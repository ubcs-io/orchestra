/**
 * Default role catalog + routing templates (seed data).
 *
 * Roles are seeded once as global rows (project_id NULL) and can be overridden
 * per project. The Orchestrator picks a subset + order per intake_kind from the
 * routing templates; users can override per task (§5.5 steering).
 */

import { createHash } from "node:crypto";
import { countGlobalRoles, createNetwork, getDb, getMeta, listNetworks, setMeta, upsertRole } from "./db.js";

/** Read-only pi built-in tools given to code-inspecting roles. */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
/**
 * Read-only inspection plus `git_history` (a custom tool, see agent.ts). Given to
 * roles that must reason about what recently changed in the affected code — the
 * bug and security investigators/reviewers.
 */
export const READ_ONLY_TOOLS_WITH_GIT = [...READ_ONLY_TOOLS, "git_history"] as const;
/** Light roles reason over the Orchestrator-assembled context alone (cheaper). */
export const NO_TOOLS: string[] = [];

/** The concern taxonomy that powers the coverage map (fixed default; per-project extensible). */
export const CONCERN_TAXONOMY = [
  "correctness",
  "security",
  "privacy",
  "performance",
  "accessibility",
  "edge-cases",
  "tests",
  "dependencies",
  "data",
  "ux",
  "docs",
] as const;

export type IntakeKind =
  | "manual"
  | "error_file"
  | "feature"
  | "bug"
  | "security"
  | "chore"
  | "spike"
  | "research"
  | "ux"
  | "question";

export type ExitKind = "spec" | "research_brief";

/** Which terminal shape each intake kind targets. */
export const EXIT_KIND_BY_INTAKE: Record<IntakeKind, ExitKind> = {
  manual: "spec",
  error_file: "spec",
  feature: "spec",
  bug: "spec",
  security: "spec",
  chore: "spec",
  spike: "spec",
  research: "research_brief",
  ux: "research_brief",
  question: "research_brief",
};

// ---------------------------------------------------------------------------
// Flow templates: routing + rigor + acceptance criteria + counter-reviewer.
//
// A flow bundles four previously-tangled concerns into one selectable unit,
// keyed by intake kind:
//   - steps:        the ordered role plan (ends in the exit kind's terminal role,
//                   with the counter-reviewer placed immediately before it)
//   - reviewerRole: the counter-reviewer that gates the flow — it VERIFIES prior
//                   output against `criteria` rather than authoring content
//   - criteria:     a predefined, testable acceptance checklist; each "must"
//                   criterion gates readiness and, when unmet, is the loop-back
//                   target (the responsible `ownerRole` is re-run)
//   - mandatoryConcerns: coverage concerns that MUST end up "considered"
//   - maxLoopbacks: how many times the gate re-routes before escalating to a human
// ---------------------------------------------------------------------------

export type Severity = "must" | "should";

export interface Criterion {
  /** Stable id, e.g. "bug.root_cause". */
  id: string;
  /** Testable assertion the counter-reviewer checks. */
  text: string;
  /** The role responsible for satisfying it — the loop-back target when unmet. */
  ownerRole: string;
  /** "must" gates readiness and drives loop-back; "should" is advisory. */
  severity: Severity;
  /** Optional link into CONCERN_TAXONOMY. */
  concern?: string;
}

export type ReviewDepth = "none" | "terminal_only" | "every_step";

export interface FlowTemplate {
  /** Shared label for a family of intake kinds, e.g. "bug", "security". */
  key: string;
  rigor: "low" | "standard" | "high";
  /** Ordered role keys; includes the reviewer (before terminal) and the terminal role. */
  steps: string[];
  /** The counter-reviewer role that gates this flow. */
  reviewerRole: string;
  criteria: Criterion[];
  /** Concerns that must be "considered" in the rolled-up coverage before READY. */
  mandatoryConcerns: string[];
  /** Loop-back attempts before escalating to human REVIEW. */
  maxLoopbacks: number;
  /** How often the adversarial `critic` role checks a step's output for a domain
   *  violation ("would I reject a PR for this?") before the deterministic gate
   *  runs: "none" (off), "terminal_only" (at the reviewer step only, alongside
   *  its criteria check), "every_step" (after every non-exempt producer step). */
  reviewDepth: ReviewDepth;
}

const BUG_CRITERIA: Criterion[] = [
  { id: "bug.locate", text: "The code that emits/reports the error is identified with a concrete file:line reference.", ownerRole: "bug_investigator", severity: "must", concern: "correctness" },
  { id: "bug.recent_changes", text: "Recent commits touching that code region are enumerated (via git_history), or it is shown there are none.", ownerRole: "bug_investigator", severity: "must" },
  { id: "bug.root_cause", text: "A root-cause hypothesis is stated and explicitly separated from proven facts.", ownerRole: "bug_investigator", severity: "must", concern: "correctness" },
  { id: "bug.regression_test", text: "A regression test targeting the failure is proposed, referencing the repo's existing test patterns.", ownerRole: "test_strategy", severity: "must", concern: "tests" },
];

const SECURITY_CRITERIA: Criterion[] = [
  { id: "sec.exploit_path", text: "The vulnerability / exploit path is described with the specific vulnerable file:line.", ownerRole: "security_review", severity: "must", concern: "security" },
  { id: "sec.blast_radius", text: "Blast radius and the affected data/assets are identified.", ownerRole: "security_review", severity: "must", concern: "security" },
  { id: "sec.fix_criteria", text: "A remediation approach and concrete security acceptance criteria are produced.", ownerRole: "security_review", severity: "must", concern: "security" },
  { id: "sec.privacy", text: "Privacy / data-flow implications are assessed (or shown not applicable).", ownerRole: "privacy_review", severity: "must", concern: "privacy" },
];

