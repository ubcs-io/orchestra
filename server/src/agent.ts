/**
 * Repo-aware role execution over pi (the key mechanism, §5).
 *
 * `runRole()` runs one refinement step as a pi AgentSession: the role's persona
 * is the system prompt, it gets read-only repo tools plus two custom tools —
 * `record_findings` (the required structured finisher) and `write_artifact`
 * (sandboxed to PLANNING). pi's event stream is forwarded to `onEvent` for the
 * live SSE view and captured to a transcript for replay.
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
import { appendArtifactSection, assertInsideWorktree, isWorktreePath, resolveInPlanning } from "./git.js";
import { ensureModel, getRegistry } from "./providers.js";
import { resolveConnection, type Connection, type ThinkingBudgets } from "./settings.js";
import { TWO_PHASE_EXPLORE_CONTRACT, TWO_PHASE_FORMALIZE_PROMPT } from "./roles.js";
import { DEFAULT_HARNESS_POLICY, WRITE_TOOL_NAMES, type HarnessPolicy } from "./harness-policy.js";

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

export interface RoleFindings {
  verdict: Verdict;
  summary: string;
  open_questions: OpenQuestion[];
  coverage: CoverageItem[];
  section_md: string;
  /** Present only for counter-reviewer roles; one entry per acceptance criterion. */
  criteria_results?: CriteriaResult[];
}

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
}

export interface RunRoleParams {
  repoPath: string;
  planningDir: string;
  /** Absolute path to the task's REFINING artifact (write_artifact target default). */
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

const RecordFindingsSchema = Type.Object({
  verdict: Type.Union([
    Type.Literal("pass"),
    Type.Literal("needs_more"),
    Type.Literal("blocker"),
    Type.Literal("needs_human"),
  ]),
  summary: Type.String(),
  open_questions: Type.Optional(Type.Array(OpenQuestionSchema)),
  coverage: Type.Optional(Type.Array(CoverageSchema)),
  section_md: Type.String(),
  criteria_results: Type.Optional(Type.Array(CriteriaResultSchema)),
});

const WriteArtifactSchema = Type.Object({
  relative_path: Type.String({
    description: "Path relative to the project's PLANNING directory. Cannot escape it.",
  }),
  content: Type.String(),
});

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
  "When you are ready to use a tool, invoke it directly as a function call — never describe or " +
  'narrate the call in plain text (e.g. do not write "Let me call record_findings now" or similar). ' +
  "Plain text should contain your analysis, not announcements of tool use.\n\n" +
  "When you are done, call the `record_findings` tool EXACTLY ONCE with the fields described in " +
  '"How to finish" above. record_findings is a platform custom tool and IS available to you. Even ' +
  'if it does not appear in a separate "built-in" tool list, it is registered and ready — just ' +
  'call it. You will not get a "tool not found" error for it. Do not question whether it exists — ' +
  "invoke it when you are done.";

const STALL_NUDGE =
  "You just described calling a tool in plain text, repeatedly, without actually invoking it. Stop " +
  "narrating and invoke the tool directly as a function call right now, using your best current " +
  "assessment. If you genuinely need more information first, use the available read-only tools to " +
  "get it, then call record_findings — do not write about your intentions.";

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
 * Instruction appended to the system prompt when textMode is on. The model is told
 * to output its findings as a JSON code block instead of using record_findings.
 */
export const TEXT_MODE_INSTRUCTION = `
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
 */
export function createStallDetector(
  repThreshold = STALL_REPEAT_THRESHOLD,
  narrationThreshold = STALL_REPEAT_THRESHOLD,
) {
  let buffer = "";
  const seen = new Map<string, number>();
  let narrationCount = 0;
  let stalled = false;
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
            break;
          }
        }

        // Narration pattern check: the model is talking about calling a tool.
        if (hasNarrationPattern(raw)) {
          narrationCount += 1;
          if (narrationCount >= narrationThreshold) {
            stalled = true;
            break;
          }
        }
      }
      return stalled;
    },
    reset(): void {
      buffer = "";
      seen.clear();
      narrationCount = 0;
      stalled = false;
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

// ---- JSON extraction for text-mode and fallback recovery ----

/**
 * Try to extract a RoleFindings object from a JSON code fence in the answer text.
 * Handles models (including markdown-fenced) and raw JSON. Returns the parsed
 * findings on success, or null if no valid JSON block is found.
 */
export function extractFindingsFromText(text: string): RoleFindings | null {
  if (!text) return null;

  // Try ```json ... ``` fence first (most common for text-mode output).
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  // Find the LAST fence — models often put the JSON at the end.
  let lastFence: string | null = null;
  while ((m = fence.exec(text)) !== null) {
    lastFence = m[1]!.trim();
  }

  if (lastFence) {
    const parsed = tryParseFindings(lastFence);
    if (parsed) return parsed;
  }

  // Try unclosed fence: an opening ```json ... without a closing ```.
  // This handles models whose output was cut off mid-response (e.g. pre-emptive
  // nudge or token limit). We take everything after the LAST opening fence and
  // attempt a best-effort parse.
  const openFence = /```(?:json)?\s*\n([\s\S]*?)$/;
  const om = openFence.exec(text);
  if (om?.[1]) {
    const partial = om[1].trim();
    if (partial.length > 20) {
      const parsed = tryParseFindings(partial);
      if (parsed) return parsed;
      // Best-effort: extract individual fields even from unparseable JSON.
      const salvaged = salvageFieldsFromPartialJson(partial);
      if (salvaged) return salvaged;
    }
  }

