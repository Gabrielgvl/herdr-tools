import { describe, expect, it } from "vitest";
import {
  BoundedHistory,
  createSupervisionEventId,
  eventPriority,
  isSettlingEvent,
  materialTransitionEvent,
  SupervisionEventLog,
  SUPERVISION_MAX_EVENTS,
  SUPERVISION_MAX_RETURNED_EVENTS,
} from "../../src/supervision/events.js";

function log(): SupervisionEventLog {
  let id = 0;
  return new SupervisionEventLog(() => `id-${++id}`);
}

describe("supervision event model", () => {
  it("wakes only on a completed work cycle or a block, never on a working start", () => {
    expect(materialTransitionEvent("idle", "working")).toBeUndefined();
    expect(materialTransitionEvent("blocked", "working")).toBeUndefined();
    expect(materialTransitionEvent("working", "unknown")).toBeUndefined();
    expect(materialTransitionEvent("working", "idle")).toBe("work_cycle_completed");
    expect(materialTransitionEvent("working", "done")).toBe("work_cycle_completed");
    expect(materialTransitionEvent("idle", "done")).toBe("work_cycle_completed");
    expect(materialTransitionEvent("working", "blocked")).toBe("blocked");
    expect(materialTransitionEvent("idle", "blocked")).toBe("blocked");
  });

  it("classifies priority and settlement", () => {
    expect(eventPriority("evidence_gap")).toBe("high");
    expect(eventPriority("blocked")).toBe("high");
    expect(eventPriority("reviewer_attention")).toBe("high");
    expect(eventPriority("identity_replaced")).toBe("high");
    expect(eventPriority("identity_lost")).toBe("high");
    expect(eventPriority("work_cycle_completed")).toBe("normal");
    expect(eventPriority("monitor_degraded")).toBe("normal");
    expect(isSettlingEvent("released")).toBe(true);
    expect(isSettlingEvent("pane_closed")).toBe(true);
    expect(isSettlingEvent("identity_replaced")).toBe(true);
    expect(isSettlingEvent("blocked")).toBe(false);
  });

  it("mints opaque event ids and refuses an unusable factory", () => {
    expect(createSupervisionEventId(() => "abc")).toBe("sev_abc");
    expect(createSupervisionEventId()).toMatch(/^sev_[0-9a-f-]{36}$/u);
    expect(() => createSupervisionEventId(() => "")).toThrow(/SUPERVISION_EVENT_ID_INVALID/u);
    expect(() => createSupervisionEventId(() => "a\nb")).toThrow(/SUPERVISION_EVENT_ID_INVALID/u);
    expect(() => createSupervisionEventId(() => 7 as unknown as string)).toThrow(/SUPERVISION_EVENT_ID_INVALID/u);
  });

  it("returns only unobserved events and marks exactly the ones it returned", () => {
    const events = log();
    const first = events.record("blocked", 1, "one");
    const second = events.record("work_cycle_completed", 2, "two", { from: "working", to: "idle", revision: 3 });
    expect(second.details).toEqual({ from: "working", to: "idle", revision: 3 });
    expect(events.unobserved()).toBe(2);

    const pending = events.pending(1);
    expect(pending.map((event) => event.eventId)).toEqual([first.eventId]);
    events.markObserved(pending.map((event) => event.eventId));
    expect(events.unobserved()).toBe(1);

    const rest = events.pending();
    expect(rest.map((event) => event.eventId)).toEqual([second.eventId]);
    events.markObserved(rest.map((event) => event.eventId));
    expect(events.unobserved()).toBe(0);
    expect(events.pending()).toEqual([]);
    expect(events.history()).toHaveLength(2);
    expect(events.history()[0]).not.toHaveProperty("observed");
  });

  it("bounds history, counts what it dropped, and clips oversized fields", () => {
    const events = log();
    for (let index = 0; index < SUPERVISION_MAX_EVENTS + 5; index += 1) events.record("blocked", index, "x".repeat(2_000), { note: "y".repeat(2_000) });
    expect(events.history()).toHaveLength(SUPERVISION_MAX_EVENTS);
    expect(events.truncatedEvents()).toBe(5);
    expect(events.pending()).toHaveLength(SUPERVISION_MAX_RETURNED_EVENTS);
    const [sample] = events.history();
    expect(sample!.summary.length).toBeLessThan(2_000);
    expect(String(sample!.details!.note).length).toBeLessThan(2_000);
  });

  it("keeps the newest entries in a bounded history", () => {
    const history = new BoundedHistory<number>(2);
    expect(history.last()).toBeUndefined();
    history.push(1);
    history.push(2);
    history.push(3);
    expect(history.entries()).toEqual([2, 3]);
    expect(history.truncated()).toBe(1);
    expect(history.size()).toBe(2);
    expect(history.last()).toBe(3);
  });
});
