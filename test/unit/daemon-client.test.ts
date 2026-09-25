import { chmod, lstat, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectDaemon,
  connectDaemonClient,
  DaemonCallError,
  DaemonClient,
  DaemonClientError,
  DaemonClientSocket,
  type DaemonCallerContext,
  type DaemonRunInput,
} from "../../src/daemon/client.js";
import { acquireDaemonInstance, DaemonInstanceError, type DaemonInstanceLease } from "../../src/daemon/instance.js";
import { resolveDaemonNamespace, type DaemonNamespace } from "../../src/daemon/namespace.js";
import {
  DAEMON_MAX_LINE_BYTES,
  DAEMON_PROTOCOL_VERSION,
  DAEMON_SOCKET_NAME,
  DaemonProtocolError,
  DaemonRequestError,
  encodeDaemonHello,
  encodeDaemonRequest,
} from "../../src/daemon/protocol.js";
import { createDaemonSocketProbe, startDaemonServer, type DaemonRequest, type DaemonServer } from "../../src/daemon/server.js";
import { LAUNCH_DIAGNOSTIC_MARKER, LAUNCH_RECOVERY_GUIDANCE } from "../../src/tools/launch.js";
import type { SupervisionStream } from "../../src/supervision/socket.js";

const dirs: string[] = [];
const servers: DaemonServer[] = [];
const listeners: Server[] = [];
const sockets: Socket[] = [];
const clients: DaemonClientSocket[] = [];
const leases: DaemonInstanceLease[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) client.close();
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) await server.close();
  for (const listener of listeners.splice(0)) await new Promise<void>((resolve) => listener.close(() => resolve()));
  for (const lease of leases.splice(0)) await lease.release();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function namespace(): Promise<DaemonNamespace> {
  const dir = await mkdtemp(join(tmpdir(), "herdr-daemon-"));
  dirs.push(dir);
  return { dir, endpoint: join(dir, "herdr.sock") };
}

function fakeLease(check: () => Promise<void> = async () => undefined): DaemonInstanceLease {
  return { check, release: async () => undefined };
}

async function start(ns: DaemonNamespace, options: Partial<Parameters<typeof startDaemonServer>[0]> = {}): Promise<DaemonServer> {
  const server = await startDaemonServer({ namespace: ns, lease: fakeLease(), ...options });
  servers.push(server);
  return server;
}

async function connect(ns: DaemonNamespace, options: Parameters<typeof connectDaemon>[1] = {}): Promise<DaemonClientSocket> {
  const client = await connectDaemon(ns, options);
  clients.push(client);
  return client;
}

interface FakeStream extends SupervisionStream {
  written: string[];
  destroyed: boolean;
  push(text: string): void;
  pushChunk(chunk: Buffer): void;
  close(error?: Error): void;
}

function fakeStream(): FakeStream {
  let onData: (chunk: Buffer) => void = () => undefined;
  let onClose: (error?: Error) => void = () => undefined;
  const stream: FakeStream = {
    written: [],
    destroyed: false,
    write: (line) => { stream.written.push(line); },
    destroy: () => { stream.destroyed = true; },
    onData: (handler) => { onData = handler; },
    onClose: (handler) => { onClose = handler; },
    push: (text) => onData(Buffer.from(text, "utf8")),
    pushChunk: (chunk) => onData(chunk),
    close: (error) => onClose(error),
  };
  return stream;
}

function socketPath(ns: DaemonNamespace): string {
  return join(ns.dir, DAEMON_SOCKET_NAME);
}

/** A raw socket peer for speaking (or mis-speaking) the wire protocol directly. */
interface RawPeer {
  socket: Socket;
  lines: string[];
  closed: Promise<void>;
  send(text: string): void;
}

async function rawPeer(path: string, options: { allowHalfOpen?: boolean } = {}): Promise<RawPeer> {
  const socket = createConnection({ path, allowHalfOpen: options.allowHalfOpen === true });
  sockets.push(socket);
  const lines: string[] = [];
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      lines.push(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
  });
  const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return { socket, lines, closed, send: (text) => socket.write(text) };
}

async function untilLines(peer: RawPeer, count: number): Promise<void> {
  await vi.waitFor(() => expect(peer.lines.length).toBe(count));
}

