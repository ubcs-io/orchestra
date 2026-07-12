# Orchestra → Refinery: A Repo-Aware Code-Planning Refinement Loop

> Status: DRAFT for refinement · Owner: TBD · Last updated: 2026-07-12
> This document is itself the first artifact of the system it describes — a plan sitting in `/PLANNING`, meant to be routed through refinement.

## Context

**Why:** Orchestra today is a simple Flask + SQLite CRUD dashboard that fires each task at an OpenWebUI LLM endpoint once and stores the reply. The goal is to repurpose it into a **refinement loop**: connect any number of git repositories, ingest raw intakes (or a bare error file with zero context), and route each item through a chain of specialized "software-company role" agents until an orchestrator judges it **atomic, actionable, and modular** — grouped as **epic → story → task** — and exits it to one of two states: **READY_FOR_WORK** or **NEEDS_REVIEW** (human).

**What already exists we will reuse (not rebuild):**
- SQLite is already the backend (`db.py`) — *no migration needed*. The `tasks` table already has `parent_task_id`, `task_type`, `step_number`, `completion_criteria`, `response`, `failure_reason` — the latent scaffolding for parent/child decomposition and multi-step routing.
- A parent/child spawn mechanism already exists: `create_subtask` / `create_next_steps_subtasks` (`orchestrator.py:292-334`).
- An evaluator/gatekeeper pattern already exists (hardcoded `evaluator` workspace, `parse_evaluator_response` `orchestrator.py:251-290`) — we generalize this into the Orchestrator role.
- The OpenWebUI call path `submit_to_openwebui` (`orchestrator.py:113-206`) and model discovery `fetch_available_models` (`app.py:42-161`) — reused and extended with a tool-calling loop.
- Flask server-rendered template pattern (`app.py`, `templates/`).

**Confirmed decisions:**
1. **Repo-aware tool agents** — each role can grep/read the real repo + read/write `/PLANNING` artifacts.
2. **Hybrid storage** — SQLite is source of truth for state/routing/history; artifacts are *also* materialized as markdown into the repo's `/PLANNING` tree so output is version-controlled.
3. **OpenWebUI only** — no Anthropic dependency; we build a function-calling agent loop over the existing OpenAI-compatible endpoint, with a context-pack fallback.
4. **Two exit states** — `READY_FOR_WORK` (actionable spec) and `NEEDS_REVIEW` (escalated for human evaluation).

---

## 1. Target architecture (overview)

```
┌─────────────────────────────────────────────────────────────┐
│  Flask UI (projects, kanban board, task detail, role config) │
└───────────────┬─────────────────────────────────────────────┘
                │
        ┌───────▼────────┐        ┌──────────────────────────┐
        │  Orchestrator  │◄──────►│  SQLite (source of truth) │
        │  (router +     │        │  projects, tasks, roles,  │
        │   gatekeeper)  │        │  role_runs, events        │
        └───────┬────────┘        └──────────────────────────┘
                │ selects next role per task
        ┌───────▼────────────────────────────┐
        │  Role Agent runner (per role)       │
        │  system prompt + repo-scoped tools  │
        │  ── OpenWebUI function-calling loop ─┼──► OpenWebUI
        └───────┬─────────────────────────────┘
                │ read/grep repo, read/write artifacts
        ┌───────▼────────────────────────────┐
        │  Git repo(s) on disk                │
        │  <repo>/PLANNING/{INTAKE,REFINING,  │
        │                    READY,REVIEW}    │
        └─────────────────────────────────────┘
```

The refinement flow is **orchestrator-driven dynamic routing**, not a fixed linear pipeline: the Orchestrator picks which roles a task needs (based on its type + accumulated findings), runs them one at a time, and re-evaluates readiness after each.

---

## 2. Data model (SQLite changes in `db.py`)

Keep the single-file `sqlite3` pattern. Add tables + extend `tasks`. All new columns via `ALTER TABLE ... ADD COLUMN` guarded by a check (idempotent `init_db`, matching existing style at `db.py:37-65`).

