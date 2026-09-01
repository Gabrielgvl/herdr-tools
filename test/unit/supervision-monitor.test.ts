import { describe, expect, it, vi } from "vitest";
import {
  realMonitorClock,
  SessionEventMonitor,
  SUPERVISION_RECONCILIATION_INTERVAL_MS,
  type MonitorClock,
  type MonitorScheduler,
  type SupervisionObserver,
} from "../../src/supervision/monitor.js";
import type { ReconciliationFailureReason } from "../../src/supervision/events.js";
import { emptySnapshotResult, scriptedServer } from "./supervision-peer.js";
import type { SupervisionStream } from "../../src/supervision/socket.js";
import type { SupervisionSocketEvent } from "../../src/supervision/protocol.js";
import { parseSnapshotResult, type HerdrSnapshot } from "../../src/targets.js";

function observer(paneId: string) {
  const events: SupervisionSocketEvent[] = [];
  const bootstraps: Array<{ generation: number; reconnected: boolean }> = [];
  const degraded: string[] = [];
  const reconciliations: HerdrSnapshot[] = [];
  const reconciliationFailures: ReconciliationFailureReason[] = [];
  let recovered = 0;
  const value: SupervisionObserver & {
    events: typeof events;
    bootstraps: typeof bootstraps;
    degraded: typeof degraded;
    reconciliations: typeof reconciliations;
    reconciliationFailures: typeof reconciliationFailures;
    recovered: () => number;
  } = {
    matches: (candidate) => candidate === paneId,
    onEvent: async (event) => { events.push(event); },
    onBootstrap: async (_snapshot: HerdrSnapshot, generation, reconnected) => { bootstraps.push({ generation, reconnected }); },
    onMonitorDegraded: (reason) => { degraded.push(reason); },
    onMonitorRecovered: () => { recovered += 1; },
    onReconciliationSnapshot: async (snapshot) => { reconciliations.push(snapshot); },
    onReconciliationFailure: (reason) => { reconciliationFailures.push(reason); },
    events,
    bootstraps,
    degraded,
    reconciliations,
    reconciliationFailures,
    recovered: () => recovered,
  };
  return value;
}

class ManualMonitorScheduler implements MonitorScheduler {
  private readonly timers: Array<{ callback: () => void; milliseconds: number; active: boolean }> = [];

  setTimer(callback: () => void, milliseconds: number) {
    const timer = { callback, milliseconds, active: true };
    this.timers.push(timer);
    return { cancel: () => { timer.active = false; } };
  }

  pendingDelays(): number[] {
    return this.timers.filter((timer) => timer.active).map((timer) => timer.milliseconds);
  }

  fireNext(): void {
    const timer = this.timers.find((candidate) => candidate.active);
    if (!timer) throw new Error("no monitor timer is armed");
    timer.active = false;
    timer.callback();
  }

  fireNextTwice(): void {
    const timer = this.timers.find((candidate) => candidate.active);
    if (!timer) throw new Error("no monitor timer is armed");
    timer.active = false;
    timer.callback();
    timer.callback();
  }
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

  it("runs one shared periodic snapshot for every observer and cancels with the last observer", async () => {
    let now = 0;
    const scheduler = new ManualMonitorScheduler();
    const peer = scriptedServer();
    const monitor = new SessionEventMonitor({
      connect: () => peer.connect(),
      env,
      clock: { now: () => now, sleep: async () => undefined },
      scheduler,
    });
    expect(scheduler.pendingDelays()).toEqual([]);
    const first = observer("p1");
    const second = observer("p2");
    monitor.addObserver(first);
    monitor.addObserver(second);
    expect(scheduler.pendingDelays()).toEqual([SUPERVISION_RECONCILIATION_INTERVAL_MS]);
    await monitor.ensureStarted();
    expect(first.reconciliations).toEqual([]);
    expect(second.reconciliations).toEqual([]);

    now = SUPERVISION_RECONCILIATION_INTERVAL_MS;
    scheduler.fireNext();
    await vi.waitFor(() => expect(first.reconciliations).toHaveLength(1));
    expect(second.reconciliations).toHaveLength(1);
    expect(peer.requests).toEqual(["session.snapshot", "events.subscribe", "session.snapshot"]);
    expect(scheduler.pendingDelays()).toEqual([SUPERVISION_RECONCILIATION_INTERVAL_MS]);

    monitor.removeObserver(first);
    expect(scheduler.pendingDelays()).toEqual([SUPERVISION_RECONCILIATION_INTERVAL_MS]);
    monitor.removeObserver(second);
    expect(scheduler.pendingDelays()).toEqual([]);
    expect(() => scheduler.fireNext()).toThrow(/no monitor timer/u);
    monitor.stop();
  });

