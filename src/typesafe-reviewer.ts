import { APIError, choice, noul, TypeSafeClient, type EntryType, type Fetch } from "@typesafe-ai/sdk";
import { AuthJsonCredentialStore } from "./supervision/auth-json-credential-store.js";
import {
  MAX_SUMMARY_CHARS,
  PiModelReviewer,
  REASON_CRITERIA,
  reduceSupervisionReview,
  ReviewerFailure,
  SUPERVISION_BLOCKED_THRESHOLD,
  SUPERVISION_REASONS,
  SUPERVISION_RISK_THRESHOLD,
  type ModelRegistrySeam,
  type ReviewClassification,
  type ReviewerRequest,
  type ReviewerResult,
  type SupervisionReason,
  type SupervisionSignalProbabilities,
  type WaitReviewer,
} from "./reviewer.js";

/**
 * @deprecated Inert under the V2 contract: the evidence gate plus reducer
 * fallthrough replaced the single-choice confidence derivation, and nothing
 * here reads this value. Retained only because `typesafe-router.test.ts`
 * asserts it; remove when that assertion is updated.
 */
export const TYPESAFE_REVIEW_CONFIDENCE_THRESHOLD = 0.5;
export const TYPESAFE_REVIEWER_PREFIX = "typesafe/";

export interface TypeSafeReviewerOptions {
  apiKey?: string;
  fetch?: Fetch;
}

/**
 * The key every System One reviewer uses: an explicit option, then the
 * environment. Resolution to the Pi auth store happens once at the caller —
 * `resolveTypesafeApiKey` — and arrives here as the explicit option.
 */
export function typeSafeReviewerApiKey(options: TypeSafeReviewerOptions): string | undefined {
  return options.apiKey ?? process.env.TYPESAFE_API_KEY;
}

/** The one client construction every System One reviewer shares: logging off, retries off, an optional injected fetch. */
export function createTypeSafeClient(options: { apiKey: string; defaultModel: string; fetch?: Fetch }): TypeSafeClient {
  return new TypeSafeClient({
    apiKey: options.apiKey,
    defaultModel: options.defaultModel,
    logLevel: "off",
    retry: { maxRetries: 0 },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
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

function parseAnswer(targetId: string, body: unknown): {
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
 * The V2 System One wait reviewer. It performs exactly one HTTP request
 * carrying the seven fixed questions — six `noul` predicates (the evidence
 * gate and the five non-exclusive signals) plus the `reason` choice — using
 * the ADR-036 verbatim wordings, then reduces deterministically. Per the
 * ADR-036 reducer amendment, `risk` and `blocked` are interrupts evaluated
 * before the evidence gate; the shared reducer governs every classification
 * the gate still owns. The wait request carries no assignment, so `risk` and
 * `appears_complete` judge against an empty digest exactly as a digest-less
 * supervised launch does. It never invokes a chat model.
 */
export class TypeSafeReviewer implements WaitReviewer {
  private readonly apiKey: string | undefined;
  private readonly fetchCall: Fetch | undefined;

  constructor(private readonly modelId: string, options: TypeSafeReviewerOptions = {}) {
    if (modelId.length === 0 || /[\s\0]/u.test(modelId)) {
      throw new ReviewerFailure("Configured TypeSafe reviewer model identifier is invalid", { model: modelId });
    }
    this.apiKey = typeSafeReviewerApiKey(options);
    this.fetchCall = options.fetch;
  }

  async review(request: ReviewerRequest, signal: AbortSignal): Promise<ReviewerResult> {
    if (signal.aborted) throw aborted(request.targetId);
    if (this.apiKey === undefined || this.apiKey.length === 0) {
      throw new ReviewerFailure("TypeSafe reviewer is not authenticated", { targetId: request.targetId, model: this.modelId });
    }
    try {
      const client = createTypeSafeClient({
        apiKey: this.apiKey,
        defaultModel: this.modelId,
        ...(this.fetchCall === undefined ? {} : { fetch: this.fetchCall }),
      });
      const response = await client.systemOne({
        state: {
          targetId: request.targetId,
          metadata: request.metadata,
          transcriptDelta: request.transcriptDelta,
          assignmentDigest: { doneWhen: [], constraints: [] },
        } as EntryType,
        questions: {
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
        },
      }, { signal });
      const answer = parseAnswer(request.targetId, response);
      const classification: ReviewClassification =
        answer.signals.risk >= SUPERVISION_RISK_THRESHOLD ? "risk"
        : answer.signals.blocked >= SUPERVISION_BLOCKED_THRESHOLD ? "blocked"
        // The wait request folds the prior review into metadata (wait.ts); its
        // absence means no trajectory grounds the standard stalled bar.
        : reduceSupervisionReview(answer.evidenceSufficiency, answer.signals, { firstObservation: request.metadata.previousReview === undefined });
      return {
        targetId: request.targetId,
        classification,
        summary: summaryFor(classification, answer.evidenceSufficiency, answer.signals, answer.reason, request.transcriptDelta.length),
      };
    } catch (error) {
      if (error instanceof ReviewerFailure) throw error;
      if (signal.aborted) throw aborted(request.targetId);
      throw new ReviewerFailure("TypeSafe reviewer request failed", {
        targetId: request.targetId,
        model: this.modelId,
        ...(error instanceof APIError ? { status: error.status } : {}),
        cause: (error as Error).message,
      });
    }
  }
}

/**
 * Resolve the Jev API key from the Pi auth store first. A caller-supplied
 * explicit option still wins by construction (`TypeSafeReviewer` prefers
 * `options.apiKey`); otherwise the extension's shared `auth.json` is the
 * canonical source, so a stale `TYPESAFE_API_KEY` cannot silently override a
 * rotated key. The environment remains a compatibility fallback for isolated
 * tests and bootstrap processes. Key material is never logged or persisted
 * here.
 */
export async function resolveTypesafeApiKey(store: Pick<AuthJsonCredentialStore, "read"> = new AuthJsonCredentialStore()): Promise<string | undefined> {
  const credential = await store.read("typesafe").catch(() => undefined);
  if (credential?.type === "api_key" && typeof credential.key === "string" && credential.key.length > 0) return credential.key;
  const fromEnv = process.env.TYPESAFE_API_KEY;
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : undefined;
}

/** Select the opt-in System One path or preserve the existing Pi reviewer unchanged. */
export function createConfiguredWaitReviewer(
  context: { modelRegistry: ModelRegistrySeam },
  modelIdentifier: string,
  options?: TypeSafeReviewerOptions,
  fallback?: () => WaitReviewer,
): WaitReviewer {
  if (fallback !== undefined) return fallback();
  if (modelIdentifier.startsWith(TYPESAFE_REVIEWER_PREFIX)) {
    return new TypeSafeReviewer(modelIdentifier.slice(TYPESAFE_REVIEWER_PREFIX.length), options);
  }
  return new PiModelReviewer(context.modelRegistry, modelIdentifier);
}
