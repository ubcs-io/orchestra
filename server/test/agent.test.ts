import { describe, expect, it } from "vitest";
import {
  createFenceTracker,
  createStallDetector,
  createThinkSplitter,
  extractFindingsFromText,
} from "../src/agent";

/** Feed chunks through a splitter and concatenate the routed output. */
function run(chunks: string[]): { text: string; thinking: string } {
  const s = createThinkSplitter();
  let text = "";
  let thinking = "";
  for (const c of chunks) {
    const r = s.push(c);
    text += r.text;
    thinking += r.thinking;
  }
  const tail = s.flush();
  return { text: text + tail.text, thinking: thinking + tail.thinking };
}

describe("createThinkSplitter", () => {
  it("passes plain text through untouched", () => {
    expect(run(["just some answer text"])).toEqual({ text: "just some answer text", thinking: "" });
  });

  it("separates a self-contained <think> block from the answer", () => {
    const { text, thinking } = run(["<think>reasoning here</think>the answer"]);
    expect(text).toBe("the answer");
    expect(thinking).toBe("reasoning here");
  });

  it("handles tags split across chunk boundaries", () => {
    // Tags are broken mid-token across deltas.
    const { text, thinking } = run(["hel", "lo <thi", "nk>rea", "son</thi", "nk> done"]);
    expect(text).toBe("hello  done");
    expect(thinking).toBe("reason");
  });

  it("routes an unclosed <think> (truncated reasoning) entirely to thinking", () => {
    const { text, thinking } = run(["<think>the model ran out of tokens mid-thought"]);
    expect(text).toBe("");
    expect(thinking).toBe("the model ran out of tokens mid-thought");
  });

  it("does not emit a partial tag prefix as answer text prematurely", () => {
    // "<thin" arrives with no closing ">": it must be withheld, not shown as text.
    const s = createThinkSplitter();
    const first = s.push("answer <thin");
    expect(first.text).toBe("answer ");
    const second = s.push("k>secret</think>ok");
    expect(second.thinking).toBe("secret");
    expect(first.text + second.text + s.flush().text).toBe("answer ok");
  });
});

describe("createFenceTracker", () => {
  it("passes plain text through untouched when no fence appears", () => {
    const t = createFenceTracker();
    const r = t.push("just some narration, no code blocks here.");
    expect(r.outside).toBe("just some narration, no code blocks here.");
    expect(r.inside).toBe("");
  });

  it("routes a self-contained fence's interior to inside, surrounding text to outside", () => {
    const t = createFenceTracker();
    const r = t.push("before ```middle``` after");
    expect(r.outside).toBe("before ``` after");
    expect(r.inside).toBe("middle```");
  });

  it("handles the fence marker split across chunk boundaries", () => {
    const t = createFenceTracker();
    let outside = "";
    let inside = "";
    for (const c of ["before ``", "`middle``", "` after"]) {
      const r = t.push(c);
      outside += r.outside;
      inside += r.inside;
    }
    expect(outside).toBe("before ``` after");
    expect(inside).toBe("middle```");
  });

  it("reset() clears state so a fence left open doesn't leak into the next turn", () => {
    const t = createFenceTracker();
    t.push("open ```unterminated json here");
    t.reset();
    const r = t.push("fresh text");
    expect(r.outside).toBe("fresh text");
    expect(r.inside).toBe("");
  });
});

