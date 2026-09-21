import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobRegistry, SupervisionActiveError } from "../../src/job-registry.js";
import { createHandoffAllocator, readHandoffState, type HandoffAllocation } from "../../src/handoff.js";
import { createHandoffGate, type HandoffGate } from "../../src/handoff-gate.js";
import { ReviewerFailure } from "../../src/reviewer.js";
import { SessionEventMonitor } from "../../src/supervision/monitor.js";
import { resolveForbiddenTools, SupervisionRegistry } from "../../src/supervision/registry.js";
import { scriptedServer } from "./supervision-peer.js";
import { TypeSafeSupervisionReviewer, type SupervisionReviewer } from "../../src/supervision/reviewer.js";
import type { EvidenceState, WorkspaceCommandRunner } from "../../src/supervision/evidence.js";
import type { ProvisionalSupervisedIdentity, SupervisedIdentity } from "../../src/supervision/identity.js";
import type { ManagerNotifier, SupervisionWake } from "../../src/supervision/notify.js";
import { createJobsTool } from "../../src/tools/jobs.js";

const session = { source: "herdr:pi", agent: "pi", kind: "id", value: "s1" };
const identity: SupervisedIdentity = { paneId: "p1", terminalId: "t1", agentName: "worker", agentKind: "pi", agentSession: session };
const agyIdentity: ProvisionalSupervisedIdentity = { paneId: "p1", terminalId: "t1", agentName: "worker", agentKind: "agy" };
const agySession = { source: "agy", agent: "agy", kind: "id", value: "agy-1" };
const settings = { reviewCadenceMinutes: 5, reviewerModel: "testmodel", reviewerThinking: "low" as const };
const workspaceBaseSha = "a".repeat(40);
const cleanWorkspaceRunner: WorkspaceCommandRunner = async (argv) => ({
  stdout: argv[1] === "rev-parse" ? `${workspaceBaseSha}\n` : "",
  exitCode: 0,
});

const pane = { pane_id: "p1", terminal_id: "t1", tab_id: "tab1", workspace_id: "w1", agent_status: "working", revision: 3, agent: "pi", agent_session: session };

function snapshotResult(panes: Array<Record<string, unknown>>, agents: Array<Record<string, unknown>> = panes.some((item) => item.pane_id === "p1") ? [{ pane_id: "p1", name: "worker" }] : []): unknown {
  return { type: "session_snapshot", snapshot: { version: "0.8.2", protocol: 22, workspaces: [], tabs: [], panes, agents } };
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

function fixture(options: { reviewer?: SupervisionReviewer; snapshots?: unknown[]; handoffs?: HandoffGate; repairPrompt?: (paneId: string, text: string, signal: AbortSignal) => Promise<unknown>; workspaceRunner?: WorkspaceCommandRunner } = {}): Fixture {
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
    // Tests never read the real auth.json: an empty store leaves env as the only leg.
    typesafeCredentials: { read: async () => undefined },
    ...(options.reviewer ? { reviewerFactory: () => options.reviewer! } : {}),
    scheduler: { setTimer: () => "timer", clearTimer: () => undefined },
    workspaceRunner: options.workspaceRunner ?? cleanWorkspaceRunner,
    idFactory: (() => { let id = 0; return () => `fixture-${++id}`; })(),
    ...(options.handoffs ? { handoffs: options.handoffs } : {}),
    ...(options.repairPrompt ? { repairPrompt: options.repairPrompt } : {}),
  });
  return { jobs, supervision, wakes, push: server.push };
}

async function managedAllocation(): Promise<HandoffAllocation> {
  const dir = await mkdtemp(join(tmpdir(), "herdr-registry-handoff-"));
  await chmod(dir, 0o700);
  const allocator = createHandoffAllocator({ namespace: { dir, endpoint: "test-endpoint" } });
  const allocation = await allocator.allocate();
  await allocator.persist(allocation, {
    manager: { paneId: "p0", display: "caller", source: "injected" },
    child: { agentName: "worker", agentKind: "pi", candidateName: "worker-pi", specLabel: "worker-pi", fallbackCandidates: [] }
  });
  return allocation;
}

