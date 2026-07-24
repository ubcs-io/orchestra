import { afterEach, describe, expect, it, vi } from "vitest";
import { probeStructuredOutputs } from "../src/probe";

function chatCompletionBody(content: string) {
  return { choices: [{ message: { content } }] };
}

/** Which probe a request body is for, mirroring probe.ts's per-mode extra-body shaping. */
function probeModeOf(
  body: Record<string, unknown>,
): "json_object" | "json_schema" | "guided_json" | "grammar" {
  if (body.grammar) return "grammar";
  if (body.guided_json) return "guided_json";
  const rf = body.response_format as { type?: string } | undefined;
  if (rf?.type === "json_schema") return "json_schema";
  return "json_object";
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("probeStructuredOutputs", () => {
  it("marks all four modes supported when the endpoint returns conforming JSON for each", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        void probeModeOf(JSON.parse(init.body as string));
        return new Response(JSON.stringify(chatCompletionBody('{"ok": true}')), { status: 200 });
      }),
    );
    const result = await probeStructuredOutputs("http://localhost:8000/v1", "", "fake-model");
    expect(result.modes).toEqual({ json_object: true, json_schema: true, guided_json: true, grammar: true });
    expect(result.baseUrl).toBe("http://localhost:8000/v1");
    expect(result.modelId).toBe("fake-model");
    expect(result.probedAt).toBeTruthy();
  });

  it("detects a grammar-only endpoint (json_schema + guided_json rejected, GBNF grammar honored)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        const mode = probeModeOf(body);
        // A grammar-only llama.cpp build: sends a `grammar` param and honors it,
        // but 400s on response_format json_schema and has no guided_json.
        if (mode === "grammar") {
          expect(typeof body.grammar).toBe("string");
          expect(body.grammar).toContain("root ::=");
          return new Response(JSON.stringify(chatCompletionBody('{"ok": true}')), { status: 200 });
        }
        if (mode === "json_schema" || mode === "guided_json") {
          return new Response("bad request", { status: 400 });
        }
        return new Response(JSON.stringify(chatCompletionBody('{"ok": true}')), { status: 200 });
      }),
    );
    const result = await probeStructuredOutputs("http://localhost:8000/v1", "", "fake-model");
    expect(result.modes.grammar).toBe(true);
    expect(result.modes.json_schema).toBe(false);
    expect(result.modes.guided_json).toBe(false);
  });

  it("marks a mode unsupported when the endpoint rejects the param with a 4xx (vLLM has no guided_json support)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const mode = probeModeOf(JSON.parse(init.body as string));
        if (mode === "guided_json") return new Response("bad request", { status: 400 });
        return new Response(JSON.stringify(chatCompletionBody('{"ok": true}')), { status: 200 });
      }),
    );
    const result = await probeStructuredOutputs("http://localhost:8000/v1", "", "fake-model");
    expect(result.modes.guided_json).toBe(false);
    expect(result.modes.json_schema).toBe(true);
  });

  it("marks a mode unsupported when the endpoint returns 200 but silently ignored the param (llama.cpp's sneaky case)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const mode = probeModeOf(JSON.parse(init.body as string));
        // Endpoint ignores json_schema entirely and just answers in prose.
        if (mode === "json_schema") {
          return new Response(JSON.stringify(chatCompletionBody("Sure! The answer is ok.")), { status: 200 });
        }
        return new Response(JSON.stringify(chatCompletionBody('{"ok": true}')), { status: 200 });
      }),
    );
    const result = await probeStructuredOutputs("http://localhost:8000/v1", "", "fake-model");
    expect(result.modes.json_schema).toBe(false);
    expect(result.modes.json_object).toBe(true);
  });

  it("marks every mode unsupported on a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const result = await probeStructuredOutputs("http://localhost:8000/v1", "", "fake-model");
    expect(result.modes).toEqual({
      json_object: false,
      json_schema: false,
      guided_json: false,
      grammar: false,
    });
  });
});
