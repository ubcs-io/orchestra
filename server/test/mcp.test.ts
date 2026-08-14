import { afterEach, describe, expect, it } from "vitest";
import {
  closeDb,
  createProject,
  createRoleRun,
  createTask,
  upsertRole,
  type ProjectRow,
} from "../src/db";
import { getTaskContext } from "../src/mcp-context";
import { freshDb, tempGitRepo } from "./helpers";

afterEach(() => {
  closeDb();
});

function withProject(): ProjectRow {
  freshDb();
  const repo = tempGitRepo();
  return createProject({ name: "test", repo_path: repo });
}

describe("getTaskContext", () => {
  it("returns null for an unknown task id", () => {
    withProject();
    expect(getTaskContext("does-not-exist")).toBeNull();
  });

  it("resolves the pending role from a fresh plan, with role title/prompt", () => {
    const project = withProject();
    upsertRole({
      project_id: null,
      key: "explorer",
      title: "Explorer",
      system_prompt: "Explore the repo.",
    });
    const task = createTask({
      name: "t1",
      project_id: project.id,
      refinement_plan_json: JSON.stringify({
        steps: [
          { role: "explorer", status: "pending", depth: 1 },
          { role: "decomposition", status: "pending", depth: 1 },
        ],
      }),
    });

    const ctx = getTaskContext(task.task_id);
    expect(ctx?.pendingRole).toEqual({
      key: "explorer",
      title: "Explorer",
      prompt: "Explore the repo.",
    });
  });

  it("returns a null pendingRole once every step is done", () => {
    const project = withProject();
    const task = createTask({
      name: "t2",
      project_id: project.id,
      refinement_plan_json: JSON.stringify({
        steps: [{ role: "explorer", status: "done", depth: 1 }],
      }),
    });
    createRoleRun({ task_id: task.task_id, role_key: "explorer", verdict: "pass" });

    expect(getTaskContext(task.task_id)?.pendingRole).toBeNull();
  });

  it("returns [] acceptanceCriteria when the task has none set", () => {
    const project = withProject();
    const task = createTask({ name: "t3", project_id: project.id });
    expect(getTaskContext(task.task_id)?.acceptanceCriteria).toEqual([]);
  });

  it("parses acceptanceCriteria when set", () => {
    const project = withProject();
    const task = createTask({
      name: "t4",
      project_id: project.id,
      acceptance_criteria: JSON.stringify(["must handle empty input", "must not leak secrets"]),
    });
    expect(getTaskContext(task.task_id)?.acceptanceCriteria).toEqual([
      "must handle empty input",
      "must not leak secrets",
    ]);
  });

  it("returns empty artifact content when artifact_path is set but nothing was ever written", () => {
    const project = withProject();
    const task = createTask({
      name: "t5",
      project_id: project.id,
      artifact_path: "PLANNING/REFINING/t5.md",
    });
    const ctx = getTaskContext(task.task_id);
    expect(ctx?.artifact).toEqual({ path: "PLANNING/REFINING/t5.md", content: "" });
  });

  it("returns a full taxonomy-keyed 'never' coverage map when no role run recorded coverage", () => {
    const project = withProject();
    const task = createTask({ name: "t6", project_id: project.id });
    const ctx = getTaskContext(task.task_id);
    expect(ctx?.coverage.correctness).toEqual({ status: "never" });
    expect(ctx?.coverage.security).toEqual({ status: "never" });
    expect(Object.keys(ctx?.coverage ?? {})).toEqual(ctx?.concernTaxonomy);
  });

  it("aggregates open questions across role runs with their originating role key, incl. legacy string form", () => {
    const project = withProject();
    const task = createTask({ name: "t7", project_id: project.id });
    createRoleRun({
      task_id: task.task_id,
      role_key: "explorer",
      open_questions_json: JSON.stringify([
        { question: "which auth flow?", assumed_answer: "OAuth", confidence: "medium", resolved: "assumed" },
      ]),
    });
    createRoleRun({
      task_id: task.task_id,
      role_key: "architecture_review",
      open_questions_json: JSON.stringify(["a legacy plain-string question"]),
    });

    const ctx = getTaskContext(task.task_id);
    expect(ctx?.openQuestions).toEqual([
      {
        question: "which auth flow?",
        assumed_answer: "OAuth",
        confidence: "medium",
        resolved: "assumed",
        roleKey: "explorer",
      },
      {
        question: "a legacy plain-string question",
        assumed_answer: "",
        confidence: "low",
        resolved: "assumed",
        roleKey: "architecture_review",
      },
    ]);
  });
});
