/**
 * The ADR-036 per-runner trace-source seam.
 *
 * A supervision review pins the exact child identity first, then asks that
 * child's own structured trace — never another pane's — what happened since
 * the last completed review. The seam takes the pinned supervised
 * identity/session and an opaque prior cursor and returns one bounded,
 * deterministic window: a source label, the cursor range consumed, the event
 * records, the UTF-8 byte count, and an optional typed failure.
 *
 * The evidence hierarchy assigns each runner its source:
 *
 * - Pi reads its own `agent_session.kind = "path"` session JSONL directly.
 *   The file is a sequence of `JSON.stringify(entry) + "\n"` records. Reads
 *   are incremental from the prior cursor's byte offset, UTF-8-safe, and
 *   bounded to the 32 KiB trace budget; only newline-terminated records are
 *   events, so a writer's in-flight tail is never mistaken for a record.
 *   Because Pi can rewrite the file (compaction flush) or the path can be
 *   recycled, the cursor carries an anchor — the SHA-256 of the last KiB it
 *   consumed — which is re-verified on every continuation read. A mismatch is
 *   a typed `source_rewritten` failure, never a silently wrong window.
 *   Semantic compilation of those records is V2.2; this adapter emits the
 *   raw-but-bounded structured window.
 *
 * - Devin is keyed by `agent_session.kind = "id"`. The structured-session
 *   reader itself is T2; the seam already routes the runner, carries its
 *   opaque position, and enforces the byte bound on what it returns. Without
 *   an installed reader the answer is `adapter_unavailable` — a known
 *   structured source is never hidden behind terminal evidence.
 *
 * - Runners with no structured source (AGY, anything unknown) get bounded
 *   terminal evidence labelled `tmux-fallback`: the existing CLI `pane read`
 *   window plus the same delta rule the transcript reviewer already uses.
 *   Terminal scroll-off can discard scrolled lines, so a burst wider than the
 *   byte budget keeps the newest lines and leaves a leading offset gap —
 *   truncation is visible, never silent.
 *
 * Every failure is a typed value on the window (`events: []`, cursor
 * unadvanced), not an exception and never an empty window masquerading as
 * quiet. Diagnostics carry only offsets, counts, and fixed-vocabulary
 * reasons — never a file path or record content, so no secret-bearing text
 * can ride a failure into a log.
 */
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { deltaLines } from "../transcript-delta.js";
import type { AgentSessionRecord } from "./protocol.js";

export const TRACE_SOURCE_KINDS = ["pi-jsonl", "devin-session", "tmux-fallback"] as const;
export type TraceSourceKind = (typeof TRACE_SOURCE_KINDS)[number];

/** The ADR-036 trace-evidence budget: 32 KiB of UTF-8 per window. */
export const TRACE_WINDOW_MAX_BYTES = 32 * 1024;
/** The authoritative pane read and its fallback cursor retain at most this many lines. */
export const TRACE_FALLBACK_CURSOR_MAX_LINES = 100;
/** A fallback cursor may retain at most the MCP host's bounded text response. */
export const TRACE_FALLBACK_CURSOR_MAX_BYTES = 1024 * 1024;

/** How much of the consumed Pi stream a cursor re-verifies on continuation. */
const PI_CURSOR_ANCHOR_BYTES = 1024;
const NEWLINE = 0x0a;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * An opaque resumption marker minted by one source. Callers carry it verbatim
 * — they never construct or inspect it — and a source refuses a cursor it did
 * not mint rather than guessing at a position.
 */
export type TraceCursor =
  | { readonly source: "pi-jsonl"; readonly offset: number; readonly anchor: string }
  | { readonly source: "devin-session"; readonly position: unknown }
  | { readonly source: "tmux-fallback"; readonly window: string[] };

