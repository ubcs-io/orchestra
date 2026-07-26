/**
 * Git + filesystem helpers for the per-project `/PLANNING` tree.
 *
 * The DB is authoritative for state; these helpers mirror artifacts onto disk
 * (and commit them) so the refinement history is version-controlled and PR-able.
 * All writes are sandboxed to `<repo>/<planningDir>`.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const STAGE_DIRS = ["INTAKE", "REFINING", "READY", "REVIEW", "epics"] as const;

/**
 * Rewrite absolute paths under the current user's home directory to use "~/" for
 * brevity and privacy in API responses and UI. The original path is never
 * modified in the database; this is a display-only transformation.
 */
export function sanitizePath(absPath: string): string {
  const home = os.homedir();
  if (absPath.startsWith(home + path.sep)) {
    return "~" + absPath.slice(home.length);
  }
  return absPath;
}
export type StageDir = (typeof STAGE_DIRS)[number];

/**
 * Run a git command. Uses `execSync` (shell) instead of `execFileSync` so
 * PATH resolution works correctly regardless of the Node process's execution
 * context (e.g. macOS IDE-launched processes with sanitized environments).
 */
function git(repoPath: string, args: string[]): string {
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const cmd = `cd ${q(repoPath)} && git ${args.map(q).join(" ")}`;
  return execSync(cmd, { encoding: "utf8" }).trim();
}

export interface GitRepoResult {
  canonicalRoot: string;
}

/**
 * Check whether `repoPath` is inside a git work tree and return the canonical
 * repository root (from `git rev-parse --show-toplevel`).  Works from any path
 * within the repo — the root, a subdirectory, a tracked file, or even inside
 * `.git` itself.
 *
 * Throws with a message that names the specific failure — the path does not
 * exist, git is not on PATH, or the path is not tracked by git — rather than
 * collapsing every case into a raw `git rev-parse` error, so callers can tell
 * a typo apart from a missing git binary.
 */
export function isGitRepo(repoPath: string): GitRepoResult {
  // Confirm the path exists before shelling out; otherwise git's own error
  // ("cd: no such file or directory") masks a simple typo or bad path.
  let stat: fs.Stats;
  try {
    stat = fs.statSync(repoPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(
        `permission denied reading "${repoPath}" (${code}) — the server process cannot access this path`,
      );
    }
    // ENOENT (and anything else): the server can't see this path. Include the
    // errno so a container/remote/wrong-user mismatch is diagnosable rather
    // than looking like a plain typo.
    throw new Error(
      `path not found by the server: "${repoPath}" (${code ?? "unknown error"}) — ` +
        `supply an absolute path to the repository root as the SERVER sees it. ` +
        `If the server runs in a container, over SSH, or on a different host/user than the repo, that path may not exist there.`,
    );
  }
  // Accept a file (e.g. a path into .git/) by starting from its directory.
  const start = stat.isDirectory() ? repoPath : path.dirname(repoPath);

  let lastErr: unknown;
  // Strategy 1: --show-toplevel (works from root or any subdirectory).
  try {
    return { canonicalRoot: git(start, ["rev-parse", "--show-toplevel"]) };
  } catch (err) {
    lastErr = err;
  }
  // Strategy 2: --show-toplevel fails when CWD is .git/ itself.
  // Resolve the work tree by going up from the git dir.
  try {
    const gitDir = git(start, ["rev-parse", "--git-dir"]);
    const resolvedGitDir = path.resolve(start, gitDir);
    const workTree = path.dirname(resolvedGitDir);
    return { canonicalRoot: git(workTree, ["rev-parse", "--show-toplevel"]) };
  } catch (err) {
    lastErr = err;
  }

  // Both strategies failed. Distinguish "git binary missing" (common when the
  // server is launched from an IDE with a sanitized PATH) from "valid path,
  // just not a git repo".
  const detail = (lastErr as Error).message ?? "";
  if (/(?:git:?\s*)?command not found|\bENOENT\b/i.test(detail) && !/not a git repository/i.test(detail)) {
    throw new Error(
      `git executable not found on PATH — install git or make it available to the server process`,
    );
  }
  throw new Error(
    `not a git repository: "${repoPath}" — point at a folder tracked by git (the repo root, a subdirectory, or its .git directory)`,
  );
}

export function planningRoot(repoPath: string, planningDir = "PLANNING"): string {
  return path.join(repoPath, planningDir);
}

