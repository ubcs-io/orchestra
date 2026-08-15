import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RoleRunResult, Verdict } from "../src/agent";
import {
  closeDb,
  createProject,
  getNetworkByIntakeKind,
  getProject,
  getTask,
  listInterventions,
  listRoleRuns,
  listTasks,
  updateProject,
  updateTask,
  type TaskRow,
} from "../src/db";
import { scaffoldPlanning, writeArtifact } from "../src/git";
import { flowForIntake, seedGlobalRoles, seedNetworks } from "../src/roles";
import {
  buildHeuristicProposal,
  buildNetworkCatalog,
  intakeReviewState,
  isScoutingIntake,
  mergePlannerProposal,
  readProposal,
  resolveIntakeReviewConfig,
  validateProposal,
  type IntakeProposal,
} from "../src/intake-review";
import {
  applyIntakeProposal,
  effortBudgetPreview,
  ingestProject,
  materializeIntakeTask,
  readPlan,
  resetReachabilityChecker,
  resetRoleRunner,
  setReachabilityChecker,
  setRoleRunner,
  skipIntakeReview,
  tick,
  type RoleRunner,
} from "../src/orchestrator";
import { resetRouterFns, setIntakePlanFn } from "../src/router";
import { freshDb, tempGitRepo } from "./helpers";

beforeEach(() => {
  setReachabilityChecker(async () => ({ ok: true }));
});

afterEach(() => {
  resetRoleRunner();
  resetReachabilityChecker();
  resetRouterFns();
  closeDb();
});

function setupProject(): { repo: string; projectId: number } {
  const repo = tempGitRepo();
  freshDb();
  seedGlobalRoles();
  seedNetworks();
  const project = createProject({ name: "p", repo_path: repo });
  scaffoldPlanning(repo, "PLANNING");
  return { repo, projectId: project.id };
}

function rootTask(projectId: number): TaskRow | undefined {
  return listTasks({ projectId }).find((t) => t.parent_task_id == null);
}

async function drainTicks(
  projectId: number,
  until: (t: TaskRow) => boolean,
  max = 30,
): Promise<void> {
  for (let i = 0; i < max; i++) {
    await tick();
    const t = rootTask(projectId);
    if (t && until(t)) return;
  }
}

/** A runner that always passes, optionally reporting an effort size (only the
 *  explorer role's is ever persisted — see runOneStep). */
