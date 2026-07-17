# Roles Catalog

Orchestra ships with **24 roles** seeded as global defaults. Each role is customizable per project — you can edit its system prompt, assigned tools, model, or enable/disable it via the Roles Editor UI or `PUT /api/projects/:id/roles/:key`.

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
| `decomposition` | Decomposition (Tech Lead / Scrum Master) | read-only | all spec kinds _(terminal)_ |

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

## Per-Project Customization

Via `GET /api/projects/:id/roles` and `PUT /api/projects/:id/roles/:key` you can override any role for a specific project:

- Change the system prompt (persona)
- Change the assigned tools
- Override the model
- Disable a role entirely (it will be skipped in flows)

Project overrides are stored in SQLite and persist across restarts.