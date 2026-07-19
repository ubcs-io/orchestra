import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { marked } from "marked";
import {
  ReactFlow,
  Background,
  MiniMap,
  BackgroundVariant,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api, displayModelName, verdictClass, type TaskDetail as TD, type RoleRun, type AgentNetworkGraph, type NetworkPingTarget } from "../api";
import { rolesWithWriteTools, taskWriteCapability } from "../writeCapability";
import { NetworkNodeCard } from "../components/NetworkNodeCard";
import { ModelBubble } from "../components/ModelBubble";
import { DiffPanel, RunDiffSection } from "../components/DiffPanel";
import { ReviewCTA, collectQuestions, findAnsweredQuestion, type ClientOpenQuestion } from "../components/ReviewCTA";
import { QuestionDecomposeButton, DecomposedChildCard } from "../components/QuestionDecompose";

/** Parse an open-question string into structured parts: the clean question, a suggested default, and options. */
interface ParsedQuestion {
  text: string;
  defaultAnswer: string | null;
  options: string[];
}

function parseQuestion(rawQ: ClientOpenQuestion): ParsedQuestion {
  const heuristic = parseQuestionText(rawQ.question);
  // A structured guess takes priority over anything the legacy heuristic below
  // scraped out of the question's own free text (e.g. old model output that
  // still ends with "(default: X)").
  return rawQ.assumed_answer
    ? { ...heuristic, defaultAnswer: rawQ.assumed_answer }
    : heuristic;
}

/** Legacy heuristic: scrape a suggested default / options out of a plain-text
 *  question string (pre-dates the structured assumed_answer/confidence fields). */
function parseQuestionText(raw: string): ParsedQuestion {
  let q = raw.trim();

  // Extract trailing default suggestions: ... (default: X)  or  ... (likely X)  or  ... → X
  const defaultRe = /[→\->]\s*(.+?)$/;
  const parenDefaultRe = /\(\s*(?:default|likely|probably|recommended|suggested)\s*[:\-–]\s*(.+?)\s*\)\s*$/i;
  const defaultRe2 = /\(\s*(.+?)\s*\)\s*$/;

  let dflt: string | null = null;

  // Try "(default: X)" / "(likely X)" first
  let m = q.match(parenDefaultRe);
  if (m) {
    dflt = m[1]!.trim();
    q = q.slice(0, m.index!).trim();
  }

  // Try trailing "→ X" or "-> X"
  if (!dflt) {
    const lines = q.split("\n");
    const last = lines[lines.length - 1] ?? "";
    m = last.match(defaultRe);
    if (m) {
      dflt = m[1]!.trim();
      lines.pop();
      q = lines.join("\n").trim();
    }
  }

  // Try simple "(X)" at end as fallback
  if (!dflt) {
    m = q.match(defaultRe2);
    if (m) {
      dflt = m[1]!.trim();
      q = q.slice(0, m.index!).trim();
    }
  }

  // Extract options: [Option A] / [A] style or numbered lists
  const optionRe = /\[([A-Za-z])\]\s*(.+?)(?=\s*\[[A-Za-z]\]|$)/g;
  const opts: string[] = [];
  let om;
  while ((om = optionRe.exec(q)) !== null) {
    opts.push(om[2]!.trim());
  }
  if (opts.length) {
    // Remove the options section from the question text
    const firstBracket = q.search(/\[[A-Za-z]\]\s/);
    if (firstBracket >= 0) {
      q = q.slice(0, firstBracket).trim();
    }
  }

  return { text: q || raw.trim(), defaultAnswer: dflt, options: opts };
}

function ElapsedTime({ startTime }: { startTime: number }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(iv);
  }, []);
  const elapsed = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return <>{m > 0 ? `${m}m ${s}s` : `${s}s`}</>;
}

export interface ActivityState {
  currentRole: string | null;
  disposition: "reading" | "thinking" | "responding" | "tool" | "done" | null;
  roleStartTime: number | null;
  roleEndTime: number | null;
  /** Completed role stats — persist across role_start so the TPS / timing stay visible. */
  lastRole: { role: string; tokens: number; elapsedSec: number; model: string | null } | null;
  /** Model for the currently running role, from the role_start event. */
  currentModel: string | null;
  /** TPS values per role from all completed runs, for per-role min/max display. */
  tpsHistory: Record<string, number[]>;
  /** Whether the final recap LLM call is still in progress. */
  recapGenerating: boolean;
}

/** Structured line item for the live activity console — replaces raw strings. */
export interface LineItem {
  kind: "role_start" | "role_end" | "text" | "thinking" | "tool_start" | "tool_end" | "status" | "separator";
  content: string;
  meta?: {
    role?: string;
    depth?: number;
    verdict?: string;
    flags?: string;
    tool?: string;
    isError?: boolean;
    /** Raw tool arguments for pretty-printing as JSON. */
    jsonArgs?: unknown;
    repeatCount?: number;
    aborted?: boolean;
  };
}

function useTaskStream(taskId: string, onActivity: () => void, nextRoleRef: { current: string | null }, resetKey: number) {
  const [lines, setLines] = useState<LineItem[]>([]);
  const [activity, setActivity] = useState<ActivityState>({
    currentRole: null,
    disposition: null,
    roleStartTime: null,
    roleEndTime: null,
    lastRole: null,
    currentModel: null,
    tpsHistory: {},
    recapGenerating: false,
  });
  const bufRef = useRef("");
  const thinkRef = useRef("");
  const lastToolRef = useRef("");
  const repeatRef = useRef(0);
  useEffect(() => {
    setLines([]);
    setActivity({ currentRole: null, disposition: null, roleStartTime: null, roleEndTime: null, lastRole: null, currentModel: null, tpsHistory: {}, recapGenerating: false });
    const role = nextRoleRef.current;
    if (role) {
      setActivity((a) => a.currentRole ? a : { ...a, currentRole: role, disposition: "reading", roleStartTime: Date.now() });
    }
    bufRef.current = "";
    thinkRef.current = "";
    lastToolRef.current = "";
    repeatRef.current = 0;
    const es = new EventSource(`/api/tasks/${taskId}/stream`);
    const push = (item: LineItem) => setLines((prev) => [...prev.slice(-400), item]);

    const flushRepeat = () => {
      lastToolRef.current = "";
      repeatRef.current = 0;
    };

    es.addEventListener("role_start", (e) => {
      const d = JSON.parse((e as MessageEvent).data).data;
      push({ kind: "role_start", content: `▶ ROLE ${d.role}`, meta: { role: d.role, depth: d.depth } });
      bufRef.current = "";
      thinkRef.current = "";
      flushRepeat();
      setActivity((a) => ({ ...a, currentRole: d.role, disposition: "reading", roleStartTime: Date.now(), roleEndTime: null, lastRole: a.lastRole, currentModel: d.model ?? null }));
    });
    es.addEventListener("text", (e) => {
      const d = JSON.parse((e as MessageEvent).data).data;
      bufRef.current += d.delta ?? "";
      thinkRef.current = "";
      flushRepeat();
      setLines((prev) => {
        const last = prev[prev.length - 1];
        const rest = last?.kind === "text" ? prev.slice(0, -1) : prev;
        return [...rest, { kind: "text", content: bufRef.current.slice(-1200) }];
      });
      setActivity((a) => a.disposition !== "responding" ? { ...a, disposition: "responding" } : a);
    });
    es.addEventListener("thinking", (e) => {
      const d = JSON.parse((e as MessageEvent).data).data;
      thinkRef.current += d.delta ?? "";
      bufRef.current = "";
      flushRepeat();
      setLines((prev) => {
        const last = prev[prev.length - 1];
        const rest = last?.kind === "thinking" ? prev.slice(0, -1) : prev;
        return [...rest, { kind: "thinking", content: thinkRef.current.slice(-1200) }];
      });
      setActivity((a) => a.disposition !== "thinking" ? { ...a, disposition: "thinking" } : a);
    });
    es.addEventListener("tool_start", (e) => {
      const d = JSON.parse((e as MessageEvent).data).data;
      if (d.tool === lastToolRef.current) {
        repeatRef.current += 1;
        if (repeatRef.current === 2) {
          setLines((prev) => [...prev.slice(0, -2).slice(-400), { kind: "tool_start", content: d.tool, meta: { tool: d.tool, repeatCount: 2, jsonArgs: d.args } }]);
        } else {
          setLines((prev) => [...prev.slice(0, -1).slice(-400), { kind: "tool_start", content: d.tool, meta: { tool: d.tool, repeatCount: repeatRef.current, jsonArgs: d.args } }]);
        }
      } else {
        lastToolRef.current = d.tool;
        repeatRef.current = 1;
        push({ kind: "tool_start", content: d.tool, meta: { tool: d.tool, jsonArgs: d.args } });
      }
      bufRef.current = "";
      thinkRef.current = "";
      setActivity((a) => a.disposition !== "tool" ? { ...a, disposition: "tool" } : a);
    });
    es.addEventListener("tool_end", (e) => {
      const d = JSON.parse((e as MessageEvent).data).data;
      if (repeatRef.current > 1) {
        setLines((prev) => [...prev.slice(0, -1).slice(-400), { kind: "tool_end", content: d.tool, meta: { tool: d.tool, repeatCount: repeatRef.current, isError: d.isError } }]);
      } else {
        push({ kind: "tool_end", content: d.tool, meta: { tool: d.tool, isError: d.isError } });
      }
    });
    es.addEventListener("role_end", (e) => {
      const d = JSON.parse((e as MessageEvent).data).data;
      const flags = [
        d.fallback ? "no verdict" : "",
        d.stopReason === "length" ? "TRUNCATED" : "",
      ].filter(Boolean).join(", ");
      push({ kind: "role_end", content: `${d.verdict ?? (d.error ? "error" : "done")}`, meta: { role: d.role, verdict: d.verdict ?? "done", flags: flags || undefined, aborted: d.error ?? false } });
      onActivity();
      flushRepeat();
      setActivity((a) => {
        const endTime = Date.now();
        const elapsed = a.roleStartTime ? (endTime - a.roleStartTime) / 1000 : 0;
        const lastRole = d.tokens != null && elapsed > 0
          ? { role: d.role, tokens: d.tokens, elapsedSec: elapsed, model: d.model ?? null }
          : a.lastRole;
        const tps = lastRole ? lastRole.tokens / lastRole.elapsedSec : null;
        const tpsHistory = tps != null
          ? { ...a.tpsHistory, [d.role]: [...(a.tpsHistory[d.role] ?? []), tps] }
          : a.tpsHistory;
        return {
          ...a,
          currentRole: d.role,
          disposition: "done",
          roleStartTime: a.roleStartTime,
          roleEndTime: endTime,
          lastRole,
          currentModel: null,
          tpsHistory,
        };
      });
    });
    es.addEventListener("recap_start", () => {
      setActivity((a) => ({ ...a, recapGenerating: true }));
    });
    es.addEventListener("recap_end", () => {
      setActivity((a) => ({ ...a, recapGenerating: false }));
    });
    es.addEventListener("task_update", () => onActivity());
    es.onerror = () => {}; // browser auto-reconnects

    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, resetKey]);
  return { lines, activity };
}

