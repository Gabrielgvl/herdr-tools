/**
 * The ADR-036 Devin structured-session reader (T2).
 *
 * Devin persists each local session as one JSON document at
 * `$XDG_DATA_HOME/devin/cli/transcripts/<session_id>.json` (default
 * `~/.local/share/devin/cli/transcripts/`), rewritten atomically per turn in
 * ATIF (`schema_version` `ATIF-v1.x`). The document's `steps` array is the
 * trace: each step carries `step_id` (1..N sequential), `timestamp`, `source`
 * (`system` | `user` | `agent`), and `message`; agent steps add `tool_calls`
 * (`tool_call_id`, `function_name`, `arguments`), an `observation.results`
 * list keyed back to each call by `source_call_id`, per-step `metrics`, and
 * `model_name`. The document's own `session_id` must equal the requested id —
 * a record filed under one id that declares another is malformed for that key.
 *
 * The reader emits one `TraceEvent` per step, raw: `kind` is the step's
 * `source`, `offset` its `step_id` (ATIF's own positional identity — the index
 * `/steps`, `/revert`, and `/fork` address), and `bytes` the UTF-8 size of the
 * record's canonical serialization — what it contributes to the 32 KiB window,
 * since a whole-document format has no per-record file offsets.
 *
 * The cursor is `{session, steps, anchor}`: the session the position belongs
 * to, how many steps were consumed, and the SHA-256 over the consumed steps'
 * canonical serializations. Each continuation re-reads the document through a
 * fixed source ceiling and re-verifies the consumed prefix, so a `/revert`
 * rewind, a compaction rewrite, or a recycled record fails `source_rewritten`
 * instead of emitting a silently wrong window. The anchor covers every
 * consumed step — strictly stronger than the Pi cursor's bounded tail anchor.
 *
 * Failures are typed, never hidden: an I/O throw rides the seam's
 * `source_unreadable` mapping, and a `DevinSourceError` carries the exact kind
 * — `source_malformed`, `source_exceeds_budget`, `source_rewritten`,
 * `record_exceeds_budget`, `cursor_malformed`, `session_pointer_invalid` — so a
 * broken Devin source can never masquerade as a quiet window or degrade to
 * terminal evidence.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createNodeFileReader,
  DevinSourceError,
  TRACE_WINDOW_MAX_BYTES,
  type DevinSessionReader,
  type TraceEvent,
} from "./trace-source.js";

/** The largest ATIF source document the adapter will allocate and parse. */
export const DEVIN_SOURCE_MAX_BYTES = 8 * 1024 * 1024;

/** Injectable storage seam: where records live and how bounded bytes are read. */
export interface DevinTraceDeps {
  /** Record directory override; production resolves Devin's data dir. */
  transcriptsDir?: string;
  /** Read at most `maxBytes` from the start of one source file. */
  readFile?: (path: string, maxBytes: number, signal: AbortSignal) => Promise<Uint8Array>;
}

/**
 * The reader's opaque cursor state, carried verbatim inside
 * `TraceCursor.position`. `session` binds the position to the session record
 * that minted it — a cursor replayed against a different id fails
 * `cursor_malformed`, not a confusing rewrite.
 */
