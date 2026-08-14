/**
 * Per-project harness write/exec policy and tools_json validation.
 *
 * Governs whether a role may be granted the sandboxed `write`/`edit` tools
 * (agent.ts's guarded wrappers around pi's write/edit tool factories) or the
 * allowlisted `run_command` tool (PLANNING/overhaul/05) on top of whatever
 * tools it already has. Mirrors router.ts's resolveRouterConfig: a
 * `{ harness: {...} }` sub-key inside projects.config_json, spread over a
 * fixed default — no dedicated DB column.
 *
 * Both capabilities ship OFF (`allowWrite`, `allowExec` default false) and are
 * enforced authoritatively at run time in agent.ts, independent of whatever a
 * role's stored tools_json happens to say.
 */

import { READ_ONLY_TOOLS } from "./roles.js";

/** Custom tool name for read-only git log — mirrors agent.ts's GIT_HISTORY_TOOL
 *  constant. Duplicated rather than imported: agent.ts imports HarnessPolicy /
 *  resolveHarnessPolicy from this module, so importing agent.ts back here
 *  would create a circular module dependency. */
const GIT_HISTORY_TOOL_NAME = "git_history";

/** The two guarded write-capable tool names this feature adds. These are
 *  never added to the plain pi builtin tool allowlist (see agent.ts) — only
 *  ever registered as custom, worktree-jailed tools when a role requests
 *  them AND the resolved project policy allows it. */
export const WRITE_TOOL_NAMES = ["write", "edit"] as const;

/** Custom tool name for the allowlisted command runner (PLANNING/overhaul/05).
 *  Like write/edit this is never a pi builtin — it is registered as a custom,
 *  worktree-jailed tool only when the project policy allows it. */
export const EXEC_TOOL_NAME = "run_command";

/** Every tool name a role's tools_json may legally contain. */
export const ALL_KNOWN_TOOL_NAMES: readonly string[] = [
  ...READ_ONLY_TOOLS,
  GIT_HISTORY_TOOL_NAME,
  ...WRITE_TOOL_NAMES,
  EXEC_TOOL_NAME,
];

/**
 * One pre-approved command a role may invoke by NAME. The model never supplies
 * a command line: it picks `name` from the project's menu and the fixed `argv`
 * behind it is what runs (see exec.ts). Extra arguments are opt-in per command
 * and regex-validated before being appended — never interpolated.
 */
export interface ExecCommand {
  /** What the model invokes: run_command({ name: "test" }). */
  name: string;
  /** The actual command, fixed: ["npm","test"] / ["npx","tsc","--noEmit"]. */
  argv: string[];
  /** Whether extra args may be appended (e.g. a test-file filter). */
  allowArgs?: boolean;
  /** Regex the appended args must match; defaults to exec.ts's
   *  EXEC_ARG_DEFAULT_PATTERN. A malformed pattern denies, never falls open. */
  argPattern?: string;
  /** Per-command timeout override, for a suite that is legitimately slow. */
  timeoutMs?: number;
  /** Shown to the model alongside the name so it picks the right one. */
  description?: string;
}

export interface HarnessPolicy {
  /** Master switch for this project: may any role's tools_json contain
   *  "write"/"edit"? Default false — existing projects get zero behavior
   *  change until an admin opts in. */
  allowWrite: boolean;
  /** Reserved for a future path allow/deny-glob refinement inside the
   *  worktree; not enforced beyond the worktree-root + .git jail (see
   *  git.ts's assertInsideWorktree). Kept in the shape now so config_json
   *  doesn't need a second migration later. */
  denyGlobs?: string[];
  /** Master switch for `run_command` — same opt-in posture as allowWrite, and
   *  a strictly bigger trust decision: an executed command runs arbitrary
   *  project code with the daemon's OS privileges (the worktree is a jail for
   *  the agent's *file writes*, not a sandbox for a spawned process). */
  allowExec: boolean;
  /** The named, pre-approved command menu. An empty menu means `run_command`
   *  is never registered even when allowExec is on — there is nothing to run. */
  execAllowlist: ExecCommand[];
  /** Default per-command hard timeout (ms). */
  execTimeoutMs?: number;
  /** Cap on combined stdout+stderr retained per execution, head+tail. */
  execMaxOutputBytes?: number;
  /** Cap on executions per role run — bounds a small model looping on `test`. */
  execMaxRuns?: number;
  /** Extra environment variables for executed commands, on top of exec.ts's
   *  minimal passthrough allowlist (e.g. { "NODE_ENV": "test" }). */
  execEnv?: Record<string, string>;
  /**
   * Which role keys, if any, may have a stored secret (the project's GitHub
   * PAT) resolved into their run context (PLANNING/overhaul-2/02 §2).
   *
   * A documented NO-OP today, and deliberately so. No role currently receives a
   * secret: the PAT is used server-side, by github.ts, for pushes and PRs a
   * human triggers — it is never handed to a model. Today's default is
   * therefore "no role sees secrets", and this field exists to make that
   * enforced-and-explicit rather than incidental, so the day a role gains its
   * own push capability the grant has to be written down here rather than
   * inherited by accident. An empty array (the default) means no role.
   */
  secretScope?: string[];
}

