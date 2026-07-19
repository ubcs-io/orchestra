import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, type DiffFile, type Task } from "../api";

type DiffLine =
  | { type: "hunk"; text: string }
  | { type: "add" | "del" | "ctx"; text: string; oldLine?: number; newLine?: number };

/** Parse unified diff text into renderable lines. Everything before the first
 *  `@@` hunk marker — `diff --git`, `index`, `+++`/`---`, and (for
 *  added/deleted/renamed files) `new file mode` / `deleted file mode` /
 *  `similarity index` / `rename from|to` etc. — is git's file header, not
 *  content; it's skipped wholesale rather than pattern-matched line by line
 *  so an unrecognized header line can't get misparsed as a diff line (its
 *  first character sliced off and treated as a context row). A patch with no
 *  `@@` at all (e.g. a pure rename with no content change) yields no lines. */
function parseUnifiedDiff(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) {
      inHunk = true;
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (m) {
        oldLine = Number(m[1]);
        newLine = Number(m[2]);
      }
      out.push({ type: "hunk", text: raw });
    } else if (!inHunk) {
      // git's file header, before any hunk — not diff content.
    } else if (raw.startsWith("\\")) {
      // "\ No newline at end of file"
    } else if (raw.startsWith("+")) {
      out.push({ type: "add", text: raw.slice(1), newLine });
      newLine++;
    } else if (raw.startsWith("-")) {
      out.push({ type: "del", text: raw.slice(1), oldLine });
      oldLine++;
    } else if (raw) {
      out.push({ type: "ctx", text: raw.slice(1), oldLine, newLine });
      oldLine++;
      newLine++;
    }
  }
  return out;
}

export function FileDiff({ patch }: { patch: string }) {
  const lines = useMemo(() => parseUnifiedDiff(patch), [patch]);
  if (lines.length === 0) return <p className="muted" style={{ padding: "6px 10px" }}>No changes.</p>;
  return (
    <div className="diff-body">
      {lines.map((l, i) =>
        l.type === "hunk" ? (
          <div key={i} className="diff-line diff-hunk">{l.text}</div>
        ) : (
          <div key={i} className={`diff-line diff-${l.type}`}>
            <span className="diff-line-no">{l.oldLine ?? ""}</span>
            <span className="diff-line-no">{l.newLine ?? ""}</span>
            <span className="diff-line-marker">{l.type === "add" ? "+" : l.type === "del" ? "-" : ""}</span>
            <span className="diff-line-text">{l.text}</span>
          </div>
        ),
      )}
    </div>
  );
}

export const STATUS_PILL: Record<DiffFile["status"], string> = {
  added: "ok",
  deleted: "bad",
  modified: "dim",
  renamed: "human",
  copied: "human",
};
export const STATUS_LABEL: Record<DiffFile["status"], string> = {
  added: "A",
  deleted: "D",
  modified: "M",
  renamed: "R",
  copied: "C",
};

