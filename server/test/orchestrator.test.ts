import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CoverageItem, CriteriaResult, RoleRunResult, Subtask, Verdict } from "../src/agent";
import { closeDb, createCandidate, createIntervention, createProject, createRoleRun, createTask, getCandidate, getProject, getTask, getTaskHealthSummaries, listCandidates, listInterventions, listRoleRuns, listTasks, resetTask, updateCandidate, updateProject, updateTask, upsertConfig, type TaskRow } from "../src/db";
import type { RoleRunRow } from "../src/db";
import { resetConfig } from "../src/config";
import { appendArtifactSection, checkoutBranch, commitArtifacts, scaffoldPlanning, writeArtifact } from "../src/git";
import { flowForIntake, ROUTING_TEMPLATES, type Criterion } from "../src/roles";
import { seedGlobalRoles } from "../src/roles";
import {
  applyFamilyBudget,
  applyPlanMutation,
  checkEvidenceCriteria,
  dependenciesSatisfied,
  EFFORT_BUDGET,
  inferIntakeKind,
  mergeCoverageItems,
  nextPending,
  parseDecompositionTree,
  planFromTemplate,
  reincorporateAnswer,
  renderSubtaskTree,
  resetReachabilityChecker,
  resetRoleRunner,
  abortAllInFlight,
  materializeIntakeTask,
  resolveDecompositionSubtasks,
  resolveFamilyBudget,
  restoreCheckpoint,
  setReachabilityChecker,
  setRoleRunner,
  tick,
  tickOnce,
} from "../src/orchestrator";
import type { RoleRunner } from "../src/orchestrator";
import { resetRouterFns, setAnswerMatchFn, setSecondReviewFn, setTriageFn } from "../src/router";
import { resetHumanActivityClock } from "../src/autonomy";
import { tickWatchers } from "../src/watchers";
import { freshDb, tempGitRepo } from "./helpers";

// The pre-flight reachability gate would otherwise hit a real (nonexistent)
// endpoint for every step — stub it as always-reachable, matching how
// setRoleRunner() stubs out the real LLM call.
beforeEach(() => {
  setReachabilityChecker(async () => ({ ok: true }));
});

afterEach(() => {
  resetRoleRunner();
  resetReachabilityChecker();
  resetRouterFns();
  closeDb();
});

// ---- Pure helpers -------------------------------------------------------

describe("planFromTemplate / nextPending", () => {
  it("builds a pending plan from the routing template", () => {
    const plan = planFromTemplate("error_file");
    expect(plan.steps.map((s) => s.role)).toEqual(ROUTING_TEMPLATES.error_file);
    expect(plan.steps.every((s) => s.status === "pending" && s.depth === 1)).toBe(true);
    expect(nextPending(plan)?.role).toBe(ROUTING_TEMPLATES.error_file[0]);
    plan.steps[0]!.status = "done";
    expect(nextPending(plan)?.role).toBe(ROUTING_TEMPLATES.error_file[1]);
  });
});

describe("mergeCoverageItems", () => {
  it("applies precedence considered > skipped > out_of_scope > never", () => {
    const map = mergeCoverageItems([
      [{ concern: "security", status: "skipped" }],
      [{ concern: "security", status: "considered" }],
      [{ concern: "privacy", status: "out_of_scope" }],
    ]);
    expect(map.security?.status).toBe("considered");
    expect(map.privacy?.status).toBe("out_of_scope");
    expect(map.performance?.status).toBe("never"); // untouched concern
  });

  it("does not let a weaker status override a stronger one", () => {
    const map = mergeCoverageItems([
      [{ concern: "security", status: "considered" }],
      [{ concern: "security", status: "skipped" }],
    ]);
    expect(map.security?.status).toBe("considered");
  });
});

describe("inferIntakeKind", () => {
  it("detects error files by extension and by traceback content", () => {
    expect(inferIntakeKind("crash.log", "anything")).toBe("error_file");
    expect(inferIntakeKind("x.txt", "Traceback (most recent call last):")).toBe("error_file");
    expect(inferIntakeKind("note.md", "just a normal note")).toBe("manual");
  });

  it("detects security reports by filename or content signal", () => {
    expect(inferIntakeKind("security-report.md", "found an issue")).toBe("security");
    expect(inferIntakeKind("report.txt", "Reflected XSS in the search box")).toBe("security");
    expect(inferIntakeKind("report.txt", "CVE-2025-1234 affects our parser")).toBe("security");
    // A plain trace is still an error_file, not security.
    expect(inferIntakeKind("crash.log", "NullPointerException at Foo.bar")).toBe("error_file");
  });
});

describe("flow templates", () => {
  it("seeds the counter-reviewer immediately before the terminal role", () => {
    const plan = planFromTemplate("error_file");
    const roles = plan.steps.map((s) => s.role);
    const flow = flowForIntake("error_file");
    expect(roles).toContain(flow.reviewerRole);
    expect(roles.indexOf(flow.reviewerRole)).toBe(roles.indexOf("decomposition") - 1);
  });
});

describe("applyPlanMutation", () => {
  const isTerminal = (r: string) => r === "decomposition";

  it("injects before the terminal role when no anchor given", () => {
    const plan = planFromTemplate("error_file");
    applyPlanMutation(plan, "inject_role", { role: "privacy_review" }, isTerminal);
    const roles = plan.steps.map((s) => s.role);
    expect(roles.indexOf("privacy_review")).toBe(roles.indexOf("decomposition") - 1);
  });

  it("injects after a named anchor role", () => {
    const plan = planFromTemplate("error_file");
    applyPlanMutation(plan, "inject_role", { role: "privacy_review", after: "explorer" }, isTerminal);
    const roles = plan.steps.map((s) => s.role);
    expect(roles[roles.indexOf("explorer") + 1]).toBe("privacy_review");
  });

  it("deepen bumps depth and re-pends", () => {
    const plan = planFromTemplate("error_file");
    plan.steps[1]!.status = "done";
    applyPlanMutation(plan, "deepen", { role: plan.steps[1]!.role }, isTerminal);
    expect(plan.steps[1]!.depth).toBe(2);
    expect(plan.steps[1]!.status).toBe("pending");
  });
});

describe("parseDecompositionTree", () => {
  it("parses [epic]/[story]/[task] bullets", () => {
    const tree = parseDecompositionTree("- [epic] Big\n  - [story] A\n    - [task] do x\n    - [task] do y");
    expect(tree.map((n) => n.level)).toEqual(["epic", "story", "task", "task"]);
    expect(tree[2]!.name).toBe("do x");
  });

  it("falls back to a numbered/tree-drawing prose format when no bracket tags are present", () => {
    const md = [
      "1. Epic: Tags default to collapsed in sidebar",
      "├── 2. Story: Implement default collapsed state",
      "│   ├── 3. Task: Change useState initial value (DashboardClient.tsx:247)",
      "│   │   └── `useState(true)` → `useState(false)`",
      "│   └── 4. Task: Update PREF_DEFAULTS (user-preferences.ts:36)",
      "│       └── `tagsExpanded: 'true'` → `tagsExpanded: 'false'`",
      "└── 5. Story: Add test coverage (recommended)",
      "    ├── 6. Task: Unit test for PREF_DEFAULTS.tagsExpanded",
      "    │   └── Add to media-vault/__tests__/lib/display-name.test.ts",
      "    └── 7. Task: E2e regression test for collapsed default",
      "        └── Add to media-vault/e2e/tags.spec.ts",
    ].join("\n");
    const tree = parseDecompositionTree(md);
    expect(tree.map((n) => n.level)).toEqual([
      "epic", "story", "task", "task", "story", "task", "task",
    ]);
    expect(tree.map((n) => n.name)).toEqual([
      "Tags default to collapsed in sidebar",
      "Implement default collapsed state",
      "Change useState initial value (DashboardClient.tsx:247)",
      "Update PREF_DEFAULTS (user-preferences.ts:36)",
      "Add test coverage (recommended)",
      "Unit test for PREF_DEFAULTS.tagsExpanded",
      "E2e regression test for collapsed default",
    ]);
  });

  it("prefers bracket tags over the tree-drawing fallback when both could match", () => {
    const tree = parseDecompositionTree("- [epic] Big\n1. Task: should not be used");
    expect(tree).toEqual([{ level: "epic", name: "Big" }]);
  });
});

function createProjectTask(projectId: number, overrides: Record<string, unknown> = {}): TaskRow {
  const t = createTask({ name: "t", project_id: projectId });
  return Object.keys(overrides).length ? updateTask(t.task_id, overrides)! : t;
}

function makeSubtask(overrides: Partial<Subtask> = {}): Subtask {
  return {
    local_id: "1",
    level: "task",
    name: "Do the thing",
    brief: "",
    acceptance_criteria: [],
    context_to_carry_forward: "",
    ...overrides,
  };
}

describe("renderSubtaskTree", () => {
  it("renders bracket-tag lines that round-trip through parseDecompositionTree", () => {
    const subtasks = [
      makeSubtask({ local_id: "1", level: "epic", name: "Big epic" }),
      makeSubtask({ local_id: "2", level: "story", name: "A story" }),
      makeSubtask({ local_id: "3", level: "task", name: "do x", depends_on: ["2"] }),
    ];
    const md = renderSubtaskTree(subtasks);
    expect(md).toContain("### Task Tree");
    expect(md).toContain("- [epic] Big epic");
    expect(md).toContain("- [story] A story");
    expect(md).toContain("- [task] do x (depends on: 2)");

    const parsed = parseDecompositionTree(md);
    expect(parsed.map((n) => ({ level: n.level, name: n.name }))).toEqual([
      { level: "epic", name: "Big epic" },
      { level: "story", name: "A story" },
      { level: "task", name: "do x (depends on: 2)" },
    ]);
  });
});

describe("resolveDecompositionSubtasks", () => {
  it("prefers subtasks_json when present and non-empty", () => {
    const subtasks = [makeSubtask({ name: "From structured output" })];
    const decomp = { subtasks_json: JSON.stringify(subtasks), output_md: "- [task] From regex" } as RoleRunRow;
    const result = resolveDecompositionSubtasks(decomp);
    expect(result.legacy).toBe(false);
    expect(result.subtasks.map((s) => s.name)).toEqual(["From structured output"]);
  });

  it("falls back to parseDecompositionTree(output_md) when subtasks_json is absent or empty", () => {
    const decomp = {
      subtasks_json: null,
      output_md: "- [epic] Big\n  - [task] do x",
    } as unknown as RoleRunRow;
    const result = resolveDecompositionSubtasks(decomp);
    expect(result.legacy).toBe(true);
    expect(result.subtasks.map((s) => s.name)).toEqual(["Big", "do x"]);
    expect(result.subtasks.every((s) => s.brief === "" && s.acceptance_criteria.length === 0)).toBe(true);
  });

  it("falls back to output_md when subtasks_json is malformed JSON", () => {
    const decomp = { subtasks_json: "not json", output_md: "- [task] recovered" } as RoleRunRow;
    const result = resolveDecompositionSubtasks(decomp);
    expect(result.legacy).toBe(true);
    expect(result.subtasks.map((s) => s.name)).toEqual(["recovered"]);
  });

  it("returns empty when both sources are absent/empty", () => {
    expect(resolveDecompositionSubtasks(undefined)).toEqual({ subtasks: [], legacy: false });
    const decomp = { subtasks_json: "[]", output_md: "no bracket tags here" } as RoleRunRow;
    expect(resolveDecompositionSubtasks(decomp)).toEqual({ subtasks: [], legacy: false });
  });
});

describe("resolveFamilyBudget / applyFamilyBudget", () => {
  it("looks up maxCount/maxDepth by effort_size, scaled by rigor", () => {
    freshDb();
    seedGlobalRoles();
    const project = createProject({ name: "p", repo_path: tempGitRepo() });
    const root = createProjectTask(project.id, { effort_size: "S" });
    expect(resolveFamilyBudget(root)).toEqual(EFFORT_BUDGET.S);
    expect(resolveFamilyBudget(root, "minimal").maxCount).toBe(Math.ceil(EFFORT_BUDGET.S.maxCount * 0.6));
    expect(resolveFamilyBudget(root, "thorough").maxCount).toBe(Math.ceil(EFFORT_BUDGET.S.maxCount * 1.5));
  });

  it("falls back to the M budget when effort_size hasn't been set yet", () => {
    freshDb();
    seedGlobalRoles();
    const project = createProject({ name: "p", repo_path: tempGitRepo() });
    const root = createProjectTask(project.id, { effort_size: null });
    expect(resolveFamilyBudget(root)).toEqual(EFFORT_BUDGET.M);
  });

  it("truncates a proposed subtask list once the family's existing size would exceed maxCount", () => {
    freshDb();
    seedGlobalRoles();
    const project = createProject({ name: "p", repo_path: tempGitRepo() });
    // "S" => maxCount 4. The root itself already counts as 1 family member,
    // leaving room for exactly 3 more before the budget is exhausted.
    const root = createProjectTask(project.id, { effort_size: "S" });
    const proposed = Array.from({ length: 6 }, (_, i) =>
      makeSubtask({ local_id: String(i + 1), level: "task", name: `Task ${i + 1}` }),
    );
    const decision = applyFamilyBudget(root, project, proposed);
    expect(decision.budget).toEqual(EFFORT_BUDGET.S);
    expect(decision.depthBlocked).toBe(false);
    expect(decision.allowedSubtasks.length).toBe(3);
    expect(decision.truncatedCount).toBe(3);
  });

  it("blocks non-leaf children once the family is already at the depth ceiling, keeping only execution-ready leaves", () => {
    freshDb();
    seedGlobalRoles();
    const project = createProject({ name: "p", repo_path: tempGitRepo() });
    // "S" => maxDepth 1. A story that is itself already 1 hop below the root
    // is AT the ceiling, so any further epic/story children it proposes must
    // be refused — only already execution-ready task leaves may pass.
    const root = createProjectTask(project.id, { effort_size: "S", level: "epic" });
    const story = createTask({
      name: "story",
      project_id: project.id,
      parent_task_id: root.task_id,
      level: "story",
    });
    const proposed = [
      makeSubtask({ local_id: "1", level: "story", name: "Nested story (should be dropped)" }),
      makeSubtask({ local_id: "2", level: "task", name: "Leaf A", execution_ready: true }),
      makeSubtask({ local_id: "3", level: "task", name: "Non-leaf task (dropped: not execution_ready)" }),
    ];
    const decision = applyFamilyBudget(story, project, proposed);
    expect(decision.depthBlocked).toBe(true);
    expect(decision.allowedSubtasks.map((s) => s.name)).toEqual(["Leaf A"]);
    expect(decision.truncatedCount).toBe(2);
  });

  it("XS gets a zero budget at every depth, so any decomposition attempt is fully refused", () => {
    freshDb();
    seedGlobalRoles();
    const project = createProject({ name: "p", repo_path: tempGitRepo() });
    const root = createProjectTask(project.id, { effort_size: "XS" });
    const proposed = [makeSubtask({ local_id: "1", level: "task", name: "Anything" })];
    const decision = applyFamilyBudget(root, project, proposed);
    expect(decision.allowedSubtasks).toEqual([]);
    expect(decision.truncatedCount).toBe(1);
  });

  it("scales the budget by the root's effective planning_rigor (task override over project default)", () => {
    freshDb();
    seedGlobalRoles();
    // Project default "thorough" (×1.5); root's own task-level override
    // "minimal" (×0.6) must win — mirrors effectiveAutonomyLevel's precedence.
    const project = createProject({
      name: "p",
      repo_path: tempGitRepo(),
      config_json: JSON.stringify({ planningRigor: "thorough" }),
    });
    const root = createProjectTask(project.id, { effort_size: "M", planning_rigor: "minimal" });
    const proposed = Array.from({ length: 10 }, (_, i) =>
      makeSubtask({ local_id: String(i + 1), level: "task", name: `Task ${i + 1}` }),
    );
    const decision = applyFamilyBudget(root, project, proposed);
    // M => maxCount 12; minimal => ×0.6 => ceil(7.2) = 8; root itself counts
    // as 1 existing family member, leaving room for 7.
    expect(decision.budget.maxCount).toBe(8);
    expect(decision.allowedSubtasks.length).toBe(7);
  });
});

describe("dependenciesSatisfied", () => {
  it("treats a task with no depends_on_json as immediately schedulable", () => {
    freshDb();
    seedGlobalRoles();
    const project = createProject({ name: "p", repo_path: tempGitRepo() });
    const t = createProjectTask(project.id, { depends_on_json: null });
    expect(dependenciesSatisfied(t)).toBe(true);
  });

  it("blocks until every dependency reaches stage ready, including a wont_do finalization", () => {
    freshDb();
    seedGlobalRoles();
    const project = createProject({ name: "p", repo_path: tempGitRepo() });
    const dep = createProjectTask(project.id, { stage: "refining" });
    const t = createProjectTask(project.id, { depends_on_json: JSON.stringify([dep.task_id]) });
    expect(dependenciesSatisfied(t)).toBe(false);

    updateTask(dep.task_id, { stage: "ready", exit_state: "wont_do" });
    expect(dependenciesSatisfied(t)).toBe(true);
  });

  it("fails open (schedulable) on malformed depends_on_json", () => {
    freshDb();
    seedGlobalRoles();
    const project = createProject({ name: "p", repo_path: tempGitRepo() });
    const t = createProjectTask(project.id, { depends_on_json: "not json" });
    expect(dependenciesSatisfied(t)).toBe(true);
  });
});

// ---- Integration: the full loop with an injected fake runner ------------

function fakeRunner(
  verdict: Verdict,
  opts: { coverage?: CoverageItem[]; criteria?: CriteriaResult[] } = {},
): RoleRunner {
  return async () => ({
    findings: {
      verdict,
      summary: `${verdict} from fake`,
      open_questions: [],
      coverage: opts.coverage ?? [{ concern: "security", status: "considered" }],
      section_md: "## role\n- [epic] Epic\n- [task] implement the fix\n",
      criteria_results: opts.criteria ?? [],
    },
    toolCalls: [],
    transcriptJsonl: "",
    tokens: 3,
    model: "fake",
    fallback: false,
    stalled: false,
    thinkingText: "",
    filesWritten: [],
  });
}

