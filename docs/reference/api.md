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
| GET | `/api/ping-model/:id` | Check connectivity for a single model config's `/models` route. Returns `{ config_id, available, error? }`. |
| GET | `/api/ping-network/stream` | SSE: checks connectivity to every configured model endpoint's `/models` route and streams per-node `checking → ok/down` results as they resolve. Each config in the initial listing carries a `location` label (derived from its `base_url`, e.g. local/tailnet/cloud) alongside its name and base URL. |

## Roles

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/roles` | List all roles, global + merged with a project's overrides if `?project_id=` is given. Used by the network editor's role palette. |
| GET | `/api/roles/stats` | Per-role-key usage stats aggregated across all projects: `total_calls`, `pass_count`, `counter_reviewer_passes` (times a run's linked critique/second-review passed), `network_count` (how many agent networks include the role), `total_tokens`. Powers the call/pass/review/nets/tokens pills on the Roles Editor. |

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
| POST | `/api/tasks/:id/restore` | Roll a task back to the git checkpoint left by one of its own role runs. Body: `{ "role_run_id": <id> }`. Discards every `role_runs` row (and any unconsumed interventions) created after that run, resets the task's plan/stage back to right after it, and hard-resets its checkpoint branch to that run's recorded commit. Only valid for a `primary` run that has a recorded `git_commit_sha`. |
| POST | `/api/tasks/:id/subtasks` | Create a child task under a parent. |
| POST | `/api/tasks/:id/questions/decompose` | Spin an open review question off into its own child **Question Flow** subtask. Body: `{ "role_key": "...", "question": "..." }`. Idempotent — re-submitting the same `role_key` + `question` for a task returns the existing child instead of creating a duplicate. Response: `{ task, created }`. |
| POST | `/api/tasks/:id/chat` | Send a free-text follow-up chat message against a task, persisted to `task_chat_messages`. Used by the inline decomposed-child preview so you can ask a quick question without navigating away. |

## Interventions

All interventions use `POST /api/tasks/:id/interventions` with a JSON body of `{ "kind": "...", "payload": { ... } }`:

```json
{
  "kind": "inject_role",
  "payload": { "role": "privacy_review" }
}
```

| Kind | Payload | Purpose |
|---|---|---|
| `pause` | — | Pause at next role boundary. |
| `resume` | — | Resume a paused task. |
| `deepen` | `{ role }` | Re-queue `role` to run again with an extra depth level. |
| `inject_role` | `{ role, after? }` | Insert a one-off role into the plan, immediately after step `after` (or before the terminal role if omitted). |
| `steer_note` | `{ text }` | Add a note to upcoming role context. |
| `pin_question` | `{ text }` | Pin a question for upcoming roles to address. |
| `promote_role` | `{ role }` | Promote an injected role to standing project policy. |
| `run_now` | — | Trigger immediate processing. |
| `wont_do` | — | Close the task as won't-do: sets `stage: "ready"`, `exit_state: "wont_do"`, and pauses it. |
| `question_answer` | `{ role_key, question, answer }` | Answer an open question a role raised. If the task is already at `stage: "review"` (no scheduler pass left to consume it), this triggers [answer reincorporation](/reference/config#strategic-llm-routing-advisors) directly instead of waiting: the `answerReincorporation` router call point compares the human answer against the role's recorded guess and, on a genuine mismatch, restores the task to right after that role and re-runs downstream steps with the corrected answer. No-op if that call point is disabled, the task isn't in `review`, or the question doesn't match a recorded guess. |

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