/** Create the PLANNING/{INTAKE,REFINING,READY,REVIEW,epics} scaffold if missing. */
export function scaffoldPlanning(repoPath: string, planningDir = "PLANNING"): void {
  const root = planningRoot(repoPath, planningDir);
  for (const dir of STAGE_DIRS) {
    const full = path.join(root, dir);
    fs.mkdirSync(full, { recursive: true });
    const keep = path.join(full, ".gitkeep");
    if (!fs.existsSync(keep)) fs.writeFileSync(keep, "");
  }
}

/**
 * Resolve a path under the planning tree, throwing if it would escape the
 * sandbox. This backs the `write_artifact` tool's path guard.
 */
export function resolveInPlanning(
  repoPath: string,
  planningDir: string,
  ...segments: string[]
): string {
  const root = planningRoot(repoPath, planningDir);
  const resolved = path.resolve(root, ...segments);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes planning sandbox: ${segments.join("/")}`);
  }
  return resolved;
}

export interface IntakeFile {
  absPath: string;
  fileName: string;
  ext: string;
  content: string;
}

/** List candidate files sitting in PLANNING/INTAKE (non-recursive, skips dotfiles). */
export function scanIntake(repoPath: string, planningDir = "PLANNING"): IntakeFile[] {
  const dir = path.join(planningRoot(repoPath, planningDir), "INTAKE");
  if (!fs.existsSync(dir)) return [];
  const out: IntakeFile[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const abs = path.join(dir, name);
    if (!fs.statSync(abs).isFile()) continue;
    out.push({
      absPath: abs,
      fileName: name,
      ext: path.extname(name).toLowerCase(),
      content: fs.readFileSync(abs, "utf8"),
    });
  }
  return out;
}

export function writeArtifact(absPath: string, content: string): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
}

export function readArtifact(absPath: string): string {
  return fs.existsSync(absPath) ? fs.readFileSync(absPath, "utf8") : "";
}

export function appendArtifactSection(absPath: string, md: string): void {
  const existing = readArtifact(absPath);
  const sep = existing && !existing.endsWith("\n\n") ? "\n\n" : "";
  writeArtifact(absPath, existing + sep + md.trimEnd() + "\n");
}

/** Move an artifact between stage folders, returning the new absolute path. */
export function moveArtifact(fromAbs: string, toAbs: string): string {
  if (!fs.existsSync(fromAbs)) return toAbs;
  fs.mkdirSync(path.dirname(toAbs), { recursive: true });
  fs.renameSync(fromAbs, toAbs);
  return toAbs;
}

/** Remove a file (used to clear the ingested INTAKE original). */
export function removeFile(absPath: string): void {
  if (fs.existsSync(absPath)) fs.rmSync(absPath);
}

/**
 * Stage the given paths and commit. Best-effort: a failure (nothing to commit,
 * missing git identity, detached state) is logged, never thrown, so a commit
 * problem cannot stall the refinement loop.
 */
export function commitArtifacts(repoPath: string, relPaths: string[], message: string): boolean {
  try {
    git(repoPath, ["add", "--", ...relPaths]);
    // Nothing staged → skip commit quietly.
    const staged = git(repoPath, ["diff", "--cached", "--name-only"]);
    if (!staged) return false;
    git(repoPath, [
      "-c",
      "user.name=Orchestra",
      "-c",
      "user.email=orchestra@localhost",
      "commit",
      "-m",
      message,
    ]);
    return true;
  } catch (err) {
    console.warn(`[git] commit skipped for ${repoPath}: ${(err as Error).message}`);
    return false;
  }
}

/** Convenience: build the `refine(<role>): <task> — <purpose>` commit subject. */
export function refineCommitMessage(role: string, taskName: string, purpose: string): string {
  const trimmed = purpose.replace(/\s+/g, " ").trim().slice(0, 100);
  return `refine(${role}): ${taskName}${trimmed ? ` — ${trimmed}` : ""}`;
}

// ---------------------------------------------------------------------------
// Checkpointing: per-task branches + restore
// ---------------------------------------------------------------------------

/** The branch currently checked out in `repoPath`. */
export function currentBranch(repoPath: string): string {
  return git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

/** The commit SHA currently at HEAD in `repoPath`. */
export function headSha(repoPath: string): string {
  return git(repoPath, ["rev-parse", "HEAD"]);
}

/** Resolve any ref (branch, tag, sha) to a full commit SHA, without touching
 *  what's checked out at `repoPath`. Used by the scan-worktree reset
 *  (PLANNING/overhaul/08) to find the default branch's current tip from a
 *  worktree sitting on its own dedicated branch. */
export function resolveRef(repoPath: string, ref: string): string {
  return git(repoPath, ["rev-parse", ref]);
}

function branchExists(repoPath: string, branch: string): boolean {
  try {
    git(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checkout `branch` in `repoPath`. Relies on git's own refusal to switch
 * branches over conflicting uncommitted changes — this throws in that case
 * rather than forcing past it, so callers must surface the error instead of
 * swallowing it (unlike the best-effort `commitArtifacts`).
 */
export function checkoutBranch(repoPath: string, branch: string): void {
  git(repoPath, ["checkout", branch]);
}

/**
 * Whether `repoPath` has uncommitted changes to *tracked* files (staged or
 * unstaged). Untracked files (`??` in porcelain output — build artifacts,
 * Orchestra's own not-yet-added `.gitkeep` scaffolding, etc.) are deliberately
 * excluded: `git reset --hard` never touches them, so they pose no risk of
 * being silently discarded and would otherwise make this check misfire
 * constantly in a real project directory.
 */
export function hasUncommittedChanges(repoPath: string): boolean {
  return git(repoPath, ["status", "--porcelain"])
    .split("\n")
    .some((line) => line.length > 0 && !line.startsWith("??"));
}

/**
 * Hard-reset `repoPath`'s current branch to `sha` — used to restore a task
 * checkpoint. Unlike `checkout`, `reset --hard` does not refuse on a dirty
 * working tree, so this checks first and throws rather than silently
 * discarding uncommitted work.
 */
export function resetHardTo(repoPath: string, sha: string): void {
  if (hasUncommittedChanges(repoPath)) {
    throw new Error(
      `refusing to restore: "${repoPath}" has uncommitted changes — commit, stash, or discard them first`,
    );
  }
  git(repoPath, ["reset", "--hard", sha]);
}

// ---------------------------------------------------------------------------
// Worktrees: per-task working directories sharing one object store
// ---------------------------------------------------------------------------

export const WORKTREES_DIR = ".orchestra-worktrees";

/** The dedicated worktree directory for a task, nested under the project repo. */
export function worktreePath(repoPath: string, taskId: string): string {
  return path.join(repoPath, WORKTREES_DIR, taskId);
}

/**
 * Whether `worktreeDir` is already a live worktree. Checked by asking git
 * from *inside* that directory rather than string-matching it against
 * `git worktree list`'s output against `repoPath` — the latter compares
 * canonicalized paths (git resolves symlinks) against `worktreeDir` as
 * constructed, which spuriously mismatches wherever the two differ (e.g.
 * macOS's `/var` → `/private/var`), causing a duplicate `worktree add` that
 * git then rejects because the directory already exists.
 */
function worktreeRegistered(worktreeDir: string): boolean {
  if (!fs.existsSync(path.join(worktreeDir, ".git"))) return false;
  try {
    git(worktreeDir, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create (once) this task's dedicated worktree, checked out onto `branch` —
 * creating `branch` off `baseBranch` if it doesn't exist yet. Idempotent: a
 * worktree already registered at `worktreeDir` is left alone.
 *
 * Unlike `ensureBranch`, this throws on failure rather than swallowing it —
 * a worktree is a precondition for a task to do any work at all, so silently
 * continuing would mean falling back to a shared checkout and reintroducing
 * the exact cross-task races worktrees exist to remove.
 */
export function ensureWorktree(repoPath: string, worktreeDir: string, branch: string, baseBranch: string): void {
  if (worktreeRegistered(worktreeDir)) return;
  fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });
  if (branchExists(repoPath, branch)) {
    git(repoPath, ["worktree", "add", worktreeDir, branch]);
  } else {
    git(repoPath, ["worktree", "add", "-b", branch, worktreeDir, baseBranch]);
  }
}

/**
 * Remove a task's worktree. Best-effort like `commitArtifacts` — a cleanup
 * failure (already deleted, git refuses due to untracked files) is logged
 * and swallowed rather than thrown, since it must never block the caller
 * (task delete/reset) from completing.
 */
export function removeWorktree(repoPath: string, worktreeDir: string): void {
  try {
    git(repoPath, ["worktree", "remove", "--force", worktreeDir]);
  } catch (err) {
    console.warn(`[git] worktree remove failed for "${worktreeDir}", falling back to rm: ${(err as Error).message}`);
    try {
      fs.rmSync(worktreeDir, { recursive: true, force: true });
      git(repoPath, ["worktree", "prune"]);
    } catch (err2) {
      console.warn(`[git] worktree cleanup failed for "${worktreeDir}": ${(err2 as Error).message}`);
    }
  }
}

/** Sweep stale worktree registrations (e.g. after a crash left directories half-removed). */
export function pruneWorktrees(repoPath: string): void {
  try {
    git(repoPath, ["worktree", "prune"]);
  } catch (err) {
    console.warn(`[git] worktree prune failed for "${repoPath}": ${(err as Error).message}`);
  }
}

/** True if `repoPath` is a per-task worktree (`<repo>/.orchestra-worktrees/<taskId>`),
 *  not a bare project checkout. The guarded write/edit tools (agent.ts) must only
 *  ever be registered against a worktree — runRole() asserts this before wiring
 *  them in, since a shared checkout has no per-task isolation. */
export function isWorktreePath(repoPath: string): boolean {
  return repoPath.split(path.sep).includes(WORKTREES_DIR);
}

/**
 * Validate that an absolute path pi's write/edit tools have already resolved
 * (via their own unguarded `path.resolve(cwd, input)`) still lands inside
 * `worktreeRoot`, and isn't the worktree's own `.git` entry. Throws on any
 * violation — the caller (a guarded write/edit operation in agent.ts) lets
 * this propagate so pi's tool-call machinery turns it into a normal error
 * tool result, the same way a validation failure in any other tool does.
 *
 * Mirrors `resolveInPlanning`'s escape check above, applied to the worktree
 * root instead of the PLANNING tree.
 *
 * `.git` under a worktree root is a *file* (not a directory) containing
 * `gitdir: <repo>/.git/worktrees/<taskId>` — overwriting it lets a write call
 * repoint the task's git identity anywhere on disk, silently breaking
 * worktree isolation for every subsequent git operation against this path.
 * Blocked outright rather than validated by content.
 */
export function assertInsideWorktree(worktreeRoot: string, absPath: string): string {
  const resolved = path.resolve(absPath);
  const rel = path.relative(worktreeRoot, resolved);
  if (rel === "") {
    throw new Error("refusing to write the worktree root itself");
  }
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes task worktree sandbox: ${absPath}`);
  }
  if (rel === ".git" || rel.startsWith(`.git${path.sep}`)) {
    throw new Error(`refusing to write git-internal path: ${rel}`);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Branch reconciliation
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  status: "merged" | "up_to_date" | "conflict" | "error";
  detail?: string;
}

