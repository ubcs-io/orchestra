import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { resetConfig } from "../src/config";
import {
  closeDb,
  countGlobalRoles,
  createIntervention,
  createProject,
  createRoleRun,
  createTask,
  familyMembersExcluding,
  familyRootId,
  getDb,
  getGlobalConfig,
  getProject,
  getTask,
  initDb,
  listRoleRuns,
  listRoles,
  listTasks,
  listUnconsumedInterventions,
  markInterventionConsumed,
  updateProject,
  updateTask,
  upsertConfig,
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

  it("a legacy task (root_task_id null) resolves its own id as root and doesn't share a family with new children", () => {
    freshDb();
    const legacyRoot = createTask({ name: "predates the column" });
    updateTask(legacyRoot.task_id, {}); // no-op, just ensures the row round-trips
    // Simulate a pre-migration row directly, since createTask always sets it now.
    getDb().prepare("UPDATE tasks SET root_task_id = NULL WHERE task_id = ?").run(legacyRoot.task_id);
    const stale = getTask(legacyRoot.task_id)!;
    expect(familyRootId(stale)).toBe(stale.task_id);

    const child = createTask({ name: "new child of a legacy parent", parent_task_id: stale.task_id, task_type: "child" });
    // getTask(parent)?.root_task_id is null, so the child gets its own
    // standalone family too — no retroactive sharing with the legacy parent.
    expect(child.root_task_id).toBeNull();
    expect(familyRootId(child)).toBe(child.task_id);
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

  it("tracks unconsumed interventions until marked", () => {
    freshDb();
    const t = createTask({ name: "t" });
    const iv = createIntervention({ task_id: t.task_id, kind: "pause" });
    expect(listUnconsumedInterventions(t.task_id).length).toBe(1);
    markInterventionConsumed(iv.id);
    expect(listUnconsumedInterventions(t.task_id).length).toBe(0);
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
