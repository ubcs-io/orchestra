/**
 * Orchestra daemon entry point.
 *
 * One Node process is the whole app: it boots the DB, seeds the role catalog,
 * serves the REST + SSE API and the built React client, and starts the
 * orchestrator scheduler. "The server process is the daemon."
 */

import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { getConfig } from "./config.js";
import { getDb, initDb } from "./db.js";
import { seedGlobalRoles } from "./roles.js";
import { seedGlobalConfig } from "./settings.js";
import { apiRoutes } from "./routes/api.js";
import { sseRoutes } from "./routes/sse.js";
import { startScheduler, stopScheduler } from "./orchestrator.js";

async function main(): Promise<void> {
  const cfg = getConfig();

  initDb();
  seedGlobalRoles();
  seedGlobalConfig();

  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, bodyLimit: 8 * 1024 * 1024 });

  await app.register(apiRoutes);
  await app.register(sseRoutes);

  // Serve the built SPA if present, with a client-side-routing fallback.
  if (fs.existsSync(path.join(cfg.clientDir, "index.html"))) {
    await app.register(fastifyStatic, { root: cfg.clientDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api")) return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
  } else {
    app.get("/", async () => ({
      service: "orchestra",
      note: "client not built — run `npm run build` (or use the Vite dev server on :5173)",
    }));
  }

  await app.listen({ host: cfg.host, port: cfg.port });
  app.log.info(`Orchestra listening on http://${cfg.host}:${cfg.port}`);

  startScheduler();

  const shutdown = async (sig: string) => {
    app.log.info(`received ${sig}, shutting down`);
    await stopScheduler();
    await app.close();
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
  console.error("fatal:", err);
  process.exit(1);
});
