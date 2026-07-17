import { useState, useEffect, useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, displayModelName } from "../api";
import type { ModelConfig, ModelStat } from "../api";

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

// ---------------------------------------------------------------------------
// Radar chart — pure SVG, no external dependencies
// ---------------------------------------------------------------------------

const RADAR_AXES = [
  "Context",
  "Max Tokens",
  "Reasoning",
  "Quant Score",
  "Effective\nParams",
  "Params (log)",
] as const;

type RadarAxis = (typeof RADAR_AXES)[number];

function thinkingLevelScore(level: string | null | undefined): number {
  const map: Record<string, number> = {
    minimal: 0.17, low: 0.33, medium: 0.5, high: 0.67, xhigh: 0.83, max: 1.0,
  };
  return map[level ?? "medium"] ?? 0.5;
}

function logScale(v: number | null, max: number): number {
  if (!v || v <= 0 || max <= 0) return 0;
  const logV = Math.log10(v);
  const logMax = Math.log10(max);
  return logMax > 0 ? 0.05 + 0.95 * Math.min(1, logV / logMax) : 0;
}

function linScale(v: number | null, max: number): number {
  if (!v || max <= 0) return 0;
  return 0.05 + 0.95 * Math.min(1, v / max);
}

interface RadarData {
  configId: number;
  name: string;
  color: string;
  values: Record<RadarAxis, number>;
  raw: Record<string, string>;
}

const MODEL_COLORS = [
  "#c9a24b", "#5ba3c9", "#4faa6a", "#cc5b5b", "#d1913c",
  "#b06fce", "#5bc9b0", "#c95b9d", "#7bc95b", "#5b7bc9",
];

