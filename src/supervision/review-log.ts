/**
 * The ADR-035 D1 durable supervision review log: append-once JSONL records at
 * `<root>/.herdr/supervision/reviews.jsonl`, where `root` is the trusted
 * manager/session project directory — the anchor the hosts already use
 * (`HERDR_PROJECT_DIR` when set, else the host's own launch directory), never a
 * caller-controlled child `cwd`.
 *
 * One `review` record persists per completed review: timestamp, job, child
 * name and kind, classification, every signal probability including the
 * non-activating ones, evidence sufficiency, the reason code, the attention
 * decision, the progress watermark, the previous classification, the new-line
 * count, and the evidence cursors the review pinned (pane, terminal, agent
 * session, pane revision, lifecycle sequence, consumed transcript window,
 * working time). An attention wake additionally appends a `wake` record whose
 * `disposition` is honestly `unknown`; a manager-observed disposition is a
 * `disposition` record appended through the same file by
 * `appendSupervisionDisposition`, superseding by `eventId` — latest wins, and
 * absent never defaults to "acted". No raw transcript, no caller prose, and
 * no reviewer summary text reaches the file.
 *
 * Persistence is allowlisted before `modelSafeJson` ever runs: each line is
 * built from typed fields — every nested object rebuilt from its allowlisted
 * keys and every contract shape (the five signal keys, the reason set, the
 * classification set, the event-type set, the disposition set) proven — so no
 * transcript line, assignment text, metadata bag, request/response text, or
 * exception message can reach the file.
 *
 * Appends serialize on the flock holder (`reviews.lock`) inside one short
 * exclusive section; the lock is never held across a review or a wake. Every
 * failure — untrusted input, unsafe or symlink targets, lock acquisition, or
 * write errors — surfaces as `REVIEW_LOG_UNAVAILABLE` with no claim of
 * persistence. There is no retry, repair, rotation, or fsync/WAL durability
 * promise, and existing records are never truncated.
 *
 * Unlike the router decision log — whose `ROUTER_LOG_UNAVAILABLE` vetoes a
 * launch because the decision log is a launch precondition and the only
 * routing dataset — a failed append here is telemetry loss only: the caller
 * degrades and supervision continues, because blinding the supervisor to
 * protect a dataset inverts the priority.
 */
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { isAgentName } from "../agent-identity.js";
import { acquireFlockHolder, assertOwnerOnlyDirectory } from "../pane-write-lock.js";
import { modelSafeJson } from "../redaction.js";
import { REVIEW_CLASSIFICATIONS, type ReviewClassification } from "../reviewer.js";
import { SUPERVISION_EVENT_TYPES, type SupervisionEventType } from "./events.js";
import type { AgentSessionRecord } from "./protocol.js";
import { SUPERVISION_REASONS, type SupervisionReason, type SupervisionSignalProbabilities } from "./reviewer.js";

export class ReviewLogError extends Error {
  readonly code = "REVIEW_LOG_UNAVAILABLE";

  constructor(message = "Supervision review log is unavailable") {
    super(message);
    this.name = "ReviewLogError";
  }
}

const reviewLogFailure = (message: string): ReviewLogError => new ReviewLogError(message);

/** Bound on flock's own contention wait for one append section. */
export const REVIEW_LOG_LOCK_WAIT_MS = 5_000;
const REVIEW_LOG_READY = "HERDR_REVIEW_LOG_LOCK_READY";

const SIGNAL_KEYS = ["progress", "stalled", "blocked", "risk", "appears_complete"] as const;

/** What a human did with an attention wake, as far as was observable. */
export const SUPERVISION_DISPOSITIONS = ["acknowledged", "acted", "overruled", "unknown"] as const;
export type SupervisionDisposition = (typeof SUPERVISION_DISPOSITIONS)[number];

/**
 * The evidence cursors a review may carry; each optional field is recorded
 * only when the review actually pinned it. `paneId`/`terminalId` identify the
 * observed child and are required once an evidence object is supplied.
 */