**New table `projects`:**
```sql
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  repo_path TEXT NOT NULL,          -- absolute path to git repo on disk
  planning_dir TEXT DEFAULT 'PLANNING',
  default_model TEXT,               -- overrides config DEFAULT_MODEL
  default_workspace TEXT,           -- OpenWebUI workspace routing
  config_json TEXT,                 -- per-project settings (tool budget, timeouts)
  created_at TEXT, updated_at TEXT
);
```

**New table `roles`** (seeded with the default catalog in §4; per-project rows override the defaults where `project_id` is set, `NULL` = global default):
```sql
CREATE TABLE roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER,               -- NULL = global default template
  key TEXT NOT NULL,                -- 'intake_triage', 'security_review', ...
  title TEXT,                       -- human label, e.g. "Security Reviewer (AppSec)"
  enabled INTEGER DEFAULT 1,
  applies_to TEXT,                  -- JSON: task types this role runs on
  ordering INTEGER,                 -- default suggested order / priority
  system_prompt TEXT,               -- the role persona + instructions
  tools_json TEXT,                  -- JSON: which tools this role may call
  model TEXT,                       -- optional per-role model override
  created_at TEXT, updated_at TEXT
);
```

**New table `role_runs`** (one row per role execution on a task — the refinement history / audit; each also holds the markdown section that role contributed):
```sql
CREATE TABLE role_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT, role_key TEXT,
  verdict TEXT,                     -- pass | needs_more | blocker | needs_human
  summary TEXT,                     -- short structured takeaway
  output_md TEXT,                   -- the section appended to the artifact
  tool_calls_json TEXT,             -- what files it read/grepped (for transparency)
  model TEXT, tokens INTEGER,
  created_at TEXT
);
```

**Extend `tasks`** (new columns):
- `project_id INTEGER`
- `stage TEXT` — `intake | refining | ready | review` (drives the kanban board; supersedes the current 3-bucket `status_to_category`)
- `level TEXT` — `epic | story | task` (reuses the parent/child tree via existing `parent_task_id`/`step_number`)
- `intake_kind TEXT` — `manual | error_file | feature | bug | chore | spike`
- `refinement_plan_json TEXT` — the Orchestrator's ordered list of roles + which have run
- `artifact_path TEXT` — path of the materialized markdown under `<repo>/PLANNING/...`
- `exit_state TEXT` — `ready_for_work | needs_review` (set at terminal)
- `review_reason TEXT` — why it was escalated to a human

New `db.py` functions (mirroring existing `create_task`/`update_task`/`list_tasks` style at `db.py:77-236`): `create_project`, `list_projects`, `get_project`, `update_project`; `list_roles(project_id)` (with global-fallback merge), `upsert_role`; `create_role_run`, `list_role_runs(task_id)`. Consolidate the **three duplicate config loaders** (app.py `load_config`, orchestrator.py `load_config`, db.py `_load_db_path`) into one helper in a new `config_loader.py` while here.

---

## 3. Git repos + the `/PLANNING` tree

- A **project = a local git repo path** (local service; clone-from-URL is a later add). Registering a project validates the path is a git repo and creates `<repo>/PLANNING/` scaffold if missing.
- **Stage folders** (artifacts physically materialized here, committed by the tool, so the plan output is version-controlled and PR-able):
  ```
  <repo>/PLANNING/
    INTAKE/     ← user drops raw intakes / error files here OR they're created via UI
    REFINING/   ← in-flight artifacts (one .md per task, growing per-role sections)
    READY/      ← exit_state = ready_for_work
    REVIEW/     ← exit_state = needs_review (awaiting human)
    epics/      ← epic/story/task tree (grouped decomposition output)
  ```
