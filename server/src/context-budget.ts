/**
 * Context ledger for role-context assembly (PLANNING/overhaul/07).
 *
 * Orchestra's target models have 8k–32k effective windows, but `buildRoleContext`
 * (orchestrator.ts) concatenates intake, every prior run's summary, all open
 * questions, steering notes, and human answers with no token accounting — a task
 * deep into a loopback chain can silently exceed the window, and the server
 * truncates from whichever end it chooses. This module turns that into
 * arithmetic: a `ContextBudget` computed once per run, and a pure `allocate()`
 * that assigns priority-tiered content to it with graceful, stated degradation
 * instead of a silent cut.
 *
 * Deliberately content-agnostic: this module knows nothing about roles, tasks,
 * or artifacts — callers (orchestrator.ts) build `BudgetPart[]` from their own
 * domain content, and this module only does the arithmetic and the picking.
 * That split is what makes `allocate()` cheap to table-test exhaustively.
 *
 * Token estimation is chars/4 (±15% typical error) — no tokenizer dependency in
 * v1; `safetyFactor` absorbs the error. Revisit only if overhaul/04 shows
 * `stop_reason=length` runs despite budgeting (the doc's risk note).
 */

import { Type, type Static } from "@sinclair/typebox";
import { runConstrainedCompletion, runPlainCompletion, type ChatMessage } from "./structured.js";
import type { Connection } from "./settings.js";

/** chars/4 heuristic — sufficient given the safety factor below (doc §1). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** Fraction of the model's window held back, off the top, for tool results
 *  (file reads, exec output) accumulated DURING the run — these never appear in
 *  the assembled prompt `allocate()` sizes, so they'd otherwise go unaccounted
 *  and let a read-heavy role blow the window after a "budgeted" start. */
export const DEFAULT_TOOL_RESULT_RESERVE_FRACTION = 0.3;

/** Slack against the chars/4 estimation error and any other rounding — the
 *  allocator budgets to 90% of what's technically left after every reservation. */
export const SAFETY_FACTOR = 0.9;

export interface ContextBudgetInputs {
  /** Connection.contextWindow — the configured/fallback window. */
  contextWindow: number;
  /** Measured effective window from the model's capability profile
   *  (PLANNING/overhaul/06 `BehaviorProbes.effectiveContext`), when known.
   *  Wins over `contextWindow` when present and positive. */
  effectiveContext?: number | null;
  /** Connection.maxTokens — reserved for the model's own output. */
  maxTokens: number;
  /** Reasoning-model thinking budget for the active thinking level, if any. */
  thinkingBudget?: number;
  /** Tokens the fixed system prompt costs — measured once per role×contract
   *  version by the caller (estimateTokens over the composed prompt text). */
  systemPromptTokens: number;
  /** Overrides {@link DEFAULT_TOOL_RESULT_RESERVE_FRACTION}. */
  toolResultReserveFraction?: number;
  /** Overrides {@link SAFETY_FACTOR}. */
  safetyFactor?: number;
}

export interface ContextBudget {
  /** The window this budget was computed against (effectiveContext, else contextWindow). */
  windowSize: number;
  /** Tokens held back for in-run tool results — never spent by `allocate()`. */
  toolResultReserve: number;
  /** windowSize - maxTokens - thinkingBudget - systemPromptTokens - toolResultReserve, floored at 0. */
  available: number;
  /** available * safetyFactor, floored — what `allocate()` is handed. */
  budget: number;
}

/** Ledger arithmetic only — no content, no I/O. Pure, per doc §1's formula. */
export function computeBudget(inputs: ContextBudgetInputs): ContextBudget {
  const windowSize =
    inputs.effectiveContext != null && inputs.effectiveContext > 0
      ? inputs.effectiveContext
      : inputs.contextWindow;
  const reserveFraction = inputs.toolResultReserveFraction ?? DEFAULT_TOOL_RESULT_RESERVE_FRACTION;
  const toolResultReserve = Math.round(windowSize * reserveFraction);
  const available = Math.max(
    0,
    windowSize -
      inputs.maxTokens -
      (inputs.thinkingBudget ?? 0) -
      inputs.systemPromptTokens -
      toolResultReserve,
  );
  const safetyFactor = inputs.safetyFactor ?? SAFETY_FACTOR;
  return {
    windowSize,
    toolResultReserve,
    available,
    budget: Math.floor(available * safetyFactor),
  };
}

