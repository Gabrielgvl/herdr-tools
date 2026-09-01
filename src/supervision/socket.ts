/**
 * The newline-delimited JSON client for the local Herdr socket.
 *
 * This is supervision's only transport and it is read-only: it issues
 * `session.snapshot` and `events.subscribe` and consumes the pushed lifecycle
 * stream. Every mutation in this repository still goes through the Herdr CLI.
 */

import { createConnection } from "node:net";
import { StringDecoder } from "node:string_decoder";
import {
  assertSubscriptionAck,
  parseSocketLine,
  subscribeParams,
  SupervisionProtocolError,
  SUPERVISION_MAX_LINE_BYTES,
  type SupervisionSocketEvent,
} from "./protocol.js";

/** The transport seam: a duplex line stream, so tests never need a real socket. */
export interface SupervisionStream {
  write(line: string): void;
  destroy(): void;
  onData(handler: (chunk: Buffer) => void): void;
  onClose(handler: (error?: Error) => void): void;
}

export type SupervisionConnect = (socketPath: string) => Promise<SupervisionStream>;

export const SUPERVISION_REQUEST_TIMEOUT_MS = 10_000;
export const SUPERVISION_CONNECT_TIMEOUT_MS = 5_000;

export class SupervisionSocketError extends Error {
  readonly code: "SUPERVISION_SOCKET_UNAVAILABLE" | "SUPERVISION_SOCKET_CLOSED" | "SUPERVISION_REQUEST_TIMEOUT";

  constructor(code: SupervisionSocketError["code"], message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "SupervisionSocketError";
    this.code = code;
  }
}

/** The single failure a socket request can return from the server itself. */
export class SupervisionRequestError extends Error {
  readonly code = "SUPERVISION_REQUEST_FAILED" as const;

  constructor(readonly herdrCode: string, message: string) {
    super(message);
    this.name = "SupervisionRequestError";
  }
}

/**
 * Resolve the socket path fail-closed. Supervision refuses to guess a default
 * path: `HERDR_SOCKET_PATH` is the value Herdr injects into every pane, and its
 * absence means this process is not inside a Herdr runtime that can be observed.
 */
export function resolveSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.HERDR_SOCKET_PATH;
  if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/u.test(value)) {
    throw new SupervisionSocketError("SUPERVISION_SOCKET_UNAVAILABLE", "HERDR_SOCKET_PATH is missing or malformed");
  }
  return value;
}

/** The `node:net` seam, mirroring the `SpawnLike` seam the MCP host exec uses. */
export interface SupervisionSocketLike {
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "connect", listener: () => void): unknown;
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  setNoDelay(value: boolean): unknown;
  write(data: string): unknown;
  destroy(): unknown;
}

export type SupervisionSocketFactory = (socketPath: string) => SupervisionSocketLike;

const nodeSocketFactory: SupervisionSocketFactory = (socketPath) => createConnection({ path: socketPath }) as unknown as SupervisionSocketLike;

export function createNodeSupervisionConnect(connectTimeoutMs = SUPERVISION_CONNECT_TIMEOUT_MS, createSocket: SupervisionSocketFactory = nodeSocketFactory): SupervisionConnect {
  return (socketPath: string) => new Promise<SupervisionStream>((resolve, reject) => {
    const socket = createSocket(socketPath);
    let settled = false;
    // Both settling paths clear this timer, so it can only fire while unsettled.
    const timer = setTimeout(() => {
      settled = true;
      socket.destroy();
      reject(new SupervisionSocketError("SUPERVISION_SOCKET_UNAVAILABLE", "Herdr socket did not connect within the bound"));
    }, connectTimeoutMs);
    socket.once("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(new SupervisionSocketError("SUPERVISION_SOCKET_UNAVAILABLE", "Herdr socket could not be opened", { cause: error.message }));
    });
    socket.once("connect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.setNoDelay(true);
      resolve({
        write: (line) => { socket.write(line); },
        destroy: () => { socket.destroy(); },
        onData: (handler) => { socket.on("data", (chunk: Buffer) => handler(chunk)); },
        onClose: (handler) => {
          socket.on("error", (error: Error) => handler(error));
          socket.on("close", () => handler());
        },
      });
    });
  });
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * One connected socket. It owns line framing, request correlation, and the
 * single `events.subscribe` this connection is allowed to issue.
 */