const FEATURE_CRITERIA: Criterion[] = [
  { id: "feat.acceptance", text: "Unambiguous acceptance criteria for the feature are written.", ownerRole: "requirements_analyst", severity: "must", concern: "correctness" },
  { id: "feat.api", text: "API/contract changes and backward-compatibility are covered.", ownerRole: "api_design", severity: "should" },
  { id: "feat.schema", text: "Schema/migration safety is assessed.", ownerRole: "data_schema_review", severity: "should", concern: "data" },
  { id: "feat.security", text: "Security acceptance criteria are produced.", ownerRole: "security_review", severity: "must", concern: "security" },
  { id: "feat.tests", text: "A test strategy covering the acceptance criteria is defined.", ownerRole: "test_strategy", severity: "must", concern: "tests" },
];

const MANUAL_CRITERIA: Criterion[] = [
  { id: "manual.acceptance", text: "Acceptance criteria for the requested change are written.", ownerRole: "requirements_analyst", severity: "must", concern: "correctness" },
  { id: "manual.approach", text: "A recommended approach with rationale is given.", ownerRole: "architecture_review", severity: "should" },
];

const CHORE_CRITERIA: Criterion[] = [
  { id: "chore.conventions", text: "The change aligns with repo conventions; reusable utilities are noted.", ownerRole: "style_conventions", severity: "should" },
  { id: "chore.tests", text: "Test impact is considered.", ownerRole: "test_strategy", severity: "should", concern: "tests" },
];

const SPIKE_CRITERIA: Criterion[] = [
  { id: "spike.options", text: "At least two approaches with honest trade-offs and a recommendation are given.", ownerRole: "options_exploration", severity: "must" },
  { id: "spike.feasibility", text: "Architectural feasibility of the recommendation is assessed.", ownerRole: "architecture_review", severity: "should" },
];

const RESEARCH_CRITERIA: Criterion[] = [
  { id: "res.options", text: "At least two options with honest trade-offs are laid out.", ownerRole: "options_exploration", severity: "should" },
  { id: "res.recommendation", text: "A clear recommendation with rationale is given.", ownerRole: "options_exploration", severity: "should" },
  { id: "res.edges", text: "Key edge cases are noted.", ownerRole: "edge_case_analysis", severity: "should", concern: "edge-cases" },
];

/**
 * The selectable flow per intake kind. The Orchestrator seeds a task's
 * refinement_plan_json from `steps`, then may insert/skip roles dynamically and
 * the user may inject one-offs. `bug`/`error_file` share the bug flow; the
 * research/ux/question kinds share the brief reviewer + criteria.
 */
export const FLOW_TEMPLATES: Record<IntakeKind, FlowTemplate> = {
  error_file: {
    key: "bug", rigor: "standard", reviewerRole: "bug_review", maxLoopbacks: 2,
    mandatoryConcerns: ["correctness", "tests"], criteria: BUG_CRITERIA, reviewDepth: "terminal_only",
    steps: ["intake_triage", "explorer", "bug_investigator", "architecture_review", "test_strategy", "bug_review", "decomposition"],
  },
  bug: {
    key: "bug", rigor: "standard", reviewerRole: "bug_review", maxLoopbacks: 2,
    mandatoryConcerns: ["correctness", "tests"], criteria: BUG_CRITERIA, reviewDepth: "terminal_only",
    steps: ["intake_triage", "explorer", "bug_investigator", "architecture_review", "test_strategy", "bug_review", "decomposition"],
  },
  security: {
    key: "security", rigor: "high", reviewerRole: "security_review_adversary", maxLoopbacks: 1,
    mandatoryConcerns: ["security", "privacy"], criteria: SECURITY_CRITERIA, reviewDepth: "every_step",
    steps: ["intake_triage", "explorer", "security_review", "privacy_review", "architecture_review", "test_strategy", "security_review_adversary", "decomposition"],
  },
  feature: {
    key: "feature", rigor: "standard", reviewerRole: "spec_review", maxLoopbacks: 2,
    mandatoryConcerns: ["correctness", "security", "tests"], criteria: FEATURE_CRITERIA, reviewDepth: "every_step",
    steps: ["intake_triage", "requirements_analyst", "explorer", "architecture_review", "api_design", "data_schema_review", "security_review", "test_strategy", "spec_review", "decomposition"],
  },
  manual: {
    key: "spec", rigor: "standard", reviewerRole: "spec_review", maxLoopbacks: 2,
    mandatoryConcerns: ["correctness"], criteria: MANUAL_CRITERIA, reviewDepth: "terminal_only",
    steps: ["intake_triage", "explorer", "requirements_analyst", "architecture_review", "test_strategy", "spec_review", "decomposition"],
  },
  chore: {
    key: "chore", rigor: "low", reviewerRole: "spec_review", maxLoopbacks: 1,
    mandatoryConcerns: [], criteria: CHORE_CRITERIA, reviewDepth: "terminal_only",
    steps: ["intake_triage", "explorer", "style_conventions", "test_strategy", "spec_review", "decomposition"],
  },
  spike: {
    key: "spike", rigor: "low", reviewerRole: "spec_review", maxLoopbacks: 1,
    mandatoryConcerns: [], criteria: SPIKE_CRITERIA, reviewDepth: "terminal_only",
    steps: ["intake_triage", "explorer", "options_exploration", "architecture_review", "spec_review", "decomposition"],
  },
  research: {
    key: "research", rigor: "low", reviewerRole: "brief_review", maxLoopbacks: 1,
    mandatoryConcerns: [], criteria: RESEARCH_CRITERIA, reviewDepth: "terminal_only",
    steps: ["intake_triage", "user_research", "options_exploration", "edge_case_analysis", "brief_review", "research_synthesis"],
  },
  ux: {
    key: "research", rigor: "low", reviewerRole: "brief_review", maxLoopbacks: 1,
    mandatoryConcerns: [], criteria: RESEARCH_CRITERIA, reviewDepth: "terminal_only",
    steps: ["intake_triage", "ux_review", "user_research", "options_exploration", "edge_case_analysis", "brief_review", "research_synthesis"],
  },
  question: {
    key: "research", rigor: "low", reviewerRole: "brief_review", maxLoopbacks: 1, reviewDepth: "terminal_only",
    mandatoryConcerns: [], criteria: RESEARCH_CRITERIA,
    steps: ["intake_triage", "explorer", "options_exploration", "brief_review", "research_synthesis"],
  },
};

