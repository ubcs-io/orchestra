import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { marked } from "marked";
import { api, type Task } from "../api";

export interface QuestionDecomposeButtonProps {
  parentTaskId: string;
  roleKey: string;
  question: string;
  onMutate: () => void;
}

/** Inline trigger that spins a review question off into its own Question Flow subtask. */
export function QuestionDecomposeButton({
  parentTaskId,
  roleKey,
  question,
  onMutate,
}: QuestionDecomposeButtonProps) {
  const [loading, setLoading] = useState(false);

  async function decompose() {
    setLoading(true);
    try {
      await api.decomposeQuestion(parentTaskId, { role_key: roleKey, question });
      onMutate();
    } catch {
      /* handled by query layer */
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      className="small review-cta-secondary"
      style={{ padding: "2px 6px" }}
      disabled={loading}
      onClick={decompose}
    >
      {loading ? "…" : "⚡ decompose"}
    </button>
  );
}

export function DecomposedChildCard({ task }: { task: Task }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["task", task.task_id],
    queryFn: () => api.task(task.task_id),
    refetchInterval: (query) => {
      const stage = query.state.data?.task.stage;
      return stage === "ready" || stage === "review" ? false : 4000;
    },
  });

  const [chatInput, setChatInput] = useState("");
  const [sending, setSending] = useState(false);

  const detail = q.data;
  const stage = detail?.task.stage ?? task.stage;
  const recapMd = detail?.recap_md;
  const chatMessages = detail?.chat_messages ?? [];

  async function sendChat() {
    if (!chatInput.trim()) return;
    setSending(true);
    try {
      await api.sendChatMessage(task.task_id, { message: chatInput.trim() });
      setChatInput("");
      await qc.invalidateQueries({ queryKey: ["task", task.task_id] });
    } catch {
      /* handled by query layer */
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      style={{
        marginTop: 6,
        marginLeft: 12,
        padding: "8px 10px",
        border: "1px solid var(--line)",
        borderRadius: 6,
      }}
    >
      <span className="pill dim">{stage}</span>

      {recapMd && (
        <div
          className="section-md rendered-md"
          style={{ marginTop: 8, fontSize: 12 }}
          dangerouslySetInnerHTML={{ __html: marked.parse(recapMd) as string }}
        />
      )}

      {recapMd && (
        <div style={{ marginTop: 10 }}>
          {chatMessages.length > 0 && (
            <div style={{ marginBottom: 6, display: "flex", flexDirection: "column", gap: 4 }}>
              {chatMessages.map((m) => (
                <div key={m.id} style={{ fontSize: 12 }}>
                  <strong>{m.role === "user" ? "You" : "Assistant"}:</strong> {m.content}
                </div>
              ))}
            </div>
          )}
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              style={{ flex: 1, fontSize: 12, padding: "3px 6px" }}
              value={chatInput}
              disabled={sending}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && chatInput.trim()) sendChat();
              }}
              placeholder="ask the model about this brief…"
            />
            <button
              className="small review-cta-secondary"
              disabled={sending || !chatInput.trim()}
              onClick={sendChat}
            >
              {sending ? "…thinking" : "send"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
