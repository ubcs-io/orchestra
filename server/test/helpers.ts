import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetConfig } from "../src/config";
import { closeDb, initDb } from "../src/db";

/** Point config at a brand-new temp SQLite file and initialize the schema. */
export function freshDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "orch-db-"));
  const dbPath = path.join(dir, "test.db");
  process.env.ORCHESTRA_DB_PATH = dbPath;
  resetConfig();
  closeDb();
  initDb();
  return dbPath;
}

/** Create an initialized temp git repo and return its path. */
export function tempGitRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "orch-repo-"));
  const g = (args: string[]) => execFileSync("git", args, { cwd: dir });
  g(["init", "-q"]);
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  writeFileSync(path.join(dir, "README.md"), "# test\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "init"]);
  return dir;
}

export function gitLog(repo: string): string[] {
  return execFileSync("git", ["log", "--format=%s"], { cwd: repo, encoding: "utf8" })
    .trim()
    .split("\n")
    .filter(Boolean);
}
