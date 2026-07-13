import { useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Role } from "../api";

function RoleCard({ projectId, role }: { projectId: number; role: Role }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState(role.system_prompt ?? "");
  const [tools, setTools] = useState(() => {
    try {
      return (JSON.parse(role.tools_json ?? "[]") as string[]).join(", ");
    } catch {
      return "";
    }
  });
  const [model, setModel] = useState(role.model ?? "");
  const [enabled, setEnabled] = useState(role.enabled === 1);
  const [canCreateSubtasks, setCanCreateSubtasks] = useState(role.can_create_subtasks === 1);

  const save = useMutation({
    mutationFn: () =>
      api.saveRole(projectId, role.key, {
        system_prompt: prompt,
        tools_json: JSON.stringify(tools.split(",").map((s) => s.trim()).filter(Boolean)),
        model: model || undefined,
        enabled: enabled ? 1 : 0,
        can_create_subtasks: canCreateSubtasks ? 1 : 0,
      } as Partial<Role>),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["roles", projectId] }),
  });

  return (
    <div className="panel">
      <div className="row">
        <button className="small" onClick={() => setOpen((o) => !o)}>{open ? "▾" : "▸"}</button>
        <strong>{role.title ?? role.key}</strong>
        <span className="pill dim">{role.key}</span>
        {role.project_id != null && <span className="pill ok">project override</span>}
        {!enabled && <span className="pill bad">disabled</span>}
      </div>
      {open && (
        <div style={{ marginTop: 10 }}>
          <label><input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> enabled</label>
          <label><input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={canCreateSubtasks} onChange={(e) => setCanCreateSubtasks(e.target.checked)} /> Can Create Subtasks</label>
          <label>Tools (comma-separated pi built-ins: read, grep, find, ls)</label>
          <input value={tools} onChange={(e) => setTools(e.target.value)} />
          <label>Model override (optional)</label>
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="(project default)" />
          <label>System prompt</label>
          <textarea style={{ minHeight: 180 }} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <div style={{ marginTop: 8 }}>
            <button className="primary" disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Saving…" : "Save project override"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function RolesEditor() {
  const { projectId } = useParams({ strict: false }) as { projectId: string };
  const pid = Number(projectId);
  const { data, isLoading } = useQuery({ queryKey: ["roles", pid], queryFn: () => api.roles(pid) });

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <Link to="/projects/$projectId" params={{ projectId }}>← board</Link>
        <h2 style={{ margin: 0, color: "var(--brass)" }}>Role configuration</h2>
      </div>
      <p className="muted">Global defaults shown; saving creates a project-specific override that wins by key.</p>
      {isLoading ? (
        <p className="muted">Loading…</p>
      ) : (
        data?.roles.map((r) => <RoleCard key={r.key} projectId={pid} role={r} />)
      )}
    </div>
  );
}
