import { afterEach, describe, expect, it } from "vitest";
import type { RoleRunResult } from "../src/agent";
import type { RoleRunner } from "../src/orchestrator";
import {
  assessSecondReview,
  DEFAULT_ROUTER_CONFIG,
  resetRouterFns,
  resolveRouterConfig,
  setSecondReviewFn,
  type SecondReviewInput,
} from "../src/router";

afterEach(() => {
  resetRouterFns();
});

const BASE_INPUT: SecondReviewInput = {
  taskName: "t",
  intakeKind: "security",
  roleKey: "explorer",
  primaryVerdict: "pass",
  primarySummary: "looks fine",
  critiqueVerdict: "blocker",
  critiqueSummary: "exposes PII",
  coverageMap: { security: { status: "considered" } },
};

/** A fake RoleRunner that returns the given text as the "model response" the
 *  router's JSON extractor parses (mirrors routerCall's section_md-or-summary contract). */
function fakeJsonRunner(responseText: string): RoleRunner {
  return async (): Promise<RoleRunResult> => ({
    findings: {
      verdict: "pass",
      summary: "",
      open_questions: [],
      coverage: [],
      section_md: responseText,
    },
    toolCalls: [],
    transcriptJsonl: "",
    tokens: 1,
    model: "fake",
    fallback: false,
    stalled: false,
    thinkingText: "",
    filesWritten: [],
  });
}

describe("resolveRouterConfig", () => {
  it("returns defaults (including secondReview: false) when no config is set", () => {
    expect(resolveRouterConfig(null)).toEqual(DEFAULT_ROUTER_CONFIG);
  });

  it("merges a project's router overrides onto the defaults", () => {
    const cfg = resolveRouterConfig(JSON.stringify({ router: { enabled: true, secondReview: true } }));
    expect(cfg.enabled).toBe(true);
    expect(cfg.secondReview).toBe(true);
    expect(cfg.borderlineGateAssessment).toBe(false);
  });
});

describe("assessSecondReview (Call Point 4)", () => {
  it("parses a valid decision from the model response", async () => {
    const runner = fakeJsonRunner(
      '```json\n{"decision": "escalate", "reasoning": "genuine PII exposure"}\n```',
    );
    const result = await assessSecondReview(BASE_INPUT, runner, "/repo", "PLANNING", "fake-model");
    expect(result.decision).toBe("escalate");
    expect(result.reasoning).toContain("PII");
  });

  it("falls back to accept when the model response is not valid JSON", async () => {
    const runner = fakeJsonRunner("not json at all");
    const result = await assessSecondReview(BASE_INPUT, runner, "/repo", "PLANNING", "fake-model");
    expect(result.decision).toBe("accept");
  });

  it("falls back to accept when the decision value is invalid", async () => {
    const runner = fakeJsonRunner('{"decision": "maybe", "reasoning": "unsure"}');
    const result = await assessSecondReview(BASE_INPUT, runner, "/repo", "PLANNING", "fake-model");
    expect(result.decision).toBe("accept");
  });

  it("falls back to accept when the underlying role runner throws", async () => {
    const throwingRunner: RoleRunner = async () => {
      throw new Error("connection refused");
    };
    const result = await assessSecondReview(BASE_INPUT, throwingRunner, "/repo", "PLANNING", "fake-model");
    expect(result.decision).toBe("accept");
  });

  it("is overridable via the setSecondReviewFn seam", async () => {
    setSecondReviewFn(async () => ({ decision: "loopback", reasoning: "test override", steer_note: "redo it" }));
    const result = await assessSecondReview(
      BASE_INPUT,
      fakeJsonRunner("{}"),
      "/repo",
      "PLANNING",
      "fake-model",
    );
    expect(result.decision).toBe("loopback");
    expect(result.steer_note).toBe("redo it");
  });
});