function RadarChart({ stats }: { stats: ModelStat[]; configs: ModelConfig[] }) {
  if (stats.length <= 2) return null;

  // Build radar data per stat
  const maxCtx = Math.max(1, ...stats.map((s) => s.context_window ?? 0));
  const maxMaxTok = Math.max(1, ...stats.map((s) => s.max_tokens ?? 0));
  const maxEffective = Math.max(1, ...stats.map((s) => s.effective_params_b ?? s.parameter_count_b ?? 0));
  const maxParams = Math.max(1, ...stats.map((s) => s.total_parameter_count_b ?? s.parameter_count_b ?? 0));

  const radar: RadarData[] = stats.map((s, i) => {
    const color = MODEL_COLORS[i % MODEL_COLORS.length];
    return {
      configId: s.config_id,
      name: s.name,
      color,
      values: {
        "Context": linScale(s.context_window, maxCtx),
        "Max Tokens": linScale(s.max_tokens, maxMaxTok),
        "Reasoning": thinkingLevelScore(s.reasoning ? s.thinking_level : null),
        "Quant Score": s.quantization_score ?? 0.6,
        "Effective\nParams": linScale(s.effective_params_b ?? s.parameter_count_b, maxEffective),
        "Params (log)": logScale(s.total_parameter_count_b ?? s.parameter_count_b, maxParams),
      },
      raw: {
        "Context": ctxLabel(s.context_window, 0),
        "Max Tokens": ctxLabel(s.max_tokens, 0),
        "Reasoning": s.reasoning ? (s.thinking_level ?? "medium") : "none",
        "Quant Score": `${s.quantization ?? "?"} (${(s.quantization_score * 100).toFixed(0)}%)`,
        "Effective\nParams": s.effective_params_b != null ? `${s.effective_params_b}B` : s.parameter_count_b != null ? `${s.parameter_count_b}B` : "?",
        "Params (log)": s.total_parameter_count_b != null ? `${s.total_parameter_count_b}B` : s.parameter_count_b != null ? `${s.parameter_count_b}B` : "?",
      },
    };
  });

  const dims = 400;
  const cx = dims / 2;
  const cy = dims / 2;
  const radius = 160;
  const n = RADAR_AXES.length;
  const toRad = (i: number) => (Math.PI * 2 * i) / n - Math.PI / 2;

  const levels = [0.2, 0.4, 0.6, 0.8, 1.0];

  const [hovered, setHovered] = useState<{ configId: number; axis: string; value: string } | null>(null);
  const [selectedConfigId, setSelectedConfigId] = useState<number | null>(null);
  const [legendHoveredConfigId, setLegendHoveredConfigId] = useState<number | null>(null);

  // Sort so the selected model is drawn last (on top)
  const sortedRadar = useMemo(() => {
    if (selectedConfigId == null) return radar;
    const idx = radar.findIndex((d) => d.configId === selectedConfigId);
    if (idx === -1) return radar;
    const copy = [...radar];
    const [moved] = copy.splice(idx, 1);
    copy.push(moved);
    return copy;
  }, [radar, selectedConfigId]);

  const hasSelection = selectedConfigId != null;

  // Collect all values for the hovered axis across all models, sorted desc
  const axisAllValues = useMemo(() => {
    if (!hovered) return [];
    return radar
      .map((d) => ({ configId: d.configId, name: d.name, color: d.color, value: d.raw[hovered.axis] }))
      .sort((a, b) => {
        const na = parseFloat(a.value);
        const nb = parseFloat(b.value);
        if (!isNaN(na) && !isNaN(nb)) return nb - na;
        return b.value.localeCompare(a.value);
      });
  }, [hovered, radar]);

  // Build all-axis stats for the legend-hovered model
  const legendAllAxes = useMemo(() => {
    if (legendHoveredConfigId == null) return null;
    const d = radar.find((r) => r.configId === legendHoveredConfigId);
    if (!d) return null;
    return {
      configId: d.configId,
      name: d.name,
      color: d.color,
      axes: RADAR_AXES.map((axis) => ({ axis, value: d.raw[axis] })),
    };
  }, [legendHoveredConfigId, radar]);

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <h3 style={{ margin: "0 0 8px", color: "var(--brass)", fontSize: 13, textTransform: "uppercase", letterSpacing: 1 }}>
        Coverage Radar
      </h3>
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        <svg
          width={dims} height={dims} viewBox={`0 0 ${dims} ${dims}`}
          style={{ flexShrink: 0, cursor: hasSelection ? "pointer" : "default" }}
          onClick={() => setSelectedConfigId(null)}
        >
          {/* Invisible background rect to catch deselect clicks */}
          <rect x={0} y={0} width={dims} height={dims} fill="transparent" />
          {/* Background grid */}
          {levels.map((lvl, li) => {
            const pts = RADAR_AXES.map((_, i) => {
              const a = toRad(i);
              return `${cx + radius * lvl * Math.cos(a)},${cy + radius * lvl * Math.sin(a)}`;
            }).join(" ");
            return (
              <polygon
                key={li}
                points={pts}
                fill="none"
                stroke="var(--line)"
                strokeWidth={0.5}
                opacity={0.4}
              />
            );
          })}
          {/* Grid lines from center to each axis */}
          {RADAR_AXES.map((_, i) => {
            const a = toRad(i);
            return (
              <line
                key={i}
                x1={cx} y1={cy}
                x2={cx + radius * Math.cos(a)}
                y2={cy + radius * Math.sin(a)}
                stroke="var(--line)"
                strokeWidth={0.5}
                opacity={0.4}
              />
            );
          })}
          {/* Data polygons — sorted so selected is on top */}
          {sortedRadar.map((d) => {
            const pts = RADAR_AXES.map((axis, i) => {
              const a = toRad(i);
              const r = d.values[axis] * radius;
              return `${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`;
            }).join(" ");
            const isSelected = d.configId === selectedConfigId;
            const isLegendHovered = d.configId === legendHoveredConfigId;
            const dimmed = hasSelection && !isSelected;
            const fillOp = dimmed ? 0.03 : isSelected ? 0.18 : 0.12;
            const strokeOp = dimmed ? 0.18 : 1;
            const strokeW = isLegendHovered ? 3 : isSelected ? 2.5 : 1.5;
            return (
              <g key={d.configId} onClick={(e) => { e.stopPropagation(); setSelectedConfigId(isSelected ? null : d.configId); }}>
                {/* Glow ring when legend-hovered */}
                {isLegendHovered && !dimmed && (
                  <polygon
                    points={pts}
                    fill="none"
                    stroke={d.color}
                    strokeWidth={5.5}
                    strokeOpacity={0.35}
                    style={{ pointerEvents: "none" }}
                  />
                )}
                <polygon
                  points={pts}
                  fill={d.color}
                  fillOpacity={fillOp}
                  stroke={d.color}
                  strokeWidth={strokeW}
                  strokeOpacity={strokeOp}
                  style={{ cursor: "pointer" }}
                />
              </g>
            );
          })}
          {/* Data points + hover zones */}
          {sortedRadar.map((d) =>
            RADAR_AXES.map((axis, i) => {
              const a = toRad(i);
              const r = d.values[axis] * radius;
              const x = cx + r * Math.cos(a);
              const y = cy + r * Math.sin(a);
              const isSelected = d.configId === selectedConfigId;
              const dimmed = hasSelection && !isSelected;
              return (
                <g key={`${d.configId}-${i}`}>
                  <circle
                    cx={x} cy={y} r={4}
                    fill={d.color}
                    stroke="var(--bg)"
                    strokeWidth={1}
                    opacity={dimmed ? 0.25 : 1}
                  />
                  <circle
                    cx={x} cy={y} r={12}
                    fill="transparent"
                    style={{ cursor: "pointer" }}
                    onMouseEnter={() =>
                      setHovered({ configId: d.configId, axis, value: d.raw[axis] })
                    }
                    onMouseLeave={() => setHovered(null)}
                    onClick={(e) => { e.stopPropagation(); setSelectedConfigId(d.configId); }}
                  />
                </g>
              );
            }),
          )}
          {/* Axis labels */}
          {RADAR_AXES.map((axis, i) => {
            const a = toRad(i);
            const labelR = radius + 28;
            const lx = cx + labelR * Math.cos(a);
            const ly = cy + labelR * Math.sin(a);
            const lines = axis.split("\n");
            return (
              <text
                key={axis}
                x={lx} y={ly}
                textAnchor="middle"
                fill="var(--ink-dim)"
                fontSize={10}
                fontFamily="monospace"
              >
                {lines.map((line, j) => (
                  <tspan
                    key={j}
                    x={lx}
                    dy={j === 0 ? (lines.length === 1 ? "0.35em" : "-0.35em") : "1.2em"}
                  >
                    {line}
                  </tspan>
                ))}
              </text>
            );
          })}
        </svg>
        {/* Legend */}
        <div style={{ fontSize: 11 }}>
          {radar.map((d) => (
            <div
              key={d.configId}
              style={{
                display: "flex", alignItems: "center", gap: 6, marginBottom: 3,
                cursor: "pointer",
                opacity: hasSelection && d.configId !== selectedConfigId ? 0.5 : 1,
                transition: "opacity 0.15s",
              }}
              onMouseEnter={() => setLegendHoveredConfigId(d.configId)}
              onMouseLeave={() => setLegendHoveredConfigId(null)}
              onClick={() => setSelectedConfigId(selectedConfigId === d.configId ? null : d.configId)}
            >
              <span style={{
                width: 10, height: 10, borderRadius: "50%",
                background: d.color, display: "inline-block", flexShrink: 0,
                boxShadow: legendHoveredConfigId === d.configId ? `0 0 6px ${d.color}` : undefined,
                transition: "box-shadow 0.15s",
              }} />
              <span style={{
                fontWeight: legendHoveredConfigId === d.configId ? 700 : 400,
                color: legendHoveredConfigId === d.configId ? d.color : undefined,
                transition: "color 0.15s, font-weight 0.15s",
              }}>{d.name}</span>
            </div>
          ))}
          {/* Tooltip — shows all models for the hovered axis, placed below legend so it doesn't bounce */}
          {hovered && (
            <div style={{
              fontSize: 11,
              background: "var(--panel-2)",
              border: "1px solid var(--line)",
              borderRadius: 4,
              padding: "6px 10px",
              marginTop: 8,
              minWidth: 160,
            }}>
              <div style={{ fontWeight: 700, marginBottom: 4, color: "var(--brass)" }}>
                {hovered.axis}
              </div>
              {axisAllValues.map((item) => (
                <div
                  key={item.configId}
                  style={{
                    display: "flex", justifyContent: "space-between", gap: 12,
                    padding: "1px 0",
                    opacity: hasSelection && item.configId !== selectedConfigId ? 0.4 : 1,
                  }}
                >
                  <span style={{ color: item.color, whiteSpace: "nowrap" }}>{item.name}</span>
                  <span style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{item.value}</span>
                </div>
              ))}
            </div>
          )}
          {/* Tooltip — shows all axes for the legend-hovered model */}
          {legendAllAxes && (
            <div style={{
              fontSize: 11,
              background: "var(--panel-2)",
              border: "1px solid var(--line)",
              borderRadius: 4,
              padding: "6px 10px",
              marginTop: 8,
              minWidth: 160,
            }}>
              <div style={{ fontWeight: 700, marginBottom: 4, color: legendAllAxes.color }}>
                {legendAllAxes.name}
              </div>
              {legendAllAxes.axes.map((item) => (
                <div
                  key={item.axis}
                  style={{
                    display: "flex", justifyContent: "space-between", gap: 12,
                    padding: "1px 0",
                  }}
                >
                  <span className="muted" style={{ whiteSpace: "nowrap" }}>{item.axis}</span>
                  <span style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{item.value}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stats comparison table
// ---------------------------------------------------------------------------

type StatSort = { col: string; dir: "asc" | "desc" };

function StatsTable({ stats: rawStats }: { stats: ModelStat[]; configs: ModelConfig[] }) {
  const [sort, setSort] = useState<StatSort>({ col: "name", dir: "asc" });

  const stats = useMemo(() => {
    const sorted = [...rawStats];
    sorted.sort((a, b) => {
      const av = (a as unknown as Record<string, unknown>)[sort.col];
      const bv = (b as unknown as Record<string, unknown>)[sort.col];
      const an = av == null ? "" : String(av);
      const bn = bv == null ? "" : String(bv);
      const na = Number(av);
      const nb = Number(bv);
      const cmp = !isNaN(na) && !isNaN(nb)
        ? na - nb
        : an.localeCompare(bn);
      return sort.dir === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [rawStats, sort]);

  const th = (col: string, label: string) => (
    <th
      style={{ cursor: "pointer", whiteSpace: "nowrap", userSelect: "none" }}
      onClick={() => setSort((prev) => ({
        col,
        dir: prev.col === col ? (prev.dir === "asc" ? "desc" : "asc") : "asc",
      }))}
    >
      {label}
      {sort.col === col ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
    </th>
  );

  return (
    <div className="panel" style={{ marginBottom: 16, overflowX: "auto" }}>
      <h3 style={{ margin: "0 0 8px", color: "var(--brass)", fontSize: 13, textTransform: "uppercase", letterSpacing: 1 }}>
        Model Comparison
      </h3>
      <table className="stats-table">
        <thead>
          <tr>
            {th("name", "Model")}
            {th("active_parameter_count_b", "Active")}
            {th("total_parameter_count_b", "Total")}
            {th("quantization", "Quant")}
            {th("context_window", "Context")}
            {th("max_tokens", "Max Tok")}
            {th("reasoning", "Reasoning")}
            {th("historical_runs", "Runs")}
            {th("historical_avg_tokens_per_run", "Avg Tok/Run")}
            {th("cost_per_1m_input", "$/1M in")}
            {th("cost_per_1m_output", "$/1M out")}
          </tr>
        </thead>
        <tbody>
          {stats.map((s) => (
            <tr key={s.config_id}>
              <td><strong>{s.name}</strong></td>
              <td>{s.active_parameter_count_b != null ? `${s.active_parameter_count_b}B` : s.parameter_count_b != null ? `${s.parameter_count_b}B` : "—"}</td>
              <td>{s.total_parameter_count_b != null ? `${s.total_parameter_count_b}B` : s.parameter_count_b != null ? `${s.parameter_count_b}B` : "—"}</td>
              <td>{s.quantization ?? "—"}</td>
              <td>{ctxLabel(s.context_window, 0)}</td>
              <td>{ctxLabel(s.max_tokens, 0)}</td>
              <td>{s.reasoning ? s.thinking_level ?? "on" : "—"}</td>
              <td>{s.historical_runs}</td>
              <td>{s.historical_avg_tokens_per_run > 0 ? s.historical_avg_tokens_per_run.toLocaleString() : "—"}</td>
              <td>{s.cost_per_1m_input != null ? `$${s.cost_per_1m_input.toFixed(2)}` : "—"}</td>
              <td>{s.cost_per_1m_output != null ? `$${s.cost_per_1m_output.toFixed(2)}` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Models() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["model-configs"],
    queryFn: api.modelConfigs,
  });

  // Fetch model stats for radar chart + comparison table
  const { data: statsData } = useQuery({
    queryKey: ["model-stats"],
    queryFn: () => api.modelStats(),
    staleTime: 30_000,
  });
  const modelStats = statsData?.stats ?? [];

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
          {/* Radar + stats side-by-side when both are visible */}
          <div style={{ display: "flex", gap: 16, alignItems: "flex-start", marginBottom: 16 }}>
            {modelStats.length > 2 && (
              <div style={{ flex: 1, minWidth: 0 }}>
                <RadarChart stats={modelStats} configs={configs} />
              </div>
            )}
            {modelStats.length > 0 && (
              <div style={{ flex: 1, minWidth: 0, maxHeight: 520, overflowY: "auto" }}>
                <StatsTable stats={modelStats} configs={configs} />
              </div>
            )}
          </div>

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
                      <span className={`pill ${cfg.location === "local" ? "ok" : "bad"}`}>
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
  const [twoPhase] = useState(initialData?.two_phase === 1);
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
  const [nudgeThresholdChars, setNudgeThresholdChars] = useState(
    String(compatRaw.nudgeThresholdChars ?? ""),
  );
  const [nudgeThresholdCharsTextMode, setNudgeThresholdCharsTextMode] = useState(
    String(compatRaw.nudgeThresholdCharsTextMode ?? ""),
  );
  const [apiKeyTouched, setApiKeyTouched] = useState(false);
  const [parameterCountB, setParameterCountB] = useState(String(extras.parameter_count_b ?? ""));
  const [quantization, setQuantization] = useState(String(extras.quantization ?? ""));
  const [costPer1mInput, setCostPer1mInput] = useState(String(extras.cost_per_1m_input ?? ""));
  const [costPer1mOutput, setCostPer1mOutput] = useState(String(extras.cost_per_1m_output ?? ""));
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
        chatTemplateKwargs !== "" ||
        nudgeThresholdChars !== "" ||
        nudgeThresholdCharsTextMode !== "",
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
    const initNudgeThresholdChars = String(compatInit.nudgeThresholdChars ?? "");
    const initNudgeThresholdCharsTextMode = String(compatInit.nudgeThresholdCharsTextMode ?? "");

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
      chatTemplateKwargs !== initChatKwargs ||
      nudgeThresholdChars !== initNudgeThresholdChars ||
      nudgeThresholdCharsTextMode !== initNudgeThresholdCharsTextMode,
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
      if (parameterCountB) extra.parameter_count_b = parseFloat(parameterCountB);
      else delete extra.parameter_count_b;
      if (quantization) extra.quantization = quantization;
      else delete extra.quantization;
      if (costPer1mInput) extra.cost_per_1m_input = parseFloat(costPer1mInput);
      else delete extra.cost_per_1m_input;
      if (costPer1mOutput) extra.cost_per_1m_output = parseFloat(costPer1mOutput);
      else delete extra.cost_per_1m_output;
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
      if (nudgeThresholdChars) compat.nudgeThresholdChars = Number(nudgeThresholdChars);
      if (nudgeThresholdCharsTextMode) {
        compat.nudgeThresholdCharsTextMode = Number(nudgeThresholdCharsTextMode);
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
            <strong style={{ fontSize: 13, color: "var(--brass)" }}>Stall / Nudge Thresholds</strong>
            <p className="muted" style={{ fontSize: 11, margin: "4px 0 8px" }}>
              A role's turn is aborted mid-stream once its answer text since the last tool call
              reaches this length, on the assumption it's rambling instead of acting. Low values
              cut off legitimately verbose analysis mid-word. Leave empty to use the defaults
              (8000 chars; 20000 in text mode).
            </p>
          </div>

          <div className="field-grid" style={{ marginTop: 4 }}>
            <div>
              <label>Nudge threshold (chars)</label>
              <input
                value={nudgeThresholdChars}
                onChange={(e) => setNudgeThresholdChars(e.target.value)}
                placeholder="8000"
              />
            </div>
            <div>
              <label>Nudge threshold, text mode (chars)</label>
              <input
                value={nudgeThresholdCharsTextMode}
                onChange={(e) => setNudgeThresholdCharsTextMode(e.target.value)}
                placeholder="20000"
              />
            </div>
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

          <div style={{ marginTop: 16 }}>
            <strong style={{ fontSize: 13, color: "var(--brass)" }}>Model Metadata (for radar & comparison)</strong>
            <p className="muted" style={{ fontSize: 11, margin: "4px 0 8px" }}>
              These values feed the coverage radar chart and comparison table. Leave empty to
              use auto-estimates parsed from the model name. Override when the estimate is wrong.
            </p>
          </div>

          <div className="field-grid" style={{ marginTop: 4 }}>
            <div>
              <label>Parameter count (billions)</label>
              <input
                value={parameterCountB}
                onChange={(e) => setParameterCountB(e.target.value)}
                placeholder={(() => {
                  const s = defaultModel.toLowerCase();
                  const m = s.match(/(\d+\.?\d*)\s*b/i);
                  return m ? `${m[1]} (auto)` : "e.g. 8.0";
                })()}
              />
              <span className="muted" style={{ fontSize: 10 }}>Override auto-estimate</span>
            </div>
            <div>
              <label>Quantization</label>
              <input
                value={quantization}
                onChange={(e) => setQuantization(e.target.value)}
                placeholder={(() => {
                  const s = defaultModel.toLowerCase();
                  const m = s.match(/q(\d+)[_\s]*[kK][_\s]*[mMsS]/i);
                  if (m) return `q${m[1]}_k (auto)`;
                  if (s.includes("fp16") || s.includes("f16")) return "fp16 (auto)";
                  if (s.includes("bf16")) return "bf16 (auto)";
                  return "e.g. q4_k_m";
                })()}
              />
              <span className="muted" style={{ fontSize: 10 }}>Override auto-estimate</span>
            </div>
            <div>
              <label>Cost per 1M input tokens ($)</label>
              <input
                value={costPer1mInput}
                onChange={(e) => setCostPer1mInput(e.target.value)}
                placeholder="e.g. 0.15"
              />
            </div>
            <div>
              <label>Cost per 1M output tokens ($)</label>
              <input
                value={costPer1mOutput}
                onChange={(e) => setCostPer1mOutput(e.target.value)}
                placeholder="e.g. 0.60"
              />
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