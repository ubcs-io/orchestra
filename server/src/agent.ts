/**
 * Repo-aware role execution over pi (the key mechanism, §5).
 *
 * `runRole()` runs one refinement step as a pi AgentSession: the role's persona
 * is the system prompt, it gets read-only repo tools plus custom tools. Under
 * the artifact-first output contract (PLANNING/overhaul/01) a role's work
 * travels on two channels:
 *   - the REPORT: markdown prose streamed to the task's planning artifact as it
 *     is produced — via `report_section` in tool mode, or as the answer text
 *     itself in text/two-phase modes. Prose survives every failure mode.
 *   - the VERDICT TRAILER: a small structured payload (verdict, summary,
 *     open_questions, coverage, plus criteria_results/subtasks where required)
 *     delivered via `record_findings` or a trailing ```json fence.
 * `RoleFindings.section_md` is an assembled value (report + trailer), not a
 * transmitted one. The legacy v1 contract (full report embedded in the JSON as
 * `section_md`) remains available per connection via ModelCompat.outputContract.
 * pi's event stream is forwarded to `onEvent` for the live SSE view and
 * captured to a transcript for replay.
 */

import {
  createAgentSession,
  createEditToolDefinition,
  createWriteToolDefinition,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { ThinkingLevel } from "@earendil-works/pi-ai/compat";
import { appendArtifactSection, assertInsideWorktree, isWorktreePath, readArtifact, resolveInPlanning } from "./git.js";
import { ensureModel, getRegistry } from "./providers.js";
import { resolveConnection, type Connection, type ThinkingBudgets } from "./settings.js";
import { runConstrainedCompletion, runPlainCompletion, type ChatMessage } from "./structured.js";
import { computeBudget } from "./context-budget.js";
import {
  REPAIR_FORMALIZE_PROMPT,
  TWO_PHASE_EXPLORE_CONTRACT,
  TWO_PHASE_EXPLORE_CONTRACT_V1,
  TWO_PHASE_FORMALIZE_PROMPT,
  TWO_PHASE_FORMALIZE_PROMPT_V1,
} from "./roles.js";
import {
  DEFAULT_EXEC_MAX_OUTPUT_BYTES,
  DEFAULT_EXEC_MAX_RUNS,
  DEFAULT_EXEC_TIMEOUT_MS,
  DEFAULT_HARNESS_POLICY,
  EXEC_TOOL_NAME,
  WRITE_TOOL_NAMES,
  execEnabled,
  type HarnessPolicy,
} from "./harness-policy.js";
import {
  buildExecEnv,
  describeEvidence,
  resolveExecInvocation,
  runExecCommand,
  type ExecEvidence,
} from "./exec.js";

export type Verdict = "pass" | "needs_more" | "blocker" | "needs_human";
export type CoverageStatus = "considered" | "skipped" | "out_of_scope";
export type QuestionConfidence = "low" | "medium" | "high";
/** Lifecycle of a role's best-effort guess: set once when recorded, then updated
 *  when a human's later answer is compared against it (see orchestrator.ts). */
export type QuestionResolution = "assumed" | "confirmed" | "invalidated";

export interface CoverageItem {
  concern: string;
  status: CoverageStatus;
  note?: string;
}

/** An open question a role could not fully resolve, together with its own
 *  best-effort guess — recorded so the pipeline can proceed past it instead of
 *  stalling, and so a later human answer can be checked against the guess. */
export interface OpenQuestion {
  question: string;
  assumed_answer: string;
  confidence: QuestionConfidence;
  resolved: QuestionResolution;
}

/** Whether a counter-reviewer judged an acceptance criterion satisfied. */
export type CritStatus = "met" | "partial" | "unmet";

/** A counter-reviewer's judgement of one acceptance criterion (by id). */
export interface CriteriaResult {
  id: string;
  status: CritStatus;
  note?: string;
}

/** XS = single-file or few-line change, S = 2-4 files no new dependencies,
 *  M = new component/feature within existing patterns, L = cross-cutting/new
 *  subsystem, XL = major architecture change. Estimated by `explorer` once it
 *  has actually looked at the affected files (see roles.ts). */
export type EffortSize = "XS" | "S" | "M" | "L" | "XL";

/** One node of a decomposition role's epic/story/task tree — the machine-readable
 *  counterpart to the human-readable prose it also writes in section_md. */
export interface Subtask {
  local_id: string;
  level: "epic" | "story" | "task";
  name: string;
  brief: string;
  acceptance_criteria: string[];
  context_to_carry_forward: string;
  depends_on?: string[];
  /** Set true only on a `level: "task"` node that's already fully scoped and
   *  needs no further requirements/architecture analysis — just implementation.
   *  Routes the spawned child straight to the developer/critic execution flow
   *  instead of re-entering the full planning pipeline (see orchestrator.ts's
   *  createDecompositionChildren). */
  execution_ready?: boolean;
}

export interface RoleFindings {
  verdict: Verdict;
  summary: string;
  open_questions: OpenQuestion[];
  coverage: CoverageItem[];
  section_md: string;
  /** Present only for counter-reviewer roles; one entry per acceptance criterion. */
  criteria_results?: CriteriaResult[];
  /** Present only for decomposition (or any role with can_create_subtasks). */
  subtasks?: Subtask[];
  /** Required when subtasks is intentionally empty (already one atomic unit) —
   *  distinguishes that from a failed/incomplete decomposition. */
  no_decomposition_reason?: string;
  /** Present only for the `explorer` role: an informed estimate of how much
   *  work this task actually is, now that real files have been looked at.
   *  Drives the family-wide decomposition budget (orchestrator.ts's
   *  createDecompositionChildren) and the XS fast path — not produced by
   *  intake_triage, which runs before any code is read. */
  effort_size?: EffortSize;
  /** "What the next role must know that isn't obvious from my summary"
   *  (PLANNING/overhaul/07 §4) — an explicit, model-authored handoff contract.
   *  Optional; Tier-4 prior-run context prefers this over `summary` when a
   *  later role's context is being assembled. */
  carry_forward?: string;
}

/**
 * Which mechanism produced the run's structured verdict. "tool" = a
 * record_findings call; "fence" = parsed/salvaged from a ```json trailer in the
 * answer text; "constrained" = the sampler-guaranteed constrained-decoding turn
 * (overhaul/02); "repair" = the cheap stateless formalize call that reconstructs
 * the verdict from already-produced material after every in-session channel
 * failed (overhaul/03); "fallback" = synthesized because no verdict was
 * recovered at all.
 */
export type VerdictSource = "tool" | "fence" | "constrained" | "repair" | "fallback";

export interface ToolCallRecord {
  tool: string;
  args: unknown;
  isError: boolean;
  /** Error text (e.g. schema validation failure) when isError is true. */
  error?: string;
}

/** Normalized stream event forwarded to the SSE layer. */
export type RoleStreamEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_start"; tool: string; args: unknown }
  | { type: "tool_end"; tool: string; isError: boolean; error?: string }
  | { type: "status"; message: string };

export interface RoleRunResult {
  findings: RoleFindings;
  toolCalls: ToolCallRecord[];
  transcriptJsonl: string;
  tokens: number;
  model: string;
  /** True when the role never called record_findings and we synthesized a fallback. */
  fallback: boolean;
  /** True if the run narrated a tool call instead of invoking it and had to be aborted
   *  mid-turn (see createStallDetector) — even if the auto-retry then recovered. */
  stalled: boolean;
  /** For twoPhase mode: 0 = normal/tool mode, 1 = phase 1 complete, 2 = phase 2 complete. */
  phase?: number;
  /** The LLM stop reason ("stop" | "length" | "toolUse" | ...); "length" == truncated. */
  stopReason?: string;
  /** The model's reasoning trace (native reasoning channel + any inline <think>). */
  thinkingText: string;
  /** Worktree-relative paths written/edited via the guarded write/edit tools
   *  this run (empty unless the role was granted write/edit and the project's
   *  harness policy allowed it) — the caller stages these into the same
   *  checkpoint commit as the artifact section. */
  filesWritten: string[];
  /** Bytes of report prose durably appended to the task artifact via
   *  report_section DURING the run. >0 means the report (or part of it) is
   *  already on disk even if the run later degraded. Optional only so test
   *  fakes stay terse — the real runRole always sets it. */
  artifactBytesAppended?: number;
  /** How the structured verdict was obtained (see VerdictSource). Optional only
   *  for test fakes — the real runRole always sets it. */
  verdictSource?: VerdictSource;
  /** True when the repair pass (overhaul/03) ran — i.e. every in-session verdict
   *  channel failed and a stateless formalize call was attempted to reconstruct
   *  the verdict from already-produced material. Independent of success:
   *  verdictSource === "repair" iff it succeeded, "fallback" iff it too failed.
   *  Raw recovery-cost signal for overhaul/04. Optional for test fakes. */
  repairAttempted?: boolean;
  /** The portion of findings.section_md NOT yet appended to the artifact during
   *  the run — the orchestrator appends exactly this after the run (plus any
   *  extras it renders itself, e.g. the decomposition tree). "" when
   *  report_section already persisted the whole report. When absent (test
   *  fakes / older callers), callers should treat it as findings.section_md. */
  artifactResidualMd?: string;
  /** Commands actually executed this run via the allowlisted `run_command`
   *  tool, recorded BY THE HARNESS (PLANNING/overhaul/05). Empty unless the
   *  role was granted `run_command` and the project's policy allowed it.
   *  Deliberately not part of the verdict payload: the model reports its
   *  opinion, the executor reports what happened, and only the latter is
   *  admissible at the evidence-criteria gate — so neither a confident wrong
   *  verdict nor a repair pass (overhaul/03) can manufacture a green run. */
  evidence?: ExecEvidence[];
}

export interface RunRoleParams {
  repoPath: string;
  planningDir: string;
  /** Absolute path to the task's REFINING artifact — the `report_section`
   *  tool's append target. Pass "" for calls with no owned artifact (critique
   *  passes, router mini-calls, recap): report_section is then not registered. */
  artifactAbsPath: string;
  modelId: string;
  systemPrompt: string;
  /** pi built-in tool allowlist, e.g. ["read","grep","find","ls"]; [] = context-only. */
  tools: string[];
  /** Fully composed user message (task + accumulated findings + steering). */
  context: string;
  /** Thinking level for reasoning models (omitted → pi default; ignored when model.reasoning is false). */
  thinkingLevel?: ThinkingLevel;
  /** When true, record_findings is NOT registered as a tool — the model must output
   *  findings as a ```json block in the answer text instead. Opt-in for models whose
   *  native function-calling is unreliable. Superseded by twoPhase. */
  textMode?: boolean;
  /** When true, splits the run into two phases within the same pi session:
   *  phase 1 explores with tools and produces a natural-language summary;
   *  phase 2 formalizes that summary as structured JSON (no custom tool call).
   *  Supersedes textMode for models whose built-in tool usage works but whose
   *  custom tool calling (record_findings) is unreliable. */
  twoPhase?: boolean;
  /** Per-thinking-level reasoning token budgets passed to pi's SettingsManager.
   *  Caps reasoning spend so the model's output has guaranteed headroom.
   *  Falls back to the global connection's thinkingBudgets when omitted. */
  thinkingBudgets?: ThinkingBudgets;
  /** Pre-resolved connection (base URL/auth/textMode/twoPhase/compat/thinkingBudgets)
   *  for `modelId` — pass the result of settings.ts's `resolveConnectionForModel()`
   *  so a role/task running against a named model-config override uses THAT
   *  config's own settings instead of the project/global default connection.
   *  Falls back to `resolveConnection()` (today's behavior) when omitted. */
  connection?: Connection;
  /** Resolved per-project harness policy — gates whether "write"/"edit" in
   *  `tools` actually get registered as real, worktree-jailed tools. Omitted
   *  → DEFAULT_HARNESS_POLICY (allowWrite: false), i.e. write/edit are
   *  stripped even if present in `tools`. This is the authoritative runtime
   *  enforcement point, independent of what's stored in the role's tools_json. */
  harnessPolicy?: HarnessPolicy;
  onEvent?: (ev: RoleStreamEvent) => void;
  signal?: AbortSignal;
}

// ---- TypeBox schemas for the custom tools ----

const CoverageSchema = Type.Object({
  concern: Type.String(),
  status: Type.Union([
    Type.Literal("considered"),
    Type.Literal("skipped"),
    Type.Literal("out_of_scope"),
  ]),
  note: Type.Optional(Type.String()),
});

const CriteriaResultSchema = Type.Object({
  id: Type.String(),
  status: Type.Union([
    Type.Literal("met"),
    Type.Literal("partial"),
    Type.Literal("unmet"),
  ]),
  note: Type.Optional(Type.String()),
});

const OpenQuestionSchema = Type.Object({
  question: Type.String(),
  assumed_answer: Type.String({
    description:
      "Your own best-effort guess at the answer. Never leave this empty — a low-" +
      "confidence guess still lets the pipeline keep moving; a human can confirm or " +
      "correct it later.",
  }),
  confidence: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
});

const SubtaskSchema = Type.Object({
  local_id: Type.String({
    description:
      "Short id unique within this list (e.g. \"1\", \"1.2\") — referenced by other nodes' depends_on.",
  }),
  level: Type.Union([Type.Literal("epic"), Type.Literal("story"), Type.Literal("task")]),
  name: Type.String({ description: "Short imperative title, <=120 chars." }),
  brief: Type.String({ description: "1-3 sentences: what this unit of work is, concretely." }),
  acceptance_criteria: Type.Array(Type.String()),
  context_to_carry_forward: Type.String({
    description:
      "Decisions, constraints, or facts this child needs that aren't obvious from name/brief alone — " +
      "this becomes the child's seed context. The child will not re-read this parent's full history by default.",
  }),
  depends_on: Type.Optional(
    Type.Array(Type.String(), {
      description: "local_ids of sibling nodes in this same list that must complete first.",
    }),
  ),
  execution_ready: Type.Optional(
    Type.Boolean({
      description:
        "level: \"task\" nodes only — true if this needs no further requirements/architecture analysis and " +
        "a developer could implement it directly from brief + acceptance_criteria alone. Always false/omitted " +
        "for epic/story nodes or anything still needing analysis.",
    }),
  ),
});

/** Exported so structured.ts's constrained-decoding rung (PLANNING/overhaul/02)
 *  can reuse it verbatim as the response_format/guided_json payload for the
 *  verdict trailer — the same schema that already validates the record_findings
 *  tool call, with zero duplication. */
export const RecordFindingsSchema = Type.Object({
  verdict: Type.Union([
    Type.Literal("pass"),
    Type.Literal("needs_more"),
    Type.Literal("blocker"),
    Type.Literal("needs_human"),
  ]),
  summary: Type.String(),
  open_questions: Type.Optional(Type.Array(OpenQuestionSchema)),
  coverage: Type.Optional(Type.Array(CoverageSchema)),
  section_md: Type.Optional(
    Type.String({
      description:
        "Legacy field — omit it if you already saved your report via report_section (or your report " +
        "is the prose of your response). Only include it when you have a report that was not " +
        "delivered any other way.",
    }),
  ),
  criteria_results: Type.Optional(
    Type.Array(CriteriaResultSchema, {
      description:
        "Required if you are a counter-reviewer checking an \"Acceptance criteria to verify\" checklist " +
        "— one entry per criterion. A criterion with no entry here is treated as unmet regardless of your " +
        "verdict, so a \"pass\" verdict with this left empty will be rejected as incomplete.",
    }),
  ),
  subtasks: Type.Optional(Type.Array(SubtaskSchema)),
  no_decomposition_reason: Type.Optional(
    Type.String({
      description:
        "Required when subtasks is empty and that's intentional (the work is already one atomic, " +
        "independently-actionable unit). An empty subtasks array with no reason is treated as a " +
        "failed decomposition, not an intentional no-op.",
    }),
  ),
  effort_size: Type.Optional(
    Type.Union(
      [Type.Literal("XS"), Type.Literal("S"), Type.Literal("M"), Type.Literal("L"), Type.Literal("XL")],
      {
        description:
          "Explorer role only: your best estimate of how much work this actually is, now that you've " +
          "looked at the real files. XS = single-file or few-line change. S = 2-4 files, no new " +
          "dependencies. M = new component/feature within existing patterns. L = cross-cutting change " +
          "or new subsystem. XL = major architecture change. This gates how much further planning " +
          "the pipeline does, so be honest rather than defaulting to a larger size out of caution.",
      },
    ),
  ),
  carry_forward: Type.Optional(
    Type.String({
      description:
        "Optional, max ~300 characters. What the NEXT role must know that isn't obvious from your " +
        "summary alone — a specific decision, gotcha, or constraint you found. Omit if your summary " +
        "already covers it. This is shown to later roles in place of a truncated summary.",
    }),
  ),
});

/** Map a validated record_findings-shaped payload onto RoleFindings — shared by
 *  the record_findings tool's execute() (tool-call rung) and the constrained
 *  completion path in runRole (structured.ts rung, PLANNING/overhaul/02), so
 *  both delivery mechanisms produce identical RoleFindings for the same input. */
export function findingsFromRecordPayload(p: Static<typeof RecordFindingsSchema>): RoleFindings {
  return {
    verdict: p.verdict,
    summary: p.summary,
    open_questions: (p.open_questions ?? []).map((q) => ({ ...q, resolved: "assumed" as const })),
    coverage: (p.coverage ?? []) as CoverageItem[],
    section_md: p.section_md ?? "",
    criteria_results: (p.criteria_results ?? []) as CriteriaResult[],
    subtasks: p.subtasks as Subtask[] | undefined,
    no_decomposition_reason: p.no_decomposition_reason,
    effort_size: p.effort_size,
    carry_forward: p.carry_forward,
  };
}

const WriteArtifactSchema = Type.Object({
  relative_path: Type.String({
    description: "Path relative to the project's PLANNING directory. Cannot escape it.",
  }),
  content: Type.String(),
});

const ReportSectionSchema = Type.Object({
  content: Type.String({
    description:
      "The completed markdown section to append to your report. Start the first section with a " +
      '"## <Your Role>" heading; use "###" subheadings for later sections. Include concrete ' +
      "file references.",
  }),
});

/** Hard cap on report_section calls per run — a stalling model must not be able
 *  to litter the artifact with an unbounded stream of fragments. */
const REPORT_SECTION_MAX_CALLS = 12;

/** Custom tool name that opts a role into the read-only git history tool. */
export const GIT_HISTORY_TOOL = "git_history";

const GitHistorySchema = Type.Object({
  path: Type.Optional(
    Type.String({ description: "Limit history to this repo-relative file or directory." }),
  ),
  grep: Type.Optional(
    Type.String({ description: "Find commits that added or removed this exact string (git log -S)." }),
  ),
  since_days: Type.Optional(
    Type.Number({ description: "Only include commits from the last N days." }),
  ),
  max_commits: Type.Optional(
    Type.Number({ description: "Maximum commits to return (default 20)." }),
  ),
});

/** Read-only `git log` over the repo, used to see what recently changed near a bug. */
function runGitHistory(repoPath: string, p: Static<typeof GitHistorySchema>): string {
  const max = Math.max(1, Math.min(p.max_commits ?? 20, 100));
  const args = ["log", "--format=%h %ad %an %s", "--date=short", "-n", String(max)];
  if (p.since_days && p.since_days > 0) args.push(`--since=${p.since_days} days ago`);
  if (p.grep) args.push("-S", p.grep);
  if (p.path) args.push("--", p.path);
  try {
    const out = execFileSync("git", args, {
      cwd: repoPath,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 15_000,
    });
    return out.trim() || "(no matching commits)";
  } catch (err) {
    return `git error: ${(err as Error).message}`;
  }
}

// ---- run_command: allowlisted execution in the task worktree (overhaul/05) ----

const RunCommandSchema = Type.Object({
  name: Type.String({
    description:
      "The name of an approved command to run, exactly as listed in your instructions. This is a " +
      "menu choice, not a command line — you cannot pass a shell command here.",
  }),
  args: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Extra arguments appended to the approved command, only for commands documented as accepting " +
        "them (e.g. a single test-file path to narrow the run). Omit otherwise.",
    }),
  ),
});

