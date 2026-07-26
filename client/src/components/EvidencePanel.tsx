import { useState } from "react";
import { isEvidenceGreen, type ExecEvidence } from "../api";

/**
 * Verification evidence table (PLANNING/overhaul/05).
 *
 * Renders the commands a role actually ran in its task worktree, with the exit
 * code and captured output. These rows are written by the server's executor,
 * not by a model — which is the whole reason this panel exists: at the merge
 * gate the human is approving a diff *plus a green run*, not a diff plus an
 * opinion. Failing runs open by default; passing ones stay one line.
 */
export function EvidencePanel({
  evidence,
  title = "Verification evidence",
  compact = false,
}: {
  evidence: ExecEvidence[];
  title?: string;
  /** Drop the heading and the "recorded by the platform" note — for embedding
   *  inside a run card that already has its own framing. */
  compact?: boolean;
}) {
  if (!evidence.length) return null;
  const allGreen = evidence.every(isEvidenceGreen);
  return (
    <div style={{ margin: compact ? "8px 0" : "12px 0" }}>
      {!compact && (
        <div className="row" style={{ justifyContent: "flex-start", gap: 8, marginBottom: 6 }}>
          <strong style={{ fontSize: 12 }}>{title}</strong>
          <span className={`pill ${allGreen ? "ok" : "bad"}`} style={{ fontSize: 10 }}>
            {allGreen ? "all green" : "not passing"}
          </span>
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {evidence.map((e, i) => (
          <EvidenceRow key={`${e.name}-${e.startedAt}-${i}`} evidence={e} />
        ))}
      </div>
      {!compact && (
        <p className="muted" style={{ fontSize: 10, marginTop: 6 }}>
          Recorded by the platform when the command ran — not self-reported by the model.
        </p>
      )}
    </div>
  );
}

function statusOf(e: ExecEvidence): { label: string; cls: string } {
  if (e.spawnError) return { label: "could not start", cls: "bad" };
  if (e.timedOut) return { label: "timed out", cls: "bad" };
  if (e.exitCode === 0) return { label: "exit 0", cls: "ok" };
  if (e.exitCode == null) return { label: `killed (${e.signal ?? "signal"})`, cls: "bad" };
  return { label: `exit ${e.exitCode}`, cls: "bad" };
}

function EvidenceRow({ evidence: e }: { evidence: ExecEvidence }) {
  const green = isEvidenceGreen(e);
  // A red run's output is the thing the reviewer came for; a green run's is noise.
  const [open, setOpen] = useState(!green);
  const status = statusOf(e);
  const hasOutput = !!e.outputTail.trim() || !!e.spawnError;

  return (
    <div
      style={{
        border: "1px solid var(--border, #333)",
        borderRadius: 6,
        padding: "6px 8px",
        background: green ? "transparent" : "rgba(200, 60, 60, 0.06)",
      }}
    >
      <div className="row" style={{ justifyContent: "flex-start", gap: 8, flexWrap: "wrap" }}>
        <span className={`pill ${status.cls}`} style={{ fontSize: 10 }}>
          {status.label}
        </span>
        <strong style={{ fontSize: 12 }}>{e.name}</strong>
        <code style={{ fontSize: 11, opacity: 0.75 }}>{e.argv.join(" ")}</code>
        <span className="muted" style={{ fontSize: 10 }}>
          {(e.durationMs / 1000).toFixed(1)}s
        </span>
        {hasOutput && (
          <button
            className="small"
            style={{ marginLeft: "auto", fontSize: 10 }}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "hide output" : "show output"}
          </button>
        )}
      </div>
      {open && hasOutput && (
        <pre
          style={{
            marginTop: 6,
            marginBottom: 0,
            maxHeight: 320,
            overflow: "auto",
            fontSize: 11,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {e.spawnError ? `could not start: ${e.spawnError}` : e.outputTail}
          {e.truncated && "\n\n(output was truncated by the harness output cap)"}
        </pre>
      )}
    </div>
  );
}
