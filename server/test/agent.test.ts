import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assembleReport,
  buildRepairMaterial,
  createFenceTracker,
  createStallDetector,
  createThinkSplitter,
  extractFindingsAndProse,
  extractFindingsFromText,
  findingsFromRecordPayload,
  formalizeFindings,
} from "../src/agent";
import type { Connection } from "../src/settings";

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

  // These construct detectors with explicit thresholds (repetition 3, narration
  // effectively off) so they exercise the detection mechanism itself and don't
  // silently break whenever the production default (STALL_REPEAT_THRESHOLD,
  // tuned upward over time) changes.
  it("flags a sentence repeated past the threshold", () => {
    const d = createStallDetector(3, 99);
    expect(d.push("Let me call record_findings now.")).toBe(false);
    expect(d.push("Let me call record_findings now.")).toBe(false);
    expect(d.push("Let me call record_findings now.")).toBe(true);
  });

  it("matches case- and whitespace-insensitively", () => {
    const d = createStallDetector(3, 99);
    d.push("Now I have all the information I need.");
    d.push("now i have  all the information i need.");
    expect(d.push("NOW I HAVE ALL THE INFORMATION I NEED.")).toBe(true);
  });

  it("matches a sentence split across streamed chunks", () => {
    const d = createStallDetector(3, 99);
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
    const d = createStallDetector(3, 99);
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

describe("verdict trailer extraction (artifact-first contract)", () => {
  it("accepts a trailer without section_md — its absence no longer fails validation", () => {
    const text = '```json\n{"verdict":"pass","summary":"ok","open_questions":[],"coverage":[]}\n```';
    const findings = extractFindingsFromText(text);
    expect(findings?.verdict).toBe("pass");
    expect(findings?.summary).toBe("ok");
    expect(findings?.section_md).toBe("");
  });

  it("returns the report prose around the trailer fence, fence removed", () => {
    const report = "## Explorer\n\n- entry point: `src/main.ts:12`\n- reuse `parseThing()`";
    const text = `${report}\n\n\`\`\`json\n{"verdict":"pass","summary":"ok"}\n\`\`\``;
    const extracted = extractFindingsAndProse(text);
    expect(extracted?.findings.verdict).toBe("pass");
    expect(extracted?.prose).toBe(report);
    expect(extracted?.prose).not.toContain("```");
  });

  it("preserves the prose when the trailer fence is unclosed (truncated output)", () => {
    const report = "## Bug Investigator\n\nThe failure is emitted at `db.ts:42`.";
    const text = `${report}\n\n\`\`\`json\n{"verdict":"needs_more","summary":"partial evidence","open_qu`;
    const extracted = extractFindingsAndProse(text);
    expect(extracted?.findings.verdict).toBe("needs_more");
    expect(extracted?.findings.summary).toBe("partial evidence");
    expect(extracted?.prose).toBe(report);
  });

  it("still accepts the legacy v1 blob with section_md embedded", () => {
    const text =
      '```json\n{"verdict":"pass","summary":"ok","open_questions":[],"coverage":[],"section_md":"## Role\\n\\nlegacy"}\n```';
    const extracted = extractFindingsAndProse(text);
    expect(extracted?.findings.section_md).toBe("## Role\n\nlegacy");
  });

  it("parses raw whole-text trailer JSON with empty prose", () => {
    const extracted = extractFindingsAndProse('{"verdict":"pass","summary":"ok"}');
    expect(extracted?.findings.verdict).toBe("pass");
    expect(extracted?.prose).toBe("");
  });

  it("parses carry_forward (overhaul/07 §4) when present, undefined when omitted", () => {
    const withCarry = extractFindingsFromText(
      '```json\n{"verdict":"pass","summary":"ok","carry_forward":"watch out for the flaky retry test"}\n```',
    );
    expect(withCarry?.carry_forward).toBe("watch out for the flaky retry test");
    const without = extractFindingsFromText('```json\n{"verdict":"pass","summary":"ok"}\n```');
    expect(without?.carry_forward).toBeUndefined();
  });
});

describe("assembleReport (artifact-first assembly)", () => {
  // Scenario (a) from the plan's verification section: the model appends
  // sections during the run, then emits a trailer with no section_md.
  it("uses report_section appends as the report; nothing left to append", () => {
    const r = assembleReport({
      reportedSections: ["## Role\n\nfirst", "### Details\n\nsecond"],
      trailerSectionMd: "",
      fenceProse: undefined,
      answerText: "narration noise",
    });
    expect(r.sectionMd).toBe("## Role\n\nfirst\n\n### Details\n\nsecond");
    expect(r.artifactResidualMd).toBe("");
  });

  it("keeps a trailer section_md that adds content beyond the streamed sections, as the residual", () => {
    const r = assembleReport({
      reportedSections: ["## Role\n\nstreamed"],
      trailerSectionMd: "### Extra\n\nonly in the trailer",
      answerText: "",
    });
    expect(r.sectionMd).toBe("## Role\n\nstreamed\n\n### Extra\n\nonly in the trailer");
    expect(r.artifactResidualMd).toBe("### Extra\n\nonly in the trailer");
  });

  it("does not duplicate a trailer section_md already covered by the streamed sections", () => {
    const r = assembleReport({
      reportedSections: ["## Role\n\nsame content"],
      trailerSectionMd: "## Role\n\nsame content",
      answerText: "",
    });
    expect(r.sectionMd).toBe("## Role\n\nsame content");
    expect(r.artifactResidualMd).toBe("");
  });

  // Scenario (b): prose emitted, trailer truncated/parsed without section_md —
  // the prose (fence stripped) becomes the report and must reach the artifact.
  it("uses the fence-stripped prose when there are no streamed sections and no trailer section_md", () => {
    const r = assembleReport({
      reportedSections: [],
      trailerSectionMd: "",
      fenceProse: "## Role\n\nthe actual report",
      answerText: "## Role\n\nthe actual report\n\n```json\n{...garbage",
    });
    expect(r.sectionMd).toBe("## Role\n\nthe actual report");
    expect(r.artifactResidualMd).toBe("## Role\n\nthe actual report");
  });

  // Scenario (c): no trailer at all (fallback) — raw answer text is preserved.
  it("falls back to the raw answer text when no other source exists", () => {
    const r = assembleReport({
      reportedSections: [],
      trailerSectionMd: "",
      answerText: "whatever the model said",
    });
    expect(r.sectionMd).toBe("whatever the model said");
    expect(r.artifactResidualMd).toBe("whatever the model said");
  });

  it("keeps the v1 shape: trailer section_md alone becomes both report and residual", () => {
    const r = assembleReport({
      reportedSections: [],
      trailerSectionMd: "## Role\n\nv1 blob report",
      answerText: "narration",
    });
    expect(r.sectionMd).toBe("## Role\n\nv1 blob report");
    expect(r.artifactResidualMd).toBe("## Role\n\nv1 blob report");
  });

  it("emits the reasoning-only placeholder when every source is empty", () => {
    const r = assembleReport({ reportedSections: [], answerText: "  " });
    expect(r.sectionMd).toContain("only reasoning");
  });
});

describe("output-contract prompt variants", () => {
  it("TOOL_CALL_DISCIPLINE (artifact-first) instructs report_section; the v1 variant does not", async () => {
    const { TOOL_CALL_DISCIPLINE, TOOL_CALL_DISCIPLINE_V1 } = await import("../src/agent.js");
    expect(TOOL_CALL_DISCIPLINE).toMatch(/report_section/);
    expect(TOOL_CALL_DISCIPLINE_V1).not.toMatch(/report_section/);
    // v1 still demands the report inside the tool call.
    expect(TOOL_CALL_DISCIPLINE_V1).toMatch(/section_md/);
  });

  it("TEXT_MODE_INSTRUCTION (artifact-first) forbids section_md; the v1 variant requires it", async () => {
    const { TEXT_MODE_INSTRUCTION, TEXT_MODE_INSTRUCTION_V1 } = await import("../src/agent.js");
    expect(TEXT_MODE_INSTRUCTION).toMatch(/there is no "section_md" field/);
    expect(TEXT_MODE_INSTRUCTION_V1).toMatch(/\*\*section_md\*\*/);
  });

  it("TWO_PHASE_FORMALIZE_PROMPT (artifact-first) emits only the trailer; v1 keeps section_md", async () => {
    const { TWO_PHASE_FORMALIZE_PROMPT, TWO_PHASE_FORMALIZE_PROMPT_V1 } = await import("../src/roles.js");
    expect(TWO_PHASE_FORMALIZE_PROMPT).toMatch(/Do NOT include a "section_md" field/);
    expect(TWO_PHASE_FORMALIZE_PROMPT_V1).toMatch(/\*\*section_md\*\*/);
  });

  it("neither two-phase exploration contract mentions record_findings", async () => {
    const { TWO_PHASE_EXPLORE_CONTRACT, TWO_PHASE_EXPLORE_CONTRACT_V1 } = await import("../src/roles.js");
    expect(TWO_PHASE_EXPLORE_CONTRACT).not.toMatch(/record_findings/);
    expect(TWO_PHASE_EXPLORE_CONTRACT_V1).not.toMatch(/record_findings/);
  });
});

describe("findingsFromRecordPayload (overhaul/02 — shared by the tool call and the constrained-completion rung)", () => {
  it("maps the minimal required fields, defaulting the rest", () => {
    const findings = findingsFromRecordPayload({ verdict: "pass", summary: "looks good" });
    expect(findings).toEqual({
      verdict: "pass",
      summary: "looks good",
      open_questions: [],
      coverage: [],
      section_md: "",
      criteria_results: [],
      subtasks: undefined,
      no_decomposition_reason: undefined,
    });
  });

  it("marks every open_question as resolved:'assumed' regardless of what the payload said", () => {
    const findings = findingsFromRecordPayload({
      verdict: "needs_more",
      summary: "s",
      open_questions: [{ question: "q?", assumed_answer: "a", confidence: "medium" }],
    });
    expect(findings.open_questions).toEqual([
      { question: "q?", assumed_answer: "a", confidence: "medium", resolved: "assumed" },
    ]);
  });

  it("passes through criteria_results, subtasks, and no_decomposition_reason untouched", () => {
    const findings = findingsFromRecordPayload({
      verdict: "pass",
      summary: "s",
      criteria_results: [{ id: "c1", status: "met" }],
      no_decomposition_reason: "already atomic",
    });
    expect(findings.criteria_results).toEqual([{ id: "c1", status: "met" }]);
    expect(findings.subtasks).toBeUndefined();
    expect(findings.no_decomposition_reason).toBe("already atomic");
  });

  it("passes through carry_forward (overhaul/07 §4) when present, undefined when omitted", () => {
    const withCarry = findingsFromRecordPayload({
      verdict: "pass",
      summary: "s",
      carry_forward: "the migration script is idempotent but slow — don't re-run it casually",
    });
    expect(withCarry.carry_forward).toBe(
      "the migration script is idempotent but slow — don't re-run it casually",
    );
    const without = findingsFromRecordPayload({ verdict: "pass", summary: "s" });
    expect(without.carry_forward).toBeUndefined();
  });
});
// ---- Repair pass (PLANNING/overhaul/03) ----

function fakeConnection(mode: "json_schema" | "guided_json" | "grammar" | "off"): Connection {
  return {
    baseUrl: "http://localhost:8000/v1",
    apiKey: "",
    api: "openai-completions",
    defaultModelId: "fake-model",
    contextWindow: 8192,
    maxTokens: 4096,
    requestTimeoutMs: 5000,
    reasoning: false,
    thinkingLevel: "medium",
    thinkingFormat: "qwen-chat-template",
    textMode: false,
    twoPhase: false,
    compat: {},
    structuredOutputs: { mode },
  };
}

function chatCompletionBody(content: string) {
  return { choices: [{ message: { content } }] };
}

describe("buildRepairMaterial", () => {
  it("uses the streamed report sections as the primary material", () => {
    const material = buildRepairMaterial({
      reportedSections: [
        "## Analyst\n\nFound a bug in auth.ts — the session token is not null-checked before use, " +
          "so a missing cookie throws a 500 instead of redirecting to login.",
        "### Detail\n\nSee auth.ts:42 where `session.token` is dereferenced unconditionally.",
      ],
      answerText: "ignored when sections exist",
      thinkingText: "some long reasoning ".repeat(50),
    });
    expect(material).toContain("Found a bug in auth.ts");
    expect(material).toContain("auth.ts:42");
    // Report is substantial (> the thinking-salvage threshold), so the reasoning
    // trace is NOT folded in — it would be pure noise/cost.
    expect(material).not.toContain("some long reasoning");
  });

  it("falls back to the answer text when no sections were streamed", () => {
    const material = buildRepairMaterial({
      reportedSections: [],
      answerText: "## Analyst\n\nThe prose report the model typed inline.",
      thinkingText: "",
    });
    expect(material).toContain("The prose report the model typed inline.");
  });

  it("folds in the reasoning trace for the thinking-only salvage case", () => {
    // Almost no answer text, but the model reasoned at length — the conclusions
    // live in the reasoning channel.
    const material = buildRepairMaterial({
      reportedSections: [],
      answerText: "ok",
      thinkingText: "The auth check is missing a null guard on the session token.",
    });
    expect(material).toContain("Reasoning trace");
    expect(material).toContain("null guard on the session token");
  });

  it("returns null when there is nothing substantive to formalize", () => {
    expect(buildRepairMaterial({ reportedSections: [], answerText: "   ", thinkingText: "" })).toBeNull();
  });

  it("tail-caps oversized material, keeping the (conclusion-bearing) end", () => {
    const long = "x".repeat(20000) + "FINAL_CONCLUSION";
    const material = buildRepairMaterial({ reportedSections: [long], answerText: "", thinkingText: "" });
    expect(material!.length).toBeLessThan(9000);
    expect(material).toContain("FINAL_CONCLUSION");
    expect(material).toContain("earlier content omitted");
  });
});

describe("formalizeFindings (repair call)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reconstructs the verdict via the constrained rung when available", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify(chatCompletionBody('{"verdict":"needs_more","summary":"cut off mid-analysis"}')),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const findings = await formalizeFindings("some material", fakeConnection("json_schema"), "m");
    expect(findings?.verdict).toBe("needs_more");
    expect(findings?.summary).toBe("cut off mid-analysis");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.response_format.type).toBe("json_schema");
  });

  it("falls back to an unconstrained fenced completion when the constrained call fails", async () => {
    const fetchSpy = vi
      .fn()
      // First call = the constrained attempt → 5xx, throws inside runConstrainedCompletion.
      .mockResolvedValueOnce(new Response("upstream boom", { status: 503 }))
      // Second call = the plain fenced attempt → a fenced verdict block.
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            chatCompletionBody('here you go:\n```json\n{"verdict":"pass","summary":"ok"}\n```'),
          ),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchSpy);
    const findings = await formalizeFindings("material", fakeConnection("json_schema"), "m");
    expect(findings?.verdict).toBe("pass");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // The second (fallback) request carries no response_format constraint.
    const body2 = JSON.parse(fetchSpy.mock.calls[1]![1]!.body as string);
    expect(body2.response_format).toBeUndefined();
  });

  it("uses only the plain fenced rung when the connection has no structured support", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify(chatCompletionBody('```json\n{"verdict":"blocker","summary":"nope"}\n```')),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const findings = await formalizeFindings("material", fakeConnection("off"), "m");
    expect(findings?.verdict).toBe("blocker");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
    expect(body.response_format).toBeUndefined();
  });

  it("returns null (→ caller falls back) when every rung fails", async () => {
    const fetchSpy = vi.fn(async () => new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchSpy);
    expect(await formalizeFindings("material", fakeConnection("json_schema"), "m")).toBeNull();
  });

  it("returns null when the endpoint replies with unparseable non-JSON", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify(chatCompletionBody("I could not produce JSON, sorry.")), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    expect(await formalizeFindings("material", fakeConnection("off"), "m")).toBeNull();
  });
});

describe("createStallDetector — reason (overhaul/03 §3 soft-stall differentiation)", () => {
  it("reports 'repetition' when the same sentence recurs past threshold", () => {
    const d = createStallDetector(3, 99);
    d.push("The same exact sentence here.");
    d.push("The same exact sentence here.");
    expect(d.push("The same exact sentence here.")).toBe(true);
    expect(d.reason()).toBe("repetition");
  });

  it("reports 'narration' when varied tool-narration phrasings recur", () => {
    const d = createStallDetector(99, 3);
    d.push("Let me call record_findings now.");
    d.push("I will invoke it in a moment.");
    expect(d.push("Now I will finalize.")).toBe(true);
    expect(d.reason()).toBe("narration");
  });

  it("reason() is null before any stall latches", () => {
    const d = createStallDetector();
    d.push("Just normal analysis text with nothing repeated.");
    expect(d.reason()).toBeNull();
  });

  it("reset() clears the latched reason", () => {
    const d = createStallDetector(3, 99);
    d.push("Repeat me please now.");
    d.push("Repeat me please now.");
    d.push("Repeat me please now.");
    expect(d.reason()).toBe("repetition");
    d.reset();
    expect(d.reason()).toBeNull();
  });
});
