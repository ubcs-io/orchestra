import { useState, useRef, useEffect } from "react";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Role, type ModelConfig, type RoleStats } from "../api";

/** Known pi built-in + custom tools (also serves as the dropdown suggestion
 *  list). Mirrors server/src/harness-policy.ts's ALL_KNOWN_TOOL_NAMES — kept
 *  as a hand-copied literal here rather than shared, consistent with how this
 *  list was already just a client mirror before write/edit existed. */
const KNOWN_TOOLS = ["read", "grep", "find", "ls", "git_history", "write", "edit"] as const;

/** The two write-capable tool names — only addable when a project's harness
 *  policy has allowWrite on. Mirrors server/src/harness-policy.ts's WRITE_TOOL_NAMES. */
const WRITE_TOOL_NAMES = ["write", "edit"] as const;

/** Format a number of tokens: 1234 → "1.2k", 1234567 → "1.2M" */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Tag-style input: shows selected items as chips and provides a dropdown to pick. */
function TagInput({
  value,
  onChange,
  suggestions,
  restrictTo,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  suggestions: readonly string[];
  /** When set, only these values may be newly added — the input can't be used
   *  to type an unknown tool name or a policy-disallowed one (e.g. write/edit
   *  while the project's harness policy is off). Values already in `value`
   *  but outside this set are still shown (as disabled chips) and removable —
   *  see `add()`/the chip rendering below. */
  restrictTo?: readonly string[];
}) {
  const [text, setText] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const addableSuggestions = restrictTo ? suggestions.filter((s) => restrictTo.includes(s)) : suggestions;
  const filtered = text.trim()
    ? addableSuggestions.filter(
        (s) =>
          s.toLowerCase().includes(text.toLowerCase()) &&
          !value.includes(s),
      )
    : addableSuggestions.filter((s) => !value.includes(s));

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
    if (restrictTo && !restrictTo.includes(trimmed)) return;
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
        {value.map((t) => {
          const disallowed = restrictTo && !restrictTo.includes(t);
          return (
            <span
              key={t}
              className={`tag-chip${disallowed ? " tag-chip-disabled" : ""}`}
              title={disallowed ? "disabled by this project's harness policy" : undefined}
            >
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
          );
        })}
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

/**
 * Bubble-picker dropdown for model overrides — mimics the "Get models" flow in Models.
 *
 * Stores the selected config's `name` (not its `default_model`) as the role's model
 * override — the server resolves that name back to the config's own connection
 * (base URL/auth/text_mode/two_phase/etc.) and real `default_model` at run time
 * via `resolveConnectionForModel()`. Shared between RolesEditor and NetworkEditor
 * so both surfaces store/display role.model consistently.
 */
export function ModelPicker({
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
              title={
                cfg.default_model
                  ? `Runs on ${cfg.name ?? cfg.key}'s own connection (${cfg.default_model}, ` +
                    `${cfg.text_mode ? "text mode" : cfg.two_phase ? "two-phase mode" : "native tool-calling"})`
                  : (cfg.name ?? cfg.key)
              }
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
  stats,
  allowWrite,
}: {
  projectId: number;
  role: Role;
  defaultOpen: boolean;
  modelConfigs: ModelConfig[];
  defaultModelConfigName: string;
  stats?: RoleStats;
  /** This project's current harness policy — governs whether write/edit can
   *  be newly added to this role's tools. */
  allowWrite: boolean;
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

  // Parse title to separate the role type name from its software equivalent.
  // Titles look like "Requirements Analyst (Product Manager)" — the parenthetical
  // part is the human-job equivalent; the part before it is the role type.
  const titleMatch = (role.title ?? "").match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  const displayTitle = titleMatch ? titleMatch[1]! : (role.title ?? role.key);
  const softwareEquivalent = titleMatch ? titleMatch[2]! : null;

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

  function toggle() {
    setOpen((o) => !o);
  }

  return (
    <div className="panel" id={`role-${role.key}`}>
      <div className="row role-card-header" onClick={toggle} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") toggle(); }}>
        <span className="collapse-caret">{open ? "▾" : "▸"}</span>
        <strong className="role-card-title">{displayTitle}</strong>
        <span className="pill dim role-card-key">{softwareEquivalent ?? role.key}</span>
        {role.project_id != null && <span className="pill ok">project override</span>}
        {!enabled && <span className="pill bad">disabled</span>}
        {stats && (
          <>
            <span className="pill role-stat" title="Times this role has been called">calls {stats.total_calls}</span>
            <span className="pill role-stat" title="Verdict = pass">pass {stats.pass_count}</span>
            <span className="pill role-stat" title="Counter-reviewer passed">review {stats.counter_reviewer_passes}</span>
            <span className="pill role-stat" title="Networks containing this role">nets {stats.network_count}</span>
            <span className="pill role-stat" title="Tokens used">{fmtTokens(stats.total_tokens)} t</span>
          </>
        )}
      </div>
      {open && (
        <div className="role-editor" style={{ marginTop: 10 }}>
          <div>
            <label><input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> enabled</label>
            <label><input type="checkbox" style={{ width: "auto", marginRight: 6 }} checked={canCreateSubtasks} onChange={(e) => setCanCreateSubtasks(e.target.checked)} /> Can Create Subtasks</label>
            <label>Tools</label>
            <TagInput
              value={tools}
              onChange={setTools}
              suggestions={KNOWN_TOOLS}
              restrictTo={
                allowWrite ? KNOWN_TOOLS : KNOWN_TOOLS.filter((t) => !(WRITE_TOOL_NAMES as readonly string[]).includes(t))
              }
            />
            <label>Model override (optional)</label>
            <ModelPicker
              value={model}
              onChange={setModel}
              configs={modelConfigs}
              defaultConfigName={defaultModelConfigName}
            />
            <div style={{ marginTop: 8 }}>
              <button className="primary" disabled={save.isPending} onClick={() => save.mutate()}>
                {save.isPending ? "Saving…" : "Save project override"}
              </button>
            </div>
          </div>
          <div>
            <label>System prompt</label>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </div>
        </div>
      )}
    </div>
  );
}

/** Toggle card for this project's harness write policy — governs whether any
 *  role below may have write/edit added to its tools (see the TagInput's
 *  restrictTo below and server/src/harness-policy.ts). */
function HarnessPolicyCard({ projectId }: { projectId: number }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["harness-policy", projectId],
    queryFn: () => api.harnessPolicy(projectId),
  });

  const save = useMutation({
    mutationFn: (allowWrite: boolean) => api.saveHarnessPolicy(projectId, { allowWrite }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["harness-policy", projectId] });
      qc.invalidateQueries({ queryKey: ["safety"] });
    },
  });

  const allowWrite = data?.policy.allowWrite ?? false;

  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <div className="row" style={{ justifyContent: "flex-start", gap: 10 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, width: "auto" }}>
          <input
            type="checkbox"
            style={{ width: "auto" }}
            checked={allowWrite}
            disabled={save.isPending}
            onChange={(e) => save.mutate(e.target.checked)}
          />
          Allow write/edit tools in this project
        </label>
        {save.isError && <span className="pill bad" style={{ fontSize: 10 }}>{(save.error as Error).message}</span>}
      </div>
      <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
        When on, roles below can be granted <code>write</code>/<code>edit</code> tools — jailed to each task's own
        git worktree, never the shared checkout. Turning this off doesn't remove write/edit from a role's stored
        tools, it just stops them from running until re-enabled.
      </p>
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
  const { data: statsData } = useQuery({
    queryKey: ["role-stats"],
    queryFn: api.roleStats,
  });
  const { data: policyData } = useQuery({
    queryKey: ["harness-policy", pid],
    queryFn: () => api.harnessPolicy(pid),
  });
  const allowWrite = policyData?.policy.allowWrite ?? false;

  const configs = mcData?.configs ?? [];
  const defaultModelConfigName =
    configs.find((c) => c.project_id === null && c.key === "default")?.name ?? "(none)";

  const statsByKey = new Map<string, RoleStats>();
  if (statsData?.stats) {
    for (const s of statsData.stats) {
      statsByKey.set(s.role_key, s);
    }
  }

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
      <HarnessPolicyCard projectId={pid} />
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
            stats={statsByKey.get(r.key)}
            allowWrite={allowWrite}
          />
        ))
      )}
    </div>
  );
}