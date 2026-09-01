import { describe, expect, it, vi } from "vitest";
import { SessionEventMonitor, type MonitorClock, type SupervisionObserver } from "../../src/supervision/monitor.js";
import { scriptedServer } from "./supervision-peer.js";
import type { SupervisionStream } from "../../src/supervision/socket.js";
import type { SupervisionSocketEvent } from "../../src/supervision/protocol.js";
import type { HerdrSnapshot } from "../../src/targets.js";

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
const env = { HERDR_SOCKET_PATH: "/tmp/s.sock" };

describe("the session event monitor", () => {
  it("bootstraps snapshot-then-subscribe on separate connections, once for concurrent callers", async () => {
    const peer = scriptedServer();
    const connect = vi.fn(() => peer.connect());
    const monitor = new SessionEventMonitor({ connect, env, clock: instantClock });
    await Promise.all([monitor.ensureStarted(), monitor.ensureStarted()]);
    // Herdr answers one request per connection, so bootstrap costs exactly two.
    expect(connect).toHaveBeenCalledTimes(2);
    expect(peer.requests).toEqual(["session.snapshot", "events.subscribe"]);
    expect(monitor.generation).toBe(1);

    // A live subscription costs nothing: no snapshot is taken for its own sake.
    await monitor.ensureStarted();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(peer.requests).toEqual(["session.snapshot", "events.subscribe"]);

    // An explicit reconciliation is still a unary read on its own connection.
    expect((await monitor.snapshot()).protocol).toBe(20);
    expect(connect).toHaveBeenCalledTimes(3);
    expect(peer.requests).toEqual(["session.snapshot", "events.subscribe", "session.snapshot"]);
    monitor.stop();
  });

  it("refuses to start without a socket path, and after shutdown", async () => {
    const unset = new SessionEventMonitor({ connect: () => scriptedServer().connect(), env: {}, clock: instantClock });
    await expect(unset.ensureStarted()).rejects.toMatchObject({ code: "SUPERVISION_SOCKET_UNAVAILABLE" });

    const peer = scriptedServer();
    const monitor = new SessionEventMonitor({ connect: () => peer.connect(), env, clock: instantClock });
    await monitor.ensureStarted();
    monitor.stop();
    monitor.stop();
    await expect(monitor.ensureStarted()).rejects.toMatchObject({ code: "SUPERVISION_SOCKET_CLOSED" });
    await expect(monitor.snapshot()).rejects.toMatchObject({ code: "SUPERVISION_SOCKET_CLOSED" });
  });

  it("closes the subscription socket when it is not acknowledged", async () => {
    const peer = scriptedServer({ failSubscribe: true });
    const monitor = new SessionEventMonitor({ connect: () => peer.connect(), env, clock: instantClock });
    await expect(monitor.ensureStarted()).rejects.toMatchObject({ code: "SUPERVISION_PROTOCOL_ERROR" });
    monitor.stop();
  });

  it("fans events out by pane id, including a move's previous pane id", async () => {
    const peer = scriptedServer();
    const monitor = new SessionEventMonitor({ connect: () => peer.connect(), env, clock: instantClock });
    const watcher = observer("p1");
    const bystander = observer("p9");
    monitor.addObserver(watcher);
    monitor.addObserver(bystander);
    await monitor.ensureStarted();

    peer.push(`${JSON.stringify({ event: "pane_closed", data: { type: "pane_closed", pane_id: "p1", workspace_id: "w1" } })}\n`);
    peer.push(`${JSON.stringify({ event: "pane_closed", data: { type: "pane_closed", pane_id: "p2", workspace_id: "w1" } })}\n`);
    peer.push(`${JSON.stringify({ event: "pane_updated", data: { type: "pane_updated", pane: { pane_id: "p1", terminal_id: "t1", tab_id: "tab", workspace_id: "w1", agent_status: "idle", revision: 2 } } })}\n`);
    peer.push(`${JSON.stringify({ event: "pane_moved", data: { type: "pane_moved", previous_pane_id: "p1", previous_tab_id: "tab", previous_workspace_id: "w1", pane: { pane_id: "p5", terminal_id: "t1", tab_id: "tab2", workspace_id: "w1", agent_status: "idle", revision: 3 } } })}\n`);
    await vi.waitFor(() => expect(watcher.events).toHaveLength(3));

    expect(watcher.events.map((event) => event.event)).toEqual(["pane_closed", "pane_updated", "pane_moved"]);
    expect(bystander.events).toHaveLength(0);
    monitor.removeObserver(bystander);
    monitor.stop();
  });

  it("reconnects, reports one degraded episode, and then recovers", async () => {
    const peer = scriptedServer();
    let failures = 1;
    const sleeps: number[] = [];
    const monitor = new SessionEventMonitor({
      connect: async (): Promise<SupervisionStream> => {
        if (peer.connects >= 2 && failures > 0) {
          failures -= 1;
          throw Object.assign(new Error("no socket"), { code: "SUPERVISION_SOCKET_UNAVAILABLE" });
        }
        return peer.connect();
      },
      env,
      clock: { now: () => Date.now(), sleep: async (ms) => { sleeps.push(ms); } },
      random: () => 0.5,
      maxReconnectDelayMs: 1_000,
    });
    // Health is reported to every observer, so a first one that fails on either
    // health call must not cost the rest their degradation, recovery, or
    // bootstrap. A failure escaping the reconnect loop would also leave the
    // monitor permanently marked reconnecting and never reconnect again.
    monitor.addObserver({
      matches: () => true,
      onEvent: async () => undefined,
      onBootstrap: async () => undefined,
      onMonitorDegraded: () => { throw new Error("degradation failed"); },
      onMonitorRecovered: () => { throw new Error("recovery failed"); },
    });
    const watcher = observer("p1");
    monitor.addObserver(watcher);
    await monitor.ensureStarted();
    expect(watcher.bootstraps).toEqual([]);

    peer.closeSubscription();
    await vi.waitFor(() => expect(watcher.bootstraps).toHaveLength(1));
    expect(watcher.degraded).toEqual(["SUPERVISION_SOCKET_UNAVAILABLE"]);
    expect(watcher.recovered()).toBe(1);
    expect(watcher.bootstraps[0]).toEqual({ generation: 2, reconnected: true });
    expect(sleeps).toHaveLength(1);
    expect(monitor.isDegraded()).toBe(false);
    monitor.stop();
  });

  it("reconnects silently when the socket comes straight back", async () => {
    const peer = scriptedServer();
    const monitor = new SessionEventMonitor({ connect: () => peer.connect(), env, clock: instantClock });
    const watcher = observer("p1");
    monitor.addObserver(watcher);
    await monitor.ensureStarted();
    peer.closeSubscription();
    await vi.waitFor(() => expect(watcher.bootstraps).toHaveLength(1));
    expect(watcher.degraded).toEqual([]);
    expect(watcher.recovered()).toBe(0);
    monitor.stop();
  });

  it("stops reconnecting once the monitor is shut down", async () => {
    const peer = scriptedServer();
    let attempts = 0;
    const monitor = new SessionEventMonitor({
      connect: async (): Promise<SupervisionStream> => {
        attempts += 1;
        if (attempts > 2) throw Object.assign(new Error("down"), { code: "SUPERVISION_SOCKET_UNAVAILABLE" });
        return peer.connect();
      },
      env,
      clock: { now: () => Date.now(), sleep: async () => { monitor.stop(); } },
      random: () => 0,
      maxReconnectDelayMs: 4,
    });
    await monitor.ensureStarted();
    peer.closeSubscription();
    await vi.waitFor(() => expect(attempts).toBeGreaterThan(2));
    const settled = attempts;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(attempts).toBe(settled);
  });
});

