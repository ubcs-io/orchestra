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
 * Call Point 6 — Candidate Triage (a watcher-produced candidate, before it may
 *                 become a task)
 * Call Point 7 — Intake Planning (a fresh intake plus its scout findings —
 *                 which flow/network, which roles, and how big this really is,
 *                 proposed for a human to correct before any of it is spent)
 */

import { Type, type Static } from "@sinclair/typebox";
import type { RoleRunner, PlanStep, CoverageMap as OrchestratorCoverageMap } from "./orchestrator.js";
import type { CriteriaResult } from "./agent.js";
import type { Connection } from "./settings.js";
import { runConstrainedCompletion } from "./structured.js";

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
  /** Call Point 6 (PLANNING/overhaul/08): triage a watcher-produced candidate
   *  into worth_doing/priority/suggested_kind before it may become a task. */
  candidateTriage: boolean;
  /** Call Point 7 (PLANNING/intake-refinement.md): propose kind/network/role
   *  plan/effort size for a reviewed intake. Off = the review still runs and
   *  still gives a human the editable card, filled from the heuristic proposal
   *  (today's routing) instead of an informed read. */
  intakePlanning: boolean;
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
  candidateTriage: false,
  intakePlanning: false,
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

/**
 * Attempt a router mini-call via the sampler-guaranteed rung
 * (PLANNING/overhaul/02) instead of `routerCall`'s roleRunner+extractJson path.
 * Returns null (never throws) on any failure — unsupported connection, network
 * error, or schema mismatch — so callers fall straight through to their
 * existing heuristic-backed `routerCall` path unchanged. `connection` is
 * optional only so existing call sites that haven't threaded it through yet
 * degrade to the unconstrained path rather than failing to compile/run.
 */
