# Orchestra

**A configurable, Git-backed, code-planning refinement utility.**

Connect any git repository, drop in work that ranges from a bare error log to an open-ended research prompt, and a single orchestrator routes it through a chain of specialized "software-company role" agents — powered by [pi](https://github.com/earendil-works/pi) over any OpenAI-compatible endpoint — until it becomes **actionable**: either a decomposed **spec** (epic → story → task) or a **research brief** (approaches, trade-offs, edge cases, recommendation).

The point is **tighter control and visibility over long-running, nebulous work**. LLMs fail at big vague tasks; Orchestra breaks them into tracked steps you can *watch* live, *notice* gaps in (via a coverage map), *steer* mid-run, and *enrich* durably.

---

## How it works

```
INTAKE file / UI  ─►  Orchestrator  ─►  role agents (pi)  ─►  READY  (spec or research brief)
                       (router +          read/grep the           or
                        gatekeeper)       real repo, write     REVIEW (needs human)
                            │             PLANNING artifacts
                            ▼
                    SQLite (source of truth + work queue)
```

1. **Intake.** Drop a file into `<repo>/PLANNING/INTAKE/` (or use the UI). It can be a stack trace, a one-line request, or a research question.
2. **Ingest.** The orchestrator picks it up, creates a task, infers its kind (a `.log`/traceback → `error_file`), seeds a markdown artifact in `PLANNING/REFINING/`, and commits it.
3. **Plan.** A routing template (flow) for the intake kind becomes the task's ordered list of roles. Each flow includes a **counter-reviewer** — a gate role that verifies prior output against predefined acceptance criteria — plus configurable loop-back and rigor settings.
4. **Run.** One role at a time runs as a pi agent session: it reads/greps the real repo, then records a structured verdict + a **coverage** declaration (which concerns it examined vs. skipped) + a markdown section, which is appended to the artifact and committed (`refine(<role>): <task> — <purpose>`). Roles that support unreliable models can run in **two-phase** mode (exploration → formalization) or **text mode** (JSON output via markdown instead of native tool calls).
5. **Gate.** After each role the orchestrator decides: keep refining, escalate to **REVIEW** (an ambiguity/blocker needing a human), or, once the terminal role runs, exit to **READY**. The counter-reviewer checks criteria; unmet "must" criteria loop back to the responsible role (up to `maxLoopbacks` times). Spec tasks also spawn an epic→story→task child tree.

State lives in SQLite (the authoritative work queue); the `PLANNING/` tree mirrors it on disk so the refinement history is version-controlled and PR-able.

### Intake kinds & flow rigor

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

### Two exit shapes
- **spec** (`error_file`, `bug`, `security`, `feature`, `manual`, `chore`, `spike`) → ends in `decomposition` → an actionable task tree.
- **research_brief** (`research`, `ux`, `question`) → ends in `research_synthesis` → a decision brief.

### Live visibility & steering
- **Live pane** — Server-Sent Events stream the active role's reasoning and every file it reads, in real time.
- **Coverage map** — each role declares which concerns (correctness, security, privacy, performance, accessibility, edge-cases, tests, dependencies, data, ux, docs) it examined, skipped, or ignored, so *omissions are visible* (you can see privacy was never looked at).
- **Steering** — per task you can pause/resume, re-run or **deepen** a role, **inject** a one-off role mid-plan, add a steer note / pin a question, **reset** a task to intake, create child **subtasks**, or **promote** an injected role into standing project policy that auto-runs on future tasks.

### Agent Networks

Beyond the built-in flow templates, you can author custom **agent networks** — visual graphs that define how the orchestrator routes work through role agents. Networks replace a flow template's ordered list with a directed graph of nodes (roles) and edges (transitions), giving you full control over branching, parallelism, and gating logic.

- **Visual editor** — available at `/networks` in the UI. Drag roles from the palette onto a React Flow canvas, connect them with edges to define the work path, and set per-network metadata (intake kind, rigor level, max loopbacks, reviewer role). Nodes are positioned on a snap-to-grid canvas.
- **Built-in system templates** — Orchestra ships with pre-configured networks for common intake kinds (`bug`, `feature`, `security`, `research`, etc.). System networks are read-only; duplicate one to customize it for your project.
- **Custom networks** — create networks from scratch or duplicate and modify a system template. Custom networks are editable: add/remove roles, rewire edges, adjust rigor, and set as the **default** for an intake kind. When set as default, the orchestrator will use your custom network instead of the built-in flow for matching intakes.
- **Import / Export** — networks can be exported to and imported from JSON, making them portable across projects and Orchestra instances. Export from the canvas toolbar; import via the API (`POST /api/networks/import`).

Networks are stored in SQLite alongside projects and are resolved by intake kind: when a task enters the orchestrator, the default network for its intake kind is loaded. If no custom network is set, the built-in flow template is used as a fallback.

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

Other scripts: `npm run typecheck` (both workspaces), `npm run test` / `npm run test:watch` / `npm run test:coverage` (server tests via Vitest).

---

## Configuration

Orchestra has two configuration layers:

1. **Bootstrap config** (`config.json` + `ORCHESTRA_*` env vars) — the static seed used on first boot.
2. **Runtime-editable connection profiles** — stored in SQLite, editable via `PATCH /api/config` and the Settings UI. These take precedence over the bootstrap config, except for `baseUrl` and `apiKey` where env vars always win (so credentials can stay out of the database).

Resolution order (lowest → highest precedence): built-in defaults → `config.json` (repo root, gitignored) → DB global profile → DB project override → `ORCHESTRA_*` environment variables.

| `config.json` key | Env var | Default | Meaning |
|---|---|---|---|
| `host` | `ORCHESTRA_HOST` | `0.0.0.0` | Bind interface (0.0.0.0 so tailnet clients reach it). |
| `port` | `ORCHESTRA_PORT` | `5001` | HTTP port (UI + API + SSE). |
| `providerBaseUrl` | `ORCHESTRA_BASE_URL` | `http://192.168.1.2:8080/v1` | OpenAI-compatible **base** URL (not the `/chat/completions` path). |
| `apiKey` | `ORCHESTRA_API_KEY` | `""` | Bearer token; empty if the endpoint has no auth. |
| `defaultModelId` | `ORCHESTRA_MODEL` | `deepseek-r1:latest` | Model used when a project/role doesn't override. |
| `contextWindow` / `maxTokens` | `ORCHESTRA_MAX_TOKENS` | `128000` / `16384` | Advertised to pi for the local model. |
| `reasoning` | — | `true` | Whether the model is a reasoning model (enables pi thinking level). Set `false` for plain instruct models. |
| `thinkingLevel` | — | `medium` | pi thinking verbosity when `reasoning` is true: `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `thinkingFormat` | — | `qwen-chat-template` | pi reasoning request dialect for the endpoint. Supported: `qwen-chat-template`, `qwen`, `deepseek`, `zai`, `openai`, `openrouter`, `together`, `string-thinking`, `chat-template`, `ant-ling`. |
| `requestTimeoutMs` | `ORCHESTRA_REQUEST_TIMEOUT_MS` | `300000` | Per-request LLM timeout. |
| `dbPath` | `ORCHESTRA_DB_PATH` | `./orchestra.db` | SQLite file (WAL). |
| `schedulerIdleMs` | `ORCHESTRA_SCHEDULER_IDLE_MS` | `3000` | Idle poll interval when there's no work. |
| `roleToolBudget` | — | `40` | Max tool-calling turns per role run. |
| `clientDir` | — | `<server>/public` | Built SPA directory served in production. |

### Runtime-editable connection profiles

Beyond the bootstrap config, connection settings are stored in SQLite and editable at runtime via `PATCH /api/config` or the **Settings UI**. These take precedence over `config.json` (except for `baseUrl` and `apiKey`, where env vars always win).

| Field | Default | Description |
|---|---|---|
| `baseUrl` | (from `config.json`) | OpenAI-compatible base URL. |
| `apiKey` | (from `config.json`) | Bearer token. |
| `api` | `openai-completions` | Provider API type. |
| `defaultModelId` | (from `config.json`) | Model ID used when a project/role doesn't override. |
| `contextWindow` / `maxTokens` | (from `config.json`) | Advertised to pi for the local model. |
| `requestTimeoutMs` | (from `config.json`) | Per-request LLM timeout. |
| `reasoning` | (from `config.json`) | Whether the model is a reasoning model. |
| `thinkingLevel` | (from `config.json`) | pi thinking verbosity (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`). |
| `thinkingFormat` | (from `config.json`) | pi reasoning request dialect (e.g. `qwen-chat-template`, `deepseek`, `openai`). |
| `textMode` | `false` | Bypass native tool calls; model outputs structured JSON via markdown instead. |
| `twoPhase` | `false` | Split run into exploration (no tool-calling) + formalization phases. Supersedes `textMode`. Useful when a model's native function calling (`record_findings`) is unreliable. |

