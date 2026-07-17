/**
 * Strategic LLM Routing Advisors ("Call-Point Router").
 *
 * The orchestrator remains a deterministic state machine. This module provides
 * optional, narrowly-scoped LLM calls at specific decision points where
 * structured heuristics are weakest. Each call point:
 *
 * - Receives structured input (verdict, coverage, criteria, summaries)
 * - Returns structured, actionable JSON
 * - Is advisory — the orchestrator validates and owns the final decision
 * - Has a hard timeout and falls back to the heuristic default on failure
 * - Is independently configurable and testable via the seam pattern
 *
 * Call Point 1 — Question Distillation (after a role produces open_questions)
 * Call Point 2 — Escalation Assessment (before escalating to human REVIEW)
 * Call Point 3 — Borderline Gate Assessment (partial criteria, near-exhaustion)
 * Call Point 4 — Second Review (authoritative synthesis of a step's primary run
 *                 + its adversarial critique, run after every critiqued step)
 * Call Point 5 — Answer Match Assessment (a human's later answer to a role's
 *                 recorded best-effort guess — confirms it, or contradicts it
 *                 and should roll the task back to right after the guess)
 */

import type { RoleRunner, PlanStep, CoverageMap as OrchestratorCoverageMap } from "./orchestrator.js";
import type { CriteriaResult } from "./agent.js";

// Re-export CoverageMap so callers don't need the orchestrator type.
export type CoverageMap = OrchestratorCoverageMap;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface RouterConfig {
  /** Master kill-switch. When false, all call points fall through to heuristics. */
  enabled: boolean;
  /** Call Point 1: distill + deduplicate open questions. */
  questionDistillation: boolean;
  /** Call Point 2: assess whether escalation to human review is truly needed. */
  escalationAssessment: boolean;
  /** Call Point 3: assess borderline gate decisions (partial criteria, last loop-back). */
  borderlineGateAssessment: boolean;
  /** Call Point 4: authoritative second review synthesizing a step's primary run + critique. */
  secondReview: boolean;
  /** Call Point 5: compare a human's later answer against a role's recorded guess,
   *  and roll the task back to right after the guess if it was wrong. */
  answerReincorporation: boolean;
  /** Override model for router calls (falls back to project connection default). */
  model?: string;
  /** Token budget per router call. Default 1024. */
  maxTokens?: number;
  /** Per-call timeout in ms. Default 15000. */
  timeoutMs?: number;
}

export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  enabled: false,
  questionDistillation: false,
  escalationAssessment: false,
  borderlineGateAssessment: false,
  secondReview: false,
  answerReincorporation: false,
};

