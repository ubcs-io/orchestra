import { describe, expect, it } from "vitest";
import {
  computeRunHealth,
  isTrustedHealth,
  runHealthReason,
  roleRunHealthInput,
  type RunHealthInput,
} from "../src/health";

/** A healthy baseline; each case overrides only the signals it exercises. */
function input(over: Partial<RunHealthInput> = {}): RunHealthInput {
  return {
    verdict_source: "tool",
    fallback: 0,
    stalled: 0,
    stop_reason: "stop",
    attempt: 1,
    resumed_from: null,
    artifact_bytes: 500,
    hasOutput: true,
    ...over,
  };
}

describe("computeRunHealth", () => {
  it("healthy: clean verdict, no stall/truncation, first attempt", () => {
    expect(computeRunHealth(input())).toBe("healthy");
    expect(computeRunHealth(input({ verdict_source: "fence" }))).toBe("healthy");
    expect(computeRunHealth(input({ verdict_source: "constrained" }))).toBe("healthy");
  });

  it("degraded: a synthesized (fallback) verdict, even with prose on disk", () => {
    expect(computeRunHealth(input({ fallback: 1, verdict_source: "fallback" }))).toBe("degraded");
    // The fallback flag alone (verdict_source absent) is enough.
    expect(computeRunHealth(input({ fallback: 1, verdict_source: null }))).toBe("degraded");
  });

  it("empty: fallback AND nothing durable produced", () => {
    expect(
      computeRunHealth(input({ fallback: 1, verdict_source: "fallback", artifact_bytes: 0, hasOutput: false })),
    ).toBe("empty");
  });

  it("empty requires BOTH no bytes and no output — either present keeps it degraded", () => {
    expect(
      computeRunHealth(input({ fallback: 1, artifact_bytes: 0, hasOutput: true })),
    ).toBe("degraded");
    expect(
      computeRunHealth(input({ fallback: 1, artifact_bytes: 200, hasOutput: false })),
    ).toBe("degraded");
  });

  it("degraded: truncated or stalled but real verdict, not healed", () => {
    expect(computeRunHealth(input({ stop_reason: "length" }))).toBe("degraded");
    expect(computeRunHealth(input({ stalled: 1 }))).toBe("degraded");
  });

  it("recovered: the repair pass produced the verdict", () => {
    expect(computeRunHealth(input({ verdict_source: "repair" }))).toBe("recovered");
    // Recovered even if the underlying run also truncated — repair salvaged it.
    expect(computeRunHealth(input({ verdict_source: "repair", stop_reason: "length" }))).toBe("recovered");
  });

  it("recovered: a resume (attempt > 1 or resumed_from set) with a real verdict", () => {
    expect(computeRunHealth(input({ attempt: 2 }))).toBe("recovered");
    expect(computeRunHealth(input({ attempt: 1, resumed_from: 7 }))).toBe("recovered");
  });

  it("fallback precedence: repair attempted then fell back is still degraded, not recovered", () => {
    // verdict_source ends up "fallback" when the repair call itself failed.
    expect(computeRunHealth(input({ verdict_source: "fallback", fallback: 1, attempt: 2 }))).toBe("degraded");
  });

  it("legacy rows (all-null signals) read as healthy", () => {
    expect(
      computeRunHealth({
        verdict_source: null,
        fallback: null,
        stalled: null,
        stop_reason: null,
        attempt: null,
        resumed_from: null,
        artifact_bytes: null,
        hasOutput: true,
      }),
    ).toBe("healthy");
  });
});

describe("runHealthReason", () => {
  it("is empty for a healthy run and non-empty otherwise", () => {
    expect(runHealthReason(input())).toBe("");
    expect(runHealthReason(input({ fallback: 1, verdict_source: "fallback" }))).toMatch(/synthesized/i);
    expect(runHealthReason(input({ stop_reason: "length" }))).toMatch(/truncat/i);
    expect(runHealthReason(input({ stalled: 1 }))).toMatch(/stall/i);
    expect(runHealthReason(input({ verdict_source: "repair" }))).toMatch(/repair/i);
    expect(runHealthReason(input({ attempt: 2 }))).toMatch(/resum/i);
  });

  it("distinguishes an empty run truncated before any output", () => {
    expect(
      runHealthReason(input({ fallback: 1, stop_reason: "length", artifact_bytes: 0, hasOutput: false })),
    ).toMatch(/truncated/i);
  });
});

