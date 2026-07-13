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
import { getGlobalConfig, getProjectConfig, upsertConfig, type ConfigRow } from "./db.js";

/** Fully resolved connection settings for a single model call. */
export interface Connection {
  baseUrl: string;
  apiKey: string;
  api: string;
  defaultModelId: string;
  contextWindow: number;
  maxTokens: number;
  requestTimeoutMs: number;
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
  });
  console.log("[config] seeded global default connection profile");
}

function pick<T>(...vals: (T | null | undefined)[]): T | undefined {
  for (const v of vals) if (v != null) return v as T;
  return undefined;
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

  return {
    baseUrl: pick(envBaseUrl, project?.base_url, global?.base_url, cfg.providerBaseUrl)!,
    apiKey: pick(envApiKey, project?.api_key, global?.api_key, cfg.apiKey) ?? "",
    api: pick(project?.api, global?.api) ?? "openai-completions",
    defaultModelId: pick(project?.default_model, global?.default_model, cfg.defaultModelId)!,
    contextWindow: pick(project?.context_window, global?.context_window, cfg.contextWindow)!,
    maxTokens: pick(project?.max_tokens, global?.max_tokens, cfg.maxTokens)!,
    requestTimeoutMs: pick(project?.request_timeout_ms, global?.request_timeout_ms, cfg.requestTimeoutMs)!,
  };
}