/** All CONCERN_TAXONOMY concerns marked "considered" — satisfies mandatoryConcerns. */
const ALL_CONSIDERED: CoverageItem[] = [
  "correctness", "security", "privacy", "performance", "accessibility",
  "edge-cases", "tests", "dependencies", "data", "ux", "docs",
].map((concern) => ({ concern, status: "considered" as const }));

/** Every acceptance criterion for a flow marked met (a clean counter-review). */
function allMet(kind: Parameters<typeof flowForIntake>[0]): CriteriaResult[] {
  return flowForIntake(kind).criteria.map((c) => ({ id: c.id, status: "met" as const }));
}

/**
 * A runner that distinguishes the counter-reviewer (detected via the injected
 * "Acceptance criteria to verify" block) from producer roles, and can fail the
 * review a bounded number of times before passing.
 */
function scriptedRunner(opts: { reviewerFailures: number; unmetId?: string }): RoleRunner {
  let reviewerCalls = 0;
  return async (params) => {
    const isReviewer = params.context.includes("Acceptance criteria to verify");
    let verdict: Verdict = "pass";
    let criteria: CriteriaResult[] = [];
    if (isReviewer) {
      reviewerCalls += 1;
      // The reviewer's context lists each criterion id in backticks (e.g. `bug.locate`).
      const ids = [...params.context.matchAll(/`([a-z_]+\.[a-z_]+)`/gi)].map((m) => m[1]!);
      const failing = reviewerCalls <= opts.reviewerFailures;
      criteria = ids.map((id) => ({
        id,
        status: failing && (!opts.unmetId || id === opts.unmetId) ? "unmet" : "met",
      }));
      if (failing) verdict = "needs_more";
    }
    return {
      findings: {
        verdict,
        summary: `${verdict} from scripted (${isReviewer ? "reviewer" : "producer"})`,
        open_questions: [],
        coverage: ALL_CONSIDERED,
        section_md: "## role\n- [epic] Epic\n- [task] implement the fix\n",
        criteria_results: criteria,
      },
      toolCalls: [],
      transcriptJsonl: "",
      tokens: 1,
      model: "fake",
      fallback: false,
      stalled: false,
      thinkingText: "",
      filesWritten: [],
    };
  };
}

/**
 * A reviewer that reports verdict "pass" with an EMPTY criteria_results for
 * its first `failCount` calls — the "complied with the prose verdict, skipped
 * the structured checklist" failure mode — then, on the call after, populates
 * criteria_results with every criterion met. The (separate) decomposition
 * role, if the flow reaches one, always reports an intentional
 * no_decomposition_reason so this fixture isolates the reviewer-retry
 * behavior instead of also tripping the empty-subtasks retry. Every other
 * producer role just passes cleanly.
 */
function reviewerEmptyCriteriaRunner(failCount: number): RoleRunner {
  let reviewerCalls = 0;
  return async (params) => {
    const isReviewer = params.context.includes("Acceptance criteria to verify");
    const isDecomp = params.context.includes("**decomposition** role");
    let criteria: CriteriaResult[] = [];
    if (isReviewer) {
      reviewerCalls += 1;
      if (reviewerCalls > failCount) {
        const ids = [...params.context.matchAll(/`([a-z_]+\.[a-z_]+)`/gi)].map((m) => m[1]!);
        criteria = ids.map((id) => ({ id, status: "met" as const }));
      }
    }
    return {
      findings: {
        verdict: "pass",
        summary: isReviewer ? "reviewer pass (see criteria_results)" : "pass from fake",
        open_questions: [],
        coverage: ALL_CONSIDERED,
        section_md: "## role\ndone",
        criteria_results: criteria,
        no_decomposition_reason: isDecomp ? "Atomic fix, no further decomposition needed." : undefined,
      },
      toolCalls: [],
      transcriptJsonl: "",
      tokens: 1,
      model: "fake",
      fallback: false,
      stalled: false,
      thinkingText: "",
      filesWritten: [],
    };
  };
}

/**
 * A runner that distinguishes the counter-reviewer (same detection as
 * scriptedRunner, auto-passing every criterion) from the decomposition role
 * (detected via buildRoleContext's "You are the **decomposition** role" line),
 * letting a test control exactly what decomposition reports — a subtask list,
 * an explicit no_decomposition_reason, or neither (the anomaly case) — while
 * every other producer role just passes cleanly with no bracket-tag markup
 * (so legacy regex fallback never accidentally fires for a role that isn't
 * actually decomposition).
 */
function decompositionRunner(
  opts: { decompSubtasks?: Subtask[]; noDecompositionReason?: string } = {},
): RoleRunner {
  return async (params) => {
    const isReviewer = params.context.includes("Acceptance criteria to verify");
    const isDecomp = params.context.includes("**decomposition** role");
    const criteria: CriteriaResult[] = isReviewer
      ? [...params.context.matchAll(/`([a-z_]+\.[a-z_]+)`/gi)].map((m) => ({
          id: m[1]!,
          status: "met" as const,
        }))
      : [];
    return {
      findings: {
        verdict: "pass",
        summary: isDecomp ? "decomposition done" : "pass from fake",
        open_questions: [],
        coverage: ALL_CONSIDERED,
        section_md: isDecomp ? "## Decomposition\n(see structured subtasks)" : "## role\ndone",
        criteria_results: criteria,
        subtasks: isDecomp ? (opts.decompSubtasks ?? []) : undefined,
        no_decomposition_reason: isDecomp ? opts.noDecompositionReason : undefined,
      },
      toolCalls: [],
      transcriptJsonl: "",
      tokens: 1,
      model: "fake",
      fallback: false,
      stalled: false,
      thinkingText: "",
      filesWritten: [],
    };
  };
}

/**
 * Like decompositionRunner, but the decomposition role specifically returns
 * empty subtasks/no reason for its first `failCount` invocations before
 * reporting `subtasks` on the call after — for exercising the empty-subtasks
 * retry in runOneStep. Only counts calls where isDecomp is true, so earlier
 * pipeline roles (intake_triage, explorer, ...) don't consume the budget.
 */
function decompositionRetryRunner(failCount: number, subtasks: Subtask[]): RoleRunner {
  let decompCalls = 0;
  return async (params) => {
    const isReviewer = params.context.includes("Acceptance criteria to verify");
    const isDecomp = params.context.includes("**decomposition** role");
    const criteria: CriteriaResult[] = isReviewer
      ? [...params.context.matchAll(/`([a-z_]+\.[a-z_]+)`/gi)].map((m) => ({
          id: m[1]!,
          status: "met" as const,
        }))
      : [];
    if (isDecomp) decompCalls += 1;
    const succeeds = isDecomp && decompCalls > failCount;
    return {
      findings: {
        verdict: "pass",
        summary: isDecomp ? "decomposition done" : "pass from fake",
        open_questions: [],
        coverage: ALL_CONSIDERED,
        section_md: isDecomp ? "## Decomposition\n(see structured subtasks)" : "## role\ndone",
        criteria_results: criteria,
        subtasks: isDecomp ? (succeeds ? subtasks : []) : undefined,
        no_decomposition_reason: undefined,
      },
      toolCalls: [],
      transcriptJsonl: "",
      tokens: 1,
      model: "fake",
      fallback: false,
      stalled: false,
      thinkingText: "",
      filesWritten: [],
    };
  };
}

/**
 * Every ordinary role step just passes cleanly. The new recap-decomposition
 * call (detected via its distinct systemPrompt, not context — it's a separate
 * ad-hoc roleRunner call, not a normal pipeline step) either proposes the
 * given `subtasks`, or throws if `throwOnRecapDecomposition` is set (for
 * exercising the error/timeout-swallowing path). The prose recap call (also
 * detected via systemPrompt) just returns a trivial summary.
 */
function recapDecompositionRunner(
  subtasks: Subtask[],
  opts: { throwOnRecapDecomposition?: boolean } = {},
): RoleRunner {
  return async (params) => {
    const isRecapDecomp = params.systemPrompt.includes(
      "reviewing a just-finished task's complete history",
    );
    const isProseRecap = params.systemPrompt.includes(
      "orchestration layer performing a final recap",
    );
    if (isRecapDecomp && opts.throwOnRecapDecomposition) {
      throw new Error("simulated recap-decomposition failure");
    }
    return {
      findings: {
        verdict: "pass",
        summary: isRecapDecomp ? "recap-decomposition" : isProseRecap ? "recap" : "pass from fake",
        open_questions: [],
        coverage: ALL_CONSIDERED,
        section_md: "## role\ndone",
        criteria_results: [],
        subtasks: isRecapDecomp ? subtasks : undefined,
      },
      toolCalls: [],
      transcriptJsonl: "",
      tokens: 1,
      model: "fake",
      fallback: false,
      stalled: false,
      thinkingText: "",
      filesWritten: [],
    };
  };
}

function rootTask(projectId: number): TaskRow | undefined {
  return listTasks({ projectId }).find((t) => t.parent_task_id == null);
}

async function drainTicks(projectId: number, until: (t: TaskRow) => boolean, max = 30): Promise<void> {
  for (let i = 0; i < max; i++) {
    await tick();
    const t = rootTask(projectId);
    if (t && until(t)) return;
  }
}

function setupProject(): { repo: string; projectId: number } {
  const repo = tempGitRepo();
  freshDb();
  seedGlobalRoles();
  const project = createProject({ name: "p", repo_path: repo });
  scaffoldPlanning(repo, "PLANNING");
  return { repo, projectId: project.id };
}

