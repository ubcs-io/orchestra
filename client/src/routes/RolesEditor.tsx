import { useState, useRef, useEffect } from "react";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ExecCommand, type HarnessPolicy, type Role, type ModelConfig, type RoleStats, type AutonomyLevel, type PlanningRigor, type WatcherConfig } from "../api";

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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["roles", projectId] });
      // A save that changed prompt/tools/model just minted a version — the
      // open history panel would otherwise still show the pre-edit list.
      qc.invalidateQueries({ queryKey: ["role-versions", projectId, role.key] });
    },
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
            <RoleVersionHistory projectId={projectId} roleKey={role.key} />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Line-level diff between two prompt texts, as a longest-common-subsequence
 * walk. Hand-rolled rather than pulled from a library: a role prompt is a few
 * dozen lines, and this is the only diff in the client.
 */
type DiffLine = { kind: "same" | "add" | "del"; text: string };

function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: "del", text: a[i]! });
      i++;
    } else {
      out.push({ kind: "add", text: b[j]! });
      j++;
    }
  }
  while (i < a.length) out.push({ kind: "del", text: a[i++]! });
  while (j < b.length) out.push({ kind: "add", text: b[j++]! });
  return out;
}

const DIFF_COLORS: Record<DiffLine["kind"], { bg: string; mark: string }> = {
  same: { bg: "transparent", mark: "  " },
  add: { bg: "rgba(46, 139, 87, 0.18)", mark: "+ " },
  del: { bg: "rgba(192, 57, 43, 0.18)", mark: "- " },
};

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/**
 * Version history for one role (PLANNING/overhaul-2/03 §4): what each past
 * definition said, how its own runs actually turned out, and a one-click
 * revert.
 *
 * Two things this panel is careful about, both of them the doc's named risks:
 *
 *  - A version below the run-count floor is shown as *underpowered*, not bad.
 *    Two runs and one failure is noise, and rendering it as a confident 50%
 *    would be worse than showing nothing.
 *  - A version that changed prompt AND model at once can't attribute its score
 *    to either. That gets a badge, not a block — it's a nudge to change one
 *    thing at a time, not a rule.
 */