export interface TraceEvent {
  /** Source-typed discriminator: the Pi record's `type`, the Devin record's kind, or `terminal-line`. */
  kind: string;
  /**
   * Source-relative position: the record's byte offset for structured sources;
   * the line's index within the computed delta for the terminal fallback, so a
   * leading gap marks exactly the lines the byte budget dropped.
   */
  offset: number;
  /** UTF-8 bytes the raw record occupies in its source, newline included. */
  bytes: number;
  /** The raw bounded record: the parsed JSON object for structured sources, the line text for the fallback. */
  record: unknown;
}

export type TraceFailureKind =
  /** No reader is wired for the selected source — including a Devin adapter T2 has not installed. */
  | "adapter_unavailable"
  /** A structured-source runner's session record cannot key its source. */
  | "session_pointer_invalid"
  /** The reader or filesystem refused the source. */
  | "source_unreadable"
  /** Structured bytes violate the source's format (UTF-8, JSON, record shape). */
  | "source_malformed"
  /** A source document exceeds its adapter's bounded read ceiling. */
  | "source_exceeds_budget"
  /** The cursor's anchor no longer matches the file: truncated, replaced, or rewritten. */
  | "source_rewritten"
  /** One source record alone can never fit inside the trace budget. */
  | "record_exceeds_budget"
  /** An adapter's returned window is outside the trace budget. */
  | "window_exceeds_budget"
  /** The prior cursor was minted by a different source. */
  | "cursor_mismatch"
  /** The prior cursor fails this source's own validation. */
  | "cursor_malformed"
  /** The read's signal aborted mid-flight. */
  | "aborted";

export interface TraceFailure {
  kind: TraceFailureKind;
  /** Bounded, path-free detail: offsets, counts, fixed reasons. Never a path or record content. */
  detail?: Record<string, string | number | boolean>;
}

export interface TraceWindow {
  source: TraceSourceKind;
  cursorFrom: TraceCursor | undefined;
  cursorTo: TraceCursor | undefined;
  events: TraceEvent[];
  byteCount: number;
  typedFailure?: TraceFailure;
}

/**
 * The minimum identity the seam needs. `SupervisedIdentity` satisfies it; a
 * reduced-assurance provisional binding (no session yet) selects the fallback
 * like any other runner without a structured source.
 */
export interface TraceSourceIdentity {
  paneId: string;
  agentKind: string;
  agentSession?: AgentSessionRecord;
}

/** Bounded byte-range read of a structured source file; returns fewer than `maxBytes` at EOF. */
export type TraceFileRangeReader = (path: string, offset: number, maxBytes: number, signal: AbortSignal) => Promise<Uint8Array>;

/** The existing bounded terminal read — the CLI's authoritative `pane read`. */
export type TraceTerminalReader = (paneId: string, signal: AbortSignal) => Promise<string[]>;

/**
 * What the T2 Devin adapter returns. The seam computes `byteCount` itself and
 * validates the event shape, so the budget cannot be misreported.
 */
export interface DevinSessionRead {
  position: unknown;
  events: TraceEvent[];
  /**
   * Set when the window's first step alone exceeds the budget: `position` is
   * already past it and `events` is empty. The seam reports the typed
   * `record_exceeds_budget` failure with the advanced cursor so the next
   * cadence resumes after the step instead of refusing it forever.
   */
  skipped?: { step: number; bytes: number };
}

export type DevinSessionReader = (sessionId: string, position: unknown, signal: AbortSignal) => Promise<DevinSessionRead>;

/**
 * The failure kinds a Devin reader may raise from inside its own source. The
 * seam owns routing, cursor labels, the window budget, and abort; the reader
 * can only describe its source and its own cursor.
 */
export type DevinSourceFailureKind = Extract<
  TraceFailureKind,
  "session_pointer_invalid" | "source_malformed" | "source_exceeds_budget" | "source_rewritten" | "record_exceeds_budget" | "cursor_malformed"
>;

/**
 * A typed failure raised inside the Devin reader. The seam maps it to the
 * matching window failure verbatim — a malformed or rewritten Devin source is
 * never mislabelled an I/O failure and never degrades to terminal evidence.
 * `detail` carries the same path-free contract as `TraceFailure.detail`.
 */