describe("the supervision registry", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("registers a supervisor job whose request records the requested child", async () => {
    const f = fixture();
    const reservation = await f.supervision.reserve({ child: { agentName: "worker", agentKind: "pi", candidateName: "worker-pi" } });
    const detail = f.jobs.get(reservation.jobId)!;
    expect(detail.kind).toBe("supervisor");
    expect(detail.request).toMatchObject({
      kind: "supervisor",
      label: "supervise worker",
      targets: ["worker"],
      // No pane exists at reservation time, so no target id is back-dated into the request.
      targetIds: [],
      child: { agentName: "worker", agentKind: "pi", candidateName: "worker-pi" },
      settings: { reviewerModel: "typesafe/jev-latest", reviewCadenceMinutes: 5 },
    });
    expect(detail.request.target_generation_refs?.[0]).toMatch(/^target_generation_/u);
    await f.supervision.shutdown();
  });

  it("accepts a supervision digest at reservation without changing the public request view", async () => {
    const f = fixture();
    const digest = { doneWhen: ["tests pass"], constraints: ["read-only"] };
    const reservation = await f.supervision.reserve({
      child: { agentName: "worker", agentKind: "pi", candidateName: "worker-pi" },
      settings: { supervisionDigest: digest },
    });
    const detail = f.jobs.get(reservation.jobId)!;
    // The digest is reservation-scoped evidence: the public request projection
    // keeps its allowlisted settings shape and never exposes it.
    expect(detail.request.settings).toEqual({
      reviewerModel: "typesafe/jev-latest",
      reviewCadenceMinutes: 5,
    });
    expect(detail.request.settings).not.toHaveProperty("supervisionDigest");
    await f.supervision.shutdown();
  });

  it("records the reservation digest on the job request as a typed field", async () => {
    const f = fixture();
    const register = vi.spyOn(f.jobs, "register");
    const digest = { doneWhen: ["tests pass"], constraints: ["read-only"] };
    await f.supervision.reserve({
      child: { agentName: "worker", agentKind: "pi", candidateName: "worker-pi" },
      settings: { supervisionDigest: digest },
    });
    const jobRequest = register.mock.calls[0]![0];
    if (jobRequest.kind !== "supervisor") throw new Error("expected a supervisor job request");
    // Type-visible: this access compiles only because the snapshot declares the field.
    expect(jobRequest.settings.supervisionDigest).toEqual(digest);
    await f.supervision.shutdown();
  });

  it("carries the reservation's Tier-0 policy facts on the private request, never the public view", async () => {
    const f = fixture();
    const register = vi.spyOn(f.jobs, "register");
    const forbiddenTools = [
      { agentKind: "claude", candidateName: "worker-opus", forbiddenTools: { available: true as const, tools: ["Write", "Bash"] } },
      { agentKind: "pi", candidateName: "worker-pi", forbiddenTools: { available: false as const, reason: "runner_lacks_disallowed_tools" as const } },
    ];
    const workspaceRoot = { available: true as const, root: "/repo" };
    const reservation = await f.supervision.reserve({
      child: { agentName: "worker", agentKind: "pi", candidateName: "worker-pi" },
      settings: {
        supervisionDigest: { doneWhen: ["tests pass"], constraints: ["read-only"], readOnly: true },
        forbiddenTools,
        workspaceRoot,
      },
    });
    const jobRequest = register.mock.calls[0]![0];
    if (jobRequest.kind !== "supervisor") throw new Error("expected a supervisor job request");
    // Typed private carriers: the digest keeps its authorial readOnly claim,
    // and the policy facts cross verbatim — no constraint prose is consulted.
    expect(jobRequest.settings.supervisionDigest).toEqual({ doneWhen: ["tests pass"], constraints: ["read-only"], readOnly: true });
    expect(jobRequest.settings.forbiddenTools).toEqual(forbiddenTools);
    expect(jobRequest.settings.workspaceRoot).toEqual(workspaceRoot);
    // The public projection keeps its allowlisted settings shape.
    const detail = f.jobs.get(reservation.jobId)!;
    expect(detail.request.settings).toEqual({
      reviewerModel: "typesafe/jev-latest",
      reviewCadenceMinutes: 5,
    });
    expect(detail.request.settings).not.toHaveProperty("forbiddenTools");
    expect(detail.request.settings).not.toHaveProperty("workspaceRoot");
    expect(detail.request.settings).not.toHaveProperty("supervisionDigest");
    await f.supervision.shutdown();
  });

  it("does not return a reservation until the workspace base is pinned", async () => {
    let releasePin!: () => void;
    const pinGate = new Promise<void>((resolve) => { releasePin = resolve; });
    let pinStarted = false;
    const f = fixture({
      workspaceRunner: async (argv) => {
        if (argv[1] === "rev-parse") {
          pinStarted = true;
          await pinGate;
          return { stdout: `${workspaceBaseSha}\n`, exitCode: 0 };
        }
        return { stdout: "", exitCode: 0 };
      },
    });
    let returned = false;
    const reserving = f.supervision.reserve({
      child: { agentName: "worker", agentKind: "pi", candidateName: "worker-pi" },
      settings: { workspaceRoot: { available: true, root: "/repo" } },
    });
    void reserving.then(() => { returned = true; });
    await vi.waitFor(() => expect(pinStarted).toBe(true));
    expect(returned).toBe(false);
    releasePin();
    await expect(reserving).resolves.toMatchObject({ jobId: expect.any(String) });
    expect(returned).toBe(true);
    await f.supervision.shutdown();
  });

  it("fails reservation with typed pin evidence and never re-anchors later", async () => {
    const runner = vi.fn<WorkspaceCommandRunner>(async () => {
      throw Object.assign(new Error("path-bearing failure must not escape"), { code: "ENOENT" });
    });
    const f = fixture({ workspaceRunner: runner });
    await expect(f.supervision.reserve({
      child: { agentName: "worker", agentKind: "pi", candidateName: "worker-pi" },
      settings: { workspaceRoot: { available: true, root: "/repo" } },
    })).rejects.toMatchObject({
      code: "SUPERVISION_WORKSPACE_BASE_UNAVAILABLE",
      details: { reason: "command_failed", command: "rev-parse", code: "ENOENT" },
    });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(f.jobs.size()).toBe(0);
    await f.supervision.shutdown();
  });

  it("types a pin refusal that has no command detail", async () => {
    const f = fixture();
    await expect(f.supervision.reserve({
      child: { agentName: "worker", agentKind: "pi", candidateName: "worker-pi" },
      settings: { workspaceRoot: { available: true, root: "relative" } },
    })).rejects.toMatchObject({
      code: "SUPERVISION_WORKSPACE_BASE_UNAVAILABLE",
      details: { reason: "root_invalid" },
    });
    expect(f.jobs.size()).toBe(0);
    await f.supervision.shutdown();
  });

  it("resolves the bound candidate's deny-list fact and degrades unmatched or ambiguous bindings", () => {
    const policies = [
      { agentKind: "claude", candidateName: "opus", forbiddenTools: { available: true as const, tools: ["Write"] } },
      { agentKind: "pi", candidateName: "pi-1", forbiddenTools: { available: false as const, reason: "runner_lacks_disallowed_tools" as const } },
      { agentKind: "claude", candidateName: "dup", forbiddenTools: { available: true as const, tools: ["Write"] } },
      { agentKind: "claude", candidateName: "dup", forbiddenTools: { available: true as const, tools: ["Bash"] } },
      { agentKind: "pi", candidateName: "same", forbiddenTools: { available: false as const, reason: "runner_lacks_disallowed_tools" as const } },
      { agentKind: "pi", candidateName: "same", forbiddenTools: { available: false as const, reason: "runner_lacks_disallowed_tools" as const } },
    ];
    expect(resolveForbiddenTools(policies, { agentKind: "claude", candidateName: "opus" })).toEqual({ available: true, tools: ["Write"] });
    expect(resolveForbiddenTools(policies, { agentKind: "pi", candidateName: "pi-1" })).toEqual({ available: false, reason: "runner_lacks_disallowed_tools" });
    // Identical duplicate chain entries resolve to their shared fact.
    expect(resolveForbiddenTools(policies, { agentKind: "pi", candidateName: "same" })).toEqual({ available: false, reason: "runner_lacks_disallowed_tools" });
    // A binding the reservation never compiled — or one that matches reserved
    // candidates with different facts — degrades rather than guessing.
    expect(resolveForbiddenTools(policies, { agentKind: "devin", candidateName: "swe" })).toEqual({ available: false, reason: "candidate_not_reserved" });
    expect(resolveForbiddenTools(policies, { agentKind: "claude", candidateName: "dup" })).toEqual({ available: false, reason: "candidate_ambiguous" });
    expect(resolveForbiddenTools(undefined, { agentKind: "pi", candidateName: "pi-1" })).toEqual({ available: false, reason: "candidate_not_reserved" });
  });

  it("publishes AGY provisional supervision and atomically strengthens it to exact coverage", async () => {
    const baseline = snapshotResult([agyPane()], [agyAgent()]);
    const exact = snapshotResult(
      [agyPane({ agent_session: agySession, agent_status: "working", revision: 3, state_change_seq: 5 })],
      [agyAgent({ agent_session: agySession, agent_status: "working", revision: 3, state_change_seq: 5 })],
    );
    const f = fixture({ snapshots: [baseline, baseline, exact] });
    const reservation = await f.supervision.reserve({ child: { agentName: "worker", agentKind: "agy", candidateName: "researcher-agy" } });
    await reservation.bindProvisional({ identity: agyIdentity, candidateName: "researcher-agy", baseline: { state: "idle", stateChangeSeq: 4, revision: 2 } });
    expect(f.jobs.get(reservation.jobId)).toMatchObject({
      operation_phase: "running",
      request: { targetIds: [], child: { agentKind: "agy", candidateName: "researcher-agy" } },
      supervision: { state: "provisional", provisional: { paneId: "p1", terminalId: "t1", baseline: { stateChangeSeq: 4, revision: 2 } } },
    });
    expect(f.jobs.activeSupervisorFor({ ...agySession, paneId: "p1", terminalId: "t1", agentName: "worker", agentKind: "agy", agentSession: agySession })).toBeUndefined();
    await expect(f.jobs.cancel(reservation.jobId)).rejects.toMatchObject({ code: "SUPERVISION_ACTIVE" });

    const exactIdentity: SupervisedIdentity = { ...agyIdentity, agentSession: agySession };
    await reservation.strengthen({ identity: exactIdentity, candidateName: "researcher-agy", stateChangeSeq: 5 });
    expect(f.jobs.get(reservation.jobId)).toMatchObject({
      operation_phase: "running",
      request: { targetIds: ["p1"], child: { agentKind: "agy", candidateName: "researcher-agy" } },
      supervision: { state: "active", child: { paneId: "p1", agentKind: "agy" }, status: "working" },
    });
    expect(f.jobs.activeSupervisorFor(exactIdentity)).toEqual({ jobId: reservation.jobId });
    await f.supervision.shutdown();
  });

  it("keeps the provisional recovery handle when strengthening evidence is rejected", async () => {
    const baseline = snapshotResult([agyPane()], [agyAgent()]);
    const replaced = snapshotResult([agyPane({ terminal_id: "t9", agent_status: "working", revision: 3, state_change_seq: 5 })], [agyAgent({ terminal_id: "t9", agent_status: "working", revision: 3, state_change_seq: 5 })]);
    const f = fixture({ snapshots: [baseline, baseline, replaced] });
    const reservation = await f.supervision.reserve({ child: { agentName: "worker", agentKind: "agy", candidateName: "researcher-agy" } });
    await reservation.bindProvisional({ identity: agyIdentity, candidateName: "researcher-agy", baseline: { state: "idle", stateChangeSeq: 4, revision: 2 } });
    await expect(reservation.strengthen({ identity: { ...agyIdentity, agentSession: agySession }, candidateName: "researcher-agy" })).rejects.toMatchObject({ code: "SUPERVISION_UNCONFIRMED", details: { cause: "identity_mismatch" } });
    expect(f.jobs.get(reservation.jobId)).toMatchObject({ operation_phase: "running", request: { targetIds: [] }, supervision: { state: "provisional" } });
    expect(f.jobs.activeSupervisorFor({ ...agyIdentity, agentSession: agySession })).toBeUndefined();
    await expect(f.jobs.cancel(reservation.jobId)).rejects.toMatchObject({ code: "SUPERVISION_ACTIVE" });
    await f.supervision.shutdown();
  });

  it("rolls back the request publication when AGY provisional evidence is rejected", async () => {
    const baseline = snapshotResult([agyPane()], [agyAgent()]);
    const f = fixture({ snapshots: [baseline] });
    const reservation = await f.supervision.reserve({ child: { agentName: "worker", agentKind: "agy", candidateName: "researcher-agy" } });
    await expect(reservation.bindProvisional({ identity: agyIdentity, candidateName: "researcher-agy", baseline: { state: "idle", stateChangeSeq: -1, revision: 2 } }))
      .rejects.toMatchObject({ code: "SUPERVISION_UNCONFIRMED", details: { cause: "provisional_baseline_invalid" } });
    expect(f.jobs.get(reservation.jobId)).toMatchObject({ request: { targetIds: [], child: { agentKind: "agy", candidateName: "researcher-agy" } } });
    await f.supervision.shutdown();
  });

  it("does not expose AGY provisional state through the exact binding path", async () => {
    const baseline = snapshotResult([agyPane()], [agyAgent()]);
    const f = fixture({ snapshots: [baseline, baseline] });
    const reservation = await f.supervision.reserve({ child: { agentName: "worker", agentKind: "agy", candidateName: "researcher-agy" } });
    await expect(reservation.bind({ identity: { ...agyIdentity, agentSession: agySession }, candidateName: "researcher-agy" })).rejects.toThrow(/STRENGTHENING_REQUIRED/u);
    await f.supervision.shutdown();
  });

  it("binds the managed handoff run to the exact launched identity through the shared gate", async () => {
    const gate = createHandoffGate();
    const f = fixture({ handoffs: gate });
    const allocation = await managedAllocation();
    const reservation = await f.supervision.reserve({ child: { agentName: "worker", agentKind: "pi", candidateName: "worker-pi" } });
    await reservation.bind({ identity, candidateName: "worker-pi", stateChangeSeq: 2, handoff: { allocation, agentId: "agent-1" } });
    // The gate bound the run before the child publication committed: the exact
    // identity is lookup-visible and persisted in the sidecar for recovery.
    expect(gate.lookup(identity)).toMatchObject({ runId: allocation.runId, lifecycle: "awaiting_handoff", artifactPath: allocation.artifactPath });
    const state = await readHandoffState(allocation);
    expect(state.child).toMatchObject({ paneId: "p1", terminalId: "t1", agentId: "agent-1" });
    expect(state.nativeSession).toEqual(session);
    expect(f.jobs.activeSupervisorFor(identity)).toEqual({ jobId: reservation.jobId });
    await f.supervision.shutdown();
  });

  it("refuses a managed binding on a host with no handoff gate", async () => {
    const f = fixture();
    const allocation = await managedAllocation();
    const reservation = await f.supervision.reserve({ child: { agentName: "worker", agentKind: "pi", candidateName: "worker-pi" } });
    await expect(reservation.bind({ identity, candidateName: "worker-pi", handoff: { allocation } }))
      .rejects.toMatchObject({ code: "SUPERVISION_UNCONFIRMED" });
    // The child publication rolled back: no exact coverage was ever published.
    expect(f.jobs.get(reservation.jobId)).toMatchObject({ request: { targetIds: [] } });
    expect(f.jobs.activeSupervisorFor(identity)).toBeUndefined();
    await f.supervision.shutdown();
  });

  it("binds, publishes a live view, and settles when the exact child goes away", async () => {
    const f = fixture({ snapshots: [snapshotResult([pane]), snapshotResult([pane]), snapshotResult([])] });
    const reservation = await f.supervision.reserve({ child: { agentName: "worker", agentKind: "pi", candidateName: "worker-pi" } });
    await reservation.bind({ identity, candidateName: "worker-pi", stateChangeSeq: 2 });
    expect(f.jobs.get(reservation.jobId)).toMatchObject({
      kind: "supervisor",
      request: { targets: ["worker"], targetIds: ["p1"], child: { agentKind: "pi", candidateName: "worker-pi" } },
      supervision: { state: "active", status: "working", child: { paneId: "p1" } },
    });
    expect(f.jobs.get(reservation.jobId)?.request.target_generation_refs).toHaveLength(1);
    expect(f.jobs.list(undefined, 0, 20, "supervisor").jobs[0]?.targetIds).toEqual(["p1"]);

    f.push(`${JSON.stringify({ event: "pane_closed", data: { type: "pane_closed", pane_id: "p1", workspace_id: "w1" } })}\n`);
    await vi_waitForSettled(f.jobs, reservation.jobId);
    expect(f.jobs.get(reservation.jobId)).toMatchObject({ operation_phase: "settled", supervision_result: "released", supervision_reason: "event:pane_closed" });
    expect(f.wakes.map((wake) => wake.event.type)).toEqual(["pane_closed"]);
    await f.supervision.shutdown();
  });

  it("finds coverage only for the complete exact live identity without observing receipts", async () => {
    const f = fixture({ snapshots: [snapshotResult([pane]), snapshotResult([pane]), snapshotResult([])] });
    const reservation = await f.supervision.reserve({ child: { agentName: "worker", agentKind: "pi", candidateName: "worker-pi" } });
    expect(f.jobs.activeSupervisorFor(identity)).toBeUndefined();
    await reservation.bind({ identity, candidateName: "worker-pi" });
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
    await f.supervision.shutdown();
  });

  it("rolls request target publication back when queued evidence settles during bind", async () => {
    const f = fixture({ snapshots: [snapshotResult([pane]), snapshotResult([pane]), snapshotResult([])] });
    const reservation = await f.supervision.reserve({ child: { agentName: "worker", agentKind: "pi", candidateName: "worker-pi" } });
    const binding = reservation.bind({ identity, candidateName: "worker-pi" });
    f.push(`${JSON.stringify({ event: "pane_closed", data: { type: "pane_closed", pane_id: "p1", workspace_id: "w1" } })}\n`);
    await expect(binding).rejects.toMatchObject({ code: "SUPERVISION_UNCONFIRMED", details: { cause: "settled_during_bind", settledDuringBind: true } });
    await vi_waitForSettled(f.jobs, reservation.jobId);
    expect(f.jobs.get(reservation.jobId)).toMatchObject({
      operation_phase: "settled",
      request: { targets: ["worker"], targetIds: [], child: { agentKind: "pi", candidateName: "worker-pi" } },
      supervision_result: "released",
    });
    await f.supervision.shutdown();
  });

  it("refuses herdr_jobs cancel while the exact child is live and allows it afterwards", async () => {
    const f = fixture({ snapshots: [snapshotResult([pane]), snapshotResult([pane]), snapshotResult([])] });
    const reservation = await f.supervision.reserve({ child: { agentName: "worker", agentKind: "pi", candidateName: "worker-pi" } });
    await reservation.bind({ identity, candidateName: "worker-pi" });
    const tool = createJobsTool(f.jobs);
    await expect(tool.execute("id", { operation: "cancel", jobId: reservation.jobId } as never, undefined, undefined, {} as never)).rejects.toBeInstanceOf(SupervisionActiveError);
    await expect(f.jobs.cancel(reservation.jobId)).rejects.toMatchObject({ code: "SUPERVISION_ACTIVE" });

    f.push(`${JSON.stringify({ event: "pane_closed", data: { type: "pane_closed", pane_id: "p1", workspace_id: "w1" } })}\n`);
    await vi_waitForSettled(f.jobs, reservation.jobId);
    await expect(f.jobs.cancel(reservation.jobId)).resolves.toMatchObject({ operation_phase: "settled" });
    await f.supervision.shutdown();
  });

  it("returns soft receipts through herdr_jobs get and counts them in list", async () => {
    const f = fixture({ snapshots: [snapshotResult([pane]), snapshotResult([pane])] });
    const reservation = await f.supervision.reserve({ child: { agentName: "worker", agentKind: "pi", candidateName: "worker-pi" } });
    await reservation.bind({ identity, candidateName: "worker-pi" });
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
    await f.supervision.shutdown();
  });

  it("settles a released reservation instead of leaking its job", async () => {
    const f = fixture();
    const reservation = await f.supervision.reserve({ child: { agentName: "worker", agentKind: "pi", candidateName: "worker-pi" } });
    reservation.release("launch_failed_placement");
    await vi_waitForSettled(f.jobs, reservation.jobId);
    expect(f.jobs.get(reservation.jobId)).toMatchObject({ supervision_result: "failed", supervision_reason: "launch_failed_placement" });
    await f.supervision.shutdown();
  });

  it("cancels every supervisor on manager-session shutdown", async () => {
    const f = fixture({ snapshots: [snapshotResult([pane]), snapshotResult([pane])] });
    const reservation = await f.supervision.reserve({ child: { agentName: "worker", agentKind: "pi", candidateName: "worker-pi" } });
    await reservation.bind({ identity, candidateName: "worker-pi" });
    await f.supervision.shutdown();
    await vi_waitForSettled(f.jobs, reservation.jobId);
    expect(f.jobs.get(reservation.jobId)).toMatchObject({ supervision_result: "cancelled", supervision_reason: "manager_session_shutdown" });
    await f.supervision.shutdown();
  });

  it("keeps a host with no Jev credential visibly degraded rather than silently unreviewed", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    const f = fixture();
    const reservation = await f.supervision.reserve({ child: { agentName: "worker", agentKind: "pi", candidateName: "worker-pi" } });
    expect(f.jobs.get(reservation.jobId)?.supervision?.reviewer).toMatchObject({ model: "typesafe/jev-latest", degraded: false });
    // The default reviewer is the shared Jev adapter; with no key anywhere it
    // fails closed through the typed authentication path.
    const registry = f.supervision as unknown as { reviewer(): Promise<SupervisionReviewer> };
    const reviewer = await registry.reviewer();
    expect(reviewer).toBeInstanceOf(TypeSafeSupervisionReviewer);
    // The mandatory evidence stub's contents are never read: the credential
    // check fails closed before the envelope is touched (ADR-036 V2-02).
    await expect(reviewer.review({ paneId: "p1", agentName: "worker", workingForMs: 0, metadata: { agentKind: "pi", status: "working", revision: 0 }, evidence: {} as EvidenceState }, new AbortController().signal))
      .rejects.toThrowError(ReviewerFailure);
    await f.supervision.shutdown();
  });

  it("refuses to reserve when the monitor cannot start", async () => {
    const jobs = new JobRegistry();
    const supervision = new SupervisionRegistry({
      jobs,
      settingsLoader: async () => settings,
      readTranscript: async () => [],
      monitorOptions: { env: {} },
    });
    await expect(supervision.reserve({ child: { agentName: "worker", agentKind: "pi", candidateName: "worker-pi" } })).rejects.toMatchObject({ code: "SUPERVISION_SOCKET_UNAVAILABLE" });
    expect(jobs.size()).toBe(0);
    await supervision.shutdown();
  });
});

