# What is Orchestra?

**Orchestra** is a configurable, Git-backed refinement utility that routes work through a chain of specialized "software-company role" agents — powered by [pi](https://github.com/earendil-works/pi) over any OpenAI-compatible endpoint — until it becomes **actionable**: either a decomposed **spec** (epic → story → task) or a **research brief** (approaches, trade-offs, edge cases, recommendation).

## The Problem

LLMs fail at big, vague tasks. They lose context, skip concerns, and produce shallow output. Orchestra breaks those tasks into tracked steps that you can:

- **Watch live** via Server-Sent Events
- **Notice gaps** via a declarative coverage map (correctness, security, privacy, performance, etc.)
- **Steer mid-run** — pause, inject roles, deepen analysis, add notes
- **Version control** — every refinement step commits to your repo as markdown

![Orchestra dashboard — task board, network health, and registered projects](/screenshots/dashboard.png)

## Key Concepts

### Intake

You drop work into Orchestra via the UI or by placing a file in `<repo>/PLANNING/INTAKE/`. It can be anything:

- A stack trace or error log → an `error_file` intake
- A one-line feature request → a `feature` intake
- An open-ended research question → a `research` intake

Orchestra infers the **intake kind** automatically (based on file extension and content) and applies the appropriate flow.

### Flows & Roles

Each intake kind has a **flow template** — an ordered list of role agents with a counter-reviewer. A role is a specialized AI persona (e.g., Bug Investigator, Security Reviewer, API Designer) with specific tools and a system prompt.

The flow also defines **rigor** (low, standard, high), **acceptance criteria** (what "done" looks like), and **max loopbacks** (how many times the counter-reviewer can send work back before escalating to a human).

### Gates & Counter-Reviewers

Each flow includes a **counter-reviewer** — a role whose job is to verify prior output against predefined criteria, not to author new content. If a "must" criterion is unmet, the orchestrator loops back to the responsible role. If still unmet after `maxLoopbacks` attempts, the task escalates to **REVIEW** for a human.

Alongside the flow-level counter-reviewer, a cross-cutting **`critic`** role can run immediately after individual steps (per the flow's `reviewDepth`) to catch domain-ending violations early, scoped to just that step's output. Two optional, off-by-default LLM routing advisors — escalation assessment and borderline gate assessment — can further refine gate decisions; see [How It Works](/guide/how-it-works) and [Configuration](/reference/config#strategic-llm-routing-advisors).

### Exit Shapes

- **spec** — ends with the `decomposition` role, producing an epic → story → task tree with acceptance criteria
- **research_brief** — ends with the `research_synthesis` role, producing a decision brief with options, trade-offs, and a recommendation
- **code_change** — ends with the `critic` role, producing an implemented change on the task's own branch, parked for [merge review](/guide/execution#the-merge-gate)

### Reliability

Orchestra is built for local, low-context models, which fail in specific ways: truncated output, unreliable custom tool calls, context exhaustion. Reports are written to the artifact as they're produced (so a failed structured payload never costs you the analysis), the verdict is obtained by the most guaranteed mechanism the endpoint supports, and every run carries a [health record](/reference/reliability#run-health) that the gates take into account before trusting what it concluded.

### Self-Generated Work

With [autonomy](/guide/autonomy) enabled, watchers scan the repo during idle windows — failing tests, decayed TODOs, lint drift, doc drift, quiet branches, stale dependencies — and propose candidates that become ordinary tasks under hard caps. Off by default, per project.

## Architecture

One Node process is the whole app. The server boots the database, seeds the role catalog, serves the REST + SSE API and the built client, and runs two independent loops in-process: the orchestrator scheduler and the watcher loop. No external broker, queue, or cron: SQLite is the durable work queue. Each scheduler round dispatches up to `maxConcurrentTasks` tasks' next role-step concurrently, each isolated in its own [git worktree](/guide/how-it-works#git-isolation-concurrency) — a single task is still strictly sequential against itself (a restore can never race that task's own in-flight step), but distinct tasks genuinely overlap instead of taking turns.

A second, optional process — the [MCP server](/reference/mcp) — exposes task context and the candidate queue to external agents over stdio. It is never spawned by the daemon and only ever reads.

- **Backend:** Fastify (REST + SSE), better-sqlite3 (WAL), pi
- **Frontend:** Vite + React SPA, TanStack Router + TanStack Query, native `EventSource`

## Next Steps

- [Quick Start](/guide/quick-start) — get Orchestra running in 5 minutes
- [How It Works](/guide/how-it-works) — deep dive into the refinement pipeline
- [Roles Catalog](/reference/roles) — all 25 roles and their capabilities
- [Writing & Running Code](/guide/execution) — opt roles into editing source and running your test suite
- [Autonomous Operation](/guide/autonomy) — let Orchestra generate its own work
- [Agent Networks](/guide/networks) — build custom visual agent graphs