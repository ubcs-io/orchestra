/**
 * Secrets hardening (PLANNING/overhaul-2/02) — the cipher itself, the
 * transparent encrypt-on-write/decrypt-on-read wrapping of the two secret
 * columns, and the migration that upgrades rows written before any of this
 * existed.
 */

import crypto from "node:crypto";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { resetConfig } from "../src/config";
import {
  ENC_PREFIX,
  decryptSecret,
  encryptSecret,
  isEncrypted,
  resetSecretKey,
} from "../src/crypto";
import {
  closeDb,
  createModelConfig,
  createProject,
  getConfigById,
  getDb,
  getGlobalConfig,
  getProject,
  initDb,
  listModelConfigs,
  listProjects,
  updateModelConfig,
  updateProject,
  upsertConfig,
} from "../src/db";
import { resolveGithubToken } from "../src/github";
import { resolveHarnessPolicy, roleMaySeeSecrets } from "../src/harness-policy";
import { freshDb } from "./helpers";

afterEach(() => closeDb());

const KEY = crypto.randomBytes(32);

describe("encryptSecret / decryptSecret", () => {
  it("round-trips and produces a distinguishable stored form", () => {
    const enc = encryptSecret("ghp_supersecret", KEY)!;
    expect(enc.startsWith(ENC_PREFIX)).toBe(true);
    expect(enc).not.toContain("ghp_supersecret");
    expect(decryptSecret(enc, KEY)).toBe("ghp_supersecret");
  });

  it("uses a fresh IV, so the same secret never encrypts to the same blob twice", () => {
    expect(encryptSecret("same", KEY)).not.toBe(encryptSecret("same", KEY));
  });

  it("rejects a tampered ciphertext rather than returning garbage", () => {
    const enc = encryptSecret("ghp_supersecret", KEY)!;
    const [prefixed, tag, data] = enc.split(":") as [string, string, string];
    void prefixed;
    // Flip a byte in the payload; GCM's auth tag must catch it.
    const bytes = Buffer.from(data, "base64");
    bytes[0] = bytes[0]! ^ 0xff;
    const tampered = `${ENC_PREFIX}${enc.split(":")[1]}:${tag}:${bytes.toString("base64")}`;
    expect(decryptSecret(tampered, KEY)).toBeNull();
  });

  it("returns null rather than throwing on a wrong key or a malformed blob", () => {
    const enc = encryptSecret("ghp_supersecret", KEY)!;
    expect(decryptSecret(enc, crypto.randomBytes(32))).toBeNull();
    expect(decryptSecret(`${ENC_PREFIX}nonsense`, KEY)).toBeNull();
    expect(decryptSecret(`${ENC_PREFIX}a:b:c`, KEY)).toBeNull();
  });

  it("is idempotent — encrypting an already-encrypted value is a no-op", () => {
    const once = encryptSecret("ghp_x", KEY)!;
    expect(encryptSecret(once, KEY)).toBe(once);
    // The guard that matters: a double-encrypt would be unrecoverable.
    expect(decryptSecret(encryptSecret(once, KEY), KEY)).toBe("ghp_x");
  });

  it("passes empty/absent values through, so 'no token set' stays detectable", () => {
    expect(encryptSecret(null, KEY)).toBeNull();
    expect(encryptSecret("", KEY)).toBe("");
    expect(decryptSecret(null, KEY)).toBeNull();
    expect(decryptSecret("", KEY)).toBeNull();
  });

  it("leaves a legacy plaintext value readable until it's migrated", () => {
    expect(isEncrypted("ghp_plaintext")).toBe(false);
    expect(decryptSecret("ghp_plaintext", KEY)).toBe("ghp_plaintext");
  });
});

/** Read the column straight out of SQLite, bypassing db.ts's accessors — the
 *  only way to assert what actually landed on disk. */
function rawColumn(table: string, column: string, id: number): string | null {
  const row = getDb().prepare(`SELECT ${column} AS v FROM ${table} WHERE id = ?`).get(id) as { v: string | null };
  return row.v;
}

