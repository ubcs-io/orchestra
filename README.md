# Orchestra

**A repo-aware, steerable code-planning refinement loop.**

Connect any git repository, drop in work that ranges from a bare error log to an open-ended research prompt, and a single orchestrator routes it through a chain of specialized "software-company role" agents — powered by [pi](https://github.com/earendil-works/pi) over any OpenAI-compatible endpoint — until it becomes **actionable**: either a decomposed **spec** (epic → story → task) or a **research brief** (approaches, trade-offs, edge cases, recommendation).

The point is **tighter control and visibility over long-running, nebulous work**. LLMs fail at big vague tasks; Orchestra breaks them into tracked steps you can *watch* live, *notice* gaps in (via a coverage map), *steer* mid-run, and *enrich* durably.

> Full design rationale lives in [PLANNING/refinement-loop-plan.md](PLANNING/refinement-loop-plan.md).

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
3. **Plan.** A routing template for the intake kind becomes the task's ordered list of roles.
4. **Run.** One role at a time runs as a pi agent session: it reads/greps the real repo, then records a structured verdict + a **coverage** declaration (which concerns it examined vs. skipped) + a markdown section, which is appended to the artifact and committed (`refine(<role>): <task> — <purpose>`).
5. **Gate.** After each role the orchestrator decides: keep refining, escalate to **REVIEW** (an ambiguity/blocker needing a human), or, once the terminal role runs, exit to **READY**. Spec tasks also spawn an epic→story→task child tree.

State lives in SQLite (the authoritative work queue); the `PLANNING/` tree mirrors it on disk so the refinement history is version-controlled and PR-able.

### Two exit shapes
- **spec** (`error_file`, `bug`, `feature`, `chore`, `spike`, `manual`) → ends in `decomposition` → an actionable task tree.
- **research_brief** (`research`, `ux`, `question`) → ends in `research_synthesis` → a decision brief.

### Live visibility & steering
- **Live pane** — Server-Sent Events stream the active role's reasoning and every file it reads, in real time.
- **Coverage map** — each role declares which concerns (security, privacy, performance, a11y, edge-cases, …) it examined, skipped, or ignored, so *omissions are visible* (you can see privacy was never looked at).
- **Steering** — per task you can pause/resume, re-run or **deepen** a role, **inject** a one-off role mid-plan, add a steer note / pin a question, or **promote** an injected role into standing project policy that auto-runs on future tasks.

---

## Quick start

Requires **Node 20+** and a git repo to point at. An OpenAI-compatible LLM endpoint (Ollama, LM Studio, vLLM, OpenWebUI, …) is needed for roles to actually run.

The repo path you provide when registering a project must be an **absolute path** to a git repository. You can give the repository root, any subdirectory inside it, or even the `.git` directory itself — Orchestra resolves it to the canonical working-tree root automatically.

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

Other scripts: `npm run typecheck` (both workspaces).

---

## Configuration

Resolution order (lowest → highest precedence): built-in defaults → `config.json` (repo root, gitignored) → `ORCHESTRA_*` environment variables.

| `config.json` key | Env var | Default | Meaning |
|---|---|---|---|
| `host` | `ORCHESTRA_HOST` | `0.0.0.0` | Bind interface (0.0.0.0 so tailnet clients reach it). |
| `port` | `ORCHESTRA_PORT` | `5001` | HTTP port (UI + API + SSE). |
| `providerBaseUrl` | `ORCHESTRA_BASE_URL` | `http://192.168.1.2:8080/v1` | OpenAI-compatible **base** URL (not the `/chat/completions` path). |
| `apiKey` | `ORCHESTRA_API_KEY` | `""` | Bearer token; empty if the endpoint has no auth. |
| `defaultModelId` | `ORCHESTRA_MODEL` | `deepseek-r1:latest` | Model used when a project/role doesn't override. |
| `contextWindow` / `maxTokens` | — | `128000` / `8192` | Advertised to pi for the local model. |
| `requestTimeoutMs` | `ORCHESTRA_REQUEST_TIMEOUT_MS` | `300000` | Per-request LLM timeout. |
| `dbPath` | `ORCHESTRA_DB_PATH` | `./orchestra.db` | SQLite file (WAL). |
| `schedulerIdleMs` | `ORCHESTRA_SCHEDULER_IDLE_MS` | `3000` | Idle poll interval when there's no work. |
| `roleToolBudget` | — | `40` | Max tool-calling turns per role run. |

> **Prefer a tool-capable model.** Roles use pi's function-calling to read the repo and to record findings. A model without tool support falls back to reasoning over pre-packed context.

---

## Architecture

One Node process is the whole app — **the server *is* the daemon**. `server/main.ts` boots the DB, seeds the role catalog, serves the REST + SSE API and the built client, and starts the orchestrator loop, all in-process. No external broker, queue, or cron: **SQLite is the durable work queue**, and the scheduler is a single re-entrant, mutex-serialized async loop (strict single-worker sequential). It's crash-safe — restart and it resumes in-flight tasks from the DB.

- **Backend:** Fastify (REST + SSE), better-sqlite3 (WAL), pi (`@earendil-works/pi-*`) for provider-agnostic, repo-aware agents.
- **Frontend:** Vite + React SPA, TanStack Router + TanStack Query, native `EventSource` for the live stream.

### Project layout

```
server/                one Node daemon (we own main())
  src/main.ts          boots Fastify + orchestrator loop + pi
  src/config.ts        typed config (defaults → config.json → env)
  src/db.ts            better-sqlite3 schema + CRUD (idempotent, WAL)
  src/providers.ts     pi provider registration + model discovery
  src/agent.ts         runRole(): one pi agent session per role
  src/roles.ts         default role catalog + routing templates
  src/orchestrator.ts  ingest → plan → run → gate + scheduler
  src/git.ts           PLANNING scaffold + sandboxed artifact writes + commits
  src/bus.ts           in-process pub/sub for the SSE stream
  src/routes/          Fastify REST (api.ts) + SSE (sse.ts)
client/                Vite + React SPA
  src/routes/          Projects, ProjectBoard (kanban), TaskDetail, RolesEditor
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

19 roles are seeded as global defaults and are **customizable per project** (edit prompt, tools, model, enable/disable — a project override wins by key). Two tracks:

- **Spec track:** `intake_triage`, `explorer`, `bug_investigator`, `requirements_analyst`, `architecture_review`, `security_review`, `performance_review`, `api_design`, `data_schema_review`, `style_conventions`, `test_strategy`, `dependency_integration`, `decomposition` (+ promotable `privacy_review`).
- **Research/UX track:** `ux_review`, `user_research`, `options_exploration`, `edge_case_analysis`, `research_synthesis`.

The orchestrator picks the subset + order from routing templates per intake kind; you can override per task via steering.

---

## API

REST is served under `/api`; the live stream is SSE.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness. |
| GET | `/api/scheduler` · POST `/api/scheduler/{start,stop}` · POST `/api/tick` | Loop control / manual single step. |
| GET/POST | `/api/projects` · GET/PATCH/DELETE `/api/projects/:id` | Projects. |
| GET | `/api/projects/:id/roles` · PUT `/api/projects/:id/roles/:key` | Per-project role config. |
| POST | `/api/projects/:id/intake` | Submit an intake (writes into `INTAKE/`). |
| GET | `/api/tasks` · GET/DELETE `/api/tasks/:id` | Tasks + full detail (runs, coverage, plan, children). |
| POST | `/api/tasks/:id/interventions` | Steering: `pause`/`resume`/`rerun_role`/`deepen`/`inject_role`/`steer_note`/`pin_question`/`promote_role`. |
| GET | `/api/tasks/:id/stream` | SSE: live role/tool/text events. |

---

## Deployment (headless / tailnet)

The single process is designed to run on a headless box under **systemd** (or pm2/Docker with a restart policy), bound to the tailnet interface; other clients reach the UI/API/SSE over Tailscale. There is **no auth** — the tailnet is the trust boundary. Multiple clients can watch and steer the same task concurrently; steering actions are POSTs, execution is serialized by the single worker, and SSE fans live progress to every viewer.

---

## Status

The full pipeline — ingest, planning, role execution, gating, coverage rollup, decomposition, artifacts/commits, SSE, and the React UI — is implemented and typechecks/builds. Successful *LLM* refinement depends on a reachable tool-capable endpoint (set `providerBaseUrl`). There is **no automated test suite yet** (see the test-coverage assessment for the plan to add one).
