import type { Task } from "./api";

export interface RelationGroup {
  rootId: string;
  color: string;
}

/** Saturated "primary" colors distinct from the semantic pill colors (--ok/--warn/--bad/--human). */
const REL_COLORS = [
  "#e0574f", // coral
  "#4fa8e0", // sky blue
  "#e0c04f", // amber
  "#4fe0b0", // teal
  "#9d6fe0", // violet
  "#e08a4f", // orange
  "#6fe073", // lime green
  "#e04f9d", // pink
];

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function colorForGroup(rootId: string): string {
  return REL_COLORS[hashString(rootId) % REL_COLORS.length];
}

function findRoot(taskId: string, parentOf: Map<string, string | null>): string {
  const seen = new Set<string>();
  let id = taskId;
  while (!seen.has(id)) {
    seen.add(id);
    const parent = parentOf.get(id);
    if (!parent || !parentOf.has(parent)) return id;
    id = parent;
  }
  return id;
}

/** Groups tasks by shared root ancestor (walking parent_task_id). Only families with >1 member are returned. */
export function buildRelationGroups(tasks: Task[]): Map<string, RelationGroup> {
  const parentOf = new Map<string, string | null>();
  for (const t of tasks) parentOf.set(t.task_id, t.parent_task_id);

  const rootOf = new Map<string, string>();
  for (const t of tasks) rootOf.set(t.task_id, findRoot(t.task_id, parentOf));

  const rootCounts = new Map<string, number>();
  for (const root of rootOf.values()) rootCounts.set(root, (rootCounts.get(root) ?? 0) + 1);

  const groups = new Map<string, RelationGroup>();
  for (const t of tasks) {
    const rootId = rootOf.get(t.task_id)!;
    if ((rootCounts.get(rootId) ?? 0) > 1) {
      groups.set(t.task_id, { rootId, color: colorForGroup(rootId) });
    }
  }
  return groups;
}

export interface WorktreeFamily {
  rootId: string;
  root: Task;
  members: Task[]; // includes the root
}

/** One entry per worktree family (a root task + all its descendants sharing
 *  one worktree/branch — see server/src/orchestrator.ts's ensureTaskWorkspace),
 *  including solo/no-children families — unlike buildRelationGroups above,
 *  which only returns groups with >1 member. Uses the denormalized
 *  root_task_id when present, falling back to the parent-walk (findRoot) for
 *  legacy tasks that predate that column. */
export function buildWorktreeFamilies(tasks: Task[]): Map<string, WorktreeFamily> {
  const parentOf = new Map<string, string | null>();
  for (const t of tasks) parentOf.set(t.task_id, t.parent_task_id);
  const byId = new Map(tasks.map((t) => [t.task_id, t]));

  const families = new Map<string, WorktreeFamily>();
  for (const t of tasks) {
    const rootId = t.root_task_id ?? findRoot(t.task_id, parentOf);
    let fam = families.get(rootId);
    if (!fam) {
      fam = { rootId, root: byId.get(rootId) ?? t, members: [] };
      families.set(rootId, fam);
    }
    fam.members.push(t);
  }
  return families;
}

export type WorktreeColumn = "in_progress" | "ready_for_review" | "done";

/** Derives a worktree family's kanban column from the aggregate state of
 *  ALL its members, not just the root — in the common epic→story→task
 *  decomposition shape, the root often reaches stage "ready" right after
 *  decomposition while the human-actionable signal (stage "review") sits on
 *  a leaf child. */
export function familyColumn(fam: WorktreeFamily): WorktreeColumn {
  if (fam.members.some((m) => m.stage === "intake" || m.stage === "refining")) return "in_progress";
  if (fam.members.some((m) => m.stage === "review")) return "ready_for_review";
  const rs = fam.root.reconcile_status;
  if (rs === "merged" || rs === "up_to_date") return "done";
  return "ready_for_review"; // settled but not yet reconciled/flagged — still needs eyes
}

export interface BlockedDep {
  task_id: string;
  name: string | null;
  stage: string | null;
}

/** Mirrors the server's dependenciesSatisfied() (server/src/orchestrator.ts) — a task
 *  can't be scheduled until every id in its depends_on_json reaches stage "ready".
 *  Returns null when the task isn't blocked (no deps, or all satisfied). */
export function blockedDeps(
  task: Pick<Task, "depends_on_json">,
  byId: Map<string, Pick<Task, "task_id" | "name" | "stage">>,
): BlockedDep[] | null {
  if (!task.depends_on_json) return null;
  let ids: string[];
  try {
    ids = JSON.parse(task.depends_on_json) as string[];
  } catch {
    return null;
  }
  const unmet = ids
    .map((id) => byId.get(id))
    .filter((dep): dep is Pick<Task, "task_id" | "name" | "stage"> => !!dep && dep.stage !== "ready")
    .map((dep) => ({ task_id: dep.task_id, name: dep.name, stage: dep.stage }));
  return unmet.length > 0 ? unmet : null;
}
