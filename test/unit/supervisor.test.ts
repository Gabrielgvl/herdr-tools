import { describe, expect, it, vi } from "vitest";
import { ReviewerFailure } from "../../src/reviewer.js";
import type { SupervisionEvent } from "../../src/supervision/events.js";
import type { SupervisedIdentity } from "../../src/supervision/identity.js";
import type { ManagerNotifier, SupervisionWake } from "../../src/supervision/notify.js";
import { parseSocketLine, type SupervisionSocketEvent } from "../../src/supervision/protocol.js";
import type { SupervisionReviewResult, SupervisionReviewer } from "../../src/supervision/reviewer.js";
import { Supervisor, SupervisionBindError, snapshotOccupant, type SupervisionScheduler, type SupervisorDependencies } from "../../src/supervision/supervisor.js";
import { parseSnapshotResult, type HerdrSnapshot } from "../../src/targets.js";

const session = { source: "herdr:pi", agent: "pi", kind: "id", value: "s1" };

const identity: SupervisedIdentity = { paneId: "p1", terminalId: "t1", agentName: "worker", agentKind: "pi", agentSession: session };

interface PaneOptions {
  paneId?: string;
  terminalId?: string;
  status?: string;
  revision?: number;
  agentSession?: Record<string, string> | null;
  agentKind?: string | null;
}

function paneRecord(options: PaneOptions = {}): Record<string, unknown> {
  return {
    pane_id: options.paneId ?? "p1",
    terminal_id: options.terminalId ?? "t1",
    tab_id: "tab1",
    workspace_id: "w1",
    agent_status: options.status ?? "idle",
    revision: options.revision ?? 5,
    agent: options.agentKind === undefined ? "pi" : options.agentKind,
    agent_session: options.agentSession === undefined ? session : options.agentSession,
  };
}

function snapshot(panes: Array<Record<string, unknown>>, agents: Array<Record<string, unknown>> = [{ pane_id: "p1", name: "worker" }]): HerdrSnapshot {
  return parseSnapshotResult({ type: "session_snapshot", snapshot: { version: "0.8.2", protocol: 20, workspaces: [], tabs: [], panes, agents } });
}

let ordinal = 0;

/** Events reach a supervisor already validated by the protocol boundary. */
function paneEvent(kind: string, pane: Record<string, unknown>, extra: Record<string, unknown> = {}): SupervisionSocketEvent {
  return parseSocketLine(JSON.stringify({ event: kind, data: { type: kind, pane, ...extra } })) as SupervisionSocketEvent;
}

function thinEvent(kind: string, paneId = "p1"): SupervisionSocketEvent {
  return parseSocketLine(JSON.stringify({ event: kind, data: { type: kind, pane_id: paneId, workspace_id: "w1" } })) as SupervisionSocketEvent;
}

interface Harness {
  supervisor: Supervisor;
  wakes: SupervisionWake[];
  progress: string[];
  snapshots: Array<() => Promise<HerdrSnapshot>>;
  fireTimer(): void;
  timerArmed(): boolean;
  reviews: number;
  observers: number;
  degradeMonitor(): void;
}

interface HarnessOptions {
  snapshots?: Array<HerdrSnapshot | Error>;
  review?: (call: number) => Promise<SupervisionReviewResult>;
  transcript?: () => Promise<string[]>;
  cadenceMs?: number;
}

