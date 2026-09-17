import { complete } from "@earendil-works/pi-ai/compat";
import type { Api, AssistantMessage, Context, Model, ProviderStreamOptions, TextContent } from "@earendil-works/pi-ai";

export const REVIEW_CLASSIFICATIONS = ["progress", "stalled", "blocked", "risk", "appears_complete", "unknown"] as const;
export type ReviewClassification = (typeof REVIEW_CLASSIFICATIONS)[number];

export interface ReviewerRequest {
  targetId: string;
  metadata: Record<string, unknown>;
  transcriptDelta: string[];
}

export interface ReviewerResult {
  targetId: string;
  classification: ReviewClassification;
  summary: string;
}

export interface WaitReviewer {
  review(request: ReviewerRequest, signal: AbortSignal): Promise<ReviewerResult>;
}

export interface ModelRegistrySeam {
  find(provider: string, modelId: string): Model<Api> | undefined;
  getAll(): Model<Api>[];
  getApiKeyAndHeaders(model: Model<Api>): Promise<{ ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string }>;
}

export type CompleteSeam = (model: Model<Api>, context: Context, options: ProviderStreamOptions) => Promise<AssistantMessage>;

export class ReviewerFailure extends Error {
  readonly code = "REVIEWER_FAILED" as const;
  constructor(message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ReviewerFailure";
  }
}

const MAX_PROMPT_BYTES = 16_000;
export const MAX_SUMMARY_CHARS = 500;

export function modelFor(registry: ModelRegistrySeam, identifier: string): Model<Api> {
  if (identifier.length === 0 || /\s/.test(identifier) || identifier.includes(String.fromCharCode(0))) throw new ReviewerFailure("Configured reviewer model identifier is invalid", { model: identifier });
  const separator = identifier.indexOf("/");
  const matches = separator > 0
    ? [registry.find(identifier.slice(0, separator), identifier.slice(separator + 1))].filter((model): model is Model<Api> => model !== undefined)
    : registry.getAll().filter((model) => model.id === identifier);
  if (matches.length !== 1) throw new ReviewerFailure("Configured reviewer model could not be resolved", { model: identifier });
  return matches[0];
}

/**
 * The reviewer's answer is only the assistant's text. Reasoning arrives as
 * `thinking` parts and is dropped here. The text is not truncated: it is the
 * parser's input, and clipping it turns a valid answer into a hard failure.
 */
export function textFrom(message: AssistantMessage): string {
  return message.content.filter((part): part is TextContent => part.type === "text").map((part) => part.text).join("");
}

/**
 * The body of the one markdown fence in the text, with an optional `json` tag
 * removed. A chat model told to return one JSON object routinely wraps it in a
 * fence and puts a sentence around it; that is the same intended answer, so it
 * is recovered. Any other wrapper, and any text carrying a second fence, stays
 * malformed. Scanned with `indexOf` rather than a pattern: this input is
 * unbounded model text, and an anchored pattern around a lazy body backtracks.
 */
function fencedBody(raw: string): string | undefined {
  const open = raw.indexOf("```");
  if (open < 0) return undefined;
  const close = raw.indexOf("```", open + 3);
  if (close < 0 || raw.includes("```", close + 3)) return undefined;
  const body = raw.slice(open + 3, close).trimStart();
  return body.toLowerCase().startsWith("json") ? body.slice(4) : body;
}

/**
 * The whole response is parsed first and, when it parses, it is the answer:
 * every response that already reached the schema checks keeps its exact
 * outcome, and no wrapper the contract refuses becomes acceptable. Only an
 * unparseable response falls back to the fenced body, which then faces the
 * unchanged schema checks below.
 */
function parsedResponse(raw: string, fenced: string | undefined): { value: unknown } | undefined {
  for (const candidate of [raw, fenced]) {
    if (candidate === undefined) continue;
    try {
      return { value: JSON.parse(candidate) };
    } catch {
      // Fall through to the fenced body, then to the malformed failure.
    }
  }
  return undefined;
}

/**
 * A content-free description of an unparseable response. The reviewer's text is
 * derived from a child's terminal transcript, so no part of it may reach an
 * event, a job detail, or a host projection; the size and structure that name
 * the defect can. `reviewer_degraded` carries only the failure message, so this
 * goes in the message as well as the details.
 */
