import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ConfigResponse, type ConnectionConfig, type SafetyResponse } from "../api";

/**
 * Reasoning dialects (pi `thinkingFormat`), one per model family. Labeled for the
 * dropdown; the value is what the server persists + validates. Qwen + DeepSeek are
 * first since those are the common self-hosted cases.
 */
const THINKING_FORMAT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "qwen-chat-template", label: "Qwen (vLLM / llama.cpp — chat_template_kwargs)" },
  { value: "qwen", label: "Qwen (DashScope — top-level enable_thinking)" },
  { value: "deepseek", label: "DeepSeek-R1 / QwQ (thinking + reasoning_effort)" },
  { value: "zai", label: "GLM / Z.ai" },
  { value: "openai", label: "OpenAI o-series (reasoning_effort)" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "together", label: "Together" },
  { value: "string-thinking", label: "String thinking (advanced)" },
  { value: "chat-template", label: "Generic chat template (advanced)" },
  { value: "ant-ling", label: "Ant Ling (advanced)" },
];

/**
 * Global connection settings. Today there is exactly one profile (the global
 * `default`), rendered as a single card. The page is deliberately laid out as a
 * vertical stack of self-contained cards so per-project / multi-endpoint
 * profiles can be added later as additional cards with no restructuring.
 */
export function Settings() {
  const { data, isLoading } = useQuery({ queryKey: ["config"], queryFn: api.config });

  return (
    <div className="settings">
      <div className="row" style={{ marginBottom: 12 }}>
        <Link to="/">← projects</Link>
        <h2 style={{ margin: 0, color: "var(--brass)" }}>Settings</h2>
      </div>
      <p className="muted">
        The model endpoint every project uses. This is a single global connection for now — per-project
        and per-role overrides will layer on top of it later.
      </p>

      {isLoading || !data ? (
        <p className="muted">Loading…</p>
      ) : (
        <ConnectionCard data={data} />
      )}

      <SafetyDashboard />

      <button className="ghost" disabled title="Multiple connections are coming — the layout is already built for them.">
        + Add connection (coming soon)
      </button>
    </div>
  );
}

