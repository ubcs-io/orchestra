# Quick Start

Get Orchestra running in 5 minutes.

## Prerequisites

- **Node 20+**
- A **git repository** to point Orchestra at
- An **OpenAI-compatible LLM endpoint** (Ollama, LM Studio, vLLM, OpenWebUI, or a cloud provider)

## Installation

```bash
git clone https://github.com/ubcs-io/orchestra.git
cd orchestra
npm install
```

## Configuration

Copy the example config and set your LLM endpoint:

```bash
cp config.example.json config.json
```

Edit `config.json` with your values:

```json
{
  "providerBaseUrl": "http://localhost:11434/v1",
  "apiKey": "",
  "defaultModelId": "llama3.1:8b"
}
```

| Key | Meaning |
|---|---|
| `providerBaseUrl` | OpenAI-compatible **base** URL (not the `/chat/completions` path) |
| `apiKey` | Bearer token; leave empty for local endpoints without auth |
| `defaultModelId` | The model to use for all roles (can be overridden per project) |

> **Prefer a tool-capable model.** Roles use function calling to read your repo. If your model's tool calling is unreliable, enable `twoPhase` mode in the Settings UI.

All configuration options are documented in the [Configuration reference](/reference/config).

## Start the Dev Server

```bash
npm run dev
```

This starts:
- **Fastify daemon** on `http://localhost:5001` (API + SSE)
- **Vite dev client** on `http://localhost:5173` (proxies `/api` to the daemon)

Open `http://localhost:5173` in your browser.

## First Run

1. **Register a project** — paste the absolute path to your git repository (or drag it from Finder)
2. **Drop an intake** — write a brief description of what you want (e.g., "Investigate the timeout error in auth.ts" or "Research whether we should migrate to Postgres")
3. **Press Start loop** — the orchestrator picks it up, infers the intake kind, and begins running role agents

![New intake form — name, kind, and free-text content dropped straight into the queue](/screenshots/new-intake.png)

You'll see the live SSE stream on the Task Detail page as roles inspect your codebase and record their findings.

::: tip Not sure which kind or how big it is?
Press **Review intake ▸** instead of "Create task". Orchestra reads the repository first, then proposes the flow, the role plan, and the effort size for you to correct before anything runs — see [Intake Review](/guide/intake-review).
:::

## Production Build

```bash
npm run build   # builds client into server/public, compiles server to server/dist
npm start       # node server/dist/main.js on :5001
```

The production process serves both the API and the built SPA from a single Node process.

Other scripts: `npm run typecheck` (both workspaces) and `npm run test` / `test:watch` / `test:coverage` (server tests via Vitest).

## Deployment

The single process is designed to run on a headless box under **systemd** (or pm2/Docker with a restart policy), bound to a tailnet interface, with other clients reaching the UI/API/SSE over Tailscale.

::: danger There is no authentication
Network reachability is the entire trust boundary. Anyone who can reach the port can register projects, run roles against your repositories, and — if you have enabled them — trigger source edits and allowlisted commands on the host. GitHub PATs and API keys are stored **unencrypted** in SQLite (masked on API responses, not at rest). Bind to a private interface.
:::

Multiple clients can watch and steer the same task concurrently: steering actions are POSTs, up to `maxConcurrentTasks` tasks execute in parallel in their own worktrees, a given task's own steps and restores stay serialized, and SSE fans live progress out to every viewer.

## Next Steps

- [How It Works](/guide/how-it-works) — understand the refinement pipeline
- [Roles Catalog](/reference/roles) — learn about all 25 role agents, including the adversarial `critic`
- [Writing & Running Code](/guide/execution) — let roles edit source and run your test suite (opt-in)
- [Autonomous Operation](/guide/autonomy) — watchers, budgets, and the morning report
- [Agent Networks](/guide/networks) — create custom visual agent graphs
- Visit `/models` in the UI to set up named model configs, compare them, probe their capabilities, and ping your endpoints for connectivity