import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendArtifactSection,
  commitArtifacts,
  currentBranch,
  ensureWorktree,
  isGitRepo,
  moveArtifact,
  readArtifact,
  reconcileBranch,
  refineCommitMessage,
  removeWorktree,
  resolveInPlanning,
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
