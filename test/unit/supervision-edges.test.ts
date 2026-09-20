import { describe, expect, it, vi } from "vitest";
import { boundedList, JobRegistry, type JobSummary, type SupervisorJobRequestSnapshot } from "../../src/job-registry.js";
import { ReviewerFailure } from "../../src/reviewer.js";
import { SessionEventMonitor } from "../../src/supervision/monitor.js";
import { SupervisionRegistry } from "../../src/supervision/registry.js";
import { Supervisor, type SupervisorDependencies } from "../../src/supervision/supervisor.js";
import type { SupervisedIdentity } from "../../src/supervision/identity.js";
import { parseSocketLine, type SupervisionSocketEvent } from "../../src/supervision/protocol.js";
import type { SupervisionReviewRequest } from "../../src/supervision/reviewer.js";
import { createTraceSource } from "../../src/supervision/trace-source.js";
import type { SupervisionWake } from "../../src/supervision/notify.js";
import { scriptedServer } from "./supervision-peer.js";
import { parseSnapshotResult, type HerdrSnapshot } from "../../src/targets.js";

const types = (wakes: SupervisionWake[]): string[] => wakes.map((wake) => wake.event.type);

const session = { source: "herdr:pi", agent: "pi", kind: "path", value: "/pi/session.jsonl" };
const identity: SupervisedIdentity = { paneId: "p1", terminalId: "t1", agentName: "worker", agentKind: "pi", agentSession: session };
const settings = { reviewCadenceMinutes: 5, reviewerModel: "testmodel", reviewerThinking: "low" as const };

const request: SupervisorJobRequestSnapshot = {
  kind: "supervisor",
  label: "supervise worker",
  targets: ["worker"],
  targetIds: [],
  child: { agentName: "worker", agentKind: "pi", candidateName: "worker-pi" },
  settings: { reviewCadenceMinutes: 5, reviewerModel: "typesafe/jev-latest", reviewerThinking: "max" },
};

function paneRecord(status = "working", revision = 5, paneId = "p1"): Record<string, unknown> {
  return { pane_id: paneId, terminal_id: "t1", tab_id: "tab1", workspace_id: "w1", agent_status: status, revision, agent: "pi", agent_session: session };
}

function snapshot(panes: Array<Record<string, unknown>>, agents: Array<Record<string, unknown>> = [{ pane_id: "p1", name: "worker" }]): HerdrSnapshot {
  return parseSnapshotResult({ type: "session_snapshot", snapshot: { version: "0.8.2", protocol: 22, workspaces: [], tabs: [], panes, agents } });
}

/** Events reach a supervisor already validated by the protocol boundary. */
function paneEvent(kind: string, pane: Record<string, unknown>, extra: Record<string, unknown> = {}): SupervisionSocketEvent {
  return parseSocketLine(JSON.stringify({ event: kind, data: { type: kind, pane, ...extra } })) as SupervisionSocketEvent;
}

function thinEvent(kind: string, paneId = "p1"): SupervisionSocketEvent {
  return parseSocketLine(JSON.stringify({ event: kind, data: { type: kind, pane_id: paneId, workspace_id: "w1" } })) as SupervisionSocketEvent;
}

interface EdgeHarness {
  supervisor: Supervisor;
  wakes: SupervisionWake[];
  reviews: number;
  /** Cadence delays the supervisor armed, in order. */
  arms: number[];
  releaseReview(): void;
}

interface EdgeOptions {
  scheduler?: boolean;
  transcript?: () => Promise<string[]>;
  onReview?: (request: SupervisionReviewRequest) => void;
  /** The gated reviewer rejects instead of returning a result. */
  reviewFails?: boolean;
}

