import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type AutonomyLevel,
  type EffortBudgetRow,
  type EffortSize,
  type IntakeProposal,
  type NetworkOption,
  type PlanningRigor,
  type Task,
} from "../api";

/**
 * The intake review card (PLANNING/intake-refinement.md) — the one place a
 * human gets to change how a task will be routed *before* any of it is spent.
 *
 * The design rule this component exists to serve: never show a setting without
 * showing what it buys. `effort_size` in particular is a single letter that
 * silently picks the family decomposition budget, so the size control renders
 * the real budget beside it ("M × standard → up to 12 subtasks, max depth 2"),
 * computed server-side by the same resolveFamilyBudget the decomposition gate
 * uses. A human has an opinion about "how many subtasks may this spawn"; nobody
 * has an opinion about the letter M.
 */

const EFFORT_SIZES: EffortSize[] = ["XS", "S", "M", "L", "XL"];
const RIGORS: PlanningRigor[] = ["minimal", "standard", "thorough"];
const AUTONOMY: AutonomyLevel[] = ["plan", "edit", "auto"];

function budgetLine(row: EffortBudgetRow | undefined, rigor: PlanningRigor): string {
  if (!row) return "";
  if (row.maxCount === 0) {
    return `${row.size} × ${rigor} → no decomposition at all; routes straight to implementation`;
  }
  return `${row.size} × ${rigor} → up to ${row.maxCount} subtask${row.maxCount === 1 ? "" : "s"}, max depth ${row.maxDepth}`;
}

