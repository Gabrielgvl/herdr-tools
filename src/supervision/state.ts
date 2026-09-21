/**
 * The bounded supervision view `herdr_jobs` publishes, and the port a supervisor
 * exposes to the job registry.
 *
 * The registry stays generic: it never reaches into supervision state, and
 * supervision never reaches into job settlement. Everything they share crosses
 * this seam.
 */

import type { ReconciliationFailureReason, SupervisionEvent, SupervisionTransition } from "./events.js";
import { SUPERVISION_AGENT_STATUSES, type SupervisionAgentStatus } from "./protocol.js";
import type { HandoffInspection } from "../handoff-gate.js";
import type { ReviewClassification } from "../reviewer.js";
import type { SupervisedIdentity } from "./identity.js";

export type SupervisionState = "reserved" | "provisional" | "active" | "degraded" | "settled";

export interface SupervisionChildView {
  agentName: string;
  agentKind: string;
  paneId: string;
  terminalId: string;
  /** The compiled candidate that actually started this child. */
  candidateName: string;
  /** Present only when fallback selection changed the candidate after reservation. */
  requestedCandidateName?: string;
  /** Present only when fallback selection changed the kind after reservation. */
  requestedAgentKind?: string;
}

/**
 * Reduced-assurance evidence published while an AGY child has no native
 * session identity yet. These fields are inspectable evidence, not exact
 * identity coverage; `baseline` is the idle lifecycle sample used for
 * strengthening.
 */
export interface SupervisionProvisionalView {
  agentName: string;
  agentKind: "agy";
  paneId: string;
  terminalId: string;
  /** The compiled candidate that actually started this child. */
  candidateName: string;
  /** Present only when fallback selection changed the candidate after reservation. */
  requestedCandidateName?: string;
  baseline: {
    state: "idle";
    stateChangeSeq: number;
    revision: number;
  };
}

export interface SupervisionReconciliationView {
  intervalMs: number;
  degraded: boolean;
  consecutiveFailures: number;
  lastAttemptAtMs?: number;
  lastSuccessAtMs?: number;
  lastFailureAtMs?: number;
  lastFailureReason?: ReconciliationFailureReason;
}

export interface SupervisionMonitorView {
  /** Subscription connection only. */
  connected: boolean;
  /** Aggregate of subscription and authoritative reconciliation health. */
  degraded: boolean;
  generation: number;
  evidenceGaps: number;
  /** Present on every runtime Supervisor view; optional only for structural test ports. */
  reconciliation?: SupervisionReconciliationView;
}

export interface SupervisionReviewView {
  atMs: number;
  classification: ReviewClassification;
  summary: string;
}

export interface SupervisionReviewerView {
  model: string;
  /** Legacy input compatibility only. Public projections omit this because Jev has no thinking level. */
  thinking?: "max";
  cadenceMinutes: number;
  degraded: boolean;
  reviews: SupervisionReviewView[];
  truncatedReviews: number;
  lastReviewAtMs?: number;
}

interface SupervisionJobViewCommon {
  monitor: SupervisionMonitorView;
  reviewer: SupervisionReviewerView;
  transitions: SupervisionTransition[];
  truncatedTransitions: number;
  events: SupervisionEvent[];
  truncatedEvents: number;
  unobservedEvents: number;
  settledReason?: string;
}

export interface SupervisionReservedJobView extends SupervisionJobViewCommon {
  state: "reserved";
  provisional?: never;
  child?: never;
  status?: never;
}

export interface SupervisionProvisionalJobView extends SupervisionJobViewCommon {
  state: "provisional";
  provisional: SupervisionProvisionalView;
  child?: never;
  status?: "idle";
}

export interface SupervisionActiveJobView extends SupervisionJobViewCommon {
  state: "active";
  provisional?: never;
  child: SupervisionChildView;
  status: SupervisionAgentStatus;
}

export interface SupervisionDegradedJobView extends SupervisionJobViewCommon {
  state: "degraded";
  provisional?: never;
  child: SupervisionChildView;
  status: SupervisionAgentStatus;
}

export interface SupervisionSettledJobView extends SupervisionJobViewCommon {
  state: "settled";
  provisional?: never;
  child?: SupervisionChildView;
  status?: SupervisionAgentStatus;
}

/** The state discriminates which identity evidence may be published. */
export type SupervisionJobView =
  | SupervisionReservedJobView
  | SupervisionProvisionalJobView
  | SupervisionActiveJobView
  | SupervisionDegradedJobView
  | SupervisionSettledJobView;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function safeCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function status(value: unknown): value is SupervisionAgentStatus {
  return typeof value === "string" && (SUPERVISION_AGENT_STATUSES as readonly string[]).includes(value);
}

function child(value: unknown): value is SupervisionChildView {
  if (!record(value) || !text(value.agentName) || !text(value.agentKind) || !text(value.paneId) || !text(value.terminalId) || !text(value.candidateName)) return false;
  return (value.requestedCandidateName === undefined || text(value.requestedCandidateName)) && (value.requestedAgentKind === undefined || text(value.requestedAgentKind));
}

function provisional(value: unknown): value is SupervisionProvisionalView {
  if (!record(value) || value.agentKind !== "agy" || !text(value.agentName) || !text(value.paneId) || !text(value.terminalId) || !text(value.candidateName)) return false;
  if (value.requestedCandidateName !== undefined && !text(value.requestedCandidateName)) return false;
  return record(value.baseline) && value.baseline.state === "idle" && safeCounter(value.baseline.stateChangeSeq) && safeCounter(value.baseline.revision);
}

/** Runtime guard for the public seam. Invalid state/evidence combinations are omitted. */
export function isSupervisionJobView(value: unknown): value is SupervisionJobView {
  try {
    if (!record(value) || !["reserved", "provisional", "active", "degraded", "settled"].includes(String(value.state))) return false;
    if (!record(value.monitor) || !record(value.reviewer) || !text(value.reviewer.model) || !Array.isArray(value.reviewer.reviews) || !Array.isArray(value.transitions) || !Array.isArray(value.events)) return false;
    if (!value.reviewer.reviews.every((review) => record(review) && typeof review.summary === "string")) return false;
    if (!value.events.every((event) => record(event) && typeof event.eventId === "string" && typeof event.summary === "string")) return false;
    if (value.settledReason !== undefined && typeof value.settledReason !== "string") return false;
    if (value.state === "provisional") return provisional(value.provisional) && value.child === undefined && (value.status === undefined || value.status === "idle");
    if (value.provisional !== undefined) return false;
    if (value.state === "reserved") return value.child === undefined && value.status === undefined;
    if (value.state === "active" || value.state === "degraded") return child(value.child) && status(value.status);
    return (value.child === undefined || child(value.child)) && (value.status === undefined || status(value.status));
  } catch {
    return false;
  }
}

/**
 * What the job registry may ask a supervisor for. `takePendingEvents` is the
 * only mutating call, and it marks exactly the events it returns.
 */
export interface SupervisionJobPort {
  view(): SupervisionJobView;
  /**
   * The bound managed run's bounded evidence, published on the job detail
   * rather than inside this view so no truncation tier can strip it.
   */
  handoffEvidence?(): HandoffInspection | undefined;
  takePendingEvents(): SupervisionEvent[];
  /** True while the exact child is still live, which refuses `herdr_jobs cancel`. */
  childLive(): boolean;
  /** Exact private identity match used only for semantic-review ownership. */
  coversIdentity?(identity: SupervisedIdentity): boolean;
  /** Stop supervising because the session is shutting down. */
  shutdown(): void;
}