// ---- Markdown syntax colorizer (colors syntax without rendering) ----

interface MdSpan {
  text: string;
  cls?: string;
}

function tokenizeMarkdown(text: string): MdSpan[] {
  const spans: MdSpan[] = [];
  let i = 0;

  while (i < text.length) {
    // Fenced code blocks (``` ... ```) — must be checked before inline code
    if (text.startsWith("```", i)) {
      const fenceStart = i;
      const end = text.indexOf("\n```", i + 3);
      if (end >= 0) {
        const fenceEnd = end + 4;
        const fenceLine = text.slice(fenceStart, text.indexOf("\n", fenceStart) >= 0 ? text.indexOf("\n", fenceStart) : fenceStart + 3);
        spans.push({ text: "\n", cls: "" });
        spans.push({ text: fenceLine, cls: "md-fence-open" });
        spans.push({ text: text.slice(fenceStart + fenceLine.length, fenceEnd - 3), cls: "md-fence-body" });
        spans.push({ text: "```", cls: "md-fence-close" });
        spans.push({ text: "\n", cls: "" });
        i = fenceEnd;
        continue;
      }
      // Unterminated — treat as inline code
      spans.push({ text: "```", cls: "md-code" });
      i += 3;
      continue;
    }

    // Inline code (`code`)
    if (text[i] === "`") {
      const endTick = text.indexOf("`", i + 1);
      if (endTick >= 0) {
        spans.push({ text: text.slice(i, endTick + 1), cls: "md-code" });
        i = endTick + 1;
        continue;
      }
    }

    // Bold (**text**)
    if (text.startsWith("**", i)) {
      const endBold = text.indexOf("**", i + 2);
      if (endBold >= 0) {
        spans.push({ text: "**", cls: "md-bold-marker" });
        spans.push({ text: text.slice(i + 2, endBold), cls: "md-bold" });
        spans.push({ text: "**", cls: "md-bold-marker" });
        i = endBold + 2;
        continue;
      }
    }

    // Italic (*text*)
    if (text[i] === "*" && text[i + 1] !== "*") {
      const endItalic = text.indexOf("*", i + 1);
      if (endItalic >= 0) {
        spans.push({ text: "*", cls: "md-italic-marker" });
        spans.push({ text: text.slice(i + 1, endItalic), cls: "md-italic" });
        spans.push({ text: "*", cls: "md-italic-marker" });
        i = endItalic + 1;
        continue;
      }
    }

    // Links [text](url)
    if (text[i] === "[" && text.indexOf("](", i + 1) >= 0) {
      const linkTextEnd = text.indexOf("](", i);
      const linkUrlEnd = text.indexOf(")", linkTextEnd + 2);
      if (linkUrlEnd >= 0) {
        spans.push({ text: "[", cls: "md-link-bracket" });
        spans.push({ text: text.slice(i + 1, linkTextEnd), cls: "md-link-text" });
        spans.push({ text: "](", cls: "md-link-bracket" });
        spans.push({ text: text.slice(linkTextEnd + 2, linkUrlEnd), cls: "md-link-url" });
        spans.push({ text: ")", cls: "md-link-bracket" });
        i = linkUrlEnd + 1;
        continue;
      }
    }

    // Heading lines (## Heading at start of line, or after newline in middle of text)
    if ((i === 0 || text[i - 1] === "\n") && text[i] === "#") {
      let hashEnd = i;
      while (hashEnd < text.length && text[hashEnd] === "#") hashEnd++;
      const hashCount = hashEnd - i;
      if (hashCount >= 1 && hashCount <= 4 && text[hashEnd] === " ") {
        const newlineEnd = text.indexOf("\n", hashEnd);
        const headingEnd = newlineEnd >= 0 ? newlineEnd : text.length;
        const headingText = text.slice(i, headingEnd);
        spans.push({ text: headingText, cls: `md-h${hashCount}` });
        i = headingEnd;
        continue;
      }
    }

    // Blockquote lines (> ...)
    if ((i === 0 || text[i - 1] === "\n") && text[i] === ">") {
      const newlineEnd = text.indexOf("\n", i);
      const lineEnd = newlineEnd >= 0 ? newlineEnd : text.length;
      spans.push({ text: text.slice(i, lineEnd), cls: "md-blockquote" });
      i = lineEnd;
      continue;
    }

    // Unordered list items (-  or *  at start of line)
    if ((i === 0 || text[i - 1] === "\n") && (text[i] === "-" || text[i] === "*") && text[i + 1] === " ") {
      const newlineEnd = text.indexOf("\n", i);
      const lineEnd = newlineEnd >= 0 ? newlineEnd : text.length;
      spans.push({ text: text.slice(i, i + 2), cls: "md-list-marker" });
      spans.push({ text: text.slice(i + 2, lineEnd), cls: "" });
      i = lineEnd;
      continue;
    }

    // Horizontal rule (---)
    if ((i === 0 || text[i - 1] === "\n") && text.startsWith("---", i) && (i + 3 >= text.length || text[i + 3] === "\n")) {
      spans.push({ text: "---", cls: "md-hr" });
      i += 3;
      continue;
    }

    // Plain text — consume until the next special character or end
    const nextSpecial = findNextSpecial(text, i);
    if (nextSpecial > i) {
      spans.push({ text: text.slice(i, nextSpecial), cls: "" });
      i = nextSpecial;
    } else {
      spans.push({ text: text.slice(i), cls: "" });
      break;
    }
  }

  return spans;
}

function findNextSpecial(text: string, start: number): number {
  for (let j = start; j < text.length; j++) {
    if (text[j] === "`" || text[j] === "[" || text[j] === "*" ||
        (j === start || text[j - 1] === "\n" ? text[j] === "#" || text[j] === ">" || text[j] === "-" : false)) {
      return j;
    }
  }
  return text.length;
}

