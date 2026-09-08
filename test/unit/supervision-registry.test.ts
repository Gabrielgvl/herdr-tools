import { describe, expect, it } from "vitest";
import { JobRegistry, SupervisionActiveError } from "../../src/job-registry.js";
import { SessionEventMonitor } from "../../src/supervision/monitor.js";
import { SupervisionRegistry } from "../../src/supervision/registry.js";
import { scriptedServer } from "./supervision-peer.js";
import type { SupervisionReviewer } from "../../src/supervision/reviewer.js";
import type { ProvisionalSupervisedIdentity, SupervisedIdentity } from "../../src/supervision/identity.js";
import type { ManagerNotifier, SupervisionWake } from "../../src/supervision/notify.js";
import { createJobsTool } from "../../src/tools/jobs.js";

const session = { source: "herdr:pi", agent: "pi", kind: "id", value: "s1" };
const identity: SupervisedIdentity = { paneId: "p1", terminalId: "t1", agentName: "worker", agentKind: "pi", agentSession: session };
const agyIdentity: ProvisionalSupervisedIdentity = { paneId: "p1", terminalId: "t1", agentName: "worker", agentKind: "agy" };
const agySession = { source: "agy", agent: "agy", kind: "id", value: "agy-1" };
const settings = { reviewCadenceMinutes: 5, reviewerModel: "luna", reviewerThinking: "low" as const };

const pane = { pane_id: "p1", terminal_id: "t1", tab_id: "tab1", workspace_id: "w1", agent_status: "working", revision: 3, agent: "pi", agent_session: session };

function snapshotResult(panes: Array<Record<string, unknown>>, agents: Array<Record<string, unknown>> = panes.some((item) => item.pane_id === "p1") ? [{ pane_id: "p1", name: "worker" }] : []): unknown {
  return { type: "session_snapshot", snapshot: { version: "0.8.2", protocol: 20, workspaces: [], tabs: [], panes, agents } };
}

function agyPane(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { pane_id: "p1", terminal_id: "t1", tab_id: "tab1", workspace_id: "w1", agent_status: "idle", revision: 2, agent: "agy", agent_session: null, state_change_seq: 4, ...overrides };
}

function agyAgent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { pane_id: "p1", name: "worker", agent: "agy", agent_session: null, agent_status: "idle", revision: 2, state_change_seq: 4, ...overrides };
}

interface Fixture {
  jobs: JobRegistry;
  supervision: SupervisionRegistry;
  wakes: SupervisionWake[];
  push(line: string): void;
}

function fixture(options: { reviewer?: SupervisionReviewer; snapshots?: unknown[] } = {}): Fixture {
  const server = scriptedServer({ snapshots: options.snapshots ?? [snapshotResult([pane])] });
  const jobs = new JobRegistry();
  const wakes: SupervisionWake[] = [];
  const notifier: ManagerNotifier = { wake: (wake) => { wakes.push(wake); } };
  const supervision = new SupervisionRegistry({
    jobs,
    settingsLoader: async () => settings,
    readTranscript: async () => ["line"],
    notifier,
    monitorFactory: () => new SessionEventMonitor({ connect: () => server.connect(), env: { HERDR_SOCKET_PATH: "/tmp/s.sock" }, clock: { now: () => 0, sleep: async () => undefined } }),
    ...(options.reviewer ? { reviewerFactory: () => options.reviewer! } : {}),
    scheduler: { setTimer: () => "timer", clearTimer: () => undefined },
    idFactory: (() => { let id = 0; return () => `fixture-${++id}`; })(),
  });
  return { jobs, supervision, wakes, push: server.push };
}

