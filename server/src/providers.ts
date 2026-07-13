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
import { getConfig } from "./config.js";

export const LOCAL_PROVIDER = "local";
const OPENAI_COMPAT: Api = "openai-completions";

let registry: ModelRegistry | undefined;
const registeredModelIds = new Set<string>();

function ensureRegistry(): ModelRegistry {
  if (registry) return registry;
  const auth = AuthStorage.inMemory();
  registry = ModelRegistry.inMemory(auth);
  return registry;
}

function modelEntry(id: string) {
  const cfg = getConfig();
  return {
    id,
    name: id,
    api: OPENAI_COMPAT,
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: cfg.contextWindow,
    maxTokens: cfg.maxTokens,
  };
}

/**
 * Ensure `modelId` is registered on the local provider and return its Model.
 * Registering with a models array replaces the provider's model list, so we
 * always re-register the full known set to keep every id resolvable.
 */
export function ensureModel(modelId: string): Model<Api> {
  const cfg = getConfig();
  const reg = ensureRegistry();
  if (!registeredModelIds.has(modelId)) {
    registeredModelIds.add(modelId);
    // Always include the default so a role/task override never drops it.
    registeredModelIds.add(cfg.defaultModelId);
    reg.registerProvider(LOCAL_PROVIDER, {
      name: "Local",
      baseUrl: cfg.providerBaseUrl,
      apiKey: cfg.apiKey || "sk-local",
      api: OPENAI_COMPAT,
      models: [...registeredModelIds].map(modelEntry),
    });
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
  const cfg = getConfig();
  const url = cfg.providerBaseUrl.replace(/\/+$/, "") + "/models";
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
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
