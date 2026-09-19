import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createHandoffAllocator, readHandoffState, type HandoffAllocation } from "../../src/handoff.js";
import { createHandoffGate, type HandoffGate } from "../../src/handoff-gate.js";
import type { SupervisionChildBindingPublication } from "../../src/job-registry.js";
import { ReviewerFailure } from "../../src/reviewer.js";
import type { ReconciliationFailureReason, SupervisionEvent } from "../../src/supervision/events.js";
import { classifySnapshotTarget, type ProvisionalSupervisedIdentity, type ProvisionalSupervisionBinding, type SupervisedIdentity } from "../../src/supervision/identity.js";
import type { ManagerNotifier, SupervisionWake } from "../../src/supervision/notify.js";
import { createSelfCloseTracker, type SelfCloseTracker } from "../../src/supervision/self-close.js";
import { parseSocketLine, type SupervisionSocketEvent } from "../../src/supervision/protocol.js";
import { reviewLogPaths, ReviewLogError, type SupervisionLogRecord, type SupervisionReviewLogEntry } from "../../src/supervision/review-log.js";
import type { SupervisionReviewRequest, SupervisionReviewResult, SupervisionReviewer } from "../../src/supervision/reviewer.js";
import { Supervisor, SupervisionBindError, type SupervisionBinding, type SupervisionScheduler, type SupervisorDependencies } from "../../src/supervision/supervisor.js";
import { parseSnapshotResult, type HerdrSnapshot } from "../../src/targets.js";

const session = { source: "herdr:pi", agent: "pi", kind: "id", value: "s1" };

const identity: SupervisedIdentity = { paneId: "p1", terminalId: "t1", agentName: "worker", agentKind: "pi", agentSession: session };
const agyIdentity: ProvisionalSupervisedIdentity = { paneId: "p1", terminalId: "t1", agentName: "worker", agentKind: "agy" };
const agySession = { source: "agy", agent: "agy", kind: "id", value: "agy-1" };
const provisionalBinding: ProvisionalSupervisionBinding = {
  identity: agyIdentity,
  profileName: "researcher-agy",
  baseline: { state: "idle", stateChangeSeq: 4, revision: 2 },
};
const exactAgyIdentity: SupervisedIdentity = { ...agyIdentity, agentSession: agySession };

interface PaneOptions {
  paneId?: string;
  terminalId?: string;
  status?: string;
  revision?: number;
  stateChangeSeq?: number;
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
    ...(options.stateChangeSeq === undefined ? {} : { state_change_seq: options.stateChangeSeq }),
    agent: options.agentKind === undefined ? "pi" : options.agentKind,
    agent_session: options.agentSession === undefined ? session : options.agentSession,
  };
}

function agyPaneRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { pane_id: "p1", terminal_id: "t1", tab_id: "tab1", workspace_id: "w1", agent_status: "idle", revision: 2, agent: "agy", agent_session: null, state_change_seq: 4, ...overrides };
}

function agyAgentRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { pane_id: "p1", name: "worker", agent: "agy", agent_session: null, agent_status: "idle", revision: 2, state_change_seq: 4, ...overrides };
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

/** The destination of a proven move whose read of that destination was invalid. */
const invalidDestination = (paneId = "p2"): HerdrSnapshot => snapshot([paneRecord({ paneId }), paneRecord({ paneId })]);

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
  /** The pane of every review that actually reached the model, in order. */
  reviewedPanes: string[];
  /** Every request that reached the reviewer, in order. */
  reviewRequests: SupervisionReviewRequest[];
  /** Every entry the supervisor handed the review-log seam, in order. */
  logged: SupervisionReviewLogEntry[];
  observers: number;
  degradeMonitor(): void;
  recoverMonitor(): void;
}

interface HarnessOptions {
  snapshots?: Array<HerdrSnapshot | Error | Promise<HerdrSnapshot>>;
  review?: (call: number) => Promise<SupervisionReviewResult>;
  transcript?: (paneId: string) => Promise<string[]>;
  cadenceMs?: number;
  child?: SupervisorDependencies["child"];
  assignmentDigest?: SupervisorDependencies["assignmentDigest"];
  selfClose?: SelfCloseTracker;
  handoffs?: HandoffGate;
  repairPrompt?: SupervisorDependencies["repairPrompt"];
  /** The review-log append seam; `"default"` exercises the real `appendSupervisionReview` — always pair it with `reviewLogRoot`. */
  reviewLog?: SupervisorDependencies["reviewLog"] | "default";
  /** The trusted root the default seam appends under. */
  reviewLogRoot?: string;
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
  const reviewedPanes: string[] = [];
  const reviewRequests: SupervisionReviewRequest[] = [];
  const logged: SupervisionReviewLogEntry[] = [];
  const reviewer: SupervisionReviewer = {
    review: async (request) => {
      reviews += 1;
      reviewedPanes.push(request.paneId);
      reviewRequests.push(request);
      if (!options.review) return { classification: "progress", summary: "moving" };
      return options.review(reviews);
    },
  };
  const deps: SupervisorDependencies = {
    jobId: "job_supervisor",
    child: options.child ?? { agentName: "worker", agentKind: "pi", profileName: "worker-pi" },
    monitor: {
      addObserver: () => { observers += 1; },
      removeObserver: () => { observers -= 1; },
      snapshot: async () => {
        const next = queue.shift();
        if (next === undefined) throw Object.assign(new Error("no scripted snapshot"), { code: "SUPERVISION_SOCKET_CLOSED" });
        if (next instanceof Error) throw next;
        return await next;
      },
      generation: 1,
      isDegraded: () => degraded,
    },
    notifier,
    reviewer,
    ...(options.assignmentDigest === undefined ? {} : { assignmentDigest: options.assignmentDigest }),
    ...(options.reviewLog === "default" ? {} : { reviewLog: options.reviewLog ?? (async (entry: SupervisionReviewLogEntry) => { logged.push(entry); }) }),
    ...(options.reviewLogRoot === undefined ? {} : { reviewLogRoot: options.reviewLogRoot }),
    cadenceMs: options.cadenceMs ?? 300_000,
    clock: { now: () => 1_000 },
    scheduler,
    ...(options.selfClose ? { selfClose: options.selfClose } : {}),
    ...(options.handoffs ? { handoffs: options.handoffs } : {}),
    ...(options.repairPrompt ? { repairPrompt: options.repairPrompt } : {}),
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
    reviewedPanes,
    reviewRequests,
    logged,
    get observers() { return observers; },
    degradeMonitor: () => { degraded = true; },
    recoverMonitor: () => { degraded = false; },
  } as Harness;
}

const types = (wakes: SupervisionWake[]): string[] => wakes.map((wake) => wake.event.type);

function agyExactSnapshot(overrides: Record<string, unknown> = {}): HerdrSnapshot {
  const record = { agent_session: agySession, agent_status: "working", revision: 3, state_change_seq: 5, ...overrides };
  return snapshot([agyPaneRecord(record)], [agyAgentRecord(record)]);
}

async function bindAgy(h: Harness, binding: ProvisionalSupervisionBinding = provisionalBinding): Promise<void> {
  await h.supervisor.bindProvisional(binding);
}

