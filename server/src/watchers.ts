/**
 * Watchers (PLANNING/overhaul/08 §1/§2): read-only scanners that turn repo
 * state into self-generated intake. This pass ships exactly one — `test-suite`,
 * the doc's own highest-value pick — running the project's configured
 * test/typecheck commands against a dedicated, read-only scan worktree of the
 * default branch, never a task worktree.
 *
 * A watcher never creates a task directly: it produces a candidate, which
 * `tickWatchers` dedupes against prior sightings and hands to
 * `triageAndMaybeQueue` (a Call-Point-6 router mini-call, capped by
 * `autoQueueDepth` and a per-watcher daily limit). Only an approved candidate
 * becomes a task, via `orchestrator.ts`'s `materializeIntakeTask` — the exact
 * same create→worktree→artifact→commit path a human-dropped intake file uses.
 *
 * Module boundary: this file imports FROM `orchestrator.ts` (materializeIntakeTask,
 * getRoleRunner) — `orchestrator.ts` does NOT import this file back. Instead
 * `main.ts` wires `tickWatchers()` into its own loop, parallel to how it wires
 * `startScheduler()`. This keeps the import graph one-directional.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  createCandidate,
  findLatestCandidateByFingerprint,
  getMeta,
  listCandidates,
  listProjects,
  countCandidatesQueuedToday,
  countOpenWatcherTasks,
  setMeta,
  updateCandidate,
  type CandidateRow,
  type ProjectRow,
} from "./db.js";
import { ensureWorktree, resetHardTo, resolveRef, currentBranch, WORKTREES_DIR } from "./git.js";
import { buildExecEnv, isGreen, runExecCommand, type ExecEvidence } from "./exec.js";
import {
  DEFAULT_EXEC_MAX_OUTPUT_BYTES,
  DEFAULT_EXEC_TIMEOUT_MS,
  findExecCommand,
  resolveHarnessPolicy,
} from "./harness-policy.js";
import {
  getOrResetIdleWindowBudget,
  isWithinActiveHours,
  recordAutonomousExecRun,
  recordAutonomousTaskStart,
  resolveAutonomyConfig,
  type AutonomyConfig,
  type WatcherConfig,
} from "./autonomy.js";
import { resolveRouterConfig, triageCandidate } from "./router.js";
import { resolveConnectionForModel } from "./settings.js";
import { FLOW_TEMPLATES, type IntakeKind } from "./roles.js";
import { getRoleRunner, materializeIntakeTask } from "./orchestrator.js";

// ---------------------------------------------------------------------------
// Scan worktree lifecycle
// ---------------------------------------------------------------------------

const SCAN_BRANCH = "orchestra/_scan";

function scanWorktreeDir(project: ProjectRow): string {
  return path.join(project.repo_path, WORKTREES_DIR, "_scan");
}

/** Node/npm-specific workaround: a fresh git worktree has no `node_modules`
 *  (gitignored everywhere), which would fail `npm test`/`typecheck` for a
 *  reason that has nothing to do with the code under test. Symlinks the
 *  primary checkout's `node_modules` in if the scan worktree doesn't have one
 *  yet. Best-effort — never throws. A real gap for non-Node stacks, flagged as
 *  a follow-up rather than solved generally in this pass. */
function symlinkNodeModulesIfMissing(repoPath: string, scanDir: string): void {
  try {
    const target = path.join(scanDir, "node_modules");
    const source = path.join(repoPath, "node_modules");
    if (fs.existsSync(target) || !fs.existsSync(source)) return;
    fs.symlinkSync(source, target, "dir");
  } catch (err) {
    console.warn(`[watchers] could not link node_modules into scan worktree: ${(err as Error).message}`);
  }
}

/** Create (once) a project's dedicated, read-only scan worktree on its own
 *  stable branch — never a task worktree. Idempotent, like `ensureTaskWorkspace`. */
export function ensureScanWorktree(project: ProjectRow): string {
  const dir = scanWorktreeDir(project);
  const baseBranch = project.main_branch || currentBranch(project.repo_path);
  ensureWorktree(project.repo_path, dir, SCAN_BRANCH, baseBranch);
  symlinkNodeModulesIfMissing(project.repo_path, dir);
  return dir;
}

