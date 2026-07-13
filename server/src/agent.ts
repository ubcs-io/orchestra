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
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { Type, type Static } from "@sinclair/typebox";
import type { ThinkingLevel } from "@earendil-works/pi-ai/compat";
import { appendArtifactSection, resolveInPlanning } from "./git.js";
import { ensureModel, getRegistry } from "./providers.js";

export type Verdict = "pass" | "needs_more" | "blocker" | "needs_human";
export type CoverageStatus = "considered" | "skipped" | "out_of_scope";

export interface CoverageItem {
  concern: string;
  status: CoverageStatus;
  note?: string;
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
  open_questions: string[];
  coverage: CoverageItem[];
  section_md: string;
  /** Present only for counter-reviewer roles; one entry per acceptance criterion. */
  criteria_results?: CriteriaResult[];
}

export interface ToolCallRecord {
  tool: string;
  args: unknown;
  isError: boolean;
}

/** Normalized stream event forwarded to the SSE layer. */
export type RoleStreamEvent =
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool_start"; tool: string; args: unknown }
  | { type: "tool_end"; tool: string; isError: boolean }
  | { type: "status"; message: string };

export interface RoleRunResult {
  findings: RoleFindings;
  toolCalls: ToolCallRecord[];
  transcriptJsonl: string;
  tokens: number;
  model: string;
  /** True when the role never called record_findings and we synthesized a fallback. */
  fallback: boolean;
  /** The LLM stop reason ("stop" | "length" | "toolUse" | ...); "length" == truncated. */
  stopReason?: string;
  /** The model's reasoning trace (native reasoning channel + any inline <think>). */
  thinkingText: string;
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

const RecordFindingsSchema = Type.Object({
  verdict: Type.Union([
    Type.Literal("pass"),
    Type.Literal("needs_more"),
    Type.Literal("blocker"),
    Type.Literal("needs_human"),
  ]),
  summary: Type.String(),
  open_questions: Type.Array(Type.String()),
  coverage: Type.Array(CoverageSchema),
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

export async function runRole(params: RunRoleParams): Promise<RoleRunResult> {
  const emit = params.onEvent ?? (() => {});
  const transcript: string[] = [];
  const toolCalls: ToolCallRecord[] = [];
  let tokens = 0;
  let captured: RoleFindings | undefined;
  let stopReason: string | undefined;

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
        open_questions: p.open_questions ?? [],
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

  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: params.repoPath,
    agentDir: getAgentDir(),
    settingsManager,
    systemPrompt: params.systemPrompt,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();

  const model = ensureModel(params.modelId);

  // `git_history` is a custom tool, not a pi builtin — pull it out of the builtin
  // allowlist and register it as a custom tool only for roles that opt in.
  const wantsGit = params.tools.includes(GIT_HISTORY_TOOL);
  const builtinTools = params.tools.filter((t) => t !== GIT_HISTORY_TOOL);
  const customTools = wantsGit
    ? [recordFindings, writeArtifact, gitHistory]
    : [recordFindings, writeArtifact];

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

  const unsubscribe = session.subscribe((ev) => {
    switch (ev.type) {
      case "message_update": {
        const ame = ev.assistantMessageEvent as { type?: string; delta?: string; text?: string };
        if (ame?.type === "text_delta") {
          // Route through the splitter: inline <think> goes to the reasoning channel.
          const { text, thinking } = splitter.push(ame.delta ?? ame.text ?? "");
          emitText(text);
          emitThinking(thinking);
        } else if (ame?.type === "thinking_delta") {
          // Native reasoning channel (endpoints that emit reasoning_content).
          emitThinking(ame.delta ?? "");
        }
        break;
      }
      case "tool_execution_start":
        record({ type: "tool_start", tool: ev.toolName, args: ev.args });
        break;
      case "tool_execution_end":
        toolCalls.push({ tool: ev.toolName, args: undefined, isError: ev.isError });
        record({ type: "tool_end", tool: ev.toolName, isError: ev.isError });
        break;
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
    emit({ type: "status", message: "running" });
    await session.prompt(params.context);
  } finally {
    unsubscribe();
  }

  // Flush any trailing text held back for partial-tag detection.
  const tail = splitter.flush();
  emitText(tail.text);
  emitThinking(tail.thinking);

  let fallback = false;
  if (!captured) {
    // The model finished without the required tool call — salvage the (think-stripped)
    // answer text; never surface raw reasoning as the output.
    fallback = true;
    captured = {
      verdict: "needs_more",
      summary:
        stopReason === "length"
          ? "Output was truncated (hit the token limit) before the role recorded a verdict."
          : "Role finished without a structured verdict; captured raw output.",
      open_questions: [],
      coverage: [],
      section_md: answerText.trim() || "_(model produced only reasoning — see the reasoning trace)_",
      criteria_results: [],
    };
  }

  if (fallback || stopReason === "length") {
    console.warn(
      `[agent] degraded role run: model=${params.modelId} stop=${stopReason ?? "?"} ` +
        `fallback=${fallback} tokens=${tokens} answer_chars=${answerText.length} thinking_chars=${thinkingText.length}`,
    );
  }

  session.dispose();

  return {
    findings: captured,
    toolCalls,
    transcriptJsonl: transcript.join("\n"),
    tokens,
    model: params.modelId,
    fallback,
    stopReason,
    thinkingText,
  };
}
