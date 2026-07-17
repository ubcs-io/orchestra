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
import { api, verdictClass, type TaskDetail as TD, type RoleRun, type AgentNetworkGraph } from "../api";
import { NetworkNodeCard } from "../components/NetworkNodeCard";
import { ReviewCTA } from "../components/ReviewCTA";

/** Parse an open-question string into structured parts: the clean question, a suggested default, and options. */
interface ParsedQuestion {
  text: string;
  defaultAnswer: string | null;
  options: string[];
}

function parseQuestion(raw: string): ParsedQuestion {
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

/** Collect all open questions grouped by role, skipping runs with no questions. */
function collectQuestions(runs: RoleRun[]): Array<{ runId: number; roleKey: string; questions: string[] }> {
  const groups: Array<{ runId: number; roleKey: string; questions: string[] }> = [];
  for (const r of runs) {
    try {
      const parsed = JSON.parse(r.open_questions_json ?? "[]") as string[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        groups.push({ runId: r.id, roleKey: r.role_key, questions: parsed });
      }
    } catch { /* skip malformed */ }
  }
  return groups;
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
  lastRole: { role: string; tokens: number; elapsedSec: number } | null;
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
    tpsHistory: {},
    recapGenerating: false,
  });
  const bufRef = useRef("");
  const thinkRef = useRef("");
  const lastToolRef = useRef("");
  const repeatRef = useRef(0);
  useEffect(() => {
    setLines([]);
    setActivity({ currentRole: null, disposition: null, roleStartTime: null, roleEndTime: null, lastRole: null, tpsHistory: {}, recapGenerating: false });
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
      setActivity((a) => ({ ...a, currentRole: d.role, disposition: "reading", roleStartTime: Date.now(), roleEndTime: null, lastRole: a.lastRole }));
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
          ? { role: d.role, tokens: d.tokens, elapsedSec: elapsed }
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
}: {
  networkId: string;
  runs: RoleRun[];
  plan: { steps: { role: string; status: string; depth: number }[] } | null;
  currentRole: string | null;
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
    const run = runs.find((r) => r.role_key === roleKey);
    if (run) {
      const el = document.getElementById(`run-${roleKey}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
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
  const [showIntake, setShowIntake] = useState(false);
  const [showAdvancedSteering, setShowAdvancedSteering] = useState(false);

  // Question answer state: per-question-editing keyed by "${runId}:${qIndex}"
  const [questionEdits, setQuestionEdits] = useState<Record<string, string>>({});

  // Intake editing state
  const [editName, setEditName] = useState("");
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [showNetworkGraph, setShowNetworkGraph] = useState(true);

  // Scheduler state for banner
  const [schedulerRunning, setSchedulerRunning] = useState(true);
  useEffect(() => {
    api.scheduler().then((s) => setSchedulerRunning(s.running)).catch(() => {});
    const iv = setInterval(() => {
      api.scheduler().then((s) => setSchedulerRunning(s.running)).catch(() => {});
    }, 5000);
    return () => clearInterval(iv);
  }, []);

  // Sync edit fields when task data loads
  useEffect(() => {
    if (q.data) {
      setEditName(q.data.task.name ?? "");
      setEditContent(q.data.task.content ?? "");
    }
  }, [q.data]);

  // Modal states
  const navigate = useNavigate();
  const [deleteModal, setDeleteModal] = useState(false);
  const [resetModal, setResetModal] = useState(false);
  const [removePlan, setRemovePlan] = useState(false);

  const intervene = useMutation({
    mutationFn: ({ kind, payload }: { kind: string; payload?: unknown }) => api.intervene(taskId, kind, payload),
    onSuccess: refresh,
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
    setQuestionEdits((prev) => {
      const next = { ...prev };
      delete next[editKey];
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

      <div className="row" style={{ marginBottom: 12 }}>
        {t.project_id != null && (
          <Link to="/projects/$projectId" params={{ projectId: String(t.project_id) }}>← board</Link>
        )}
        <h2 style={{ margin: 0, color: "var(--brass)" }}>{t.name ?? t.task_id.slice(0, 8)}</h2>
        <span className={`pill ${t.stage === "ready" ? "ok" : t.stage === "review" ? "human" : "dim"}`}>{t.stage}</span>
        {t.exit_state === "wont_do" && <span className="pill dim">won't do</span>}
        <span className="pill dim">{t.intake_kind}</span>
        <span className="pill dim">exit: {t.exit_kind}</span>
        {t.paused === 1 && <span className="pill warn">paused</span>}
        {t.stage === "intake" && t.project_id != null && (
          <NetworkSelector taskId={t.task_id} projectId={t.project_id!} intakeKind={t.intake_kind} onChanged={refresh} />
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
              {d.runs.some((r) => r.output_md) && (
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

          <div className="panel">
            <div className="plan-header">
              <h2>Refinement plan</h2>
              <button
                className="small"
                onClick={() => setShowIntake((p) => !p)}
                title={showIntake ? "Back to plan" : "View original intake contents"}
              >
                {showIntake ? "📋 Plan" : "📄 Intake"}
              </button>
            </div>
            {showIntake ? (
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
                            await api.updateTask(taskId, { name: editName, content: editContent });
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
            ) : (
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
            )}
          </div>

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
                      intervene.mutate({ kind: "rerun_role", payload: { role: r.role_key } });
                    }}
                  >
                    re-run
                  </button>
                  <button
                    className="small"
                    onClick={(e) => {
                      e.stopPropagation();
                      intervene.mutate({ kind: "deepen", payload: { role: r.role_key } });
                    }}
                  >
                    deepen
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
                      <td>{c.name}</td>
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
                    <span className="muted">Speed</span>
                    <span className="pill dim">
                      {activity.lastRole.tokens} tok / {(activity.lastRole.elapsedSec).toFixed(1)}s → {(activity.lastRole.tokens / activity.lastRole.elapsedSec).toFixed(0)} tps
                    </span>
                  </div>
                )}
                {activity.disposition !== "done" && activity.lastRole && (
                  <div className="current-state-row">
                    <span className="muted">Last role</span>
                    <span className="pill dim">
                      {activity.lastRole.role}: {(activity.lastRole.tokens / activity.lastRole.elapsedSec).toFixed(0)} tps ({activity.lastRole.tokens} tok / {(activity.lastRole.elapsedSec).toFixed(1)}s)
                    </span>
                  </div>
                )}
                {activity.currentRole && activity.disposition !== "done" && !activity.lastRole && (
                  <div className="current-state-row">
                    <span className="muted">Speed</span>
                    <span className="pill dim">n/a</span>
                  </div>
                )}
              </div>
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
                      rerun_role: "RERUN",
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
                          : iv.kind === "rerun_role" || iv.kind === "deepen" || iv.kind === "promote_role"
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
            {d.coverage ? (
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
                      const editVal = questionEdits[editKey] ?? pq.defaultAnswer ?? "";
                      return (
                        <div key={qi} className="question-item">
                          <p className="question-text">{pq.text}</p>
                          {pq.options.length > 0 && (
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
                          </div>
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