export class DevinSourceError extends Error {
  constructor(
    readonly failure: DevinSourceFailureKind,
    readonly detail?: Record<string, string | number | boolean>,
  ) {
    super(`devin-session source failure: ${failure}`);
    this.name = "DevinSourceError";
  }
}

export interface TraceSourceDeps {
  readFileRange?: TraceFileRangeReader;
  readTerminal?: TraceTerminalReader;
  /** The T2 plug point: a Devin structured-session reader. Absent → `adapter_unavailable`. */
  devinSession?: DevinSessionReader;
}

export interface TraceSource {
  /** The source this identity's runner selects — before any session pointer is judged. */
  select(identity: TraceSourceIdentity): TraceSourceKind;
  /**
   * Read the bounded window following `prior`. Never rejects: every failure is
   * a typed value on the returned window with `events: []` and the cursor
   * unadvanced, so a failed read can never pass for a quiet one.
   */
  read(identity: TraceSourceIdentity, prior: TraceCursor | undefined, signal: AbortSignal): Promise<TraceWindow>;
}

/** Per-runner source selection (ADR-036): Pi and Devin are structured; every other runner is terminal fallback. */
export function selectTraceSource(identity: TraceSourceIdentity): TraceSourceKind {
  if (identity.agentKind === "pi") return "pi-jsonl";
  if (identity.agentKind === "devin") return "devin-session";
  return "tmux-fallback";
}

/** The production file reader: one open/read/close, bounded by `maxBytes`. */
export function createNodeFileReader(): TraceFileRangeReader {
  return async (path, offset, maxBytes) => {
    const handle = await open(path, "r");
    try {
      const data = new Uint8Array(maxBytes);
      const { bytesRead } = await handle.read(data, 0, maxBytes, offset);
      return data.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  };
}

function failure(source: TraceSourceKind, cursorFrom: TraceCursor | undefined, kind: TraceFailureKind, detail?: TraceFailure["detail"]): TraceWindow {
  return { source, cursorFrom, cursorTo: cursorFrom, events: [], byteCount: 0, typedFailure: { kind, ...(detail === undefined ? {} : { detail }) } };
}

/**
 * The only field an I/O error may contribute to a diagnostic. Codes are
 * vocabulary (`ENOENT`, `SUPERVISION_PROTOCOL_ERROR`); anything carrying
 * spaces, slashes, or length is a message and is dropped — messages can hold
 * paths and content.
 */
function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[\w.-]{1,64}$/.test(code) ? code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type TerminalWindowIssue =
  | { kind: "malformed" }
  | { kind: "line_exceeds_budget"; offset: number; bytes?: number }
  | { kind: "window_exceeds_budget"; lines?: number; bytes?: number };

/** Validate before delta matching or cursor hashing; every byte scan is itself bounded. */
function terminalWindowIssue(value: unknown): TerminalWindowIssue | undefined {
  if (!Array.isArray(value)) return { kind: "malformed" };
  if (value.length > TRACE_FALLBACK_CURSOR_MAX_LINES) return { kind: "window_exceeds_budget", lines: value.length };
  let total = 0;
  for (let offset = 0; offset < value.length; offset += 1) {
    const line = value[offset];
    if (typeof line !== "string") return { kind: "malformed" };
    // UTF-8 cannot be shorter than UTF-16 code units. Reject this cheap case
    // before asking Buffer to scan a hostile, arbitrarily large string.
    if (line.length > TRACE_WINDOW_MAX_BYTES) return { kind: "line_exceeds_budget", offset };
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > TRACE_WINDOW_MAX_BYTES) return { kind: "line_exceeds_budget", offset, bytes };
    total += bytes;
    if (total > TRACE_FALLBACK_CURSOR_MAX_BYTES) return { kind: "window_exceeds_budget", bytes: total };
  }
  return undefined;
}

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

type PiCursor = { offset: number; anchor: string };

