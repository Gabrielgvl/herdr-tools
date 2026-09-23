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
 * count, the evidence cursors the review pinned (pane, terminal, agent
 * session, pane revision, lifecycle sequence, consumed transcript window,
 * working time), and bounded ADR-036 provenance — the evidence's
 * representation label, trace source, cursor labels, trace/workspace content
 * hashes, byte counts, and the version-identity hash. An attention wake
 * additionally appends a `wake` record whose `disposition` is honestly
 * `unknown`; a manager-observed disposition is a `disposition` record
 * appended through the same file by `appendSupervisionDisposition`,
 * superseding by `eventId` — latest wins, and absent never defaults to
 * "acted". A cadence whose Tier-0 checks fire appends one `violation` record
 * per emitted wake instead — a closed violation kind, the wake's bounded
 * detail scalars, and the cadence's provenance — carrying no classification
 * or probability fields at all, because a deterministic code finding never
 * passed through Jev. Its `disposition` supersedes by `eventId` exactly like
 * a review wake's. No raw transcript, no caller prose, and no reviewer
 * summary text reaches the file.
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
import { TRACE_SOURCE_KINDS, type TraceSourceKind } from "./trace-source.js";

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

const PROVENANCE_LABEL_MAX_CHARS = 256;
const PROVENANCE_LABEL_PATTERN = /^(?:pi-jsonl|devin-session|tmux-fallback)(?:@[0-9]+)?:[0-9a-f]{64}$/u;
const VIOLATION_BATCH_MAX = 16;
const VIOLATION_DETAIL_MAX_KEYS = 16;
const VIOLATION_DETAIL_KEY_MAX_CHARS = 64;
const VIOLATION_DETAIL_VALUE_MAX_CHARS = 256;

/** What a human did with an attention wake, as far as was observable. */
export const SUPERVISION_DISPOSITIONS = ["acknowledged", "acted", "overruled", "unknown"] as const;
export type SupervisionDisposition = (typeof SUPERVISION_DISPOSITIONS)[number];

/**
 * The closed representation vocabulary the ADR-036 three-way study measures:
 * `A-tmux-lines` is the bounded terminal fallback, `B-runner-trace` is the
 * runner's own structured trace, and `C-vcc-supervision-view` is the future
 * VCC representation. C is a measurement hook only — the schema admits the
 * label so a later pipeline can be persisted and compared, but no V2.1 source
 * maps to it and no C record is ever fabricated.
 */
export const SUPERVISION_REPRESENTATIONS = ["A-tmux-lines", "B-runner-trace", "C-vcc-supervision-view"] as const;
export type SupervisionRepresentation = (typeof SUPERVISION_REPRESENTATIONS)[number];

/** V2.1's representation mapping: the terminal fallback is A; every structured runner trace is B. Never C. */
export function representationForTraceSource(source: TraceSourceKind): SupervisionRepresentation {
  return source === "tmux-fallback" ? "A-tmux-lines" : "B-runner-trace";
}

/**
 * The closed Tier-0 violation vocabulary (ADR-036 W1): deterministic code
 * facts detected before any model call. A kind not in this set is not a
 * known violation, and the append refuses rather than persists an unbounded
 * claim.
 */
export const SUPERVISION_TIER0_VIOLATIONS = [
  "read_only_dirty_workspace",
  "evidence_budget_exceeded",
  "process_exit",
] as const;
export type SupervisionTier0Violation = (typeof SUPERVISION_TIER0_VIOLATIONS)[number];

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

/**
 * Bounded trace/workspace provenance for one persisted record (ADR-036 M1):
 * which representation the evidence took, the digest's cursor refs as
 * `source@position:hash` labels, the trace-digest and workspace content
 * hashes, the byte counts the assembled state carried, and the
 * version-identity hash it was judged under. Every field is a closed label,
 * a bounded count, or a SHA-256 hex digest — provenance, never raw evidence.
 * Fields are `null` when the cadence honestly had none: no cursor on that
 * side, an unavailable workspace, a refused build, a reviewer that reported
 * no provenance.
 */
