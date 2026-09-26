/**
 * The daemon's newline-delimited JSON wire protocol (spec: durable-supervisor
 * §4): the supervision framing discipline — one JSON object per line, the
 * shared 256 KiB line bound, request/reply correlation by `id` — plus one
 * bounded version handshake on the same framing.
 *
 * The client's first line is `hello` carrying its protocol version; the daemon
 * answers one `ack` line with its own, or one bounded `PROTOCOL_MISMATCH`
 * refusal line before the connection closes with no other effect. Anything
 * that is not a proven frame is a `DaemonProtocolError`, never a guess.
 */

import { SUPERVISION_MAX_LINE_BYTES } from "../supervision/protocol.js";

/** The wire version this build speaks; the hello/ack gate refuses any other. */
export const DAEMON_PROTOCOL_VERSION = 1;

/** The daemon's socket file inside the endpoint namespace (spec §4). */
export const DAEMON_SOCKET_NAME = "daemon.sock";

/** The daemon shares supervision's NDJSON line bound, delimiter included. */
export const DAEMON_MAX_LINE_BYTES = SUPERVISION_MAX_LINE_BYTES;

/**
 * Longest code or message put on the wire inside an error frame. Error lines
 * must stay bounded even when they carry derived text, so the values are
 * truncated before framing rather than risking an unencodable refusal.
 */
const DAEMON_WIRE_ERROR_MAX_CHARS = 512;

export class DaemonProtocolError extends Error {
  readonly code = "DAEMON_PROTOCOL_ERROR" as const;

  constructor(message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "DaemonProtocolError";
  }
}

/**
 * A request the daemon answered with a failure reply. The wire message is
 * untrusted — peers and tests use the typed `daemonCode`, not the text.
 */
export class DaemonRequestError extends Error {
  readonly code = "DAEMON_REQUEST_FAILED" as const;

  constructor(readonly daemonCode: string, message = "Daemon request was rejected") {
    super(message);
    this.name = "DaemonRequestError";
  }
}

export interface DaemonWireError {
  code: string;
  message: string;
}

/** A line validated at the daemon protocol boundary. */
export type DaemonLine =
  | { kind: "hello"; version: number }
  | { kind: "ack"; version: number }
  | { kind: "error"; error: DaemonWireError }
  | { kind: "request"; id: string; method: string; params: Record<string, unknown> }
  | { kind: "reply"; id: string; result: unknown }
  | { kind: "failure"; id: string; error: DaemonWireError };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(value: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/u.test(value)) {
    throw new DaemonProtocolError("daemon socket value is not a usable identifier", { field });
  }
  return value;
}

function requiredVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new DaemonProtocolError("daemon protocol version is malformed", { field: "version" });
  }
  return value;
}

function wireError(value: unknown): DaemonWireError {
  if (!record(value)) throw new DaemonProtocolError("daemon socket error is malformed", { field: "error" });
  return { code: requiredString(value.code, "error.code"), message: requiredString(value.message, "error.message") };
}

function bounded(value: string): string {
  return value.length > DAEMON_WIRE_ERROR_MAX_CHARS ? value.slice(0, DAEMON_WIRE_ERROR_MAX_CHARS) : value;
}

function frame(value: Record<string, unknown>): string {
  let line: string;
  try {
    line = `${JSON.stringify(value)}\n`;
  } catch {
    throw new DaemonProtocolError("daemon socket frame is not serializable");
  }
  if (Buffer.byteLength(line, "utf8") > DAEMON_MAX_LINE_BYTES) {
    throw new DaemonProtocolError("daemon socket frame exceeds the accepted bound", { limitBytes: DAEMON_MAX_LINE_BYTES });
  }
  return line;
}

/** The client's first line: `{"type":"hello","version":<n>}`. */
export function encodeDaemonHello(version = DAEMON_PROTOCOL_VERSION): string {
  return frame({ type: "hello", version: requiredVersion(version) });
}

/** The daemon's acceptance line: `{"type":"ack","version":<n>}`. */
export function encodeDaemonAck(version = DAEMON_PROTOCOL_VERSION): string {
  return frame({ type: "ack", version: requiredVersion(version) });
}

/**
 * The single connection-scoped error line — `PROTOCOL_MISMATCH` refusals and
 * fatal framing errors share this shape so a refusal is always exactly one
 * bounded line.
 */
export function encodeDaemonErrorLine(code: string, message: string): string {
  return frame({ type: "error", error: { code: bounded(code), message: bounded(message) } });
}

/** A correlated request: `{"id","method","params"}`. */
export function encodeDaemonRequest(id: string, method: string, params: Record<string, unknown>): string {
  requiredString(id, "id");
  requiredString(method, "method");
  if (!record(params)) throw new DaemonProtocolError("daemon socket request params are malformed");
  return frame({ id, method, params });
}

/** A correlated success reply: `{"id","result"}`. */
export function encodeDaemonResult(id: string, result: unknown): string {
  requiredString(id, "id");
  return frame({ id, result: result === undefined ? null : result });
}

/** A correlated failure reply: `{"id","error":{"code","message"}}`. */
export function encodeDaemonFailure(id: string, code: string, message: string): string {
  requiredString(id, "id");
  return frame({ id, error: { code: bounded(code), message: bounded(message) } });
}

/**
 * Parse one NDJSON line. Handshake frames carry `type`; correlated frames
 * carry `id`. Anything satisfying neither shape is a protocol failure, because
 * silently skipping unknown lines would let a malformed stream look quiet.
 */
export function parseDaemonLine(line: string): DaemonLine {
  if (Buffer.byteLength(line, "utf8") > DAEMON_MAX_LINE_BYTES) {
    throw new DaemonProtocolError("daemon socket line exceeds the accepted bound", { limitBytes: DAEMON_MAX_LINE_BYTES });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new DaemonProtocolError("daemon socket line is not JSON");
  }
  if (!record(parsed)) throw new DaemonProtocolError("daemon socket line is not an object");
  if (own(parsed, "type")) {
    const type = requiredString(parsed.type, "type");
    if (type === "hello" || type === "ack") return { kind: type, version: requiredVersion(parsed.version) };
    if (type === "error") return { kind: "error", error: wireError(parsed.error) };
    throw new DaemonProtocolError("daemon socket frame type is unknown", { type });
  }
  if (!own(parsed, "id")) throw new DaemonProtocolError("daemon socket line is neither a handshake nor a request");
  const id = requiredString(parsed.id, "id");
  if (own(parsed, "method")) {
    if (own(parsed, "result") || own(parsed, "error")) {
      throw new DaemonProtocolError("daemon socket request carries a reply field", { id });
    }
    if (!record(parsed.params)) throw new DaemonProtocolError("daemon socket request params are malformed", { id });
    return { kind: "request", id, method: requiredString(parsed.method, "method"), params: parsed.params };
  }
  if (own(parsed, "result") && own(parsed, "error")) {
    throw new DaemonProtocolError("daemon socket reply carries both result and error", { id });
  }
  if (own(parsed, "error")) return { kind: "failure", id, error: wireError(parsed.error) };
  if (!own(parsed, "result")) throw new DaemonProtocolError("daemon socket reply carries neither result nor error", { id });
  return { kind: "reply", id, result: parsed.result };
}
