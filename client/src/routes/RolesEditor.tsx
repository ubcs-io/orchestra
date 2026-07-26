import { useState, useRef, useEffect } from "react";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ExecCommand, type HarnessPolicy, type Role, type ModelConfig, type RoleStats, type AutonomyLevel, type PlanningRigor } from "../api";

/** Known pi built-in + custom tools (also serves as the dropdown suggestion
 *  list). Mirrors server/src/harness-policy.ts's ALL_KNOWN_TOOL_NAMES — kept
 *  as a hand-copied literal here rather than shared, consistent with how this
 *  list was already just a client mirror before write/edit existed. */
const KNOWN_TOOLS = ["read", "grep", "find", "ls", "git_history", "write", "edit", "run_command"] as const;

/** The two write-capable tool names — only addable when a project's harness
 *  policy has allowWrite on. Mirrors server/src/harness-policy.ts's WRITE_TOOL_NAMES. */
const WRITE_TOOL_NAMES = ["write", "edit"] as const;

/** The command-execution tool — only addable when a project's harness policy
 *  has allowExec on AND has at least one approved command. Mirrors
 *  server/src/harness-policy.ts's EXEC_TOOL_NAME. */
const EXEC_TOOL_NAME = "run_command";

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
  allowExec,
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
  /** Whether `run_command` can be newly added — exec on with a non-empty menu. */
  allowExec: boolean;
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
              restrictTo={KNOWN_TOOLS.filter(
                (t) =>
                  (allowWrite || !(WRITE_TOOL_NAMES as readonly string[]).includes(t)) &&
                  (allowExec || t !== EXEC_TOOL_NAME),
              )}
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

/** Split an argv text field on whitespace. Deliberately simple: an argument
 *  containing a space is rare for a build/test command and, if genuinely
 *  needed, belongs in the project's config_json rather than behind quoting
 *  rules a reader of this field would have to guess at. */
