/**
 * Intake refinement — the pre-flight review layer (PLANNING/intake-refinement.md).
 *
 * Today every routing decision a task will ever make is fixed the moment a
 * human hits "Create task", by a human who has not looked at the code yet: the
 * intake kind selects the whole flow, `network_id` is never set at all from the
 * board, and `effort_size` — which picks the family decomposition budget and
 * can silently reroute the task into the execution flow — is set mid-flight by
 * `explorer` with no way to correct it beforehand.
 *
 * This module is the *pure* half of the layer that fixes that: config
 * resolution, the proposal type, the no-LLM heuristic proposal, and save-time
 * validation. The orchestration half (running the scout prefix, calling the
 * router, applying an accepted proposal to a task) lives in orchestrator.ts,
 * which owns plan seeding and already imports everything it needs — keeping it
 * there is what stops this module from closing an import cycle, exactly as
 * planning-rigor.ts / autonomy-level.ts / budget-policy.ts are split.
 *
 * The layer rides *parallel* to the existing intake → immediate-start path: a
 * task only enters it when a human asks for review (or the project opts in),
 * and a review that fails at any point degrades to the heuristic proposal —
 * which is today's routing, pre-filled into the same editable card. The
 * steering wheel is the feature; the LLM call only improves its defaults.
 */

import type { EffortSize } from "./agent.js";
import type { AutonomyLevel } from "./autonomy-level.js";
import { getNetwork, listNetworks, type TaskRow } from "./db.js";
import type { PlanningRigor } from "./planning-rigor.js";
import { flowForIntake, type IntakeKind } from "./roles.js";

/** The two roles the scout prefix runs before a flow is chosen. Every planning
 *  flow starts with `intake_triage`, and `explorer` appears in all but the
 *  research/ux/question ones — so running them early is the same work in a
 *  different order, not speculative work. Accepting a proposal seeds the plan
 *  with these already `done` (see orchestrator.ts's applyIntakeProposal). */
export const SCOUT_ROLES = ["intake_triage", "explorer"] as const;

/** "scouting" — the scout prefix is running; the task is unpaused and stepping,
 *   but no flow has been chosen and it must never finalize (see applyGate).
 *  "skip_pending" — a human hit "Start as-is" while the prefix was mid-run. The
 *   skip is deferred to the natural step boundary rather than applied under a
 *   running step: the in-flight step still holds the scout plan in memory and
 *   writes it back when it finishes, so clearing the plan out from under it
 *   would resurrect a two-step plan with no review state — which the
 *   finalization path would then promote to READY without a single planning
 *   role having run. Treated as "still scouting" everywhere until
 *   completeScoutPass applies it.
 *  "proposed" — a proposal is persisted and the task is paused on a human.
 *  "accepted" — a human accepted (possibly edited) it; the real flow is seeded.
 *  "skipped"  — the review was bypassed; the task runs exactly as filed. */
export type IntakeReviewState =
  | "scouting"
  | "skip_pending"
  | "proposed"
  | "accepted"
  | "skipped";

const STATES: IntakeReviewState[] = [
  "scouting",
  "skip_pending",
  "proposed",
  "accepted",
  "skipped",
];

export function intakeReviewState(task: TaskRow): IntakeReviewState | null {
  const s = task.intake_review_state;
  return (STATES as (string | null)[]).includes(s) ? (s as IntakeReviewState) : null;
}

/** True while the scout prefix owns the task's plan. The orchestrator consults
 *  this in three places, and all three exist because a scouting plan is a
 *  deliberate two-step prefix with no terminal role and no chosen flow:
 *  finishing it means "the proposal is ready to build", never "the task is
 *  ready". */
