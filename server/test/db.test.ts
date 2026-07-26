import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { resetConfig } from "../src/config";
import {
  closeDb,
  countCandidatesQueuedToday,
  countGlobalRoles,
  countOpenWatcherTasks,
  createCandidate,
  createIntervention,
  createProject,
  createRoleRun,
  createTask,
  deleteModelProfileRow,
  familyMembersExcluding,
  familyRootId,
  findLatestCandidateByFingerprint,
  getCandidate,
  getDb,
  getGlobalConfig,
  getModelLiveStats,
  getModelProfileRow,
  getProject,
  getTask,
  initDb,
  getHealthStats,
  getTaskHealthSummaries,
  listCandidates,
  listModelProfileRows,
  listRoleRuns,
  listRoles,
  listTasks,
  listUnconsumedInterventions,
  markInterventionConsumed,
  suppressCandidateForTask,
  sumAutonomousTokensSince,
  updateCandidate,
  updateProject,
  updateTask,
  upsertConfig,
  upsertModelProfileRow,
  upsertRole,
} from "../src/db";
import { resolveConnection } from "../src/settings";
import { freshDb } from "./helpers";

afterEach(() => closeDb());

describe("schema init", () => {
  it("creates all tables and is idempotent", () => {
    freshDb();
    initDb(); // second call must not throw
    const tables = (getDb().prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
      .map((r) => r.name)
      .sort();
    expect(tables).toEqual(expect.arrayContaining(["interventions", "projects", "role_runs", "roles", "tasks"]));
  });

  it("migrates a legacy Python-schema DB in place, preserving rows", () => {
    // Build a DB that only has the original db.py tasks columns + one row.
    const dir = fs.mkdtempSync(path.join(tmpdir(), "orch-legacy-"));
    const dbPath = path.join(dir, "legacy.db");
    const legacy = new Database(dbPath);
    legacy.exec(`CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT UNIQUE, name TEXT,
      status TEXT, model TEXT, workspace TEXT, content TEXT, acceptance_criteria TEXT,
      completion_criteria TEXT, response TEXT, failure_reason TEXT, parent_task_id TEXT,
      task_type TEXT, step_number INTEGER, created_at TEXT, updated_at TEXT);`);
    legacy.prepare("INSERT INTO tasks (task_id, name, status) VALUES (?,?,?)").run("legacy1", "old task", "pending");
    legacy.close();

    process.env.ORCHESTRA_DB_PATH = dbPath;
    resetConfig();
    closeDb();
    initDb();

    const cols = (getDb().prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["project_id", "stage", "level", "exit_kind", "coverage_json", "paused"]));
    const row = getTask("legacy1");
    expect(row?.name).toBe("old task");
    expect(row?.stage).toBeNull(); // new column, unset on legacy row
  });
});

describe("projects CRUD", () => {
  it("round-trips create/get/update", () => {
    freshDb();
    const p = createProject({ name: "svc", repo_path: "/tmp/svc" });
    expect(getProject(p.id)?.name).toBe("svc");
    const updated = updateProject(p.id, { name: "renamed" });
    expect(updated?.name).toBe("renamed");
  });

  it("update whitelist ignores unknown columns", () => {
    freshDb();
    const p = createProject({ name: "svc", repo_path: "/tmp/svc" });
    updateProject(p.id, { name: "ok", nonsense: "DROP", repo_path: "/tmp/moved" } as never);
    const after = getProject(p.id)!;
    expect(after.name).toBe("ok");
    expect(after.repo_path).toBe("/tmp/moved");
    expect((after as Record<string, unknown>).nonsense).toBeUndefined();
  });
});

describe("tasks CRUD", () => {
  it("creates, lists, filters, and updates with whitelist", () => {
    freshDb();
    const p = createProject({ name: "svc", repo_path: "/tmp/svc" });
    const t = createTask({ name: "t1", project_id: p.id, stage: "intake", intake_kind: "bug" });
    expect(getTask(t.task_id)?.name).toBe("t1");
    expect(listTasks({ projectId: p.id }).length).toBe(1);
    expect(listTasks({ projectId: p.id, stage: "refining" }).length).toBe(0);

    updateTask(t.task_id, { stage: "refining", bogus_col: 1 } as never);
    const after = getTask(t.task_id)!;
    expect(after.stage).toBe("refining");
    expect((after as Record<string, unknown>).bogus_col).toBeUndefined();
  });

  it("links children by parent_task_id", () => {
    freshDb();
    const parent = createTask({ name: "epic" });
    createTask({ name: "child", parent_task_id: parent.task_id, level: "task" });
    expect(listTasks({ parentTaskId: parent.task_id }).length).toBe(1);
  });
});

