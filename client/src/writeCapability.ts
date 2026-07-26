import type { Role, Task, Plan } from "./api";

/** Mirrors server/src/harness-policy.ts's WRITE_TOOL_NAMES — same hand-copied-
 *  literal convention already used in RolesEditor.tsx. */
const WRITE_TOOL_NAMES = ["write", "edit"];

export function rolesWithWriteTools(roles: Role[]): Set<string> {
  const s = new Set<string>();
  for (const r of roles) {
    if (!r.tools_json) continue;
    try {
      const tools = JSON.parse(r.tools_json) as string[];
      if (tools.some((t) => WRITE_TOOL_NAMES.includes(t))) s.add(r.key);
    } catch {
      // ignore malformed tools_json
    }
  }
  return s;
}

export type WriteCapability = "acting" | "planning" | "pending";

/** "pending" = task hasn't been planned yet (no refinement_plan_json) — genuinely
 *  unknowable client-side without duplicating orchestrator.ts's withPromotedRoles,
 *  so callers should render nothing for it rather than guessing. */
export function taskWriteCapability(task: Task, allowWrite: boolean, writeRoles: Set<string>): WriteCapability {
  if (!allowWrite || writeRoles.size === 0) return "planning";
  if (!task.refinement_plan_json) return "pending";
  try {
    const plan = JSON.parse(task.refinement_plan_json) as Plan;
    return plan.steps.some((s) => writeRoles.has(s.role)) ? "acting" : "planning";
  } catch {
    return "planning";
  }
}