function harness(options: HarnessOptions = {}): Harness {
  const queue = [...(options.snapshots ?? [])];
  const wakes: SupervisionWake[] = [];
  const progress: string[] = [];
  let timer: (() => void) | undefined;
  let reviews = 0;
  let observers = 0;
  let degraded = false;
  const scheduler: SupervisionScheduler = {
    setTimer: (callback) => { timer = callback; return "timer"; },
    clearTimer: () => { timer = undefined; },
  };
  const notifier: ManagerNotifier = { wake: (wake) => { wakes.push(wake); } };
  const reviewer: SupervisionReviewer = {
    review: async () => {
      reviews += 1;
      if (!options.review) return { classification: "progress", summary: "moving" };
      return options.review(reviews);
    },
  };
  const deps: SupervisorDependencies = {
    jobId: "job_supervisor",
    child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" },
    monitor: {
      addObserver: () => { observers += 1; },
      removeObserver: () => { observers -= 1; },
      snapshot: async () => {
        const next = queue.shift();
        if (next === undefined) throw Object.assign(new Error("no scripted snapshot"), { code: "SUPERVISION_SOCKET_CLOSED" });
        if (next instanceof Error) throw next;
        return next;
      },
      generation: 1,
      isDegraded: () => degraded,
    },
    notifier,
    reviewer,
    cadenceMs: options.cadenceMs ?? 300_000,
    clock: { now: () => 1_000 },
    scheduler,
    readTranscript: options.transcript ?? (async () => ["line"]),
    idFactory: (() => { let id = 0; return () => `e${++id}`; })(),
    update: (text) => { progress.push(text); },
  };
  const supervisor = new Supervisor(deps);
  return {
    supervisor,
    wakes,
    progress,
    snapshots: [],
    fireTimer: () => timer?.(),
    timerArmed: () => timer !== undefined,
    get reviews() { return reviews; },
    get observers() { return observers; },
    degradeMonitor: () => { degraded = true; },
  } as Harness;
}

const types = (wakes: SupervisionWake[]): string[] => wakes.map((wake) => wake.event.type);

describe("snapshotOccupant", () => {
  it("requires exactly one pane, at most one agent, and a parseable record", () => {
    expect(snapshotOccupant(snapshot([paneRecord()]), "p1")).toMatchObject({ pane: { paneId: "p1" }, agentName: "worker" });
    expect(snapshotOccupant(snapshot([paneRecord()]), "p2")).toBeUndefined();
    expect(snapshotOccupant(snapshot([paneRecord(), paneRecord()]), "p1")).toBeUndefined();
    expect(snapshotOccupant(snapshot([paneRecord()], [{ pane_id: "p1", name: "a" }, { pane_id: "p1", name: "b" }]), "p1")).toBeUndefined();
    expect(snapshotOccupant(snapshot([paneRecord()], [{ pane_id: "p1" }]), "p1")).not.toHaveProperty("agentName");
    expect(snapshotOccupant(snapshot([{ ...paneRecord(), agent_status: "spinning" }]), "p1")).toBeUndefined();
  });
});

describe("supervisor binding", () => {
  it("binds to the proven occupant and anchors on its revision", async () => {
    const h = harness({ snapshots: [snapshot([paneRecord({ status: "working", revision: 9 })])] });
    await h.supervisor.bind({ identity, profileName: "worker-pi", stateChangeSeq: 4 });
    const view = h.supervisor.view();
    expect(view.state).toBe("active");
    expect(view.status).toBe("working");
    expect(view.child).toEqual({ agentName: "worker", agentKind: "pi", paneId: "p1", terminalId: "t1", profileName: "worker-pi" });
    expect(view.reviewer).toMatchObject({ model: "openai-codex/gpt-5.6-luna", thinking: "max", cadenceMinutes: 5, degraded: false });
    expect(h.supervisor.childLive()).toBe(true);
    // A working child arms the review cadence immediately.
    expect(h.timerArmed()).toBe(true);
  });

  it("binds without a state_change_seq rather than defaulting one", async () => {
    const h = harness({ snapshots: [snapshot([paneRecord()])] });
    await expect(h.supervisor.bind({ identity, profileName: "worker-pi" })).resolves.toBeUndefined();
    expect(h.timerArmed()).toBe(false);
  });

  it("refuses to bind when authoritative state is unreadable, absent, or a different agent", async () => {
    const unreadable = harness({ snapshots: [Object.assign(new Error("closed"), { code: "SUPERVISION_SOCKET_CLOSED" })] });
    await expect(unreadable.supervisor.bind({ identity, profileName: "worker-pi" })).rejects.toBeInstanceOf(SupervisionBindError);
    expect(unreadable.observers).toBe(0);

    const missing = harness({ snapshots: [snapshot([])] });
    await expect(missing.supervisor.bind({ identity, profileName: "worker-pi" })).rejects.toThrow(/no unique authoritative occupant/u);

    const replaced = harness({ snapshots: [snapshot([paneRecord({ agentSession: { ...session, value: "other" } })])] });
    await expect(replaced.supervisor.bind({ identity, profileName: "worker-pi" })).rejects.toThrow(/could not prove the launched identity/u);
    const failure = await replaced.supervisor.bind({ identity, profileName: "worker-pi" }).catch((error: SupervisionBindError) => error);
    expect((failure as SupervisionBindError).code).toBe("SUPERVISION_UNCONFIRMED");
  });

  it("queues events that land before the anchor exists and folds them after", async () => {
    const h = harness({ snapshots: [snapshot([paneRecord({ status: "working", revision: 5 })])] });
    const binding = h.supervisor.bind({ identity, profileName: "worker-pi" });
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "idle", revision: 6 })), ++ordinal);
    await binding;
    expect(types(h.wakes)).toEqual(["work_cycle_completed"]);
    expect(h.supervisor.view().transitions).toEqual([{ atMs: 1_000, from: "working", to: "idle", revision: 6, source: "event" }]);
  });
});

