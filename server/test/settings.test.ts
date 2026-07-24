import { afterEach, describe, expect, it } from "vitest";
import { closeDb, createModelConfig } from "../src/db";
import {
  applyProfileToConnection,
  connectionFromConfigRow,
  importedOverridesForConnection,
  resolveConnection,
  resolveConnectionForModel,
} from "../src/settings";
import { buildProfileFromProbes } from "../src/profiles";
import { freshDb } from "./helpers";

afterEach(() => closeDb());

describe("resolveConnectionForModel", () => {
  it("falls back to the default connection when modelRef is empty", () => {
    freshDb();
    const def = resolveConnection();
    const { connection, modelId } = resolveConnectionForModel(null);
    expect(connection.baseUrl).toBe(def.baseUrl);
    expect(connection.textMode).toBe(def.textMode);
    expect(modelId).toBe(def.defaultModelId);
  });

  it("falls back to the default connection when modelRef matches no config name, using it verbatim as modelId", () => {
    freshDb();
    const def = resolveConnection();
    const { connection, modelId } = resolveConnectionForModel("some-raw-model-id-not-a-config-name");
    expect(connection.baseUrl).toBe(def.baseUrl);
    expect(modelId).toBe("some-raw-model-id-not-a-config-name");
  });

  it("resolves a named model config's own connection settings, not the default's", () => {
    freshDb();
    createModelConfig({
      name: "Local Qwen",
      base_url: "http://local-box:8000/v1",
      default_model: "qwen2.5-72b-instruct",
      text_mode: true,
    });
    const { connection, modelId } = resolveConnectionForModel("Local Qwen");
    expect(connection.baseUrl).toBe("http://local-box:8000/v1");
    expect(connection.textMode).toBe(true);
    // The resolved modelId must be the config's real default_model, not the
    // config's display name — this is the fix for the RolesEditor picker bug
    // (ModelPicker stores cfg.name, which must never be sent to the LLM API).
    expect(modelId).toBe("qwen2.5-72b-instruct");
  });

  it("does not leak one config's textMode/base_url onto another config's model", () => {
    freshDb();
    createModelConfig({
      name: "Hosted GPT",
      base_url: "https://api.example/v1",
      default_model: "gpt-5",
      text_mode: false,
    });
    createModelConfig({
      name: "Local Qwen",
      base_url: "http://local-box:8000/v1",
      default_model: "qwen2.5-72b-instruct",
      text_mode: true,
    });
    const hosted = resolveConnectionForModel("Hosted GPT");
    const local = resolveConnectionForModel("Local Qwen");
    expect(hosted.connection.textMode).toBe(false);
    expect(hosted.connection.baseUrl).toBe("https://api.example/v1");
    expect(hosted.modelId).toBe("gpt-5");
    expect(local.connection.textMode).toBe(true);
    expect(local.connection.baseUrl).toBe("http://local-box:8000/v1");
    expect(local.modelId).toBe("qwen2.5-72b-instruct");
  });
});

/** Build a cached ProbeResult JSON blob for a config row. */
function probeJson(
  baseUrl: string,
  modelId: string,
  modes: Partial<Record<"json_object" | "json_schema" | "guided_json" | "grammar", boolean>>,
): string {
  return JSON.stringify({
    probedAt: "2026-07-22T00:00:00.000Z",
    baseUrl,
    modelId,
    modes: { json_object: false, json_schema: false, guided_json: false, grammar: false, ...modes },
  });
}

