# Configuration

Orchestra has two configuration layers:

1. **Bootstrap config** (`config.json` + `ORCHESTRA_*` env vars) — the static seed used on first boot
2. **Runtime-editable connection profiles** — stored in SQLite, editable via `PATCH /api/config` and the Settings UI

## Resolution Order

Lowest → highest precedence:

1. Built-in defaults
2. `config.json` (repo root, gitignored)
3. DB global profile
4. DB project override
5. `ORCHESTRA_*` environment variables

`baseUrl` and `apiKey` always prefer env vars over DB values (so credentials can stay out of the database).

---

## Bootstrap Config (`config.json`)

| Key | Env Var | Default | Meaning |
|---|---|---|---|
| `host` | `ORCHESTRA_HOST` | `0.0.0.0` | Bind interface. |
| `port` | `ORCHESTRA_PORT` | `5001` | HTTP port (UI + API + SSE). |
| `providerBaseUrl` | `ORCHESTRA_BASE_URL` | `http://192.168.1.2:8080/v1` | OpenAI-compatible **base** URL. |
| `apiKey` | `ORCHESTRA_API_KEY` | `""` | Bearer token. |
| `defaultModelId` | `ORCHESTRA_MODEL` | `deepseek-r1:latest` | Default model. |
| `contextWindow` / `maxTokens` | `ORCHESTRA_MAX_TOKENS` | `128000` / `16384` | Advertised to pi. |
| `reasoning` | — | `true` | Whether the model is a reasoning model. |
| `thinkingLevel` | — | `medium` | pi thinking verbosity: `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `thinkingFormat` | — | `qwen-chat-template` | pi reasoning dialect: `qwen-chat-template`, `qwen`, `deepseek`, `zai`, `openai`, `openrouter`, `together`, `string-thinking`, `chat-template`, `ant-ling`. |
| `requestTimeoutMs` | `ORCHESTRA_REQUEST_TIMEOUT_MS` | `300000` | Per-request LLM timeout (ms). |
| `dbPath` | `ORCHESTRA_DB_PATH` | `./orchestra.db` | SQLite file path (WAL). |
| `schedulerIdleMs` | `ORCHESTRA_SCHEDULER_IDLE_MS` | `3000` | Idle poll interval (ms). |
| `roleToolBudget` | — | `40` | Max tool-calling turns per role run. |
| `clientDir` | — | `<server>/public` | Built SPA directory served in production. |

---

## Runtime Connection Profiles

These settings are stored in SQLite and editable at runtime via `PATCH /api/config` or the **Settings UI**. They take precedence over `config.json` (except where env vars win).

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

---

## Named Model Configs

Beyond the single global connection profile above, Orchestra supports named **model configs** — reusable endpoint + model profiles managed at `/models` in the UI and via `/api/model-configs*` (see [API Reference](/reference/api#model-configs-stats)). A role or project can opt into one by putting the config's `name` in its `model` field; if the name matches a config, the orchestrator uses that config's own `base_url`/`api_key`/`text_mode`/`two_phase`/compat settings and model ID for the run instead of falling back to the global profile. API keys can be stored per-config in the DB, or supplied via the `ORCHESTRA_TOKENS` env var keyed by config name (so secrets don't need to live in the database).

Each config additionally stores:

| Field | Description |
|---|---|
| `context_window` / `max_tokens` | Advertised to pi for this specific endpoint. |
| `thinking_budgets` | Per-thinking-level token budgets for this config. |
| `ordering` | Drag-and-drop priority position (set via `POST /api/model-configs/reorder`). |
| `compat` (tier-1 compat options) | `supportsDeveloperRole`, `supportsReasoningEffort`, `maxTokensField`, `chatTemplateKwargs` (raw JSON passed to the chat template), `nudgeThresholdChars` / `nudgeThresholdCharsTextMode` (stall-nudge thresholds for the agent loop) — quirks needed to get some local/OSS models behaving like a "tier-1" hosted model. |

`POST /api/model-stats` returns comparison data across all configs (or a subset) — context window, max tokens, reasoning, quantization score, dense/MoE-aware parameter counts, estimated cost per 1M input/output tokens, and historical usage (run count, total tokens, avg tokens/run) pulled from actual role-run history — rendered in the `/models` page as a radar chart plus a sortable stats table. The same page's **Ping Network** action (surfaced on the Projects page) hits every config's `/models` endpoint over `GET /api/ping-network/stream` and streams back live availability.

---

## Strategic LLM Routing Advisors

`server/src/router.ts` provides four **optional, narrowly-scoped advisory LLM calls** ("Call Points") layered on top of the deterministic orchestrator, for decision points where fixed heuristics are weakest. All four are **off by default**; each has its own boolean, a hard per-call timeout, and falls back to the existing heuristic default on failure, timeout, or when disabled — the orchestrator always makes and owns the final decision.

| `RouterConfig` field | Call Point | Decides |
|---|---|---|
| `enabled` | — | Master kill-switch; when `false`, all call points fall through to heuristics regardless of their own flags. |
| `questionDistillation` | 1 — Question Distillation | Distill and de-duplicate the open questions a role produced. |
| `escalationAssessment` | 2 — Escalation Assessment | Before escalating to human REVIEW: `escalate` \| `reroute` \| `rerun` \| `close`. |
| `borderlineGateAssessment` | 3 — Borderline Gate Assessment | For partial-criteria / near-loopback-exhaustion gate decisions: `loopback` \| `proceed` \| `proceed_with_note` \| `escalate` \| `narrow_loopback`. |
| `secondReview` | 4 — Second Review | After every step the [`critic`](/reference/roles#cross-cutting-critique) checks, authoritatively synthesize the primary run + critique into `accept` \| `accept_with_note` \| `escalate` \| `loopback`. |

Additional fields: `model` (override model for router calls, falls back to the project's connection default), `maxTokens` (default `1024`), `timeoutMs` (default `15000`).

Router config is resolved from a project's `config_json`; omitted fields default to `false`/unset (`DEFAULT_ROUTER_CONFIG`).

---

## Model Recommendations

::: tip Prefer a tool-capable model
Roles use pi's function calling to read the repo and record findings. A model without tool support falls back to reasoning over pre-packed context.
:::

If your model's native tool calling (`record_findings`) is unreliable, enable **`twoPhase` mode** in the connection profile. This splits each role run into two phases:

1. **Exploration** — the model uses built-in tools freely, then writes a natural-language summary
2. **Formalization** — the model formalizes its findings as structured JSON (no tools required)

Set `twoPhase: true` in the Settings UI or via `PATCH /api/config { "twoPhase": true }`.