/**
 * The daemon socket client (spec: durable-supervisor §4).
 *
 * Connect-only: this module never spawns a daemon. A missing socket or a
 * refused connect is a typed `DAEMON_UNAVAILABLE` — until the owner activates
 * the systemd unit that is the visible switch the contract calls for, never a
 * drift into an in-process fallback.
 *
 * After connecting, the client performs the one-line version handshake on the
 * same NDJSON framing: it writes `hello`, and the daemon's `ack` opens the
 * connection for correlated requests. A mismatch surfaces as typed
 * `PROTOCOL_MISMATCH`; anything that is not a proven frame is a
 * `DaemonProtocolError` and drops the connection.
 */

import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Type, type Static } from "typebox";
import { DelegatedCallerSchema, IdempotencyKeySchema, type DaemonLaunchRequest } from "../launch-schema.js";
import type { AgentSessionIdentity } from "../messages/prompt.js";
import type { LaunchEffectCertainty } from "../tools/launch.js";
import {
  createNodeSupervisionConnect,
  SUPERVISION_CONNECT_TIMEOUT_MS,
  SUPERVISION_REQUEST_TIMEOUT_MS,
  type SupervisionSocketFactory,
  type SupervisionStream,
} from "../supervision/socket.js";
import type { DaemonLaunchReply } from "./handlers/launch.js";
import type { DaemonRunReply } from "./handlers/run.js";
import type { DaemonStatusReply } from "./handlers/status.js";
import type { LaunchIntentState } from "./intents.js";
import type { DaemonNamespace } from "./namespace.js";
import {
  DAEMON_MAX_LINE_BYTES,
  DAEMON_PROTOCOL_VERSION,
  DAEMON_SOCKET_NAME,
  DaemonProtocolError,
  DaemonRequestError,
  encodeDaemonHello,
  encodeDaemonRequest,
  parseDaemonLine,
} from "./protocol.js";

export type DaemonClientErrorCode = "DAEMON_UNAVAILABLE" | "PROTOCOL_MISMATCH";

export class DaemonClientError extends Error {
  constructor(readonly code: DaemonClientErrorCode, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "DaemonClientError";
  }
}

export interface DaemonClientSocketOptions {
  /** The wire version to offer; defaults to {@link DAEMON_PROTOCOL_VERSION}. */
  version?: number;
  /** Bound on the handshake and on each request. */
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function unavailable(message: string): DaemonClientError {
  return new DaemonClientError("DAEMON_UNAVAILABLE", message);
}

/**
 * One connected daemon socket: it owns the hello/ack handshake, line framing,
 * and request correlation. `hello` is always the first line on the wire, so a
 * request issued before `ready` resolves is still a legal frame — the daemon
 * has already seen the hello by the time the request arrives.
 */
export class DaemonClientSocket {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly decoder = new StringDecoder("utf8");
  private readonly version: number;
  private readonly requestTimeoutMs: number;
  private buffer = "";
  private nextId = 0;
  private acknowledged = false;
  private closed = false;
  private closedError: Error | undefined;
  private closeHandler: ((error: Error) => void) | undefined;
  /** Resolves once the daemon's `ack` is accepted; rejects on any refusal. */
  readonly ready: Promise<void>;
  /** Assigned by the `ready` executor; settles once, then is a no-op. */
  private settleReady!: (error?: Error) => void;