describe("supervisor folding", () => {
  async function bound(options: HarnessOptions = {}): Promise<Harness> {
    const h = harness({ ...options, snapshots: [snapshot([paneRecord({ status: "working", revision: 5 })]), ...(options.snapshots ?? [])] });
    await h.supervisor.bind({ identity, profileName: "worker-pi" });
    return h;
  }

  it("ignores historical replay below the anchor and folds everything above it", async () => {
    const h = await bound();
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "idle", revision: 4 })), ++ordinal);
    expect(h.wakes).toHaveLength(0);
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "blocked", revision: 6 })), ++ordinal);
    expect(types(h.wakes)).toEqual(["blocked"]);
    expect(h.wakes[0]!.event.priority).toBe("high");
  });

  it("keeps a working start silent and records it as a transition", async () => {
    const h = await bound();
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "idle", revision: 6 })), ++ordinal);
    h.wakes.length = 0;
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "working", revision: 7 })), ++ordinal);
    expect(h.wakes).toHaveLength(0);
    expect(h.supervisor.view().transitions.map((transition) => transition.to)).toEqual(["idle", "working"]);
    expect(h.progress.some((line) => line.includes("idle → working"))).toBe(true);
  });

  it("reconciles rather than concluding from a thin or unprovable event", async () => {
    const closed = await bound({ snapshots: [snapshot([])] });
    await closed.supervisor.onEvent(thinEvent("pane_closed"), ++ordinal);
    expect(types(closed.wakes)).toEqual(["pane_closed"]);
    expect(await closed.supervisor.run()).toEqual({ outcome: "released", reason: "event:pane_closed" });

    const unproven = await bound({ snapshots: [snapshot([paneRecord({ agentSession: null, agentKind: null })])] });
    await unproven.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ agentSession: null, agentKind: null, revision: 6 })), ++ordinal);
    expect(types(unproven.wakes)).toEqual(["released"]);

    const replaced = await bound({ snapshots: [snapshot([paneRecord({ terminalId: "t9" })])] });
    await replaced.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ terminalId: "t9", revision: 6 })), ++ordinal);
    expect(types(replaced.wakes)).toEqual(["identity_replaced"]);
    expect(await replaced.supervisor.run()).toMatchObject({ outcome: "identity_replaced" });

  });

  it("keeps supervising when reconciliation itself is unavailable", async () => {
    const h = await bound({ snapshots: [Object.assign(new Error("down"), { code: "SUPERVISION_SOCKET_CLOSED" })] });
    await h.supervisor.onEvent(thinEvent("pane_exited"), ++ordinal);
    expect(h.wakes).toHaveLength(0);
    expect(h.progress.some((line) => line.includes("reconciliation unavailable"))).toBe(true);
    expect(h.supervisor.view().state).toBe("active");
  });

  it("coalesces concurrent reconciliations into a single re-run", async () => {
    const h = await bound({ snapshots: [snapshot([paneRecord({ status: "blocked", revision: 6 })]), snapshot([paneRecord({ status: "idle", revision: 7 })])] });
    const first = h.supervisor.onEvent(thinEvent("pane_exited"), ++ordinal);
    const second = h.supervisor.onEvent(thinEvent("pane_exited"), ++ordinal);
    await Promise.all([first, second]);
    expect(types(h.wakes)).toEqual(["blocked"]);
    expect(h.supervisor.view().status).toBe("idle");
  });
});

