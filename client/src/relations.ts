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