function parseArgv(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

/**
 * Exec policy editor (PLANNING/overhaul/05): the switch, the approved command
 * menu, and the run bounds.
 *
 * The warning text here is load-bearing, not decoration. The worktree confines
 * what the *agent* writes; it does nothing to confine a process the agent
 * starts. Whoever flips this switch is deciding that this repository's test
 * suite — and every lifecycle script its dependencies bring along — may run as
 * the user this daemon runs as. That has to be said where the decision is made.
 */
function ExecPolicyCard({ projectId }: { projectId: number }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["harness-policy", projectId],
    queryFn: () => api.harnessPolicy(projectId),
  });
  const policy = data?.policy;

  const [draft, setDraft] = useState<ExecCommand[] | null>(null);
  const [caps, setCaps] = useState<Pick<
    HarnessPolicy,
    "execTimeoutMs" | "execMaxOutputBytes" | "execMaxRuns"
  > | null>(null);

  // Adopt the server's values once loaded, and again after a save — but never
  // clobber an edit in progress.
  useEffect(() => {
    if (!policy) return;
    setDraft((d) => d ?? policy.execAllowlist ?? []);
    setCaps(
      (c) =>
        c ?? {
          execTimeoutMs: policy.execTimeoutMs,
          execMaxOutputBytes: policy.execMaxOutputBytes,
          execMaxRuns: policy.execMaxRuns,
        },
    );
  }, [policy]);

  const save = useMutation({
    mutationFn: (patch: Parameters<typeof api.saveHarnessPolicy>[1]) =>
      api.saveHarnessPolicy(projectId, patch),
    onSuccess: (res) => {
      setDraft(res.policy.execAllowlist ?? []);
      qc.invalidateQueries({ queryKey: ["harness-policy", projectId] });
      qc.invalidateQueries({ queryKey: ["safety"] });
    },
  });

  if (!policy || draft === null || caps === null) return null;
  const allowExec = policy.allowExec ?? false;
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(policy.execAllowlist ?? []) ||
    caps.execTimeoutMs !== policy.execTimeoutMs ||
    caps.execMaxOutputBytes !== policy.execMaxOutputBytes ||
    caps.execMaxRuns !== policy.execMaxRuns;

  const patchCommand = (i: number, patch: Partial<ExecCommand>) =>
    setDraft((d) => (d ?? []).map((c, idx) => (idx === i ? { ...c, ...patch } : c)));

  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <div className="row" style={{ justifyContent: "flex-start", gap: 10 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, width: "auto" }}>
          <input
            type="checkbox"
            style={{ width: "auto" }}
            checked={allowExec}
            disabled={save.isPending}
            onChange={(e) => save.mutate({ allowExec: e.target.checked })}
          />
          Allow <code>run_command</code> in this project
        </label>
        {allowExec && (draft.length === 0) && (
          <span className="pill warn" style={{ fontSize: 10 }}>
            no approved commands — the tool stays unavailable
          </span>
        )}
        {save.isError && (
          <span className="pill bad" style={{ fontSize: 10 }}>{(save.error as Error).message}</span>
        )}
      </div>

      <div className="banner warn" style={{ margin: "8px 0", fontSize: 11 }}>
        ⚠ This is not a sandbox.{" "}
        <span className="banner-why">
          An approved command runs this repository's own code — including whatever its dependencies
          run on install or test — with the same OS privileges as this server process. The task
          worktree isolates the agent's <em>file edits</em>; it does not contain a process it starts.
          Turn this on for repositories you would run these commands in yourself, and no others.
          There is no shell: only the exact argv listed below can run.
        </span>
      </div>

      {allowExec && (
        <>
          <label style={{ fontSize: 12 }}>Approved commands</label>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
            {draft.map((c, i) => (
              <div
                key={i}
                style={{ border: "1px solid var(--border, #333)", borderRadius: 6, padding: 8 }}
              >
                <div className="row" style={{ justifyContent: "flex-start", gap: 8, flexWrap: "wrap" }}>
                  <input
                    style={{ width: 130 }}
                    placeholder="name (e.g. test)"
                    value={c.name}
                    onChange={(e) => patchCommand(i, { name: e.target.value })}
                  />
                  <input
                    style={{ flex: 1, minWidth: 220 }}
                    placeholder="command, e.g. npm test"
                    value={c.argv.join(" ")}
                    onChange={(e) => patchCommand(i, { argv: parseArgv(e.target.value) })}
                  />
                  <label
                    style={{ display: "flex", alignItems: "center", gap: 4, width: "auto", fontSize: 11 }}
                    title="Let the model append extra arguments (regex-validated). A real extension of trust — leave off unless you need it."
                  >
                    <input
                      type="checkbox"
                      style={{ width: "auto" }}
                      checked={c.allowArgs ?? false}
                      onChange={(e) => patchCommand(i, { allowArgs: e.target.checked })}
                    />
                    extra args
                  </label>
                  <input
                    style={{ width: 110 }}
                    type="number"
                    placeholder="timeout ms"
                    value={c.timeoutMs ?? ""}
                    onChange={(e) =>
                      patchCommand(i, {
                        timeoutMs: e.target.value ? Number(e.target.value) : undefined,
                      })
                    }
                  />
                  <button
                    className="small"
                    onClick={() => setDraft((d) => (d ?? []).filter((_, idx) => idx !== i))}
                  >
                    ✕
                  </button>
                </div>
                <div className="muted" style={{ fontSize: 10, marginTop: 4 }}>
                  runs: <code>{c.argv.join(" ") || "(nothing — enter a command)"}</code>
                  {c.allowArgs && " + model-supplied arguments"}
                </div>
                {c.allowArgs && (
                  <input
                    style={{ marginTop: 4, fontSize: 11 }}
                    placeholder="argument pattern (regex, default ^[A-Za-z0-9._/:@=+-]+$)"
                    value={c.argPattern ?? ""}
                    onChange={(e) => patchCommand(i, { argPattern: e.target.value || undefined })}
                  />
                )}
              </div>
            ))}
          </div>
          <div className="row" style={{ justifyContent: "flex-start", gap: 8, marginTop: 8 }}>
            <button
              className="small"
              onClick={() => setDraft((d) => [...(d ?? []), { name: "", argv: [] }])}
            >
              + command
            </button>
            {["test", "typecheck", "lint", "build"].map((preset) => (
              <button
                key={preset}
                className="small"
                title={`Add a "${preset}" entry to fill in`}
                disabled={draft.some((c) => c.name === preset)}
                onClick={() =>
                  setDraft((d) => [
                    ...(d ?? []),
                    {
                      name: preset,
                      argv:
                        preset === "typecheck"
                          ? ["npx", "tsc", "--noEmit"]
                          : preset === "test"
                            ? ["npm", "test"]
                            : ["npm", "run", preset],
                    },
                  ])
                }
              >
                + {preset}
              </button>
            ))}
          </div>

          <div className="row" style={{ justifyContent: "flex-start", gap: 12, marginTop: 10, flexWrap: "wrap" }}>
            <label style={{ width: "auto", fontSize: 11 }}>
              default timeout (ms)
              <input
                type="number"
                style={{ width: 110 }}
                value={caps.execTimeoutMs ?? ""}
                onChange={(e) => setCaps({ ...caps, execTimeoutMs: Number(e.target.value) })}
              />
            </label>
            <label style={{ width: "auto", fontSize: 11 }}>
              output cap (bytes)
              <input
                type="number"
                style={{ width: 110 }}
                value={caps.execMaxOutputBytes ?? ""}
                onChange={(e) => setCaps({ ...caps, execMaxOutputBytes: Number(e.target.value) })}
              />
            </label>
            <label style={{ width: "auto", fontSize: 11 }} title="Maximum executions per role run">
              runs per turn
              <input
                type="number"
                style={{ width: 80 }}
                value={caps.execMaxRuns ?? ""}
                onChange={(e) => setCaps({ ...caps, execMaxRuns: Number(e.target.value) })}
              />
            </label>
          </div>

          <div style={{ marginTop: 8 }}>
            <button
              className="primary"
              disabled={!dirty || save.isPending}
              onClick={() =>
                save.mutate({
                  execAllowlist: draft.filter((c) => c.name.trim() && c.argv.length),
                  ...caps,
                })
              }
            >
              {save.isPending ? "Saving…" : "Save exec policy"}
            </button>
            {dirty && (
              <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>
                unsaved changes
              </span>
            )}
          </div>
          <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            Once at least one command is approved, <code>run_command</code> can be added to a role's
            tools below. Commands named <code>test</code> and <code>typecheck</code> additionally
            become <em>gating</em> for code-change tasks: the task cannot reach merge review until a
            recorded run of them exits 0.
          </p>
        </>
      )}
    </div>
  );
}

