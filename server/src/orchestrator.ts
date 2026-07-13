/**
 * The Orchestrator: router + gatekeeper + scheduler (§6).
 *
 * A single re-entrant async loop is the daemon heartbeat. Each tick does exactly
 * one unit of work — ingest new intakes, then advance one role step on the
 * least-recently-updated active task — and commits atomically, so the loop is
 * crash-safe and resumes from the DB on restart. SQLite is the work queue; there
 * is no external broker.
 */

import path from "node:path";
import {
  createRoleRun,
  createTask,
  getProject,
  getRole,
  getTask,
  listInterventions,
  listProjects,
  listRoleRuns,
  listTasks,
  listUnconsumedInterventions,
  markInterventionConsumed,
  updateProject,
  updateTask,
  upsertRole,
  type ProjectRow,
  type TaskRow,
} from "./db.js";
import { publish } from "./bus.js";
import {
  appendArtifactSection,
  commitArtifacts,
  moveArtifact,
  planningRoot,
  refineCommitMessage,
  removeFile,
  scaffoldPlanning,
  scanIntake,
  writeArtifact,
} from "./git.js";
import {
  CONCERN_TAXONOMY,
  EXIT_KIND_BY_INTAKE,
  ROUTING_TEMPLATES,
  TERMINAL_ROLE,
  type ExitKind,
  type IntakeKind,
} from "./roles.js";
import { runRole, type CoverageItem, type CoverageStatus } from "./agent.js";
import { getConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Plan representation (stored in tasks.refinement_plan_json)
// ---------------------------------------------------------------------------

interface PlanStep {
  role: string;
  status: "pending" | "done" | "skipped";
  depth: number;
}
interface RefinementPlan {
  steps: PlanStep[];
}

function readPlan(task: TaskRow): RefinementPlan | null {
  if (!task.refinement_plan_json) return null;
  try {
    return JSON.parse(task.refinement_plan_json) as RefinementPlan;
  } catch {
    return null;
  }
}

function planFromTemplate(kind: IntakeKind): RefinementPlan {
  const roles = ROUTING_TEMPLATES[kind] ?? ROUTING_TEMPLATES.manual;
  return { steps: roles.map((role) => ({ role, status: "pending", depth: 1 })) };
}

function nextPending(plan: RefinementPlan): PlanStep | undefined {
  return plan.steps.find((s) => s.status === "pending");
}

// ---------------------------------------------------------------------------
// Coverage rollup
// ---------------------------------------------------------------------------

const STATUS_RANK: Record<CoverageStatus | "never", number> = {
  considered: 3,
  skipped: 2,
  out_of_scope: 1,
  never: 0,
};

export interface CoverageMap {
  [concern: string]: { status: CoverageStatus | "never"; note?: string };
}

function rollupCoverage(taskId: string): CoverageMap {
  const map: CoverageMap = {};
  for (const concern of CONCERN_TAXONOMY) map[concern] = { status: "never" };
  for (const run of listRoleRuns(taskId)) {
    if (!run.coverage_json) continue;
    let items: CoverageItem[] = [];
    try {
      items = JSON.parse(run.coverage_json) as CoverageItem[];
    } catch {
      continue;
    }
    for (const it of items) {
      const key = it.concern.toLowerCase();
      const current = map[key]?.status ?? "never";
      if (STATUS_RANK[it.status] > STATUS_RANK[current]) {
        map[key] = { status: it.status, note: it.note };
      }
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

function inferIntakeKind(fileName: string, content: string): IntakeKind {
  const lower = fileName.toLowerCase();
  const looksLikeTrace =
    /\.log$/.test(lower) ||
    /traceback|exception|stack trace|\bat .+\(.+:\d+\)|Error:/i.test(content);
  if (looksLikeTrace) return "error_file";
  return "manual";
}

function artifactName(task: TaskRow): string {
  const shortId = task.task_id.slice(0, 8);
  const safe = (task.name ?? "task").replace(/[^a-z0-9._-]+/gi, "-").slice(0, 40);
  return `${shortId}-${safe}.md`;
}

/** Scan every project's INTAKE folder and create tasks for new files. */
function ingestProject(project: ProjectRow): number {
  const planningDir = project.planning_dir || "PLANNING";
  scaffoldPlanning(project.repo_path, planningDir);
  const files = scanIntake(project.repo_path, planningDir);
  let created = 0;
  for (const f of files) {
    const kind = inferIntakeKind(f.fileName, f.content);
    const task = createTask({
      name: f.fileName,
      content: f.content,
      project_id: project.id,
      stage: "intake",
      level: "task",
      intake_kind: kind,
      exit_kind: EXIT_KIND_BY_INTAKE[kind],
    });
    // Seed the REFINING artifact and remove the INTAKE original (dedupe = move).
    const artName = artifactName(task);
    const relArtifact = path.join(planningDir, "REFINING", artName);
    const absArtifact = path.join(project.repo_path, relArtifact);
    writeArtifact(
      absArtifact,
      `# ${f.fileName}\n\n> Intake kind: **${kind}** · task \`${task.task_id.slice(0, 8)}\`\n\n## Original intake\n\n\`\`\`\n${f.content.trim()}\n\`\`\`\n`,
    );
    removeFile(f.absPath);
    updateTask(task.task_id, { artifact_path: relArtifact });
    commitArtifacts(
      project.repo_path,
      [relArtifact, path.join(planningDir, "INTAKE")],
      `intake(${kind}): ${f.fileName}`,
    );
    created++;
    publish(task.task_id, "task_update", { stage: "intake" });
  }
  return created;
}

// ---------------------------------------------------------------------------
// Interventions
// ---------------------------------------------------------------------------

interface InterventionPayload {
  role?: string;
  after?: string;
  text?: string;
  project_id?: number;
}

function parsePayload(json: string | null): InterventionPayload {
  if (!json) return {};
  try {
    return JSON.parse(json) as InterventionPayload;
  } catch {
    return {};
  }
}

/** Apply unconsumed interventions to a task's plan/state before its next step. */
function consumeInterventions(task: TaskRow, plan: RefinementPlan): { plan: RefinementPlan; paused: boolean } {
  let paused = (task.paused ?? 0) === 1;
  for (const iv of listUnconsumedInterventions(task.task_id)) {
    const p = parsePayload(iv.payload_json);
    switch (iv.kind) {
      case "pause":
        paused = true;
        updateTask(task.task_id, { paused: 1 });
        break;
      case "resume":
      case "run_now":
        paused = false;
        updateTask(task.task_id, { paused: 0 });
        break;
      case "inject_role":
        if (p.role) {
          const idx = p.after ? plan.steps.findIndex((s) => s.role === p.after) : -1;
          const step: PlanStep = { role: p.role, status: "pending", depth: 1 };
          if (idx >= 0) plan.steps.splice(idx + 1, 0, step);
          else {
            // insert before the terminal role if present, else append
            const termIdx = plan.steps.findIndex((s) => isTerminalRole(task, s.role));
            if (termIdx >= 0) plan.steps.splice(termIdx, 0, step);
            else plan.steps.push(step);
          }
        }
        break;
      case "rerun_role":
      case "deepen":
        if (p.role) {
          const last = [...plan.steps].reverse().find((s) => s.role === p.role);
          if (last) {
            last.status = "pending";
            if (iv.kind === "deepen") last.depth += 1;
          } else {
            plan.steps.push({ role: p.role, status: "pending", depth: iv.kind === "deepen" ? 2 : 1 });
          }
        }
        break;
      case "promote_role":
        if (p.role && task.project_id != null) promoteRole(task, p.role);
        break;
      // steer_note / pin_question influence context (read in buildContext), no plan change
      default:
        break;
    }
    markInterventionConsumed(iv.id);
  }
  updateTask(task.task_id, { refinement_plan_json: JSON.stringify(plan) });
  return { plan, paused };
}

function isTerminalRole(task: TaskRow, role: string): boolean {
  const exitKind = (task.exit_kind as ExitKind) || "spec";
  return role === TERMINAL_ROLE[exitKind];
}

/** Promote an injected one-off role into standing project policy. */
function promoteRole(task: TaskRow, roleKey: string): void {
  if (task.project_id == null) return;
  const global = getRole(null, roleKey);
  if (!global) return;
  // Copy the (possibly project-tuned) definition into a project-scoped row.
  upsertRole({
    project_id: task.project_id,
    key: roleKey,
    title: global.title,
    enabled: true,
    applies_to: global.applies_to,
    ordering: global.ordering,
    system_prompt: global.system_prompt,
    tools_json: global.tools_json,
    model: global.model,
  });
  // Record it in the project's routing config so future tasks of this kind include it.
  const project = getProject(task.project_id);
  if (!project) return;
  let cfg: { promotedRoles?: Record<string, string[]> } = {};
  try {
    cfg = project.config_json ? JSON.parse(project.config_json) : {};
  } catch {
    cfg = {};
  }
  cfg.promotedRoles ??= {};
  const kind = task.intake_kind || "manual";
  cfg.promotedRoles[kind] ??= [];
  if (!cfg.promotedRoles[kind].includes(roleKey)) cfg.promotedRoles[kind].push(roleKey);
  updateProject(project.id, { config_json: JSON.stringify(cfg) });
}

/** Collect steer notes / pinned questions for a task (all, regardless of consumed). */
function steeringNotes(taskId: string): string[] {
  return listInterventions(taskId)
    .filter((iv) => iv.kind === "steer_note" || iv.kind === "pin_question")
    .map((iv) => parsePayload(iv.payload_json).text?.trim())
    .filter((t): t is string => !!t);
}

// ---------------------------------------------------------------------------
// Context building
// ---------------------------------------------------------------------------

function buildRoleContext(task: TaskRow, roleKey: string): string {
  const parts: string[] = [];
  parts.push(`# Task: ${task.name ?? task.task_id}`);
  parts.push(`Intake kind: ${task.intake_kind} · Target exit: ${task.exit_kind}`);
  if (task.content) parts.push(`\n## Original intake\n\n${task.content.trim()}`);

  const priors = listRoleRuns(task.task_id);
  if (priors.length) {
    parts.push(`\n## Findings so far (from earlier roles)`);
    for (const r of priors) {
      parts.push(
        `\n### ${r.role_key} — verdict: ${r.verdict ?? "n/a"}\n${r.summary ?? ""}`.trimEnd(),
      );
    }
  }

  const notes = steeringNotes(task.task_id);
  if (notes.length) {
    parts.push(`\n## Human steering (honor these)`);
    for (const n of notes) parts.push(`- ${n}`);
  }

  parts.push(
    `\n## Your task now\nYou are the **${roleKey}** role. Inspect the repository, do your part, and finish by calling record_findings.`,
  );
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Running one role step
// ---------------------------------------------------------------------------

async function runOneStep(task: TaskRow, project: ProjectRow, step: PlanStep, plan: RefinementPlan): Promise<void> {
  const cfg = getConfig();
  const planningDir = project.planning_dir || "PLANNING";
  const role = getRole(project.id, step.role) ?? getRole(null, step.role);
  if (!role || !role.system_prompt) {
    // Unknown role — skip it so the loop can't wedge.
    step.status = "skipped";
    updateTask(task.task_id, { refinement_plan_json: JSON.stringify(plan) });
    return;
  }

  const tools: string[] = role.tools_json ? (JSON.parse(role.tools_json) as string[]) : [];
  const modelId = role.model || task.model || project.default_model || cfg.defaultModelId;
  const relArtifact = task.artifact_path ?? path.join(planningDir, "REFINING", artifactName(task));
  const absArtifact = path.join(project.repo_path, relArtifact);

  publish(task.task_id, "role_start", { role: step.role, depth: step.depth });

  let result;
  try {
    result = await runRole({
      repoPath: project.repo_path,
      planningDir,
      artifactAbsPath: absArtifact,
      modelId,
      systemPrompt: role.system_prompt,
      tools,
      context: buildRoleContext(task, step.role),
      onEvent: (ev) => publish(task.task_id, ev.type as never, ev),
    });
  } catch (err) {
    // A role failure must not crash the daemon; record it and escalate to review.
    publish(task.task_id, "role_end", { role: step.role, error: true });
    createRoleRun({
      task_id: task.task_id,
      role_key: step.role,
      verdict: "blocker",
      summary: `Role execution failed: ${(err as Error).message}`,
      depth: step.depth,
      model: modelId,
    });
    step.status = "done";
    updateTask(task.task_id, {
      refinement_plan_json: JSON.stringify(plan),
      stage: "review",
      exit_state: "needs_review",
      review_reason: `Role ${step.role} failed: ${(err as Error).message}`,
      status: "failed",
    });
    publish(task.task_id, "task_update", { stage: "review" });
    return;
  }

  const { findings } = result;

  // Persist the run.
  createRoleRun({
    task_id: task.task_id,
    role_key: step.role,
    verdict: findings.verdict,
    summary: findings.summary,
    output_md: findings.section_md,
    coverage_json: JSON.stringify(findings.coverage),
    tool_calls_json: JSON.stringify(result.toolCalls),
    transcript_jsonl: result.transcriptJsonl,
    depth: step.depth,
    model: result.model,
    tokens: result.tokens,
  });

  // Append the section to the artifact + commit.
  appendArtifactSection(absArtifact, findings.section_md);
  commitArtifacts(
    project.repo_path,
    [relArtifact],
    refineCommitMessage(step.role, task.name ?? task.task_id, findings.summary),
  );

  // Roll coverage up.
  const coverage = rollupCoverage(task.task_id);
  step.status = "done";

  publish(task.task_id, "role_end", { role: step.role, verdict: findings.verdict });

  // Gate.
  applyGate(task, project, plan, step, findings.verdict, coverage);
}

function applyGate(
  task: TaskRow,
  project: ProjectRow,
  plan: RefinementPlan,
  step: PlanStep,
  verdict: string,
  coverage: CoverageMap,
): void {
  const planningDir = project.planning_dir || "PLANNING";
  const relArtifact = task.artifact_path ?? path.join(planningDir, "REFINING", artifactName(task));
  const coverageJson = JSON.stringify(coverage);

  const escalate = (reason: string) => {
    const dest = relArtifact.replace(`${path.sep}REFINING${path.sep}`, `${path.sep}REVIEW${path.sep}`);
    moveArtifact(path.join(project.repo_path, relArtifact), path.join(project.repo_path, dest));
    updateTask(task.task_id, {
      refinement_plan_json: JSON.stringify(plan),
      coverage_json: coverageJson,
      stage: "review",
      exit_state: "needs_review",
      review_reason: reason,
      artifact_path: dest,
      status: "complete",
    });
    commitArtifacts(project.repo_path, [relArtifact, dest], `review: ${task.name ?? task.task_id}`);
    publish(task.task_id, "task_update", { stage: "review" });
  };

  if (verdict === "needs_human") {
    escalate(`Role ${step.role} flagged an ambiguity requiring human judgement.`);
    return;
  }
  if (verdict === "blocker") {
    escalate(`Role ${step.role} reported a blocker.`);
    return;
  }

  // Terminal role finished cleanly → ready.
  if (isTerminalRole(task, step.role) || !nextPending(plan)) {
    const dest = relArtifact.replace(`${path.sep}REFINING${path.sep}`, `${path.sep}READY${path.sep}`);
    moveArtifact(path.join(project.repo_path, relArtifact), path.join(project.repo_path, dest));
    updateTask(task.task_id, {
      refinement_plan_json: JSON.stringify(plan),
      coverage_json: coverageJson,
      stage: "ready",
      exit_state: "ready_for_work",
      artifact_path: dest,
      status: "complete",
    });
    commitArtifacts(project.repo_path, [relArtifact, dest], `ready: ${task.name ?? task.task_id}`);
    if (isTerminalRole(task, step.role) && (task.exit_kind as ExitKind) === "spec") {
      createDecompositionChildren(task);
    }
    publish(task.task_id, "task_update", { stage: "ready" });
    return;
  }

  // Otherwise keep refining.
  updateTask(task.task_id, {
    refinement_plan_json: JSON.stringify(plan),
    coverage_json: coverageJson,
    stage: "refining",
  });
  publish(task.task_id, "task_update", { stage: "refining" });
}

/** Parse the decomposition role's section for [epic]/[story]/[task] and create child tasks. */
function createDecompositionChildren(task: TaskRow): void {
  const runs = listRoleRuns(task.task_id);
  const decomp = [...runs].reverse().find((r) => r.role_key === "decomposition");
  if (!decomp?.output_md) return;
  const re = /\[(epic|story|task)\]\s*(.+)/gi;
  let m: RegExpExecArray | null;
  let step = 0;
  while ((m = re.exec(decomp.output_md)) !== null) {
    const level = m[1]!.toLowerCase();
    const name = m[2]!.trim().slice(0, 120);
    createTask({
      name,
      content: null,
      project_id: task.project_id,
      stage: "ready",
      level,
      intake_kind: task.intake_kind ?? "manual",
      exit_kind: task.exit_kind ?? "spec",
      parent_task_id: task.task_id,
      task_type: "child",
      step_number: step++,
      status: "complete",
    });
  }
}

// ---------------------------------------------------------------------------
// Tick + scheduler
// ---------------------------------------------------------------------------

/** Pick the least-recently-updated active task that has work to do. */
function pickNextTask(): { task: TaskRow; project: ProjectRow } | undefined {
  for (const project of listProjects()) {
    const candidates = listTasks({ projectId: project.id })
      .filter((t) => (t.stage === "intake" || t.stage === "refining") && (t.paused ?? 0) === 0)
      .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
    if (candidates.length) return { task: candidates[0]!, project };
  }
  return undefined;
}

/**
 * Serialize every tick — the scheduler loop AND manual /api/tick calls funnel
 * through one chain so no two role steps ever run concurrently (single-worker
 * sequential semantics, regardless of caller).
 */
let tickChain: Promise<void> = Promise.resolve();

export function tick(): Promise<boolean> {
  let result = false;
  const run = tickChain.then(async () => {
    result = await tickOnce();
  });
  tickChain = run.catch(() => {});
  return run.then(() => result);
}

/** Do one unit of work. Returns true if work was performed (caller loops fast). */
async function tickOnce(): Promise<boolean> {
  // 1. Ingest new intake files.
  let ingested = 0;
  for (const project of listProjects()) ingested += ingestProject(project);

  // 2. Advance one role step on the next active task.
  const next = pickNextTask();
  if (!next) return ingested > 0;

  let { task } = next;
  const { project } = next;

  // Ensure a plan; intake → refining on first plan.
  let plan = readPlan(task);
  if (!plan) {
    plan = planFromTemplate((task.intake_kind as IntakeKind) || "manual");
    // Fold any promoted project roles for this kind into the plan.
    plan = withPromotedRoles(project, task, plan);
    updateTask(task.task_id, { refinement_plan_json: JSON.stringify(plan), stage: "refining" });
    task = getTask(task.task_id)!;
    publish(task.task_id, "task_update", { stage: "refining" });
  }

  // Consume interventions (may pause / mutate plan).
  const consumed = consumeInterventions(task, plan);
  plan = consumed.plan;
  if (consumed.paused) return true;
  task = getTask(task.task_id)!;

  const step = nextPending(plan);
  if (!step) {
    // No pending steps but not terminal — finalize as ready to avoid wedging.
    applyGate(task, project, plan, { role: "", status: "done", depth: 1 }, "pass", rollupCoverage(task.task_id));
    return true;
  }

  await runOneStep(task, project, step, plan);
  return true;
}

/** Fold promoted project roles into a fresh plan (before the terminal role). */
function withPromotedRoles(project: ProjectRow, task: TaskRow, plan: RefinementPlan): RefinementPlan {
  if (!project.config_json) return plan;
  let cfg: { promotedRoles?: Record<string, string[]> } = {};
  try {
    cfg = JSON.parse(project.config_json);
  } catch {
    return plan;
  }
  const kind = task.intake_kind || "manual";
  const promoted = cfg.promotedRoles?.[kind] ?? [];
  for (const role of promoted) {
    if (plan.steps.some((s) => s.role === role)) continue;
    const termIdx = plan.steps.findIndex((s) => isTerminalRole(task, s.role));
    const step: PlanStep = { role, status: "pending", depth: 1 };
    if (termIdx >= 0) plan.steps.splice(termIdx, 0, step);
    else plan.steps.push(step);
  }
  return plan;
}

let stopped = true;
let loopHandle: Promise<void> | undefined;

/** Start the daemon heartbeat. Idempotent. tick() is self-serializing. */
export function startScheduler(): void {
  if (!stopped) return;
  stopped = false;
  const cfg = getConfig();
  loopHandle = (async () => {
    while (!stopped) {
      let didWork = false;
      try {
        didWork = await tick();
      } catch (err) {
        console.error(`[orchestrator] tick error: ${(err as Error).message}`);
      }
      await sleep(didWork ? 50 : cfg.schedulerIdleMs);
    }
  })();
  console.log("[orchestrator] scheduler started");
}

export async function stopScheduler(): Promise<void> {
  stopped = true;
  await loopHandle;
  console.log("[orchestrator] scheduler stopped");
}

export function isSchedulerRunning(): boolean {
  return !stopped;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