describe("orchestrator loop (integration)", () => {
  it("ingests → plans → runs → reaches READY with children (spec exit)", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(
      path.join(repo, "PLANNING", "INTAKE", "crash.log"),
      "Traceback (most recent call last):\nValueError: boom",
    );
    // A clean run: producers pass, the counter-reviewer finds every criterion met
    // and mandatory concerns covered, so no loop-back occurs.
    setRoleRunner(fakeRunner("pass", { coverage: ALL_CONSIDERED, criteria: allMet("error_file") }));

    // First tick: ingest → seeds plan → bumps level to epic so the recursion
    // guard allows the decomposition role to spawn children.
    await tick();
    const t0 = rootTask(projectId);
    if (t0) updateTask(t0.task_id, { level: "epic" });

    await drainTicks(projectId, (t) => t.stage === "ready" || t.stage === "review");

    const t = rootTask(projectId)!;
    expect(t.intake_kind).toBe("error_file");
    expect(t.stage).toBe("ready");
    expect(t.exit_state).toBe("ready_for_work");
    // Every planned role ran exactly once (no loop-back), plus one adversarial
    // critique run at the reviewer step (error_file's reviewDepth is "terminal_only").
    expect(listRoleRuns(t.task_id).length).toBe(ROUTING_TEMPLATES.error_file.length + 1);
    expect(listRoleRuns(t.task_id).filter((r) => r.role_key === "critic").length).toBe(1);
    // Artifact moved into READY, committed on the task's own checkpoint branch.
    expect(t.artifact_path).toContain("READY");
    expect(t.git_branch).toBeTruthy();
    expect(t.git_base_branch).toBeTruthy();
    expect(t.git_worktree_path).toBeTruthy();
    // The root reached "ready" but its decomposition children share its
    // worktree/branch and haven't run yet — reconciliation is deferred until
    // the whole family settles (see maybeReconcileFamily), so nothing has
    // merged into base yet and the artifact isn't in the shared checkout.
    expect(t.reconcile_status).toBeNull();
    const currentBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo })
      .toString()
      .trim();
    expect(currentBranch).toBe(t.git_base_branch);
    expect(fs.existsSync(path.join(repo, t.artifact_path!))).toBe(false);
    expect(fs.existsSync(path.join(t.git_worktree_path!, t.artifact_path!))).toBe(true);
    // Decomposition produced child tasks, sharing the root's worktree family.
    const children = listTasks({ parentTaskId: t.task_id });
    expect(children.length).toBeGreaterThan(0);
    expect(children.every((c) => c.git_worktree_path === t.git_worktree_path)).toBe(true);
    expect(children.every((c) => c.git_branch === t.git_branch)).toBe(true);
    // INTAKE original was consumed (moved out).
    expect(fs.existsSync(path.join(repo, "PLANNING", "INTAKE", "crash.log"))).toBe(false);
  });

  it("defers family reconciliation until every descendant settles, then merges once onto the root", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(
      path.join(repo, "PLANNING", "INTAKE", "crash.log"),
      "Traceback (most recent call last):\nValueError: boom",
    );
    // The decomposition role produces two non-recursive "task"-level children
    // on its first invocation only; every later decomposition call (i.e. each
    // child's own terminal role) reports zero subtasks with a stated reason —
    // which the orchestrator now treats as "this one node is itself atomic",
    // spinning up exactly one execution-ready grandchild per child instead of
    // growing the subtask tree further. So the family ends up 5-deep (root +
    // 2 children + 2 grandchildren), not 3.
    let decompCalls = 0;
    const childSubtasks: Subtask[] = [
      makeSubtask({ local_id: "1", name: "Child A" }),
      makeSubtask({ local_id: "2", name: "Child B" }),
    ];
    setRoleRunner((params) => {
      const isDecomp = params.context.includes("**decomposition** role");
      if (isDecomp) decompCalls += 1;
      return decompositionRunner({
        decompSubtasks: isDecomp && decompCalls === 1 ? childSubtasks : [],
        noDecompositionReason: isDecomp && decompCalls > 1 ? "atomic — no further breakdown needed" : undefined,
      })(params);
    });

    await tick();
    const t0 = rootTask(projectId);
    if (t0) updateTask(t0.task_id, { level: "epic" });

    // Drain until every family member (root, both children, and each child's
    // own synthesized execution-ready grandchild) is out of intake/refining.
    for (let i = 0; i < 80; i++) {
      await tick();
      const t = rootTask(projectId);
      const family = t ? listTasks({ rootTaskId: t.task_id }).filter((m) => m.task_id !== t.task_id) : [];
      if (t && t.stage !== "intake" && t.stage !== "refining" && family.length === 4 && family.every((m) => m.stage !== "intake" && m.stage !== "refining")) {
        break;
      }
    }

    const t = rootTask(projectId)!;
    const children = listTasks({ parentTaskId: t.task_id });
    expect(children.length).toBe(2);
    expect(children.every((c) => c.stage === "ready" || c.stage === "review")).toBe(true);
    const grandchildren = children.flatMap((c) => listTasks({ parentTaskId: c.task_id }));
    expect(grandchildren.length).toBe(2);
    expect(grandchildren.every((g) => g.exit_kind === "code_change")).toBe(true);
    // A code_change leaf always finishes at review/needs_merge_approval, with
    // reconcile_status set directly on its own row (unlike the family root's,
    // which maybeReconcileFamily computes once every member has settled).
    expect(grandchildren.every((g) => g.stage === "review")).toBe(true);
    expect(grandchildren.every((g) => g.exit_state === "needs_merge_approval")).toBe(true);
    expect(grandchildren.every((g) => g.reconcile_status === "pending_human_merge")).toBe(true);
    // Now that every family member has settled, exactly one merge happened,
    // recorded only on the root's row — the grandchildren's own
    // "pending_human_merge" above doesn't block this: nothing in this stubbed
    // run actually wrote source (see wrote_source), so maybeReconcileFamily
    // still finds the family clean to auto-merge.
    expect(t.reconcile_status).toBe("merged");
    expect(children.every((c) => c.reconcile_status === null)).toBe(true);
    expect(fs.existsSync(path.join(repo, t.artifact_path!))).toBe(true);
    const currentBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo })
      .toString()
      .trim();
    expect(currentBranch).toBe(t.git_base_branch);
  });

  it("escalates to REVIEW when decomposition reports zero subtasks with no stated reason", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(
      path.join(repo, "PLANNING", "INTAKE", "crash.log"),
      "Traceback (most recent call last):\nValueError: boom",
    );
    setRoleRunner(decompositionRunner());

    await tick();
    const t0 = rootTask(projectId);
    if (t0) updateTask(t0.task_id, { level: "epic" });

    await drainTicks(projectId, (t) => t.stage === "ready" || t.stage === "review");

    const t = rootTask(projectId)!;
    expect(t.stage).toBe("review");
    expect(t.exit_state).toBe("needs_review");
    expect(t.review_reason).toContain("zero subtasks");
    expect(listTasks({ parentTaskId: t.task_id }).length).toBe(0);
  });

  it("retries decomposition when subtasks and no_decomposition_reason are both empty, then succeeds", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(
      path.join(repo, "PLANNING", "INTAKE", "crash.log"),
      "Traceback (most recent call last):\nValueError: boom",
    );
    const subtasks = [makeSubtask({ local_id: "1", name: "Only task" })];
    setRoleRunner(decompositionRetryRunner(1, subtasks));

    await tick();
    const t0 = rootTask(projectId);
    if (t0) updateTask(t0.task_id, { level: "epic" });

    await drainTicks(projectId, (t) => t.stage === "ready" || t.stage === "review");

    const t = rootTask(projectId)!;
    expect(t.stage).toBe("ready");
    expect(listTasks({ parentTaskId: t.task_id }).length).toBe(1);
    // The failed first attempt never persisted a role_run — only the
    // eventual successful one did.
    const decompRuns = listRoleRuns(t.task_id).filter((r) => r.role_key === "decomposition");
    expect(decompRuns.length).toBe(1);
    expect(decompRuns[0]!.output_md).toContain("### Task Tree");
    expect(decompRuns[0]!.output_md).toContain("[task] Only task");
  });

  it("escalates to REVIEW after exhausting empty-subtasks retries", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(
      path.join(repo, "PLANNING", "INTAKE", "crash.log"),
      "Traceback (most recent call last):\nValueError: boom",
    );
    // Never succeeds — always reports empty subtasks/no reason.
    setRoleRunner(decompositionRetryRunner(Infinity, []));

    await tick();
    const t0 = rootTask(projectId);
    if (t0) updateTask(t0.task_id, { level: "epic" });

    await drainTicks(projectId, (t) => t.stage === "ready" || t.stage === "review");

    const t = rootTask(projectId)!;
    expect(t.stage).toBe("review");
    expect(t.review_reason).toContain("zero subtasks");
    // Two retries (empty, un-persisted) plus the final attempt that gets
    // recorded and escalated.
    const decompRuns = listRoleRuns(t.task_id).filter((r) => r.role_key === "decomposition");
    expect(decompRuns.length).toBe(1);
  });

  it("still escalates to REVIEW on zero subtasks after a reset-to-intake round trip (exit_kind backfill)", async () => {
    // Regression test: resetTask() nulls exit_kind, and the zero-subtasks
    // escalation gate used to compare it with a strict `=== "spec"` check
    // (unlike isTerminalRole's `|| "spec"` fallback), so a task that had ever
    // been reset would silently lose this safety net on its next pass through
    // the pipeline and reach "ready" with nothing to show for it.
    const { repo, projectId } = setupProject();
    writeArtifact(
      path.join(repo, "PLANNING", "INTAKE", "crash.log"),
      "Traceback (most recent call last):\nValueError: boom",
    );
    setRoleRunner(decompositionRunner());

    await tick();
    const t0 = rootTask(projectId);
    if (t0) updateTask(t0.task_id, { level: "epic" });
    await drainTicks(projectId, (t) => t.stage === "ready" || t.stage === "review");

    const afterFirstRun = rootTask(projectId)!;
    expect(afterFirstRun.stage).toBe("review");

    // Simulate the "⟳ Reset to intake" button: wipes history and nulls exit_kind.
    resetTask(afterFirstRun.task_id);
    expect(getTask(afterFirstRun.task_id)!.exit_kind).toBeNull();
    updateTask(afterFirstRun.task_id, { paused: 0 });

    await drainTicks(projectId, (t) => t.stage === "ready" || t.stage === "review");

    const t = rootTask(projectId)!;
    expect(t.stage).toBe("review");
    expect(t.exit_state).toBe("needs_review");
    expect(t.review_reason).toContain("zero subtasks");
    expect(listTasks({ parentTaskId: t.task_id }).length).toBe(0);
  });

  it("spins up a single execution-ready child (no escalation) when decomposition states an intentional no_decomposition_reason", async () => {
    // Zero subtasks + a stated reason means decomposition judged the *whole
    // task* atomic — the same judgement `execution_ready: true` expresses on
    // an individual subtask node, just applied to the task as a whole. That
    // must not dead-end at spec-ready with nothing but prose recommendations
    // and no code ever written — it should synthesize exactly one
    // execution-ready child carrying the reason forward as its brief.
    const { repo, projectId } = setupProject();
    writeArtifact(
      path.join(repo, "PLANNING", "INTAKE", "crash.log"),
      "Traceback (most recent call last):\nValueError: boom",
    );
    const reason = "Already one atomic, independently-actionable unit.";
    setRoleRunner(decompositionRunner({ noDecompositionReason: reason }));

    await tick();
    const t0 = rootTask(projectId);
    if (t0) updateTask(t0.task_id, { level: "epic" });

    await drainTicks(projectId, (t) => t.stage === "ready" || t.stage === "review");

    const t = rootTask(projectId)!;
    expect(t.stage).toBe("ready");
    expect(t.exit_state).toBe("ready_for_work");
    const children = listTasks({ parentTaskId: t.task_id });
    expect(children.length).toBe(1);
    const child = children[0]!;
    expect(child.exit_kind).toBe("code_change");
    expect(child.content).toContain(reason);
    expect(child.git_worktree_path).toBe(t.git_worktree_path);
    expect(child.git_branch).toBe(t.git_branch);

    // Drive the synthesized child to completion with a plain passing runner —
    // if it were re-entering the normal planning/decomposition flow instead
    // of skipping straight to execution, intake_triage/requirements_analyst/
    // decomposition would show up in its role_runs too.
    setRoleRunner(fakeRunner("pass", { coverage: ALL_CONSIDERED, criteria: [] }));
    for (let i = 0; i < 20; i++) {
      await tick();
      if (getTask(child.task_id)!.stage !== "intake" && getTask(child.task_id)!.stage !== "refining") break;
    }
    const finishedChild = getTask(child.task_id)!;
    expect(finishedChild.stage).toBe("review");
    expect(finishedChild.exit_state).toBe("needs_merge_approval");
    expect(listRoleRuns(child.task_id).map((r) => r.role_key)).toEqual(["developer", "critic"]);
  });

  it("does NOT promote level to 'story' for a synthesized no_decomposition_reason leaf — 'no children, already atomic' is a clean pass, not a decomposition", async () => {
    // Left at the default "task" level (unlike the test above, which forces
    // "epic" beforehand): the synthesized single execution-ready child must
    // still be spawned (decompositionSynthesized bypasses the old
    // level==="epic"||"story" gate), but the parent's own level must stay
    // "task" — promoting it to "story" here would misrepresent a genuinely
    // atomic task as a multi-child story it never became.
    const { repo, projectId } = setupProject();
    writeArtifact(
      path.join(repo, "PLANNING", "INTAKE", "crash.log"),
      "Traceback (most recent call last):\nValueError: boom",
    );
    setRoleRunner(decompositionRunner({ noDecompositionReason: "Already one atomic unit." }));

    await drainTicks(projectId, (t) => t.stage === "ready" || t.stage === "review");

    const t = rootTask(projectId)!;
    expect(t.stage).toBe("ready");
    expect(t.level).toBe("task");
    expect(listTasks({ parentTaskId: t.task_id }).length).toBe(1);
  });

  it("truncates real decomposition output to the family's effort_size budget and records a steer_note intervention", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(
      path.join(repo, "PLANNING", "INTAKE", "crash.log"),
      "Traceback (most recent call last):\nValueError: boom",
    );
    // "S" => maxCount 4; the root itself counts as 1 family member, leaving
    // room for exactly 3 of the 6 proposed children.
    const proposed = Array.from({ length: 6 }, (_, i) =>
      makeSubtask({ local_id: String(i + 1), level: "task", name: `Subtask ${i + 1}` }),
    );
    setRoleRunner(decompositionRunner({ decompSubtasks: proposed }));

    await tick();
    const t0 = rootTask(projectId);
    if (t0) updateTask(t0.task_id, { level: "epic", effort_size: "S" });

    await drainTicks(projectId, (t) => t.stage === "ready" || t.stage === "review");

    const t = rootTask(projectId)!;
    expect(t.stage).toBe("ready");
    const children = listTasks({ parentTaskId: t.task_id });
    expect(children.length).toBe(3);
    const notes = listInterventions(t.task_id)
      .filter((i) => i.kind === "steer_note")
      .map((i) => JSON.parse(i.payload_json ?? "{}").text as string);
    expect(notes.some((text) => text.includes("[orchestrator·budget]"))).toBe(true);
  });

  it("gives decomposition children family-wide sibling awareness, and skips re-running intake_triage/explorer on them", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(
      path.join(repo, "PLANNING", "INTAKE", "crash.log"),
      "Traceback (most recent call last):\nValueError: boom",
    );

    // Keyed by task name (from the "# Task: ..." header) -> the raw context
    // text seen by that task's OWN decomposition-role call.
    const decompContexts: Record<string, string> = {};
    const runner: RoleRunner = async (params) => {
      const isReviewer = params.context.includes("Acceptance criteria to verify");
      const roleMatches = [...params.context.matchAll(/You are the \*\*([a-zA-Z_]+)\*\* role/g)];
      const role = roleMatches.length ? roleMatches[roleMatches.length - 1]![1]! : "";
      const taskName = params.context.match(/# Task: (.+)/)?.[1] ?? "?";
      const criteria: CriteriaResult[] = isReviewer
        ? [...params.context.matchAll(/`([a-z_]+\.[a-z_]+)`/gi)].map((m) => ({ id: m[1]!, status: "met" as const }))
        : [];

      let subtasks: Subtask[] | undefined;
      let noDecompositionReason: string | undefined;
      if (role === "decomposition") {
        decompContexts[taskName] = params.context;
        if (taskName === "First Task" || taskName === "Second Task") {
          // Each child judges itself already atomic — terminates in one hop
          // (a synthesized execution-ready grandchild) instead of splitting further.
          noDecompositionReason = "Already one atomic, independently-actionable unit.";
        } else {
          // The root: split into two sibling "task"-level (non-execution-ready)
          // children so each goes through its own full spec pipeline.
          subtasks = [
            makeSubtask({ local_id: "1", level: "task", name: "First Task", brief: "Do the first thing." }),
            makeSubtask({ local_id: "2", level: "task", name: "Second Task", brief: "Do the second thing." }),
          ];
        }
      }
      return {
        findings: {
          verdict: "pass",
          summary: role === "decomposition" ? "decomposition done" : "pass from fake",
          open_questions: [],
          coverage: ALL_CONSIDERED,
          section_md: role === "decomposition" ? "## Decomposition\n(see structured subtasks)" : "## role\ndone",
          criteria_results: criteria,
          subtasks,
          no_decomposition_reason: noDecompositionReason,
        },
        toolCalls: [],
        transcriptJsonl: "",
        tokens: 1,
        model: "fake",
        fallback: false,
        stalled: false,
        thinkingText: "",
        filesWritten: [],
      };
    };
    setRoleRunner(runner);

    await tick();
    const t0 = rootTask(projectId);
    if (t0) updateTask(t0.task_id, { level: "epic" });

    await drainTicks(projectId, (t) => t.stage === "ready" || t.stage === "review");

    const t = rootTask(projectId)!;
    expect(t.stage).toBe("ready");
    const children = listTasks({ parentTaskId: t.task_id });
    expect(children.map((c) => c.name).sort()).toEqual(["First Task", "Second Task"]);

    // Drive both children forward until each has reached its own
    // decomposition step (no need to run them to full completion).
    for (let i = 0; i < 150; i++) {
      await tick();
      const bothDecomposed = children.every((c) =>
        listRoleRuns(c.task_id).some((r) => r.role_key === "decomposition"),
      );
      if (bothDecomposed) break;
    }

    // §6: a decomposition child already inherited its content from the
    // parent's decomposition output — intake_triage/explorer never re-run.
    for (const c of children) {
      const roleKeys = listRoleRuns(c.task_id).map((r) => r.role_key);
      expect(roleKeys).not.toContain("intake_triage");
      expect(roleKeys).not.toContain("explorer");
    }

    // §5: both children exist (created together) before either reaches its
    // own decomposition step, so each one's decomposition context should
    // list the OTHER as an existing family member.
    expect(decompContexts["First Task"]).toContain("Already exists in this family");
    expect(decompContexts["First Task"]).toContain("Second Task");
    expect(decompContexts["Second Task"]).toContain("Already exists in this family");
    expect(decompContexts["Second Task"]).toContain("First Task");
  });

  it("XS fast path: routes straight to developer/critic once explorer reports effort_size XS, skipping architecture_review/test_strategy/bug_review/decomposition entirely", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(
      path.join(repo, "PLANNING", "INTAKE", "crash.log"),
      "Traceback (most recent call last):\nValueError: boom",
    );
    const runner: RoleRunner = async (params) => {
      const isReviewer = params.context.includes("Acceptance criteria to verify");
      const isExplorer = params.context.includes("You are the **explorer** role");
      const criteria: CriteriaResult[] = isReviewer
        ? [...params.context.matchAll(/`([a-z_]+\.[a-z_]+)`/gi)].map((m) => ({ id: m[1]!, status: "met" as const }))
        : [];
      return {
        findings: {
          verdict: "pass",
          summary: "pass from fake",
          open_questions: [],
          coverage: ALL_CONSIDERED,
          section_md: "## role\ndone",
          criteria_results: criteria,
          effort_size: isExplorer ? "XS" : undefined,
        },
        toolCalls: [],
        transcriptJsonl: "",
        tokens: 1,
        model: "fake",
        fallback: false,
        stalled: false,
        thinkingText: "",
        filesWritten: [],
      };
    };
    setRoleRunner(runner);

    await drainTicks(projectId, (t) => t.stage === "review" || t.stage === "ready", 40);

    const t = rootTask(projectId)!;
    expect(t.effort_size).toBe("XS");
    expect(t.exit_kind).toBe("code_change");
    expect(t.stage).toBe("review");
    expect(t.exit_state).toBe("needs_merge_approval");
    // error_file's normal flow is intake_triage/explorer/bug_investigator/
    // architecture_review/test_strategy/bug_review/decomposition — the fast
    // path must skip straight from explorer to developer/critic, never
    // touching any of the roles in between.
    expect(listRoleRuns(t.task_id).map((r) => r.role_key)).toEqual([
      "intake_triage",
      "explorer",
      "developer",
      "critic",
    ]);
  });

  it("does NOT take the XS fast path when planning_rigor is 'thorough', even with effort_size XS", async () => {
    // Project-level default set up front (rather than a task-level override
    // applied mid-run) so it's already in effect the first time explorer
    // runs — a task-level override can't be set before the task exists.
    const repo = tempGitRepo();
    freshDb();
    seedGlobalRoles();
    const project = createProject({
      name: "p",
      repo_path: repo,
      config_json: JSON.stringify({ planningRigor: "thorough" }),
    });
    scaffoldPlanning(repo, "PLANNING");
    const projectId = project.id;
    writeArtifact(
      path.join(repo, "PLANNING", "INTAKE", "crash.log"),
      "Traceback (most recent call last):\nValueError: boom",
    );

    setRoleRunner(async (params) => {
      const isReviewer = params.context.includes("Acceptance criteria to verify");
      const isExplorer = params.context.includes("You are the **explorer** role");
      const isDecomp = params.context.includes("**decomposition** role");
      const criteria: CriteriaResult[] = isReviewer
        ? [...params.context.matchAll(/`([a-z_]+\.[a-z_]+)`/gi)].map((m) => ({ id: m[1]!, status: "met" as const }))
        : [];
      return {
        findings: {
          verdict: "pass",
          summary: "pass from fake",
          open_questions: [],
          coverage: ALL_CONSIDERED,
          section_md: "## role\ndone",
          criteria_results: criteria,
          effort_size: isExplorer ? "XS" : undefined,
          no_decomposition_reason: isDecomp ? "Already atomic." : undefined,
        },
        toolCalls: [],
        transcriptJsonl: "",
        tokens: 1,
        model: "fake",
        fallback: false,
        stalled: false,
        thinkingText: "",
        filesWritten: [],
      };
    });

    await drainTicks(projectId, (t) => t.stage === "ready" || t.stage === "review", 40);

    const t = rootTask(projectId)!;
    expect(t.effort_size).toBe("XS");
    // Rigor "thorough" opts out of the fast path — normal spec pipeline
    // still runs all the way to decomposition's own no-op termination.
    expect(t.exit_kind).toBe("spec");
    expect(listRoleRuns(t.task_id).map((r) => r.role_key)).toContain("decomposition");
  });

  it("seeds decomposition children with brief/acceptance-criteria/carried-forward context and resolved dependencies, and the scheduler holds a dependent child until its dependency is ready", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(
      path.join(repo, "PLANNING", "INTAKE", "crash.log"),
      "Traceback (most recent call last):\nValueError: boom",
    );
    setRoleRunner(
      decompositionRunner({
        decompSubtasks: [
          makeSubtask({
            local_id: "1",
            name: "First task",
            brief: "Do the first thing.",
            acceptance_criteria: ["the first thing is done"],
            context_to_carry_forward: "The parent already ruled out approach B.",
          }),
          makeSubtask({ local_id: "2", name: "Second task", depends_on: ["1"] }),
        ],
      }),
    );

    await tick();
    const t0 = rootTask(projectId);
    if (t0) updateTask(t0.task_id, { level: "epic" });

    await drainTicks(projectId, (t) => t.stage === "ready" || t.stage === "review");

    const t = rootTask(projectId)!;
    expect(t.stage).toBe("ready");
    const children = listTasks({ parentTaskId: t.task_id });
    expect(children.length).toBe(2);
    const first = children.find((c) => c.name === "First task")!;
    const second = children.find((c) => c.name === "Second task")!;

    // Real seed context, not just the bare name.
    expect(first.content).toContain("Do the first thing.");
    expect(first.content).toContain("Acceptance criteria");
    expect(first.content).toContain("the first thing is done");
    expect(first.content).toContain("The parent already ruled out approach B.");
    expect(first.content).toContain("Decomposed from");
    expect(first.acceptance_criteria).toBe(JSON.stringify(["the first thing is done"]));

    // depends_on's local_id resolved to the real sibling task_id.
    expect(JSON.parse(second.depends_on_json!)).toEqual([first.task_id]);
    expect(second.stage).toBe("intake");
    expect(listRoleRuns(second.task_id).length).toBe(0);

    // Switch to a runner that would happily advance ANY picked task — if the
    // dependency gate weren't in place, "Second task" would very plausibly be
    // picked next (it sorts before "First task" on a created_at tie-break).
    // It must stay untouched until its dependency reaches stage "ready".
    setRoleRunner(fakeRunner("pass", { coverage: ALL_CONSIDERED, criteria: [] }));
    for (let i = 0; i < 3; i++) await tick();
    const secondStillBlocked = getTask(second.task_id)!;
    expect(secondStillBlocked.stage).toBe("intake");
    expect(listRoleRuns(second.task_id).length).toBe(0);

    // Once the dependency is (forcibly) marked ready, Second becomes schedulable.
    updateTask(first.task_id, { stage: "ready" });
    await tick();
    const secondUnblocked = getTask(second.task_id)!;
    expect(secondUnblocked.stage).not.toBe("intake");
  });

  it("silently drops a depends_on reference to a nonexistent local_id instead of blocking the child", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(
      path.join(repo, "PLANNING", "INTAKE", "crash.log"),
      "Traceback (most recent call last):\nValueError: boom",
    );
    setRoleRunner(
      decompositionRunner({
        decompSubtasks: [makeSubtask({ local_id: "1", name: "Only task", depends_on: ["nonexistent"] })],
      }),
    );

    await tick();
    const t0 = rootTask(projectId);
    if (t0) updateTask(t0.task_id, { level: "epic" });

    await drainTicks(projectId, (t) => t.stage === "ready" || t.stage === "review");

    const t = rootTask(projectId)!;
    expect(t.stage).toBe("ready");
    const children = listTasks({ parentTaskId: t.task_id });
    expect(children.length).toBe(1);
    expect(children[0]!.depends_on_json).toBeNull();
    expect(dependenciesSatisfied(children[0]!)).toBe(true);
  });

  it("routes a decomposition child flagged execution_ready straight to the developer/critic execution flow instead of re-planning", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(
      path.join(repo, "PLANNING", "INTAKE", "crash.log"),
      "Traceback (most recent call last):\nValueError: boom",
    );
    setRoleRunner(
      decompositionRunner({
        decompSubtasks: [
          makeSubtask({ local_id: "1", name: "Atomic fix", execution_ready: true }),
          makeSubtask({ local_id: "2", name: "Needs more scoping" }),
        ],
      }),
    );

    await tick();
    const t0 = rootTask(projectId);
    if (t0) updateTask(t0.task_id, { level: "epic" });
    await drainTicks(projectId, (t) => t.stage === "ready" || t.stage === "review");

    const t = rootTask(projectId)!;
    const children = listTasks({ parentTaskId: t.task_id });
    const execChild = children.find((c) => c.name === "Atomic fix")!;
    const planChild = children.find((c) => c.name === "Needs more scoping")!;

    // Only the flagged node gets the execution exit kind; its sibling inherits
    // the parent's exit_kind (spec) exactly as before this feature existed.
    expect(execChild.exit_kind).toBe("code_change");
    expect(planChild.exit_kind).toBe(t.exit_kind);

    // Drive the execution-flow child to completion with a runner that just
    // passes every step — if it were re-entering the normal planning flow,
    // roles like intake_triage/requirements_analyst/decomposition would show
    // up in its role_runs too.
    setRoleRunner(fakeRunner("pass", { coverage: ALL_CONSIDERED, criteria: [] }));
    for (let i = 0; i < 20; i++) {
      await tick();
      if (getTask(execChild.task_id)!.stage !== "intake" && getTask(execChild.task_id)!.stage !== "refining") break;
    }

    const finished = getTask(execChild.task_id)!;
    expect(finished.stage).toBe("review");
    expect(finished.exit_state).toBe("needs_merge_approval");
    expect(finished.reconcile_status).toBe("pending_human_merge");
    expect(listRoleRuns(execChild.task_id).map((r) => r.role_key)).toEqual(["developer", "critic"]);
  });

  describe("autonomy level (plan / edit / auto)", () => {
    function setProjectAutonomyLevel(projectId: number, level: "plan" | "edit" | "auto"): void {
      updateProject(projectId, { config_json: JSON.stringify({ autonomyLevel: level }) });
    }

    /** Writes a real file to the role's own worktree on its first call only
     *  (a code-change leaf's plan is always exactly [developer, critic], so
     *  the first call is always the developer step) and reports it via
     *  filesWritten, so the orchestrator commits a real change worth merging. */
    function developerWritesFileRunner(fileName: string, content: string): RoleRunner {
      let calls = 0;
      return async (params) => {
        calls += 1;
        const isDeveloper = calls === 1;
        if (isDeveloper) fs.writeFileSync(path.join(params.repoPath, fileName), content);
        return {
          findings: {
            verdict: "pass",
            summary: "pass from fake",
            open_questions: [],
            coverage: ALL_CONSIDERED,
            section_md: "## role\ndone",
            criteria_results: [],
          },
          toolCalls: [],
          transcriptJsonl: "",
          tokens: 1,
          model: "fake",
          fallback: false,
          stalled: false,
          thinkingText: "",
          filesWritten: isDeveloper ? [fileName] : [],
        };
      };
    }

    it('"plan" never promotes a real decomposition subtask to code_change, even when flagged execution_ready', async () => {
      const { repo, projectId } = setupProject();
      setProjectAutonomyLevel(projectId, "plan");
      writeArtifact(
        path.join(repo, "PLANNING", "INTAKE", "crash.log"),
        "Traceback (most recent call last):\nValueError: boom",
      );
      setRoleRunner(
        decompositionRunner({
          decompSubtasks: [makeSubtask({ local_id: "1", name: "Atomic fix", execution_ready: true })],
        }),
      );

      await tick();
      const t0 = rootTask(projectId);
      if (t0) updateTask(t0.task_id, { level: "epic" });
      await drainTicks(projectId, (t) => t.stage === "ready" || t.stage === "review");

      const root = rootTask(projectId)!;
      const child = listTasks({ parentTaskId: root.task_id })[0]!;
      expect(child.exit_kind).not.toBe("code_change");
      expect(child.exit_kind).toBe("spec");
    });

    it('"plan" also blocks the whole-task atomic-synthesis path (zero subtasks + reason)', async () => {
      const { repo, projectId } = setupProject();
      setProjectAutonomyLevel(projectId, "plan");
      writeArtifact(
        path.join(repo, "PLANNING", "INTAKE", "crash.log"),
        "Traceback (most recent call last):\nValueError: boom",
      );
      setRoleRunner(decompositionRunner({ noDecompositionReason: "Atomic fix, no further decomposition needed." }));

      await tick();
      const t0 = rootTask(projectId);
      if (t0) updateTask(t0.task_id, { level: "epic" });
      await drainTicks(projectId, (t) => t.stage === "ready" || t.stage === "review");

      const root = rootTask(projectId)!;
      expect(root.stage).toBe("ready");
      const children = listTasks({ parentTaskId: root.task_id });
      expect(children.length).toBe(1);
      expect(children[0]!.exit_kind).not.toBe("code_change");
    });

    it('"auto" auto-merges a clean code_change leaf instead of parking at needs_merge_approval', async () => {
      const { repo, projectId } = setupProject();
      // Set BEFORE decomposition runs — a child snapshots its parent's
      // resolved effective level onto its own autonomy_level column at
      // creation time (Gate 1), not a live re-read of the project default.
      setProjectAutonomyLevel(projectId, "auto");
      writeArtifact(
        path.join(repo, "PLANNING", "INTAKE", "crash.log"),
        "Traceback (most recent call last):\nValueError: boom",
      );
      setRoleRunner(
        decompositionRunner({
          decompSubtasks: [makeSubtask({ local_id: "1", name: "Atomic fix", execution_ready: true })],
        }),
      );
      await tick();
      const t0 = rootTask(projectId);
      if (t0) updateTask(t0.task_id, { level: "epic" });
      await drainTicks(projectId, (t) => t.stage === "ready" || t.stage === "review");

      const execChild = listTasks({ parentTaskId: rootTask(projectId)!.task_id })[0]!;
      expect(execChild.exit_kind).toBe("code_change");
      expect(execChild.autonomy_level).toBe("auto");

      setRoleRunner(developerWritesFileRunner("feature.txt", "hello\n"));
      for (let i = 0; i < 20; i++) {
        await tick();
        const c = getTask(execChild.task_id)!;
        if (c.stage !== "intake" && c.stage !== "refining") break;
      }

      const finished = getTask(execChild.task_id)!;
      expect(finished.stage).toBe("ready");
      expect(finished.exit_state).toBe("ready_for_work");
      expect(finished.status).toBe("complete");
      expect(["merged", "up_to_date"]).toContain(finished.reconcile_status);
    });

    it('"auto" falls back to needs_merge_approval on a genuine merge conflict instead of swallowing it', async () => {
      const { repo, projectId } = setupProject();
      setProjectAutonomyLevel(projectId, "auto"); // before decomposition — see Gate 1 snapshot note above
      writeArtifact(
        path.join(repo, "PLANNING", "INTAKE", "crash.log"),
        "Traceback (most recent call last):\nValueError: boom",
      );
      setRoleRunner(
        decompositionRunner({
          decompSubtasks: [makeSubtask({ local_id: "1", name: "Atomic fix", execution_ready: true })],
        }),
      );
      await tick();
      const t0 = rootTask(projectId);
      if (t0) updateTask(t0.task_id, { level: "epic" });
      await drainTicks(projectId, (t) => t.stage === "ready" || t.stage === "review");

      const root = rootTask(projectId)!;
      const execChild = listTasks({ parentTaskId: root.task_id })[0]!;

      // Seed a conflicting commit on base, touching the same file the
      // developer step is about to write, before the auto-merge is attempted.
      checkoutBranch(repo, root.git_base_branch!);
      writeArtifact(path.join(repo, "feature.txt"), "base version\n");
      commitArtifacts(repo, ["feature.txt"], "base: conflicting change");

      setRoleRunner(developerWritesFileRunner("feature.txt", "task version\n"));
      for (let i = 0; i < 20; i++) {
        await tick();
        const c = getTask(execChild.task_id)!;
        if (c.stage !== "intake" && c.stage !== "refining") break;
      }

      const finished = getTask(execChild.task_id)!;
      expect(finished.stage).toBe("review");
      expect(finished.exit_state).toBe("needs_merge_approval");
      expect(finished.reconcile_status).toBe("conflict");
    });

    it('"auto" also auto-merges via the generic family wrote_source path (non-code_change), falling back to a recorded conflict on divergence', async () => {
      const { projectId: projectIdClean } = setupProject();
      setProjectAutonomyLevel(projectIdClean, "auto");
      materializeIntakeTask(getProject(projectIdClean)!, {
        name: "Should we cache this lookup?",
        content: "Investigate caching options.",
        intakeKind: "question",
      });
      setRoleRunner(
        (() => {
          let calls = 0;
          return async (params) => {
            calls += 1;
            const isFirst = calls === 1;
            if (isFirst) fs.writeFileSync(path.join(params.repoPath, "note.txt"), "hello\n");
            return {
              findings: {
                verdict: "pass" as const,
                summary: "pass from fake",
                open_questions: [],
                coverage: ALL_CONSIDERED,
                section_md: "## role\ndone",
                criteria_results: [],
              },
              toolCalls: [],
              transcriptJsonl: "",
              tokens: 1,
              model: "fake",
              fallback: false,
              stalled: false,
              thinkingText: "",
              filesWritten: isFirst ? ["note.txt"] : [],
            };
          };
        })(),
      );
      await drainTicks(projectIdClean, (t) => t.stage === "ready" || t.stage === "review", 40);
      const cleanRoot = rootTask(projectIdClean)!;
      expect(cleanRoot.wrote_source).toBe(1);
      expect(["merged", "up_to_date"]).toContain(cleanRoot.reconcile_status);

      // Conflicting variant: seed a diverging commit on base first.
      const { projectId, repo } = setupProject();
      setProjectAutonomyLevel(projectId, "auto");
      const project = getProject(projectId)!;
      const task = materializeIntakeTask(project, {
        name: "Should we cache this lookup?",
        content: "Investigate caching options.",
        intakeKind: "question",
      });
      checkoutBranch(repo, task.git_base_branch!);
      writeArtifact(path.join(repo, "note.txt"), "base version\n");
      commitArtifacts(repo, ["note.txt"], "base: conflicting change");
      setRoleRunner(
        (() => {
          let calls = 0;
          return async (params) => {
            calls += 1;
            const isFirst = calls === 1;
            if (isFirst) fs.writeFileSync(path.join(params.repoPath, "note.txt"), "task version\n");
            return {
              findings: {
                verdict: "pass" as const,
                summary: "pass from fake",
                open_questions: [],
                coverage: ALL_CONSIDERED,
                section_md: "## role\ndone",
                criteria_results: [],
              },
              toolCalls: [],
              transcriptJsonl: "",
              tokens: 1,
              model: "fake",
              fallback: false,
              stalled: false,
              thinkingText: "",
              filesWritten: isFirst ? ["note.txt"] : [],
            };
          };
        })(),
      );
      await drainTicks(projectId, (t) => t.stage === "ready" || t.stage === "review", 40);
      const conflictedRoot = rootTask(projectId)!;
      expect(conflictedRoot.wrote_source).toBe(1);
      expect(conflictedRoot.reconcile_status).toBe("conflict");
    });

    it("a task-level override takes effect over the project default", async () => {
      const { repo, projectId } = setupProject();
      // Project default left at "edit" — the override alone must be what refuses code_change.
      writeArtifact(
        path.join(repo, "PLANNING", "INTAKE", "crash.log"),
        "Traceback (most recent call last):\nValueError: boom",
      );
      setRoleRunner(
        decompositionRunner({
          decompSubtasks: [makeSubtask({ local_id: "1", name: "Atomic fix", execution_ready: true })],
        }),
      );
      await tick();
      const t0 = rootTask(projectId)!;
      updateTask(t0.task_id, { level: "epic", autonomy_level: "plan" });
      await drainTicks(projectId, (t) => t.stage === "ready" || t.stage === "review");

      const root = rootTask(projectId)!;
      const child = listTasks({ parentTaskId: root.task_id })[0]!;
      expect(child.exit_kind).not.toBe("code_change");
    });

    it("a spawned child inherits the parent's resolved effective autonomy level", async () => {
      const { repo, projectId } = setupProject();
      setProjectAutonomyLevel(projectId, "auto");
      writeArtifact(
        path.join(repo, "PLANNING", "INTAKE", "crash.log"),
        "Traceback (most recent call last):\nValueError: boom",
      );
      setRoleRunner(
        decompositionRunner({
          decompSubtasks: [
            makeSubtask({ local_id: "1", name: "Child A" }),
            makeSubtask({ local_id: "2", name: "Child B" }),
          ],
        }),
      );
      await tick();
      const t0 = rootTask(projectId);
      if (t0) updateTask(t0.task_id, { level: "epic" });
      await drainTicks(projectId, (t) => t.stage === "ready" || t.stage === "review");

      const root = rootTask(projectId)!;
      const children = listTasks({ parentTaskId: root.task_id });
      expect(children.length).toBe(2);
      expect(children.every((c) => c.autonomy_level === "auto")).toBe(true);
    });
  });

  describe("recap-driven decomposition", () => {
    it("recap proposes a follow-up subtask for a research_brief-exit task (no pipeline decomposition step at all in this flow), tagging it origin_role_key: 'recap', sharing the family worktree/branch, and the family reconciles once it settles", async () => {
      const { projectId } = setupProject();
      const project = getProject(projectId)!;
      // "question" intake → exit_kind research_brief, terminal role
      // research_synthesis — this flow has no "decomposition" step at all, so
      // any child that appears must come from the new mechanism, not the
      // pre-existing pipeline gate.
      materializeIntakeTask(project, {
        name: "Does the cache need eviction?",
        content: "Investigate whether the cache needs an eviction policy.",
        intakeKind: "question",
      });
      setRoleRunner(
        recapDecompositionRunner([
          makeSubtask({ local_id: "1", name: "Add a regression test for the eviction check", execution_ready: true }),
        ]),
      );

      await drainTicks(projectId, (t) => t.stage === "ready" || t.stage === "review", 40);

      const root = rootTask(projectId)!;
      expect(root.exit_kind).toBe("research_brief");
      expect(root.stage).toBe("ready");
      const children = listTasks({ parentTaskId: root.task_id });
      expect(children.length).toBe(1);
      expect(children[0]!.origin_role_key).toBe("recap");
      expect(children[0]!.exit_kind).toBe("code_change");
      expect(children[0]!.git_worktree_path).toBe(root.git_worktree_path);
      expect(children[0]!.git_branch).toBe(root.git_branch);
      // Family hasn't merged yet — the recap-spawned child is still at intake.
      expect(getTask(root.task_id)!.reconcile_status).not.toBe("merged");

      // Drive the recap-spawned child to completion.
      setRoleRunner(fakeRunner("pass", { coverage: ALL_CONSIDERED, criteria: [] }));
      for (let i = 0; i < 20; i++) {
        await tick();
        const c = getTask(children[0]!.task_id)!;
        if (c.stage !== "intake" && c.stage !== "refining") break;
      }
      const finishedChild = getTask(children[0]!.task_id)!;
      expect(finishedChild.stage).toBe("review");
      expect(finishedChild.exit_state).toBe("needs_merge_approval");

      // One more tick lets the root's own family-reconciliation re-check fire
      // now that every member (root + recap-spawned child) has settled.
      await tick();
      expect(getTask(root.task_id)!.reconcile_status).toBe("merged");
    });

    it("a recap-spawned child's own recap never proposes further children — the recursion bound caps every lineage at one hop", async () => {
      const { projectId } = setupProject();
      const project = getProject(projectId)!;
      materializeIntakeTask(project, {
        name: "Should we cache this lookup?",
        content: "Investigate caching options for this lookup.",
        intakeKind: "question",
      });
      // Always willing to propose a subtask, no matter which task's recap is asking.
      setRoleRunner(
        recapDecompositionRunner([
          makeSubtask({ local_id: "1", name: "Follow-up work", execution_ready: true }),
        ]),
      );

      await drainTicks(projectId, (t) => t.stage === "ready" || t.stage === "review", 40);
      const root = rootTask(projectId)!;
      const children = listTasks({ parentTaskId: root.task_id });
      expect(children.length).toBe(1);
      expect(children[0]!.origin_role_key).toBe("recap");

      // Drive the recap-spawned child through completion with the SAME
      // always-propose runner — if the recursion bound didn't hold, this
      // child would spawn its own grandchild too.
      for (let i = 0; i < 20; i++) {
        await tick();
        const c = getTask(children[0]!.task_id)!;
        if (c.stage !== "intake" && c.stage !== "refining") break;
      }
      expect(listTasks({ parentTaskId: children[0]!.task_id }).length).toBe(0);
    });

    it("swallows a recap-decomposition call failure without escalating or blocking the task from reaching ready", async () => {
      const { projectId } = setupProject();
      const project = getProject(projectId)!;
      materializeIntakeTask(project, {
        name: "Should we cache this lookup?",
        content: "Investigate caching options for this lookup.",
        intakeKind: "question",
      });
      setRoleRunner(recapDecompositionRunner([], { throwOnRecapDecomposition: true }));

      await drainTicks(projectId, (t) => t.stage === "ready" || t.stage === "review", 40);

      const root = rootTask(projectId)!;
      expect(root.stage).toBe("ready");
      expect(root.exit_state).toBe("ready_for_work");
      expect(listTasks({ parentTaskId: root.task_id }).length).toBe(0);
    });

    it("does not propose follow-ups for a code_change-exit task awaiting merge approval", async () => {
      const { repo, projectId } = setupProject();
      writeArtifact(
        path.join(repo, "PLANNING", "INTAKE", "crash.log"),
        "Traceback (most recent call last):\nValueError: boom",
      );
      setRoleRunner(
        decompositionRunner({
          decompSubtasks: [makeSubtask({ local_id: "1", name: "Atomic fix", execution_ready: true })],
        }),
      );
      await tick();
      const t0 = rootTask(projectId);
      if (t0) updateTask(t0.task_id, { level: "epic" });
      await drainTicks(projectId, (t) => t.stage === "ready" || t.stage === "review");

      const execChild = listTasks({ parentTaskId: rootTask(projectId)!.task_id })[0]!;
      // Always willing to propose a subtask — if the code_change branch wired
      // this up (it must not), this would spawn a grandchild.
      setRoleRunner(
        recapDecompositionRunner([
          makeSubtask({ local_id: "1", name: "Add a regression test", execution_ready: true }),
        ]),
      );
      for (let i = 0; i < 20; i++) {
        await tick();
        const c = getTask(execChild.task_id)!;
        if (c.stage !== "intake" && c.stage !== "refining") break;
      }
      const finished = getTask(execChild.task_id)!;
      expect(finished.stage).toBe("review");
      expect(finished.exit_state).toBe("needs_merge_approval");
      expect(listTasks({ parentTaskId: execChild.task_id }).length).toBe(0);
    });
  });

  it("escalates to REVIEW when a role returns needs_human", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(path.join(repo, "PLANNING", "INTAKE", "vague.md"), "make it better somehow");
    setRoleRunner(fakeRunner("needs_human"));

    await drainTicks(projectId, (t) => t.stage === "review");

    const t = rootTask(projectId)!;
    expect(t.stage).toBe("review");
    expect(t.exit_state).toBe("needs_review");
    expect(t.review_reason).toBeTruthy();
    expect(t.artifact_path).toContain("REVIEW");
  });

  it("serializes concurrent ticks — one intake yields exactly one task", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(path.join(repo, "PLANNING", "INTAKE", "one.log"), "boom");
    setRoleRunner(fakeRunner("pass"));

    // Fire two ticks at once; per-task tracking must prevent double-ingest
    // and double-dispatch even though different tasks CAN now run concurrently.
    await Promise.all([tick(), tick()]);

    const roots = listTasks({ projectId }).filter((t) => t.parent_task_id == null);
    expect(roots.length).toBe(1);
  });

  it("dispatches multiple tasks' role-steps concurrently, each in its own worktree", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(path.join(repo, "PLANNING", "INTAKE", "a.log"), "boom a");
    writeArtifact(path.join(repo, "PLANNING", "INTAKE", "b.log"), "boom b");

    let inFlight = 0;
    let maxInFlight = 0;
    setRoleRunner(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return {
        findings: {
          verdict: "pass" as Verdict,
          summary: "pass from fake",
          open_questions: [],
          coverage: ALL_CONSIDERED,
          section_md: "## role\nok\n",
          criteria_results: [],
        },
        toolCalls: [],
        transcriptJsonl: "",
        tokens: 1,
        model: "fake",
        fallback: false,
        stalled: false,
        thinkingText: "",
        filesWritten: [],
      };
    });

    // One round with two free slots: ingest creates both tasks, then both
    // get dispatched together — this is the actual point of worktrees, so
    // it must be a genuine wall-clock overlap, not just two disjoint steps.
    await tickOnce(2);

    expect(maxInFlight).toBe(2);
    const roots = listTasks({ projectId }).filter((t) => t.parent_task_id == null);
    expect(roots.length).toBe(2);
    // Each task got its own worktree directory.
    const worktrees = new Set(roots.map((t) => t.git_worktree_path));
    expect(worktrees.size).toBe(2);
    for (const t of roots) expect(fs.existsSync(t.git_worktree_path!)).toBe(true);
  });

  it("never dispatches two members of the same worktree family in the same round, even with free slots", async () => {
    const { projectId } = setupProject();
    const root = createProjectTask(projectId, { stage: "intake" });
    const child = createTask({
      name: "child",
      project_id: projectId,
      parent_task_id: root.task_id,
      task_type: "child",
      stage: "intake",
    });
    expect(child.root_task_id).toBe(root.task_id);

    let inFlight = 0;
    let maxInFlight = 0;
    setRoleRunner(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return {
        findings: {
          verdict: "pass" as Verdict,
          summary: "pass from fake",
          open_questions: [],
          coverage: ALL_CONSIDERED,
          section_md: "## role\nok\n",
          criteria_results: [],
        },
        toolCalls: [],
        transcriptJsonl: "",
        tokens: 1,
        model: "fake",
        fallback: false,
        stalled: false,
        thinkingText: "",
        filesWritten: [],
      };
    });

    // Two free slots, but root+child share a worktree family — only one of
    // them may be picked this round despite both being schedulable.
    await tickOnce(2);

    expect(maxInFlight).toBe(1);
    const advanced = [getTask(root.task_id)!, getTask(child.task_id)!].filter(
      (t) => t.stage !== "intake",
    );
    expect(advanced.length).toBe(1);

    // Family locking claims the whole family for the round, not just one
    // slot — so with a persistent family lock, later rounds keep dispatching
    // this family one member at a time until every member has advanced.
    // Round budget generous on purpose: `pickNextTasks` breaks ties in
    // `updated_at` (second-precision — db.ts's now()) by insertion order, so
    // the untouched sibling only overtakes the recently-touched one once a
    // real wall-clock second boundary has passed; a tight round count is
    // flaky under system load for reasons unrelated to what this test checks
    // (family-exclusive dispatch), so it errs generous rather than racy.
    for (let i = 0; i < 30; i++) {
      await tickOnce(2);
      expect(maxInFlight).toBe(1);
      if (getTask(root.task_id)!.stage !== "intake" && getTask(child.task_id)!.stage !== "intake") break;
    }
    expect(getTask(root.task_id)!.stage).not.toBe("intake");
    expect(getTask(child.task_id)!.stage).not.toBe("intake");
    // Both ended up sharing the same worktree, confirming the family reuse.
    expect(getTask(child.task_id)!.git_worktree_path).toBe(getTask(root.task_id)!.git_worktree_path);
  });

  it("loops back to the owner role when the counter-reviewer fails, then reaches READY", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(path.join(repo, "PLANNING", "INTAKE", "crash.log"), "Error: boom");
    // The reviewer fails once (bug.locate unmet → owner bug_investigator), then passes.
    setRoleRunner(scriptedRunner({ reviewerFailures: 1, unmetId: "bug.locate" }));

    await drainTicks(projectId, (t) => t.stage === "ready" || t.stage === "review", 60);

    const t = rootTask(projectId)!;
    expect(t.stage).toBe("ready");
    const runs = listRoleRuns(t.task_id);
    // bug_investigator ran twice (initial + one loop-back); bug_review ran twice.
    expect(runs.filter((r) => r.role_key === "bug_investigator").length).toBe(2);
    expect(runs.filter((r) => r.role_key === "bug_review").length).toBe(2);
    // Intermediate roles between owner and reviewer were NOT re-run.
    expect(runs.filter((r) => r.role_key === "architecture_review").length).toBe(1);
  });

  it("escalates to REVIEW once loop-backs are exhausted", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(path.join(repo, "PLANNING", "INTAKE", "crash.log"), "Error: boom");
    // The reviewer never passes; the bug flow allows maxLoopbacks = 2.
    setRoleRunner(scriptedRunner({ reviewerFailures: 99, unmetId: "bug.locate" }));

    await drainTicks(projectId, (t) => t.stage === "review", 60);

    const t = rootTask(projectId)!;
    expect(t.stage).toBe("review");
    expect(t.exit_state).toBe("needs_review");
    expect(t.review_reason).toContain("bug.locate");
    // maxLoopbacks = 2 → reviewer ran 3 times (2 loop-backs + the final escalation).
    const runs = listRoleRuns(t.task_id);
    expect(runs.filter((r) => r.role_key === "bug_review").length).toBe(3);
  });

  it("retries the reviewer when a pass verdict leaves criteria_results empty, then reaches READY", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(path.join(repo, "PLANNING", "INTAKE", "crash.log"), "Error: boom");
    // Reviewer reports "pass" with empty criteria_results once, then populates it.
    setRoleRunner(reviewerEmptyCriteriaRunner(1));

    await drainTicks(projectId, (t) => t.stage === "ready" || t.stage === "review", 60);

    const t = rootTask(projectId)!;
    expect(t.stage).toBe("ready");
    // The empty-criteria attempt was never persisted — only the eventual
    // valid one was.
    const runs = listRoleRuns(t.task_id);
    expect(runs.filter((r) => r.role_key === "bug_review").length).toBe(1);
  });

  it("falls through to the existing unmet-criteria escalation once empty-criteria-results retries are exhausted", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(path.join(repo, "PLANNING", "INTAKE", "crash.log"), "Error: boom");
    // Reviewer always reports "pass" with empty criteria_results.
    setRoleRunner(reviewerEmptyCriteriaRunner(Infinity));

    await drainTicks(projectId, (t) => t.stage === "review", 60);

    const t = rootTask(projectId)!;
    expect(t.stage).toBe("review");
    expect(t.exit_state).toBe("needs_review");
    expect(t.review_reason).toContain("bug.locate");
    // Two retries went unpersisted; the retry budget is shared with
    // maxLoopbacks (2), so the third (persisted, still empty) attempt lands
    // with attempts already at the loop-back cap and escalates immediately.
    const runs = listRoleRuns(t.task_id);
    expect(runs.filter((r) => r.role_key === "bug_review").length).toBe(1);
  });

  it("re-routes when a mandatory concern is never covered", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(path.join(repo, "PLANNING", "INTAKE", "crash.log"), "Error: boom");
    // Producers/reviewer 'pass' with all criteria met, but coverage omits the
    // mandatory 'tests' concern → the gate must still refuse to advance.
    const partialCoverage: CoverageItem[] = [{ concern: "correctness", status: "considered" }];
    setRoleRunner(fakeRunner("pass", { coverage: partialCoverage, criteria: allMet("error_file") }));

    await drainTicks(projectId, (t) => t.stage === "review", 60);

    const t = rootTask(projectId)!;
    expect(t.stage).toBe("review");
    expect(t.review_reason).toContain("tests");
  });

  it("persists stop_reason / fallback / thinking_md from a degraded run", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(path.join(repo, "PLANNING", "INTAKE", "crash.log"), "Error: boom");
    // A truncated run: no verdict recorded (fallback), hit the token limit, has reasoning.
    setRoleRunner(async () => ({
      findings: {
        verdict: "needs_more",
        summary: "truncated",
        open_questions: [],
        coverage: ALL_CONSIDERED,
        section_md: "partial answer",
        criteria_results: [],
      },
      toolCalls: [],
      transcriptJsonl: "",
      tokens: 42,
      model: "fake",
      fallback: true,
      stalled: false,
      stopReason: "length",
      thinkingText: "the model was thinking hard",
      filesWritten: [],
    }));

    await drainTicks(projectId, () => listRoleRuns(rootTask(projectId)!.task_id).length > 0, 5);

    const runs = listRoleRuns(rootTask(projectId)!.task_id);
    const first = runs[0]!;
    expect(first.fallback).toBe(1);
    expect(first.stop_reason).toBe("length");
    expect(first.thinking_md).toBe("the model was thinking hard");
  });

  it("persists phase / failed_tool_calls / artifact_bytes and derives degraded health (overhaul/04)", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(path.join(repo, "PLANNING", "INTAKE", "crash.log"), "Error: boom");
    // A twoPhase run that truncated in phase 1, had a failed tool call, streamed
    // nothing to the artifact, and fell back on its verdict.
    setRoleRunner(async () => ({
      findings: {
        verdict: "needs_more",
        summary: "truncated",
        open_questions: [],
        coverage: ALL_CONSIDERED,
        section_md: "partial answer",
        criteria_results: [],
      },
      toolCalls: [{ tool: "read_file", args: undefined, isError: true, error: "denied" }],
      transcriptJsonl: "",
      tokens: 42,
      model: "fake",
      fallback: true,
      stalled: false,
      stopReason: "length",
      phase: 1,
      thinkingText: "reasoning",
      artifactBytesAppended: 0,
      verdictSource: "fallback",
      filesWritten: [],
    }));

    await drainTicks(projectId, () => listRoleRuns(rootTask(projectId)!.task_id).length > 0, 5);

    const first = listRoleRuns(rootTask(projectId)!.task_id)[0]!;
    expect(first.phase).toBe(1);
    expect(first.failed_tool_calls).toBe(1);
    expect(first.artifact_bytes).toBe(0);
    expect(first.verdict_source).toBe("fallback");
    // fallback + non-blank prose ("partial answer") → degraded, not empty.
    const summary = getTaskHealthSummaries([first.task_id]).get(first.task_id)!;
    expect(summary.degraded_runs).toBeGreaterThanOrEqual(1);
    expect(summary.latest_health).toBe("degraded");
  });

  it("counter-reviewer distrust: a degraded reviewer run's criteria are unverified, so the gate loops back (overhaul/04 §4)", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(path.join(repo, "PLANNING", "INTAKE", "crash.log"), "Error: boom");
    // The reviewer reports "pass" with every criterion met, but ITS OWN run is
    // degraded (fallback) — so its criteria_results are not trustworthy evidence.
    // Producers stay healthy; only the reviewer is degraded.
    setRoleRunner(async (params) => {
      const isReviewer = params.context.includes("Acceptance criteria to verify");
      const ids = isReviewer
        ? [...params.context.matchAll(/`([a-z_]+\.[a-z_]+)`/gi)].map((m) => m[1]!)
        : [];
      return {
        findings: {
          verdict: "pass",
          summary: isReviewer ? "reviewer pass" : "producer pass",
          open_questions: [],
          coverage: ALL_CONSIDERED,
          section_md: "## role\ndone",
          criteria_results: ids.map((id) => ({ id, status: "met" as const })),
        },
        toolCalls: [],
        transcriptJsonl: "",
        tokens: 1,
        model: "fake",
        fallback: isReviewer,
        stalled: false,
        verdictSource: isReviewer ? "fallback" : "tool",
        thinkingText: "",
        filesWritten: [],
      };
    });

    await drainTicks(projectId, (t) => t.stage === "review", 60);

    const t = rootTask(projectId)!;
    expect(t.stage).toBe("review");
    // The reviewer re-ran because its evidence was never trusted (loop-backs then
    // escalation) rather than passing on the first degraded self-report.
    const reviewerRuns = listRoleRuns(t.task_id).filter(
      (r) => r.role_key === "bug_review" && (r.run_kind === "primary" || !r.run_kind),
    );
    expect(reviewerRuns.length).toBeGreaterThanOrEqual(2);
    expect(t.review_reason?.toLowerCase()).toContain("unverified");
  });

  it("READY health gate blocks promotion when the terminal run is degraded (overhaul/04 §4)", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(path.join(repo, "PLANNING", "INTAKE", "crash.log"), "Error: boom");
    // Enable the gate (new projects get this by default; existing ones opt in).
    updateProject(projectId, { config_json: JSON.stringify({ requireHealthyTerminal: true }) });
    // Reviewer + producers healthy; the terminal decomposition run is degraded
    // but still emits subtasks — so only the health gate (not the zero-subtask
    // check) can hold it back. Without the gate this reaches ready with children.
    const subtasks = [makeSubtask({ local_id: "1", name: "Only task" })];
    setRoleRunner(async (params) => {
      const isReviewer = params.context.includes("Acceptance criteria to verify");
      const isDecomp = params.context.includes("**decomposition** role");
      const ids = isReviewer
        ? [...params.context.matchAll(/`([a-z_]+\.[a-z_]+)`/gi)].map((m) => m[1]!)
        : [];
      return {
        findings: {
          verdict: "pass",
          summary: isDecomp ? "decomposition done" : "pass",
          open_questions: [],
          coverage: ALL_CONSIDERED,
          section_md: isDecomp ? "## Decomposition\n(structured)" : "## role\ndone",
          criteria_results: ids.map((id) => ({ id, status: "met" as const })),
          subtasks: isDecomp ? subtasks : undefined,
        },
        toolCalls: [],
        transcriptJsonl: "",
        tokens: 1,
        model: "fake",
        fallback: isDecomp,
        stalled: false,
        verdictSource: isDecomp ? "fallback" : "tool",
        thinkingText: "",
        filesWritten: [],
      };
    });

    await tick();
    const t0 = rootTask(projectId);
    if (t0) updateTask(t0.task_id, { level: "epic" });

    await drainTicks(projectId, (t) => t.stage === "ready" || t.stage === "review", 60);

    const t = rootTask(projectId)!;
    expect(t.stage).toBe("review");
    expect(t.review_reason?.toLowerCase()).toContain("degraded");
    // The degraded terminal never promoted → no decomposition children spawned.
    expect(listTasks({ parentTaskId: t.task_id }).length).toBe(0);
  });
});

