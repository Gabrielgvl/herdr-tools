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
   * One stream event for a pane this observer matched, with its ordinal in this
   * connection's event stream. The replay is deterministic and the ordinal counts
   * every accepted event rather than only routed ones, so ordinal `n` names the
   * same log entry on every connection regardless of which pane it concerns.
   */
  onEvent(event: SupervisionSocketEvent, ordinal: number): Promise<void>;
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
    if (this.stopped) throw new SupervisionSocketError("SUPERVISION_SOCKET_CLOSED", "The supervision monitor has been shut down");
    if (this.socket && !this.socket.isClosed()) return;
    this.starting ??= this.bootstrap(false).finally(() => { this.starting = undefined; });
    await this.starting;
  }

  private async bootstrap(reconnected: boolean, recovered = false): Promise<HerdrSnapshot> {
    const snapshot = await this.snapshot();
    const socket = new SupervisionSocket(await this.connect(resolveSocketPath(this.env)), this.requestTimeoutMs);
    try {
      await socket.subscribe();
    } catch (error) {
      socket.close();
      throw error;
    }
    // A socket that died between the acknowledgement and adoption is never
    // adopted: keeping it would leave supervision reporting an active
    // subscription that can never deliver another event.
    const closure = socket.closure();
    if (closure) throw closure;
    this.socket = socket;
    this.generationValue += 1;
    // The ordinal counter belongs to this connection, so a later connection
    // restarts counting without disturbing work already queued from this one.
    // A superseded socket cannot emit: it is always closed before it is replaced.
    const stream = { ordinal: 0 };
    socket.onEvent((event) => {
      const ordinal = ++stream.ordinal;
      this.enqueue(() => this.dispatch(event, ordinal));
    });
    socket.onClose(() => { void this.onSocketClosed(); });
    if (reconnected) {
      const generation = this.generationValue;
      this.enqueue(() => this.announce(snapshot, generation, recovered));
    }
    return snapshot;
  }

  /** Append one ordered unit of observer work to the single dispatch chain. */
  private enqueue(work: () => Promise<void>): void {
    this.dispatchTail = this.dispatchTail.then(work).catch(() => undefined);
  }

  /**
   * A fresh authoritative read. It is unary by protocol: the server answers one
   * request per connection, so this never shares the subscription's connection.
   */
  async snapshot(): Promise<HerdrSnapshot> {
    if (this.stopped) throw new SupervisionSocketError("SUPERVISION_SOCKET_CLOSED", "The supervision monitor has been shut down");
    const socket = new SupervisionSocket(await this.connect(resolveSocketPath(this.env)), this.requestTimeoutMs);
    try {
      return parseSnapshotResult(await socket.request("session.snapshot", {}));
    } finally {
      socket.close();
    }
  }

  private async dispatch(event: SupervisionSocketEvent, ordinal: number): Promise<void> {
    // Both identifiers are validated at the protocol boundary, so an accepted
    // event always names the pane it concerns.
    for (const observer of [...this.observers]) {
      if (!observer.matches(event.paneId) && !(event.previousPaneId !== undefined && observer.matches(event.previousPaneId))) continue;
      await observer.onEvent(event, ordinal);
    }
  }

  /** Recovery is reported before the bootstrap it recovered into. */
  private async announce(snapshot: HerdrSnapshot, generation: number, recovered: boolean): Promise<void> {
    for (const observer of [...this.observers]) {
      if (recovered) observer.onMonitorRecovered();
      await observer.onBootstrap(snapshot, generation, true);
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
          for (const observer of [...this.observers]) observer.onMonitorDegraded(reason);
        }
        await this.clock.sleep(backoffDelay(attempt, this.random, this.maxReconnectDelayMs));
        attempt += 1;
      }
    }
    this.reconnecting = false;
  }

  /** Shut the monitor down. Idempotent; no reconnect is attempted afterwards. */
  stop(): void {
    this.stopped = true;
    this.observers.clear();
    this.socket?.close();
    this.socket = undefined;
  }
}