describe("managed handoff runtime enforcement", () => {
  const writeArtifact = (allocation: HandoffAllocation, status = "done", summary = "Finished the work.") =>
    writeFile(allocation.artifactPath, `${allocation.marker}\n\n## Status\n${status}\n\n## Summary\n${summary}\n\n## Changes\n- src/a.ts\n\n## Verification\nnpm test passed.\n\n## Blockers\nNone\n\n## Continuation\nNone\n`, { mode: 0o600 });
  const paneUpdated = (revision: number, status: string) =>
    `${JSON.stringify({ event: "pane_updated", data: { type: "pane_updated", pane: { ...pane, agent_status: status, revision } } })}\n`;
  const paneClosed = `${JSON.stringify({ event: "pane_closed", data: { type: "pane_closed", pane_id: "p1", workspace_id: "w1" } })}\n`;
  const child = { agentName: "worker", agentKind: "pi", candidateName: "worker-pi" };

  async function waitForLifecycle(allocation: HandoffAllocation, state: string, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await readHandoffState(allocation)).lifecycle.state === state) return;
      if (Date.now() > deadline) throw new Error(`handoff lifecycle did not reach ${state}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  it("opens a fresh artifact cycle on an authoritative working transition", async () => {
    const gate = createHandoffGate();
    const f = fixture({ handoffs: gate });
    const allocation = await managedAllocation();
    const reservation = await f.supervision.reserve({ child });
    await reservation.bind({ identity, candidateName: "worker-pi", stateChangeSeq: 2, handoff: { allocation } });
    const run = gate.lookup(identity)!;
    await writeArtifact(allocation);
    f.push(paneUpdated(4, "done"));
    await waitForLifecycle(allocation, "handed_off");
    expect(run.cycleOpen).toBe(false);

    f.push(paneUpdated(5, "working"));
    await vi_waitFor(() => run.cycleOpen === true);
    // The previously accepted artifact version is stale in the new cycle.
    expect((await gate.validate(run)).state).toBe("stale");
    expect((await readHandoffState(allocation)).artifact.version).toBe(1);
    await f.supervision.shutdown();
  });

  it("keeps supervision active and sends exactly one fenced repair prompt per artifact version", async () => {
    const gate = createHandoffGate();
    const calls: Array<{ paneId: string; text: string }> = [];
    const f = fixture({ handoffs: gate, repairPrompt: async (paneId, text) => { calls.push({ paneId, text }); } });
    const allocation = await managedAllocation();
    const reservation = await f.supervision.reserve({ child });
    await reservation.bind({ identity, candidateName: "worker-pi", stateChangeSeq: 2, handoff: { allocation } });

    f.push(paneUpdated(4, "done"));
    await vi_waitFor(() => calls.length === 1);
    // The attempt and fence were persisted before the send, and the prompt
    // went to the exact child's current pane with the run's own contract.
    expect(calls[0]!.paneId).toBe("p1");
    expect(calls[0]!.text).toContain(allocation.artifactPath);
    expect(calls[0]!.text).toContain(allocation.marker);
    let state = await readHandoffState(allocation);
    expect(state.lifecycle.state).toBe("awaiting_handoff");
    expect(state.repair).toMatchObject({ attempts: 1, fence: { version: 0 } });
    expect(f.jobs.get(reservation.jobId)).toMatchObject({ operation_phase: "running" });

    // The same artifact version is never re-prompted: a second unmatched
    // terminal observation behind a new cycle finds the fence standing.
    f.push(paneUpdated(5, "working"));
    f.push(paneUpdated(6, "done"));
    await writeArtifact(allocation);
    f.push(paneUpdated(7, "working"));
    f.push(paneUpdated(8, "done"));
    await waitForLifecycle(allocation, "handed_off");
    expect(calls).toHaveLength(1);
    state = await readHandoffState(allocation);
    expect(state.repair.attempts).toBe(1);
    expect(f.jobs.get(reservation.jobId)).toMatchObject({ operation_phase: "running" });
    await f.supervision.shutdown();
  });

  it("never treats a failed repair prompt as evidence", async () => {
    const gate = createHandoffGate();
    const calls: string[] = [];
    const f = fixture({
      handoffs: gate,
      repairPrompt: async (_paneId, text) => { calls.push(text); throw new Error("send_failed"); },
    });
    const allocation = await managedAllocation();
    const reservation = await f.supervision.reserve({ child });
    await reservation.bind({ identity, candidateName: "worker-pi", stateChangeSeq: 2, handoff: { allocation } });

    f.push(paneUpdated(4, "done"));
    await vi_waitFor(() => calls.length === 1);
    // The send failed: the fence stands but nothing about the run resolved.
    let state = await readHandoffState(allocation);
    expect(state.lifecycle.state).toBe("awaiting_handoff");
    expect(state.repair.attempts).toBe(1);
    expect(f.jobs.get(reservation.jobId)).toMatchObject({ operation_phase: "running" });

    // A later valid artifact still hands the run off.
    f.push(paneUpdated(5, "working"));
    await writeArtifact(allocation);
    f.push(paneUpdated(6, "done"));
    await waitForLifecycle(allocation, "handed_off");
    state = await readHandoffState(allocation);
    expect(state.repair.attempts).toBe(1);
    expect(calls).toHaveLength(1);
    await f.supervision.shutdown();
  });

  it("does not prompt or fence for an initial terminal status at bind", async () => {
    const gate = createHandoffGate();
    const calls: string[] = [];
    const idlePane = { ...pane, agent_status: "idle" };
    const f = fixture({ handoffs: gate, snapshots: [snapshotResult([idlePane])], repairPrompt: async (_paneId, text) => { calls.push(text); } });
    const allocation = await managedAllocation();
    const reservation = await f.supervision.reserve({ child });
    await reservation.bind({ identity, candidateName: "worker-pi", stateChangeSeq: 2, handoff: { allocation } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toHaveLength(0);
    expect((await readHandoffState(allocation)).repair.attempts).toBe(0);
    expect((await readHandoffState(allocation)).lifecycle.state).toBe("awaiting_handoff");
    await f.supervision.shutdown();
  });

  it("persists the agent-authored handoff ahead of an exit settlement", async () => {
    const gate = createHandoffGate();
    const f = fixture({ handoffs: gate, snapshots: [snapshotResult([pane]), snapshotResult([pane]), snapshotResult([])] });
    const allocation = await managedAllocation();
    const reservation = await f.supervision.reserve({ child });
    await reservation.bind({ identity, candidateName: "worker-pi", stateChangeSeq: 2, handoff: { allocation } });
    // The artifact landed while the child was still working; the exit settle
    // validates it before any fallback may be authored.
    await writeArtifact(allocation);
    f.push(paneClosed);
    await vi_waitForSettled(f.jobs, reservation.jobId);
    expect(f.jobs.get(reservation.jobId)).toMatchObject({ supervision_result: "released" });
    expect((await readHandoffState(allocation)).lifecycle.state).toBe("handed_off");
    expect(gate.lookup(identity)).toBeUndefined();
    await f.supervision.shutdown();
  });

  it("persists the cancelled fallback only on an authoritative exit", async () => {
    const gate = createHandoffGate();
    const f = fixture({ handoffs: gate, snapshots: [snapshotResult([pane]), snapshotResult([pane]), snapshotResult([])] });
    const allocation = await managedAllocation();
    const reservation = await f.supervision.reserve({ child });
    await reservation.bind({ identity, candidateName: "worker-pi", stateChangeSeq: 2, handoff: { allocation } });
    f.push(paneClosed);
    await vi_waitForSettled(f.jobs, reservation.jobId);
    expect((await readHandoffState(allocation)).lifecycle).toMatchObject({ state: "cancelled", detail: "event:pane_closed" });
    await f.supervision.shutdown();
  });

  it("marks unresolved runs recovery_pending on shutdown and fabricates no terminal status", async () => {
    const gate = createHandoffGate();
    const f = fixture({ handoffs: gate });
    const allocation = await managedAllocation();
    const reservation = await f.supervision.reserve({ child });
    await reservation.bind({ identity, candidateName: "worker-pi", stateChangeSeq: 2, handoff: { allocation } });
    await f.supervision.shutdown();
    await vi_waitForSettled(f.jobs, reservation.jobId);
    // The job reports the supervisor's stop, but the durable run is only ever
    // recovery_pending: teardown authored no terminal outcome for it.
    expect(f.jobs.get(reservation.jobId)).toMatchObject({ supervision_result: "cancelled" });
    await waitForLifecycle(allocation, "recovery_pending");
    expect((await readHandoffState(allocation)).lifecycle.detail).toBe("manager_session_shutdown");
  });

  it("awaits the durable recovery_pending write before tearing supervisors down", async () => {
    const gate = createHandoffGate();
    const realShutdown = gate.shutdown;
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    let gateShutdownStarted = false;
    gate.shutdown = async () => {
      gateShutdownStarted = true;
      await blocker;
      await realShutdown();
    };
    const f = fixture({ handoffs: gate });
    const allocation = await managedAllocation();
    const reservation = await f.supervision.reserve({ child });
    await reservation.bind({ identity, candidateName: "worker-pi", stateChangeSeq: 2, handoff: { allocation } });

    const shutdown = f.supervision.shutdown();
    await vi_waitFor(() => gateShutdownStarted);
    // The durable write is still in flight: the supervisor is not torn down and
    // the sidecar is not yet marked — teardown strictly follows the write.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(f.jobs.get(reservation.jobId)).toMatchObject({ operation_phase: "running" });
    expect((await readHandoffState(allocation)).lifecycle.state).toBe("awaiting_handoff");

    release();
    await shutdown;
    expect((await readHandoffState(allocation)).lifecycle.state).toBe("recovery_pending");
    await vi_waitForSettled(f.jobs, reservation.jobId);
  });

  it("projects the bound run's bounded evidence on the supervisor job detail", async () => {
    const gate = createHandoffGate();
    const f = fixture({ handoffs: gate, snapshots: [snapshotResult([pane]), snapshotResult([pane]), snapshotResult([])] });
    const allocation = await managedAllocation();
    const reservation = await f.supervision.reserve({ child });
    await reservation.bind({ identity, candidateName: "worker-pi", stateChangeSeq: 2, handoff: { allocation } });

    let detail = f.jobs.get(reservation.jobId)!;
    expect(detail.handoff).toMatchObject({ gated: true, runId: allocation.runId, path: allocation.artifactPath, state: "awaiting_handoff" });

    // Settled on an authoritative exit: the run drops from the live gate, but
    // the job detail keeps the durable terminal evidence via the retained binding.
    f.push(paneClosed);
    await vi_waitForSettled(f.jobs, reservation.jobId);
    detail = f.jobs.get(reservation.jobId)!;
    expect(detail.handoff).toMatchObject({ gated: true, runId: allocation.runId, state: "cancelled" });
    const serialized = JSON.stringify(detail.handoff);
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain(allocation.marker);
    await f.supervision.shutdown();
  });

  it("reports the explicit ungated reason on supervisor job details", async () => {
    const gated = fixture({ handoffs: createHandoffGate() });
    const unbound = await gated.supervision.reserve({ child });
    await unbound.bind({ identity, candidateName: "worker-pi", stateChangeSeq: 2 });
    expect(gated.jobs.get(unbound.jobId)!.handoff).toEqual({ gated: false, reason: "no_managed_run" });
    await gated.supervision.shutdown();

    const gateless = fixture();
    const reservation = await gateless.supervision.reserve({ child });
    await reservation.bind({ identity, candidateName: "worker-pi", stateChangeSeq: 2 });
    expect(gateless.jobs.get(reservation.jobId)!.handoff).toEqual({ gated: false, reason: "gate_unavailable" });
    await gateless.supervision.shutdown();
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
