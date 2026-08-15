/**
 * Idle-time self-maintenance (PLANNING/overhaul/08 §5): the system's own upkeep,
 * run by the watcher loop in the same idle window and under the same budgets as
 * watcher work. "A model pulled into Ollama at midnight is probed, profiled, and
 * usable by morning — the 'opportunistic' adjective applied to the system
 * itself."
 *
 * Three jobs, all idempotent, all strictly bounded per round:
 *
 *   1. **Model re-probing** (overhaul/06) — any configured connection whose
 *      (baseUrl, modelId) pair has no capability profile yet gets the behavioral
 *      probe suite run against it, exactly as the Models UI's "Probe" button
 *      would, and the derived profile persisted. Only ONE model per round: the
 *      suite is ~20 requests, and an operator who just added five connections
 *      should not have their whole idle window consumed by probing.
 *   2. **Digest backfill** (overhaul/07) — role runs whose rolling digest never
 *      landed (the fire-and-forget call failed, or the daemon stopped mid-flight)
 *      get one cheap completion each to fill it in, so later steps and
 *      `buildParentDigest` have the short form they expect instead of falling
 *      back to full summaries.
 *   3. **Workspace reaping** — `orchestra/*` branches and worktree directories
 *      with no owning task row get reclaimed, so Orchestra's bookkeeping stops
 *      piling up in a repo it doesn't own. Strictly non-destructive: an orphan
 *      branch still holding unmerged commits is reported and left alone.
 *
 * Everything here is best-effort by construction: this is housekeeping that runs
 * unattended, so a failure must cost one warning line and nothing else. Neither
 * job ever throws, and the scan loop treats a failure as "no work done".
 *
 * The third item doc §5 lists — "scheduled clean-worktree suite runs feeding the
 * test-suite watcher" — is already exactly what the `test-suite` watcher does on
 * its own cadence, so it needs nothing here.
 */

import {
  getConfigById,
  getMeta,
  listModelConfigs,
  listRoleRunsMissingDigest,
  setMeta,
  setRoleRunDigest,
  updateModelConfig,
  type ProjectRow,
} from "./db.js";
import {
  buildProfileFromProbes,
  loadProfile,
  profileConnectionSig,
  runModelProbes,
} from "./profiles.js";
import { sweepOrphanWorkspaces } from "./orchestrator.js";
import {
  connectionFromConfigRow,
  envTokenForModel,
  importedOverridesForConnection,
  resolveConnectionForModel,
} from "./settings.js";
import { generateDigest } from "./context-budget.js";
import type { AutonomyConfig } from "./autonomy.js";

/** How many missing digests to fill per round. Small on purpose: the backlog
 *  drains over successive idle rounds rather than in one burst that competes
 *  with real work for the same endpoint. */
export const DIGEST_BACKFILL_PER_ROUND = 5;

export interface ProbeTarget {
  configId: number;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  sig: string;
}

/** How long a failed probe suppresses retrying that same model. Without this,
 *  one unreachable endpoint (a laptop off the tailnet, a stopped Ollama) would
 *  cost ~20 doomed requests every single round, forever — the archetypal
 *  unattended-automation failure. */
export const PROBE_RETRY_BACKOFF_MS = 24 * 60 * 60 * 1000;

function probeFailureKey(sig: string, modelId: string): string {
  return `selfmaint:probe-failed:${sig}:${modelId}`;
}

function recentlyFailed(sig: string, modelId: string, nowMs: number): boolean {
  const raw = getMeta(probeFailureKey(sig, modelId));
  if (!raw) return false;
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return false;
  return nowMs - at < PROBE_RETRY_BACKOFF_MS;
}

/**
 * The first configured (connection, model) pair with no stored profile that
 * isn't inside its post-failure backoff, or null when there's nothing to probe.
 * Exported for direct testing — "which model would self-maintenance probe next"
 * is the whole decision, and it's pure apart from the DB reads.
 */
export function nextUnprofiledModel(nowMs = Date.now()): ProbeTarget | null {
  for (const cfg of listModelConfigs()) {
    const conn = connectionFromConfigRow(cfg);
    const baseUrl = conn.baseUrl.trim();
    const modelId = conn.defaultModelId.trim();
    // A connection missing either half isn't "unprobed", it's unconfigured —
    // probing it would fail every trial and persist a uniformly-incapable
    // profile that then looks measured.
    if (!baseUrl || !modelId) continue;
    const sig = profileConnectionSig(baseUrl);
    if (loadProfile(sig, modelId)) continue;
    if (recentlyFailed(sig, modelId, nowMs)) continue;
    return {
      configId: cfg.id,
      baseUrl,
      apiKey: cfg.api_key?.trim() || envTokenForModel(cfg.name) || "",
      modelId,
      sig,
    };
  }
  return null;
}