describe("supervisor pane moves", () => {
  async function bound(after: Array<HerdrSnapshot | Error> = []): Promise<Harness> {
    const h = harness({ snapshots: [snapshot([paneRecord({ status: "working", revision: 5 })]), ...after] });
    await h.supervisor.bind({ identity, profileName: "worker-pi" });
    return h;
  }

  it("follows a move proven by an atomic event and a fresh matching occupant", async () => {
    const moved = paneRecord({ paneId: "p2", revision: 6, status: "idle" });
    const h = await bound([snapshot([moved], [{ pane_id: "p2", name: "worker" }])]);
    await h.supervisor.onEvent(paneEvent("pane_moved", moved, { previous_pane_id: "p1" }), ++ordinal);
    expect(h.supervisor.view().child?.paneId).toBe("p2");
    expect(h.supervisor.matches("p2")).toBe(true);
    expect(types(h.wakes)).toEqual(["work_cycle_completed"]);
  });

  it("settles identity_lost when a move cannot be proven", async () => {
    // A move with no previous pane id never reaches a supervisor: the protocol
    // boundary refuses it and the connection is dropped instead.
    const wrongPrevious = await bound();
    await wrongPrevious.supervisor.onEvent(paneEvent("pane_moved", paneRecord({ paneId: "p2", revision: 6 }), { previous_pane_id: "p9" }), ++ordinal);
    expect(await wrongPrevious.supervisor.run()).toMatchObject({ reason: "move_previous_pane_mismatch" });

    const unreadable = await bound([Object.assign(new Error("down"), { code: "X" })]);
    await unreadable.supervisor.onEvent(paneEvent("pane_moved", paneRecord({ paneId: "p2", revision: 6 }), { previous_pane_id: "p1" }), ++ordinal);
    expect(await unreadable.supervisor.run()).toMatchObject({ reason: "move_reconciliation_unavailable" });

    const unproven = await bound([snapshot([paneRecord({ paneId: "p2", revision: 6, agentSession: { ...session, value: "other" } })], [{ pane_id: "p2", name: "worker" }])]);
    await unproven.supervisor.onEvent(paneEvent("pane_moved", paneRecord({ paneId: "p2", revision: 6 }), { previous_pane_id: "p1" }), ++ordinal);
    expect(await unproven.supervisor.run()).toMatchObject({ reason: "move_continuity_unproven" });
  });
});

describe("supervisor reconnect and monitor health", () => {
  async function bound(after: Array<HerdrSnapshot | Error> = []): Promise<Harness> {
    const h = harness({ snapshots: [snapshot([paneRecord({ status: "working", revision: 5 })]), ...after] });
    await h.supervisor.bind({ identity, profileName: "worker-pi" });
    return h;
  }

  it("resumes silently when the reconnect snapshot proves nothing advanced", async () => {
    const h = await bound();
    await h.supervisor.onBootstrap(snapshot([paneRecord({ status: "working", revision: 5 })]), 2, true);
    expect(h.wakes).toHaveLength(0);
    expect(h.supervisor.view().monitor.evidenceGaps).toBe(0);
  });

  it("emits one high-priority evidence_gap when the sequence advanced during the outage", async () => {
    const h = await bound();
    await h.supervisor.onBootstrap(snapshot([paneRecord({ status: "working", revision: 8 })]), 2, true);
    expect(types(h.wakes)).toEqual(["evidence_gap"]);
    expect(h.wakes[0]!.event.priority).toBe("high");
    expect(h.supervisor.view().monitor.evidenceGaps).toBe(1);
  });

  it("settles identity_lost when the reconnect snapshot cannot prove continuity", async () => {
    const gone = await bound();
    await gone.supervisor.onBootstrap(snapshot([]), 2, true);
    expect(await gone.supervisor.run()).toEqual({ outcome: "identity_lost", reason: "reconnect_identity_unproven" });
  });

  it("replays a deterministic prefix without double-processing it", async () => {
    const h = await bound();
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "blocked", revision: 6 })), ++ordinal);
    expect(types(h.wakes)).toEqual(["blocked"]);
    await h.supervisor.onBootstrap(snapshot([paneRecord({ status: "blocked", revision: 7 })]), 2, true);
    // The same first event arrives again in the replay and is skipped.
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "blocked", revision: 6 })), ++ordinal);
    expect(types(h.wakes)).toEqual(["blocked", "evidence_gap"]);
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "working", revision: 7 })), ++ordinal);
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "idle", revision: 8 })), ++ordinal);
    expect(types(h.wakes)).toEqual(["blocked", "evidence_gap", "work_cycle_completed"]);
    // The skipped replay of the blocked event left exactly one blocked transition.
    expect(h.supervisor.view().transitions.map((transition) => transition.to)).toEqual(["blocked", "working", "idle"]);
  });

  it("only resets the replay cursor on a first bootstrap", async () => {
    const h = await bound();
    await h.supervisor.onBootstrap(snapshot([paneRecord({ status: "working", revision: 99 })]), 1, false);
    expect(h.wakes).toHaveLength(0);
  });

  it("ignores stream traffic before binding and after shutdown", async () => {
    const unbound = harness();
    await unbound.supervisor.onBootstrap(snapshot([]), 1, true);
    expect(unbound.supervisor.matches("p1")).toBe(false);
    unbound.supervisor.onMonitorDegraded("X");
    expect(unbound.wakes).toHaveLength(0);

    const h = await bound();
    h.supervisor.shutdown();
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "idle", revision: 6 })), ++ordinal);
    await h.supervisor.onBootstrap(snapshot([]), 2, true);
    h.supervisor.onMonitorRecovered();
    expect(h.wakes).toHaveLength(0);
  });

  it("reports one visible degraded episode and its recovery", async () => {
    const h = await bound();
    h.supervisor.onMonitorDegraded("SUPERVISION_SOCKET_UNAVAILABLE");
    expect(h.supervisor.view().state).toBe("degraded");
    h.supervisor.onMonitorRecovered();
    expect(h.supervisor.view().state).toBe("active");
    expect(types(h.wakes)).toEqual(["monitor_degraded", "monitor_recovered"]);
    h.degradeMonitor();
    expect(h.supervisor.view().monitor).toMatchObject({ connected: false, degraded: true, generation: 1 });
  });
});

