/**
 * Connection profile resolution — the runtime-editable, inheritable layer that
 * sits above the static bootstrap config (config.ts).
 *
 * config.ts holds the *seed* (built-in defaults ← config.json ← ORCHESTRA_* env).
 * The DB `configs` table holds the *editable* connection profiles, seeded once
 * from that effective config. `resolveConnection()` merges, lowest → highest
 * precedence:
 *   1. built-in numeric defaults (context window / max tokens / timeout)
 *   2. global config row     (configs: project_id NULL, key='default')
 *   3. project override row   (configs: project_id=X, key='default')   [later]
 *   4. ORCHESTRA_* env        (base URL + API key only)
 *
 * Env wins for base URL + API key so the auth token can live *only* in the
 * environment and stay out of the SQLite file if the operator prefers.
 */

import { getConfig } from "./config.js";
import { getGlobalConfig, getProjectConfig, listModelConfigs, upsertConfig, type ConfigRow } from "./db.js";
import type { ProbeResult } from "./probe.js";
import {
  effectiveDecisions,
  loadProfile,
  profileConnectionSig,
  type ProfileOverrides,
} from "./profiles.js";

/** Per-thinking-level reasoning token budgets (mirrors pi's ThinkingBudgets). */
export interface ThinkingBudgets {
  minimal?: number;
  low?: number;
  medium?: number;
  high?: number;
}

/**
 * Check whether the ORCHESTRA_TOKENS env var overrides a model config's API key.
 * Returns the env token string if found, or undefined.
 */
export function envTokenForModel(name: string | null): string | undefined {
  if (!name) return undefined;
  const map = getConfig().tokenMap;
  return map[name];
}

/**
 * Derive a "local" / "api" label from a base URL.
 * Private / localhost / tailnet → "local", public APIs → "api", unknown → null.
 */
export function locationLabel(url: string | null | undefined): string | null {
  if (!url) return null;
  const host = url.replace(/^https?:\/\//, "").split(/[/:]/)[0] ?? "";
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.endsWith(".ts.net") ||
    host.startsWith("192.168.") ||
    host.startsWith("10.") ||
    (host.startsWith("172.") && (() => {
      const second = parseInt(host.split(".")[1] ?? "", 10);
      return second >= 16 && second <= 31;
    })())
  ) {
    return "local";
  }
  return "api";
}

/**
 * Valid pi `thinkingFormat` dialects (one per model family / reasoning API shape).
 * Mirrors the enum in @earendil-works/pi-ai's OpenAICompletionsCompat; the server
 * validates PATCH /api/config against this set and the client dropdown labels them.
 */
export const THINKING_FORMATS = [
  "qwen-chat-template",
  "qwen",
  "deepseek",
  "zai",
  "openai",
  "openrouter",
  "together",
  "string-thinking",
  "chat-template",
  "ant-ling",
] as const;

export type ThinkingFormat = (typeof THINKING_FORMATS)[number];