  constructor(private readonly stream: SupervisionStream, options: DaemonClientSocketOptions = {}) {
    this.version = options.version ?? DAEMON_PROTOCOL_VERSION;
    this.requestTimeoutMs = options.requestTimeoutMs ?? SUPERVISION_REQUEST_TIMEOUT_MS;
    stream.onData((chunk) => this.ingest(chunk));
    stream.onClose((error) =>
      this.fail(unavailable(error === undefined ? "daemon socket closed" : `daemon socket error: ${error.message}`)),
    );
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(unavailable("daemon did not acknowledge the handshake within the bound"));
      }, this.requestTimeoutMs);
      this.settleReady = (error) => {
        clearTimeout(timer);
        if (error === undefined) resolve();
        else reject(error);
      };
    });
    // The rejection is always delivered through `ready`/`closure`; this keeps
    // a never-awaited handshake from becoming an unhandled rejection.
    void this.ready.catch(() => undefined);
    try {
      this.stream.write(encodeDaemonHello(this.version));
    } catch (error) {
      this.fail(error instanceof Error ? error : unavailable("daemon socket write failed"));
    }
  }

  onClose(handler: (error: Error) => void): void {
    this.closeHandler = handler;
  }

  private ingest(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer += this.decoder.write(chunk);
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (Buffer.byteLength(line, "utf8") + 1 > DAEMON_MAX_LINE_BYTES) {
        this.fail(new DaemonProtocolError("daemon socket frame exceeds the accepted bound", { limitBytes: DAEMON_MAX_LINE_BYTES }));
        return;
      }
      if (line.trim().length > 0 && !this.consume(line)) return;
      index = this.buffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.buffer, "utf8") > DAEMON_MAX_LINE_BYTES) {
      this.fail(new DaemonProtocolError("daemon socket line exceeds the accepted bound", { limitBytes: DAEMON_MAX_LINE_BYTES }));
    }
  }

  /** Returns false once the connection has been torn down by a failure. */
  private consume(line: string): boolean {
    let parsed;
    try {
      parsed = parseDaemonLine(line);
    } catch (error) {
      this.fail(error as Error);
      return false;
    }
    if (!this.acknowledged) {
      if (parsed.kind === "ack") {
        if (parsed.version !== this.version) {
          this.fail(new DaemonClientError("PROTOCOL_MISMATCH", "daemon protocol version does not match", { daemonVersion: parsed.version }));
          return false;
        }
        this.acknowledged = true;
        this.settleReady();
        return true;
      }
      if (parsed.kind === "error") {
        this.fail(
          parsed.error.code === "PROTOCOL_MISMATCH"
            ? new DaemonClientError("PROTOCOL_MISMATCH", "daemon refused the protocol version")
            : new DaemonProtocolError("daemon refused the connection", { code: parsed.error.code }),
        );
        return false;
      }
      this.fail(new DaemonProtocolError("daemon sent traffic before the version acknowledgement"));
      return false;
    }
    if (parsed.kind !== "reply" && parsed.kind !== "failure") {
      this.fail(new DaemonProtocolError("daemon socket line is not a reply"));
      return false;
    }
    const request = this.pending.get(parsed.id);
    if (!request) return true;
    this.pending.delete(parsed.id);
    clearTimeout(request.timer);
    if (parsed.kind === "failure") {
      request.reject(new DaemonRequestError(parsed.error.code));
      return true;
    }
    request.resolve(parsed.result);
    return true;
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closedError = error;
    this.settleReady(error);
    for (const [, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.stream.destroy();
    this.closeHandler?.(error);
  }

  /** Issue one correlated request; the reply resolves or rejects it. */
  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closedError);
    const id = `herdr-daemon-${++this.nextId}`;
    let frame: string;
    try {
      frame = encodeDaemonRequest(id, method, params);
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(unavailable("daemon request timed out"));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.stream.write(frame);
      } catch (error) {
        this.fail(error instanceof Error ? error : unavailable("daemon socket write failed"));
      }
    });
  }

  /**
   * Why this socket closed, or undefined while it is open. The reason and the
   * state can never disagree, so a caller checks this rather than a flag.
   */
  closure(): Error | undefined {
    return this.closedError;
  }

  close(): void {
    this.fail(unavailable("daemon socket closed by the client"));
  }

  isClosed(): boolean {
    return this.closed;
  }
}

export interface DaemonClientOptions extends DaemonClientSocketOptions {
  /** Bound on the socket connect; defaults to the supervision connect bound. */
  connectTimeoutMs?: number;
  /** The `node:net` seam, mirroring the supervision socket factory. */
  createSocket?: SupervisionSocketFactory;
}

/**
 * Connect to the daemon socket inside `namespace` and complete the version
 * handshake. Missing sockets and refused connects are `DAEMON_UNAVAILABLE`;
 * a version refusal is `PROTOCOL_MISMATCH`. This never spawns a daemon.
 */
export async function connectDaemon(namespace: DaemonNamespace, options: DaemonClientOptions = {}): Promise<DaemonClientSocket> {
  const socketPath = join(namespace.dir, DAEMON_SOCKET_NAME);
  let stream: SupervisionStream;
  try {
    stream = await createNodeSupervisionConnect(options.connectTimeoutMs ?? SUPERVISION_CONNECT_TIMEOUT_MS, options.createSocket)(socketPath);
  } catch {
    throw unavailable("daemon socket could not be opened");
  }
  const client = new DaemonClientSocket(stream, options);
  try {
    await client.ready;
  } catch (error) {
    client.close();
    throw error;
  }
  return client;
}

/* ------------------------------------------------------------------ */
/* Typed call layer (spec: durable-supervisor §5–§8).                    */
/* ------------------------------------------------------------------ */

/** The identity the thin client claims; the daemon verifies it per request (D2a). */
export interface DaemonCallerIdentity {
  workspaceId: string;
  tabId: string;
  paneId: string;
  agentSession: AgentSessionIdentity | null;
}