export const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
export const DEFAULT_EXEC_MAX_OUTPUT_BYTES = 64 * 1024;
export const DEFAULT_EXEC_MAX_RUNS = 5;

export const DEFAULT_HARNESS_POLICY: HarnessPolicy = {
  allowWrite: false,
  denyGlobs: [],
  allowExec: false,
  execAllowlist: [],
  execTimeoutMs: DEFAULT_EXEC_TIMEOUT_MS,
  execMaxOutputBytes: DEFAULT_EXEC_MAX_OUTPUT_BYTES,
  execMaxRuns: DEFAULT_EXEC_MAX_RUNS,
  secretScope: [],
};

/** Clamp a numeric policy knob to a sane range, falling back to the default for
 *  anything missing or nonsensical (a hand-edited config_json must not be able
 *  to set a 10-hour timeout or a zero-byte output cap). */
function clampNumber(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * Drop anything in a stored `execAllowlist` that isn't a usable command. This
 * runs on every resolve (not just on save) so a config_json edited by hand, by
 * an older version, or by the generic project PATCH can never present the
 * executor with a malformed entry — the invalid entry simply doesn't exist as
 * far as the model's menu is concerned.
 */
export function sanitizeExecAllowlist(raw: unknown): ExecCommand[] {
  if (!Array.isArray(raw)) return [];
  const out: ExecCommand[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    const name = typeof c.name === "string" ? c.name.trim() : "";
    if (!name || seen.has(name)) continue;
    if (!Array.isArray(c.argv)) continue;
    const argv = c.argv.filter((a): a is string => typeof a === "string" && a.length > 0);
    if (!argv.length) continue;
    seen.add(name);
    out.push({
      name,
      argv,
      allowArgs: c.allowArgs === true,
      argPattern: typeof c.argPattern === "string" && c.argPattern ? c.argPattern : undefined,
      timeoutMs:
        c.timeoutMs == null ? undefined : clampNumber(c.timeoutMs, DEFAULT_EXEC_TIMEOUT_MS, 1_000, 3_600_000),
      description: typeof c.description === "string" ? c.description : undefined,
    });
  }
  return out;
}

/** Keep only well-formed string→string env extras. */
function sanitizeExecEnv(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Resolve harness policy from a project's config_json `{ harness: {...} }`
 *  sub-key, spread over the default — mirrors router.ts's
 *  resolveRouterConfig(), plus normalization of the exec sub-shape (which,
 *  unlike a plain boolean, has structure a bad edit could corrupt). */
export function resolveHarnessPolicy(projectConfigJson: string | null): HarnessPolicy {
  if (!projectConfigJson) return { ...DEFAULT_HARNESS_POLICY };
  let harness: Partial<HarnessPolicy> = {};
  try {
    const parsed = JSON.parse(projectConfigJson) as { harness?: Partial<HarnessPolicy> };
    harness = parsed.harness ?? {};
  } catch {
    return { ...DEFAULT_HARNESS_POLICY };
  }
  return {
    ...DEFAULT_HARNESS_POLICY,
    ...harness,
    allowWrite: harness.allowWrite === true,
    allowExec: harness.allowExec === true,
    execAllowlist: sanitizeExecAllowlist(harness.execAllowlist),
    execTimeoutMs: clampNumber(harness.execTimeoutMs, DEFAULT_EXEC_TIMEOUT_MS, 1_000, 3_600_000),
    execMaxOutputBytes: clampNumber(
      harness.execMaxOutputBytes,
      DEFAULT_EXEC_MAX_OUTPUT_BYTES,
      1_024,
      1_048_576,
    ),
    execMaxRuns: clampNumber(harness.execMaxRuns, DEFAULT_EXEC_MAX_RUNS, 1, 50),
    execEnv: sanitizeExecEnv(harness.execEnv),
    secretScope: sanitizeSecretScope(harness.secretScope),
  };
}

/** Anything that isn't a list of non-empty role keys reads as "no role" — the
 *  safe direction for a field that grants credential access. */
function sanitizeSecretScope(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) out.add(item.trim());
  }
  return [...out];
}

