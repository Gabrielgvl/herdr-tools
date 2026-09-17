import {
  MAX_SUMMARY_CHARS,
  PiModelReviewer,
  ReviewerFailure,
  type ModelRegistrySeam,
  type ReviewClassification,
  type ReviewerRequest,
  type ReviewerResult,
  type WaitReviewer,
} from "./reviewer.js";

export const TYPESAFE_REVIEW_CONFIDENCE_THRESHOLD = 0.5;
export const TYPESAFE_REVIEWER_PREFIX = "typesafe/";
const TYPESAFE_SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";

const CHOICES = {
  progress: "Output shows the assignment advancing",
  stalled: "Output is repeating or idling with no advance",
  blocked: "It is waiting on something it cannot resolve itself",
  risk: "It is advancing toward a wrong or damaging outcome",
  appears_complete: "The assignment looks finished but no terminal state was reached",
} as const;

type TypeSafeClassification = keyof typeof CHOICES;
type FetchSeam = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface TypeSafeReviewerOptions {
  apiKey?: string;
  fetch?: FetchSeam;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function classification(value: unknown): value is TypeSafeClassification {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CHOICES, value);
}

function aborted(targetId: string): ReviewerFailure {
  return new ReviewerFailure("Reviewer operation aborted", { targetId, code: "ABORTED" });
}

function parseAnswer(targetId: string, body: unknown): {
  choice: TypeSafeClassification;
  confidence: number;
  probabilities: Record<TypeSafeClassification, number>;
} {
  if (!record(body) || !record(body.answers) || !record(body.answers.classification)) {
    throw new ReviewerFailure("TypeSafe reviewer returned an incompatible response", { targetId });
  }
  const answer = body.answers.classification;
  if (answer.type !== "choice" || !classification(answer.choice) || !probability(answer.confidence) || !record(answer.probabilities)) {
    throw new ReviewerFailure("TypeSafe reviewer returned an incompatible response", { targetId });
  }
  const probabilities = {} as Record<TypeSafeClassification, number>;
  for (const name of Object.keys(CHOICES) as TypeSafeClassification[]) {
    const value = answer.probabilities[name];
    if (!probability(value)) throw new ReviewerFailure("TypeSafe reviewer returned invalid probabilities", { targetId });
    probabilities[name] = value;
  }
  return { choice: answer.choice, confidence: answer.confidence, probabilities };
}

function summaryFor(
  classificationValue: ReviewClassification,
  confidence: number,
  probabilities: Record<TypeSafeClassification, number>,
  lineCount: number,
): string {
  const ranked = (Object.entries(probabilities) as Array<[TypeSafeClassification, number]>)
    .sort((left, right) => right[1] - left[1])
    .map(([name, value]) => `${name} ${value.toFixed(2)}`)
    .join(", ");
  return `${classificationValue} (confidence ${confidence.toFixed(2)}); ${ranked}; ${lineCount} new lines`.slice(0, MAX_SUMMARY_CHARS);
}

/** System One Choice reviewer. It performs exactly one HTTP request and never invokes a chat model. */
export class TypeSafeReviewer implements WaitReviewer {
  private readonly apiKey: string | undefined;
  private readonly fetchCall: FetchSeam;

  constructor(private readonly modelId: string, options: TypeSafeReviewerOptions = {}) {
    if (modelId.length === 0 || /[\s\0]/u.test(modelId)) {
      throw new ReviewerFailure("Configured TypeSafe reviewer model identifier is invalid", { model: modelId });
    }
    this.apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
    this.fetchCall = options.fetch ?? globalThis.fetch;
  }

  async review(request: ReviewerRequest, signal: AbortSignal): Promise<ReviewerResult> {
    if (signal.aborted) throw aborted(request.targetId);
    if (this.apiKey === undefined || this.apiKey.length === 0) {
      throw new ReviewerFailure("TypeSafe reviewer is not authenticated", { targetId: request.targetId, model: this.modelId });
    }
    try {
      const response = await this.fetchCall(TYPESAFE_SYSTEM_ONE_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          state: {
            targetId: request.targetId,
            metadata: request.metadata,
            transcriptDelta: request.transcriptDelta,
          },
          model: this.modelId,
          questions: {
            classification: {
              type: "choice",
              instructions: "Judge only from the supplied evidence how this Herdr child agent is doing.",
              criteria: CHOICES,
            },
          },
        }),
        signal,
      });
      if (signal.aborted) throw aborted(request.targetId);
      if (!response.ok) {
        throw new ReviewerFailure("TypeSafe reviewer request failed", { targetId: request.targetId, model: this.modelId, status: response.status });
      }
      const answer = parseAnswer(request.targetId, await response.json());
      if (signal.aborted) throw aborted(request.targetId);
      const derived: ReviewClassification = answer.confidence < TYPESAFE_REVIEW_CONFIDENCE_THRESHOLD ? "unknown" : answer.choice;
      return {
        targetId: request.targetId,
        classification: derived,
        summary: summaryFor(derived, answer.confidence, answer.probabilities, request.transcriptDelta.length),
      };
    } catch (error) {
      if (error instanceof ReviewerFailure) throw error;
      if (signal.aborted) throw aborted(request.targetId);
      throw new ReviewerFailure("TypeSafe reviewer request failed", {
        targetId: request.targetId,
        model: this.modelId,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** Select the opt-in System One path or preserve the existing Pi reviewer unchanged. */
export function createConfiguredWaitReviewer(
  context: { modelRegistry: ModelRegistrySeam },
  modelIdentifier: string,
  options?: TypeSafeReviewerOptions,
  fallback?: () => WaitReviewer,
): WaitReviewer {
  if (modelIdentifier.startsWith(TYPESAFE_REVIEWER_PREFIX)) {
    return new TypeSafeReviewer(modelIdentifier.slice(TYPESAFE_REVIEWER_PREFIX.length), options);
  }
  return fallback?.() ?? new PiModelReviewer(context.modelRegistry, modelIdentifier);
}