function RoleVersionHistory({ projectId, roleKey }: { projectId: number; roleKey: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [compareId, setCompareId] = useState<number | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["role-versions", projectId, roleKey],
    queryFn: () => api.roleVersions(projectId, roleKey),
    enabled: open,
  });

  const revert = useMutation({
    mutationFn: (versionId: number) => api.revertRoleVersion(projectId, roleKey, versionId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["role-versions", projectId, roleKey] });
      qc.invalidateQueries({ queryKey: ["roles", projectId] });
    },
  });

  const versions = data?.versions ?? [];
  const scoreById = new Map((data?.scores ?? []).map((s) => [s.version_id, s]));
  const current = versions.find((v) => v.id === data?.current_version_id) ?? versions[0];
  const compare = compareId != null ? versions.find((v) => v.id === compareId) : undefined;

  return (
    <div style={{ marginTop: 12, borderTop: "1px solid var(--border, #333)", paddingTop: 8 }}>
      <button className="small" onClick={() => setOpen((o) => !o)}>
        {open ? "History ▾" : "History ▸"}
      </button>
      {open && isLoading && <p className="muted" style={{ fontSize: 11 }}>Loading…</p>}
      {open && data && (
        <div style={{ marginTop: 8 }}>
          {revert.isError && (
            <span className="pill bad" style={{ fontSize: 10 }}>{(revert.error as Error).message}</span>
          )}
          {versions.length <= 1 && (
            <p className="muted" style={{ fontSize: 11 }}>
              Only the current definition so far. Edit and save this role to start building a history worth
              comparing.
            </p>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {versions.map((v, idx) => {
              const score = scoreById.get(v.id);
              const prev = versions[idx + 1];
              // Both changed in the same edit → the score can't tell you which
              // one moved it. Worth saying; not worth preventing.
              const mixedEdit = !!prev && v.system_prompt !== prev.system_prompt && v.model !== prev.model;
              return (
                <div
                  key={v.id}
                  className="row"
                  style={{ justifyContent: "flex-start", gap: 8, flexWrap: "wrap", fontSize: 11 }}
                >
                  <span className={`pill ${v.id === data.current_version_id ? "ok" : "dim"}`} style={{ fontSize: 10 }}>
                    v{v.version_no}
                    {v.id === data.current_version_id ? " · live" : ""}
                  </span>
                  <span className="muted">{new Date(v.created_at).toLocaleString()}</span>
                  {score && score.runs === 0 && <span className="muted">no runs yet</span>}
                  {score && score.runs > 0 && (
                    <>
                      <span
                        className="pill dim"
                        style={{ fontSize: 10 }}
                        title={`${score.runs} run(s) attributed to this version`}
                      >
                        {score.runs} runs
                      </span>
                      <span title="Verdict = pass, over this version's own runs">pass {pct(score.pass_rate)}</span>
                      <span title={`Counter-reviewer sent it back — over the ${score.reviewed_runs} reviewed run(s)`}>
                        loopback {pct(score.loopback_rate)}
                      </span>
                      <span title={`Critique flagged a failing criterion — over the ${score.reviewed_runs} reviewed run(s)`}>
                        flagged {pct(score.critique_flag_rate)}
                      </span>
                      <span title="Task later needed a human restore / change request / wont_do">
                        human {pct(score.human_override_rate)}
                      </span>
                      <span title="Runs whose health was below 'healthy' — passed only via repair or fallback">
                        degraded {pct(score.degraded_rate)}
                      </span>
                      {score.sample_warning && (
                        <span
                          className="pill warn"
                          style={{ fontSize: 10 }}
                          title={`Fewer than ${data.min_runs_for_confidence} runs — this is an underpowered sample, not a verdict on the version`}
                        >
                          low sample
                        </span>
                      )}
                    </>
                  )}
                  {mixedEdit && (
                    <span
                      className="pill warn"
                      style={{ fontSize: 10 }}
                      title="Prompt and model both changed in this edit, so its score can't be attributed to either alone. Change one at a time for a comparable result."
                    >
                      mixed edit
                    </span>
                  )}
                  {v.created_by_note && <span className="muted">{v.created_by_note}</span>}
                  {v.id !== data.current_version_id && (
                    <>
                      <button className="small" onClick={() => setCompareId(compareId === v.id ? null : v.id)}>
                        {compareId === v.id ? "hide diff" : "diff"}
                      </button>
                      <button
                        className="small"
                        disabled={revert.isPending}
                        title="Records a new version matching this one — the versions in between stay in the history"
                        onClick={() => revert.mutate(v.id)}
                      >
                        revert to this
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </div>

          {compare && current && (
            <div style={{ marginTop: 10 }}>
              <label style={{ fontSize: 11 }}>
                v{compare.version_no} → v{current.version_no} (live)
              </label>
              <pre
                style={{
                  fontSize: 11,
                  lineHeight: 1.5,
                  maxHeight: 320,
                  overflow: "auto",
                  background: "var(--bg-color, #1a1a2e)",
                  borderRadius: 6,
                  padding: 8,
                  margin: "4px 0 0",
                }}
              >
                {diffLines(compare.system_prompt ?? "", current.system_prompt ?? "").map((line, i) => (
                  <div key={i} style={{ background: DIFF_COLORS[line.kind].bg, whiteSpace: "pre-wrap" }}>
                    {DIFF_COLORS[line.kind].mark}
                    {line.text}
                  </div>
                ))}
              </pre>
              {(compare.model ?? "") !== (current.model ?? "") && (
                <p className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                  model: <code>{compare.model || "inherit"}</code> → <code>{current.model || "inherit"}</code>
                </p>
              )}
              {(compare.tools_json ?? "") !== (current.tools_json ?? "") && (
                <p className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                  tools: <code>{compare.tools_json || "[]"}</code> → <code>{current.tools_json || "[]"}</code>
                </p>
              )}
            </div>
          )}
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

function fmtUsd(n: number): string {
  return n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;
}

/**
 * Spend ceiling for this project (PLANNING/overhaul-2/01): the caps, the
 * rolling window, and — the part that makes the card worth opening — what has
 * actually been spent against them.
 *
 * The dollar figure is deliberately hedged wherever it's partial. `role_runs`
 * stores one combined token count and only some models carry a configured
 * price, so an unqualified "$12.40" would be a number the data can't back. It
 * renders as "≥ $12.40" with the unpriced remainder named, which is the same
 * honesty posture ExecPolicyCard's warning takes about the worktree.
 */
function BudgetPolicyCard({ projectId }: { projectId: number }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["budget", projectId],
    queryFn: () => api.budget(projectId),
    // Spend moves while you're looking at it; a stale readout next to a live
    // cap is the one thing this card must not show.
    refetchInterval: 15_000,
  });
  const policy = data?.policy;
  const status = data?.status;

  const [periodDays, setPeriodDays] = useState(30);
  const [capTokens, setCapTokens] = useState("");
  const [capUsd, setCapUsd] = useState("");
  const [warnThresholdPct, setWarnThresholdPct] = useState(80);
  const [overrideMinutes, setOverrideMinutes] = useState(60);
  const [adopted, setAdopted] = useState(false);

  useEffect(() => {
    if (!policy || adopted) return;
    setPeriodDays(policy.periodDays);
    setCapTokens(policy.capTokens != null ? String(policy.capTokens) : "");
    setCapUsd(policy.capUsd != null ? String(policy.capUsd) : "");
    setWarnThresholdPct(policy.warnThresholdPct);
    setOverrideMinutes(policy.overrideMinutes);
    setAdopted(true);
  }, [policy, adopted]);

  const save = useMutation({
    mutationFn: (patch: Parameters<typeof api.saveBudget>[1]) => api.saveBudget(projectId, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["budget", projectId] });
      qc.invalidateQueries({ queryKey: ["safety"] });
    },
  });

  if (!policy || !status) return null;

  // Blank means "leave this dimension unbudgeted" — sent as null so the server
  // clears it, rather than omitted (which the merge would read as unchanged).
  const capsPatch = {
    capTokens: capTokens.trim() ? Number(capTokens) : null,
    capUsd: capUsd.trim() ? Number(capUsd) : null,
  };

  const usage = status.usagePct;
  const barPct = usage == null ? 0 : Math.min(100, usage);

  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <div className="row" style={{ justifyContent: "flex-start", gap: 10 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, width: "auto" }}>
          <input
            type="checkbox"
            style={{ width: "auto" }}
            checked={policy.enabled}
            disabled={save.isPending}
            onChange={(e) => save.mutate({ enabled: e.target.checked, ...capsPatch })}
          />
          Enforce a spend ceiling in this project
        </label>
        {policy.enabled && !status.enforced && (
          <span className="pill warn" style={{ fontSize: 10 }}>
            no cap set — nothing is being enforced
          </span>
        )}
        {status.overCap && (
          <span className="pill bad" style={{ fontSize: 10 }}>
            over cap ({status.breached.join(" + ")}) — dispatch stopped
          </span>
        )}
        {save.isError && <span className="pill bad" style={{ fontSize: 10 }}>{(save.error as Error).message}</span>}
      </div>
      <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
        Off by default. When a cap is crossed, the task's current role step still finishes — the ceiling blocks
        the <em>next</em> dispatch and flags the task, which clears itself once spend ages out of the window.
        Resuming past a cap is an explicit per-task action, not an auto-continue.
      </p>

      {status.enforced && (
        <div style={{ marginTop: 8 }}>
          <div
            style={{ height: 6, borderRadius: 3, background: "var(--border, #333)", overflow: "hidden" }}
            title={usage == null ? undefined : `${usage.toFixed(1)}% of the tightest cap`}
          >
            <div
              style={{
                width: `${barPct}%`,
                height: "100%",
                background: status.overCap ? "var(--bad, #c0392b)" : status.warning ? "var(--warn, #d68910)" : "var(--ok, #2e8b57)",
              }}
            />
          </div>
          <div className="row" style={{ justifyContent: "flex-start", gap: 12, marginTop: 6, fontSize: 11 }}>
            <span className="muted">
              last {policy.periodDays}d:{" "}
              <strong>{fmtTokens(status.spend.tokens)}</strong> tokens
              {policy.capTokens != null && <> / {fmtTokens(policy.capTokens)}</>}
            </span>
            <span className="muted">
              {/* "≥" is not decoration: unpriced runs contribute tokens but no
                  dollars, so this figure is a floor whenever it's partial. */}
              {status.spend.usdIsPartial ? "≥ " : ""}
              <strong>{fmtUsd(status.spend.usd)}</strong>
              {policy.capUsd != null && <> / {fmtUsd(policy.capUsd)}</>}
            </span>
            {status.spend.usdIsPartial && (
              <span className="pill dim" style={{ fontSize: 10 }} title="Add $/1M pricing to these models' configs for a complete figure">
                {fmtTokens(status.spend.unpricedTokens)} tokens ran on models with no configured price
              </span>
            )}
          </div>
        </div>
      )}

      <div className="row" style={{ justifyContent: "flex-start", gap: 12, marginTop: 10, flexWrap: "wrap" }}>
        <label style={{ width: "auto", fontSize: 11 }} title="Rolling window spend is summed over">
          window (days)
          <input type="number" style={{ width: 80 }} value={periodDays} onChange={(e) => setPeriodDays(Number(e.target.value))} />
        </label>
        <label style={{ width: "auto", fontSize: 11 }} title="Blank = don't budget tokens. Always enforceable, with or without pricing data.">
          token cap
          <input type="number" style={{ width: 130 }} placeholder="none" value={capTokens} onChange={(e) => setCapTokens(e.target.value)} />
        </label>
        <label style={{ width: "auto", fontSize: 11 }} title="Blank = don't budget dollars. Needs $/1M pricing on the model configs to mean anything.">
          $ cap
          <input type="number" style={{ width: 100 }} placeholder="none" value={capUsd} onChange={(e) => setCapUsd(e.target.value)} />
        </label>
        <label style={{ width: "auto", fontSize: 11 }} title="Percent of a cap at which a non-blocking notice fires">
          warn at (%)
          <input type="number" style={{ width: 80 }} value={warnThresholdPct} onChange={(e) => setWarnThresholdPct(Number(e.target.value))} />
        </label>
        <label style={{ width: "auto", fontSize: 11 }} title="How long a per-task 'resume over budget' override lasts before the ceiling reapplies">
          override lasts (min)
          <input type="number" style={{ width: 90 }} value={overrideMinutes} onChange={(e) => setOverrideMinutes(Number(e.target.value))} />
        </label>
      </div>

      <div style={{ marginTop: 8 }}>
        <button
          className="primary"
          disabled={save.isPending}
          onClick={() => save.mutate({ periodDays, warnThresholdPct, overrideMinutes, ...capsPatch })}
        >
          {save.isPending ? "Saving…" : "Save spend ceiling"}
        </button>
      </div>
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

/** Project default for whether an intake goes through pre-flight review
 *  (PLANNING/intake-refinement.md) — mirrors PlanningRigorCard above exactly.
 *  "off" keeps the board's "Review intake" button as the only way in. */
function IntakeReviewCard({ projectId }: { projectId: number }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["intake-review-config", projectId],
    queryFn: () => api.intakeReviewConfig(projectId),
  });
  const save = useMutation({
    mutationFn: (value: "on" | "off") => api.saveIntakeReviewConfig(projectId, value),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["intake-review-config", projectId] }),
  });

  if (!data) return null;

  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <label style={{ width: "auto", fontSize: 12 }}>
        Review intakes by default
        <select
          value={data.config.default}
          disabled={save.isPending}
          onChange={(e) => save.mutate(e.target.value as "on" | "off")}
          style={{ marginLeft: 8, width: "auto" }}
        >
          <option value="off">off — start immediately; review only when asked (default)</option>
          <option value="on">on — read the repo and propose routing before anything runs</option>
        </select>
      </label>
      {save.isError && (
        <p className="pill bad" style={{ fontSize: 10, marginTop: 6 }}>{(save.error as Error).message}</p>
      )}
      <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
        When on, a new intake (including a file dropped into INTAKE/) runs intake_triage and explorer
        first, then waits while you correct its kind, network, role plan and effort size. Those two
        runs are reused, not repeated. Self-generated watcher work is never held this way.
      </p>
    </div>
  );
}

/**
 * Watcher menu editor, driven by the server's live registry (`GET /api/watchers`)
 * rather than a hardcoded list — a watcher added server-side shows up here with
 * no client change, and one this build doesn't have can never be offered.
 *
 * A project whose config predates a watcher simply has no row for it; the
 * editor renders the catalog entry with the shipped defaults and only writes a
 * config row once the operator touches it. That's why enabling a new watcher
 * always sends the full merged array rather than a partial.
 */
function WatchersListCard({ projectId, allowExec }: { projectId: number; allowExec: boolean }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["autonomy-config", projectId],
    queryFn: () => api.autonomyConfig(projectId),
  });
  const { data: catalogData } = useQuery({ queryKey: ["watcher-catalog"], queryFn: api.watcherCatalog });

  const save = useMutation({
    mutationFn: (patch: Parameters<typeof api.saveAutonomyConfig>[1]) => api.saveAutonomyConfig(projectId, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["autonomy-config", projectId] }),
  });

  if (!data || !catalogData) return null;
  const configured = data.config.watchers;
  const catalog = catalogData.catalog;

  /** The config row for a catalog entry, or the defaults it would get. */
  const rowFor = (name: string): WatcherConfig =>
    configured.find((w) => w.name === name) ?? {
      name,
      enabled: false,
      cadenceMinutes: 1440,
      perWatcherDailyCap: 1,
    };

  const patchWatcher = (name: string, patch: Partial<WatcherConfig>) => {
    const next = catalog.map((entry) => {
      const row = rowFor(entry.name);
      return entry.name === name ? { ...row, ...patch } : row;
    });
    // Anything configured that this build doesn't have in its registry is
    // carried through untouched rather than silently dropped — a config edited
    // against a newer server must survive a round-trip through an older one.
    const unknown = configured.filter((w) => !catalog.some((c) => c.name === w.name));
    save.mutate({ watchers: [...next, ...unknown] });
  };

  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <h3 style={{ margin: "0 0 8px" }}>Watchers</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {catalog.map((entry) => {
          const w = rowFor(entry.name);
          const inert = entry.requiresExec && !allowExec;
          return (
            <div key={entry.name} style={{ border: "1px solid var(--border, #333)", borderRadius: 6, padding: 8 }}>
              <div className="row" style={{ justifyContent: "flex-start", gap: 10, flexWrap: "wrap" }}>
                <label style={{ display: "flex", alignItems: "center", gap: 6, width: "auto" }}>
                  <input
                    type="checkbox"
                    style={{ width: "auto" }}
                    checked={w.enabled}
                    disabled={save.isPending}
                    onChange={(e) => patchWatcher(entry.name, { enabled: e.target.checked })}
                  />
                  <strong>{entry.name}</strong>
                </label>
                {inert && (
                  <span className="pill warn" style={{ fontSize: 10 }} title="This watcher runs project commands, which requires command execution to be enabled with an allowlist above">
                    needs exec
                  </span>
                )}
                <label style={{ width: "auto", fontSize: 11 }} title="Minimum minutes between two runs of this watcher">
                  cadence (minutes)
                  <input
                    type="number"
                    style={{ width: 80 }}
                    value={w.cadenceMinutes}
                    onChange={(e) => patchWatcher(entry.name, { cadenceMinutes: Number(e.target.value) })}
                  />
                </label>
                <label style={{ width: "auto", fontSize: 11 }} title="Max candidates from this watcher that may become tasks per day">
                  daily cap
                  <input
                    type="number"
                    style={{ width: 70 }}
                    value={w.perWatcherDailyCap}
                    onChange={(e) => patchWatcher(entry.name, { perWatcherDailyCap: Number(e.target.value) })}
                  />
                </label>
                {entry.usesThresholdDays && (
                  <label style={{ width: "auto", fontSize: 11 }} title="How old something must be before this watcher proposes it">
                    age threshold (days)
                    <input
                      type="number"
                      style={{ width: 70 }}
                      value={w.thresholdDays ?? 30}
                      onChange={(e) => patchWatcher(entry.name, { thresholdDays: Number(e.target.value) })}
                    />
                  </label>
                )}
              </div>
              <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                {entry.description}
                {inert && " Enabled here, it stays inert until command execution is on with these commands in the allowlist."}
              </p>
            </div>
          );
        })}
      </div>
      {save.isError && (
        <p className="pill bad" style={{ fontSize: 10, marginTop: 8 }}>{(save.error as Error).message}</p>
      )}
      <p className="muted" style={{ fontSize: 11, marginTop: 8 }}>
        All scans are read-only, against a dedicated <code>_scan</code> worktree of the default branch —
        never a task worktree, and never your own checkout. Nothing a watcher finds becomes a task
        without clearing triage and every cap above.
      </p>
    </div>
  );
}

