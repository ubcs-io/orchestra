/**
 * Budget guardrails (PLANNING/overhaul-2/01) — policy resolution, the spend
 * aggregator's honesty about partial pricing, and the gate's stop/override
 * behavior.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_BUDGET_POLICY,
  budgetEnforced,
  budgetOverrideActive,
  clearBudgetOverride,
  evaluateProjectBudget,
  grantBudgetOverride,
  resolveBudgetPolicy,
  shouldPublishBudgetWarning,
  validateBudgetPolicy,
  type BudgetPolicy,
} from "../src/budget-policy";
import {
  closeDb,
  createModelConfig,
  createProject,
  createRoleRun,
  createTask,
  getProjectSpend,
  getTask,
  updateProject,
  updateTask,
  type ProjectRow,
} from "../src/db";
import { freshDb } from "./helpers";

afterEach(() => closeDb());

const cfg = (budget: unknown): string => JSON.stringify({ budget });

describe("resolveBudgetPolicy", () => {
  it("degrades every malformed or missing config to the disabled default", () => {
    for (const input of [null, "", "not json", "{}", cfg(undefined), cfg("nope"), cfg([1, 2])]) {
      const p = resolveBudgetPolicy(input);
      expect(p.enabled, String(input)).toBe(false);
      expect(p.capTokens, String(input)).toBeUndefined();
      expect(p.capUsd, String(input)).toBeUndefined();
      expect(p.periodDays, String(input)).toBe(DEFAULT_BUDGET_POLICY.periodDays);
    }
  });

  it("only a literal true enables the switch", () => {
    expect(resolveBudgetPolicy(cfg({ enabled: "yes" })).enabled).toBe(false);
    expect(resolveBudgetPolicy(cfg({ enabled: 1 })).enabled).toBe(false);
    expect(resolveBudgetPolicy(cfg({ enabled: true })).enabled).toBe(true);
  });

  it("clamps knobs and reads a nonsensical cap as 'unset', never as zero", () => {
    const p = resolveBudgetPolicy(
      cfg({ periodDays: 10_000, warnThresholdPct: 0, overrideMinutes: -5, capTokens: 0, capUsd: "lots" }),
    );
    expect(p.periodDays).toBe(365);
    expect(p.warnThresholdPct).toBe(1);
    expect(p.overrideMinutes).toBe(1);
    // A cap of 0 would wedge the project on its first run — it must read as
    // "this dimension isn't budgeted" instead.
    expect(p.capTokens).toBeUndefined();
    expect(p.capUsd).toBeUndefined();
  });

  it("budgetEnforced needs a cap, not just the switch", () => {
    expect(budgetEnforced(resolveBudgetPolicy(cfg({ enabled: true })))).toBe(false);
    expect(budgetEnforced(resolveBudgetPolicy(cfg({ enabled: true, capTokens: 100 })))).toBe(true);
    expect(budgetEnforced(resolveBudgetPolicy(cfg({ enabled: false, capTokens: 100 })))).toBe(false);
  });
});

describe("validateBudgetPolicy", () => {
  it("reports the problem rather than silently degrading it", () => {
    expect(validateBudgetPolicy(null).ok).toBe(false);
    expect(validateBudgetPolicy([]).ok).toBe(false);
    const bad = validateBudgetPolicy({ periodDays: 9999 });
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.error).toContain("periodDays");
    const badCap = validateBudgetPolicy({ capUsd: -3 });
    expect(badCap.ok === false && badCap.error).toContain("capUsd");
  });

  it("refuses to enable a policy that would stop nothing", () => {
    const res = validateBudgetPolicy({ enabled: true });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain("stops nothing");
    expect(validateBudgetPolicy({ enabled: true, capTokens: 1000 }).ok).toBe(true);
  });

  it("normalizes through the same reader the runtime uses", () => {
    const res = validateBudgetPolicy({ enabled: true, capTokens: 500, capUsd: null, periodDays: 7 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.policy).toEqual(resolveBudgetPolicy(cfg(res.policy)));
    expect(res.policy.capUsd).toBeUndefined();
  });
});

/** A project with one task and priced/unpriced runs against it. */
function seedSpend(opts: { priced?: number; unpriced?: number } = {}): { project: ProjectRow; taskId: string } {
  const project = createProject({ name: "p", repo_path: "/tmp/p" });
  const task = createTask({ name: "t", project_id: project.id });
  createModelConfig({
    name: "priced",
    default_model: "gpt-priced",
    extra_json: JSON.stringify({ cost_per_1m_input: 10, cost_per_1m_output: 30 }),
  });
  if (opts.priced) {
    createRoleRun({ task_id: task.task_id, role_key: "explorer", model: "gpt-priced", tokens: opts.priced });
  }
  if (opts.unpriced) {
    createRoleRun({ task_id: task.task_id, role_key: "explorer", model: "local-llama", tokens: opts.unpriced });
  }
  return { project, taskId: task.task_id };
}

