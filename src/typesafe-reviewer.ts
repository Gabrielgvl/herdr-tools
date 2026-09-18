import { APIError, choice, TypeSafeClient, type EntryType, type Fetch } from "@typesafe-ai/sdk";
import { AuthJsonCredentialStore } from "./supervision/auth-json-credential-store.js";
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

const CHOICES = {
  progress: "Output shows the assignment advancing",
  stalled: "Output is repeating or idling with no advance",
  blocked: "It is waiting on something it cannot resolve itself",
  risk: "It is advancing toward a wrong or damaging outcome",
  appears_complete: "The assignment looks finished but no terminal state was reached",
} as const;

type TypeSafeClassification = keyof typeof CHOICES;

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
        } as EntryType,
        questions: {
          classification: choice("Judge only from the supplied evidence how this Herdr child agent is doing.", CHOICES),
        },
      }, { signal });
      const answer = parseAnswer(request.targetId, response);
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
        ...(error instanceof APIError ? { status: error.status } : {}),
        cause: (error as Error).message,
      });
    }
  }
}

/**
 * Resolve the Jev API key in precedence order. A caller-supplied explicit
 * option always wins by construction (`TypeSafeReviewer` prefers
 * `options.apiKey`); this helper supplies the next two legs —
 * `TYPESAFE_API_KEY`, then the "typesafe" `api_key` entry in the Pi auth
 * credential store, the same file the Pi host logs into. A missing,
 * unreadable, or non-api-key entry resolves to `undefined`, which leaves the
 * reviewer's own "not authenticated" failure to surface at review time. Key
 * material is never logged or persisted here.
 */
export async function resolveTypesafeApiKey(store: Pick<AuthJsonCredentialStore, "read"> = new AuthJsonCredentialStore()): Promise<string | undefined> {
  const fromEnv = process.env.TYPESAFE_API_KEY;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const credential = await store.read("typesafe").catch(() => undefined);
  return credential?.type === "api_key" ? credential.key : undefined;
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
