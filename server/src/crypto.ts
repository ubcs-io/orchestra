/**
 * Encryption at rest for the two secrets Orchestra actually stores
 * (PLANNING/overhaul-2/02): a project's GitHub PAT and a connection profile's
 * LLM API key.
 *
 * Both were plain TEXT columns, masked only on the API response path — which is
 * response hygiene, not storage security. Anyone who could read `orchestra.db`
 * (a backup, a synced folder, a `sqlite3` one-liner) got every credential in
 * plaintext. This module makes the stored form `enc:<iv>:<tag>:<ciphertext>`,
 * AES-256-GCM via Node's built-in `crypto` — no new dependency.
 *
 * What this does and does not buy you, stated plainly: the DB file is no longer
 * self-describing, but the key sits next to it under the same trust tier as
 * `config.json`. This defends against the database leaving the machine, not
 * against someone who is already on it as this user.
 *
 * Deliberately scoped to the two secrets that exist today rather than built out
 * into a general secrets manager — extend it when a third secret type shows up,
 * not before.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(SERVER_DIR, "..");

/** Marker on a stored value that has been through {@link encryptSecret}. Its
 *  absence is what the read path uses to spot a pre-encryption row. */
export const ENC_PREFIX = "enc:";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

/** Where a generated key is persisted when `ORCHESTRA_SECRET_KEY` is unset.
 *  Same directory and trust tier as `config.json`; must be gitignored. */
export const SECRET_KEY_FILE = path.join(REPO_ROOT, "secret.key");

let cachedKey: Buffer | undefined;

/**
 * The instance encryption key: `ORCHESTRA_SECRET_KEY` (hex or base64) if set,
 * otherwise a key generated once and persisted to {@link SECRET_KEY_FILE}.
 *
 * Losing this key means losing access to every stored secret — the tokens
 * become unreadable and have to be re-entered. That is an acceptable trade for
 * a locally-run companion (re-pasting a PAT is cheap), but it is a real one, so
 * it is documented at every level: here, in the README, and in the safety
 * panel. Never silent.
 */
export function getSecretKey(): Buffer {
  if (cachedKey) return cachedKey;

  const fromEnv = process.env.ORCHESTRA_SECRET_KEY?.trim();
  if (fromEnv) {
    const decoded = decodeKey(fromEnv);
    if (!decoded) {
      throw new Error(
        `ORCHESTRA_SECRET_KEY must be ${KEY_BYTES} bytes encoded as hex (64 chars) or base64 — refusing to run with a malformed key rather than silently generating a different one`,
      );
    }
    cachedKey = decoded;
    return cachedKey;
  }

  if (fs.existsSync(SECRET_KEY_FILE)) {
    const decoded = decodeKey(fs.readFileSync(SECRET_KEY_FILE, "utf8").trim());
    if (decoded) {
      cachedKey = decoded;
      return cachedKey;
    }
    // A corrupt key file is not something to paper over by generating a new
    // one — that would quietly orphan every secret already encrypted with the
    // old key. Say so instead.
    throw new Error(
      `${SECRET_KEY_FILE} does not contain a valid ${KEY_BYTES}-byte key. Fix or remove it (removing it means re-entering any stored GitHub token / API key).`,
    );
  }

  const generated = crypto.randomBytes(KEY_BYTES);
  // 0600: the key is only ever read by this process, as this user.
  fs.writeFileSync(SECRET_KEY_FILE, generated.toString("hex"), { mode: 0o600 });
  cachedKey = generated;
  return cachedKey;
}

function decodeKey(raw: string): Buffer | undefined {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  try {
    const buf = Buffer.from(raw, "base64");
    if (buf.length === KEY_BYTES) return buf;
  } catch {
    /* fall through */
  }
  return undefined;
}

/** Test/CLI seam: drop the memoized key so a later call re-reads env/file. */
export function resetSecretKey(): void {
  cachedKey = undefined;
}

/** Whether a stored value is already in the encrypted form. The idempotence
 *  guard for the migration pass — encrypting an `enc:` value a second time
 *  would make it permanently unreadable. */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(ENC_PREFIX);
}

/** Encrypt a plaintext secret. An empty/absent value is passed through
 *  untouched: "no token set" must stay distinguishable from "a token that
 *  happens to encrypt to something", including for the `has_github_token`
 *  style presence checks that read the column's truthiness. */
export function encryptSecret(plain: string | null | undefined, key: Buffer = getSecretKey()): string | null {
  if (plain == null || plain === "") return plain ?? null;
  if (isEncrypted(plain)) return plain;
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

/**
 * Decrypt a stored secret back to plaintext.
 *
 * Returns `null` when the value can't be decrypted — a wrong key, a truncated
 * row, or a tampered ciphertext (GCM's auth tag catches that last one). It
 * never throws, because every caller sits on a path where the honest failure
 * mode is "this token needs re-entering", not "the daemon won't boot".
 *
 * A value with no `enc:` prefix is returned as-is: that's a row written before
 * this feature, and it stays usable until the migration pass rewrites it.
 */
export function decryptSecret(stored: string | null | undefined, key: Buffer = getSecretKey()): string | null {
  if (stored == null || stored === "") return null;
  if (!isEncrypted(stored)) return stored;
  const parts = stored.slice(ENC_PREFIX.length).split(":");
  if (parts.length !== 3) return null;
  const [ivB64, tagB64, dataB64] = parts as [string, string, string];
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}
