import { describe, expect, it, vi } from "vitest";
import type { SupervisionChildBindingPublication } from "../../src/job-registry.js";
import { ReviewerFailure } from "../../src/reviewer.js";
import type { ReconciliationFailureReason, SupervisionEvent } from "../../src/supervision/events.js";
import { classifySnapshotTarget, type SupervisedIdentity } from "../../src/supervision/identity.js";
import type { ManagerNotifier, SupervisionWake } from "../../src/supervision/notify.js";
import { parseSocketLine, type SupervisionSocketEvent } from "../../src/supervision/protocol.js";
import type { SupervisionReviewResult, SupervisionReviewer } from "../../src/supervision/reviewer.js";
import { Supervisor, SupervisionBindError, type SupervisionScheduler, type SupervisorDependencies } from "../../src/supervision/supervisor.js";
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
  /**
   * Fire the last armed cadence even though it has since been cleared. A real
   * `setTimeout` callback already dispatched into the event loop cannot be
   * cancelled, so this is the one timer state clearing cannot prevent.
   */
  fireClearedTimer(): void;
  timerArmed(): boolean;
  reviews: number;
  observers: number;
  degradeMonitor(): void;
  recoverMonitor(): void;
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
  let dispatched: (() => void) | undefined;
  let reviews = 0;
  let observers = 0;
  let degraded = false;
  const scheduler: SupervisionScheduler = {
    setTimer: (callback) => { timer = callback; dispatched = callback; return "timer"; },
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
    fireClearedTimer: () => dispatched?.(),
    timerArmed: () => timer !== undefined,
    get reviews() { return reviews; },
    get observers() { return observers; },
    degradeMonitor: () => { degraded = true; },
    recoverMonitor: () => { degraded = false; },
  } as Harness;
}

const types = (wakes: SupervisionWake[]): string[] => wakes.map((wake) => wake.event.type);

