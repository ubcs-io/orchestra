/** Typed API client + shared types. All calls hit the Fastify `/api` surface. */

export interface Project {
  id: number;
  name: string;
  repo_path: string;
  planning_dir: string;
  default_model: string | null;
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
  paused: number | null;
  refinement_plan_json: string | null;
  content: string | null;
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
  tokens: number | null;
  depth: number;
  model: string | null;
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
  has_api_key: boolean;
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
  plan: Plan | null;
  coverage: CoverageMap | null;
  runs: RoleRun[];
  interventions: Intervention[];
  children: Task[];
  taxonomy: string[];
}

async function req<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "content-type": "application/json" },
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
};

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
