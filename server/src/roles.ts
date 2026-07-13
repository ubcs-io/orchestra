/**
 * Default role catalog + routing templates (seed data).
 *
 * Roles are seeded once as global rows (project_id NULL) and can be overridden
 * per project. The Orchestrator picks a subset + order per intake_kind from the
 * routing templates; users can override per task (§5.5 steering).
 */

import { countGlobalRoles, getMeta, setMeta, upsertRole } from "./db.js";

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
    mandatoryConcerns: ["correctness", "tests"], criteria: BUG_CRITERIA,
    steps: ["intake_triage", "explorer", "bug_investigator", "architecture_review", "test_strategy", "bug_review", "decomposition"],
  },
  bug: {
    key: "bug", rigor: "standard", reviewerRole: "bug_review", maxLoopbacks: 2,
    mandatoryConcerns: ["correctness", "tests"], criteria: BUG_CRITERIA,
    steps: ["intake_triage", "explorer", "bug_investigator", "architecture_review", "test_strategy", "bug_review", "decomposition"],
  },
  security: {
    key: "security", rigor: "high", reviewerRole: "security_review_adversary", maxLoopbacks: 1,
    mandatoryConcerns: ["security", "privacy"], criteria: SECURITY_CRITERIA,
    steps: ["intake_triage", "explorer", "security_review", "privacy_review", "architecture_review", "test_strategy", "security_review_adversary", "decomposition"],
  },
  feature: {
    key: "feature", rigor: "standard", reviewerRole: "spec_review", maxLoopbacks: 2,
    mandatoryConcerns: ["correctness", "security", "tests"], criteria: FEATURE_CRITERIA,
    steps: ["intake_triage", "requirements_analyst", "explorer", "architecture_review", "api_design", "data_schema_review", "security_review", "test_strategy", "spec_review", "decomposition"],
  },
  manual: {
    key: "spec", rigor: "standard", reviewerRole: "spec_review", maxLoopbacks: 2,
    mandatoryConcerns: ["correctness"], criteria: MANUAL_CRITERIA,
    steps: ["intake_triage", "explorer", "requirements_analyst", "architecture_review", "test_strategy", "spec_review", "decomposition"],
  },
  chore: {
    key: "chore", rigor: "low", reviewerRole: "spec_review", maxLoopbacks: 1,
    mandatoryConcerns: [], criteria: CHORE_CRITERIA,
    steps: ["intake_triage", "explorer", "style_conventions", "test_strategy", "spec_review", "decomposition"],
  },
  spike: {
    key: "spike", rigor: "low", reviewerRole: "spec_review", maxLoopbacks: 1,
    mandatoryConcerns: [], criteria: SPIKE_CRITERIA,
    steps: ["intake_triage", "explorer", "options_exploration", "architecture_review", "spec_review", "decomposition"],
  },
  research: {
    key: "research", rigor: "low", reviewerRole: "brief_review", maxLoopbacks: 1,
    mandatoryConcerns: [], criteria: RESEARCH_CRITERIA,
    steps: ["intake_triage", "user_research", "options_exploration", "edge_case_analysis", "brief_review", "research_synthesis"],
  },
  ux: {
    key: "research", rigor: "low", reviewerRole: "brief_review", maxLoopbacks: 1,
    mandatoryConcerns: [], criteria: RESEARCH_CRITERIA,
    steps: ["intake_triage", "ux_review", "user_research", "options_exploration", "edge_case_analysis", "brief_review", "research_synthesis"],
  },
  question: {
    key: "research", rigor: "low", reviewerRole: "brief_review", maxLoopbacks: 1,
    mandatoryConcerns: [], criteria: RESEARCH_CRITERIA,
    steps: ["intake_triage", "explorer", "options_exploration", "brief_review", "research_synthesis"],
  },
};

