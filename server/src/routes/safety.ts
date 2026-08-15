/**
 * Safety / pi dev controls API.
 *
 * GET  /api/safety  — read-only snapshot of agent boundaries, limits, gates,
 *                     role summary, and security posture.
 * PATCH /api/safety — edit a few mutable controls (currently role_tool_budget).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  CONCERN_TAXONOMY,
  FLOW_TEMPLATES,
  DEFAULT_ROLES,
  READ_ONLY_TOOLS,
  READ_ONLY_TOOLS_WITH_GIT,
} from "../roles.js";
import { getGlobalConfig, getMeta, getProject, listProjects, listRoles, setMeta, updateProject } from "../db.js";
import { resolveConnection } from "../settings.js";
import { getConfig } from "../config.js";
import {
  DEFAULT_HARNESS_POLICY,
  EXEC_TOOL_NAME,
  WRITE_TOOL_NAMES,
  execEnabled,
  resolveHarnessPolicy,
} from "../harness-policy.js";
import { DEFAULT_BUDGET_POLICY, budgetEnforced, evaluateProjectBudget } from "../budget-policy.js";
import { SECRET_KEY_FILE } from "../crypto.js";

function resolveRoleToolBudget(): number {
  const meta = getMeta("safety.role_tool_budget");
  if (meta) {
    const v = Number(meta);
    if (Number.isFinite(v) && v > 0) return Math.floor(v);
  }
  return getConfig().roleToolBudget;
}

function bad(reply: FastifyReply, code: number, message: string) {
  return reply.code(code).send({ error: message });
}

export async function safetyRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/safety", async () => {
    const cfg = getConfig();
    const conn = resolveConnection();
    const globalRoles = listRoles(null);
    const globalConfig = getGlobalConfig();

    // Tool access classification.
    const readOnlySet = new Set<string>(READ_ONLY_TOOLS);
    const readOnlyWithGitSet = new Set<string>(READ_ONLY_TOOLS_WITH_GIT);

    let readOnlyCount = 0;
    let gitHistoryCount = 0;
    let contextOnlyCount = 0;
    let disabledCount = 0;

    for (const role of globalRoles) {
      if (!role.enabled) {
        disabledCount++;
        continue;
      }
      const tools: string[] = role.tools_json ? (JSON.parse(role.tools_json) as string[]) : [];

      if (tools.length === 0) {
        contextOnlyCount++;
        continue;
      }

      const hasGit = tools.includes("git_history");
      const hasReadOnly = tools.some((t) => readOnlySet.has(t));
      const hasReadWithGit = tools.some((t) => readOnlyWithGitSet.has(t));

      if (hasGit || hasReadWithGit) {
        gitHistoryCount++;
      } else if (hasReadOnly) {
        readOnlyCount++;
      } else {
        contextOnlyCount++;
      }
    }

    // Per-flow gate info.
    const gates: Record<string, { maxLoopbacks: number; reviewerRole: string; rigor: string }> = {};
    for (const [k, flow] of Object.entries(FLOW_TEMPLATES)) {
      gates[k] = {
        maxLoopbacks: flow.maxLoopbacks,
        reviewerRole: flow.reviewerRole,
        rigor: flow.rigor,
      };
    }

    // Per-project harness policy + live write/edit grants — unlike roles_summary
    // above (a global-catalog-shape summary), this inspects each project's own
    // merged roles (listRoles(p.id): globals overridden by that project's rows),
    // since a project can grant write/edit via a role override without ever
    // touching the global catalog.
    const writeToolSet = new Set<string>(WRITE_TOOL_NAMES);
    let projectsWithWrite = 0;
    let projectsWithExec = 0;
    let projectsWithBudget = 0;
    const budgetSummaries: Array<Record<string, unknown>> = [];
    const projectSummaries = listProjects().map((p) => {
      const policy = resolveHarnessPolicy(p.config_json);
      const projectRoles = listRoles(p.id).filter((r) => r.enabled && r.tools_json);
      const roleTools = (r: (typeof projectRoles)[number]): string[] => {
        try {
          return JSON.parse(r.tools_json!) as string[];
        } catch {
          return [];
        }
      };
      const rolesWithWrite = projectRoles
        .filter((r) => roleTools(r).some((t) => writeToolSet.has(t)))
        .map((r) => r.key);
      // A live exec grant needs BOTH halves — the policy switch with a non-empty
      // command menu, and a role that actually asked for the tool. Reporting the
      // conjunction (rather than the switch alone) is what keeps this panel an
      // honest answer to "can this thing run commands right now?".
      const rolesWithExec = execEnabled(policy)
        ? projectRoles.filter((r) => roleTools(r).includes(EXEC_TOOL_NAME)).map((r) => r.key)
        : [];
      if (rolesWithWrite.length > 0) projectsWithWrite++;
      if (rolesWithExec.length > 0) projectsWithExec++;

      // Spend ceiling (PLANNING/overhaul-2/01). Reported alongside the harness
      // policy because it answers the same operator question — what stops this
      // thing? — and with the same honesty rule: `enforced` is the conjunction
      // (switch on AND a cap set), and a partial dollar figure is labelled
      // as the floor it is rather than presented as a total.
      const budget = evaluateProjectBudget(p);
      if (budgetEnforced(budget.policy)) projectsWithBudget++;
      budgetSummaries.push({
        id: p.id,
        name: p.name,
        enabled: budget.policy.enabled,
        enforced: budget.enforced,
        period_days: budget.policy.periodDays,
        cap_tokens: budget.policy.capTokens ?? null,
        cap_usd: budget.policy.capUsd ?? null,
        warn_threshold_pct: budget.policy.warnThresholdPct,
        override_minutes: budget.policy.overrideMinutes,
        spent_tokens: budget.spend.tokens,
        spent_usd: budget.spend.usd,
        spent_usd_is_partial: budget.spend.usdIsPartial,
        unpriced_tokens: budget.spend.unpricedTokens,
        usage_pct: budget.usagePct,
        over_cap: budget.overCap,
        breached: budget.breached,
      });

      return {
        id: p.id,
        name: p.name,
        allow_write: policy.allowWrite,
        roles_with_write: rolesWithWrite,
        allow_exec: policy.allowExec,
        exec_commands: (policy.execAllowlist ?? []).map((c) => ({ name: c.name, argv: c.argv })),
        roles_with_exec: rolesWithExec,
      };
    });

    return {
      agent_tools: {
        mode: projectsWithWrite > 0 ? "mixed" : "read_only",
        write_scope:
          projectsWithWrite > 0
            ? "PLANNING/ (always, via write_artifact) plus source files inside the task's git worktree for roles granted write/edit"
            : "PLANNING/ only (sandboxed artifact writes via write_artifact tool)",
        // Not a shell — `run_command` (PLANNING/overhaul/05) executes fixed,
        // pre-approved argv with no shell interpretation. But it does run
        // project code with this process's privileges, so anything short of
        // saying so plainly here would be misleading.
        shell_access: false,
        command_execution: projectsWithExec > 0,
        command_execution_note:
          projectsWithExec > 0
            ? "allowlisted commands only (fixed argv, no shell), inside the task worktree, with a scrubbed environment — but executing project code runs it with this daemon's OS privileges"
            : "no project has approved command execution",
        cross_repo_access: false,
        source_code_writes: projectsWithWrite > 0,
        git_history_available: gitHistoryCount > 0,
        worktree_jail: true,
      },
      harness_policy: {
        global_default: DEFAULT_HARNESS_POLICY,
        projects: projectSummaries,
      },
      budget_policy: {
        global_default: DEFAULT_BUDGET_POLICY,
        projects_enforced: projectsWithBudget,
        // What the dollar column rests on, stated once rather than implied:
        // role_runs records one combined token count, so converting it to
        // dollars assumes a split (see db.ts's ASSUMED_OUTPUT_FRACTION).
        usd_note:
          "dollar figures are estimates — token counts are combined input+output, priced with an assumed 15% output share, and runs on models with no configured price contribute nothing (spent_usd_is_partial)",
        projects: budgetSummaries,
      },
      limits: {
        role_tool_budget: resolveRoleToolBudget(),
        request_timeout_ms: conn.requestTimeoutMs,
        max_tokens: conn.maxTokens,
        context_window: conn.contextWindow,
      },
      gates,
      roles_summary: {
        total_roles: DEFAULT_ROLES.length,
        read_only_count: readOnlyCount,
        git_history_count: gitHistoryCount,
        context_only_count: contextOnlyCount,
        disabled_count: disabledCount,
      },
      server: {
        bind_address: cfg.host,
        port: cfg.port,
        auth_enabled: false,
        trust_boundary: "tailnet (no built-in auth — the tailnet IS the trust boundary)",
      },
      storage: {
        db_path: cfg.dbPath,
        api_key_in_db: !!(globalConfig?.api_key?.length),
        api_key_in_env: !!process.env.ORCHESTRA_API_KEY,
        /** PLANNING/overhaul-2/02: the two secret columns are AES-256-GCM at
         *  rest, so the DB file no longer reads as plaintext credentials. */
        secrets_encrypted_at_rest: true,
      },
      secrets: {
        // Which projects have a token set, and when the row was last written —
        // rotation visibility without ever moving the value itself. The token
        // is never in this payload; only its presence and age.
        projects: listProjects().map((p) => ({
          id: p.id,
          name: p.name,
          has_github_token: !!p.github_token,
          last_updated_at: p.updated_at,
        })),
        /** Where the instance key comes from. Named because losing it means
         *  re-entering every stored secret — a cheap loss, but never a silent
         *  one. */
        key_source: process.env.ORCHESTRA_SECRET_KEY ? "ORCHESTRA_SECRET_KEY (env)" : SECRET_KEY_FILE,
        key_loss_note:
          "losing this key makes stored tokens unreadable — they must be re-entered (nothing else breaks)",
        // The scope field ships as a documented no-op: no role receives a
        // secret today. Reported so the panel says so rather than staying
        // silent about a capability that doesn't exist yet.
        roles_with_secret_access: listProjects().flatMap((p) =>
          (resolveHarnessPolicy(p.config_json).secretScope ?? []).map((role) => ({ project_id: p.id, role })),
        ),
      },
      concerns: CONCERN_TAXONOMY.slice(),
    };
  });

  app.patch("/api/safety", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as {
      role_tool_budget?: number;
    };

    const changes: string[] = [];

    if (body.role_tool_budget !== undefined) {
      const v = Number(body.role_tool_budget);
      if (!Number.isFinite(v) || v < 1) {
        return bad(reply, 400, "role_tool_budget must be a positive integer");
      }
      setMeta("safety.role_tool_budget", String(Math.floor(v)));
      changes.push(`role_tool_budget → ${Math.floor(v)}`);
    }

    if (changes.length === 0) {
      return bad(reply, 400, "no mutable safety fields provided");
    }

    return { ok: true, changes };
  });

  /**
   * Revoke a project's stored GitHub token (PLANNING/overhaul-2/02 §3).
   *
   * Lives on the safety surface, next to the readout that shows the token
   * exists, because "I can see it's set" and "I can get rid of it" belong in
   * one place. Clearing here only removes Orchestra's copy — the PAT itself is
   * still live on GitHub until it's revoked there, which the response says
   * rather than leaving the operator to assume otherwise.
   */
  app.delete("/api/safety/secrets/github/:projectId", async (req: FastifyRequest, reply: FastifyReply) => {
    const projectId = Number((req.params as { projectId: string }).projectId);
    const project = getProject(projectId);
    if (!project) return bad(reply, 404, "project not found");
    updateProject(projectId, { github_token: null });
    return {
      ok: true,
      project_id: projectId,
      note: "Orchestra's copy is gone. The token is still valid on GitHub until you revoke it there.",
    };
  });
}