import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ConfigResponse, type ConnectionConfig } from "../api";

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
            <input value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} placeholder="8192" />
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
