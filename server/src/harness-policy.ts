/**
 * Per-project harness write policy and tools_json validation.
 *
 * Governs whether a role may be granted the sandboxed `write`/`edit` tools
 * (agent.ts's guarded wrappers around pi's write/edit tool factories) on top
 * of whatever tools it already has. Mirrors router.ts's resolveRouterConfig:
 * a `{ harness: {...} }` sub-key inside projects.config_json, spread over a
 * fixed default — no dedicated DB column.
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

/** Every tool name a role's tools_json may legally contain. */
export const ALL_KNOWN_TOOL_NAMES: readonly string[] = [
  ...READ_ONLY_TOOLS,
  GIT_HISTORY_TOOL_NAME,
  ...WRITE_TOOL_NAMES,
];

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
}

export const DEFAULT_HARNESS_POLICY: HarnessPolicy = { allowWrite: false, denyGlobs: [] };

/** Resolve harness policy from a project's config_json `{ harness: {...} }`
 *  sub-key, spread over the default — exact mirror of router.ts's
 *  resolveRouterConfig(). */
export function resolveHarnessPolicy(projectConfigJson: string | null): HarnessPolicy {
  if (!projectConfigJson) return { ...DEFAULT_HARNESS_POLICY };
  try {
    const parsed = JSON.parse(projectConfigJson) as { harness?: Partial<HarnessPolicy> };
    return { ...DEFAULT_HARNESS_POLICY, ...parsed.harness };
  } catch {
    return { ...DEFAULT_HARNESS_POLICY };
  }
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
  return { ok: true, tools };
}
