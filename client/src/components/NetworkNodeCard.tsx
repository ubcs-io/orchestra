/** Shared React Flow custom node card — used by both NetworkEditor and TaskDetail. */

import { Handle, Position } from "@xyflow/react";

export interface NetworkNodeCardData {
  label: string;
  roleKey: string;
  criteriaCount: number;
  depth?: number;
  onPersonClick?: () => void;
}

export function NetworkNodeCard({ data }: { data: NetworkNodeCardData }) {
  return (
    <div className="network-node-card">
      <Handle type="target" position={Position.Top} />
      {data.onPersonClick && (
        <button
          className="network-node-person-btn"
          title="Edit role"
          onClick={(e) => {
            e.stopPropagation();
            data.onPersonClick?.();
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        </button>
      )}
      <div className="network-node-header">
        <span className="network-node-key">{data.roleKey}</span>
        {data.depth && data.depth > 1 ? <span className="pill dim">d{data.depth}</span> : null}
      </div>
      <div className="network-node-body">
        <span className="muted">{data.label}</span>
      </div>
      {data.criteriaCount > 0 && (
        <div className="network-node-footer">
          <span className="pill dim">{data.criteriaCount} criteria</span>
        </div>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