describe("getProjectSpend", () => {
  it("prices known models with the blended rate and counts the rest as tokens only", () => {
    freshDb();
    const { project } = seedSpend({ priced: 1_000_000 });
    const spend = getProjectSpend(project.id, "1970-01-01");
    expect(spend.tokens).toBe(1_000_000);
    // 1M tokens at 85% input ($10/1M) + 15% output ($30/1M) = $13.00.
    expect(spend.usd).toBeCloseTo(13, 6);
    expect(spend.usdIsPartial).toBe(false);
    expect(spend.unpricedTokens).toBe(0);
  });

  it("flags a partial dollar figure instead of silently under-reporting", () => {
    freshDb();
    const { project } = seedSpend({ priced: 1_000_000, unpriced: 4_000_000 });
    const spend = getProjectSpend(project.id, "1970-01-01");
    // Tokens are exact regardless of pricing — that's what makes a token-only
    // budget fully enforceable on a local-model project.
    expect(spend.tokens).toBe(5_000_000);
    expect(spend.usd).toBeCloseTo(13, 6);
    expect(spend.usdIsPartial).toBe(true);
    expect(spend.unpricedTokens).toBe(4_000_000);
  });

  it("counts nothing when every run has no price and reports it as partial", () => {
    freshDb();
    const { project } = seedSpend({ unpriced: 2_000 });
    const spend = getProjectSpend(project.id, "1970-01-01");
    expect(spend.tokens).toBe(2_000);
    expect(spend.usd).toBe(0);
    expect(spend.usdIsPartial).toBe(true);
  });

  it("excludes runs outside the window and other projects' runs", () => {
    freshDb();
    const { project } = seedSpend({ priced: 1_000_000 });
    const other = createProject({ name: "other", repo_path: "/tmp/o" });
    const otherTask = createTask({ name: "ot", project_id: other.id });
    createRoleRun({ task_id: otherTask.task_id, role_key: "explorer", model: "gpt-priced", tokens: 9_000_000 });

    expect(getProjectSpend(project.id, "1970-01-01").tokens).toBe(1_000_000);
    // A window that starts in the future contains nothing.
    const future = new Date(Date.now() + 3_600_000).toISOString();
    expect(getProjectSpend(project.id, future).tokens).toBe(0);
  });
});

function budgeted(project: ProjectRow, policy: Partial<BudgetPolicy>): ProjectRow {
  return updateProject(project.id, { config_json: cfg({ enabled: true, ...policy }) })!;
}

describe("evaluateProjectBudget", () => {
  it("is inert — and never queries spend — for an unbudgeted project", () => {
    freshDb();
    const { project } = seedSpend({ priced: 5_000_000 });
    const status = evaluateProjectBudget(project);
    expect(status.enforced).toBe(false);
    expect(status.overCap).toBe(false);
    expect(status.spend.tokens).toBe(0);
    expect(status.usagePct).toBeNull();
  });

  it("breaches the token cap with no pricing data at all", () => {
    freshDb();
    const { project } = seedSpend({ unpriced: 2_000 });
    const status = evaluateProjectBudget(budgeted(project, { capTokens: 1_000 }));
    expect(status.overCap).toBe(true);
    expect(status.breached).toEqual(["tokens"]);
    expect(status.usagePct).toBeCloseTo(200, 6);
  });

  it("breaches the dollar cap on the priced portion alone", () => {
    freshDb();
    const { project } = seedSpend({ priced: 1_000_000, unpriced: 9_000_000 });
    // $13 of priced spend against a $10 cap — a crossing the floor already
    // proves, so the unpriced remainder can't turn it into a false positive.
    const status = evaluateProjectBudget(budgeted(project, { capUsd: 10 }));
    expect(status.overCap).toBe(true);
    expect(status.breached).toEqual(["usd"]);
    expect(status.spend.usdIsPartial).toBe(true);
  });

  it("warns below the cap without stopping anything", () => {
    freshDb();
    const { project } = seedSpend({ unpriced: 850 });
    const status = evaluateProjectBudget(budgeted(project, { capTokens: 1_000, warnThresholdPct: 80 }));
    expect(status.overCap).toBe(false);
    expect(status.warning).toBe(true);
  });

  it("only counts spend inside the rolling window", () => {
    freshDb();
    const { project } = seedSpend({ unpriced: 5_000 });
    const budgetedProject = budgeted(project, { capTokens: 1_000, periodDays: 30 });
    expect(evaluateProjectBudget(budgetedProject).overCap).toBe(true);
    // Evaluated 60 days later, the same runs have aged out and the ceiling
    // releases on its own — no human action needed.
    const later = new Date(Date.now() + 60 * 24 * 3_600_000);
    expect(evaluateProjectBudget(budgetedProject, later).overCap).toBe(false);
  });
});

