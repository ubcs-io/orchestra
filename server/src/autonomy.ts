/**
 * Autonomy policy (PLANNING/overhaul/08 §3): the per-project config governing
 * whether/when/how much self-generated watcher work may run — the kill-switch,
 * active-hours schedule, idle-window budgets, and the watcher menu itself.
 *
 * Mirrors `harness-policy.ts` exactly: a `{ autonomy: {...} }` sub-key inside
 * `projects.config_json`, spread over a fixed default, sanitized on every read
 * (a hand-edited config_json can never hand the scheduler a malformed policy)
 * and separately validated (with a reportable error) at save time. Ships
 * `enabled: false` — every existing project is fully inert until a human opts
 * in, same posture as `allowWrite`/`allowExec`.
 *
 * Also owns the "no human API activity" idle signal: `recordHumanActivity` /
 * `msSinceHumanActivity` live here (not orchestrator.ts) specifically so that
 * orchestrator.ts can import FROM this module (for the scheduler's eligibility
 * gate) without this module ever needing to import orchestrator.ts back —
 * watchers.ts already needs the reverse (orchestrator.ts's
 * `materializeIntakeTask`), and this keeps that a one-directional graph.
 */

import { getMeta, setMeta, sumAutonomousTokensSince } from "./db.js";

export interface WatcherConfig {
  /** Registry key — see `WATCHER_REGISTRY` in watchers.ts for the live list. */
  name: string;
  enabled: boolean;
  /** Minimum minutes between two runs of this watcher. */
  cadenceMinutes: number;
  /** Max candidates from this watcher that may reach "queued" per UTC day. */
  perWatcherDailyCap: number;
  /** Exec-allowlist command names (harness-policy.ts) this watcher invokes.
   *  Only meaningful for the exec-backed watchers (test-suite, lint-drift,
   *  dep-staleness); the natively-read ones ignore it. */
  commands?: string[];
  /** Age gate, for the watchers that have one: how old a TODO marker
   *  (`todo-scan`) or a quiet branch (`branch-triage`) must be before it's
   *  worth proposing. Ignored by watchers with no age dimension. */
  thresholdDays?: number;
}

/** Idle-time upkeep of the system itself (PLANNING/overhaul/08 §5) — runs in
 *  the same idle window, under the same budgets, as watcher work. Every flag
 *  defaults ON because the parent `enabled` kill-switch is already OFF: a
 *  project that has deliberately turned autonomy on wants its own upkeep done
 *  too, and each sub-flag exists to turn one piece back off. */
export interface SelfMaintenanceConfig {
  enabled: boolean;
  /** Probe + profile models seen in config but with no capability profile yet
   *  (overhaul/06) — "a model pulled into Ollama at midnight is usable by
   *  morning". */
  reprobeModels: boolean;
  /** Generate the rolling digests (overhaul/07) that runs missed because their
   *  fire-and-forget digest call failed or was still in flight at shutdown. */
  backfillDigests: boolean;
  /** Reclaim `orchestra/*` branches and worktree directories with no owning
   *  task row, so Orchestra's bookkeeping doesn't accumulate in the user's repo
   *  and swamp plain `git branch`. Never force-deletes: an orphan holding
   *  unmerged commits is left alone. */
  reapWorkspaces: boolean;
}

export interface ActiveHours {
  /** "HH:MM", local time. */
  start: string;
  end: string;
  /** Saturdays/Sundays are always active, regardless of start/end. */
  weekendsAllDay: boolean;
}

export interface AutonomyBudgets {
  /** Max watcher-originated task dispatches per idle window. */
  maxTaskStarts: number;
  /** Max summed role_runs.tokens across watcher-originated tasks per window. */
  maxTokens: number;
  /** Max watcher scan command executions per window. */
  maxExecRuns: number;
}

export interface AutonomyConfig {
  /** The kill-switch. false = fully inert (default for every project). */
  enabled: boolean;
  /** null = always active (no schedule restriction). */
  activeHours: ActiveHours | null;
  /** Minutes of no mutating API activity before the project is "idle". */
  idleAfterMinutes: number;
  /** Max open (non-"ready") watcher-originated tasks at once. */
  autoQueueDepth: number;
  budgets: AutonomyBudgets;
  watchers: WatcherConfig[];
  selfMaintenance: SelfMaintenanceConfig;
}

/**
 * Only `test-suite` ships enabled. The other five are present-but-off so the
 * editor can list them without an operator hand-writing config_json, and so
 * turning autonomy on for the first time doesn't hand a repo six simultaneous
 * new sources of self-generated work — the doc's own rollout order is "the
 * remaining watchers one at a time, each with its cap".
 *
 * `dep-staleness` is doubly inert: off here, and its commands must also be
 * added to the exec allowlist, because it's the only watcher that reaches
 * outside the operator's network.
 */
