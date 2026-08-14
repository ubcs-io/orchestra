import { afterEach, describe, expect, it } from "vitest";
import { closeDb, createProject } from "../src/db";
import {
  DEFAULT_AUTONOMY_CONFIG,
  getOrResetIdleWindowBudget,
  isWithinActiveHours,
  recordAutonomousExecRun,
  recordAutonomousTaskStart,
  recordHumanActivity,
  resetHumanActivityClock,
  resolveAutonomyConfig,
  validateAutonomyConfig,
  type ActiveHours,
  type AutonomyConfig,
} from "../src/autonomy";
import { freshDb } from "./helpers";

afterEach(() => closeDb());

const cfg = (autonomy: unknown): string => JSON.stringify({ autonomy });

describe("resolveAutonomyConfig", () => {
  it("defaults to fully inert (enabled: false) for every existing project", () => {
    for (const input of [null, "", "not json", "{}", cfg(undefined)]) {
      const c = resolveAutonomyConfig(input);
      expect(c.enabled, String(input)).toBe(false);
      expect(c.activeHours, String(input)).toBeNull();
    }
  });

  it("merges a project's autonomy overrides over the defaults", () => {
    const c = resolveAutonomyConfig(cfg({ enabled: true, autoQueueDepth: 2 }));
    expect(c.enabled).toBe(true);
    expect(c.autoQueueDepth).toBe(2);
    expect(c.idleAfterMinutes).toBe(DEFAULT_AUTONOMY_CONFIG.idleAfterMinutes);
  });

  it("clamps out-of-range numeric knobs and falls back on nonsense", () => {
    const c = resolveAutonomyConfig(
      cfg({ idleAfterMinutes: 999_999, autoQueueDepth: -5, budgets: { maxTaskStarts: "lots" } }),
    );
    expect(c.idleAfterMinutes).toBe(1440);
    expect(c.autoQueueDepth).toBe(0);
    expect(c.budgets.maxTaskStarts).toBe(DEFAULT_AUTONOMY_CONFIG.budgets.maxTaskStarts);
  });

  it("drops a malformed activeHours shape rather than surfacing it to the scheduler", () => {
    expect(resolveAutonomyConfig(cfg({ activeHours: { start: "25:99", end: "07:00" } })).activeHours).toBeNull();
    expect(resolveAutonomyConfig(cfg({ activeHours: "always" })).activeHours).toBeNull();
    const c = resolveAutonomyConfig(cfg({ activeHours: { start: "22:00", end: "07:00", weekendsAllDay: true } }));
    expect(c.activeHours).toEqual({ start: "22:00", end: "07:00", weekendsAllDay: true });
  });

  it("drops malformed watcher entries and falls back to the default watcher list when none survive", () => {
    const c = resolveAutonomyConfig(
      cfg({ watchers: [{ name: "" }, "not an object", { name: "test-suite", enabled: true, cadenceMinutes: 30, perWatcherDailyCap: 1 }] }),
    );
    expect(c.watchers).toHaveLength(1);
    expect(c.watchers[0]).toMatchObject({ name: "test-suite", enabled: true, cadenceMinutes: 30, perWatcherDailyCap: 1 });

    const empty = resolveAutonomyConfig(cfg({ watchers: ["garbage", { name: "" }] }));
    expect(empty.watchers).toEqual(DEFAULT_AUTONOMY_CONFIG.watchers);
  });

  it("drops duplicate watcher names, keeping the first", () => {
    const c = resolveAutonomyConfig(
      cfg({
        watchers: [
          { name: "test-suite", enabled: true, cadenceMinutes: 10, perWatcherDailyCap: 1 },
          { name: "test-suite", enabled: false, cadenceMinutes: 999, perWatcherDailyCap: 9 },
        ],
      }),
    );
    expect(c.watchers).toHaveLength(1);
    expect(c.watchers[0]).toMatchObject({ enabled: true, cadenceMinutes: 10 });
  });
});

