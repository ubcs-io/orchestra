<script lang="ts" setup>
// No TypeScript issues
</script>

# How It Works

Orchestra's refinement pipeline takes a raw intake through five stages:

```
INTAKE file / UI  ─►  Orchestrator  ─►  role agents (pi)  ─►  READY  (spec or research brief)
                       (router +          read/grep the           or
                        gatekeeper)       real repo, write     REVIEW (needs human)
                            │             PLANNING artifacts
                            ▼
                    SQLite (source of truth + work queue)
```

## Stage 1: Intake

Drop work into Orchestra via the UI or by placing a file in `<repo>/PLANNING/INTAKE/`. It can be anything — a stack trace, a one-line request, or an open-ended research question.

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

One role at a time runs as a pi agent session. Each role:

1. Reads/greps the real repository using its assigned tools
2. Records a structured **verdict** (`pass`, `needs_more`, `blocker`, `needs_human`)
3. Declares a **coverage map** — which concerns it examined, skipped, or ignored
4. Appends a markdown section to the artifact, then commits (`refine(<role>): <task> — <purpose>`)

Roles that struggle with native tool calling can run in **two-phase mode** (exploration → JSON formalization) or **text mode** (JSON output via markdown).

## Stage 5: Critique

Depending on the flow's `reviewDepth` (`none` / `terminal_only` / `every_step`, see [Roles Catalog](/reference/roles#cross-cutting-critique)), a scoped adversarial **`critic`** role runs immediately after a step, checking *only that step's output* for a domain-ending violation (PII exposure, an authz bypass, an irreversible data-loss migration, a legal/compliance breach). Silence (`pass`) is the expected default — it only speaks up for genuine, high-severity issues. The critique is recorded as its own run (`run_kind: "critique"`, linked to the primary run) and its verdict is folded into the step's effective verdict without ever silently downgrading it. A `blocker` critique on a non-reviewer step can trigger one bounded loop-back independent of the flow's own reviewer.

If the optional **second-review** [routing advisor](/reference/config#strategic-llm-routing-advisors) is enabled, it authoritatively synthesizes the primary run + critique afterward, and can let a critic false-positive proceed (`accept`/`accept_with_note`) instead of forcing a loop-back.

## Stage 6: Gate

After each role (and any critique), the orchestrator evaluates the state:

- **Keep refining** — advance to the next role
- **Loop back** — if the counter-reviewer finds an unmet "must" criterion (or a critique blocker fires), re-run the responsible role (up to `maxLoopbacks` times)
- **Escalate to REVIEW** — if loopback limit is exhausted, flag for human attention
- **Exit to READY** — when the terminal role completes

Two optional LLM routing advisors can refine borderline gate calls: **escalation assessment** (is escalation truly needed, or should the task reroute/rerun/close instead?) and **borderline gate assessment** (for partial-criteria or near-loopback-exhaustion cases). Both are off by default and fall back to the heuristic decision above — see [Strategic LLM Routing Advisors](/reference/config#strategic-llm-routing-advisors).

For **spec** tasks, the decomposition role spawns an epic → story → task child tree. Any open question a role raises along the way can also be spun off — via the Task Detail page's review call-to-action, or `POST /api/tasks/:id/questions/decompose` — into its own child **Question Flow** subtask, which gets a full task page of its own (and can recursively spin off its own open questions the same way).

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