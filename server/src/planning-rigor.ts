/**
 * Planning rigor: how much the family-wide decomposition budget (see
 * orchestrator.ts's resolveFamilyBudget/EFFORT_BUDGET) is scaled up or down
 * relative to a task's effort_size — "minimal" (×0.6, favor fewer/smaller
 * subtasks and skip straight to execution more readily), "standard" (×1,
 * default), or "thorough" (×1.5, allow more structure/review even for small
 * work). Independent of effort_size itself: size answers "how big is this
 * really," rigor answers "how much process do you want applied per unit of
 * size."
 *
 * Named "planning_rigor" (not "rigor") specifically to avoid colliding with
 * two other unrelated existing uses of that word in this codebase: the fixed
 * per-intake-kind `rigor` tag on FLOW_TEMPLATES (roles.ts), and the
 * counter-reviewer gate rigor surfaced read-only in the UI (routes/safety.ts,
 * client Settings.tsx/TaskDetail.tsx).
 *
 * A project-level default lives at `config_json.planningRigor`. A task-level
 * override lives on `tasks.planning_rigor` (null = inherit the project
 * default) — mirrors autonomy-level.ts's plain-column-fallback shape exactly.
 */

import type { ProjectRow, TaskRow } from "./db.js";

export type PlanningRigor = "minimal" | "standard" | "thorough";

/** Today's status quo: no scaling, the budget table's own numbers apply as-is. */
export const DEFAULT_PLANNING_RIGOR: PlanningRigor = "standard";

function isPlanningRigor(value: unknown): value is PlanningRigor {
  return value === "minimal" || value === "standard" || value === "thorough";
}

/** The project's own default, silently degrading to DEFAULT_PLANNING_RIGOR on
 *  anything unexpected (missing key, malformed JSON, garbage value) — same
 *  contract as resolveAutonomyLevel/resolveAutonomyConfig. */
export function resolvePlanningRigor(projectConfigJson: string | null): PlanningRigor {
  if (!projectConfigJson) return DEFAULT_PLANNING_RIGOR;
  try {
    const parsed = JSON.parse(projectConfigJson) as { planningRigor?: unknown };
    return isPlanningRigor(parsed.planningRigor) ? parsed.planningRigor : DEFAULT_PLANNING_RIGOR;
  } catch {
    return DEFAULT_PLANNING_RIGOR;
  }
}

export type PlanningRigorValidation =
  | { ok: true; rigor: PlanningRigor }
  | { ok: false; error: string };

/** Save-time validation: unlike {@link resolvePlanningRigor} (which silently
 *  degrades), this REPORTS the problem so an editor in the UI finds out why a
 *  PATCH was rejected. */
export function validatePlanningRigor(raw: unknown): PlanningRigorValidation {
  if (!isPlanningRigor(raw)) {
    return { ok: false, error: `planning rigor must be one of "minimal", "standard", "thorough"` };
  }
  return { ok: true, rigor: raw };
}

/** The one function every call site should use — a task's own override, if
 *  set to a valid rigor, wins; otherwise the project's default. */
export function effectivePlanningRigor(task: TaskRow, project: ProjectRow): PlanningRigor {
  return isPlanningRigor(task.planning_rigor) ? task.planning_rigor : resolvePlanningRigor(project.config_json);
}