export class SupervisionSocket {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private nextId = 0;
  private closedError: Error | undefined;
  private closed = false;
  private subscribed = false;
  private subscriptionRequestId: string | undefined;
  private eventHandler: ((event: SupervisionSocketEvent) => void) | undefined;
  private closeHandler: ((error: Error) => void) | undefined;

  constructor(private readonly stream: SupervisionStream, private readonly requestTimeoutMs = SUPERVISION_REQUEST_TIMEOUT_MS) {
    stream.onData((chunk) => this.ingest(chunk));
    stream.onClose((error) => this.fail(error ?? new SupervisionSocketError("SUPERVISION_SOCKET_CLOSED", "Herdr socket closed")));
  }

  onEvent(handler: (event: SupervisionSocketEvent) => void): void {
    this.eventHandler = handler;
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
      if (line.trim().length > 0) {
        if (!this.consume(line)) return;
      }
      index = this.buffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.buffer, "utf8") > SUPERVISION_MAX_LINE_BYTES) {
      this.fail(new SupervisionProtocolError("Herdr socket line exceeds the accepted bound", { limitBytes: SUPERVISION_MAX_LINE_BYTES }));
    }
  }

  /** Returns false once the connection has been torn down by a protocol failure. */
  private consume(line: string): boolean {
    let parsed;
    try {
      parsed = parseSocketLine(line);
    } catch (error) {
      this.fail(error as Error);
      return false;
    }
    if (parsed.kind === "ignored") return true;
    if (parsed.kind === "event") {
      // Events before the subscription acknowledgement are not part of any
      // subscription this client asked for, so they are refused rather than folded.
      if (!this.subscribed) {
        this.fail(new SupervisionProtocolError("Herdr pushed an event before acknowledging the subscription"));
        return false;
      }
      this.eventHandler?.(parsed);
      return true;
    }
    const request = this.pending.get(parsed.id);
    if (!request) return true;
    this.pending.delete(parsed.id);
    clearTimeout(request.timer);
    if (parsed.kind === "failure") {
      request.reject(new SupervisionRequestError(parsed.error.code, parsed.error.message));
      return true;
    }
    if (parsed.id === this.subscriptionRequestId) {
      // The acknowledgement takes effect here, not in `subscribe`'s continuation:
      // the transport can deliver it and the first replay event in one chunk, and
      // this loop consumes that event before any await can resume.
      try {
        assertSubscriptionAck(parsed.result);
      } catch (error) {
        request.reject(error as Error);
        this.fail(error as Error);
        return false;
      }
      this.subscribed = true;
    }
    request.resolve(parsed.result);
    return true;
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closedError = error;
    for (const [, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.stream.destroy();
    this.closeHandler?.(error);
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.issue(method, params);
  }

  private issue(method: string, params: Record<string, unknown>, mark?: (id: string) => void): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closedError);
    const id = `herdr-tools-${++this.nextId}`;
    mark?.(id);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SupervisionSocketError("SUPERVISION_REQUEST_TIMEOUT", "Herdr socket request timed out", { method }));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.stream.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  /**
   * Issue the single `events.subscribe` this connection is allowed. The
   * acknowledgement is validated and takes effect inside the ingest loop, so a
   * chunk carrying both it and the first replay event is accepted atomically.
   */
  async subscribe(): Promise<void> {
    await this.issue("events.subscribe", subscribeParams(), (id) => { this.subscriptionRequestId = id; });
  }

  /**
   * Why this socket closed, or undefined while it is open. A caller that must
   * not adopt a dead connection checks this rather than a separate flag, so the
   * reason and the state can never disagree.
   */
  closure(): Error | undefined {
    return this.closedError;
  }

  close(): void {
    this.fail(new SupervisionSocketError("SUPERVISION_SOCKET_CLOSED", "Herdr socket closed by the supervision monitor"));
  }

  isClosed(): boolean {
    return this.closed;
  }
}