/** Resolve the flow for an intake kind (falls back to the manual flow). */
export function flowForIntake(kind: IntakeKind): FlowTemplate {
  return FLOW_TEMPLATES[kind] ?? FLOW_TEMPLATES.manual;
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
 * Shared output contract appended to every role's system prompt. Every role MUST
 * finish by calling `record_findings` exactly once — that structured call is how
 * the Orchestrator captures verdict + coverage without fragile text parsing.
 * (The tool-aware "How to work" preamble is prepended by `buildRoleSystemPrompt`.)
 */
export const OUTPUT_CONTRACT = `
## How to finish (required)
When done, call the \`record_findings\` tool EXACTLY ONCE with:
- verdict: one of "pass" (your concern is adequately addressed), "needs_more"
  (more refinement needed before this is actionable), "blocker" (a hard problem
  must be resolved first), or "needs_human" (ambiguity only a person can resolve).
- summary: one or two sentences capturing your key takeaway.
- open_questions: array of unresolved questions (empty if none).
- coverage: array of { concern, status, note } declaring which concerns you
  examined. status is "considered", "skipped" (relevant but you did not cover it —
  say why in note), or "out_of_scope". Draw concerns from: ${CONCERN_TAXONOMY.join(", ")}.
  Be honest about what you did NOT look at — omissions must be visible.
- section_md: a markdown section (start with a "## <Your Role>" heading) that will
  be appended to the task's planning artifact. Include concrete file references.

## If you are a counter-reviewer
When the context gives you an "Acceptance criteria to verify" checklist, your job
is to VERIFY the prior roles' work against it — not to author new content. Read the
findings and the code, then include one entry per criterion in the optional
\`criteria_results\` argument: { id, status: "met" | "partial" | "unmet", note }.
Set verdict "needs_more" if any "must" criterion is not fully met (this routes the
work back to the responsible role); use "pass" only when every "must" criterion is met.
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
    persona: `You ground the task in the real codebase. Locate the relevant files, entry points, and existing patterns or utilities that should be reused rather than reinvented. Map the affected surface area. Your output should let a later role reason precisely about where changes land.`,
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
  },
  {
    key: "architecture_review",
    title: "Architecture Review (Software Architect)",
    ordering: 50,
    tools: READ_ONLY_TOOLS.slice(),
    appliesTo: ["feature", "bug", "error_file", "manual", "spike", "security"],
    persona: `You assess design impact: module boundaries, the proposed approach, viable alternatives, and the main risks. Recommend the approach that best fits the existing architecture and say why.`,
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
    persona: `You identify hot paths, algorithmic complexity, and resource/data-volume implications of the work. Call out anything that degrades at scale.`,
  },
  {
    key: "api_design",
    title: "API Design (API Designer / Tech Lead)",
    ordering: 80,
    tools: READ_ONLY_TOOLS.slice(),
    appliesTo: ["feature"],
    persona: `You define contracts: signatures, endpoints, request/response shapes, and backward-compatibility considerations. Align with existing API conventions in the repo.`,
  },
  {
    key: "data_schema_review",
    title: "Data & Schema Review (Data Engineer / DBA)",
    ordering: 90,
    tools: READ_ONLY_TOOLS.slice(),
    appliesTo: ["feature", "bug"],
    persona: `You evaluate schema and migration impact, data integrity, and indexing. Flag any migration that is not backward-compatible or that risks data loss.`,
  },
  {
    key: "style_conventions",
    title: "Style & Conventions (Code Reviewer)",
    ordering: 100,
    tools: READ_ONLY_TOOLS.slice(),
    appliesTo: ["chore", "feature"],
    persona: `You check alignment with the repo's established conventions and naming, and point to existing utilities that should be reused. Keep the guidance actionable and specific to files you read.`,
  },
  {
    key: "test_strategy",
    title: "Test Strategy (QA / SDET)",
    ordering: 110,
    tools: READ_ONLY_TOOLS.slice(),
    appliesTo: ["feature", "bug", "error_file", "manual", "chore", "security"],
    persona: `You define the test plan: acceptance tests, key edge cases, and coverage expectations. For a bug, propose a specific regression test that would have caught the failure. Reference the repo's existing test patterns and framework.`,
  },
  {
    key: "dependency_integration",
    title: "Dependency & Integration (Build / DevEx)",
    ordering: 120,
    tools: READ_ONLY_TOOLS.slice(),
    appliesTo: ["feature"],
    persona: `You examine external dependencies, versioning, integration points, and CI/build impact of the work.`,
  },
  {
    key: "decomposition",
    title: "Decomposition (Tech Lead / Scrum Master)",
    ordering: 900,
    tools: READ_ONLY_TOOLS.slice(),
    appliesTo: ["feature", "bug", "error_file", "manual", "chore", "spike", "security"],
    persona: `You are the SPEC exit. Break the refined work into an epic → story → atomic task tree with clear sequencing, dependencies, and rough sizing. In section_md, present the tree explicitly using nested bullets labeled [epic], [story], [task] so downstream tooling can parse it. Each atomic task must be independently actionable with acceptance criteria.`,
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
    persona: `You enumerate edge cases, failure modes, and empty/error/loading and accessibility states relevant to the work. This is the "actionable feedback on edge cases" the user wants — be concrete.`,
  },
  {
    key: "research_synthesis",
    title: "Research Synthesis (Tech Lead)",
    ordering: 910,
    tools: NO_TOOLS,
    appliesTo: ["research", "ux", "question"],
    persona: `You are the RESEARCH_BRIEF exit. Roll the prior findings into a single decision brief: problem statement, the options with trade-offs, key edge cases, a recommendation, and any open questions. section_md should be a self-contained brief a human can act on immediately.`,
  },

  // ---- Optional/promotable extras (disabled by default via routing, still seeded) ----
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
 * Bump when the default personas / contract change so existing DBs re-seed the
 * global rows. Project-override rows (project_id set) are never touched.
 */
export const ROLES_SEED_VERSION = 2;

/**
 * Seed (or refresh) the global default role catalog. Idempotent within a version:
 * runs on first boot, and again when ROLES_SEED_VERSION increases so prompt fixes
 * propagate to existing databases. Only global (project_id NULL) rows are upserted.
 */
export function seedGlobalRoles(): void {
  const stored = Number(getMeta("roles_seed_version") ?? "0");
  if (countGlobalRoles() > 0 && stored >= ROLES_SEED_VERSION) return;
  for (const r of DEFAULT_ROLES) {
    upsertRole({
      project_id: null,
      key: r.key,
      title: r.title,
      enabled: true,
      applies_to: JSON.stringify(r.appliesTo),
      ordering: r.ordering,
      system_prompt: buildRoleSystemPrompt(r.persona, r.tools),
      tools_json: JSON.stringify(r.tools),
    });
  }
  setMeta("roles_seed_version", String(ROLES_SEED_VERSION));
  console.log(`[roles] seeded/updated ${DEFAULT_ROLES.length} global roles (v${ROLES_SEED_VERSION})`);
}
