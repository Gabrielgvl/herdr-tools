import { randomUUID } from "node:crypto";
import {
  joinPromptTargetIdentity,
  samePromptTargetIdentity,
  type PromptTargetIdentity,
} from "./messages/prompt.js";

export const TARGET_EVIDENCE_KINDS = [
  "predicate_observed",
  "native_done_observed",
  "agent_absent_observed",
  "pane_absent_observed",
  "target_replaced",
  "identity_unknown",
] as const;
export type TargetEvidenceKind = (typeof TARGET_EVIDENCE_KINDS)[number];

export const TARGET_EVIDENCE_SOURCES = ["native_agent_wait", "composite_observation"] as const;
export type TargetEvidenceSource = (typeof TARGET_EVIDENCE_SOURCES)[number];

export interface TargetEvidence {
  kind: TargetEvidenceKind;
  observedAtMs: number;
  targetGenerationRef: string;
  currency: "historical_non_current";
  source: TargetEvidenceSource;
}

export type WaitTargetIdentity = PromptTargetIdentity;

export function createTargetGenerationRef(factory: () => string = randomUUID): string {
  const value = factory();
  if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/u.test(value)) {
    throw new Error("TARGET_GENERATION_REF_INVALID: target generation reference factory returned an invalid value");
  }
  return `target_generation_${value}`;
}

export function historicalTargetEvidence(
  kind: TargetEvidenceKind,
  observedAtMs: number,
  targetGenerationRef: string,
  source: TargetEvidenceSource,
): TargetEvidence {
  if (!TARGET_EVIDENCE_KINDS.includes(kind) || !TARGET_EVIDENCE_SOURCES.includes(source)) {
    throw new Error("TARGET_EVIDENCE_INVALID: unsupported historical target evidence");
  }
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) {
    throw new Error("TARGET_EVIDENCE_INVALID: observation time is invalid");
  }
  if (typeof targetGenerationRef !== "string" || targetGenerationRef.length === 0 || /[\0\r\n]/u.test(targetGenerationRef)) {
    throw new Error("TARGET_EVIDENCE_INVALID: target generation reference is invalid");
  }
  return {
    kind,
    observedAtMs,
    targetGenerationRef,
    currency: "historical_non_current",
    source,
  };
}

export function isTargetEvidence(value: unknown): value is TargetEvidence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return TARGET_EVIDENCE_KINDS.includes(candidate.kind as TargetEvidenceKind)
    && Number.isSafeInteger(candidate.observedAtMs)
    && (candidate.observedAtMs as number) >= 0
    && typeof candidate.targetGenerationRef === "string"
    && candidate.targetGenerationRef.length > 0
    && !/[\0\r\n]/u.test(candidate.targetGenerationRef)
    && candidate.currency === "historical_non_current"
    && TARGET_EVIDENCE_SOURCES.includes(candidate.source as TargetEvidenceSource);
}

/** Require the complete identity needed to bind a wait to one occupant. */
export function requireWaitTargetIdentity(values: unknown[], expectedPaneId: string): WaitTargetIdentity {
  return joinPromptTargetIdentity(values, expectedPaneId);
}

export function sameWaitTargetIdentity(left: WaitTargetIdentity, right: WaitTargetIdentity): boolean {
  return samePromptTargetIdentity(left, right);
}
