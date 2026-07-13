import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CoverageItem, CriteriaResult, RoleRunResult, Verdict } from "../src/agent";
import { closeDb, createProject, getTask, listRoleRuns, listTasks, updateTask, type TaskRow } from "../src/db";
import { scaffoldPlanning, writeArtifact } from "../src/git";
import { flowForIntake, ROUTING_TEMPLATES } from "../src/roles";
import { seedGlobalRoles } from "../src/roles";
import {
  applyPlanMutation,
  inferIntakeKind,
  mergeCoverageItems,
  nextPending,
  parseDecompositionTree,
  planFromTemplate,
  resetRoleRunner,
  setRoleRunner,
  tick,
} from "../src/orchestrator";
import type { RoleRunner } from "../src/orchestrator";
import { freshDb, tempGitRepo } from "./helpers";

afterEach(() => {
  resetRoleRunner();
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

  it("rerun sets the matching step back to pending", () => {
    const plan = planFromTemplate("error_file");
    plan.steps[0]!.status = "done";
    applyPlanMutation(plan, "rerun_role", { role: plan.steps[0]!.role }, isTerminal);
    expect(plan.steps[0]!.status).toBe("pending");
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
    thinkingText: "",
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
      thinkingText: "",
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
    // Every planned role ran exactly once (no loop-back).
    expect(listRoleRuns(t.task_id).length).toBe(ROUTING_TEMPLATES.error_file.length);
    // Artifact moved into READY and exists on disk.
    expect(t.artifact_path).toContain("READY");
    expect(fs.existsSync(path.join(repo, t.artifact_path!))).toBe(true);
    // Decomposition produced child tasks.
    expect(listTasks({ parentTaskId: t.task_id }).length).toBeGreaterThan(0);
    // INTAKE original was consumed (moved out).
    expect(fs.existsSync(path.join(repo, "PLANNING", "INTAKE", "crash.log"))).toBe(false);
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

    // Fire two ticks at once; the mutex must prevent double-ingest.
    await Promise.all([tick(), tick()]);

    const roots = listTasks({ projectId }).filter((t) => t.parent_task_id == null);
    expect(roots.length).toBe(1);
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
      stopReason: "length",
      thinkingText: "the model was thinking hard",
    }));

    await drainTicks(projectId, () => listRoleRuns(rootTask(projectId)!.task_id).length > 0, 5);

    const runs = listRoleRuns(rootTask(projectId)!.task_id);
    const first = runs[0]!;
    expect(first.fallback).toBe(1);
    expect(first.stop_reason).toBe("length");
    expect(first.thinking_md).toBe("the model was thinking hard");
  });
});