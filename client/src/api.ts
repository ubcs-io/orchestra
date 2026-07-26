/** Typed API client + shared types. All calls hit the Fastify `/api` surface. */

export interface Project {
  internal_calls?: number;
  external_calls?: number;
  processing?: boolean;
  id: number;
  name: string;
  repo_path: string;
  planning_dir: string;
  default_model: string | null;
  models: string[];
  /** Whether a GitHub token is configured (push/PR flow) — the raw token itself
   *  is never sent to the client. */
  has_github_token?: boolean;
  github_repo?: string | null;
}

export interface Task {
  id: number;
  task_id: string;
  name: string | null;
  project_id: number | null;
  stage: string | null;
  level: string | null;
  intake_kind: string | null;
  exit_kind: string | null;
  exit_state: string | null;
  review_reason: string | null;
  recap_md: string | null;
  paused: number | null;
  refinement_plan_json: string | null;
  content: string | null;
  network_id: string | null;
  origin_role_key: string | null;
  origin_question: string | null;
  parent_task_id: string | null;
  task_type: string | null;
  /** Family root's task_id — tasks sharing a root_task_id share one worktree
   *  and branch. null on tasks that predate this column (treat as if it were
   *  their own task_id, i.e. their own standalone worktree/family). */
  root_task_id: string | null;
  /** Set when a later answer invalidated an assumption the parent task made
   *  while spawning this decomposition child — flagged for human triage. */
  stale_reason: string | null;
  git_branch: string | null;
  git_base_branch: string | null;
  /** This task's (family's) worktree directory on disk. null until the task
   *  has actually done a step of work. */
  git_worktree_path: string | null;
  /** Outcome of merging this task's branch back into base on completion.
   *  "pending_human_merge" means a role wrote real source (not just PLANNING
   *  artifacts this run) — the branch was deliberately left unmerged for
   *  manual review instead of auto-merging into base. */
  reconcile_status: string | null;
  reconcile_detail: string | null;
  /** Set once "Push & open PR" has succeeded for this task's branch. */
  github_pr_url: string | null;
  github_pushed_sha: string | null;
  /** Set the first time a role in this task actually writes files (not just
   *  PLANNING artifacts) — see server/src/orchestrator.ts's commitArtifacts call. */
  wrote_source: number | null;
  created_at: string | null;
  /** JSON array of task ids this task can't be scheduled until reach stage "ready" —
   *  set by decomposition when a subtask declared `depends_on` on a sibling. */
  depends_on_json: string | null;
  /** "human" (default, every human-filed task) or "watcher:<name>" for a task
   *  a watcher proposed and triage approved (PLANNING/overhaul/08). */
  origin: string | null;
  /** 1-5, default 3 — the scheduler's tie-break among same-class tasks. */
  priority: number | null;
  /** "plan" | "edit" | "auto" override, or null to inherit the project's own
   *  default (see server/src/autonomy-level.ts). Distinct from the unrelated
   *  project-level watcher-scheduling "autonomy" config. */
  autonomy_level: string | null;
  /** "XS" | "S" | "M" | "L" | "XL" — the explorer role's informed size
   *  estimate, null until explorer runs (see server/src/agent.ts's EffortSize). */
  effort_size: string | null;
  /** "minimal" | "standard" | "thorough" override, or null to inherit the
   *  project's own default (see server/src/planning-rigor.ts). Distinct from
   *  the unrelated fixed FLOW_TEMPLATES rigor tag and counter-reviewer gate rigor. */
  planning_rigor: string | null;
  /** Run-health rollups (PLANNING/overhaul/04) attached by GET /api/tasks — count
   *  of this task's degraded/empty primary runs, and the health of its most
   *  recent primary run. Present on the task-list payload only. */
  degraded_runs?: number;
  latest_health?: RunHealth | null;
}

/** Derived run-health tier (PLANNING/overhaul/04), most→least trustworthy.
 *  `verified` (overhaul/05) sits above `healthy`: a clean run whose verdict is
 *  backed by harness-recorded command runs that all exited 0. */
export type RunHealth = "verified" | "healthy" | "recovered" | "degraded" | "empty";

/** One harness-recorded command execution (PLANNING/overhaul/05). Written by
 *  the server's executor, never by a model — see server/src/exec.ts. */
export interface ExecEvidence {
  name: string;
  argv: string[];
  exitCode: number | null;
  signal?: string | null;
  durationMs: number;
  outputTail: string;
  truncated: boolean;
  timedOut: boolean;
  startedAt: string;
  spawnError?: string;
}

/** Whether an execution counts as green. Mirrors server/src/exec.ts's isGreen —
 *  "we couldn't tell" (timeout, failed spawn) is never a pass. */
export function isEvidenceGreen(e: ExecEvidence): boolean {
  return e.exitCode === 0 && !e.timedOut && !e.spawnError;
}

/** Parse a run's `evidence_json`, tolerating null/legacy/garbage rows. */
export function parseEvidence(json: string | null | undefined): ExecEvidence[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is ExecEvidence => !!e && typeof e === "object" && typeof (e as ExecEvidence).name === "string",
    );
  } catch {
    return [];
  }
}

