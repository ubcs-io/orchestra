/**
 * REST API surface (`/api/...`). All steering actions are POSTs; the live view
 * is the separate SSE route. Kept intentionally thin — the logic lives in the
 * orchestrator and db modules.
 */

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createIntervention,
  createModelConfig,
  createNetwork,
  createProject,
  createTask,
  deleteModelConfig,
  deleteNetwork,
  deleteProject,
  deleteTask,
  duplicateModelConfig,
  duplicateNetwork,
  getConfigById,
  getDb,
  getGlobalConfig,
  getNetwork,
  getNetworkByIntakeKind,
  getProject,
  getTask,
  listInterventions,
  listModelConfigs,
  listNetworks,
  listProjects,
  listRoles,
  listRoleRuns,
  listTasks,
  resetTask,
  setDefaultModelConfig,
  setDefaultNetwork,
  updateModelConfig,
  updateNetwork,
  updateProject,
  updateTask,
  upsertConfig,
  upsertRole,
} from "../db.js";
import { isGitRepo, removeFile, scaffoldPlanning, writeArtifact } from "../git.js";
import { discoverModels } from "../providers.js";
import { envTokenForModel, locationLabel, resolveConnection, THINKING_FORMATS } from "../settings.js";
import { CONCERN_TAXONOMY, FLOW_TEMPLATES, flowForIntake, type IntakeKind } from "../roles.js";
import {
  isSchedulerRunning,
  isSchedulerStopping,
  startScheduler,
  stopScheduler,
  tick,
} from "../orchestrator.js";
import { applyWaterfallLayout, type NetworkGraph } from "../roles.js";

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
    recap_md: task.recap_md ?? null,
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

/**
 * Discover models from an arbitrary OpenAI-compatible endpoint.
 * Best-effort: returns [] if the endpoint is unreachable or shaped differently.
 */
async function discoverModelsFrom(baseUrl: string, apiKey?: string): Promise<string[]> {
  const url = baseUrl.replace(/\/+$/, "") + "/models";
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: Array<{ id?: string }> } | Array<{ id?: string }>;
    const list = Array.isArray(data) ? data : (data.data ?? []);
    return list.map((m) => m.id).filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

