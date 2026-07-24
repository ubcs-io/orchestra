/**
 * Bounded command execution inside a task worktree (PLANNING/overhaul/05).
 *
 * This is the machinery behind the `run_command` tool: the model never sends a
 * shell string, it picks a NAME from a per-project menu of pre-approved
 * commands (`HarnessPolicy.execAllowlist`) and the fixed argv behind that name
 * is what actually runs. Everything here is deliberately narrow:
 *
 *   - **No shell.** `spawn(argv[0], argv.slice(1), { shell: false })` — no pipes,
 *     no globbing, no `&&`, no interpolation. Optional extra args are regex-
 *     validated and *appended* to the fixed argv, never spliced into it.
 *   - **Scrubbed env.** Only a small allowlist of variables is passed through
 *     (plus project-configured extras), so a hijacked test script can't read the
 *     orchestrator's own API keys out of `process.env`.
 *   - **Bounded.** Hard timeout that kills the whole process group (a test
 *     runner's children die with it), output capped with head+tail retention as
 *     it streams so a runaway process can't exhaust memory.
 *
 * Honest about what this is NOT: a worktree jail is not a sandbox. `npm test`
 * runs arbitrary project code with the daemon's OS privileges — the same trust
 * boundary as the human running that suite locally. That is why `allowExec`
 * ships off and the settings UI states it plainly.
 *
 * The evidence a run produces is recorded HERE, by the harness, not self-
 * reported by the model — which is what makes it un-fakeable by a repair pass
 * (overhaul/03) or a confident-but-wrong verdict.
 */

import { spawn } from "node:child_process";
import type { ExecCommand, HarnessPolicy } from "./harness-policy.js";

/**
 * One harness-recorded command execution. Written only by
 * {@link runExecCommand}; persisted verbatim on `role_runs.evidence_json` and
 * surfaced to the counter-reviewer gate, the critic's context, and the human
 * merge gate.
 */
export interface ExecEvidence {
  /** The allowlist entry's name, as the model invoked it ("test", "typecheck"). */
  name: string;
  /** The exact argv that ran, including any validated appended args. */
  argv: string[];
  /** Process exit code; null when the process was killed (timeout/signal). */
  exitCode: number | null;
  /** Signal that killed the process, when one did. */
  signal?: string | null;
  durationMs: number;
  /** Combined stdout+stderr, head+tail capped (see {@link capOutput}). */
  outputTail: string;
  /** True when the output exceeded the cap and the middle was elided. */
  truncated: boolean;
  /** True when the hard timeout fired and the process group was killed. */
  timedOut: boolean;
  /** ISO timestamp the command started at. */
  startedAt: string;
  /** Set when the command could not be started at all (ENOENT etc.). */
  spawnError?: string;
}

/** Default regex appended args must match when a command sets `allowArgs`
 *  without its own `argPattern`. Deliberately excludes whitespace, quotes,
 *  `$`, backticks and every shell metacharacter — even though nothing here
 *  goes through a shell, a value that *looks* inert is easier to audit. */
export const EXEC_ARG_DEFAULT_PATTERN = "^[A-Za-z0-9._/:@=+-]+$";

/** Hard ceilings on appended args, independent of the per-command pattern —
 *  a pathological `argPattern` still can't produce an unbounded argv. */
const EXEC_MAX_ARGS = 8;
const EXEC_MAX_ARG_LEN = 200;

/** Environment variables passed through to an executed command. Everything
 *  else in the daemon's `process.env` — API keys, `ORCHESTRA_*`, cloud creds —
 *  is dropped. Includes the Windows-only entries unconditionally; they simply
 *  won't exist in `process.env` elsewhere. */
const ENV_PASSTHROUGH = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  "USER",
  "LOGNAME",
  "SHELL",
  // Windows
  "SystemRoot",
  "SystemDrive",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
] as const;

/** Valid shape for a project-configured extra env var name. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type ExecResolution =
  | { ok: true; command: ExecCommand; argv: string[] }
  | { ok: false; error: string };

/**
 * Resolve a model-supplied `{ name, args }` against the project's exec
 * allowlist into a concrete argv, or an error string explaining the refusal.
 * Pure — no filesystem, no process. This is the whole authorization decision
 * for `run_command`, so it is exported and unit-tested directly.
 *
 * Error strings are written to be read BY THE MODEL as a tool result: they
 * name the menu it may choose from rather than just saying "denied".
 */