export function IntakeReviewPanel({ task, onClose }: { task: Task; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["intake-proposal", task.task_id],
    queryFn: () => api.intakeProposal(task.task_id),
    // While the scout prefix is still running there is nothing to edit yet —
    // poll until the proposal lands, then stop.
    refetchInterval: (query) => (query.state.data?.state === "scouting" ? 2000 : false),
  });

  const [draft, setDraft] = useState<IntakeProposal | null>(null);
  // Adopt the server's proposal once, and again if the scout pass replaces it
  // (scouting → proposed). Never clobbers edits in progress: `source` and
  // `state` only change on that transition.
  const serverProposal = q.data?.proposal ?? null;
  useEffect(() => {
    if (serverProposal && !draft) setDraft(serverProposal);
  }, [serverProposal, draft]);

  const networks = q.data?.networks ?? [];
  const roles = q.data?.roles ?? [];
  const intakeKinds = q.data?.intake_kinds ?? [];

  const accept = useMutation({
    mutationFn: () => api.acceptIntakeProposal(task.task_id, draft ?? undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tasks", task.project_id] });
      onClose();
    },
  });
  const skip = useMutation({
    mutationFn: () => api.skipIntakeProposal(task.task_id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tasks", task.project_id] });
      onClose();
    },
  });

  const budgetBySize = useMemo(() => {
    const map = new Map<EffortSize, EffortBudgetRow>();
    for (const row of q.data?.budget_preview ?? []) map.set(row.size, row);
    return map;
  }, [q.data]);

  const selectedNetwork: NetworkOption | undefined = networks.find(
    (n) => n.network_id === draft?.network_id,
  );

  function patch(fields: Partial<IntakeProposal>) {
    setDraft((d) => (d ? { ...d, ...fields } : d));
  }

  /** Switching networks replaces the role plan with that network's own steps —
   *  a role list carried over from a different network is nobody's intent.
   *  Selecting "no network" falls back to the built-in flow for the current
   *  kind, for the same reason. */
  function selectNetwork(networkId: string | null) {
    if (!draft) return;
    const next = networks.find((n) => n.network_id === networkId);
    const roles = next?.roles.length
      ? [...next.roles]
      : (q.data?.flows[draft.intake_kind] ?? draft.role_plan);
    patch({
      network_id: networkId,
      network_name: next?.name ?? `${draft.intake_kind} (built-in flow)`,
      role_plan: roles,
      plan_deltas: [],
    });
  }

  /** Changing the kind re-points a task at a different flow entirely. When no
   *  network is pinned, the role list has to follow — leaving the previous
   *  kind's roles in place would run a `feature` flow under a `chore` label. A
   *  human who explicitly picked a network keeps it; that choice outranks the
   *  kind's default. */
  function selectKind(kind: string) {
    if (!draft) return;
    patch({
      intake_kind: kind,
      ...(draft.network_id
        ? {}
        : {
            role_plan: q.data?.flows[kind] ?? draft.role_plan,
            network_name: `${kind} (built-in flow)`,
            plan_deltas: [],
          }),
    });
  }

  function moveRole(index: number, delta: number) {
    if (!draft) return;
    const next = [...draft.role_plan];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    patch({ role_plan: next });
  }

  const state = q.data?.state ?? task.intake_review_state;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        style={{ maxWidth: 720, maxHeight: "86vh", overflow: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Review intake</h3>
        <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
          {task.name ?? task.task_id.slice(0, 8)}
        </div>

        {state === "scouting" && (
          <p className="muted">
            Reading the repository — <code>intake_triage</code> and <code>explorer</code> are running.
            These are the first two steps of whichever flow you choose, so this isn't extra work; the
            proposal appears when they finish.
          </p>
        )}

        {q.isLoading && <p className="muted">Loading…</p>}

        {draft && (
          <>
            {draft.scout_warning && (
              <div className="pill warn" style={{ display: "block", padding: "6px 10px", marginBottom: 12 }}>
                ⚠ {draft.scout_warning}
              </div>
            )}

            {draft.source === "heuristic" && (
              <p className="muted" style={{ fontSize: 12 }}>
                No planner read this — the values below are exactly what this task would have done
                without the review. Change whatever is wrong.
              </p>
            )}

            <label>What is being asked</label>
            <textarea
              value={draft.restated_request}
              rows={3}
              onChange={(e) => patch({ restated_request: e.target.value })}
              placeholder="The planner's restatement of the request."
            />

            <div className="grid-2" style={{ marginTop: 10 }}>
              <div>
                <label>Kind</label>
                <select value={draft.intake_kind} onChange={(e) => selectKind(e.target.value)}>
                  {intakeKinds.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>Network</label>
                <select
                  value={draft.network_id ?? ""}
                  onChange={(e) => selectNetwork(e.target.value || null)}
                >
                  <option value="">(built-in flow for this kind)</option>
                  {networks.map((n) => (
                    <option key={n.network_id} value={n.network_id}>
                      {n.name}
                      {n.intake_kind ? ` · ${n.intake_kind}` : ""}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {draft.network_why && (
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                {draft.network_why}
              </div>
            )}

            <label style={{ marginTop: 14 }}>
              Effort size
              {task.effort_size && draft.effort_size !== task.effort_size && (
                <span className="pill dim" style={{ marginLeft: 8 }}>
                  explorer said {task.effort_size}
                </span>
              )}
            </label>
            <div className="row" style={{ gap: 4 }}>
              {EFFORT_SIZES.map((s) => (
                <button
                  key={s}
                  className={`small${draft.effort_size === s ? " primary" : ""}`}
                  onClick={() => patch({ effort_size: s })}
                >
                  {s}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 12, marginTop: 6, color: "var(--brass)" }}>
              {budgetLine(budgetBySize.get(draft.effort_size), draft.planning_rigor)}
            </div>
            {draft.size_rationale && (
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                {draft.size_rationale}
              </div>
            )}

            <div className="grid-2" style={{ marginTop: 14 }}>
              <div>
                <label>Planning depth</label>
                <select
                  value={draft.planning_rigor}
                  onChange={(e) => patch({ planning_rigor: e.target.value as PlanningRigor })}
                >
                  {RIGORS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>Autonomy</label>
                <select
                  value={draft.autonomy_level ?? ""}
                  onChange={(e) =>
                    patch({ autonomy_level: (e.target.value || null) as AutonomyLevel | null })
                  }
                >
                  <option value="">(inherit project default)</option>
                  {AUTONOMY.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <label style={{ marginTop: 14 }}>
              Roles ({draft.role_plan.length})
              {selectedNetwork && (
                <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
                  from {selectedNetwork.name}
                </span>
              )}
            </label>
            <div className="next-steps-list">
              {draft.role_plan.map((role, i) => {
                const delta = draft.plan_deltas.find((d) => d.role_key === role);
                return (
                  <div key={`${role}-${i}`} className="next-step-item">
                    <span className="next-step-text">
                      <code>{role}</code>
                      {delta && (
                        <span className="pill accent" style={{ marginLeft: 6 }} title={delta.why}>
                          {delta.change}
                        </span>
                      )}
                    </span>
                    <button className="small" onClick={() => moveRole(i, -1)} disabled={i === 0}>
                      ↑
                    </button>
                    <button
                      className="small"
                      onClick={() => moveRole(i, 1)}
                      disabled={i === draft.role_plan.length - 1}
                    >
                      ↓
                    </button>
                    <button
                      className="small"
                      onClick={() =>
                        patch({ role_plan: draft.role_plan.filter((_, idx) => idx !== i) })
                      }
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
            <select
              value=""
              style={{ marginTop: 6 }}
              onChange={(e) => {
                if (!e.target.value) return;
                patch({ role_plan: [...draft.role_plan, e.target.value] });
              }}
            >
              <option value="">+ add a role…</option>
              {roles
                .filter((r) => !draft.role_plan.includes(r.key))
                .map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.key} — {r.title}
                  </option>
                ))}
            </select>

            {draft.plan_deltas.filter((d) => d.change === "removed").length > 0 && (
              <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                Removed vs. the network:{" "}
                {draft.plan_deltas
                  .filter((d) => d.change === "removed")
                  .map((d) => `${d.role_key} (${d.why})`)
                  .join("; ")}
              </div>
            )}

            {draft.assumptions.length > 0 && (
              <>
                <label style={{ marginTop: 14 }}>Assumptions made for you</label>
                <div className="next-steps-list">
                  {draft.assumptions.map((a, i) => (
                    <div key={i} className="next-step-item" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
                      <div className="next-step-text">
                        {a.question}{" "}
                        <span className={`pill ${a.confidence === "high" ? "ok" : a.confidence === "low" ? "warn" : "dim"}`}>
                          {a.confidence}
                        </span>
                      </div>
                      <input
                        value={a.assumed_answer}
                        onChange={(e) => {
                          const next = [...draft.assumptions];
                          next[i] = { ...a, assumed_answer: e.target.value };
                          patch({ assumptions: next });
                        }}
                      />
                    </div>
                  ))}
                </div>
              </>
            )}

            {draft.custom_node && (
              <div className="muted" style={{ fontSize: 12, marginTop: 14 }}>
                💡 The planner thinks a role is missing: <code>{draft.custom_node.role_key}</code> —{" "}
                {draft.custom_node.title}. {draft.custom_node.why} Nothing is created automatically;
                add it in the roles editor if you agree.
              </div>
            )}

            {accept.isError && (
              <p className="pill bad" style={{ display: "block", padding: "6px 10px", marginTop: 12 }}>
                {(accept.error as Error).message}
              </p>
            )}
          </>
        )}

        <div className="modal-actions">
          <button className="small" onClick={onClose}>
            Save &amp; hold
          </button>
          <button
            className="small"
            onClick={() => skip.mutate()}
            disabled={skip.isPending}
            title="Ignore the review and run this intake exactly as it was filed"
          >
            Start as-is
          </button>
          <button
            className="primary"
            disabled={!draft || accept.isPending || state !== "proposed"}
            onClick={() => accept.mutate()}
          >
            {accept.isPending ? "Starting…" : "Start"}
          </button>
        </div>
      </div>
    </div>
  );
}
