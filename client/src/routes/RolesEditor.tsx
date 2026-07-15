import { useState, useRef, useEffect } from "react";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Role, type ModelConfig } from "../api";

/** Known pi built-in tools (also serves as the dropdown suggestion list). */
const KNOWN_TOOLS = ["read", "grep", "find", "ls", "git_history"] as const;

/** Tag-style input: shows selected items as chips and provides a dropdown to pick. */
function TagInput({
  value,
  onChange,
  suggestions,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  suggestions: readonly string[];
}) {
  const [text, setText] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = text.trim()
    ? suggestions.filter(
        (s) =>
          s.toLowerCase().includes(text.toLowerCase()) &&
          !value.includes(s),
      )
    : suggestions.filter((s) => !value.includes(s));

  // Reset active index when filtered list changes.
  useEffect(() => {
    setActiveIdx(0);
  }, [filtered.length]);

  // Close dropdown on outside click.
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function add(tool: string) {
    const trimmed = tool.trim();
    if (!trimmed || value.includes(trimmed)) return;
    onChange([...value, trimmed]);
    setText("");
    setShowDropdown(false);
  }

  function remove(tool: string) {
    onChange(value.filter((t) => t !== tool));
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && !text && value.length > 0) {
      remove(value[value.length - 1]!);
      return;
    }
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (showDropdown && filtered.length > 0) {
        add(filtered[activeIdx] ?? filtered[0] ?? text);
      } else if (text.trim()) {
        add(text);
      }
      return;
    }
    if (e.key === "Escape") {
      setShowDropdown(false);
      return;
    }
    if (showDropdown) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => Math.max(i - 1, 0));
      }
    }
  }

  return (
    <div className="tag-input" ref={containerRef}>
      <div
        className="tag-input-container"
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((t) => (
          <span key={t} className="tag-chip">
            {t}
            <button
              type="button"
              className="tag-remove"
              onClick={(e) => {
                e.stopPropagation();
                remove(t);
              }}
              tabIndex={-1}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          className="tag-input-field"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setShowDropdown(true);
          }}
          onFocus={() => setShowDropdown(true)}
          onKeyDown={handleKey}
          placeholder={value.length === 0 ? "Add tools…" : ""}
        />
      </div>
      {showDropdown && filtered.length > 0 && (
        <div className="tag-dropdown">
          {filtered.map((s, i) => (
            <div
              key={s}
              className={`tag-dropdown-item${i === activeIdx ? " active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault(); // prevent input blur
                add(s);
              }}
              onMouseEnter={() => setActiveIdx(i)}
            >
              {s}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Bubble-picker dropdown for model overrides — mimics the "Get models" flow in Models. */
function ModelPicker({
  value,
  onChange,
  configs,
  defaultConfigName,
}: {
  value: string;
  onChange: (v: string) => void;
  configs: ModelConfig[];
  defaultConfigName: string;
}) {
  const [showDropdown, setShowDropdown] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click.
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const selectedConfig = configs.find((c) => c.name === value);
  const displayText = value || `(default: ${defaultConfigName})`;

  return (
    <div className="model-picker" ref={containerRef}>
      {value ? (
        <div className="model-picker-chip">
          <span className="model-picker-chip-label">{value}</span>
          {selectedConfig && (
            <span className="muted" style={{ fontSize: 10 }}>
              {selectedConfig.default_model ?? "—"}
            </span>
          )}
          <button
            type="button"
            className="tag-remove"
            onClick={(e) => {
              e.stopPropagation();
              onChange("");
            }}
            tabIndex={-1}
          >
            ×
          </button>
        </div>
      ) : (
        <button
          className="model-picker-trigger small"
          onClick={() => setShowDropdown((o) => !o)}
        >
          {displayText}
        </button>
      )}

      {value && (
        <button
          className="model-picker-change small"
          style={{ marginLeft: 6, fontSize: 10 }}
          onClick={() => setShowDropdown((o) => !o)}
        >
          change
        </button>
      )}

      {showDropdown && (
        <div
          className="model-picker-dropdown"
          style={{
            marginTop: 6,
            padding: "6px 8px",
            background: "var(--bg-depth)",
            borderRadius: 6,
            maxHeight: 200,
            overflowY: "auto",
            display: "flex",
            flexWrap: "wrap",
            gap: 4,
          }}
        >
          {configs.map((cfg) => (
            <button
              key={cfg.id}
              className="small"
              style={{
                fontSize: 10,
                padding: "2px 8px",
                background: value === cfg.name ? "var(--brass)" : "var(--bg-hover)",
                color: value === cfg.name ? "var(--bg-base)" : "inherit",
              }}
              onClick={() => {
                onChange(value === cfg.name ? "" : (cfg.name ?? ""));
                setShowDropdown(false);
              }}
              title={cfg.default_model ? `${cfg.name ?? cfg.key} → ${cfg.default_model}` : (cfg.name ?? cfg.key)}
            >
              {cfg.name ?? cfg.key}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function RoleCard({
  projectId,
  role,
  defaultOpen,
  modelConfigs,
  defaultModelConfigName,
}: {
  projectId: number;
  role: Role;
  defaultOpen: boolean;
  modelConfigs: ModelConfig[];
  defaultModelConfigName: string;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(defaultOpen);
  const [prompt, setPrompt] = useState(role.system_prompt ?? "");
  const [tools, setTools] = useState<string[]>(() => {
    try {
      return JSON.parse(role.tools_json ?? "[]") as string[];
    } catch {
      return [];
    }
  });
  const [model, setModel] = useState(role.model ?? "");
  const [enabled, setEnabled] = useState(role.enabled === 1);
  const [canCreateSubtasks, setCanCreateSubtasks] = useState(role.can_create_subtasks === 1);

  const save = useMutation({
    mutationFn: () =>
      api.saveRole(projectId, role.key, {
        system_prompt: prompt,
        tools_json: JSON.stringify(tools),
        model: model || undefined,
        enabled: enabled ? 1 : 0,
        can_create_subtasks: canCreateSubtasks ? 1 : 0,
      } as Partial<Role>),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["roles", projectId] }),
  });

  return (
    <div className="panel" id={`role-${role.key}`}>
      <div className="row">
        <button className="small" onClick={() => setOpen((o) => !o)}>{open ? "▾" : "▸"}</button>
        <strong>{role.title ?? role.key}</strong>
        <span className="pill dim">{role.key}</span>
        {role.project_id != null && <span className="pill ok">project override</span>}
        {!enabled && <span className="pill bad">disabled</span>}
      </div>
      {open && (
        <div className="role-editor" style={{ marginTop: 10 }}>
          <label><input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> enabled</label>
          <label><input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={canCreateSubtasks} onChange={(e) => setCanCreateSubtasks(e.target.checked)} /> Can Create Subtasks</label>
          <label>Tools</label>
          <TagInput
            value={tools}
            onChange={setTools}
            suggestions={KNOWN_TOOLS}
          />
          <label>Model override (optional)</label>
          <ModelPicker
            value={model}
            onChange={setModel}
            configs={modelConfigs}
            defaultConfigName={defaultModelConfigName}
          />
          <label>System prompt</label>
          <textarea style={{ minHeight: 250 }} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
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
  const { role: targetRole } = useSearch({ strict: false }) as { role?: string };
  const { data: mcData } = useQuery({
    queryKey: ["model-configs"],
    queryFn: api.modelConfigs,
  });

  const configs = mcData?.configs ?? [];
  const defaultModelConfigName =
    configs.find((c) => c.project_id === null && c.key === "default")?.name ?? "(none)";

  // Scroll to the target role after data loads
  useEffect(() => {
    if (targetRole && data) {
      const el = document.getElementById(`role-${targetRole}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }
  }, [targetRole, data]);

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
        data?.roles.map((r) => (
          <RoleCard
            key={r.key}
            projectId={pid}
            role={r}
            defaultOpen={r.key === targetRole}
            modelConfigs={configs}
            defaultModelConfigName={defaultModelConfigName}
          />
        ))
      )}
    </div>
  );
}