describe("worktree families (root_task_id)", () => {
  it("a brand-new task self-references as its own family root", () => {
    freshDb();
    const t = createTask({ name: "solo" });
    expect(t.root_task_id).toBe(t.task_id);
    expect(familyRootId(t)).toBe(t.task_id);
  });

  it("a child inherits its parent's resolved root, at any depth, with no chain-walking", () => {
    freshDb();
    const root = createTask({ name: "epic" });
    const child = createTask({ name: "story", parent_task_id: root.task_id, task_type: "child" });
    const grandchild = createTask({ name: "task", parent_task_id: child.task_id, task_type: "child" });
    expect(child.root_task_id).toBe(root.task_id);
    // Copied straight from the parent's already-resolved value, not walked.
    expect(grandchild.root_task_id).toBe(root.task_id);
    expect(familyRootId(grandchild)).toBe(root.task_id);
  });

  it("a legacy task (root_task_id null) resolves its own id as root and a new child still joins that family", () => {
    freshDb();
    const legacyRoot = createTask({ name: "predates the column" });
    updateTask(legacyRoot.task_id, {}); // no-op, just ensures the row round-trips
    // Simulate a pre-migration row directly, since createTask always sets it now.
    getDb().prepare("UPDATE tasks SET root_task_id = NULL WHERE task_id = ?").run(legacyRoot.task_id);
    const stale = getTask(legacyRoot.task_id)!;
    expect(familyRootId(stale)).toBe(stale.task_id);

    const child = createTask({ name: "new child of a legacy parent", parent_task_id: stale.task_id, task_type: "child" });
    // getTask(parent)?.root_task_id is null, meaning the parent IS the root
    // (a fresh root and a legacy one are indistinguishable from here) — the
    // child falls back to the parent's own id, joining its family instead of
    // being permanently orphaned into a standalone one of its own.
    expect(child.root_task_id).toBe(stale.task_id);
    expect(familyRootId(child)).toBe(stale.task_id);
  });

  it("listTasks({rootTaskId}) returns every family member, including the root's own row", () => {
    freshDb();
    const root = createTask({ name: "epic" });
    const childA = createTask({ name: "a", parent_task_id: root.task_id, task_type: "child" });
    const childB = createTask({ name: "b", parent_task_id: root.task_id, task_type: "child" });
    const other = createTask({ name: "unrelated" });

    const family = listTasks({ rootTaskId: root.task_id }).map((t) => t.task_id).sort();
    expect(family).toEqual([root.task_id, childA.task_id, childB.task_id].sort());
    expect(family).not.toContain(other.task_id);
  });

  it("familyMembersExcluding omits the task itself but includes every other family member", () => {
    freshDb();
    const root = createTask({ name: "epic" });
    const child = createTask({ name: "child", parent_task_id: root.task_id, task_type: "child" });

    expect(familyMembersExcluding(root).map((t) => t.task_id)).toEqual([child.task_id]);
    expect(familyMembersExcluding(child).map((t) => t.task_id)).toEqual([root.task_id]);
    // Solo task: no siblings.
    const solo = createTask({ name: "solo" });
    expect(familyMembersExcluding(solo)).toEqual([]);
  });
});

