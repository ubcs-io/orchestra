/**
 * Default role catalog + routing templates (seed data).
 *
 * Roles are seeded once as global rows (project_id NULL) and can be overridden
 * per project. The Orchestrator picks a subset + order per intake_kind from the
 * routing templates; users can override per task (§5.5 steering).
 */

import { countGlobalRoles, upsertRole } from "./db.js";

/** Read-only pi built-in tools given to code-inspecting roles. */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
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
  chore: "spec",
  spike: "spec",
  research: "research_brief",
  ux: "research_brief",
  question: "research_brief",
};

/**
 * Default ordered role plans per intake kind. The Orchestrator seeds a task's
 * refinement_plan_json from these, then may insert/skip roles dynamically and
 * the user may inject one-offs.
 */
export const ROUTING_TEMPLATES: Record<IntakeKind, string[]> = {
  error_file: ["intake_triage", "explorer", "bug_investigator", "architecture_review", "test_strategy", "decomposition"],
  bug: ["intake_triage", "explorer", "bug_investigator", "architecture_review", "test_strategy", "decomposition"],
  feature: [
    "intake_triage", "requirements_analyst", "explorer", "architecture_review",
    "api_design", "data_schema_review", "security_review", "test_strategy", "decomposition",
  ],
  chore: ["intake_triage", "explorer", "style_conventions", "test_strategy", "decomposition"],
  spike: ["intake_triage", "explorer", "options_exploration", "architecture_review", "decomposition"],
  manual: ["intake_triage", "explorer", "requirements_analyst", "architecture_review", "test_strategy", "decomposition"],
  research: ["intake_triage", "user_research", "options_exploration", "edge_case_analysis", "research_synthesis"],
  ux: ["intake_triage", "ux_review", "user_research", "options_exploration", "edge_case_analysis", "research_synthesis"],
  question: ["intake_triage", "explorer", "options_exploration", "research_synthesis"],
};

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
  "manual", "error_file", "feature", "bug", "chore", "spike", "research", "ux", "question",
];

/**
 * Shared output contract appended to every role's system prompt. Every role MUST
 * finish by calling `record_findings` exactly once — that structured call is how
 * the Orchestrator captures verdict + coverage without fragile text parsing.
 */
export const OUTPUT_CONTRACT = `
## How to work
You are one step in a multi-role refinement loop operating on a real git repository.
Ground every claim in the actual code: use your tools (read, grep, find, ls) to inspect
files before asserting anything. Do not invent file names, symbols, or behavior.

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
    tools: READ_ONLY_TOOLS.slice(),
    appliesTo: ["error_file", "bug"],
    persona: `You determine why something fails. Produce reproduction logic, a root-cause hypothesis grounded in the code you read, the specific failing component, and the evidence for it. Distinguish proven facts from hypotheses.`,
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
    appliesTo: ["feature", "bug", "error_file", "manual", "spike"],
    persona: `You assess design impact: module boundaries, the proposed approach, viable alternatives, and the main risks. Recommend the approach that best fits the existing architecture and say why.`,
  },
  {
    key: "security_review",
    title: "Security Review (AppSec Engineer)",
    ordering: 60,
    tools: READ_ONLY_TOOLS.slice(),
    appliesTo: ["feature", "bug"],
    persona: `You threat-model the change: injection, authz, secrets handling, and dependency risks. Produce security acceptance criteria. Explicitly note whether privacy of user data is implicated (and if you did not examine it, say so in coverage).`,
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
    appliesTo: ["feature", "bug", "error_file", "manual", "chore"],
    persona: `You define the test plan: acceptance tests, key edge cases, and coverage expectations. Reference the repo's existing test patterns and framework.`,
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
    appliesTo: ["feature", "bug", "error_file", "manual", "chore", "spike"],
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
    appliesTo: ["feature", "bug"],
    persona: `You examine how the change collects, stores, transmits, or exposes personal or sensitive data. Identify data flows, retention, and minimization concerns, and produce privacy acceptance criteria. This role is the canonical example of a step a user can inject and then promote to standing project policy.`,
  },
];

/** Build the full system prompt for a role (persona + shared contract). */
export function buildRoleSystemPrompt(persona: string): string {
  return `${persona}\n\n${OUTPUT_CONTRACT}`;
}

/** Seed the global default role catalog once (no-op if already seeded). */
export function seedGlobalRoles(): void {
  if (countGlobalRoles() > 0) return;
  for (const r of DEFAULT_ROLES) {
    upsertRole({
      project_id: null,
      key: r.key,
      title: r.title,
      enabled: true,
      applies_to: JSON.stringify(r.appliesTo),
      ordering: r.ordering,
      system_prompt: buildRoleSystemPrompt(r.persona),
      tools_json: JSON.stringify(r.tools),
    });
  }
  console.log(`[roles] seeded ${DEFAULT_ROLES.length} global roles`);
}
