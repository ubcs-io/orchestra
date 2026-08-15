# MCP Server

Orchestra's role contract — verdict, coverage, open questions — was originally something only a pi agent session could fulfil. The MCP server generalizes it: any agent that speaks [Model Context Protocol](https://modelcontextprotocol.io) (Claude Code, another harness, a live frontier planning session) can read a task's role-execution context and the watcher-generated candidate queue.

This is the transport layer between a **planner tier** and a **worker tier** — how a high-rigor planning session hands a decomposed task down to a cheaper worker, and how that handoff stays auditable.

::: info Read-only, for now
This slice exposes reads only. There is no `start_role_run`, `record_findings`, or `claim_candidate` yet — those arrive in a later slice, gated behind a bearer token. An external agent can look at the queue; it cannot yet claim or close work.
:::

## Running It

The MCP server is a **separate, opt-in stdio process**. `main.ts` never spawns it, and it never starts the scheduler or the watcher loop — it only reads.

```bash
npm --workspace server run dev:mcp     # tsx, for development
npm --workspace server run start:mcp   # node server/dist/mcp-server.js
```

It shares the same SQLite file as the daemon. WAL mode makes concurrent readers against one writer safe, so it can run alongside a live Orchestra daemon.

Register it with an MCP client the usual way — as a stdio server whose command is the `start:mcp` script, run from the Orchestra repo root so `config.json` and `dbPath` resolve.

## Tools

### `get_task_context`

Full role-execution context for a task — everything an external agent needs to pick up where Orchestra's own pipeline would continue.

**Input:** `{ taskId: string }` — numeric id or `task_id` hash.

**Returns:**

| Field | Contents |
|---|---|
| `task` | id, name, status, stage, project id |
| `pendingRole` | The role that would run next — key, title, and full system prompt. `null` for a terminal task or one with no plan yet. |
| `acceptanceCriteria` | The task's criteria checklist. |
| `artifact` | Path and current markdown content. |
| `coverage` | The rolled-up coverage map. |
| `concernTaxonomy` | The concern dimensions coverage is declared against. |
| `openQuestions` | Every open question recorded by prior runs, each tagged with the role that raised it. |

`pendingRole` is resolved with the **same functions the real dispatcher uses**, so it can't drift from what the scheduler would actually do next.

### `list_candidates`

The watcher-generated [candidate queue](/guide/autonomy#candidates-triage) — the work an external agent could look at before anything is claimable.

**Input:** `{ projectId?: number, status?: string, watcher?: string, limit?: number }`

`status` accepts the usual lifecycle values (`pending`, `queued`, `rejected`, `capped`, `suppressed`); `watcher` filters by registry name (`test-suite`, `todo-scan`, …).