export function isScoutingIntake(task: TaskRow): boolean {
  const state = intakeReviewState(task);
  return state === "scouting" || state === "skip_pending";
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface IntakeReviewConfig {
  /** Whether an intake with no explicit choice goes through review. "off"
   *  (default) preserves today's behaviour byte-for-byte: the "Review intake"
   *  button is the only way in. "on" reviews every human intake, and the
   *  "Create task" button becomes the explicit bypass. */
  default: "off" | "on";
}

export const DEFAULT_INTAKE_REVIEW_CONFIG: IntakeReviewConfig = { default: "off" };

/** The project's own default, silently degrading to
 *  DEFAULT_INTAKE_REVIEW_CONFIG on anything unexpected (missing key, malformed
 *  JSON, garbage value) — same contract as resolvePlanningRigor /
 *  resolveAutonomyLevel / resolveHarnessPolicy. */
export function resolveIntakeReviewConfig(projectConfigJson: string | null): IntakeReviewConfig {
  if (!projectConfigJson) return { ...DEFAULT_INTAKE_REVIEW_CONFIG };
  try {
    const parsed = JSON.parse(projectConfigJson) as { intakeReview?: { default?: unknown } };
    const d = parsed.intakeReview?.default;
    return { default: d === "on" || d === "off" ? d : DEFAULT_INTAKE_REVIEW_CONFIG.default };
  } catch {
    return { ...DEFAULT_INTAKE_REVIEW_CONFIG };
  }
}

// ---------------------------------------------------------------------------
// The proposal
// ---------------------------------------------------------------------------

/** One entry of the network catalog handed to the planner (and rendered in the
 *  review card's network picker). Deliberately flat and small: the planner is
 *  choosing between options, not reading graphs. */
export interface NetworkOption {
  network_id: string;
  name: string;
  description: string;
  intake_kind: string | null;
  is_system: boolean;
  /** Ordered role keys from the network's graph nodes. */
  roles: string[];
}

/** A role the planner added to, or removed from, the matched network's own
 *  step list — surfaced in the card so a human sees what was changed and why,
 *  rather than a role list that silently differs from the network it names. */
export interface PlanDelta {
  role_key: string;
  change: "added" | "removed";
  why: string;
}

/** An open question the planner answered on the human's behalf. Deliberately
 *  the same three fields as `open_questions` in agent.ts, so a correction can
 *  flow through the router's existing answer-match call point (Call Point 5)
 *  with no new machinery. */
export interface ProposalAssumption {
  question: string;
  assumed_answer: string;
  confidence: "low" | "medium" | "high";
}

/**
 * A role the planner believes is genuinely missing from the catalog.
 * ADVISORY ONLY — never auto-created. A role is a durable, cross-task,
 * versioned object (PLANNING/overhaul-2/03); one intake's say-so is far too
 * thin a basis for minting one, so the card surfaces this as a note pointing
 * at the roles editor and nothing else acts on it.
 */
export interface CustomNodeSuggestion {
  role_key: string;
  title: string;
  persona_sketch: string;
  why: string;
}

export interface IntakeProposal {
  /** The intake normalized into a problem statement, in the planner's words. */
  restated_request: string;
  intake_kind: IntakeKind;
  /** null network_id = use the built-in flow for `intake_kind`. */
  network_id: string | null;
  network_name: string;
  network_why: string;
  /** The ordered role keys to actually run — the network's steps, possibly edited. */
  role_plan: string[];
  plan_deltas: PlanDelta[];
  effort_size: EffortSize;
  /** The concrete surfaces that drove the size — files and call sites, not adjectives. */
  size_rationale: string;
  planning_rigor: PlanningRigor;
  autonomy_level: AutonomyLevel | null;
  assumptions: ProposalAssumption[];
  custom_node: CustomNodeSuggestion | null;
  confidence: "low" | "medium" | "high";
  /** How this proposal was produced. "heuristic" means the planner call was
   *  off, failed, or timed out and these are today's default answers — the
   *  card says so rather than presenting them as an informed read. */
  source: "planner" | "heuristic";
  /** Set when the scout prefix itself flagged something (intake_triage judging
   *  the intake too vague, a blocker verdict). Rendered as a banner on the
   *  card: the human is the gate here by construction, so a scout escalation
   *  becomes a warning on the proposal rather than a separate review state. */
  scout_warning: string | null;
}

export const INTAKE_KINDS: IntakeKind[] = [
  "manual",
  "error_file",
  "feature",
  "bug",
  "security",
  "chore",
  "spike",
  "research",
  "ux",
  "question",
];

const EFFORT_SIZES: EffortSize[] = ["XS", "S", "M", "L", "XL"];

function isIntakeKind(v: unknown): v is IntakeKind {
  return typeof v === "string" && (INTAKE_KINDS as string[]).includes(v);
}
function isEffortSize(v: unknown): v is EffortSize {
  return typeof v === "string" && (EFFORT_SIZES as string[]).includes(v);
}
function isPlanningRigor(v: unknown): v is PlanningRigor {
  return v === "minimal" || v === "standard" || v === "thorough";
}
function isAutonomyLevel(v: unknown): v is AutonomyLevel {
  return v === "plan" || v === "edit" || v === "auto";
}
function isConfidence(v: unknown): v is "low" | "medium" | "high" {
  return v === "low" || v === "medium" || v === "high";
}

/** Ordered role keys from a network's stored graph, or [] if it can't be read.
 *  Mirrors planFromTemplate's own defensive parse — a malformed graph degrades
 *  to "no opinion" rather than throwing inside an intake. */
export function networkRoles(graphJson: string): string[] {
  try {
    const graph = JSON.parse(graphJson) as { nodes?: Array<{ roleKey?: string }> };
    return (graph.nodes ?? []).map((n) => n.roleKey).filter((r): r is string => typeof r === "string");
  } catch {
    return [];
  }
}

/** Every network this project could route to, as the planner and the card see
 *  it. System networks (the seeded per-intake-kind flows) come first, matching
 *  listNetworks' own ordering. */
export function buildNetworkCatalog(projectId: number | null): NetworkOption[] {
  return listNetworks({ projectId }).map((n) => ({
    network_id: n.network_id,
    name: n.name,
    description: n.description ?? "",
    intake_kind: n.intake_kind,
    is_system: n.is_system === 1,
    roles: networkRoles(n.graph_json),
  }));
}

// ---------------------------------------------------------------------------
// The heuristic proposal
// ---------------------------------------------------------------------------

export interface HeuristicProposalInput {
  /** The kind intake already inferred/was told — today's answer. */
  intakeKind: IntakeKind;
  /** The default network for that kind in this project's scope, if any. */
  defaultNetworkId: string | null;
  /** explorer's own estimate, when the scout prefix got that far. */
  effortSize: EffortSize | null;
  /** The project's (or task's) effective rigor — not a guess, the real setting. */
  planningRigor: PlanningRigor;
  scoutWarning?: string | null;
}

/**
 * The proposal that describes *exactly what would happen today* — the intake
 * kind already inferred, that kind's default network, explorer's own size, the
 * project's own rigor. Used when the planner call is disabled, fails, or times
 * out, and as the card's initial render while the planner is still running.
 *
 * That it reproduces current routing is the point, not a limitation: a review
 * whose planner is down still gives the human the one thing they never had —
 * the chance to change these values before they are spent.
 */
export function buildHeuristicProposal(input: HeuristicProposalInput): IntakeProposal {
  const network = input.defaultNetworkId ? getNetwork(input.defaultNetworkId) : undefined;
  const roles = network ? networkRoles(network.graph_json) : [];
  return {
    restated_request: "",
    intake_kind: input.intakeKind,
    network_id: network?.network_id ?? null,
    network_name: network?.name ?? `${input.intakeKind} (built-in flow)`,
    network_why: network
      ? "The project's default network for this intake kind — what this task would route to today."
      : "No network is registered for this intake kind, so the built-in flow applies.",
    role_plan: roles.length ? roles : flowForIntake(input.intakeKind).steps.slice(),
    plan_deltas: [],
    effort_size: input.effortSize ?? "M",
    size_rationale: input.effortSize
      ? "The explorer role's own estimate, made after reading the affected files."
      : "No size was recorded — defaulting to M, the same mid-sized fallback the decomposition budget uses.",
    planning_rigor: input.planningRigor,
    autonomy_level: null,
    assumptions: [],
    custom_node: null,
    confidence: "low",
    source: "heuristic",
    scout_warning: input.scoutWarning ?? null,
  };
}

// ---------------------------------------------------------------------------
// Folding the planner's answer into a proposal
// ---------------------------------------------------------------------------

/** The planner's raw output shape (router.ts Call Point 7). Structurally typed
 *  rather than imported so this module stays free of any router dependency. */
export interface PlannerResultLike {
  restated_request?: unknown;
  intake_kind?: unknown;
  network_id?: unknown;
  network_why?: unknown;
  role_plan?: unknown;
  plan_deltas?: unknown;
  effort_size?: unknown;
  size_rationale?: unknown;
  planning_rigor?: unknown;
  assumptions?: unknown;
  custom_node?: unknown;
  confidence?: unknown;
}

/**
 * Fold a planner result onto the heuristic proposal, field by field, keeping
 * the heuristic's value wherever the planner's is missing or unusable.
 *
 * Every field is checked against reality rather than trusted: an intake kind
 * outside the known set, a network id that isn't in this project's catalog, a
 * role key no role registry defines — each degrades to the heuristic answer for
 * that one field instead of rejecting the whole proposal. A partially-useful
 * proposal is still worth showing a human; a proposal naming a role that
 * doesn't exist would seed a plan with a step that can only be skipped.
 */
export function mergePlannerProposal(
  heuristic: IntakeProposal,
  raw: PlannerResultLike,
  context: { networks: NetworkOption[]; availableRoles: string[] },
): IntakeProposal {
  const kind = isIntakeKind(raw.intake_kind) ? raw.intake_kind : heuristic.intake_kind;

  const networkId =
    typeof raw.network_id === "string" &&
    context.networks.some((n) => n.network_id === raw.network_id)
      ? raw.network_id
      : raw.network_id === null
        ? null
        : heuristic.network_id;
  const chosen = context.networks.find((n) => n.network_id === networkId);

  const known = new Set(context.availableRoles);
  const proposedRoles = Array.isArray(raw.role_plan)
    ? (raw.role_plan as unknown[]).filter(
        (r): r is string => typeof r === "string" && known.has(r),
      )
    : [];
  // A network the planner chose but whose role list it couldn't restate is
  // still a useful choice — fall back to that network's own steps, not the
  // heuristic's (which describes a different network entirely).
  const rolePlan = proposedRoles.length
    ? proposedRoles
    : chosen?.roles.length
      ? chosen.roles
      : networkId === null
        ? flowForIntake(kind).steps.slice()
        : heuristic.role_plan;

  const planDeltas: PlanDelta[] = Array.isArray(raw.plan_deltas)
    ? (raw.plan_deltas as unknown[]).flatMap((d) => {
        const item = d as Record<string, unknown>;
        if (typeof item?.role_key !== "string") return [];
        if (item.change !== "added" && item.change !== "removed") return [];
        return [
          {
            role_key: item.role_key,
            change: item.change,
            why: typeof item.why === "string" ? item.why : "",
          },
        ];
      })
    : [];

  const assumptions: ProposalAssumption[] = Array.isArray(raw.assumptions)
    ? (raw.assumptions as unknown[]).flatMap((a) => {
        const item = a as Record<string, unknown>;
        if (typeof item?.question !== "string" || !item.question.trim()) return [];
        return [
          {
            question: item.question,
            assumed_answer: typeof item.assumed_answer === "string" ? item.assumed_answer : "",
            confidence: isConfidence(item.confidence) ? item.confidence : "low",
          },
        ];
      })
    : [];

  const customNodeRaw = raw.custom_node as Record<string, unknown> | null | undefined;
  const customNode: CustomNodeSuggestion | null =
    customNodeRaw && typeof customNodeRaw.role_key === "string"
      ? {
          role_key: customNodeRaw.role_key,
          title: typeof customNodeRaw.title === "string" ? customNodeRaw.title : customNodeRaw.role_key,
          persona_sketch:
            typeof customNodeRaw.persona_sketch === "string" ? customNodeRaw.persona_sketch : "",
          why: typeof customNodeRaw.why === "string" ? customNodeRaw.why : "",
        }
      : null;

  return {
    restated_request:
      typeof raw.restated_request === "string" ? raw.restated_request : heuristic.restated_request,
    intake_kind: kind,
    network_id: networkId,
    network_name: chosen?.name ?? (networkId === null ? `${kind} (built-in flow)` : heuristic.network_name),
    network_why: typeof raw.network_why === "string" ? raw.network_why : heuristic.network_why,
    role_plan: rolePlan,
    plan_deltas: planDeltas,
    effort_size: isEffortSize(raw.effort_size) ? raw.effort_size : heuristic.effort_size,
    size_rationale:
      typeof raw.size_rationale === "string" ? raw.size_rationale : heuristic.size_rationale,
    planning_rigor: isPlanningRigor(raw.planning_rigor) ? raw.planning_rigor : heuristic.planning_rigor,
    autonomy_level: heuristic.autonomy_level,
    assumptions,
    custom_node: customNode,
    confidence: isConfidence(raw.confidence) ? raw.confidence : "low",
    source: "planner",
    scout_warning: heuristic.scout_warning,
  };
}

// ---------------------------------------------------------------------------
// Save-time validation
// ---------------------------------------------------------------------------

export type ProposalValidation =
  | { ok: true; proposal: IntakeProposal }
  | { ok: false; error: string };

/**
 * Validate a proposal arriving from the client on accept. Unlike the resolvers
 * above (which silently degrade), this REPORTS the problem so an editor finds
 * out why its POST was rejected — same split as validatePlanningRigor.
 *
 * The role plan is checked for shape only, not against the role registry: an
 * unknown role key is already handled downstream (runOneStep marks an
 * unresolvable step "skipped" so the loop can't wedge), and rejecting the whole
 * accept for one stale key would strand a task with no way forward.
 */
export function validateProposal(raw: unknown, fallback: IntakeProposal): ProposalValidation {
  if (!raw || typeof raw !== "object") return { ok: false, error: "proposal must be an object" };
  const p = raw as Record<string, unknown>;

  if (!isIntakeKind(p.intake_kind)) {
    return { ok: false, error: `intake_kind must be one of: ${INTAKE_KINDS.join(", ")}` };
  }
  if (!isEffortSize(p.effort_size)) {
    return { ok: false, error: `effort_size must be one of: ${EFFORT_SIZES.join(", ")}` };
  }
  if (!isPlanningRigor(p.planning_rigor)) {
    return { ok: false, error: `planning_rigor must be one of: minimal, standard, thorough` };
  }
  if (p.autonomy_level != null && !isAutonomyLevel(p.autonomy_level)) {
    return { ok: false, error: `autonomy_level must be one of: plan, edit, auto (or null to inherit)` };
  }
  const rolePlan = Array.isArray(p.role_plan)
    ? p.role_plan.filter((r): r is string => typeof r === "string" && r.trim().length > 0)
    : [];
  if (rolePlan.length === 0) {
    return { ok: false, error: "role_plan must contain at least one role" };
  }
  if (p.network_id != null && typeof p.network_id !== "string") {
    return { ok: false, error: "network_id must be a string or null" };
  }
  if (typeof p.network_id === "string" && !getNetwork(p.network_id)) {
    return { ok: false, error: `network "${p.network_id}" not found` };
  }

  const assumptions: ProposalAssumption[] = Array.isArray(p.assumptions)
    ? (p.assumptions as unknown[]).flatMap((a) => {
        const item = a as Record<string, unknown>;
        if (typeof item?.question !== "string") return [];
        return [
          {
            question: item.question,
            assumed_answer: typeof item.assumed_answer === "string" ? item.assumed_answer : "",
            confidence: isConfidence(item.confidence) ? item.confidence : "low",
          },
        ];
      })
    : [];

  return {
    ok: true,
    proposal: {
      ...fallback,
      restated_request:
        typeof p.restated_request === "string" ? p.restated_request : fallback.restated_request,
      intake_kind: p.intake_kind,
      network_id: (p.network_id as string | null) ?? null,
      network_name: typeof p.network_name === "string" ? p.network_name : fallback.network_name,
      network_why: typeof p.network_why === "string" ? p.network_why : fallback.network_why,
      role_plan: rolePlan,
      effort_size: p.effort_size,
      planning_rigor: p.planning_rigor,
      autonomy_level: (p.autonomy_level as AutonomyLevel | null) ?? null,
      assumptions,
    },
  };
}

/** Parse a stored proposal off a task row, or null if absent/malformed. */
export function readProposal(task: TaskRow): IntakeProposal | null {
  if (!task.intake_proposal_json) return null;
  try {
    return JSON.parse(task.intake_proposal_json) as IntakeProposal;
  } catch {
    return null;
  }
}