/** Kill-switch + schedule/budget editor for a project's autonomy policy
 *  (PLANNING/overhaul/08 §3). Mirrors HarnessPolicyCard's draft-adopted-once
 *  pattern; PATCHes only this card's own slice of the config, so it can't
 *  clobber the watcher list WatchersListCard below edits independently. */
function AutonomyPolicyCard({ projectId }: { projectId: number }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["autonomy-config", projectId],
    queryFn: () => api.autonomyConfig(projectId),
  });
  const cfg = data?.config;

  const [restrictHours, setRestrictHours] = useState(false);
  const [hours, setHours] = useState({ start: "22:00", end: "07:00", weekendsAllDay: true });
  const [idleAfterMinutes, setIdleAfterMinutes] = useState(10);
  const [autoQueueDepth, setAutoQueueDepth] = useState(5);
  const [budgets, setBudgets] = useState({ maxTaskStarts: 10, maxTokens: 2_000_000, maxExecRuns: 50 });
  const [adopted, setAdopted] = useState(false);

  useEffect(() => {
    if (!cfg || adopted) return;
    setRestrictHours(cfg.activeHours != null);
    if (cfg.activeHours) setHours(cfg.activeHours);
    setIdleAfterMinutes(cfg.idleAfterMinutes);
    setAutoQueueDepth(cfg.autoQueueDepth);
    setBudgets(cfg.budgets);
    setAdopted(true);
  }, [cfg, adopted]);

  const save = useMutation({
    mutationFn: (patch: Parameters<typeof api.saveAutonomyConfig>[1]) => api.saveAutonomyConfig(projectId, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["autonomy-config", projectId] });
      qc.invalidateQueries({ queryKey: ["autonomy-budget", projectId] });
    },
  });

  if (!cfg) return null;

  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <div className="row" style={{ justifyContent: "flex-start", gap: 10 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, width: "auto" }}>
          <input
            type="checkbox"
            style={{ width: "auto" }}
            checked={cfg.enabled}
            disabled={save.isPending}
            onChange={(e) => save.mutate({ enabled: e.target.checked })}
          />
          Autonomy enabled (self-generated watcher tasks)
        </label>
        {save.isError && <span className="pill bad" style={{ fontSize: 10 }}>{(save.error as Error).message}</span>}
      </div>
      <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
        The kill-switch. Off (default) is fully inert — no scans, no self-generated tasks. Human-created
        tasks are never affected by this switch either way.
      </p>

      <div className="row" style={{ justifyContent: "flex-start", gap: 8, marginTop: 8 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, width: "auto" }}>
          <input
            type="checkbox"
            style={{ width: "auto" }}
            checked={restrictHours}
            onChange={(e) => setRestrictHours(e.target.checked)}
          />
          Restrict to a schedule window
        </label>
        {restrictHours && (
          <>
            <input
              type="time"
              style={{ width: 100 }}
              value={hours.start}
              onChange={(e) => setHours((h) => ({ ...h, start: e.target.value }))}
            />
            <span className="muted">to</span>
            <input
              type="time"
              style={{ width: 100 }}
              value={hours.end}
              onChange={(e) => setHours((h) => ({ ...h, end: e.target.value }))}
            />
            <label style={{ display: "flex", alignItems: "center", gap: 4, width: "auto", fontSize: 11 }}>
              <input
                type="checkbox"
                style={{ width: "auto" }}
                checked={hours.weekendsAllDay}
                onChange={(e) => setHours((h) => ({ ...h, weekendsAllDay: e.target.checked }))}
              />
              weekends all day
            </label>
          </>
        )}
      </div>

      <div className="row" style={{ justifyContent: "flex-start", gap: 12, marginTop: 10, flexWrap: "wrap" }}>
        <label style={{ width: "auto", fontSize: 11 }} title="How many minutes of no mutating API activity count as 'idle'">
          idle after (minutes)
          <input
            type="number"
            style={{ width: 80 }}
            value={idleAfterMinutes}
            onChange={(e) => setIdleAfterMinutes(Number(e.target.value))}
          />
        </label>
        <label style={{ width: "auto", fontSize: 11 }} title="Max open self-generated tasks at once">
          auto queue depth
          <input
            type="number"
            style={{ width: 80 }}
            value={autoQueueDepth}
            onChange={(e) => setAutoQueueDepth(Number(e.target.value))}
          />
        </label>
        <label style={{ width: "auto", fontSize: 11 }} title="Max watcher-originated task dispatches per idle window">
          max task starts / window
          <input
            type="number"
            style={{ width: 100 }}
            value={budgets.maxTaskStarts}
            onChange={(e) => setBudgets((b) => ({ ...b, maxTaskStarts: Number(e.target.value) }))}
          />
        </label>
        <label style={{ width: "auto", fontSize: 11 }} title="Max summed tokens across watcher-originated runs per idle window">
          max tokens / window
          <input
            type="number"
            style={{ width: 120 }}
            value={budgets.maxTokens}
            onChange={(e) => setBudgets((b) => ({ ...b, maxTokens: Number(e.target.value) }))}
          />
        </label>
        <label style={{ width: "auto", fontSize: 11 }} title="Max watcher scan command executions per idle window">
          max exec runs / window
          <input
            type="number"
            style={{ width: 100 }}
            value={budgets.maxExecRuns}
            onChange={(e) => setBudgets((b) => ({ ...b, maxExecRuns: Number(e.target.value) }))}
          />
        </label>
      </div>

      <div style={{ marginTop: 8 }}>
        <button
          className="primary"
          disabled={save.isPending}
          onClick={() =>
            save.mutate({
              activeHours: restrictHours ? hours : null,
              idleAfterMinutes,
              autoQueueDepth,
              budgets,
            })
          }
        >
          {save.isPending ? "Saving…" : "Save autonomy schedule/budgets"}
        </button>
      </div>
    </div>
  );
}

