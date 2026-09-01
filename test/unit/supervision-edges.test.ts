import { describe, expect, it, vi } from "vitest";
import { boundedList, JobRegistry, type JobSummary, type SupervisorJobRequestSnapshot } from "../../src/job-registry.js";
import { SessionEventMonitor } from "../../src/supervision/monitor.js";
import { SupervisionRegistry } from "../../src/supervision/registry.js";
import { Supervisor, type SupervisorDependencies } from "../../src/supervision/supervisor.js";
import type { SupervisedIdentity } from "../../src/supervision/identity.js";
import type { SupervisionSocketEvent } from "../../src/supervision/protocol.js";
import type { SupervisionStream } from "../../src/supervision/socket.js";
import { parseSnapshotResult, type HerdrSnapshot } from "../../src/targets.js";

const session = { source: "herdr:pi", agent: "pi", kind: "id", value: "s1" };
const identity: SupervisedIdentity = { paneId: "p1", terminalId: "t1", agentName: "worker", agentKind: "pi", agentSession: session };
const settings = { reviewCadenceMinutes: 5, reviewerModel: "luna", reviewerThinking: "low" as const };

const request: SupervisorJobRequestSnapshot = {
  kind: "supervisor",
  label: "supervise worker",
  targets: ["worker"],
  targetIds: [],
  child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" },
  settings: { reviewCadenceMinutes: 5, reviewerModel: "openai-codex/gpt-5.6-luna", reviewerThinking: "max" },
};

function paneRecord(status = "working", revision = 5, paneId = "p1"): Record<string, unknown> {
  return { pane_id: paneId, terminal_id: "t1", tab_id: "tab1", workspace_id: "w1", agent_status: status, revision, agent: "pi", agent_session: session };
}

function snapshot(panes: Array<Record<string, unknown>>, agents: Array<Record<string, unknown>> = [{ pane_id: "p1", name: "worker" }]): HerdrSnapshot {
  return parseSnapshotResult({ type: "session_snapshot", snapshot: { version: "0.8.2", protocol: 20, workspaces: [], tabs: [], panes, agents } });
}

function paneEvent(kind: string, pane: Record<string, unknown>, extra: Record<string, unknown> = {}): SupervisionSocketEvent {
  return { kind: "event", event: kind as SupervisionSocketEvent["event"], data: { type: kind, pane, ...extra } };
}

interface EdgeHarness {
  supervisor: Supervisor;
  reviews: number;
  releaseReview(): void;
}

function edgeSupervisor(snapshots: Array<HerdrSnapshot | Error>, options: { scheduler?: boolean } = {}): EdgeHarness {
  const queue = [...snapshots];
  let reviews = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const deps: SupervisorDependencies = {
    jobId: "job_edge",
    child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" },
    monitor: {
      addObserver: () => undefined,
      removeObserver: () => undefined,
      snapshot: async () => {
        const next = queue.shift();
        if (next === undefined || next instanceof Error) throw next ?? Object.assign(new Error("exhausted"), { code: "X" });
        return next;
      },
      generation: 1,
      isDegraded: () => false,
    },
    notifier: { wake: () => undefined },
    reviewer: { review: async () => { reviews += 1; await pending; return { classification: "progress", summary: "moving" }; } },
    cadenceMs: 1_000,
    clock: { now: () => 0 },
    // Omitting the scheduler exercises the real-timer default.
    ...(options.scheduler === false ? {} : { scheduler: { setTimer: () => "timer", clearTimer: () => undefined } }),
    readTranscript: async () => [],
    update: () => undefined,
  };
  const supervisor = new Supervisor(deps);
  return { supervisor, get reviews() { return reviews; }, releaseReview: release } as EdgeHarness;
}

