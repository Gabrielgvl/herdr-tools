/**
 * The single session-level event connection, multiplexed across supervisors.
 *
 * Herdr 0.8.2 serves exactly one request per socket connection: after the first
 * request the connection either closes or, once it has been upgraded to a
 * subscription stream, is reset. Two consequences follow, and both were
 * established against a live named server rather than assumed:
 *
 * - the long-lived connection carries `events.subscribe` and nothing else, so a
 *   per-supervisor subscription is impossible and the monitor subscribes once to
 *   the fixed global set and fans events out by pane id;
 * - every `session.snapshot` — bootstrap and reconciliation alike — is a unary
 *   read on its own short-lived connection.
 *
 * Bootstrap is always the snapshot first and the subscription second; the
 * subscription's durable replay covers the window between them, so that order
 * has no gap.
 */

import { parseSnapshotResult, type HerdrSnapshot } from "../targets.js";
import type { SupervisionSocketEvent } from "./protocol.js";
import {
  createNodeSupervisionConnect,
  resolveSocketPath,
  SupervisionSocket,
  SupervisionSocketError,
  type SupervisionConnect,
} from "./socket.js";

export const SUPERVISION_RECONNECT_MIN_MS = 250;
export const SUPERVISION_RECONNECT_MAX_MS = 8_000;

export interface MonitorClock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

export const realMonitorClock: MonitorClock = {
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise<void>((resolve) => { setTimeout(resolve, milliseconds).unref?.(); }),
};

export interface SupervisionObserver {
  /** True when this observer is currently bound to the given pane id. */
  matches(paneId: string): boolean;
  /**
   * One stream event for a pane this observer matched.
   *
   * The monitor deliberately supplies no stream position. Herdr's retained log
   * can drop entries from its head, so a connection-local position is not a
   * stable event identity: after truncation the same position names a different
   * entry. An observer must decide from the event's own authoritative content.
   */
  onEvent(event: SupervisionSocketEvent): Promise<void>;
  /** A fresh bootstrap. `reconnected` is false only for the very first one. */
  onBootstrap(snapshot: HerdrSnapshot, generation: number, reconnected: boolean): Promise<void>;
  /** The monitor lost its connection and could not immediately restore it. */
  onMonitorDegraded(reason: string): void;
  /** The monitor restored its connection after a degraded episode. */
  onMonitorRecovered(): void;
}

export interface SupervisionMonitorDependencies {
  connect?: SupervisionConnect;
  env?: NodeJS.ProcessEnv;
  clock?: MonitorClock;
  random?: () => number;
  requestTimeoutMs?: number;
  maxReconnectDelayMs?: number;
}

function backoffDelay(attempt: number, random: () => number, maxDelayMs: number): number {
  const ceiling = Math.min(maxDelayMs, SUPERVISION_RECONNECT_MIN_MS * 2 ** Math.min(attempt, 16));
  return Math.max(1, Math.floor(random() * ceiling));
}

/**
 * Whether one event belongs to one observer. A `matches` that fails is read as
 * "not this observer": a broken observer cannot claim an event, and it must not
 * abort the routing decision for the ones that come after it.
 */
function routes(observer: SupervisionObserver, event: SupervisionSocketEvent): boolean {
  try {
    return observer.matches(event.paneId) || (event.previousPaneId !== undefined && observer.matches(event.previousPaneId));
  } catch {
    return false;
  }
}

function reasonOf(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : "SUPERVISION_SOCKET_CLOSED";
}

export class SessionEventMonitor {
  private readonly connect: SupervisionConnect;
  private readonly env: NodeJS.ProcessEnv;
  private readonly clock: MonitorClock;
  private readonly random: () => number;
  private readonly requestTimeoutMs: number | undefined;
  private readonly maxReconnectDelayMs: number;
  private readonly observers = new Set<SupervisionObserver>();
  private socket: SupervisionSocket | undefined;
  private starting: Promise<HerdrSnapshot> | undefined;
  /**
   * Socket events are delivered to observers strictly in stream order. Without
   * this, a thin event awaiting a reconciliation snapshot could be overtaken by a
   * later full update and then apply its older snapshot on top of it.
   */
  private dispatchTail: Promise<void> = Promise.resolve();
  private generationValue = 0;
  private degraded = false;
  private stopped = false;
  private reconnecting = false;

  constructor(deps: SupervisionMonitorDependencies = {}) {
    this.connect = deps.connect ?? createNodeSupervisionConnect();
    this.env = deps.env ?? process.env;
    this.clock = deps.clock ?? realMonitorClock;
    this.random = deps.random ?? Math.random;
    this.requestTimeoutMs = deps.requestTimeoutMs;
    this.maxReconnectDelayMs = deps.maxReconnectDelayMs ?? SUPERVISION_RECONNECT_MAX_MS;
  }