/** Project default for how far a task's own pipeline may progress unattended
 *  — a single-field select, so unlike AutonomyPolicyCard above it mutates
 *  directly on change with no separate Save button. Distinct from (and
 *  unrelated to) that card's watcher-scheduling config. */
function AutonomyLevelCard({ projectId }: { projectId: number }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["autonomy-level", projectId],
    queryFn: () => api.autonomyLevel(projectId),
  });
  const save = useMutation({
    mutationFn: (level: AutonomyLevel) => api.saveAutonomyLevel(projectId, level),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["autonomy-level", projectId] }),
  });

  if (!data) return null;

  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <label style={{ width: "auto", fontSize: 12 }}>
        Default autonomy level
        <select
          value={data.level}
          disabled={save.isPending}
          onChange={(e) => save.mutate(e.target.value as AutonomyLevel)}
          style={{ marginLeft: 8, width: "auto" }}
        >
          <option value="plan">plan — stop before any code is written</option>
          <option value="edit">edit — write code, park for human merge approval (default)</option>
          <option value="auto">auto — write code, auto-merge once checks pass (falls back to human on conflict)</option>
        </select>
      </label>
      {save.isError && (
        <p className="pill bad" style={{ fontSize: 10, marginTop: 6 }}>{(save.error as Error).message}</p>
      )}
      <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
        How far a task's own pipeline may progress unattended, project-wide.
        Any task can override this individually from its own detail page.
      </p>
    </div>
  );
}

