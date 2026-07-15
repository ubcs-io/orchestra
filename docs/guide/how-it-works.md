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

## Stage 5: Gate

After each role, the orchestrator evaluates the state:

- **Keep refining** — advance to the next role
- **Loop back** — if the counter-reviewer finds an unmet "must" criterion, re-run the responsible role (up to `maxLoopbacks` times)
- **Escalate to REVIEW** — if loopback limit is exhausted, flag for human attention
- **Exit to READY** — when the terminal role completes

For **spec** tasks, the decomposition role spawns an epic → story → task child tree.

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