/** Apply JSON syntax coloring return React elements. */
function jsonSpans(value: unknown): React.ReactNode {
  const json = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const spans: MdSpan[] = [];
  let i = 0;

  while (i < json.length) {
    // String values
    if (json[i] === '"') {
      const end = json.indexOf('"', i + 1);
      // Handle escaped quotes
      let escEnd = end;
      while (escEnd > 0 && json[escEnd - 1] === "\\") {
        escEnd = json.indexOf('"', escEnd + 1);
      }
      const actualEnd = escEnd >= 0 ? escEnd + 1 : json.length;
      spans.push({ text: json.slice(i, actualEnd), cls: "json-string" });
      i = actualEnd;
      continue;
    }
    // Numbers
    if (/^-?\d/.test(json[i]) && (i === 0 || /[\s:,\[\n]/.test(json[i - 1]))) {
      let numEnd = i + 1;
      while (numEnd < json.length && /[\d.eE+\-]/.test(json[numEnd])) numEnd++;
      spans.push({ text: json.slice(i, numEnd), cls: "json-number" });
      i = numEnd;
      continue;
    }
    // Boolean / null
    if (json.slice(i).match(/^(true|false|null)/)) {
      const word = json.slice(i).match(/^(true|false|null)/)![0];
      spans.push({ text: word, cls: "json-keyword" });
      i += word.length;
      continue;
    }
    // Keys (anything between quotes before a colon)
    // Plain chars
    let plainEnd = i + 1;
    while (plainEnd < json.length && !'"-0123456789tefnul'.includes(json[plainEnd])) plainEnd++;
    spans.push({ text: json.slice(i, plainEnd), cls: "json-punct" });
    i = plainEnd;
  }

  return spans.map((s, idx) =>
    s.cls ? <span key={idx} className={s.cls}>{s.text}</span> : s.text
  );
}

/** Colorize markdown text — applies syntax coloring spans, preserving the raw text. */
function colorizeMarkdown(text: string): React.ReactNode {
  const spans = tokenizeMarkdown(text);
  return spans.map((s, idx) =>
    s.cls ? <span key={idx} className={s.cls}>{s.text}</span> : s.text
  );
}

/** Verdict → pill class and color for role_end display. */
function verdictStyle(verdict: string): { cls: string; color: string } {
  switch (verdict) {
    case "pass": return { cls: "pill ok", color: "var(--ok)" };
    case "needs_more": return { cls: "pill warn", color: "var(--warn)" };
    case "blocker": return { cls: "pill bad", color: "var(--bad)" };
    case "needs_human": return { cls: "pill human", color: "var(--human)" };
    default: return { cls: "pill dim", color: "var(--ink-dim)" };
  }
}

function LiveLine({ item }: { item: LineItem }) {
  switch (item.kind) {
    case "role_start":
      return (
        <div className="live-role-start">
          <span className="live-role-icon">{"▶"}</span>
          <span className="live-role-key">{item.meta?.role}</span>
          {item.meta?.depth != null && <span className="live-role-depth">depth {item.meta.depth}</span>}
        </div>
      );

    case "role_end": {
      const vs = verdictStyle(item.meta?.verdict ?? "done");
      return (
        <div className="live-role-end">
          <span className="live-role-end-marker">{item.meta?.aborted ? "✕" : "■"}</span>
          <span className="live-role-key">{item.meta?.role}</span>
          <span className="live-role-arrow">→</span>
          <span className={`${vs.cls}`} style={{ borderColor: vs.color, color: vs.color }}>{item.content}</span>
          {item.meta?.flags && <span className="live-role-flags">[{item.meta.flags}]</span>}
        </div>
      );
    }

    case "tool_start": {
      const rc = item.meta?.repeatCount;
      return (
        <div className="live-tool-start">
          <span className="live-tool-icon">{"⚙"}</span>
          <span className="live-tool-name">{item.content}</span>
          {rc && rc > 1 ? (
            <span className="live-tool-repeat">{rc}x</span>
          ) : null}
          {item.meta?.jsonArgs != null && (
            <pre className="live-json">{jsonSpans(item.meta.jsonArgs)}</pre>
          )}
        </div>
      );
    }

    case "tool_end": {
      const rc = item.meta?.repeatCount;
      return (
        <div className="live-tool-end">
          <span className="live-tool-icon">{"⚙"}</span>
          <span className="live-tool-name">{item.content}</span>
          {rc && rc > 1 ? <span className="live-tool-repeat">{rc}x</span> : null}
          <span className={item.meta?.isError ? "live-tool-result error" : "live-tool-result ok"}>
            {item.meta?.isError ? "✗" : "✓"}
          </span>
        </div>
      );
    }

    case "text":
      return <div className="live-text">{colorizeMarkdown(item.content)}</div>;

    case "thinking":
      return <div className="live-thinking"><span className="live-thinking-prefix">{"💭"}</span> {colorizeMarkdown(item.content)}</div>;

    case "status":
      return <div className="live-status">{item.content}</div>;

    default:
      return <div className="live-text">{item.content}</div>;
  }
}

function TaskNetworkGraph({
  networkId,
  runs,
  plan,
  currentRole,
  projectId,
}: {
  networkId: string;
  runs: RoleRun[];
  plan: { steps: { role: string; status: string; depth: number }[] } | null;
  currentRole: string | null;
  projectId: number | null;
}) {
  const rolesQ = useQuery({ queryKey: ["allRoles"], queryFn: () => api.allRoles() });
  const networkQ = useQuery({
    queryKey: ["network", networkId],
    queryFn: () => api.network(networkId),
  });
  const navigate = useNavigate();

  const parsedGraph = useMemo<AgentNetworkGraph | null>(() => {
    if (!networkQ.data?.network?.graph_json) return null;
    try {
      return JSON.parse(networkQ.data.network.graph_json) as AgentNetworkGraph;
    } catch {
      return null;
    }
  }, [networkQ.data]);

  const nodeTypes = useMemo(() => ({ networkNode: NetworkNodeCard }), []);

  const graphNodes: Node[] = useMemo(() => {
    if (!parsedGraph?.nodes) return [];
    return parsedGraph.nodes.map((n) => {
      const roleTitle = rolesQ.data?.roles.find((r) => r.key === n.roleKey)?.title ?? n.roleKey;
      const planStep = plan?.steps.find((s) => s.role === n.roleKey);
      const isActive = currentRole === n.roleKey;
      const status = isActive ? "active" : (planStep?.status ?? "pending");

      return {
        id: n.id,
        type: "networkNode",
        position: { x: n.position.x, y: n.position.y },
        data: {
          label: roleTitle,
          roleKey: n.roleKey,
          criteriaCount: n.criteria?.length ?? 0,
          depth: n.overrides?.depth,
        },
        className: isActive
          ? "task-network-node--active"
          : status === "done"
            ? "task-network-node--done"
            : status === "skipped"
              ? "task-network-node--skipped"
              : "",
      };
    });
  }, [parsedGraph, rolesQ.data, plan, runs, currentRole]);

  const graphEdges: Edge[] = useMemo(() => {
    if (!parsedGraph?.edges) return [];
    return parsedGraph.edges.map((e) => ({
      id: e.id,
      source: e.sourceNodeId,
      target: e.targetNodeId,
      label: e.label,
      type: "smoothstep" as const,
      animated: !!e.condition,
    }));
  }, [parsedGraph]);

  const handleNodeClick = (_event: React.MouseEvent, node: Node) => {
    const roleKey = (node.data as { roleKey?: string }).roleKey;
    if (!roleKey) return;
    if (projectId != null) {
      navigate({
        to: "/projects/$projectId/roles",
        params: { projectId: String(projectId) },
        search: { role: roleKey },
      });
    } else {
      navigate({ to: "/settings" });
    }
  };

  if (networkQ.isLoading || rolesQ.isLoading || !parsedGraph) {
    return null;
  }

  return (
    <div className="task-network-graph">
      <ReactFlow
        nodes={graphNodes}
        edges={graphEdges}
        nodeTypes={nodeTypes}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        zoomOnScroll={false}
        onNodeClick={handleNodeClick}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <MiniMap
          nodeColor={(n) => {
            if (n.className?.includes("--active")) return "var(--warn)";
            if (n.className?.includes("--done")) return "var(--ok)";
            if (n.className?.includes("--skipped")) return "var(--ink-dim)";
            return "var(--panel-2)";
          }}
        />
      </ReactFlow>
    </div>
  );
}

function RefinementNetworkPanel({
  networkId,
  runs,
  plan,
  currentRole,
  lastRole,
  projectId,
  selectedNodeRole,
  onSelectNodeRole,
  onJumpToRole,
}: {
  networkId: string;
  runs: RoleRun[];
  plan: { steps: { role: string; status: string; depth: number }[] } | null;
  currentRole: string | null;
  lastRole: { role: string; tokens: number; elapsedSec: number; model: string | null } | null;
  projectId: number | null;
  selectedNodeRole: string | null;
  onSelectNodeRole: (role: string | null) => void;
  onJumpToRole: (roleKey: string) => void;
}) {
  const rolesQ = useQuery({ queryKey: ["allRoles"], queryFn: () => api.allRoles() });
  const networkQ = useQuery({
    queryKey: ["network", networkId],
    queryFn: () => api.network(networkId),
  });

  const parsedGraph = useMemo<AgentNetworkGraph | null>(() => {
    if (!networkQ.data?.network?.graph_json) return null;
    try {
      return JSON.parse(networkQ.data.network.graph_json) as AgentNetworkGraph;
    } catch {
      return null;
    }
  }, [networkQ.data]);

  const nodeTypes = useMemo(() => ({ networkNode: NetworkNodeCard }), []);

  /** Resolve which role to show in the right panel: selected node, last completed, current, most recent run, or first plan step. */
  const displayRoleKey = useMemo<string | null>(() => {
    if (selectedNodeRole) return selectedNodeRole;
    if (lastRole) return lastRole.role;
    if (currentRole) return currentRole;
    // Fallback: most recent completed run
    const latest = runs.filter((r) => !r.run_kind || r.run_kind === "primary").pop();
    if (latest?.role_key) return latest.role_key;
    // Fallback: first step in the plan (before any roles run)
    return plan?.steps[0]?.role ?? null;
  }, [selectedNodeRole, lastRole, currentRole, runs, plan]);

  /** Find the network node for the displayed role. */
  const displayNode = useMemo(() => {
    if (!parsedGraph?.nodes || !displayRoleKey) return null;
    return parsedGraph.nodes.find((n) => n.roleKey === displayRoleKey) ?? null;
  }, [parsedGraph, displayRoleKey]);

  /** Find the role config from project roles or allRoles. */
  const roleConfig = useMemo(() => {
    if (!displayRoleKey) return null;
    return rolesQ.data?.roles.find((r) => r.key === displayRoleKey) ?? null;
  }, [rolesQ.data, displayRoleKey]);

  /** Find the persisted run for the displayed role. */
  const displayRun = useMemo(() => {
    if (!displayRoleKey) return null;
    return runs.find((r) => r.role_key === displayRoleKey && (!r.run_kind || r.run_kind === "primary")) ?? null;
  }, [runs, displayRoleKey]);

  const planStep = plan?.steps.find((s) => s.role === displayRoleKey);
  const isDisplayActive = currentRole === displayRoleKey;

  const graphNodes: Node[] = useMemo(() => {
    if (!parsedGraph?.nodes) return [];
    return parsedGraph.nodes.map((n) => {
      const roleTitle = rolesQ.data?.roles.find((r) => r.key === n.roleKey)?.title ?? n.roleKey;
      const step = plan?.steps.find((s) => s.role === n.roleKey);
      const isActive = currentRole === n.roleKey;
      const status = isActive ? "active" : (step?.status ?? "pending");

      return {
        id: n.id,
        type: "networkNode",
        position: { x: n.position.x, y: n.position.y },
        data: {
          label: roleTitle,
          roleKey: n.roleKey,
          criteriaCount: n.criteria?.length ?? 0,
          depth: n.overrides?.depth,
        },
        className: isActive
          ? "task-network-node--active"
          : status === "done"
            ? "task-network-node--done"
            : status === "skipped"
              ? "task-network-node--skipped"
              : "",
      };
    });
  }, [parsedGraph, rolesQ.data, plan, currentRole]);

  const graphEdges: Edge[] = useMemo(() => {
    if (!parsedGraph?.edges) return [];
    return parsedGraph.edges.map((e) => ({
      id: e.id,
      source: e.sourceNodeId,
      target: e.targetNodeId,
      label: e.label,
      type: "smoothstep" as const,
      animated: !!e.condition,
    }));
  }, [parsedGraph]);

  const handleNetworkNodeClick = (_event: React.MouseEvent, node: Node) => {
    const roleKey = (node.data as { roleKey?: string }).roleKey;
    if (!roleKey) return;
    onSelectNodeRole(roleKey);
  };

  if (networkQ.isLoading || rolesQ.isLoading || !parsedGraph) {
    return null;
  }

  return (
    <div className="panel">
      <div className="plan-header">
        <h2>Refinement plan</h2>
      </div>
      <div className="refinement-split">
        <div className="refinement-network-left">
          <ReactFlow
            nodes={graphNodes}
            edges={graphEdges}
            nodeTypes={nodeTypes}
            fitView
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            panOnDrag={true}
            zoomOnScroll={true}
            onNodeClick={handleNetworkNodeClick}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          </ReactFlow>
        </div>
        <div
          className="refinement-role-right"
          onClick={() => {
            if (displayRoleKey) {
              onJumpToRole(displayRoleKey);
            }
          }}
          title={displayRoleKey ? `Click to jump to ${displayRoleKey} results` : undefined}
        >
          {displayRoleKey ? (
            <>
              <div className="refinement-role-header">
                <span className="refinement-role-title">{displayRoleKey}</span>
                {displayNode && (
                  <Link
                    to={projectId != null
                      ? "/projects/$projectId/roles"
                      : "/settings"}
                    params={projectId != null ? { projectId: String(projectId) } : undefined}
                    search={projectId != null ? { role: displayRoleKey } : undefined}
                    className="small"
                    title={`Edit ${displayRoleKey} configuration`}
                    onClick={(e: React.MouseEvent) => e.stopPropagation()}
                    style={{ fontSize: 14, lineHeight: 1, textDecoration: "none" }}
                  >
                    👤
                  </Link>
                )}
              </div>

              <div className="refinement-role-status">
                {isDisplayActive ? (
                  <span className="pill warn">active</span>
                ) : displayRun ? (
                  <span className={`pill ${verdictClass(displayRun.verdict)}`}>
                    {displayRun.verdict ?? "?"}
                  </span>
                ) : planStep ? (
                  <span className={`pill ${planStep.status === "done" ? "ok" : planStep.status === "skipped" ? "dim" : "warn"}`}>
                    {planStep.status}
                  </span>
                ) : null}
                {displayRun?.tokens != null && (
                  <span className="pill dim">{displayRun.tokens.toLocaleString()} tok</span>
                )}
                {displayRun?.depth && displayRun.depth > 1 && (
                  <span className="pill dim">depth {displayRun.depth}</span>
                )}
              </div>

              {roleConfig && (
                <div className="refinement-role-section">
                  <div className="refinement-role-section-label">Role Configuration</div>
                  <div className="refinement-role-override">
                    <strong>Title:</strong> {roleConfig.title ?? displayRoleKey}
                  </div>
                  {roleConfig.model && (
                    <div className="refinement-role-override">
                      <strong>Model:</strong> <code>{displayModelName(roleConfig.model)}</code>
                    </div>
                  )}
                  {roleConfig.system_prompt && (
                    <div className="refinement-role-override">
                      <strong>Prompt:</strong> {roleConfig.system_prompt.length > 120
                        ? roleConfig.system_prompt.slice(0, 120) + "…"
                        : roleConfig.system_prompt}
                    </div>
                  )}
                </div>
              )}

              {displayNode?.overrides && Object.keys(displayNode.overrides).length > 0 && (
                <div className="refinement-role-section">
                  <div className="refinement-role-section-label">Network Overrides</div>
                  {displayNode.overrides.systemPrompt && (
                    <div className="refinement-role-override">
                      <strong>Prompt override:</strong> {displayNode.overrides.systemPrompt.length > 100
                        ? displayNode.overrides.systemPrompt.slice(0, 100) + "…"
                        : displayNode.overrides.systemPrompt}
                    </div>
                  )}
                  {displayNode.overrides.model && (
                    <div className="refinement-role-override">
                      <strong>Model:</strong> <code>{displayModelName(displayNode.overrides.model)}</code>
                    </div>
                  )}
                  {displayNode.overrides.tools && displayNode.overrides.tools.length > 0 && (
                    <div className="refinement-role-override">
                      <strong>Tools:</strong> {displayNode.overrides.tools.join(", ")}
                    </div>
                  )}
                  {displayNode.overrides.depth != null && (
                    <div className="refinement-role-override">
                      <strong>Depth:</strong> {displayNode.overrides.depth}
                    </div>
                  )}
                </div>
              )}

              {projectId != null && (
                <Link
                  to="/projects/$projectId/roles"
                  params={{ projectId: String(projectId) }}
                  search={{ role: displayRoleKey }}
                  className="refinement-role-config-link"
                  onClick={(e: React.MouseEvent) => e.stopPropagation()}
                >
                  ⚙ Configure {displayRoleKey} →
                </Link>
              )}
            </>
          ) : (
            <div className="refinement-role-empty">
              {parsedGraph.nodes.length > 0
                ? "Click a node to see role details"
                : "No roles configured in this network"}
            </div>
          )}

          <div className="refinement-role-click-hint">
            {displayRoleKey && displayRun
              ? "Click card to jump to results ↓"
              : displayRoleKey
                ? "Click card to jump to plan ↓"
                : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function NetworkSelector({ taskId, projectId, intakeKind, onChanged }: { taskId: string; projectId: number; intakeKind: string | null; onChanged: () => void }) {
  const networksQ = useQuery({ queryKey: ["networks", projectId], queryFn: () => api.networks(projectId) });
  const setNetwork = useMutation({
    mutationFn: (networkId: string | null) =>
      api.updateTask(taskId, { network_id: networkId } as Record<string, unknown>),
    onSuccess: () => {
      onChanged();
    },
  });

  const networks = networksQ.data?.networks ?? [];
  const kind = intakeKind ?? "manual";

  // Filter networks matching this intake kind, plus all custom networks
  const matchingNetworks = networks.filter(
    (n) => !n.intake_kind || n.intake_kind === kind,
  );

  return (
    <select
      className="network-select"
      style={{ width: "auto", fontSize: 12, padding: "2px 6px" }}
      onChange={(e) => setNetwork.mutate(e.target.value || null)}
      defaultValue=""
    >
      <option value="">network: built-in</option>
      {matchingNetworks.map((n) => (
        <option key={n.network_id} value={n.network_id}>
          {n.name} {n.is_system ? "" : "✦"}
        </option>
      ))}
    </select>
  );
}

export function TaskDetail() {
  const { taskId } = useParams({ strict: false }) as { taskId: string };
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["task", taskId], queryFn: () => api.task(taskId), refetchInterval: 4000 });
  const refresh = () => qc.invalidateQueries({ queryKey: ["task", taskId] });
  const nextRoleRef = useRef<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const { lines, activity } = useTaskStream(taskId, refresh, nextRoleRef, resetKey);
  const liveRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  // Auto-scroll when pinned; detect when user scrolls away
  useEffect(() => {
    if (pinned) liveRef.current?.scrollTo(0, liveRef.current.scrollHeight);
  }, [lines, pinned]);

  const handleLiveScroll = () => {
    const el = liveRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setPinned(atBottom);
  };

  const jumpToLive = () => {
    liveRef.current?.scrollTo(0, liveRef.current.scrollHeight);
    setPinned(true);
  };

  const [roleInput, setRoleInput] = useState("");
  const [afterInput, setAfterInput] = useState("");
  const [noteInput, setNoteInput] = useState("");
  const [collapsedRuns, setCollapsedRuns] = useState<Set<number>>(new Set());
  const [runDiffOpen, setRunDiffOpen] = useState<Set<number>>(new Set());
  const [showAdvancedSteering, setShowAdvancedSteering] = useState(false);

  // Question answer state: per-question-editing keyed by "${runId}:${qIndex}"
  const [questionEdits, setQuestionEdits] = useState<Record<string, string>>({});
  // Keys the user has explicitly reopened for editing after the question was
  // already answered (see findAnsweredQuestion) — an already-answered question
  // renders as a locked "you answered" row unless its key is in this set.
  const [editingKeys, setEditingKeys] = useState<Set<string>>(new Set());

  // Intake editing state
  const [editName, setEditName] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editKind, setEditKind] = useState("");
  const [saving, setSaving] = useState(false);
  const [showNetworkGraph, setShowNetworkGraph] = useState(true);
  const [hoveredCoverage, setHoveredCoverage] = useState<{ role: string; concern: string } | null>(null);
  const [selectedNodeRole, setSelectedNodeRole] = useState<string | null>(null);

  // Scheduler state for banner
  const [schedulerRunning, setSchedulerRunning] = useState(true);
  useEffect(() => {
    api.scheduler().then((s) => setSchedulerRunning(s.running)).catch(() => {});
    const iv = setInterval(() => {
      api.scheduler().then((s) => setSchedulerRunning(s.running)).catch(() => {});
    }, 5000);
    return () => clearInterval(iv);
  }, []);

  // ---- Network availability check (for the network_unavailable blocked state) ----
  const [netPinging, setNetPinging] = useState(false);
  const [netPingResults, setNetPingResults] = useState<NetworkPingTarget[] | null>(null);
  const [netPingError, setNetPingError] = useState("");
  const netPingEsRef = useRef<EventSource | null>(null);

  useEffect(() => {
    return () => {
      if (netPingEsRef.current) {
        netPingEsRef.current.close();
        netPingEsRef.current = null;
      }
    };
  }, []);

  function checkNetworkAvailability() {
    if (netPingEsRef.current) {
      netPingEsRef.current.close();
      netPingEsRef.current = null;
    }
    setNetPinging(true);
    setNetPingError("");
    setNetPingResults(null);

    const es = new EventSource(api.taskNetworkPingStreamUrl(taskId));
    netPingEsRef.current = es;

    es.addEventListener("init", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as {
        targets: Array<{ target_id: string; label: string; kind: "override" | "default"; roles: string[] }>;
      };
      setNetPingResults(
        data.targets.map((t) => ({ ...t, available: false, status: "checking" as const })),
      );
    });

    es.addEventListener("result", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { target_id: string; available: boolean; error?: string };
      setNetPingResults((prev) =>
        prev
          ? prev.map((r) =>
              r.target_id === data.target_id
                ? { ...r, available: data.available, error: data.error, status: "done" as const }
                : r,
            )
          : prev,
      );
    });

    es.addEventListener("done", () => {
      setNetPinging(false);
      es.close();
      netPingEsRef.current = null;
    });

    es.onerror = () => {
      setNetPinging(false);
      setNetPingError("Connection lost while checking availability");
      es.close();
      netPingEsRef.current = null;
    };
  }

  // Sync edit fields when task data loads
  useEffect(() => {
    if (q.data) {
      setEditName(q.data.task.name ?? "");
      setEditContent(q.data.task.content ?? "");
      setEditKind(q.data.task.intake_kind ?? "manual");
    }
  }, [q.data]);

  // Modal states
  const navigate = useNavigate();
  const [deleteModal, setDeleteModal] = useState(false);
  const [resetModal, setResetModal] = useState(false);
  const [removePlan, setRemovePlan] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<RoleRun | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);

  const intervene = useMutation({
    mutationFn: ({ kind, payload }: { kind: string; payload?: unknown }) => api.intervene(taskId, kind, payload),
    onSuccess: refresh,
  });

  const restore = useMutation({
    mutationFn: (roleRunId: number) => api.restoreTask(taskId, roleRunId),
    onSuccess: () => {
      setRestoreTarget(null);
      setRestoreError(null);
      refresh();
    },
    onError: (e: unknown) => setRestoreError(e instanceof Error ? e.message : "restore failed"),
  });

  const doDelete = async () => {
    try {
      await api.deleteTask(taskId, removePlan);
      if (t?.project_id != null) {
        navigate({ to: "/projects/$projectId", params: { projectId: String(t.project_id) } });
      } else {
        navigate({ to: "/" });
      }
    } catch (e: unknown) {
      // error will show via query refetch
    }
  };

  const doReset = async () => {
    try {
      await api.resetTask(taskId);
      setResetKey((k) => k + 1);
      refresh();
      setResetModal(false);
    } catch (e: unknown) {
      // error will show via query refetch
    }
  };

  /** Per-role coverage items parsed from individual run coverage_json (not the roll-up). */
  interface CoverageItem {
    concern: string;
    status: string;
    note?: string;
  }
  const coverageGrid = useMemo(() => {
    const runs = q.data?.runs ?? [];
    const primaryRuns = runs.filter((r) => !r.run_kind || r.run_kind === "primary");
    // Build a map: concern → roleKey → { status, note }
    const map: Record<string, Record<string, { status: string; note?: string }>> = {};
    const roleKeys: string[] = [];
    const seen = new Set<string>();
    for (const run of primaryRuns) {
      if (!run.coverage_json) continue;
      try {
        const items = JSON.parse(run.coverage_json) as CoverageItem[];
        if (!seen.has(run.role_key)) {
          seen.add(run.role_key);
          roleKeys.push(run.role_key);
        }
        for (const item of items) {
          if (!map[item.concern]) map[item.concern] = {};
          map[item.concern][run.role_key] = { status: item.status, note: item.note };
        }
      } catch {
        /* skip malformed */
      }
    }
    return { map, roleKeys };
  }, [q.data]);

  /** Per-model API call counts and tokens derived from persisted role runs. */
  const modelConfigsQ = useQuery({ queryKey: ["modelConfigs"], queryFn: () => api.modelConfigs() });

  /** Project + roles for the model bubble; shares cache with ProjectBoard's ["project", pid] query. */
  const taskProjectId = q.data?.task.project_id ?? null;
  const projectQ = useQuery({
    queryKey: ["project", taskProjectId],
    queryFn: () => api.project(taskProjectId as number),
    enabled: taskProjectId != null,
  });
  const harnessPolicyQ = useQuery({
    queryKey: ["harness-policy", taskProjectId],
    queryFn: () => api.harnessPolicy(taskProjectId as number),
    enabled: taskProjectId != null,
  });
  const writeCap = useMemo(() => {
    if (!q.data?.task) return null;
    const writeRoles = rolesWithWriteTools(projectQ.data?.roles ?? []);
    return taskWriteCapability(q.data.task, harnessPolicyQ.data?.policy.allowWrite ?? false, writeRoles);
  }, [q.data?.task, projectQ.data?.roles, harnessPolicyQ.data?.policy.allowWrite]);

  const { modelCallCounts, modelTokens } = useMemo(() => {
    const counts: Record<string, number> = {};
    const tokens: Record<string, number> = {};
    for (const run of q.data?.runs ?? []) {
      if (!run.model) continue;
      const key = String(run.model);
      counts[key] = (counts[key] ?? 0) + 1;
      if (run.tokens != null) {
        tokens[key] = (tokens[key] ?? 0) + run.tokens;
      }
    }
    return { modelCallCounts: counts, modelTokens: tokens };
  }, [q.data]);

  /** Map model display name → location ("local" | "api") from model configs. */
  const modelLocationMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const cfg of modelConfigsQ.data?.configs ?? []) {
      if (cfg.default_model && cfg.location) {
        map[cfg.default_model] = cfg.location;
      }
    }
    return map;
  }, [modelConfigsQ.data]);

  /** Local / API call & token aggregates. */
  const localApiAgg = useMemo(() => {
    let local = 0;
    let api = 0;
    let localTok = 0;
    let apiTok = 0;
    for (const [model, count] of Object.entries(modelCallCounts)) {
      const loc = modelLocationMap[model] ?? "api";
      if (loc === "local") {
        local += count;
        localTok += modelTokens[model] ?? 0;
      } else {
        api += count;
        apiTok += modelTokens[model] ?? 0;
      }
    }
    return { local, api, localTok, apiTok };
  }, [modelCallCounts, modelTokens, modelLocationMap]);

  /** Average TPS across all completed roles in this session. */
  const avgTps = useMemo(() => {
    const all = Object.values(activity.tpsHistory).flat();
    if (all.length === 0) return null;
    return all.reduce((a, b) => a + b, 0) / all.length;
  }, [activity.tpsHistory]);

  if (q.isLoading) return <p className="muted">Loading…</p>;
  if (q.isError || !q.data) return <p className="pill bad">Task not found.</p>;
  const d: TD = q.data;
  const t = d.task;
  const nextPendingRole = d.plan?.steps.find((s) => s.status === "pending")?.role ?? null;
  nextRoleRef.current = nextPendingRole;

  const questionGroups = collectQuestions(d.runs);

  const submitAnswer = (roleKey: string, question: string, answer: string, editKey: string) => {
    if (!answer.trim()) return;
    intervene.mutate({ kind: "question_answer", payload: { role_key: roleKey, question, answer: answer.trim() } });
    // Exit explicit-edit mode; the typed text stays in questionEdits so the
    // input keeps showing it (not the stale default) until the refetched
    // interventions confirm the answer and the row locks.
    setEditingKeys((prev) => {
      const next = new Set(prev);
      next.delete(editKey);
      return next;
    });
  };

  return (
    <div>
      {/* Delete confirmation modal */}
      {deleteModal && (
        <div className="modal-overlay" onClick={() => setDeleteModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Delete Task</h3>
            <p className="muted" style={{ margin: "12px 0" }}>
              This permanently deletes the task and all associated role runs and interventions.
              This cannot be undone.
            </p>
            <label className="modal-check">
              <input type="checkbox" checked={removePlan} onChange={(e) => setRemovePlan(e.target.checked)} />
              Also delete associated .md plan file from disk
            </label>
            <div className="modal-actions">
              <button className="small" onClick={() => { setDeleteModal(false); setRemovePlan(false); }}>Cancel</button>
              <button className="small danger" onClick={doDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Reset confirmation modal */}
      {resetModal && (
        <div className="modal-overlay" onClick={() => setResetModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Reset to Intake</h3>
            <p className="muted" style={{ margin: "12px 0" }}>
              This clears all run history, interventions, and output files, moving the task
              back to intake. The task's name and content are preserved and will be editable.
              {!schedulerRunning && (
                <span style={{ display: "block", marginTop: 8, color: "var(--brass)" }}>
                  ⏸ The scheduler is currently stopped — the task will stay in intake until
                  you restart the loop.
                </span>
              )}
            </p>
            <div className="modal-actions">
              <button className="small" onClick={() => setResetModal(false)}>Cancel</button>
              <button className="small warn" onClick={doReset}>Reset</button>
            </div>
          </div>
        </div>
      )}

      {/* Restore checkpoint confirmation modal */}
      {restoreTarget && (
        <div className="modal-overlay" onClick={() => { setRestoreTarget(null); setRestoreError(null); }}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Restore to "{restoreTarget.role_key}"</h3>
            <p className="muted" style={{ margin: "12px 0" }}>
              {(() => {
                const discarded = d.runs.filter(
                  (x) => x.id > restoreTarget.id && (!x.run_kind || x.run_kind === "primary"),
                ).length;
                return discarded
                  ? `This discards ${discarded} later role run${discarded === 1 ? "" : "s"} and resets the ` +
                    `task's checkpoint branch back to right after ${restoreTarget.role_key} finished. The task ` +
                    `will resume from there. This cannot be undone.`
                  : `This resets the task's checkpoint branch back to right after ${restoreTarget.role_key} ` +
                    `finished. This cannot be undone.`;
              })()}
            </p>
            {restoreError && <p className="pill bad" style={{ marginBottom: 12 }}>{restoreError}</p>}
            <div className="modal-actions">
              <button className="small" onClick={() => { setRestoreTarget(null); setRestoreError(null); }}>Cancel</button>
              <button className="small warn" disabled={restore.isPending} onClick={() => restore.mutate(restoreTarget.id)}>
                {restore.isPending ? "Restoring…" : "Restore"}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="row" style={{ marginBottom: 12 }}>
        {t.project_id != null && (
          <Link to="/projects/$projectId" params={{ projectId: String(t.project_id) }}>← board</Link>
        )}
        <h2 style={{ margin: 0, color: "var(--brass)" }}>{t.name ?? t.task_id.slice(0, 8)}</h2>
        {projectQ.data && (
          <ModelBubble
            projectId={taskProjectId as number}
            defaultModel={projectQ.data.project.default_model}
            roles={projectQ.data.roles}
          />
        )}
        <span className={`pill ${t.stage === "ready" ? "ok" : t.stage === "review" ? "human" : "dim"}`}>{t.stage}</span>
        {writeCap === "acting" && (
          <span className="pill accent" title="This task's plan includes a role with write/edit tools, in a write-enabled project">acting</span>
        )}
        {writeCap === "acting" && t.wrote_source === 1 && (
          <span className="pill warn" title="A role has already written to this task's worktree">wrote code</span>
        )}
        {writeCap === "planning" && <span className="pill dim">planning</span>}
        {t.exit_state === "wont_do" && <span className="pill dim">won't do</span>}
        {t.exit_state === "network_unavailable" && <span className="pill bad">network unavailable</span>}
        <span className="pill dim">{t.intake_kind}</span>
        <span className="pill dim">exit: {t.exit_kind}</span>
        {t.paused === 1 && <span className="pill warn">paused</span>}
        {t.reconcile_status === "pending_human_merge" && (
          t.github_pr_url ? (
            <a className="pill ok" href={t.github_pr_url} target="_blank" rel="noreferrer" onClick={() => setDiffOpen(true)}>
              PR open →
            </a>
          ) : (
            <button type="button" className="pill warn" title={t.reconcile_detail ?? undefined} onClick={() => setDiffOpen(true)}>
              review branch "{t.git_branch}"
            </button>
          )
        )}
        {diffOpen && (
          <DiffPanel
            taskId={t.task_id}
            task={t}
            projectHasGithubToken={projectQ.data?.project.has_github_token ?? false}
            onClose={() => setDiffOpen(false)}
            onMutate={refresh}
          />
        )}
      </div>

      {t.network_id && t.stage !== "intake" && (
        <div className="panel task-network-panel">
          <div className="plan-header">
            <h2 style={{ marginBottom: 0 }}>Agent Network</h2>
            <button className="small" onClick={() => setShowNetworkGraph((p) => !p)}>
              {showNetworkGraph ? "▾ Hide" : "▸ Show"}
            </button>
          </div>
          {showNetworkGraph && (
            <TaskNetworkGraph
              networkId={t.network_id}
              runs={d.runs}
              plan={d.plan}
              currentRole={activity.currentRole}
              projectId={t.project_id}
            />
          )}
        </div>
      )}

      <div className="detail-grid">
        <div>
          {/* Show recap for review/ready, then the ReviewCTA actions */}
          {t.stage === "ready" || t.stage === "review" ? (
            <>
              {activity.recapGenerating && !d.recap_md && (
                <div className="panel">
                  <div className="recap-loading">
                    <span className="in-progress-pulse" />
                    <span>Generating final assessment…</span>
                  </div>
                </div>
              )}
              {d.recap_md && (
                <div className="panel">
                  <h2>Final Status</h2>
                  <div
                    className="section-md rendered-md"
                    style={{ marginBottom: 16 }}
                    dangerouslySetInnerHTML={{ __html: marked.parse(d.recap_md) as string }}
                  />
                </div>
              )}
            </>
          ) : (
            <div className="panel">
              <h2>Live activity</h2>
              <div className="live" ref={liveRef} onScroll={handleLiveScroll}>
                {lines.length ? lines.map((item, i) => <LiveLine key={i} item={item} />) : <span className="muted">Waiting for the active role… (start the loop if stopped)</span>}
                {!pinned && (
                  <button className="live-jump" onClick={jumpToLive}>
                    ↓ latest
                  </button>
                )}
              </div>
            </div>
          )}

          {t.network_id ? (
            <RefinementNetworkPanel
              networkId={t.network_id}
              runs={d.runs}
              plan={d.plan}
              currentRole={activity.currentRole}
              lastRole={activity.lastRole}
              projectId={t.project_id}
              selectedNodeRole={selectedNodeRole}
              onSelectNodeRole={setSelectedNodeRole}
              onJumpToRole={(roleKey) => {
                const el = document.getElementById(`run-${roleKey}`);
                if (el) {
                  el.scrollIntoView({ behavior: "smooth", block: "start" });
                  setCollapsedRuns((prev) => {
                    const run = d.runs.find((r) => r.role_key === roleKey);
                    if (run && prev.has(run.id)) {
                      const next = new Set(prev);
                      next.delete(run.id);
                      return next;
                    }
                    return prev;
                  });
                }
              }}
            />
          ) : (
            <div className="panel">
              <div className="plan-header">
                <h2>Refinement plan</h2>
              </div>
              <div className="row">
                {d.plan?.steps.map((s, i) => (
                  <a
                    key={i}
                    href={`#run-${s.role}`}
                    className={`pill ${s.status === "done" ? "ok" : s.status === "skipped" ? "dim" : "warn"}`}
                    onClick={(e) => {
                      e.preventDefault();
                      const el = document.getElementById(`run-${s.role}`);
                      if (el) {
                        el.scrollIntoView({ behavior: "smooth", block: "start" });
                        setCollapsedRuns((prev) => {
                          const run = d.runs.find((r) => r.role_key === s.role);
                          if (run && prev.has(run.id)) {
                            const next = new Set(prev);
                            next.delete(run.id);
                            return next;
                          }
                          return prev;
                        });
                      }
                    }}
                  >
                    {s.role}{s.depth > 1 ? `·d${s.depth}` : ""}
                  </a>
                )) ?? <span className="muted">Not planned yet.</span>}
              </div>
            </div>
          )}

          {/* In-progress role slat — shows as soon as role_start fires, before run is persisted */}
          {activity.currentRole && activity.disposition !== "done" && (
            <div className="panel in-progress" id="in-progress-role">
              <div className="row" style={{ marginBottom: 6 }}>
                <span className="in-progress-pulse" />
                <h2 style={{ margin: 0 }}>{activity.currentRole}</h2>
                <span className="pill warn">in progress</span>
                <div style={{ flex: 1 }} />
                {activity.roleStartTime && (
                  <span className="muted" style={{ fontSize: 11 }}>
                    <ElapsedTime startTime={activity.roleStartTime} />
                  </span>
                )}
              </div>
              <div className="in-progress-stats">
                <div className="in-progress-stat">
                  <span className="muted">disposition</span>
                  <span className="pill">
                    {activity.disposition === "reading" && "📖 reading"}
                    {activity.disposition === "thinking" && "💭 thinking"}
                    {activity.disposition === "responding" && "✍ responding"}
                    {activity.disposition === "tool" && "🔧 tool use"}
                  </span>
                </div>
                <div className="in-progress-stat">
                  <span className="muted">tps</span>
                  <span className="pill dim">
                    {(() => {
                      const roleHistory = activity.currentRole ? activity.tpsHistory[activity.currentRole] : undefined;
                      if (roleHistory && roleHistory.length > 0) {
                        const minTps = Math.min(...roleHistory).toFixed(0);
                        const maxTps = Math.max(...roleHistory).toFixed(0);
                        return minTps === maxTps ? `${minTps} tps` : `min ${minTps} / max ${maxTps} tps`;
                      }
                      return "—";
                    })()}
                  </span>
                </div>
              </div>
              <details className="in-progress-details" style={{ marginTop: 8 }}>
                <summary className="muted" style={{ cursor: "pointer", fontSize: 12 }}>
                  System prompt & settings
                </summary>
                <div style={{ marginTop: 8 }}>
                  {t.project_id != null ? (
                    <p className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
                      Role configuration is sourced from the project's role settings.{" "}
                      <Link to="/projects/$projectId/roles" params={{ projectId: String(t.project_id) }} className="muted" style={{ textDecoration: "underline" }}>
                        Customize in Settings →
                      </Link>
                    </p>
                  ) : (
                    <p className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
                      This task is not associated with a project.{" "}
                      <Link to="/settings" className="muted" style={{ textDecoration: "underline" }}>
                        Manage global roles in Settings →
                      </Link>
                    </p>
                  )}
                  <div className="in-progress-config-hint">
                    <span className="muted" style={{ fontSize: 11 }}>
                      The system prompt, tools, and model for this role are configurable per-project
                      under the Roles editor. Changes take effect on the next role run.
                    </span>
                  </div>
                </div>
              </details>
            </div>
          )}

          {/* Per-role findings — collapsible caret below refinement plan and in-progress */}
          {t.stage === "ready" || t.stage === "review" ? (
            d.runs.some((r) => r.output_md) && (
              <details style={{ marginTop: 16 }}>
                <summary className="muted" style={{ cursor: "pointer" }}>Per-role findings</summary>
                <div style={{ marginTop: 8 }}>
                  {d.runs.map((r) =>
                    r.output_md ? (
                      <div
                        key={r.id}
                        className="section-md rendered-md"
                        style={{ marginBottom: 12 }}
                        dangerouslySetInnerHTML={{ __html: marked.parse(r.output_md) as string }}
                      />
                    ) : null,
                  )}
                </div>
              </details>
            )
          ) : null}

          {(() => {
            const primaryRuns = d.runs.filter((r) => !r.run_kind || r.run_kind === "primary");
            return primaryRuns.length > 0 && (
              <div className="row" style={{ marginBottom: 8 }}>
                <button
                  className="small"
                  onClick={() => {
                    if (collapsedRuns.size === primaryRuns.length) {
                      setCollapsedRuns(new Set());
                    } else {
                      setCollapsedRuns(new Set(primaryRuns.map((r) => r.id)));
                    }
                  }}
                >
                  {collapsedRuns.size === primaryRuns.length ? "expand all" : "collapse all"}
                </button>
              </div>
            );
          })()}
          {d.runs.filter((r) => !r.run_kind || r.run_kind === "primary").map((r) => {
            const isCollapsed = collapsedRuns.has(r.id);
            const toggle = () =>
              setCollapsedRuns((prev) => {
                const next = new Set(prev);
                if (next.has(r.id)) next.delete(r.id);
                else next.add(r.id);
                return next;
              });
            return (
              <div className="panel" key={r.id} id={`run-${r.role_key}`}>
                <div className="row collapsible" onClick={toggle}>
                  <span className="collapse-caret">{isCollapsed ? "▸" : "▾"}</span>
                  <h2 style={{ margin: 0, cursor: "pointer" }}>{r.role_key}</h2>
                  <span className={`pill ${verdictClass(r.verdict)}`}>{r.verdict ?? "?"}</span>
                  {r.fallback === 1 && <span className="pill warn" title="Model never called record_findings — output was salvaged">no verdict</span>}
                  {r.stop_reason === "length" && <span className="pill bad" title="Output hit the token limit before finishing">truncated</span>}
                  {r.stalled === 1 && <span className="pill warn" title="Model narrated calling record_findings instead of invoking it — auto-aborted and retried">stalled</span>}
                  {r.tokens != null && <span className="muted">{r.tokens} tok</span>}
                  {r.depth > 1 && <span className="pill dim">depth {r.depth}</span>}
                  <div style={{ flex: 1 }} />
                  <button
                    className="small"
                    onClick={(e) => {
                      e.stopPropagation();
                      intervene.mutate({ kind: "deepen", payload: { role: r.role_key } });
                    }}
                  >
                    deepen
                  </button>
                  <button
                    className="small"
                    disabled={!r.git_commit_sha}
                    title={r.git_commit_sha ? "Roll the task back to right after this role finished" : "No checkpoint recorded for this run"}
                    onClick={(e) => {
                      e.stopPropagation();
                      setRestoreError(null);
                      setRestoreTarget(r);
                    }}
                  >
                    restore
                  </button>
                  <button
                    className="small"
                    disabled={!r.git_commit_sha}
                    title={r.git_commit_sha ? "Show what this run changed" : "No checkpoint recorded for this run"}
                    onClick={(e) => {
                      e.stopPropagation();
                      setRunDiffOpen((prev) => {
                        const next = new Set(prev);
                        if (next.has(r.id)) next.delete(r.id);
                        else next.add(r.id);
                        return next;
                      });
                    }}
                  >
                    diff
                  </button>
                  {t.project_id != null && (
                    <Link
                      to="/projects/$projectId/roles"
                      params={{ projectId: String(t.project_id) }}
                      search={{ role: r.role_key }}
                      className="small"
                      title={`View ${r.role_key} configuration`}
                      onClick={(e: React.MouseEvent) => e.stopPropagation()}
                      style={{ fontSize: 14, lineHeight: 1, textDecoration: "none" }}
                    >
                      👤
                    </Link>
                  )}
                </div>
                {!isCollapsed && r.summary && <p className="muted" style={{ margin: "6px 0" }}>{r.summary}</p>}
                {!isCollapsed && r.output_md && (
                  <div className="section-md rendered-md" dangerouslySetInnerHTML={{ __html: marked.parse(r.output_md) as string }} />
                )}
                {!isCollapsed && runDiffOpen.has(r.id) && <RunDiffSection taskId={t.task_id} runId={r.id} />}
                {!isCollapsed && r.thinking_md && (
                  <details className="reasoning-trace" style={{ marginTop: 8 }}>
                    <summary className="muted" style={{ cursor: "pointer" }}>💭 Reasoning trace ({r.thinking_md.length.toLocaleString()} chars)</summary>
                    <pre className="reasoning-body muted" style={{ whiteSpace: "pre-wrap", overflowWrap: "break-word", fontSize: 12, marginTop: 6 }}>{r.thinking_md}</pre>
                  </details>
                )}
                {!isCollapsed && (() => {
                  const critiques = d.runs.filter((cr) => cr.target_run_id === r.id);
                  if (!critiques.length) return null;
                  return (
                    <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid var(--line)" }}>
                      {critiques.map((cr) => (
                        <div key={cr.id} className="row" style={{ alignItems: "flex-start", gap: 6, marginBottom: 6 }}>
                          <span
                            className="pill dim"
                            title={cr.run_kind === "second_review" ? "Orchestrator second review" : "Adversarial critique"}
                          >
                            {cr.run_kind === "second_review" ? "second review" : "critic"}
                          </span>
                          <span className={`pill ${verdictClass(cr.verdict)}`}>{cr.verdict ?? "?"}</span>
                          {cr.summary && <span className="muted" style={{ fontSize: 13 }}>{cr.summary}</span>}
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
            );
          })}

          {d.children.length > 0 && (
            <div className="panel">
              <h2>Decomposition</h2>
              <table>
                <tbody>
                  {d.children.map((c) => (
                    <tr key={c.task_id}>
                      <td><span className="pill dim">{c.level}</span></td>
                      <td>
                        <Link to="/tasks/$taskId" params={{ taskId: c.task_id }}>
                          {c.name}
                        </Link>
                        {c.stale_reason && (
                          <span
                            className="pill bad"
                            style={{ marginLeft: 6 }}
                            title={c.stale_reason}
                          >
                            possibly stale
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div>

          {/* Immediate next steps — shown when task is in review or ready */}
          {(t.stage === "ready" || t.stage === "review") && (
            <ReviewCTA
              taskId={taskId}
              task={t}
              recapMd={d.recap_md}
              coverage={d.coverage}
              runs={d.runs}
              interventions={d.interventions}
              childTasks={d.children}
              onMutate={refresh}
            />
          )}

          {/* Current state panel — shown whenever there's meaningful state */}
          {(activity.currentRole || activity.lastRole) && (
            <div className="panel">
              <h2>Current State</h2>
              <div className="current-state">
                {activity.currentRole && (
                  <div className="current-state-row">
                    <span className="muted">Role</span>
                    <a
                      href="#in-progress-role"
                      className="pill warn clickable-role"
                      onClick={(e) => {
                        e.preventDefault();
                        const el = document.getElementById("in-progress-role");
                        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
                      }}
                      title="Jump to in-progress role slat"
                    >
                      {activity.currentRole}
                    </a>
                  </div>
                )}
                {activity.disposition && (
                  <div className="current-state-row">
                    <span className="muted">Disposition</span>
                    <span className="pill">
                      {activity.disposition === "reading" && "📖 reading"}
                      {activity.disposition === "thinking" && "💭 thinking"}
                      {activity.disposition === "responding" && "✍ responding"}
                      {activity.disposition === "tool" && "🔧 tool use"}
                      {activity.disposition === "done" && "✅ complete"}
                    </span>
                  </div>
                )}
                {activity.roleStartTime && activity.disposition !== "done" && (
                  <div className="current-state-row">
                    <span className="muted">Elapsed</span>
                    <span className="pill dim">
                      <ElapsedTime startTime={activity.roleStartTime} />
                    </span>
                  </div>
                )}
                {activity.disposition === "done" && activity.lastRole && (
                  <div className="current-state-row">
                    <span className="muted">Model</span>
                    <span className="pill dim">
                      {activity.lastRole.model ?? "—"} | {(activity.lastRole.tokens / activity.lastRole.elapsedSec).toFixed(0)} tps
                    </span>
                  </div>
                )}
                {activity.disposition !== "done" && (activity.currentModel || activity.lastRole) && (
                  <div className="current-state-row">
                    <span className="muted">Model</span>
                    <span className="pill dim">
                      {activity.currentModel ?? activity.lastRole?.model ?? "—"}{activity.lastRole ? ` | ${(activity.lastRole.tokens / activity.lastRole.elapsedSec).toFixed(0)} tps (${activity.lastRole.tokens} tok / ${(activity.lastRole.elapsedSec).toFixed(1)}s)` : " | — tps"}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* API Calls panel — expanded with local/API split, avg TPS, and per-model breakdown */}
          {Object.keys(modelCallCounts).length > 0 && (
            <div className="panel">
              <h2>API Calls</h2>
              <div className="calls-summary">
                <div className="calls-total">
                  <span className="calls-total-num">
                    {localApiAgg.local + localApiAgg.api}
                  </span>
                  <span className="muted" style={{ fontSize: 11 }}>total calls</span>
                </div>
                {/* Local / API progress bar */}
                {localApiAgg.local + localApiAgg.api > 0 && (
                  <div className="api-calls-bar-container">
                    <div className="api-calls-bar" style={{ display: "flex", borderRadius: 5, overflow: "hidden", background: "var(--panel-2)" }}>
                      {localApiAgg.local > 0 && (
                        <span
                          className="api-calls-bar__internal"
                          style={{ width: `${(localApiAgg.local / (localApiAgg.local + localApiAgg.api)) * 100}%`, height: 10 }}
                          title="local (internal)"
                        />
                      )}
                      {localApiAgg.api > 0 && (
                        <span
                          className="api-calls-bar__external"
                          style={{ width: `${(localApiAgg.api / (localApiAgg.local + localApiAgg.api)) * 100}%`, height: 10 }}
                          title="api (external)"
                        />
                      )}
                    </div>
                    <div className="api-calls-label">
                      {localApiAgg.local} local / {localApiAgg.api} api
                    </div>
                  </div>
                )}
                {/* Average TPS */}
                {avgTps != null && (
                  <div className="calls-avg-tps">
                    <span className="muted">avg </span>
                    <span className="pill dim">{avgTps.toFixed(0)} tps</span>
                  </div>
                )}
                {/* Per-model breakdown */}
                <div className="calls-section-label muted">per model</div>
                <div className="calls-breakdown">
                  {Object.entries(modelCallCounts)
                    .sort(([, a], [, b]) => b - a)
                    .map(([model, count]) => {
                      const loc = modelLocationMap[model] ?? "api";
                      return (
                        <div key={model} className="calls-model-row">
                          <span className="calls-model-name">{displayModelName(model)}</span>
                          <span className="pill dim">{count} call{count > 1 ? "s" : ""}</span>
                          {modelTokens[model] != null && (
                            <span className="calls-model-tokens muted">
                              {(modelTokens[model]).toLocaleString()} tok
                            </span>
                          )}
                          <span className={`pill calls-loc-pill ${loc === "local" ? "ok" : "accent"}`}>{loc}</span>
                        </div>
                      );
                    })}
                </div>
              </div>
            </div>
          )}

          {t.exit_state === "network_unavailable" && (
            <div className="panel network-blocked-panel">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <h2 style={{ margin: 0 }}>Network unavailable</h2>
                <button className="small" disabled={netPinging} onClick={checkNetworkAvailability}>
                  {netPinging ? "Checking…" : "Check availability"}
                </button>
              </div>
              <p className="muted" style={{ marginTop: 8 }}>
                Stopped before starting — {t.review_reason ?? "a model endpoint used by this task's network wasn't reachable"}.
                Nothing is running; use Resume below once connectivity is confirmed.
              </p>
              {netPingError && <p className="pill bad" style={{ marginTop: 8 }}>{netPingError}</p>}
              {netPingResults && (
                <div className="ping-results" style={{ marginTop: 8 }}>
                  {netPingResults.map((r) => (
                    <div
                      key={r.target_id}
                      className={`ping-node ${r.status === "checking" ? "ping-checking" : r.available ? "ping-ok" : "ping-down"}`}
                    >
                      <span className={`ping-dot ${r.status === "checking" ? "ping-dot--checking" : r.available ? "ok" : "bad"}`} />
                      <span className="ping-name">{r.label}</span>
                      <span className="pill dim" style={{ fontSize: 10 }}>{r.kind}</span>
                      <span className="muted" style={{ fontSize: 11 }}>{r.roles.join(", ")}</span>
                      {r.status === "checking" && <span className="pill dim" style={{ fontSize: 10 }}>checking…</span>}
                      {r.status === "done" && r.error && <span className="pill bad" style={{ fontSize: 10 }}>{r.error}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="panel">
            <div className="steering-header">
              <h2 style={{ margin: 0 }}>Steering</h2>
              <div className="steer">
                {t.paused === 1 ? (
                  <button className="small primary" onClick={() => intervene.mutate({ kind: "resume" })}>Resume</button>
                ) : (
                  <button className="small" onClick={() => intervene.mutate({ kind: "pause" })}>Pause</button>
                )}
                <button className="small" onClick={() => setResetModal(true)} title="Reset to intake">
                  🔄
                </button>
                <button className="small danger" onClick={() => { setRemovePlan(false); setDeleteModal(true); }} title="Delete task">
                  🗑
                </button>
              </div>
              <button
                className="small"
                onClick={() => setShowAdvancedSteering((p) => !p)}
                title={showAdvancedSteering ? "Hide advanced controls" : "Show advanced controls"}
              >
                {showAdvancedSteering ? "Advanced ▾" : "Advanced ▸"}
              </button>
            </div>
            {showAdvancedSteering && (
              <>
                <div className="steer" style={{ marginTop: 8 }}>
                  <button className="small" onClick={() => api.tick().then(refresh)}>Tick now</button>
                </div>
                <label style={{ marginTop: 8 }}>Inject with after / promote</label>
                <div className="steer">
                  <select value={roleInput} onChange={(e) => setRoleInput(e.target.value)}>
                    <option value="">— role —</option>
                    {["privacy_review", "security_review", "performance_review", "test_strategy", "edge_case_analysis", "options_exploration", "ux_review"].map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                  <input style={{ width: 120 }} value={afterInput} onChange={(e) => setAfterInput(e.target.value)} placeholder="after (role)" />
                  <button className="small" disabled={!roleInput} onClick={() => intervene.mutate({ kind: "inject_role", payload: { role: roleInput, after: afterInput || undefined } })}>inject</button>
                  <button className="small" disabled={!roleInput} onClick={() => intervene.mutate({ kind: "promote_role", payload: { role: roleInput } })}>promote</button>
                </div>
                <label>Steer note / pin a question</label>
                <div className="steer">
                  <input value={noteInput} onChange={(e) => setNoteInput(e.target.value)} placeholder="focus on token handling…" />
                  <button className="small" disabled={!noteInput} onClick={() => { intervene.mutate({ kind: "steer_note", payload: { text: noteInput } }); setNoteInput(""); }}>add</button>
                </div>
              </>
            )}

            {d.interventions.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <h2 style={{ marginBottom: 6 }}>Steering log</h2>
                <div className="steering-log">
                  {[...d.interventions].reverse().map((iv) => {
                    let payload: Record<string, unknown> = {};
                    try { payload = iv.payload_json ? JSON.parse(iv.payload_json) : {}; } catch { /* skip */ }

                    const kindLabel = {
                      steer_note: "NOTE",
                      pin_question: "PIN",
                      question_answer: "ANSWER",
                      inject_role: "INJECT",
                      deepen: "DEEPEN",
                      promote_role: "PROMOTE",
                      pause: "PAUSE",
                      resume: "RESUME",
                      run_now: "RUN NOW",
                    }[iv.kind] ?? iv.kind.toUpperCase();

                    const detail =
                      iv.kind === "steer_note" || iv.kind === "pin_question"
                        ? (payload.text as string ?? "")
                        : iv.kind === "inject_role"
                          ? `${payload.role ?? "?"}${payload.after ? " after " + payload.after : ""}`
                          : iv.kind === "deepen" || iv.kind === "promote_role"
                            ? (payload.role as string ?? "?")
                            : "";

                    const isConsumed = iv.consumed_at != null;

                    return (
                      <div key={iv.id} className={`steering-entry ${isConsumed ? "consumed" : "pending"}`}>
                        <span className={`pill ${isConsumed ? "dim" : "warn"}`}>{kindLabel}</span>
                        {detail && <span className={isConsumed ? "muted" : ""}>{detail}</span>}
                        <span className="muted" style={{ fontSize: 11 }}>{iv.created_at.replace("T", " ").slice(0, 16)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <div className="panel">
            <h2>Coverage map</h2>
            {coverageGrid.roleKeys.length > 0 ? (
              <>
                <div className="coverage-grid" style={{ gridTemplateColumns: `120px repeat(${coverageGrid.roleKeys.length}, minmax(28px, 1fr))` }}>
                  {/* Dynamic x-axis label row — shows which role column is being hovered */}
                  <div className="coverage-grid-concern coverage-x-label-label">role</div>
                  <div className="coverage-x-label" style={{ gridColumn: `span ${coverageGrid.roleKeys.length}` }}>
                    {hoveredCoverage ? (
                      <span className="coverage-x-label-text">{hoveredCoverage.role}</span>
                    ) : (
                      <span className="coverage-x-label-placeholder">hover a column…</span>
                    )}
                  </div>
                  {/* Data rows — one per concern */}
                  {d.taxonomy.map((concern) => (
                    <div key={concern} className="coverage-row" style={{ display: "contents" }}>
                      <span className="coverage-grid-concern">{concern}</span>
                      {coverageGrid.roleKeys.map((roleKey) => {
                        const entry = coverageGrid.map[concern]?.[roleKey];
                        const status = entry?.status ?? "never";
                        const hasRun = d.runs.some((r) => r.role_key === roleKey && (!r.run_kind || r.run_kind === "primary"));
                        return (
                          <span
                            key={roleKey}
                            className="coverage-dot-wrapper"
                            onMouseEnter={() => setHoveredCoverage({ role: roleKey, concern })}
                            onClick={() => {
                              if (hasRun) {
                                const el = document.getElementById(`run-${roleKey}`);
                                if (el) {
                                  el.scrollIntoView({ behavior: "smooth", block: "start" });
                                  setCollapsedRuns((prev) => {
                                    const run = d.runs.find((r) => r.role_key === roleKey && (!r.run_kind || r.run_kind === "primary"));
                                    if (run && prev.has(run.id)) {
                                      const next = new Set(prev);
                                      next.delete(run.id);
                                      return next;
                                    }
                                    return prev;
                                  });
                                }
                              }
                            }}
                            title={hasRun ? `Click to jump to ${roleKey} findings` : undefined}
                            style={{ cursor: hasRun ? "pointer" : "default" }}
                          >
                            <span className={`coverage-dot coverage-dot--${status}`} />
                          </span>
                        );
                      })}
                    </div>
                  ))}
                </div>
                {/* Info panel below the coverage map — shows details for hovered cell */}
                <div className="coverage-info-panel">
                  {hoveredCoverage ? (
                    (() => {
                      const entry = coverageGrid.map[hoveredCoverage.concern]?.[hoveredCoverage.role];
                      const status = entry?.status ?? "never";
                      const note = entry?.note;
                      const vs = verdictStyle(status === "considered" ? "pass" : status === "skipped" ? "needs_more" : status === "out_of_scope" ? "needs_human" : "done");
                      return (
                        <div className="coverage-info-content">
                          <span className="coverage-info-role">{hoveredCoverage.role}</span>
                          <span className="coverage-info-sep">·</span>
                          <span className="coverage-info-concern">{hoveredCoverage.concern}</span>
                          <span className={`pill ${vs.cls.replace("pill ", "")}`} style={{ marginLeft: 8 }}>{status}</span>
                          {note && <span className="muted coverage-info-note">{note}</span>}
                        </div>
                      );
                    })()
                  ) : (
                    <span className="muted coverage-info-placeholder">Hover over a dot to see role & disposition</span>
                  )}
                </div>
              </>
            ) : d.coverage ? (
              <div className="coverage">
                {d.taxonomy.map((concern) => {
                  const c = d.coverage?.[concern] ?? { status: "never" };
                  return (
                    <div key={concern} className={c.status} style={{ display: "contents" }}>
                      <span className={c.status}>{concern}</span>
                      <span className={c.status}>{c.status === "never" ? "never looked at" : c.status}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="muted">No coverage recorded yet.</p>
            )}
          </div>

          <div className="panel">
            <div className="plan-header">
              <h2>Intake — original request</h2>
            </div>
            <div className="intake-content">
              <div className="row" style={{ marginBottom: 6 }}>
                <span className="pill dim">kind: {t.intake_kind ?? "—"}</span>
                <span className="pill dim">name: {t.name ?? t.task_id.slice(0, 8)}</span>
              </div>
              {t.stage === "intake" ? (
                <>
                  <label className="muted" style={{ display: "block", marginBottom: 4 }}>Name</label>
                  <input
                    className="intake-textarea"
                    style={{ minHeight: "auto", height: "auto", marginBottom: 8 }}
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    placeholder="Task name"
                  />
                  <label className="muted" style={{ display: "block", marginBottom: 4 }}>Kind</label>
                  <div className="row" style={{ marginBottom: 8, gap: 8, alignItems: "center" }}>
                    <select value={editKind} onChange={(e) => setEditKind(e.target.value)}>
                      {["manual", "error_file", "feature", "bug", "chore", "spike", "research", "ux", "question"].map((k) => (
                        <option key={k} value={k}>{k}</option>
                      ))}
                    </select>
                    {t.project_id != null && (
                      <NetworkSelector taskId={t.task_id} projectId={t.project_id!} intakeKind={editKind} onChanged={refresh} />
                    )}
                  </div>
                  <label className="muted" style={{ display: "block", marginBottom: 4 }}>Content</label>
                  <textarea
                    className="intake-textarea"
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    placeholder="No intake content recorded."
                  />
                  {!schedulerRunning && (
                    <div className="banner stopped" style={{ marginTop: 8 }}>
                      ⏸ Scheduler is stopped — task will stay in intake until you restart it.
                    </div>
                  )}
                  <div className="row" style={{ marginTop: 8, gap: 8 }}>
                    <button
                      className="small primary"
                      disabled={saving}
                      onClick={async () => {
                        setSaving(true);
                        try {
                          await api.updateTask(taskId, { name: editName, content: editContent, intake_kind: editKind });
                          refresh();
                        } catch (e: unknown) {
                          // error will show via query refetch
                        } finally {
                          setSaving(false);
                        }
                      }}
                    >
                      {saving ? "Saving…" : "Save"}
                    </button>
                    <button
                      className="small"
                      onClick={() => {
                        setEditName(t.name ?? "");
                        setEditContent(t.content ?? "");
                        setEditKind(t.intake_kind ?? "manual");
                      }}
                    >
                      Revert
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <textarea
                    className="intake-textarea"
                    value={t.content ?? ""}
                    onChange={() => {}}
                    placeholder="No intake content recorded."
                  />
                  <p className="intake-note muted">
                    Not in intake —{" "}
                    <button
                      className="link"
                      onClick={() => setResetModal(true)}
                      style={{ color: "var(--brass)", background: "none", border: "none", cursor: "pointer", padding: 0, textDecoration: "underline" }}
                    >
                      reset
                    </button>{" "}
                    to intake to edit name and content.
                  </p>
                </>
              )}
            </div>
          </div>

          {questionGroups.length > 0 && t.stage !== "review" && t.stage !== "ready" && (
            <div className="panel">
              <h2>Questions</h2>
              <div className="questions-panel">
                {questionGroups.map((group) => (
                  <div key={group.runId} className="questions-role-group">
                    <div className="questions-role-header">
                      <a
                        href={`#run-${group.roleKey}`}
                        onClick={(e) => {
                          e.preventDefault();
                          const el = document.getElementById(`run-${group.roleKey}`);
                          if (el) {
                            el.scrollIntoView({ behavior: "smooth", block: "start" });
                            setCollapsedRuns((prev) => {
                              if (prev.has(group.runId)) {
                                const next = new Set(prev);
                                next.delete(group.runId);
                                return next;
                              }
                              return prev;
                            });
                          }
                        }}
                      >
                        {group.roleKey}
                      </a>
                      <span className="pill dim">{group.questions.length} Q</span>
                    </div>
                    {group.questions.map((rawQ, qi) => {
                      const pq = parseQuestion(rawQ);
                      const editKey = `${group.runId}:${qi}`;
                      const answered = findAnsweredQuestion(d.interventions, group.roleKey, pq.text);
                      const isEditing = !answered || editingKeys.has(editKey);
                      const editVal = questionEdits[editKey] ?? answered?.answer ?? pq.defaultAnswer ?? "";
                      return (
                        <div key={qi} className="question-item">
                          <p className="question-text">{pq.text}</p>
                          {isEditing && pq.options.length > 0 && (
                            <div className="question-options">
                              {pq.options.map((opt, oi) => (
                                <button
                                  key={oi}
                                  className={`small pill ${editVal === opt ? "ok" : "dim"}`}
                                  onClick={() => setQuestionEdits((prev) => ({ ...prev, [editKey]: opt }))}
                                >
                                  {opt}
                                </button>
                              ))}
                            </div>
                          )}
                          {pq.defaultAnswer && (
                            <p className="question-default">
                              suggested: <strong>{pq.defaultAnswer}</strong>
                            </p>
                          )}
                          {answered && !isEditing && (
                            <p className="question-default">
                              you answered: <strong>{answered.answer}</strong>
                              <span className="pill ok" style={{ marginLeft: 6 }}>
                                answered
                              </span>{" "}
                              <button
                                className="link"
                                style={{
                                  background: "none",
                                  border: "none",
                                  color: "var(--brass)",
                                  cursor: "pointer",
                                  padding: 0,
                                  textDecoration: "underline",
                                  fontSize: 11,
                                }}
                                onClick={() => {
                                  setEditingKeys((prev) => new Set(prev).add(editKey));
                                  setQuestionEdits((prev) => ({ ...prev, [editKey]: answered.answer }));
                                }}
                              >
                                change answer
                              </button>
                            </p>
                          )}
                          {isEditing && (
                            <div className="question-answer-row">
                              <input
                                className="question-answer-input"
                                value={editVal}
                                onChange={(e) => setQuestionEdits((prev) => ({ ...prev, [editKey]: e.target.value }))}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" && editVal.trim()) {
                                    submitAnswer(group.roleKey, pq.text, editVal, editKey);
                                  }
                                }}
                                placeholder={pq.defaultAnswer ? `or edit default: ${pq.defaultAnswer}` : "your answer…"}
                              />
                              <button
                                className="small primary"
                                disabled={!editVal.trim()}
                                onClick={() => submitAnswer(group.roleKey, pq.text, editVal, editKey)}
                              >
                                ✓
                              </button>
                              {answered && (
                                <button
                                  className="link"
                                  style={{
                                    background: "none",
                                    border: "none",
                                    color: "var(--ink-dim)",
                                    cursor: "pointer",
                                    padding: "0 4px",
                                    fontSize: 11,
                                  }}
                                  onClick={() =>
                                    setEditingKeys((prev) => {
                                      const next = new Set(prev);
                                      next.delete(editKey);
                                      return next;
                                    })
                                  }
                                >
                                  cancel
                                </button>
                              )}
                              <QuestionDecomposeButton
                                parentTaskId={taskId}
                                roleKey={group.roleKey}
                                question={rawQ.question}
                                onMutate={refresh}
                              />
                            </div>
                          )}
                          {(() => {
                            const decomposedChild = d.children.find(
                              (c) =>
                                c.origin_role_key === group.roleKey &&
                                c.origin_question === rawQ.question,
                            );
                            return decomposedChild ? (
                              <DecomposedChildCard task={decomposedChild} />
                            ) : null;
                          })()}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}