  // Fallback: try parsing the entire text as raw JSON (unlikely but possible).
  return tryParseFindings(text.trim());
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

/** Parse a JSON string as RoleFindings, validating required fields. */
function tryParseFindings(json: string): RoleFindings | null {
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    // Must have at least verdict, summary, section_md.
    if (
      typeof obj.verdict !== "string" ||
      typeof obj.summary !== "string" ||
      typeof obj.section_md !== "string"
    ) {
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
      section_md: obj.section_md,
      criteria_results: Array.isArray(obj.criteria_results)
        ? (obj.criteria_results as CriteriaResult[])
        : undefined,
    };
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
  let stalled = false;
  let stallEverDetected = false;
  let stallRetried = false;

  // Pre-emptive nudge tracking: if the model emits a lot of text without ever
  // calling a tool, inject the nudge early.
  let answerTextLenSinceLastTool = 0;
  let preemptiveNudged = false;

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
      "Finish this role by recording your verdict, summary, open questions, concern coverage, and the markdown section for the planning artifact. Call this exactly once.",
    parameters: RecordFindingsSchema,
    execute: async (_id: string, p: Static<typeof RecordFindingsSchema>) => {
      captured = {
        verdict: p.verdict,
        summary: p.summary,
        open_questions: (p.open_questions ?? []).map((q) => ({ ...q, resolved: "assumed" as const })),
        coverage: (p.coverage ?? []) as CoverageItem[],
        section_md: p.section_md,
        criteria_results: (p.criteria_results ?? []) as CriteriaResult[],
      };
      return { ...textResult("findings recorded"), terminate: true };
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
      "Append a markdown section to a file under the project's PLANNING directory (sandboxed). Optional: the orchestrator already persists your section_md.",
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

  // System prompt: twoPhase supersedes textMode — it uses the exploration-phase
  // contract (no record_findings tool, just explore and summarize naturally).
  const twoPhase = params.twoPhase === true;
  const disciplineSuffix = twoPhase
    ? TWO_PHASE_EXPLORE_CONTRACT
    : textMode
      ? TEXT_MODE_INSTRUCTION
      : TOOL_CALL_DISCIPLINE;

  const connection = params.connection ?? resolveConnection();
  const thinkingBudgets = params.thinkingBudgets ?? connection.thinkingBudgets;
  const settingsManager = SettingsManager.inMemory(
    thinkingBudgets ? { thinkingBudgets } : undefined,
  );
  const nudgeThresholdChars =
    connection.compat.nudgeThresholdChars ?? DEFAULT_PREEMPTIVE_NUDGE_CHARS;
  const nudgeThresholdCharsTextMode =
    connection.compat.nudgeThresholdCharsTextMode ?? DEFAULT_PREEMPTIVE_NUDGE_CHARS_TEXT_MODE;
  const loader = new DefaultResourceLoader({
    cwd: params.repoPath,
    agentDir: getAgentDir(),
    settingsManager,
    systemPrompt: params.systemPrompt + "\n\n" + disciplineSuffix,
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
  const harnessPolicy = params.harnessPolicy ?? DEFAULT_HARNESS_POLICY;
  const wantsGit = params.tools.includes(GIT_HISTORY_TOOL);
  const wantsWrite = params.tools.includes("write") && harnessPolicy.allowWrite;
  const wantsEdit = params.tools.includes("edit") && harnessPolicy.allowWrite;
  const builtinTools = params.tools.filter(
    (t) => t !== GIT_HISTORY_TOOL && !(WRITE_TOOL_NAMES as readonly string[]).includes(t),
  );

  // In textMode or twoPhase, strip record_findings from custom tools — the model
  // must output findings in text instead. write_artifact and git_history remain
  // available for both exploration phases.
  const wantsRecordFindings = !textMode && !twoPhase;
  const customTools: ReturnType<typeof defineTool>[] = [writeArtifact];
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
    if (stallDetector.push(s)) {
      stalled = true;
      stallEverDetected = true;
      record({ type: "status", message: "detected repeated/narration stall — aborting this turn" });
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
          checkStall(text);
          if (!textMode) checkStall(thinking);

          // Track answer text length since last tool call for pre-emptive nudge.
          if (text.length > 0) {
            answerTextLenSinceLastTool += text.length;
            const nudgeThreshold = textMode
              ? nudgeThresholdCharsTextMode
              : nudgeThresholdChars;
            if (
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
          if (!textMode) checkStall(d);
        }
        break;
      }
      case "tool_execution_start":
        record({ type: "tool_start", tool: ev.toolName, args: ev.args });
        // Reset pre-emptive nudge tracking on any tool call.
        answerTextLenSinceLastTool = 0;
        break;
      case "tool_execution_end": {
        // On rejection (e.g. schema validation failure), pi wraps the error
        // message as a text content block in `result` — surface it so failed
        // record_findings calls are diagnosable without transcript spelunking.
        const errText = ev.isError
          ? (ev.result?.content as { type: string; text?: string }[] | undefined)?.find(
              (c) => c.type === "text",
            )?.text
          : undefined;
        toolCalls.push({ tool: ev.toolName, args: undefined, isError: ev.isError, error: errText });
        record({ type: "tool_end", tool: ev.toolName, isError: ev.isError, error: errText });
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
    const modeLabel = twoPhase ? "running (phase 1/2)" : textMode ? "running (text mode)" : "running";
    emit({ type: "status", message: modeLabel });

    // ---- Phase 1: Exploration (twoPhase) or single-turn (normal/textMode) ----
    try {
      await session.prompt(params.context);
    } catch (err) {
      // Only swallow the abort we triggered ourselves via checkStall / preemptive
      // nudge — a real external cancellation (params.signal) must still propagate
      // so the orchestrator's existing abort handling (needs_human escalation) applies.
      const selfAbort = stalled || preemptiveNudged;
      if (!selfAbort || params.signal?.aborted) throw err;
    }

    // Retry logic for stall/preemptive-nudge: if the model was narrating without
    // acting, inject the nudge and give it one more chance. In twoPhase mode,
    // retries are disabled — if phase 1 stalls we proceed directly to phase 2
    // which gives the model a clean prompt for JSON output.
    if ((stalled || preemptiveNudged) && !captured && !stallRetried && !twoPhase) {
      stallRetried = true;
      stalled = false;
      preemptiveNudged = false;
      stallDetector.reset();
      answerTextLenSinceLastTool = 0;
      record({ type: "status", message: "retrying: call the tool directly instead of narrating it" });
      try {
        await session.prompt(STALL_NUDGE);
      } catch (err) {
        const selfAbort = stalled || preemptiveNudged;
        if (!selfAbort || params.signal?.aborted) throw err;
      }
    }

    // ---- Phase 2: Formalize (twoPhase only) ----
    // In twoPhase mode, after phase 1 exploration, send a second prompt asking
    // the model to formalize its findings as JSON (no tools expected). This avoids
    // the unreliable custom-tool-calling path while preserving built-in tool usage.
    if (twoPhase && !captured) {
      // Reset stall state for the formalization turn.
      stalled = false;
      preemptiveNudged = false;
      stallDetector.reset();
      answerTextLenSinceLastTool = 0;

      record({ type: "status", message: "phase 2: formalizing findings as structured JSON" });
      try {
        await session.prompt(TWO_PHASE_FORMALIZE_PROMPT);
      } catch (err) {
        // Self-aborts during phase 2 are tolerable — we'll fall back to extracting
        // whatever text was produced. External cancellations still propagate.
        const selfAbort = stalled || preemptiveNudged;
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

  let fallback = false;
  let phase: number | undefined;
  if (twoPhase) {
    // Two-phase: the model should have produced a JSON block in phase 2 answer text.
    // If phase 1 stalled or phase 2 didn't produce JSON, we still consider it
    // non-fallback if we can extract structured findings from either phase.
    phase = captured ? 2 : stalled ? 1 : 2;
    const extracted = extractFindingsFromText(answerText);
    if (extracted) {
      captured = extracted;
      fallback = false;
    } else {
      fallback = true;
      captured = synthesizeFallback(
        answerText,
        stallEverDetected,
        stallRetried,
        preemptiveNudged,
        stopReason,
      );
    }
  } else if (!captured) {
    // Normal/textMode: the model finished without the required tool call.
    // First, try to extract structured findings from the answer text.
    const extracted = extractFindingsFromText(answerText);
    if (extracted) {
      captured = extracted;
      fallback = false;
    } else {
      fallback = true;
      captured = synthesizeFallback(
        answerText,
        stallEverDetected,
        stallRetried,
        preemptiveNudged,
        stopReason,
      );
    }
  }

  // ---- Fallback synthesis (reused by both paths) ----
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
      section_md: text.trim() || "_(model produced only reasoning — see the reasoning trace)_",
      criteria_results: [],
    };
  }

  // ---- Remove old fallback block (logic moved above) ----

  const failedCalls = toolCalls.filter((tc) => tc.isError);
  if (fallback || stopReason === "length" || stallEverDetected || failedCalls.length > 0) {
    console.warn(
      `[agent] role run: model=${params.modelId} stop=${stopReason ?? "?"} ` +
        `fallback=${fallback} stalled=${stallEverDetected} retried=${stallRetried} textMode=${textMode} twoPhase=${twoPhase} ` +
        `tokens=${tokens} answer_chars=${answerText.length} thinking_chars=${thinkingText.length}`,
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
  };
}
