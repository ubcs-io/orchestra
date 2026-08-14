# Autonomous Operation

Orchestra can generate its own work. **Watchers** scan a project during idle windows, propose candidate work items, triage them, and — under hard caps — turn the survivors into ordinary tasks that run through the normal pipeline. In the morning you get a report of what happened.

Everything here is **off by default, per project** (`config_json.autonomy.enabled: false`). A project that has never opted in is completely inert.

::: tip Turn on reliability first
Autonomous volume amplifies whatever failure rate you already have. The [run-health gate](/reference/reliability#run-health) and [evidence](/guide/execution#evidence) are what keep unattended work reviewable rather than a landfill — worth having in place before you hand the system its own queue.
:::

## The Watcher Loop

Watchers run on their **own loop**, independent of the task scheduler, started and stopped by the same UI control. Each round, for every project, it checks in order:

1. Is autonomy `enabled`?
2. Are we inside `activeHours` (weekends optionally all-day)?
3. Is the idle-window budget exhausted?

Then it runs every watcher that is enabled and **due** by its own `cadenceMinutes`, and finishes with [self-maintenance](#self-maintenance).

### The scan worktree

Watchers never touch your checkout, and never a task worktree. A dedicated scan worktree is prepared **at most once per project per round**, reset to base, and shared by every watcher that runs that round.

## The Watcher Catalog

`GET /api/watchers` returns what your build can actually run, so the editor never lists a watcher the backend doesn't have.

| Watcher | Default | Needs exec | What it proposes |
|---|---|---|---|
| `test-suite` | **on** | yes | Runs the project's test/typecheck commands against the clean scan worktree; proposes a fix task when the same failure appears **twice**. |
| `todo-scan` | off | no | TODO/FIXME/HACK/XXX comments older than `thresholdDays` (by `git blame`) — so decayed markers get resolved or deleted. |
| `branch-triage` | off | no | Local branches with unmerged commits that have gone quiet. Produces a *question* for the human; never deletes anything. |
| `doc-drift` | off | no | Documentation referring to code symbols that no longer exist anywhere in the source. |
| `lint-drift` | off | yes | Runs lint and proposes cleanup **only when the problem count grows** against the previous observation. |
| `dep-staleness` | off | yes | Outdated dependencies and high/critical advisories. The only watcher that reaches the package registry — offline-tolerant, and doubly inert until you both enable it and allowlist its commands. |

Only `test-suite` ships enabled, so turning autonomy on for the first time doesn't hand a repo six simultaneous new sources of self-generated work. Enable the rest one at a time, each with its own cap.

Exec-backed watchers stay inert until [command execution](/guide/execution#the-run-command-tool) is on with their commands in the allowlist — the editor badges them **needs exec** rather than silently doing nothing.

## Candidates & Triage

A watcher observation becomes a `candidates` row before it becomes anything else. Rows are kept after rejection, because the fingerprint index is what makes dedupe work.

| Status | Meaning |
|---|---|
| `pending` | Recorded, awaiting triage. |
| `queued` | Triage approved it; a task was created. |
| `rejected` | Triage judged it not worth doing. |
| `capped` | Would have been approved, but a cap blocked it. |
| `suppressed` | Matches a fingerprint a human closed as won't-do. |

A candidate whose fingerprint already exists in *any* state is dropped on sight. Closing a watcher-originated task as won't-do (including via the board's bulk action) suppresses its fingerprint, and recent suppression reasons are fed back into triage as context — so telling Orchestra "no" once actually sticks.

Triage itself is the `candidateTriage` [router call point](/reference/config#strategic-llm-routing-advisors): a small LLM call returning `worth_doing`, a `priority`, a `rationale`, and a suggested intake kind. **It is off by default, and when disabled the system fails toward *not* queuing** rather than auto-approving everything sight unseen.

Approved candidates become normal tasks with `origin: "watcher:<name>"` and the triage-assigned priority, and run through exactly the same flows, gates, and health checks as human-submitted work.

## Caps & Budgets

Four independent limits bound self-generated work:

| Limit | Default | Scope |
|---|---|---|
| `autoQueueDepth` | `5` | Max open (non-ready) watcher-originated tasks at once. |
| `perWatcherDailyCap` | 1–2 | Candidates from one watcher that may reach `queued` per UTC day. |
| `budgets.maxTaskStarts` | `10` | Watcher-originated task dispatches per idle window. |
| `budgets.maxTokens` | `2,000,000` | Summed tokens across watcher-originated runs per idle window. |
| `budgets.maxExecRuns` | `50` | Watcher scan command executions per idle window. |

### Idle windows

A project is **idle** after `idleAfterMinutes` (default 10) with no mutating API activity. The window's counters reset exactly once on the active → idle transition; while a human is active the window is cleared and nothing is ever "exhausted". Human work always preempts.

`GET /api/projects/:id/autonomy/budget` reports live consumption against each budget.

### The kill switch

Setting `enabled: false` (or `PATCH`ing the autonomy config) **aborts any in-progress scan for that project within one tick** — it doesn't merely stop future rounds from starting one.

## The Morning Report

`GET /api/projects/:id/morning-report?sinceHours=24` rolls up everything that happened in the window. It's **computed from what actually happened, never generated by a model** — so it costs nothing, still renders when the token budget is spent or the endpoint is down, and can't misreport the night it summarizes.

Three buckets, and the distinction matters:

- **Completed** — terminal *and* trusted-health work. The only section that claims success.
- **Parked** — reached a human-gated stage, or ended on an untrusted run.
- **In progress** — everything else that moved.

Plus run count, tokens used, health counts by tier, per-watcher activity (queued / rejected / capped / suppressed), budget status, and the count of self-generated tasks you haven't opened yet.

"Unseen" is server-side (`tasks.seen_at`, first-write-wins), so "new" means the same thing in every browser. `POST /api/tasks/seen` marks them read.

## Self-Maintenance

The system's own upkeep runs in the same idle window, under the same budgets, **after** the watchers — repo work first, housekeeping with what's left. Every sub-flag defaults on, because the parent autonomy switch is already off.

| Flag | What it does |
|---|---|
| `reprobeModels` | Probes and profiles any configured model with no [capability profile](/reference/reliability#model-capability-profiles) yet — a model pulled into Ollama at midnight is tuned by morning. A failed probe backs off for 24h, so one unreachable endpoint doesn't cost ~20 doomed requests every round forever. |
| `backfillDigests` | Regenerates the rolling [context digests](/reference/reliability#context-budgeting) that runs missed because the fire-and-forget call failed or was still in flight at shutdown. Five per round, so the backlog drains gradually instead of competing with real work. |

## Configuration

The whole block lives under a project's `config_json.autonomy`, read and written via `GET`/`PATCH /api/projects/:id/autonomy` or the **Roles Editor** UI. Patches are merged over the resolved config, so sending `{ "enabled": true }` can't clobber your watcher array.

```json
{
  "enabled": false,
  "activeHours": { "start": "22:00", "end": "07:00", "weekendsAllDay": true },
  "idleAfterMinutes": 10,
  "autoQueueDepth": 5,
  "budgets": { "maxTaskStarts": 10, "maxTokens": 2000000, "maxExecRuns": 50 },
  "watchers": [
    { "name": "test-suite", "enabled": true, "cadenceMinutes": 60, "perWatcherDailyCap": 2, "commands": ["test", "typecheck"] },
    { "name": "todo-scan", "enabled": false, "cadenceMinutes": 1440, "perWatcherDailyCap": 1, "thresholdDays": 30 }
  ],
  "selfMaintenance": { "enabled": true, "reprobeModels": true, "backfillDigests": true }
}
```

A config naming a watcher this build doesn't have is **ignored, not an error** — a config written against a newer build never crashes an older one.
