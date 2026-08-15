# Reliability & Model Profiles

Orchestra is built for **local, low-context models**, which are unusually bad at exactly what a multi-role pipeline used to demand of them: emitting one long, perfect JSON blob at the end of a run, calling custom tools reliably, and keeping an unbounded transcript in context. This page documents the machinery that makes a role run survive those failure modes — and the measurements that let Orchestra tune itself to whatever model you point it at.

## Artifact-First Output

A role's write-up is no longer carried inside its structured payload. As each section of its report is finished, the role calls the `report_section` tool and the prose is **durably appended to the task's artifact right then**, mid-run. What still has to arrive as structure is a small verdict trailer — verdict, summary, coverage, open questions.

The consequence: a failed or truncated trailer costs you the ~4-field verdict, never the analysis. `role_runs.artifact_bytes` records how much prose a run durably wrote, which is also what distinguishes a `degraded` run from an `empty` one below.

## The Verdict Delivery Ladder

Every run tries to obtain its verdict by the most reliable mechanism the endpoint supports, and falls down the ladder on failure. The rung that actually worked is recorded on the run as `verdict_source`:

| `verdict_source` | Mechanism | Notes |
|---|---|---|
| `constrained` | A separate, tool-free completion constrained by the inference server (`json_schema` / `guided_json` / GBNF grammar) | Schema-valid by construction. Preferred when the endpoint supports it. |
| `tool` | The `record_findings` custom tool call | The classic path; fine on models with solid function calling. |
| `fence` | A trailing JSON fence parsed out of the answer text | Also yields the surrounding prose as the report. |
| `repair` | One cheap, stateless formalize call that reconstructs the trailer from what the role already produced | See [Repair & Resume](#repair-resume). |
| `fallback` | A synthesized verdict — no usable structure ever arrived | The only rung that counts as a failure. Drives `degraded`/`empty` health. |

### Constrained decoding

Support is a property of the **endpoint**, not the model, so Orchestra probes for it rather than assuming: `POST /api/config/probe-structured-outputs` tests `json_object`, `json_schema`, `guided_json`, and `grammar` against the configured connection and caches the result on the model config (`structured_outputs_json`). For `grammar`-capable servers (llama.cpp and friends), Orchestra compiles the verdict schema to GBNF itself.

If nothing is supported, the ladder simply starts a rung lower — no configuration required.

## Repair & Resume

When every in-session channel fails, Orchestra does **not** rerun the role from zero. It spends one cheap stateless call to rebuild the trailer from material the role already produced (its report sections plus the reasoning tail), because in most degraded runs the analysis exists and only the serialization failed.

Two columns on `role_runs` record what happened:

- `attempt` — 1-based attempt index; `>1` means this run followed an interrupted earlier one.
- `resumed_from` — the `role_runs` id this run resumed from.

Both feed the health taxonomy: a run that needed either is `recovered`, never `healthy`.

## Run Health

Every run gets a health record computed from raw signals (`server/src/health.ts`), surfaced as a badge in the UI and aggregated at `GET /api/stats/health`.

| Health | Meaning |
|---|---|
| `verified` | Clean run **and** every command it executed came back green (see [Grounded verification](/guide/execution#evidence)). |
| `healthy` | Clean run: a real verdict on the normal path, no degradation signals. |
| `recovered` | A real verdict, but only after a repair pass or a resume. |
| `degraded` | Verdict synthesized after every channel failed, or output truncated at the token limit, or the run stalled — but it produced *something*. |
| `empty` | Nothing durable came out: no artifact bytes, no report. |

**A red test suite is not bad health.** A run that executed commands and got a failing one is still `healthy` — the run worked, it just reported bad news. Failing evidence is a *gate* concern, not a run-health concern.

### Where health is enforced

| Enforcement point | Default |
|---|---|
| **The counter-reviewer gate.** A reviewer run that came back `degraded` or `empty` fails the gate outright — a fallback run's empty or defaulted criteria results must not slip through a path that only checks the verdict string. | Always on |
| **The critique prompt.** An untrusted producing run is flagged to the `critic` with the reason, so it weights a synthesized or reconstructed verdict accordingly instead of taking it at face value. | Always on |
| **The terminal gate.** A `degraded`/`empty` terminal run loops back (bounded by the flow's `maxLoopbacks`, with a steer note explaining why) and then escalates to REVIEW rather than promoting the task to READY on a synthesized verdict. `recovered` is allowed through — repair and resume produced a *real* verdict. | Opt-in: `config_json.requireHealthyTerminal` |

`GET /api/stats/health?groupBy=model|role|mode` rolls health up across runs. `mode` buckets by `verdict_source`, which is how you find out that (say) a particular model only ever succeeds via the `fence` rung.

## Model Capability Profiles

Compatibility used to be hand-set per connection (`textMode`, `twoPhase`, nudge thresholds, `supportsDeveloperRole`, …). Those flags are now **measured** per `(connection, model)` pair and stored in the `model_profiles` table.

### Probing

`GET /api/model-configs/:id/probe-profile/stream` runs a behavioral probe suite — roughly 20 small requests, 1–2 minutes on a local box — and streams progress over SSE. It observes, as evidence rather than conclusions:

- constrained-decoding modes the endpoint accepts
- whether a well-formed **custom** tool call arrives (5 trials)
- whether a **built-in** tool call arrives (5 trials) — this is what separates "can't custom-tool" from "can't tool at all"
- whether a fenced-JSON instruction parses (5 trials)
- the thinking dialect (`reasoning_content` / `<think>` tags / none)
- whether `developer`-role messages and `reasoning_effort` are accepted, and which max-tokens field the endpoint wants
- the advertised context length from `/models`, when exposed

A channel counts as reliable at **≥80%** (4 of 5 trials).

### Derived decisions

From that evidence Orchestra derives the two decisions that actually shape a run:

| Decision | Values |
|---|---|
| `runShape` | `single-turn` (custom tool calls are reliable) · `two-turn` (explore with built-ins, formalize separately — the old `twoPhase`) · `text` (fenced JSON only — the old `textMode`) |
| `verdictDelivery` | `json_schema` · `guided_json` · `grammar` · `tool_call` · `fence` |

plus `toolCapable`, `reasoning`, `supportsDeveloperRole`, `supportsReasoningEffort`, and `maxTokensField`. Each derived field carries a `rationale` string saying which probe or live statistic drove it.

### Live calibration

Probes only pick a safe *starting* mode; real runs are the real signal. Over a rolling window of the **most recent 30 primary runs**:

- a `single-turn` model whose fallback share exceeds **10%** is demoted to `two-turn` — immediately, since that's a safety response to fresh evidence;
- a demoted model whose window is at least **98% clean** earns a promotion **suggestion**, surfaced in the UI and never auto-applied;
- fewer than **10 runs** in the window is treated as noise and acted on not at all;
- mode changes are rate-limited to once per **30 runs** (hysteresis, so a flaky model can't flap).

### Overrides

`PATCH /api/model-configs/:id/profile/overrides` replaces the profile's override bag; each field wins over the derived value. On a model's **first** probe, whatever hand-flags the connection already had are imported as overrides, so turning profiling on changes nothing on day one. Re-probe with `?reset=1` to discard them and run fully measured. `DELETE /api/model-configs/:id/profile` forgets the profile entirely — the recovery path when a silent quantization or server change invalidates it.

## Context Budgeting

Rather than hoping a run fits, Orchestra computes a per-run token budget and allocates against it. Every piece of context is a **part** with a priority tier and a list of candidate renderings, most detailed first; the allocator walks tiers in order and gives each part the most detailed rendering that still fits.

| Tier | Content | Degrades to |
|---|---|---|
| 1 | Task header, contract, human steering, human answers | never dropped |
| 2 | Acceptance criteria, current-step steering | never dropped for roles that need them |
| 3 | Intake content | head + tail |
| 4 | Prior-run summaries | recent-K in full + one-liners, then a single paragraph |
| 5 | Open questions | a capped, highest-priority subset plus a count |

Runs record what this cost them: `context_tokens_est`, `context_degraded` (set when anything rendered below full detail or was dropped), plus `digest` and `carry_forward` — the rolling summary and explicit step-to-step handoff that keep long chains viable in an 8k–32k window. Digests that failed or were still in flight at shutdown are regenerated later by [self-maintenance](/guide/autonomy#self-maintenance).

::: warning Shadow mode by default
Budgeting ships in **shadow mode**: every run computes and records `context_tokens_est` and `context_degraded`, but the full, undegraded prompt is what actually gets sent. Set `config_json.contextBudget: true` on a project to send the budgeted, tier-degraded assembly instead. Running in shadow first lets you see what *would* have been trimmed before anything is.
:::
