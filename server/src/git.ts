/**
 * Git + filesystem helpers for the per-project `/PLANNING` tree.
 *
 * The DB is authoritative for state; these helpers mirror artifacts onto disk
 * (and commit them) so the refinement history is version-controlled and PR-able.
 * All writes are sandboxed to `<repo>/<planningDir>`.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const STAGE_DIRS = ["INTAKE", "REFINING", "READY", "REVIEW", "epics"] as const;
export type StageDir = (typeof STAGE_DIRS)[number];

function git(repoPath: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoPath, encoding: "utf8" }).trim();
}

export function isGitRepo(repoPath: string): boolean {
  try {
    return git(repoPath, ["rev-parse", "--is-inside-work-tree"]) === "true";
  } catch {
    return false;
  }
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
