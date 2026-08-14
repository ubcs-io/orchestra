import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api, type MorningReport, type ReportTaskLine, type RunHealth } from "../api";

/**
 * The morning report (PLANNING/overhaul/08 §4) — what happened while nobody was
 * watching. Rendered from the server's deterministic rollup, not from generated
 * prose, so it can't be wrong about its own night.
 *
 * The presentation rule the doc insists on is visible here: the "Done" section
 * leads with harness-recorded evidence, and a task that finished on an
 * untrusted run is shown under "Needs you" rather than counted as done. The
 * server decides that; this component only renders the buckets it's given.
 */
const WINDOWS: { label: string; hours: number }[] = [
  { label: "Last 12h", hours: 12 },
  { label: "Last 24h", hours: 24 },
  { label: "Last 3d", hours: 72 },
  { label: "Last week", hours: 168 },
];

const HEALTH_CLASS: Record<RunHealth, string> = {
  verified: "ok",
  healthy: "ok",
  recovered: "warn",
  degraded: "bad",
  empty: "bad",
};

export function MorningReportPanel({ projectId }: { projectId: number }) {
  const [hours, setHours] = useState(24);
  const q = useQuery({
    queryKey: ["morning-report", projectId, hours],
    queryFn: () => api.morningReport(projectId, hours),
    enabled: Number.isFinite(projectId),
    refetchInterval: 60_000,
  });
  const report = q.data?.report;

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 12, color: "var(--ink-dim)", textTransform: "uppercase", letterSpacing: 1 }}>
          Morning report
        </h3>
        <div className="row" style={{ gap: 4 }}>
          {WINDOWS.map((w) => (
            <button
              key={w.hours}
              className={`small${hours === w.hours ? " primary" : ""}`}
              onClick={() => setHours(w.hours)}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {q.isLoading && <p className="muted">Loading…</p>}
      {q.isError && <p className="pill bad">{(q.error as Error).message}</p>}
      {report && <ReportBody report={report} />}
    </div>
  );
}

function ReportBody({ report }: { report: MorningReport }) {
  const degraded = report.healthCounts.degraded + report.healthCounts.empty;

  if (!report.runCount) {
    return (
      <p className="muted">
        Nothing ran in this window. When watchers queue work overnight, this is where you'll find what
        happened, what's waiting on you, and what it cost.
      </p>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        {report.runCount} role run{report.runCount === 1 ? "" : "s"} · {report.tokensUsed.toLocaleString()} tokens
        {report.unseenCount > 0 && ` · ${report.unseenCount} self-generated task${report.unseenCount === 1 ? "" : "s"} you haven't opened`}
      </p>

      <Section
        title={`Done (${report.completed.length})`}
        lines={report.completed}
        withEvidence
        empty="Nothing reached a trusted terminal state in this window."
      />
      <Section
        title={`Needs you (${report.parked.length})`}
        lines={report.parked}
        empty="Nothing is waiting on you."
      />
      {report.inProgress.length > 0 && (
        <Section title={`Still in progress (${report.inProgress.length})`} lines={report.inProgress} empty="" />
      )}

      {report.watcherActivity.length > 0 && (
        <div>
          <SectionHeading>Watchers</SectionHeading>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {report.watcherActivity.map((w) => (
              <div key={w.watcher} className="row" style={{ gap: 8, fontSize: 12 }}>
                <strong>{w.watcher}</strong>
                <span className="muted">
                  {w.queued} queued · {w.rejected} rejected by triage · {w.capped} capped · {w.suppressed} suppressed
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <SectionHeading>Run health</SectionHeading>
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          {(Object.keys(report.healthCounts) as RunHealth[]).map((h) => (
            <span key={h} className={`pill ${report.healthCounts[h] ? HEALTH_CLASS[h] : "dim"}`} style={{ fontSize: 10 }}>
              {h} {report.healthCounts[h]}
            </span>
          ))}
        </div>
        {degraded > 0 && (
          <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            ⚠️ {degraded} run{degraded === 1 ? "" : "s"} produced degraded or empty output — that's usually the
            model or endpoint, not the tasks.
          </p>
        )}
      </div>

      <div>
        <SectionHeading>Budget</SectionHeading>
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          Task starts {report.budget.consumed.taskStarts}/{report.budget.budgets.maxTaskStarts} · exec runs{" "}
          {report.budget.consumed.execRuns}/{report.budget.budgets.maxExecRuns} · tokens{" "}
          {report.budget.consumed.tokens.toLocaleString()}/{report.budget.budgets.maxTokens.toLocaleString()}
        </p>
        {report.budget.exhausted && (
          <p className="pill warn" style={{ fontSize: 10, marginTop: 6 }}>
            Budget exhausted — autonomy is paused until the next idle window.
          </p>
        )}
      </div>
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h4 style={{ margin: "0 0 6px", fontSize: 11, color: "var(--ink-dim)", textTransform: "uppercase", letterSpacing: 1 }}>
      {children}
    </h4>
  );
}

function Section({
  title,
  lines,
  empty,
  withEvidence,
}: {
  title: string;
  lines: ReportTaskLine[];
  empty: string;
  withEvidence?: boolean;
}) {
  if (!lines.length && !empty) return null;
  return (
    <div>
      <SectionHeading>{title}</SectionHeading>
      {!lines.length && <p className="muted" style={{ fontSize: 12, margin: 0 }}>{empty}</p>}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {lines.map((line) => (
          <ReportRow key={line.taskId} line={line} withEvidence={withEvidence} />
        ))}
      </div>
    </div>
  );
}

function ReportRow({ line, withEvidence }: { line: ReportTaskLine; withEvidence?: boolean }) {
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
        <Link to="/tasks/$taskId" params={{ taskId: line.taskId }} style={{ color: "inherit", fontWeight: 600 }}>
          {line.name}
        </Link>
        <div className="row" style={{ gap: 4 }}>
          {line.origin.startsWith("watcher:") && (
            <span className="pill dim" style={{ fontSize: 10 }}>🤖 {line.origin.slice("watcher:".length)}</span>
          )}
          {line.latestVerdict && <span className="pill dim" style={{ fontSize: 10 }}>{line.latestVerdict}</span>}
          <span className={`pill ${HEALTH_CLASS[line.latestHealth]}`} style={{ fontSize: 10 }}>
            {line.latestHealth}
          </span>
        </div>
      </div>
      {line.reason && (
        <p className="muted" style={{ fontSize: 11, margin: "4px 0 0" }}>{line.reason}</p>
      )}
      {withEvidence && line.evidence.length > 0 && (
        <div style={{ marginTop: 6 }}>
          {line.evidence.map((e, i) => (
            <div key={i} className="muted" style={{ fontSize: 11, fontFamily: "var(--mono, monospace)" }}>
              {e}
            </div>
          ))}
        </div>
      )}
      {withEvidence && !line.evidence.length && (
        <p className="muted" style={{ fontSize: 11, margin: "4px 0 0" }}>
          No executed evidence — this is an opinion, not a verified result.
        </p>
      )}
    </div>
  );
}