describe("daemon server stale-socket probe", () => {
  it("refuses to start when the existing socket answers — a live owner holds it", async () => {
    const ns = await namespace();
    const occupant = createServer();
    listeners.push(occupant);
    await new Promise<void>((resolve) => occupant.listen(socketPath(ns), resolve));
    await expect(startDaemonServer({ namespace: ns, lease: fakeLease() })).rejects.toMatchObject({
      name: "DaemonInstanceError",
      code: "DAEMON_INSTANCE_HELD",
    });
  });

  it("unlinks and rebinds a stale socket the probe refused", async () => {
    const ns = await namespace();
    await writeFile(socketPath(ns), "left by a dead process");
    const server = await start(ns);
    // The garbage file is gone and the path is a real, working socket.
    expect((await lstat(server.socketPath)).isSocket()).toBe(true);
    await expect(connect(ns)).resolves.toBeInstanceOf(DaemonClientSocket);
  });

  it("binds directly when no socket path exists", async () => {
    const ns = await namespace();
    await expect(createDaemonSocketProbe()(socketPath(ns))).resolves.toBe("vanished");
    const server = await start(ns);
    expect((await lstat(server.socketPath)).isSocket()).toBe(true);
  });

  it("rebinds when the path vanishes mid-probe", async () => {
    const ns = await namespace();
    await writeFile(socketPath(ns), "about to vanish");
    const real = createDaemonSocketProbe();
    const server = await start(ns, {
      probe: async (path) => {
        await unlink(path);
        return real(path);
      },
    });
    expect((await lstat(server.socketPath)).isSocket()).toBe(true);
  });

  it("fails startup on any other probe error", async () => {
    const ns = await namespace();
    await writeFile(socketPath(ns), "");
    const eacces = Object.assign(new Error("denied"), { code: "EACCES" });
    await expect(
      startDaemonServer({ namespace: ns, lease: fakeLease(), probe: async () => { throw eacces; } }),
    ).rejects.toMatchObject({ name: "DaemonInstanceError", code: "DAEMON_INSTANCE_UNAVAILABLE" });
    // An instance-typed probe failure propagates unchanged.
    await expect(
      startDaemonServer({
        namespace: ns,
        lease: fakeLease(),
        probe: async () => { throw new DaemonInstanceError("DAEMON_INSTANCE_HELD", "held"); },
      }),
    ).rejects.toMatchObject({ code: "DAEMON_INSTANCE_HELD", message: "held" });
    // A real probe error that is neither refused nor vanished fails startup:
    // a connect into an unsearchable directory is EACCES.
    const dirNs = await namespace();
    const blocked = join(dirNs.dir, "blocked");
    await mkdir(blocked, { mode: 0o000 });
    await expect(createDaemonSocketProbe()(join(blocked, "daemon.sock"))).rejects.toMatchObject({ code: "EACCES" });
    await chmod(blocked, 0o700);
    // A directory occupying the socket path fails startup too.
    await mkdir(socketPath(dirNs));
    await expect(startDaemonServer({ namespace: dirNs, lease: fakeLease() })).rejects.toMatchObject({
      code: "DAEMON_INSTANCE_UNAVAILABLE",
    });
  });

  it("fails startup when the stale path cannot be unlinked", async () => {
    const ns = await namespace();
    await mkdir(socketPath(ns));
    await expect(
      startDaemonServer({ namespace: ns, lease: fakeLease(), probe: async () => "stale" }),
    ).rejects.toMatchObject({ code: "DAEMON_INSTANCE_UNAVAILABLE", message: "daemon socket path could not be cleared" });
  });

  it("fails startup when the socket cannot be bound", async () => {
    const ns = await namespace();
    await chmod(ns.dir, 0o500);
    await expect(
      startDaemonServer({ namespace: ns, lease: fakeLease(), probe: async () => "vanished" }),
    ).rejects.toMatchObject({ code: "DAEMON_INSTANCE_UNAVAILABLE", message: "daemon socket could not be bound" });
    await chmod(ns.dir, 0o700);
  });

  it("runs the probe only while the instance lock is provably held", async () => {
    const ns = await namespace();
    // A lease that is already lost: the probe must never run and no socket binds.
    const probed: string[] = [];
    await expect(
      startDaemonServer({
        namespace: ns,
        lease: fakeLease(async () => { throw new DaemonInstanceError("DAEMON_INSTANCE_UNAVAILABLE", "lock lost"); }),
        probe: async (path) => { probed.push(path); return "vanished"; },
      }),
    ).rejects.toMatchObject({ code: "DAEMON_INSTANCE_UNAVAILABLE", message: "lock lost" });
    expect(probed).toEqual([]);

    // A lease lost between probe and bind completion closes the listener.
    let checks = 0;
    await expect(
      startDaemonServer({
        namespace: ns,
        lease: fakeLease(async () => {
          checks += 1;
          if (checks === 2) throw new DaemonInstanceError("DAEMON_INSTANCE_UNAVAILABLE", "lock lost mid-bind");
        }),
      }),
    ).rejects.toMatchObject({ code: "DAEMON_INSTANCE_UNAVAILABLE", message: "lock lost mid-bind" });
    // Nothing answers the endpoint afterward — a client is refused.
    await expect(connectDaemon(ns)).rejects.toMatchObject({ code: "DAEMON_UNAVAILABLE" });
  });

  it("holds the N1.1 instance lock for the life of the bound socket", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-daemon-"));
    dirs.push(root);
    const endpoint = join(root, "herdr.sock");
    await writeFile(endpoint, "");
    const ns = await resolveDaemonNamespace({ HERDR_SOCKET_PATH: endpoint });
    const lease = await acquireDaemonInstance(ns);
    leases.push(lease);
    const server = await startDaemonServer({ namespace: ns, lease });
    servers.push(server);
    // While the server runs, a second acquirer is refused — the same exclusion
    // the probe relies on when it unlinks a stale socket.
    await expect(acquireDaemonInstance(ns)).rejects.toMatchObject({ code: "DAEMON_INSTANCE_HELD" });
    await server.close();
    await expect(acquireDaemonInstance(ns)).rejects.toMatchObject({ code: "DAEMON_INSTANCE_HELD" });
    await lease.release();
    const next = await acquireDaemonInstance(ns);
    await next.release();
  });
});

describe("daemon socket version handshake", () => {
  it("answers a matching hello with an ack and then serves correlated requests", async () => {
    const ns = await namespace();
    await start(ns);
    const peer = await rawPeer(socketPath(ns));
    peer.send(encodeDaemonHello());
    await untilLines(peer, 1);
    expect(JSON.parse(peer.lines[0]!)).toEqual({ type: "ack", version: DAEMON_PROTOCOL_VERSION });
    peer.send(encodeDaemonRequest("r1", "echo", { text: "hi" }));
    await untilLines(peer, 2);
    expect(JSON.parse(peer.lines[1]!)).toEqual({ id: "r1", result: { text: "hi" } });

    // The N1.2 plumbing handler: `version` reports the wire version and an
    // unknown method is a correlated failure, not a connection failure.
    const client = await connect(ns);
    await expect(client.request("version", {})).resolves.toEqual({ version: DAEMON_PROTOCOL_VERSION });
    await expect(client.request("bogus", {})).rejects.toMatchObject({ daemonCode: "DAEMON_UNKNOWN_METHOD" });
    await expect(client.request("echo", { still: "open" })).resolves.toEqual({ still: "open" });
  });

  it("refuses a version mismatch with exactly one bounded PROTOCOL_MISMATCH line, then closes", async () => {
    const ns = await namespace();
    await start(ns);
    const peer = await rawPeer(socketPath(ns));
    peer.send(encodeDaemonHello(DAEMON_PROTOCOL_VERSION + 1));
    await peer.closed;
    expect(peer.lines).toHaveLength(1);
    const refusal = JSON.parse(peer.lines[0]!);
    expect(refusal).toEqual({ type: "error", error: { code: "PROTOCOL_MISMATCH", message: expect.any(String) } });
    expect(Buffer.byteLength(peer.lines[0]!, "utf8")).toBeLessThan(DAEMON_MAX_LINE_BYTES);
    // No other effect: the daemon still serves a compatible client.
    const client = await connect(ns);
    await expect(client.request("echo", { still: "serving" })).resolves.toEqual({ still: "serving" });
  });

  it("surfaces the daemon's refusal to the client as typed PROTOCOL_MISMATCH", async () => {
    const ns = await namespace();
    await start(ns, { version: DAEMON_PROTOCOL_VERSION + 1 });
    await expect(connectDaemon(ns)).rejects.toSatisfy(
      (error: unknown) => error instanceof DaemonClientError && error.code === "PROTOCOL_MISMATCH",
    );
  });
});