export interface SupervisionReviewEvidence {
  paneId: string;
  terminalId: string;
  agentSession?: AgentSessionRecord;
  revision?: number;
  stateChangeSeq?: number;
  transcriptLines?: number;
  workingForMs?: number;
}

/** One completed review — plus the wake it may have raised — as the supervisor supplies it. */
export interface SupervisionReviewLogEntry {
  jobId: string;
  agentName: string;
  agentKind: string;
  /** The supervisor clock reading at completion. */
  atMs: number;
  classification: ReviewClassification;
  attention: boolean;
  signals?: SupervisionSignalProbabilities;
  evidenceSufficiency?: number;
  reason?: SupervisionReason;
  lastMeaningfulProgressAtMs?: number;
  linesSinceLastReview?: number;
  previousClassification?: ReviewClassification;
  evidence?: SupervisionReviewEvidence;
  /** Present exactly when this review woke the manager; the wake record rides the same append. */
  wake?: { eventId: string; eventType: SupervisionEventType; atMs: number };
}

/** A manager-observed disposition for a recorded wake. */
export interface SupervisionDispositionLogEntry {
  jobId: string;
  eventId: string;
  disposition: SupervisionDisposition;
  /** The observed action time; defaults to the append clock. */
  atMs?: number;
}

/** The fixed `review` record schema appended as one JSONL line. */
export interface SupervisionReviewLogRecord {
  type: "review";
  timestamp: string;
  jobId: string;
  agentName: string;
  agentKind: string;
  atMs: number;
  classification: ReviewClassification;
  attention: boolean;
  signals: SupervisionSignalProbabilities | null;
  evidenceSufficiency: number | null;
  reason: SupervisionReason | null;
  lastMeaningfulProgressAtMs: number | null;
  linesSinceLastReview: number | null;
  previousClassification: ReviewClassification | null;
  evidence: SupervisionReviewEvidence | null;
}

/** The fixed `wake` record schema; `disposition` stays `unknown` until a `disposition` record supersedes it. */
export interface SupervisionWakeLogRecord {
  type: "wake";
  timestamp: string;
  jobId: string;
  agentName: string;
  eventId: string;
  eventType: SupervisionEventType;
  classification: ReviewClassification;
  atMs: number;
  /** The parent review's clock reading, so a wake joins its review without inference. */
  reviewAtMs: number;
  disposition: SupervisionDisposition;
}

/** The fixed `disposition` record schema; latest record per `eventId` wins, absent means unknown. */
export interface SupervisionDispositionLogRecord {
  type: "disposition";
  timestamp: string;
  atMs: number;
  jobId: string;
  eventId: string;
  disposition: SupervisionDisposition;
}

export type SupervisionLogRecord = SupervisionReviewLogRecord | SupervisionWakeLogRecord | SupervisionDispositionLogRecord;

export interface AppendReviewLogOptions {
  root: string;
  now?: () => Date;
  waitMs?: number;
  deadlineMs?: number;
}

/** The review-log append seam `SupervisorDependencies` consumes; `appendSupervisionReview` satisfies it directly. */
export type SupervisionReviewLog = (entry: SupervisionReviewLogEntry, options: AppendReviewLogOptions) => Promise<void>;

export interface SupervisionReviewLogPaths {
  directory: string;
  reviews: string;
  lock: string;
}

export function reviewLogPaths(root: string): SupervisionReviewLogPaths {
  const directory = join(root, ".herdr", "supervision");
  return { directory, reviews: join(directory, "reviews.jsonl"), lock: join(directory, "reviews.lock") };
}

/**
 * The trusted project root when no caller supplies one: the same anchor the
 * hosts use — `HERDR_PROJECT_DIR` when it is set, else the host's own launch
 * directory. An unusable value fails the append's absolute-root check rather
 * than silently re-anchoring.
 */
export function defaultReviewLogRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.HERDR_PROJECT_DIR ?? process.cwd();
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function uid(): number {
  const value = process.getuid?.();
  /* c8 ignore next -- flock only exists on platforms that provide getuid. */
  if (value === undefined) throw reviewLogFailure("Supervision review log owner is unavailable");
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** A single-line identifier: non-empty, no characters that could forge a record boundary. */
function usableText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\0\r\n]/u.test(value);
}

function safeCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function finiteMs(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function classification(value: unknown): value is ReviewClassification {
  return typeof value === "string" && (REVIEW_CLASSIFICATIONS as readonly string[]).includes(value);
}

function reason(value: unknown): value is SupervisionReason {
  return typeof value === "string" && (SUPERVISION_REASONS as readonly string[]).includes(value);
}

function disposition(value: unknown): value is SupervisionDisposition {
  return typeof value === "string" && (SUPERVISION_DISPOSITIONS as readonly string[]).includes(value);
}

function eventType(value: unknown): value is SupervisionEventType {
  return typeof value === "string" && (SUPERVISION_EVENT_TYPES as readonly string[]).includes(value);
}

/** An optional scalar is honestly null when absent and refuses the append when malformed. */
function probabilityOrNull(value: unknown): number | null {
  if (value === undefined) return null;
  if (!probability(value)) throw reviewLogFailure("Supervision review probabilities are untrusted");
  return value;
}

function counterOrNull(value: unknown): number | null {
  if (value === undefined) return null;
  if (!safeCounter(value)) throw reviewLogFailure("Supervision review log entry is untrusted");
  return value;
}

function msOrNull(value: unknown): number | null {
  if (value === undefined) return null;
  if (!finiteMs(value)) throw reviewLogFailure("Supervision review log entry is untrusted");
  return value;
}

function classificationOrNull(value: unknown): ReviewClassification | null {
  if (value === undefined) return null;
  if (!classification(value)) throw reviewLogFailure("Supervision review classification is untrusted");
  return value;
}

function reasonOrNull(value: unknown): SupervisionReason | null {
  if (value === undefined) return null;
  if (!reason(value)) throw reviewLogFailure("Supervision review reason is untrusted");
  return value;
}

function signalsOrNull(value: unknown): SupervisionSignalProbabilities | null {
  return value === undefined ? null : projectSignals(value);
}

function evidenceOrNull(value: unknown): SupervisionReviewEvidence | null {
  return value === undefined ? null : projectEvidence(value);
}

function textField(value: unknown): string {
  if (!usableText(value)) throw reviewLogFailure("Supervision review log entry is untrusted");
  return value;
}

function counterField(value: unknown): number {
  if (!safeCounter(value)) throw reviewLogFailure("Supervision review log entry is untrusted");
  return value;
}

function msField(value: unknown): number {
  if (!finiteMs(value)) throw reviewLogFailure("Supervision review log entry is untrusted");
  return value;
}

/**
 * The exact five-key signal contract: a foreign or missing key means the
 * object is not a signal set and the append is refused rather than silently
 * persisted incomplete.
 */
function projectSignals(value: unknown): SupervisionSignalProbabilities {
  if (!record(value) || Object.keys(value).length !== SIGNAL_KEYS.length) {
    throw reviewLogFailure("Supervision review signals are untrusted");
  }
  const signals = {} as SupervisionSignalProbabilities;
  for (const key of SIGNAL_KEYS) {
    const entry = value[key];
    if (!probability(entry)) throw reviewLogFailure("Supervision review signals are untrusted");
    signals[key] = entry;
  }
  return signals;
}

/** Rebuild one agent-session reference from allowlisted identifier fields. */
function projectAgentSession(value: unknown): AgentSessionRecord {
  if (!record(value)) throw reviewLogFailure("Supervision review evidence is untrusted");
  return {
    source: textField(value.source),
    agent: textField(value.agent),
    kind: textField(value.kind),
    value: textField(value.value),
  };
}

/** Rebuild the evidence cursors from allowlisted fields; extra keys are dropped, malformed ones refuse. */
function projectEvidence(value: unknown): SupervisionReviewEvidence {
  if (!record(value)) throw reviewLogFailure("Supervision review evidence is untrusted");
  return {
    paneId: textField(value.paneId),
    terminalId: textField(value.terminalId),
    ...(value.agentSession === undefined ? {} : { agentSession: projectAgentSession(value.agentSession) }),
    ...(value.revision === undefined ? {} : { revision: counterField(value.revision) }),
    ...(value.stateChangeSeq === undefined ? {} : { stateChangeSeq: counterField(value.stateChangeSeq) }),
    ...(value.transcriptLines === undefined ? {} : { transcriptLines: counterField(value.transcriptLines) }),
    ...(value.workingForMs === undefined ? {} : { workingForMs: msField(value.workingForMs) }),
  };
}

/** The identity fields every review-scoped record shares, validated once for the append. */
function reviewSubject(entry: unknown): { jobId: string; agentName: string; agentKind: string } {
  if (!record(entry)) throw reviewLogFailure("Supervision review log entry is untrusted");
  return {
    jobId: textField(entry.jobId),
    agentName: isAgentName(entry.agentName) ? entry.agentName : textField(undefined),
    agentKind: textField(entry.agentKind),
  };
}

function buildReviewRecord(entry: SupervisionReviewLogEntry, now: () => Date): SupervisionReviewLogRecord {
  const subject = reviewSubject(entry);
  if (!finiteMs(entry.atMs) || !classification(entry.classification) || typeof entry.attention !== "boolean") {
    throw reviewLogFailure("Supervision review log entry is untrusted");
  }
  return {
    type: "review",
    timestamp: now().toISOString(),
    ...subject,
    atMs: entry.atMs,
    classification: entry.classification,
    attention: entry.attention,
    signals: signalsOrNull(entry.signals),
    evidenceSufficiency: probabilityOrNull(entry.evidenceSufficiency),
    reason: reasonOrNull(entry.reason),
    lastMeaningfulProgressAtMs: msOrNull(entry.lastMeaningfulProgressAtMs),
    linesSinceLastReview: counterOrNull(entry.linesSinceLastReview),
    previousClassification: classificationOrNull(entry.previousClassification),
    evidence: evidenceOrNull(entry.evidence),
  };
}

function buildWakeRecord(entry: SupervisionReviewLogEntry, now: () => Date): SupervisionWakeLogRecord {
  const subject = reviewSubject(entry);
  const wake: unknown = entry.wake;
  if (!record(wake) || !usableText(wake.eventId) || !eventType(wake.eventType) || !finiteMs(wake.atMs)) {
    throw reviewLogFailure("Supervision wake log entry is untrusted");
  }
  return {
    type: "wake",
    timestamp: now().toISOString(),
    ...subject,
    eventId: wake.eventId,
    eventType: wake.eventType,
    classification: entry.classification,
    atMs: wake.atMs,
    reviewAtMs: entry.atMs,
    disposition: "unknown",
  };
}

function buildDispositionRecord(entry: SupervisionDispositionLogEntry, now: () => Date): SupervisionDispositionLogRecord {
  if (!record(entry) || !usableText(entry.jobId) || !usableText(entry.eventId) || !disposition(entry.disposition)) {
    throw reviewLogFailure("Supervision disposition log entry is untrusted");
  }
  const atMs = entry.atMs ?? now().getTime();
  if (!finiteMs(atMs)) throw reviewLogFailure("Supervision disposition log entry is untrusted");
  return {
    type: "disposition",
    timestamp: now().toISOString(),
    atMs,
    jobId: entry.jobId,
    eventId: entry.eventId,
    disposition: entry.disposition,
  };
}

/**
 * Serialize the built lines under one bounded flock section. Validation has
 * already completed: a failure past this point is transport-only — the lock
 * is released and the descriptor closed even on a write error.
 */
async function appendRecords(root: string, records: SupervisionLogRecord[], options: AppendReviewLogOptions): Promise<void> {
  const payload = records.map((item) => `${JSON.stringify(modelSafeJson(item))}\n`).join("");
  const paths = reviewLogPaths(root);
  await ensureLogDirectory(paths.directory);
  const holder = await acquireFlockHolder({
    lockPath: paths.lock,
    wait: { timeoutMs: options.waitMs ?? REVIEW_LOG_LOCK_WAIT_MS },
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    readyMarker: REVIEW_LOG_READY,
    subject: "Supervision review log",
    failure: reviewLogFailure
  });
  try {
    await appendLine(paths.reviews, payload);
  } finally {
    // A failed release cannot recall what the section already did, so the
    // lease settles quietly; the kernel frees the flock when the holder dies.
    await holder.release().catch(() => undefined);
  }
}

async function ensureLogDirectory(directory: string): Promise<void> {
  for (const path of [dirname(directory), directory]) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw reviewLogFailure("Supervision review log directory is unavailable");
    }
    let value;
    try {
      value = await lstat(path);
    } catch {
      throw reviewLogFailure("Supervision review log directory is unavailable");
    }
    assertOwnerOnlyDirectory(path, value, reviewLogFailure, "Supervision review log");
  }
}

