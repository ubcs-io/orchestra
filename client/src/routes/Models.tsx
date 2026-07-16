import { useState, useEffect } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, displayModelName } from "../api";
import type { ModelConfig } from "../api";

const THINKING_FORMAT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "qwen-chat-template", label: "Qwen (vLLM / llama.cpp)" },
  { value: "qwen", label: "Qwen (DashScope)" },
  { value: "deepseek", label: "DeepSeek-R1 / QwQ" },
  { value: "zai", label: "GLM / Z.ai" },
  { value: "openai", label: "OpenAI o-series" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "together", label: "Together" },
  { value: "string-thinking", label: "String thinking" },
  { value: "chat-template", label: "Chat template" },
  { value: "ant-ling", label: "Ant Ling" },
];

function ctxLabel(n: number | null | undefined, def: number): string {
  const v = n ?? def;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${Math.round(v / 1_000)}K`;
  return String(v);
}

function familyLabel(cfg: ModelConfig): string {
  if (cfg.thinking_format) return cfg.thinking_format;
  if (cfg.api === "openai-completions") return "OpenAI compat";
  return cfg.api ?? "unknown";
}

/** Parse temperature / top_p / reasoning_effort from extra_json. */
function parseExtras(extra: string | null): Record<string, unknown> {
  if (!extra) return {};
  try { return JSON.parse(extra) as Record<string, unknown>; }
  catch { return {}; }
}

function isDefault(cfg: ModelConfig): boolean {
  return cfg.project_id === null && cfg.key === "default";
}

export function Models() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["model-configs"],
    queryFn: api.modelConfigs,
  });

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [pendingSwitchId, setPendingSwitchId] = useState<number | null>(null);
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);

  const configs = data?.configs ?? [];
  const isEmpty = configs.length === 0 && !showNewForm;
  const effectiveShowNew = showNewForm || isEmpty;

  const selectedConfig = selectedId ? configs.find((c) => c.id === selectedId) : undefined;

  const duplicate = useMutation({
    mutationFn: (id: number) => api.duplicateModelConfig(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["model-configs"] }),
  });

  const setDefault = useMutation({
    mutationFn: (id: number) => api.setDefaultModelConfig(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["model-configs"] }),
  });

  const reorder = useMutation({
    mutationFn: (ids: number[]) => api.reorderModelConfigs(ids),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["model-configs"] }),
  });

  // Discard unsaved changes and switch to the pending config
  const handleDiscardAndSwitch = () => {
    const targetId = pendingSwitchId;
    setPendingSwitchId(null);
    setDirty(false);
    if (targetId !== null) {
      setEditingId(targetId);
      setSelectedId(targetId);
      setShowNewForm(false);
    }
  };

  const handleCardClick = (id: number) => {
    if (editingId === id) {
      // Toggle: close the current editor
      setEditingId(null);
      setSelectedId(null);
      setDirty(false);
    } else {
      // If editor is dirty, ask before switching
      if (dirty) {
        setPendingSwitchId(id);
        return;
      }
      setEditingId(id);
      setSelectedId(id);
      setShowNewForm(false);
      setDirty(false);
    }
  };

  // ---- Drag-and-drop handlers ----
  const handleDragStart = (e: React.DragEvent, id: number) => {
    setDraggedId(id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(id));
  };

  const handleDragOver = (e: React.DragEvent, id: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (id !== draggedId) {
      setDragOverId(id);
    }
  };

  const handleDragLeave = () => {
    setDragOverId(null);
  };

  const handleDrop = (e: React.DragEvent, targetId: number) => {
    e.preventDefault();
    setDragOverId(null);
    setDraggedId(null);

    if (draggedId == null || draggedId === targetId) return;

    const newConfigs = [...configs];
    const dragIdx = newConfigs.findIndex((c) => c.id === draggedId);
    const dropIdx = newConfigs.findIndex((c) => c.id === targetId);
    if (dragIdx === -1 || dropIdx === -1) return;

    // Move the dragged item to the target position
    const [moved] = newConfigs.splice(dragIdx, 1);
    newConfigs.splice(dropIdx, 0, moved);

    reorder.mutate(newConfigs.map((c) => c.id));
  };

  const handleDragEnd = () => {
    setDraggedId(null);
    setDragOverId(null);
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 12 }}>
        <Link to="/">← projects</Link>
        <h2 style={{ margin: 0, color: "var(--brass)" }}>Models</h2>
        {data?.has_tokens_env && (
          <span className="pill warn">ORCHESTRA_TOKENS env set</span>
        )}
      </div>
      <p className="muted">
        Named model configurations. Each card stores endpoint + model settings. API keys can be
        stored in the DB or injected via <code>ORCHESTRA_TOKENS</code> env var using the config name
        as the key.
      </p>

      {isLoading ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <div className="model-card-grid">
            {configs.map((cfg) => {
              const def = isDefault(cfg);
              return (
                <div
                  key={cfg.id}
                  className={`model-card${selectedId === cfg.id ? " selected" : ""}${draggedId === cfg.id ? " dragging" : ""}${dragOverId === cfg.id ? " drag-over" : ""}`}
                  draggable
                  onClick={() => handleCardClick(cfg.id)}
                  onDragStart={(e) => handleDragStart(e, cfg.id)}
                  onDragOver={(e) => handleDragOver(e, cfg.id)}
                  onDragLeave={handleDragLeave}
                  onDrop={(e) => handleDrop(e, cfg.id)}
                  onDragEnd={handleDragEnd}
                >
                  <div className="model-card-header">
                    <span className="model-card-name">
                      {cfg.name ?? "Unnamed"}
                      {def && <span className="pill ok" style={{ marginLeft: 6, fontSize: 10 }}>default</span>}
                    </span>
                    <span
                      className="model-card-delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (def) return;
                        setDeletingId(cfg.id);
                      }}
                      title={def ? "Cannot delete the default config" : "Delete"}
                      style={def ? { opacity: 0.3, cursor: "not-allowed" } : undefined}
                    >
                      ×
                    </span>
                  </div>
                  <div className="model-card-body">
                    <div className="model-card-field">
                      <span className="muted">Model</span>
                      <span>{cfg.default_model ? displayModelName(cfg.default_model) : "—"}</span>
                    </div>
                    <div className="model-card-field">
                      <span className="muted">Size</span>
                      <span>{ctxLabel(cfg.context_window, 0)}</span>
                    </div>
                    <div className="model-card-field">
                      <span className="muted">Family</span>
                      <span>{familyLabel(cfg)}</span>
                    </div>
                    <div className="model-card-field">
                      <span className="muted">Type</span>
                      <span className={`pill ${cfg.location === "local" ? "dim" : "ok"}`}>
                        {cfg.location ?? "unknown"}
                      </span>
                    </div>
                    <div className="model-card-field">
                      <span className="muted">Token</span>
                      <span className={`pill ${cfg.has_env_token ? "ok" : cfg.has_api_key ? "warn" : "dim"}`}>
                        {cfg.has_env_token ? "env" : cfg.has_api_key ? "DB" : "none"}
                      </span>
                    </div>
                    {!def && (
                      <button
                        className="small"
                        style={{ marginTop: 4, fontSize: 10 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setDefault.mutate(cfg.id);
                        }}
                        disabled={setDefault.isPending}
                        title="Promote to default model config"
                      >
                        {setDefault.isPending && setDefault.variables === cfg.id ? "…" : "Set as default"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}

            {selectedConfig ? (
              <div className="model-card empty-split">
                <button
                  className="model-split-btn"
                  onClick={() => {
                    setEditingId(null);
                    setShowNewForm(true);
                  }}
                >
                  <span className="model-split-icon">+</span>
                  <span>Add new</span>
                </button>
                <button
                  className="model-split-btn"
                  onClick={() => duplicate.mutate(selectedConfig.id)}
                  disabled={duplicate.isPending}
                >
                  <span className="model-split-icon">⧉</span>
                  <span>Duplicate "{selectedConfig.name}"</span>
                </button>
              </div>
            ) : (
              <div
                className="model-card empty"
                onClick={() => {
                  setEditingId(null);
                  setShowNewForm(true);
                }}
              >
                <span className="model-plus">+</span>
              </div>
            )}
          </div>

          {(effectiveShowNew || editingId != null) && (
            <ModelEditor
              key={editingId}
              configId={editingId}
              initialData={editingId ? (configs.find((c) => c.id === editingId) ?? null) : null}
              onDirtyChange={setDirty}
              onDone={() => {
                setEditingId(null);
                setShowNewForm(false);
                setDirty(false);
              }}
            />
          )}
        </>
      )}

      <DeleteModal
        configId={deletingId}
        configName={deletingId ? (configs.find((c) => c.id === deletingId)?.name ?? null) : null}
        onClose={() => setDeletingId(null)}
      />

      <DiscardChangesModal
        configName={pendingSwitchId ? (configs.find((c) => c.id === pendingSwitchId)?.name ?? null) : null}
        onStay={() => setPendingSwitchId(null)}
        onDiscard={handleDiscardAndSwitch}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Full-size editor card
// ---------------------------------------------------------------------------

function ModelEditor({
  configId,
  initialData,
  onDone,
  onDirtyChange,
}: {
  configId: number | null;
  initialData: ModelConfig | null;
  onDone: () => void;
  onDirtyChange: (d: boolean) => void;
}) {
  const qc = useQueryClient();
  const isNew = configId == null;

  const [name, setName] = useState(initialData?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(initialData?.base_url ?? "");
  const [defaultModel, setDefaultModel] = useState(initialData?.default_model ?? "");
  const [contextWindow, setContextWindow] = useState(String(initialData?.context_window ?? ""));
  const [maxTokens, setMaxTokens] = useState(String(initialData?.max_tokens ?? ""));
  const [timeoutMs, setTimeoutMs] = useState(String(initialData?.request_timeout_ms ?? ""));
  const [reasoning, setReasoning] = useState(initialData?.reasoning === 1);
  const [thinkingLevel, setThinkingLevel] = useState(initialData?.thinking_level ?? "medium");
  const [thinkingFormat, setThinkingFormat] = useState(initialData?.thinking_format ?? "qwen-chat-template");
  const extras = parseExtras(initialData?.extra_json ?? null);
  const compatRaw = parseExtras(initialData?.compat_json ?? null);
  const budgetsRaw = parseExtras(initialData?.thinking_budgets ?? null);
  const [thinkingBudgetMinimal, setThinkingBudgetMinimal] = useState(String(budgetsRaw.minimal ?? ""));
  const [thinkingBudgetLow, setThinkingBudgetLow] = useState(String(budgetsRaw.low ?? ""));
  const [thinkingBudgetMedium, setThinkingBudgetMedium] = useState(String(budgetsRaw.medium ?? ""));
  const [thinkingBudgetHigh, setThinkingBudgetHigh] = useState(String(budgetsRaw.high ?? ""));
  const [textMode, setTextMode] = useState(initialData?.text_mode === 1);
  const [twoPhase, setTwoPhase] = useState(initialData?.two_phase === 1);
  const [temperature, setTemperature] = useState(String(extras.temperature ?? ""));
  const [topP, setTopP] = useState(String(extras.top_p ?? ""));
  const [reasoningEffort, setReasoningEffort] = useState(String(extras.reasoning_effort ?? ""));
  const [apiKey, setApiKey] = useState("");
  // Tier-1 compat options
  const [supportsDeveloperRole, setSupportsDeveloperRole] = useState<boolean | undefined>(
    compatRaw.supportsDeveloperRole as boolean | undefined,
  );
  const [supportsReasoningEffort, setSupportsReasoningEffort] = useState<boolean | undefined>(
    compatRaw.supportsReasoningEffort as boolean | undefined,
  );
  const [maxTokensField, setMaxTokensField] = useState<string>(
    (compatRaw.maxTokensField as string) ?? "",
  );
  const [chatTemplateKwargs, setChatTemplateKwargs] = useState(
    compatRaw.chatTemplateKwargs ? JSON.stringify(compatRaw.chatTemplateKwargs, null, 2) : "",
  );
  const [apiKeyTouched, setApiKeyTouched] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);

  // Report dirty state to parent
  useEffect(() => {
    if (isNew) {
      onDirtyChange(
        name.trim() !== "" ||
        baseUrl.trim() !== "" ||
        defaultModel.trim() !== "" ||
        contextWindow !== "" ||
        maxTokens !== "" ||
        timeoutMs !== "" ||
        reasoning !== false ||
        thinkingLevel !== "medium" ||
        thinkingFormat !== "qwen-chat-template" ||
        textMode !== false ||
        twoPhase !== false ||
        temperature !== "" ||
        topP !== "" ||
        reasoningEffort !== "" ||
        apiKeyTouched ||
        supportsDeveloperRole !== undefined ||
        supportsReasoningEffort !== undefined ||
        maxTokensField !== "" ||
        chatTemplateKwargs !== "",
      );
      return;
    }

    // Editing existing — compare to initial values
    const extrasInit = parseExtras(initialData?.extra_json ?? null);
    const compatInit = parseExtras(initialData?.compat_json ?? null);

    const initName = initialData?.name ?? "";
    const initBaseUrl = initialData?.base_url ?? "";
    const initDefaultModel = initialData?.default_model ?? "";
    const initContextWindow = String(initialData?.context_window ?? "");
    const initMaxTokens = String(initialData?.max_tokens ?? "");
    const initTimeoutMs = String(initialData?.request_timeout_ms ?? "");
    const initReasoning = initialData?.reasoning === 1;
    const initThinkingLevel = initialData?.thinking_level ?? "medium";
    const initThinkingFormat = initialData?.thinking_format ?? "qwen-chat-template";
    const initTextMode = initialData?.text_mode === 1;
    const initTwoPhase = initialData?.two_phase === 1;
    const initTemperature = String(extrasInit.temperature ?? "");
    const initTopP = String(extrasInit.top_p ?? "");
    const initReasoningEffort = String(extrasInit.reasoning_effort ?? "");
    const initSupportsDevRole = compatInit.supportsDeveloperRole as boolean | undefined;
    const initSupportsReasoning = compatInit.supportsReasoningEffort as boolean | undefined;
    const initMaxTokensField = (compatInit.maxTokensField as string) ?? "";
    const initChatKwargs = compatInit.chatTemplateKwargs
      ? JSON.stringify(compatInit.chatTemplateKwargs, null, 2)
      : "";

    onDirtyChange(
      name !== initName ||
      baseUrl !== initBaseUrl ||
      defaultModel !== initDefaultModel ||
      contextWindow !== initContextWindow ||
      maxTokens !== initMaxTokens ||
      timeoutMs !== initTimeoutMs ||
      reasoning !== initReasoning ||
      thinkingLevel !== initThinkingLevel ||
      thinkingFormat !== initThinkingFormat ||
      textMode !== initTextMode ||
      twoPhase !== initTwoPhase ||
      temperature !== initTemperature ||
      topP !== initTopP ||
      reasoningEffort !== initReasoningEffort ||
      apiKeyTouched ||
      supportsDeveloperRole !== initSupportsDevRole ||
      supportsReasoningEffort !== initSupportsReasoning ||
      maxTokensField !== initMaxTokensField ||
      chatTemplateKwargs !== initChatKwargs,
    );
  });

  const title = isNew ? "New Model Config" : `Edit: ${initialData?.name ?? "Unnamed"}`;

  const handleDiscover = async () => {
    if (!baseUrl.trim()) {
      setDiscoverError("Enter a base URL first");
      return;
    }
    setIsDiscovering(true);
    setDiscoverError(null);
    try {
      const key = apiKeyTouched ? apiKey : undefined;
      const result = await api.discoverModels(baseUrl.trim(), key);
      setDiscoveredModels(result.models);
      if (result.models.length === 0) setDiscoverError("No models found at this endpoint");
    } catch (err) {
      setDiscoverError((err as Error).message);
    } finally {
      setIsDiscovering(false);
    }
  };

  const save = useMutation({
    mutationFn: () => {
      // Pack pi customization settings into extra_json
      const extra: Record<string, unknown> = { ...extras };
      if (temperature) extra.temperature = parseFloat(temperature);
      else delete extra.temperature;
      if (topP) extra.top_p = parseFloat(topP);
      else delete extra.top_p;
      if (reasoningEffort) extra.reasoning_effort = reasoningEffort;
      else delete extra.reasoning_effort;
      const extraJson = Object.keys(extra).length > 0 ? JSON.stringify(extra) : undefined;

      // Build compat_json from tier-1 fields
      const compat: Record<string, unknown> = {};
      if (supportsDeveloperRole !== undefined) compat.supportsDeveloperRole = supportsDeveloperRole;
      if (supportsReasoningEffort !== undefined) compat.supportsReasoningEffort = supportsReasoningEffort;
      if (maxTokensField) compat.maxTokensField = maxTokensField;
      if (chatTemplateKwargs.trim()) {
        try {
          compat.chatTemplateKwargs = JSON.parse(chatTemplateKwargs);
        } catch {
          /* invalid JSON — will be silently ignored */
        }
      }
      const compatJson = Object.keys(compat).length > 0 ? JSON.stringify(compat) : undefined;

      // Build thinking_budgets JSON string
      const budgets: Record<string, number> = {};
      if (thinkingBudgetMinimal) budgets.minimal = Number(thinkingBudgetMinimal);
      if (thinkingBudgetLow) budgets.low = Number(thinkingBudgetLow);
      if (thinkingBudgetMedium) budgets.medium = Number(thinkingBudgetMedium);
      if (thinkingBudgetHigh) budgets.high = Number(thinkingBudgetHigh);
      const thinkingBudgetsJson = Object.keys(budgets).length > 0 ? JSON.stringify(budgets) : undefined;

      const body: Record<string, unknown> = {
        name: name.trim(),
        base_url: baseUrl.trim() || undefined,
        default_model: defaultModel.trim() || undefined,
        context_window: contextWindow ? Number(contextWindow) : undefined,
        max_tokens: maxTokens ? Number(maxTokens) : undefined,
        request_timeout_ms: timeoutMs ? Number(timeoutMs) : undefined,
        reasoning,
        thinking_level: thinkingLevel,
        thinking_format: thinkingFormat,
        text_mode: textMode,
        two_phase: twoPhase,
        ...(extraJson !== undefined ? { extra_json: extraJson } : {}),
        ...(compatJson !== undefined ? { compat_json: compatJson } : {}),
        ...(thinkingBudgetsJson !== undefined ? { thinking_budgets: thinkingBudgetsJson } : {}),
        ...(apiKeyTouched ? { api_key: apiKey } : {}),
      };
      if (isNew) return api.createModelConfig(body as Parameters<typeof api.createModelConfig>[0]);
      return api.updateModelConfig(configId!, body as Parameters<typeof api.updateModelConfig>[1]);
    },
    onSuccess: () => {
      setApiKey("");
      setApiKeyTouched(false);
      qc.invalidateQueries({ queryKey: ["model-configs"] });
      if (isNew) onDone();
    },
  });

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div className="row">
        <strong>{title}</strong>
        {isNew && <span className="pill dim">new</span>}
      </div>

      <label>Name (unique)</label>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. qwen-7b-local" />

      <label>Base URL (OpenAI-compatible, ending in /v1)</label>
      <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://192.168.2.245:8080/v1" />

      <div className="row" style={{ gap: 12, flexWrap: "nowrap", alignItems: "flex-start" }}>
        <div style={{ flex: 2 }}>
          <label>Default model</label>
          <input value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)} placeholder="llama-serve" />
        </div>
        <div style={{ flex: 1 }}>
          <label>
            API key{" "}
            {initialData?.has_api_key && <span className="pill ok" style={{ marginLeft: 6 }}>set</span>}
            {!initialData?.has_api_key && <span className="pill dim" style={{ marginLeft: 6 }}>none</span>}
            {initialData?.has_env_token && <span className="pill ok" style={{ marginLeft: 6 }}>env</span>}
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => { setApiKey(e.target.value); setApiKeyTouched(true); }}
            placeholder={initialData?.has_api_key ? "•••••••• (leave blank to keep)" : initialData?.has_env_token ? "overridden by ORCHESTRA_TOKENS env" : "(none)"}
            disabled={!!initialData?.has_env_token}
          />
        </div>
      </div>

      <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8 }}>
        <button
          className="small"
          onClick={handleDiscover}
          disabled={isDiscovering || !baseUrl.trim()}
        >
          {isDiscovering ? "Fetching…" : "Get models"}
        </button>
        {discoverError && (
          <span className="pill bad" style={{ fontSize: 11 }}>
            {discoverError}
          </span>
        )}
      </div>

      {discoveredModels.length > 0 && (
        <div
          style={{
            marginTop: 6,
            padding: "6px 8px",
            background: "var(--bg-depth)",
            borderRadius: 6,
            maxHeight: 160,
            overflowY: "auto",
            display: "flex",
            flexWrap: "wrap",
            gap: 4,
          }}
        >
          {discoveredModels.map((modelId) => (
            <button
              key={modelId}
              className="small"
              style={{
                fontSize: 10,
                padding: "2px 8px",
                background: defaultModel === modelId ? "var(--brass)" : "var(--bg-hover)",
                color: defaultModel === modelId ? "var(--bg-base)" : "inherit",
              }}
              onClick={() => setDefaultModel(modelId)}
              title={`Click to use "${modelId}"`}
            >
              {modelId}
            </button>
          ))}
        </div>
      )}

      <label style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 6 }}>
        <input type="checkbox" checked={reasoning} onChange={(e) => setReasoning(e.target.checked)} style={{ width: "auto", margin: 0 }} />
        Reasoning model
      </label>
      <p className="muted" style={{ fontSize: 11, margin: "4px 0 0" }}>
        Enable for models that emit chain-of-thought. Off registers the model as a plain instruct model.
        Inline <code>{`<think>`}</code> is always separated into the reasoning trace regardless of this setting.
      </p>
      {reasoning && (
        <>
          <div className="row" style={{ gap: 12, flexWrap: "nowrap", alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
              <label>Thinking level</label>
              <select value={thinkingLevel} onChange={(e) => setThinkingLevel(e.target.value)}>
                {["minimal", "low", "medium", "high", "xhigh", "max"].map((l) => (
                  <option key={l} value={l}>{l}</option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label>Reasoning dialect</label>
              <select value={thinkingFormat} onChange={(e) => setThinkingFormat(e.target.value)}>
                {THINKING_FORMAT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>
          <p className="muted" style={{ fontSize: 11, margin: "4px 0 0" }}>
            Shapes how pi requests thinking for this model's family. On Ollama / llama.cpp the endpoint
            may ignore it and emit inline <code>{`<think>`}</code> — Orchestra's splitter still routes
            that into the reasoning trace, so output stays clean either way.
          </p>
        </>
      )}

      <label style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 6 }}>
        <input type="checkbox" checked={textMode} onChange={(e) => setTextMode(e.target.checked)} style={{ width: "auto", margin: 0 }} />
        Text mode — no native function calling
      </label>
      <p className="muted" style={{ fontSize: 11, margin: "4px 0 0" }}>
        When enabled, the model outputs findings as a JSON code block in plain text instead of using{" "}
        <code>record_findings</code> as a function call. Use this for models whose function-calling is
        unreliable (e.g. small MoE models, heavy quantization, or older llama.cpp builds).
      </p>

      <button className="small" style={{ marginTop: 10 }} onClick={() => setAdvanced((a) => !a)}>
        {advanced ? "▾" : "▸"} Advanced
      </button>
      {advanced && (
        <>
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

          <div style={{ marginTop: 16 }}>
            <strong style={{ fontSize: 13, color: "var(--brass)" }}>Endpoint Compatibility</strong>
            <p className="muted" style={{ fontSize: 11, margin: "4px 0 8px" }}>
              Fine-tune how pi talks to this OpenAI-compatible endpoint. These flags are critical for
              self-hosted models (Ollama, vLLM, SGLang) that may reject or mishandle certain fields.
            </p>
          </div>

          <div className="field-grid" style={{ marginTop: 4 }}>
            <div>
              <label>Developer role</label>
              <select
                value={supportsDeveloperRole === undefined ? "" : supportsDeveloperRole ? "true" : "false"}
                onChange={(e) => {
                  const v = e.target.value;
                  setSupportsDeveloperRole(v === "" ? undefined : v === "true");
                }}
              >
                <option value="">(auto)</option>
                <option value="true">Yes — use developer role</option>
                <option value="false">No — use system role</option>
              </select>
              <span className="muted" style={{ fontSize: 10 }}>
                Set "No" for Ollama / vLLM / SGLang that reject the developer role
              </span>
            </div>
            <div>
              <label>Reasoning effort support</label>
              <select
                value={supportsReasoningEffort === undefined ? "" : supportsReasoningEffort ? "true" : "false"}
                onChange={(e) => {
                  const v = e.target.value;
                  setSupportsReasoningEffort(v === "" ? undefined : v === "true");
                }}
              >
                <option value="">(auto)</option>
                <option value="true">Yes — supports reasoning_effort</option>
                <option value="false">No — omit reasoning_effort</option>
              </select>
              <span className="muted" style={{ fontSize: 10 }}>
                Set "No" for local endpoints that don't understand reasoning_effort
              </span>
            </div>
            <div>
              <label>Max tokens field</label>
              <select
                value={maxTokensField}
                onChange={(e) => setMaxTokensField(e.target.value)}
              >
                <option value="">(auto)</option>
                <option value="max_completion_tokens">max_completion_tokens</option>
                <option value="max_tokens">max_tokens (legacy)</option>
              </select>
              <span className="muted" style={{ fontSize: 10 }}>
                Force a specific field name for max output tokens
              </span>
            </div>
          </div>

          <div style={{ marginTop: 10 }}>
            <label>Chat-template kwargs (JSON)</label>
            <textarea
              value={chatTemplateKwargs}
              onChange={(e) => setChatTemplateKwargs(e.target.value)}
              placeholder='{ "thinking": { "$var": "thinking.enabled" } }'
              rows={3}
              style={{ fontFamily: "monospace", fontSize: 11, resize: "vertical" }}
            />
            <span className="muted" style={{ fontSize: 10 }}>
              Used with thinkingFormat "chat-template" — e.g. for DeepSeek V3.x on vLLM. Leave empty to omit.
            </span>
          </div>

          <div style={{ marginTop: 16 }}>
            <strong style={{ fontSize: 13, color: "var(--brass)" }}>Thinking Token Budgets</strong>
            <p className="muted" style={{ fontSize: 11, margin: "4px 0 8px" }}>
              Per-thinking-level caps for reasoning tokens. Providers that support token-based thinking
              limits (e.g. hosted Anthropic/OpenAI) use these to constrain the chain-of-thought budget
              separately from the max output tokens. Leave empty to use provider defaults.
            </p>
          </div>

          <div className="field-grid" style={{ marginTop: 4 }}>
            <div>
              <label>Minimal</label>
              <input value={thinkingBudgetMinimal} onChange={(e) => setThinkingBudgetMinimal(e.target.value)} placeholder="1024" />
            </div>
            <div>
              <label>Low</label>
              <input value={thinkingBudgetLow} onChange={(e) => setThinkingBudgetLow(e.target.value)} placeholder="4096" />
            </div>
            <div>
              <label>Medium</label>
              <input value={thinkingBudgetMedium} onChange={(e) => setThinkingBudgetMedium(e.target.value)} placeholder="8192" />
            </div>
            <div>
              <label>High</label>
              <input value={thinkingBudgetHigh} onChange={(e) => setThinkingBudgetHigh(e.target.value)} placeholder="16384" />
            </div>
          </div>

          <div className="field-grid" style={{ marginTop: 10 }}>
            <div>
              <label>Temperature (0–2)</label>
              <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                <input
                  type="range"
                  min="0" max="2" step="0.1"
                  value={temperature || "0.7"}
                  onChange={(e) => setTemperature(e.target.value)}
                  style={{ flex: 1, height: 6, accentColor: "var(--brass)", padding: 0, margin: "6px 0" }}
                />
                <span style={{ fontVariantNumeric: "tabular-nums", minWidth: 36, textAlign: "right", fontSize: 12 }}>
                  {temperature || "0.7"}
                </span>
              </div>
            </div>
            <div>
              <label>Top-p (0–1)</label>
              <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                <input
                  type="range"
                  min="0" max="1" step="0.05"
                  value={topP || "0.95"}
                  onChange={(e) => setTopP(e.target.value)}
                  style={{ flex: 1, height: 6, accentColor: "var(--brass)", padding: 0, margin: "6px 0" }}
                />
                <span style={{ fontVariantNumeric: "tabular-nums", minWidth: 36, textAlign: "right", fontSize: 12 }}>
                  {topP || "0.95"}
                </span>
              </div>
            </div>
            <div>
              <label>Reasoning effort</label>
              <select value={reasoningEffort || ""} onChange={(e) => setReasoningEffort(e.target.value)}>
                <option value="">(none)</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
              <span className="muted" style={{ fontSize: 10 }}>
                OpenAI o-series only; ignored for other dialects
              </span>
            </div>
          </div>
        </>
      )}

      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : isNew ? "Create config" : "Save changes"}
        </button>
        <button onClick={onDone}>Cancel</button>
        {save.isError && <span className="pill bad">{(save.error as Error).message}</span>}
        {save.isSuccess && <span className="pill ok">saved</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Discard changes confirmation modal
// ---------------------------------------------------------------------------

function DiscardChangesModal({
  configName,
  onStay,
  onDiscard,
}: {
  configName: string | null;
  onStay: () => void;
  onDiscard: () => void;
}) {
  if (configName == null) return null;

  return (
    <div className="modal-overlay" onClick={onStay}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Unsaved Changes</h3>
        <p className="muted">
          You have unsaved changes. Discard them and switch to <strong>{configName ?? "Unnamed"}</strong>?
        </p>
        <div className="modal-actions">
          <button onClick={onStay}>Stay</button>
          <button className="warn" onClick={onDiscard}>
            Discard & Switch
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Delete confirmation modal
// ---------------------------------------------------------------------------

function DeleteModal({
  configId,
  configName,
  onClose,
}: {
  configId: number | null;
  configName: string | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  if (configId == null) return null;

  const del = useMutation({
    mutationFn: () => api.deleteModelConfig(configId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["model-configs"] }); onClose(); },
  });

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Delete model config?</h3>
        <p className="muted">Permanently remove <strong>{configName ?? "Unnamed"}</strong>.</p>
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="danger" disabled={del.isPending} onClick={() => del.mutate()}>
            {del.isPending ? "Deleting…" : "Delete"}
          </button>
        </div>
        {del.isError && <div className="pill bad" style={{ marginTop: 8 }}>{(del.error as Error).message}</div>}
      </div>
    </div>
  );
}