export async function apiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/models", async () => ({ models: await discoverModels() }));

  // Discover models from a caller-supplied base URL (for model-config setup flow).
  app.post("/api/models/discover", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as { base_url?: string; api_key?: string };
    if (!body.base_url) return bad(reply, 400, "base_url is required");
    const models = await discoverModelsFrom(body.base_url.trim(), body.api_key?.trim() || undefined);
    return { models };
  });

  app.get("/api/concerns", async () => ({ concerns: CONCERN_TAXONOMY }));

  app.get("/api/flows", async () => ({ flows: FLOW_TEMPLATES }));

  // ---- Folder picker dialog (native OS dialog) ----
  app.post("/api/dialogs/folder", async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      let script: string;
      let args: string[];
      if (process.platform === "darwin") {
        script = "osascript";
        args = ["-e", 'POSIX path of (choose folder with prompt "Select repository folder")'];
      } else if (process.platform === "win32") {
        script = "powershell";
        args = [
          "-NoProfile",
          "-Command",
          `Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.FolderBrowserDialog
$f.Description = "Select repository folder"
if ($f.ShowDialog() -eq 'OK') { $f.SelectedPath } else { "" }`,
        ];
      } else {
        // Linux — try zenity, fall back to kdialog
        script = "zenity";
        args = ["--file-selection", "--directory", "--title=Select repository folder"];
      }
      const path = await new Promise<string>((resolve) => {
        execFile(script, args, { timeout: 120_000 }, (err, stdout) => {
          if (err) {
            // Non-zero exit (e.g. user cancelled) — return null, not an error.
            resolve("");
            return;
          }
          resolve(stdout.trim());
        });
      });
      return { path: path || null };
    } catch (err) {
      console.error(`[api] folder picker failed: ${(err as Error).message}`);
      return { path: null };
    }
  });

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
        reasoning: resolved.reasoning,
        thinkingLevel: resolved.thinkingLevel,
        thinkingFormat: resolved.thinkingFormat,
        textMode: resolved.textMode,
        compat: resolved.compat,
        has_api_key: !!resolved.apiKey,
      },
      env_overrides: {
        base_url: !!process.env.ORCHESTRA_BASE_URL,
        api_key: !!process.env.ORCHESTRA_API_KEY,
      },
    };
  });

  app.patch("/api/config", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as {
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
      compat?: Record<string, unknown> | null;
    };
    if (
      body.thinking_format !== undefined &&
      !(THINKING_FORMATS as readonly string[]).includes(body.thinking_format)
    ) {
      return bad(reply, 400, `unknown thinking_format '${body.thinking_format}'`);
    }
    // An explicit empty api_key clears the stored token (fall back to env/none);
    // omitting the field leaves the existing token untouched.
    const api_key =
      body.api_key === undefined ? undefined : body.api_key.trim() === "" ? null : body.api_key.trim();
    // compat_json: null clears it, undefined keeps prior, an object serialises.
    const compat_json =
      body.compat === undefined
        ? undefined
        : body.compat === null
          ? null
          : JSON.stringify(body.compat);
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
      reasoning: body.reasoning === undefined ? undefined : body.reasoning ? 1 : 0,
      thinking_level: body.thinking_level,
      thinking_format: body.thinking_format,
      text_mode: body.text_mode === undefined ? undefined : body.text_mode ? 1 : 0,
      compat_json,
    });
    // Return the same redacted shape as GET.
    const row = getGlobalConfig();
    const { api_key: _k, ...safe } = row ?? {};
    return { config: { ...safe, has_api_key: !!(_k && _k.length) } };
  });

  // ---- Model Configs (named connection profiles) ----

  // List all model configs.
  app.get("/api/model-configs", async () => {
    const configs = listModelConfigs();
    const hasTokensEnv = !!process.env.ORCHESTRA_TOKENS;
    const enriched = configs.map((cfg) => {
      const { api_key, ...safe } = cfg;
      const envKey = envTokenForModel(cfg.name);
      return {
        ...safe,
        has_api_key: !!(api_key && api_key.length),
        has_env_token: !!envKey,
        location: locationLabel(cfg.base_url),
      };
    });
    return { configs: enriched, has_tokens_env: hasTokensEnv };
  });

  // Create a new model config.
  app.post("/api/model-configs", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as {
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
    };
    if (!body.name || !body.name.trim()) return bad(reply, 400, "name is required");
    if (
      body.thinking_format !== undefined &&
      !(THINKING_FORMATS as readonly string[]).includes(body.thinking_format)
    ) {
      return bad(reply, 400, `unknown thinking_format '${body.thinking_format}'`);
    }
    try {
      const cfg = createModelConfig({
        name: body.name.trim(),
        base_url: body.base_url?.trim(),
        api_key: body.api_key?.trim() || null,
        default_model: body.default_model?.trim(),
        context_window: body.context_window,
        max_tokens: body.max_tokens,
        request_timeout_ms: body.request_timeout_ms,
        reasoning: body.reasoning,
        thinking_level: body.thinking_level,
        thinking_format: body.thinking_format,
        text_mode: body.text_mode,
      });
      const { api_key, ...safe } = cfg;
      const envKey = envTokenForModel(cfg.name);
      return {
        config: {
          ...safe,
          has_api_key: !!(api_key && api_key.length),
          has_env_token: !!envKey,
          location: locationLabel(cfg.base_url),
        },
      };
    } catch (err) {
      return bad(reply, 409, (err as Error).message);
    }
  });

  // Get a single model config.
  app.get("/api/model-configs/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const id = Number((req.params as { id: string }).id);
    const cfg = getConfigById(id);
    if (!cfg) return bad(reply, 404, "model config not found");
    const { api_key, ...safe } = cfg;
    const envKey = envTokenForModel(cfg.name);
    return {
      config: {
        ...safe,
        has_api_key: !!(api_key && api_key.length),
        has_env_token: !!envKey,
        location: locationLabel(cfg.base_url),
      },
    };
  });

  // Update a model config.
  app.patch("/api/model-configs/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const id = Number((req.params as { id: string }).id);
    const body = (req.body ?? {}) as {
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
    };
    if (
      body.thinking_format !== undefined &&
      !(THINKING_FORMATS as readonly string[]).includes(body.thinking_format)
    ) {
      return bad(reply, 400, `unknown thinking_format '${body.thinking_format}'`);
    }
    try {
      const cfg = updateModelConfig(id, {
        name: body.name?.trim(),
        base_url: body.base_url?.trim(),
        api_key: body.api_key !== undefined ? (body.api_key.trim() === "" ? null : body.api_key.trim()) : undefined,
        default_model: body.default_model?.trim(),
        context_window: body.context_window,
        max_tokens: body.max_tokens,
        request_timeout_ms: body.request_timeout_ms,
        reasoning: body.reasoning === undefined ? undefined : body.reasoning ? 1 : 0,
        thinking_level: body.thinking_level,
        thinking_format: body.thinking_format,
        text_mode: body.text_mode === undefined ? undefined : body.text_mode ? 1 : 0,
      });
      const { api_key, ...safe } = cfg;
      const envKey = envTokenForModel(cfg.name);
      return {
        config: {
          ...safe,
          has_api_key: !!(api_key && api_key.length),
          has_env_token: !!envKey,
          location: locationLabel(cfg.base_url),
        },
      };
    } catch (err) {
      return bad(reply, 409, (err as Error).message);
    }
  });

  // Delete a model config.
  app.delete("/api/model-configs/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const id = Number((req.params as { id: string }).id);
    try {
      deleteModelConfig(id);
      return { ok: true };
    } catch (err) {
      return bad(reply, 400, (err as Error).message);
    }
  });

  // Duplicate a model config.
  app.post("/api/model-configs/:id/duplicate", async (req: FastifyRequest, reply: FastifyReply) => {
    const id = Number((req.params as { id: string }).id);
    const body = (req.body ?? {}) as { name?: string };
    try {
      const cfg = duplicateModelConfig(id, body.name);
      const { api_key, ...safe } = cfg;
      const envKey = envTokenForModel(cfg.name);
      return {
        config: {
          ...safe,
          has_api_key: !!(api_key && api_key.length),
          has_env_token: !!envKey,
          location: locationLabel(cfg.base_url),
        },
      };
    } catch (err) {
      return bad(reply, 409, (err as Error).message);
    }
  });

  // Set a model config as the global default.
  app.post("/api/model-configs/:id/set-default", async (req: FastifyRequest, reply: FastifyReply) => {
    const id = Number((req.params as { id: string }).id);
    try {
      const cfg = setDefaultModelConfig(id);
      const { api_key, ...safe } = cfg;
      const envKey = envTokenForModel(cfg.name);
      return {
        config: {
          ...safe,
          has_api_key: !!(api_key && api_key.length),
          has_env_token: !!envKey,
          location: locationLabel(cfg.base_url),
        },
      };
    } catch (err) {
      return bad(reply, 400, (err as Error).message);
    }
  });

  // ---- Scheduler ----
  app.get("/api/scheduler", async () => ({ running: isSchedulerRunning(), stopping: isSchedulerStopping() }));
  app.post("/api/scheduler/start", async () => {
    startScheduler();
    return { running: true };
  });
  app.post("/api/scheduler/stop", () => {
    stopScheduler();
    return { running: false, stopping: isSchedulerStopping() };
  });
  app.post("/api/tick", async () => ({ worked: await tick() }));

  // ---- Projects ----
  app.get("/api/projects", async () => {
    const projects = listProjects();
    const enriched = projects.map((p) => {
      const roles = listRoles(p.id);
      const models = [...new Set(
        roles
          .filter((r) => r.enabled && r.model)
          .map((r) => r.model!)
      )];
      // If no per-role model is set, fall back to the project default_model or
      // the global default model config so the homepage card never shows "—".
      if (models.length === 0) {
        const fallback = p.default_model ?? getGlobalConfig()?.default_model ?? null;
        if (fallback) models.push(fallback);
      }
      return { ...p, models };
    });
    return { projects: enriched };
  });

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
      can_create_subtasks: body.can_create_subtasks as boolean | undefined,
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
    const taskId = (req.params as { id: string }).id;
    const q = req.query as { removePlan?: string };

    // Resolve artifact path before deletion so we know what to delete on disk.
    const task = getTask(taskId);
    const artifactRel = task?.artifact_path ?? null;

    deleteTask(taskId);

    // Optionally remove the .md plan/output file from disk.
    if (q.removePlan === "true" && artifactRel && task?.project_id) {
      const project = getProject(task.project_id);
      if (project) {
        const absPath = path.join(project.repo_path, artifactRel);
        removeFile(absPath);
      }
    }

    return { ok: true };
  });

  // Edit a task's name / content while it is in intake stage.
  app.patch("/api/tasks/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const taskId = (req.params as { id: string }).id;
    const task = getTask(taskId);
    if (!task) return bad(reply, 404, "task not found");
    if (task.stage !== "intake") {
      return bad(reply, 400, "Only intake tasks can be edited. Reset the task to intake first.");
    }
    const body = (req.body ?? {}) as { name?: string; content?: string };
    if (body.name === undefined && body.content === undefined) {
      return bad(reply, 400, "name or content is required");
    }
    const updates: Partial<import("../db.js").TaskRow> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.content !== undefined) updates.content = body.content;
    const updated = updateTask(taskId, updates);
    if (!updated) return bad(reply, 500, "update failed");
    // Refresh the full detail view
    return taskDetail(taskId);
  });

  // Reset a task to intake state — clears all history, moves back to intake.
  app.post("/api/tasks/:id/reset", async (req: FastifyRequest, reply: FastifyReply) => {
    const taskId = (req.params as { id: string }).id;
    const task = getTask(taskId);
    if (!task) return bad(reply, 404, "task not found");

    // Remove the output .md file from disk if one exists.
    if (task.artifact_path && task.project_id) {
      const project = getProject(task.project_id);
      if (project) {
        removeFile(path.join(project.repo_path, task.artifact_path));
      }
    }

    const updated = resetTask(taskId);
    if (!updated) return bad(reply, 500, "reset failed");
    return { task: updated };
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

  // ---- Subtasks (create child tasks from next-step actions) ----
  app.post("/api/tasks/:id/subtasks", async (req: FastifyRequest, reply: FastifyReply) => {
    const taskId = (req.params as { id: string }).id;
    const parent = getTask(taskId);
    if (!parent) return bad(reply, 404, "task not found");
    const body = (req.body ?? {}) as { name?: string; content?: string };
    if (!body.name) return bad(reply, 400, "name is required");
    const child = createTask({
      name: body.name,
      content: body.content ?? body.name,
      project_id: parent.project_id,
      stage: "intake",
      level: "task",
      intake_kind: parent.intake_kind ?? "manual",
      exit_kind: parent.exit_kind ?? "spec",
      parent_task_id: parent.task_id,
      task_type: "child",
    });
    return { task: child };
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

  // ---- Agent Networks (visual flow templates) ----

  // List all networks. Query params: ?project_id=X (filters to project scope + global system).
  app.get("/api/networks", async (req: FastifyRequest) => {
    const q = req.query as { project_id?: string };
    const projectId = q.project_id ? Number(q.project_id) : undefined;
    return { networks: listNetworks({ projectId }) };
  });

  // Get the default network for an intake kind in a project context.
  app.get("/api/networks/default", async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as { project_id?: string; intake_kind?: string };
    if (!q.intake_kind) return bad(reply, 400, "intake_kind is required");
    const projectId = q.project_id ? Number(q.project_id) : null;
    const network = getNetworkByIntakeKind(projectId, q.intake_kind);
    return { network: network ?? null };
  });

  // Get a single network by id.
  app.get("/api/networks/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const network = getNetwork((req.params as { id: string }).id);
    if (!network) return bad(reply, 404, "network not found");
    return { network };
  });

  // Create a new custom network.
  app.post("/api/networks", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as {
      name?: string;
      description?: string;
      project_id?: number;
      intake_kind?: string;
      graph_json?: string;
    };
    if (!body.name) return bad(reply, 400, "name is required");
    if (!body.graph_json) return bad(reply, 400, "graph_json is required");
    try {
      JSON.parse(body.graph_json);
    } catch {
      return bad(reply, 400, "graph_json is not valid JSON");
    }
    const network = createNetwork({
      name: body.name,
      description: body.description,
      project_id: body.project_id ?? null,
      intake_kind: body.intake_kind ?? null,
      graph_json: body.graph_json,
    });
    return { network };
  });

  // Update a network (PUT for full replace semantics).
  app.put("/api/networks/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const networkId = (req.params as { id: string }).id;
    const network = getNetwork(networkId);
    if (!network) return bad(reply, 404, "network not found");
    if (network.is_system) return bad(reply, 403, "system networks are read-only; duplicate to edit");
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.graph_json !== undefined) {
      try {
        JSON.parse(body.graph_json as string);
      } catch {
        return bad(reply, 400, "graph_json is not valid JSON");
      }
    }
    const updated = updateNetwork(networkId, body);
    return { network: updated };
  });

  // Delete a custom network.
  app.delete("/api/networks/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const network = getNetwork((req.params as { id: string }).id);
    if (!network) return bad(reply, 404, "network not found");
    if (network.is_system) return bad(reply, 403, "system networks are read-only");
    deleteNetwork((req.params as { id: string }).id);
    return { ok: true };
  });

  // Duplicate a network (system or custom) into a new editable copy.
  app.post("/api/networks/:id/duplicate", async (req: FastifyRequest, reply: FastifyReply) => {
    const network = getNetwork((req.params as { id: string }).id);
    if (!network) return bad(reply, 404, "network not found");
    const body = (req.body ?? {}) as { name?: string; project_id?: number };
    const copy = duplicateNetwork((req.params as { id: string }).id, body.name, body.project_id);

    // Re-apply waterfall layout to the duplicate so it's always readable.
    try {
      const parsed = JSON.parse(copy.graph_json);
      copy.graph_json = JSON.stringify(applyWaterfallLayout(parsed));
      updateNetwork(copy.network_id, { graph_json: copy.graph_json });
    } catch {
      /* keep original layout if JSON is malformed */
    }

    return { network: copy };
  });

  // Set a network as the default for its intake_kind.
  app.post("/api/networks/:id/set-default", async (req: FastifyRequest, reply: FastifyReply) => {
    const network = getNetwork((req.params as { id: string }).id);
    if (!network) return bad(reply, 404, "network not found");
    if (!network.intake_kind) return bad(reply, 400, "network has no intake_kind");
    const updated = setDefaultNetwork((req.params as { id: string }).id);
    return { network: updated };
  });

  // Import a network from JSON.
  app.post("/api/networks/import", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as {
      name?: string;
      description?: string;
      project_id?: number;
      intake_kind?: string;
      graph_json?: string;
    };
    if (!body.graph_json) return bad(reply, 400, "graph_json is required");
    // Validate graph structure
    let graph: unknown;
    try {
      graph = JSON.parse(body.graph_json);
    } catch {
      return bad(reply, 400, "graph_json is not valid JSON");
    }
    const g = graph as Record<string, unknown>;
    if (!g.nodes || !Array.isArray(g.nodes)) {
      return bad(reply, 400, "graph_json must have a 'nodes' array");
    }
    if (!g.edges || !Array.isArray(g.edges)) {
      return bad(reply, 400, "graph_json must have an 'edges' array");
    }
    const network = createNetwork({
      name: body.name ?? "Imported Network",
      description: body.description,
      project_id: body.project_id ?? null,
      intake_kind: body.intake_kind ?? null,
      graph_json: JSON.stringify(applyWaterfallLayout(g as unknown as NetworkGraph)),
    });
    return { network };
  });

  // Export a network as JSON.
  app.get("/api/networks/:id/export", async (req: FastifyRequest, reply: FastifyReply) => {
    const network = getNetwork((req.params as { id: string }).id);
    if (!network) return bad(reply, 404, "network not found");
    let graph: unknown;
    try {
      graph = JSON.parse(network.graph_json);
    } catch {
      return bad(reply, 500, "stored graph_json is not valid JSON");
    }
    return {
      export: {
        version: 1,
        exported_at: new Date().toISOString(),
        network_id: network.network_id,
        name: network.name,
        description: network.description,
        intake_kind: network.intake_kind,
        graph,
      },
    };
  });

  // List all roles (global + project-merged) — used by the network editor palette.
  app.get("/api/roles", async (req: FastifyRequest) => {
    const q = req.query as { project_id?: string };
    const projectId = q.project_id ? Number(q.project_id) : null;
    return { roles: listRoles(projectId) };
  });

  // ---- Summary stats (homepage dashboard) ----
  app.get("/api/summary", async () => {
    const d = getDb();
    const projects = listProjects();
    const allTasks = listTasks();
    const byStage: Record<string, number> = { intake: 0, refining: 0, ready: 0, review: 0 };
    let inFlight = 0;
    let actionItems = 0;
    let blockers = 0;
    let paused = 0;
    const blockersList: Array<{
      task_id: string;
      name: string | null;
      exit_state: string | null;
      stage: string | null;
      project_id: number | null;
      review_reason: string | null;
    }> = [];

    for (const t of allTasks) {
      const stage = t.stage ?? "intake";
      if (byStage[stage] !== undefined) byStage[stage]++;
      if (stage === "refining" || stage === "ready") inFlight++;
      if (t.exit_state && ["blocker", "needs_human", "needs_more"].includes(t.exit_state)) {
        actionItems++;
        if (t.exit_state === "blocker") blockers++;
        blockersList.push({
          task_id: t.task_id,
          name: t.name,
          exit_state: t.exit_state,
          stage: t.stage,
          project_id: t.project_id,
          review_reason: t.review_reason,
        });
      }
      if (t.paused === 1) paused++;
    }

    // Enrich action items with project name
    const enrichedBlockers = blockersList.map((b) => {
      const proj = projects.find((p) => p.id === b.project_id);
      return { ...b, project_name: proj?.name ?? null };
    });

    return {
      total: allTasks.length,
      by_stage: byStage,
      in_flight: inFlight,
      action_items: actionItems,
      blockers,
      paused,
      projects_count: projects.length,
      blockers_list: enrichedBlockers,
    };
  });

  // ---- Ping network: heartbeat check against every model config ----
  app.post("/api/ping-network", async () => {
    const configs = listModelConfigs();
    const results = await Promise.all(
      configs.map(async (cfg) => {
        const baseUrl = (cfg.base_url ?? "").trim();
        if (!baseUrl) {
          return {
            config_id: cfg.id,
            name: cfg.name ?? cfg.key,
            base_url: baseUrl,
            available: false,
            error: "No base URL configured",
          };
        }
        try {
          const url = baseUrl.replace(/\/+$/, "") + "/models";
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 8_000);
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          // Use stored API key if available, else fall back to env token
          const apiKey = cfg.api_key?.trim();
          const envKey = envTokenForModel(cfg.name);
          const authKey = apiKey || envKey;
          if (authKey) headers.Authorization = `Bearer ${authKey}`;
          const res = await fetch(url, { headers, signal: controller.signal });
          clearTimeout(timer);
          return {
            config_id: cfg.id,
            name: cfg.name ?? cfg.key,
            base_url: baseUrl,
            available: res.ok,
            error: res.ok ? undefined : `HTTP ${res.status}`,
          };
        } catch (err) {
          return {
            config_id: cfg.id,
            name: cfg.name ?? cfg.key,
            base_url: baseUrl,
            available: false,
            error: (err as Error).message,
          };
        }
      }),
    );

    return { results };
  });
}