/**
 * One bounded append: the target is lstat-rejected when unsafe or symlinked,
 * opened with `O_APPEND | O_NOFOLLOW` and `0600` on creation, then the opened
 * description itself is proven a regular owner-only file before the single
 * whole-line append. A failed write is surfaced; a partial trailing line is
 * never repaired by truncating another writer's data.
 */
async function appendLine(path: string, payload: string): Promise<void> {
  let target;
  try {
    target = await lstat(path);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw reviewLogFailure("Supervision review log is indeterminate");
  }
  if (target !== undefined && (!target.isFile() || target.isSymbolicLink() || target.uid !== uid() || (Number(target.mode) & 0o22) !== 0)) {
    throw reviewLogFailure("Supervision review log is not trusted");
  }
  /* c8 ignore next -- O_NOFOLLOW exists on every platform that ships flock. */
  const flags = constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);
  let file;
  try {
    file = await open(path, flags, 0o600);
  } catch {
    throw reviewLogFailure("Supervision review log is unavailable");
  }
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.uid !== uid() || (Number(opened.mode) & 0o22) !== 0) {
      throw reviewLogFailure("Supervision review log is not trusted");
    }
    await file.appendFile(payload);
  } finally {
    // A failed close cannot unwrite what the append already did; the section
    // promises no fsync, so close errors settle quietly like release errors.
    await file.close().catch(() => undefined);
  }
}

