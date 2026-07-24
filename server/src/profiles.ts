/**
 * Measured model capability profiles (PLANNING/overhaul/06).
 *
 * One measured record per (connection signature, model id) replaces hand-tuned
 * compat guessing: behavioral probes (can this model form a custom tool call? a
 * built-in one? parseable fenced JSON? which thinking dialect?) bootstrap the
 * profile, live run-health aggregates (overhaul/04) continuously refine it, and
 * a pure `deriveProfile` policy function turns both into the decisions that
 * today come from hand-set `textMode`/`twoPhase`/`ModelCompat` flags. The
 * `overrides` bag is the human escape hatch and always wins field-by-field —
 * it is also how existing hand tuning is imported on first probe, so flipping
 * resolution to profile-first changes nothing on day one (the doc's rollout
 * step 2, "zero behavior change by construction").
 *
 * Layering: this module sits between db.ts (store + live aggregates) and
 * settings.ts (which consults the store in `resolveConnectionForModel`).
 * It must NOT import settings.ts or providers.ts — both import (or will
 * import) from here. Probes go through direct `fetch`, deliberately outside
 * pi, mirroring probe.ts: probe behavior must not be filtered through pi's
 * own compat-shaping, since the compat flags are exactly what is being
 * measured. Probe prompts are kept trivial and dialect-neutral, and success
 * is asserted on structure only (a probe failing because of a chat-template
 * quirk would mislabel the model).
 */

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { probeStructuredOutputs, type StructuredMode } from "./probe.js";
import {
  deleteModelProfileRow,
  getModelLiveStats,
  getModelProfileRow,
  listModelProfileRows,
  upsertModelProfileRow,
  type ModelLiveStats,
} from "./db.js";

// ---------------------------------------------------------------------------
// Keying
// ---------------------------------------------------------------------------

/** Small non-cryptographic string hash — a stable, short, secret-free id
 *  derived from a signature string. Shared home for the keying scheme
 *  providers.ts introduced for its per-connection provider registry. */
