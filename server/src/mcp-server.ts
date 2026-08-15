/**
 * Orchestra MCP server — PLANNING/overhaul/09's portable role contract,
 * read-only slice. A separate, opt-in stdio process (never spawned by
 * main.ts) that lets an external agent (Claude Code, Hermes, ...) read a
 * task's role context and the watcher-generated candidate queue.
 *
 * Deliberately read-only: no `start_role_run`/`record_findings`/
 * `claim_candidate` here yet — those are a later slice, gated behind a
 * bearer token, per the doc's own migration order (read-only first).
 *
 * Shares the same SQLite file as the daemon (WAL mode makes concurrent
 * readers-against-one-writer safe, see db.ts) but never calls
 * startScheduler()/startWatcherLoop() — this process only reads.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getConfig } from "./config.js";
import { getDb, initDb, listCandidates } from "./db.js";
import { getTaskContext } from "./mcp-context.js";

function isSqliteBusy(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "SQLITE_BUSY";
}

/** initDb() can race the daemon's own first-run schema migration on a brand
 *  new DB file; WAL's busy_timeout absorbs most of this, but not guaranteed
 *  for concurrent DDL, so retry once after a short delay rather than crash. */
async function initDbWithRetry(): Promise<void> {
  try {
    initDb();
  } catch (err) {
    if (!isSqliteBusy(err)) throw err;
    await new Promise((resolve) => setTimeout(resolve, 250));
    initDb();
  }
}

async function main(): Promise<void> {
  getConfig();
  await initDbWithRetry();

  const server = new McpServer({ name: "orchestra", version: "0.1.0" });

  server.registerTool(
    "get_task_context",
    {
      title: "Get task context",
      description:
        "Full role-execution context for an Orchestra task: the role that would run next, its prompt, " +
        "the task's acceptance criteria, the current artifact markdown, the coverage map + taxonomy, " +
        "and open questions recorded by prior role runs. Read-only.",
      inputSchema: { taskId: z.string().describe("Task id (numeric) or task_id hash") },
    },
    async ({ taskId }) => {
      const result = getTaskContext(taskId);
      if (!result) {
        return { content: [{ type: "text", text: `No task found for id "${taskId}"` }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    "list_candidates",
    {
      title: "List candidate work items",
      description:
        "Watcher-generated candidate work items (PLANNING/overhaul/08) for a project — the queue an " +
        "external agent can look at before anything is claimable. Read-only.",
      inputSchema: {
        projectId: z.number().optional().describe("Filter to one project"),
        status: z.string().optional().describe("e.g. 'proposed', 'queued', 'suppressed'"),
        watcher: z.string().optional().describe("e.g. 'test-suite'"),
        limit: z.number().optional(),
      },
    },
    async (args) => {
      const candidates = listCandidates(args);
      return { content: [{ type: "text", text: JSON.stringify(candidates, null, 2) }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async (sig: string) => {
    console.error(`orchestra-mcp: received ${sig}, shutting down`);
    try {
      getDb().close();
    } catch {
      /* already closed */
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("orchestra-mcp fatal:", err);
  process.exit(1);
});