export const DEFAULT_AUTONOMY_CONFIG: AutonomyConfig = {
  enabled: false,
  activeHours: null,
  idleAfterMinutes: 10,
  autoQueueDepth: 5,
  budgets: { maxTaskStarts: 10, maxTokens: 2_000_000, maxExecRuns: 50 },
  watchers: [
    { name: "test-suite", enabled: true, cadenceMinutes: 60, perWatcherDailyCap: 2, commands: ["test", "typecheck"] },
    { name: "todo-scan", enabled: false, cadenceMinutes: 1440, perWatcherDailyCap: 1, thresholdDays: 30 },
    { name: "branch-triage", enabled: false, cadenceMinutes: 1440, perWatcherDailyCap: 1, thresholdDays: 30 },
    { name: "doc-drift", enabled: false, cadenceMinutes: 1440, perWatcherDailyCap: 1 },
    { name: "lint-drift", enabled: false, cadenceMinutes: 360, perWatcherDailyCap: 2, commands: ["lint"] },
    { name: "dep-staleness", enabled: false, cadenceMinutes: 1440, perWatcherDailyCap: 1, commands: ["outdated", "audit"] },
  ],
  selfMaintenance: { enabled: true, reprobeModels: true, backfillDigests: true, reapWorkspaces: true },
};

function clampNumber(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function sanitizeActiveHours(raw: unknown): ActiveHours | null {
  if (raw == null) return null;
  if (typeof raw !== "object") return null;
  const h = raw as Record<string, unknown>;
  const start = typeof h.start === "string" && TIME_RE.test(h.start) ? h.start : null;
  const end = typeof h.end === "string" && TIME_RE.test(h.end) ? h.end : null;
  if (!start || !end) return null;
  return { start, end, weekendsAllDay: h.weekendsAllDay === true };
}

function sanitizeWatchers(raw: unknown): WatcherConfig[] {
  if (!Array.isArray(raw)) return DEFAULT_AUTONOMY_CONFIG.watchers.map((w) => ({ ...w }));
  const out: WatcherConfig[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const w = item as Record<string, unknown>;
    const name = typeof w.name === "string" ? w.name.trim() : "";
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      enabled: w.enabled === true,
      cadenceMinutes: clampNumber(w.cadenceMinutes, 60, 0, 1440 * 7),
      perWatcherDailyCap: clampNumber(w.perWatcherDailyCap, 2, 1, 50),
      commands:
        Array.isArray(w.commands) && w.commands.every((c) => typeof c === "string")
          ? (w.commands as string[])
          : undefined,
      thresholdDays:
        w.thresholdDays == null ? undefined : clampNumber(w.thresholdDays, 30, 0, 3650),
    });
  }
  return out.length ? out : DEFAULT_AUTONOMY_CONFIG.watchers.map((w) => ({ ...w }));
}

function sanitizeSelfMaintenance(raw: unknown): SelfMaintenanceConfig {
  const d = DEFAULT_AUTONOMY_CONFIG.selfMaintenance;
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return { ...d };
  const s = raw as Record<string, unknown>;
  const flag = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
  return {
    enabled: flag(s.enabled, d.enabled),
    reprobeModels: flag(s.reprobeModels, d.reprobeModels),
    backfillDigests: flag(s.backfillDigests, d.backfillDigests),
    reapWorkspaces: flag(s.reapWorkspaces, d.reapWorkspaces),
  };
}

function sanitizeBudgets(raw: unknown): AutonomyBudgets {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    maxTaskStarts: clampNumber(b.maxTaskStarts, DEFAULT_AUTONOMY_CONFIG.budgets.maxTaskStarts, 1, 1000),
    maxTokens: clampNumber(b.maxTokens, DEFAULT_AUTONOMY_CONFIG.budgets.maxTokens, 1000, 100_000_000),
    maxExecRuns: clampNumber(b.maxExecRuns, DEFAULT_AUTONOMY_CONFIG.budgets.maxExecRuns, 1, 10_000),
  };
}

/** A fully-detached copy of the defaults — nested arrays/objects included, so a
 *  caller mutating a resolved config can never write through to the shared
 *  DEFAULT_AUTONOMY_CONFIG. */
function defaultConfigClone(): AutonomyConfig {
  return {
    ...DEFAULT_AUTONOMY_CONFIG,
    budgets: { ...DEFAULT_AUTONOMY_CONFIG.budgets },
    watchers: DEFAULT_AUTONOMY_CONFIG.watchers.map((w) => ({ ...w })),
    selfMaintenance: { ...DEFAULT_AUTONOMY_CONFIG.selfMaintenance },
  };
}

