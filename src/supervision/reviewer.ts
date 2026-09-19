/**
 * The supervisor's own reviewer.
 *
 * A supervisor reviews a child that has been working continuously for a whole
 * cadence with no transition to read. ADR-033 moved that judgement from a
 * pinned frontier chat model to `typesafe/jev-latest`; ADR-034 replaces the
 * inherited single-choice contract with a dedicated one: one `systemOne` call
 * carrying six independent `noul` predicates and a `reason` choice, then a
 * deterministic reducer. The signals are non-exclusive by design, an evidence
 * gate answers "can we judge?" before any signal answers "what do we see?", and
 * the launch's authorial digest plus the previous review's state give `risk`,
 * `appears_complete`, and `stalled` the semantics transcript evidence alone
 * cannot carry. It still never reads `wait.reviewerModel`, which governs only
 * the explicit wait reviewer.
 *
 * It never starts a Herdr agent and never creates a pane.
 */

import { APIError, choice, noul, type EntryType, type Fetch } from "@typesafe-ai/sdk";
import {
  MAX_SUMMARY_CHARS,
  REASON_CRITERIA,
  reduceSupervisionReview,
  ReviewerFailure,
  SUPERVISION_REASONS,
  type ReviewClassification,
  type SupervisionReason,
  type SupervisionSignalProbabilities,
} from "../reviewer.js";
import { createTypeSafeClient, typeSafeReviewerApiKey, type TypeSafeReviewerOptions } from "../typesafe-reviewer.js";

/** The exact supervisor review model. Not configurable: see ADR-033. */
export const SUPERVISION_REVIEWER_MODEL = "typesafe/jev-latest";

/** The model id the System One client sends — the prefixed public name without its provider prefix. */
const SUPERVISION_JEV_MODEL = "jev-latest";

/** Classifications that wake the manager while the supervisor stays active. */
export const SUPERVISION_ATTENTION_CLASSIFICATIONS = ["stalled", "blocked", "risk", "appears_complete", "unknown"] as const;

export function needsManagerAttention(classification: ReviewClassification): boolean {
  return (SUPERVISION_ATTENTION_CLASSIFICATIONS as readonly string[]).includes(classification);
}

// The reducer, thresholds, signal probabilities, and reason taxonomy live in
// the shared reviewer module (src/reviewer.ts) — both this module and
// typesafe-reviewer.ts already depend on it, and the reverse import would
// cycle. Re-exported here so every existing consumer is unchanged.
export {
  reduceSupervisionReview,
  SUPERVISION_APPEARS_COMPLETE_THRESHOLD,
  SUPERVISION_BLOCKED_THRESHOLD,
  SUPERVISION_EVIDENCE_THRESHOLD,
  SUPERVISION_PROGRESS_THRESHOLD,
  SUPERVISION_RISK_THRESHOLD,
  SUPERVISION_REASONS,
  SUPERVISION_STALLED_FIRST_OBSERVATION_THRESHOLD,
  SUPERVISION_STALLED_THRESHOLD,
} from "../reviewer.js";
export type { SupervisionReason, SupervisionSignalProbabilities } from "../reviewer.js";

/** The launch's authorial contract, carried to the reviewer as state. Either array may be empty. */
export interface SupervisionAssignmentDigest {
  doneWhen: string[];
  constraints: string[];
}

/** What the previous completed review recorded, supplied back as state on the next one. Absent on the first review. */
export interface SupervisionPreviousReview {
  classification: ReviewClassification;
  signals?: SupervisionSignalProbabilities;
  lastMeaningfulProgressAtMs?: number;
}

export interface SupervisionReviewRequest {
  paneId: string;
  agentName: string;
  workingForMs: number;
  metadata: Record<string, unknown>;
  transcriptDelta: string[];
  /** The authorial done-when/constraints the launch supplied; absent when none was given. */
  assignmentDigest?: SupervisionAssignmentDigest;
  /** The prior review's memory; absent until a first review completes. */
  previousReview?: SupervisionPreviousReview;
  /** Runtime hint: how many transcript lines are new since the previous completed review. */
  linesSinceLastReview?: number;
}

/**
 * The public contract stays `{classification, summary}`. The V2 telemetry is
 * additive: the reviewer's own implementation always supplies it, and a review
 * record persists every signal probability — including the non-activating
 * ones — the reason code, and the evidence-sufficiency probability.
 */
export interface SupervisionReviewResult {
  classification: ReviewClassification;
  summary: string;
  signals?: SupervisionSignalProbabilities;
  evidenceSufficiency?: number;
  reason?: SupervisionReason;
}