describe("secret columns at rest", () => {
  it("stores a project's GitHub token encrypted and hands it back decrypted", () => {
    freshDb();
    const project = createProject({ name: "p", repo_path: "/tmp/p" });
    updateProject(project.id, { github_token: "ghp_realtoken" });

    expect(rawColumn("projects", "github_token", project.id)).toMatch(/^enc:/);
    expect(rawColumn("projects", "github_token", project.id)).not.toContain("ghp_realtoken");
    expect(getProject(project.id)!.github_token).toBe("ghp_realtoken");
    expect(listProjects()[0]!.github_token).toBe("ghp_realtoken");
    // The consumer that actually uses it gets a usable token, not a blob.
    expect(resolveGithubToken(getProject(project.id)!)).toBe("ghp_realtoken");
  });

  it("stores a config's api_key encrypted through every write path", () => {
    freshDb();
    upsertConfig({ project_id: null, key: "default", api_key: "sk-global" });
    const global = getGlobalConfig()!;
    expect(rawColumn("configs", "api_key", global.id)).toMatch(/^enc:/);
    expect(global.api_key).toBe("sk-global");

    const created = createModelConfig({ name: "m", default_model: "x", api_key: "sk-created" });
    expect(rawColumn("configs", "api_key", created.id)).toMatch(/^enc:/);
    expect(created.api_key).toBe("sk-created");
    expect(getConfigById(created.id)!.api_key).toBe("sk-created");
    expect(listModelConfigs().find((c) => c.id === created.id)!.api_key).toBe("sk-created");

    const updated = updateModelConfig(created.id, { name: "m2" });
    // An update that doesn't mention api_key must preserve it — and must not
    // have double-encrypted the value it carried forward.
    expect(rawColumn("configs", "api_key", created.id)).toMatch(/^enc:/);
    expect(updated.api_key).toBe("sk-created");

    const rotated = updateModelConfig(created.id, { api_key: "sk-rotated" });
    expect(rotated.api_key).toBe("sk-rotated");
    expect(rawColumn("configs", "api_key", created.id)).not.toContain("sk-rotated");
  });

  it("keeps 'no token' distinguishable from 'an encrypted empty token'", () => {
    freshDb();
    const project = createProject({ name: "p", repo_path: "/tmp/p" });
    expect(getProject(project.id)!.github_token).toBeNull();
    updateProject(project.id, { github_token: "ghp_x" });
    expect(!!getProject(project.id)!.github_token).toBe(true);
    // Clearing it (the safety panel's revoke action) leaves a falsy column, so
    // has_github_token reads false rather than "an encrypted empty string".
    updateProject(project.id, { github_token: null });
    expect(getProject(project.id)!.github_token).toBeNull();
  });

  it("survives a reopen — nothing depends on in-process state", () => {
    const dbPath = freshDb();
    const project = createProject({ name: "p", repo_path: "/tmp/p" });
    updateProject(project.id, { github_token: "ghp_persisted" });
    closeDb();

    process.env.ORCHESTRA_DB_PATH = dbPath;
    resetConfig();
    initDb();
    expect(getProject(project.id)!.github_token).toBe("ghp_persisted");
  });
});