describe("target-local snapshot evidence", () => {
  it("distinguishes valid uniqueness, absence, and invalid local topology", () => {
    expect(classifySnapshotTarget(snapshot([paneRecord()]), "p1")).toMatchObject({ kind: "unique", occupant: { pane: { paneId: "p1" }, agentPresent: true, agentName: "worker" } });
    expect(classifySnapshotTarget(snapshot([paneRecord()]), "p2")).toEqual({ kind: "absent" });
    expect(classifySnapshotTarget(snapshot([paneRecord(), paneRecord()]), "p1")).toEqual({ kind: "invalid", reason: "duplicate_target_pane" });
    expect(classifySnapshotTarget(snapshot([paneRecord()], [{ pane_id: "p1", name: "a" }, { pane_id: "p1", name: "b" }]), "p1")).toEqual({ kind: "invalid", reason: "duplicate_target_agent" });
    expect(classifySnapshotTarget(snapshot([], [{ pane_id: "p1", name: "worker" }]), "p1")).toEqual({ kind: "invalid", reason: "orphan_target_agent" });
    expect(classifySnapshotTarget(snapshot([paneRecord()], []), "p1")).toMatchObject({ kind: "unique", occupant: { agentPresent: false } });
    expect(classifySnapshotTarget(snapshot([{ ...paneRecord(), agent_status: "spinning" }]), "p1")).toEqual({ kind: "invalid", reason: "target_record_malformed" });
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

    const missing = harness({ snapshots: [snapshot([], [])] });
    await expect(missing.supervisor.bind({ identity, profileName: "worker-pi" })).rejects.toThrow(/no valid unique authoritative occupant/u);

    const invalid = harness({ snapshots: [snapshot([paneRecord(), paneRecord()])] });
    await expect(invalid.supervisor.bind({ identity, profileName: "worker-pi" })).rejects.toThrow(/no valid unique authoritative occupant/u);

    const agentFree = harness({ snapshots: [snapshot([paneRecord()], [])] });
    await expect(agentFree.supervisor.bind({ identity, profileName: "worker-pi" })).rejects.toThrow(/no valid unique authoritative occupant/u);

    const replaced = harness({ snapshots: [snapshot([paneRecord({ agentSession: { ...session, value: "other" } })])] });
    const failure = await replaced.supervisor.bind({ identity, profileName: "worker-pi" }).catch((error: SupervisionBindError) => error);
    expect(failure).toBeInstanceOf(SupervisionBindError);
    expect((failure as SupervisionBindError).message).toMatch(/could not prove the launched identity/u);
    expect((failure as SupervisionBindError).code).toBe("SUPERVISION_UNCONFIRMED");
  });

  it("queues events that land before the anchor exists and commits only after draining them", async () => {
    const h = harness({ snapshots: [snapshot([paneRecord({ status: "working", revision: 5 })])] });
    const order: string[] = [];
    const publication: SupervisionChildBindingPublication = {
      commit: () => { order.push(`commit:${h.supervisor.view().state}:${String(h.supervisor.view().child)}`); },
      rollback: () => { order.push("rollback"); },
      publish: () => { order.push(`publish:${h.supervisor.view().state}:${h.supervisor.view().child?.paneId}`); },
    };
    const binding = h.supervisor.bind({ identity, profileName: "worker-pi" }, publication);
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "idle", revision: 6 })));
    expect(h.supervisor.view()).toMatchObject({ state: "reserved" });
    expect(h.supervisor.view().child).toBeUndefined();
    expect(h.supervisor.childLive()).toBe(false);
    await binding;
    expect(order).toEqual(["commit:reserved:undefined", "publish:active:p1"]);
    expect(types(h.wakes)).toEqual(["work_cycle_completed"]);
    expect(h.supervisor.view().transitions).toEqual([{ atMs: 1_000, from: "working", to: "idle", revision: 6, source: "event" }]);
  });

  it("rolls back when queued evidence cannot be drained", async () => {
    const h = harness({ snapshots: [snapshot([paneRecord({ status: "working", revision: 5 })])] });
    (h.supervisor as unknown as { deps: { notifier: ManagerNotifier } }).deps.notifier = {
      wake: () => { throw new Error("wake failed"); },
    };
    const rollback = vi.fn();
    const publication: SupervisionChildBindingPublication = { commit: vi.fn(), rollback, publish: vi.fn() };
    const binding = h.supervisor.bind({ identity, profileName: "worker-pi" }, publication);
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "idle", revision: 6 })));
    const failure = await binding.catch((error: SupervisionBindError) => error);
    expect(failure).toBeInstanceOf(SupervisionBindError);
    expect((failure as SupervisionBindError).details).toMatchObject({ cause: "UNKNOWN" });
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(h.supervisor.view().state).toBe("reserved");
    expect(h.supervisor.view().child).toBeUndefined();
    expect(h.observers).toBe(0);
  });

  it("reports a settled queued bind without assuming settlement details", async () => {
    const h = harness({ snapshots: [snapshot([paneRecord({ status: "working", revision: 5 })])] });
    (h.supervisor as unknown as { deps: { update: () => void } }).deps.update = () => {
      (h.supervisor as unknown as { state: string }).state = "settled";
    };
    const rollback = vi.fn();
    const publication: SupervisionChildBindingPublication = { commit: vi.fn(), rollback, publish: vi.fn() };
    const binding = h.supervisor.bind({ identity, profileName: "worker-pi" }, publication);
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "idle", revision: 6 })));
    const failure = await binding.catch((error: SupervisionBindError) => error);
    expect(failure).toBeInstanceOf(SupervisionBindError);
    expect((failure as SupervisionBindError).details).toMatchObject({ cause: "settled_during_bind", settledDuringBind: true });
    expect((failure as SupervisionBindError).details).not.toHaveProperty("supervisionOutcome");
    expect(rollback).toHaveBeenCalledTimes(1);
    h.supervisor.shutdown();
  });

  it("rejects when queued closure or replacement evidence settles during bind", async () => {
    const scenarios = [
      {
        label: "closure",
        h: harness({ snapshots: [snapshot([paneRecord({ status: "working", revision: 5 })]), snapshot([], [])] }),
        event: thinEvent("pane_closed"),
        outcome: "released",
      },
      {
        label: "replacement",
        h: harness({ snapshots: [
          snapshot([paneRecord({ status: "working", revision: 5 })]),
          snapshot([paneRecord({ terminalId: "t9", status: "working", revision: 6 })]),
        ] }),
        event: paneEvent("pane_updated", paneRecord({ terminalId: "t9", status: "working", revision: 6 })),
        outcome: "identity_replaced",
      },
    ] as const;
    for (const scenario of scenarios) {
      const commit = vi.fn();
      const rollback = vi.fn();
      const publication: SupervisionChildBindingPublication = { commit, rollback, publish: vi.fn() };
      const binding = scenario.h.supervisor.bind({ identity, profileName: "worker-pi" }, publication);
      await scenario.h.supervisor.onEvent(scenario.event);
      const failure = await binding.catch((error: SupervisionBindError) => error);
      expect(failure, scenario.label).toBeInstanceOf(SupervisionBindError);
      expect((failure as SupervisionBindError).details).toMatchObject({ cause: "settled_during_bind", settledDuringBind: true, supervisionOutcome: scenario.outcome });
      expect(commit).not.toHaveBeenCalled();
      expect(rollback).toHaveBeenCalledTimes(1);
      expect(scenario.h.supervisor.view().state).toBe("settled");
      expect(scenario.h.supervisor.view().child).toBeUndefined();
      expect(scenario.h.supervisor.childLive()).toBe(false);
      expect(await scenario.h.supervisor.run()).toMatchObject({ outcome: scenario.outcome });
    }
  });

  it("folds evidence admitted during the drain in arrival order behind the evidence already queued", async () => {
    const h = harness();
    let admitted: Promise<void> | undefined;
    let calls = 0;
    (h.supervisor as unknown as { deps: { monitor: { snapshot: () => Promise<HerdrSnapshot> } } }).deps.monitor.snapshot = async () => {
      calls += 1;
      if (calls === 1) return snapshot([paneRecord({ status: "working", revision: 5 })]);
      // Admitted while the drain's own reconciliation is in flight. Folding it
      // here rather than in its turn would apply revision 8 before the snapshot
      // this call answers and before the evidence already queued ahead of it,
      // regressing the watermark and discarding revision 7 entirely.
      admitted = h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "idle", revision: 8 })));
      return snapshot([paneRecord({ status: "blocked", revision: 6 })]);
    };
    let transitionsAtCommit = -1;
    const publication: SupervisionChildBindingPublication = {
      commit: () => { transitionsAtCommit = h.supervisor.view().transitions.length; },
      rollback: vi.fn(),
      publish: vi.fn(),
    };
    const binding = h.supervisor.bind({ identity, profileName: "worker-pi" }, publication);
    const first = h.supervisor.onEvent(thinEvent("pane_exited"));
    const second = h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "working", revision: 7 })));
    await binding;
    await Promise.all([first, second, admitted]);
    expect(h.supervisor.view().transitions).toEqual([
      { atMs: 1_000, from: "working", to: "blocked", revision: 6, source: "snapshot" },
      { atMs: 1_000, from: "blocked", to: "working", revision: 7, source: "event" },
      { atMs: 1_000, from: "working", to: "idle", revision: 8, source: "event" },
    ]);
    // Every admitted event was folded before the binding went public.
    expect(transitionsAtCommit).toBe(3);
    expect(h.supervisor.view().monitor.reconciliation).toMatchObject({ degraded: false, consecutiveFailures: 0 });
    expect(publication.rollback).not.toHaveBeenCalled();
  });

  it("holds the commit for closure evidence admitted during the drain", async () => {
    const h = harness();
    let closure: Promise<void> | undefined;
    let proveClosure!: (snapshot: HerdrSnapshot) => void;
    const closureSnapshot = new Promise<HerdrSnapshot>((resolve) => { proveClosure = resolve; });
    let calls = 0;
    (h.supervisor as unknown as { deps: { monitor: { snapshot: () => Promise<HerdrSnapshot> } } }).deps.monitor.snapshot = async () => {
      calls += 1;
      if (calls === 1) return snapshot([paneRecord({ status: "working", revision: 5 })]);
      // A move is followed without holding the reconciliation coalescer, so this
      // admission is the case where a concurrent fold would race the commit
      // rather than collapse into the reconciliation already running.
      if (calls === 2) {
        closure = h.supervisor.onEvent(thinEvent("pane_closed"));
        return snapshot([paneRecord({ paneId: "p2", status: "working", revision: 3 })], [{ pane_id: "p2", name: "worker" }]);
      }
      return closureSnapshot;
    };
    const commit = vi.fn();
    const rollback = vi.fn();
    const binding = h.supervisor.bind({ identity, profileName: "worker-pi" }, { commit, rollback, publish: vi.fn() });
    const move = h.supervisor.onEvent(paneEvent("pane_moved", paneRecord({ paneId: "p2", status: "working", revision: 3 }), { previous_pane_id: "p1" }));
    const settled = binding.catch((error: SupervisionBindError) => error);
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    // The closure is still being proven, so the binding cannot have gone public.
    expect(commit).not.toHaveBeenCalled();

    proveClosure(snapshot([], []));
    const failure = await settled;
    expect(failure).toBeInstanceOf(SupervisionBindError);
    expect((failure as SupervisionBindError).details).toMatchObject({ cause: "settled_during_bind", settledDuringBind: true, supervisionOutcome: "released" });
    expect(commit).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(h.supervisor.childLive()).toBe(false);
    expect(h.supervisor.view().child).toBeUndefined();
    expect(await h.supervisor.run()).toMatchObject({ outcome: "released" });
    await Promise.all([move, closure]);
  });

  it("does not reset a shutdown settlement when binding read fails", async () => {
    const h = harness();
    (h.supervisor as unknown as { deps: { monitor: { snapshot: () => Promise<HerdrSnapshot> } } }).deps.monitor.snapshot = async () => {
      h.supervisor.shutdown();
      throw new Error("snapshot closed");
    };
    await expect(h.supervisor.bind({ identity, profileName: "worker-pi" })).rejects.toBeInstanceOf(SupervisionBindError);
    expect(await h.supervisor.run()).toEqual({ outcome: "cancelled", reason: "manager_session_shutdown" });
    expect(h.supervisor.view().state).toBe("settled");
  });

  it("marks the reviewer degraded when its initial cadence cannot be armed", async () => {
    const h = harness({ snapshots: [snapshot([paneRecord({ status: "working" })])] });
    (h.supervisor as unknown as { deps: { scheduler: SupervisionScheduler } }).deps.scheduler.setTimer = () => {
      throw new Error("timer failed");
    };
    await h.supervisor.bind({ identity, profileName: "worker-pi" });
    expect(h.supervisor.view()).toMatchObject({ state: "active", reviewer: { degraded: true } });
    expect(h.timerArmed()).toBe(false);
    expect(h.progress).toContain("supervision reviewer cadence could not be armed");
  });

  it("rolls back a failed request publication and keeps the reservation unbound", async () => {
    const h = harness({ snapshots: [snapshot([paneRecord()])] });
    const publication: SupervisionChildBindingPublication = {
      commit: () => { throw new Error("private-publication-secret"); },
      rollback: vi.fn(),
      publish: vi.fn(),
    };
    const failure = await h.supervisor.bind({ identity, profileName: "worker-pi" }, publication).catch((error: SupervisionBindError) => error);
    expect(failure).toBeInstanceOf(SupervisionBindError);
    expect((failure as SupervisionBindError).message).toMatch(/could not publish its exact child/u);
    expect((failure as SupervisionBindError).message).not.toContain("private-publication-secret");
    expect(publication.rollback).toHaveBeenCalledTimes(1);
    expect(publication.publish).not.toHaveBeenCalled();
    expect(h.supervisor.view()).toMatchObject({ state: "reserved" });
    expect(h.supervisor.view().child).toBeUndefined();
    expect(h.supervisor.childLive()).toBe(false);
    expect(h.observers).toBe(0);
    await expect(h.supervisor.bind({ identity, profileName: "worker-pi" })).rejects.toThrow(/single-use/u);
    h.supervisor.release("bind_publication_failed");
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
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "idle", revision: 4 })));
    expect(h.wakes).toHaveLength(0);
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "blocked", revision: 6 })));
    expect(types(h.wakes)).toEqual(["blocked"]);
    expect(h.wakes[0]!.event.priority).toBe("high");
  });

  it("makes event-path revision jumps and same-revision status contradictions gap-visible", async () => {
    const h = await bound();
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "working", revision: 8 })));
    expect(types(h.wakes)).toEqual(["evidence_gap"]);
    expect(h.wakes[0]!.event.details).toMatchObject({
      source: "event",
      reason: "revision_jump",
      previousRevision: 5,
      observedRevision: 8,
      omittedRevisions: 2,
    });

    // An exact replay is silent after the endpoint was adopted.
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "working", revision: 8 })));
    expect(types(h.wakes)).toEqual(["evidence_gap"]);

    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "idle", revision: 8 })));
    expect(types(h.wakes)).toEqual(["evidence_gap", "evidence_gap", "work_cycle_completed"]);
    expect(h.wakes[1]!.event.details).toMatchObject({ source: "event", reason: "status_changed_without_revision", previousRevision: 8, observedRevision: 8 });
    expect(h.supervisor.view().transitions).toEqual([{ atMs: 1_000, from: "working", to: "idle", revision: 8, source: "event" }]);

    // The normal next revision with an unchanged endpoint creates no gap.
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "idle", revision: 9 })));
    expect(types(h.wakes)).toEqual(["evidence_gap", "evidence_gap", "work_cycle_completed"]);
    expect(h.supervisor.view().monitor.evidenceGaps).toBe(2);
  });

  it("keeps a working start silent and records it as a transition", async () => {
    const h = await bound();
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "idle", revision: 6 })));
    h.wakes.length = 0;
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "working", revision: 7 })));
    expect(h.wakes).toHaveLength(0);
    expect(h.supervisor.view().transitions.map((transition) => transition.to)).toEqual(["idle", "working"]);
    expect(h.progress.some((line) => line.includes("idle → working"))).toBe(true);
  });

  it("reconciles rather than concluding from a thin or unprovable event", async () => {
    const closed = await bound({ snapshots: [snapshot([], [])] });
    await closed.supervisor.onEvent(thinEvent("pane_closed"));
    expect(types(closed.wakes)).toEqual(["pane_closed"]);
    expect(await closed.supervisor.run()).toEqual({ outcome: "released", reason: "event:pane_closed" });

    const unproven = await bound({ snapshots: [snapshot([paneRecord({ agentSession: null, agentKind: null })])] });
    await unproven.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ agentSession: null, agentKind: null, revision: 6 })));
    expect(types(unproven.wakes)).toEqual(["released"]);

    const replaced = await bound({ snapshots: [snapshot([paneRecord({ terminalId: "t9" })])] });
    await replaced.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ terminalId: "t9", revision: 6 })));
    expect(types(replaced.wakes)).toEqual(["identity_replaced"]);
    expect(await replaced.supervisor.run()).toMatchObject({ outcome: "identity_replaced" });

  });

  it("keeps supervising when reconciliation itself is unavailable", async () => {
    const h = await bound({ snapshots: [Object.assign(new Error("down"), { code: "SUPERVISION_SOCKET_CLOSED" })] });
    await h.supervisor.onEvent(thinEvent("pane_exited"));
    expect(types(h.wakes)).toEqual(["reconciliation_degraded"]);
    expect(h.progress.some((line) => line.includes("reconciliation_degraded"))).toBe(true);
    expect(h.supervisor.view().state).toBe("degraded");

    for (const [code, reason] of [
      ["SUPERVISION_SOCKET_UNAVAILABLE", "connect_failed"],
      ["CLI_PROTOCOL_ERROR", "snapshot_protocol_invalid"],
      ["SUPERVISION_PROTOCOL_ERROR", "snapshot_protocol_invalid"],
    ] as const) {
      const candidate = await bound();
      const error = Object.assign(new Error("down"), { code });
      (candidate.supervisor as unknown as { deps: { monitor: { snapshot: () => Promise<HerdrSnapshot> } } }).deps.monitor.snapshot = async () => { throw error; };
      await candidate.supervisor.onEvent(thinEvent("pane_exited"));
      expect(candidate.wakes[0]?.event.details).toMatchObject({ reason });
    }
  });

  it("reconciles concurrently admitted triggers one at a time, in arrival order", async () => {
    const h = await bound({ snapshots: [snapshot([paneRecord({ status: "blocked", revision: 6 })]), snapshot([paneRecord({ status: "idle", revision: 7 })])] });
    const first = h.supervisor.onEvent(thinEvent("pane_exited"));
    const second = h.supervisor.onEvent(thinEvent("pane_exited"));
    await Promise.all([first, second]);
    // Each trigger got its own authoritative read, in the order it was admitted.
    expect(types(h.wakes)).toEqual(["evidence_gap", "blocked", "evidence_gap"]);
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
    await h.supervisor.onEvent(paneEvent("pane_moved", moved, { previous_pane_id: "p1" }));
    expect(h.supervisor.view().child?.paneId).toBe("p2");
    expect(h.supervisor.matches("p2")).toBe(true);
    expect(types(h.wakes)).toEqual(["work_cycle_completed"]);
  });

  it("reconciles rather than concluding from a move that is not this child's", async () => {
    // A move with no previous pane id never reaches a supervisor: the protocol
    // boundary refuses it and the connection is dropped instead. A move whose
    // previous pane is not ours is routed here only because its *destination* is
    // our pane id — a replay of our own earlier move, or a recycled pane id.
    // Pane IDs are reused, so concluding `identity_lost` from that would settle
    // a live supervisor on somebody else's evidence; authoritative state decides.
    const live = await bound([snapshot([paneRecord({ status: "blocked", revision: 7 })])]);
    await live.supervisor.onEvent(paneEvent("pane_moved", paneRecord({ revision: 6 }), { previous_pane_id: "p9" }));
    expect(live.supervisor.view().state).toBe("active");
    expect(live.supervisor.view().child?.paneId).toBe("p1");
    expect(types(live.wakes)).toEqual(["evidence_gap", "blocked"]);

    // The same event settles only where authoritative state proves the loss.
    const taken = await bound([snapshot([paneRecord({ revision: 7, terminalId: "t9" })])]);
    await taken.supervisor.onEvent(paneEvent("pane_moved", paneRecord({ revision: 6 }), { previous_pane_id: "p9" }));
    expect(await taken.supervisor.run()).toMatchObject({ outcome: "identity_replaced" });

    // A move that does leave our pane but whose own record does not prove our
    // occupant is somebody else's move out of a recycled pane id. It reconciles
    // before spending a snapshot on following it.
    const foreign = await bound([snapshot([paneRecord({ status: "blocked", revision: 7 })])]);
    await foreign.supervisor.onEvent(paneEvent("pane_moved", paneRecord({ paneId: "p2", revision: 6, terminalId: "t9" }), { previous_pane_id: "p1" }));
    expect(foreign.supervisor.view().child?.paneId).toBe("p1");
    expect(types(foreign.wakes)).toEqual(["evidence_gap", "blocked"]);
  });

  it("rebases a proven move to the destination pane's lower local revision", async () => {
    const destination = paneRecord({ paneId: "p2", revision: 1, status: "idle" });
    const h = await bound([snapshot([destination], [{ pane_id: "p2", name: "worker" }])]);
    await h.supervisor.onEvent(paneEvent("pane_moved", paneRecord({ paneId: "p2", revision: 1, status: "idle" }), { previous_pane_id: "p1" }));
    expect(h.supervisor.view().child?.paneId).toBe("p2");
    expect(h.supervisor.view().state).toBe("active");
    expect(types(h.wakes)).toEqual(["work_cycle_completed"]);

    // Revision two is the next destination event, not a jump from origin five.
    h.wakes.length = 0;
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ paneId: "p2", revision: 2, status: "working" })));
    expect(h.wakes).toHaveLength(0);
    expect(h.supervisor.view().monitor.evidenceGaps).toBe(0);
  });

  it("settles identity_lost when a move cannot be proven", async () => {
    const unreadable = await bound([Object.assign(new Error("down"), { code: "X" })]);
    await unreadable.supervisor.onEvent(paneEvent("pane_moved", paneRecord({ paneId: "p2", revision: 6 }), { previous_pane_id: "p1" }));
    expect(await unreadable.supervisor.run()).toMatchObject({ reason: "move_reconciliation_unavailable" });

    const unproven = await bound([snapshot([paneRecord({ paneId: "p2", revision: 6, agentSession: { ...session, value: "other" } })], [{ pane_id: "p2", name: "worker" }])]);
    await unproven.supervisor.onEvent(paneEvent("pane_moved", paneRecord({ paneId: "p2", revision: 6 }), { previous_pane_id: "p1" }));
    expect(await unproven.supervisor.run()).toMatchObject({ reason: "move_continuity_unproven" });

    const invalid = await bound([snapshot([paneRecord({ paneId: "p2" }), paneRecord({ paneId: "p2" })])]);
    await invalid.supervisor.onEvent(paneEvent("pane_moved", paneRecord({ paneId: "p2", revision: 6 }), { previous_pane_id: "p1" }));
    expect(invalid.supervisor.view()).toMatchObject({ state: "degraded", child: { paneId: "p1" } });
    expect(types(invalid.wakes)).toEqual(["reconciliation_degraded"]);
  });

  /** The destination of a proven move whose first destination read was invalid. */
  const invalidDestination = (): HerdrSnapshot => snapshot([paneRecord({ paneId: "p2" }), paneRecord({ paneId: "p2" })]);

  it("follows a retained move destination once a later read of it is valid", async () => {
    const destination = paneRecord({ paneId: "p2", revision: 1, status: "idle" });
    const h = await bound([invalidDestination(), invalidDestination(), snapshot([destination], [{ pane_id: "p2", name: "worker" }])]);
    await h.supervisor.onEvent(paneEvent("pane_moved", destination, { previous_pane_id: "p1" }));
    expect(h.supervisor.view()).toMatchObject({ state: "degraded", child: { paneId: "p1" } });

    // Origin-pane evidence cannot be folded while the child is elsewhere: the
    // watermark still counts origin revisions and the child is not there. It
    // triggers a read, and a still-invalid destination keeps the move pending.
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "blocked", revision: 9 })));
    expect(h.supervisor.view()).toMatchObject({ state: "degraded", child: { paneId: "p1" }, status: "working" });

    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "blocked", revision: 9 })));
    expect(h.supervisor.view()).toMatchObject({ state: "active", child: { paneId: "p2" }, status: "idle" });
    expect(h.supervisor.matches("p2")).toBe(true);
    expect(types(h.wakes)).toEqual(["reconciliation_degraded", "reconciliation_recovered", "work_cycle_completed"]);

    // The recovered move rebases too, so revision two is the next destination
    // event rather than a jump from the origin pane's numbering.
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ paneId: "p2", revision: 2, status: "working" })));
    expect(h.supervisor.view()).toMatchObject({ status: "working", monitor: { evidenceGaps: 0 } });
  });

  it("settles replacement when the retained destination holds a different agent", async () => {
    const h = await bound([invalidDestination()]);
    await h.supervisor.onEvent(paneEvent("pane_moved", paneRecord({ paneId: "p2", revision: 6 }), { previous_pane_id: "p1" }));
    // The origin pane is absent because this very move emptied it. Judging that
    // absence would settle `pane_closed` on a child that is alive in p2.
    await h.supervisor.onReconciliationSnapshot(snapshot([paneRecord({ paneId: "p2", terminalId: "t9" })], [{ pane_id: "p2", name: "other" }]));
    expect(await h.supervisor.run()).toEqual({ outcome: "identity_replaced", reason: "periodic_snapshot" });
    expect(types(h.wakes)).toEqual(["reconciliation_degraded", "reconciliation_recovered", "identity_replaced"]);
  });

  it("settles pane_closed only when the retained destination is itself absent", async () => {
    const h = await bound([invalidDestination()]);
    await h.supervisor.onEvent(paneEvent("pane_moved", paneRecord({ paneId: "p2", revision: 6 }), { previous_pane_id: "p1" }));
    await h.supervisor.onReconciliationSnapshot(snapshot([], []));
    expect(await h.supervisor.run()).toEqual({ outcome: "released", reason: "periodic_snapshot" });
    expect(types(h.wakes)).toEqual(["reconciliation_degraded", "reconciliation_recovered", "pane_closed"]);
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

  it("adopts the reconnect snapshot's own status, not only the gap it proves", async () => {
    // The retained log can scroll past the outage, so the individual transitions
    // are not always replayable. Reporting the gap without applying the state the
    // snapshot proves would leave supervision reporting a stale status for good.
    const h = await bound();
    await h.supervisor.onBootstrap(snapshot([paneRecord({ status: "blocked", revision: 9 })]), 2, true);
    expect(types(h.wakes)).toEqual(["evidence_gap", "blocked"]);
    expect(h.supervisor.view().status).toBe("blocked");
    expect(h.supervisor.view().transitions).toEqual([{ atMs: 1_000, from: "working", to: "blocked", revision: 9, source: "snapshot" }]);
    // The adopted revision is the new watermark: the scrolled-past replay, if it
    // does arrive, is history and is not folded a second time.
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "working", revision: 8 })));
    expect(h.supervisor.view().status).toBe("blocked");
  });

  it("settles identity_lost when the reconnect snapshot cannot prove continuity", async () => {
    const gone = await bound();
    await gone.supervisor.onBootstrap(snapshot([], []), 2, true);
    expect(await gone.supervisor.run()).toEqual({ outcome: "identity_lost", reason: "reconnect_identity_unproven" });
  });

  it("replays a deterministic prefix without double-processing it", async () => {
    const h = await bound();
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "blocked", revision: 6 })));
    expect(types(h.wakes)).toEqual(["blocked"]);
    await h.supervisor.onBootstrap(snapshot([paneRecord({ status: "blocked", revision: 7 })]), 2, true);
    // The same first event arrives again in the replay and is skipped.
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "blocked", revision: 6 })));
    expect(types(h.wakes)).toEqual(["blocked", "evidence_gap"]);
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "working", revision: 7 })));
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "idle", revision: 8 })));
    expect(types(h.wakes)).toEqual(["blocked", "evidence_gap", "evidence_gap", "work_cycle_completed"]);
    // The skipped replay of the blocked event left exactly one blocked transition.
    expect(h.supervisor.view().transitions.map((transition) => transition.to)).toEqual(["blocked", "working", "idle"]);
  });

  it("makes no gap decision on a first bootstrap", async () => {
    const h = await bound();
    await h.supervisor.onBootstrap(snapshot([paneRecord({ status: "working", revision: 99 })]), 1, false);
    expect(h.wakes).toHaveLength(0);
  });

  it("ignores stream traffic before binding and after shutdown", async () => {
    const unbound = harness();
    await unbound.supervisor.onBootstrap(snapshot([]), 1, true);
    await unbound.supervisor.onReconciliationSnapshot(snapshot([]));
    unbound.supervisor.onReconciliationFailure("request_failed");
    expect(unbound.supervisor.matches("p1")).toBe(false);
    unbound.supervisor.onMonitorDegraded("X");
    expect(unbound.wakes).toHaveLength(0);

    const h = await bound();
    h.supervisor.shutdown();
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "idle", revision: 6 })));
    await h.supervisor.onBootstrap(snapshot([]), 2, true);
    await h.supervisor.onReconciliationSnapshot(snapshot([]));
    h.supervisor.onReconciliationFailure("request_failed");
    h.supervisor.onMonitorRecovered();
    expect(h.wakes).toHaveLength(0);
  });

  it("reconciles a missed status transition and snapshot revision gaps", async () => {
    const h = harness({ snapshots: [snapshot([paneRecord({ status: "idle", revision: 5 })])] });
    await h.supervisor.bind({ identity, profileName: "worker-pi" });
    await h.supervisor.onReconciliationSnapshot(snapshot([paneRecord({ status: "working", revision: 8 })]));
    expect(types(h.wakes)).toEqual(["evidence_gap"]);
    expect(h.wakes[0]!.event.details).toMatchObject({ source: "snapshot", reason: "revision_jump", previousRevision: 5, observedRevision: 8 });
    expect(h.supervisor.view().status).toBe("working");
    expect(h.supervisor.view().transitions).toEqual([{ atMs: 1_000, from: "idle", to: "working", revision: 8, source: "snapshot" }]);

    // Exact currency is silent. A status contradiction at that same revision is
    // still gap-visible and its authoritative endpoint is adopted.
    await h.supervisor.onReconciliationSnapshot(snapshot([paneRecord({ status: "working", revision: 8 })]));
    await h.supervisor.onReconciliationSnapshot(snapshot([paneRecord({ status: "idle", revision: 8 })]));
    expect(types(h.wakes)).toEqual(["evidence_gap", "evidence_gap", "work_cycle_completed"]);
    expect(h.supervisor.view().monitor).toMatchObject({
      evidenceGaps: 2,
      reconciliation: { degraded: false, consecutiveFailures: 0, lastAttemptAtMs: 1_000, lastSuccessAtMs: 1_000 },
    });
  });

  it("rejects regressed snapshot revisions and recovers only from valid current evidence", async () => {
    const h = await bound();
    await h.supervisor.onReconciliationSnapshot(snapshot([paneRecord({ status: "idle", revision: 4 })]));
    expect(types(h.wakes)).toEqual(["reconciliation_degraded"]);
    expect(h.supervisor.view()).toMatchObject({
      state: "degraded",
      status: "working",
      monitor: { reconciliation: { degraded: true, consecutiveFailures: 1, lastFailureReason: "revision_regressed" } },
    });
    expect(h.supervisor.view().transitions).toEqual([]);

    await h.supervisor.onReconciliationSnapshot(snapshot([paneRecord({ status: "working", revision: 5 })]));
    expect(types(h.wakes)).toEqual(["reconciliation_degraded", "reconciliation_recovered"]);
    expect(h.supervisor.view()).toMatchObject({
      state: "active",
      monitor: { reconciliation: { degraded: false, consecutiveFailures: 0, lastSuccessAtMs: 1_000, lastFailureAtMs: 1_000 } },
    });
    expect(h.supervisor.view().monitor.reconciliation).not.toHaveProperty("lastFailureReason");
  });

  it.each([
    ["duplicate pane", snapshot([paneRecord(), paneRecord()]), "duplicate_target_pane"],
    ["duplicate agent", snapshot([paneRecord()], [{ pane_id: "p1", name: "worker" }, { pane_id: "p1", name: "worker" }]), "duplicate_target_agent"],
    ["orphan agent", snapshot([], [{ pane_id: "p1", name: "worker" }]), "orphan_target_agent"],
    ["malformed target", snapshot([{ ...paneRecord(), agent_status: "spinning" }]), "target_record_malformed"],
    ["contradictory identity", snapshot([paneRecord()], [{ pane_id: "p1", name: "worker", terminal_id: "t9" }]), "target_identity_contradiction"],
  ] as Array<[string, HerdrSnapshot, ReconciliationFailureReason]>)("degrades without settling on $0 snapshot evidence", async (_label, invalid, reason) => {
    const h = await bound();
    await h.supervisor.onReconciliationSnapshot(invalid);
    await h.supervisor.onReconciliationSnapshot(invalid);
    expect(h.supervisor.childLive()).toBe(true);
    expect(h.supervisor.view()).toMatchObject({
      state: "degraded",
      status: "working",
      monitor: { reconciliation: { degraded: true, consecutiveFailures: 2, lastFailureReason: reason } },
    });
    expect(types(h.wakes)).toEqual(["reconciliation_degraded"]);
    expect(JSON.stringify(h.supervisor.view().events)).not.toContain("backend");

    await h.supervisor.onReconciliationSnapshot(snapshot([paneRecord({ status: "working", revision: 5 })]));
    expect(types(h.wakes)).toEqual(["reconciliation_degraded", "reconciliation_recovered"]);
    expect(h.supervisor.view().state).toBe("active");
  });

  it("settles only from valid absent, agent-free, or replacement evidence", async () => {
    const absent = await bound();
    await absent.supervisor.onReconciliationSnapshot(snapshot([], []));
    expect(types(absent.wakes)).toEqual(["pane_closed"]);
    expect(await absent.supervisor.run()).toMatchObject({ outcome: "released" });

    const agentFree = await bound();
    await agentFree.supervisor.onReconciliationSnapshot(snapshot([paneRecord()], []));
    expect(types(agentFree.wakes)).toEqual(["released"]);
    expect(await agentFree.supervisor.run()).toMatchObject({ outcome: "released" });

    const replaced = await bound();
    await replaced.supervisor.onReconciliationSnapshot(snapshot([paneRecord({ terminalId: "t9" })]));
    expect(types(replaced.wakes)).toEqual(["identity_replaced"]);
    expect(await replaced.supervisor.run()).toMatchObject({ outcome: "identity_replaced" });
  });

  it("keeps subscription and reconciliation health independent and aggregate", async () => {
    const h = await bound();
    h.supervisor.onReconciliationFailure("request_failed");
    expect(h.supervisor.view()).toMatchObject({ state: "degraded", monitor: { connected: true, degraded: true, reconciliation: { degraded: true } } });
    h.supervisor.onMonitorDegraded("SUPERVISION_SOCKET_UNAVAILABLE");
    expect(h.supervisor.view().monitor.connected).toBe(false);

    await h.supervisor.onReconciliationSnapshot(snapshot([paneRecord({ status: "working", revision: 5 })]));
    expect(h.supervisor.view()).toMatchObject({ state: "degraded", monitor: { connected: false, degraded: true, reconciliation: { degraded: false } } });
    h.supervisor.onMonitorRecovered();
    expect(h.supervisor.view()).toMatchObject({ state: "active", monitor: { connected: true, degraded: false } });
    expect(types(h.wakes)).toEqual(["reconciliation_degraded", "monitor_degraded", "reconciliation_recovered", "monitor_recovered"]);
  });

  it("reports one visible degraded subscription episode and its recovery", async () => {
    const h = await bound();
    h.supervisor.onMonitorDegraded("SUPERVISION_SOCKET_UNAVAILABLE");
    expect(h.supervisor.view().state).toBe("degraded");
    h.supervisor.onMonitorRecovered();
    expect(h.supervisor.view().state).toBe("active");
    expect(types(h.wakes)).toEqual(["monitor_degraded", "monitor_recovered"]);
    h.degradeMonitor();
    expect(h.supervisor.view().monitor).toMatchObject({ connected: false, degraded: true, generation: 1 });
  });

  /** Binding during an outage is the one way this supervisor never observes the degrade that started it. */
  async function boundDuringOutage(): Promise<Harness> {
    const h = harness({ snapshots: [snapshot([paneRecord({ status: "working", revision: 5 })])] });
    h.degradeMonitor();
    await h.supervisor.bind({ identity, profileName: "worker-pi" });
    expect(h.supervisor.view()).toMatchObject({ state: "degraded", monitor: { connected: false, degraded: true } });
    expect(h.supervisor.childLive()).toBe(true);
    // The outage was already visible when the child bound, so it is not news.
    expect(h.wakes).toHaveLength(0);
    return h;
  }

  it("adopts an outage that was already running when it bound and recovers from it exactly once", async () => {
    const h = await boundDuringOutage();

    // The monitor announces recovery before it clears its own flag.
    h.supervisor.onMonitorRecovered();
    expect(types(h.wakes)).toEqual(["monitor_recovered"]);
    h.recoverMonitor();
    expect(h.supervisor.view()).toMatchObject({ state: "active", monitor: { connected: true, degraded: false } });

    h.supervisor.onMonitorRecovered();
    expect(types(h.wakes)).toEqual(["monitor_recovered"]);
  });

  it("keeps a re-announced bind-time outage silent and still recovers once", async () => {
    const h = await boundDuringOutage();
    h.supervisor.onMonitorDegraded("SUPERVISION_SOCKET_UNAVAILABLE");
    expect(h.wakes).toHaveLength(0);
    expect(h.supervisor.view().state).toBe("degraded");

    h.supervisor.onMonitorRecovered();
    h.recoverMonitor();
    expect(h.supervisor.view()).toMatchObject({ state: "active", monitor: { connected: true, degraded: false } });
    expect(types(h.wakes)).toEqual(["monitor_recovered"]);
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
    // A cadence that fires anyway — a timer already in the event loop when the
    // child left `working` — reviews nothing and re-arms nothing.
    const review = (h: Harness): Promise<void> => (h.supervisor as unknown as { review(): Promise<void> }).review();

    const stopped = harness({ snapshots: [snapshot([paneRecord({ status: "idle", revision: 5 })])] });
    await stopped.supervisor.bind({ identity, profileName: "worker-pi" });
    await review(stopped);
    expect(stopped.reviews).toBe(0);
    expect(stopped.timerArmed()).toBe(false);

    const settled = await working();
    settled.supervisor.shutdown();
    await review(settled);
    expect(settled.reviews).toBe(0);
    expect(settled.timerArmed()).toBe(false);
  });

  it("lets an obsolete in-flight review yield the cadence to the run that replaced it", async () => {
    // The child stops and starts working again while a review is still settling.
    // The new run's cadence must fire eventually, not be starved by a call the
    // obsolete review is still holding, and not be cleared by its completion.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = await working({ review: async () => { await gate; return { classification: "progress", summary: "moving" }; } });
    h.fireTimer();
    await vi.waitFor(() => expect(h.reviews).toBe(1));

    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "idle", revision: 6 })));
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "working", revision: 7 })));
    // The new run's own cadence fires while the first review is still in flight.
    h.fireTimer();
    await Promise.resolve();
    expect(h.reviews).toBe(1);
    expect(h.timerArmed()).toBe(true);

    // A cadence that fires after the child has left working re-arms nothing:
    // the run that owned it is over, so nothing is left to starve.
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "idle", revision: 8 })));
    expect(h.timerArmed()).toBe(false);
    h.fireClearedTimer();
    await Promise.resolve();
    expect(h.reviews).toBe(1);
    expect(h.timerArmed()).toBe(false);

    release();
    await vi.waitFor(() => expect(h.supervisor.view().reviewer.reviews).toEqual([]));
    // The obsolete review stored nothing and armed nothing of its own.
    expect(h.timerArmed()).toBe(false);
  });

  it("clears the cadence when the child leaves the working state", async () => {
    const h = harness({ snapshots: [snapshot([paneRecord({ status: "working", revision: 5 })])] });
    await h.supervisor.bind({ identity, profileName: "worker-pi" });
    expect(h.timerArmed()).toBe(true);
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "idle", revision: 6 })));
    expect(h.timerArmed()).toBe(false);
  });
});

