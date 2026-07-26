import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLANNING_RIGOR,
  effectivePlanningRigor,
  resolvePlanningRigor,
  validatePlanningRigor,
} from "../src/planning-rigor";
import type { ProjectRow, TaskRow } from "../src/db";

function fakeProject(config_json: string | null): ProjectRow {
  return { config_json } as ProjectRow;
}

function fakeTask(planning_rigor: string | null): TaskRow {
  return { planning_rigor } as TaskRow;
}

describe("resolvePlanningRigor", () => {
  it("defaults to standard when config_json is null/missing the key", () => {
    expect(resolvePlanningRigor(null)).toBe("standard");
    expect(resolvePlanningRigor("{}")).toBe("standard");
  });

  it("reads a valid planningRigor key", () => {
    expect(resolvePlanningRigor(JSON.stringify({ planningRigor: "thorough" }))).toBe("thorough");
  });

  it("silently degrades to the default on malformed JSON or a garbage value", () => {
    expect(resolvePlanningRigor("not json")).toBe(DEFAULT_PLANNING_RIGOR);
    expect(resolvePlanningRigor(JSON.stringify({ planningRigor: "extreme" }))).toBe(DEFAULT_PLANNING_RIGOR);
  });
});

describe("validatePlanningRigor", () => {
  it("accepts the three known levels", () => {
    for (const rigor of ["minimal", "standard", "thorough"]) {
      expect(validatePlanningRigor(rigor)).toEqual({ ok: true, rigor });
    }
  });

  it("reports (not silently degrades) an invalid value", () => {
    const result = validatePlanningRigor("extreme");
    expect(result.ok).toBe(false);
  });
});

describe("effectivePlanningRigor", () => {
  it("prefers a valid task-level override over the project default", () => {
    const task = fakeTask("minimal");
    const project = fakeProject(JSON.stringify({ planningRigor: "thorough" }));
    expect(effectivePlanningRigor(task, project)).toBe("minimal");
  });

  it("falls back to the project default when the task has no override", () => {
    const task = fakeTask(null);
    const project = fakeProject(JSON.stringify({ planningRigor: "thorough" }));
    expect(effectivePlanningRigor(task, project)).toBe("thorough");
  });

  it("falls back to the project default when the task's stored override is garbage", () => {
    const task = fakeTask("extreme");
    const project = fakeProject(null);
    expect(effectivePlanningRigor(task, project)).toBe(DEFAULT_PLANNING_RIGOR);
  });
});