describe("daemon socket connection discipline", () => {
  it("answers a malformed line with exactly one bounded error line, then closes", async () => {
    const ns = await namespace();
    await start(ns);
    const peer = await rawPeer(socketPath(ns), { allowHalfOpen: true });
    peer.send("this is not a frame\n");
    await untilLines(peer, 1);
    expect(JSON.parse(peer.lines[0]!)).toMatchObject({ type: "error", error: { code: "DAEMON_PROTOCOL_ERROR" } });
    // Anything more the peer writes earns nothing further: one error, then close.
    peer.send("more junk\n");
    await new Promise((resolve) => setTimeout(resolve, 30));
    peer.socket.end();
    await peer.closed;
    expect(peer.lines).toHaveLength(1);
  });

  it("refuses a first line that is not a hello", async () => {
    const ns = await namespace();
    await start(ns);
    const peer = await rawPeer(socketPath(ns));
    peer.send(encodeDaemonRequest("r1", "echo", {}));
    await peer.closed;
    expect(peer.lines).toHaveLength(1);
    expect(JSON.parse(peer.lines[0]!)).toMatchObject({ type: "error", error: { code: "DAEMON_PROTOCOL_ERROR" } });
  });

  it("refuses a non-request line after the ack", async () => {
    const ns = await namespace();
    await start(ns);
    const peer = await rawPeer(socketPath(ns));
    peer.send(encodeDaemonHello());
    await untilLines(peer, 1);
    peer.send(encodeDaemonHello());
    await peer.closed;
    expect(peer.lines).toHaveLength(2);
    expect(JSON.parse(peer.lines[1]!)).toMatchObject({ type: "error", error: { code: "DAEMON_PROTOCOL_ERROR" } });
  });

  it("refuses an oversized frame and an oversized buffered line", async () => {
    const ns = await namespace();
    await start(ns);
    const oversized = await rawPeer(socketPath(ns));
    oversized.send(`${"x".repeat(DAEMON_MAX_LINE_BYTES + 1)}\n`);
    await oversized.closed;
    expect(oversized.lines).toHaveLength(1);
    expect(JSON.parse(oversized.lines[0]!)).toMatchObject({ type: "error", error: { code: "DAEMON_PROTOCOL_ERROR" } });

    const unterminated = await rawPeer(socketPath(ns));
    unterminated.send("x".repeat(DAEMON_MAX_LINE_BYTES + 1));
    await unterminated.closed;
    expect(unterminated.lines).toHaveLength(1);
    expect(JSON.parse(unterminated.lines[0]!)).toMatchObject({ type: "error", error: { code: "DAEMON_PROTOCOL_ERROR" } });
  });

  it("keeps each client's responses on its own connection", async () => {
    const ns = await namespace();
    await start(ns, {
      handler: async (request) => {
        await new Promise((resolve) => setTimeout(resolve, Number(request.params.ms ?? 0)));
        return request.params;
      },
    });
    const a = await connect(ns);
    const b = await connect(ns);
    const [resultA, resultB] = await Promise.all([
      a.request("echo", { ms: 40, tag: "a" }),
      b.request("echo", { ms: 0, tag: "b" }),
    ]);
    expect(resultA).toEqual({ ms: 40, tag: "a" });
    expect(resultB).toEqual({ ms: 0, tag: "b" });
    // Correlation on one connection: the later reply still resolves its own request.
    const [slow, fast] = [a.request("echo", { ms: 40, tag: "slow" }), a.request("echo", { ms: 0, tag: "fast" })];
    await expect(fast).resolves.toEqual({ ms: 0, tag: "fast" });
    await expect(slow).resolves.toEqual({ ms: 40, tag: "slow" });
  });

  it("returns correlated failure replies for handler failures", async () => {
    const ns = await namespace();
    await start(ns, {
      handler: (request) => {
        if (request.method === "throw-typed") throw new DaemonRequestError("DAEMON_CUSTOM", "typed failure");
        if (request.method === "throw-plain") throw new Error("internal detail");
        if (request.method === "huge") return "x".repeat(DAEMON_MAX_LINE_BYTES);
        if (request.method === "nothing") return undefined;
        return request.params;
      },
    });
    const client = await connect(ns);
    await expect(client.request("throw-typed", {})).rejects.toMatchObject({ name: "DaemonRequestError", daemonCode: "DAEMON_CUSTOM" });
    await expect(client.request("throw-plain", {})).rejects.toMatchObject({ daemonCode: "DAEMON_REQUEST_FAILED" });
    await expect(client.request("huge", {})).rejects.toMatchObject({ daemonCode: "DAEMON_RESPONSE_TOO_LARGE" });
    await expect(client.request("nothing", {})).resolves.toBeNull();
    await expect(client.request("echo", { done: true })).resolves.toEqual({ done: true });
  });

  it("drops the connection when no bounded failure reply can be framed", async () => {
    const ns = await namespace();
    await start(ns, { handler: () => { throw new DaemonRequestError("DAEMON_X", "boom"); } });
    const peer = await rawPeer(socketPath(ns));
    peer.send(encodeDaemonHello());
    await untilLines(peer, 1);
    // A request id near the bound leaves no room for the failure frame.
    peer.send(encodeDaemonRequest("x".repeat(DAEMON_MAX_LINE_BYTES - 48), "boom", {}));
    await peer.closed;
    expect(peer.lines).toHaveLength(1);
  });

  it("discards handler completions that arrive after the connection drops", async () => {
    const ns = await namespace();
    await start(ns, {
      handler: async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (request.method === "fail-late") throw new Error("late failure");
        return request.params;
      },
    });
    const resolved = await rawPeer(socketPath(ns));
    resolved.send(encodeDaemonHello());
    await untilLines(resolved, 1);
    resolved.send(encodeDaemonRequest("r1", "slow", {}));
    resolved.socket.destroy();
    const rejected = await rawPeer(socketPath(ns));
    rejected.send(encodeDaemonHello());
    await untilLines(rejected, 1);
    rejected.send(encodeDaemonRequest("r2", "fail-late", {}));
    rejected.socket.destroy();
    // Both completions land on dead connections and are dropped; the daemon
    // keeps serving everyone else.
    await new Promise((resolve) => setTimeout(resolve, 60));
    const client = await connect(ns);
    await expect(client.request("echo", { ok: true })).resolves.toEqual({ ok: true });
  });

  it("skips blank framing lines", async () => {
    const ns = await namespace();
    await start(ns);
    const peer = await rawPeer(socketPath(ns));
    peer.send("\n   \n");
    peer.send(encodeDaemonHello());
    await untilLines(peer, 1);
    expect(JSON.parse(peer.lines[0]!)).toMatchObject({ type: "ack" });
  });

  it("closes open connections and unlinks the socket path on close", async () => {
    const ns = await namespace();
    const server = await start(ns, { handler: () => new Promise(() => undefined) });
    const client = await connect(ns);
    const pending = client.request("never", {});
    const dropped = expect(pending).rejects.toMatchObject({ code: "DAEMON_UNAVAILABLE" });
    await server.close();
    await dropped;
    await expect(lstat(socketPath(ns))).rejects.toMatchObject({ code: "ENOENT" });
    // A second close is idempotent, and a restart probes cleanly.
    await server.close();
    await expect(start(ns)).resolves.toBeDefined();
  });

  it("ignores a peer that dies mid-write without disturbing other connections", async () => {
    const ns = await namespace();
    await start(ns);
    const rude = await rawPeer(socketPath(ns));
    // A destroy with unflushed bytes resets the connection; the daemon's side
    // sees a socket error that must not become an unhandled 'error' throw.
    rude.send("unterminated garbage");
    rude.socket.destroy();
    const client = await connect(ns);
    await expect(client.request("echo", { ok: true })).resolves.toEqual({ ok: true });
  });
});