/** Resolve router config from a project's config_json or return defaults. */
export function resolveRouterConfig(projectConfigJson: string | null): RouterConfig {
  if (!projectConfigJson) return { ...DEFAULT_ROUTER_CONFIG };
  try {
    const parsed = JSON.parse(projectConfigJson) as { router?: Partial<RouterConfig> };
    return { ...DEFAULT_ROUTER_CONFIG, ...parsed.router };
  } catch {
    return { ...DEFAULT_ROUTER_CONFIG };
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Extract JSON from an LLM text response (handles markdown code blocks).
 *  Tolerates trailing text / commentary after a valid JSON root object. */
function extractJson<T>(text: string): T {
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (jsonMatch?.[1] ?? text).trim();
  try {
    return JSON.parse(raw) as T;
  } catch (firstErr) {
    // Handle trailing non-whitespace after a valid root object.
    // Models sometimes append commentary after the JSON block.
    if (
      firstErr instanceof SyntaxError &&
      firstErr.message.includes("after JSON")
    ) {
      // Walk backwards from the end, truncating one character at a time,
      // until a valid parse is found. Prefer closing brace/brace-style roots.
      for (let i = raw.length - 1; i > 0; i--) {
        try {
          return JSON.parse(raw.slice(0, i)) as T;
        } catch {
          continue;
        }
      }
    }
    throw firstErr;
  }
}

/** Run a router LLM call through the roleRunner seam and parse the result. */
async function routerCall<T>(
  roleRunner: RoleRunner,
  repoPath: string,
  planningDir: string,
  modelId: string,
  systemPrompt: string,
  userPrompt: string,
  signal: AbortSignal,
): Promise<T> {
  const result = await roleRunner({
    repoPath,
    planningDir,
    artifactAbsPath: "",
    modelId,
    systemPrompt,
    tools: [],
    context: userPrompt,
    signal,
  });

  return extractJson<T>(result.findings.section_md || result.findings.summary || "{}");
}

// ---------------------------------------------------------------------------
// Call Point 1: Question Distillation
// ---------------------------------------------------------------------------

export interface QuestionDistillationInput {
  taskName: string;
  intakeKind: string;
  roleKey: string;
  rawQuestions: string[];
  priorQuestions: Array<{ question: string; answer: string | null }>;
}

export interface DistilledQuestion {
  text: string;
  context: string | null;
  priority: "high" | "medium" | "low";
  duplicate_of: string | null;
  suggested_answer: string | null;
}

export interface DistillationResult {
  questions: DistilledQuestion[];
  merged_count: number;
  dropped_duplicates: number;
}

const DISTILL_SYSTEM_PROMPT = `You are a question editor for an automated code refinement pipeline.
Your job is to clean, deduplicate, and prioritize questions that role agents ask of humans.

Rules:
- Merge questions that ask the same thing in different words.
- Remove questions that are purely rhetorical or already answered in the context.
- Preserve important technical context (file paths, line numbers, variable names).
- Assign priority: "high" for blocking/safety questions, "medium" for design decisions, "low" for nice-to-know.
- If a question has an obvious answer based on common conventions or the context, provide a suggested_answer.
- Be concise — each question text should be one clear sentence.
- Do NOT answer questions that require human judgement — only suggest answers for factual/trivial questions.

Respond ONLY with valid JSON matching this schema — no markdown, no explanation outside the JSON:
{
  "questions": [
    {
      "text": "cleaned question text",
      "context": "relevant file/line or null",
      "priority": "high" | "medium" | "low",
      "duplicate_of": null,
      "suggested_answer": "suggested answer or null"
    }
  ],
  "merged_count": 0,
  "dropped_duplicates": 0
}`;

function buildDistillPrompt(input: QuestionDistillationInput): string {
  const prior = input.priorQuestions.length
    ? input.priorQuestions
        .map((q) => `- Q: ${q.question}\n  A: ${q.answer ?? "(unanswered)"}`)
        .join("\n")
    : "(none)";

  return `Task: ${input.taskName} (${input.intakeKind})
Role: ${input.roleKey}

## Previously asked questions
${prior}

## New questions from this role
${input.rawQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")}

Distill the new questions: merge duplicates (across both new and prior), assign priority, and suggest answers for factual questions.`;
}

async function defaultDistill(
  input: QuestionDistillationInput,
  roleRunner: RoleRunner,
  repoPath: string,
  planningDir: string,
  modelId: string,
): Promise<DistillationResult> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const json = await routerCall<DistillationResult>(
      roleRunner,
      repoPath,
      planningDir,
      modelId,
      DISTILL_SYSTEM_PROMPT,
      buildDistillPrompt(input),
      controller.signal,
    );

    clearTimeout(timeout);

    if (!Array.isArray(json.questions)) throw new Error("missing questions array");
    return json;
  } catch (err) {
    console.warn(`[router] question distillation failed: ${(err as Error).message}`);
    return {
      questions: input.rawQuestions.map((q) => ({
        text: q,
        context: null,
        priority: "medium" as const,
        duplicate_of: null,
        suggested_answer: null,
      })),
      merged_count: 0,
      dropped_duplicates: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Call Point 2: Escalation Assessment
// ---------------------------------------------------------------------------

export interface EscalationAssessmentInput {
  taskName: string;
  intakeKind: string;
  escalationReason: string;
  lastRoleKey: string;
  lastVerdict: string;
  lastSummary: string;
  allRuns: Array<{ role_key: string; verdict: string; summary: string }>;
  coverageMap: Record<string, { status: string; note?: string }>;
  criteriaResults: CriteriaResult[];
  loopbacksRemaining: number;
  availableRoles: string[];
  planSteps: PlanStep[];
}

export type EscalationDecision = "escalate" | "reroute" | "rerun" | "close";

export interface EscalationAssessmentResult {
  decision: EscalationDecision;
  reasoning: string;
  action?: {
    role?: string;
    after?: string;
    steer_note?: string;
  };
  human_review_still_needed_after?: boolean;
}

const ESCALATION_SYSTEM_PROMPT = `You are a routing decision assistant for an automated code refinement pipeline.
Your job is to assess whether a task flagged for human review can instead be resolved by another specialized role agent.

Available decisions:
- "escalate": Human review is genuinely required (fundamental ambiguity, policy decision, safety concern).
- "reroute": Inject a specific role from the available list to address the issue. Provide the role key, insertion point, and a focused steer note.
- "rerun": Re-run the current role with deeper analysis. Provide a steer note with specific guidance.
- "close": The issue is minor or non-blocking; the pipeline can proceed. Override the verdict to pass.

Guidelines:
- If the blocker/needs_human is a specific technical finding (e.g., deprecated algorithm, missing file), prefer reroute or rerun.
- If the issue is genuinely ambiguous (unclear requirements, conflicting stakeholder needs), escalate.
- If a role says "needs_human" but provides a clear description of the problem that another available role can analyze, reroute.
- NEVER close a genuine security vulnerability, privacy violation, or safety issue.

Respond ONLY with valid JSON matching this schema — no markdown, no explanation outside the JSON:
{
  "decision": "escalate" | "reroute" | "rerun" | "close",
  "reasoning": "brief explanation of the decision",
  "action": {
    "role": "role_key (for reroute only)",
    "after": "insert after this role (for reroute only, omit for end of plan)",
    "steer_note": "specific guidance text for the role"
  },
  "human_review_still_needed_after": true | false
}

The "action" field is required for "reroute" and "rerun" decisions. Omit it for "escalate" and "close".`;

function buildEscalationPrompt(input: EscalationAssessmentInput): string {
  const runs = input.allRuns
    .map((r) => `- **${r.role_key}** (${r.verdict}): ${r.summary}`)
    .join("\n");

  const coverage = Object.entries(input.coverageMap)
    .map(([k, v]) => `- ${k}: ${v.status}${v.note ? ` (${v.note})` : ""}`)
    .join("\n");

  const criteria = input.criteriaResults.length
    ? input.criteriaResults
        .map((c) => `- [${c.status}] \`${c.id}\`: ${c.note ?? "(no note)"}`)
        .join("\n")
    : "(none)";

  return `Task: ${input.taskName} (${input.intakeKind})
Escalation reason: ${input.escalationReason}

## Last completed role
- Role: ${input.lastRoleKey}
- Verdict: ${input.lastVerdict}
- Summary: ${input.lastSummary}

## All role runs
${runs}

## Coverage map
${coverage}

## Criteria results
${criteria}

## Plan state
- Loopbacks remaining: ${input.loopbacksRemaining}
- Plan steps: ${input.planSteps.map((s) => `${s.role} (${s.status})`).join(" → ")}

## Available roles for rerouting
${input.availableRoles.join(", ")}

Assess whether this task truly needs human review or can be resolved by another role.`;
}

async function defaultAssessEscalation(
  input: EscalationAssessmentInput,
  roleRunner: RoleRunner,
  repoPath: string,
  planningDir: string,
  modelId: string,
): Promise<EscalationAssessmentResult> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const json = await routerCall<EscalationAssessmentResult>(
      roleRunner,
      repoPath,
      planningDir,
      modelId,
      ESCALATION_SYSTEM_PROMPT,
      buildEscalationPrompt(input),
      controller.signal,
    );

    clearTimeout(timeout);

    if (!["escalate", "reroute", "rerun", "close"].includes(json.decision)) {
      throw new Error(`invalid decision: ${json.decision}`);
    }
    return json;
  } catch (err) {
    console.warn(`[router] escalation assessment failed: ${(err as Error).message}`);
    return {
      decision: "escalate",
      reasoning: "Router assessment failed — falling back to human review.",
    };
  }
}

// ---------------------------------------------------------------------------
// Call Point 3: Borderline Gate Assessment
// ---------------------------------------------------------------------------

export interface BorderlineAssessmentInput {
  taskName: string;
  intakeKind: string;
  reviewerRole: string;
  reviewerVerdict: string;
  allCriteria: Array<{
    id: string;
    text: string;
    severity: "must" | "should";
    status: string;
    note: string | null;
    ownerRole: string;
  }>;
  unmetMust: Array<{ id: string; text: string; ownerRole: string; note: string | null }>;
  missingConcerns: string[];
  loopbackCount: number;
  maxLoopbacks: number;
  ownerRolesSummaries: Array<{ role_key: string; summary: string }>;
  coverageMap: Record<string, { status: string }>;
}

export type BorderlineDecision = "loopback" | "proceed" | "proceed_with_note" | "escalate" | "narrow_loopback";

export interface BorderlineAssessmentResult {
  decision: BorderlineDecision;
  reasoning: string;
  override_unmet?: string[];
  steer_note?: string;
  target_roles?: string[];
}

const BORDERLINE_SYSTEM_PROMPT = `You are a quality-gate decision assistant for an automated code refinement pipeline.
Your job is to assess whether unmet acceptance criteria after a reviewer pass warrant another loop-back or can be accepted.

Available decisions:
- "loopback": Re-run the owner roles (default behavior). The criteria gaps are substantive.
- "proceed": Override the unmet criteria and continue to the terminal role. The gaps are minor.
- "proceed_with_note": Proceed to the terminal role but inject a steer note flagging the gaps for the final output.
- "escalate": Skip the remaining loop-back and go straight to human review. The gap is fundamental.
- "narrow_loopback": Re-run only specific owner roles (not all) with a targeted prompt.

Guidelines:
- If a criterion is marked "partial" with a note indicating the gap is minor (missing detail, documentation nuance), prefer proceed or proceed_with_note.
- If a criterion is fully "unmet" with no progress, prefer loopback.
- If this is the last loop-back and the gap is small, prefer proceed_with_note — another loop-back won't help.
- If the gap is fundamental (wrong architecture, missing security analysis), escalate.
- Safety/security/privacy "must" criteria that are unmet should NEVER be overridden with "proceed".

Respond ONLY with valid JSON matching this schema — no markdown, no explanation outside the JSON:
{
  "decision": "loopback" | "proceed" | "proceed_with_note" | "escalate" | "narrow_loopback",
  "reasoning": "brief explanation",
  "override_unmet": ["c1", "c2"],
  "steer_note": "guidance for terminal role or re-run roles",
  "target_roles": ["role_key"]
}

"override_unmet" is required for "proceed" and "proceed_with_note".
"steer_note" is required for "proceed_with_note" and "narrow_loopback".
"target_roles" is required for "narrow_loopback".`;

function buildBorderlinePrompt(input: BorderlineAssessmentInput): string {
  const criteria = input.allCriteria
    .map((c) => `- [${c.severity}] \`${c.id}\` (${c.status}): ${c.text}${c.note ? ` — ${c.note}` : ""} [owner: ${c.ownerRole}]`)
    .join("\n");

  const owners = input.ownerRolesSummaries
    .map((o) => `- **${o.role_key}**: ${o.summary}`)
    .join("\n");

  const coverage = Object.entries(input.coverageMap)
    .map(([k, v]) => `- ${k}: ${v.status}`)
    .join("\n");

  return `Task: ${input.taskName} (${input.intakeKind})
Reviewer: ${input.reviewerRole} — verdict: ${input.reviewerVerdict}
Loop-back: ${input.loopbackCount} / ${input.maxLoopbacks}

## All criteria
${criteria}

## Unmet "must" criteria
${input.unmetMust.map((c) => `- \`${c.id}\`: ${c.text} [owner: ${c.ownerRole}]${c.note ? ` — ${c.note}` : ""}`).join("\n") || "(none)"}

