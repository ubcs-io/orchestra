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
import { getGlobalConfig, getMeta, listRoles, setMeta } from "../db.js";
import { resolveConnection } from "../settings.js";
import { getConfig } from "../config.js";

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

    return {
      agent_tools: {
        mode: "read_only",
        write_scope: "PLANNING/ only (sandboxed artifact writes via write_artifact tool)",
        shell_access: false,
        cross_repo_access: false,
        source_code_writes: false,
        git_history_available: gitHistoryCount > 0,
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
}