/** pi Model compat options stored as a JSON blob on the config row. */
export interface ModelCompat {
  /** Use `developer` vs `system` role for reasoning models (default: true). */
  supportsDeveloperRole?: boolean;
  /** Whether the endpoint accepts `reasoning_effort` (default: true). */
  supportsReasoningEffort?: boolean;
  /** Which field name to use for max output tokens: `max_completion_tokens` or `max_tokens`. */
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  /** Custom kwargs for `chat-template` thinking format, e.g. `{ "thinking": { "$var": "thinking.enabled" } }`. */
  chatTemplateKwargs?: Record<string, unknown>;
  /** Per-thinking-level reasoning token budgets: {"minimal": 1024, "low": 4096, …}.
   *  Passed to pi's SettingsManager so providers that support token-based thinking
   *  caps can constrain reasoning tokens separately from the max_tokens budget. */
  thinkingBudgets?: ThinkingBudgets;
  /** Overrides agent.ts's DEFAULT_PREEMPTIVE_NUDGE_CHARS — answer-text characters
   *  without a tool call before the pre-emptive stall nudge aborts the turn. */
  nudgeThresholdChars?: number;
  /** Text-mode counterpart of nudgeThresholdChars (overrides
   *  DEFAULT_PREEMPTIVE_NUDGE_CHARS_TEXT_MODE). */
  nudgeThresholdCharsTextMode?: number;
  /** Reasoning/thinking-channel counterpart of nudgeThresholdChars (overrides
   *  DEFAULT_PREEMPTIVE_NUDGE_CHARS_THINKING) — guards against a role that
   *  reasons at length without emitting answer text (e.g. twoPhase Phase 1)
   *  running until an external/provider timeout discards it. */
  nudgeThresholdCharsThinking?: number;
  /** Which role output contract this endpoint's models are prompted with
   *  (PLANNING/overhaul/01). "artifact-first" (the default when unset): the
   *  report streams to the task artifact (report_section / answer prose) and
   *  the structured payload shrinks to a small verdict trailer. "v1": the
   *  legacy contract — the full markdown report embedded in one terminal JSON
   *  blob as section_md. Per-endpoint revert switch for a model that
   *  misbehaves under the new contract; no deploy needed. Parsing always
   *  accepts both shapes regardless of this setting. */
  outputContract?: "v1" | "artifact-first";
  /** Manual override of which structured-output rung to use (PLANNING/overhaul/02).
   *  "off" forces the legacy tool-call/text-fence path even if a probe found
   *  json_schema/guided_json/grammar support. Unset: derived from the cached probe
   *  result on the config row (highest supported rung), or "off" if never probed. */
  structuredOutputsOverride?: "json_schema" | "guided_json" | "grammar" | "off";
  /** Softer stall handling (PLANNING/overhaul/03 §3). When true, the pre-emptive
   *  character-count nudges and the narration-pattern stall stop firing a
   *  mid-stream `session.abort()` — they only note the signal and let the turn
   *  finish (bounded by the provider's own max_tokens), after which the
   *  repair/resume ladder recovers the verdict. A true repetition-loop stall
   *  (the same sentence repeated past threshold) still aborts, since the rest of
   *  that stream is provably worthless. Default (unset/false) preserves today's
   *  abort-on-nudge behavior; flip it per connection only once repair+resume are
   *  proven to cover the truncation cases the nudges were protecting against
   *  (the doc's migration step 3). Retiring it hinges on the two-turn shape from
   *  overhaul/02: the working turn is allowed to end without a verdict because
   *  the verdict comes from a separate constrained/repair turn. */
  retirePreemptiveNudge?: boolean;
}

/** The resolved structured-output rung for a connection: the highest mode the
 *  cached probe found (or the manual override, which always wins), collapsed to
 *  the two rungs agent.ts/router.ts actually request — "json_object" alone isn't
 *  enough to guarantee schema conformance, so it never resolves to "on". */
export interface ResolvedStructuredOutputs {
  mode: "json_schema" | "guided_json" | "grammar" | "off";
  probedAt?: string;
}

/** Fully resolved connection settings for a single model call. */
export interface Connection {
  baseUrl: string;
  apiKey: string;
  api: string;
  defaultModelId: string;
  contextWindow: number;
  maxTokens: number;
  requestTimeoutMs: number;
  /** Whether pi should treat the model as a reasoning model (enables a thinking level). */
  reasoning: boolean;
  /** Thinking level for pi when reasoning is enabled. */
  thinkingLevel: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** pi reasoning request dialect (model family): deepseek | qwen | qwen-chat-template | … */
  thinkingFormat: string;
  /** When true, record_findings is NOT registered as a tool and the model is
   *  instructed to output findings as JSON in markdown instead. Opt-in for
   *  models whose native function-calling is unreliable. Superseded by twoPhase. */
  textMode: boolean;
  /** When true, the role run is split into two phases within one session:
   *  phase 1 explores with tools and produces a natural-language summary;
   *  phase 2 formalizes that summary as structured JSON (no custom tool call).
   *  Supersedes textMode — use this for models whose built-in tool usage works
   *  but whose custom tool calling (record_findings) is unreliable. */
  twoPhase: boolean;
  /** pi Model compat overrides for this endpoint (merged from config row's compat_json). */
  compat: ModelCompat;
  /** Per-thinking-level reasoning token budgets (merged from config row's thinking_budgets). */
  thinkingBudgets?: ThinkingBudgets;
  /** Resolved server-side structured-decoding rung (PLANNING/overhaul/02): cached
   *  probe result (`configs.structured_outputs_json`) + compat.structuredOutputsOverride,
   *  override wins. "off" until a probe has run (or the probe found nothing usable). */
  structuredOutputs: ResolvedStructuredOutputs;
  /** Measured effective context window from the model's capability profile
   *  (PLANNING/overhaul/06 `BehaviorProbes.effectiveContext`, PLANNING/overhaul/07's
   *  context ledger). null/undefined = never probed or the endpoint didn't expose
   *  it — callers fall back to `contextWindow`. Only ever set by
   *  `applyProfileToConnection`; the hand-flag resolution paths leave it unset. */
  effectiveContext?: number | null;
}