## Missing concerns
${input.missingConcerns.join(", ") || "(none)"}

## Owner role summaries
${owners}

## Coverage map
${coverage}

Assess whether to loop-back, proceed, or escalate.`;
}

async function defaultAssessBorderline(
  input: BorderlineAssessmentInput,
  roleRunner: RoleRunner,
  repoPath: string,
  planningDir: string,
  modelId: string,
): Promise<BorderlineAssessmentResult> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const json = await routerCall<BorderlineAssessmentResult>(
      roleRunner,
      repoPath,
      planningDir,
      modelId,
      BORDERLINE_SYSTEM_PROMPT,
      buildBorderlinePrompt(input),
      controller.signal,
    );

    clearTimeout(timeout);

    const valid = ["loopback", "proceed", "proceed_with_note", "escalate", "narrow_loopback"];
    if (!valid.includes(json.decision)) {
      throw new Error(`invalid decision: ${json.decision}`);
    }
    return json;
  } catch (err) {
    console.warn(`[router] borderline assessment failed: ${(err as Error).message}`);
    return {
      decision: "loopback",
      reasoning: "Router assessment failed — falling back to default loop-back.",
    };
  }
}

// ---------------------------------------------------------------------------
// Call Point 4: Second Review (authoritative synthesis of primary + critique)
// ---------------------------------------------------------------------------

export interface SecondReviewInput {
  taskName: string;
  intakeKind: string;
  roleKey: string;
  primaryVerdict: string;
  primarySummary: string;
  critiqueVerdict?: string;
  critiqueSummary?: string;
  coverageMap: Record<string, { status: string; note?: string }>;
}

export type SecondReviewDecision = "accept" | "accept_with_note" | "escalate" | "loopback";

export interface SecondReviewResult {
  decision: SecondReviewDecision;
  reasoning: string;
  steer_note?: string;
}

const SECOND_REVIEW_SYSTEM_PROMPT = `You are the orchestrator's own second reviewer for an automated code refinement pipeline.
A role just produced a finding, and — if enabled — an adversarial critic judged whether that
finding is SO egregious it would violate their domain (e.g. exposing PII, an authz bypass, an
irreversible data-loss migration). Your job is to synthesize both into one authoritative decision.

