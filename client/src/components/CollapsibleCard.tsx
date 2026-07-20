import { useState, type ReactNode } from "react";

interface CollapsibleCardProps {
  title: string;
  /** Shown when collapsed — keep it to 2-3 key metrics. */
  summary?: ReactNode;
  /** Always-visible controls next to the title, regardless of collapse state (e.g. action buttons). */
  headerExtra?: ReactNode;
  defaultCollapsed?: boolean;
  className?: string;
  /** Shown when expanded. */
  children: ReactNode;
}

export function CollapsibleCard({
  title,
  summary,
  headerExtra,
  defaultCollapsed = true,
  className,
  children,
}: CollapsibleCardProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  return (
    <div
      className={`panel${collapsed ? " panel--expandable" : ""}${className ? ` ${className}` : ""}`}
      onClick={() => { if (collapsed) setCollapsed(false); }}
    >
      <div
        className="row collapsible"
        onClick={(e) => { e.stopPropagation(); setCollapsed((c) => !c); }}
      >
        <span className="collapse-caret">{collapsed ? "▸" : "▾"}</span>
        <h2 style={{ margin: 0, flex: 1 }}>{title}</h2>
        {headerExtra && <div onClick={(e) => e.stopPropagation()}>{headerExtra}</div>}
      </div>
      {collapsed
        ? summary && <div className="row" style={{ marginTop: 6, gap: 8 }}>{summary}</div>
        : children}
    </div>
  );
}
