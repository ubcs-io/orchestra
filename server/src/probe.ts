/**
 * Capability probing for server-side constrained decoding (PLANNING/overhaul/02).
 *
 * Plain `fetch` against the endpoint's OpenAI-compatible /chat/completions route —
 * deliberately outside pi, so probe behavior is fully controlled and not filtered
 * through pi's own compat-shaping. Distinguishes "endpoint rejected the param"
 * (non-2xx) from "endpoint silently ignored it" (200 but the body doesn't conform
 * to the requested schema — the sneaky case some backends exhibit for unknown
 * response_format dialects): both count as unsupported, but only a conformance
 * check on the actual body catches the second case.
 *
 * Covers all four rungs: `json_object`, `json_schema` (OpenAI-standard), the
 * vLLM `guided_json` extra-body dialect, and llama.cpp's `grammar` (GBNF) param
 * — the last built by converting the probe schema through gbnf.ts, so a
 * grammar-only endpoint (some llama.cpp builds accept `grammar` but ignore
 * `response_format`) is still detected as constrained-decoding capable.
 */

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { schemaToGbnf } from "./gbnf.js";

export type StructuredMode = "json_object" | "json_schema" | "guided_json" | "grammar";

export interface ProbeResult {
  probedAt: string;
  baseUrl: string;
  modelId: string;
  modes: Record<StructuredMode, boolean>;
}

const PROBE_SCHEMA = Type.Object({ ok: Type.Boolean() });

const PROBE_PROMPT = 'Reply with ONLY this JSON object, nothing else: {"ok": true}';

/** Cap the probe's own output — this is a conformance check, not real work. */
const PROBE_MAX_TOKENS = 128;

async function postCompletion(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  extra: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<{ status: number; body: unknown } | { error: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    let res: Response;
    try {
      res = await fetch(baseUrl.replace(/\/+$/, "") + "/chat/completions", {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: modelId,
          max_tokens: PROBE_MAX_TOKENS,
          messages: [{ role: "user", content: PROBE_PROMPT }],
          ...extra,
        }),
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

/** Pull the assistant message content out of an OpenAI-compatible chat completion body. */
function extractContent(body: unknown): string | null {
  const choices = (body as { choices?: Array<{ message?: { content?: string } }> } | undefined)
    ?.choices;
  const content = choices?.[0]?.message?.content;
  return typeof content === "string" ? content : null;
}

/**
 * Best-effort: parse the response content as JSON (tolerating a fenced block) and
 * check it conforms to the probe schema — this is what catches an endpoint that
 * returns HTTP 200 but silently ignored the structured-output param.
 */
function conforms(body: unknown): boolean {
  const content = extractContent(body);
  if (!content) return false;
  const fence = /```(?:json)?\s*\n?([\s\S]*?)```/.exec(content);
  const raw = (fence?.[1] ?? content).trim();
  try {
    const parsed: unknown = JSON.parse(raw);
    return Value.Check(PROBE_SCHEMA, parsed);
  } catch {
    return false;
  }
}

async function probeMode(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  mode: StructuredMode,
): Promise<boolean> {
  const extra: Record<string, unknown> =
    mode === "json_object"
      ? { response_format: { type: "json_object" } }
      : mode === "json_schema"
        ? {
            response_format: {
              type: "json_schema",
              json_schema: { name: "probe", schema: PROBE_SCHEMA, strict: true },
            },
          }
        : mode === "guided_json"
          ? { guided_json: PROBE_SCHEMA } // vLLM extra-body dialect
          : { grammar: schemaToGbnf(PROBE_SCHEMA) }; // llama.cpp GBNF dialect

  const result = await postCompletion(baseUrl, apiKey, modelId, extra);
  if ("error" in result) return false;
  if (result.status < 200 || result.status >= 300) return false; // endpoint rejected the param
  return conforms(result.body); // endpoint ignored the param (200, non-conforming) also fails here
}

/**
 * Probe an endpoint's support for server-side constrained decoding. Cheap (max
 * ~128 output tokens per probe), meant to run on-demand (Settings/Models "Probe
 * endpoint" action) and cached against the connection's base URL + model id — see
 * settings.ts (ModelCompat.structuredOutputsOverride / Connection.structuredOutputs)
 * and db.ts (`configs.structured_outputs_json`) for where the result is persisted.
 */
export async function probeStructuredOutputs(
  baseUrl: string,
  apiKey: string,
  modelId: string,
): Promise<ProbeResult> {
  const [json_object, json_schema, guided_json, grammar] = await Promise.all([
    probeMode(baseUrl, apiKey, modelId, "json_object"),
    probeMode(baseUrl, apiKey, modelId, "json_schema"),
    probeMode(baseUrl, apiKey, modelId, "guided_json"),
    probeMode(baseUrl, apiKey, modelId, "grammar"),
  ]);
  return {
    probedAt: new Date().toISOString(),
    baseUrl,
    modelId,
    modes: { json_object, json_schema, guided_json, grammar },
  };
}
