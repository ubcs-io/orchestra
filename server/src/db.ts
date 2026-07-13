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

    CREATE TABLE IF NOT EXISTS interventions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id      TEXT,
      kind         TEXT,
      payload_json TEXT,
      created_by   TEXT,
      consumed_at  TEXT,
      created_at   TEXT
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

  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_stage   ON tasks(stage);
    CREATE INDEX IF NOT EXISTS idx_role_runs_task ON role_runs(task_id);
    CREATE INDEX IF NOT EXISTS idx_interventions_task ON interventions(task_id);
    CREATE INDEX IF NOT EXISTS idx_roles_project ON roles(project_id);
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
  paused: number | null;
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
  tool_calls_json: string | null;
  transcript_jsonl: string | null;
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
        system_prompt=@system_prompt, tools_json=@tools_json, model=@model, updated_at=@ts WHERE id=@id`,
    ).run({
      id: existing.id,
      title: input.title ?? existing.title,
      enabled: input.enabled == null ? existing.enabled : input.enabled ? 1 : 0,
      applies_to: input.applies_to ?? existing.applies_to,
      ordering: input.ordering ?? existing.ordering,
      system_prompt: input.system_prompt ?? existing.system_prompt,
      tools_json: input.tools_json ?? existing.tools_json,
      model: input.model ?? existing.model,
      ts,
    });
    return d.prepare(`SELECT * FROM roles WHERE id = ?`).get(existing.id) as RoleRow;
  }

  const info = d
    .prepare(
      `INSERT INTO roles (project_id, key, title, enabled, applies_to, ordering, system_prompt, tools_json, model, created_at, updated_at)
       VALUES (@project_id, @key, @title, @enabled, @applies_to, @ordering, @system_prompt, @tools_json, @model, @ts, @ts)`,
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
  "paused",
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
  const isNumeric = typeof identifier === "number" || /^\d+$/.test(String(identifier));
  const keyCol = isNumeric ? "id" : "task_id";
  const keyVal = isNumeric ? Number(identifier) : String(identifier);
  getDb().prepare(`DELETE FROM tasks WHERE ${keyCol} = ?`).run(keyVal);
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
  tool_calls_json?: string | null;
  transcript_jsonl?: string | null;
  depth?: number;
  model?: string | null;
  tokens?: number | null;
}): RoleRunRow {
  const d = getDb();
  const ts = now();
  const info = d
    .prepare(
      `INSERT INTO role_runs (task_id, role_key, verdict, summary, output_md, coverage_json,
         tool_calls_json, transcript_jsonl, depth, model, tokens, created_at)
       VALUES (@task_id, @role_key, @verdict, @summary, @output_md, @coverage_json,
         @tool_calls_json, @transcript_jsonl, @depth, @model, @tokens, @ts)`,
    )
    .run({
      task_id: input.task_id,
      role_key: input.role_key,
      verdict: input.verdict ?? null,
      summary: input.summary ?? null,
      output_md: input.output_md ?? null,
      coverage_json: input.coverage_json ?? null,
      tool_calls_json: input.tool_calls_json ?? null,
      transcript_jsonl: input.transcript_jsonl ?? null,
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