export function DiffFileRow({
  queryKey,
  file,
  expanded,
  onToggle,
  fetchPatch,
}: {
  /** React-query cache key prefix — scopes the patch cache per task or per run. */
  queryKey: unknown[];
  file: DiffFile;
  expanded: boolean;
  onToggle: () => void;
  fetchPatch: (file: DiffFile) => Promise<{ path: string; patch: string }>;
}) {
  const fileQ = useQuery({
    queryKey: [...queryKey, file.path, file.oldPath],
    queryFn: () => fetchPatch(file),
    enabled: expanded && !file.binary,
  });

  return (
    <div className="diff-file">
      <button type="button" className="diff-file-header" onClick={onToggle}>
        <span className={`pill ${STATUS_PILL[file.status]}`}>{STATUS_LABEL[file.status]}</span>
        <span className="diff-file-path">
          {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        {file.binary ? (
          <span className="pill dim">binary</span>
        ) : (
          <span className="diff-file-stats">
            <span className="diff-add">+{file.additions}</span> <span className="diff-del">-{file.deletions}</span>
          </span>
        )}
      </button>
      {expanded && !file.binary && (
        <div className="diff-file-body">
          {fileQ.isLoading ? (
            <p className="muted" style={{ padding: "6px 10px" }}>Loading…</p>
          ) : fileQ.isError ? (
            <p className="pill bad" style={{ margin: "6px 10px" }}>Failed to load diff.</p>
          ) : (
            <FileDiff patch={fileQ.data?.patch ?? ""} />
          )}
        </div>
      )}
    </div>
  );
}

export interface DiffPanelProps {
  taskId: string;
  task: Task;
  projectHasGithubToken: boolean;
  onClose: () => void;
  onMutate: () => void;
}

/** Modal: shows the file-level diff between a task's branch and its base,
 *  and lets the user push the branch and/or open a PR once satisfied. */
export function DiffPanel({ taskId, task, projectHasGithubToken, onClose, onMutate }: DiffPanelProps) {
  const diffQ = useQuery({ queryKey: ["taskDiff", taskId], queryFn: () => api.taskDiff(taskId) });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);

  const push = useMutation({
    mutationFn: () => api.githubPush(taskId),
    onError: (e: unknown) => setActionError(e instanceof Error ? e.message : "push failed"),
    onSuccess: () => {
      setActionError(null);
      onMutate();
    },
  });
  const openPr = useMutation({
    mutationFn: () => api.githubOpenPr(taskId),
    onError: (e: unknown) => setActionError(e instanceof Error ? e.message : "failed to open PR"),
    onSuccess: () => {
      setActionError(null);
      onMutate();
    },
  });

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const totals = diffQ.data?.files.reduce(
    (acc, f) => ({ additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions }),
    { additions: 0, deletions: 0 },
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal diff-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Review changes{task.git_branch ? ` — "${task.git_branch}"` : ""}</h3>

        {diffQ.isLoading && <p className="muted" style={{ margin: "12px 0" }}>Loading diff…</p>}
        {diffQ.isError && <p className="pill bad" style={{ margin: "12px 0" }}>Failed to load diff.</p>}

        {diffQ.data && (
          <>
            <p className="muted" style={{ margin: "8px 0 10px" }}>
              {diffQ.data.files.length} file{diffQ.data.files.length === 1 ? "" : "s"} changed
              {totals && (totals.additions > 0 || totals.deletions > 0) && (
                <>
                  {" · "}
                  <span className="diff-add">+{totals.additions}</span> <span className="diff-del">-{totals.deletions}</span>
                </>
              )}
            </p>
            {diffQ.data.files.length === 0 ? (
              <p className="muted">No differences from {diffQ.data.base}.</p>
            ) : (
              <div className="diff-file-list">
                {diffQ.data.files.map((f) => (
                  <DiffFileRow
                    key={f.path}
                    queryKey={["taskDiffFile", taskId]}
                    file={f}
                    expanded={expanded.has(f.path)}
                    onToggle={() => toggle(f.path)}
                    fetchPatch={(file) => api.taskDiffFile(taskId, file.path, file.oldPath)}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {actionError && <p className="pill bad" style={{ margin: "12px 0 0" }}>{actionError}</p>}
        {task.github_pr_url && (
          <p style={{ margin: "12px 0 0" }}>
            <a href={task.github_pr_url} target="_blank" rel="noreferrer">View PR ↗</a>
          </p>
        )}

        <div className="modal-actions">
          <button className="small" onClick={onClose}>Close</button>
          {projectHasGithubToken ? (
            <>
              <button className="small" disabled={push.isPending} onClick={() => push.mutate()}>
                {push.isPending ? "Pushing…" : push.isSuccess ? "Pushed ✓" : "Push branch"}
              </button>
              <button className="small primary" disabled={openPr.isPending} onClick={() => openPr.mutate()}>
                {openPr.isPending ? "Opening PR…" : task.github_pr_url ? "Push & update PR" : "Push & open PR"}
              </button>
            </>
          ) : (
            <span className="muted" style={{ fontSize: 12, alignSelf: "center" }}>
              Configure a GitHub token in project settings to push.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** Inline (non-modal) diff for a single role run, scoped against the previous
 *  run's checkpoint commit (or the task's base branch for the first commit).
 *  Rendered inside a run's panel in TaskDetail, not as an overlay. */
export function RunDiffSection({ taskId, runId }: { taskId: string; runId: number }) {
  const diffQ = useQuery({ queryKey: ["runDiff", taskId, runId], queryFn: () => api.runDiff(taskId, runId) });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const totals = diffQ.data?.files.reduce(
    (acc, f) => ({ additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions }),
    { additions: 0, deletions: 0 },
  );

  return (
    <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid var(--line)" }}>
      {diffQ.isLoading && <p className="muted">Loading diff…</p>}
      {diffQ.isError && <p className="pill bad">Failed to load diff.</p>}
      {diffQ.data && (
        <>
          <p className="muted" style={{ margin: "0 0 8px" }}>
            {diffQ.data.files.length} file{diffQ.data.files.length === 1 ? "" : "s"} changed in this step
            {totals && (totals.additions > 0 || totals.deletions > 0) && (
              <>
                {" · "}
                <span className="diff-add">+{totals.additions}</span> <span className="diff-del">-{totals.deletions}</span>
              </>
            )}
          </p>
          {diffQ.data.files.length === 0 ? (
            <p className="muted">No changes.</p>
          ) : (
            <div className="diff-file-list">
              {diffQ.data.files.map((f) => (
                <DiffFileRow
                  key={f.path}
                  queryKey={["runDiffFile", taskId, runId]}
                  file={f}
                  expanded={expanded.has(f.path)}
                  onToggle={() => toggle(f.path)}
                  fetchPatch={(file) => api.runDiffFile(taskId, runId, file.path, file.oldPath)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