/** Reset the scan worktree to the default branch's current tip before every
 *  scan, without touching whatever's checked out at the project's own
 *  repo_path (the scan worktree sits on its own branch throughout). */
export function resetScanWorktreeToBase(project: ProjectRow, scanDir: string): void {
  const baseBranch = project.main_branch || currentBranch(project.repo_path);
  const tipSha = resolveRef(project.repo_path, baseBranch);
  resetHardTo(scanDir, tipSha);
}

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

export interface FailingTestId {
  file?: string;
  name: string;
}

/** Best-effort extraction of failing test identifiers from combined
 *  stdout+stderr. Tuned for vitest's default reporter (this repo's actual
 *  runner) — lines like `FAIL  server/test/foo.test.ts > suite > test` or a
 *  `×`/`✗`-prefixed failing-test line. Any other runner simply yields no ids
 *  here, which `computeFingerprint` falls back to whole-output hashing for:
 *  dedupe still works, just with thinner triage context. Never throws. */
export function extractFailingTestIds(output: string): FailingTestId[] {
  const ids: FailingTestId[] = [];
  const seen = new Set<string>();
  const lineRe = /^\s*(?:FAIL|×|✗|✖)\s+(.+?)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(output))) {
    const raw = (m[1] ?? "").trim();
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    const parts = raw.split(">").map((s) => s.trim());
    const file = parts[0] && /\.(test|spec)\.[tj]sx?$/.test(parts[0]) ? parts[0] : undefined;
    ids.push({ file, name: raw });
  }
  return ids;
}

/** Stable dedupe key for one exec run: a sha256 of the sorted failing-id set,
 *  or (when no ids were extractable) of the trimmed raw output. Same
 *  fingerprint for the same underlying failure regardless of run order. */
export function computeFingerprint(evidence: ExecEvidence): string {
  const ids = extractFailingTestIds(evidence.outputTail);
  const basis = ids.length
    ? `ids:${ids.map((i) => i.name).sort().join("|")}`
    : `raw:${evidence.outputTail.trim()}`;
  return crypto.createHash("sha256").update(basis).digest("hex");
}

// ---------------------------------------------------------------------------
// Flake-guard: same fingerprint twice before proposing
// ---------------------------------------------------------------------------

function pendingFingerprintKey(projectId: number, commandName: string): string {
  return `autonomy:test-suite:${projectId}:${commandName}:pending_fp`;
}

/** Returns the fingerprint to propose as a candidate — but only once the SAME
 *  fingerprint has been seen on two consecutive scans of this command. A green
 *  run clears the pending marker; a red run with a *different* fingerprint
 *  than the pending one replaces it (restarting the two-in-a-row count) rather
 *  than confirming. Implements the doc's flaky-suppression note ("require the
 *  same failure fingerprint twice before proposing"). Once confirmed, the
 *  marker is left in place — a further identical failure just re-confirms
 *  (a no-op downstream, since an already-open candidate/task dedupes it). */
export function confirmOrDeferFingerprint(
  projectId: number,
  commandName: string,
  evidence: ExecEvidence,
): string | null {
  const key = pendingFingerprintKey(projectId, commandName);
  if (isGreen(evidence)) {
    setMeta(key, "");
    return null;
  }
  const fingerprint = computeFingerprint(evidence);
  const pending = getMeta(key);
  if (pending === fingerprint) return fingerprint;
  setMeta(key, fingerprint);
  return null;
}

// ---------------------------------------------------------------------------
// The test-suite watcher
// ---------------------------------------------------------------------------

export interface WatcherCandidate {
  watcher: string;
  kind: string;
  fingerprint: string;
  payload: Record<string, unknown>;
}

/**
 * Runs the project's configured exec-allowlist commands (default
 * `["test","typecheck"]`, or the watcher's own `commands` override) against a
 * freshly-reset scan worktree of the default branch. Never throws — a red
 * suite, a missing command, or a worktree-setup failure are all ordinary,
 * recordable-or-skippable outcomes, matching `runExecCommand`'s own contract.
 */
