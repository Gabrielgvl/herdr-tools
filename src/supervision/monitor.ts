/**
 * The single session-level event connection, multiplexed across supervisors.
 *
 * Herdr 0.8.2 drops a connection that issues a second `events.subscribe`, so a
 * per-supervisor subscription is impossible: this monitor subscribes once to the
 * fixed global set and fans events out by pane id. Bootstrap is always
 * `session.snapshot` first and `events.subscribe` second; the subscription's
 * durable replay covers the window between them, so that order has no gap.
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
  /** One stream event for a pane this observer matched. */
  onEvent(event: SupervisionSocketEvent, generation: number): Promise<void>;
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
   * Connect, bootstrap, and subscribe. Concurrent callers share one attempt so a
   * burst of launches cannot open competing connections.
   */
  async ensureStarted(): Promise<HerdrSnapshot> {
    if (this.stopped) throw new SupervisionSocketError("SUPERVISION_SOCKET_CLOSED", "The supervision monitor has been shut down");
    if (this.socket && !this.socket.isClosed()) return this.snapshot();
    this.starting ??= this.bootstrap().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async bootstrap(): Promise<HerdrSnapshot> {
    const socketPath = resolveSocketPath(this.env);
    const stream = await this.connect(socketPath);
    const socket = new SupervisionSocket(stream, this.requestTimeoutMs);
    try {
      const snapshot = parseSnapshotResult(await socket.request("session.snapshot", {}));
      await socket.subscribe();
      this.socket = socket;
      this.generationValue += 1;
      socket.onEvent((event) => { void this.dispatch(event); });
      socket.onClose(() => { void this.onSocketClosed(); });
      return snapshot;
    } catch (error) {
      socket.close();
      throw error;
    }
  }

  /** A fresh authoritative reconciliation read on the live connection. */
  async snapshot(): Promise<HerdrSnapshot> {
    const socket = this.socket;
    if (!socket || socket.isClosed()) throw new SupervisionSocketError("SUPERVISION_SOCKET_CLOSED", "The supervision monitor has no live connection");
    return parseSnapshotResult(await socket.request("session.snapshot", {}));
  }

  private async dispatch(event: SupervisionSocketEvent): Promise<void> {
    const paneId = typeof event.data.pane_id === "string"
      ? event.data.pane_id
      : typeof (event.data.pane as { pane_id?: unknown } | undefined)?.pane_id === "string"
        ? (event.data.pane as { pane_id: string }).pane_id
        : undefined;
    const previousPaneId = typeof event.data.previous_pane_id === "string" ? event.data.previous_pane_id : undefined;
    const generation = this.generationValue;
    for (const observer of [...this.observers]) {
      if (!(paneId !== undefined && observer.matches(paneId)) && !(previousPaneId !== undefined && observer.matches(previousPaneId))) continue;
      await observer.onEvent(event, generation);
    }
  }

  private async onSocketClosed(): Promise<void> {
    if (this.stopped || this.reconnecting) return;
    this.reconnecting = true;
    this.socket = undefined;
    let attempt = 0;
    while (!this.stopped) {
      try {
        const snapshot = await this.bootstrap();
        const generation = this.generationValue;
        const recovered = this.degraded;
        this.degraded = false;
        this.reconnecting = false;
        for (const observer of [...this.observers]) {
          if (recovered) observer.onMonitorRecovered();
          await observer.onBootstrap(snapshot, generation, true);
        }
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