export function hashSig(sig: string): string {
  let h = 0;
  for (let i = 0; i < sig.length; i++) {
    h = (Math.imul(h, 31) + sig.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** Profile store key for a connection. Deliberately hashes ONLY the normalized
 *  base URL: the profile describes the (endpoint, model) pair's behavior, so it
 *  must survive an API-key rotation or a context-window edit (unlike the
 *  provider-registry sig, which keys registration state and wants to churn on
 *  any param change). A changed base URL yields a different sig, which is the
 *  implicit invalidation the doc asks for. */
export function profileConnectionSig(baseUrl: string | null | undefined): string {
  return hashSig((baseUrl ?? "").replace(/\/+$/, ""));
}

// ---------------------------------------------------------------------------
// Profile shape
// ---------------------------------------------------------------------------

/** Success count over K trials of one behavioral probe. */
export interface TrialProbe {
  attempts: number;
  successes: number;
}

/** Where the model's reasoning arrived in the dialect sniff: on the OpenAI-
 *  compatible `reasoning_content`/`reasoning` channel, as literal `<think>`
 *  tags in the answer text (createThinkSplitter's case), or not at all. */
export type ThinkingDialect = "reasoning_content" | "think_tags" | "none";

/** Raw behavioral probe observations — evidence, never conclusions. */
export interface BehaviorProbes {
  /** Endpoint-level constrained-decoding support (probe.ts, overhaul/02). */
  structured?: Record<StructuredMode, boolean>;
  /** Did a well-formed `record_answer` custom tool call arrive? Directly
   *  measures the record_findings failure mode that spawned textMode. */
  customToolCall?: TrialProbe;
  /** Same with a `read_file`-style tool — distinguishes "can't custom-tool"
   *  from "can't tool at all" (the textMode vs twoPhase distinction). */
  builtinToolCall?: TrialProbe;
  /** Text-mode-style instruction, tiny schema → parseable on how many trials? */
  jsonFence?: TrialProbe;
  thinkingDialect?: ThinkingDialect;
  /** Endpoint accepted a `developer`-role message (200 vs 4xx). */
  developerRole?: boolean;
  /** Endpoint accepted `reasoning_effort` (200 vs 4xx). */
  reasoningEffortParam?: boolean;
  /** Which max-output-tokens field the endpoint accepts. */
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  /** Advertised context length from /models when present; null = not exposed
   *  (trust the configured context window). */
  effectiveContext?: number | null;
}

/** How a role run is shaped for this model (replaces stored textMode/twoPhase):
 *  "single-turn" — custom tool calls are reliable, record_findings works;
 *  "two-turn"    — explore with built-in tools, verdict via a separate
 *                  constrained/formalize turn (today's twoPhase);
 *  "text"        — tool calling is unreliable altogether, fenced JSON only
 *                  (today's textMode). */
export type RunShape = "single-turn" | "two-turn" | "text";

/** The mechanism the verdict trailer should arrive by, most→least guaranteed. */
export type VerdictDelivery = "json_schema" | "guided_json" | "grammar" | "tool_call" | "fence";

/** The decisions `deriveProfile` computes — the measured replacements for the
 *  hand-set flags. Optional fields stay undefined when the evidence to decide
 *  them was never collected, so consumption falls back to the hand-set value. */
export interface DerivedDecisions {
  runShape: RunShape;
  verdictDelivery: VerdictDelivery;
  /** Whether this model can hold tools at all — consulted by overhaul/05 before
   *  seeding exec-dependent prompts (`run_command`). */
  toolCapable?: boolean;
  /** Whether pi should treat the model as a reasoning model. */
  reasoning?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
}

/** The human escape hatch: wins field-by-field over `derived`. Also the vessel
 *  for hand flags imported at first probe (rollout step 2). */
export type ProfileOverrides = Partial<DerivedDecisions>;

/** Hysteresis anchor: which runShape is currently in force and how many total
 *  runs the model had when it last changed — live-driven mode changes are
 *  allowed at most once per MODE_CHANGE_COOLDOWN_RUNS. */
export interface ModeState {
  runShape: RunShape;
  changedAtTotalRuns: number;
}

/** The stored profile object (model_profiles.profile_json). */
export interface ModelProfile {
  model: string;
  connectionSig: string;
  /** The base URL the probes ran against — display + staleness diagnosis. */
  baseUrl: string;
  probedAt: string | null;
  probes: BehaviorProbes;
  live: ModelLiveStats | null;
  derived: DerivedDecisions;
  /** Per-decision "why": which probe / live stat drove each derived field. */
  rationale: Record<string, string>;
  /** Promotion proposal for the UI — never auto-applied (no mode flapping). */
  suggestion: string | null;
  overrides: ProfileOverrides;
  modeState: ModeState | null;
}

// ---------------------------------------------------------------------------
// Policy constants (doc: named constants with rationale; tune from dogfooding)
// ---------------------------------------------------------------------------

/** Trials per behavioral probe. 5 keeps the whole suite ≈20 small requests
 *  (~1–2 min on a local box) while separating "works" from "flaky". */
export const PROBE_TRIALS = 5;

/** A probe channel counts as reliable at ≥80% (4/5). One dropped trial can be
 *  sampling noise; two is a pattern — and probes only need to be right enough
 *  to pick a SAFE STARTING mode (live calibration is the real signal). */
export const RELIABLE_MIN_RATE = 0.8;

/** Live rates are computed over the most recent N primary runs — recent enough
 *  to track a quantization/server change, wide enough to damp single failures. */
export const LIVE_WINDOW_RUNS = 30;

/** Don't act on live rates from fewer runs than this — 1 fallback in 3 runs is
 *  not a 33% failure rate, it's noise. */
export const MIN_LIVE_RUNS_FOR_DEMOTION = 10;

/** Custom-tool mode showing more than this fallback share over the live window
 *  demotes the run shape to two-turn (the doc's >10% signal). */
export const DEMOTION_FALLBACK_RATE = 0.1;

/** A demoted model whose live window is at least this clean earns a promotion
 *  SUGGESTION (surfaced in the UI, never auto-applied). */
export const PROMOTION_CLEAN_FALLBACK_RATE = 0.02;

/** How long a promotion SUGGESTION waits after the mode last changed before it
 *  will surface, so a noisy model can't get suggested back up the instant its
 *  cooldown opens. Does not gate demotions — those are a safety response to
 *  fresh evidence and apply immediately (see deriveProfile's hysteresis
 *  block). Probe-driven changes (a deliberate re-probe) are exempt entirely —
 *  the probe route derives with a fresh ModeState. */
export const MODE_CHANGE_COOLDOWN_RUNS = 30;

// ---------------------------------------------------------------------------
// The policy function
// ---------------------------------------------------------------------------

export interface DeriveResult {
  derived: DerivedDecisions;
  rationale: Record<string, string>;
  suggestion: string | null;
  modeState: ModeState;
}

function reliable(t: TrialProbe | undefined): boolean {
  return !!t && t.attempts > 0 && t.successes / t.attempts >= RELIABLE_MIN_RATE;
}

function probed(t: TrialProbe | undefined): t is TrialProbe {
  return !!t && t.attempts > 0;
}

function ratio(t: TrialProbe | undefined): string {
  return probed(t) ? `${t.successes}/${t.attempts}` : "unprobed";
}

/** More capable shapes rank higher; moving up the ranks is a promotion (which
 *  is never automatic), moving down is a demotion. */
const SHAPE_RANK: Record<RunShape, number> = { text: 0, "two-turn": 1, "single-turn": 2 };

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/**
 * Pure policy: probes + live aggregates (+ the previous mode state for
 * hysteresis) → derived decisions with a per-field rationale. Overrides are NOT
 * folded into `derived` — they stay separate so the UI can show "measured vs
 * overridden"; use {@link effectiveDecisions} for the merged view consumers act
 * on. Pass `prior = null` from the probe path (a deliberate re-probe adopts its
 * own verdicts immediately); pass the stored ModeState from the on-read refresh
 * path so live-driven changes honor the cooldown.
 */
export function deriveProfile(
  probes: BehaviorProbes,
  live: ModelLiveStats | null,
  prior?: ModeState | null,
): DeriveResult {
  const rationale: Record<string, string> = {};

  // ---- runShape from probes (conservative bias on ambiguity) ----
  let probeShape: RunShape;
  if (reliable(probes.customToolCall)) {
    probeShape = "single-turn";
    rationale.runShape = `custom tool calls reliable (${ratio(probes.customToolCall)})`;
  } else if (reliable(probes.builtinToolCall)) {
    probeShape = "two-turn";
    rationale.runShape = probed(probes.customToolCall)
      ? `custom tool calls unreliable (${ratio(probes.customToolCall)}) but built-in tool calls work (${ratio(probes.builtinToolCall)})`
      : `built-in tool calls work (${ratio(probes.builtinToolCall)}); custom tool calls unprobed — conservative two-turn`;
  } else if (probed(probes.builtinToolCall)) {
    probeShape = "text";
    rationale.runShape = `neither custom (${ratio(probes.customToolCall)}) nor built-in (${ratio(probes.builtinToolCall)}) tool calls reliable`;
  } else {
    // No behavioral evidence at all: the doc's "bias toward the conservative
    // two-turn shape on ambiguity".
    probeShape = "two-turn";
    rationale.runShape = "no tool-call probe data — defaulting to the conservative two-turn shape";
  }

  // ---- live demotion ----
  let target = probeShape;
  if (
    target === "single-turn" &&
    live &&
    live.runs >= MIN_LIVE_RUNS_FOR_DEMOTION &&
    live.fallbackRate > DEMOTION_FALLBACK_RATE
  ) {
    target = "two-turn";
    rationale.runShape = `demoted from single-turn: live fallback rate ${pct(live.fallbackRate)} over the last ${live.runs} runs exceeds ${pct(DEMOTION_FALLBACK_RATE)}`;
  }

  // ---- hysteresis + suggestion-only promotion ----
  // Asymmetric on purpose: a DEMOTION is the system reacting to fresh evidence
  // of a live failure rate (already gated by MIN_LIVE_RUNS_FOR_DEMOTION above)
  // and takes effect immediately — waiting out a cooldown while a mode keeps
  // producing fallbacks would defeat the point of continuous calibration. A
  // PROMOTION is never automatic regardless of cooldown: sustained clean runs
  // under a demoted shape say nothing about the failure channel that caused
  // the demotion in the first place, so it only ever surfaces as a suggestion.
  // MODE_CHANGE_COOLDOWN_RUNS gates *that suggestion*, not the demotion path —
  // it keeps a UI suggestion from appearing the instant a demotion's cooldown
  // window opens, before enough clean signal has actually accumulated.
  let suggestion: string | null = null;
  let modeState: ModeState = prior ?? { runShape: target, changedAtTotalRuns: live?.totalRuns ?? 0 };
  if (prior && target !== prior.runShape) {
    if (SHAPE_RANK[target] > SHAPE_RANK[prior.runShape]) {
      const runsSinceChange = (live?.totalRuns ?? 0) - prior.changedAtTotalRuns;
      if (
        live &&
        live.runs >= MIN_LIVE_RUNS_FOR_DEMOTION &&
        live.fallbackRate <= PROMOTION_CLEAN_FALLBACK_RATE &&
        runsSinceChange >= MODE_CHANGE_COOLDOWN_RUNS
      ) {
        suggestion =
          `Probes support "${target}" and the last ${live.runs} runs were clean ` +
          `(fallback rate ${pct(live.fallbackRate)}) — consider promoting runShape to "${target}" ` +
          `(re-probe or set an override).`;
      }
      target = prior.runShape;
      rationale.runShape = `holding "${prior.runShape}" (previously calibrated down; promotion is suggestion-only)`;
    } else {
      modeState = { runShape: target, changedAtTotalRuns: live?.totalRuns ?? 0 };
    }
  }
  if (modeState.runShape !== target) modeState = { ...modeState, runShape: target };

  // ---- verdict delivery: most guaranteed mechanism the evidence supports ----
  let verdictDelivery: VerdictDelivery;
  const s = probes.structured;
  if (s?.json_schema) {
    verdictDelivery = "json_schema";
    rationale.verdictDelivery = "endpoint honors response_format json_schema (sampler-guaranteed)";
  } else if (s?.guided_json) {
    verdictDelivery = "guided_json";
    rationale.verdictDelivery = "endpoint honors vLLM guided_json (sampler-guaranteed)";
  } else if (s?.grammar) {
    verdictDelivery = "grammar";
    rationale.verdictDelivery = "endpoint honors llama.cpp GBNF grammar (sampler-guaranteed)";
  } else if (target === "single-turn") {
    verdictDelivery = "tool_call";
    rationale.verdictDelivery = `no server-side constrained decoding; custom tool calls reliable (${ratio(probes.customToolCall)})`;
  } else {
    verdictDelivery = "fence";
    rationale.verdictDelivery = probed(probes.jsonFence)
      ? `no server-side constrained decoding or reliable custom tool calls; fenced JSON parsed on ${ratio(probes.jsonFence)} trials`
      : "no server-side constrained decoding or reliable custom tool calls — fenced JSON fallback";
  }

  const derived: DerivedDecisions = { runShape: target, verdictDelivery };

  // ---- the rest: direct observations mapped through ----
  if (probed(probes.customToolCall) || probed(probes.builtinToolCall)) {
    derived.toolCapable = reliable(probes.customToolCall) || reliable(probes.builtinToolCall);
    rationale.toolCapable = derived.toolCapable
      ? `tool calls arrived well-formed (custom ${ratio(probes.customToolCall)}, built-in ${ratio(probes.builtinToolCall)})`
      : `no tool channel reached ${pct(RELIABLE_MIN_RATE)} (custom ${ratio(probes.customToolCall)}, built-in ${ratio(probes.builtinToolCall)})`;
  }
  if (probes.thinkingDialect !== undefined) {
    derived.reasoning = probes.thinkingDialect !== "none";
    rationale.reasoning =
      probes.thinkingDialect === "reasoning_content"
        ? "reasoning arrived on the reasoning_content channel"
        : probes.thinkingDialect === "think_tags"
          ? "reasoning arrived as literal <think> tags in answer text (think-splitter needed)"
          : "no reasoning channel observed";
  }
  if (probes.developerRole !== undefined) {
    derived.supportsDeveloperRole = probes.developerRole;
    rationale.supportsDeveloperRole = probes.developerRole
      ? "endpoint accepted a developer-role message"
      : "endpoint rejected a developer-role message (4xx)";
  }
  if (probes.reasoningEffortParam !== undefined) {
    derived.supportsReasoningEffort = probes.reasoningEffortParam;
    rationale.supportsReasoningEffort = probes.reasoningEffortParam
      ? "endpoint accepted reasoning_effort"
      : "endpoint rejected reasoning_effort (4xx)";
  }
  if (probes.maxTokensField !== undefined) {
    derived.maxTokensField = probes.maxTokensField;
    rationale.maxTokensField = `endpoint accepted ${probes.maxTokensField}`;
  }

  return { derived, rationale, suggestion, modeState };
}

/** The merged view consumers act on: measured decisions with the human (or
 *  imported hand-flag) overrides winning field-by-field. Undefined override
 *  values are skipped so a partial override bag can't erase a measurement. */
export function effectiveDecisions(profile: ModelProfile): DerivedDecisions {
  const out: Record<string, unknown> = { ...profile.derived };
  for (const [k, v] of Object.entries(profile.overrides ?? {})) {
    if (v !== undefined) out[k] = v;
  }
  return out as unknown as DerivedDecisions;
}

// ---------------------------------------------------------------------------
// Probe suite
// ---------------------------------------------------------------------------

/** Per-trial output cap — these are conformance checks, not real work. The
 *  dialect sniff gets more room since reasoning has to fit before the answer. */
const TRIAL_MAX_TOKENS = 256;
const DIALECT_MAX_TOKENS = 768;
const PROBE_TIMEOUT_MS = 30_000;

const FENCE_SCHEMA = Type.Object({ answer: Type.String() });

/** Progress callback shape for the SSE probe route. */
export interface ProbeProgress {
  step: string;
  status: "start" | "done";
  detail?: unknown;
}

async function postCompletion(
  baseUrl: string,
  apiKey: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: unknown } | { error: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    let res: Response;
    try {
      res = await fetch(baseUrl.replace(/\/+$/, "") + "/chat/completions", {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify(payload),
      });
    } finally {
      clearTimeout(timer);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    return { status: res.status, body };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

interface ToolCallShape {
  function?: { name?: string; arguments?: string };
}

function firstToolCall(body: unknown): ToolCallShape | undefined {
  const choices = (
    body as { choices?: Array<{ message?: { tool_calls?: ToolCallShape[] } }> } | undefined
  )?.choices;
  return choices?.[0]?.message?.tool_calls?.[0];
}

function messageOf(body: unknown): Record<string, unknown> | undefined {
  const choices = (body as { choices?: Array<{ message?: Record<string, unknown> }> } | undefined)
    ?.choices;
  return choices?.[0]?.message;
}

function contentOf(body: unknown): string | null {
  const content = messageOf(body)?.content;
  return typeof content === "string" ? content : null;
}

/** One custom-tool-call trial: did a well-formed `record_answer` call arrive?
 *  Structure-only assertion — the actual answer text is irrelevant. */
async function customToolCallTrial(baseUrl: string, apiKey: string, modelId: string): Promise<boolean> {
  const result = await postCompletion(baseUrl, apiKey, {
    model: modelId,
    max_tokens: TRIAL_MAX_TOKENS,
    messages: [
      {
        role: "user",
        content:
          "What color is a clear daytime sky? Answer by calling the record_answer tool with your one-word answer.",
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "record_answer",
          description: "Record your final one-word answer.",
          parameters: {
            type: "object",
            properties: { answer: { type: "string" } },
            required: ["answer"],
          },
        },
      },
    ],
  });
  if ("error" in result || result.status < 200 || result.status >= 300) return false;
  const call = firstToolCall(result.body);
  if (!call || call.function?.name !== "record_answer") return false;
  try {
    const args: unknown = JSON.parse(call.function?.arguments ?? "");
    return (
      !!args &&
      typeof args === "object" &&
      typeof (args as { answer?: unknown }).answer === "string" &&
      ((args as { answer: string }).answer.length > 0)
    );
  } catch {
    return false;
  }
}

/** One built-in-style tool trial: a `read_file` tool with a required path
 *  argument — the shape every harness tool takes. */
async function builtinToolCallTrial(baseUrl: string, apiKey: string, modelId: string): Promise<boolean> {
  const result = await postCompletion(baseUrl, apiKey, {
    model: modelId,
    max_tokens: TRIAL_MAX_TOKENS,
    messages: [
      {
        role: "user",
        content: "Use the read_file tool to read the file at /tmp/orchestra-probe.txt.",
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file from disk and return its contents.",
          parameters: {
            type: "object",
            properties: { path: { type: "string", description: "Absolute path of the file to read." } },
            required: ["path"],
          },
        },
      },
    ],
  });
  if ("error" in result || result.status < 200 || result.status >= 300) return false;
  const call = firstToolCall(result.body);
  if (!call || call.function?.name !== "read_file") return false;
  try {
    const args: unknown = JSON.parse(call.function?.arguments ?? "");
    return (
      !!args &&
      typeof args === "object" &&
      typeof (args as { path?: unknown }).path === "string" &&
      ((args as { path: string }).path.length > 0)
    );
  } catch {
    return false;
  }
}

/** One fenced-JSON trial: text-mode-style instruction, tiny schema. */
async function jsonFenceTrial(baseUrl: string, apiKey: string, modelId: string): Promise<boolean> {
  const result = await postCompletion(baseUrl, apiKey, {
    model: modelId,
    max_tokens: TRIAL_MAX_TOKENS,
    messages: [
      {
        role: "user",
        content:
          'Reply with ONLY a JSON object of the shape {"answer": "<one word>"} answering this question: what color is a clear daytime sky? You may wrap it in a ```json fence.',
      },
    ],
  });
  if ("error" in result || result.status < 200 || result.status >= 300) return false;
  const content = contentOf(result.body);
  if (!content) return false;
  const fence = /```(?:json)?\s*\n?([\s\S]*?)```/.exec(content);
  const raw = (fence?.[1] ?? content).trim();
  try {
    return Value.Check(FENCE_SCHEMA, JSON.parse(raw));
  } catch {
    return false;
  }
}

/** One reasoning prompt; inspect WHERE the reasoning arrived. */
async function thinkingDialectTrial(
  baseUrl: string,
  apiKey: string,
  modelId: string,
): Promise<ThinkingDialect | undefined> {
  const result = await postCompletion(baseUrl, apiKey, {
    model: modelId,
    max_tokens: DIALECT_MAX_TOKENS,
    messages: [
      { role: "user", content: "What is 17 + 25? Think it through step by step, then give the final number." },
    ],
  });
  if ("error" in result || result.status < 200 || result.status >= 300) return undefined;
  const message = messageOf(result.body);
  if (!message) return undefined;
  // Servers name the separate channel `reasoning_content` (DeepSeek/Qwen
  // dialects) or `reasoning` (OpenRouter-style) — either counts.
  const channel = message.reasoning_content ?? message.reasoning;
  if (typeof channel === "string" && channel.trim().length > 0) return "reasoning_content";
  const content = typeof message.content === "string" ? message.content : "";
  if (content.includes("<think>")) return "think_tags";
  return "none";
}

/** Param-acceptance probe: 2xx = accepted, 4xx = rejected, transport error /
 *  5xx = unknown (leave undefined — don't turn an outage into a conclusion). */
async function paramAcceptanceTrial(
  baseUrl: string,
  apiKey: string,
  payload: Record<string, unknown>,
): Promise<boolean | undefined> {
  const result = await postCompletion(baseUrl, apiKey, payload);
  if ("error" in result) return undefined;
  if (result.status >= 200 && result.status < 300) return true;
  if (result.status >= 400 && result.status < 500) return false;
  return undefined;
}

/** Cheap effective-context read: trust the endpoint's advertised /models
 *  context length when present (Ollama's context_length, vLLM's max_model_len);
 *  null = not exposed (the bisection probe is the doc's ship-later option). */
async function effectiveContextProbe(
  baseUrl: string,
  apiKey: string,
  modelId: string,
): Promise<number | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    let res: Response;
    try {
      res = await fetch(baseUrl.replace(/\/+$/, "") + "/models", { headers, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
    const list = Array.isArray(data) ? data : (data.data ?? []);
    const entry = list.find((m) => {
      const id = typeof m.id === "string" ? m.id : "";
      return id === modelId || id.replace(/^.*[/\\]/, "") === modelId;
    });
    if (!entry) return null;
    for (const field of ["context_length", "max_model_len", "max_context_length", "context_window"]) {
      const v = entry[field];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    }
    return null;
  } catch {
    return null;
  }
}

async function runTrials(
  trial: () => Promise<boolean>,
  attempts = PROBE_TRIALS,
): Promise<TrialProbe> {
  let successes = 0;
  // Sequential on purpose: a local single-GPU box serves one request at a time
  // anyway, and parallel probes would just skew each other's latency/timeouts.
  for (let i = 0; i < attempts; i++) {
    if (await trial()) successes += 1;
  }
  return { attempts, successes };
}

/** Ordered step keys, exported so the SSE route and the client render the same
 *  progress list without duplicating it. */
export const PROBE_STEPS = [
  "structured",
  "customToolCall",
  "builtinToolCall",
  "jsonFence",
  "thinkingDialect",
  "params",
  "effectiveContext",
] as const;

/**
 * Run the full behavioral probe suite against the actual model. ≈20 small
 * max_tokens-capped requests, run sequentially; emits per-step progress for the
 * SSE route. Never throws for endpoint-side failures — an unreachable endpoint
 * simply yields 0/K trials and undefined param observations, which derive into
 * the conservative shape.
 */
export async function runModelProbes(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  onProgress?: (ev: ProbeProgress) => void,
): Promise<BehaviorProbes> {
  const progress = (step: string, status: "start" | "done", detail?: unknown) =>
    onProgress?.({ step, status, detail });
  const probes: BehaviorProbes = {};

  progress("structured", "start");
  probes.structured = (await probeStructuredOutputs(baseUrl, apiKey, modelId)).modes;
  progress("structured", "done", probes.structured);

  progress("customToolCall", "start");
  probes.customToolCall = await runTrials(() => customToolCallTrial(baseUrl, apiKey, modelId));
  progress("customToolCall", "done", probes.customToolCall);

  progress("builtinToolCall", "start");
  probes.builtinToolCall = await runTrials(() => builtinToolCallTrial(baseUrl, apiKey, modelId));
  progress("builtinToolCall", "done", probes.builtinToolCall);

  progress("jsonFence", "start");
  probes.jsonFence = await runTrials(() => jsonFenceTrial(baseUrl, apiKey, modelId));
  progress("jsonFence", "done", probes.jsonFence);

  progress("thinkingDialect", "start");
  probes.thinkingDialect = await thinkingDialectTrial(baseUrl, apiKey, modelId);
  progress("thinkingDialect", "done", probes.thinkingDialect);

  progress("params", "start");
  const ok = 'Reply with the single word "ok".';
  probes.developerRole = await paramAcceptanceTrial(baseUrl, apiKey, {
    model: modelId,
    max_tokens: 16,
    messages: [
      { role: "developer", content: "You are a terse assistant." },
      { role: "user", content: ok },
    ],
  });
  probes.reasoningEffortParam = await paramAcceptanceTrial(baseUrl, apiKey, {
    model: modelId,
    max_tokens: 16,
    reasoning_effort: "low",
    messages: [{ role: "user", content: ok }],
  });
  const acceptsCompletionTokens = await paramAcceptanceTrial(baseUrl, apiKey, {
    model: modelId,
    max_completion_tokens: 16,
    messages: [{ role: "user", content: ok }],
  });
  probes.maxTokensField =
    acceptsCompletionTokens === true
      ? "max_completion_tokens"
      : acceptsCompletionTokens === false
        ? "max_tokens"
        : undefined;
  progress("params", "done", {
    developerRole: probes.developerRole,
    reasoningEffortParam: probes.reasoningEffortParam,
    maxTokensField: probes.maxTokensField,
  });

  progress("effectiveContext", "start");
  probes.effectiveContext = await effectiveContextProbe(baseUrl, apiKey, modelId);
  progress("effectiveContext", "done", probes.effectiveContext);

  return probes;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Cheap stored-profile read for the resolution hot path: one PK SELECT + a
 *  JSON.parse, NO recompute (recompute happens on API reads and probe writes —
 *  the doc's "simplest viable" calibration job). Malformed JSON reads as "no
 *  profile", which resolves to today's hand-flag behavior. */
export function loadProfile(connectionSig: string, modelId: string): ModelProfile | null {
  const row = getModelProfileRow(connectionSig, modelId);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.profile_json) as Partial<ModelProfile>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.model !== "string" || !parsed.derived) {
      return null;
    }
    return {
      model: parsed.model,
      connectionSig: parsed.connectionSig ?? row.connection_sig,
      baseUrl: parsed.baseUrl ?? "",
      probedAt: parsed.probedAt ?? null,
      probes: parsed.probes ?? {},
      live: parsed.live ?? null,
      derived: parsed.derived,
      rationale: parsed.rationale ?? {},
      suggestion: parsed.suggestion ?? null,
      overrides: parsed.overrides ?? {},
      modeState: parsed.modeState ?? null,
    };
  } catch {
    return null;
  }
}

export function saveProfile(profile: ModelProfile): void {
  upsertModelProfileRow(profile.connectionSig, profile.model, JSON.stringify(profile));
}

export function deleteProfile(connectionSig: string, modelId: string): void {
  deleteModelProfileRow(connectionSig, modelId);
}

/** Continuous calibration, read-path variant: fold the current live aggregates
 *  in, re-derive with the stored ModeState (hysteresis applies), persist, and
 *  return the refreshed profile. */
export function refreshProfile(profile: ModelProfile): ModelProfile {
  const live = getModelLiveStats(profile.model, LIVE_WINDOW_RUNS);
  const res = deriveProfile(profile.probes, live, profile.modeState);
  const next: ModelProfile = {
    ...profile,
    live,
    derived: res.derived,
    rationale: res.rationale,
    suggestion: res.suggestion,
    modeState: res.modeState,
  };
  saveProfile(next);
  return next;
}

/** All stored profiles, refreshed against current live data. */
export function listProfiles(): ModelProfile[] {
  const out: ModelProfile[] = [];
  for (const row of listModelProfileRows()) {
    const profile = loadProfile(row.connection_sig, row.model_id);
    if (profile) out.push(refreshProfile(profile));
  }
  return out;
}

/**
 * Build + persist a profile from a fresh probe run. A deliberate probe adopts
 * its own verdicts immediately (prior = null, exempt from hysteresis).
 * `overrides` is what the caller wants to carry: existing overrides on a
 * re-probe, the imported hand flags on a first probe, or {} on a reset.
 */
export function buildProfileFromProbes(
  baseUrl: string,
  modelId: string,
  probes: BehaviorProbes,
  overrides: ProfileOverrides,
): ModelProfile {
  const live = getModelLiveStats(modelId, LIVE_WINDOW_RUNS);
  const res = deriveProfile(probes, live, null);
  const profile: ModelProfile = {
    model: modelId,
    connectionSig: profileConnectionSig(baseUrl),
    baseUrl: baseUrl.replace(/\/+$/, ""),
    probedAt: new Date().toISOString(),
    probes,
    live,
    derived: res.derived,
    rationale: res.rationale,
    suggestion: res.suggestion,
    overrides,
    modeState: res.modeState,
  };
  saveProfile(profile);
  return profile;
}
