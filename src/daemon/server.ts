/**
 * The daemon endpoint listener (spec: durable-supervisor §4).
 *
 * `daemon.sock` is bound only while the N1.1 instance lock is provably held,
 * and an existing path is probed by connect before the bind: an answered
 * socket means a live daemon owns it and startup refuses; `ECONNREFUSED` or a
 * path vanishing mid-probe means a stale socket left by a dead process and it
 * is unlinked and rebound; any other error fails startup. Without the probe a
 * crashed daemon leaves `daemon.sock` behind and `Restart=on-failure` loops on
 * `EADDRINUSE`.
 *
 * Each accepted connection gets the version handshake on the NDJSON framing:
 * the first line must be `hello`, a matching version is answered with `ack`,
 * and a mismatch earns exactly one bounded `PROTOCOL_MISMATCH` line before the
 * connection closes with no other effect. Any malformed line earns exactly one
 * bounded error line before that connection closes. Replies are correlated by
 * `id` and written only on the requesting connection, so concurrent clients
 * can never see each other's responses.
 */

import { createConnection, createServer, type Server } from "node:net";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { DaemonInstanceError, type DaemonInstanceLease } from "./instance.js";
import type { DaemonNamespace } from "./namespace.js";
import {
  DAEMON_MAX_LINE_BYTES,
  DAEMON_PROTOCOL_VERSION,
  DAEMON_SOCKET_NAME,
  DaemonRequestError,
  encodeDaemonAck,
  encodeDaemonErrorLine,
  encodeDaemonFailure,
  encodeDaemonResult,
  parseDaemonLine,
} from "./protocol.js";

/** What one connect probe proved about an existing `daemon.sock` path. */
export type DaemonSocketProbeVerdict = "answered" | "stale" | "vanished";
export type DaemonSocketProbe = (socketPath: string) => Promise<DaemonSocketProbeVerdict>;

/**
 * The connect probe. Only the verdicts are returned; every other connect
 * failure rejects so the caller fails startup rather than guessing at the
 * owner's liveness. A unix connect resolves or fails at once — no timeout is
 * needed. A settled promise ignores any later event on its own.
 */
export function createDaemonSocketProbe(): DaemonSocketProbe {
  return (socketPath) =>
    new Promise<DaemonSocketProbeVerdict>((resolve, reject) => {
      const socket = createConnection({ path: socketPath });
      socket.once("error", (error: NodeJS.ErrnoException) => {
        socket.destroy();
        if (error.code === "ECONNREFUSED") resolve("stale");
        else if (error.code === "ENOENT") resolve("vanished");
        else reject(error);
      });
      socket.once("connect", () => {
        socket.destroy();
        resolve("answered");
      });
    });
}

/** One validated request handed to the daemon's handler surface (N2.1). */
export interface DaemonRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export type DaemonRequestHandler = (request: DaemonRequest) => unknown | Promise<unknown>;

/**
 * The N1.2 plumbing handler — `echo` and `version` exist to prove the
 * protocol; the real handler surface arrives with N2.1. Unknown methods are a
 * correlated failure reply, never a connection failure.
 */
function defaultDaemonHandler(version: number): DaemonRequestHandler {
  return (request) => {
    if (request.method === "echo") return request.params;
    if (request.method === "version") return { version };
    throw new DaemonRequestError("DAEMON_UNKNOWN_METHOD", "daemon method is not implemented");
  };
}

/** The accepted-connection seam, mirroring the supervision stream seam. */
interface DaemonPeerStream {
  write(line: string): void;
  /** Write the final line and flush it ahead of the close. */
  end(line: string): void;
  destroy(): void;
  onData(handler: (chunk: Buffer) => void): void;
  onError(handler: (error: Error) => void): void;
  onClose(handler: () => void): void;
}

/**
 * One accepted connection: line framing, the one-line handshake, and
 * correlated dispatch. A connection that cannot produce a valid frame earns
 * exactly one bounded error line delivered with `end` — flushing it ahead of
 * the close — and then nothing more.
 */
class DaemonServerConnection {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private acknowledged = false;
  private closed = false;

  constructor(
    private readonly stream: DaemonPeerStream,
    private readonly version: number,
    private readonly handler: DaemonRequestHandler,
    private readonly onClosed: () => void,
  ) {
    stream.onData((chunk) => this.ingest(chunk));
    // A socket error is always followed by close; swallowing it here keeps a
    // dead peer from becoming an unhandled 'error' throw.
    /* c8 ignore next -- a peer error is timing-dependent and cannot be forced */
    stream.onError(() => undefined);
    stream.onClose(() => {
      this.closed = true;
      this.onClosed();
    });
  }

  destroy(): void {
    this.closed = true;
    this.stream.destroy();
  }

