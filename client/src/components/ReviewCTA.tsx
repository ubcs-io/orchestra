import { useState } from "react";
import { api, type Task, type RoleRun, type CoverageMap, type Intervention } from "../api";
import { QuestionDecomposeButton, DecomposedChildCard } from "./QuestionDecompose";

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
}

/** Extract action items from recap_md, coverage, and runs. */
function extractActionItems(
  recapMd: string | null,
  coverage: CoverageMap | null,
  runs: RoleRun[],
): string[] {
  const items: string[] = [];

  // 1. Parse ## Action Items / ## Next Steps from recap.
  if (recapMd) {
    const headerRe = /^##\s+(?:action\s*items?|next\s*steps?)\s*$/im;
    const hdr = headerRe.exec(recapMd);
    if (hdr) {
      const afterHeader = recapMd.slice(hdr.index + hdr[0].length);
      const nextHeader = afterHeader.search(/^##\s+/m);
      const section =
        nextHeader >= 0 ? afterHeader.slice(0, nextHeader) : afterHeader;
      const bulletRe = /^[-*]\s+(.+)$/gm;
      let bm;
      while ((bm = bulletRe.exec(section)) !== null) {
        const text = bm[1]!.trim();
        if (text && !text.startsWith("---")) {
          items.push(text.slice(0, 200));
        }
      }
    }
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

  async function createSubtask(name: string) {
    setCreatingSubtaskKey(name);
    try {
      await api.createSubtask(taskId, {
        name,
        content: name,
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

  return (
    <div className="panel review-cta-panel">
      {isReview && (
        <>
          <span className="review-cta-tag">needs review</span>
          <h2>Human Review Required</h2>
          <p className="review-reason">{reviewReason}</p>

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
                    onClick={() => createSubtask(item)}
                  >
                    {creatingSubtaskKey === item ? "…" : "+ subtask"}
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