async function tryConstrained<T extends import("@sinclair/typebox").TSchema>(
  connection: Connection | undefined,
  modelId: string,
  systemPrompt: string,
  userPrompt: string,
  schema: T,
  /** Raised only by call points whose output is genuinely longer than a
   *  verdict-plus-reason (Call Point 7's proposal carries prose rationales),
   *  so every existing call point keeps its original 1024 budget. */
  maxTokens = 1024,
): Promise<Static<T> | null> {
  if (!connection || connection.structuredOutputs.mode === "off") return null;
  try {
    return await runConstrainedCompletion(
      connection,
      modelId,
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      schema,
      maxTokens,
    );
  } catch (err) {
    console.warn(`[router] constrained call failed, falling back: ${(err as Error).message}`);
    return null;
  }
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

/** JSON-schema payload for the constrained-decoding rung — mirrors DistillationResult. */
const DistillationResultSchema = Type.Object({
  questions: Type.Array(
    Type.Object({
      text: Type.String(),
      context: Type.Union([Type.String(), Type.Null()]),
      priority: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
      duplicate_of: Type.Union([Type.String(), Type.Null()]),
      suggested_answer: Type.Union([Type.String(), Type.Null()]),
    }),
  ),
  merged_count: Type.Number(),
  dropped_duplicates: Type.Number(),
});

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
  connection?: Connection,
): Promise<DistillationResult> {
  const constrained = await tryConstrained(
    connection,
    modelId,
    DISTILL_SYSTEM_PROMPT,
    buildDistillPrompt(input),
    DistillationResultSchema,
  );
  if (constrained) return constrained;
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

/** JSON-schema payload for the constrained-decoding rung — mirrors EscalationAssessmentResult. */
const EscalationAssessmentResultSchema = Type.Object({
  decision: Type.Union([
    Type.Literal("escalate"),
    Type.Literal("reroute"),
    Type.Literal("rerun"),
    Type.Literal("close"),
  ]),
  reasoning: Type.String(),
  action: Type.Optional(
    Type.Object({
      role: Type.Optional(Type.String()),
      after: Type.Optional(Type.String()),
      steer_note: Type.Optional(Type.String()),
    }),
  ),
  human_review_still_needed_after: Type.Optional(Type.Boolean()),
});

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
  connection?: Connection,
): Promise<EscalationAssessmentResult> {
  const constrained = await tryConstrained(
    connection,
    modelId,
    ESCALATION_SYSTEM_PROMPT,
    buildEscalationPrompt(input),
    EscalationAssessmentResultSchema,
  );
  if (constrained) return constrained;
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

/** JSON-schema payload for the constrained-decoding rung — mirrors BorderlineAssessmentResult. */
const BorderlineAssessmentResultSchema = Type.Object({
  decision: Type.Union([
    Type.Literal("loopback"),
    Type.Literal("proceed"),
    Type.Literal("proceed_with_note"),
    Type.Literal("escalate"),
    Type.Literal("narrow_loopback"),
  ]),
  reasoning: Type.String(),
  override_unmet: Type.Optional(Type.Array(Type.String())),
  steer_note: Type.Optional(Type.String()),
  target_roles: Type.Optional(Type.Array(Type.String())),
});

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
  connection?: Connection,
): Promise<BorderlineAssessmentResult> {
  const constrained = await tryConstrained(
    connection,
    modelId,
    BORDERLINE_SYSTEM_PROMPT,
    buildBorderlinePrompt(input),
    BorderlineAssessmentResultSchema,
  );
  if (constrained) return constrained;
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

/** JSON-schema payload for the constrained-decoding rung — mirrors SecondReviewResult. */
const SecondReviewResultSchema = Type.Object({
  decision: Type.Union([
    Type.Literal("accept"),
    Type.Literal("accept_with_note"),
    Type.Literal("escalate"),
    Type.Literal("loopback"),
  ]),
  reasoning: Type.String(),
  steer_note: Type.Optional(Type.String()),
});

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
  connection?: Connection,
): Promise<SecondReviewResult> {
  const constrained = await tryConstrained(
    connection,
    modelId,
    SECOND_REVIEW_SYSTEM_PROMPT,
    buildSecondReviewPrompt(input),
    SecondReviewResultSchema,
  );
  if (constrained) return constrained;
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

/** JSON-schema payload for the constrained-decoding rung — mirrors AnswerMatchResult. */
const AnswerMatchResultSchema = Type.Object({
  decision: Type.Union([Type.Literal("confirms"), Type.Literal("contradicts")]),
  reasoning: Type.String(),
});

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
  connection?: Connection,
): Promise<AnswerMatchResult> {
  const constrained = await tryConstrained(
    connection,
    modelId,
    ANSWER_MATCH_SYSTEM_PROMPT,
    buildAnswerMatchPrompt(input),
    AnswerMatchResultSchema,
  );
  if (constrained) return constrained;
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
// Call Point 6: Candidate Triage (PLANNING/overhaul/08)
// ---------------------------------------------------------------------------

export interface CandidateTriageInput {
  projectName: string;
  /** Watcher registry key, e.g. "test-suite". */
  watcher: string;
  /** The watcher's own suggested intake kind, e.g. "error_file". */
  candidateKind: string;
  /** Condensed evidence — failing test names + a capped log excerpt. */
  payloadSummary: string;
  /** Currently open self-generated tasks for this project (any watcher). */
  openAutoTaskCount: number;
  autoQueueDepth: number;
  /** Recent human "won't do" reasons for the same/a similar fingerprint —
   *  context only, never a hard rule the model must obey. */
  recentSuppressions: string[];
}

export type CandidateTriagePriority = 1 | 2 | 3 | 4 | 5;

export interface CandidateTriageDecision {
  worth_doing: boolean;
  priority: CandidateTriagePriority;
  rationale: string;
  suggested_kind: string;
}

/** JSON-schema payload for the constrained-decoding rung — mirrors CandidateTriageDecision. */
const CandidateTriageResultSchema = Type.Object({
  worth_doing: Type.Boolean(),
  priority: Type.Union([
    Type.Literal(1),
    Type.Literal(2),
    Type.Literal(3),
    Type.Literal(4),
    Type.Literal(5),
  ]),
  rationale: Type.String(),
  suggested_kind: Type.String(),
});

const CANDIDATE_TRIAGE_SYSTEM_PROMPT = `You are the triage gate for an autonomous local code companion. A background
watcher just observed something in the repository (e.g. a failing test suite) and is proposing it as a
candidate for the automated work queue. Your job is to decide whether it is actually worth an automated
task, so the queue doesn't fill up with noise the human never asked for.

Guidelines:
- "worth_doing: true" only for a genuine, concrete problem worth an automated pass — a real test failure,
  not flakiness or a transient environment issue.
- Weigh the existing queue depth: if it's already near the cap, raise the bar for "worth_doing".
- If similar candidates were recently marked "won't do" by a human, treat that as a signal this kind of
  thing isn't wanted right now (but not an absolute rule — a different underlying cause can still be real).
- priority 1 (lowest) to 5 (highest) — reflect genuine urgency, not enthusiasm. Most candidates should be
  2-3; reserve 4-5 for something a human would drop other work to look at.
- suggested_kind should usually match the watcher's own candidateKind unless the evidence clearly suggests
  a different intake kind fits better.
- When genuinely unsure, prefer "worth_doing: false" — a missed candidate just waits for the next scan,
  which is cheap; a bad auto-queued task is queue pollution a human has to clean up.

Respond ONLY with valid JSON matching this schema — no markdown, no explanation outside the JSON:
{
  "worth_doing": true | false,
  "priority": 1 | 2 | 3 | 4 | 5,
  "rationale": "brief explanation",
  "suggested_kind": "intake kind this should become, e.g. error_file"
}`;

function buildCandidateTriagePrompt(input: CandidateTriageInput): string {
  const suppressions = input.recentSuppressions.length
    ? input.recentSuppressions.map((s) => `- ${s}`).join("\n")
    : "(none)";

  return `Project: ${input.projectName}
Watcher: ${input.watcher}
Candidate kind: ${input.candidateKind}
Open self-generated tasks: ${input.openAutoTaskCount} / ${input.autoQueueDepth} (autoQueueDepth)

## Evidence
${input.payloadSummary}

## Recent human "won't do" reasons for similar candidates
${suppressions}

Decide whether this candidate is worth an automated task.`;
}

async function defaultTriageCandidate(
  input: CandidateTriageInput,
  roleRunner: RoleRunner,
  repoPath: string,
  planningDir: string,
  modelId: string,
  connection?: Connection,
): Promise<CandidateTriageDecision> {
  const constrained = await tryConstrained(
    connection,
    modelId,
    CANDIDATE_TRIAGE_SYSTEM_PROMPT,
    buildCandidateTriagePrompt(input),
    CandidateTriageResultSchema,
  );
  if (constrained) return constrained;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const json = await routerCall<CandidateTriageDecision>(
      roleRunner,
      repoPath,
      planningDir,
      modelId,
      CANDIDATE_TRIAGE_SYSTEM_PROMPT,
      buildCandidateTriagePrompt(input),
      controller.signal,
    );

    clearTimeout(timeout);

    if (typeof json.worth_doing !== "boolean") throw new Error("missing worth_doing");
    if (![1, 2, 3, 4, 5].includes(json.priority)) throw new Error(`invalid priority: ${json.priority}`);
    return json;
  } catch (err) {
    console.warn(`[router] candidate triage failed: ${(err as Error).message}`);
    // Fail toward NOT queuing — the opposite bias from Call Point 5's
    // "fail toward redoing work": a missed candidate just waits for the next
    // scan (cheap), while a broken router silently auto-queuing junk is the
    // doc's own #1 named risk (queue pollution).
    return {
      worth_doing: false,
      priority: 3,
      rationale: "Router triage failed — defaulting to not queuing this candidate.",
      suggested_kind: input.candidateKind,
    };
  }
}