/** Idle-time upkeep of the system itself (PLANNING/overhaul/08 §5): runs in the
 *  same idle window, under the same budgets, as watcher work. */
function SelfMaintenanceCard({ projectId }: { projectId: number }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["autonomy-config", projectId],
    queryFn: () => api.autonomyConfig(projectId),
  });
  const save = useMutation({
    mutationFn: (patch: Parameters<typeof api.saveAutonomyConfig>[1]) => api.saveAutonomyConfig(projectId, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["autonomy-config", projectId] }),
  });
  if (!data) return null;
  const sm = data.config.selfMaintenance;
  const patch = (p: Partial<typeof sm>) => save.mutate({ selfMaintenance: { ...sm, ...p } });

  const toggle = (key: keyof typeof sm, label: string, hint: string) => (
    <label style={{ display: "flex", alignItems: "center", gap: 6, width: "auto" }} title={hint}>
      <input
        type="checkbox"
        style={{ width: "auto" }}
        checked={sm[key]}
        disabled={save.isPending || (key !== "enabled" && !sm.enabled)}
        onChange={(e) => patch({ [key]: e.target.checked } as Partial<typeof sm>)}
      />
      {label}
    </label>
  );

  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <h3 style={{ margin: "0 0 8px" }}>Idle-time self-maintenance</h3>
      <div className="row" style={{ justifyContent: "flex-start", gap: 14, flexWrap: "wrap" }}>
        {toggle("enabled", "Enabled", "Master switch for the system's own upkeep during idle windows")}
        {toggle("reprobeModels", "Probe new models", "Run the capability probe suite against any configured model that has no profile yet")}
        {toggle("backfillDigests", "Backfill run digests", "Generate the short rolling digests that runs missed when the digest call failed")}
      </div>
      <p className="muted" style={{ fontSize: 11, marginTop: 6 }}>
        Housekeeping the companion does for itself between scans — a model added at midnight is probed and
        profiled by morning. Governed by the same kill-switch, schedule and budgets as watcher work; a model
        whose probe fails isn't retried for 24 hours.
      </p>
      {save.isError && <span className="pill bad" style={{ fontSize: 10 }}>{(save.error as Error).message}</span>}
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
      <BudgetPolicyCard projectId={pid} />
      <AutonomyLevelCard projectId={pid} />
      <PlanningRigorCard projectId={pid} />
      <IntakeReviewCard projectId={pid} />
      <AutonomyPolicyCard projectId={pid} />
      <WatchersListCard projectId={pid} allowExec={allowExec} />
      <SelfMaintenanceCard projectId={pid} />
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