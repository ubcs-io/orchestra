import { useCallback, useEffect, useRef, useState } from "react";
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
  const [hoveredConfigId, setHoveredConfigId] = useState<number | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const closeStream = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => closeStream();
  }, [closeStream]);

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

  function doPing() {
    // Clean up any existing stream
    closeStream();
    setPinging(true);
    setPingError("");
    setPingResults(null);

    const es = new EventSource(api.pingNetworkStreamUrl());
    esRef.current = es;

    es.addEventListener("init", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as {
        configs: Array<{ config_id: number; name: string; base_url: string; location?: string | null }>;
      };
      // Immediately show the full list with "checking" status
      setPingResults(
        data.configs.map((c) => ({
          config_id: c.config_id,
          name: c.name,
          base_url: c.base_url,
          location: c.location ?? null,
          available: false,
          status: "checking" as const,
        })),
      );
    });

    es.addEventListener("result", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as {
        config_id: number;
        available: boolean;
        error?: string;
      };
      setPingResults((prev) => {
        if (!prev) return prev;
        return prev.map((r) =>
          r.config_id === data.config_id
            ? { ...r, available: data.available, error: data.error, status: "done" as const }
            : r,
        );
      });
    });

    es.addEventListener("done", () => {
      setPinging(false);
      closeStream();
    });

    es.onerror = () => {
      setPinging(false);
      setPingError("Connection lost during ping");
      closeStream();
    };
  }

  const stats = summaryQ.data;
  const availableCount = pingResults?.filter((r) => r.available).length ?? 0;
  const totalNodes = pingResults?.length ?? 0;
  const checkedCount = pingResults?.filter((r) => r.status === "done").length ?? 0;

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
              <span className="stat-value">{stats.review_count}</span>
              <span className="stat-label stat-warn">Needs Review</span>
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

      {/* ---- Needs Your Review ---- */}
      {stats && stats.review_list.length > 0 && (
        <div className="panel">
          <h2>Needs Your Review ({stats.review_list.length})</h2>
          <p className="muted" style={{ marginTop: -4, marginBottom: 8, fontSize: 12 }}>
            Parked awaiting a human decision (approve/reset/request changes) — nothing will progress on these,
            or on any task depending on them, until you act.
          </p>
          <div className="blockers-list">
            {stats.review_list.map((r) => (
              <div key={r.task_id} className="blocker-row">
                <span className="pill human">{r.exit_state ? r.exit_state.replace(/_/g, " ") : "needs review"}</span>
                <Link to="/tasks/$taskId" params={{ taskId: r.task_id }} className="blocker-name">
                  {r.name ?? r.task_id.slice(0, 8)}
                </Link>
                {r.project_name && (
                  <span className="muted" style={{ fontSize: 11 }}>
                    {r.project_name}
                  </span>
                )}
                {r.review_reason && (
                  <span className="muted" style={{ fontSize: 11, maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    — {r.review_reason}
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
            {pinging ? `Pinging… (${checkedCount}/${totalNodes})` : "Ping Network"}
          </button>
        </div>
        {pingError && <p className="pill bad" style={{ marginTop: 8 }}>{pingError}</p>}
        {pingResults && (
          <div>
            <p className="muted" style={{ marginTop: 4, marginBottom: 8 }}>
              {pinging ? `${checkedCount}/${totalNodes} checked so far` : `${availableCount}/${totalNodes} nodes available`}
            </p>
            <div className="ping-results">
              {pingResults.map((r) => (
                <div
                  key={r.config_id}
                  className={`ping-node ${r.status === "checking" ? "ping-checking" : r.available ? "ping-ok" : "ping-down"}`}
                  onMouseEnter={() => setHoveredConfigId(r.config_id)}
                  onMouseLeave={() => setHoveredConfigId(null)}
                >
                  <span className={`ping-dot ${r.status === "checking" ? "ping-dot--checking" : r.available ? "ok" : "bad"}`} />
                  <span className="ping-name">{r.name}</span>
                  <span className="muted" style={{ fontSize: 11 }}>
                    {(() => {
                      // While pinging, always show the full URL
                      if (pinging) return r.base_url;
                      // Done pinging — obfuscate local addresses unless hovered, using server-provided location
                      if (r.location === "local") {
                        return hoveredConfigId === r.config_id ? r.base_url : <span className="pill dim">[local]</span>;
                      }
                      return r.base_url;
                    })()}
                  </span>
                  {r.status === "checking" && (
                    <span className="pill dim" style={{ fontSize: 10 }}>checking…</span>
                  )}
                  {r.status === "done" && r.error && (
                    <span className="pill bad" style={{ fontSize: 10 }}>{r.error}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        {!pingResults && !pingError && (
          <p className="muted" style={{ marginTop: 4 }}>Click "Ping Network" to check connectivity to all configured model endpoints.</p>
        )}
      </div>

      {/* ---- Project List ---- */}
      <div className="panel">
        <h2>Projects</h2>
        {isLoading ? (
          <p className="muted">Loading…</p>
        ) : (
          <div className="project-grid">
            {data?.projects && data.projects.length > 0 && data.projects.map((p) => (
              <Link className={`project-card${p.processing ? " project-card--processing" : ""}`} to="/projects/$projectId" params={{ projectId: String(p.id) }} key={p.id}>
                <Link className="project-roles-icon" to="/projects/$projectId/roles" params={{ projectId: String(p.id) }} title="Roles" onClick={(e) => e.stopPropagation()}>👤</Link>
                <span className="project-name">{p.name}</span>
                <div className="project-meta">
                  <span>Repo: {p.repo_path.split("/").pop()}</span>
                  <span>
                    Models:{' '}
                    <Link to="/settings">
                      {p.models.length ? p.models.map(displayModelName).join(", ") : "—"}
                    </Link>
                  </span>
                </div>
                {/* API calls bar */}
                {(() => {
                  const internal = p.internal_calls ?? 0;
                  const external = p.external_calls ?? 0;
                  const total = internal + external;
                  if (total === 0) {
                    return (
                      <div className="api-calls-bar">
                        <div className="api-calls-bar__empty" title="No API calls yet" />
                      </div>
                    );
                  }
                  const internalPct = Math.round((internal / total) * 100);
                  const externalPct = 100 - internalPct;
                  return (
                    <div className="api-calls-bar" title={`${internal} internal / ${external} external API calls`}>
                      {internalPct > 0 && (
                        <div className="api-calls-bar__internal" style={{ width: `${internalPct}%` }} />
                      )}
                      {externalPct > 0 && (
                        <div className="api-calls-bar__external" style={{ width: `${externalPct}%` }} />
                      )}
                    </div>
                  );
                })()}
                <div className="api-calls-label">
                  {((p.internal_calls ?? 0) + (p.external_calls ?? 0) === 0)
                    ? "No calls"
                    : `${p.internal_calls ?? 0} local / ${p.external_calls ?? 0} api`}
                </div>

              </Link>
            ))}
            {/* ---- Register Repository (inline card) ---- */}
            <div className="project-card project-card--register">
              <div className="project-name">Register a repository</div>
              <div className="grid-2" style={{ width: "100%" }}>
                <div>
                  <label>Project name</label>
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-service" />
                </div>
                <div>
                  <label>Absolute path to the repo root</label>
                  <div className="repo-path-row">
                    <input value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder="/Users/me/code/my-service" />
                    <button className="picker-btn" title="Browse for folder" disabled={picking} onClick={pickFolder}>
                      {picking ? "…" : "📁"}
                    </button>
                  </div>
                </div>
              </div>
              {err && <p className="pill bad" style={{ marginTop: 8 }}>{err}</p>}
              <div className="project-actions" style={{ marginTop: 8 }}>
                <button className="primary" disabled={!name || !repoPath || create.isPending} onClick={() => create.mutate()}>
                  {create.isPending ? "Registering…" : "Register project"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}