Available decisions:
- "accept": Nothing serious here. Proceed normally.
- "accept_with_note": Minor concern worth flagging for the record, but not worth blocking on. Proceed, but attach a steer_note.
- "loopback": The critique's concern is real and the responsible role should redo this step with the concern in mind.
- "escalate": The concern is serious enough (or ambiguous enough) that only a human should decide.

Guidelines:
- If the critic passed (no objection) and the primary verdict is fine, "accept".
- If the critic raised a "blocker", take it seriously — do NOT rubber-stamp it, but do independently
  judge whether it's a genuine, concrete, high-severity domain violation or a false positive/nitpick.
  A genuine violation (PII exposure, authz bypass, irreversible data loss, legal/compliance breach)
  should "escalate" (or "loopback" if a straightforward redo would resolve it). A false positive or a
  stylistic nitpick should be downgraded to "accept_with_note" so the pipeline isn't blocked on noise.
- You may also independently escalate even if the critic passed, if the primary finding itself looks
  like a serious domain violation the critic missed.
- Never downgrade a genuine security, privacy, or safety violation to "accept" or "accept_with_note".

Respond ONLY with valid JSON matching this schema — no markdown, no explanation outside the JSON:
{
  "decision": "accept" | "accept_with_note" | "escalate" | "loopback",
  "reasoning": "brief explanation of the decision",
  "steer_note": "guidance for the re-run role or a note to carry forward (omit for \\"accept\\")"
}`;

function buildSecondReviewPrompt(input: SecondReviewInput): string {
  const coverage = Object.entries(input.coverageMap)
    .map(([k, v]) => `- ${k}: ${v.status}${v.note ? ` (${v.note})` : ""}`)
    .join("\n");

  return `Task: ${input.taskName} (${input.intakeKind})
