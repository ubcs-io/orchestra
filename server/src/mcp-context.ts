/**
 * Pure, DB/fs-backed assembly of "role context" for a task — the read half of
 * PLANNING/overhaul/09's portable role contract. No MCP SDK import here: this
 * module is testable directly and reused as-is by mcp-server.ts's tool
 * handlers, mirroring how routes/api.ts's `taskDetail` composes existing
 * accessors rather than duplicating their logic.
 */

import path from "node:path";
import type { OpenQuestion } from "./agent.js";
import { getProject, getRole, getTask, listRoleRuns, type RoleRunRow } from "./db.js";
import { readArtifact } from "./git.js";
import {
  buildEdgeContext,
  nextPending,
  nextStep,
  parseOpenQuestions,
  readPlan,
  rollupCoverage,
  type CoverageMap,
} from "./orchestrator.js";
import { CONCERN_TAXONOMY } from "./roles.js";

export interface TaskContextResult {
  task: {
    taskId: string;
    id: number;
    name: string | null;
    status: string;
    stage: string | null;
    projectId: number | null;
  };
  /** The role that would run next if the scheduler dispatched this task right
   *  now — resolved with the exact same functions the real dispatcher uses
   *  (nextPending/nextStep/buildEdgeContext), so this never drifts from what
   *  actually happens. `null` for a terminal task or one with no plan yet. */
  pendingRole: { key: string; title: string | null; prompt: string | null } | null;
  acceptanceCriteria: string[];
  artifact: { path: string | null; content: string };
  coverage: CoverageMap;
  concernTaxonomy: readonly string[];
  openQuestions: Array<OpenQuestion & { roleKey: string }>;
}

function parseAcceptanceCriteria(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === "string") : [];
  } catch {
    return [];
  }
}

function resolvePendingRole(
  taskId: string,
  projectId: number | null,
  runs: RoleRunRow[],
): { key: string; title: string | null; prompt: string | null } | null {
  const task = getTask(taskId);
  const plan = task ? readPlan(task) : null;
  if (!plan) return null;

  const lastRun = runs.length ? runs[runs.length - 1] : undefined;
  const context = lastRun ? buildEdgeContext(lastRun, taskId) : undefined;
  const step = lastRun ? nextStep(plan, lastRun.role_key, context) : nextPending(plan);
  if (!step) return null;

  const role = getRole(projectId, step.role);
  return { key: step.role, title: role?.title ?? null, prompt: role?.system_prompt ?? null };
}

/** Fetch the full role-execution context for a task: everything an external
 *  agent needs to pick up where Orchestra's own role pipeline would continue —
 *  without granting it write access to anything yet (PLANNING/overhaul/09). */
export function getTaskContext(taskId: string): TaskContextResult | null {
  const task = getTask(taskId);
  if (!task) return null;

  const project = task.project_id != null ? getProject(task.project_id) : undefined;
  const runs = listRoleRuns(task.task_id);

  const artifactAbsPath =
    task.artifact_path != null
      ? path.join(task.git_worktree_path ?? project?.repo_path ?? "", task.artifact_path)
      : null;

  // Always freshly rolled up (never stale, never null) — same source of
  // truth buildEdgeContext uses for routing, not the persisted snapshot.
  const coverage = rollupCoverage(task.task_id);

  const openQuestions = runs.flatMap((run) =>
    parseOpenQuestions(run.open_questions_json).map((q) => ({ ...q, roleKey: run.role_key })),
  );

  return {
    task: {
      taskId: task.task_id,
      id: task.id,
      name: task.name,
      status: task.status,
      stage: task.stage,
      projectId: task.project_id,
    },
    pendingRole: resolvePendingRole(task.task_id, task.project_id, runs),
    acceptanceCriteria: parseAcceptanceCriteria(task.acceptance_criteria),
    artifact: {
      path: task.artifact_path,
      content: artifactAbsPath ? readArtifact(artifactAbsPath) : "",
    },
    coverage,
    concernTaxonomy: CONCERN_TAXONOMY,
    openQuestions,
  };
}