describe("role_runs + interventions", () => {
  it("records and lists role runs", () => {
    freshDb();
    const t = createTask({ name: "t" });
    createRoleRun({ task_id: t.task_id, role_key: "explorer", verdict: "pass", summary: "ok" });
    const runs = listRoleRuns(t.task_id);
    expect(runs.length).toBe(1);
    expect(runs[0]!.verdict).toBe("pass");
  });

  it("round-trips verdict_source and leaves it null when unset", () => {
    freshDb();
    const t = createTask({ name: "t" });
    createRoleRun({ task_id: t.task_id, role_key: "explorer", verdict: "pass", verdict_source: "fence" });
    createRoleRun({ task_id: t.task_id, role_key: "critic", verdict: "pass" });
    const runs = listRoleRuns(t.task_id);
    expect(runs[0]!.verdict_source).toBe("fence");
    expect(runs[1]!.verdict_source).toBeNull();
  });

  it("round-trips attempt + resumed_from and leaves them null when unset (overhaul/03)", () => {
    freshDb();
    const t = createTask({ name: "t" });
    const first = createRoleRun({ task_id: t.task_id, role_key: "explorer", verdict: "needs_more", attempt: 1 });
    createRoleRun({
      task_id: t.task_id,
      role_key: "explorer",
      verdict: "pass",
      attempt: 2,
      resumed_from: first.id,
    });
    createRoleRun({ task_id: t.task_id, role_key: "critic", verdict: "pass" });
    const runs = listRoleRuns(t.task_id);
    expect(runs[0]!.attempt).toBe(1);
    expect(runs[0]!.resumed_from).toBeNull();
    expect(runs[1]!.attempt).toBe(2);
    expect(runs[1]!.resumed_from).toBe(first.id);
    expect(runs[2]!.attempt).toBeNull();
    expect(runs[2]!.resumed_from).toBeNull();
  });

  it("round-trips phase + failed_tool_calls + artifact_bytes and leaves them null when unset (overhaul/04)", () => {
    freshDb();
    const t = createTask({ name: "t" });
    createRoleRun({
      task_id: t.task_id,
      role_key: "explorer",
      verdict: "pass",
      phase: 2,
      failed_tool_calls: 3,
      artifact_bytes: 1234,
    });
    createRoleRun({ task_id: t.task_id, role_key: "critic", verdict: "pass" });
    const runs = listRoleRuns(t.task_id);
    expect(runs[0]!.phase).toBe(2);
    expect(runs[0]!.failed_tool_calls).toBe(3);
    expect(runs[0]!.artifact_bytes).toBe(1234);
    expect(runs[1]!.phase).toBeNull();
    expect(runs[1]!.failed_tool_calls).toBeNull();
    expect(runs[1]!.artifact_bytes).toBeNull();
  });

  it("round-trips evidence_json and leaves it null when unset (overhaul/05)", () => {
    freshDb();
    const t = createTask({ name: "t" });
    const evidence = [
      {
        name: "test",
        argv: ["npm", "test"],
        exitCode: 0,
        durationMs: 4200,
        outputTail: "42 passed",
        truncated: false,
        timedOut: false,
        startedAt: "2026-07-22T00:00:00.000Z",
      },
    ];
    createRoleRun({
      task_id: t.task_id,
      role_key: "developer",
      verdict: "pass",
      evidence_json: JSON.stringify(evidence),
    });
    createRoleRun({ task_id: t.task_id, role_key: "critic", verdict: "pass" });
    const runs = listRoleRuns(t.task_id);
    expect(JSON.parse(runs[0]!.evidence_json!)).toEqual(evidence);
    expect(runs[1]!.evidence_json).toBeNull();
  });

  it("counts the verified tier from recorded evidence (overhaul/05)", () => {
    freshDb();
    const t = createTask({ name: "t" });
    const ev = (exitCode: number) =>
      JSON.stringify([{ name: "test", argv: ["npm", "test"], exitCode, durationMs: 1, outputTail: "", truncated: false, timedOut: false, startedAt: "x" }]);
    // Clean + green -> verified; clean + red -> healthy; clean + none -> healthy.
    createRoleRun({ task_id: t.task_id, role_key: "developer", verdict: "pass", verdict_source: "tool", model: "m", output_md: "r", evidence_json: ev(0) });
    createRoleRun({ task_id: t.task_id, role_key: "developer", verdict: "pass", verdict_source: "tool", model: "m", output_md: "r", evidence_json: ev(1) });
    createRoleRun({ task_id: t.task_id, role_key: "critic", verdict: "pass", verdict_source: "tool", model: "m", output_md: "r" });

    const stats = getHealthStats("model");
    const bucket = stats.find((s) => s.group === "m")!;
    expect(bucket.runs).toBe(3);
    expect(bucket.verified).toBe(1);
    expect(bucket.healthy).toBe(2);

    // The per-task rollup sees the same tier and does not count it as degraded.
    const summary = getTaskHealthSummaries([t.task_id]).get(t.task_id)!;
    expect(summary.degraded_runs).toBe(0);
    expect(summary.latest_health).toBe("healthy");
  });

  it("getHealthStats buckets primary runs and counts health tiers (overhaul/04)", () => {
    freshDb();
    const t = createTask({ name: "t" });
    // healthy
    createRoleRun({ task_id: t.task_id, role_key: "explorer", verdict: "pass", verdict_source: "tool", model: "m1", tokens: 100, artifact_bytes: 50 });
    // degraded (truncated)
    createRoleRun({ task_id: t.task_id, role_key: "explorer", verdict: "needs_more", verdict_source: "fence", stop_reason: "length", model: "m1", tokens: 200, artifact_bytes: 10 });
    // recovered (repair)
    createRoleRun({ task_id: t.task_id, role_key: "explorer", verdict: "pass", verdict_source: "repair", model: "m1", tokens: 150, artifact_bytes: 30 });
    // empty (fallback, nothing produced) — verdict_source fallback = repair reached & failed
    createRoleRun({ task_id: t.task_id, role_key: "explorer", verdict: "needs_more", verdict_source: "fallback", fallback: 1, model: "m2", tokens: 5, artifact_bytes: 0, output_md: "" });
    // A critique run must be excluded from primary-only stats.
    createRoleRun({ task_id: t.task_id, role_key: "critic", verdict: "pass", run_kind: "critique", model: "m1" });

    const byModel = getHealthStats("model");
    const m1 = byModel.find((r) => r.group === "m1")!;
    expect(m1.runs).toBe(3);
    expect(m1.healthy).toBe(1);
    expect(m1.recovered).toBe(1);
    expect(m1.degraded).toBe(1);
    expect(m1.truncation_count).toBe(1);
    // m1 reached repair once (the "repair" run) and it succeeded → 100%.
    expect(m1.repair_attempted).toBe(1);
    expect(m1.repair_success).toBe(1);
    expect(m1.repair_success_rate).toBe(1);

    const m2 = byModel.find((r) => r.group === "m2")!;
    expect(m2.runs).toBe(1);
    expect(m2.empty).toBe(1);
    // m2's single run reached repair (fallback source) but it failed → 0%.
    expect(m2.repair_attempted).toBe(1);
    expect(m2.repair_success).toBe(0);
    expect(m2.repair_success_rate).toBe(0);

    // "mode" buckets by verdict_source.
    const byMode = getHealthStats("mode");
    expect(byMode.find((r) => r.group === "tool")!.healthy).toBe(1);
    expect(byMode.find((r) => r.group === "repair")!.recovered).toBe(1);
  });

  it("getHealthStats rolls up context ledger metrics (overhaul/07 §5)", () => {
    freshDb();
    const t = createTask({ name: "t" });
    createRoleRun({ task_id: t.task_id, role_key: "explorer", verdict: "pass", model: "m1", context_tokens_est: 100, context_degraded: 0 });
    createRoleRun({ task_id: t.task_id, role_key: "explorer", verdict: "pass", model: "m1", context_tokens_est: 200, context_degraded: 1 });
    createRoleRun({ task_id: t.task_id, role_key: "explorer", verdict: "pass", model: "m1", context_tokens_est: 300, context_degraded: 0 });
    // A run predating the column (context_tokens_est unset) must not skew the average.
    createRoleRun({ task_id: t.task_id, role_key: "explorer", verdict: "pass", model: "m1" });

    const stats = getHealthStats("model");
    const m1 = stats.find((s) => s.group === "m1")!;
    expect(m1.runs).toBe(4);
    expect(m1.avg_context_tokens_est).toBe(200); // mean of [100, 200, 300], legacy row excluded
    expect(m1.p95_context_tokens_est).toBe(300);
    expect(m1.context_degraded_count).toBe(1);
    expect(m1.context_degraded_rate).toBe(0.25); // 1 of 4 runs, legacy row counts toward the denominator
  });

  it("getTaskHealthSummaries reports degraded counts + latest-run health per task (overhaul/04)", () => {
    freshDb();
    const a = createTask({ name: "a" });
    const b = createTask({ name: "b" });
    createRoleRun({ task_id: a.task_id, role_key: "explorer", verdict: "pass", verdict_source: "tool", artifact_bytes: 40 });
    createRoleRun({ task_id: a.task_id, role_key: "reviewer", verdict: "needs_more", verdict_source: "fence", stop_reason: "length", artifact_bytes: 10 });
    // b has only a clean run
    createRoleRun({ task_id: b.task_id, role_key: "explorer", verdict: "pass", verdict_source: "tool", artifact_bytes: 40 });

    const summaries = getTaskHealthSummaries([a.task_id, b.task_id]);
    expect(summaries.get(a.task_id)).toEqual({ degraded_runs: 1, latest_health: "degraded" });
    expect(summaries.get(b.task_id)).toEqual({ degraded_runs: 0, latest_health: "healthy" });
    // A task with no runs is simply absent.
    expect(summaries.has("nonexistent")).toBe(false);
    // Empty input short-circuits.
    expect(getTaskHealthSummaries([]).size).toBe(0);
  });

  it("tracks unconsumed interventions until marked", () => {
    freshDb();
    const t = createTask({ name: "t" });
    const iv = createIntervention({ task_id: t.task_id, kind: "pause" });
    expect(listUnconsumedInterventions(t.task_id).length).toBe(1);
    markInterventionConsumed(iv.id);
    expect(listUnconsumedInterventions(t.task_id).length).toBe(0);
  });
});