/** Resolve the flow for an intake kind (falls back to the manual flow). */
export function flowForIntake(kind: IntakeKind): FlowTemplate {
  return FLOW_TEMPLATES[kind] ?? FLOW_TEMPLATES.manual;
}

/** Whether a role is excluded from "every_step" adversarial critique (see RoleSeed.critiqueExempt). */
export function isCritiqueExempt(roleKey: string): boolean {
  return DEFAULT_ROLES.find((r) => r.key === roleKey)?.critiqueExempt ?? false;
}

/**
 * Ordered role plans per intake kind, derived from the flow templates. Retained
 * as the canonical routing view consumed by the Orchestrator and steering logic.
 */
export const ROUTING_TEMPLATES: Record<IntakeKind, string[]> = Object.fromEntries(
  (Object.keys(FLOW_TEMPLATES) as IntakeKind[]).map((k) => [k, FLOW_TEMPLATES[k].steps]),
) as Record<IntakeKind, string[]>;

/** The role that, once run, terminates each exit kind. */
export const TERMINAL_ROLE: Record<ExitKind, string> = {
  spec: "decomposition",
  research_brief: "research_synthesis",
};

export interface RoleSeed {
  key: string;
  title: string;
  ordering: number;
  tools: string[];
  /** Intake kinds this role is relevant to (informational; routing templates drive execution). */
  appliesTo: IntakeKind[];
  persona: string;
  can_create_subtasks?: boolean;
  /** Excluded from "every_step" adversarial critique — for pure administrative/
   *  synthesis roles where a domain-violation check isn't meaningful. */
  critiqueExempt?: boolean;
}

const ALL: IntakeKind[] = [
  "manual", "error_file", "feature", "bug", "security", "chore", "spike", "research", "ux", "question",
];

/** "How to work" preamble for roles that HAVE file-inspection tools. */
const HOW_TO_WORK_WITH_TOOLS = `
## How to work
You are one step in a multi-role refinement loop operating on a real git repository.
Ground every claim in the actual code: use your tools (read, grep, find, ls) to inspect
files before asserting anything. Do not invent file names, symbols, or behavior.
Your output budget is limited: investigate briefly, then finish. Do NOT narrate a plan to
explore ("Let me start by exploring…") — just inspect what you need and record your findings.`.trim();

/** "How to work" preamble for light roles that reason over context alone (no tools). */
const HOW_TO_WORK_NO_TOOLS = `
## How to work
You are one step in a multi-role refinement loop. You do NOT have file-inspection tools.
Reason over the original intake and the findings from earlier roles provided in your context —
do NOT attempt to explore the repository or claim to read files. Work from what you are given.
Your output budget is limited: be decisive and finish promptly. Do NOT narrate a plan to explore.`.trim();

/**
 * Shared output contract appended to every role's system prompt. Defines the
 * findings schema (verdict, summary, coverage, section_md) every role must
 * report — deliberately mechanism-agnostic (no mention of `record_findings` or
 * any other submission mechanism), since whether that's a tool call or structured
 * text depends on the connection's textMode/twoPhase settings, which aren't known
 * at role-seed time. The mechanism-specific instruction is appended at runtime by
 * agent.ts's TOOL_CALL_DISCIPLINE / TEXT_MODE_INSTRUCTION / TWO_PHASE_EXPLORE_CONTRACT.
 * (The tool-aware "How to work" preamble is prepended by `buildRoleSystemPrompt`.)
 */
export const OUTPUT_CONTRACT = `
## How to finish (required)
When you are done, your findings must convey the following. (The exact submission
mechanism — a tool call or structured text — is specified elsewhere in your instructions.)
- verdict: one of "pass" (your concern is adequately addressed), "needs_more"
  (more refinement needed before this is actionable), "blocker" (a hard problem
  must be resolved first), or "needs_human" (ambiguity only a person can resolve).
- summary: one or two sentences capturing your key takeaway.
- open_questions: array of { question, assumed_answer, confidence } (empty if none).
  For EVERY open question, give your own best-effort guess at the answer plus a
  confidence ("low" | "medium" | "high") — never leave assumed_answer empty. A later
  step or a human may confirm or correct it; recording a guess now keeps the pipeline
  moving instead of stalling on it. Reserve the "blocker"/"needs_human" verdicts ONLY
  for questions where you cannot produce any reasonable guess at all — an ordinary
  open question with a guess attached should still get "pass" or "needs_more".
- coverage: array of { concern, status, note } declaring which concerns you
  examined. status is "considered", "skipped" (relevant but you did not cover it —
  say why in note), or "out_of_scope". Draw concerns from: ${CONCERN_TAXONOMY.join(", ")}.
  Be honest about what you did NOT look at — omissions must be visible.
- section_md: a markdown section (start with a "## <Your Role>" heading) that will
  be appended to the task's planning artifact. Include concrete file references.

## Keep the deliverable tight
Your \`summary\` and \`section_md\` are the deliverable — a busy engineer or the next
role in the pipeline will skim them, not your reasoning process. Investigate and
reason as much as you need to, but do not transcribe that process into your output:
no "first I checked X, then I considered Y" narration, no restating context you were
given. Write findings as direct, skimmable statements — prefer bullet lists with
concrete file:line citations over prose. If you have extended reasoning to do, do it
in your own thinking process, not in section_md.

## If you are a counter-reviewer
When the context gives you an "Acceptance criteria to verify" checklist, your job
is to VERIFY the prior roles' work against it — not to author new content. Read the
findings and the code, then include one entry per criterion in the optional
\`criteria_results\` argument: { id, status: "met" | "partial" | "unmet", note }.
Set verdict "needs_more" if any "must" criterion is not fully met (this routes the
work back to the responsible role); use "pass" only when every "must" criterion is met.
For any "partial" or "unmet" criterion, write \`note\` as a short, imperative fix
instruction addressed to the owner role (e.g. "Cite the migration file, not just
'schema was reviewed'") — that note is sent back to them verbatim as the reason for
re-work, so a vague justification produces a vague re-run.
`.trim();

