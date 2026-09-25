import { describe, expect, it } from "vitest";
import {
  CLAUDE_CHANNEL_CAPABILITY,
  CLAUDE_CHANNEL_NOTIFICATION_METHOD,
  createPiSupervisionNotifier,
  inertNotifier,
  supervisionWakeContent,
  supervisionWakeMeta,
  SUPERVISION_WAKE_CONTENT_BYTES,
  type SupervisionWake,
} from "../../src/supervision/notify.js";

const wake: SupervisionWake = {
  jobId: "job_1",
  child: { agentName: "worker", agentKind: "pi", paneId: "p1" },
  event: { eventId: "sev_1", atMs: 5, type: "blocked", priority: "high", summary: "child idle → blocked", details: { revision: 3 } },
};

describe("supervision manager wake delivery", () => {
  it("renders a bounded, high-priority-marked wake that names the recovery path", () => {
    const content = supervisionWakeContent(wake);
    expect(content).toContain("HIGH PRIORITY: ");
    expect(content).toContain("job_1");
    expect(content).toContain("worker");
    expect(content).toContain("herdr_jobs get");
    // The text is what a host replays into later turns, so it carries its own
    // staleness signal: event time, event id, and the do-nothing rule.
    expect(content).toContain("sev_1");
    expect(content).toContain("Delivered once at 1970-01-01T00:00:00.005Z");
    expect(content).toContain("if this event id is already in your ledger or the job is settled, do nothing");
    expect(supervisionWakeContent({ ...wake, event: { ...wake.event, atMs: Number.NaN } })).toContain("Delivered once at an unknown time");
    const normal = supervisionWakeContent({ ...wake, event: { ...wake.event, priority: "normal" } });
    expect(normal.startsWith("Herdr supervisor")).toBe(true);
    const oversized = supervisionWakeContent({ ...wake, event: { ...wake.event, summary: "x".repeat(20_000) } });
    expect(Buffer.byteLength(oversized, "utf8")).toBeLessThanOrEqual(SUPERVISION_WAKE_CONTENT_BYTES);
  });

  it("publishes bounded structured meta including the opaque event id", () => {
    expect(supervisionWakeMeta(wake)).toEqual({
      jobId: "job_1", kind: "supervisor", eventId: "sev_1", eventType: "blocked",
      priority: "high", atMs: 5, agentName: "worker", agentKind: "pi", paneId: "p1", details: { revision: 3 },
    });
    const withoutDetails = supervisionWakeMeta({ ...wake, event: { ...wake.event, details: undefined } });
    expect(withoutDetails).not.toHaveProperty("details");
  });

  it("delivers a Pi wake as steered custom context and swallows every delivery failure", () => {
    const calls: unknown[] = [];
    createPiSupervisionNotifier((message, options) => { calls.push({ message, options }); return Promise.resolve(); }).wake(wake);
    expect(calls).toEqual([{
      message: { customType: "herdr-supervision", content: supervisionWakeContent(wake), display: true, details: supervisionWakeMeta(wake) },
      options: { deliverAs: "steer", triggerTurn: true },
    }]);
    expect(() => createPiSupervisionNotifier(() => Promise.reject(new Error("gone"))).wake(wake)).not.toThrow();
    expect(() => createPiSupervisionNotifier(() => { throw new Error("shutting down"); }).wake(wake)).not.toThrow();
  });

  it("pins the documented Claude channel notification method and capability", () => {
    expect(CLAUDE_CHANNEL_NOTIFICATION_METHOD).toBe("notifications/claude/channel");
    expect(CLAUDE_CHANNEL_CAPABILITY).toBe("claude/channel");
  });

  it("keeps recording when a host has no wake channel", () => {
    expect(() => inertNotifier.wake(wake)).not.toThrow();
  });
});