export function resolveExecInvocation(
  policy: HarnessPolicy,
  name: unknown,
  args: unknown,
): ExecResolution {
  if (!policy.allowExec) {
    return { ok: false, error: "command execution is not enabled for this project" };
  }
  const menu = policy.execAllowlist ?? [];
  if (!menu.length) {
    return { ok: false, error: "this project has no approved commands configured" };
  }
  const names = menu.map((c) => c.name).join(", ");
  if (typeof name !== "string" || !name.trim()) {
    return { ok: false, error: `\`name\` is required — choose one of: ${names}` };
  }
  const command = menu.find((c) => c.name === name);
  if (!command) {
    return { ok: false, error: `unknown command "${name}" — available commands: ${names}` };
  }

  const extra = args == null ? [] : args;
  if (!Array.isArray(extra) || !extra.every((a) => typeof a === "string")) {
    return { ok: false, error: "`args` must be an array of strings" };
  }
  const nonEmpty = (extra as string[]).filter((a) => a.length > 0);
  if (!nonEmpty.length) return { ok: true, command, argv: [...command.argv] };

  if (!command.allowArgs) {
    return {
      ok: false,
      error: `command "${name}" takes no extra arguments — call it with just { "name": "${name}" }`,
    };
  }
  if (nonEmpty.length > EXEC_MAX_ARGS) {
    return { ok: false, error: `too many arguments (max ${EXEC_MAX_ARGS})` };
  }
  const source = command.argPattern ?? EXEC_ARG_DEFAULT_PATTERN;
  let re: RegExp;
  try {
    re = new RegExp(source);
  } catch {
    // A malformed pattern must deny, never fall open to "no validation".
    return { ok: false, error: `command "${name}" has an invalid argument pattern configured` };
  }
  for (const a of nonEmpty) {
    if (a.length > EXEC_MAX_ARG_LEN) {
      return { ok: false, error: `argument too long (max ${EXEC_MAX_ARG_LEN} chars): "${a.slice(0, 40)}…"` };
    }
    if (!re.test(a)) {
      return { ok: false, error: `argument "${a}" is not allowed for "${name}" (must match ${source})` };
    }
  }
  return { ok: true, command, argv: [...command.argv, ...nonEmpty] };
}

/**
 * Build the scrubbed environment an executed command sees: the passthrough
 * allowlist above, `CI=1` (so test runners pick their non-interactive path),
 * then the project's own `execEnv` extras last so a project can override any of
 * it deliberately. Pure — exported for unit testing.
 */
export function buildExecEnv(
  policy: HarnessPolicy,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_PASSTHROUGH) {
    const v = source[key];
    if (typeof v === "string") env[key] = v;
  }
  // Non-interactive by default: keeps watch-mode test runners from hanging
  // until the timeout kills them.
  env.CI = "1";
  for (const [k, v] of Object.entries(policy.execEnv ?? {})) {
    if (ENV_NAME_RE.test(k) && typeof v === "string") env[k] = v;
  }
  return env;
}

export interface CappedOutput {
  text: string;
  truncated: boolean;
}

/**
 * Cap combined command output to `maxBytes` with head+tail retention: the head
 * carries the runner's banner (which suite, how it was invoked) and the tail
 * carries the failure summary — the middle is where a 200k-line passing log
 * lives, and it is what gets elided. Byte-accurate on UTF-8 rather than
 * character-accurate, since the cap exists to protect the context budget
 * (overhaul/07). Pure — exported for unit testing.
 */
export function capOutput(text: string, maxBytes: number): CappedOutput {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncated: false };
  const headBytes = Math.floor(maxBytes * 0.25);
  const tailBytes = maxBytes - headBytes;
  const head = buf.subarray(0, headBytes).toString("utf8");
  const tail = buf.subarray(buf.length - tailBytes).toString("utf8");
  const elided = buf.length - headBytes - tailBytes;
  return {
    text: `${head}\n\n…(${elided} bytes of output elided)…\n\n${tail}`,
    truncated: true,
  };
}

/**
 * A streaming head+tail accumulator so a runaway process (an infinite log loop)
 * can never grow the buffer past ~`maxBytes`, however long it runs. Keeps the
 * first quarter of the budget verbatim and a rolling window of the most recent
 * output for the rest.
 */
function createOutputCollector(maxBytes: number) {
  const headBudget = Math.max(1, Math.floor(maxBytes * 0.25));
  const tailBudget = Math.max(1, maxBytes - headBudget);
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let total = 0;

  return {
    push(chunk: Buffer): void {
      total += chunk.length;
      if (head.length < headBudget) {
        const take = Math.min(headBudget - head.length, chunk.length);
        head = Buffer.concat([head, chunk.subarray(0, take)]);
        chunk = chunk.subarray(take);
        if (!chunk.length) return;
      }
      tail = Buffer.concat([tail, chunk]);
      // Bounded slack (2x) so we don't re-allocate on every small chunk.
      if (tail.length > tailBudget * 2) tail = tail.subarray(tail.length - tailBudget);
    },
    result(): CappedOutput {
      if (total <= maxBytes) {
        return { text: Buffer.concat([head, tail]).toString("utf8"), truncated: false };
      }
      const keptTail = tail.length > tailBudget ? tail.subarray(tail.length - tailBudget) : tail;
      const elided = total - head.length - keptTail.length;
      return {
        text:
          `${head.toString("utf8")}\n\n…(${elided} bytes of output elided)…\n\n${keptTail.toString("utf8")}`,
        truncated: true,
      };
    },
  };
}

