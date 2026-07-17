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

You'll see the live SSE stream on the Task Detail page as roles inspect your codebase and record their findings.

## Production Build

```bash
npm run build   # builds client into server/public, compiles server to server/dist
npm start       # node server/dist/main.js on :5001
```

The production process serves both the API and the built SPA from a single Node process.

## Next Steps

- [How It Works](/guide/how-it-works) — understand the refinement pipeline
- [Roles Catalog](/reference/roles) — learn about all 24 role agents, including the adversarial `critic`
- [Agent Networks](/guide/networks) — create custom visual agent graphs
- Visit `/models` in the UI to set up named model configs, compare them, and ping your endpoints for connectivity