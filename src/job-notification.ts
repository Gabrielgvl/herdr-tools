import { boundedText, type JobDetail } from "./job-registry.js";
import { WAIT_LABEL_MAX_BYTES } from "./wait-schema.js";

function safeNotificationPart(value: unknown, limit = 500): string {
  const text = typeof value === "string" ? value : String(value);
  const safe = [...text].map((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? " " : character;
  }).join("");
  return boundedText(safe, limit);
}

/**
 * The wait-job terminal notification. Supervisor jobs never reach it: their
 * wakes are material events delivered by the supervision notifier, and their
 * settlement is one of those events.
 */
export function notificationForJob(detail: JobDetail): { content: string; details: Record<string, unknown> } {
  const waitResult = detail.wait_result;
  const manager = waitResult === "manager_judgment_required";
  const conditionMatched = waitResult === "condition_met";
  const reason = detail.result?.reason ?? detail.cancelReason ?? detail.error?.code ?? detail.error?.message ?? "awaiting_settlement";
  const requestedTargets = detail.request.targets.map((target, index) => `${safeNotificationPart(target)} (${safeNotificationPart(detail.request.targetIds[index] ?? "unknown")})`).join(", ");
  const matchedRefs = conditionMatched ? detail.result?.matchedTargets ?? detail.result?.targets?.filter((target) => target.matched).map((target) => ({ target: target.target, targetId: target.targetId })) ?? [] : [];
  const matchedCount = conditionMatched ? detail.result?.matchedTargetCount ?? matchedRefs.length : 0;
  const matchedOmitted = conditionMatched ? Math.max(detail.truncation?.resultMatchedTargets ?? 0, matchedCount - matchedRefs.length) : 0;
  const matchedTargets = matchedRefs.map((target) => `${safeNotificationPart(target.target)} (${safeNotificationPart(target.targetId)})`).join(", ");
  const matchedSuffix = matchedOmitted > 0 ? `; matchedTargetsOmitted=${matchedOmitted}` : "";
  const evidenceKinds = detail.result?.targets?.flatMap((target) => target.target_evidence ? [target.target_evidence.kind] : []).slice(0, 16) ?? [];
  const error = detail.error ? `${safeNotificationPart(detail.error.code ?? "error")}: ${safeNotificationPart(detail.error.message)}` : undefined;
  const prefix = manager ? "HIGH PRIORITY: MANAGER JUDGMENT REQUIRED\n" : "";
  const publicResult = waitResult ?? "pending";
  const content = `${prefix}Herdr wait job ${safeNotificationPart(detail.jobId)} (${safeNotificationPart(detail.request.label, WAIT_LABEL_MAX_BYTES)}) reported: operation_phase=${safeNotificationPart(detail.operation_phase)}, wait_result=${safeNotificationPart(publicResult)}, reason=${safeNotificationPart(reason)} (wait condition only; target lifecycle unchanged), matchedTargets=${safeNotificationPart(matchedTargets || "none", 2_000)}${matchedSuffix}, requestedTargets=${safeNotificationPart(requestedTargets, 2_000)}${error ? `, error=${safeNotificationPart(error)}` : ""}`;
  const requestedIds = detail.request.targetIds.slice(0, 16).map((targetId) => safeNotificationPart(targetId, 256));
  const requestedOmitted = Math.max(detail.truncation?.requestTargetIds ?? 0, detail.request.targetIds.length - requestedIds.length);
  return {
    content: boundedText(content, 8_000),
    details: {
      jobId: safeNotificationPart(detail.jobId, 256),
      label: safeNotificationPart(detail.request.label, WAIT_LABEL_MAX_BYTES),
      action: "wait",
      operation_phase: detail.operation_phase,
      ...(waitResult === undefined ? {} : { wait_result: waitResult }),
      reason: safeNotificationPart(reason),
      targets: matchedRefs.slice(0, 16).map((target) => safeNotificationPart(target.targetId, 256)),
      matchedTargets: matchedRefs.slice(0, 16).map((target) => safeNotificationPart(target.targetId, 256)),
      matchedTargetCount: matchedCount,
      ...(evidenceKinds.length > 0 ? { target_evidence_kinds: evidenceKinds } : {}),
      ...(matchedOmitted > 0 ? { matchedTargetsOmitted: matchedOmitted } : {}),
      requestedTargets: requestedIds,
      ...(requestedOmitted > 0 ? { requestedTargetsOmitted: requestedOmitted } : {}),
      priority: manager ? "high" : "normal"
    }
  };
}
