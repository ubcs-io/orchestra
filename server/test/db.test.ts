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
    // No rows yet: falls back to the bootstrap config default ("deepseek").
    expect(resolveConnection().thinkingFormat).toBe("deepseek");

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