describe("supervisor guards after settlement", () => {
  it("ignores every stream path once the supervisor has settled", async () => {
    const h = edgeSupervisor([snapshot([paneRecord()]), snapshot([])]);
    await h.supervisor.bind({ identity });
    await h.supervisor.onEvent({ kind: "event", event: "pane_closed", data: { type: "pane_closed", pane_id: "p1", workspace_id: "w1" } });
    expect(await h.supervisor.run()).toMatchObject({ outcome: "released" });

    // Folding, reconciling and settling again are all no-ops on a settled supervisor.
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord("blocked", 9)));
    await h.supervisor.onEvent({ kind: "event", event: "pane_exited", data: { type: "pane_exited", pane_id: "p1", workspace_id: "w1" } });
    expect(h.supervisor.view().status).toBe("working");
    expect(await h.supervisor.run()).toMatchObject({ outcome: "released" });
  });

  it("abandons the rest of a queued replay once the supervisor is stopped", async () => {
    const stopper = { current: (): void => undefined };
    const deps: SupervisorDependencies = {
      jobId: "job_stop_mid_drain",
      child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" },
      monitor: { addObserver: () => undefined, removeObserver: () => undefined, snapshot: async () => snapshot([paneRecord("working")]), generation: 1, isDegraded: () => false },
      // The first material wake stops the supervisor, so the second queued event
      // must not be folded.
      notifier: { wake: () => stopper.current() },
      reviewer: { review: async () => ({ classification: "progress", summary: "s" }) },
      cadenceMs: 1_000,
      clock: { now: () => 0 },
      scheduler: { setTimer: () => "timer", clearTimer: () => undefined },
      readTranscript: async () => [],
      update: () => undefined,
    };
    const supervisor = new Supervisor(deps);
    stopper.current = () => supervisor.shutdown();
    const binding = supervisor.bind({ identity });
    // Both events are queued synchronously, before binding can set the anchor.
    const queued = [supervisor.onEvent(paneEvent("pane_updated", paneRecord("blocked", 6))), supervisor.onEvent(paneEvent("pane_updated", paneRecord("idle", 7)))];
    await binding;
    await Promise.all(queued);
    expect(supervisor.view().transitions.map((transition) => transition.to)).toEqual(["blocked"]);
  });

  it("does not settle twice when a settling wake stops the supervisor", async () => {
    const stopper = { current: (): void => undefined };
    const supervisor = new Supervisor({
      jobId: "job_double_settle",
      child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" },
      monitor: { addObserver: () => undefined, removeObserver: () => undefined, snapshot: async () => snapshot([]), generation: 1, isDegraded: () => false },
      notifier: { wake: () => stopper.current() },
      reviewer: { review: async () => ({ classification: "progress", summary: "s" }) },
      cadenceMs: 1_000,
      clock: { now: () => 0 },
      scheduler: { setTimer: () => "timer", clearTimer: () => undefined },
      readTranscript: async () => [],
      update: () => undefined,
    });
    // Bind against a live pane, then let the pane_closed wake stop the supervisor
    // before its own settlement runs.
    (supervisor as unknown as { identity: SupervisedIdentity; anchor: { revision: number; status: string }; status: string; paneId: string; state: string }).identity = identity;
    (supervisor as unknown as { anchor: { revision: number; status: string } }).anchor = { revision: 1, status: "working" };
    (supervisor as unknown as { status: string }).status = "working";
    (supervisor as unknown as { paneId: string }).paneId = "p1";
    (supervisor as unknown as { state: string }).state = "active";
    stopper.current = () => supervisor.shutdown();
    await supervisor.onEvent({ kind: "event", event: "pane_closed", data: { type: "pane_closed", pane_id: "p1", workspace_id: "w1" } });
    expect(await supervisor.run()).toEqual({ outcome: "cancelled", reason: "manager_session_shutdown" });
  });

  it("settles identity_lost when a move names a pane no snapshot can show", async () => {
    const h = edgeSupervisor([snapshot([paneRecord()]), snapshot([])]);
    await h.supervisor.bind({ identity });
    await h.supervisor.onEvent(paneEvent("pane_moved", paneRecord("working", 6, "p2"), { previous_pane_id: "p1" }));
    expect(await h.supervisor.run()).toMatchObject({ reason: "move_continuity_unproven" });
  });

  it("does not re-arm the cadence for a child that stopped working mid-review", async () => {
    const h = edgeSupervisor([snapshot([paneRecord("working")]), snapshot([paneRecord("idle", 6)])], { scheduler: false });
    await h.supervisor.bind({ identity });
    const review = (h.supervisor as unknown as { review(): Promise<void> }).review();
    // The child leaves the working state while the review is still in flight.
    await h.supervisor.onEvent({ kind: "event", event: "pane_exited", data: { type: "pane_exited", pane_id: "p1", workspace_id: "w1" } });
    h.releaseReview();
    await review;
    expect(h.supervisor.view().status).toBe("idle");
    expect(h.supervisor.view().reviewer.reviews).toHaveLength(1);
  });

  it("never runs two reviews at once", async () => {
    const h = edgeSupervisor([snapshot([paneRecord("working")])], { scheduler: false });
    await h.supervisor.bind({ identity });
    const first = (h.supervisor as unknown as { review(): Promise<void> }).review();
    const second = (h.supervisor as unknown as { review(): Promise<void> }).review();
    h.releaseReview();
    await Promise.all([first, second]);
    expect(h.reviews).toBe(1);
  });
});

