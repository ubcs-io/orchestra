import { afterEach, describe, expect, it } from "vitest";
import { closeDb, createRoleRun, createTask, upsertModelProfileRow } from "../src/db";
import {
  buildProfileFromProbes,
  deleteProfile,
  deriveProfile,
  effectiveDecisions,
  hashSig,
  listProfiles,
  loadProfile,
  MODE_CHANGE_COOLDOWN_RUNS,
  profileConnectionSig,
  refreshProfile,
  saveProfile,
  type BehaviorProbes,
  type ModeState,
  type ModelProfile,
} from "../src/profiles";
import type { ModelLiveStats } from "../src/db";
import { freshDb } from "./helpers";

afterEach(() => closeDb());

function trial(successes: number, attempts = 5) {
  return { successes, attempts };
}

function live(overrides: Partial<ModelLiveStats> = {}): ModelLiveStats {
  return {
    totalRuns: 100,
    runs: 30,
    window: 30,
    fallbackRate: 0,
    stallRate: 0,
    truncationRate: 0,
    repairRate: 0,
    byMode: {},
    ...overrides,
  };
}

describe("hashSig / profileConnectionSig", () => {
  it("is stable for the same input", () => {
    expect(hashSig("abc")).toBe(hashSig("abc"));
  });

  it("differs for different inputs", () => {
    expect(hashSig("abc")).not.toBe(hashSig("abd"));
  });

  it("normalizes a trailing slash on the base URL", () => {
    expect(profileConnectionSig("http://box:8000/v1")).toBe(profileConnectionSig("http://box:8000/v1/"));
  });

  it("differs across base URLs", () => {
    expect(profileConnectionSig("http://box-a:8000/v1")).not.toBe(profileConnectionSig("http://box-b:8000/v1"));
  });
});

describe("deriveProfile — runShape from probes", () => {
  it("single-turn when custom tool calls are reliable", () => {
    const { derived, rationale } = deriveProfile({ customToolCall: trial(5) }, null);
    expect(derived.runShape).toBe("single-turn");
    expect(rationale.runShape).toMatch(/custom tool calls reliable/);
  });

  it("two-turn when custom tool calls are unreliable but built-in tool calls work", () => {
    const { derived } = deriveProfile({ customToolCall: trial(1), builtinToolCall: trial(5) }, null);
    expect(derived.runShape).toBe("two-turn");
  });

  it("two-turn (conservative default) when neither tool-call probe ran", () => {
    const { derived, rationale } = deriveProfile({}, null);
    expect(derived.runShape).toBe("two-turn");
    expect(rationale.runShape).toMatch(/conservative/);
  });

  it("text mode when built-in tool calls were probed and also unreliable", () => {
    const { derived } = deriveProfile({ customToolCall: trial(0), builtinToolCall: trial(1) }, null);
    expect(derived.runShape).toBe("text");
  });

  it("treats exactly the reliability floor (4/5 = 80%) as reliable", () => {
    const { derived } = deriveProfile({ customToolCall: trial(4) }, null);
    expect(derived.runShape).toBe("single-turn");
  });

  it("treats just below the floor (3/5 = 60%) as unreliable", () => {
    const { derived } = deriveProfile({ customToolCall: trial(3), builtinToolCall: trial(5) }, null);
    expect(derived.runShape).toBe("two-turn");
  });
});

