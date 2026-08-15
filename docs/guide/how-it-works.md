<script lang="ts" setup>
// No TypeScript issues
</script>

# How It Works

Orchestra's refinement pipeline takes a raw intake through six stages:

```
INTAKE file / UI  ─►  Orchestrator  ─►  role agents (pi)  ─►  READY  (spec, brief, or code change)
   or a watcher         (router +         read/grep the            or
                        gatekeeper)       real repo, write      REVIEW (needs human)
                            │             PLANNING artifacts
                            ▼
                    SQLite (source of truth + work queue)
```

## Stage 1: Intake

Drop work into Orchestra via the UI or by placing a file in `<repo>/PLANNING/INTAKE/`. It can be anything — a stack trace, a one-line request, or an open-ended research question.

Work can also arrive without you: with [autonomy](/guide/autonomy) enabled, watchers scan the repo during idle windows and propose their own candidates, which run through this same pipeline once triaged.

## Stage 2: Ingest

The orchestrator picks up the intake, creates a task record in SQLite, infers its **intake kind** (a `.log`/traceback → `error_file`, a question → `question`, etc.), seeds a markdown artifact in `PLANNING/REFINING/`, and commits it to git.

## Stage 3: Plan

A **flow template** for the intake kind becomes the task's ordered list of roles. Each flow includes:

- **Steps** — the ordered role sequence
- **Counter-reviewer** — a gate role placed before the terminal role
- **Acceptance criteria** — predefined, testable checks (each tagged as "must" or "should")
- **Rigor** — `low`, `standard`, or `high` (controls how thorough the review chain is)
- **Max loopbacks** — how many times the gate can send work back before escalating
- **Mandatory concerns** — coverage dimensions that MUST end up "considered"

## Stage 4: Run

One role at a time runs as a pi agent session, against that task's own [dedicated git worktree](#git-isolation-concurrency). Each role:

1. Reads/greps the real repository using its assigned tools — and, where the project has [opted in](/guide/execution), edits source or runs allowlisted commands
2. **Writes its report as it goes.** Each finished section is appended to the task artifact immediately via `report_section`, so the analysis is durable before the run ends
3. Records a small structured **verdict trailer**: a verdict (`pass`, `needs_more`, `blocker`, `needs_human`), a summary, a **coverage map** of which concerns it examined/skipped/ignored, and any **open questions** it couldn't resolve — each with its own best-effort guess (`assumed_answer`) and `confidence`, so an ordinary open question doesn't stall the pipeline; `blocker`/`needs_human` are reserved for questions with no reasonable guess at all
4. Commits (`refine(<role>): <task> — <purpose>`) — the resulting SHA is recorded as the run's **checkpoint**, so the task can later be [restored](/guide/steering#task-lifecycle) back to right after this step