- **Intake ingestion:** the Orchestrator scans `<repo>/PLANNING/INTAKE/*` (and `*.log`/`*.txt`/`*.md`) for new files not yet in SQLite, creates a `tasks` row (`stage=intake`, `intake_kind` inferred: a stack-trace/`.log` → `error_file`), and moves the file into `REFINING/`. This realizes the "drop a bare error file → actionable work" requirement.
- **State is DB-driven, files mirror it:** we do not rely on folder location for truth (avoids the concurrency/query weakness of file-only); the DB `stage` is authoritative and the file is moved/rewritten to match. This is the "hybrid" chosen.
- Git ops via `subprocess` `git` (repo already uses `subprocess`); add a small `gitio.py` (read tracked files, write+`git add` artifacts, optional commit per project setting). Reads are plain filesystem; the tool sandbox restricts paths to `repo_path`.

---

## 4. Role catalog — default refinement process (13 roles + Orchestrator)

Modeled on real software-company functions. Seeded as global `roles` rows; **each is customizable/toggleable per project**. The Orchestrator chooses a subset + order per task type.

| # | Role key | Real-world analog | What it produces |
|---|----------|-------------------|------------------|
| 0 | `orchestrator` | Eng Manager / Refinement Lead | **Gatekeeper + router.** Builds the refinement plan, runs after each role, judges readiness, sets exit_state. (Not a queue role.) |
| 1 | `intake_triage` | Product Owner / BA | Normalizes raw intake or error file → structured problem statement, `intake_kind`, urgency, first-pass scope. **Entry role.** |
| 2 | `explorer` | Staff Eng / Onboarding | Grounds the task in real code: locates relevant files, entry points, existing patterns/utilities to reuse, affected surface. (Uses grep/read tools.) |
| 3 | `bug_investigator` | SRE / Debugging Eng | For bug/error kinds: reproduction logic, root-cause hypothesis, failing component, evidence from code. |
| 4 | `requirements_analyst` | Product Manager | User-facing intent + acceptance criteria; **flags ambiguities → can route to NEEDS_REVIEW**. |
| 5 | `architecture_review` | Software Architect / Staff+ | Design impact, module boundaries, proposed approach, alternatives, risks. |
| 6 | `security_review` | AppSec Engineer | Threat model, injection/authz/secrets/dependency risks, security acceptance criteria. |
| 7 | `performance_review` | Performance Engineer | Hot paths, complexity, resource/data-volume implications. |
| 8 | `api_design` | API Designer / Tech Lead | Contracts, signatures, endpoints, backward-compat. |
| 9 | `data_schema_review` | Data Eng / DBA | Schema/migration impact, integrity, indexing. |
| 10 | `style_conventions` | Code Reviewer | Alignment with repo conventions, naming, reuse of existing utilities. |
| 11 | `test_strategy` | QA / SDET | Test plan, acceptance tests, edge cases, coverage expectations. |
| 12 | `dependency_integration` | Build / DevEx Eng | External deps, versioning, integration points, CI/build impact. |
| 13 | `decomposition` | Tech Lead / Scrum Master | **Breaks refined work into epic → story → atomic task tree**, sequencing, dependencies, sizing. Produces child `tasks` rows. **Exit-adjacent role.** |

Optional extras a project can enable: `devops_release` (SRE/Release), `docs_review` (Tech Writer), `accessibility_review`, `cost_review`. Gets us into the 15+ range.

**Each role definition** = `title` + `system_prompt` (persona + what to inspect + required structured output) + `tools_json` (which repo tools it may call) + `applies_to` (task kinds). Heavy roles (2,3,5,6,7,9) get read/grep tools; light roles (10,11) may run on the assembled context pack alone to save cost.

---

## 5. Repo-aware role agents over OpenWebUI (the key new mechanism)

Because roles must read real code but the backend is OpenWebUI-only, add an **agentic tool-calling loop** in a new `agent_runner.py` (extends, does not replace, `submit_to_openwebui`):

