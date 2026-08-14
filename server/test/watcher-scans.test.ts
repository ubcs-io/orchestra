import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeDb, createProject, getMeta, type ProjectRow } from "../src/db";
import { listLocalBranches, listTrackedFiles, blameLineTimestamps } from "../src/git";
import {
  collectSourceTokens,
  extractDocSymbolRefs,
  extractTodoMarkers,
  looksOffline,
  parseLintOutput,
  parseNpmAudit,
  parseNpmOutdated,
  prepareScanWorktree,
  runBranchTriageWatcher,
  runDepStalenessWatcher,
  runDocDriftWatcher,
  runLintDriftWatcher,
  runTodoScanWatcher,
  selectStaleBranches,
  type ScanContext,
} from "../src/watcher-scans";
import type { ExecEvidence } from "../src/exec";
import { freshDb, tempGitRepo } from "./helpers";

afterEach(() => closeDb());

const DAY_MS = 86_400_000;

function git(repo: string, args: string[], env?: Record<string, string>): void {
  execFileSync("git", args, { cwd: repo, env: { ...process.env, ...env } });
}

/** Commit `files` with a backdated author AND committer date, so `git blame`
 *  reports the age these watchers key off. */
function commitAt(repo: string, files: Record<string, string>, daysAgo: number): void {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  const when = new Date(Date.now() - daysAgo * DAY_MS).toISOString();
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", `commit ${daysAgo}d ago`], {
    GIT_AUTHOR_DATE: when,
    GIT_COMMITTER_DATE: when,
  });
}

function ctxFor(project: ProjectRow, scanDir: string, cfg: Partial<ScanContext["cfg"]> = {}): ScanContext {
  return {
    project,
    scanDir,
    cfg: { name: "w", enabled: true, cadenceMinutes: 60, perWatcherDailyCap: 2, ...cfg },
  };
}

function execProject(repo: string, allowlist: { name: string; argv: string[] }[]): ProjectRow {
  return createProject({
    name: "p",
    repo_path: repo,
    config_json: JSON.stringify({ harness: { allowExec: true, execAllowlist: allowlist } }),
  });
}

// ---------------------------------------------------------------------------
// git primitives
// ---------------------------------------------------------------------------