/** Everything one connected client needs beyond the socket itself. */
export interface DaemonCallerContext {
  identity: DaemonCallerIdentity;
  /** The caller's canonical project root — the daemon verifies it before any effect. */
  projectRoot: string;
}

/** Single-line identifier text on the wire: nonempty and free of NUL and line breaks. */
const WireIdentifier = Type.String({ minLength: 1, pattern: "^[^\\u0000\\r\\n]+$" });

/**
 * The `run` request union (§8) as one schema — the published `herdr_run`
 * parameters and `DaemonRunInput` share a single authority so the tool surface
 * can never drift from the wire. `observe` is read-only; `reconcile`,
 * `transfer`, and `claim` act on recorded state; `ack` performs the caller's
 * own-mailbox `unread/` → `acked/` rename after handling. `caller` is the
 * additive delegated-mode assertion every action accepts; it is a client-side
 * input only — `run()` never puts it on the wire.
 */
export const DaemonRunParamsSchema = Type.Union([
  Type.Object({ action: Type.Literal("observe"), runId: WireIdentifier, caller: Type.Optional(DelegatedCallerSchema) }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("reconcile"), idempotencyKey: IdempotencyKeySchema, caller: Type.Optional(DelegatedCallerSchema) }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal("transfer"),
    runIds: Type.Array(WireIdentifier, { minItems: 1 }),
    successorPaneId: WireIdentifier,
    caller: Type.Optional(DelegatedCallerSchema),
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal("claim"),
    runIds: Type.Array(WireIdentifier, { minItems: 1 }),
    incidentId: WireIdentifier,
    caller: Type.Optional(DelegatedCallerSchema),
  }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("ack"), eventId: WireIdentifier, caller: Type.Optional(DelegatedCallerSchema) }, { additionalProperties: false }),
]);
export type DaemonRunInput = Static<typeof DaemonRunParamsSchema>;

/** The `status` request (§10): an optional event ID selects one bounded event body. `caller` is the delegated-mode assertion; it never reaches the wire. */
export const DaemonStatusParamsSchema = Type.Object({
  eventId: Type.Optional(WireIdentifier),
  caller: Type.Optional(DelegatedCallerSchema),
}, { additionalProperties: false });
export type DaemonStatusInput = Static<typeof DaemonStatusParamsSchema>;

/**
 * The one bounded error every typed call projects. `code` is always a typed
 * vocabulary entry — the daemon's own refusal codes pass through unchanged,
 * transport failures project `DAEMON_UNAVAILABLE`, a version or framing
 * refusal `PROTOCOL_MISMATCH`/`DAEMON_PROTOCOL_ERROR`, and a reply that is not
 * the method's documented shape `DAEMON_REPLY_MALFORMED`. Wire message text is
 * never forwarded: the fixed `message` is all a caller prints, and the
 * structured recovery evidence rides `details`.
 *
 * For `launch` calls the details always carry `effectCertainty`: a wire
 * refusal can never convey the launcher's certainty, so it projects
 * `unknown` — the fail-closed value — and a post-effect failure can never
 * be read as a bare `failed`. The settled classification stays readable
 * through `status`/`run reconcile`.
 */
export class DaemonCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "DaemonCallError";
  }

  /** The launcher-computed certainty a launch failure proved, or undefined for non-launch calls. */
  get effectCertainty(): LaunchEffectCertainty | undefined {
    return this.details.effectCertainty as LaunchEffectCertainty | undefined;
  }
}