  it("uses fixed due times, never overlaps reads, and skips delayed catch-up bursts", async () => {
    let now = 0;
    let releaseConnect!: () => void;
    const heldConnect = new Promise<void>((resolve) => { releaseConnect = resolve; });
    const scheduler = new ManualMonitorScheduler();
    const peer = scriptedServer();
    const connect = vi.fn(async () => {
      if (connect.mock.calls.length === 3) await heldConnect;
      return peer.connect();
    });
    const monitor = new SessionEventMonitor({
      connect,
      env,
      clock: { now: () => now, sleep: async () => undefined },
      scheduler,
    });
    const watcher = observer("p1");
    monitor.addObserver(watcher);
    await monitor.ensureStarted();

    now = 30_000;
    scheduler.fireNext();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(3));
    expect(scheduler.pendingDelays()).toEqual([]);
    expect(watcher.reconciliations).toEqual([]);

    now = 45_000;
    releaseConnect();
    await vi.waitFor(() => expect(watcher.reconciliations).toHaveLength(1));
    // The next fixed due time is 60s, not 30s after the 45s completion.
    expect(scheduler.pendingDelays()).toEqual([15_000]);

    // Firing the 60s timer late at 95s skips the elapsed 90s due time. It runs
    // once and schedules 120s instead of bursting a second catch-up attempt.
    now = 95_000;
    scheduler.fireNext();
    await vi.waitFor(() => expect(watcher.reconciliations).toHaveLength(2));
    expect(connect).toHaveBeenCalledTimes(4);
    expect(scheduler.pendingDelays()).toEqual([25_000]);
    expect(peer.requests.filter((request) => request === "session.snapshot")).toHaveLength(3);
    monitor.stop();
    expect(scheduler.pendingDelays()).toEqual([]);
  });

  it("ignores stopped, stale, and incomplete periodic timer state", async () => {
    const stopped = new SessionEventMonitor({ connect: () => scriptedServer().connect(), env, clock: instantClock });
    const stoppedInternals = stopped as unknown as { armPeriodicReconciliation(epoch: number): void };
    stopped.stop();
    expect(() => stoppedInternals.armPeriodicReconciliation(0)).not.toThrow();

    const scheduler = new ManualMonitorScheduler();
    const active = new SessionEventMonitor({
      connect: () => scriptedServer().connect(),
      env,
      clock: instantClock,
      scheduler,
    });
    active.addObserver(observer("p1"));
    const activeInternals = active as unknown as {
      armPeriodicReconciliation(epoch: number): void;
      runPeriodicReconciliation(epoch: number, dueAt: number): Promise<void>;
      reconciliationNextDueAt: number | undefined;
      reconciliationTimer: unknown;
    };
    const timer = activeInternals.reconciliationTimer;
    activeInternals.reconciliationTimer = undefined;
    activeInternals.reconciliationNextDueAt = undefined;
    expect(() => activeInternals.armPeriodicReconciliation(1)).not.toThrow();
    activeInternals.reconciliationTimer = timer;
    await activeInternals.runPeriodicReconciliation(0, 30_000);
    active.stop();
  });

  it("rolls an overdue due time forward before arming the timer", () => {
    let clockReads = 0;
    const scheduler = new ManualMonitorScheduler();
    const monitor = new SessionEventMonitor({
      connect: () => scriptedServer().connect(),
      env,
      clock: {
        now: () => clockReads++ === 0 ? 0 : SUPERVISION_RECONCILIATION_INTERVAL_MS + 1,
        sleep: async () => undefined,
      },
      scheduler,
    });
    monitor.addObserver(observer("p1"));
    expect(scheduler.pendingDelays()).toEqual([SUPERVISION_RECONCILIATION_INTERVAL_MS - 1]);
    monitor.stop();
  });

  it("does not start a second periodic read while one is in flight", async () => {
    let now = 0;
    let releaseConnect!: () => void;
    const heldConnect = new Promise<void>((resolve) => { releaseConnect = resolve; });
    const scheduler = new ManualMonitorScheduler();
    const peer = scriptedServer();
    const connect = vi.fn(async () => {
      if (connect.mock.calls.length === 3) await heldConnect;
      return peer.connect();
    });
    const monitor = new SessionEventMonitor({
      connect,
      env,
      clock: { now: () => now, sleep: async () => undefined },
      scheduler,
    });
    const watcher = observer("p1");
    monitor.addObserver(watcher);
    await monitor.ensureStarted();

    now = SUPERVISION_RECONCILIATION_INTERVAL_MS;
    scheduler.fireNextTwice();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(3));
    expect(scheduler.pendingDelays()).toEqual([SUPERVISION_RECONCILIATION_INTERVAL_MS]);
    releaseConnect();
    await vi.waitFor(() => expect(watcher.reconciliations).toHaveLength(1));
    expect(connect).toHaveBeenCalledTimes(3);
    monitor.stop();
  });

  it("reports fixed shared-attempt failures without leaking causes and recovers on a valid snapshot", async () => {
    let now = 0;
    const scheduler = new ManualMonitorScheduler();
    const peer = scriptedServer({ snapshots: [emptySnapshotResult, { type: "backend-secret" }, emptySnapshotResult] });
    const connect = vi.fn(async () => {
      if (connect.mock.calls.length === 3) throw new Error("connect-backend-secret");
      return peer.connect();
    });
    const monitor = new SessionEventMonitor({
      connect,
      env,
      clock: { now: () => now, sleep: async () => undefined },
      scheduler,
    });
    const watcher = observer("p1");
    monitor.addObserver(watcher);
    await monitor.ensureStarted();

    now = 30_000;
    scheduler.fireNext();
    await vi.waitFor(() => expect(watcher.reconciliationFailures).toEqual(["connect_failed"]));
    now = 60_000;
    scheduler.fireNext();
    await vi.waitFor(() => expect(watcher.reconciliationFailures).toEqual(["connect_failed", "snapshot_protocol_invalid"]));
    now = 90_000;
    scheduler.fireNext();
    await vi.waitFor(() => expect(watcher.reconciliations).toHaveLength(1));

    expect(JSON.stringify(watcher.reconciliationFailures)).not.toContain("backend-secret");
    expect(scheduler.pendingDelays()).toEqual([30_000]);
    monitor.stop();
  });

  it("drops periodic results after observers are removed during a read", async () => {
    let releaseConnect!: () => void;
    const heldConnect = new Promise<void>((resolve) => { releaseConnect = resolve; });
    const scheduler = new ManualMonitorScheduler();
    const peer = scriptedServer();
    const connect = vi.fn(async () => {
      if (connect.mock.calls.length === 3) await heldConnect;
      return peer.connect();
    });
    const monitor = new SessionEventMonitor({
      connect,
      env,
      clock: { now: () => 0, sleep: async () => undefined },
      scheduler,
    });
    const watcher = observer("p1");
    monitor.addObserver(watcher);
    await monitor.ensureStarted();

    scheduler.fireNext();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(3));
    monitor.removeObserver(watcher);
    releaseConnect();
    await vi.waitFor(() => expect(peer.requests.filter((request) => request === "session.snapshot")).toHaveLength(2));
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(watcher.reconciliations).toEqual([]);
    monitor.stop();
  });

  it("drops stale reconciliation deliveries and tolerates observers without hooks", async () => {
    const scheduler = new ManualMonitorScheduler();
    const monitor = new SessionEventMonitor({
      connect: () => scriptedServer().connect(),
      env,
      clock: instantClock,
      scheduler,
    });
    const passive: SupervisionObserver = {
      matches: () => false,
      onEvent: async () => undefined,
      onBootstrap: async () => undefined,
      onMonitorDegraded: () => undefined,
      onMonitorRecovered: () => undefined,
    };
    const watcher = observer("p1");
    monitor.addObserver(passive);
    monitor.addObserver(watcher);
    const internals = monitor as unknown as {
      dispatchReconciliationSnapshot(snapshot: HerdrSnapshot, participants: readonly SupervisionObserver[], epoch: number): Promise<void>;
      dispatchReconciliationFailure(reason: ReconciliationFailureReason, participants: readonly SupervisionObserver[], epoch: number): Promise<void>;
    };
    const snapshot = parseSnapshotResult(emptySnapshotResult);
    await internals.dispatchReconciliationSnapshot(snapshot, [passive, watcher], 1);
    await internals.dispatchReconciliationFailure("request_failed", [passive, watcher], 1);
    expect(watcher.reconciliations).toHaveLength(1);
    expect(watcher.reconciliationFailures).toEqual(["request_failed"]);

    monitor.stop();
    await internals.dispatchReconciliationSnapshot(snapshot, [watcher], 1);
    await internals.dispatchReconciliationFailure("request_failed", [watcher], 1);
    expect(watcher.reconciliations).toHaveLength(1);
    expect(watcher.reconciliationFailures).toEqual(["request_failed"]);
  });

  it("reports snapshot setup and request failures through the bounded error path", async () => {
    let setupDestroyed = 0;
    const setupFailure: SupervisionStream = {
      write: () => undefined,
      destroy: () => { setupDestroyed += 1; },
      onData: () => { throw new Error("setup failed"); },
      onClose: () => undefined,
    };
    const setupMonitor = new SessionEventMonitor({ connect: async () => setupFailure, env, clock: instantClock });
    await expect(setupMonitor.snapshot()).rejects.toThrow("setup failed");
    expect(setupDestroyed).toBe(1);

    let requestWrites = 0;
    let requestDestroyed = 0;
    const requestFailure: SupervisionStream = {
      write: () => { requestWrites += 1; throw new Error("request failed"); },
      destroy: () => { requestDestroyed += 1; },
      onData: () => undefined,
      onClose: () => undefined,
    };
    const requestMonitor = new SessionEventMonitor({ connect: async () => requestFailure, env, clock: instantClock });
    await expect(requestMonitor.snapshot()).rejects.toThrow("request failed");
    expect(requestWrites).toBe(1);
    expect(requestDestroyed).toBe(1);

    const defaults = new SessionEventMonitor();
    defaults.stop();

    const reconnectPeer = scriptedServer();
    let failures = 1;
    const degraded = observer("p1");
    const reconnectMonitor = new SessionEventMonitor({
      connect: async () => {
        if (reconnectPeer.connects >= 2 && failures > 0) {
          failures -= 1;
          throw new Error("missing code");
        }
        return reconnectPeer.connect();
      },
      env,
      random: () => 0,
      maxReconnectDelayMs: 1,
    });
    reconnectMonitor.addObserver(degraded);
    await reconnectMonitor.ensureStarted();
    reconnectPeer.closeSubscription();
    await vi.waitFor(() => expect(degraded.degraded).toEqual(["SUPERVISION_SOCKET_CLOSED"]));
    expect(degraded.recovered()).toBe(1);
    reconnectMonitor.stop();
    await expect(realMonitorClock.sleep(0)).resolves.toBeUndefined();
  });

  it("refuses to start without a socket path, and after shutdown", async () => {
    const unset = new SessionEventMonitor({ connect: () => scriptedServer().connect(), env: {}, clock: instantClock });
    await expect(unset.ensureStarted()).rejects.toMatchObject({ code: "SUPERVISION_SOCKET_UNAVAILABLE" });

    const peer = scriptedServer();
    const monitor = new SessionEventMonitor({ connect: () => peer.connect(), env, clock: instantClock });
    await monitor.ensureStarted();
    monitor.stop();
    monitor.addObserver(observer("p1"));
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
