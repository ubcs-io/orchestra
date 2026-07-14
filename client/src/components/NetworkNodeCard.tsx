/** Shared React Flow custom node card — used by both NetworkEditor and TaskDetail. */

import { Handle, Position } from "@xyflow/react";

export interface NetworkNodeCardData {
  label: string;
  roleKey: string;
  criteriaCount: number;
  depth?: number;
}

export function NetworkNodeCard({ data }: { data: NetworkNodeCardData }) {
  return (
    <div className="network-node-card">
      <Handle type="target" position={Position.Top} />
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