/** Resolve autonomy config from a project's config_json `{ autonomy: {...} }`
 *  sub-key, spread over the default — mirrors harness-policy.ts's
 *  resolveHarnessPolicy(). Never throws: malformed JSON or a missing key both
 *  read as "fully inert defaults". */
export function resolveAutonomyConfig(projectConfigJson: string | null): AutonomyConfig {
  if (!projectConfigJson) return defaultConfigClone();
  let autonomy: Partial<AutonomyConfig> = {};
  try {
    const parsed = JSON.parse(projectConfigJson) as { autonomy?: Partial<AutonomyConfig> };
    autonomy = parsed.autonomy ?? {};
  } catch {
    return defaultConfigClone();
  }
  return {
    enabled: autonomy.enabled === true,
    activeHours: sanitizeActiveHours(autonomy.activeHours),
    idleAfterMinutes: clampNumber(autonomy.idleAfterMinutes, DEFAULT_AUTONOMY_CONFIG.idleAfterMinutes, 0, 1440),
    autoQueueDepth: clampNumber(autonomy.autoQueueDepth, DEFAULT_AUTONOMY_CONFIG.autoQueueDepth, 0, 100),
    budgets: sanitizeBudgets(autonomy.budgets),
    watchers: sanitizeWatchers(autonomy.watchers),
    selfMaintenance: sanitizeSelfMaintenance(autonomy.selfMaintenance),
  };
}

export type AutonomyValidation = { ok: true; config: AutonomyConfig } | { ok: false; error: string };

/**
 * Save-time validation: unlike {@link resolveAutonomyConfig} (which silently
 * degrades a corrupt config_json to safe defaults), this REPORTS the problem
 * so an editor in the UI finds out why a field didn't take, then normalizes
 * through the same reader the runtime uses so what's stored is exactly what
 * will later be resolved.
 */
export function validateAutonomyConfig(raw: unknown): AutonomyValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "autonomy config must be an object" };
  }
  const a = raw as Record<string, unknown>;
  if (a.activeHours != null) {
    if (typeof a.activeHours !== "object" || Array.isArray(a.activeHours)) {
      return { ok: false, error: "activeHours must be an object with start/end, or null" };
    }
    const h = a.activeHours as Record<string, unknown>;
    if (typeof h.start !== "string" || !TIME_RE.test(h.start) || typeof h.end !== "string" || !TIME_RE.test(h.end)) {
      return { ok: false, error: `activeHours.start/end must be "HH:MM" (00:00-23:59)` };
    }
  }
  if (a.watchers != null) {
    if (!Array.isArray(a.watchers)) return { ok: false, error: "watchers must be an array" };
    const seen = new Set<string>();
    for (const item of a.watchers) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return { ok: false, error: "each watcher entry must be an object" };
      }
      const w = item as Record<string, unknown>;
      const name = typeof w.name === "string" ? w.name.trim() : "";
      if (!name) return { ok: false, error: "each watcher needs a non-empty name" };
      if (seen.has(name)) return { ok: false, error: `duplicate watcher name "${name}"` };
      seen.add(name);
    }
  }
  if (a.budgets != null && (typeof a.budgets !== "object" || Array.isArray(a.budgets))) {
    return { ok: false, error: "budgets must be an object" };
  }
  if (a.selfMaintenance != null && (typeof a.selfMaintenance !== "object" || Array.isArray(a.selfMaintenance))) {
    return { ok: false, error: "selfMaintenance must be an object" };
  }
  return { ok: true, config: resolveAutonomyConfig(JSON.stringify({ autonomy: raw })) };
}

/** Whether `now` falls inside the configured active-hours window. `null`
 *  (no schedule set) means always active. Handles a window that crosses
 *  midnight (e.g. 22:00-07:00) and an optional weekends-all-day override.
 *  Pure — uses local time, since this is a locally-run companion. */
