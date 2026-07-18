import type { ModelStat } from "../api";

const RADAR_AXES = [
  "Context",
  "Max Tokens",
  "Reasoning",
  "Quant Score",
  "Active\nParams",
  "Params (log)",
] as const;

type RadarAxis = (typeof RADAR_AXES)[number];

const MODEL_COLORS = [
  "#c9a24b", "#5ba3c9", "#4faa6a", "#cc5b5b", "#d1913c",
  "#b06fce", "#5bc9b0", "#c95b9d", "#7bc95b", "#5b7bc9",
];

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
  /** Call count for this model in the current task. */
  calls: number;
}

export interface MiniRadarChartProps {
  stats: ModelStat[];
  modelCallCounts: Record<string, number>;
}

/**
 * Miniature radar chart for the task detail sidebar. Shows a simplified
 * version of the Models page radar, sized for a sidebar panel.
 * Displays call counts next to model names.
 */
export function MiniRadarChart({ stats, modelCallCounts }: MiniRadarChartProps) {
  // Map model names from stats to call counts — stats use config names,
  // orchestrator SSE uses resolved modelId strings. Try both.
  const getCalls = (s: ModelStat): number => {
    if (modelCallCounts[s.name]) return modelCallCounts[s.name];
    if (s.model_id && modelCallCounts[s.model_id]) return modelCallCounts[s.model_id];
    // Also try matching by config_id prefix in case modelCallCounts keys use config ids
    return modelCallCounts[String(s.config_id)] ?? 0;
  };

  if (stats.length === 0) return null;

  const maxCtx = Math.max(1, ...stats.map((s) => s.context_window ?? 0));
  const maxMaxTok = Math.max(1, ...stats.map((s) => s.max_tokens ?? 0));
  const maxActive = Math.max(1, ...stats.map((s) => s.active_parameter_count_b ?? s.parameter_count_b ?? 0));
  const maxParams = Math.max(1, ...stats.map((s) => s.total_parameter_count_b ?? s.parameter_count_b ?? 0));

  const radar: RadarData[] = stats.map((s, i) => ({
    configId: s.config_id,
    name: s.name,
    color: MODEL_COLORS[i % MODEL_COLORS.length],
    values: {
      "Context": linScale(s.context_window, maxCtx),
      "Max Tokens": linScale(s.max_tokens, maxMaxTok),
      "Reasoning": thinkingLevelScore(s.reasoning ? s.thinking_level : null),
      "Quant Score": s.quantization_score ?? 0.6,
      "Active\nParams": linScale(s.active_parameter_count_b ?? s.parameter_count_b, maxActive),
      "Params (log)": logScale(s.total_parameter_count_b ?? s.parameter_count_b, maxParams),
    },
    calls: getCalls(s),
  }))
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 5);

  const dims = 200;
  const cx = dims / 2;
  const cy = dims / 2;
  const radius = 75;
  const n = RADAR_AXES.length;
  const toRad = (i: number) => (Math.PI * 2 * i) / n - Math.PI / 2;
  const levels = radar.length > 1 ? [0.33, 0.66, 1.0] : [0.5, 1.0];

  return (
    <div className="mini-radar">
      <svg
        width={dims} height={dims} viewBox={`0 0 ${dims} ${dims}`}
      >
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
              opacity={0.3}
            />
          );
        })}
        {/* Grid lines from center */}
        {RADAR_AXES.map((_, i) => {
          const a = toRad(i);
          return (
            <line
              key={i}
              x1={cx} y1={cy}
              x2={cx + radius * Math.cos(a)}
              y2={cy + radius * Math.sin(a)}
              stroke="var(--line)"
              strokeWidth={0.3}
              opacity={0.3}
            />
          );
        })}
        {/* Data polygons */}
        {radar.map((d) => {
          const pts = RADAR_AXES.map((axis, i) => {
            const a = toRad(i);
            const r = d.values[axis as RadarAxis] * radius;
            return `${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`;
          }).join(" ");
          const sw = radar.length === 1 ? 2 : 1.5;
          return (
            <polygon
              key={d.configId}
              points={pts}
              fill={d.color}
              fillOpacity={0.15}
              stroke={d.color}
              strokeWidth={sw}
              strokeOpacity={0.8}
            />
          );
        })}
        {/* Axis labels — abbreviated, smaller */}
        {RADAR_AXES.map((axis, i) => {
          const a = toRad(i);
          const labelR = radius + 16;
          const lx = cx + labelR * Math.cos(a);
          const ly = cy + labelR * Math.sin(a);
          const lines = axis.split("\n");
          return (
            <text
              key={axis}
              x={lx} y={ly}
              textAnchor="middle"
              fill="var(--ink-dim)"
              fontSize={8}
              fontFamily="monospace"
              opacity={0.7}
            >
              {lines.map((line, j) => (
                <tspan
                  key={j}
                  x={lx}
                  dy={j === 0 ? (lines.length === 1 ? "0.35em" : "-0.35em") : "1.0em"}
                >
                  {line}
                </tspan>
              ))}
            </text>
          );
        })}
      </svg>
      {/* Model legend with call counts */}
      <div className="mini-radar-legend">
        {radar.map((d) => (
          <div key={d.configId} className="mini-radar-legend-item">
            <span
              className="mini-radar-dot"
              style={{ background: d.color }}
            />
            <span className="mini-radar-name">{d.name}</span>
            {d.calls > 0 && (
              <span className="mini-radar-calls">{d.calls} call{d.calls > 1 ? "s" : ""}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}