export async function runTestSuiteWatcher(
  project: ProjectRow,
  watcherCfg: WatcherConfig,
  signal?: AbortSignal,
): Promise<WatcherCandidate[]> {
  let scanDir: string;
  try {
    scanDir = ensureScanWorktree(project);
    resetScanWorktreeToBase(project, scanDir);
  } catch (err) {
    console.warn(`[watchers] test-suite scan worktree setup failed for project ${project.id}: ${(err as Error).message}`);
    return [];
  }

  const policy = resolveHarnessPolicy(project.config_json);
  const commandNames = watcherCfg.commands?.length ? watcherCfg.commands : ["test", "typecheck"];
  const env = buildExecEnv(policy);
  const candidates: WatcherCandidate[] = [];

  for (const name of commandNames) {
    const command = findExecCommand(policy, name);
    if (!command) continue; // nothing configured under this name — skip, not an error

    const evidence = await runExecCommand({
      name: command.name,
      argv: command.argv,
      cwd: scanDir,
      timeoutMs: command.timeoutMs ?? policy.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
      maxOutputBytes: policy.execMaxOutputBytes ?? DEFAULT_EXEC_MAX_OUTPUT_BYTES,
      env,
      signal,
    });
    recordAutonomousExecRun(project.id);

    const fingerprint = confirmOrDeferFingerprint(project.id, name, evidence);
    if (!fingerprint) continue;

    const baseBranch = project.main_branch || "the default branch";
    candidates.push({
      watcher: "test-suite",
      kind: "error_file",
      fingerprint,
      payload: {
        command: name,
        argv: evidence.argv,
        exitCode: evidence.exitCode,
        outputTail: evidence.outputTail,
        renderedContent:
          `# Failing \`${name}\` on ${baseBranch}\n\n` +
          `Command: \`${evidence.argv.join(" ")}\`\n\n` +
          `Exit code: ${evidence.exitCode ?? `killed (${evidence.signal ?? "signal"})`}\n\n` +
          `\`\`\`\n${evidence.outputTail}\n\`\`\`\n`,
      },
    });
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Candidate -> task promotion (Call Point 6 triage + caps)
// ---------------------------------------------------------------------------

/**
 * Triage one pending candidate and, if approved and under every cap,
 * materialize it into a real task via the same path human intake uses.
 * Exported for direct unit testing of the cap/dedupe/reject/queue branches.
 */
export async function triageAndMaybeQueue(
  project: ProjectRow,
  candidate: CandidateRow,
  cfg: AutonomyConfig,
): Promise<void> {
  if (countOpenWatcherTasks(project.id) >= cfg.autoQueueDepth) {
    updateCandidate(candidate.id, { status: "capped" });
    return;
  }
  const watcherCfg = cfg.watchers.find((w) => w.name === candidate.watcher);
  const dailyCap = watcherCfg?.perWatcherDailyCap ?? 2;
  if (countCandidatesQueuedToday(project.id, candidate.watcher) >= dailyCap) {
    updateCandidate(candidate.id, { status: "capped" });
    return;
  }

  let payload: { outputTail?: string; renderedContent?: string } = {};
  try {
    payload = JSON.parse(candidate.payload_json) as typeof payload;
  } catch {
    /* malformed payload — everything below just falls back to empty */
  }

  const routerCfg = resolveRouterConfig(project.config_json);
  let decision: { worth_doing: boolean; priority: number; rationale: string; suggested_kind: string };
  if (!routerCfg.enabled || !routerCfg.candidateTriage) {
    // Triage disabled for this project — fail toward NOT queuing rather than
    // silently auto-approving every candidate sight unseen.
    decision = {
      worth_doing: false,
      priority: 3,
      rationale: "candidate triage is disabled for this project",
      suggested_kind: candidate.kind,
    };
  } else {
    const { connection, modelId } = resolveConnectionForModel(project.default_model, project.id);
    const recentSuppressions = listCandidates({ projectId: project.id, watcher: candidate.watcher, status: "suppressed" })
      .slice(0, 5)
      .map((c) => c.suppressed_reason ?? "")
      .filter(Boolean);
    decision = await triageCandidate(
      {
        projectName: project.name,
        watcher: candidate.watcher,
        candidateKind: candidate.kind,
        payloadSummary: (payload.outputTail ?? "").slice(-4000),
        openAutoTaskCount: countOpenWatcherTasks(project.id),
        autoQueueDepth: cfg.autoQueueDepth,
        recentSuppressions,
      },
      getRoleRunner(),
      project.repo_path,
      project.planning_dir || "PLANNING",
      modelId,
      connection,
    );
  }

  updateCandidate(candidate.id, {
    triage_json: JSON.stringify(decision),
    status: decision.worth_doing ? "queued" : "rejected",
  });
  if (!decision.worth_doing) return;

  const suggestedKind = decision.suggested_kind as IntakeKind;
  const task = materializeIntakeTask(project, {
    name: `[watcher:${candidate.watcher}] ${candidate.kind} candidate`,
    content: payload.renderedContent ?? payload.outputTail ?? "(no content captured)",
    intakeKind: suggestedKind in FLOW_TEMPLATES ? suggestedKind : "error_file",
    origin: `watcher:${candidate.watcher}`,
    priority: decision.priority,
  });
  updateCandidate(candidate.id, { task_id: task.task_id });
  recordAutonomousTaskStart(project.id);
}

// ---------------------------------------------------------------------------
// Registry + scheduler entry point
// ---------------------------------------------------------------------------

type WatcherFn = (project: ProjectRow, cfg: WatcherConfig, signal?: AbortSignal) => Promise<WatcherCandidate[]>;

const WATCHER_REGISTRY: Record<string, WatcherFn> = {
  "test-suite": runTestSuiteWatcher,
};

/** Per-project abort controllers for an in-progress scan — lets the kill-switch
 *  (or a project-level autonomy PATCH) halt a mid-scan watcher immediately
 *  rather than waiting for it to finish on its own. */
const activeScanAborts = new Map<number, AbortController>();

export function abortWatcherScan(projectId: number): void {
  activeScanAborts.get(projectId)?.abort();
}

/** Aborts every in-progress scan across every project — the bulk shutdown
 *  path, called alongside `stopScheduler()`. */
export function stopWatcherLoop(): void {
  for (const ac of activeScanAborts.values()) ac.abort();
}

function watcherDueMetaKey(projectId: number, watcherName: string): string {
  return `autonomy:watcher:${projectId}:${watcherName}:lastRunAt`;
}

function watcherIsDue(projectId: number, wc: WatcherConfig): boolean {
  const raw = getMeta(watcherDueMetaKey(projectId, wc.name));
  if (!raw) return true;
  const last = new Date(raw).getTime();
  if (Number.isNaN(last)) return true;
  return Date.now() - last >= wc.cadenceMinutes * 60_000;
}

function markWatcherRan(projectId: number, wc: WatcherConfig): void {
  setMeta(watcherDueMetaKey(projectId, wc.name), new Date().toISOString());
}

/**
 * Called once per scheduler round (wired into `main.ts`'s own loop, parallel
 * to `startScheduler`). For every project: resolves autonomy config, checks
 * enabled + active-hours + idle-window budget, runs any due+enabled watcher,
 * and triages every candidate it produces. Returns true if any watcher scan
 * ran this round, so the caller's idle-sleep can treat it like other work.
 */
export async function tickWatchers(): Promise<boolean> {
  let didWork = false;
  for (const project of listProjects()) {
    const cfg = resolveAutonomyConfig(project.config_json);
    if (!cfg.enabled) continue;
    if (!isWithinActiveHours(cfg.activeHours, new Date())) continue;
    if (getOrResetIdleWindowBudget(project.id, cfg).exhausted) continue;

    for (const wc of cfg.watchers) {
      if (!wc.enabled) continue;
      const fn = WATCHER_REGISTRY[wc.name];
      if (!fn) continue;
      if (!watcherIsDue(project.id, wc)) continue;

      const controller = new AbortController();
      activeScanAborts.set(project.id, controller);
      didWork = true;
      try {
        markWatcherRan(project.id, wc);
        const found = await fn(project, wc, controller.signal);
        for (const cand of found) {
          const existing = findLatestCandidateByFingerprint(project.id, cand.watcher, cand.fingerprint);
          if (existing) continue; // already tracked in some state — nothing new to do
          const row = createCandidate({
            project_id: project.id,
            watcher: cand.watcher,
            kind: cand.kind,
            fingerprint: cand.fingerprint,
            payload_json: JSON.stringify(cand.payload),
          });
          await triageAndMaybeQueue(project, row, cfg);
        }
      } catch (err) {
        console.warn(`[watchers] "${wc.name}" scan failed for project ${project.id}: ${(err as Error).message}`);
      } finally {
        activeScanAborts.delete(project.id);
      }
    }
  }
  return didWork;
}
