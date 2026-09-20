/**
 * The supervisor's own reviewer.
 *
 * A supervisor reviews a child that has been working continuously for a whole
 * cadence with no transition to read. ADR-033 moved that judgement from a
 * pinned frontier chat model to `typesafe/jev-latest`; ADR-036 replaces the
 * V2 contract with V2.1: one `systemOne` call carrying six independent `noul`
 * predicates with verbatim contract wording and a `reason` choice, then the
 * shared deterministic reducer. The outbound state is the assembled evidence
 * state (E3's `buildEvidenceState` output) — assignment → trace digest →
 * workspace → terminal — never a raw transcript window. Attention, failure
 * normalization, and the summary are code-owned: Jev answers probabilities,
 * code decides what they mean. It still never reads `wait.reviewerModel`,
 * which governs only the explicit wait reviewer.
 *
 * It never starts a Herdr agent and never creates a pane.
 */

import { APIError, choice, noul, type EntryType, type Fetch } from "@typesafe-ai/sdk";
import {
  MAX_SUMMARY_CHARS,
  REASON_CRITERIA,
  reduceSupervisionReview,
  ReviewerFailure,
  SUPERVISION_EVIDENCE_THRESHOLD,
  SUPERVISION_REASONS,
  SUPERVISION_REDUCER_VERSION,
  SUPERVISION_THRESHOLDS,
  type ReviewClassification,
  type SupervisionReason,
  type SupervisionSignalProbabilities,
} from "../reviewer.js";
import { executionDigestHash, type DigestCursorRef, type EvidenceDrift, type EvidenceIdentityInput, type EvidenceState, type EvidenceVersionIdentity } from "./evidence.js";
import { createTypeSafeClient, typeSafeReviewerApiKey, type TypeSafeReviewerOptions } from "../typesafe-reviewer.js";

/** The exact supervisor review model. Not configurable: see ADR-033. */
export const SUPERVISION_REVIEWER_MODEL = "typesafe/jev-latest";

/** The model id the System One client sends — the prefixed public name without its provider prefix. */
const SUPERVISION_JEV_MODEL = "jev-latest";

/**
 * The ADR-036 question set, verbatim — wording is contract, workers do not
 * paraphrase. Six independent `noul` predicates and one `reason` choice in a
 * single `systemOne` call. The same object is both the request payload and
 * the `identity.questions` the evidence builder hashes, so a wording change
 * is question-set drift by construction.
 */
export const SUPERVISION_REVIEWER_QUESTIONS = {
  evidence_sufficient: noul(
    "Is the supplied evidence sufficient to make a meaningful judgment about the child's current execution state?",
    {
      true: "The trace, workspace state, terminal evidence, or previous observation provides concrete evidence about what the agent is doing or has changed.",
      false: "The evidence is absent, purely incidental, too ambiguous, or insufficient to distinguish meaningful execution states.",
    },
  ),
  progress: noul(
    "Does the supplied evidence show meaningful advancement toward the assignment since the previous observation, or within this observation when no previous observation exists?",
    {
      true: "Relevant implementation changed; new useful evidence established; a previously failing check now passes; a new milestone reached; a meaningful hypothesis tested; failure advanced toward resolution.",
      false: "Mere activity: re-reading, repeated commands, cosmetic churn, progress bars, unchanged failures.",
    },
  ),
  stalled: noul(
    "Does the evidence show repeated activity without meaningful advancement?",
    {
      true: "Repeated same approach; oscillation; same failure with no new evidence; no relevant artifact change across observations.",
      false: "Mere absence of output is NOT sufficient.",
    },
  ),
  blocked: noul(
    "Does the evidence show the child is waiting on a dependency, permission, information, resource, or action it cannot resolve itself?",
    { false: "A normal code error is not a blocker." },
  ),
  risk: noul(
    "Does the evidence show the child taking or preparing an incorrect, destructive, unauthorized, or assignment-violating action?",
    { true: "Includes `constraints` violations." },
  ),
  appears_complete: noul(
    "Does the evidence establish the assignment's doneWhen conditions sufficiently to make the child appear finished despite no terminal lifecycle state?",
    { false: "`progressMarkers` never count as completion criteria." },
  ),
  reason: choice("Which single factor best explains the supplied evidence's overall picture? Choose none only when no specific factor stands out.", REASON_CRITERIA),
};