/** Validate a cursor this source minted; anything else fails closed. */
function piPrior(prior: TraceCursor): PiCursor | "malformed" {
  const cursor = prior as { offset?: unknown; anchor?: unknown };
  if (!Number.isSafeInteger(cursor.offset) || (cursor.offset as number) < 0) return "malformed";
  const offset = cursor.offset as number;
  if (offset === 0) return { offset: 0, anchor: "" };
  if (typeof cursor.anchor !== "string" || !/^[0-9a-f]{64}$/.test(cursor.anchor)) return "malformed";
  return { offset, anchor: cursor.anchor };
}

async function readPi(identity: TraceSourceIdentity, prior: TraceCursor | undefined, deps: TraceSourceDeps, signal: AbortSignal): Promise<TraceWindow> {
  const source: TraceSourceKind = "pi-jsonl";
  const from = prior === undefined ? { offset: 0, anchor: "" } : piPrior(prior);
  if (from === "malformed") return failure(source, prior, "cursor_malformed");
  const session = identity.agentSession;
  if (session === undefined || session.kind !== "path") {
    return failure(source, prior, "session_pointer_invalid", { reason: session === undefined ? "session_absent" : "kind_not_path" });
  }
  const path = session.value;
  if (!isAbsolute(path)) return failure(source, prior, "session_pointer_invalid", { reason: "path_not_absolute" });
  const reader = deps.readFileRange;
  if (reader === undefined) return failure(source, prior, "adapter_unavailable");

  // One contiguous read: the cursor's anchor region followed by up to one
  // budget of new bytes. A file truncated below the anchor returns short and
  // fails the check exactly like a rewrite does.
  const span = Math.min(PI_CURSOR_ANCHOR_BYTES, from.offset);
  const bufferStart = from.offset - span;
  let buffer: Uint8Array;
  try {
    buffer = await reader(path, bufferStart, span + TRACE_WINDOW_MAX_BYTES, signal);
  } catch (error) {
    const code = errorCode(error);
    return failure(source, prior, "source_unreadable", code === undefined ? undefined : { code });
  }
  if (signal.aborted) return failure(source, prior, "aborted");
  if (span > 0 && (buffer.length < span || sha256Hex(buffer.subarray(0, span)) !== from.anchor)) {
    return failure(source, prior, "source_rewritten");
  }
  const body = buffer.subarray(span);

  const events: TraceEvent[] = [];
  let position = from.offset;
  let index = 0;
  while (index < body.length) {
    const newline = body.indexOf(NEWLINE, index);
    if (newline === -1) break;
    // The buffer itself is the byte bound: a complete line inside it fits the
    // window by construction, and an unterminated tail is deferred whole.
    const bytes = newline - index + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(utf8.decode(body.subarray(index, newline)));
    } catch {
      return failure(source, prior, "source_malformed", { offset: position });
    }
    if (!isRecord(parsed) || typeof parsed.type !== "string" || parsed.type.length === 0) {
      return failure(source, prior, "source_malformed", { offset: position });
    }
    events.push({ kind: parsed.type, offset: position, bytes, record: parsed });
    index = newline + 1;
    position += bytes;
  }
  // A record whose terminator lies beyond a full window can never fit one, at
  // this cadence or any later one. Report it once and step the cursor past it,
  // or every subsequent cadence re-refuses the same offset and reviews stay
  // dark for the rest of the run. A record still unterminated at EOF is being
  // written; it keeps the cursor pinned until it lands.
  if (index === 0 && body.length === TRACE_WINDOW_MAX_BYTES) {
    const skipped = await skipOversizedPiRecord(reader, path, from.offset + body.length, buffer.subarray(Math.max(0, buffer.length - PI_CURSOR_ANCHOR_BYTES)), signal);
    if (skipped === "unreadable") return failure(source, prior, "source_unreadable");
    if (signal.aborted) return failure(source, prior, "aborted");
    if (skipped === undefined) return failure(source, prior, "record_exceeds_budget", { offset: position, bytes: body.length });
    return {
      ...failure(source, prior, "record_exceeds_budget", { offset: position, bytes: skipped.end - position, skipped: true }),
      cursorTo: { source, offset: skipped.end, anchor: sha256Hex(skipped.tail) },
    };
  }

  const cursorTo: TraceCursor = {
    source,
    offset: position,
    anchor: position === 0 ? "" : sha256Hex(buffer.subarray(Math.max(bufferStart, position - PI_CURSOR_ANCHOR_BYTES) - bufferStart, position - bufferStart)),
  };
  return { source, cursorFrom: prior, cursorTo, events, byteCount: position - from.offset };
}

