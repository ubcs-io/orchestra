import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CoverageItem, CriteriaResult, RoleRunResult, Subtask, Verdict } from "../src/agent";
import { closeDb, createProject, createTask, getTask, listInterventions, listRoleRuns, listTasks, resetTask, updateProject, updateTask, type TaskRow } from "../src/db";
import type { RoleRunRow } from "../src/db";
import { scaffoldPlanning, writeArtifact } from "../src/git";
import { flowForIntake, ROUTING_TEMPLATES } from "../src/roles";
import { seedGlobalRoles } from "../src/roles";
import {
  applyPlanMutation,
  dependenciesSatisfied,
  inferIntakeKind,
  mergeCoverageItems,
  nextPending,
  parseDecompositionTree,
  planFromTemplate,
  reincorporateAnswer,
  renderSubtaskTree,
  resetReachabilityChecker,
  resetRoleRunner,
  resolveDecompositionSubtasks,
  restoreCheckpoint,
  setReachabilityChecker,
  setRoleRunner,
  tick,
  tickOnce,
} from "../src/orchestrator";
import type { RoleRunner } from "../src/orchestrator";
import { resetRouterFns, setAnswerMatchFn, setSecondReviewFn } from "../src/router";
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
    // Reconciliation merges the task's branch back into base on completion...
    expect(t.reconcile_status).toBe("merged");
    const currentBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo })
      .toString()
      .trim();
    expect(currentBranch).toBe(t.git_base_branch);
    // ...so the artifact is present in the shared checkout too, not just the
    // task's own worktree, once reconciliation has run.
    expect(fs.existsSync(path.join(repo, t.artifact_path!))).toBe(true);
    expect(fs.existsSync(path.join(t.git_worktree_path!, t.artifact_path!))).toBe(true);
    // Decomposition produced child tasks.
    expect(listTasks({ parentTaskId: t.task_id }).length).toBeGreaterThan(0);
    // INTAKE original was consumed (moved out).
    expect(fs.existsSync(path.join(repo, "PLANNING", "INTAKE", "crash.log"))).toBe(false);
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

  it("finalizes normally (no escalation, no children) when decomposition states an intentional no_decomposition_reason", async () => {
    const { repo, projectId } = setupProject();
    writeArtifact(
      path.join(repo, "PLANNING", "INTAKE", "crash.log"),
      "Traceback (most recent call last):\nValueError: boom",
    );
    setRoleRunner(decompositionRunner({ noDecompositionReason: "Already one atomic, independently-actionable unit." }));

    await tick();
    const t0 = rootTask(projectId);
    if (t0) updateTask(t0.task_id, { level: "epic" });

    await drainTicks(projectId, (t) => t.stage === "ready" || t.stage === "review");

    const t = rootTask(projectId)!;
    expect(t.stage).toBe("ready");
    expect(t.exit_state).toBe("ready_for_work");
    expect(listTasks({ parentTaskId: t.task_id }).length).toBe(0);
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