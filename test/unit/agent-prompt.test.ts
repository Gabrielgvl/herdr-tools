import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentPromptError, createAgentPromptClient } from "../../src/agent-prompt.js";
import type { SupervisionStream } from "../../src/supervision/socket.js";

interface FakeStream extends SupervisionStream {
  written: string[];
  destroyed: boolean;
  push(line: string): void;
  close(error?: Error): void;
}

function stream(): FakeStream {
  let onData: (chunk: Buffer) => void = () => undefined;
  let onClose: (error?: Error) => void = () => undefined;
  const value: FakeStream = {
    written: [],
    destroyed: false,
    write: (line) => { value.written.push(line); },
    destroy: () => { value.destroyed = true; },
    onData: (handler) => { onData = handler; },
    onClose: (handler) => { onClose = handler; },
    push: (line) => onData(Buffer.from(line, "utf8")),
    close: (error) => onClose(error)
  };
  return value;
}

const env = { HERDR_SOCKET_PATH: "/tmp/herdr-test.sock" };
const signal = new AbortController().signal;
const prompted = { type: "agent_prompted", agent: { pane_id: "w1:p1" } };
const pong = { type: "pong", version: "0.9.0", protocol: 22, capabilities: { endpoint_protocol_generation: 1 } };

async function nextStream(streams: FakeStream[]): Promise<FakeStream> {
  await vi.waitFor(() => {
    expect(streams.length).toBeGreaterThan(0);
    expect(streams.at(-1)!.written).toHaveLength(1);
  });
  return streams.at(-1)!;
}