describe("priority-aware scheduling (PLANNING/overhaul/08 §3)", () => {
  it("a human-origin task is dispatched; a watcher-origin task is left untouched while autonomy is disabled", async () => {
    const { projectId } = setupProject();
    const watcherTask = createProjectTask(projectId, { origin: "watcher:test-suite", priority: 5 });
    const humanTask = createProjectTask(projectId, { origin: "human", priority: 1 });
    setRoleRunner(fakeRunner("pass"));
    await tickOnce(1);
    expect(getTask(humanTask.task_id)!.stage).toBe("refining");
    expect(getTask(watcherTask.task_id)!.stage).toBe("intake"); // never eligible — autonomy off
  });

  it("among two watcher-origin tasks with autonomy enabled, the higher-priority one is dispatched first", async () => {
    const { projectId } = setupProject();
    updateProject(projectId, { config_json: JSON.stringify({ autonomy: { enabled: true } }) });
    const low = createProjectTask(projectId, { origin: "watcher:test-suite", priority: 1 });
    const high = createProjectTask(projectId, { origin: "watcher:test-suite", priority: 5 });
    setRoleRunner(fakeRunner("pass"));
    await tickOnce(1);
    expect(getTask(high.task_id)!.stage).toBe("refining");
    expect(getTask(low.task_id)!.stage).toBe("intake");
  });

  it("a watcher-origin task with a human-authored intervention is promoted to the human class, preempting a plain (higher-priority) watcher task", async () => {
    const { projectId } = setupProject();
    updateProject(projectId, { config_json: JSON.stringify({ autonomy: { enabled: true } }) });
    const touched = createProjectTask(projectId, { origin: "watcher:test-suite", priority: 1 });
    const untouched = createProjectTask(projectId, { origin: "watcher:test-suite", priority: 5 });
    createIntervention({
      task_id: touched.task_id,
      kind: "steer_note",
      payload_json: JSON.stringify({ text: "please look into this" }),
      created_by: "user",
    });
    setRoleRunner(fakeRunner("pass"));
    await tickOnce(1);
    expect(getTask(touched.task_id)!.stage).toBe("refining"); // promoted despite lower priority
    expect(getTask(untouched.task_id)!.stage).toBe("intake");
  });

  it("preserves the existing same-class fairness tie-break (oldest updated_at first)", async () => {
    const { projectId } = setupProject();
    const first = createProjectTask(projectId, { origin: "human", priority: 3 });
    await new Promise((r) => setTimeout(r, 5));
    const second = createProjectTask(projectId, { origin: "human", priority: 3 });
    setRoleRunner(fakeRunner("pass"));
    await tickOnce(1);
    expect(getTask(first.task_id)!.stage).toBe("refining");
    expect(getTask(second.task_id)!.stage).toBe("intake");
  });
});

