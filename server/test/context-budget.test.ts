import { afterEach, describe, expect, it, vi } from "vitest";
import {
  allocate,
  capHeadTail,
  computeBudget,
  DEFAULT_TOOL_RESULT_RESERVE_FRACTION,
  DIGEST_MAX_CHARS,
  DIGEST_MIN_REPORT_CHARS,
  estimateTokens,
  generateDigest,
  SAFETY_FACTOR,
  type BudgetPart,
} from "../src/context-budget";
import type { Connection } from "../src/settings";

function fakeConnection(mode: "json_schema" | "off"): Connection {
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

function chatCompletionBody(content: string) {
  return { choices: [{ message: { content } }] };
}

describe("estimateTokens", () => {
  it("is chars/4 rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("a".repeat(4000))).toBe(1000);
  });
});

describe("computeBudget", () => {
  it("matches the doc's formula: window - maxTokens - thinking - systemPrompt - toolReserve, then *safetyFactor", () => {
    const b = computeBudget({
      contextWindow: 8000,
      maxTokens: 1000,
      systemPromptTokens: 500,
      thinkingBudget: 500,
    });
    const toolResultReserve = Math.round(8000 * DEFAULT_TOOL_RESULT_RESERVE_FRACTION);
    const available = 8000 - 1000 - 500 - 500 - toolResultReserve;
    expect(b.toolResultReserve).toBe(toolResultReserve);
    expect(b.available).toBe(available);
    expect(b.budget).toBe(Math.floor(available * SAFETY_FACTOR));
  });

  it("prefers effectiveContext over contextWindow when positive", () => {
    const b = computeBudget({
      contextWindow: 32000,
      effectiveContext: 4000,
      maxTokens: 512,
      systemPromptTokens: 200,
    });
    expect(b.windowSize).toBe(4000);
  });

  it("falls back to contextWindow when effectiveContext is null/0/negative", () => {
    for (const eff of [null, undefined, 0, -1]) {
      const b = computeBudget({
        contextWindow: 16000,
        effectiveContext: eff,
        maxTokens: 512,
        systemPromptTokens: 200,
      });
      expect(b.windowSize).toBe(16000);
    }
  });

  it("never goes negative — floors available at 0 when reservations exceed the window", () => {
    const b = computeBudget({
      contextWindow: 1000,
      maxTokens: 2000,
      systemPromptTokens: 5000,
    });
    expect(b.available).toBe(0);
    expect(b.budget).toBe(0);
  });

  it("honors overridden reserve fraction and safety factor", () => {
    const b = computeBudget({
      contextWindow: 10000,
      maxTokens: 0,
      systemPromptTokens: 0,
      toolResultReserveFraction: 0.5,
      safetyFactor: 1,
    });
    expect(b.toolResultReserve).toBe(5000);
    expect(b.available).toBe(5000);
    expect(b.budget).toBe(5000);
  });
});

/** Build a simple never-drop part. */
function neverDrop(id: string, tier: 1 | 2, text: string): BudgetPart {
  return { id, tier, neverDrop: true, renderings: [text] };
}