export interface SupervisionReviewer {
  review(request: SupervisionReviewRequest, signal: AbortSignal): Promise<SupervisionReviewResult>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function reason(value: unknown): value is SupervisionReason {
  return typeof value === "string" && (SUPERVISION_REASONS as readonly string[]).includes(value);
}

function aborted(targetId: string): ReviewerFailure {
  return new ReviewerFailure("Reviewer operation aborted", { targetId, code: "ABORTED" });
}

function noulAnswer(targetId: string, value: unknown): number {
  if (!record(value) || value.type !== "noul" || !probability(value.noul)) {
    throw new ReviewerFailure("TypeSafe reviewer returned an incompatible response", { targetId });
  }
  return value.noul;
}

function reasonAnswer(targetId: string, value: unknown): SupervisionReason {
  if (!record(value) || value.type !== "choice" || !reason(value.choice) || !probability(value.confidence) || !record(value.probabilities)) {
    throw new ReviewerFailure("TypeSafe reviewer returned an incompatible response", { targetId });
  }
  for (const name of SUPERVISION_REASONS) {
    if (!probability(value.probabilities[name])) {
      throw new ReviewerFailure("TypeSafe reviewer returned invalid probabilities", { targetId });
    }
  }
  return value.choice;
}

function parseAnswers(targetId: string, body: unknown): {
  evidenceSufficiency: number;
  signals: SupervisionSignalProbabilities;
  reason: SupervisionReason;
} {
  if (!record(body) || !record(body.answers)) {
    throw new ReviewerFailure("TypeSafe reviewer returned an incompatible response", { targetId });
  }
  const answers = body.answers;
  return {
    evidenceSufficiency: noulAnswer(targetId, answers.evidence_sufficient),
    signals: {
      progress: noulAnswer(targetId, answers.making_progress),
      stalled: noulAnswer(targetId, answers.stalled),
      blocked: noulAnswer(targetId, answers.blocked),
      risk: noulAnswer(targetId, answers.risk),
      appears_complete: noulAnswer(targetId, answers.appears_complete),
    },
    reason: reasonAnswer(targetId, answers.reason),
  };
}

function summaryFor(
  classificationValue: ReviewClassification,
  evidenceSufficiency: number,
  signals: SupervisionSignalProbabilities,
  reasonCode: SupervisionReason,
  lineCount: number,
): string {
  // Every signal probability is logged, including the ones that did not activate.
  const ranked = (Object.entries(signals) as Array<[keyof SupervisionSignalProbabilities, number]>)
    .sort((left, right) => right[1] - left[1])
    .map(([name, value]) => `${name} ${value.toFixed(2)}`)
    .join(", ");
  return `${classificationValue} (evidence ${evidenceSufficiency.toFixed(2)}); ${ranked}; reason ${reasonCode}; ${lineCount} new lines`.slice(0, MAX_SUMMARY_CHARS);
}

/**
 * The V2 System One reviewer. It performs exactly one HTTP request carrying
 * the seven fixed questions and never invokes a chat model: six `noul`
 * predicates for the evidence gate and the five signals, one `choice` for the
 * reason code. Client construction, key handling, defensive parsing, and
 * abort handling are the ones ADR-033 established.
 */
export class TypeSafeSupervisionReviewer implements SupervisionReviewer {
  private readonly apiKey: string | undefined;
  private readonly fetchCall: Fetch | undefined;

  constructor(options: TypeSafeReviewerOptions = {}) {
    this.apiKey = typeSafeReviewerApiKey(options);
    this.fetchCall = options.fetch;
  }

  async review(request: SupervisionReviewRequest, signal: AbortSignal): Promise<SupervisionReviewResult> {
    if (signal.aborted) throw aborted(request.paneId);
    if (this.apiKey === undefined || this.apiKey.length === 0) {
      throw new ReviewerFailure("TypeSafe reviewer is not authenticated", { targetId: request.paneId, model: SUPERVISION_REVIEWER_MODEL });
    }
    try {
      const client = createTypeSafeClient({
        apiKey: this.apiKey,
        defaultModel: SUPERVISION_JEV_MODEL,
        ...(this.fetchCall === undefined ? {} : { fetch: this.fetchCall }),
      });
      const response = await client.systemOne({
        state: {
          targetId: request.paneId,
          // The supervision-only fields fold into a copied metadata object, as
          // the shared question contract has always required.
          metadata: { ...request.metadata, agentName: request.agentName, workingForMs: request.workingForMs },
          transcriptDelta: request.transcriptDelta,
          assignmentDigest: request.assignmentDigest ?? { doneWhen: [], constraints: [] },
          ...(request.previousReview === undefined ? {} : { previousReview: request.previousReview }),
          ...(request.linesSinceLastReview === undefined ? {} : { linesSinceLastReview: request.linesSinceLastReview }),
        } as unknown as EntryType,
        questions: {
          evidence_sufficient: noul("Is there enough supplied evidence (transcript delta, metadata, assignment digest, and prior review state) to make a meaningful supervision judgment about this child agent?"),
          making_progress: noul("Does the evidence show meaningful advancement toward the assignment's objective within its constraints?"),
          stalled: noul("Does the evidence show repeated attempts, oscillation, idling, or lack of semantic advancement over the elapsed working time — rather than a single silent long-running operation?"),
          blocked: noul("Does the evidence show the agent is waiting on something it cannot resolve itself, such as credentials, permissions, an external dependency, or human input?"),
          risk: noul("Does the evidence show the agent moving toward an incorrect, unsafe, destructive, or out-of-constraint outcome relative to the assignment digest?"),
          appears_complete: noul("Does the evidence indicate the assignment's done-when conditions are effectively met even though the agent process has not terminated?"),
          reason: choice("Which single factor best explains the supplied evidence's overall picture? Choose none only when no specific factor stands out.", REASON_CRITERIA),
        },
      }, { signal });
      const answer = parseAnswers(request.paneId, response);
      const classification = reduceSupervisionReview(answer.evidenceSufficiency, answer.signals, { firstObservation: request.previousReview === undefined });
      return {
        classification,
        summary: summaryFor(classification, answer.evidenceSufficiency, answer.signals, answer.reason, request.transcriptDelta.length),
        signals: answer.signals,
        evidenceSufficiency: answer.evidenceSufficiency,
        reason: answer.reason,
      };
    } catch (error) {
      if (error instanceof ReviewerFailure) throw error;
      if (signal.aborted) throw aborted(request.paneId);
      throw new ReviewerFailure("TypeSafe reviewer request failed", {
        targetId: request.paneId,
        model: SUPERVISION_REVIEWER_MODEL,
        ...(error instanceof APIError ? { status: error.status } : {}),
        cause: (error as Error).message,
      });
    }
  }
}
