import { randomUUID } from "node:crypto";
import { truncateTail } from "@earendil-works/pi-coding-agent";

export const JOB_STATUSES = ["running", "completed", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const WAIT_OUTCOMES = ["success", "timeout", "manager_judgment_required"] as const;
export type WaitOutcome = (typeof WAIT_OUTCOMES)[number];

const MAX_TEXT_BYTES = 50_000;
const MAX_TEXT_LINES = 2_000;
const MAX_PUBLIC_BYTES = MAX_TEXT_BYTES - 1;
const MAX_SUMMARY_CHARS = 1_000;
const PUBLIC_REQUEST_ITEMS = 8;
const PUBLIC_RESULT_TARGETS = 6;
const PUBLIC_TARGET_LINES = 4;
const PUBLIC_REVIEWER_SUMMARIES = 6;
const PUBLIC_LIST_JOBS = 100;
const PUBLIC_SUMMARY_ITEMS = 2;
const PUBLIC_FIELD_BYTES = 256;

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

export interface JobRequestSnapshot {
  targets: string[];
  targetIds: string[];
  match: "any" | "all";
  condition: unknown;
  timeoutMs: number;
  settings: {
    reviewCadenceMinutes: number;
    reviewerModel: string;
    reviewerThinking: "low";
  };
}

export interface JobProgress {
  text: string;
  atMs: number;
  details?: unknown;
}

export interface JobResultSnapshot {
  outcome: WaitOutcome;
  matched: boolean;
  reason?: string;
  /** Exact match facts are independent from the bounded evidence window. */
  matchedTargetCount?: number;
  matchedTargets?: Array<{ target: string; targetId: string }>;
  targets?: Array<{
    target: string;
    targetId: string;
    metadata: PublicDetails;
    recentUnwrappedLines: string[];
    outputTruncated?: boolean;
    observedAtMs: number;
    matched: boolean;
  }>;
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
  requestCondition?: boolean;
  requestConditionClipped?: boolean;
  requestReviewerModelClipped?: boolean;
  jobIdClipped?: boolean;
  progressDetails?: boolean;
  progressTextClipped?: boolean;
  resultTargets?: number;
  resultMatchedTargets?: number;
  resultTargetValuesClipped?: number;
  resultTargetIdsClipped?: number;
  resultTargetLines?: number;
  resultTargetLinesClipped?: number;
  resultTargetMetadata?: number;
  reviewerSummaries?: number;
  reviewerFieldsClipped?: number;
  errorDetails?: boolean;
  errorCodeClipped?: boolean;
  errorMessageClipped?: boolean;
  publicEvidenceOmitted?: boolean;
}

export interface JobDetail {
  jobId: string;
  status: JobStatus;
  sequence: number;
  createdAtMs: number;
  startedAtMs?: number;
  finishedAtMs?: number;
  request: JobRequestSnapshot;
  progress?: JobProgress;
  outcome?: WaitOutcome;
  result?: JobResultSnapshot;
  error?: JobErrorSnapshot;
  cancelReason?: "cancelled" | "shutdown";
  truncation?: JobTruncation;
}

export interface JobSummary {
  jobId: string;
  status: JobStatus;
  sequence: number;
  createdAtMs: number;
  startedAtMs?: number;
  finishedAtMs?: number;
  targetIds: string[];
  targets: string[];
  outcome?: WaitOutcome;
  reason?: string;
  progress?: { text: string; atMs: number };
  error?: { code?: string; message: string };
  truncation?: { targetIds?: number; targetIdsClipped?: number; targets?: number; targetsClipped?: number; progress?: boolean; jobIdClipped?: boolean };
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

export interface JobRunResult {
  outcome: WaitOutcome;
  matched: boolean;
  reason?: string;
  matchedTargetCount?: number;
  matchedTargets?: JobResultSnapshot["matchedTargets"];
  targets?: JobResultSnapshot["targets"];
  reviewerSummaries?: JobResultSnapshot["reviewerSummaries"];
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
}

export interface RegisteredJob {
  jobId: string;
  generation: JobGeneration;
  signal: AbortSignal;
  detail: JobDetail;
  promise: Promise<void>;
}

interface JobRecord {
  detail: JobDetail;
  controller: AbortController;
  generation: JobGeneration;
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

function boundedStrings(values: string[], limit: number, truncation: JobTruncation, key: "requestTargets" | "requestTargetIds", clippedKey: "requestTargetsClipped" | "requestTargetIdsClipped"): string[] {
  const selected = values.slice(0, limit);
  const copied = selected.map((value) => boundedText(value, PUBLIC_FIELD_BYTES));
  const omitted = values.length - copied.length;
  const clipped = selected.filter((value, index) => copied[index] !== value).length;
  if (omitted > 0) truncation[key] = omitted;
  if (clipped > 0) truncation[clippedKey] = clipped;
  return copied;
}

function copyRequest(request: JobRequestSnapshot, truncation: JobTruncation): JobRequestSnapshot {
  const reviewerModel = boundedText(request.settings.reviewerModel, PUBLIC_FIELD_BYTES);
  if (reviewerModel !== request.settings.reviewerModel) truncation.requestReviewerModelClipped = true;
  return {
    targets: boundedStrings(request.targets, PUBLIC_REQUEST_ITEMS, truncation, "requestTargets", "requestTargetsClipped"),
    targetIds: boundedStrings(request.targetIds, PUBLIC_REQUEST_ITEMS, truncation, "requestTargetIds", "requestTargetIdsClipped"),
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

function copyResult(result: JobRunResult, truncation: JobTruncation, targetLimit = PUBLIC_RESULT_TARGETS, lineLimit = PUBLIC_TARGET_LINES, reviewerLimit = PUBLIC_REVIEWER_SUMMARIES): JobResultSnapshot {
  const sourceTargets = result.targets ?? [];
  const matchedSourceTargets = result.outcome === "success" ? sourceTargets.filter((target) => target.matched) : [];
  const matchedSourceRefs = result.outcome === "success" ? result.matchedTargets ?? matchedSourceTargets.map((target) => ({ target: target.target, targetId: target.targetId })) : [];
  const matchedTargetCount = result.outcome === "success" ? result.matchedTargetCount ?? matchedSourceTargets.length : 0;
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
    return {
      target: targetValue,
      targetId,
      metadata: boundedMetadata(target.metadata as Record<string, unknown>),
      recentUnwrappedLines,
      ...(target.outputTruncated === undefined ? {} : { outputTruncated: target.outputTruncated }),
      observedAtMs: target.observedAtMs,
      matched: target.matched
    };
  });
  if (sourceTargets.length > targets.length) truncation.resultTargets = sourceTargets.length - targets.length;

  const matchedTargets = matchedSourceRefs.slice(0, targetLimit).map((target) => ({
    target: boundedText(target.target, PUBLIC_FIELD_BYTES),
    targetId: boundedText(target.targetId, PUBLIC_FIELD_BYTES)
  }));
  if (matchedTargetCount > matchedTargets.length) truncation.resultMatchedTargets = Math.max(truncation.resultMatchedTargets ?? 0, matchedTargetCount - matchedTargets.length);

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
    outcome: result.outcome,
    matched: result.matched,
    ...(matchedTargetCount > 0 ? { matchedTargetCount, matchedTargets } : {}),
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
  "requestTargets", "requestTargetsClipped", "requestTargetIds", "requestTargetIdsClipped", "requestCondition", "requestConditionClipped", "requestReviewerModelClipped", "jobIdClipped", "progressDetails", "progressTextClipped", "resultTargets", "resultMatchedTargets", "resultTargetValuesClipped", "resultTargetIdsClipped", "resultTargetLines", "resultTargetLinesClipped", "resultTargetMetadata", "reviewerSummaries", "reviewerFieldsClipped", "errorDetails", "errorCodeClipped", "errorMessageClipped", "publicEvidenceOmitted"
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
  return copy;
}

function minimalDetail(copy: JobDetail, truncation: JobTruncation): JobDetail {
  truncation.publicEvidenceOmitted = true;
  return {
    jobId: boundedText(copy.jobId, 128),
    status: copy.status,
    sequence: copy.sequence,
    createdAtMs: copy.createdAtMs,
    ...(copy.startedAtMs === undefined ? {} : { startedAtMs: copy.startedAtMs }),
    ...(copy.finishedAtMs === undefined ? {} : { finishedAtMs: copy.finishedAtMs }),
    request: {
      targets: [],
      targetIds: [],
      match: copy.request.match,
      condition: { truncated: true, kind: "object" },
      timeoutMs: copy.request.timeoutMs,
      settings: copy.request.settings
    },
    ...(copy.outcome ? { outcome: copy.outcome } : {}),
    ...(copy.result ? { result: { outcome: copy.result.outcome, matched: copy.result.matched, ...(copy.result.matchedTargetCount === undefined ? {} : { matchedTargetCount: copy.result.matchedTargetCount }), ...(copy.result.matchedTargets ? { matchedTargets: copy.result.matchedTargets.slice(0, 1) } : {}) } } : {}),
    ...(copy.cancelReason ? { cancelReason: copy.cancelReason } : {}),
    truncation
  };
}

export function publicDetail(detail: JobDetail, maxBytes = MAX_PUBLIC_BYTES): JobDetail {
  const truncation: JobTruncation = boundedTruncation(detail.truncation);
  const jobId = boundedText(detail.jobId, PUBLIC_FIELD_BYTES);
  if (jobId !== detail.jobId) truncation.jobIdClipped = true;
  const copy: JobDetail = {
    jobId,
    status: detail.status,
    sequence: detail.sequence,
    createdAtMs: detail.createdAtMs,
    startedAtMs: detail.startedAtMs,
    finishedAtMs: detail.finishedAtMs,
    request: copyRequest(detail.request, truncation),
    ...(detail.progress ? { progress: copyProgress(detail.progress, truncation) } : {}),
    ...(detail.outcome ? { outcome: detail.outcome } : {}),
    ...(detail.result ? { result: copyResult(detail.result, truncation) } : {}),
    ...(detail.error ? {
      error: {
        ...(detail.error.code ? { code: boundedText(detail.error.code, PUBLIC_FIELD_BYTES) } : {}),
        message: boundedText(detail.error.message),
        ...(detail.error.details === undefined ? {} : { details: boundedDetails(detail.error.details) })
      }
    } : {}),
    ...(detail.cancelReason ? { cancelReason: detail.cancelReason } : {})
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
  const targetIds = detail.request.targetIds.slice(0, PUBLIC_SUMMARY_ITEMS).map((value) => boundedText(value, 48));
  const targets = detail.request.targets.slice(0, PUBLIC_SUMMARY_ITEMS).map((value) => boundedText(value, 48));
  if (detail.request.targetIds.length > targetIds.length) truncation.targetIds = detail.request.targetIds.length - targetIds.length;
  if (detail.request.targets.length > targets.length) truncation.targets = detail.request.targets.length - targets.length;
  const clippedTargetIds = detail.request.targetIds.slice(0, targetIds.length).filter((value, index) => targetIds[index] !== value).length;
  const clippedTargets = detail.request.targets.slice(0, targets.length).filter((value, index) => targets[index] !== value).length;
  if (clippedTargetIds > 0) truncation.targetIdsClipped = clippedTargetIds;
  if (clippedTargets > 0) truncation.targetsClipped = clippedTargets;
  const progress = detail.progress ? { text: boundedText(detail.progress.text, 128), atMs: detail.progress.atMs } : undefined;
  if (detail.progress && progress && progress.text !== detail.progress.text) truncation.progress = true;
  const jobId = boundedText(detail.jobId, 64);
  if (jobId !== detail.jobId) truncation.jobIdClipped = true;
  return clone({
    jobId,
    status: detail.status,
    sequence: detail.sequence,
    createdAtMs: detail.createdAtMs,
    startedAtMs: detail.startedAtMs,
    finishedAtMs: detail.finishedAtMs,
    targetIds,
    targets,
    ...(detail.outcome ? { outcome: detail.outcome } : {}),
    ...(detail.result?.reason ? { reason: boundedText(detail.result.reason, 128) } : {}),
    ...(detail.cancelReason ? { reason: detail.cancelReason } : {}),
    ...(progress ? { progress } : {}),
    ...(detail.error ? { error: { ...(detail.error.code ? { code: boundedText(detail.error.code, 48) } : {}), message: boundedText(detail.error.message, 128) } } : {}),
    ...(Object.keys(truncation).length > 0 ? { truncation } : {})
  });
}

function compactSummaryForList(value: JobSummary): JobSummary {
  const jobIdClipped = value.jobId.length > 32 || value.truncation?.jobIdClipped === true;
  const truncation = { ...value.truncation, ...(jobIdClipped ? { jobIdClipped: true } : {}) };
  return {
    jobId: boundedText(value.jobId, 32),
    status: value.status,
    sequence: value.sequence,
    createdAtMs: value.createdAtMs,
    startedAtMs: value.startedAtMs,
    finishedAtMs: value.finishedAtMs,
    targetIds: [],
    targets: [],
    ...(value.outcome ? { outcome: value.outcome } : {}),
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
  const minimalJobs = result.jobs.map((job) => ({
    jobId: boundedText(job.jobId, 16),
    status: job.status,
    sequence: job.sequence,
    createdAtMs: job.createdAtMs,
    ...(job.startedAtMs === undefined ? {} : { startedAtMs: job.startedAtMs }),
    ...(job.finishedAtMs === undefined ? {} : { finishedAtMs: job.finishedAtMs }),
    ...(job.outcome ? { outcome: job.outcome } : {}),
    targetIds: [],
    targets: [],
    truncation: { ...(job.truncation ?? {}), jobIdClipped: true }
  }));
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
  private sequence = 0;
  private generationValue = 0;
  private accepting = true;

  constructor(options: JobRegistryOptions = {}) {
    this.idFactory = options.idFactory ?? (() => `job_${randomUUID()}`);
    this.clock = options.clock ?? { now: () => Date.now() };
    this.onTerminal = options.onTerminal;
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

  beginSession(): JobGeneration {
    this.accepting = false;
    for (const record of this.jobs.values()) {
      if (record.detail.status !== "running") continue;
      record.detail.status = "cancelled";
      record.detail.cancelReason = "shutdown";
      record.detail.finishedAtMs = this.clock.now();
      record.controller.abort();
    }
    this.jobs.clear();
    this.generationValue += 1;
    this.accepting = true;
    return this.generation;
  }

  register(
    request: JobRequestSnapshot,
    run: (signal: AbortSignal, update: (text: string, details?: unknown) => void) => Promise<JobRunResult>,
    generation: JobGeneration = this.generation
  ): RegisteredJob {
    if (!this.isCurrent(generation)) throw new Error("SESSION_REPLACED: wait session was replaced before registration");
    const jobId = this.idFactory();
    if (!jobId.startsWith("job_") || jobId.length <= 4 || jobId.includes(String.fromCharCode(0)) || jobId.includes("\r") || jobId.includes("\n") || this.jobs.has(jobId)) throw new Error("JOB_ID_INVALID: job ID factory returned an invalid or duplicate ID");
    const controller = new AbortController();
    const detail: JobDetail = {
      jobId,
      status: "running",
      sequence: ++this.sequence,
      createdAtMs: this.clock.now(),
      request: clone(request)
    };
    const record: JobRecord = { detail, controller, generation };
    this.jobs.set(jobId, record);
    const promise = this.execute(record, run);
    return { jobId, generation, signal: controller.signal, detail: publicDetail(detail), promise };
  }

  private async execute(record: JobRecord, run: (signal: AbortSignal, update: (text: string, details?: unknown) => void) => Promise<JobRunResult>): Promise<void> {
    record.detail.startedAtMs = this.clock.now();
    try {
      const result = await run(record.controller.signal, (text, details) => this.update(record.detail.jobId, text, details));
      if (record.detail.status !== "running") return;
      record.detail.status = "completed";
      record.detail.outcome = result.outcome;
      // Keep the authoritative terminal snapshots intact. Every public read performs
      // one bounded projection from this original result, so match facts cannot be
      // changed by an intermediate evidence window.
      record.detail.result = clone({
        outcome: result.outcome,
        matched: result.matched,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.matchedTargetCount === undefined ? {} : { matchedTargetCount: result.matchedTargetCount }),
        ...(result.matchedTargets ? { matchedTargets: result.matchedTargets } : {}),
        ...(result.targets ? { targets: result.targets } : {}),
        ...(result.reviewerSummaries ? { reviewerSummaries: result.reviewerSummaries } : {})
      });
      record.detail.finishedAtMs = this.clock.now();
      this.notifyTerminal(record);
    } catch (error) {
      if (record.detail.status !== "running") return;
      const mapped: JobErrorSnapshot = {
        ...(typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string" ? { code: (error as { code: string }).code } : {}),
        message: error instanceof Error ? error.message : String(error),
        ...(typeof error === "object" && error !== null && "details" in error ? { details: (error as { details?: unknown }).details } : {})
      };
      record.detail.status = "failed";
      record.detail.error = mapped;
      record.detail.finishedAtMs = this.clock.now();
      this.notifyTerminal(record);
    }
  }

  private notifyTerminal(record: JobRecord): void {
    if (!this.onTerminal) return;
    try {
      void Promise.resolve(this.onTerminal(publicDetail(record.detail))).catch(() => undefined);
    } catch {
      // Notification is explicitly best effort and must never affect settlement.
    }
  }

  update(jobId: string, text: string, details?: unknown): JobDetail {
    const record = this.jobs.get(jobId);
    if (!record) throw new Error("JOB_NOT_FOUND: unknown Herdr job");
    if (record.detail.status !== "running") return publicDetail(record.detail);
    record.detail.progress = { text: boundedText(text), atMs: this.clock.now(), ...(details === undefined ? {} : { details: boundedDetails(details) }) };
    return publicDetail(record.detail);
  }

  get(jobId: string): JobDetail | undefined {
    const record = this.jobs.get(jobId);
    return record ? publicDetail(record.detail) : undefined;
  }

  list(status?: JobStatus, offset = 0, limit = 20): JobListResult {
    const filtered = [...this.jobs.values()]
      .filter((record) => status === undefined || record.detail.status === status)
      .sort((left, right) => right.detail.sequence - left.detail.sequence);
    const pageLimit = Math.min(Math.max(1, limit), PUBLIC_LIST_JOBS);
    const jobs = filtered.slice(offset, offset + pageLimit).map((record) => summary(record.detail));
    const result: JobListResult = {
      jobs,
      total: filtered.length,
      offset,
      limit: pageLimit,
      nextOffset: offset + jobs.length < filtered.length ? offset + jobs.length : null
    };
    return boundedList(result);
  }

  cancel(jobId: string): JobDetail | undefined {
    const record = this.jobs.get(jobId);
    if (!record) return undefined;
    if (record.detail.status !== "running") return publicDetail(record.detail);
    record.detail.status = "cancelled";
    record.detail.cancelReason = "cancelled";
    record.detail.finishedAtMs = this.clock.now();
    record.controller.abort();
    return publicDetail(record.detail);
  }

  shutdown(): void {
    this.accepting = false;
    this.generationValue += 1;
    for (const record of this.jobs.values()) {
      if (record.detail.status !== "running") continue;
      record.detail.status = "cancelled";
      record.detail.cancelReason = "shutdown";
      record.detail.finishedAtMs = this.clock.now();
      record.controller.abort();
    }
    this.jobs.clear();
  }

  size(): number {
    return this.jobs.size;
  }
}

export function jobDetailContent(detail: JobDetail): string {
  return jsonText(publicDetail(detail), true);
}

export const JOB_OUTPUT_LIMITS = Object.freeze({ maxBytes: MAX_TEXT_BYTES, maxLines: MAX_TEXT_LINES });