describe("fence-aware stall suppression (integration)", () => {
  /** Mirrors the runRole() wiring: feed each chunk to the fence tracker, only the
   *  portion outside a fence reaches the stall detector. Returns whether stalled
   *  was ever raised. */
  function runFenceGated(chunks: string[]): boolean {
    const fence = createFenceTracker();
    const detector = createStallDetector();
    let stalled = false;
    for (const c of chunks) {
      if (detector.push(fence.push(c).outside)) stalled = true;
    }
    return stalled;
  }

  it("does not flag a JSON payload whose coverage/criteria_results entries share a status line", () => {
    // Reproduces the reported bug: the model finishes reasoning, then emits a
    // record_findings JSON block where several coverage entries share the exact
    // same status line — legitimate repetition, not narration.
    const preamble = "Now I have a thorough understanding of the problem. Let me compile my findings.\n\n";
    const jsonBlock =
      "```json\n" +
      "{\n" +
      '  "verdict": "pass",\n' +
      '  "coverage": [\n' +
      "    {\n" +
      '      "concern": "correctness",\n' +
      '      "status": "considered",\n' +
      '      "note": "reviewed the pipeline"\n' +
      "    },\n" +
      "    {\n" +
      '      "concern": "performance",\n' +
      '      "status": "considered",\n' +
      '      "note": "checked the hot path"\n' +
      "    },\n" +
      "    {\n" +
      '      "concern": "security",\n' +
      '      "status": "considered",\n' +
      '      "note": "checked auth"\n' +
      "    },\n" +
      "    {\n" +
      '      "concern": "data",\n' +
      '      "status": "considered",\n' +
      '      "note": "checked storage"\n' +
      "    },\n" +
      "    {\n" +
      '      "concern": "ux",\n' +
      '      "status": "considered",\n' +
      '      "note": "checked the viewer"\n' +
      "    }\n" +
      "  ]\n" +
      "}\n" +
      "```";
    expect(runFenceGated([preamble, jsonBlock])).toBe(false);
  });

  it("still flags a genuine narration loop outside any fence", () => {
    const chunks = Array(6).fill("Let me call record_findings now.\n");
    expect(runFenceGated(chunks)).toBe(true);
  });

  it("fence content doesn't get polluted by, or pollute, narration counting", () => {
    // 4 narration repeats (below threshold) followed by fenced JSON with repeated
    // status lines: neither alone crosses the threshold, and the fence's repeats
    // must not add to the narration count computed before it opened.
    const narration = Array(4).fill("Let me call record_findings now.\n");
    const jsonBlock =
      "```json\n" +
      '{"coverage":[' +
      Array(5)
        .fill('{"status":"considered"}')
        .join(",\n") +
      "]}\n```";
    expect(runFenceGated([...narration, jsonBlock])).toBe(false);
  });

  it("resumes stall detection once the fence closes", () => {
    const jsonBlock =
      "```json\n" +
      '{"coverage":[' +
      Array(5)
        .fill('{"status":"considered"}')
        .join(",\n") +
      "]}\n```\n";
    const narration = Array(6).fill("Let me call record_findings now.\n");
    expect(runFenceGated([jsonBlock, ...narration])).toBe(true);
  });
});

describe("createStallDetector", () => {
  it("does not flag normal, non-repetitive prose", () => {
    const d = createStallDetector();
    expect(d.push("I looked at the auth module.")).toBe(false);
    expect(d.push("It validates tokens against the session store.")).toBe(false);
    expect(d.push("No issues found there.")).toBe(false);
  });

  it("flags a sentence repeated past the threshold", () => {
    const d = createStallDetector();
    expect(d.push("Let me call record_findings now.")).toBe(false);
    expect(d.push("Let me call record_findings now.")).toBe(false);
    expect(d.push("Let me call record_findings now.")).toBe(true);
  });

  it("matches case- and whitespace-insensitively", () => {
    const d = createStallDetector();
    d.push("Now I have all the information I need.");
    d.push("now i have  all the information i need.");
    expect(d.push("NOW I HAVE ALL THE INFORMATION I NEED.")).toBe(true);
  });

  it("matches a sentence split across streamed chunks", () => {
    const d = createStallDetector();
    d.push("Let me call record");
    d.push("_findings with my assessment.");
    d.push("Let me call record");
    expect(d.push("_findings with my assessment.")).toBe(false);
    d.push("Let me call record");
    expect(d.push("_findings with my assessment.")).toBe(true);
  });

  it("ignores short fragments below the minimum sentence length", () => {
    const d = createStallDetector();
    expect(d.push("Okay.")).toBe(false);
    expect(d.push("Okay.")).toBe(false);
    expect(d.push("Okay.")).toBe(false);
    expect(d.push("Okay.")).toBe(false);
  });

  it("stays flagged (latches) once stalled, ignoring further pushes", () => {
    const d = createStallDetector();
    d.push("Let me call record_findings now.");
    d.push("Let me call record_findings now.");
    expect(d.push("Let me call record_findings now.")).toBe(true);
    expect(d.push("something completely different")).toBe(true);
  });

  it("reset() clears prior counts so old repeats don't count toward a new threshold", () => {
    const d = createStallDetector();
    d.push("Let me call record_findings now.");
    d.push("Let me call record_findings now.");
    d.reset();
    expect(d.push("Let me call record_findings now.")).toBe(false);
    expect(d.push("Let me call record_findings now.")).toBe(false);
  });

  it("flags varied narration patterns (different phrasings of the same intent)", () => {
    const d = createStallDetector(3, 2);
    // Two different narration sentences should fire the narration-pattern detector.
    expect(d.push("Let me call record_findings with my assessment.")).toBe(false);
    expect(d.push("Now I will finalize and invoke the tool.")).toBe(true);
  });

  it("does not flag a single narration sentence", () => {
    const d = createStallDetector(3, 2);
    expect(d.push("Let me call record_findings now.")).toBe(false);
    expect(d.push("That covers the investigation.")).toBe(false);
    expect(d.push("The auth module looks clean.")).toBe(false);
  });

  it("resets narration count on reset()", () => {
    const d = createStallDetector(3, 2);
    d.push("Let me call record_findings now.");
    d.reset();
    expect(d.push("Let me call record_findings now.")).toBe(false);
    expect(d.push("Something else.")).toBe(false);
  });
});

