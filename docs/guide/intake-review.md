# Intake Review

By default, filing an intake starts work immediately: the kind you picked selects a flow, the flow runs, and the first honest read of *how big this actually is* happens several steps in, when the `explorer` role has read the files. By then the decomposition budget has already been drawn from that read.

**Intake review** is an optional pre-flight step that moves those decisions in front of you, before anything is spent. It rides parallel to the normal path — the "Create task" button behaves exactly as it always has.

## Why

Three routing decisions are fixed the moment you file a task, by you, before anyone has looked at the code:

- **The intake kind selects the whole flow.** A `chore` runs six roles with review only at the end; a `feature` runs ten with adversarial critique after every step. You are choosing between those before reading anything.
- **The network is never chosen at all.** From the board, a task always falls back to its intake kind's built-in flow. Every custom network you build is reachable only by editing the task afterwards.
- **The effort size is set mid-flight and is consequential.** `explorer` estimates XS–XL, and that letter picks the family decomposition budget outright — `S` allows 4 subtasks at depth 1, `L` allows 30 at depth 3 — while an `XS` verdict reroutes the task straight to implementation. Models systematically over-size copy changes (the string is in three files, so it reads as "M") and under-size refactors (the surface looks small until the call sites are traced).

You have a cheap advantage on exactly that last judgement. Review is where you get to use it.

## Using it

The intake panel has two buttons:

- **Create task** — today's behaviour, unchanged. The task starts immediately.
- **Review intake ▸** — the task is created identically, then held.

While held, Orchestra runs two roles against the real repository: `intake_triage` (what is being asked) and `explorer` (which files this touches). These are the first two steps of whichever flow you end up choosing, so this is not extra work — it is the same work, reordered, and it is reused rather than re-run once you accept.

The result is a **review card**, with every field editable:

| Field | What it decides |
|---|---|
| What is being asked | The normalized problem statement carried into every role's context |
| Kind | Which flow's criteria and counter-reviewer gate the task |
| Network | Which role graph runs — including your own custom networks |
| Roles | The exact ordered role plan; add, remove, or reorder |
| **Effort size** | The decomposition budget, shown live: *"M × standard → up to 12 subtasks, max depth 2"* |
| Planning depth | How much process is applied per unit of size (`minimal` ×0.6 / `standard` / `thorough` ×1.5) |
| Autonomy | How far this task may go unattended — `plan`, `edit`, `auto` |
| Assumptions | Questions the planner answered on your behalf, with its confidence — correct any that are wrong |

The budget line beside the size control is the point of the card. `effort_size` is otherwise an invisible letter with a large downstream consequence; rendering what it buys means you are steering "how many subtasks may this spawn", which is a question you have an opinion about.

Then:

- **Start** — accept, with your edits. The chosen flow is seeded with the two scout steps already complete, and the task runs.
- **Start as-is** — abandon the review; the intake runs exactly as filed. Pressed while the scout roles are still running, it takes effect at the next step boundary rather than interrupting a run mid-flight.
- **Save & hold** — close the card; the task stays parked until you come back.

Choosing **XS** at review takes the same fast path an `XS` verdict from `explorer` would have taken: straight to the developer/critic execution flow, with the same guards (never at `plan` autonomy, never at `thorough` planning depth, never for a research/brief-shaped task).

## What it costs

One planner call. The two scout roles are steps you were going to run anyway, and their runs are reused by the accepted plan rather than repeated. The exceptions are the `research`, `ux`, and `question` flows, which have no `explorer` step of their own — there, that one run is genuinely extra.

A size you set by hand is recorded as yours and is never overwritten by a later `explorer` re-run, including after a loop-back.

## Turning it on for everything

Review is per-intake by default. To review every intake in a project — including files dropped into the `INTAKE/` folder — set the project default:

```bash
curl -X PATCH localhost:5001/api/projects/1/intake-review \
  -H 'content-type: application/json' \
  -d '{"default":"on"}'
```

The two buttons swap emphasis, and "Create task" becomes the explicit bypass. Watcher-generated work is deliberately unaffected: turning review on for yourself never parks [autonomous work](/guide/autonomy) on a human.

## When the planner is off

The card works with no LLM call at all. If the [`intakePlanning` router call point](/reference/config#strategic-llm-routing-advisors) is disabled, fails, or times out, the card is filled with the **heuristic proposal** — the kind already inferred, that kind's default network, `explorer`'s own size, your project's planning depth. In other words, exactly what the task would have done without the review, labelled as such.

That is a deliberate ordering: the steering wheel is the feature, and the planner call only improves its starting position.

## API

| Endpoint | Purpose |
|---|---|
| `POST /api/projects/:id/intake` with `{"review": true}` | File an intake into review |
| `GET /api/tasks/:id/intake-proposal` | The proposal, network catalog, role catalog, and budget preview |
| `POST /api/tasks/:id/intake-proposal/accept` | Accept, optionally with an edited `proposal` body |
| `POST /api/tasks/:id/intake-proposal/skip` | "Start as-is" |
| `GET` / `PATCH /api/projects/:id/intake-review` | Read/set the project default |

A task in review carries `intake_review_state`: `scouting` (the prefix is running), `proposed` (waiting on you), `accepted`, or `skipped`. It is `null` on every task that took the direct path.
