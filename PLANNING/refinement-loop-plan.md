# Orchestra → Refinery: A Repo-Aware Code-Planning Refinement Loop (TypeScript + pi)

> Status: READY FOR FINAL REVIEW · Owner: TBD · Last updated: 2026-07-12
> This document is itself the first artifact of the system it describes — a plan sitting in `/PLANNING`, meant to be routed through refinement.

## Context

**Why:** Orchestra today is a small Flask + SQLite CRUD dashboard that fires each task at an OpenWebUI LLM endpoint once and stores the reply. We are repurposing it into a **steerable, observable refinement loop**: connect any number of git repositories, drop in work that ranges from a bare error file to open-ended research ("consider how to address this UX issue on this page"), and route each item through a chain of specialized "software-company role" agents until it becomes **actionable** — grouped as **epic → story → task** *or* delivered as a **research brief** (approaches, trade-offs, edge cases, recommendation) — exiting to **READY_FOR_WORK** or **NEEDS_REVIEW** (human).

**The core purpose (drives every design choice below):** LLMs reliably fail at large, nebulous tasks. This tool's value is **tighter control and visibility over long-running research and refinement** — breaking big vague asks into tracked steps, and *making the process legible and steerable* so a user can:
- **watch** a run progress in real time (which role is active, what files it is reading);
- **notice** that a concern was under-served or skipped entirely (e.g. "this run barely touched privacy") — omissions must be *visible*, not invisible;
- **intervene** on a specific task mid-run (re-run a role deeper, inject a one-off step, steer with a note, pause/step);
- **enrich the process durably** — promote a one-off intervention ("add a privacy review here") into a reusable project role that applies to future (and other in-flight) tasks.
This purpose is why §5.5 (live visibility + steering) and the coverage map are load-bearing, not nice-to-haves — they are the product, not the pipeline.

