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
import { MAX_SUMMARY_CHARS, ReviewerFailure, type ReviewClassification } from "../reviewer.js";
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

/**
 * The owner-ratified activation thresholds (ADR-034). The evidence gate runs
 * before any signal; each signal then activates independently — none requires
 * the others to be low — and the first crossing in precedence order classifies.
 * The cost of error differs per signal: `risk` wakes a human so it favours
 * recall, while `appears_complete` and `stalled` sit higher because coding
 * agents habitually claim done early and a five-minute window makes builds,
 * tests, and idle subprocesses look like stalls.
 */
export const SUPERVISION_EVIDENCE_THRESHOLD = 0.60;
export const SUPERVISION_RISK_THRESHOLD = 0.60;
export const SUPERVISION_BLOCKED_THRESHOLD = 0.65;
export const SUPERVISION_APPEARS_COMPLETE_THRESHOLD = 0.70;
export const SUPERVISION_STALLED_THRESHOLD = 0.70;
export const SUPERVISION_PROGRESS_THRESHOLD = 0.60;

/** The five non-exclusive judgment signals and their probabilities. */
export interface SupervisionSignalProbabilities {
  progress: number;
  stalled: number;
  blocked: number;
  risk: number;
  appears_complete: number;
}

/** The fixed reason-code set the `reason` choice picks exactly one of. */
export const SUPERVISION_REASONS = [
  "none",
  "repetition",
  "no_output",
  "oscillation",
  "external_dependency",
  "missing_permission",
  "tool_failure",
  "scope_drift",
  "destructive_action",
  "incorrect_direction",
  "completion_claim",
  "artifact_produced",
  "verification_passed",
] as const;

export type SupervisionReason = (typeof SUPERVISION_REASONS)[number];

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

/**
 * The deterministic precedence reducer. The evidence gate classifies
 * `unknown` before any signal is read; otherwise the first crossing signal in
 * precedence order wins, and no crossing at all falls through to `unknown`
 * rather than forcing a label from a low-resolution zone.
 */
export function reduceSupervisionReview(evidenceSufficiency: number, signals: SupervisionSignalProbabilities): ReviewClassification {
  if (evidenceSufficiency < SUPERVISION_EVIDENCE_THRESHOLD) return "unknown";
  if (signals.risk >= SUPERVISION_RISK_THRESHOLD) return "risk";
  if (signals.blocked >= SUPERVISION_BLOCKED_THRESHOLD) return "blocked";
  if (signals.appears_complete >= SUPERVISION_APPEARS_COMPLETE_THRESHOLD) return "appears_complete";
  if (signals.stalled >= SUPERVISION_STALLED_THRESHOLD) return "stalled";
  if (signals.progress >= SUPERVISION_PROGRESS_THRESHOLD) return "progress";
  return "unknown";
}

const REASON_CRITERIA: Record<SupervisionReason, string> = {
  none: "No specific factor stands out",
  repetition: "The same action, output, or failure repeats without new effect",
  no_output: "Little or no new output appeared in the window",
  oscillation: "The agent flips between approaches without converging",
  external_dependency: "Progress waits on an external service, resource, or event",
  missing_permission: "A credential, grant, or approval the agent needs is missing",
  tool_failure: "A tool or command fails and blocks the current approach",
  scope_drift: "The work is drifting outside the assignment's scope",
  destructive_action: "The agent is taking or approaching a destructive or irreversible action",
  incorrect_direction: "The work is converging on a wrong answer or outcome",
  completion_claim: "The agent claims or signals the assignment is finished",
  artifact_produced: "A deliverable artifact exists and looks ready",
  verification_passed: "The assignment's verification checks have passed",
};

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
      const classification = reduceSupervisionReview(answer.evidenceSufficiency, answer.signals);
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
