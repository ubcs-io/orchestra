# Writing & Running Code

By default every role is **read-only** against your repository: the only files Orchestra ever writes are `PLANNING/` artifacts. A project can opt into two further capabilities, independently, and both ship **off**.

| Capability | Policy flag | What it grants |
|---|---|---|
| Editing source | `allowWrite` | The `write` / `edit` tools may appear in a role's tool list. |
| Running commands | `allowExec` | The `run_command` tool, restricted to a named allowlist. |

Both are per-project and live under `config_json.harness`, read and written via `GET`/`PATCH /api/projects/:id/harness-policy` or the **Roles Editor** UI. Until `allowWrite` is on, `write`/`edit` cannot be added to any role's `tools_json` — not even by editing the JSON directly.

::: warning The worktree is a jail, not a sandbox
Write and edit are confined to the task's own git worktree, so an agent's *file writes* can never touch anything outside its disposable checkout. `run_command` is a bigger trust decision: it spawns real project code with the daemon's OS privileges. The allowlist, not the worktree, is what bounds it.
:::

## The `run_command` Tool

The model never supplies a command line. It picks a `name` from the project's menu and the fixed `argv` behind that name is what runs:

```json
{
  "allowExec": true,
  "execAllowlist": [
    { "name": "test", "argv": ["npm", "test"], "allowArgs": true, "description": "Run the test suite" },
    { "name": "typecheck", "argv": ["npx", "tsc", "--noEmit"] },
    { "name": "lint", "argv": ["npm", "run", "lint"] }
  ],
  "execTimeoutMs": 120000,
  "execMaxOutputBytes": 65536,
  "execMaxRuns": 5
}
```

| Field | Default | Meaning |
|---|---|---|
| `name` | — | What the model invokes: `run_command({ name: "test" })`. |
| `argv` | — | The fixed command. Never interpolated. |
| `allowArgs` | `false` | Whether extra arguments (e.g. a test-file filter) may be appended. |
| `argPattern` | `^[A-Za-z0-9._/:@=+-]+$` | Regex every appended argument must match. A malformed pattern denies rather than falling open. |
| `timeoutMs` | `execTimeoutMs` | Per-command override, for a legitimately slow suite. |
| `execTimeoutMs` | `120000` | Default hard timeout per execution. |
| `execMaxOutputBytes` | `65536` | Combined stdout+stderr retained per execution, head + tail. |
| `execMaxRuns` | `5` | Executions per role run — bounds a small model looping on `test`. |
| `execEnv` | `{}` | Extra environment variables on top of a minimal passthrough allowlist. |

An empty allowlist means `run_command` is never registered, even with `allowExec: true` — there is nothing to run.

## Evidence

Every execution is recorded by the harness, not self-reported by the model: exit code, timing, timeout/spawn-error status, and capped output land on the run as `evidence_json` and render in the Task Detail evidence panel.

That turns two of the execution flow's previously *implicit* expectations into machine-checkable acceptance criteria:

| Criterion | Requires |
|---|---|
| `exec.tests_pass` | The project's `test` command ran in this task's worktree and exited 0. |
| `exec.typecheck` | The project's `typecheck` command ran in this task's worktree and exited 0. |

Each is attached **only when the project's allowlist actually defines that command**, so a project with no test command never fails a gate for not running one — and a project with exec turned off sees no change at all.

Evidence also feeds [run health](/reference/reliability#run-health): a clean run whose commands all came back green is promoted to `verified`. A run whose commands came back **red** stays `healthy` — the run worked, it just reported bad news. Failing evidence is a gate concern, not a health concern.

## The `developer` Role

`developer` (Implementation Engineer) is the seeded role intended to hold write/edit. It ships with **no tools** — it's a sensibly-named target for the opt-in rather than a capability grant of its own. Without write tools it treats its step as a dry run and describes the change it *would* make.

Its persona is explicit that finishing means green checks, not written code: *"your work is not done when the code is written — it is done when the project's own checks run green against it."*

## How a Task Reaches Execution

`developer` is wired into one built-in flow — the **execution flow** (`developer` → `critic`), which produces the third exit shape, `code_change`. A task enters it two ways:

1. **An execution-ready decomposition leaf.** When `decomposition` flags an atomic subtask `execution_ready: true`, that child routes straight to implementation instead of another planning pass. It already carries its own scoped acceptance criteria, so no criteria checklist is re-derived.
2. **The XS fast path.** When `explorer` sizes a task `XS`, Orchestra skips `architecture_review` / `test_strategy` / `spec_review` / `decomposition` and routes straight to the execution flow. A two-file default-value flip has no business walking the full planning gauntlet only for decomposition to conclude "no further work" several expensive steps later.

   The fast path is gated: it only applies to a `spec`-exit task at `task` level, and never when autonomy level is `plan` or planning rigor is `thorough`.

In the execution flow `critic` **is** the review step, so `reviewDepth` is `none` and `critic`'s own verdict (`pass` / `blocker` / `needs_human`) is the sole automated gate before human merge review.

## Autonomy Levels

How far a task's own pipeline may progress unattended. Project default at `config_json.autonomyLevel`; per-task override on `tasks.autonomy_level` (null inherits).

| Level | Behavior |
|---|---|
| `plan` | Stop before any code is written. Disables the XS fast path and execution routing. |
| `edit` | **Default.** Write code, then always park for an explicit human merge approval. |
| `auto` | Write code, and once the task's own checks pass, attempt the merge instead of waiting for a human. |

::: tip Two different "autonomy" settings
This is unrelated to a project's `config_json.autonomy` block, which governs whether [watcher-generated work](/guide/autonomy) may be scheduled at all. Different axis, similar name — the endpoints are `/autonomy-level` and `/autonomy` respectively.
:::

## The Merge Gate

A task that wrote real source is never quietly merged into your base branch at level `plan` or `edit`. Instead:

- The task lands at `stage: "review"` with `exit_state: "needs_merge_approval"` (or, for a family whose members wrote source, `reconcile_status: "pending_human_merge"` on the family root).
- The Task Detail **review branch** pill opens a file-level diff of the task branch against its base (`GET /api/tasks/:id/diff`), with per-file unified patches fetched lazily. `GET /api/tasks/:id/runs/:runId/diff` scopes the same view to a single role run.
- With a GitHub token configured you can push the branch or push-and-open a PR without leaving Orchestra.
- Two interventions close the loop: `approve_merge` performs the merge, `request_changes` (with an optional note) sends it back.

At level `auto`, the orchestrator attempts the real merge itself when the task's checks pass — and falls back to exactly the `edit` behavior the moment there's a genuine conflict or error, never swallowing one. Family-wide reconciliation follows the **root** task's autonomy level, and only fires once every member of the worktree family has reached a terminal state.

## Visibility

The Settings safety dashboard (`GET /api/safety`) reports whether any project has write or exec enabled, which roles hold those tools, and whether source-code writes are currently possible at all.
