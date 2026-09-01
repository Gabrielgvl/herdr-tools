import { describe, expect, it, vi } from "vitest";
import { SessionEventMonitor, type MonitorClock, type SupervisionObserver } from "../../src/supervision/monitor.js";
import type { SupervisionStream } from "../../src/supervision/socket.js";
import type { SupervisionSocketEvent } from "../../src/supervision/protocol.js";
import type { HerdrSnapshot } from "../../src/targets.js";

const snapshotResult = {
  type: "session_snapshot",
  snapshot: { version: "0.8.2", protocol: 20, workspaces: [], tabs: [], panes: [], agents: [] },
};

interface Peer {
  stream: SupervisionStream;
  written: Array<{ id: string; method: string }>;
  reply(id: string, result: unknown): void;
  push(line: string): void;
  close(): void;
  destroyed: boolean;
}

/** A scripted server peer that answers `session.snapshot` and `events.subscribe`. */
function peer(options: { failSubscribe?: boolean } = {}): Peer {
  let onData: (chunk: Buffer) => void = () => undefined;
  let onClose: (error?: Error) => void = () => undefined;
  const state: Peer = {
    written: [],
    destroyed: false,
    stream: {
      write: (line) => {
        const request = JSON.parse(line) as { id: string; method: string };
        state.written.push(request);
        queueMicrotask(() => {
          if (request.method === "session.snapshot") state.reply(request.id, snapshotResult);
          else if (options.failSubscribe) state.reply(request.id, { type: "pong" });
          else state.reply(request.id, { type: "subscription_started" });
        });
      },
      destroy: () => { state.destroyed = true; },
      onData: (handler) => { onData = handler; },
      onClose: (handler) => { onClose = handler; },
    },
    reply: (id, result) => onData(Buffer.from(`${JSON.stringify({ id, result })}\n`, "utf8")),
    push: (line) => onData(Buffer.from(line, "utf8")),
    close: () => onClose(),
  };
  return state;
}

function observer(paneId: string) {
  const events: SupervisionSocketEvent[] = [];
  const bootstraps: Array<{ generation: number; reconnected: boolean }> = [];
  const degraded: string[] = [];
  let recovered = 0;
  const value: SupervisionObserver & { events: typeof events; bootstraps: typeof bootstraps; degraded: typeof degraded; recovered: () => number } = {
    matches: (candidate) => candidate === paneId,
    onEvent: async (event) => { events.push(event); },
    onBootstrap: async (_snapshot: HerdrSnapshot, generation, reconnected) => { bootstraps.push({ generation, reconnected }); },
    onMonitorDegraded: (reason) => { degraded.push(reason); },
    onMonitorRecovered: () => { recovered += 1; },
    events,
    bootstraps,
    degraded,
    recovered: () => recovered,
  };
  return value;
}

const instantClock: MonitorClock = { now: () => Date.now(), sleep: async () => undefined };

