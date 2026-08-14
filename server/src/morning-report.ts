/**
 * The morning report (PLANNING/overhaul/08 §4): "what was attempted, what
 * reached READY/merge-review with evidence, what's parked and why, budget
 * consumed, health stats."
 *
 * Doc §4 left the shape open — "a `question`-kind task the companion runs on
 * itself, or a dedicated endpoint". This is the dedicated endpoint, computed
 * **deterministically from what actually happened**, with no LLM involved. That
 * choice is deliberate:
 *
 *   - The report's entire job is to substitute for the human not having been
 *     there. A generated narrative can be wrong about its own night's work, and
 *     a wrong report is worse than no report — it spends the trust the evidence
 *     was meant to earn.
 *   - It costs nothing, so it still renders when the token budget is exhausted,
 *     the endpoint is down, or autonomy is off entirely.
 *
 * The presentation rule from §4 and the [04] interaction is enforced here:
 * "done" means a task that reached a terminal stage **and** whose latest run
 * carries trusted health. Anything else is listed as parked or attempted, never
 * as an accomplishment.
 */

import {
  getOrResetIdleWindowBudget,
  resolveAutonomyConfig,
  type IdleWindowBudgetStatus,
} from "./autonomy.js";
import {
  getTask,
  listCandidates,
  listRoleRunsSince,
  listUnseenWatcherTasks,
  toDbTimestamp,
  type ProjectRow,
  type RoleRunRow,
  type TaskRow,
} from "./db.js";
import { describeEvidence, isGreen, parseEvidence } from "./exec.js";
import { computeRunHealth, isTrustedHealth, runHealthReason, roleRunHealthInput, type RunHealth } from "./health.js";

export interface ReportTaskLine {
  taskId: string;
  name: string;
  stage: string;
  /** "human" or "watcher:<name>". */
  origin: string;
  runs: number;
  /** Health of this task's most recent run in the window. */
  latestHealth: RunHealth;
  /** Verdict of the most recent run in the window. */
  latestVerdict: string | null;
  /** One line per harness-recorded command execution across the window. */
  evidence: string[];
  /** True when every recorded execution exited green. */
  evidenceAllGreen: boolean;
  /** Why this task is parked, for the parked section. */
  reason?: string;
}

export interface MorningReport {
  projectId: number;
  projectName: string;
  windowStart: string;
  windowEnd: string;
  /** Terminal, trusted-health work — the only section that claims success. */
  completed: ReportTaskLine[];
  /** Reached a human-gated stage, or ended on an untrusted run. */
  parked: ReportTaskLine[];
  /** Everything else that moved: still mid-pipeline. */
  inProgress: ReportTaskLine[];
  /** Self-generated tasks the human has not opened yet. */
  unseenCount: number;
  runCount: number;
  tokensUsed: number;
  healthCounts: Record<RunHealth, number>;
  watcherActivity: { watcher: string; queued: number; rejected: number; capped: number; suppressed: number }[];
  budget: IdleWindowBudgetStatus;
}

/** Stages a task can be sitting in when nothing further will happen without a
 *  human — the report's "parked" bucket regardless of run health. */
const HUMAN_GATED_STAGES = new Set(["review", "merge_review", "blocked"]);

function emptyHealthCounts(): Record<RunHealth, number> {
  return { verified: 0, healthy: 0, recovered: 0, degraded: 0, empty: 0 };
}

/** A task row's stage, normalised — a NULL stage (only reachable on a
 *  half-written legacy row) reads as "unknown" rather than crashing the report
 *  a human is relying on to tell them what happened overnight. */
function taskStage(task: TaskRow): string {
  return task.stage || "unknown";
}

