/**
 * Derived run-health taxonomy (PLANNING/overhaul/04).
 *
 * Health is NOT persisted — it is computed from the raw signals already on a
 * `role_runs` row (verdict_source, fallback, stalled, stop_reason, retry
 * lineage, artifact bytes / output). Computing it in one shared function rather
 * than storing it means the taxonomy can evolve as 01–03 land (and 05's
 * "verified" tier later) without a migration or a backfill — every consumer
 * (the API row decorator, the health-stats aggregation, the READY gate, the
 * critic-context hook) reads the same definition.
 *
 * The five tiers form a trust ladder, most→least trustworthy:
 *   verified  — healthy AND the run's verdict is backed by harness-recorded
 *               command executions that all exited zero (overhaul/05). The only
 *               tier where the trust is *earned* rather than assumed: nothing
 *               the model asserts can produce it, because evidence is written
 *               solely by the executor.
 *   healthy   — a clean verdict (tool/fence/constrained), no stall, ran to a
 *               natural stop, first attempt. Nothing went wrong.
 *   recovered — a real (non-synthesized) verdict was still obtained, but only
 *               after the repair pass reconstructed it or a resume re-entered a
 *               prior attempt. Trustworthy, but flag that it was salvaged.
 *   degraded  — the verdict is synthesized (fallback), or the run truncated at
 *               the token limit / stalled without being healed. Low trust.
 *   empty     — degraded AND nothing durable was produced (no bytes appended
 *               during the run and a blank output_md). The literal "task ran
 *               but wrote no output" case.
 *
 * A run that executed commands and got a RED one is deliberately NOT demoted
 * below `healthy`: the run itself worked perfectly, it just reported bad news.
 * Failing evidence is a *gate* concern (orchestrator.ts's evidence criteria),
 * not a run-health concern — conflating the two would make an honest red suite
 * look like a broken model.
 */

export type RunHealth = "verified" | "healthy" | "recovered" | "degraded" | "empty";

/** Tiers at or above `healthy` — i.e. nothing went wrong with the run itself.
 *  Use this rather than `=== "healthy"` anywhere a distrust signal is being
 *  decided, so `verified` is never mistaken for a degradation. */
export function isTrustedHealth(h: RunHealth): boolean {
  return h === "verified" || h === "healthy";
}

/** The minimal set of raw signals health is derived from. `RoleRunRow`
 *  satisfies this (via {@link roleRunHealthInput}); stats queries and tests
 *  supply the same shape directly so neither needs a full row. */
export interface RunHealthInput {
  /** How the structured verdict was obtained (agent.ts `VerdictSource`), or
   *  null on legacy rows / failure-path rows with no model turn. */
  verdict_source: string | null;
  /** 1 when the verdict was synthesized by `synthesizeFallback`. */
  fallback: number | null;
  /** 1 when a stall was detected at any point during the run. */
  stalled: number | null;
  /** LLM stop reason; "length" means the generation was truncated. */
  stop_reason: string | null;
  /** 1-based attempt index (overhaul/03); >1 means this run resumed a prior one. */
  attempt: number | null;
  /** role_run id this run resumed from; non-null means a resume happened. */
  resumed_from: number | null;
  /** Bytes of prose durably appended to the artifact DURING the run (overhaul/01). */
  artifact_bytes: number | null;
  /** Whether the assembled report (output_md) is non-blank. */
  hasOutput: boolean;
  /** Commands this run executed via `run_command` (overhaul/05), harness-
   *  recorded. Only the pass/fail shape matters here, so this takes the
   *  minimal projection rather than the full ExecEvidence — keeping health.ts
   *  free of an exec.ts import and trivially constructible in tests. */
  evidence?: { exitCode: number | null; timedOut?: boolean; spawnError?: string }[];
}

/** A run's verdict is synthesized (not model-reported) when the fallback flag
 *  is set or the verdict source is explicitly "fallback". */
function isFallbackVerdict(r: RunHealthInput): boolean {
  return r.fallback === 1 || r.verdict_source === "fallback";
}

/** The verdict was obtained, but only after a repair pass or a resume — i.e.
 *  the normal in-session channels failed and something salvaged it. */
function wasHealed(r: RunHealthInput): boolean {
  return (
    r.verdict_source === "repair" ||
    r.resumed_from != null ||
    (r.attempt != null && r.attempt > 1)
  );
}

