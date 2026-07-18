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
  createIntervention,
  createRoleRun,
  createTask,
  deleteRoleRunsAfter,
  deleteUnconsumedInterventionsAfter,
  getNetwork,
  getProject,
  getRole,
  getRoleRun,
  getTask,
  listInterventions,
  listProjects,
  listRoleRuns,
  listTasks,
  listUnconsumedInterventions,
  markInterventionConsumed,
  setRoleRunCommitSha,
  setRoleRunOpenQuestions,
  updateProject,
  updateTask,
  upsertRole,
  type ProjectRow,
  type RoleRunRow,
  type TaskRow,
} from "./db.js";
import { publish } from "./bus.js";
import {
  appendArtifactSection,
  checkoutBranch,
  commitArtifacts,
  currentBranch,
  ensureWorktree,
  headSha,
  moveArtifact,
  planningRoot,
  reconcileBranch,
  refineCommitMessage,
  removeFile,
  resetHardTo,
  sanitizePath,
  scaffoldPlanning,
  scanIntake,
  worktreePath,
  writeArtifact,
} from "./git.js";
import {
  CONCERN_TAXONOMY,
  EXIT_KIND_BY_INTAKE,
  flowForIntake,
  isCritiqueExempt,
  TERMINAL_ROLE,
  type ExitKind,
  type FlowTemplate,
  type IntakeKind,
  type ReviewDepth,
} from "./roles.js";
import {
  runRole as defaultRunRole,
  type CoverageItem,
  type CoverageStatus,
  type CriteriaResult,
  type OpenQuestion,
  type RoleFindings,
  type RoleRunResult,
  type RunRoleParams,
  type Verdict,
} from "./agent.js";
import { getConfig } from "./config.js";
import { resolveConnectionForModel } from "./settings.js";
import { resolveHarnessPolicy } from "./harness-policy.js";
import {
  resolveRouterConfig,
  distillQuestions,
  assessEscalation,
  assessBorderline,
  assessSecondReview,
  assessAnswerMatch,
  type RouterConfig,
  type SecondReviewResult,
} from "./router.js";

// ---------------------------------------------------------------------------
// Role runner seam — injectable so the loop can be tested without a live LLM.
// ---------------------------------------------------------------------------

export type RoleRunner = (params: RunRoleParams) => Promise<RoleRunResult>;
let roleRunner: RoleRunner = defaultRunRole;

/** Override the role runner (tests inject a deterministic fake). */
export function setRoleRunner(fn: RoleRunner): void {
  roleRunner = fn;
}
/** Restore the real pi-backed runner. */
export function resetRoleRunner(): void {
  roleRunner = defaultRunRole;
}

// ---------------------------------------------------------------------------
// Plan representation (stored in tasks.refinement_plan_json)
// ---------------------------------------------------------------------------

export interface PlanStep {
  role: string;
  status: "pending" | "done" | "skipped";
  depth: number;
  /** Loop-back attempts spent on this step (reviewer steps only). */
  attempts?: number;
}

export interface NetworkEdgeCondition {
  type: "verdict" | "always" | "coverage" | "criteria";
  value?: string;
  operator?: "eq" | "neq" | "any_unmet" | "any_missing";
}

export interface NetworkEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  label?: string;
  condition?: NetworkEdgeCondition;
}

export interface RefinementPlan {
  steps: PlanStep[];
  /** If set, edge routing is enabled and edges are read from this network. */
  networkId?: string;
  /** Cached at plan-creation time: roleKey → nodeId. */
  nodeIdByRole?: Record<string, string>;
  /** Cached at plan-creation time: nodeIds in graph order. */
  nodeIds?: string[];
}

/** Context assembled after a role step completes, used to evaluate edge conditions. */
export interface EdgeEvaluationContext {
  verdict: string;
  coverage: CoverageMap;
  criteriaResults: CriteriaResult[];
}

/** Resolve the flow template for a task from its intake kind.
 *  If the task has a custom network_id, resolve criteria, reviewer, rigor,
 *  mandatoryConcerns, and maxLoopbacks from the stored graph. */
function flowForTask(task: TaskRow): FlowTemplate {
  const base = flowForIntake((task.intake_kind as IntakeKind) || "manual");
  if (!task.network_id) return base;

  const network = getNetwork(task.network_id);
  if (!network) return base;

  try {
    const graph = JSON.parse(network.graph_json) as {
      metadata?: {
        rigor?: "low" | "standard" | "high";
        maxLoopbacks?: number;
        mandatoryConcerns?: string[];
        reviewerRole?: string;
        reviewDepth?: ReviewDepth;
      };
      nodes?: Array<{
        roleKey: string;
        criteria?: Array<{ id: string; text: string; severity: string; concern?: string }>;
      }>;
    };

    const meta = graph.metadata ?? {};

    // Merge criteria: graph criteria attached to nodes become criterion with
    // ownerRole = node's roleKey, severity from criterion if present, "must" default.
    const graphCriteria: typeof base.criteria = [];
    for (const node of graph.nodes ?? []) {
      for (const c of node.criteria ?? []) {
        graphCriteria.push({
          id: c.id,
          text: c.text,
          ownerRole: node.roleKey,
          severity: (c.severity as "must" | "should") || "must",
          concern: c.concern,
        });
      }
    }

    return {
      key: base.key,
      rigor: meta.rigor ?? base.rigor,
      steps: graph.nodes?.map((n) => n.roleKey) ?? base.steps,
      reviewerRole: meta.reviewerRole ?? base.reviewerRole,
      criteria: graphCriteria.length > 0 ? graphCriteria : base.criteria,
      mandatoryConcerns: meta.mandatoryConcerns ?? base.mandatoryConcerns,
      maxLoopbacks: meta.maxLoopbacks ?? base.maxLoopbacks,
      reviewDepth: meta.reviewDepth ?? base.reviewDepth,
    };
  } catch {
    return base;
  }
}

function readPlan(task: TaskRow): RefinementPlan | null {
  if (!task.refinement_plan_json) return null;
  try {
    return JSON.parse(task.refinement_plan_json) as RefinementPlan;
  } catch {
    return null;
  }
}

export function planFromTemplate(kind: IntakeKind, networkId?: string | null): RefinementPlan {
  // If a custom network is set, resolve steps from its graph nodes in order
  // and cache edge routing data (nodeIdByRole, nodeIds, networkId).
  if (networkId) {
    const network = getNetwork(networkId);
    if (network) {
      try {
        const graph = JSON.parse(network.graph_json) as {
          nodes?: Array<{ id: string; roleKey: string; overrides?: { depth?: number } }>;
        };
        if (graph.nodes?.length) {
          const nodeIdByRole: Record<string, string> = {};
          for (const node of graph.nodes) {
            nodeIdByRole[node.roleKey] = node.id;
          }
          return {
            steps: graph.nodes.map((n) => ({
              role: n.roleKey,
              status: "pending" as const,
              depth: n.overrides?.depth ?? 1,
            })),
            networkId,
            nodeIdByRole,
            nodeIds: graph.nodes.map((n) => n.id),
          };
        }
      } catch {
        // Fall through to built-in template.
      }
    }
  }
  const roles = flowForIntake(kind).steps;
  return { steps: roles.map((role) => ({ role, status: "pending", depth: 1 })) };
}

export function nextPending(plan: RefinementPlan): PlanStep | undefined {
  return plan.steps.find((s) => s.status === "pending");
}

// ---------------------------------------------------------------------------
// Edge-aware routing engine
// ---------------------------------------------------------------------------

/**
 * Evaluate a single edge condition against the context produced by the last
 * completed role run.
 */
export function evaluateEdgeCondition(
  condition: NetworkEdgeCondition | undefined,
  context: EdgeEvaluationContext,
): boolean {
  if (!condition || condition.type === "always") return true;

  switch (condition.type) {
    case "verdict": {
      const op = condition.operator ?? "eq";
      if (op === "eq") return context.verdict === condition.value;
      if (op === "neq") return context.verdict !== condition.value;
      return false;
    }

    case "coverage": {
      const op = condition.operator ?? "any_unmet";
      const concern = condition.value;
      if (op === "any_unmet") {
        if (concern) return (context.coverage[concern]?.status ?? "never") !== "considered";
        return Object.values(context.coverage).some((c) => c.status !== "considered");
      }
      if (op === "any_missing") {
        if (concern) {
          const s = context.coverage[concern]?.status ?? "never";
          return s === "never" || s === "out_of_scope";
        }
        return Object.values(context.coverage).some(
          (c) => c.status === "never" || c.status === "out_of_scope",
        );
      }
      return false;
    }

    case "criteria": {
      const op = condition.operator ?? "any_unmet";
      if (op === "any_unmet") {
        if (condition.value) {
          return context.criteriaResults.some(
            (c) => c.id === condition.value && c.status !== "met",
          );
        }
        return context.criteriaResults.some((c) => c.status !== "met");
      }
      return false;
    }

    default:
      return false;
  }
}

/** Load edges from the network stored in the plan, falling back to the DB. */
function loadEdges(plan: RefinementPlan): NetworkEdge[] {
  // The plan stores a networkId reference; read edges from the network.
  if (!plan.networkId) return [];
  const network = getNetwork(plan.networkId);
  if (!network) return [];
  try {
    const graph = JSON.parse(network.graph_json) as { edges?: NetworkEdge[] };
    return graph.edges ?? [];
  } catch {
    return [];
  }
}

/**
 * Build an EdgeEvaluationContext from the most recent completed role run
 * and the rolled-up task coverage.
 */
function buildEdgeContext(lastRun: RoleRunRow, taskId: string): EdgeEvaluationContext {
  const coverage = rollupCoverage(taskId);
  let criteriaResults: CriteriaResult[] = [];
  if (lastRun.criteria_results_json) {
    try {
      criteriaResults = JSON.parse(lastRun.criteria_results_json) as CriteriaResult[];
    } catch {
      /* ignore */
    }
  }
  return {
    verdict: lastRun.verdict ?? "pass",
    coverage,
    criteriaResults,
  };
}

/**
 * Determine the next step after a role completes, using edge conditions if
 * the plan has network routing data. Falls back to linear order when:
 * - No network routing data exists on the plan
 * - No context is available (first step of a task)
 * - No outgoing edges match their conditions
 */
