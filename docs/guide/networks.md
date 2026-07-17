# Agent Networks

Beyond the built-in flow templates, you can author custom **agent networks** — visual graphs that define how the orchestrator routes work through role agents.

Networks replace a flow template's ordered list with a directed graph of **nodes** (roles) and **edges** (transitions), giving you full control over branching, parallelism, and gating logic.

## Visual Editor

Access the editor at `/networks` in the UI. It provides:

- A **role palette** — drag any of the 24 roles onto the canvas
- **React Flow canvas** with snap-to-grid positioning
- **Edge connections** — click-drag from a node's output handle to another node's input handle
- **Per-network metadata** — intake kind, rigor level, max loopbacks, reviewer role, review depth
- **In-place role editing** — click a node's person icon to open a role editor modal (enabled state, subtask creation, tools, model override, system prompt) without leaving the canvas

![Agent network editor — drag-and-drop role graph with edge conditions and per-role tool boundaries](/screenshots/network-view.png)

## System Templates

Orchestra ships with pre-configured networks for common intake kinds:

- `bug` — intake triage → explorer → bug investigator → architecture review → test strategy → bug review → decomposition
- `feature` — intake triage → requirements analyst → explorer → architecture review → api design → data schema review → security review → test strategy → spec review → decomposition
- `security` — intake triage → explorer → security review → privacy review → architecture review → test strategy → adversarial security review → decomposition
- `research` — intake triage → user research → options exploration → edge case analysis → brief review → research synthesis

System networks are **read-only**. To customize one, duplicate it first.

## Custom Networks

Create networks from scratch or duplicate a system template. Custom networks are fully editable:

- **Add/remove roles** — drag new roles from the palette, delete nodes from the canvas
- **Rewire edges** — change the flow of work through the graph
- **Adjust rigor** — set `low`, `standard`, or `high` for the entire network
- **Set as default** — mark a network as the default for its intake kind
- **Project-scoped duplication** — duplicate a network directly into a specific project (or leave it global), assigned via a project-select modal shown when creating or duplicating

When a network is set as default for an intake kind, the orchestrator uses it instead of the built-in flow template for all matching intakes.

### Critique on network nodes

Networks carry the same cross-cutting critique support as the built-in flows: each node has a `critics: string[]` field (defaulting to `["critic"]` on non-terminal, non-reviewer nodes), and the network's `metadata.reviewDepth` (`none` / `terminal_only` / `every_step`) controls how broadly it's applied. See [Roles Catalog — Cross-Cutting Critique](/reference/roles#cross-cutting-critique) for what the `critic` role actually checks.

## Import / Export

Networks can be exported to and imported from JSON, making them portable across projects and Orchestra instances:

- **Export** — from the canvas toolbar, downloads a `.json` file
- **Import** — via the API endpoint `POST /api/networks/import`

## Network Resolution

When a task enters the orchestrator:

1. The orchestrator looks up the intake kind
2. If a custom network is set as **default** for that intake kind, it's loaded
3. Otherwise, the built-in flow template is used as a fallback

Networks are stored in SQLite alongside projects.

## API

All network operations are available via the REST API. See the [API Reference](/reference/api) for full details.