const DAEMON_CALL_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const INTENT_STATES = new Set<LaunchIntentState>(["recorded", "effecting", "completed", "failed", "unresolved"]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A bounded typed code carried by the thrown cause, else undefined. */
function codeOf(error: unknown): string | undefined {
  const code = record(error) ? error.code : undefined;
  return typeof code === "string" && DAEMON_CALL_CODE.test(code) ? code : undefined;
}

function malformedReply(method: string): DaemonCallError {
  return new DaemonCallError("DAEMON_REPLY_MALFORMED", `daemon ${method} reply is not the documented shape`);
}

/**
 * Project any rejection into the single bounded error the call layer
 * publishes: one typed code, a fixed message, whitelisted `details`. Wire
 * text is never copied into the projected error.
 */
function projectCallError(method: string, error: unknown): DaemonCallError {
  if (error instanceof DaemonCallError) return error;
  // Every launch failure carries the fail-closed certainty: no wire reply —
  // refusal, timeout, or mid-call drop — can prove the launch had no effect,
  // and a single-line wire refusal can never carry the diagnostic (the wire's
  // `requiredString` rejects embedded newlines). The authoritative settled
  // state stays readable through `status`/`run observe`.
  const certainty = method === "launch" ? { effectCertainty: "unknown" as const } : {};
  if (error instanceof DaemonRequestError) {
    return new DaemonCallError(
      typeof error.daemonCode === "string" && DAEMON_CALL_CODE.test(error.daemonCode) ? error.daemonCode : "DAEMON_REQUEST_FAILED",
      `daemon ${method} call was refused`,
      certainty,
    );
  }
  // Typed peers — DaemonClientError, DaemonProtocolError, DaemonMailboxError,
  // DaemonIntentError — pass their bounded code and details through unchanged.
  const code = codeOf(error);
  if (code !== undefined) {
    const details = record(error) && record(error.details) ? error.details : {};
    return new DaemonCallError(code, error instanceof Error ? error.message : `daemon ${method} call failed`, { ...details, ...certainty });
  }
  // An untyped failure is a transport-class refusal: nothing the daemon said
  // is trusted, and the caller learns only that the call did not land.
  return new DaemonCallError("DAEMON_UNAVAILABLE", `daemon ${method} call failed`, certainty);
}

/**
 * One connected, identity-bound daemon client: the three typed calls over the
 * socket — `launch`, `run`, `status` (spec §10 — mailbox reads ride `status`,
 * `ack` rides `run`; there is no separate filesystem helper). Every rejection
 * projects through {@link DaemonCallError}; replies that are not the
 * documented envelope refuse as `DAEMON_REPLY_MALFORMED`.
 */
export class DaemonClient {
  constructor(
    private readonly socket: DaemonClientSocket,
    private readonly caller: DaemonCallerContext,
  ) {}

  /**
   * `launch` (§6): the Task plus the required idempotency key, under the
   * claimed identity and canonical project root. Resolves with the intent-
   * gated reply — `state` and `resumed`/`replayed` distinguish an executed
   * launch, a resumed pre-effect intent, and a zero-effect replay — and
   * `result.children[].error` retains the surviving-resource fields and
   * per-child `effectCertainty` a post-effect failure carries.
   */
  async launch(request: DaemonLaunchRequest): Promise<DaemonLaunchReply> {
    const reply = await this.call("launch", {
      identity: this.caller.identity,
      projectRoot: this.caller.projectRoot,
      task: request.task,
      idempotencyKey: request.idempotencyKey,
    });
    if (!record(reply)
      || reply.kind !== "launch"
      || typeof reply.launchId !== "string"
      || typeof reply.state !== "string"
      || !INTENT_STATES.has(reply.state as LaunchIntentState)
      || !Array.isArray(reply.children)
      || (!(typeof reply.resumed === "boolean" && record(reply.result)) && reply.replayed !== false)) {
      throw malformedReply("launch");
    }
    return reply as unknown as DaemonLaunchReply;
  }

  /** `run` (§8): one discriminated input per action; replies echo the action. */
  async run(input: DaemonRunInput): Promise<DaemonRunReply> {
    // `caller` is a client-side assertion for claim derivation on delegated
    // serves; the daemon request carries only the derived identity.
    const { action, ...rest } = input;
    const params = { ...rest };
    delete params.caller;
    const reply = await this.call("run", { identity: this.caller.identity, action, ...params });
    if (!record(reply) || reply.kind !== "run" || reply.action !== action) throw malformedReply("run");
    return reply as DaemonRunReply;
  }

  /** `status` (§10): read-only; opens nothing for writing, never acks, never mutates. */
  async status(input: DaemonStatusInput = {}): Promise<DaemonStatusReply> {
    const reply = await this.call("status", {
      identity: this.caller.identity,
      ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
    });
    if (!record(reply) || reply.kind !== "status") throw malformedReply("status");
    return reply as unknown as DaemonStatusReply;
  }

  private async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.socket.request(method, params);
    } catch (error) {
      throw projectCallError(method, error);
    }
  }

  close(): void {
    this.socket.close();
  }

  isClosed(): boolean {
    return this.socket.isClosed();
  }
}

/**
 * Connect to the daemon and bind the caller's claimed identity and canonical
 * project root. Connect-only, like {@link connectDaemon}: a missing socket or
 * refused connect is `DAEMON_UNAVAILABLE`, a version refusal `PROTOCOL_MISMATCH`.
 */
export async function connectDaemonClient(
  namespace: DaemonNamespace,
  caller: DaemonCallerContext,
  options: DaemonClientOptions = {},
): Promise<DaemonClient> {
  return new DaemonClient(await connectDaemon(namespace, options), caller);
}

export type { DaemonLaunchReply } from "./handlers/launch.js";
export type { DaemonRunReply } from "./handlers/run.js";
export type { DaemonStatusReply } from "./handlers/status.js";
export type { MailboxEvent, DaemonMailboxError } from "./mailbox.js";
