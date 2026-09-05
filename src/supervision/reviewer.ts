/**
 * The supervisor's own reviewer.
 *
 * It is deliberately not the `herdr_wait` reviewer: a supervisor reviews a child
 * that has been working continuously for a whole cadence with no transition to
 * read, which is a harder judgement than confirming a wait predicate. It
 * therefore pins an exact model at maximum thinking rather than reading
 * `wait.reviewerModel`, which continues to govern the explicit wait reviewer at
 * `low`.
 *
 * It never starts a Herdr agent and never creates a pane.
 */

import { complete } from "@earendil-works/pi-ai/compat";
import { ReviewerFailure, strictResult, textFrom, type CompleteSeam, type ReviewClassification } from "../reviewer.js";
import type { SupervisionModelService } from "./model-service.js";

/** The exact supervisor review model. Not configurable: see the module comment. */
export const SUPERVISION_REVIEWER_MODEL = "openai-codex/gpt-5.6-luna";
export const SUPERVISION_REVIEWER_THINKING = "max" as const;

const MAX_PROMPT_BYTES = 16_000;

/**
 * Bound the prompt by UTF-8 bytes, not by UTF-16 code units. A pane transcript is
 * arbitrary terminal output, so a character slice against a byte budget can emit
 * a request several times the advertised size. The head is kept: the instructions
 * come first and must survive.
 */
function boundedPromptBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let kept = "";
  let size = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (size + characterBytes > maxBytes) break;
    kept += character;
    size += characterBytes;
  }
  return kept;
}

/** Classifications that wake the manager while the supervisor stays active. */
export const SUPERVISION_ATTENTION_CLASSIFICATIONS = ["stalled", "blocked", "risk", "appears_complete", "unknown"] as const;

export function needsManagerAttention(classification: ReviewClassification): boolean {
  return (SUPERVISION_ATTENTION_CLASSIFICATIONS as readonly string[]).includes(classification);
}

export interface SupervisionReviewRequest {
  paneId: string;
  agentName: string;
  workingForMs: number;
  metadata: Record<string, unknown>;
  transcriptDelta: string[];
}

export interface SupervisionReviewResult {
  classification: ReviewClassification;
  summary: string;
}

export interface SupervisionReviewer {
  review(request: SupervisionReviewRequest, signal: AbortSignal): Promise<SupervisionReviewResult>;
}

function promptFor(request: SupervisionReviewRequest): string {
  const prompt = [
    "You supervise one Herdr child agent that has been continuously working with no state change.",
    "Judge only from the supplied evidence whether it is genuinely progressing.",
    "Return exactly one JSON object with only these keys: classification and summary.",
    "classification must be one of progress, stalled, blocked, risk, appears_complete, unknown.",
    JSON.stringify({
      paneId: request.paneId,
      agentName: request.agentName,
      workingForMs: request.workingForMs,
      metadata: request.metadata,
      transcriptDelta: request.transcriptDelta,
    }),
  ].join("\n");
  return boundedPromptBytes(prompt, MAX_PROMPT_BYTES);
}

export class ModelSupervisionReviewer implements SupervisionReviewer {
  constructor(
    private readonly models: SupervisionModelService,
    private readonly completeCall: CompleteSeam = complete,
    private readonly modelIdentifier: string = SUPERVISION_REVIEWER_MODEL,
  ) {}

  async review(request: SupervisionReviewRequest, signal: AbortSignal): Promise<SupervisionReviewResult> {
    if (signal.aborted) throw new ReviewerFailure("Supervision review aborted", { paneId: request.paneId, code: "ABORTED" });
    const resolved = await this.models.resolve(this.modelIdentifier);
    try {
      const message = await this.completeCall(resolved.model, { messages: [{ role: "user", content: promptFor(request), timestamp: Date.now() }] }, {
        ...(resolved.apiKey === undefined ? {} : { apiKey: resolved.apiKey }),
        ...(resolved.headers === undefined ? {} : { headers: resolved.headers }),
        signal,
        // The option name the transport reads; one named for the thinking level
        // is dropped. It sends no output-token limit, so none is requested here.
        reasoningEffort: SUPERVISION_REVIEWER_THINKING,
      });
      if (signal.aborted || message.stopReason === "aborted") throw new ReviewerFailure("Supervision review aborted", { paneId: request.paneId, code: "ABORTED" });
      const parsed = strictResult(request.paneId, textFrom(message));
      return { classification: parsed.classification, summary: parsed.summary };
    } catch (error) {
      if (error instanceof ReviewerFailure) throw error;
      throw new ReviewerFailure("Supervision review model call failed", { paneId: request.paneId, cause: error instanceof Error ? error.message : String(error) });
    }
  }
}