describe("daemon client connect-only contract", () => {
  it("reports a missing socket and a refused connect as DAEMON_UNAVAILABLE", async () => {
    const ns = await namespace();
    await expect(connectDaemon(ns)).rejects.toMatchObject({ name: "DaemonClientError", code: "DAEMON_UNAVAILABLE" });
    await writeFile(socketPath(ns), "stale");
    await expect(connectDaemon(ns)).rejects.toMatchObject({ code: "DAEMON_UNAVAILABLE" });
  });

  it("never spawns a daemon — the client module cannot reach child_process", async () => {
    // ESM exports cannot be spied on, so the connect-only contract is enforced
    // at the source: nothing in the client module may touch process spawning.
    const source = await readFile(new URL("../../src/daemon/client.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/child_process|spawn\(/u);
  });
});

describe("daemon client socket", () => {
  it("writes the hello on connect and opens on the matching ack", async () => {
    const stream = fakeStream();
    const client = new DaemonClientSocket(stream);
    expect(JSON.parse(stream.written[0]!)).toEqual({ type: "hello", version: DAEMON_PROTOCOL_VERSION });
    stream.push(`${JSON.stringify({ type: "ack", version: DAEMON_PROTOCOL_VERSION })}\n`);
    await client.ready;
    const pending = client.request("echo", { x: 1 });
    stream.push(`${JSON.stringify({ id: "herdr-daemon-1", result: { x: 1 } })}\n`);
    await expect(pending).resolves.toEqual({ x: 1 });
    client.close();
    expect(stream.destroyed).toBe(true);
  });

  it("reassembles the ack and replies split across chunks", async () => {
    const stream = fakeStream();
    const client = new DaemonClientSocket(stream);
    const ack = Buffer.from(`${JSON.stringify({ type: "ack", version: DAEMON_PROTOCOL_VERSION })}\n`, "utf8");
    stream.pushChunk(ack.subarray(0, 5));
    stream.pushChunk(ack.subarray(5));
    await client.ready;
  });

  it("fails a mismatched ack or refusal as PROTOCOL_MISMATCH", async () => {
    const wrongAck = fakeStream();
    const first = new DaemonClientSocket(wrongAck);
    wrongAck.push(`${JSON.stringify({ type: "ack", version: DAEMON_PROTOCOL_VERSION + 1 })}\n`);
    await expect(first.ready).rejects.toMatchObject({ code: "PROTOCOL_MISMATCH" });
    expect(wrongAck.destroyed).toBe(true);

    const refused = fakeStream();
    const second = new DaemonClientSocket(refused);
    refused.push(`${JSON.stringify({ type: "error", error: { code: "PROTOCOL_MISMATCH", message: "no" } })}\n`);
    await expect(second.ready).rejects.toMatchObject({ code: "PROTOCOL_MISMATCH" });
  });

  it("drops the connection on any other pre-ack line", async () => {
    for (const line of [
      JSON.stringify({ type: "error", error: { code: "DAEMON_PROTOCOL_ERROR", message: "bad hello" } }),
      JSON.stringify({ id: "x", result: {} }),
      "not json",
    ]) {
      const stream = fakeStream();
      const client = new DaemonClientSocket(stream);
      stream.push(`${line}\n`);
      await expect(client.ready).rejects.toBeInstanceOf(DaemonProtocolError);
      expect(stream.destroyed).toBe(true);
    }
  });

  it("discards data that arrives after the connection failed", async () => {
    const stream = fakeStream();
    const client = new DaemonClientSocket(stream);
    stream.push("not json\n");
    await expect(client.ready).rejects.toBeInstanceOf(DaemonProtocolError);
    // Bytes on a dead connection are dropped, never parsed.
    stream.push(`${JSON.stringify({ type: "ack", version: DAEMON_PROTOCOL_VERSION })}\n`);
    expect(client.closure()).toBeInstanceOf(DaemonProtocolError);
    expect(client.isClosed()).toBe(true);
  });

  it("times out a handshake the peer never answers", async () => {
    const stream = fakeStream();
    const client = new DaemonClientSocket(stream, { requestTimeoutMs: 5 });
    await expect(client.ready).rejects.toMatchObject({ code: "DAEMON_UNAVAILABLE" });
  });

  it("rejects requests after closure and reports the closure reason", async () => {
    const stream = fakeStream();
    const client = new DaemonClientSocket(stream);
    stream.push(`${JSON.stringify({ type: "ack", version: DAEMON_PROTOCOL_VERSION })}\n`);
    await client.ready;
    const pending = client.request("echo", {});
    stream.close(new Error("reset"));
    await expect(pending).rejects.toMatchObject({ code: "DAEMON_UNAVAILABLE", message: expect.stringContaining("reset") });
    expect(client.closure()).toMatchObject({ code: "DAEMON_UNAVAILABLE" });
    await expect(client.request("echo", {})).rejects.toMatchObject({ code: "DAEMON_UNAVAILABLE" });
    stream.close();
  });

  it("rejects in-flight and future requests as unavailable when the daemon drops", async () => {
    const stream = fakeStream();
    const client = new DaemonClientSocket(stream);
    stream.push(`${JSON.stringify({ type: "ack", version: DAEMON_PROTOCOL_VERSION })}\n`);
    await client.ready;
    const pending = client.request("echo", {});
    stream.close();
    await expect(pending).rejects.toMatchObject({ code: "DAEMON_UNAVAILABLE" });
    await expect(client.request("echo", {})).rejects.toMatchObject({ code: "DAEMON_UNAVAILABLE" });
    expect(client.isClosed()).toBe(true);
  });

  it("drops the connection on post-ack lines that are not replies", async () => {
    const stream = fakeStream();
    const client = new DaemonClientSocket(stream);
    const closed: Error[] = [];
    client.onClose((error) => closed.push(error));
    stream.push(`${JSON.stringify({ type: "ack", version: DAEMON_PROTOCOL_VERSION })}\n`);
    await client.ready;
    stream.push(`${JSON.stringify({ type: "hello", version: DAEMON_PROTOCOL_VERSION })}\n`);
    expect(closed[0]).toBeInstanceOf(DaemonProtocolError);
    expect(client.isClosed()).toBe(true);
  });

  it("ignores replies for unknown ids and rejects failure replies as request errors", async () => {
    const stream = fakeStream();
    const client = new DaemonClientSocket(stream);
    stream.push(`${JSON.stringify({ type: "ack", version: DAEMON_PROTOCOL_VERSION })}\n`);
    await client.ready;
    const pending = client.request("echo", {});
    stream.push(`${JSON.stringify({ id: "herdr-daemon-999", result: {} })}\n`);
    stream.push(`${JSON.stringify({ id: "herdr-daemon-1", error: { code: "DAEMON_UNKNOWN_METHOD", message: "no" } })}\n`);
    await expect(pending).rejects.toMatchObject({ name: "DaemonRequestError", daemonCode: "DAEMON_UNKNOWN_METHOD" });
  });

  it("drops the connection on oversized daemon frames", async () => {
    const stream = fakeStream();
    const client = new DaemonClientSocket(stream);
    stream.push(`${JSON.stringify({ type: "ack", version: DAEMON_PROTOCOL_VERSION })}\n`);
    await client.ready;
    stream.push("x".repeat(DAEMON_MAX_LINE_BYTES + 1));
    expect(client.closure()).toBeInstanceOf(DaemonProtocolError);

    const second = fakeStream();
    const secondClient = new DaemonClientSocket(second);
    second.push(`${"x".repeat(DAEMON_MAX_LINE_BYTES)}\n`);
    await expect(secondClient.ready).rejects.toBeInstanceOf(DaemonProtocolError);
  });

  it("times out requests without losing the connection", async () => {
    const stream = fakeStream();
    const client = new DaemonClientSocket(stream, { requestTimeoutMs: 5 });
    stream.push(`${JSON.stringify({ type: "ack", version: DAEMON_PROTOCOL_VERSION })}\n`);
    await client.ready;
    await expect(client.request("echo", {})).rejects.toMatchObject({ code: "DAEMON_UNAVAILABLE" });
    expect(client.isClosed()).toBe(false);
  });

  it("rejects malformed request params and turns write failures into closure", async () => {
    const stream = fakeStream();
    const client = new DaemonClientSocket(stream);
    stream.push(`${JSON.stringify({ type: "ack", version: DAEMON_PROTOCOL_VERSION })}\n`);
    await client.ready;
    await expect(client.request("echo", null as never)).rejects.toBeInstanceOf(DaemonProtocolError);

    for (const thrown of [new Error("hello write died"), "nope"]) {
      const badWrite = fakeStream();
      badWrite.write = () => { throw thrown; };
      const broken = new DaemonClientSocket(badWrite);
      await expect(broken.ready).rejects.toBeDefined();
      expect(broken.closure()).toMatchObject(thrown instanceof Error ? { message: "hello write died" } : { code: "DAEMON_UNAVAILABLE" });
      expect(broken.isClosed()).toBe(true);
    }
  });

  it("turns request-time write failures into closure", async () => {
    for (const thrown of [new Error("write died"), "write died"]) {
      const stream = fakeStream();
      const client = new DaemonClientSocket(stream);
      stream.push(`${JSON.stringify({ type: "ack", version: DAEMON_PROTOCOL_VERSION })}\n`);
      await client.ready;
      stream.write = () => { throw thrown; };
      await expect(client.request("echo", {})).rejects.toBeDefined();
      expect(client.isClosed()).toBe(true);
      expect(client.closure()).toMatchObject(thrown instanceof Error ? { message: "write died" } : { code: "DAEMON_UNAVAILABLE" });
    }
  });
});

describe("daemon typed call layer", () => {
  const caller: DaemonCallerContext = {
    identity: {
      workspaceId: "w",
      tabId: "w:t1",
      paneId: "w:p1",
      agentSession: { source: "native", agent: "pi", kind: "agent", value: "session-1" },
    },
    projectRoot: "/repo",
  };
  const task = { objective: "o", scope: "s", doneWhen: ["d"] };

  /** The typed client over a real socket + server whose handler is the fixture's. */
  async function typedClient(handler: (request: DaemonRequest) => unknown): Promise<{ client: DaemonClient; seen: DaemonRequest[] }> {
    const ns = await namespace();
    const seen: DaemonRequest[] = [];
    await start(ns, {
      handler: (request) => {
        seen.push(request);
        return handler(request);
      },
    });
    const socket = await connect(ns);
    return { client: new DaemonClient(socket, caller), seen };
  }

  const launchReply = (extra: Record<string, unknown> = {}) => ({
    kind: "launch",
    launchId: "L-1",
    state: "completed",
    resumed: false,
    result: { kind: "launch", launchId: "L-1", outcome: "launched", requestedTier: "standard", children: [{ target: "task-x-1", state: "launched" }] },
    children: [{ name: "task-x-1", runId: "run-1" }],
    ...extra,
  });

  it("sends launch with the claimed identity, canonical root, task, and required idempotency key", async () => {
    const reply = launchReply();
    const { client, seen } = await typedClient(() => reply);
    await expect(client.launch({ task, idempotencyKey: "key-1" })).resolves.toEqual(reply);
    expect(seen[0]).toMatchObject({
      method: "launch",
      params: { identity: caller.identity, projectRoot: "/repo", task, idempotencyKey: "key-1" },
    });
  });

  it("preserves the resumed and replayed launch reply variants verbatim", async () => {
    const { client } = await typedClient(() => launchReply({ state: "recorded", resumed: true }));
    await expect(client.launch({ task, idempotencyKey: "key-1" })).resolves.toMatchObject({ state: "recorded", resumed: true });
    const { client: replayed } = await typedClient(() => ({ kind: "launch", launchId: "L-2", state: "completed", replayed: false, children: [{ name: "task-x-1", runId: "run-9" }] }));
    await expect(replayed.launch({ task, idempotencyKey: "key-2" })).resolves.toMatchObject({ replayed: false, children: [{ runId: "run-9" }] });
  });

  it("sends each run action with the claimed identity and returns the typed reply", async () => {
    const inputs: DaemonRunInput[] = [
      { action: "observe", runId: "3F2504E0-4F89-41D3-9A0C-0305E82C3301" },
      { action: "reconcile", idempotencyKey: "key-9" },
      { action: "transfer", runIds: ["3F2504E0-4F89-41D3-9A0C-0305E82C3301"], successorPaneId: "w:p9" },
      { action: "claim", runIds: ["3F2504E0-4F89-41D3-9A0C-0305E82C3301"], incidentId: "claim-1" },
      { action: "ack", eventId: "2026-09-25T141340.499Z-f831c59f-68e4-4b6a-bf8f-10e6866957b2" },
    ];
    for (const input of inputs) {
      const reply = { kind: "run", action: input.action, settled: true };
      const { client, seen } = await typedClient(() => reply);
      await expect(client.run({ ...input })).resolves.toEqual(reply);
      const { action, ...rest } = input;
      expect(seen[0]).toMatchObject({ method: "run", params: { identity: caller.identity, action, ...rest } });
    }
  });

  it("sends status with only the claimed identity, plus the eventId selection when named", async () => {
    const reply = { kind: "status", runs: [], intents: [], unread: { count: 0, ids: [] } };
    const { client, seen } = await typedClient(() => reply);
    await expect(client.status()).resolves.toEqual(reply);
    expect(seen[0]).toMatchObject({ method: "status", params: { identity: caller.identity } });
    const selected = { kind: "status", runs: [], intents: [], unread: { count: 1, ids: ["evt-1"] }, event: { kind: "downtime_gap", id: "evt-1" } };
    const { client: reading, seen: seenRead } = await typedClient(() => selected);
    await expect(reading.status({ eventId: "evt-1" })).resolves.toEqual(selected);
    expect(seenRead[0]).toMatchObject({ method: "status", params: { identity: caller.identity, eventId: "evt-1" } });
  });

  it("strips the client-side caller assertion from every wire payload", async () => {
    const delegated = { paneId: "w:p9", projectRoot: "/delegated" };
    const { client, seen } = await typedClient((request) =>
      request.method === "launch" ? launchReply()
        : request.method === "run" ? { kind: "run", action: (request.params as { action: string }).action, settled: true }
        : { kind: "status", runs: [], intents: [], unread: { count: 0, ids: [] } });
    await client.launch({ task, idempotencyKey: "key-1", caller: delegated });
    await client.run({ action: "ack", eventId: "evt-1", caller: delegated });
    await client.status({ eventId: "evt-2", caller: delegated });
    expect(seen).toHaveLength(3);
    expect(seen[0]).toMatchObject({ method: "launch", params: { identity: caller.identity, task, idempotencyKey: "key-1" } });
    expect(seen[1]).toMatchObject({ method: "run", params: { identity: caller.identity, action: "ack", eventId: "evt-1" } });
    expect(seen[2]).toMatchObject({ method: "status", params: { identity: caller.identity, eventId: "evt-2" } });
    for (const request of seen) expect(request.params).not.toHaveProperty("caller");
  });

  it("refuses replies that are not the method's documented shape", async () => {
    const malformed = [null, 7, "result", { kind: "run" }, { kind: "launch", launchId: "L", state: "bogus", children: [] }, { kind: "launch", launchId: "L", state: "completed", children: [] }];
    for (const reply of malformed) {
      const { client } = await typedClient(() => reply);
      await expect(client.launch({ task, idempotencyKey: "key-1" })).rejects.toMatchObject({ name: "DaemonCallError", code: "DAEMON_REPLY_MALFORMED" });
      await expect(client.status()).rejects.toMatchObject({ code: "DAEMON_REPLY_MALFORMED" });
      await expect(client.run({ action: "observe", runId: "3F2504E0-4F89-41D3-9A0C-0305E82C3301" })).rejects.toMatchObject({ code: "DAEMON_REPLY_MALFORMED" });
    }
  });

  it("projects every daemon refusal code to exactly one bounded typed error, never wire text", async () => {
    const codes = [
      "DAEMON_UNKNOWN_METHOD", "DAEMON_REQUEST_FAILED", "DAEMON_RESPONSE_TOO_LARGE",
      "REQUEST_INVALID", "PROJECT_ROOT_UNVERIFIED",
      "CALLER_IDENTITY_MALFORMED", "CALLER_IDENTITY_UNPROVEN", "CALLER_IDENTITY_MISMATCH",
      "MANAGER_SESSION_UNAVAILABLE", "SNAPSHOT_UNAVAILABLE",
      "IDEMPOTENCY_KEY_CONFLICT", "INTENT_NOT_FOUND", "INTENT_STORE_UNAVAILABLE", "INTENT_MALFORMED", "INTENT_REQUEST_INVALID", "INTENT_STATE_CONFLICT",
      "LAUNCH_FAILED", "ABORTED", "PROMPT_UNCONFIRMED", "MAILBOX_CAPACITY", "NOT_IMPLEMENTED",
      "OWNER_UNAVAILABLE", "OWNER_MISMATCH", "OWNER_PRESENT", "OWNER_INTENT_UNRESOLVED",
      "OWNERSHIP_UNAVAILABLE", "OWNERSHIP_UNTRUSTED", "SUCCESSOR_UNPROVEN",
      "TRANSFER_PENDING", "TRANSFER_EVENT_FAILED", "TRANSFER_MALFORMED", "RUN_IDS_INVALID", "CLAIM_NOT_INSTRUCTED",
      "DAEMON_STATUS_UNAVAILABLE", "MAILBOX_UNAVAILABLE", "MAILBOX_EVENT_INVALID", "MAILBOX_EVENT_NOT_FOUND",
    ];
    for (const code of codes) {
      for (const method of ["launch", "status"] as const) {
        const { client } = await typedClient(() => { throw new DaemonRequestError(code, "daemon-internal refusal text that must not cross"); });
        const call = method === "launch" ? client.launch({ task, idempotencyKey: "key-1" }) : client.status();
        const error = await call.then(() => { throw new Error("expected refusal"); }, (failure: unknown) => failure);
        expect(error).toBeInstanceOf(DaemonCallError);
        const projected = error as DaemonCallError;
        expect(projected.code).toBe(code);
        expect(projected.message).not.toContain("must not cross");
        if (method === "launch") expect(projected.details.effectCertainty).toBeDefined();
      }
    }
  });

  it("projects a wire refusal that violates the single-line bound as a protocol violation, not a refusal", async () => {
    // Wire error text is single-line only (`requiredString` rejects \n) — a
    // frame carrying a multi-line message, including one that embeds the
    // launch diagnostic marker, is not a refusal at all.
    const diagnostic = { code: "LAUNCH_FAILED", phase: "placement", created: { paneId: "w:p9" }, agentStarted: true, promptSubmitted: false, recipientRegistered: false, effectCertainty: "partial", recoveryGuidance: LAUNCH_RECOVERY_GUIDANCE.inspectBeforeRetry };
    const marked = `failure\n${LAUNCH_DIAGNOSTIC_MARKER} ${JSON.stringify(diagnostic)}`;
    const { client } = await typedClient(() => { throw new DaemonRequestError("LAUNCH_FAILED", marked); });
    await expect(client.launch({ task, idempotencyKey: "key-1" })).rejects.toMatchObject({ name: "DaemonCallError", code: "DAEMON_PROTOCOL_ERROR" });
  });

  it("projects launch refusals fail-closed: effectCertainty is never absent and wire text never crosses", async () => {
    // The daemon's wire refusal carries only a bounded code; the launcher's
    // true certainty lives in the intent record. A bare code can never prove
    // the launch had no effect, so the projection must say `unknown` — a
    // caller that reads certainty absent or `failed`-looking text could
    // relaunch into live children.
    const { client } = await typedClient(() => { throw new DaemonRequestError("LAUNCH_FAILED", "single-line wire refusal text that must not cross"); });
    const error = await client.launch({ task, idempotencyKey: "key-1" }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(DaemonCallError);
    expect(error).toMatchObject({ code: "LAUNCH_FAILED" });
    expect((error as DaemonCallError).details.effectCertainty).toBe("unknown");
    expect((error as DaemonCallError).effectCertainty).toBe("unknown");
    expect((error as Error).message).not.toContain("must not cross");

    // run/status refusals carry no launch effect fields.
    const { client: other } = await typedClient(() => { throw new DaemonRequestError("INTENT_NOT_FOUND"); });
    const runError = await other.run({ action: "reconcile", idempotencyKey: "key-1" }).catch((failure: unknown) => failure);
    expect(runError).toMatchObject({ name: "DaemonCallError", code: "INTENT_NOT_FOUND" });
    expect((runError as DaemonCallError).details.effectCertainty).toBeUndefined();
  });

  it("keeps the N1.3 failed-versus-unresolved rule readable from projected launch replies", async () => {
    // Post-effect failure: the daemon recorded children with partial certainty —
    // the intent settles `unresolved`, and the surviving-resource fields ride
    // the reply so the caller inspects rather than relaunches.
    const unresolvedReply = {
      kind: "launch",
      launchId: "L-3",
      state: "unresolved",
      resumed: false,
      result: {
        kind: "launch", launchId: "L-3", outcome: "failed", requestedTier: "standard",
        children: [{
          target: "task-x-1", state: "failed", effectCertainty: "partial",
          error: { code: "PROMPT_UNCONFIRMED", paneId: "w:p9", tabId: "w:t9", supervisorJobId: "job_9", effectCertainty: "partial" },
        }],
      },
      children: [{ name: "task-x-1", runId: "run-3" }],
    };
    const { client } = await typedClient(() => unresolvedReply);
    const reply = await client.launch({ task, idempotencyKey: "key-1" });
    expect(reply.state).toBe("unresolved");
    expect(reply.children[0]).toMatchObject({ runId: "run-3" });
    const failed = reply as { result?: { children: Array<{ error?: Record<string, unknown> }> } };
    expect(failed.result?.children[0]?.error).toMatchObject({ effectCertainty: "partial", paneId: "w:p9", tabId: "w:t9", supervisorJobId: "job_9" });

    // Provably absent effect with zero recorded children is the only `failed`.
    const { client: absent } = await typedClient(() => ({ kind: "launch", launchId: "L-4", state: "failed", resumed: false, result: { kind: "launch", launchId: "L-4", outcome: "failed", requestedTier: "standard", children: [] }, children: [] }));
    await expect(absent.launch({ task, idempotencyKey: "key-2" })).resolves.toMatchObject({ state: "failed", children: [] });
  });

  it("projects transport failure, request timeout, and mid-call drop as DAEMON_UNAVAILABLE", async () => {
    const ns = await namespace();
    await expect(connectDaemonClient({ dir: join(ns.dir, "absent"), endpoint: ns.endpoint }, caller)).rejects.toMatchObject({ code: "DAEMON_UNAVAILABLE" });

    // The server never replies; bound the wait through the socket options.
    const ns2 = await namespace();
    await start(ns2, { handler: () => new Promise(() => undefined) });
    const slow = await connectDaemonClient(ns2, caller, { requestTimeoutMs: 40 });
    await expect(slow.status()).rejects.toMatchObject({ name: "DaemonCallError", code: "DAEMON_UNAVAILABLE" });

    const stream = fakeStream();
    const socket = new DaemonClientSocket(stream);
    stream.push(`${JSON.stringify({ type: "ack", version: DAEMON_PROTOCOL_VERSION })}\n`);
    await socket.ready;
    const dropped = new DaemonClient(socket, caller);
    const pending = dropped.status();
    stream.close();
    await expect(pending).rejects.toMatchObject({ code: "DAEMON_UNAVAILABLE" });
  });

  it("marks even a mid-flight transport drop of launch as effect-unknown, never bare failed", async () => {
    // The daemon may have received and executed the request before the socket
    // died — this is exactly the relaunch-into-live-children window, so the
    // projected error must carry `unknown` certainty, not silence.
    const stream = fakeStream();
    const socket = new DaemonClientSocket(stream);
    stream.push(`${JSON.stringify({ type: "ack", version: DAEMON_PROTOCOL_VERSION })}\n`);
    await socket.ready;
    const client = new DaemonClient(socket, caller);
    const pending = client.launch({ task, idempotencyKey: "key-1" });
    stream.close();
    const error = await pending.catch((failure: unknown) => failure);
    expect(error).toMatchObject({ name: "DaemonCallError", code: "DAEMON_UNAVAILABLE" });
    expect((error as DaemonCallError).effectCertainty).toBe("unknown");
  });

  it("projects a version refusal as PROTOCOL_MISMATCH", async () => {
    const stream = fakeStream();
    const socket = new DaemonClientSocket(stream);
    stream.push(`${JSON.stringify({ type: "ack", version: DAEMON_PROTOCOL_VERSION + 1 })}\n`);
    const client = new DaemonClient(socket, caller);
    await expect(socket.ready).rejects.toMatchObject({ code: "PROTOCOL_MISMATCH" });
    await expect(client.status()).rejects.toMatchObject({ name: "DaemonCallError", code: "PROTOCOL_MISMATCH" });
  });

  it("projects framing violations as DAEMON_PROTOCOL_ERROR", async () => {
    const stream = fakeStream();
    const socket = new DaemonClientSocket(stream);
    stream.push(`${JSON.stringify({ type: "ack", version: DAEMON_PROTOCOL_VERSION })}\n`);
    await socket.ready;
    const client = new DaemonClient(socket, caller);
    const pending = client.status();
    stream.push(`${JSON.stringify({ type: "bogus" })}\n`);
    await expect(pending).rejects.toMatchObject({ name: "DaemonCallError", code: "DAEMON_PROTOCOL_ERROR" });
  });
});

describe("daemon mailbox surface over the wire", () => {
  const caller: DaemonCallerContext = {
    identity: {
      workspaceId: "w",
      tabId: "w:t1",
      paneId: "w:p1",
      agentSession: { source: "native", agent: "pi", kind: "agent", value: "session-1" },
    },
    projectRoot: "/repo",
  };

  /** The typed client over a real socket + server whose handler is the fixture's. */
  async function typedClient(handler: (request: DaemonRequest) => unknown): Promise<{ client: DaemonClient; seen: DaemonRequest[] }> {
    const ns = await namespace();
    const seen: DaemonRequest[] = [];
    await start(ns, {
      handler: (request) => {
        seen.push(request);
        return handler(request);
      },
    });
    const socket = await connect(ns);
    return { client: new DaemonClient(socket, caller), seen };
  }

  it("sends ack as the idempotent run operation and status as the read projection", async () => {
    const acked = { kind: "run", action: "ack", eventId: "evt-1", result: "acked" };
    const { client, seen } = await typedClient(() => acked);
    await expect(client.run({ action: "ack", eventId: "evt-1" })).resolves.toEqual(acked);
    expect(seen[0]).toMatchObject({ method: "run", params: { identity: caller.identity, action: "ack", eventId: "evt-1" } });
  });

  it("projects transport-level and typed rejections into the one bounded call error", async () => {
    const failing = (error: unknown) => new DaemonClient({
      request: async () => { throw error; },
      close: () => undefined,
      isClosed: () => true,
    } as unknown as DaemonClientSocket, caller);
    // A DaemonCallError passes through untouched.
    const typed = new DaemonCallError("SOME_CODE", "already bounded");
    await expect(failing(typed).status()).rejects.toBe(typed);
    // A wire refusal whose daemonCode is not wire-safe degrades to the generic code.
    await expect(failing(new DaemonRequestError("lowercase code")).status()).rejects.toMatchObject({ code: "DAEMON_REQUEST_FAILED" });
    // A typed peer keeps its code even without an Error shape or details record.
    await expect(failing({ code: "CUSTOM_CODE" }).status()).rejects.toMatchObject({ code: "CUSTOM_CODE", message: "daemon status call failed" });
    await expect(failing(Object.assign(new Error("nope"), { code: "EDGE_CODE" })).status()).rejects.toMatchObject({ code: "EDGE_CODE", message: "nope" });
    // Non-record and code-free failures are transport-class refusals.
    await expect(failing("socket gone").status()).rejects.toMatchObject({ code: "DAEMON_UNAVAILABLE" });
    await expect(failing({ code: "lowercase" }).status()).rejects.toMatchObject({ code: "DAEMON_UNAVAILABLE" });
    // A failed launch additionally carries the unknown-effect certainty.
    await expect(failing(new Error("dropped")).launch({ task: { objective: "o", scope: "s", doneWhen: ["d"] }, idempotencyKey: "k" }))
      .rejects.toMatchObject({ code: "DAEMON_UNAVAILABLE", details: { effectCertainty: "unknown" } });
  });

  it("closes the underlying socket and reports itself closed", async () => {
    const ns = await namespace();
    await start(ns, { handler: async () => ({ kind: "status" }) });
    const socket = await connect(ns);
    const client = new DaemonClient(socket, caller);
    expect(client.isClosed()).toBe(false);
    client.close();
    expect(client.isClosed()).toBe(true);
  });
});
