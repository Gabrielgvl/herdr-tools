import type { MessageDelivery } from "./limits.js";
import type { PublishedAttachment } from "./store.js";

export interface DeliveryFailureContext {
  delivery?: MessageDelivery;
  route?: string;
  phase?: string;
  published?: PublishedAttachment;
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
  failure.details = {
    ...existing,
    ...(context.delivery ? { delivery: context.delivery } : {}),
    ...(context.route ? { route: context.route } : {}),
    ...(context.phase ? { phase: context.phase } : {}),
    ...(context.published ? { attachmentRetained: true, attachment: { ...context.published } } : {})
  };
  return error;
}