function provisionalCause(h: Harness): unknown {
  return h.supervisor.view().events.at(-1)?.details?.cause;
}

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
    expect(view.reviewer).toMatchObject({ model: "typesafe/jev-latest", cadenceMinutes: 5, degraded: false });
    expect(h.supervisor.childLive()).toBe(true);
    // A working child arms the review cadence immediately.
    expect(h.timerArmed()).toBe(true);
  });

  it("publishes AGY provisional evidence, keeps the observer, then strengthens atomically", async () => {
    const baseline = snapshot([agyPaneRecord()], [agyAgentRecord()]);
    const exact = snapshot(
      [agyPaneRecord({ agent_session: agySession, agent_status: "working", revision: 3, state_change_seq: 5 })],
      [agyAgentRecord({ agent_session: agySession, agent_status: "working", revision: 3, state_change_seq: 5 })],
    );
    const h = harness({ child: { agentName: "worker", agentKind: "agy", profileName: "researcher-agy" }, snapshots: [baseline, exact] });
    const provisional: ProvisionalSupervisionBinding = { identity: agyIdentity, profileName: "researcher-agy", baseline: { state: "idle", stateChangeSeq: 4, revision: 2 } };
    const events: string[] = [];
    await h.supervisor.bindProvisional(provisional, { commit: () => { events.push(`provisional-commit:${h.supervisor.view().state}`); }, rollback: vi.fn(), publish: () => { events.push(`provisional-publish:${h.supervisor.view().state}`); } });
    expect(h.supervisor.view()).toMatchObject({ state: "provisional", provisional: { paneId: "p1", terminalId: "t1", agentKind: "agy", baseline: { stateChangeSeq: 4, revision: 2 } }, status: "idle" });
    expect(h.supervisor.view()).not.toHaveProperty("child");
    expect(h.supervisor.childLive()).toBe(true);
    expect(h.observers).toBe(1);
    expect(h.supervisor.coversIdentity({ ...agyIdentity, agentSession: agySession })).toBe(false);

    const exactIdentity: SupervisedIdentity = { ...agyIdentity, agentSession: agySession };
    await h.supervisor.strengthen({ identity: exactIdentity, profileName: "researcher-agy" }, { commit: () => { events.push(`exact-commit:${h.supervisor.view().state}`); }, rollback: vi.fn(), publish: () => { events.push(`exact-publish:${h.supervisor.view().state}`); } });
    expect(events).toEqual(["provisional-commit:reserved", "provisional-publish:provisional", "exact-commit:provisional", "exact-publish:active"]);
    expect(h.supervisor.view()).toMatchObject({ state: "active", child: { paneId: "p1", terminalId: "t1", agentKind: "agy", profileName: "researcher-agy" }, status: "working" });
    expect(h.supervisor.coversIdentity(exactIdentity)).toBe(true);
    expect(h.observers).toBe(1);
    h.supervisor.shutdown();
  });

  it("retains ordered lifecycle events before the fresh AGY strengthening read", async () => {
    const exact = snapshot(
      [agyPaneRecord({ agent_session: agySession, agent_status: "idle", revision: 6, state_change_seq: 8 })],
      [agyAgentRecord({ agent_session: agySession, agent_status: "idle", revision: 6, state_change_seq: 8 })],
    );
    const h = harness({ child: { agentName: "worker", agentKind: "agy", profileName: "researcher-agy" }, snapshots: [snapshot([agyPaneRecord()], [agyAgentRecord()]), exact] });
    await h.supervisor.bindProvisional(provisionalBinding);
    await h.supervisor.onEvent(paneEvent("pane_updated", agyPaneRecord({ agent_session: agySession, agent_status: "working", revision: 3, state_change_seq: 5 })));
    await h.supervisor.onEvent(paneEvent("pane_updated", agyPaneRecord({ agent_session: agySession, agent_status: "blocked", revision: 4, state_change_seq: 6 })));
    await h.supervisor.onEvent(paneEvent("pane_updated", agyPaneRecord({ agent_session: agySession, agent_status: "working", revision: 5, state_change_seq: 7 })));
    expect(h.supervisor.view()).toMatchObject({ state: "provisional", status: "idle", transitions: [], events: [] });
    expect(h.wakes).toEqual([]);

    let published: ReturnType<Supervisor["view"]> | undefined;
    await h.supervisor.strengthen({ identity: exactAgyIdentity, profileName: "researcher-agy" }, {
      commit: vi.fn(),
      rollback: vi.fn(),
      publish: () => { published = h.supervisor.view(); },
    });

    const transitions = [
      { atMs: 1_000, from: "idle", to: "working", revision: 3, source: "event" },
      { atMs: 1_000, from: "working", to: "blocked", revision: 4, source: "event" },
      { atMs: 1_000, from: "blocked", to: "working", revision: 5, source: "event" },
      { atMs: 1_000, from: "working", to: "idle", revision: 6, source: "snapshot" },
    ];
    expect(published).toMatchObject({ state: "active", status: "idle", transitions });
    expect(h.supervisor.view().transitions).toEqual(transitions);
    expect(types(h.wakes)).toEqual(["blocked", "work_cycle_completed"]);
    h.supervisor.shutdown();
  });

  it.each([
    [agyExactSnapshot({ revision: 3, state_change_seq: 6, agent_status: "blocked" }), "revision_regressed"],
    [agyExactSnapshot({ revision: 5, state_change_seq: 5, agent_status: "blocked" }), "lifecycle_regressed"],
    [agyExactSnapshot({ revision: 4, state_change_seq: 6, agent_status: "idle" }), "lifecycle_contradiction"],
  ] as const)("rejects a strengthening snapshot behind retained event evidence (%s)", async (exact, cause) => {
    const h = harness({ child: { agentName: "worker", agentKind: "agy", profileName: "researcher-agy" }, snapshots: [snapshot([agyPaneRecord()], [agyAgentRecord()]), exact] });
    await h.supervisor.bindProvisional(provisionalBinding);
    await h.supervisor.onEvent(paneEvent("pane_updated", agyPaneRecord({ agent_session: agySession, agent_status: "blocked", revision: 4, state_change_seq: 6 })));
    const publication = { commit: vi.fn(), rollback: vi.fn(), publish: vi.fn() };
    await expect(h.supervisor.strengthen({ identity: exactAgyIdentity, profileName: "researcher-agy" }, publication))
      .rejects.toMatchObject({ details: { cause } });
    expect(publication.commit).not.toHaveBeenCalled();
    h.supervisor.shutdown();
  });

  it("drains events admitted during the fresh AGY strengthening read before commit", async () => {
    let resolveFresh!: (value: HerdrSnapshot) => void;
    const fresh = new Promise<HerdrSnapshot>((resolve) => { resolveFresh = resolve; });
    const baseline = snapshot([agyPaneRecord()], [agyAgentRecord()]);
    const exact = snapshot(
      [agyPaneRecord({ agent_session: agySession, agent_status: "working", revision: 3, state_change_seq: 5 })],
      [agyAgentRecord({ agent_session: agySession, agent_status: "working", revision: 3, state_change_seq: 5 })],
    );
    const h = harness({ child: { agentName: "worker", agentKind: "agy", profileName: "researcher-agy" }, snapshots: [baseline, fresh] });
    await h.supervisor.bindProvisional({ identity: agyIdentity, profileName: "researcher-agy", baseline: { state: "idle", stateChangeSeq: 4, revision: 2 } });
    const commit = vi.fn();
    let published: ReturnType<Supervisor["view"]> | undefined;
    const strengthening = h.supervisor.strengthen({ identity: { ...agyIdentity, agentSession: agySession }, profileName: "researcher-agy" }, { commit, rollback: vi.fn(), publish: () => { published = h.supervisor.view(); } });
    await Promise.resolve();
    const admitted = h.supervisor.onEvent(paneEvent("pane_updated", agyPaneRecord({ agent_session: agySession, agent_status: "blocked", revision: 4, state_change_seq: 6 })));
    resolveFresh(exact);
    await Promise.all([strengthening, admitted]);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(published).toMatchObject({ state: "active", status: "blocked", transitions: [{ from: "working", to: "blocked", revision: 4 }] });
    expect(h.supervisor.view()).toMatchObject({ state: "active", status: "blocked", child: { paneId: "p1" } });
    expect(h.supervisor.view().transitions).toEqual([{ atMs: 1_000, from: "working", to: "blocked", revision: 4, source: "event" }]);
    h.supervisor.shutdown();
  });

  it("rejects a move admitted after the strengthening drain empties but before exact commit", async () => {
    const baseline = snapshot([agyPaneRecord()], [agyAgentRecord()]);
    const exact = snapshot(
      [agyPaneRecord({ agent_session: agySession, agent_status: "working", revision: 3, state_change_seq: 5 })],
      [agyAgentRecord({ agent_session: agySession, agent_status: "working", revision: 3, state_change_seq: 5 })],
    );
    const h = harness({ child: { agentName: "worker", agentKind: "agy", profileName: "researcher-agy" }, snapshots: [baseline, exact] });
    await h.supervisor.bindProvisional({ identity: agyIdentity, profileName: "researcher-agy", baseline: { state: "idle", stateChangeSeq: 4, revision: 2 } });
    const internals = h.supervisor as unknown as { drainAdmitted(): Promise<void> };
    const drainAdmitted = internals.drainAdmitted.bind(h.supervisor);
    let injectMove = true;
    internals.drainAdmitted = async () => {
      await drainAdmitted();
      if (!injectMove) return;
      injectMove = false;
      void h.supervisor.onEvent(paneEvent("pane_moved", agyPaneRecord({ pane_id: "p2", agent_session: agySession, agent_status: "working", revision: 3, state_change_seq: 5 }), { previous_pane_id: "p1" }));
    };
    const publication = { commit: vi.fn(), rollback: vi.fn(), publish: vi.fn() };
    const failure = await h.supervisor.strengthen({ identity: { ...agyIdentity, agentSession: agySession }, profileName: "researcher-agy" }, publication)
      .catch((error: SupervisionBindError) => error);
    expect(failure).toBeInstanceOf(SupervisionBindError);
    expect((failure as SupervisionBindError).details).toMatchObject({ cause: "move_before_strengthening" });
    expect(publication.commit).not.toHaveBeenCalled();
    h.supervisor.shutdown();
  });

  it("pins the first native session seen before strengthening", async () => {
    const otherSession = { ...agySession, value: "agy-2" };
    const baseline = snapshot([agyPaneRecord()], [agyAgentRecord()]);
    const exact = snapshot(
      [agyPaneRecord({ agent_session: otherSession, agent_status: "working", revision: 4, state_change_seq: 6 })],
      [agyAgentRecord({ agent_session: otherSession, agent_status: "working", revision: 4, state_change_seq: 6 })],
    );
    const h = harness({ child: { agentName: "worker", agentKind: "agy", profileName: "researcher-agy" }, snapshots: [baseline, exact] });
    await h.supervisor.bindProvisional({ identity: agyIdentity, profileName: "researcher-agy", baseline: { state: "idle", stateChangeSeq: 4, revision: 2 } });
    await h.supervisor.onEvent(paneEvent("pane_updated", agyPaneRecord({ agent_session: agySession, agent_status: "working", revision: 3, state_change_seq: 5 })));
    const failure = await h.supervisor.strengthen({ identity: { ...agyIdentity, agentSession: otherSession }, profileName: "researcher-agy" })
      .catch((error: SupervisionBindError) => error);
    expect(failure).toBeInstanceOf(SupervisionBindError);
    expect((failure as SupervisionBindError).details).toMatchObject({ cause: "native_identity_mismatch" });
    h.supervisor.shutdown();
  });

  it("binds without a state_change_seq rather than defaulting one", async () => {
    const h = harness({ snapshots: [snapshot([paneRecord()])] });
    await expect(h.supervisor.bind({ identity, profileName: "worker-pi" })).resolves.toBeUndefined();
    expect(h.timerArmed()).toBe(false);

    const regressed = harness({ snapshots: [snapshot([paneRecord({ stateChangeSeq: 3 })])] });
    await expect(regressed.supervisor.bind({ identity, profileName: "worker-pi", stateChangeSeq: 4 }))
      .rejects.toMatchObject({ details: { cause: "lifecycle_regressed" } });

    const stopped = harness();
    stopped.supervisor.shutdown();
    await expect(stopped.supervisor.bind({ identity, profileName: "worker-pi" })).rejects.toMatchObject({ details: { cause: "bind_already_attempted" } });
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

describe("AGY provisional supervision failures", () => {
  const agyChild = { agentName: "worker", agentKind: "agy", profileName: "researcher-agy" };
  const agyHarness = (snapshots: Array<HerdrSnapshot | Error | Promise<HerdrSnapshot>> = []): Harness => harness({ child: agyChild, snapshots });

  it("validates every provisional binding field and remains single-use", async () => {
    const wrongIdentity = { ...provisionalBinding, identity: { ...agyIdentity, agentKind: "pi" } } as unknown as ProvisionalSupervisionBinding;
    await expect(agyHarness().supervisor.bindProvisional(wrongIdentity)).rejects.toMatchObject({ details: { cause: "provisional_kind_invalid" } });

    const malformed: ProvisionalSupervisionBinding[] = [
      ...([1, "", "bad\n"] as unknown[]).map((paneId) => ({ ...provisionalBinding, identity: { ...agyIdentity, paneId } } as ProvisionalSupervisionBinding)),
      ...([1, "", "bad\r"] as unknown[]).map((terminalId) => ({ ...provisionalBinding, identity: { ...agyIdentity, terminalId } } as ProvisionalSupervisionBinding)),
      ...([1, "", "bad\0"] as unknown[]).map((agentName) => ({ ...provisionalBinding, identity: { ...agyIdentity, agentName } } as ProvisionalSupervisionBinding)),
      ...([1, "", "bad\n"] as unknown[]).map((profileName) => ({ ...provisionalBinding, profileName } as ProvisionalSupervisionBinding)),
      { ...provisionalBinding, baseline: { ...provisionalBinding.baseline, state: "working" } } as unknown as ProvisionalSupervisionBinding,
      ...([-1, 1.5, Number.MAX_SAFE_INTEGER + 1] as number[]).map((stateChangeSeq) => ({ ...provisionalBinding, baseline: { ...provisionalBinding.baseline, stateChangeSeq } })),
      ...([-1, 1.5, Number.MAX_SAFE_INTEGER + 1] as number[]).map((revision) => ({ ...provisionalBinding, baseline: { ...provisionalBinding.baseline, revision } })),
    ];
    const throwingIdentity = new Proxy({ ...agyIdentity }, {
      get: (target, property, receiver) => {
        if (property === "paneId") throw new Error("bad getter");
        return Reflect.get(target, property, receiver);
      },
    });
    for (const binding of malformed) {
      await expect(agyHarness().supervisor.bindProvisional(binding)).rejects.toMatchObject({ details: { cause: "provisional_baseline_invalid" } });
    }
    await expect(agyHarness().supervisor.bindProvisional({ ...provisionalBinding, identity: throwingIdentity })).rejects.toThrow("bad getter");

    const bound = agyHarness([snapshot([agyPaneRecord()], [agyAgentRecord()])]);
    await bindAgy(bound);
    await expect(bound.supervisor.bindProvisional(provisionalBinding)).rejects.toMatchObject({ details: { cause: "bind_already_attempted" } });
    bound.supervisor.shutdown();
  });

  it("rejects every provisional bind-time evidence failure", async () => {
    const cases: Array<[HerdrSnapshot | Error, string]> = [
      [Object.assign(new Error("closed"), { code: "SUPERVISION_SOCKET_CLOSED" }), "SUPERVISION_SOCKET_CLOSED"],
      [snapshot([], []), "occupant_absent"],
      [snapshot([agyPaneRecord(), agyPaneRecord()], []), "duplicate_target_pane"],
      [snapshot([agyPaneRecord()], []), "agent_absent"],
      [snapshot([agyPaneRecord({ terminal_id: "t2" })], [agyAgentRecord({ terminal_id: "t2" })]), "identity_mismatch"],
      [snapshot([agyPaneRecord({ agent_status: "working" })], [agyAgentRecord({ agent_status: "working" })]), "baseline_changed"],
      [snapshot([agyPaneRecord({ state_change_seq: 5 })], [agyAgentRecord({ state_change_seq: 5 })]), "baseline_changed"],
      [snapshot([agyPaneRecord({ revision: 3 })], [agyAgentRecord({ revision: 3 })]), "baseline_changed"],
      [snapshot([agyPaneRecord({ state_change_seq: undefined })], [agyAgentRecord({ state_change_seq: undefined })]), "baseline_changed"],
    ];
    for (const [evidence, cause] of cases) {
      const h = agyHarness([evidence]);
      const error = await h.supervisor.bindProvisional(provisionalBinding).catch((failure: SupervisionBindError) => failure);
      expect(error).toBeInstanceOf(SupervisionBindError);
      expect((error as SupervisionBindError).details).toMatchObject({ cause });
      expect(h.observers).toBe(0);
    }
  });

  it("rolls back provisional publication and drain failures", async () => {
    const publishFailure = agyHarness([snapshot([agyPaneRecord()], [agyAgentRecord()])]);
    const failedPublication = { commit: vi.fn(() => { throw Object.assign(new Error("failed"), { code: "PUBLISH_FAILED" }); }), rollback: vi.fn(), publish: vi.fn() };
    await expect(publishFailure.supervisor.bindProvisional(provisionalBinding, failedPublication)).rejects.toMatchObject({ details: { cause: "PUBLISH_FAILED" } });
    expect(failedPublication.rollback).toHaveBeenCalledTimes(1);
    expect(publishFailure.supervisor.view().state).toBe("reserved");

    let resolveDrain!: (value: HerdrSnapshot) => void;
    const drainSnapshot = new Promise<HerdrSnapshot>((resolve) => { resolveDrain = resolve; });
    const drainFailure = agyHarness([drainSnapshot]);
    const publication = { commit: vi.fn(), rollback: vi.fn(), publish: vi.fn() };
    const binding = drainFailure.supervisor.bindProvisional(provisionalBinding, publication);
    await drainFailure.supervisor.onEvent(paneEvent("pane_moved", agyPaneRecord({ pane_id: "p2" }), { previous_pane_id: "p1" }));
    resolveDrain(snapshot([agyPaneRecord()], [agyAgentRecord()]));
    await expect(binding).rejects.toMatchObject({ details: { cause: "move_before_strengthening" } });
    expect(publication.rollback).toHaveBeenCalledTimes(1);

    const settled = agyHarness([snapshot([agyPaneRecord()], [agyAgentRecord()])]);
    const settledInternals = settled.supervisor as unknown as { drainAdmitted(): Promise<void>; state: string };
    const drainAdmitted = settledInternals.drainAdmitted.bind(settled.supervisor);
    settledInternals.drainAdmitted = async () => {
      await drainAdmitted();
      settledInternals.state = "settled";
    };
    const settledPublication = { commit: vi.fn(), rollback: vi.fn(), publish: vi.fn() };
    const settledBinding = settled.supervisor.bindProvisional(provisionalBinding, settledPublication);
    await expect(settledBinding).rejects.toMatchObject({ details: { cause: "settled_during_bind", settledDuringBind: true } });
    expect(settledPublication.rollback).toHaveBeenCalledTimes(1);
    settled.supervisor.shutdown();

    const settledWithDetails = agyHarness([snapshot([agyPaneRecord()], [agyAgentRecord()])]);
    const detailedInternals = settledWithDetails.supervisor as unknown as { drainAdmitted(): Promise<void>; state: string; settlement?: { outcome: string; reason: string } };
    const detailedDrain = detailedInternals.drainAdmitted.bind(settledWithDetails.supervisor);
    detailedInternals.drainAdmitted = async () => {
      await detailedDrain();
      detailedInternals.state = "settled";
      detailedInternals.settlement = { outcome: "cancelled", reason: "test_settlement" };
    };
    await expect(settledWithDetails.supervisor.bindProvisional(provisionalBinding)).rejects.toMatchObject({
      details: { cause: "settled_during_bind", supervisionOutcome: "cancelled", supervisionReason: "test_settlement" },
    });
    settledWithDetails.supervisor.shutdown();
  });

  it("rejects provisional event evidence before strengthening", async () => {
    const events: Array<[SupervisionSocketEvent, string]> = [
      [paneEvent("pane_moved", agyPaneRecord({ pane_id: "p2" }), { previous_pane_id: "p1" }), "move_before_strengthening"],
      [thinEvent("pane_closed"), "event_lifecycle_unvalidated"],
      [paneEvent("pane_updated", agyPaneRecord({ pane_id: "p2" })), "identity_mismatch"],
      [paneEvent("pane_updated", agyPaneRecord({ terminal_id: "t2" })), "identity_mismatch"],
      [paneEvent("pane_updated", agyPaneRecord({ agent: "pi" })), "identity_mismatch"],
      [paneEvent("pane_updated", agyPaneRecord({ agent_session: { ...agySession, agent: "pi" }, revision: 3, state_change_seq: 5 })), "native_identity_mismatch"],
      [paneEvent("pane_updated", agyPaneRecord({ revision: 1, state_change_seq: 5 })), "revision_regressed"],
      [paneEvent("pane_updated", agyPaneRecord({ revision: 3, state_change_seq: undefined })), "lifecycle_not_advanced"],
    ];
    for (const [event, cause] of events) {
      const h = agyHarness([snapshot([agyPaneRecord()], [agyAgentRecord()])]);
      await bindAgy(h);
      await h.supervisor.onEvent(event);
      expect(provisionalCause(h)).toBe(cause);
      h.supervisor.shutdown();
    }

    const pinned = agyHarness([snapshot([agyPaneRecord()], [agyAgentRecord()])]);
    await bindAgy(pinned);
    await pinned.supervisor.onEvent(paneEvent("pane_updated", agyPaneRecord({ agent_session: agySession, revision: 3, state_change_seq: 5 })));
    await pinned.supervisor.onEvent(paneEvent("pane_updated", agyPaneRecord({ agent_session: null, revision: 4, state_change_seq: 6 })));
    expect(provisionalCause(pinned)).toBe("native_identity_mismatch");
    pinned.supervisor.shutdown();

    const stale = agyHarness([snapshot([agyPaneRecord()], [agyAgentRecord()])]);
    await bindAgy(stale);
    await stale.supervisor.onEvent(paneEvent("pane_updated", agyPaneRecord({ revision: 2, state_change_seq: 4 })));
    await stale.supervisor.onEvent(paneEvent("pane_updated", agyPaneRecord({ revision: 2, state_change_seq: undefined })));
    expect(stale.supervisor.view().events).toEqual([]);
    stale.supervisor.shutdown();

    const regressed = agyHarness([snapshot([agyPaneRecord()], [agyAgentRecord()])]);
    await bindAgy(regressed);
    await regressed.supervisor.onEvent(paneEvent("pane_updated", agyPaneRecord({ revision: 3, state_change_seq: 5 })));
    await regressed.supervisor.onEvent(paneEvent("pane_updated", agyPaneRecord({ revision: 3, state_change_seq: 4 })));
    expect(provisionalCause(regressed)).toBe("lifecycle_regressed");
    regressed.supervisor.shutdown();

    const contradictory = agyHarness([snapshot([agyPaneRecord()], [agyAgentRecord()])]);
    await bindAgy(contradictory);
    await contradictory.supervisor.onEvent(paneEvent("pane_updated", agyPaneRecord({ agent_status: "working", revision: 3, state_change_seq: 5 })));
    await contradictory.supervisor.onEvent(paneEvent("pane_updated", agyPaneRecord({ agent_status: "blocked", revision: 3, state_change_seq: 5 })));
    expect(provisionalCause(contradictory)).toBe("lifecycle_contradiction");
    contradictory.supervisor.shutdown();

    const stableNative = agyHarness([snapshot([agyPaneRecord()], [agyAgentRecord()])]);
    await bindAgy(stableNative);
    await stableNative.supervisor.onEvent(paneEvent("pane_updated", agyPaneRecord({ agent_session: agySession, revision: 3, state_change_seq: 5 })));
    await stableNative.supervisor.onEvent(paneEvent("pane_updated", agyPaneRecord({ agent_session: agySession, revision: 4, state_change_seq: 6 })));
    expect(stableNative.supervisor.view().events).toEqual([]);
    stableNative.supervisor.shutdown();

    const missingKind = agyHarness([snapshot([agyPaneRecord()], [agyAgentRecord()])]);
    await bindAgy(missingKind);
    await missingKind.supervisor.onEvent(paneEvent("pane_updated", agyPaneRecord({ agent: null })));
    expect(missingKind.supervisor.view().state).toBe("provisional");
    expect(missingKind.supervisor.view().events).toEqual([]);
    missingKind.supervisor.shutdown();
  });

  it("validates every provisional reconciliation outcome", async () => {
    const cases: Array<[HerdrSnapshot, string]> = [
      [snapshot([], []), "periodic_snapshot:occupant_absent"],
      [snapshot([agyPaneRecord(), agyPaneRecord()], []), "periodic_snapshot:duplicate_target_pane"],
      [snapshot([agyPaneRecord()], []), "periodic_snapshot:agent_absent"],
      [snapshot([agyPaneRecord({ terminal_id: "t2" })], [agyAgentRecord({ terminal_id: "t2" })]), "periodic_snapshot:identity_mismatch"],
      [snapshot([agyPaneRecord({ state_change_seq: undefined })], [agyAgentRecord({ state_change_seq: undefined })]), "periodic_snapshot:lifecycle_unavailable"],
      [snapshot([agyPaneRecord({ revision: 1 })], [agyAgentRecord({ revision: 1 })]), "periodic_snapshot:revision_regressed"],
    ];
    for (const [evidence, cause] of cases) {
      const h = agyHarness([snapshot([agyPaneRecord()], [agyAgentRecord()])]);
      await bindAgy(h);
      await h.supervisor.onReconciliationSnapshot(evidence);
      expect(provisionalCause(h)).toBe(cause);
      h.supervisor.shutdown();
    }

    const pinned = agyHarness([snapshot([agyPaneRecord()], [agyAgentRecord()])]);
    await bindAgy(pinned);
    await pinned.supervisor.onBootstrap(agyExactSnapshot(), 2, true);
    await pinned.supervisor.onBootstrap(agyExactSnapshot({ agent_session: { ...agySession, value: "agy-2" }, revision: 4, state_change_seq: 6 }), 3, true);
    expect(provisionalCause(pinned)).toBe("reconnect:native_identity_mismatch");
    pinned.supervisor.shutdown();

    const settled = agyHarness([snapshot([agyPaneRecord()], [agyAgentRecord()])]);
    await bindAgy(settled);
    (settled.supervisor as unknown as { state: string }).state = "settled";
    await settled.supervisor.onBootstrap(snapshot([], []), 2, true);
    await settled.supervisor.onReconciliationSnapshot(snapshot([], []));
    settled.supervisor.shutdown();
  });

  it("uses error codes when provisional draining itself fails", async () => {
    const h = agyHarness([snapshot([agyPaneRecord()], [agyAgentRecord()])]);
    (h.supervisor as unknown as { drainAdmitted(): Promise<void> }).drainAdmitted = async () => {
      throw Object.assign(new Error("drain failed"), { code: "DRAIN_FAILED" });
    };
    await expect(h.supervisor.bindProvisional(provisionalBinding)).rejects.toMatchObject({ details: { cause: "DRAIN_FAILED" } });
    expect(h.observers).toBe(0);
  });

  it.each(["pi", "claude"] as const)("allows a %s reservation to bind and strengthen an AGY fallback", async (agentKind) => {
    const h = harness({
      child: { agentName: "worker", agentKind, profileName: `researcher-${agentKind}` },
      snapshots: [snapshot([agyPaneRecord()], [agyAgentRecord()]), agyExactSnapshot()],
    });
    await h.supervisor.bindProvisional({ ...provisionalBinding, profileName: "fallback-agy" });
    expect(h.supervisor.view()).toMatchObject({ state: "provisional", provisional: { agentKind: "agy", profileName: "fallback-agy", requestedProfileName: `researcher-${agentKind}` } });
    await h.supervisor.strengthen({ identity: exactAgyIdentity, profileName: "fallback-agy" });
    expect(h.supervisor.view()).toMatchObject({ state: "active", child: { agentKind: "agy", profileName: "fallback-agy", requestedAgentKind: agentKind, requestedProfileName: `researcher-${agentKind}` } });
    h.supervisor.shutdown();
  });

  it("projects the requested profile beside a provisional fallback", async () => {
    const h = agyHarness([snapshot([agyPaneRecord()], [agyAgentRecord()])]);
    await bindAgy(h, { ...provisionalBinding, profileName: "fallback-agy" });
    expect(h.supervisor.view()).toMatchObject({ provisional: { profileName: "fallback-agy", requestedProfileName: "researcher-agy" } });
    h.supervisor.shutdown();
  });
});

describe("AGY supervision strengthening failures", () => {
  const agyChild = { agentName: "worker", agentKind: "agy", profileName: "researcher-agy" };
  const agyHarness = (after: Array<HerdrSnapshot | Error | Promise<HerdrSnapshot>> = []): Harness => harness({
    child: agyChild,
    snapshots: [snapshot([agyPaneRecord()], [agyAgentRecord()]), ...after],
  });

  async function provisional(after: Array<HerdrSnapshot | Error | Promise<HerdrSnapshot>> = []): Promise<Harness> {
    const h = agyHarness(after);
    await bindAgy(h);
    return h;
  }

  it("rejects repeated and mismatched strengthening requests", async () => {
    await expect(agyHarness().supervisor.strengthen({ identity: exactAgyIdentity, profileName: "researcher-agy" }))
      .rejects.toMatchObject({ details: { cause: "strengthen_already_attempted" } });

    for (const binding of [
      { identity: { ...exactAgyIdentity, agentKind: "pi" }, profileName: "researcher-agy" },
      { identity: { ...exactAgyIdentity, paneId: "p2" }, profileName: "researcher-agy" },
    ] as SupervisionBinding[]) {
      const h = await provisional();
      await expect(h.supervisor.strengthen(binding)).rejects.toMatchObject({ details: { cause: "strengthening_identity_invalid" } });
      h.supervisor.shutdown();
    }

    const stopped = await provisional();
    stopped.supervisor.shutdown();
    await expect(stopped.supervisor.strengthen({ identity: exactAgyIdentity, profileName: "researcher-agy" }))
      .rejects.toMatchObject({ details: { cause: "strengthen_already_attempted" } });

    const strengthened = await provisional([agyExactSnapshot()]);
    await strengthened.supervisor.strengthen({ identity: exactAgyIdentity, profileName: "researcher-agy" });
    await expect(strengthened.supervisor.strengthen({ identity: exactAgyIdentity, profileName: "researcher-agy" }))
      .rejects.toMatchObject({ details: { cause: "strengthen_already_attempted" } });
    strengthened.supervisor.shutdown();
  });

  it("rejects every fresh strengthening evidence failure and rolls back", async () => {
    const otherSession = { ...agySession, value: "agy-2" };
    const cases: Array<[HerdrSnapshot | Error, SupervisedIdentity, string]> = [
      [Object.assign(new Error("closed"), { code: "SUPERVISION_SOCKET_CLOSED" }), exactAgyIdentity, "SUPERVISION_SOCKET_CLOSED"],
      [snapshot([], []), exactAgyIdentity, "occupant_absent"],
      [snapshot([agyPaneRecord(), agyPaneRecord()], []), exactAgyIdentity, "duplicate_target_pane"],
      [snapshot([agyPaneRecord()], []), exactAgyIdentity, "agent_absent"],
      [snapshot([agyPaneRecord({ terminal_id: "t2" })], [agyAgentRecord({ terminal_id: "t2" })]), exactAgyIdentity, "identity_mismatch"],
      [snapshot([agyPaneRecord({ state_change_seq: undefined })], [agyAgentRecord({ state_change_seq: undefined })]), exactAgyIdentity, "lifecycle_not_advanced"],
      [snapshot([agyPaneRecord()], [agyAgentRecord()]), exactAgyIdentity, "lifecycle_not_advanced"],
      [agyExactSnapshot({ revision: 1 }), exactAgyIdentity, "revision_regressed"],
      [agyExactSnapshot(), { ...exactAgyIdentity, agentSession: otherSession }, "native_identity_mismatch"],
    ];
    for (const [evidence, requestedIdentity, cause] of cases) {
      const h = await provisional([evidence]);
      const rollback = vi.fn();
      await expect(h.supervisor.strengthen({ identity: requestedIdentity, profileName: "researcher-agy" }, { commit: vi.fn(), rollback, publish: vi.fn() }))
        .rejects.toMatchObject({ details: { cause } });
      expect(rollback).toHaveBeenCalled();
      expect(h.supervisor.view().state).toBe("provisional");
      h.supervisor.shutdown();
    }

    const pinnedBaseline = snapshot(
      [agyPaneRecord({ agent_session: agySession })],
      [agyAgentRecord({ agent_session: agySession })],
    );
    const pinned = harness({ child: agyChild, snapshots: [pinnedBaseline, agyExactSnapshot({ agent_session: otherSession })] });
    await bindAgy(pinned);
    await expect(pinned.supervisor.strengthen({ identity: { ...agyIdentity, agentSession: otherSession }, profileName: "researcher-agy" }))
      .rejects.toMatchObject({ details: { cause: "native_identity_mismatch" } });
    pinned.supervisor.shutdown();
  });

  it("carries prior provisional failure into strengthening and refuses release", async () => {
    const h = await provisional();
    h.supervisor.onReconciliationFailure("request_failed");
    expect(provisionalCause(h)).toBe("reconciliation_request_failed");
    const rollback = vi.fn(() => { throw new Error("rollback unavailable"); });
    await expect(h.supervisor.strengthen({ identity: exactAgyIdentity, profileName: "researcher-agy" }, { commit: vi.fn(), rollback, publish: vi.fn() }))
      .rejects.toMatchObject({ details: { cause: "reconciliation_request_failed" } });
    h.supervisor.release("launch_failed");
    expect(h.supervisor.childLive()).toBe(true);
    expect(h.progress.at(-1)).toContain("release refused");
    h.supervisor.shutdown();
  });

  it("rejects malformed or regressed evidence admitted during strengthening", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ pane_id: "p2", agent_session: agySession, revision: 4, state_change_seq: 6 }, "native_identity_mismatch"],
      [{ agent_session: agySession, revision: 4, state_change_seq: undefined }, "lifecycle_not_advanced"],
      [{ agent_session: agySession, revision: 1, state_change_seq: 6 }, "revision_regressed"],
      [{ agent_session: agySession, revision: 2, state_change_seq: 6 }, "revision_regressed"],
      [{ agent_session: agySession, revision: 4, state_change_seq: 4 }, "lifecycle_regressed"],
      [{ agent_session: agySession, agent_status: "blocked", revision: 3, state_change_seq: 5 }, "lifecycle_contradiction"],
    ];
    for (const [overrides, cause] of cases) {
      let resolveFresh!: (value: HerdrSnapshot) => void;
      const fresh = new Promise<HerdrSnapshot>((resolve) => { resolveFresh = resolve; });
      const h = await provisional([fresh]);
      const strengthening = h.supervisor.strengthen({ identity: exactAgyIdentity, profileName: "researcher-agy" });
      await Promise.resolve();
      const admitted = h.supervisor.onEvent(paneEvent("pane_updated", agyPaneRecord(overrides)));
      resolveFresh(agyExactSnapshot());
      await expect(strengthening).rejects.toMatchObject({ details: { cause } });
      await admitted;
      h.supervisor.shutdown();
    }
  });

  it("accepts an advancing candidate event whose status is unchanged", async () => {
    let resolveFresh!: (value: HerdrSnapshot) => void;
    const fresh = new Promise<HerdrSnapshot>((resolve) => { resolveFresh = resolve; });
    const h = await provisional([fresh]);
    const strengthening = h.supervisor.strengthen({ identity: exactAgyIdentity, profileName: "researcher-agy" });
    await Promise.resolve();
    const admitted = h.supervisor.onEvent(paneEvent("pane_updated", agyPaneRecord({ agent_session: agySession, agent_status: "working", revision: 4, state_change_seq: 6 })));
    resolveFresh(agyExactSnapshot());
    await Promise.all([strengthening, admitted]);
    expect(h.supervisor.view()).toMatchObject({ state: "active", status: "working", transitions: [] });
    h.supervisor.shutdown();
  });

  it("replays strengthened transitions without false same-revision gaps", async () => {
    let resolveFresh!: (value: HerdrSnapshot) => void;
    const fresh = new Promise<HerdrSnapshot>((resolve) => { resolveFresh = resolve; });
    const h = await provisional([fresh]);
    const strengthening = h.supervisor.strengthen({ identity: exactAgyIdentity, profileName: "fallback-agy" });
    await Promise.resolve();
    const sameRevision = h.supervisor.onEvent(paneEvent("pane_updated", agyPaneRecord({ agent_session: agySession, agent_status: "blocked", revision: 3, state_change_seq: 6 })));
    const jumped = h.supervisor.onEvent(paneEvent("pane_updated", agyPaneRecord({ agent_session: agySession, agent_status: "idle", revision: 6, state_change_seq: 7 })));
    const working = h.supervisor.onEvent(paneEvent("pane_updated", agyPaneRecord({ agent_session: agySession, agent_status: "working", revision: 7, state_change_seq: 8 })));
    resolveFresh(agyExactSnapshot());
    await Promise.all([strengthening, sameRevision, jumped, working]);
    expect(types(h.wakes)).toEqual(["blocked", "evidence_gap"]);
    expect(h.supervisor.view()).toMatchObject({
      state: "active",
      status: "working",
      child: { profileName: "fallback-agy", requestedProfileName: "researcher-agy" },
      reviewer: { degraded: false },
    });
    h.supervisor.shutdown();
  });

  it("keeps exact supervision active when its first cadence cannot be armed", async () => {
    const h = await provisional([agyExactSnapshot()]);
    (h.supervisor as unknown as { scheduler: SupervisionScheduler }).scheduler.setTimer = () => { throw new Error("timer failed"); };
    await h.supervisor.strengthen({ identity: exactAgyIdentity, profileName: "researcher-agy" });
    expect(h.supervisor.view()).toMatchObject({ state: "active", status: "working", reviewer: { degraded: true } });
    expect(h.progress).toContain("supervision reviewer cadence could not be armed");
    h.supervisor.shutdown();
  });

  it("restores provisional state when exact publication fails", async () => {
    for (const fail of ["commit", "publish"] as const) {
      const h = await provisional([agyExactSnapshot()]);
      const publication = {
        commit: vi.fn(() => { if (fail === "commit") throw new Error("failed"); }),
        rollback: vi.fn(() => { throw new Error("rollback failed"); }),
        publish: vi.fn(() => { if (fail === "publish") throw new Error("failed"); }),
      };
      await expect(h.supervisor.strengthen({ identity: exactAgyIdentity, profileName: "researcher-agy" }, publication))
        .rejects.toMatchObject({ details: { cause: "publication_failed" } });
      expect(h.supervisor.view()).toMatchObject({ state: "provisional", status: "idle" });
      expect(h.supervisor.childLive()).toBe(true);
      h.supervisor.shutdown();
    }
  });

  it("fails closed when a strengthening candidate disappears or settles", async () => {
    for (const [mutation, cause] of [
      [(internals: { strengtheningCandidate?: unknown }) => { internals.strengtheningCandidate = undefined; }, "strengthening_candidate_missing"],
      [(internals: { state?: string }) => { internals.state = "settled"; }, "settled_during_strengthen"],
    ] as const) {
      const h = await provisional([agyExactSnapshot()]);
      const internals = h.supervisor as unknown as { drainAdmitted(): Promise<void>; strengtheningCandidate?: unknown; state?: string };
      const drain = internals.drainAdmitted.bind(h.supervisor);
      internals.drainAdmitted = async () => { await drain(); mutation(internals); };
      await expect(h.supervisor.strengthen({ identity: exactAgyIdentity, profileName: "researcher-agy" }))
        .rejects.toMatchObject({ details: { cause } });
      h.supervisor.shutdown();
    }
  });

  it("covers the serialized strengthening commit guards", async () => {
    const queued = await provisional([agyExactSnapshot()]);
    let lengthReads = 0;
    const queuedInternals = queued.supervisor as unknown as { drainAdmitted(): Promise<void>; queued: { readonly length: number } };
    queuedInternals.drainAdmitted = async () => undefined;
    queuedInternals.queued = { get length() { return ++lengthReads === 1 ? 0 : 1; } };
    await expect(queued.supervisor.strengthen({ identity: exactAgyIdentity, profileName: "researcher-agy" }))
      .rejects.toMatchObject({ details: { cause: "publication_failed" } });
    queued.supervisor.shutdown();

    const drain = await provisional([agyExactSnapshot()]);
    const drainInternals = drain.supervisor as unknown as { drainAdmitted(): Promise<void> };
    drainInternals.drainAdmitted = async () => { throw Object.assign(new Error("drain failed"), { code: "DRAIN_FAILED" }); };
    await expect(drain.supervisor.strengthen({ identity: exactAgyIdentity, profileName: "researcher-agy" }))
      .rejects.toMatchObject({ details: { cause: "DRAIN_FAILED" } });
    drain.supervisor.shutdown();
  });

  it("covers provisional observer and view fail-closed guards", async () => {
    const h = await provisional();
    h.supervisor.onMonitorDegraded("down");
    h.supervisor.onMonitorRecovered();
    expect(types(h.wakes)).toEqual(["monitor_degraded", "monitor_recovered"]);

    const internals = h.supervisor as unknown as {
      applyProvisionalSnapshot(snapshot: HerdrSnapshot, trigger: string): void;
      foldProvisional(event: SupervisionSocketEvent): void;
      fold(event: SupervisionSocketEvent): Promise<void>;
      provisional?: ProvisionalSupervisionBinding;
      provisionalFailure?: string;
      state: string;
    };
    internals.provisionalFailure = "already_failed";
    internals.applyProvisionalSnapshot(snapshot([], []), "test");
    internals.foldProvisional(thinEvent("pane_closed"));
    internals.provisionalFailure = undefined;
    const valid = paneEvent("pane_updated", agyPaneRecord());
    internals.foldProvisional({ ...valid, data: { ...valid.data, pane: null } } as never);
    expect(provisionalCause(h)).toBe("lifecycle_malformed");
    internals.provisionalFailure = undefined;
    internals.provisional = undefined;
    internals.applyProvisionalSnapshot(snapshot([], []), "test");
    internals.foldProvisional(thinEvent("pane_closed"));
    internals.state = "settled";
    await internals.fold(thinEvent("pane_closed"));
    expect(h.supervisor.view().state).toBe("settled");
    h.supervisor.shutdown();
  });

  it("rejects a native session disappearing from a provisional snapshot", async () => {
    const h = await provisional();
    await h.supervisor.onBootstrap(agyExactSnapshot(), 2, true);
    await h.supervisor.onBootstrap(snapshot(
      [agyPaneRecord({ agent_session: null, revision: 4, state_change_seq: 6 })],
      [agyAgentRecord({ agent_session: null, revision: 4, state_change_seq: 6 })],
    ), 3, true);
    expect(provisionalCause(h)).toBe("reconnect:native_identity_mismatch");
    h.supervisor.shutdown();
  });

  it("keeps a provisional view fail-closed if its private binding disappears", async () => {
    const h = await provisional();
    (h.supervisor as unknown as { provisional?: ProvisionalSupervisionBinding }).provisional = undefined;
    expect(h.supervisor.view().state).toBe("reserved");
    h.supervisor.shutdown();
  });
});