/**
 * The reviewer-owned version-identity components the evidence builder hashes
 * (`EvidenceStateRequest.identity`): exactly the model, question set, reducer
 * version, and thresholds this reviewer sends. Supplying this object pins the
 * state's identity to what was actually sent — drift compares truth, not
 * assumption.
 */
export const SUPERVISION_REVIEWER_IDENTITY: EvidenceIdentityInput = {
  model: SUPERVISION_REVIEWER_MODEL,
  questions: SUPERVISION_REVIEWER_QUESTIONS,
  reducerVersion: SUPERVISION_REDUCER_VERSION,
  thresholds: SUPERVISION_THRESHOLDS,
};

/** The ADR-036 attention decision — `"wake_manager"` is the only wake. */
export type SupervisionAttention = "none" | "wake_manager";

/**
 * Why a review result exists — the ADR-036 V2 vocabulary. The ADR's shape
 * names this field `reason`, which the shipped result already uses for the
 * bounded reason-choice taxonomy; `outcome` carries it instead so both stay
 * intact.
 */
export type SupervisionReviewOutcome = "classified" | "baseline" | "insufficient_evidence" | "signal_conflict" | "reviewer_unavailable";

/** The sent evidence's provenance pointers — every wake is reconstructible to the exact state that produced it (ADR-036). */
export interface SupervisionReviewEvidence {
  /** The digest's cursor refs as `source@position:hash` labels; null when the window had no cursor on that side. */
  traceFromCursor: string | null;
  traceToCursor: string | null;
  /** SHA-256 over the sent digest's canonical bytes. */
  traceDigestHash: string;
  /** The workspace fingerprint; null when the cadence's view was unavailable. */
  workspaceFingerprint: string | null;
}

export interface SupervisionAttentionInput {
  classification: ReviewClassification;
  /** A `reviewer_unavailable` outcome is infrastructure failure, never evidence — it never wakes. */
  outcome?: SupervisionReviewOutcome;
  /** No completed review under a compatible calibration grounds this reservation. */
  firstObservation: boolean;
  /** How long the child has been working. */
  workingForMs: number;
  /** The supervision cadence; baseline grace is `workingForMs ≤ 2 × cadenceMs`. Absent ⇒ grace is unprovable ⇒ `unknown` wakes. */
  cadenceMs?: number;
}

/**
 * The code-owned attention policy (ADR-036), separate from classification:
 * `risk`, `blocked`, `appears_complete`, and `stalled` wake; `progress` is
 * silent; a first-observation `unknown` is silent only inside baseline grace
 * — the baseline acquisition is an expected state, not a finding — and wakes
 * once it expires. A reviewer failure is silent at every age.
 */
export function supervisionAttention(input: SupervisionAttentionInput): SupervisionAttention {
  if (input.outcome === "reviewer_unavailable") return "none";
  switch (input.classification) {
    case "risk":
    case "blocked":
    case "appears_complete":
    case "stalled":
      return "wake_manager";
    case "progress":
      return "none";
    case "unknown":
      return input.firstObservation && input.cadenceMs !== undefined && input.workingForMs <= 2 * input.cadenceMs ? "none" : "wake_manager";
  }
}

/**
 * The pre-V2.1 attention gate, retained for the caller W1 has not yet rewired.
 * Without review context it cannot express baseline grace, so `unknown` keeps
 * its legacy unconditional wake — the conservative direction.
 */
