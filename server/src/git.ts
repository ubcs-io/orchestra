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

const WORKTREES_DIR = ".orchestra-worktrees";

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
