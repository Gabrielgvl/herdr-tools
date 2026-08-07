import { randomUUID } from "node:crypto";
import { truncateTail } from "@earendil-works/pi-coding-agent";

export const JOB_STATUSES = ["running", "completed", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const WAIT_OUTCOMES = ["success", "timeout", "manager_judgment_required"] as const;
export type WaitOutcome = (typeof WAIT_OUTCOMES)[number];

const MAX_TEXT_BYTES = 50_000;
const MAX_TEXT_LINES = 2_000;
const MAX_SUMMARY_CHARS = 1_000;
const MAX_PUBLIC_JSON_BYTES = MAX_TEXT_BYTES - 1;
const OUTPUT_TRUNCATION_MARKER = "\n[output truncated]";

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
    metadata: Record<string, unknown>;
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
}

export interface JobListResult {
  jobs: JobSummary[];
  total: number;
  offset: number;
  limit: number;
  nextOffset: number | null;
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

function boundedText(value: string, limit = MAX_SUMMARY_CHARS): string {
  return truncateTail(value, { maxBytes: limit, maxLines: MAX_TEXT_LINES }).content;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) as string, "utf8");
}

function truncateContent(content: string, maxBytes: number): string {
  let low = 0;
  let high = Math.min(maxBytes, Buffer.byteLength(content, "utf8"));
  let best = "";
  while (low <= high) {
    const candidateLimit = Math.floor((low + high) / 2);
    const candidate = truncateTail(content, { maxBytes: candidateLimit, maxLines: MAX_TEXT_LINES }).content;
    if (jsonBytes({ truncated: true, content: candidate }) <= maxBytes) {
      best = candidate;
      low = candidateLimit + 1;
    } else {
      high = candidateLimit - 1;
    }
  }
  return best;
}

function boundedDetails(value: unknown, maxBytes = MAX_PUBLIC_JSON_BYTES): unknown {
  let cloned: unknown;
  try {
    cloned = clone(value);
  } catch {
    return "[details unavailable]";
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(cloned) as string;
  } catch {
    return "[details unavailable]";
  }
  if (jsonBytes(cloned) <= maxBytes) return cloned;
  if (typeof cloned === "object" && cloned !== null && !Array.isArray(cloned) && (cloned as { truncated?: unknown }).truncated === true && typeof (cloned as { content?: unknown }).content === "string") {
    return { truncated: true, content: truncateContent((cloned as { content: string }).content, maxBytes) };
  }
  return { truncated: true, content: truncateContent(serialized, maxBytes) };
}

function boundedProgress(progress: JobProgress): JobProgress {
  const base = { text: boundedText(progress.text), atMs: progress.atMs };
  if (progress.details === undefined) return base;
  const prefixBytes = jsonBytes({ ...base, details: null }) - Buffer.byteLength("null", "utf8");
  const maxDetailBytes = Math.max(0, MAX_PUBLIC_JSON_BYTES - prefixBytes);
  const details = boundedDetails(progress.details, maxDetailBytes);
  return { ...base, details };
}

function copyRequest(request: JobRequestSnapshot): JobRequestSnapshot {
  return clone({
    targets: [...request.targets],
    targetIds: [...request.targetIds],
    match: request.match,
    condition: clone(request.condition),
    timeoutMs: request.timeoutMs,
    settings: { ...request.settings }
  });
}

function copyResult(result: JobRunResult): JobResultSnapshot {
  const targets = result.targets?.map((target) => ({
    target: boundedText(target.target),
    targetId: boundedText(target.targetId),
    metadata: boundedDetails(target.metadata) as Record<string, unknown>,
    recentUnwrappedLines: target.recentUnwrappedLines.slice(-100).map((line) => boundedText(line, 2_000)),
    ...(target.outputTruncated === undefined ? {} : { outputTruncated: target.outputTruncated }),
    observedAtMs: target.observedAtMs,
    matched: target.matched
  }));
  const reviewerSummaries = result.reviewerSummaries?.map((summary) => ({
    target: boundedText(summary.target),
    targetId: boundedText(summary.targetId),
    classification: boundedText(summary.classification),
    summary: boundedText(summary.summary)
  }));
  return {
    outcome: result.outcome,
    matched: result.matched,
    ...(result.reason ? { reason: boundedText(result.reason) } : {}),
    ...(targets ? { targets } : {}),
    ...(reviewerSummaries && reviewerSummaries.length > 0 ? { reviewerSummaries } : {})
  };
}