Role: ${input.roleKey}

## Primary run
- Verdict: ${input.primaryVerdict}
- Summary: ${input.primarySummary}

## Adversarial critique
${
  input.critiqueVerdict
    ? `- Verdict: ${input.critiqueVerdict}\n- Summary: ${input.critiqueSummary ?? "(no summary)"}`
    : "(no critique ran for this step)"
}

## Coverage map
${coverage}

Synthesize a single authoritative decision for this step.`;
}

async function defaultAssessSecondReview(
  input: SecondReviewInput,
  roleRunner: RoleRunner,
  repoPath: string,
  planningDir: string,
  modelId: string,
): Promise<SecondReviewResult> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const json = await routerCall<SecondReviewResult>(
      roleRunner,
      repoPath,
      planningDir,
      modelId,
      SECOND_REVIEW_SYSTEM_PROMPT,
      buildSecondReviewPrompt(input),
      controller.signal,
    );

    clearTimeout(timeout);

    const valid = ["accept", "accept_with_note", "escalate", "loopback"];
    if (!valid.includes(json.decision)) {
      throw new Error(`invalid decision: ${json.decision}`);
    }
    return json;
  } catch (err) {
    console.warn(`[router] second review failed: ${(err as Error).message}`);
    return {
      decision: "accept",
      reasoning: "Router second review failed — falling back to accepting the primary verdict as-is.",
    };
  }
}

// ---------------------------------------------------------------------------
// Call Point 5: Answer Match Assessment
// ---------------------------------------------------------------------------

export interface AnswerMatchInput {
  question: string;
  assumedAnswer: string;
  confidence: "low" | "medium" | "high";
  humanAnswer: string;
}

export type AnswerMatchDecision = "confirms" | "contradicts";

export interface AnswerMatchResult {
  decision: AnswerMatchDecision;
  reasoning: string;
}

const ANSWER_MATCH_SYSTEM_PROMPT = `You are comparing a human's answer to a question against the best-effort guess an automated role made earlier, in order to decide whether that guess's downstream work still stands or needs to be redone.

