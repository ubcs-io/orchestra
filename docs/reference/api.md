# API Reference

REST is served under `/api`; live streams are SSE. Safety/dev controls are under `/api/safety`.

There is **no authentication** — see [Deployment](/guide/quick-start#deployment) — so treat network reachability as the entire trust boundary.

## Health & Discovery

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness check. |
| GET | `/api/models` | Discover model IDs from the connected endpoint's `/models` route. |
| POST | `/api/models/discover` | Discover models from a caller-supplied endpoint. Body: `{ base_url, api_key? }`. Used by the model-config setup flow. |
| GET | `/api/concerns` | The concern taxonomy (coverage map dimensions). |
| GET | `/api/flows` | Flow templates per intake kind (steps, criteria, rigor). |
| GET | `/api/watchers` | The [watcher registry](/guide/autonomy#the-watcher-catalog) this build can actually run. |
| GET | `/api/summary` | Cross-project dashboard rollup: task counts by stage, in-flight count, action items, blockers, and the list of tasks parked awaiting a human. |
| POST | `/api/dialogs/folder` | Open the OS folder picker on the machine running the daemon (project registration convenience). |

## Configuration

| Method | Path | Purpose |
|---|---|---|
| GET · PATCH | `/api/config` | Global connection profile (base URL, model, reasoning, thinking, text/two-phase mode). |
| POST | `/api/config/probe-structured-outputs` | Probe the configured endpoint for [constrained-decoding support](/reference/reliability#constrained-decoding) — `json_object`, `json_schema`, `guided_json`, `grammar` — and cache the result. |

## Model Configs & Stats

Named model configs are reusable endpoint + model profiles, separate from (and additional to) the single global connection profile — a role or project opts into one by referencing its `name`. See [Configuration](/reference/config) for the field reference.

| Method | Path | Purpose |
|---|---|---|
| GET · POST | `/api/model-configs` | List all model configs / create one. |
| GET · PATCH · DELETE | `/api/model-configs/:id` | Get / update / delete a model config. |
| POST | `/api/model-configs/:id/duplicate` | Duplicate a config (optionally with a new name). |
| POST | `/api/model-configs/:id/set-default` | Set a config as the global default. |
| POST | `/api/model-configs/reorder` | Reorder configs — body `{ "ids": [3, 1, 2] }`. |
| POST | `/api/model-stats` | Radar/stats-table data per config: context window, max tokens, reasoning, quantization score, dense and MoE-aware parameter counts, estimated cost per 1M tokens, and historical usage from actual role-run history. |
| GET | `/api/ping-model/:id` | Connectivity check for one config. Returns `{ config_id, available, error? }`. |
| GET | `/api/ping-network/stream` | SSE: connectivity check against every configured endpoint, streaming `checking → ok/down` per node. |

## Model Capability Profiles

Measured per `(connection, model)` pair — see [Reliability & Model Profiles](/reference/reliability#model-capability-profiles).

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/model-profiles` | Every stored profile. |
| GET | `/api/model-configs/:id/profile` | The profile for one config, refreshed on read. Returns `{ profile: null, effective: null }` (not a 404) when never probed. |
| GET | `/api/model-configs/:id/probe-profile/stream` | SSE: run the behavioral probe suite (~20 small requests), then derive and persist the profile. `?reset=1` discards imported overrides for a fully-measured result. |
| PATCH | `/api/model-configs/:id/profile/overrides` | Replace the override bag (`{}` or `null` clears it), then re-derive. Accepts `runShape`, `verdictDelivery`, `toolCapable`, `reasoning`, `supportsDeveloperRole`, `supportsReasoningEffort`, `maxTokensField`. |
| DELETE | `/api/model-configs/:id/profile` | Forget the profile; resolution falls back to hand flags until the next probe. |

## Roles

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/roles` | List all roles, global + merged with a project's overrides if `?project_id=` is given. Powers the network editor's role palette. |
| GET | `/api/roles/stats` | Per-role-key usage aggregated across projects: `total_calls`, `pass_count`, `counter_reviewer_passes`, `network_count`, `total_tokens`. |
| GET | `/api/stats/health` | [Run-health](/reference/reliability#run-health) rollups. `?groupBy=model` (default) `\|role\|mode`; `mode` buckets by `verdict_source`. |

## Scheduler

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/scheduler` | Status: `{ running, stopping }`. |
| POST | `/api/scheduler/start` · `/api/scheduler/stop` | Start / stop the loop. Drives the task scheduler and the [watcher loop](/guide/autonomy#the-watcher-loop) in lockstep. |
| POST | `/api/tick` | Trigger a single manual scheduler tick. |

## Projects

| Method | Path | Purpose |
|---|---|---|
| GET · POST | `/api/projects` | List / create projects. |
| GET · PATCH · DELETE | `/api/projects/:id` | Get / update / delete a project. |
| GET | `/api/projects/:id/roles` | Per-project role overrides. |
| PUT | `/api/projects/:id/roles/:key` | Override a role for this project (prompt, tools, model, enabled). A `tools_json` naming `write`/`edit`/`run_command` is rejected unless the harness policy allows it. Records a [role version](/reference/roles#version-history-outcome-scoring) when the prompt, tools, or model actually change; optional `version_note` annotates it. |
| GET | `/api/projects/:id/roles/:key/versions` | [Version history + per-version outcome scores](/reference/roles#version-history-outcome-scoring). Returns `{ role_id, is_project_override, current_version_id, min_runs_for_confidence, versions, scores }`. |
| POST | `/api/projects/:id/roles/:key/versions/:versionId/revert` | Revert to an earlier version by recording a **new** version matching it — history is never rewritten. Rejected if the old definition's tools would violate today's harness policy. |
| POST | `/api/projects/:id/intake` | Submit a raw intake (writes into `INTAKE/`). `{"review": true}` holds it for [pre-flight review](/guide/intake-review) instead of starting its flow; omitted follows the project default. |
| POST | `/api/projects/:id/tasks/bulk-wontdo` | Close many tasks as won't-do. Body `{ task_ids }`. Watcher-originated tasks also get their candidate fingerprint suppressed. |
| POST | `/api/projects/:id/tasks/bulk-delete` | Hard-delete tasks and their worktrees ("clean slate"). Body `{ task_ids }`. |

### Policy & autonomy

| Method | Path | Purpose |
|---|---|---|
| GET · PATCH | `/api/projects/:id/harness-policy` | [Write/exec policy](/guide/execution): `allowWrite`, `allowExec`, `execAllowlist`, `execTimeoutMs`, `execMaxOutputBytes`, `execMaxRuns`, `execEnv`. Partial patch; at least one field required. |
| GET · PATCH | `/api/projects/:id/autonomy` | [Watcher scheduling config](/guide/autonomy#configuration). Patches merge over the resolved config. Disabling aborts any in-progress scan. |
| GET · PATCH | `/api/projects/:id/autonomy-level` | [`plan` / `edit` / `auto`](/guide/execution#autonomy-levels) — how far a task may progress unattended. Unrelated to `/autonomy` above. |
| GET · PATCH | `/api/projects/:id/planning-rigor` | `minimal` / `standard` / `thorough` — scales the family decomposition budget. |
| GET · PATCH | `/api/projects/:id/intake-review` | Whether intakes go through [pre-flight review](/guide/intake-review) by default. Body `{ "default": "on" }` or `{ "default": "off" }`. |
| GET · PATCH | `/api/projects/:id/budget` | [Spend ceiling](/reference/config#spend-ceilings): `enabled`, `periodDays`, `capTokens`, `capUsd`, `warnThresholdPct`, `overrideMinutes`. Returns both the `policy` and the live `status` (spend so far, usage %, whether it's over cap). Patches merge over the resolved policy; `null` clears a cap. Enabling with no cap set is rejected. |
| GET | `/api/projects/:id/candidates` | Watcher candidates. `?status=`, `?limit=`. |
| GET | `/api/projects/:id/autonomy/budget` | Live idle-window budget consumption vs. limits. |
| GET | `/api/projects/:id/morning-report` | The [morning report](/guide/autonomy#the-morning-report). `?sinceHours=` (1–720, default 24). Returns `{ report, markdown, sinceHours }`. |
| GET | `/api/projects/:id/unseen-tasks` | Self-generated tasks no human has opened yet. |

## Tasks

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/tasks` | List tasks. `?projectId=`, `?stage=`. Each row carries `degraded_runs` and `latest_health`. |
| GET | `/api/tasks/:id` | Task detail (runs, coverage, plan, children, flow). |
| POST | `/api/tasks` | Create a manual task (no repo file). |
| PATCH | `/api/tasks/:id` | Edit name/content while in intake stage. |
| DELETE | `/api/tasks/:id` | Delete a task (and its worktree). |
| POST | `/api/tasks/:id/reset` | Reset to intake state, clearing history. |
| POST | `/api/tasks/:id/restore` | Roll back to the git checkpoint left by one of this task's own runs. Body `{ "role_run_id": <id> }`. Discards later runs and unconsumed interventions, resets the plan/stage, and hard-resets the branch to that commit. Only valid for a `primary` run with a recorded `git_commit_sha`. |
| GET | `/api/tasks/:id/intake-proposal` | The [intake review](/guide/intake-review) proposal plus what the card needs to render it: `{ state, proposal, networks, roles, intake_kinds, budget_preview }`. |
| POST | `/api/tasks/:id/intake-proposal/accept` | Accept the proposal and release the task. Optional body `{ proposal }` carries the human's edits; omitted accepts it as proposed. |
| POST | `/api/tasks/:id/intake-proposal/skip` | "Start as-is" — abandon the review and run the intake exactly as filed. |
| POST | `/api/tasks/:id/subtasks` | Create a child task under a parent. |
| POST | `/api/tasks/:id/questions/decompose` | Spin an open question into its own child **Question Flow** subtask. Body `{ role_key, question }`. Idempotent per question; returns `{ task, created }`. |
| POST | `/api/tasks/:id/chat` | Free-text follow-up against a task, persisted to `task_chat_messages`. |
| POST | `/api/tasks/seen` | Mark self-generated tasks as seen. Body `{ taskIds }`. First-write-wins. |

### Diffs, push & PR

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/tasks/:id/diff` | File-level diff of the task branch against its base (GitHub "compare" semantics). |
| GET | `/api/tasks/:id/diff/file` | Unified patch for one file. `?path=`, `?oldPath=`. |
| GET | `/api/tasks/:id/runs/:runId/diff` | The same view scoped to a single role run's checkpoint. |
| GET | `/api/tasks/:id/runs/:runId/diff/file` | Unified patch for one file within that run's diff. |
| POST | `/api/tasks/:id/github/push` | Push the task branch to GitHub. Requires a per-project or fallback token. |
| POST | `/api/tasks/:id/github/pr` | Push and open a PR against the task's base branch; the PR URL is stored on the task. |

## Interventions

All interventions use `POST /api/tasks/:id/interventions` with `{ "kind": "...", "payload": { ... } }`:

```json
{
  "kind": "inject_role",
  "payload": { "role": "privacy_review" }
}
```

| Kind | Payload | Purpose |
|---|---|---|
| `pause` | — | Pause at the next role boundary. |
| `resume` | — | Resume a paused task. |
| `deepen` | `{ role }` | Re-queue a role with an extra depth level. |
| `inject_role` | `{ role, after? }` | Insert a one-off role into the plan. |
| `steer_note` | `{ text }` | Add a note to upcoming role context. |
| `pin_question` | `{ text }` | Pin a question for upcoming roles to address. |
| `promote_role` | `{ role }` | Promote an injected role to standing project policy. |
| `run_now` | — | Process this task immediately, bypassing the idle poll. |
| `wont_do` | — | Close as won't-do: `stage: "ready"`, `exit_state: "wont_do"`, paused. Suppresses the candidate fingerprint for watcher-originated tasks. |
| `question_answer` | `{ role_key, question, answer }` | Answer an open question. At `stage: "review"` this triggers [answer reincorporation](/reference/config#strategic-llm-routing-advisors) immediately rather than waiting for a scheduler pass. |
| `approve_merge` | — | Approve a `code_change` task's branch and merge it into base. Handled immediately — a review-stage task has no scheduler pass coming. |
| `request_changes` | `{ note? }` | Send a `code_change` task back for rework instead of merging. |
| `set_autonomy_level` | `{ level }` | Per-task `plan`/`edit`/`auto` override. `null` clears it (inherit the project default). |
| `set_planning_rigor` | `{ rigor }` | Per-task `minimal`/`standard`/`thorough` override. `null` clears it. |
| `resume_over_budget` | — | Let this one task keep running past the project's [spend ceiling](/reference/config#spend-ceilings), for `overrideMinutes`. Deliberate and logged — never an auto-continue. Rejected if the project has no budget enabled. |

## Networks

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/networks` | List networks (system + custom). `?project_id=` filters to project scope + global system. |
| GET | `/api/networks/default` | The default network for an intake kind. Query: `intake_kind` (required), `project_id`. |
| POST | `/api/networks` | Create a custom network. |
| GET | `/api/networks/:id` | Get one network. |
| PUT | `/api/networks/:id` | Update a custom network. |
| DELETE | `/api/networks/:id` | Delete a custom network. |
| POST | `/api/networks/:id/duplicate` | Duplicate a network (custom or system). |
| POST | `/api/networks/:id/set-default` | Set as default for its intake kind. |
| POST | `/api/networks/import` | Import a network from JSON. |
| GET | `/api/networks/:id/export` | Export a network as JSON. |

## SSE

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/tasks/:id/stream` | Live role/tool/text events for a task. |
| GET | `/api/tasks/:id/network-ping/stream` | Connectivity check scoped to the models this task would use. |
| GET | `/api/ping-network/stream` | Endpoint connectivity across every model config. |
| GET | `/api/model-configs/:id/probe-profile/stream` | Capability-probe progress. |

The task stream emits typed events — role/tool boundaries, streaming thinking and text deltas, status updates, and `recap_start`/`recap_end` around artifact recap generation. Connect with native `EventSource`:

```js
const es = new EventSource("/api/tasks/:id/stream");
es.addEventListener("role", (e) => { /* role started/completed */ });
es.addEventListener("tool", (e) => { /* tool call made */ });
es.addEventListener("text", (e) => { /* streaming text delta */ });
```

::: tip Why GET for probes
`EventSource` cannot issue a POST, so every stream — including the ones that perform work, like the probe suite — is a GET by convention.
:::

## Safety

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/safety` | Agent boundaries, limits, gates, role summary, and `harness_policy` — which projects have write/exec enabled, which roles hold those tools, and whether source-code writes are possible at all. Also carries `budget_policy` (per-project [spend ceilings](/reference/config#spend-ceilings) and live consumption) and `secrets` ([which secrets exist and how old they are](/reference/config#secrets-at-rest) — never a value). |
| PATCH | `/api/safety` | Edit mutable safety fields. Currently `role_tool_budget` only. |
| DELETE | `/api/safety/secrets/github/:projectId` | Drop Orchestra's copy of a project's GitHub PAT. Does **not** revoke it on GitHub. |
