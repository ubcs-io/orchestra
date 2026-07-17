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
import { api, type AgentNetworkGraph, type NetworkEdge, type ModelConfig } from "../api";
import { NetworkNodeCard } from "../components/NetworkNodeCard";
import { ModelPicker } from "./RolesEditor";

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
// Role Edit Modal (extracted to manage its own form state)
// ---------------------------------------------------------------------------

function ProjectSelectModal({
  projects,
  onSelect,
  onCancel,
}: {
  projects: Array<{ id: number; name: string }>;
  onSelect: (projectId: number | null) => void;
  onCancel: () => void;
}) {
  const [selectedId, setSelectedId] = useState<number | null>(null);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        <h3>Select Project</h3>
        <p className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
          Associate this template with a project, or leave unselected for a global template.
        </p>
        <select
          value={selectedId ?? ""}
          onChange={(e) => setSelectedId(e.target.value ? Number(e.target.value) : null)}
          style={{ marginBottom: 12 }}
        >
          <option value="">(Global — no project)</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="modal-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={() => onSelect(selectedId)}>
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

function RoleEditModal({
  role,
  projectId,
  modelConfigs,
  defaultModelConfigName,
  onSave,
  onCancel,
  isSaving,
}: {
  role: {
    key: string;
    title: string | null;
    enabled: number;
    system_prompt: string | null;
    tools_json: string | null;
    model: string | null;
    can_create_subtasks: number;
  };
  projectId: number | null;
  modelConfigs: ModelConfig[];
  defaultModelConfigName: string;
  onSave: (body: {
    enabled: number;
    can_create_subtasks: number;
    system_prompt: string;
    tools_json: string;
    model?: string;
  }) => void;
  onCancel: () => void;
  isSaving: boolean;
}) {
  const [prompt, setPrompt] = useState(role.system_prompt ?? "");
  const [tools, setTools] = useState(() => {
    try {
      return (JSON.parse(role.tools_json ?? "[]") as string[]).join(", ");
    } catch {
      return "";
    }
  });
  const [model, setModel] = useState(role.model ?? "");
  const [enabled, setEnabled] = useState(role.enabled === 1);
  const [canCreateSubtasks, setCanCreateSubtasks] = useState(role.can_create_subtasks === 1);

  const handleSave = () => {
    onSave({
      enabled: enabled ? 1 : 0,
      can_create_subtasks: canCreateSubtasks ? 1 : 0,
      system_prompt: prompt,
      tools_json: JSON.stringify(
        tools
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
      model: model || undefined,
    });
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
        <h3>
          Edit Role — {role.title ?? role.key}
        </h3>
        <span className="pill dim" style={{ marginBottom: 12, display: "inline-block" }}>
          {role.key}
        </span>
        {projectId != null && (
          <span className="pill ok" style={{ marginLeft: 6, marginBottom: 12 }}>
            project override
          </span>
        )}

        <label>
          <input
            type="checkbox"
            style={{ width: "auto", marginRight: 6 }}
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />{" "}
          enabled
        </label>

        <label>
          <input
            type="checkbox"
            style={{ width: "auto", marginRight: 6 }}
            checked={canCreateSubtasks}
            onChange={(e) => setCanCreateSubtasks(e.target.checked)}
          />{" "}
          Can Create Subtasks
        </label>

        <label>Tools (comma-separated pi built-ins: read, grep, find, ls)</label>
        <input value={tools} onChange={(e) => setTools(e.target.value)} />

        <label>Model override (optional)</label>
        <ModelPicker
          value={model}
          onChange={setModel}
          configs={modelConfigs}
          defaultConfigName={defaultModelConfigName}
        />

        <label>System prompt</label>
        <textarea
          style={{ minHeight: 180 }}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />

        <p className="muted" style={{ fontSize: 11, fontStyle: "italic", marginTop: 10 }}>
          Changes are applied globally to all networks that use this role.
        </p>

        <div className="modal-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" disabled={isSaving} onClick={handleSave}>
            {isSaving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

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
  const projectsQ = useQuery({ queryKey: ["projects"], queryFn: () => api.projects() });
  const modelConfigsQ = useQuery({ queryKey: ["model-configs"], queryFn: api.modelConfigs });
  const modelConfigs = modelConfigsQ.data?.configs ?? [];
  const defaultModelConfigName =
    modelConfigs.find((c) => c.project_id === null && c.key === "default")?.name ?? "(none)";

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

  // Helper: navigate to the role config page if project is set, otherwise open inline modal
  const handleRoleClick = useCallback(
    (roleKey: string) => {
      if (currentNetwork?.project_id != null) {
        navigate({
          to: "/projects/$projectId/roles",
          params: { projectId: String(currentNetwork.project_id) },
          search: { role: roleKey },
        });
      } else {
        setRoleModalKey(roleKey);
      }
    },
    [currentNetwork, navigate],
  );

  // --- UI & modal state (must come before initialNodes which references setRoleModalKey) ---
  const [name, setName] = useState("New Network");
  const [description, setDescription] = useState("");
  const [intakeKind, setIntakeKind] = useState("manual");
  const [rigor, setRigor] = useState<"low" | "standard" | "high">("standard");
  const [maxLoopbacks, setMaxLoopbacks] = useState(2);
  const [reviewDepth, setReviewDepth] = useState<"none" | "terminal_only" | "every_step">("terminal_only");
  const [snapToGrid, setSnapToGrid] = useState(true);

  // Selection state — driven by React Flow's onSelectionChange for full
  // multi-select support (nodes + edges, Shift+Click).
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<string[]>([]);

  // Role editing modal state
  const [roleModalKey, setRoleModalKey] = useState<string | null>(null);

  // Project selection modal state — shown before creating or duplicating
  const [projectModalMode, setProjectModalMode] = useState<"create" | "duplicate" | null>(null);
  // Pending project ID for "New Network" workflow (carried from modal to save)
  const [pendingProjectId, setPendingProjectId] = useState<number | null>(null);

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
        onPersonClick: () => handleRoleClick(n.roleKey),
      },
    }));
  }, [parsedGraph, rolesQ.data, handleRoleClick]);

  const initialEdges: Edge[] = useMemo(() => {
    if (!parsedGraph?.edges) return [];
    return parsedGraph.edges.map((e) => ({
      id: e.id,
      source: e.sourceNodeId,
      target: e.targetNodeId,
      label: e.label,
      type: "smoothstep",
      animated: !e.condition,
    }));
  }, [parsedGraph]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // Working copy of edge properties for the selected edge's condition/label
  const [edgeLabel, setEdgeLabel] = useState("");
  const [edgeCondition, setEdgeCondition] = useState<NetworkEdge["condition"]>({ type: "always" });

  // When a single edge is selected, populate the editor from current data
  useEffect(() => {
    if (selectedEdgeIds.length !== 1) return;
    const edgeId = selectedEdgeIds[0];
    // Check parsed graph first, then React Flow state for unsaved edges
    const stored = parsedGraph?.edges?.find((pe) => pe.id === edgeId);
    if (stored) {
      setEdgeLabel(stored.label ?? "");
      setEdgeCondition(stored.condition ?? { type: "always" });
      return;
    }
    // Unsaved edge – use internal label if any
    const rfEdge = edges.find((e) => e.id === edgeId);
    setEdgeLabel((rfEdge?.label as string) ?? "");
    setEdgeCondition({ type: "always" });
  }, [selectedEdgeIds]);

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
      setReviewDepth(parsedGraph.metadata?.reviewDepth ?? "terminal_only");
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
            animated: true,
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
          animated: true,
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
          onPersonClick: () => handleRoleClick(roleKey),
        },
      };

      setNodes((nds) => [...nds, newNode]);
    },
    [setNodes, rolesQ.data, handleRoleClick],
  );

  // --- Edge property handlers ---
  const updateEdgeLabel = useCallback(
    (id: string, label: string) => {
      setEdgeLabel(label);
      setEdges((eds) =>
        eds.map((e) => (e.id === id ? { ...e, label } : e)),
      );
    },
    [setEdges],
  );

  const updateEdgeCondition = useCallback(
    (id: string, condition: NetworkEdge["condition"]) => {
      setEdgeCondition(condition);
      // Edges with a non-"always" condition become solid (animated=false) like saved edges
      const hasCustomCondition =
        condition?.type !== "always" || condition?.operator || condition?.value;
      setEdges((eds) =>
        eds.map((e) =>
          e.id === id ? { ...e, animated: !hasCustomCondition } : e,
        ),
      );
    },
    [setEdges],
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
        // If this edge is currently selected and being edited, use working copy
        const isSelected =
          selectedEdgeIds.length === 1 && selectedEdgeIds[0] === e.id;
        const condition = isSelected
          ? edgeCondition
          : (existingEdge?.condition ?? { type: "always" as const });
        const label = isSelected
          ? (edgeLabel || undefined)
          : ((e.label as string) || undefined);
        return {
          id: e.id,
          sourceNodeId: e.source,
          targetNodeId: e.target,
          label,
          condition,
        };
      }),
      layout: { gridSize: GRID, snapToGrid },
      metadata: {
        rigor,
        maxLoopbacks,
        mandatoryConcerns: parsedGraph?.metadata?.mandatoryConcerns ?? [],
        reviewerRole: parsedGraph?.metadata?.reviewerRole,
        reviewDepth,
      },
    };
    return JSON.stringify(graph);
  }, [nodes, edges, snapToGrid, rigor, maxLoopbacks, reviewDepth, parsedGraph]);

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
        project_id: pendingProjectId ?? undefined,
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
      qc.removeQueries({ queryKey: ["network", networkId] });
      navigate({ to: "/networks", replace: true });
    },
  });

  // --- Project modal handlers ---
  const handleProjectSelectForCreate = useCallback((projectId: number | null) => {
    setProjectModalMode(null);
    setPendingProjectId(projectId);
    // Navigate to a fresh /networks route — the new network editor will use pendingProjectId on save
    navigate({ to: "/networks" });
  }, [navigate]);

  const handleProjectSelectForDuplicate = useCallback((projectId: number | null) => {
    setProjectModalMode(null);
    duplicateMutation.mutate(projectId ?? undefined);
  }, []);

  // --- Duplicate mutation ---
  const duplicateMutation = useMutation({
    mutationFn: (projectId?: number) => api.duplicateNetwork(networkId!, undefined, projectId),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["networks"] });
      navigate({ to: "/networks/$networkId", params: { networkId: res.network.network_id } });
    },
  });

  // --- Role save mutation ---
  const roleSaveMutation = useMutation({
    mutationFn: async (body: {
      enabled: number;
      can_create_subtasks: number;
      system_prompt: string;
      tools_json: string;
      model?: string;
    }) => {
      if (!roleModalKey) throw new Error("No role selected");
      // Use network's project_id if available, otherwise 0 for global
      const pid = currentNetwork?.project_id ?? 0;
      return api.saveRole(pid, roleModalKey, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["allRoles"] });
      setRoleModalKey(null);
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
          <h3>Custom Templates</h3>
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
                {n.project_id != null && (
                  <span className="muted">
                    {projectsQ.data?.projects.find((p) => p.id === n.project_id)?.name ?? `Project #${n.project_id}`}
                  </span>
                )}
                {n.is_default === 1 && <span className="pill ok">default</span>}
              </Link>
            ))}
          {isEditing && (
            <button
              className="small"
              style={{ marginTop: 8, width: "100%" }}
              onClick={() => setProjectModalMode("duplicate")}
            >
              + Duplicate Template
            </button>
          )}
          <button
            className="small primary"
            style={{ marginTop: 8, width: "100%" }}
            onClick={() => setProjectModalMode("create")}
          >
            + New Template
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
            <select
              value={reviewDepth}
              onChange={(e) => setReviewDepth(e.target.value as "none" | "terminal_only" | "every_step")}
              disabled={isReadOnly}
              title="How often the adversarial critic checks a step's output for a domain violation before the gate runs"
            >
              <option value="none">Critique: Off</option>
              <option value="terminal_only">Critique: Reviewer step only</option>
              <option value="every_step">Critique: Every step</option>
            </select>
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
            <MiniMap
              nodeColor={(n) => (n.selected ? "var(--brass)" : "var(--bg3)")}
              position="top-right"
              style={{ width: 150, height: 113 }}
            />
            <Panel position="top-center">
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

      {/* Right Sidebar — Edge Properties & Role Palette */}
      <aside className="network-right-sidebar">
        {/* Edge Properties Panel — shown when exactly one edge is selected */}
        {!isReadOnly && selectedEdgeIds.length === 1 && (() => {
          const edgeId = selectedEdgeIds[0];
          const rfEdge = edges.find((e) => e.id === edgeId);
          const sourceNode = nodes.find((n) => n.id === rfEdge?.source);
          const targetNode = nodes.find((n) => n.id === rfEdge?.target);
          const sourceRole = rolesQ.data?.roles.find((r) => r.key === (sourceNode?.data?.roleKey as string));
          const targetRole = rolesQ.data?.roles.find((r) => r.key === (targetNode?.data?.roleKey as string));

          const condType = edgeCondition?.type ?? "always";
          const showOperator = condType !== "always";
          const showValue = condType === "verdict" || condType === "criteria";

          return (
            <div className="network-sidebar-section">
              <h3>Edge Properties</h3>

              {/* Source / Target info */}
              <div className="row muted" style={{ fontSize: 12, marginBottom: 8, gap: 4 }}>
                <span>{sourceRole?.title ?? (sourceNode?.data as any)?.roleKey as string ?? rfEdge?.source ?? "?"}</span>
                <span>→</span>
                <span>{targetRole?.title ?? (targetNode?.data as any)?.roleKey as string ?? rfEdge?.target ?? "?"}</span>
              </div>

              {/* Label */}
              <label className="muted" style={{ display: "block", marginBottom: 4 }}>
                Label
                <input
                  style={{ width: "100%", marginTop: 2 }}
                  value={edgeLabel}
                  onChange={(e) => updateEdgeLabel(edgeId, e.target.value)}
                  placeholder="Optional edge label"
                />
              </label>

              {/* Condition Type */}
              <label className="muted" style={{ display: "block", marginBottom: 4 }}>
                Condition
                <select
                  style={{ width: "100%", marginTop: 2 }}
                  value={condType}
                  onChange={(e) => {
                    const newType = e.target.value as NonNullable<NetworkEdge["condition"]>["type"];
                    if (newType === "always") {
                      updateEdgeCondition(edgeId, { type: "always" });
                    } else if (newType === "coverage") {
                      updateEdgeCondition(edgeId, { type: "coverage", operator: "any_unmet" });
                    } else if (newType === "verdict") {
                      updateEdgeCondition(edgeId, { type: "verdict", operator: "eq", value: "pass" });
                    } else {
                      updateEdgeCondition(edgeId, { type: newType, operator: "any_unmet", value: "" });
                    }
                  }}
                >
                  <option value="always">Always (unconditional)</option>
                  <option value="verdict">Verdict — pass / blocker / etc.</option>
                  <option value="coverage">Coverage — unmet / missing</option>
                  <option value="criteria">Criteria — unmet / missing</option>
                </select>
              </label>

              {/* Operator (for non-"always" types) */}
              {showOperator && (
                <label className="muted" style={{ display: "block", marginBottom: 4 }}>
                  Operator
                  <select
                    style={{ width: "100%", marginTop: 2 }}
                    value={edgeCondition?.operator ?? "any_unmet"}
                    onChange={(e) =>
                      updateEdgeCondition(edgeId, {
                        ...edgeCondition!,
                        operator: e.target.value as NonNullable<NetworkEdge["condition"]>["operator"],
                      })
                    }
                  >
                    {condType === "verdict" ? (
                      <>
                        <option value="eq">Equals (==)</option>
                        <option value="neq">Not Equals (!=)</option>
                      </>
                    ) : (
                      <>
                        <option value="any_unmet">Any Unmet</option>
                        <option value="any_missing">Any Missing</option>
                      </>
                    )}
                  </select>
                </label>
              )}

              {/* Value (for verdict / criteria) */}
              {showValue && (
                <label className="muted" style={{ display: "block", marginBottom: 8 }}>
                  {condType === "verdict" ? "Verdict" : "Key"}
                  <input
                    style={{ width: "100%", marginTop: 2 }}
                    value={edgeCondition?.value ?? ""}
                    onChange={(e) =>
                      updateEdgeCondition(edgeId, {
                        ...edgeCondition!,
                        value: e.target.value,
                      })
                    }
                    placeholder={condType === "verdict" ? "pass" : "criteria key"}
                  />
                </label>
              )}
            </div>
          );
        })()}

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

      {/* Project Select Modal */}
      {projectModalMode && projectsQ.data && (
        <ProjectSelectModal
          projects={projectsQ.data.projects}
          onSelect={
            projectModalMode === "create"
              ? handleProjectSelectForCreate
              : handleProjectSelectForDuplicate
          }
          onCancel={() => setProjectModalMode(null)}
        />
      )}

      {/* Role Edit Modal — only shown for global networks without a project */}
      {roleModalKey && currentNetwork?.project_id == null && (() => {
        const role = rolesQ.data?.roles.find((r) => r.key === roleModalKey);
        if (!role) return null;
        return (
          <RoleEditModal
            role={role}
            projectId={null}
            modelConfigs={modelConfigs}
            defaultModelConfigName={defaultModelConfigName}
            onSave={(body) => roleSaveMutation.mutate(body)}
            onCancel={() => setRoleModalKey(null)}
            isSaving={roleSaveMutation.isPending}
          />
        );
      })()}
    </div>
  );
}