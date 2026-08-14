/**
 * Role versioning & outcome scoring (PLANNING/overhaul-2/03) — version
 * recording on edit, the backfill, per-version attribution of run outcomes
 * across an edit boundary, and non-destructive revert.
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { resetConfig } from "../src/config";
import {
  MIN_RUNS_FOR_CONFIDENT_SCORE,
  closeDb,
  createIntervention,
  createProject,
  createRoleRun,
  createTask,
  getDb,
  getRole,
  getRoleVersionStats,
  initDb,
  listRoleVersions,
  revertRoleToVersion,
  upsertRole,
  type RoleRow,
} from "../src/db";
import { freshDb } from "./helpers";

afterEach(() => closeDb());

function seedRole(overrides: Partial<Parameters<typeof upsertRole>[0]> = {}): RoleRow {
  return upsertRole({
    project_id: null,
    key: "explorer",
    title: "Explorer",
    system_prompt: "v1 prompt",
    tools_json: JSON.stringify(["read"]),
    model: null,
    ...overrides,
  });
}

describe("upsertRole versioning", () => {
  it("records an initial version on insert and points the role at it", () => {
    freshDb();
    const role = seedRole();
    const versions = listRoleVersions(role.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.version_no).toBe(1);
    expect(versions[0]!.system_prompt).toBe("v1 prompt");
    expect(role.current_version_id).toBe(versions[0]!.id);
  });

  it("advances current_version_id on a real edit", () => {
    freshDb();
    const first = seedRole();
    const second = seedRole({ system_prompt: "v2 prompt" });

    const versions = listRoleVersions(second.id);
    expect(versions.map((v) => v.version_no)).toEqual([2, 1]);
    expect(second.current_version_id).not.toBe(first.current_version_id);
    expect(second.current_version_id).toBe(versions[0]!.id);
    // The live row is still the single source of truth for what runs.
    expect(second.system_prompt).toBe("v2 prompt");
    // History is intact — the old prompt is recoverable, which it wasn't before.
    expect(versions[1]!.system_prompt).toBe("v1 prompt");
  });

  it("versions a tools or model change, not just the prompt", () => {
    freshDb();
    const role = seedRole();
    seedRole({ tools_json: JSON.stringify(["read", "grep"]) });
    seedRole({ model: "some-model" });
    expect(listRoleVersions(role.id)).toHaveLength(3);
  });

  it("does not mint a version when nothing scoreable changed", () => {
    freshDb();
    const role = seedRole();
    // Re-saving identical content — what seedGlobalRoles does on every boot
    // whose catalog hash moved for some OTHER role.
    seedRole();
    // Non-scoreable fields: a re-ordered or re-titled role produces no
    // different output, so there is nothing new to score.
    seedRole({ ordering: 9, title: "Renamed", enabled: true });
    expect(listRoleVersions(role.id)).toHaveLength(1);
  });
});

describe("backfill for pre-versioning roles", () => {
  it("gives an existing role a version 1 matching what it already runs", () => {
    // A DB with a roles row but no versioning columns at all.
    const dir = fs.mkdtempSync(path.join(tmpdir(), "orch-roles-"));
    const dbPath = path.join(dir, "legacy.db");
    const legacy = new Database(dbPath);
    legacy.exec(`CREATE TABLE roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, key TEXT NOT NULL, title TEXT,
      enabled INTEGER DEFAULT 1, applies_to TEXT, ordering INTEGER DEFAULT 0,
      system_prompt TEXT, tools_json TEXT, model TEXT, created_at TEXT, updated_at TEXT);`);
    legacy
      .prepare(`INSERT INTO roles (project_id, key, system_prompt, tools_json) VALUES (NULL, ?, ?, ?)`)
      .run("explorer", "legacy prompt", '["read"]');
    legacy.close();

    process.env.ORCHESTRA_DB_PATH = dbPath;
    process.env.ORCHESTRA_SECRET_KEY = "0".repeat(64);
    resetConfig();
    closeDb();
    initDb();

    const role = getRole(null, "explorer")!;
    expect(role.current_version_id).not.toBeNull();
    const versions = listRoleVersions(role.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.version_no).toBe(1);
    expect(versions[0]!.system_prompt).toBe("legacy prompt");

    // Idempotent: a second boot must not add a duplicate version 1.
    initDb();
    expect(listRoleVersions(role.id)).toHaveLength(1);
  });
});

/** A primary run against `versionId`, optionally with a linked critique. */
function runAgainst(
  taskId: string,
  versionId: number,
  opts: { verdict?: string; critiqueVerdict?: string; criteria?: Array<{ status: string }> } = {},
): number {
  const run = createRoleRun({
    task_id: taskId,
    role_key: "explorer",
    verdict: opts.verdict ?? "pass",
    role_version_id: versionId,
    model: "m",
    tokens: 100,
    verdict_source: "tool",
    output_md: "report",
    artifact_bytes: 500,
  });
  if (opts.critiqueVerdict) {
    createRoleRun({
      task_id: taskId,
      role_key: "critic",
      run_kind: "critique",
      target_run_id: run.id,
      verdict: opts.critiqueVerdict,
      criteria_results_json: opts.criteria ? JSON.stringify(opts.criteria) : null,
    });
  }
  return run.id;
}