describe("git read-only inspection", () => {
  it("listTrackedFiles returns tracked paths and excludes ignored ones", () => {
    const repo = tempGitRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), "ignored.txt\n");
    fs.writeFileSync(path.join(repo, "ignored.txt"), "nope");
    commitAt(repo, { "src/a.ts": "export const a = 1;\n" }, 1);

    const files = listTrackedFiles(repo);
    expect(files).toContain("src/a.ts");
    expect(files).toContain("README.md");
    expect(files).not.toContain("ignored.txt");
  });

  it("listTrackedFiles returns [] for a path that isn't a repo, rather than throwing", () => {
    expect(listTrackedFiles(path.join(fs.mkdtempSync(path.join(tmpdir(), "not-a-repo-")), "x"))).toEqual([]);
  });

  it("blameLineTimestamps maps every line to its commit's author time", () => {
    const repo = tempGitRepo();
    commitAt(repo, { "src/a.ts": "line1\nline2\n" }, 10);
    const times = blameLineTimestamps(repo, "src/a.ts");
    expect(times.size).toBe(2);
    const ageDays = (Date.now() / 1000 - times.get(1)!) / 86_400;
    expect(ageDays).toBeGreaterThan(9);
    expect(ageDays).toBeLessThan(11);
    // Second line came from the same commit — porcelain omits the repeated
    // header fields, which is exactly the case the sha→time table exists for.
    expect(times.get(2)).toBe(times.get(1));
  });

  it("listLocalBranches reports divergence and skips base + orchestra bookkeeping branches", () => {
    const repo = tempGitRepo();
    const base = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    git(repo, ["checkout", "-q", "-b", "feature/x"]);
    commitAt(repo, { "src/x.ts": "x\n" }, 5);
    git(repo, ["checkout", "-q", base]);
    git(repo, ["checkout", "-q", "-b", "orchestra/_scan"]);
    git(repo, ["checkout", "-q", base]);

    const branches = listLocalBranches(repo, base);
    expect(branches.map((b) => b.name)).toEqual(["feature/x"]);
    expect(branches[0]!.ahead).toBe(1);
    expect(branches[0]!.behind).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// todo-scan
// ---------------------------------------------------------------------------

describe("todo-scan", () => {
  it("extractTodoMarkers finds tagged comment lines and ignores prose mentions", () => {
    const markers = extractTodoMarkers("a.ts", [
      "// TODO: wire up the thing",
      "const s = 'the TODO list feature';",
      "  # FIXME handle the null case",
      "/* HACK: works by accident */",
      "<!-- XXX revisit -->",
    ].join("\n"));
    expect(markers.map((m) => m.tag)).toEqual(["TODO", "FIXME", "HACK", "XXX"]);
    expect(markers[0]!.text).toBe("wire up the thing");
    expect(markers[0]!.line).toBe(1);
    expect(markers[4 - 1]!.text).toBe("revisit");
  });

  it("proposes only markers older than the age threshold", async () => {
    freshDb();
    const repo = tempGitRepo();
    commitAt(repo, { "src/old.ts": "// TODO: ancient debt\nexport const a = 1;\n" }, 90);
    commitAt(repo, { "src/new.ts": "// TODO: written today\nexport const b = 2;\n" }, 0);
    const project = createProject({ name: "p", repo_path: repo });

    const found = await runTodoScanWatcher(ctxFor(project, repo, { thresholdDays: 30 }));
    expect(found).toHaveLength(1);
    const payload = found[0]!.payload as { renderedContent: string; markerCount: number };
    expect(found[0]!.kind).toBe("chore");
    expect(payload.markerCount).toBe(1);
    expect(payload.renderedContent).toContain("ancient debt");
    expect(payload.renderedContent).not.toContain("written today");
  });

  it("returns nothing when every marker is younger than the threshold", async () => {
    freshDb();
    const repo = tempGitRepo();
    commitAt(repo, { "src/new.ts": "// FIXME: fresh\n" }, 2);
    const project = createProject({ name: "p", repo_path: repo });
    expect(await runTodoScanWatcher(ctxFor(project, repo, { thresholdDays: 30 }))).toEqual([]);
  });

  it("fingerprints on marker text, not line numbers, so unrelated edits don't re-propose", async () => {
    freshDb();
    const repo = tempGitRepo();
    commitAt(repo, { "src/a.ts": "// TODO: stable marker\n" }, 60);
    const project = createProject({ name: "p", repo_path: repo });
    const first = await runTodoScanWatcher(ctxFor(project, repo, { thresholdDays: 30 }));

    // Insert a line ABOVE the TODO: same marker, new line number.
    commitAt(repo, { "src/a.ts": "const x = 1;\n// TODO: stable marker\n" }, 60);
    const second = await runTodoScanWatcher(ctxFor(project, repo, { thresholdDays: 30 }));

    expect(first[0]!.fingerprint).toBe(second[0]!.fingerprint);
  });
});

// ---------------------------------------------------------------------------
// branch-triage
// ---------------------------------------------------------------------------

describe("branch-triage", () => {
  const branch = (over: Partial<Parameters<typeof selectStaleBranches>[0][number]> = {}) => ({
    name: "feature/x",
    tipSha: "abc",
    lastCommitAt: new Date(Date.now() - 60 * DAY_MS).toISOString(),
    subject: "wip",
    ahead: 3,
    behind: 1,
    ...over,
  });

  it("selects only quiet branches that carry unmerged commits", () => {
    const selected = selectStaleBranches(
      [
        branch({ name: "old-unmerged" }),
        branch({ name: "old-but-merged", ahead: 0 }),
        branch({ name: "recent", lastCommitAt: new Date().toISOString() }),
      ],
      Date.now(),
      30,
    );
    expect(selected.map((b) => b.name)).toEqual(["old-unmerged"]);
    expect(selected[0]!.ageDays).toBeGreaterThanOrEqual(59);
  });

  it("ignores a branch whose tip date is unparseable rather than treating it as ancient", () => {
    expect(selectStaleBranches([branch({ lastCommitAt: "not-a-date" })], Date.now(), 30)).toEqual([]);
  });

  it("produces a question-kind candidate that asks rather than proposes deletion", async () => {
    freshDb();
    const repo = tempGitRepo();
    const base = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    git(repo, ["checkout", "-q", "-b", "feature/abandoned"]);
    commitAt(repo, { "src/x.ts": "x\n" }, 120);
    git(repo, ["checkout", "-q", base]);
    const project = createProject({ name: "p", repo_path: repo, main_branch: base });

    const found = await runBranchTriageWatcher(ctxFor(project, repo, { thresholdDays: 30 }));
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("question");
    const content = (found[0]!.payload as { renderedContent: string }).renderedContent;
    expect(content).toContain("feature/abandoned");
    expect(content).toContain("Do not delete or modify any branch");
  });
});

// ---------------------------------------------------------------------------
// doc-drift
// ---------------------------------------------------------------------------

describe("doc-drift", () => {
  it("extractDocSymbolRefs takes code-shaped backticked identifiers only", () => {
    const refs = extractDocSymbolRefs(
      "Call `resolveThing()` and `snake_case_fn`. Not `test`, not `a`, not `PLANNING/x.md`.\n" +
        "```\n`insideAFence`\n```\n",
    );
    expect(refs.sort()).toEqual(["resolveThing", "snake_case_fn"]);
  });

  it("flags documented symbols absent from the source, and stays quiet when they exist", async () => {
    freshDb();
    const repo = tempGitRepo();
    commitAt(
      repo,
      {
        "src/a.ts": "export function stillHere() { return 1; }\n",
        "docs/guide.md": "Use `stillHere` and `wasRenamedAway` to do the thing.\n",
      },
      1,
    );
    const project = createProject({ name: "p", repo_path: repo });

    const found = await runDocDriftWatcher(ctxFor(project, repo));
    expect(found).toHaveLength(1);
    const rendered = (found[0]!.payload as { renderedContent: string }).renderedContent;
    expect(rendered).toContain("wasRenamedAway");
    expect(rendered).not.toContain("stillHere");
  });

  it("collectSourceTokens accumulates identifiers across files", () => {
    const set = new Set<string>();
    collectSourceTokens("export const alpha = 1;", set);
    collectSourceTokens("function beta() {}", set);
    expect(set.has("alpha")).toBe(true);
    expect(set.has("beta")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// lint-drift
// ---------------------------------------------------------------------------

describe("lint-drift", () => {
  it("parseLintOutput prefers an eslint-style summary over line counting", () => {
    const parsed = parseLintOutput("src/a.ts:3:1  error  Unexpected\n\n✖ 12 problems (3 errors, 9 warnings)\n");
    expect(parsed.count).toBe(12);
    expect(parsed.files).toContain("src/a.ts");
  });

  it("parseLintOutput falls back to counting file:line:col diagnostics", () => {
    const parsed = parseLintOutput("src/a.ts:3:1 error x\nsrc/b.ts:9:2 warning y\n");
    expect(parsed.count).toBe(2);
    expect(parsed.files.sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("first run only establishes a baseline; a later growth proposes, a later drop does not", async () => {
    freshDb();
    const repo = tempGitRepo();
    // Three scripted runs with growing then shrinking problem counts.
    const script = (n: number) =>
      `console.log(${JSON.stringify(`src/a.ts:1:1 error x\n✖ ${n} problems (0 errors, ${n} warnings)`)})`;
    const project = execProject(repo, [{ name: "lint", argv: ["node", "-e", script(5)] }]);
    const cfg = { commands: ["lint"] };

    expect(await runLintDriftWatcher(ctxFor(project, repo, cfg))).toEqual([]); // baseline
    expect(getMeta(`autonomy:lint-drift:${project.id}:lint:count`)).toBe("5");

    const grown = execProject(repo, [{ name: "lint", argv: ["node", "-e", script(9)] }]);
    // Same project id is what the baseline is keyed on, so reuse it.
    const grownCtx = ctxFor({ ...grown, id: project.id }, repo, cfg);
    const found = await runLintDriftWatcher(grownCtx);
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("chore");
    expect((found[0]!.payload as { previousCount: number; count: number })).toMatchObject({
      previousCount: 5,
      count: 9,
    });

    const shrunk = execProject(repo, [{ name: "lint", argv: ["node", "-e", script(2)] }]);
    expect(await runLintDriftWatcher(ctxFor({ ...shrunk, id: project.id }, repo, cfg))).toEqual([]);
  }, 20000);

  it("skips silently when no lint command is configured", async () => {
    freshDb();
    const repo = tempGitRepo();
    const project = execProject(repo, []);
    expect(await runLintDriftWatcher(ctxFor(project, repo, { commands: ["lint"] }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// dep-staleness
// ---------------------------------------------------------------------------

describe("dep-staleness", () => {
  const evidence = (over: Partial<ExecEvidence> = {}): ExecEvidence => ({
    name: "outdated",
    argv: ["npm", "outdated"],
    exitCode: 1,
    durationMs: 10,
    outputTail: "",
    truncated: false,
    timedOut: false,
    startedAt: new Date().toISOString(),
    ...over,
  });

  it("parseNpmOutdated drops packages already at latest", () => {
    const deps = parseNpmOutdated(
      JSON.stringify({
        vitest: { current: "1.0.0", wanted: "1.2.0", latest: "1.2.0" },
        typescript: { current: "5.5.0", wanted: "5.5.0", latest: "5.5.0" },
      }),
    );
    expect(deps).toEqual([{ name: "vitest", current: "1.0.0", latest: "1.2.0" }]);
  });

  it("parseNpmOutdated returns [] for a non-npm runner's output", () => {
    expect(parseNpmOutdated("all dependencies up to date")).toEqual([]);
  });

  it("parseNpmAudit reports only high/critical, from either npm schema", () => {
    const modern = parseNpmAudit(
      JSON.stringify({
        vulnerabilities: {
          lodash: { severity: "critical", via: [{ title: "Prototype pollution" }] },
          minimist: { severity: "moderate", via: [{ title: "meh" }] },
        },
      }),
    );
    expect(modern).toEqual([{ name: "lodash", severity: "critical", title: "Prototype pollution" }]);

    const legacy = parseNpmAudit(
      JSON.stringify({ advisories: { "118": { module_name: "tar", severity: "high", title: "Path traversal" } } }),
    );
    expect(legacy).toEqual([{ name: "tar", severity: "high", title: "Path traversal" }]);
  });

  it("looksOffline recognises spawn failures and network errors", () => {
    expect(looksOffline(evidence({ spawnError: "ENOENT" }))).toBe(true);
    expect(looksOffline(evidence({ outputTail: "request to https://registry.npmjs.org failed, reason: getaddrinfo EAI_AGAIN" }))).toBe(true);
    expect(looksOffline(evidence({ outputTail: '{"vitest":{"current":"1.0.0","latest":"1.2.0"}}' }))).toBe(false);
  });

  it("produces a chore candidate for outdated deps and a security candidate for advisories", async () => {
    freshDb();
    const repo = tempGitRepo();
    const outdatedJson = JSON.stringify({ vitest: { current: "1.0.0", latest: "1.2.0" } });
    const auditJson = JSON.stringify({
      vulnerabilities: { lodash: { severity: "critical", via: [{ title: "Prototype pollution" }] } },
    });
    const project = execProject(repo, [
      { name: "outdated", argv: ["node", "-e", `console.log(${JSON.stringify(outdatedJson)})`] },
      { name: "audit", argv: ["node", "-e", `console.log(${JSON.stringify(auditJson)})`] },
    ]);

    const found = await runDepStalenessWatcher(ctxFor(project, repo, { commands: ["outdated", "audit"] }));
    expect(found.map((c) => c.kind)).toEqual(["chore", "security"]);
    expect((found[1]!.payload as { renderedContent: string }).renderedContent).toContain("Prototype pollution");
  }, 20000);

  it("produces nothing when the registry is unreachable", async () => {
    freshDb();
    const repo = tempGitRepo();
    const project = execProject(repo, [
      {
        name: "outdated",
        argv: ["node", "-e", "console.log('npm ERR! request to https://registry.npmjs.org failed: getaddrinfo EAI_AGAIN'); process.exit(1)"],
      },
    ]);
    expect(await runDepStalenessWatcher(ctxFor(project, repo, { commands: ["outdated"] }))).toEqual([]);
  }, 20000);
});

// ---------------------------------------------------------------------------
// Scan worktree
// ---------------------------------------------------------------------------

describe("prepareScanWorktree", () => {
  it("creates a dedicated _scan worktree on its own branch, leaving the primary checkout alone", () => {
    freshDb();
    const repo = tempGitRepo();
    const base = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const project = createProject({ name: "p", repo_path: repo, main_branch: base });

    const dir = prepareScanWorktree(project);
    expect(dir).toBe(path.join(repo, ".orchestra-worktrees", "_scan"));
    expect(fs.existsSync(path.join(dir!, "README.md"))).toBe(true);
    // The project's own checkout never left its branch.
    expect(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()).toBe(base);
    // Idempotent.
    expect(prepareScanWorktree(project)).toBe(dir);
  });

  it("returns null instead of throwing when the repo path isn't usable", () => {
    freshDb();
    const project = createProject({ name: "p", repo_path: "/definitely/not/a/repo" });
    expect(prepareScanWorktree(project)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Threshold plumbing
// ---------------------------------------------------------------------------

describe("thresholdDays plumbing", () => {
  it("a configured threshold overrides the watcher's default", async () => {
    freshDb();
    const repo = tempGitRepo();
    commitAt(repo, { "src/a.ts": "// TODO: 10 days old\n" }, 10);
    const project = createProject({ name: "p", repo_path: repo });

    expect(await runTodoScanWatcher(ctxFor(project, repo))).toEqual([]); // default 30d
    expect(await runTodoScanWatcher(ctxFor(project, repo, { thresholdDays: 5 }))).toHaveLength(1);
  });

  it("a zero threshold means 'any age', not 'fall back to the default'", async () => {
    freshDb();
    const repo = tempGitRepo();
    commitAt(repo, { "src/a.ts": "// TODO: written just now\n" }, 0);
    const project = createProject({ name: "p", repo_path: repo });
    expect(await runTodoScanWatcher(ctxFor(project, repo, { thresholdDays: 0 }))).toHaveLength(1);
  });
});