export interface RoleRun {
  id: number;
  task_id: string;
  role_key: string;
  verdict: string | null;
  summary: string | null;
  output_md: string | null;
  thinking_md: string | null;
  stop_reason: string | null;
  fallback: number | null;
  stalled: number | null;
  /** How the run's structured verdict was obtained (artifact-first contract):
   *  "tool" | "fence" | "constrained" | "repair" | "fallback"; null on rows
   *  predating the column or on failure-path rows with no model turn. */
  verdict_source: string | null;
  /** twoPhase progress at exit (overhaul/04); null for tool/text mode. */
  phase?: number | null;
  /** Count of this run's tool calls that returned an error (overhaul/04). */
  failed_tool_calls?: number | null;
  /** Bytes of report prose durably appended to the artifact during the run
   *  (overhaul/04); 0 is the literal "wrote no output" signal. */
  artifact_bytes?: number | null;
  /** JSON `ExecEvidence[]` — commands this run actually executed via
   *  `run_command` (overhaul/05). Parse with {@link parseEvidence}. */
  evidence_json?: string | null;
  /** Derived run-health tier + one-line reason (overhaul/04), computed
   *  server-side in taskDetail. Absent on payloads that don't decorate runs. */
  health?: RunHealth;
  health_reason?: string;
  tokens: number | null;
  depth: number;
  model: string | null;
  open_questions_json: string | null;
  coverage_json: string | null;
  /** The primary run this critiques/second-reviews, if this is not itself a primary run. */
  target_run_id: number | null;
  /** "primary" | "critique" | "second_review". */
  run_kind: string;
  /** Checkpoint commit created right after this run's artifact commit — null if
   *  the commit was a no-op/failed, or the run predates the checkpointing feature. */
  git_commit_sha: string | null;
  /** Structured decomposition output (JSON array of Subtask), when this run is a
   *  can_create_subtasks role — preferred over regex-parsing output_md. */
  subtasks_json: string | null;
  /** Set by a can_create_subtasks role when it deliberately leaves subtasks
   *  empty because the work is already one atomic, independently-actionable
   *  unit. Empty subtasks_json with this unset means the decomposition failed
   *  rather than intentionally concluding there was nothing to break down. */
  no_decomposition_reason: string | null;
  started_at: string | null;
  ended_at: string | null;
  /** chars/4 estimate of the assembled role context this run was given
   *  (overhaul/07). null on rows predating the column. */
  context_tokens_est?: number | null;
  /** 1 iff the context allocator collapsed or dropped any degradable tier
   *  for this run (overhaul/07) — in shadow mode, "would have needed to". */
  context_degraded?: number | null;
  /** The role's own "what the next role must know" handoff (overhaul/07 §4). */
  carry_forward?: string | null;
  /** Rolling ≤400-char digest of this run's report (overhaul/07 §2). */
  digest?: string | null;
  created_at: string;
}

export interface Role {
  id: number;
  project_id: number | null;
  key: string;
  title: string | null;
  enabled: number;
  ordering: number;
  system_prompt: string | null;
  tools_json: string | null;
  model: string | null;
  can_create_subtasks: number;
}

export interface Intervention {
  id: number;
  task_id: string;
  kind: string;
  payload_json: string | null;
  consumed_at: string | null;
  created_at: string;
}

export interface ChatMessage {
  id: number;
  task_id: string;
  role: string;
  content: string;
  created_at: string;
}

/** A connection/provider profile. The API key is never sent to the client. */
export interface ConnectionConfig {
  id: number;
  project_id: number | null;
  key: string;
  name: string | null;
  base_url: string | null;
  api: string | null;
  default_model: string | null;
  context_window: number | null;
  max_tokens: number | null;
  request_timeout_ms: number | null;
  reasoning: number | null;
  thinking_level: string | null;
  thinking_format: string | null;
  text_mode: number | null;
  structured_outputs_json: string | null;
  has_api_key: boolean;
}

/** Cached result of probing an endpoint for server-side structured-decoding
 *  support (PLANNING/overhaul/02) — see server/src/probe.ts. */
export interface StructuredOutputsProbeResult {
  probedAt: string;
  baseUrl: string;
  modelId: string;
  modes: { json_object: boolean; json_schema: boolean; guided_json: boolean; grammar: boolean };
}

/** A named model config card (excluding the global default). */
export interface ModelConfig {
  id: number;
  project_id: number | null;
  key: string;
  name: string | null;
  base_url: string | null;
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
  has_api_key: boolean;
  has_env_token: boolean;
  location: string | null;
  created_at: string;
  updated_at: string;
}

export interface ModelConfigsResponse {
  configs: ModelConfig[];
  has_tokens_env: boolean;
}

// ---- Measured model capability profiles (PLANNING/overhaul/06) ----
// Mirrors server/src/profiles.ts.

export interface TrialProbe {
  attempts: number;
  successes: number;
}

