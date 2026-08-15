import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendArtifactSection,
  commitArtifacts,
  currentBranch,
  deleteBranch,
  ensureWorktree,
  isGitRepo,
  listOrchestraBranches,
  moveArtifact,
  readArtifact,
  reconcileBranch,
  refineCommitMessage,
  removeWorktree,
  resolveInPlanning,
  resolveRef,
  scaffoldPlanning,
  scanIntake,
  worktreePath,
  writeArtifact,
} from "../src/git";
import { gitLog, tempGitRepo } from "./helpers";

const cleanups: string[] = [];
afterEach(() => {
  for (const d of cleanups.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function repo(): string {
  const r = tempGitRepo();
  cleanups.push(r);
  return r;
}
/** Porcelain working-tree status — "" means git sees nothing out of place. */
function status(r: string): string {
  return execFileSync("git", ["status", "--porcelain"], { cwd: r, encoding: "utf8" }).trim();
}

describe("isGitRepo", () => {
  it("resolves the canonical root from the repo root", () => {
    const r = repo();
    expect(isGitRepo(r).canonicalRoot).toBe(fs.realpathSync(r));
  });

  it("resolves the same root from a subdirectory", () => {
    const r = repo();
    const sub = path.join(r, "src", "deep");
    fs.mkdirSync(sub, { recursive: true });
    expect(isGitRepo(sub).canonicalRoot).toBe(fs.realpathSync(r));
  });

  it("throws on a non-git directory", () => {
    const r = repo();
    const outside = fs.mkdtempSync(path.join(path.dirname(r), "not-git-"));
    cleanups.push(outside);
    expect(() => isGitRepo(outside)).toThrow(/not a git repository/i);
  });
});

describe("resolveInPlanning (path sandbox)", () => {
  it("resolves a valid nested path under PLANNING", () => {
    const r = repo();
    const abs = resolveInPlanning(r, "PLANNING", "REFINING", "task.md");
    expect(abs).toBe(path.join(r, "PLANNING", "REFINING", "task.md"));
  });

  it("rejects a parent-traversal escape", () => {
    const r = repo();
    expect(() => resolveInPlanning(r, "PLANNING", "../../etc/passwd")).toThrow(/sandbox/);
  });

  it("rejects an absolute path outside the sandbox", () => {
    const r = repo();
    expect(() => resolveInPlanning(r, "PLANNING", "/etc/passwd")).toThrow(/sandbox/);
  });

  it("rejects sneaky mid-segment traversal", () => {
    const r = repo();
    expect(() => resolveInPlanning(r, "PLANNING", "REFINING/../../..//x")).toThrow(/sandbox/);
  });
});

describe("scaffoldPlanning", () => {
  it("creates all stage folders with .gitkeep", () => {
    const r = repo();
    scaffoldPlanning(r, "PLANNING");
    for (const d of ["INTAKE", "REFINING", "READY", "REVIEW", "epics"]) {
      expect(fs.existsSync(path.join(r, "PLANNING", d, ".gitkeep"))).toBe(true);
    }
  });
});

describe("scanIntake", () => {
  it("returns files but skips dotfiles and subdirectories", () => {
    const r = repo();
    scaffoldPlanning(r, "PLANNING");
    const intake = path.join(r, "PLANNING", "INTAKE");
    fs.writeFileSync(path.join(intake, "crash.log"), "boom");
    fs.writeFileSync(path.join(intake, "notes.md"), "hi");
    fs.writeFileSync(path.join(intake, ".hidden"), "x");
    fs.mkdirSync(path.join(intake, "adir"));
    const found = scanIntake(r, "PLANNING").map((f) => f.fileName).sort();
    expect(found).toEqual(["crash.log", "notes.md"]);
  });
});

describe("artifact writes", () => {
  it("appendArtifactSection separates sections with a blank line", () => {
    const r = repo();
    const f = path.join(r, "PLANNING", "REFINING", "a.md");
    writeArtifact(f, "# Title\n");
    appendArtifactSection(f, "## Role A\nbody");
    appendArtifactSection(f, "## Role B\nbody");
    const out = readArtifact(f);
    expect(out).toContain("## Role A");
    expect(out).toContain("## Role B");
    expect(out.split("## Role").length).toBe(3);
  });

  it("moveArtifact relocates the file", () => {
    const r = repo();
    const from = path.join(r, "PLANNING", "REFINING", "a.md");
    const to = path.join(r, "PLANNING", "READY", "a.md");
    writeArtifact(from, "x");
    moveArtifact(from, to);
    expect(fs.existsSync(from)).toBe(false);
    expect(fs.existsSync(to)).toBe(true);
  });
});

describe("commits", () => {
  it("commitArtifacts stages + commits and reports true; false when nothing changed", () => {
    const r = repo();
    const rel = path.join("PLANNING", "REFINING", "a.md");
    writeArtifact(path.join(r, rel), "hello");
    expect(commitArtifacts(r, [rel], "refine(explorer): a — grounded")).toBe(true);
    expect(gitLog(r)[0]).toBe("refine(explorer): a — grounded");
    // No further changes → nothing to commit.
    expect(commitArtifacts(r, [rel], "noop")).toBe(false);
  });

  it("refineCommitMessage formats role/task/purpose and truncates", () => {
    expect(refineCommitMessage("security_review", "t1", "threat model")).toBe(
      "refine(security_review): t1 — threat model",
    );
    const long = refineCommitMessage("x", "t", "p".repeat(300));
    expect(long.length).toBeLessThan(160);
  });
});

describe("worktrees", () => {
  it("creates an isolated worktree on its own branch, off base", () => {
    const r = repo();
    const base = currentBranch(r);
    const dir = worktreePath(r, "task-1");
    ensureWorktree(r, dir, "orchestra/task-1", base);

    expect(fs.existsSync(path.join(dir, "README.md"))).toBe(true);
    expect(currentBranch(dir)).toBe("orchestra/task-1");
    // The main checkout is untouched — worktree creation never switches it.
    expect(currentBranch(r)).toBe(base);
  });

  it("is idempotent — re-asserting an existing worktree does not error or recreate it", () => {
    const r = repo();
    const base = currentBranch(r);
    const dir = worktreePath(r, "task-1");
    ensureWorktree(r, dir, "orchestra/task-1", base);
    writeArtifact(path.join(dir, "marker.txt"), "still here");
    expect(() => ensureWorktree(r, dir, "orchestra/task-1", base)).not.toThrow();
    expect(fs.existsSync(path.join(dir, "marker.txt"))).toBe(true);
  });

  it("removeWorktree deletes the directory and lets a later ensureWorktree reattach to the same branch", () => {
    const r = repo();
    const base = currentBranch(r);
    const dir = worktreePath(r, "task-1");
    ensureWorktree(r, dir, "orchestra/task-1", base);
    writeArtifact(path.join(dir, "work.md"), "in progress");
    commitArtifacts(dir, ["work.md"], "wip");

    removeWorktree(r, dir);
    expect(fs.existsSync(dir)).toBe(false);

    // The branch (and its commit) survives — only the worktree checkout was removed.
    ensureWorktree(r, dir, "orchestra/task-1", base);
    expect(fs.existsSync(path.join(dir, "work.md"))).toBe(true);
  });

  it("makes the worktrees container self-ignoring, leaving the user's repo clean", () => {
    const r = repo();
    const base = currentBranch(r);
    ensureWorktree(r, worktreePath(r, "task-1"), "orchestra/task-1", base);

    // A `.gitignore` of `*` inside the container hides the directory AND
    // itself, so Orchestra never dirties `git status` and never has to touch
    // the user's own root `.gitignore`.
    expect(fs.readFileSync(path.join(r, ".orchestra-worktrees", ".gitignore"), "utf8")).toBe("*\n");
    expect(fs.existsSync(path.join(r, ".gitignore"))).toBe(false);
    expect(status(r)).toBe("");
  });

  it("leaves an existing container .gitignore alone", () => {
    const r = repo();
    const base = currentBranch(r);
    const ignoreFile = path.join(r, ".orchestra-worktrees", ".gitignore");
    fs.mkdirSync(path.dirname(ignoreFile), { recursive: true });
    fs.writeFileSync(ignoreFile, "*\n# hand-edited\n");

    ensureWorktree(r, worktreePath(r, "task-1"), "orchestra/task-1", base);
    expect(fs.readFileSync(ignoreFile, "utf8")).toContain("# hand-edited");
  });
});

describe("deleteBranch", () => {
  it("deletes a merged branch and refuses an unmerged one", () => {
    const r = repo();
    const base = currentBranch(r);

    // Merged: worktree removed first (git won't delete a checked-out branch).
    const mergedDir = worktreePath(r, "merged");
    ensureWorktree(r, mergedDir, "orchestra/merged", base);
    writeArtifact(path.join(mergedDir, "a.md"), "a");
    commitArtifacts(mergedDir, ["a.md"], "landed work");
    expect(reconcileBranch(mergedDir, "orchestra/merged", base).status).toBe("merged");
    removeWorktree(r, mergedDir);

    // Unmerged: a commit that never reached base.
    const openDir = worktreePath(r, "open");
    ensureWorktree(r, openDir, "orchestra/open", base);
    writeArtifact(path.join(openDir, "b.md"), "b");
    commitArtifacts(openDir, ["b.md"], "unlanded work");
    removeWorktree(r, openDir);

    expect(deleteBranch(r, "orchestra/merged")).toBe(true);
    // `-d`, never `-D`: git's own unmerged check is the safety property.
    expect(deleteBranch(r, "orchestra/open")).toBe(false);

    const remaining = listOrchestraBranches(r);
    expect(remaining).toEqual(["orchestra/open"]);
  });

  it("returns false rather than throwing for a branch that does not exist", () => {
    const r = repo();
    expect(deleteBranch(r, "orchestra/never-existed")).toBe(false);
  });
});

describe("listOrchestraBranches", () => {
  it("returns only orchestra/* branches, never the user's own", () => {
    const r = repo();
    const base = currentBranch(r);
    execFileSync("git", ["branch", "feature/mine"], { cwd: r });
    ensureWorktree(r, worktreePath(r, "t1"), "orchestra/t1", base);
    ensureWorktree(r, worktreePath(r, "t2"), "orchestra/t2", base);

    expect(listOrchestraBranches(r).sort()).toEqual(["orchestra/t1", "orchestra/t2"]);
  });
});

describe("resolveRef (PLANNING/overhaul/08 — scan worktree reset)", () => {
  it("resolves a branch name and HEAD to the same full SHA", () => {
    const r = repo();
    const base = currentBranch(r);
    const headViaBranch = resolveRef(r, base);
    const headViaHead = resolveRef(r, "HEAD");
    expect(headViaBranch).toBe(headViaHead);
    expect(headViaBranch).toMatch(/^[0-9a-f]{40}$/);
  });

  it("does not touch what is checked out at repoPath", () => {
    const r = repo();
    const base = currentBranch(r);
    resolveRef(r, base);
    expect(currentBranch(r)).toBe(base);
  });

  it("throws on an unknown ref", () => {
    const r = repo();
    expect(() => resolveRef(r, "refs/heads/does-not-exist")).toThrow();
  });
});

describe("reconcileBranch", () => {
  it("merges a clean task branch back into base", () => {
    const r = repo();
    const base = currentBranch(r);
    const dir = worktreePath(r, "task-1");
    ensureWorktree(r, dir, "orchestra/task-1", base);
    writeArtifact(path.join(dir, "PLANNING", "READY", "a.md"), "done");
    commitArtifacts(dir, [path.join("PLANNING", "READY", "a.md")], "ready: a");

    const result = reconcileBranch(dir, "orchestra/task-1", base);
    expect(result.status).toBe("merged");
    expect(fs.existsSync(path.join(r, "PLANNING", "READY", "a.md"))).toBe(true);
    expect(currentBranch(r)).toBe(base);
  });

  it("reports up_to_date when the task branch has nothing new to contribute", () => {
    const r = repo();
    const base = currentBranch(r);
    const dir = worktreePath(r, "task-1");
    ensureWorktree(r, dir, "orchestra/task-1", base);
    // No commits on the task branch beyond base.
    const result = reconcileBranch(dir, "orchestra/task-1", base);
    expect(result.status).toBe("up_to_date");
  });

  it("reports a conflict and leaves the task branch clean when base and task diverge on the same file", () => {
    const r = repo();
    const base = currentBranch(r);
    const dir = worktreePath(r, "task-1");
    ensureWorktree(r, dir, "orchestra/task-1", base);

    // Task branch changes README.md.
    writeArtifact(path.join(dir, "README.md"), "# task version\n");
    commitArtifacts(dir, ["README.md"], "task: rewrite readme");

    // Base moves too, touching the same file differently.
    writeArtifact(path.join(r, "README.md"), "# base version\n");
    commitArtifacts(r, ["README.md"], "base: rewrite readme");

    const result = reconcileBranch(dir, "orchestra/task-1", base);
    expect(result.status).toBe("conflict");
    expect(result.detail).toContain("README.md");

    // The task branch was left clean (merge --abort), not mid-conflict.
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).trim();
    expect(status).toBe("");
    expect(fs.readFileSync(path.join(dir, "README.md"), "utf8")).toBe("# task version\n");
  });

  it("reports an error (not a conflict) when the base branch doesn't exist", () => {
    const r = repo();
    const base = currentBranch(r);
    const dir = worktreePath(r, "task-1");
    ensureWorktree(r, dir, "orchestra/task-1", base);

    const result = reconcileBranch(dir, "orchestra/task-1", "does-not-exist");
    expect(result.status).toBe("error");
  });
});

// A sanity check that git itself is available in the environment.
describe("environment", () => {
  it("has git", () => {
    expect(execFileSync("git", ["--version"], { encoding: "utf8" })).toMatch(/git version/);
  });
});