export interface SupervisionLogProvenance {
  /** Which evidence source produced the trace window. */
  traceSource: TraceSourceKind;
  /** The closed A/B/C representation label; V2.1 supplies only A or B. */
  representation: SupervisionRepresentation;
  /** Digest cursor labels (`source@position:hash`); null when the window had no cursor on that side. */
  traceFromCursor: string | null;
  traceToCursor: string | null;
  /** SHA-256 over the evaluated trace digest's canonical bytes. */
  traceDigestHash: string | null;
  /** The workspace fingerprint; null when the cadence's view was unavailable. */
  workspaceFingerprint: string | null;
  /** UTF-8 bytes of the assembled state and its terminal section; null when no state was built. */
  stateBytes: number | null;
  terminalBytes: number | null;
  /** The version-identity hash the record was judged under. */
  identityHash: string | null;
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
  /** Bounded provenance for the evidence the review ran on; absent only from callers that never assembled a state. */
  provenance?: SupervisionLogProvenance;
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
  provenance: SupervisionLogProvenance | null;
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

/**
 * One Tier-0 violation as the supervisor supplies it: the emitted wake's
 * identity plus its closed kind and bounded detail scalars, verbatim from the
 * event the host already saw.
 */
export interface SupervisionViolationItem {
  eventId: string;
  eventType: SupervisionEventType;
  atMs: number;
  violation: SupervisionTier0Violation;
  /** The emitted event's bounded detail scalars, verbatim. */
  details?: Record<string, string | number | boolean>;
}

/**
 * The allowlisted entry for one Tier-0 violation cadence: one `violation`
 * record per emitted wake, all sharing the cadence's bounded provenance.
 */
export interface SupervisionViolationLogEntry {
  jobId: string;
  agentName: string;
  agentKind: string;
  provenance: SupervisionLogProvenance;
  violations: SupervisionViolationItem[];
}

/**
 * The fixed `violation` record schema: one record per Tier-0 wake. It has no
 * classification, signals, reason, or sufficiency fields at all — a
 * deterministic code finding can never read as Jev output. `disposition`
 * stays `unknown` until a `disposition` record supersedes it by `eventId`,
 * exactly like a review wake.
 */
export interface SupervisionViolationLogRecord {
  type: "violation";
  timestamp: string;
  jobId: string;
  agentName: string;
  agentKind: string;
  eventId: string;
  eventType: SupervisionEventType;
  atMs: number;
  disposition: SupervisionDisposition;
  violation: SupervisionTier0Violation;
  details: Record<string, string | number | boolean> | null;
  provenance: SupervisionLogProvenance;
}

export type SupervisionLogRecord =
  | SupervisionReviewLogRecord
  | SupervisionWakeLogRecord
  | SupervisionDispositionLogRecord
  | SupervisionViolationLogRecord;

/**
 * What the append seam accepts: a completed review (plus its wake), or a
 * cadence's Tier-0 violation batch. Dispatched on the `violations` field.
 */
export type SupervisionLogEntry = SupervisionReviewLogEntry | SupervisionViolationLogEntry;

export interface AppendReviewLogOptions {
  root: string;
  now?: () => Date;
  waitMs?: number;
  deadlineMs?: number;
}

/** The review-log append seam `SupervisorDependencies` consumes; `appendSupervisionReview` satisfies it directly. */
export type SupervisionReviewLog = (entry: SupervisionLogEntry, options: AppendReviewLogOptions) => Promise<void>;

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

function traceSourceKind(value: unknown): TraceSourceKind {
  if (typeof value !== "string" || !(TRACE_SOURCE_KINDS as readonly string[]).includes(value)) {
    throw reviewLogFailure("Supervision log provenance is untrusted");
  }
  return value as TraceSourceKind;
}

function representationKind(value: unknown): SupervisionRepresentation {
  if (typeof value !== "string" || !(SUPERVISION_REPRESENTATIONS as readonly string[]).includes(value)) {
    throw reviewLogFailure("Supervision log provenance is untrusted");
  }
  return value as SupervisionRepresentation;
}

/** A valid provenance cursor label, or an honest null when the label is absent or malformed. */
function provenanceLabelOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (!usableText(value) || value.length > PROVENANCE_LABEL_MAX_CHARS || !PROVENANCE_LABEL_PATTERN.test(value)) return null;
  return value;
}

/** A SHA-256 hex digest or an honest null. */
function provenanceHashOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw reviewLogFailure("Supervision log provenance is untrusted");
  }
  return value;
}

function provenanceCounterOrNull(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!safeCounter(value)) throw reviewLogFailure("Supervision log provenance is untrusted");
  return value;
}

/** Rebuild the bounded provenance block from its allowlisted fields; a malformed one refuses the append. */
function projectProvenance(value: unknown): SupervisionLogProvenance {
  if (!record(value)) throw reviewLogFailure("Supervision log provenance is untrusted");
  return {
    traceSource: traceSourceKind(value.traceSource),
    representation: representationKind(value.representation),
    traceFromCursor: provenanceLabelOrNull(value.traceFromCursor),
    traceToCursor: provenanceLabelOrNull(value.traceToCursor),
    traceDigestHash: provenanceHashOrNull(value.traceDigestHash),
    workspaceFingerprint: provenanceHashOrNull(value.workspaceFingerprint),
    stateBytes: provenanceCounterOrNull(value.stateBytes),
    terminalBytes: provenanceCounterOrNull(value.terminalBytes),
    identityHash: provenanceHashOrNull(value.identityHash),
  };
}