describe("roleRunHealthInput", () => {
  it("derives hasOutput from a non-blank output_md", () => {
    expect(
      roleRunHealthInput({
        verdict_source: "tool",
        fallback: 0,
        stalled: 0,
        stop_reason: "stop",
        attempt: 1,
        resumed_from: null,
        artifact_bytes: 0,
        output_md: "  \n ",
      }).hasOutput,
    ).toBe(false);
    expect(
      roleRunHealthInput({
        verdict_source: "tool",
        fallback: 0,
        stalled: 0,
        stop_reason: "stop",
        attempt: 1,
        resumed_from: null,
        artifact_bytes: 0,
        output_md: "## Report\nreal content",
      }).hasOutput,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The `verified` tier (PLANNING/overhaul/05)
// ---------------------------------------------------------------------------

const green = { exitCode: 0 };
const red = { exitCode: 1 };

describe("computeRunHealth — verified tier (overhaul/05)", () => {
  it("promotes a clean run whose recorded commands all exited 0", () => {
    expect(computeRunHealth(input({ evidence: [green] }))).toBe("verified");
    expect(computeRunHealth(input({ evidence: [green, green] }))).toBe("verified");
  });

  it("stays healthy with no evidence at all — absence is not failure", () => {
    expect(computeRunHealth(input({ evidence: [] }))).toBe("healthy");
    expect(computeRunHealth(input())).toBe("healthy");
  });

  it("stays healthy — not degraded — when a recorded command failed", () => {
    // A red suite means the run did its job and reported bad news; demoting the
    // run itself would confuse "the model broke" with "the code is broken".
    expect(computeRunHealth(input({ evidence: [red] }))).toBe("healthy");
    expect(computeRunHealth(input({ evidence: [green, red] }))).toBe("healthy");
  });

  it("never counts an unfinished command as green", () => {
    expect(computeRunHealth(input({ evidence: [{ exitCode: null, timedOut: true }] }))).toBe("healthy");
    expect(computeRunHealth(input({ evidence: [{ exitCode: null, spawnError: "ENOENT" }] }))).toBe("healthy");
  });

  it("never promotes a degraded/recovered/fallback run, however green its runs", () => {
    expect(computeRunHealth(input({ evidence: [green], fallback: 1 }))).toBe("degraded");
    expect(computeRunHealth(input({ evidence: [green], verdict_source: "repair" }))).toBe("recovered");
    expect(computeRunHealth(input({ evidence: [green], stop_reason: "length" }))).toBe("degraded");
    expect(computeRunHealth(input({ evidence: [green], stalled: 1 }))).toBe("degraded");
  });

  it("explains itself with the number of green runs", () => {
    expect(runHealthReason(input({ evidence: [green] }))).toMatch(/1 green command run\b/);
    expect(runHealthReason(input({ evidence: [green, green] }))).toMatch(/2 green command runs/);
  });
});

describe("isTrustedHealth", () => {
  it("covers exactly the tiers where nothing went wrong", () => {
    expect(isTrustedHealth("verified")).toBe(true);
    expect(isTrustedHealth("healthy")).toBe(true);
    expect(isTrustedHealth("recovered")).toBe(false);
    expect(isTrustedHealth("degraded")).toBe(false);
    expect(isTrustedHealth("empty")).toBe(false);
  });
});

describe("roleRunHealthInput — evidence_json (overhaul/05)", () => {
  const row = {
    verdict_source: "tool",
    fallback: 0,
    stalled: 0,
    stop_reason: "stop",
    attempt: 1,
    resumed_from: null,
    artifact_bytes: 100,
    output_md: "report",
  };

  it("parses a stored evidence array into the pass/fail projection", () => {
    const parsed = roleRunHealthInput({
      ...row,
      evidence_json: JSON.stringify([{ name: "test", exitCode: 0 }, { name: "lint", exitCode: 2 }]),
    });
    expect(parsed.evidence).toEqual([
      { exitCode: 0, timedOut: false, spawnError: undefined },
      { exitCode: 2, timedOut: false, spawnError: undefined },
    ]);
  });

  it("reads a missing or malformed column as no evidence, never throwing", () => {
    expect(roleRunHealthInput(row).evidence).toEqual([]);
    expect(roleRunHealthInput({ ...row, evidence_json: null }).evidence).toEqual([]);
    expect(roleRunHealthInput({ ...row, evidence_json: "{oops" }).evidence).toEqual([]);
    expect(roleRunHealthInput({ ...row, evidence_json: '{"a":1}' }).evidence).toEqual([]);
  });

  it("declines the promotion when the column is corrupt (fails closed)", () => {
    expect(computeRunHealth(roleRunHealthInput({ ...row, evidence_json: "{oops" }))).toBe("healthy");
  });
});
