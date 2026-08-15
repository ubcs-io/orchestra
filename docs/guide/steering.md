# Steering & Interventions

Orchestra gives you full control over the refinement loop while it's running. You can steer any task in real time via the Task Detail page or the REST API.

## Live Visibility

- **SSE Stream** — watch the active role's reasoning, every file it reads, and every tool call it makes, in real time, rendered as structured role/tool/thinking/text/status events with inline markdown highlighting rather than a raw log
- **Coverage Map** — see which concerns each role examined, skipped, or ignored, rolled up across the entire task. Omissions are highlighted so you can notice that, for example, privacy was never reviewed

![Interactive live view — SSE role/tool stream, current state, steering, and coverage map](/screenshots/interactive-live-view.png)

![Live activity feed — a role's findings streaming in with inline markdown highlighting](/screenshots/live-activity.png)

![Coverage map — concerns rolled up as considered, skipped, out of scope, or never looked at](/screenshots/coverage-map.png)

## Interventions

All interventions are submitted via `POST /api/tasks/:id/interventions` with a JSON body of `{ "kind": "...", "payload": { ... } }`. Available kinds:

| Kind | Description |
|---|---|
| `pause` | Pause the task at the next role boundary. The orchestrator waits until you resume. |
| `resume` | Resume a paused task. |
| `deepen` | Re-queue a role to run again with increased depth (useful after adjusting a role's prompt or model, or when its analysis feels thin). |
| `inject_role` | Insert a one-off role into the plan at the current position. Provide the role key and it runs immediately. |
| `steer_note` | Add a free-text note that will be included in the context of upcoming roles. |
| `pin_question` | Pin a specific question for upcoming roles to address. |
| `promote_role` | Promote an injected role into standing project policy — it will auto-run on future tasks of the same intake kind. |
| `run_now` | Trigger the scheduler to process this specific task immediately, bypassing the idle poll interval. |
| `wont_do` | Close the task as won't-do — sets it to `ready` with `exit_state: "wont_do"` and pauses it, without waiting for the flow to run to completion. |
| `question_answer` | Answer an open question a role raised (surfaced via the review call-to-action). If the task is still refining, the answer is picked up on its next step; if it's already at `stage: "review"`, it's reincorporated immediately — see [Checkpoint Restore](#checkpoint-restore) below. |
| `approve_merge` | Approve a `code_change` task's branch and merge it into base. Handled immediately, since a review-stage task has no scheduler pass coming to consume a deferred intervention. |
| `request_changes` | Send a `code_change` task back for rework instead of merging, with an optional note. |
| `set_autonomy_level` | Override [how far this task may go unattended](/guide/execution#autonomy-levels) — `plan`, `edit`, or `auto`. `null` clears the override and inherits the project default. |
| `set_planning_rigor` | Override how much structure this task's decomposition may produce — `minimal`, `standard`, or `thorough`. `null` inherits the project default. |

## Task Lifecycle

- **Reset** — reset a task back to intake state (clears all refinement history)
- **Checkpoint Restore** — every completed role run leaves a git checkpoint (the commit right after its artifact commit). From the Task Detail page's role-run history, or `POST /api/tasks/:id/restore` with `{ "role_run_id": <id> }`, you can roll the task back to right after any of its own prior roles — discarding every run and unconsumed intervention after that point and resetting the task's plan/stage to resume from there, as if everything after it never happened. This is also what powers automatic [answer reincorporation](/reference/config#strategic-llm-routing-advisors): when the optional `answerReincorporation` router call point detects that a human's answer contradicts a role's earlier best-effort guess, it restores the task to that role's checkpoint for you and re-runs downstream steps with the corrected answer.
- **Subtasks** — create child tasks under a parent (useful for decomposition of complex work). Related tasks (a parent and its descendants) are color-grouped on the Project Board so a family stays visually identifiable as it grows.
- **Question decomposition** — any open question a role raises (surfaced via the review call-to-action on Task Detail) can be spun off with one click into its own child **Question Flow** subtask (`POST /api/tasks/:id/questions/decompose`), so a tangent gets its own focused refinement pass instead of derailing the parent. The child gets a full task page and can itself decompose its own open questions recursively; an inline chat box on the parent lets you ask it quick follow-ups without navigating away.
- **Edit** — modify a task's name or content while it's still in the intake stage
- **Merge review** — a task that wrote real source lands at `stage: "review"` awaiting an explicit decision. The "review branch" pill opens a file-level diff of the task branch against its base (`GET /api/tasks/:id/diff`), and `GET /api/tasks/:id/runs/:runId/diff` narrows the same view to a single role run. Approve, request changes, or push the branch / open a PR without leaving the page — see [the merge gate](/guide/execution#the-merge-gate)
- **Bulk actions** — close or hard-delete many tasks at once from the Project Board. Closing a watcher-originated task as won't-do also suppresses its [candidate fingerprint](/guide/autonomy#candidates-triage), so the same proposal doesn't come back tomorrow

## Run Health

Every completed run carries a [health badge](/reference/reliability#run-health) — `verified`, `healthy`, `recovered`, `degraded`, or `empty` — with a tooltip explaining *why*. It's worth reading before you trust a result you didn't watch:

- `degraded` and `empty` mean something went wrong with the run itself (truncation, a stall, a synthesized verdict), not with the code it looked at
- `verified` means the run's own commands were executed by the harness and came back green
- A `degraded` counter-reviewer always fails its gate; turning on `requireHealthyTerminal` extends the same distrust to the terminal step, so a task can't reach READY on a synthesized verdict

Board cards show a per-task degraded count, and `GET /api/stats/health?groupBy=model|role|mode` rolls the same data up so you can tell whether a bad night was one flaky role or one flaky model.

## Common Steering Patterns

### "I want to inject a Privacy Review"

1. While a spec task is running, submit an `inject_role` intervention with key `privacy_review`
2. The privacy reviewer inspects the codebase for data flows, retention, and minimization
3. Its findings are appended to the artifact, and coverage is updated
4. Optionally, `promote_role` so future tasks automatically include privacy review

### "The output is shallow — deepen it"

1. If a role's analysis feels thin, submit a `deepen` intervention
2. The role re-runs with extended tool budget and higher thinking verbosity
3. Its updated findings replace or supplement the previous output

### "I want to steer the conversation"

1. Submit a `steer_note` with specific guidance ("Make sure to check the auth middleware")
2. Upcoming roles see your note in their context and incorporate it

## API

See the [API Reference](/reference/api) for the full intervention endpoint documentation.