export interface ModelProfileProbes {
  structured?: { json_object: boolean; json_schema: boolean; guided_json: boolean; grammar: boolean };
  customToolCall?: TrialProbe;
  builtinToolCall?: TrialProbe;
  jsonFence?: TrialProbe;
  thinkingDialect?: "reasoning_content" | "think_tags" | "none";
  developerRole?: boolean;
  reasoningEffortParam?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  effectiveContext?: number | null;
}

export interface ModelLiveStats {
  totalRuns: number;
  runs: number;
  window: number;
  fallbackRate: number;
  stallRate: number;
  truncationRate: number;
  repairRate: number;
  byMode: Record<string, number>;
}

export type ProfileRunShape = "single-turn" | "two-turn" | "text";
export type ProfileVerdictDelivery = "json_schema" | "guided_json" | "grammar" | "tool_call" | "fence";

export interface DerivedDecisions {
  runShape: ProfileRunShape;
  verdictDelivery: ProfileVerdictDelivery;
  toolCapable?: boolean;
  reasoning?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
}

export interface ModelProfileView {
  model: string;
  connectionSig: string;
  baseUrl: string;
  probedAt: string | null;
  probes: ModelProfileProbes;
  live: ModelLiveStats | null;
  derived: DerivedDecisions;
  /** Per-decision "why": which probe / live stat drove each derived field. */
  rationale: Record<string, string>;
  suggestion: string | null;
  overrides: Partial<DerivedDecisions>;
}

export interface ModelProfileResponse {
  profile: ModelProfileView | null;
  /** derived ⊕ overrides — the decisions resolution actually applies. */
  effective: DerivedDecisions | null;
}

/** Per-step progress event streamed by the probe-profile SSE route. */
export interface ProfileProbeProgress {
  step: string;
  status: "start" | "done";
  detail?: unknown;
}

export interface ConfigResponse {
  config: ConnectionConfig;
  resolved: {
    baseUrl: string;
    api: string;
    defaultModelId: string;
    contextWindow: number;
    maxTokens: number;
    requestTimeoutMs: number;
    reasoning: boolean;
    thinkingLevel: string;
    thinkingFormat: string;
    textMode: boolean;
    structuredOutputs: { mode: "json_schema" | "guided_json" | "grammar" | "off"; probedAt?: string };
    has_api_key: boolean;
  };
  env_overrides: { base_url: boolean; api_key: boolean };
}

/** Fields a PATCH may set. `api_key: ""` clears the stored key; omit to keep it. */
export interface ConfigPatch {
  name?: string;
  base_url?: string;
  api_key?: string;
  default_model?: string;
  context_window?: number;
  max_tokens?: number;
  request_timeout_ms?: number;
  reasoning?: boolean;
  thinking_level?: string;
  thinking_format?: string;
  text_mode?: boolean;
}

export type CoverageMap = Record<string, { status: string; note?: string }>;

export interface PlanStep {
  role: string;
  status: string;
  depth: number;
}
export interface Plan {
  steps: PlanStep[];
}

export interface TaskDetail {
  task: Task;
  recap_md: string | null;
  plan: Plan | null;
  coverage: CoverageMap | null;
  runs: RoleRun[];
  interventions: Intervention[];
  children: Task[];
  chat_messages: ChatMessage[];
  taxonomy: string[];
}

// ---- Agent Networks ----

export interface NetworkNode {
  id: string;
  roleKey: string;
  position: { x: number; y: number };
  overrides?: {
    systemPrompt?: string;
    model?: string;
    tools?: string[];
    depth?: number;
  };
  criteria?: NetworkNodeCriterion[];
  /** Role keys that critique this node's output (groundwork for a future
   *  all-roles-critique-all-nodes option; today always ["critic"] or unset). */
  critics?: string[];
}

export interface NetworkNodeCriterion {
  id: string;
  text: string;
  severity: "must" | "should";
  concern?: string;
}

export interface NetworkEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  label?: string;
  condition?: {
    type: "verdict" | "always" | "coverage" | "criteria";
    value?: string;
    operator?: "eq" | "neq" | "any_unmet" | "any_missing";
  };
}

export interface AgentNetworkGraph {
  version: 1;
  nodes: NetworkNode[];
  edges: NetworkEdge[];
  layout: { gridSize: number; snapToGrid: boolean };
  metadata: {
    rigor: "low" | "standard" | "high";
    maxLoopbacks: number;
    mandatoryConcerns: string[];
    reviewerRole?: string;
    /** How often the adversarial `critic` role checks a step's output: "none"
     *  (off), "terminal_only" (at the reviewer step only), "every_step" (after
     *  every non-exempt producer step). */
    reviewDepth?: "none" | "terminal_only" | "every_step";
  };
}