/**
 * Persist one completed supervision review — and, when the review woke the
 * manager, the wake's pending disposition — to the durable log. This fails
 * OPEN by design: callers treat `REVIEW_LOG_UNAVAILABLE` like a reviewer
 * failure (report, retry next cadence), because unlike the router decision
 * log's `ROUTER_LOG_UNAVAILABLE` launch veto, review telemetry is not a launch
 * precondition and a logging failure must never blind supervision or kill the
 * child.
 */
export async function appendSupervisionReview(entry: SupervisionReviewLogEntry, options: AppendReviewLogOptions): Promise<void> {
  try {
    if (!isAbsolute(options.root)) {
      throw reviewLogFailure("Supervision review log root is untrusted");
    }
    const now = options.now ?? (() => new Date());
    const records: SupervisionLogRecord[] = [buildReviewRecord(entry, now)];
    if (entry.wake !== undefined) records.push(buildWakeRecord(entry, now));
    await appendRecords(options.root, records, options);
  } catch (error) {
    if (error instanceof ReviewLogError) throw error;
    throw new ReviewLogError();
  }
}

/**
 * Record what a human did with a recorded wake. The manager appends one
 * disposition record per observation; readers resolve the effective
 * disposition as the latest `disposition` record for the wake's `eventId`,
 * staying `unknown` when none exists — never defaulting to `acted`.
 */
export async function appendSupervisionDisposition(entry: SupervisionDispositionLogEntry, options: AppendReviewLogOptions): Promise<void> {
  try {
    if (!isAbsolute(options.root)) {
      throw reviewLogFailure("Supervision review log root is untrusted");
    }
    const records: SupervisionLogRecord[] = [buildDispositionRecord(entry, options.now ?? (() => new Date()))];
    await appendRecords(options.root, records, options);
  } catch (error) {
    if (error instanceof ReviewLogError) throw error;
    throw new ReviewLogError();
  }
}