// ---------------------------------------------------------------------------
// Call Point 7: Intake Planning (PLANNING/intake-refinement.md)
// ---------------------------------------------------------------------------

export interface IntakePlanInput {
  projectName: string;
  taskName: string;
  /** The raw intake, capped by the caller. */
  intakeContent: string;
  /** What intake already inferred / the human picked — the status quo answer. */
  currentIntakeKind: string;
  /** intake_triage's report from the scout prefix. */
  triageSummary: string;
  /** explorer's report — the file list and affected surface. */
  explorerSummary: string;
  /** explorer's own size estimate, if it recorded one. The planner is asked to
   *  confirm or correct it, and is told this is the number a human is about to
   *  be asked to steer. */
  explorerEffortSize: string | null;
  /** Every network this project could route to, with its ordered role list. */
  networks: Array<{
    network_id: string;
    name: string;
    description: string;
    intake_kind: string | null;
    roles: string[];
  }>;
  /** Role keys that actually exist, so a proposed plan can't name a fiction. */
  availableRoles: string[];
  /** What each effort size would buy, rendered from the real budget table so
   *  the planner sizes against consequences rather than adjectives. */
  budgetPreview: string;
}

export interface IntakePlanResult {
  restated_request: string;
  intake_kind: string;
  network_id: string | null;
  network_why: string;
  role_plan: string[];
  plan_deltas: Array<{ role_key: string; change: "added" | "removed"; why: string }>;
  effort_size: string;
  size_rationale: string;
  planning_rigor: string;
  assumptions: Array<{ question: string; assumed_answer: string; confidence: string }>;
  custom_node: { role_key: string; title: string; persona_sketch: string; why: string } | null;
  confidence: string;
}

