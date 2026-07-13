/**
 * REST API surface (`/api/...`). All steering actions are POSTs; the live view
 * is the separate SSE route. Kept intentionally thin — the logic lives in the
 * orchestrator and db modules.
 */

import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createIntervention,
  createProject,
  createTask,
  deleteProject,
  deleteTask,
  getProject,
  getTask,
  listInterventions,
  listProjects,
  listRoles,
  listRoleRuns,
  listTasks,
  updateProject,
  updateTask,
  upsertRole,
} from "../db.js";
import { isGitRepo, scaffoldPlanning, writeArtifact } from "../git.js";
import { discoverModels } from "../providers.js";
import { CONCERN_TAXONOMY } from "../roles.js";
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
  return { task, plan, coverage, runs, interventions, children, taxonomy: CONCERN_TAXONOMY };
}

export async function apiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/models", async () => ({ models: await discoverModels() }));

  app.get("/api/concerns", async () => ({ concerns: CONCERN_TAXONOMY }));

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
    const repoPath = path.resolve(body.repo_path);
    if (!isGitRepo(repoPath)) return bad(reply, 400, `not a git repository: ${repoPath}`);
    const project = createProject({
      name: body.name,
      repo_path: repoPath,
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
