/**
 * Per-project spend guardrails (PLANNING/overhaul-2/01).
 *
 * Orchestra already records `role_runs.tokens` on every run and carries
 * `cost_per_1m_input`/`cost_per_1m_output` on named model configs — but nothing
 * ever compared either against a ceiling, so a task that loops through
 * loopbacks/critique/resume more than expected spends until a human notices.
 * This module owns the policy half of that gap: the shape, its defaults, its
 * defensive read, and its save-time validation. The aggregation lives in db.ts
 * (`getProjectSpend`) and the enforcement point in orchestrator.ts's
 * `pickNextTasks`.
 *
 * Mirrors `harness-policy.ts` / `autonomy.ts` exactly: a `{ budget: {...} }`
 * sub-key inside `projects.config_json`, spread over a fixed default, sanitized
 * on every read (a hand-edited config_json can never hand the scheduler a
 * malformed policy) and separately validated with a reportable error at save
 * time. Ships `enabled: false` — every existing project is unaffected until a
 * human opts in, same posture as `allowWrite`/`allowExec`/`autonomy.enabled`.
 *
 * Like autonomy.ts, this module also owns the small amount of persisted state
 * the gate needs (warn dedupe, override grants) so orchestrator.ts can import
 * FROM it without it ever needing to import orchestrator.ts back.
 */

import { getMeta, getProjectSpend, setMeta, type ProjectRow, type ProjectSpend } from "./db.js";

export interface BudgetPolicy {
  /** The switch. false = no ceiling is ever consulted (default). */
  enabled: boolean;
  /** Rolling window, in days, that spend is summed over. */
  periodDays: number;
  /** Dollar ceiling for the window. Omit to budget tokens only — a project
   *  pointed at a purely local endpoint has no cost data to convert, and the
   *  token path must never depend on the dollar path. */
  capUsd?: number;
  /** Token ceiling for the window. Always enforceable: `role_runs.tokens` is
   *  recorded regardless of whether anyone entered pricing. */
  capTokens?: number;
  /** Percent of a cap at which a non-blocking notice is published (once per
   *  period) ahead of the hard stop. */
  warnThresholdPct: number;
  /** How long a `resume_over_budget` override keeps one task dispatchable past
   *  the cap. Bounded on purpose: the rolling window has no period boundary for
   *  an override to expire at, so an unbounded grant would silently become a
   *  permanent one. */
  overrideMinutes: number;
}

export const DEFAULT_BUDGET_POLICY: BudgetPolicy = {
  enabled: false,
  periodDays: 30,
  warnThresholdPct: 80,
  overrideMinutes: 60,
};

/** Clamp a numeric policy knob to a sane range, falling back to the default for
 *  anything missing or nonsensical — same convention as harness-policy.ts. */