function buildTaskLine(task: TaskRow, runs: RoleRunRow[]): ReportTaskLine {
  const latest = runs[runs.length - 1]!;
  const evidence = runs.flatMap((r) => parseEvidence(r.evidence_json));
  return {
    taskId: task.task_id,
    name: task.name || task.task_id.slice(0, 8),
    stage: taskStage(task),
    origin: task.origin ?? "human",
    runs: runs.length,
    latestHealth: computeRunHealth(roleRunHealthInput(latest)),
    latestVerdict: latest.verdict,
    evidence: evidence.map(describeEvidence),
    evidenceAllGreen: evidence.length > 0 && evidence.every(isGreen),
  };
}

/**
 * Roll up everything that happened for one project since `since`. Pure apart
 * from its DB reads — every judgement (done vs parked, trusted vs not) is made
 * here rather than in the renderer or the route, so it can be asserted directly
 * in tests.
 */
export function buildMorningReport(project: ProjectRow, since: Date, now = new Date()): MorningReport {
  const windowStart = since.toISOString();
  const runs = listRoleRunsSince(project.id, windowStart);

  const byTask = new Map<string, RoleRunRow[]>();
  for (const run of runs) {
    const list = byTask.get(run.task_id);
    if (list) list.push(run);
    else byTask.set(run.task_id, [run]);
  }

  const healthCounts = emptyHealthCounts();
  for (const run of runs) healthCounts[computeRunHealth(roleRunHealthInput(run))]++;

  const completed: ReportTaskLine[] = [];
  const parked: ReportTaskLine[] = [];
  const inProgress: ReportTaskLine[] = [];

  for (const [taskId, taskRuns] of byTask) {
    const task = getTask(taskId);
    if (!task) continue; // deleted mid-window
    const line = buildTaskLine(task, taskRuns);

    if (HUMAN_GATED_STAGES.has(line.stage)) {
      line.reason = task.review_reason || "waiting for a human decision";
      parked.push(line);
    } else if (line.stage === "ready") {
      // The [04] presentation rule: terminal is not the same as trustworthy.
      // A task that finished on a degraded/synthesized run is reported as
      // needing a look, never as an accomplishment.
      if (isTrustedHealth(line.latestHealth)) {
        completed.push(line);
      } else {
        line.reason = runHealthReason(roleRunHealthInput(taskRuns[taskRuns.length - 1]!));
        parked.push(line);
      }
    } else {
      inProgress.push(line);
    }
  }

  const watchers = new Map<string, { watcher: string; queued: number; rejected: number; capped: number; suppressed: number }>();
  const windowStartDb = toDbTimestamp(windowStart); // stored rows use a space, not "T"
  for (const c of listCandidates({ projectId: project.id, limit: 200 })) {
    if (c.created_at < windowStartDb) continue;
    const entry = watchers.get(c.watcher) ?? { watcher: c.watcher, queued: 0, rejected: 0, capped: 0, suppressed: 0 };
    if (c.status === "queued") entry.queued++;
    else if (c.status === "rejected") entry.rejected++;
    else if (c.status === "capped") entry.capped++;
    else if (c.status === "suppressed") entry.suppressed++;
    watchers.set(c.watcher, entry);
  }

  return {
    projectId: project.id,
    projectName: project.name,
    windowStart,
    windowEnd: now.toISOString(),
    completed,
    parked,
    inProgress,
    unseenCount: listUnseenWatcherTasks(project.id).length,
    runCount: runs.length,
    tokensUsed: runs.reduce((sum, r) => sum + (r.tokens ?? 0), 0),
    healthCounts,
    watcherActivity: [...watchers.values()].sort((a, b) => a.watcher.localeCompare(b.watcher)),
    budget: getOrResetIdleWindowBudget(project.id, resolveAutonomyConfig(project.config_json)),
  };
}

function taskBullet(line: ReportTaskLine, opts: { withEvidence?: boolean } = {}): string {
  const badge = line.origin.startsWith("watcher:") ? ` _(${line.origin})_` : "";
  const verdict = line.latestVerdict ? ` — verdict \`${line.latestVerdict}\`` : "";
  const head = `- **${line.name}**${badge}${verdict}, ${line.runs} run${line.runs === 1 ? "" : "s"}, health \`${line.latestHealth}\``;
  const reason = line.reason ? `\n  - ${line.reason}` : "";
  if (!opts.withEvidence || !line.evidence.length) return head + reason;
  return `${head}${reason}\n${line.evidence.map((e) => `  - ${e}`).join("\n")}`;
}

