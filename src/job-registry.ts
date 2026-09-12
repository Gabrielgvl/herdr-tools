import { randomUUID } from "node:crypto";
import { truncateTail } from "@earendil-works/pi-coding-agent";
import { WAIT_LABEL_MAX_BYTES } from "./wait-schema.js";
import { isTargetEvidence, type TargetEvidence } from "./wait-target-evidence.js";
import type { SupervisionEvent } from "./supervision/events.js";
import type { SupervisedIdentity } from "./supervision/identity.js";
import { isSupervisionJobView, type SupervisionChildView, type SupervisionJobPort, type SupervisionJobView, type SupervisionProvisionalView } from "./supervision/state.js";

export const OPERATION_PHASES = ["accepted", "running", "cancel_requested", "settled"] as const;
export type OperationPhase = (typeof OPERATION_PHASES)[number];

export const JOB_KINDS = ["wait", "supervisor"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const WAIT_RESULTS = ["condition_met", "timed_out", "manager_judgment_required", "failed", "cancelled", "unknown"] as const;
export type WaitResult = (typeof WAIT_RESULTS)[number];

export const SUPERVISION_RESULTS = ["released", "identity_lost", "identity_replaced", "failed", "cancelled", "unknown"] as const;
export type SupervisionResult = (typeof SUPERVISION_RESULTS)[number];

/** The generic terminal outcomes both job kinds share. */
type GenericTerminal = "failed" | "cancelled" | "unknown";

export class SupervisionActiveError extends Error {
  readonly code = "SUPERVISION_ACTIVE" as const;

  constructor(readonly details: Record<string, unknown>) {
    super("SUPERVISION_ACTIVE: a supervisor cannot be cancelled while its exact child is live");
    this.name = "SupervisionActiveError";
  }
}

const MAX_TEXT_BYTES = 50_000;
const MAX_TEXT_LINES = 2_000;
const MAX_PUBLIC_BYTES = MAX_TEXT_BYTES - 1;
const MAX_SUMMARY_CHARS = 1_000;
const PUBLIC_REQUEST_ITEMS = 8;
const PUBLIC_RESULT_TARGETS = 6;
const PUBLIC_TARGET_LINES = 4;
const PUBLIC_REVIEWER_SUMMARIES = 6;
const PUBLIC_SUPERVISION_TRANSITIONS = 8;
const PUBLIC_SUPERVISION_EVENTS = 8;
const PUBLIC_SUPERVISION_REVIEWS = 6;
const PUBLIC_LIST_JOBS = 100;
const PUBLIC_SUMMARY_ITEMS = 2;
const PUBLIC_FIELD_BYTES = 256;
const SEMANTIC_REVIEW_COVERED_LIMIT = 6;
const SEMANTIC_REVIEW_EXPLICIT_LIMIT = 8;
const SEMANTIC_REVIEW_TARGET_BYTES = 128;
const SEMANTIC_REVIEW_JOB_ID_BYTES = 64;
const SEMANTIC_REVIEW_TOTAL_BYTES = 4_096;
type LateSettlementKind = "fulfilled" | "rejected";
type SupervisionBindingStage = "reserved" | "provisional" | "exact";

export interface TruncatedDetails {
  truncated: true;
  content: string;
  omittedBytes?: number;
  omittedLines?: number;
  clipped?: true;
}

export type PublicDetails = Record<string, unknown> | TruncatedDetails;

export interface JobTargetRef {
  target: string;
  targetId: string;
}

/** A bounded failure for one target in a partial multi-target observation. */
export interface JobTargetError {
  target: string;
  targetId: string;
  code: string;
  message: string;
}

/** The fields both request kinds share, so summaries and lists stay kind-agnostic. */
interface JobRequestCommon {
  label: string;
  targets: string[];
  targetIds: string[];
  target_generation_refs?: string[];
}

export interface WaitJobRequestSnapshot extends JobRequestCommon {
  kind: "wait";
  match: "any" | "all";
  condition: unknown;
  timeoutMs: number;
  settings: {
    reviewCadenceMinutes: number;
    reviewerModel: string;
    reviewerThinking: "max";
  };
}

/**
 * The child this supervisor watches.
 *
 * A reservation is taken before any topology mutation, so at first these are the
 * requested values and no pane or terminal id exists yet. Binding replaces the
 * profile and kind with the ones that actually started the child — profile
 * fallback can change both — and keeps the requested values beside them only
 * when they differ, so the request and the supervision view can never report
 * different profiles for the same child.
 */
export interface SupervisedJobChild {
  agentName: string;
  agentKind: string;
  profileName: string;
  requestedAgentKind?: string;
  requestedProfileName?: string;
}

export interface SupervisionChildBindingPublication {
  /** Mutate the private request snapshot without notifying public observers. */
  commit(): void;
  /** Restore the reserved request snapshot. Idempotent. */
  rollback(): void;
  /** Notify observers only after the supervisor has published matching state. */
  publish(): void;
}

/** The request half of an AGY provisional binding. */
export interface ProvisionalSupervisionChildBinding {
  agentKind: string;
  profileName: string;
}

export interface SupervisorJobRequestSnapshot extends JobRequestCommon {
  kind: "supervisor";
  child: SupervisedJobChild;
  settings: {
    reviewCadenceMinutes: number;
    reviewerModel: string;
    reviewerThinking: "max";
  };
}

export type JobRequestSnapshot = WaitJobRequestSnapshot | SupervisorJobRequestSnapshot;

export interface JobProgress {
  text: string;
  atMs: number;
  details?: unknown;
}

export interface WaitSemanticReviewProjection {
  observedAtMs: number;
  supervisorCovered: Array<{ target: string; targetId: string; supervisorJobId: string }>;
  explicitReviewerTargetIds: string[];
  omittedSupervisorCovered: number;
  omittedExplicitReviewerTargetIds: number;
}

export interface JobResultTargetSnapshot {
  target: string;
  targetId: string;
  metadata: PublicDetails;
  recentUnwrappedLines: string[];
  outputTruncated?: boolean;
  observedAtMs: number;
  matched: boolean;
  target_evidence?: TargetEvidence;
}

export interface JobResultSnapshot {
  wait_result: WaitResult;
  matched: boolean;
  reason?: string;
  /** Exact match facts are independent from the bounded evidence window. */
  matchedTargetCount?: number;
  matchedTargets?: Array<{ target: string; targetId: string }>;
  targetErrors?: JobTargetError[];
  targets?: JobResultTargetSnapshot[];
  reviewerSummaries?: Array<{
    target: string;
    targetId: string;
    classification: string;
    summary: string;
  }>;
}

export interface JobErrorSnapshot {
  code?: string;
  message: string;
  details?: unknown;
}

export interface JobTruncation {
  requestTargets?: number;
  requestTargetsClipped?: number;
  requestTargetIds?: number;
  requestTargetIdsClipped?: number;
  requestTargetGenerationRefs?: number;
  requestTargetGenerationRefsClipped?: number;
  requestCondition?: boolean;
  requestConditionClipped?: boolean;
  requestLabelClipped?: boolean;
  requestReviewerModelClipped?: boolean;
  jobIdClipped?: boolean;
  progressDetails?: boolean;
  progressTextClipped?: boolean;
  resultTargets?: number;
  resultMatchedTargets?: number;
  resultTargetValuesClipped?: number;
  resultTargetIdsClipped?: number;
  resultTargetGenerationRefsClipped?: number;
  resultTargetLines?: number;
  resultTargetLinesClipped?: number;
  resultTargetMetadata?: number;
  resultTargetEvidence?: number;
  resultTargetErrors?: number;
  reviewerSummaries?: number;
  reviewerFieldsClipped?: number;
  supervisionTransitions?: number;
  supervisionEvents?: number;
  supervisionReviews?: number;
  supervisionFieldsClipped?: number;
  pendingEvents?: number;
  errorDetails?: boolean;
  errorCodeClipped?: boolean;
  errorMessageClipped?: boolean;
  publicEvidenceOmitted?: boolean;
  lateSettlementClipped?: boolean;
}

export interface LateSettlementObservation {
  kind: LateSettlementKind;
  observedAtMs: number;
}

export interface JobDetail {
  jobId: string;
  kind: JobKind;
  operation_phase: OperationPhase;
  sequence: number;
  createdAtMs: number;
  startedAtMs?: number;
  finishedAtMs?: number;
  request: JobRequestSnapshot;
  progress?: JobProgress;
  semanticReview?: WaitSemanticReviewProjection;
  wait_result?: WaitResult;
  supervision_result?: SupervisionResult;
  supervision_reason?: string;
  result?: JobResultSnapshot;
  supervision?: SupervisionJobView;
  /** Soft receipts. Present only on a `get` that observed them. */
  pending_events?: SupervisionEvent[];
  unobservedEvents?: number;
  error?: JobErrorSnapshot;
  cancelReason?: "cancelled" | "shutdown";
  late_settlement_observed?: LateSettlementObservation;
  truncation?: JobTruncation;
}

export interface JobSummary {
  jobId: string;
  kind: JobKind;
  label: string;
  operation_phase: OperationPhase;
  sequence: number;
  createdAtMs: number;
  startedAtMs?: number;
  finishedAtMs?: number;
  targetIds: string[];
  targets: string[];
  wait_result?: WaitResult;
  supervision_result?: SupervisionResult;
  unobservedEvents?: number;
  reason?: string;
  progress?: { text: string; atMs: number };
  error?: { code?: string; message: string };
  truncation?: { targetIds?: number; targetIdsClipped?: number; targets?: number; targetsClipped?: number; targetGenerationRefs?: number; targetGenerationRefsClipped?: number; progress?: boolean; jobIdClipped?: boolean; labelClipped?: boolean };
}

export interface RunningJobOverview {
  jobs: JobSummary[];
  total: number;
  oldestStartedAtMs?: number;
}

export interface JobListResult {
  jobs: JobSummary[];
  total: number;
  offset: number;
  limit: number;
  nextOffset: number | null;
  truncation?: { jobs?: number; jobIdsClipped?: number };
}

export interface JobClock {
  now(): number;
}

export interface JobGeneration {
  readonly generation: number;
}

export interface JobOperationControl {
  readonly fence: number;
  readonly isOpen: () => boolean;
  readonly check: () => void;
  readonly beginActivity: () => () => void;
  readonly publishSemanticReview: (projection: WaitSemanticReviewProjection) => void;
}

export interface JobRunResult {
  wait_result: WaitResult;
  matched: boolean;
  reason?: string;
  matchedTargetCount?: number;
  matchedTargets?: JobResultSnapshot["matchedTargets"];
  targetErrors?: JobResultSnapshot["targetErrors"];
  targets?: JobResultSnapshot["targets"];
  reviewerSummaries?: JobResultSnapshot["reviewerSummaries"];
}

export interface SupervisionRunResult {
  supervision_result: SupervisionResult;
  reason?: string;
}

/** What a runner may return, discriminated by the job kind that registered it. */
export type JobKindRunResult = JobRunResult | SupervisionRunResult;

function isSupervisionRunResult(value: JobKindRunResult): value is SupervisionRunResult {
  return "supervision_result" in value;
}

export interface JobRunError {
  code?: string;
  message: string;
  details?: unknown;
}

export interface JobRegistryOptions {
  idFactory?: () => string;
  clock?: JobClock;
  onTerminal?: (detail: JobDetail) => void | Promise<void>;
  onChange?: () => void | Promise<void>;
  /** Maximum time allowed to observe runner/callback quiescence after cancellation. */
  quiescenceMs?: number;
}

export interface RegisteredJob {
  jobId: string;
  generation: JobGeneration;
  signal: AbortSignal;
  detail: JobDetail;
  promise: Promise<void>;
}

interface TransitionLock {
  runExclusive<T>(operation: () => T | Promise<T>): Promise<T>;
}

function transitionLock(): TransitionLock {
  let tail = Promise.resolve();
  return {
    runExclusive<T>(operation: () => T | Promise<T>): Promise<T> {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      return previous.then(operation).finally(release);
    }
  };
}

interface JobRecord {
  detail: JobDetail;
  controller: AbortController;
  generation: JobGeneration;
  lock: TransitionLock;
  control: JobOperationControl;
  gateOpen: boolean;
  fenceValue: number;
  runnerStarted: boolean;
  runnerDone: boolean;
  activityCount: number;
  executionPromise: Promise<void>;
  resolveDrain: Array<() => void>;
  supervision?: SupervisionJobPort;
  supervisionBindingStage: SupervisionBindingStage;
}

function sameOptional(left: string | undefined, right: string | undefined): boolean {
  return left === right;
}

function verifyInstalledSupervisor(record: JobRecord, stage: "provisional" | "exact", child: SupervisedJobChild, paneId?: string): void {
  if (!record.gateOpen || record.detail.operation_phase !== "running") throw new Error("SUPERVISION_BINDING_CLOSED: supervisor job is no longer running");
  const port = record.supervision;
  if (!port) throw new Error("SUPERVISION_PUBLICATION_UNCONFIRMED: supervisor state is not installed");
  let view: SupervisionJobView;
  try {
    view = port.view();
    if (!isSupervisionJobView(view) || port.childLive() !== true) throw new Error("invalid installed state");
  } catch {
    throw new Error("SUPERVISION_PUBLICATION_UNCONFIRMED: installed supervisor state is unavailable");
  }
  if (stage === "provisional") {
    if (view.state !== "provisional" || view.provisional.agentName !== child.agentName || view.provisional.agentKind !== child.agentKind || view.provisional.profileName !== child.profileName || !sameOptional(view.provisional.requestedProfileName, child.requestedProfileName)) {
      throw new Error("SUPERVISION_PUBLICATION_MISMATCH: installed provisional supervisor state does not match the binding");
    }
    return;
  }
  if ((view.state !== "active" && view.state !== "degraded") || view.child.agentName !== child.agentName || view.child.agentKind !== child.agentKind || view.child.profileName !== child.profileName || view.child.paneId !== paneId || !sameOptional(view.child.requestedAgentKind, child.requestedAgentKind) || !sameOptional(view.child.requestedProfileName, child.requestedProfileName)) {
    throw new Error("SUPERVISION_PUBLICATION_MISMATCH: installed exact supervisor state does not match the binding");
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function jsonText(value: unknown, pretty = false): string {
  return JSON.stringify(value, null, pretty ? 2 : undefined) as string;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(jsonText(value), "utf8");
}

function jsonLines(value: unknown): number {
  return jsonText(value, true).split("\n").length;
}

function fitJsonString(value: string, maxBytes: number): string {
  if (jsonBytes(value) <= maxBytes) return value;
  const characters = Array.from(value);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonBytes(characters.slice(0, middle).join("")) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return characters.slice(0, low).join("");
}

export function boundedText(value: string, limit = MAX_SUMMARY_CHARS): string {
  const lineBounded = truncateTail(value, { maxBytes: limit, maxLines: MAX_TEXT_LINES }).content;
  return fitJsonString(lineBounded, Math.max(2, limit));
}

function boundedOmission(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function incrementOmission(value: number, amount: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value + amount);
}

export function boundedSemanticReview(value: WaitSemanticReviewProjection): WaitSemanticReviewProjection {
  if (!Number.isSafeInteger(value.observedAtMs) || value.observedAtMs < 0 || !Array.isArray(value.supervisorCovered) || !Array.isArray(value.explicitReviewerTargetIds)) {
    throw new Error("SEMANTIC_REVIEW_INVALID: ownership projection is malformed");
  }
  if (value.supervisorCovered.some((entry) => typeof entry !== "object" || entry === null || typeof entry.target !== "string" || typeof entry.targetId !== "string" || typeof entry.supervisorJobId !== "string")
    || value.explicitReviewerTargetIds.some((targetId) => typeof targetId !== "string")) {
    throw new Error("SEMANTIC_REVIEW_INVALID: ownership projection entries are malformed");
  }
  const sourceCovered = value.supervisorCovered;
  const sourceExplicit = value.explicitReviewerTargetIds;
  const projection: WaitSemanticReviewProjection = {
    observedAtMs: value.observedAtMs,
    supervisorCovered: sourceCovered.slice(0, SEMANTIC_REVIEW_COVERED_LIMIT).map((entry) => ({
      target: boundedText(entry.target, SEMANTIC_REVIEW_TARGET_BYTES),
      targetId: boundedText(entry.targetId, SEMANTIC_REVIEW_TARGET_BYTES),
      supervisorJobId: boundedText(entry.supervisorJobId, SEMANTIC_REVIEW_JOB_ID_BYTES),
    })),
    explicitReviewerTargetIds: sourceExplicit.slice(0, SEMANTIC_REVIEW_EXPLICIT_LIMIT).map((targetId) => boundedText(targetId, SEMANTIC_REVIEW_TARGET_BYTES)),
    omittedSupervisorCovered: incrementOmission(boundedOmission(value.omittedSupervisorCovered), Math.max(0, sourceCovered.length - SEMANTIC_REVIEW_COVERED_LIMIT)),
    omittedExplicitReviewerTargetIds: incrementOmission(boundedOmission(value.omittedExplicitReviewerTargetIds), Math.max(0, sourceExplicit.length - SEMANTIC_REVIEW_EXPLICIT_LIMIT)),
  };
  while (jsonBytes(projection) > SEMANTIC_REVIEW_TOTAL_BYTES && (projection.supervisorCovered.length > 0 || projection.explicitReviewerTargetIds.length > 0)) {
    const coveredTailBytes = projection.supervisorCovered.length === 0 ? -1 : jsonBytes(projection.supervisorCovered.at(-1));
    const explicitTailBytes = projection.explicitReviewerTargetIds.length === 0 ? -1 : jsonBytes(projection.explicitReviewerTargetIds.at(-1));
    if (coveredTailBytes >= explicitTailBytes) {
      projection.supervisorCovered.pop();
      projection.omittedSupervisorCovered = incrementOmission(projection.omittedSupervisorCovered, 1);
    } else {
      projection.explicitReviewerTargetIds.pop();
      projection.omittedExplicitReviewerTargetIds = incrementOmission(projection.omittedExplicitReviewerTargetIds, 1);
    }
  }
  return projection;
}

function truncatedDetails(content: string, maxBytes = PUBLIC_FIELD_BYTES): TruncatedDetails {
  const omittedBytes = Buffer.byteLength(content, "utf8");
  const omittedLines = content.split("\n").length;
  let marker: TruncatedDetails = { truncated: true, content: "", omittedBytes, omittedLines, clipped: true };
  const contentBudget = Math.max(0, maxBytes - jsonBytes(marker));
  marker = { ...marker, content: fitJsonString(content, contentBudget) };
  return marker;
}

function hasTruncatedMarker(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "truncated" in value && (value as { truncated?: unknown }).truncated === true;
}

function boundedDetails(value: unknown, maxBytes = PUBLIC_FIELD_BYTES): unknown {
  try {
    const copied = clone(value);
    if (jsonBytes(copied) <= maxBytes && jsonLines(copied) <= MAX_TEXT_LINES) return copied;
    return truncatedDetails(jsonText(copied), maxBytes);
  } catch {
    return truncatedDetails("[details unavailable]", maxBytes);
  }
}

function boundedMetadata(value: Record<string, unknown>): PublicDetails {
  return boundedDetails(value, PUBLIC_FIELD_BYTES) as PublicDetails;
}

function boundedCondition(value: unknown, truncation: JobTruncation, maxBytes = PUBLIC_FIELD_BYTES): unknown {
  let copied: unknown;
  try {
    copied = clone(value);
  } catch {
    truncation.requestCondition = true;
    return truncatedDetails("[condition unavailable]", maxBytes);
  }
  if (jsonBytes(copied) <= maxBytes && jsonLines(copied) <= MAX_TEXT_LINES) return copied;
  const condition = copied as { kind?: unknown; match?: { kind?: unknown; value?: unknown } };
  truncation.requestCondition = true;
  if (condition.kind !== "output" || !condition.match || typeof condition.match.value !== "string") return { truncated: true, kind: "object" };
  const valueText = boundedText(condition.match.value, maxBytes);
  if (valueText !== condition.match.value) truncation.requestConditionClipped = true;
  return { kind: "output", match: { kind: condition.match.kind, value: valueText } };
}

function boundedStrings(
  values: string[],
  limit: number,
  truncation: JobTruncation,
  key: "requestTargets" | "requestTargetIds" | "requestTargetGenerationRefs",
  clippedKey: "requestTargetsClipped" | "requestTargetIdsClipped" | "requestTargetGenerationRefsClipped"
): string[] {
  const selected = values.slice(0, limit);
  const copied = selected.map((value) => boundedText(value, PUBLIC_FIELD_BYTES));
  const omitted = values.length - copied.length;
  const clipped = selected.filter((value, index) => copied[index] !== value).length;
  if (omitted > 0) truncation[key] = omitted;
  if (clipped > 0) truncation[clippedKey] = clipped;
  return copied;
}

function copyRequest(request: JobRequestSnapshot, truncation: JobTruncation): JobRequestSnapshot {
  const label = boundedText(request.label, WAIT_LABEL_MAX_BYTES);
  if (label !== request.label) truncation.requestLabelClipped = true;
  const reviewerModel = boundedText(request.settings.reviewerModel, PUBLIC_FIELD_BYTES);
  if (reviewerModel !== request.settings.reviewerModel) truncation.requestReviewerModelClipped = true;
  const refs = request.target_generation_refs === undefined
    ? undefined
    : boundedStrings(request.target_generation_refs, PUBLIC_REQUEST_ITEMS, truncation, "requestTargetGenerationRefs", "requestTargetGenerationRefsClipped");
  const common = {
    label,
    targets: boundedStrings(request.targets, PUBLIC_REQUEST_ITEMS, truncation, "requestTargets", "requestTargetsClipped"),
    targetIds: boundedStrings(request.targetIds, PUBLIC_REQUEST_ITEMS, truncation, "requestTargetIds", "requestTargetIdsClipped"),
    ...(refs === undefined ? {} : { target_generation_refs: refs })
  };
  if (request.kind === "supervisor") {
    return {
      kind: "supervisor",
      ...common,
      child: {
        agentName: boundedText(request.child.agentName, PUBLIC_FIELD_BYTES),
        agentKind: boundedText(request.child.agentKind, PUBLIC_FIELD_BYTES),
        profileName: boundedText(request.child.profileName, PUBLIC_FIELD_BYTES),
        ...(request.child.requestedAgentKind === undefined ? {} : { requestedAgentKind: boundedText(request.child.requestedAgentKind, PUBLIC_FIELD_BYTES) }),
        ...(request.child.requestedProfileName === undefined ? {} : { requestedProfileName: boundedText(request.child.requestedProfileName, PUBLIC_FIELD_BYTES) })
      },
      settings: {
        reviewCadenceMinutes: request.settings.reviewCadenceMinutes,
        reviewerModel,
        reviewerThinking: request.settings.reviewerThinking
      }
    };
  }
  return {
    kind: "wait",
    ...common,
    match: request.match,
    condition: boundedCondition(request.condition, truncation),
    timeoutMs: request.timeoutMs,
    settings: {
      reviewCadenceMinutes: request.settings.reviewCadenceMinutes,
      reviewerModel,
      reviewerThinking: request.settings.reviewerThinking
    }
  };
}

function boundedSupervisionEvent(event: SupervisionEvent, truncation: JobTruncation): SupervisionEvent {
  const eventId = boundedText(event.eventId, PUBLIC_FIELD_BYTES);
  const summary = boundedText(event.summary, PUBLIC_FIELD_BYTES);
  if (eventId !== event.eventId || summary !== event.summary) truncation.supervisionFieldsClipped = (truncation.supervisionFieldsClipped ?? 0) + 1;
  return { eventId, atMs: event.atMs, type: event.type, priority: event.priority, summary, ...(event.details === undefined ? {} : { details: event.details }) };
}

function boundedProvisional(view: SupervisionProvisionalView, truncation: JobTruncation): SupervisionProvisionalView {
  const agentName = boundedText(view.agentName, PUBLIC_FIELD_BYTES);
  const paneId = boundedText(view.paneId, PUBLIC_FIELD_BYTES);
  const terminalId = boundedText(view.terminalId, PUBLIC_FIELD_BYTES);
  const profileName = boundedText(view.profileName, PUBLIC_FIELD_BYTES);
  const requestedProfileName = view.requestedProfileName === undefined ? undefined : boundedText(view.requestedProfileName, PUBLIC_FIELD_BYTES);
  const clipped = [
    agentName !== view.agentName,
    paneId !== view.paneId,
    terminalId !== view.terminalId,
    profileName !== view.profileName,
    requestedProfileName !== view.requestedProfileName,
  ].some(Boolean);
  if (clipped) truncation.supervisionFieldsClipped = (truncation.supervisionFieldsClipped ?? 0) + 1;
  return {
    agentName,
    agentKind: "agy",
    paneId,
    terminalId,
    profileName,
    ...(requestedProfileName === undefined ? {} : { requestedProfileName }),
    baseline: { ...view.baseline }
  };
}

function boundedChild(view: SupervisionChildView, truncation: JobTruncation): SupervisionChildView {
  const agentName = boundedText(view.agentName, PUBLIC_FIELD_BYTES);
  const agentKind = boundedText(view.agentKind, PUBLIC_FIELD_BYTES);
  const paneId = boundedText(view.paneId, PUBLIC_FIELD_BYTES);
  const terminalId = boundedText(view.terminalId, PUBLIC_FIELD_BYTES);
  const profileName = boundedText(view.profileName, PUBLIC_FIELD_BYTES);
  const requestedProfileName = view.requestedProfileName === undefined ? undefined : boundedText(view.requestedProfileName, PUBLIC_FIELD_BYTES);
  const requestedAgentKind = view.requestedAgentKind === undefined ? undefined : boundedText(view.requestedAgentKind, PUBLIC_FIELD_BYTES);
  if ([
    agentName !== view.agentName,
    agentKind !== view.agentKind,
    paneId !== view.paneId,
    terminalId !== view.terminalId,
    profileName !== view.profileName,
    requestedProfileName !== view.requestedProfileName,
    requestedAgentKind !== view.requestedAgentKind,
  ].some(Boolean)) truncation.supervisionFieldsClipped = (truncation.supervisionFieldsClipped ?? 0) + 1;
  return {
    agentName,
    agentKind,
    paneId,
    terminalId,
    profileName,
    ...(requestedProfileName === undefined ? {} : { requestedProfileName }),
    ...(requestedAgentKind === undefined ? {} : { requestedAgentKind }),
  };
}

function boundedSupervision(view: SupervisionJobView, truncation: JobTruncation): SupervisionJobView | undefined {
  if (!isSupervisionJobView(view)) {
    truncation.publicEvidenceOmitted = true;
    return undefined;
  }
  const transitions = view.transitions.slice(-PUBLIC_SUPERVISION_TRANSITIONS);
  const events = view.events.slice(-PUBLIC_SUPERVISION_EVENTS).map((event) => boundedSupervisionEvent(event, truncation));
  const reviews = view.reviewer.reviews.slice(-PUBLIC_SUPERVISION_REVIEWS).map((review) => {
    const summary = boundedText(review.summary, PUBLIC_FIELD_BYTES);
    if (summary !== review.summary) truncation.supervisionFieldsClipped = (truncation.supervisionFieldsClipped ?? 0) + 1;
    return { atMs: review.atMs, classification: review.classification, summary };
  });
  const omittedTransitions = view.transitions.length - transitions.length;
  const omittedEvents = view.events.length - events.length;
  const omittedReviews = view.reviewer.reviews.length - reviews.length;
  if (omittedTransitions > 0) truncation.supervisionTransitions = omittedTransitions;
  if (omittedEvents > 0) truncation.supervisionEvents = omittedEvents;
  if (omittedReviews > 0) truncation.supervisionReviews = omittedReviews;
  const common = {
    monitor: { ...view.monitor },
    reviewer: {
      model: boundedText(view.reviewer.model, PUBLIC_FIELD_BYTES),
      thinking: view.reviewer.thinking,
      cadenceMinutes: view.reviewer.cadenceMinutes,
      degraded: view.reviewer.degraded,
      reviews,
      truncatedReviews: view.reviewer.truncatedReviews + omittedReviews,
      ...(view.reviewer.lastReviewAtMs === undefined ? {} : { lastReviewAtMs: view.reviewer.lastReviewAtMs })
    },
    transitions,
    truncatedTransitions: view.truncatedTransitions + omittedTransitions,
    events,
    truncatedEvents: view.truncatedEvents + omittedEvents,
    unobservedEvents: view.unobservedEvents,
    ...(view.settledReason === undefined ? {} : { settledReason: boundedText(view.settledReason, PUBLIC_FIELD_BYTES) })
  };
  if (view.state === "provisional") return {
    ...common,
    state: "provisional",
    provisional: boundedProvisional(view.provisional, truncation),
    ...(view.status === undefined ? {} : { status: view.status })
  };
  if (view.state === "active" || view.state === "degraded") return {
    ...common,
    state: view.state,
    child: boundedChild(view.child, truncation),
    status: view.status
  };
  if (view.state === "reserved") return { ...common, state: "reserved" };
  return {
    ...common,
    state: "settled",
    ...(view.child === undefined ? {} : { child: boundedChild(view.child, truncation) }),
    ...(view.status === undefined ? {} : { status: view.status })
  };
}

function copyEvidence(value: unknown, truncation: JobTruncation): TargetEvidence | undefined {
  if (!isTargetEvidence(value)) {
    truncation.resultTargetEvidence = (truncation.resultTargetEvidence ?? 0) + 1;
    return undefined;
  }
  const targetGenerationRef = boundedText(value.targetGenerationRef, PUBLIC_FIELD_BYTES);
  if (targetGenerationRef !== value.targetGenerationRef) truncation.resultTargetGenerationRefsClipped = (truncation.resultTargetGenerationRefsClipped ?? 0) + 1;
  return {
    kind: value.kind,
    observedAtMs: value.observedAtMs,
    targetGenerationRef,
    currency: "historical_non_current",
    source: value.source
  };
}

function copyResult(result: JobRunResult, truncation: JobTruncation, targetLimit = PUBLIC_RESULT_TARGETS, lineLimit = PUBLIC_TARGET_LINES, reviewerLimit = PUBLIC_REVIEWER_SUMMARIES): JobResultSnapshot {
  const sourceTargets = result.targets ?? [];
  const matchedSourceTargets = result.wait_result === "condition_met" ? sourceTargets.filter((target) => target.matched) : [];
  const matchedSourceRefs = result.wait_result === "condition_met" ? result.matchedTargets ?? matchedSourceTargets.map((target) => ({ target: target.target, targetId: target.targetId })) : [];
  const matchedTargetCount = result.wait_result === "condition_met" ? result.matchedTargetCount ?? matchedSourceTargets.length : 0;
  const selectedTargets = [...matchedSourceTargets, ...sourceTargets.filter((target) => !target.matched)].slice(0, targetLimit);
  const targets = selectedTargets.map((target) => {
    const lines = target.recentUnwrappedLines.slice(-lineLimit);
    if (target.recentUnwrappedLines.length > lines.length) truncation.resultTargetLines = (truncation.resultTargetLines ?? 0) + target.recentUnwrappedLines.length - lines.length;
    const targetValue = boundedText(target.target, PUBLIC_FIELD_BYTES);
    const targetId = boundedText(target.targetId, PUBLIC_FIELD_BYTES);
    if (targetValue !== target.target) truncation.resultTargetValuesClipped = (truncation.resultTargetValuesClipped ?? 0) + 1;
    if (targetId !== target.targetId) truncation.resultTargetIdsClipped = (truncation.resultTargetIdsClipped ?? 0) + 1;
    const recentUnwrappedLines = lines.map((line) => {
      const bounded = boundedText(line, PUBLIC_FIELD_BYTES);
      if (bounded !== line) truncation.resultTargetLinesClipped = (truncation.resultTargetLinesClipped ?? 0) + 1;
      return bounded;
    });
    const targetEvidence = target.target_evidence === undefined ? undefined : copyEvidence(target.target_evidence, truncation);
    return {
      target: targetValue,
      targetId,
      metadata: boundedMetadata(target.metadata as Record<string, unknown>),
      recentUnwrappedLines,
      ...(target.outputTruncated === undefined ? {} : { outputTruncated: target.outputTruncated }),
      observedAtMs: target.observedAtMs,
      matched: target.matched,
      ...(targetEvidence === undefined ? {} : { target_evidence: targetEvidence })
    };
  });
  if (sourceTargets.length > targets.length) truncation.resultTargets = sourceTargets.length - targets.length;

  const matchedTargets = matchedSourceRefs.slice(0, targetLimit).map((target) => ({
    target: boundedText(target.target, PUBLIC_FIELD_BYTES),
    targetId: boundedText(target.targetId, PUBLIC_FIELD_BYTES)
  }));
  if (matchedTargetCount > matchedTargets.length) truncation.resultMatchedTargets = Math.max(truncation.resultMatchedTargets ?? 0, matchedTargetCount - matchedTargets.length);

  const sourceTargetErrors = result.targetErrors ?? [];
  const targetErrors = sourceTargetErrors.slice(0, targetLimit).map((error) => ({
    target: boundedText(error.target, PUBLIC_FIELD_BYTES),
    targetId: boundedText(error.targetId, PUBLIC_FIELD_BYTES),
    code: boundedText(error.code, PUBLIC_FIELD_BYTES),
    message: boundedText(error.message, PUBLIC_FIELD_BYTES)
  }));
  if (sourceTargetErrors.length > targetErrors.length) truncation.resultTargetErrors = sourceTargetErrors.length - targetErrors.length;

  const sourceReviews = result.reviewerSummaries ?? [];
  const reviewerSummaries = sourceReviews.slice(0, reviewerLimit).map((summary) => {
    const target = boundedText(summary.target, PUBLIC_FIELD_BYTES);
    const targetId = boundedText(summary.targetId, PUBLIC_FIELD_BYTES);
    const classification = boundedText(summary.classification, PUBLIC_FIELD_BYTES);
    const summaryText = boundedText(summary.summary, PUBLIC_FIELD_BYTES);
    if (target !== summary.target || targetId !== summary.targetId || classification !== summary.classification || summaryText !== summary.summary) truncation.reviewerFieldsClipped = (truncation.reviewerFieldsClipped ?? 0) + 1;
    return { target, targetId, classification, summary: summaryText };
  });
  if (sourceReviews.length > reviewerSummaries.length) truncation.reviewerSummaries = sourceReviews.length - reviewerSummaries.length;
  return {
    wait_result: result.wait_result,
    matched: result.matched,
    ...(matchedTargetCount > 0 ? { matchedTargetCount, matchedTargets } : {}),
    ...(sourceTargetErrors.length > 0 ? { targetErrors } : {}),
    ...(result.reason ? { reason: boundedText(result.reason) } : {}),
    ...(sourceTargets.length > 0 ? { targets } : {}),
    ...(sourceReviews.length > 0 ? { reviewerSummaries } : {})
  };
}

function copyProgress(progress: JobProgress, truncation: JobTruncation): JobProgress {
  const text = boundedText(progress.text);
  if (text !== progress.text) truncation.progressTextClipped = true;
  const copied: JobProgress = { text, atMs: progress.atMs };
  if (progress.details === undefined) return copied;
  copied.details = boundedDetails(progress.details);
  if (hasTruncatedMarker(copied.details)) truncation.progressDetails = true;
  return copied;
}

const TRUNCATION_KEYS = [
  "requestTargets", "requestTargetsClipped", "requestTargetIds", "requestTargetIdsClipped", "requestTargetGenerationRefs", "requestTargetGenerationRefsClipped", "requestCondition", "requestConditionClipped", "requestLabelClipped", "requestReviewerModelClipped", "jobIdClipped", "progressDetails", "progressTextClipped", "resultTargets", "resultMatchedTargets", "resultTargetValuesClipped", "resultTargetIdsClipped", "resultTargetGenerationRefsClipped", "resultTargetLines", "resultTargetLinesClipped", "resultTargetMetadata", "resultTargetEvidence", "resultTargetErrors", "reviewerSummaries", "reviewerFieldsClipped", "supervisionTransitions", "supervisionEvents", "supervisionReviews", "supervisionFieldsClipped", "pendingEvents", "errorDetails", "errorCodeClipped", "errorMessageClipped", "publicEvidenceOmitted", "lateSettlementClipped"
] as const;

function boundedTruncation(value: JobTruncation | undefined): JobTruncation {
  const bounded: JobTruncation = {};
  for (const key of TRUNCATION_KEYS) {
    const entry = value?.[key];
    if (typeof entry === "number" || typeof entry === "boolean") Object.assign(bounded, { [key]: entry });
  }
  return bounded;
}

export function fitsPublic(value: unknown, maxBytes = MAX_PUBLIC_BYTES): boolean {
  try {
    return jsonBytes(value) < maxBytes && jsonLines(value) <= MAX_TEXT_LINES;
  } catch {
    return false;
  }
}

function compactDetail(copy: JobDetail, truncation: JobTruncation): JobDetail {
  if (copy.progress?.details !== undefined) {
    delete copy.progress.details;
    truncation.progressDetails = true;
    truncation.publicEvidenceOmitted = true;
  }
  if (copy.result?.targets) {
    const lineCount = copy.result.targets.reduce((total, target) => total + target.recentUnwrappedLines.length, 0);
    copy.result.targets = copy.result.targets.map((target) => ({ ...target, metadata: { truncated: true, content: "[metadata omitted]" }, recentUnwrappedLines: [] }));
    truncation.resultTargetMetadata = copy.result.targets.length;
    if (lineCount > 0) truncation.resultTargetLines = (truncation.resultTargetLines ?? 0) + lineCount;
    truncation.publicEvidenceOmitted = true;
  }
  if (copy.result?.reviewerSummaries) {
    delete copy.result.reviewerSummaries;
    truncation.reviewerSummaries = (truncation.reviewerSummaries ?? 0) + 1;
    truncation.publicEvidenceOmitted = true;
  }
  if (copy.supervision) {
    truncation.supervisionTransitions = (truncation.supervisionTransitions ?? 0) + copy.supervision.transitions.length;
    truncation.supervisionEvents = (truncation.supervisionEvents ?? 0) + copy.supervision.events.length;
    truncation.supervisionReviews = (truncation.supervisionReviews ?? 0) + copy.supervision.reviewer.reviews.length;
    copy.supervision = {
      ...copy.supervision,
      transitions: [],
      truncatedTransitions: copy.supervision.truncatedTransitions + copy.supervision.transitions.length,
      events: [],
      truncatedEvents: copy.supervision.truncatedEvents + copy.supervision.events.length,
      reviewer: { ...copy.supervision.reviewer, reviews: [], truncatedReviews: copy.supervision.reviewer.truncatedReviews + copy.supervision.reviewer.reviews.length }
    };
    truncation.publicEvidenceOmitted = true;
  }
  if (copy.pending_events) {
    truncation.pendingEvents = (truncation.pendingEvents ?? 0) + copy.pending_events.length;
    delete copy.pending_events;
    truncation.publicEvidenceOmitted = true;
  }
  return copy;
}

/**
 * The request a minimal projection keeps. `copyRequest` has already bounded
 * every field, so only the per-target lists are dropped; rebuilding the request
 * per kind would add a branch no bounded detail can reach.
 */
function minimalRequest(request: JobRequestSnapshot): JobRequestSnapshot {
  return { ...request, targets: [], targetIds: [] };
}

function minimalDetail(copy: JobDetail, truncation: JobTruncation): JobDetail {
  truncation.publicEvidenceOmitted = true;
  return {
    jobId: boundedText(copy.jobId, 128),
    kind: copy.kind,
    operation_phase: copy.operation_phase,
    sequence: copy.sequence,
    createdAtMs: copy.createdAtMs,
    ...(copy.startedAtMs === undefined ? {} : { startedAtMs: copy.startedAtMs }),
    ...(copy.finishedAtMs === undefined ? {} : { finishedAtMs: copy.finishedAtMs }),
    request: minimalRequest(copy.request),
    ...(copy.semanticReview ? { semanticReview: copy.semanticReview } : {}),
    ...(copy.operation_phase === "settled" && copy.wait_result ? { wait_result: copy.wait_result } : {}),
    ...(copy.operation_phase === "settled" && copy.supervision_result ? { supervision_result: copy.supervision_result } : {}),
    ...(copy.unobservedEvents === undefined ? {} : { unobservedEvents: copy.unobservedEvents }),
    ...(copy.result ? { result: { wait_result: copy.result.wait_result, matched: copy.result.matched, ...(copy.result.matchedTargetCount === undefined ? {} : { matchedTargetCount: copy.result.matchedTargetCount }), ...(copy.result.matchedTargets ? { matchedTargets: copy.result.matchedTargets.slice(0, 1) } : {}) } } : {}),
    ...(copy.cancelReason ? { cancelReason: copy.cancelReason } : {}),
    ...(copy.late_settlement_observed ? { late_settlement_observed: copy.late_settlement_observed } : {}),
    truncation
  };
}

export function publicDetail(detail: JobDetail, maxBytes = MAX_PUBLIC_BYTES): JobDetail {
  const truncation: JobTruncation = boundedTruncation(detail.truncation);
  const supervision = detail.supervision === undefined ? undefined : boundedSupervision(detail.supervision, truncation);
  const jobId = boundedText(detail.jobId, PUBLIC_FIELD_BYTES);
  if (jobId !== detail.jobId) truncation.jobIdClipped = true;
  const terminal = detail.operation_phase === "settled";
  const copy: JobDetail = {
    jobId,
    kind: detail.kind,
    operation_phase: detail.operation_phase,
    sequence: detail.sequence,
    createdAtMs: detail.createdAtMs,
    ...(detail.startedAtMs === undefined ? {} : { startedAtMs: detail.startedAtMs }),
    ...(detail.finishedAtMs === undefined ? {} : { finishedAtMs: detail.finishedAtMs }),
    request: copyRequest(detail.request, truncation),
    ...(detail.progress ? { progress: copyProgress(detail.progress, truncation) } : {}),
    ...(detail.semanticReview ? { semanticReview: boundedSemanticReview(detail.semanticReview) } : {}),
    ...(terminal && detail.wait_result ? { wait_result: detail.wait_result } : {}),
    ...(terminal && detail.supervision_result ? { supervision_result: detail.supervision_result } : {}),
    ...(terminal && detail.supervision_reason ? { supervision_reason: boundedText(detail.supervision_reason, PUBLIC_FIELD_BYTES) } : {}),
    ...(supervision === undefined ? {} : { supervision }),
    ...(detail.pending_events ? { pending_events: detail.pending_events.map((event) => boundedSupervisionEvent(event, truncation)) } : {}),
    ...(detail.unobservedEvents === undefined ? {} : { unobservedEvents: detail.unobservedEvents }),
    ...(terminal && detail.result ? { result: copyResult({
      wait_result: detail.result.wait_result,
      matched: detail.result.matched,
      ...(detail.result.reason ? { reason: detail.result.reason } : {}),
      ...(detail.result.matchedTargetCount === undefined ? {} : { matchedTargetCount: detail.result.matchedTargetCount }),
      ...(detail.result.matchedTargets ? { matchedTargets: detail.result.matchedTargets } : {}),
      ...(detail.result.targetErrors ? { targetErrors: detail.result.targetErrors } : {}),
      ...(detail.result.targets ? { targets: detail.result.targets } : {}),
      ...(detail.result.reviewerSummaries ? { reviewerSummaries: detail.result.reviewerSummaries } : {})
    }, truncation) } : {}),
    ...(detail.error ? {
      error: {
        ...(detail.error.code ? { code: boundedText(detail.error.code, PUBLIC_FIELD_BYTES) } : {}),
        message: boundedText(detail.error.message),
        ...(detail.error.details === undefined ? {} : { details: boundedDetails(detail.error.details) })
      }
    } : {}),
    ...(detail.cancelReason ? { cancelReason: detail.cancelReason } : {}),
    ...(detail.late_settlement_observed ? { late_settlement_observed: detail.late_settlement_observed } : {})
  };
  if (detail.error?.code && boundedText(detail.error.code, PUBLIC_FIELD_BYTES) !== detail.error.code) truncation.errorCodeClipped = true;
  if (detail.error && boundedText(detail.error.message) !== detail.error.message) truncation.errorMessageClipped = true;
  if (hasTruncatedMarker(copy.error?.details)) truncation.errorDetails = true;
  if (copy.result?.targets?.some((target) => hasTruncatedMarker(target.metadata))) truncation.resultTargetMetadata = copy.result.targets.filter((target) => hasTruncatedMarker(target.metadata)).length;
  if (Object.keys(truncation).length > 0) copy.truncation = truncation;
  if (!fitsPublic(copy, maxBytes)) compactDetail(copy, truncation);
  if (Object.keys(truncation).length > 0) copy.truncation = truncation;
  return clone(fitsPublic(copy, maxBytes) ? copy : minimalDetail(copy, truncation));
}

function summary(detail: JobDetail): JobSummary {
  const truncation: NonNullable<JobSummary["truncation"]> = {};
  const label = boundedText(detail.request.label, WAIT_LABEL_MAX_BYTES);
  if (label !== detail.request.label) truncation.labelClipped = true;
  const targetIds = detail.request.targetIds.slice(0, PUBLIC_SUMMARY_ITEMS).map((value) => boundedText(value, 48));
  const targets = detail.request.targets.slice(0, PUBLIC_SUMMARY_ITEMS).map((value) => boundedText(value, 48));
  if (detail.request.targetIds.length > targetIds.length) truncation.targetIds = detail.request.targetIds.length - targetIds.length;
  if (detail.request.targets.length > targets.length) truncation.targets = detail.request.targets.length - targets.length;
  const sourceRefs = detail.request.target_generation_refs;
  const refs = sourceRefs === undefined ? undefined : sourceRefs.slice(0, PUBLIC_SUMMARY_ITEMS).map((value) => boundedText(value, 48));
  if (refs !== undefined && refs.length < sourceRefs!.length) truncation.targetGenerationRefs = sourceRefs!.length - refs.length;
  const clippedTargetIds = detail.request.targetIds.slice(0, targetIds.length).filter((value, index) => targetIds[index] !== value).length;
  const clippedTargets = detail.request.targets.slice(0, targets.length).filter((value, index) => targets[index] !== value).length;
  const clippedRefs = refs === undefined ? 0 : refs.filter((value, index) => value !== sourceRefs![index]).length;
  if (clippedTargetIds > 0) truncation.targetIdsClipped = clippedTargetIds;
  if (clippedTargets > 0) truncation.targetsClipped = clippedTargets;
  if (clippedRefs > 0) truncation.targetGenerationRefsClipped = clippedRefs;
  const progress = detail.progress ? { text: boundedText(detail.progress.text, 128), atMs: detail.progress.atMs } : undefined;
  if (detail.progress && progress && progress.text !== detail.progress.text) truncation.progress = true;
  const jobId = boundedText(detail.jobId, 64);
  if (jobId !== detail.jobId) truncation.jobIdClipped = true;
  return clone({
    jobId,
    kind: detail.kind,
    label,
    operation_phase: detail.operation_phase,
    sequence: detail.sequence,
    createdAtMs: detail.createdAtMs,
    ...(detail.startedAtMs === undefined ? {} : { startedAtMs: detail.startedAtMs }),
    ...(detail.finishedAtMs === undefined ? {} : { finishedAtMs: detail.finishedAtMs }),
    targetIds,
    targets,
    ...(refs === undefined ? {} : { target_generation_refs: refs }),
    ...(detail.operation_phase === "settled" && detail.wait_result ? { wait_result: detail.wait_result } : {}),
    ...(detail.operation_phase === "settled" && detail.supervision_result ? { supervision_result: detail.supervision_result } : {}),
    ...(detail.unobservedEvents === undefined ? {} : { unobservedEvents: detail.unobservedEvents }),
    ...(detail.result?.reason ? { reason: boundedText(detail.result.reason, 128) } : {}),
    ...(detail.supervision_reason ? { reason: boundedText(detail.supervision_reason, 128) } : {}),
    ...(detail.cancelReason ? { reason: detail.cancelReason } : {}),
    ...(progress ? { progress } : {}),
    ...(detail.error ? { error: { ...(detail.error.code ? { code: boundedText(detail.error.code, 48) } : {}), message: boundedText(detail.error.message, 128) } } : {}),
    ...(Object.keys(truncation).length > 0 ? { truncation } : {})
  });
}

function compactSummaryForList(value: JobSummary): JobSummary {
  const jobId = boundedText(value.jobId, 32);
  const label = boundedText(value.label, 64);
  const jobIdClipped = jobId !== value.jobId || value.truncation?.jobIdClipped === true;
  const labelClipped = label !== value.label || value.truncation?.labelClipped === true;
  const truncation = { ...value.truncation, ...(jobIdClipped ? { jobIdClipped: true } : {}), ...(labelClipped ? { labelClipped: true } : {}) };
  return {
    jobId,
    kind: value.kind,
    label,
    operation_phase: value.operation_phase,
    sequence: value.sequence,
    createdAtMs: value.createdAtMs,
    ...(value.startedAtMs === undefined ? {} : { startedAtMs: value.startedAtMs }),
    ...(value.finishedAtMs === undefined ? {} : { finishedAtMs: value.finishedAtMs }),
    targetIds: [],
    targets: [],
    ...(value.wait_result ? { wait_result: value.wait_result } : {}),
    ...(value.supervision_result ? { supervision_result: value.supervision_result } : {}),
    ...(value.unobservedEvents === undefined ? {} : { unobservedEvents: value.unobservedEvents }),
    ...(value.reason ? { reason: boundedText(value.reason, 64) } : {}),
    ...(value.progress ? { progress: { text: boundedText(value.progress.text, 64), atMs: value.progress.atMs } } : {}),
    ...(value.error ? { error: { ...(value.error.code ? { code: boundedText(value.error.code, 32) } : {}), message: boundedText(value.error.message, 64) } } : {}),
    ...(Object.keys(truncation).length > 0 ? { truncation } : {})
  };
}

export function boundedList(result: JobListResult): JobListResult {
  if (fitsPublic(result)) return clone(result);
  const compact = { ...result, jobs: result.jobs.map(compactSummaryForList) };
  if (fitsPublic(compact)) return clone(compact);
  const minimalJobs = result.jobs.map((job) => {
    const jobId = boundedText(job.jobId, 16);
    const label = boundedText(job.label, 32);
    return {
      jobId,
      kind: job.kind,
      label,
      operation_phase: job.operation_phase,
      sequence: job.sequence,
      createdAtMs: job.createdAtMs,
      ...(job.startedAtMs === undefined ? {} : { startedAtMs: job.startedAtMs }),
      ...(job.finishedAtMs === undefined ? {} : { finishedAtMs: job.finishedAtMs }),
      ...(job.wait_result ? { wait_result: job.wait_result } : {}),
      ...(job.supervision_result ? { supervision_result: job.supervision_result } : {}),
      ...(job.unobservedEvents === undefined ? {} : { unobservedEvents: job.unobservedEvents }),
      targetIds: [],
      targets: [],
      truncation: { ...(job.truncation ?? {}), jobIdClipped: true, ...(label !== job.label || job.truncation?.labelClipped === true ? { labelClipped: true } : {}) }
    };
  });
  const truncation = {
    ...(result.truncation?.jobs === undefined ? {} : { jobs: result.truncation.jobs }),
    jobIdsClipped: result.jobs.length
  };
  return clone({ ...result, jobs: minimalJobs, truncation });
}

export class JobRegistry {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly idFactory: () => string;
  private readonly clock: JobClock;
  private readonly onTerminal?: (detail: JobDetail) => void | Promise<void>;
  private readonly onChange?: () => void | Promise<void>;
  private readonly quiescenceMs: number;
  private sequence = 0;
  private generationValue = 0;
  private accepting = true;

  constructor(options: JobRegistryOptions = {}) {
    this.idFactory = options.idFactory ?? (() => `job_${randomUUID()}`);
    this.clock = options.clock ?? { now: () => Date.now() };
    this.onTerminal = options.onTerminal;
    this.onChange = options.onChange;
    const quiescenceMs = options.quiescenceMs;
    this.quiescenceMs = typeof quiescenceMs === "number" && Number.isFinite(quiescenceMs) && quiescenceMs >= 0 ? quiescenceMs : 1_000;
  }

  private notifyChange(): void {
    if (!this.onChange) return;
    try {
      void Promise.resolve(this.onChange()).catch(() => undefined);
    } catch {
      // TUI rendering is best effort and cannot affect operation state.
    }
  }

  get generation(): JobGeneration {
    return { generation: this.generationValue };
  }

  captureGeneration(): JobGeneration {
    return this.generation;
  }

  isCurrent(generation: JobGeneration): boolean {
    return this.accepting && generation.generation === this.generationValue;
  }

  private isDrained(record: Pick<JobRecord, "runnerDone" | "activityCount">): boolean {
    return record.runnerDone && record.activityCount === 0;
  }

  private signalDrain(record: Pick<JobRecord, "runnerDone" | "activityCount" | "resolveDrain">): void {
    if (!this.isDrained(record)) return;
    const waiters = record.resolveDrain.splice(0);
    waiters.forEach((resolve) => resolve());
  }

  private closeGate(record: JobRecord): void {
    record.gateOpen = false;
    record.fenceValue += 1;
  }

  private late(record: JobRecord, kind: LateSettlementKind): void {
    if (record.detail.late_settlement_observed) return;
    record.detail.late_settlement_observed = { kind, observedAtMs: this.clock.now() };
    this.notifyChange();
  }

  private settleSupervisionLocked(record: JobRecord, outcome: SupervisionResult, reason: string | undefined, error?: JobErrorSnapshot): boolean {
    return this.settleOnce(record, () => {
      record.detail.supervision_result = outcome;
      if (reason !== undefined) record.detail.supervision_reason = reason;
    }, error);
  }

  /** Settle either kind with one of the outcomes both kinds share. */
  private settleGenericLocked(record: JobRecord, outcome: GenericTerminal, error?: JobErrorSnapshot): boolean {
    return record.detail.kind === "supervisor"
      ? this.settleSupervisionLocked(record, outcome, error?.code, error)
      : this.settleLocked(record, outcome, undefined, error);
  }

  /**
   * The single settlement gate both kinds pass through. Fence first: no terminal
   * authority is published while the gate remains open.
   */
  private settleOnce(record: JobRecord, apply: () => void, error?: JobErrorSnapshot): boolean {
    if (record.detail.operation_phase === "settled") return false;
    this.closeGate(record);
    record.detail.operation_phase = "settled";
    apply();
    if (error) record.detail.error = error;
    record.detail.finishedAtMs = this.clock.now();
    this.notifyChange();
    return true;
  }

  private settleLocked(record: JobRecord, waitResult: WaitResult, result?: JobRunResult, error?: JobErrorSnapshot): boolean {
    const settled = this.settleOnce(record, () => {
      record.detail.wait_result = waitResult;
      record.detail.result = result
        ? clone({
          wait_result: result.wait_result,
          matched: result.matched,
          ...(result.reason ? { reason: result.reason } : {}),
          ...(result.matchedTargetCount === undefined ? {} : { matchedTargetCount: result.matchedTargetCount }),
          ...(result.matchedTargets ? { matchedTargets: result.matchedTargets } : {}),
          ...(result.targetErrors ? { targetErrors: result.targetErrors } : {}),
          ...(result.targets ? { targets: result.targets } : {}),
          ...(result.reviewerSummaries ? { reviewerSummaries: result.reviewerSummaries } : {})
        })
        : { wait_result: waitResult, matched: false, reason: error?.code ?? "unknown" };
    }, error);
    if (!settled) return false;
    if (record.detail.cancelReason === undefined && waitResult !== "cancelled") this.notifyTerminal(record);
    return true;
  }

  private notifyTerminal(record: JobRecord): void {
    if (!this.onTerminal) return;
    try {
      void Promise.resolve(this.onTerminal(publicDetail(record.detail))).catch(() => undefined);
    } catch {
      // Notification is explicitly best effort and must never affect settlement.
    }
  }

  private createControl(record: Pick<JobRecord, "detail" | "gateOpen" | "fenceValue" | "runnerDone" | "activityCount" | "resolveDrain">): JobOperationControl {
    return {
      get fence() { return record.fenceValue; },
      isOpen: () => record.gateOpen,
      check: () => {
        if (!record.gateOpen) throw Object.assign(new Error("ABORTED: operation fence is closed"), { code: "ABORTED" });
      },
      beginActivity: () => {
        if (!record.gateOpen) throw Object.assign(new Error("ABORTED: operation fence is closed"), { code: "ABORTED" });
        record.activityCount += 1;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          record.activityCount -= 1;
          this.signalDrain(record);
        };
      },
      publishSemanticReview: (projection) => {
        if (record.detail.kind !== "wait") throw new Error("JOB_KIND_MISMATCH: only a wait job accepts semantic review ownership");
        if (!record.gateOpen || record.detail.operation_phase !== "running") throw Object.assign(new Error("ABORTED: operation fence is closed"), { code: "ABORTED" });
        record.detail.semanticReview = boundedSemanticReview(projection);
        this.notifyChange();
      }
    };
  }

  register(
    request: JobRequestSnapshot,
    run: (signal: AbortSignal, update: (text: string, details?: unknown) => void, control: JobOperationControl) => Promise<JobKindRunResult>,
    generation: JobGeneration = this.generation
  ): RegisteredJob {
    if (!this.isCurrent(generation)) throw new Error("SESSION_REPLACED: wait session was replaced before registration");
    const jobId = this.idFactory();
    if (!jobId.startsWith("job_") || jobId.length <= 4 || jobId.includes(String.fromCharCode(0)) || jobId.includes("\r") || jobId.includes("\n") || this.jobs.has(jobId)) throw new Error("JOB_ID_INVALID: job ID factory returned an invalid or duplicate ID");
    const controller = new AbortController();
    const detail: JobDetail = {
      jobId,
      kind: request.kind,
      operation_phase: "accepted",
      sequence: ++this.sequence,
      createdAtMs: this.clock.now(),
      request: clone(request)
    };
    const partial = {
      detail,
      controller,
      generation,
      lock: transitionLock(),
      gateOpen: true,
      fenceValue: 0,
      runnerStarted: false,
      runnerDone: false,
      activityCount: 0,
      executionPromise: Promise.resolve(),
      resolveDrain: [] as Array<() => void>,
      supervisionBindingStage: "reserved" as const
    };
    const record = partial as JobRecord;
    record.control = this.createControl(partial);
    this.jobs.set(jobId, record);
    let resolveExecution!: () => void;
    record.executionPromise = new Promise<void>((resolve) => { resolveExecution = resolve; });
    // Registration is the accepted boundary. Start the runner in a later turn so
    // callers can observe accepted rather than a completion-shaped acknowledgement.
    queueMicrotask(() => {
      void this.execute(record, run).finally(resolveExecution);
    });
    this.notifyChange();
    return { jobId, generation, signal: controller.signal, detail: publicDetail(detail), promise: record.executionPromise };
  }

  private async execute(record: JobRecord, run: (signal: AbortSignal, update: (text: string, details?: unknown) => void, control: JobOperationControl) => Promise<JobKindRunResult>): Promise<void> {
    const started = await record.lock.runExclusive(() => {
      if (record.detail.operation_phase !== "accepted" || !record.gateOpen) return false;
      record.detail.operation_phase = "running";
      record.runnerStarted = true;
      record.detail.startedAtMs = this.clock.now();
      this.notifyChange();
      return true;
    });
    if (!started) {
      record.runnerDone = true;
      this.signalDrain(record);
      return;
    }
    try {
      const result = await run(record.controller.signal, (text, details) => this.update(record.detail.jobId, text, details), record.control);
      record.runnerDone = true;
      this.signalDrain(record);
      await record.lock.runExclusive(() => {
        if (record.detail.operation_phase !== "running") {
          this.late(record, "fulfilled");
          return;
        }
        if (isSupervisionRunResult(result)) this.settleSupervisionLocked(record, result.supervision_result, result.reason);
        else this.settleLocked(record, result.wait_result, result);
      });
    } catch (error) {
      record.runnerDone = true;
      this.signalDrain(record);
      await record.lock.runExclusive(() => {
        if (record.detail.operation_phase !== "running") {
          this.late(record, "rejected");
          return;
        }
        const mapped: JobErrorSnapshot = {
          ...(typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string" ? { code: (error as { code: string }).code } : {}),
          message: error instanceof Error ? error.message : String(error),
          ...(typeof error === "object" && error !== null && "details" in error ? { details: (error as { details?: unknown }).details } : {})
        };
        if (record.detail.kind === "supervisor") {
          this.settleSupervisionLocked(record, "failed", mapped.code, mapped);
          return;
        }
        const partialResult = typeof error === "object" && error !== null && "result" in error && typeof (error as { result?: unknown }).result === "object" && (error as { result?: { wait_result?: unknown } }).result?.wait_result === "failed"
          ? (error as { result: JobRunResult }).result
          : undefined;
        this.settleLocked(record, "failed", partialResult, mapped);
      });
    }
  }

  update(jobId: string, text: string, details?: unknown): JobDetail {
    const record = this.jobs.get(jobId);
    if (!record) throw new Error("JOB_NOT_FOUND: unknown Herdr job");
    if (record.detail.operation_phase !== "running" || !record.gateOpen) return publicDetail(record.detail);
    record.activityCount += 1;
    try {
      record.detail.progress = { text: boundedText(text), atMs: this.clock.now(), ...(details === undefined ? {} : { details: boundedDetails(details) }) };
      this.notifyChange();
    } finally {
      record.activityCount -= 1;
      this.signalDrain(record);
    }
    return publicDetail(record.detail);
  }

  /**
   * Prepare the request half of AGY's provisional supervisor publication. It
   * changes only the selected child metadata; targetIds stay empty until exact
   * native-session strengthening.
   */
  prepareProvisionalSupervisionChildBinding(jobId: string, bound: ProvisionalSupervisionChildBinding): SupervisionChildBindingPublication {
    const record = this.jobs.get(jobId);
    if (!record) throw new Error("JOB_NOT_FOUND: unknown Herdr job");
    if (record.detail.request.kind !== "supervisor") throw new Error("JOB_KIND_MISMATCH: only a supervisor job has a supervised child");
    if (bound.agentKind !== "agy") throw new Error("SUPERVISION_PROVISIONAL_INVALID: provisional supervision is AGY-only");
    if (typeof bound.profileName !== "string" || bound.profileName.length === 0 || /[\0\r\n]/u.test(bound.profileName)) throw new Error("SUPERVISION_BINDING_INVALID: provisional profile name is malformed");
    const request = record.detail.request;
    if (record.supervisionBindingStage !== "reserved" || request.targetIds.length !== 0) throw new Error("SUPERVISION_ALREADY_BOUND: supervisor request already has a provisional or exact binding");
    if (request.targets.length !== 1 || request.target_generation_refs?.length !== 1) throw new Error("SUPERVISION_REQUEST_INVALID: supervisor target arrays are not aligned");
    const reservedChild = clone(request.child);
    const reservedTargetIds = [...request.targetIds];
    const requestedAgentKind = reservedChild.requestedAgentKind ?? (reservedChild.agentKind === "agy" ? undefined : reservedChild.agentKind);
    const selectedChild: SupervisedJobChild = {
      agentName: reservedChild.agentName,
      agentKind: "agy",
      profileName: bound.profileName,
      ...(requestedAgentKind === undefined ? {} : { requestedAgentKind }),
      ...(bound.profileName === reservedChild.profileName ? {} : { requestedProfileName: reservedChild.profileName })
    };
    let committed = false;
    let published = false;
    return {
      commit: () => {
        if (committed) throw new Error("SUPERVISION_ALREADY_BOUND: binding publication was already committed");
        if (!record.gateOpen || record.detail.operation_phase !== "running") throw new Error("SUPERVISION_BINDING_CLOSED: supervisor job is no longer running");
        if (record.supervisionBindingStage !== "reserved") throw new Error("SUPERVISION_ALREADY_BOUND: supervisor request already has a provisional or exact binding");
        request.child = clone(selectedChild);
        request.targetIds = [];
        record.supervisionBindingStage = "provisional";
        committed = true;
      },
      rollback: () => {
        if (!committed) return;
        request.child = clone(reservedChild);
        request.targetIds = [...reservedTargetIds];
        record.supervisionBindingStage = "reserved";
        committed = false;
        if (published) this.notifyChange();
        published = false;
      },
      publish: () => {
        if (!committed) throw new Error("SUPERVISION_BINDING_UNCOMMITTED: cannot publish an uncommitted provisional binding");
        if (published) return;
        verifyInstalledSupervisor(record, "provisional", selectedChild);
        published = true;
        this.notifyChange();
      },
    };
  }

  /**
   * Prepare the synchronous request half of supervisor binding. No public field
   * changes until `commit`, and no observer is notified until `publish`, after
   * the supervisor has installed its matching bound state.
   */
  prepareSupervisionChildBinding(jobId: string, bound: { agentKind: string; profileName: string; paneId: string }): SupervisionChildBindingPublication {
    return this.prepareExactSupervisionChildBinding(jobId, bound, false);
  }

  /** Prepare the exact request half of an already-published AGY provisional binding. */
  prepareSupervisionStrengthening(jobId: string, bound: { agentKind: string; profileName: string; paneId: string }): SupervisionChildBindingPublication {
    return this.prepareExactSupervisionChildBinding(jobId, bound, true);
  }

  private prepareExactSupervisionChildBinding(
    jobId: string,
    bound: { agentKind: string; profileName: string; paneId: string },
    strengthening: boolean,
  ): SupervisionChildBindingPublication {
    const record = this.jobs.get(jobId);
    if (!record) throw new Error("JOB_NOT_FOUND: unknown Herdr job");
    if (record.detail.request.kind !== "supervisor") throw new Error("JOB_KIND_MISMATCH: only a supervisor job has a supervised child");
    const request = record.detail.request;
    if (strengthening) {
      if (record.supervisionBindingStage !== "provisional" || request.child.agentKind !== "agy" || bound.agentKind !== "agy") throw new Error("SUPERVISION_STRENGTHENING_INVALID: only an AGY provisional supervisor can be strengthened");
      try {
        if (!record.supervision || record.supervision.childLive() !== true || record.supervision.view().state !== "provisional") throw new Error("invalid provisional supervisor");
      } catch {
        throw new Error("SUPERVISION_PUBLICATION_UNCONFIRMED: provisional supervisor state is unavailable");
      }
    } else if (bound.agentKind === "agy" || record.supervisionBindingStage === "provisional") {
      throw new Error("SUPERVISION_STRENGTHENING_REQUIRED: generic exact binding cannot bypass AGY strengthening");
    }
    if (typeof bound.paneId !== "string" || bound.paneId.length === 0 || /[\0\r\n]/u.test(bound.paneId)) throw new Error("SUPERVISION_BINDING_INVALID: exact pane id is malformed");
    if (record.supervisionBindingStage === "exact" || request.targetIds.length !== 0) throw new Error("SUPERVISION_ALREADY_BOUND: supervisor request already has an exact target");
    if (request.targets.length !== 1 || request.target_generation_refs?.length !== 1) throw new Error("SUPERVISION_REQUEST_INVALID: supervisor target arrays are not aligned");
    const reservedStage = record.supervisionBindingStage;
    const reservedChild = clone(request.child);
    const reservedTargetIds = [...request.targetIds];
    const requestedAgentKind = reservedChild.requestedAgentKind ?? (bound.agentKind === reservedChild.agentKind ? undefined : reservedChild.agentKind);
    const requestedProfileName = reservedChild.requestedProfileName ?? (bound.profileName === reservedChild.profileName ? undefined : reservedChild.profileName);
    const selectedChild: SupervisedJobChild = {
      agentName: reservedChild.agentName,
      agentKind: bound.agentKind,
      profileName: bound.profileName,
      ...(requestedAgentKind === undefined ? {} : { requestedAgentKind }),
      ...(requestedProfileName === undefined ? {} : { requestedProfileName }),
    };
    let committed = false;
    let published = false;
    return {
      commit: () => {
        if (committed) throw new Error("SUPERVISION_ALREADY_BOUND: binding publication was already committed");
        if (!record.gateOpen || record.detail.operation_phase !== "running") throw new Error("SUPERVISION_BINDING_CLOSED: supervisor job is no longer running");
        if (record.supervisionBindingStage !== reservedStage) throw new Error("SUPERVISION_BINDING_STALE: supervisor binding changed before commit");
        request.child = clone(selectedChild);
        request.targetIds = [bound.paneId];
        record.supervisionBindingStage = "exact";
        committed = true;
      },
      rollback: () => {
        if (!committed) return;
        request.child = clone(reservedChild);
        request.targetIds = [...reservedTargetIds];
        record.supervisionBindingStage = reservedStage;
        committed = false;
        if (published) this.notifyChange();
        published = false;
      },
      publish: () => {
        if (!committed) throw new Error("SUPERVISION_BINDING_UNCOMMITTED: cannot publish an uncommitted binding");
        if (published) return;
        if (record.supervisionBindingStage !== "exact") throw new Error("SUPERVISION_BINDING_STALE: supervisor binding changed before publish");
        verifyInstalledSupervisor(record, "exact", selectedChild, bound.paneId);
        published = true;
        this.notifyChange();
      },
    };
  }

  /** Attach a supervisor's port so the registry can publish its bounded view. */
  attachSupervision(jobId: string, port: SupervisionJobPort): void {
    const record = this.jobs.get(jobId);
    if (!record) throw new Error("JOB_NOT_FOUND: unknown Herdr job");
    if (record.detail.kind !== "supervisor") throw new Error("JOB_KIND_MISMATCH: only a supervisor job accepts a supervision port");
    record.supervision = port;
    this.notifyChange();
  }

  /** Read-only exact ownership lookup. It never projects or consumes receipts. */
  activeSupervisorFor(identity: SupervisedIdentity): { jobId: string } | undefined {
    for (const record of this.jobs.values()) {
      if (record.detail.kind !== "supervisor" || record.detail.operation_phase === "settled" || record.detail.request.targetIds.length === 0) continue;
      const port = record.supervision;
      if (!port) continue;
      // Provisional AGY evidence is intentionally not exact coverage, even if
      // an internal port accidentally reports a matching native identity.
      const state = port.view().state;
      if ((state === "active" || state === "degraded") && port.childLive() === true && port.coversIdentity?.(identity) === true) return { jobId: record.detail.jobId };
    }
    return undefined;
  }

  /**
   * Project a job with its live supervision view. `observeEvents` returns the
   * pending soft receipts and marks exactly the returned events observed.
   */
  private projected(record: JobRecord, observeEvents: boolean): JobDetail {
    const port = record.supervision;
    if (!port) return publicDetail(record.detail);
    const view = port.view();
    const pending = observeEvents ? port.takePendingEvents() : undefined;
    return publicDetail({
      ...record.detail,
      supervision: view,
      // `takePendingEvents` has already marked the returned events observed, so
      // the published count is the state a follow-up `get` would see.
      unobservedEvents: observeEvents ? port.view().unobservedEvents : view.unobservedEvents,
      ...(pending === undefined || pending.length === 0 ? {} : { pending_events: pending })
    });
  }

  /** Summaries carry only the unobserved count, never the events themselves. */
  private withUnobserved(record: JobRecord): JobDetail {
    const port = record.supervision;
    return port ? { ...record.detail, unobservedEvents: port.view().unobservedEvents } : record.detail;
  }

  get(jobId: string, options: { observeEvents?: boolean } = {}): JobDetail | undefined {
    const record = this.jobs.get(jobId);
    return record ? this.projected(record, options.observeEvents === true) : undefined;
  }

  list(operationPhase?: OperationPhase, offset = 0, limit = 20, kind?: JobKind): JobListResult {
    const filtered = [...this.jobs.values()]
      .filter((record) => (operationPhase === undefined || record.detail.operation_phase === operationPhase) && (kind === undefined || record.detail.kind === kind))
      .sort((left, right) => right.detail.sequence - left.detail.sequence);
    const pageLimit = Math.min(Math.max(1, limit), PUBLIC_LIST_JOBS);
    const jobs = filtered.slice(offset, offset + pageLimit).map((record) => summary(this.withUnobserved(record)));
    const result: JobListResult = {
      jobs,
      total: filtered.length,
      offset,
      limit: pageLimit,
      nextOffset: offset + jobs.length < filtered.length ? offset + jobs.length : null
    };
    return boundedList(result);
  }

  runningOverview(limit = 20): RunningJobOverview {
    const running = [...this.jobs.values()]
      .filter((record) => record.detail.operation_phase !== "settled")
      .sort((left, right) => right.detail.sequence - left.detail.sequence);
    const starts = running.map((record) => record.detail.startedAtMs ?? record.detail.createdAtMs);
    return {
      jobs: running.slice(0, Math.max(0, limit)).map((record) => summary(this.withUnobserved(record))),
      total: running.length,
      ...(starts.length > 0 ? { oldestStartedAtMs: Math.min(...starts) } : {})
    };
  }

  private async waitForDrain(record: JobRecord): Promise<boolean> {
    if (this.isDrained(record)) return true;
    const drained = new Promise<void>((resolve) => { record.resolveDrain.push(resolve); });
    let resolveBounded!: () => void;
    const bounded = new Promise<false>((resolve) => { resolveBounded = () => resolve(false); });
    const timeout = setTimeout(resolveBounded, this.quiescenceMs);
    await Promise.race([drained.then(() => true as const), bounded]);
    clearTimeout(timeout);
    return this.isDrained(record);
  }

  /**
   * Ordinary cancellation. A supervisor whose exact child is still live is
   * refused: the child would keep working with nobody watching it, which is the
   * exact state automatic supervision exists to prevent. Session shutdown is a
   * different path and is never refused.
   */
  async cancel(jobId: string): Promise<JobDetail | undefined> {
    const record = this.jobs.get(jobId);
    if (!record) return undefined;
    const request = await record.lock.runExclusive(() => {
      if (record.detail.operation_phase === "settled") return false;
      if (record.detail.operation_phase === "cancel_requested") return true;
      // Recheck under the transition lock immediately before closing the gate.
      if (record.supervision?.childLive() === true) {
        throw new SupervisionActiveError({ jobId: boundedText(record.detail.jobId, PUBLIC_FIELD_BYTES), kind: record.detail.kind });
      }
      // The gate/fence closes before the cancellation request becomes visible.
      this.closeGate(record);
      record.detail.operation_phase = "cancel_requested";
      record.detail.cancelReason = "cancelled";
      try { record.controller.abort(); } catch { /* AbortController.abort is normally infallible. */ }
      this.notifyChange();
      return true;
    });
    if (!request) return this.projected(record, false);
    const drained = await this.waitForDrain(record);
    return record.lock.runExclusive(() => {
      if (record.detail.operation_phase === "settled") return this.projected(record, false);
      const outcome: GenericTerminal = drained ? "cancelled" : "unknown";
      const error = drained ? undefined : { code: "CANCELLATION_UNCERTAIN", message: "Cancellation quiescence was not observed" };
      this.settleGenericLocked(record, outcome, error);
      return this.projected(record, false);
    });
  }

  /** Session teardown. Supervisors are stopped unconditionally; nothing persists. */
  private abandonAll(): void {
    for (const record of this.jobs.values()) {
      record.supervision?.shutdown();
      if (record.detail.operation_phase === "settled") continue;
      this.closeGate(record);
      record.detail.operation_phase = "cancel_requested";
      record.detail.cancelReason = "shutdown";
      record.controller.abort();
      record.runnerDone = true;
      this.signalDrain(record);
    }
    this.jobs.clear();
  }

  beginSession(): JobGeneration {
    this.accepting = false;
    this.abandonAll();
    this.generationValue += 1;
    this.accepting = true;
    this.notifyChange();
    return this.generation;
  }

  shutdown(): void {
    this.accepting = false;
    this.generationValue += 1;
    this.abandonAll();
    this.notifyChange();
  }

  size(): number {
    return this.jobs.size;
  }
}

export function jobDetailContent(detail: JobDetail): string {
  return jsonText(publicDetail(detail), true);
}

export const JOB_OUTPUT_LIMITS = Object.freeze({ maxBytes: MAX_TEXT_BYTES, maxLines: MAX_TEXT_LINES });
