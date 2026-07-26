import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type DiffFile } from "../api";
import type { WorktreeFamily } from "../relations";
import { FileDiff } from "./DiffPanel";
import { buildFileTree, FileTree } from "./FileTree";
import { ReviewCTA } from "./ReviewCTA";

/** Master-detail equivalent of DiffFileRow's lazy fetch-on-expand, adapted to
 *  fetch on file-select into the right pane instead of expanding inline.
 *  Reuses DiffPanel's FileDiff renderer verbatim — no new diff-rendering code. */
function FileDiffLoader({ taskId, file }: { taskId: string; file: DiffFile }) {
  const q = useQuery({
    queryKey: ["taskDiffFile", taskId, file.path, file.oldPath],
    queryFn: () => api.taskDiffFile(taskId, file.path, file.oldPath),
    enabled: !file.binary,
  });
  if (file.binary) return <p className="muted" style={{ padding: "6px 10px" }}>Binary file — no inline diff.</p>;
  if (q.isLoading) return <p className="muted" style={{ padding: "6px 10px" }}>Loading…</p>;
  if (q.isError) return <p className="pill bad" style={{ margin: "6px 10px" }}>Failed to load diff.</p>;
  return <FileDiff patch={q.data?.patch ?? ""} />;
}

/** A family member currently parked in review, with the detail data
 *  ReviewCTA needs to render its accept/merge or request-changes actions. */
function PendingReview({
  taskId,
  onMutate,
  onOpenDiff,
}: {
  taskId: string;
  onMutate: () => void;
  onOpenDiff: () => void;
}) {
  const detailQ = useQuery({ queryKey: ["task", taskId], queryFn: () => api.task(taskId) });
  if (!detailQ.data) return null;
  const { task, recap_md, coverage, runs, interventions, children } = detailQ.data;
  return (
    <ReviewCTA
      taskId={taskId}
      task={task}
      recapMd={recap_md}
      coverage={coverage}
      runs={runs}
      interventions={interventions}
      childTasks={children}
      onMutate={onMutate}
      onOpenDiff={onOpenDiff}
    />
  );
}

export function WorktreeDetailPane({
  family,
  onBack,
  onMutate,
}: {
  family: WorktreeFamily;
  onBack: () => void;
  onMutate: () => void;
}) {
  const rootId = family.rootId;
  const diffQ = useQuery({ queryKey: ["taskDiff", rootId], queryFn: () => api.taskDiff(rootId) });
  const tree = useMemo(() => (diffQ.data ? buildFileTree(diffQ.data.files) : null), [diffQ.data]);
  const [selectedFile, setSelectedFile] = useState<DiffFile | null>(null);
  const diffSectionId = `worktree-diff-${rootId}`;
  const scrollToDiff = () => {
    document.getElementById(diffSectionId)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // Per the "stack all pending reviews" decision: a decomposed family can
  // have more than one member simultaneously awaiting a human decision, so
  // every member currently in stage "review" gets its own ReviewCTA here,
  // not just the first found.
  const pendingReviewIds = family.members.filter((m) => m.stage === "review").map((m) => m.task_id);

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <button className="small" onClick={onBack}>
          ← Back to board
        </button>
        <h2 style={{ margin: 0 }}>
          {family.root.name ?? family.root.task_id.slice(0, 8)}{" "}
          {family.root.git_branch && <span className="pill dim">{family.root.git_branch}</span>}
        </h2>
      </div>

      {diffQ.isLoading && <p className="muted" style={{ margin: "12px 0" }}>Loading diff…</p>}
      {diffQ.isError && <p className="pill bad" style={{ margin: "12px 0" }}>Failed to load diff.</p>}

      {diffQ.data && (
        <div id={diffSectionId} className="worktree-detail-body">
          <div className="panel worktree-detail-tree">
            {tree && <FileTree tree={tree} selectedPath={selectedFile?.path} onSelect={setSelectedFile} />}
          </div>
          <div className="panel worktree-detail-diff">
            {selectedFile ? (
              <FileDiffLoader taskId={rootId} file={selectedFile} />
            ) : (
              <p className="muted" style={{ padding: "6px 10px" }}>Select a file to view its diff.</p>
            )}
          </div>
        </div>
      )}

      {pendingReviewIds.length > 0 && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 12 }}>
          {pendingReviewIds.map((taskId) => (
            <PendingReview key={taskId} taskId={taskId} onMutate={onMutate} onOpenDiff={scrollToDiff} />
          ))}
        </div>
      )}
    </div>
  );
}
