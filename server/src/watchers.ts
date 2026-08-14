/**
 * Watchers (PLANNING/overhaul/08 §1/§2): read-only scanners that turn repo
 * state into self-generated intake. This module is the *orchestration* half —
 * the registry, the per-round loop, fingerprint dedupe, the flake guard, triage
 * and every cap. The scans themselves live in `watcher-scans.ts`, which this
 * file imports (and never the other way round).
 *
 * All six watchers run against a dedicated, read-only scan worktree of the
 * default branch, prepared once per project per round here — never a task
 * worktree, and never twice in one round by two different watchers.
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
 * this module owns its own start/stop loop (`startWatcherLoop`/`stopWatcherLoop`),
 * parallel to `orchestrator.ts`'s `startScheduler`/`stopScheduler`, and `main.ts`
 * / `routes/api.ts` start and stop both loops together. This keeps the import
 * graph one-directional while still giving the two loops one shared on/off switch.
 */

import crypto from "node:crypto";
import { getConfig } from "./config.js";
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
import {
  ensureScanWorktree,
  prepareScanWorktree,
  resetScanWorktreeToBase,
  runBranchTriageWatcher,
  runDepStalenessWatcher,
  runDocDriftWatcher,
  runLintDriftWatcher,
  runTodoScanWatcher,
  type ScanContext,
  type WatcherCandidate,
  type WatcherScanFn,
} from "./watcher-scans.js";
import { runSelfMaintenance } from "./self-maintenance.js";

// The scan-worktree lifecycle moved to watcher-scans.ts (so the scans can own
// it without importing this module back); re-exported here because it is part
// of this subsystem's public surface.
export { ensureScanWorktree, resetScanWorktreeToBase, type WatcherCandidate };

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

/**
 * Runs the project's configured exec-allowlist commands (default
 * `["test","typecheck"]`, or the watcher's own `commands` override) against the
 * freshly-reset scan worktree the loop prepared. Never throws — a red suite and
 * a missing command are both ordinary, recordable-or-skippable outcomes,
 * matching `runExecCommand`'s own contract.
 */
export const runTestSuiteWatcher: WatcherScanFn = async ({ project, cfg: watcherCfg, scanDir, signal }) => {
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
};

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

/** Every watcher the scheduler knows how to run. A config entry naming
 *  something absent from here is ignored (not an error) — a config written
 *  against a newer build must never crash an older one. */
const WATCHER_REGISTRY: Record<string, WatcherScanFn> = {
  "test-suite": runTestSuiteWatcher,
  "todo-scan": runTodoScanWatcher,
  "branch-triage": runBranchTriageWatcher,
  "doc-drift": runDocDriftWatcher,
  "lint-drift": runLintDriftWatcher,
  "dep-staleness": runDepStalenessWatcher,
};

export interface WatcherDescriptor {
  name: string;
  /** One line, shown in the watcher editor. */
  description: string;
  /** True when the watcher is inert until exec commands are configured. */
  requiresExec: boolean;
  /** True when the watcher honours `thresholdDays`. */
  usesThresholdDays: boolean;
}

/** The registry, described for the UI — so the watcher editor lists what this
 *  build can actually run instead of hardcoding a parallel list that drifts. */
export const WATCHER_CATALOG: WatcherDescriptor[] = [
  {
    name: "test-suite",
    description: "Runs the project's test/typecheck commands against a clean scan worktree; proposes a fix task when the same failure appears twice.",
    requiresExec: true,
    usesThresholdDays: false,
  },
  {
    name: "todo-scan",
    description: "Finds TODO/FIXME/HACK/XXX comments older than the age threshold (by git blame), so decayed markers get resolved or deleted.",
    requiresExec: false,
    usesThresholdDays: true,
  },
  {
    name: "branch-triage",
    description: "Asks about local branches with unmerged commits that have gone quiet — produces a question for the human, never deletes anything.",
    requiresExec: false,
    usesThresholdDays: true,
  },
  {
    name: "doc-drift",
    description: "Flags documentation referring to code symbols that no longer exist anywhere in the source.",
    requiresExec: false,
    usesThresholdDays: false,
  },
  {
    name: "lint-drift",
    description: "Runs the lint command and proposes cleanup only when the problem count grows against the previous observation.",
    requiresExec: true,
    usesThresholdDays: false,
  },
  {
    name: "dep-staleness",
    description: "Outdated dependencies and high/critical advisories. The only watcher that reaches the package registry — offline-tolerant, and off until you enable it.",
    requiresExec: true,
    usesThresholdDays: false,
  },
];