describe("the session event monitor", () => {
  it("bootstraps snapshot-then-subscribe exactly once for concurrent callers", async () => {
    const server = peer();
    const connect = vi.fn(async () => server.stream);
    const monitor = new SessionEventMonitor({ connect, env: { HERDR_SOCKET_PATH: "/tmp/s.sock" }, clock: instantClock });
    const [first, second] = await Promise.all([monitor.ensureStarted(), monitor.ensureStarted()]);
    expect(first.protocol).toBe(20);
    expect(second.protocol).toBe(20);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(server.written.map((request) => request.method)).toEqual(["session.snapshot", "events.subscribe"]);
    expect(monitor.generation).toBe(1);
    // A live connection answers a later ensureStarted with a fresh snapshot only.
    await monitor.ensureStarted();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(server.written).toHaveLength(3);
    monitor.stop();
  });

  it("refuses to start without a socket path, and after shutdown", async () => {
    const unset = new SessionEventMonitor({ connect: async () => peer().stream, env: {}, clock: instantClock });
    await expect(unset.ensureStarted()).rejects.toMatchObject({ code: "SUPERVISION_SOCKET_UNAVAILABLE" });

    const server = peer();
    const monitor = new SessionEventMonitor({ connect: async () => server.stream, env: { HERDR_SOCKET_PATH: "/tmp/s.sock" }, clock: instantClock });
    await monitor.ensureStarted();
    monitor.stop();
    monitor.stop();
    await expect(monitor.ensureStarted()).rejects.toMatchObject({ code: "SUPERVISION_SOCKET_CLOSED" });
    await expect(monitor.snapshot()).rejects.toMatchObject({ code: "SUPERVISION_SOCKET_CLOSED" });
  });

  it("closes the socket when the subscription is not acknowledged", async () => {
    const server = peer({ failSubscribe: true });
    const monitor = new SessionEventMonitor({ connect: async () => server.stream, env: { HERDR_SOCKET_PATH: "/tmp/s.sock" }, clock: instantClock });
    await expect(monitor.ensureStarted()).rejects.toMatchObject({ code: "SUPERVISION_PROTOCOL_ERROR" });
    expect(server.destroyed).toBe(true);
    monitor.stop();
  });

  it("fans events out by pane id, including a move's previous pane id", async () => {
    const server = peer();
    const monitor = new SessionEventMonitor({ connect: async () => server.stream, env: { HERDR_SOCKET_PATH: "/tmp/s.sock" }, clock: instantClock });
    const watcher = observer("p1");
    const bystander = observer("p9");
    monitor.addObserver(watcher);
    monitor.addObserver(bystander);
    await monitor.ensureStarted();

    server.push(`${JSON.stringify({ event: "pane_closed", data: { type: "pane_closed", pane_id: "p1", workspace_id: "w1" } })}\n`);
    server.push(`${JSON.stringify({ event: "pane_closed", data: { type: "pane_closed", pane_id: "p2", workspace_id: "w1" } })}\n`);
    server.push(`${JSON.stringify({ event: "pane_updated", data: { type: "pane_updated", pane: { pane_id: "p1", terminal_id: "t1", tab_id: "tab", workspace_id: "w1", agent_status: "idle", revision: 2 } } })}\n`);
    server.push(`${JSON.stringify({ event: "pane_moved", data: { type: "pane_moved", previous_pane_id: "p1", previous_tab_id: "tab", previous_workspace_id: "w1", pane: { pane_id: "p5", terminal_id: "t1", tab_id: "tab2", workspace_id: "w1", agent_status: "idle", revision: 3 } } })}\n`);
    await Promise.resolve();

    expect(watcher.events.map((event) => event.event)).toEqual(["pane_closed", "pane_updated", "pane_moved"]);
    expect(bystander.events).toHaveLength(0);
    monitor.removeObserver(bystander);
    monitor.stop();
  });

  it("reconnects losslessly, reports one degraded episode, and then recovers", async () => {
    const first = peer();
    const failure = new Error("no socket");
    const third = peer();
    const connections = [first, failure, third];
    let index = 0;
    const sleeps: number[] = [];
    const monitor = new SessionEventMonitor({
      connect: async () => {
        const next = connections[index++];
        if (next instanceof Error) throw Object.assign(next, { code: "SUPERVISION_SOCKET_UNAVAILABLE" });
        return next!.stream;
      },
      env: { HERDR_SOCKET_PATH: "/tmp/s.sock" },
      clock: { now: () => Date.now(), sleep: async (ms) => { sleeps.push(ms); } },
      random: () => 0.5,
      maxReconnectDelayMs: 1_000,
    });
    const watcher = observer("p1");
    monitor.addObserver(watcher);
    await monitor.ensureStarted();
    expect(watcher.bootstraps).toEqual([]);

    first.close();
    await vi.waitFor(() => expect(watcher.bootstraps).toHaveLength(1));
    expect(watcher.degraded).toEqual(["SUPERVISION_SOCKET_UNAVAILABLE"]);
    expect(watcher.recovered()).toBe(1);
    expect(watcher.bootstraps[0]).toEqual({ generation: 2, reconnected: true });
    expect(sleeps).toHaveLength(1);
    expect(monitor.isDegraded()).toBe(false);
    monitor.stop();
  });

  it("reconnects silently when the socket comes straight back", async () => {
    const first = peer();
    const second = peer();
    const connections = [first, second];
    let index = 0;
    const monitor = new SessionEventMonitor({
      connect: async () => connections[index++]!.stream,
      env: { HERDR_SOCKET_PATH: "/tmp/s.sock" },
      clock: instantClock,
    });
    const watcher = observer("p1");
    monitor.addObserver(watcher);
    await monitor.ensureStarted();
    first.close();
    await vi.waitFor(() => expect(watcher.bootstraps).toHaveLength(1));
    expect(watcher.degraded).toEqual([]);
    expect(watcher.recovered()).toBe(0);
    monitor.stop();
  });

  it("stops reconnecting once the monitor is shut down", async () => {
    const first = peer();
    let attempts = 0;
    const monitor = new SessionEventMonitor({
      connect: async () => {
        attempts += 1;
        if (attempts === 1) return first.stream;
        throw Object.assign(new Error("down"), { code: "SUPERVISION_SOCKET_UNAVAILABLE" });
      },
      env: { HERDR_SOCKET_PATH: "/tmp/s.sock" },
      clock: { now: () => Date.now(), sleep: async () => { monitor.stop(); } },
      random: () => 0,
      maxReconnectDelayMs: 4,
    });
    await monitor.ensureStarted();
    first.close();
    await vi.waitFor(() => expect(attempts).toBeGreaterThan(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(attempts).toBe(2);
  });
});
