import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, verdictClass, type TaskDetail as TD } from "../api";

function useTaskStream(taskId: string, onActivity: () => void) {
  const [lines, setLines] = useState<string[]>([]);
  const bufRef = useRef("");
  useEffect(() => {
    setLines([]);
    bufRef.current = "";
    const es = new EventSource(`/api/tasks/${taskId}/stream`);
    const push = (s: string) => setLines((prev) => [...prev.slice(-400), s]);

    es.addEventListener("role_start", (e) => {
      const d = JSON.parse((e as MessageEvent).data).data;
      push(`\n▶ ROLE ${d.role} (depth ${d.depth})`);
      bufRef.current = "";
    });
    es.addEventListener("text", (e) => {
      const d = JSON.parse((e as MessageEvent).data).data;
      bufRef.current += d.delta ?? "";
      setLines((prev) => {
        const rest = prev[prev.length - 1]?.startsWith("  ") ? prev.slice(0, -1) : prev;
        return [...rest, "  " + bufRef.current.slice(-1200)];
      });
    });
    es.addEventListener("tool_start", (e) => {
      const d = JSON.parse((e as MessageEvent).data).data;
      push(`  ⚙ ${d.tool}(${JSON.stringify(d.args).slice(0, 80)})`);
      bufRef.current = "";
    });
    es.addEventListener("tool_end", (e) => {
      const d = JSON.parse((e as MessageEvent).data).data;
      push(`  ⚙ ${d.tool} ${d.isError ? "✗" : "✓"}`);
    });
    es.addEventListener("role_end", (e) => {
      const d = JSON.parse((e as MessageEvent).data).data;
      push(`■ ${d.role} → ${d.verdict ?? (d.error ? "error" : "done")}`);
      onActivity();
    });
    es.addEventListener("task_update", () => onActivity());
    es.onerror = () => {}; // browser auto-reconnects

    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);
  return lines;
}

export function TaskDetail() {
  const { taskId } = useParams({ strict: false }) as { taskId: string };
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["task", taskId], queryFn: () => api.task(taskId), refetchInterval: 4000 });
  const refresh = () => qc.invalidateQueries({ queryKey: ["task", taskId] });
  const lines = useTaskStream(taskId, refresh);
  const liveRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    liveRef.current?.scrollTo(0, liveRef.current.scrollHeight);
  }, [lines]);

  const [roleInput, setRoleInput] = useState("");
  const [afterInput, setAfterInput] = useState("");
  const [noteInput, setNoteInput] = useState("");
  const [collapsedRuns, setCollapsedRuns] = useState<Set<number>>(new Set());

  const intervene = useMutation({
    mutationFn: ({ kind, payload }: { kind: string; payload?: unknown }) => api.intervene(taskId, kind, payload),
    onSuccess: refresh,
  });

  if (q.isLoading) return <p className="muted">Loading…</p>;
  if (q.isError || !q.data) return <p className="pill bad">Task not found.</p>;
  const d: TD = q.data;
  const t = d.task;

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        {t.project_id != null && (
          <Link to="/projects/$projectId" params={{ projectId: String(t.project_id) }}>← board</Link>
        )}
        <h2 style={{ margin: 0, color: "var(--brass)" }}>{t.name ?? t.task_id.slice(0, 8)}</h2>
        <span className={`pill ${t.stage === "ready" ? "ok" : t.stage === "review" ? "human" : "dim"}`}>{t.stage}</span>
        <span className="pill dim">{t.intake_kind}</span>
        <span className="pill dim">exit: {t.exit_kind}</span>
        {t.paused === 1 && <span className="pill warn">paused</span>}
      </div>

      {t.review_reason && (
        <div className="panel" style={{ borderColor: "var(--human)" }}>
          <h2>Needs review</h2>
          <p>{t.review_reason}</p>
        </div>
      )}

      <div className="detail-grid">
        <div>
          <div className="panel">
            <h2>Live activity</h2>
            <div className="live" ref={liveRef}>
              {lines.length ? lines.join("\n") : <span className="muted">Waiting for the active role… (start the loop if stopped)</span>}
            </div>
          </div>

          <div className="panel">
            <h2>Refinement plan</h2>
            <div className="row">
              {d.plan?.steps.map((s, i) => (
                <a
                  key={i}
                  href={`#run-${s.role}`}
                  className={`pill ${s.status === "done" ? "ok" : s.status === "skipped" ? "dim" : "warn"}`}
                  onClick={(e) => {
                    e.preventDefault();
                    const el = document.getElementById(`run-${s.role}`);
                    if (el) {
                      el.scrollIntoView({ behavior: "smooth", block: "start" });
                      setCollapsedRuns((prev) => {
                        const run = d.runs.find((r) => r.role_key === s.role);
                        if (run && prev.has(run.id)) {
                          const next = new Set(prev);
                          next.delete(run.id);
                          return next;
                        }
                        return prev;
                      });
                    }
                  }}
                >
                  {s.role}{s.depth > 1 ? `·d${s.depth}` : ""}
                </a>
              )) ?? <span className="muted">Not planned yet.</span>}
            </div>
          </div>

          {d.runs.length > 0 && (
            <div className="row" style={{ marginBottom: 8 }}>
              <button
                className="small"
                onClick={() => {
                  if (collapsedRuns.size === d.runs.length) {
                    setCollapsedRuns(new Set());
                  } else {
                    setCollapsedRuns(new Set(d.runs.map((r) => r.id)));
                  }
                }}
              >
                {collapsedRuns.size === d.runs.length ? "expand all" : "collapse all"}
              </button>
            </div>
          )}
          {d.runs.map((r) => {
            const isCollapsed = collapsedRuns.has(r.id);
            const toggle = () =>
              setCollapsedRuns((prev) => {
                const next = new Set(prev);
                if (next.has(r.id)) next.delete(r.id);
                else next.add(r.id);
                return next;
              });
            return (
              <div className="panel" key={r.id} id={`run-${r.role_key}`}>
                <div className="row collapsible" onClick={toggle}>
                  <span className="collapse-caret">{isCollapsed ? "▸" : "▾"}</span>
                  <h2 style={{ margin: 0, cursor: "pointer" }}>{r.role_key}</h2>
                  <span className={`pill ${verdictClass(r.verdict)}`}>{r.verdict ?? "?"}</span>
                  {r.tokens != null && <span className="muted">{r.tokens} tok</span>}
                  {r.depth > 1 && <span className="pill dim">depth {r.depth}</span>}
                  <div style={{ flex: 1 }} />
                  <button
                    className="small"
                    onClick={(e) => {
                      e.stopPropagation();
                      intervene.mutate({ kind: "rerun_role", payload: { role: r.role_key } });
                    }}
                  >
                    re-run
                  </button>
                  <button
                    className="small"
                    onClick={(e) => {
                      e.stopPropagation();
                      intervene.mutate({ kind: "deepen", payload: { role: r.role_key } });
                    }}
                  >
                    deepen
                  </button>
                </div>
                {!isCollapsed && r.summary && <p className="muted" style={{ margin: "6px 0" }}>{r.summary}</p>}
                {!isCollapsed && r.output_md && <div className="section-md">{r.output_md}</div>}
              </div>
            );
          })}

          {d.children.length > 0 && (
            <div className="panel">
              <h2>Decomposition</h2>
              <table>
                <tbody>
                  {d.children.map((c) => (
                    <tr key={c.task_id}>
                      <td><span className="pill dim">{c.level}</span></td>
                      <td>{c.name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div>
          <div className="panel">
            <h2>Steering</h2>
            <div className="steer">
              {t.paused === 1 ? (
                <button className="small primary" onClick={() => intervene.mutate({ kind: "resume" })}>Resume</button>
              ) : (
                <button className="small" onClick={() => intervene.mutate({ kind: "pause" })}>Pause</button>
              )}
              <button className="small" onClick={() => api.tick().then(refresh)}>Tick now</button>
            </div>
            <label>Inject / re-run / promote a role</label>
            <div className="steer">
              <select value={roleInput} onChange={(e) => setRoleInput(e.target.value)}>
                <option value="">— role —</option>
                {["privacy_review", "security_review", "performance_review", "test_strategy", "edge_case_analysis", "options_exploration", "ux_review"].map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
              <input style={{ width: 120 }} value={afterInput} onChange={(e) => setAfterInput(e.target.value)} placeholder="after (role)" />
              <button className="small" disabled={!roleInput} onClick={() => intervene.mutate({ kind: "inject_role", payload: { role: roleInput, after: afterInput || undefined } })}>inject</button>
              <button className="small" disabled={!roleInput} onClick={() => intervene.mutate({ kind: "promote_role", payload: { role: roleInput } })}>promote</button>
            </div>
            <label>Steer note / pin a question</label>
            <div className="steer">
              <input value={noteInput} onChange={(e) => setNoteInput(e.target.value)} placeholder="focus on token handling…" />
              <button className="small" disabled={!noteInput} onClick={() => { intervene.mutate({ kind: "steer_note", payload: { text: noteInput } }); setNoteInput(""); }}>add</button>
            </div>
          </div>

          <div className="panel">
            <h2>Coverage map</h2>
            {d.coverage ? (
              <div className="coverage">
                {d.taxonomy.map((concern) => {
                  const c = d.coverage?.[concern] ?? { status: "never" };
                  return (
                    <div key={concern} className={c.status} style={{ display: "contents" }}>
                      <span className={c.status}>{concern}</span>
                      <span className={c.status}>{c.status === "never" ? "never looked at" : c.status}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="muted">No coverage recorded yet.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