/**
 * Two-phase session contract: phase 1 (exploration). Appended to the system prompt
 * when twoPhase is active. The model uses available tools freely, then stops with a
 * natural-language summary — record_findings is NOT registered as a tool, so the
 * model cannot accidentally try to call it and stall.
 */
export const TWO_PHASE_EXPLORE_CONTRACT = `
## How to finish (two-phase exploration)

You are in the exploration phase. Use the available tools to inspect the repository
and ground your reasoning in real code. When you have gathered enough to assess the
situation, write a concise natural-language summary of your key findings and then
stop. Do NOT call any "finish" tool — just write your summary as plain text.

Your summary should cover:
- What you examined and what you found
- Any open questions or uncertainties
- A preliminary verdict (pass / needs_more / blocker / needs_human)

You will be asked to formalize your findings as structured JSON in the next step.
Do not pre-empt that step — save formalization for when you are explicitly asked.
`.trim();

/**
 * Two-phase session: phase 2 prompt. Sent as a follow-up within the same pi
 * session after the exploration phase completes. The model has full conversation
 * context from phase 1 and is instructed to formalize its findings as JSON text
 * (no tools). Parsed by extractFindingsFromText() in agent.ts.
 */
export const TWO_PHASE_FORMALIZE_PROMPT = `
## Phase 2 — Formalize your findings

Based on the exploration you completed above, output your structured findings as a
single JSON code block. Do NOT use any tools for this — just produce the JSON.

Format exactly (replace the example values with your own):
\`\`\`json
{
  "verdict": "pass",
  "summary": "One or two sentences capturing your key takeaway.",
  "open_questions": [{"question": "...", "assumed_answer": "your best guess", "confidence": "medium"}],
  "coverage": [{"concern": "security", "status": "considered", "note": "checked auth flow"}],
  "section_md": "## My Role\\n\\nFindings with concrete file references..."
}
\`\`\`

Rules:
- **verdict**: one of "pass", "needs_more", "blocker", or "needs_human"
- **summary**: brief key takeaway
- **open_questions**: array of { question, assumed_answer, confidence } (empty if none). For EVERY open question, give your own best-effort guess plus a confidence ("low" | "medium" | "high") — never leave assumed_answer empty. Reserve "blocker"/"needs_human" ONLY for questions with no reasonable guess at all; an ordinary open question with a guess attached should still get "pass" or "needs_more".
- **coverage**: array of { concern, status, note }. status is "considered", "skipped", or "out_of_scope". Draw concerns from: ${CONCERN_TAXONOMY.join(", ")}. Be honest about what you did NOT examine.
- **section_md**: a markdown section (start with "## <Your Role>" heading) with concrete file references. This will be appended to the task's planning artifact.

If you are a counter-reviewer with acceptance criteria to verify, also include:
- **criteria_results**: array of { id, status, note } — status is "met", "partial", or "unmet"

IMPORTANT for decomposition: also include a **subtasks** array — one entry per
epic/story/task node — each { local_id, level, name, brief, acceptance_criteria,
context_to_carry_forward, depends_on }. local_id is a short id you assign (e.g.
"1", "1.2") that other nodes' depends_on (array of local_ids, optional) can
reference; level is "epic", "story", or "task"; context_to_carry_forward must
state any decision/constraint/fact the child needs that isn't obvious from
name/brief alone — the child will not see this parent's full history by default.
If the work is already one atomic, independently-actionable unit, leave subtasks
empty and instead set **no_decomposition_reason** explaining why — an empty
subtasks array with no reason is treated as a failed decomposition. Still render
the same tree as readable prose in section_md for the human-facing artifact.

Output ONLY the JSON block — nothing before, nothing after.
`.trim();