/**
 * Seed the global default profile once from the effective bootstrap config, so
 * an existing config.json base URL / key migrates into an editable DB row on
 * first boot. No-op if the global row already exists.
 */
export function seedGlobalConfig(): void {
  if (getGlobalConfig()) return;
  const cfg = getConfig();
  upsertConfig({
    project_id: null,
    key: "default",
    name: "Default",
    base_url: cfg.providerBaseUrl,
    api_key: cfg.apiKey || null,
    api: "openai-completions",
    default_model: cfg.defaultModelId,
    context_window: cfg.contextWindow,
    max_tokens: cfg.maxTokens,
    request_timeout_ms: cfg.requestTimeoutMs,
    reasoning: cfg.reasoning ? 1 : 0,
    thinking_level: cfg.thinkingLevel,
    thinking_format: cfg.thinkingFormat,
  });
  console.log("[config] seeded global default connection profile");
}

function pick<T>(...vals: (T | null | undefined)[]): T | undefined {
  for (const v of vals) if (v != null) return v as T;
  return undefined;
}

/** A nullable 0/1 DB flag → boolean, or undefined when unset (so `pick` falls through). */
function boolFromDb(v: number | null | undefined): boolean | undefined {
  return v == null ? undefined : v !== 0;
}

/** Parse a `compat_json` string into a ModelCompat object, swallowing errors. */
function parseCompat(raw: string | null | undefined): ModelCompat {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return {};
    return obj as ModelCompat;
  } catch {
    return {};
  }
}

/** Parse a `structured_outputs_json` string into a cached ProbeResult. */
function parseProbeResult(raw: string | null | undefined): ProbeResult | undefined {
  if (!raw) return undefined;
  try {
    const obj = JSON.parse(raw) as Partial<ProbeResult>;
    if (!obj || typeof obj !== "object" || !obj.modes) return undefined;
    return obj as ProbeResult;
  } catch {
    return undefined;
  }
}

/** Normalize a base URL for probe-freshness comparison: trailing slashes are
 *  insignificant (fetch strips them before appending the route), so a probe
 *  taken against `…/v1` still matches a connection resolved to `…/v1/`. */
function normalizeBaseUrl(url: string | null | undefined): string {
  return (url ?? "").replace(/\/+$/, "");
}

/** A cached probe describes a specific (baseUrl, modelId) pair. If either has
 *  since changed — the user edited the connection, or an ORCHESTRA_BASE_URL env
 *  override now points elsewhere than what was probed — the cached modes no
 *  longer describe the endpoint we're about to call, so the probe is stale and
 *  must be ignored (resolving to "off", the fail-safe rung) rather than trusted.
 *  The doc's design: results are invalidated when the base URL or model id
 *  changes; since probing is manual, this check enforces it at resolve time. */
function probeIsFresh(probe: ProbeResult, baseUrl: string, modelId: string): boolean {
  return normalizeBaseUrl(probe.baseUrl) === normalizeBaseUrl(baseUrl) && probe.modelId === modelId;
}

/** Resolve the highest server-side structured-decoding rung a connection can use:
 *  a manual `structuredOutputsOverride` always wins (it's a deliberate operator
 *  choice, independent of any probe); otherwise derive it from the cached probe
 *  result (json_schema preferred over guided_json over grammar; json_object
 *  alone never resolves "on" — it doesn't guarantee schema conformance). A probe
 *  taken against a different baseUrl/modelId than the connection now resolves to
 *  is treated as absent (stale). No usable probe resolves to "off", not an
 *  optimistic guess. `baseUrl`/`modelId` are the values the connection will
 *  actually call with (the probe stored the pair it was taken against). */