/** Probe + persist one unprofiled model. Returns true when a profile was
 *  written. Mirrors the Models UI's probe route: same probe suite, same
 *  imported-overrides handling, same structured-outputs cache refresh — this is
 *  the unattended path to the same outcome, not a second implementation. */
async function probeOneModel(): Promise<boolean> {
  const target = nextUnprofiledModel();
  if (!target) return false;
  try {
    const cfg = getConfigById(target.configId);
    if (!cfg) return false;
    // Recorded BEFORE the attempt: a probe that hangs until the daemon is
    // killed must still count as a failure, or restarting re-enters the same
    // doomed suite immediately.
    setMeta(probeFailureKey(target.sig, target.modelId), new Date().toISOString());
    // First probe of a model imports the connection's existing hand-set compat
    // flags as overrides, so measuring changes nothing until a human clears
    // them — identical to the interactive route's day-one contract.
    const overrides = importedOverridesForConnection(connectionFromConfigRow(cfg));
    const probes = await runModelProbes(target.baseUrl, target.apiKey, target.modelId);
    updateModelConfig(target.configId, {
      structured_outputs_json: JSON.stringify({
        probedAt: new Date().toISOString(),
        baseUrl: target.baseUrl,
        modelId: target.modelId,
        modes: probes.structured,
      }),
    });
    buildProfileFromProbes(target.baseUrl, target.modelId, probes, overrides);
    setMeta(probeFailureKey(target.sig, target.modelId), ""); // succeeded — clear the backoff
    console.log(`[self-maintenance] probed and profiled "${target.modelId}" (${target.baseUrl})`);
    return true;
  } catch (err) {
    console.warn(`[self-maintenance] probing "${target.modelId}" failed: ${(err as Error).message}`);
    return false;
  }
}

/** Fill in up to {@link DIGEST_BACKFILL_PER_ROUND} missing run digests for this
 *  project. Returns how many were written. */
export async function backfillDigests(project: ProjectRow, limit = DIGEST_BACKFILL_PER_ROUND): Promise<number> {
  const rows = listRoleRunsMissingDigest(project.id, limit);
  if (!rows.length) return 0;

  let written = 0;
  for (const row of rows) {
    try {
      // Resolve per row: different runs can have used different models, and the
      // digest should be generated by the same connection class that produced
      // the report rather than whatever the project default is today.
      const { connection, modelId } = resolveConnectionForModel(row.model ?? project.default_model, project.id);
      const digest = await generateDigest(row.output_md ?? "", connection, modelId);
      if (!digest) continue;
      setRoleRunDigest(row.id, digest);
      written++;
    } catch (err) {
      console.warn(`[self-maintenance] digest backfill failed for run ${row.id}: ${(err as Error).message}`);
    }
  }
  if (written) console.log(`[self-maintenance] backfilled ${written} run digest(s) for "${project.name}"`);
  return written;
}

/**
 * One round of upkeep for one project. Called by `tickWatchers` after the
 * watchers, inside the same enabled/active-hours/budget gate — so the
 * kill-switch and the idle-window budgets govern housekeeping exactly as they
 * govern self-generated work. Returns true when anything was done, which the
 * caller folds into its "did work this round" signal.
 */
export async function runSelfMaintenance(project: ProjectRow, cfg: AutonomyConfig): Promise<boolean> {
  const sm = cfg.selfMaintenance;
  if (!sm.enabled) return false;

  let didWork = false;
  if (sm.reprobeModels && (await probeOneModel())) didWork = true;
  if (sm.backfillDigests && (await backfillDigests(project)) > 0) didWork = true;
  if (sm.reapWorkspaces && reapWorkspaces(project)) didWork = true;
  return didWork;
}

/** Sweep this project's orphaned branches/worktrees. Wrapped so a git failure
 *  costs one warning line, like every other job here. */
function reapWorkspaces(project: ProjectRow): boolean {
  try {
    const swept = sweepOrphanWorkspaces(project);
    return swept.branchesDeleted.length > 0 || swept.worktreesRemoved.length > 0;
  } catch (err) {
    console.warn(`[self-maintenance] workspace sweep failed for "${project.name}": ${(err as Error).message}`);
    return false;
  }
}
