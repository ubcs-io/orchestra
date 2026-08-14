# Roles Catalog

Orchestra ships with **25 roles** seeded as global defaults. Each role is customizable per project — you can edit its system prompt, assigned tools, model, or enable/disable it via the Roles Editor UI or `PUT /api/projects/:id/roles/:key`.

Roles are organized into four groups: spec-track, research/UX-track, counter-reviewers, and the cross-cutting `critic`.

## Spec-Track Roles

| Key | Title | Tools | Applies to |
|---|---|---|---|
| `intake_triage` | Intake Triage (Product Owner / BA) | read-only | all |
| `explorer` | Explorer (Staff Engineer / Onboarding) | read-only | all |
| `bug_investigator` | Bug Investigator (SRE / Debugging) | read + git_history | bug, error_file |
| `requirements_analyst` | Requirements Analyst (Product Manager) | none (context-only) | feature, manual, chore |
| `architecture_review` | Architecture Review (Software Architect) | read-only | feature, bug, error_file, manual, spike, security |
| `security_review` | Security Review (AppSec Engineer) | read + git_history | feature, bug, security |
| `privacy_review` | Privacy Review (Privacy Engineer) | read-only | feature, bug, security |
| `performance_review` | Performance Review (Performance Engineer) | read-only | feature, bug |
| `api_design` | API Design (API Designer / Tech Lead) | read-only | feature |
| `data_schema_review` | Data & Schema Review (Data Engineer / DBA) | read-only | feature, bug |
| `style_conventions` | Style & Conventions (Code Reviewer) | read-only | chore, feature |
| `test_strategy` | Test Strategy (QA / SDET) | read-only | feature, bug, error_file, manual, chore, security |
| `dependency_integration` | Dependency & Integration (Build / DevEx) | read-only | feature |
| `decomposition` | Decomposition (Tech Lead / Scrum Master) | read-only | all spec kinds _(terminal for `spec`)_ |
| `developer` | Developer (Implementation Engineer) | none by default — [write/edit/exec are opt-in](/guide/execution) | the execution flow _(see below)_ |

::: tip `explorer` sizes the work
`explorer` is the one role that has actually read the files before anyone estimates scope, so it also sets the task's `effort_size` (XS–XL). That number gates how much further planning happens — see [planning rigor & effort sizing](/reference/config#planning-rigor-effort-sizing).
:::

## Research/UX-Track Roles

| Key | Title | Tools | Applies to |
|---|---|---|---|
| `ux_review` | UX Review (Product Designer) | read-only | ux |
| `user_research` | User Research (UX Researcher) | none (context-only) | ux, research |
| `options_exploration` | Options Exploration (Staff Engineer / Design Lead) | read-only | research, ux, spike, question |
| `edge_case_analysis` | Edge Case Analysis (QA / Design) | read-only | research, ux, feature |
| `research_synthesis` | Research Synthesis (Tech Lead) | none (context-only) | research, ux, question _(terminal)_ |

## Counter-Reviewers

Counter-reviewers gate a flow by verifying prior output against predefined acceptance criteria. They do **not** author new content — they check that existing findings meet the bar.

| Key | Title | Tools | Gates |
|---|---|---|---|
| `bug_review` | Bug Review (Verification Engineer) | read + git_history | bug, error_file |
| `security_review_adversary` | Adversarial Security Review (Red Team) | read + git_history | security |
| `spec_review` | Spec Review (Verification Tech Lead) | read-only | feature, manual, chore, spike |
| `brief_review` | Brief Review (Verification Lead) | none (context-only) | research, ux, question |

## Cross-Cutting Critique

| Key | Title | Tools | Applies to |
|---|---|---|---|
| `critic` | Critic (Adversarial Domain Reviewer) | none (context-only) | all — runs per-step |

`critic` is not a flow-terminal gate like the counter-reviewers above — it runs immediately after an individual step and judges **only that step's output**, not the whole task. Its bar is deliberately extreme: it stays silent (`pass`) unless the step commits a genuine, high-severity domain violation (e.g. exposing PII, an authz bypass, an irreversible data-loss migration, a legal/compliance breach), in which case it sets `blocker` (or `needs_human` if ambiguous but serious). Its verdict folds into the step's effective verdict without ever silently downgrading it, and it's persisted as a separate `role_runs` row (`run_kind: "critique"`, linked to the primary run via `target_run_id`) — the primary role's output is never overwritten.

