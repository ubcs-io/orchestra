import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, displayModelName, verdictClass, type PingResult } from "../api";

export function Projects() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const summaryQ = useQuery({ queryKey: ["summary"], queryFn: api.summary, refetchInterval: 10_000 });
  const [name, setName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [err, setErr] = useState("");
  const [picking, setPicking] = useState(false);
  const [pinging, setPinging] = useState(false);
  const [pingResults, setPingResults] = useState<PingResult[] | null>(null);
  const [pingError, setPingError] = useState("");

  const create = useMutation({
    mutationFn: () => api.createProject({ name, repo_path: repoPath }),
    onSuccess: () => {
      setName("");
      setRepoPath("");
      setErr("");
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["summary"] });
    },
    onError: (e: Error) => setErr(e.message),
  });

  async function pickFolder() {
    setPicking(true);
    try {
      const res = await api.pickFolder();
      if (res.path) setRepoPath(res.path);
    } catch {
      /* dialog cancelled or failed — do nothing */
    } finally {
      setPicking(false);
    }
  }

  async function doPing() {
    setPinging(true);
    setPingError("");
    setPingResults(null);
    try {
      const res = await api.pingNetwork();
      setPingResults(res.results);
    } catch (e) {
      setPingError((e as Error).message);
    } finally {
      setPinging(false);
    }
  }

  const stats = summaryQ.data;
  const availableCount = pingResults?.filter((r) => r.available).length ?? 0;
  const totalNodes = pingResults?.length ?? 0;

  return (
    <div>
      {/* ---- Summary Stats ---- */}
      {stats && (
        <div className="panel">
          <h2>Dashboard</h2>
          <div className="stats-grid">
            <div className="stat-card">
              <span className="stat-value">{stats.total}</span>
              <span className="stat-label">Total Tasks</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">{stats.in_flight}</span>
              <span className="stat-label">In Flight</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">{stats.action_items}</span>
              <span className="stat-label stat-warn">Action Items</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">{stats.blockers}</span>
              <span className="stat-label stat-bad">Blockers</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">{stats.paused}</span>
              <span className="stat-label">Paused</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">{stats.projects_count}</span>
              <span className="stat-label">Projects</span>
            </div>
          </div>
          <div className="stage-breakdown">
            {Object.entries(stats.by_stage).map(([stage, count]) => (
              <span key={stage} className="pill dim">{stage}: {count}</span>
            ))}
          </div>
        </div>
      )}

      {/* ---- Blockers / Action Items ---- */}
      {stats && stats.blockers_list.length > 0 && (
        <div className="panel">
          <h2>Action Items ({stats.blockers_list.length})</h2>
          <div className="blockers-list">
            {stats.blockers_list.map((b) => (
              <div key={b.task_id} className="blocker-row">
                <span className={`pill ${verdictClass(b.exit_state)}`}>{b.exit_state}</span>
                <Link to="/tasks/$taskId" params={{ taskId: b.task_id }} className="blocker-name">
                  {b.name ?? b.task_id.slice(0, 8)}
                </Link>
                {b.project_name && (
                  <span className="muted" style={{ fontSize: 11 }}>
                    {b.project_name}
                  </span>
                )}
                {b.review_reason && (
                  <span className="muted" style={{ fontSize: 11, maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    — {b.review_reason}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---- Ping Network ---- */}
      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between", marginBottom: pingResults ? 10 : 0 }}>
          <h2 style={{ margin: 0 }}>Network Health</h2>
          <button
            className="primary"
            disabled={pinging}
            onClick={doPing}
          >
            {pinging ? "Pinging…" : "Ping Network"}
          </button>
        </div>
        {pingError && <p className="pill bad" style={{ marginTop: 8 }}>{pingError}</p>}
        {pingResults && (
          <div>
            <p className="muted" style={{ marginTop: 4, marginBottom: 8 }}>
              {availableCount}/{totalNodes} nodes available
            </p>
            <div className="ping-results">
              {pingResults.map((r) => (
                <div key={r.config_id} className={`ping-node ${r.available ? "ping-ok" : "ping-down"}`}>
                  <span className={`ping-dot ${r.available ? "ok" : "bad"}`} />
                  <span className="ping-name">{r.name}</span>
                  <span className="muted" style={{ fontSize: 11 }}>{r.base_url}</span>
                  {r.error && <span className="pill bad" style={{ fontSize: 10 }}>{r.error}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
        {!pingResults && !pingError && (
          <p className="muted" style={{ marginTop: 4 }}>Click "Ping Network" to check connectivity to all configured model endpoints.</p>
        )}
      </div>

      {/* ---- Register Repository ---- */}
      <div className="panel">
        <h2>Register a repository</h2>
        <div className="grid-2">
          <div>
            <label>Project name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-service" />
          </div>
          <div>
            <label>Absolute path to the repo root (a subdirectory or .git also works)</label>
            <div className="repo-path-row">
              <input value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder="/Users/me/code/my-service" />
              <button className="picker-btn" title="Browse for folder" disabled={picking} onClick={pickFolder}>
                {picking ? "…" : "📁"}
              </button>
            </div>
          </div>
        </div>
        {err && <p className="pill bad" style={{ marginTop: 8 }}>{err}</p>}
        <div style={{ marginTop: 10 }}>
          <button className="primary" disabled={!name || !repoPath || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? "Registering…" : "Register project"}
          </button>
        </div>
      </div>

      {/* ---- Project List ---- */}
      <div className="panel">
        <h2>Projects</h2>
        {isLoading ? (
          <p className="muted">Loading…</p>
        ) : !data?.projects.length ? (
          <p className="empty">No projects yet. Register a git repo above to begin.</p>
        ) : (
          <div className="project-grid">
            {data.projects.map((p) => (
              <div className="project-card" key={p.id}>
                <Link className="project-name" to="/projects/$projectId" params={{ projectId: String(p.id) }}>{p.name}</Link>
                <div className="project-meta">
                  <span>Repo: {p.repo_path.split("/").pop()}</span>
                  <span>
                    Models:{' '}
                    <Link to="/settings">
                      {p.models.length ? p.models.map(displayModelName).join(", ") : "—"}
                    </Link>
                  </span>
                </div>
                <div className="project-actions">
                  <Link to="/projects/$projectId/roles" params={{ projectId: String(p.id) }}>roles</Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}