/**
 * Reconcile a finished task's branch back into `baseBranch`. Never throws —
 * the outcome is carried entirely in the return value so a reconciliation
 * failure can be recorded and surfaced without ever crashing the scheduler
 * tick that's completing the task.
 *
 * Two-step: first merge `baseBranch` into `branch` (from `repoPath`, which is
 * expected to already be checked out to `branch` — a task's own worktree) so
 * any conflict resolution happens on the disposable task branch, never on
 * `baseBranch` itself. If that's clean, merge `branch` into `baseBranch` in
 * the shared repo root, where `baseBranch` lives.
 */
export function reconcileBranch(repoPath: string, branch: string, baseBranch: string): ReconcileResult {
  try {
    git(repoPath, ["merge", "--no-edit", baseBranch]);
  } catch (err) {
    const conflicted = conflictedFiles(repoPath);
    if (conflicted.length) {
      try {
        git(repoPath, ["merge", "--abort"]);
      } catch {
        // best-effort: leave as-is if even the abort fails
      }
      return { status: "conflict", detail: conflicted.join(", ") };
    }
    return { status: "error", detail: (err as Error).message };
  }

  const repoRoot = repoRootOf(repoPath) ?? repoPath;
  try {
    const beforeSha = git(repoRoot, ["rev-parse", baseBranch]);
    checkoutBranch(repoRoot, baseBranch);
    git(repoRoot, ["merge", "--no-ff", "--no-edit", branch]);
    const afterSha = git(repoRoot, ["rev-parse", baseBranch]);
    return { status: beforeSha === afterSha ? "up_to_date" : "merged" };
  } catch (err) {
    const conflicted = conflictedFiles(repoRoot);
    if (conflicted.length) {
      try {
        git(repoRoot, ["merge", "--abort"]);
      } catch {
        // best-effort
      }
      return { status: "conflict", detail: conflicted.join(", ") };
    }
    return { status: "error", detail: (err as Error).message };
  }
}

