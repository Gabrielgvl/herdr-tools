import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNodeSupervisionConnect,
  resolveSocketPath,
  SupervisionRequestError,
  SupervisionSocket,
  SupervisionSocketError,
  type SupervisionStream,
} from "../../src/supervision/socket.js";
import { SupervisionProtocolError, SUPERVISION_MAX_LINE_BYTES } from "../../src/supervision/protocol.js";

interface FakeStream extends SupervisionStream {
  written: string[];
  destroyed: boolean;
  push(line: string): void;
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
    push: (line) => onData(Buffer.from(line, "utf8")),
    pushChunk: (chunk) => onData(chunk),
    close: (error) => onClose(error),
  };
  return stream;
}

const servers: Server[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function listen(onConnection: (socket: Socket) => void): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), "herdr-supervision-"));
  directories.push(directory);
  const path = join(directory, "herdr.sock");
  const server = createServer(onConnection);
  servers.push(server);
  return new Promise((resolve) => server.listen(path, () => resolve(path)));
}

describe("supervision socket path resolution", () => {
  it("refuses to guess a socket path", () => {
    expect(resolveSocketPath({ HERDR_SOCKET_PATH: "/tmp/x.sock" })).toBe("/tmp/x.sock");
    for (const env of [{}, { HERDR_SOCKET_PATH: "" }, { HERDR_SOCKET_PATH: "/tmp/a\nb" }]) {
      expect(() => resolveSocketPath(env)).toThrow(SupervisionSocketError);
      expect(() => resolveSocketPath(env)).toThrow(/HERDR_SOCKET_PATH is missing or malformed/u);
    }
  });
});