describe("materializeIntakeTask (PLANNING/overhaul/08 §2)", () => {
  it("defaults to origin human / priority 3 — the same behavior ingestProject's own call site relies on", () => {
    const { projectId } = setupProject();
    const project = getProject(projectId)!;
    const task = materializeIntakeTask(project, { name: "x", content: "hello", intakeKind: "manual" });
    expect(task.origin).toBe("human");
    expect(task.priority).toBe(3);
    expect(fs.existsSync(task.git_worktree_path!)).toBe(true);
  });

  it("threads a watcher origin/priority through to the created task and writes the artifact into its own worktree", () => {
    const { projectId } = setupProject();
    const project = getProject(projectId)!;
    const task = materializeIntakeTask(project, {
      name: "candidate",
      content: "boom failure output",
      intakeKind: "error_file",
      origin: "watcher:test-suite",
      priority: 5,
    });
    expect(task.origin).toBe("watcher:test-suite");
    expect(task.priority).toBe(5);
    expect(task.artifact_path).not.toBeNull();
    const artifactAbs = path.join(task.git_worktree_path!, task.artifact_path!);
    expect(fs.existsSync(artifactAbs)).toBe(true);
    expect(fs.readFileSync(artifactAbs, "utf8")).toContain("boom failure output");
  });
});