/**
 * Priority tier, kept-first order (doc §1 table):
 *  1 — task header / contract / human steering / human answers: never dropped.
 *  2 — acceptance criteria, current-step steering: never dropped for roles that need them.
 *  3 — intake content: degrades to head+tail.
 *  4 — prior-run summaries: degrades to recent-K-full+one-liners, then one paragraph.
 *  5 — open questions: degrades to a capped, highest-priority subset + a count.
 */
export type BudgetTier = 1 | 2 | 3 | 4 | 5;

export interface BudgetPart {
  /** Stable id for logging/testing/UI — e.g. "task-header", "intake", "priors", "open-questions". */
  id: string;
  tier: BudgetTier;
  /** Tier-1/2 content: always renders at full detail (renderings[0]) regardless
   *  of remaining budget — "never dropped" per the doc table. Set this instead
   *  of relying on tier alone so a caller's intent is explicit at the call site. */
  neverDrop?: boolean;
  /** Candidate renderings, most detailed first. `allocate()` walks this list and
   *  picks the first one that fits the remaining budget; an empty string is a
   *  valid final rung (drop the part entirely) and always "fits". Every
   *  non-first rendering should state what was cut and where to find it in full
   *  (the doc's "older findings condensed; full detail at <path>" pattern) —
   *  allocate() has no domain knowledge to add that itself. */
  renderings: string[];
}

export interface AllocateResult {
  /** Non-empty renderings joined in the parts' original order (not tier order). */
  text: string;
  tokensEst: number;
  /** Part ids that rendered at less than full detail (renderings[0]) but non-empty. */
  degradedIds: string[];
  /** Part ids that rendered as "" because nothing fit — dropped entirely. */
  droppedIds: string[];
  /** true iff degradedIds or droppedIds is non-empty — the run-row flag. */
  degraded: boolean;
}

/**
 * Assign each part its highest-detail rendering that fits the remaining budget,
 * processing tiers in priority order (1 first) so higher tiers always get first
 * claim. `neverDrop` parts always take renderings[0] and are never considered
 * for degradation — they can drive `remaining` negative, which correctly starves
 * every lower tier down to their emptiest rung (or drops them) rather than
 * silently overflowing. Pure — no I/O, no randomness, table-testable.
 */
