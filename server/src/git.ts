/**
 * Git + filesystem helpers for the per-project `/PLANNING` tree.
 *
 * The DB is authoritative for state; these helpers mirror artifacts onto disk
 * (and commit them) so the refinement history is version-controlled and PR-able.
 * All writes are sandboxed to `<repo>/<planningDir>`.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const STAGE_DIRS = ["INTAKE", "REFINING", "READY", "REVIEW", "epics"] as const;
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