describe("deriveProfile — live demotion", () => {
  it("demotes single-turn to two-turn when live fallback rate exceeds 10% over >=10 runs", () => {
    const { derived, rationale } = deriveProfile(
      { customToolCall: trial(5) },
      live({ runs: 20, fallbackRate: 0.15 }),
    );
    expect(derived.runShape).toBe("two-turn");
    expect(rationale.runShape).toMatch(/demoted/);
  });

  it("does not demote below the minimum live sample size", () => {
    const { derived } = deriveProfile({ customToolCall: trial(5) }, live({ runs: 5, fallbackRate: 0.5 }));
    expect(derived.runShape).toBe("single-turn");
  });

  it("does not demote at exactly the 10% threshold (strictly greater-than)", () => {
    const { derived } = deriveProfile({ customToolCall: trial(5) }, live({ runs: 20, fallbackRate: 0.1 }));
    expect(derived.runShape).toBe("single-turn");
  });

  it("never demotes two-turn or text (only single-turn is at risk)", () => {
    const { derived } = deriveProfile(
      { customToolCall: trial(1), builtinToolCall: trial(5) },
      live({ runs: 30, fallbackRate: 0.9 }),
    );
    expect(derived.runShape).toBe("two-turn");
  });
});

describe("deriveProfile — hysteresis", () => {
  it("holds a demoted mode within the cooldown window even if probes now look better", () => {
    const prior: ModeState = { runShape: "two-turn", changedAtTotalRuns: 90 };
    const { derived, modeState } = deriveProfile(
      { customToolCall: trial(5) },
      live({ totalRuns: 95, runs: 30 }), // only 5 runs since the change
      prior,
    );
    // Probes alone would say single-turn; hysteresis holds two-turn.
    expect(derived.runShape).toBe("two-turn");
    expect(modeState.runShape).toBe("two-turn");
  });

  it("promotion is suggestion-only, never automatic, even after the cooldown", () => {
    const prior: ModeState = { runShape: "two-turn", changedAtTotalRuns: 0 };
    const { derived, suggestion } = deriveProfile(
      { customToolCall: trial(5) },
      live({ totalRuns: MODE_CHANGE_COOLDOWN_RUNS + 5, runs: 30, fallbackRate: 0.0 }),
      prior,
    );
    expect(derived.runShape).toBe("two-turn");
    expect(suggestion).toMatch(/consider promoting/);
  });

  it("no suggestion when the model is still failing under the demoted shape", () => {
    const prior: ModeState = { runShape: "two-turn", changedAtTotalRuns: 0 };
    const { suggestion } = deriveProfile(
      { customToolCall: trial(5) },
      live({ totalRuns: MODE_CHANGE_COOLDOWN_RUNS + 5, runs: 30, fallbackRate: 0.2 }),
      prior,
    );
    expect(suggestion).toBeNull();
  });

  it("a fresh probe (prior = null) adopts its own verdict immediately, exempt from hysteresis", () => {
    const { derived } = deriveProfile({ customToolCall: trial(5) }, live({ fallbackRate: 0.9, runs: 30 }), null);
    // Even a terrible live rate demotes on a fresh probe — hysteresis has no
    // prior mode to hold onto, but the demotion rule itself still applies.
    expect(derived.runShape).toBe("two-turn");
  });

  it("after the cooldown elapses, a live-driven demotion adopts the new mode state", () => {
    const prior: ModeState = { runShape: "single-turn", changedAtTotalRuns: 0 };
    const { modeState } = deriveProfile(
      { customToolCall: trial(5) },
      live({ totalRuns: MODE_CHANGE_COOLDOWN_RUNS + 5, runs: 20, fallbackRate: 0.2 }),
      prior,
    );
    expect(modeState.runShape).toBe("two-turn");
    expect(modeState.changedAtTotalRuns).toBe(MODE_CHANGE_COOLDOWN_RUNS + 5);
  });
});

