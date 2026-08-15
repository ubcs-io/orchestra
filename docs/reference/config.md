# Configuration

Orchestra has three configuration layers:

1. **Bootstrap config** (`config.json` + `ORCHESTRA_*` env vars) — the static seed used on first boot
2. **Runtime-editable connection profiles** — stored in SQLite, editable via `PATCH /api/config` and the Settings UI
3. **Per-project settings** — stored as JSON on the project row, covering harness policy, autonomy, and rigor

## Resolution Order

Lowest → highest precedence:

1. Built-in defaults
2. `config.json` (repo root, gitignored)
3. DB global profile
4. DB project override
5. `ORCHESTRA_*` environment variables

`baseUrl` and `apiKey` always prefer env vars over DB values (so credentials can stay out of the database).

The Settings UI's **Pi Dev Controls** panel is a live view onto these boundaries and limits — what the agent harness can and cannot do. The editable limits are enforced by the orchestrator, not merely suggested:

![Pi Dev Controls — agent tool boundaries, configurable limits, and gate/review settings](/screenshots/settings.png)

---

## Bootstrap Config (`config.json`)

| Key | Env Var | Default | Meaning |
|---|---|---|---|
| `host` | `ORCHESTRA_HOST` | `0.0.0.0` | Bind interface. |
| `port` | `ORCHESTRA_PORT` | `5001` | HTTP port (UI + API + SSE). |
| `providerBaseUrl` | `ORCHESTRA_BASE_URL` | `http://192.168.1.2:8080/v1` | OpenAI-compatible **base** URL. |
| `apiKey` | `ORCHESTRA_API_KEY` | `""` | Bearer token. |
| `githubToken` | `ORCHESTRA_GITHUB_TOKEN` | `""` | Fallback GitHub PAT for pushing task branches / opening PRs, used when a project has no token of its own. |
| `defaultModelId` | `ORCHESTRA_MODEL` | `deepseek-r1:latest` | Default model. |
| `contextWindow` / `maxTokens` | `ORCHESTRA_MAX_TOKENS` | `128000` / `32768` | Advertised to pi. |
| `reasoning` | `ORCHESTRA_REASONING` | `true` | Whether the model is a reasoning model. Set `false` for plain instruct models. |
| `thinkingLevel` | `ORCHESTRA_THINKING_LEVEL` | `medium` | pi thinking verbosity: `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `thinkingFormat` | `ORCHESTRA_THINKING_FORMAT` | `qwen-chat-template` | pi reasoning dialect: `qwen-chat-template`, `qwen`, `deepseek`, `zai`, `openai`, `openrouter`, `together`, `string-thinking`, `chat-template`, `ant-ling`. |
| `requestTimeoutMs` | `ORCHESTRA_REQUEST_TIMEOUT_MS` | `300000` | Idle/heartbeat timeout for a role's LLM call — a watchdog reset on every streamed event, not a flat duration cap, so a long-but-active run never trips it. |
| `dbPath` | `ORCHESTRA_DB_PATH` | `./orchestra.db` | SQLite file path (WAL). |
| `schedulerIdleMs` | `ORCHESTRA_SCHEDULER_IDLE_MS` | `3000` | Idle poll interval (ms), for both the task scheduler and the watcher loop. |
| `roleToolBudget` | — | `40` | Max tool-calling turns per role run. |
| `maxConcurrentTasks` | `ORCHESTRA_MAX_CONCURRENT_TASKS` | `3` | Max tasks the scheduler runs role-steps for concurrently, each in its own [git worktree](/guide/how-it-works#git-isolation-concurrency). Bounded by the disk/IO cost of N full checkouts, not just CPU. |
| `clientDir` | — | `<server>/public` | Built SPA directory served in production. |
| `tokenMap` | `ORCHESTRA_TOKENS` | `{}` | Per-model-config API keys as a JSON object keyed by config **name**, e.g. `'{"qwen-7b":"sk-abc"}'`. An entry here overrides that config's DB-stored key, so secrets can stay out of the database. |

---

## Runtime Connection Profiles

Stored in SQLite and editable at runtime via `PATCH /api/config` or the **Settings UI**. These take precedence over `config.json` (except where env vars win).

| Field | Default | Description |
|---|---|---|
| `baseUrl` | (from `config.json`) | OpenAI-compatible base URL. |
| `apiKey` | (from `config.json`) | Bearer token. |
| `api` | `openai-completions` | Provider API type. |
| `defaultModelId` | (from `config.json`) | Model ID for roles. |
| `contextWindow` / `maxTokens` | (from `config.json`) | Advertised to pi for the local model. |
| `requestTimeoutMs` | (from `config.json`) | Per-request LLM timeout (ms). |
| `reasoning` | (from `config.json`) | Whether the model is a reasoning model. |
| `thinkingLevel` | (from `config.json`) | pi thinking verbosity. |
| `thinkingFormat` | (from `config.json`) | pi reasoning dialect. |
| `textMode` | `false` | Bypass native tool calls; JSON output via markdown. |
| `twoPhase` | `false` | Split run: exploration + formalization. Supersedes `textMode`. |

::: tip These two flags are now measured, not guessed
`textMode` and `twoPhase` were hand-set answers to "how badly does this model handle tool calls?". Once a model has been probed, that question is answered by its [capability profile](/reference/reliability#model-capability-profiles) — as a `runShape` of `single-turn`, `two-turn`, or `text` — and the hand flags survive only as imported overrides you can clear. Set them by hand for a model you haven't probed; probe the model if you'd rather not.
:::

---

## Named Model Configs

Beyond the single global connection profile, Orchestra supports named **model configs** — reusable endpoint + model profiles managed at `/models` in the UI and via `/api/model-configs*`. A role or project opts into one by putting the config's `name` in its `model` field; the orchestrator then uses that config's own `base_url` / `api_key` / mode settings and model ID for the run instead of the global profile. Keys can live in the DB per config, or come from `ORCHESTRA_TOKENS` keyed by config name.

Each config additionally stores:

| Field | Description |
|---|---|
| `context_window` / `max_tokens` | Advertised to pi for this specific endpoint. |
| `thinking_budgets` | Per-thinking-level token budgets. |
| `ordering` | Drag-and-drop priority position (`POST /api/model-configs/reorder`). |
| `structured_outputs_json` | Cached [constrained-decoding probe](/reference/reliability#constrained-decoding) results for this endpoint. |
| `compat` | `supportsDeveloperRole`, `supportsReasoningEffort`, `maxTokensField`, `chatTemplateKwargs`, and stall-nudge thresholds. Superseded by measured profiles where one exists. |

`POST /api/model-stats` returns comparison data across configs — context window, max tokens, reasoning, quantization score, dense/MoE-aware parameter counts, estimated cost per 1M tokens, and historical usage from actual role-run history — rendered as a radar chart plus a sortable table. **Ping Network** (`GET /api/ping-network/stream`) streams live availability for every configured endpoint.

![Coverage radar and model comparison table across context window, params, quantization, and usage](/screenshots/model-radar.png)

---

## Per-Project Settings

A project's `config_json` holds nine independent sub-keys. The first six have their own endpoint with shape validation — deliberately **not** the generic `PATCH /api/projects/:id`, so a malformed config body can't silently widen a policy that gates filesystem writes, command execution, or spend.

| Sub-key | Endpoint | Governs |
|---|---|---|
| `harness` | `/api/projects/:id/harness-policy` | [Write and exec capability](/guide/execution): `allowWrite`, `allowExec`, the command allowlist, and its timeouts/caps. Both default off. |
| `autonomy` | `/api/projects/:id/autonomy` | [Watcher scheduling](/guide/autonomy#configuration): the kill switch, active hours, idle threshold, queue depth, budgets, the watcher menu, and self-maintenance. Defaults off. |
| `autonomyLevel` | `/api/projects/:id/autonomy-level` | [`plan` / `edit` / `auto`](/guide/execution#autonomy-levels) — how far a task may progress unattended. Defaults `edit`. |
| `planningRigor` | `/api/projects/:id/planning-rigor` | `minimal` / `standard` / `thorough`. Defaults `standard`. |
| `budget` | `/api/projects/:id/budget` | The [spend ceiling](#spend-ceilings) below: token and/or dollar caps over a rolling window. Defaults off. |
| `intakeReview` | `/api/projects/:id/intake-review` | Whether intakes go through [pre-flight review](/guide/intake-review) by default: `{"default": "on" \| "off"}`. Defaults `off` — the "Review intake" button is then the only way in. |
| `router` | (project `config_json`) | The [LLM routing advisors](#strategic-llm-routing-advisors) below. All off by default. |
| `requireHealthyTerminal` | (project `config_json`) | When `true`, a `degraded`/`empty` terminal run loops back and then escalates instead of promoting the task to READY. Defaults `false`. See [where health is enforced](/reference/reliability#where-health-is-enforced). |
| `contextBudget` | (project `config_json`) | When `true`, the [budgeted, tier-degraded prompt](/reference/reliability#context-budgeting) is what gets sent. Defaults `false` — shadow mode, which measures without changing behavior. |

The last two have no dedicated endpoint; set them through `PATCH /api/projects/:id` with the rest of `config_json`.

::: warning Two settings named "autonomy"
`autonomy` and `autonomyLevel` are unrelated axes that happen to share a word. `autonomy` decides **whether the system may generate and schedule its own work**; `autonomyLevel` decides **how far any single task may go before a human is required**. Turning one on says nothing about the other.
:::

### Planning rigor & effort sizing

Two orthogonal inputs bound how much structure a task's decomposition produces. **Effort size** answers "how big is this really" — the `explorer` role sets it on the task after actually reading the files. **Planning rigor** answers "how much process do you want per unit of size".

| Effort size | Max subtasks | Max depth |
|---|---|---|
| `XS` | 0 | 0 |
| `S` | 4 | 1 |
| `M` | 12 | 2 |
| `L` | 30 | 3 |
| `XL` | 60 | 4 |

Rigor scales the subtask count: `minimal` ×0.6, `standard` ×1, `thorough` ×1.5. Depth is unaffected. A task with no recorded size falls back to `M` — safer than either extreme.

`XS` is special: it means "no decomposition at all", and (unless rigor is `thorough` or autonomy level is `plan`) routes the task straight to the [execution flow](/guide/execution#how-a-task-reaches-execution) instead of walking the full planning gauntlet.

Both are overridable per task via the `set_planning_rigor` and `set_autonomy_level` interventions.

---

## Spend Ceilings

Orchestra has always recorded `role_runs.tokens` on every run and carried `$/1M` pricing on named model configs — but nothing compared either against a limit, so a task that looped through more loopbacks, critiques and resumes than expected simply spent until someone noticed. The `budget` sub-key closes that.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | The switch. Off means no ceiling is ever consulted. |
| `periodDays` | `30` | Rolling window that spend is summed over. Not a calendar period — it's always "the last N days". |
| `capTokens` | unset | Token ceiling. **Always enforceable**, with or without pricing data. |
| `capUsd` | unset | Dollar ceiling. Only meaningful once model configs carry `cost_per_1m_input` / `cost_per_1m_output`. |
| `warnThresholdPct` | `80` | Percent of a cap at which a non-blocking notice fires, deduped to once per period. |
| `overrideMinutes` | `60` | How long a `resume_over_budget` grant lasts. |

Enabling the budget with **neither** cap set is rejected: a policy that reads as "budgeted" everywhere while stopping nothing is worse than one that's plainly off.

### What happens at the cap

The check runs at task-selection time, not inside a running step. An in-flight role run always finishes and is always paid for — the ceiling blocks the **next** dispatch. That matches the existing pause/resume semantics rather than inventing an abort path mid-run.

A stopped task gets `budget_paused_at` set, which is deliberately **not** the existing `paused` flag: "I paused this" and "the budget stopped this" have to stay tellable apart. It also clears itself — once spend ages out of the rolling window, or you raise the cap, the task is released with no human action.

To run past the cap anyway, use the `resume_over_budget` intervention. It's logged like any other steering action and bounded to `overrideMinutes`, because a rolling window has no period boundary for an unbounded grant to expire at. It's per-task: overriding one task doesn't exempt its siblings.

### Why dollar figures are estimates

`role_runs.tokens` is a single **combined** input+output count, but pricing is per-direction. Converting therefore assumes a split — Orchestra assumes 15% output, since its runs are read-heavy (a large assembled context against a comparatively short findings report).

Separately, runs on a model with no configured price contribute **tokens but no dollars**. When that happens the response sets `usdIsPartial` and reports `unpricedTokens`, and the UI renders `≥ $X` rather than `$X`. The dollar figure is a floor, never a silently under-reported total — which is also why crossing the cap with it is always a real crossing and never a false positive.

::: tip Token caps need no pricing
A project pointed entirely at local models has no cost data and never will. `capTokens` is fully enforceable on its own — the dollar path is never a prerequisite for the token path.
:::

---

## Secrets at Rest

`projects.github_token` and `configs.api_key` are encrypted in the database with AES-256-GCM. Previously they were plain TEXT columns masked only on the API response — response hygiene, not storage security: anyone with a copy of `orchestra.db` (a backup, a synced folder, a `sqlite3` one-liner) had every credential in plaintext.

The instance key comes from `ORCHESTRA_SECRET_KEY` (32 bytes, hex or base64) if set, otherwise a key generated on first boot and written to `secret.key` beside `config.json` (mode `0600`, gitignored).

**Losing the key means the stored tokens become unreadable and must be re-entered.** Nothing else breaks — no data is lost and the daemon still starts. This is a cheap loss, but never a silent one: it's stated here, in the safety dashboard, and in the code.

Existing plaintext rows are upgraded transparently on first boot. The pass is idempotent (an already-encrypted value is skipped, never double-encrypted) and non-fatal: if a secret can't be read, it logs and reads as "not set" rather than taking the boot path down.

::: warning What this does and doesn't buy you
The database file is no longer self-describing, but the key sits next to it under the same trust tier as `config.json`. This defends against the DB leaving the machine — not against someone already on it as this user. To keep a key out of the DB entirely, use `ORCHESTRA_API_KEY` or [`ORCHESTRA_TOKENS`](#bootstrap-config-config-json).
:::

### Scoping

No role receives a secret in its run context. The GitHub PAT is used server-side by `github.ts` for pushes and PRs a human triggers — it is never handed to a model. `harness.secretScope` exists to make that default explicit and enforced rather than incidental; it ships as a documented no-op (empty = no role), so the day a role gains its own push capability the grant has to be written down rather than inherited by accident.

`GET /api/safety` reports which projects have a token set and when the row was last written; `DELETE /api/safety/secrets/github/:projectId` drops Orchestra's copy. Neither ever moves the value itself, and clearing does not revoke the token on GitHub.

---

## Strategic LLM Routing Advisors

`server/src/router.ts` provides seven **optional, narrowly-scoped advisory LLM calls** ("Call Points") layered on top of the deterministic orchestrator, for decision points where fixed heuristics are weakest. All are **off by default**; each has its own boolean, a hard per-call timeout, and falls back to the existing heuristic on failure, timeout, or when disabled — the orchestrator always makes and owns the final decision.

| `RouterConfig` field | Call Point | Decides |
|---|---|---|
| `enabled` | — | Master kill-switch; when `false`, every call point falls through to heuristics regardless of its own flag. |
| `questionDistillation` | 1 — Question Distillation | Distill and de-duplicate the open questions a role produced. |
| `escalationAssessment` | 2 — Escalation Assessment | Before escalating to human REVIEW: `escalate` \| `reroute` \| `rerun` \| `close`. |
| `borderlineGateAssessment` | 3 — Borderline Gate Assessment | For partial-criteria / near-loopback-exhaustion gate decisions: `loopback` \| `proceed` \| `proceed_with_note` \| `escalate` \| `narrow_loopback`. |
| `secondReview` | 4 — Second Review | After every step the [`critic`](/reference/roles#cross-cutting-critique) checks, authoritatively synthesize the primary run + critique into `accept` \| `accept_with_note` \| `escalate` \| `loopback`. |
| `answerReincorporation` | 5 — Answer Match Assessment | When a human answers an open question on a task already at `stage: "review"`, compare the answer against the role's recorded guess: `confirms` \| `contradicts`. A contradiction restores the task to that role's checkpoint and re-runs downstream steps with the correction. |
| `candidateTriage` | 6 — Candidate Triage | Whether a [watcher candidate](/guide/autonomy#candidates-triage) is worth doing, at what priority, as which intake kind. **Disabled means nothing is queued** — this call point fails toward silence, not toward auto-approval. |
| `intakePlanning` | 7 — Intake Planning | For an intake sent through [review](/guide/intake-review): which intake kind, which network, which ordered role plan, and how big the work really is. Disabled (or failed) still produces the review card — filled with the heuristic proposal, i.e. exactly what the task would have done without the review. |

Additional fields: `model` (override model for router calls), `maxTokens` (default `1024`), `timeoutMs` (default `15000`).

### Open questions carry a guess

Every open question a role records carries the role's own best-effort guess alongside it: `{ question, assumed_answer, confidence: "low" | "medium" | "high" }`. This lets the pipeline keep moving instead of stalling — `blocker`/`needs_human` verdicts are reserved for questions where no reasonable guess is possible at all. Once a human answers (via the `question_answer` intervention), the guess's `resolved` field becomes `confirmed` or `invalidated`, and Call Point 5 decides whether downstream work built on the guess needs redoing.

Router config is resolved from a project's `config_json`; omitted fields default to `false`/unset.

---

## Model Recommendations

::: tip Prefer a tool-capable model
Roles use pi's function calling to read the repo and record findings. A model without tool support falls back to reasoning over pre-packed context.
:::

If your model's native tool calling is unreliable, you have two options — and the second is usually better:

1. **Set `twoPhase: true`** in the connection profile, splitting each run into exploration (tools free) and formalization (structured output, no tools required).
2. **Probe the model** (`/models` → probe profile) and let Orchestra pick the run shape and verdict delivery mechanism from measurements, then keep adjusting as live runs accumulate. See [Reliability & Model Profiles](/reference/reliability).

Either way, a failed structured payload no longer costs you the role's analysis — [artifact-first output](/reference/reliability#artifact-first-output) means the write-up is already on disk.
