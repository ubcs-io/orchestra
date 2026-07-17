import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, STAGES, type Plan, type Task } from "../api";
import { buildRelationGroups, type RelationGroup } from "../relations";
import { ModelBubble } from "../components/ModelBubble";

function planProgress(task: Task): string {
  if (!task.refinement_plan_json) return "not planned";
  try {
    const plan = JSON.parse(task.refinement_plan_json) as Plan;
    const done = plan.steps.filter((s) => s.status === "done").length;
    const current = plan.steps.find((s) => s.status === "pending");
    return `${done}/${plan.steps.length}${current ? ` · at ${current.role}` : ""}`;
  } catch {
    return "";
  }
}

function TaskCard({
  task,
  group,
  hovered,
  onHover,
}: {
  task: Task;
  group?: RelationGroup;
  hovered: boolean;
  onHover: (rootId: string | null) => void;
}) {
  const isWontDo = task.exit_state === "wont_do";
  return (
    <Link
      to="/tasks/$taskId"
      params={{ taskId: task.task_id }}
      className={`card${isWontDo ? " card--wont-do" : ""}${hovered ? " card--related-highlight" : ""}`}
      style={{ display: "block", color: "inherit" }}
      onMouseEnter={() => group && onHover(group.rootId)}
      onMouseLeave={() => group && onHover(null)}
    >
      <div className="title">{task.name ?? task.task_id.slice(0, 8)}</div>
      <div className="meta">
        {group && <span className="dot" style={{ background: group.color }} title="part of a related task family" />}
        <span className="pill dim">{task.intake_kind ?? task.level}</span>
        <span>{planProgress(task)}</span>
        {task.paused === 1 && <span className="pill warn">paused</span>}
        {task.stale_reason && (
          <span className="pill bad" title={task.stale_reason}>
            possibly stale
          </span>
        )}
        {task.exit_state && (
          <span className={`pill ${isWontDo ? "dim" : task.exit_state === "ready_for_work" ? "ok" : "human"}`}>
            {task.exit_state.replace(/_/g, " ")}
          </span>
        )}
      </div>
    </Link>
  );
}