function clampNumber(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** An optional cap: absent/blank leaves that dimension unbudgeted, rather than
 *  falling back to some default ceiling nobody asked for. Non-positive and
 *  non-finite values read as "not set" for the same reason — a cap of 0 would
 *  wedge the project on its first run. */
function optionalCap(v: unknown, max: number): number | undefined {
  if (v == null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(max, n);
}

export const MAX_CAP_USD = 1_000_000;
export const MAX_CAP_TOKENS = 10_000_000_000;

/** Resolve budget policy from a project's config_json `{ budget: {...} }`
 *  sub-key, spread over the default. Never throws: malformed JSON and a missing
 *  key both read as "disabled defaults". */
export function resolveBudgetPolicy(projectConfigJson: string | null): BudgetPolicy {
  if (!projectConfigJson) return { ...DEFAULT_BUDGET_POLICY };
  let budget: Partial<BudgetPolicy> = {};
  try {
    const parsed = JSON.parse(projectConfigJson) as { budget?: Partial<BudgetPolicy> };
    budget = parsed.budget ?? {};
  } catch {
    return { ...DEFAULT_BUDGET_POLICY };
  }
  if (!budget || typeof budget !== "object" || Array.isArray(budget)) {
    return { ...DEFAULT_BUDGET_POLICY };
  }
  return {
    enabled: budget.enabled === true,
    periodDays: clampNumber(budget.periodDays, DEFAULT_BUDGET_POLICY.periodDays, 1, 365),
    capUsd: optionalCap(budget.capUsd, MAX_CAP_USD),
    capTokens: optionalCap(budget.capTokens, MAX_CAP_TOKENS),
    warnThresholdPct: clampNumber(budget.warnThresholdPct, DEFAULT_BUDGET_POLICY.warnThresholdPct, 1, 100),
    overrideMinutes: clampNumber(budget.overrideMinutes, DEFAULT_BUDGET_POLICY.overrideMinutes, 1, 24 * 60),
  };
}

/** Whether this policy can actually stop anything: switched on AND carrying at
 *  least one cap. An enabled policy with no cap set is inert by construction —
 *  reporting that conjunction (rather than `enabled` alone) is what keeps the
 *  safety panel an honest answer to "will this stop a runaway task?". */
export function budgetEnforced(policy: BudgetPolicy): boolean {
  return policy.enabled && (policy.capTokens != null || policy.capUsd != null);
}

export type BudgetValidation = { ok: true; policy: BudgetPolicy } | { ok: false; error: string };

/**
 * Save-time validation. Unlike {@link resolveBudgetPolicy} — which silently
 * degrades a corrupt config_json to safe defaults at read time — this REPORTS
 * the problem, so someone editing the budget in the UI finds out why their
 * value didn't take instead of wondering why the ceiling never fired.
 */
export function validateBudgetPolicy(raw: unknown): BudgetValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "budget policy must be an object" };
  }
  const b = raw as Record<string, unknown>;
  if (b.enabled !== undefined && typeof b.enabled !== "boolean") {
    return { ok: false, error: "enabled must be a boolean" };
  }
  for (const [key, min, max] of [
    ["periodDays", 1, 365],
    ["warnThresholdPct", 1, 100],
    ["overrideMinutes", 1, 24 * 60],
  ] as const) {
    const v = b[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
      return { ok: false, error: `${key} must be a number between ${min} and ${max}` };
    }
  }
  for (const [key, max] of [
    ["capUsd", MAX_CAP_USD],
    ["capTokens", MAX_CAP_TOKENS],
  ] as const) {
    const v = b[key];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > max) {
      return { ok: false, error: `${key} must be a positive number up to ${max}, or null to leave it unset` };
    }
  }
  // Turning the switch on with neither cap set would produce a policy that
  // reads as "budgeted" everywhere while stopping nothing — refuse it here
  // rather than let the safety panel claim a guarantee it can't back.
  const resolved = resolveBudgetPolicy(JSON.stringify({ budget: raw }));
  if (resolved.enabled && resolved.capTokens == null && resolved.capUsd == null) {
    return { ok: false, error: "set capTokens and/or capUsd before enabling the budget — an enabled policy with no cap stops nothing" };
  }
  return { ok: true, policy: resolved };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** Which dimension(s) of a budget have been crossed. */
export type BudgetDimension = "tokens" | "usd";

export interface BudgetStatus {
  policy: BudgetPolicy;
  /** budgetEnforced(policy) — on AND carrying at least one cap. */
  enforced: boolean;
  spend: ProjectSpend;
  /** Any cap crossed: dispatch stops until spend ages out or a human overrides. */
  overCap: boolean;
  /** At/over warnThresholdPct but not yet over any cap — notice only. */
  warning: boolean;
  /** Highest per-cap utilisation as a percentage, or null when unbudgeted. */
  usagePct: number | null;
  /** The caps actually crossed, for a message that says which one. */
  breached: BudgetDimension[];
}

/** Window start for a policy's rolling period, as an ISO timestamp. */
export function budgetWindowStart(policy: BudgetPolicy, now: Date = new Date()): string {
  return new Date(now.getTime() - policy.periodDays * 24 * 3_600_000).toISOString();
}

/**
 * Current budget standing for a project. Cheap enough to call per scheduler
 * round (one grouped SUM plus the model-config list); returns an inert,
 * zeroed status without touching the DB when the project isn't budgeted.
 *
 * The dollar comparison uses `spend.usd` even when `usdIsPartial` — that figure
 * is a floor, so crossing the cap with it is a real crossing, never a
 * false positive. Under-reporting is the only failure mode, and the token cap
 * is what covers it.
 */