function conflictedFiles(repoPath: string): string[] {
  try {
    return git(repoPath, ["diff", "--name-only", "--diff-filter=U"])
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** The repo root that `repoPath` (possibly a worktree) shares its object store with. */
function repoRootOf(repoPath: string): string | undefined {
  try {
    const commonDir = git(repoPath, ["rev-parse", "--git-common-dir"]);
    const resolved = path.isAbsolute(commonDir) ? commonDir : path.resolve(repoPath, commonDir);
    return path.dirname(resolved);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Diffing: task branch vs. its base, for the pre-push review UI
// ---------------------------------------------------------------------------

export interface DiffFileSummary {
  path: string;
  oldPath?: string;
  status: "added" | "deleted" | "modified" | "renamed" | "copied";
  additions: number;
  deletions: number;
  binary: boolean;
}

function statusFromCode(code: string): DiffFileSummary["status"] {
  switch (code[0]) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    default:
      return "modified";
  }
}

/** `--numstat`'s rename column is `old => new` (or `common/{old => new}/suffix`
 *  when the unchanged path prefix/suffix is shared) rather than two separate
 *  fields — pull out just the resulting (new) path so it can be matched up
 *  against `--name-status`'s entry for the same file. */
function numstatNewPath(raw: string): string {
  const brace = /^(.*)\{.* => (.*)\}(.*)$/.exec(raw);
  if (brace) return `${brace[1]}${brace[2]}${brace[3]}`;
  if (raw.includes(" => ")) {
    const parts = raw.split(" => ");
    return parts[parts.length - 1]!;
  }
  return raw;
}

/**
 * File-level summary of everything `head` changed relative to where it
 * diverged from `base` (triple-dot / merge-base diff — matches GitHub's PR
 * "compare" semantics, so it's unaffected by unrelated commits landing on
 * `base` after the task branch forked off it).
 */
export function diffSummary(repoPath: string, base: string, head: string): DiffFileSummary[] {
  const range = `${base}...${head}`;
  const nameStatusRaw = git(repoPath, ["diff", "--name-status", "-M", "--diff-filter=ACDMR", range]);
  const numstatRaw = git(repoPath, ["diff", "--numstat", "-M", "--diff-filter=ACDMR", range]);

  const stats = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (const line of numstatRaw.split("\n")) {
    if (!line) continue;
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    const [, addRaw, delRaw, rawPath] = m as unknown as [string, string, string, string];
    const binary = addRaw === "-" || delRaw === "-";
    stats.set(numstatNewPath(rawPath), {
      additions: binary ? 0 : Number(addRaw),
      deletions: binary ? 0 : Number(delRaw),
      binary,
    });
  }

  const files: DiffFileSummary[] = [];
  for (const line of nameStatusRaw.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    const status = statusFromCode(parts[0]!);
    const renamedOrCopied = status === "renamed" || status === "copied";
    const newPath = renamedOrCopied ? parts[2]! : parts[1]!;
    const oldPath = renamedOrCopied ? parts[1] : undefined;
    const stat = stats.get(newPath) ?? { additions: 0, deletions: 0, binary: false };
    files.push({ path: newPath, oldPath, status, additions: stat.additions, deletions: stat.deletions, binary: stat.binary });
  }
  return files;
}

/** Unified patch text for exactly one file's change between `base` and `head`
 *  — fetched lazily per file (rather than one patch for the whole branch) so
 *  the initial diff view stays cheap even for a task that touched many files.
 *
 *  For a renamed/copied file, `oldPath` must also be passed (from the matching
 *  `DiffFileSummary.oldPath`) — restricting `git diff` to just the new path
 *  hides the old side of the rename entirely, so git can't pair them up and
 *  falls back to showing the whole file as a fresh addition instead of the
 *  actual (often much smaller) rename+edit diff. */
export function diffFilePatch(repoPath: string, base: string, head: string, filePath: string, oldPath?: string): string {
  const pathArgs = oldPath && oldPath !== filePath ? [oldPath, filePath] : [filePath];
  return git(repoPath, ["diff", "--unified=3", "-M", `${base}...${head}`, "--", ...pathArgs]);
}

// ---------------------------------------------------------------------------
// GitHub push
// ---------------------------------------------------------------------------

/** The URL configured for a remote (e.g. "origin"), or null if it isn't set. */
export function remoteUrl(repoPath: string, name = "origin"): string | null {
  try {
    return git(repoPath, ["remote", "get-url", name]);
  } catch {
    return null;
  }
}

/**
 * Push `branch` to a GitHub repo using `token` for auth, without touching the
 * repo's configured remotes or writing anything token-bearing to `.git/config`
 * — the token-embedded URL is passed as the push destination directly.
 *
 * A non-interactive server process has no credential helper to lean on for a
 * private/HTTPS remote, so the token has to be embedded here; in exchange,
 * any thrown error is scrubbed of the token first; `execSync`'s own error
 * message otherwise echoes the full shell command (token included) verbatim.
 */
export function pushBranchToGithub(repoPath: string, branch: string, owner: string, repo: string, token: string): void {
  const authedUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
  try {
    git(repoPath, ["push", authedUrl, `${branch}:${branch}`]);
  } catch (err) {
    throw new Error(`git push failed: ${(err as Error).message.split(token).join("***")}`);
  }
}
