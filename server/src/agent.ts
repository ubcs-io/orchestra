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
import { Type, type Static } from "@sinclair/typebox";
import { appendArtifactSection, resolveInPlanning } from "./git.js";
import { ensureModel, getRegistry } from "./providers.js";

export type Verdict = "pass" | "needs_more" | "blocker" | "needs_human";
export type CoverageStatus = "considered" | "skipped" | "out_of_scope";

export interface CoverageItem {
  concern: string;
  status: CoverageStatus;
  note?: string;
}

export interface RoleFindings {
  verdict: Verdict;
  summary: string;
  open_questions: string[];
  coverage: CoverageItem[];
  section_md: string;
}

export interface ToolCallRecord {
  tool: string;
  args: unknown;
  isError: boolean;
}

/** Normalized stream event forwarded to the SSE layer. */
export type RoleStreamEvent =
  | { type: "text"; delta: string }
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
});

const WriteArtifactSchema = Type.Object({
  relative_path: Type.String({
    description: "Path relative to the project's PLANNING directory. Cannot escape it.",
  }),
  content: Type.String(),
});

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

/**
 * Extract the concatenated text of the last assistant message, used only as a
 * fallback when the model never calls record_findings.
 */
function lastAssistantText(messages: Array<{ role?: string; content?: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    const parts = (m.content as Array<{ type?: string; text?: string }>)
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string);
    if (parts.length) return parts.join("");
  }
  return "";
}

export async function runRole(params: RunRoleParams): Promise<RoleRunResult> {
  const emit = params.onEvent ?? (() => {});
  const transcript: string[] = [];
  const toolCalls: ToolCallRecord[] = [];
  let tokens = 0;
  let captured: RoleFindings | undefined;

  const record = (ev: RoleStreamEvent) => {
    transcript.push(JSON.stringify(ev));
    emit(ev);
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
      };
      return { ...textResult("findings recorded"), terminate: true };
    },
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

  const { session } = await createAgentSession({
    cwd: params.repoPath,
    model,
    modelRegistry: getRegistry(),
    settingsManager,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    tools: params.tools,
    customTools: [recordFindings, writeArtifact],
  });

  const unsubscribe = session.subscribe((ev) => {
    switch (ev.type) {
      case "message_update": {
        const ame = ev.assistantMessageEvent as { type?: string; delta?: string; text?: string };
        const delta = ame?.type === "text_delta" ? (ame.delta ?? ame.text ?? "") : "";
        if (delta) record({ type: "text", delta });
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
        const usage = (ev.message as { usage?: { input?: number; output?: number } }).usage;
        if (usage) tokens += (usage.input ?? 0) + (usage.output ?? 0);
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

  let fallback = false;
  if (!captured) {
    // The model finished without the required tool call — salvage its prose.
    fallback = true;
    const text = lastAssistantText(session.messages as Array<{ role?: string; content?: unknown }>);
    captured = {
      verdict: "needs_more",
      summary: "Role finished without a structured verdict; captured raw output.",
      open_questions: [],
      coverage: [],
      section_md: text || "_(no output produced)_",
    };
  }

  session.dispose();

  return {
    findings: captured,
    toolCalls,
    transcriptJsonl: transcript.join("\n"),
    tokens,
    model: params.modelId,
    fallback,
  };
}
