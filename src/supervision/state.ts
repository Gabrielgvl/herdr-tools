/**
 * The bounded supervision view `herdr_jobs` publishes, and the port a supervisor
 * exposes to the job registry.
 *
 * The registry stays generic: it never reaches into supervision state, and
 * supervision never reaches into job settlement. Everything they share crosses
 * this seam.
 */

import type { ReconciliationFailureReason, SupervisionEvent, SupervisionTransition } from "./events.js";
import type { SupervisionAgentStatus } from "./protocol.js";
import type { ReviewClassification } from "../reviewer.js";
import type { SupervisedIdentity } from "./identity.js";

export type SupervisionState = "reserved" | "active" | "degraded" | "settled";

export interface SupervisionChildView {
  agentName: string;
  agentKind: string;
  paneId: string;
  terminalId: string;
  /** The profile that actually started this child. */
  profileName: string;
  /** Present only when fallback selection changed the profile after reservation. */
  requestedProfileName?: string;
  /** Present only when fallback selection changed the kind after reservation. */
  requestedAgentKind?: string;
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
  thinking: "max";
  cadenceMinutes: number;
  degraded: boolean;
  reviews: SupervisionReviewView[];
  truncatedReviews: number;
  lastReviewAtMs?: number;
}

export interface SupervisionJobView {
  state: SupervisionState;
  monitor: SupervisionMonitorView;
  reviewer: SupervisionReviewerView;
  transitions: SupervisionTransition[];
  truncatedTransitions: number;
  events: SupervisionEvent[];
  truncatedEvents: number;
  unobservedEvents: number;
  child?: SupervisionChildView;
  status?: SupervisionAgentStatus;
  settledReason?: string;
}

/**
 * What the job registry may ask a supervisor for. `takePendingEvents` is the
 * only mutating call, and it marks exactly the events it returns.
 */
export interface SupervisionJobPort {
  view(): SupervisionJobView;
  takePendingEvents(): SupervisionEvent[];
  /** True while the exact child is still live, which refuses `herdr_jobs cancel`. */
  childLive(): boolean;
  /** Exact private identity match used only for semantic-review ownership. */
  coversIdentity?(identity: SupervisedIdentity): boolean;
  /** Stop supervising because the session is shutting down. */
  shutdown(): void;
}