interface DevinCursor {
  session: string;
  steps: number;
  anchor: string;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
const ATIF_V1 = /^ATIF-v1\.\d+$/;
const HEX_64 = /^[0-9a-f]{64}$/;

/** Devin's record directory: `$XDG_DATA_HOME/devin/cli/transcripts`. */
function defaultTranscriptsDir(): string {
  const dataHome = process.env.XDG_DATA_HOME;
  const base = dataHome === undefined || dataHome === "" ? join(homedir(), ".local", "share") : dataHome;
  return join(base, "devin", "cli", "transcripts");
}

const nodeFileReader = createNodeFileReader();
const defaultReadFile = (path: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> => nodeFileReader(path, 0, maxBytes, signal);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(value: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

/** The session id is a filename key; a separator would escape the record dir. */
function filenameSafe(sessionId: string): boolean {
  return sessionId !== "." && sessionId !== ".." && !/[\\/\0]/.test(sessionId);
}

/** SHA-256 over the canonical serialization of the first `count` steps. */
function hashSteps(steps: unknown[], count: number): string {
  const hash = createHash("sha256");
  for (let index = 0; index < count; index += 1) {
    hash.update(JSON.stringify(steps[index]));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function cursorMalformed(reason: string): DevinSourceError {
  return new DevinSourceError("cursor_malformed", { reason });
}

/** Validate a position this reader minted; anything else fails closed. */
function parsePosition(position: unknown, sessionId: string): DevinCursor {
  if (position === undefined) return { session: sessionId, steps: 0, anchor: hashSteps([], 0) };
  if (!isRecord(position)) throw cursorMalformed("position_not_object");
  if (position.session !== sessionId) throw cursorMalformed("session_mismatch");
  if (!Number.isSafeInteger(position.steps) || (position.steps as number) < 0) throw cursorMalformed("steps_invalid");
  if (typeof position.anchor !== "string" || !HEX_64.test(position.anchor)) throw cursorMalformed("anchor_invalid");
  return { session: sessionId, steps: position.steps as number, anchor: position.anchor };
}

function malformed(reason: string): DevinSourceError {
  return new DevinSourceError("source_malformed", { reason });
}

function malformedStep(step: number, reason: string): DevinSourceError {
  return new DevinSourceError("source_malformed", { step, reason });
}

/**
 * Prove a step is an ATIF record: its own sequential id, a usable `source`
 * discriminator, and — when present — well-formed evidence-bearing fields
 * (tool calls keyed by `tool_call_id`, observation results paired by
 * `source_call_id`, a metrics object). Everything else rides through raw for
 * the digest builder; fields this reader does not consume are not validated.
 */
function checkStep(step: unknown, index: number): Record<string, unknown> {
  const stepId = index + 1;
  if (!isRecord(step)) throw malformedStep(stepId, "step_not_object");
  if (step.step_id !== stepId) throw malformedStep(stepId, "step_id_mismatch");
  if (typeof step.source !== "string" || step.source.length === 0) throw malformedStep(stepId, "source_invalid");
  if (own(step, "tool_calls")) {
    if (!Array.isArray(step.tool_calls)) throw malformedStep(stepId, "tool_calls_invalid");
    for (const call of step.tool_calls) {
      if (!isRecord(call) || typeof call.tool_call_id !== "string" || typeof call.function_name !== "string") {
        throw malformedStep(stepId, "tool_call_invalid");
      }
    }
  }
  if (own(step, "observation")) {
    const observation = step.observation;
    if (!isRecord(observation) || !Array.isArray(observation.results)) throw malformedStep(stepId, "observation_invalid");
    for (const result of observation.results) {
      if (!isRecord(result) || typeof result.source_call_id !== "string" || typeof result.content !== "string") {
        throw malformedStep(stepId, "result_invalid");
      }
    }
  }
  if (own(step, "metrics") && !isRecord(step.metrics)) throw malformedStep(stepId, "metrics_invalid");
  return step;
}

/**
 * Build the production reader: resolves `<session_id>.json` inside the record
 * dir, reads no more than the source ceiling plus one sentinel byte, parses the
 * bounded document, verifies the cursor's consumed prefix, and emits the
 * bounded window of new steps. Throws only `DevinSourceError` (typed) or the
 * storage seam's own error (seam → `source_unreadable`).
 */
export function createDevinSessionReader(deps: DevinTraceDeps = {}): DevinSessionReader {
  const dir = deps.transcriptsDir ?? defaultTranscriptsDir();
  const read = deps.readFile ?? defaultReadFile;
  return async (sessionId, position, signal) => {
    if (!filenameSafe(sessionId)) {
      throw new DevinSourceError("session_pointer_invalid", { reason: "id_not_filename_safe" });
    }
    const prior = parsePosition(position, sessionId);
    const data = await read(join(dir, `${sessionId}.json`), DEVIN_SOURCE_MAX_BYTES + 1, signal);
    if (data.byteLength > DEVIN_SOURCE_MAX_BYTES) {
      throw new DevinSourceError("source_exceeds_budget", { bytesAtLeast: data.byteLength, budget: DEVIN_SOURCE_MAX_BYTES });
    }

    let text: string;
    try {
      text = utf8.decode(data);
    } catch {
      throw malformed("invalid_utf8");
    }
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch {
      throw malformed("invalid_json");
    }
    if (!isRecord(document)) throw malformed("document_not_object");
    if (typeof document.schema_version !== "string" || !ATIF_V1.test(document.schema_version)) {
      throw malformed("schema_version_unsupported");
    }
    if (typeof document.session_id !== "string") throw malformed("session_id_invalid");
    if (document.session_id !== sessionId) throw malformed("session_id_mismatch");
    if (!Array.isArray(document.steps)) throw malformed("steps_not_array");
    const steps: unknown[] = document.steps;

    if (steps.length < prior.steps) {
      throw new DevinSourceError("source_rewritten", { reason: "steps_truncated" });
    }
    if (prior.steps > 0 && hashSteps(steps, prior.steps) !== prior.anchor) {
      throw new DevinSourceError("source_rewritten", { reason: "anchor_mismatch" });
    }

    // Window-boundary discipline matches the Pi adapter: a step that does not
    // fit is deferred unvalidated (it is judged when a window reaches it),
    // while a malformed step inside the window fails the whole read.
    const events: TraceEvent[] = [];
    let byteCount = 0;
    let emit = prior.steps;
    while (emit < steps.length) {
      const bytes = Buffer.byteLength(JSON.stringify(steps[emit]), "utf8");
      if (byteCount + bytes > TRACE_WINDOW_MAX_BYTES) {
        if (events.length === 0) {
          throw new DevinSourceError("record_exceeds_budget", { step: emit + 1, bytes });
        }
        break;
      }
      const step = checkStep(steps[emit], emit);
      events.push({ kind: step.source as string, offset: emit + 1, bytes, record: step });
      byteCount += bytes;
      emit += 1;
    }
    return { position: { session: sessionId, steps: emit, anchor: hashSteps(steps, emit) }, events };
  };
}