function ConnectionCard({ data }: { data: ConfigResponse }) {
  const qc = useQueryClient();
  const cfg: ConnectionConfig = data.config;
  const env = data.env_overrides;

  const [name, setName] = useState(cfg.name ?? "");
  const [baseUrl, setBaseUrl] = useState(cfg.base_url ?? "");
  const [defaultModel, setDefaultModel] = useState(cfg.default_model ?? "");
  const [contextWindow, setContextWindow] = useState(String(cfg.context_window ?? ""));
  const [maxTokens, setMaxTokens] = useState(String(cfg.max_tokens ?? ""));
  const [timeoutMs, setTimeoutMs] = useState(String(cfg.request_timeout_ms ?? ""));
  // reasoning is stored 0/1; null → fall back to the resolved default.
  const [reasoning, setReasoning] = useState(
    cfg.reasoning == null ? data.resolved.reasoning : cfg.reasoning === 1,
  );
  const [thinkingLevel, setThinkingLevel] = useState(cfg.thinking_level ?? data.resolved.thinkingLevel);
  const [thinkingFormat, setThinkingFormat] = useState(
    cfg.thinking_format ?? data.resolved.thinkingFormat,
  );
  const [advanced, setAdvanced] = useState(false);

  // The API key is write-only from the client's view: we know only whether one
  // is set (has_api_key), never its value. Typing sets a new one; blank = keep.
  const [apiKey, setApiKey] = useState("");
  const [apiKeyTouched, setApiKeyTouched] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      api.saveConfig({
        name: name.trim() || undefined,
        base_url: baseUrl.trim() || undefined,
        default_model: defaultModel.trim() || undefined,
        context_window: contextWindow ? Number(contextWindow) : undefined,
        max_tokens: maxTokens ? Number(maxTokens) : undefined,
        request_timeout_ms: timeoutMs ? Number(timeoutMs) : undefined,
        reasoning,
        thinking_level: thinkingLevel,
        thinking_format: thinkingFormat,
        // Only send the key when the user actually typed into the field.
        ...(apiKeyTouched ? { api_key: apiKey } : {}),
      }),
    onSuccess: () => {
      setApiKey("");
      setApiKeyTouched(false);
      qc.invalidateQueries({ queryKey: ["config"] });
    },
  });

  const clearKey = useMutation({
    mutationFn: () => api.saveConfig({ api_key: "" }),
    onSuccess: () => {
      setApiKey("");
      setApiKeyTouched(false);
      qc.invalidateQueries({ queryKey: ["config"] });
    },
  });

  return (
    <div className="panel">
      <div className="row">
        <strong>{cfg.name ?? "Default"}</strong>
        <span className="pill dim">{cfg.key}</span>
        <span className="pill dim">{cfg.api ?? "openai-completions"}</span>
      </div>

      <label>Name</label>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Default" />

      <label>
        Base URL (OpenAI-compatible, ending in /v1 — not /chat/completions)
        {env.base_url && <span className="pill warn" style={{ marginLeft: 8 }}>overridden by env</span>}
      </label>
      <input
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
        placeholder="http://192.168.2.245:8080/v1"
      />

      <label>
        API key {cfg.has_api_key ? <span className="pill ok" style={{ marginLeft: 6 }}>set</span> : <span className="pill dim" style={{ marginLeft: 6 }}>none</span>}
        {env.api_key && <span className="pill warn" style={{ marginLeft: 8 }}>overridden by env</span>}
      </label>
      <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.target.value);
            setApiKeyTouched(true);
          }}
          placeholder={cfg.has_api_key ? "•••••••• (leave blank to keep)" : "(none — leave blank if the endpoint needs no auth)"}
        />
        {cfg.has_api_key && (
          <button className="small" disabled={clearKey.isPending} onClick={() => clearKey.mutate()}>
            Clear
          </button>
        )}
      </div>
      <p className="muted" style={{ fontSize: 11, marginTop: 4 }}>
        Stored in the local SQLite DB. Prefer secrets in the environment? Set <code>ORCHESTRA_API_KEY</code> —
        it overrides the stored value and keeps the key out of the DB.
      </p>

      <label>Default model</label>
      <input value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)} placeholder="llama-serve" />

      <label style={{ marginTop: 10 }}>
        <input
          type="checkbox"
          checked={reasoning}
          onChange={(e) => setReasoning(e.target.checked)}
          style={{ marginRight: 6 }}
        />
        Reasoning model (DeepSeek-R1 / QwQ style)
      </label>
      <p className="muted" style={{ fontSize: 11, margin: "4px 0 0" }}>
        Enable for models that emit chain-of-thought. Off registers the model as a plain instruct model.
        Inline <code>&lt;think&gt;</code> is always separated into the reasoning trace regardless of this setting.
      </p>
      {reasoning && (
        <>
          <label>Thinking level</label>
          <select value={thinkingLevel} onChange={(e) => setThinkingLevel(e.target.value)}>
            {["minimal", "low", "medium", "high", "xhigh", "max"].map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>

          <label>Reasoning dialect (model family)</label>
          <select value={thinkingFormat} onChange={(e) => setThinkingFormat(e.target.value)}>
            {THINKING_FORMAT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <p className="muted" style={{ fontSize: 11, margin: "4px 0 0" }}>
            Shapes how pi requests thinking for this model's family. On Ollama / llama.cpp the endpoint
            may ignore it and emit inline <code>&lt;think&gt;</code> — Orchestra's splitter still routes
            that into the reasoning trace, so output stays clean either way.
          </p>
        </>
      )}

      <button className="small" style={{ marginTop: 10 }} onClick={() => setAdvanced((a) => !a)}>
        {advanced ? "▾" : "▸"} Advanced (context window, max tokens, timeout)
      </button>
      {advanced && (
        <div className="field-grid" style={{ marginTop: 8 }}>
          <div>
            <label>Context window</label>
            <input value={contextWindow} onChange={(e) => setContextWindow(e.target.value)} placeholder="128000" />
          </div>
          <div>
            <label>Max tokens</label>
            <input value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} placeholder="16384" />
          </div>
          <div>
            <label>Request timeout (ms)</label>
            <input value={timeoutMs} onChange={(e) => setTimeoutMs(e.target.value)} placeholder="300000" />
          </div>
        </div>
      )}

      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save connection"}
        </button>
        {save.isError && <span className="pill bad">{(save.error as Error).message}</span>}
        {save.isSuccess && <span className="pill ok">saved</span>}
      </div>

      <ModelDiscovery defaultModel={cfg.default_model} />
    </div>
  );
}