describe("supervisor review cadence", () => {
  async function working(options: HarnessOptions = {}): Promise<Harness> {
    const h = harness({ ...options, snapshots: [snapshot([paneRecord({ status: "working", revision: 5 })])] });
    await h.supervisor.bind({ identity, profileName: "worker-pi" });
    return h;
  }

  it("stores a progress review silently and re-arms the cadence", async () => {
    const h = await working();
    h.fireTimer();
    await vi.waitFor(() => expect(h.supervisor.view().reviewer.reviews).toHaveLength(1));
    expect(h.wakes).toHaveLength(0);
    expect(h.supervisor.view().reviewer.lastReviewAtMs).toBe(1_000);
    expect(h.timerArmed()).toBe(true);
  });

  it("wakes the manager on an attention classification and stays active", async () => {
    const h = await working({ review: async () => ({ classification: "stalled", summary: "no output" }) });
    h.fireTimer();
    await vi.waitFor(() => expect(types(h.wakes)).toEqual(["reviewer_attention"]));
    expect(h.supervisor.view().state).toBe("active");
    expect(h.supervisor.childLive()).toBe(true);
  });

  it("degrades once, retries on the next cadence, and notifies recovery once", async () => {
    const h = await working({ review: async (call) => { if (call <= 2) throw new ReviewerFailure("model unavailable"); return { classification: "progress", summary: "moving" }; } });
    h.fireTimer();
    await vi.waitFor(() => expect(types(h.wakes)).toEqual(["reviewer_degraded"]));
    expect(h.supervisor.view().reviewer.degraded).toBe(true);
    h.fireTimer();
    await vi.waitFor(() => expect(h.reviews).toBe(2));
    expect(types(h.wakes)).toEqual(["reviewer_degraded"]);
    h.fireTimer();
    await vi.waitFor(() => expect(types(h.wakes)).toEqual(["reviewer_degraded", "reviewer_recovered"]));
    expect(h.supervisor.view().reviewer.degraded).toBe(false);
  });

  it("treats an unreadable transcript as a reviewer failure", async () => {
    const h = await working({ transcript: async () => { throw new Error("pane read failed"); } });
    h.fireTimer();
    await vi.waitFor(() => expect(types(h.wakes)).toEqual(["reviewer_degraded"]));
    expect(h.reviews).toBe(0);
  });

  it("does not review a child that stopped working or a settled supervisor", async () => {
    const stopped = harness({ snapshots: [snapshot([paneRecord({ status: "idle", revision: 5 })])] });
    await stopped.supervisor.bind({ identity, profileName: "worker-pi" });
    stopped.fireTimer();
    await Promise.resolve();
    expect(stopped.reviews).toBe(0);

    const settled = await working();
    settled.supervisor.shutdown();
    settled.fireTimer();
    await Promise.resolve();
    expect(settled.reviews).toBe(0);
  });

  it("clears the cadence when the child leaves the working state", async () => {
    const h = harness({ snapshots: [snapshot([paneRecord({ status: "working", revision: 5 })])] });
    await h.supervisor.bind({ identity, profileName: "worker-pi" });
    expect(h.timerArmed()).toBe(true);
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "idle", revision: 6 })), ++ordinal);
    expect(h.timerArmed()).toBe(false);
  });
});

