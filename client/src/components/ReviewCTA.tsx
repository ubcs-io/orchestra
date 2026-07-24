import { useState } from "react";
import {
  api,
  isEvidenceGreen,
  parseEvidence,
  type Task,
  type RoleRun,
  type CoverageMap,
  type ExecEvidence,
  type Intervention,
} from "../api";
import { QuestionDecomposeButton, DecomposedChildCard } from "./QuestionDecompose";
import { EvidencePanel } from "./EvidencePanel";

export interface ReviewCTAProps {
  taskId: string;
  task: Task;
  recapMd: string | null;
  coverage: CoverageMap | null;
  runs: RoleRun[];
  interventions: Intervention[];
  childTasks: Task[];
  /** Call after any mutation to refresh data. */
  onMutate: () => void;
  /** Open the task's diff modal (DiffPanel) — lifted to the parent so this
   *  panel and the header's "review branch" pill share one instance. */
  onOpenDiff: () => void;
}

/**
 * The verification evidence that stands at the merge gate (PLANNING/overhaul/05):
 * the most recent execution of each distinct command across the task's primary
 * runs. "Most recent" matters — the developer's run and the critic's independent
 * re-run of the same suite are two records of one question, and only the latest
 * answer describes the code as it stands now.
 */
export function latestEvidenceByCommand(runs: RoleRun[]): ExecEvidence[] {
  const latest = new Map<string, ExecEvidence>();
  for (const run of runs) {
    if (run.run_kind && run.run_kind !== "primary") continue;
    for (const e of parseEvidence(run.evidence_json)) latest.set(e.name, e);
  }
  return [...latest.values()];
}

/** Extract action items from recap_md, coverage, and runs. */
function extractActionItems(
  recapMd: string | null,
  coverage: CoverageMap | null,
  runs: RoleRun[],
): string[] {
  const items: string[] = [];

  // 1. Parse an Action Items / Next Steps / Recommendation(s) section from the
  //    recap. The recap prompt (server/src/orchestrator.ts's generateRecap) is
  //    deliberately free-form — it never mandates a specific heading — so this
  //    must recognize every phrasing a model reasonably picks for "here's what
  //    to do next", and both bullet and numbered lists (a model as often
  //    writes "1. Implement..." as "- Implement..."). Shares its header/list
  //    regexes with extractRecoveryCandidates below for the same reason.
  if (recapMd) {
    items.push(...extractListSection(recapMd, ACTION_SECTION_HEADER_RE));
  }

  // 2. Fallback: decomposition role output. Prefer the structured subtasks_json
  //    (name per node); fall back to regex-parsing [epic]/[story]/[task] bullets
  //    in output_md for runs recorded before subtasks_json existed.
  if (items.length === 0) {
    const decomp = runs.find((r) => r.role_key === "decomposition");
    if (decomp?.subtasks_json) {
      try {
        const parsed = JSON.parse(decomp.subtasks_json) as Array<{ name?: string }>;
        for (const node of parsed) {
          if (node?.name) items.push(node.name.trim().slice(0, 200));
        }
      } catch {
        // fall through to the legacy regex path
      }
    }
    if (items.length === 0 && decomp?.output_md) {
      const labelRe = /\[(epic|story|task)\]\s*(.+)/gi;
      let lm;
      while ((lm = labelRe.exec(decomp.output_md)) !== null) {
        items.push(lm[2]!.trim().slice(0, 200));
      }
    }
  }

  // 3. Fallback: coverage gaps.
  if (items.length === 0 && coverage) {
    for (const [concern, entry] of Object.entries(coverage)) {
      if (entry.status === "never") {
        items.push(`${concern} — not yet evaluated`);
      }
    }
  }

  return items.slice(0, 8);
}

const ACTION_SECTION_HEADER_RE =
  /^#{2,4}\s+(?:action\s*items?|next\s*steps?|recommended\s+update\s+strategy|recommendations?)\s*$/im;
const LIST_ITEM_RE = /^(?:[-*]|\d+[.)])\s+(.+)$/gm;

