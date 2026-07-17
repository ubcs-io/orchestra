import { afterEach, describe, expect, it } from "vitest";
import { closeDb, createModelConfig } from "../src/db";
import { resolveConnection, resolveConnectionForModel } from "../src/settings";
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