**Stack decision (confirmed with user):** The whole app is **migrated from Python/Flask to TypeScript/Node**, so that [pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-*`, MIT) becomes a **native, in-process dependency** rather than a subprocess. Pure Python was a fit while this was a trivial app; the refinement loop is not trivial, and pi already solves its two riskiest pieces:
- **Provider-agnostic LLM access** (`pi-ai`) — one agent loop runs against any OpenAI-compatible/local endpoint (Ollama, LM Studio, vLLM, OpenWebUI, …) with no per-provider code. This *is* the "endpoint-agnostic" requirement, solved natively.
- **Repo-aware agent runtime** (`pi-agent-core` / `pi-coding-agent`) — the tool-calling loop, built-in `read`/`grep`/`glob`/`bash` tools, path protection, and session state. This replaces the entire hand-built function-calling loop + tool sandbox we would otherwise write.

**Framework decision (confirmed with user; stability-weighted):** a **Fastify** backend we own + a **Vite + React SPA** frontend (TanStack Router + TanStack Query), with **SSE** for live updates. Chosen over meta-frameworks (Next.js, React Router 7, TanStack Start) because long-term stability is the priority, and this stack has the **lowest churn** (no meta-framework to migrate; React/Vite/TanStack are dominant, independently maintained, individually swappable) and the **best architectural fit**: our process is a long-running daemon that boots the HTTP server, the orchestrator loop, and pi *together* ("the server process **is** the daemon"), so a backend we own (`main()` is ours) is native, whereas a meta-framework would make the background worker a startup bolt-on against its grain. Next.js was explicitly ruled out here — its serverless/RSC bias fights the daemon + embedded-pi shape and it carries the highest churn. No SSR is needed (internal, auth-free tailnet, no SEO). Trade-off accepted: we hand-wire routing/data-fetching (standard Vite + TanStack stack), which adds a small frontend-foundation step to the roadmap.

**What carries over from the current design (language-agnostic, keep):** the data model, the stage/kanban model, the role catalog, the orchestrator router+gatekeeper state machine, epic/story/task decomposition, hybrid SQLite+/PLANNING storage, and the two exit states. Only the *implementation language* and the *agent-engine internals* change. The existing HTML/CSS industrial theme carries over largely unchanged.

**What gets retired:** the Python files (`app.py`, `orchestrator.py`, `db.py`, `config*.py`) and the never-needed hand-built pieces they implied (`agent_runner.py`, provider adapter, `fetch_available_models` multi-path probe, custom tool sandbox). Their *logic* is ported; their code is replaced.

**Confirmed decisions:**
1. **Repo-aware tool agents** — each role reads/greps the real repo + writes `/PLANNING` artifacts (via pi tools).
2. **Hybrid storage** — SQLite is source of truth for state/routing/history; artifacts are *also* materialized as markdown into `<repo>/PLANNING` so output is version-controlled.
3. **Endpoint-agnostic** — any local OpenAI-compatible endpoint, configured once via pi provider registration (no Anthropic requirement; cloud providers work too if a key is supplied).
4. **Two exit states** — `READY_FOR_WORK` and `NEEDS_REVIEW` (human).

---

## 0. Target stack

| Concern | Choice | Notes |
|---|---|---|
| Language/runtime | TypeScript on Node 20+ | Whole app. |
| Backend | **Fastify** (long-running Node server we own) | We own `main()` → it boots the HTTP server + orchestrator loop + pi together ("the server *is* the daemon"). REST + SSE routes. Mature plugin ecosystem, lowest-churn backbone. |
| Frontend | **Vite + React SPA** — TanStack Router (routing) + TanStack Query (data/SSE cache) | Lowest-churn UI stack (no meta-framework to migrate; each dep dominant + swappable). No SSR needed (internal, auth-free tailnet, no SEO). Served as static assets by Fastify. |
| DB | **better-sqlite3** (WAL mode) | Synchronous API matches the current open→query→close style in `db.py` 1:1; reuses the existing SQLite file. WAL suits the read-heavy (many SSE viewers) + occasional-write pattern. Also serves as the durable work queue (no broker). (`node:sqlite` is a zero-dep alternative.) |
| Agent engine | **`@earendil-works/pi-coding-agent`** (`createAgentSession`, `DefaultResourceLoader`, `defineTool`, `SessionManager`) + **`@earendil-works/pi-ai`** (`registerProvider`) | Roles, tools, provider adapter, model discovery. |
| Tool param schemas | **TypeBox** (`@sinclair/typebox`) | pi's `defineTool` uses `Type.Object(...)`. |
| Background worker | in-process re-entrant async loop in `orchestrator.ts` (single-worker sequential) | No external queue/broker/cron — SQLite is the work queue. The Fastify server process *is* the daemon. Replaces the Python daemon-thread-spawns-subprocess pattern; start/stop toggle like today. |

**Project layout:**
```
server/                we own the process — one Node daemon
  main.ts              entry: boots Fastify + orchestrator loop + pi
  config.ts            single typed config (kills the 3 duplicate Python loaders)
  db.ts                better-sqlite3 schema + CRUD (idempotent init)
  providers.ts         pi registerProvider + async model discovery
  agent.ts             runRole(): one pi agent session per role
  roles.ts             default role catalog + system prompts (seed data)
  orchestrator.ts      ingest → plan → run → gate state machine + scheduler
  git.ts               scaffold <repo>/PLANNING, commit artifacts
  routes/              Fastify REST + SSE routes (serves built client assets)
client/                Vite + React SPA
  main.tsx             app entry, TanStack Router
  routes/              kanban, project, task-detail, roles editor, intake
  queries/             TanStack Query hooks + EventSource (SSE) client
  components/          coverage map, live pane, steering controls, verdict chips
  styles/              industrial CSS/ico carried over from templates/
package.json  tsconfig.json  vite.config.ts
```

---

## 1. Architecture (overview)

```
┌─────────────────────────────────────────────────────────────┐
│  React SPA (Vite) — projects, kanban, task detail, roles     │
│  ⇅ REST + SSE ⇄ Fastify API                                  │
└───────────────┬─────────────────────────────────────────────┘
                │
        ┌───────▼────────┐        ┌──────────────────────────┐
        │  Orchestrator  │◄──────►│  SQLite (source of truth) │
        │  (router +     │        │  projects, tasks, roles,  │
        │   gatekeeper)  │        │  role_runs, interventions │
        └───────┬────────┘        └──────────────────────────┘
                │ selects next role per task
        ┌───────▼─────────────────────────────────┐
        │  agent.ts runRole()                      │
        │  pi createAgentSession(                  │
        │    systemPromptOverride = role persona,  │
        │    tools = read/grep/glob (read-only),   │
        │    customTools = [record_findings,       │
        │                   write_artifact])       │──► pi-ai ──► any OpenAI-
        │  cwd = <repo>                            │             compatible endpoint
        └───────┬─────────────────────────────────┘
                │ reads/greps repo, writes artifact section
        ┌───────▼────────────────────────────┐
        │  Git repo(s) on disk                │
        │  <repo>/PLANNING/{INTAKE,REFINING,  │
        │                    READY,REVIEW,epics}│
        └─────────────────────────────────────┘
```

Flow is **orchestrator-driven dynamic routing**, not a fixed pipeline: the Orchestrator picks which roles a task needs, runs them one at a time, and re-evaluates readiness after each.

---

## 2. Data model (`db.ts`, better-sqlite3)

Same schema the Python plan defined — ported verbatim. Single SQLite file; idempotent `initDb()` creates tables and runs guarded `ALTER TABLE ... ADD COLUMN` migrations.

**`projects`** — `id, name, repo_path, planning_dir DEFAULT 'PLANNING', default_model, default_provider, config_json, created_at, updated_at`.

**`roles`** — `id, project_id (NULL = global default), key, title, enabled, applies_to (JSON), ordering, system_prompt, tools_json (JSON: allowed pi tool names), model, created_at, updated_at`. Per-project rows override global defaults by `key`.

**`role_runs`** — `id, task_id, role_key, verdict (pass|needs_more|blocker|needs_human), summary, output_md, coverage_json (which concerns this role examined / skipped and why), tool_calls_json, transcript_jsonl (streamed events, for the live+replay view), depth (1..n, bumped by "deepen"), model, tokens, created_at`. One row per role execution: the audit trail + the markdown section that role contributed.

**`interventions`** (new) — `id, task_id, kind (rerun_role|inject_role|steer_note|pin_question|pause|resume|deepen|promote_role), payload_json, created_by, created_at`. The record of every human steering action on a task (§5.5); the Orchestrator reads unconsumed interventions before its next step so steering takes effect on the very next role.

**`tasks`** — reuse the existing table + add: `project_id, stage (intake|refining|ready|review), level (epic|story|task), intake_kind (manual|error_file|feature|bug|chore|spike|research|ux|question), exit_kind (spec|research_brief), refinement_plan_json (ordered roles incl. ad-hoc injected ones + which have run), coverage_json (rolled-up concern coverage across roles — powers the coverage map), artifact_path, exit_state (ready_for_work|needs_review), review_reason, paused (0/1)`. The existing `parent_task_id`/`step_number` carry the epic→story→task tree.

CRUD mirrors the current `db.py` functions as typed TS: `createProject/listProjects/getProject/updateProject`, `listRoles(projectId)` (global-fallback merge), `upsertRole`, `createRoleRun/listRoleRuns(taskId)`, `createIntervention/listUnconsumedInterventions(taskId)/markConsumed`, plus the ported task CRUD. All config resolution lives in `config.ts` (one loader, not three).

---

## 3. Git repos + the `/PLANNING` tree

- A **project = a local git repo path**. Registering validates it's a git repo and scaffolds `<repo>/PLANNING/{INTAKE,REFINING,READY,REVIEW,epics}` if missing (`git.ts`).
- Artifacts are physically materialized in the stage folders (`READY/`, `REVIEW/`, growing `REFINING/*.md`) and **committed** after each role step, so the refinement history is version-controlled and PR-able. Commit message encodes role / task / purpose, e.g. `refine(security_review): task-1234 — threat model for token handling` (`git.ts`).
- **Intake ingestion:** the Orchestrator scans `<repo>/PLANNING/INTAKE/*` (`.log`/`.txt`/`.md`) for files not yet in SQLite, creates a `tasks` row (`stage=intake`, `intake_kind` inferred — stack-trace/`.log` → `error_file`), and moves the file into `REFINING/`. This realizes "drop a bare error file → actionable work."
- **DB is authoritative; files mirror it** (the hybrid): `stage` in SQLite is truth; the file is moved/rewritten to match — no reliance on folder location for queries.
- **Sandboxing comes free from pi:** review roles are configured with **read-only built-in tools only** (`read`, `grep`, `glob`) and pi's path protection scoped to `cwd = repo_path`. The only writes go through our sandboxed `write_artifact` custom tool, which refuses paths outside `<repo>/PLANNING`. `git.ts` handles the commit step separately.

---

## 4. Role catalog — default refinement process (13 roles + Orchestrator)

Modeled on real software-company functions; seeded as global `roles` rows in `roles.ts`; **each customizable/toggleable per project**. The Orchestrator chooses a subset + order per `intake_kind`.

| # | Role key | Real-world analog | Produces |
|---|----------|-------------------|----------|
| 0 | `orchestrator` | Eng Manager / Refinement Lead | **Gatekeeper + router.** Builds the plan, runs after each role, judges readiness, sets exit_state. (Not a queue role.) |
| 1 | `intake_triage` | Product Owner / BA | Raw intake/error → structured problem statement, `intake_kind`, urgency, first scope. **Entry role.** |
| 2 | `explorer` | Staff Eng / Onboarding | Grounds the task in real code: relevant files, entry points, patterns/utilities to reuse. |
| 3 | `bug_investigator` | SRE / Debugging Eng | Repro logic, root-cause hypothesis, failing component, evidence from code. |
| 4 | `requirements_analyst` | Product Manager | Intent + acceptance criteria; **flags ambiguity → can route to NEEDS_REVIEW**. |
| 5 | `architecture_review` | Software Architect | Design impact, module boundaries, approach, alternatives, risks. |
| 6 | `security_review` | AppSec Engineer | Threat model, injection/authz/secrets/deps, security acceptance criteria. |
| 7 | `performance_review` | Performance Engineer | Hot paths, complexity, resource/data-volume implications. |
| 8 | `api_design` | API Designer / Tech Lead | Contracts, signatures, endpoints, backward-compat. |
| 9 | `data_schema_review` | Data Eng / DBA | Schema/migration impact, integrity, indexing. |
| 10 | `style_conventions` | Code Reviewer | Repo conventions, naming, reuse of existing utilities. |
| 11 | `test_strategy` | QA / SDET | Test plan, acceptance tests, edge cases, coverage. |
| 12 | `dependency_integration` | Build / DevEx Eng | External deps, versioning, integration points, CI/build impact. |
| 13 | `decomposition` | Tech Lead / Scrum Master | **Breaks refined work into epic → story → atomic task tree.** Produces child `tasks` rows. **Exit-adjacent (spec).** |

**Research/UX track** (for `research`/`ux`/`question` intakes — the "consider this UX issue" case, whose exit is a `research_brief`, not a task tree):

| # | Role key | Real-world analog | Produces |
|---|----------|-------------------|----------|
| 14 | `ux_review` | Product Designer | Usability/interaction critique of the affected surface, grounded in the real templates/components. |
| 15 | `user_research` | UX Researcher | User goals, personas, journeys, prior art / competitive patterns for the problem. |
| 16 | `options_exploration` | Staff Eng / Design Lead | 2-3 concrete approaches with trade-offs and a recommendation. |
| 17 | `edge_case_analysis` | QA / Design | Edge cases, failure modes, accessibility/empty/error states — the "actionable feedback on edge cases" the user explicitly wants. |
| 18 | `research_synthesis` | Tech Lead | Rolls the above into a **decision brief** (problem, options, trade-offs, edge cases, recommendation, open questions). **Exit-adjacent (research_brief).** |

Optional per-project extras: `devops_release`, `docs_review`, `accessibility_review`, `cost_review`, `privacy_review` (the promotable example from §8).

**Each role** = `title` + `system_prompt` (persona + what to inspect + required findings, incl. a declared **coverage list** of concerns examined/skipped) + `tools_json` (subset of pi built-ins) + `applies_to`. Heavy roles get `read`/`grep`/`glob`; light roles can run on the Orchestrator-assembled context alone to save cost. Which track (spec vs research) and which roles run is chosen by the Orchestrator from `intake_kind`, and is always user-overridable per task (§5.5).

---

## 5. Repo-aware role agents via pi (`agent.ts`) — the key mechanism

`runRole(project, task, role)` executes one refinement step as a **pi agent session** and returns a structured result. Concretely (verbatim pi SDK surface):

```ts
import { createAgentSession, DefaultResourceLoader,
         defineTool, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// A custom tool the role MUST call to finish — gives us structured output
// directly from the tool call, no fragile tail-parsing.
const recordFindings = defineTool({
  name: "record_findings",
  description: "Record your verdict and the markdown section for this role.",
  parameters: Type.Object({
    verdict: Type.Union([Type.Literal("pass"), Type.Literal("needs_more"),
                         Type.Literal("blocker"), Type.Literal("needs_human")]),
    summary: Type.String(),
    open_questions: Type.Array(Type.String()),
    section_md: Type.String(),
  }),
  execute: async (_id, p) => { captured = p; return { content:[{type:"text",text:"recorded"}], details:{} }; },
});

// write_artifact: appends section_md to <repo>/PLANNING/REFINING/<task>.md,
// path-guarded to reject anything outside PLANNING.

const loader = new DefaultResourceLoader({ systemPromptOverride: () => role.system_prompt });
await loader.reload();

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  resourceLoader: loader,
  tools: role.tools,                       // e.g. ["read","grep","glob"] — read-only
  customTools: [recordFindings, writeArtifact],
  // cwd set to project.repo_path so pi's read/grep are repo-scoped + sandboxed
});

session.subscribe(ev => { if (ev.type === "tool_execution_end") logToolCall(ev); });
await session.prompt(buildRoleContext(task, priorRoleRuns));   // task + accumulated findings
```

After `prompt()` resolves: read `captured` (verdict/summary/open_questions/section_md) and the logged tool calls, persist a `role_runs` row, and append `section_md` to the task's `REFINING/*.md`.

**Provider setup (`providers.ts`, once at startup) — this is the endpoint-agnostic answer:**
```ts
pi.registerProvider("local", {
  baseUrl: config.baseUrl,          // e.g. http://192.168.1.2:8080/v1  (any OpenAI-compatible)
  apiKey: "$LOCAL_API_KEY",
  api: "openai-completions",
  models: [ /* discovered dynamically via async extension factory hitting /models */ ],
});
```
This replaces the old `submit_to_openwebui` body-building + the multi-path `fetch_available_models` probe. Model discovery uses pi's async extension factory against the endpoint's `/models`.

**Why this removes the old risk:** we no longer hand-write the tool-call loop, the OpenAI-body shaping, the `X-Workspace-ID` special-casing, response normalization, or a bespoke path sandbox — pi owns all of it and normalizes across providers. **Non-tool-capable models:** prefer a tool-capable local model; where unavailable, the Orchestrator pre-packs relevant files into `buildRoleContext()` so the role still reasons over real code (lightweight fallback, not a separate engine).

---

## 5.5 Live visibility & human steering (the product surface)

This is what makes the loop *steerable and observable* rather than a black-box batch job. It is central, not polish.

**Live visibility (watch a run):**
- `runRole()` already gets pi's event stream (`session.subscribe` → `text_delta`, `tool_execution_start/end`). A Fastify **SSE** route (`GET /api/task/:id/stream`) fans these to the React task-detail view (browser-native `EventSource`, feeding a TanStack Query cache/store) so the user watches, in real time: which role is active, its streaming reasoning, and each file it `read`/`grep`ed. Persist the stream to `role_runs.transcript_jsonl` for replay after the fact.
- **Coverage map** (the mechanism for *noticing gaps*): every role declares, in its `record_findings` call, a `coverage` list — concerns it examined, concerns it deliberately skipped (+why), concerns out of scope. The Orchestrator rolls these into `tasks.coverage_json` and the UI renders a matrix: *Considered · Skipped · Never looked at* across a project's concern taxonomy (security, privacy, perf, a11y, edge-cases, …). This is how a user *sees* that privacy was never touched — the absence is on screen.
- **Effort indicators:** surface per-role tokens / tool-call count / `depth` so "didn't spend enough time on X" is observable, not a hunch.

**Human steering (intervene on one task) — each is an `interventions` row the Orchestrator consumes before its next step:**
- **Re-run a role** (optionally with a note: "focus on token handling") → supersedes the prior `role_runs` row; or **deepen** → re-runs at `depth+1` with a larger budget and the prior section as prior art.
- **Inject a one-off role** into this task's `refinement_plan_json` at a chosen position (e.g. drop `privacy_review` in after `security_review`) — without touching the global catalog.
- **Steer note / pin question** → free-text guidance attached to the task; injected into the next role's context and kept visible until resolved.
- **Pause / step / run-now:** `paused` flag stops the scheduler from advancing this task; "step" runs exactly one role then re-pauses (inspect-between-steps); "run-now" bypasses the idle wait.

**Enrich the process durably (one-off → policy):** a `promote_role` intervention takes an injected one-off role (e.g. `privacy_review`) and writes it as a per-project `roles` row + adds it to the relevant `intake_kind` routing template, so it runs automatically on future tasks — with a prompt to optionally **apply it to other in-flight tasks** of the same kind. This closes the loop: notice a gap once → make it standing process.

---

## 6. Orchestrator (router + gatekeeper) — `orchestrator.ts`

Ported from the Python state machine, driven off `stage` (fixes the current `incomplete`-never-reprocessed bug):

1. **Ingest** new `INTAKE/` files → `tasks` rows (§3).
2. **Plan:** if `refinement_plan_json` empty, the Orchestrator (its own pi session/system prompt) proposes an ordered role list for the `intake_kind` (default templates per kind, e.g. `error_file` → triage → explorer → bug_investigator → arch → test → decomposition).
3. **Consume interventions, then run next pending role:** before advancing, drain unconsumed `interventions` for the task (re-run/inject/steer/deepen/pause per §5.5) and apply them to `refinement_plan_json` + the next role's context. Then `runRole()` (§5) → write `role_runs` (with `coverage_json`) + artifact section, and roll coverage up into `tasks.coverage_json`.
4. **Gate** after each role, on accumulated verdicts **and coverage**:
   - `paused` → stop advancing this task (await a resume/step intervention).
   - any `needs_human` / unresolved `open_questions` over threshold → **exit `needs_review`**, move artifact to `REVIEW/`, set `review_reason`.
   - readiness rubric met → terminate on the task's `exit_kind`: **spec** → run `decomposition`, **exit `ready_for_work`** into `READY/`; **research_brief** → run `research_synthesis`, **exit `ready_for_work`** into `READY/` as a decision brief. The rubric checks *coverage of expected concerns*, not just verdicts — a task with privacy uncovered on a data-touching change is not "ready."
   - `blocker` → insert a remediation role or escalate to review.
   - else → advance (Orchestrator may insert/skip roles dynamically; user injections take precedence).
5. **Decomposition → epic/story/task** (spec exit): the `decomposition` role emits a tree; the Orchestrator creates child `tasks` rows (`level` = epic/story/task, `parent_task_id` links); large stories/spikes can re-enter refinement recursively; related work groups under one epic artifact in `PLANNING/epics/`.

**Scheduler (internal, no external queue):** an in-process, **re-entrant-guarded async loop** — after each role step it immediately re-checks for work and only sleeps (idle poll, ~a few seconds) when nothing is actionable, so intakes and interventions are picked up promptly while an idle service stays quiet. The unit of work is **one role step**, which commits atomically (`role_runs` + artifact section + `stage`/`refinement_plan_json` update) — this is the checkpoint boundary. **Crash-safe by construction:** the loop keeps no irrecoverable in-memory state; on restart the orchestrator re-derives all in-flight work from `stage`/`refinement_plan_json` and resumes at the next role. Start/stop toggle like today. **Readiness rubric** replaces the thin `check_completion_criteria`, stored per project so "done" is tunable.

**Deployment (headless / tailnet):** the whole app is a single Node process (server + scheduler + agent runner), run under **systemd** (or pm2/Docker with a restart policy) on a headless box and bound to the tailnet interface; other clients reach the UI/SSE/API over Tailscale (no auth — the tailnet is the trust boundary). Multiple clients can watch and steer the same task concurrently: steering actions are plain POSTs appending `interventions` rows, execution is serialized by the single worker, and SSE fans live progress to all viewers — so no locking is needed. **Escape hatch (not built now):** to split the worker into its own process or scale across machines, add `busy_timeout` + a `locked_at` lease column so one worker claims a task; WAL already handles multi-process reads. Not required for a single-box tailnet service.

---

## 7. UI (React SPA in `client/`, Fastify REST+SSE in `server/routes/`)

React SPA (Vite) served as static assets by Fastify; TanStack Router for routes, TanStack Query for data + SSE; industrial theme preserved (CSS/ico reused). The API is a plain REST surface (`/api/...`) plus the SSE stream; every steering action is a POST.
- **Projects page** — register a repo (path, name, model/provider), list, enter. Routes `/projects`, `/projects/new`, `/project/:id`.
- **Kanban board** (replaces the 3-bucket dashboard) — columns by `stage`: INTAKE · REFINING · READY · REVIEW; cards show role progress ("6/9 · at security_review"), `level` badge, exit_state, a paused indicator, and a coverage warning dot when expected concerns are uncovered.
- **Task detail** — the primary steering surface (§5.5): (a) a **live pane** over SSE showing the active role streaming + files it is reading; (b) the accumulating artifact with per-role sections + verdict chips + effort indicators (from `role_runs`); (c) a **coverage map** (Considered/Skipped/Never-looked-at); (d) **steering controls** — re-run/deepen a role, inject a one-off role at a position, add a steer-note/pin a question, pause/step/run-now; (e) the epic→story→task tree or research brief; (f) the REVIEW action (approve → READY, or send back with notes). Each control POSTs an `interventions` row.
- **Role config editor** (per project) — enable/disable, edit `system_prompt`, reorder, set tools/model. Backed by `roles`. Includes **"promote"** to turn a task's injected one-off role into standing project policy (§8).
- **Intake** — textarea *or* file upload landing in `INTAKE/`.

---

## 8. Per-project customization

- Global default role catalog seeded once; per-project `roles` rows override prompt/enablement/order/tools/model (`listRoles(projectId)` merges, project wins by `key`).
- Routing templates per `intake_kind`, readiness rubric (incl. **required-concern coverage** so "done" means covered, not just verticals passed), tool budget, timeouts, commit-artifacts on/off → `projects.config_json`.
- Model/provider overridable at project and role level (falls back to `config.ts` defaults).
- **One-off → standing policy (the enrich loop):** a `promote_role` intervention (§5.5) writes an injected task role into the project `roles` table and adds it to the matching `intake_kind` routing template, so it runs automatically thereafter; the user is offered to backfill it onto other in-flight tasks of the same kind. This is how "add a dedicated privacy review flow," realized once on a single task, becomes durable project process.

---

## 9. Roadmap (phased)

1. **Scaffold + parity core:** Node/TS monorepo (`server/` + `client/`, `package.json`, `tsconfig`, Fastify, Vite, better-sqlite3, pi packages); `config.ts`; `server/main.ts` (boots Fastify + worker + pi); `db.ts` with full schema (new tables + `tasks` extensions) reusing the existing SQLite file; `git.ts` (register repo, scaffold `/PLANNING`, commit artifacts).
2. **pi integration:** `providers.ts` (registerProvider + model discovery); `agent.ts` `runRole()` with `record_findings` (incl. `coverage`) + `write_artifact` custom tools, forwarding pi's event stream; `roles.ts` default catalog (spec + research/UX tracks) + system prompts.
3. **Orchestrator v2:** ingest; plan/run/gate state machine consuming `interventions`; coverage roll-up; readiness rubric with required-concern coverage; spec + research_brief exits; in-process scheduler with pause/step/run-now.
4. **API + frontend foundation:** Fastify REST routes for the data model + the SSE stream route; Vite + React SPA scaffold with TanStack Router + TanStack Query + the `EventSource` client (the "we hand-wire routing/data" cost, paid once here).
5. **Visibility & steering (the product surface, §5.5):** SSE live pane; coverage map; per-task steering controls (re-run/deepen/inject/steer/pin/pause) POSTing `interventions`; effort indicators; promote-to-policy.
6. **UI shell:** projects, kanban, task-detail, role editor, intake/upload; port the industrial theme.
7. **Polish:** per-project routing templates, non-tool-model context-pack fallback, retire the orphaned legacy markdown store, README rewrite for the TS app + pi setup, remove the Python files.

---

## 10. Critical files

- **New (server):** `server/{main,config,db,providers,agent,roles,orchestrator,git}.ts`, `server/routes/*.ts`, `package.json`, `tsconfig.json`.
- **New (client):** `client/main.tsx`, `client/routes/*`, `client/queries/*`, `client/components/*`, `vite.config.ts`.
- **Reused assets:** the industrial CSS / favicon from `templates/`/static → `client/styles/`.
- **Retired after port:** `app.py`, `orchestrator.py`, `db.py`, `config*.py`, `templates/*.html`, `requirements.txt` (logic ported, code removed in the final phase).

---

## 11. Verification (end-to-end)

1. **Schema:** `initDb()` on the existing DB adds all tables/columns; re-running is idempotent. `listRoles(projectId)` returns globals, then reflects a project override.
2. **Provider probe:** point `config.baseUrl` at the local endpoint → `providers.ts` registers it and model discovery lists models; swap `baseUrl` to a second OpenAI-compatible server → same code path works with no changes (proves endpoint-agnosticism).
3. **Repo registration:** register the Orchestra repo itself as a test project → `PLANNING/{INTAKE,REFINING,READY,REVIEW,epics}` scaffold appears; a review role attempting to `read` outside `repo_path` is blocked, and `write_artifact` rejects paths outside `PLANNING`.
4. **Bare-error-file path (headline demo):** drop a real stack-trace file into `PLANNING/INTAKE/`, start the scheduler → task created (`intake_kind=error_file`), triage → explorer → bug_investigator run (confirm `role_runs.tool_calls_json` shows real `read`/`grep` calls via pi), terminating at `READY_FOR_WORK` (atomic spec) or `NEEDS_REVIEW` (reason). Inspect materialized `READY/`/`REVIEW/` markdown.
5. **Decomposition (spec exit):** submit a broad feature intake → a `decomposition` run produces epic→story→task child `tasks` rows linked by `parent_task_id`, grouped under one epic artifact.
6. **Research brief exit (the UX case):** submit "consider how to address this UX issue on this page" as a `ux` intake → the research track runs (ux_review → options_exploration → edge_case_analysis → research_synthesis) and exits `ready_for_work` with `exit_kind=research_brief` — a decision brief listing approaches, trade-offs, and edge cases (not a task tree).
7. **Live visibility:** open a task mid-run → SSE pane streams the active role's reasoning and shows the files it reads in real time; the coverage map renders Considered/Skipped/Never-looked-at.
8. **Notice-a-gap → steer → promote (headline steering loop):** on a data-touching task, confirm the coverage map shows privacy as *never looked at* → **inject** a one-off `privacy_review` role after `security_review` → confirm it runs on the next tick and its findings + coverage appear → **promote** it → confirm a project `roles` row + routing-template entry now exist and a fresh similar task auto-includes privacy_review. Also exercise **deepen** on a shallow section and **pause/step** to inspect between roles.
9. **Non-tool model:** point at a model without function-calling → context-pack fallback still grounds findings in real code and the loop completes.
10. **UI walk:** kanban shows INTAKE→REFINING→READY/REVIEW with verdict chips + coverage/paused indicators; editing a project's `security_review` prompt changes the next run; REVIEW action approves a task into READY.
11. **Headless resume (crash-safety):** start a refinement, kill the process mid-run, restart → the orchestrator resumes at the next unrun role from `stage`/`refinement_plan_json` with no duplicated role_runs; confirm two tailnet clients can both watch the same task's SSE stream and one can steer it while it runs.
12. Run the app (`npm run dev`) and exercise the flow manually; deploy under systemd on a headless host bound to the tailnet interface.

---

## Open follow-ups (not blocking; defaults chosen)
- **Concurrency:** single-worker sequential (matches today); parallel roles a later optimization.
- **Concern taxonomy** for the coverage map: a fixed default list (security, privacy, perf, a11y, edge-cases, tests, deps, data) vs. per-project editable. Default: seed the fixed list, allow per-project additions.

## Decided
- **Stack = Fastify (backend we own) + Vite/React SPA (TanStack Router + TanStack Query) + SSE.** Chosen for lowest churn and native fit to the daemon (we own `main()`). Meta-frameworks (Next.js, React Router 7, TanStack Start) considered and set aside; **Next.js ruled out** for this system (serverless/RSC bias fights the daemon + embedded pi). No SSR needed.
- **Live transport = SSE** (browser-native `EventSource`; interventions flow back as plain POSTs). WebSocket only if the UI later needs bidirectional streaming.
- **Commit artifacts:** after each role step, commit the artifact with a role/task/purpose message (e.g. `refine(<role>): <task> — <purpose>`).
- **Structured output:** `record_findings` custom tool (vs. parsing a JSON tail from free text).
- **Migration cutover:** greenfield `server/` + `client/` alongside the Python app, then delete Python in the final phase.
- **Product naming:** keep "Orchestra" vs. rename "Refinery" - Keep orchestra for now.
