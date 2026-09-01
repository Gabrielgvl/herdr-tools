import { describe, expect, it, vi } from "vitest";
import { JobRegistry } from "../../src/job-registry.js";
import { validateJobsParams } from "../../src/jobs-schema.js";
import { parseProfile, profileSource } from "../../src/profiles/index.js";
import { realMonitorClock } from "../../src/supervision/monitor.js";
import { createCliTranscriptReader, SupervisionRegistry, SUPERVISION_TRANSCRIPT_LINES } from "../../src/supervision/registry.js";
import { realSupervisionScheduler } from "../../src/supervision/supervisor.js";
import { createJobsTool } from "../../src/tools/jobs.js";
import { WaitJobsUi } from "../../src/wait-jobs-ui.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const settings = { reviewCadenceMinutes: 5, reviewerModel: "luna", reviewerThinking: "low" as const };

describe("the shared transcript reader", () => {
  it("reads exactly the bounded authoritative pane window and tolerates an empty one", async () => {
    const calls: string[][] = [];
    const reader = createCliTranscriptReader({ runText: async (argv) => { calls.push(argv); return calls.length === 1 ? "" : Array.from({ length: 150 }, (_, index) => `line-${index}`).join("\n"); } });
    const signal = new AbortController().signal;
    await expect(reader("p1", signal)).resolves.toEqual([]);
    const lines = await reader("p1", signal);
    expect(lines).toHaveLength(SUPERVISION_TRANSCRIPT_LINES);
    expect(lines.at(-1)).toBe("line-149");
    expect(calls[0]).toEqual(["pane", "read", "p1", "--source", "recent-unwrapped", "--lines", "100", "--format", "text"]);
  });
});