1. Build request with OpenAI-style `tools` (function schemas) for a **repo-scoped toolset**: `read_file(path)`, `grep(pattern, glob)`, `list_dir(path)`, `glob(pattern)`, `read_artifact()`, `write_artifact_section(md)` — all path-sandboxed to `project.repo_path`/`PLANNING`.
2. POST to the existing endpoint with `tools`; if the model returns `tool_calls`, execute them locally against the repo, append results, loop (bounded by a per-role tool-call budget from `config_json`).
3. When the model returns a final message, parse a **required structured tail** (JSON block: `verdict`, `summary`, `open_questions`, plus the markdown section) — reuse the robust extraction in `parse_evaluator_response` (`orchestrator.py:251-290`).
4. **Graceful degradation:** if the endpoint/model rejects `tools` (many local models, e.g. `deepseek-r1`, lack function-calling), fall back to a **context-pack** path — the Orchestrator pre-runs `grep`/`read` heuristics for the task and injects the relevant files into the prompt, so the role still reasons over real code without live tool-use. Provider capability is probed once per project and cached.

Persist every run to `role_runs` (verdict, summary, output_md, tool_calls) and append `output_md` as a new section to the task's `REFINING/*.md` artifact.

---

## 6. Orchestrator redesign (router + gatekeeper)

Replace the linear `main()`/`process_task` (`orchestrator.py:336-445`) with a per-task state machine:

1. **Ingest** new `INTAKE/` files → `tasks` rows (§3).
2. **Plan:** if `refinement_plan_json` empty, Orchestrator (an LLM call with its own system prompt) proposes an ordered role list for this `intake_kind` (default templates per kind, e.g. `error_file` → triage → explorer → bug_investigator → arch → test → decomposition).
3. **Run next pending role** via `agent_runner` (§5) → write `role_runs` + artifact section.
4. **Gate:** after each role, Orchestrator evaluates accumulated verdicts:
   - any `needs_human` / unresolved `open_questions` past a threshold → **exit `needs_review`**, move artifact to `REVIEW/`, set `review_reason`.
   - all planned roles `pass` **and** readiness rubric met (atomic, acceptance criteria present, files identified, no open questions) → run `decomposition` if not yet, then **exit `ready_for_work`**, move to `READY/`.
   - a `blocker` verdict → either insert a remediation role or escalate to review.
   - otherwise → advance to next role (Orchestrator may insert/skip roles dynamically).
5. **Decomposition → epic/story/task:** the `decomposition` role emits a tree; Orchestrator creates child `tasks` rows via existing `create_subtask` pattern (`orchestrator.py:292-310`) with `level` = epic/story/task and `parent_task_id` links; large stories can re-enter refinement recursively. Related work is grouped under a shared epic artifact in `PLANNING/epics/`.

Keep the existing 5-min background-thread cadence (`app.py:163-206`) but make one invocation process **one role step per active task** (bounded), so long refinements stream progress rather than blocking. Fix the current `incomplete`-never-reprocessed bug by driving off `stage` not `status`.

**Readiness rubric** replaces the thin `check_completion_criteria` (`orchestrator.py:65-91`); store it per project (config) so "done" is tunable.

---

## 7. UI changes (`templates/`, `app.py`)

Keep the existing server-rendered Flask + industrial theme; add:
- **Projects page** — register a repo (path, name, model/workspace), list projects, enter a project. New routes `/projects`, `/projects/new`, `/project/<id>`.
- **Kanban board** (replaces the 3-bucket dashboard `index.html:253-334`) — columns by `stage`: INTAKE · REFINING · READY · REVIEW, cards showing role progress (e.g. "6/9 roles · at security_review"), `level` badge (epic/story/task), and exit_state.
- **Task detail** (`view_task.html`) — render the accumulating artifact with per-role sections + verdict chips (from `role_runs`), the epic→story→task tree, open questions, and (for REVIEW) a human action to approve → READY or send back with notes.
- **Role config editor** (per project) — enable/disable roles, edit `system_prompt`, reorder, set tools/model. Backed by `roles` table.
- **Intake form** — simple textarea *or* file upload that lands in `INTAKE/`.
- Fix leftover "Task Filename / .md" labeling (`create_task.html:170-172`).

---

## 8. Per-project customization

