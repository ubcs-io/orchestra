import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Project } from "../api";

export interface GitHubBubbleProps {
  project: Project;
}

/** Project GitHub token / owner-repo-override indicator, modeled on ModelBubble:
 *  click opens a small form to set the PAT used to push task branches and open
 *  PRs (see DiffPanel). The token itself is never echoed back by the server —
 *  the input always starts blank and only overwrites the stored value if typed into. */
export function GitHubBubble({ project }: GitHubBubbleProps) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [repo, setRepo] = useState(project.github_repo ?? "");
  const wrapRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["project", project.id] });
    qc.invalidateQueries({ queryKey: ["projects"] });
  };

  const save = useMutation({
    mutationFn: () => {
      const body: { github_token?: string; github_repo?: string | null } = { github_repo: repo.trim() || null };
      if (token) body.github_token = token;
      return api.updateProject(project.id, body);
    },
    onSuccess: () => {
      setToken("");
      setOpen(false);
      invalidate();
    },
  });

  const clearToken = useMutation({
    mutationFn: () => api.updateProject(project.id, { github_token: "" }),
    onSuccess: () => {
      setToken("");
      invalidate();
    },
  });

  return (
    <div className="model-bubble" ref={wrapRef}>
      <button
        type="button"
        className={`pill info-tip model-bubble-trigger ${project.has_github_token ? "ok" : "dim"}`}
        onClick={() => setOpen((o) => !o)}
      >
        {project.has_github_token ? "GitHub: configured" : "GitHub: not configured"}
      </button>
      {open && (
        <div className="model-bubble-dropdown" style={{ width: 260, maxHeight: "none" }}>
          <label style={{ marginTop: 0 }}>GitHub token (repo scope)</label>
          <input
            type="password"
            placeholder={project.has_github_token ? "•••••••• (configured)" : "ghp_…"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <label>owner/repo override</label>
          <input
            type="text"
            placeholder="(derived from origin remote)"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
          />
          <div className="modal-actions" style={{ marginTop: 10 }}>
            {project.has_github_token && (
              <button type="button" className="small" disabled={clearToken.isPending} onClick={() => clearToken.mutate()}>
                Clear token
              </button>
            )}
            <button type="button" className="small primary" disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