describe("supervisor folding", () => {
  async function bound(options: HarnessOptions = {}): Promise<Harness> {
    const h = harness({ ...options, snapshots: [snapshot([paneRecord({ status: "working", revision: 5 })]), ...(options.snapshots ?? [])] });
    await h.supervisor.bind({ identity, profileName: "worker-pi" });
    return h;
  }

  async function exactAgyBound(after: HerdrSnapshot[] = []): Promise<Harness> {
    const child = { agentName: "worker", agentKind: "agy", profileName: "researcher-agy" };
    const h = harness({ child, snapshots: [snapshot([agyPaneRecord()], [agyAgentRecord()]), agyExactSnapshot(), ...after] });
    await h.supervisor.bindProvisional(provisionalBinding);
    await h.supervisor.strengthen({ identity: exactAgyIdentity, profileName: "researcher-agy" });
    h.wakes.length = 0;
    return h;
  }

  it("accepts AGY same-revision event transitions with an advancing lifecycle sequence", async () => {
    const h = await exactAgyBound();
    await h.supervisor.onEvent(paneEvent("pane_updated", agyPaneRecord({ agent_session: agySession, agent_status: "idle", revision: 3, state_change_seq: 6 })));
    await h.supervisor.onEvent(paneEvent("pane_updated", agyPaneRecord({ agent_session: agySession, agent_status: "done", revision: 3, state_change_seq: 7 })));
    expect(types(h.wakes)).toEqual(["work_cycle_completed", "work_cycle_completed"]);
    expect(h.supervisor.view()).toMatchObject({ status: "done", monitor: { evidenceGaps: 0 } });
    h.supervisor.shutdown();
  });

  it("accepts AGY same-revision snapshot transitions with an advancing lifecycle sequence", async () => {
    const h = await exactAgyBound();
    await h.supervisor.onReconciliationSnapshot(agyExactSnapshot({ agent_status: "blocked", state_change_seq: 6 }));
    await h.supervisor.onReconciliationSnapshot(agyExactSnapshot({ agent_status: "idle", state_change_seq: 7 }));
    expect(types(h.wakes)).toEqual(["blocked"]);
    expect(h.supervisor.view()).toMatchObject({ status: "idle", monitor: { evidenceGaps: 0, reconciliation: { degraded: false } } });
    h.supervisor.shutdown();
  });

  it("keeps AGY missing, unchanged, and regressed lifecycle evidence visible", async () => {
    const missing = await exactAgyBound();
    await missing.supervisor.onEvent(paneEvent("pane_updated", agyPaneRecord({ agent_session: agySession, agent_status: "blocked", revision: 3, state_change_seq: undefined })));
    expect(types(missing.wakes)).toEqual(["evidence_gap", "blocked"]);
    expect(missing.supervisor.view().monitor.evidenceGaps).toBe(1);
    missing.supervisor.shutdown();

    const unchanged = await exactAgyBound();
    await unchanged.supervisor.onEvent(paneEvent("pane_updated", agyPaneRecord({ agent_session: agySession, agent_status: "blocked", revision: 3, state_change_seq: 5 })));
    expect(types(unchanged.wakes)).toEqual(["evidence_gap", "blocked"]);
    unchanged.supervisor.shutdown();

    const regressed = await exactAgyBound();
    await regressed.supervisor.onEvent(paneEvent("pane_updated", agyPaneRecord({ agent_session: agySession, agent_status: "blocked", revision: 3, state_change_seq: 6 })));
    await regressed.supervisor.onEvent(paneEvent("pane_updated", agyPaneRecord({ agent_session: agySession, agent_status: "idle", revision: 3, state_change_seq: 5 })));
    expect(types(regressed.wakes)).toEqual(["blocked", "evidence_gap"]);
    expect(regressed.supervisor.view()).toMatchObject({ status: "blocked", monitor: { evidenceGaps: 1 } });
    regressed.supervisor.shutdown();

    const snapshotRegression = await exactAgyBound();
    await snapshotRegression.supervisor.onReconciliationSnapshot(agyExactSnapshot({ revision: 4, state_change_seq: 4, agent_status: "blocked" }));
    expect(types(snapshotRegression.wakes)).toEqual(["reconciliation_degraded"]);
    expect(snapshotRegression.supervisor.view()).toMatchObject({ state: "degraded", status: "working", monitor: { reconciliation: { lastFailureReason: "revision_regressed" } } });
    snapshotRegression.supervisor.shutdown();

    const moved = agyPaneRecord({ pane_id: "p2", agent_session: agySession, agent_status: "working", revision: 1, state_change_seq: 4 });
    const move = await exactAgyBound([snapshot([moved], [agyAgentRecord({ pane_id: "p2", agent_session: agySession, agent_status: "working", revision: 1, state_change_seq: 4 })])]);
    await move.supervisor.onEvent(paneEvent("pane_moved", moved, { previous_pane_id: "p1" }));
    expect(types(move.wakes)).toEqual(["reconciliation_degraded"]);
    expect(move.supervisor.view()).toMatchObject({ state: "degraded", child: { paneId: "p1" } });
    move.supervisor.shutdown();
  });

  it("rebases the lifecycle watermark across an AGY pane move", async () => {
    const destination = agyPaneRecord({ pane_id: "p2", agent_session: agySession, agent_status: "idle", revision: 1, state_change_seq: 6 });
    const h = await exactAgyBound([snapshot([destination], [agyAgentRecord({ pane_id: "p2", agent_session: agySession, agent_status: "idle", revision: 1, state_change_seq: 6 })])]);
    await h.supervisor.onEvent(paneEvent("pane_moved", destination, { previous_pane_id: "p1" }));
    await h.supervisor.onEvent(paneEvent("pane_updated", { ...destination, agent_status: "blocked", state_change_seq: 7 }));
    expect(types(h.wakes)).toEqual(["work_cycle_completed", "blocked"]);
    expect(h.supervisor.view()).toMatchObject({ child: { paneId: "p2" }, status: "blocked", monitor: { evidenceGaps: 0 } });
    h.supervisor.shutdown();
  });

  it("keeps a same-revision regressed event gap-visible without adopting its status", async () => {
    const h = await exactAgyBound();
    await h.supervisor.onEvent(paneEvent("pane_updated", agyPaneRecord({ agent_session: agySession, agent_status: "idle", revision: 3, state_change_seq: 4 })));
    expect(types(h.wakes)).toEqual(["evidence_gap"]);
    expect(h.supervisor.view()).toMatchObject({ status: "working", monitor: { evidenceGaps: 1 } });
    const internals = h.supervisor as unknown as { lastRevision: number; lastStateChangeSeq?: number };
    expect(internals).toMatchObject({ lastRevision: 3, lastStateChangeSeq: 5 });
    await h.supervisor.onEvent(paneEvent("pane_updated", agyPaneRecord({ agent_session: agySession, agent_status: "working", revision: 3, state_change_seq: 5 })));
    expect(h.wakes).toHaveLength(1);
    expect(h.supervisor.view().monitor.evidenceGaps).toBe(1);
    h.supervisor.shutdown();
  });

  it("keeps a newer regressed event endpoint gap-visible without adopting it", async () => {
    const h = await exactAgyBound();
    const event = paneEvent("pane_updated", agyPaneRecord({ agent_session: agySession, agent_status: "idle", revision: 5, state_change_seq: 4 }));
    await h.supervisor.onEvent(event);
    expect(types(h.wakes)).toEqual(["evidence_gap", "evidence_gap"]);
    expect(h.supervisor.view()).toMatchObject({ status: "working", monitor: { evidenceGaps: 2 } });
    const internals = h.supervisor as unknown as { lastRevision: number; lastStateChangeSeq?: number };
    expect(internals).toMatchObject({ lastRevision: 3, lastStateChangeSeq: 5 });
    expect(h.wakes.filter((wake) => wake.event.details?.reason === "revision_jump")).toHaveLength(1);

    const wakeCount = h.wakes.length;
    await h.supervisor.onEvent(event);
    expect(h.wakes).toHaveLength(wakeCount);
    expect(h.supervisor.view().monitor.evidenceGaps).toBe(2);
    expect(h.wakes.filter((wake) => wake.event.details?.reason === "revision_jump")).toHaveLength(1);

    await h.supervisor.onEvent(paneEvent("pane_updated", agyPaneRecord({ agent_session: agySession, agent_status: "idle", revision: 5, state_change_seq: 3 })));
    expect(h.wakes).toHaveLength(wakeCount + 2);
    expect(h.supervisor.view().monitor.evidenceGaps).toBe(4);
    expect(h.wakes.filter((wake) => wake.event.details?.reason === "revision_jump")).toHaveLength(2);
    expect(internals).toMatchObject({ lastRevision: 3, lastStateChangeSeq: 5 });
    h.supervisor.shutdown();
  });

  it("keeps move lifecycle gaps visible when the destination omits its sequence", async () => {
    const destination = agyPaneRecord({ pane_id: "p2", agent_session: agySession, agent_status: "idle", revision: 1 });
    delete destination.state_change_seq;
    const destinationAgent = agyAgentRecord({ pane_id: "p2", agent_session: agySession, agent_status: "idle", revision: 1 });
    delete destinationAgent.state_change_seq;
    const h = await exactAgyBound([snapshot([destination], [destinationAgent])]);
    await h.supervisor.onEvent(paneEvent("pane_moved", destination, { previous_pane_id: "p1" }));
    expect(types(h.wakes)).toEqual(["evidence_gap", "work_cycle_completed"]);
    expect(h.supervisor.view().monitor.evidenceGaps).toBe(1);
    h.supervisor.shutdown();

    const regressedDestination = agyPaneRecord({ pane_id: "p2", agent_session: agySession, agent_status: "working", revision: 1, state_change_seq: 4 });
    const pending = await exactAgyBound([invalidDestination(), snapshot([regressedDestination], [agyAgentRecord({ pane_id: "p2", agent_session: agySession, agent_status: "working", revision: 1, state_change_seq: 4 })])]);
    await pending.supervisor.onEvent(paneEvent("pane_moved", regressedDestination, { previous_pane_id: "p1" }));
    await pending.supervisor.onReconciliationSnapshot(snapshot([regressedDestination], [agyAgentRecord({ pane_id: "p2", agent_session: agySession, agent_status: "working", revision: 1, state_change_seq: 4 })]));
    expect(types(pending.wakes)).toEqual(["reconciliation_degraded"]);
    expect(pending.supervisor.view()).toMatchObject({ state: "degraded", child: { paneId: "p1" } });
    pending.supervisor.shutdown();

    const absentDestination = await exactAgyBound([snapshot([], [])]);
    await absentDestination.supervisor.onEvent(paneEvent("pane_moved", regressedDestination, { previous_pane_id: "p1" }));
    expect(types(absentDestination.wakes)).toEqual(["identity_lost"]);
    expect(await absentDestination.supervisor.run()).toMatchObject({ outcome: "identity_lost" });
  });

  it("accepts a Pi same-revision transition when its authoritative lifecycle sequence advances", async () => {
    const h = harness({ snapshots: [snapshot([paneRecord({ status: "working", revision: 5, stateChangeSeq: 4 })])] });
    await h.supervisor.bind({ identity, profileName: "worker-pi", stateChangeSeq: 4 });
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "idle", revision: 5, stateChangeSeq: 5 })));
    expect(types(h.wakes)).toEqual(["work_cycle_completed"]);
    expect(h.supervisor.view().monitor.evidenceGaps).toBe(0);
    h.supervisor.shutdown();

    const unanchored = harness({ snapshots: [snapshot([paneRecord({ status: "working", revision: 5 })])] });
    await unanchored.supervisor.bind({ identity, profileName: "worker-pi" });
    await unanchored.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "working", revision: 6, stateChangeSeq: 1 })));
    expect(unanchored.supervisor.view().monitor.evidenceGaps).toBe(0);
    unanchored.supervisor.shutdown();
  });

  it("keeps same-revision Pi and Claude transitions gap-visible without lifecycle evidence", async () => {
    const claudeSession = { source: "herdr:claude", agent: "claude", kind: "id", value: "s1" };
    for (const [agentKind, agentSession] of [["pi", session], ["claude", claudeSession]] as const) {
      const h = harness({
        child: { agentName: "worker", agentKind, profileName: `worker-${agentKind}` },
        snapshots: [snapshot([paneRecord({ status: "working", revision: 5, agentKind, agentSession })])],
      });
      const boundIdentity = { ...identity, agentKind, agentSession };
      await h.supervisor.bind({ identity: boundIdentity, profileName: `worker-${agentKind}` });
      await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "idle", revision: 5, agentKind, agentSession })));
      expect(types(h.wakes)).toEqual(["evidence_gap", "work_cycle_completed"]);
      expect(h.supervisor.view().monitor.evidenceGaps).toBe(1);
      h.supervisor.shutdown();
    }
  });

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

  it("treats done to idle normalization as noise", async () => {
    const h = await bound();
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "done", revision: 6 })));
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "idle", revision: 7 })));
    expect(types(h.wakes)).toEqual(["work_cycle_completed"]);
    expect(h.supervisor.view()).toMatchObject({ status: "idle" });
    expect(h.supervisor.view().transitions.map(({ from, to }) => ({ from, to }))).toEqual([
      { from: "working", to: "done" },
    ]);
    expect(h.progress.some((line) => line.includes("done → idle"))).toBe(false);
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

  it("folds a move event sequence when its destination snapshot omits it", async () => {
    const origin = paneRecord({ status: "working", revision: 5, stateChangeSeq: 5 });
    const moved = paneRecord({ paneId: "p2", status: "idle", revision: 1, stateChangeSeq: 8 });
    const destination = paneRecord({ paneId: "p2", status: "idle", revision: 1 });
    delete destination.state_change_seq;
    const h = harness({ snapshots: [snapshot([origin]), snapshot([destination], [{ pane_id: "p2", name: "worker" }])] });
    await h.supervisor.bind({ identity, profileName: "worker-pi", stateChangeSeq: 5 });
    await h.supervisor.onEvent(paneEvent("pane_moved", moved, { previous_pane_id: "p1" }));
    expect(types(h.wakes)).toEqual(["work_cycle_completed"]);
    expect(h.supervisor.view()).toMatchObject({ child: { paneId: "p2" }, status: "idle", monitor: { evidenceGaps: 0 } });
    const internals = h.supervisor as unknown as { lastRevision: number; lastStateChangeSeq?: number };
    expect(internals).toMatchObject({ lastRevision: 1, lastStateChangeSeq: 8 });

    await h.supervisor.onEvent(paneEvent("pane_updated", { ...moved, agent_status: "blocked", state_change_seq: 7 }));
    expect(types(h.wakes)).toEqual(["work_cycle_completed", "evidence_gap"]);
    expect(h.supervisor.view()).toMatchObject({ status: "idle", monitor: { evidenceGaps: 1 } });
    expect(internals).toMatchObject({ lastRevision: 1, lastStateChangeSeq: 8 });
    h.supervisor.shutdown();
  });

  it("keeps a newer move sequence when the destination snapshot is lower", async () => {
    const origin = paneRecord({ status: "working", revision: 5, stateChangeSeq: 5 });
    const moved = paneRecord({ paneId: "p2", status: "idle", revision: 1, stateChangeSeq: 8 });
    const lower = paneRecord({ paneId: "p2", status: "idle", revision: 1, stateChangeSeq: 7 });
    const h = harness({ snapshots: [snapshot([origin]), snapshot([lower], [{ pane_id: "p2", name: "worker" }])] });
    await h.supervisor.bind({ identity, profileName: "worker-pi", stateChangeSeq: 5 });
    await h.supervisor.onEvent(paneEvent("pane_moved", moved, { previous_pane_id: "p1" }));
    expect(types(h.wakes)).toEqual(["reconciliation_degraded"]);
    expect(h.supervisor.view()).toMatchObject({ state: "degraded", child: { paneId: "p1" } });
    const internals = h.supervisor as unknown as { lastStateChangeSeq?: number };
    expect(internals.lastStateChangeSeq).toBe(8);

    await h.supervisor.onReconciliationSnapshot(snapshot([lower], [{ pane_id: "p2", name: "worker" }]));
    expect(types(h.wakes)).toEqual(["reconciliation_degraded"]);
    expect(internals.lastStateChangeSeq).toBe(8);

    await h.supervisor.onReconciliationSnapshot(snapshot([moved], [{ pane_id: "p2", name: "worker" }]));
    expect(types(h.wakes)).toEqual(["reconciliation_degraded", "reconciliation_recovered", "work_cycle_completed"]);
    expect(h.supervisor.view()).toMatchObject({ child: { paneId: "p2" }, status: "idle" });
    await h.supervisor.onEvent(paneEvent("pane_updated", { ...moved, agent_status: "blocked", state_change_seq: 7 }));
    expect(types(h.wakes)).toEqual(["reconciliation_degraded", "reconciliation_recovered", "work_cycle_completed", "evidence_gap"]);
    expect(h.supervisor.view()).toMatchObject({ status: "idle", monitor: { evidenceGaps: 1 } });
    expect(internals.lastStateChangeSeq).toBe(8);
    h.supervisor.shutdown();
  });

  it("rejects a destination snapshot below the move revision", async () => {
    const origin = paneRecord({ status: "working", revision: 5, stateChangeSeq: 5 });
    const moved = paneRecord({ paneId: "p2", status: "idle", revision: 2, stateChangeSeq: 8 });
    const lower = paneRecord({ paneId: "p2", status: "idle", revision: 1, stateChangeSeq: 8 });
    const h = harness({ snapshots: [snapshot([origin]), snapshot([lower], [{ pane_id: "p2", name: "worker" }])] });
    await h.supervisor.bind({ identity, profileName: "worker-pi", stateChangeSeq: 5 });

    await h.supervisor.onEvent(paneEvent("pane_moved", moved, { previous_pane_id: "p1" }));

    expect(types(h.wakes)).toEqual(["reconciliation_degraded"]);
    expect(h.supervisor.view()).toMatchObject({ state: "degraded", child: { paneId: "p1" }, status: "working" });
    expect(h.wakes[0]?.event.details?.reason).toBe("revision_regressed");
    h.supervisor.shutdown();
  });

  it("folds a proven move endpoint before a newer snapshot endpoint", async () => {
    const origin = paneRecord({ status: "working", revision: 5, stateChangeSeq: 5 });
    const moved = paneRecord({ paneId: "p2", status: "idle", revision: 1, stateChangeSeq: 8 });
    const destination = paneRecord({ paneId: "p2", status: "working", revision: 2, stateChangeSeq: 9 });
    const h = harness({ snapshots: [snapshot([origin]), snapshot([destination], [{ pane_id: "p2", name: "worker" }])] });
    await h.supervisor.bind({ identity, profileName: "worker-pi", stateChangeSeq: 5 });

    await h.supervisor.onEvent(paneEvent("pane_moved", moved, { previous_pane_id: "p1" }));

    expect(types(h.wakes)).toEqual(["work_cycle_completed", "evidence_gap"]);
    expect(h.wakes[1]?.event.details?.reason).toBe("revision_jump");
    expect(h.supervisor.view()).toMatchObject({ child: { paneId: "p2" }, status: "working", monitor: { evidenceGaps: 1 } });
    expect(h.supervisor.view().transitions).toEqual([
      { atMs: 1_000, from: "working", to: "idle", revision: 1, source: "event" },
      { atMs: 1_000, from: "idle", to: "working", revision: 2, source: "snapshot" },
    ]);
    expect(h.supervisor as unknown as { lastRevision: number; lastStateChangeSeq?: number }).toMatchObject({ lastRevision: 2, lastStateChangeSeq: 9 });
    h.supervisor.shutdown();
  });

  it("rejects equal-sequence move and snapshot status contradictions", async () => {
    const origin = paneRecord({ status: "working", revision: 5, stateChangeSeq: 5 });
    const moved = paneRecord({ paneId: "p2", status: "idle", revision: 1, stateChangeSeq: 8 });
    const destination = paneRecord({ paneId: "p2", status: "working", revision: 1, stateChangeSeq: 8 });
    const h = harness({ snapshots: [snapshot([origin]), snapshot([destination], [{ pane_id: "p2", name: "worker" }])] });
    await h.supervisor.bind({ identity, profileName: "worker-pi", stateChangeSeq: 5 });

    await h.supervisor.onEvent(paneEvent("pane_moved", moved, { previous_pane_id: "p1" }));

    expect(types(h.wakes)).toEqual(["reconciliation_degraded"]);
    expect(h.supervisor.view()).toMatchObject({
      state: "degraded",
      child: { paneId: "p1" },
      status: "working",
      transitions: [],
      monitor: { reconciliation: { lastFailureReason: "target_identity_contradiction" } },
    });
    expect((h.supervisor as unknown as { lastStateChangeSeq?: number }).lastStateChangeSeq).toBe(8);
    h.supervisor.shutdown();
  });

  it("credits a matching move sequence across a newer snapshot revision", async () => {
    const origin = paneRecord({ status: "working", revision: 5, stateChangeSeq: 5 });
    const moved = paneRecord({ paneId: "p2", status: "idle", revision: 1, stateChangeSeq: 8 });
    const destination = paneRecord({ paneId: "p2", status: "idle", revision: 2, stateChangeSeq: 8 });
    const h = harness({ snapshots: [snapshot([origin]), snapshot([destination], [{ pane_id: "p2", name: "worker" }])] });
    await h.supervisor.bind({ identity, profileName: "worker-pi", stateChangeSeq: 5 });

    await h.supervisor.onEvent(paneEvent("pane_moved", moved, { previous_pane_id: "p1" }));

    expect(types(h.wakes)).toEqual(["work_cycle_completed", "evidence_gap"]);
    expect(h.wakes.filter((wake) => wake.event.type === "evidence_gap").map((wake) => wake.event.details?.reason)).toEqual(["revision_jump"]);
    expect(h.supervisor.view()).toMatchObject({ child: { paneId: "p2" }, status: "idle", monitor: { evidenceGaps: 1 } });
    expect(h.supervisor.view().transitions).toEqual([
      { atMs: 1_000, from: "working", to: "idle", revision: 1, source: "event" },
    ]);
    h.supervisor.shutdown();
  });

  it("does not merge a move sequence into an incoherent snapshot tuple", async () => {
    const origin = paneRecord({ status: "working", revision: 5, stateChangeSeq: 5 });
    const moved = paneRecord({ paneId: "p2", status: "idle", revision: 1, stateChangeSeq: 8 });
    const incoherent = paneRecord({ paneId: "p2", status: "working", revision: 2 });
    delete incoherent.state_change_seq;
    const h = harness({ snapshots: [snapshot([origin]), snapshot([incoherent], [{ pane_id: "p2", name: "worker" }])] });
    await h.supervisor.bind({ identity, profileName: "worker-pi", stateChangeSeq: 5 });
    await h.supervisor.onEvent(paneEvent("pane_moved", moved, { previous_pane_id: "p1" }));
    expect(h.supervisor.view()).toMatchObject({ state: "degraded", child: { paneId: "p1", }, monitor: { reconciliation: { lastFailureReason: "target_identity_contradiction" } } });
    expect((h.supervisor as unknown as { lastStateChangeSeq?: number }).lastStateChangeSeq).toBe(8);
    h.supervisor.shutdown();
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

  it("reconciles a retained destination's own events instead of folding them on the origin watermark", async () => {
    const destination = paneRecord({ paneId: "p2", revision: 1, status: "blocked" });
    const h = await bound([invalidDestination(), snapshot([destination], [{ pane_id: "p2", name: "worker" }])]);
    await h.supervisor.onEvent(paneEvent("pane_moved", paneRecord({ paneId: "p2", revision: 1, status: "blocked" }), { previous_pane_id: "p1" }));
    // The destination is routed here from the moment it is retained: its events
    // are this child's, and without them the move could never be completed by
    // anything but a periodic snapshot.
    expect(h.supervisor.matches("p2")).toBe(true);

    // Pane-local revision one is below the origin pane's watermark of five, so
    // folding it there would discard it. It drives an authoritative read of the
    // destination, which both completes the move and adopts the proven status.
    await h.supervisor.onEvent(paneEvent("pane_updated", destination));
    expect(h.supervisor.view()).toMatchObject({ state: "active", child: { paneId: "p2" }, status: "blocked" });
    expect(h.supervisor.view().monitor.evidenceGaps).toBe(0);
    expect(types(h.wakes)).toEqual(["reconciliation_degraded", "reconciliation_recovered", "blocked"]);
  });

  it("does not adopt a regressed endpoint in a chained pending move", async () => {
    const origin = paneRecord({ status: "working", revision: 5, stateChangeSeq: 5 });
    const first = paneRecord({ paneId: "p2", status: "idle", revision: 1, stateChangeSeq: 8 });
    const regressed = paneRecord({ paneId: "p3", status: "blocked", revision: 2, stateChangeSeq: 7 });
    const destination = paneRecord({ paneId: "p3", status: "idle", revision: 2, stateChangeSeq: 9 });
    const h = harness({ snapshots: [snapshot([origin]), invalidDestination(), snapshot([destination], [{ pane_id: "p3", name: "worker" }])] });
    await h.supervisor.bind({ identity, profileName: "worker-pi", stateChangeSeq: 5 });

    await h.supervisor.onEvent(paneEvent("pane_moved", first, { previous_pane_id: "p1" }));
    await h.supervisor.onEvent(paneEvent("pane_moved", regressed, { previous_pane_id: "p2" }));

    expect(types(h.wakes)).toEqual(["reconciliation_degraded", "reconciliation_recovered", "work_cycle_completed", "evidence_gap"]);
    expect(h.wakes.at(-1)?.event.details).toMatchObject({ source: "event", reason: "status_changed_without_revision", previousStateChangeSeq: 8, observedStateChangeSeq: 7 });
    expect(h.supervisor.view()).toMatchObject({ child: { paneId: "p3" }, status: "idle", monitor: { evidenceGaps: 1 } });
    expect(h.supervisor.view().transitions).toEqual([
      { atMs: 1_000, from: "working", to: "idle", revision: 1, source: "event" },
    ]);
    expect((h.supervisor as unknown as { lastStateChangeSeq?: number }).lastStateChangeSeq).toBe(9);
    h.supervisor.shutdown();
  });

  it("rejects a chained snapshot that contradicts an earlier retained lifecycle endpoint", async () => {
    const origin = paneRecord({ status: "working", revision: 5, stateChangeSeq: 5 });
    const first = paneRecord({ paneId: "p2", status: "idle", revision: 1, stateChangeSeq: 8 });
    const regressed = paneRecord({ paneId: "p3", status: "blocked", revision: 2, stateChangeSeq: 7 });
    const contradictory = paneRecord({ paneId: "p3", status: "blocked", revision: 2, stateChangeSeq: 8 });
    const h = harness({ snapshots: [snapshot([origin]), invalidDestination(), snapshot([contradictory], [{ pane_id: "p3", name: "worker" }])] });
    await h.supervisor.bind({ identity, profileName: "worker-pi", stateChangeSeq: 5 });

    await h.supervisor.onEvent(paneEvent("pane_moved", first, { previous_pane_id: "p1" }));
    await h.supervisor.onEvent(paneEvent("pane_moved", regressed, { previous_pane_id: "p2" }));

    expect(types(h.wakes)).toEqual(["reconciliation_degraded"]);
    expect(h.supervisor.view()).toMatchObject({
      state: "degraded",
      child: { paneId: "p1" },
      status: "working",
      transitions: [],
      monitor: { reconciliation: { lastFailureReason: "target_identity_contradiction" } },
    });
    expect((h.supervisor as unknown as { lastStateChangeSeq?: number }).lastStateChangeSeq).toBe(8);
    h.supervisor.shutdown();
  });

  it("rejects conflicting equal-sequence endpoints in a chained pending move", async () => {
    const origin = paneRecord({ status: "working", revision: 5, stateChangeSeq: 5 });
    const first = paneRecord({ paneId: "p2", status: "idle", revision: 1, stateChangeSeq: 8 });
    const contradictory = paneRecord({ paneId: "p3", status: "blocked", revision: 2, stateChangeSeq: 8 });
    const destination = paneRecord({ paneId: "p3", status: "blocked", revision: 2, stateChangeSeq: 9 });
    const h = harness({ snapshots: [snapshot([origin]), invalidDestination(), snapshot([destination], [{ pane_id: "p3", name: "worker" }])] });
    await h.supervisor.bind({ identity, profileName: "worker-pi", stateChangeSeq: 5 });

    await h.supervisor.onEvent(paneEvent("pane_moved", first, { previous_pane_id: "p1" }));
    await h.supervisor.onEvent(paneEvent("pane_moved", contradictory, { previous_pane_id: "p2" }));

    expect(types(h.wakes)).toEqual(["reconciliation_degraded"]);
    expect(h.supervisor.view()).toMatchObject({
      state: "degraded",
      child: { paneId: "p1" },
      status: "working",
      transitions: [],
      monitor: { reconciliation: { lastFailureReason: "target_identity_contradiction" } },
    });
    expect((h.supervisor as unknown as { lastStateChangeSeq?: number }).lastStateChangeSeq).toBe(8);
    h.supervisor.shutdown();
  });

  it("preserves earlier lifecycle advancement across chained pending moves", async () => {
    const origin = paneRecord({ status: "working", revision: 5, stateChangeSeq: 5 });
    const first = paneRecord({ paneId: "p2", status: "idle", revision: 1, stateChangeSeq: 8 });
    const second = paneRecord({ paneId: "p3", status: "idle", revision: 2, stateChangeSeq: 8 });
    const destination = paneRecord({ paneId: "p3", status: "idle", revision: 2 });
    const h = harness({ snapshots: [snapshot([origin]), invalidDestination(), invalidDestination("p3")] });
    await h.supervisor.bind({ identity, profileName: "worker-pi", stateChangeSeq: 5 });

    await h.supervisor.onEvent(paneEvent("pane_moved", first, { previous_pane_id: "p1" }));
    await h.supervisor.onEvent(paneEvent("pane_moved", second, { previous_pane_id: "p2" }));
    await h.supervisor.onReconciliationSnapshot(snapshot([destination], [{ pane_id: "p3", name: "worker" }]));

    expect(types(h.wakes)).toEqual(["reconciliation_degraded", "reconciliation_recovered", "work_cycle_completed"]);
    expect(h.supervisor.view()).toMatchObject({ child: { paneId: "p3" }, status: "idle", monitor: { evidenceGaps: 0 } });
    expect(h.supervisor.view().transitions).toEqual([
      { atMs: 1_000, from: "working", to: "idle", revision: 1, source: "event" },
    ]);
    expect((h.supervisor as unknown as { lastStateChangeSeq?: number }).lastStateChangeSeq).toBe(8);
    h.supervisor.shutdown();
  });

  it("follows a chained move out of a retained destination without concluding the child was lost", async () => {
    const h = await bound([
      invalidDestination(),
      invalidDestination("p3"),
      snapshot([paneRecord({ paneId: "p3", revision: 2, status: "idle" })], [{ pane_id: "p3", name: "worker" }]),
    ]);
    await h.supervisor.onEvent(paneEvent("pane_moved", paneRecord({ paneId: "p2", revision: 1 }), { previous_pane_id: "p1" }));
    expect(h.supervisor.view()).toMatchObject({ state: "degraded", child: { paneId: "p1" } });

    // p2 -> p3 while p2 is still only the retained destination. Judging it a
    // foreign move would reconcile p2 — which this second move has just emptied
    // — and settle a false `pane_closed` on a child that is alive in p3.
    await h.supervisor.onEvent(paneEvent("pane_moved", paneRecord({ paneId: "p3", revision: 2 }), { previous_pane_id: "p2" }));
    expect(h.supervisor.view()).toMatchObject({ state: "degraded", child: { paneId: "p1" } });
    expect(h.supervisor.childLive()).toBe(true);
    // The retained destination moved with the child, so p3 is now what routes.
    expect(h.supervisor.matches("p3")).toBe(true);
    expect(h.supervisor.matches("p2")).toBe(false);

    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ paneId: "p3", revision: 2, status: "idle" })));
    expect(h.supervisor.view()).toMatchObject({ state: "active", child: { paneId: "p3" }, status: "idle" });
    expect(types(h.wakes)).toEqual(["reconciliation_degraded", "reconciliation_recovered", "work_cycle_completed"]);
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
    const h = harness({ ...options, snapshots: [snapshot([paneRecord({ status: "working", revision: 5 })]), ...(options.snapshots ?? [])] });
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

  it("neither reads a transcript nor reaches the reviewer while a move destination is unresolved", async () => {
    const reads: string[] = [];
    // The destination's first read is invalid, so the move is retained. The read
    // that resolves it also shows p1 already reused by a different agent: the
    // origin transcript is a stranger's output, and semantic review must never
    // have touched it.
    const resolved = snapshot(
      [paneRecord({ paneId: "p2", revision: 1, status: "working" }), paneRecord({ terminalId: "t9", agentSession: { ...session, value: "other" } })],
      [{ pane_id: "p2", name: "worker" }, { pane_id: "p1", name: "other" }],
    );
    const h = await working({ snapshots: [invalidDestination(), resolved], transcript: async (paneId) => { reads.push(paneId); return ["line"]; } });
    await h.supervisor.onEvent(paneEvent("pane_moved", paneRecord({ paneId: "p2", revision: 1, status: "working" }), { previous_pane_id: "p1" }));

    h.fireTimer();
    await Promise.resolve();
    expect(reads).toEqual([]);
    expect(h.reviews).toBe(0);
    // The cadence keeps ticking so the run resumes rather than being abandoned.
    expect(h.timerArmed()).toBe(true);

    // Exact identity is re-established at the destination; review resumes there.
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ paneId: "p2", revision: 1, status: "working" })));
    expect(h.supervisor.view()).toMatchObject({ state: "active", child: { paneId: "p2" } });
    h.fireTimer();
    await vi.waitFor(() => expect(h.reviews).toBe(1));
    expect(reads).toEqual(["p2"]);
  });

  it("abandons an in-flight review before a gated move snapshot can resolve", async () => {
    const reads: string[] = [];
    const transcript = gatedTranscript(reads);
    const destination = gatedSnapshot(snapshot([paneRecord({ paneId: "p2", status: "working", revision: 1 })], [{ pane_id: "p2", name: "worker" }]));
    const h = await working({ snapshots: [destination.snapshot], transcript: transcript.transcript });
    const inFlight = (h.supervisor as unknown as { review(): Promise<void> }).review();
    await vi.waitFor(() => expect(reads).toEqual(["p1"]));

    const move = h.supervisor.onEvent(paneEvent("pane_moved", paneRecord({ paneId: "p2", revision: 1, status: "working" }), { previous_pane_id: "p1" }));
    await Promise.resolve();
    transcript.release();
    await inFlight;
    expect(h.reviews).toBe(0);
    expect(h.supervisor.view().reviewer).toMatchObject({ degraded: false, reviews: [] });

    // The unresolved destination also blocks a new cadence from reading p1.
    h.fireTimer();
    await Promise.resolve();
    expect(reads).toEqual(["p1"]);
    expect(h.reviews).toBe(0);

    destination.release();
    await move;
    expect(h.supervisor.view()).toMatchObject({ state: "active", child: { paneId: "p2" } });
    h.fireTimer();
    await vi.waitFor(() => expect(h.reviews).toBe(1));
    expect(reads).toEqual(["p1", "p2"]);
  });

  it("does not start a review while a move snapshot is gated", async () => {
    const reads: string[] = [];
    const destination = gatedSnapshot(snapshot([paneRecord({ paneId: "p2", status: "working", revision: 1 })], [{ pane_id: "p2", name: "worker" }]));
    const h = await working({ snapshots: [destination.snapshot], transcript: async (paneId) => { reads.push(paneId); return ["line"]; } });

    const move = h.supervisor.onEvent(paneEvent("pane_moved", paneRecord({ paneId: "p2", revision: 1, status: "working" }), { previous_pane_id: "p1" }));
    await Promise.resolve();
    h.fireTimer();
    await Promise.resolve();
    expect(reads).toEqual([]);
    expect(h.reviews).toBe(0);

    destination.release();
    await move;
    h.fireTimer();
    await vi.waitFor(() => expect(h.reviews).toBe(1));
    expect(reads).toEqual(["p2"]);
  });

  function gatedSnapshot(result: HerdrSnapshot): { snapshot: Promise<HerdrSnapshot>; release(): void } {
    let release!: () => void;
    const snapshot = new Promise<HerdrSnapshot>((resolve) => { release = () => resolve(result); });
    return { snapshot, release };
  }

  /**
   * Read p1's transcript behind a gate, so a move can land while the read is in
   * flight, and let every later read return immediately.
   */
  function gatedTranscript(reads: string[]): { transcript: (paneId: string) => Promise<string[]>; release(): void } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    return {
      transcript: async (paneId) => {
        reads.push(paneId);
        if (reads.length === 1) await gate;
        return [`${paneId} line`];
      },
      release: () => { release(); },
    };
  }

  it("abandons an in-flight review when a move is proven outright mid-read", async () => {
    // The destination is valid on its first read, so the move is adopted at once
    // and never becomes pending. The child stays `working`, so the run does not
    // change either: only the pane identity did, and that alone must discard the
    // origin pane's transcript rather than submit it labelled as p2.
    const reads: string[] = [];
    const gated = gatedTranscript(reads);
    const h = await working({
      snapshots: [snapshot([paneRecord({ paneId: "p2", revision: 1, status: "working" })], [{ pane_id: "p2", name: "worker" }])],
      transcript: gated.transcript,
    });
    const inFlight = (h.supervisor as unknown as { review(): Promise<void> }).review();
    await vi.waitFor(() => expect(reads).toEqual(["p1"]));

    await h.supervisor.onEvent(paneEvent("pane_moved", paneRecord({ paneId: "p2", revision: 1, status: "working" }), { previous_pane_id: "p1" }));
    expect(h.supervisor.view()).toMatchObject({ state: "active", child: { paneId: "p2" } });

    gated.release();
    await inFlight;
    expect(h.reviews).toBe(0);
    expect(h.reviewedPanes).toEqual([]);
    expect(h.supervisor.view().reviewer).toMatchObject({ degraded: false, reviews: [] });

    // The cadence survives the discarded review and reads only the new pane.
    expect(h.timerArmed()).toBe(true);
    h.fireTimer();
    await vi.waitFor(() => expect(h.reviews).toBe(1));
    expect(reads).toEqual(["p1", "p2"]);
    expect(h.reviewedPanes).toEqual(["p2"]);
  });

  it("abandons an in-flight review when a retained move destination resolves mid-read", async () => {
    // The destination's first read is invalid, so the move is retained, and the
    // read that resolves it adopts p2 — all while p1's transcript is still being
    // read. `pendingMoveDestination` is clear again by the time the read
    // completes, so only the pane identity token can still refuse it.
    const reads: string[] = [];
    const gated = gatedTranscript(reads);
    const resolved = snapshot([paneRecord({ paneId: "p2", revision: 1, status: "working" })], [{ pane_id: "p2", name: "worker" }]);
    const h = await working({ snapshots: [invalidDestination(), resolved], transcript: gated.transcript });
    const inFlight = (h.supervisor as unknown as { review(): Promise<void> }).review();
    await vi.waitFor(() => expect(reads).toEqual(["p1"]));

    await h.supervisor.onEvent(paneEvent("pane_moved", paneRecord({ paneId: "p2", revision: 1, status: "working" }), { previous_pane_id: "p1" }));
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ paneId: "p2", revision: 1, status: "working" })));
    expect(h.supervisor.view()).toMatchObject({ state: "active", child: { paneId: "p2" } });

    gated.release();
    await inFlight;
    expect(h.reviews).toBe(0);
    expect(h.reviewedPanes).toEqual([]);
    expect(h.supervisor.view().reviewer).toMatchObject({ degraded: false, reviews: [] });

    expect(h.timerArmed()).toBe(true);
    h.fireTimer();
    await vi.waitFor(() => expect(h.reviews).toBe(1));
    expect(reads).toEqual(["p1", "p2"]);
    expect(h.reviewedPanes).toEqual(["p2"]);
  });

  it("clears the cadence when the child leaves the working state", async () => {
    const h = harness({ snapshots: [snapshot([paneRecord({ status: "working", revision: 5 })])] });
    await h.supervisor.bind({ identity, profileName: "worker-pi" });
    expect(h.timerArmed()).toBe(true);
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "idle", revision: 6 })));
    expect(h.timerArmed()).toBe(false);
  });

  it("carries the assignment digest and the new-line count into every review", async () => {
    const h = await working({
      assignmentDigest: { doneWhen: ["tests pass"], constraints: ["read-only"] },
      transcript: async () => ["a", "b", "c"],
    });
    h.fireTimer();
    await vi.waitFor(() => expect(h.reviews).toBe(1));
    expect(h.reviewRequests[0]).toMatchObject({
      assignmentDigest: { doneWhen: ["tests pass"], constraints: ["read-only"] },
      linesSinceLastReview: 3,
      transcriptDelta: ["a", "b", "c"],
    });
  });

  it("omits previousReview on the first review and supplies it on the second", async () => {
    const signals = { progress: 0.9, stalled: 0.1, blocked: 0.05, risk: 0.01, appears_complete: 0.02 };
    const h = await working({ review: async () => ({ classification: "progress", summary: "moving", signals, evidenceSufficiency: 0.95, reason: "artifact_produced" }) });
    h.fireTimer();
    await vi.waitFor(() => expect(h.reviews).toBe(1));
    expect(h.reviewRequests[0]).not.toHaveProperty("previousReview");

    h.fireTimer();
    await vi.waitFor(() => expect(h.reviews).toBe(2));
    // The second review consumes the first review's classification and signals,
    // plus the progress watermark the first crossing set.
    expect(h.reviewRequests[1]!.previousReview).toEqual({
      classification: "progress",
      signals,
      lastMeaningfulProgressAtMs: 1_000,
    });
  });

  it("never backdates the meaningful-progress watermark and omits it until progress crosses", async () => {
    const h = await working({
      review: async (call) => call === 1
        ? { classification: "blocked", summary: "waiting", signals: { progress: 0.5, stalled: 0.1, blocked: 0.9, risk: 0.01, appears_complete: 0.02 }, evidenceSufficiency: 0.9, reason: "missing_permission" }
        : { classification: "progress", summary: "moving", signals: { progress: 0.8, stalled: 0.1, blocked: 0.2, risk: 0.01, appears_complete: 0.02 }, evidenceSufficiency: 0.9, reason: "artifact_produced" },
    });
    h.fireTimer();
    await vi.waitFor(() => expect(h.reviews).toBe(1));
    // A blocked review that did not cross the progress threshold leaves no watermark.
    expect(h.reviewRequests[0]).not.toHaveProperty("previousReview");

    h.fireTimer();
    await vi.waitFor(() => expect(h.reviews).toBe(2));
    expect(h.reviewRequests[1]!.previousReview).toEqual({
      classification: "blocked",
      signals: { progress: 0.5, stalled: 0.1, blocked: 0.9, risk: 0.01, appears_complete: 0.02 },
    });
    expect(h.reviewRequests[1]!.previousReview).not.toHaveProperty("lastMeaningfulProgressAtMs");
  });

  it("persists every signal probability, the reason, and the evidence sufficiency on the review record", async () => {
    const signals = { progress: 0.88, stalled: 0.1, blocked: 0.2, risk: 0.72, appears_complete: 0.02 };
    const h = await working({ review: async () => ({ classification: "risk", summary: "wrong way", signals, evidenceSufficiency: 0.9, reason: "incorrect_direction" }) });
    h.fireTimer();
    await vi.waitFor(() => expect(h.supervisor.view().reviewer.reviews).toHaveLength(1));
    const record = h.supervisor.view().reviewer.reviews[0] as { signals?: unknown; reason?: string; evidenceSufficiency?: number };
    expect(record.signals).toEqual(signals);
    expect(record.reason).toBe("incorrect_direction");
    expect(record.evidenceSufficiency).toBe(0.9);
    // The public triple is unchanged.
    expect(record).toMatchObject({ atMs: 1_000, classification: "risk", summary: "wrong way" });
  });

  it("hands every completed review to the log seam with the allowlisted entry", async () => {
    const signals = { progress: 0.9, stalled: 0.1, blocked: 0.05, risk: 0.01, appears_complete: 0.02 };
    const h = await working({ review: async () => ({ classification: "progress", summary: "moving", signals, evidenceSufficiency: 0.95, reason: "artifact_produced" }) });
    h.fireTimer();
    await vi.waitFor(() => expect(h.logged).toHaveLength(1));
    expect(h.logged[0]).toEqual({
      jobId: "job_supervisor",
      agentName: "worker",
      agentKind: "pi",
      atMs: 1_000,
      classification: "progress",
      attention: false,
      signals,
      evidenceSufficiency: 0.95,
      reason: "artifact_produced",
      lastMeaningfulProgressAtMs: 1_000,
      linesSinceLastReview: 1,
      evidence: {
        paneId: "p1",
        terminalId: "t1",
        agentSession: session,
        revision: 5,
        transcriptLines: 1,
        workingForMs: 0,
      },
    });
    // The next review names the classification this review read as its predecessor.
    h.fireTimer();
    await vi.waitFor(() => expect(h.logged).toHaveLength(2));
    expect(h.logged[1]).toMatchObject({ classification: "progress", previousClassification: "progress" });
  });

  it("logs the wake entry with the emitted event id when a review wakes the manager", async () => {
    const h = await working({ review: async () => ({ classification: "stalled", summary: "no output" }) });
    h.fireTimer();
    await vi.waitFor(() => expect(types(h.wakes)).toEqual(["reviewer_attention"]));
    await vi.waitFor(() => expect(h.logged).toHaveLength(1));
    expect(h.logged[0]).toMatchObject({ classification: "stalled", attention: true });
    expect(h.logged[0]!.wake).toEqual({ eventId: h.wakes[0]!.event.eventId, eventType: "reviewer_attention", atMs: 1_000 });
  });

  it("degrades like a reviewer failure when the log write fails, then retries on the next cadence", async () => {
    const entries: SupervisionReviewLogEntry[] = [];
    let fail = true;
    const h = await working({
      reviewLog: async (entry) => {
        if (fail) throw new ReviewLogError();
        entries.push(entry);
      },
    });
    h.fireTimer();
    await vi.waitFor(() => expect(types(h.wakes)).toEqual(["reviewer_degraded"]));
    // The review still completed and stored; only the dataset row was lost.
    expect(h.supervisor.view().reviewer.reviews).toHaveLength(1);
    expect(h.supervisor.view().reviewer.degraded).toBe(true);
    expect(h.supervisor.childLive()).toBe(true);
    expect(h.timerArmed()).toBe(true);

    fail = false;
    h.fireTimer();
    await vi.waitFor(() => expect(types(h.wakes)).toEqual(["reviewer_degraded", "reviewer_recovered"]));
    expect(entries).toHaveLength(1);
    expect(h.supervisor.view().reviewer.degraded).toBe(false);
  });

  it("still wakes the manager when an attention review's log write fails", async () => {
    const h = await working({
      review: async () => ({ classification: "stalled", summary: "no output" }),
      reviewLog: async () => { throw new ReviewLogError(); },
    });
    h.fireTimer();
    await vi.waitFor(() => expect(types(h.wakes)).toEqual(["reviewer_attention", "reviewer_degraded"]));
    expect(h.supervisor.view().reviewer.reviews).toHaveLength(1);
    expect(h.supervisor.childLive()).toBe(true);
  });

  it("persists nothing for a review abandoned when its run ended in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = await working({ review: async () => { await gate; return { classification: "progress", summary: "moving" }; } });
    h.fireTimer();
    await vi.waitFor(() => expect(h.reviews).toBe(1));
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "idle", revision: 6 })));
    release();
    await vi.waitFor(() => expect(h.supervisor.view().reviewer.reviews).toEqual([]));
    expect(h.logged).toEqual([]);
  });

  it("writes the review and wake records into .herdr/supervision/reviews.jsonl through the default seam", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-supervisor-log-"));
    try {
      const h = harness({
        reviewLog: "default",
        reviewLogRoot: root,
        snapshots: [snapshot([paneRecord({ status: "working", revision: 5, stateChangeSeq: 9 })])],
        review: async () => ({ classification: "stalled", summary: "no output" }),
      });
      await h.supervisor.bind({ identity, profileName: "worker-pi", stateChangeSeq: 9 });
      h.fireTimer();
      await vi.waitFor(() => expect(types(h.wakes)).toEqual(["reviewer_attention"]));
      const paths = reviewLogPaths(root);
      await vi.waitFor(async () => {
        const records = (await readFile(paths.reviews, "utf8")).split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as SupervisionLogRecord);
        expect(records).toHaveLength(2);
        expect(records[0]).toMatchObject({
          type: "review",
          jobId: "job_supervisor",
          agentName: "worker",
          agentKind: "pi",
          atMs: 1_000,
          classification: "stalled",
          attention: true,
          reason: null,
          evidence: { paneId: "p1", terminalId: "t1", agentSession: session, revision: 5, stateChangeSeq: 9, transcriptLines: 1, workingForMs: 0 },
        });
        expect(records[1]).toMatchObject({
          type: "wake",
          eventId: h.wakes[0]!.event.eventId,
          eventType: "reviewer_attention",
          classification: "stalled",
          reviewAtMs: 1_000,
          disposition: "unknown",
        });
      });
      expect((await lstat(paths.reviews)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  it("projects fallback child identity fields and settled omissions", async () => {
    const fallback = harness({
      child: { agentName: "worker", agentKind: "claude", profileName: "requested-claude" },
      snapshots: [snapshot([paneRecord()])],
    });
    await fallback.supervisor.bind({ identity, profileName: "fallback-pi" });
    expect(fallback.supervisor.view()).toMatchObject({
      child: { profileName: "fallback-pi", requestedProfileName: "requested-claude", requestedAgentKind: "claude" },
    });

    const internals = fallback.supervisor as unknown as { state: string; identity?: SupervisedIdentity; status?: string };
    internals.state = "settled";
    internals.identity = undefined;
    internals.status = undefined;
    expect(fallback.supervisor.view()).toMatchObject({ state: "settled" });
    expect(fallback.supervisor.view()).not.toHaveProperty("child");
    expect(fallback.supervisor.view()).not.toHaveProperty("status");
    fallback.supervisor.shutdown();
  });

  it("reports a reserved supervisor as not live", () => {
    const h = harness();
    expect(h.supervisor.childLive()).toBe(false);
    expect(h.supervisor.coversIdentity(identity)).toBe(false);
    expect(h.supervisor.view()).toMatchObject({ state: "reserved", transitions: [], events: [], unobservedEvents: 0 });
    expect(h.supervisor.view().child).toBeUndefined();
  });
});

describe("self-close wake suppression", () => {
  const absent = (): HerdrSnapshot => snapshot([], []);

  it("records no event or wake after a proven self-close", async () => {
    const tracker = createSelfCloseTracker();
    const h = harness({ selfClose: tracker, snapshots: [snapshot([paneRecord()]), absent()] });
    await h.supervisor.bind({ identity, profileName: "worker-pi" });
    tracker.begin("p1")(true);
    await h.supervisor.onEvent(thinEvent("pane_closed"));
    expect(h.wakes).toEqual([]);
    expect(h.supervisor.view().events).toEqual([]);
    expect(h.supervisor.view().unobservedEvents).toBe(0);
    expect(h.supervisor.takePendingEvents()).toEqual([]);
    expect(await h.supervisor.run()).toEqual({ outcome: "released", reason: "event:pane_closed" });
    tracker.clear();
  });

  it("suppresses the event when absence is observed before the close finishes", async () => {
    const tracker = createSelfCloseTracker();
    const h = harness({ selfClose: tracker, snapshots: [snapshot([paneRecord()]), absent()] });
    await h.supervisor.bind({ identity, profileName: "worker-pi" });
    const finish = tracker.begin("p1");
    const observed = h.supervisor.onEvent(thinEvent("pane_closed"));
    finish(true);
    await observed;
    expect(h.wakes).toEqual([]);
    expect(h.supervisor.view().events).toEqual([]);
    expect(await h.supervisor.run()).toEqual({ outcome: "released", reason: "event:pane_closed" });
    tracker.clear();
  });

  it("wakes exactly once when a still-pending close resolves unproven", async () => {
    const tracker = createSelfCloseTracker();
    const h = harness({ selfClose: tracker, snapshots: [snapshot([paneRecord()]), absent()] });
    await h.supervisor.bind({ identity, profileName: "worker-pi" });
    const finish = tracker.begin("p1");
    const observed = h.supervisor.onEvent(thinEvent("pane_closed"));
    expect(h.wakes).toEqual([]);
    finish(false);
    await observed;
    expect(types(h.wakes)).toEqual(["pane_closed"]);
    tracker.clear();
  });

  it("wakes pane_closed normally when the tracked close failed", async () => {
    const tracker = createSelfCloseTracker();
    const h = harness({ selfClose: tracker, snapshots: [snapshot([paneRecord()]), absent()] });
    await h.supervisor.bind({ identity, profileName: "worker-pi" });
    tracker.begin("p1")(false);
    await h.supervisor.onEvent(thinEvent("pane_closed"));
    expect(types(h.wakes)).toEqual(["pane_closed"]);
    tracker.clear();
  });

  it("wakes a recycled pane id whose marker was already consumed", async () => {
    const tracker = createSelfCloseTracker();
    tracker.begin("p1")(true);
    expect(tracker.consume("p1")).toBe(true);
    const h = harness({ selfClose: tracker, snapshots: [snapshot([paneRecord()]), absent()] });
    await h.supervisor.bind({ identity, profileName: "worker-pi" });
    await h.supervisor.onEvent(thinEvent("pane_closed"));
    expect(types(h.wakes)).toEqual(["pane_closed"]);
    tracker.clear();
  });

  it("keeps every non-close wake and never spends the marker on them", async () => {
    const tracker = createSelfCloseTracker();
    const consumeSpy = vi.spyOn(tracker, "consume");
    const h = harness({
      selfClose: tracker,
      snapshots: [
        snapshot([paneRecord()]),
        Object.assign(new Error("down"), { code: "SUPERVISION_SOCKET_CLOSED" }),
        snapshot([paneRecord({ agentSession: null, agentKind: null })], []),
      ],
    });
    await h.supervisor.bind({ identity, profileName: "worker-pi" });
    tracker.begin("p1")(true);
    await h.supervisor.onEvent(thinEvent("pane_exited"));
    expect(types(h.wakes)).toEqual(["reconciliation_degraded"]);
    await h.supervisor.onEvent(thinEvent("pane_closed"));
    expect(types(h.wakes)).toEqual(["reconciliation_degraded", "reconciliation_recovered", "released"]);
    expect(consumeSpy).not.toHaveBeenCalled();
    // The marker was never spent: it still suppresses a matching pane_closed.
    expect(tracker.consume("p1")).toBe(true);
    tracker.clear();
  });

  it("keeps identity_replaced and identity_lost wakes without spending the marker", async () => {
    const tracker = createSelfCloseTracker();
    const consumeSpy = vi.spyOn(tracker, "consume");

    const replaced = harness({ selfClose: tracker, snapshots: [snapshot([paneRecord()]), snapshot([paneRecord({ terminalId: "t9" })])] });
    await replaced.supervisor.bind({ identity, profileName: "worker-pi" });
    tracker.begin("p1")(true);
    await replaced.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ terminalId: "t9", revision: 6 })));
    expect(types(replaced.wakes)).toEqual(["identity_replaced"]);

    const lost = harness({ selfClose: tracker, snapshots: [snapshot([paneRecord()])] });
    await lost.supervisor.bind({ identity, profileName: "worker-pi" });
    await lost.supervisor.onBootstrap(snapshot([], []), 2, true);
    expect(types(lost.wakes)).toEqual(["identity_lost"]);

    expect(consumeSpy).not.toHaveBeenCalled();
    expect(tracker.consume("p1")).toBe(true);
    tracker.clear();
  });

  it("correlates a retained move destination's closure, not the origin pane", async () => {
    const tracker = createSelfCloseTracker();
    const origin = paneRecord({ status: "working", revision: 5 });
    const moved = paneRecord({ paneId: "p2", revision: 6 });

    // A marker on the origin pane must not suppress the destination's closure.
    const stray = harness({ selfClose: tracker, snapshots: [snapshot([origin]), invalidDestination()] });
    await stray.supervisor.bind({ identity, profileName: "worker-pi" });
    await stray.supervisor.onEvent(paneEvent("pane_moved", moved, { previous_pane_id: "p1" }));
    tracker.begin("p1")(true);
    await stray.supervisor.onReconciliationSnapshot(absent());
    expect(types(stray.wakes)).toEqual(["reconciliation_degraded", "reconciliation_recovered", "pane_closed"]);
    expect(await stray.supervisor.run()).toEqual({ outcome: "released", reason: "periodic_snapshot" });

    // The marker on the destination itself does suppress it.
    const held = harness({ selfClose: tracker, snapshots: [snapshot([origin]), invalidDestination()] });
    await held.supervisor.bind({ identity, profileName: "worker-pi" });
    await held.supervisor.onEvent(paneEvent("pane_moved", moved, { previous_pane_id: "p1" }));
    tracker.begin("p2")(true);
    await held.supervisor.onReconciliationSnapshot(absent());
    expect(types(held.wakes)).toEqual(["reconciliation_degraded", "reconciliation_recovered"]);
    expect(held.supervisor.view().events.some((event) => event.type === "pane_closed")).toBe(false);
    expect(await held.supervisor.run()).toEqual({ outcome: "released", reason: "periodic_snapshot" });
    tracker.clear();
  });

  it("falls back to waking when the tracker throws or its decision rejects", async () => {
    const throwing: SelfCloseTracker = {
      begin: () => () => undefined,
      consume: () => {
        throw new Error("tracker exploded");
      },
      clear: () => undefined,
    };
    const h = harness({ selfClose: throwing, snapshots: [snapshot([paneRecord()]), absent()] });
    await h.supervisor.bind({ identity, profileName: "worker-pi" });
    await h.supervisor.onEvent(thinEvent("pane_closed"));
    expect(types(h.wakes)).toEqual(["pane_closed"]);

    const rejecting: SelfCloseTracker = {
      begin: () => () => undefined,
      consume: () => Promise.reject(new Error("tracker exploded")),
      clear: () => undefined,
    };
    const deferred = harness({ selfClose: rejecting, snapshots: [snapshot([paneRecord()]), absent()] });
    await deferred.supervisor.bind({ identity, profileName: "worker-pi" });
    await deferred.supervisor.onEvent(thinEvent("pane_closed"));
    await vi.waitFor(() => expect(deferred.wakes).toHaveLength(1));
    expect(types(deferred.wakes)).toEqual(["pane_closed"]);
  });
});