export function needsManagerAttention(classification: ReviewClassification): boolean {
  return supervisionAttention({ classification, firstObservation: false, workingForMs: 0 }) === "wake_manager";
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
  SUPERVISION_REDUCER_VERSION,
  SUPERVISION_STALLED_FIRST_OBSERVATION_THRESHOLD,
  SUPERVISION_STALLED_THRESHOLD,
  SUPERVISION_THRESHOLDS,
} from "../reviewer.js";
export type { SupervisionReason, SupervisionSignalProbabilities } from "../reviewer.js";

/** The launch's authorial contract. Either array may be empty. The reviewer sees it only as `evidence.assignment`, never as a raw field. */
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

/**
 * The dispatch context the outbound envelope carries — closed scalar fields
 * only. The reviewer rebuilds it field by field, so nothing a caller attached
 * beyond this shape can reach the wire (ADR-036 V2-02).
 */
export interface SupervisionRequestMetadata {
  agentKind: string;
  status: string;
  revision: number;
}

export interface SupervisionReviewRequest {
  paneId: string;
  agentName: string;
  workingForMs: number;
  metadata: SupervisionRequestMetadata;
  /** The prior review's memory; absent until a first review completes. */
  previousReview?: SupervisionPreviousReview;
  /** Runtime hint: how many transcript lines are new since the previous completed review. */
  linesSinceLastReview?: number;
  /**
   * The assembled V2.1 evidence state — already compacted, byte-bounded, and
   * scan-passed by `buildEvidenceState`. Mandatory: it IS the outbound
   * evidence, sent unchanged. A request without one has nothing safe to send
   * and resolves to `reviewer_unavailable` — there is no raw-input fallback.
   */
  evidence: EvidenceState;
  /** The supervision cadence in ms — bounds the baseline grace for a first-observation `unknown`. */
  cadenceMs?: number;
}

/**
 * The public contract stays `{classification, summary}`. The V2.1 telemetry
 * is additive: the reviewer's own implementation always supplies the signal
 * probabilities, the evidence-sufficiency probability, the bounded reason
 * code, the code-owned attention decision and outcome, and — when an
 * assembled evidence state was sent — the version-identity hash and the
 * drift against the reservation's baseline.
 */
export interface SupervisionReviewResult {
  classification: ReviewClassification;
  summary: string;
  /** The ADR-036 V2 internal shape marker. */
  schemaVersion?: 2;
  signals?: SupervisionSignalProbabilities;
  evidenceSufficiency?: number;
  reason?: SupervisionReason;
  /** The code-owned attention decision; `"wake_manager"` is the only wake. */
  attention?: SupervisionAttention;
  /** Why the result exists; `reviewer_unavailable` is infrastructure failure, not evidence about the child. */
  outcome?: SupervisionReviewOutcome;
  /** The sent evidence's provenance pointers; absent only when no state was sent (a refused request). */
  evidence?: SupervisionReviewEvidence;
  /** The sent state's version-identity hash — provenance for the review record. */
  identityHash?: string;
  /** Drift against the reservation's pinned identity — surfaced, never silently absorbed. */
  drift?: EvidenceDrift;
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
      progress: noulAnswer(targetId, answers.progress),
      stalled: noulAnswer(targetId, answers.stalled),
      blocked: noulAnswer(targetId, answers.blocked),
      risk: noulAnswer(targetId, answers.risk),
      appears_complete: noulAnswer(targetId, answers.appears_complete),
    },
    reason: reasonAnswer(targetId, answers.reason),
  };
}

/** Rebuild the temporal memory as its closed shape — a caller-supplied object is never forwarded to the wire verbatim. */
function closedPreviousReview(previous: SupervisionPreviousReview): SupervisionPreviousReview {
  const signals = previous.signals;
  return {
    classification: previous.classification,
    ...(signals === undefined ? {} : {
      signals: {
        progress: signals.progress,
        stalled: signals.stalled,
        blocked: signals.blocked,
        risk: signals.risk,
        appears_complete: signals.appears_complete,
      },
    }),
    ...(previous.lastMeaningfulProgressAtMs === undefined ? {} : { lastMeaningfulProgressAtMs: previous.lastMeaningfulProgressAtMs }),
  };
}

