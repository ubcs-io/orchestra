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
import { decryptSecret, encryptSecret, isEncrypted } from "./crypto.js";
import { computeRunHealth, isTrustedHealth, roleRunHealthInput, type RunHealth } from "./health.js";

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

/** Millisecond-precision, lexicographically-sortable timestamp (still parses
 *  fine via `new Date(...)` — verified round-trip). Second-precision used to
 *  cause spurious `updated_at` ties between rows touched within the same
 *  second; `pickNextTasks`' scheduler-fairness tie-break (orchestrator.ts)
 *  depends on real ordering between siblings, so a tie there isn't just
 *  cosmetic — it can starve one sibling of dispatch until a full wall-clock
 *  second passes. */
function now(): string {
  return new Date().toISOString().replace("T", " ");
}

/**
 * Normalize a timestamp into the exact textual form this schema stores, so a
 * `created_at >= ?` comparison actually works.
 *
 * Rows are written by {@link now} as `"YYYY-MM-DD HH:MM:SS.sssZ"` — a space, not
 * the `T` that `Date.toISOString()` produces. SQLite compares TEXT
 * lexicographically, and `" "` (0x20) sorts *below* `"T"` (0x54), so passing a
 * raw ISO string to a range query silently matches nothing at all rather than
 * failing loudly. Every caller with a time bound must route through this.
 */
export function toDbTimestamp(value: Date | string): string {
  const iso = value instanceof Date ? value.toISOString() : value;
  return iso.replace("T", " ");
}

