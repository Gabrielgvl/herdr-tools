import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { JobRegistry, type JobRequestSnapshot } from "../../src/job-registry.js";
import { formatElapsed, WaitJobsUi, type WaitJobsUiScheduler } from "../../src/wait-jobs-ui.js";

const request: JobRequestSnapshot = {
  label: "review worker",
  targets: ["worker"],
  targetIds: ["p1"],
  match: "any",
  condition: { kind: "state", state: "done" },
  timeoutMs: 60_000,
  settings: { reviewCadenceMinutes: 1, reviewerModel: "luna", reviewerThinking: "low" }
};

function fakeContext() {
  const setStatus = vi.fn();
  const setWidget = vi.fn();
  const context = { hasUI: true, ui: { setStatus, setWidget } } as unknown as ExtensionContext;
  return { context, setStatus, setWidget };
}

function harness(start = 10_000) {
  let now = start;
  let callback: (() => void) | undefined;
  const scheduler: WaitJobsUiScheduler = {
    setInterval: vi.fn((next) => { callback = next; return "timer"; }),
    clearInterval: vi.fn()
  };
  const uiRef: { current?: WaitJobsUi } = {};
  const registry = new JobRegistry({ clock: { now: () => now }, onChange: () => uiRef.current?.refresh(), idFactory: (() => { let id = 0; return () => `job_${++id}`; })() });
  const ui = new WaitJobsUi(registry, { now: () => now, scheduler });
  uiRef.current = ui;
  const rendered = fakeContext();
  ui.beginSession(rendered.context);
  return {
    registry,
    ui,
    scheduler,
    ...rendered,
    setNow(value: number) { now = value; },
    tick() { callback?.(); }
  };
}

const pending = async () => new Promise<never>(() => undefined);

describe("WaitJobsUi", () => {
  it("formats elapsed time compactly", () => {
    expect(formatElapsed(-1)).toBe("0s");
    expect(formatElapsed(59_999)).toBe("59s");
    expect(formatElapsed(74_000)).toBe("1m14s");
    expect(formatElapsed(3_661_000)).toBe("1h01m");
  });

  it("uses the real clock scheduler defaults without leaking a timer", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(20_000);
      const uiRef: { current?: WaitJobsUi } = {};
      const registry = new JobRegistry({ onChange: () => uiRef.current?.refresh(), idFactory: () => "job_default_timer" });
      const ui = new WaitJobsUi(registry);
      uiRef.current = ui;
      const rendered = fakeContext();
      ui.beginSession(rendered.context);
      const job = registry.register(request, pending);
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(1_000);
      expect(rendered.setStatus).toHaveBeenLastCalledWith("herdr-waits", "⠙ Herdr waits: 1 · oldest 1s · /herdr-waits");
      registry.cancel(job.jobId);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts one live footer timer and clears it when the active set empties", () => {
    const h = harness();
    const job = h.registry.register(request, pending);
    expect(h.setStatus).toHaveBeenLastCalledWith("herdr-waits", "⠋ Herdr waits: 1 · oldest 0s · /herdr-waits");
    expect(h.scheduler.setInterval).toHaveBeenCalledTimes(1);
    h.setNow(12_000);
    h.tick();
    expect(h.setStatus).toHaveBeenLastCalledWith("herdr-waits", "⠙ Herdr waits: 1 · oldest 2s · /herdr-waits");
    expect(h.scheduler.setInterval).toHaveBeenCalledTimes(1);
    h.registry.cancel(job.jobId);
    expect(h.scheduler.clearInterval).toHaveBeenCalledWith("timer");
    expect(h.setStatus).toHaveBeenLastCalledWith("herdr-waits", undefined);
  });

  it("toggles a read-only active list and remembers it across an empty active set", () => {
    const h = harness();
    expect(h.ui.toggle(h.context)).toBe(true);
    const first = h.registry.register(request, pending);
    expect(h.setWidget).toHaveBeenLastCalledWith("herdr-waits", ["review worker · 0s · job_1"], { placement: "aboveEditor" });
    h.registry.cancel(first.jobId);
    expect(h.setWidget).toHaveBeenLastCalledWith("herdr-waits", undefined, { placement: "aboveEditor" });
    h.setNow(15_000);
    h.registry.register({ ...request, label: "test worker" }, pending);
    expect(h.setWidget).toHaveBeenLastCalledWith("herdr-waits", ["test worker · 0s · job_2"], { placement: "aboveEditor" });
    expect(h.ui.toggle(h.context)).toBe(false);
    expect(h.setWidget).toHaveBeenLastCalledWith("herdr-waits", undefined, { placement: "aboveEditor" });
  });

  it("uses the exact active count and oldest start while bounding visible rows", () => {
    const h = harness(1_000);
    h.ui.toggle(h.context);
    for (let index = 0; index < 21; index += 1) {
      h.setNow(1_000 + index * 1_000);
      h.registry.register({ ...request, label: `wait ${index + 1}` }, pending);
    }
    h.setNow(31_000);
    h.ui.refresh();
    expect(h.setStatus).toHaveBeenLastCalledWith("herdr-waits", expect.stringContaining("Herdr waits: 21 · oldest 30s"));
    const rows = h.setWidget.mock.calls.at(-1)?.[1] as string[];
    expect(rows).toHaveLength(10);
    expect(rows[0]).toContain("wait 21");
    expect(rows.at(-1)).toBe("… 12 more active waits");
  });

  it("clears UI and resets widget preference at session boundaries", () => {
    const h = harness();
    h.ui.toggle(h.context);
    h.ui.endSession();
    expect(h.setStatus).toHaveBeenLastCalledWith("herdr-waits", undefined);
    expect(h.setWidget).toHaveBeenLastCalledWith("herdr-waits", undefined, { placement: "aboveEditor" });
    h.ui.beginSession(h.context);
    h.registry.register(request, pending);
    expect(h.setWidget).toHaveBeenLastCalledWith("herdr-waits", undefined, { placement: "aboveEditor" });
  });

  it("does not start timers without UI and isolates rendering failures", () => {
    const h = harness();
    h.ui.endSession();
    const noUi = { hasUI: false, ui: {} } as unknown as ExtensionContext;
    h.ui.beginSession(noUi);
    expect(() => h.registry.register(request, pending)).not.toThrow();
    expect(h.scheduler.setInterval).toHaveBeenCalledTimes(0);

    const broken = { hasUI: true, ui: { setStatus: () => { throw new Error("broken"); }, setWidget: () => { throw new Error("broken"); } } } as unknown as ExtensionContext;
    expect(() => h.ui.beginSession(broken)).not.toThrow();
    expect(h.registry.runningOverview().total).toBe(1);
  });
});