describe("twoPhase contract (pure)", () => {
  it("TWO_PHASE_EXPLORE_CONTRACT does not mention record_findings", async () => {
    const { TWO_PHASE_EXPLORE_CONTRACT } = await import("../src/roles.js");
    expect(TWO_PHASE_EXPLORE_CONTRACT).not.toMatch(/record_findings/);
  });

  it("TWO_PHASE_FORMALIZE_PROMPT includes JSON block instruction", async () => {
    const { TWO_PHASE_FORMALIZE_PROMPT } = await import("../src/roles.js");
    expect(TWO_PHASE_FORMALIZE_PROMPT).toMatch(/```json/);
    expect(TWO_PHASE_FORMALIZE_PROMPT).toMatch(/verdict/);
  });
});

describe("record_findings availability claim (persisted vs runtime)", () => {
  // Regression coverage for the "record_findings IS available... Tool record_findings
  // not found" contradiction: OUTPUT_CONTRACT is baked into every role's system_prompt
  // and persisted in the DB, so it must never assert tool availability — only the
  // runtime-computed discipline suffixes (TOOL_CALL_DISCIPLINE / TEXT_MODE_INSTRUCTION)
  // may do that, since only they know whether the tool is actually registered.
  const AVAILABILITY_CLAIM = /is available to you|will (never|not) (get|receive) a ["']?tool not found/i;

  it("OUTPUT_CONTRACT (persisted) never asserts record_findings tool availability", async () => {
    const { OUTPUT_CONTRACT } = await import("../src/roles.js");
    expect(OUTPUT_CONTRACT).not.toMatch(AVAILABILITY_CLAIM);
  });

  it("buildRoleSystemPrompt (persisted) + TEXT_MODE_INSTRUCTION never asserts availability", async () => {
    const { buildRoleSystemPrompt } = await import("../src/roles.js");
    const { TEXT_MODE_INSTRUCTION } = await import("../src/agent.js");
    const prompt = buildRoleSystemPrompt("You are a test role.") + TEXT_MODE_INSTRUCTION;
    expect(prompt).not.toMatch(AVAILABILITY_CLAIM);
    // The negative claim ("you do NOT have a record_findings tool") must still be present.
    expect(prompt).toMatch(/do NOT have a `?record_findings`? tool/);
  });

  it("buildRoleSystemPrompt (persisted) + TOOL_CALL_DISCIPLINE instructs calling record_findings", async () => {
    const { buildRoleSystemPrompt } = await import("../src/roles.js");
    const { TOOL_CALL_DISCIPLINE } = await import("../src/agent.js");
    const prompt = buildRoleSystemPrompt("You are a test role.") + TOOL_CALL_DISCIPLINE;
    expect(prompt).toMatch(/call the `record_findings` tool/);
    expect(prompt).toMatch(AVAILABILITY_CLAIM);
  });
});

describe("extractFindingsFromText (salvage path)", () => {
  it("parses a well-formed closed fence", () => {
    const text =
      '```json\n{"verdict":"pass","summary":"ok","open_questions":[],"coverage":[],"section_md":"# done"}\n```';
    const findings = extractFindingsFromText(text);
    expect(findings?.verdict).toBe("pass");
    expect(findings?.summary).toBe("ok");
  });

  it("salvages fields from an unclosed fence containing an escaped quote without corrupting them", () => {
    // Truncated mid-response (e.g. cut off by the pre-emptive nudge) — the closed
    // `summary` field contains an escaped quote, and `section_md` (the last field)
    // is cut off with no closing fence. Before the fix, the salvage regex's capture
    // group (already valid JSON string content) was re-escaped a second time,
    // corrupting `\"` into `\\"` and throwing inside JSON.parse.
    const text =
      '```json\n{"verdict":"needs_more","summary":"the \\"foo\\" case is unhandled","section_md":"trunc';
    const findings = extractFindingsFromText(text);
    expect(findings).not.toBeNull();
    expect(findings?.verdict).toBe("needs_more");
    expect(findings?.summary).toBe('the "foo" case is unhandled');
    expect(findings?.open_questions).toEqual([]);
    expect(findings?.coverage).toEqual([]);
  });

  it("does not throw on a value containing a lone unescaped backslash near a quote", () => {
    const text = '```json\n{"verdict":"blocker","summary":"path is C:\\\\Users\\\\x","section_md":"trunc';
    expect(() => extractFindingsFromText(text)).not.toThrow();
  });
});