describe("getModelLiveStats (PLANNING/overhaul/06 — live calibration input)", () => {
  it("returns null when the model has no primary runs at all", () => {
    freshDb();
    expect(getModelLiveStats("nonexistent-model", 30)).toBeNull();
  });

  it("distinguishes 'no live data' from 'clean live data' — a model with only clean runs is not null", () => {
    freshDb();
    const t = createTask({ name: "t" });
    createRoleRun({ task_id: t.task_id, role_key: "explorer", verdict: "pass", verdict_source: "tool", model: "m" });
    const stats = getModelLiveStats("m", 30);
    expect(stats).not.toBeNull();
    expect(stats!.runs).toBe(1);
    expect(stats!.fallbackRate).toBe(0);
  });

  it("computes fallback/stall/truncation/repair rates over the sampled runs", () => {
    freshDb();
    const t = createTask({ name: "t" });
    createRoleRun({ task_id: t.task_id, role_key: "explorer", verdict: "pass", verdict_source: "tool", model: "m" });
    createRoleRun({ task_id: t.task_id, role_key: "explorer", verdict: "needs_more", verdict_source: "fallback", fallback: 1, model: "m" });
    createRoleRun({ task_id: t.task_id, role_key: "explorer", verdict: "pass", verdict_source: "repair", model: "m" });
    createRoleRun({ task_id: t.task_id, role_key: "explorer", verdict: "needs_more", stop_reason: "length", model: "m" });
    createRoleRun({ task_id: t.task_id, role_key: "explorer", verdict: "needs_more", stalled: 1, model: "m" });

    const stats = getModelLiveStats("m", 30)!;
    expect(stats.runs).toBe(5);
    expect(stats.totalRuns).toBe(5);
    expect(stats.fallbackRate).toBeCloseTo(1 / 5);
    expect(stats.stallRate).toBeCloseTo(1 / 5);
    expect(stats.truncationRate).toBeCloseTo(1 / 5);
    // Repair-reached = verdict_source in (repair, fallback) = 2/5.
    expect(stats.repairRate).toBeCloseTo(2 / 5);
    expect(stats.byMode.tool).toBe(1);
    expect(stats.byMode.fallback).toBe(1);
    expect(stats.byMode.repair).toBe(1);
  });

  it("excludes non-primary runs (critique/second_review) from the live sample", () => {
    freshDb();
    const t = createTask({ name: "t" });
    createRoleRun({ task_id: t.task_id, role_key: "explorer", verdict: "pass", verdict_source: "tool", model: "m" });
    createRoleRun({ task_id: t.task_id, role_key: "critic", verdict: "pass", verdict_source: "tool", model: "m", run_kind: "critique" });
    const stats = getModelLiveStats("m", 30)!;
    expect(stats.runs).toBe(1);
    expect(stats.totalRuns).toBe(1);
  });

  it("caps the sample at the window but keeps totalRuns as the all-time count (the hysteresis clock)", () => {
    freshDb();
    const t = createTask({ name: "t" });
    for (let i = 0; i < 50; i++) {
      createRoleRun({ task_id: t.task_id, role_key: "explorer", verdict: "pass", verdict_source: "tool", model: "m" });
    }
    const stats = getModelLiveStats("m", 30)!;
    expect(stats.runs).toBe(30);
    expect(stats.totalRuns).toBe(50);
    expect(stats.window).toBe(30);
  });

  it("samples the most recent runs, not the oldest, when capped by the window", () => {
    freshDb();
    const t = createTask({ name: "t" });
    // 20 clean runs, then 5 fallback runs — with a window of 5, only the
    // fallback runs (the most recent) should be sampled.
    for (let i = 0; i < 20; i++) {
      createRoleRun({ task_id: t.task_id, role_key: "explorer", verdict: "pass", verdict_source: "tool", model: "m" });
    }
    for (let i = 0; i < 5; i++) {
      createRoleRun({ task_id: t.task_id, role_key: "explorer", verdict: "needs_more", verdict_source: "fallback", fallback: 1, model: "m" });
    }
    const stats = getModelLiveStats("m", 5)!;
    expect(stats.runs).toBe(5);
    expect(stats.fallbackRate).toBe(1);
  });
});

