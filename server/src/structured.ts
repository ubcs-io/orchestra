/**
 * Constrained/structured completion calls — the sampler-guaranteed rung of the
 * verdict-trailer and router-mini-call delivery ladders (PLANNING/overhaul/02).
 *
 * Deliberately bypasses pi: pi's `openai-completions` API has no
 * `response_format` / extra-body passthrough (confirmed by reading
 * `@earendil-works/pi-ai`'s dist — no such field is ever read off `model.compat`
 * or forwarded to the request body), and these calls need no tools/streaming
 * anyway — a plain completion is the simplest, most controllable way to ask a
 * local endpoint for guaranteed-valid JSON.
 *
 * `Connection.structuredOutputs.mode` (settings.ts) is the resolved rung — "off"
 * until a probe (probe.ts) has found `json_schema`/`guided_json`/`grammar`
 * support or a manual `ModelCompat.structuredOutputsOverride` selects one. The
 * `grammar` rung converts the schema to GBNF (gbnf.ts) for llama.cpp endpoints.
 */

import type { TSchema, Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Connection } from "./settings.js";
import { schemaToGbnf } from "./gbnf.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Thrown for any failure (unsupported mode, network, non-2xx, invalid JSON,
 *  schema mismatch) — callers catch this and fall back to their existing
 *  (unconstrained) recovery ladder rather than surfacing it as a hard error. */
export class ConstrainedCompletionError extends Error {}

function extractContent(body: unknown): string | null {
  const choices = (body as { choices?: Array<{ message?: { content?: string } }> } | undefined)
    ?.choices;
  const content = choices?.[0]?.message?.content;
  return typeof content === "string" ? content : null;
}

/** Tolerate a model that wraps its constrained output in a fence anyway. */
function stripFence(text: string): string {
  const fence = /```(?:json)?\s*\n?([\s\S]*?)```/.exec(text);
  return (fence?.[1] ?? text).trim();
}

/**
 * POST one tool-free chat completion to `connection`'s OpenAI-compatible
 * endpoint and return the raw assistant content string. `extra` carries the
 * per-rung request shaping (response_format / guided_json / grammar) or {} for
 * an unconstrained completion. Throws ConstrainedCompletionError on any
 * transport/protocol failure so every caller falls back cleanly. Shared by
 * runConstrainedCompletion (the sampler-guaranteed rung) and runPlainCompletion
 * (the unconstrained fenced rung used by the repair pass, PLANNING/overhaul/03,
 * on endpoints without server-side constrained decoding).
 */
async function postChatCompletion(
  connection: Connection,
  modelId: string,
  messages: ChatMessage[],
  maxTokens: number,
  extra: Record<string, unknown>,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), connection.requestTimeoutMs || 60_000);
  let res: Response;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (connection.apiKey) headers.Authorization = `Bearer ${connection.apiKey}`;
    try {
      res = await fetch(connection.baseUrl.replace(/\/+$/, "") + "/chat/completions", {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({ model: modelId, max_tokens: maxTokens, messages, ...extra }),
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    throw new ConstrainedCompletionError(`request failed: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new ConstrainedCompletionError(`endpoint returned HTTP ${res.status}`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new ConstrainedCompletionError(`response was not JSON: ${(err as Error).message}`);
  }

  const content = extractContent(body);
  if (!content) throw new ConstrainedCompletionError("empty completion content");
  return content;
}

/**
 * Run one tool-free, schema-constrained completion against `connection`'s
 * OpenAI-compatible endpoint. Never returns a partial or best-effort result —
 * any failure (including a schema mismatch, which some backends can still
 * produce despite requesting constrained decoding) throws
 * ConstrainedCompletionError so callers fall back cleanly.
 */
export async function runConstrainedCompletion<T extends TSchema>(
  connection: Connection,
  modelId: string,
  messages: ChatMessage[],
  schema: T,
  maxTokens = 1024,
): Promise<Static<T>> {
  const mode = connection.structuredOutputs.mode;
  if (mode === "off") {
    throw new ConstrainedCompletionError("structured outputs not supported by this connection");
  }

  const extra: Record<string, unknown> =
    mode === "json_schema"
      ? {
          response_format: {
            type: "json_schema",
            json_schema: { name: "verdict", schema, strict: true },
          },
        }
      : mode === "guided_json"
        ? { guided_json: schema } // vLLM extra-body dialect
        : { grammar: schemaToGbnf(schema) }; // llama.cpp GBNF dialect

  const content = await postChatCompletion(connection, modelId, messages, maxTokens, extra);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(content));
  } catch (err) {
    throw new ConstrainedCompletionError(`content was not valid JSON: ${(err as Error).message}`);
  }

  if (!Value.Check(schema, parsed)) {
    throw new ConstrainedCompletionError("content did not conform to the requested schema");
  }
  return parsed as Static<T>;
}

/**
 * Run one unconstrained, tool-free completion and return the raw assistant
 * content string — the fenced-JSON rung of the repair pass (PLANNING/overhaul/03)
 * for endpoints without server-side constrained decoding. The caller is
 * responsible for parsing/validating the returned text (e.g. via
 * extractFindingsFromText), since without a sampler guarantee the output can be
 * anything. Throws ConstrainedCompletionError on transport/protocol failure.
 */
export async function runPlainCompletion(
  connection: Connection,
  modelId: string,
  messages: ChatMessage[],
  maxTokens = 1024,
): Promise<string> {
  return postChatCompletion(connection, modelId, messages, maxTokens, {});
}
