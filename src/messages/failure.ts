import type { MessageDelivery } from "./limits.js";
import type { PromptDispatchEvidence } from "../agent-prompt.js";
import type { PublishedAttachment } from "./store.js";

export interface DeliveryFailureContext {
  delivery?: MessageDelivery;
  route?: string;
  phase?: string;
  published?: PublishedAttachment;
  promptDispatch?: PromptDispatchEvidence;
}

function safePromptDispatch(value: unknown): PromptDispatchEvidence | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as { state?: unknown; requestId?: unknown };
  if (candidate.state !== "not_written" && candidate.state !== "rejected" && candidate.state !== "acknowledged" && candidate.state !== "unknown") return undefined;
  if (candidate.requestId === undefined) return { state: candidate.state };
  if (typeof candidate.requestId !== "string" || candidate.requestId.length === 0 || candidate.requestId.length > 256 || /[\0\r\n]/u.test(candidate.requestId)) return { state: candidate.state };
  return { state: candidate.state, requestId: candidate.requestId };
}

/**
 * Keep a delivery failure's typed code and message while adding route, phase, and
 * body-free retained-attachment evidence. A published attachment stays on disk until it
 * expires, so a failed send must still name it.
 */
export function withDeliveryFailureEvidence(error: unknown, context: DeliveryFailureContext): unknown {
  if (typeof error !== "object" || error === null) return error;
  const failure = error as { details?: unknown };
  const existing = typeof failure.details === "object" && failure.details !== null && !Array.isArray(failure.details) ? failure.details as Record<string, unknown> : {};
  const promptDispatch = safePromptDispatch(context.promptDispatch ?? existing.promptDispatch);
  failure.details = {
    ...Object.fromEntries(Object.entries(existing).filter(([key]) => key !== "promptDispatch")),
    ...(context.delivery ? { delivery: context.delivery } : {}),
    ...(context.route ? { route: context.route } : {}),
    ...(context.phase ? { phase: context.phase } : {}),
    ...(promptDispatch === undefined ? {} : { promptDispatch }),
    ...(context.published ? { attachmentRetained: true, attachment: { ...context.published } } : {})
  };
  return error;
}