export const DEFAULT_ROLES: RoleSeed[] = [
  {
    key: "intake_triage",
    title: "Intake Triage (Product Owner / BA)",
    ordering: 10,
    tools: READ_ONLY_TOOLS.slice(),
    appliesTo: ALL,
    persona: `You normalize a raw intake — which may be a bare error log, a one-line request, or open-ended research — into a structured problem statement. Establish: what is being asked, the apparent kind of work, urgency, and a first-pass scope. If the intake is a stack trace or log, extract the failing signal. Flag immediately if the intake is too vague to proceed without human clarification.`,
  },
  {
    key: "explorer",
    title: "Explorer (Staff Engineer / Onboarding)",
    ordering: 20,
    tools: READ_ONLY_TOOLS.slice(),
    appliesTo: ALL,
    persona: `You do the onboarding a new engineer would do before touching this code: find the entry point(s) the change will go through, name the specific existing utilities/helpers/patterns that already do something similar (so later roles reuse them instead of reinventing), and list the concrete files/modules that make up the affected surface area — not a description of the area, an actual list. Do not propose a design or recommend an approach; that is architecture_review's job. Your output should let a later role open the right files without re-searching.`,
  },
  {
    key: "bug_investigator",
    title: "Bug Investigator (SRE / Debugging Engineer)",
    ordering: 30,
    tools: READ_ONLY_TOOLS_WITH_GIT.slice(),
    appliesTo: ["error_file", "bug"],
    persona: `You determine why something fails. First locate the exact code that emits/reports the failure (grep the error text) and cite it as file:line. Then use git_history on that region to enumerate what changed there recently — a recent change is often the cause. Produce reproduction logic, a root-cause hypothesis grounded in the code you read, the specific failing component, and the evidence for it. Distinguish proven facts from hypotheses.`,
  },
  {
    key: "requirements_analyst",
    title: "Requirements Analyst (Product Manager)",
    ordering: 40,
    tools: NO_TOOLS,
    appliesTo: ["feature", "manual", "chore"],
    persona: `You clarify user-facing intent and write crisp acceptance criteria. Surface ambiguities explicitly; when a requirement is genuinely underspecified and cannot be safely assumed, set verdict "needs_human" so it routes to human review rather than being guessed.`,
    critiqueExempt: true,
  },
  {
    key: "critic",
    title: "Critic (Adversarial Domain Reviewer)",
    ordering: 15,
    tools: NO_TOOLS,
    appliesTo: ALL,
    persona: `You review ONE finished step's output, not the whole task. Your bar is deliberately extreme: does this specific finding/decision violate a domain you're responsible for so badly that you would reject a PR implementing it — not "could be better," not "I'd have done it differently." Silence is the default and expected outcome; only speak up for genuine, concrete, high-severity violations (e.g., exposing PII, an authz bypass, an irreversible data-loss migration, a legal/compliance breach). Set verdict "blocker" only for such a violation, "needs_human" if it's ambiguous but serious enough that a person must decide, and "pass" otherwise — if in doubt, pass.`,
  },
  {
    key: "architecture_review",
    title: "Architecture Review (Software Architect)",
    ordering: 50,
    tools: READ_ONLY_TOOLS.slice(),
    appliesTo: ["feature", "bug", "error_file", "manual", "spike", "security"],
    persona: `You evaluate the design against four fixed axes: (1) module boundaries and coupling — what this change touches and what it shouldn't leak into; (2) at least one concrete alternative approach and why it was rejected; (3) the main technical risk of the recommended approach; (4) fit with existing patterns you can point to in the repo. End with an explicit recommendation and a one-line rationale — not an open-ended discussion. Do not write acceptance criteria (requirements_analyst's job) or a test plan (test_strategy's job).`,
  },
  {
    key: "security_review",
    title: "Security Review (AppSec Engineer)",
    ordering: 60,
    tools: READ_ONLY_TOOLS_WITH_GIT.slice(),
    appliesTo: ["feature", "bug", "security"],
    persona: `You threat-model the change: injection, authz, secrets handling, and dependency risks. When investigating a reported issue, cite the vulnerable file:line and use git_history to see how it got there. Identify blast radius and affected data/assets, and produce concrete security acceptance criteria. Explicitly note whether privacy of user data is implicated (and if you did not examine it, say so in coverage).`,
  },
  {
    key: "performance_review",
    title: "Performance Review (Performance Engineer)",
    ordering: 70,
    tools: READ_ONLY_TOOLS.slice(),
    appliesTo: ["feature", "bug"],
    persona: `You identify the specific hot path(s) this change adds to or touches (name the function/query/loop), its algorithmic complexity relative to input size, and what happens as data volume grows (N+1 queries, unbounded loops, unindexed lookups). Cite the exact code location for each finding — "this could be slow" without a location is not a finding. If nothing on the change's critical path is affected, say so plainly rather than speculating about unrelated code.`,
  },
  {
    key: "api_design",
    title: "API Design (API Designer / Tech Lead)",
    ordering: 80,
    tools: READ_ONLY_TOOLS.slice(),
    appliesTo: ["feature"],
    persona: `You define the concrete contract: exact endpoint/signature, request/response shape, and status/error cases. Ground it by finding a comparable existing endpoint or function signature in the repo and citing it as the convention you're matching (naming, error shape, versioning approach) — do not just say "align with existing conventions," name the file you're aligning with. Call out explicitly whether this is backward-compatible, and if not, what breaks.`,
  },
  {
    key: "data_schema_review",
    title: "Data & Schema Review (Data Engineer / DBA)",
    ordering: 90,
    tools: READ_ONLY_TOOLS.slice(),
    appliesTo: ["feature", "bug"],
    persona: `You run every schema/migration change through a fixed checklist: is it backward-compatible with code still running the old schema during rollout? Is it reversible (a working down-migration or an explicit reason one isn't needed)? Does a new/changed query need an index it doesn't have? Could any step lose or silently truncate existing data? Cite the specific migration file and column/table. If there's no schema change, say so and stop — don't pad with generic data-modeling advice.`,
  },
  {
    key: "style_conventions",
    title: "Style & Conventions (Code Reviewer)",
    ordering: 100,
    tools: READ_ONLY_TOOLS.slice(),
    appliesTo: ["chore", "feature"],
    persona: `For each convention you flag, name the specific existing file you're matching against (naming pattern, error handling style, import structure, or a utility that already does this) — "follow repo conventions" without a cited example is not actionable. Only flag real deviations you found in the affected files, not generic style preferences.`,
  },
  {
    key: "test_strategy",
    title: "Test Strategy (QA / SDET)",
    ordering: 110,
    tools: READ_ONLY_TOOLS.slice(),
    appliesTo: ["feature", "bug", "error_file", "manual", "chore", "security"],
    persona: `You define the test plan: which tests to write (naming the test file/framework you're matching), key edge cases, and coverage expectations. For a bug, propose a specific regression test that would have caught the failure — a concrete test case, not a restatement of the acceptance criteria (those are requirements_analyst's/bug_investigator's). Reference the repo's existing test patterns and framework.`,
  },
  {
    key: "dependency_integration",
    title: "Dependency & Integration (Build / DevEx)",
    ordering: 120,
    tools: READ_ONLY_TOOLS.slice(),
    appliesTo: ["feature"],
    persona: `You check specifically: does this change add a new third-party dependency (name it, and whether an equivalent is already in package.json/requirements), does it bump a version with a breaking-change note in its changelog, does it touch a CI/build config file, or does it cross an integration boundary (external API, message queue, another service) whose contract could shift. If none of these apply, say so and stop.`,
  },
  {
    key: "decomposition",
    title: "Decomposition (Tech Lead / Scrum Master)",
    ordering: 900,
    tools: READ_ONLY_TOOLS.slice(),
    appliesTo: ["feature", "bug", "error_file", "manual", "chore", "spike", "security"],
    can_create_subtasks: true,
    persona: `You are the SPEC exit. Break the refined work into an epic → story → atomic task tree with clear sequencing, dependencies, and rough sizing. Report the tree as the structured \`subtasks\` array — one entry per node, each with a \`local_id\`, \`level\`, \`name\`, \`brief\`, \`acceptance_criteria\`, and \`context_to_carry_forward\` (state plainly what a child needs to know that isn't obvious from its name alone — the decisions, constraints, and facts this refinement trail already established, since the child will not automatically see this history). Use \`depends_on\` (a list of other nodes' local_ids) to record real sequencing — a child that can start immediately should have no depends_on. Each atomic task must be independently actionable with acceptance criteria. If the work is already one atomic, independently-actionable unit, leave subtasks empty and set \`no_decomposition_reason\` explaining why — never leave subtasks empty without one. Also render the same tree as readable prose in section_md, for the human-facing artifact.`,
  },

  // ---- Developer (write/edit capable) ----
  // Not wired into any FLOW_TEMPLATES step, so upgrading Orchestra never starts
  // writing source code on its own. tools starts empty (read-only-equivalent,
  // i.e. no tools at all) — a project must explicitly grant "write"/"edit" via a
  // project role override AND turn on that project's harness policy (allowWrite)
  // before this role's write/edit tools become live (see harness-policy.ts,
  // agent.ts's runRole()). Exists purely as a sensibly-named target for that
  // override, instead of granting write/edit to e.g. "decomposition".
  {
    key: "developer",
    title: "Developer (Implementation Engineer)",
    ordering: 950,
    tools: NO_TOOLS,
    appliesTo: ALL,
    persona: `You implement the refined work directly in the repository. Ground every change in the actual code: read the affected files before editing them, follow existing patterns and conventions, and make the smallest change that satisfies the acceptance criteria. Do not invent file names, symbols, or APIs — verify they exist first. This role only runs with write/edit tools when a project explicitly grants them; without them, treat this as a dry-run and describe the change you would make instead.`,
  },

  // ---- Research / UX track (research_brief exit) ----
  {
    key: "ux_review",
    title: "UX Review (Product Designer)",
    ordering: 200,
    tools: READ_ONLY_TOOLS.slice(),
    appliesTo: ["ux"],
    persona: `You critique the usability and interaction design of the affected surface, grounded in the real templates/components you read. Identify concrete UX problems and their impact on users.`,
  },
  {
    key: "user_research",
    title: "User Research (UX Researcher)",
    ordering: 210,
    tools: NO_TOOLS,
    appliesTo: ["ux", "research"],
    persona: `You articulate user goals, relevant personas, and journeys for the problem, plus prior-art / common patterns that address it. Keep it grounded and non-speculative.`,
  },
  {
    key: "options_exploration",
    title: "Options Exploration (Staff Engineer / Design Lead)",
    ordering: 220,
    tools: READ_ONLY_TOOLS.slice(),
    appliesTo: ["research", "ux", "spike", "question"],
    persona: `You lay out 2–3 concrete approaches to the problem, each with honest trade-offs, and end with a clear recommendation and rationale. Ground feasibility in the actual code where relevant.`,
  },
  {
    key: "edge_case_analysis",
    title: "Edge Case Analysis (QA / Design)",
    ordering: 230,
    tools: READ_ONLY_TOOLS.slice(),
    appliesTo: ["research", "ux", "feature"],
    persona: `You enumerate edge cases, failure modes, and empty/error/loading and accessibility states relevant to the work. For each one, name the specific trigger condition and the component/flow it affects — a list of vague categories ("handle errors") is not useful; a list of concrete scenarios ("cart submit with a zero-quantity line item") is.`,
  },
  {
    key: "research_synthesis",
    title: "Research Synthesis (Tech Lead)",
    ordering: 910,
    tools: NO_TOOLS,
    appliesTo: ["research", "ux", "question"],
    persona: `You are the RESEARCH_BRIEF exit. Roll the prior findings into a single decision brief: problem statement, the options with trade-offs, key edge cases, a recommendation, and any open questions. section_md should be a self-contained brief a human can act on immediately.`,
  },

  // ---- Optional/promotable extras (dormant by default in feature/bug routing —
  // a user can inject it per task, or promote it to a standing step; already wired
  // into the `security` flow's steps, where it runs unconditionally) ----
  {
    key: "privacy_review",
    title: "Privacy Review (Privacy Engineer)",
    ordering: 65,
    tools: READ_ONLY_TOOLS.slice(),
    appliesTo: ["feature", "bug", "security"],
    persona: `You examine how the change collects, stores, transmits, or exposes personal or sensitive data. Identify data flows, retention, and minimization concerns, and produce privacy acceptance criteria. This role is the canonical example of a step a user can inject and then promote to standing project policy.`,
  },

  // ---- Counter-reviewers (gate a flow by verifying prior output vs. criteria) ----
  {
    key: "bug_review",
    title: "Bug Review (Verification Engineer)",
    ordering: 500,
    tools: READ_ONLY_TOOLS_WITH_GIT.slice(),
    appliesTo: ["bug", "error_file"],
    persona: `You are a counter-reviewer for a bug investigation — verify, do not author. Adversarially check the accumulated findings against the acceptance criteria you are given: is the emitting code actually cited at file:line, were recent changes really enumerated via git_history, is the root cause separated from hypothesis, is a concrete regression test proposed? Use your tools to confirm claims against the real code. Return a criteria_results entry for every criterion and set verdict "needs_more" if any "must" criterion is not fully met.`,
  },
  {
    key: "security_review_adversary",
    title: "Adversarial Security Review (Red Team)",
    ordering: 510,
    tools: READ_ONLY_TOOLS_WITH_GIT.slice(),
    appliesTo: ["security"],
    persona: `You are an adversarial counter-reviewer for a security finding — verify, do not author, and assume the prior analysis is optimistic. Check the accumulated findings against the acceptance criteria: is the exploit path concrete and cited, is blast radius honest, are the remediation acceptance criteria real and testable, were privacy implications assessed? Probe for hand-waving. Return a criteria_results entry for every criterion and set verdict "needs_more" if any "must" criterion is not fully met.`,
  },
  {
    key: "spec_review",
    title: "Spec Review (Verification Tech Lead)",
    ordering: 520,
    tools: READ_ONLY_TOOLS.slice(),
    appliesTo: ["feature", "manual", "chore", "spike"],
    persona: `You are a counter-reviewer for a refinement spec — verify, do not author. Check the accumulated findings against the acceptance criteria: are the acceptance criteria unambiguous, are contracts/schema/security/tests addressed where required? Return a criteria_results entry for every criterion and set verdict "needs_more" if any "must" criterion is not fully met, naming what the responsible role must fix.`,
  },
  {
    key: "brief_review",
    title: "Brief Review (Verification Lead)",
    ordering: 530,
    tools: NO_TOOLS,
    appliesTo: ["research", "ux", "question"],
    persona: `You are a counter-reviewer for a research/decision brief — verify, do not author. Check the accumulated findings against the acceptance criteria: are there ≥2 options with honest trade-offs, a clear recommendation with rationale, and key edge cases noted? Return a criteria_results entry for every criterion. These are mostly advisory ("should"); set verdict "pass" unless a listed "must" criterion is unmet.`,
  },
];