describe("watcher-task suppression on wont_do (PLANNING/overhaul/08 §2)", () => {
  it("suppresses the linked candidate when a wont_do intervention closes a watcher-origin task", async () => {
    const { projectId } = setupProject();
    const task = createProjectTask(projectId, { origin: "watcher:test-suite", stage: "refining" });
    const candidate = createCandidate({
      project_id: projectId,
      watcher: "test-suite",
      kind: "error_file",
      fingerprint: "fp1",
      payload_json: "{}",
    });
    updateCandidate(candidate.id, { task_id: task.task_id, status: "queued" });
    createIntervention({ task_id: task.task_id, kind: "wont_do", payload_json: "{}", created_by: "user" });
    setRoleRunner(fakeRunner("pass"));
    await tickOnce(1);
    expect(getCandidate(candidate.id)?.status).toBe("suppressed");
  });

  it("is a no-op (never throws) for a human-origin task with no linked candidate", async () => {
    const { projectId } = setupProject();
    const task = createProjectTask(projectId, { origin: "human", stage: "refining" });
    createIntervention({ task_id: task.task_id, kind: "wont_do", payload_json: "{}", created_by: "user" });
    setRoleRunner(fakeRunner("pass"));
    await expect(tickOnce(1)).resolves.not.toThrow();
    expect(getTask(task.task_id)!.exit_state).toBe("wont_do");
  });
});

describe("opportunistic companion dogfood (PLANNING/overhaul/08 — end-to-end)", () => {
  it("watcher detects → triage queues (badged) → the existing flow/gate machinery carries it to READY unchanged", async () => {
    const { repo, projectId } = setupProject();
    updateProject(projectId, {
      config_json: JSON.stringify({
        harness: { allowExec: true, execAllowlist: [{ name: "test", argv: ["node", "-e", "process.exit(1)"] }] },
        autonomy: {
          enabled: true,
          idleAfterMinutes: 0,
          watchers: [{ name: "test-suite", enabled: true, cadenceMinutes: 0, perWatcherDailyCap: 5, commands: ["test"] }],
        },
        router: { enabled: true, candidateTriage: true },
      }),
    });
    resetHumanActivityClock();
    setTriageFn(async () => ({
      worth_doing: true,
      priority: 4,
      rationale: "a real, reproducible test failure",
      suggested_kind: "error_file",
    }));

    // First scan: the flake-guard requires the same failure fingerprint twice
    // before proposing anything — no candidate, no task yet.
    expect(await tickWatchers()).toBe(true);
    expect(listCandidates({ projectId })).toHaveLength(0);
    expect(rootTask(projectId)).toBeUndefined();

    // Second scan: confirmed — triage approves, a badged task is materialized.
    expect(await tickWatchers()).toBe(true);
    const candidates = listCandidates({ projectId });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.status).toBe("queued");
    const created = rootTask(projectId)!;
    expect(created.origin).toBe("watcher:test-suite");
    expect(created.priority).toBe(4);
    expect(created.intake_kind).toBe("error_file");

    // A later scan of the same still-failing suite must not spawn a duplicate.
    expect(await tickWatchers()).toBe(true);
    expect(listCandidates({ projectId })).toHaveLength(1);

    // From here on, this is an ordinary task: the exact same tick()/drainTicks
    // machinery every human-filed error_file task goes through, with no
    // watcher-aware special-casing anywhere in the flow/gate logic.
    setRoleRunner(fakeRunner("pass", { coverage: ALL_CONSIDERED, criteria: allMet("error_file") }));
    await tick();
    updateTask(created.task_id, { level: "epic" }); // allow decomposition to spawn children
    await drainTicks(projectId, (t) => t.stage === "ready" || t.stage === "review");

    const finished = getTask(created.task_id)!;
    expect(finished.stage).toBe("ready");
    expect(finished.exit_state).toBe("ready_for_work");
    expect(finished.origin).toBe("watcher:test-suite"); // origin survives the whole run
    // Reached the terminal state with zero human interventions of any kind —
    // "never block, batch the rest for the morning report" etiquette, satisfied
    // by simply never needing to escalate in the first place on a clean run.
    expect(listInterventions(created.task_id).filter((iv) => iv.created_by === "user")).toHaveLength(0);
  });

  it("etiquette: outside the configured active-hours window, repeated scans never touch the exec harness", async () => {
    const { projectId } = setupProject();
    // A 5-minute window starting 5 minutes from now — guaranteed to exclude
    // the current instant without any wall-clock-timing flakiness.
    const now = new Date();
    const fmt = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const start = fmt(new Date(now.getTime() + 5 * 60_000));
    const end = fmt(new Date(now.getTime() + 10 * 60_000));
    updateProject(projectId, {
      config_json: JSON.stringify({
        harness: { allowExec: true, execAllowlist: [{ name: "test", argv: ["node", "-e", "process.exit(1)"] }] },
        autonomy: {
          enabled: true,
          idleAfterMinutes: 0,
          activeHours: { start, end, weekendsAllDay: false },
          watchers: [{ name: "test-suite", enabled: true, cadenceMinutes: 0, perWatcherDailyCap: 5, commands: ["test"] }],
        },
      }),
    });
    resetHumanActivityClock();

    for (let i = 0; i < 3; i++) expect(await tickWatchers()).toBe(false);
    expect(listCandidates({ projectId })).toHaveLength(0);
    expect(rootTask(projectId)).toBeUndefined();
  });
});

describe("role-call idle watchdog", () => {
  /** A runner that hangs until its AbortSignal fires, then either succeeds
   *  (after `succeedOnAttempt` prior hangs) or hangs forever. Mirrors the
   *  shape of a real hung LLM call: never emits an event, so the idle timer
   *  in runOneStep is never reset and fires on schedule. */
  function hangingRunner(succeedOnAttempt: number): RoleRunner {
    let calls = 0;
    return (params) => {
      calls += 1;
      if (calls > succeedOnAttempt) {
        return fakeRunner("pass", { coverage: ALL_CONSIDERED, criteria: allMet("error_file") })(params);
      }
      return new Promise((_, reject) => {
        params.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    };
  }

  beforeEach(() => {
    process.env.ORCHESTRA_REQUEST_TIMEOUT_MS = "30";
    resetConfig();
  });
  afterEach(() => {
    delete process.env.ORCHESTRA_REQUEST_TIMEOUT_MS;
    resetConfig();
  });

  it("auto-retries a role call that times out once, then succeeds", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(
      path.join(repo, "PLANNING", "INTAKE", "crash.log"),
      "Traceback (most recent call last):\nValueError: boom",
    );
    setRoleRunner(hangingRunner(1));

    await tick();
    const t0 = rootTask(projectId);
    if (t0) updateTask(t0.task_id, { level: "epic" });

    await drainTicks(projectId, (t) => t.stage === "ready" || t.stage === "review", 60);

    const t = rootTask(projectId)!;
    // Reached a normal terminal stage — the timeout was invisible to the outcome.
    expect(["ready", "review"]).toContain(t.stage);
    // The timed-out attempt for the first step is never persisted as a role_run,
    // matching the JSON-parse-error / empty-subtasks retry contract.
    const firstStepRuns = listRoleRuns(t.task_id).filter((r) => r.role_key === "intake_triage");
    expect(firstStepRuns.length).toBe(1);
  });

  it("resumes (not cold-restarts) the step after a timeout and records the attempt index", async () => {
    // overhaul/03 §2: a dead-air timeout re-enters the step as a RESUME — the
    // retry's context carries the resume steering, and the eventual successful
    // run row records attempt=2.
    const { repo, projectId } = setupProject();
    writeArtifact(
      path.join(repo, "PLANNING", "INTAKE", "crash.log"),
      "Traceback (most recent call last):\nValueError: boom",
    );
    const contexts: string[] = [];
    let calls = 0;
    setRoleRunner((params) => {
      calls += 1;
      if (calls === 1) {
        // First attempt hangs until the idle watchdog aborts it.
        return new Promise<RoleRunResult>((_, reject) => {
          params.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      contexts.push(params.context);
      return fakeRunner("pass", { coverage: ALL_CONSIDERED, criteria: allMet("error_file") })(params);
    });

    await tick();
    const t0 = rootTask(projectId);
    if (t0) updateTask(t0.task_id, { level: "epic" });

    await drainTicks(projectId, (t) => t.stage === "ready" || t.stage === "review", 60);

    // The first successful call is the intake_triage RESUME (attempt 2).
    expect(contexts[0]).toContain("RESUMING");
    expect(contexts[0]).toContain("previous attempt");

    const firstStepRuns = listRoleRuns(rootTask(projectId)!.task_id).filter(
      (r) => r.role_key === "intake_triage",
    );
    expect(firstStepRuns.length).toBe(1);
    expect(firstStepRuns[0]!.attempt).toBe(2);
  });

  it("escalates to REVIEW after exhausting timeout retries, without reading as a user abort", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(
      path.join(repo, "PLANNING", "INTAKE", "crash.log"),
      "Traceback (most recent call last):\nValueError: boom",
    );
    setRoleRunner(hangingRunner(Infinity));

    await tick();
    const t0 = rootTask(projectId);
    if (t0) updateTask(t0.task_id, { level: "epic" });

    await drainTicks(projectId, (t) => t.stage === "review", 60);

    const t = rootTask(projectId)!;
    expect(t.stage).toBe("review");
    expect(t.exit_state).toBe("needs_review");
    expect(t.review_reason).toContain("timed out");
    expect(t.review_reason).not.toContain("aborted by user");
  });

  it("a genuine external abort (e.g. stopScheduler) still reads as aborted by user, not a timeout", async () => {
    // A generous timeout that would never fire within this test — the abort
    // here comes from outside the watchdog, simulating stopScheduler()'s
    // "fire every in-flight AbortController" behavior (abortAllInFlight is the
    // same abort-every-controller mechanic, minus the start/stop flag dance,
    // so this test doesn't need to spin up the real scheduler loop).
    process.env.ORCHESTRA_REQUEST_TIMEOUT_MS = "60000";
    resetConfig();

    const { repo, projectId } = setupProject();
    writeArtifact(
      path.join(repo, "PLANNING", "INTAKE", "crash.log"),
      "Traceback (most recent call last):\nValueError: boom",
    );
    // By the time this runner is invoked, runOneStep has already registered its
    // AbortController in the module-level activeAborts map (synchronously,
    // before awaiting the runner) — so calling abortAllInFlight() here reliably
    // aborts THIS call's own signal, without any race on scheduling internals.
    setRoleRunner((params) => {
      abortAllInFlight();
      return new Promise((_, reject) => {
        // The abort above happens synchronously — check first in case the
        // signal already fired before this listener could attach.
        if (params.signal?.aborted) { reject(new Error("aborted")); return; }
        params.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });

    await tick();
    const t0 = rootTask(projectId);
    if (t0) updateTask(t0.task_id, { level: "epic" });

    await drainTicks(projectId, (t) => t.stage === "review", 10);

    const t = rootTask(projectId)!;
    expect(t.stage).toBe("review");
    expect(t.review_reason).toContain("aborted by user");
    expect(t.review_reason).not.toContain("timed out");
  });
});

describe("counter-review overhaul: adversarial critique + second review", () => {
  it("critiques every non-exempt step when reviewDepth is every_step, linking each critique to its primary run", async () => {
    const { repo, projectId } = setupProject();
    // "security" content triggers the security flow, whose reviewDepth is "every_step".
    writeArtifact(path.join(repo, "PLANNING", "INTAKE", "security-report.md"), "Reflected XSS in the search box");
    setRoleRunner(fakeRunner("pass", { coverage: ALL_CONSIDERED, criteria: allMet("security") }));

    await drainTicks(projectId, (t) => t.stage === "ready" || t.stage === "review", 60);

    const t = rootTask(projectId)!;
    expect(t.intake_kind).toBe("security");
    expect(t.stage).toBe("ready");

    const runs = listRoleRuns(t.task_id);
    const primaryRuns = runs.filter((r) => r.run_kind === "primary");
    const critiqueRuns = runs.filter((r) => r.run_kind === "critique");
    // Every step in the flow (including the reviewer and terminal roles) gets
    // critiqued under "every_step".
    expect(critiqueRuns.length).toBe(ROUTING_TEMPLATES.security.length);
    for (const c of critiqueRuns) {
      expect(c.role_key).toBe("critic");
      expect(c.target_run_id).not.toBeNull();
      expect(primaryRuns.some((r) => r.id === c.target_run_id)).toBe(true);
    }
  });

  it("escalates when the adversarial critique flags a producer step, even though the flow's reviewer step never ran", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(path.join(repo, "PLANNING", "INTAKE", "security-report.md"), "Reflected XSS in the search box");
    // Every primary run passes; the critique on the "explorer" step alone flags a blocker.
    setRoleRunner(async (params) => {
      const isCritique = params.context.includes("Step under review:");
      const verdict: Verdict = isCritique && params.context.includes("Step under review: explorer") ? "blocker" : "pass";
      return {
        findings: {
          verdict,
          summary: isCritique ? "critic flags a domain violation" : "pass from producer",
          open_questions: [],
          coverage: ALL_CONSIDERED,
          section_md: "## role\n- [epic] Epic\n- [task] implement the fix\n",
          criteria_results: allMet("security"),
        },
        toolCalls: [],
        transcriptJsonl: "",
        tokens: 1,
        model: "fake",
        fallback: false,
        stalled: false,
        thinkingText: "",
        filesWritten: [],
      };
    });

    await drainTicks(projectId, (t) => t.stage === "review", 60);

    const t = rootTask(projectId)!;
    expect(t.stage).toBe("review");
    expect(t.exit_state).toBe("needs_review");
    expect(t.review_reason).toContain("explorer");
    const runs = listRoleRuns(t.task_id);
    // The flow's own reviewer step never had to run — the critique on an
    // earlier producer step escalated first.
    expect(runs.some((r) => r.role_key === "security_review_adversary")).toBe(false);
    expect(runs.filter((r) => r.role_key === "critic" && r.verdict === "blocker").length).toBe(1);
  });

  it("lets the orchestrator's second review downgrade a critique false-positive back to accept (no loop-back)", async () => {
    const { repo, projectId } = setupProject();
    updateProject(projectId, { config_json: JSON.stringify({ router: { enabled: true, secondReview: true } }) });
    writeArtifact(path.join(repo, "PLANNING", "INTAKE", "security-report.md"), "Reflected XSS in the search box");
    setRoleRunner(async (params) => {
      const isCritique = params.context.includes("Step under review:");
      const verdict: Verdict = isCritique && params.context.includes("Step under review: explorer") ? "blocker" : "pass";
      return {
        findings: {
          verdict,
          summary: isCritique ? "critic false alarm" : "pass from producer",
          open_questions: [],
          coverage: ALL_CONSIDERED,
          section_md: "## role\n- [epic] Epic\n- [task] implement the fix\n",
          criteria_results: allMet("security"),
        },
        toolCalls: [],
        transcriptJsonl: "",
        tokens: 1,
        model: "fake",
        fallback: false,
        stalled: false,
        thinkingText: "",
        filesWritten: [],
      };
    });
    setSecondReviewFn(async () => ({ decision: "accept", reasoning: "false positive, proceed" }));

    await drainTicks(projectId, (t) => t.stage === "ready" || t.stage === "review", 60);

    const t = rootTask(projectId)!;
    // The second review downgraded the critique's blocker back to the primary
    // verdict — the task is not escalated and "explorer" was not re-run.
    expect(t.stage).toBe("ready");
    const runs = listRoleRuns(t.task_id);
    expect(runs.filter((r) => r.role_key === "explorer" && r.run_kind === "primary").length).toBe(1);
  });

  it("does not treat a non-reviewer step's own routine \"needs_more\" self-verdict as an adversarial flag", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(
      path.join(repo, "PLANNING", "INTAKE", "crash.log"),
      "Traceback (most recent call last):\nValueError: boom",
    );
    // intake_triage reports its own routine "needs_more" self-assessment — an
    // expected, everyday verdict per the output contract, not a flag. error_file's
    // reviewDepth is "terminal_only", so critique never even runs on intake_triage.
    setRoleRunner(async (params) => {
      const isIntakeTriage = params.systemPrompt.includes("You normalize a raw intake");
      const verdict: Verdict = isIntakeTriage ? "needs_more" : "pass";
      return {
        findings: {
          verdict,
          summary: isIntakeTriage ? "scope is a little underspecified, but workable" : "pass from fake",
          open_questions: [],
          coverage: ALL_CONSIDERED,
          section_md: "## role\n- [epic] Epic\n- [task] implement the fix\n",
          criteria_results: allMet("error_file"),
        },
        toolCalls: [],
        transcriptJsonl: "",
        tokens: 1,
        model: "fake",
        fallback: false,
        stalled: false,
        thinkingText: "",
        filesWritten: [],
      };
    });

    await drainTicks(projectId, (t) => t.stage === "ready" || t.stage === "review", 60);

    const t = rootTask(projectId)!;
    expect(t.stage).toBe("ready");
    expect(t.exit_state).toBe("ready_for_work");
    const runs = listRoleRuns(t.task_id);
    expect(runs.find((r) => r.role_key === "intake_triage")?.verdict).toBe("needs_more");
    expect(runs.filter((r) => r.role_key === "intake_triage" && r.run_kind === "primary").length).toBe(1);
    // Only the reviewer step is critiqued under "terminal_only" — intake_triage
    // never went through the critic.
    expect(runs.filter((r) => r.role_key === "critic").length).toBe(1);
  });
});

describe("checkpoint restore", () => {
  it("gives the task its own branch and records a checkpoint commit per role run", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(
      path.join(repo, "PLANNING", "INTAKE", "crash.log"),
      "Traceback (most recent call last):\nValueError: boom",
    );
    setRoleRunner(fakeRunner("pass"));

    await tick(); // ingest + plan + first role step (all in one tick)

    const t = rootTask(projectId)!;
    expect(t.git_branch).toMatch(/^orchestra\//);
    expect(t.git_base_branch).toBeTruthy();
    expect(t.git_worktree_path).toBeTruthy();
    const currentBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: t.git_worktree_path! })
      .toString()
      .trim();
    expect(currentBranch).toBe(t.git_branch);

    const runs = listRoleRuns(t.task_id);
    expect(runs.length).toBe(1);
    expect(runs[0]!.git_commit_sha).toBeTruthy();
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: t.git_worktree_path! }).toString().trim();
    expect(runs[0]!.git_commit_sha).toBe(headSha);
  });

  it("rolls a task back to an earlier checkpoint, discarding later runs and resuming from there", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(
      path.join(repo, "PLANNING", "INTAKE", "crash.log"),
      "Traceback (most recent call last):\nValueError: boom",
    );
    setRoleRunner(fakeRunner("pass"));

    await tick(); // ingest + plan + step 1
    await tick(); // step 2
    await tick(); // step 3

    const before = rootTask(projectId)!;
    const runsBefore = listRoleRuns(before.task_id);
    expect(runsBefore.length).toBe(3);
    const checkpoint = runsBefore[0]!;
    const secondRun = runsBefore[1]!;

    await restoreCheckpoint(before.task_id, checkpoint.id);

    const after = getTask(before.task_id)!;
    expect(after.stage).toBe("refining");
    expect(after.exit_state).toBeNull();

    // Only the restored-to run (and anything before it) survives.
    const runsAfter = listRoleRuns(after.task_id);
    expect(runsAfter.map((r) => r.id)).toEqual([checkpoint.id]);

    // The plan reflects exactly what survived: step 0 done, the rest pending.
    const plan = JSON.parse(after.refinement_plan_json!) as { steps: Array<{ role: string; status: string }> };
    expect(plan.steps[0]!.status).toBe("done");
    expect(plan.steps[0]!.role).toBe(checkpoint.role_key);
    expect(plan.steps.slice(1).every((s) => s.status === "pending")).toBe(true);

    // The branch's HEAD is back at the checkpoint commit.
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: after.git_worktree_path! }).toString().trim();
    expect(headSha).toBe(checkpoint.git_commit_sha);
    const currentBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: after.git_worktree_path!,
    })
      .toString()
      .trim();
    expect(currentBranch).toBe(after.git_branch);

    // The restore is recorded in the steering log for audit.
    expect(listInterventions(after.task_id).some((iv) => iv.kind === "restore_checkpoint")).toBe(true);

    // The scheduler resumes and re-runs the step that followed the checkpoint.
    await tick();
    const runsResumed = listRoleRuns(after.task_id);
    expect(runsResumed.length).toBe(2);
    expect(runsResumed[1]!.role_key).toBe(secondRun.role_key);
    expect(runsResumed[1]!.id).not.toBe(secondRun.id); // a fresh run, not the discarded one
  });

  it("rejects restoring to a run with no checkpoint commit or from another task", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(path.join(repo, "PLANNING", "INTAKE", "crash.log"), "Traceback: boom");
    setRoleRunner(fakeRunner("pass"));
    await tick();
    await tick();
    const t = rootTask(projectId)!;
    const run = listRoleRuns(t.task_id)[0]!;

    await expect(restoreCheckpoint("not-a-real-task", run.id)).rejects.toThrow(
      "checkpoint not found for this task",
    );
  });
});