export function nextStep(
  plan: RefinementPlan,
  lastCompletedRole: string,
  context?: EdgeEvaluationContext,
): PlanStep | undefined {
  // If no graph routing info or no context, use linear fallback
  if (!plan.nodeIdByRole || !plan.nodeIds || !context) {
    return plan.steps.find((s) => s.status === "pending");
  }

  const currentNodeId = plan.nodeIdByRole[lastCompletedRole];
  if (!currentNodeId) {
    // Role not found in graph — linear fallback
    return plan.steps.find((s) => s.status === "pending");
  }

  // Get outgoing edges from the completed node
  const edges = loadEdges(plan);
  const outgoing = edges.filter((e) => e.sourceNodeId === currentNodeId);

  if (outgoing.length > 0) {
    // Evaluate conditions in edge array order — first match wins
    for (const edge of outgoing) {
      if (evaluateEdgeCondition(edge.condition, context)) {
        // Find the target node's role key and return its pending step
        const targetRole = Object.entries(plan.nodeIdByRole).find(
          ([, id]) => id === edge.targetNodeId,
        )?.[0];
        if (targetRole) {
          const targetStep = plan.steps.find(
            (s) => s.role === targetRole && s.status === "pending",
          );
          if (targetStep) return targetStep;
        }
      }
    }
    // No edge matched — fall through to linear fallback
  }

  // Linear fallback: next pending step after current role in nodeIds order
  const currentIndex = plan.nodeIds.indexOf(currentNodeId);
  for (let i = currentIndex + 1; i < plan.nodeIds.length; i++) {
    const nodeId = plan.nodeIds[i]!;
    const roleKey = Object.entries(plan.nodeIdByRole).find(([, id]) => id === nodeId)?.[0];
    if (roleKey) {
      const step = plan.steps.find((s) => s.role === roleKey && s.status === "pending");
      if (step) return step;
    }
  }

  return undefined; // No pending steps — plan complete
}