describe("the supervisor job port", () => {
  it("returns pending events once and marks exactly those observed", async () => {
    const h = harness({ snapshots: [snapshot([paneRecord({ status: "working", revision: 5 })])] });
    await h.supervisor.bind({ identity, profileName: "worker-pi" });
    expect(h.supervisor.coversIdentity(identity)).toBe(true);
    expect(h.supervisor.coversIdentity({ ...identity, paneId: "p2" })).toBe(false);
    expect(h.supervisor.coversIdentity({ ...identity, agentSession: undefined } as unknown as SupervisedIdentity)).toBe(false);
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "blocked", revision: 6 })));
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

    const settledThenStopped = harness({ snapshots: [snapshot([paneRecord()]), snapshot([], [])] });
    await settledThenStopped.supervisor.bind({ identity, profileName: "worker-pi" });
    await settledThenStopped.supervisor.onEvent(thinEvent("pane_closed"));
    settledThenStopped.supervisor.shutdown();
    await (settledThenStopped.supervisor as unknown as { settle(outcome: "cancelled", reason: string): Promise<void> }).settle("cancelled", "ignored");
    expect(await settledThenStopped.supervisor.run()).toMatchObject({ outcome: "released" });

    const releasedAfterSettle = harness({ snapshots: [snapshot([paneRecord()]), snapshot([], [])] });
    await releasedAfterSettle.supervisor.bind({ identity, profileName: "worker-pi" });
    await releasedAfterSettle.supervisor.onEvent(thinEvent("pane_closed"));
    releasedAfterSettle.supervisor.release("too late");
    expect(await releasedAfterSettle.supervisor.run()).toMatchObject({ outcome: "released" });
  });

  it("survives a job-progress publisher that throws", async () => {
    const h = harness({ snapshots: [snapshot([paneRecord()])] });
    await h.supervisor.bind({ identity, profileName: "worker-pi" });
    // Replace the update seam with one that throws; supervision must not notice.
    (h.supervisor as unknown as { deps: { update: () => void } }).deps.update = () => { throw new Error("ui gone"); };
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "blocked", revision: 6 })));
    expect(types(h.wakes)).toEqual(["blocked"]);
  });

  it("reports a reserved supervisor as not live", () => {
    const h = harness();
    expect(h.supervisor.childLive()).toBe(false);
    expect(h.supervisor.coversIdentity(identity)).toBe(false);
    expect(h.supervisor.view()).toMatchObject({ state: "reserved", transitions: [], events: [], unobservedEvents: 0 });
    expect(h.supervisor.view().child).toBeUndefined();
  });
});
