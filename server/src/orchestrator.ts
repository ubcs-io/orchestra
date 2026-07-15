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
  getNetwork,
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
  type RoleRunRow,
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
  flowForIntake,
  TERMINAL_ROLE,
  type ExitKind,
  type FlowTemplate,
  type IntakeKind,
} from "./roles.js";
import {
  runRole as defaultRunRole,
  type CoverageItem,
  type CoverageStatus,
  type CriteriaResult,
  type RoleRunResult,
  type RunRoleParams,
} from "./agent.js";
import { getConfig } from "./config.js";
import { resolveConnection } from "./settings.js";
import {
  resolveRouterConfig,
  distillQuestions,
  assessEscalation,
  assessBorderline,
  type RouterConfig,
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
  } else if (kind === "rerun_role" || kind === "deepen") {
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

function artifactName(task: TaskRow): string {
  const shortId = task.task_id.slice(0, 8);
  const safe = (task.name ?? "task").replace(/[^a-z0-9._-]+/gi, "-").slice(0, 40);
  const base = safe.replace(/\.md$/i, "");
  return `${base}-${shortId}.md`;
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
      case "rerun_role":
      case "deepen":
        applyPlanMutation(plan, iv.kind, p, (r) => isTerminalRole(task, r));
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

/** Resolve router config for a project, returning null if the router is disabled. */
function getRouterCfg(project: ProjectRow): RouterConfig | null {
  const cfg = resolveRouterConfig(project.config_json);
  return cfg.enabled ? cfg : null;
}

// ---------------------------------------------------------------------------
// Context building
// ---------------------------------------------------------------------------

function buildRoleContext(task: TaskRow, roleKey: string, twoPhase = false): string {
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
  } else {
    parts.push(
      `\n## Your task now\nYou are the **${roleKey}** role. Inspect the repository, do your part, then finish ` +
        `by invoking \`record_findings\` directly as a tool call. Do not describe or announce the call in plain ` +
        `text first — just make it.`,
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
  rawQuestions: string[],
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
    try {
      const qs = JSON.parse(run.open_questions_json ?? "[]") as string[];
      for (const q of qs) {
        if (!allPrior.some((p) => p.question === q)) {
          allPrior.push({ question: q, answer: null });
        }
      }
    } catch {
      /* skip */
    }
  }

  const conn = resolveConnection(project.id);
  const modelId = task.model || project.default_model || conn.defaultModelId;

  // Fire-and-forget — do not await
  distillQuestions(
    {
      taskName: task.name ?? task.task_id.slice(0, 8),
      intakeKind: task.intake_kind ?? "manual",
      roleKey: "", // filled from the run that was just created
      rawQuestions,
      priorQuestions: allPrior.slice(0, 50), // cap at 50 prior questions
    },
    roleRunner,
    project.repo_path,
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
  const conn = resolveConnection(project.id);
  const planningDir = project.planning_dir || "PLANNING";
  const role = getRole(project.id, step.role) ?? getRole(null, step.role);
  if (!role || !role.system_prompt) {
    // Unknown role — skip it so the loop can't wedge.
    step.status = "skipped";
    updateTask(task.task_id, { refinement_plan_json: JSON.stringify(plan) });
    return;
  }

  const tools: string[] = role.tools_json ? (JSON.parse(role.tools_json) as string[]) : [];
  const modelId = role.model || task.model || project.default_model || conn.defaultModelId;
  const relArtifact = task.artifact_path ?? path.join(planningDir, "REFINING", artifactName(task));
  const absArtifact = path.join(project.repo_path, relArtifact);

  publish(task.task_id, "role_start", { role: step.role, depth: step.depth });

  let result;
  const ac = new AbortController();
  activeAbort = ac;
  try {
    result = await roleRunner({
      repoPath: project.repo_path,
      planningDir,
      artifactAbsPath: absArtifact,
      modelId,
      systemPrompt: role.system_prompt,
      tools,
      context: buildRoleContext(task, step.role, conn.twoPhase),
      thinkingLevel: conn.reasoning ? conn.thinkingLevel : undefined,
      textMode: conn.textMode,
      twoPhase: conn.twoPhase,
      onEvent: (ev) => publish(task.task_id, ev.type as never, ev),
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

    publish(task.task_id, "role_end", { role: step.role, error: true, aborted });
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
    activeAbort = null;
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

  publish(task.task_id, "role_end", {
    role: step.role,
    verdict: findings.verdict,
    fallback: result.fallback,
    stopReason: result.stopReason,
    tokens: result.tokens,
  });

  // Gate.
  await applyGate(task, project, plan, step, findings.verdict, coverage, findings.criteria_results ?? [], routerCfg);
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
  const conn = resolveConnection(project.id);
  const modelId = task.model || project.default_model || conn.defaultModelId;
  const planningDir = project.planning_dir || "PLANNING";
  const context = buildRecapContext(task, project, runs, coverage, criteriaResults);

  try {
    const result = await roleRunner({
      repoPath: project.repo_path,
      planningDir,
      artifactAbsPath: path.join(project.repo_path, planningDir, "REFINING", `${task.task_id.slice(0, 8)}.md`),
      modelId,
      systemPrompt:
        "You are the orchestration layer performing a final recap of a multi-role refinement pipeline. " +
        "You receive structured findings from every role that ran and produce a concise, " +
        "actionable final status summary in well-formatted Markdown. " +
        "Do NOT use any tools — simply read the context and produce the recap text directly. " +
        "Do not describe what you are doing; just produce the recap.",
      tools: [],
      context,
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

  const conn = resolveConnection(project.id);
  const modelId = task.model || project.default_model || conn.defaultModelId;

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
      project.repo_path,
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

  const conn = resolveConnection(project.id);
  const modelId = task.model || project.default_model || conn.defaultModelId;

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
      project.repo_path,
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

async function applyGate(
  task: TaskRow,
  project: ProjectRow,
  plan: RefinementPlan,
  step: PlanStep,
  verdict: string,
  coverage: CoverageMap,
  criteriaResults: CriteriaResult[] = [],
  routerCfg: RouterConfig | null = null,
): Promise<void> {
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

  /** Fire-and-forget: generate a recap for a task that just reached terminal state. */
  const triggerRecap = (finalCoverage: CoverageMap, finalCriteria: CriteriaResult[]) => {
    generateRecap(task, project, listRoleRuns(task.task_id), finalCoverage, finalCriteria).then(
      (recapMd) => {
        if (recapMd) updateTask(task.task_id, { recap_md: recapMd });
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
    escalate(`Role ${step.role} flagged an ambiguity requiring human judgement.`);
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
    escalate(`Role ${step.role} reported a blocker.`);
    triggerRecap(coverage, criteriaResults);
    return;
  }

  // Counter-reviewer gate: verify prior output against the flow's acceptance
  // criteria. On failure, re-route (bounded loop-back) to the responsible roles;
  // once loop-backs are exhausted, escalate to a human.
  const flow = flowForTask(task);
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
              (unmetMust.length ? ` Unmet: ${unmetMust.map((c) => c.id).join(", ")}.` : "") +
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
        (unmetMust.length ? ` Unmet: ${unmetMust.map((c) => c.id).join(", ")}.` : "") +
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
        createDecompositionChildren(task, project);
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
    const child = createTask({
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

    // Write a minimal intake artifact so the child follows the normal pipeline.
    const artName = artifactName(child);
    const relArtifact = path.join(planningDir, "REFINING", artName);
    const absArtifact = path.join(project.repo_path, relArtifact);
    writeArtifact(
      absArtifact,
      `# ${node.name}\n\n> Child of: **${parentName}** · level: \`${node.level}\`\n\n## Problem\n\n${node.name}\n`,
    );
    updateTask(child.task_id, { artifact_path: relArtifact });
    commitArtifacts(project.repo_path, [relArtifact], `intake(child): ${node.name}`);
    publish(child.task_id, "task_update", { stage: "intake" });
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
    plan = planFromTemplate(
      (task.intake_kind as IntakeKind) || "manual",
      task.network_id,
    );
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

  // Determine the next step. If the plan has edge routing data and at least one
  // role has already run, use edge conditions to bias routing. Otherwise fall
  // back to linear order (first step, or tasks with no network graph).
  const runs = listRoleRuns(task.task_id);
  const lastRun = runs[runs.length - 1];
  const context = lastRun ? buildEdgeContext(lastRun, task.task_id) : undefined;

  const step = lastRun
    ? nextStep(plan, lastRun.role_key, context)
    : nextPending(plan);

  if (!step) {
    // No pending steps but not terminal — finalize as ready to avoid wedging.
    const routerCfg = getRouterCfg(project);
    await applyGate(task, project, plan, { role: "", status: "done", depth: 1 }, "pass", rollupCoverage(task.task_id), [], routerCfg);
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
let stopping = false;
let loopHandle: Promise<void> | undefined;
/** Abort controller for the in-progress tick — set by stopScheduler() to hard-cut a stuck agent. */
let activeAbort: AbortController | null = null;

/** Start the daemon heartbeat. Idempotent. tick() is self-serializing. */
export function startScheduler(): void {
  if (!stopped) return;
  stopped = false;
  stopping = false;
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
    stopping = false;
    console.log("[orchestrator] scheduler stopped");
  })();
  console.log("[orchestrator] scheduler started");
}

/** Signal the loop to stop and abort the in-progress tick. Non-blocking:
 *  sets the stop flags immediately and fires the abort controller. The
 *  current tick unwinds naturally (agent session is cancelled), then the
 *  loop exits on the next `while (!stopped)` check. */
export function stopScheduler(): void {
  if (stopped) return;
  stopped = true;
  stopping = true;
  activeAbort?.abort();
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