export interface AgentNetwork {
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

export interface NetworkExport {
  version: number;
  exported_at: string;
  network_id: string;
  name: string;
  description: string;
  intake_kind: string | null;
  graph: AgentNetworkGraph;
}

async function req<T>(url: string, opts?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts?.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const res = await fetch(url, {
    headers,
    ...opts,
  });
  if (!res.ok) {
    const msg = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((msg as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/** One pre-approved command a role may run by name — see server/src/harness-policy.ts.
 *  The model picks `name`; `argv` is what actually executes (no shell). */
export interface ExecCommand {
  name: string;
  argv: string[];
  allowArgs?: boolean;
  argPattern?: string;
  timeoutMs?: number;
  description?: string;
}

/** Per-project write/exec policy — see server/src/harness-policy.ts. */
export interface HarnessPolicy {
  allowWrite: boolean;
  denyGlobs?: string[];
  allowExec: boolean;
  execAllowlist: ExecCommand[];
  execTimeoutMs?: number;
  execMaxOutputBytes?: number;
  execMaxRuns?: number;
  execEnv?: Record<string, string>;
}

/** Every field of the harness policy is independently patchable; send only
 *  what you're changing. */
export type HarnessPolicyPatch = Partial<
  Pick<
    HarnessPolicy,
    | "allowWrite"
    | "allowExec"
    | "execAllowlist"
    | "execTimeoutMs"
    | "execMaxOutputBytes"
    | "execMaxRuns"
    | "execEnv"
  >
>;

/** One watcher's config — see server/src/autonomy.ts. Only "test-suite" ships
 *  in this pass. */
export interface WatcherConfig {
  name: string;
  enabled: boolean;
  cadenceMinutes: number;
  perWatcherDailyCap: number;
  commands?: string[];
}

export interface ActiveHours {
  /** "HH:MM", local time. */
  start: string;
  end: string;
  weekendsAllDay: boolean;
}

export interface AutonomyBudgets {
  maxTaskStarts: number;
  maxTokens: number;
  maxExecRuns: number;
}

/** Per-project autonomy policy — the kill-switch, schedule, budgets, and
 *  watcher menu (PLANNING/overhaul/08 §3). See server/src/autonomy.ts. */
export interface AutonomyConfig {
  enabled: boolean;
  activeHours: ActiveHours | null;
  idleAfterMinutes: number;
  autoQueueDepth: number;
  budgets: AutonomyBudgets;
  watchers: WatcherConfig[];
}

/** Every field is independently patchable; the server merges over the
 *  currently-resolved config before validating (see routes/api.ts). */
export type AutonomyPatch = Partial<AutonomyConfig>;

/** How far a task's own pipeline may progress unattended — distinct from
 *  (and unrelated to) AutonomyConfig above, which governs watcher-dispatch
 *  scheduling. */
export type AutonomyLevel = "plan" | "edit" | "auto";

/** Scales the family-wide decomposition budget relative to a task's
 *  effort_size — see server/src/planning-rigor.ts. Labeled "Planning Depth"
 *  in the UI to avoid colliding with the unrelated FLOW_TEMPLATES rigor tag
 *  and counter-reviewer gate rigor already surfaced elsewhere. */
export type PlanningRigor = "minimal" | "standard" | "thorough";

export interface AutonomyBudgetStatus {
  exhausted: boolean;
  consumed: { taskStarts: number; execRuns: number; tokens: number };
  budgets: AutonomyBudgets;
  windowStartedAt: string | null;
}

/** One watcher observation, before/after triage (PLANNING/overhaul/08 §1/§2). */
export interface Candidate {
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

/** GET /api/safety response shape. */
export interface SafetyResponse {
  agent_tools: {
    mode: string;
    write_scope: string;
    shell_access: boolean;
    /** Whether any project has a live `run_command` grant (overhaul/05). */
    command_execution?: boolean;
    command_execution_note?: string;
    cross_repo_access: boolean;
    source_code_writes: boolean;
    git_history_available: boolean;
    worktree_jail: boolean;
  };
  harness_policy: {
    global_default: HarnessPolicy;
    projects: Array<{
      id: number;
      name: string;
      allow_write: boolean;
      roles_with_write: string[];
      allow_exec?: boolean;
      exec_commands?: Array<{ name: string; argv: string[] }>;
      roles_with_exec?: string[];
    }>;
  };
  limits: {
    role_tool_budget: number;
    request_timeout_ms: number;
    max_tokens: number;
    context_window: number;
  };
  gates: Record<string, { maxLoopbacks: number; reviewerRole: string; rigor: string }>;
  roles_summary: {
    total_roles: number;
    read_only_count: number;
    git_history_count: number;
    context_only_count: number;
    disabled_count: number;
  };
  server: {
    bind_address: string;
    port: number;
    auth_enabled: boolean;
    trust_boundary: string;
  };
  storage: {
    db_path: string;
    api_key_in_db: boolean;
    api_key_in_env: boolean;
  };
  concerns: string[];
}

export interface SafetyPatch {
  role_tool_budget?: number;
}

export interface SummaryStats {
  total: number;
  by_stage: Record<string, number>;
  in_flight: number;
  in_flight_task_ids: string[];
  action_items: number;
  blockers: number;
  paused: number;
  projects_count: number;
  blockers_list: Array<{
    task_id: string;
    name: string | null;
    exit_state: string | null;
    stage: string | null;
    project_id: number | null;
    review_reason: string | null;
    project_name: string | null;
  }>;
  /** Count of tasks parked at stage "review" awaiting a human decision (approve/reset/
   *  request changes) — a superset of blockers_list, since exit_state is null for some
   *  review gates (e.g. a failed decomposition) that blockers_list's exit_state filter misses. */
  review_count: number;
  review_list: Array<{
    task_id: string;
    name: string | null;
    exit_state: string | null;
    review_reason: string | null;
    project_id: number | null;
    project_name: string | null;
  }>;
}

export interface PingResult {
  config_id: number;
  name: string;
  base_url: string;
  available: boolean;
  error?: string;
  status: "checking" | "done";
  /** Server-provided location label: "local" | "api" | null */
  location?: string | null;
}

export interface PingResultInit {
  configs: Array<{
    config_id: number;
    name: string;
    base_url: string;
    location?: string | null;
  }>;
}

/** One resolved model target used by a task's network (a named override
 *  config, or the single default-connection fallback), possibly shared by
 *  several roles. */
export interface NetworkPingTarget {
  target_id: string;
  label: string;
  kind: "override" | "default";
  roles: string[];
  available: boolean;
  error?: string;
  status: "checking" | "done";
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: "added" | "deleted" | "modified" | "renamed" | "copied";
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface TaskDiff {
  base: string;
  branch: string;
  files: DiffFile[];
}

/** Diff scoped to a single role run — base is the previous primary run's
 *  checkpoint commit (or the task's base branch for the first one), head is
 *  this run's own checkpoint commit. See server/src/routes/api.ts's
 *  resolveRunDiffRefs. */
export interface RunDiff {
  base: string;
  head: string;
  files: DiffFile[];
}

export interface RoleStats {
  role_key: string;
  total_calls: number;
  pass_count: number;
  counter_reviewer_passes: number;
  network_count: number;
  total_tokens: number;
}

/** One reliability rollup bucket from GET /api/stats/health (overhaul/04 §3).
 *  Rates are 0..1. `group` is the model / role_key / verdict_source key. */
export interface RunHealthStats {
  group: string;
  runs: number;
  /** Clean runs additionally backed by green command executions (overhaul/05). */
  verified: number;
  healthy: number;
  recovered: number;
  degraded: number;
  empty: number;
  stall_count: number;
  truncation_count: number;
  repair_attempted: number;
  repair_success: number;
  stall_rate: number;
  truncation_rate: number;
  repair_success_rate: number;
  avg_tokens: number;
  median_tokens: number;
  avg_duration_ms: number;
  /** Context ledger observability (overhaul/07 §5): assembled prompt size vs.
   *  the degradation frequency it implies. In shadow mode (contextBudget
   *  project flag off), context_degraded_rate is "would have needed to
   *  degrade" for the full prompt actually sent. */
  avg_context_tokens_est: number;
  p95_context_tokens_est: number;
  context_degraded_count: number;
  context_degraded_rate: number;
}

export type HealthGroupBy = "model" | "role" | "mode";

export const api = {
  health: () => req<{ ok: boolean }>("/api/health"),
  models: () => req<{ models: string[] }>("/api/models"),

  config: () => req<ConfigResponse>("/api/config"),
  saveConfig: (body: ConfigPatch) =>
    req<{ config: ConnectionConfig }>("/api/config", { method: "PATCH", body: JSON.stringify(body) }),

  safety: () => req<SafetyResponse>("/api/safety"),
  saveSafety: (body: SafetyPatch) =>
    req<{ ok: boolean; changes: string[] }>("/api/safety", { method: "PATCH", body: JSON.stringify(body) }),

  scheduler: () => req<{ running: boolean; stopping: boolean }>("/api/scheduler"),
  startScheduler: () => req<{ running: boolean; stopping: boolean }>("/api/scheduler/start", { method: "POST" }),
  stopScheduler: () => req<{ running: boolean; stopping: boolean }>("/api/scheduler/stop", { method: "POST" }),
  tick: () => req<{ worked: boolean }>("/api/tick", { method: "POST" }),

  projects: () => req<{ projects: Project[] }>("/api/projects"),
  project: (id: number) => req<{ project: Project; roles: Role[] }>(`/api/projects/${id}`),
  createProject: (body: { name: string; repo_path: string; default_model?: string }) =>
    req<{ project: Project }>("/api/projects", { method: "POST", body: JSON.stringify(body) }),
  updateProject: (
    id: number,
    body: { default_model?: string | null; github_token?: string | null; github_repo?: string | null },
  ) => req<{ project: Project }>(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(body) }),

  roles: (projectId: number) => req<{ roles: Role[] }>(`/api/projects/${projectId}/roles`),
  saveRole: (projectId: number, key: string, body: Partial<Role>) =>
    req<{ role: Role }>(`/api/projects/${projectId}/roles/${key}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  harnessPolicy: (projectId: number) =>
    req<{ policy: HarnessPolicy }>(`/api/projects/${projectId}/harness-policy`),
  saveHarnessPolicy: (projectId: number, body: HarnessPolicyPatch) =>
    req<{ policy: HarnessPolicy }>(`/api/projects/${projectId}/harness-policy`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  autonomyConfig: (projectId: number) =>
    req<{ config: AutonomyConfig }>(`/api/projects/${projectId}/autonomy`),
  saveAutonomyConfig: (projectId: number, body: AutonomyPatch) =>
    req<{ config: AutonomyConfig }>(`/api/projects/${projectId}/autonomy`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  autonomyBudget: (projectId: number) =>
    req<AutonomyBudgetStatus>(`/api/projects/${projectId}/autonomy/budget`),

  autonomyLevel: (projectId: number) =>
    req<{ level: AutonomyLevel }>(`/api/projects/${projectId}/autonomy-level`),
  saveAutonomyLevel: (projectId: number, level: AutonomyLevel) =>
    req<{ level: AutonomyLevel }>(`/api/projects/${projectId}/autonomy-level`, {
      method: "PATCH",
      body: JSON.stringify({ level }),
    }),

  planningRigor: (projectId: number) =>
    req<{ rigor: PlanningRigor }>(`/api/projects/${projectId}/planning-rigor`),
  savePlanningRigor: (projectId: number, rigor: PlanningRigor) =>
    req<{ rigor: PlanningRigor }>(`/api/projects/${projectId}/planning-rigor`, {
      method: "PATCH",
      body: JSON.stringify({ rigor }),
    }),

  candidates: (projectId: number, status?: string, limit?: number) => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (limit != null) params.set("limit", String(limit));
    const qs = params.toString();
    return req<{ candidates: Candidate[] }>(
      `/api/projects/${projectId}/candidates${qs ? `?${qs}` : ""}`,
    );
  },

  tasks: (projectId?: number) =>
    req<{ tasks: Task[] }>(`/api/tasks${projectId ? `?projectId=${projectId}` : ""}`),
  task: (taskId: string) => req<TaskDetail>(`/api/tasks/${taskId}`),
  deleteTask: (taskId: string, removePlan?: boolean) =>
    req<{ ok: boolean }>(`/api/tasks/${taskId}${removePlan ? "?removePlan=true" : ""}`, { method: "DELETE" }),
  bulkWontDo: (projectId: number, taskIds: string[]) =>
    req<{ ok: boolean; updated: number }>(`/api/projects/${projectId}/tasks/bulk-wontdo`, {
      method: "POST",
      body: JSON.stringify({ task_ids: taskIds }),
    }),
  bulkDelete: (projectId: number, taskIds: string[]) =>
    req<{ ok: boolean; deleted: number }>(`/api/projects/${projectId}/tasks/bulk-delete`, {
      method: "POST",
      body: JSON.stringify({ task_ids: taskIds }),
    }),

  resetTask: (taskId: string) => req<{ task: Task }>(`/api/tasks/${taskId}/reset`, { method: "POST" }),

  restoreTask: (taskId: string, roleRunId: number) =>
    req<TaskDetail>(`/api/tasks/${taskId}/restore`, {
      method: "POST",
      body: JSON.stringify({ role_run_id: roleRunId }),
    }),

  taskDiff: (taskId: string) => req<TaskDiff>(`/api/tasks/${taskId}/diff`),
  taskDiffFile: (taskId: string, path: string, oldPath?: string) =>
    req<{ path: string; patch: string }>(
      `/api/tasks/${taskId}/diff/file?path=${encodeURIComponent(path)}${oldPath ? `&oldPath=${encodeURIComponent(oldPath)}` : ""}`,
    ),

  runDiff: (taskId: string, runId: number) => req<RunDiff>(`/api/tasks/${taskId}/runs/${runId}/diff`),
  runDiffFile: (taskId: string, runId: number, path: string, oldPath?: string) =>
    req<{ path: string; patch: string }>(
      `/api/tasks/${taskId}/runs/${runId}/diff/file?path=${encodeURIComponent(path)}${oldPath ? `&oldPath=${encodeURIComponent(oldPath)}` : ""}`,
    ),

  githubPush: (taskId: string) =>
    req<{ pushed: boolean; branch: string; owner: string; repo: string }>(`/api/tasks/${taskId}/github/push`, {
      method: "POST",
    }),
  githubOpenPr: (taskId: string, body?: { title?: string; body?: string }) =>
    req<{ pr_url: string }>(`/api/tasks/${taskId}/github/pr`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),

  updateTask: (taskId: string, body: { name?: string; content?: string; intake_kind?: string }) =>
    req<TaskDetail>(`/api/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify(body) }),

  intake: (projectId: number, body: { name: string; content: string; intake_kind?: string }) =>
    req<{ accepted: boolean; path: string; task_id: string | null }>(`/api/projects/${projectId}/intake`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  intervene: (taskId: string, kind: string, payload?: unknown) =>
    req<{ intervention: Intervention }>(`/api/tasks/${taskId}/interventions`, {
      method: "POST",
      body: JSON.stringify({ kind, payload }),
    }),

  createSubtask: (
    taskId: string,
    body: { name: string; content?: string; exit_kind?: "spec" | "research_brief" | "code_change" },
  ) =>
    req<{ task: Task }>(`/api/tasks/${taskId}/subtasks`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  decomposeQuestion: (taskId: string, body: { role_key: string; question: string }) =>
    req<{ task: Task; created: boolean }>(`/api/tasks/${taskId}/questions/decompose`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  sendChatMessage: (taskId: string, body: { message: string }) =>
    req<{ user_message: ChatMessage; assistant_message: ChatMessage }>(`/api/tasks/${taskId}/chat`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // Agent Networks
  networks: (projectId?: number) =>
    req<{ networks: AgentNetwork[] }>(`/api/networks${projectId ? `?project_id=${projectId}` : ""}`),
  network: (networkId: string) =>
    req<{ network: AgentNetwork }>(`/api/networks/${networkId}`),
  defaultNetwork: (intakeKind: string, projectId?: number) =>
    req<{ network: AgentNetwork | null }>(
      `/api/networks/default?intake_kind=${intakeKind}${projectId ? `&project_id=${projectId}` : ""}`,
    ),
  createNetwork: (body: {
    name: string;
    description?: string;
    project_id?: number;
    intake_kind?: string;
    graph_json: string;
  }) =>
    req<{ network: AgentNetwork }>("/api/networks", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateNetwork: (networkId: string, body: Record<string, unknown>) =>
    req<{ network: AgentNetwork }>(`/api/networks/${networkId}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteNetwork: (networkId: string) =>
    req<{ ok: boolean }>(`/api/networks/${networkId}`, { method: "DELETE" }),
  duplicateNetwork: (networkId: string, name?: string, projectId?: number) =>
    req<{ network: AgentNetwork }>(`/api/networks/${networkId}/duplicate`, {
      method: "POST",
      body: JSON.stringify({ name, project_id: projectId }),
    }),
  setDefaultNetwork: (networkId: string) =>
    req<{ network: AgentNetwork }>(`/api/networks/${networkId}/set-default`, { method: "POST" }),
  importNetwork: (body: {
    name?: string;
    description?: string;
    project_id?: number;
    intake_kind?: string;
    graph_json: string;
  }) =>
    req<{ network: AgentNetwork }>("/api/networks/import", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  exportNetwork: (networkId: string) =>
    req<{ export: NetworkExport }>(`/api/networks/${networkId}/export`),
  allRoles: (projectId?: number) =>
    req<{ roles: Role[] }>(`/api/roles${projectId ? `?project_id=${projectId}` : ""}`),
  roleStats: () => req<{ stats: RoleStats[] }>("/api/roles/stats"),
  healthStats: (groupBy: HealthGroupBy = "model") =>
    req<{ groupBy: HealthGroupBy; stats: RunHealthStats[] }>(`/api/stats/health?groupBy=${groupBy}`),

  // Folder picker dialog
  pickFolder: () =>
    req<{ path: string | null }>("/api/dialogs/folder", { method: "POST" }),

  // Model Configs
  discoverModels: (baseUrl: string, apiKey?: string) =>
    req<{ models: string[] }>("/api/models/discover", {
      method: "POST",
      body: JSON.stringify({ base_url: baseUrl, api_key: apiKey }),
    }),
  modelConfigs: () => req<ModelConfigsResponse>("/api/model-configs"),
  createModelConfig: (body: {
    name: string;
    base_url?: string;
    api_key?: string;
    default_model?: string;
    context_window?: number;
    max_tokens?: number;
    request_timeout_ms?: number;
    reasoning?: boolean;
    thinking_level?: string;
    thinking_format?: string;
    text_mode?: boolean;
  }) =>
    req<{ config: ModelConfig }>("/api/model-configs", { method: "POST", body: JSON.stringify(body) }),
  updateModelConfig: (id: number, body: {
    name?: string;
    base_url?: string;
    api_key?: string;
    default_model?: string;
    context_window?: number;
    max_tokens?: number;
    request_timeout_ms?: number;
    reasoning?: boolean;
    thinking_level?: string;
    thinking_format?: string;
    text_mode?: boolean;
  }) =>
    req<{ config: ModelConfig }>(`/api/model-configs/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteModelConfig: (id: number) =>
    req<{ ok: boolean }>(`/api/model-configs/${id}`, { method: "DELETE" }),
  duplicateModelConfig: (id: number, name?: string) =>
    req<{ config: ModelConfig }>(`/api/model-configs/${id}/duplicate`, { method: "POST", body: JSON.stringify({ name }) }),
  reorderModelConfigs: (ids: number[]) =>
    req<{ ok: boolean }>("/api/model-configs/reorder", { method: "POST", body: JSON.stringify({ ids }) }),
  setDefaultModelConfig: (id: number) =>
    req<{ config: ModelConfig }>(`/api/model-configs/${id}/set-default`, { method: "POST" }),

  /** Ping a single model config to check health. */
  pingModel: (configId: number) =>
    req<{ config_id: number; available: boolean; error?: string }>(`/api/ping-model/${configId}`),

  /** Probe the global default connection for structured-decoding support. */
  probeStructuredOutputs: () =>
    req<{ result: StructuredOutputsProbeResult }>("/api/config/probe-structured-outputs", { method: "POST" }),
  /** Probe a named model config's connection for structured-decoding support. */
  probeModelStructuredOutputs: (configId: number) =>
    req<{ config_id: number; result: StructuredOutputsProbeResult }>(
      `/api/model-configs/${configId}/probe-structured-outputs`,
      { method: "POST" },
    ),

  // ---- Measured model capability profiles (PLANNING/overhaul/06) ----
  /** The measured capability profile for a model config (null = never probed). */
  modelProfile: (configId: number) =>
    req<ModelProfileResponse>(`/api/model-configs/${configId}/profile`),
  /** URL for the SSE probe-profile stream (GET; ~20 small requests, 1–2 min).
   *  reset=true discards overrides so decisions become fully measured. */
  modelProfileProbeStreamUrl: (configId: number, reset = false) =>
    `/api/model-configs/${configId}/probe-profile/stream${reset ? "?reset=1" : ""}`,
  /** Replace the profile's override bag ({}/null clears → measured decisions). */
  updateModelProfileOverrides: (configId: number, overrides: Partial<DerivedDecisions> | null) =>
    req<ModelProfileResponse>(`/api/model-configs/${configId}/profile/overrides`, {
      method: "PATCH",
      body: JSON.stringify({ overrides }),
    }),
  /** Forget the profile — resolution falls back to hand flags until re-probed. */
  deleteModelProfile: (configId: number) =>
    req<{ ok: boolean }>(`/api/model-configs/${configId}/profile`, { method: "DELETE" }),

  // Summary dashboard
  summary: () => req<SummaryStats>("/api/summary"),
  /** URL for the SSE ping-network stream (GET). */
  pingNetworkStreamUrl: () => "/api/ping-network/stream",
  /** URL for the SSE stream that pings only the models a task's network actually uses. */
  taskNetworkPingStreamUrl: (taskId: string) => `/api/tasks/${taskId}/network-ping/stream`,

  // ---- Model stats (radar chart + performance comparison) ----
  modelStats: (configIds?: number[]) =>
    req<{ stats: ModelStat[] }>("/api/model-stats", {
      method: "POST",
      body: JSON.stringify({ config_ids: configIds }),
    }),
};

export interface ModelStat {
  config_id: number;
  name: string;
  model_id: string | null;
  context_window: number | null;
  max_tokens: number | null;
  reasoning: boolean;
  thinking_level: string | null;
  thinking_format: string | null;
  text_mode: boolean;
  has_api_key: boolean;
  has_env_token: boolean;
  location: string | null;
  parameter_count_b: number | null;
  parameter_count_estimated: number | null;
  total_parameter_count_b: number | null;
  active_parameter_count_b: number | null;
  quantization: string | null;
  quantization_estimated: string | null;
  quantization_score: number;
  cost_per_1m_input: number | null;
  cost_per_1m_output: number | null;
  historical_runs: number;
  historical_total_tokens: number;
  historical_avg_tokens_per_run: number;
}

/** Strip leading paths and GGUF shard suffixes like "-00001-of-00003.gguf" for display purposes. */
export function displayModelName(name: string): string {
  const basename = name.replace(/^.*[/\\]/, "");
  return basename.replace(/-(\d+)-of-(\d+)\.gguf$/i, "");
}

export const STAGES = ["intake", "refining", "ready", "review"] as const;

export function verdictClass(v: string | null | undefined): string {
  switch (v) {
    case "pass":
      return "ok";
    case "blocker":
      return "bad";
    case "needs_human":
      return "human";
    case "needs_more":
      return "warn";
    default:
      return "dim";
  }
}

/** Presentation for a run-health tier (overhaul/04): pill color class, a short
 *  label, and a glyph. `healthy` returns `show: false` — a clean run needs no
 *  badge; callers can skip rendering. `verified` (overhaul/05) DOES show: it is
 *  the one tier a reviewer benefits from seeing, since it is earned. */
export function healthMeta(h: RunHealth | null | undefined): {
  show: boolean;
  cls: string;
  label: string;
  icon: string;
} {
  switch (h) {
    case "verified":
      return { show: true, cls: "ok", label: "verified", icon: "✓✓" };
    case "recovered":
      return { show: true, cls: "accent", label: "recovered", icon: "↻" };
    case "degraded":
      return { show: true, cls: "warn", label: "degraded", icon: "▲" };
    case "empty":
      return { show: true, cls: "bad", label: "empty", icon: "∅" };
    case "healthy":
      return { show: false, cls: "ok", label: "healthy", icon: "✓" };
    default:
      return { show: false, cls: "dim", label: "", icon: "" };
  }
}
