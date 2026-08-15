import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeDb,
  createProject,
  createRoleRun,
  createTask,
  createModelConfig,
  getRoleRun,
  listRoleRunsMissingDigest,
  setMeta,
  type ProjectRow,
} from "../src/db";
import { saveProfile, profileConnectionSig, type ModelProfile } from "../src/profiles";
import {
  backfillDigests,
  nextUnprofiledModel,
  runSelfMaintenance,
  PROBE_RETRY_BACKOFF_MS,
} from "../src/self-maintenance";
import { DEFAULT_AUTONOMY_CONFIG, type AutonomyConfig } from "../src/autonomy";
import { freshDb, tempGitRepo } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  closeDb();
});

const BASE_URL = "http://localhost:9999/v1";

function project(): ProjectRow {
  return createProject({ name: "p", repo_path: tempGitRepo() });
}

function config(cfg: Partial<AutonomyConfig> = {}): AutonomyConfig {
  return {
    ...DEFAULT_AUTONOMY_CONFIG,
    budgets: { ...DEFAULT_AUTONOMY_CONFIG.budgets },
    watchers: DEFAULT_AUTONOMY_CONFIG.watchers.map((w) => ({ ...w })),
    selfMaintenance: { ...DEFAULT_AUTONOMY_CONFIG.selfMaintenance },
    ...cfg,
  };
}

function addModelConfig(name: string, model: string, baseUrl = BASE_URL) {
  return createModelConfig({ name, base_url: baseUrl, default_model: model });
}

function existingProfile(modelId: string, baseUrl = BASE_URL): ModelProfile {
  return {
    model: modelId,
    connectionSig: profileConnectionSig(baseUrl),
    baseUrl,
    probedAt: new Date().toISOString(),
    probes: {},
    live: null,
    derived: {} as ModelProfile["derived"],
    rationale: {} as ModelProfile["rationale"],
    suggestion: null,
    overrides: {},
    modeState: {} as ModelProfile["modeState"],
  };
}

describe("nextUnprofiledModel", () => {
  it("returns nothing when there is nothing configured", () => {
    freshDb();
    expect(nextUnprofiledModel()).toBeNull();
  });

  it("picks a configured model that has no profile", () => {
    freshDb();
    addModelConfig("local", "qwen3-32b");
    const target = nextUnprofiledModel();
    expect(target).toMatchObject({ modelId: "qwen3-32b", baseUrl: BASE_URL });
  });

  it("skips a model that already has a profile", () => {
    freshDb();
    addModelConfig("local", "qwen3-32b");
    saveProfile(existingProfile("qwen3-32b"));
    expect(nextUnprofiledModel()).toBeNull();
  });

  it("skips a model whose probe failed inside the backoff window, and retries after it", () => {
    freshDb();
    addModelConfig("local", "qwen3-32b");
    const key = `selfmaint:probe-failed:${profileConnectionSig(BASE_URL)}:qwen3-32b`;

    setMeta(key, new Date().toISOString());
    expect(nextUnprofiledModel()).toBeNull();

    // Same failure, but the backoff has elapsed.
    const past = Date.now() + PROBE_RETRY_BACKOFF_MS + 60_000;
    expect(nextUnprofiledModel(past)).not.toBeNull();
  });

  it("treats a cleared failure marker as no failure", () => {
    freshDb();
    addModelConfig("local", "qwen3-32b");
    setMeta(`selfmaint:probe-failed:${profileConnectionSig(BASE_URL)}:qwen3-32b`, "");
    expect(nextUnprofiledModel()).not.toBeNull();
  });
});

describe("backfillDigests", () => {
  const LONG_REPORT = "# Report\n\n" + "This run produced a substantial amount of prose. ".repeat(20);

  function runWithReport(taskId: string, over: Record<string, unknown> = {}) {
    return createRoleRun({
      task_id: taskId,
      role_key: "developer",
      verdict: "pass",
      summary: "s",
      output_md: LONG_REPORT,
      depth: 0,
      ...over,
    } as Parameters<typeof createRoleRun>[0]);
  }

  function seedTask(p: ProjectRow) {
    return createTask({
      name: "t",
      content: "c",
      project_id: p.id,
      stage: "refining",
      level: "task",
      intake_kind: "feature",
      exit_kind: "spec",
    });
  }

  it("selects only runs with a real report and no digest", () => {
    freshDb();
    const p = project();
    const t = seedTask(p);
    const missing = runWithReport(t.task_id);
    runWithReport(t.task_id, { output_md: "too short" }); // below the material floor
    runWithReport(t.task_id, { output_md: null });

    const rows = listRoleRunsMissingDigest(p.id, 10);
    expect(rows.map((r) => r.id)).toEqual([missing.id]);
  });

  it("writes the digest the model returns", async () => {
    freshDb();
    const p = project();
    const t = seedTask(p);
    const target = runWithReport(t.task_id);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "Fixed the login redirect." } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const written = await backfillDigests(p);
    expect(written).toBe(1);
    expect(getRoleRun(target.id)!.digest).toContain("Fixed the login redirect");
  });

  it("leaves the digest NULL when the call fails, so the row stays eligible next round", async () => {
    freshDb();
    const p = project();
    const t = seedTask(p);
    const target = runWithReport(t.task_id);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));

    expect(await backfillDigests(p)).toBe(0);
    expect(getRoleRun(target.id)!.digest).toBeNull();
    expect(listRoleRunsMissingDigest(p.id, 10)).toHaveLength(1);
  });

  it("does nothing when there is no backlog", async () => {
    freshDb();
    const p = project();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await backfillDigests(p)).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("runSelfMaintenance gating", () => {
  it("does nothing at all when self-maintenance is disabled", async () => {
    freshDb();
    const p = project();
    addModelConfig("local", "qwen3-32b");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const did = await runSelfMaintenance(p, config({ selfMaintenance: { enabled: false, reprobeModels: true, backfillDigests: true } }));
    expect(did).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("honours the individual sub-flags", async () => {
    freshDb();
    const p = project();
    addModelConfig("local", "qwen3-32b");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    // Probing off + no digest backlog = nothing to do, and crucially no probe
    // requests fired at the endpoint.
    const did = await runSelfMaintenance(
      p,
      config({ selfMaintenance: { enabled: true, reprobeModels: false, backfillDigests: true } }),
    );
    expect(did).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