function genId(seed: string): string {
  return crypto.createHash("sha256").update(seed).digest("hex");
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Secret columns (PLANNING/overhaul-2/02)
// ---------------------------------------------------------------------------
//
// `projects.github_token` and `configs.api_key` are encrypted at rest and
// decrypted transparently on the way out, so every existing caller keeps
// working against plaintext and no consumer has to know this happened. What
// changes is the DB file: it no longer contains readable credentials.
//
// The rule for anyone adding a read path: route the row through
// {@link readProject} / {@link readConfig} rather than casting a raw `SELECT *`.
// A raw read yields the `enc:` blob, which will fail as a bearer token in a way
// that looks like a wrong credential rather than a missing decrypt.

/** Decrypt a project row's secret column in place. */
function readProject<T extends ProjectRow | undefined>(row: T): T {
  if (row) row.github_token = decryptSecret(row.github_token);
  return row;
}

function readProjects(rows: ProjectRow[]): ProjectRow[] {
  for (const row of rows) row.github_token = decryptSecret(row.github_token);
  return rows;
}

/** Decrypt a config row's secret column in place. */
function readConfig<T extends ConfigRow | undefined>(row: T): T {
  if (row) row.api_key = decryptSecret(row.api_key);
  return row;
}

function readConfigs(rows: ConfigRow[]): ConfigRow[] {
  for (const row of rows) row.api_key = decryptSecret(row.api_key);
  return rows;
}

/**
 * One-time, transparent upgrade of any secret still stored in plaintext
 * (PLANNING/overhaul-2/02 migration step 1). Runs inside initDb, needs no
 * operator action, and is safe to run on every boot:
 *
 *  - values already carrying the `enc:` prefix are skipped, so a second pass is
 *    a no-op and can never double-encrypt a value into unreadability;
 *  - a failure here (an unreadable key file, say) logs and leaves the rows
 *    exactly as they were rather than taking the boot path down with it. An
 *    unencrypted token is a weaker posture; a daemon that won't start is a
 *    worse one.
 */
function encryptExistingSecrets(d: DB): void {
  try {
    const projects = d
      .prepare(`SELECT id, github_token FROM projects WHERE github_token IS NOT NULL AND github_token != ''`)
      .all() as Array<{ id: number; github_token: string }>;
    const configs = d
      .prepare(`SELECT id, api_key FROM configs WHERE api_key IS NOT NULL AND api_key != ''`)
      .all() as Array<{ id: number; api_key: string }>;
    const pending =
      projects.filter((p) => !isEncrypted(p.github_token)).length +
      configs.filter((c) => !isEncrypted(c.api_key)).length;
    if (pending === 0) return;

    const setProject = d.prepare(`UPDATE projects SET github_token = ? WHERE id = ?`);
    const setConfig = d.prepare(`UPDATE configs SET api_key = ? WHERE id = ?`);
    d.transaction(() => {
      for (const p of projects) {
        if (!isEncrypted(p.github_token)) setProject.run(encryptSecret(p.github_token), p.id);
      }
      for (const c of configs) {
        if (!isEncrypted(c.api_key)) setConfig.run(encryptSecret(c.api_key), c.id);
      }
    })();
    console.log(`[db] encrypted ${pending} stored secret(s) at rest`);
  } catch (err) {
    console.warn(`[db] could not encrypt stored secrets: ${(err as Error).message}`);
  }
}

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

    CREATE TABLE IF NOT EXISTS task_chat_messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    TEXT NOT NULL,
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at TEXT
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
  // Which mechanism produced the run's structured verdict under the
  // artifact-first output contract (PLANNING/overhaul/01): "tool" | "fence" |
  // "constrained" | "repair" | "fallback". NULL on rows predating the column
  // and on failure-path rows that never ran a model turn. The queryable
  // per-model degradation signal overhaul/04 aggregates.
  addColumnIfMissing(d, "role_runs", "verdict_source", "verdict_source TEXT");
  addColumnIfMissing(d, "role_runs", "thinking_md", "thinking_md TEXT");
  // Open questions from record_findings (JSON array of strings).
  addColumnIfMissing(d, "role_runs", "open_questions_json", "open_questions_json TEXT");
  // Audit-trail spine for the counter-review overhaul: a "critique" or
  // "second_review" run points back at the primary run it judged via
  // target_run_id; run_kind distinguishes the three kinds of role_runs row.
  addColumnIfMissing(d, "role_runs", "target_run_id", "target_run_id INTEGER");
  addColumnIfMissing(d, "role_runs", "run_kind", "run_kind TEXT DEFAULT 'primary'");
  // Retry lineage for resumable runs (PLANNING/overhaul/03). `attempt` is the
  // 1-based attempt index for this step (1 = first try, 2+ = a resume). NULL on
  // rows predating the column and on runs that never retried. `resumed_from` is
  // the role_run id of the immediately preceding attempt this run continued from
  // (NULL for a cold first attempt). The raw retry-cost signal overhaul/04
  // aggregates and overhaul/06 scores per model.
  addColumnIfMissing(d, "role_runs", "attempt", "attempt INTEGER");
  addColumnIfMissing(d, "role_runs", "resumed_from", "resumed_from INTEGER");
  // Run-health capture (PLANNING/overhaul/04). These complete the raw signal set
  // the derived run-health enum (health.ts) reads; health itself is never stored.
  //   phase            — twoPhase progress at exit (1 = explore done, 2 = formalize
  //                      done; NULL/0 for tool/text mode). From RoleRunResult.phase.
  //   failed_tool_calls — count of tool calls that returned isError this run.
  //   artifact_bytes    — bytes of report prose durably appended to the artifact
  //                      DURING the run; 0 is the literal "wrote no output" signal.
  addColumnIfMissing(d, "role_runs", "phase", "phase INTEGER");
  addColumnIfMissing(d, "role_runs", "failed_tool_calls", "failed_tool_calls INTEGER");
  addColumnIfMissing(d, "role_runs", "artifact_bytes", "artifact_bytes INTEGER");
  // Grounded verification (PLANNING/overhaul/05): JSON array of ExecEvidence —
  // the commands this run actually executed via the allowlisted `run_command`
  // tool, with exit code, duration and captured output. Written ONLY from
  // RoleRunResult.evidence (the harness's own record of what ran); nothing the
  // model says can put a row in here, which is what makes it admissible at the
  // evidence-criteria gate.
  addColumnIfMissing(d, "role_runs", "evidence_json", "evidence_json TEXT");
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
  // Cached server-side structured-decoding probe result (PLANNING/overhaul/02):
  // JSON {probedAt, baseUrl, modelId, modes:{json_object,json_schema,guided_json}}.
  // Re-probed on demand (Settings/Models "Probe endpoint"), not on every request.
  addColumnIfMissing(d, "configs", "structured_outputs_json", "structured_outputs_json TEXT");

  // Agent network linking: custom flow template per task.
  addColumnIfMissing(d, "tasks", "network_id", "network_id TEXT");
  // Links a "decompose question" child task back to the question that spawned it.
  addColumnIfMissing(d, "tasks", "origin_role_key", "origin_role_key TEXT");
  addColumnIfMissing(d, "tasks", "origin_question", "origin_question TEXT");
  // Checkpointing: the task's dedicated git branch, and the branch to return to
  // once the task is accepted.
  addColumnIfMissing(d, "tasks", "git_branch", "git_branch TEXT");
  addColumnIfMissing(d, "tasks", "git_base_branch", "git_base_branch TEXT");
  // Lazily captured the first time a task in this project needs a branch —
  // whatever branch was checked out at that moment.
  addColumnIfMissing(d, "projects", "main_branch", "main_branch TEXT");
  // The commit created immediately after this primary run's artifact commit —
  // the checkpoint that "restore" resets the task's branch back to.
  addColumnIfMissing(d, "role_runs", "git_commit_sha", "git_commit_sha TEXT");
  // Set on a decomposition child when a later answer invalidates a guess its
  // parent task made — flagged for human triage, never cleared automatically.
  addColumnIfMissing(d, "tasks", "stale_reason", "stale_reason TEXT");
  // The task's dedicated git worktree directory — lets each task's role steps
  // run against their own working tree instead of sharing the project's.
  addColumnIfMissing(d, "tasks", "git_worktree_path", "git_worktree_path TEXT");
  // Outcome of merging the task's branch back into its base branch on
  // completion. null = not yet attempted (task predates this feature, or
  // hasn't reached a terminal role yet).
  addColumnIfMissing(d, "tasks", "reconcile_status", "reconcile_status TEXT");
  addColumnIfMissing(d, "tasks", "reconcile_detail", "reconcile_detail TEXT");
  // Family root's task_id: lets a task's whole decomposition tree share one
  // worktree/branch. null on tasks that predate this column (and their
  // future children) — they keep today's one-worktree-per-task behavior.
  addColumnIfMissing(d, "tasks", "root_task_id", "root_task_id TEXT");
  // Set when any role step wrote/edited a real file via the guarded write/edit
  // tools (not just the PLANNING artifact). Gates auto-merge: a task that wrote
  // source code goes to reconcile_status "pending_human_merge" instead of
  // auto-merging its branch into base — see orchestrator.ts's ready-transition.
  addColumnIfMissing(d, "tasks", "wrote_source", "wrote_source INTEGER DEFAULT 0");
  // Per-project GitHub PAT, stored plaintext like configs.api_key (no encryption
  // layer exists anywhere in this app) — used to push a task's branch and open
  // PRs. Falls back to ORCHESTRA_GITHUB_TOKEN when unset. github_repo is an
  // optional "owner/repo" override; when null it's parsed from the "origin" remote.
  addColumnIfMissing(d, "projects", "github_token", "github_token TEXT");
  addColumnIfMissing(d, "projects", "github_repo", "github_repo TEXT");
  // Set once a task's branch has been pushed / had a PR opened via the
  // review-diff UI. github_pr_url flips the "pending human merge" badge to a
  // link; github_pushed_sha is tracked for a future "N commits since you
  // pushed" indicator (not surfaced directly yet).
  addColumnIfMissing(d, "tasks", "github_pr_url", "github_pr_url TEXT");
  addColumnIfMissing(d, "tasks", "github_pushed_sha", "github_pushed_sha TEXT");
  // Structured decomposition output (JSON array of Subtask), superseding the old
  // bracket-tag-regex-over-output_md parsing — see resolveDecompositionSubtasks
  // in orchestrator.ts, which falls back to the regex for pre-existing rows.
  addColumnIfMissing(d, "role_runs", "subtasks_json", "subtasks_json TEXT");
  // Required whenever a can_create_subtasks role intentionally returns zero
  // subtasks (already-atomic work) — an empty subtasks array with this unset is
  // treated as a failed decomposition, not an intentional no-op.
  addColumnIfMissing(d, "role_runs", "no_decomposition_reason", "no_decomposition_reason TEXT");
  // Timing: when a role_start/role_end event was first/last observed for this
  // run. Populated by the orchestrator; null for runs that predate this feature.
  addColumnIfMissing(d, "role_runs", "started_at", "started_at TEXT");
  addColumnIfMissing(d, "role_runs", "ended_at", "ended_at TEXT");
  // Sibling local_ids (from a decomposition's subtasks[].depends_on) resolved to
  // real task_ids at child-creation time. JSON array of task_id strings; null/
  // absent = no dependencies. Consulted by the scheduler's dependenciesSatisfied().
  addColumnIfMissing(d, "tasks", "depends_on_json", "depends_on_json TEXT");

  // "plan" | "edit" | "auto" — how far this task's own pipeline may progress
  // unattended (never write code / write but park for human merge approval /
  // write and attempt to auto-merge). Null = inherit the project's own
  // default (see server/src/autonomy-level.ts's effectiveAutonomyLevel).
  // Distinct from — and unrelated to — the `autonomy` sub-key of project
  // config_json (server/src/autonomy.ts), which governs watcher scheduling.
  addColumnIfMissing(d, "tasks", "autonomy_level", "autonomy_level TEXT");

  // "XS" | "S" | "M" | "L" | "XL" — the explorer role's informed estimate of
  // how much work this task actually is, set once it has looked at the real
  // files (see agent.ts's EffortSize / RecordFindingsSchema). Null until
  // explorer runs. Drives the family-wide decomposition budget and the XS
  // fast path in orchestrator.ts.
  addColumnIfMissing(d, "tasks", "effort_size", "effort_size TEXT");

  // "minimal" | "standard" | "thorough" — per-task override of the family's
  // planning rigor (see server/src/planning-rigor.ts's effectivePlanningRigor).
  // Null = inherit the project's own default at config_json.planningRigor.
  // Distinct from — and unrelated to — the fixed per-intake-kind `rigor` tag
  // on FLOW_TEMPLATES (roles.ts) and the counter-reviewer gate rigor exposed
  // read-only elsewhere in the UI (routes/safety.ts).
  addColumnIfMissing(d, "tasks", "planning_rigor", "planning_rigor TEXT");

  // Self-generated task tracking (PLANNING/overhaul/08): "human" (default,
  // every existing/human-filed task) or "watcher:<name>" for a task a watcher
  // proposed and triage approved. priority (1-5, default 3/mid) is the
  // scheduler's tie-break among same-class tasks — see orchestrator.ts's
  // pickNextTasks.
  addColumnIfMissing(d, "tasks", "origin", "origin TEXT DEFAULT 'human'");
  addColumnIfMissing(d, "tasks", "priority", "priority INTEGER DEFAULT 3");

  // When a human first laid eyes on a self-generated task. Server-side so the
  // "new self-generated" section means the same thing in every browser and
  // session, replacing the client-only localStorage tracking the first
  // autonomy slice shipped with. NULL on every pre-existing row, which for a
  // human-origin task is simply never consulted.
  addColumnIfMissing(d, "tasks", "seen_at", "seen_at TEXT");

  // Role versioning (PLANNING/overhaul-2/03). `roles` stays the single source
  // of truth for what runs right now; `role_versions` is the paper trail behind
  // it, and `roles.current_version_id` is the pointer between them. Nothing
  // about dispatch changes — a role is still read from `roles`.
  d.exec(`
    CREATE TABLE IF NOT EXISTS role_versions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      role_id         INTEGER NOT NULL,
      version_no      INTEGER NOT NULL,
      system_prompt   TEXT,
      tools_json      TEXT,
      model           TEXT,
      created_by_note TEXT,
      created_at      TEXT
    );
  `);
  addColumnIfMissing(d, "roles", "current_version_id", "current_version_id INTEGER");
  // The join key that turns per-run outcome data into per-VERSION outcome data.
  // Nullable, and deliberately never backfilled with a guess: a run that
  // predates versioning simply doesn't contribute to any version's score.
  addColumnIfMissing(d, "role_runs", "role_version_id", "role_version_id INTEGER");

  // Budget guardrails (PLANNING/overhaul-2/01): when the project's spend
  // ceiling stopped this task's next dispatch. NULL on every task that has
  // never been budget-stopped, which is every task until an operator opts in.
  // Deliberately NOT the existing `paused` flag: a human needs to be able to
  // tell "I paused this" from "the budget stopped this", and only the latter
  // clears itself once spend ages out of the rolling window.
  addColumnIfMissing(d, "tasks", "budget_paused_at", "budget_paused_at TEXT");

  // Intake refinement (PLANNING/intake-refinement.md): the pre-flight review
  // layer's per-task state, NULL on every task that took the direct
  // intake → start path (which is every task until an operator clicks
  // "Review intake").
  //   intake_review_state — "scouting" (the intake_triage+explorer prefix is
  //     running early, before a flow is chosen), "proposed" (a proposal is
  //     waiting on a human), "accepted", or "skipped". NULL = not reviewed.
  //   intake_proposal_json — the IntakeProposal the review produced, plus the
  //     human's edits once accepted (see server/src/intake-review.ts).
  addColumnIfMissing(d, "tasks", "intake_review_state", "intake_review_state TEXT");
  addColumnIfMissing(d, "tasks", "intake_proposal_json", "intake_proposal_json TEXT");

  // Who set `effort_size`: "model" (the explorer role's own estimate, the
  // default path) or "human" (corrected during intake review). The distinction
  // has teeth — orchestrator.ts refuses to let a later explorer re-run
  // overwrite a human's correction, which is the entire point of letting a
  // human steer the size before the decomposition budget is drawn from it.
  addColumnIfMissing(d, "tasks", "effort_size_source", "effort_size_source TEXT");

  // Context budgeting (PLANNING/overhaul/07): the ledger's own observability
  // columns, recorded by buildRoleContext's allocator call on every run —
  // in shadow mode (project config `contextBudget` unset/false) this records
  // what WOULD have been assembled/degraded without altering the prompt; once
  // enabled it records what actually was.
  //   context_tokens_est — chars/4 estimate of the assembled role context.
  //   context_degraded   — 1 iff any tier below 1/2 was collapsed or dropped.
  addColumnIfMissing(d, "role_runs", "context_tokens_est", "context_tokens_est INTEGER");
  addColumnIfMissing(d, "role_runs", "context_degraded", "context_degraded INTEGER DEFAULT 0");
  // The verdict trailer's optional handoff contract (doc §4): "what the next
  // role must know that isn't obvious from my summary" — up to ~300 chars,
  // authored by the role itself. Tier-4 prior-run rendering prefers this over
  // `summary` when present. NULL when the role left it out (every existing run).
  addColumnIfMissing(d, "role_runs", "carry_forward", "carry_forward TEXT");
  // Rolling digest of this run's report (doc §2): a ≤400-char extractive
  // summary generated post-run by the same cheap constrained-call machinery as
  // the repair pass (overhaul/03), used in place of a truncated `summary` for
  // Tier-4 one-liner collapse and buildParentDigest. NULL when the digest call
  // was never attempted (short report — see DIGEST_MIN_REPORT_CHARS) or failed.
  addColumnIfMissing(d, "role_runs", "digest", "digest TEXT");

  // Measured model capability profiles (PLANNING/overhaul/06): one record per
  // (connection signature, model id). profile_json holds the full ModelProfile
  // (probes, live aggregates, derived decisions, overrides) — see profiles.ts,
  // which owns the shape; db.ts only stores/retrieves the blob.
  d.exec(`
    CREATE TABLE IF NOT EXISTS model_profiles (
      connection_sig TEXT NOT NULL,
      model_id       TEXT NOT NULL,
      profile_json   TEXT NOT NULL,
      updated_at     TEXT,
      PRIMARY KEY (connection_sig, model_id)
    );
  `);

  // Watcher candidates (PLANNING/overhaul/08 §1/§2): one row per observation a
  // watcher makes, before triage decides whether it becomes a task. Kept even
  // after rejection/suppression — the fingerprint index is what makes dedupe
  // against "recently closed" work (see suppressCandidateForTask).
  // status: pending (awaiting triage) -> queued (became a task) | rejected
  // (triage said not worth it) | capped (would've been approved but a cap
  // blocked it) | suppressed (matches a fingerprint a human closed wont_do).
  d.exec(`
    CREATE TABLE IF NOT EXISTS candidates (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id        INTEGER NOT NULL,
      watcher           TEXT NOT NULL,
      kind              TEXT NOT NULL,
      fingerprint       TEXT NOT NULL,
      payload_json      TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'pending',
      triage_json       TEXT,
      task_id           TEXT,
      suppressed_at     TEXT,
      suppressed_reason TEXT,
      created_at        TEXT,
      updated_at        TEXT
    );
  `);

  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_stage   ON tasks(stage);
    CREATE INDEX IF NOT EXISTS idx_role_runs_task ON role_runs(task_id);
    CREATE INDEX IF NOT EXISTS idx_interventions_task ON interventions(task_id);
    CREATE INDEX IF NOT EXISTS idx_roles_project ON roles(project_id);
    CREATE INDEX IF NOT EXISTS idx_configs_project ON configs(project_id);
    CREATE INDEX IF NOT EXISTS idx_agent_networks_project ON agent_networks(project_id);
    CREATE INDEX IF NOT EXISTS idx_agent_networks_intake ON agent_networks(intake_kind);
    CREATE INDEX IF NOT EXISTS idx_task_chat_messages_task ON task_chat_messages(task_id);
    CREATE INDEX IF NOT EXISTS idx_role_runs_target ON role_runs(target_run_id);
    CREATE INDEX IF NOT EXISTS idx_candidates_project ON candidates(project_id);
    CREATE INDEX IF NOT EXISTS idx_candidates_fp ON candidates(project_id, watcher, fingerprint);
    CREATE INDEX IF NOT EXISTS idx_role_versions_role ON role_versions(role_id, version_no);
    CREATE INDEX IF NOT EXISTS idx_role_runs_version ON role_runs(role_version_id);
  `);

  backfillRoleVersions(d);
  backfillRootTaskIds(d);

  // Last, so the columns and rows it rewrites definitely exist.
  encryptExistingSecrets(d);
}

/**
 * Resolve `root_task_id` for every task that predates the column.
 *
 * When the column was added it was deliberately left null on existing rows,
 * which meant `familyRootId` treated every one of them — including children
 * with a perfectly good `parent_task_id` — as its own family root, so each got
 * its own branch and worktree. That's precisely the "one branch per subtask"
 * sprawl this migration exists to stop, and it also made the server disagree
 * with the client, whose `buildWorktreeFamilies` has always walked
 * `parent_task_id` when `root_task_id` is missing.
 *
 * Walks each orphan up to its topmost ancestor, short-circuiting on any
 * ancestor that already has a resolved root. Cycle-guarded: a corrupted
 * parent chain falls back to treating the task as its own root rather than
 * looping forever.
 */
function backfillRootTaskIds(d: DB): void {
  const rows = d
    .prepare(`SELECT task_id, parent_task_id, root_task_id FROM tasks`)
    .all() as Array<{ task_id: string; parent_task_id: string | null; root_task_id: string | null }>;
  if (!rows.length) return;

  const byId = new Map(rows.map((r) => [r.task_id, r]));
  const resolve = (row: (typeof rows)[number]): string => {
    const seen = new Set<string>([row.task_id]);
    let cur = row;
    for (;;) {
      if (cur.root_task_id && cur !== row) return cur.root_task_id;
      if (!cur.parent_task_id) return cur.task_id;
      const parent = byId.get(cur.parent_task_id);
      if (!parent || seen.has(parent.task_id)) return cur.task_id; // dangling or cyclic
      seen.add(parent.task_id);
      cur = parent;
    }
  };

  const update = d.prepare(`UPDATE tasks SET root_task_id = ? WHERE task_id = ?`);
  let patched = 0;
  d.transaction(() => {
    for (const row of rows) {
      if (row.root_task_id) continue;
      update.run(resolve(row), row.task_id);
      patched++;
    }
  })();
  if (patched) console.log(`[db] backfilled root_task_id for ${patched} task(s)`);
}

/**
 * Give every pre-existing role a version 1 matching what it's already running
 * (PLANNING/overhaul-2/03 migration step 1). No behavior change: a role's
 * "history" simply starts at the definition it has right now, so the first real
 * edit produces a version 2 there's something to compare against.
 *
 * Idempotent — only roles with no `current_version_id` are touched.
 */
function backfillRoleVersions(d: DB): void {
  const orphans = d
    .prepare(
      `SELECT id, system_prompt, tools_json, model FROM roles WHERE current_version_id IS NULL`,
    )
    .all() as Array<{ id: number; system_prompt: string | null; tools_json: string | null; model: string | null }>;
  if (!orphans.length) return;

  const ts = now();
  const insert = d.prepare(
    `INSERT INTO role_versions (role_id, version_no, system_prompt, tools_json, model, created_by_note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const point = d.prepare(`UPDATE roles SET current_version_id = ? WHERE id = ?`);
  d.transaction(() => {
    for (const role of orphans) {
      // version_no is per-role, and a backfilled role has no versions yet — but
      // compute it rather than assuming 1, so this stays correct if a future
      // path ever inserts versions before pointing the role at one.
      const next = (
        d.prepare(`SELECT COALESCE(MAX(version_no), 0) AS n FROM role_versions WHERE role_id = ?`).get(role.id) as {
          n: number;
        }
      ).n + 1;
      const info = insert.run(
        role.id,
        next,
        role.system_prompt,
        role.tools_json,
        role.model,
        "initial version (recorded when versioning was introduced)",
        ts,
      );
      point.run(Number(info.lastInsertRowid), role.id);
    }
  })();
  console.log(`[db] recorded an initial version for ${orphans.length} role(s)`);
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
  main_branch: string | null;
  github_token: string | null;
  github_repo: string | null;
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
  /** The `role_versions` row matching this role's live definition
   *  (PLANNING/overhaul-2/03). Null only between schema creation and the
   *  backfill, never in normal operation. */
  current_version_id: number | null;
  created_at: string;
  updated_at: string;
}

/** One recorded state of a role's definition (PLANNING/overhaul-2/03). Append
 *  only: a revert writes a NEW version whose content matches an old one rather
 *  than rewriting history, the same way restoreCheckpoint treats task history. */
export interface RoleVersionRow {
  id: number;
  role_id: number;
  /** 1-based, per role. */
  version_no: number;
  system_prompt: string | null;
  tools_json: string | null;
  model: string | null;
  /** Free text: "initial version", "reverted to v2", or an operator's note. */
  created_by_note: string | null;
  created_at: string;
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
  origin_role_key: string | null;
  origin_question: string | null;
  git_branch: string | null;
  git_base_branch: string | null;
  stale_reason: string | null;
  git_worktree_path: string | null;
  reconcile_status: string | null;
  reconcile_detail: string | null;
  root_task_id: string | null;
  wrote_source: number | null;
  github_pr_url: string | null;
  github_pushed_sha: string | null;
  depends_on_json: string | null;
  origin: string | null;
  priority: number | null;
  /** ISO timestamp a human first opened this task; NULL = not yet glanced at
   *  (PLANNING/overhaul/08 §2's "distinct lane until first human glance"). */
  seen_at: string | null;
  autonomy_level: string | null;
  effort_size: string | null;
  /** "model" (explorer's own estimate) or "human" (corrected at intake review).
   *  NULL = never set. See PLANNING/intake-refinement.md. */
  effort_size_source: string | null;
  planning_rigor: string | null;
  /** "scouting" | "proposed" | "accepted" | "skipped" — intake review state;
   *  NULL for a task that took the direct intake → start path. */
  intake_review_state: string | null;
  /** The IntakeProposal JSON a review produced (see intake-review.ts). */
  intake_proposal_json: string | null;
  /** When the project's spend ceiling stopped this task's next dispatch
   *  (PLANNING/overhaul-2/01). NULL = never budget-stopped. */
  budget_paused_at: string | null;
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
  structured_outputs_json: string | null;
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
  verdict_source: string | null;
  thinking_md: string | null;
  open_questions_json: string | null;
  target_run_id: number | null;
  run_kind: string;
  /** 1-based attempt index for this step (PLANNING/overhaul/03); NULL = legacy/first. */
  attempt: number | null;
  /** role_run id of the preceding attempt this run resumed from; NULL = cold start. */
  resumed_from: number | null;
  /** twoPhase progress at exit (PLANNING/overhaul/04); NULL for tool/text mode. */
  phase: number | null;
  /** Count of this run's tool calls that returned isError (PLANNING/overhaul/04). */
  failed_tool_calls: number | null;
  /** Bytes of report prose durably appended to the artifact DURING the run
   *  (PLANNING/overhaul/04); 0 = the literal "wrote no output" signal. */
  artifact_bytes: number | null;
  /** JSON `ExecEvidence[]` — commands this run executed via `run_command`
   *  (PLANNING/overhaul/05). Harness-written only; parse with exec.ts's
   *  parseEvidence(). */
  evidence_json: string | null;
  depth: number;
  model: string | null;
  tokens: number | null;
  git_commit_sha: string | null;
  subtasks_json: string | null;
  no_decomposition_reason: string | null;
  started_at: string | null;
  ended_at: string | null;
  /** chars/4 estimate of the assembled role context this run was given
   *  (PLANNING/overhaul/07). NULL on rows predating the column. */
  context_tokens_est: number | null;
  /** 1 iff the context allocator collapsed or dropped any degradable tier for
   *  this run's context (PLANNING/overhaul/07). */
  context_degraded: number | null;
  /** The role's own "what the next role must know" handoff (PLANNING/overhaul/07 §4). */
  carry_forward: string | null;
  /** Rolling ≤400-char digest of this run's report (PLANNING/overhaul/07 §2). */
  digest: string | null;
  /** The `role_versions` row whose definition produced this run
   *  (PLANNING/overhaul-2/03). NULL on every run predating versioning — those
   *  are excluded from version scores rather than guessed at. */
  role_version_id: number | null;
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

export interface TaskChatMessageRow {
  id: number;
  task_id: string;
  role: string;
  content: string;
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

export interface RoleStatRow {
  role_key: string;
  total_calls: number;
  pass_count: number;
  counter_reviewer_passes: number;
  network_count: number;
  total_tokens: number;
}

/** How {@link getHealthStats} buckets primary runs. */
export type HealthStatGroupBy = "model" | "role" | "mode";

/** One reliability rollup bucket (PLANNING/overhaul/04 §3) — the exact shape
 *  overhaul/06 consumes to auto-select output modes. Rates are 0..1. */
export interface RunHealthStatRow {
  /** The bucket key: model name, role_key, or verdict_source ("mode"). */
  group: string;
  runs: number;
  /** Runs whose clean verdict was backed by green harness-recorded command
   *  executions (PLANNING/overhaul/05) — a strict subset of "nothing went
   *  wrong", counted separately from `healthy`. */
  verified: number;
  healthy: number;
  recovered: number;
  degraded: number;
  empty: number;
  /** Runs where a stall was detected. */
  stall_count: number;
  /** Runs truncated at the token limit (stop_reason='length'). */
  truncation_count: number;
  /** Runs where the repair pass was reached (verdict_source in repair|fallback). */
  repair_attempted: number;
  /** Runs the repair pass rescued (verdict_source='repair'). */
  repair_success: number;
  stall_rate: number;
  truncation_rate: number;
  /** repair_success / repair_attempted; 0 when repair was never reached. */
  repair_success_rate: number;
  avg_tokens: number;
  median_tokens: number;
  avg_duration_ms: number;
  /** Context ledger observability (PLANNING/overhaul/07 §5) — p95 assembled
   *  prompt size vs. the degradation frequency it implies. context_degraded
   *  counts runs where the allocator collapsed or dropped a tier (in shadow
   *  mode: WOULD have, for the full/undegraded prompt actually sent). */
  avg_context_tokens_est: number;
  p95_context_tokens_est: number;
  context_degraded_count: number;
  context_degraded_rate: number;
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
  return readProjects(getDb().prepare(`SELECT * FROM projects ORDER BY id DESC`).all() as ProjectRow[]);
}

export function getProject(id: number): ProjectRow | undefined {
  return readProject(getDb().prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as ProjectRow | undefined);
}

const PROJECT_UPDATABLE = new Set([
  "name",
  "repo_path",
  "planning_dir",
  "default_model",
  "default_provider",
  "config_json",
  "main_branch",
  "github_token",
  "github_repo",
]);

export function updateProject(id: number, fields: Record<string, unknown>): ProjectRow | undefined {
  const updates = Object.entries(fields)
    .filter(([k]) => PROJECT_UPDATABLE.has(k))
    // Encrypt on the way in (PLANNING/overhaul-2/02). Idempotent, so a caller
    // that read a row and wrote it straight back is handled either way.
    .map(([k, v]) => (k === "github_token" ? [k, encryptSecret(v as string | null)] : [k, v]) as [string, unknown]);
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

/**
 * Record a new version of a role's definition and point the live row at it
 * (PLANNING/overhaul-2/03 §1). Returns the new version's id.
 */
function recordRoleVersion(
  d: DB,
  roleId: number,
  content: { system_prompt: string | null; tools_json: string | null; model: string | null },
  note: string | null,
): number {
  const next = (
    d.prepare(`SELECT COALESCE(MAX(version_no), 0) AS n FROM role_versions WHERE role_id = ?`).get(roleId) as {
      n: number;
    }
  ).n + 1;
  const info = d
    .prepare(
      `INSERT INTO role_versions (role_id, version_no, system_prompt, tools_json, model, created_by_note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(roleId, next, content.system_prompt, content.tools_json, content.model, note, now());
  const versionId = Number(info.lastInsertRowid);
  d.prepare(`UPDATE roles SET current_version_id = ? WHERE id = ?`).run(versionId, roleId);
  return versionId;
}

/**
 * Insert or update a role identified by (project_id, key).
 *
 * Versioned since PLANNING/overhaul-2/03: instead of overwriting a definition
 * with no record of what it said before, this records a `role_versions` row and
 * repoints `roles.current_version_id`. Dispatch is unchanged — the live `roles`
 * row is still what runs.
 *
 * A version is recorded only when the three *scored* fields (system_prompt,
 * tools_json, model) actually change. Everything else a role carries — title,
 * ordering, enabled — updates in place without minting a version, because a
 * version exists to be compared on outcomes and a re-ordered role produces no
 * different output. This is also what keeps `seedGlobalRoles`, which re-upserts
 * the whole catalog whenever its content hash moves, from stamping a redundant
 * version onto every role each time one of them is edited.
 */
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
  /** Recorded on the version this call creates, if it creates one. */
  version_note?: string | null;
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
    const next = {
      system_prompt: input.system_prompt ?? existing.system_prompt,
      tools_json: input.tools_json ?? existing.tools_json,
      model: input.model ?? existing.model,
    };
    d.prepare(
      `UPDATE roles SET title=@title, enabled=@enabled, applies_to=@applies_to, ordering=@ordering,
        system_prompt=@system_prompt, tools_json=@tools_json, model=@model, can_create_subtasks=@can_create_subtasks, updated_at=@ts WHERE id=@id`,
    ).run({
      id: existing.id,
      title: input.title ?? existing.title,
      enabled: input.enabled == null ? existing.enabled : input.enabled ? 1 : 0,
      applies_to: input.applies_to ?? existing.applies_to,
      ordering: input.ordering ?? existing.ordering,
      ...next,
      can_create_subtasks: input.can_create_subtasks == null ? existing.can_create_subtasks : input.can_create_subtasks ? 1 : 0,
      ts,
    });
    const changed =
      next.system_prompt !== existing.system_prompt ||
      next.tools_json !== existing.tools_json ||
      next.model !== existing.model;
    // A role with no version at all still needs one — covers a row inserted by
    // a path that predates the backfill.
    if (changed || existing.current_version_id == null) {
      recordRoleVersion(d, existing.id, next, input.version_note ?? null);
    }
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
  const roleId = Number(info.lastInsertRowid);
  recordRoleVersion(
    d,
    roleId,
    {
      system_prompt: input.system_prompt ?? null,
      tools_json: input.tools_json ?? null,
      model: input.model ?? null,
    },
    input.version_note ?? "initial version",
  );
  return d.prepare(`SELECT * FROM roles WHERE id = ?`).get(roleId) as RoleRow;
}

// ---------------------------------------------------------------------------
// Role versions (PLANNING/overhaul-2/03)
// ---------------------------------------------------------------------------

/** Newest first — the order the history panel renders. */
export function listRoleVersions(roleId: number): RoleVersionRow[] {
  return getDb()
    .prepare(`SELECT * FROM role_versions WHERE role_id = ? ORDER BY version_no DESC`)
    .all(roleId) as RoleVersionRow[];
}

export function getRoleVersion(id: number): RoleVersionRow | undefined {
  return getDb().prepare(`SELECT * FROM role_versions WHERE id = ?`).get(id) as RoleVersionRow | undefined;
}

/**
 * Revert a role to an earlier version's content by recording a NEW version that
 * matches it, then pointing the role there (PLANNING/overhaul-2/03 §4).
 *
 * Never destructive: the intervening versions stay in the history with their
 * own scores, which is the whole point — "we tried that and it was worse" is
 * information, and rewriting it away would destroy the record the scoring is
 * built on.
 */
export function revertRoleToVersion(roleId: number, versionId: number): RoleRow {
  const d = getDb();
  const target = getRoleVersion(versionId);
  if (!target || target.role_id !== roleId) throw new Error("Version not found for this role.");
  const role = d.prepare(`SELECT * FROM roles WHERE id = ?`).get(roleId) as RoleRow | undefined;
  if (!role) throw new Error("Role not found.");

  d.prepare(
    `UPDATE roles SET system_prompt = ?, tools_json = ?, model = ?, updated_at = ? WHERE id = ?`,
  ).run(target.system_prompt, target.tools_json, target.model, now(), roleId);
  recordRoleVersion(
    d,
    roleId,
    { system_prompt: target.system_prompt, tools_json: target.tools_json, model: target.model },
    `reverted to v${target.version_no}`,
  );
  return d.prepare(`SELECT * FROM roles WHERE id = ?`).get(roleId) as RoleRow;
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

/**
 * Below this many runs, a version's score is underpowered rather than bad — two
 * runs and one failure isn't "worse", it's noise. The UI must not present a
 * score as confident until this many runs have landed (PLANNING/overhaul-2/03
 * risks §1).
 */
export const MIN_RUNS_FOR_CONFIDENT_SCORE = 5;

/** One role version's outcome rollup (PLANNING/overhaul-2/03 §3). Rates 0..1. */
export interface RoleVersionScoreRow {
  version_id: number;
  version_no: number;
  created_at: string;
  created_by_note: string | null;
  /** Whether this is the definition currently running. */
  is_current: boolean;
  /** Primary runs stamped with this version. Runs predating versioning have no
   *  `role_version_id` and are excluded rather than attributed by guess. */
  runs: number;
  pass_rate: number;
  /** Runs whose counter-reviewer returned a non-pass verdict — the gate's own
   *  "send it back" signal, read from the linked critique/second_review row.
   *  Runs with no counter-review are excluded from the denominator (see
   *  `reviewed_runs`), so a role that's never critiqued reads 0, not "perfect". */
  loopback_rate: number;
  /** Reviewed runs where the critique marked at least one criterion failed,
   *  regardless of its overall verdict — a softer signal than the verdict
   *  alone, since a critique can pass while still flagging something. */
  critique_flag_rate: number;
  /** Runs on a task that later drew a human non-acceptance action — a
   *  checkpoint restore, a request-for-changes, or a wont_do. Attribution is
   *  task-level, not run-level: the signal is "work from this version needed a
   *  human to intervene", not "this exact run was rejected". */
  human_override_rate: number;
  /** Runs whose derived health (overhaul/04) was below `healthy` — a version
   *  that only reaches `pass` via repair or fallback is doing worse than its
   *  raw pass rate suggests. */
  degraded_rate: number;
  /** Runs that had a counter-review at all — the denominator behind
   *  loopback_rate/critique_flag_rate, exposed so the UI can say "3 of 7
   *  reviewed" rather than implying the whole sample was checked. */
  reviewed_runs: number;
  avg_tokens: number;
  /** True below {@link MIN_RUNS_FOR_CONFIDENT_SCORE}: don't rank on this. */
  sample_warning: boolean;
}

/**
 * Score every version of one role by the outcomes of its own runs
 * (PLANNING/overhaul-2/03 §3).
 *
 * This is the thing `getRoleStats` structurally cannot do: that query groups by
 * `role_key` across all time, mixing every prompt a role has ever had into one
 * number, so it can tell you a role is good but never that last week's edit
 * made it worse. Grouping by `role_version_id` is the whole difference.
 *
 * A caveat the caller must carry rather than hide: pass rates across versions
 * are only comparable when the underlying work was comparable. A version can
 * score worse purely because it drew harder intakes. The `applies_to` scoping
 * the doc recommends is a UI-level concern; what this function guarantees is
 * only that each run is counted against the version that actually produced it.
 */
export function getRoleVersionStats(roleId: number): RoleVersionScoreRow[] {
  const d = getDb();
  const versions = d
    .prepare(`SELECT * FROM role_versions WHERE role_id = ? ORDER BY version_no DESC`)
    .all(roleId) as RoleVersionRow[];
  if (!versions.length) return [];

  const currentVersionId = (
    d.prepare(`SELECT current_version_id AS v FROM roles WHERE id = ?`).get(roleId) as
      | { v: number | null }
      | undefined
  )?.v ?? null;

  const versionIds = versions.map((v) => v.id);
  const placeholders = versionIds.map(() => "?").join(",");
  const runs = d
    .prepare(
      `SELECT * FROM role_runs
       WHERE role_version_id IN (${placeholders})
         AND (run_kind = 'primary' OR run_kind IS NULL)`,
    )
    .all(...versionIds) as RoleRunRow[];

  // Counter-reviews, keyed by the primary run they judged.
  const critiques = new Map<number, RoleRunRow[]>();
  if (runs.length) {
    const runPlaceholders = runs.map(() => "?").join(",");
    const rows = d
      .prepare(
        `SELECT * FROM role_runs
         WHERE target_run_id IN (${runPlaceholders})
           AND run_kind IN ('critique', 'second_review')`,
      )
      .all(...runs.map((r) => r.id)) as RoleRunRow[];
    for (const c of rows) {
      const list = critiques.get(c.target_run_id!) ?? [];
      list.push(c);
      critiques.set(c.target_run_id!, list);
    }
  }

  // Human non-acceptance actions, per task, with their timestamps — a run only
  // counts as overridden by an action recorded AFTER it ran.
  const overrideByTask = new Map<string, string[]>();
  const taskIds = [...new Set(runs.map((r) => r.task_id))];
  if (taskIds.length) {
    const taskPlaceholders = taskIds.map(() => "?").join(",");
    const rows = d
      .prepare(
        `SELECT task_id, created_at FROM interventions
         WHERE task_id IN (${taskPlaceholders})
           AND kind IN ('restore_checkpoint', 'request_changes', 'wont_do')`,
      )
      .all(...taskIds) as Array<{ task_id: string; created_at: string }>;
    for (const iv of rows) {
      const list = overrideByTask.get(iv.task_id) ?? [];
      list.push(iv.created_at);
      overrideByTask.set(iv.task_id, list);
    }
  }

  const byVersion = new Map<number, RoleRunRow[]>();
  for (const run of runs) {
    const list = byVersion.get(run.role_version_id!) ?? [];
    list.push(run);
    byVersion.set(run.role_version_id!, list);
  }

  const rate = (numerator: number, denominator: number): number =>
    denominator > 0 ? numerator / denominator : 0;

  return versions.map((version) => {
    const mine = byVersion.get(version.id) ?? [];
    let passes = 0;
    let reviewed = 0;
    let loopbacks = 0;
    let flagged = 0;
    let overridden = 0;
    let degraded = 0;
    let tokens = 0;

    for (const run of mine) {
      if (run.verdict === "pass") passes++;
      tokens += run.tokens ?? 0;
      if (!isTrustedHealth(computeRunHealth(roleRunHealthInput(run)))) degraded++;

      const linked = critiques.get(run.id) ?? [];
      if (linked.length) {
        reviewed++;
        if (linked.some((c) => c.verdict !== "pass")) loopbacks++;
        if (linked.some((c) => hasFailedCriterion(c.criteria_results_json))) flagged++;
      }

      const actions = overrideByTask.get(run.task_id) ?? [];
      if (actions.some((at) => at > run.created_at)) overridden++;
    }

    return {
      version_id: version.id,
      version_no: version.version_no,
      created_at: version.created_at,
      created_by_note: version.created_by_note,
      is_current: version.id === currentVersionId,
      runs: mine.length,
      pass_rate: rate(passes, mine.length),
      loopback_rate: rate(loopbacks, reviewed),
      critique_flag_rate: rate(flagged, reviewed),
      human_override_rate: rate(overridden, mine.length),
      degraded_rate: rate(degraded, mine.length),
      reviewed_runs: reviewed,
      avg_tokens: mine.length ? Math.round(tokens / mine.length) : 0,
      sample_warning: mine.length < MIN_RUNS_FOR_CONFIDENT_SCORE,
    };
  });
}

/** Whether a critique's per-criterion judgements contain a real failure. A
 *  malformed/absent blob reads as "nothing flagged" — the same defensive
 *  direction the rest of this file's JSON parsing takes. */
function hasFailedCriterion(criteriaResultsJson: string | null): boolean {
  if (!criteriaResultsJson) return false;
  try {
    const parsed = JSON.parse(criteriaResultsJson) as Array<{ status?: string }>;
    return Array.isArray(parsed) && parsed.some((c) => c?.status === "fail" || c?.status === "failed");
  } catch {
    return false;
  }
}

/** Per-role-key aggregated statistics across all projects. */
export function getRoleStats(): RoleStatRow[] {
  const d = getDb();

  // Calls + passes + tokens (primary runs only)
  const runStats = d.prepare(`
    SELECT
      role_key,
      COUNT(*) AS total_calls,
      SUM(CASE WHEN verdict = 'pass' THEN 1 ELSE 0 END) AS pass_count,
      COALESCE(SUM(tokens), 0) AS total_tokens
    FROM role_runs
    WHERE run_kind = 'primary' OR run_kind IS NULL
    GROUP BY role_key
  `).all() as Array<{ role_key: string; total_calls: number; pass_count: number; total_tokens: number }>;

  // Counter-reviewer passes: primary runs whose linked critique/second_review has verdict='pass'
  const reviewerStats = d.prepare(`
    SELECT
      r1.role_key,
      COUNT(*) AS counter_reviewer_passes
    FROM role_runs r1
    JOIN role_runs r2 ON r2.target_run_id = r1.id
    WHERE (r1.run_kind = 'primary' OR r1.run_kind IS NULL)
      AND r2.run_kind IN ('critique', 'second_review')
      AND r2.verdict = 'pass'
    GROUP BY r1.role_key
  `).all() as Array<{ role_key: string; counter_reviewer_passes: number }>;

  // Network count: count networks whose graph_json contains the role key
  const networkRows = d.prepare(
    `SELECT graph_json FROM agent_networks`,
  ).all() as Array<{ graph_json: string }>;

  const networkCounts = new Map<string, number>();
  for (const row of networkRows) {
    // Use regex to find unique role keys in the graph json
    const matches = row.graph_json.matchAll(/"roleKey"\s*:\s*"([^"]+)"/g);
    const seen = new Set<string>();
    for (const m of matches) {
      const rk = m[1]!;
      if (!seen.has(rk)) {
        seen.add(rk);
        networkCounts.set(rk, (networkCounts.get(rk) ?? 0) + 1);
      }
    }
  }

  // Merge into a map by role_key
  const byKey = new Map<string, RoleStatRow>();
  for (const rs of runStats) {
    byKey.set(rs.role_key, {
      role_key: rs.role_key,
      total_calls: rs.total_calls,
      pass_count: rs.pass_count,
      counter_reviewer_passes: 0,
      network_count: 0,
      total_tokens: rs.total_tokens,
    });
  }
  for (const rev of reviewerStats) {
    const existing = byKey.get(rev.role_key);
    if (existing) {
      existing.counter_reviewer_passes = rev.counter_reviewer_passes;
    }
  }
  for (const e of byKey.values()) {
    e.network_count = networkCounts.get(e.role_key) ?? 0;
  }

  return [...byKey.values()].sort((a, b) => a.role_key.localeCompare(b.role_key));
}

/** Minimal pass/fail projection of a persisted `evidence_json` for the health
 *  derivation (PLANNING/overhaul/05). The stats queries deliberately avoid
 *  importing exec.ts's richer parser: they only need the exit shape, and a
 *  malformed column must read as "no evidence" rather than throw mid-rollup. */
function parseEvidenceShapeForStats(
  json: string | null,
): { exitCode: number | null; timedOut?: boolean; spawnError?: string }[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
      .map((e) => ({
        exitCode: typeof e.exitCode === "number" ? e.exitCode : null,
        timedOut: e.timedOut === true,
        spawnError: typeof e.spawnError === "string" ? e.spawnError : undefined,
      }));
  } catch {
    return [];
  }
}

/**
 * Reliability rollups for the tuning cockpit (PLANNING/overhaul/04 §3, feeds
 * overhaul/06). Buckets primary runs by model / role_key / verdict_source and
 * counts the derived health tiers plus stall/truncation/repair rates and
 * token+duration central tendencies.
 *
 * Health is a JS-derived enum (health.ts), not a SQL-expressible column, so the
 * counting happens in JS. We deliberately select only the small signal columns
 * — never `transcript_jsonl`/`output_md`, which can be large — and derive the
 * "blank output" bit as `output_blank` in SQL so a full report is never pulled.
 */
export function getHealthStats(groupBy: HealthStatGroupBy): RunHealthStatRow[] {
  const d = getDb();
  const rows = d.prepare(`
    SELECT
      role_key,
      model,
      verdict_source,
      fallback,
      stalled,
      stop_reason,
      attempt,
      resumed_from,
      artifact_bytes,
      evidence_json,
      tokens,
      started_at,
      ended_at,
      context_tokens_est,
      context_degraded,
      CASE WHEN TRIM(COALESCE(output_md, '')) = '' THEN 1 ELSE 0 END AS output_blank
    FROM role_runs
    WHERE run_kind = 'primary' OR run_kind IS NULL
  `).all() as Array<{
    role_key: string | null;
    model: string | null;
    verdict_source: string | null;
    fallback: number | null;
    stalled: number | null;
    stop_reason: string | null;
    attempt: number | null;
    resumed_from: number | null;
    artifact_bytes: number | null;
    evidence_json: string | null;
    tokens: number | null;
    started_at: string | null;
    ended_at: string | null;
    context_tokens_est: number | null;
    context_degraded: number | null;
    output_blank: number;
  }>;

  interface Acc {
    tierCounts: Record<RunHealth, number>;
    runs: number;
    stall_count: number;
    truncation_count: number;
    repair_attempted: number;
    repair_success: number;
    tokens: number[];
    durations: number[];
    context_tokens_est: number[];
    context_degraded_count: number;
  }
  const buckets = new Map<string, Acc>();
  const keyFor = (r: (typeof rows)[number]): string => {
    const k =
      groupBy === "model" ? r.model : groupBy === "role" ? r.role_key : r.verdict_source;
    return (k ?? "(unknown)").toString();
  };

  for (const r of rows) {
    const key = keyFor(r);
    let acc = buckets.get(key);
    if (!acc) {
      acc = {
        tierCounts: { verified: 0, healthy: 0, recovered: 0, degraded: 0, empty: 0 },
        runs: 0,
        stall_count: 0,
        truncation_count: 0,
        repair_attempted: 0,
        repair_success: 0,
        tokens: [],
        durations: [],
        context_tokens_est: [],
        context_degraded_count: 0,
      };
      buckets.set(key, acc);
    }
    const health = computeRunHealth({
      verdict_source: r.verdict_source,
      fallback: r.fallback,
      stalled: r.stalled,
      stop_reason: r.stop_reason,
      attempt: r.attempt,
      resumed_from: r.resumed_from,
      artifact_bytes: r.artifact_bytes,
      hasOutput: r.output_blank === 0,
      evidence: parseEvidenceShapeForStats(r.evidence_json),
    });
    acc.runs += 1;
    acc.tierCounts[health] += 1;
    if (r.stalled === 1) acc.stall_count += 1;
    if (r.stop_reason === "length") acc.truncation_count += 1;
    // A "fallback" verdict on the artifact-first path is always preceded by a
    // repair attempt (agent.ts runs formalizeFindings before synthesizeFallback);
    // a "repair" source means that attempt succeeded. Together they are the
    // repair-reached denominator.
    if (r.verdict_source === "repair" || r.verdict_source === "fallback") acc.repair_attempted += 1;
    if (r.verdict_source === "repair") acc.repair_success += 1;
    if (r.tokens != null) acc.tokens.push(r.tokens);
    if (r.started_at && r.ended_at) {
      const dur = new Date(r.ended_at).getTime() - new Date(r.started_at).getTime();
      if (Number.isFinite(dur) && dur >= 0) acc.durations.push(dur);
    }
    // Context ledger (PLANNING/overhaul/07 §5).
    if (r.context_tokens_est != null) acc.context_tokens_est.push(r.context_tokens_est);
    if (r.context_degraded === 1) acc.context_degraded_count += 1;
  }

  const median = (xs: number[]): number => {
    if (xs.length === 0) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
  };
  const mean = (xs: number[]): number =>
    xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
  const rate = (n: number, d: number): number => (d > 0 ? n / d : 0);
  const p95 = (xs: number[]): number => {
    if (xs.length === 0) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const idx = Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1);
    return s[Math.max(0, idx)]!;
  };

  const out: RunHealthStatRow[] = [...buckets.entries()].map(([group, a]) => ({
    group,
    runs: a.runs,
    verified: a.tierCounts.verified,
    healthy: a.tierCounts.healthy,
    recovered: a.tierCounts.recovered,
    degraded: a.tierCounts.degraded,
    empty: a.tierCounts.empty,
    stall_count: a.stall_count,
    truncation_count: a.truncation_count,
    repair_attempted: a.repair_attempted,
    repair_success: a.repair_success,
    stall_rate: rate(a.stall_count, a.runs),
    truncation_rate: rate(a.truncation_count, a.runs),
    repair_success_rate: rate(a.repair_success, a.repair_attempted),
    avg_tokens: mean(a.tokens),
    median_tokens: median(a.tokens),
    avg_duration_ms: mean(a.durations),
    avg_context_tokens_est: mean(a.context_tokens_est),
    p95_context_tokens_est: p95(a.context_tokens_est),
    context_degraded_count: a.context_degraded_count,
    context_degraded_rate: rate(a.context_degraded_count, a.runs),
  }));
  // Busiest buckets first — the ones with enough data to tune on.
  return out.sort((x, y) => y.runs - x.runs || x.group.localeCompare(y.group));
}

/** Per-task run-health rollup for board cards (PLANNING/overhaul/04 §2). */
export interface TaskHealthSummary {
  /** Count of primary runs whose derived health is degraded or empty. */
  degraded_runs: number;
  /** Health of the most recent primary run — the "latest terminal" signal the
   *  board uses to give a card a distinct low-trust state. null = no primary runs. */
  latest_health: RunHealth | null;
}

/**
 * Batched health summaries for a set of tasks — one query over the minimal
 * signal columns (never output_md/transcript_jsonl), health derived in JS.
 * Returns a map keyed by task_id; tasks with no primary runs are absent.
 */
export function getTaskHealthSummaries(taskIds: string[]): Map<string, TaskHealthSummary> {
  const out = new Map<string, TaskHealthSummary>();
  if (taskIds.length === 0) return out;
  const placeholders = taskIds.map(() => "?").join(",");
  const rows = getDb().prepare(`
    SELECT
      id, task_id, verdict_source, fallback, stalled, stop_reason,
      attempt, resumed_from, artifact_bytes, evidence_json,
      CASE WHEN TRIM(COALESCE(output_md, '')) = '' THEN 1 ELSE 0 END AS output_blank
    FROM role_runs
    WHERE (run_kind = 'primary' OR run_kind IS NULL)
      AND task_id IN (${placeholders})
    ORDER BY id ASC
  `).all(...taskIds) as Array<{
    id: number;
    task_id: string;
    verdict_source: string | null;
    fallback: number | null;
    stalled: number | null;
    stop_reason: string | null;
    attempt: number | null;
    resumed_from: number | null;
    artifact_bytes: number | null;
    evidence_json: string | null;
    output_blank: number;
  }>;

  for (const r of rows) {
    const health = computeRunHealth({
      verdict_source: r.verdict_source,
      fallback: r.fallback,
      stalled: r.stalled,
      stop_reason: r.stop_reason,
      attempt: r.attempt,
      resumed_from: r.resumed_from,
      artifact_bytes: r.artifact_bytes,
      hasOutput: r.output_blank === 0,
      evidence: parseEvidenceShapeForStats(r.evidence_json),
    });
    let s = out.get(r.task_id);
    if (!s) {
      s = { degraded_runs: 0, latest_health: null };
      out.set(r.task_id, s);
    }
    if (health === "degraded" || health === "empty") s.degraded_runs += 1;
    // Rows are ordered by id ascending, so the last write wins → latest run.
    s.latest_health = health;
  }
  return out;
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
  return readConfig(
    getDb()
      .prepare(`SELECT * FROM configs WHERE project_id IS NULL AND key = 'default'`)
      .get() as ConfigRow | undefined,
  );
}

/** A project's override profile for `key` (default 'default'), if any. */
export function getProjectConfig(projectId: number, key = "default"): ConfigRow | undefined {
  return readConfig(
    getDb()
      .prepare(`SELECT * FROM configs WHERE project_id = ? AND key = ?`)
      .get(projectId, key) as ConfigRow | undefined,
  );
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
  structured_outputs_json?: string | null;
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
      // `base` here is a RAW row (read directly below, not through readConfig),
      // so an untouched prior value is already ciphertext — and encryptSecret
      // passes that through rather than double-encrypting it.
      api_key: encryptSecret(keep(input.api_key, base.api_key)),
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
      structured_outputs_json: keep(input.structured_outputs_json, base.structured_outputs_json),
    };

  if (existing) {
    d.prepare(
      `UPDATE configs SET name=@name, base_url=@base_url, api_key=@api_key, api=@api,
        default_model=@default_model, context_window=@context_window, max_tokens=@max_tokens,
        request_timeout_ms=@request_timeout_ms, reasoning=@reasoning, thinking_level=@thinking_level,
        thinking_format=@thinking_format, text_mode=@text_mode, two_phase=@two_phase, extra_json=@extra_json, compat_json=@compat_json, thinking_budgets=@thinking_budgets, structured_outputs_json=@structured_outputs_json, updated_at=@ts WHERE id=@id`,
    ).run({ ...merged, id: existing.id, ts });
    return readConfig(d.prepare(`SELECT * FROM configs WHERE id = ?`).get(existing.id) as ConfigRow);
  }

  const info = d
    .prepare(
      `INSERT INTO configs (project_id, key, name, base_url, api_key, api, default_model,
         context_window, max_tokens, request_timeout_ms, reasoning, thinking_level, thinking_format, text_mode, two_phase, extra_json, compat_json, thinking_budgets, structured_outputs_json, created_at, updated_at)
       VALUES (@project_id, @key, @name, @base_url, @api_key, @api, @default_model,
         @context_window, @max_tokens, @request_timeout_ms, @reasoning, @thinking_level, @thinking_format, @text_mode, @two_phase, @extra_json, @compat_json, @thinking_budgets, @structured_outputs_json, @ts, @ts)`,
    )
    .run({ ...merged, project_id: input.project_id, key, ts });
  return readConfig(d.prepare(`SELECT * FROM configs WHERE id = ?`).get(Number(info.lastInsertRowid)) as ConfigRow);
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
  network_id?: string | null;
  origin_role_key?: string | null;
  origin_question?: string | null;
  acceptance_criteria?: string | null;
  depends_on_json?: string | null;
  origin?: string | null;
  priority?: number | null;
}): TaskRow {
  const d = getDb();
  const ts = now();
  const taskId = genId(`${ts}-${process.hrtime.bigint()}`);
  // A brand-new root task anchors its own family (self-reference); a child
  // inherits its parent's already-resolved root, so lookups never need to
  // walk the parent chain, no matter how deep decomposition nests. A root
  // task's own root_task_id is null (either it's fresh, or it predates this
  // column), so falling back to `?? null` here would leave every one of its
  // direct children without a family to join — fall back to the parent's own
  // id instead, since an unresolved root_task_id always means "the parent IS
  // the root."
  const rootTaskId = input.parent_task_id
    ? (getTask(input.parent_task_id)?.root_task_id ?? input.parent_task_id)
    : taskId;
  const info = d
    .prepare(
      `INSERT INTO tasks (task_id, name, status, model, content, project_id, stage, level, intake_kind,
         exit_kind, parent_task_id, task_type, step_number, artifact_path, refinement_plan_json,
         network_id, origin_role_key, origin_question, acceptance_criteria, depends_on_json, root_task_id,
         origin, priority, created_at, updated_at)
       VALUES (@task_id, @name, @status, @model, @content, @project_id, @stage, @level, @intake_kind,
         @exit_kind, @parent_task_id, @task_type, @step_number, @artifact_path, @refinement_plan_json,
         @network_id, @origin_role_key, @origin_question, @acceptance_criteria, @depends_on_json, @root_task_id,
         @origin, @priority, @ts, @ts)`,
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
      network_id: input.network_id ?? null,
      origin_role_key: input.origin_role_key ?? null,
      origin_question: input.origin_question ?? null,
      acceptance_criteria: input.acceptance_criteria ?? null,
      depends_on_json: input.depends_on_json ?? null,
      root_task_id: rootTaskId,
      origin: input.origin ?? "human",
      priority: input.priority ?? 3,
      ts,
    });
  return getTask(Number(info.lastInsertRowid))!;
}

/**
 * The task_id of a family's shared-worktree anchor: itself for a root task,
 * otherwise its resolved root.
 *
 * `backfillRootTaskIds` fills the column in for every existing row, so the
 * parent-walk fallback is belt-and-braces for a task whose root was somehow
 * never resolved (a row written by an older build against a newer DB). It
 * matters because the alternative — treating a task that plainly has a parent
 * as its own root — silently hands it a second branch and worktree, and makes
 * the server disagree with the client's `buildWorktreeFamilies`, which has
 * always done this walk.
 */
export function familyRootId(task: TaskRow): string {
  if (task.root_task_id) return task.root_task_id;
  if (!task.parent_task_id) return task.task_id;
  const seen = new Set<string>([task.task_id]);
  let cur = task;
  while (cur.parent_task_id && !seen.has(cur.parent_task_id)) {
    seen.add(cur.parent_task_id);
    const parent = getTask(cur.parent_task_id);
    if (!parent) break;
    if (parent.root_task_id) return parent.root_task_id;
    cur = parent;
  }
  return cur.task_id;
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

export function listTasks(
  opts: { projectId?: number; stage?: string; parentTaskId?: string; rootTaskId?: string } = {},
): TaskRow[] {
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
  if (opts.rootTaskId) {
    // OR task_id = ? so this still returns the root's own row even if its
    // root_task_id predates the column (null) or its root row was deleted.
    where.push("(root_task_id = ? OR task_id = ?)");
    params.push(opts.rootTaskId, opts.rootTaskId);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return d
    .prepare(`SELECT * FROM tasks ${clause} ORDER BY created_at DESC, id DESC`)
    .all(...(params as never[])) as TaskRow[];
}

/** Other tasks sharing this task's worktree family (siblings/parent/children),
 *  excluding the task itself. Used to guard against reclaiming a worktree
 *  that's still in use by another family member. */
export function familyMembersExcluding(task: TaskRow): TaskRow[] {
  return listTasks({ rootTaskId: familyRootId(task) }).filter((t) => t.task_id !== task.task_id);
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
  // Normally write-once at createTask. Updatable so a task orphaned by a
  // vanished family root can be promoted to its own root (ensureTaskWorkspace)
  // instead of being left with no worktree at all.
  "root_task_id",
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
  "git_branch",
  "git_base_branch",
  "stale_reason",
  "git_worktree_path",
  "reconcile_status",
  "reconcile_detail",
  "wrote_source",
  "github_pr_url",
  "github_pushed_sha",
  "depends_on_json",
  "origin",
  "priority",
  "seen_at",
  "autonomy_level",
  "effort_size",
  "effort_size_source",
  "planning_rigor",
  "budget_paused_at",
  "intake_review_state",
  "intake_proposal_json",
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

/**
 * Hand a family's identity to a surviving member when its root is deleted.
 *
 * Without this, deleting a root leaves its descendants pointing at a row that
 * no longer exists. `ensureTaskWorkspace` can't resolve the root, returns them
 * with no `git_worktree_path`, and `taskRepoPath` then falls back to the
 * project's SHARED checkout — so the orphans run with no worktree isolation at
 * all, which is worse than the duplicate worktree the family scheme exists to
 * prevent.
 *
 * The eldest surviving member takes over: it becomes its own root, adopts the
 * dead root's worktree/branch, and every other member (plus anything that was
 * parented directly on the deleted row) re-points at it.
 */
function reRootFamily(d: DB, root: TaskRow): void {
  const members = listTasks({ rootTaskId: root.task_id }).filter((t) => t.task_id !== root.task_id);
  if (!members.length) return;

  // listTasks orders created_at DESC, so the last entry is the eldest.
  const heir = members[members.length - 1]!;
  const rest = members.filter((t) => t.task_id !== heir.task_id);

  d.prepare(
    `UPDATE tasks SET root_task_id = ?, parent_task_id = NULL, task_type = 'root',
       git_worktree_path = COALESCE(git_worktree_path, ?),
       git_branch = COALESCE(git_branch, ?),
       git_base_branch = COALESCE(git_base_branch, ?),
       updated_at = ?
     WHERE task_id = ?`,
  ).run(
    heir.task_id,
    root.git_worktree_path,
    root.git_branch,
    root.git_base_branch,
    now(),
    heir.task_id,
  );

  const reparent = d.prepare(
    `UPDATE tasks SET root_task_id = ?,
       parent_task_id = CASE WHEN parent_task_id = ? THEN ? ELSE parent_task_id END,
       updated_at = ?
     WHERE task_id = ?`,
  );
  for (const m of rest) reparent.run(heir.task_id, root.task_id, heir.task_id, now(), m.task_id);

  console.log(
    `[db] re-rooted family ${root.task_id.slice(0, 8)} -> ${heir.task_id.slice(0, 8)} (${members.length} member(s))`,
  );
}

export function deleteTask(identifier: number | string): void {
  const d = getDb();
  const task = getTask(identifier);
  if (!task) return;

  // Before the row goes: if this task anchors a family that outlives it, hand
  // the family's worktree/branch to a survivor rather than orphaning them.
  if (familyRootId(task) === task.task_id) reRootFamily(d, task);

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
      paused = 1,
      response = NULL,
      failure_reason = NULL,
      acceptance_criteria = NULL,
      completion_criteria = NULL,
      refinement_plan_json = NULL,
      coverage_json = NULL,
      artifact_path = NULL,
      workspace = NULL,
      git_worktree_path = NULL,
      reconcile_status = NULL,
      reconcile_detail = NULL,
      github_pr_url = NULL,
      github_pushed_sha = NULL,
      task_type = 'root',
      step_number = NULL,
      model = NULL,
      depends_on_json = NULL,
      effort_size_source = NULL,
      intake_review_state = NULL,
      intake_proposal_json = NULL,
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
  verdict_source?: string | null;
  thinking_md?: string | null;
  open_questions_json?: string | null;
  /** The primary run this critiques/second-reviews, if this is not itself a primary run. */
  target_run_id?: number | null;
  /** "primary" (default) | "critique" | "second_review". */
  run_kind?: string;
  /** Retry lineage (PLANNING/overhaul/03). */
  attempt?: number | null;
  resumed_from?: number | null;
  /** Run-health capture (PLANNING/overhaul/04). */
  phase?: number | null;
  failed_tool_calls?: number | null;
  artifact_bytes?: number | null;
  /** Harness-recorded command executions (PLANNING/overhaul/05), JSON array. */
  evidence_json?: string | null;
  depth?: number;
  model?: string | null;
  tokens?: number | null;
  subtasks_json?: string | null;
  no_decomposition_reason?: string | null;
  /** Context ledger observability (PLANNING/overhaul/07). */
  context_tokens_est?: number | null;
  context_degraded?: number | null;
  carry_forward?: string | null;
  /** The role definition that produced this run (PLANNING/overhaul-2/03) —
   *  the role's `current_version_id` at dispatch time. The join key that turns
   *  per-run outcomes into per-version outcomes. */
  role_version_id?: number | null;
}): RoleRunRow {
  const d = getDb();
  const ts = now();
  const info = d
    .prepare(
      `INSERT INTO role_runs (task_id, role_key, verdict, summary, output_md, coverage_json,
         criteria_results_json, tool_calls_json, transcript_jsonl, stop_reason, fallback, stalled, verdict_source,
         thinking_md, open_questions_json, target_run_id, run_kind, attempt, resumed_from,
         phase, failed_tool_calls, artifact_bytes, evidence_json, depth, model, tokens, subtasks_json,
         no_decomposition_reason, context_tokens_est, context_degraded, carry_forward, role_version_id, created_at)
       VALUES (@task_id, @role_key, @verdict, @summary, @output_md, @coverage_json,
         @criteria_results_json, @tool_calls_json, @transcript_jsonl, @stop_reason, @fallback, @stalled, @verdict_source,
         @thinking_md, @open_questions_json, @target_run_id, @run_kind, @attempt, @resumed_from,
         @phase, @failed_tool_calls, @artifact_bytes, @evidence_json, @depth, @model, @tokens, @subtasks_json,
         @no_decomposition_reason, @context_tokens_est, @context_degraded, @carry_forward, @role_version_id, @ts)`,
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
      verdict_source: input.verdict_source ?? null,
      thinking_md: input.thinking_md ?? null,
      open_questions_json: input.open_questions_json ?? null,
      target_run_id: input.target_run_id ?? null,
      run_kind: input.run_kind ?? "primary",
      attempt: input.attempt ?? null,
      resumed_from: input.resumed_from ?? null,
      phase: input.phase ?? null,
      failed_tool_calls: input.failed_tool_calls ?? null,
      artifact_bytes: input.artifact_bytes ?? null,
      evidence_json: input.evidence_json ?? null,
      depth: input.depth ?? 1,
      model: input.model ?? null,
      tokens: input.tokens ?? null,
      subtasks_json: input.subtasks_json ?? null,
      no_decomposition_reason: input.no_decomposition_reason ?? null,
      context_tokens_est: input.context_tokens_est ?? null,
      context_degraded: input.context_degraded ?? 0,
      carry_forward: input.carry_forward ?? null,
      role_version_id: input.role_version_id ?? null,
      ts,
    });
  return d.prepare(`SELECT * FROM role_runs WHERE id = ?`).get(Number(info.lastInsertRowid)) as RoleRunRow;
}

/** Persist the post-run digest (PLANNING/overhaul/07 §2) once the cheap
 *  formalize call completes — separate from createRoleRun because the digest
 *  is generated from the run's own just-persisted report/summary. */
export function setRoleRunDigest(id: number, digest: string): void {
  getDb().prepare(`UPDATE role_runs SET digest = ? WHERE id = ?`).run(digest, id);
}

export function listRoleRuns(taskId: string): RoleRunRow[] {
  return getDb()
    .prepare(`SELECT * FROM role_runs WHERE task_id = ? ORDER BY id ASC`)
    .all(taskId) as RoleRunRow[];
}

export function getRoleRun(id: number): RoleRunRow | undefined {
  return getDb().prepare(`SELECT * FROM role_runs WHERE id = ?`).get(id) as RoleRunRow | undefined;
}

/** Critique/second-review runs recorded against a specific primary run. */
export function listCritiquesForRun(runId: number): RoleRunRow[] {
  return getDb()
    .prepare(`SELECT * FROM role_runs WHERE target_run_id = ? ORDER BY id ASC`)
    .all(runId) as RoleRunRow[];
}

/** Record the checkpoint commit created right after a primary run's artifact commit. */
export function setRoleRunCommitSha(id: number, sha: string): void {
  getDb().prepare(`UPDATE role_runs SET git_commit_sha = ? WHERE id = ?`).run(sha, id);
}

/** Record timing for a role run. Only writes columns that are currently null
 *  (first event wins for started_at, last event wins for ended_at). */
export function setRoleRunTimings(id: number, timings: { started_at?: string; ended_at?: string }): void {
  const d = getDb();
  if (timings.started_at) {
    d.prepare(`UPDATE role_runs SET started_at = COALESCE(started_at, ?) WHERE id = ?`).run(timings.started_at, id);
  }
  if (timings.ended_at) {
    d.prepare(`UPDATE role_runs SET ended_at = ? WHERE id = ?`).run(timings.ended_at, id);
  }
}

/** Update a run's open_questions_json — used to mark a guess "confirmed"/"invalidated"
 *  once a human's later answer has been compared against it. */
export function setRoleRunOpenQuestions(id: number, openQuestionsJson: string): void {
  getDb().prepare(`UPDATE role_runs SET open_questions_json = ? WHERE id = ?`).run(openQuestionsJson, id);
}

/**
 * Checkpoint restore: drop every role_runs row (primary, critique, second_review)
 * created after the checkpoint being restored to. Ids are creation-ordered, so
 * `id > id` captures everything that happened after it regardless of run_kind.
 */
export function deleteRoleRunsAfter(taskId: string, id: number): void {
  getDb().prepare(`DELETE FROM role_runs WHERE task_id = ? AND id > ?`).run(taskId, id);
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

/** Checkpoint restore: discard unconsumed interventions from after the checkpoint
 *  so they can't fire against a plan/run history that no longer exists. */
export function deleteUnconsumedInterventionsAfter(taskId: string, createdAt: string): void {
  getDb()
    .prepare(`DELETE FROM interventions WHERE task_id = ? AND consumed_at IS NULL AND created_at > ?`)
    .run(taskId, createdAt);
}

// ---------------------------------------------------------------------------
// Task chat messages (freeform chat against a decomposed question subtask)
// ---------------------------------------------------------------------------

export function createChatMessage(input: {
  task_id: string;
  role: "user" | "assistant";
  content: string;
}): TaskChatMessageRow {
  const d = getDb();
  const ts = now();
  const info = d
    .prepare(
      `INSERT INTO task_chat_messages (task_id, role, content, created_at)
       VALUES (@task_id, @role, @content, @ts)`,
    )
    .run({ task_id: input.task_id, role: input.role, content: input.content, ts });
  return d
    .prepare(`SELECT * FROM task_chat_messages WHERE id = ?`)
    .get(Number(info.lastInsertRowid)) as TaskChatMessageRow;
}

export function listChatMessages(taskId: string): TaskChatMessageRow[] {
  return getDb()
    .prepare(`SELECT * FROM task_chat_messages WHERE task_id = ? ORDER BY id ASC`)
    .all(taskId) as TaskChatMessageRow[];
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
// Model performance stats (historical TPS from role_runs)
// ---------------------------------------------------------------------------

export interface ModelPerformanceRow {
  config_id: number;
  config_name: string | null;
  model_id: string | null;
  total_runs: number;
  total_tokens: number;
  avg_tokens_per_run: number;
}

/** Aggregate token usage from role_runs, keyed by the model identifier string. */
export function getModelPerformanceStats(): ModelPerformanceRow[] {
  const d = getDb();
  const raw = d.prepare(`
    SELECT
      r.model AS model_id,
      COUNT(*) AS total_runs,
      COALESCE(SUM(r.tokens), 0) AS total_tokens
    FROM role_runs r
    WHERE r.model IS NOT NULL AND r.tokens IS NOT NULL AND r.tokens > 0
    GROUP BY r.model
  `).all() as Array<{ model_id: string; total_runs: number; total_tokens: number }>;

  // Match runs to configs by model name (the config's default_model field).
  const configs = listModelConfigs();
  const result: ModelPerformanceRow[] = [];

  for (const row of raw) {
    // Find configs where default_model matches this model_id
    const matching = configs.filter((c) => c.default_model === row.model_id);
    if (matching.length > 0) {
      for (const cfg of matching) {
        result.push({
          config_id: cfg.id,
          config_name: cfg.name,
          model_id: row.model_id,
          total_runs: row.total_runs,
          total_tokens: row.total_tokens,
          avg_tokens_per_run: row.total_runs > 0 ? Math.round(row.total_tokens / row.total_runs) : 0,
        });
      }
    } else {
      // Model name appears in runs but doesn't match any config's default_model
      result.push({
        config_id: -1,
        config_name: null,
        model_id: row.model_id,
        total_runs: row.total_runs,
        total_tokens: row.total_tokens,
        avg_tokens_per_run: row.total_runs > 0 ? Math.round(row.total_tokens / row.total_runs) : 0,
      });
    }
  }

  return result;
}

  // ---------------------------------------------------------------------------
  // Model Configs (named connection profiles beyond the global default)
  // ---------------------------------------------------------------------------

  /** Return all model configs including the global default row. Sorted by user ordering. */
  export function listModelConfigs(): ConfigRow[] {
    return readConfigs(
      getDb()
        .prepare(`SELECT * FROM configs ORDER BY ordering ASC, id ASC`)
        .all() as ConfigRow[],
    );
  }

  export function getConfigById(id: number): ConfigRow | undefined {
    return readConfig(getDb().prepare(`SELECT * FROM configs WHERE id = ?`).get(id) as ConfigRow | undefined);
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
    structured_outputs_json?: string | null;
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
           text_mode, two_phase, extra_json, compat_json, thinking_budgets, structured_outputs_json, ordering, created_at, updated_at)
         VALUES (NULL, @key, @name, @base_url, @api_key, @api, @default_model,
           @context_window, @max_tokens, @request_timeout_ms, @reasoning, @thinking_level, @thinking_format,
           @text_mode, @two_phase, @extra_json, @compat_json, @thinking_budgets, @structured_outputs_json, @ordering, @ts, @ts)`,
      )
      .run({
        key,
        name: input.name,
        base_url: input.base_url ?? null,
        api_key: encryptSecret(input.api_key ?? null),
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
        structured_outputs_json: input.structured_outputs_json ?? null,
        ordering,
        ts,
      });
    return readConfig(d.prepare(`SELECT * FROM configs WHERE id = ?`).get(Number(info.lastInsertRowid)) as ConfigRow);
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
    structured_outputs_json?: string | null;
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
      // `existing` came from getConfigById, i.e. already decrypted — so an
      // untouched prior value is re-encrypted here, same as a brand-new one.
      api_key: encryptSecret(keep(input.api_key, existing.api_key)),
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
      structured_outputs_json: keep(input.structured_outputs_json, existing.structured_outputs_json),
    };

    const ts = now();
    d.prepare(
      `UPDATE configs SET name=@name, base_url=@base_url, api_key=@api_key, api=@api,
        default_model=@default_model, context_window=@context_window, max_tokens=@max_tokens,
        request_timeout_ms=@request_timeout_ms, reasoning=@reasoning, thinking_level=@thinking_level,
        thinking_format=@thinking_format, text_mode=@text_mode, two_phase=@two_phase,
        extra_json=@extra_json, compat_json=@compat_json, thinking_budgets=@thinking_budgets, structured_outputs_json=@structured_outputs_json, updated_at=@ts WHERE id=@id`,
    ).run({ ...merged, id, ts });
    return readConfig(d.prepare(`SELECT * FROM configs WHERE id = ?`).get(id) as ConfigRow);
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
    return readConfig(d.prepare(`SELECT * FROM configs WHERE id = ?`).get(id) as ConfigRow);
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

// ---------------------------------------------------------------------------
// Model capability profiles (PLANNING/overhaul/06)
// ---------------------------------------------------------------------------

export interface ModelProfileRow {
  connection_sig: string;
  model_id: string;
  profile_json: string;
  updated_at: string | null;
}

export function getModelProfileRow(connectionSig: string, modelId: string): ModelProfileRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM model_profiles WHERE connection_sig = ? AND model_id = ?`)
    .get(connectionSig, modelId) as ModelProfileRow | undefined;
}

export function upsertModelProfileRow(connectionSig: string, modelId: string, profileJson: string): void {
  getDb()
    .prepare(
      `INSERT INTO model_profiles (connection_sig, model_id, profile_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(connection_sig, model_id) DO UPDATE SET profile_json = excluded.profile_json, updated_at = excluded.updated_at`,
    )
    .run(connectionSig, modelId, profileJson, now());
}

export function listModelProfileRows(): ModelProfileRow[] {
  return getDb()
    .prepare(`SELECT * FROM model_profiles ORDER BY connection_sig, model_id`)
    .all() as ModelProfileRow[];
}

export function deleteModelProfileRow(connectionSig: string, modelId: string): void {
  getDb().prepare(`DELETE FROM model_profiles WHERE connection_sig = ? AND model_id = ?`).run(connectionSig, modelId);
}

/** The live-calibration input a capability profile folds in (overhaul/06 §3):
 *  degradation rates over the most recent `window` primary runs of a model.
 *  Keyed by model id only — role_runs does not record which endpoint served a
 *  run, and in practice one model id maps to one endpoint at a time. */
export interface ModelLiveStats {
  /** All-time primary-run count for the model — the hysteresis clock. */
  totalRuns: number;
  /** Runs actually sampled (≤ window). Rates below are over these runs. */
  runs: number;
  window: number;
  /** Share of sampled runs whose verdict was synthesized (fallback). */
  fallbackRate: number;
  stallRate: number;
  /** Share truncated at the token limit (stop_reason='length'). */
  truncationRate: number;
  /** Share where the repair pass was reached (verdict_source repair|fallback). */
  repairRate: number;
  /** Sampled runs bucketed by verdict_source ("tool"|"fence"|"constrained"|…). */
  byMode: Record<string, number>;
}

/**
 * Windowed live rates for one model. Selects only the small signal columns of
 * the last `window` primary runs (never output_md/transcript_jsonl). Returns
 * null when the model has no primary runs at all — "no live data yet" and
 * "clean live data" must be distinguishable to the derivation policy.
 */
export function getModelLiveStats(model: string, window: number): ModelLiveStats | null {
  const d = getDb();
  const total = (
    d
      .prepare(
        `SELECT COUNT(*) AS c FROM role_runs WHERE model = ? AND (run_kind = 'primary' OR run_kind IS NULL)`,
      )
      .get(model) as { c: number }
  ).c;
  if (total === 0) return null;

  const rows = d
    .prepare(
      `SELECT verdict_source, fallback, stalled, stop_reason
       FROM role_runs
       WHERE model = ? AND (run_kind = 'primary' OR run_kind IS NULL)
       ORDER BY id DESC LIMIT ?`,
    )
    .all(model, window) as Array<{
    verdict_source: string | null;
    fallback: number | null;
    stalled: number | null;
    stop_reason: string | null;
  }>;

  let fallbackCount = 0;
  let stallCount = 0;
  let truncationCount = 0;
  let repairCount = 0;
  const byMode: Record<string, number> = {};
  for (const r of rows) {
    if (r.fallback === 1 || r.verdict_source === "fallback") fallbackCount += 1;
    if (r.stalled === 1) stallCount += 1;
    if (r.stop_reason === "length") truncationCount += 1;
    if (r.verdict_source === "repair" || r.verdict_source === "fallback") repairCount += 1;
    const mode = r.verdict_source ?? "(none)";
    byMode[mode] = (byMode[mode] ?? 0) + 1;
  }
  const runs = rows.length;
  const rate = (n: number): number => (runs > 0 ? n / runs : 0);
  return {
    totalRuns: total,
    runs,
    window,
    fallbackRate: rate(fallbackCount),
    stallRate: rate(stallCount),
    truncationRate: rate(truncationCount),
    repairRate: rate(repairCount),
    byMode,
  };
}

// ---------------------------------------------------------------------------
// Watcher candidates (PLANNING/overhaul/08)
// ---------------------------------------------------------------------------

export interface CandidateRow {
  id: number;
  project_id: number;
  watcher: string;
  kind: string;
  fingerprint: string;
  payload_json: string;
  status: string;
  triage_json: string | null;
  task_id: string | null;
  suppressed_at: string | null;
  suppressed_reason: string | null;
  created_at: string;
  updated_at: string;
}

export function createCandidate(input: {
  project_id: number;
  watcher: string;
  kind: string;
  fingerprint: string;
  payload_json: string;
}): CandidateRow {
  const d = getDb();
  const ts = now();
  const info = d
    .prepare(
      `INSERT INTO candidates (project_id, watcher, kind, fingerprint, payload_json, status, created_at, updated_at)
       VALUES (@project_id, @watcher, @kind, @fingerprint, @payload_json, 'pending', @ts, @ts)`,
    )
    .run({ ...input, ts });
  return getCandidate(Number(info.lastInsertRowid))!;
}

export function getCandidate(id: number): CandidateRow | undefined {
  return getDb().prepare(`SELECT * FROM candidates WHERE id = ?`).get(id) as CandidateRow | undefined;
}

/** Most recent candidate for this fingerprint, any status — the basis for
 *  both "already open, don't re-triage" and "was closed/suppressed" dedupe. */
export function findLatestCandidateByFingerprint(
  projectId: number,
  watcher: string,
  fingerprint: string,
): CandidateRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM candidates WHERE project_id = ? AND watcher = ? AND fingerprint = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(projectId, watcher, fingerprint) as CandidateRow | undefined;
}

const CANDIDATES_DEFAULT_LIMIT = 50;
const CANDIDATES_MAX_LIMIT = 200;

export function listCandidates(
  opts: { projectId?: number; status?: string; watcher?: string; limit?: number } = {},
): CandidateRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.projectId != null) {
    where.push("project_id = ?");
    params.push(opts.projectId);
  }
  if (opts.status) {
    where.push("status = ?");
    params.push(opts.status);
  }
  if (opts.watcher) {
    where.push("watcher = ?");
    params.push(opts.watcher);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  // Most-recent-first feed for the UI (Signals panel) — id order matches
  // creation order exactly (autoincrement), no separate recency column needed.
  const limit = Math.max(1, Math.min(opts.limit ?? CANDIDATES_DEFAULT_LIMIT, CANDIDATES_MAX_LIMIT));
  return getDb()
    .prepare(`SELECT * FROM candidates ${clause} ORDER BY id DESC LIMIT ?`)
    .all(...params, limit) as CandidateRow[];
}

export function updateCandidate(
  id: number,
  fields: Partial<
    Pick<CandidateRow, "status" | "triage_json" | "task_id" | "suppressed_at" | "suppressed_reason">
  >,
): CandidateRow | undefined {
  const cols = Object.keys(fields);
  if (cols.length) {
    const setClause = cols.map((c) => `${c} = ?`).join(", ");
    getDb()
      .prepare(`UPDATE candidates SET ${setClause}, updated_at = ? WHERE id = ?`)
      .run(...cols.map((c) => (fields as Record<string, unknown>)[c] as never), now(), id);
  }
  return getCandidate(id);
}

/** Count of this project+watcher's candidates that reached "queued" today
 *  (UTC calendar-day prefix match on created_at) — the per-watcher daily cap. */
export function countCandidatesQueuedToday(projectId: number, watcher: string): number {
  const today = new Date().toISOString().slice(0, 10);
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM candidates
       WHERE project_id = ? AND watcher = ? AND status = 'queued' AND substr(created_at, 1, 10) = ?`,
    )
    .get(projectId, watcher, today) as { c: number };
  return row.c;
}

/** Open (non-terminal) tasks whose origin is any watcher — the autoQueueDepth
 *  cap. "ready" is the one terminal stage every settle path lands on: normal
 *  completion, wont_do, and approveCodeChangeMerge all set stage:"ready" (see
 *  orchestrator.ts) — so "not ready yet" is exactly "still open". */
export function countOpenWatcherTasks(projectId: number): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM tasks WHERE project_id = ? AND origin LIKE 'watcher:%' AND stage != 'ready'`,
    )
    .get(projectId) as { c: number };
  return row.c;
}

/** Called when a watcher-originated task is closed as wont_do: marks the
 *  candidate that produced it (if any) suppressed, so a future scan with the
 *  same fingerprint dedupes against it instead of re-proposing. No-op when
 *  the task has no linked candidate (e.g. predates this feature). */
export function suppressCandidateForTask(taskId: string, reason: string): void {
  const row = getDb().prepare(`SELECT id FROM candidates WHERE task_id = ?`).get(taskId) as
    | { id: number }
    | undefined;
  if (!row) return;
  updateCandidate(row.id, { status: "suppressed", suppressed_at: now(), suppressed_reason: reason });
}

/** Mark self-generated tasks as glanced at. Idempotent and first-write-wins —
 *  re-marking never moves the timestamp, so "new since you last looked" can't
 *  be reset by a second page load. */
export function markTasksSeen(taskIds: string[]): void {
  if (!taskIds.length) return;
  const d = getDb();
  const ts = now();
  const stmt = d.prepare(`UPDATE tasks SET seen_at = ? WHERE task_id = ? AND seen_at IS NULL`);
  const tx = d.transaction((ids: string[]) => {
    for (const id of ids) stmt.run(ts, id);
  });
  tx(taskIds);
}

/** Watcher-origin tasks a human has never opened — the server-side truth
 *  behind the board's "new self-generated" section. */
export function listUnseenWatcherTasks(projectId: number): TaskRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM tasks
       WHERE project_id = ? AND origin LIKE 'watcher:%' AND seen_at IS NULL
       ORDER BY created_at DESC`,
    )
    .all(projectId) as TaskRow[];
}

/** Every role run for a project since `isoTimestamp`, oldest first — the raw
 *  material for the morning report's "what was attempted overnight". */
export function listRoleRunsSince(projectId: number, isoTimestamp: string): RoleRunRow[] {
  return getDb()
    .prepare(
      `SELECT rr.* FROM role_runs rr
       JOIN tasks t ON t.task_id = rr.task_id
       WHERE t.project_id = ? AND rr.created_at >= ?
       ORDER BY rr.id ASC`,
    )
    .all(projectId, toDbTimestamp(isoTimestamp)) as RoleRunRow[];
}

/** Completed runs whose rolling digest (PLANNING/overhaul/07 §2) never landed —
 *  the fire-and-forget digest call failed, or the daemon stopped while it was
 *  in flight. Only rows with enough material to be worth digesting are
 *  returned, so the backfill can't burn calls on one-line reports. */
export function listRoleRunsMissingDigest(projectId: number, limit: number): RoleRunRow[] {
  return getDb()
    .prepare(
      `SELECT rr.* FROM role_runs rr
       JOIN tasks t ON t.task_id = rr.task_id
       WHERE t.project_id = ?
         AND rr.digest IS NULL
         AND rr.output_md IS NOT NULL
         AND length(rr.output_md) >= 400
       ORDER BY rr.id DESC LIMIT ?`,
    )
    .all(projectId, limit) as RoleRunRow[];
}

/** Live sum of `role_runs.tokens` for watcher-originated tasks since
 *  `isoTimestamp` — the doc's "sum role_runs.tokens live" token budget, read
 *  on demand rather than counter-incremented (unlike task-starts/exec-runs,
 *  which have no row to sum after the fact). The bound goes through
 *  {@link toDbTimestamp}: callers hand this a `Date.toISOString()` value, which
 *  never matches stored rows without normalization. */
/**
 * `role_runs.tokens` carries ONE combined count (input + output — see agent.ts's
 * usage accumulation), but pricing is per-direction. Converting the combined
 * number to dollars therefore requires assuming a split. Orchestra's runs are
 * read-heavy — a large assembled context against a comparatively short findings
 * report — so output is the minority share. This constant names that assumption
 * instead of burying it in a formula, and {@link ProjectSpend} returns it so the
 * UI can label the dollar figure as the estimate it is.
 */
export const ASSUMED_OUTPUT_FRACTION = 0.15;

export interface ProjectSpend {
  /** Summed `role_runs.tokens` in the window. Always exact. */
  tokens: number;
  /** Dollar estimate for the runs whose model matched a config carrying
   *  pricing. See {@link ASSUMED_OUTPUT_FRACTION} for the split assumption. */
  usd: number;
  /** True when at least one contributing run's model had no cost data, so the
   *  dollar figure is a floor ("at least $X"), not a total. The whole point of
   *  the flag: never present a silently under-reported number as a total. */
  usdIsPartial: boolean;
  /** Tokens that couldn't be priced — what `usdIsPartial` is hiding, quantified. */
  unpricedTokens: number;
  /** Echoed so a caller rendering `usd` can state the assumption it rests on. */
  assumedOutputFraction: number;
  /** Window start actually used, for display alongside the numbers. */
  since: string;
}

/**
 * Spend for one project's tasks over a rolling window (PLANNING/overhaul-2/01).
 *
 * Sums `role_runs.tokens` across every run belonging to the project's tasks,
 * then prices the ones whose `model` matches a named model config carrying
 * `cost_per_1m_input`/`cost_per_1m_output` in its `extra_json`. Runs on models
 * with no pricing still count toward `tokens` — the token ceiling must be fully
 * enforceable on a project that has never entered a price — and set
 * `usdIsPartial` so the dollar figure is never mistaken for a complete total.
 */
export function getProjectSpend(projectId: number, sinceIso: string): ProjectSpend {
  const rows = getDb()
    .prepare(
      `SELECT rr.model AS model, COALESCE(SUM(rr.tokens), 0) AS tokens
       FROM role_runs rr
       JOIN tasks t ON t.task_id = rr.task_id
       WHERE t.project_id = ? AND rr.created_at >= ?
       GROUP BY rr.model`,
    )
    .all(projectId, toDbTimestamp(sinceIso)) as Array<{ model: string | null; tokens: number }>;

  // model id -> blended $/1M tokens, from the first config that both matches the
  // model and actually carries pricing (several configs can share a
  // default_model — a priced one beats an unpriced duplicate).
  const priceByModel = new Map<string, number>();
  for (const cfg of listModelConfigs()) {
    if (!cfg.default_model || priceByModel.has(cfg.default_model)) continue;
    let extras: Record<string, unknown> = {};
    try {
      if (cfg.extra_json) extras = JSON.parse(cfg.extra_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    const inRate = typeof extras.cost_per_1m_input === "number" ? extras.cost_per_1m_input : null;
    const outRate = typeof extras.cost_per_1m_output === "number" ? extras.cost_per_1m_output : null;
    if (inRate == null && outRate == null) continue;
    // A config priced in only one direction still prices better than nothing:
    // treat the missing side as equal to the one that's set.
    const input = inRate ?? outRate!;
    const output = outRate ?? inRate!;
    priceByModel.set(
      cfg.default_model,
      input * (1 - ASSUMED_OUTPUT_FRACTION) + output * ASSUMED_OUTPUT_FRACTION,
    );
  }

  let tokens = 0;
  let usd = 0;
  let unpricedTokens = 0;
  for (const row of rows) {
    const t = row.tokens ?? 0;
    tokens += t;
    const rate = row.model ? priceByModel.get(row.model) : undefined;
    if (rate == null) {
      unpricedTokens += t;
      continue;
    }
    usd += (t / 1_000_000) * rate;
  }

  return {
    tokens,
    usd,
    usdIsPartial: unpricedTokens > 0,
    unpricedTokens,
    assumedOutputFraction: ASSUMED_OUTPUT_FRACTION,
    since: sinceIso,
  };
}

export function sumAutonomousTokensSince(projectId: number, isoTimestamp: string): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(rr.tokens), 0) AS total
       FROM role_runs rr
       JOIN tasks t ON t.task_id = rr.task_id
       WHERE t.project_id = ? AND t.origin LIKE 'watcher:%' AND rr.created_at >= ?`,
    )
    .get(projectId, toDbTimestamp(isoTimestamp)) as { total: number };
  return row.total;
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