describe("best-effort guesses + auto-reincorporation", () => {
  /** A runner that records a guessed open question on its first call only,
   *  and passes cleanly (no questions) on every call after. */
  function runnerWithGuess(question: string, assumedAnswer: string, confidence: "low" | "medium" | "high"): RoleRunner {
    let calls = 0;
    return async () => {
      calls += 1;
      return {
        findings: {
          verdict: "pass",
          summary: "pass from fake",
          open_questions:
            calls === 1
              ? [{ question, assumed_answer: assumedAnswer, confidence, resolved: "assumed" as const }]
              : [],
          coverage: [{ concern: "security", status: "considered" }],
          section_md: "## role\n- [epic] Epic\n- [task] implement the fix\n",
          criteria_results: [],
        },
        toolCalls: [],
        transcriptJsonl: "",
        tokens: 3,
        model: "fake",
        fallback: false,
        stalled: false,
        thinkingText: "",
        filesWritten: [],
      };
    };
  }

  const QUESTION = "What logging framework does this project use?";

  it("a guessed open question does not escalate the task — pass/needs_more proceeds normally", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(path.join(repo, "PLANNING", "INTAKE", "crash.log"), "Error: boom");
    setRoleRunner(runnerWithGuess(QUESTION, "probably the existing one", "low"));

    await tick(); // ingest + first role step

    const t = rootTask(projectId)!;
    expect(t.stage).toBe("refining"); // not escalated by the mere presence of a guess
    const run = listRoleRuns(t.task_id)[0]!;
    const questions = JSON.parse(run.open_questions_json!) as Array<{ resolved: string; confidence: string }>;
    expect(questions[0]!.resolved).toBe("assumed");
    expect(questions[0]!.confidence).toBe("low");
  });

  it("marks a guess confirmed and leaves the task untouched when the human's answer matches it", async () => {
    const { repo, projectId } = setupProject();
    updateProject(projectId, {
      config_json: JSON.stringify({ router: { enabled: true, answerReincorporation: true } }),
    });
    writeArtifact(path.join(repo, "PLANNING", "INTAKE", "crash.log"), "Error: boom");
    setRoleRunner(runnerWithGuess(QUESTION, "the existing one", "medium"));
    setAnswerMatchFn(async () => ({ decision: "confirms", reasoning: "matches" }));

    await tick();
    const before = rootTask(projectId)!;
    updateTask(before.task_id, { stage: "review" }); // simulate escalation for an unrelated reason

    await reincorporateAnswer(before.task_id, QUESTION, "yeah, the existing one");

    const after = getTask(before.task_id)!;
    expect(after.stage).toBe("review"); // untouched
    const run = listRoleRuns(before.task_id)[0]!;
    const questions = JSON.parse(run.open_questions_json!) as Array<{ resolved: string }>;
    expect(questions[0]!.resolved).toBe("confirmed");
    expect(listInterventions(before.task_id).some((iv) => iv.kind === "restore_checkpoint")).toBe(false);
  });

  it("rolls the task back to right after the guess when the human's answer contradicts it", async () => {
    const { repo, projectId } = setupProject();
    updateProject(projectId, {
      config_json: JSON.stringify({ router: { enabled: true, answerReincorporation: true } }),
    });
    writeArtifact(path.join(repo, "PLANNING", "INTAKE", "crash.log"), "Error: boom");
    setRoleRunner(runnerWithGuess(QUESTION, "probably console.log", "low"));
    setAnswerMatchFn(async () => ({ decision: "contradicts", reasoning: "mismatch" }));

    await tick();
    const before = rootTask(projectId)!;
    const checkpoint = listRoleRuns(before.task_id)[0]!;
    updateTask(before.task_id, { stage: "review" });

    await reincorporateAnswer(before.task_id, QUESTION, "actually we use pino");

    const after = getTask(before.task_id)!;
    expect(after.stage).toBe("refining"); // rolled back and resumable, like a manual restore

    const runsAfter = listRoleRuns(after.task_id);
    expect(runsAfter.map((r) => r.id)).toEqual([checkpoint.id]); // nothing after it survives
    const questions = JSON.parse(runsAfter[0]!.open_questions_json!) as Array<{ resolved: string }>;
    expect(questions[0]!.resolved).toBe("invalidated");

    const ivs = listInterventions(after.task_id);
    expect(ivs.some((iv) => iv.kind === "restore_checkpoint")).toBe(true);
    const steerNote = ivs.find(
      (iv) => iv.kind === "steer_note" && (JSON.parse(iv.payload_json ?? "{}") as { text?: string }).text?.includes("actually we use pino"),
    );
    expect(steerNote).toBeTruthy();

    // The pipeline actually resumes afterward, not just a state flip.
    await tick();
    expect(listRoleRuns(after.task_id).length).toBe(2);
  });

  it("does nothing while the task is still refining — the answer is left for ordinary context instead", async () => {
    const { repo, projectId } = setupProject();
    updateProject(projectId, {
      config_json: JSON.stringify({ router: { enabled: true, answerReincorporation: true } }),
    });
    writeArtifact(path.join(repo, "PLANNING", "INTAKE", "crash.log"), "Error: boom");
    setRoleRunner(runnerWithGuess(QUESTION, "probably console.log", "low"));
    setAnswerMatchFn(async () => ({ decision: "contradicts", reasoning: "mismatch" }));

    await tick();
    const t = rootTask(projectId)!;
    expect(t.stage).toBe("refining");

    await reincorporateAnswer(t.task_id, QUESTION, "actually we use pino");

    const after = getTask(t.task_id)!;
    expect(after.stage).toBe("refining");
    const run = listRoleRuns(t.task_id)[0]!;
    const questions = JSON.parse(run.open_questions_json!) as Array<{ resolved: string }>;
    expect(questions[0]!.resolved).toBe("assumed"); // never even compared
  });

  it("does nothing when the router's answerReincorporation call point is disabled (the default)", async () => {
    const { repo, projectId } = setupProject();
    // No router config set — resolveRouterConfig defaults every call point to off.
    writeArtifact(path.join(repo, "PLANNING", "INTAKE", "crash.log"), "Error: boom");
    setRoleRunner(runnerWithGuess(QUESTION, "probably console.log", "low"));
    setAnswerMatchFn(async () => ({ decision: "contradicts", reasoning: "mismatch" }));

    await tick();
    const t = rootTask(projectId)!;
    updateTask(t.task_id, { stage: "review" });

    await reincorporateAnswer(t.task_id, QUESTION, "actually we use pino");

    const after = getTask(t.task_id)!;
    expect(after.stage).toBe("review"); // untouched — call point never ran
    const run = listRoleRuns(t.task_id)[0]!;
    const questions = JSON.parse(run.open_questions_json!) as Array<{ resolved: string }>;
    expect(questions[0]!.resolved).toBe("assumed");
  });
});

describe("role feed-forward (buildRoleContext)", () => {
  /** Records every context string it was invoked with; the first call reports a
   *  guessed open question, every later call passes cleanly with no questions. */
  function contextCapturingRunner(contexts: string[], question: string, assumedAnswer: string): RoleRunner {
    let calls = 0;
    return async (params) => {
      calls += 1;
      contexts.push(params.context);
      return {
        findings: {
          verdict: "pass",
          summary: "pass from fake",
          open_questions:
            calls === 1
              ? [{ question, assumed_answer: assumedAnswer, confidence: "low" as const, resolved: "assumed" as const }]
              : [],
          coverage: [{ concern: "security", status: "considered" }],
          section_md: "## role\nfindings\n",
          criteria_results: [],
        },
        toolCalls: [],
        transcriptJsonl: "",
        tokens: 3,
        model: "fake",
        fallback: false,
        stalled: false,
        thinkingText: "",
        filesWritten: [],
      };
    };
  }

  it("carries an earlier role's unresolved guess forward into the next role's context", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(path.join(repo, "PLANNING", "INTAKE", "crash.log"), "Error: boom");
    const contexts: string[] = [];
    setRoleRunner(contextCapturingRunner(contexts, "What logging framework does this project use?", "probably the existing one"));

    await tick(); // intake_triage: records the guess
    await tick(); // explorer: should see it as unresolved context

    expect(contexts.length).toBe(2);
    expect(contexts[1]).toContain("Open questions from earlier roles (unresolved)");
    expect(contexts[1]).toContain("What logging framework does this project use?");
    expect(contexts[1]).toContain("probably the existing one");
    expect(contexts[1]).toContain("intake_triage");
  });

  it("points a tool-equipped role at the on-disk artifact for full prior write-ups", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(path.join(repo, "PLANNING", "INTAKE", "crash.log"), "Error: boom");
    const contexts: string[] = [];
    setRoleRunner(contextCapturingRunner(contexts, "unused question", "unused answer"));

    await tick(); // intake_triage
    await tick(); // explorer — has tools, and now has a prior run to point at

    const t = rootTask(projectId)!;
    expect(contexts[1]).toContain(t.artifact_path);
    expect(contexts[1]).toContain("read it with your `read` tool");
  });
});

