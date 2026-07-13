import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";

export function Projects() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const [name, setName] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [err, setErr] = useState("");

  const create = useMutation({
    mutationFn: () => api.createProject({ name, repo_path: repoPath }),
    onSuccess: () => {
      setName("");
      setRepoPath("");
      setErr("");
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (e: Error) => setErr(e.message),
  });

  return (
    <div>
      <div className="panel">
        <h2>Register a repository</h2>
        <div className="grid-2">
          <div>
            <label>Project name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-service" />
          </div>
          <div>
            <label>Absolute repo path (must be a git repo)</label>
            <input value={repoPath} onChange={(e) => setRepoPath(e.target.value)} placeholder="/Users/me/code/my-service" />
          </div>
        </div>
        {err && <p className="pill bad" style={{ marginTop: 8 }}>{err}</p>}
        <div style={{ marginTop: 10 }}>
          <button className="primary" disabled={!name || !repoPath || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? "Registering…" : "Register project"}
          </button>
        </div>
      </div>

      <div className="panel">
        <h2>Projects</h2>
        {isLoading ? (
          <p className="muted">Loading…</p>
        ) : !data?.projects.length ? (
          <p className="empty">No projects yet. Register a git repo above to begin.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Name</th><th>Repo</th><th>Default model</th><th></th></tr>
            </thead>
            <tbody>
              {data.projects.map((p) => (
                <tr key={p.id}>
                  <td><Link to="/projects/$projectId" params={{ projectId: String(p.id) }}>{p.name}</Link></td>
                  <td className="muted">{p.repo_path}</td>
                  <td className="muted">{p.default_model ?? "—"}</td>
                  <td><Link to="/projects/$projectId/roles" params={{ projectId: String(p.id) }}>roles</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