describe("agent prompt socket transport", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  function client(options: { requestId?: () => string; requestTimeoutMs?: number } = {}) {
    const streams: FakeStream[] = [];
    const connect = vi.fn(async (path: string) => {
      expect(path).toBe(env.HERDR_SOCKET_PATH);
      const value = stream();
      streams.push(value);
      return value;
    });
    cleanups.push(() => streams.splice(0));
    return {
      streams,
      connect,
      client: createAgentPromptClient({ env, connect, requestTimeoutMs: options.requestTimeoutMs, requestId: options.requestId ?? (() => `request-${streams.length + 1}`) })
    };
  }

  it("writes the exact bounded agent.prompt frame and accepts its correlated acknowledgement", async () => {
    const harness = client({ requestId: () => "request-17" });
    const pending = harness.client.prompt("w1:p1", "secret body\nwith lines", signal);
    const socket = await nextStream(harness.streams);
    expect(JSON.parse(socket.written[0]!)).toEqual({ id: "request-17", method: "agent.prompt", params: { target: "w1:p1", text: "secret body\nwith lines" } });
    expect(socket.written[0]).not.toContain('"wait"');
    socket.push(`${JSON.stringify({ id: "request-17", result: prompted })}\n`);
    await expect(pending).resolves.toEqual({ id: "request-17", result: prompted });
    expect(harness.connect).toHaveBeenCalledOnce();
  });

  it("uses a generated request id when none is supplied", async () => {
    const streams: FakeStream[] = [];
    const connect = vi.fn(async () => {
      const value = stream();
      streams.push(value);
      return value;
    });
    const promptClient = createAgentPromptClient({ env, connect });
    const pending = promptClient.prompt("w1:p1", "body", signal);
    const socket = await nextStream(streams);
    const request = JSON.parse(socket.written[0]!) as { id: string };
    expect(request.id).toMatch(/^herdr-tools-/u);
    socket.push(`${JSON.stringify({ id: request.id, result: prompted })}\n`);
    await expect(pending).resolves.toMatchObject({ id: request.id });
  });

  it("uses one fresh connection for each unary prompt or ping", async () => {
    const harness = client({ requestId: (() => { let n = 0; return () => `request-${++n}`; })() });
    const first = harness.client.prompt("w1:p1", "one", signal);
    const firstSocket = await nextStream(harness.streams);
    firstSocket.push(`${JSON.stringify({ id: "request-1", result: prompted })}\n`);
    await first;
    const second = harness.client.ping(signal);
    const secondSocket = await nextStream(harness.streams);
    expect(JSON.parse(secondSocket.written[0]!)).toEqual({ id: "request-2", method: "ping", params: {} });
    secondSocket.push(`${JSON.stringify({ id: "request-2", result: pong })}\n`);
    await expect(second).resolves.toBeUndefined();
    expect(harness.connect).toHaveBeenCalledTimes(2);
  });

  it("reports agent_blocked as rejected without exposing backend text", async () => {
    const harness = client({ requestId: () => "request-blocked" });
    const pending = harness.client.prompt("w1:p1", "body must not escape", signal);
    const socket = await nextStream(harness.streams);
    socket.push(`${JSON.stringify({ id: "request-blocked", error: { code: "agent_blocked", message: "body must not escape" } })}\n`);
    const failure = await pending.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AgentPromptError);
    expect(failure).toMatchObject({ code: "TARGET_BLOCKED", details: { promptDispatch: { state: "rejected", requestId: "request-blocked" } } });
    expect(JSON.stringify(failure)).not.toContain("body must not escape");
  });

  it("marks every post-write uncertainty unknown and never retries", async () => {
    for (const outcome of [
      (socket: FakeStream) => socket.close(new Error("backend secret")),
      (socket: FakeStream) => socket.push(`${JSON.stringify({ id: "request-uncertain", result: { type: "wrong", body: "secret" } })}\n`)
    ]) {
      const harness = client({ requestId: () => "request-uncertain", requestTimeoutMs: 20 });
      const pending = harness.client.prompt("w1:p1", "secret prompt", signal).catch((error: unknown) => error);
      const socket = await nextStream(harness.streams);
      outcome(socket);
      const failure = await pending;
      expect(failure).toMatchObject({ details: { promptDispatch: { state: "unknown", requestId: "request-uncertain" } } });
      expect(harness.connect).toHaveBeenCalledOnce();
      expect(JSON.stringify(failure)).not.toContain("secret");
    }
  });

  it("closes pending unary sockets on shutdown without replay and preserves a settled acknowledgement", async () => {
    let resolveConnect!: (value: FakeStream) => void;
    const connect = vi.fn(() => new Promise<FakeStream>((resolve) => { resolveConnect = resolve; }));
    const client = createAgentPromptClient({ env, connect, requestId: () => "request-shutdown" });
    const pending = client.prompt("w1:p1", "must not be replayed", signal);
    client.close?.();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED", details: { promptDispatch: { state: "not_written" } } });
    const abandoned = stream();
    resolveConnect(abandoned);
    await vi.waitFor(() => expect(abandoned.destroyed).toBe(true));
    expect(abandoned.written).toEqual([]);

    const harness = clientForAcknowledgement();
    const acknowledged = harness.client.prompt("w1:p1", "already acknowledged", signal);
    const socket = await nextStream(harness.streams);
    socket.push(`${JSON.stringify({ id: "request-ack", result: prompted })}\n`);
    harness.client.close?.();
    await expect(acknowledged).resolves.toMatchObject({ id: "request-ack" });
  });

  it("cancels a pending connect from abort and does not replay it", async () => {
    let resolveConnect!: (value: FakeStream) => void;
    const connect = vi.fn(() => new Promise<FakeStream>((resolve) => { resolveConnect = resolve; }));
    const controller = new AbortController();
    const promptClient = createAgentPromptClient({ env, connect, requestId: () => "request-connect-abort" });
    const pending = promptClient.prompt("w1:p1", "body", controller.signal);
    controller.abort();
    promptClient.close?.();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED", details: { promptDispatch: { state: "not_written" } } });
    const abandoned = stream();
    resolveConnect(abandoned);
    await vi.waitFor(() => expect(abandoned.destroyed).toBe(true));
    expect(abandoned.written).toEqual([]);
  });

  it("keeps pre-connect cancellation and synchronous connect failures not_written", async () => {
    const cancelled = { aborted: false, addEventListener: (_type: string, callback: () => void) => { callback(); }, removeEventListener: () => undefined } as unknown as AbortSignal;
    const cancelledConnect = vi.fn();
    const cancelledClient = createAgentPromptClient({
      env,
      connect: cancelledConnect,
      requestId: () => "request-cancelled"
    });
    const cancelledRequest = cancelledClient.prompt("w1:p1", "body", cancelled);
    await expect(cancelledRequest).rejects.toMatchObject({ code: "ABORTED", details: { promptDispatch: { state: "not_written" } } });
    expect(cancelledConnect).not.toHaveBeenCalled();

    const synchronousFailure = createAgentPromptClient({ env, connect: (() => { throw new Error("socket secret"); }) as never, requestId: () => "request-sync-failure" });
    const failure = await synchronousFailure.prompt("w1:p1", "body", signal).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "BACKEND_UNAVAILABLE", details: { promptDispatch: { state: "not_written" } } });
    expect(JSON.stringify(failure)).not.toContain("socket secret");

    const raced = { client: undefined as ReturnType<typeof createAgentPromptClient> | undefined };
    const racedConnect = vi.fn(() => {
      raced.client?.close?.();
      throw new Error("late socket failure");
    });
    raced.client = createAgentPromptClient({ env, connect: racedConnect, requestId: () => "request-generation-race" });
    await expect(raced.client!.prompt("w1:p1", "body", signal)).rejects.toMatchObject({ code: "ABORTED", details: { promptDispatch: { state: "not_written" } } });
  });

  it("closes a socket that aborts during connect or socket setup", async () => {
    const connecting = new AbortController();
    const connectingStream = stream();
    const connectingClient = createAgentPromptClient({ env, connect: async () => { connecting.abort(); return connectingStream; }, requestId: () => "request-connect-race" });
    await expect(connectingClient.prompt("w1:p1", "body", connecting.signal)).rejects.toMatchObject({ code: "ABORTED", details: { promptDispatch: { state: "not_written" } } });
    expect(connectingStream.destroyed).toBe(true);

    const setupSignalValue = {
      aborted: false,
      addEventListener: (_type: string, callback: () => void) => {
        if (setupSignalValue.added++ === 1) {
          setupSignalValue.aborted = true;
          callback();
        }
      },
      removeEventListener: () => undefined,
      added: 0
    };
    const setupSignal = setupSignalValue as unknown as AbortSignal;
    const setupStream = stream();
    const setupClient = createAgentPromptClient({ env, connect: async () => setupStream, requestId: () => "request-setup-race" });
    await expect(setupClient.prompt("w1:p1", "body", setupSignal)).rejects.toMatchObject({ code: "ABORTED", details: { promptDispatch: { state: "not_written" } } });
    expect(setupStream.destroyed).toBe(true);
  });

  it("closes an in-flight unary socket on abort and retains unknown dispatch evidence", async () => {
    const harness = client({ requestId: () => "request-aborted", requestTimeoutMs: 1_000 });
    const controller = new AbortController();
    const pending = harness.client.prompt("w1:p1", "may already be delivered", controller.signal);
    const socket = await nextStream(harness.streams);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED", details: { promptDispatch: { state: "unknown", requestId: "request-aborted" } } });
    expect(socket.destroyed).toBe(true);
    expect(harness.connect).toHaveBeenCalledOnce();
  });

  it("keeps connect, encoding, and pre-write failures not_written", async () => {
    const unavailable = createAgentPromptClient({ env, connect: vi.fn(async () => { throw new Error("socket secret"); }), requestId: () => "request-unavailable" });
    const unavailableFailure = await unavailable.prompt("w1:p1", "secret", signal).catch((error: unknown) => error);
    expect(unavailableFailure).toMatchObject({ code: "BACKEND_UNAVAILABLE", details: { promptDispatch: { state: "not_written" } } });
    expect(JSON.stringify(unavailableFailure)).not.toContain("socket secret");

    const oversized = client({ requestId: () => "request-oversized" });
    const oversizedFailure = await oversized.client.prompt("w1:p1", "x".repeat(262_144), signal).catch((error: unknown) => error);
    expect(oversizedFailure).toMatchObject({ code: "CLI_PROTOCOL_ERROR", details: { promptDispatch: { state: "not_written" } } });
    expect(oversized.connect).not.toHaveBeenCalled();

    const closedSocket = stream();
    closedSocket.onClose = (handler) => handler(new Error("closed"));
    const closedClient = createAgentPromptClient({ env, connect: async () => closedSocket, requestId: () => "request-closed" });
    const closedFailure = await closedClient.prompt("w1:p1", "secret", signal).catch((error: unknown) => error);
    expect(closedFailure).toMatchObject({ code: "PROMPT_DISPATCH_UNKNOWN", details: { promptDispatch: { state: "not_written" } } });
  });

  it("rejects an already-aborted request and incompatible ping acknowledgement", async () => {
    const controller = new AbortController();
    controller.abort();
    const connect = vi.fn();
    const promptClient = createAgentPromptClient({ env, connect });
    await expect(promptClient.prompt("w1:p1", "body", controller.signal)).rejects.toMatchObject({ code: "ABORTED", details: { promptDispatch: { state: "not_written" } } });
    expect(connect).not.toHaveBeenCalled();

    const harness = client({ requestId: () => "request-bad-ping" });
    const pending = harness.client.ping(signal);
    const socket = await nextStream(harness.streams);
    socket.push(`${JSON.stringify({ id: "request-bad-ping", result: { type: "pong", version: "0.9.0", protocol: 22, capabilities: {} } })}\n`);
    await expect(pending).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR", details: { promptDispatch: { state: "unknown", requestId: "request-bad-ping" } } });

    const earlyFailure = client({ requestId: () => "request-bad-ping-early" });
    const earlyPending = earlyFailure.client.ping(signal);
    const earlySocket = await nextStream(earlyFailure.streams);
    earlySocket.push(`${JSON.stringify({ id: "request-bad-ping-early", result: { type: "pong", version: "0.9.0", protocol: 22, capabilities: null } })}\n`);
    await expect(earlyPending).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR", details: { promptDispatch: { state: "unknown", requestId: "request-bad-ping-early" } } });
  });
});

function clientForAcknowledgement(): { streams: FakeStream[]; client: ReturnType<typeof createAgentPromptClient> } {
  const streams: FakeStream[] = [];
  const connect = vi.fn(async () => {
    const value = stream();
    streams.push(value);
    return value;
  });
  return { streams, client: createAgentPromptClient({ env, connect, requestId: () => "request-ack" }) };
}