describe("getRoleVersionStats", () => {
  it("attributes runs to the version that produced them across an edit boundary", () => {
    freshDb();
    const project = createProject({ name: "p", repo_path: "/tmp/p" });
    const task = createTask({ name: "t", project_id: project.id });
    const v1Role = seedRole();
    const v1 = v1Role.current_version_id!;

    // Two runs on v1: one pass, one fail.
    runAgainst(task.task_id, v1, { verdict: "pass" });
    runAgainst(task.task_id, v1, { verdict: "blocker" });

    // Edit the prompt, then one clean run on v2.
    const v2Role = seedRole({ system_prompt: "v2 prompt" });
    const v2 = v2Role.current_version_id!;
    runAgainst(task.task_id, v2, { verdict: "pass" });

    const stats = getRoleVersionStats(v1Role.id);
    const byVersion = new Map(stats.map((s) => [s.version_id, s]));
    expect(byVersion.get(v1)!.runs).toBe(2);
    expect(byVersion.get(v1)!.pass_rate).toBeCloseTo(0.5, 6);
    expect(byVersion.get(v2)!.runs).toBe(1);
    expect(byVersion.get(v2)!.pass_rate).toBe(1);
    // This is the whole point: a lifetime rollup would report 2/3 for both.
    expect(byVersion.get(v2)!.is_current).toBe(true);
    expect(byVersion.get(v1)!.is_current).toBe(false);
  });

  it("excludes runs predating versioning rather than guessing which version they used", () => {
    freshDb();
    const project = createProject({ name: "p", repo_path: "/tmp/p" });
    const task = createTask({ name: "t", project_id: project.id });
    const role = seedRole();
    createRoleRun({ task_id: task.task_id, role_key: "explorer", verdict: "blocker" }); // no version stamp
    runAgainst(task.task_id, role.current_version_id!, { verdict: "pass" });

    const stats = getRoleVersionStats(role.id);
    expect(stats[0]!.runs).toBe(1);
    expect(stats[0]!.pass_rate).toBe(1);
  });

  it("scopes loopback and flag rates to the runs that were actually reviewed", () => {
    freshDb();
    const project = createProject({ name: "p", repo_path: "/tmp/p" });
    const task = createTask({ name: "t", project_id: project.id });
    const role = seedRole();
    const v1 = role.current_version_id!;

    runAgainst(task.task_id, v1, { verdict: "pass" }); // never reviewed
    runAgainst(task.task_id, v1, { verdict: "pass", critiqueVerdict: "pass", criteria: [{ status: "met" }] });
    runAgainst(task.task_id, v1, { verdict: "pass", critiqueVerdict: "blocker", criteria: [{ status: "fail" }] });

    const s = getRoleVersionStats(role.id)[0]!;
    expect(s.runs).toBe(3);
    expect(s.reviewed_runs).toBe(2);
    // 1 of the 2 reviewed runs was sent back — not 1 of 3, which would let an
    // uncritiqued role look better simply by never being checked.
    expect(s.loopback_rate).toBeCloseTo(0.5, 6);
    expect(s.critique_flag_rate).toBeCloseTo(0.5, 6);
  });

  it("counts a human non-acceptance only when it came after the run", async () => {
    freshDb();
    const project = createProject({ name: "p", repo_path: "/tmp/p" });
    const task = createTask({ name: "t", project_id: project.id });
    const role = seedRole();
    const v1 = role.current_version_id!;

    // An action recorded BEFORE any run of this version can't be a judgement
    // on it. The waits are only to clear the millisecond-precision timestamp
    // this comparison rests on — a real run takes seconds.
    createIntervention({ task_id: task.task_id, kind: "request_changes", created_by: "user" });
    await new Promise((r) => setTimeout(r, 5));
    runAgainst(task.task_id, v1);
    expect(getRoleVersionStats(role.id)[0]!.human_override_rate).toBe(0);

    await new Promise((r) => setTimeout(r, 5));
    createIntervention({ task_id: task.task_id, kind: "restore_checkpoint", created_by: "user" });
    expect(getRoleVersionStats(role.id)[0]!.human_override_rate).toBe(1);
  });

  it("folds run health in, so a version that only passes via fallback scores worse than its pass rate", () => {
    freshDb();
    const project = createProject({ name: "p", repo_path: "/tmp/p" });
    const task = createTask({ name: "t", project_id: project.id });
    const role = seedRole();
    const v1 = role.current_version_id!;

    createRoleRun({
      task_id: task.task_id,
      role_key: "explorer",
      verdict: "pass",
      role_version_id: v1,
      verdict_source: "fallback",
      fallback: 1,
      output_md: "something",
      artifact_bytes: 100,
    });

    const s = getRoleVersionStats(role.id)[0]!;
    expect(s.pass_rate).toBe(1);
    expect(s.degraded_rate).toBe(1);
  });

  it("flags an underpowered sample instead of presenting it as a verdict", () => {
    freshDb();
    const project = createProject({ name: "p", repo_path: "/tmp/p" });
    const task = createTask({ name: "t", project_id: project.id });
    const role = seedRole();
    const v1 = role.current_version_id!;

    for (let i = 0; i < MIN_RUNS_FOR_CONFIDENT_SCORE - 1; i++) runAgainst(task.task_id, v1);
    expect(getRoleVersionStats(role.id)[0]!.sample_warning).toBe(true);
    runAgainst(task.task_id, v1);
    expect(getRoleVersionStats(role.id)[0]!.sample_warning).toBe(false);
  });

  it("reports a version with no runs as zeroed rather than omitting it", () => {
    freshDb();
    const role = seedRole();
    const stats = getRoleVersionStats(role.id);
    expect(stats).toHaveLength(1);
    expect(stats[0]!.runs).toBe(0);
    expect(stats[0]!.pass_rate).toBe(0);
    expect(stats[0]!.loopback_rate).toBe(0); // no divide-by-zero
    expect(stats[0]!.sample_warning).toBe(true);
  });
});

