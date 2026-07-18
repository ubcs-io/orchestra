import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, displayModelName, type Role } from "../api";

export interface ModelBubbleProps {
  projectId: number;
  defaultModel: string | null;
  roles: Role[];
}

/**
 * Project-default-model indicator. Hover reveals any role model overrides (read-only);
 * click opens a dropdown to change the project's default model. Overrides are untouched
 * by this control — they're edited on the roles page.
 */
export function ModelBubble({ projectId, defaultModel, roles }: ModelBubbleProps) {
  const overrides = roles.filter((r) => !!r.model);
  const [showDropdown, setShowDropdown] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();
  const configsQ = useQuery({ queryKey: ["modelConfigs"], queryFn: () => api.modelConfigs() });

  useEffect(() => {
    if (!showDropdown) return;
    function handleClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setShowDropdown(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showDropdown]);

  const setDefault = useMutation({
    mutationFn: (name: string | null) => api.updateProject(projectId, { default_model: name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      setShowDropdown(false);
    },
  });

  return (
    <div className="model-bubble" ref={wrapRef}>
      <button
        type="button"
        className="pill info-tip model-bubble-trigger"
        onClick={() => setShowDropdown((o) => !o)}
      >
        {defaultModel ? displayModelName(defaultModel) : "no default model"}
        {!showDropdown && (
          <span className="info-tip-popup">
            {overrides.length === 0 ? (
              "No role overrides"
            ) : (
              <div className="model-list">
                {overrides.map((r) => (
                  <div className="model" key={r.id}>
                    <span>{r.title ?? r.key}</span>
                    <span>→ {displayModelName(r.model as string)}</span>
                  </div>
                ))}
              </div>
            )}
          </span>
        )}
      </button>
      {showDropdown && (
        <div className="model-bubble-dropdown">
          {(configsQ.data?.configs ?? []).map((cfg) => (
            <button
              key={cfg.id}
              type="button"
              className="small"
              style={{
                background: cfg.name === defaultModel ? "var(--brass)" : "var(--bg-hover)",
                color: cfg.name === defaultModel ? "var(--bg-base)" : "inherit",
              }}
              disabled={setDefault.isPending}
              onClick={() => setDefault.mutate(cfg.name ?? null)}
            >
              {cfg.name ?? cfg.key}
            </button>
          ))}
          {configsQ.data?.configs.length === 0 && (
            <span className="muted" style={{ fontSize: 11 }}>No model configs</span>
          )}
        </div>
      )}
    </div>
  );
}