export function allocate(parts: readonly BudgetPart[], budgetTokens: number): AllocateResult {
  const chosen = new Map<string, string>();
  const degradedIds: string[] = [];
  const droppedIds: string[] = [];
  let remaining = budgetTokens;

  const byTier = [...parts].sort((a, b) => a.tier - b.tier);
  for (const part of byTier) {
    if (!part.renderings.length) continue;

    if (part.neverDrop) {
      const text = part.renderings[0] ?? "";
      chosen.set(part.id, text);
      remaining -= estimateTokens(text);
      continue;
    }

    const room = Math.max(remaining, 0);
    let pickedIdx = -1;
    let pickedText = "";
    for (let i = 0; i < part.renderings.length; i++) {
      const candidate = part.renderings[i]!;
      if (candidate === "" || estimateTokens(candidate) <= room) {
        pickedIdx = i;
        pickedText = candidate;
        break;
      }
    }
    // No rendering (including the emptiest non-"" one) fit — drop entirely.
    // This only differs from pickedIdx pointing at a "" rendering in that no
    // candidate was even offered as fitting; both land here as a full drop.
    if (pickedIdx === -1) {
      chosen.set(part.id, "");
      droppedIds.push(part.id);
      continue;
    }

    chosen.set(part.id, pickedText);
    remaining -= estimateTokens(pickedText);
    if (pickedText === "") {
      if (part.renderings.some((r) => r !== "")) droppedIds.push(part.id);
    } else if (pickedIdx > 0) {
      degradedIds.push(part.id);
    }
  }

  const text = parts
    .map((p) => chosen.get(p.id) ?? "")
    .filter((s) => s.trim().length > 0)
    .join("\n");

  return {
    text,
    tokensEst: estimateTokens(text),
    degradedIds,
    droppedIds,
    degraded: degradedIds.length > 0 || droppedIds.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Rolling digests (doc §2)
// ---------------------------------------------------------------------------

/** Hard cap on a generated digest's length — Tier-4 one-liner/paragraph
 *  material, not a second report. */
export const DIGEST_MAX_CHARS = 400;

/** Below this many chars of source material, a digest call would just restate
 *  (or exceed the length of) the input — skip it entirely and let callers fall
 *  back to the run's own `summary`/`carry_forward` untruncated. */
export const DIGEST_MIN_REPORT_CHARS = 500;

/** Cheap-call input cap (doc's repair pass uses the same tail-biased shape via
 *  agent.ts's REPAIR_MATERIAL_MAX_CHARS) — keeps the digest call itself small
 *  and fast regardless of how long the source report is. */
const DIGEST_SOURCE_HEAD_CHARS = 3000;
const DIGEST_SOURCE_TAIL_CHARS = 1000;

const DigestSchema = Type.Object({ digest: Type.String() });

const DIGEST_SYSTEM_PROMPT =
  "You compress one completed step's work-report into a rolling digest for a multi-step pipeline. " +
  `Extract the key sentences — decisions made, concrete findings, file paths touched — in at most ` +
  `${DIGEST_MAX_CHARS} characters. Be extractive, not creative: prefer copying the report's own key ` +
  `sentences over inventing new phrasing. A later step will read only this digest, not the full report, ` +
  `so it must stand on its own.\n\nRespond with ONLY JSON: {"digest": "..."}`;

/** Parse a digest completion's raw text: prefers `{"digest": "..."}` (possibly
 *  fenced), tolerates a bare string when the endpoint ignored the JSON
 *  instruction (still useful — the content itself is the extractive digest). */
function extractDigestFromText(text: string): string | null {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const raw = (fence?.[1] ?? text).trim();
  try {
    const obj = JSON.parse(raw) as { digest?: unknown };
    if (typeof obj.digest === "string" && obj.digest.trim()) {
      return obj.digest.trim().slice(0, DIGEST_MAX_CHARS);
    }
  } catch {
    // Not JSON — fall through to the plain-text tolerance below.
  }
  const plain = raw.replace(/^["']|["']$/g, "").trim();
  return plain ? plain.slice(0, DIGEST_MAX_CHARS) : null;
}

/**
 * Generate a rolling digest of a completed step's report (doc §2), reusing the
 * same cheap constrained/plain-completion machinery as the repair pass
 * (agent.ts's formalizeFindings, PLANNING/overhaul/03): the sampler-guaranteed
 * rung when the connection supports it, falling back to an unconstrained
 * completion parsed leniently. Returns null (never throws) when the report is
 * too short to bother digesting, or on any call failure — callers fall back to
 * the run's existing `summary`/`carry_forward`.
 */
export async function generateDigest(
  reportMd: string,
  connection: Connection,
  modelId: string,
): Promise<string | null> {
  const material = reportMd.trim();
  if (material.length < DIGEST_MIN_REPORT_CHARS) return null;
  const capped = capHeadTail(material, DIGEST_SOURCE_HEAD_CHARS, DIGEST_SOURCE_TAIL_CHARS);
  const messages: ChatMessage[] = [
    { role: "system", content: DIGEST_SYSTEM_PROMPT },
    { role: "user", content: capped },
  ];

  if (connection.structuredOutputs.mode !== "off") {
    try {
      const result: Static<typeof DigestSchema> = await runConstrainedCompletion(
        connection,
        modelId,
        messages,
        DigestSchema,
        256,
      );
      const digest = result.digest.trim().slice(0, DIGEST_MAX_CHARS);
      return digest || null;
    } catch {
      // Fall through to the unconstrained rung — a constrained-decoding
      // hiccup shouldn't deny the endpoint its unconstrained shot.
    }
  }
  try {
    const content = await runPlainCompletion(connection, modelId, messages, 256);
    return extractDigestFromText(content);
  } catch {
    return null;
  }
}

/** Keep the first `headChars` and last `tailChars` of `text`, eliding the
 *  middle with a stated marker — the doc §3 "head+tail extraction" shape for
 *  oversize intake and Tier-3 degradation. No-op (returns `text` unchanged) if
 *  it's already short enough that head+tail would overlap or exceed it. */
export function capHeadTail(text: string, headChars: number, tailChars: number): string {
  const t = text.trim();
  if (t.length <= headChars + tailChars) return t;
  const head = t.slice(0, headChars).trimEnd();
  const tail = t.slice(t.length - tailChars).trimStart();
  return `${head}\n\n…[${t.length - headChars - tailChars} chars elided]…\n\n${tail}`;
}
