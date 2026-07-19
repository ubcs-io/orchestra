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

  return {
    baseUrl: pick(envBaseUrl, project?.base_url, global?.base_url, cfg.providerBaseUrl)!,
    apiKey: pick(envApiKey, project?.api_key, global?.api_key, cfg.apiKey) ?? "",
    api: pick(project?.api, global?.api) ?? "openai-completions",
    defaultModelId: pick(project?.default_model, global?.default_model, cfg.defaultModelId)!,
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
  };
}

/**
 * Build a Connection from a single named model-config row. Unlike
 * resolveConnection(), this does NOT merge with the project/global 'default'
 * row — a named config (created via the Models UI) is a complete, standalone
 * profile with its own base_url/api_key/text_mode/two_phase/compat. Bootstrap
 * config only fills in fields the row itself leaves unset.
 */
function connectionFromConfigRow(row: ConfigRow): Connection {
  const cfg = getConfig();
  const envBaseUrl = process.env.ORCHESTRA_BASE_URL;
  const envApiKey = process.env.ORCHESTRA_API_KEY;
  return {
    baseUrl: pick(envBaseUrl, row.base_url, cfg.providerBaseUrl)!,
    apiKey: pick(envApiKey, row.api_key, cfg.apiKey) ?? "",
    api: row.api ?? "openai-completions",
    defaultModelId: pick(row.default_model, cfg.defaultModelId)!,
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
  };
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
 */
export function resolveConnectionForModel(
  modelRef: string | null | undefined,
  projectId?: number | null,
): ResolvedModel {
  if (modelRef) {
    const match = listModelConfigs().find((c) => c.name === modelRef);
    if (match) {
      return { connection: connectionFromConfigRow(match), modelId: match.default_model || modelRef };
    }
  }
  const connection = resolveConnection(projectId);
  return { connection, modelId: modelRef || connection.defaultModelId };
}