/** JSON-schema payload for the constrained-decoding rung — mirrors IntakePlanResult. */
const IntakePlanResultSchema = Type.Object({
  restated_request: Type.String(),
  intake_kind: Type.String(),
  network_id: Type.Union([Type.String(), Type.Null()]),
  network_why: Type.String(),
  role_plan: Type.Array(Type.String()),
  plan_deltas: Type.Array(
    Type.Object({
      role_key: Type.String(),
      change: Type.Union([Type.Literal("added"), Type.Literal("removed")]),
      why: Type.String(),
    }),
  ),
  effort_size: Type.Union([
    Type.Literal("XS"),
    Type.Literal("S"),
    Type.Literal("M"),
    Type.Literal("L"),
    Type.Literal("XL"),
  ]),
  size_rationale: Type.String(),
  planning_rigor: Type.Union([
    Type.Literal("minimal"),
    Type.Literal("standard"),
    Type.Literal("thorough"),
  ]),
  assumptions: Type.Array(
    Type.Object({
      question: Type.String(),
      assumed_answer: Type.String(),
      confidence: Type.Union([
        Type.Literal("low"),
        Type.Literal("medium"),
        Type.Literal("high"),
      ]),
    }),
  ),
  custom_node: Type.Union([
    Type.Object({
      role_key: Type.String(),
      title: Type.String(),
      persona_sketch: Type.String(),
      why: Type.String(),
    }),
    Type.Null(),
  ]),
  confidence: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
});

