import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type SafetyResponse } from "../api";

const FLOW_LABELS: Record<string, string> = {
  error_file: "Bug / Error",
  bug: "Bug",
  security: "Security",
  feature: "Feature",
  manual: "Manual",
  chore: "Chore",
  spike: "Spike",
  research: "Research",
  ux: "UX",
  question: "Question",
};

/**
 * Settings page — now focuses on the Pi Dev Safety Dashboard.
 * Connection settings have moved to the Models page.
 */
export function Settings() {
  return (
    <div className="settings">
      <div className="row" style={{ marginBottom: 12 }}>
        <Link to="/">← projects</Link>
        <h2 style={{ margin: 0, color: "var(--brass)" }}>Settings</h2>
      </div>
      <p className="muted">
        Connection settings are now managed on the{" "}
        <Link to="/models">Models page</Link>. Visit Models to view, edit, create,
        and set the default model configuration.
      </p>

      <SafetyDashboard />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pi Dev Safety Dashboard
// ---------------------------------------------------------------------------

function SafetyDashboard() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["safety"],
    queryFn: api.safety,
  });

  if (isLoading) return <p className="muted" style={{ marginTop: 24 }}>Loading safety info…</p>;
  if (isError) return <p className="pill bad" style={{ marginTop: 24 }}>{(error as Error).message}</p>;
  if (!data) return null;

  return (
    <div style={{ marginTop: 32 }}>
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0, color: "var(--brass)" }}>Pi Dev Controls</h2>
        <span className="pill dim">safety dashboard</span>
      </div>
      <p className="muted" style={{ marginBottom: 16 }}>
        What the pi agent harness can and cannot do. These boundaries are enforced by the orchestrator — not
        suggestions.
      </p>

      <div className="safety-grid">
        <ToolBoundaries data={data} />
        <LimitsCard data={data} />
        <GatesCard data={data} />
        <div>
          <RolesSummary data={data} />
          <HarnessPolicySummary data={data} />
          <SecurityPosture data={data} />
        </div>
      </div>
    </div>
  );
}