/** Project default for how much the family-wide decomposition budget is
 *  scaled relative to a task's effort_size — mirrors AutonomyLevelCard above
 *  exactly. Labeled "Planning depth" (not "rigor") to avoid colliding with
 *  the unrelated counter-reviewer gate rigor and FLOW_TEMPLATES rigor tag. */
function PlanningRigorCard({ projectId }: { projectId: number }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["planning-rigor", projectId],
    queryFn: () => api.planningRigor(projectId),
  });
  const save = useMutation({
    mutationFn: (rigor: PlanningRigor) => api.savePlanningRigor(projectId, rigor),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["planning-rigor", projectId] }),
  });

  if (!data) return null;

  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <label style={{ width: "auto", fontSize: 12 }}>
        Default planning depth
        <select
          value={data.rigor}
          disabled={save.isPending}
          onChange={(e) => save.mutate(e.target.value as PlanningRigor)}
          style={{ marginLeft: 8, width: "auto" }}
        >
          <option value="minimal">minimal — fewer/smaller subtasks, favor executing directly</option>
          <option value="standard">standard — default budget (default)</option>
          <option value="thorough">thorough — allow more structure/review even for small work</option>
        </select>
      </label>
      {save.isError && (
        <p className="pill bad" style={{ fontSize: 10, marginTop: 6 }}>{(save.error as Error).message}</p>
      )}
      <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
        Scales the family-wide decomposition budget (how many subtasks a feature may spawn) relative
        to its estimated effort size, project-wide. Any task can override this individually from its
        own detail page.
      </p>
    </div>
  );
}