describe("supervisor-aware job summaries", () => {
  it("carries the supervisor outcome and unobserved count through every list projection", () => {
    const summary = (overrides: Partial<JobSummary> = {}): JobSummary => ({
      jobId: "job_list",
      kind: "supervisor",
      label: "supervise worker",
      operation_phase: "settled",
      sequence: 1,
      createdAtMs: 0,
      targetIds: [],
      targets: ["worker"],
      supervision_result: "released",
      unobservedEvents: 3,
      ...overrides,
    });
    const compact = boundedList({ jobs: [summary({ label: "l".repeat(400), targets: ["y".repeat(20_000)] })], total: 1, offset: 0, limit: 1, nextOffset: null });
    expect(compact.jobs[0]).toMatchObject({ kind: "supervisor", supervision_result: "released", unobservedEvents: 3 });
    const minimal = boundedList({ jobs: Array.from({ length: 60 }, () => summary({ targets: ["z".repeat(20_000)], targetIds: ["z".repeat(20_000)] })), total: 60, offset: 0, limit: 60, nextOffset: null });
    expect(minimal.jobs[0]).toMatchObject({ kind: "supervisor", supervision_result: "released", unobservedEvents: 3 });
    // A running supervisor has neither an outcome nor a receipt count yet, and an
    // oversized truncation payload forces the minimal projection.
    const running = boundedList({
      jobs: Array.from({ length: 60 }, () => summary({ operation_phase: "running", supervision_result: undefined, unobservedEvents: undefined })),
      total: 60, offset: 0, limit: 60, nextOffset: null,
      truncation: { padding: "x".repeat(100_000) } as unknown as { jobs?: number },
    });
    expect(running.jobs[0]).not.toHaveProperty("supervision_result");
    expect(running.jobs[0]).not.toHaveProperty("unobservedEvents");
    const settledMinimal = boundedList({
      jobs: Array.from({ length: 60 }, () => summary()),
      total: 60, offset: 0, limit: 60, nextOffset: null,
      truncation: { padding: "x".repeat(100_000) } as unknown as { jobs?: number },
    });
    expect(settledMinimal.jobs[0]).toMatchObject({ supervision_result: "released", unobservedEvents: 3 });
  });

  it("settles a supervisor that reports no reason at all", async () => {
    const registry = new JobRegistry({ idFactory: () => "job_no_reason" });
    const registered = registry.register(request, async () => ({ supervision_result: "released" as const }));
    await registered.promise;
    const detail = registry.get(registered.jobId)!;
    expect(detail).toMatchObject({ supervision_result: "released" });
    expect(detail).not.toHaveProperty("supervision_reason");
  });

  it("publishes the settled supervisor outcome and reason in the running summary", async () => {
    const registry = new JobRegistry({ idFactory: () => "job_summary", quiescenceMs: 0 });
    const registered = registry.register(request, async () => ({ supervision_result: "released" as const, reason: "event:pane_closed" }));
    await registered.promise;
    expect(registry.list().jobs[0]).toMatchObject({ kind: "supervisor", supervision_result: "released", reason: "event:pane_closed" });
    // Settling an already-settled supervisor is refused rather than repeated.
    await expect(registry.cancel(registered.jobId)).resolves.toMatchObject({ supervision_result: "released" });
  });
});