/** Forward scan while stepping over an oversized record; larger than a window so a multi-megabyte record costs few reads. */
const PI_SKIP_SCAN_CHUNK_BYTES = 1024 * 1024;

/**
 * Find the terminator of the oversized record that starts before `scanFrom`.
 * Returns the offset just past its newline together with the ≤1 KiB of bytes
 * preceding that offset (the next cursor's anchor), `undefined` when the file
 * ends first, or `"unreadable"` when the reader refuses.
 */
async function skipOversizedPiRecord(
  reader: TraceFileRangeReader,
  path: string,
  scanFrom: number,
  tail: Uint8Array,
  signal: AbortSignal,
): Promise<{ end: number; tail: Uint8Array } | "unreadable" | undefined> {
  let offset = scanFrom;
  let recent = tail;
  for (;;) {
    if (signal.aborted) return undefined;
    let chunk: Uint8Array;
    try {
      chunk = await reader(path, offset, PI_SKIP_SCAN_CHUNK_BYTES, signal);
    } catch {
      return "unreadable";
    }
    const newline = chunk.indexOf(NEWLINE);
    if (newline !== -1) {
      const joined = concatBytes(recent, chunk.subarray(0, newline + 1));
      return { end: offset + newline + 1, tail: joined.subarray(Math.max(0, joined.length - PI_CURSOR_ANCHOR_BYTES)) };
    }
    if (chunk.length < PI_SKIP_SCAN_CHUNK_BYTES) return undefined;
    const joined = concatBytes(recent, chunk);
    recent = joined.subarray(Math.max(0, joined.length - PI_CURSOR_ANCHOR_BYTES));
    offset += chunk.length;
  }
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

function validEvent(value: unknown): value is TraceEvent {
  if (!isRecord(value)) return false;
  return typeof value.kind === "string"
    && Number.isSafeInteger(value.offset) && (value.offset as number) >= 0
    && Number.isSafeInteger(value.bytes) && (value.bytes as number) >= 0
    && Object.prototype.hasOwnProperty.call(value, "record");
}

async function readDevin(identity: TraceSourceIdentity, prior: TraceCursor | undefined, deps: TraceSourceDeps, signal: AbortSignal): Promise<TraceWindow> {
  const source: TraceSourceKind = "devin-session";
  const session = identity.agentSession;
  if (session === undefined || session.kind !== "id") {
    return failure(source, prior, "session_pointer_invalid", { reason: session === undefined ? "session_absent" : "kind_not_id" });
  }
  const reader = deps.devinSession;
  if (reader === undefined) return failure(source, prior, "adapter_unavailable");
  let result: DevinSessionRead;
  try {
    result = await reader(session.value, prior === undefined ? undefined : (prior as { position?: unknown }).position, signal);
  } catch (error) {
    if (signal.aborted) return failure(source, prior, "aborted");
    if (error instanceof DevinSourceError) return failure(source, prior, error.failure, error.detail);
    const code = errorCode(error);
    return failure(source, prior, "source_unreadable", code === undefined ? undefined : { code });
  }
  if (signal.aborted) return failure(source, prior, "aborted");
  if (!isRecord(result) || !Array.isArray(result.events) || result.events.some((event) => !validEvent(event))) {
    return failure(source, prior, "source_malformed", { reason: "adapter_window" });
  }
  const byteCount = result.events.reduce((total, event) => total + event.bytes, 0);
  if (byteCount > TRACE_WINDOW_MAX_BYTES) {
    return failure(source, prior, "window_exceeds_budget", { bytes: byteCount });
  }
  if (result.skipped !== undefined) {
    const { step, bytes } = result.skipped;
    if (result.events.length !== 0 || !Number.isSafeInteger(step) || !Number.isSafeInteger(bytes)) {
      return failure(source, prior, "source_malformed", { reason: "adapter_window" });
    }
    return {
      ...failure(source, prior, "record_exceeds_budget", { step, bytes, skipped: true }),
      cursorTo: { source, position: result.position },
    };
  }
  return {
    source,
    cursorFrom: prior,
    cursorTo: { source, position: result.position },
    events: result.events,
    byteCount,
  };
}

async function readTerminalWindow(identity: TraceSourceIdentity, prior: TraceCursor | undefined, deps: TraceSourceDeps, signal: AbortSignal): Promise<TraceWindow> {
  const source: TraceSourceKind = "tmux-fallback";
  let previous: string[] = [];
  if (prior !== undefined) {
    const window = (prior as { window?: unknown }).window;
    if (terminalWindowIssue(window) !== undefined) {
      // Do not return the hostile payload as either cursor: the digest hashes
      // returned cursors, so carrying it would defeat validation-before-hash.
      return failure(source, undefined, "cursor_malformed");
    }
    previous = window as string[];
  }
  const reader = deps.readTerminal;
  if (reader === undefined) return failure(source, prior, "adapter_unavailable");
  let lines: string[];
  try {
    lines = await reader(identity.paneId, signal);
  } catch (error) {
    const code = errorCode(error);
    return failure(source, prior, "source_unreadable", code === undefined ? undefined : { code });
  }
  if (signal.aborted) return failure(source, prior, "aborted");
  const issue = terminalWindowIssue(lines);
  if (issue?.kind === "malformed") {
    return failure(source, prior, "source_unreadable", { reason: "window_malformed" });
  }
  if (issue?.kind === "line_exceeds_budget") {
    return failure(source, prior, "record_exceeds_budget", {
      offset: issue.offset,
      ...(issue.bytes === undefined ? {} : { bytes: issue.bytes }),
    });
  }
  if (issue?.kind === "window_exceeds_budget") {
    return failure(source, prior, "window_exceeds_budget", {
      ...(issue.lines === undefined ? {} : { lines: issue.lines }),
      ...(issue.bytes === undefined ? {} : { bytes: issue.bytes }),
    });
  }
  // Same delta rule the transcript reviewer already applies, now inside the
  // seam. Terminal scroll-off cannot be re-read, so an over-budget delta keeps
  // the newest lines; the first emitted `offset` counts what was dropped.
  const delta = deltaLines(previous, lines);
  let byteCount = 0;
  let first = delta.length;
  while (first > 0) {
    const bytes = Buffer.byteLength(delta[first - 1]!, "utf8");
    if (byteCount + bytes > TRACE_WINDOW_MAX_BYTES) break;
    byteCount += bytes;
    first -= 1;
  }
  const events = delta.slice(first).map((line, index) => ({
    kind: "terminal-line",
    offset: first + index,
    bytes: Buffer.byteLength(line, "utf8"),
    record: line,
  }));
  return { source, cursorFrom: prior, cursorTo: { source, window: lines }, events, byteCount };
}

export function createTraceSource(deps: TraceSourceDeps): TraceSource {
  return {
    select: selectTraceSource,
    async read(identity, prior, signal) {
      const source = selectTraceSource(identity);
      if (prior !== undefined && prior.source !== source) {
        return failure(source, prior, "cursor_mismatch", { cursorSource: prior.source });
      }
      switch (source) {
        case "pi-jsonl": return readPi(identity, prior, deps, signal);
        case "devin-session": return readDevin(identity, prior, deps, signal);
        case "tmux-fallback": return readTerminalWindow(identity, prior, deps, signal);
      }
    },
  };
}