describe("managed handoff evaluation", () => {
  async function managedAllocation(): Promise<HandoffAllocation> {
    const dir = await mkdtemp(join(tmpdir(), "herdr-supervisor-handoff-"));
    await chmod(dir, 0o700);
    const allocator = createHandoffAllocator({ namespace: { dir, endpoint: "test-endpoint" } });
    const allocation = await allocator.allocate();
    await allocator.persist(allocation, {
      manager: { paneId: "p0", display: "caller", source: "injected" },
      child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi", requestedProfile: "worker-pi", fallbackProfiles: [] },
    });
    return allocation;
  }

  const writeArtifact = (allocation: HandoffAllocation, status: string, summary = "Finished the work.") =>
    writeFile(
      allocation.artifactPath,
      `${allocation.marker}\n\n## Status\n${status}\n\n## Summary\n${summary}\n\n## Changes\n- src/a.ts\n\n## Verification\nnpm test passed.\n\n## Blockers\nNone\n\n## Continuation\nNone\n`,
      { mode: 0o600 },
    );

  /** Count every gate read so a queued evaluation that never ran is provable. */
  function countValidations(gate: HandoffGate): () => number {
    const real = gate.validate.bind(gate);
    let count = 0;
    gate.validate = async (run) => { count += 1; return real(run); };
    return () => count;
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const workingOrigin = () => snapshot([paneRecord({ status: "working", revision: 5, stateChangeSeq: 5 })]);

  async function managed(options: { snapshots?: Array<HerdrSnapshot | Error | Promise<HerdrSnapshot>>; repairPrompt?: SupervisorDependencies["repairPrompt"] } = {}) {
    const gate = createHandoffGate();
    const h = harness({
      snapshots: options.snapshots ?? [workingOrigin()],
      handoffs: gate,
      ...(options.repairPrompt ? { repairPrompt: options.repairPrompt } : {}),
    });
    await h.supervisor.bind({ identity, profileName: "worker-pi", stateChangeSeq: 5 });
    const allocation = await managedAllocation();
    const run = await gate.bind(allocation, identity);
    return { gate, h, allocation, run };
  }

  it("keeps a blocked child in repair when its artifact reports done", async () => {
    const prompts: Array<{ paneId: string; text: string }> = [];
    const { h, allocation, run } = await managed({ repairPrompt: async (paneId, text) => { prompts.push({ paneId, text }); } });
    await writeArtifact(allocation, "done");

    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "blocked", revision: 6, stateChangeSeq: 6 })));
    await vi.waitFor(() => expect(prompts).toHaveLength(1));

    // The artifact is valid and was accepted into the sidecar, but a `done`
    // status does not correspond to a blocked child: the run stays unmatched,
    // stays awaiting_handoff, and earns exactly one fenced repair prompt.
    const state = await readHandoffState(allocation);
    expect(state.lifecycle.state).toBe("awaiting_handoff");
    expect(state.artifact).toMatchObject({ version: 1, status: "done" });
    expect(state.repair).toMatchObject({ attempts: 1, fence: { version: 1 } });
    expect(run.lastValidation).toEqual({ state: "accepted" });
    expect(prompts[0]).toMatchObject({ paneId: "p1" });
    expect(prompts[0]!.text).toContain("(accepted)");
    expect(prompts[0]!.text).toContain(allocation.artifactPath);
    // Supervision never settles on an unmatched artifact.
    expect(h.supervisor.view().state).toBe("active");
    h.supervisor.shutdown();
  });

  it("names the parser's refusal in the repair prompt when the artifact is invalid", async () => {
    const prompts: string[] = [];
    const { h, allocation } = await managed({ repairPrompt: async (_paneId, text) => { prompts.push(text); } });
    await writeFile(allocation.artifactPath, `${allocation.marker}\n\nno headings at all\n`, { mode: 0o600 });

    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "done", revision: 6, stateChangeSeq: 6 })));
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]).toContain("(invalid:headings_mismatch)");
    expect((await readHandoffState(allocation)).lifecycle.state).toBe("awaiting_handoff");
    h.supervisor.shutdown();
  });

  it("never consumes a repair fence on a host that cannot prompt", async () => {
    const { h, allocation, run } = await managed();
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "done", revision: 6, stateChangeSeq: 6 })));
    await vi.waitFor(() => expect(run.lastValidation).toEqual({ state: "missing" }));
    // The verdict was computed and the run left unresolved, but with no prompt
    // transport no attempt is recorded and no version is ever fenced.
    const state = await readHandoffState(allocation);
    expect(state.repair).toEqual({ attempts: 0, fence: null });
    expect(state.lifecycle.state).toBe("awaiting_handoff");
    h.supervisor.shutdown();
  });

  it("sends no second prompt when the version is already fenced or the fence write fails", async () => {
    const prompts: string[] = [];
    const { gate, h, allocation } = await managed({ repairPrompt: async (_paneId, text) => { prompts.push(text); } });
    const validations = countValidations(gate);

    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "done", revision: 6, stateChangeSeq: 6 })));
    await vi.waitFor(() => expect(prompts).toHaveLength(1));

    // A later terminal observation on the same artifact version finds the fence
    // standing, so `beginRepair` grants no token and nothing is sent.
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "working", revision: 7, stateChangeSeq: 7 })));
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "done", revision: 8, stateChangeSeq: 8 })));
    await vi.waitFor(() => expect(validations()).toBe(2));
    expect(prompts).toHaveLength(1);
    expect((await readHandoffState(allocation)).repair.attempts).toBe(1);

    // A fence that cannot be persisted yields no token either: the failed write
    // is never treated as permission to send.
    gate.beginRepair = async () => { throw new Error("sidecar is unavailable"); };
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "working", revision: 9, stateChangeSeq: 9 })));
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "done", revision: 10, stateChangeSeq: 10 })));
    await vi.waitFor(() => expect(validations()).toBe(3));
    expect(prompts).toHaveLength(1);
    expect((await readHandoffState(allocation)).repair.attempts).toBe(1);
    h.supervisor.shutdown();
  });

  it("treats a failed gate read as no evidence rather than a settlement", async () => {
    const prompts: string[] = [];
    const { gate, h, allocation } = await managed({ repairPrompt: async (_paneId, text) => { prompts.push(text); } });
    let reads = 0;
    gate.validate = async () => { reads += 1; throw new Error("gate exploded"); };

    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "done", revision: 6, stateChangeSeq: 6 })));
    await vi.waitFor(() => expect(reads).toBe(1));
    await sleep(20);
    // No verdict means no acceptance, no repair, and no settlement.
    expect(prompts).toHaveLength(0);
    expect((await readHandoffState(allocation)).repair.attempts).toBe(0);
    expect((await readHandoffState(allocation)).lifecycle.state).toBe("awaiting_handoff");
    expect(h.supervisor.view().state).toBe("active");
    h.supervisor.shutdown();
  });

  it("keeps folding evidence when the gate throws outside the guarded calls", async () => {
    const { gate, h, run } = await managed();
    const realLookup = gate.lookup.bind(gate);
    let poisoned = true;
    gate.lookup = (target) => {
      if (!poisoned) return realLookup(target);
      poisoned = false;
      throw new Error("gate exploded");
    };

    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "done", revision: 6, stateChangeSeq: 6 })));
    // The rejected evaluation is swallowed; the mutation chain survives it and
    // the next terminal observation is still evaluated.
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "working", revision: 7, stateChangeSeq: 7 })));
    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "done", revision: 8, stateChangeSeq: 8 })));
    await vi.waitFor(() => expect(run.lastValidation).toEqual({ state: "missing" }));
    expect(h.supervisor.view().state).toBe("active");
    h.supervisor.shutdown();
  });

  it("abandons a queued evaluation when the status left terminal before it ran", async () => {
    const { gate, h } = await managed();
    const validations = countValidations(gate);
    // Both events land in one fold: the terminal observation queues the
    // evaluation, and the working transition behind it reopens the cycle
    // before the queued task reaches the chain.
    const folding = h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "done", revision: 6, stateChangeSeq: 6 })));
    void h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "working", revision: 7, stateChangeSeq: 7 })));
    await folding;
    await sleep(20);
    expect(validations()).toBe(0);
    expect(h.supervisor.view().status).toBe("working");
    h.supervisor.shutdown();
  });

  it("abandons a queued evaluation when the supervisor stopped before it ran", async () => {
    let release!: (value: HerdrSnapshot) => void;
    const blocked = new Promise<HerdrSnapshot>((resolve) => { release = resolve; });
    const { gate, h, allocation } = await managed({ snapshots: [workingOrigin(), blocked] });
    const validations = countValidations(gate);

    // The terminal observation queues the evaluation; the thin event behind it
    // parks the same fold on a reconciliation snapshot that has not arrived.
    const folding = h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "done", revision: 6, stateChangeSeq: 6 })));
    void h.supervisor.onEvent(thinEvent("pane_exited"));
    await sleep(20);
    h.supervisor.shutdown();
    release(snapshot([paneRecord({ status: "done", revision: 6, stateChangeSeq: 6 })]));
    await folding;
    await sleep(20);
    expect(validations()).toBe(0);
    expect((await readHandoffState(allocation)).lifecycle.state).toBe("awaiting_handoff");
  });

  it("follows a proven move so the repair prompt reaches the child's current pane", async () => {
    const prompts: Array<{ paneId: string; text: string }> = [];
    const moved = paneRecord({ paneId: "p2", status: "working", revision: 1, stateChangeSeq: 8 });
    const { h, run } = await managed({
      snapshots: [workingOrigin(), snapshot([moved], [{ pane_id: "p2", name: "worker" }])],
      repairPrompt: async (paneId, text) => { prompts.push({ paneId, text }); },
    });

    await h.supervisor.onEvent(paneEvent("pane_moved", moved, { previous_pane_id: "p1" }));
    expect(h.supervisor.view().child?.paneId).toBe("p2");
    // The gate's bound run tracks the move, so the repair reaches the exact
    // child where it now lives rather than where it was launched.
    expect(run.identity.paneId).toBe("p2");

    await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ paneId: "p2", status: "done", revision: 2, stateChangeSeq: 9 })));
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]).toMatchObject({ paneId: "p2" });
    h.supervisor.shutdown();
  });

  it("reports an unbound identity as the reason a gated host is still ungated", async () => {
    const h = harness({ snapshots: [workingOrigin()], handoffs: createHandoffGate() });
    expect(h.supervisor.handoffEvidence()).toEqual({ gated: false, reason: "identity_unavailable" });
    await h.supervisor.bind({ identity, profileName: "worker-pi", stateChangeSeq: 5 });
    expect(h.supervisor.handoffEvidence()).toEqual({ gated: false, reason: "no_managed_run" });
    h.supervisor.shutdown();
  });
});
