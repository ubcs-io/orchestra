import { afterEach, describe, expect, it } from "vitest";
import {
  closeDb,
  createCandidate,
  createProject,
  createRoleRun,
  createTask,
  getTask,
  listUnseenWatcherTasks,
  markTasksSeen,
  updateCandidate,
  updateTask,
  type ProjectRow,
  type TaskRow,
} from "../src/db";
import { buildMorningReport, renderMorningReport } from "../src/morning-report";
import type { ExecEvidence } from "../src/exec";
import { freshDb, tempGitRepo } from "./helpers";

afterEach(() => closeDb());

function project(): ProjectRow {
  return createProject({ name: "proj", repo_path: tempGitRepo() });
}

function task(p: ProjectRow, over: Partial<Parameters<typeof createTask>[0]> = {}): TaskRow {
  return createTask({
    name: "a task",
    content: "do the thing",
    project_id: p.id,
    stage: "refining",
    level: "task",
    intake_kind: "feature",
    exit_kind: "spec",
    ...over,
  });
}

function greenEvidence(name = "test"): ExecEvidence[] {
  return [
    {
      name,
      argv: ["npm", name],
      exitCode: 0,
      durationMs: 1200,
      outputTail: "ok",
      truncated: false,
      timedOut: false,
      startedAt: new Date().toISOString(),
    },
  ];
}

function run(taskId: string, over: Record<string, unknown> = {}) {
  return createRoleRun({
    task_id: taskId,
    role_key: "developer",
    verdict: "pass",
    summary: "did it",
    output_md: "# report\n\nplenty of prose here to count as real output.",
    depth: 0,
    ...over,
  } as Parameters<typeof createRoleRun>[0]);
}

const HOUR_AGO = () => new Date(Date.now() - 3_600_000);

describe("buildMorningReport", () => {
  it("counts a terminal task with green evidence as done", () => {
    freshDb();
    const p = project();
    const t = task(p, { stage: "ready" });
    updateTask(t.task_id, { stage: "ready" });
    run(t.task_id, { evidence_json: JSON.stringify(greenEvidence()) });

    const report = buildMorningReport(p, HOUR_AGO());
    expect(report.completed).toHaveLength(1);
    expect(report.parked).toHaveLength(0);
    expect(report.completed[0]!.evidenceAllGreen).toBe(true);
    expect(report.completed[0]!.latestHealth).toBe("verified");
  });

  it("does NOT count a terminal task as done when its last run was degraded", () => {
    freshDb();
    const p = project();
    const t = task(p, { stage: "ready" });
    updateTask(t.task_id, { stage: "ready" });
    // fallback verdict = synthesized after every recovery failed → degraded.
    run(t.task_id, { verdict_source: "fallback", fallback: 1 });

    const report = buildMorningReport(p, HOUR_AGO());
    expect(report.completed).toHaveLength(0);
    expect(report.parked).toHaveLength(1);
    expect(report.parked[0]!.latestHealth).toBe("degraded");
    expect(report.parked[0]!.reason).toContain("synthesized");
  });

  it("parks a task sitting in review with its review reason", () => {
    freshDb();
    const p = project();
    const t = task(p);
    updateTask(t.task_id, { stage: "review", review_reason: "needs a human decision on the API shape" });
    run(t.task_id);

    const report = buildMorningReport(p, HOUR_AGO());
    expect(report.parked[0]!.reason).toBe("needs a human decision on the API shape");
    expect(report.completed).toHaveLength(0);
  });

  it("puts a mid-pipeline task in progress, not done or parked", () => {
    freshDb();
    const p = project();
    const t = task(p);
    run(t.task_id);
    const report = buildMorningReport(p, HOUR_AGO());
    expect(report.inProgress).toHaveLength(1);
    expect(report.completed).toHaveLength(0);
    expect(report.parked).toHaveLength(0);
  });

  it("excludes runs from before the window", () => {
    freshDb();
    const p = project();
    const t = task(p);
    run(t.task_id);
    // A window starting in the future contains nothing.
    const report = buildMorningReport(p, new Date(Date.now() + 60_000));
    expect(report.runCount).toBe(0);
    expect(report.inProgress).toHaveLength(0);
  });

  it("sums tokens and tallies health across every run in the window", () => {
    freshDb();
    const p = project();
    const t = task(p);
    run(t.task_id, { tokens: 1000, evidence_json: JSON.stringify(greenEvidence()) }); // verified
    run(t.task_id, { tokens: 500, stop_reason: "length" }); // degraded

    const report = buildMorningReport(p, HOUR_AGO());
    expect(report.runCount).toBe(2);
    expect(report.tokensUsed).toBe(1500);
    expect(report.healthCounts.verified).toBe(1);
    expect(report.healthCounts.degraded).toBe(1);
  });

  it("summarizes watcher activity by status, ignoring candidates older than the window", () => {
    freshDb();
    const p = project();
    const queued = createCandidate({
      project_id: p.id,
      watcher: "todo-scan",
      kind: "chore",
      fingerprint: "fp1",
      payload_json: "{}",
    });
    updateCandidate(queued.id, { status: "queued" });
    const rejected = createCandidate({
      project_id: p.id,
      watcher: "todo-scan",
      kind: "chore",
      fingerprint: "fp2",
      payload_json: "{}",
    });
    updateCandidate(rejected.id, { status: "rejected" });

    const report = buildMorningReport(p, HOUR_AGO());
    expect(report.watcherActivity).toEqual([
      { watcher: "todo-scan", queued: 1, rejected: 1, capped: 0, suppressed: 0 },
    ]);

    const future = buildMorningReport(p, new Date(Date.now() + 60_000));
    expect(future.watcherActivity).toEqual([]);
  });

  it("reports how many self-generated tasks are still unseen", () => {
    freshDb();
    const p = project();
    task(p, { origin: "watcher:test-suite" });
    task(p, { origin: "watcher:todo-scan" });
    task(p, { origin: "human" });

    expect(buildMorningReport(p, HOUR_AGO()).unseenCount).toBe(2);
  });
});