/** Nothing durable came out of the run: no bytes appended during it and a
 *  blank assembled report. */
function producedNothing(r: RunHealthInput): boolean {
  return (r.artifact_bytes ?? 0) <= 0 && !r.hasOutput;
}

/** The run ran at least one command and every one of them came back green.
 *  A timeout or a failed spawn is never green — "we couldn't tell" is not
 *  evidence of passing. */
function allEvidenceGreen(r: RunHealthInput): boolean {
  const ev = r.evidence ?? [];
  return ev.length > 0 && ev.every((e) => e.exitCode === 0 && !e.timedOut && !e.spawnError);
}

export function computeRunHealth(r: RunHealthInput): RunHealth {
  // A synthesized verdict is the strongest low-trust signal — even a repair
  // that was *attempted* but fell back lands here (verdict_source === "fallback").
  if (isFallbackVerdict(r)) {
    return producedNothing(r) ? "empty" : "degraded";
  }
  // Real verdict obtained. If it took repair/resume to get it, it's recovered.
  if (wasHealed(r)) return "recovered";
  // Real verdict on the normal path, but a degradation signal fired anyway.
  if (r.stop_reason === "length" || r.stalled === 1) return "degraded";
  // Clean run — promote it only if the model also backed it with green
  // executions it did not get to self-report (overhaul/05).
  return allEvidenceGreen(r) ? "verified" : "healthy";
}

/** A short human-readable explanation of *why* a run has its health, for the
 *  UI tooltip / distrust banner. Returns "" for a clean healthy run. */
export function runHealthReason(r: RunHealthInput): string {
  const health = computeRunHealth(r);
  switch (health) {
    case "empty":
      return r.stop_reason === "length"
        ? "Truncated at the token limit before any output was written."
        : "The run produced no output.";
    case "degraded":
      if (isFallbackVerdict(r)) {
        return "Verdict synthesized after every recovery attempt failed — the model never returned a usable verdict.";
      }
      if (r.stop_reason === "length") return "Output truncated at the token limit.";
      if (r.stalled === 1) return "The run stalled narrating tool calls instead of producing output.";
      return "The run degraded.";
    case "recovered":
      if (r.verdict_source === "repair") return "Verdict reconstructed by the repair pass from already-produced work.";
      if (r.resumed_from != null || (r.attempt != null && r.attempt > 1)) {
        return "Completed after resuming an interrupted earlier attempt.";
      }
      return "Recovered after a degradation.";
    case "verified": {
      const n = r.evidence?.length ?? 0;
      return `Verdict backed by ${n} green command run${n === 1 ? "" : "s"} recorded by the harness.`;
    }
    case "healthy":
      return "";
  }
}

/** Adapt a persisted `role_runs` row (or any superset) to {@link RunHealthInput}.
 *  Kept here so the "blank output_md" rule lives with the taxonomy. Accepts the
 *  columns structurally to avoid a db.ts → health.ts type cycle. */
export function roleRunHealthInput(row: {
  verdict_source: string | null;
  fallback: number | null;
  stalled: number | null;
  stop_reason: string | null;
  attempt: number | null;
  resumed_from: number | null;
  artifact_bytes: number | null;
  output_md: string | null;
  evidence_json?: string | null;
}): RunHealthInput {
  return {
    verdict_source: row.verdict_source,
    fallback: row.fallback,
    stalled: row.stalled,
    stop_reason: row.stop_reason,
    attempt: row.attempt,
    resumed_from: row.resumed_from,
    artifact_bytes: row.artifact_bytes,
    hasOutput: !!(row.output_md ?? "").trim(),
    evidence: parseEvidenceShape(row.evidence_json),
  };
}

/** Minimal, defensive read of `evidence_json` for health purposes. Kept local
 *  (rather than importing exec.ts's parseEvidence) so health.ts stays a leaf
 *  module with no dependencies — a malformed column reads as "no evidence",
 *  which correctly declines the `verified` promotion instead of throwing. */
function parseEvidenceShape(json: string | null | undefined): RunHealthInput["evidence"] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
      .map((e) => ({
        exitCode: typeof e.exitCode === "number" ? e.exitCode : null,
        timedOut: e.timedOut === true,
        spawnError: typeof e.spawnError === "string" ? e.spawnError : undefined,
      }));
  } catch {
    return [];
  }
}