describe("validateAutonomyConfig", () => {
  it("rejects a non-object body", () => {
    expect(validateAutonomyConfig(null).ok).toBe(false);
    expect(validateAutonomyConfig("nope").ok).toBe(false);
    expect(validateAutonomyConfig([1, 2]).ok).toBe(false);
  });

  it("rejects a malformed activeHours shape with a reportable error", () => {
    const res = validateAutonomyConfig({ activeHours: { start: "bad", end: "07:00" } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/activeHours/);
  });

  it("rejects a non-array watchers field and duplicate watcher names", () => {
    expect(validateAutonomyConfig({ watchers: "nope" }).ok).toBe(false);
    const dup = validateAutonomyConfig({
      watchers: [
        { name: "test-suite", enabled: true, cadenceMinutes: 10, perWatcherDailyCap: 1 },
        { name: "test-suite", enabled: true, cadenceMinutes: 10, perWatcherDailyCap: 1 },
      ],
    });
    expect(dup.ok).toBe(false);
  });

  it("rejects a non-object budgets field", () => {
    expect(validateAutonomyConfig({ budgets: "nope" }).ok).toBe(false);
  });

  it("accepts and round-trips a valid config through resolveAutonomyConfig", () => {
    const res = validateAutonomyConfig({
      enabled: true,
      activeHours: { start: "22:00", end: "07:00", weekendsAllDay: true },
      idleAfterMinutes: 15,
      autoQueueDepth: 3,
      budgets: { maxTaskStarts: 5, maxTokens: 100_000, maxExecRuns: 20 },
      watchers: [{ name: "test-suite", enabled: true, cadenceMinutes: 45, perWatcherDailyCap: 1 }],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.enabled).toBe(true);
      expect(res.config.activeHours).toEqual({ start: "22:00", end: "07:00", weekendsAllDay: true });
      expect(res.config.idleAfterMinutes).toBe(15);
    }
  });
});

describe("isWithinActiveHours", () => {
  const at = (hh: number, mm: number, day: number): Date => {
    // A fixed reference week: 2024-01-01 is a Monday (day 1).
    const d = new Date(2024, 0, 1 + ((day - 1 + 7) % 7), hh, mm, 0, 0);
    return d;
  };

  it("is always active when no schedule is set", () => {
    expect(isWithinActiveHours(null, at(3, 0, 3))).toBe(true);
  });

  it("handles a same-day window", () => {
    const hours: ActiveHours = { start: "09:00", end: "17:00", weekendsAllDay: false };
    expect(isWithinActiveHours(hours, at(12, 0, 3))).toBe(true);
    expect(isWithinActiveHours(hours, at(8, 59, 3))).toBe(false);
    expect(isWithinActiveHours(hours, at(17, 0, 3))).toBe(false); // end exclusive
  });

  it("handles a window crossing midnight", () => {
    const hours: ActiveHours = { start: "22:00", end: "07:00", weekendsAllDay: false };
    expect(isWithinActiveHours(hours, at(23, 30, 3))).toBe(true);
    expect(isWithinActiveHours(hours, at(3, 0, 3))).toBe(true);
    expect(isWithinActiveHours(hours, at(12, 0, 3))).toBe(false);
  });

  it("weekendsAllDay overrides the window on Saturday/Sunday", () => {
    const hours: ActiveHours = { start: "09:00", end: "17:00", weekendsAllDay: true };
    // day 6 = Saturday, day 0 = Sunday, per JS Date.getDay()
    expect(isWithinActiveHours(hours, at(3, 0, 6))).toBe(true);
    expect(isWithinActiveHours(hours, at(3, 0, 0))).toBe(true);
    expect(isWithinActiveHours(hours, at(3, 0, 3))).toBe(false); // Wednesday, outside window
  });
});

describe("getOrResetIdleWindowBudget", () => {
  function baseCfg(over: Partial<AutonomyConfig> = {}): AutonomyConfig {
    return { ...DEFAULT_AUTONOMY_CONFIG, idleAfterMinutes: 0, ...over };
  }

  it("reports no window while a human is active, clearing any prior counters", () => {
    freshDb();
    const project = createProject({ name: "p", repo_path: "/tmp/p" });
    recordHumanActivity();
    const status = getOrResetIdleWindowBudget(project.id, baseCfg({ idleAfterMinutes: 60 }));
    expect(status.windowStartedAt).toBeNull();
    expect(status.exhausted).toBe(false);
    expect(status.consumed).toEqual({ taskStarts: 0, execRuns: 0, tokens: 0 });
  });

  it("starts a fresh window once idle, and is not exhausted before any budget is hit", () => {
    freshDb();
    const project = createProject({ name: "p", repo_path: "/tmp/p" });
    resetHumanActivityClock();
    // idleAfterMinutes: 0 -> immediately "idle" for this test.
    const status = getOrResetIdleWindowBudget(project.id, baseCfg());
    expect(status.windowStartedAt).not.toBeNull();
    expect(status.exhausted).toBe(false);
  });

  it("becomes exhausted once maxTaskStarts is reached", () => {
    freshDb();
    const project = createProject({ name: "p", repo_path: "/tmp/p" });
    resetHumanActivityClock();
    const cfg2 = baseCfg({ budgets: { maxTaskStarts: 2, maxTokens: 1_000_000, maxExecRuns: 100 } });
    getOrResetIdleWindowBudget(project.id, cfg2); // opens the window
    recordAutonomousTaskStart(project.id);
    expect(getOrResetIdleWindowBudget(project.id, cfg2).exhausted).toBe(false);
    recordAutonomousTaskStart(project.id);
    expect(getOrResetIdleWindowBudget(project.id, cfg2).exhausted).toBe(true);
  });

  it("becomes exhausted once maxExecRuns is reached", () => {
    freshDb();
    const project = createProject({ name: "p", repo_path: "/tmp/p" });
    resetHumanActivityClock();
    const cfg2 = baseCfg({ budgets: { maxTaskStarts: 100, maxTokens: 1_000_000, maxExecRuns: 1 } });
    getOrResetIdleWindowBudget(project.id, cfg2);
    recordAutonomousExecRun(project.id);
    expect(getOrResetIdleWindowBudget(project.id, cfg2).exhausted).toBe(true);
  });

  it("resets counters when a new idle window begins after human activity resumes", () => {
    freshDb();
    const project = createProject({ name: "p", repo_path: "/tmp/p" });
    resetHumanActivityClock();
    const cfg2 = baseCfg({ budgets: { maxTaskStarts: 1, maxTokens: 1_000_000, maxExecRuns: 100 } });
    getOrResetIdleWindowBudget(project.id, cfg2);
    recordAutonomousTaskStart(project.id);
    expect(getOrResetIdleWindowBudget(project.id, cfg2).exhausted).toBe(true);

    // Human shows up (idleAfterMinutes: 0 config means "active" requires us to
    // simulate via a config with a real idleAfterMinutes so msSinceHumanActivity()
    // reads as "not idle" immediately after recordHumanActivity()).
    recordHumanActivity();
    const activeStatus = getOrResetIdleWindowBudget(project.id, baseCfg({ idleAfterMinutes: 60 }));
    expect(activeStatus.windowStartedAt).toBeNull();

    // New idle stretch begins -> fresh window, counters back to zero.
    resetHumanActivityClock();
    const fresh = getOrResetIdleWindowBudget(project.id, cfg2);
    expect(fresh.exhausted).toBe(false);
    expect(fresh.consumed.taskStarts).toBe(0);
  });
});

describe("selfMaintenance config", () => {
  it("defaults every flag on — the parent kill-switch is what ships off", () => {
    const c = resolveAutonomyConfig(null);
    expect(c.selfMaintenance).toEqual({
      enabled: true,
      reprobeModels: true,
      backfillDigests: true,
      reapWorkspaces: true,
    });
  });

  it("honours individually-disabled sub-flags and ignores non-boolean junk", () => {
    const c = resolveAutonomyConfig(cfg({ selfMaintenance: { reprobeModels: false, backfillDigests: "yes" } }));
    expect(c.selfMaintenance.reprobeModels).toBe(false);
    expect(c.selfMaintenance.backfillDigests).toBe(true); // junk → default, never coerced
    expect(c.selfMaintenance.enabled).toBe(true);
  });

  it("rejects a non-object selfMaintenance at save time with a reportable error", () => {
    const result = validateAutonomyConfig({ selfMaintenance: [] });
    expect(result.ok).toBe(false);
  });
});

describe("watcher config", () => {
  it("ships all six watchers, with only test-suite enabled", () => {
    const c = resolveAutonomyConfig(null);
    expect(c.watchers.map((w) => w.name)).toEqual([
      "test-suite",
      "todo-scan",
      "branch-triage",
      "doc-drift",
      "lint-drift",
      "dep-staleness",
    ]);
    expect(c.watchers.filter((w) => w.enabled).map((w) => w.name)).toEqual(["test-suite"]);
  });

  it("clamps thresholdDays and leaves it undefined when unset", () => {
    const c = resolveAutonomyConfig(
      cfg({
        watchers: [
          { name: "todo-scan", enabled: true, thresholdDays: -10 },
          { name: "doc-drift", enabled: true },
        ],
      }),
    );
    expect(c.watchers[0]!.thresholdDays).toBe(0);
    expect(c.watchers[1]!.thresholdDays).toBeUndefined();
  });

  it("a resolved config is fully detached from the shared defaults", () => {
    const a = resolveAutonomyConfig(null);
    a.watchers[0]!.enabled = false;
    a.selfMaintenance.enabled = false;
    a.budgets.maxTaskStarts = 1;
    const b = resolveAutonomyConfig(null);
    expect(b.watchers[0]!.enabled).toBe(true);
    expect(b.selfMaintenance.enabled).toBe(true);
    expect(b.budgets.maxTaskStarts).toBe(DEFAULT_AUTONOMY_CONFIG.budgets.maxTaskStarts);
  });
});