/** A cursor ref's label: source, position hint when the source carries one, and the cursor's identity hash. */
function cursorLabel(cursor: DigestCursorRef | undefined): string | null {
  if (cursor === undefined) return null;
  return cursor.position === undefined ? `${cursor.source}:${cursor.hash}` : `${cursor.source}@${cursor.position}:${cursor.hash}`;
}

/** The summary's trace anchor: the digest's `cursorTo` label. */
function traceLabel(evidence: EvidenceState | undefined): string {
  return cursorLabel(evidence?.trace.cursorTo) ?? "none";
}

/** The summary's workspace anchor: the cadence fingerprint, or the typed unavailability — never a fabricated clean state. */
function workspaceLabel(evidence: EvidenceState | undefined): string {
  const workspace = evidence?.workspace;
  if (workspace === undefined) return "none";
  return workspace.available ? workspace.fingerprint : `unavailable:${workspace.failure.reason}`;
}

/** The summary's shared tail — the bounded reason code, the trace cursor, the workspace fingerprint, and any drifted identity fields. */
function summaryTail(reason: SupervisionReason, evidence: EvidenceState | undefined): string {
  const parts = [`reason ${reason}`, `trace ${traceLabel(evidence)}`, `workspace ${workspaceLabel(evidence)}`];
  if (evidence?.drift.drifted === true) parts.push(`drift ${evidence.drift.fields.join("+")}`);
  return parts.join("; ");
}

/**
 * The deterministic, code-composed summary (ADR-036): the classification,
 * the evidence-sufficiency probability, every signal probability including
 * non-activating ones, and the shared provenance tail. Jev response text is
 * never part of it — Jev emits probabilities, not prose.
 */
function summaryFor(input: {
  classification: ReviewClassification;
  evidenceSufficiency: number;
  signals: SupervisionSignalProbabilities;
  reason: SupervisionReason;
  evidence?: EvidenceState;
}): string {
  const signals = (Object.entries(input.signals) as Array<[keyof SupervisionSignalProbabilities, number]>)
    .sort((left, right) => right[1] - left[1])
    .map(([name, value]) => `${name} ${value.toFixed(2)}`)
    .join(", ");
  return `${input.classification} (evidence ${input.evidenceSufficiency.toFixed(2)}); ${signals}; ${summaryTail(input.reason, input.evidence)}`.slice(0, MAX_SUMMARY_CHARS);
}

/** The sent evidence's provenance pointers, from the state itself — never from the model's reading of it. */
function evidenceProvenance(evidence: EvidenceState): SupervisionReviewEvidence {
  const workspace = evidence.workspace;
  return {
    traceFromCursor: cursorLabel(evidence.trace.cursorFrom),
    traceToCursor: cursorLabel(evidence.trace.cursorTo),
    traceDigestHash: executionDigestHash(evidence.trace),
    workspaceFingerprint: workspace.available ? workspace.fingerprint : null,
  };
}

/**
 * The ADR-036 failure normalization at the supervision boundary: a reviewer
 * that never answered — timeout, 429, 5xx, malformed response, or an evidence
 * state the builder refused (`sensitive`/oversized) — produces a silent
 * `unknown` / `none` / `reviewer_unavailable` result, not evidence about the
 * child and never a wake. The caller retries at the next cadence. When the
 * assembled state (or a refused build's identity) is supplied, its provenance
 * still surfaces on the result.
 */
export function supervisionReviewerUnavailable(input: { evidence?: EvidenceState; identity?: EvidenceVersionIdentity } = {}): SupervisionReviewResult {
  const evidence = input.evidence;
  const identity = evidence?.identity ?? input.identity;
  return {
    classification: "unknown",
    summary: `unknown (reviewer_unavailable); ${summaryTail("none", evidence)}`.slice(0, MAX_SUMMARY_CHARS),
    schemaVersion: 2,
    reason: "none",
    outcome: "reviewer_unavailable",
    attention: supervisionAttention({ classification: "unknown", outcome: "reviewer_unavailable", firstObservation: false, workingForMs: 0 }),
    ...(evidence === undefined ? {} : { evidence: evidenceProvenance(evidence), drift: evidence.drift }),
    ...(identity === undefined ? {} : { identityHash: identity.hash }),
  };
}