> **Prefer a tool-capable model.** Roles use pi's function-calling to read the repo and to record findings. A model without tool support falls back to reasoning over pre-packed context. For unreliable tool-calling models, enable `twoPhase` mode above.

---

## Architecture

One Node process is the whole app — **the server *is* the daemon**. `server/main.ts` boots the DB, seeds the role catalog and connection profile, serves the REST + SSE API and the built client, and starts the orchestrator loop, all in-process. No external broker, queue, or cron: **SQLite is the durable work queue**, and the scheduler is a single re-entrant, mutex-serialized async loop (strict single-worker sequential). It's crash-safe — restart and it resumes in-flight tasks from the DB.

- **Backend:** Fastify (REST + SSE), better-sqlite3 (WAL), pi (`@earendil-works/pi-*`) for provider-agnostic, repo-aware agents.
- **Frontend:** Vite + React SPA, TanStack Router + TanStack Query, native `EventSource` for the live stream.

### Project layout

```
server/                one Node daemon (we own main())
  src/main.ts          boots Fastify + orchestrator loop + pi
  src/config.ts        typed bootstrap config (defaults → config.json → env)
  src/settings.ts      runtime-editable connection profiles (DB-backed, inheritable per project)
  src/db.ts            better-sqlite3 schema + CRUD (idempotent, WAL)
  src/providers.ts     pi provider registration + model discovery
  src/agent.ts         runRole(): one pi agent session per role (text mode, two-phase, think splitting)
  src/roles.ts         role catalog (23 roles), flow templates, acceptance criteria, seed data
  src/orchestrator.ts  ingest → plan → run → gate + scheduler + loop-back
  src/git.ts           PLANNING scaffold + sandboxed artifact writes + commits
  src/bus.ts           in-process pub/sub for the SSE stream
  src/routes/          Fastify REST (api.ts) + SSE (sse.ts) + safety controls (safety.ts)
  test/                Vitest test suite (agent, db, git, orchestrator, roles)
client/                Vite + React SPA
  src/routes/          Projects, ProjectBoard (kanban), TaskDetail, RolesEditor, Settings
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

23 roles are seeded as global defaults and are **customizable per project** (edit prompt, tools, model, enable/disable — a project override wins by key). Each flow template selects a subset and order per intake kind, with a counter-reviewer gating before the terminal role.

### Spec-track roles

| Key | Title | Tools | Applies to |
|---|---|---|---|
| `intake_triage` | Intake Triage (Product Owner / BA) | read-only | all |
| `explorer` | Explorer (Staff Engineer / Onboarding) | read-only | all |
| `bug_investigator` | Bug Investigator (SRE / Debugging) | read + git_history | bug, error_file |
| `requirements_analyst` | Requirements Analyst (Product Manager) | none (context-only) | feature, manual, chore |
| `architecture_review` | Architecture Review (Software Architect) | read-only | feature, bug, error_file, manual, spike, security |
| `security_review` | Security Review (AppSec Engineer) | read + git_history | feature, bug, security |
| `privacy_review` | Privacy Review (Privacy Engineer) | read-only | feature, bug, security *(included in security flow; promotable in others)* |
| `performance_review` | Performance Review (Performance Engineer) | read-only | feature, bug |
| `api_design` | API Design (API Designer / Tech Lead) | read-only | feature |
| `data_schema_review` | Data & Schema Review (Data Engineer / DBA) | read-only | feature, bug |
| `style_conventions` | Style & Conventions (Code Reviewer) | read-only | chore, feature |
| `test_strategy` | Test Strategy (QA / SDET) | read-only | feature, bug, error_file, manual, chore, security |
| `dependency_integration` | Dependency & Integration (Build / DevEx) | read-only | feature |
| `decomposition` | Decomposition (Tech Lead / Scrum Master) | read-only | all spec kinds *(terminal role)* |

### Research/UX-track roles

| Key | Title | Tools | Applies to |
|---|---|---|---|
| `ux_review` | UX Review (Product Designer) | read-only | ux |
| `user_research` | User Research (UX Researcher) | none (context-only) | ux, research |
| `options_exploration` | Options Exploration (Staff Engineer / Design Lead) | read-only | research, ux, spike, question |
| `edge_case_analysis` | Edge Case Analysis (QA / Design) | read-only | research, ux, feature |
| `research_synthesis` | Research Synthesis (Tech Lead) | none (context-only) | research, ux, question *(terminal role)* |

### Counter-reviewers (gate roles)

| Key | Title | Tools | Gates |
|---|---|---|---|
| `bug_review` | Bug Review (Verification Engineer) | read + git_history | bug, error_file |
| `security_review_adversary` | Adversarial Security Review (Red Team) | read + git_history | security |
| `spec_review` | Spec Review (Verification Tech Lead) | read-only | feature, manual, chore, spike |
| `brief_review` | Brief Review (Verification Lead) | none (context-only) | research, ux, question |

Counter-reviewers verify prior output against predefined acceptance criteria. If a "must" criterion is unmet, the orchestrator loops back to the responsible role (up to `maxLoopbacks` times). If still unmet after max attempts, the task escalates to **REVIEW** for a human.

---

## API

REST is served under `/api`; the live stream is SSE. Safety/dev controls are under `/api/safety`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness. |
| GET | `/api/models` | Discover model IDs from the connected endpoint's `/models` route. |
| GET | `/api/concerns` | The concern taxonomy (coverage map dimensions). |
| GET | `/api/flows` | Flow templates per intake kind (steps, criteria, rigor). |
| GET · PATCH | `/api/config` | Global connection profile (read/edit base URL, model, reasoning, thinking, text/two-phase mode). |
| GET | `/api/scheduler` · POST `/api/scheduler/{start,stop}` · POST `/api/tick` | Loop control / manual single step. |
| GET · POST | `/api/projects` · GET · PATCH · DELETE `/api/projects/:id` | Projects. |
| GET | `/api/projects/:id/roles` · PUT `/api/projects/:id/roles/:key` | Per-project role config (prompt, tools, model, enabled). |
| POST | `/api/projects/:id/intake` | Submit an intake (writes into `INTAKE/`). |
| POST | `/api/tasks` | Create a manual task (without a repo file). |
| GET | `/api/networks` | List all networks (system + custom). |
| POST | `/api/networks` | Create a custom network. |
| GET | `/api/networks/:id` | Get a single network. |
| PATCH | `/api/networks/:id` | Update a custom network. |
| DELETE | `/api/networks/:id` | Delete a custom network. |
| POST | `/api/networks/:id/duplicate` | Duplicate a network (custom or system). |
| POST | `/api/networks/default/:intakeKind` | Set a network as default for an intake kind. |
| POST | `/api/networks/import` | Import a network from JSON. |
| GET | `/api/networks/export/:id` | Export a network as JSON. |
| POST | `/api/networks/:id/reset` | Reset a custom network to its original. |
| GET | `/api/tasks` · GET · DELETE `/api/tasks/:id` | Tasks + full detail (runs, coverage, plan, children, flow). |
| PATCH | `/api/tasks/:id` | Edit a task's name/content while in intake stage. |
| POST | `/api/tasks/:id/reset` | Reset a task to intake state (clears history). |
| POST | `/api/tasks/:id/subtasks` | Create a child task under a parent. |
| POST | `/api/tasks/:id/interventions` | Steering: `pause`/`resume`/`rerun_role`/`deepen`/`inject_role`/`steer_note`/`pin_question`/`promote_role`/`run_now`. |
| GET | `/api/tasks/:id/stream` | SSE: live role/tool/text events. |
| GET · PATCH | `/api/safety` | Safety/pi dev controls (read agent boundaries, limits, gates, role summary; edit `role_tool_budget`). |

---

## Deployment (headless / tailnet)

The single process is designed to run on a headless box under **systemd** (or pm2/Docker with a restart policy), bound to the tailnet interface; other clients reach the UI/API/SSE over Tailscale. There is **no auth** — the tailnet is the trust boundary. Multiple clients can watch and steer the same task concurrently; steering actions are POSTs, execution is serialized by the single worker, and SSE fans live progress to every viewer.

---

## Status

The full pipeline — ingest, planning, role execution (including two-phase and text mode for unreliable tool-calling models), gating with counter-reviewers and loop-back, coverage rollup, decomposition, artifacts/commits, SSE, runtime-editable connection profiles, and the React UI — is implemented and typechecks/builds. Successful *LLM* refinement depends on a reachable tool-capable endpoint (set `providerBaseUrl`). A Vitest test suite covers the agent (think splitting, stall detection, text-mode extraction), orchestrator (plan mutation, gating, loop-back, interventions), database, git operations, and roles.