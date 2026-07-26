import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { ConstrainedCompletionError, runConstrainedCompletion, runPlainCompletion } from "../src/structured";
import type { Connection } from "../src/settings";

function fakeConnection(mode: "json_schema" | "guided_json" | "grammar" | "off"): Connection {
  return {
    baseUrl: "http://localhost:8000/v1",
    apiKey: "",
    api: "openai-completions",
    defaultModelId: "fake-model",
    contextWindow: 8192,
    maxTokens: 4096,
    requestTimeoutMs: 5000,
    reasoning: false,
    thinkingLevel: "medium",
    thinkingFormat: "qwen-chat-template",
    textMode: false,
    twoPhase: false,
    compat: {},
    structuredOutputs: { mode },
  };
}

const SCHEMA = Type.Object({ verdict: Type.String(), summary: Type.String() });

function chatCompletionBody(content: string) {
  return { choices: [{ message: { content } }] };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runConstrainedCompletion", () => {
  it("throws immediately when the connection's structured mode is off", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      runConstrainedCompletion(fakeConnection("off"), "fake-model", [], SCHEMA),
    ).rejects.toThrow(ConstrainedCompletionError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("requests response_format json_schema and returns the schema-valid parsed body", async () => {
    const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.response_format.type).toBe("json_schema");
      return new Response(JSON.stringify(chatCompletionBody('{"verdict":"pass","summary":"ok"}')), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const result = await runConstrainedCompletion(
      fakeConnection("json_schema"),
      "fake-model",
      [{ role: "user", content: "go" }],
      SCHEMA,
    );
    expect(result).toEqual({ verdict: "pass", summary: "ok" });
  });

  it("requests guided_json (vLLM dialect) as an extra body field, not response_format", async () => {
    const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.guided_json).toBeDefined();
      expect(body.response_format).toBeUndefined();
      return new Response(JSON.stringify(chatCompletionBody('{"verdict":"pass","summary":"ok"}')), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const result = await runConstrainedCompletion(
      fakeConnection("guided_json"),
      "fake-model",
      [{ role: "user", content: "go" }],
      SCHEMA,
    );
    expect(result.verdict).toBe("pass");
  });

  it("requests a GBNF `grammar` (llama.cpp dialect) as an extra body field, not response_format", async () => {
    const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(typeof body.grammar).toBe("string");
      expect(body.grammar).toContain("root ::=");
      expect(body.response_format).toBeUndefined();
      expect(body.guided_json).toBeUndefined();
      return new Response(JSON.stringify(chatCompletionBody('{"verdict":"pass","summary":"ok"}')), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const result = await runConstrainedCompletion(
      fakeConnection("grammar"),
      "fake-model",
      [{ role: "user", content: "go" }],
      SCHEMA,
    );
    expect(result.verdict).toBe("pass");
  });

  it("tolerates a fenced JSON block despite requesting constrained output", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify(chatCompletionBody('```json\n{"verdict":"needs_more","summary":"partial"}\n```')),
          { status: 200 },
        ),
      ),
    );
    const result = await runConstrainedCompletion(
      fakeConnection("json_schema"),
      "fake-model",
      [{ role: "user", content: "go" }],
      SCHEMA,
    );
    expect(result.verdict).toBe("needs_more");
  });

  it("throws when the endpoint returns a non-2xx status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    await expect(
      runConstrainedCompletion(fakeConnection("json_schema"), "fake-model", [], SCHEMA),
    ).rejects.toThrow(ConstrainedCompletionError);
  });

  it("throws when the body doesn't conform to the requested schema (endpoint ignored the param)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(chatCompletionBody('{"unrelated":"stuff"}')), { status: 200 })),
    );
    await expect(
      runConstrainedCompletion(fakeConnection("json_schema"), "fake-model", [], SCHEMA),
    ).rejects.toThrow(ConstrainedCompletionError);
  });

  it("throws on a network error instead of propagating the raw fetch exception", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(
      runConstrainedCompletion(fakeConnection("json_schema"), "fake-model", [], SCHEMA),
    ).rejects.toThrow(ConstrainedCompletionError);
  });
});

describe("runPlainCompletion (unconstrained fenced rung — overhaul/03 repair fallback)", () => {
  it("returns the raw assistant content without requesting any structured format", async () => {
    const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      // No constraint fields are sent on the plain rung.
      expect(body.response_format).toBeUndefined();
      expect(body.guided_json).toBeUndefined();
      expect(body.grammar).toBeUndefined();
      return new Response(JSON.stringify(chatCompletionBody("```json\n{\"verdict\":\"pass\"}\n```")), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const content = await runPlainCompletion(fakeConnection("off"), "fake-model", [
      { role: "user", content: "hi" },
    ]);
    expect(content).toContain('"verdict":"pass"');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("throws ConstrainedCompletionError on a non-2xx status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    await expect(
      runPlainCompletion(fakeConnection("off"), "fake-model", []),
    ).rejects.toThrow(ConstrainedCompletionError);
  });

  it("throws ConstrainedCompletionError on a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(
      runPlainCompletion(fakeConnection("off"), "fake-model", []),
    ).rejects.toThrow(ConstrainedCompletionError);
  });
});