How often `critic` fires is controlled per flow by a `reviewDepth` setting:

| `reviewDepth` | Behavior | Flows |
|---|---|---|
| `every_step` | Runs after every non-terminal, non-reviewer step | `security`, `feature` |
| `terminal_only` | Runs once, scoped to the reviewer step | `error_file`, `bug`, `manual`, `chore`, `spike`, `research`, `ux`, `question` |
| `none` | Never runs | — |

`requirements_analyst` is marked `critiqueExempt` (it's context-only with no tool-derived findings to adversarially check, so it's skipped even under `every_step`).

If a critique on a non-reviewer step comes back `blocker`, the orchestrator can loop back to the responsible role once (bounded independently of the flow's own `maxLoopbacks`) before escalating — so a serious domain violation can be caught and re-run well before the flow's own counter-reviewer ever runs. When the optional [second-review router advisor](/reference/config#strategic-llm-routing-advisors) is enabled, its authoritative synthesis of the primary run + critique can also let a critic false-positive proceed instead of forcing a loop-back.

Custom [agent networks](/guide/networks) expose the same mechanism via a per-node `critics: string[]` field (defaulting to `["critic"]` on non-terminal, non-reviewer nodes) and a network-level `reviewDepth` in its metadata.

## Role Tools

Roles are assigned tool sets that define what they can do:

| Tool Set | Tools | Used By |
|---|---|---|
| **read-only** | `read`, `grep`, `find`, `ls` | Most code-inspecting roles |
| **read + git_history** | above + `git_history` (recent commit inspection) | Bug investigators, security reviewers |
| **none** | context-only reasoning | Lightweight roles (requirements analyst, research synthesis, brief review) |
| **write** | `write`, `edit` | Nobody by default. Requires `allowWrite` on the project's [harness policy](/guide/execution); worktree-jailed. |
| **exec** | `run_command` | Nobody by default. Requires `allowExec` **and** a non-empty command allowlist. |

Every role also has two platform tools that aren't part of its tool set: `report_section`, which appends report prose to the task artifact durably as the role works, and `record_findings`, which delivers the verdict trailer. See [artifact-first output](/reference/reliability#artifact-first-output).

## Flow Templates

Each intake kind maps to a flow — a specific sequence of roles with a counter-reviewer, plus a `reviewDepth` that controls how often `critic` runs alongside it:

| Intake Kind | Steps | `reviewDepth` |
|---|---|---|
| `error_file` | intake_triage → explorer → bug_investigator → architecture_review → test_strategy → **bug_review** → decomposition | `terminal_only` |
| `bug` | intake_triage → explorer → bug_investigator → architecture_review → test_strategy → **bug_review** → decomposition | `terminal_only` |
| `security` | intake_triage → explorer → security_review → privacy_review → architecture_review → test_strategy → **security_review_adversary** → decomposition | `every_step` |
| `feature` | intake_triage → requirements_analyst → explorer → architecture_review → api_design → data_schema_review → security_review → test_strategy → **spec_review** → decomposition | `every_step` |
| `manual` | intake_triage → explorer → requirements_analyst → architecture_review → test_strategy → **spec_review** → decomposition | `terminal_only` |
| `chore` | intake_triage → explorer → style_conventions → test_strategy → **spec_review** → decomposition | `terminal_only` |
| `spike` | intake_triage → explorer → options_exploration → architecture_review → **spec_review** → decomposition | `terminal_only` |
| `research` | intake_triage → user_research → options_exploration → edge_case_analysis → **brief_review** → research_synthesis | `terminal_only` |
| `ux` | intake_triage → ux_review → user_research → options_exploration → edge_case_analysis → **brief_review** → research_synthesis | `terminal_only` |
| `question` | intake_triage → explorer → options_exploration → **brief_review** → research_synthesis | `terminal_only` |

**Bold** roles are counter-reviewers. `security` and `feature` are the two highest-rigor flows, so `critic` checks every step rather than just the reviewer step.

### The execution flow

One further flow is not tied to an intake kind. It produces the third exit shape, `code_change`:

| Flow | Steps | `reviewDepth` |
|---|---|---|
| execution | **developer** → **critic** | `none` |

A task enters it either as a decomposition leaf flagged `execution_ready`, or via the XS fast path from `explorer`. `reviewDepth` is `none` because `critic` *is* the review step here rather than a producer being reviewed — its own verdict is the sole automated gate before human merge review. Where the project's [command allowlist](/guide/execution#the-run-command-tool) defines `test` or `typecheck`, matching evidence criteria are attached automatically and must run green.

See [Writing & Running Code](/guide/execution) for the full picture.

## Per-Project Customization

Via `GET /api/projects/:id/roles` and `PUT /api/projects/:id/roles/:key` you can override any role for a specific project:

- Change the system prompt (persona)
- Change the assigned tools
- Override the model
- Disable a role entirely (it will be skipped in flows)

Project overrides are stored in SQLite and persist across restarts.

## Role Usage Stats

The Roles Editor shows per-role-key pills — **calls**, **pass** (verdict = pass), **review** (counter-reviewer/critique passes), **nets** (agent networks containing the role), and total **tokens** — aggregated across every project via `GET /api/roles/stats`. Use it to spot roles that never pass, rarely get exercised, or burn disproportionate tokens.

## Version History & Outcome Scoring

Those lifetime totals have a structural blind spot: they aggregate across **all time**, mixing every prompt a role has ever had into one number. They can tell you a role is good; they can never tell you last week's edit made it worse.

So every edit to a role's **prompt, tools, or model** records a `role_versions` row and repoints `roles.current_version_id`. Nothing about dispatch changes — the live `roles` row is still what runs; this is a paper trail behind it. Every run is stamped with the version that produced it (`role_runs.role_version_id`), and that stamp is what turns per-run outcome data into per-version outcome data.

Edits to fields that can't change output — title, ordering, enabled — update in place without minting a version.

Open **History** under any role in the Roles Editor for the list, a line diff against the live prompt, and a one-click revert. Each version carries:

| Metric | Meaning |
|---|---|
| `runs` | Primary runs attributed to this version. Runs predating versioning have no stamp and are excluded rather than guessed at. |
| `pass_rate` | Verdict = pass, over this version's own runs. |
| `loopback_rate` | The counter-reviewer sent it back — over `reviewed_runs`, not all runs, so a role that's never critiqued reads 0 rather than looking perfect. |
| `critique_flag_rate` | The critique marked at least one criterion failed, regardless of its overall verdict. A softer signal than the verdict alone. |
| `human_override_rate` | The task later drew a checkpoint restore, a change request, or a won't-do. |
| `degraded_rate` | Runs whose [health](/reference/reliability#run-health) was below `healthy` — a version that only reaches `pass` via repair or fallback is doing worse than its raw pass rate suggests. |
| `sample_warning` | Fewer than 5 runs. |

**Revert is never destructive.** It records a *new* version whose content matches the old one, leaving the intervening versions in the history with their own scores — "we tried that and it was worse" is information, and rewriting it away would destroy the record the scoring is built on. A revert is still checked against today's harness policy: an old version granting `write`/`edit` can't come back through that door while the project says no.

::: warning Two things a score can't tell you
**Small samples aren't verdicts.** A version with 2 runs and a bad pass rate isn't worse, it's underpowered — hence `sample_warning`, and why the panel labels rather than ranks below the floor.

**Difficulty confounds.** A version can score worse purely because it drew harder intakes. What's guaranteed is only that each run counts against the version that actually produced it; comparing across different kinds of work is on you.

Relatedly, a version that changed prompt **and** model at once can't attribute its score to either — the editor badges that as a *mixed edit*. It's a nudge to change one thing at a time, not a block.
:::

## Open Questions

A role isn't required to fully resolve everything it encounters. Alongside `verdict`, `coverage`, and `section_md`, `record_findings` accepts `open_questions`: an array of `{ question, assumed_answer, confidence }`. Every open question must carry the role's own best-effort guess and a confidence (`low`/`medium`/`high`) — this keeps the pipeline moving instead of stalling, so `blocker`/`needs_human` verdicts are reserved for questions with no reasonable guess at all. These surface on the Task Detail review call-to-action, where a human can answer them directly, spin one off into its own [Question Flow subtask](/guide/steering#task-lifecycle), or — if the answer contradicts the guess — trigger the [Answer Match Assessment](/reference/config#strategic-llm-routing-advisors) router call point to roll the task back and redo the affected work.