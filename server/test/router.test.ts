import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoleRunResult } from "../src/agent";
import type { RoleRunner } from "../src/orchestrator";
import type { Connection } from "../src/settings";
import {
  assessSecondReview,
  DEFAULT_ROUTER_CONFIG,
  resetRouterFns,
  resolveRouterConfig,
  setSecondReviewFn,
  setTriageFn,
  triageCandidate,
  type CandidateTriageInput,
  type SecondReviewInput,
} from "../src/router";

afterEach(() => {
  resetRouterFns();
  vi.unstubAllGlobals();
});

function fakeConnection(mode: "json_schema" | "guided_json" | "off"): Connection {
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

  it("merges a project's candidateTriage override (PLANNING/overhaul/08 Call Point 6)", () => {
    expect(resolveRouterConfig(null).candidateTriage).toBe(false);
    const cfg = resolveRouterConfig(JSON.stringify({ router: { enabled: true, candidateTriage: true } }));
    expect(cfg.candidateTriage).toBe(true);
  });
});

const BASE_TRIAGE_INPUT: CandidateTriageInput = {
  projectName: "orchestra",
  watcher: "test-suite",
  candidateKind: "error_file",
  payloadSummary: "FAIL server/test/foo.test.ts > does a thing",
  openAutoTaskCount: 1,
  autoQueueDepth: 5,
  recentSuppressions: [],
};

describe("triageCandidate (Call Point 6)", () => {
  it("parses a valid decision from the model response", async () => {
    const runner = fakeJsonRunner(
      '```json\n{"worth_doing": true, "priority": 4, "rationale": "real failure", "suggested_kind": "error_file"}\n```',
    );
    const result = await triageCandidate(BASE_TRIAGE_INPUT, runner, "/repo", "PLANNING", "fake-model");
    expect(result.worth_doing).toBe(true);
    expect(result.priority).toBe(4);
  });

  it("fails toward NOT queuing when the model response is not valid JSON", async () => {
    const runner = fakeJsonRunner("not json at all");
    const result = await triageCandidate(BASE_TRIAGE_INPUT, runner, "/repo", "PLANNING", "fake-model");
    expect(result.worth_doing).toBe(false);
  });

  it("fails toward NOT queuing when priority is out of range", async () => {
    const runner = fakeJsonRunner('{"worth_doing": true, "priority": 9, "rationale": "x", "suggested_kind": "error_file"}');
    const result = await triageCandidate(BASE_TRIAGE_INPUT, runner, "/repo", "PLANNING", "fake-model");
    expect(result.worth_doing).toBe(false);
  });

  it("fails toward NOT queuing when the underlying role runner throws", async () => {
    const throwingRunner: RoleRunner = async () => {
      throw new Error("connection refused");
    };
    const result = await triageCandidate(BASE_TRIAGE_INPUT, throwingRunner, "/repo", "PLANNING", "fake-model");
    expect(result.worth_doing).toBe(false);
  });

  it("is overridable via the setTriageFn seam", async () => {
    setTriageFn(async () => ({ worth_doing: true, priority: 5, rationale: "override", suggested_kind: "error_file" }));
    const result = await triageCandidate(BASE_TRIAGE_INPUT, fakeJsonRunner("{}"), "/repo", "PLANNING", "fake-model");
    expect(result.priority).toBe(5);
    expect(result.rationale).toBe("override");
  });
});

describe("triageCandidate — constrained-decoding rung (overhaul/02)", () => {
  it("uses the constrained completion when the connection supports it, never touching the roleRunner fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify(
            chatCompletionBody('{"worth_doing":true,"priority":3,"rationale":"constrained path","suggested_kind":"error_file"}'),
          ),
          { status: 200 },
        ),
      ),
    );
    const runner = vi.fn(fakeJsonRunner("{}"));
    const result = await triageCandidate(
      BASE_TRIAGE_INPUT,
      runner,
      "/repo",
      "PLANNING",
      "fake-model",
      fakeConnection("json_schema"),
    );
    expect(result).toEqual({
      worth_doing: true,
      priority: 3,
      rationale: "constrained path",
      suggested_kind: "error_file",
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it("falls back to the roleRunner path when the constrained completion fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const result = await triageCandidate(
      BASE_TRIAGE_INPUT,
      fakeJsonRunner('{"worth_doing": true, "priority": 2, "rationale": "fallback path used", "suggested_kind": "error_file"}'),
      "/repo",
      "PLANNING",
      "fake-model",
      fakeConnection("json_schema"),
    );
    expect(result.rationale).toBe("fallback path used");
  });

  it("skips the constrained rung entirely when the connection has no structured-output support", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await triageCandidate(
      BASE_TRIAGE_INPUT,
      fakeJsonRunner('{"worth_doing": false, "priority": 1, "rationale": "unconstrained path", "suggested_kind": "error_file"}'),
      "/repo",
      "PLANNING",
      "fake-model",
      fakeConnection("off"),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.rationale).toBe("unconstrained path");
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

describe("assessSecondReview — constrained-decoding rung (overhaul/02)", () => {
  it("uses the constrained completion when the connection supports it, never touching the roleRunner fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify(chatCompletionBody('{"decision":"accept_with_note","reasoning":"minor nitpick","steer_note":"tighten wording"}')),
          { status: 200 },
        ),
      ),
    );
    const runner = vi.fn(fakeJsonRunner("{}"));
    const result = await assessSecondReview(
      BASE_INPUT,
      runner,
      "/repo",
      "PLANNING",
      "fake-model",
      fakeConnection("json_schema"),
    );
    expect(result).toEqual({
      decision: "accept_with_note",
      reasoning: "minor nitpick",
      steer_note: "tighten wording",
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it("falls back to the roleRunner path when the constrained completion fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const result = await assessSecondReview(
      BASE_INPUT,
      fakeJsonRunner('{"decision": "loopback", "reasoning": "fallback path used"}'),
      "/repo",
      "PLANNING",
      "fake-model",
      fakeConnection("json_schema"),
    );
    expect(result.decision).toBe("loopback");
    expect(result.reasoning).toBe("fallback path used");
  });

  it("skips the constrained rung entirely when the connection has no structured-output support", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await assessSecondReview(
      BASE_INPUT,
      fakeJsonRunner('{"decision": "accept", "reasoning": "unconstrained path"}'),
      "/repo",
      "PLANNING",
      "fake-model",
      fakeConnection("off"),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.reasoning).toBe("unconstrained path");
  });
});