describe("renderMorningReport", () => {
  it("names the evidence when work is done, and says so plainly when there is none", () => {
    freshDb();
    const p = project();
    const verified = task(p, { name: "verified work" });
    updateTask(verified.task_id, { stage: "ready" });
    run(verified.task_id, { evidence_json: JSON.stringify(greenEvidence()) });

    const md = renderMorningReport(buildMorningReport(p, HOUR_AGO()));
    expect(md).toContain("# Morning report — proj");
    expect(md).toContain("## Done (1)");
    expect(md).toContain("1 of these carry green harness-recorded command runs.");
    expect(md).toContain("exit 0 ✓");
  });

  it("refuses to dress up an unverified result", () => {
    freshDb();
    const p = project();
    const t = task(p, { name: "opinion only" });
    updateTask(t.task_id, { stage: "ready" });
    run(t.task_id); // healthy, but no evidence

    const md = renderMorningReport(buildMorningReport(p, HOUR_AGO()));
    expect(md).toContain("_None of these carry executed evidence — they are opinions, not verified results._");
  });

  it("flags a degraded batch as a model/endpoint problem", () => {
    freshDb();
    const p = project();
    const t = task(p);
    run(t.task_id, { verdict_source: "fallback", fallback: 1 });
    run(t.task_id, { verdict_source: "fallback", fallback: 1, output_md: null, artifact_bytes: 0 });

    const md = renderMorningReport(buildMorningReport(p, HOUR_AGO()));
    expect(md).toContain("2 runs produced degraded or empty output");
  });

  it("says nothing ran when nothing ran", () => {
    freshDb();
    const p = project();
    expect(renderMorningReport(buildMorningReport(p, HOUR_AGO()))).toContain("Nothing ran in this window.");
  });
});

describe("seen flag", () => {
  it("lists only unseen watcher-origin tasks", () => {
    freshDb();
    const p = project();
    const watcherTask = task(p, { origin: "watcher:test-suite" });
    task(p, { origin: "human" });

    expect(listUnseenWatcherTasks(p.id).map((t) => t.task_id)).toEqual([watcherTask.task_id]);
    markTasksSeen([watcherTask.task_id]);
    expect(listUnseenWatcherTasks(p.id)).toEqual([]);
  });

  it("is first-write-wins — re-marking never moves the timestamp", async () => {
    freshDb();
    const p = project();
    const t = task(p, { origin: "watcher:test-suite" });
    markTasksSeen([t.task_id]);
    const firstSeenAt = getTask(t.task_id)!.seen_at;
    expect(firstSeenAt).toBeTruthy();

    await new Promise((r) => setTimeout(r, 1100)); // seen_at has second granularity
    markTasksSeen([t.task_id]);
    expect(getTask(t.task_id)!.seen_at).toBe(firstSeenAt);
  }, 10000);

  it("ignores an empty id list", () => {
    freshDb();
    expect(() => markTasksSeen([])).not.toThrow();
  });
});
