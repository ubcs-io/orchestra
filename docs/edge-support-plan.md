# Edge Support Implementation Plan

> **Status:** Planning | **Author:** Orchestra Engineering | **Date:** 2026-07-14

---

## Table of Contents

1. [Context & Current State Analysis](#context--current-state-analysis)
2. [Phase 1: Editor Edge UX](#phase-1-editor-edge-ux)
3. [Phase 2: Edge-Aware Orchestration](#phase-2-edge-aware-orchestration)

---

## Context & Current State Analysis

### What Exists Today

#### Type Definitions (`client/src/api.ts`)

The `NetworkEdge` interface is fully specified with rich condition support:

```typescript
export interface NetworkEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  label?: string;
  condition?: {
    type: "verdict" | "always" | "coverage" | "criteria";
    value?: string;
    operator?: "eq" | "neq" | "any_unmet" | "any_missing";
  };
}
```

The `AgentNetworkGraph` interface includes both `nodes: NetworkNode[]` and `edges: NetworkEdge[]`. The `NetworkExport` wraps this entire graph for import/export.

#### Editor (`client/src/routes/NetworkEditor.tsx`)

The editor uses `@xyflow/react` (React Flow v12+) with:

- **`onConnect` handler (line 154):** The default drag-from-handle-to-handle connection works. When a user drags from one node's output handle to another node's input handle, a new `smoothstep` edge is created with a generated ID. This is the only way to create edges currently — there is no alternative UI control.

- **Edge parsing from JSON (lines 106–116):** Stored edges are mapped into React Flow edges correctly — `sourceNodeId` → `source`, `targetNodeId` → `target`, `label` → `label`, `condition` presence → `animated`.

- **Edge serialization BUG (lines 221–227):** `buildGraphJson()` **hardcodes every edge's `condition` to `{ type: "always" }`**, completely discarding whatever condition was stored in `parsedGraph`. This means:
  - If a user imports a network with custom edge conditions, they are lost on save.
  - The loopback label on reviewer edges is preserved (it comes from `e.label`), but the semantic condition is wiped.
  - New edges created by drag-to-connect get `{ type: "always" }` which is correct for new edges, but existing edges with richer conditions get flattened.

- **Edge deletion (lines 201–205):** The `deleteSelected` callback filters both nodes and edges by `selectedNodeId`. In theory this would delete an edge if its ID matches. However:
  - There is **no `onEdgeClick` handler** wired — edges cannot be selected.
  - The `onNodeClick` (line 420) sets `selectedNodeId` to the node's ID.
  - The `onPaneClick` (line 421) clears `selectedNodeId`.
  - Only nodes can ever populate `selectedNodeId`, so edge deletion via the toolbar button is effectively dead code.

- **Edge deletion via keyboard (line 426–429):** React Flow's `deleteKeyCode` is set to `["Backspace", "Delete"]`. React Flow's built-in keyboard delete works on whatever is selected in the flow. Since edges cannot be selected, this only deletes nodes.

- **Edge visibility:** The default React Flow `smoothstep` edge type with `animated` when a condition is present makes edges visible. The background dots, controls, and minimap are all present. But the user has no visual affordance to interact with edges directly.

- **Toolbar (lines 435–450):** The top-right panel shows a "Delete Selected" button when `selectedNodeId` is truthy. There is no "Add Edge" button and no hint text about edge interactions.

- **CSS:** The custom node component (`NetworkNodeCard`) is styled but there are no custom edge styles beyond React Flow defaults.

#### Roles / Seeding (`server/src/roles.ts`)

`flowToGraph()` (line 643) converts a `FlowTemplate` into an `AgentNetworkGraph` for system network seeding:

- **Linear edges only (lines 701–709):** A single pass creates edges connecting `nodes[i-1]` → `nodes[i]` for every adjacent pair. Every edge gets `condition: { type: "always" }`.
- **Reviewer loopback label (lines 713–719):** The edge leading *into* the reviewer node gets a label `"needs_more → loopback"` but the condition is still `{ type: "always" }`. This is purely documentary — it tells the human reader "this is where loopback happens" but encodes no machine-readable branching logic.
- **No cross-edges, skip edges, or conditional forks:** The graph is a strict one-directional chain. There is no way to express "if the security review finds a vulnerability, route to privacy_review before proceeding to decomposition."

#### Orchestrator (`server/src/orchestrator.ts`)

The orchestrator **completely ignores edges**. Two functions consume network graphs:

1. **`flowForTask()` (line 99):** Reads `graph.metadata` (rigor, maxLoopbacks, mandatoryConcerns, reviewerRole) and `graph.nodes[].criteria`. Extracts `graph.nodes[].roleKey` into a flat ordered array for `steps`. The `edges` field is never destructured, read, or evaluated.

2. **`planFromTemplate()` (line 160):** Reads `graph.nodes[].roleKey` (and `overrides.depth`) to build a `RefinementPlan`. Again, edges are invisible.

The actual routing logic is hardcoded in `applyGate()` (line 726):

- The reviewer role's gate logic (lines 779–836) determines whether to loop-back or proceed to terminal.
- Loop-back re-opens all pending steps for the owners of unmet criteria (linear array scan).
- The next step is always `nextPending(plan)` (line 1002) which finds the first `status: "pending"` step in the linear array.
- There is no notion of "follow the matching edge" or "branch based on verdict."

#### Database (`server/src/db.ts`)

The `agent_networks` table stores `graph_json TEXT NOT NULL`. The entire graph (nodes, edges, layout, metadata) is serialized as a single JSON string. No edge-specific columns exist — edges live entirely within `graph_json`. This is correct for the current architecture.

#### API Routes (`server/src/routes/api.ts`)

- **Create (POST `/api/networks`):** Validates `graph_json` is valid JSON but does not validate internal structure (nodes/edges shape).
- **Update (PUT `/api/networks/:id`):** Same validation.
- **Import (POST `/api/networks/import`):** Validates that `graph_json` has `nodes` and `edges` arrays. Applies waterfall layout on import, which repositions nodes but preserves edge structure.
- **Export (GET `/api/networks/:id/export`):** Returns the full `graph` object including edges.
- **Duplicate (POST `/api/networks/:id/duplicate`):** Applies waterfall layout to the copy.

---

## Phase 1: Editor Edge UX

### Objective

Make edges fully interactive in the network editor: users can select, delete, and create edges through multiple affordances (drag, button, keyboard). Fix the edge condition serialization bug. Add visual cues and hint text.

### Current Gaps

| Gap | Severity | Description |
|-----|----------|-------------|
| No edge selection | High | Edges cannot be clicked/selected; `onEdgeClick` is not wired |
| Edge deletion is dead code | High | `deleteSelected` checks for edge IDs but none are ever selected |
| Condition serialization bug | High | `buildGraphJson` hardcodes `{ type: "always" }` for every edge |
| No explicit "Add Edge" button | Medium | Only drag-from-handle works; no button for multi-selected nodes |
| No hint text for interactions | Low | Users don't know Shift+Click exists or that edges are interactive |
| Edge click visual feedback | Low | No highlight/selection style for edges |

### Detailed Changes

#### 1A. Enable Edge Selection

**File:** `client/src/routes/NetworkEditor.tsx`

**Changes:**

1. **Rename or add edge selection state.** Currently `selectedNodeId` tracks selected element IDs. Rename to `selectedElementId` (or keep the name and add an `selectedEdgeId` variable). The simpler approach: keep `selectedNodeId` as-is and add `selectedEdgeId` state alongside it, then derive a combined `hasSelection` boolean.

```typescript
const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

// Clear both on pane click
const onPaneClick = useCallback(() => {
  setSelectedNodeId(null);
  setSelectedEdgeId(null);
}, []);

// Select node on node click
const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
  setSelectedNodeId(node.id);
  setSelectedEdgeId(null);
}, []);

// Select edge on edge click
const onEdgeClick = useCallback((_: React.MouseEvent, edge: Edge) => {
  setSelectedEdgeId(edge.id);
  setSelectedNodeId(null);
}, []);
```

2. **Wire `onEdgeClick`** to the `<ReactFlow>` component:

```tsx
<ReactFlow
  // ...existing props
  onEdgeClick={onEdgeClick}
  // ...
>
```

3. **Update `deleteSelected`** to handle edge IDs:

```typescript
const deleteSelected = useCallback(() => {
  if (selectedEdgeId) {
    setEdges((eds) => eds.filter((e) => e.id !== selectedEdgeId));
    setSelectedEdgeId(null);
    return;
  }
  if (selectedNodeId) {
    setNodes((nds) => nds.filter((n) => n.id !== selectedNodeId));
    setEdges((eds) => eds.filter((e) => e.source !== selectedNodeId && e.target !== selectedNodeId));
    setSelectedNodeId(null);
  }
}, [selectedNodeId, selectedEdgeId, setNodes, setEdges]);
```

4. **Update `onNodesDelete`** to also clear edge selection:

```typescript
onNodesDelete={(deleted) => {
  if (deleted.some((n) => n.id === selectedNodeId)) setSelectedNodeId(null);
}}
onEdgesDelete={(deleted) => {
  if (deleted.some((e) => e.id === selectedEdgeId)) setSelectedEdgeId(null);
}}
```

**React Flow default edge selection note:** React Flow supports built-in edge selection via `selectable` on the edge type. With `smoothstep` edges, clicking near the edge path selects it. We should ensure `interactive: true` is set (it is by default) and test that click zones are wide enough. If edge clicks don't register reliably, we can add a `connectionLineStyle` and increase the edge `interactionWidth` (React Flow v12 default is 20px).

**CSS (`client/src/styles.css`):**

Add a visual style for selected edges via React Flow's CSS classes. React Flow applies `.selected` class to selected edges automatically:

```css
/* Edge selection highlight */
.react-flow__edge.selected .react-flow__edge-path {
  stroke: var(--brass, #f0c040);
  stroke-width: 2.5;
}
```

#### 1B. Add Explicit Edge Creation Controls

**Option A: "Connect Selected" Button**

When exactly two nodes are selected (via Shift+Click), show a "Connect Nodes" button in the toolbar.

1. **Track multi-selection.** React Flow's `multiSelectionKeyCode="Shift"` is already set. Nodes can be Shift+clicked to multi-select. However, `onNodeClick` currently sets `selectedNodeId` to a single ID — this needs to change to support multi-select tracking.

React Flow internally tracks `nodesSelectionActive` and provides hooks. The simplest approach without adding new React Flow hooks:

Use `onSelectionChange` which fires whenever the selection changes, including multi-select:

```typescript
const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);

const onSelectionChange = useCallback(({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) => {
  setSelectedNodeIds(nodes.map(n => n.id));
  setSelectedEdgeIds(edges.map(e => e.id));
}, []);
```

This replaces the manual `selectedNodeId`/`selectedEdgeId` tracking from 1A and uses React Flow's native selection system.

2. **"Connect Nodes" button** in the toolbar:

```tsx
{selectedNodeIds.length === 2 && (
  <button
    className="small"
    onClick={() => {
      const [source, target] = selectedNodeIds;
      const newEdge: Edge = {
        id: `e-${generateId()}`,
        source: source!,
        target: target!,
        type: "smoothstep",
      };
      setEdges((eds) => addEdge(newEdge, eds));
    }}
  >
    Connect Nodes
  </button>
)}
```

**Option B: Keyboard Shortcut**

When two nodes are selected, pressing `E` or `C` creates an edge between them. This is a nice-to-have in addition to the button.

React Flow doesn't support custom keyboard handlers natively when nodes are selected. We'd add a `useEffect` with a keydown listener:

```typescript
useEffect(() => {
  const handler = (e: KeyboardEvent) => {
    if (e.key === 'e' && selectedNodeIds.length === 2) {
      const [source, target] = selectedNodeIds;
      const newEdge: Edge = {
        id: `e-${generateId()}`,
        source: source!,
        target: target!,
        type: "smoothstep",
      };
      setEdges((eds) => addEdge(newEdge, eds));
    }
  };
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}, [selectedNodeIds, setEdges]);
```

**Implementation decision:** Use `onSelectionChange` as the primary selection mechanism (replacing `onNodeClick`/`onEdgeClick`). This gives us multi-select for free and is more idiomatic with React Flow. Add both the button and the keyboard shortcut.

#### 1C. Fix Edge Condition Serialization

**File:** `client/src/routes/NetworkEditor.tsx`

**Current (buggy) code (line 226):**

```typescript
edges: edges.map((e) => ({
  id: e.id,
  sourceNodeId: e.source,
  targetNodeId: e.target,
  label: (e.label as string) || undefined,
  condition: { type: "always" as const },  // BUG: always hardcoded
})),
```

**Fixed code:**

```typescript
edges: edges.map((e) => {
  const existingEdge = parsedGraph?.edges?.find((pe) => pe.id === e.id);
  const existingCondition = existingEdge?.condition;
  // Preserve stored condition if available, otherwise default to "always"
  const condition = existingCondition ?? { type: "always" as const };
  return {
    id: e.id,
    sourceNodeId: e.source,
    targetNodeId: e.target,
    label: (e.label as string) || undefined,
    condition,
  };
}),
```

This ensures:
- Existing edges with custom conditions (e.g., `{ type: "verdict", value: "blocker", operator: "eq" }`) are preserved on save.
- Newly created edges (not in `parsedGraph`) default to `{ type: "always" }`.
- Imported networks with rich edge conditions retain them through edit cycles.

#### 1D. Toolbar & Hint Text

**File:** `client/src/routes/NetworkEditor.tsx`

Add a small hint bar below the top metadata bar (or as a subtle text element in the flow panel) showing available interactions:

```tsx
<div className="network-hint-bar">
  <span className="muted" style={{ fontSize: 11 }}>
    Drag from handle to connect · Shift+Click to multi-select · Click edge to select · Del to remove
  </span>
</div>
```

Position this either:
- As a `Panel` inside React Flow (top-left, subtle)
- Below the topbar metadata row
- In the bottom bar next to the Snap checkbox

Also update the toolbar panel to show contextual actions:

```tsx
<Panel position="top-right">
  <div className="network-canvas-toolbar">
    {selectedEdgeIds.length === 1 && (
      <button className="small" onClick={deleteSelected}>
        Delete Edge
      </button>
    )}
    {selectedNodeIds.length === 1 && (
      <button className="small" onClick={deleteSelected}>
        Delete Node
      </button>
    )}
    {selectedNodeIds.length === 2 && (
      <button className="small" onClick={connectSelected}>
        Connect Nodes
      </button>
    )}
    {selectedNodeIds.length > 1 && (
      <button className="small" onClick={deleteSelected}>
        Delete Selected ({selectedNodeIds.length})
      </button>
    )}
    {isEditing && isSystem && (
      <span className="muted" style={{ fontSize: 12 }}>
        Read-only (duplicate to edit)
      </span>
    )}
  </div>
</Panel>
```

#### 1E. Complete `onSelectionChange` Rewrite

Since we're moving to `onSelectionChange` for multi-select support, here's the full migration plan:

**Remove:**
- `selectedNodeId` state
- `onNodeClick` handler
- `onPaneClick` handler (or keep it for deselection — React Flow deselects on pane click by default)

**Add:**
- `selectedNodeIds: string[]` state
- `selectedEdgeIds: string[]` state
- `onSelectionChange` handler

**Update `deleteSelected`:**
```typescript
const deleteSelected = useCallback(() => {
  if (selectedEdgeIds.length > 0) {
    setEdges((eds) => eds.filter((e) => !selectedEdgeIds.includes(e.id)));
  }
  if (selectedNodeIds.length > 0) {
    setNodes((nds) => nds.filter((n) => !selectedNodeIds.includes(n.id)));
    setEdges((eds) => eds.filter((e) => 
      !selectedNodeIds.includes(e.source) && !selectedNodeIds.includes(e.target)
    ));
  }
}, [selectedNodeIds, selectedEdgeIds, setNodes, setEdges]);
```

**Update ReactFlow props:**
```tsx
<ReactFlow
  // Remove: onNodeClick, onPaneClick
  // Add:
  onSelectionChange={onSelectionChange}
  // Keep:
  onConnect={onConnect}
  deleteKeyCode={["Backspace", "Delete"]}
  multiSelectionKeyCode="Shift"
  selectionKeyCode="Shift"
  // ...
>
```

#### 1F. CSS Additions

**File:** `client/src/styles.css`

```css
/* --- Network Editor: Edge Interactions --- */

/* Selected edge highlight */
.react-flow__edge.selected .react-flow__edge-path {
  stroke: var(--brass, #f0c040) !important;
  stroke-width: 2.5 !important;
}

/* Edge hover state (for discoverability) */
.react-flow__edge:hover .react-flow__edge-path {
  stroke: var(--brass, #f0c040);
  stroke-width: 2;
}

/* Wider click target for edges */
.react-flow__edge {
  cursor: pointer;
}

/* Edge interaction width — makes edges easier to click */
.react-flow__edgeinteraction {
  cursor: pointer;
}

/* Connection line style (when dragging a new edge) */
.react-flow__connection-line {
  stroke: var(--brass, #f0c040);
  stroke-width: 2;
}

/* Handle hover to indicate connectability */
.react-flow__handle:hover {
  stroke: var(--brass, #f0c040);
}

/* Hint bar styling */
.network-hint-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
  background: var(--bg2, #1e1e2e);
  border-top: 1px solid var(--bg3, #2e2e3e);
}
```

### Phase 1: File Change Summary

| File | Lines Changed | Description |
|------|--------------|-------------|
| `client/src/routes/NetworkEditor.tsx` | ~60 lines | `onSelectionChange`, `selectedNodeIds`/`selectedEdgeIds` state, `connectSelected`, `deleteSelected` rewrite, `buildGraphJson` condition fix, toolbar buttons, hint text |
| `client/src/styles.css` | ~35 lines | Edge selection/hover styles, interaction width, connection line, hint bar |

### Phase 1: Testing Checklist

- [ ] Drag from handle to handle creates an edge (existing functionality preserved)
- [ ] Clicking an edge selects it (visual highlight visible)
- [ ] Pressing Delete/Backspace with edge selected removes it
- [ ] Shift+Click selects two nodes; "Connect Nodes" button appears and works
- [ ] Pressing `E` key with two nodes selected creates an edge
- [ ] Deleting a node also deletes its incident edges
- [ ] Saving a network preserves edge conditions from import
- [ ] New edges default to `{ type: "always" }`
- [ ] Hint text displays correctly
- [ ] Multi-select delete (multiple nodes) cleans up all incident edges
- [ ] Read-only (system) networks do not show edit controls
- [ ] Snapping, minimap, controls all still work

---

## Phase 2: Edge-Aware Orchestration

### Objective

Make the orchestrator evaluate edge conditions after each role step to determine the next node dynamically, rather than always following a linear ordered list. This enables branching workflows like:

- "If the security review finds a blocker, route to privacy_review before decomposition."
- "If the explorer finds no relevant code, skip architecture_review and go straight to test_strategy."
- "If the reviewer verdict is `needs_more`, loop back to the owner role (existing behavior, but driven by edges instead of hardcoded logic)."

### Design Principles

1. **Backward compatible.** Networks without conditional edges (the current system templates) must behave identically. Linear chains with `{ type: "always" }` edges must produce the same plan order as today.
2. **Edges bias, not dictate.** If no edge condition matches, fall back to the linear order defined by the `nodes` array (explicit ordering is the tiebreaker). This matches the user's original intent: *"node paths bias the orchestrator by encouraging routing to 'next planned node'"*.
3. **Deterministic and predictable.** The routing algorithm must be easy to reason about — users should be able to look at the graph and understand exactly what path a task will follow.
4. **Compatible with existing interventions.** Human interventions (`inject_role`, `rerun_role`, `deepen`) still insert/reattach to the plan as they do today. Edge routing applies to the *automated* progression, not to human overrides.
5. **The reviewer gate remains.** The counter-reviewer loopback logic in `applyGate()` is critical infrastructure and must not be replaced, only enhanced. Edge conditions can provide *additional* branching points; the gate still governs quality.

### Current Routing vs. Proposed

**Current:**
```
planFromTemplate() → flat ordered list from nodes[].roleKey
pickNextTask() → nextPending(plan) → first step with status "pending"
applyGate() → on reviewer "needs_more" → reopen all owner steps (linear scan)
```

**Proposed:**
```
planFromTemplate() → build graph adjacency map from nodes + edges
pickNextTask() → find next step by evaluating outgoing edges from the LAST completed step
applyGate() → (unchanged for now) loopback logic remains, but the "next step after gate" is edge-driven
```

### Edge Condition Evaluation

After a role step completes (in `runOneStep` → after persisting the run), the orchestrator evaluates the outgoing edges from the completed node. The first matching edge's target becomes the next node.

#### Condition Types

| Type | Operator | Semantics |
|------|----------|-----------|
| `always` | (none) | Always matches — default fallthrough edge |
| `verdict` | `eq` / `neq` | Match the completed role's verdict (pass, needs_more, blocker, needs_human) |
| `coverage` | `any_unmet` / `any_missing` | Match coverage map state — e.g., "security concern is not yet considered" |
| `criteria` | `any_unmet` / `any_missing` | Match criteria results state — e.g., "any must criterion is unmet" |

#### Evaluation Order

1. Edges are evaluated in the order they appear in the `edges` array for the source node.
2. The **first edge whose condition evaluates to `true`** wins and its `targetNodeId` becomes the next node.
3. If **no edge matches**, fall back to the linear order: find the next node in the `nodes` array after the current one that has `status: "pending"`.
4. If the current node is the last in the `nodes` array (or no pending nodes remain), the plan is complete → move to terminal/ready.

#### Evaluation Function (Pseudocode)

```typescript
interface EdgeEvaluationContext {
  verdict: string;                          // from the completed role run
  coverage: CoverageMap;                    // rolled-up coverage after this run
  criteriaResults: CriteriaResult[];        // from the completed role run (if reviewer)
}

function evaluateEdgeCondition(
  condition: NetworkEdge["condition"],      // { type, value?, operator? }
  context: EdgeEvaluationContext,
): boolean {
  if (!condition || condition.type === "always") return true;

  switch (condition.type) {
    case "verdict": {
      const op = condition.operator ?? "eq";
      if (op === "eq") return context.verdict === condition.value;
      if (op === "neq") return context.verdict !== condition.value;
      return false;
    }

    case "coverage": {
      const op = condition.operator ?? "any_unmet";
      const concern = condition.value; // specific concern key, or undefined = any
      if (op === "any_unmet") {
        // Any concern (or specific concern) has status !== "considered"
        if (concern) return (context.coverage[concern]?.status ?? "never") !== "considered";
        return Object.values(context.coverage).some(c => c.status !== "considered");
      }
      if (op === "any_missing") {
        // Any concern has status "never" or "out_of_scope"
        if (concern) {
          const s = context.coverage[concern]?.status ?? "never";
          return s === "never" || s === "out_of_scope";
        }
        return Object.values(context.coverage).some(
          c => c.status === "never" || c.status === "out_of_scope"
        );
      }
      return false;
    }

    case "criteria": {
      const op = condition.operator ?? "any_unmet";
      if (op === "any_unmet") {
        // Any criterion (or specific criterion id) has status !== "met"
        if (condition.value) {
          return context.criteriaResults.some(
            c => c.id === condition.value && c.status !== "met"
          );
        }
        return context.criteriaResults.some(c => c.status !== "met");
      }
      return false;
    }

    default:
      return false;
  }
}
```

### Changes to `orchestrator.ts`

#### 2A. Graph Traversal Data Structure

Build an adjacency map from the graph at plan-creation time. Store it as part of the task's plan (extend `RefinementPlan`) or compute it on-demand from the network.

**Option A: Extend `RefinementPlan`**

```typescript
export interface RefinementPlan {
  steps: PlanStep[];
  /** Adjacency map: nodeId → outgoing edges (populated from network graph). */
  graph?: {
    nodeIds: string[];           // ordered node IDs (same as steps[].role → node mapping)
    nodeIdByRole: Map<string, string>; // roleKey → nodeId
    outgoingEdges: Map<string, NetworkEdge[]>; // nodeId → edges
  };
}
```

This is stored in `refinement_plan_json` on the task row. Since it's JSON-serialized, we need plain objects, not `Map`. Use records instead:

```typescript
export interface PlanGraph {
  nodeIds: string[];
  nodeIdByRole: Record<string, string>;
  outgoingEdges: Record<string, NetworkEdge[]>;
}
```

**Option B: Recompute on every tick**

Parse `graph_json` from the network row each time we need to route. This avoids storing graph data in the plan JSON but adds a DB read + JSON parse on every step. Since networks are small (<30 nodes, <30 edges), this is negligible. **Prefer Option B** — it keeps the plan simple and avoids duplication.

#### 2B. `planFromTemplate()` Changes

Currently:

```typescript
export function planFromTemplate(kind: IntakeKind, networkId?: string | null): RefinementPlan {
  if (networkId) {
    const network = getNetwork(networkId);
    if (network) {
      try {
        const graph = JSON.parse(network.graph_json) as { nodes?: Array<{ roleKey: string }> };
        if (graph.nodes?.length) {
          return {
            steps: graph.nodes.map((n) => ({
              role: n.roleKey,
              status: "pending" as const,
              depth: n.overrides?.depth ?? 1,
            })),
          };
        }
      } catch { /* fall through */ }
    }
  }
  const roles = flowForIntake(kind).steps;
  return { steps: roles.map((role) => ({ role, status: "pending", depth: 1 })) };
}
```

**New version:**

```typescript
export function planFromTemplate(kind: IntakeKind, networkId?: string | null): RefinementPlan {
  if (networkId) {
    const network = getNetwork(networkId);
    if (network) {
      try {
        const graph = JSON.parse(network.graph_json) as AgentNetworkGraph;
        if (graph.nodes?.length) {
          // Build role → nodeId lookup and adjacency map
          const nodeIdByRole: Record<string, string> = {};
          for (const node of graph.nodes) {
            nodeIdByRole[node.roleKey] = node.id;
          }

          const steps: PlanStep[] = graph.nodes.map((n) => ({
            role: n.roleKey,
            status: "pending" as const,
            depth: n.overrides?.depth ?? 1,
          }));

          const plan: RefinementPlan = {
            steps,
            // Store graph routing info on the plan for edge-aware traversal
            graph: {
              nodeIds: graph.nodes.map(n => n.id),
              nodeIdByRole,
              // Edges from the graph — preserved as-is for routing
              edges: graph.edges ?? [],
            },
          };
          return plan;
        }
      } catch { /* fall through */ }
    }
  }
  const roles = flowForIntake(kind).steps;
  return { steps: roles.map((role) => ({ role, status: "pending", depth: 1 })) };
}
```

Note: We need to extend `RefinementPlan` with an optional `graph` field.

#### 2C. `nextPending()` Replacement

Currently `nextPending(plan)` returns the first step with `status: "pending"`. This is used in `tickOnce()` (line 1002) to determine which step runs next.

**New version — `nextStep(plan, lastCompletedRole)`:**

```typescript
/**
 * Determine the next step after a role completes, using edge conditions if
 * available. Falls back to linear order when no edges match.
 */
function nextStep(
  plan: RefinementPlan,
  lastCompletedRole: string,
  context?: EdgeEvaluationContext,
): PlanStep | undefined {
  // If no graph routing info, use linear fallback
  if (!plan.graph || !context) {
    return plan.steps.find((s) => s.status === "pending");
  }

  const { nodeIdByRole, nodeIds, edges } = plan.graph;
  const currentNodeId = nodeIdByRole[lastCompletedRole];
  if (!currentNodeId) {
    // Role not found in graph — linear fallback
    return plan.steps.find((s) => s.status === "pending");
  }

  // Get outgoing edges from the completed node
  const outgoing = edges.filter((e) => e.sourceNodeId === currentNodeId);
  if (outgoing.length > 0) {
    // Evaluate conditions in edge array order
    for (const edge of outgoing) {
      if (evaluateEdgeCondition(edge.condition, context)) {
        const targetNode = plan.steps.find((s) => 
          nodeIdByRole[s.role] === edge.targetNodeId && s.status === "pending"
        );
        if (targetNode) return targetNode;
      }
    }
    // No edge matched — fall through to linear fallback
  }

  // Linear fallback: next pending step after current role in nodeIds order
  const currentIndex = nodeIds.indexOf(currentNodeId);
  for (let i = currentIndex + 1; i < nodeIds.length; i++) {
    const nodeId = nodeIds[i]!;
    const roleKey = Object.entries(nodeIdByRole).find(([, id]) => id === nodeId)?.[0];
    if (roleKey) {
      const step = plan.steps.find((s) => s.role === roleKey && s.status === "pending");
      if (step) return step;
    }
  }

  return undefined; // No pending steps — plan complete
}
```

#### 2D. Where to Call `nextStep()`

Currently in `tickOnce()` (line 1002):

```typescript
const step = nextPending(plan);
if (!step) {
  applyGate(task, project, plan, { role: "", status: "done", depth: 1 }, "pass", rollupCoverage(task.task_id));
  return true;
}
await runOneStep(task, project, step, plan);
```

This always picks the first pending step. After Phase 2:

```typescript
// Determine context from the last completed role run
const lastRun = listRoleRuns(task.task_id).slice(-1)[0];
const context = lastRun ? buildEdgeContext(lastRun, task) : undefined;

const step = nextStep(plan, lastRun?.role_key ?? "", context);
if (!step) {
  applyGate(task, project, plan, { role: "", status: "done", depth: 1 }, "pass", rollupCoverage(task.task_id));
  return true;
}
await runOneStep(task, project, step, plan);
```

Where `buildEdgeContext` assembles the `EdgeEvaluationContext` from the last run:

```typescript
function buildEdgeContext(lastRun: RoleRunRow, task: TaskRow): EdgeEvaluationContext {
  const coverage = rollupCoverage(task.task_id);
  let criteriaResults: CriteriaResult[] = [];
  if (lastRun.criteria_results_json) {
    try {
      criteriaResults = JSON.parse(lastRun.criteria_results_json);
    } catch { /* ignore */ }
  }
  return {
    verdict: lastRun.verdict ?? "pass",
    coverage,
    criteriaResults,
  };
}
```

#### 2E. Interaction with `applyGate()`

The gate logic (`applyGate()`, line 726) is orthogonal to edge routing. The gate:

1. Checks the verdict of the *just-completed* step.
2. If it's the reviewer and the review fails, re-opens owner steps and sets the reviewer back to pending.
3. If terminal or no pending steps, moves to ready.

After Phase 2, the gate still re-opens steps (sets `step.status = "pending"`). When `nextStep()` is called on the next tick, it will:
- Find the re-opened steps as pending.
- Use edge routing from the reviewer node to determine which specific owner to re-run first (if the reviewer has conditional outgoing edges).
- If no matching edges, fall back to linear order (which is the current behavior).

**No changes needed to `applyGate()` for Phase 2.** The gate mutates plan state; edge routing reads plan state. They compose naturally.

#### 2F. Migration: `flowForTask()` Changes

`flowForTask()` (line 99) reads `graph.metadata` and `graph.nodes[].criteria`. It does not need to read edges — criteria extraction is orthogonal to routing. No changes needed.

#### 2G. Edge Condition Persistence in Plan

The `RefinementPlan` with a `graph` field containing edges must be serialized to `refinement_plan_json`. This means:

- On plan creation (`planFromTemplate`), we store the graph adjacency info.
- On plan mutation (interventions like `inject_role`, `rerun_role`), we must update the graph info accordingly:
  - `inject_role`: The injected role has no edges by default. It's inserted into the linear order. Outgoing edges from the predecessor and to the successor must be adjusted — or, simpler, the injected role follows linear order.
  - `rerun_role` / `deepen`: No graph changes — the role is already in the graph.
- When saving the plan after interventions (`consumeInterventions`), the graph info must be preserved.

**Simplification:** Rather than storing the full graph in every plan step's JSON, store a reference to the network and re-read edges from there. This avoids edge-injection complexity with interventions.

**Final approach for Phase 2:** Add a `networkId` field to `RefinementPlan`. When `nextStep()` needs edges, it reads them from `getNetwork(plan.networkId).graph_json`. This keeps the plan JSON small and avoids edge/injection inconsistencies.

```typescript
export interface RefinementPlan {
  steps: PlanStep[];
  /** If set, edge routing is enabled and edges are read from this network. */
  networkId?: string;
  /** Cached at plan-creation time for fast lookups. */
  nodeIdByRole?: Record<string, string>;
  nodeIds?: string[];
}
```

#### 2H. `nextPending()` During Interventions

When `applyPlanMutation()` re-opens steps (e.g., reviewer loopback), the `nextStep()` function still works correctly:

1. The last completed role is the reviewer (verdict: `needs_more`).
2. Outgoing edges from the reviewer are evaluated.
3. If the reviewer has edges like `{ type: "verdict", value: "needs_more", operator: "eq" }` pointing to specific owner roles, those owners are prioritized.
4. The existing `applyGate()` logic already re-opens ALL owner steps — this is correct and ensures no step is skipped.
5. `nextStep()` picks the first pending step among the re-opened ones using edge priority.

**Potential issue:** If edges route to a specific owner but the gate reopened multiple owners, the non-routed owners remain pending and will be picked up in subsequent ticks via linear fallback. This is acceptable behavior.

### Phase 2: Data Flow Diagram

```
Task Created
    │
    ▼
planFromTemplate(intakeKind, networkId)
    │
    ├── Reads network.graph_json
    ├── Extracts nodes → steps (ordered)
    ├── Stores nodeIdByRole, nodeIds in plan
    ├── Stores networkId in plan
    │
    ▼
Orchestrator Tick
    │
    ▼
pickNextTask() → task with stage=intake|refining
    │
    ▼
readPlan(task) → RefinementPlan
    │
    ▼
consumeInterventions() → mutate plan steps
    │
    ▼
lastRun = listRoleRuns(task).last()
    │
    ▼
if lastRun exists:
    context = buildEdgeContext(lastRun, task)
    step = nextStep(plan, lastRun.role_key, context)
else:
    step = nextPending(plan)  // first step, linear
    │
    ▼
if step == null: finalize (gate → ready)
else: runOneStep(task, project, step, plan)
    │
    ▼
(within runOneStep → applyGate → may reopen steps)
    │
    ▼
Loop back to next tick
```

### Phase 2: System Network Updates

The seeded system networks created by `flowToGraph()` use `{ type: "always" }` conditions on all edges. This means after Phase 2, system networks still behave linearly — every edge matches "always", so the first outgoing edge (the only one) is always followed. This is the desired backward-compatible behavior.

To take advantage of edge routing, users must duplicate a system network and add conditional edges in the editor.

### Phase 2: Edge Condition Editor (Minimum Viable)

To make edge conditions editable, we need a minimal UI. Since Phase 2 is about orchestration, not UI, the condition editor can be barebones:

- When an edge is selected in the editor, show a small properties panel.
- Allow editing: condition type dropdown, value/operator inputs (conditional on type).
- Default new edges to `{ type: "always" }`.

However, **this should be a separate Phase 3**. Phase 2 focuses on the orchestrator consuming edge conditions. The editor can create conditional edges programmatically (via import) for testing. The condition editor UI is a natural follow-up.

### Phase 2: File Change Summary

| File | Description |
|------|-------------|
| `server/src/orchestrator.ts` | Add `evaluateEdgeCondition()`, `buildEdgeContext()`, `nextStep()` (replaces `nextPending` in tick), extend `RefinementPlan` with `networkId`/`nodeIdByRole`/`nodeIds`, update `planFromTemplate()` to store graph info, update `tickOnce()` to use edge-aware routing |
| `server/src/roles.ts` | (no changes needed — system networks already have edges) |
| `client/src/api.ts` | Ensure `RefinementPlan` type exported to client includes optional `graph` fields (if we expose plan to UI) |
| `server/src/db.ts` | (no changes needed — network_id already links tasks to networks) |

### Phase 2: Testing Checklist

- [ ] System network task follows linear order (backward compatibility)
- [ ] Network with `{ type: "always" }` edges follows node array order
- [ ] Network with conditional verdict edge routes correctly on matching verdict
- [ ] Network with conditional verdict edge falls back to linear on non-matching verdict
- [ ] Network with coverage-based edge routes correctly (e.g., security not covered → route to security_review)
- [ ] Network with criteria-based edge routes correctly (e.g., unmet criterion → route to owner)
- [ ] Reviewer gate still works with edge routing (loopback → re-opened steps → edge routing picks next)
- [ ] `network_id` stored on plan is read correctly on subsequent ticks
- [ ] Interventions (inject_role, rerun_role) compose with edge routing
- [ ] No pending steps → task finalizes to ready
- [ ] Edge conditions survive plan serialization/deserialization (if stored in plan) or are re-read from network
- [ ] Existing tests pass (orchestrator.test.ts)

---

## Implementation Order

1. **Phase 1** — Editor edge UX (this pass)
2. **Phase 2** — Edge-aware orchestration (next pass)
3. **Phase 3 (future)** — Edge condition editor UI in the network editor