describe("context budgeting (PLANNING/overhaul/07)", () => {
  /** A minimal, valid RoleRunResult with a given verdict/findings override. */
  function minimalResult(
    overrides: Partial<RoleRunResult["findings"]> = {},
  ): RoleRunResult {
    return {
      findings: {
        verdict: "pass",
        summary: "short summary",
        open_questions: [],
        coverage: [{ concern: "security", status: "considered" }],
        section_md: "## role\nfindings\n",
        criteria_results: [],
        ...overrides,
      },
      toolCalls: [],
      transcriptJsonl: "",
      tokens: 3,
      model: "fake",
      fallback: false,
      stalled: false,
      thinkingText: "",
      filesWritten: [],
    };
  }

  it("carries an earlier role's carry_forward handoff into the next role's context and persists it on the run row", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(path.join(repo, "PLANNING", "INTAKE", "crash.log"), "Error: boom");
    const contexts: string[] = [];
    let calls = 0;
    setRoleRunner(async (params) => {
      calls += 1;
      contexts.push(params.context);
      return minimalResult(
        calls === 1
          ? { carry_forward: "the auth middleware caches tokens for 5 min — don't assume live checks" }
          : {},
      );
    });

    await tick(); // intake_triage
    await tick(); // explorer

    const t = rootTask(projectId)!;
    const runs = listRoleRuns(t.task_id);
    expect(runs[0]!.carry_forward).toBe(
      "the auth middleware caches tokens for 5 min — don't assume live checks",
    );
    expect(contexts[1]).toContain("Carry forward for later roles:");
    expect(contexts[1]).toContain("the auth middleware caches tokens for 5 min");
  });

  it("caps an oversize carry_forward at 300 chars before persisting it", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(path.join(repo, "PLANNING", "INTAKE", "crash.log"), "Error: boom");
    const huge = "z".repeat(500);
    setRoleRunner(async () => minimalResult({ carry_forward: huge }));

    await tick();

    const t = rootTask(projectId)!;
    expect(listRoleRuns(t.task_id)[0]!.carry_forward?.length).toBe(300);
  });

  // Just under INTAKE_COMPACTION_THRESHOLD_CHARS (8000) so ingest-time
  // compaction (§3) does NOT kick in — these tests are exercising the
  // separate per-run Tier-3 runtime degradation (§1) that buildRoleContext
  // applies on top, so the fixture has to reach buildRoleContext un-condensed.
  const BIG_INTAKE = "y".repeat(7900);

  it("shadow mode (default, no contextBudget flag): records context_degraded but still sends the full, undegraded prompt", async () => {
    const { repo, projectId } = setupProject();
    // A window far too small for this task's content — proves the allocator
    // WOULD have needed to degrade, without actually being enforced.
    upsertConfig({ project_id: projectId, context_window: 2000, max_tokens: 200 });
    writeArtifact(path.join(repo, "PLANNING", "INTAKE", "crash.log"), `Error: boom\n${BIG_INTAKE}`);
    const contexts: string[] = [];
    setRoleRunner(async (params) => {
      contexts.push(params.context);
      return minimalResult();
    });

    await tick(); // ingest + intake_triage

    const t = rootTask(projectId)!;
    const run = listRoleRuns(t.task_id)[0]!;
    expect(run.context_degraded).toBe(1);
    expect(run.context_tokens_est).toBeGreaterThan(0);
    // Shadow mode: the actual prompt sent to the model still has the full,
    // uncondensed intake — nothing was actually cut.
    expect(contexts[0]).toContain(BIG_INTAKE);
  });

  it("enforced mode (project config contextBudget:true): actually sends the degraded, condensed prompt", async () => {
    const { repo, projectId } = setupProject();
    updateProject(projectId, { config_json: JSON.stringify({ contextBudget: true }) });
    // Sized so the always-kept content (task header/instruction + the role's
    // own system prompt reservation) leaves enough room for the condensed
    // intake rendering to fit, but not the full one — degrades to "condensed",
    // not a full drop (see the shadow-mode test above for the drop case).
    upsertConfig({ project_id: projectId, context_window: 4000, max_tokens: 300 });
    writeArtifact(path.join(repo, "PLANNING", "INTAKE", "crash.log"), `Error: boom\n${BIG_INTAKE}`);
    const contexts: string[] = [];
    setRoleRunner(async (params) => {
      contexts.push(params.context);
      return minimalResult();
    });

    await tick();

    const t = rootTask(projectId)!;
    const run = listRoleRuns(t.task_id)[0]!;
    expect(run.context_degraded).toBe(1);
    // Enforced: the huge intake was NOT sent in full, but the condensation is
    // stated in the prompt (the doc's "state every drop/collapse" rule).
    expect(contexts[0]).not.toContain(BIG_INTAKE);
    expect(contexts[0]).toContain("condensed — head + tail");
    expect(contexts[0]!.length).toBeLessThan(BIG_INTAKE.length);
  });

  it("compacts oversize intake at ingest, preserving the full original in a sidecar file referenced by path", async () => {
    const { repo, projectId } = setupProject();
    const bigLog = "Traceback (most recent call last):\n" + "at foo.js:1:1\n".repeat(1000); // > 8000 chars
    expect(bigLog.length).toBeGreaterThan(8000);
    writeArtifact(path.join(repo, "PLANNING", "INTAKE", "crash.log"), bigLog);
    setRoleRunner(async () => minimalResult());

    await tick(); // ingest (+ first role step)

    const t = rootTask(projectId)!;
    // The DB row's content is compacted, not the full multi-KB log.
    expect(t.content!.length).toBeLessThan(bigLog.length);
    expect(t.content).toContain("condensed at intake");
    expect(t.content).toContain("raw-intake.txt");
    // The full original is preserved on disk in the task's own worktree.
    const sidecarMatch = /full text at `([^`]+)`/.exec(t.content!);
    expect(sidecarMatch).not.toBeNull();
    const sidecarRel = sidecarMatch![1]!;
    const sidecarAbs = path.join(t.git_worktree_path!, sidecarRel);
    expect(fs.existsSync(sidecarAbs)).toBe(true);
    expect(fs.readFileSync(sidecarAbs, "utf8")).toBe(bigLog);
  });

  it("leaves small intake untouched at ingest (no sidecar, no condensation)", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(path.join(repo, "PLANNING", "INTAKE", "crash.log"), "Error: boom");
    setRoleRunner(async () => minimalResult());

    await tick();

    const t = rootTask(projectId)!;
    expect(t.content).toBe("Error: boom");
    expect(t.content).not.toContain("condensed at intake");
  });
});

describe("artifact-first output (overhaul/01)", () => {
  const STREAMED = "## Streamed Section\n\nprose saved via report_section";

  /** Mimics a run that streamed its whole report to the artifact via
   *  report_section during the run: the prose is already on disk when the
   *  runner returns, and artifactResidualMd says there is nothing left to
   *  append. */
  function streamingRunner(): RoleRunner {
    return async (params) => {
      appendArtifactSection(params.artifactAbsPath, STREAMED);
      return {
        findings: {
          verdict: "pass",
          summary: "pass from streaming fake",
          open_questions: [],
          coverage: [{ concern: "security", status: "considered" }],
          section_md: STREAMED,
          criteria_results: [],
        },
        toolCalls: [],
        transcriptJsonl: "",
        tokens: 1,
        model: "fake",
        fallback: false,
        stalled: false,
        thinkingText: "",
        filesWritten: [],
        artifactBytesAppended: Buffer.byteLength(STREAMED, "utf8"),
        verdictSource: "tool",
        artifactResidualMd: "",
      };
    };
  }

  it("does not re-append prose the run already streamed to the artifact", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(path.join(repo, "PLANNING", "INTAKE", "note.md"), "please do a thing");
    setRoleRunner(streamingRunner());

    await tick(); // ingest + first role run

    const t = rootTask(projectId)!;
    const runs = listRoleRuns(t.task_id);
    expect(runs.length).toBe(1);
    // The run row still carries the complete report...
    expect(runs[0]!.output_md).toContain("prose saved via report_section");
    expect(runs[0]!.verdict_source).toBe("tool");
    // ...but the artifact holds it exactly once (streamed copy only, no
    // post-run duplicate append).
    const content = fs.readFileSync(path.join(t.git_worktree_path!, t.artifact_path!), "utf8");
    expect(content.split("prose saved via report_section").length - 1).toBe(1);
  });

  it("keeps appending section_md post-run for runners without the artifact-first fields (v1 parity)", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(path.join(repo, "PLANNING", "INTAKE", "note.md"), "please do a thing");
    setRoleRunner(fakeRunner("pass"));

    await tick();

    const t = rootTask(projectId)!;
    expect(listRoleRuns(t.task_id).length).toBe(1);
    const content = fs.readFileSync(path.join(t.git_worktree_path!, t.artifact_path!), "utf8");
    expect(content.split("implement the fix").length - 1).toBe(1);
  });

  it("marks the checkpoint commit and persists verdict_source when the verdict was synthesized", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(path.join(repo, "PLANNING", "INTAKE", "note.md"), "please do a thing");
    setRoleRunner(async () => ({
      findings: {
        verdict: "needs_more" as Verdict,
        summary: "Output was truncated before the role recorded a verdict.",
        open_questions: [],
        coverage: [],
        section_md: "partial prose that must still reach the artifact",
        criteria_results: [],
      },
      toolCalls: [],
      transcriptJsonl: "",
      tokens: 1,
      model: "fake",
      fallback: true,
      stalled: false,
      stopReason: "length",
      thinkingText: "",
      filesWritten: [],
      artifactBytesAppended: 0,
      verdictSource: "fallback" as const,
      artifactResidualMd: "partial prose that must still reach the artifact",
    }));

    await tick();

    const t = rootTask(projectId)!;
    const run = listRoleRuns(t.task_id)[0]!;
    expect(run.verdict_source).toBe("fallback");
    expect(run.fallback).toBe(1);
    // Prose preserved on disk even though the verdict was synthesized...
    const content = fs.readFileSync(path.join(t.git_worktree_path!, t.artifact_path!), "utf8");
    expect(content).toContain("partial prose that must still reach the artifact");
    // ...and the checkpoint commit is visibly flagged as degraded.
    const log = execFileSync("git", ["log", "--format=%s"], { cwd: t.git_worktree_path! }).toString();
    expect(log).toContain("[degraded: fallback verdict]");
  });
});
// ---------------------------------------------------------------------------
// Grounded verification (PLANNING/overhaul/05)
// ---------------------------------------------------------------------------

describe("grounded verification (overhaul/05)", () => {
  const TEST_CRITERION: Criterion = {
    id: "exec.tests_pass",
    text: "tests pass",
    ownerRole: "developer",
    severity: "must",
    evidence: { command: "test", mustExitZero: true },
  };

  function evidenceJson(exitCode: number, name = "test"): string {
    return JSON.stringify([
      {
        name,
        argv: ["npm", "test"],
        exitCode,
        durationMs: 1200,
        outputTail: exitCode === 0 ? "42 passing" : "1 failing",
        truncated: false,
        timedOut: false,
        startedAt: new Date().toISOString(),
      },
    ]);
  }

  describe("checkEvidenceCriteria", () => {
    it("is unmet when the command was never run", () => {
      freshDb();
      const t = createTask({ name: "t" });
      createRoleRun({ task_id: t.task_id, role_key: "developer", verdict: "pass" });
      const [check] = checkEvidenceCriteria(t.task_id, [TEST_CRITERION]);
      expect(check!.met).toBe(false);
      expect(check!.detail).toContain("never run");
    });

    it("is met when the owner's own run recorded a green execution", () => {
      freshDb();
      const t = createTask({ name: "t" });
      createRoleRun({
        task_id: t.task_id,
        role_key: "developer",
        verdict: "pass",
        evidence_json: evidenceJson(0),
      });
      const [check] = checkEvidenceCriteria(t.task_id, [TEST_CRITERION]);
      expect(check!.met).toBe(true);
      expect(check!.latest?.exitCode).toBe(0);
    });

    it("is unmet when the recorded execution was red", () => {
      freshDb();
      const t = createTask({ name: "t" });
      createRoleRun({
        task_id: t.task_id,
        role_key: "developer",
        verdict: "pass",
        evidence_json: evidenceJson(1),
      });
      const [check] = checkEvidenceCriteria(t.task_id, [TEST_CRITERION]);
      expect(check!.met).toBe(false);
    });

    it("prefers a later reviewer re-run over the owner's own earlier result", () => {
      freshDb();
      const t = createTask({ name: "t" });
      createRoleRun({ task_id: t.task_id, role_key: "developer", verdict: "pass", evidence_json: evidenceJson(0) });
      createRoleRun({ task_id: t.task_id, role_key: "critic", verdict: "pass", evidence_json: evidenceJson(1) });
      const [check] = checkEvidenceCriteria(t.task_id, [TEST_CRITERION]);
      // The critic's independent re-run is the newest answer, and it is red.
      expect(check!.met).toBe(false);
    });

    it("treats evidence from before the owner's latest run as stale", () => {
      freshDb();
      const t = createTask({ name: "t" });
      // Attempt 1: developer ran the suite green.
      createRoleRun({ task_id: t.task_id, role_key: "developer", verdict: "pass", evidence_json: evidenceJson(0) });
      createRoleRun({ task_id: t.task_id, role_key: "critic", verdict: "needs_more" });
      // Attempt 2 (loop-back): developer edited code and never re-ran anything.
      createRoleRun({ task_id: t.task_id, role_key: "developer", verdict: "pass", attempt: 2 });
      const [check] = checkEvidenceCriteria(t.task_id, [TEST_CRITERION]);
      expect(check!.met).toBe(false);
      expect(check!.detail).toContain("has not been run since");
    });

    it("ignores evidence recorded on non-primary (critique) runs", () => {
      freshDb();
      const t = createTask({ name: "t" });
      const primary = createRoleRun({ task_id: t.task_id, role_key: "developer", verdict: "pass" });
      createRoleRun({
        task_id: t.task_id,
        role_key: "critic",
        run_kind: "critique",
        target_run_id: primary.id,
        evidence_json: evidenceJson(0),
      });
      expect(checkEvidenceCriteria(t.task_id, [TEST_CRITERION])[0]!.met).toBe(false);
    });

    it("a fallback/repaired verdict cannot satisfy an evidence criterion", () => {
      // The doc's negative case: repair reconstructs a *verdict* from prose and
      // can never mint an evidence row, so a repaired "pass" still fails here.
      freshDb();
      const t = createTask({ name: "t" });
      createRoleRun({
        task_id: t.task_id,
        role_key: "developer",
        verdict: "pass",
        verdict_source: "repair",
        fallback: 0,
      });
      expect(checkEvidenceCriteria(t.task_id, [TEST_CRITERION])[0]!.met).toBe(false);
    });

    it("returns nothing when there are no evidence criteria", () => {
      freshDb();
      const t = createTask({ name: "t" });
      expect(checkEvidenceCriteria(t.task_id, [])).toEqual([]);
    });
  });

  // ---- Flow wiring -------------------------------------------------------

  /** A code-change leaf sitting at the developer step, as decomposition creates it. */
  function codeChangeTask(projectId: number): TaskRow {
    return createTask({
      name: "impl",
      project_id: projectId,
      stage: "refining",
      exit_kind: "code_change",
      intake_kind: "feature",
      level: "task",
      refinement_plan_json: JSON.stringify({
        steps: [
          { role: "developer", status: "pending", depth: 1 },
          { role: "critic", status: "pending", depth: 1 },
        ],
      }),
    });
  }

  function enableExec(projectId: number): void {
    updateProject(projectId, {
      config_json: JSON.stringify({
        harness: {
          allowExec: true,
          execAllowlist: [{ name: "test", argv: ["npm", "test"] }],
        },
      }),
    });
  }

  /** A runner that passes every step and attaches the given evidence to the
   *  `developer` step only (the critic here does not re-run anything).
   *  RunRoleParams carries no role key, so the developer is identified by the
   *  opening line of its seeded persona. */
  const DEVELOPER_PERSONA = "You implement the refined work";
  function runnerWithEvidence(exitCode: number | null): RoleRunner {
    return async (params) => ({
      findings: {
        verdict: "pass" as Verdict,
        summary: "implemented",
        open_questions: [],
        coverage: [],
        section_md: "## step\ndone\n",
        criteria_results: [],
      },
      toolCalls: [],
      transcriptJsonl: "",
      tokens: 1,
      model: "fake",
      fallback: false,
      stalled: false,
      thinkingText: "",
      filesWritten: [],
      verdictSource: "tool" as const,
      evidence:
        exitCode == null || !params.systemPrompt.includes(DEVELOPER_PERSONA)
          ? []
          : [
              {
                name: "test",
                argv: ["npm", "test"],
                exitCode,
                durationMs: 900,
                outputTail: exitCode === 0 ? "ok" : "FAIL",
                truncated: false,
                timedOut: false,
                startedAt: new Date().toISOString(),
              },
            ],
    });
  }

  it("persists harness-recorded evidence onto the run row", async () => {
    const { projectId } = setupProject();
    enableExec(projectId);
    const task = codeChangeTask(projectId);
    setRoleRunner(runnerWithEvidence(0));

    await tick();

    const devRun = listRoleRuns(task.task_id).find((r) => r.role_key === "developer")!;
    expect(JSON.parse(devRun.evidence_json!)[0].exitCode).toBe(0);
  });

  it("reaches merge review when the required command ran green", async () => {
    const { projectId } = setupProject();
    enableExec(projectId);
    const task = codeChangeTask(projectId);
    setRoleRunner(runnerWithEvidence(0));

    await drainTicks(projectId, (t) => t.stage === "review" || t.stage === "ready");

    const t = getTask(task.task_id)!;
    expect(t.stage).toBe("review");
    expect(t.exit_state).toBe("needs_merge_approval");
  });

  it("blocks the gate on a red run even though every role reported pass", async () => {
    const { projectId } = setupProject();
    enableExec(projectId);
    const task = codeChangeTask(projectId);
    setRoleRunner(runnerWithEvidence(1));

    await drainTicks(projectId, (t) => t.stage === "review" || t.stage === "ready");

    const t = getTask(task.task_id)!;
    // Loop-backs exhausted → parked for a human, NOT promoted to merge review.
    expect(t.exit_state).not.toBe("needs_merge_approval");
    expect(t.stage).toBe("review");
    expect(t.review_reason ?? "").toMatch(/verification did not pass/i);
  });

  it("blocks the gate when nothing was executed at all", async () => {
    const { projectId } = setupProject();
    enableExec(projectId);
    const task = codeChangeTask(projectId);
    setRoleRunner(runnerWithEvidence(null)); // every role passes, none verifies

    await drainTicks(projectId, (t) => t.stage === "review" || t.stage === "ready");

    const t = getTask(task.task_id)!;
    expect(t.exit_state).not.toBe("needs_merge_approval");
    expect(t.review_reason ?? "").toMatch(/never run/i);
  });

  it("re-opens the developer (the criterion's owner), not just the reviewer", async () => {
    const { projectId } = setupProject();
    enableExec(projectId);
    const task = codeChangeTask(projectId);
    setRoleRunner(runnerWithEvidence(1));

    await tick(); // developer
    await tick(); // critic → gate fails on the red run → loop-back

    const runs = listRoleRuns(task.task_id).map((r) => r.role_key);
    expect(runs).toEqual(["developer", "critic"]);
    const plan = JSON.parse(getTask(task.task_id)!.refinement_plan_json!) as {
      steps: { role: string; status: string }[];
    };
    expect(plan.steps.find((s) => s.role === "developer")!.status).toBe("pending");

    // And the re-run developer is told what actually happened, not just "unmet".
    const notes = listInterventions(task.task_id)
      .map((i) => JSON.parse(i.payload_json ?? "{}").text ?? "")
      .join("\n");
    expect(notes).toContain("exec.tests_pass");
    expect(notes).toMatch(/exit 1/);
  });

  it("stays a no-op for a project that has not enabled exec", async () => {
    const { projectId } = setupProject();
    // No enableExec() — the flow carries no evidence criteria at all, so the
    // execution flow behaves exactly as it did before overhaul/05.
    const task = codeChangeTask(projectId);
    setRoleRunner(runnerWithEvidence(null));

    await drainTicks(projectId, (t) => t.stage === "review" || t.stage === "ready");

    const t = getTask(task.task_id)!;
    expect(t.stage).toBe("review");
    expect(t.exit_state).toBe("needs_merge_approval");
  });

  it("feeds recorded evidence forward into the next role's context", async () => {
    const { projectId } = setupProject();
    enableExec(projectId);
    const task = codeChangeTask(projectId);
    const contexts: string[] = [];
    const inner = runnerWithEvidence(1);
    setRoleRunner(async (params) => {
      contexts.push(params.context);
      return inner(params);
    });

    await tick(); // developer records a red run
    await tick(); // critic sees it

    expect(contexts[1]).toContain("Verification evidence");
    expect(contexts[1]).toContain("npm test");
    expect(contexts[1]).toContain("Automatically verified");
  });
});
