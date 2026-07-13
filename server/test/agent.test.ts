import { describe, expect, it } from "vitest";
import { createThinkSplitter } from "../src/agent";

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
