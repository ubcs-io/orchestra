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
  createChatMessage,
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
  getModelPerformanceStats,
  getNetwork,
  getNetworkByIntakeKind,
  getProject,
  getTask,
  listChatMessages,
  listInterventions,
  listModelConfigs,
  listNetworks,
  listProjects,
  listRoles,
  listRoleRuns,
  listTasks,
  reorderModelConfigs,
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
import {
  commitArtifacts,
  isGitRepo,
  removeFile,
  sanitizePath,
  scaffoldPlanning,
  writeArtifact,
} from "../git.js";
import { discoverModels } from "../providers.js";
import {
  envTokenForModel,
  locationLabel,
  resolveConnection,
  resolveConnectionForModel,
  THINKING_FORMATS,
} from "../settings.js";
import { CONCERN_TAXONOMY, FLOW_TEMPLATES, flowForIntake, type IntakeKind } from "../roles.js";
import {
  artifactName,
  isSchedulerRunning,
  isSchedulerStopping,
  startScheduler,
  stopScheduler,
  tick,
} from "../orchestrator.js";
import { applyWaterfallLayout, type NetworkGraph } from "../roles.js";
import { runRole } from "../agent.js";
import { publish } from "../bus.js";

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
    chat_messages: listChatMessages(task.task_id),
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
      thinking_budgets?: string;
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
      thinking_budgets: body.thinking_budgets,
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
      thinking_budgets?: string;
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
        thinking_budgets: body.thinking_budgets,
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
      thinking_budgets?: string;
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
        thinking_budgets: body.thinking_budgets,
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

  // Reorder model configs by ID array.
  app.post("/api/model-configs/reorder", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as { ids?: number[] };
    if (!body.ids || !Array.isArray(body.ids) || body.ids.length === 0) {
      return bad(reply, 400, "ids must be a non-empty array of config IDs");
    }
    reorderModelConfigs(body.ids);
    return { ok: true };
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
      return { ...p, repo_path: sanitizePath(p.repo_path), models };
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
    return { project: { ...project, repo_path: sanitizePath(project.repo_path) } };
  });

  app.get("/api/projects/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const id = Number((req.params as { id: string }).id);
    const project = getProject(id);
    if (!project) return bad(reply, 404, "project not found");
    return { project: { ...project, repo_path: sanitizePath(project.repo_path) }, roles: listRoles(id) };
  });

  app.patch("/api/projects/:id", async (req: FastifyRequest, reply: FastifyReply) => {
    const id = Number((req.params as { id: string }).id);
    if (!getProject(id)) return bad(reply, 404, "project not found");
    const updated = updateProject(id, (req.body ?? {}) as Record<string, unknown>);
    return { project: updated ? { ...updated, repo_path: sanitizePath(updated.repo_path) } : updated };
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

  // ---- Question decomposition (spin a review question off into its own
  // Question Flow subtask, with a compacted digest of the parent's context) ----

  function buildQuestionDigest(
    parent: import("../db.js").TaskRow,
    roleKey: string,
    question: string,
  ): string {
    const parentName = parent.name ?? parent.task_id.slice(0, 8);
    const excerpt = parent.content?.trim() ?? "";
    const truncatedExcerpt =
      excerpt.length > 600 ? `${excerpt.slice(0, 600)}…` : excerpt || "(no original intake text)";

    const runs = listRoleRuns(parent.task_id).slice(-6);
    const findingsLines = runs.length
      ? runs
          .map((r) => {
            const summary = (r.summary ?? "").trim();
            const truncated = summary.length > 200 ? `${summary.slice(0, 200)}…` : summary;
            return `- **${r.role_key}** (${r.verdict ?? "unknown"}): ${truncated || "(no summary)"}`;
          })
          .join("\n")
      : "(no prior findings yet)";

    return [
      `## The question to resolve`,
      question,
      ``,
      `(Raised by the \`${roleKey}\` role while refining "${parentName}".)`,
      ``,
      `## Original problem (excerpt)`,
      truncatedExcerpt,
      ``,
      `## Findings so far (condensed)`,
      findingsLines,
      ``,
      `## Where to find more`,
      `The above is a condensed summary. The full upstream context — the original intake, every prior ` +
        `role's complete write-up, and any human answers — lives in \`${parent.artifact_path ?? "(no artifact yet)"}\` ` +
        `at the root of this repository. Read that file with your \`read\` tool if the condensed summary above ` +
        `isn't enough to answer the question confidently. Don't ask the user something you could answer yourself ` +
        `by reading that file.`,
      ``,
      `## Output format requested`,
      `When the research_synthesis step produces the final brief, structure it as an explicit options table: ` +
        `one row per option with columns "Option", "What it means for this question", "Trade-offs", "When to ` +
        `pick it" — followed by a clear "Recommendation" section. Use a real markdown table, not just prose.`,
    ].join("\n");
  }

  app.post(
    "/api/tasks/:id/questions/decompose",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const taskId = (req.params as { id: string }).id;
      const parent = getTask(taskId);
      if (!parent) return bad(reply, 404, "task not found");
      const body = (req.body ?? {}) as { role_key?: string; question?: string };
      if (!body.role_key || !body.question) {
        return bad(reply, 400, "role_key and question are required");
      }

      // Idempotency: re-clicking "decompose" on the same question returns the
      // existing subtask instead of spawning a duplicate.
      const existing = listTasks({ parentTaskId: parent.task_id }).find(
        (c) => c.origin_role_key === body.role_key && c.origin_question === body.question,
      );
      if (existing) return reply.code(200).send({ task: existing, created: false });

      const project = parent.project_id != null ? getProject(parent.project_id) : undefined;
      if (!project) return bad(reply, 400, "parent task has no project");

      const network = getNetworkByIntakeKind(project.id, "question");
      const digest = buildQuestionDigest(parent, body.role_key, body.question);
      const question = body.question;
      const name = `Q: ${question.length > 70 ? `${question.slice(0, 70)}…` : question}`;

      const child = createTask({
        name,
        content: digest,
        project_id: project.id,
        stage: "intake",
        level: "task",
        intake_kind: "question",
        exit_kind: "research_brief",
        parent_task_id: parent.task_id,
        task_type: "child",
        network_id: network?.network_id ?? null,
        origin_role_key: body.role_key,
        origin_question: question,
      });

      const planningDir = project.planning_dir || "PLANNING";
      const relArtifact = path.join(planningDir, "REFINING", artifactName(child));
      const absArtifact = path.join(project.repo_path, relArtifact);
      writeArtifact(
        absArtifact,
        `# ${name}\n\n> Follow-up question from **${parent.name ?? parent.task_id.slice(0, 8)}** ` +
          `(role: \`${body.role_key}\`)\n\n${digest}\n`,
      );
      updateTask(child.task_id, { artifact_path: relArtifact });
      commitArtifacts(project.repo_path, [relArtifact], `intake(question): ${name}`);
      publish(child.task_id, "task_update", { stage: "intake" });

      return reply.code(201).send({ task: getTask(child.task_id), created: true });
    },
  );

  const CHAT_SYSTEM_PROMPT =
    `You are answering a follow-up question from a human about a research brief that was already ` +
    `produced for them. Read the brief and prior conversation turns supplied in the context, then ` +
    `respond directly and conversationally to the user's latest message — no meta-commentary about ` +
    `being an AI, no repeating the whole brief back. When you finish, call record_findings: set verdict ` +
    `to "pass", leave open_questions and coverage empty, put a one-line gist in summary, and put your ` +
    `full reply (this is what the user will see) in section_md. If you don't have enough grounding to ` +
    `answer confidently, say so plainly instead of guessing.`;

  app.post("/api/tasks/:id/chat", async (req: FastifyRequest, reply: FastifyReply) => {
    const taskId = (req.params as { id: string }).id;
    const task = getTask(taskId);
    if (!task) return bad(reply, 404, "task not found");
    const body = (req.body ?? {}) as { message?: string };
    const message = body.message?.trim();
    if (!message) return bad(reply, 400, "message is required");
    if (!task.recap_md) {
      return bad(reply, 400, "this subtask has not produced a brief yet — wait for it to reach ready/review");
    }

    const project = task.project_id != null ? getProject(task.project_id) : undefined;
    if (!project) return bad(reply, 400, "task has no project");

    const history = listChatMessages(task.task_id);
    const userMsg = createChatMessage({ task_id: task.task_id, role: "user", content: message });

    const transcript = history
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n\n");
    const context = [
      `## Research brief`,
      task.recap_md,
      ...(transcript ? [``, `## Conversation so far`, transcript] : []),
      ``,
      `## Latest message`,
      `User: ${message}`,
    ].join("\n");

    const modelRef = task.model || project.default_model || null;
    const { connection, modelId } = resolveConnectionForModel(modelRef, project.id);

    const result = await runRole({
      repoPath: project.repo_path,
      planningDir: project.planning_dir || "PLANNING",
      artifactAbsPath: path.join(project.repo_path, task.artifact_path ?? ""),
      modelId,
      systemPrompt: CHAT_SYSTEM_PROMPT,
      tools: [],
      context,
      thinkingLevel: connection.reasoning ? connection.thinkingLevel : undefined,
      textMode: connection.textMode,
      twoPhase: connection.twoPhase,
      thinkingBudgets: connection.thinkingBudgets,
      connection,
    });

    const replyText = result.findings.section_md?.trim() || result.findings.summary?.trim() || "(no response)";
    const assistantMsg = createChatMessage({ task_id: task.task_id, role: "assistant", content: replyText });

    return { user_message: userMsg, assistant_message: assistantMsg };
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

  // ---- Model stats (radar chart + performance comparison) ----

  /** Known API/model-size pairs. First match wins (case-insensitive substring).
   *  MoE entries also carry expert counts for the Epoch.ai effective-params
   *  formula:  Dense ≈ (num_experts^0.44 / active_per_token^0.63) × total_b  */
  const KNOWN_MODEL_SIZES: Array<{
    pattern: string;
    total_b: number;
    active_b?: number;
    num_experts?: number;
    active_per_token?: number;
  }> = [
    // OpenAI (dense)
    { pattern: "gpt-4.1-nano", total_b: 8 },
    { pattern: "gpt-4.1-mini", total_b: 70 },
    { pattern: "gpt-4.1", total_b: 1760, active_b: 440 },
    { pattern: "gpt-4o-mini", total_b: 8 },
    { pattern: "gpt-4o", total_b: 1760, active_b: 440 },
    { pattern: "gpt-4-turbo", total_b: 1760, active_b: 440 },
    { pattern: "gpt-3.5-turbo", total_b: 20 },
    { pattern: "o4-mini", total_b: 20 },
    { pattern: "o3-mini", total_b: 20 },
    { pattern: "o1-mini", total_b: 20 },
    { pattern: "o1", total_b: 1760, active_b: 440 },
    { pattern: "o3", total_b: 1760, active_b: 440 },
    { pattern: "o4", total_b: 1760, active_b: 440 },
    // Anthropic (dense)
    { pattern: "claude-opus-4", total_b: 2000 },
    { pattern: "claude-sonnet-4", total_b: 1000 },
    { pattern: "claude-haiku-4", total_b: 200 },
    { pattern: "claude-3.5-sonnet", total_b: 1000 },
    { pattern: "claude-3.5-haiku", total_b: 200 },
    { pattern: "claude-3-opus", total_b: 2000 },
    { pattern: "claude-3-sonnet", total_b: 1000 },
    { pattern: "claude-3-haiku", total_b: 200 },
    // Google (dense)
    { pattern: "gemini-2.5-pro", total_b: 2000 },
    { pattern: "gemini-2.5-flash", total_b: 200 },
    { pattern: "gemini-2.0-flash", total_b: 100 },
    { pattern: "gemini-1.5-pro", total_b: 1000 },
    { pattern: "gemini-1.5-flash", total_b: 100 },
    // DeepSeek (MoE)
    { pattern: "deepseek-v4", total_b: 1600, active_b: 49, num_experts: 256, active_per_token: 8 },
    { pattern: "deepseek-r1", total_b: 671, active_b: 37, num_experts: 256, active_per_token: 8 },
    { pattern: "deepseek-v3", total_b: 671, active_b: 37, num_experts: 256, active_per_token: 8 },
    { pattern: "deepseek-coder-v2", total_b: 236, active_b: 21, num_experts: 160, active_per_token: 6 },
    { pattern: "deepseek-chat", total_b: 671, active_b: 37, num_experts: 256, active_per_token: 8 },
    { pattern: "deepseek-reasoner", total_b: 671, active_b: 37, num_experts: 256, active_per_token: 8 },
    // Meta — Llama 4 (MoE)
    { pattern: "llama-4-maverick", total_b: 400, active_b: 17, num_experts: 128, active_per_token: 1 },
    { pattern: "llama-4-scout", total_b: 109, active_b: 17, num_experts: 16, active_per_token: 1 },
    // Meta — Llama 3 (dense)
    { pattern: "llama-3.3-70b", total_b: 70 },
    { pattern: "llama-3.1-405b", total_b: 405 },
    { pattern: "llama-3.1-70b", total_b: 70 },
    { pattern: "llama-3.1-8b", total_b: 8 },
    { pattern: "llama-3.2-90b", total_b: 90 },
    { pattern: "llama-3.2-11b", total_b: 11 },
    { pattern: "llama-3.2-3b", total_b: 3 },
    { pattern: "llama-3.2-1b", total_b: 1 },
    // Mistral — Mixtral (MoE)
    { pattern: "mixtral-8x22b", total_b: 141, active_b: 39, num_experts: 8, active_per_token: 2 },
    { pattern: "mixtral-8x7b", total_b: 46.7, active_b: 12.9, num_experts: 8, active_per_token: 2 },
    // Mistral (dense)
    { pattern: "mistral-large", total_b: 123 },
    { pattern: "mistral-medium", total_b: 70 },
    { pattern: "mistral-small", total_b: 22 },
    { pattern: "codestral", total_b: 22 },
    // Qwen (dense)
    { pattern: "qwen2.5-max", total_b: 72 },
    { pattern: "qwen2.5-72b", total_b: 72 },
    { pattern: "qwen2.5-32b", total_b: 32 },
    { pattern: "qwen2.5-14b", total_b: 14 },
    { pattern: "qwen2.5-7b", total_b: 7 },
    // Qwen MoE
    { pattern: "qwen2.5-57b-a14b", total_b: 57, active_b: 14, num_experts: 16, active_per_token: 4 },
    { pattern: "qwen3", total_b: 235, active_b: 22, num_experts: 128, active_per_token: 8 },
    // Qwen QwQ (reasoning, dense)
    { pattern: "qwq-32b", total_b: 32 },
    // DBRX (Databricks, MoE)
    { pattern: "dbrx", total_b: 132, active_b: 36, num_experts: 16, active_per_token: 4 },
    // Snowflake Arctic (MoE)
    { pattern: "arctic", total_b: 480, active_b: 17, num_experts: 128, active_per_token: 2 },
    // AI21 Jamba (MoE)
    { pattern: "jamba-1.5-large", total_b: 398, active_b: 94, num_experts: 8, active_per_token: 2 },
    { pattern: "jamba-1.5-mini", total_b: 52, active_b: 12, num_experts: 8, active_per_token: 2 },
    // Microsoft Phi MoE
    { pattern: "phi-3.5-moe", total_b: 42, active_b: 6.6, num_experts: 16, active_per_token: 2 },
    { pattern: "phi-4", total_b: 14 },
    // Allen AI OLMoE
    { pattern: "olmoe-7b", total_b: 7, active_b: 1, num_experts: 64, active_per_token: 8 },
    // Ornith / OrnithAI
    { pattern: "ornith-122b", total_b: 122, active_b: 10, num_experts: 16, active_per_token: 2 },
    { pattern: "ornith-38b", total_b: 38, active_b: 5.5, num_experts: 8, active_per_token: 2 },
    // xAI
    { pattern: "grok-3", total_b: 314 },
    { pattern: "grok-2", total_b: 314 },
    // Cohere
    { pattern: "command-r-plus", total_b: 104 },
    { pattern: "command-r", total_b: 35 },
  ];

  /** Look up a model in the known-sizes table. */
  function lookupKnownModelSize(modelName: string): (typeof KNOWN_MODEL_SIZES)[number] | null {
    const s = modelName.toLowerCase();
    for (const entry of KNOWN_MODEL_SIZES) {
      if (s.includes(entry.pattern)) return entry;
    }
    return null;
  }

  /**
   * Estimate active parameter count in billions.
   * Priority: user override → known table (active_b or total_b) → regex fallback.
   * Regex now catches "122B A10B" (active hint) and "A10B" alone.
   */
  function estimateParameterCount(modelName: string | null | undefined): number | null {
    if (!modelName) return null;
    const known = lookupKnownModelSize(modelName);
    if (known) return known.active_b ?? known.total_b;

    // Regex fallback
    const s = modelName.toLowerCase();

    // "A10B" — explicit active parameter annotation (common in MoE naming)
    const activeHintMatch = s.match(/\bA(\d+\.?\d*)\s*B\b/i);
    if (activeHintMatch) return Math.round(Number(activeHintMatch[1]) * 10) / 10;

    // "8x22B" MoE pattern
    const moeMatch = s.match(/(\d+)x(\d+\.?\d*)\s*b/i);
    if (moeMatch) {
      const experts = Number(moeMatch[1]);
      const perExpert = Number(moeMatch[2]);
      return Math.round(experts * perExpert * 1.15 * 10) / 10;
    }
    // Plain "7B" style
    const bMatch = s.match(/(\d+\.?\d*)\s*b/i);
    if (bMatch) return Math.round(Number(bMatch[1]) * 10) / 10;
    // "300M" style
    const mMatch = s.match(/(\d+\.?\d*)\s*m\b/i);
    if (mMatch) return Math.round((Number(mMatch[1]) / 1000) * 10) / 10;
    return null;
  }

  /**
   * Estimate total parameter count in billions.
   * Priority: known table (total_b) → regex fallback.
   */
  function estimateTotalParamCount(modelName: string | null | undefined): number | null {
    if (!modelName) return null;
    const known = lookupKnownModelSize(modelName);
    if (known) return known.total_b;
    return estimateParameterCount(modelName);
  }

  /** Estimate quantization bits from a model name string.
   *  When no quant pattern is found, defaults to fp16 for API-hosted
   *  models and q4_k for local models. */
  function estimateQuantization(modelName: string | null | undefined, loc: string | null | undefined): string | null {
    if (modelName) {
      const s = modelName.toLowerCase();
      const qMatch = s.match(/q(\d+)[_\s]*[kK][_\s]*[mMsS]/i);
      if (qMatch) return `q${qMatch[1]}_k`;
      if (s.includes("fp16") || s.includes("f16")) return "fp16";
      if (s.includes("bf16")) return "bf16";
      if (s.includes("fp32") || s.includes("f32")) return "fp32";
      if (s.includes("q8_0")) return "q8_0";
      if (s.includes("q6_k")) return "q6_k";
      if (s.includes("q5_k")) return "q5_k";
      if (s.includes("q4_k")) return "q4_k";
      if (s.includes("q3_k")) return "q3_k";
      if (s.includes("q2_k")) return "q2_k";
    }
    // No name-based match — default by location
    return loc === "local" ? "q4_k" : "fp16";
  }

  /** Quantization → normalized score (fp16=1.0 … q2=0.2). */
  function quantizationScore(q: string | null): number {
    if (!q) return 0.6; // unknown = middle ground
    if (q === "fp32" || q === "fp16" || q === "bf16") return 1.0;
    if (q.startsWith("q8")) return 0.8;
    if (q.startsWith("q6")) return 0.6;
    if (q.startsWith("q5")) return 0.5;
    if (q.startsWith("q4")) return 0.4;
    if (q.startsWith("q3")) return 0.3;
    if (q.startsWith("q2")) return 0.2;
    return 0.6;
  }

  app.post("/api/model-stats", async (req: FastifyRequest) => {
    const body = (req.body ?? {}) as { config_ids?: number[] };
    const configs = listModelConfigs();
    const filtered = body.config_ids
      ? configs.filter((c) => body.config_ids!.includes(c.id))
      : configs;

    const perfStats = getModelPerformanceStats();
    const perfByConfig = new Map<number, { total_runs: number; total_tokens: number; avg_tokens_per_run: number }>();
    for (const ps of perfStats) {
      if (ps.config_id >= 0) {
        perfByConfig.set(ps.config_id, {
          total_runs: ps.total_runs,
          total_tokens: ps.total_tokens,
          avg_tokens_per_run: ps.avg_tokens_per_run,
        });
      }
    }

    const stats = filtered.map((cfg) => {
      let extras: Record<string, unknown> = {};
      try {
        if (cfg.extra_json) extras = JSON.parse(cfg.extra_json) as Record<string, unknown>;
      } catch { /* ignore */ }

      const estimatedParams = estimateParameterCount(cfg.default_model);
      const estimatedTotalParams = estimateTotalParamCount(cfg.default_model);
      const loc = locationLabel(cfg.base_url);
      const estimatedQuant = estimateQuantization(cfg.default_model, loc);
      const userParams = typeof extras.parameter_count_b === "number" ? extras.parameter_count_b : null;
      const userTotalParams = typeof extras.total_parameter_count_b === "number" ? extras.total_parameter_count_b : null;
      const userActiveParams = typeof extras.active_parameter_count_b === "number" ? extras.active_parameter_count_b : null;
      const userQuant = typeof extras.quantization === "string" ? extras.quantization : null;
      const costInput = typeof extras.cost_per_1m_input === "number" ? extras.cost_per_1m_input : null;
      const costOutput = typeof extras.cost_per_1m_output === "number" ? extras.cost_per_1m_output : null;

      // Epoch.ai effective-params formula: for MoE models, the dense
      // equivalent is (num_experts^0.44 / active_per_token^0.63) × total_b.
      // For dense models, effective_params = total_b.
      const knownMoE = lookupKnownModelSize(cfg.default_model ?? "");
      let effectiveParamsB: number | null = null;
      if (knownMoE && knownMoE.num_experts && knownMoE.active_per_token) {
        const factor = Math.pow(knownMoE.num_experts, 0.44) / Math.pow(knownMoE.active_per_token, 0.63);
        effectiveParamsB = Math.round(factor * knownMoE.total_b * 10) / 10;
      } else if (estimatedTotalParams) {
        // Dense model (or MoE without expert info) — effective = total
        effectiveParamsB = Math.round(estimatedTotalParams * 10) / 10;
      }

      const perf = perfByConfig.get(cfg.id);

      return {
        config_id: cfg.id,
        name: cfg.name ?? cfg.key,
        model_id: cfg.default_model,
        context_window: cfg.context_window,
        max_tokens: cfg.max_tokens,
        reasoning: cfg.reasoning === 1,
        thinking_level: cfg.thinking_level,
        thinking_format: cfg.thinking_format,
        text_mode: cfg.text_mode === 1,
        has_api_key: !!(cfg.api_key && cfg.api_key.length),
        has_env_token: !!process.env.ORCHESTRA_TOKENS,
        location: locationLabel(cfg.base_url),
        parameter_count_b: userParams ?? estimatedParams,
        parameter_count_estimated: estimatedParams,
        total_parameter_count_b: userTotalParams ?? estimatedTotalParams ?? estimatedParams,
        active_parameter_count_b: userActiveParams ?? (estimatedTotalParams !== estimatedParams ? estimatedParams : null),
        quantization: userQuant ?? estimatedQuant,
        quantization_estimated: estimatedQuant,
        quantization_score: quantizationScore(userQuant ?? estimatedQuant),
        effective_params_b: effectiveParamsB,
        cost_per_1m_input: costInput,
        cost_per_1m_output: costOutput,
        historical_runs: perf?.total_runs ?? 0,
        historical_total_tokens: perf?.total_tokens ?? 0,
        historical_avg_tokens_per_run: perf?.avg_tokens_per_run ?? 0,
      };
    });

    return { stats };
  });

  // ---- Ping network: SSE stream — sends full list immediately, then updates as each ping returns ----
  app.get("/api/ping-network/stream", async (req: FastifyRequest, reply: FastifyReply) => {
    const configs = listModelConfigs();

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // 1. Immediately send the full list with "checking" status
    send("init", {
      configs: configs.map((cfg) => ({
        config_id: cfg.id,
        name: cfg.name ?? cfg.key,
        base_url: (cfg.base_url ?? "").trim(),
      })),
    });

    // 2. Ping each config and stream results as they complete
    const promises = configs.map(async (cfg) => {
      const baseUrl = (cfg.base_url ?? "").trim();
      if (!baseUrl) {
        send("result", {
          config_id: cfg.id,
          available: false,
          error: "No base URL configured",
        });
        return;
      }
      try {
        const url = baseUrl.replace(/\/+$/, "") + "/models";
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8_000);
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        const apiKey = cfg.api_key?.trim();
        const envKey = envTokenForModel(cfg.name);
        const authKey = apiKey || envKey;
        if (authKey) headers.Authorization = `Bearer ${authKey}`;
        const res = await fetch(url, { headers, signal: controller.signal });
        clearTimeout(timer);
        send("result", {
          config_id: cfg.id,
          available: res.ok,
          error: res.ok ? undefined : `HTTP ${res.status}`,
        });
      } catch (err) {
        send("result", {
          config_id: cfg.id,
          available: false,
          error: (err as Error).message,
        });
      }
    });

    await Promise.all(promises);

    // 3. Stream complete
    send("done", {});
    reply.raw.end();
  });
}