describe("structured-outputs resolution (PLANNING/overhaul/02)", () => {
  it("resolves the highest supported rung from a probe taken against the current baseUrl+modelId", () => {
    freshDb();
    createModelConfig({
      name: "vLLM",
      base_url: "http://box:8000/v1",
      default_model: "qwen",
      structured_outputs_json: probeJson("http://box:8000/v1", "qwen", { json_schema: true, guided_json: true }),
    });
    const { connection } = resolveConnectionForModel("vLLM");
    expect(connection.structuredOutputs.mode).toBe("json_schema");
  });

  it("falls back to grammar when only the GBNF rung is supported", () => {
    freshDb();
    createModelConfig({
      name: "llamacpp",
      base_url: "http://box:8080/v1",
      default_model: "gguf",
      structured_outputs_json: probeJson("http://box:8080/v1", "gguf", { grammar: true }),
    });
    const { connection } = resolveConnectionForModel("llamacpp");
    expect(connection.structuredOutputs.mode).toBe("grammar");
  });

  it("ignores a stale probe taken against a different base URL (resolves off, the fail-safe rung)", () => {
    freshDb();
    createModelConfig({
      name: "moved",
      base_url: "http://new-box:8000/v1",
      default_model: "qwen",
      // Probe recorded against the OLD base URL — the endpoint was since edited.
      structured_outputs_json: probeJson("http://old-box:8000/v1", "qwen", { json_schema: true }),
    });
    const { connection } = resolveConnectionForModel("moved");
    expect(connection.structuredOutputs.mode).toBe("off");
  });

  it("ignores a stale probe taken against a different model id", () => {
    freshDb();
    createModelConfig({
      name: "swapped",
      base_url: "http://box:8000/v1",
      default_model: "qwen-new",
      structured_outputs_json: probeJson("http://box:8000/v1", "qwen-old", { json_schema: true }),
    });
    const { connection } = resolveConnectionForModel("swapped");
    expect(connection.structuredOutputs.mode).toBe("off");
  });

  it("treats a trailing slash on the base URL as insignificant when matching a probe", () => {
    freshDb();
    createModelConfig({
      name: "slashy",
      base_url: "http://box:8000/v1/",
      default_model: "qwen",
      structured_outputs_json: probeJson("http://box:8000/v1", "qwen", { json_schema: true }),
    });
    const { connection } = resolveConnectionForModel("slashy");
    expect(connection.structuredOutputs.mode).toBe("json_schema");
  });

  it("lets a manual override win even when the probe is stale", () => {
    freshDb();
    createModelConfig({
      name: "forced",
      base_url: "http://new-box:8000/v1",
      default_model: "qwen",
      structured_outputs_json: probeJson("http://old-box:8000/v1", "qwen", { json_schema: true }),
      compat_json: JSON.stringify({ structuredOutputsOverride: "guided_json" }),
    });
    const { connection } = resolveConnectionForModel("forced");
    expect(connection.structuredOutputs.mode).toBe("guided_json");
  });
});

describe("model capability profiles (PLANNING/overhaul/06) — resolution", () => {
  it("regression guard: with no stored profile, resolveConnectionForModel is byte-identical to hand-flag resolution", () => {
    freshDb();
    createModelConfig({
      name: "vLLM",
      base_url: "http://box:8000/v1",
      default_model: "qwen",
      text_mode: true,
      reasoning: true,
      thinking_format: "qwen",
    });
    // No profile has ever been probed/stored for this (connection, model) —
    // applyProfileToConnection must be a complete no-op.
    const { connection } = resolveConnectionForModel("vLLM");
    const hand = connectionFromConfigRow(
      createModelConfig({ name: "vLLM-control", base_url: "http://box:8000/v1", default_model: "qwen", text_mode: true, reasoning: true, thinking_format: "qwen" }),
    );
    expect(connection).toEqual(hand);
  });

  it("a stored profile's derived runShape overlays textMode/twoPhase on the resolved connection", () => {
    freshDb();
    createModelConfig({ name: "vLLM", base_url: "http://box:8000/v1", default_model: "qwen", text_mode: false });
    buildProfileFromProbes("http://box:8000/v1", "qwen", { customToolCall: { attempts: 0, successes: 0 }, builtinToolCall: { attempts: 1, successes: 0 } }, {});
    const { connection } = resolveConnectionForModel("vLLM");
    expect(connection.textMode).toBe(true); // derived runShape "text" overlays the hand flag
    expect(connection.twoPhase).toBe(false);
  });

  it("a stored profile's verdictDelivery overlays structuredOutputs, unless a manual structuredOutputsOverride is set", () => {
    freshDb();
    createModelConfig({ name: "vLLM", base_url: "http://box:8000/v1", default_model: "qwen" });
    buildProfileFromProbes(
      "http://box:8000/v1",
      "qwen",
      { structured: { json_object: true, json_schema: true, guided_json: false, grammar: false } },
      {},
    );
    const { connection } = resolveConnectionForModel("vLLM");
    expect(connection.structuredOutputs.mode).toBe("json_schema");
  });

  it("a manual structuredOutputsOverride on the config row still wins over the profile", () => {
    freshDb();
    createModelConfig({
      name: "vLLM",
      base_url: "http://box:8000/v1",
      default_model: "qwen",
      compat_json: JSON.stringify({ structuredOutputsOverride: "off" }),
    });
    buildProfileFromProbes(
      "http://box:8000/v1",
      "qwen",
      { structured: { json_object: true, json_schema: true, guided_json: false, grammar: false } },
      {},
    );
    const { connection } = resolveConnectionForModel("vLLM");
    expect(connection.structuredOutputs.mode).toBe("off");
  });

  it("a profile override wins over its own measured decision", () => {
    freshDb();
    createModelConfig({ name: "vLLM", base_url: "http://box:8000/v1", default_model: "qwen" });
    buildProfileFromProbes(
      "http://box:8000/v1",
      "qwen",
      { customToolCall: { attempts: 5, successes: 5 } }, // measures single-turn
      { runShape: "text" }, // human override forces text mode
    );
    const { connection } = resolveConnectionForModel("vLLM");
    expect(connection.textMode).toBe(true);
    expect(connection.twoPhase).toBe(false);
  });

  it("compat.supportsDeveloperRole on the config row stays the override layer over the profile", () => {
    freshDb();
    createModelConfig({
      name: "vLLM",
      base_url: "http://box:8000/v1",
      default_model: "qwen",
      compat_json: JSON.stringify({ supportsDeveloperRole: true }),
    });
    buildProfileFromProbes("http://box:8000/v1", "qwen", { developerRole: false }, {});
    const { connection } = resolveConnectionForModel("vLLM");
    expect(connection.compat.supportsDeveloperRole).toBe(true);
  });

  it("the profile fills compat.supportsDeveloperRole when the config row leaves it unset", () => {
    freshDb();
    createModelConfig({ name: "vLLM", base_url: "http://box:8000/v1", default_model: "qwen" });
    buildProfileFromProbes("http://box:8000/v1", "qwen", { developerRole: false }, {});
    const { connection } = resolveConnectionForModel("vLLM");
    expect(connection.compat.supportsDeveloperRole).toBe(false);
  });

  it("a profile keyed to a different base URL does not apply (connection sig mismatch)", () => {
    freshDb();
    createModelConfig({ name: "moved", base_url: "http://new-box:8000/v1", default_model: "qwen", text_mode: false });
    // Profile was captured against the OLD endpoint.
    buildProfileFromProbes("http://old-box:8000/v1", "qwen", { customToolCall: { attempts: 0, successes: 0 }, builtinToolCall: { attempts: 1, successes: 0 } }, {});
    const { connection } = resolveConnectionForModel("moved");
    expect(connection.textMode).toBe(false); // untouched — hand flag still applies
  });

  it("applyProfileToConnection is a pure no-op when there is no stored profile", () => {
    freshDb();
    const conn = resolveConnection();
    expect(applyProfileToConnection(conn, "some-model")).toEqual(conn);
  });
});