/**
 * The V2.1 System One reviewer. It performs exactly one HTTP request carrying
 * the seven fixed questions — six `noul` predicates for the evidence gate and
 * the five signals, one `choice` for the reason code — over the assembled
 * evidence state, the only state that may ever be sent. Client construction,
 * key handling, defensive parsing, and abort handling are the ones ADR-033
 * established.
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
    // The evidence state is mandatory (ADR-036 V2-02): only the compacted,
    // byte-bounded, scan-passed assembly may reach the model. A request
    // without one has nothing safe to send and resolves to the silent
    // unavailable result — the raw-input fallback is gone.
    const evidence: EvidenceState | undefined = request.evidence;
    if (evidence === undefined) return supervisionReviewerUnavailable();
    if (this.apiKey === undefined || this.apiKey.length === 0) {
      throw new ReviewerFailure("TypeSafe reviewer is not authenticated", { targetId: request.paneId, model: SUPERVISION_REVIEWER_MODEL });
    }
    // A drifted predecessor was produced under a different calibration: it is
    // not a compatible trajectory, so it is withheld from the sent state and
    // this review reduces as a first observation. The drift itself stays
    // visible — it ships inside `evidence.drift` and on the result.
    const previousReview = evidence.drift.drifted === true ? undefined : request.previousReview;
    const firstObservation = previousReview === undefined;
    // The non-evidence envelope is rebuilt field by field from closed scalar
    // slots — no caller object is ever forwarded to the wire.
    const state = {
      targetId: request.paneId,
      metadata: {
        agentName: request.agentName,
        workingForMs: request.workingForMs,
        agentKind: request.metadata.agentKind,
        status: request.metadata.status,
        revision: request.metadata.revision,
      },
      evidence,
      ...(previousReview === undefined ? {} : { previousReview: closedPreviousReview(previousReview) }),
      ...(request.linesSinceLastReview === undefined ? {} : { linesSinceLastReview: request.linesSinceLastReview }),
    };
    try {
      const client = createTypeSafeClient({
        apiKey: this.apiKey,
        defaultModel: SUPERVISION_JEV_MODEL,
        ...(this.fetchCall === undefined ? {} : { fetch: this.fetchCall }),
      });
      const response = await client.systemOne({
        state: state as unknown as EntryType,
        questions: SUPERVISION_REVIEWER_QUESTIONS,
      }, { signal });
      const answer = parseAnswers(request.paneId, response);
      const classification = reduceSupervisionReview(answer.evidenceSufficiency, answer.signals, { firstObservation });
      const attention = supervisionAttention({
        classification,
        firstObservation,
        workingForMs: request.workingForMs,
        cadenceMs: request.cadenceMs,
      });
      // The outcome names what produced the result: a real classification, a
      // silent baseline acquisition, a gate refusal, or a sufficient-evidence
      // fallthrough whose signals crossed nothing.
      const outcome: SupervisionReviewOutcome =
        classification !== "unknown" ? "classified"
        : attention === "none" ? "baseline"
        : answer.evidenceSufficiency < SUPERVISION_EVIDENCE_THRESHOLD ? "insufficient_evidence"
        : "signal_conflict";
      return {
        classification,
        summary: summaryFor({
          classification,
          evidenceSufficiency: answer.evidenceSufficiency,
          signals: answer.signals,
          reason: answer.reason,
          evidence,
        }),
        schemaVersion: 2,
        signals: answer.signals,
        evidenceSufficiency: answer.evidenceSufficiency,
        reason: answer.reason,
        attention,
        outcome,
        evidence: evidenceProvenance(evidence),
        identityHash: evidence.identity.hash,
        drift: evidence.drift,
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