/** How much of a command's output comes back to the model in the tool result.
 *  The full (policy-capped) output is retained on the evidence record for the
 *  human and the UI; the model only needs enough tail to see what failed, and
 *  a 64 KiB paste would swallow a small model's whole context (overhaul/07). */
const EXEC_TOOL_RESULT_TAIL_CHARS = 4000;

/** How often a running command emits a "still running" status event. Chosen
 *  well under any sane `requestTimeoutMs` so the orchestrator's idle watchdog
 *  never mistakes a working test suite for a hung connection. */
const EXEC_HEARTBEAT_MS = 20_000;

/**
 * Instruction appended to the system prompt whenever `run_command` is actually
 * registered. Lives here rather than in a role's persona because the menu is
 * per-project and only known at run time — and because a role that was NOT
 * granted exec must never be told to run tests it cannot run.
 *
 * The hard line ("a pass verdict without a green run will be rejected") is not
 * a bluff: the evidence criteria in the execution flow are checked
 * deterministically against the harness-recorded evidence, with no model
 * judgement involved (see orchestrator.ts's evidence gate).
 */
export function buildExecToolInstruction(policy: HarnessPolicy, maxRuns: number): string {
  const lines = (policy.execAllowlist ?? []).map((c) => {
    const argNote = c.allowArgs ? " — accepts optional extra arguments" : "";
    const desc = c.description ? ` — ${c.description}` : "";
    return `- \`${c.name}\` → \`${c.argv.join(" ")}\`${desc}${argNote}`;
  });
  return `
## Verifying your work (required)

You have a \`run_command\` tool that runs pre-approved commands inside this task's
own git worktree. You do not write command lines — you pick a name from this menu:

${lines.join("\n")}

Call it as \`run_command({ "name": "<one of the names above>" })\`. There is no shell:
no pipes, no redirection, no chaining, and no command that is not on the menu.
You may call it at most ${maxRuns} times in this run, so do not re-run a command
that already passed.

The result of every run is recorded by the platform, not by you — you cannot
assert that a suite passed, you can only run it and let the result speak. Claiming
in your report that tests pass when the recorded run is red will be caught. If a
command exits non-zero, treat that as the ground truth: fix the cause and run it
again, or report honestly what is still failing with verdict "needs_more".
`.trim();
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

// A sentence repeated this many times (verbatim, case/space-insensitive) marks the
// turn as stalled — the model is narrating an action instead of taking it. This is
// a known failure mode on self-hosted endpoints whose chat template doesn't reliably
// surface tool calls as structured deltas: the model just talks about calling the
// tool (e.g. "Let me call record_findings now") forever, burning the token budget.
// Kept fairly high because both this and the narration check below abort the stream
// mid-chunk the instant they fire — false positives on legitimate verbose analysis
// truncate output mid-word (see PREEMPTIVE_NUDGE_CHARS below).
const STALL_REPEAT_THRESHOLD = 5;
const STALL_MIN_SENTENCE_LEN = 20;

export const TOOL_CALL_DISCIPLINE =
  "Save your report AS YOU WORK by calling the `report_section` tool: each time a section of your " +
  'write-up is complete (start the first with a "## <Your Role>" heading), call `report_section` ' +
  "with that markdown. This is how your work is persisted — prose you only type into the chat is " +
  "not the report. Do not re-send a section you already reported.\n\n" +
  "When you are ready to use a tool, invoke it directly as a function call — never describe or " +
  'narrate the call in plain text (e.g. do not write "Let me call record_findings now" or similar). ' +
  "Plain text should contain your analysis, not announcements of tool use.\n\n" +
  "When you are done, call the `record_findings` tool EXACTLY ONCE with your verdict trailer: " +
  "verdict, summary, open_questions, and coverage (plus criteria_results / subtasks / " +
  "no_decomposition_reason when your role requires them). Your report is already saved via " +
  "report_section — do NOT repeat it in record_findings; leave section_md out. Both " +
  "`report_section` and `record_findings` are platform custom tools and each IS available to you. " +
  'Even if they do not appear in a separate "built-in" tool list, they are registered and ready — ' +
  'just call them. You will not get a "tool not found" error for them. Do not question whether ' +
  "they exist — invoke record_findings when you are done.";

/** Legacy (v1 output contract) tool discipline: the whole report travels inside
 *  record_findings' section_md. Selected per connection via
 *  ModelCompat.outputContract = "v1", and used whenever a run has no owned
 *  artifact for report_section to target (critique passes, router mini-calls). */
export const TOOL_CALL_DISCIPLINE_V1 =
  "When you are ready to use a tool, invoke it directly as a function call — never describe or " +
  'narrate the call in plain text (e.g. do not write "Let me call record_findings now" or similar). ' +
  "Plain text should contain your analysis, not announcements of tool use.\n\n" +
  "When you are done, call the `record_findings` tool EXACTLY ONCE with the fields described in " +
  '"How to finish" above, including your full markdown report as `section_md`. record_findings is ' +
  "a platform custom tool and IS available to you. Even " +
  'if it does not appear in a separate "built-in" tool list, it is registered and ready — just ' +
  'call it. You will not get a "tool not found" error for it. Do not question whether it exists — ' +
  "invoke it when you are done.";

const STALL_NUDGE =
  "You just described calling a tool in plain text, repeatedly, without actually invoking it. Stop " +
  "narrating and invoke the tool directly as a function call right now, using your best current " +
  "assessment. If you genuinely need more information first, use the available read-only tools to " +
  "get it, then call record_findings — do not write about your intentions.";

/** PLANNING/overhaul/07 §3: sent when cumulative tool-result volume crosses
 *  `toolResultCharBudget` — the model has read enough that continuing risks
 *  crowding out its own verdict. Same abort+re-prompt delivery as STALL_NUDGE. */
const TOOL_RESULT_BUDGET_NUDGE =
  "You have read a large amount of tool output in this run. Stop reading more files or running more " +
  "commands, and finish up now: report your verdict based on what you have already seen. If something " +
  "important is still unconfirmed, note it as an open question rather than continuing to explore.";

// ---- Text-mode support (for models that can't reliably do native function calling) ----

/**
 * Regex patterns that indicate the model is talking about calling/invoking a tool
 * in plain text instead of actually doing so. Matched case-insensitively against
 * streamed answer text. Used by the narration-pattern stall detector (universal)
 * and also checked during fallback extraction for diagnostic hints.
 */
const NARRATION_PATTERNS = [
  /\b(let me|i will|i'll|i need to|going to|i can|i should|i must)\s+(call|invoke|use|run|trigger|execute|make)\s+/i,
  /\b(call|invoking|invoke)\s+(the\s+)?record_findings/i,
  /\b(i have|i've)\s+(all\s+the\s+information|everything\s+i\s+need)\b/i,
  /\b(let me|i will|i'll|i am going to)\s+(finalize|finish|wrap|conclude|do that)\b/i,
  /\bnow\s+(i|let me)\s+(will|call|invoke|record|finalize)\b/i,
];

/** Check whether a piece of text matches any narration pattern. */
function hasNarrationPattern(text: string): boolean {
  for (const re of NARRATION_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}

/**
 * Instruction appended to the system prompt when textMode is on (artifact-first
 * contract). The model writes its report as plain markdown prose FIRST — that
 * prose is appended to the task artifact as-is — and ends with one small JSON
 * verdict trailer (no section_md, no markdown-inside-JSON).
 */
export const TEXT_MODE_INSTRUCTION = `
## How to finish (text mode)

You do NOT have a record_findings tool. Structure your response in two parts:

**1. Your report (first).** Write your full findings as normal markdown prose,
starting with a "## <Your Role>" heading. Include concrete file references. This
prose IS the deliverable — it is appended to the task's planning artifact exactly
as you write it, so write a finished document, not narration. Do NOT wrap it in
JSON or a code fence.

**2. Your verdict trailer (last).** End your response with ONE small JSON code
block containing only your structured verdict, using EXACTLY this format:

\`\`\`json
{
  "verdict": "pass",
  "summary": "One or two sentences capturing your key takeaway.",
  "open_questions": [{"question": "...", "assumed_answer": "your best guess", "confidence": "medium"}],
  "coverage": [{"concern": "security", "status": "considered", "note": "checked auth flow"}]
}
\`\`\`

- **verdict**: one of "pass", "needs_more", "blocker", or "needs_human"
- **summary**: brief key takeaway
- **open_questions**: array of { question, assumed_answer, confidence } (empty if none). For EVERY open question, give your own best-effort guess at the answer plus a confidence ("low" | "medium" | "high") — never leave assumed_answer empty. Reserve "blocker"/"needs_human" ONLY for questions where no reasonable guess is possible at all; an ordinary open question with a guess attached should still get "pass" or "needs_more".
- **coverage**: array of { concern, status, note } — status is "considered", "skipped", or "out_of_scope". Draw concerns from: correctness, security, privacy, performance, accessibility, edge-cases, tests, dependencies, data, ux, docs. Be honest about what you did NOT examine.

If you are a counter-reviewer with acceptance criteria to verify, also include:
- **criteria_results**: array of { id, status, note } — status is "met", "partial", or "unmet"

If you are decomposing work into an epic/story/task tree, also include:
- **subtasks**: array of { local_id, level, name, brief, acceptance_criteria, context_to_carry_forward, depends_on, execution_ready } — local_id is a short id you assign (e.g. "1", "1.2") that depends_on (array of other subtasks' local_ids, optional) can reference; level is "epic", "story", or "task"; context_to_carry_forward must state any decision/constraint/fact the child needs that isn't obvious from name/brief alone — the child will not see this parent's full history by default. On a "task"-level node only, set execution_ready: true if it's already fully scoped and needs no further requirements/architecture analysis — a developer could implement it directly from brief + acceptance_criteria alone; leave it false/omitted otherwise, and always for epic/story nodes.
- **no_decomposition_reason**: a string explaining why, REQUIRED if subtasks is empty and that's intentional (the work is already one atomic, independently-actionable unit). An empty subtasks array with no reason is treated as a failed decomposition.
- **carry_forward** (optional, ~300 chars max): a specific decision, gotcha, or constraint the NEXT role must know that isn't obvious from your summary. Omit if your summary already covers it.

Do NOT put your report inside the JSON — there is no "section_md" field. The
markdown you wrote above the code block is the report. The JSON block must be the
LAST thing in your response. Do not write anything after the closing \`\`\`.
`.trim();

/**
 * Legacy (v1 output contract) text-mode instruction: the full report is embedded
 * in the JSON as section_md. Selected per connection via
 * ModelCompat.outputContract = "v1".
 */
export const TEXT_MODE_INSTRUCTION_V1 = `
## How to finish (text mode)

You do NOT have a record_findings tool. Instead, when you are done with your analysis,
output your findings as a single JSON code block using EXACTLY this format:

\`\`\`json
{
  "verdict": "pass",
  "summary": "One or two sentences capturing your key takeaway.",
  "open_questions": [{"question": "...", "assumed_answer": "your best guess", "confidence": "medium"}],
  "coverage": [{"concern": "security", "status": "considered", "note": "checked auth flow"}],
  "section_md": "## My Role\\n\\nFindings with concrete file references..."
}
\`\`\`

- **verdict**: one of "pass", "needs_more", "blocker", or "needs_human"
- **summary**: brief key takeaway
- **open_questions**: array of { question, assumed_answer, confidence } (empty if none). For EVERY open question, give your own best-effort guess at the answer plus a confidence ("low" | "medium" | "high") — never leave assumed_answer empty. Reserve "blocker"/"needs_human" ONLY for questions where no reasonable guess is possible at all; an ordinary open question with a guess attached should still get "pass" or "needs_more".
- **coverage**: array of { concern, status, note } — status is "considered", "skipped", or "out_of_scope". Draw concerns from: correctness, security, privacy, performance, accessibility, edge-cases, tests, dependencies, data, ux, docs. Be honest about what you did NOT examine.
- **section_md**: a markdown section (start with "## Your Role" heading) with concrete file references. This will be appended to the task's planning artifact.

If you are a counter-reviewer with acceptance criteria to verify, also include:
- **criteria_results**: array of { id, status, note } — status is "met", "partial", or "unmet"

If you are decomposing work into an epic/story/task tree, also include:
- **subtasks**: array of { local_id, level, name, brief, acceptance_criteria, context_to_carry_forward, depends_on, execution_ready } — local_id is a short id you assign (e.g. "1", "1.2") that depends_on (array of other subtasks' local_ids, optional) can reference; level is "epic", "story", or "task"; context_to_carry_forward must state any decision/constraint/fact the child needs that isn't obvious from name/brief alone — the child will not see this parent's full history by default. On a "task"-level node only, set execution_ready: true if it's already fully scoped and needs no further requirements/architecture analysis — a developer could implement it directly from brief + acceptance_criteria alone; leave it false/omitted otherwise, and always for epic/story nodes.
- **no_decomposition_reason**: a string explaining why, REQUIRED if subtasks is empty and that's intentional (the work is already one atomic, independently-actionable unit). An empty subtasks array with no reason is treated as a failed decomposition.
- **carry_forward** (optional, ~300 chars max): a specific decision, gotcha, or constraint the NEXT role must know that isn't obvious from your summary. Omit if your summary already covers it.

Output ONLY the JSON block as the last thing in your response. Do not write anything after the closing \`\`\`.
`.trim();

// ---- Stall detection (purely stream-driven helpers) ----

/**
 * Flags a turn as "stalled" once the same substantial sentence recurs across the
 * streamed text — the signature of a model narrating a tool call instead of making
 * one. Buffers partial sentences across streamed deltas so a sentence split across
 * chunk boundaries is still matched whole. Exported for unit testing.
 *
 * Also detects varied "narration patterns" — sentences that talk about calling a
 * tool without actually doing so, even if the wording differs each time. This
 * catches the more common case where the model cycles through different phrasings
 * of the same intent (e.g. "Let me call record_findings", "I will invoke it now",
 * "Let me finalize").
 *
 * Which signal fired is exposed via `reason()` — "repetition" (the same sentence
 * verbatim past threshold) vs "narration" (varied talk-about-calling-a-tool
 * phrasings). Softer stall handling (overhaul/03 §3) treats these differently:
 * a repetition loop's remaining stream is provably worthless and still aborts
 * mid-stream, while a narration stall can be downgraded to end-of-turn steering.
 */
export type StallReason = "repetition" | "narration";

export function createStallDetector(
  repThreshold = STALL_REPEAT_THRESHOLD,
  narrationThreshold = STALL_REPEAT_THRESHOLD,
) {
  let buffer = "";
  const seen = new Map<string, number>();
  let narrationCount = 0;
  let stalled = false;
  let reason: StallReason | null = null;
  const SENTENCE_END = /[.!?\n]/;

  function extractSentences(): string[] {
    const out: string[] = [];
    for (;;) {
      const m = SENTENCE_END.exec(buffer);
      if (!m) break;
      out.push(buffer.slice(0, m.index + 1));
      buffer = buffer.slice(m.index + 1);
    }
    return out;
  }

  return {
    /** Feed the next streamed chunk; returns true once/if this turn is stalled. */
    push(delta: string): boolean {
      if (stalled || !delta) return stalled;
      buffer += delta;
      for (const raw of extractSentences()) {
        const norm = raw.trim().toLowerCase().replace(/\s+/g, " ");

        // Repetition check: exact same sentence appears N times.
        if (norm.length >= STALL_MIN_SENTENCE_LEN) {
          const count = (seen.get(norm) ?? 0) + 1;
          seen.set(norm, count);
          if (count >= repThreshold) {
            stalled = true;
            reason = "repetition";
            break;
          }
        }

        // Narration pattern check: the model is talking about calling a tool.
        if (hasNarrationPattern(raw)) {
          narrationCount += 1;
          if (narrationCount >= narrationThreshold) {
            stalled = true;
            reason = "narration";
            break;
          }
        }
      }
      return stalled;
    },
    /** Why the turn latched as stalled, or null if it hasn't. */
    reason(): StallReason | null {
      return reason;
    },
    reset(): void {
      buffer = "";
      seen.clear();
      narrationCount = 0;
      stalled = false;
      reason = null;
    },
  };
}

/** Longest suffix of `s` that is a proper prefix of `marker` (for partial-tag carry). */
function partialSuffix(s: string, marker: string): number {
  const max = Math.min(marker.length - 1, s.length);
  for (let k = max; k > 0; k--) {
    if (s.slice(s.length - k) === marker.slice(0, k)) return k;
  }
  return 0;
}

/**
 * Incremental splitter that separates inline `<think>…</think>` reasoning from the
 * answer text across streamed deltas. Some local reasoning models (DeepSeek-R1 /
 * QwQ) emit chain-of-thought as literal `<think>` tags in the content stream rather
 * than on pi's native reasoning channel; this routes that text to a thinking channel
 * so it never pollutes the answer or the fallback salvage. Handles tags split across
 * chunk boundaries. Exported for unit testing.
 */
export function createThinkSplitter() {
  let buffer = "";
  let inside = false;

  const process = (final: boolean): { text: string; thinking: string } => {
    let text = "";
    let thinking = "";
    for (;;) {
      const marker = inside ? THINK_CLOSE : THINK_OPEN;
      const idx = buffer.indexOf(marker);
      if (idx === -1) break;
      const seg = buffer.slice(0, idx);
      if (inside) thinking += seg;
      else text += seg;
      buffer = buffer.slice(idx + marker.length);
      inside = !inside;
    }
    // No complete current marker remains. Retain a trailing partial of the marker we
    // are scanning for so we never emit half a tag (unless this is the final flush).
    const keep = final ? 0 : partialSuffix(buffer, inside ? THINK_CLOSE : THINK_OPEN);
    const flushable = buffer.slice(0, buffer.length - keep);
    buffer = buffer.slice(buffer.length - keep);
    if (inside) thinking += flushable;
    else text += flushable;
    return { text, thinking };
  };

  return {
    push: (delta: string) => {
      buffer += delta;
      return process(false);
    },
    flush: () => process(true),
  };
}

const FENCE_MARKER = "```";

/**
 * Incremental tracker for Markdown code-fence boundaries (```) across streamed
 * deltas. Used to keep stall detection from being fed the model's final structured
 * JSON payload once it starts one — repeated short lines inside that payload (e.g.
 * many `"status": "met",` entries in a criteria_results/coverage array) are normal
 * and must not be mistaken for a narration stall. Mirrors createThinkSplitter's
 * partial-marker handling for markers split across chunk boundaries, but simpler
 * since the fence's open and close marker are the same string (a toggle rather than
 * an asymmetric pair). Exported for unit testing.
 */
export function createFenceTracker() {
  let buffer = "";
  let insideFence = false;

  const process = (final: boolean): { outside: string; inside: string } => {
    let outside = "";
    let inside = "";
    for (;;) {
      const idx = buffer.indexOf(FENCE_MARKER);
      if (idx === -1) break;
      const seg = buffer.slice(0, idx);
      if (insideFence) inside += seg + FENCE_MARKER;
      else outside += seg + FENCE_MARKER;
      buffer = buffer.slice(idx + FENCE_MARKER.length);
      insideFence = !insideFence;
    }
    const keep = final ? 0 : partialSuffix(buffer, FENCE_MARKER);
    const flushable = buffer.slice(0, buffer.length - keep);
    buffer = buffer.slice(buffer.length - keep);
    if (insideFence) inside += flushable;
    else outside += flushable;
    return { outside, inside };
  };

  return {
    /** Feed the next streamed chunk; returns the portion outside any fence (safe
     *  to feed to the stall detector) and the portion inside a fence (must be
     *  excluded from stall detection). */
    push: (delta: string) => {
      buffer += delta;
      return process(false);
    },
    /** Clear state for a fresh model turn — call alongside stallDetector.reset()
     *  so a fence left open by an aborted turn doesn't suppress stall detection
     *  on the next turn's fresh narration. */
    reset(): void {
      buffer = "";
      insideFence = false;
    },
  };
}

// ---- JSON extraction for text-mode and fallback recovery ----

/** A verdict extracted from answer text plus the surrounding report prose. */
export interface ExtractedFindings {
  findings: RoleFindings;
  /** The answer text with the verdict-trailer fence removed — under the
   *  artifact-first contract this is the report body ("text before the fence"). */
  prose: string;
}

/**
 * Try to extract a RoleFindings object from a JSON code fence in the answer
 * text, together with the prose around the fence (the report body under the
 * artifact-first contract). Handles closed fences, unclosed fences (truncated
 * output), and raw whole-text JSON. Returns null if no verdict can be recovered.
 */
export function extractFindingsAndProse(text: string): ExtractedFindings | null {
  if (!text) return null;

  // Try ```json ... ``` fence first (most common for text-mode output).
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  // Find the LAST fence — the verdict trailer goes at the end.
  let lastFence: RegExpExecArray | null = null;
  while ((m = fence.exec(text)) !== null) {
    lastFence = m;
  }

  if (lastFence) {
    const parsed = tryParseFindings(lastFence[1]!.trim());
    if (parsed) {
      const prose = (
        text.slice(0, lastFence.index) + text.slice(lastFence.index + lastFence[0].length)
      ).trim();
      return { findings: parsed, prose };
    }
  }

  // Try unclosed fence: an opening ```json ... without a closing ```.
  // This handles models whose output was cut off mid-response (e.g. pre-emptive
  // nudge or token limit). We take everything after the opening fence and
  // attempt a best-effort parse.
  const openFence = /```(?:json)?\s*\n([\s\S]*?)$/;
  const om = openFence.exec(text);
  if (om?.[1]) {
    const partial = om[1].trim();
    if (partial.length > 20) {
      const parsed = tryParseFindings(partial) ?? salvageFieldsFromPartialJson(partial);
      if (parsed) return { findings: parsed, prose: text.slice(0, om.index).trim() };
    }
  }

  // Fallback: try parsing the entire text as raw JSON (unlikely but possible).
  const whole = tryParseFindings(text.trim());
  return whole ? { findings: whole, prose: "" } : null;
}

/**
 * Findings-only wrapper around extractFindingsAndProse — kept for callers that
 * don't need the report prose.
 */
export function extractFindingsFromText(text: string): RoleFindings | null {
  return extractFindingsAndProse(text)?.findings ?? null;
}

/** Coerce loosely-typed model output into OpenQuestion[] — tolerates the old
 *  plain-string form (models that ignore the updated instructions) alongside
 *  the current { question, assumed_answer, confidence } shape. Not schema-
 *  validated input (unlike the record_findings tool path), so every field is
 *  checked defensively. */
function normalizeOpenQuestions(raw: unknown): OpenQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: OpenQuestion[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      if (item.trim()) {
        out.push({ question: item, assumed_answer: "", confidence: "low", resolved: "assumed" });
      }
    } else if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      if (typeof o.question === "string" && o.question.trim()) {
        const confidence =
          o.confidence === "high" || o.confidence === "medium" || o.confidence === "low"
            ? o.confidence
            : "low";
        out.push({
          question: o.question,
          assumed_answer: typeof o.assumed_answer === "string" ? o.assumed_answer : "",
          confidence,
          resolved: "assumed",
        });
      }
    }
  }
  return out;
}

/** Coerce loosely-typed model output into Subtask[] — same defensive posture as
 *  normalizeOpenQuestions since this path (text-mode/two-phase JSON) is not
 *  schema-validated like the record_findings tool call is. Drops entries missing
 *  a name (nothing usable to seed a child task with). */
function normalizeSubtasks(raw: unknown): Subtask[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Subtask[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.name !== "string" || !o.name.trim()) continue;
    const level = o.level === "epic" || o.level === "story" || o.level === "task" ? o.level : "task";
    out.push({
      local_id: typeof o.local_id === "string" && o.local_id ? o.local_id : String(out.length + 1),
      level,
      name: o.name,
      brief: typeof o.brief === "string" ? o.brief : "",
      acceptance_criteria: Array.isArray(o.acceptance_criteria)
        ? o.acceptance_criteria.filter((c): c is string => typeof c === "string")
        : [],
      context_to_carry_forward:
        typeof o.context_to_carry_forward === "string" ? o.context_to_carry_forward : "",
      depends_on: Array.isArray(o.depends_on)
        ? o.depends_on.filter((d): d is string => typeof d === "string")
        : undefined,
      execution_ready: o.execution_ready === true,
    });
  }
  return out.length ? out : undefined;
}

/** Best-effort extraction of RoleFindings fields from malformed/partial JSON
 *  by matching quoted field values with regex. Only returns a result when at
 *  least verdict and summary can be extracted. */
function salvageFieldsFromPartialJson(json: string): RoleFindings | null {
  const str = (key: string): string | null => {
    // Match "key": "value" — handles escaped quotes in the value via a simple
    // greedy match to the next unescaped quote + comma/brace.
    const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "i");
    const m = re.exec(json);
    if (!m) return null;
    // m[1] is already valid JSON string content (the regex only accepts
    // non-quote/backslash chars or backslash-escape pairs) — wrap it in
    // quotes and parse directly. Do not re-escape: that would double-escape
    // already-escaped quotes (\" -> \\") and corrupt the value.
    try {
      return JSON.parse(`"${m[1]}"`) as string;
    } catch {
      return null;
    }
  };
  const verdict = str("verdict");
  const summary = str("summary");
  if (!verdict || !summary) return null;
  if (!["pass", "needs_more", "blocker", "needs_human"].includes(verdict)) return null;
  return {
    verdict: verdict as Verdict,
    summary,
    open_questions: [],
    coverage: [],
    section_md: str("section_md") ?? "",
    criteria_results: [],
  };
}

/** Parse a JSON string as RoleFindings, validating required fields. Accepts
 *  both the legacy v1 blob (section_md embedded) and the artifact-first verdict
 *  trailer (no section_md — the report travels outside the JSON, so its absence
 *  no longer fails validation; callers source it from the durable prose). */
function tryParseFindings(json: string): RoleFindings | null {
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    // Must have at least verdict + summary (the trailer minimum).
    if (typeof obj.verdict !== "string" || typeof obj.summary !== "string") {
      return null;
    }
    const verdict = obj.verdict as Verdict;
    if (!["pass", "needs_more", "blocker", "needs_human"].includes(verdict)) return null;

    return {
      verdict,
      summary: obj.summary,
      open_questions: normalizeOpenQuestions(obj.open_questions),
      coverage: Array.isArray(obj.coverage)
        ? (obj.coverage as CoverageItem[])
        : [],
      section_md: typeof obj.section_md === "string" ? obj.section_md : "",
      criteria_results: Array.isArray(obj.criteria_results)
        ? (obj.criteria_results as CriteriaResult[])
        : undefined,
      subtasks: normalizeSubtasks(obj.subtasks),
      no_decomposition_reason:
        typeof obj.no_decomposition_reason === "string" ? obj.no_decomposition_reason : undefined,
      carry_forward: typeof obj.carry_forward === "string" ? obj.carry_forward : undefined,
    };
  } catch {
    return null;
  }
}

// ---- Report assembly (artifact-first output contract) ----

export interface ReportAssembly {
  /** Final section_md for RoleFindings, assembled from the most reliable source. */
  sectionMd: string;
  /** The part of sectionMd NOT already durably appended to the artifact via
   *  report_section during the run — the orchestrator appends exactly this. */
  artifactResidualMd: string;
}

/**
 * Assemble a run's report (RoleFindings.section_md) from its possible sources,
 * most reliable first:
 *   1. sections durably appended via report_section during the run;
 *   2. a section_md carried inside the verdict payload (legacy v1 models);
 *   3. the answer prose (text/two-phase modes: answer text minus the trailer
 *      fence; last resort: the raw accumulated answer text).
 * Prose is never discarded: even a run that produced no verdict at all gets its
 * text preserved here. Pure — exported for unit testing.
 */
export function assembleReport(input: {
  /** Sections appended via report_section during the run, in call order. */
  reportedSections: string[];
  /** section_md from the verdict payload (tool call / fence), if any. */
  trailerSectionMd?: string;
  /** Answer text with the verdict-trailer fence stripped (when a fence parsed). */
  fenceProse?: string;
  /** Full accumulated answer text — last-resort prose source. */
  answerText: string;
}): ReportAssembly {
  const reportProse = input.reportedSections.join("\n\n").trim();
  const trailerMd = (input.trailerSectionMd ?? "").trim();
  if (reportProse) {
    // Durable sections are the report. A trailer section_md on top of them (a
    // v1-style model that also streamed sections) is kept only when it adds
    // content not already reported — never duplicated.
    if (trailerMd && !reportProse.includes(trailerMd)) {
      return { sectionMd: `${reportProse}\n\n${trailerMd}`, artifactResidualMd: trailerMd };
    }
    return { sectionMd: reportProse, artifactResidualMd: "" };
  }
  if (trailerMd) {
    return { sectionMd: trailerMd, artifactResidualMd: trailerMd };
  }
  const prose = (input.fenceProse ?? input.answerText).trim();
  const sectionMd = prose || "_(model produced only reasoning — see the reasoning trace)_";
  return { sectionMd, artifactResidualMd: sectionMd };
}

// ---- Repair pass (PLANNING/overhaul/03) ----

/** Hard cap on the characters of material sent to the repair formalize call,
 *  keeping the cheap reconstruction call cheap and inside a small context
 *  window. Tail-biased: a report's conclusions and a reasoning trace's
 *  conclusions both sit at the end, which is exactly what the verdict needs. */
const REPAIR_MATERIAL_MAX_CHARS = 8000;

/** Only fold the reasoning trace into repair material when the report is at
 *  most this many chars — the thinking-only salvage case (a reasoning model that
 *  emitted almost no answer text but reasoned at length). Above it, the report
 *  is authoritative and the trace is just noise/cost. */
const REPAIR_THINKING_SALVAGE_MAX_REPORT_CHARS = 200;

/** Keep only the last `max` chars of `s`, marking the elision when it cuts. */
function tailCap(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `…(earlier content omitted)…\n${t.slice(t.length - max)}`;
}

/**
 * Assemble the material for the repair formalize call from a degraded run's
 * surviving output, most-authoritative first: the report the role actually
 * wrote (streamed sections, else the answer prose), plus — only for the
 * thinking-only salvage case — a tail of the reasoning trace. Returns null when
 * there is nothing substantive to formalize (repair would be pointless; the
 * caller goes straight to fallback). Pure — exported for unit testing.
 */
export function buildRepairMaterial(input: {
  reportedSections: string[];
  answerText: string;
  thinkingText: string;
}): string | null {
  const report = input.reportedSections.join("\n\n").trim() || input.answerText.trim();
  const thinking = input.thinkingText.trim();
  const parts: string[] = [];
  if (report) parts.push(`## Report produced so far\n${report}`);
  if (thinking && report.length <= REPAIR_THINKING_SALVAGE_MAX_REPORT_CHARS) {
    parts.push(`## Reasoning trace (the role's conclusions may be here)\n${thinking}`);
  }
  if (!parts.length) return null;
  return tailCap(parts.join("\n\n"), REPAIR_MATERIAL_MAX_CHARS);
}

/**
 * Repair pass (PLANNING/overhaul/03 §1): reconstruct a verdict trailer from a
 * degraded run's already-produced `material` with ONE cheap, stateless
 * completion, instead of re-running the whole role. Prefers the
 * sampler-guaranteed constrained rung (overhaul/02) when the endpoint supports
 * it, falling back to a plain fenced-JSON completion parsed leniently by the
 * same extractor the text-mode path uses. Returns the reconstructed
 * RoleFindings, or null on any failure (endpoint down, still unparseable) so the
 * caller falls through to synthesizeFallback. Never throws.
 */
export async function formalizeFindings(
  material: string,
  connection: Connection,
  modelId: string,
): Promise<RoleFindings | null> {
  const messages: ChatMessage[] = [
    { role: "system", content: REPAIR_FORMALIZE_PROMPT },
    { role: "user", content: material },
  ];
  // Rung 1: sampler-guaranteed structured decoding.
  if (connection.structuredOutputs.mode !== "off") {
    try {
      const result = await runConstrainedCompletion(
        connection,
        modelId,
        messages,
        RecordFindingsSchema,
        512,
      );
      return findingsFromRecordPayload(result);
    } catch {
      // A constrained failure (e.g. transient 5xx) shouldn't deny the endpoint
      // its unconstrained shot at repair — fall through to the fenced rung.
    }
  }
  // Rung 2: unconstrained fenced JSON.
  try {
    const content = await runPlainCompletion(connection, modelId, messages, 512);
    return extractFindingsFromText(content);
  } catch {
    return null;
  }
}

// ---- Main role runner ----

/**
 * Default number of answer-text characters without a tool call before we
 * pre-emptively inject the stall nudge (token-budget guard). This fires before the
 * model runs out of tokens, giving the retry room to work.
 *
 * In text_mode, reasoning models spend most of their output on <think> analysis
 * before producing the JSON block — a higher threshold gives them room to think.
 *
 * These fire an immediate session.abort() mid-stream (see the message_update
 * handler below), which can cut generation off mid-word — so they're intentionally
 * generous defaults, not a tight budget. Overridable per connection profile via
 * ModelCompat.nudgeThresholdChars / nudgeThresholdCharsTextMode (settings.ts).
 */
const DEFAULT_PREEMPTIVE_NUDGE_CHARS = 8000;
const DEFAULT_PREEMPTIVE_NUDGE_CHARS_TEXT_MODE = 20000;
/**
 * Reasoning/thinking-channel counterpart of the above: a role that reasons at
 * great length without producing much answer text (e.g. twoPhase Phase 1
 * exploration, which has no record_findings tool and often composes its whole
 * answer inside its thinking trace before wrapping up) never trips the
 * answer-text nudge above, and can run until an external/provider-side
 * timeout cuts it off mid-thought — discarding all of that reasoning instead
 * of cleanly handing off to Phase 2's formalize prompt. Deliberately much more
 * generous than the answer-text threshold since deep reasoning here is
 * expected and useful. Overridable via ModelCompat.nudgeThresholdCharsThinking.
 */
const DEFAULT_PREEMPTIVE_NUDGE_CHARS_THINKING = 60000;

/**
 * Final user turn for the constrained-verdict completion (PLANNING/overhaul/02)
 * — sent as a tool-free raw completion (structured.ts), not a pi session
 * prompt, alongside the original system/context and the exploration text as an
 * "assistant" turn. The sampler already guarantees schema conformance, so this
 * only needs to state intent, not repeat the field-by-field format instructions
 * TWO_PHASE_FORMALIZE_PROMPT gives an unconstrained model.
 */
const CONSTRAINED_VERDICT_PROMPT =
  "Your exploration above is complete and already saved as your report — do not repeat it. Now " +
  "output your structured verdict trailer: verdict, summary, open_questions, and coverage (plus " +
  "criteria_results / subtasks / no_decomposition_reason when your role requires them). Leave " +
  "section_md unset.";

export async function runRole(params: RunRoleParams): Promise<RoleRunResult> {
  const textMode = params.textMode === true;
  const emit = params.onEvent ?? (() => {});
  const transcript: string[] = [];
  const toolCalls: ToolCallRecord[] = [];
  let tokens = 0;
  let captured: RoleFindings | undefined;
  let stopReason: string | undefined;

  // Stall detection: flags a turn that's narrating a tool call instead of making one.
  const stallDetector = createStallDetector();
  // Guards against feeding the stall detector the model's final JSON payload, where
  // repeated short lines (e.g. several coverage/criteria_results entries sharing a
  // status value) are normal — not a narration loop. Answer and thinking channels
  // are independent streams, so each gets its own tracker.
  const answerFenceTracker = createFenceTracker();
  const thinkingFenceTracker = createFenceTracker();
  let stalled = false;
  let stallEverDetected = false;
  let stallRetried = false;
  // Under soft stall handling, a narration stall is noted (once) rather than
  // aborted — this latch keeps that note from repeating on every subsequent
  // delta once the detector has latched.
  let stallNoted = false;

  // Pre-emptive nudge tracking: if the model emits a lot of text without ever
  // calling a tool, inject the nudge early.
  let answerTextLenSinceLastTool = 0;
  // Thinking-channel counterpart — tracked separately since a role can reason
  // at length while emitting little/no answer text (see
  // DEFAULT_PREEMPTIVE_NUDGE_CHARS_THINKING above).
  let thinkingTextLenSinceLastTool = 0;
  let preemptiveNudged = false;

  // Cumulative tool-result budget state (PLANNING/overhaul/07 §3) — the
  // char budget itself is computed below once `connection` is resolved.
  let toolResultChars = 0;
  let toolBudgetNudged = false;

  // Text vs. reasoning accumulators. `answerText` is the clean answer (inline
  // <think> stripped); `thinkingText` is the reasoning trace.
  const splitter = createThinkSplitter();
  let answerText = "";
  let thinkingText = "";

  const record = (ev: RoleStreamEvent) => {
    transcript.push(JSON.stringify(ev));
    emit(ev);
  };
  const emitText = (s: string) => {
    if (!s) return;
    answerText += s;
    record({ type: "text", delta: s });
  };
  const emitThinking = (s: string) => {
    if (!s) return;
    thinkingText += s;
    record({ type: "thinking", delta: s });
  };

  const recordFindings = defineTool({
    name: "record_findings",
    label: "Record findings",
    description:
      "Finish this role by recording your verdict trailer: verdict, summary, open questions, and concern coverage. If you are decomposing work, also populate `subtasks` or `no_decomposition_reason` — never leave both empty. If you are a counter-reviewer, also populate `criteria_results` for every criterion in the checklist — a `pass` verdict with this empty will be rejected. Your report itself is delivered separately (via report_section or your prose) — only include `section_md` here if the report was not delivered any other way. Call this exactly once.",
    parameters: RecordFindingsSchema,
    execute: async (_id: string, p: Static<typeof RecordFindingsSchema>) => {
      captured = findingsFromRecordPayload(p);
      return { ...textResult("findings recorded"), terminate: true };
    },
  });

  // ---- report_section: the required reporting channel (artifact-first) ----
  // Zero-path append to this run's own REFINING artifact: each call durably
  // persists one completed report section, so the prose survives truncation,
  // stalls, aborts, and a failed verdict trailer. Dedupes repeated content (a
  // stalling model re-sending the same section, or a retried run re-generating
  // sections a previous attempt already appended) and caps total calls.
  const reportedSections: string[] = [];
  let artifactBytesAppended = 0;
  const reportSection = defineTool({
    name: "report_section",
    label: "Report section",
    description:
      "Append the next completed section of your findings report to this task's planning artifact. " +
      "This is how your work is saved — call it each time a section of your write-up is done " +
      "(start the first section with a \"## <Your Role>\" heading). Do not wait until the end, and " +
      "do not re-send a section you already reported.",
    parameters: ReportSectionSchema,
    execute: async (_id: string, p: Static<typeof ReportSectionSchema>) => {
      const content = (p.content ?? "").trim();
      if (!content) return textResult("error: empty section — nothing appended");
      if (reportedSections.length >= REPORT_SECTION_MAX_CALLS) {
        return textResult(
          `error: report_section call limit (${REPORT_SECTION_MAX_CALLS}) reached — finish now by recording your verdict`,
        );
      }
      if (reportedSections.includes(content)) {
        return textResult("duplicate section ignored (already reported) — do not re-send sections");
      }
      try {
        // A retried run may regenerate sections a previous attempt already
        // appended — checking the file (not just this run's memory) keeps the
        // artifact clean across attempts while still counting the section as
        // part of this run's report.
        const existing = readArtifact(params.artifactAbsPath);
        if (!existing.includes(content)) {
          appendArtifactSection(params.artifactAbsPath, content);
          artifactBytesAppended += Buffer.byteLength(content, "utf8");
        }
        reportedSections.push(content);
        return textResult(`report section ${reportedSections.length} saved`);
      } catch (err) {
        return textResult(`error: ${(err as Error).message}`);
      }
    },
  });

  const gitHistory = defineTool({
    name: GIT_HISTORY_TOOL,
    label: "Git history",
    description:
      "Read-only git log over the repository. Use to see what recently changed near the failing code — pass `path` to scope to a file/dir, `grep` to find commits that touched a string, `since_days` to bound the window.",
    parameters: GitHistorySchema,
    execute: async (_id: string, p: Static<typeof GitHistorySchema>) =>
      textResult(runGitHistory(params.repoPath, p)),
  });

  const writeArtifact = defineTool({
    name: "write_artifact",
    label: "Write artifact",
    description:
      "Append a markdown section to a named file under the project's PLANNING directory (sandboxed). For auxiliary/supporting documents only — your own findings report is delivered through its own channel (report_section, or your prose), not this tool.",
    parameters: WriteArtifactSchema,
    execute: async (_id: string, p: Static<typeof WriteArtifactSchema>) => {
      try {
        const abs = resolveInPlanning(params.repoPath, params.planningDir, p.relative_path);
        appendArtifactSection(abs, p.content);
        return textResult(`appended to ${p.relative_path}`);
      } catch (err) {
        return textResult(`error: ${(err as Error).message}`);
      }
    },
  });

  const twoPhase = params.twoPhase === true;
  const connection = params.connection ?? resolveConnection();

  // Cumulative tool-result budget (PLANNING/overhaul/07 §3): file reads, grep/
  // find/ls output, and exec output all arrive as tool results outside the
  // assembled `context` string, so buildRoleContext's allocator can never see
  // or budget them. `toolResultReserve` (context-budget.ts) reserves a slice
  // of the model's window for exactly this; once this run's cumulative
  // tool-result bytes cross it (tracked in the tool_execution_end handler
  // below), the model is nudged to stop reading and wrap up — same
  // abort+re-prompt shape as the pre-emptive text/thinking nudges, just keyed
  // on tool-result volume instead of narration length.
  const toolResultCharBudget =
    computeBudget({
      contextWindow: connection.contextWindow,
      effectiveContext: connection.effectiveContext,
      maxTokens: 0,
      systemPromptTokens: 0,
    }).toolResultReserve * 4;

  // Grounded verification (PLANNING/overhaul/05). Resolved up here — ahead of
  // the system-prompt assembly below — because the command menu is per-project
  // and has to be *described* to the model, not just registered: a role told to
  // "run the tests" without the menu in front of it invents a command name.
  // Same authoritative-at-run-time posture as write/edit: whatever the role's
  // stored tools_json says, the tool only exists if the project's policy says
  // so AND there is a non-empty menu behind it.
  const harnessPolicy = params.harnessPolicy ?? DEFAULT_HARNESS_POLICY;
  const wantsExec = params.tools.includes(EXEC_TOOL_NAME) && execEnabled(harnessPolicy);
  const execMaxRuns = harnessPolicy.execMaxRuns ?? DEFAULT_EXEC_MAX_RUNS;
  const execInstruction = wantsExec ? buildExecToolInstruction(harnessPolicy, execMaxRuns) : "";

  // Output contract: "artifact-first" (default — report streams to the artifact,
  // structure shrinks to a verdict trailer) vs "v1" (legacy full-blob JSON with
  // section_md embedded). Per-connection revert switch, no deploy needed.
  const artifactFirst = (connection.compat.outputContract ?? "artifact-first") !== "v1";
  // report_section needs an owned artifact to append to — critique passes,
  // router mini-calls and the recap pass "" and run without it (their prose
  // still lands in section_md via assembleReport).
  const wantsReportSection = artifactFirst && !!params.artifactAbsPath;

  // Constrained decoding (PLANNING/overhaul/02): when the connection's endpoint
  // has been probed (or manually overridden) to support server-side structured
  // decoding, the verdict trailer is delivered by a tool-free constrained
  // completion (structured.ts) instead of the record_findings tool call — a
  // constrained turn can't also make tool calls, so this generalizes twoPhase's
  // two-turn shape to be automatic whenever it's available, regardless of the
  // connection's own twoPhase/textMode setting. textMode keeps its existing
  // fenced-JSON contract untouched (retiring it is a later, separate migration
  // step — see the doc's migration section).
  const useConstrainedVerdict = !textMode && connection.structuredOutputs.mode !== "off";
  // True whenever the run must NOT register record_findings and instead ends
  // its tool-using turn(s) with plain exploration prose — either because the
  // connection is configured for legacy twoPhase, or because a constrained
  // completion will supply the verdict afterward.
  const explorationOnly = twoPhase || useConstrainedVerdict;

  // Softer stall handling (PLANNING/overhaul/03 §3): when the connection opts in,
  // the pre-emptive character-count nudges and narration-pattern stalls stop
  // firing a mid-stream abort — the turn is allowed to finish (bounded by the
  // provider's max_tokens) and the verdict is recovered afterward by the
  // constrained/repair ladder. A repetition-loop stall still aborts (its
  // remaining stream is provably worthless). Default off — today's behavior.
  const softStall = connection.compat.retirePreemptiveNudge === true;

  // System prompt: explorationOnly supersedes textMode — it uses the
  // exploration-phase contract (no record_findings tool, just explore and
  // report naturally). Within each mode, the artifact-first / v1 contract picks
  // the instruction variant; tool mode only advertises report_section when it
  // is registered.
  const disciplineSuffix = explorationOnly
    ? artifactFirst
      ? TWO_PHASE_EXPLORE_CONTRACT
      : TWO_PHASE_EXPLORE_CONTRACT_V1
    : textMode
      ? artifactFirst
        ? TEXT_MODE_INSTRUCTION
        : TEXT_MODE_INSTRUCTION_V1
      : wantsReportSection
        ? TOOL_CALL_DISCIPLINE
        : TOOL_CALL_DISCIPLINE_V1;
  // The fully composed system prompt — reused verbatim by the constrained
  // verdict completion below, so the out-of-session turn sees exactly the same
  // instructions (including the exec menu) the in-session turns did.
  const systemPrompt =
    params.systemPrompt + (execInstruction ? `\n\n${execInstruction}` : "") + "\n\n" + disciplineSuffix;
  const thinkingBudgets = params.thinkingBudgets ?? connection.thinkingBudgets;
  const settingsManager = SettingsManager.inMemory(
    thinkingBudgets ? { thinkingBudgets } : undefined,
  );
  const nudgeThresholdChars =
    connection.compat.nudgeThresholdChars ?? DEFAULT_PREEMPTIVE_NUDGE_CHARS;
  const nudgeThresholdCharsTextMode =
    connection.compat.nudgeThresholdCharsTextMode ?? DEFAULT_PREEMPTIVE_NUDGE_CHARS_TEXT_MODE;
  const nudgeThresholdCharsThinking =
    connection.compat.nudgeThresholdCharsThinking ?? DEFAULT_PREEMPTIVE_NUDGE_CHARS_THINKING;
  const loader = new DefaultResourceLoader({
    cwd: params.repoPath,
    agentDir: getAgentDir(),
    settingsManager,
    systemPrompt,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();

  const model = ensureModel(params.modelId, connection);

  // `git_history` is a custom tool, not a pi builtin — pull it out of the builtin
  // allowlist and register it as a custom tool only for roles that opt in.
  // `write`/`edit` are pi builtins too, but pi resolves their paths unguarded
  // (plain path.resolve, no jail) — never let those reach the builtin allowlist
  // either. They're only ever registered below as custom tools backed by our
  // own worktree-jailed operations, and only when the resolved project harness
  // policy allows it (independent of what the role's tools_json requests).
  // `run_command` (overhaul/05) is the same shape of grant — resolved further
  // up (wantsExec) because its menu also feeds the system prompt.
  const wantsGit = params.tools.includes(GIT_HISTORY_TOOL);
  const wantsWrite = params.tools.includes("write") && harnessPolicy.allowWrite;
  const wantsEdit = params.tools.includes("edit") && harnessPolicy.allowWrite;
  const builtinTools = params.tools.filter(
    (t) =>
      t !== GIT_HISTORY_TOOL &&
      t !== EXEC_TOOL_NAME &&
      !(WRITE_TOOL_NAMES as readonly string[]).includes(t),
  );

  // In textMode or explorationOnly (twoPhase / constrained-verdict), strip
  // record_findings from custom tools — the model must finish with plain
  // exploration prose instead. report_section (when the run owns an artifact),
  // write_artifact and git_history remain available in every mode: a
  // text/exploration-only model that CAN custom-tool-call still benefits from
  // streaming report sections durably.
  const wantsRecordFindings = !textMode && !explorationOnly;
  const customTools: ReturnType<typeof defineTool>[] = [writeArtifact];
  if (wantsReportSection) customTools.unshift(reportSection);
  if (wantsRecordFindings) customTools.unshift(recordFindings);
  if (wantsGit) customTools.push(gitHistory);

  // Every fs operation the write/edit tools perform goes through this guard
  // first — it's the only thing standing between a granted write/edit tool
  // and the rest of the filesystem. A thrown error here propagates out of
  // pi's tool `execute()` and is turned into a normal isError tool result by
  // its agent-loop (verified against @earendil-works/pi-agent-core), so no
  // try/catch is needed here.
  const touchedRelPaths = new Set<string>();
  if (wantsWrite || wantsEdit) {
    if (!isWorktreePath(params.repoPath)) {
      throw new Error(
        `refusing to grant write/edit tools: repoPath "${params.repoPath}" is not an isolated task worktree`,
      );
    }
    const guard = (absPath: string) => assertInsideWorktree(params.repoPath, absPath);
    const recordTouched = (abs: string) => touchedRelPaths.add(path.relative(params.repoPath, abs));
    if (wantsWrite) {
      customTools.push(
        defineTool(
          createWriteToolDefinition(params.repoPath, {
            operations: {
              writeFile: async (absolutePath, content) => {
                const abs = guard(absolutePath);
                await fsp.writeFile(abs, content, "utf8");
                recordTouched(abs);
              },
              mkdir: async (dir) => {
                await fsp.mkdir(guard(dir), { recursive: true });
              },
            },
          }),
        ),
      );
    }
    if (wantsEdit) {
      customTools.push(
        defineTool(
          createEditToolDefinition(params.repoPath, {
            operations: {
              readFile: async (absolutePath) => fsp.readFile(guard(absolutePath)),
              access: async (absolutePath) => {
                await fsp.access(guard(absolutePath), fs.constants.R_OK | fs.constants.W_OK);
              },
              writeFile: async (absolutePath, content) => {
                const abs = guard(absolutePath);
                await fsp.writeFile(abs, content, "utf8");
                recordTouched(abs);
              },
            },
          }),
        ),
      );
    }
  }

  // ---- run_command: allowlisted execution in the task worktree (overhaul/05) ----
  // Same jail assertion as write/edit, and for a strictly stronger reason: the
  // command runs with the daemon's privileges, so it must at least be confined
  // to a throwaway worktree rather than the user's live checkout. Refusing
  // loudly (rather than silently dropping the tool) surfaces a misconfiguration
  // that would otherwise look like a model that just never verified anything.
  const execEvidence: ExecEvidence[] = [];
  if (wantsExec) {
    if (!isWorktreePath(params.repoPath)) {
      throw new Error(
        `refusing to grant ${EXEC_TOOL_NAME}: repoPath "${params.repoPath}" is not an isolated task worktree`,
      );
    }
    const execEnv = buildExecEnv(harnessPolicy);
    const defaultTimeout = harnessPolicy.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    const maxOutputBytes = harnessPolicy.execMaxOutputBytes ?? DEFAULT_EXEC_MAX_OUTPUT_BYTES;
    const menu = (harnessPolicy.execAllowlist ?? []).map((c) => c.name).join(", ");
    customTools.push(
      defineTool({
        name: EXEC_TOOL_NAME,
        label: "Run command",
        description:
          `Run one of this project's pre-approved commands inside your task worktree and see its real ` +
          `output. Available: ${menu}. This is a menu, not a shell — pass the command's NAME, never a ` +
          `command line. The exit code and output are recorded as verification evidence by the platform.`,
        parameters: RunCommandSchema,
        execute: async (_id: string, p: Static<typeof RunCommandSchema>) => {
          const resolved = resolveExecInvocation(harnessPolicy, p.name, p.args);
          if (!resolved.ok) return textResult(`error: ${resolved.error}`);
          // Budget is enforced on *attempts that would run something*, and only
          // after resolution — a rejected/misspelled call shouldn't consume it.
          if (execEvidence.length >= execMaxRuns) {
            return textResult(
              `error: command budget exhausted (${execMaxRuns} runs this turn) — stop running commands ` +
                `and record your verdict based on what you have already observed`,
            );
          }
          // A running command produces no model-stream events, and the
          // orchestrator's idle watchdog aborts a run that goes quiet for a
          // full requestTimeoutMs window (orchestrator.ts's armIdleTimer). A
          // suite that legitimately takes minutes would trip it, so the tool
          // heartbeats: each status event resets that watchdog and doubles as
          // live "still running" feedback in the activity pane.
          const startedMs = Date.now();
          record({ type: "status", message: `running \`${resolved.command.name}\`…` });
          const heartbeat = setInterval(() => {
            record({
              type: "status",
              message: `still running \`${resolved.command.name}\` (${Math.round(
                (Date.now() - startedMs) / 1000,
              )}s)`,
            });
          }, EXEC_HEARTBEAT_MS);
          let evidence: ExecEvidence;
          try {
            evidence = await runExecCommand({
              name: resolved.command.name,
              argv: resolved.argv,
              cwd: params.repoPath,
              timeoutMs: resolved.command.timeoutMs ?? defaultTimeout,
              maxOutputBytes,
              env: execEnv,
              signal: params.signal,
            });
          } finally {
            clearInterval(heartbeat);
          }
          execEvidence.push(evidence);
          record({
            type: "status",
            message: `ran \`${evidence.name}\`: ${
              evidence.spawnError
                ? `could not start (${evidence.spawnError})`
                : evidence.timedOut
                  ? "timed out"
                  : `exit ${evidence.exitCode}`
            }`,
          });
          if (evidence.spawnError) {
            return textResult(
              `command "${evidence.name}" could not be started: ${evidence.spawnError}. This is an ` +
                `environment problem, not something your code change caused — report it rather than ` +
                `working around it.`,
            );
          }
          const tail = evidence.outputTail.slice(-EXEC_TOOL_RESULT_TAIL_CHARS);
          const header = evidence.timedOut
            ? `TIMED OUT after ${Math.round(evidence.durationMs / 1000)}s (killed)`
            : `exit code ${evidence.exitCode} after ${Math.round(evidence.durationMs / 1000)}s`;
          return textResult(`$ ${evidence.argv.join(" ")}\n${header}\n\n${tail || "(no output)"}`);
        },
      }),
    );
  }

  const { session } = await createAgentSession({
    cwd: params.repoPath,
    model,
    modelRegistry: getRegistry(),
    settingsManager,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    tools: builtinTools,
    customTools,
    thinkingLevel: params.thinkingLevel,
  });

  // Feed streamed text (either channel — narration can land in the answer or the
  // reasoning trace) to the stall detector; abort the turn the moment it fires
  // instead of waiting for the token budget to run out.
  const checkStall = (s: string) => {
    if (!s || stalled || captured) return;
    if (!stallDetector.push(s)) return;
    const why = stallDetector.reason();
    stallEverDetected = true;
    // A repetition loop's remaining stream is provably worthless — always abort.
    // A narration stall aborts too UNLESS soft handling is on, in which case the
    // turn is left to finish and the verdict comes from the repair pass after.
    if (why === "repetition" || !softStall) {
      stalled = true;
      record({
        type: "status",
        message: `detected ${why ?? "repeat/narration"} stall — aborting this turn`,
      });
      void session.abort();
    } else if (!stallNoted) {
      stallNoted = true;
      record({
        type: "status",
        message: `noted ${why} stall — letting the turn finish (soft stall handling)`,
      });
    }
  };

  // Thinking-channel pre-emptive nudge: a role can reason at length while
  // emitting little/no answer text (twoPhase Phase 1 has no record_findings
  // tool, so it may compose its whole answer inside its thinking trace before
  // ever wrapping up) — the answer-text nudge above never trips for that
  // shape of run, leaving it to run until an external/provider timeout
  // discards everything. This mirrors that guard for the thinking channel.
  const checkThinkingNudge = (d: string) => {
    // Soft stall handling retires the character-count pre-emptive nudges as
    // abort triggers entirely (overhaul/03 §3) — the turn runs to max_tokens.
    if (softStall || !d || preemptiveNudged || captured || stalled) return;
    thinkingTextLenSinceLastTool += d.length;
    if (thinkingTextLenSinceLastTool >= nudgeThresholdCharsThinking) {
      preemptiveNudged = true;
      record({
        type: "status",
        message:
          "pre-emptive nudge: model has reasoned at length without a tool call — requesting action",
      });
      void session.abort();
    }
  };

  const unsubscribe = session.subscribe((ev) => {
    switch (ev.type) {
      case "message_update": {
        const ame = ev.assistantMessageEvent as { type?: string; delta?: string; text?: string };
        if (ame?.type === "text_delta") {
          // Route through the splitter: inline <think> goes to the reasoning channel.
          const { text, thinking } = splitter.push(ame.delta ?? ame.text ?? "");
          emitText(text);
          emitThinking(thinking);
          // In text_mode, only the answer text (not reasoning) feeds stall
          // detection — the model is supposed to "narrate" in <think> blocks.
          // Both channels are filtered through their fence tracker first: once the
          // model opens a ```-fenced block it's writing its final JSON payload, not
          // narrating, so that content must not reach the stall detector.
          checkStall(answerFenceTracker.push(text).outside);
          if (!textMode) checkStall(thinkingFenceTracker.push(thinking).outside);
          checkThinkingNudge(thinking);

          // Track answer text length since last tool call for pre-emptive nudge.
          if (text.length > 0) {
            answerTextLenSinceLastTool += text.length;
            const nudgeThreshold = textMode
              ? nudgeThresholdCharsTextMode
              : nudgeThresholdChars;
            if (
              !softStall &&
              !preemptiveNudged &&
              !captured &&
              !stalled &&
              answerTextLenSinceLastTool >= nudgeThreshold
            ) {
              preemptiveNudged = true;
              record({
                type: "status",
                message:
                  "pre-emptive nudge: model has produced significant text without a tool call — requesting action",
              });
              void session.abort();
            }
          }
        } else if (ame?.type === "thinking_delta") {
          // Native reasoning channel (endpoints that emit reasoning_content).
          const d = ame.delta ?? "";
          emitThinking(d);
          if (!textMode) checkStall(thinkingFenceTracker.push(d).outside);
          checkThinkingNudge(d);
        }
        break;
      }
      case "tool_execution_start":
        record({ type: "tool_start", tool: ev.toolName, args: ev.args });
        // Reset pre-emptive nudge tracking on any tool call.
        answerTextLenSinceLastTool = 0;
        thinkingTextLenSinceLastTool = 0;
        break;
      case "tool_execution_end": {
        // On rejection (e.g. schema validation failure), pi wraps the error
        // message as a text content block in `result` — surface it so failed
        // record_findings calls are diagnosable without transcript spelunking.
        const resultBlocks = ev.result?.content as { type: string; text?: string }[] | undefined;
        const errText = ev.isError ? resultBlocks?.find((c) => c.type === "text")?.text : undefined;
        toolCalls.push({ tool: ev.toolName, args: undefined, isError: ev.isError, error: errText });
        record({ type: "tool_end", tool: ev.toolName, isError: ev.isError, error: errText });

        // Cumulative tool-result budget (PLANNING/overhaul/07 §3) — every tool
        // result counts (not just successes): an error message is still text
        // the model has to read and reason about.
        for (const block of resultBlocks ?? []) {
          if (block.type === "text") toolResultChars += block.text?.length ?? 0;
        }
        if (
          !softStall &&
          !toolBudgetNudged &&
          !preemptiveNudged &&
          !captured &&
          !stalled &&
          toolResultChars >= toolResultCharBudget
        ) {
          toolBudgetNudged = true;
          record({
            type: "status",
            message: `pre-emptive nudge: tool-result budget (~${Math.round(toolResultCharBudget / 1000)}k chars) reached — requesting a wrap-up`,
          });
          void session.abort();
        }
        break;
      }
      case "message_end": {
        const msg = ev.message as { usage?: { input?: number; output?: number }; stopReason?: string };
        if (msg.usage) tokens += (msg.usage.input ?? 0) + (msg.usage.output ?? 0);
        if (msg.stopReason) stopReason = msg.stopReason;
        break;
      }
      default:
        break;
    }
  });

  try {
    if (params.signal) {
      params.signal.addEventListener("abort", () => void session.abort(), { once: true });
    }
    const modeLabel = useConstrainedVerdict
      ? "running (explore + constrained verdict)"
      : twoPhase
        ? "running (phase 1/2)"
        : textMode
          ? "running (text mode)"
          : "running";
    emit({ type: "status", message: modeLabel });

    // ---- Phase 1: Exploration (explorationOnly) or single-turn (normal/textMode) ----
    try {
      await session.prompt(params.context);
    } catch (err) {
      // Only swallow the abort we triggered ourselves via checkStall / preemptive
      // nudge / tool-result budget — a real external cancellation (params.signal)
      // must still propagate so the orchestrator's existing abort handling
      // (needs_human escalation) applies.
      const selfAbort = stalled || preemptiveNudged || toolBudgetNudged;
      if (!selfAbort || params.signal?.aborted) throw err;
    }

    // Retry logic for stall/preemptive-nudge/tool-budget: if the model was
    // narrating without acting, or has read enough tool output to risk
    // crowding out its verdict, inject the matching nudge and give it one more
    // chance. In explorationOnly mode (twoPhase or constrained-verdict),
    // retries are disabled — if exploration stalls or hits the tool-result
    // budget we proceed directly to the formalize/constrained step, which
    // gives the model (or the raw completion) a clean shot at output.
    if ((stalled || preemptiveNudged || toolBudgetNudged) && !captured && !stallRetried && !explorationOnly) {
      stallRetried = true;
      const wasToolBudgetNudge = toolBudgetNudged && !stalled && !preemptiveNudged;
      stalled = false;
      preemptiveNudged = false;
      toolBudgetNudged = false;
      stallDetector.reset();
      answerFenceTracker.reset();
      thinkingFenceTracker.reset();
      answerTextLenSinceLastTool = 0;
      record({
        type: "status",
        message: wasToolBudgetNudge
          ? "retrying: wrapping up after the tool-result budget"
          : "retrying: call the tool directly instead of narrating it",
      });
      try {
        await session.prompt(wasToolBudgetNudge ? TOOL_RESULT_BUDGET_NUDGE : STALL_NUDGE);
      } catch (err) {
        const selfAbort = stalled || preemptiveNudged || toolBudgetNudged;
        if (!selfAbort || params.signal?.aborted) throw err;
      }
    }

    // ---- Phase 2: Formalize (explorationOnly only) ----
    // After exploration, get the structured verdict. Constrained-verdict
    // connections (PLANNING/overhaul/02) use a tool-free raw completion outside
    // pi (constrainedResult, handled after this try/finally, since it needs no
    // session/tools and a thrown ConstrainedCompletionError must fall through to
    // the normal recovery ladder below rather than propagate). Legacy twoPhase
    // connections without a constrained rung keep sending a second in-session
    // prompt asking the model to formalize its findings as JSON.
    if (twoPhase && !useConstrainedVerdict && !captured) {
      // Reset stall state for the formalization turn.
      stalled = false;
      preemptiveNudged = false;
      toolBudgetNudged = false;
      stallDetector.reset();
      answerFenceTracker.reset();
      thinkingFenceTracker.reset();
      answerTextLenSinceLastTool = 0;

      record({ type: "status", message: "phase 2: formalizing findings as structured JSON" });
      try {
        await session.prompt(artifactFirst ? TWO_PHASE_FORMALIZE_PROMPT : TWO_PHASE_FORMALIZE_PROMPT_V1);
      } catch (err) {
        // Self-aborts during phase 2 are tolerable — we'll fall back to extracting
        // whatever text was produced. External cancellations still propagate.
        const selfAbort = stalled || preemptiveNudged || toolBudgetNudged;
        if (!selfAbort || params.signal?.aborted) throw err;
      }
    }
  } finally {
    unsubscribe();
  }

  // Flush any trailing text held back for partial-tag detection.
  const tail = splitter.flush();
  emitText(tail.text);
  emitThinking(tail.thinking);

  // ---- Verdict recovery ladder ----
  // constrained completion ("constrained", schema-valid by construction) →
  // record_findings ("tool") → trailing JSON fence in the answer text ("fence",
  // which also yields the report prose around the fence) → synthesized verdict
  // ("fallback"). In every rung the report survives: assembleReport below
  // sources section_md from the durable/reliable prose, so a failed trailer
  // costs only the ~4-field verdict, never the write-up.
  let fallback = false;
  let phase: number | undefined;
  let verdictSource: VerdictSource = "tool";
  let fenceProse: string | undefined;

  if (explorationOnly) {
    // captured is never set by a tool in explorationOnly mode (record_findings
    // isn't registered) — the formalize/constrained step completed unless
    // exploration stalled out.
    phase = stalled ? 1 : 2;
  }

  // ---- Constrained verdict completion (outside pi, PLANNING/overhaul/02) ----
  // This call needs no tools/streaming, so it is a plain fetch (structured.ts),
  // not a further session.prompt() — run once the pi session has closed and the
  // full exploration text is flushed. Any failure (unsupported, network, schema
  // mismatch) is swallowed here — the extractFindingsAndProse/fallback ladder
  // right below is the safety net.
  if (useConstrainedVerdict && !captured) {
    record({ type: "status", message: "formalizing verdict via constrained completion" });
    try {
      const messages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: params.context },
        { role: "assistant", content: answerText.trim() || "(no exploration text produced)" },
        { role: "user", content: CONSTRAINED_VERDICT_PROMPT },
      ];
      const result = await runConstrainedCompletion(
        connection,
        params.modelId,
        messages,
        RecordFindingsSchema,
        1024,
      );
      captured = findingsFromRecordPayload(result);
      verdictSource = "constrained";
    } catch (err) {
      record({
        type: "status",
        message: `constrained verdict call failed, falling back: ${(err as Error).message}`,
      });
    }
  }

  let repairAttempted = false;

  if (!captured) {
    const extracted = extractFindingsAndProse(answerText);
    if (extracted) {
      captured = extracted.findings;
      fenceProse = extracted.prose;
      verdictSource = "fence";
    }
  }

  // ---- Repair pass (PLANNING/overhaul/03 §1) ----
  // Every in-session verdict channel failed (no tool call, no constrained turn,
  // no parseable fence). Before synthesizing an empty fallback, spend one cheap
  // stateless formalize call to reconstruct the verdict from what the role
  // already produced (its report + reasoning tail) — in most degraded runs the
  // analysis exists and only the serialization failed, so this converts the
  // majority of would-be fallbacks at a fraction of a full re-run's cost. The
  // report itself is already safe (assembleReport sources it from the durable
  // prose below), so repair only has to rebuild the ~4-field trailer.
  if (!captured) {
    const material = buildRepairMaterial({ reportedSections, answerText, thinkingText });
    if (material) {
      repairAttempted = true;
      record({ type: "status", message: "repair: reconstructing verdict from produced material" });
      const repaired = await formalizeFindings(material, connection, params.modelId);
      if (repaired) {
        captured = repaired;
        verdictSource = "repair";
        record({ type: "status", message: "repair: verdict reconstructed" });
      }
    }
  }

  if (!captured) {
    fallback = true;
    verdictSource = "fallback";
    captured = synthesizeFallback(
      answerText,
      stallEverDetected,
      stallRetried,
      preemptiveNudged,
      stopReason,
    );
  }

  // ---- Fallback synthesis: verdict only ----
  // section_md is left empty here on purpose — the report is assembled below
  // from the durable sources (report_section appends / answer prose), so the
  // synthesized part is only the missing verdict.
  function synthesizeFallback(
    text: string,
    everStalled: boolean,
    retried: boolean,
    nudged: boolean,
    reason: string | undefined,
  ): RoleFindings {
    if (!text) {
      text = answerText; // fallback to accumulated text in closure
    }
    const stallReason = everStalled
      ? `Role repeated itself / narrated tool use without invoking it${
          retried ? " (even after a direct nudge)" : ""
        }; captured raw output.`
      : nudged && !everStalled
        ? "Model produced substantial text without any tool call; captured raw output."
        : reason === "length"
          ? "Output was truncated (hit the token limit) before the role recorded a verdict."
          : "Role finished without a structured verdict; captured raw output.";

    const narrationNote = hasNarrationPattern(text)
      ? " (model was still narrating intent to call tools at end of run)"
      : "";

    return {
      verdict: "needs_more",
      summary: stallReason + narrationNote,
      open_questions: [],
      coverage: [],
      section_md: "",
      criteria_results: [],
    };
  }

  // ---- Report assembly: section_md is an assembled value, not a transmitted one ----
  const assembled = assembleReport({
    reportedSections,
    trailerSectionMd: captured.section_md,
    fenceProse,
    answerText,
  });
  captured.section_md = assembled.sectionMd;

  const failedCalls = toolCalls.filter((tc) => tc.isError);
  if (fallback || stopReason === "length" || stallEverDetected || failedCalls.length > 0) {
    console.warn(
      `[agent] role run: model=${params.modelId} stop=${stopReason ?? "?"} ` +
        `fallback=${fallback} verdictSource=${verdictSource} repairAttempted=${repairAttempted} ` +
        `stalled=${stallEverDetected} retried=${stallRetried} ` +
        `textMode=${textMode} twoPhase=${twoPhase} constrained=${useConstrainedVerdict} tokens=${tokens} ` +
        `answer_chars=${answerText.length} thinking_chars=${thinkingText.length} ` +
        `artifact_bytes_appended=${artifactBytesAppended} ` +
        `exec_runs=${execEvidence.length}${
          execEvidence.length ? ` (${execEvidence.map(describeEvidence).join("; ")})` : ""
        }`,
    );
    for (const tc of failedCalls) {
      console.warn(`[agent]   tool call failed: ${tc.tool} — ${tc.error ?? "(no error text)"}`);
    }
  }

  session.dispose();

  return {
    findings: captured,
    toolCalls,
    transcriptJsonl: transcript.join("\n"),
    tokens,
    model: params.modelId,
    fallback,
    stalled: stallEverDetected,
    phase,
    stopReason,
    thinkingText,
    filesWritten: [...touchedRelPaths],
    artifactBytesAppended,
    verdictSource,
    repairAttempted,
    artifactResidualMd: assembled.artifactResidualMd,
    evidence: execEvidence,
  };
}