describe("importedOverridesForConnection", () => {
  it("snapshots textMode as runShape 'text' and 'fence' delivery", () => {
    freshDb();
    createModelConfig({ name: "c", base_url: "http://box/v1", default_model: "m", text_mode: true });
    const { connection } = resolveConnectionForModel("c");
    const overrides = importedOverridesForConnection(connection);
    expect(overrides.runShape).toBe("text");
    expect(overrides.verdictDelivery).toBe("fence");
  });

  it("snapshots twoPhase as runShape 'two-turn' and 'tool_call' delivery", () => {
    freshDb();
    createModelConfig({ name: "c", base_url: "http://box/v1", default_model: "m", two_phase: true });
    const { connection } = resolveConnectionForModel("c");
    const overrides = importedOverridesForConnection(connection);
    expect(overrides.runShape).toBe("two-turn");
    expect(overrides.verdictDelivery).toBe("tool_call");
  });

  it("snapshots neither flag as runShape 'single-turn'", () => {
    freshDb();
    createModelConfig({ name: "c", base_url: "http://box/v1", default_model: "m" });
    const { connection } = resolveConnectionForModel("c");
    const overrides = importedOverridesForConnection(connection);
    expect(overrides.runShape).toBe("single-turn");
    expect(overrides.verdictDelivery).toBe("tool_call");
  });

  it("prefers the cached structured-outputs mode as verdictDelivery when one is resolved", () => {
    freshDb();
    createModelConfig({
      name: "c",
      base_url: "http://box/v1",
      default_model: "m",
      structured_outputs_json: probeJson("http://box/v1", "m", { json_schema: true }),
    });
    const { connection } = resolveConnectionForModel("c");
    const overrides = importedOverridesForConnection(connection);
    expect(overrides.verdictDelivery).toBe("json_schema");
  });

  it("importing then building a profile from it is a resolution no-op (rollout step 2 guarantee)", () => {
    freshDb();
    createModelConfig({
      name: "c",
      base_url: "http://box/v1",
      default_model: "m",
      text_mode: true,
      reasoning: true,
    });
    const before = resolveConnectionForModel("c").connection;
    const imported = importedOverridesForConnection(before);
    buildProfileFromProbes("http://box/v1", "m", {}, imported);
    const after = resolveConnectionForModel("c").connection;
    expect(after).toEqual(before);
  });
});
