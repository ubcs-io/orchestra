import { useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, STAGES, type Plan, type Task } from "../api";

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

function TaskCard({ task }: { task: Task }) {
  return (
    <Link to="/tasks/$taskId" params={{ taskId: task.task_id }} className="card" style={{ display: "block", color: "inherit" }}>
      <div className="title">{task.name ?? task.task_id.slice(0, 8)}</div>
      <div className="meta">
        <span className="pill dim">{task.level}</span>
        <span>{planProgress(task)}</span>
        {task.paused === 1 && <span className="pill warn">paused</span>}
        {task.exit_state && <span className={`pill ${task.exit_state === "ready_for_work" ? "ok" : "human"}`}>{task.exit_state}</span>}
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

  const submit = useMutation({
    mutationFn: () => api.intake(pid, { name: name || "intake", content, intake_kind: kind }),
    onSuccess: () => {
      setContent("");
      setName("");
      qc.invalidateQueries({ queryKey: ["tasks", pid] });
    },
  });

  const byStage = (stage: string) => (tasksQ.data?.tasks ?? []).filter((t) => (t.stage ?? "intake") === stage);

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0, color: "var(--brass)" }}>{projectQ.data?.project.name ?? "Project"}</h2>
        <span className="muted">{projectQ.data?.project.repo_path}</span>
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
            <h3>{stage} ({byStage(stage).length})</h3>
            <div className="cards">
              {byStage(stage).map((t) => <TaskCard key={t.task_id} task={t} />)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
