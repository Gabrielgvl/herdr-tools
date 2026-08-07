import { randomUUID } from "node:crypto";
import { truncateTail } from "@earendil-works/pi-coding-agent";

export const JOB_STATUSES = ["running", "completed", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const WAIT_OUTCOMES = ["success", "timeout", "manager_judgment_required"] as const;
export type WaitOutcome = (typeof WAIT_OUTCOMES)[number];

const MAX_TEXT_BYTES = 50_000;
const MAX_TEXT_LINES = 2_000;
const MAX_SUMMARY_CHARS = 1_000;
const PUBLIC_REQUEST_ITEMS = 8;
const PUBLIC_RESULT_TARGETS = 6;
const PUBLIC_TARGET_LINES = 4;
const PUBLIC_REVIEWER_SUMMARIES = 6;
const PUBLIC_LIST_JOBS = 20;
const PUBLIC_FIELD_BYTES = 256;

export interface TruncatedDetails {
  truncated: true;
  content: string;
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
  requestTargetIds?: number;
  requestCondition?: boolean;
  progressDetails?: boolean;
  resultTargets?: number;
  resultTargetLines?: number;
  resultTargetMetadata?: number;
  reviewerSummaries?: number;
  errorDetails?: boolean;
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
  truncation?: { targetIds?: number; targets?: number; progress?: boolean };
}

export interface JobListResult {
  jobs: JobSummary[];
  total: number;
  offset: number;
  limit: number;
  nextOffset: number | null;
  truncation?: { jobs: number };
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

function boundedText(value: string, limit = MAX_SUMMARY_CHARS): string {
  return truncateTail(value, { maxBytes: limit, maxLines: MAX_TEXT_LINES }).content;
}

function truncatedDetails(content: string): TruncatedDetails {
  return { truncated: true, content };
}

function hasTruncatedMarker(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "truncated" in value && (value as { truncated?: unknown }).truncated === true;
}

function boundedDetails(value: unknown, maxBytes = PUBLIC_FIELD_BYTES): unknown {
  try {
    const copied = clone(value);
    if (jsonBytes(copied) <= maxBytes && jsonLines(copied) <= MAX_TEXT_LINES) return copied;
    const serialized = jsonText(copied);
    return truncatedDetails(boundedText(serialized, Math.max(64, maxBytes - 64)));
  } catch {
    return truncatedDetails("[details unavailable]");
  }
}

function boundedMetadata(value: Record<string, unknown>): PublicDetails {
  return boundedDetails(value, PUBLIC_FIELD_BYTES) as PublicDetails;
}

function boundedCondition(value: unknown, truncation: JobTruncation, maxBytes = PUBLIC_FIELD_BYTES): unknown {
  const copied = clone(value);
  if (jsonBytes(copied) <= maxBytes && jsonLines(copied) <= MAX_TEXT_LINES) return copied;
  const condition = copied as { kind?: unknown; match?: { kind?: unknown; value?: unknown } };
  if (condition.kind !== "output") {
    truncation.requestCondition = true;
    return { truncated: true, kind: "object" };
  }
  truncation.requestCondition = true;
  return { kind: "output", match: { kind: condition.match!.kind, value: boundedText(condition.match!.value as string, maxBytes) } };
}

function boundedStrings(values: string[], limit: number, truncation: JobTruncation, key: "requestTargets" | "requestTargetIds"): string[] {
  const copied = values.slice(0, limit).map((value) => boundedText(value, PUBLIC_FIELD_BYTES));
  const omitted = values.length - copied.length;
  const shortened = values.slice(0, copied.length).filter((value, index) => copied[index]!.length < value.length).length;
  if (omitted + shortened > 0) truncation[key] = omitted + shortened;
  return copied;
}

function copyRequest(request: JobRequestSnapshot, truncation: JobTruncation): JobRequestSnapshot {
  return {
    targets: boundedStrings(request.targets, PUBLIC_REQUEST_ITEMS, truncation, "requestTargets"),
    targetIds: boundedStrings(request.targetIds, PUBLIC_REQUEST_ITEMS, truncation, "requestTargetIds"),
    match: request.match,
    condition: boundedCondition(request.condition, truncation),
    timeoutMs: request.timeoutMs,
    settings: {
      reviewCadenceMinutes: request.settings.reviewCadenceMinutes,
      reviewerModel: boundedText(request.settings.reviewerModel, PUBLIC_FIELD_BYTES),
      reviewerThinking: request.settings.reviewerThinking
    }
  };
}

function copyResult(result: JobRunResult, truncation: JobTruncation, targetLimit = PUBLIC_RESULT_TARGETS, lineLimit = PUBLIC_TARGET_LINES, reviewerLimit = PUBLIC_REVIEWER_SUMMARIES): JobResultSnapshot {
  const sourceTargets = result.targets ?? [];
  const targets = sourceTargets.slice(0, targetLimit).map((target) => {
    const lines = target.recentUnwrappedLines.slice(-lineLimit);
    if (target.recentUnwrappedLines.length > lines.length) truncation.resultTargetLines = (truncation.resultTargetLines ?? 0) + target.recentUnwrappedLines.length - lines.length;
    return {
      target: boundedText(target.target, PUBLIC_FIELD_BYTES),
      targetId: boundedText(target.targetId, PUBLIC_FIELD_BYTES),
      metadata: boundedMetadata(target.metadata as Record<string, unknown>),
      recentUnwrappedLines: lines.map((line) => boundedText(line, PUBLIC_FIELD_BYTES)),
      ...(target.outputTruncated === undefined ? {} : { outputTruncated: target.outputTruncated }),
      observedAtMs: target.observedAtMs,
      matched: target.matched
    };
  });
  if (sourceTargets.length > targets.length) truncation.resultTargets = sourceTargets.length - targets.length;
  const sourceReviews = result.reviewerSummaries ?? [];
  const reviewerSummaries = sourceReviews.slice(0, reviewerLimit).map((summary) => ({
    target: boundedText(summary.target, PUBLIC_FIELD_BYTES),
    targetId: boundedText(summary.targetId, PUBLIC_FIELD_BYTES),
    classification: boundedText(summary.classification, PUBLIC_FIELD_BYTES),
    summary: boundedText(summary.summary, PUBLIC_FIELD_BYTES)
  }));
  if (sourceReviews.length > reviewerSummaries.length) truncation.reviewerSummaries = sourceReviews.length - reviewerSummaries.length;
  return {
    outcome: result.outcome,
    matched: result.matched,
    ...(result.reason ? { reason: boundedText(result.reason) } : {}),
    ...(sourceTargets.length > 0 ? { targets } : {}),
    ...(sourceReviews.length > 0 ? { reviewerSummaries } : {})
  };
}

function copyProgress(progress: JobProgress): JobProgress {
  const copied: JobProgress = { text: boundedText(progress.text), atMs: progress.atMs };
  if (progress.details === undefined) return copied;
  copied.details = boundedDetails(progress.details);
  return copied;
}

function publicDetail(detail: JobDetail): JobDetail {
  const truncation: JobTruncation = { ...detail.truncation };
  const copy: JobDetail = {
    jobId: boundedText(detail.jobId, PUBLIC_FIELD_BYTES),
    status: detail.status,
    sequence: detail.sequence,
    createdAtMs: detail.createdAtMs,
    startedAtMs: detail.startedAtMs,
    finishedAtMs: detail.finishedAtMs,
    request: copyRequest(detail.request, truncation),
    ...(detail.progress ? { progress: copyProgress(detail.progress) } : {}),
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
  if (hasTruncatedMarker(copy.progress?.details)) truncation.progressDetails = true;
  if (detail.result?.targets?.some((target) => hasTruncatedMarker(target.metadata))) truncation.resultTargetMetadata = detail.result.targets.filter((target) => hasTruncatedMarker(target.metadata)).length;
  if (hasTruncatedMarker(copy.error?.details)) truncation.errorDetails = true;
  if (Object.keys(truncation).length > 0) copy.truncation = truncation;
  return clone(copy);
}

function summary(detail: JobDetail): JobSummary {
  const truncation: NonNullable<JobSummary["truncation"]> = {};
  const targetIds = detail.request.targetIds.slice(0, 4).map((value) => boundedText(value, 64));
  const targets = detail.request.targets.slice(0, 4).map((value) => boundedText(value, 64));
  if (detail.request.targetIds.length > targetIds.length) truncation.targetIds = detail.request.targetIds.length - targetIds.length;
  if (detail.request.targets.length > targets.length) truncation.targets = detail.request.targets.length - targets.length;
  const progress = detail.progress ? { text: boundedText(detail.progress.text, 256), atMs: detail.progress.atMs } : undefined;
  if (detail.progress && progress && progress.text !== detail.progress.text) truncation.progress = true;
  return clone({
    jobId: boundedText(detail.jobId, PUBLIC_FIELD_BYTES),
    status: detail.status,
    sequence: detail.sequence,
    createdAtMs: detail.createdAtMs,
    startedAtMs: detail.startedAtMs,
    finishedAtMs: detail.finishedAtMs,
    targetIds,
    targets,
    ...(detail.outcome ? { outcome: detail.outcome } : {}),
    ...(detail.result?.reason ? { reason: boundedText(detail.result.reason, 256) } : {}),
    ...(detail.cancelReason ? { reason: detail.cancelReason } : {}),
    ...(progress ? { progress } : {}),
    ...(detail.error ? { error: { ...(detail.error.code ? { code: boundedText(detail.error.code, 64) } : {}), message: boundedText(detail.error.message, 256) } } : {}),
    ...(Object.keys(truncation).length > 0 ? { truncation } : {})
  });
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
      record.detail.result = copyResult(result, {}, 100, 100, 100);
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
    const requested = filtered.slice(offset, offset + limit).map((record) => summary(record.detail));
    const jobs = requested.slice(0, PUBLIC_LIST_JOBS);
    const result: JobListResult = {
      jobs: clone(jobs),
      total: filtered.length,
      offset,
      limit,
      nextOffset: offset + jobs.length < filtered.length ? offset + jobs.length : null,
      ...(requested.length > jobs.length ? { truncation: { jobs: requested.length - jobs.length } } : {})
    };
    return clone(result);
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
