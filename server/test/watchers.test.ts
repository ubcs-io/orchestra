import { afterEach, describe, expect, it } from "vitest";
import {
  closeDb,
  createCandidate,
  createProject,
  createTask,
  getCandidate,
  getTask,
  listCandidates,
  updateCandidate,
} from "../src/db";
import type { ExecEvidence } from "../src/exec";
import { resetRouterFns, setTriageFn } from "../src/router";
import {
  getOrResetIdleWindowBudget,
  recordAutonomousTaskStart,
  resetHumanActivityClock,
  resolveAutonomyConfig,
} from "../src/autonomy";
import {
  abortWatcherScan,
  computeFingerprint,
  confirmOrDeferFingerprint,
  extractFailingTestIds,
  runTestSuiteWatcher,
  tickWatchers,
  triageAndMaybeQueue,
} from "../src/watchers";
import { freshDb, tempGitRepo } from "./helpers";

afterEach(() => {
  closeDb();
  resetRouterFns();
});

function fakeEvidence(over: Partial<ExecEvidence> = {}): ExecEvidence {
  return {
    name: "test",
    argv: ["npm", "test"],
    exitCode: 1,
    signal: null,
    durationMs: 10,
    outputTail: "",
    truncated: false,
    timedOut: false,
    startedAt: new Date().toISOString(),
    ...over,
  };
}

describe("extractFailingTestIds", () => {
  it("extracts vitest-style FAIL lines with the file when recognizable", () => {
    const out = "some noise\n FAIL  server/test/foo.test.ts > suite > does a thing\nmore noise\n";
    const ids = extractFailingTestIds(out);
    expect(ids).toHaveLength(1);
    expect(ids[0].name).toContain("does a thing");
    expect(ids[0].file).toBe("server/test/foo.test.ts");
  });

  it("returns no ids for unrecognized output", () => {
    expect(extractFailingTestIds("nothing interesting here")).toEqual([]);
  });

  it("dedupes repeated identical failing lines", () => {
    const out = " FAIL  a.test.ts > x\n FAIL  a.test.ts > x\n";
    expect(extractFailingTestIds(out)).toHaveLength(1);
  });
});

describe("computeFingerprint", () => {
  it("is stable regardless of failing-id order", () => {
    const a = fakeEvidence({ outputTail: " FAIL  a.test.ts > one\n FAIL  b.test.ts > two\n" });
    const b = fakeEvidence({ outputTail: " FAIL  b.test.ts > two\n FAIL  a.test.ts > one\n" });
    expect(computeFingerprint(a)).toBe(computeFingerprint(b));
  });

  it("differs for different failure sets", () => {
    const a = fakeEvidence({ outputTail: " FAIL  a.test.ts > one\n" });
    const b = fakeEvidence({ outputTail: " FAIL  a.test.ts > two\n" });
    expect(computeFingerprint(a)).not.toBe(computeFingerprint(b));
  });

  it("falls back to whole-output hashing when no ids are extractable", () => {
    const a = fakeEvidence({ outputTail: "raw unrecognized failure text" });
    const b = fakeEvidence({ outputTail: "raw unrecognized failure text" });
    const c = fakeEvidence({ outputTail: "different raw text" });
    expect(computeFingerprint(a)).toBe(computeFingerprint(b));
    expect(computeFingerprint(a)).not.toBe(computeFingerprint(c));
  });
});

describe("confirmOrDeferFingerprint", () => {
  it("defers on first sighting, confirms on the second identical one", () => {
    freshDb();
    const project = createProject({ name: "p", repo_path: "/tmp/x" });
    const red = fakeEvidence({ exitCode: 1, outputTail: " FAIL  a.test.ts > x\n" });
    expect(confirmOrDeferFingerprint(project.id, "test", red)).toBeNull();
    expect(confirmOrDeferFingerprint(project.id, "test", red)).not.toBeNull();
  });

  it("a green run clears the pending marker, restarting the two-in-a-row count", () => {
    freshDb();
    const project = createProject({ name: "p", repo_path: "/tmp/x" });
    const red = fakeEvidence({ exitCode: 1, outputTail: " FAIL  a.test.ts > x\n" });
    const green = fakeEvidence({ exitCode: 0, outputTail: "" });
    expect(confirmOrDeferFingerprint(project.id, "test", red)).toBeNull();
    expect(confirmOrDeferFingerprint(project.id, "test", green)).toBeNull();
    expect(confirmOrDeferFingerprint(project.id, "test", red)).toBeNull(); // back to "first sighting"
  });

  it("a different red fingerprint replaces the pending marker instead of confirming", () => {
    freshDb();
    const project = createProject({ name: "p", repo_path: "/tmp/x" });
    const redA = fakeEvidence({ exitCode: 1, outputTail: " FAIL  a.test.ts > x\n" });
    const redB = fakeEvidence({ exitCode: 1, outputTail: " FAIL  b.test.ts > y\n" });
    expect(confirmOrDeferFingerprint(project.id, "test", redA)).toBeNull();
    expect(confirmOrDeferFingerprint(project.id, "test", redB)).toBeNull(); // different fp, restarts
    expect(confirmOrDeferFingerprint(project.id, "test", redB)).not.toBeNull(); // now confirmed
  });
});

