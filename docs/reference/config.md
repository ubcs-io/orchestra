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

## Model Recommendations

::: tip Prefer a tool-capable model
Roles use pi's function calling to read the repo and record findings. A model without tool support falls back to reasoning over pre-packed context.
:::

If your model's native tool calling (`record_findings`) is unreliable, enable **`twoPhase` mode** in the connection profile. This splits each role run into two phases:

1. **Exploration** — the model uses built-in tools freely, then writes a natural-language summary
2. **Formalization** — the model formalizes its findings as structured JSON (no tools required)

Set `twoPhase: true` in the Settings UI or via `PATCH /api/config { "twoPhase": true }`.