- Roles: global default catalog (§4) seeded once; per-project `roles` rows override prompt/enablement/order/tools/model. `list_roles(project_id)` merges (project row wins over global by `key`).
- Routing templates per `intake_kind`, readiness rubric, tool budget, timeouts, commit-artifacts on/off → `projects.config_json`.
- Model/workspace overridable at project and role level (falls back to `config.py` `DEFAULT_MODEL`/`DEFAULT_WORKSPACE`).

---

## 9. Implementation roadmap (phased)

1. **Foundation:** consolidate config loading; add `projects`/`roles`/`role_runs` tables + extend `tasks` (idempotent migrations in `init_db`); `db.py` CRUD for the new tables; `gitio.py` (register repo, scaffold `/PLANNING`, read/write artifacts).
2. **Role engine:** `agent_runner.py` (tool-calling loop + context-pack fallback + repo-scoped sandboxed tools); seed the default role catalog + system prompts.
3. **Orchestrator v2:** intake ingestion; plan/run/gate state machine; readiness rubric; decomposition → epic/story/task child rows; drive off `stage`.
4. **UI:** projects page, kanban board, task-detail with role sections + review actions, role config editor, intake form/upload.
5. **Polish:** per-project routing templates, provider tool-capability probe + caching, retire the orphaned legacy markdown store under `tasks/`, docs in README.

---

## 10. Critical files

- **Modify:** `db.py` (schema + CRUD), `orchestrator.py` (→ orchestrator v2, reuse `submit_to_openwebui`, `create_subtask`, `parse_evaluator_response`), `app.py` (routes + config), `templates/index.html` → kanban, `templates/view_task.html`, `templates/create_task.html`, `config.example.py` (new keys), `README.md`.
- **New:** `agent_runner.py`, `gitio.py`, `config_loader.py`, `roles_seed.py` (default catalog + prompts), `templates/projects.html`, `templates/project.html`, `templates/roles.html`.

---

## 11. Verification (end-to-end)

1. **Unit-ish:** `init_db()` on a fresh DB creates all tables + columns; re-running is idempotent. `list_roles(project_id)` returns global defaults, then reflects a project override.
2. **Repo registration:** register this Orchestra repo itself as a test project → `PLANNING/{INTAKE,REFINING,READY,REVIEW,epics}` scaffold appears; path sandbox rejects reads outside `repo_path`.
3. **Bare-error-file path (headline demo):** drop a real Python stack-trace file into `PLANNING/INTAKE/`, start the orchestrator, watch it: create a task (`intake_kind=error_file`), run triage → explorer → bug_investigator (confirm `role_runs` show real files were `read`/`grep`'d), and terminate at either `READY_FOR_WORK` with an atomic task spec or `NEEDS_REVIEW` with a reason. Inspect the materialized `READY/`/`REVIEW/` markdown.
4. **Decomposition:** submit a broad feature intake → confirm a `decomposition` run produces epic→story→task child `tasks` rows linked by `parent_task_id`, grouped under one epic artifact.
5. **Tool fallback:** point at a model without function-calling → confirm the context-pack fallback still grounds findings in real code and the loop completes without erroring.
6. **UI walk:** kanban shows the task moving INTAKE→REFINING→READY/REVIEW with per-role verdict chips; role config editor edits a project's `security_review` prompt and the next run uses it; REVIEW action approves a task into READY.
7. Run the app (`python3 app.py`, port 5001) and exercise the flow manually per §7.

---

## Open questions / refinement backlog

- **Auto-commit artifacts** per project vs. leave uncommitted (proposed default: write + `git add`, no commit).
- **Concurrency:** single-worker sequential assumed (matches today); parallel role execution is a later optimization.
- **Role loop guards:** cap on total roles/tool-calls per task to bound cost; what triggers auto-escalation to NEEDS_REVIEW vs. inserting another role.
- **Recursion depth** for epic→story→task re-refinement — how deep before requiring human sign-off.
- **Intake dedup** — how to detect the same error file re-dropped; fingerprinting.
- **Naming:** keep "Orchestra" or rename (e.g. "Refinery") for the repurposed product.
