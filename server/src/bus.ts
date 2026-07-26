/**
 * In-process pub/sub for live task activity, consumed by the SSE route.
 *
 * Single-process only (matches the daemon model). Each task id has a set of
 * listeners; the orchestrator publishes lifecycle + streamed role events and
 * every connected SSE client receives them.
 */

export interface TaskEvent {
  taskId: string;
  kind:
    | "role_start"
    | "role_end"
    | "text"
    | "thinking"
    | "tool_start"
    | "tool_end"
    | "status"
    | "task_update"
    | "run_health"
    | "recap_start"
    | "recap_end";
  /** Arbitrary event-specific payload (delta, tool name, role key, stage, …). */
  data?: unknown;
  ts: number;
}

type Listener = (ev: TaskEvent) => void;

const listeners = new Map<string, Set<Listener>>();

export function subscribe(taskId: string, fn: Listener): () => void {
  let set = listeners.get(taskId);
  if (!set) {
    set = new Set();
    listeners.set(taskId, set);
  }
  set.add(fn);
  return () => {
    set?.delete(fn);
    if (set && set.size === 0) listeners.delete(taskId);
  };
}

export function publish(taskId: string, kind: TaskEvent["kind"], data?: unknown): void {
  const set = listeners.get(taskId);
  if (!set || set.size === 0) return;
  const ev: TaskEvent = { taskId, kind, data, ts: Date.now() };
  for (const fn of set) {
    try {
      fn(ev);
    } catch {
      /* a broken listener must not stall the loop */
    }
  }
}

export function listenerCount(taskId: string): number {
  return listeners.get(taskId)?.size ?? 0;
}