function provenanceOrNull(value: unknown): SupervisionLogProvenance | null {
  return value === undefined || value === null ? null : projectProvenance(value);
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
    provenance: provenanceOrNull(entry.provenance),
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

/** One review record plus its wake record when the review woke the manager. */
function buildReviewRecords(entry: SupervisionReviewLogEntry, now: () => Date): SupervisionLogRecord[] {
  const records: SupervisionLogRecord[] = [buildReviewRecord(entry, now)];
  if (entry.wake !== undefined) records.push(buildWakeRecord(entry, now));
  return records;
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
 * Rebuild a violation's typed detail dict: bounded keys and bounded scalar
 * values only — the same contract the emitted event's `details` already
 * enforces. A nested object, an over-long string, or a forged key refuses the
 * append rather than persisting unbounded evidence.
 */
function projectViolationDetails(value: unknown): Record<string, string | number | boolean> | null {
  if (value === undefined || value === null) return null;
  if (!record(value)) throw reviewLogFailure("Supervision violation log entry is untrusted");
  const entries = Object.entries(value);
  if (entries.length > VIOLATION_DETAIL_MAX_KEYS) throw reviewLogFailure("Supervision violation log entry is untrusted");
  const details: Record<string, string | number | boolean> = {};
  for (const [key, item] of entries) {
    if (!usableText(key) || key.length > VIOLATION_DETAIL_KEY_MAX_CHARS) {
      throw reviewLogFailure("Supervision violation log entry is untrusted");
    }
    if (typeof item === "boolean") {
      details[key] = item;
      continue;
    }
    if (typeof item === "number" && Number.isFinite(item)) {
      details[key] = item;
      continue;
    }
    if (typeof item === "string" && usableText(item) && item.length <= VIOLATION_DETAIL_VALUE_MAX_CHARS) {
      details[key] = item;
      continue;
    }
    throw reviewLogFailure("Supervision violation log entry is untrusted");
  }
  return details;
}

function violationKind(value: unknown): SupervisionTier0Violation {
  if (typeof value !== "string" || !(SUPERVISION_TIER0_VIOLATIONS as readonly string[]).includes(value)) {
    throw reviewLogFailure("Supervision violation log entry is untrusted");
  }
  return value as SupervisionTier0Violation;
}

function buildViolationRecord(
  item: unknown,
  subject: { jobId: string; agentName: string; agentKind: string },
  provenance: SupervisionLogProvenance,
  now: () => Date
): SupervisionViolationLogRecord {
  if (!record(item) || !usableText(item.eventId) || !eventType(item.eventType) || !finiteMs(item.atMs)) {
    throw reviewLogFailure("Supervision violation log entry is untrusted");
  }
  return {
    type: "violation",
    timestamp: now().toISOString(),
    ...subject,
    eventId: item.eventId,
    eventType: item.eventType,
    atMs: item.atMs,
    disposition: "unknown",
    violation: violationKind(item.violation),
    details: projectViolationDetails(item.details),
    provenance,
  };
}

/**
 * Build one record per emitted Tier-0 wake. The batch is bounded — a cadence
 * emits at most a handful of violations — and every record carries the same
 * provenance block so the join needs no inference.
 */
function buildViolationRecords(entry: unknown, now: () => Date): SupervisionLogRecord[] {
  const subject = reviewSubject(entry);
  const provenance = projectProvenance((entry as SupervisionViolationLogEntry).provenance);
  const violations: unknown = (entry as SupervisionViolationLogEntry).violations;
  if (!Array.isArray(violations) || violations.length === 0 || violations.length > VIOLATION_BATCH_MAX) {
    throw reviewLogFailure("Supervision violation log entry is untrusted");
  }
  return violations.map((item) => buildViolationRecord(item, subject, provenance, now));
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
 * manager, the wake's pending disposition — or a cadence's Tier-0 violation
 * batch, to the durable log. This fails OPEN by design: callers treat
 * `REVIEW_LOG_UNAVAILABLE` like a reviewer failure (report, retry next
 * cadence), because unlike the router decision log's `ROUTER_LOG_UNAVAILABLE`
 * launch veto, review telemetry is not a launch precondition and a logging
 * failure must never blind supervision or kill the child.
 */
export async function appendSupervisionReview(entry: SupervisionLogEntry, options: AppendReviewLogOptions): Promise<void> {
  try {
    if (!isAbsolute(options.root)) {
      throw reviewLogFailure("Supervision review log root is untrusted");
    }
    const now = options.now ?? (() => new Date());
    const records: SupervisionLogRecord[] = record(entry) && "violations" in entry
      ? buildViolationRecords(entry, now)
      : buildReviewRecords(entry as SupervisionReviewLogEntry, now);
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