describe("model_profiles row store (PLANNING/overhaul/06)", () => {
  it("upserts in place — a second write for the same key updates rather than duplicating", () => {
    freshDb();
    upsertModelProfileRow("sig-a", "model-a", '{"v":1}');
    upsertModelProfileRow("sig-a", "model-a", '{"v":2}');
    expect(listModelProfileRows()).toHaveLength(1);
    expect(getModelProfileRow("sig-a", "model-a")!.profile_json).toBe('{"v":2}');
  });

  it("keys independently by (connection_sig, model_id) — same model, different connection", () => {
    freshDb();
    upsertModelProfileRow("sig-a", "model-x", '{"v":"a"}');
    upsertModelProfileRow("sig-b", "model-x", '{"v":"b"}');
    expect(listModelProfileRows()).toHaveLength(2);
    expect(getModelProfileRow("sig-a", "model-x")!.profile_json).toBe('{"v":"a"}');
    expect(getModelProfileRow("sig-b", "model-x")!.profile_json).toBe('{"v":"b"}');
  });

  it("getModelProfileRow returns undefined for a never-stored key", () => {
    freshDb();
    expect(getModelProfileRow("nope", "nope")).toBeUndefined();
  });

  it("deleteModelProfileRow removes exactly the targeted row", () => {
    freshDb();
    upsertModelProfileRow("sig-a", "model-a", "{}");
    upsertModelProfileRow("sig-a", "model-b", "{}");
    deleteModelProfileRow("sig-a", "model-a");
    expect(getModelProfileRow("sig-a", "model-a")).toBeUndefined();
    expect(getModelProfileRow("sig-a", "model-b")).not.toBeUndefined();
  });
});