/** Per-project abort controllers for an in-progress scan — lets the kill-switch
 *  (or a project-level autonomy PATCH) halt a mid-scan watcher immediately
 *  rather than waiting for it to finish on its own. */
const activeScanAborts = new Map<number, AbortController>();

export function abortWatcherScan(projectId: number): void {
  activeScanAborts.get(projectId)?.abort();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let loopStopped = true;
let loopHandle: Promise<void> | undefined;

/** Start the watcher heartbeat — a second, independent loop from the main
 *  task scheduler (see module comment), but with the identical start/stop
 *  lifecycle so it can be driven by the exact same UI control. Idempotent. */
export function startWatcherLoop(): void {
  if (!loopStopped) return;
  loopStopped = false;
  loopHandle = (async () => {
    while (!loopStopped) {
      try {
        await tickWatchers();
      } catch (err) {
        console.error(`[watchers] tick error: ${(err as Error).message}`);
      }
      await sleep(getConfig().schedulerIdleMs);
    }
  })();
}

/** Signal the watcher loop to stop and abort every in-progress scan — the
 *  same "stop everything now" contract as `stopScheduler()`. Must be wired
 *  to every place that stops the main scheduler (the UI's "Stop loop" button
 *  and process shutdown alike); a watcher loop left running after the user
 *  stops the primary loop can still fire LLM calls and queue new tasks
 *  invisibly, which is exactly the trust violation this pairing prevents. */
export function stopWatcherLoop(): void {
  loopStopped = true;
  for (const ac of activeScanAborts.values()) ac.abort();
}

/** Resolves once the loop has actually exited its current iteration — used
 *  by process shutdown to wait for a graceful stop before closing the DB. */
export function watcherLoopIdle(): Promise<void> {
  return loopHandle ?? Promise.resolve();
}

export function isWatcherLoopRunning(): boolean {
  return !loopStopped;
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
 * Called once per round of this module's own loop (`startWatcherLoop`),
 * parallel to `startScheduler`'s. For every project: resolves autonomy
 * config, checks enabled + active-hours + idle-window budget, runs any
 * due+enabled watcher, triages every candidate it produces, and finally runs
 * idle-time self-maintenance (§5). Returns true if any scan ran this round, so
 * the caller's idle-sleep can treat it like other work.
 *
 * The scan worktree is prepared at most **once per project per round**, lazily
 * on the first due watcher — six watchers must not each `git reset --hard` the
 * same directory, still less reset it out from under one another.
 */
export async function tickWatchers(): Promise<boolean> {
  let didWork = false;
  for (const project of listProjects()) {
    const cfg = resolveAutonomyConfig(project.config_json);
    if (!cfg.enabled) continue;
    if (!isWithinActiveHours(cfg.activeHours, new Date())) continue;
    if (getOrResetIdleWindowBudget(project.id, cfg).exhausted) continue;

    let scanDir: string | null | undefined; // undefined = not yet attempted
    for (const wc of cfg.watchers) {
      if (!wc.enabled) continue;
      const fn = WATCHER_REGISTRY[wc.name];
      if (!fn) continue;
      if (!watcherIsDue(project.id, wc)) continue;

      if (scanDir === undefined) scanDir = prepareScanWorktree(project);
      if (scanDir === null) break; // worktree unavailable — no scan can run this round

      const controller = new AbortController();
      activeScanAborts.set(project.id, controller);
      didWork = true;
      try {
        markWatcherRan(project.id, wc);
        const ctx: ScanContext = { project, cfg: wc, scanDir, signal: controller.signal };
        const found = await fn(ctx);
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

    // §5: the system's own upkeep runs in the same idle window, under the same
    // budgets, after the watchers — repo work first, housekeeping with what's
    // left.
    if (await runSelfMaintenance(project, cfg)) didWork = true;
  }
  return didWork;
}