describe("supervision runtime defaults", () => {
  it("uses real timers that never hold the process open", async () => {
    await expect(realMonitorClock.sleep(1)).resolves.toBeUndefined();
    expect(realMonitorClock.now()).toBeGreaterThan(0);
    const fired = vi.fn();
    const handle = realSupervisionScheduler.setTimer(fired, 1);
    realSupervisionScheduler.clearTimer(handle);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fired).not.toHaveBeenCalled();
  });

  it("builds its own monitor, notifier, clock, and event ids when none are supplied", async () => {
    const jobs = new JobRegistry();
    const supervision = new SupervisionRegistry({
      jobs,
      settingsLoader: async () => settings,
      readTranscript: async () => [],
      monitorOptions: { env: { HERDR_SOCKET_PATH: "" } },
    });
    // Constructing the defaults is enough; reserving proves they are reachable.
    await expect(supervision.reserve({ child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" } })).rejects.toMatchObject({ code: "SUPERVISION_SOCKET_UNAVAILABLE" });
    supervision.shutdown();
  });
});

describe("supervisor-aware job surfaces", () => {
  it("refuses an unknown job kind filter", () => {
    expect(validateJobsParams({ operation: "list", kind: "supervisor" })).toMatchObject({ kind: "supervisor" });
    expect(() => validateJobsParams({ operation: "list", kind: "watcher" })).toThrow(/kind is invalid/u);
  });

  it("renders supervisor jobs with their outcome, unobserved count, and tone", () => {
    const tool = createJobsTool(new JobRegistry());
    const render = (details: Record<string, unknown>): string[] | undefined =>
      tool.renderResult?.({ content: [], details, isError: false } as never, { expanded: false, isPartial: false }, {} as never, {} as never)?.render(80);
    expect(render({ operation: "jobs", view: "job", kind: "supervisor", operation_phase: "settled", supervision_result: "released", unobservedEvents: 2 })).toEqual(["supervisor · settled · released · 2 unobserved"]);
    expect(render({ operation: "jobs", view: "job", kind: "supervisor", operation_phase: "settled", supervision_result: "identity_lost" })).toEqual(["supervisor · settled · identity_lost"]);
    expect(render({ operation: "jobs", view: "job", kind: "supervisor", operation_phase: "running", unobservedEvents: 0 })).toEqual(["supervisor · running"]);
    expect(render({ operation: "jobs", view: "job", kind: "wait", operation_phase: "settled", wait_result: "condition_met" })).toEqual(["job · settled · condition_met"]);
  });

  it("shows supervisor rows and unobserved counts in the active job list", () => {
    const setStatus = vi.fn();
    const setWidget = vi.fn();
    const context = { hasUI: true, ui: { setStatus, setWidget } } as unknown as ExtensionContext;
    const registry = new JobRegistry({ idFactory: () => "job_ui_supervisor", clock: { now: () => 0 } });
    const ui = new WaitJobsUi(registry, { now: () => 0, scheduler: { setInterval: () => "timer", clearInterval: () => undefined } });
    ui.beginSession(context);
    ui.toggle(context);
    const registered = registry.register(
      { kind: "supervisor", label: "supervise worker", targets: ["worker"], targetIds: [], child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" }, settings: { reviewCadenceMinutes: 5, reviewerModel: "openai-codex/gpt-5.6-luna", reviewerThinking: "max" } },
      async () => new Promise<never>(() => undefined),
    );
    registry.attachSupervision(registered.jobId, {
      view: () => ({
        state: "active",
        monitor: { connected: true, degraded: false, generation: 1, evidenceGaps: 0 },
        reviewer: { model: "openai-codex/gpt-5.6-luna", thinking: "max", cadenceMinutes: 5, degraded: false, reviews: [], truncatedReviews: 0 },
        transitions: [], truncatedTransitions: 0, events: [], truncatedEvents: 0, unobservedEvents: 3,
      }),
      takePendingEvents: () => [],
      childLive: () => true,
      shutdown: () => undefined,
    });
    ui.refresh();
    expect(setStatus).toHaveBeenLastCalledWith("herdr-waits", expect.stringContaining("3 unobserved"));
    expect(setWidget).toHaveBeenLastCalledWith("herdr-waits", ["supervisor · supervise worker · 0s · 3 unobserved · job_ui_supervisor"], { placement: "aboveEditor" });
    ui.endSession();
  });

  it("settles a supervisor whose runner throws", async () => {
    const registry = new JobRegistry({ idFactory: () => "job_thrower" });
    const request = { kind: "supervisor" as const, label: "supervise worker", targets: ["worker"], targetIds: [], child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" }, settings: { reviewCadenceMinutes: 5, reviewerModel: "openai-codex/gpt-5.6-luna", reviewerThinking: "max" as const } };
    const registered = registry.register(request, async () => { throw Object.assign(new Error("monitor gone"), { code: "SUPERVISION_SOCKET_CLOSED" }); });
    await registered.promise;
    expect(registry.get(registered.jobId)).toMatchObject({ supervision_result: "failed", supervision_reason: "SUPERVISION_SOCKET_CLOSED", error: { code: "SUPERVISION_SOCKET_CLOSED" } });


  });
});

describe("the profile channel opt-in", () => {
  const source = profileSource("bundled", "/root/manager-claude.md", "/root");
  const profileText = (channels: string): string => [
    "---",
    "name: manager-claude",
    "description: test",
    "timeoutMinutes: 30",
    "sessionPersistence: true",
    "runtime:",
    "  kind: claude",
    "  model: claude-fable-5",
    "  effort: high",
    channels,
    "fallbackProfiles: []",
    "---",
    "",
    "Body.",
    "",
  ].join("\n");

  it("accepts only tagged channel entries", () => {
    expect(parseProfile(profileText("  developmentChannels:\n    - server:herdr"), source).runtime).toMatchObject({ developmentChannels: ["server:herdr"] });
    expect(parseProfile(profileText("  developmentChannels:\n    - plugin:herdr-tools@herdr-tools"), source).runtime).toMatchObject({ developmentChannels: ["plugin:herdr-tools@herdr-tools"] });
    expect(parseProfile(profileText("  developmentChannels: []"), source).runtime).toMatchObject({ developmentChannels: [] });
    for (const entry of ["herdr", "server:", "plugin:herdr-tools", "server:herdr extra"]) {
      expect(() => parseProfile(profileText(`  developmentChannels:\n    - ${entry}`), source)).toThrow(/developmentChannels/u);
    }
  });
});

describe("supervision runtime seams", () => {
  it("falls back to process.env and reports an untyped connect failure", async () => {
    const { SessionEventMonitor } = await import("../../src/supervision/monitor.js");
    const previous = process.env.HERDR_SOCKET_PATH;
    process.env.HERDR_SOCKET_PATH = "/tmp/herdr-defaults.sock";
    try {
      const degraded: string[] = [];
      const monitor = new SessionEventMonitor({
        connect: async () => { throw new Error("plain failure with no code"); },
        clock: { now: () => 0, sleep: async () => undefined },
      });
      monitor.addObserver({
        matches: () => true,
        onEvent: async () => undefined,
        onBootstrap: async () => undefined,
        onMonitorDegraded: (reason) => { degraded.push(reason); },
        onMonitorRecovered: () => undefined,
      });
      await expect(monitor.ensureStarted()).rejects.toThrow(/plain failure/u);
      monitor.stop();
      expect(degraded).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.HERDR_SOCKET_PATH;
      else process.env.HERDR_SOCKET_PATH = previous;
    }
  });

  it("builds a model-backed reviewer when a model service is supplied", async () => {
    const { SupervisionRegistry } = await import("../../src/supervision/registry.js");
    const { ModelSupervisionReviewer } = await import("../../src/supervision/reviewer.js");
    const supervision = new SupervisionRegistry({
      jobs: new JobRegistry(),
      settingsLoader: async () => settings,
      readTranscript: async () => [],
      models: () => ({ resolve: async () => ({ model: {} as never }) }),
      monitorOptions: { env: {} },
    });
    expect((supervision as unknown as { reviewer(): unknown }).reviewer()).toBeInstanceOf(ModelSupervisionReviewer);
    supervision.shutdown();
  });
});