describe("the supervision registry", () => {
  it("registers a supervisor job whose request records the requested child", async () => {
    const f = fixture();
    const reservation = await f.supervision.reserve({ child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" } });
    const detail = f.jobs.get(reservation.jobId)!;
    expect(detail.kind).toBe("supervisor");
    expect(detail.request).toMatchObject({
      kind: "supervisor",
      label: "supervise worker",
      targets: ["worker"],
      // No pane exists at reservation time, so no target id is back-dated into the request.
      targetIds: [],
      child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" },
      settings: { reviewerModel: "openai-codex/gpt-5.6-sol", reviewerThinking: "max", reviewCadenceMinutes: 5 },
    });
    expect(detail.request.target_generation_refs?.[0]).toMatch(/^target_generation_/u);
    f.supervision.shutdown();
  });

  it("publishes AGY provisional supervision and atomically strengthens it to exact coverage", async () => {
    const baseline = snapshotResult([agyPane()], [agyAgent()]);
    const exact = snapshotResult(
      [agyPane({ agent_session: agySession, agent_status: "working", revision: 3, state_change_seq: 5 })],
      [agyAgent({ agent_session: agySession, agent_status: "working", revision: 3, state_change_seq: 5 })],
    );
    const f = fixture({ snapshots: [baseline, baseline, exact] });
    const reservation = await f.supervision.reserve({ child: { agentName: "worker", agentKind: "agy", profileName: "researcher-agy" } });
    await reservation.bindProvisional({ identity: agyIdentity, profileName: "researcher-agy", baseline: { state: "idle", stateChangeSeq: 4, revision: 2 } });
    expect(f.jobs.get(reservation.jobId)).toMatchObject({
      operation_phase: "running",
      request: { targetIds: [], child: { agentKind: "agy", profileName: "researcher-agy" } },
      supervision: { state: "provisional", provisional: { paneId: "p1", terminalId: "t1", baseline: { stateChangeSeq: 4, revision: 2 } } },
    });
    expect(f.jobs.activeSupervisorFor({ ...agySession, paneId: "p1", terminalId: "t1", agentName: "worker", agentKind: "agy", agentSession: agySession })).toBeUndefined();
    await expect(f.jobs.cancel(reservation.jobId)).rejects.toMatchObject({ code: "SUPERVISION_ACTIVE" });

    const exactIdentity: SupervisedIdentity = { ...agyIdentity, agentSession: agySession };
    await reservation.strengthen({ identity: exactIdentity, profileName: "researcher-agy", stateChangeSeq: 5 });
    expect(f.jobs.get(reservation.jobId)).toMatchObject({
      operation_phase: "running",
      request: { targetIds: ["p1"], child: { agentKind: "agy", profileName: "researcher-agy" } },
      supervision: { state: "active", child: { paneId: "p1", agentKind: "agy" }, status: "working" },
    });
    expect(f.jobs.activeSupervisorFor(exactIdentity)).toEqual({ jobId: reservation.jobId });
    f.supervision.shutdown();
  });

  it("keeps the provisional recovery handle when strengthening evidence is rejected", async () => {
    const baseline = snapshotResult([agyPane()], [agyAgent()]);
    const replaced = snapshotResult([agyPane({ terminal_id: "t9", agent_status: "working", revision: 3, state_change_seq: 5 })], [agyAgent({ terminal_id: "t9", agent_status: "working", revision: 3, state_change_seq: 5 })]);
    const f = fixture({ snapshots: [baseline, baseline, replaced] });
    const reservation = await f.supervision.reserve({ child: { agentName: "worker", agentKind: "agy", profileName: "researcher-agy" } });
    await reservation.bindProvisional({ identity: agyIdentity, profileName: "researcher-agy", baseline: { state: "idle", stateChangeSeq: 4, revision: 2 } });
    await expect(reservation.strengthen({ identity: { ...agyIdentity, agentSession: agySession }, profileName: "researcher-agy" })).rejects.toMatchObject({ code: "SUPERVISION_UNCONFIRMED", details: { cause: "identity_mismatch" } });
    expect(f.jobs.get(reservation.jobId)).toMatchObject({ operation_phase: "running", request: { targetIds: [] }, supervision: { state: "provisional" } });
    expect(f.jobs.activeSupervisorFor({ ...agyIdentity, agentSession: agySession })).toBeUndefined();
    await expect(f.jobs.cancel(reservation.jobId)).rejects.toMatchObject({ code: "SUPERVISION_ACTIVE" });
    f.supervision.shutdown();
  });

  it("rolls back the request publication when AGY provisional evidence is rejected", async () => {
    const baseline = snapshotResult([agyPane()], [agyAgent()]);
    const f = fixture({ snapshots: [baseline] });
    const reservation = await f.supervision.reserve({ child: { agentName: "worker", agentKind: "agy", profileName: "researcher-agy" } });
    await expect(reservation.bindProvisional({ identity: agyIdentity, profileName: "researcher-agy", baseline: { state: "idle", stateChangeSeq: -1, revision: 2 } }))
      .rejects.toMatchObject({ code: "SUPERVISION_UNCONFIRMED", details: { cause: "provisional_baseline_invalid" } });
    expect(f.jobs.get(reservation.jobId)).toMatchObject({ request: { targetIds: [], child: { agentKind: "agy", profileName: "researcher-agy" } } });
    f.supervision.shutdown();
  });

  it("does not expose AGY provisional state through the exact binding path", async () => {
    const baseline = snapshotResult([agyPane()], [agyAgent()]);
    const f = fixture({ snapshots: [baseline, baseline] });
    const reservation = await f.supervision.reserve({ child: { agentName: "worker", agentKind: "agy", profileName: "researcher-agy" } });
    await expect(reservation.bind({ identity: { ...agyIdentity, agentSession: agySession }, profileName: "researcher-agy" })).rejects.toThrow(/STRENGTHENING_REQUIRED/u);
    f.supervision.shutdown();
  });

  it("binds, publishes a live view, and settles when the exact child goes away", async () => {
    const f = fixture({ snapshots: [snapshotResult([pane]), snapshotResult([pane]), snapshotResult([])] });
    const reservation = await f.supervision.reserve({ child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" } });
    await reservation.bind({ identity, profileName: "worker-pi", stateChangeSeq: 2 });
    expect(f.jobs.get(reservation.jobId)).toMatchObject({
      kind: "supervisor",
      request: { targets: ["worker"], targetIds: ["p1"], child: { agentKind: "pi", profileName: "worker-pi" } },
      supervision: { state: "active", status: "working", child: { paneId: "p1" } },
    });
    expect(f.jobs.get(reservation.jobId)?.request.target_generation_refs).toHaveLength(1);
    expect(f.jobs.list(undefined, 0, 20, "supervisor").jobs[0]?.targetIds).toEqual(["p1"]);

    f.push(`${JSON.stringify({ event: "pane_closed", data: { type: "pane_closed", pane_id: "p1", workspace_id: "w1" } })}\n`);
    await vi_waitForSettled(f.jobs, reservation.jobId);
    expect(f.jobs.get(reservation.jobId)).toMatchObject({ operation_phase: "settled", supervision_result: "released", supervision_reason: "event:pane_closed" });
    expect(f.wakes.map((wake) => wake.event.type)).toEqual(["pane_closed"]);
    f.supervision.shutdown();
  });

  it("finds coverage only for the complete exact live identity without observing receipts", async () => {
    const f = fixture({ snapshots: [snapshotResult([pane]), snapshotResult([pane]), snapshotResult([])] });
    const reservation = await f.supervision.reserve({ child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" } });
    expect(f.jobs.activeSupervisorFor(identity)).toBeUndefined();
    await reservation.bind({ identity, profileName: "worker-pi" });
    expect(f.jobs.activeSupervisorFor(identity)).toEqual({ jobId: reservation.jobId });

    const mismatches: SupervisedIdentity[] = [
      { ...identity, paneId: "p2" },
      { ...identity, terminalId: "t2" },
      { ...identity, agentName: "other" },
      { ...identity, agentKind: "claude" },
      { ...identity, agentSession: { ...session, source: "other" } },
      { ...identity, agentSession: { ...session, agent: "other" } },
      { ...identity, agentSession: { ...session, kind: "other" } },
      { ...identity, agentSession: { ...session, value: "other" } },
    ];
    for (const mismatch of mismatches) expect(f.jobs.activeSupervisorFor(mismatch)).toBeUndefined();
    expect(f.jobs.activeSupervisorFor({ paneId: "p1" } as SupervisedIdentity)).toBeUndefined();

    f.push(`${JSON.stringify({ event: "pane_updated", data: { type: "pane_updated", pane: { ...pane, agent_status: "blocked", revision: 4 } } })}\n`);
    await vi_waitFor(() => (f.jobs.get(reservation.jobId)?.unobservedEvents ?? 0) > 0);
    const liveSupervisor = [...(f.supervision as unknown as { supervisors: Set<{ onReconciliationFailure(reason: "request_failed"): Promise<void> }> }).supervisors][0]!;
    await liveSupervisor.onReconciliationFailure("request_failed");
    expect(f.jobs.get(reservation.jobId)?.supervision?.state).toBe("degraded");
    const pendingBeforeQuery = f.jobs.get(reservation.jobId)?.unobservedEvents;
    expect(f.jobs.activeSupervisorFor(identity)).toEqual({ jobId: reservation.jobId });
    expect(f.jobs.get(reservation.jobId)?.unobservedEvents).toBe(pendingBeforeQuery);

    f.push(`${JSON.stringify({ event: "pane_closed", data: { type: "pane_closed", pane_id: "p1", workspace_id: "w1" } })}\n`);
    await vi_waitForSettled(f.jobs, reservation.jobId);
    expect(f.jobs.activeSupervisorFor(identity)).toBeUndefined();
    f.supervision.shutdown();
  });

  it("rolls request target publication back when queued evidence settles during bind", async () => {
    const f = fixture({ snapshots: [snapshotResult([pane]), snapshotResult([pane]), snapshotResult([])] });
    const reservation = await f.supervision.reserve({ child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" } });
    const binding = reservation.bind({ identity, profileName: "worker-pi" });
    f.push(`${JSON.stringify({ event: "pane_closed", data: { type: "pane_closed", pane_id: "p1", workspace_id: "w1" } })}\n`);
    await expect(binding).rejects.toMatchObject({ code: "SUPERVISION_UNCONFIRMED", details: { cause: "settled_during_bind", settledDuringBind: true } });
    await vi_waitForSettled(f.jobs, reservation.jobId);
    expect(f.jobs.get(reservation.jobId)).toMatchObject({
      operation_phase: "settled",
      request: { targets: ["worker"], targetIds: [], child: { agentKind: "pi", profileName: "worker-pi" } },
      supervision_result: "released",
    });
    f.supervision.shutdown();
  });

  it("refuses herdr_jobs cancel while the exact child is live and allows it afterwards", async () => {
    const f = fixture({ snapshots: [snapshotResult([pane]), snapshotResult([pane]), snapshotResult([])] });
    const reservation = await f.supervision.reserve({ child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" } });
    await reservation.bind({ identity, profileName: "worker-pi" });
    const tool = createJobsTool(f.jobs);
    await expect(tool.execute("id", { operation: "cancel", jobId: reservation.jobId } as never, undefined, undefined, {} as never)).rejects.toBeInstanceOf(SupervisionActiveError);
    await expect(f.jobs.cancel(reservation.jobId)).rejects.toMatchObject({ code: "SUPERVISION_ACTIVE" });

    f.push(`${JSON.stringify({ event: "pane_closed", data: { type: "pane_closed", pane_id: "p1", workspace_id: "w1" } })}\n`);
    await vi_waitForSettled(f.jobs, reservation.jobId);
    await expect(f.jobs.cancel(reservation.jobId)).resolves.toMatchObject({ operation_phase: "settled" });
    f.supervision.shutdown();
  });

  it("returns soft receipts through herdr_jobs get and counts them in list", async () => {
    const f = fixture({ snapshots: [snapshotResult([pane]), snapshotResult([pane])] });
    const reservation = await f.supervision.reserve({ child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" } });
    await reservation.bind({ identity, profileName: "worker-pi" });
    f.push(`${JSON.stringify({ event: "pane_updated", data: { type: "pane_updated", pane: { ...pane, agent_status: "blocked", revision: 4 } } })}\n`);
    await vi_waitFor(() => (f.jobs.get(reservation.jobId)?.unobservedEvents ?? 0) > 0);

    expect(f.jobs.list(undefined, 0, 20, "supervisor").jobs[0]).toMatchObject({ kind: "supervisor", unobservedEvents: 1 });
    expect(f.jobs.list(undefined, 0, 20, "wait").jobs).toEqual([]);

    const tool = createJobsTool(f.jobs);
    const first = await tool.execute("id", { operation: "get", jobId: reservation.jobId } as never, undefined, undefined, {} as never);
    expect(first.details).toMatchObject({ view: "job", kind: "supervisor", unobservedEvents: 0 });
    expect((first.details as { pending_events: Array<{ type: string }> }).pending_events.map((event) => event.type)).toEqual(["blocked"]);
    const second = await tool.execute("id", { operation: "get", jobId: reservation.jobId } as never, undefined, undefined, {} as never);
    expect(second.details).not.toHaveProperty("pending_events");
    f.supervision.shutdown();
  });

  it("settles a released reservation instead of leaking its job", async () => {
    const f = fixture();
    const reservation = await f.supervision.reserve({ child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" } });
    reservation.release("launch_failed_placement");
    await vi_waitForSettled(f.jobs, reservation.jobId);
    expect(f.jobs.get(reservation.jobId)).toMatchObject({ supervision_result: "failed", supervision_reason: "launch_failed_placement" });
    f.supervision.shutdown();
  });

  it("cancels every supervisor on manager-session shutdown", async () => {
    const f = fixture({ snapshots: [snapshotResult([pane]), snapshotResult([pane])] });
    const reservation = await f.supervision.reserve({ child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" } });
    await reservation.bind({ identity, profileName: "worker-pi" });
    f.supervision.shutdown();
    await vi_waitForSettled(f.jobs, reservation.jobId);
    expect(f.jobs.get(reservation.jobId)).toMatchObject({ supervision_result: "cancelled", supervision_reason: "manager_session_shutdown" });
    f.supervision.shutdown();
  });

  it("keeps a host with no model service visibly degraded rather than silently unreviewed", async () => {
    const f = fixture();
    const reservation = await f.supervision.reserve({ child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" } });
    expect(f.jobs.get(reservation.jobId)?.supervision?.reviewer).toMatchObject({ model: "openai-codex/gpt-5.6-sol", thinking: "max", degraded: false });
    // The default reviewer for a host without a model service always fails.
    const registry = f.supervision as unknown as { reviewer(): SupervisionReviewer };
    await expect(registry.reviewer().review({ paneId: "p1", agentName: "worker", workingForMs: 0, metadata: {}, transcriptDelta: [] }, new AbortController().signal))
      .rejects.toThrow(/No supervision reviewer model service is available/u);
    f.supervision.shutdown();
  });

  it("refuses to reserve when the monitor cannot start", async () => {
    const jobs = new JobRegistry();
    const supervision = new SupervisionRegistry({
      jobs,
      settingsLoader: async () => settings,
      readTranscript: async () => [],
      monitorOptions: { env: {} },
    });
    await expect(supervision.reserve({ child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" } })).rejects.toMatchObject({ code: "SUPERVISION_SOCKET_UNAVAILABLE" });
    expect(jobs.size()).toBe(0);
    supervision.shutdown();
  });
});

async function vi_waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function vi_waitForSettled(jobs: JobRegistry, jobId: string): Promise<void> {
  await vi_waitFor(() => jobs.get(jobId)?.operation_phase === "settled");
}
