import { afterEach, describe, expect, it, vi } from "vitest";
import { runModelProbes, PROBE_STEPS } from "../src/profiles";

/** Build an OpenAI-compatible chat completion body with a plain text answer. */
function textBody(content: string, extra: Record<string, unknown> = {}) {
  return { choices: [{ message: { content, ...extra } }] };
}

/** Build a chat completion body carrying a tool call. */
function toolCallBody(name: string, args: Record<string, unknown>) {
  return {
    choices: [
      { message: { content: null, tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] } },
    ],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runModelProbes", () => {
  it("runs all seven steps and reports progress start/done for each", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/models")) return jsonResponse({ data: [] });
        return jsonResponse(textBody('{"ok": true}'));
      }),
    );
    const seen: string[] = [];
    await runModelProbes("http://box:8000/v1", "", "model", (ev) => seen.push(`${ev.step}:${ev.status}`));
    for (const step of PROBE_STEPS) {
      expect(seen).toContain(`${step}:start`);
      expect(seen).toContain(`${step}:done`);
    }
  });

  it("marks customToolCall reliable when a well-formed record_answer call arrives every trial", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith("/models")) return jsonResponse({ data: [] });
        const body = JSON.parse(init.body as string) as { tools?: Array<{ function: { name: string } }> };
        const toolName = body.tools?.[0]?.function.name;
        if (toolName === "record_answer") return jsonResponse(toolCallBody("record_answer", { answer: "blue" }));
        if (toolName === "read_file") return jsonResponse(toolCallBody("read_file", { path: "/tmp/x" }));
        return jsonResponse(textBody('{"answer": "blue"}'));
      }),
    );
    const probes = await runModelProbes("http://box:8000/v1", "", "model");
    expect(probes.customToolCall).toEqual({ attempts: 5, successes: 5 });
    expect(probes.builtinToolCall).toEqual({ attempts: 5, successes: 5 });
  });

  it("counts a malformed tool call (wrong name / missing arg) as a failed trial", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith("/models")) return jsonResponse({ data: [] });
        const body = JSON.parse(init.body as string) as { tools?: Array<{ function: { name: string } }> };
        const toolName = body.tools?.[0]?.function.name;
        // Model calls the wrong tool name entirely (or answers in prose instead).
        if (toolName === "record_answer") return jsonResponse(textBody("The sky is blue."));
        if (toolName === "read_file") return jsonResponse(toolCallBody("read_file", {})); // missing required path
        return jsonResponse(textBody("nope"));
      }),
    );
    const probes = await runModelProbes("http://box:8000/v1", "", "model");
    expect(probes.customToolCall).toEqual({ attempts: 5, successes: 0 });
    expect(probes.builtinToolCall).toEqual({ attempts: 5, successes: 0 });
  });

  it("parses fenced JSON for the jsonFence probe, tolerating a ```json fence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith("/models")) return jsonResponse({ data: [] });
        const body = JSON.parse(init.body as string) as { tools?: unknown };
        if (body.tools) return jsonResponse(toolCallBody("record_answer", { answer: "blue" }));
        return jsonResponse(textBody('Sure!\n```json\n{"answer": "blue"}\n```'));
      }),
    );
    const probes = await runModelProbes("http://box:8000/v1", "", "model");
    expect(probes.jsonFence).toEqual({ attempts: 5, successes: 5 });
  });

  it("marks jsonFence a failure when the content isn't valid JSON at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith("/models")) return jsonResponse({ data: [] });
        const body = JSON.parse(init.body as string) as { tools?: unknown };
        if (body.tools) return jsonResponse(toolCallBody("record_answer", { answer: "blue" }));
        return jsonResponse(textBody("The sky is blue, no JSON here."));
      }),
    );
    const probes = await runModelProbes("http://box:8000/v1", "", "model");
    expect(probes.jsonFence).toEqual({ attempts: 5, successes: 0 });
  });

  it("detects the reasoning_content channel for the thinking-dialect sniff", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith("/models")) return jsonResponse({ data: [] });
        const body = JSON.parse(init.body as string) as { tools?: unknown; max_tokens?: number };
        if (body.tools) return jsonResponse(toolCallBody("record_answer", { answer: "42" }));
        if (body.max_tokens && body.max_tokens > 256) {
          return jsonResponse(textBody("42", { reasoning_content: "17 + 25 = 42" }));
        }
        return jsonResponse(textBody('{"answer": "42"}'));
      }),
    );
    const probes = await runModelProbes("http://box:8000/v1", "", "model");
    expect(probes.thinkingDialect).toBe("reasoning_content");
  });

  it("detects literal <think> tags when no separate channel is present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith("/models")) return jsonResponse({ data: [] });
        const body = JSON.parse(init.body as string) as { tools?: unknown; max_tokens?: number };
        if (body.tools) return jsonResponse(toolCallBody("record_answer", { answer: "42" }));
        if (body.max_tokens && body.max_tokens > 256) {
          return jsonResponse(textBody("<think>17 + 25 is 42</think>The answer is 42."));
        }
        return jsonResponse(textBody('{"answer": "42"}'));
      }),
    );
    const probes = await runModelProbes("http://box:8000/v1", "", "model");
    expect(probes.thinkingDialect).toBe("think_tags");
  });

  it("reports 'none' when no reasoning channel is observed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/models")) return jsonResponse({ data: [] });
        return jsonResponse(textBody("42"));
      }),
    );
    const probes = await runModelProbes("http://box:8000/v1", "", "model");
    expect(probes.thinkingDialect).toBe("none");
  });

  it("param acceptance: 2xx -> true, 4xx -> false, distinguishing developer-role and reasoning_effort", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith("/models")) return jsonResponse({ data: [] });
        const body = JSON.parse(init.body as string) as {
          messages?: Array<{ role: string }>;
          reasoning_effort?: string;
          max_completion_tokens?: number;
        };
        if (body.messages?.some((m) => m.role === "developer")) return new Response("bad", { status: 400 });
        if (body.reasoning_effort) return jsonResponse(textBody("ok"));
        if (body.max_completion_tokens) return new Response("bad", { status: 400 });
        return jsonResponse(textBody("ok"));
      }),
    );
    const probes = await runModelProbes("http://box:8000/v1", "", "model");
    expect(probes.developerRole).toBe(false);
    expect(probes.reasoningEffortParam).toBe(true);
    expect(probes.maxTokensField).toBe("max_tokens");
  });

  it("leaves param acceptance undefined (not false) on a transport error, never mistaking an outage for rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.endsWith("/models")) return jsonResponse({ data: [] });
        const body = JSON.parse(init.body as string) as { messages?: Array<{ role: string }> };
        if (body.messages?.some((m) => m.role === "developer")) throw new Error("ECONNRESET");
        return jsonResponse(textBody("ok"));
      }),
    );
    const probes = await runModelProbes("http://box:8000/v1", "", "model");
    expect(probes.developerRole).toBeUndefined();
  });

  it("reads the effective context length from /models when the endpoint advertises it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/models")) {
          return jsonResponse({ data: [{ id: "my-model", context_length: 32768 }] });
        }
        return jsonResponse(textBody('{"ok": true}'));
      }),
    );
    const probes = await runModelProbes("http://box:8000/v1", "", "my-model");
    expect(probes.effectiveContext).toBe(32768);
  });

  it("returns null effective context when /models doesn't expose it or the model isn't listed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/models")) return jsonResponse({ data: [{ id: "some-other-model" }] });
        return jsonResponse(textBody('{"ok": true}'));
      }),
    );
    const probes = await runModelProbes("http://box:8000/v1", "", "my-model");
    expect(probes.effectiveContext).toBeNull();
  });

  it("never throws when the endpoint is entirely unreachable — yields 0/K trials and undefined params", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const probes = await runModelProbes("http://box:8000/v1", "", "model");
    expect(probes.customToolCall).toEqual({ attempts: 5, successes: 0 });
    expect(probes.builtinToolCall).toEqual({ attempts: 5, successes: 0 });
    expect(probes.jsonFence).toEqual({ attempts: 5, successes: 0 });
    expect(probes.thinkingDialect).toBeUndefined();
    expect(probes.developerRole).toBeUndefined();
    expect(probes.effectiveContext).toBeNull();
  });
});