/**
 * Whether a role may have the project's stored secrets resolved into its run
 * context (PLANNING/overhaul-2/02 §2).
 *
 * Always false in this build: nothing calls it with a role that's in scope,
 * because nothing puts a secret into a run context at all. It exists so that
 * the "no role sees secrets" default is a checked rule rather than an
 * unwritten one — a future role that can push on its own has to come through
 * here, not around it.
 */
export function roleMaySeeSecrets(policy: HarnessPolicy, roleKey: string): boolean {
  return (policy.secretScope ?? []).includes(roleKey);
}

export type ExecAllowlistValidation =
  | { ok: true; commands: ExecCommand[] }
  | { ok: false; error: string };

/**
 * Save-time validation of an exec allowlist. Unlike {@link sanitizeExecAllowlist}
 * — which silently drops junk so a corrupt config_json degrades safely at read
 * time — this REPORTS the problem, so someone editing the menu in the UI finds
 * out why their entry vanished instead of wondering.
 */
export function validateExecAllowlist(raw: unknown): ExecAllowlistValidation {
  if (!Array.isArray(raw)) return { ok: false, error: "execAllowlist must be an array" };
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: "each exec command must be an object" };
    }
    const c = item as Record<string, unknown>;
    const name = typeof c.name === "string" ? c.name.trim() : "";
    if (!name) return { ok: false, error: "each exec command needs a non-empty name" };
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
      return {
        ok: false,
        error: `invalid command name "${name}" — use letters, digits, "-" and "_" (starting with a letter)`,
      };
    }
    if (seen.has(name)) return { ok: false, error: `duplicate command name "${name}"` };
    seen.add(name);
    if (!Array.isArray(c.argv) || !c.argv.length || !c.argv.every((a) => typeof a === "string" && a)) {
      return { ok: false, error: `command "${name}" needs a non-empty argv array of strings` };
    }
    if (c.argPattern != null) {
      if (typeof c.argPattern !== "string") {
        return { ok: false, error: `command "${name}": argPattern must be a string` };
      }
      try {
        new RegExp(c.argPattern);
      } catch (err) {
        return { ok: false, error: `command "${name}": argPattern is not a valid regex (${(err as Error).message})` };
      }
    }
  }
  // Normalize through the same reader the runtime uses, so what is stored is
  // exactly what will later be resolved — no save-time/read-time drift.
  return { ok: true, commands: sanitizeExecAllowlist(raw) };
}

/** Whether `run_command` should actually be registered for a run: the switch is
 *  on AND there is a non-empty menu to choose from. Shared by agent.ts (the
 *  authoritative registration gate) and the UI/API surfaces that describe
 *  posture, so "enabled" means the same thing everywhere. */
export function execEnabled(policy: HarnessPolicy): boolean {
  return policy.allowExec && (policy.execAllowlist?.length ?? 0) > 0;
}

/** Look up an approved command by name (exact match). */
export function findExecCommand(policy: HarnessPolicy, name: string): ExecCommand | undefined {
  return (policy.execAllowlist ?? []).find((c) => c.name === name);
}

export type ToolsValidation = { ok: true; tools: string[] } | { ok: false; error: string };

/**
 * Shared validator for role.tools_json. Used at save time by the roles PUT
 * route (server/src/routes/api.ts); the authoritative enforcement still
 * happens independently at run time in agent.ts's runRole(), so a row
 * written before this validator existed (or edited directly in the DB)
 * can never grant write/edit unless the *current* policy also allows it.
 */
export function validateToolsJson(raw: string, policy: HarnessPolicy): ToolsValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "tools_json is not valid JSON" };
  }
  if (!Array.isArray(parsed) || !parsed.every((t) => typeof t === "string")) {
    return { ok: false, error: "tools_json must be a JSON array of strings" };
  }
  const tools = parsed as string[];
  const unknown = tools.filter((t) => !ALL_KNOWN_TOOL_NAMES.includes(t));
  if (unknown.length) {
    return { ok: false, error: `unknown tool(s): ${unknown.join(", ")}` };
  }
  const wantsWrite = tools.some((t) => (WRITE_TOOL_NAMES as readonly string[]).includes(t));
  if (wantsWrite && !policy.allowWrite) {
    return {
      ok: false,
      error: `this project's harness policy does not allow write/edit tools — enable "allowWrite" first`,
    };
  }
  if (tools.includes(EXEC_TOOL_NAME) && !policy.allowExec) {
    return {
      ok: false,
      error: `this project's harness policy does not allow the ${EXEC_TOOL_NAME} tool — enable "allowExec" first`,
    };
  }
  if (tools.includes(EXEC_TOOL_NAME) && !policy.execAllowlist?.length) {
    return {
      ok: false,
      error: `this project has no approved commands configured — add at least one to the exec allowlist before granting ${EXEC_TOOL_NAME}`,
    };
  }
  return { ok: true, tools };
}