function responseShape(raw: string, fenced: string | undefined): string {
  const chars = raw.trim().length;
  if (chars === 0) return "empty response";
  const structure = fenced !== undefined ? "fenced body did not parse" : raw.includes("```") ? "no single JSON fence" : "no JSON fence";
  return `${chars} chars, ${structure}`;
}

export function strictResult(targetId: string, raw: string): ReviewerResult {
  const fenced = fencedBody(raw);
  const response = parsedResponse(raw, fenced);
  if (response === undefined) {
    const shape = responseShape(raw, fenced);
    throw new ReviewerFailure(`Reviewer returned malformed JSON (${shape})`, { targetId, responseShape: shape });
  }
  const parsed = response.value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ReviewerFailure("Reviewer returned an incompatible response", { targetId });
  const value = parsed as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "classification" && key !== "summary") || !keys.includes("classification") || !keys.includes("summary")) {
    throw new ReviewerFailure("Reviewer returned an incompatible response", { targetId });
  }
  if (!REVIEW_CLASSIFICATIONS.includes(value.classification as ReviewClassification) || typeof value.summary !== "string") {
    throw new ReviewerFailure("Reviewer returned an invalid classification", { targetId });
  }
  return { targetId, classification: value.classification as ReviewClassification, summary: value.summary.slice(0, MAX_SUMMARY_CHARS) };
}

function promptFor(request: ReviewerRequest): string {
  const prompt = [
    "Classify the current Herdr target using only the supplied evidence.",
    "Return exactly one JSON object with only these keys: classification and summary.",
    "classification must be one of progress, stalled, blocked, risk, appears_complete, unknown.",
    JSON.stringify({ targetId: request.targetId, metadata: request.metadata, transcriptDelta: request.transcriptDelta })
  ].join("\n");
  return prompt.slice(0, MAX_PROMPT_BYTES);
}

/** Production reviewer adapter. It never consults the active model or creates a pane. */
export class PiModelReviewer implements WaitReviewer {
  private readonly model: Model<Api>;
  private readonly completeCall: CompleteSeam;

  constructor(registry: ModelRegistrySeam, modelIdentifier: string, completeCall: CompleteSeam = complete) {
    this.model = modelFor(registry, modelIdentifier);
    this.completeCall = completeCall;
    this.registry = registry;
  }

  private readonly registry: ModelRegistrySeam;

  async review(request: ReviewerRequest, signal: AbortSignal): Promise<ReviewerResult> {
    if (signal.aborted) throw new ReviewerFailure("Reviewer operation aborted", { targetId: request.targetId, code: "ABORTED" });
    const auth = await this.registry.getApiKeyAndHeaders(this.model);
    if (!auth.ok) throw new ReviewerFailure("Configured reviewer model is not authenticated", { targetId: request.targetId, model: this.model.id, cause: auth.error });
    try {
      const message = await this.completeCall(this.model, { messages: [{ role: "user", content: promptFor(request), timestamp: Date.now() }] }, {
        apiKey: auth.apiKey,
        headers: auth.headers,
        signal,
        maxTokens: 256,
        // The option name the transports read; one named for the thinking level
        // is silently dropped, leaving the spec's fixed `low` unapplied.
        reasoningEffort: "low"
      });
      if (signal.aborted || message.stopReason === "aborted") throw new ReviewerFailure("Reviewer operation aborted", { targetId: request.targetId, code: "ABORTED" });
      if (message.stopReason === "error") {
        throw new ReviewerFailure("Reviewer model call failed", {
          targetId: request.targetId,
          cause: message.errorMessage ?? "provider returned an unspecified error",
        });
      }
      return strictResult(request.targetId, textFrom(message));
    } catch (error) {
      if (error instanceof ReviewerFailure) throw error;
      throw new ReviewerFailure("Reviewer model call failed", { targetId: request.targetId, cause: error instanceof Error ? error.message : String(error) });
    }
  }
}

export function createPiModelReviewer(ctx: { modelRegistry: ModelRegistrySeam }, modelIdentifier: string): WaitReviewer {
  return new PiModelReviewer(ctx.modelRegistry, modelIdentifier);
}