Available decisions:
- "confirms": The human's answer is consistent with (or a more specific version of) the guessed answer. Downstream work built on the guess is still valid.
- "contradicts": The human's answer conflicts with the guessed answer in a way that would change downstream conclusions. The work needs to be redone with the corrected answer.

Guidelines:
- Minor wording differences that don't change the substance are still "confirms".
- Only decide "contradicts" when acting on the human's answer would actually produce a different result than acting on the guess did.
- When genuinely unsure, prefer "contradicts" — re-doing unaffected work is cheap, but silently keeping wrong conclusions is not.

Respond ONLY with valid JSON matching this schema — no markdown, no explanation outside the JSON:
{
  "decision": "confirms" | "contradicts",
  "reasoning": "brief explanation of the decision"
}`;

function buildAnswerMatchPrompt(input: AnswerMatchInput): string {
  return `Question: ${input.question}

## Role's earlier best-effort guess (confidence: ${input.confidence})
${input.assumedAnswer || "(no guess was recorded)"}

## Human's actual answer
${input.humanAnswer}

Does the human's answer confirm the guess, or contradict it?`;
}

async function defaultAssessAnswerMatch(
  input: AnswerMatchInput,
  roleRunner: RoleRunner,
  repoPath: string,
  planningDir: string,
  modelId: string,
): Promise<AnswerMatchResult> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const json = await routerCall<AnswerMatchResult>(
      roleRunner,
      repoPath,
      planningDir,
      modelId,
      ANSWER_MATCH_SYSTEM_PROMPT,
      buildAnswerMatchPrompt(input),
      controller.signal,
    );

    clearTimeout(timeout);

    if (!["confirms", "contradicts"].includes(json.decision)) {
      throw new Error(`invalid decision: ${json.decision}`);
    }
    return json;
  } catch (err) {
    console.warn(`[router] answer match assessment failed: ${(err as Error).message}`);
    // Fall back conservatively: never silently keep a possibly-wrong guess.
    return {
      decision: "contradicts",
      reasoning: "Router assessment failed — treating as a mismatch so the answer isn't silently dropped.",
    };
  }
}