The split in steps 2 and 3 is the point: because the write-up is already on disk, a failed or truncated structured payload costs the ~4-field trailer, never the work. Orchestra then walks a [delivery ladder](/reference/reliability#the-verdict-delivery-ladder) to get that trailer — constrained decoding, tool call, JSON fence, a cheap repair call — and records which rung succeeded.

Every run also gets a [health record](/reference/reliability#run-health) (`verified` / `healthy` / `recovered` / `degraded` / `empty`) that follows it into the UI, the gates, and the reliability rollups.

How a run is shaped for a given model — single-turn, two-turn (exploration → formalization), or text-only — is [measured per model](/reference/reliability#model-capability-profiles) rather than hand-configured, though the `twoPhase`/`textMode` flags still work for a model you haven't probed.

If a human later answers one of these open questions (once the task is at `stage: "review"`), the optional [Answer Match Assessment](/reference/config#strategic-llm-routing-advisors) call point compares the answer against the recorded guess. A confirmed guess is left alone; a contradicted one restores the task to that role's checkpoint and re-runs downstream steps with the corrected answer.

Each completed run is recorded with its verdict, disposition, token usage, and full reasoning trace:

![Role run detail — verdict, tokens/sec, and reasoning trace for a completed step](/screenshots/role-history.png)

## Stage 5: Critique

Depending on the flow's `reviewDepth` (`none` / `terminal_only` / `every_step`, see [Roles Catalog](/reference/roles#cross-cutting-critique)), a scoped adversarial **`critic`** role runs immediately after a step, checking *only that step's output* for a domain-ending violation (PII exposure, an authz bypass, an irreversible data-loss migration, a legal/compliance breach). Silence (`pass`) is the expected default — it only speaks up for genuine, high-severity issues. The critique is recorded as its own run (`run_kind: "critique"`, linked to the primary run) and its verdict is folded into the step's effective verdict without ever silently downgrading it. A `blocker` critique on a non-reviewer step can trigger one bounded loop-back independent of the flow's own reviewer.

If the optional **second-review** [routing advisor](/reference/config#strategic-llm-routing-advisors) is enabled, it authoritatively synthesizes the primary run + critique afterward, and can let a critic false-positive proceed (`accept`/`accept_with_note`) instead of forcing a loop-back.

## Stage 6: Gate

After each role (and any critique), the orchestrator evaluates the state:

- **Keep refining** — advance to the next role
- **Loop back** — if the counter-reviewer finds an unmet "must" criterion (or a critique blocker fires), re-run the responsible role (up to `maxLoopbacks` times)
- **Escalate to REVIEW** — if the loopback limit is exhausted, flag for human attention
- **Exit to READY** — when the terminal role completes

[Run health](/reference/reliability#where-health-is-enforced) participates in these decisions: a counter-reviewer whose own run came back `degraded` or `empty` fails the gate outright (a synthesized run's defaulted criteria results must not slip through), and with `requireHealthyTerminal` enabled a degraded terminal run loops back and then escalates rather than promoting the task to READY on a synthesized verdict.

Where the flow declares **evidence criteria** — the project's `test` or `typecheck` command exiting 0 inside the task's worktree — those are checked against harness-recorded [evidence](/guide/execution#evidence), not against the model's claims about them.

Two optional LLM routing advisors can refine borderline gate calls: **escalation assessment** (is escalation truly needed, or should the task reroute/rerun/close instead?) and **borderline gate assessment** (for partial-criteria or near-loopback-exhaustion cases). Both are off by default and fall back to the heuristic decision above — see [Strategic LLM Routing Advisors](/reference/config#strategic-llm-routing-advisors).

For **spec** tasks, the decomposition role spawns an epic → story → task child tree. Any open question a role raises along the way can also be spun off — via the Task Detail page's review call-to-action, or `POST /api/tasks/:id/questions/decompose` — into its own child **Question Flow** subtask, which gets a full task page of its own (and can recursively spin off its own open questions the same way). If a later Answer Match contradiction rolls a parent task back past the point where it decomposed, its already-spawned children aren't touched or deleted — they're just flagged `stale_reason` for a human to triage, since the guess they were built on turned out wrong.

On **Exit to READY**, the orchestrator reconciles the task's dedicated branch back into its base branch: base is merged into the task branch first (so any conflict resolution happens on the disposable task branch, never on shared history), then the task branch is merged into base. This is best-effort — a conflict or error is recorded on the task (`reconcile_status`, `reconcile_detail`) rather than blocking the "ready" transition, since the artifact itself is unaffected; only its git history needs manual attention. The task branch itself is always left in place afterward, merged or not.

That describes an **artifact-only** task. A task that wrote real source code is treated differently: at autonomy level `plan` or `edit` it is parked for an explicit human merge approval rather than auto-reconciled, and only the `approve_merge` intervention lands it. At level `auto` the orchestrator attempts the merge itself once the task's own checks pass, falling back to the human gate on any conflict. Family-wide reconciliation follows the **root** task's level and waits until every member of the worktree family has settled. See [the merge gate](/guide/execution#the-merge-gate).

## Git Isolation & Concurrency

Every task runs against its **own git worktree and branch** (`<repo>/.orchestra-worktrees/<taskId>`, checked out onto `orchestra/<taskId>` off the project's base branch), created the first time the task needs to touch the repo. This means:

- **Tasks run concurrently.** The scheduler dispatches up to `maxConcurrentTasks` (default `3`, see [Configuration](/reference/config)) tasks' role-steps in the same round, each in its own worktree — one task's commits can never collide with another's, or with your own work on the checkout you're actively looking at.
- **Each task still runs single-threaded against itself.** A restore or an answer-reincorporation for a given task is serialized against that task's own in-flight step, so a task's own history can never be mutated concurrently — only *different* tasks overlap.
- **Checkpoints are per-role-run.** Every primary run's post-commit SHA is recorded (`git_commit_sha`), so a task can be [restored](/guide/steering#task-lifecycle) back to right after any of its own completed roles via `POST /api/tasks/:id/restore` or the Task Detail page's role-run history.
- **Worktrees are cleaned up, branches aren't.** Deleting or resetting a task removes its worktree directory (a real disk cost) but leaves the branch ref in place; the worktree is silently recreated onto that branch the next time the task does any work (including a later restore).
- **Merges happen once, on completion.** Nothing is merged into your base branch mid-refinement — only the final [reconciliation](#stage-6-gate) on Exit to READY touches it, and only after the task branch has already absorbed base cleanly.

Tasks created before this feature (or whose worktree was removed by a crash) fall back to the project's shared checkout until they next need `ensureTaskWorkspace` to (re)create their worktree — this is transparent and requires no manual migration.

## The PLANNING/ Tree

All artifacts are written into your repository:

```
<repo>/PLANNING/
  INTAKE/     drop raw intakes / error files here
  REFINING/   in-flight artifacts (one .md per task, growing per role)
  READY/      exit_state = ready_for_work
  REVIEW/     exit_state = needs_review (awaiting a human)
  epics/      epic/story/task decomposition output
```

The Project Board mirrors these same four stages as kanban columns, so you can watch tasks move across the pipeline:

![Project board — tasks grouped into Intake, Refining, Ready, and Review columns](/screenshots/manage-tasks.png)

State lives in SQLite (the authoritative work queue); the `PLANNING/` tree mirrors it on disk so the refinement history is version-controlled and PR-able.

## Intake Kinds & Flow Rigor

| Kind | Exit | Rigor | Description |
|---|---|---|---|
| `error_file` | spec | standard | Stack trace or error log → bug investigation |
| `bug` | spec | standard | Described bug report → investigation |
| `security` | spec | high | Vulnerability report → adversarial review |
| `feature` | spec | standard | Feature request → full spec with contracts, schema, security |
| `manual` | spec | standard | Open-ended request → structured spec |
| `chore` | spec | low | Housekeeping → conventions + tests |
| `spike` | spec | low | Exploration → options + feasibility |
| `research` | research_brief | low | Open-ended research → decision brief |
| `ux` | research_brief | low | UX-focused question → design review + brief |
| `question` | research_brief | low | Quick question → options + synthesis |

## Three Exit Shapes

| Exit kind | Terminal role | Produces |
|---|---|---|
| `spec` | `decomposition` | An epic → story → task tree with acceptance criteria. |
| `research_brief` | `research_synthesis` | A decision brief: options, trade-offs, edge cases, recommendation. |
| `code_change` | `critic` | An implemented change on the task's branch, parked for merge review. |

`code_change` isn't reachable from an intake kind directly. A task arrives there either as a decomposition leaf flagged `execution_ready`, or via the XS fast path — when `explorer` sizes the work `XS`, Orchestra skips the remaining planning roles and routes straight to the [execution flow](/guide/execution#how-a-task-reaches-execution), because a genuinely tiny change has no business walking the full gauntlet only for decomposition to conclude "no further work" several expensive steps later.