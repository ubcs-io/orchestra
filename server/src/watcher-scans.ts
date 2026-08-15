/**
 * Watcher scan implementations (PLANNING/overhaul/08 §1) — the "what does this
 * watcher notice" half of the subsystem. The "what happens to what it noticed"
 * half (dedupe, flake-guard, triage, caps, the loop) lives in `watchers.ts`,
 * which imports FROM this module; this module never imports it back.
 *
 * The scan-worktree lifecycle lives here too, since every scan needs it and
 * putting it here is what keeps that import edge one-directional.
 *
 * **Deliberate deviation from doc §1**: the doc describes `todo-scan`/`lint-drift`
 * as shelling out "via the same jailed exec surface". Three of these five need
 * nothing but *reading* the repo, and `allowExec` ships off with an
 * operator-curated allowlist — so routing them through exec would leave them
 * inert on every fresh project, gated behind a policy that exists to authorize
 * *writes and arbitrary code execution* they don't perform. So:
 *
 *   - `todo-scan`, `branch-triage`, `doc-drift` read the scan worktree directly
 *     (`git ls-files`/`git blame`/`for-each-ref` + file reads). No exec policy;
 *     they work the moment autonomy is enabled.
 *   - `lint-drift`, `dep-staleness` genuinely need to run project-defined
 *     commands, so they stay on the jailed exec surface exactly like
 *     `test-suite`, and are inert until the operator configures those commands.
 *
 * Every scan function has the same contract as `runTestSuiteWatcher`: it never
 * throws. A missing tool, an unparseable output, an offline registry and a
 * broken worktree are all ordinary "nothing to report this round" outcomes.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  blameLineTimestamps,
  currentBranch,
  ensureWorktree,
  listLocalBranches,
  listTrackedFiles,
  ORCHESTRA_BRANCH_PREFIX,
  resetHardTo,
  resolveRef,
  SCAN_WORKSPACE_NAME,
  WORKTREES_DIR,
  type LocalBranchInfo,
} from "./git.js";
import { getMeta, setMeta, type ProjectRow } from "./db.js";
import { buildExecEnv, runExecCommand, type ExecEvidence } from "./exec.js";
import {
  DEFAULT_EXEC_MAX_OUTPUT_BYTES,
  DEFAULT_EXEC_TIMEOUT_MS,
  findExecCommand,
  resolveHarnessPolicy,
} from "./harness-policy.js";
import { recordAutonomousExecRun, type WatcherConfig } from "./autonomy.js";

/** One observation a watcher wants considered for the queue. Not a task — it
 *  still has to clear dedupe, triage and every cap in `watchers.ts`. */
export interface WatcherCandidate {
  watcher: string;
  kind: string;
  fingerprint: string;
  payload: Record<string, unknown>;
}

/** Context every scan receives. `scanDir` is a freshly-reset, read-only
 *  worktree of the project's default branch (never a task worktree). */
export interface ScanContext {
  project: ProjectRow;
  cfg: WatcherConfig;
  scanDir: string;
  signal?: AbortSignal;
}

export type WatcherScanFn = (ctx: ScanContext) => Promise<WatcherCandidate[]>;

// ---------------------------------------------------------------------------
// Scan worktree lifecycle
// ---------------------------------------------------------------------------

const SCAN_BRANCH = ORCHESTRA_BRANCH_PREFIX + SCAN_WORKSPACE_NAME;