describe("allocate", () => {
  it("returns everything at full detail when the budget comfortably fits", () => {
    const parts: BudgetPart[] = [
      neverDrop("header", 1, "# Task\n"),
      { id: "intake", tier: 3, renderings: ["## Intake\nhello world", "## Intake\n(condensed)"] },
      { id: "priors", tier: 4, renderings: ["## Priors\nfull detail", "## Priors\ncollapsed"] },
    ];
    const result = allocate(parts, 10_000);
    expect(result.text).toContain("full detail");
    expect(result.text).toContain("hello world");
    expect(result.degraded).toBe(false);
    expect(result.degradedIds).toEqual([]);
    expect(result.droppedIds).toEqual([]);
  });

  it("never drops tier-1/2 content even when the budget is zero or negative", () => {
    const parts: BudgetPart[] = [
      neverDrop("header", 1, "# Task header (must survive)"),
      neverDrop("criteria", 2, "## Acceptance criteria (must survive)"),
      { id: "intake", tier: 3, renderings: ["a".repeat(4000), ""] },
    ];
    const result = allocate(parts, 0);
    expect(result.text).toContain("Task header (must survive)");
    expect(result.text).toContain("Acceptance criteria (must survive)");
    expect(result.droppedIds).toContain("intake");
  });

  it("degrades a tier in priority order, preferring higher tiers first", () => {
    const bigFull = "x".repeat(4000); // ~1000 tokens
    const parts: BudgetPart[] = [
      { id: "intake", tier: 3, renderings: [bigFull, "intake-condensed"] },
      { id: "priors", tier: 4, renderings: [bigFull, "priors-condensed"] },
    ];
    // Budget only large enough for one full-detail rendering plus a bit — tier 3
    // (higher priority) should keep full detail; tier 4 should degrade.
    const result = allocate(parts, 1050);
    expect(result.text).toContain(bigFull); // intake kept full
    expect(result.text).toContain("priors-condensed");
    expect(result.degradedIds).toEqual(["priors"]);
    expect(result.droppedIds).toEqual([]);
  });

  it("drops a part entirely (empty string) when nothing fits, and records it in droppedIds", () => {
    const parts: BudgetPart[] = [
      { id: "questions", tier: 5, renderings: ["a".repeat(400), "b".repeat(200)] },
    ];
    const result = allocate(parts, 0);
    expect(result.text).toBe("");
    expect(result.droppedIds).toEqual(["questions"]);
    expect(result.degradedIds).toEqual([]);
  });

  it("treats an explicit empty-string rendering as a valid always-fits floor", () => {
    const parts: BudgetPart[] = [{ id: "optional", tier: 5, renderings: ["huge".repeat(10000), ""] }];
    const result = allocate(parts, 1);
    expect(result.text).toBe("");
    // Explicitly rendered "" (present as a rung) still counts as dropped since
    // there was non-empty content that didn't fit.
    expect(result.droppedIds).toEqual(["optional"]);
  });

  it("preserves the caller's original part order in the assembled text, independent of tier order", () => {
    const parts: BudgetPart[] = [
      { id: "second", tier: 4, renderings: ["SECOND"] },
      neverDrop("first", 1, "FIRST"),
    ];
    const result = allocate(parts, 10_000);
    // Input order was [second, first] — allocate() must preserve that, not
    // reorder by tier, even though tier 1 was processed first internally.
    expect(result.text.indexOf("SECOND")).toBeLessThan(result.text.indexOf("FIRST"));
  });

  it("computes tokensEst as estimateTokens of the final joined text", () => {
    const parts: BudgetPart[] = [neverDrop("a", 1, "abcd"), neverDrop("b", 1, "efgh")];
    const result = allocate(parts, 10_000);
    expect(result.tokensEst).toBe(estimateTokens(result.text));
  });

  it("degraded is false iff both degradedIds and droppedIds are empty", () => {
    const clean = allocate([neverDrop("a", 1, "x")], 10_000);
    expect(clean.degraded).toBe(false);
    const withDrop = allocate([{ id: "b", tier: 5, renderings: ["y".repeat(100)] }], 0);
    expect(withDrop.degraded).toBe(true);
  });

  it("ignores parts with no renderings at all (no-op, never crashes)", () => {
    const parts: BudgetPart[] = [{ id: "empty", tier: 3, renderings: [] }, neverDrop("a", 1, "kept")];
    const result = allocate(parts, 10_000);
    expect(result.text).toBe("kept");
    expect(result.degradedIds).toEqual([]);
    expect(result.droppedIds).toEqual([]);
  });
});

describe("generateDigest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("skips the call entirely for short reports (below DIGEST_MIN_REPORT_CHARS)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await generateDigest("short report", fakeConnection("off"), "fake-model");
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses the constrained rung when supported and returns the parsed digest, capped", async () => {
    const longReport = "Report body. ".repeat(50); // > DIGEST_MIN_REPORT_CHARS
    expect(longReport.length).toBeGreaterThan(DIGEST_MIN_REPORT_CHARS);
    const overlong = "x".repeat(DIGEST_MAX_CHARS + 100);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify(chatCompletionBody(JSON.stringify({ digest: overlong }))), {
          status: 200,
        }),
      ),
    );
    const result = await generateDigest(longReport, fakeConnection("json_schema"), "fake-model");
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
  });

  it("falls back to the plain rung when structured outputs are off, tolerating a fenced or bare response", async () => {
    const longReport = "Report body. ".repeat(50);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        expect(body.response_format).toBeUndefined();
        return new Response(JSON.stringify(chatCompletionBody('```json\n{"digest":"key finding here"}\n```')), {
          status: 200,
        });
      }),
    );
    const result = await generateDigest(longReport, fakeConnection("off"), "fake-model");
    expect(result).toBe("key finding here");
  });

  it("returns null (never throws) when every rung fails", async () => {
    const longReport = "Report body. ".repeat(50);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const result = await generateDigest(longReport, fakeConnection("off"), "fake-model");
    expect(result).toBeNull();
  });
});

describe("capHeadTail", () => {
  it("is a no-op when the text already fits within head+tail", () => {
    expect(capHeadTail("short text", 100, 100)).toBe("short text");
  });

  it("keeps head and tail, eliding the middle with a stated marker", () => {
    const text = "H".repeat(50) + "M".repeat(500) + "T".repeat(50);
    const capped = capHeadTail(text, 50, 50);
    expect(capped.startsWith("H".repeat(50))).toBe(true);
    expect(capped.endsWith("T".repeat(50))).toBe(true);
    expect(capped).toContain("elided");
    expect(capped).not.toContain("M".repeat(500));
  });
});
