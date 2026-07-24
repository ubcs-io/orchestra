import { familyColumn, type WorktreeColumn, type WorktreeFamily } from "../relations";

const COLUMNS: Array<{ key: WorktreeColumn; label: string }> = [
  { key: "in_progress", label: "In Progress" },
  { key: "ready_for_review", label: "Ready for Review" },
  { key: "done", label: "Done" },
];

const RECONCILE_PILL: Record<string, string> = {
  merged: "ok",
  up_to_date: "ok",
  conflict: "bad",
  error: "bad",
  pending_human_merge: "human",
};

function WorktreeCard({
  family,
  isActive,
  onClick,
}: {
  family: WorktreeFamily;
  isActive: boolean;
  onClick: () => void;
}) {
  const rs = family.root.reconcile_status;
  // Aggregate run-health across the family (overhaul/04 §2): total degraded/empty
  // runs, and whether any member's *latest* run degraded — the latter flags the
  // card so a human scanning the board sees exactly where trust is currently low.
  const degradedCount = family.members.reduce((n, m) => n + (m.degraded_runs ?? 0), 0);
  const latestDegraded = family.members.some(
    (m) => m.latest_health === "degraded" || m.latest_health === "empty",
  );
  return (
    <button
      type="button"
      className={`card card--button${isActive ? " card--processing" : ""}${latestDegraded ? " card--degraded" : ""}`}
      onClick={onClick}
    >
      <div className="title">{family.root.name ?? family.root.task_id.slice(0, 8)}</div>
      <div className="meta">
        {family.root.git_branch && <span className="pill dim">{family.root.git_branch}</span>}
        <span className="pill dim">
          {family.members.length} task{family.members.length === 1 ? "" : "s"}
        </span>
        {degradedCount > 0 && (
          <span
            className={`pill ${latestDegraded ? "bad" : "warn"}`}
            title="Degraded/empty runs in this worktree — the output may be salvaged or incomplete"
          >
            {degradedCount} degraded
          </span>
        )}
        {rs && <span className={`pill ${RECONCILE_PILL[rs] ?? "dim"}`}>{rs.replace(/_/g, " ")}</span>}
      </div>
    </button>
  );
}

export function WorktreeKanban({
  families,
  activeTaskIds,
  onSelect,
}: {
  families: WorktreeFamily[];
  activeTaskIds: Set<string>;
  onSelect: (rootId: string) => void;
}) {
  if (families.length === 0) return null;
  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <h2>Active Worktrees</h2>
      <div className="kanban" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
        {COLUMNS.map((col) => {
          const inCol = families.filter((f) => familyColumn(f) === col.key);
          return (
            <div className="col" key={col.key}>
              <h3>
                {col.label} ({inCol.length})
              </h3>
              <div className="cards">
                {inCol.map((f) => (
                  <WorktreeCard
                    key={f.rootId}
                    family={f}
                    isActive={f.members.some((m) => activeTaskIds.has(m.task_id))}
                    onClick={() => onSelect(f.rootId)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
