/**
 * SQLite persistence for Orchestra (better-sqlite3, synchronous).
 *
 * Ports db.py and extends it: `projects`, `roles`, `role_runs`, `interventions`
 * tables plus new `tasks` columns for the refinement loop. The single SQLite
 * file is both the source of truth and the durable work queue (no broker).
 *
 * init is idempotent: CREATE TABLE IF NOT EXISTS + guarded ALTER TABLE, so it
 * upgrades the existing orchestra.db in place.
 */

import crypto from "node:crypto";
import Database from "better-sqlite3";
import { getConfig } from "./config.js";

export type DB = Database.Database;

let db: DB | undefined;

/** Open (once) the configured database with WAL + sane pragmas. */
export function getDb(): DB {
  if (db) return db;
  const cfg = getConfig();
  db = new Database(cfg.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  return db;
}

/** Close and drop the cached connection. Mainly for tests (fresh temp DBs). */
export function closeDb(): void {
  if (db) {
    db.close();
    db = undefined;
  }
}

function now(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function genId(seed: string): string {
  return crypto.createHash("sha256").update(seed).digest("hex");
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Add a column to a table only if it does not already exist. */
function addColumnIfMissing(d: DB, table: string, column: string, ddl: string): void {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

export function initDb(): void {
  const d = getDb();

  d.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id             TEXT UNIQUE,
      name                TEXT,
      status              TEXT NOT NULL DEFAULT 'pending',
      model               TEXT,
      workspace           TEXT,
      content             TEXT,
      acceptance_criteria TEXT,
      completion_criteria TEXT,
      response            TEXT,
      failure_reason      TEXT,
      parent_task_id      TEXT,
      task_type           TEXT DEFAULT 'root',
      step_number         INTEGER,
      created_at          TEXT,
      updated_at          TEXT
    );

    CREATE TABLE IF NOT EXISTS projects (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT NOT NULL,
      repo_path        TEXT NOT NULL,
      planning_dir     TEXT DEFAULT 'PLANNING',
      default_model    TEXT,
      default_provider TEXT,
      config_json      TEXT,
      created_at       TEXT,
      updated_at       TEXT
    );

    CREATE TABLE IF NOT EXISTS roles (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id    INTEGER,
      key           TEXT NOT NULL,
      title         TEXT,
      enabled       INTEGER DEFAULT 1,
      applies_to    TEXT,
      ordering      INTEGER DEFAULT 0,
      system_prompt TEXT,
      tools_json    TEXT,
      model         TEXT,
      created_at    TEXT,
      updated_at    TEXT
    );

    CREATE TABLE IF NOT EXISTS configs (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id         INTEGER,
      key                TEXT NOT NULL DEFAULT 'default',
      name               TEXT,
      base_url           TEXT,
      api_key            TEXT,
      api                TEXT,
      default_model      TEXT,
      context_window     INTEGER,
      max_tokens         INTEGER,
      request_timeout_ms INTEGER,
      extra_json         TEXT,
      created_at         TEXT,
      updated_at         TEXT
    );

    CREATE TABLE IF NOT EXISTS role_runs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id         TEXT,
      role_key        TEXT,
      verdict         TEXT,
      summary         TEXT,
      output_md       TEXT,
      coverage_json   TEXT,
      tool_calls_json TEXT,
      transcript_jsonl TEXT,
      depth           INTEGER DEFAULT 1,
      model           TEXT,
      tokens          INTEGER,
      created_at      TEXT
    );

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS interventions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id      TEXT,
      kind         TEXT,
      payload_json TEXT,
      created_by   TEXT,
      consumed_at  TEXT,
      created_at   TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_networks (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      network_id    TEXT UNIQUE NOT NULL,
      name          TEXT NOT NULL,
      description   TEXT DEFAULT '',
      project_id    INTEGER,
      intake_kind   TEXT,
      graph_json    TEXT NOT NULL,
      is_system     INTEGER DEFAULT 0,
      is_default    INTEGER DEFAULT 0,
      created_at    TEXT,
      updated_at    TEXT
    );
  `);

  // New tasks columns (existing DBs only have the original db.py set). Must run
  // BEFORE the indexes below, which reference the new columns.
  const taskCols: Array<[string, string]> = [
    ["project_id", "project_id INTEGER"],
    ["stage", "stage TEXT"],
    ["level", "level TEXT"],
    ["intake_kind", "intake_kind TEXT"],
    ["exit_kind", "exit_kind TEXT"],
    ["refinement_plan_json", "refinement_plan_json TEXT"],
    ["coverage_json", "coverage_json TEXT"],
    ["artifact_path", "artifact_path TEXT"],
    ["exit_state", "exit_state TEXT"],
    ["review_reason", "review_reason TEXT"],
    ["paused", "paused INTEGER DEFAULT 0"],
  ];
  for (const [col, ddl] of taskCols) addColumnIfMissing(d, "tasks", col, ddl);

  // Counter-reviewer output: per-criterion { id, status, note } judgements.
  addColumnIfMissing(d, "role_runs", "criteria_results_json", "criteria_results_json TEXT");
  // Run diagnostics: LLM stop reason, whether the required record_findings call was
  // missing (fallback salvage), and the captured reasoning trace.
  addColumnIfMissing(d, "role_runs", "stop_reason", "stop_reason TEXT");
  addColumnIfMissing(d, "role_runs", "fallback", "fallback INTEGER DEFAULT 0");
  // Set when the run's own text stream repeated itself (narrating a tool call
  // instead of invoking it) and had to be aborted mid-turn — see agent.ts's
  // stall detector. Distinct from `fallback`: a stalled run can still recover
  // on the auto-retry and finish with a real verdict.
  addColumnIfMissing(d, "role_runs", "stalled", "stalled INTEGER DEFAULT 0");
  addColumnIfMissing(d, "role_runs", "thinking_md", "thinking_md TEXT");
  // Open questions from record_findings (JSON array of strings).
  addColumnIfMissing(d, "role_runs", "open_questions_json", "open_questions_json TEXT");
  // Orchestrator recap call — synthesized final disposition after all roles finish.
  addColumnIfMissing(d, "tasks", "recap_md", "recap_md TEXT");
  // Reasoning-model connection settings (editable per profile).
  addColumnIfMissing(d, "configs", "reasoning", "reasoning INTEGER");
  addColumnIfMissing(d, "configs", "thinking_level", "thinking_level TEXT");
  // Reasoning request dialect (model family): shapes how pi asks for thinking.
  addColumnIfMissing(d, "configs", "thinking_format", "thinking_format TEXT");
  // Text mode: when enabled, record_findings is NOT registered as a tool — the
  // model is instead instructed to output findings as a JSON code block. Opt-in
  // for models whose function-calling is unreliable (small MoE, quantized, etc.).
  addColumnIfMissing(d, "configs", "text_mode", "text_mode INTEGER DEFAULT 0");
  // Two-phase session mode: phase 1 explores with tools, phase 2 formalizes as JSON.
  // Supersedes text_mode for models whose built-in tool usage works but whose
  // custom tool calling (record_findings) is unreliable.
  addColumnIfMissing(d, "configs", "two_phase", "two_phase INTEGER DEFAULT 0");
  // Whether a role can spawn child tasks via decomposition.
  addColumnIfMissing(d, "roles", "can_create_subtasks", "can_create_subtasks INTEGER DEFAULT 0");
  // JSON blob for pi Model compat options (supportsDeveloperRole, supportsReasoningEffort,
  // maxTokensField, chatTemplateKwargs, etc.).
  addColumnIfMissing(d, "configs", "compat_json", "compat_json TEXT");
  // Per-thinking-level reasoning token budgets (JSON: {"minimal": 1024, "low": 4096, …}).
  // Passed to pi's SettingsManager so providers that support token-based thinking caps
  // can constrain reasoning tokens separately from the max_tokens output budget.
  addColumnIfMissing(d, "configs", "thinking_budgets", "thinking_budgets TEXT");
  // Display ordering for model config cards (user-controlled drag-and-drop).
  addColumnIfMissing(d, "configs", "ordering", "ordering INTEGER DEFAULT 0");

  // Agent network linking: custom flow template per task.
  addColumnIfMissing(d, "tasks", "network_id", "network_id TEXT");

  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_stage   ON tasks(stage);
    CREATE INDEX IF NOT EXISTS idx_role_runs_task ON role_runs(task_id);
    CREATE INDEX IF NOT EXISTS idx_interventions_task ON interventions(task_id);
    CREATE INDEX IF NOT EXISTS idx_roles_project ON roles(project_id);
    CREATE INDEX IF NOT EXISTS idx_configs_project ON configs(project_id);
    CREATE INDEX IF NOT EXISTS idx_agent_networks_project ON agent_networks(project_id);
    CREATE INDEX IF NOT EXISTS idx_agent_networks_intake ON agent_networks(intake_kind);
  `);
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface ProjectRow {
  id: number;
  name: string;
  repo_path: string;
  planning_dir: string;
  default_model: string | null;
  default_provider: string | null;
  config_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface RoleRow {
  id: number;
  project_id: number | null;
  key: string;
  title: string | null;
  enabled: number;
  applies_to: string | null;
  ordering: number;
  system_prompt: string | null;
  tools_json: string | null;
  model: string | null;
  can_create_subtasks: number;
  created_at: string;
  updated_at: string;
}

export interface TaskRow {
  id: number;
  task_id: string;
  name: string | null;
  status: string;
  model: string | null;
  workspace: string | null;
  content: string | null;
  acceptance_criteria: string | null;
  completion_criteria: string | null;
  response: string | null;
  failure_reason: string | null;
  parent_task_id: string | null;
  task_type: string | null;
  step_number: number | null;
  project_id: number | null;
  stage: string | null;
  level: string | null;
  intake_kind: string | null;
  exit_kind: string | null;
  refinement_plan_json: string | null;
  coverage_json: string | null;
  artifact_path: string | null;
  exit_state: string | null;
  review_reason: string | null;
  recap_md: string | null;
  paused: number | null;
  network_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A named connection/provider profile. `project_id IS NULL, key='default'` is the
 * global template; project rows (same key) override it. Endpoint + auth + model
 * params live here so they can be edited at runtime and inherited per project,
 * mirroring how `roles` layers globals under project overrides.
 */
export interface ConfigRow {
  id: number;
  project_id: number | null;
  key: string;
  name: string | null;
  base_url: string | null;
  api_key: string | null;
  api: string | null;
  default_model: string | null;
  context_window: number | null;
  max_tokens: number | null;
  request_timeout_ms: number | null;
  reasoning: number | null;
  thinking_level: string | null;
  thinking_format: string | null;
  text_mode: number | null;
  two_phase: number | null;
  extra_json: string | null;
  compat_json: string | null;
  thinking_budgets: string | null;
  ordering: number;
  created_at: string;
  updated_at: string;
}

export interface RoleRunRow {
  id: number;
  task_id: string;
  role_key: string;
  verdict: string | null;
  summary: string | null;
  output_md: string | null;
  coverage_json: string | null;
  criteria_results_json: string | null;
  tool_calls_json: string | null;
  transcript_jsonl: string | null;
  stop_reason: string | null;
  fallback: number | null;
  stalled: number | null;
  thinking_md: string | null;
  open_questions_json: string | null;
  depth: number;
  model: string | null;
  tokens: number | null;
  created_at: string;
}

export interface InterventionRow {
  id: number;
  task_id: string;
  kind: string;
  payload_json: string | null;
  created_by: string | null;
  consumed_at: string | null;
  created_at: string;
}

export interface AgentNetworkRow {
  id: number;
  network_id: string;
  name: string;
  description: string;
  project_id: number | null;
  intake_kind: string | null;
  graph_json: string;
  is_system: number;
  is_default: number;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export function createProject(input: {
  name: string;
  repo_path: string;
  planning_dir?: string;
  default_model?: string | null;
  default_provider?: string | null;
  config_json?: string | null;
}): ProjectRow {
  const d = getDb();
  const ts = now();
  const info = d
    .prepare(
      `INSERT INTO projects (name, repo_path, planning_dir, default_model, default_provider, config_json, created_at, updated_at)
       VALUES (@name, @repo_path, @planning_dir, @default_model, @default_provider, @config_json, @ts, @ts)`,
    )
    .run({
      name: input.name,
      repo_path: input.repo_path,
      planning_dir: input.planning_dir ?? "PLANNING",
      default_model: input.default_model ?? null,
      default_provider: input.default_provider ?? null,
      config_json: input.config_json ?? null,
      ts,
    });
  return getProject(Number(info.lastInsertRowid))!;
}

export function listProjects(): ProjectRow[] {
  return getDb().prepare(`SELECT * FROM projects ORDER BY id DESC`).all() as ProjectRow[];
}

export function getProject(id: number): ProjectRow | undefined {
  return getDb().prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as ProjectRow | undefined;
}

const PROJECT_UPDATABLE = new Set([
  "name",
  "repo_path",
  "planning_dir",
  "default_model",
  "default_provider",
  "config_json",
]);

export function updateProject(id: number, fields: Record<string, unknown>): ProjectRow | undefined {
  const updates = Object.entries(fields).filter(([k]) => PROJECT_UPDATABLE.has(k));
  if (updates.length) {
    updates.push(["updated_at", now()]);
    const setClause = updates.map(([k]) => `${k} = ?`).join(", ");
    getDb()
      .prepare(`UPDATE projects SET ${setClause} WHERE id = ?`)
      .run(...updates.map(([, v]) => v as never), id);
  }
  return getProject(id);
}

export function deleteProject(id: number): void {
  getDb().prepare(`DELETE FROM projects WHERE id = ?`).run(id);
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/**
 * Merged role list for a project: global defaults (project_id IS NULL) overridden
 * by any project-specific row sharing the same `key`.
 */
export function listRoles(projectId: number | null): RoleRow[] {
  const d = getDb();
  const globals = d
    .prepare(`SELECT * FROM roles WHERE project_id IS NULL`)
    .all() as RoleRow[];
  const overrides =
    projectId == null
      ? []
      : (d.prepare(`SELECT * FROM roles WHERE project_id = ?`).all(projectId) as RoleRow[]);

  const byKey = new Map<string, RoleRow>();
  for (const r of globals) byKey.set(r.key, r);
  for (const r of overrides) byKey.set(r.key, r); // project wins by key
  return [...byKey.values()].sort((a, b) => a.ordering - b.ordering || a.key.localeCompare(b.key));
}

export function getRole(projectId: number | null, key: string): RoleRow | undefined {
  return listRoles(projectId).find((r) => r.key === key);
}

/** Insert or update a role identified by (project_id, key). */
export function upsertRole(input: {
  project_id: number | null;
  key: string;
  title?: string | null;
  enabled?: boolean;
  applies_to?: string | null;
  ordering?: number;
  system_prompt?: string | null;
  tools_json?: string | null;
  model?: string | null;
  can_create_subtasks?: boolean;
}): RoleRow {
  const d = getDb();
  const ts = now();
  const existing = d
    .prepare(
      `SELECT * FROM roles WHERE key = ? AND ${input.project_id == null ? "project_id IS NULL" : "project_id = ?"}`,
    )
    .get(...(input.project_id == null ? [input.key] : [input.key, input.project_id])) as
    | RoleRow
    | undefined;

  if (existing) {
    d.prepare(
      `UPDATE roles SET title=@title, enabled=@enabled, applies_to=@applies_to, ordering=@ordering,
        system_prompt=@system_prompt, tools_json=@tools_json, model=@model, can_create_subtasks=@can_create_subtasks, updated_at=@ts WHERE id=@id`,
    ).run({
      id: existing.id,
      title: input.title ?? existing.title,
      enabled: input.enabled == null ? existing.enabled : input.enabled ? 1 : 0,
      applies_to: input.applies_to ?? existing.applies_to,
      ordering: input.ordering ?? existing.ordering,
      system_prompt: input.system_prompt ?? existing.system_prompt,
      tools_json: input.tools_json ?? existing.tools_json,
      model: input.model ?? existing.model,
      can_create_subtasks: input.can_create_subtasks == null ? existing.can_create_subtasks : input.can_create_subtasks ? 1 : 0,
      ts,
    });
    return d.prepare(`SELECT * FROM roles WHERE id = ?`).get(existing.id) as RoleRow;
  }

  const info = d
    .prepare(
      `INSERT INTO roles (project_id, key, title, enabled, applies_to, ordering, system_prompt, tools_json, model, can_create_subtasks, created_at, updated_at)
       VALUES (@project_id, @key, @title, @enabled, @applies_to, @ordering, @system_prompt, @tools_json, @model, @can_create_subtasks, @ts, @ts)`,
    )
    .run({
      project_id: input.project_id,
      key: input.key,
      title: input.title ?? null,
      enabled: input.enabled === false ? 0 : 1,
      applies_to: input.applies_to ?? null,
      ordering: input.ordering ?? 0,
      system_prompt: input.system_prompt ?? null,
      tools_json: input.tools_json ?? null,
      model: input.model ?? null,
      can_create_subtasks: input.can_create_subtasks ? 1 : 0,
      ts,
    });
  return d.prepare(`SELECT * FROM roles WHERE id = ?`).get(Number(info.lastInsertRowid)) as RoleRow;
}

export function deleteRole(id: number): void {
  getDb().prepare(`DELETE FROM roles WHERE id = ?`).run(id);
}

export function countGlobalRoles(): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM roles WHERE project_id IS NULL`).get() as {
    n: number;
  };
  return row.n;
}

// ---------------------------------------------------------------------------
// Meta (small key/value store for migration/versioning flags)
// ---------------------------------------------------------------------------

export function getMeta(key: string): string | undefined {
  const row = getDb().prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
    | { value: string | null }
    | undefined;
  return row?.value ?? undefined;
}

export function setMeta(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

// ---------------------------------------------------------------------------
// Configs (connection / provider profiles)
// ---------------------------------------------------------------------------

/** The global default profile (`project_id IS NULL, key='default'`), if seeded. */
export function getGlobalConfig(): ConfigRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM configs WHERE project_id IS NULL AND key = 'default'`)
    .get() as ConfigRow | undefined;
}

/** A project's override profile for `key` (default 'default'), if any. */
export function getProjectConfig(projectId: number, key = "default"): ConfigRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM configs WHERE project_id = ? AND key = ?`)
    .get(projectId, key) as ConfigRow | undefined;
}

/**
 * Insert or update a config profile identified by (project_id, key). Only the
 * fields present in `input` are written; omitted fields keep their prior value,
 * so a PATCH of just base_url/api_key leaves the model params untouched.
 */
export function upsertConfig(input: {
  project_id: number | null;
  key?: string;
  name?: string | null;
  base_url?: string | null;
  api_key?: string | null;
  api?: string | null;
  default_model?: string | null;
  context_window?: number | null;
  max_tokens?: number | null;
  request_timeout_ms?: number | null;
  reasoning?: number | null;
  thinking_level?: string | null;
  thinking_format?: string | null;
  text_mode?: number | null;
  two_phase?: number | null;
  extra_json?: string | null;
  compat_json?: string | null;
  thinking_budgets?: string | null;
}): ConfigRow {
  const d = getDb();
  const ts = now();
  const key = input.key ?? "default";
  const existing = d
    .prepare(
      `SELECT * FROM configs WHERE key = ? AND ${input.project_id == null ? "project_id IS NULL" : "project_id = ?"}`,
    )
    .get(...(input.project_id == null ? [key] : [key, input.project_id])) as ConfigRow | undefined;

  // PATCH semantics: `undefined` field = keep prior value, explicit `null` =
  // clear it. (Plain `??` can't tell the two apart, which matters for api_key.)
  const base: Partial<ConfigRow> = existing ?? {};
  const keep = <T>(next: T | null | undefined, prior: T | null | undefined): T | null =>
    next !== undefined ? (next as T | null) : (prior ?? null);
    const merged = {
      name: keep(input.name, base.name),
      base_url: keep(input.base_url, base.base_url),
      api_key: keep(input.api_key, base.api_key),
      api: keep(input.api, base.api),
      default_model: keep(input.default_model, base.default_model),
      context_window: keep(input.context_window, base.context_window),
      max_tokens: keep(input.max_tokens, base.max_tokens),
      request_timeout_ms: keep(input.request_timeout_ms, base.request_timeout_ms),
      reasoning: keep(input.reasoning, base.reasoning),
      thinking_level: keep(input.thinking_level, base.thinking_level),
      thinking_format: keep(input.thinking_format, base.thinking_format),
      text_mode: keep(input.text_mode, base.text_mode),
      two_phase: keep(input.two_phase, base.two_phase),
      extra_json: keep(input.extra_json, base.extra_json),
      compat_json: keep(input.compat_json, base.compat_json),
      thinking_budgets: keep(input.thinking_budgets, base.thinking_budgets),
    };

  if (existing) {
    d.prepare(
      `UPDATE configs SET name=@name, base_url=@base_url, api_key=@api_key, api=@api,
        default_model=@default_model, context_window=@context_window, max_tokens=@max_tokens,
        request_timeout_ms=@request_timeout_ms, reasoning=@reasoning, thinking_level=@thinking_level,
        thinking_format=@thinking_format, text_mode=@text_mode, two_phase=@two_phase, extra_json=@extra_json, compat_json=@compat_json, thinking_budgets=@thinking_budgets, updated_at=@ts WHERE id=@id`,
    ).run({ ...merged, id: existing.id, ts });
    return d.prepare(`SELECT * FROM configs WHERE id = ?`).get(existing.id) as ConfigRow;
  }

  const info = d
    .prepare(
      `INSERT INTO configs (project_id, key, name, base_url, api_key, api, default_model,
         context_window, max_tokens, request_timeout_ms, reasoning, thinking_level, thinking_format, text_mode, two_phase, extra_json, compat_json, thinking_budgets, created_at, updated_at)
       VALUES (@project_id, @key, @name, @base_url, @api_key, @api, @default_model,
         @context_window, @max_tokens, @request_timeout_ms, @reasoning, @thinking_level, @thinking_format, @text_mode, @two_phase, @extra_json, @compat_json, @thinking_budgets, @ts, @ts)`,
    )
    .run({ ...merged, project_id: input.project_id, key, ts });
  return d.prepare(`SELECT * FROM configs WHERE id = ?`).get(Number(info.lastInsertRowid)) as ConfigRow;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export function createTask(input: {
  name: string;
  content?: string | null;
  project_id?: number | null;
  status?: string;
  model?: string | null;
  stage?: string;
  level?: string;
  intake_kind?: string | null;
  exit_kind?: string | null;
  parent_task_id?: string | null;
  task_type?: string;
  step_number?: number | null;
  artifact_path?: string | null;
  refinement_plan_json?: string | null;
}): TaskRow {
  const d = getDb();
  const ts = now();
  const taskId = genId(`${ts}-${process.hrtime.bigint()}`);
  const info = d
    .prepare(
      `INSERT INTO tasks (task_id, name, status, model, content, project_id, stage, level, intake_kind,
         exit_kind, parent_task_id, task_type, step_number, artifact_path, refinement_plan_json, created_at, updated_at)
       VALUES (@task_id, @name, @status, @model, @content, @project_id, @stage, @level, @intake_kind,
         @exit_kind, @parent_task_id, @task_type, @step_number, @artifact_path, @refinement_plan_json, @ts, @ts)`,
    )
    .run({
      task_id: taskId,
      name: input.name,
      status: input.status ?? "pending",
      model: input.model ?? null,
      content: input.content ?? null,
      project_id: input.project_id ?? null,
      stage: input.stage ?? "intake",
      level: input.level ?? "task",
      intake_kind: input.intake_kind ?? "manual",
      exit_kind: input.exit_kind ?? null,
      parent_task_id: input.parent_task_id ?? null,
      task_type: input.task_type ?? "root",
      step_number: input.step_number ?? null,
      artifact_path: input.artifact_path ?? null,
      refinement_plan_json: input.refinement_plan_json ?? null,
      ts,
    });
  return getTask(Number(info.lastInsertRowid))!;
}

/** Fetch a task by numeric id or by task_id hash. */
export function getTask(identifier: number | string): TaskRow | undefined {
  const d = getDb();
  if (typeof identifier === "number" || /^\d+$/.test(identifier)) {
    const row = d.prepare(`SELECT * FROM tasks WHERE id = ?`).get(Number(identifier)) as
      | TaskRow
      | undefined;
    if (row) return row;
  }
  return d.prepare(`SELECT * FROM tasks WHERE task_id = ?`).get(String(identifier)) as
    | TaskRow
    | undefined;
}

export function listTasks(opts: { projectId?: number; stage?: string; parentTaskId?: string } = {}): TaskRow[] {
  const d = getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.projectId != null) {
    where.push("project_id = ?");
    params.push(opts.projectId);
  }
  if (opts.stage) {
    where.push("stage = ?");
    params.push(opts.stage);
  }
  if (opts.parentTaskId) {
    where.push("parent_task_id = ?");
    params.push(opts.parentTaskId);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return d
    .prepare(`SELECT * FROM tasks ${clause} ORDER BY created_at DESC, id DESC`)
    .all(...(params as never[])) as TaskRow[];
}

const TASK_UPDATABLE = new Set([
  "name",
  "status",
  "model",
  "workspace",
  "content",
  "acceptance_criteria",
  "completion_criteria",
  "response",
  "failure_reason",
  "parent_task_id",
  "task_type",
  "step_number",
  "project_id",
  "stage",
  "level",
  "intake_kind",
  "exit_kind",
  "refinement_plan_json",
  "coverage_json",
  "artifact_path",
  "exit_state",
  "review_reason",
  "recap_md",
  "paused",
  "network_id",
]);

export function updateTask(
  identifier: number | string,
  fields: Record<string, unknown>,
): TaskRow | undefined {
  const updates = Object.entries(fields).filter(([k]) => TASK_UPDATABLE.has(k));
  if (updates.length) {
    updates.push(["updated_at", now()]);
    const isNumeric = typeof identifier === "number" || /^\d+$/.test(String(identifier));
    const keyCol = isNumeric ? "id" : "task_id";
    const keyVal = isNumeric ? Number(identifier) : String(identifier);
    const setClause = updates.map(([k]) => `${k} = ?`).join(", ");
    getDb()
      .prepare(`UPDATE tasks SET ${setClause} WHERE ${keyCol} = ?`)
      .run(...updates.map(([, v]) => v as never), keyVal);
  }
  return getTask(identifier);
}

export function deleteTask(identifier: number | string): void {
  const d = getDb();
  const task = getTask(identifier);
  if (!task) return;

  // Cascade-clean related rows before removing the task itself.
  d.prepare(`DELETE FROM role_runs WHERE task_id = ?`).run(task.task_id);
  d.prepare(`DELETE FROM interventions WHERE task_id = ?`).run(task.task_id);

  const isNumeric = typeof identifier === "number" || /^\d+$/.test(String(identifier));
  const keyCol = isNumeric ? "id" : "task_id";
  const keyVal = isNumeric ? Number(identifier) : String(identifier);
  d.prepare(`DELETE FROM tasks WHERE ${keyCol} = ?`).run(keyVal);
}

/**
 * Reset a task to intake state: clears all run/intervention history, log
 * metadata, and output artifacts. Preserves the task's name, content, project
 * association, and intake_kind so it is equivalent to a freshly-created task
 * with the same intake.
 */
export function resetTask(identifier: number | string): TaskRow | undefined {
  const d = getDb();
  const task = getTask(identifier);
  if (!task) return undefined;

  // Wipe all history and steering records.
  d.prepare(`DELETE FROM role_runs WHERE task_id = ?`).run(task.task_id);
  d.prepare(`DELETE FROM interventions WHERE task_id = ?`).run(task.task_id);

  // Reset to intake defaults — keep name, content, project_id, intake_kind.
  const ts = now();
  const isNumeric = typeof identifier === "number" || /^\d+$/.test(String(identifier));
  const keyCol = isNumeric ? "id" : "task_id";
  const keyVal = isNumeric ? Number(identifier) : String(identifier);

  d.prepare(`
    UPDATE tasks SET
      status = 'pending',
      stage = 'intake',
      level = 'task',
      exit_kind = NULL,
      exit_state = NULL,
      review_reason = NULL,
      recap_md = NULL,
      paused = 0,
      response = NULL,
      failure_reason = NULL,
      acceptance_criteria = NULL,
      completion_criteria = NULL,
      refinement_plan_json = NULL,
      coverage_json = NULL,
      artifact_path = NULL,
      workspace = NULL,
      parent_task_id = NULL,
      task_type = 'root',
      step_number = NULL,
      model = NULL,
      updated_at = @ts
    WHERE ${keyCol} = @keyVal
  `).run({ ts, keyVal });

  return getTask(identifier);
}

/**
 * Check whether a task has an artifact_path pointing to a file that exists
 * on disk under the project's planning tree. Returns the absolute path if so,
 * or null.
 */
export function taskArtifactPath(identifier: number | string): string | null {
  const task = getTask(identifier);
  if (!task || !task.artifact_path) return null;
  // artifact_path is always relative to the project repo via the planning dir.
  // For safety, only return it if it looks like a .md file.
  if (!/\.md$/i.test(task.artifact_path)) return null;
  return task.artifact_path;
}

// ---------------------------------------------------------------------------
// Role runs
// ---------------------------------------------------------------------------

export function createRoleRun(input: {
  task_id: string;
  role_key: string;
  verdict?: string | null;
  summary?: string | null;
  output_md?: string | null;
  coverage_json?: string | null;
  criteria_results_json?: string | null;
  tool_calls_json?: string | null;
  transcript_jsonl?: string | null;
  stop_reason?: string | null;
  fallback?: number | null;
  stalled?: number | null;
  thinking_md?: string | null;
  open_questions_json?: string | null;
  depth?: number;
  model?: string | null;
  tokens?: number | null;
}): RoleRunRow {
  const d = getDb();
  const ts = now();
  const info = d
    .prepare(
      `INSERT INTO role_runs (task_id, role_key, verdict, summary, output_md, coverage_json,
         criteria_results_json, tool_calls_json, transcript_jsonl, stop_reason, fallback, stalled, thinking_md,
         open_questions_json, depth, model, tokens, created_at)
       VALUES (@task_id, @role_key, @verdict, @summary, @output_md, @coverage_json,
         @criteria_results_json, @tool_calls_json, @transcript_jsonl, @stop_reason, @fallback, @stalled, @thinking_md,
         @open_questions_json, @depth, @model, @tokens, @ts)`,
    )
    .run({
      task_id: input.task_id,
      role_key: input.role_key,
      verdict: input.verdict ?? null,
      summary: input.summary ?? null,
      output_md: input.output_md ?? null,
      coverage_json: input.coverage_json ?? null,
      criteria_results_json: input.criteria_results_json ?? null,
      tool_calls_json: input.tool_calls_json ?? null,
      transcript_jsonl: input.transcript_jsonl ?? null,
      stop_reason: input.stop_reason ?? null,
      fallback: input.fallback ?? 0,
      stalled: input.stalled ?? 0,
      thinking_md: input.thinking_md ?? null,
      open_questions_json: input.open_questions_json ?? null,
      depth: input.depth ?? 1,
      model: input.model ?? null,
      tokens: input.tokens ?? null,
      ts,
    });
  return d.prepare(`SELECT * FROM role_runs WHERE id = ?`).get(Number(info.lastInsertRowid)) as RoleRunRow;
}

export function listRoleRuns(taskId: string): RoleRunRow[] {
  return getDb()
    .prepare(`SELECT * FROM role_runs WHERE task_id = ? ORDER BY id ASC`)
    .all(taskId) as RoleRunRow[];
}

// ---------------------------------------------------------------------------
// Interventions
// ---------------------------------------------------------------------------

export function createIntervention(input: {
  task_id: string;
  kind: string;
  payload_json?: string | null;
  created_by?: string | null;
}): InterventionRow {
  const d = getDb();
  const ts = now();
  const info = d
    .prepare(
      `INSERT INTO interventions (task_id, kind, payload_json, created_by, created_at)
       VALUES (@task_id, @kind, @payload_json, @created_by, @ts)`,
    )
    .run({
      task_id: input.task_id,
      kind: input.kind,
      payload_json: input.payload_json ?? null,
      created_by: input.created_by ?? "user",
      ts,
    });
  return d
    .prepare(`SELECT * FROM interventions WHERE id = ?`)
    .get(Number(info.lastInsertRowid)) as InterventionRow;
}

export function listUnconsumedInterventions(taskId: string): InterventionRow[] {
  return getDb()
    .prepare(`SELECT * FROM interventions WHERE task_id = ? AND consumed_at IS NULL ORDER BY id ASC`)
    .all(taskId) as InterventionRow[];
}

export function listInterventions(taskId: string): InterventionRow[] {
  return getDb()
    .prepare(`SELECT * FROM interventions WHERE task_id = ? ORDER BY id ASC`)
    .all(taskId) as InterventionRow[];
}

export function markInterventionConsumed(id: number): void {
  getDb().prepare(`UPDATE interventions SET consumed_at = ? WHERE id = ?`).run(now(), id);
}

// ---------------------------------------------------------------------------
// Agent Networks (visual flow templates)
// ---------------------------------------------------------------------------

/** Create a new agent network with a unique nanoid-style identifier. */
export function createNetwork(input: {
  name: string;
  description?: string;
  project_id?: number | null;
  intake_kind?: string | null;
  graph_json: string;
  is_system?: boolean;
  is_default?: boolean;
}): AgentNetworkRow {
  const d = getDb();
  const ts = now();
  const networkId = genId(`${ts}-${process.hrtime.bigint()}`).slice(0, 16);
  const info = d
    .prepare(
      `INSERT INTO agent_networks (network_id, name, description, project_id, intake_kind, graph_json, is_system, is_default, created_at, updated_at)
       VALUES (@network_id, @name, @description, @project_id, @intake_kind, @graph_json, @is_system, @is_default, @ts, @ts)`,
    )
    .run({
      network_id: networkId,
      name: input.name,
      description: input.description ?? "",
      project_id: input.project_id ?? null,
      intake_kind: input.intake_kind ?? null,
      graph_json: input.graph_json,
      is_system: input.is_system ? 1 : 0,
      is_default: input.is_default ? 1 : 0,
      ts,
    });
  return getNetwork(Number(info.lastInsertRowid))!;
}

export function getNetwork(identifier: number | string): AgentNetworkRow | undefined {
  const d = getDb();
  if (typeof identifier === "number" || /^\d+$/.test(identifier)) {
    const row = d
      .prepare(`SELECT * FROM agent_networks WHERE id = ?`)
      .get(Number(identifier)) as AgentNetworkRow | undefined;
    if (row) return row;
  }
  return d
    .prepare(`SELECT * FROM agent_networks WHERE network_id = ?`)
    .get(String(identifier)) as AgentNetworkRow | undefined;
}

export function getNetworkByIntakeKind(
  projectId: number | null,
  intakeKind: string,
): AgentNetworkRow | undefined {
  const d = getDb();
  // Prefer a project-scoped default, then global default.
  if (projectId != null) {
    const row = d
      .prepare(
        `SELECT * FROM agent_networks WHERE intake_kind = ? AND project_id = ? AND is_default = 1 ORDER BY is_system ASC, id ASC LIMIT 1`,
      )
      .get(intakeKind, projectId) as AgentNetworkRow | undefined;
    if (row) return row;
  }
  return d
    .prepare(
      `SELECT * FROM agent_networks WHERE intake_kind = ? AND project_id IS NULL AND is_default = 1 ORDER BY is_system ASC, id ASC LIMIT 1`,
    )
    .get(intakeKind) as AgentNetworkRow | undefined;
}

export function listNetworks(opts: { projectId?: number | null } = {}): AgentNetworkRow[] {
  const d = getDb();
  if (opts.projectId != null) {
    return d
      .prepare(
        `SELECT * FROM agent_networks WHERE project_id = ? OR (project_id IS NULL AND is_system = 1) ORDER BY is_system ASC, name ASC`,
      )
      .all(opts.projectId) as AgentNetworkRow[];
  }
  return d
    .prepare(`SELECT * FROM agent_networks ORDER BY is_system ASC, name ASC`)
    .all() as AgentNetworkRow[];
}

const NETWORK_UPDATABLE = new Set([
  "name",
  "description",
  "project_id",
  "intake_kind",
  "graph_json",
  "is_default",
]);

export function updateNetwork(
  identifier: number | string,
  fields: Record<string, unknown>,
): AgentNetworkRow | undefined {
  const d = getDb();
  const network = getNetwork(identifier);
  if (!network || network.is_system) return network; // system networks are immutable

  const updates = Object.entries(fields).filter(([k]) => NETWORK_UPDATABLE.has(k));
  if (updates.length) {
    updates.push(["updated_at", now()]);
    const isNumeric = typeof identifier === "number" || /^\d+$/.test(String(identifier));
    const keyCol = isNumeric ? "id" : "network_id";
    const keyVal = isNumeric ? Number(identifier) : String(identifier);
    const setClause = updates.map(([k]) => `${k} = ?`).join(", ");
    d.prepare(`UPDATE agent_networks SET ${setClause} WHERE ${keyCol} = ?`).run(
      ...updates.map(([, v]) => v as never),
      keyVal,
    );
  }
  return getNetwork(identifier);
}

/** Set a network as the default for its intake_kind, clearing any previous default. */
export function setDefaultNetwork(
  identifier: number | string,
): AgentNetworkRow | undefined {
  const network = getNetwork(identifier);
  if (!network || !network.intake_kind) return network;

  const d = getDb();
  // Clear previous default for this intake_kind + scope
  d.prepare(
    `UPDATE agent_networks SET is_default = 0 WHERE intake_kind = ? AND project_id IS ?`,
  ).run(network.intake_kind, network.project_id);

  // Set this one as default
  d.prepare(`UPDATE agent_networks SET is_default = 1 WHERE id = ?`).run(network.id);
  return getNetwork(network.id);
}

export function deleteNetwork(identifier: number | string): void {
  const d = getDb();
  const network = getNetwork(identifier);
  if (!network || network.is_system) return; // cannot delete system networks

  const isNumeric = typeof identifier === "number" || /^\d+$/.test(String(identifier));
  const keyCol = isNumeric ? "id" : "network_id";
  const keyVal = isNumeric ? Number(identifier) : String(identifier);
  d.prepare(`DELETE FROM agent_networks WHERE ${keyCol} = ?`).run(keyVal);
}

  // ---------------------------------------------------------------------------
  // Model Configs (named connection profiles beyond the global default)
  // ---------------------------------------------------------------------------

  /** Return all model configs including the global default row. Sorted by user ordering. */
  export function listModelConfigs(): ConfigRow[] {
    return getDb()
      .prepare(`SELECT * FROM configs ORDER BY ordering ASC, id ASC`)
      .all() as ConfigRow[];
  }

  export function getConfigById(id: number): ConfigRow | undefined {
    return getDb().prepare(`SELECT * FROM configs WHERE id = ?`).get(id) as ConfigRow | undefined;
  }

  /** Create a named model config. Throws if name already exists. */
  export function createModelConfig(input: {
    name: string;
    base_url?: string | null;
    api_key?: string | null;
    api?: string | null;
    default_model?: string | null;
    context_window?: number | null;
    max_tokens?: number | null;
    request_timeout_ms?: number | null;
    reasoning?: boolean;
    thinking_level?: string | null;
    thinking_format?: string | null;
    text_mode?: boolean;
    two_phase?: boolean;
    extra_json?: string | null;
    compat_json?: string | null;
    thinking_budgets?: string | null;
  }): ConfigRow {
    const d = getDb();
    const existing = d.prepare(`SELECT id FROM configs WHERE name = ?`).get(input.name) as { id: number } | undefined;
    if (existing) throw new Error(`A model config named "${input.name}" already exists.`);
    const ts = now();
    const key = `model_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Place new config at the end: ordering = max(existing) + 1
    const maxOrd = d.prepare(
      `SELECT COALESCE(MAX(ordering), -1) AS m FROM configs WHERE project_id IS NULL`,
    ).get() as { m: number };
    const ordering = maxOrd.m + 1;

    const info = d
      .prepare(
        `INSERT INTO configs (project_id, key, name, base_url, api_key, api, default_model,
           context_window, max_tokens, request_timeout_ms, reasoning, thinking_level, thinking_format,
           text_mode, two_phase, extra_json, compat_json, thinking_budgets, ordering, created_at, updated_at)
         VALUES (NULL, @key, @name, @base_url, @api_key, @api, @default_model,
           @context_window, @max_tokens, @request_timeout_ms, @reasoning, @thinking_level, @thinking_format,
           @text_mode, @two_phase, @extra_json, @compat_json, @thinking_budgets, @ordering, @ts, @ts)`,
      )
      .run({
        key,
        name: input.name,
        base_url: input.base_url ?? null,
        api_key: input.api_key ?? null,
        api: input.api ?? "openai-completions",
        default_model: input.default_model ?? null,
        context_window: input.context_window ?? null,
        max_tokens: input.max_tokens ?? null,
        request_timeout_ms: input.request_timeout_ms ?? null,
        reasoning: input.reasoning ? 1 : 0,
        thinking_level: input.thinking_level ?? null,
        thinking_format: input.thinking_format ?? null,
        text_mode: input.text_mode ? 1 : 0,
        two_phase: input.two_phase ? 1 : 0,
        extra_json: input.extra_json ?? null,
        compat_json: input.compat_json ?? null,
        thinking_budgets: input.thinking_budgets ?? null,
        ordering,
        ts,
      });
    return d.prepare(`SELECT * FROM configs WHERE id = ?`).get(Number(info.lastInsertRowid)) as ConfigRow;
  }

  /** Update a model config by id. */
  export function updateModelConfig(id: number, input: {
    name?: string | null;
    base_url?: string | null;
    api_key?: string | null;
    api?: string | null;
    default_model?: string | null;
    context_window?: number | null;
    max_tokens?: number | null;
    request_timeout_ms?: number | null;
    reasoning?: number | null;
    thinking_level?: string | null;
    thinking_format?: string | null;
    text_mode?: number | null;
    two_phase?: number | null;
    extra_json?: string | null;
    compat_json?: string | null;
    thinking_budgets?: string | null;
  }): ConfigRow {
    const d = getDb();
    const existing = getConfigById(id);
    if (!existing) throw new Error("Model config not found.");

    // Name uniqueness check if name is changing
    if (input.name !== undefined && input.name !== existing.name) {
      const dup = d.prepare(`SELECT id FROM configs WHERE name = ? AND id != ?`).get(input.name, id) as { id: number } | undefined;
      if (dup) throw new Error(`A model config named "${input.name}" already exists.`);
    }

    const keep = <T>(next: T | null | undefined, prior: T | null | undefined): T | null =>
      next !== undefined ? (next as T | null) : (prior ?? null);

    const merged = {
      name: keep(input.name, existing.name),
      base_url: keep(input.base_url, existing.base_url),
      api_key: keep(input.api_key, existing.api_key),
      api: keep(input.api, existing.api),
      default_model: keep(input.default_model, existing.default_model),
      context_window: keep(input.context_window, existing.context_window),
      max_tokens: keep(input.max_tokens, existing.max_tokens),
      request_timeout_ms: keep(input.request_timeout_ms, existing.request_timeout_ms),
      reasoning: keep(input.reasoning, existing.reasoning),
      thinking_level: keep(input.thinking_level, existing.thinking_level),
      thinking_format: keep(input.thinking_format, existing.thinking_format),
      text_mode: keep(input.text_mode, existing.text_mode),
      two_phase: keep(input.two_phase, existing.two_phase),
      extra_json: keep(input.extra_json, existing.extra_json),
      compat_json: keep(input.compat_json, existing.compat_json),
      thinking_budgets: keep(input.thinking_budgets, existing.thinking_budgets),
    };

    const ts = now();
    d.prepare(
      `UPDATE configs SET name=@name, base_url=@base_url, api_key=@api_key, api=@api,
        default_model=@default_model, context_window=@context_window, max_tokens=@max_tokens,
        request_timeout_ms=@request_timeout_ms, reasoning=@reasoning, thinking_level=@thinking_level,
        thinking_format=@thinking_format, text_mode=@text_mode, two_phase=@two_phase,
        extra_json=@extra_json, compat_json=@compat_json, thinking_budgets=@thinking_budgets, updated_at=@ts WHERE id=@id`,
    ).run({ ...merged, id, ts });
    return d.prepare(`SELECT * FROM configs WHERE id = ?`).get(id) as ConfigRow;
  }

  /** Delete a model config by id. Refuses to delete the global default row. */
  export function deleteModelConfig(id: number): void {
    const d = getDb();
    const existing = getConfigById(id);
    if (!existing) return;
    if (existing.project_id === null && existing.key === "default") {
      throw new Error("Cannot delete the global default config.");
    }
    d.prepare(`DELETE FROM configs WHERE id = ?`).run(id);
  }

  /** Duplicate a model config with a new unique name. The copy gets a fresh key and empty api_key. */
  export function duplicateModelConfig(id: number, newName?: string): ConfigRow {
    const existing = getConfigById(id);
    if (!existing) throw new Error("Model config not found.");
    return createModelConfig({
      name: newName ?? `${existing.name ?? "model"} (copy)`,
      base_url: existing.base_url,
      api: existing.api,
      default_model: existing.default_model,
      context_window: existing.context_window,
      max_tokens: existing.max_tokens,
      request_timeout_ms: existing.request_timeout_ms,
      reasoning: existing.reasoning === 1,
      thinking_level: existing.thinking_level,
      thinking_format: existing.thinking_format,
      text_mode: existing.text_mode === 1,
      two_phase: existing.two_phase === 1,
      extra_json: existing.extra_json,
      compat_json: existing.compat_json,
      thinking_budgets: existing.thinking_budgets,
    });
  }

  /**
   * Promote a model config to be the new global default.
   * The current default (key='default') is demoted to a regular key,
   * and the target config's key is changed to 'default'.
   * Throws if the target is already the default.
   */
  export function setDefaultModelConfig(id: number): ConfigRow {
    const d = getDb();
    const target = getConfigById(id);
    if (!target) throw new Error("Model config not found.");
    if (target.project_id === null && target.key === "default") {
      throw new Error("This config is already the default.");
    }

    // Demote the current default: give it a generated key
    const currentDefault = d
      .prepare(`SELECT * FROM configs WHERE project_id IS NULL AND key = 'default'`)
      .get() as ConfigRow | undefined;
    if (currentDefault) {
      const newKey = `model_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      d.prepare(`UPDATE configs SET key = ? WHERE id = ?`).run(newKey, currentDefault.id);
    }

    // Promote the target
    const ts = now();
    d.prepare(`UPDATE configs SET key = 'default', updated_at = ? WHERE id = ?`).run(ts, id);
    return d.prepare(`SELECT * FROM configs WHERE id = ?`).get(id) as ConfigRow;
  }

  /**
   * Reorder model configs. Accepts an array of config IDs in the desired order.
   * Assigns ordering = index for each ID in a single transaction.
   * IDs not in the list are left untouched.
   */
  export function reorderModelConfigs(ids: number[]): void {
    const d = getDb();
    const stmt = d.prepare(`UPDATE configs SET ordering = ? WHERE id = ?`);
    const tx = d.transaction((idList: number[]) => {
      for (let i = 0; i < idList.length; i++) {
        stmt.run(i, idList[i]);
      }
    });
    tx(ids);
  }

  /** Duplicate a network (creates a new user-editable copy). */
export function duplicateNetwork(identifier: number | string, newName?: string, targetProjectId?: number | null): AgentNetworkRow {
  const network = getNetwork(identifier);
  if (!network) throw new Error("Network not found");
  return createNetwork({
    name: newName ?? `${network.name} (copy)`,
    description: network.description,
    project_id: targetProjectId !== undefined ? targetProjectId : network.project_id,
    intake_kind: network.intake_kind,
    graph_json: network.graph_json,
    is_system: false,
    is_default: false,
  });
}
