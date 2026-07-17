import { useState } from "react";
import { api, type Task, type RoleRun, type CoverageMap } from "../api";
import { QuestionDecomposeButton, DecomposedChildCard } from "./QuestionDecompose";

export interface ReviewCTAProps {
  taskId: string;
  task: Task;
  recapMd: string | null;
  coverage: CoverageMap | null;
  runs: RoleRun[];
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

  // 2. Fallback: decomposition role output for [epic]/[story]/[task] bullets.
  if (items.length === 0) {
    const decomp = runs.find((r) => r.role_key === "decomposition");
    if (decomp?.output_md) {
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

/** Collect all open questions grouped by role, skipping runs with no questions. */
function collectQuestions(
  runs: RoleRun[],
): Array<{ runId: number; roleKey: string; questions: string[] }> {
  const groups: Array<{
    runId: number;
    roleKey: string;
    questions: string[];
  }> = [];
  for (const r of runs) {
    try {
      const parsed = JSON.parse(r.open_questions_json ?? "[]") as string[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        groups.push({ runId: r.id, roleKey: r.role_key, questions: parsed });
      }
    } catch {
      /* skip malformed */
    }
  }
  return groups;
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
    // Clear answer input
    setQuestionAnswers((prev) => {
      const next = { ...prev };
      delete next[`${roleKey}:${question}`];
      return next;
    });
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
                    const answerKey = `${group.roleKey}:${rawQ}`;
                    const val = questionAnswers[answerKey] ?? "";
                    const decomposedChild = childTasks.find(
                      (c) =>
                        c.origin_role_key === group.roleKey &&
                        c.origin_question === rawQ,
                    );
                    return (
                      <div key={qi} style={{ marginBottom: 6 }}>
                        <div
                          style={{
                            display: "flex",
                            gap: 6,
                            alignItems: "center",
                          }}
                        >
                          <span
                            style={{
                              flex: 1,
                              fontSize: 12,
                              color: "var(--ink)",
                            }}
                          >
                            {rawQ}
                          </span>
                          <input
                            style={{
                              width: 180,
                              fontSize: 12,
                              padding: "3px 6px",
                            }}
                            value={val}
                            onChange={(e) =>
                              setQuestionAnswers((prev) => ({
                                ...prev,
                                [answerKey]: e.target.value,
                              }))
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && val.trim()) {
                                submitAnswer(group.roleKey, rawQ, val);
                              }
                            }}
                            placeholder="answer…"
                          />
                          <button
                            className="small review-cta-secondary"
                            disabled={!val.trim()}
                            style={{ padding: "2px 6px" }}
                            onClick={() =>
                              submitAnswer(group.roleKey, rawQ, val)
                            }
                          >
                            ✓
                          </button>
                          {!decomposedChild && (
                            <QuestionDecomposeButton
                              parentTaskId={taskId}
                              roleKey={group.roleKey}
                              question={rawQ}
                              onMutate={onMutate}
                            />
                          )}
                        </div>
                        {decomposedChild && (
                          <DecomposedChildCard task={decomposedChild} />
                        )}
                      </div>
                    );
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
                    const answerKey = `${group.roleKey}:${rawQ}`;
                    const val = questionAnswers[answerKey] ?? "";
                    const decomposedChild = childTasks.find(
                      (c) =>
                        c.origin_role_key === group.roleKey &&
                        c.origin_question === rawQ,
                    );
                    return (
                      <div key={qi} style={{ marginBottom: 6 }}>
                        <div
                          style={{
                            display: "flex",
                            gap: 6,
                            alignItems: "center",
                          }}
                        >
                          <span
                            style={{
                              flex: 1,
                              fontSize: 12,
                              color: "var(--ink)",
                            }}
                          >
                            {rawQ}
                          </span>
                          <input
                            style={{
                              width: 180,
                              fontSize: 12,
                              padding: "3px 6px",
                            }}
                            value={val}
                            onChange={(e) =>
                              setQuestionAnswers((prev) => ({
                                ...prev,
                                [answerKey]: e.target.value,
                              }))
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && val.trim()) {
                                submitAnswer(group.roleKey, rawQ, val);
                              }
                            }}
                            placeholder="answer…"
                          />
                          <button
                            className="small review-cta-secondary"
                            disabled={!val.trim()}
                            style={{ padding: "2px 6px" }}
                            onClick={() =>
                              submitAnswer(group.roleKey, rawQ, val)
                            }
                          >
                            ✓
                          </button>
                          {!decomposedChild && (
                            <QuestionDecomposeButton
                              parentTaskId={taskId}
                              roleKey={group.roleKey}
                              question={rawQ}
                              onMutate={onMutate}
                            />
                          )}
                        </div>
                        {decomposedChild && (
                          <DecomposedChildCard task={decomposedChild} />
                        )}
                      </div>
                    );
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