// ---------------------------------------------------------------------------
// Injector seam (same pattern as orchestrator's setRoleRunner)
// ---------------------------------------------------------------------------

type DistillParams = [
  input: QuestionDistillationInput,
  roleRunner: RoleRunner,
  repoPath: string,
  planningDir: string,
  modelId: string,
];

type EscalationParams = [
  input: EscalationAssessmentInput,
  roleRunner: RoleRunner,
  repoPath: string,
  planningDir: string,
  modelId: string,
];

type BorderlineParams = [
  input: BorderlineAssessmentInput,
  roleRunner: RoleRunner,
  repoPath: string,
  planningDir: string,
  modelId: string,
];

type SecondReviewParams = [
  input: SecondReviewInput,
  roleRunner: RoleRunner,
  repoPath: string,
  planningDir: string,
  modelId: string,
];

type AnswerMatchParams = [
  input: AnswerMatchInput,
  roleRunner: RoleRunner,
  repoPath: string,
  planningDir: string,
  modelId: string,
];

export type DistillFn = (...args: DistillParams) => Promise<DistillationResult>;
export type EscalationFn = (...args: EscalationParams) => Promise<EscalationAssessmentResult>;
export type BorderlineFn = (...args: BorderlineParams) => Promise<BorderlineAssessmentResult>;
export type SecondReviewFn = (...args: SecondReviewParams) => Promise<SecondReviewResult>;
export type AnswerMatchFn = (...args: AnswerMatchParams) => Promise<AnswerMatchResult>;

let _distill: DistillFn = defaultDistill;
let _assessEscalation: EscalationFn = defaultAssessEscalation;
let _assessBorderline: BorderlineFn = defaultAssessBorderline;
let _assessSecondReview: SecondReviewFn = defaultAssessSecondReview;
let _assessAnswerMatch: AnswerMatchFn = defaultAssessAnswerMatch;

export function setDistillFn(fn: DistillFn): void { _distill = fn; }
export function setEscalationFn(fn: EscalationFn): void { _assessEscalation = fn; }
export function setBorderlineFn(fn: BorderlineFn): void { _assessBorderline = fn; }
export function setSecondReviewFn(fn: SecondReviewFn): void { _assessSecondReview = fn; }
export function setAnswerMatchFn(fn: AnswerMatchFn): void { _assessAnswerMatch = fn; }

export function resetRouterFns(): void {
  _distill = defaultDistill;
  _assessEscalation = defaultAssessEscalation;
  _assessBorderline = defaultAssessBorderline;
  _assessSecondReview = defaultAssessSecondReview;
  _assessAnswerMatch = defaultAssessAnswerMatch;
}

/** Public entry points that tests can override via the seam. */
export const distillQuestions: DistillFn = (...args) => _distill(...args);
export const assessEscalation: EscalationFn = (...args) => _assessEscalation(...args);
export const assessBorderline: BorderlineFn = (...args) => _assessBorderline(...args);
export const assessSecondReview: SecondReviewFn = (...args) => _assessSecondReview(...args);
export const assessAnswerMatch: AnswerMatchFn = (...args) => _assessAnswerMatch(...args);