const INTAKE_PLAN_SYSTEM_PROMPT = `You are the intake planner for an automated code refinement pipeline. A human
has just filed a request, and two scout roles have already looked at the real repository: intake_triage
(what is being asked) and explorer (which files this actually touches). Your job is to propose how the
request should be routed — which flow, which roles, and how big the work really is.

Everything you propose is shown to the human for correction before anything runs. Propose the honest
answer, not the safe one: a human correcting an over-estimate is the cheap outcome, but only if you gave
them a real number to correct.

Guidelines:
- **intake_kind** selects the flow's criteria and counter-reviewer. Pick the one that matches the work,
  even when it differs from what the human picked — they chose before anyone read the code.
- **network_id** must be one of the offered networks, or null to use the built-in flow for the intake
  kind. Prefer a network whose intake_kind matches; only pick a differently-scoped one when its role list
  is clearly a better fit for this specific request, and say why.
- **role_plan** is the ordered list of roles to actually run. Start from the chosen network's role list.
  Only add or remove a role when this specific request needs it — every entry in plan_deltas must name a
  concrete reason grounded in what explorer found. Do not remove the flow's reviewer or its terminal role.
  Every role_plan entry must be a role that exists in the available roles list.
- **effort_size** is the single most consequential number here: it sets how much further planning and how
  many subtasks this work may spawn. Size the work you can see in explorer's file list, not the work the
  request's wording implies. A copy/string change touching three files is XS or S no matter how important
  it sounds; a rename whose call sites explorer found across many modules is not S just because each edit
  is small. Do not hedge upward "to be safe" — that is exactly the failure this review exists to catch.
- **planning_rigor** scales the process applied per unit of size — "minimal" for work whose shape is
  obvious, "thorough" when the change is small but the blast radius is dangerous. Most work is "standard".
- **assumptions**: every question you had to answer yourself to produce this proposal, with the answer you
  assumed and your confidence. This is where a human catches a wrong premise cheaply — do not leave it
  empty just because the proposal came out clean.
- **custom_node**: null in almost every case. Only when no existing role covers a concern this request
  genuinely needs. It is advisory — a human decides whether such a role is ever created.

Respond ONLY with valid JSON matching this schema — no markdown, no explanation outside the JSON:
{
  "restated_request": "one paragraph: what is actually being asked",
  "intake_kind": "manual | error_file | feature | bug | security | chore | spike | research | ux | question",
  "network_id": "id from the offered list, or null",
  "network_why": "why this network/flow fits",
  "role_plan": ["role_key", "..."],
  "plan_deltas": [{ "role_key": "...", "change": "added" | "removed", "why": "..." }],
  "effort_size": "XS | S | M | L | XL",
  "size_rationale": "the concrete files/surfaces that drove it",
  "planning_rigor": "minimal | standard | thorough",
  "assumptions": [{ "question": "...", "assumed_answer": "...", "confidence": "low" | "medium" | "high" }],
  "custom_node": null,
  "confidence": "low" | "medium" | "high"
}`;

function buildIntakePlanPrompt(input: IntakePlanInput): string {
  const networks = input.networks.length
    ? input.networks
        .map(
          (n) =>
            `- ${n.network_id} — "${n.name}"${n.intake_kind ? ` (intake kind: ${n.intake_kind})` : ""}\n` +
            `  ${n.description || "(no description)"}\n` +
            `  roles: ${n.roles.join(" → ") || "(none)"}`,
        )
        .join("\n")
    : "(none registered — the built-in flow for the intake kind applies)";

  return `Project: ${input.projectName}
Task: ${input.taskName}
Intake kind as filed: ${input.currentIntakeKind}
Explorer's own effort size: ${input.explorerEffortSize ?? "(not recorded)"}

## The raw intake
${input.intakeContent}

## intake_triage's report
${input.triageSummary || "(no report recorded)"}

## explorer's report
${input.explorerSummary || "(no report recorded)"}

## Networks available in this project
${networks}

## Roles available
${input.availableRoles.join(", ")}

## What each effort size buys
${input.budgetPreview}

Propose how this intake should be routed.`;
}

async function defaultPlanIntake(
  input: IntakePlanInput,
  roleRunner: RoleRunner,
  repoPath: string,
  planningDir: string,
  modelId: string,
  connection?: Connection,
): Promise<IntakePlanResult | null> {
  const constrained = await tryConstrained(
    connection,
    modelId,
    INTAKE_PLAN_SYSTEM_PROMPT,
    buildIntakePlanPrompt(input),
    IntakePlanResultSchema,
    2048,
  );
  if (constrained) return constrained;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const json = await routerCall<IntakePlanResult>(
      roleRunner,
      repoPath,
      planningDir,
      modelId,
      INTAKE_PLAN_SYSTEM_PROMPT,
      buildIntakePlanPrompt(input),
      controller.signal,
    );

    clearTimeout(timeout);

    if (typeof json.intake_kind !== "string") throw new Error("missing intake_kind");
    if (!Array.isArray(json.role_plan) || json.role_plan.length === 0) {
      throw new Error("missing role_plan");
    }
    return json;
  } catch (err) {
    console.warn(`[router] intake planning failed: ${(err as Error).message}`);
    // Null, not a fabricated proposal: the caller's fallback is the *heuristic*
    // proposal (today's routing, honestly labelled as such in the card), which
    // is strictly better than this call point inventing defaults of its own.
    return null;
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
  connection?: Connection,
];