/**
 * Lists the models the *saved* endpoint advertises (GET /api/models →
 * discoverModels). Bounded + scrollable so a large catalog can't blow out the
 * page — the same list will host multiple endpoints' models in the future.
 */
function ModelDiscovery({ defaultModel }: { defaultModel: string | null }) {
  const [checked, setChecked] = useState(false);
  const query = useQuery({
    queryKey: ["discover-models"],
    queryFn: api.models,
    enabled: false,
  });

  const run = () => {
    setChecked(true);
    query.refetch();
  };

  const models = query.data?.models ?? [];

  return (
    <div className="model-discovery">
      <div className="row" style={{ marginTop: 14 }}>
        <strong style={{ fontSize: 13 }}>Available models</strong>
        <button className="small" disabled={query.isFetching} onClick={run}>
          {query.isFetching ? "Checking…" : "Check endpoint"}
        </button>
        {checked && !query.isFetching && (
          <span className="muted" style={{ fontSize: 12 }}>{models.length} found</span>
        )}
      </div>
      <p className="muted" style={{ fontSize: 11, margin: "4px 0 0" }}>
        Reflects the saved connection above — save first if you just changed the URL.
      </p>

      {query.isError && <p className="pill bad" style={{ marginTop: 8 }}>{(query.error as Error).message}</p>}

      {checked && !query.isFetching && !query.isError && (
        models.length === 0 ? (
          <p className="muted" style={{ marginTop: 8 }}>
            No models reported (endpoint unreachable or exposes no <code>/models</code> route).
          </p>
        ) : (
          <div className="model-list">
            {models.map((m) => (
              <div className="model" key={m}>
                <span>{m}</span>
                {m === defaultModel && <span className="pill ok">default</span>}
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pi Dev Safety Dashboard
// ---------------------------------------------------------------------------

const FLOW_LABELS: Record<string, string> = {
  error_file: "Bug / Error",
  bug: "Bug",
  security: "Security",
  feature: "Feature",
  manual: "Manual",
  chore: "Chore",
  spike: "Spike",
  research: "Research",
  ux: "UX",
  question: "Question",
};

function SafetyDashboard() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["safety"],
    queryFn: api.safety,
  });

  if (isLoading) return <p className="muted" style={{ marginTop: 24 }}>Loading safety info…</p>;
  if (isError) return <p className="pill bad" style={{ marginTop: 24 }}>{(error as Error).message}</p>;
  if (!data) return null;

  return (
    <div style={{ marginTop: 32 }}>
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0, color: "var(--brass)" }}>Pi Dev Controls</h2>
        <span className="pill dim">safety dashboard</span>
      </div>
      <p className="muted" style={{ marginBottom: 16 }}>
        What the pi agent harness can and cannot do. These boundaries are enforced by the orchestrator — not
        suggestions.
      </p>

      {/* A: Agent Tool Boundaries */}
      <ToolBoundaries data={data} />

      {/* B: Configurable Limits */}
      <LimitsCard data={data} />

      {/* C: Gate & Review Controls */}
      <GatesCard data={data} />

      {/* D: Role Summary */}
      <RolesSummary data={data} />

      {/* E: Security Posture */}
      <SecurityPosture data={data} />
    </div>
  );
}

function ToolBoundaries({ data }: { data: SafetyResponse }) {
  const items: Array<{ label: string; ok: boolean; detail: string }> = [
    { label: "Read repo files", ok: true, detail: "read, grep, find, ls — scoped to registered repo" },
    { label: "Git history", ok: true, detail: "read-only git log — scoped to registered repo" },
    { label: "Write artifacts", ok: true, detail: data.agent_tools.write_scope },
    { label: "Shell / exec access", ok: false, detail: "no exec, shell, or system tools available to agents" },
    { label: "Source code editing", ok: false, detail: "no write/edit tools — repository code is never modified" },
    { label: "Cross-repo isolation", ok: true, detail: "each session locked to a single project's repoPath" },
  ];

  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <strong style={{ marginBottom: 8, display: "block" }}>Agent Tool Boundaries</strong>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {items.map((it) => (
          <div key={it.label} className="row" style={{ justifyContent: "flex-start", gap: 8, alignItems: "flex-start" }}>
            <span className={`pill ${it.ok ? "ok" : "bad"}`} style={{ minWidth: 24, textAlign: "center" }}>
              {it.ok ? "✓" : "✕"}
            </span>
            <div>
              <strong style={{ fontSize: 13 }}>{it.label}</strong>
              <br />
              <span className="muted" style={{ fontSize: 11 }}>{it.detail}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LimitsCard({ data }: { data: SafetyResponse }) {
  const qc = useQueryClient();
  const [budget, setBudget] = useState(String(data.limits.role_tool_budget));

  const save = useMutation({
    mutationFn: () => api.saveSafety({ role_tool_budget: Number(budget) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["safety"] }),
  });

  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <strong style={{ marginBottom: 8, display: "block" }}>Configurable Limits</strong>

      <div className="field-grid" style={{ marginBottom: 10 }}>
        <div>
          <label>
            Tool calls per role run
            {save.isSuccess && <span className="pill ok" style={{ marginLeft: 6, fontSize: 10 }}>saved</span>}
          </label>
          <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
            <input
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              placeholder="40"
              style={{ width: 80 }}
            />
            <button className="small" disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "…" : "Save"}
            </button>
          </div>
          {save.isError && <span className="pill bad" style={{ fontSize: 10 }}>{(save.error as Error).message}</span>}
        </div>
        <div>
          <label>Request timeout</label>
          <input value={`${data.limits.request_timeout_ms} ms`} disabled style={{ opacity: 0.6 }} />
          <span className="muted" style={{ fontSize: 10 }}>edit in Connection above</span>
        </div>
        <div>
          <label>Max tokens per response</label>
          <input value={String(data.limits.max_tokens)} disabled style={{ opacity: 0.6 }} />
          <span className="muted" style={{ fontSize: 10 }}>edit in Connection above</span>
        </div>
        <div>
          <label>Context window</label>
          <input value={String(data.limits.context_window)} disabled style={{ opacity: 0.6 }} />
          <span className="muted" style={{ fontSize: 10 }}>edit in Connection above</span>
        </div>
      </div>
    </div>
  );
}

function GatesCard({ data }: { data: SafetyResponse }) {
  const entries = Object.entries(data.gates);
  if (!entries.length) return null;

  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <strong style={{ marginBottom: 8, display: "block" }}>Gate & Review Controls</strong>
      <p className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
        Counter-reviewers verify prior role output against acceptance criteria. Unmet "must" criteria trigger
        loop-backs (bounded). After exhaustion, tasks escalate to human REVIEW.
      </p>

      <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border-color, #333)" }}>
            <th style={{ padding: "4px 8px" }}>Flow</th>
            <th style={{ padding: "4px 8px" }}>Reviewer</th>
            <th style={{ padding: "4px 8px" }}>Rigor</th>
            <th style={{ padding: "4px 8px" }}>Max loop-backs</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([k, g]) => (
            <tr key={k} style={{ borderBottom: "1px solid var(--border-color, #222)" }}>
              <td style={{ padding: "4px 8px" }}>{FLOW_LABELS[k] ?? k}</td>
              <td style={{ padding: "4px 8px" }}>
                <span className="pill dim">{g.reviewerRole}</span>
              </td>
              <td style={{ padding: "4px 8px" }}>
                <span className={`pill ${g.rigor === "high" ? "warn" : g.rigor === "low" ? "dim" : "ok"}`}>
                  {g.rigor}
                </span>
              </td>
              <td style={{ padding: "4px 8px", textAlign: "center" }}>{g.maxLoopbacks}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RolesSummary({ data }: { data: SafetyResponse }) {
  const s = data.roles_summary;
  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <strong style={{ marginBottom: 8, display: "block" }}>Role Summary</strong>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        <SummaryBadge label="Total roles" value={s.total_roles} />
        <SummaryBadge label="Read-only (read/grep/find/ls)" value={s.read_only_count} />
        <SummaryBadge label="Git history access" value={s.git_history_count} />
        <SummaryBadge label="Context-only (no tools)" value={s.context_only_count} />
        {s.disabled_count > 0 && <SummaryBadge label="Disabled" value={s.disabled_count} tone="warn" />}
      </div>
      <p className="muted" style={{ fontSize: 11, marginTop: 8 }}>
        Edit per-role tools in the <strong>Roles Editor</strong> inside each project.
      </p>
    </div>
  );
}

function SummaryBadge({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div style={{
      background: "var(--bg-color, #1a1a2e)",
      borderRadius: 8,
      padding: "8px 14px",
      textAlign: "center",
      minWidth: 100,
    }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: tone === "warn" ? "var(--warn, #f0a040)" : "var(--brass)" }}>
        {value}
      </div>
      <div className="muted" style={{ fontSize: 10 }}>{label}</div>
    </div>
  );
}

function SecurityPosture({ data }: { data: SafetyResponse }) {
  const s = data.server;
  const st = data.storage;

  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <strong style={{ marginBottom: 8, display: "block" }}>Security Posture</strong>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
        <div className="row" style={{ justifyContent: "flex-start", gap: 8 }}>
          <span className="muted" style={{ minWidth: 100 }}>Server</span>
          <code>{s.bind_address}:{s.port}</code>
        </div>
        <div className="row" style={{ justifyContent: "flex-start", gap: 8 }}>
          <span className="muted" style={{ minWidth: 100 }}>Auth</span>
          <span className="pill bad" style={{ fontSize: 10 }}>none</span>
          <span className="muted" style={{ fontSize: 11 }}>{s.trust_boundary}</span>
        </div>
        <div className="row" style={{ justifyContent: "flex-start", gap: 8 }}>
          <span className="muted" style={{ minWidth: 100 }}>API Key</span>
          <span className={`pill ${st.api_key_in_env ? "ok" : st.api_key_in_db ? "warn" : "dim"}`} style={{ fontSize: 10 }}>
            {st.api_key_in_env ? "in env" : st.api_key_in_db ? "in DB" : "not set"}
          </span>
          {st.api_key_in_db && !st.api_key_in_env && (
            <span className="muted" style={{ fontSize: 10 }}>
              stored in <code>{st.db_path}</code> — use ORCHESTRA_API_KEY env to keep it out of the DB
            </span>
          )}
        </div>
        <div className="row" style={{ justifyContent: "flex-start", gap: 8 }}>
          <span className="muted" style={{ minWidth: 100 }}>DB</span>
          <code style={{ fontSize: 11 }}>{st.db_path}</code>
        </div>
      </div>
    </div>
  );
}
