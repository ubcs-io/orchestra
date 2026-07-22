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
  return (
    <button
      type="button"
      className={`card card--button${isActive ? " card--processing" : ""}`}
      onClick={onClick}
    >
      <div className="title">{family.root.name ?? family.root.task_id.slice(0, 8)}</div>
      <div className="meta">
        {family.root.git_branch && <span className="pill dim">{family.root.git_branch}</span>}
        <span className="pill dim">
          {family.members.length} task{family.members.length === 1 ? "" : "s"}
        </span>
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