describe("deriveProfile — verdictDelivery", () => {
  it("prefers json_schema over guided_json and grammar", () => {
    const { derived } = deriveProfile(
      { structured: { json_object: true, json_schema: true, guided_json: true, grammar: true } },
      null,
    );
    expect(derived.verdictDelivery).toBe("json_schema");
  });

  it("falls back to guided_json when json_schema is unsupported", () => {
    const { derived } = deriveProfile(
      { structured: { json_object: true, json_schema: false, guided_json: true, grammar: false } },
      null,
    );
    expect(derived.verdictDelivery).toBe("guided_json");
  });

  it("falls back to grammar when only GBNF is supported", () => {
    const { derived } = deriveProfile(
      { structured: { json_object: false, json_schema: false, guided_json: false, grammar: true } },
      null,
    );
    expect(derived.verdictDelivery).toBe("grammar");
  });

  it("uses tool_call when no constrained decoding but the run shape is single-turn", () => {
    const { derived } = deriveProfile({ customToolCall: trial(5) }, null);
    expect(derived.verdictDelivery).toBe("tool_call");
  });

  it("falls back to fence when no constrained decoding and the shape is not single-turn", () => {
    const { derived } = deriveProfile({ customToolCall: trial(1), builtinToolCall: trial(5) }, null);
    expect(derived.verdictDelivery).toBe("fence");
  });
});

describe("deriveProfile — direct observations", () => {
  it("maps toolCapable from either tool-call channel", () => {
    expect(deriveProfile({ customToolCall: trial(5) }, null).derived.toolCapable).toBe(true);
    expect(deriveProfile({ builtinToolCall: trial(5) }, null).derived.toolCapable).toBe(true);
    expect(deriveProfile({ customToolCall: trial(0), builtinToolCall: trial(1) }, null).derived.toolCapable).toBe(
      false,
    );
  });

  it("leaves toolCapable undefined when neither tool-call probe ran", () => {
    expect(deriveProfile({}, null).derived.toolCapable).toBeUndefined();
  });

  it("maps thinkingDialect to reasoning", () => {
    expect(deriveProfile({ thinkingDialect: "reasoning_content" }, null).derived.reasoning).toBe(true);
    expect(deriveProfile({ thinkingDialect: "think_tags" }, null).derived.reasoning).toBe(true);
    expect(deriveProfile({ thinkingDialect: "none" }, null).derived.reasoning).toBe(false);
    expect(deriveProfile({}, null).derived.reasoning).toBeUndefined();
  });

  it("maps param-acceptance probes straight through", () => {
    const { derived } = deriveProfile(
      { developerRole: false, reasoningEffortParam: true, maxTokensField: "max_tokens" },
      null,
    );
    expect(derived.supportsDeveloperRole).toBe(false);
    expect(derived.supportsReasoningEffort).toBe(true);
    expect(derived.maxTokensField).toBe("max_tokens");
  });
});

describe("effectiveDecisions — override precedence", () => {
  it("returns the measured decisions unchanged with no overrides", () => {
    const profile: ModelProfile = {
      model: "m",
      connectionSig: "s",
      baseUrl: "http://x/v1",
      probedAt: null,
      probes: {},
      live: null,
      derived: { runShape: "single-turn", verdictDelivery: "tool_call" },
      rationale: {},
      suggestion: null,
      overrides: {},
      modeState: null,
    };
    expect(effectiveDecisions(profile)).toEqual(profile.derived);
  });

  it("an override wins field-by-field over the measured value", () => {
    const profile: ModelProfile = {
      model: "m",
      connectionSig: "s",
      baseUrl: "http://x/v1",
      probedAt: null,
      probes: {},
      live: null,
      derived: { runShape: "single-turn", verdictDelivery: "tool_call", reasoning: false },
      rationale: {},
      suggestion: null,
      overrides: { runShape: "text" },
      modeState: null,
    };
    const eff = effectiveDecisions(profile);
    expect(eff.runShape).toBe("text");
    expect(eff.verdictDelivery).toBe("tool_call"); // untouched
    expect(eff.reasoning).toBe(false); // untouched
  });

  it("a partial override bag never erases sibling measured fields", () => {
    const profile: ModelProfile = {
      model: "m",
      connectionSig: "s",
      baseUrl: "http://x/v1",
      probedAt: null,
      probes: {},
      live: null,
      derived: {
        runShape: "two-turn",
        verdictDelivery: "fence",
        toolCapable: false,
        reasoning: true,
      },
      rationale: {},
      suggestion: null,
      overrides: { toolCapable: true },
      modeState: null,
    };
    const eff = effectiveDecisions(profile);
    expect(eff.toolCapable).toBe(true);
    expect(eff.runShape).toBe("two-turn");
    expect(eff.reasoning).toBe(true);
  });
});

