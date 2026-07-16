/**
 * Single typed configuration for Orchestra.
 *
 * Replaces the three duplicate Python config loaders (app.py / orchestrator.py /
 * db.py). Resolution order, lowest → highest precedence:
 *   1. built-in defaults (below, seeded from the old config.py values)
 *   2. ./config.json in the repo root (gitignored; see config.example.json)
 *   3. process.env (ORCHESTRA_* keys)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  /** Interface Fastify binds to. 0.0.0.0 so tailnet clients can reach it. */
  host: string;
  /** HTTP port for the daemon (UI + API + SSE). */
  port: number;

  /** OpenAI-compatible base URL, e.g. http://host:8080/v1 (NOT the /chat/completions path). */
  providerBaseUrl: string;
  /** Bearer token for the endpoint; empty when local auth is disabled. */
  apiKey: string;
  /** Model id used when a project/role does not override it. */
  defaultModelId: string;
  /** Context window / max output tokens advertised to pi for the local model. */
  contextWindow: number;
  maxTokens: number;
  /** Per-request timeout (ms) for LLM calls. */
  requestTimeoutMs: number;

  /**
   * Whether the model is a reasoning model. When true, pi enables a thinking
   * level and (for `thinkingFormat: "deepseek"`) requests native reasoning — the
   * endpoint's `reasoning_content` then streams on a separate channel. Leave true
   * for DeepSeek-R1 / QwQ-style models; set false for plain instruct models.
   */
  reasoning: boolean;
  /** Thinking level passed to pi when `reasoning` is true (off is implied by reasoning:false). */
  thinkingLevel: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** pi reasoning request shape for the OpenAI-compatible endpoint (advanced; config/env only). */
  thinkingFormat: string;

  /** SQLite file (reuses the existing orchestra.db by default). */
  dbPath: string;

  /** Idle poll interval for the orchestrator loop when there is no work (ms). */
  schedulerIdleMs: number;
  /** Max tool-calling turns pi may take within a single role run. */
  roleToolBudget: number;

  /** Directory of the built React client to serve (server/public). */
  clientDir: string;

  /**
   * Per-model API key map loaded from ORCHESTRA_TOKENS env var.
   * Keys are model config names, values are the API key strings.
   * When a model config's name matches a key here, the env token overrides
   * the DB-stored api_key for that model config.
   *
   * Example env: ORCHESTRA_TOKENS='{"qwen-7b":"sk-abc","deepseek-r1":"sk-xyz"}'
   */
  tokenMap: Record<string, string>;
}

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(SERVER_DIR, "..");

const DEFAULTS: Config = {
  host: "0.0.0.0",
  port: 5001,
  providerBaseUrl: "http://192.168.1.2:8080/v1",
  apiKey: "",
  defaultModelId: "deepseek-r1:latest",
  contextWindow: 128_000,
  maxTokens: 32_768,
  requestTimeoutMs: 300_000,
  reasoning: true,
  thinkingLevel: "medium",
  thinkingFormat: "qwen-chat-template",
  dbPath: path.join(REPO_ROOT, "orchestra.db"),
  schedulerIdleMs: 3_000,
  roleToolBudget: 40,
  clientDir: path.join(SERVER_DIR, "public"),
  tokenMap: {},
};

function readConfigFile(): Partial<Config> {
  const file = path.join(REPO_ROOT, "config.json");
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Config>;
  } catch (err) {
    console.warn(`[config] ignoring invalid config.json: ${(err as Error).message}`);
    return {};
  }
}

function readEnv(): Partial<Config> {
  const e = process.env;
  const out: Partial<Config> = {};
  if (e.ORCHESTRA_HOST) out.host = e.ORCHESTRA_HOST;
  if (e.ORCHESTRA_PORT) out.port = Number(e.ORCHESTRA_PORT);
  if (e.ORCHESTRA_BASE_URL) out.providerBaseUrl = e.ORCHESTRA_BASE_URL;
  if (e.ORCHESTRA_API_KEY) out.apiKey = e.ORCHESTRA_API_KEY;
  if (e.ORCHESTRA_MODEL) out.defaultModelId = e.ORCHESTRA_MODEL;
  if (e.ORCHESTRA_DB_PATH) out.dbPath = e.ORCHESTRA_DB_PATH;
  if (e.ORCHESTRA_REQUEST_TIMEOUT_MS) out.requestTimeoutMs = Number(e.ORCHESTRA_REQUEST_TIMEOUT_MS);
  if (e.ORCHESTRA_SCHEDULER_IDLE_MS) out.schedulerIdleMs = Number(e.ORCHESTRA_SCHEDULER_IDLE_MS);
  if (e.ORCHESTRA_MAX_TOKENS) out.maxTokens = Number(e.ORCHESTRA_MAX_TOKENS);
  if (e.ORCHESTRA_REASONING) out.reasoning = e.ORCHESTRA_REASONING !== "0" && e.ORCHESTRA_REASONING !== "false";
  if (e.ORCHESTRA_THINKING_LEVEL) out.thinkingLevel = e.ORCHESTRA_THINKING_LEVEL as Config["thinkingLevel"];
  if (e.ORCHESTRA_THINKING_FORMAT) out.thinkingFormat = e.ORCHESTRA_THINKING_FORMAT;
  if (e.ORCHESTRA_TOKENS) {
    try {
      const parsed = JSON.parse(e.ORCHESTRA_TOKENS);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        out.tokenMap = parsed as Record<string, string>;
      } else {
        console.warn("[config] ORCHESTRA_TOKENS is not a valid JSON object — ignoring");
      }
    } catch {
      console.warn("[config] ORCHESTRA_TOKENS is not valid JSON — ignoring");
    }
  }
  return out;
}

let cached: Config | undefined;

/** Resolve (and memoize) the effective configuration. */
export function getConfig(): Config {
  if (cached) return cached;
  cached = { ...DEFAULTS, ...readConfigFile(), ...readEnv() };
  return cached;
}

/** Test/CLI helper to force re-resolution (e.g. after writing config.json). */
export function resetConfig(): void {
  cached = undefined;
}
