/**
 * Autonomy level: how far a task's own pipeline may progress unattended —
 * "plan" (stop before any code is written), "edit" (write code, always park
 * for an explicit human merge approval — today's status quo default), or
 * "auto" (write code, and once the task's own checks pass, attempt to merge
 * automatically instead of waiting on a human).
 *
 * A project-level default lives at `config_json.autonomyLevel` — a plain
 * string, sibling to (NOT nested inside) the unrelated `config_json.autonomy`
 * sub-key (see autonomy.ts), which governs a completely different axis:
 * whether/when watcher-originated work may be scheduled at all. A task-level
 * override lives on `tasks.autonomy_level` (null = inherit the project
 * default), mirroring the plain-column-fallback shape of
 * `task.model || project.default_model` rather than the JSON-blob-resolver
 * shape `autonomy.ts` uses — but still funneled through one shared resolver
 * function (`effectiveAutonomyLevel`) rather than inlined at each call site,
 * since a stray/legacy value in the column must degrade safely rather than
 * propagate garbage into a merge decision.
 */

import type { ProjectRow, TaskRow } from "./db.js";

export type AutonomyLevel = "plan" | "edit" | "auto";

/** Today's status quo: write code, always park for human merge approval. */
export const DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = "edit";

function isAutonomyLevel(value: unknown): value is AutonomyLevel {
  return value === "plan" || value === "edit" || value === "auto";
}

/** The project's own default, silently degrading to DEFAULT_AUTONOMY_LEVEL on
 *  anything unexpected (missing key, malformed JSON, garbage value) — same
 *  contract as resolveAutonomyConfig/resolveHarnessPolicy. */
export function resolveAutonomyLevel(projectConfigJson: string | null): AutonomyLevel {
  if (!projectConfigJson) return DEFAULT_AUTONOMY_LEVEL;
  try {
    const parsed = JSON.parse(projectConfigJson) as { autonomyLevel?: unknown };
    return isAutonomyLevel(parsed.autonomyLevel) ? parsed.autonomyLevel : DEFAULT_AUTONOMY_LEVEL;
  } catch {
    return DEFAULT_AUTONOMY_LEVEL;
  }
}

export type AutonomyLevelValidation =
  | { ok: true; level: AutonomyLevel }
  | { ok: false; error: string };

/** Save-time validation: unlike {@link resolveAutonomyLevel} (which silently
 *  degrades), this REPORTS the problem so an editor in the UI finds out why a
 *  PATCH was rejected. */
export function validateAutonomyLevel(raw: unknown): AutonomyLevelValidation {
  if (!isAutonomyLevel(raw)) {
    return { ok: false, error: `autonomy level must be one of "plan", "edit", "auto"` };
  }
  return { ok: true, level: raw };
}

/** The one function every call site should use — a task's own override, if
 *  set to a valid level, wins; otherwise the project's default. */
export function effectiveAutonomyLevel(task: TaskRow, project: ProjectRow): AutonomyLevel {
  return isAutonomyLevel(task.autonomy_level) ? task.autonomy_level : resolveAutonomyLevel(project.config_json);
}
