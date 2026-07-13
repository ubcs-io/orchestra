/**
 * REST API surface (`/api/...`). All steering actions are POSTs; the live view
 * is the separate SSE route. Kept intentionally thin — the logic lives in the
 * orchestrator and db modules.
 */

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createIntervention,
  createProject,
  createTask,
  deleteProject,
  deleteTask,
  getGlobalConfig,
  getProject,
  getTask,
  listInterventions,
  listProjects,
  listRoles,
  listRoleRuns,
  listTasks,
  updateProject,
  updateTask,
  upsertConfig,
  upsertRole,
} from "../db.js";
import { isGitRepo, scaffoldPlanning, writeArtifact } from "../git.js";
import { discoverModels } from "../providers.js";
import { resolveConnection } from "../settings.js";
import { CONCERN_TAXONOMY, FLOW_TEMPLATES, flowForIntake, type IntakeKind } from "../roles.js";
import {
  isSchedulerRunning,
  startScheduler,
  stopScheduler,
  tick,
} from "../orchestrator.js";

function bad(reply: FastifyReply, code: number, message: string) {
  return reply.code(code).send({ error: message });
}

function taskDetail(taskId: string) {
  const task = getTask(taskId);
  if (!task) return null;
  const runs = listRoleRuns(task.task_id);
  const interventions = listInterventions(task.task_id);
  const children = listTasks({ parentTaskId: task.task_id });
  let coverage: unknown = null;
  try {
    coverage = task.coverage_json ? JSON.parse(task.coverage_json) : null;
  } catch {
    coverage = null;
  }
  let plan: unknown = null;
  try {
    plan = task.refinement_plan_json ? JSON.parse(task.refinement_plan_json) : null;
  } catch {
    plan = null;
  }
  const flow = flowForIntake((task.intake_kind as IntakeKind) || "manual");
  return {
    task,
    plan,
    coverage,
    runs,
    interventions,
    children,
    taxonomy: CONCERN_TAXONOMY,
    flow: {
      key: flow.key,
      rigor: flow.rigor,
      reviewerRole: flow.reviewerRole,
      criteria: flow.criteria,
      mandatoryConcerns: flow.mandatoryConcerns,
      maxLoopbacks: flow.maxLoopbacks,
    },
  };
}

/**
 * Normalize a user-supplied repository path into an absolute filesystem path.
 * Tolerates the common ways a path arrives mangled from a browser field:
 * surrounding whitespace/quotes, a `file://` URL (as produced by dragging a
 * folder from Finder), percent-encoded spaces, and a leading `~`.
 */