function edgeSupervisor(snapshots: Array<HerdrSnapshot | Error>, options: EdgeOptions = {}): EdgeHarness {
  const wakes: SupervisionWake[] = [];
  const queue = [...snapshots];
  let reviews = 0;
  let release!: () => void;
  const arms: number[] = [];
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const readTranscript: SupervisorDependencies["readTranscript"] = options.transcript ?? (async () => []);
  const deps: SupervisorDependencies = {
    jobId: "job_edge",
    child: { agentName: "worker", agentKind: "pi", candidateName: "worker-pi" },
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
    notifier: { wake: (wake) => { wakes.push(wake); } },
    reviewer: {
      review: async (request) => {
        reviews += 1;
        options.onReview?.(request);
        if (options.onReview === undefined) await pending;
        if (options.reviewFails) throw new ReviewerFailure("model down");
        return { classification: "progress", summary: "moving" };
      },
    },
    cadenceMs: 1_000,
    clock: { now: () => 0 },
    // Omitting the scheduler exercises the real-timer default.
    ...(options.scheduler === false ? {} : { scheduler: { setTimer: (_callback, ms) => { arms.push(ms); return "timer"; }, clearTimer: () => undefined } }),
    // Reviews that complete here must not reach the real review log on disk.
    reviewLog: async () => undefined,
    readTranscript,
    traceSource: createTraceSource({ readFileRange: async () => new Uint8Array(), readTerminal: readTranscript }),
    update: () => undefined,
  };
  const supervisor = new Supervisor(deps);
  return { supervisor, wakes, arms, get reviews() { return reviews; }, releaseReview: release } as EdgeHarness;
}

