import { healthMeta, type RunHealth } from "../api";

/**
 * Run-health badge (PLANNING/overhaul/04 §2). Renders a colored pill with an
 * icon + label and a hover tooltip explaining *why* a run is degraded. A
 * `healthy` run renders nothing (healthMeta.show === false) unless
 * `alwaysShow` is set — a clean run needs no visual noise.
 */
export function HealthBadge({
  health,
  reason,
  alwaysShow = false,
  compact = false,
  style,
}: {
  health: RunHealth | null | undefined;
  reason?: string | null;
  /** Render even for a healthy run (e.g. an explicit "healthy" chip). */
  alwaysShow?: boolean;
  /** Icon only, no text label — for tight rows/timelines. */
  compact?: boolean;
  style?: React.CSSProperties;
}) {
  const meta = healthMeta(health);
  if (!meta.show && !alwaysShow) return null;
  const label = compact ? meta.icon : `${meta.icon} ${meta.label}`;
  return (
    <span
      className={`pill ${meta.cls}`}
      title={reason || meta.label}
      style={{ fontSize: 10, ...style }}
    >
      {label}
    </span>
  );
}
