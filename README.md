# Orchestra

**A Configurable Model Orchestrator for Auditable, Long Running Tasks**

Smaller local LLMs fail at tasks which require large context windows or are poorly scoped; frontier models struggle here as well, but they can afford to solve the problem with more hardware - you can't. The point of Orchestra is to offer **tighter control and visibility over long-running, nebulous work**, it breaks tasks into tracked steps you can *watch* live, *notice* gaps in (via a coverage map), *steer* mid-run, and *enrich* durably.

Letting a local model burn tokens on a dead-end exploration feels more productive when you can easily travel back to a checkpoint and see *where* the task went sideways.  Fewer blind re-runs means better output.

Connect any git repository, drop in work that ranges from a bare error log to an open-ended research prompt, and a single orchestrator routes it through a chain of specialized "software-company role" agents — powered by [pi](https://github.com/earendil-works/pi) over any OpenAI-compatible endpoint — until it becomes **actionable**: a decomposed **spec** (epic → story → task), a **research brief** (approaches, trade-offs, edge cases, recommendation), or — where you've opted in — an implemented **code change** waiting at a merge gate with a green test run behind it. *Mix and match* your API and local models in a single workflow to maximize the value of your frontier API calls while keeping local hardware saturated for long runs.

**[Read the docs →](https://ubcs-io.github.io/orchestra/)**

![Orchestra dashboard — task board, network health, and registered projects](docs/public/screenshots/dashboard.png)

---

## How it works

```
INTAKE file / UI  ─►  Orchestrator  ─►  role agents (pi)  ─►  READY  (spec, brief, or code change)
   or a watcher        (router +          read/grep the            or
                       gatekeeper)        real repo, write      REVIEW (needs human)
                            │             PLANNING artifacts
                            ▼
                    SQLite (source of truth + work queue)
```

1. **Intake.** Drop a file into `<repo>/PLANNING/INTAKE/` (or use the UI). It can be a stack trace, a one-line request, or a research question. With autonomy on, [watchers](#autonomous-operation) also propose their own.
2. **Ingest.** The orchestrator picks it up, creates a task, infers its kind (a `.log`/traceback → `error_file`), seeds a markdown artifact in `PLANNING/REFINING/`, and commits it.
3. **Plan.** A routing template (flow) for the intake kind becomes the task's ordered list of roles. Each flow includes a **counter-reviewer** — a gate role that verifies prior output against predefined acceptance criteria — plus configurable loop-back and rigor settings.
4. **Run.** One role at a time runs as a pi agent session, in that task's own dedicated git worktree. It reads/greps the real repo (and, where permitted, edits source and runs allowlisted commands), **writes its report to the artifact as it goes**, and records a small structured trailer: verdict, summary, a **coverage** declaration (which concerns it examined vs. skipped), and any **open questions** it couldn't resolve — each with a best-effort guess and confidence, so it doesn't stall the pipeline. The commit is the run's checkpoint.
5. **Critique.** Depending on the flow's `reviewDepth` (`none` / `terminal_only` / `every_step`), a scoped adversarial **`critic`** role runs immediately after a step to check that single step's output for a domain-ending violation (PII exposure, authz bypass, irreversible data loss). Silence is the expected outcome. Its verdict folds into the step's effective verdict (never silently downgraded) and is stored as its own `role_runs` row (`run_kind: "critique"`).
6. **Gate.** After each role the orchestrator decides: keep refining, escalate to **REVIEW**, or exit to **READY** once the terminal role runs. Unmet "must" criteria loop back to the responsible role (up to `maxLoopbacks` times); evidence criteria are checked against harness-recorded command results rather than the model's claims; and a counter-reviewer whose own run came back degraded fails its gate regardless of what it concluded. Spec tasks spawn an epic→story→task child tree.

State lives in SQLite (the authoritative work queue); the `PLANNING/` tree mirrors it on disk so the refinement history is version-controlled and PR-able.

### Per-task git worktrees & concurrency

Every task runs against its **own git worktree and branch** (`<repo>/.orchestra-worktrees/<taskId>`, off the project's base branch), created the first time the task touches the repo. This means:

- **Tasks run concurrently** — the scheduler dispatches up to `maxConcurrentTasks` (default `3`) tasks' next role-step per round, each isolated in its own worktree. A single task is still sequential against itself (a restore or answer-reincorporation can never race that task's own in-flight step) — only *distinct* tasks overlap.
- **Every completed role run leaves a checkpoint** — its post-commit SHA. `POST /api/tasks/:id/restore` (or the Task Detail role-run history) rolls a task back to right after any of its own prior roles, discarding everything after it.
- **Branches reconcile once, on completion** — nothing is merged into your base branch mid-refinement. A task that wrote real source code doesn't auto-merge at all; it waits at the [merge gate](#writing--running-code).
- **Worktrees are disk-cleaned on delete/reset; branches aren't** — a worktree is silently recreated the next time a task needs one (including after a restore), so no state is lost, just the checkout.

### Reliability on local models

Local low-context models are bad at precisely what a multi-role pipeline used to demand: one long, perfect JSON blob at the end of a run, reliable custom tool calls, and an unbounded transcript. Orchestra is built around those failure modes.

- **Artifact-first output** — a role's write-up is appended to the task artifact *as it is produced*, so a failed or truncated structured payload costs the ~4-field verdict trailer, never the analysis.
- **A verdict delivery ladder** — constrained decoding (`json_schema` / `guided_json` / GBNF, probed per endpoint) → `record_findings` tool call → trailing JSON fence → one cheap repair call that reconstructs the trailer from work already produced → synthesized fallback. The rung that worked is recorded as `verdict_source`.
- **Repair and resume, not rerun** — an interrupted run resumes from durable state with a digest instead of paying full price again (`attempt`, `resumed_from`).
- **Run health** — every run is classified `verified` / `healthy` / `recovered` / `degraded` / `empty`, badged in the UI, aggregated per model×role×mode, and fed into the gates: a degraded counter-reviewer always fails its gate, and `requireHealthyTerminal` extends that distrust to the terminal step. A red test suite is *not* bad health: the run worked, it just reported bad news.
- **Context budgeting** — a per-run token ledger with priority-tiered degradation, rolling digests, and explicit step-to-step carry-forward, so long chains fit 8k–32k windows by construction. Ships in shadow mode (measures without trimming) until a project opts in.
- **Measured model profiles** — `textMode`, `twoPhase` and compat quirks stop being hand-tuned. A ~20-request probe suite measures what an endpoint can actually do, derives a run shape and verdict delivery mechanism, and keeps recalibrating from live runs (with hysteresis, so nothing flaps).

**[Full reference →](https://ubcs-io.github.io/orchestra/reference/reliability)**

### Intake kinds & exit shapes

Ten intake kinds are supported, each with a dedicated flow:

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

Three exit shapes:

- **spec** → ends in `decomposition` → an actionable task tree.
- **research_brief** → ends in `research_synthesis` → a decision brief.
- **code_change** → ends in `critic` → an implemented change parked for merge review. Not reachable from an intake kind directly: a task gets there as an `execution_ready` decomposition leaf, or via the **XS fast path** when `explorer` sizes the work as trivial and skips the remaining planning roles.

### Live visibility & steering

- **Live pane** — Server-Sent Events stream the active role's reasoning and every file it reads, in real time, as structured typed events (role/tool boundaries, thinking, text, status) with inline markdown highlighting — not just a raw log.
- **Coverage map** — each role declares which concerns (correctness, security, privacy, performance, accessibility, edge-cases, tests, dependencies, data, ux, docs) it examined, skipped, or ignored, so *omissions are visible* (you can see privacy was never looked at).
- **Steering** — per task you can pause/resume, re-run or **deepen** a role, **inject** a one-off role mid-plan, add a steer note / pin a question, **reset** a task to intake, **restore** it to any of its own prior checkpoints, create child **subtasks**, mark a task **won't do**, override its **autonomy level** or **planning rigor**, or **promote** an injected role into standing project policy.
- **Open questions & answer reincorporation** — a role can record open questions with its own best-effort guess instead of stalling. Answer one later (even after the task reaches REVIEW) and, if the `answerReincorporation` advisor is enabled, a genuinely contradicting answer automatically restores the task to that role's checkpoint and re-runs downstream work with the correction.
- **Review CTA & question decomposition** — Task Detail distills a review call-to-action from the artifact's action items, coverage gaps, and open questions; any question can be spun off with one click into its own child **Question Flow** subtask, which gets a full task page (and can recursively decompose its own questions) plus an inline chat box on the parent.

![Interactive live view — SSE role/tool stream, current state, steering, and coverage map](docs/public/screenshots/interactive-live-view.png)

### Writing & running code

By default every role is read-only against the target repo — only `PLANNING/` artifacts are ever written. A project can opt into two further capabilities, independently, both off by default and both configured from the **Roles Editor** (`GET`/`PATCH /api/projects/:id/harness-policy`):

- **`allowWrite`** — until it's on, `write`/`edit` can't be added to any role's tool list, even by editing `tools_json` directly. Once on, those tools stay jailed inside the task's own disposable worktree.
- **`allowExec`** — enables `run_command`, restricted to a **named allowlist**: the model picks a name from your menu (`test`, `typecheck`, `lint`) and the fixed `argv` behind it is what runs. Extra arguments are opt-in per command and regex-validated, never interpolated. Per-command timeouts, output caps, and a per-run execution cap all apply. This is a strictly bigger trust decision than write: the worktree is a jail for *file writes*, not a sandbox for a spawned process.

On top of those:

- **Evidence, not opinion** — every execution is recorded by the harness (exit code, timing, capped output). Where the allowlist defines `test` or `typecheck`, matching acceptance criteria are attached automatically and must exit 0 — and a project without those commands never fails a gate for not running them.
- **`developer` role** — the seeded target for the opt-in (no tools by default). It's wired into the **execution flow** (`developer` → `critic`), which is what an `execution_ready` decomposition leaf or an XS-sized task routes to. Adding a flow that writes code still requires you to grant the tools.
- **Autonomy levels** — `plan` (never write code), `edit` (write, then always park for human merge approval — the default), or `auto` (write, and merge once the task's own checks pass). Project default plus a per-task override.
- **The merge gate** — at `plan`/`edit`, a task that wrote source lands at `needs_merge_approval` with its branch intact; `approve_merge` lands it, `request_changes` sends it back. At `auto`, the orchestrator attempts the merge itself and falls back to the human gate on any conflict.
- **Visibility** — the Settings safety dashboard shows which projects have write/exec enabled, which roles hold those tools, and whether source-code writes are possible at all.

**[Full guide →](https://ubcs-io.github.io/orchestra/guide/execution)**

### Autonomous operation

Orchestra can generate its own work. **Watchers** scan a project on their own loop during idle windows, propose candidates, triage them, and — under hard caps — turn survivors into ordinary tasks. Off by default, per project.

- **Six watchers** — `test-suite` (proposes a fix only when the same failure appears twice), `todo-scan` (markers older than a threshold, by `git blame`), `branch-triage` (quiet unmerged branches — asks a question, never deletes), `doc-drift` (docs referencing symbols that no longer exist), `lint-drift` (only when the problem count *grows*), and `dep-staleness` (the only one that reaches the package registry). Only `test-suite` ships enabled.
- **Scans never touch your checkout** — a dedicated scan worktree is prepared at most once per project per round.
- **Candidates, not tasks** — each observation is fingerprinted and recorded first. A duplicate fingerprint is dropped on sight, and closing a watcher task as won't-do suppresses that fingerprint permanently, with recent suppressions fed back into triage. Triage itself is an off-by-default advisor that fails toward *not* queuing.
- **Hard caps** — max open auto-tasks, per-watcher daily caps, and per-idle-window budgets for task starts, tokens, and command executions. A project is idle after N minutes of no human API activity; human work always preempts, and the kill switch aborts an in-progress scan within one tick.
- **The morning report** — a deterministic rollup (computed from what happened, never generated by a model) splitting the night into *completed* (terminal **and** trusted health), *parked*, and *in progress*, with health counts, per-watcher activity, budget status, and how many self-generated tasks you haven't opened.
- **Self-maintenance** — in the same idle window, Orchestra probes models that have no capability profile yet and backfills missing context digests.

**[Full guide →](https://ubcs-io.github.io/orchestra/guide/autonomy)**

### Spend ceilings

Token and cost data was always recorded per run; nothing ever compared it against a limit. A project can now set a **rolling-window spend ceiling** (`GET`/`PATCH /api/projects/:id/budget`) — off by default, like every other policy gate here.

- **Token cap, dollar cap, or both.** The token cap is fully enforceable with no pricing data at all, so a project pointed entirely at local models is still protected. Enabling the budget with neither cap set is rejected — a policy that reads as "budgeted" while stopping nothing is worse than one that's plainly off.
- **The in-flight step always finishes.** The check runs at task-selection time and blocks the *next* dispatch, matching the existing pause/resume semantics rather than inventing a mid-run abort.
- **`budget_paused_at`, not `paused`.** "I paused this" and "the budget stopped this" stay tellable apart — and the budget flag clears itself once spend ages out of the window or you raise the cap.
- **Overriding is deliberate.** The `resume_over_budget` intervention is logged like any other steering action and bounded to `overrideMinutes`, per task. Never an auto-continue.
- **Dollar figures say what they are.** `role_runs.tokens` is one combined input+output count, so conversion assumes a 15% output share; runs on unpriced models contribute tokens but no dollars. That renders as `≥ $X` with the unpriced remainder named — a floor, never a silently under-reported total.

### Secrets at rest

GitHub PATs and model API keys are encrypted in SQLite with **AES-256-GCM** (Node built-ins, no new dependency), decrypted only at point of use. Previously they were plain TEXT columns masked on the API response — response hygiene, not storage security.

The key comes from `ORCHESTRA_SECRET_KEY`, or is generated on first boot into a gitignored `secret.key` beside `config.json`. Existing plaintext rows are upgraded transparently and idempotently on boot; a secret that can't be read logs and reads as "not set" rather than taking the boot path down. **Losing the key means re-entering your tokens** — nothing else breaks, and that trade is stated wherever it matters rather than left as a silent trap.

No role ever receives a secret in its run context; the PAT is used server-side for pushes and PRs *you* trigger. `harness.secretScope` makes that default explicit and enforced instead of incidental. The safety dashboard reports which secrets exist and how old they are — never a value — with a one-click clear.

### Role versioning & outcome scoring

Editing a role's prompt used to overwrite it in place, with no history and no way to tell whether the edit helped. Now every change to a role's **prompt, tools, or model** records a version, and every run is stamped with the version that produced it.

- **Dispatch is unchanged** — the live `roles` row is still what runs. This is a paper trail behind it.
- **Scores are per version, not per lifetime.** `getRoleStats` aggregates across all time, mixing every prompt a role ever had into one number. Grouping by version is the whole difference: pass rate, loopback rate, critique-flag rate, human-override rate, and degraded rate, each over that version's own runs.
- **Revert is non-destructive** — it records a *new* version matching the old one, leaving the versions in between with their scores intact. "We tried that and it was worse" is information.
- **It refuses to overclaim.** Below five runs a version is labelled *underpowered*, not bad; a version that changed prompt and model at once is badged as a *mixed edit*, because its score can't be attributed to either.

### GitHub — inline diff review, push, and PR

- **Inline diff panel** — Task Detail's "review branch" pill opens a file-level diff of the task's branch against its base (`GET /api/tasks/:id/diff`, matching GitHub's PR "compare" semantics), with unified per-file patches fetched lazily. `GET /api/tasks/:id/runs/:runId/diff` scopes the same view to a single role run.
- **Push & open PR** — with a GitHub token configured, push the branch (`POST /api/tasks/:id/github/push`) or push-and-open a PR against the task's base branch (`POST /api/tasks/:id/github/pr`); the PR URL is stored on the task.
- **Per-project GitHub config** — set via the **GitHub bubble** on the Projects page: a repo-scoped PAT (write-only once saved — never echoed back, and [encrypted at rest](#secrets-at-rest)) and an optional `owner/repo` override. Falls back to a shared `githubToken` / `ORCHESTRA_GITHUB_TOKEN`.

### Agent Networks

Beyond the built-in flow templates, you can author custom **agent networks** — visual graphs that define how the orchestrator routes work through role agents, replacing a flow's ordered list with a directed graph of nodes and edges.

- **Visual editor** at `/networks` — drag roles from the palette onto a React Flow canvas, connect them, and set per-network metadata (intake kind, rigor, max loopbacks, reviewer role, `reviewDepth`).
- **Built-in system templates** for common intake kinds, read-only; duplicate one to customize it.
- **Custom networks** can be set as the **default** for an intake kind, at which point the orchestrator uses them instead of the built-in flow.
- **Import / export** as JSON, portable across projects and instances.

![Agent network editor — drag-and-drop role graph with edge conditions and per-role tool boundaries](docs/public/screenshots/network-view.png)

### Model dashboard, capability probes & network ping

The **`/models`** page manages named model configs — reusable endpoint + model profiles (base URL, model ID, context/max-tokens, reasoning/thinking settings) that a project or role can opt into by name, independent of the global connection profile. From this page you can:

- **Compare models** — a radar chart and sortable stats table across context window, max tokens, reasoning, quantization score, effective parameter count, and historical usage pulled from actual role-run history.
- **Probe capabilities** — run the behavioral probe suite over SSE and let Orchestra derive the run shape and verdict delivery mechanism itself, with per-field overrides if you disagree.
- **Reorder, duplicate, set default** — drag-and-drop cards to set priority, duplicate a config, or promote one to global default.
- **Ping Network** — check live connectivity to every configured endpoint over an SSE stream, streaming `checking → ok/down` with a running "N/M available" count.

![Coverage radar and model comparison table across context window, params, quantization, and usage](docs/public/screenshots/model-radar.png)

### Strategic LLM routing advisors (experimental)

Beyond the deterministic router, `server/src/router.ts` provides six **optional, narrowly-scoped advisory LLM calls** at decision points where heuristics are weakest. Each is independently toggleable, off by default, hard-timeout-bounded, and falls back to the heuristic on failure — the orchestrator always owns the final decision:

1. **Question distillation** — distill and de-duplicate a role's open questions.
2. **Escalation assessment** — before escalating to human REVIEW: `escalate` / `reroute` / `rerun` / `close`.
3. **Borderline gate assessment** — for partial-criteria or near-loopback-exhaustion decisions.
4. **Second review** — synthesize a primary run and its critique into `accept` / `accept_with_note` / `escalate` / `loopback`, so a critic false-positive can be overturned.
5. **Answer match assessment** — compare a human's answer to a role's recorded guess; `contradicts` restores the task to that checkpoint and re-runs downstream steps.
6. **Candidate triage** — whether a watcher candidate is worth doing, at what priority, as which kind. Disabled means *nothing is queued* — this one fails toward silence, not auto-approval.

### Portable role contract (MCP)

An opt-in, **read-only** MCP server (`npm --workspace server run start:mcp`) exposes the role contract to agents outside pi. `get_task_context` returns the role that would run next (resolved with the same functions the real dispatcher uses), its prompt, the task's criteria, artifact, coverage map, and open questions; `list_candidates` exposes the watcher queue. It's a separate stdio process, never spawned by the daemon, sharing the same SQLite file. Claim/close tools are a later slice.

---

## Quick start

Requires **Node 20+** and a git repo to point at. An OpenAI-compatible LLM endpoint (Ollama, LM Studio, vLLM, OpenWebUI, …) is needed for roles to actually run.

The repo path you provide when registering a project must be an **absolute path** to a git repository. You can give the repository root, any subdirectory inside it, or even the `.git` directory itself — Orchestra resolves it to the canonical working-tree root automatically. Dragging a folder from Finder (a `file://` URL) or pasting percent-encoded paths is supported transparently.

```bash
npm install                          # installs the server + client workspaces
cp config.example.json config.json   # then set providerBaseUrl / apiKey / defaultModelId
npm run dev                          # Fastify daemon :5001 + Vite dev client :5173
```

Open the client (dev: http://localhost:5173, which proxies `/api` to the daemon). Register a repo, drop an intake, press **Start loop**.

Production-style (single process serves the built SPA + API):

```bash
npm run build      # builds client into server/public, compiles server to server/dist
npm start          # node server/dist/main.js on :5001
```

Other scripts: `npm run typecheck` (both workspaces), `npm run test` / `npm run test:watch` / `npm run test:coverage` (server tests via Vitest), `npm run docs:dev` (the documentation site).

---

## Configuration

Orchestra has three configuration layers:

1. **Bootstrap config** (`config.json` + `ORCHESTRA_*` env vars) — the static seed used on first boot.
2. **Runtime-editable connection profiles** — stored in SQLite, editable via `PATCH /api/config` and the Settings UI. These take precedence over the bootstrap config, except for `baseUrl` and `apiKey` where env vars always win (so credentials can stay out of the database).
3. **Per-project settings** — five independent sub-keys on the project row: `harness` (write/exec policy), `autonomy` (watcher scheduling), `autonomyLevel` (`plan`/`edit`/`auto`), `planningRigor` (`minimal`/`standard`/`thorough`), and `router` (the advisors above). Each has its own validated endpoint.

Resolution order (lowest → highest precedence): built-in defaults → `config.json` (repo root, gitignored) → DB global profile → DB project override → `ORCHESTRA_*` environment variables.

The most commonly changed bootstrap keys:

| `config.json` key | Env var | Default | Meaning |
|---|---|---|---|
| `providerBaseUrl` | `ORCHESTRA_BASE_URL` | `http://192.168.1.2:8080/v1` | OpenAI-compatible **base** URL (not the `/chat/completions` path). |
| `apiKey` | `ORCHESTRA_API_KEY` | `""` | Bearer token; empty if the endpoint has no auth. |
| `defaultModelId` | `ORCHESTRA_MODEL` | `deepseek-r1:latest` | Model used when a project/role doesn't override. |
| `contextWindow` / `maxTokens` | `ORCHESTRA_MAX_TOKENS` | `128000` / `32768` | Advertised to pi for the local model. |
| `maxConcurrentTasks` | `ORCHESTRA_MAX_CONCURRENT_TASKS` | `3` | Max tasks the scheduler runs role-steps for concurrently. |
| `port` / `host` | `ORCHESTRA_PORT` / `ORCHESTRA_HOST` | `5001` / `0.0.0.0` | HTTP bind (UI + API + SSE). |
| `githubToken` | `ORCHESTRA_GITHUB_TOKEN` | `""` | Fallback PAT for pushing branches / opening PRs. |
| — | `ORCHESTRA_TOKENS` | `{}` | Per-model-config API keys as JSON keyed by config name, so secrets stay out of the DB. |

**[Full configuration reference →](https://ubcs-io.github.io/orchestra/reference/config)** — every key, the runtime profile fields, model configs, per-project policy, and the routing advisors.

> **Prefer a tool-capable model.** Roles use pi's function-calling to read the repo and record findings. A model without tool support falls back to reasoning over pre-packed context. Rather than hand-tuning `textMode`/`twoPhase` for such a model, probe it and let the [capability profile](https://ubcs-io.github.io/orchestra/reference/reliability) pick.

---

## Architecture

One Node process is the whole app — **the server *is* the daemon**. `server/main.ts` boots the DB, seeds the role catalog and connection profile, serves the REST + SSE API and the built client, and starts two independent in-process loops: the orchestrator scheduler and the watcher loop. No external broker, queue, or cron: **SQLite is the durable work queue**. It's crash-safe — restart and it resumes in-flight tasks from the DB (worktrees are recreated on demand if missing). A second, optional stdio process serves MCP and only ever reads.

- **Backend:** Fastify (REST + SSE), better-sqlite3 (WAL), pi (`@earendil-works/pi-*`) for provider-agnostic, repo-aware agents, `@modelcontextprotocol/sdk` for the MCP surface.
- **Frontend:** Vite + React SPA, TanStack Router + TanStack Query, native `EventSource` for the live stream.

### Project layout

```
server/                one Node daemon (we own main())
  src/main.ts          boots Fastify + orchestrator loop + watcher loop + pi
  src/mcp-server.ts    separate opt-in stdio MCP process (read-only)
  src/mcp-context.ts   task role-execution context for external agents
  src/config.ts        typed bootstrap config (defaults → config.json → env)
  src/settings.ts      runtime-editable connection profiles (DB-backed, inheritable per project)
  src/db.ts            better-sqlite3 schema + CRUD (idempotent, WAL)
  src/providers.ts     pi provider registration + model discovery
  src/agent.ts         runRole(): one pi agent session per role (run shapes, verdict ladder, think splitting)
  src/roles.ts         role catalog (25 roles), flow templates, acceptance criteria, seed data
  src/orchestrator.ts  ingest → plan → run → critique → gate + scheduler + loop-back
  src/router.ts        strategic LLM routing advisors (six call points)
  src/harness-policy.ts per-project write/exec policy + tools_json validation
  src/exec.ts          allowlisted, worktree-scoped command runner + evidence records
  src/health.ts        run-health taxonomy (verified/healthy/recovered/degraded/empty)
  src/probe.ts         endpoint constrained-decoding probing
  src/structured.ts    constrained completions outside the pi session
  src/gbnf.ts          JSON-schema → GBNF grammar compiler
  src/profiles.ts      measured model capability profiles + live calibration
  src/context-budget.ts token ledger, tiered degradation, rolling digests
  src/watchers.ts      watcher loop, triage, candidate queueing
  src/watcher-scans.ts the individual watcher scans + scan worktree
  src/autonomy.ts      autonomy config, active hours, idle-window budgets
  src/autonomy-level.ts plan/edit/auto resolution
  src/planning-rigor.ts minimal/standard/thorough resolution
  src/morning-report.ts deterministic overnight rollup
  src/self-maintenance.ts idle-time model probing + digest backfill
  src/git.ts           PLANNING scaffold + sandboxed artifact writes/commits + per-task worktrees + reconciliation + diffing
  src/github.ts        GitHub REST glue: push a task branch, open a PR
  src/bus.ts           in-process pub/sub for the SSE stream
  src/routes/          Fastify REST (api.ts) + SSE (sse.ts) + safety controls (safety.ts)
  test/                Vitest suite (agent, autonomy, context-budget, db, exec, gbnf, git, harness-policy,
                       health, mcp, morning-report, orchestrator, planning-rigor, probe, profiles, roles,
                       router, self-maintenance, settings, structured, watchers, watcher-scans)
client/                Vite + React SPA
  src/routes/          Projects, ProjectBoard (kanban), TaskDetail, RolesEditor, Settings, Models, NetworkEditor
  src/components/      ReviewCTA, QuestionDecompose, DiffPanel, EvidencePanel, HealthBadge, SignalsPanel,
                       MorningReportPanel, WorktreeKanban, WorktreeDetailPane, FileTree, NetworkNodeCard,
                       GitHubBubble, ModelBubble, MiniRadarChart, CollapsibleCard
  src/api.ts           typed API client
```

### The `PLANNING/` tree (created per project)

```
<repo>/PLANNING/
  INTAKE/     drop raw intakes / error files here
  REFINING/   in-flight artifacts (one .md per task, growing per role)
  READY/      exit_state = ready_for_work
  REVIEW/     exit_state = needs_review (awaiting a human)
  epics/      epic/story/task decomposition output
```

---

## Roles

25 roles are seeded as global defaults and are **customizable per project** (edit prompt, tools, model, enable/disable — a project override wins by key). Each flow template selects a subset and order per intake kind, with a counter-reviewer gating before the terminal role, and a cross-cutting `critic` that can run after any non-terminal step depending on `reviewDepth`.

- **Spec track** — `intake_triage`, `explorer` (which also sizes the work XS–XL), `bug_investigator`, `requirements_analyst`, `architecture_review`, `security_review`, `privacy_review`, `performance_review`, `api_design`, `data_schema_review`, `style_conventions`, `test_strategy`, `dependency_integration`, `decomposition` *(terminal)*, and `developer` *(execution flow)*.
- **Research / UX track** — `ux_review`, `user_research`, `options_exploration`, `edge_case_analysis`, `research_synthesis` *(terminal)*.
- **Counter-reviewers** — `bug_review`, `security_review_adversary`, `spec_review`, `brief_review`. Each verifies prior output against predefined acceptance criteria; an unmet "must" loops back to the responsible role, and exhausting `maxLoopbacks` escalates to REVIEW.
- **Cross-cutting** — `critic`, scoped to a single step's output with a deliberately extreme bar. `every_step` for the `security` and `feature` flows, `terminal_only` for the rest.

Tool sets are read-only (`read`, `grep`, `find`, `ls`), read + `git_history`, or context-only — plus the opt-in `write`/`edit` and `run_command`, which no role holds by default.

**[Full roles catalog →](https://ubcs-io.github.io/orchestra/reference/roles)**

---

## API

REST is served under `/api`; live streams are SSE. Safety/dev controls are under `/api/safety`. Roughly ninety endpoints cover projects, tasks, interventions, networks, model configs and profiles, harness policy, autonomy and budgets, candidates, the morning report, diffs, and GitHub push/PR.

**[Full API reference →](https://ubcs-io.github.io/orchestra/reference/api)**

---

## Deployment (headless / tailnet)

The single process is designed to run on a headless box under **systemd** (or pm2/Docker with a restart policy), bound to the tailnet interface; other clients reach the UI/API/SSE over Tailscale. Multiple clients can watch and steer the same task concurrently, and SSE fans live progress to every viewer.

> **There is no auth — the network is the entire trust boundary.** Anyone who can reach the port can register projects, run roles against your repositories, and (where enabled) trigger source edits and allowlisted command execution on the host. GitHub PATs and model API keys are now encrypted at rest (AES-256-GCM), but the key lives beside the database under the same trust tier — that protects a *leaked database file*, not a reachable port. Bind to a private interface.

---

## Status

Alpha, and developed in phases. **Reliability:** artifact-first output, constrained decoding with per-endpoint probing, repair-and-resume, and health-aware gating. **Trust:** an allowlisted command runner producing harness-recorded evidence, and measured capability profiles replacing hand-tuned compat flags. **Autonomy:** context budgeting for small windows, plus watchers, budgets, and the morning report. **Transport:** a read-only MCP surface. All of that is implemented and typechecks/builds on top of the original pipeline — ingest, planning, concurrent role execution across per-task worktrees, per-step critique, counter-reviewer gating with loop-back, checkpoint restore, branch reconciliation, decomposition, artifacts/commits, SSE, runtime-editable connection profiles, named model configs, and the React UI.

Successful *LLM* refinement still depends on a reachable tool-capable endpoint (set `providerBaseUrl`). A Vitest suite of 26 files covers the agent, orchestrator, router, database, git operations, exec and evidence, health, profiles and probes, context budgeting, watchers and scans, autonomy, morning report, self-maintenance, the MCP surface, spend guardrails, secrets at rest, and role versioning.

**Operational guardrails:** per-project spend ceilings that actually stop dispatch, encryption at rest for stored tokens, and role versioning with per-version outcome scoring — see below.
