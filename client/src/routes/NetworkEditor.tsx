import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Panel,
  useNodesState,
  useEdgesState,
  addEdge,
  Connection,
  BackgroundVariant,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api, type AgentNetworkGraph } from "../api";
import { NetworkNodeCard } from "../components/NetworkNodeCard";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GRID = 20;

function snap(v: number): number {
  return Math.round(v / GRID) * GRID;
}

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Custom React Flow node types
// ---------------------------------------------------------------------------

const nodeTypes = { networkNode: NetworkNodeCard };

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function NetworkEditor() {
  const { networkId } = useParams({ strict: false }) as { networkId?: string };
  const navigate = useNavigate();
  const qc = useQueryClient();
  const isEditing = !!networkId;

  // --- Data queries ---
  const networksQ = useQuery({ queryKey: ["networks"], queryFn: () => api.networks() });
  const networkQ = useQuery({
    queryKey: ["network", networkId],
    queryFn: () => api.network(networkId!),
    enabled: isEditing,
  });
  const rolesQ = useQuery({ queryKey: ["allRoles"], queryFn: () => api.allRoles() });

  // --- Parse current graph ---
  const currentNetwork = networkQ.data?.network ?? null;
  const parsedGraph = useMemo<AgentNetworkGraph | null>(() => {
    if (!currentNetwork?.graph_json) return null;
    try {
      return JSON.parse(currentNetwork.graph_json) as AgentNetworkGraph;
    } catch {
      return null;
    }
  }, [currentNetwork]);

  // --- React Flow state ---
  const initialNodes: Node[] = useMemo(() => {
    if (!parsedGraph?.nodes) return [];
    return parsedGraph.nodes.map((n) => ({
      id: n.id,
      type: "networkNode",
      position: { x: n.position.x, y: n.position.y },
      data: {
        label: rolesQ.data?.roles.find((r) => r.key === n.roleKey)?.title ?? n.roleKey,
        roleKey: n.roleKey,
        criteriaCount: n.criteria?.length ?? 0,
        depth: n.overrides?.depth,
      },
    }));
  }, [parsedGraph, rolesQ.data]);

  const initialEdges: Edge[] = useMemo(() => {
    if (!parsedGraph?.edges) return [];
    return parsedGraph.edges.map((e) => ({
      id: e.id,
      source: e.sourceNodeId,
      target: e.targetNodeId,
      label: e.label,
      type: "smoothstep",
      animated: !!e.condition,
    }));
  }, [parsedGraph]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // --- UI state ---
  const [name, setName] = useState("New Network");
  const [description, setDescription] = useState("");
  const [intakeKind, setIntakeKind] = useState("manual");
  const [rigor, setRigor] = useState<"low" | "standard" | "high">("standard");
  const [maxLoopbacks, setMaxLoopbacks] = useState(2);
  const [snapToGrid, setSnapToGrid] = useState(true);

  // Selection state — driven by React Flow's onSelectionChange for full
  // multi-select support (nodes + edges, Shift+Click).
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<string[]>([]);

  // Sync React Flow nodes/edges whenever the parsed graph or roles data changes
  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  // Sync metadata fields whenever the current network changes (handles navigation between networks)
  const prevNetworkId = useRef<string | undefined>();
  useEffect(() => {
    if (!currentNetwork) return;
    // Only reinitialize if the network ID actually changed
    if (prevNetworkId.current === currentNetwork.network_id) return;
    prevNetworkId.current = currentNetwork.network_id;
    setName(currentNetwork.name);
    setDescription(currentNetwork.description);
    setIntakeKind(currentNetwork.intake_kind ?? "manual");
    if (parsedGraph) {
      setRigor(parsedGraph.metadata?.rigor ?? "standard");
      setMaxLoopbacks(parsedGraph.metadata?.maxLoopbacks ?? 2);
      setSnapToGrid(parsedGraph.layout?.snapToGrid ?? true);
    }
  }, [currentNetwork, parsedGraph]);

  // Auto-navigate to most recent custom network (or bug flow) when landing on /networks
  useEffect(() => {
    if (networkId) return;
    if (!networksQ.data) return;

    const customNetworks = networksQ.data.networks
      .filter((n) => !n.is_system)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));

    if (customNetworks.length > 0) {
      navigate({ to: "/networks/$networkId", params: { networkId: customNetworks[0].network_id }, replace: true });
    } else {
      const bugFlow = networksQ.data.networks.find((n) => n.is_system && n.intake_kind === "bug");
      if (bugFlow) {
        navigate({ to: "/networks/$networkId", params: { networkId: bugFlow.network_id }, replace: true });
      }
    }
  }, [networkId, networksQ.data, navigate]);

  // --- Selection handler (native React Flow multi-select) ---
  const onSelectionChange = useCallback(
    ({ nodes: selNodes, edges: selEdges }: { nodes: Node[]; edges: Edge[] }) => {
      setSelectedNodeIds(selNodes.map((n) => n.id));
      setSelectedEdgeIds(selEdges.map((e) => e.id));
    },
    [],
  );

  // --- Connect handler ---
  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) =>
        addEdge(
          {
            ...connection,
            id: `e-${generateId()}`,
            type: "smoothstep",
          },
          eds,
        ),
      );
    },
    [setEdges],
  );

  // --- Connect two currently-selected nodes ---
  const connectSelected = useCallback(() => {
    if (selectedNodeIds.length !== 2) return;
    const [source, target] = selectedNodeIds;
    if (!source || !target) return;
    setEdges((eds) =>
      addEdge(
        {
          id: `e-${generateId()}`,
          source,
          target,
          type: "smoothstep",
        },
        eds,
      ),
    );
  }, [selectedNodeIds, setEdges]);

  // Keyboard shortcut: E connects two selected nodes
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ignore if focus is in an input / textarea / select
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (e.key === "e" && selectedNodeIds.length === 2) {
        e.preventDefault();
        connectSelected();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedNodeIds, connectSelected]);

  // --- Drop handler for adding nodes from sidebar ---
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const roleKey = e.dataTransfer.getData("application/orchestra-role");
      if (!roleKey) return;

      const position = { x: snap(e.clientX - 300), y: snap(e.clientY - 150) };

      const newNode: Node = {
        id: `n-${generateId()}`,
        type: "networkNode",
        position,
        data: {
          label: rolesQ.data?.roles.find((r) => r.key === roleKey)?.title ?? roleKey,
          roleKey,
          criteriaCount: 0,
        },
      };

      setNodes((nds) => [...nds, newNode]);
    },
    [setNodes, rolesQ.data],
  );

  // --- Delete selected elements ---
  const deleteSelected = useCallback(() => {
    if (selectedEdgeIds.length > 0) {
      setEdges((eds) => eds.filter((e) => !selectedEdgeIds.includes(e.id)));
    }
    if (selectedNodeIds.length > 0) {
      setNodes((nds) => nds.filter((n) => !selectedNodeIds.includes(n.id)));
      // Also remove any edges incident to deleted nodes
      setEdges((eds) =>
        eds.filter(
          (e) => !selectedNodeIds.includes(e.source) && !selectedNodeIds.includes(e.target),
        ),
      );
    }
  }, [selectedNodeIds, selectedEdgeIds, setNodes, setEdges]);

  // --- Build graph JSON for save ---
  const buildGraphJson = useCallback((): string => {
    const graph: AgentNetworkGraph = {
      version: 1,
      nodes: nodes.map((n) => {
        const existingNode = parsedGraph?.nodes?.find((pn) => pn.id === n.id);
        return {
          id: n.id,
          roleKey: n.data.roleKey as string,
          position: {
            x: snapToGrid ? snap(n.position.x) : n.position.x,
            y: snapToGrid ? snap(n.position.y) : n.position.y,
          },
          overrides: existingNode?.overrides,
          criteria: existingNode?.criteria,
        };
      }),
      edges: edges.map((e) => {
        const existingEdge = parsedGraph?.edges?.find((pe) => pe.id === e.id);
        // Preserve stored condition if available, otherwise default to "always"
        const condition = existingEdge?.condition ?? { type: "always" as const };
        return {
          id: e.id,
          sourceNodeId: e.source,
          targetNodeId: e.target,
          label: (e.label as string) || undefined,
          condition,
        };
      }),
      layout: { gridSize: GRID, snapToGrid },
      metadata: {
        rigor,
        maxLoopbacks,
        mandatoryConcerns: parsedGraph?.metadata?.mandatoryConcerns ?? [],
        reviewerRole: parsedGraph?.metadata?.reviewerRole,
      },
    };
    return JSON.stringify(graph);
  }, [nodes, edges, snapToGrid, rigor, maxLoopbacks, parsedGraph]);

  // --- Save mutation ---
  const saveMutation = useMutation({
    mutationFn: async () => {
      const graphJson = buildGraphJson();
      if (isEditing && networkId) {
        return api.updateNetwork(networkId, {
          name,
          description,
          intake_kind: intakeKind,
          graph_json: graphJson,
        });
      }
      return api.createNetwork({
        name,
        description,
        intake_kind: intakeKind,
        graph_json: graphJson,
      });
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["networks"] });
      if (!isEditing && res.network) {
        navigate({ to: "/networks/$networkId", params: { networkId: res.network.network_id } });
      }
    },
  });

  // --- Delete mutation ---
  const deleteMutation = useMutation({
    mutationFn: () => api.deleteNetwork(networkId!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["networks"] });
      navigate({ to: "/networks" });
    },
  });

  // --- Duplicate mutation ---
  const duplicateMutation = useMutation({
    mutationFn: () => api.duplicateNetwork(networkId!),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["networks"] });
      navigate({ to: "/networks/$networkId", params: { networkId: res.network.network_id } });
    },
  });

  // --- Export ---
  const handleExport = async () => {
    if (!networkId) return;
    const data = await api.exportNetwork(networkId);
    const blob = new Blob([JSON.stringify(data.export, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${currentNetwork?.name ?? "network"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // --- Loading states ---
  if (isEditing && networkQ.isLoading) return <p className="muted">Loading network…</p>;
  if (isEditing && networkQ.isError) return <p className="pill bad">Network not found.</p>;

  const isSystem = currentNetwork?.is_system === 1;
  const isReadOnly = isSystem;
  const hasSelection = selectedNodeIds.length > 0 || selectedEdgeIds.length > 0;

  return (
    <div className="network-editor-layout">
      {/* Left Sidebar — Network List */}
      <aside className="network-left-sidebar">
        <div className="network-sidebar-section">
          <h3>My Networks</h3>
          {networksQ.data?.networks
            .filter((n) => !n.is_system)
            .map((n) => (
              <Link
                key={n.network_id}
                to="/networks/$networkId"
                params={{ networkId: n.network_id }}
                className={`network-list-item ${n.network_id === networkId ? "active" : ""}`}
              >
                <span>{n.name}</span>
                {n.is_default === 1 && <span className="pill ok">default</span>}
              </Link>
            ))}
          {isEditing && (
            <button
              className="small"
              style={{ marginTop: 8, width: "100%" }}
              onClick={() => duplicateMutation.mutate()}
            >
              + Duplicate
            </button>
          )}
          <button
            className="small primary"
            style={{ marginTop: 8, width: "100%" }}
            onClick={() => navigate({ to: "/networks" })}
          >
            + New Network
          </button>
        </div>

        <div className="network-sidebar-section">
          <h3>Built-in Templates</h3>
          {networksQ.data?.networks
            .filter((n) => n.is_system)
            .map((n) => (
              <Link
                key={n.network_id}
                to="/networks/$networkId"
                params={{ networkId: n.network_id }}
                className={`network-list-item ${n.network_id === networkId ? "active" : ""}`}
              >
                <span>{n.name}</span>
                <span className="muted">{n.intake_kind}</span>
              </Link>
            ))}
        </div>

        {isEditing && !isSystem && (
          <div className="network-sidebar-actions">
            <button className="small danger" onClick={() => deleteMutation.mutate()}>
              Delete
            </button>
          </div>
        )}
      </aside>

      {/* Center — Canvas */}
      <main className="network-canvas-container">
        {/* Top bar with metadata */}
        <div className="network-topbar">
          <input
            className="network-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Network Name"
            disabled={isReadOnly}
          />
          <div className="row">
            <select value={intakeKind} onChange={(e) => setIntakeKind(e.target.value)} disabled={isReadOnly}>
              <option value="manual">Manual</option>
              <option value="bug">Bug</option>
              <option value="error_file">Error File</option>
              <option value="security">Security</option>
              <option value="feature">Feature</option>
              <option value="chore">Chore</option>
              <option value="spike">Spike</option>
              <option value="research">Research</option>
              <option value="ux">UX</option>
              <option value="question">Question</option>
            </select>
            <select value={rigor} onChange={(e) => setRigor(e.target.value as "low" | "standard" | "high")} disabled={isReadOnly}>
              <option value="low">Low Rigor</option>
              <option value="standard">Standard</option>
              <option value="high">High Rigor</option>
            </select>
            <label className="muted">
              Max Loopbacks:
              <input
                type="number"
                min={0}
                max={5}
                value={maxLoopbacks}
                onChange={(e) => setMaxLoopbacks(Number(e.target.value))}
                style={{ width: 50, marginLeft: 4 }}
                disabled={isReadOnly}
              />
            </label>
            <div className="row">
              {!isReadOnly && (
                <button
                  className="small primary"
                  disabled={saveMutation.isPending}
                  onClick={() => saveMutation.mutate()}
                >
                  {saveMutation.isPending ? "Saving…" : "Save"}
                </button>
              )}
              {isEditing && (
                <button className="small" onClick={handleExport}>
                  Export JSON
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Hint bar */}
        <div className="network-hint-bar">
          <span className="muted">
            Drag from handle to connect · Shift+Click to multi-select · Click edge to select · E to connect two selected · Del to remove
          </span>
        </div>

        {/* React Flow Canvas */}
        <div className="network-flow-wrapper" onDragOver={onDragOver} onDrop={onDrop}>
          <ReactFlow
            key={networkId ?? "new"}
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onSelectionChange={onSelectionChange}
            nodeTypes={nodeTypes}
            fitView
            snapToGrid={snapToGrid}
            snapGrid={[GRID, GRID]}
            deleteKeyCode={["Backspace", "Delete"]}
            multiSelectionKeyCode="Shift"
            selectionKeyCode="Shift"
          >
            <Background variant={BackgroundVariant.Dots} gap={GRID} size={1} />
            <Controls />
            <MiniMap nodeColor={(n) => (n.selected ? "var(--brass)" : "var(--bg3)")} />
            <Panel position="top-right">
              <div className="network-canvas-toolbar">
                {!isReadOnly && selectedEdgeIds.length === 1 && (
                  <button className="small" onClick={deleteSelected}>
                    Delete Edge
                  </button>
                )}
                {!isReadOnly && selectedNodeIds.length === 1 && (
                  <button className="small" onClick={deleteSelected}>
                    Delete Node
                  </button>
                )}
                {!isReadOnly && selectedNodeIds.length === 2 && (
                  <button className="small" onClick={connectSelected}>
                    Connect Nodes
                  </button>
                )}
                {!isReadOnly && hasSelection && (selectedNodeIds.length > 2 || (selectedNodeIds.length > 0 && selectedEdgeIds.length > 0)) && (
                  <button className="small" onClick={deleteSelected}>
                    Delete Selected ({selectedNodeIds.length + selectedEdgeIds.length})
                  </button>
                )}
                {isEditing && isSystem && (
                  <span className="muted" style={{ fontSize: 12 }}>
                    Read-only (duplicate to edit)
                  </span>
                )}
              </div>
            </Panel>
          </ReactFlow>
        </div>

        {/* Bottom bar */}
        <div className="network-bottombar">
          <label className="row">
            <input
              type="checkbox"
              checked={snapToGrid}
              onChange={(e) => setSnapToGrid(e.target.checked)}
            />
            Snap to Grid ({GRID}px)
          </label>
        </div>
      </main>

      {/* Right Sidebar — Role Palette */}
      <aside className="network-right-sidebar">
        <h3>Roles</h3>
        <div className="network-role-list">
          {rolesQ.data?.roles
            .filter((r) => r.enabled !== 0)
            .map((role) => (
              <div
                key={role.key}
                className="network-role-card"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("application/orchestra-role", role.key);
                  e.dataTransfer.effectAllowed = "move";
                }}
                title={role.system_prompt?.slice(0, 100) ?? ""}
              >
                <div className="network-role-card-header">
                  <span className="network-role-key">{role.key}</span>
                </div>
                <span className="muted">{role.title}</span>
                {role.can_create_subtasks === 1 && <span className="pill dim">terminal</span>}
              </div>
            ))}
        </div>
      </aside>
    </div>
  );
}