describe("stream ordering and dead-socket refusal", () => {
  it("delivers events strictly in stream order even when one suspends", async () => {
    const peer = scriptedServer();
    const monitor = new SessionEventMonitor({ connect: () => peer.connect(), env, clock: instantClock });
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let seen = 0;
    monitor.addObserver({
      matches: () => true,
      onEvent: async (event) => {
        order.push(`start:${event.event}`);
        // The first event suspends, exactly as a reconciliation snapshot does.
        if (++seen === 1) await firstBlocked;
        order.push(`end:${event.event}`);
      },
      onBootstrap: async () => undefined,
      onMonitorDegraded: () => undefined,
      onMonitorRecovered: () => undefined,
    });
    await monitor.ensureStarted();

    peer.push(`${JSON.stringify({ event: "pane_closed", data: { type: "pane_closed", pane_id: "p1", workspace_id: "w1" } })}\n`);
    peer.push(`${JSON.stringify({ event: "pane_updated", data: { type: "pane_updated", pane: { pane_id: "p1", terminal_id: "t1", tab_id: "tab", workspace_id: "w1", agent_status: "idle", revision: 2 } } })}\n`);
    await vi.waitFor(() => expect(order).toEqual(["start:pane_closed"]));
    // The later full update cannot overtake the suspended thin event.
    releaseFirst();
    await vi.waitFor(() => expect(order).toHaveLength(4));
    expect(order).toEqual(["start:pane_closed", "end:pane_closed", "start:pane_updated", "end:pane_updated"]);
    monitor.stop();
  });

  it("routes an event only to the observers whose pane it names", async () => {
    const peer = scriptedServer();
    const monitor = new SessionEventMonitor({ connect: () => peer.connect(), env, clock: instantClock });
    const routed: string[] = [];
    monitor.addObserver({
      matches: (paneId) => paneId === "p2",
      onEvent: async (event) => { routed.push(event.paneId); },
      onBootstrap: async () => undefined,
      onMonitorDegraded: () => undefined,
      onMonitorRecovered: () => undefined,
    });
    await monitor.ensureStarted();
    for (const paneId of ["p1", "p2", "p1", "p2"]) {
      peer.push(`${JSON.stringify({ event: "pane_closed", data: { type: "pane_closed", pane_id: paneId, workspace_id: "w1" } })}\n`);
    }
    await vi.waitFor(() => expect(routed).toHaveLength(2));
    expect(routed).toEqual(["p2", "p2"]);
    monitor.stop();
  });

  it("delivers an event and a bootstrap to every matching observer even when one fails", async () => {
    const peer = scriptedServer();
    const monitor = new SessionEventMonitor({ connect: () => peer.connect(), env, clock: instantClock });
    const thrower: string[] = [];
    const sibling = observer("p1");
    // A failing observer must neither break the ordered dispatch chain nor
    // deprive its siblings of the very event it failed on: the monitor can never
    // deliver that event again. Each of its three entry points can fail, and
    // `onEvent` fails before its first await, which a rejected promise misses.
    monitor.addObserver({
      matches: (paneId) => { thrower.push(`matches:${paneId}`); throw new Error("routing failed"); },
      onEvent: () => { throw new Error("fold failed"); },
      onBootstrap: async () => { throw new Error("bootstrap failed"); },
      onMonitorDegraded: () => undefined,
      onMonitorRecovered: () => { throw new Error("recovery failed"); },
    });
    monitor.addObserver(sibling);
    await monitor.ensureStarted();
    const closed = `${JSON.stringify({ event: "pane_closed", data: { type: "pane_closed", pane_id: "p1", workspace_id: "w1" } })}\n`;
    peer.push(closed);
    peer.push(closed);
    await vi.waitFor(() => expect(sibling.events).toHaveLength(2));
    // A `matches` that throws claims nothing, so the failing observer is skipped
    // rather than aborting the routing decision for the ones behind it.
    expect(thrower).toEqual(["matches:p1", "matches:p1"]);

    // The same isolation on the reconnect path: degradation, recovery, and the
    // bootstrap all reach the sibling.
    peer.closeSubscription();
    await vi.waitFor(() => expect(sibling.bootstraps).toEqual([{ generation: 2, reconnected: true }]));

    // A superseded connection cannot emit: it is closed before it is replaced.
    const superseded = peer.emitter();
    peer.closeSubscription();
    await vi.waitFor(() => expect(peer.connects).toBeGreaterThan(4));
    superseded(closed);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sibling.events).toHaveLength(2);
    monitor.stop();
  });


  it("delivers events that arrive inside the acknowledgement's own chunk", async () => {
    // The socket accepts events the moment the acknowledgement lands, which can
    // be before `subscribe` resolves. A handler installed afterwards would drop
    // the head of the replay into an undefined callback, silently.
    const closed = `${JSON.stringify({ event: "pane_closed", data: { type: "pane_closed", pane_id: "p1", workspace_id: "w1" } })}\n`;
    const peer = scriptedServer({ eventsWithAck: [closed, closed] });
    const monitor = new SessionEventMonitor({ connect: () => peer.connect(), env, clock: instantClock });
    const watcher = observer("p1");
    monitor.addObserver(watcher);
    await monitor.ensureStarted();
    await vi.waitFor(() => expect(watcher.events).toHaveLength(2));
    expect(watcher.events.map((event) => event.paneId)).toEqual(["p1", "p1"]);
    monitor.stop();
  });

  it("refuses to adopt a connection for a session that stopped while it was starting", async () => {
    // Stopping is the end of the manager session. A bootstrap still awaiting its
    // acknowledgement must not hand the stopped monitor a live socket, which
    // would outlive the session it belonged to.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const peer = scriptedServer({ holdSubscribe: held });
    const monitor = new SessionEventMonitor({ connect: () => peer.connect(), env, clock: instantClock });
    const starting = monitor.ensureStarted();
    await vi.waitFor(() => expect(peer.requests).toContain("events.subscribe"));
    monitor.stop();
    release();
    await expect(starting).rejects.toMatchObject({ code: "SUPERVISION_SOCKET_CLOSED" });
    // Nothing was adopted, so the abandoned attempt is not shared with a later caller.
    expect(monitor.generation).toBe(0);
    await expect(monitor.ensureStarted()).rejects.toMatchObject({ code: "SUPERVISION_SOCKET_CLOSED" });
  });

  it("refuses to adopt a subscription whose socket died before adoption", async () => {
    const peer = scriptedServer({ closeOnSubscribeAck: true });
    const monitor = new SessionEventMonitor({ connect: () => peer.connect(), env, clock: instantClock });
    await expect(monitor.ensureStarted()).rejects.toMatchObject({ code: "SUPERVISION_SOCKET_CLOSED" });
    monitor.stop();
  });
});