describe("migration of pre-encryption rows", () => {
  /** Build a DB whose secret columns hold plaintext, exactly as a pre-upgrade
   *  install would have written them. */
  function legacyDbWithPlaintextSecrets(): string {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "orch-secret-"));
    const dbPath = path.join(dir, "legacy.db");

    // Build the full current schema first, then overwrite the two columns with
    // plaintext behind db.ts's back — the state an upgrade actually encounters.
    process.env.ORCHESTRA_DB_PATH = dbPath;
    process.env.ORCHESTRA_SECRET_KEY = "0".repeat(64);
    resetSecretKey();
    resetConfig();
    closeDb();
    initDb();
    const project = createProject({ name: "legacy", repo_path: "/tmp/legacy" });
    upsertConfig({ project_id: null, key: "default", api_key: "placeholder" });
    const configId = getGlobalConfig()!.id;
    getDb().prepare(`UPDATE projects SET github_token = 'ghp_legacy' WHERE id = ?`).run(project.id);
    getDb().prepare(`UPDATE configs SET api_key = 'sk-legacy' WHERE id = ?`).run(configId);
    closeDb();
    return dbPath;
  }

  it("encrypts plaintext secrets in place on first boot, preserving their values", () => {
    const dbPath = legacyDbWithPlaintextSecrets();
    process.env.ORCHESTRA_DB_PATH = dbPath;
    resetConfig();
    initDb();

    const project = listProjects()[0]!;
    expect(rawColumn("projects", "github_token", project.id)).toMatch(/^enc:/);
    expect(project.github_token).toBe("ghp_legacy");
    const global = getGlobalConfig()!;
    expect(rawColumn("configs", "api_key", global.id)).toMatch(/^enc:/);
    expect(global.api_key).toBe("sk-legacy");
  });

  it("is a no-op on a second pass — it never double-encrypts", () => {
    const dbPath = legacyDbWithPlaintextSecrets();
    process.env.ORCHESTRA_DB_PATH = dbPath;
    resetConfig();
    initDb();
    const project = listProjects()[0]!;
    const afterFirst = rawColumn("projects", "github_token", project.id);

    initDb(); // second boot
    expect(rawColumn("projects", "github_token", project.id)).toBe(afterFirst);
    expect(getProject(project.id)!.github_token).toBe("ghp_legacy");
  });

  it("does not take the boot path down when a secret can't be read", () => {
    const dbPath = legacyDbWithPlaintextSecrets();
    process.env.ORCHESTRA_DB_PATH = dbPath;
    resetConfig();
    initDb();
    const projectId = listProjects()[0]!.id;
    closeDb();

    // Boot with a different key: the stored blob is now undecryptable.
    process.env.ORCHESTRA_SECRET_KEY = "1".repeat(64);
    resetSecretKey();
    resetConfig();
    expect(() => initDb()).not.toThrow();
    // The token reads as "not set" (needs re-entering) rather than crashing or
    // handing a caller a corrupt string.
    expect(getProject(projectId)!.github_token).toBeNull();

    process.env.ORCHESTRA_SECRET_KEY = "0".repeat(64);
    resetSecretKey();
  });
});

describe("secretScope (documented no-op)", () => {
  it("defaults to no role, and only a well-formed list grants anything", () => {
    expect(resolveHarnessPolicy(null).secretScope).toEqual([]);
    expect(resolveHarnessPolicy(JSON.stringify({ harness: {} })).secretScope).toEqual([]);
    expect(resolveHarnessPolicy(JSON.stringify({ harness: { secretScope: "developer" } })).secretScope).toEqual([]);
    expect(
      resolveHarnessPolicy(JSON.stringify({ harness: { secretScope: ["developer", "", 7, "developer"] } })).secretScope,
    ).toEqual(["developer"]);
  });

  it("answers false for every role under the shipped default", () => {
    const policy = resolveHarnessPolicy(null);
    for (const role of ["developer", "critic", "explorer"]) {
      expect(roleMaySeeSecrets(policy, role)).toBe(false);
    }
    const scoped = resolveHarnessPolicy(JSON.stringify({ harness: { secretScope: ["developer"] } }));
    expect(roleMaySeeSecrets(scoped, "developer")).toBe(true);
    expect(roleMaySeeSecrets(scoped, "critic")).toBe(false);
  });
});

describe("no route hands back a raw token", () => {
  it("keeps the raw value out of the DB file even while it's usable in-process", () => {
    const dbPath = freshDb();
    const project = createProject({ name: "p", repo_path: "/tmp/p" });
    updateProject(project.id, { github_token: "ghp_never_on_disk" });
    upsertConfig({ project_id: null, key: "default", api_key: "sk_never_on_disk" });
    closeDb();

    // Inspect the file the way an attacker with a copy of it would.
    const raw = new Database(dbPath, { readonly: true });
    const projects = raw.prepare(`SELECT github_token AS v FROM projects`).all() as Array<{ v: string | null }>;
    const configs = raw.prepare(`SELECT api_key AS v FROM configs`).all() as Array<{ v: string | null }>;
    raw.close();

    const stored = [...projects, ...configs].map((r) => r.v ?? "").join("|");
    expect(stored).not.toContain("ghp_never_on_disk");
    expect(stored).not.toContain("sk_never_on_disk");
    expect(stored).toContain(ENC_PREFIX);
  });
});
