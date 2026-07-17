# API Reference

REST is served under `/api`; the live stream is SSE. Safety/dev controls are under `/api/safety`.

## Health & Discovery

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness check. |
| GET | `/api/models` | Discover model IDs from the connected endpoint's `/models` route. |
| GET | `/api/concerns` | The concern taxonomy (coverage map dimensions). |
| GET | `/api/flows` | Flow templates per intake kind (steps, criteria, rigor). |

## Configuration

| Method | Path | Purpose |
|---|---|---|
| GET · PATCH | `/api/config` | Global connection profile (read/edit base URL, model, reasoning, thinking, text/two-phase mode). |

## Model Configs & Stats

Named model configs are reusable endpoint + model profiles, separate from (and additional to) the single global connection profile above — a role or project can opt into one by referencing its `name`. See [Configuration](/reference/config) for the field reference.

| Method | Path | Purpose |
|---|---|---|
| GET · POST | `/api/model-configs` | List all model configs / create a new one. |
| GET · PATCH · DELETE | `/api/model-configs/:id` | Get / update / delete a model config. |
| POST | `/api/model-configs/:id/duplicate` | Duplicate a config (optionally with a new name). |
| POST | `/api/model-configs/:id/set-default` | Set a config as the global default. |
| POST | `/api/model-configs/reorder` | Reorder configs — body `{ "ids": [3, 1, 2] }` in the desired order. |
| POST | `/api/model-stats` | Radar/stats-table data per config: context window, max tokens, reasoning, quantization score, parameter counts (dense and MoE-aware active/total), estimated cost per 1M tokens, and historical usage (runs, total tokens, avg tokens/run) aggregated from actual role-run history. |
| GET | `/api/ping-network/stream` | SSE: checks connectivity to every configured model endpoint's `/models` route and streams per-node `checking → ok/down` results as they resolve. |

## Scheduler

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/scheduler` | Scheduler status (running, idle). |
| POST | `/api/scheduler/start` | Start the scheduler loop. |
| POST | `/api/scheduler/stop` | Stop the scheduler loop. |
| POST | `/api/tick` | Trigger a single manual scheduler tick. |

## Projects

| Method | Path | Purpose |
|---|---|---|
| GET · POST | `/api/projects` | List all projects / create a new project. |
| GET · PATCH · DELETE | `/api/projects/:id` | Get / update / delete a project. |
| GET | `/api/projects/:id/roles` | Get per-project role overrides. |
| PUT | `/api/projects/:id/roles/:key` | Override a role's config for this project (prompt, tools, model, enabled). |
| POST | `/api/projects/:id/intake` | Submit a raw intake (writes into `INTAKE/` in the project repo). |

## Tasks

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/tasks` | List all tasks across projects. |
| GET | `/api/tasks/:id` | Get task detail (runs, coverage, plan, children, flow). |
| DELETE | `/api/tasks/:id` | Delete a task. |
| PATCH | `/api/tasks/:id` | Edit a task's name/content while in intake stage. |
| POST | `/api/tasks` | Create a manual task (without a repo file). |
| POST | `/api/tasks/:id/reset` | Reset a task to intake state (clears history). |
| POST | `/api/tasks/:id/subtasks` | Create a child task under a parent. |
| POST | `/api/tasks/:id/questions/decompose` | Spin an open review question off into its own child **Question Flow** subtask. Body: `{ "role_key": "...", "question": "..." }`. Idempotent — re-submitting the same `role_key` + `question` for a task returns the existing child instead of creating a duplicate. Response: `{ task, created }`. |
| POST | `/api/tasks/:id/chat` | Send a free-text follow-up chat message against a task, persisted to `task_chat_messages`. Used by the inline decomposed-child preview so you can ask a quick question without navigating away. |

## Interventions

All interventions use `POST /api/tasks/:id/interventions` with a JSON body:

```json
{
  "action": "inject_role",
  "roleKey": "privacy_review"
}
```

| Action | Body Fields | Purpose |
|---|---|---|
| `pause` | — | Pause at next role boundary. |
| `resume` | — | Resume a paused task. |
| `rerun_role` | — | Re-run the most recent role. |
| `deepen` | — | Re-run with extended tool budget. |
| `inject_role` | `roleKey` | Insert a one-off role into the plan. |
| `steer_note` | `note` | Add a note to upcoming role context. |
| `pin_question` | `question` | Pin a question for roles to address. |
| `promote_role` | `roleKey` | Promote an injected role to standing policy. |
| `run_now` | — | Trigger immediate processing. |
| `wont_do` | — | Close the task as won't-do: sets `stage: "ready"`, `exit_state: "wont_do"`, and pauses it. |

## Networks

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/networks` | List all networks (system + custom). |
| POST | `/api/networks` | Create a custom network. |
| GET | `/api/networks/:id` | Get a single network. |
| PATCH | `/api/networks/:id` | Update a custom network. |
| DELETE | `/api/networks/:id` | Delete a custom network. |
| POST | `/api/networks/:id/duplicate` | Duplicate a network (custom or system). |
| POST | `/api/networks/default/:intakeKind` | Set as default for an intake kind. |
| POST | `/api/networks/import` | Import a network from JSON. |
| GET | `/api/networks/export/:id` | Export a network as JSON. |
| POST | `/api/networks/:id/reset` | Reset a custom network to its original. |

## SSE

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/tasks/:id/stream` | Server-Sent Events: live role/tool/text events. |

The SSE stream emits typed events as the orchestrator works through a task — role/tool boundaries, streaming thinking and text deltas, status updates, and `recap_start`/`recap_end` around artifact recap generation. Connect with native `EventSource`:

```js
const es = new EventSource("/api/tasks/:id/stream");
es.addEventListener("role", (e) => { /* role started/completed */ });
es.addEventListener("tool", (e) => { /* tool call made */ });
es.addEventListener("text", (e) => { /* streaming text delta */ });
```

The `GET /api/ping-network/stream` endpoint (see [Model Configs & Stats](#model-configs-stats)) uses the same SSE mechanism to stream endpoint-connectivity results as they resolve.

## Safety

| Method | Path | Purpose |
|---|---|---|
| GET · PATCH | `/api/safety` | Safety/pi dev controls (read agent boundaries, limits, gates, role summary; edit `role_tool_budget`). |