/** Pure plan mutation for inject/rerun/deepen interventions (no DB). */
export function applyPlanMutation(
  plan: RefinementPlan,
  kind: string,
  payload: { role?: string; after?: string },
  isTerminal: (role: string) => boolean,
): RefinementPlan {
  const role = payload.role;
  if (!role) return plan;
  if (kind === "inject_role") {
    const idx = payload.after ? plan.steps.findIndex((s) => s.role === payload.after) : -1;
    const step: PlanStep = { role, status: "pending", depth: 1 };
    if (idx >= 0) {
      plan.steps.splice(idx + 1, 0, step);
    } else {
      const termIdx = plan.steps.findIndex((s) => isTerminal(s.role));
      if (termIdx >= 0) plan.steps.splice(termIdx, 0, step);
      else plan.steps.push(step);
    }
  } else if (kind === "deepen") {
    const last = [...plan.steps].reverse().find((s) => s.role === role);
    if (last) {
      last.status = "pending";
      if (kind === "deepen") last.depth += 1;
    } else {
      plan.steps.push({ role, status: "pending", depth: kind === "deepen" ? 2 : 1 });
    }
  }
  return plan;
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

/** Pure coverage merge with precedence considered > skipped > out_of_scope > never. */
export function mergeCoverageItems(itemsPerRun: CoverageItem[][]): CoverageMap {
  const map: CoverageMap = {};
  for (const concern of CONCERN_TAXONOMY) map[concern] = { status: "never" };
  for (const items of itemsPerRun) {
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

function rollupCoverage(taskId: string): CoverageMap {
  const itemsPerRun: CoverageItem[][] = [];
  for (const run of listRoleRuns(taskId)) {
    if (!run.coverage_json) continue;
    try {
      itemsPerRun.push(JSON.parse(run.coverage_json) as CoverageItem[]);
    } catch {
      /* skip malformed */
    }
  }
  return mergeCoverageItems(itemsPerRun);
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

export function inferIntakeKind(fileName: string, content: string): IntakeKind {
  const lower = fileName.toLowerCase();
  const looksSecurity =
    /(^|[^a-z])security([^a-z]|$)/i.test(lower) ||
    /\b(vulnerabilit(y|ies)|CVE-\d{4}|exploit|XSS|CSRF|SSRF|\bRCE\b|SQL injection|auth(entication|orization)? bypass|security advisory)\b/i.test(
      content,
    );
  if (looksSecurity) return "security";
  const looksLikeTrace =
    /\.log$/.test(lower) ||
    /traceback|exception|stack trace|\bat .+\(.+:\d+\)|Error:/i.test(content);
  if (looksLikeTrace) return "error_file";
  return "manual";
}

export function artifactName(task: TaskRow): string {
  const shortId = task.task_id.slice(0, 8);
  const safe = (task.name ?? "task").replace(/[^a-z0-9._-]+/gi, "-").slice(0, 40);
  const base = safe.replace(/\.md$/i, "");
  return `${base}-${shortId}.md`;
}

/** Derive this task's dedicated checkpoint branch name (stable, content-free). */
function taskBranchName(task: TaskRow): string {
  const slug = (task.name ?? "task")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `orchestra/${slug || "task"}-${task.task_id.slice(0, 8)}`;
}

/**
 * Create (once) this task's dedicated git worktree — its own working
 * directory, checked out onto its own branch off the project's base branch
 * (captured lazily from whatever's checked out in `project.repo_path` the
 * first time any task in the project needs one). Idempotent: once
 * `git_worktree_path` is set, `ensureWorktree` just re-asserts the worktree
 * still exists (recreating it if a reset/cleanup removed it, reusing the
 * same branch) rather than doing anything expensive.
 *
 * Unlike the old shared-checkout scheme, this does NOT swallow failures —
 * a worktree is a precondition for the task to do any work at all, so a
 * failure here must block the task's step rather than silently falling back
 * to a shared checkout, which would reintroduce the cross-task races
 * per-task worktrees exist to remove.
 */
export function ensureTaskWorkspace(task: TaskRow, project: ProjectRow): TaskRow {
  let baseBranch = task.git_base_branch ?? project.main_branch;
  if (!baseBranch) {
    baseBranch = currentBranch(project.repo_path);
    updateProject(project.id, { main_branch: baseBranch });
  }
  const branch = task.git_branch ?? taskBranchName(task);
  const dir = worktreePath(project.repo_path, task.task_id);
  ensureWorktree(project.repo_path, dir, branch, baseBranch);
  if (task.git_worktree_path === dir && task.git_branch === branch && task.git_base_branch === baseBranch) {
    return task;
  }
  return (
    updateTask(task.task_id, { git_worktree_path: dir, git_branch: branch, git_base_branch: baseBranch }) ?? task
  );
}

/** Where this task's own git/filesystem operations should run: its dedicated
 *  worktree once `ensureTaskWorkspace` has created one, else the project's
 *  shared checkout (covers tasks that predate this feature). */
export function taskRepoPath(task: TaskRow, project: ProjectRow): string {
  return task.git_worktree_path ?? project.repo_path;
}

/** Scan every project's INTAKE folder and create tasks for new files. */
function ingestProject(project: ProjectRow): number {
  const planningDir = project.planning_dir || "PLANNING";
  scaffoldPlanning(project.repo_path, planningDir);
  const files = scanIntake(project.repo_path, planningDir);
  let created = 0;
  for (const f of files) {
    const kind = inferIntakeKind(f.fileName, f.content);
    let task = createTask({
      name: f.fileName,
      content: f.content,
      project_id: project.id,
      stage: "intake",
      level: "task",
      intake_kind: kind,
      exit_kind: EXIT_KIND_BY_INTAKE[kind],
    });
    // Consume the INTAKE original on the shared checkout first — before this
    // task's own worktree branches off it — so the file can never be
    // re-scanned into a duplicate task, and no task branch needs to carry a
    // copy of the removal itself.
    removeFile(f.absPath);
    commitArtifacts(project.repo_path, [path.join(planningDir, "INTAKE")], `intake(${kind}): consumed ${f.fileName}`);

    // Give the task its own worktree (off the now-updated base), then seed
    // the REFINING artifact there.
    task = ensureTaskWorkspace(task, project);
    const artName = artifactName(task);
    const relArtifact = path.join(planningDir, "REFINING", artName);
    const taskRepo = taskRepoPath(task, project);
    writeArtifact(
      path.join(taskRepo, relArtifact),
      `# ${f.fileName}\n\n> Intake kind: **${kind}** · task \`${task.task_id.slice(0, 8)}\`\n\n## Original intake\n\n\`\`\`\n${f.content.trim()}\n\`\`\`\n`,
    );
    updateTask(task.task_id, { artifact_path: relArtifact });
    commitArtifacts(taskRepo, [relArtifact], `intake(${kind}): ${f.fileName}`);
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
      case "deepen":
        applyPlanMutation(plan, iv.kind, p, (r) => isTerminalRole(task, r));
        break;
      case "promote_role":
        if (p.role && task.project_id != null) promoteRole(task, p.role);
        break;
      case "wont_do":
        updateTask(task.task_id, { stage: "ready", exit_state: "wont_do", paused: 1 });
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

/** Collect answered questions for a task. Returns pairs of { question, answer }. */
function answeredQuestions(taskId: string): Array<{ question: string; answer: string }> {
  return listInterventions(taskId)
    .filter((iv) => iv.kind === "question_answer")
    .map((iv) => {
      const p = parsePayload(iv.payload_json) as { question?: string; answer?: string };
      return { question: p.question?.trim() ?? "", answer: p.answer?.trim() ?? "" };
    })
    .filter((qa) => qa.question && qa.answer);
}

/** Parse a role_run's open_questions_json, tolerating the legacy plain-string
 *  form stored before questions carried a guess/confidence/resolution. */
function parseOpenQuestions(json: string | null): OpenQuestion[] {
  if (!json) return [];
  try {
    const raw = JSON.parse(json) as unknown[];
    if (!Array.isArray(raw)) return [];
    return raw.map((q): OpenQuestion =>
      typeof q === "string"
        ? { question: q, assumed_answer: "", confidence: "low", resolved: "assumed" }
        : (q as OpenQuestion),
    );
  } catch {
    return [];
  }
}

/** Resolve router config for a project, returning null if the router is disabled. */
function getRouterCfg(project: ProjectRow): RouterConfig | null {
  const cfg = resolveRouterConfig(project.config_json);
  return cfg.enabled ? cfg : null;
}

// ---------------------------------------------------------------------------
// Context building
// ---------------------------------------------------------------------------

function buildRoleContext(task: TaskRow, roleKey: string, twoPhase = false, textMode = false): string {
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

  // Resolved questions from human answers.
  const answers = answeredQuestions(task.task_id);
  if (answers.length) {
    parts.push(`\n## Questions resolved by human`);
    for (const qa of answers) {
      parts.push(`- Q: ${qa.question}\n  A: ${qa.answer}`);
    }
  }

  // Counter-reviewer: hand it the acceptance checklist it must verify.
  const flow = flowForTask(task);
  if (roleKey === flow.reviewerRole && flow.criteria.length) {
    parts.push(
      `\n## Acceptance criteria to verify\nVerify each criterion against the findings above and the real code, then return one \`criteria_results\` entry per id (status met/partial/unmet). Set verdict "needs_more" if any **must** criterion is not fully met.`,
    );
    for (const c of flow.criteria) {
      parts.push(`- [${c.severity}] \`${c.id}\` — ${c.text}`);
    }
    if (flow.mandatoryConcerns.length) {
      parts.push(`\nThese concerns MUST be covered before this is ready: ${flow.mandatoryConcerns.join(", ")}.`);
    }
  }

  if (twoPhase) {
    parts.push(
      `\n## Your task now\nYou are the **${roleKey}** role. Inspect the repository, do your part, then ` +
        `write a concise natural-language summary of your findings. Do not look for a "record_findings" ` +
        `tool — just write your summary as plain text. You will be asked to formalize it as structured ` +
        `JSON in the next step.`,
    );
  } else if (textMode) {
    parts.push(
      `\n## Your task now\nYou are the **${roleKey}** role. Inspect the repository, do your part, then ` +
        `output your findings as a single \`\`\`json code block at the end of your response. You do NOT ` +
        `have a \`record_findings\` tool — do not try to call it. Instead, use this exact JSON format:\n` +
        `\`\`\`\n{"verdict": "pass", "summary": "...", "open_questions": [], "coverage": [...], ` +
        `"section_md": "## My Role\\n\\n..."}\n\`\`\`\n` +
        `See the system prompt for the full schema. Output ONLY the JSON block — nothing after the closing \`\`\`.`,
    );
  } else {
    parts.push(
      `\n## Your task now\nYou are the **${roleKey}** role. Inspect the repository, do your part, then finish ` +
        `by invoking \`record_findings\` directly as a tool call. Do not describe or announce the call in ` +
        `plain text first — make the function call directly.`,
    );
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Call Point 1: Question Distillation (fire-and-forget after role run)
// ---------------------------------------------------------------------------

/**
 * If the router is enabled and questionDistillation is on, run an async
 * distillation pass over the role's open_questions. Fire-and-forget — does
 * not block the tick. On completion, updates the stored open_questions_json.
 */
function maybeDistillQuestions(
  task: TaskRow,
  project: ProjectRow,
  runId: number,
  rawQuestions: OpenQuestion[],
  routerCfg: RouterConfig,
): void {
  if (!rawQuestions.length) return;

  const priorQA = answeredQuestions(task.task_id).map((qa) => ({
    question: qa.question,
    answer: qa.answer,
  }));

  // Also include unanswered prior questions
  const allPrior: Array<{ question: string; answer: string | null }> = [...priorQA];
  for (const run of listRoleRuns(task.task_id)) {
    if (run.id === runId) continue; // skip the run we just created
    for (const q of parseOpenQuestions(run.open_questions_json)) {
      if (!allPrior.some((p) => p.question === q.question)) {
        allPrior.push({ question: q.question, answer: null });
      }
    }
  }

  const { modelId } = resolveConnectionForModel(
    task.model || project.default_model || null,
    project.id,
  );

  // Fire-and-forget — do not await
  distillQuestions(
    {
      taskName: task.name ?? task.task_id.slice(0, 8),
      intakeKind: task.intake_kind ?? "manual",
      roleKey: "", // filled from the run that was just created
      rawQuestions: rawQuestions.map((q) => q.question),
      priorQuestions: allPrior.slice(0, 50), // cap at 50 prior questions
    },
    roleRunner,
    taskRepoPath(task, project),
    project.planning_dir || "PLANNING",
    modelId,
  )
    .then((distilled) => {
      // Update the role run's open_questions with the distilled text versions
      const distilledTexts = distilled.questions.map((dq) => dq.text);
      // We can't directly update the role_run row's open_questions_json,
      // but we can update a steer_note-style intervention to surface the
      // distilled questions. For now, log the result.
      if (distilled.merged_count > 0 || distilled.dropped_duplicates > 0) {
        console.log(
          `[router] question distillation for task ${task.task_id.slice(0, 8)}: ` +
            `${distilled.merged_count} merged, ${distilled.dropped_duplicates} duplicates dropped, ` +
            `${distilled.questions.length} final questions`,
        );
      }
      // Store distilled questions as an intervention for the UI to pick up
      createIntervention({
        task_id: task.task_id,
        kind: "steer_note",
        payload_json: JSON.stringify({
          text: `[router·distilled questions] ${distilled.questions.map((dq) => `[${dq.priority}] ${dq.text}${dq.suggested_answer ? ` → ${dq.suggested_answer}` : ""}`).join(" | ")}`,
        }),
        created_by: "router",
      });
    })
    .catch((err) => {
      console.warn(`[router] question distillation async failed: ${(err as Error).message}`);
    });
}

/** Detect JSON parse errors (strict "after JSON" or generic SyntaxError). */
function isJsonParseError(message: string): boolean {
  return message.includes("JSON") || message.includes("Unexpected token") || message.includes("Unexpected non-whitespace");
}

// ---------------------------------------------------------------------------
// Running one role step
// ---------------------------------------------------------------------------

async function runOneStep(task: TaskRow, project: ProjectRow, step: PlanStep, plan: RefinementPlan): Promise<void> {
  // Ensure this task's dedicated worktree exists before touching the repo —
  // idempotent, so this is cheap on every step after the first.
  task = ensureTaskWorkspace(task, project);
  const repoPath = taskRepoPath(task, project);
  const planningDir = project.planning_dir || "PLANNING";
  const role = getRole(project.id, step.role) ?? getRole(null, step.role);
  if (!role || !role.system_prompt) {
    // Unknown role — skip it so the loop can't wedge.
    step.status = "skipped";
    updateTask(task.task_id, { refinement_plan_json: JSON.stringify(plan) });
    return;
  }

  const tools: string[] = role.tools_json ? (JSON.parse(role.tools_json) as string[]) : [];
  const harnessPolicy = resolveHarnessPolicy(project.config_json);
  // Resolve the connection FROM the chosen model reference (a named model-config's
  // `name`, or a raw modelId) rather than always the project/global default — this
  // is what lets textMode/twoPhase/base_url vary per role when a model override
  // points at a config with its own settings. Falls back to the default connection
  // (and its defaultModelId) when no override is set, matching prior behavior.
  const modelRef = role.model || task.model || project.default_model || null;
  const { connection, modelId } = resolveConnectionForModel(modelRef, project.id);
  const relArtifact = task.artifact_path ?? path.join(planningDir, "REFINING", artifactName(task));
  const absArtifact = path.join(repoPath, relArtifact);

  // Deep-sanitize home-directory paths from streaming event data (tool args,
  // text deltas, thinking deltas) before they hit the live activity pane.
  const sanitizeEventData = (data: unknown): unknown => {
    if (typeof data === "string") return sanitizePath(data);
    if (data && typeof data === "object") {
      if (Array.isArray(data)) return data.map(sanitizeEventData);
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
        out[k] = sanitizeEventData(v);
      }
      return out;
    }
    return data;
  };

  publish(task.task_id, "role_start", { role: step.role, depth: step.depth, model: modelId });

  let result;
  const ac = new AbortController();
  activeAborts.set(task.task_id, ac);
  try {
    result = await roleRunner({
      repoPath,
      planningDir,
      artifactAbsPath: absArtifact,
      modelId,
      systemPrompt: role.system_prompt,
      tools,
      context: buildRoleContext(task, step.role, connection.twoPhase, connection.textMode),
      thinkingLevel: connection.reasoning ? connection.thinkingLevel : undefined,
      textMode: connection.textMode,
      twoPhase: connection.twoPhase,
      thinkingBudgets: connection.thinkingBudgets,
      connection,
      harnessPolicy,
      onEvent: (ev) => publish(task.task_id, ev.type as never, sanitizeEventData(ev)),
      signal: ac.signal,
    });
  } catch (err) {
    const msg = (err as Error).message;
    const aborted = ac.signal.aborted || msg === "AbortError" || msg.includes("aborted");

    // JSON formatting failures are transient — re-queue with explicit guidance
    // instead of immediately escalating to human review.
    if (!aborted && isJsonParseError(msg)) {
      const retryCount = step.attempts ?? 0;
      if (retryCount < 2) {
        console.warn(
          `[orchestrator] role ${step.role} failed with JSON parse error (attempt ${retryCount + 1}/2) — ` +
            `re-queuing with formatting guidance`,
        );
        step.status = "pending";
        step.attempts = retryCount + 1;
        createIntervention({
          task_id: task.task_id,
          kind: "steer_note",
          payload_json: JSON.stringify({
            text:
              `[orchestrator·retry] The previous attempt failed because your JSON output was not valid — ` +
              `there was extra text after the closing brace or bracket. When you call record_findings (or ` +
              `output a JSON block in text mode), ensure the JSON is the ONLY content after the opening ` +
              `brace — no commentary, no markdown, no trailing text. If using a code fence, close it ` +
              `immediately after the final brace.`,
          }),
          created_by: "orchestrator",
        });
        updateTask(task.task_id, {
          refinement_plan_json: JSON.stringify(plan),
          stage: "refining",
          paused: 0,
        });
        publish(task.task_id, "task_update", {
          stage: "refining",
          retryReason: "json-parse-error",
          attempt: retryCount + 1,
        });
        return;
      }
      console.warn(
        `[orchestrator] role ${step.role} JSON parse error after ${retryCount} retries — escalating`,
      );
    }

    publish(task.task_id, "role_end", { role: step.role, error: true, aborted, model: modelId });
    createRoleRun({
      task_id: task.task_id,
      role_key: step.role,
      verdict: aborted ? "needs_human" : "blocker",
      summary: aborted
        ? `Role ${step.role} was aborted by user.`
        : `Role execution failed: ${msg}`,
      depth: step.depth,
      model: modelId,
    });
    step.status = "done";
    updateTask(task.task_id, {
      refinement_plan_json: JSON.stringify(plan),
      stage: "review",
      exit_state: "needs_review",
      review_reason: aborted
        ? `Role ${step.role} was aborted by user — task needs human judgement.`
        : `Role ${step.role} failed: ${msg}`,
      status: "failed",
    });
    publish(task.task_id, "task_update", { stage: "review" });
    return;
  } finally {
    activeAborts.delete(task.task_id);
  }

  const { findings } = result;

  // Surface degraded runs (missing verdict / truncated output / stalled narration) in the logs.
  if (result.fallback || result.stopReason === "length" || result.stalled) {
    console.warn(
      `[orchestrator] degraded run: task=${task.task_id.slice(0, 8)} role=${step.role} ` +
        `stop=${result.stopReason ?? "?"} fallback=${result.fallback} stalled=${result.stalled} tokens=${result.tokens}`,
    );
  }

  // Persist the run.
  const run = createRoleRun({
    task_id: task.task_id,
    role_key: step.role,
    verdict: findings.verdict,
    summary: findings.summary,
    output_md: findings.section_md,
    coverage_json: JSON.stringify(findings.coverage),
    criteria_results_json: JSON.stringify(findings.criteria_results ?? []),
    tool_calls_json: JSON.stringify(result.toolCalls),
    transcript_jsonl: result.transcriptJsonl,
    stop_reason: result.stopReason ?? null,
    fallback: result.fallback ? 1 : 0,
    stalled: result.stalled ? 1 : 0,
    thinking_md: result.thinkingText || null,
    open_questions_json: JSON.stringify(findings.open_questions ?? []),
    depth: step.depth,
    model: result.model,
    tokens: result.tokens,
  });

  // ---- Call Point 1: Question Distillation (fire-and-forget) ----
  const routerCfg = getRouterCfg(project);
  if (routerCfg?.questionDistillation && findings.open_questions?.length) {
    maybeDistillQuestions(task, project, run.id, findings.open_questions, routerCfg);
  }

  // Append the section to the artifact + commit. On success, the resulting
  // commit is this run's checkpoint — restore resets task.git_branch to it.
  // Any files the role wrote/edited via the guarded write/edit tools ride
  // along in the same checkpoint commit.
  appendArtifactSection(absArtifact, findings.section_md);
  const committed = commitArtifacts(
    repoPath,
    [relArtifact, ...result.filesWritten],
    refineCommitMessage(step.role, task.name ?? task.task_id, findings.summary),
  );
  if (committed) {
    try {
      setRoleRunCommitSha(run.id, headSha(repoPath));
    } catch (err) {
      console.warn(`[git] could not read checkpoint SHA for run ${run.id}: ${(err as Error).message}`);
    }
  }
  if (result.filesWritten.length > 0 && !task.wrote_source) {
    task = updateTask(task.task_id, { wrote_source: 1 }) ?? task;
  }

  // Roll coverage up.
  const coverage = rollupCoverage(task.task_id);
  step.status = "done";

  publish(task.task_id, "role_end", {
    role: step.role,
    verdict: findings.verdict,
    fallback: result.fallback,
    stopReason: result.stopReason,
    tokens: result.tokens,
    model: result.model,
  });

  // ---- Adversarial critique + orchestrator second review ----
  // A high-bar "would I reject a PR for this?" check, separate from the flow's
  // static-criteria reviewerRole gate. Fires at the reviewer step only
  // ("terminal_only") or after every non-exempt step ("every_step"), per the
  // flow's reviewDepth. The critique's own verdict always has teeth (folds into
  // the effective verdict below, never silently); the optional second-review
  // call adds an authoritative LLM-mediated synthesis on top when enabled, and
  // can downgrade a critique false-positive or independently escalate.
  const flow = flowForTask(task);
  const isReviewerStep = step.role === flow.reviewerRole;
  const shouldCritique =
    flow.reviewDepth === "every_step"
      ? !isCritiqueExempt(step.role)
      : flow.reviewDepth === "terminal_only"
        ? isReviewerStep
        : false;

  let effectiveVerdict: string = findings.verdict;
  let verdictNote: string | undefined;
  // Whether effectiveVerdict was actually set by the critique/second-review
  // machinery, as opposed to just carrying forward the primary role's own
  // self-reported verdict. A plain "needs_more" self-assessment is routine
  // for a producer role and must not be treated as an adversarial flag.
  let flaggedByReview = false;

  if (shouldCritique) {
    const critique = await runCritiquePass(task, project, step, run, findings);
    if (critique && VERDICT_RANK[critique.verdict]! > VERDICT_RANK[effectiveVerdict]!) {
      effectiveVerdict = critique.verdict;
      verdictNote = `[critic] ${critique.summary}`;
      flaggedByReview = true;
    }

    if (routerCfg?.secondReview) {
      const decision = await maybeSecondReview(task, project, step, findings, critique, coverage, routerCfg);
      switch (decision.decision) {
        case "escalate":
          effectiveVerdict = "blocker";
          verdictNote = `[second review] ${decision.reasoning}`;
          flaggedByReview = true;
          break;
        case "loopback":
          effectiveVerdict = "needs_more";
          verdictNote = `[second review] ${decision.steer_note || decision.reasoning}`;
          flaggedByReview = true;
          break;
        case "accept":
          // Authoritative downgrade of a critique false-positive back to the primary verdict.
          effectiveVerdict = findings.verdict;
          verdictNote = undefined;
          flaggedByReview = false;
          break;
        case "accept_with_note":
          effectiveVerdict = findings.verdict;
          verdictNote = `[second review] ${decision.steer_note || decision.reasoning}`;
          flaggedByReview = false;
          break;
      }
    }

    if (verdictNote) {
      createIntervention({
        task_id: task.task_id,
        kind: "steer_note",
        payload_json: JSON.stringify({ text: `${verdictNote} (re: ${step.role})` }),
        created_by: "critic",
      });
    }
  }

  // Gate.
  await applyGate(
    task,
    project,
    plan,
    step,
    effectiveVerdict,
    coverage,
    findings.criteria_results ?? [],
    routerCfg,
    verdictNote,
    flaggedByReview,
  );
}

/** Verdict severity ranking used to fold a critique's verdict into the primary
 *  one without ever silently downgrading (pass < needs_more < blocker ~ needs_human). */
const VERDICT_RANK: Record<string, number> = { pass: 0, needs_more: 1, blocker: 2, needs_human: 2 };

/** Pure: scope a critique's context to just the one step's output being judged. */
function buildCritiqueContext(task: TaskRow, roleKey: string, findings: RoleFindings): string {
  const parts: string[] = [];
  parts.push(`# Task: ${task.name ?? task.task_id}`);
  parts.push(`Intake kind: ${task.intake_kind} · Target exit: ${task.exit_kind}`);
  parts.push(`\n## Step under review: ${roleKey}`);
  parts.push(`- Verdict: ${findings.verdict}`);
  parts.push(`- Summary: ${findings.summary}`);
  parts.push(`\n${findings.section_md}`);
  parts.push(
    `\n## Your task now\nYou are the **critic**. Judge ONLY this one step's output above — not ` +
      `the whole task. Would you reject a PR implementing this, because it violates a domain ` +
      `(security, privacy, legal/compliance, irreversible data safety) so badly that it matters — ` +
      `not because it could be improved? If yes, set verdict "blocker" (or "needs_human" if ` +
      `ambiguous but serious) and say concretely why. Otherwise set verdict "pass" — silence is the ` +
      `expected outcome. Then finish by invoking \`record_findings\` directly as a tool call.`,
  );
  return parts.join("\n");
}

/** Run the adversarial critic role against one step's just-completed output and
 *  persist it as a `run_kind: "critique"` role_run linked via target_run_id.
 *  Returns undefined (rather than throwing) if the critic role is missing or the
 *  call fails — a critique failure must never wedge the primary pipeline. */
async function runCritiquePass(
  task: TaskRow,
  project: ProjectRow,
  step: PlanStep,
  run: RoleRunRow,
  findings: RoleFindings,
): Promise<{ verdict: Verdict; summary: string } | undefined> {
  const criticRole = getRole(project.id, "critic") ?? getRole(null, "critic");
  if (!criticRole || !criticRole.system_prompt) return undefined;

  const tools: string[] = criticRole.tools_json ? (JSON.parse(criticRole.tools_json) as string[]) : [];
  const modelRef = criticRole.model || task.model || project.default_model || null;
  const { connection, modelId } = resolveConnectionForModel(modelRef, project.id);

  try {
    const result = await roleRunner({
      repoPath: taskRepoPath(task, project),
      planningDir: project.planning_dir || "PLANNING",
      artifactAbsPath: "",
      modelId,
      systemPrompt: criticRole.system_prompt,
      tools,
      context: buildCritiqueContext(task, step.role, findings),
      thinkingLevel: connection.reasoning ? connection.thinkingLevel : undefined,
      textMode: connection.textMode,
      twoPhase: connection.twoPhase,
      harnessPolicy: resolveHarnessPolicy(project.config_json),
      thinkingBudgets: connection.thinkingBudgets,
      connection,
      signal: new AbortController().signal,
    });

    createRoleRun({
      task_id: task.task_id,
      role_key: "critic",
      verdict: result.findings.verdict,
      summary: result.findings.summary,
      output_md: result.findings.section_md,
      coverage_json: JSON.stringify(result.findings.coverage ?? []),
      tool_calls_json: JSON.stringify(result.toolCalls),
      transcript_jsonl: result.transcriptJsonl,
      stop_reason: result.stopReason ?? null,
      fallback: result.fallback ? 1 : 0,
      stalled: result.stalled ? 1 : 0,
      thinking_md: result.thinkingText || null,
      open_questions_json: JSON.stringify(result.findings.open_questions ?? []),
      target_run_id: run.id,
      run_kind: "critique",
      depth: step.depth,
      model: result.model,
      tokens: result.tokens,
    });

    return { verdict: result.findings.verdict, summary: result.findings.summary };
  } catch (err) {
    console.warn(`[orchestrator] critique pass failed for role ${step.role}: ${(err as Error).message}`);
    return undefined;
  }
}

/** Pure: build a context document for the orchestrator recap call. */
function buildRecapContext(task: TaskRow, project: ProjectRow, runs: RoleRunRow[], coverage: CoverageMap, criteriaResults: CriteriaResult[]): string {
  const parts: string[] = [];
  parts.push(`# Recapitulation for: ${task.name ?? task.task_id.slice(0, 8)}`);
  parts.push(`Intake kind: ${task.intake_kind} · Exit kind: ${task.exit_kind} · Stage: ${task.stage}`);
  parts.push(`Exit state: ${task.exit_state ?? "n/a"} · Review reason: ${task.review_reason || "none"}`);
  parts.push("");
  parts.push("## Role run results");
  if (runs.length === 0) {
    parts.push("No role runs recorded.");
  } else {
    for (const r of runs) {
      parts.push(`### ${r.role_key} (depth ${r.depth})`);
      parts.push(`- **Verdict**: ${r.verdict ?? "n/a"}`);
      parts.push(`- **Summary**: ${r.summary ?? "n/a"}`);
      if (r.output_md) {
        const excerpt = r.output_md.slice(0, 600).replace(/\n+/g, " ");
        parts.push(`- **Output excerpt**: ${excerpt}${r.output_md.length > 600 ? "…" : ""}`);
      }
      if (r.stop_reason === "length") parts.push(`- ⚠ Truncated (hit token limit)`);
      if (r.fallback === 1) parts.push(`- ⚠ Fallback (no record_findings call)`);
      if (r.stalled === 1) parts.push(`- ⚠ Stalled (narrated tool use instead of invoking)`);
      parts.push("");
    }
  }

  parts.push("## Coverage map");
  for (const [concern, entry] of Object.entries(coverage)) {
    parts.push(`- **${concern}**: ${entry.status}${entry.note ? ` (${entry.note})` : ""}`);
  }

  if (criteriaResults.length > 0) {
    parts.push("");
    parts.push("## Acceptance criteria results");
    for (const cr of criteriaResults) {
      const labels: Record<string, string> = { met: "✅", partial: "⚠", unmet: "❌" };
      parts.push(`- ${labels[cr.status] ?? "?"} \`${cr.id}\`: ${cr.status}${cr.note ? ` — ${cr.note}` : ""}`);
    }
  }

  parts.push("");
  parts.push(
    `## Your task now\n` +
    `You are the **orchestrator** performing a final recap. Synthesize the above into a concise, ` +
    `actionable final status summary in Markdown. Cover:\n` +
    `1. **Disposition**: one-sentence outcome — ready for implementation, needs more work, or needs human review.\n` +
    `2. **Key findings**: 2-5 bullet points synthesizing the most important discoveries from all roles.\n` +
    `3. **Coverage**: which concerns were fully addressed, which were skipped, and any gaps.\n` +
    `4. **Recommendation**: clear next steps for the developer or reviewer.\n\n` +
    `Be direct. Do not repeat the raw data verbatim — synthesize. Start directly with "## Disposition" as a level-2 heading.`,
  );
  return parts.join("\n");
}

/**
 * Run a one-shot recap call through the LLM to synthesize a final disposition
 * for the task after all role runs have completed. Uses the existing roleRunner
 * seam so it is testable without a live model.
 */
async function generateRecap(
  task: TaskRow,
  project: ProjectRow,
  runs: RoleRunRow[],
  coverage: CoverageMap,
  criteriaResults: CriteriaResult[],
): Promise<string | null> {
  const { connection, modelId } = resolveConnectionForModel(
    task.model || project.default_model || null,
    project.id,
  );
  const planningDir = project.planning_dir || "PLANNING";
  const context = buildRecapContext(task, project, runs, coverage, criteriaResults);
  const repoPath = taskRepoPath(task, project);

  try {
    const result = await roleRunner({
      repoPath,
      planningDir,
      artifactAbsPath: path.join(repoPath, planningDir, "REFINING", `${task.task_id.slice(0, 8)}.md`),
      modelId,
      systemPrompt:
        "You are the orchestration layer performing a final recap of a multi-role refinement pipeline. " +
        "You receive structured findings from every role that ran and produce a concise, " +
        "actionable final status summary in well-formatted Markdown. " +
        "Do NOT use any tools — simply read the context and produce the recap text directly. " +
        "Do not describe what you are doing; just produce the recap.",
      tools: [],
      context,
      thinkingBudgets: connection.thinkingBudgets,
      connection,
      signal: new AbortController().signal,
    });
    return result.findings.section_md || result.findings.summary || null;
  } catch (err) {
    console.error(`[orchestrator] recap call failed for task ${task.task_id.slice(0, 8)}: ${(err as Error).message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Call Point 2: Escalation Assessment (before human REVIEW)
// ---------------------------------------------------------------------------

/**
 * Before escalating a task to human REVIEW, optionally consult the router LLM
 * to assess whether another role could resolve the issue instead.
 * Returns true if the original escalation should be overridden (task stays in refining).
 */
async function maybeAssessEscalation(
  task: TaskRow,
  project: ProjectRow,
  plan: RefinementPlan,
  step: PlanStep,
  verdict: string,
  escalationReason: string,
  routerCfg: RouterConfig,
): Promise<boolean> {
  const allRuns = listRoleRuns(task.task_id).map((r) => ({
    role_key: r.role_key,
    verdict: r.verdict ?? "?",
    summary: r.summary ?? "",
  }));

  const coverage = rollupCoverage(task.task_id);
  const lastRun = allRuns[allRuns.length - 1];

  // Collect available roles from the project
  const roles = [
    ...new Set([
      "privacy_review",
      "security_review",
      "performance_review",
      "test_strategy",
      "edge_case_analysis",
      "options_exploration",
      "ux_review",
      "architecture_review",
      "requirements_analyst",
      "api_design",
      "data_schema_review",
      "style_conventions",
      "dependency_integration",
      "bug_investigator",
    ]),
  ];

  const { modelId } = resolveConnectionForModel(
    task.model || project.default_model || null,
    project.id,
  );

  try {
    const assessment = await assessEscalation(
      {
        taskName: task.name ?? task.task_id.slice(0, 8),
        intakeKind: task.intake_kind ?? "manual",
        escalationReason,
        lastRoleKey: step.role,
        lastVerdict: verdict,
        lastSummary: lastRun?.summary ?? "",
        allRuns,
        coverageMap: coverage,
        criteriaResults: [],
        loopbacksRemaining: 0,
        availableRoles: roles,
        planSteps: plan.steps,
      },
      roleRunner,
      taskRepoPath(task, project),
      project.planning_dir || "PLANNING",
      modelId,
    );

    console.log(
      `[router] escalation assessment for task ${task.task_id.slice(0, 8)}: ` +
        `decision=${assessment.decision} reasoning=${assessment.reasoning}`,
    );

    if (assessment.decision === "escalate" || assessment.decision === "close") {
      // "close" overrides the escalation — treat as pass and continue
      if (assessment.decision === "close") {
        updateTask(task.task_id, {
          stage: "refining",
          paused: 0,
        });
        publish(task.task_id, "task_update", { stage: "refining" });
        return true; // overridden
      }
      return false; // stick with escalation
    }

    // reroute or rerun
    if (assessment.decision === "reroute" && assessment.action?.role) {
      applyPlanMutation(
        plan,
        "inject_role",
        { role: assessment.action.role, after: assessment.action.after || step.role },
        (r) => isTerminalRole(task, r),
      );
      if (assessment.action.steer_note) {
        createIntervention({
          task_id: task.task_id,
          kind: "steer_note",
          payload_json: JSON.stringify({ text: assessment.action.steer_note }),
          created_by: "router",
        });
      }
      updateTask(task.task_id, {
        refinement_plan_json: JSON.stringify(plan),
        stage: "refining",
        paused: 0,
        review_reason: null,
        exit_state: null,
      });
      publish(task.task_id, "task_update", {
        stage: "refining",
        routerAction: `rerouted to ${assessment.action.role}`,
      });
      return true; // overridden
    }

    if (assessment.decision === "rerun") {
      const last = [...plan.steps].reverse().find((s) => s.role === step.role);
      if (last) {
        last.status = "pending";
        last.depth += 1;
      }
      if (assessment.action?.steer_note) {
        createIntervention({
          task_id: task.task_id,
          kind: "steer_note",
          payload_json: JSON.stringify({ text: assessment.action.steer_note }),
          created_by: "router",
        });
      }
      updateTask(task.task_id, {
        refinement_plan_json: JSON.stringify(plan),
        stage: "refining",
        paused: 0,
        review_reason: null,
        exit_state: null,
      });
      publish(task.task_id, "task_update", {
        stage: "refining",
        routerAction: "rerun",
      });
      return true; // overridden
    }
  } catch (err) {
    console.warn(`[router] escalation assessment failed: ${(err as Error).message}`);
  }

  return false; // fallback: don't override
}

// ---------------------------------------------------------------------------
// Call Point 3: Borderline Gate Assessment (partial criteria, near-exhaustion)
// ---------------------------------------------------------------------------

/**
 * Before the reviewer gate loops back or escalates, optionally consult the
 * router LLM for a more nuanced decision on borderline criteria.
 * Returns null if the default behavior should proceed, or a steering action.
 */
async function maybeAssessBorderline(
  task: TaskRow,
  project: ProjectRow,
  plan: RefinementPlan,
  step: PlanStep,
  unmetMust: Array<{ id: string; text: string; ownerRole: string }>,
  missingConcerns: string[],
  loopbackCount: number,
  maxLoopbacks: number,
  flow: FlowTemplate,
  criteriaResults: CriteriaResult[],
  coverage: CoverageMap,
  routerCfg: RouterConfig,
): Promise<"default" | "proceed" | "proceed_with_note" | "narrow_loopback" | "escalate_early"> {
  // Only fire if this is a borderline situation: has partial criteria OR at last loopback
  const hasPartials = criteriaResults.some((c) => c.status === "partial");
  const atLastLoopback = loopbackCount >= maxLoopbacks - 1;

  if (!hasPartials && !atLastLoopback) return "default";

  const ownerRuns = listRoleRuns(task.task_id).filter((r) =>
    unmetMust.some((c) => c.ownerRole === r.role_key),
  );

  const { modelId } = resolveConnectionForModel(
    task.model || project.default_model || null,
    project.id,
  );

  try {
    const assessment = await assessBorderline(
      {
        taskName: task.name ?? task.task_id.slice(0, 8),
        intakeKind: task.intake_kind ?? "manual",
        reviewerRole: step.role,
        reviewerVerdict: "needs_more",
        allCriteria: flow.criteria.map((c) => {
          const result = criteriaResults.find((r) => r.id === c.id);
          return {
            id: c.id,
            text: c.text,
            severity: c.severity,
            status: result?.status ?? "unmet",
            note: result?.note ?? null,
            ownerRole: c.ownerRole,
          };
        }),
        unmetMust: unmetMust.map((c) => {
          const result = criteriaResults.find((r) => r.id === c.id);
          return { ...c, note: result?.note ?? null };
        }),
        missingConcerns,
        loopbackCount,
        maxLoopbacks,
        ownerRolesSummaries: ownerRuns.map((r) => ({
          role_key: r.role_key,
          summary: r.summary ?? "",
        })),
        coverageMap: coverage,
      },
      roleRunner,
      taskRepoPath(task, project),
      project.planning_dir || "PLANNING",
      modelId,
    );

    console.log(
      `[router] borderline assessment for task ${task.task_id.slice(0, 8)}: ` +
        `decision=${assessment.decision} reasoning=${assessment.reasoning}`,
    );

    switch (assessment.decision) {
      case "proceed":
      case "proceed_with_note": {
        if (assessment.steer_note) {
          createIntervention({
            task_id: task.task_id,
            kind: "steer_note",
            payload_json: JSON.stringify({
              text: `[router·borderline] ${assessment.steer_note}`,
            }),
            created_by: "router",
          });
        }
        return assessment.decision === "proceed_with_note" ? "proceed_with_note" : "proceed";
      }
      case "narrow_loopback": {
        if (assessment.target_roles?.length) {
          // Re-open only the specified target roles, not all owners
          for (const s of plan.steps) {
            if (assessment.target_roles.includes(s.role)) s.status = "pending";
          }
          step.status = "pending";
          step.attempts = (step.attempts ?? 0) + 1;
          if (assessment.steer_note) {
            createIntervention({
              task_id: task.task_id,
              kind: "steer_note",
              payload_json: JSON.stringify({
                text: `[router·borderline] ${assessment.steer_note}`,
              }),
              created_by: "router",
            });
          }
          return "narrow_loopback";
        }
        return "default";
      }
      case "escalate": {
        return "escalate_early";
      }
      default:
        return "default";
    }
  } catch (err) {
    console.warn(`[router] borderline assessment failed: ${(err as Error).message}`);
    return "default";
  }
}

// ---------------------------------------------------------------------------
// Call Point 4: Second Review (authoritative synthesis of primary + critique)
// ---------------------------------------------------------------------------

/**
 * The orchestrator's own authoritative second opinion on a step, synthesizing
 * the primary run's verdict with the adversarial critique's verdict (if one
 * ran). Unlike Call Points 2/3, this is not merely advisory — its decision is
 * what reaches applyGate, so it can downgrade a critique false-positive back
 * to "accept" or independently escalate a finding the critique missed.
 */
async function maybeSecondReview(
  task: TaskRow,
  project: ProjectRow,
  step: PlanStep,
  findings: RoleFindings,
  critique: { verdict: Verdict; summary: string } | undefined,
  coverage: CoverageMap,
  routerCfg: RouterConfig,
): Promise<SecondReviewResult> {
  const { modelId } = resolveConnectionForModel(
    task.model || project.default_model || null,
    project.id,
  );

  try {
    const result = await assessSecondReview(
      {
        taskName: task.name ?? task.task_id.slice(0, 8),
        intakeKind: task.intake_kind ?? "manual",
        roleKey: step.role,
        primaryVerdict: findings.verdict,
        primarySummary: findings.summary,
        critiqueVerdict: critique?.verdict,
        critiqueSummary: critique?.summary,
        coverageMap: coverage,
      },
      roleRunner,
      taskRepoPath(task, project),
      project.planning_dir || "PLANNING",
      modelId,
    );

    console.log(
      `[router] second review for task ${task.task_id.slice(0, 8)} role=${step.role}: ` +
        `decision=${result.decision} reasoning=${result.reasoning}`,
    );
    return result;
  } catch (err) {
    console.warn(`[router] second review failed: ${(err as Error).message}`);
    return { decision: "accept", reasoning: "Second review call failed — accepting the primary verdict as-is." };
  }
}

async function applyGate(
  task: TaskRow,
  project: ProjectRow,
  plan: RefinementPlan,
  step: PlanStep,
  verdict: string,
  coverage: CoverageMap,
  criteriaResults: CriteriaResult[] = [],
  routerCfg: RouterConfig | null = null,
  /** When the verdict was overridden by the adversarial critique or the
   *  orchestrator's second review, a short explanation appended to escalation
   *  reasons and used as the steer note for a non-reviewer-step loop-back. */
  verdictNote?: string,
  /** True only when `verdict` was actually set by the critique/second-review
   *  machinery (not just carried forward from the primary role's own
   *  self-reported verdict). Gates the non-reviewer-step retry/escalate path
   *  below so a routine "needs_more" self-assessment isn't mistaken for an
   *  adversarial flag. */
  flaggedByReview = false,
): Promise<void> {
  const planningDir = project.planning_dir || "PLANNING";
  const relArtifact = task.artifact_path ?? path.join(planningDir, "REFINING", artifactName(task));
  const coverageJson = JSON.stringify(coverage);
  const repoPath = taskRepoPath(task, project);

  const escalate = (reason: string) => {
    const dest = relArtifact.replace(`${path.sep}REFINING${path.sep}`, `${path.sep}REVIEW${path.sep}`);
    moveArtifact(path.join(repoPath, relArtifact), path.join(repoPath, dest));
    updateTask(task.task_id, {
      refinement_plan_json: JSON.stringify(plan),
      coverage_json: coverageJson,
      stage: "review",
      exit_state: "needs_review",
      review_reason: reason,
      artifact_path: dest,
      status: "complete",
    });
    commitArtifacts(repoPath, [relArtifact, dest], `review: ${task.name ?? task.task_id}`);
    publish(task.task_id, "task_update", { stage: "review" });
  };

  /** Fire-and-forget: generate a recap for a task that just reached terminal state. */
  const triggerRecap = (finalCoverage: CoverageMap, finalCriteria: CriteriaResult[]) => {
    publish(task.task_id, "recap_start", {});
    generateRecap(task, project, listRoleRuns(task.task_id), finalCoverage, finalCriteria).then(
      (recapMd) => {
        if (recapMd) updateTask(task.task_id, { recap_md: recapMd });
        publish(task.task_id, "recap_end", { success: true });
        publish(task.task_id, "task_update", { stage: task.stage });
      },
      (err) => {
        console.error(`[orchestrator] recap failed: ${(err as Error).message}`);
        publish(task.task_id, "recap_end", { success: false });
        publish(task.task_id, "task_update", { stage: task.stage });
      },
    );
  };

  if (verdict === "needs_human") {
    // ---- Call Point 2: Escalation Assessment ----
    if (routerCfg?.escalationAssessment) {
      const overridden = await maybeAssessEscalation(
        task,
        project,
        plan,
        step,
        verdict,
        `Role ${step.role} flagged an ambiguity requiring human judgement.`,
        routerCfg,
      );
      if (overridden) return;
    }
    escalate(
      `Role ${step.role} flagged an ambiguity requiring human judgement.${verdictNote ? ` ${verdictNote}` : ""}`,
    );
    triggerRecap(coverage, criteriaResults);
    return;
  }
  if (verdict === "blocker") {
    // ---- Call Point 2: Escalation Assessment ----
    if (routerCfg?.escalationAssessment) {
      const overridden = await maybeAssessEscalation(
        task,
        project,
        plan,
        step,
        verdict,
        `Role ${step.role} reported a blocker.`,
        routerCfg,
      );
      if (overridden) return;
    }
    escalate(`Role ${step.role} reported a blocker.${verdictNote ? ` ${verdictNote}` : ""}`);
    triggerRecap(coverage, criteriaResults);
    return;
  }

  const flow = flowForTask(task);

  // Non-reviewer-step critique/second-review loop-back: a producer step whose
  // output was flagged by the adversarial critique or second review (not the
  // flow's static-criteria reviewerRole gate below). Bounded to one retry,
  // distinct from the reviewer's own flow.maxLoopbacks.
  const NON_REVIEWER_CRITIQUE_RETRY_LIMIT = 1;
  if (flaggedByReview && verdict === "needs_more" && step.role !== flow.reviewerRole) {
    const attempts = step.attempts ?? 0;
    if (attempts < NON_REVIEWER_CRITIQUE_RETRY_LIMIT) {
      step.status = "pending";
      step.attempts = attempts + 1;
      updateTask(task.task_id, {
        refinement_plan_json: JSON.stringify(plan),
        coverage_json: coverageJson,
        stage: "refining",
      });
      publish(task.task_id, "task_update", { stage: "refining", loopback: attempts + 1 });
      return;
    }
    escalate(
      `Role ${step.role}'s output was flagged and could not be resolved after ` +
        `${NON_REVIEWER_CRITIQUE_RETRY_LIMIT} retry.${verdictNote ? ` ${verdictNote}` : ""}`,
    );
    triggerRecap(coverage, criteriaResults);
    return;
  }

  // Counter-reviewer gate: verify prior output against the flow's acceptance
  // criteria. On failure, re-route (bounded loop-back) to the responsible roles;
  // once loop-backs are exhausted, escalate to a human.
  if (step.role === flow.reviewerRole) {
    const statusById = new Map(criteriaResults.map((r) => [r.id, r.status]));
    const unmetMust = flow.criteria.filter(
      (c) => c.severity === "must" && (statusById.get(c.id) ?? "unmet") !== "met",
    );
    const missingConcerns = flow.mandatoryConcerns.filter(
      (cc) => (coverage[cc]?.status ?? "never") !== "considered",
    );
    const failed = verdict === "needs_more" || unmetMust.length > 0 || missingConcerns.length > 0;

    if (failed) {
      const attempts = step.attempts ?? 0;

      // ---- Call Point 3: Borderline Gate Assessment ----
      if (routerCfg?.borderlineGateAssessment) {
        const borderlineResult = await maybeAssessBorderline(
          task,
          project,
          plan,
          step,
          unmetMust,
          missingConcerns,
          attempts,
          flow.maxLoopbacks,
          flow,
          criteriaResults,
          coverage,
          routerCfg,
        );

        switch (borderlineResult) {
          case "proceed":
          case "proceed_with_note": {
            // Override the loopback — proceed to terminal
            updateTask(task.task_id, {
              refinement_plan_json: JSON.stringify(plan),
              coverage_json: coverageJson,
              stage: "refining",
            });
            publish(task.task_id, "task_update", { stage: "refining", routerAction: borderlineResult });
            return;
          }
          case "narrow_loopback": {
            // Plan already mutated by maybeAssessBorderline — save and continue
            updateTask(task.task_id, {
              refinement_plan_json: JSON.stringify(plan),
              coverage_json: coverageJson,
              stage: "refining",
            });
            publish(task.task_id, "task_update", {
              stage: "refining",
              loopback: attempts + 1,
              routerAction: "narrow_loopback",
            });
            return;
          }
          case "escalate_early": {
            // Skip remaining loop-backs, escalate immediately
            const reason =
              `[router] Acceptance review incomplete — router advised early escalation after ${attempts} attempt(s).` +
              (unmetMust.length ? ` Unmet: ${unmetMust.map((c) => `${c.text} (${c.id})`).join("; ")}.` : "") +
              (missingConcerns.length ? ` Concerns not covered: ${missingConcerns.join(", ")}.` : "");
            escalate(reason);
            triggerRecap(coverage, criteriaResults);
            return;
          }
          default:
            // "default" — fall through to existing logic
            break;
        }
      }

      // ---- Default heuristic loop-back logic ----
      if (attempts < flow.maxLoopbacks) {
        // Re-open the owners of the unmet criteria (or every producer the reviewer
        // gates, if the reviewer gave no per-criterion detail) plus the reviewer.
        const owners = unmetMust.length
          ? new Set(unmetMust.map((c) => c.ownerRole))
          : new Set(flow.criteria.map((c) => c.ownerRole));
        for (const s of plan.steps) {
          if (owners.has(s.role)) s.status = "pending";
        }
        step.status = "pending";
        step.attempts = attempts + 1;

        // Feed the specific gaps back to the re-run roles via the steering channel.
        const gaps = [
          ...unmetMust.map((c) => `Unmet (${c.id}): ${c.text}`),
          ...missingConcerns.map((cc) => `Concern not yet covered: ${cc}`),
        ];
        if (gaps.length) {
          createIntervention({
            task_id: task.task_id,
            kind: "steer_note",
            payload_json: JSON.stringify({
              text: `[${flow.reviewerRole} · attempt ${attempts + 1}] Address before re-review:\n- ${gaps.join("\n- ")}`,
            }),
            created_by: "orchestrator",
          });
        }

        updateTask(task.task_id, {
          refinement_plan_json: JSON.stringify(plan),
          coverage_json: coverageJson,
          stage: "refining",
        });
        publish(task.task_id, "task_update", { stage: "refining", loopback: attempts + 1 });
        return;
      }
      // Loop-backs exhausted → human review.
      const reason =
        `Acceptance review incomplete after ${flow.maxLoopbacks} loop-back(s).` +
        (unmetMust.length ? ` Unmet: ${unmetMust.map((c) => `${c.text} (${c.id})`).join("; ")}.` : "") +
        (missingConcerns.length ? ` Concerns not covered: ${missingConcerns.join(", ")}.` : "");
      escalate(reason);
      triggerRecap(coverage, criteriaResults);
      return;
    }
    // Review passed → fall through to the forward/terminal logic below.
  }

  // Terminal role finished cleanly → ready.
  if (isTerminalRole(task, step.role) || !nextPending(plan)) {
    const dest = relArtifact.replace(`${path.sep}REFINING${path.sep}`, `${path.sep}READY${path.sep}`);
    moveArtifact(path.join(repoPath, relArtifact), path.join(repoPath, dest));
    updateTask(task.task_id, {
      refinement_plan_json: JSON.stringify(plan),
      coverage_json: coverageJson,
      stage: "ready",
      exit_state: "ready_for_work",
      artifact_path: dest,
      status: "complete",
    });
    commitArtifacts(repoPath, [relArtifact, dest], `ready: ${task.name ?? task.task_id}`);
    triggerRecap(coverage, criteriaResults);
    if (isTerminalRole(task, step.role) && (task.exit_kind as ExitKind) === "spec") {
      // Only [epic] and [story] nodes decompose further; [task] is the atomic leaf.
      // The role must also have can_create_subtasks enabled (default: only decomposition).
      let level = task.level ?? "task";
      const roleCfg = getRole(project.id, step.role);
      // Auto-promote a "task" level to "story" when the decomposition role produced
      // a parseable [epic]/[story]/[task] tree. The model clearly intends this to be
      // decomposable — the default "task" level was just never overridden.
      if (level === "task" && roleCfg?.can_create_subtasks) {
        const runs = listRoleRuns(task.task_id);
        const decomp = [...runs].reverse().find((r) => r.role_key === "decomposition");
        if (decomp?.output_md && parseDecompositionTree(decomp.output_md).length > 0) {
          level = "story";
          updateTask(task.task_id, { level });
        }
      }
      if ((level === "epic" || level === "story") && roleCfg?.can_create_subtasks) {
        // Runs before the base-branch checkout below: each child gets its own
        // branch created off base, which would otherwise leave the repo on the
        // last child's branch instead of back where the parent task started.
        createDecompositionChildren(task, project);
      }
    }
    // Accepted — reconcile the task's branch back into base before returning
    // the shared checkout there. Best-effort: a conflict/error is recorded as
    // a flag on the task (not a blocking state) and never prevents "ready" —
    // the task's own artifact is unaffected by a merge conflict, only its git
    // history is. The branch itself is left in place afterward either way,
    // for reference / possible manual resolution.
    if (task.git_branch && task.git_base_branch) {
      if (task.wrote_source) {
        // A task that wrote real source (not just PLANNING artifacts) must not
        // silently land in the base branch — the worktree jail protects the
        // filesystem during the run, but auto-merging its commits would still
        // hand agent-authored code changes to the user's working branch with
        // no review step. Leave the branch in place for manual merge instead.
        updateTask(task.task_id, {
          reconcile_status: "pending_human_merge",
          reconcile_detail: "task wrote source code — merge requires manual review",
        });
        publish(task.task_id, "task_update", { stage: "ready", reconcileStatus: "pending_human_merge" });
      } else {
        const reconciled = reconcileBranch(repoPath, task.git_branch, task.git_base_branch);
        updateTask(task.task_id, {
          reconcile_status: reconciled.status,
          reconcile_detail: reconciled.detail ?? null,
        });
        if (reconciled.status === "conflict" || reconciled.status === "error") {
          console.warn(
            `[git] reconciliation ${reconciled.status} for task ${task.task_id.slice(0, 8)}: ${reconciled.detail}`,
          );
        }
        publish(task.task_id, "task_update", { stage: "ready", reconcileStatus: reconciled.status });
      }
    }
    if (task.git_base_branch) {
      try {
        checkoutBranch(project.repo_path, task.git_base_branch);
      } catch (err) {
        console.warn(
          `[git] could not return to base branch "${task.git_base_branch}" after accepting ${task.task_id.slice(0, 8)}: ${(err as Error).message}`,
        );
      }
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

/** Pure: parse a decomposition section for [epic]/[story]/[task] bullets. */
export function parseDecompositionTree(md: string): Array<{ level: string; name: string }> {
  const re = /\[(epic|story|task)\]\s*(.+)/gi;
  const out: Array<{ level: string; name: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    out.push({ level: m[1]!.toLowerCase(), name: m[2]!.trim().slice(0, 120) });
  }
  return out;
}

/** Parse the decomposition role's section and create child tasks as intake
 *  so the scheduler discovers and refines them through the normal pipeline. */
function createDecompositionChildren(task: TaskRow, project: ProjectRow): void {
  const runs = listRoleRuns(task.task_id);
  const decomp = [...runs].reverse().find((r) => r.role_key === "decomposition");
  if (!decomp?.output_md) return;

  const planningDir = project.planning_dir || "PLANNING";
  const parentName = task.name ?? task.task_id.slice(0, 8);
  let step = 0;

  for (const node of parseDecompositionTree(decomp.output_md)) {
    // Seed content from the bullet text so the triage role has grounding.
    let child = createTask({
      name: node.name,
      content: node.name,
      project_id: task.project_id,
      stage: "intake",
      level: node.level,
      intake_kind: task.intake_kind ?? "manual",
      exit_kind: task.exit_kind ?? "spec",
      parent_task_id: task.task_id,
      task_type: "child",
      step_number: step++,
      status: "active",
    });
    // Same isolated-worktree treatment as top-level intake — a decomposition
    // child is its own checkpointable task, not a continuation of the parent's.
    child = ensureTaskWorkspace(child, project);
    const childRepo = taskRepoPath(child, project);

    // Write a minimal intake artifact so the child follows the normal pipeline.
    const artName = artifactName(child);
    const relArtifact = path.join(planningDir, "REFINING", artName);
    writeArtifact(
      path.join(childRepo, relArtifact),
      `# ${node.name}\n\n> Child of: **${parentName}** · level: \`${node.level}\`\n\n## Problem\n\n${node.name}\n`,
    );
    updateTask(child.task_id, { artifact_path: relArtifact });
    commitArtifacts(childRepo, [relArtifact], `intake(child): ${node.name}`);
    publish(child.task_id, "task_update", { stage: "intake" });
  }
}

// ---------------------------------------------------------------------------
// Tick + scheduler
// ---------------------------------------------------------------------------

/**
 * Task ids with a role-step (or restore/reincorporate) currently in flight,
 * mapped to the promise doing that work. Two roles:
 *  - `pickNextTasks` consults it so concurrent rounds (or a manual API call
 *    racing the scheduler loop) never pick the same task twice.
 *  - `serializeTask` chains onto it so a restore/reincorporate can never race
 *    a step already running for that same task — each task still gets
 *    single-worker sequential semantics against *itself*, even though
 *    different tasks now run concurrently (one worktree each).
 */
const inFlightTasks = new Map<string, Promise<void>>();
const taskChains = new Map<string, Promise<void>>();
/** Abort controllers for in-progress role runs, keyed by task id — stopScheduler()
 *  aborts every in-flight task, not just one, now that several can run at once. */
const activeAborts = new Map<string, AbortController>();

function serializeTask<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
  const prior = taskChains.get(taskId) ?? Promise.resolve();
  let result: T;
  const run = prior.then(async () => {
    result = await fn();
  });
  taskChains.set(taskId, run.catch(() => {}));
  return run.then(() => result!);
}

/** Pick up to `limit` least-recently-updated active tasks with work to do,
 *  excluding any already in flight. Same per-project-first ordering as the
 *  original single-task picker (drains one project's candidates before
 *  moving to the next), just returning a batch instead of one. */
function pickNextTasks(limit: number): Array<{ task: TaskRow; project: ProjectRow }> {
  const picked: Array<{ task: TaskRow; project: ProjectRow }> = [];
  for (const project of listProjects()) {
    const candidates = listTasks({ projectId: project.id })
      .filter(
        (t) =>
          (t.stage === "intake" || t.stage === "refining") &&
          (t.paused ?? 0) === 0 &&
          !inFlightTasks.has(t.task_id),
      )
      .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
    for (const task of candidates) {
      picked.push({ task, project });
      if (picked.length >= limit) return picked;
    }
  }
  return picked;
}

/** Run one role-step's worth of work for `taskId` — the per-task body a round
 *  dispatches once it's picked a task. Registers/deregisters the task in
 *  `inFlightTasks` for the duration and funnels through `serializeTask` so it
 *  can never overlap a restore or answer-reincorporation for the same task. */
function dispatchTask(taskId: string): Promise<void> {
  const running = serializeTask(taskId, () => runTaskStepOnce(taskId));
  inFlightTasks.set(taskId, running);
  return running.finally(() => {
    if (inFlightTasks.get(taskId) === running) inFlightTasks.delete(taskId);
  });
}

/** Do one unit of work for a single already-picked task: ensure a plan,
 *  consume interventions, then advance (or finalize) the next step. Extracted
 *  from the old single-task `tickOnce` body so it can be dispatched for
 *  several tasks concurrently. */
async function runTaskStepOnce(taskId: string): Promise<void> {
  let task = getTask(taskId);
  if (!task) return;
  const project = task.project_id != null ? getProject(task.project_id) : undefined;
  if (!project) return;

  // Ensure a plan; intake → refining on first plan.
  let plan = readPlan(task);
  if (!plan) {
    plan = planFromTemplate((task.intake_kind as IntakeKind) || "manual", task.network_id);
    // Fold any promoted project roles for this kind into the plan.
    plan = withPromotedRoles(project, task, plan);
    updateTask(task.task_id, { refinement_plan_json: JSON.stringify(plan), stage: "refining" });
    task = getTask(task.task_id)!;
    publish(task.task_id, "task_update", { stage: "refining" });
  }

  // Consume interventions (may pause / mutate plan).
  const consumed = consumeInterventions(task, plan);
  plan = consumed.plan;
  if (consumed.paused) return;
  task = getTask(task.task_id)!;

  // Determine the next step. If the plan has edge routing data and at least one
  // role has already run, use edge conditions to bias routing. Otherwise fall
  // back to linear order (first step, or tasks with no network graph).
  const runs = listRoleRuns(task.task_id);
  const lastRun = runs[runs.length - 1];
  const context = lastRun ? buildEdgeContext(lastRun, task.task_id) : undefined;

  const step = lastRun ? nextStep(plan, lastRun.role_key, context) : nextPending(plan);

  if (!step) {
    // No pending steps but not terminal — finalize as ready to avoid wedging.
    const routerCfg = getRouterCfg(project);
    await applyGate(task, project, plan, { role: "", status: "done", depth: 1 }, "pass", rollupCoverage(task.task_id), [], routerCfg);
    return;
  }

  await runOneStep(task, project, step, plan);
}

/** Ingest new intakes across every project, then dispatch up to `limit` free
 *  task slots. Returns true if any work (ingest or a dispatched step) happened.
 *  `tick()` (manual /api/tick, tests) calls this with limit 1, preserving its
 *  old one-task-per-call contract; the scheduler loop calls it with the
 *  configured concurrency cap. */
export async function tickOnce(limit: number): Promise<boolean> {
  let ingested = 0;
  for (const project of listProjects()) ingested += ingestProject(project);

  const freeSlots = limit - inFlightTasks.size;
  if (freeSlots <= 0) return ingested > 0;

  const picked = pickNextTasks(freeSlots);
  if (!picked.length) return ingested > 0;

  await Promise.all(picked.map((p) => dispatchTask(p.task.task_id)));
  return true;
}

export function tick(): Promise<boolean> {
  return tickOnce(1);
}

/**
 * Roll a task back to the checkpoint left by one of its primary role runs:
 * hard-resets the task's branch to that run's commit, discards every role_run
 * (and unconsumed intervention) recorded after it, and recomputes the plan's
 * step statuses from what survives — so the task resumes right after the
 * restored-to role, as if everything after it never happened.
 *
 * Serialized through `serializeTask` so a restore can never race a step
 * already running for the same task.
 */
export function restoreCheckpoint(taskId: string, roleRunId: number): Promise<void> {
  return serializeTask(taskId, () => doRestoreCheckpoint(taskId, roleRunId));
}

async function doRestoreCheckpoint(taskId: string, roleRunId: number): Promise<void> {
  const run = getRoleRun(roleRunId);
  if (!run || run.task_id !== taskId) throw new Error("checkpoint not found for this task");
  if (run.run_kind !== "primary") throw new Error("can only restore to a primary role run");
  if (!run.git_commit_sha) throw new Error("this run has no checkpoint commit to restore to");

  let task = getTask(taskId);
  if (!task) throw new Error("task not found");
  if (!task.git_branch) throw new Error("task has no checkpoint branch to restore");
  const branch = task.git_branch;
  const project = task.project_id != null ? getProject(task.project_id) : undefined;
  if (!project) throw new Error("project not found for task");

  // Recreate the worktree if it was removed (e.g. by a prior reset) — the
  // branch itself always survives, so this just re-attaches to it.
  task = ensureTaskWorkspace(task, project);
  const repoPath = taskRepoPath(task, project);
  checkoutBranch(repoPath, branch);
  resetHardTo(repoPath, run.git_commit_sha);

  deleteRoleRunsAfter(taskId, run.id);
  deleteUnconsumedInterventionsAfter(taskId, run.created_at);

  // Recompute step status/attempts from the surviving primary runs rather than
  // mutating the plan array positionally — robust against loopback re-runs,
  // which reuse a step entry instead of appending a new one.
  const survivorCounts = new Map<string, number>();
  for (const r of listRoleRuns(taskId)) {
    if (r.run_kind === "primary") survivorCounts.set(r.role_key, (survivorCounts.get(r.role_key) ?? 0) + 1);
  }
  const plan = readPlan(task);
  if (plan) {
    for (const step of plan.steps) {
      const count = survivorCounts.get(step.role) ?? 0;
      step.status = count > 0 ? "done" : "pending";
      step.attempts = count > 0 ? count - 1 : undefined;
    }
  }

  updateTask(taskId, {
    refinement_plan_json: plan ? JSON.stringify(plan) : null,
    stage: "refining",
    exit_state: null,
    review_reason: null,
    recap_md: null,
    paused: 0,
  });

  createIntervention({
    task_id: taskId,
    kind: "restore_checkpoint",
    payload_json: JSON.stringify({ role_run_id: run.id, role_key: run.role_key }),
    created_by: "user",
  });

  publish(taskId, "task_update", { stage: "refining", restored: true });
}

/**
 * Auto-reincorporation: called whenever a `question_answer` intervention is
 * recorded for a task already sitting at `stage: review`. A task still
 * `refining` doesn't need this — its next role step reads answered questions
 * as ordinary context (see `answeredQuestions`) with no rollback involved.
 *
 * Finds the role_run whose guessed `open_questions` contains a matching
 * question still marked "assumed", and asks the router (Call Point 5) whether
 * the human's answer confirms or contradicts that guess:
 *  - confirms: mark the guess "confirmed" — a silent no-op otherwise, since the
 *    downstream work built on it is still valid.
 *  - contradicts: mark it "invalidated" and roll the task back to right after
 *    that guess via the existing checkpoint-restore machinery, with the real
 *    answer injected as a steer note for the re-run.
 *
 * Only ever restores the ONE task the question belongs to — per-project
 * decomposition children spawned off this task are left untouched, just
 * flagged (`markChildrenStale`) for a human to triage.
 *
 * Serialized through `serializeTask` so this can never race a scheduler step
 * or a manual restore mutating the same task.
 */
export function reincorporateAnswer(taskId: string, question: string, answer: string): Promise<void> {
  return serializeTask(taskId, () => doReincorporateAnswer(taskId, question, answer));
}

async function doReincorporateAnswer(taskId: string, question: string, answer: string): Promise<void> {
  const task = getTask(taskId);
  if (!task || task.stage !== "review") return; // manual restore required first once "ready"
  const project = task.project_id != null ? getProject(task.project_id) : undefined;
  if (!project) return;

  const routerCfg = getRouterCfg(project);
  if (!routerCfg?.answerReincorporation) return;

  const norm = question.trim().toLowerCase();
  if (!norm) return;

  // Most-recent-first: a re-asked question resolves against its latest guess.
  const runs = listRoleRuns(taskId);
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i]!;
    const questions = parseOpenQuestions(run.open_questions_json);
    const idx = questions.findIndex(
      (q) => q.resolved === "assumed" && q.question.trim().toLowerCase() === norm,
    );
    if (idx === -1) continue;

    const guess = questions[idx]!;
    const { modelId } = resolveConnectionForModel(task.model || project.default_model || null, project.id);

    let matches: boolean;
    try {
      const assessment = await assessAnswerMatch(
        { question: guess.question, assumedAnswer: guess.assumed_answer, confidence: guess.confidence, humanAnswer: answer },
        roleRunner,
        taskRepoPath(task, project),
        project.planning_dir || "PLANNING",
        modelId,
      );
      matches = assessment.decision === "confirms";
    } catch (err) {
      console.warn(
        `[orchestrator] answer-match assessment failed for task ${taskId.slice(0, 8)}: ${(err as Error).message}`,
      );
      matches = false; // never silently keep a possibly-wrong guess on assessment failure
    }

    questions[idx] = { ...guess, resolved: matches ? "confirmed" : "invalidated" };
    setRoleRunOpenQuestions(run.id, JSON.stringify(questions));

    if (!matches && run.git_commit_sha) {
      // Restore FIRST — it discards every unconsumed intervention created after
      // this run (including the very question_answer that triggered this), so
      // the corrected-answer steer note must be created only after it settles.
      await doRestoreCheckpoint(taskId, run.id);
      createIntervention({
        task_id: taskId,
        kind: "steer_note",
        payload_json: JSON.stringify({
          text:
            `[auto-reincorporation] "${guess.question}" was answered "${answer}", which contradicts ` +
            `the earlier guess ("${guess.assumed_answer || "(no guess recorded)"}"). Use the corrected ` +
            `answer, not the earlier guess.`,
        }),
        created_by: "router",
      });
      markChildrenStale(task, run.role_key);
    }
    return;
  }
}

/**
 * Flag any already-spawned decomposition children of `task` as possibly stale
 * after an auto-restore invalidated an assumption `raisingRole` made — most
 * relevant when that role was the `decomposition` step itself, since children
 * are independent tasks with no dependency edge back to the parent's plan, so
 * they can't be rolled back automatically. Surfaced for human triage only; see
 * client's stale-child banner.
 */
function markChildrenStale(task: TaskRow, raisingRole: string): void {
  const children = listTasks({ parentTaskId: task.task_id });
  if (!children.length) return;
  for (const child of children) {
    updateTask(child.task_id, {
      stale_reason: `Parent task's "${raisingRole}" assumption changed after a later answer — re-check this child is still accurate.`,
    });
    publish(child.task_id, "task_update", { stage: child.stage, stale: true });
  }
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
let stopping = false;
let loopHandle: Promise<void> | undefined;

/** Start the daemon heartbeat. Idempotent. Each round dispatches up to
 *  `maxConcurrentTasks` tasks concurrently (each in its own worktree) via
 *  `tickOnce`, and waits for the whole round before starting the next. */
export function startScheduler(): void {
  if (!stopped) return;
  stopped = false;
  stopping = false;
  loopHandle = (async () => {
    while (!stopped) {
      let didWork = false;
      try {
        didWork = await tickOnce(getConfig().maxConcurrentTasks);
      } catch (err) {
        console.error(`[orchestrator] tick error: ${(err as Error).message}`);
      }
      await sleep(didWork ? 50 : getConfig().schedulerIdleMs);
    }
    stopping = false;
    console.log("[orchestrator] scheduler stopped");
  })();
  console.log("[orchestrator] scheduler started");
}

/** Signal the loop to stop and abort every in-progress task. Non-blocking:
 *  sets the stop flags immediately and fires every active abort controller —
 *  now that several tasks can run at once, all of them, not just one. The
 *  current round unwinds naturally (each agent session is cancelled), then
 *  the loop exits on the next `while (!stopped)` check. */
export function stopScheduler(): void {
  if (stopped) return;
  stopped = true;
  stopping = true;
  for (const ac of activeAborts.values()) ac.abort();
}

export function isSchedulerRunning(): boolean {
  return !stopped && !stopping;
}

export function isSchedulerStopping(): boolean {
  return stopping;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}