/** Watcher menu editor. Only "test-suite" ships this pass (PLANNING/overhaul/08
 *  §1) — the "+ watcher" affordance is deliberately disabled rather than
 *  pretending this is a general multi-watcher editor yet. */
function WatchersListCard({ projectId }: { projectId: number }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["autonomy-config", projectId],
    queryFn: () => api.autonomyConfig(projectId),
  });
  const watchers = data?.config.watchers ?? [];
  const testSuite = watchers.find((w) => w.name === "test-suite");

  const save = useMutation({
    mutationFn: (patch: Parameters<typeof api.saveAutonomyConfig>[1]) => api.saveAutonomyConfig(projectId, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["autonomy-config", projectId] }),
  });

  if (!data || !testSuite) return null;

  const patchTestSuite = (patch: Partial<typeof testSuite>) =>
    save.mutate({ watchers: watchers.map((w) => (w.name === "test-suite" ? { ...w, ...patch } : w)) });

  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <h3 style={{ margin: "0 0 8px" }}>Watchers</h3>
      <div style={{ border: "1px solid var(--border, #333)", borderRadius: 6, padding: 8 }}>
        <div className="row" style={{ justifyContent: "flex-start", gap: 10, flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, width: "auto" }}>
            <input
              type="checkbox"
              style={{ width: "auto" }}
              checked={testSuite.enabled}
              disabled={save.isPending}
              onChange={(e) => patchTestSuite({ enabled: e.target.checked })}
            />
            <strong>test-suite</strong>
          </label>
          <label style={{ width: "auto", fontSize: 11 }} title="Minimum minutes between two runs of this watcher">
            cadence (minutes)
            <input
              type="number"
              style={{ width: 80 }}
              value={testSuite.cadenceMinutes}
              onChange={(e) => patchTestSuite({ cadenceMinutes: Number(e.target.value) })}
            />
          </label>
          <label style={{ width: "auto", fontSize: 11 }} title="Max candidates from this watcher that may become tasks per day">
            daily cap
            <input
              type="number"
              style={{ width: 70 }}
              value={testSuite.perWatcherDailyCap}
              onChange={(e) => patchTestSuite({ perWatcherDailyCap: Number(e.target.value) })}
            />
          </label>
        </div>
        <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
          Runs this project's <code>test</code>/<code>typecheck</code> exec-allowlist commands (configured
          above) against a dedicated, read-only scan worktree of the default branch. Requires the same
          fingerprinted failure twice in a row before proposing a task, to filter out flakiness.
        </p>
        {save.isError && <span className="pill bad" style={{ fontSize: 10 }}>{(save.error as Error).message}</span>}
      </div>
      <div className="row" style={{ justifyContent: "flex-start", marginTop: 8 }}>
        <button className="small" disabled title="More watchers (todo-scan, lint-drift, dep-staleness, branch-triage, doc-drift) ship in a later pass">
          + watcher
        </button>
      </div>
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
  const policy = policyData?.policy;
  const allowWrite = policy?.allowWrite ?? false;
  // Both halves are required for the grant to mean anything (mirrors the
  // server's execEnabled): a switch with an empty menu registers no tool.
  const allowExec = (policy?.allowExec ?? false) && (policy?.execAllowlist?.length ?? 0) > 0;

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
      <ExecPolicyCard projectId={pid} />
      <AutonomyLevelCard projectId={pid} />
      <PlanningRigorCard projectId={pid} />
      <AutonomyPolicyCard projectId={pid} />
      <WatchersListCard projectId={pid} />
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
            allowExec={allowExec}
          />
        ))
      )}
    </div>
  );
}