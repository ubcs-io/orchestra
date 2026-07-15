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

export const LOCAL_PROVIDER = "local";
const OPENAI_COMPAT: Api = "openai-completions";

let registry: ModelRegistry | undefined;
const registeredModelIds = new Set<string>();
/** Signature of the connection the provider was last registered with. */
let lastProviderSig: string | undefined;

function ensureRegistry(): ModelRegistry {
  if (registry) return registry;
  const auth = AuthStorage.inMemory();
  registry = ModelRegistry.inMemory(auth);
  return registry;
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
 * Ensure `modelId` is registered on the local provider and return its Model.
 * Registering with a models array replaces the provider's model list, so we
 * re-register the full known set whenever a new id appears OR the resolved
 * connection (base URL / auth / params) changed — the latter lets a runtime
 * edit of the connection profile take effect without a restart.
 */
export function ensureModel(modelId: string): Model<Api> {
  const conn = resolveConnection();
  const reg = ensureRegistry();
  const sig = `${conn.baseUrl}|${conn.apiKey}|${conn.contextWindow}|${conn.maxTokens}|${conn.reasoning}|${conn.thinkingFormat}|${JSON.stringify(conn.compat)}`;
  if (!registeredModelIds.has(modelId) || sig !== lastProviderSig) {
    registeredModelIds.add(modelId);
    // Always include the default so a role/task override never drops it.
    registeredModelIds.add(conn.defaultModelId);
    reg.registerProvider(LOCAL_PROVIDER, {
      name: "Local",
      baseUrl: conn.baseUrl,
      apiKey: conn.apiKey || "sk-local",
      api: OPENAI_COMPAT,
      models: [...registeredModelIds].map((id) => modelEntry(id, conn)),
    });
    lastProviderSig = sig;
  }
  const model = reg.find(LOCAL_PROVIDER, modelId);
  if (!model) {
    throw new Error(`model '${modelId}' could not be registered on provider '${LOCAL_PROVIDER}'`);
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