export function normalizeRepoPath(input: string): string {
  let raw = input.trim();
  // Strip a single pair of surrounding quotes (from copy/paste or shell habit).
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }
  // A dragged folder arrives as file:///Users/me/proj with %20-encoded spaces.
  if (raw.startsWith("file://")) {
    try {
      raw = fileURLToPath(raw);
    } catch {
      // Fall back to manual stripping if the URL is slightly malformed.
      raw = decodeURIComponent(raw.replace(/^file:\/\//, ""));
    }
  } else if (raw.includes("%")) {
    // Percent-encoding without a scheme (e.g. a copied encoded path).
    try {
      raw = decodeURIComponent(raw);
    } catch {
      /* leave as-is if not valid encoding */
    }
  }
  // Expand a leading `~` to the server user's home directory.
  if (raw === "~" || raw.startsWith("~/")) raw = path.join(os.homedir(), raw.slice(1));
  return path.isAbsolute(raw) ? path.resolve(raw) : raw;
}

export async function apiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/models", async () => ({ models: await discoverModels() }));

  app.get("/api/concerns", async () => ({ concerns: CONCERN_TAXONOMY }));

  app.get("/api/flows", async () => ({ flows: FLOW_TEMPLATES }));

  // ---- Connection config (global 'default' profile) ----
  // The API key is never sent back to the client — only whether one is set, and
  // whether an ORCHESTRA_* env var is overriding the stored value (env wins).
  app.get("/api/config", async () => {
    const row = getGlobalConfig();
    const resolved = resolveConnection();
    const { api_key, ...safe } = row ?? {};
    return {
      config: {
        ...safe,
        has_api_key: !!(api_key && api_key.length),
      },
      resolved: {
        baseUrl: resolved.baseUrl,
        api: resolved.api,
        defaultModelId: resolved.defaultModelId,
        contextWindow: resolved.contextWindow,
        maxTokens: resolved.maxTokens,
        requestTimeoutMs: resolved.requestTimeoutMs,
        has_api_key: !!resolved.apiKey,
      },
      env_overrides: {
        base_url: !!process.env.ORCHESTRA_BASE_URL,
        api_key: !!process.env.ORCHESTRA_API_KEY,
      },
    };
  });

  app.patch("/api/config", async (req: FastifyRequest) => {
    const body = (req.body ?? {}) as {
      name?: string;
      base_url?: string;
      api_key?: string;
      default_model?: string;
      context_window?: number;
      max_tokens?: number;
      request_timeout_ms?: number;
    };
    // An explicit empty api_key clears the stored token (fall back to env/none);
    // omitting the field leaves the existing token untouched.
    const api_key =
      body.api_key === undefined ? undefined : body.api_key.trim() === "" ? null : body.api_key.trim();
    upsertConfig({
      project_id: null,
      key: "default",
      name: body.name,
      base_url: body.base_url?.trim(),
      api_key,
      default_model: body.default_model?.trim(),
      context_window: body.context_window,
      max_tokens: body.max_tokens,
      request_timeout_ms: body.request_timeout_ms,
    });
    // Return the same redacted shape as GET.
    const row = getGlobalConfig();
    const { api_key: _k, ...safe } = row ?? {};
    return { config: { ...safe, has_api_key: !!(_k && _k.length) } };
  });

  // ---- Scheduler ----
  app.get("/api/scheduler", async () => ({ running: isSchedulerRunning() }));
  app.post("/api/scheduler/start", async () => {
    startScheduler();
    return { running: true };
  });
  app.post("/api/scheduler/stop", async () => {
    await stopScheduler();
    return { running: false };
  });
  app.post("/api/tick", async () => ({ worked: await tick() }));

  // ---- Projects ----
  app.get("/api/projects", async () => ({ projects: listProjects() }));

  app.post("/api/projects", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as {
      name?: string;
      repo_path?: string;
      planning_dir?: string;
      default_model?: string;
    };
    if (!body.name || !body.repo_path) return bad(reply, 400, "name and repo_path are required");
    const repoPath = normalizeRepoPath(body.repo_path);
    if (!path.isAbsolute(repoPath)) {
      return bad(reply, 400, `repo_path must be an absolute path to the repository root (got "${repoPath}")`);
    }
    // JSON.stringify the raw value so any hidden characters (zero-width spaces,
    // control chars, stray unicode from a paste) show up as escapes in the log.
    console.log(`[api] POST /projects — raw repo_path=${JSON.stringify(body.repo_path)} → resolved=${JSON.stringify(repoPath)}`);
    let canonicalRoot: string;
    try {
      canonicalRoot = isGitRepo(repoPath).canonicalRoot;
    } catch (err) {
      console.error(`[api] isGitRepo failed for "${repoPath}": ${(err as Error).message}`);
      return bad(reply, 400, (err as Error).message);
    }
    console.log(`[api] canonical repo root: "${canonicalRoot}"`);
    const project = createProject({
      name: body.name,
      repo_path: canonicalRoot,
      planning_dir: body.planning_dir,
      default_model: body.default_model ?? null,
    });
    scaffoldPlanning(project.repo_path, project.planning_dir);
    return { project };
  });

  app.get("/api/projects/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const id = Number((req.params as { id: string }).id);
    const project = getProject(id);
    if (!project) return bad(reply, 404, "project not found");
    return { project, roles: listRoles(id) };
  });

  app.patch("/api/projects/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const id = Number((req.params as { id: string }).id);
    if (!getProject(id)) return bad(reply, 404, "project not found");
    return { project: updateProject(id, (req.body ?? {}) as Record<string, unknown>) };
  });

  app.delete("/api/projects/:id", async (req: FastifyRequest) => {
    deleteProject(Number((req.params as { id: string }).id));
    return { ok: true };
  });

  // ---- Roles (per project, merged with globals) ----
  app.get("/api/projects/:id/roles", async (req: FastifyRequest) => {
    const id = Number((req.params as { id: string }).id);
    return { roles: listRoles(id) };
  });

  app.put("/api/projects/:id/roles/:key", async (req: FastifyRequest, reply: FastifyReply) => {
    const id = Number((req.params as { id: string; key: string }).id);
    const key = (req.params as { key: string }).key;
    if (!getProject(id)) return bad(reply, 404, "project not found");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const role = upsertRole({
      project_id: id,
      key,
      title: body.title as string | undefined,
      enabled: body.enabled as boolean | undefined,
      ordering: body.ordering as number | undefined,
      system_prompt: body.system_prompt as string | undefined,
      tools_json: body.tools_json as string | undefined,
      model: body.model as string | undefined,
    });
    return { role };
  });

  // ---- Tasks ----
  app.get("/api/tasks", async (req: FastifyRequest) => {
    const q = req.query as { projectId?: string; stage?: string };
    return {
      tasks: listTasks({
        projectId: q.projectId ? Number(q.projectId) : undefined,
        stage: q.stage,
      }),
    };
  });

  app.get("/api/tasks/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const detail = taskDetail((req.params as { id: string }).id);
    if (!detail) return bad(reply, 404, "task not found");
    return detail;
  });

  app.delete("/api/tasks/:id", async (req: FastifyRequest) => {
    deleteTask((req.params as { id: string }).id);
    return { ok: true };
  });

  // Create an intake directly (manual textarea) OR drop a file into INTAKE.
  app.post("/api/projects/:id/intake", async (req: FastifyRequest, reply: FastifyReply) => {
    const id = Number((req.params as { id: string }).id);
    const project = getProject(id);
    if (!project) return bad(reply, 404, "project not found");
    const body = (req.body ?? {}) as { name?: string; content?: string; intake_kind?: string };
    if (!body.content) return bad(reply, 400, "content is required");
    const name = (body.name || "intake").replace(/[^a-z0-9._-]+/gi, "-").slice(0, 60);

    // Route through the INTAKE folder so ingestion is the single code path.
    scaffoldPlanning(project.repo_path, project.planning_dir);
    const ext = body.intake_kind === "error_file" ? ".log" : ".md";
    const rel = path.join(project.planning_dir, "INTAKE", `${name}${ext}`);
    writeArtifact(path.join(project.repo_path, rel), body.content);
    return reply.code(202).send({ accepted: true, path: rel });
  });

  // Manual task creation without a repo file (e.g. quick note).
  app.post("/api/tasks", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as {
      name?: string;
      content?: string;
      project_id?: number;
      intake_kind?: string;
    };
    if (!body.name) return bad(reply, 400, "name is required");
    const task = createTask({
      name: body.name,
      content: body.content ?? null,
      project_id: body.project_id ?? null,
      intake_kind: body.intake_kind ?? "manual",
    });
    return { task };
  });

  // ---- Interventions (steering) ----
  app.post("/api/tasks/:id/interventions", async (req: FastifyRequest, reply: FastifyReply) => {
    const taskId = (req.params as { id: string }).id;
    const task = getTask(taskId);
    if (!task) return bad(reply, 404, "task not found");
    const body = (req.body ?? {}) as { kind?: string; payload?: unknown };
    if (!body.kind) return bad(reply, 400, "kind is required");
    // pause/resume are reflected immediately for snappy UI; the orchestrator also
    // consumes the intervention row on its next pass.
    if (body.kind === "pause") updateTask(task.task_id, { paused: 1 });
    if (body.kind === "resume" || body.kind === "run_now") updateTask(task.task_id, { paused: 0 });
    const iv = createIntervention({
      task_id: task.task_id,
      kind: body.kind,
      payload_json: body.payload ? JSON.stringify(body.payload) : null,
    });
    return { intervention: iv };
  });
}