describe("monitor and registry seams", () => {
  it("labels an untyped socket failure and ignores an event with no pane identity", async () => {
    let onData: (chunk: Buffer) => void = () => undefined;
    let onClose: () => void = () => undefined;
    const stream: SupervisionStream = {
      write: (line) => {
        const req = JSON.parse(line) as { id: string; method: string };
        queueMicrotask(() => onData(Buffer.from(`${JSON.stringify({ id: req.id, result: req.method === "session.snapshot" ? { type: "session_snapshot", snapshot: { version: "0.8.2", protocol: 20, workspaces: [], tabs: [], panes: [], agents: [] } } : { type: "subscription_started" } })}\n`, "utf8")));
      },
      destroy: () => undefined,
      onData: (handler) => { onData = handler; },
      onClose: (handler) => { onClose = () => handler(); },
    };
    const seen: string[] = [];
    const monitor = new SessionEventMonitor({
      connect: async () => { if (seen.length > 0) throw "a bare string with no code"; seen.push("connected"); return stream; },
      env: { HERDR_SOCKET_PATH: "/tmp/s.sock" },
      // Two failed attempts prove that only the first one reports degradation.
      clock: { now: () => 0, sleep: async () => { if (seen.length > 2) monitor.stop(); seen.push("retry"); } },
      random: () => 0,
      maxReconnectDelayMs: 1,
    });
    const degraded: string[] = [];
    const matched: string[] = [];
    monitor.addObserver({
      matches: (paneId) => { matched.push(paneId); return false; },
      onEvent: async () => undefined,
      onBootstrap: async () => undefined,
      onMonitorDegraded: (reason) => { degraded.push(reason); },
      onMonitorRecovered: () => undefined,
    });
    await monitor.ensureStarted();
    // An event carrying neither a pane id nor a pane record reaches no observer.
    onData(Buffer.from(`${JSON.stringify({ event: "pane_updated", data: { type: "pane_updated", pane: { revision: 1 } } })}\n`, "utf8"));
    await Promise.resolve();
    expect(matched).toEqual([]);
    onClose();
    await vi.waitFor(() => expect(degraded).toEqual(["SUPERVISION_SOCKET_CLOSED"]));
    monitor.stop();
  });

  it("uses a supplied reviewer factory and event id factory, and its own monitor options", async () => {
    let reviewerCalls = 0;
    const supervision = new SupervisionRegistry({
      jobs: new JobRegistry(),
      settingsLoader: async () => settings,
      readTranscript: async () => [],
      reviewerFactory: () => { reviewerCalls += 1; return { review: async () => ({ classification: "progress", summary: "s" }) }; },
      idFactory: () => "fixed",
    });
    expect((supervision as unknown as { reviewer(): unknown }).reviewer()).toBeDefined();
    expect(reviewerCalls).toBe(1);
    // No monitorOptions and no HERDR_SOCKET_PATH means the default monitor refuses.
    const previous = process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_SOCKET_PATH;
    try {
      await expect(supervision.reserve({ child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" } })).rejects.toMatchObject({ code: "SUPERVISION_SOCKET_UNAVAILABLE" });
    } finally {
      if (previous !== undefined) process.env.HERDR_SOCKET_PATH = previous;
    }
    supervision.shutdown();
  });
});