describe("supervision socket framing and correlation", () => {
  it("correlates replies by id, ignores unknown ids, and rejects server failures", async () => {
    const stream = fakeStream();
    const socket = new SupervisionSocket(stream, 1_000);
    const pending = socket.request("session.snapshot", {});
    expect(JSON.parse(stream.written[0]!)).toEqual({ id: "herdr-tools-1", method: "session.snapshot", params: {} });
    stream.push(`${JSON.stringify({ id: "herdr-tools-999", result: {} })}\n`);
    stream.push(`${JSON.stringify({ id: "herdr-tools-1", result: { ok: true } })}\n`);
    await expect(pending).resolves.toEqual({ ok: true });

    const failing = socket.request("session.snapshot", {});
    stream.push(`${JSON.stringify({ id: "herdr-tools-2", error: { code: "denied", message: "no" } })}\n`);
    await expect(failing).rejects.toBeInstanceOf(SupervisionRequestError);
    socket.close();
  });

  it("issues a caller-correlated request ID and reports the write boundary", async () => {
    const stream = fakeStream();
    const socket = new SupervisionSocket(stream, 1_000);
    let writeInvoked = false;
    const pending = socket.requestCorrelated("request-17", "agent.prompt", { target: "w1:p1", text: "hello" }, () => { writeInvoked = true; });
    expect(writeInvoked).toBe(true);
    expect(JSON.parse(stream.written[0]!)).toEqual({ id: "request-17", method: "agent.prompt", params: { target: "w1:p1", text: "hello" } });
    stream.push(`${JSON.stringify({ id: "request-17", result: { type: "agent_prompted", agent: {} } })}\n`);
    await expect(pending).resolves.toEqual({ id: "request-17", result: { type: "agent_prompted", agent: {} } });
    socket.close();
  });

  it("times out a request without leaving the connection unusable", async () => {
    const stream = fakeStream();
    const socket = new SupervisionSocket(stream, 5);
    await expect(socket.request("ping", {})).rejects.toMatchObject({ code: "SUPERVISION_REQUEST_TIMEOUT" });
    expect(socket.isClosed()).toBe(false);
    socket.close();
    await expect(socket.request("ping", {})).rejects.toMatchObject({ code: "SUPERVISION_SOCKET_CLOSED" });
  });

  it("reassembles lines split across chunks and never splits a code point", async () => {
    const stream = fakeStream();
    const socket = new SupervisionSocket(stream, 1_000);
    const events: unknown[] = [];
    socket.onEvent((event) => events.push(event));
    const subscribing = socket.subscribe();
    stream.push(`${JSON.stringify({ id: "herdr-tools-1", result: { type: "subscription_started" } })}\n`);
    await subscribing;

    const payload = Buffer.from(`${JSON.stringify({ event: "pane_closed", data: { type: "pane_closed", pane_id: "p😀1", workspace_id: "w1" } })}\n`, "utf8");
    stream.pushChunk(payload.subarray(0, 40));
    stream.pushChunk(payload.subarray(40));
    expect(events).toHaveLength(1);
    // Blank framing lines are skipped rather than refused.
    stream.push("\n   \n");
    expect(events).toHaveLength(1);
    socket.close();
  });

  it("refuses an event that arrives before the subscription acknowledgement", () => {
    const stream = fakeStream();
    const socket = new SupervisionSocket(stream, 1_000);
    const closed: Error[] = [];
    socket.onClose((error) => closed.push(error));
    stream.push(`${JSON.stringify({ event: "pane_closed", data: { type: "pane_closed", pane_id: "p1", workspace_id: "w1" } })}\n`);
    expect(closed[0]).toBeInstanceOf(SupervisionProtocolError);
    expect(socket.isClosed()).toBe(true);
    expect(stream.destroyed).toBe(true);
  });

  it("drops the connection on a malformed line, an oversized frame, or a peer close", async () => {
    const malformed = fakeStream();
    const first = new SupervisionSocket(malformed, 1_000);
    const pending = first.request("ping", {});
    malformed.push("not json\n");
    await expect(pending).rejects.toBeInstanceOf(SupervisionProtocolError);
    // Data after the failure is discarded rather than parsed.
    malformed.push(`${JSON.stringify({ id: "herdr-tools-1", result: {} })}\n`);
    expect(first.isClosed()).toBe(true);

    const oversized = fakeStream();
    const second = new SupervisionSocket(oversized, 1_000);
    const closed: Error[] = [];
    second.onClose((error) => closed.push(error));
    oversized.push("x".repeat(SUPERVISION_MAX_LINE_BYTES + 1));
    expect(closed[0]).toBeInstanceOf(SupervisionProtocolError);

    const oversizedFrame = fakeStream();
    const frameSocket = new SupervisionSocket(oversizedFrame, 1_000);
    const frameClosed: Error[] = [];
    frameSocket.onClose((error) => frameClosed.push(error));
    oversizedFrame.push(`${"x".repeat(SUPERVISION_MAX_LINE_BYTES)}\n`);
    expect(frameClosed[0]).toBeInstanceOf(SupervisionProtocolError);

    const dropped = fakeStream();
    const third = new SupervisionSocket(dropped, 1_000);
    const inflight = third.request("ping", {});
    dropped.close(new Error("reset"));
    await expect(inflight).rejects.toThrow(/reset/u);
    // A second close is idempotent.
    dropped.close();
    expect(third.isClosed()).toBe(true);

    const peer = fakeStream();
    const fourth = new SupervisionSocket(peer, 1_000);
    const waiting = fourth.request("ping", {});
    peer.close();
    await expect(waiting).rejects.toMatchObject({ code: "SUPERVISION_SOCKET_CLOSED" });
  });

  it("refuses a subscription the server does not acknowledge", async () => {
    const stream = fakeStream();
    const socket = new SupervisionSocket(stream, 1_000);
    const subscribing = socket.subscribe();
    stream.push(`${JSON.stringify({ id: "herdr-tools-1", result: { type: "pong" } })}\n`);
    await expect(subscribing).rejects.toBeInstanceOf(SupervisionProtocolError);
    socket.close();
  });

  it("refuses malformed or duplicate correlated requests before writing", async () => {
    const stream = fakeStream();
    const socket = new SupervisionSocket(stream, 1_000);
    await expect(socket.requestCorrelated("bad\nid", "ping", {})).rejects.toBeInstanceOf(SupervisionProtocolError);
    const pending = socket.requestCorrelated("request-1", "ping", {});
    await expect(socket.requestCorrelated("request-1", "ping", {})).rejects.toMatchObject({ code: "SUPERVISION_PROTOCOL_ERROR" });
    await expect(socket.request("ping", null as never)).rejects.toMatchObject({ code: "SUPERVISION_PROTOCOL_ERROR" });
    socket.close();
    await expect(pending).rejects.toMatchObject({ code: "SUPERVISION_SOCKET_CLOSED" });
  });

  it("turns write failures into socket closure errors", async () => {
    const errorStream = fakeStream();
    errorStream.write = () => { throw new Error("write failed"); };
    const errorSocket = new SupervisionSocket(errorStream, 1_000);
    await expect(errorSocket.request("ping", {})).rejects.toThrow("write failed");

    const valueStream = fakeStream();
    valueStream.write = () => { throw "write failed"; };
    const valueSocket = new SupervisionSocket(valueStream, 1_000);
    await expect(valueSocket.request("ping", {})).rejects.toMatchObject({ code: "SUPERVISION_SOCKET_CLOSED" });
  });
});