describe("the supervisor job port", () => {
  it("returns pending events once and marks exactly those observed", async () => {
    const h = harness({ snapshots: [snapshot([paneRecord({ status: "working", revision: 5 })])] });
    await h.supervisor.bind({ identity, profileName: "worker-pi" });
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "blocked", revision: 6 })), ++ordinal);
    expect(h.supervisor.view().unobservedEvents).toBe(1);
    const first: SupervisionEvent[] = h.supervisor.takePendingEvents();
    expect(first).toHaveLength(1);
    expect(h.supervisor.view().unobservedEvents).toBe(0);
    expect(h.supervisor.takePendingEvents()).toEqual([]);
    expect(h.supervisor.view().events).toHaveLength(1);
  });

  it("settles on shutdown and on a released reservation, and refuses to re-settle", async () => {
    const shutdown = harness({ snapshots: [snapshot([paneRecord()])] });
    await shutdown.supervisor.bind({ identity, profileName: "worker-pi" });
    shutdown.supervisor.shutdown();
    shutdown.supervisor.shutdown();
    expect(await shutdown.supervisor.run()).toEqual({ outcome: "cancelled", reason: "manager_session_shutdown" });
    expect(shutdown.supervisor.childLive()).toBe(false);

    const released = harness();
    released.supervisor.release("launch_failed_placement");
    released.supervisor.release("ignored");
    expect(await released.supervisor.run()).toEqual({ outcome: "failed", reason: "launch_failed_placement" });
    expect(released.supervisor.view().settledReason).toBe("launch_failed_placement");

    const settledThenStopped = harness({ snapshots: [snapshot([paneRecord()]), snapshot([])] });
    await settledThenStopped.supervisor.bind({ identity, profileName: "worker-pi" });
    await settledThenStopped.supervisor.onEvent(thinEvent("pane_closed"), ++ordinal);
    settledThenStopped.supervisor.shutdown();
    expect(await settledThenStopped.supervisor.run()).toMatchObject({ outcome: "released" });

    const releasedAfterSettle = harness({ snapshots: [snapshot([paneRecord()]), snapshot([])] });
    await releasedAfterSettle.supervisor.bind({ identity, profileName: "worker-pi" });
    await releasedAfterSettle.supervisor.onEvent(thinEvent("pane_closed"), ++ordinal);
    releasedAfterSettle.supervisor.release("too late");
    expect(await releasedAfterSettle.supervisor.run()).toMatchObject({ outcome: "released" });
  });

  it("survives a job-progress publisher that throws", async () => {
    const h = harness({ snapshots: [snapshot([paneRecord()])] });
    await h.supervisor.bind({ identity, profileName: "worker-pi" });
    // Replace the update seam with one that throws; supervision must not notice.
    (h.supervisor as unknown as { deps: { update: () => void } }).deps.update = () => { throw new Error("ui gone"); };
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "blocked", revision: 6 })), ++ordinal);
    expect(types(h.wakes)).toEqual(["blocked"]);
  });

  it("reports a reserved supervisor as not live", () => {
    const h = harness();
    expect(h.supervisor.childLive()).toBe(false);
    expect(h.supervisor.view()).toMatchObject({ state: "reserved", transitions: [], events: [], unobservedEvents: 0 });
    expect(h.supervisor.view().child).toBeUndefined();
  });
});