type EscalationParams = [
  input: EscalationAssessmentInput,
  roleRunner: RoleRunner,
  repoPath: string,
  planningDir: string,
  modelId: string,
  connection?: Connection,
];

type BorderlineParams = [
  input: BorderlineAssessmentInput,
  roleRunner: RoleRunner,
  repoPath: string,
  planningDir: string,
  modelId: string,
  connection?: Connection,
];

type SecondReviewParams = [
  input: SecondReviewInput,
  roleRunner: RoleRunner,
  repoPath: string,
  planningDir: string,
  modelId: string,
  connection?: Connection,
];

type AnswerMatchParams = [
  input: AnswerMatchInput,
  roleRunner: RoleRunner,
  repoPath: string,
  planningDir: string,
  modelId: string,
  connection?: Connection,
];

type CandidateTriageParams = [
  input: CandidateTriageInput,
  roleRunner: RoleRunner,
  repoPath: string,
  planningDir: string,
  modelId: string,
  connection?: Connection,
];

type IntakePlanParams = [
  input: IntakePlanInput,
  roleRunner: RoleRunner,
  repoPath: string,
  planningDir: string,
  modelId: string,
  connection?: Connection,
];

export type DistillFn = (...args: DistillParams) => Promise<DistillationResult>;
export type EscalationFn = (...args: EscalationParams) => Promise<EscalationAssessmentResult>;
export type BorderlineFn = (...args: BorderlineParams) => Promise<BorderlineAssessmentResult>;
export type SecondReviewFn = (...args: SecondReviewParams) => Promise<SecondReviewResult>;
export type AnswerMatchFn = (...args: AnswerMatchParams) => Promise<AnswerMatchResult>;
export type TriageFn = (...args: CandidateTriageParams) => Promise<CandidateTriageDecision>;
/** Null = "no informed proposal available"; the caller falls back to the
 *  heuristic proposal rather than this call point inventing one. */
export type IntakePlanFn = (...args: IntakePlanParams) => Promise<IntakePlanResult | null>;

let _distill: DistillFn = defaultDistill;
let _assessEscalation: EscalationFn = defaultAssessEscalation;
let _assessBorderline: BorderlineFn = defaultAssessBorderline;
let _assessSecondReview: SecondReviewFn = defaultAssessSecondReview;
let _assessAnswerMatch: AnswerMatchFn = defaultAssessAnswerMatch;
let _triageCandidate: TriageFn = defaultTriageCandidate;
let _planIntake: IntakePlanFn = defaultPlanIntake;

export function setDistillFn(fn: DistillFn): void { _distill = fn; }
export function setEscalationFn(fn: EscalationFn): void { _assessEscalation = fn; }
export function setBorderlineFn(fn: BorderlineFn): void { _assessBorderline = fn; }
export function setSecondReviewFn(fn: SecondReviewFn): void { _assessSecondReview = fn; }
export function setAnswerMatchFn(fn: AnswerMatchFn): void { _assessAnswerMatch = fn; }
export function setTriageFn(fn: TriageFn): void { _triageCandidate = fn; }
export function setIntakePlanFn(fn: IntakePlanFn): void { _planIntake = fn; }

export function resetRouterFns(): void {
  _distill = defaultDistill;
  _assessEscalation = defaultAssessEscalation;
  _assessBorderline = defaultAssessBorderline;
  _assessSecondReview = defaultAssessSecondReview;
  _assessAnswerMatch = defaultAssessAnswerMatch;
  _triageCandidate = defaultTriageCandidate;
  _planIntake = defaultPlanIntake;
}

/** Public entry points that tests can override via the seam. */
export const distillQuestions: DistillFn = (...args) => _distill(...args);
export const assessEscalation: EscalationFn = (...args) => _assessEscalation(...args);
export const assessBorderline: BorderlineFn = (...args) => _assessBorderline(...args);
export const assessSecondReview: SecondReviewFn = (...args) => _assessSecondReview(...args);
export const assessAnswerMatch: AnswerMatchFn = (...args) => _assessAnswerMatch(...args);
export const triageCandidate: TriageFn = (...args) => _triageCandidate(...args);
export const planIntake: IntakePlanFn = (...args) => _planIntake(...args);