export function isWithinActiveHours(hours: ActiveHours | null, now: Date): boolean {
  if (!hours) return true;
  const day = now.getDay(); // 0 = Sunday, 6 = Saturday
  if (hours.weekendsAllDay && (day === 0 || day === 6)) return true;
  const toMinutes = (hhmm: string): number => {
    const [h, m] = hhmm.split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  const start = toMinutes(hours.start);
  const end = toMinutes(hours.end);
  if (start === end) return true; // degenerate config: treat as "always"
  if (start < end) return minutesNow >= start && minutesNow < end;
  return minutesNow >= start || minutesNow < end; // wraps midnight
}

// ---------------------------------------------------------------------------
// "No human API activity" idle signal
// ---------------------------------------------------------------------------

let lastHumanActivityAt = Date.now();

/** Call on every mutating (POST/PATCH/DELETE) API request — a human reading
 *  the board (GET polling) does not count, or an idle dashboard tab left open
 *  would permanently suppress autonomy. */
export function recordHumanActivity(): void {
  lastHumanActivityAt = Date.now();
}

export function msSinceHumanActivity(): number {
  return Date.now() - lastHumanActivityAt;
}

/** Test seam: force the idle clock back to "just active", undoing any prior
 *  recordHumanActivity() calls from earlier tests in the same process. */
export function resetHumanActivityClock(): void {
  lastHumanActivityAt = Date.now();
}

// ---------------------------------------------------------------------------
// Idle-window budget tracking (persisted in the `meta` table)
// ---------------------------------------------------------------------------

interface IdleWindowState {
  /** ISO timestamp the current idle window began, or null while a human is
   *  active (no window in progress). Reset to a fresh timestamp exactly once,
   *  on the active->idle transition — not on every read. */
  windowStartedAt: string | null;
  taskStarts: number;
  execRuns: number;
}

const EMPTY_WINDOW: IdleWindowState = { windowStartedAt: null, taskStarts: 0, execRuns: 0 };

function windowMetaKey(projectId: number): string {
  return `autonomy:window:${projectId}`;
}

function loadWindowState(projectId: number): IdleWindowState {
  const raw = getMeta(windowMetaKey(projectId));
  if (!raw) return { ...EMPTY_WINDOW };
  try {
    const parsed = JSON.parse(raw) as Partial<IdleWindowState>;
    return {
      windowStartedAt: typeof parsed.windowStartedAt === "string" ? parsed.windowStartedAt : null,
      taskStarts: typeof parsed.taskStarts === "number" ? parsed.taskStarts : 0,
      execRuns: typeof parsed.execRuns === "number" ? parsed.execRuns : 0,
    };
  } catch {
    return { ...EMPTY_WINDOW };
  }
}

function saveWindowState(projectId: number, state: IdleWindowState): void {
  setMeta(windowMetaKey(projectId), JSON.stringify(state));
}

export interface IdleWindowBudgetStatus {
  exhausted: boolean;
  consumed: { taskStarts: number; execRuns: number; tokens: number };
  budgets: AutonomyBudgets;
  /** null while a human is active — no window in progress. */
  windowStartedAt: string | null;
}

/**
 * Current idle-window budget status for a project: resets the window's
 * counters exactly once on the transition from "human active" to "idle" (see
 * {@link IdleWindowState}), then reports whether any of the three budgets
 * (task-starts, exec-runs, live-summed tokens) has been exhausted within the
 * window that's been running since. While a human is active, the window is
 * cleared and nothing is ever "exhausted" (autonomy doesn't run outside idle
 * anyway — this only gates already-idle dispatch).
 */
export function getOrResetIdleWindowBudget(projectId: number, cfg: AutonomyConfig): IdleWindowBudgetStatus {
  const idleNow = msSinceHumanActivity() >= cfg.idleAfterMinutes * 60_000;
  let state = loadWindowState(projectId);

  if (!idleNow) {
    if (state.windowStartedAt !== null) {
      state = { ...EMPTY_WINDOW };
      saveWindowState(projectId, state);
    }
    return { exhausted: false, consumed: { taskStarts: 0, execRuns: 0, tokens: 0 }, budgets: cfg.budgets, windowStartedAt: null };
  }

  const windowStartedAt = state.windowStartedAt ?? new Date().toISOString();
  if (state.windowStartedAt === null) {
    state = { windowStartedAt, taskStarts: 0, execRuns: 0 };
    saveWindowState(projectId, state);
  }

  const tokens = sumAutonomousTokensSince(projectId, windowStartedAt);
  const exhausted =
    state.taskStarts >= cfg.budgets.maxTaskStarts ||
    state.execRuns >= cfg.budgets.maxExecRuns ||
    tokens >= cfg.budgets.maxTokens;
  return {
    exhausted,
    consumed: { taskStarts: state.taskStarts, execRuns: state.execRuns, tokens },
    budgets: cfg.budgets,
    windowStartedAt: state.windowStartedAt,
  };
}

export function recordAutonomousTaskStart(projectId: number): void {
  const state = loadWindowState(projectId);
  state.taskStarts += 1;
  saveWindowState(projectId, state);
}

export function recordAutonomousExecRun(projectId: number): void {
  const state = loadWindowState(projectId);
  state.execRuns += 1;
  saveWindowState(projectId, state);
}