describe("runTestSuiteWatcher", () => {
  it("returns no candidates when every configured command is green", async () => {
    freshDb();
    const repo = tempGitRepo();
    const project = createProject({
      name: "p",
      repo_path: repo,
      config_json: JSON.stringify({
        harness: {
          allowExec: true,
          execAllowlist: [
            { name: "test", argv: ["node", "-e", "process.exit(0)"] },
            { name: "typecheck", argv: ["node", "-e", "process.exit(0)"] },
          ],
        },
      }),
    });
    const found = await runTestSuiteWatcher(project, {
      name: "test-suite",
      enabled: true,
      cadenceMinutes: 60,
      perWatcherDailyCap: 2,
    });
    expect(found).toEqual([]);
  });

  it("proposes a candidate only once the same failure is confirmed on a second scan", async () => {
    freshDb();
    const repo = tempGitRepo();
    const project = createProject({
      name: "p",
      repo_path: repo,
      config_json: JSON.stringify({
        harness: { allowExec: true, execAllowlist: [{ name: "test", argv: ["node", "-e", "process.exit(1)"] }] },
      }),
    });
    const wc = { name: "test-suite", enabled: true, cadenceMinutes: 60, perWatcherDailyCap: 2, commands: ["test"] };
    const first = await runTestSuiteWatcher(project, wc);
    expect(first).toEqual([]);
    const second = await runTestSuiteWatcher(project, wc);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ watcher: "test-suite", kind: "error_file" });
  }, 15000);

  it("skips a configured command name with nothing in the exec allowlist, rather than erroring", async () => {
    freshDb();
    const repo = tempGitRepo();
    const project = createProject({
      name: "p",
      repo_path: repo,
      config_json: JSON.stringify({ harness: { allowExec: true, execAllowlist: [] } }),
    });
    const found = await runTestSuiteWatcher(project, {
      name: "test-suite",
      enabled: true,
      cadenceMinutes: 60,
      perWatcherDailyCap: 2,
    });
    expect(found).toEqual([]);
  });
});

describe("triageAndMaybeQueue", () => {
  it("caps at autoQueueDepth without ever calling triage", async () => {
    freshDb();
    const project = createProject({
      name: "p",
      repo_path: tempGitRepo(),
      config_json: JSON.stringify({ router: { enabled: true, candidateTriage: true }, autonomy: { autoQueueDepth: 2 } }),
    });
    for (let i = 0; i < 2; i++) {
      createTask({ name: `t${i}`, project_id: project.id, origin: "watcher:test-suite", stage: "refining" });
    }
    setTriageFn(async () => {
      throw new Error("triage should not be called once the queue depth cap is hit");
    });
    const cand = createCandidate({
      project_id: project.id,
      watcher: "test-suite",
      kind: "error_file",
      fingerprint: "fp-cap",
      payload_json: "{}",
    });
    await triageAndMaybeQueue(project, cand, resolveAutonomyConfig(project.config_json));
    expect(getCandidate(cand.id)?.status).toBe("capped");
  });

  it("caps at the per-watcher daily limit", async () => {
    freshDb();
    const project = createProject({
      name: "p",
      repo_path: tempGitRepo(),
      config_json: JSON.stringify({ router: { enabled: true, candidateTriage: true } }),
    });
    for (let i = 0; i < 2; i++) {
      const c = createCandidate({
        project_id: project.id,
        watcher: "test-suite",
        kind: "error_file",
        fingerprint: `fp-daily-${i}`,
        payload_json: "{}",
      });
      updateCandidate(c.id, { status: "queued" }); // default perWatcherDailyCap is 2
    }
    const cand = createCandidate({
      project_id: project.id,
      watcher: "test-suite",
      kind: "error_file",
      fingerprint: "fp-new",
      payload_json: "{}",
    });
    await triageAndMaybeQueue(project, cand, resolveAutonomyConfig(project.config_json));
    expect(getCandidate(cand.id)?.status).toBe("capped");
  });

  it("fails toward NOT queuing when candidate triage is disabled for the project", async () => {
    freshDb();
    const project = createProject({
      name: "p",
      repo_path: tempGitRepo(),
      config_json: JSON.stringify({ router: { enabled: false } }),
    });
    const cand = createCandidate({
      project_id: project.id,
      watcher: "test-suite",
      kind: "error_file",
      fingerprint: "fp-disabled",
      payload_json: "{}",
    });
    await triageAndMaybeQueue(project, cand, resolveAutonomyConfig(project.config_json));
    const updated = getCandidate(cand.id)!;
    expect(updated.status).toBe("rejected");
    expect(JSON.parse(updated.triage_json!).worth_doing).toBe(false);
    expect(updated.task_id).toBeNull();
  });

  it("materializes a task and links it back when triage approves", async () => {
    freshDb();
    const project = createProject({
      name: "p",
      repo_path: tempGitRepo(),
      config_json: JSON.stringify({ router: { enabled: true, candidateTriage: true } }),
    });
    setTriageFn(async () => ({ worth_doing: true, priority: 5, rationale: "yes", suggested_kind: "error_file" }));
    const cand = createCandidate({
      project_id: project.id,
      watcher: "test-suite",
      kind: "error_file",
      fingerprint: "fp-approve",
      payload_json: JSON.stringify({ renderedContent: "# hi", outputTail: "hi" }),
    });
    await triageAndMaybeQueue(project, cand, resolveAutonomyConfig(project.config_json));
    const updated = getCandidate(cand.id)!;
    expect(updated.status).toBe("queued");
    expect(updated.task_id).not.toBeNull();
    const task = getTask(updated.task_id!);
    expect(task?.origin).toBe("watcher:test-suite");
    expect(task?.priority).toBe(5);
  });

  it("rejects and creates no task when triage says not worth doing", async () => {
    freshDb();
    const project = createProject({
      name: "p",
      repo_path: tempGitRepo(),
      config_json: JSON.stringify({ router: { enabled: true, candidateTriage: true } }),
    });
    setTriageFn(async () => ({ worth_doing: false, priority: 2, rationale: "meh", suggested_kind: "error_file" }));
    const cand = createCandidate({
      project_id: project.id,
      watcher: "test-suite",
      kind: "error_file",
      fingerprint: "fp-reject",
      payload_json: "{}",
    });
    await triageAndMaybeQueue(project, cand, resolveAutonomyConfig(project.config_json));
    const updated = getCandidate(cand.id)!;
    expect(updated.status).toBe("rejected");
    expect(updated.task_id).toBeNull();
  });
});