describe("tasks.origin / tasks.priority (PLANNING/overhaul/08)", () => {
  it("defaults to origin 'human' and priority 3 for every existing/human-filed task", () => {
    freshDb();
    const t = createTask({ name: "t" });
    expect(t.origin).toBe("human");
    expect(t.priority).toBe(3);
  });

  it("is settable at creation and updatable afterward", () => {
    freshDb();
    const t = createTask({ name: "t", origin: "watcher:test-suite", priority: 5 });
    expect(t.origin).toBe("watcher:test-suite");
    expect(t.priority).toBe(5);
    const updated = updateTask(t.task_id, { origin: "human", priority: 1 });
    expect(updated?.origin).toBe("human");
    expect(updated?.priority).toBe(1);
  });
});

describe("candidates (PLANNING/overhaul/08)", () => {
  it("creates a pending candidate and round-trips it by id", () => {
    freshDb();
    const project = createProject({ name: "p", repo_path: "/tmp/p" });
    const c = createCandidate({
      project_id: project.id,
      watcher: "test-suite",
      kind: "error_file",
      fingerprint: "fp1",
      payload_json: "{}",
    });
    expect(c.status).toBe("pending");
    expect(getCandidate(c.id)).toMatchObject({ id: c.id, watcher: "test-suite", fingerprint: "fp1" });
  });

  it("findLatestCandidateByFingerprint returns the most recent row for that (project, watcher, fingerprint)", () => {
    freshDb();
    const project = createProject({ name: "p", repo_path: "/tmp/p" });
    expect(findLatestCandidateByFingerprint(project.id, "test-suite", "fp1")).toBeUndefined();
    const c1 = createCandidate({ project_id: project.id, watcher: "test-suite", kind: "error_file", fingerprint: "fp1", payload_json: "{}" });
    updateCandidate(c1.id, { status: "suppressed" });
    const c2 = createCandidate({ project_id: project.id, watcher: "test-suite", kind: "error_file", fingerprint: "fp1", payload_json: "{}" });
    const latest = findLatestCandidateByFingerprint(project.id, "test-suite", "fp1");
    expect(latest?.id).toBe(c2.id);
  });

  it("listCandidates filters by projectId/status/watcher", () => {
    freshDb();
    const p1 = createProject({ name: "p1", repo_path: "/tmp/p1" });
    const p2 = createProject({ name: "p2", repo_path: "/tmp/p2" });
    const a = createCandidate({ project_id: p1.id, watcher: "test-suite", kind: "error_file", fingerprint: "a", payload_json: "{}" });
    createCandidate({ project_id: p1.id, watcher: "todo-scan", kind: "chore", fingerprint: "b", payload_json: "{}" });
    createCandidate({ project_id: p2.id, watcher: "test-suite", kind: "error_file", fingerprint: "c", payload_json: "{}" });
    updateCandidate(a.id, { status: "queued" });

    expect(listCandidates({ projectId: p1.id })).toHaveLength(2);
    expect(listCandidates({ projectId: p1.id, watcher: "test-suite" })).toHaveLength(1);
    expect(listCandidates({ status: "queued" })).toHaveLength(1);
    expect(listCandidates()).toHaveLength(3);
  });

  it("listCandidates defaults to a bounded, most-recent-first feed and clamps an explicit limit", () => {
    freshDb();
    const project = createProject({ name: "p", repo_path: "/tmp/p" });
    for (let i = 0; i < 60; i++) {
      createCandidate({
        project_id: project.id,
        watcher: "test-suite",
        kind: "error_file",
        fingerprint: `fp${i}`,
        payload_json: "{}",
      });
    }
    const defaulted = listCandidates({ projectId: project.id });
    expect(defaulted).toHaveLength(50); // default cap
    expect(defaulted[0]?.fingerprint).toBe("fp59"); // most recent first

    expect(listCandidates({ projectId: project.id, limit: 5 })).toHaveLength(5);
    expect(listCandidates({ projectId: project.id, limit: 0 })).toHaveLength(1); // clamped to a min of 1
    expect(listCandidates({ projectId: project.id, limit: 10_000 })).toHaveLength(60); // clamped to the max, but only 60 rows exist
  });

  it("updateCandidate patches only the given fields and always bumps updated_at", () => {
    freshDb();
    const project = createProject({ name: "p", repo_path: "/tmp/p" });
    const c = createCandidate({ project_id: project.id, watcher: "test-suite", kind: "error_file", fingerprint: "fp1", payload_json: "{}" });
    const updated = updateCandidate(c.id, { status: "queued", task_id: "abc123" });
    expect(updated?.status).toBe("queued");
    expect(updated?.task_id).toBe("abc123");
    expect(updated?.fingerprint).toBe("fp1"); // untouched
  });

  it("countCandidatesQueuedToday counts only today's queued rows for the given project+watcher", () => {
    freshDb();
    const project = createProject({ name: "p", repo_path: "/tmp/p" });
    const a = createCandidate({ project_id: project.id, watcher: "test-suite", kind: "error_file", fingerprint: "a", payload_json: "{}" });
    const b = createCandidate({ project_id: project.id, watcher: "test-suite", kind: "error_file", fingerprint: "b", payload_json: "{}" });
    const c = createCandidate({ project_id: project.id, watcher: "todo-scan", kind: "chore", fingerprint: "c", payload_json: "{}" });
    updateCandidate(a.id, { status: "queued" });
    updateCandidate(b.id, { status: "rejected" });
    updateCandidate(c.id, { status: "queued" });
    expect(countCandidatesQueuedToday(project.id, "test-suite")).toBe(1);
    expect(countCandidatesQueuedToday(project.id, "todo-scan")).toBe(1);
  });

  it("countOpenWatcherTasks counts only non-'ready' tasks whose origin is a watcher", () => {
    freshDb();
    const project = createProject({ name: "p", repo_path: "/tmp/p" });
    createTask({ name: "human", project_id: project.id, origin: "human", stage: "refining" });
    createTask({ name: "w1", project_id: project.id, origin: "watcher:test-suite", stage: "refining" });
    const w2 = createTask({ name: "w2", project_id: project.id, origin: "watcher:test-suite", stage: "refining" });
    updateTask(w2.task_id, { stage: "ready" }); // settled — no longer "open"
    expect(countOpenWatcherTasks(project.id)).toBe(1);
  });

  it("suppressCandidateForTask marks the linked candidate suppressed, and is a no-op with no linked candidate", () => {
    freshDb();
    const project = createProject({ name: "p", repo_path: "/tmp/p" });
    const task = createTask({ name: "t", project_id: project.id, origin: "watcher:test-suite" });
    const c = createCandidate({ project_id: project.id, watcher: "test-suite", kind: "error_file", fingerprint: "fp1", payload_json: "{}" });
    updateCandidate(c.id, { task_id: task.task_id });

    suppressCandidateForTask(task.task_id, "closed as wont_do");
    const updated = getCandidate(c.id)!;
    expect(updated.status).toBe("suppressed");
    expect(updated.suppressed_reason).toBe("closed as wont_do");
    expect(updated.suppressed_at).not.toBeNull();

    // No throw, no side effect, for a task with no linked candidate.
    expect(() => suppressCandidateForTask("nonexistent-task-id", "whatever")).not.toThrow();
  });

  it("sumAutonomousTokensSince sums only watcher-origin tasks' role_runs.tokens at/after the timestamp", () => {
    freshDb();
    const project = createProject({ name: "p", repo_path: "/tmp/p" });
    const human = createTask({ name: "h", project_id: project.id, origin: "human" });
    const watcher = createTask({ name: "w", project_id: project.id, origin: "watcher:test-suite" });
    createRoleRun({ task_id: human.task_id, role_key: "explorer", verdict: "pass", tokens: 999 });
    createRoleRun({ task_id: watcher.task_id, role_key: "explorer", verdict: "pass", tokens: 100 });
    createRoleRun({ task_id: watcher.task_id, role_key: "developer", verdict: "pass", tokens: 50 });
    expect(sumAutonomousTokensSince(project.id, "1970-01-01")).toBe(150);
  });
});

