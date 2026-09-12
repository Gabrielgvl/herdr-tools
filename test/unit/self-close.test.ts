import { afterEach, describe, expect, it, vi } from "vitest";
import { createSelfCloseTracker, type SelfCloseTracker } from "../../src/supervision/self-close.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function pendingClaim(tracker: SelfCloseTracker, paneId: string): Promise<boolean> {
  const decision = tracker.consume(paneId);
  expect(decision).toBeInstanceOf(Promise);
  return decision as Promise<boolean>;
}

describe("self-close tracker", () => {
  it("wakes on nothing tracked and suppresses exactly once after a proven close", () => {
    const tracker = createSelfCloseTracker();
    expect(tracker.consume("p2")).toBe(false);
    tracker.begin("p2")(true);
    expect(tracker.consume("p2")).toBe(true);
    // Consume-once: a second claim on the spent marker wakes, without waiting
    // for the TTL — that is how a recycled pane id still wakes.
    expect(tracker.consume("p2")).toBe(false);
    expect(tracker.consume("elsewhere")).toBe(false);
    tracker.clear();
  });

  it("wakes when the close attempt never proved itself", () => {
    const tracker = createSelfCloseTracker();
    tracker.begin("p2")(false);
    expect(tracker.consume("p2")).toBe(false);
    tracker.clear();
  });

  it("hands a pending claim a bounded promise the finisher settles", async () => {
    const tracker = createSelfCloseTracker();
    const finish = tracker.begin("p2");
    const decision = pendingClaim(tracker, "p2");
    // A second consumer of the same in-flight attempt wakes instead of queueing.
    expect(tracker.consume("p2")).toBe(false);
    finish(true);
    await expect(decision).resolves.toBe(true);
    // Consumed-and-finished: nothing remains for a later wake to claim.
    expect(tracker.consume("p2")).toBe(false);
    tracker.clear();
  });

  it("resolves a pending claim false when the close fails", async () => {
    const tracker = createSelfCloseTracker();
    const finish = tracker.begin("p2");
    const decision = pendingClaim(tracker, "p2");
    finish(false);
    await expect(decision).resolves.toBe(false);
    expect(tracker.consume("p2")).toBe(false);
    tracker.clear();
  });

  it("expires pending attempts 60s after begin, resolving their claims false", async () => {
    vi.useFakeTimers();
    const tracker = createSelfCloseTracker();
    const finish = tracker.begin("p2");
    const decision = pendingClaim(tracker, "p2");
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(decision).resolves.toBe(false);
    expect(tracker.consume("p2")).toBe(false);
    // A finisher arriving after expiry cannot resurrect the attempt.
    finish(true);
    expect(tracker.consume("p2")).toBe(false);
    tracker.clear();
  });

  it("ignores a finisher whose deadline already passed even if its timer has not run", () => {
    vi.useFakeTimers();
    const tracker = createSelfCloseTracker();
    const finish = tracker.begin("p2");
    // Advance the monotonic clock without running the timer callback: the
    // deadline, not the timer, is what makes an entry inert.
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 61_000);
    finish(true);
    expect(tracker.consume("p2")).toBe(false);
    tracker.clear();
  });

  it("treats an overdue confirmed marker as absent even if its timer has not run", () => {
    vi.useFakeTimers();
    const tracker = createSelfCloseTracker();
    tracker.begin("p2")(true);
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 61_000);
    expect(tracker.consume("p2")).toBe(false);
    tracker.clear();
  });

  it("expires an unconsumed confirmed marker 60s after confirmation, not begin", async () => {
    vi.useFakeTimers();
    const tracker = createSelfCloseTracker();
    const finish = tracker.begin("p2");
    await vi.advanceTimersByTimeAsync(59_000);
    finish(true);
    // The confirmed TTL re-arms at confirmation, so the marker is still live
    // nearly two minutes after begin and dies at its own deadline.
    await vi.advanceTimersByTimeAsync(59_999);
    expect(tracker.consume("p2")).toBe(true);
    tracker.begin("p2")(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tracker.consume("p2")).toBe(false);
    tracker.clear();
  });

  it("supersedes an earlier attempt on the same pane and releases its claim false", async () => {
    const tracker = createSelfCloseTracker();
    const stale = tracker.begin("p2");
    const decision = pendingClaim(tracker, "p2");
    const current = tracker.begin("p2");
    // The replaced attempt's pending claim resolves toward waking, and its late
    // finisher can neither confirm nor delete the newer entry.
    await expect(decision).resolves.toBe(false);
    stale(true);
    current(true);
    expect(tracker.consume("p2")).toBe(true);
    tracker.clear();
  });

  it("supersedes a confirmed marker when the same pane is closed again", () => {
    const tracker = createSelfCloseTracker();
    tracker.begin("p2")(true);
    const second = tracker.begin("p2");
    // The newer pending attempt replaces the marker: nothing suppresses until
    // it proves itself.
    const decision = pendingClaim(tracker, "p2");
    second(false);
    void decision;
    expect(tracker.consume("p2")).toBe(false);
    tracker.clear();
  });

  it("caps live attempts at 128 and fails overflow toward waking", () => {
    const tracker = createSelfCloseTracker();
    const finishers: Array<(confirmed: boolean) => void> = [];
    for (let i = 0; i < 128; i += 1) finishers.push(tracker.begin(`p${i}`));
    // One hundred twenty-eight live entries: the next close proceeds untracked
    // and its event will wake normally.
    const overflow = tracker.begin("overflow");
    overflow(true);
    expect(tracker.consume("overflow")).toBe(false);
    // Live pending attempts were not evicted to make room.
    const claims = finishers.map((_, i) => pendingClaim(tracker, `p${i}`));
    expect(claims).toHaveLength(128);
    for (const finish of finishers) finish(false);
    tracker.clear();
  });

  it("retires an overdue pending attempt when a new close is admitted", async () => {
    vi.useFakeTimers();
    const tracker = createSelfCloseTracker();
    const finish = tracker.begin("stale");
    const decision = pendingClaim(tracker, "stale");
    // The monotonic deadline passed without the timer running: admission, not
    // just a consume, is what settles the overdue attempt toward waking.
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 61_000);
    const current = tracker.begin("fresh");
    await expect(decision).resolves.toBe(false);
    finish(true);
    expect(tracker.consume("stale")).toBe(false);
    current(true);
    expect(tracker.consume("fresh")).toBe(true);
    tracker.clear();
  });

  it("purges overdue entries before enforcing the cap", async () => {
    vi.useFakeTimers();
    const tracker = createSelfCloseTracker();
    for (let i = 0; i < 128; i += 1) tracker.begin(`p${i}`);
    await vi.advanceTimersByTimeAsync(60_000);
    tracker.begin("fresh")(true);
    expect(tracker.consume("fresh")).toBe(true);
    tracker.clear();
  });

  it("retires the tracker on clear: claims resolve false and nothing resurrects", async () => {
    const tracker = createSelfCloseTracker();
    const stale = tracker.begin("p1");
    tracker.begin("p2")(true);
    const decision = pendingClaim(tracker, "p1");
    tracker.clear();
    await expect(decision).resolves.toBe(false);
    stale(true);
    tracker.begin("p3")(true);
    expect(tracker.consume("p1")).toBe(false);
    expect(tracker.consume("p2")).toBe(false);
    expect(tracker.consume("p3")).toBe(false);
    // A second clear is harmless.
    tracker.clear();
  });

  it("makes a double finish harmless", () => {
    const tracker = createSelfCloseTracker();
    const finish = tracker.begin("p2");
    finish(true);
    finish(false);
    expect(tracker.consume("p2")).toBe(true);
    const failed = tracker.begin("p3");
    failed(false);
    failed(true);
    expect(tracker.consume("p3")).toBe(false);
    tracker.clear();
  });

  it("shares no state between tracker instances", () => {
    const first = createSelfCloseTracker();
    const second = createSelfCloseTracker();
    first.begin("p2")(true);
    expect(second.consume("p2")).toBe(false);
    expect(first.consume("p2")).toBe(true);
    first.clear();
    second.clear();
  });
});