/**
 * Render a report as markdown. The completed section leads with evidence
 * because that is the whole reason an unwatched result is reviewable at all —
 * "tests green, recorded by the harness" is a claim a human can check in a
 * second, and it is the only thing separating this from "the 7B model liked it".
 */
export function renderMorningReport(report: MorningReport): string {
  const lines: string[] = [];
  const hours = Math.max(
    1,
    Math.round((Date.parse(report.windowEnd) - Date.parse(report.windowStart)) / 3_600_000),
  );

  lines.push(`# Morning report — ${report.projectName}`);
  lines.push("");
  lines.push(`_Last ${hours}h, ${report.runCount} role run${report.runCount === 1 ? "" : "s"}, ${report.tokensUsed.toLocaleString()} tokens._`);
  lines.push("");

  if (!report.runCount) {
    lines.push("Nothing ran in this window.");
    lines.push("");
  }

  if (report.completed.length) {
    const withEvidence = report.completed.filter((c) => c.evidenceAllGreen).length;
    lines.push(`## Done (${report.completed.length})`);
    lines.push("");
    lines.push(
      withEvidence
        ? `${withEvidence} of these carry green harness-recorded command runs.`
        : `_None of these carry executed evidence — they are opinions, not verified results._`,
    );
    lines.push("");
    lines.push(report.completed.map((c) => taskBullet(c, { withEvidence: true })).join("\n"));
    lines.push("");
  }

  if (report.parked.length) {
    lines.push(`## Parked — needs you (${report.parked.length})`);
    lines.push("");
    lines.push(report.parked.map((p) => taskBullet(p)).join("\n"));
    lines.push("");
  }

  if (report.inProgress.length) {
    lines.push(`## Still in progress (${report.inProgress.length})`);
    lines.push("");
    lines.push(report.inProgress.map((p) => taskBullet(p)).join("\n"));
    lines.push("");
  }

  if (report.watcherActivity.length) {
    lines.push("## Watchers");
    lines.push("");
    for (const w of report.watcherActivity) {
      lines.push(
        `- \`${w.watcher}\` — ${w.queued} queued, ${w.rejected} rejected by triage, ${w.capped} capped, ${w.suppressed} suppressed`,
      );
    }
    lines.push("");
  }

  const degraded = report.healthCounts.degraded + report.healthCounts.empty;
  lines.push("## Run health");
  lines.push("");
  lines.push(
    `\`verified\` ${report.healthCounts.verified} · \`healthy\` ${report.healthCounts.healthy} · ` +
      `\`recovered\` ${report.healthCounts.recovered} · \`degraded\` ${report.healthCounts.degraded} · ` +
      `\`empty\` ${report.healthCounts.empty}`,
  );
  if (degraded) {
    lines.push("");
    lines.push(`⚠️ ${degraded} run${degraded === 1 ? "" : "s"} produced degraded or empty output — worth a look at the model/endpoint, not just the tasks.`);
  }
  lines.push("");

  lines.push("## Budget");
  lines.push("");
  const b = report.budget;
  lines.push(
    `Task starts ${b.consumed.taskStarts}/${b.budgets.maxTaskStarts} · ` +
      `exec runs ${b.consumed.execRuns}/${b.budgets.maxExecRuns} · ` +
      `tokens ${b.consumed.tokens.toLocaleString()}/${b.budgets.maxTokens.toLocaleString()}` +
      (b.exhausted ? " — **exhausted**, autonomy paused until the next idle window." : ""),
  );
  if (report.unseenCount) {
    lines.push("");
    lines.push(`${report.unseenCount} self-generated task${report.unseenCount === 1 ? "" : "s"} you haven't opened yet.`);
  }
  lines.push("");

  return lines.join("\n");
}
