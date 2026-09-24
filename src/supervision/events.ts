/**
 * Supervision's transition record and its material-event log.
 *
 * Every exact-child transition is recorded. Only the material subset wakes the
 * manager, and each material event carries an opaque `eventId` so a manager can
 * recover a dropped wake by asking `herdr_jobs get` instead of the supervisor
 * resending it.
 */

import { randomUUID } from "node:crypto";
import { boundedText } from "../job-registry.js";
import type { SupervisionAgentStatus } from "./protocol.js";

export const SUPERVISION_EVENT_TYPES = [
  "work_cycle_completed",
  "provider_limit",
  "blocked",
  "reviewer_attention",
  "reviewer_degraded",
  "reviewer_recovered",
  "identity_replaced",
  "identity_lost",
  "released",
  "pane_closed",
  "monitor_degraded",
  "monitor_recovered",
  "reconciliation_degraded",
  "reconciliation_recovered",
  "evidence_gap",
] as const;
export type SupervisionEventType = (typeof SUPERVISION_EVENT_TYPES)[number];

export type SupervisionEventPriority = "normal" | "high";

export const RECONCILIATION_FAILURE_REASONS = [
  "connect_failed",
  "request_failed",
  "snapshot_protocol_invalid",
  "duplicate_target_pane",
  "duplicate_target_agent",
  "orphan_target_agent",
  "target_identity_contradiction",
  "target_record_malformed",
  "revision_regressed",
] as const;
export type ReconciliationFailureReason = (typeof RECONCILIATION_FAILURE_REASONS)[number];

/** Event types that settle the supervisor immediately after the wake. */
export const SUPERVISION_SETTLING_EVENT_TYPES = ["identity_replaced", "identity_lost", "released", "pane_closed"] as const;

const HIGH_PRIORITY_EVENT_TYPES = new Set<SupervisionEventType>([
  "provider_limit",
  "blocked",
  "reviewer_attention",
  "identity_replaced",
  "identity_lost",
  "evidence_gap",
]);

export const SUPERVISION_MAX_EVENTS = 48;
export const SUPERVISION_MAX_TRANSITIONS = 64;
export const SUPERVISION_MAX_REVIEWS = 24;
export const SUPERVISION_MAX_RETURNED_EVENTS = 16;
const SUPERVISION_SUMMARY_BYTES = 500;
const SUPERVISION_DETAIL_FIELD_BYTES = 256;

export interface SupervisionEvent {
  eventId: string;
  atMs: number;
  type: SupervisionEventType;
  priority: SupervisionEventPriority;
  summary: string;
  details?: Record<string, string | number | boolean>;
}

export interface SupervisionTransition {
  atMs: number;
  from: SupervisionAgentStatus;
  to: SupervisionAgentStatus;
  revision: number;
  source: "event" | "snapshot";
}

export function isSettlingEvent(type: SupervisionEventType): boolean {
  return (SUPERVISION_SETTLING_EVENT_TYPES as readonly string[]).includes(type);
}

export function eventPriority(type: SupervisionEventType): SupervisionEventPriority {
  return HIGH_PRIORITY_EVENT_TYPES.has(type) ? "high" : "normal";
}

export function createSupervisionEventId(factory: () => string = randomUUID): string {
  const value = factory();
  if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/u.test(value)) {
    throw new Error("SUPERVISION_EVENT_ID_INVALID: supervision event id factory returned an invalid value");
  }
  return `sev_${value}`;
}

function boundedDetails(details: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
  return Object.fromEntries(Object.entries(details).map(([key, value]) => [
    boundedText(key, 64),
    typeof value === "string" ? boundedText(value, SUPERVISION_DETAIL_FIELD_BYTES) : value,
  ]));
}

/**
 * Classify one folded status transition. `working` starts are silent by
 * contract; only a completed work cycle or a block wakes the manager.
 */
export function materialTransitionEvent(from: SupervisionAgentStatus, to: SupervisionAgentStatus): SupervisionEventType | undefined {
  if (to === "blocked") return "blocked";
  if (to === "done" || (from === "working" && to === "idle")) return "work_cycle_completed";
  return undefined;
}

interface LoggedEvent {
  event: SupervisionEvent;
  observed: boolean;
}

/** A bounded, receipt-tracking log of the material events one supervisor produced. */
export class SupervisionEventLog {
  private readonly events: LoggedEvent[] = [];
  private truncated = 0;

  constructor(private readonly idFactory: () => string = randomUUID) {}

  record(type: SupervisionEventType, atMs: number, summary: string, details?: Record<string, string | number | boolean>): SupervisionEvent {
    const event: SupervisionEvent = {
      eventId: createSupervisionEventId(this.idFactory),
      atMs,
      type,
      priority: eventPriority(type),
      summary: boundedText(summary, SUPERVISION_SUMMARY_BYTES),
      ...(details === undefined ? {} : { details: boundedDetails(details) }),
    };
    this.events.push({ event, observed: false });
    while (this.events.length > SUPERVISION_MAX_EVENTS) {
      this.events.shift();
      this.truncated += 1;
    }
    return event;
  }

  /** The oldest unobserved events, and nothing else. */
  pending(limit = SUPERVISION_MAX_RETURNED_EVENTS): SupervisionEvent[] {
    const selected: SupervisionEvent[] = [];
    for (const entry of this.events) {
      if (entry.observed) continue;
      selected.push(entry.event);
      if (selected.length >= limit) break;
    }
    return selected;
  }

  /** Mark exactly the supplied event IDs observed. */
  markObserved(eventIds: readonly string[]): void {
    const ids = new Set(eventIds);
    for (const entry of this.events) {
      if (ids.has(entry.event.eventId)) entry.observed = true;
    }
  }

  unobserved(): number {
    return this.events.filter((entry) => !entry.observed).length;
  }

  /** The retained events, oldest first, with observation state stripped. */
  history(): SupervisionEvent[] {
    return this.events.map((entry) => entry.event);
  }

  truncatedEvents(): number {
    return this.truncated;
  }
}

/** A bounded ring that keeps the newest entries and counts what it dropped. */
export class BoundedHistory<T> {
  private readonly items: T[] = [];
  private dropped = 0;

  constructor(private readonly limit: number) {}

  push(item: T): void {
    this.items.push(item);
    while (this.items.length > this.limit) {
      this.items.shift();
      this.dropped += 1;
    }
  }

  entries(): T[] {
    return [...this.items];
  }

  truncated(): number {
    return this.dropped;
  }

  size(): number {
    return this.items.length;
  }

  last(): T | undefined {
    return this.items.at(-1);
  }
}
