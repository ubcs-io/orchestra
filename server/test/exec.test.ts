import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildExecEnv,
  capOutput,
  describeEvidence,
  isGreen,
  parseEvidence,
  renderEvidenceBlock,
  resolveExecInvocation,
  runExecCommand,
  type ExecEvidence,
} from "../src/exec";
import { DEFAULT_HARNESS_POLICY, type ExecCommand, type HarnessPolicy } from "../src/harness-policy";

function policy(over: Partial<HarnessPolicy> = {}): HarnessPolicy {
  return {
    ...DEFAULT_HARNESS_POLICY,
    allowExec: true,
    execAllowlist: [{ name: "test", argv: ["npm", "test"] }],
    ...over,
  };
}

const withArgs: ExecCommand = {
  name: "test",
  argv: ["pytest", "-q"],
  allowArgs: true,
};

describe("resolveExecInvocation", () => {
  it("resolves an allowlisted name to its fixed argv", () => {
    const r = resolveExecInvocation(policy(), "test", undefined);
    expect(r).toEqual({ ok: true, command: { name: "test", argv: ["npm", "test"] }, argv: ["npm", "test"] });
  });

  it("refuses when the policy switch is off, whatever the menu says", () => {
    const r = resolveExecInvocation(policy({ allowExec: false }), "test", undefined);
    expect(r.ok).toBe(false);
  });

  it("refuses an empty menu", () => {
    const r = resolveExecInvocation(policy({ execAllowlist: [] }), "test", undefined);
    expect(r.ok).toBe(false);
  });

  it("refuses an unknown name and names the available menu", () => {
    const r = resolveExecInvocation(policy(), "rm", undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("test");
  });

  it("refuses a non-string name", () => {
    expect(resolveExecInvocation(policy(), 42, undefined).ok).toBe(false);
    expect(resolveExecInvocation(policy(), "", undefined).ok).toBe(false);
  });

  it("refuses extra args unless the command opts in", () => {
    const r = resolveExecInvocation(policy(), "test", ["--reporter=json"]);
    expect(r.ok).toBe(false);
  });

  it("appends opted-in args to the fixed argv rather than replacing it", () => {
    const r = resolveExecInvocation(policy({ execAllowlist: [withArgs] }), "test", ["tests/test_x.py"]);
    expect(r.ok && r.argv).toEqual(["pytest", "-q", "tests/test_x.py"]);
  });

  it("ignores empty-string args (a model padding the array is not an arg request)", () => {
    const r = resolveExecInvocation(policy(), "test", ["", ""]);
    expect(r.ok && r.argv).toEqual(["npm", "test"]);
  });

  it("rejects args that don't match the default pattern — no shell metacharacters", () => {
    const p = policy({ execAllowlist: [withArgs] });
    for (const bad of ["a b", "$(whoami)", "x;rm -rf /", "`id`", "a|b", "a>b", "a\nb", "'x'"]) {
      expect(resolveExecInvocation(p, "test", [bad]).ok, bad).toBe(false);
    }
  });

  it("honours a stricter per-command argPattern", () => {
    const p = policy({
      execAllowlist: [{ ...withArgs, argPattern: "^tests/[a-z_]+\\.py$" }],
    });
    // Passes the permissive default pattern, but not this command's own.
    expect(resolveExecInvocation(p, "test", ["scripts/Deploy1.sh"]).ok).toBe(false);
    expect(resolveExecInvocation(p, "test", ["tests/test_thing.py"]).ok).toBe(true);
  });

  it("denies (never falls open) when the configured argPattern is not a valid regex", () => {
    const p = policy({ execAllowlist: [{ ...withArgs, argPattern: "([" }] });
    expect(resolveExecInvocation(p, "test", ["x"]).ok).toBe(false);
  });

  it("caps argument count and length", () => {
    const p = policy({ execAllowlist: [withArgs] });
    expect(resolveExecInvocation(p, "test", Array(9).fill("a")).ok).toBe(false);
    expect(resolveExecInvocation(p, "test", ["a".repeat(201)]).ok).toBe(false);
  });

  it("rejects a non-array / non-string args payload", () => {
    expect(resolveExecInvocation(policy(), "test", "oops").ok).toBe(false);
    expect(resolveExecInvocation(policy(), "test", [1, 2]).ok).toBe(false);
  });
});

describe("buildExecEnv", () => {
  const source = {
    PATH: "/usr/bin",
    HOME: "/home/u",
    ORCHESTRA_API_KEY: "secret",
    AWS_SECRET_ACCESS_KEY: "also-secret",
    ANTHROPIC_API_KEY: "very-secret",
  } as NodeJS.ProcessEnv;

  it("passes through only the allowlisted variables", () => {
    const env = buildExecEnv(policy(), source);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/u");
  });

  it("drops every secret-shaped variable the daemon happens to hold", () => {
    const env = buildExecEnv(policy(), source);
    expect(env.ORCHESTRA_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("sets CI=1 so watch-mode runners don't hang until the timeout", () => {
    expect(buildExecEnv(policy(), source).CI).toBe("1");
  });

  it("applies project execEnv extras last, and ignores malformed ones", () => {
    const env = buildExecEnv(
      policy({ execEnv: { NODE_ENV: "test", CI: "0", "bad name": "x", NUM: 1 as unknown as string } }),
      source,
    );
    expect(env.NODE_ENV).toBe("test");
    expect(env.CI).toBe("0");
    expect(env["bad name"]).toBeUndefined();
    expect(env.NUM).toBeUndefined();
  });
});

describe("capOutput", () => {
  it("returns short output untouched", () => {
    expect(capOutput("hello", 100)).toEqual({ text: "hello", truncated: false });
  });

  it("keeps a head and a tail and marks the elision", () => {
    const out = capOutput("A".repeat(500) + "TAILMARK", 100);
    expect(out.truncated).toBe(true);
    expect(out.text).toContain("TAILMARK");
    expect(out.text).toContain("elided");
    expect(out.text.startsWith("A")).toBe(true);
  });
});

describe("runExecCommand", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "orch-exec-"));
  const base = {
    cwd,
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
    env: { PATH: process.env.PATH ?? "" },
  };

  it("records exit code, argv and duration for a successful command", async () => {
    const ev = await runExecCommand({ ...base, name: "ok", argv: ["node", "-e", "process.exit(0)"] });
    expect(ev.exitCode).toBe(0);
    expect(ev.timedOut).toBe(false);
    expect(ev.name).toBe("ok");
    expect(ev.argv).toEqual(["node", "-e", "process.exit(0)"]);
    expect(ev.durationMs).toBeGreaterThanOrEqual(0);
    expect(isGreen(ev)).toBe(true);
  });

  it("records a non-zero exit as evidence rather than throwing", async () => {
    const ev = await runExecCommand({
      ...base,
      name: "red",
      argv: ["node", "-e", "console.error('boom'); process.exit(3)"],
    });
    expect(ev.exitCode).toBe(3);
    expect(ev.outputTail).toContain("boom");
    expect(isGreen(ev)).toBe(false);
  });

  it("captures stdout and stderr together", async () => {
    const ev = await runExecCommand({
      ...base,
      name: "both",
      argv: ["node", "-e", "console.log('OUT'); console.error('ERR')"],
    });
    expect(ev.outputTail).toContain("OUT");
    expect(ev.outputTail).toContain("ERR");
  });

  it("does not interpret shell syntax — argv is passed literally", async () => {
    const ev = await runExecCommand({
      ...base,
      name: "literal",
      argv: ["node", "-e", "console.log(process.argv[1])", "a;rm -rf /"],
    });
    expect(ev.exitCode).toBe(0);
    expect(ev.outputTail).toContain("a;rm -rf /");
  });

  it("kills a command that exceeds its timeout and records timedOut", async () => {
    const ev = await runExecCommand({
      ...base,
      name: "slow",
      timeoutMs: 300,
      argv: ["node", "-e", "setTimeout(() => {}, 60000)"],
    });
    expect(ev.timedOut).toBe(true);
    expect(isGreen(ev)).toBe(false);
    expect(ev.durationMs).toBeLessThan(10_000);
  });

  it("caps runaway output instead of buffering it all", async () => {
    const ev = await runExecCommand({
      ...base,
      name: "loud",
      maxOutputBytes: 2048,
      argv: ["node", "-e", "for (let i = 0; i < 20000; i++) console.log('x'.repeat(50))"],
    });
    expect(ev.truncated).toBe(true);
    // Bounded by the cap plus the elision marker — never the full ~1MB.
    expect(Buffer.byteLength(ev.outputTail, "utf8")).toBeLessThan(2048 + 200);
  });

  it("scrubs the environment it was handed — a command sees no daemon secrets", async () => {
    const ev = await runExecCommand({
      ...base,
      name: "env",
      env: buildExecEnv(policy(), { PATH: process.env.PATH, SECRET_TOKEN: "leaked" } as NodeJS.ProcessEnv),
      argv: ["node", "-e", "console.log(process.env.SECRET_TOKEN ?? 'ABSENT')"],
    });
    expect(ev.outputTail).toContain("ABSENT");
  });

  it("records a spawn failure instead of rejecting", async () => {
    const ev = await runExecCommand({
      ...base,
      name: "missing",
      argv: [path.join(cwd, "definitely-not-a-binary")],
    });
    expect(ev.spawnError).toBeTruthy();
    expect(isGreen(ev)).toBe(false);
  });

  it("runs in the given cwd", async () => {
    writeFileSync(path.join(cwd, "marker.txt"), "hi");
    chmodSync(cwd, 0o755);
    const ev = await runExecCommand({
      ...base,
      name: "cwd",
      argv: ["node", "-e", "console.log(require('fs').existsSync('marker.txt'))"],
    });
    expect(ev.outputTail).toContain("true");
  });
});

describe("evidence helpers", () => {
  const green: ExecEvidence = {
    name: "test",
    argv: ["npm", "test"],
    exitCode: 0,
    durationMs: 4200,
    outputTail: "ok",
    truncated: false,
    timedOut: false,
    startedAt: "2026-07-22T00:00:00.000Z",
  };

  it("isGreen requires a zero exit and no timeout/spawn failure", () => {
    expect(isGreen(green)).toBe(true);
    expect(isGreen({ ...green, exitCode: 1 })).toBe(false);
    expect(isGreen({ ...green, timedOut: true })).toBe(false);
    expect(isGreen({ ...green, spawnError: "ENOENT" })).toBe(false);
    // A kill with no exit code is "we couldn't tell", not a pass.
    expect(isGreen({ ...green, exitCode: null, signal: "SIGKILL" })).toBe(false);
  });

  it("parseEvidence tolerates null, malformed and non-array payloads", () => {
    expect(parseEvidence(null)).toEqual([]);
    expect(parseEvidence("")).toEqual([]);
    expect(parseEvidence("{not json")).toEqual([]);
    expect(parseEvidence('{"name":"test"}')).toEqual([]);
    expect(parseEvidence('[{"nope":1}, null]')).toEqual([]);
    expect(parseEvidence(JSON.stringify([green]))).toHaveLength(1);
  });

  it("describeEvidence marks pass and fail distinctly", () => {
    expect(describeEvidence(green)).toContain("exit 0");
    expect(describeEvidence({ ...green, exitCode: 1 })).toContain("exit 1");
    expect(describeEvidence({ ...green, timedOut: true })).toContain("TIMED OUT");
  });

  it("renderEvidenceBlock inlines the output of failing runs only", () => {
    const red = { ...green, name: "typecheck", exitCode: 2, outputTail: "TYPE ERROR HERE" };
    const md = renderEvidenceBlock([green, red]);
    expect(md).toContain("typecheck");
    expect(md).toContain("TYPE ERROR HERE");
    // The passing run's output stays out of the context budget.
    expect(md.match(/<details>/g)).toHaveLength(1);
    expect(renderEvidenceBlock([])).toBe("");
  });
});
