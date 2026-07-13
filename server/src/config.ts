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

  /** SQLite file (reuses the existing orchestra.db by default). */
  dbPath: string;

  /** Idle poll interval for the orchestrator loop when there is no work (ms). */
  schedulerIdleMs: number;
  /** Max tool-calling turns pi may take within a single role run. */
  roleToolBudget: number;

  /** Directory of the built React client to serve (server/public). */
  clientDir: string;
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
  maxTokens: 8_192,
  requestTimeoutMs: 300_000,
  dbPath: path.join(REPO_ROOT, "orchestra.db"),
  schedulerIdleMs: 3_000,
  roleToolBudget: 40,
  clientDir: path.join(SERVER_DIR, "public"),
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