function ToolBoundaries({ data }: { data: SafetyResponse }) {
  const t = data.agent_tools;
  const items: Array<{ label: string; ok: boolean; detail: string }> = [
    { label: "Read repo files", ok: true, detail: "read, grep, find, ls — scoped to registered repo" },
    { label: "Git history", ok: t.git_history_available, detail: "read-only git log — scoped to registered repo" },
    { label: "Write artifacts", ok: true, detail: "PLANNING/ only, always on (write_artifact tool)" },
    { label: "Shell / exec access", ok: !t.shell_access, detail: "no exec, shell, or system tools available to agents" },
    {
      label: "Source code editing",
      ok: !t.source_code_writes,
      detail: t.source_code_writes
        ? "write/edit granted to at least one role — jailed to that task's git worktree"
        : "no write/edit tools — repository code is never modified",
    },
    { label: "Cross-repo isolation", ok: true, detail: "each session locked to a single project's repoPath" },
  ];

  return (
    <div className="panel">
      <strong style={{ marginBottom: 8, display: "block" }}>Agent Tool Boundaries</strong>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {items.map((it) => (
          <div key={it.label} className="row" style={{ justifyContent: "flex-start", gap: 8, alignItems: "flex-start" }}>
            <span className={`pill ${it.ok ? "ok" : "bad"}`} style={{ minWidth: 24, textAlign: "center" }}>
              {it.ok ? "✓" : "✕"}
            </span>
            <div>
              <strong style={{ fontSize: 13 }}>{it.label}</strong>
              <br />
              <span className="muted" style={{ fontSize: 11 }}>{it.detail}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LimitsCard({ data }: { data: SafetyResponse }) {
  const qc = useQueryClient();
  const [budget, setBudget] = useState(String(data.limits.role_tool_budget));

  const save = useMutation({
    mutationFn: () => api.saveSafety({ role_tool_budget: Number(budget) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["safety"] }),
  });

  return (
    <div className="panel">
      <strong style={{ marginBottom: 8, display: "block" }}>Configurable Limits</strong>
      <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse", marginBottom: 10 }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border-color, #333)" }}>
            <th style={{ padding: "4px 8px" }}>Setting</th>
            <th style={{ padding: "4px 8px" }}>Value</th>
            <th style={{ padding: "4px 8px" }}>Source</th>
          </tr>
        </thead>
        <tbody>
          <tr style={{ borderBottom: "1px solid var(--border-color, #222)" }}>
            <td style={{ padding: "4px 8px", verticalAlign: "middle" }}>
              Tool calls per role run
              {save.isSuccess && <span className="pill ok" style={{ marginLeft: 6, fontSize: 10 }}>saved</span>}
            </td>
            <td style={{ padding: "4px 8px", verticalAlign: "middle" }}>
              <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                <input
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                  placeholder="40"
                  style={{ width: 80 }}
                />
                <button className="small" disabled={save.isPending} onClick={() => save.mutate()}>
                  {save.isPending ? "…" : "Save"}
                </button>
              </div>
              {save.isError && <span className="pill bad" style={{ fontSize: 10 }}>{(save.error as Error).message}</span>}
            </td>
            <td style={{ padding: "4px 8px", verticalAlign: "middle" }}>
              <span className="pill dim" style={{ fontSize: 10 }}>editable</span>
            </td>
          </tr>
          <tr style={{ borderBottom: "1px solid var(--border-color, #222)" }}>
            <td style={{ padding: "4px 8px", verticalAlign: "middle" }}>Request timeout</td>
            <td style={{ padding: "4px 8px", verticalAlign: "middle" }}>
              <input value={`${data.limits.request_timeout_ms} ms`} disabled style={{ opacity: 0.6, width: "100%" }} />
            </td>
            <td style={{ padding: "4px 8px", verticalAlign: "middle" }}>
              <span className="muted" style={{ fontSize: 10 }}>edit on Models page</span>
            </td>
          </tr>
          <tr style={{ borderBottom: "1px solid var(--border-color, #222)" }}>
            <td style={{ padding: "4px 8px", verticalAlign: "middle" }}>Max tokens / Context window</td>
            <td style={{ padding: "4px 8px", verticalAlign: "middle" }}>
              <div className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
                <input value={String(data.limits.max_tokens)} disabled style={{ opacity: 0.6, flex: 1 }} />
                <span className="muted" style={{ fontSize: 10, whiteSpace: "nowrap" }}>/</span>
                <input value={String(data.limits.context_window)} disabled style={{ opacity: 0.6, flex: 1 }} />
              </div>
            </td>
            <td style={{ padding: "4px 8px", verticalAlign: "middle" }}>
              <span className="muted" style={{ fontSize: 10 }}>edit on Models page</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function GatesCard({ data }: { data: SafetyResponse }) {
  const entries = Object.entries(data.gates);
  if (!entries.length) return null;

  return (
    <div className="panel">
      <strong style={{ marginBottom: 8, display: "block" }}>Gate & Review Controls</strong>
      <p className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
        Counter-reviewers verify prior role output against acceptance criteria. Unmet "must" criteria trigger
        loop-backs (bounded). After exhaustion, tasks escalate to human REVIEW.
      </p>
      <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border-color, #333)" }}>
            <th style={{ padding: "4px 8px" }}>Flow</th>
            <th style={{ padding: "4px 8px" }}>Reviewer</th>
            <th style={{ padding: "4px 8px" }}>Rigor</th>
            <th style={{ padding: "4px 8px" }}>Max loop-backs</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([k, g]) => (
            <tr key={k} style={{ borderBottom: "1px solid var(--border-color, #222)" }}>
              <td style={{ padding: "4px 8px" }}>{FLOW_LABELS[k] ?? k}</td>
              <td style={{ padding: "4px 8px" }}>
                <span className="pill dim">{g.reviewerRole}</span>
              </td>
              <td style={{ padding: "4px 8px" }}>
                <span className={`pill ${g.rigor === "high" ? "warn" : g.rigor === "low" ? "dim" : "ok"}`}>
                  {g.rigor}
                </span>
              </td>
              <td style={{ padding: "4px 8px", textAlign: "center" }}>{g.maxLoopbacks}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RolesSummary({ data }: { data: SafetyResponse }) {
  const s = data.roles_summary;
  return (
    <div className="panel">
      <strong style={{ marginBottom: 8, display: "block" }}>Role Summary</strong>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        <SummaryBadge label="Total roles" value={s.total_roles} />
        <SummaryBadge label="Read-only (read/grep/find/ls)" value={s.read_only_count} />
        <SummaryBadge label="Git history access" value={s.git_history_count} />
        <SummaryBadge label="Context-only (no tools)" value={s.context_only_count} />
        {s.disabled_count > 0 && <SummaryBadge label="Disabled" value={s.disabled_count} tone="warn" />}
      </div>
      <p className="muted" style={{ fontSize: 11, marginTop: 8 }}>
        Edit per-role tools in the <strong>Roles Editor</strong> inside each project.
      </p>
    </div>
  );
}

function HarnessPolicySummary({ data }: { data: SafetyResponse }) {
  const hp = data.harness_policy;
  const withWrite = hp.projects.filter((p) => p.allow_write || p.roles_with_write.length > 0);
  // Execution posture (PLANNING/overhaul/05) is reported alongside write
  // access because it is the strictly larger capability: a write is confined to
  // the task worktree, an executed command is not confined at all.
  const withExec = hp.projects.filter(
    (p) => p.allow_exec || (p.roles_with_exec?.length ?? 0) > 0,
  );

  return (
    <div className="panel" style={{ marginTop: 12 }}>
      <strong style={{ marginBottom: 8, display: "block" }}>Harness Write Policy (per project)</strong>
      <p className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
        Global default is <code>allowWrite: {String(hp.global_default.allowWrite)}</code>. Toggle a project's
        policy from that project's Roles Editor.
      </p>
      {withWrite.length === 0 ? (
        <span className="pill dim" style={{ fontSize: 11 }}>no project has write/edit enabled</span>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {withWrite.map((p) => (
            <div key={p.id} className="row" style={{ justifyContent: "flex-start", gap: 8, flexWrap: "wrap" }}>
              <span className={`pill ${p.allow_write ? "ok" : "dim"}`} style={{ fontSize: 10 }}>
                {p.allow_write ? "write enabled" : "write disabled"}
              </span>
              <strong style={{ fontSize: 12 }}>{p.name}</strong>
              {p.roles_with_write.map((key) => (
                <span key={key} className="pill dim" style={{ fontSize: 10 }}>{key}</span>
              ))}
            </div>
          ))}
        </div>
      )}

      <strong style={{ marginBottom: 8, marginTop: 14, display: "block" }}>
        Command Execution (per project)
      </strong>
      {withExec.length === 0 ? (
        <span className="pill dim" style={{ fontSize: 11 }}>
          no project can run commands
        </span>
      ) : (
        <>
          <p className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
            Approved commands run this repo's own code with this server's OS privileges — the task
            worktree isolates file edits, not spawned processes. There is no shell: only the exact
            argv below can run.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {withExec.map((p) => (
              <div key={p.id} className="row" style={{ justifyContent: "flex-start", gap: 8, flexWrap: "wrap" }}>
                <span
                  className={`pill ${(p.roles_with_exec?.length ?? 0) > 0 ? "bad" : "dim"}`}
                  style={{ fontSize: 10 }}
                >
                  {(p.roles_with_exec?.length ?? 0) > 0 ? "exec live" : "exec allowed, unused"}
                </span>
                <strong style={{ fontSize: 12 }}>{p.name}</strong>
                {(p.roles_with_exec ?? []).map((key) => (
                  <span key={key} className="pill dim" style={{ fontSize: 10 }}>{key}</span>
                ))}
                {(p.exec_commands ?? []).map((c) => (
                  <code key={c.name} style={{ fontSize: 10, opacity: 0.7 }} title={c.argv.join(" ")}>
                    {c.name}
                  </code>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function SummaryBadge({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div style={{
      background: "var(--bg-color, #1a1a2e)",
      borderRadius: 8,
      padding: "8px 14px",
      textAlign: "center",
      minWidth: 100,
    }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: tone === "warn" ? "var(--warn, #f0a040)" : "var(--brass)" }}>
        {value}
      </div>
      <div className="muted" style={{ fontSize: 10 }}>{label}</div>
    </div>
  );
}

function SecurityPosture({ data }: { data: SafetyResponse }) {
  const s = data.server;
  const st = data.storage;

  return (
    <div className="panel">
      <strong style={{ marginBottom: 8, display: "block" }}>Security Posture</strong>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
        <div className="row" style={{ justifyContent: "flex-start", gap: 8 }}>
          <span className="muted" style={{ minWidth: 100 }}>Server</span>
          <code>{s.bind_address}:{s.port}</code>
        </div>
        <div className="row" style={{ justifyContent: "flex-start", gap: 8 }}>
          <span className="muted" style={{ minWidth: 100 }}>Auth</span>
          <span className="pill bad" style={{ fontSize: 10 }}>none</span>
          <span className="muted" style={{ fontSize: 11 }}>{s.trust_boundary}</span>
        </div>
        <div className="row" style={{ justifyContent: "flex-start", gap: 8 }}>
          <span className="muted" style={{ minWidth: 100 }}>API Key</span>
          <span className={`pill ${st.api_key_in_env ? "ok" : st.api_key_in_db ? "warn" : "dim"}`} style={{ fontSize: 10 }}>
            {st.api_key_in_env ? "in env" : st.api_key_in_db ? "in DB" : "not set"}
          </span>
          {st.api_key_in_db && !st.api_key_in_env && (
            <span className="muted" style={{ fontSize: 10 }}>
              stored in <code>{st.db_path}</code> — use ORCHESTRA_API_KEY env to keep it out of the DB
            </span>
          )}
        </div>
        <div className="row" style={{ justifyContent: "flex-start", gap: 8 }}>
          <span className="muted" style={{ minWidth: 100 }}>DB</span>
          <code style={{ fontSize: 11 }}>{st.db_path}</code>
        </div>
      </div>
    </div>
  );
}