/**
 * Build the full system prompt for a role: persona + a tool-aware "How to work"
 * preamble (light roles are told they have no tools) + the shared finish contract.
 */
export function buildRoleSystemPrompt(persona: string, tools: string[] = READ_ONLY_TOOLS.slice()): string {
  const work = tools.length > 0 ? HOW_TO_WORK_WITH_TOOLS : HOW_TO_WORK_NO_TOOLS;
  return `${persona}\n\n${work}\n\n${OUTPUT_CONTRACT}`;
}

/**
 * The exact seed payload for one role — used both to compute the content hash
 * and to upsert the row, so the two can never drift out of sync with each other.
 */
function roleSeedPayload(r: RoleSeed) {
  return {
    key: r.key,
    title: r.title,
    ordering: r.ordering,
    appliesTo: r.appliesTo,
    tools: r.tools,
    can_create_subtasks: r.can_create_subtasks,
    system_prompt: buildRoleSystemPrompt(r.persona, r.tools),
  };
}

/**
 * Hash of everything seedGlobalRoles() is about to persist. Comparing this
 * against the last-seeded hash (instead of a hand-maintained version number)
 * means any change to a persona, OUTPUT_CONTRACT, tool list, ordering, etc.
 * automatically triggers a reseed on next boot — there is no version bump to
 * remember (or forget mid-session, as happened here once already).
 */