function passingRunner(effortSize?: "XS" | "S" | "M" | "L" | "XL"): RoleRunner {
  return async (): Promise<RoleRunResult> => ({
    findings: {
      verdict: "pass" as Verdict,
      summary: "pass from fake",
      open_questions: [],
      coverage: [{ concern: "correctness", status: "considered" }],
      section_md: "## role\nfindings",
      criteria_results: [],
      ...(effortSize ? { effort_size: effortSize } : {}),
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

// ---- Config -------------------------------------------------------------

describe("resolveIntakeReviewConfig", () => {
  it("defaults to off, and degrades on missing/garbage/malformed config", () => {
    expect(resolveIntakeReviewConfig(null).default).toBe("off");
    expect(resolveIntakeReviewConfig("{}").default).toBe("off");
    expect(resolveIntakeReviewConfig("not json{{").default).toBe("off");
    expect(resolveIntakeReviewConfig(JSON.stringify({ intakeReview: {} })).default).toBe("off");
    expect(
      resolveIntakeReviewConfig(JSON.stringify({ intakeReview: { default: "maybe" } })).default,
    ).toBe("off");
  });

  it("reads an explicit opt-in", () => {
    expect(
      resolveIntakeReviewConfig(JSON.stringify({ intakeReview: { default: "on" } })).default,
    ).toBe("on");
  });
});

// ---- The heuristic proposal --------------------------------------------

describe("buildHeuristicProposal", () => {
  it("reproduces today's routing for every intake kind", () => {
    setupProject();
    for (const kind of ["manual", "bug", "feature", "chore", "research", "question"] as const) {
      const proposal = buildHeuristicProposal({
        intakeKind: kind,
        defaultNetworkId: null,
        effortSize: null,
        planningRigor: "standard",
      });
      expect(proposal.intake_kind).toBe(kind);
      // No network chosen → exactly the built-in flow's steps.
      expect(proposal.role_plan).toEqual(flowForIntake(kind).steps);
      expect(proposal.source).toBe("heuristic");
      // "M" is the same mid-sized fallback resolveFamilyBudget uses.
      expect(proposal.effort_size).toBe("M");
    }
  });

  it("uses the seeded default network for the kind when there is one", () => {
    const { projectId } = setupProject();
    const network = getNetworkByIntakeKind(projectId, "bug");
    expect(network).toBeTruthy();
    const proposal = buildHeuristicProposal({
      intakeKind: "bug",
      defaultNetworkId: network!.network_id,
      effortSize: "S",
      planningRigor: "minimal",
    });
    expect(proposal.network_id).toBe(network!.network_id);
    expect(proposal.role_plan).toEqual(flowForIntake("bug").steps);
    expect(proposal.effort_size).toBe("S");
    expect(proposal.planning_rigor).toBe("minimal");
  });
});

// ---- Folding in the planner's answer ------------------------------------

describe("mergePlannerProposal", () => {
  function heuristic(): IntakeProposal {
    return buildHeuristicProposal({
      intakeKind: "manual",
      defaultNetworkId: null,
      effortSize: null,
      planningRigor: "standard",
    });
  }

  it("takes the planner's answers when they are usable", () => {
    const merged = mergePlannerProposal(
      heuristic(),
      {
        restated_request: "Rename the flag",
        intake_kind: "chore",
        network_id: null,
        role_plan: ["explorer", "style_conventions"],
        effort_size: "XS",
        size_rationale: "one constant, three call sites",
        planning_rigor: "minimal",
        confidence: "high",
        assumptions: [{ question: "q", assumed_answer: "a", confidence: "medium" }],
      },
      { networks: [], availableRoles: ["explorer", "style_conventions"] },
    );
    expect(merged.intake_kind).toBe("chore");
    expect(merged.role_plan).toEqual(["explorer", "style_conventions"]);
    expect(merged.effort_size).toBe("XS");
    expect(merged.planning_rigor).toBe("minimal");
    expect(merged.assumptions).toHaveLength(1);
    expect(merged.source).toBe("planner");
  });

  it("keeps the heuristic's value for every field the planner got wrong", () => {
    const base = heuristic();
    const merged = mergePlannerProposal(
      base,
      {
        intake_kind: "not-a-kind",
        network_id: "no-such-network",
        effort_size: "XXL",
        planning_rigor: "extreme",
        role_plan: ["a_role_that_does_not_exist"],
        assumptions: "not an array",
        custom_node: { title: "no role_key" },
      },
      { networks: [], availableRoles: ["explorer"] },
    );
    expect(merged.intake_kind).toBe(base.intake_kind);
    expect(merged.network_id).toBe(base.network_id);
    expect(merged.effort_size).toBe(base.effort_size);
    expect(merged.planning_rigor).toBe(base.planning_rigor);
    // Every proposed role was fictional → fall back rather than seed a plan of
    // steps that can only be skipped.
    expect(merged.role_plan).toEqual(base.role_plan);
    expect(merged.assumptions).toEqual([]);
    expect(merged.custom_node).toBeNull();
  });

  it("falls back to a chosen network's own roles when the planner can't restate them", () => {
    const { projectId } = setupProject();
    const catalog = buildNetworkCatalog(projectId);
    const bug = catalog.find((n) => n.intake_kind === "bug")!;
    const merged = mergePlannerProposal(
      heuristic(),
      { intake_kind: "bug", network_id: bug.network_id, role_plan: ["fictional_role"] },
      { networks: catalog, availableRoles: ["explorer"] },
    );
    expect(merged.network_id).toBe(bug.network_id);
    expect(merged.role_plan).toEqual(bug.roles);
  });
});

// ---- Save-time validation ----------------------------------------------

describe("validateProposal", () => {
  function base(): IntakeProposal {
    return buildHeuristicProposal({
      intakeKind: "manual",
      defaultNetworkId: null,
      effortSize: "M",
      planningRigor: "standard",
    });
  }

  it("reports what is wrong instead of silently degrading", () => {
    setupProject();
    const b = base();
    expect(validateProposal({ ...b, intake_kind: "nope" }, b)).toMatchObject({ ok: false });
    expect(validateProposal({ ...b, effort_size: "XXL" }, b)).toMatchObject({ ok: false });
    expect(validateProposal({ ...b, planning_rigor: "loose" }, b)).toMatchObject({ ok: false });
    expect(validateProposal({ ...b, role_plan: [] }, b)).toMatchObject({ ok: false });
    expect(validateProposal({ ...b, autonomy_level: "yolo" }, b)).toMatchObject({ ok: false });
    expect(validateProposal({ ...b, network_id: "ghost" }, b)).toMatchObject({ ok: false });
    expect(validateProposal("not an object", b)).toMatchObject({ ok: false });
  });

  it("accepts a well-formed edit and keeps unspecified fields from the stored proposal", () => {
    setupProject();
    const b = base();
    const result = validateProposal(
      { ...b, intake_kind: "chore", effort_size: "S", role_plan: ["explorer"] },
      b,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.intake_kind).toBe("chore");
    expect(result.proposal.effort_size).toBe("S");
    expect(result.proposal.role_plan).toEqual(["explorer"]);
    expect(result.proposal.size_rationale).toBe(b.size_rationale);
  });
});

// ---- The budget preview -------------------------------------------------

describe("effortBudgetPreview", () => {
  it("quotes the same numbers the decomposition gate will enforce", () => {
    const { projectId } = setupProject();
    const task = materializeIntakeTask(getProject(projectId)!, {
      name: "t",
      content: "do a thing",
      intakeKind: "manual",
    });
    const standard = effortBudgetPreview(task, "standard");
    expect(standard.find((r) => r.size === "XS")).toMatchObject({ maxCount: 0, maxDepth: 0 });
    expect(standard.find((r) => r.size === "M")).toMatchObject({ maxCount: 12, maxDepth: 2 });
    // Rigor scales the count, never the depth (see resolveFamilyBudget).
    const thorough = effortBudgetPreview(task, "thorough");
    expect(thorough.find((r) => r.size === "M")).toMatchObject({ maxCount: 18, maxDepth: 2 });
    const minimal = effortBudgetPreview(task, "minimal");
    expect(minimal.find((r) => r.size === "M")!.maxCount).toBe(8);
  });
});

// ---- The scout pass -----------------------------------------------------

describe("intake review — scout pass", () => {
  it("runs the two scout roles, then parks the task on a human with a proposal", async () => {
    const { projectId } = setupProject();
    setRoleRunner(passingRunner("S"));
    const proj = getProject(projectId)!;
    const created = materializeIntakeTask(proj, {
      name: "review-me",
      content: "Change the login copy",
      intakeKind: "manual",
      review: true,
    });

    expect(isScoutingIntake(created)).toBe(true);
    expect(readPlan(created)!.steps.map((s) => s.role)).toEqual(["intake_triage", "explorer"]);

    await drainTicks(projectId, (t) => intakeReviewState(t) === "proposed");

    const task = getTask(created.task_id)!;
    expect(intakeReviewState(task)).toBe("proposed");
    // Parked, so nothing else runs until a human decides.
    expect(task.paused).toBe(1);
    // Exactly the two scout roles ran — no critique passes, no flow roles.
    expect(listRoleRuns(task.task_id).map((r) => r.role_key)).toEqual([
      "intake_triage",
      "explorer",
    ]);
    // Never finalized: the prefix running out of steps is not "task ready".
    expect(task.stage).toBe("refining");
    expect(task.exit_state).toBeNull();

    const proposal = readProposal(task)!;
    expect(proposal.source).toBe("heuristic"); // router off by default
    expect(proposal.effort_size).toBe("S"); // explorer's own estimate, carried in
    expect(task.effort_size).toBe("S");
    expect(task.effort_size_source).toBe("model");
  });

  it("surfaces a scout's blocker as a warning on the proposal rather than escalating", async () => {
    const { projectId } = setupProject();
    setRoleRunner(async () => ({
      findings: {
        verdict: "blocker" as Verdict,
        summary: "far too vague to proceed",
        open_questions: [],
        coverage: [],
        section_md: "## triage\nvague",
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
    }));
    const proj = getProject(projectId)!;
    const created = materializeIntakeTask(proj, {
      name: "vague",
      content: "make it better",
      intakeKind: "manual",
      review: true,
    });

    await drainTicks(projectId, (t) => intakeReviewState(t) === "proposed");

    const task = getTask(created.task_id)!;
    expect(intakeReviewState(task)).toBe("proposed");
    // Not escalated into stage:review — the human is the gate here already.
    expect(task.stage).toBe("refining");
    expect(task.exit_state).toBeNull();
    expect(readProposal(task)!.scout_warning).toContain("far too vague");
  });

  it("uses the planner's proposal when Call Point 7 is enabled", async () => {
    const { projectId } = setupProject();
    updateProject(projectId, {
      config_json: JSON.stringify({ router: { enabled: true, intakePlanning: true } }),
    });
    setRoleRunner(passingRunner("L"));
    setIntakePlanFn(async () => ({
      restated_request: "Flip a default",
      intake_kind: "chore",
      network_id: null,
      network_why: "small mechanical change",
      role_plan: ["explorer", "style_conventions", "spec_review"],
      plan_deltas: [{ role_key: "test_strategy", change: "removed" as const, why: "no behaviour change" }],
      effort_size: "XS",
      size_rationale: "one constant in one file",
      planning_rigor: "minimal",
      assumptions: [{ question: "Which default?", assumed_answer: "the retry count", confidence: "medium" }],
      custom_node: null,
      confidence: "high",
    }));

    const proj = getProject(projectId)!;
    const created = materializeIntakeTask(proj, {
      name: "planner",
      content: "bump the retry default",
      intakeKind: "feature",
      review: true,
    });
    await drainTicks(projectId, (t) => intakeReviewState(t) === "proposed");

    const proposal = readProposal(getTask(created.task_id)!)!;
    expect(proposal.source).toBe("planner");
    expect(proposal.intake_kind).toBe("chore");
    // The planner's XS overrides explorer's "L" in the *proposal* — but only a
    // human accepting it makes that the task's size.
    expect(proposal.effort_size).toBe("XS");
    expect(getTask(created.task_id)!.effort_size).toBe("L");
    expect(proposal.assumptions).toHaveLength(1);
  });

  it("falls back to the heuristic proposal when the planner returns nothing", async () => {
    const { projectId } = setupProject();
    updateProject(projectId, {
      config_json: JSON.stringify({ router: { enabled: true, intakePlanning: true } }),
    });
    setRoleRunner(passingRunner("M"));
    setIntakePlanFn(async () => null);

    const proj = getProject(projectId)!;
    const created = materializeIntakeTask(proj, {
      name: "planner-down",
      content: "something",
      intakeKind: "bug",
      review: true,
    });
    await drainTicks(projectId, (t) => intakeReviewState(t) === "proposed");

    const proposal = readProposal(getTask(created.task_id)!)!;
    expect(proposal.source).toBe("heuristic");
    expect(proposal.intake_kind).toBe("bug");
  });
});

// ---- Accepting ----------------------------------------------------------

describe("intake review — accept", () => {
  async function scoutedTask(kind = "manual" as const, size: "XS" | "S" | "M" = "S") {
    const { projectId } = setupProject();
    setRoleRunner(passingRunner(size));
    const proj = getProject(projectId)!;
    const created = materializeIntakeTask(proj, {
      name: "t",
      content: "do the thing",
      intakeKind: kind,
      review: true,
    });
    await drainTicks(projectId, (t) => intakeReviewState(t) === "proposed");
    return { projectId, task: getTask(created.task_id)! };
  }

  it("seeds the chosen flow with the scout prefix already done, and releases the task", async () => {
    const { task } = await scoutedTask();
    const proposal = readProposal(task)!;

    const updated = applyIntakeProposal(task.task_id, { ...proposal, intake_kind: "chore" })!;

    expect(intakeReviewState(updated)).toBe("accepted");
    expect(updated.intake_kind).toBe("chore");
    expect(updated.paused).toBe(0);
    expect(updated.stage).toBe("refining");

    const plan = readPlan(updated)!;
    // The two scout runs are reused, not re-run.
    expect(plan.steps.find((s) => s.role === "intake_triage")!.status).toBe("done");
    expect(plan.steps.find((s) => s.role === "explorer")!.status).toBe("done");
    // ...and the rest of the chosen flow is still ahead of it.
    expect(plan.steps.filter((s) => s.status === "pending").length).toBeGreaterThan(0);
  });

  it("records a human-set size on accept", async () => {
    const { task } = await scoutedTask("manual", "S");
    const proposal = readProposal(task)!;
    expect(task.effort_size).toBe("S");
    expect(task.effort_size_source).toBe("model");

    // The human disagrees: this is an L, not an S.
    const updated = applyIntakeProposal(task.task_id, { ...proposal, effort_size: "L" })!;
    expect(updated.effort_size).toBe("L");
    // "human" even for an unedited accept — they were shown the number beside
    // what it costs and chose to keep it.
    expect(updated.effort_size_source).toBe("human");
  });

  it("a later explorer run cannot overwrite a human-set size", async () => {
    const { projectId } = setupProject();
    setRoleRunner(passingRunner("S"));
    const created = materializeIntakeTask(getProject(projectId)!, {
      name: "sized-by-hand",
      content: "a request whose size a human already corrected",
      intakeKind: "manual",
    });
    // What an accepted review leaves behind.
    updateTask(created.task_id, { effort_size: "L", effort_size_source: "human" });

    // Run the normal flow until explorer has actually run and reported "S".
    await drainTicks(projectId, () =>
      listRoleRuns(created.task_id).some((r) => r.role_key === "explorer"),
    );
    expect(listRoleRuns(created.task_id).some((r) => r.role_key === "explorer")).toBe(true);

    const task = getTask(created.task_id)!;
    expect(task.effort_size).toBe("L");
    expect(task.effort_size_source).toBe("human");
  });

  it("applies the promoted roles of the ACCEPTED kind, not the filed one", async () => {
    const { projectId } = setupProject();
    // A role promoted into standing policy for "chore" only.
    updateProject(projectId, {
      config_json: JSON.stringify({ promotedRoles: { chore: ["privacy_review"] } }),
    });
    setRoleRunner(passingRunner("S"));
    const created = materializeIntakeTask(getProject(projectId)!, {
      name: "kind-change",
      content: "rename a constant",
      intakeKind: "manual",
      review: true,
    });
    await drainTicks(projectId, (t) => intakeReviewState(t) === "proposed");

    const task = getTask(created.task_id)!;
    const updated = applyIntakeProposal(task.task_id, {
      ...readProposal(task)!,
      intake_kind: "chore",
      role_plan: flowForIntake("chore").steps.slice(),
    })!;

    // The promoted role is keyed on intake_kind, which the human just changed —
    // reading it off the pre-accept row would have applied "manual"'s (none).
    expect(readPlan(updated)!.steps.map((s) => s.role)).toContain("privacy_review");
  });

  it("carries the human's restatement and confirmed assumptions into the flow", async () => {
    const { task } = await scoutedTask();
    applyIntakeProposal(task.task_id, {
      ...readProposal(task)!,
      restated_request: "Rename LOGIN_COPY and update the two call sites",
      assumptions: [
        { question: "Which locale files?", assumed_answer: "en only", confidence: "medium" },
        { question: "Unanswered one", assumed_answer: "", confidence: "low" },
      ],
    });

    // A steer_note is the channel buildRoleContext already reads, so the
    // corrections reach every subsequent role rather than sitting on the row.
    const notes = listInterventions(task.task_id).filter((iv) => iv.kind === "steer_note");
    expect(notes).toHaveLength(1);
    const text = JSON.parse(notes[0]!.payload_json!).text as string;
    expect(text).toContain("Rename LOGIN_COPY");
    expect(text).toContain("Which locale files? → en only");
    // An assumption the human left blank isn't asserted as settled.
    expect(text).not.toContain("Unanswered one");
  });

  it("adds no steer note when there is nothing human-authored to carry", async () => {
    const { task } = await scoutedTask();
    // The heuristic proposal has an empty restatement and no assumptions.
    applyIntakeProposal(task.task_id, readProposal(task)!);
    expect(listInterventions(task.task_id).filter((iv) => iv.kind === "steer_note")).toHaveLength(0);
  });

  it("routes an XS accept straight to the execution flow", async () => {
    const { task } = await scoutedTask("manual", "M");
    const proposal = readProposal(task)!;

    const updated = applyIntakeProposal(task.task_id, { ...proposal, effort_size: "XS" })!;

    expect(updated.exit_kind).toBe("code_change");
    const roles = readPlan(updated)!.steps.map((s) => s.role);
    expect(roles.slice(-2)).toEqual(["developer", "critic"]);
    // Nothing from the planning gauntlet survived past the scout prefix.
    expect(roles).not.toContain("spec_review");
    expect(roles).not.toContain("decomposition");
  });

  it("refuses the XS fast path when autonomy is 'plan' — same guard as the explorer path", async () => {
    const { task } = await scoutedTask("manual", "M");
    const proposal = readProposal(task)!;

    // "plan" autonomy must never let a task begin writing code — so an XS
    // accept stays on the planning flow instead of taking the fast path.
    const updated = applyIntakeProposal(task.task_id, {
      ...proposal,
      effort_size: "XS",
      autonomy_level: "plan",
    })!;

    expect(updated.exit_kind).toBe("spec");
    expect(readPlan(updated)!.steps.map((s) => s.role)).not.toContain("developer");
  });

  it("honours an edited role plan verbatim", async () => {
    const { task } = await scoutedTask();
    const proposal = readProposal(task)!;

    const updated = applyIntakeProposal(task.task_id, {
      ...proposal,
      role_plan: ["explorer", "architecture_review", "spec_review"],
    })!;

    expect(readPlan(updated)!.steps.map((s) => s.role)).toEqual([
      "intake_triage",
      "explorer",
      "architecture_review",
      "spec_review",
    ]);
    // intake_triage isn't in the edited list, so it's prepended as already-done
    // rather than dropped — the run happened and the plan should say so.
    expect(readPlan(updated)!.steps[0]).toMatchObject({ role: "intake_triage", status: "done" });
  });

  it("continues to completion after an accept without re-running the scout roles", async () => {
    const { projectId, task } = await scoutedTask("chore", "S");
    applyIntakeProposal(task.task_id, readProposal(task)!);

    await drainTicks(projectId, (t) => t.stage === "ready" || t.stage === "review");

    const runs = listRoleRuns(task.task_id).map((r) => r.role_key);
    expect(runs.filter((r) => r === "intake_triage").length).toBe(1);
    expect(runs.filter((r) => r === "explorer").length).toBe(1);
    expect(["ready", "review"]).toContain(getTask(task.task_id)!.stage);
  });
});

// ---- Skipping -----------------------------------------------------------

describe("intake review — start as-is", () => {
  it("defers a skip requested mid-prefix to the next step boundary", async () => {
    const { projectId } = setupProject();
    setRoleRunner(passingRunner("S"));
    const created = materializeIntakeTask(getProject(projectId)!, {
      name: "impatient",
      content: "x",
      intakeKind: "manual",
      review: true,
    });

    // One tick = intake_triage has run, explorer has not: mid-prefix.
    await tick();
    expect(intakeReviewState(getTask(created.task_id)!)).toBe("scouting");

    // A step is holding the scout plan, so the skip is recorded, not applied.
    const deferred = skipIntakeReview(created.task_id)!;
    expect(intakeReviewState(deferred)).toBe("skip_pending");
    expect(deferred.refinement_plan_json).not.toBeNull();

    // It lands at the boundary — and critically, the task is NOT finalized on
    // the strength of the two-step prefix.
    await drainTicks(projectId, (t) => intakeReviewState(t) === "skipped");
    const task = getTask(created.task_id)!;
    expect(intakeReviewState(task)).toBe("skipped");
    expect(task.stage).not.toBe("ready");
    expect(task.exit_state).toBeNull();
    expect(readProposal(task)).toBeNull();
  });

  it("drops the review and runs the intake exactly as filed", async () => {
    const { projectId } = setupProject();
    setRoleRunner(passingRunner("S"));
    const proj = getProject(projectId)!;
    const created = materializeIntakeTask(proj, {
      name: "asis",
      content: "x",
      intakeKind: "manual",
      review: true,
    });
    await drainTicks(projectId, (t) => intakeReviewState(t) === "proposed");

    const skipped = skipIntakeReview(created.task_id)!;
    expect(intakeReviewState(skipped)).toBe("skipped");
    expect(skipped.paused).toBe(0);
    expect(skipped.refinement_plan_json).toBeNull();

    // The next tick seeds the filed kind's own flow from scratch.
    await tick();
    const plan = readPlan(getTask(created.task_id)!)!;
    expect(plan.steps.map((s) => s.role)).toEqual(
      expect.arrayContaining(flowForIntake("manual").steps),
    );
  });
});

// ---- The parallel-path guarantee ---------------------------------------

describe("intake review — off by default", () => {
  it("an un-reviewed intake is untouched: no review state, straight into its flow", async () => {
    const { repo, projectId } = setupProject();
    setRoleRunner(passingRunner("M"));
    writeArtifact(path.join(repo, "PLANNING", "INTAKE", "plain.md"), "a normal request");

    await tick(); // ingest + first step
    const task = rootTask(projectId)!;
    expect(task.intake_review_state).toBeNull();
    expect(readProposal(task)).toBeNull();
    expect(task.paused ?? 0).toBe(0);
    // Seeded the filed kind's whole flow, not a two-step scout prefix.
    expect(readPlan(task)!.steps.length).toBeGreaterThan(2);
  });

  it("a project that opts in reviews INTAKE-folder drops too", async () => {
    const { repo, projectId } = setupProject();
    updateProject(projectId, {
      config_json: JSON.stringify({ intakeReview: { default: "on" } }),
    });
    setRoleRunner(passingRunner("S"));
    writeArtifact(path.join(repo, "PLANNING", "INTAKE", "dropped.md"), "a dropped request");

    const proj = getProject(projectId)!;
    const created = ingestProject(proj);
    expect(created).toHaveLength(1);
    expect(intakeReviewState(created[0]!)).toBe("scouting");
  });

  it("an explicit choice on the request overrides the project default", async () => {
    const { repo, projectId } = setupProject();
    updateProject(projectId, {
      config_json: JSON.stringify({ intakeReview: { default: "on" } }),
    });
    writeArtifact(path.join(repo, "PLANNING", "INTAKE", "urgent.md"), "no time for review");

    const proj = getProject(projectId)!;
    const created = ingestProject(proj, { review: false });
    expect(intakeReviewState(created[0]!)).toBeNull();
  });
});
