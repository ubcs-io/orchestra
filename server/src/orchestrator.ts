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
export interface RefinementPlan {
  steps: PlanStep[];
}

/** Resolve the flow template for a task from its intake kind. */
function flowForTask(task: TaskRow): FlowTemplate {
  return flowForIntake((task.intake_kind as IntakeKind) || "manual");
}

function readPlan(task: TaskRow): RefinementPlan | null {
  if (!task.refinement_plan_json) return null;
  try {
    return JSON.parse(task.refinement_plan_json) as RefinementPlan;
  } catch {
    return null;
  }
}

export function planFromTemplate(kind: IntakeKind): RefinementPlan {
  const roles = flowForIntake(kind).steps;
  return { steps: roles.map((role) => ({ role, status: "pending", depth: 1 })) };
}

export function nextPending(plan: RefinementPlan): PlanStep | undefined {
  return plan.steps.find((s) => s.status === "pending");
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
    // A role failure must not crash the daemon; record it and escalate to review.
    const msg = (err as Error).message;
    const aborted = ac.signal.aborted || msg === "AbortError" || msg.includes("aborted");
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
  createRoleRun({
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
  applyGate(task, project, plan, step, findings.verdict, coverage, findings.criteria_results ?? []);
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

function applyGate(
  task: TaskRow,
  project: ProjectRow,
  plan: RefinementPlan,
  step: PlanStep,
  verdict: string,
  coverage: CoverageMap,
  criteriaResults: CriteriaResult[] = [],
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

  /** Fire-and-forget: generate a recap for a task that just reached terminal state. */
  const triggerRecap = (finalCoverage: CoverageMap, finalCriteria: CriteriaResult[]) => {
    generateRecap(task, project, listRoleRuns(task.task_id), finalCoverage, finalCriteria).then(
      (recapMd) => {
        if (recapMd) updateTask(task.task_id, { recap_md: recapMd });
      },
    );
  };

  if (verdict === "needs_human") {
    escalate(`Role ${step.role} flagged an ambiguity requiring human judgement.`);
    triggerRecap(coverage, criteriaResults);
    return;
  }
  if (verdict === "blocker") {
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
      const level = task.level ?? "task";
      const roleCfg = getRole(project.id, step.role);
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