describe("warning dedupe", () => {
  it("publishes once per period and re-arms after dropping back below", () => {
    freshDb();
    const { project } = seedSpend({ unpriced: 850 });
    const p = budgeted(project, { capTokens: 1_000, periodDays: 30 });
    const warning = evaluateProjectBudget(p);
    expect(shouldPublishBudgetWarning(p.id, warning)).toBe(true);
    expect(shouldPublishBudgetWarning(p.id, warning)).toBe(false);

    // A status that isn't warning clears the marker, so a project that quiets
    // down and climbs again is warned again rather than staying silent.
    const quiet = { ...warning, warning: false };
    expect(shouldPublishBudgetWarning(p.id, quiet)).toBe(false);
    expect(shouldPublishBudgetWarning(p.id, warning)).toBe(true);
  });

  it("re-warns once the period has elapsed", () => {
    freshDb();
    const { project } = seedSpend({ unpriced: 850 });
    const p = budgeted(project, { capTokens: 1_000, periodDays: 1 });
    const status = evaluateProjectBudget(p);
    expect(shouldPublishBudgetWarning(p.id, status)).toBe(true);
    const later = new Date(Date.now() + 2 * 24 * 3_600_000);
    expect(shouldPublishBudgetWarning(p.id, status, later)).toBe(true);
  });
});

describe("resume_over_budget override", () => {
  it("is bounded — it expires rather than becoming a permanent exemption", () => {
    freshDb();
    const { project, taskId } = seedSpend({ unpriced: 2_000 });
    const policy = resolveBudgetPolicy(cfg({ enabled: true, capTokens: 1_000, overrideMinutes: 60 }));
    void project;

    expect(budgetOverrideActive(taskId)).toBe(false);
    grantBudgetOverride(taskId, policy);
    expect(budgetOverrideActive(taskId)).toBe(true);
    // 61 minutes on, the ceiling reapplies with no further action.
    expect(budgetOverrideActive(taskId, new Date(Date.now() + 61 * 60_000))).toBe(false);
  });

  it("is per-task — overriding one task doesn't exempt its siblings", () => {
    freshDb();
    const project = createProject({ name: "p", repo_path: "/tmp/p" });
    const a = createTask({ name: "a", project_id: project.id });
    const b = createTask({ name: "b", project_id: project.id });
    const policy = resolveBudgetPolicy(cfg({ enabled: true, capTokens: 1 }));
    grantBudgetOverride(a.task_id, policy);
    expect(budgetOverrideActive(a.task_id)).toBe(true);
    expect(budgetOverrideActive(b.task_id)).toBe(false);
    clearBudgetOverride(a.task_id);
    expect(budgetOverrideActive(a.task_id)).toBe(false);
  });

  it("budget_paused_at persists on the task and is distinct from paused", () => {
    freshDb();
    const project = createProject({ name: "p", repo_path: "/tmp/p" });
    const task = createTask({ name: "t", project_id: project.id });
    expect(getTask(task.task_id)?.budget_paused_at).toBeNull();
    updateTask(task.task_id, { budget_paused_at: new Date().toISOString() });
    const after = getTask(task.task_id)!;
    expect(after.budget_paused_at).toBeTruthy();
    // The human pause flag is untouched: the two states must stay tellable apart.
    expect(after.paused ?? 0).toBe(0);
  });
});