function resolveStructuredOutputs(
  compat: ModelCompat,
  probe: ProbeResult | undefined,
  baseUrl: string,
  modelId: string,
): ResolvedStructuredOutputs {
  const fresh = probe && probeIsFresh(probe, baseUrl, modelId) ? probe : undefined;
  if (compat.structuredOutputsOverride) {
    return { mode: compat.structuredOutputsOverride, probedAt: fresh?.probedAt };
  }
  if (fresh?.modes.json_schema) return { mode: "json_schema", probedAt: fresh.probedAt };
  if (fresh?.modes.guided_json) return { mode: "guided_json", probedAt: fresh.probedAt };
  if (fresh?.modes.grammar) return { mode: "grammar", probedAt: fresh.probedAt };
  return { mode: "off", probedAt: fresh?.probedAt };
}

/** Parse a `thinking_budgets` JSON string into a ThinkingBudgets object. */
function parseThinkingBudgets(raw: string | null | undefined): ThinkingBudgets | undefined {
  if (!raw) return undefined;
  try {
    const obj = JSON.parse(raw);
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return undefined;
    const budgets: ThinkingBudgets = {};
    if (typeof obj.minimal === "number") budgets.minimal = obj.minimal;
    if (typeof obj.low === "number") budgets.low = obj.low;
    if (typeof obj.medium === "number") budgets.medium = obj.medium;
    if (typeof obj.high === "number") budgets.high = obj.high;
    return Object.keys(budgets).length > 0 ? budgets : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the effective connection for a project (or global when omitted).
 * Merges global ← project row, then overlays ORCHESTRA_* env for base URL/key.
 */
export function resolveConnection(projectId?: number | null): Connection {
  const cfg = getConfig();
  const global: ConfigRow | undefined = getGlobalConfig();
  const project: ConfigRow | undefined =
    projectId == null ? undefined : getProjectConfig(projectId);

  // Env wins for the two secret-ish fields (read raw so it beats the DB rows).
  const envBaseUrl = process.env.ORCHESTRA_BASE_URL;
  const envApiKey = process.env.ORCHESTRA_API_KEY;

  // compat_json merges: project overrides global, both are parsed JSON blobs.
  const globalCompat = parseCompat(global?.compat_json);
  const projectCompat = parseCompat(project?.compat_json);
  const compat: ModelCompat = { ...globalCompat, ...projectCompat };
  const probe = parseProbeResult(pick(project?.structured_outputs_json, global?.structured_outputs_json));

  // Resolved before the return object so the structured-outputs probe-freshness
  // check can compare against the exact baseUrl/modelId this connection calls.
  const baseUrl = pick(envBaseUrl, project?.base_url, global?.base_url, cfg.providerBaseUrl)!;
  const defaultModelId = pick(project?.default_model, global?.default_model, cfg.defaultModelId)!;

  return {
    baseUrl,
    apiKey: pick(envApiKey, project?.api_key, global?.api_key, cfg.apiKey) ?? "",
    api: pick(project?.api, global?.api) ?? "openai-completions",
    defaultModelId,
    contextWindow: pick(project?.context_window, global?.context_window, cfg.contextWindow)!,
    maxTokens: pick(project?.max_tokens, global?.max_tokens, cfg.maxTokens)!,
    requestTimeoutMs: pick(project?.request_timeout_ms, global?.request_timeout_ms, cfg.requestTimeoutMs)!,
    // reasoning/thinking_level are stored as 0/1 and text; NULL falls back to bootstrap config.
    reasoning: pick(boolFromDb(project?.reasoning), boolFromDb(global?.reasoning), cfg.reasoning)!,
    thinkingLevel: pick(project?.thinking_level, global?.thinking_level, cfg.thinkingLevel)! as Connection["thinkingLevel"],
    thinkingFormat: pick(project?.thinking_format, global?.thinking_format, cfg.thinkingFormat)!,
    textMode: pick(boolFromDb(project?.text_mode), boolFromDb(global?.text_mode)) ?? false,
    twoPhase: pick(boolFromDb(project?.two_phase), boolFromDb(global?.two_phase)) ?? false,
    compat,
    thinkingBudgets: pick(
      parseThinkingBudgets(project?.thinking_budgets),
      parseThinkingBudgets(global?.thinking_budgets),
    ),
    structuredOutputs: resolveStructuredOutputs(compat, probe, baseUrl, defaultModelId),
  };
}

/**
 * Build a Connection from a single named model-config row. Unlike
 * resolveConnection(), this does NOT merge with the project/global 'default'
 * row — a named config (created via the Models UI) is a complete, standalone
 * profile with its own base_url/api_key/text_mode/two_phase/compat. Bootstrap
 * config only fills in fields the row itself leaves unset.
 *
 * Exported for the capability-profile probe route (routes/api.ts), which needs
 * the row's HAND-FLAG resolution (no profile applied) to import as overrides.
 */
export function connectionFromConfigRow(row: ConfigRow): Connection {
  const cfg = getConfig();
  const envBaseUrl = process.env.ORCHESTRA_BASE_URL;
  const envApiKey = process.env.ORCHESTRA_API_KEY;
  const baseUrl = pick(envBaseUrl, row.base_url, cfg.providerBaseUrl)!;
  const defaultModelId = pick(row.default_model, cfg.defaultModelId)!;
  return {
    baseUrl,
    apiKey: pick(envApiKey, row.api_key, cfg.apiKey) ?? "",
    api: row.api ?? "openai-completions",
    defaultModelId,
    contextWindow: pick(row.context_window, cfg.contextWindow)!,
    maxTokens: pick(row.max_tokens, cfg.maxTokens)!,
    requestTimeoutMs: pick(row.request_timeout_ms, cfg.requestTimeoutMs)!,
    reasoning: pick(boolFromDb(row.reasoning), cfg.reasoning)!,
    thinkingLevel: pick(row.thinking_level, cfg.thinkingLevel)! as Connection["thinkingLevel"],
    thinkingFormat: pick(row.thinking_format, cfg.thinkingFormat)!,
    textMode: boolFromDb(row.text_mode) ?? false,
    twoPhase: boolFromDb(row.two_phase) ?? false,
    compat: parseCompat(row.compat_json),
    thinkingBudgets: parseThinkingBudgets(row.thinking_budgets),
    structuredOutputs: resolveStructuredOutputs(
      parseCompat(row.compat_json),
      parseProbeResult(row.structured_outputs_json),
      baseUrl,
      defaultModelId,
    ),
  };
}

/**
 * Overlay a stored capability profile's effective decisions onto a hand-flag
 * Connection (PLANNING/overhaul/06 §4). The Connection shape stays — downstream
 * code (runRole, providers) doesn't care where the flags came from.
 *
 * Precedence, by field:
 *  - textMode/twoPhase: profile-first. Zero behavior change at import time is
 *    guaranteed by the probe route seeding the profile's `overrides` from the
 *    hand flags, not by consulting the hand flags here.
 *  - structuredOutputs: profile verdictDelivery, EXCEPT when the config row
 *    sets `compat.structuredOutputsOverride` — that stays a deliberate,
 *    always-winning operator switch (same rule as resolveStructuredOutputs).
 *  - reasoning: profile value when the dialect sniff produced one.
 *  - compat booleans (supportsDeveloperRole/supportsReasoningEffort/
 *    maxTokensField): the config row's explicit compat values remain the
 *    override layer (doc §Detailed changes 3) — the profile only fills fields
 *    the row leaves unset.
 *
 * No stored profile for (connection, model) → the connection is returned
 * untouched, i.e. exactly today's hand-flag behavior.
 */
export function applyProfileToConnection(conn: Connection, modelId: string): Connection {
  const profile = loadProfile(profileConnectionSig(conn.baseUrl), modelId);
  if (!profile) return conn;
  const eff = effectiveDecisions(profile);

  const next: Connection = { ...conn, compat: { ...conn.compat } };
  next.textMode = eff.runShape === "text";
  next.twoPhase = eff.runShape === "two-turn";
  // Only overlay when the profile actually resolved a constrained-decoding
  // rung — otherwise leave conn.structuredOutputs exactly as the hand-flag
  // path computed it (already "off" absent a cached endpoint probe). Forcing
  // a fabricated `probedAt` onto the "off" case would break the "zero
  // behavior change on day one" guarantee: a profile that measures no
  // constrained decoding must be indistinguishable from no profile at all.
  if (
    !conn.compat.structuredOutputsOverride &&
    (eff.verdictDelivery === "json_schema" || eff.verdictDelivery === "guided_json" || eff.verdictDelivery === "grammar")
  ) {
    next.structuredOutputs = { mode: eff.verdictDelivery, probedAt: profile.probedAt ?? undefined };
  }
  if (eff.reasoning !== undefined) next.reasoning = eff.reasoning;
  if (conn.compat.supportsDeveloperRole === undefined && eff.supportsDeveloperRole !== undefined) {
    next.compat.supportsDeveloperRole = eff.supportsDeveloperRole;
  }
  if (conn.compat.supportsReasoningEffort === undefined && eff.supportsReasoningEffort !== undefined) {
    next.compat.supportsReasoningEffort = eff.supportsReasoningEffort;
  }
  if (conn.compat.maxTokensField === undefined && eff.maxTokensField !== undefined) {
    next.compat.maxTokensField = eff.maxTokensField;
  }
  // effectiveContext (overhaul/07): a raw probe observation, not a derived
  // decision — no ProfileOverrides field for it, so it applies whenever the
  // probe found one, independent of the rest of the override machinery above.
  if (profile.probes.effectiveContext != null && profile.probes.effectiveContext > 0) {
    next.effectiveContext = profile.probes.effectiveContext;
  }
  return next;
}

/**
 * Snapshot a Connection's current hand-tuned decisions as profile overrides —
 * the auto-import of the doc's rollout step 2. Seeding these on first probe
 * makes flipping resolution to profile-first a no-op by construction; removing
 * them model-by-model as measured decisions prove out is rollout step 3.
 */
export function importedOverridesForConnection(conn: Connection): ProfileOverrides {
  const overrides: ProfileOverrides = {
    runShape: conn.textMode ? "text" : conn.twoPhase ? "two-turn" : "single-turn",
    verdictDelivery:
      conn.structuredOutputs.mode !== "off"
        ? conn.structuredOutputs.mode
        : conn.textMode
          ? "fence"
          : "tool_call",
    reasoning: conn.reasoning,
  };
  if (conn.compat.supportsDeveloperRole !== undefined) {
    overrides.supportsDeveloperRole = conn.compat.supportsDeveloperRole;
  }
  if (conn.compat.supportsReasoningEffort !== undefined) {
    overrides.supportsReasoningEffort = conn.compat.supportsReasoningEffort;
  }
  if (conn.compat.maxTokensField !== undefined) {
    overrides.maxTokensField = conn.compat.maxTokensField;
  }
  return overrides;
}

export interface ResolvedModel {
  connection: Connection;
  modelId: string;
}

/**
 * Resolve the connection AND the actual modelId for a role/task model
 * reference (`role.model` / `task.model`).
 *
 * `modelRef` may be:
 *  - empty/undefined: falls back entirely to the project/global default
 *    connection (today's behavior when no override is set).
 *  - the `name` of a named model config (what RolesEditor's ModelPicker
 *    stores): resolves to THAT config's own base_url/api_key/text_mode/
 *    two_phase/compat — not the currently-active default connection — and the
 *    modelId sent to the API is that config's `default_model`, not the name.
 *  - a raw model id string that matches no config name (e.g. typed directly
 *    into a free-text field): falls back to the default connection, using
 *    modelRef verbatim as the modelId (today's existing behavior).
 *
 * This is what lets textMode/twoPhase vary per model: two roles pointed at
 * two different named configs each get that config's own tool-calling mode,
 * instead of both being governed by whichever connection is flagged default.
 *
 * Profile-first (PLANNING/overhaul/06): after the hand-flag resolution, a
 * stored capability profile for the (connection, modelId) pair overlays its
 * measured decisions via applyProfileToConnection. No profile → unchanged.
 */
export function resolveConnectionForModel(
  modelRef: string | null | undefined,
  projectId?: number | null,
): ResolvedModel {
  if (modelRef) {
    const match = listModelConfigs().find((c) => c.name === modelRef);
    if (match) {
      const modelId = match.default_model || modelRef;
      return { connection: applyProfileToConnection(connectionFromConfigRow(match), modelId), modelId };
    }
  }
  const connection = resolveConnection(projectId);
  const modelId = modelRef || connection.defaultModelId;
  return { connection: applyProfileToConnection(connection, modelId), modelId };
}