export function evaluateProjectBudget(project: ProjectRow, now: Date = new Date()): BudgetStatus {
  const policy = resolveBudgetPolicy(project.config_json);
  const enforced = budgetEnforced(policy);
  const since = budgetWindowStart(policy, now);
  if (!enforced) {
    return {
      policy,
      enforced: false,
      spend: {
        tokens: 0,
        usd: 0,
        usdIsPartial: false,
        unpricedTokens: 0,
        assumedOutputFraction: 0,
        since,
      },
      overCap: false,
      warning: false,
      usagePct: null,
      breached: [],
    };
  }

  const spend = getProjectSpend(project.id, since);
  const breached: BudgetDimension[] = [];
  const utilisations: number[] = [];
  if (policy.capTokens != null) {
    utilisations.push((spend.tokens / policy.capTokens) * 100);
    if (spend.tokens >= policy.capTokens) breached.push("tokens");
  }
  if (policy.capUsd != null) {
    utilisations.push((spend.usd / policy.capUsd) * 100);
    if (spend.usd >= policy.capUsd) breached.push("usd");
  }
  const usagePct = utilisations.length ? Math.max(...utilisations) : null;
  const overCap = breached.length > 0;
  return {
    policy,
    enforced: true,
    spend,
    overCap,
    warning: !overCap && usagePct != null && usagePct >= policy.warnThresholdPct,
    usagePct,
    breached,
  };
}

// ---------------------------------------------------------------------------
// Persisted gate state (the `meta` table, same as autonomy's idle window)
// ---------------------------------------------------------------------------

function warnedMetaKey(projectId: number): string {
  return `budget:warned:${projectId}`;
}

function overrideMetaKey(taskId: string): string {
  return `budget:override:${taskId}`;
}

/**
 * Whether the approaching-cap notice should be published now, recording the
 * fact if so. Deduped to once per period: a rolling window has no boundary to
 * reset at, so "once per period" is measured from the last notice. Dropping
 * back below the threshold clears the marker, so a project that spends up to
 * 80%, quiets down, then climbs again is warned again.
 */
export function shouldPublishBudgetWarning(
  projectId: number,
  status: BudgetStatus,
  now: Date = new Date(),
): boolean {
  const key = warnedMetaKey(projectId);
  if (!status.warning) {
    if (getMeta(key)) setMeta(key, "");
    return false;
  }
  const last = getMeta(key);
  if (last) {
    const lastMs = Date.parse(last);
    if (Number.isFinite(lastMs) && now.getTime() - lastMs < status.policy.periodDays * 24 * 3_600_000) {
      return false;
    }
  }
  setMeta(key, now.toISOString());
  return true;
}

/**
 * Record a human's deliberate decision to let one task keep running past the
 * project's ceiling, for a bounded window. Bounded on purpose — see
 * {@link BudgetPolicy.overrideMinutes}. Returns the expiry so the caller can
 * report it back.
 */
export function grantBudgetOverride(taskId: string, policy: BudgetPolicy, now: Date = new Date()): string {
  const until = new Date(now.getTime() + policy.overrideMinutes * 60_000).toISOString();
  setMeta(overrideMetaKey(taskId), until);
  return until;
}

/** Whether an unexpired override currently exempts this task from the cap. */
export function budgetOverrideActive(taskId: string, now: Date = new Date()): boolean {
  const raw = getMeta(overrideMetaKey(taskId));
  if (!raw) return false;
  const untilMs = Date.parse(raw);
  return Number.isFinite(untilMs) && untilMs > now.getTime();
}

/** The task's override expiry, if one is set at all (expired or not) — so the
 *  UI can say "override expired 10 minutes ago" rather than just going quiet. */
export function budgetOverrideExpiry(taskId: string): string | null {
  return getMeta(overrideMetaKey(taskId)) || null;
}

export function clearBudgetOverride(taskId: string): void {
  setMeta(overrideMetaKey(taskId), "");
}