describe("configs / connection resolution", () => {
  it("round-trips thinking_format through upsertConfig", () => {
    freshDb();
    upsertConfig({ project_id: null, key: "default", thinking_format: "qwen-chat-template" });
    expect(getGlobalConfig()?.thinking_format).toBe("qwen-chat-template");
    // A later PATCH that omits it keeps the prior value.
    upsertConfig({ project_id: null, key: "default", max_tokens: 20000 });
    expect(getGlobalConfig()?.thinking_format).toBe("qwen-chat-template");
  });

  it("resolves thinkingFormat project → global → bootstrap default", () => {
    freshDb();
    // No rows yet: falls back to the bootstrap config default ("qwen-chat-template").
    expect(resolveConnection().thinkingFormat).toBe("qwen-chat-template");

    // Global row wins over the bootstrap default.
    upsertConfig({ project_id: null, key: "default", thinking_format: "qwen" });
    expect(resolveConnection().thinkingFormat).toBe("qwen");

    // Project override wins over the global row.
    const p = createProject({ name: "svc", repo_path: "/tmp/svc" });
    upsertConfig({ project_id: p.id, key: "default", thinking_format: "deepseek" });
    expect(resolveConnection(p.id).thinkingFormat).toBe("deepseek");
    // ...but the global still applies to other (or no) projects.
    expect(resolveConnection().thinkingFormat).toBe("qwen");
  });
});

describe("listRoles merge", () => {
  it("returns globals, then lets a project override win by key", () => {
    freshDb();
    upsertRole({ project_id: null, key: "explorer", title: "Global Explorer", ordering: 20 });
    upsertRole({ project_id: null, key: "security_review", title: "Global Sec", ordering: 60 });
    expect(countGlobalRoles()).toBe(2);

    const p = createProject({ name: "svc", repo_path: "/tmp/svc" });
    upsertRole({ project_id: p.id, key: "explorer", title: "Project Explorer", enabled: false, ordering: 20 });

    const merged = listRoles(p.id);
    const explorer = merged.find((r) => r.key === "explorer")!;
    expect(explorer.title).toBe("Project Explorer");
    expect(explorer.project_id).toBe(p.id);
    expect(explorer.enabled).toBe(0);
    // The non-overridden global is still present.
    expect(merged.find((r) => r.key === "security_review")?.title).toBe("Global Sec");
  });
});
