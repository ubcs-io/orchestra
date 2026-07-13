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
}

export interface Intervention {
  id: number;
  task_id: string;
  kind: string;
  payload_json: string | null;
  consumed_at: string | null;
  created_at: string;
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

export const api = {
  health: () => req<{ ok: boolean }>("/api/health"),
  models: () => req<{ models: string[] }>("/api/models"),

  scheduler: () => req<{ running: boolean }>("/api/scheduler"),
  startScheduler: () => req<{ running: boolean }>("/api/scheduler/start", { method: "POST" }),
  stopScheduler: () => req<{ running: boolean }>("/api/scheduler/stop", { method: "POST" }),
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
  deleteTask: (taskId: string) => req<{ ok: boolean }>(`/api/tasks/${taskId}`, { method: "DELETE" }),

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