describe("revertRoleToVersion", () => {
  it("creates a NEW version matching the old one rather than mutating history", () => {
    freshDb();
    const role = seedRole();
    const v1Id = role.current_version_id!;
    seedRole({ system_prompt: "v2 prompt" });
    const reverted = revertRoleToVersion(role.id, v1Id);

    expect(reverted.system_prompt).toBe("v1 prompt");
    const versions = listRoleVersions(role.id);
    expect(versions.map((v) => v.version_no)).toEqual([3, 2, 1]);
    expect(reverted.current_version_id).toBe(versions[0]!.id);
    expect(versions[0]!.created_by_note).toBe("reverted to v1");
    // The version we reverted away from is still there with its own identity —
    // "we tried that and it was worse" is information worth keeping.
    expect(versions[1]!.system_prompt).toBe("v2 prompt");
    expect(versions[2]!.id).toBe(v1Id);
  });

  it("keeps the reverted-away version's score attributable to it", () => {
    freshDb();
    const project = createProject({ name: "p", repo_path: "/tmp/p" });
    const task = createTask({ name: "t", project_id: project.id });
    const role = seedRole();
    const v1Id = role.current_version_id!;
    const v2 = seedRole({ system_prompt: "v2 prompt" });
    runAgainst(task.task_id, v2.current_version_id!, { verdict: "blocker" });
    revertRoleToVersion(role.id, v1Id);

    const stats = getRoleVersionStats(role.id);
    const v2Score = stats.find((s) => s.version_id === v2.current_version_id)!;
    expect(v2Score.runs).toBe(1);
    expect(v2Score.pass_rate).toBe(0);
    expect(v2Score.is_current).toBe(false);
  });

  it("refuses a version id that belongs to a different role", () => {
    freshDb();
    const explorer = seedRole();
    const other = upsertRole({ project_id: null, key: "critic", system_prompt: "critic prompt" });
    expect(() => revertRoleToVersion(explorer.id, other.current_version_id!)).toThrow(/not found/i);
  });
});

describe("project override vs global role histories", () => {
  it("keeps separate histories — an override doesn't rewrite the global's past", () => {
    freshDb();
    const project = createProject({ name: "p", repo_path: "/tmp/p" });
    const global = seedRole();
    const override = upsertRole({
      project_id: project.id,
      key: "explorer",
      system_prompt: "project-specific prompt",
    });

    expect(override.id).not.toBe(global.id);
    expect(listRoleVersions(global.id)).toHaveLength(1);
    expect(listRoleVersions(override.id)).toHaveLength(1);
    expect(listRoleVersions(global.id)[0]!.system_prompt).toBe("v1 prompt");
    // getRole merges globals under project rows — the override wins, and its
    // id is the one a version panel must query.
    expect(getRole(project.id, "explorer")!.id).toBe(override.id);
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM role_versions`).get()).toEqual({ n: 2 });
  });
});