function copyDetail(detail: JobDetail): JobDetail {
  const copy: JobDetail = {
    jobId: detail.jobId,
    status: detail.status,
    sequence: detail.sequence,
    createdAtMs: detail.createdAtMs,
    startedAtMs: detail.startedAtMs,
    ...(detail.finishedAtMs === undefined ? {} : { finishedAtMs: detail.finishedAtMs }),
    request: copyRequest(detail.request),
    ...(detail.progress ? { progress: boundedProgress(detail.progress) } : {}),
    ...(detail.outcome ? { outcome: detail.outcome } : {}),
    ...(detail.result ? { result: copyResult(detail.result) } : {}),
    ...(detail.error ? {
      error: {
        ...(detail.error.code ? { code: boundedText(detail.error.code) } : {}),
        message: boundedText(detail.error.message),
        ...(detail.error.details === undefined ? {} : { details: boundedDetails(detail.error.details) })
      }
    } : {}),
    ...(detail.cancelReason ? { cancelReason: detail.cancelReason } : {})
  };
  return clone(copy);
}

function summary(detail: JobDetail): JobSummary {
  return {
    jobId: detail.jobId,
    status: detail.status,
    sequence: detail.sequence,
    createdAtMs: detail.createdAtMs,
    startedAtMs: detail.startedAtMs,
    ...(detail.finishedAtMs === undefined ? {} : { finishedAtMs: detail.finishedAtMs }),
    targetIds: [...detail.request.targetIds],
    targets: [...detail.request.targets],
    ...(detail.outcome ? { outcome: detail.outcome } : {}),
    ...(detail.result?.reason ? { reason: detail.result.reason } : {}),
    ...(detail.cancelReason ? { reason: detail.cancelReason } : {}),
    ...(detail.progress ? { progress: { text: boundedText(detail.progress.text), atMs: detail.progress.atMs } } : {}),
    ...(detail.error ? { error: { ...(detail.error.code ? { code: detail.error.code } : {}), message: boundedText(detail.error.message) } } : {})
  };
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
      request: copyRequest(request)
    };
    const record: JobRecord = { detail, controller, generation };
    this.jobs.set(jobId, record);
    const promise = this.execute(record, run);
    return { jobId, generation, signal: controller.signal, detail: copyDetail(detail), promise };
  }

  private async execute(record: JobRecord, run: (signal: AbortSignal, update: (text: string, details?: unknown) => void) => Promise<JobRunResult>): Promise<void> {
    record.detail.startedAtMs = this.clock.now();
    try {
      const result = await run(record.controller.signal, (text, details) => this.update(record.detail.jobId, text, details));
      if (record.detail.status !== "running") return;
      record.detail.status = "completed";
      record.detail.outcome = result.outcome;
      record.detail.result = copyResult(result);
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
      void Promise.resolve(this.onTerminal(copyDetail(record.detail))).catch(() => undefined);
    } catch {
      // Notification is explicitly best effort and must never affect settlement.
    }
  }

  update(jobId: string, text: string, details?: unknown): JobDetail {
    const record = this.jobs.get(jobId);
    if (!record) throw new Error("JOB_NOT_FOUND: unknown Herdr job");
    if (record.detail.status !== "running") return copyDetail(record.detail);
    record.detail.progress = boundedProgress({ text, atMs: this.clock.now(), ...(details === undefined ? {} : { details }) });
    return copyDetail(record.detail);
  }

  get(jobId: string): JobDetail | undefined {
    const record = this.jobs.get(jobId);
    return record ? copyDetail(record.detail) : undefined;
  }

  list(status?: JobStatus, offset = 0, limit = 20): JobListResult {
    const filtered = [...this.jobs.values()]
      .filter((record) => status === undefined || record.detail.status === status)
      .sort((left, right) => right.detail.sequence - left.detail.sequence);
    const page = filtered.slice(offset, offset + limit).map((record) => summary(copyDetail(record.detail)));
    const nextOffset = offset + page.length < filtered.length ? offset + page.length : undefined;
    return { jobs: clone(page), total: filtered.length, offset, limit, nextOffset: nextOffset ?? null };
  }

  cancel(jobId: string): JobDetail | undefined {
    const record = this.jobs.get(jobId);
    if (!record) return undefined;
    if (record.detail.status !== "running") return copyDetail(record.detail);
    record.detail.status = "cancelled";
    record.detail.cancelReason = "cancelled";
    record.detail.finishedAtMs = this.clock.now();
    record.controller.abort();
    return copyDetail(record.detail);
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
  const serialized = JSON.stringify(copyDetail(detail), null, 2);
  const bounded = truncateTail(serialized, {
    maxBytes: MAX_PUBLIC_JSON_BYTES - Buffer.byteLength(OUTPUT_TRUNCATION_MARKER, "utf8"),
    maxLines: MAX_TEXT_LINES
  });
  return bounded.truncated ? `${bounded.content}${OUTPUT_TRUNCATION_MARKER}` : bounded.content;
}

export const JOB_OUTPUT_LIMITS = Object.freeze({ maxBytes: MAX_TEXT_BYTES, maxLines: MAX_TEXT_LINES });
