import { describe, expect, it } from "vitest";
import { createStallDetector, createThinkSplitter } from "../src/agent";

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