/** Extract the bullet/numbered items under the first matching heading in `md`. */
function extractListSection(md: string, headerRe: RegExp): string[] {
  const hdr = headerRe.exec(md);
  if (!hdr) return [];
  const afterHeader = md.slice(hdr.index + hdr[0].length);
  const nextHeader = afterHeader.search(/^#{2,4}\s+/m);
  const section = nextHeader >= 0 ? afterHeader.slice(0, nextHeader) : afterHeader;
  const items: string[] = [];
  const re = new RegExp(LIST_ITEM_RE.source, LIST_ITEM_RE.flags);
  let m;
  while ((m = re.exec(section)) !== null) {
    const text = m[1]!.trim();
    if (text && !text.startsWith("---")) items.push(text.slice(0, 200));
  }
  return items;
}

/** True (returning the run) when the terminal decomposition role failed to
 *  produce either a subtask tree or an explicit reason it's already atomic —
 *  mirrors the server's own zero-subtask escalation check (orchestrator.ts). */
export function findFailedDecomposition(runs: RoleRun[]): RoleRun | null {
  const decomp = [...runs].reverse().find((r) => r.role_key === "decomposition");
  if (!decomp) return null;
  if (decomp.no_decomposition_reason?.trim()) return null;
  let hasSubtasks = false;
  if (decomp.subtasks_json) {
    try {
      const parsed = JSON.parse(decomp.subtasks_json) as unknown[];
      hasSubtasks = Array.isArray(parsed) && parsed.length > 0;
    } catch {
      hasSubtasks = false;
    }
  }
  return hasSubtasks ? null : decomp;
}

/** Pure: parse a decomposition section for [epic]/[story]/[task] bullets, or
 *  (as a second pass, only if that finds nothing) a numbered/tree-drawing
 *  prose format some models produce instead of the structured `subtasks`
 *  array, e.g. "1. Epic: Foo" / "├── 2. Story: Bar" — mirrors
 *  parseDecompositionTree in server/src/orchestrator.ts. */
function parseDecompositionTreeNames(md: string): string[] {
  const bracketRe = /\[(?:epic|story|task)\]\s*(.+)/gi;
  const out: string[] = [];
  let m;
  while ((m = bracketRe.exec(md)) !== null) out.push(m[1]!.trim().slice(0, 200));
  if (out.length) return out;

  const treeRe = /^[\s│├└─]*\d+\.\s*(?:epic|story|task)\s*:\s*(.+)$/gim;
  while ((m = treeRe.exec(md)) !== null) out.push(m[1]!.trim().slice(0, 200));
  return out;
}

/** When decomposition fails, salvage whatever actionable list an earlier role
 *  already produced so the human isn't left with nothing to act on — later
 *  roles in the pipeline often add little beyond confirming that first
 *  analysis anyway. Scans roles in pipeline order (skipping the failed
 *  decomposition run itself) and returns the first usable list found,
 *  preferring a structured subtasks_json (any role's record_findings call can
 *  include one, not just a can_create_subtasks role's) over parsing a
 *  "Recommended Update Strategy"/"Next Steps" prose section. Finally falls
 *  back to the decomposition run's own output_md — the model often renders a
 *  correct tree there even when it left the structured `subtasks` array
 *  empty (see findFailedDecomposition), so this is the difference between
 *  telling the human "nothing usable was found" and showing them the
 *  breakdown that's actually sitting right there. */
export function extractRecoveryCandidates(
  runs: RoleRun[],
): { roleKey: string; items: string[] } | null {
  let decomp: RoleRun | undefined;
  for (const r of runs) {
    if (r.role_key === "decomposition") {
      decomp = r;
      continue;
    }
    if (r.subtasks_json) {
      try {
        const parsed = JSON.parse(r.subtasks_json) as Array<{ name?: string }>;
        const items = parsed
          .map((node) => node?.name?.trim())
          .filter((n): n is string => !!n)
          .map((n) => n.slice(0, 200));
        if (items.length > 0) return { roleKey: r.role_key, items: items.slice(0, 10) };
      } catch {
        // fall through to prose parsing below
      }
    }
    if (r.output_md) {
      const items = extractListSection(r.output_md, ACTION_SECTION_HEADER_RE);
      if (items.length > 0) return { roleKey: r.role_key, items: items.slice(0, 10) };
    }
  }
  if (decomp?.output_md) {
    const items = parseDecompositionTreeNames(decomp.output_md);
    if (items.length > 0) return { roleKey: decomp.role_key, items: items.slice(0, 10) };
  }
  return null;
}

/** A role's open question together with its own best-effort guess — mirrors
 *  server/src/agent.ts's OpenQuestion. Tolerates the legacy plain-string form
 *  stored before questions carried a guess/confidence/resolution. */
export interface ClientOpenQuestion {
  question: string;
  assumed_answer: string;
  confidence: "low" | "medium" | "high";
  resolved: "assumed" | "confirmed" | "invalidated";
}

export function normalizeQuestion(raw: unknown): ClientOpenQuestion | null {
  if (typeof raw === "string") {
    return raw.trim()
      ? { question: raw, assumed_answer: "", confidence: "low", resolved: "assumed" }
      : null;
  }
  if (raw && typeof raw === "object" && typeof (raw as { question?: unknown }).question === "string") {
    const o = raw as Partial<ClientOpenQuestion>;
    return {
      question: o.question!,
      assumed_answer: o.assumed_answer ?? "",
      confidence: o.confidence ?? "low",
      resolved: o.resolved ?? "assumed",
    };
  }
  return null;
}

/** Collect all open questions grouped by role, skipping runs with no questions. */
export function collectQuestions(
  runs: RoleRun[],
): Array<{ runId: number; roleKey: string; questions: ClientOpenQuestion[] }> {
  const groups: Array<{
    runId: number;
    roleKey: string;
    questions: ClientOpenQuestion[];
  }> = [];
  for (const r of runs) {
    try {
      const parsed = JSON.parse(r.open_questions_json ?? "[]") as unknown[];
      const questions = Array.isArray(parsed)
        ? parsed.map(normalizeQuestion).filter((q): q is ClientOpenQuestion => q !== null)
        : [];
      if (questions.length > 0) {
        groups.push({ runId: r.id, roleKey: r.role_key, questions });
      }
    } catch {
      /* skip malformed */
    }
  }
  return groups;
}

export interface AnsweredQuestion {
  answer: string;
  createdAt: string;
}

/** Most recent human answer to a role_key+question pair, derived from the
 *  interventions list (listInterventions returns ascending id order, so the
 *  last match found while scanning is the most recent — and wins). Returns
 *  null if the question was never answered. Tolerates malformed payload_json. */
export function findAnsweredQuestion(
  interventions: Intervention[],
  roleKey: string,
  question: string,
): AnsweredQuestion | null {
  const qNorm = question.trim();
  let found: AnsweredQuestion | null = null;
  for (const iv of interventions) {
    if (iv.kind !== "question_answer") continue;
    let payload: { role_key?: string; question?: string; answer?: string };
    try {
      payload = iv.payload_json ? JSON.parse(iv.payload_json) : {};
    } catch {
      continue;
    }
    if (payload.role_key !== roleKey) continue;
    if ((payload.question ?? "").trim() !== qNorm) continue;
    if (!payload.answer) continue;
    found = { answer: payload.answer, createdAt: iv.created_at };
  }
  return found;
}

/** Find coverage concerns that were never evaluated. */
function uncoveredConcerns(coverage: CoverageMap | null): string[] {
  if (!coverage) return [];
  return Object.entries(coverage)
    .filter(([, entry]) => entry.status === "never")
    .map(([concern]) => concern);
}

export function ReviewCTA({
  taskId,
  task,
  recapMd,
  coverage,
  runs,
  interventions,
  childTasks,
  onMutate,
  onOpenDiff,
}: ReviewCTAProps) {
  const [loading, setLoading] = useState<string | null>(null);
  const [creatingSubtaskKey, setCreatingSubtaskKey] = useState<string | null>(
    null,
  );
  const [questionAnswers, setQuestionAnswers] = useState<
    Record<string, string>
  >({});
  // Question keys the user has explicitly reopened for editing after the
  // question was already answered (see findAnsweredQuestion) — an already-
  // answered question renders as a locked "you answered" row unless its key
  // is in this set.
  const [editingKeys, setEditingKeys] = useState<Set<string>>(new Set());

  const isReview = task.stage === "review";
  const isReady = task.stage === "ready";
  if (!isReview && !isReady) return null;

  const actionItems =
    isReady ? extractActionItems(recapMd, coverage, runs) : [];
  const failedDecomp = findFailedDecomposition(runs);
  const recoveryCandidates = failedDecomp ? extractRecoveryCandidates(runs) : null;
  const questionGroups = collectQuestions(runs);
  const missingConcerns = uncoveredConcerns(coverage);
  const reviewReason = task.review_reason ?? "Task requires human judgement.";

  async function doMutate(kind: string, payload?: unknown) {
    setLoading(kind);
    try {
      await api.intervene(taskId, kind, payload);
      onMutate();
    } catch {
      /* error handled by query layer */
    } finally {
      setLoading(null);
    }
  }

  async function doReset() {
    setLoading("reset");
    try {
      await api.resetTask(taskId);
      onMutate();
    } catch {
      /* handled */
    } finally {
      setLoading(null);
    }
  }

  /** `executionReady` flags the child `exit_kind: "code_change"` — skipping
   *  straight to the developer/critic execution flow instead of inheriting
   *  this task's own "spec" and re-running the whole analysis pipeline for
   *  a next step that's already fully scoped by this task's own recap. */
  async function createSubtask(name: string, executionReady = false) {
    setCreatingSubtaskKey(name);
    try {
      await api.createSubtask(taskId, {
        name,
        content: name,
        exit_kind: executionReady ? "code_change" : undefined,
      });
      onMutate();
    } catch {
      /* handled */
    } finally {
      setCreatingSubtaskKey(null);
    }
  }

  async function submitAnswer(
    roleKey: string,
    question: string,
    answer: string,
  ) {
    if (!answer.trim()) return;
    await doMutate("question_answer", {
      role_key: roleKey,
      question,
      answer: answer.trim(),
    });
    // Exit explicit-edit mode; the typed text stays in questionAnswers so the
    // input keeps showing it (not the stale default) until the refetched
    // interventions confirm the answer and the row locks.
    setEditingKeys((prev) => {
      const next = new Set(prev);
      next.delete(`${roleKey}:${question}`);
      return next;
    });
  }

  /** Renders one open-question row: locked "you answered" view once answered
   *  and not explicitly being edited, otherwise the editable input + ✓. Shared
   *  by both the "Open Questions" (review) and "Follow-up Questions" (ready)
   *  sections below, which are otherwise identical markup. */
  function renderQuestionItem(
    roleKey: string,
    rawQ: ClientOpenQuestion,
    qi: number,
    decomposedChild: Task | undefined,
  ) {
    const answerKey = `${roleKey}:${rawQ.question}`;
    const answered = findAnsweredQuestion(interventions, roleKey, rawQ.question);
    const isEditing = !answered || editingKeys.has(answerKey);
    const val = questionAnswers[answerKey] ?? answered?.answer ?? "";

    return (
      <div key={qi} className="question-item">
        <p className="question-text">{rawQ.question}</p>
        {rawQ.assumed_answer && (
          <p className="question-default">
            best-effort guess ({rawQ.confidence}):{" "}
            <strong>{rawQ.assumed_answer}</strong>
            {rawQ.resolved === "confirmed" && (
              <span className="pill dim" style={{ marginLeft: 6 }}>
                confirmed
              </span>
            )}
            {rawQ.resolved === "invalidated" && (
              <span className="pill bad" style={{ marginLeft: 6 }}>
                corrected
              </span>
            )}
          </p>
        )}
        {answered && !isEditing && (
          <p className="question-default">
            you answered: <strong>{answered.answer}</strong>
            <span className="pill ok" style={{ marginLeft: 6 }}>
              answered
            </span>{" "}
            <button
              className="link"
              style={{
                background: "none",
                border: "none",
                color: "var(--brass)",
                cursor: "pointer",
                padding: 0,
                textDecoration: "underline",
                fontSize: 11,
              }}
              onClick={() => {
                setEditingKeys((prev) => new Set(prev).add(answerKey));
                setQuestionAnswers((prev) => ({ ...prev, [answerKey]: answered.answer }));
              }}
            >
              change answer
            </button>
          </p>
        )}
        {isEditing && (
          <div className="question-answer-row">
            <input
              className="question-answer-input"
              value={val}
              onChange={(e) =>
                setQuestionAnswers((prev) => ({
                  ...prev,
                  [answerKey]: e.target.value,
                }))
              }
              onKeyDown={(e) => {
                if (e.key === "Enter" && val.trim()) {
                  submitAnswer(roleKey, rawQ.question, val);
                }
              }}
              placeholder="answer…"
            />
            <button
              className="small review-cta-secondary"
              disabled={!val.trim()}
              style={{ padding: "2px 6px" }}
              onClick={() => submitAnswer(roleKey, rawQ.question, val)}
            >
              ✓
            </button>
            {answered && (
              <button
                className="link"
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--ink-dim)",
                  cursor: "pointer",
                  padding: "0 4px",
                  fontSize: 11,
                }}
                onClick={() =>
                  setEditingKeys((prev) => {
                    const next = new Set(prev);
                    next.delete(answerKey);
                    return next;
                  })
                }
              >
                cancel
              </button>
            )}
            {!decomposedChild && (
              <QuestionDecomposeButton
                parentTaskId={taskId}
                roleKey={roleKey}
                question={rawQ.question}
                onMutate={onMutate}
              />
            )}
          </div>
        )}
        {decomposedChild && <DecomposedChildCard task={decomposedChild} />}
      </div>
    );
  }

  /** Renders when decomposition failed to produce a subtask tree: salvaged
   *  candidate tickets from an earlier role's recommendations (if any were
   *  found), each with the same "+ subtask" affordance as the normal "next
   *  steps" list, plus a pointer at the existing reset button to retry
   *  decomposition itself. Shared by the review and ready panels so it shows
   *  up regardless of which stage the task landed in. */
  function renderRecoverySection() {
    if (!failedDecomp) return null;
    return (
      <div style={{ marginTop: 14 }}>
        <div className="review-cta-row">
          <span
            className="pill bad"
            style={{ fontSize: 11, textTransform: "uppercase" }}
          >
            decomposition incomplete
          </span>
        </div>
        <p className="review-reason" style={{ marginTop: 4 }}>
          Decomposition didn't produce a subtask tree
          {failedDecomp.stop_reason ? ` (stopped: ${failedDecomp.stop_reason})` : ""}.
          {recoveryCandidates
            ? ` Recovered these candidates from ${recoveryCandidates.roleKey}'s findings — review and create the ones that still apply, or use `
            : ` Nothing usable was found to recover automatically — use `}
          <strong>⟳ Reset &amp; re-run</strong> below to retry decomposition itself.
        </p>
        {recoveryCandidates?.items.map((item, i) => (
          <div key={i} className="next-step-item" style={{ marginBottom: 4 }}>
            <span className="next-step-text">{item}</span>
            <button
              className="small review-cta-secondary"
              disabled={creatingSubtaskKey === item}
              onClick={() => createSubtask(item)}
            >
              {creatingSubtaskKey === item ? "…" : "+ subtask"}
            </button>
          </div>
        ))}
      </div>
    );
  }

  const isMergeReview = isReview && task.exit_state === "needs_merge_approval";
  const hasPendingDiff = task.reconcile_status === "pending_human_merge";

  /** Prompt to open the diff modal — the one place code changes are actually
   *  shown/pushed. Rendered directly in this panel (not just the header's
   *  "review branch" pill) so accepting or rejecting a change is reachable
   *  from wherever the task landed: mid-review, or already at "ready". */
  function renderDiffBanner() {
    if (!hasPendingDiff) return null;
    return (
      <div className="review-cta-row" style={{ margin: "10px 0" }}>
        {task.github_pr_url ? (
          <a className="pill ok" href={task.github_pr_url} target="_blank" rel="noreferrer">
            PR open ↗
          </a>
        ) : null}
        <button type="button" className="small review-cta-primary" onClick={onOpenDiff}>
          🔍 View diff{task.git_branch ? ` — "${task.git_branch}"` : ""}
        </button>
        {task.reconcile_detail && (
          <span className="muted" style={{ fontSize: 11 }}>{task.reconcile_detail}</span>
        )}
      </div>
    );
  }

  return (
    <div className="panel review-cta-panel">
      {isMergeReview && (
        <>
          <span className="review-cta-tag">needs merge review</span>
          <h2>Code Ready for Merge Review</h2>
          <p className="review-reason">{reviewReason}</p>
          {renderDiffBanner()}

          {/* Grounded verification (overhaul/05): what you are approving is a
              diff PLUS a recorded run of the project's own checks — or, when
              this block is absent/red, a diff plus an opinion. Saying which is
              the entire point of showing it here. */}
          {(() => {
            const evidence = latestEvidenceByCommand(runs);
            if (!evidence.length) {
              return (
                <div className="banner warn" style={{ margin: "10px 0" }}>
                  ⚠ No verification evidence — nothing was executed against this change.{" "}
                  <span className="banner-why">
                    The verdict below is model self-assessment. Run the project's checks yourself
                    before approving, or enable command execution for this project.
                  </span>
                </div>
              );
            }
            const failing = evidence.filter((e) => !isEvidenceGreen(e));
            return (
              <>
                {failing.length > 0 && (
                  <div className="banner bad" style={{ margin: "10px 0" }}>
                    ⚠ {failing.length} verification command did not pass.{" "}
                    <span className="banner-why">
                      Approving merges code whose own checks are red.
                    </span>
                  </div>
                )}
                <EvidencePanel evidence={evidence} title="Verification evidence for this change" />
              </>
            );
          })()}

          <div className="review-cta-row">
            <button
              className="small review-cta-primary"
              disabled={loading === "approve_merge"}
              onClick={() => doMutate("approve_merge")}
            >
              {loading === "approve_merge" ? "…" : "Approve & mark merged"}
            </button>
            <button
              className="small review-cta-secondary"
              disabled={loading === "request_changes"}
              onClick={() => doMutate("request_changes")}
            >
              {loading === "request_changes" ? "…" : "Request changes"}
            </button>
          </div>

          <div className="review-cta-row escape">
            <button
              className="small review-cta-escape"
              disabled={loading === "reset"}
              onClick={doReset}
            >
              {loading === "reset" ? "…" : "⟳ Reset to intake"}
            </button>
            <button
              className="small review-cta-escape"
              disabled={loading === "wont_do"}
              onClick={() => doMutate("wont_do")}
            >
              {loading === "wont_do" ? "…" : "✕ Won't do"}
            </button>
          </div>
        </>
      )}
      {isReview && !isMergeReview && (
        <>
          <span className="review-cta-tag">needs review</span>
          <h2>Human Review Required</h2>
          <p className="review-reason">{reviewReason}</p>
          {renderDiffBanner()}

          <div className="review-cta-row">
            <button
              className="small review-cta-primary"
              disabled={loading === "mark_ready"}
              onClick={() => doMutate("mark_ready")}
            >
              {loading === "mark_ready" ? "…" : "Approve & mark ready"}
            </button>
            <button
              className="small review-cta-secondary"
              disabled={loading === "request_clarification"}
              onClick={() => doMutate("request_clarification")}
            >
              {loading === "request_clarification"
                ? "…"
                : "Request clarification"}
            </button>
          </div>

          {renderRecoverySection()}

          {questionGroups.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <h2 style={{ color: "var(--human)", marginBottom: 8 }}>
                Open Questions
              </h2>
              {questionGroups.map((group) => (
                <div key={group.runId} style={{ marginBottom: 10 }}>
                  <span
                    className="pill dim"
                    style={{ marginBottom: 6, display: "inline-block" }}
                  >
                    {group.roleKey}
                  </span>
                  {group.questions.map((rawQ, qi) => {
                    const decomposedChild = childTasks.find(
                      (c) =>
                        c.origin_role_key === group.roleKey &&
                        c.origin_question === rawQ.question,
                    );
                    return renderQuestionItem(group.roleKey, rawQ, qi, decomposedChild);
                  })}
                </div>
              ))}
            </div>
          )}

          <div className="review-cta-row escape">
            <button
              className="small review-cta-escape"
              disabled={loading === "dismiss_review"}
              onClick={() => doMutate("dismiss_review")}
            >
              {loading === "dismiss_review" ? "…" : "Dismiss (skip review)"}
            </button>
            <button
              className="small review-cta-escape"
              disabled={loading === "reset"}
              onClick={doReset}
            >
              {loading === "reset" ? "…" : "⟳ Reset to intake"}
            </button>
            <button
              className="small review-cta-escape"
              disabled={loading === "wont_do"}
              onClick={() => doMutate("wont_do")}
            >
              {loading === "wont_do" ? "…" : "✕ Won't do"}
            </button>
          </div>
        </>
      )}

      {isReady && (
        <>
          <span className="review-cta-tag">
            {task.exit_state ?? "complete"}
          </span>
          <h2>Outcome</h2>
          <p className="review-reason">
            {task.recap_md
              ? task.recap_md.slice(0, 300) +
                (task.recap_md.length > 300 ? "…" : "")
              : "Task is ready for implementation."}
          </p>
          {renderDiffBanner()}

          {actionItems.length > 0 && (
            <>
              <div className="review-cta-row" style={{ marginTop: 4 }}>
                <span
                  className="pill dim"
                  style={{ fontSize: 11, textTransform: "uppercase" }}
                >
                  next steps
                </span>
              </div>
              {actionItems.map((item, i) => (
                <div
                  key={i}
                  className="next-step-item"
                  style={{ marginBottom: 4 }}
                >
                  <span className="next-step-text">{item}</span>
                  <button
                    className="small review-cta-secondary"
                    disabled={creatingSubtaskKey === item}
                    title="Create a follow-up task that re-runs full analysis (requirements/architecture/etc.) before implementing"
                    onClick={() => createSubtask(item)}
                  >
                    {creatingSubtaskKey === item ? "…" : "+ subtask"}
                  </button>
                  <button
                    className="small review-cta-secondary"
                    disabled={creatingSubtaskKey === item}
                    title="Create a task that skips straight to implementation — use when this next step is already fully scoped"
                    onClick={() => createSubtask(item, true)}
                  >
                    {creatingSubtaskKey === item ? "…" : "⚡ implement"}
                  </button>
                </div>
              ))}
            </>
          )}

          {missingConcerns.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="review-cta-row">
                <span
                  className="pill bad"
                  style={{ fontSize: 11, textTransform: "uppercase" }}
                >
                  uncovered concerns
                </span>
              </div>
              {missingConcerns.map((concern) => {
                const roleKey = `${concern}_review`;
                return (
                  <div
                    key={concern}
                    className="next-step-item"
                    style={{ marginBottom: 4 }}
                  >
                    <span className="next-step-text">
                      {concern} — not yet evaluated
                    </span>
                    <button
                      className="small review-cta-secondary"
                      disabled={loading === `inject_${roleKey}`}
                      onClick={() =>
                        doMutate("inject_role", { role: roleKey })
                      }
                    >
                      {loading === `inject_${roleKey}`
                        ? "…"
                        : `inject ${roleKey}`}
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {renderRecoverySection()}

          {questionGroups.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <h2 style={{ color: "var(--human)", marginBottom: 8 }}>
                Follow-up Questions
              </h2>
              {questionGroups.map((group) => (
                <div key={group.runId} style={{ marginBottom: 10 }}>
                  <span
                    className="pill dim"
                    style={{ marginBottom: 6, display: "inline-block" }}
                  >
                    {group.roleKey}
                  </span>
                  {group.questions.map((rawQ, qi) => {
                    const decomposedChild = childTasks.find(
                      (c) =>
                        c.origin_role_key === group.roleKey &&
                        c.origin_question === rawQ.question,
                    );
                    return renderQuestionItem(group.roleKey, rawQ, qi, decomposedChild);
                  })}
                </div>
              ))}
            </div>
          )}

          <div className="review-cta-row escape" style={{ marginTop: 12 }}>
            <button
              className="small review-cta-escape"
              disabled={loading === "reset"}
              onClick={doReset}
            >
              {loading === "reset" ? "…" : "⟳ Reset & re-run"}
            </button>
            {task.paused === 1 ? (
              <button
                className="small review-cta-escape"
                disabled={loading === "resume"}
                onClick={() => doMutate("resume")}
              >
                {loading === "resume" ? "…" : "▶ Resume"}
              </button>
            ) : (
              <button
                className="small review-cta-escape"
                disabled={loading === "pause"}
                onClick={() => doMutate("pause")}
              >
                {loading === "pause" ? "…" : "⏸ Pause"}
              </button>
            )}
            <button
              className="small review-cta-escape"
              disabled={loading === "wont_do"}
              onClick={() => doMutate("wont_do")}
            >
              {loading === "wont_do" ? "…" : "✕ Won't do"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}