describe("the node socket connector", () => {
  it("connects to a real unix socket and carries a full request round trip", async () => {
    const path = await listen((socket) => {
      socket.on("data", (chunk) => {
        const request = JSON.parse(chunk.toString("utf8").trim()) as { id: string };
        socket.write(`${JSON.stringify({ id: request.id, result: { type: "pong" } })}\n`);
      });
    });
    const stream = await createNodeSupervisionConnect()(path);
    const socket = new SupervisionSocket(stream, 2_000);
    await expect(socket.request("ping", {})).resolves.toEqual({ type: "pong" });
    socket.close();
  });

  it("reports an unopenable socket", async () => {
    await expect(createNodeSupervisionConnect()(join(tmpdir(), "herdr-missing.sock"))).rejects.toMatchObject({ code: "SUPERVISION_SOCKET_UNAVAILABLE" });
  });

  it("bounds a connect that never completes and ignores a late connect or error", async () => {
    const listeners = new Map<string, Array<(value?: unknown) => void>>();
    let destroyed = 0;
    const silent = {
      once: (event: string, listener: (value?: unknown) => void) => { listeners.set(event, [...(listeners.get(event) ?? []), listener]); },
      on: (event: string, listener: (value?: unknown) => void) => { listeners.set(event, [...(listeners.get(event) ?? []), listener]); },
      setNoDelay: () => undefined,
      write: () => undefined,
      destroy: () => { destroyed += 1; },
    };
    const connect = createNodeSupervisionConnect(1, () => silent as never);
    await expect(connect("/tmp/never.sock")).rejects.toMatchObject({ code: "SUPERVISION_SOCKET_UNAVAILABLE" });
    expect(destroyed).toBe(1);
    // A connect or error that lands after the bound already rejected is ignored.
    for (const listener of listeners.get("connect") ?? []) listener();
    for (const listener of listeners.get("error") ?? []) listener(new Error("late"));
    expect(destroyed).toBe(1);
  });

  it("surfaces a peer reset through onClose", async () => {
    const path = await listen((socket) => socket.destroy());
    const stream = await createNodeSupervisionConnect()(path);
    const socket = new SupervisionSocket(stream, 2_000);
    const pending = socket.request("ping", {});
    await expect(pending).rejects.toBeDefined();
  });
});

describe("subscription acknowledgement atomicity", () => {
  it("accepts an acknowledgement and its first replay event delivered in one chunk", async () => {
    const stream = fakeStream();
    const socket = new SupervisionSocket(stream, 1_000);
    const events: unknown[] = [];
    const closed: Error[] = [];
    socket.onEvent((event) => events.push(event));
    socket.onClose((error) => closed.push(error));
    const subscribing = socket.subscribe();
    // The transport is free to coalesce these; the acknowledgement must take
    // effect before the next line in the same chunk is consumed.
    stream.push([
      JSON.stringify({ id: "herdr-tools-1", result: { type: "subscription_started" } }),
      JSON.stringify({ event: "pane_closed", data: { type: "pane_closed", pane_id: "p1", workspace_id: "w1" } }),
      "",
    ].join("\n"));
    await expect(subscribing).resolves.toBeUndefined();
    expect(events).toHaveLength(1);
    expect(closed).toEqual([]);
    expect(socket.isClosed()).toBe(false);
    socket.close();
  });

  it("rejects the subscription and closes when the acknowledgement is wrong, even coalesced", async () => {
    const stream = fakeStream();
    const socket = new SupervisionSocket(stream, 1_000);
    const events: unknown[] = [];
    socket.onEvent((event) => events.push(event));
    const subscribing = socket.subscribe();
    stream.push([
      JSON.stringify({ id: "herdr-tools-1", result: { type: "pong" } }),
      JSON.stringify({ event: "pane_closed", data: { type: "pane_closed", pane_id: "p1", workspace_id: "w1" } }),
      "",
    ].join("\n"));
    await expect(subscribing).rejects.toBeInstanceOf(SupervisionProtocolError);
    expect(events).toEqual([]);
    expect(socket.isClosed()).toBe(true);
    expect(socket.closure()).toBeInstanceOf(SupervisionProtocolError);
  });
});