function computeRolesSeedHash(): string {
  const payload = DEFAULT_ROLES.map(roleSeedPayload);
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/**
 * Seed (or refresh) the global default role catalog. Idempotent: runs on first
 * boot, and again whenever the seed content's hash changes, so prompt fixes
 * automatically propagate to existing databases. Only global (project_id NULL)
 * rows are upserted; project overrides are never touched.
 */
export function seedGlobalRoles(): void {
  const hash = computeRolesSeedHash();
  const stored = getMeta("roles_seed_hash");
  if (countGlobalRoles() > 0 && stored === hash) return;
  for (const r of DEFAULT_ROLES) {
    const p = roleSeedPayload(r);
    upsertRole({
      project_id: null,
      key: p.key,
      title: p.title,
      enabled: true,
      applies_to: JSON.stringify(p.appliesTo),
      ordering: p.ordering,
      system_prompt: p.system_prompt,
      tools_json: JSON.stringify(p.tools),
      can_create_subtasks: p.can_create_subtasks,
    });
  }
  setMeta("roles_seed_hash", hash);
  console.log(`[roles] seeded/updated ${DEFAULT_ROLES.length} global roles (hash ${hash.slice(0, 8)})`);
}

// ---------------------------------------------------------------------------
// Network seeding — creates system agent_networks from built-in flow templates
// ---------------------------------------------------------------------------

const NETWORKS_SEED_VERSION = 6;

const GRID = 20;
/** Horizontal + vertical offset per sequential node in the waterfall layout.
 *  Eight grid squares gives a clean diagonal with straight edges, plenty of
 *  clearance between consecutive node cards. */
const WATERFALL_STEP = GRID * 8; // 160px diagonal step — eight grid spaces down and right
const WATERFALL_ORIGIN_X = 100;
const WATERFALL_ORIGIN_Y = 80;

/**
 * Reposition a graph's nodes into a diagonal waterfall layout: each sequential
 * node (by position in the nodes array) is placed WATERFALL_STEP px below and to
 * the right of the previous node so the chain reads diagonally instead of
 * stretching on a single unreadably-wide horizontal row.
 */
export interface NetworkGraph {
  version: number;
  nodes: {
    id: string;
    roleKey: string;
    position: { x: number; y: number };
    criteria?: unknown[];
    /** Role keys that critique this node's output (groundwork for a future
     *  all-roles-critique-all-nodes option; today always ["critic"] or unset). */
    critics?: string[];
  }[];
  edges: unknown[];
  layout: { gridSize: number; snapToGrid: boolean };
  metadata: {
    rigor?: string;
    maxLoopbacks?: number;
    mandatoryConcerns?: string[];
    reviewerRole?: string;
    reviewDepth?: ReviewDepth;
  };
}

export function applyWaterfallLayout(graph: NetworkGraph): NetworkGraph {
  const nodes = (graph.nodes ?? []).map((n, i) => ({
    ...n,
    position: {
      x: snap(WATERFALL_ORIGIN_X + i * WATERFALL_STEP, GRID),
      y: snap(WATERFALL_ORIGIN_Y + i * WATERFALL_STEP, GRID),
    },
  }));
  return {
    ...graph,
    nodes,
    layout: { ...graph.layout, gridSize: GRID, snapToGrid: true },
  };
}

/** Generate a default AgentNetworkGraph from a FlowTemplate. Nodes are laid out
 *  in a diagonal waterfall: each subsequent node is four grid spaces below and to
 *  the right of the previous so the chain is readable at a glance without overlap.
 */
function flowToGraph(template: FlowTemplate, intakeKind: IntakeKind): string {
  const STEP = WATERFALL_STEP;

  // Group criteria by ownerRole.
  const criteriaByOwner = new Map<string, typeof template.criteria>();
  for (const c of template.criteria) {
    const list = criteriaByOwner.get(c.ownerRole) ?? [];
    list.push(c);
    criteriaByOwner.set(c.ownerRole, list);
  }

  const nodes = template.steps.map((roleKey, i) => {
    const isReviewer = roleKey === template.reviewerRole;
    const isTerminal =
      roleKey === TERMINAL_ROLE["spec"] || roleKey === TERMINAL_ROLE["research_brief"];

    // Assign criteria to the owner nodes.
    const ownerCriteria = criteriaByOwner.get(roleKey) ?? [];
    // Reviewer also gets all "must" criteria for display.
    const reviewerCriteria =
      isReviewer
        ? template.criteria.filter((c) => c.severity === "must")
        : [];

    const nodeCriteria =
      ownerCriteria.length > 0
        ? ownerCriteria.map((c) => ({
            id: c.id,
            text: c.text,
            severity: c.severity,
            concern: c.concern,
          }))
        : reviewerCriteria.length > 0
          ? reviewerCriteria.map((c) => ({
              id: c.id,
              text: c.text,
              severity: c.severity,
              concern: c.concern,
            }))
          : undefined;

    // Waterfall: first node at top-left origin, each subsequent node offset 2 grid
    // spaces down and right so the chain reads diagonally rather than stretching on
    // a single unreadably wide horizontal row.
    const ORIGIN_X = 100;
    const ORIGIN_Y = 80;
    const critics =
      template.reviewDepth === "none" || isTerminal || isReviewer ? undefined : ["critic"];
    return {
      id: `n${i + 1}`,
      roleKey,
      position: {
        x: snap(ORIGIN_X + i * STEP, GRID),
        y: snap(ORIGIN_Y + i * STEP, GRID),
      },
      criteria: nodeCriteria,
      critics,
    };
  });

  // Build edges: connect consecutive nodes.
  const edges = [];
  for (let i = 1; i < nodes.length; i++) {
    edges.push({
      id: `e${i}`,
      sourceNodeId: nodes[i - 1]!.id,
      targetNodeId: nodes[i]!.id,
      label: i === nodes.length - 1 ? "pass" : undefined,
      condition: { type: "always" as const },
    });
  }

  // Identify the reviewer node and add loopback metadata.
  const reviewerIdx = template.steps.indexOf(template.reviewerRole);
  if (reviewerIdx >= 0) {
    // Find the predecessor (the last non-reviewer, non-terminal before the reviewer).
    const predIdx = reviewerIdx - 1;
    if (predIdx >= 0 && edges[predIdx]) {
      edges[predIdx]!.label = "needs_more → loopback";
    }
  }

  const graph = {
    version: 1,
    nodes,
    edges,
    layout: { gridSize: GRID, snapToGrid: true },
    metadata: {
      rigor: template.rigor,
      maxLoopbacks: template.maxLoopbacks,
      mandatoryConcerns: template.mandatoryConcerns,
      reviewerRole: template.reviewerRole,
      reviewDepth: template.reviewDepth,
    },
  };

  return JSON.stringify(graph);
}

function snap(v: number, grid: number): number {
  return Math.round(v / grid) * grid;
}

/**
 * Seed (or refresh) system agent networks from the built-in flow templates.
 * Idempotent: only runs when version bumps or networks are missing. Only creates
 * rows for intake kinds that don't already have a system default.
 */
export function seedNetworks(): void {
  const stored = Number(getMeta("networks_seed_version") ?? "0");
  if (stored >= NETWORKS_SEED_VERSION) {
    // Check if any system networks exist at all — if not, re-seed regardless.
    const existing = listNetworks();
    if (existing.some((n) => n.is_system)) return;
  }

  // Bump: delete all old system networks so they are re-created with the
  // current waterfall layout. User-created networks are never touched.
  if (stored > 0 && stored < NETWORKS_SEED_VERSION) {
    const d = getDb();
    d.prepare(`DELETE FROM agent_networks WHERE is_system = 1`).run();
    console.log(`[roles] purged old system networks (v${stored} → v${NETWORKS_SEED_VERSION})`);
  }

  const seededKinds = new Set(
    listNetworks()
      .filter((n) => n.is_system)
      .map((n) => n.intake_kind),
  );

  let count = 0;
  for (const [kind, template] of Object.entries(FLOW_TEMPLATES) as [IntakeKind, FlowTemplate][]) {
    if (seededKinds.has(kind)) continue;

    const graphJson = flowToGraph(template, kind);
    createNetwork({
      name: `${kind.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())} Flow`,
      description: `Built-in ${template.rigor}-rigor flow for ${kind} intakes. ${template.steps.length} roles, ${template.criteria.length} criteria.`,
      project_id: null,
      intake_kind: kind,
      graph_json: graphJson,
      is_system: true,
      is_default: true,
    });
    count++;
  }

  setMeta("networks_seed_version", String(NETWORKS_SEED_VERSION));
  console.log(`[roles] seeded ${count} system agent networks (v${NETWORKS_SEED_VERSION})`);
}