export function ProjectBoard() {
  const { projectId } = useParams({ strict: false }) as { projectId: string };
  const pid = Number(projectId);
  const qc = useQueryClient();
  const projectQ = useQuery({ queryKey: ["project", pid], queryFn: () => api.project(pid) });
  const tasksQ = useQuery({ queryKey: ["tasks", pid], queryFn: () => api.tasks(pid), refetchInterval: 3000 });

  const [content, setContent] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState("manual");

  // Scheduler state for the intake column banner
  const [schedulerRunning, setSchedulerRunning] = useState(true);
  useEffect(() => {
    api.scheduler().then((s) => setSchedulerRunning(s.running)).catch(() => {});
    const iv = setInterval(() => {
      api.scheduler().then((s) => setSchedulerRunning(s.running)).catch(() => {});
    }, 5000);
    return () => clearInterval(iv);
  }, []);

  const submit = useMutation({
    mutationFn: () => api.intake(pid, { name: name || "intake", content, intake_kind: kind }),
    onSuccess: () => {
      setContent("");
      setName("");
      qc.invalidateQueries({ queryKey: ["tasks", pid] });
    },
  });

  const byStage = (stage: string) => (tasksQ.data?.tasks ?? []).filter((t) => (t.stage ?? "intake") === stage);

  const relationGroups = useMemo(() => buildRelationGroups(tasksQ.data?.tasks ?? []), [tasksQ.data]);
  const [hoveredGroup, setHoveredGroup] = useState<string | null>(null);

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0, color: "var(--brass)" }}>{projectQ.data?.project.name ?? "Project"}</h2>
        <span className="muted">{projectQ.data?.project.repo_path}</span>
        {projectQ.data && (
          <ModelBubble
            projectId={pid}
            defaultModel={projectQ.data.project.default_model}
            roles={projectQ.data.roles}
          />
        )}
        <div className="spacer" style={{ flex: 1 }} />
        <Link to="/projects/$projectId/roles" params={{ projectId }}>edit roles →</Link>
      </div>

      <div className="panel">
        <h2>New intake</h2>
        <div className="grid-2">
          <div>
            <label>Name (optional)</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="fix-login-bug" />
          </div>
          <div>
            <label>Kind</label>
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {["manual", "error_file", "feature", "bug", "chore", "spike", "research", "ux", "question"].map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
          </div>
        </div>
        <label>Content — a request, a bare error/stack trace, or an open-ended research prompt</label>
        <textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="Consider how to address the UX issue on the settings page…" />
        <div style={{ marginTop: 8 }}>
          <button className="primary" disabled={!content || submit.isPending} onClick={() => submit.mutate()}>
            {submit.isPending ? "Submitting…" : "Drop into INTAKE"}
          </button>
          <span className="muted" style={{ marginLeft: 10 }}>The orchestrator ingests it on the next tick.</span>
        </div>
      </div>

      <div className="kanban">
        {STAGES.map((stage) => (
          <div className="col" key={stage}>
            <h3>
              {stage} ({byStage(stage).length})
              {stage === "intake" && !schedulerRunning && (
                <span className="banner stopped" style={{ display: "block", marginTop: 4, fontSize: 12, fontWeight: 400, color: "var(--brass)" }}>
                  ⏸ Stopped
                </span>
              )}
            </h3>
            <div className="cards">
              {byStage(stage).map((t) => {
                const group = relationGroups.get(t.task_id);
                return (
                  <TaskCard
                    key={t.task_id}
                    task={t}
                    group={group}
                    hovered={!!group && hoveredGroup === group.rootId}
                    onHover={setHoveredGroup}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <TaskListTable tasks={tasksQ.data?.tasks ?? []} relationGroups={relationGroups} />
    </div>
  );
}

const ALL = "all";
type TableSort = { col: string; dir: "asc" | "desc" };

function distinct(values: (string | null)[]): string[] {
  return Array.from(new Set(values.filter((v): v is string => !!v))).sort();
}

function TaskListTable({ tasks, relationGroups }: { tasks: Task[]; relationGroups: Map<string, RelationGroup> }) {
  const [search, setSearch] = useState("");
  const [stageFilter, setStageFilter] = useState(ALL);
  const [levelFilter, setLevelFilter] = useState(ALL);
  const [kindFilter, setKindFilter] = useState(ALL);
  const [exitStateFilter, setExitStateFilter] = useState(ALL);
  const [sort, setSort] = useState<TableSort>({ col: "created_at", dir: "desc" });

  const stages = useMemo(() => distinct(tasks.map((t) => t.stage)), [tasks]);
  const levels = useMemo(() => distinct(tasks.map((t) => t.level)), [tasks]);
  const kinds = useMemo(() => distinct(tasks.map((t) => t.intake_kind)), [tasks]);
  const exitStates = useMemo(() => distinct(tasks.map((t) => t.exit_state)), [tasks]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = tasks.filter((t) => {
      if (stageFilter !== ALL && t.stage !== stageFilter) return false;
      if (levelFilter !== ALL && t.level !== levelFilter) return false;
      if (kindFilter !== ALL && t.intake_kind !== kindFilter) return false;
      if (exitStateFilter !== ALL && t.exit_state !== exitStateFilter) return false;
      if (q && !(t.name ?? "").toLowerCase().includes(q) && !(t.content ?? "").toLowerCase().includes(q)) return false;
      return true;
    });
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      const av = (a as unknown as Record<string, unknown>)[sort.col];
      const bv = (b as unknown as Record<string, unknown>)[sort.col];
      const an = av == null ? "" : String(av);
      const bn = bv == null ? "" : String(bv);
      const cmp = an.localeCompare(bn);
      return sort.dir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [tasks, search, stageFilter, levelFilter, kindFilter, exitStateFilter, sort]);

  const th = (col: string, label: string) => (
    <th
      style={{ cursor: "pointer", whiteSpace: "nowrap", userSelect: "none" }}
      onClick={() => setSort((prev) => ({
        col,
        dir: prev.col === col ? (prev.dir === "asc" ? "desc" : "asc") : "asc",
      }))}
    >
      {label}
      {sort.col === col ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
    </th>
  );

  const filterSelect = (value: string, onChange: (v: string) => void, options: string[], allLabel: string) => (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={{ width: "auto" }}>
      <option value={ALL}>{allLabel}</option>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );

  return (
    <div className="panel" style={{ marginTop: 16, overflowX: "auto" }}>
      <h2>All tasks ({rows.length})</h2>
      <div className="row" style={{ marginBottom: 10 }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="search name or content…"
          style={{ maxWidth: 240 }}
        />
        {filterSelect(stageFilter, setStageFilter, stages, "stage: all")}
        {filterSelect(levelFilter, setLevelFilter, levels, "level: all")}
        {filterSelect(kindFilter, setKindFilter, kinds, "kind: all")}
        {filterSelect(exitStateFilter, setExitStateFilter, exitStates, "exit state: all")}
      </div>
      <table className="stats-table">
        <thead>
          <tr>
            {th("name", "Name")}
            {th("stage", "Stage")}
            {th("level", "Level")}
            {th("intake_kind", "Kind")}
            {th("exit_state", "Exit State")}
            {th("created_at", "Created")}
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => {
            const group = relationGroups.get(t.task_id);
            return (
              <tr key={t.task_id}>
                <td>
                  <span className="dot" style={{ background: group ? group.color : "transparent", marginRight: 6 }} title={group ? "part of a related task family" : undefined} />
                  <Link to="/tasks/$taskId" params={{ taskId: t.task_id }}>{t.name ?? t.task_id.slice(0, 8)}</Link>
                </td>
                <td>{t.stage ?? "—"}</td>
                <td>{t.level ?? "—"}</td>
                <td>{t.intake_kind ?? "—"}</td>
                <td>{t.exit_state ?? "—"}</td>
                <td>{t.created_at ?? "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
