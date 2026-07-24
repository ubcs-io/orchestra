import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api, type Candidate, type Task } from "../api";

/**
 * The watcher/autonomy audit trail (PLANNING/overhaul/08): what a watcher has
 * found and what triage decided, whether or not it became a task. Occupies
 * the "Signals" tab in ProjectBoard's intake area — see that file for the tab
 * switching logic. Two sections: self-generated tasks not yet glanced (the
 * former standalone "New self-generated" panel, relocated here), and the
 * recent candidate feed (queued/rejected/capped/suppressed), which previously
 * had no UI at all despite the full row existing server-side.
 */
export function SignalsPanel({
  projectId,
  unglancedWatcherTasks,
  markGlanced,
  markAllGlanced,
}: {
  projectId: number;
  unglancedWatcherTasks: Task[];
  markGlanced: (taskId: string) => void;
  markAllGlanced: () => void;
}) {
  const candidatesQ = useQuery({
    queryKey: ["candidates", projectId],
    queryFn: () => api.candidates(projectId, undefined, 50),
    enabled: Number.isFinite(projectId),
    refetchInterval: 6000,
  });
  const candidates = candidatesQ.data?.candidates ?? [];

  return (
    <div>
      {unglancedWatcherTasks.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h3 style={{ margin: 0, fontSize: 12, color: "var(--ink-dim)", textTransform: "uppercase", letterSpacing: 1 }}>
              New self-generated ({unglancedWatcherTasks.length})
            </h3>
            <button className="small" onClick={markAllGlanced}>
              Mark all seen
            </button>
          </div>
          <div className="cards" style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6 }}>
            {unglancedWatcherTasks.map((t) => (
              <Link
                key={t.task_id}
                to="/tasks/$taskId"
                params={{ taskId: t.task_id }}
                className="card"
                style={{ display: "block", color: "inherit" }}
                onClick={() => markGlanced(t.task_id)}
              >
                <div className="title">{t.name ?? t.task_id.slice(0, 8)}</div>
                <div className="meta">
                  <span className="pill dim">{t.intake_kind ?? t.level}</span>
                  <span className="pill dim">🤖 {(t.origin ?? "").slice("watcher:".length)}</span>
                  <span className="pill dim">{t.stage}</span>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}

      <h3 style={{ margin: "0 0 8px", fontSize: 12, color: "var(--ink-dim)", textTransform: "uppercase", letterSpacing: 1 }}>
        Recent signals
      </h3>
      {candidatesQ.isLoading && <p className="muted">Loading…</p>}
      {!candidatesQ.isLoading && candidates.length === 0 && (
        <p className="muted">
          No watcher activity yet. Once a watcher finds something, it shows up here — whether or not it clears triage.
        </p>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {candidates.map((c) => (
          <CandidateRow key={c.id} candidate={c} />
        ))}
      </div>
    </div>
  );
}

function statusMeta(status: string): { label: string; cls: string } {
  switch (status) {
    case "queued":
      return { label: "queued", cls: "ok" };
    case "rejected":
      return { label: "rejected", cls: "dim" };
    case "capped":
      return { label: "capped", cls: "warn" };
    case "suppressed":
      return { label: "suppressed", cls: "dim" };
    default:
      return { label: status, cls: "dim" };
  }
}

function CandidateRow({ candidate }: { candidate: Candidate }) {
  const [open, setOpen] = useState(false);
  const status = statusMeta(candidate.status);

  let rationale: string | null = null;
  if (candidate.triage_json) {
    try {
      const parsed = JSON.parse(candidate.triage_json) as { rationale?: string };
      rationale = parsed.rationale ?? null;
    } catch {
      /* pre-triage or malformed — no rationale to show */
    }
  }
  const canExpand = !!rationale || !!candidate.suppressed_reason;

  return (
    <div
      className="card"
      style={{ cursor: canExpand ? "pointer" : "default" }}
      onClick={() => canExpand && setOpen((v) => !v)}
    >
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="row">
          <span className={`pill ${status.cls}`}>{status.label}</span>
          <strong style={{ fontSize: 12 }}>{candidate.watcher}</strong>
          <span className="muted" style={{ fontSize: 11 }}>
            {candidate.kind}
          </span>
        </div>
        <span className="muted" style={{ fontSize: 10 }}>
          {new Date(candidate.created_at).toLocaleString()}
        </span>
      </div>
      {candidate.task_id && (
        <div style={{ marginTop: 4 }}>
          <Link
            to="/tasks/$taskId"
            params={{ taskId: candidate.task_id }}
            onClick={(e) => e.stopPropagation()}
          >
            view task →
          </Link>
        </div>
      )}
      {open && rationale && (
        <p className="muted" style={{ marginTop: 6, fontSize: 12 }}>
          {rationale}
        </p>
      )}
      {open && candidate.suppressed_reason && (
        <p className="muted" style={{ marginTop: 6, fontSize: 12 }}>
          Suppressed: {candidate.suppressed_reason}
        </p>
      )}
    </div>
  );
}