export interface RunExecOptions {
  /** Allowlist entry name, recorded on the evidence. */
  name: string;
  /** Fully resolved argv (from {@link resolveExecInvocation}). */
  argv: string[];
  /** Working directory — always the task worktree; callers assert that. */
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  env: Record<string, string>;
  /** Cancels the command when the surrounding role run is aborted. */
  signal?: AbortSignal;
}

/**
 * Run one approved command and return its evidence. Never throws and never
 * rejects: a spawn failure, a non-zero exit and a timeout are all normal,
 * recordable outcomes — the whole point of grounded verification is that a red
 * suite is *information*, not an error to be swallowed.
 *
 * On timeout the entire process group is killed (SIGTERM, then SIGKILL after a
 * short grace period), so a test runner's spawned children die with it rather
 * than being orphaned onto the daemon.
 */
export function runExecCommand(opts: RunExecOptions): Promise<ExecEvidence> {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const collector = createOutputCollector(opts.maxOutputBytes);
  // Process-group semantics are POSIX-only; on Windows spawn's own tree kill
  // is the best available and `detached` would open a console window.
  const useProcessGroup = process.platform !== "win32";

  return new Promise<ExecEvidence>((resolve) => {
    const finish = (extra: Partial<ExecEvidence>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      const out = collector.result();
      resolve({
        name: opts.name,
        argv: opts.argv,
        exitCode: null,
        signal: null,
        durationMs: Date.now() - start,
        outputTail: out.text,
        truncated: out.truncated,
        timedOut: false,
        startedAt,
        ...extra,
      });
    };

    let settled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(opts.argv[0]!, opts.argv.slice(1), {
        cwd: opts.cwd,
        env: opts.env,
        shell: false,
        detached: useProcessGroup,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      finish({ spawnError: (err as Error).message });
      return;
    }

    /** SIGTERM the group, then SIGKILL anything that ignored it. */
    const killTree = (): void => {
      if (child.pid == null) return;
      try {
        if (useProcessGroup) process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      killTimer = setTimeout(() => {
        if (child.pid == null) return;
        try {
          if (useProcessGroup) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, 2000);
      killTimer.unref?.();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, opts.timeoutMs);

    const onAbort = () => killTree();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (c: Buffer) => collector.push(c));
    child.stderr?.on("data", (c: Buffer) => collector.push(c));

    child.on("error", (err) => {
      if (killTimer) clearTimeout(killTimer);
      finish({ spawnError: err.message, timedOut });
    });
    child.on("close", (code, sig) => {
      if (killTimer) clearTimeout(killTimer);
      finish({ exitCode: code, signal: sig, timedOut });
    });
  });
}

// ---------------------------------------------------------------------------
// Evidence helpers (shared by the orchestrator gate, role context, and the API)
// ---------------------------------------------------------------------------

/** Parse a persisted `role_runs.evidence_json`, tolerating null/legacy/garbage
 *  rows — a malformed column must read as "no evidence" (which fails an
 *  evidence criterion), never crash a gate. */
export function parseEvidence(json: string | null | undefined): ExecEvidence[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is ExecEvidence =>
        !!e && typeof e === "object" && typeof (e as ExecEvidence).name === "string",
    );
  } catch {
    return [];
  }
}

/** Whether a recorded execution counts as a green run: it actually exited, and
 *  exited zero. A timeout or a signal kill is never "passing". */
export function isGreen(e: ExecEvidence): boolean {
  return e.exitCode === 0 && !e.timedOut && !e.spawnError;
}

/** One-line human/model-readable summary of an execution. */
export function describeEvidence(e: ExecEvidence): string {
  const status = e.spawnError
    ? `could not start (${e.spawnError})`
    : e.timedOut
      ? "TIMED OUT"
      : e.exitCode === 0
        ? "exit 0 ✓"
        : e.exitCode == null
          ? `killed (${e.signal ?? "signal"})`
          : `exit ${e.exitCode} ✗`;
  return `\`${e.name}\` (\`${e.argv.join(" ")}\`) — ${status}, ${Math.round(e.durationMs / 1000)}s`;
}

/**
 * Markdown block describing the executions recorded so far, for injection into
 * a later role's context (the critic sees the developer's runs) and into the
 * merge-review payload. Includes the output tail of any FAILING run — that is
 * the part a reviewer actually needs — while passing runs stay one line each so
 * a green suite costs almost no context (overhaul/07).
 */
export function renderEvidenceBlock(entries: ExecEvidence[], failTailChars = 2000): string {
  if (!entries.length) return "";
  const lines: string[] = ["## Verification evidence (recorded by the harness, not self-reported)"];
  for (const e of entries) {
    lines.push(`- ${describeEvidence(e)}`);
  }
  const failing = entries.filter((e) => !isGreen(e));
  for (const e of failing) {
    const tail = e.outputTail.slice(-failTailChars);
    if (tail.trim()) {
      lines.push(`\n<details>\n<summary>Output of failing \`${e.name}\`</summary>\n\n\`\`\`\n${tail}\n\`\`\`\n\n</details>`);
    }
  }
  return lines.join("\n");
}
