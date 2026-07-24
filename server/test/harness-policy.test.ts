import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXEC_MAX_RUNS,
  DEFAULT_EXEC_TIMEOUT_MS,
  DEFAULT_HARNESS_POLICY,
  EXEC_TOOL_NAME,
  execEnabled,
  findExecCommand,
  resolveHarnessPolicy,
  sanitizeExecAllowlist,
  validateExecAllowlist,
  validateToolsJson,
  type HarnessPolicy,
} from "../src/harness-policy";

const cfg = (harness: unknown): string => JSON.stringify({ harness });

function policy(over: Partial<HarnessPolicy> = {}): HarnessPolicy {
  return { ...DEFAULT_HARNESS_POLICY, ...over };
}

describe("resolveHarnessPolicy", () => {
  it("defaults every capability off", () => {
    for (const input of [null, "", "not json", "{}", cfg(undefined)]) {
      const p = resolveHarnessPolicy(input);
      expect(p.allowWrite, String(input)).toBe(false);
      expect(p.allowExec, String(input)).toBe(false);
      expect(p.execAllowlist, String(input)).toEqual([]);
    }
  });

  it("only a literal true enables a switch — a truthy string does not", () => {
    expect(resolveHarnessPolicy(cfg({ allowExec: "yes" })).allowExec).toBe(false);
    expect(resolveHarnessPolicy(cfg({ allowExec: 1 })).allowExec).toBe(false);
    expect(resolveHarnessPolicy(cfg({ allowExec: true })).allowExec).toBe(true);
  });

  it("clamps the numeric bounds and falls back on nonsense", () => {
    const p = resolveHarnessPolicy(
      cfg({ execTimeoutMs: 99_999_999, execMaxOutputBytes: 1, execMaxRuns: "lots" }),
    );
    expect(p.execTimeoutMs).toBe(3_600_000);
    expect(p.execMaxOutputBytes).toBe(1024);
    expect(p.execMaxRuns).toBe(DEFAULT_EXEC_MAX_RUNS);
    expect(resolveHarnessPolicy(cfg({})).execTimeoutMs).toBe(DEFAULT_EXEC_TIMEOUT_MS);
  });

  it("drops malformed allowlist entries instead of surfacing them to the executor", () => {
    const p = resolveHarnessPolicy(
      cfg({
        allowExec: true,
        execAllowlist: [
          { name: "test", argv: ["npm", "test"] },
          { name: "", argv: ["x"] }, // no name
          { name: "noargv", argv: [] }, // nothing to run
          { name: "notarray", argv: "npm test" }, // wrong shape
          { name: "test", argv: ["other"] }, // duplicate name
          "just a string",
          null,
        ],
      }),
    );
    expect(p.execAllowlist.map((c) => c.name)).toEqual(["test"]);
    expect(p.execAllowlist[0]!.argv).toEqual(["npm", "test"]);
  });

  it("keeps a corrupt config from silently granting anything", () => {
    // A config_json that isn't valid JSON must read as the safe default, not throw.
    expect(resolveHarnessPolicy('{"harness": {"allowExec": true}')).toEqual({
      ...DEFAULT_HARNESS_POLICY,
    });
  });

  it("normalizes allowArgs to a boolean and preserves the arg pattern", () => {
    const p = resolveHarnessPolicy(
      cfg({ execAllowlist: [{ name: "t", argv: ["x"], allowArgs: "yes", argPattern: "^a$" }] }),
    );
    expect(p.execAllowlist[0]!.allowArgs).toBe(false);
    expect(p.execAllowlist[0]!.argPattern).toBe("^a$");
  });
});

describe("execEnabled / findExecCommand", () => {
  it("requires both the switch and a non-empty menu", () => {
    expect(execEnabled(policy({ allowExec: false, execAllowlist: [{ name: "t", argv: ["x"] }] }))).toBe(false);
    expect(execEnabled(policy({ allowExec: true, execAllowlist: [] }))).toBe(false);
    expect(execEnabled(policy({ allowExec: true, execAllowlist: [{ name: "t", argv: ["x"] }] }))).toBe(true);
  });

  it("looks a command up by exact name", () => {
    const p = policy({ execAllowlist: [{ name: "test", argv: ["npm", "test"] }] });
    expect(findExecCommand(p, "test")?.argv).toEqual(["npm", "test"]);
    expect(findExecCommand(p, "Test")).toBeUndefined();
  });
});

describe("validateToolsJson", () => {
  it("accepts read-only tools under the default policy", () => {
    const r = validateToolsJson('["read","grep","find","ls"]', DEFAULT_HARNESS_POLICY);
    expect(r.ok).toBe(true);
  });

  it("rejects unknown tool names", () => {
    const r = validateToolsJson('["read","bash"]', DEFAULT_HARNESS_POLICY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("bash");
  });

  it("rejects write/edit unless allowWrite is on", () => {
    expect(validateToolsJson('["write"]', DEFAULT_HARNESS_POLICY).ok).toBe(false);
    expect(validateToolsJson('["write"]', policy({ allowWrite: true })).ok).toBe(true);
  });

  it("rejects run_command unless allowExec is on", () => {
    const r = validateToolsJson(`["${EXEC_TOOL_NAME}"]`, DEFAULT_HARNESS_POLICY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("allowExec");
  });

  it("rejects run_command when exec is on but no command is approved", () => {
    const r = validateToolsJson(`["${EXEC_TOOL_NAME}"]`, policy({ allowExec: true }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("allowlist");
  });

  it("accepts run_command once both halves are in place", () => {
    const r = validateToolsJson(
      `["read","${EXEC_TOOL_NAME}"]`,
      policy({ allowExec: true, execAllowlist: [{ name: "test", argv: ["npm", "test"] }] }),
    );
    expect(r.ok).toBe(true);
  });

  it("rejects malformed tools_json", () => {
    expect(validateToolsJson("not json", DEFAULT_HARNESS_POLICY).ok).toBe(false);
    expect(validateToolsJson('{"a":1}', DEFAULT_HARNESS_POLICY).ok).toBe(false);
    expect(validateToolsJson("[1,2]", DEFAULT_HARNESS_POLICY).ok).toBe(false);
  });
});

describe("validateExecAllowlist", () => {
  it("accepts a well-formed menu and normalizes it", () => {
    const r = validateExecAllowlist([
      { name: "test", argv: ["npm", "test"] },
      { name: "typecheck", argv: ["npx", "tsc", "--noEmit"], allowArgs: false },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.commands.map((c) => c.name)).toEqual(["test", "typecheck"]);
  });

  it("reports (rather than silently drops) the reason an entry is bad", () => {
    for (const [input, needle] of [
      [[{ argv: ["x"] }], "name"],
      [[{ name: "a b", argv: ["x"] }], "invalid command name"],
      [[{ name: "test", argv: [] }], "argv"],
      [[{ name: "test", argv: ["x"] }, { name: "test", argv: ["y"] }], "duplicate"],
      [[{ name: "test", argv: ["x"], argPattern: "([" }], "regex"],
      [["nope"], "object"],
      ["not an array", "array"],
    ] as const) {
      const r = validateExecAllowlist(input);
      expect(r.ok, JSON.stringify(input)).toBe(false);
      if (!r.ok) expect(r.error.toLowerCase()).toContain(needle);
    }
  });

  it("agrees with sanitizeExecAllowlist on what a valid menu becomes", () => {
    const raw = [{ name: "test", argv: ["npm", "test"], allowArgs: true }];
    const v = validateExecAllowlist(raw);
    expect(v.ok && v.commands).toEqual(sanitizeExecAllowlist(raw));
  });
});
