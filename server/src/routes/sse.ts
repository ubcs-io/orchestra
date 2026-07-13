/**
 * Server-Sent Events: live per-task activity (§5.5 live pane).
 *
 * `GET /api/tasks/:id/stream` — subscribes to the in-process bus and streams
 * role start/end, streamed reasoning deltas, and tool calls. Many clients may
 * watch the same task; each gets its own subscription.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getTask } from "../db.js";
import { subscribe, type TaskEvent } from "../bus.js";

export async function sseRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/tasks/:id/stream", async (req: FastifyRequest, reply: FastifyReply) => {
    const taskId = (req.params as { id: string }).id;
    const task = getTask(taskId);
    if (!task) return reply.code(404).send({ error: "task not found" });

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(`: connected to ${task.task_id}\n\n`);

    const send = (ev: TaskEvent) => {
      reply.raw.write(`event: ${ev.kind}\n`);
      reply.raw.write(`data: ${JSON.stringify(ev)}\n\n`);
    };

    const unsubscribe = subscribe(task.task_id, send);

    // Heartbeat keeps intermediaries from closing an idle connection.
    const heartbeat = setInterval(() => {
      reply.raw.write(`: ping\n\n`);
    }, 15_000);

    req.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });

    // Keep the request open; we never resolve until the client disconnects.
    return reply;
  });
}