  get generation(): number {
    return this.generationValue;
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  addObserver(observer: SupervisionObserver): void {
    this.observers.add(observer);
  }

  removeObserver(observer: SupervisionObserver): void {
    this.observers.delete(observer);
  }

  /**
   * Ensure the session's event subscription is live. Concurrent callers share one
   * attempt so a burst of launches cannot open competing connections, and a live
   * subscription costs nothing: no snapshot is taken for its own sake, because
   * every read is a separate connection on this protocol.
   */
  async ensureStarted(): Promise<void> {
    this.assertRunning();
    if (this.socket && !this.socket.isClosed()) return;
    this.starting ??= this.bootstrap(false).finally(() => { this.starting = undefined; });
    await this.starting;
  }

  private async bootstrap(reconnected: boolean, recovered = false): Promise<HerdrSnapshot> {
    const snapshot = await this.snapshot();
    this.assertRunning();
    const socket = new SupervisionSocket(await this.connect(resolveSocketPath(this.env)), this.requestTimeoutMs);
    // Handlers are installed before the subscription is issued: Herdr may deliver
    // the acknowledgement and the first replay events in one chunk, and the
    // socket accepts those events the moment the acknowledgement lands. A handler
    // installed after `subscribe` resolves would miss them silently.
    socket.onEvent((event) => { this.enqueue(() => this.dispatch(event)); });
    socket.onClose(() => { void this.onSocketClosed(); });
    try {
      await socket.subscribe();
      // A monitor stopped while this bootstrap was awaiting must not adopt a live
      // connection: the session it belonged to is over, and the socket would
      // outlive it.
      this.assertRunning();
      // A socket that died between the acknowledgement and adoption is never
      // adopted either: keeping it would leave supervision reporting an active
      // subscription that can never deliver another event.
      const closure = socket.closure();
      if (closure) throw closure;
    } catch (error) {
      socket.close();
      throw error;
    }
    this.socket = socket;
    this.generationValue += 1;
    if (reconnected) {
      const generation = this.generationValue;
      this.enqueue(() => this.announce(snapshot, generation, recovered));
    }
    return snapshot;
  }

  private assertRunning(): void {
    if (this.stopped) throw new SupervisionSocketError("SUPERVISION_SOCKET_CLOSED", "The supervision monitor has been shut down");
  }

  /**
   * Append one ordered unit of observer work to the single dispatch chain.
   *
   * `dispatch` and `announce` are the only units, and both are total: every
   * observer call they make is isolated, so the chain cannot be poisoned by one
   * observer. A rejection here would therefore be a defect in the monitor
   * itself, and swallowing it silently is what hid a lost lifecycle event
   * before, so nothing is swallowed.
   */
  private enqueue(work: () => Promise<void>): void {
    this.dispatchTail = this.dispatchTail.then(work);
  }

  /**
   * A fresh authoritative read. It is unary by protocol: the server answers one
   * request per connection, so this never shares the subscription's connection.
   */
  async snapshot(): Promise<HerdrSnapshot> {
    this.assertRunning();
    const socket = new SupervisionSocket(await this.connect(resolveSocketPath(this.env)), this.requestTimeoutMs);
    try {
      return parseSnapshotResult(await socket.request("session.snapshot", {}));
    } finally {
      socket.close();
    }
  }

  private async dispatch(event: SupervisionSocketEvent): Promise<void> {
    // Both identifiers are validated at the protocol boundary, so an accepted
    // event always names the pane it concerns. Each observer is isolated: one
    // supervisor that fails must not deprive its siblings of the same event,
    // which they could never be given again. The isolation wraps the call rather
    // than its promise, because a failure thrown before the first await is a
    // failure all the same.
    for (const observer of [...this.observers]) {
      if (!routes(observer, event)) continue;
      try {
        await observer.onEvent(event);
      } catch {
        // Isolated: the observer's own state machine owns this failure.
      }
    }
  }

  /** Recovery is reported before the bootstrap it recovered into. */
  private async announce(snapshot: HerdrSnapshot, generation: number, recovered: boolean): Promise<void> {
    for (const observer of [...this.observers]) {
      try {
        if (recovered) observer.onMonitorRecovered();
        await observer.onBootstrap(snapshot, generation, true);
      } catch {
        // Isolated for the same reason: a bootstrap is offered once per connection.
      }
    }
  }

  private async onSocketClosed(): Promise<void> {
    if (this.stopped || this.reconnecting) return;
    this.reconnecting = true;
    this.socket = undefined;
    let attempt = 0;
    while (!this.stopped) {
      try {
        // Bootstrap enqueues its own announcement, so recovery and the bootstrap
        // are ordered ahead of every event the new connection delivers.
        await this.bootstrap(true, this.degraded);
        this.degraded = false;
        this.reconnecting = false;
        return;
      } catch (error) {
        if (!this.degraded) {
          this.degraded = true;
          const reason = reasonOf(error);
          // Isolated per observer, like every other observer call: a failure here
          // would otherwise escape the reconnect loop and leave the monitor
          // permanently marked as reconnecting, so it would never reconnect.
          for (const observer of [...this.observers]) {
            try {
              observer.onMonitorDegraded(reason);
            } catch {
              // The observer's own state machine owns this failure.
            }
          }
        }
        await this.clock.sleep(backoffDelay(attempt, this.random, this.maxReconnectDelayMs));
        attempt += 1;
      }
    }
    this.reconnecting = false;
  }

  /**
   * Shut the monitor down. Idempotent; no reconnect is attempted afterwards, and
   * a bootstrap that is still awaiting refuses to adopt its connection.
   */
  stop(): void {
    this.stopped = true;
    this.observers.clear();
    this.socket?.close();
    this.socket = undefined;
    // A bootstrap in flight will now throw at its next checkpoint. Dropping the
    // shared attempt keeps a later caller from awaiting a doomed one.
    this.starting = undefined;
  }
}