describe("supervisor guards after settlement", () => {
  it("ignores every stream path once the supervisor has settled", async () => {
    const h = edgeSupervisor([snapshot([paneRecord()]), snapshot([], [])]);
    await h.supervisor.bind({ identity, candidateName: "worker-pi" });
    await h.supervisor.onEvent(thinEvent("pane_closed", "p1"));
    expect(await h.supervisor.run()).toMatchObject({ outcome: "released" });

    // Folding, reconciling and settling again are all no-ops on a settled supervisor.
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord("blocked", 9)));
    await h.supervisor.onEvent(thinEvent("pane_exited", "p1"));
    expect(h.supervisor.view().status).toBe("working");
    expect(await h.supervisor.run()).toMatchObject({ outcome: "released" });
  });

  it("abandons the rest of a queued replay once the supervisor is stopped", async () => {
    const stopper = { current: (): void => undefined };
    const deps: SupervisorDependencies = {
      jobId: "job_stop_mid_drain",
      child: { agentName: "worker", agentKind: "pi", candidateName: "worker-pi" },
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
    const binding = supervisor.bind({ identity, candidateName: "worker-pi" });
    // Both events are queued synchronously, before binding can set the anchor.
    const queued = [supervisor.onEvent(paneEvent("pane_updated", paneRecord("blocked", 6))), supervisor.onEvent(paneEvent("pane_updated", paneRecord("idle", 7)))];
    await expect(binding).rejects.toMatchObject({ code: "SUPERVISION_UNCONFIRMED", details: { cause: "settled_during_bind", settledDuringBind: true, supervisionOutcome: "cancelled" } });
    await Promise.all(queued);
    expect(supervisor.view().transitions.map((transition) => transition.to)).toEqual(["blocked"]);
  });

  it("does not settle twice when a settling wake stops the supervisor", async () => {
    const stopper = { current: (): void => undefined };
    const supervisor = new Supervisor({
      jobId: "job_double_settle",
      child: { agentName: "worker", agentKind: "pi", candidateName: "worker-pi" },
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
    await supervisor.onEvent(thinEvent("pane_closed", "p1"));
    expect(await supervisor.run()).toEqual({ outcome: "cancelled", reason: "manager_session_shutdown" });
  });

  it("settles identity_lost when a move names a pane no snapshot can show", async () => {
    const h = edgeSupervisor([snapshot([paneRecord()]), snapshot([])]);
    await h.supervisor.bind({ identity, candidateName: "worker-pi" });
    await h.supervisor.onEvent(paneEvent("pane_moved", paneRecord("working", 6, "p2"), { previous_pane_id: "p1" }));
    expect(await h.supervisor.run()).toMatchObject({ reason: "move_continuity_unproven" });
  });

  it("discards a review whose work cycle ended while the model call was in flight", async () => {
    const h = edgeSupervisor([snapshot([paneRecord("working")]), snapshot([paneRecord("idle", 6)])], { scheduler: false });
    await h.supervisor.bind({ identity, candidateName: "worker-pi" });
    const review = (h.supervisor as unknown as { review(): Promise<void> }).review();
    // The child leaves the working state while the review is still in flight.
    await h.supervisor.onEvent(thinEvent("pane_exited", "p1"));
    h.releaseReview();
    await review;
    expect(h.supervisor.view().status).toBe("idle");
    // The result describes a run that is already over, so it is neither stored
    // nor announced, and the cadence is not re-armed.
    expect(h.supervisor.view().reviewer.reviews).toEqual([]);
    expect(h.supervisor.view().reviewer.lastReviewAtMs).toBeUndefined();
    // The settling wake for the ended cycle is expected; no reviewer wake is.
    expect(types(h.wakes).filter((type) => type.startsWith("reviewer_"))).toEqual([]);
  });

  it("never runs two reviews at once", async () => {
    const h = edgeSupervisor([snapshot([paneRecord("working")])], { scheduler: false });
    await h.supervisor.bind({ identity, candidateName: "worker-pi" });
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
    const peer = scriptedServer();
    const seen: string[] = [];
    const monitor = new SessionEventMonitor({
      connect: async () => { if (peer.connects >= 2 && seen.length > 0) throw "a bare string with no code"; seen.push("connected"); return peer.connect(); },
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
    peer.push(`${JSON.stringify({ event: "pane_updated", data: { type: "pane_updated", pane: { revision: 1 } } })}\n`);
    await Promise.resolve();
    expect(matched).toEqual([]);
    peer.closeSubscription();
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
    await expect((supervision as unknown as { reviewer(): Promise<unknown> }).reviewer()).resolves.toBeDefined();
    expect(reviewerCalls).toBe(1);
    // No monitorOptions and no HERDR_SOCKET_PATH means the default monitor refuses.
    const previous = process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_SOCKET_PATH;
    try {
      await expect(supervision.reserve({ child: { agentName: "worker", agentKind: "pi", candidateName: "worker-pi" } })).rejects.toMatchObject({ code: "SUPERVISION_SOCKET_UNAVAILABLE" });
    } finally {
      if (previous !== undefined) process.env.HERDR_SOCKET_PATH = previous;
    }
    await supervision.shutdown();
  });
});

describe("review-round remediations", () => {
  it("recreates the supervision monitor for each manager session", async () => {
    // A session that follows a shutdown must still be able to reserve: the
    // previous session's monitor is stopped for good, so a new one replaces it.
    const monitors: SessionEventMonitor[] = [];
    const jobs = new JobRegistry();
    const supervision = new SupervisionRegistry({
      jobs,
      settingsLoader: async () => settings,
      readTranscript: async () => [],
      monitorFactory: () => {
        const peer = scriptedServer();
        const monitor = new SessionEventMonitor({ connect: () => peer.connect(), env: { HERDR_SOCKET_PATH: "/tmp/s.sock" }, clock: { now: () => 0, sleep: async () => undefined } });
        monitors.push(monitor);
        return monitor;
      },
    });
    const first = await supervision.reserve({ child: { agentName: "worker", agentKind: "pi", candidateName: "worker-pi" } });
    expect(first.jobId).toBeDefined();

    await supervision.shutdown();
    await expect(supervision.reserve({ child: { agentName: "worker", agentKind: "pi", candidateName: "worker-pi" } })).rejects.toMatchObject({ code: "SUPERVISION_SOCKET_CLOSED" });

    await supervision.beginSession();
    const second = await supervision.reserve({ child: { agentName: "worker", agentKind: "pi", candidateName: "worker-pi" } });
    expect(second.jobId).not.toBe(first.jobId);
    expect(monitors).toHaveLength(2);
    // The replaced monitor stays stopped; it never serves the new session.
    await expect(monitors[0]!.ensureStarted()).rejects.toMatchObject({ code: "SUPERVISION_SOCKET_CLOSED" });
    await supervision.shutdown();
  });

  it("keeps replay deduplication correct across a pane move", async () => {
    // A move preserves the pane occupancy `revision` is monotonic in, so the one
    // watermark keeps meaning across it. Nothing counts routed events and nothing
    // counts stream positions, so rewriting the routing key desynchronises
    // nothing and a head-truncated retained log cannot make position `n` lie.
    const moved = paneRecord("working", 6, "p2");
    const h = edgeSupervisor([
      snapshot([paneRecord("working")]),
      snapshot([moved], [{ pane_id: "p2", name: "worker" }]),
      snapshot([paneRecord("working", 9, "p2")], [{ pane_id: "p2", name: "worker" }]),
    ]);
    await h.supervisor.bind({ identity, candidateName: "worker-pi" });

    // Two old-pane events at the anchor revision, then the move above it.
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord("working", 5)));
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord("working", 5)));
    await h.supervisor.onEvent(paneEvent("pane_moved", moved, { previous_pane_id: "p1" }));
    expect(h.supervisor.view().child?.paneId).toBe("p2");

    // On reconnect the old-pane events no longer route here at all, and the
    // replayed move is discarded on its own revision rather than re-followed:
    // no scripted snapshot is left, so following it again would settle.
    await h.supervisor.onBootstrap(snapshot([paneRecord("working", 9, "p2")], [{ pane_id: "p2", name: "worker" }]), 2, true);
    await h.supervisor.onEvent(paneEvent("pane_moved", moved, { previous_pane_id: "p1" }));
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord("blocked", 10, "p2")));
    expect(types(h.wakes)).toEqual(["evidence_gap", "blocked"]);
    expect(h.supervisor.view().state).toBe("active");
  });

  it("advances the watermark for a move that arrived while binding", async () => {
    // A move queued before the anchor existed is folded on the same watermark
    // every other event uses, so the reconnect replay of that move is history.
    // Re-following it would compare its previous pane against the identity it
    // has already moved and settle a live supervisor `identity_lost`.
    const moved = paneRecord("working", 6, "p2");
    const h = edgeSupervisor([
      snapshot([paneRecord("working")]),
      snapshot([moved], [{ pane_id: "p2", name: "worker" }]),
      snapshot([paneRecord("working", 6, "p2")], [{ pane_id: "p2", name: "worker" }]),
    ]);
    const binding = h.supervisor.bind({ identity, candidateName: "worker-pi" });
    const queued = h.supervisor.onEvent(paneEvent("pane_moved", moved, { previous_pane_id: "p1" }));
    await binding;
    await queued;
    expect(h.supervisor.view().child?.paneId).toBe("p2");

    await h.supervisor.onEvent(paneEvent("pane_moved", moved, { previous_pane_id: "p1" }));
    expect(h.supervisor.view().state).toBe("active");
    expect(h.wakes).toHaveLength(0);
  });

  it("sends only what is new since the previous completed review", async () => {
    const windows = [["a", "b"], ["a", "b", "c"], ["a", "b", "c"]];
    let read = 0;
    const deltas: string[][] = [];
    const h = edgeSupervisor([snapshot([paneRecord("working")])], {
      scheduler: false,
      transcript: async () => windows[Math.min(read++, windows.length - 1)]!,
      onReview: (request) => { deltas.push(request.evidence.terminal.lines); },
    });
    await h.supervisor.bind({ identity, candidateName: "worker-pi" });
    const first = (h.supervisor as unknown as { review(): Promise<void> }).review();
    h.releaseReview();
    await first;
    await (h.supervisor as unknown as { review(): Promise<void> }).review();
    await (h.supervisor as unknown as { review(): Promise<void> }).review();
    expect(deltas).toEqual([["a", "b"], ["c"], []]);
  });

  it("abandons a review before the model call when the read outlives the work cycle", async () => {
    const h = edgeSupervisor([snapshot([paneRecord("working")]), snapshot([paneRecord("idle", 6)])], {
      scheduler: false,
      transcript: async () => {
        // The child finishes its cycle while the transcript read is in flight.
        await h.supervisor.onEvent(thinEvent("pane_exited", "p1"));
        return ["line"];
      },
    });
    await h.supervisor.bind({ identity, candidateName: "worker-pi" });
    await (h.supervisor as unknown as { review(): Promise<void> }).review();
    expect(h.reviews).toBe(0);
    expect(h.supervisor.view().reviewer.reviews).toEqual([]);
  });

  it("abandons a reviewer failure that belongs to a finished work cycle", async () => {
    // A rejection from a run that is already over is no more evidence than an
    // obsolete success: it must not open a degraded episode, wake anyone, or
    // re-arm the cadence of the run that replaced it.
    const h = edgeSupervisor([snapshot([paneRecord("working")]), snapshot([paneRecord("idle", 6)])], {
      transcript: async () => ["line"],
      reviewFails: true,
    });
    await h.supervisor.bind({ identity, candidateName: "worker-pi" });
    const review = (h.supervisor as unknown as { review(): Promise<void> }).review();
    // The child finishes its cycle while the failing model call is in flight.
    await h.supervisor.onEvent(thinEvent("pane_exited", "p1"));
    h.arms.length = 0;
    h.releaseReview();
    await review;
    expect(h.supervisor.view().reviewer.degraded).toBe(false);
    expect(types(h.wakes)).toEqual(["evidence_gap", "work_cycle_completed"]);
    // The finished run's own cadence is not re-armed from an obsolete review.
    expect(h.arms).toEqual([]);
  });

  it("publishes the profile that actually started the child", async () => {
    const h = edgeSupervisor([snapshot([paneRecord()])]);
    await h.supervisor.bind({ identity, candidateName: "worker-claude" });
    expect(h.supervisor.view().child).toMatchObject({ candidateName: "worker-claude", requestedCandidateName: "worker-pi" });

    const same = edgeSupervisor([snapshot([paneRecord()])]);
    await same.supervisor.bind({ identity, candidateName: "worker-pi" });
    expect(same.supervisor.view().child).not.toHaveProperty("requestedCandidateName");
  });

  it("updates the job request and the supervision view to the bound profile together", async () => {
    // A fallback-selected profile that reached only one of the two surfaces would
    // let `herdr_jobs` report two different profiles for the same child.
    const claudeSession = { source: "herdr:claude", agent: "claude", kind: "id", value: "s2" };
    const claudeIdentity: SupervisedIdentity = { paneId: "p1", terminalId: "t1", agentName: "worker", agentKind: "claude", agentSession: claudeSession };
    const peer = scriptedServer({
      snapshots: [{
        type: "session_snapshot",
        snapshot: {
          version: "0.8.2",
          protocol: 22,
          workspaces: [],
          tabs: [],
          panes: [{ pane_id: "p1", terminal_id: "t1", tab_id: "tab1", workspace_id: "w1", agent_status: "idle", revision: 5, agent: "claude", agent_session: claudeSession }],
          agents: [{ pane_id: "p1", name: "worker" }],
        },
      }],
    });
    const jobs = new JobRegistry();
    const supervision = new SupervisionRegistry({
      jobs,
      settingsLoader: async () => settings,
      readTranscript: async () => [],
      monitorFactory: () => new SessionEventMonitor({ connect: () => peer.connect(), env: { HERDR_SOCKET_PATH: "/tmp/s.sock" }, clock: { now: () => 0, sleep: async () => undefined } }),
    });
    const reservation = await supervision.reserve({ child: { agentName: "worker", agentKind: "pi", candidateName: "worker-pi" } });
    await reservation.bind({ identity: claudeIdentity, candidateName: "worker-claude" });
    const detail = jobs.get(reservation.jobId)!;
    expect(detail.request).toMatchObject({ child: { agentKind: "claude", candidateName: "worker-claude", requestedAgentKind: "pi", requestedCandidateName: "worker-pi" } });
    expect(detail.supervision?.child).toMatchObject({ agentKind: "claude", candidateName: "worker-claude", requestedAgentKind: "pi", requestedCandidateName: "worker-pi" });
    await supervision.shutdown();
  });
});