  private ingest(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer += this.decoder.write(chunk);
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (Buffer.byteLength(line, "utf8") + 1 > DAEMON_MAX_LINE_BYTES) {
        this.refuse("daemon socket frame exceeds the accepted bound");
        return;
      }
      if (line.trim().length > 0 && !this.consume(line)) return;
      index = this.buffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.buffer, "utf8") > DAEMON_MAX_LINE_BYTES) {
      this.refuse("daemon socket line exceeds the accepted bound");
    }
  }

  /** Returns false once the connection has been closed by a refusal. */
  private consume(line: string): boolean {
    let parsed;
    try {
      parsed = parseDaemonLine(line);
    } catch (error) {
      /* c8 ignore next -- parseDaemonLine only ever throws DaemonProtocolError */
      this.refuse(error instanceof Error ? error.message : "daemon socket line is malformed");
      return false;
    }
    if (!this.acknowledged) {
      if (parsed.kind !== "hello") {
        this.refuse("daemon socket expects a hello");
        return false;
      }
      if (parsed.version !== this.version) {
        this.closed = true;
        this.stream.end(encodeDaemonErrorLine("PROTOCOL_MISMATCH", "daemon protocol version is not supported"));
        return false;
      }
      this.acknowledged = true;
      this.stream.write(encodeDaemonAck(this.version));
      return true;
    }
    if (parsed.kind !== "request") {
      this.refuse("daemon socket expects a request");
      return false;
    }
    this.dispatch(parsed);
    return true;
  }

  /** One bounded error line flushed ahead of the close, then nothing more. */
  private refuse(message: string): void {
    /* c8 ignore next -- consume() only reaches refuse() on an open connection */
    if (this.closed) return;
    this.closed = true;
    this.stream.end(encodeDaemonErrorLine("DAEMON_PROTOCOL_ERROR", message));
  }

  private dispatch(request: DaemonRequest): void {
    Promise.resolve()
      .then(() => this.handler(request))
      .then(
        (result) => {
          if (this.closed) return;
          try {
            this.stream.write(encodeDaemonResult(request.id, result));
          } catch {
            this.fail(request.id, "DAEMON_RESPONSE_TOO_LARGE", "daemon response exceeds the accepted bound");
          }
        },
        (error) => {
          if (error instanceof DaemonRequestError) this.fail(request.id, error.daemonCode, error.message);
          else this.fail(request.id, "DAEMON_REQUEST_FAILED", "daemon request failed");
        },
      );
  }

  private fail(id: string, code: string, message: string): void {
    if (this.closed) return;
    try {
      this.stream.write(encodeDaemonFailure(id, code, message));
    } catch {
      // The failure line itself cannot be framed — nothing bounded remains to
      // send, so the connection is simply dropped.
      this.closed = true;
      this.stream.destroy();
    }
  }
}

export interface DaemonServer {
  /** The bound `daemon.sock` path. */
  socketPath: string;
  /** Stop listening, drop open connections, and unlink the bound socket path. */
  close(): Promise<void>;
}

export interface DaemonServerOptions {
  /** The resolved endpoint namespace; `daemon.sock` binds inside `dir`. */
  namespace: DaemonNamespace;
  /** The held N1.1 instance lease — re-verified before probe and after bind. */
  lease: DaemonInstanceLease;
  /** The request handler surface; defaults to the N1.2 echo/version plumbing. */
  handler?: DaemonRequestHandler;
  /** The wire version this server speaks; defaults to {@link DAEMON_PROTOCOL_VERSION}. */
  version?: number;
  /** Probe seam for tests; defaults to the real connect probe. */
  probe?: DaemonSocketProbe;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
}

/**
 * Probe an existing `daemon.sock`, clear a stale one, and bind — all only
 * while the N1.1 instance lock is provably held. An answered socket means a
 * live owner (`DAEMON_INSTANCE_HELD`); `ECONNREFUSED` or a vanished path means
 * stale (`unlink` + rebind); any other error fails startup
 * (`DAEMON_INSTANCE_UNAVAILABLE`).
 */
export async function startDaemonServer(options: DaemonServerOptions): Promise<DaemonServer> {
  const { namespace, lease } = options;
  const version = options.version ?? DAEMON_PROTOCOL_VERSION;
  const handler = options.handler ?? defaultDaemonHandler(version);
  const socketPath = join(namespace.dir, DAEMON_SOCKET_NAME);

  await lease.check();

  let verdict: DaemonSocketProbeVerdict;
  try {
    verdict = await (options.probe ?? createDaemonSocketProbe())(socketPath);
  } catch (error) {
    if (error instanceof DaemonInstanceError) throw error;
    throw new DaemonInstanceError("DAEMON_INSTANCE_UNAVAILABLE", "daemon socket probe failed");
  }
  if (verdict === "answered") {
    throw new DaemonInstanceError("DAEMON_INSTANCE_HELD", "daemon socket has a live owner");
  }
  try {
    await unlink(socketPath);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw new DaemonInstanceError("DAEMON_INSTANCE_UNAVAILABLE", "daemon socket path could not be cleared");
    }
  }

  const connections = new Set<DaemonServerConnection>();
  const server = createServer((socket) => {
    const peer: DaemonPeerStream = {
      write: (line) => { socket.write(line); },
      end: (line) => { socket.end(line); },
      destroy: () => { socket.destroy(); },
      onData: (handler) => { socket.on("data", handler); },
      onError: (handler) => { socket.on("error", handler); },
      onClose: (handler) => { socket.on("close", handler); },
    };
    const connection = new DaemonServerConnection(peer, version, handler, () => connections.delete(connection));
    connections.add(connection);
  });

  try {
    await listen(server, socketPath);
  } catch {
    server.close();
    throw new DaemonInstanceError("DAEMON_INSTANCE_UNAVAILABLE", "daemon socket could not be bound");
  }

  try {
    await lease.check();
  } catch (error) {
    server.close();
    throw error;
  }

  let closed = false;
  return {
    socketPath,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const connection of connections) connection.destroy();
      // Node unlinks the bound unix path when the listener closes; anything
      // left behind anyway is the next start's probe's problem, not ours.
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