describe("profile store round-trip", () => {
  it("buildProfileFromProbes persists a profile that loadProfile can read back", () => {
    freshDb();
    const probes: BehaviorProbes = { customToolCall: trial(5) };
    const built = buildProfileFromProbes("http://box:8000/v1", "qwen2.5", probes, {});
    const loaded = loadProfile(profileConnectionSig("http://box:8000/v1"), "qwen2.5");
    expect(loaded).not.toBeNull();
    expect(loaded!.model).toBe("qwen2.5");
    expect(loaded!.derived.runShape).toBe(built.derived.runShape);
  });

  it("carries the passed-in overrides bag through to the stored profile", () => {
    freshDb();
    const built = buildProfileFromProbes("http://box:8000/v1", "qwen2.5", {}, { runShape: "text" });
    expect(built.overrides.runShape).toBe("text");
    const loaded = loadProfile(built.connectionSig, "qwen2.5");
    expect(loaded!.overrides.runShape).toBe("text");
  });

  it("returns null for a (connection, model) pair that was never probed", () => {
    freshDb();
    expect(loadProfile("nonexistent-sig", "nonexistent-model")).toBeNull();
  });

  it("deleteProfile forgets a stored profile", () => {
    freshDb();
    const built = buildProfileFromProbes("http://box:8000/v1", "qwen2.5", {}, {});
    deleteProfile(built.connectionSig, "qwen2.5");
    expect(loadProfile(built.connectionSig, "qwen2.5")).toBeNull();
  });

  it("saveProfile upserts in place rather than duplicating rows", () => {
    freshDb();
    const built = buildProfileFromProbes("http://box:8000/v1", "qwen2.5", {}, {});
    saveProfile({ ...built, suggestion: "hand-edited" });
    const loaded = loadProfile(built.connectionSig, "qwen2.5");
    expect(loaded!.suggestion).toBe("hand-edited");
    expect(listProfiles().filter((p) => p.model === "qwen2.5")).toHaveLength(1);
  });

  it("listProfiles refreshes every stored profile against current live data", () => {
    freshDb();
    buildProfileFromProbes("http://box:8000/v1", "model-a", { customToolCall: trial(5) }, {});
    buildProfileFromProbes("http://box:8000/v1", "model-b", {}, {});
    const all = listProfiles();
    expect(all.map((p) => p.model).sort()).toEqual(["model-a", "model-b"]);
  });

  it("a malformed stored profile_json reads as no profile rather than throwing", () => {
    freshDb();
    // Write the row directly (bypassing profiles.ts) to simulate corruption.
    upsertModelProfileRow("sig", "model-x", "{not json");
    expect(loadProfile("sig", "model-x")).toBeNull();
  });
});

describe("refreshProfile", () => {
  it("folds fresh live stats in and re-derives, persisting the result", () => {
    freshDb();
    const built = buildProfileFromProbes("http://box:8000/v1", "qwen2.5", { customToolCall: trial(5) }, {});
    expect(built.derived.runShape).toBe("single-turn");

    // Simulate 20 primary runs, all fallback, recorded against this model id —
    // enough to trip the live-demotion threshold on the next refresh.
    const task = createTask({ name: "t" });
    for (let i = 0; i < 20; i++) {
      createRoleRun({ task_id: task.task_id, role_key: "worker", model: "qwen2.5", fallback: 1, verdict_source: "fallback" });
    }

    const refreshed = refreshProfile(built);
    expect(refreshed.live?.runs).toBe(20);
    expect(refreshed.derived.runShape).toBe("two-turn");
  });
});
