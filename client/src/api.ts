/** Typed API client + shared types. All calls hit the Fastify `/api` surface. */

export interface Project {
  internal_calls?: number;
  external_calls?: number;
  id: number;
  name: string;
  repo_path: string;
  planning_dir: string;
  default_model: string | null;
  models: string[];
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
  tokens: number | null;
  depth: number;
  model: string | null;
  open_questions_json: string | null;
  /** The primary run this critiques/second-reviews, if this is not itself a primary run. */
  target_run_id: number | null;
  /** "primary" | "critique" | "second_review". */
  run_kind: string;
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
  has_api_key: boolean;
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

/** GET /api/safety response shape. */
export interface SafetyResponse {
  agent_tools: {
    mode: string;
    write_scope: string;
    shell_access: boolean;
    cross_repo_access: boolean;
    source_code_writes: boolean;
    git_history_available: boolean;
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
}

export interface PingResult {
  config_id: number;
  name: string;
  base_url: string;
  available: boolean;
  error?: string;
  status: "checking" | "done";
}

export interface PingResultInit {
  configs: Array<{
    config_id: number;
    name: string;
    base_url: string;
  }>;
}

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

  roles: (projectId: number) => req<{ roles: Role[] }>(`/api/projects/${projectId}/roles`),
  saveRole: (projectId: number, key: string, body: Partial<Role>) =>
    req<{ role: Role }>(`/api/projects/${projectId}/roles/${key}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  tasks: (projectId?: number) =>
    req<{ tasks: Task[] }>(`/api/tasks${projectId ? `?projectId=${projectId}` : ""}`),
  task: (taskId: string) => req<TaskDetail>(`/api/tasks/${taskId}`),
  deleteTask: (taskId: string, removePlan?: boolean) =>
    req<{ ok: boolean }>(`/api/tasks/${taskId}${removePlan ? "?removePlan=true" : ""}`, { method: "DELETE" }),

  resetTask: (taskId: string) => req<{ task: Task }>(`/api/tasks/${taskId}/reset`, { method: "POST" }),

  updateTask: (taskId: string, body: { name?: string; content?: string }) =>
    req<TaskDetail>(`/api/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify(body) }),

  intake: (projectId: number, body: { name: string; content: string; intake_kind?: string }) =>
    req<{ accepted: boolean; path: string }>(`/api/projects/${projectId}/intake`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  intervene: (taskId: string, kind: string, payload?: unknown) =>
    req<{ intervention: Intervention }>(`/api/tasks/${taskId}/interventions`, {
      method: "POST",
      body: JSON.stringify({ kind, payload }),
    }),

  createSubtask: (taskId: string, body: { name: string; content?: string }) =>
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

  // Summary dashboard
  summary: () => req<SummaryStats>("/api/summary"),
  /** URL for the SSE ping-network stream (GET). */
  pingNetworkStreamUrl: () => "/api/ping-network/stream",

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
