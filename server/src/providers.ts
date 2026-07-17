/**
 * pi provider registration + model discovery (the endpoint-agnostic layer).
 *
 * A single in-memory ModelRegistry holds a "local" provider pointed at the
 * configured OpenAI-compatible endpoint. Any model id the app asks for is
 * lazily registered against that provider, so pointing at a different endpoint
 * is a config change with no code change.
 */

import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { resolveConnection, type Connection } from "./settings.js";

const OPENAI_COMPAT: Api = "openai-completions";

let registry: ModelRegistry | undefined;
/** Per-provider registration state, keyed by a hash of the connection signature
 *  (base URL + auth + params) — so two different connections (e.g. a role's
 *  named model-config override vs the active default) each get their own
 *  provider entry instead of sharing one, which would stamp every model with
 *  whichever connection happened to resolve last. */
const providerStates = new Map<string, { modelIds: Set<string>; sig: string }>();

function ensureRegistry(): ModelRegistry {
  if (registry) return registry;
  const auth = AuthStorage.inMemory();
  registry = ModelRegistry.inMemory(auth);
  return registry;
}

/** Small non-cryptographic string hash — just needs to be a stable, short,
 *  secret-free provider id derived from the connection signature. */
function hashSig(sig: string): string {
  let h = 0;
  for (let i = 0; i < sig.length; i++) {
    h = (Math.imul(h, 31) + sig.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** Build a flat compat object from the connection's thinkingFormat + ModelCompat overrides. */
function buildCompat(conn: Connection): Record<string, unknown> {
  const c: Record<string, unknown> = { thinkingFormat: conn.thinkingFormat };
  const m = conn.compat;
  if (m.supportsDeveloperRole !== undefined) c.supportsDeveloperRole = m.supportsDeveloperRole;
  if (m.supportsReasoningEffort !== undefined) c.supportsReasoningEffort = m.supportsReasoningEffort;
  if (m.maxTokensField) c.maxTokensField = m.maxTokensField;
  if (m.chatTemplateKwargs && Object.keys(m.chatTemplateKwargs).length > 0) {
    c.chatTemplateKwargs = m.chatTemplateKwargs;
  }
  return c;
}

function modelEntry(id: string, conn: Connection) {
  return {
    id,
    name: id,
    api: OPENAI_COMPAT,
    // Reasoning models (DeepSeek-R1 / QwQ) MUST be registered with reasoning:true,
    // otherwise pi clamps the thinking level to "off" and the model emits its
    // chain-of-thought as inline <think> text that eats the output budget.
    reasoning: conn.reasoning,
    // thinkingFormat shapes the reasoning REQUEST; the response only splits onto a
    // separate channel if the endpoint emits `reasoning_content`.
    compat: buildCompat(conn) as Model<Api>["compat"],
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: conn.contextWindow,
    maxTokens: conn.maxTokens,
  };
}

/**
 * Ensure `modelId` is registered on the provider for `connection` and return
 * its Model. Registering with a models array replaces the provider's model
 * list, so we re-register the full known set for that provider whenever a new
 * id appears OR its resolved connection (base URL / auth / params) changed —
 * the latter lets a runtime edit of the connection profile take effect
 * without a restart.
 *
 * `connection` defaults to the active project/global default connection when
 * omitted, preserving prior single-connection behavior. Pass the result of
 * `resolveConnectionForModel()` to register a model against a specific named
 * config's own base URL/auth/params instead — this is what lets two roles
 * running against two different backends resolve correctly in the same
 * process, rather than both being silently registered against whichever
 * connection was resolved most recently.
 */
export function ensureModel(modelId: string, connection?: Connection): Model<Api> {
  const conn = connection ?? resolveConnection();
  const reg = ensureRegistry();
  const sig = `${conn.baseUrl}|${conn.apiKey}|${conn.contextWindow}|${conn.maxTokens}|${conn.reasoning}|${conn.thinkingFormat}|${JSON.stringify(conn.compat)}`;
  const providerName = `local-${hashSig(sig)}`;
  let state = providerStates.get(providerName);
  if (!state || !state.modelIds.has(modelId)) {
    if (!state) {
      state = { modelIds: new Set(), sig };
      providerStates.set(providerName, state);
    }
    state.modelIds.add(modelId);
    // Always include the default so a role/task override never drops it.
    state.modelIds.add(conn.defaultModelId);
    reg.registerProvider(providerName, {
      name: "Local",
      baseUrl: conn.baseUrl,
      apiKey: conn.apiKey || "sk-local",
      api: OPENAI_COMPAT,
      models: [...state.modelIds].map((id) => modelEntry(id, conn)),
    });
  }
  const model = reg.find(providerName, modelId);
  if (!model) {
    throw new Error(`model '${modelId}' could not be registered on provider '${providerName}'`);
  }
  return model;
}

export function getRegistry(): ModelRegistry {
  return ensureRegistry();
}

/**
 * Discover model ids from the endpoint's OpenAI-compatible /models route.
 * Best-effort: returns [] if the endpoint is unreachable or shaped differently.
 */
export async function discoverModels(): Promise<string[]> {
  const conn = resolveConnection();
  const url = conn.baseUrl.replace(/\/+$/, "") + "/models";
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (conn.apiKey) headers.Authorization = `Bearer ${conn.apiKey}`;
    const res = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: Array<{ id?: string }> } | Array<{ id?: string }>;
    const list = Array.isArray(data) ? data : (data.data ?? []);
    return list.map((m) => m.id).filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}