function scanWorktreeDir(project: ProjectRow): string {
  return path.join(project.repo_path, WORKTREES_DIR, SCAN_WORKSPACE_NAME);
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

/** ensure + reset in one call, degrading to `null` (with a warning) instead of
 *  throwing — a project whose scan worktree can't be prepared simply produces
 *  no candidates this round. */
export function prepareScanWorktree(project: ProjectRow): string | null {
  try {
    const dir = ensureScanWorktree(project);
    resetScanWorktreeToBase(project, dir);
    return dir;
  } catch (err) {
    console.warn(
      `[watchers] scan worktree setup failed for project ${project.id}: ${(err as Error).message}`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Stable dedupe key from an already-canonical basis string. Every watcher
 *  builds its basis from *sorted, position-independent* identity (a TODO's
 *  text, not its line number) so cosmetic churn doesn't re-propose work. */
export function hashBasis(basis: string): string {
  return crypto.createHash("sha256").update(basis).digest("hex");
}

const MAX_FILE_BYTES = 512 * 1024;

/** Read a tracked file, skipping anything too large or binary-looking. Returns
 *  null rather than throwing for unreadable paths. */
function readTextFile(absPath: string): string | null {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    const buf = fs.readFileSync(absPath);
    // A NUL byte in the first block is the same cheap binary test `grep` uses.
    if (buf.subarray(0, 8000).includes(0)) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

const SOURCE_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|cs|swift|kt|scala|c|h|cc|cpp|hpp|sh|sql|css|scss|vue|svelte)$/i;
const DOC_EXT_RE = /\.(md|mdx|markdown|rst|txt)$/i;

function daysBetween(laterMs: number, earlierMs: number): number {
  return Math.floor((laterMs - earlierMs) / 86_400_000);
}

/** Per-watcher `thresholdDays`, falling back to the watcher's own default. */
function thresholdDays(cfg: WatcherConfig, fallback: number): number {
  return typeof cfg.thresholdDays === "number" && cfg.thresholdDays >= 0 ? cfg.thresholdDays : fallback;
}

// ---------------------------------------------------------------------------
// todo-scan (native)
// ---------------------------------------------------------------------------

export interface TodoMarker {
  file: string;
  line: number;
  tag: string;
  text: string;
  /** Epoch ms of the line's last authorship, or null when unblameable. */
  authoredAt: number | null;
}

const TODO_TAG_RE = /(?:^|[^A-Za-z])(TODO|FIXME|HACK|XXX)\b[:\s-]*(.*)$/;

/** Extract decay markers from one file's text. Pure — the age/blame side is
 *  layered on by the scan, so this is directly unit-testable. */
export function extractTodoMarkers(file: string, text: string): TodoMarker[] {
  const out: TodoMarker[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    // Only comment-ish lines: a bare `TODO` inside a string literal or a
    // markdown checklist isn't a code decay marker.
    if (!/(^|\s)(\/\/|#|\*|<!--|--)/.test(raw)) continue;
    const m = TODO_TAG_RE.exec(raw);
    if (!m) continue;
    const body = (m[2] ?? "").replace(/-->\s*$/, "").replace(/\*\/\s*$/, "").trim();
    out.push({ file, line: i + 1, tag: m[1]!, text: body, authoredAt: null });
  }
  return out;
}

const TODO_MAX_FILES_BLAMED = 200;
const TODO_MAX_REPORTED = 20;

/**
 * Decayed `TODO`/`FIXME`/`HACK`/`XXX` comments — the doc's age threshold exists
 * so fresh work-in-progress markers aren't churned into tasks the same week
 * someone wrote them. Age comes from `git blame` per line, so moving a file
 * doesn't reset its markers' age the way an mtime check would.
 */
export const runTodoScanWatcher: WatcherScanFn = async (ctx) => {
  const minAgeDays = thresholdDays(ctx.cfg, 30);
  const files = listTrackedFiles(ctx.scanDir).filter((f) => SOURCE_EXT_RE.test(f));

  const withMarkers: { file: string; markers: TodoMarker[] }[] = [];
  for (const file of files) {
    if (ctx.signal?.aborted) return [];
    const text = readTextFile(path.join(ctx.scanDir, file));
    if (!text || !/TODO|FIXME|HACK|XXX/.test(text)) continue;
    const markers = extractTodoMarkers(file, text);
    if (markers.length) withMarkers.push({ file, markers });
  }

  // Blame is the expensive part — one call per file that actually has markers,
  // hard-capped so a repo with thousands of them can't turn one scan into a
  // multi-minute git storm.
  const aged: TodoMarker[] = [];
  const now = Date.now();
  for (const { file, markers } of withMarkers.slice(0, TODO_MAX_FILES_BLAMED)) {
    if (ctx.signal?.aborted) return [];
    const times = blameLineTimestamps(ctx.scanDir, file);
    for (const marker of markers) {
      const epoch = times.get(marker.line);
      // Unknown age (unblameable line) is treated as NOT old enough — silence
      // over noise, consistent with triage's fail-toward-not-queuing bias.
      if (epoch === undefined) continue;
      const authoredAt = epoch * 1000;
      if (daysBetween(now, authoredAt) < minAgeDays) continue;
      aged.push({ ...marker, authoredAt });
    }
  }
  if (!aged.length) return [];

  aged.sort((a, b) => (a.authoredAt ?? 0) - (b.authoredAt ?? 0));
  const reported = aged.slice(0, TODO_MAX_REPORTED);

  // Fingerprint over file+text, never line numbers: editing unrelated code
  // above a TODO shifts its line but is not new work.
  const fingerprint = hashBasis(
    `todo:${reported.map((m) => `${m.file}|${m.tag}|${m.text}`).sort().join("\n")}`,
  );

  const rows = reported
    .map((m) => {
      const age = m.authoredAt ? daysBetween(now, m.authoredAt) : 0;
      return `- \`${m.file}:${m.line}\` — **${m.tag}** (${age}d old) ${m.text || "_(no description)_"}`;
    })
    .join("\n");

  return [
    {
      watcher: "todo-scan",
      kind: "chore",
      fingerprint,
      payload: {
        markerCount: aged.length,
        minAgeDays,
        outputTail: `${aged.length} TODO/FIXME markers older than ${minAgeDays} days:\n${rows}`,
        renderedContent:
          `# Decayed TODO markers (${aged.length} older than ${minAgeDays} days)\n\n` +
          `These comments have sat unaddressed in the default branch for over ${minAgeDays} days.\n` +
          `Assess whether each is still relevant: resolve it, convert it into a real task, or delete it.\n\n` +
          `${rows}\n` +
          (aged.length > reported.length ? `\n_…and ${aged.length - reported.length} more._\n` : ""),
      },
    },
  ];
};

// ---------------------------------------------------------------------------
// branch-triage (native)
// ---------------------------------------------------------------------------

export interface StaleBranch extends LocalBranchInfo {
  ageDays: number;
}

/** Branches with unmerged commits whose tip has gone quiet for `minAgeDays`.
 *  Pure over `listLocalBranches` output so the selection rule is testable
 *  without a repo. A branch with `ahead === 0` holds nothing unmerged — there
 *  is nothing to ask a human about. */
export function selectStaleBranches(
  branches: LocalBranchInfo[],
  nowMs: number,
  minAgeDays: number,
): StaleBranch[] {
  const out: StaleBranch[] = [];
  for (const b of branches) {
    if (b.ahead <= 0) continue;
    const tipMs = Date.parse(b.lastCommitAt);
    if (!Number.isFinite(tipMs)) continue;
    const ageDays = daysBetween(nowMs, tipMs);
    if (ageDays < minAgeDays) continue;
    out.push({ ...b, ageDays });
  }
  return out.sort((a, b) => b.ageDays - a.ageDays);
}

/**
 * Un-triaged local branches — the one watcher whose output is a *question for
 * the human* rather than proposed work, per doc §1. It reads branch refs from
 * the project repo itself (branch refs are repo-wide, not worktree-local) and
 * never checks out, moves or deletes anything.
 */
export const runBranchTriageWatcher: WatcherScanFn = async (ctx) => {
  const minAgeDays = thresholdDays(ctx.cfg, 30);
  const baseBranch = ctx.project.main_branch || currentBranch(ctx.project.repo_path);
  const stale = selectStaleBranches(
    listLocalBranches(ctx.project.repo_path, baseBranch),
    Date.now(),
    minAgeDays,
  );
  if (!stale.length) return [];

  // Tip shas, so a branch that gains a commit is genuinely a new question and
  // one that merely ages further is not re-proposed.
  const fingerprint = hashBasis(
    `branches:${stale.map((b) => `${b.name}@${b.tipSha}`).sort().join("|")}`,
  );

  const rows = stale
    .map(
      (b) =>
        `- \`${b.name}\` — ${b.ahead} ahead / ${b.behind} behind \`${baseBranch}\`, last commit ${b.ageDays}d ago ("${b.subject}")`,
    )
    .join("\n");

  return [
    {
      watcher: "branch-triage",
      kind: "question",
      fingerprint,
      payload: {
        branchCount: stale.length,
        baseBranch,
        outputTail: `${stale.length} stale local branches with unmerged commits:\n${rows}`,
        renderedContent:
          `# Stale local branches (${stale.length})\n\n` +
          `These local branches carry commits that never reached \`${baseBranch}\` and have been quiet for ` +
          `over ${minAgeDays} days.\n\n${rows}\n\n` +
          `## Question for the human\n\n` +
          `For each branch: what was it for, and should it be rebased and finished, merged as-is, or abandoned?\n` +
          `Do not delete or modify any branch — this task is for producing the answer, not acting on it.\n`,
      },
    },
  ];
};

// ---------------------------------------------------------------------------
// doc-drift (native)
// ---------------------------------------------------------------------------

/** Identifiers a doc mentions in backticks that look like code symbols.
 *  camelCase / PascalCase / snake_case only, ≥4 chars — a plain English word in
 *  backticks (`test`, `build`) is not a symbol claim worth checking. */
export function extractDocSymbolRefs(markdown: string): string[] {
  // Fenced code blocks are examples, not claims about the current API surface.
  const withoutFences = markdown.replace(/```[\s\S]*?```/g, " ");
  const out = new Set<string>();
  const spanRe = /`([^`\n]{1,80})`/g;
  let m: RegExpExecArray | null;
  while ((m = spanRe.exec(withoutFences))) {
    const raw = (m[1] ?? "").trim().replace(/\(\)$/, "");
    if (!/^[A-Za-z_$][\w$]*$/.test(raw)) continue;
    if (raw.length < 4) continue;
    const looksLikeSymbol = /[a-z][A-Z]/.test(raw) || /^[A-Z][a-z]/.test(raw) || raw.includes("_");
    if (!looksLikeSymbol) continue;
    out.add(raw);
  }
  return [...out];
}

/** Every identifier token appearing anywhere in a source file. Used as a
 *  presence set: a doc symbol absent from ALL source is a broken reference,
 *  which is a far more precise drift signal than "exported but undocumented"
 *  (which fires on every internal helper in a healthy repo). */
export function collectSourceTokens(text: string, into: Set<string>): void {
  const re = /[A-Za-z_$][\w$]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) into.add(m[0]);
}

const DOC_MAX_REPORTED = 20;

/**
 * Documentation referring to symbols that no longer exist — the cheap heuristic
 * version doc §1 asks for, aimed at the precise half of "exported symbols vs
 * docs mentions". The inverse direction (exported but undocumented) is
 * deliberately not reported: it fires on every internal helper and would be
 * pure noise.
 */
export const runDocDriftWatcher: WatcherScanFn = async (ctx) => {
  const tracked = listTrackedFiles(ctx.scanDir);
  const docs = tracked.filter((f) => DOC_EXT_RE.test(f));
  const sources = tracked.filter((f) => SOURCE_EXT_RE.test(f));
  if (!docs.length || !sources.length) return [];

  const tokens = new Set<string>();
  for (const file of sources) {
    if (ctx.signal?.aborted) return [];
    const text = readTextFile(path.join(ctx.scanDir, file));
    if (text) collectSourceTokens(text, tokens);
  }

  const missing: { doc: string; symbol: string }[] = [];
  for (const doc of docs) {
    if (ctx.signal?.aborted) return [];
    const text = readTextFile(path.join(ctx.scanDir, doc));
    if (!text) continue;
    for (const symbol of extractDocSymbolRefs(text)) {
      if (!tokens.has(symbol)) missing.push({ doc, symbol });
    }
  }
  if (!missing.length) return [];

  const reported = missing.slice(0, DOC_MAX_REPORTED);
  const fingerprint = hashBasis(
    `docdrift:${reported.map((r) => `${r.doc}|${r.symbol}`).sort().join("\n")}`,
  );
  const rows = reported.map((r) => `- \`${r.doc}\` references \`${r.symbol}\`, which no longer exists in the source`).join("\n");

  return [
    {
      watcher: "doc-drift",
      kind: "chore",
      fingerprint,
      payload: {
        missingCount: missing.length,
        outputTail: `${missing.length} documented symbols no longer exist in the source:\n${rows}`,
        renderedContent:
          `# Documentation drift (${missing.length} stale symbol references)\n\n` +
          `These docs name code symbols that appear nowhere in the tracked source — typically a rename or\n` +
          `removal that never reached the documentation.\n\n${rows}\n\n` +
          `For each: find what the symbol was renamed to (or confirm it was removed) and update the doc.\n` +
          (missing.length > reported.length ? `\n_…and ${missing.length - reported.length} more._\n` : ""),
      },
    },
  ];
};

// ---------------------------------------------------------------------------
// Exec-backed scan helper (shared by lint-drift and dep-staleness)
// ---------------------------------------------------------------------------

/** Network failures a command hitting a package registry can legitimately hit
 *  on a laptop that's offline or off its tailnet. Doc §1 requires
 *  dep-staleness be "offline-tolerant; skip when no network". */
const OFFLINE_MARKERS = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|network|getaddrinfo|registry\.npmjs\.org.*(?:failed|error)/i;

export function looksOffline(evidence: ExecEvidence): boolean {
  if (evidence.spawnError) return true;
  return OFFLINE_MARKERS.test(evidence.outputTail);
}

/** Run one allowlisted command in the scan worktree, or return null when the
 *  project hasn't configured a command under that name (which is the normal
 *  state — these watchers are inert until an operator opts in). */
async function runScanCommand(ctx: ScanContext, name: string): Promise<ExecEvidence | null> {
  const policy = resolveHarnessPolicy(ctx.project.config_json);
  const command = findExecCommand(policy, name);
  if (!command) return null;
  const evidence = await runExecCommand({
    name: command.name,
    argv: command.argv,
    cwd: ctx.scanDir,
    timeoutMs: command.timeoutMs ?? policy.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
    maxOutputBytes: policy.execMaxOutputBytes ?? DEFAULT_EXEC_MAX_OUTPUT_BYTES,
    env: buildExecEnv(policy),
    signal: ctx.signal,
  });
  recordAutonomousExecRun(ctx.project.id);
  return evidence;
}

// ---------------------------------------------------------------------------
// lint-drift (exec)
// ---------------------------------------------------------------------------

export interface LintObservation {
  count: number;
  files: string[];
}

const FILE_REF_RE = /([\w./@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|css|scss|vue|svelte|json|md))(?::\d+)?/g;

/**
 * Problem count + offending files from a linter's output. Recognises eslint's
 * summary line first (`✖ 12 problems (3 errors, 9 warnings)`), then a generic
 * `file:line:col` diagnostic count, and finally falls back to non-empty output
 * lines. Pure — the parsing heuristic is the part worth unit-testing.
 */
export function parseLintOutput(output: string): LintObservation {
  const files = new Set<string>();
  let m: RegExpExecArray | null;
  FILE_REF_RE.lastIndex = 0;
  while ((m = FILE_REF_RE.exec(output))) files.add(m[1]!);

  const summary = /(\d+)\s+problems?\b/i.exec(output);
  if (summary) return { count: Number(summary[1]), files: [...files] };

  const diagnostics = output.split("\n").filter((l) => /^\s*\S+:\d+:\d+/.test(l)).length;
  if (diagnostics > 0) return { count: diagnostics, files: [...files] };

  const nonEmpty = output.split("\n").filter((l) => l.trim().length > 0).length;
  return { count: nonEmpty, files: [...files] };
}

function lintBaselineKey(projectId: number, command: string): string {
  return `autonomy:lint-drift:${projectId}:${command}:count`;
}

/**
 * Lint/format problems, proposed **only when the count grows** against the last
 * observation (doc §1) — a repo with a stable backlog of 40 warnings is not a
 * finding, a repo that went from 40 to 55 is. The first scan silently
 * establishes the baseline rather than proposing the entire pre-existing
 * backlog as one task.
 */
export const runLintDriftWatcher: WatcherScanFn = async (ctx) => {
  const names = ctx.cfg.commands?.length ? ctx.cfg.commands : ["lint"];
  const candidates: WatcherCandidate[] = [];

  for (const name of names) {
    const evidence = await runScanCommand(ctx, name);
    if (!evidence || evidence.spawnError || evidence.timedOut) continue;

    const observation = parseLintOutput(evidence.outputTail);
    const key = lintBaselineKey(ctx.project.id, name);
    const rawPrevious = getMeta(key);
    setMeta(key, String(observation.count));

    if (rawPrevious === undefined || rawPrevious === "") continue; // first sighting = baseline only
    const previous = Number(rawPrevious);
    if (!Number.isFinite(previous) || observation.count <= previous) continue;

    // Fingerprint over the offending file set: the identity of the drift is
    // *where* it appeared, so re-running with the same files pending doesn't
    // re-propose, while drift spreading to a new file does.
    const fingerprint = hashBasis(`lint:${name}:${observation.files.sort().join("|")}`);
    const grew = observation.count - previous;
    candidates.push({
      watcher: "lint-drift",
      kind: "chore",
      fingerprint,
      payload: {
        command: name,
        count: observation.count,
        previousCount: previous,
        outputTail:
          `lint problems grew from ${previous} to ${observation.count} (+${grew}) across ` +
          `${observation.files.length} files:\n${evidence.outputTail.slice(-3000)}`,
        renderedContent:
          `# Lint drift: ${previous} → ${observation.count} problems (+${grew})\n\n` +
          `Command: \`${evidence.argv.join(" ")}\` (exit ${evidence.exitCode ?? "killed"})\n\n` +
          `Affected files:\n${observation.files.map((f) => `- \`${f}\``).join("\n") || "_(none identified)_"}\n\n` +
          `\`\`\`\n${evidence.outputTail.slice(-6000)}\n\`\`\`\n`,
      },
    });
  }
  return candidates;
};

// ---------------------------------------------------------------------------
// dep-staleness (exec, off by default)
// ---------------------------------------------------------------------------

export interface OutdatedDep {
  name: string;
  current: string;
  latest: string;
}

/** Parse `npm outdated --json`. Shape: `{ pkg: { current, wanted, latest } }`.
 *  Entries already at latest, and workspace-local links with no version, are
 *  dropped. Returns [] for anything unparseable — a different package manager's
 *  output is "nothing to report", never a crash. */
export function parseNpmOutdated(json: string): OutdatedDep[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const out: OutdatedDep[] = [];
  for (const [name, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as { current?: unknown; latest?: unknown };
    const current = typeof e.current === "string" ? e.current : "";
    const latest = typeof e.latest === "string" ? e.latest : "";
    if (!latest || current === latest) continue;
    out.push({ name, current: current || "(none)", latest });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface DepAdvisory {
  name: string;
  severity: string;
  title: string;
}

const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, moderate: 2, low: 1, info: 0 };

/** Parse `npm audit --json`, supporting both the current `vulnerabilities` map
 *  and npm 6's `advisories` map. Only `high`/`critical` are reported — the
 *  point is a security *task*, and a moderate transitive advisory does not
 *  warrant waking the queue. */
export function parseNpmAudit(json: string): DepAdvisory[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const out: DepAdvisory[] = [];

  const vulns = (parsed as { vulnerabilities?: unknown }).vulnerabilities;
  if (vulns && typeof vulns === "object" && !Array.isArray(vulns)) {
    for (const [name, raw] of Object.entries(vulns as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const v = raw as { severity?: unknown; via?: unknown };
      const severity = typeof v.severity === "string" ? v.severity : "";
      if ((SEVERITY_RANK[severity] ?? 0) < 3) continue;
      const via = Array.isArray(v.via) ? v.via : [];
      const titled = via.find((x) => x && typeof x === "object" && typeof (x as { title?: unknown }).title === "string");
      out.push({
        name,
        severity,
        title: titled ? String((titled as { title: string }).title) : "(no advisory title)",
      });
    }
  }

  const advisories = (parsed as { advisories?: unknown }).advisories;
  if (advisories && typeof advisories === "object" && !Array.isArray(advisories)) {
    for (const raw of Object.values(advisories as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const a = raw as { module_name?: unknown; severity?: unknown; title?: unknown };
      const severity = typeof a.severity === "string" ? a.severity : "";
      if ((SEVERITY_RANK[severity] ?? 0) < 3) continue;
      out.push({
        name: typeof a.module_name === "string" ? a.module_name : "(unknown)",
        severity,
        title: typeof a.title === "string" ? a.title : "(no advisory title)",
      });
    }
  }
  return out.sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0));
}

const DEP_MAX_REPORTED = 25;

/**
 * Dependency staleness and security advisories. The only watcher that makes the
 * daemon reach outside the operator's own network, so it ships `enabled: false`
 * and stays inert until both autonomy *and* the `outdated`/`audit` allowlist
 * commands are configured — the same explicit-opt-in posture as `allowExec`.
 *
 * Offline-tolerant per doc §1: a registry that can't be reached produces no
 * candidate at all rather than a task claiming every dependency is broken.
 * Advisories become `security`-kind intake, which routes through the security
 * flow's high rigor automatically.
 */
export const runDepStalenessWatcher: WatcherScanFn = async (ctx) => {
  const [outdatedName, auditName] = ctx.cfg.commands?.length
    ? [ctx.cfg.commands[0]!, ctx.cfg.commands[1]]
    : ["outdated", "audit"];
  const candidates: WatcherCandidate[] = [];

  const outdatedEvidence = await runScanCommand(ctx, outdatedName);
  // `npm outdated` exits 1 when anything IS outdated — a non-zero exit is the
  // normal success case here, so only genuine offline/timeout cases are skipped.
  if (outdatedEvidence && !outdatedEvidence.timedOut && !looksOffline(outdatedEvidence)) {
    const deps = parseNpmOutdated(outdatedEvidence.outputTail).slice(0, DEP_MAX_REPORTED);
    if (deps.length) {
      const rows = deps.map((d) => `- \`${d.name}\`: ${d.current} → **${d.latest}**`).join("\n");
      candidates.push({
        watcher: "dep-staleness",
        kind: "chore",
        fingerprint: hashBasis(`deps:${deps.map((d) => `${d.name}@${d.latest}`).sort().join("|")}`),
        payload: {
          depCount: deps.length,
          outputTail: `${deps.length} dependencies behind their latest release:\n${rows}`,
          renderedContent:
            `# ${deps.length} outdated dependencies\n\n${rows}\n\n` +
            `Assess which of these are worth upgrading now: check for breaking changes in each major bump,\n` +
            `and prefer grouping low-risk patch/minor updates into one change.\n`,
        },
      });
    }
  }

  if (auditName) {
    const auditEvidence = await runScanCommand(ctx, auditName);
    if (auditEvidence && !auditEvidence.timedOut && !looksOffline(auditEvidence)) {
      const advisories = parseNpmAudit(auditEvidence.outputTail).slice(0, DEP_MAX_REPORTED);
      if (advisories.length) {
        const rows = advisories
          .map((a) => `- **${a.severity}** \`${a.name}\` — ${a.title}`)
          .join("\n");
        candidates.push({
          watcher: "dep-staleness",
          kind: "security",
          fingerprint: hashBasis(
            `advisories:${advisories.map((a) => `${a.name}|${a.severity}|${a.title}`).sort().join("|")}`,
          ),
          payload: {
            advisoryCount: advisories.length,
            outputTail: `${advisories.length} high/critical dependency advisories:\n${rows}`,
            renderedContent:
              `# ${advisories.length} high/critical dependency advisories\n\n${rows}\n\n` +
              `Determine the upgrade path that clears each advisory, and whether this project's usage is\n` +
              `actually reachable by the vulnerability before treating it as urgent.\n`,
          },
        });
      }
    }
  }

  return candidates;
};