describe("tickWatchers gating", () => {
  it("does nothing when autonomy is disabled for every project", async () => {
    freshDb();
    createProject({ name: "p", repo_path: "/nonexistent", config_json: JSON.stringify({ autonomy: { enabled: false } }) });
    await expect(tickWatchers()).resolves.toBe(false);
  });

  it("does nothing once the idle-window budget is already exhausted", async () => {
    freshDb();
    const project = createProject({
      name: "p",
      repo_path: "/nonexistent",
      config_json: JSON.stringify({
        autonomy: { enabled: true, idleAfterMinutes: 0, budgets: { maxTaskStarts: 1, maxTokens: 1_000_000, maxExecRuns: 100 } },
      }),
    });
    resetHumanActivityClock();
    getOrResetIdleWindowBudget(project.id, resolveAutonomyConfig(project.config_json)); // opens the window
    recordAutonomousTaskStart(project.id);
    await expect(tickWatchers()).resolves.toBe(false);
  });

  it("end-to-end: defers on first scan, queues on second, never duplicates on a third", async () => {
    freshDb();
    const repo = tempGitRepo();
    const project = createProject({
      name: "p",
      repo_path: repo,
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
    setTriageFn(async () => ({ worth_doing: true, priority: 4, rationale: "yes", suggested_kind: "error_file" }));

    expect(await tickWatchers()).toBe(true);
    expect(listCandidates({ projectId: project.id })).toHaveLength(0); // flake-guard deferred

    expect(await tickWatchers()).toBe(true);
    const afterSecond = listCandidates({ projectId: project.id });
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0]?.status).toBe("queued");
    expect(afterSecond[0]?.task_id).not.toBeNull();

    expect(await tickWatchers()).toBe(true); // still "did work" (ran a scan) but...
    expect(listCandidates({ projectId: project.id })).toHaveLength(1); // ...no duplicate candidate/task
  }, 15000);

  it("abortWatcherScan halts a hung scan without waiting for the process to exit on its own", async () => {
    freshDb();
    const repo = tempGitRepo();
    const project = createProject({
      name: "p",
      repo_path: repo,
      config_json: JSON.stringify({
        harness: {
          allowExec: true,
          execTimeoutMs: 60_000,
          execAllowlist: [{ name: "test", argv: ["node", "-e", "setTimeout(() => {}, 60000)"] }],
        },
        autonomy: {
          enabled: true,
          idleAfterMinutes: 0,
          watchers: [{ name: "test-suite", enabled: true, cadenceMinutes: 0, perWatcherDailyCap: 5, commands: ["test"] }],
        },
      }),
    });
    resetHumanActivityClock();
    const start = Date.now();
    const tickPromise = tickWatchers();
    await new Promise((resolve) => setTimeout(resolve, 300)); // let the scan actually spawn
    abortWatcherScan(project.id);
    await tickPromise;
    expect(Date.now() - start).toBeLessThan(10_000); // well under the 60s hang/timeout
  }, 15000);
});
