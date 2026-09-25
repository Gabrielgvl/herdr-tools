/**
 * The D4 restart reattach sweep + D5 owner-absence review pause (node N2.3).
 *
 * Proves the three restart branches — exact terminal+name+kind+session match
 * rebinds a supervisor, provable absence records `identity_lost` with the
 * sidecar untouched and no terminal state written, ambiguity leaves the run
 * `recovery_pending` with evidence — plus a prior-host `recovery_pending` run
 * re-matched and rebound, a multi-replica intent with mixed dispositions, one
 * `downtime_gap` per affected mailbox, and D5: reviews pause while the
 * recorded owner session is absent and resume when it reappears, while
 * lifecycle observation never stops.
 */

import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHandoffAllocator,
  HandoffError,
  readHandoffState,
  updateHandoffState,
  type HandoffAllocator,
  type HandoffAllocation,
  type HandoffNamespace,
  type HandoffProvenanceInput,
  type HandoffRunIdentity,
  type HandoffTaskContract,
} from "../../src/handoff.js";
import { createHandoffGate, type HandoffGate } from "../../src/handoff-gate.js";
import type { JobRegistry } from "../../src/job-registry.js";
import type { AgentSessionIdentity } from "../../src/messages/prompt.js";
import { createMailbox, type Mailbox, type MailboxEventWriter } from "../../src/daemon/mailbox.js";
import { createIntentStore, managerSessionKey, type IntentStore } from "../../src/daemon/intents.js";
import { reattachDaemonRuns, type ReattachDeps } from "../../src/daemon/reattach.js";
import type { DaemonNamespace } from "../../src/daemon/namespace.js";
import type { SupervisionBinding, SupervisorDependencies } from "../../src/supervision/supervisor.js";
import { Supervisor, type SupervisionScheduler } from "../../src/supervision/supervisor.js";
import type { SupervisionCoordinator, SupervisionReservation } from "../../src/supervision/registry.js";
import type { SupervisedIdentity } from "../../src/supervision/identity.js";
import type { SupervisionLogEntry } from "../../src/supervision/review-log.js";
import type { SupervisionReviewRequest } from "../../src/supervision/reviewer.js";
import { parseSocketLine, type SupervisionSocketEvent } from "../../src/supervision/protocol.js";
import { parseSnapshotResult, type HerdrSnapshot } from "../../src/targets.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
});

const ownerSession: AgentSessionIdentity = { source: "herdr", agent: "pi", kind: "pi", value: "owner-session-A" };
const ownerKey = managerSessionKey(ownerSession);
const childSession: AgentSessionIdentity = { source: "herdr:pi", agent: "pi", kind: "path", value: "/pi/child.jsonl" };
const siblingSession: AgentSessionIdentity = { source: "herdr:pi", agent: "pi", kind: "path", value: "/pi/sibling.jsonl" };

const task: HandoffTaskContract = {
  objective: "do the thing",
  scope: "repo",
  doneWhen: ["it works"],
  constraints: [],
  tier: "standard",
  replicas: 1,
};

const identityFields = (agentName: string): HandoffRunIdentity => ({
  manager: { paneId: "p-owner", display: "pi", source: "agent_name" },
  child: {
    agentName,
    agentKind: "pi",
    operatingPointId: "worker-pi",
    specLabel: "worker",
    fallbackCandidates: [],
    workspace: { resolvedCwd: "/project" },
  },
});

const provenance = (session: AgentSessionIdentity | null = ownerSession): HandoffProvenanceInput => ({ managerSession: session, task });

function artifactBody(runId: string): string {
  return [
    `herdr-run:${runId}`,
    "",
    "## Status",
    "done",
    "",
    "## Summary",
    "Completed the assignment end to end.",
    "",
    "## Changes",
    "- src/daemon/reattach.ts",
    "",
    "## Verification",
    "npx vitest run test/unit/daemon-reattach.test.ts",
    "",
    "## Blockers",
    "None.",
    "",
    "## Continuation",
    "None.",
  ].join("\n");
}

interface SeededRun {
  allocation: HandoffAllocation;
  runId: string;
}

/** Seed a fully-bound managed run: persisted contract + bound child identity + optional artifact/lifecycle. */
async function seedRun(
  allocator: HandoffAllocator,
  options: {
    name?: string;
    lifecycle?: "awaiting_handoff" | "recovery_pending" | "handed_off";
    session?: AgentSessionIdentity;
    paneId?: string;
    terminalId?: string;
    artifact?: boolean;
    owner?: AgentSessionIdentity | null;
  } = {},
): Promise<SeededRun> {
  const allocation = await allocator.allocate();
  const name = options.name ?? "worker";
  await allocator.persist(allocation, identityFields(name), provenance(options.owner));
  await updateHandoffState(allocation, (state) => {
    state.child.paneId = options.paneId ?? "p-child";
    state.child.terminalId = options.terminalId ?? "t1";
    state.child.agentId = "agent-1";
    state.nativeSession = { ...(options.session ?? childSession) };
    state.lifecycle.watermark = { stateChangeSeq: 4, revision: 2 };
    if (options.lifecycle !== undefined) state.lifecycle.state = options.lifecycle;
  });
  if (options.artifact === true) {
    const content = artifactBody(allocation.runId);
    await writeFile(allocation.artifactPath, content, { mode: 0o600 });
    const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
    await updateHandoffState(allocation, (state) => {
      state.artifact.sha256 = sha256;
      state.artifact.bytes = Buffer.byteLength(content);
      state.artifact.version = 1;
      state.artifact.status = "done";
    });
  }
  return { allocation, runId: allocation.runId };
}

function paneRecord(options: {
  paneId: string;
  terminalId: string;
  agentName?: string;
  agentKind?: string;
  status?: string;
  session?: Record<string, string> | null;
  revision?: number;
  stateChangeSeq?: number;
}): Record<string, unknown> {
  return {
    pane_id: options.paneId,
    terminal_id: options.terminalId,
    tab_id: "tab1",
    workspace_id: "w1",
    agent_status: options.status ?? "idle",
    revision: options.revision ?? 5,
    state_change_seq: options.stateChangeSeq ?? 5,
    agent: options.agentKind ?? "pi",
    agent_name: options.agentName ?? "worker",
    agent_session: options.session === undefined ? childSession : options.session,
  };
}

function agentRecord(options: { paneId: string; agentName?: string; agentKind?: string; session?: Record<string, string> | null; stateChangeSeq?: number }): Record<string, unknown> {
  return {
    pane_id: options.paneId,
    name: options.agentName ?? "worker",
    agent: options.agentKind ?? "pi",
    agent_session: options.session === undefined ? childSession : options.session,
    agent_status: "idle",
    revision: 5,
    state_change_seq: options.stateChangeSeq ?? 5,
  };
}

function snapshot(panes: Array<Record<string, unknown>>, agents: Array<Record<string, unknown>>): HerdrSnapshot {
  return parseSnapshotResult({ type: "session_snapshot", snapshot: { version: "0.8.2", protocol: 22, workspaces: [], tabs: [], panes, agents } });
}

function ownerPane(session: AgentSessionIdentity | null = ownerSession): Record<string, unknown> {
  return { pane_id: "p-owner", terminal_id: "t-owner", tab_id: "tab1", workspace_id: "w1", agent_status: "idle", revision: 1, agent: "pi", agent_name: "manager", agent_session: session };
}

function ownerAgent(session: AgentSessionIdentity | null = ownerSession): Record<string, unknown> {
  return { pane_id: "p-owner", name: "manager", agent: "pi", agent_session: session, agent_status: "idle", revision: 1 };
}

/** A snapshot holding only the owner pane — the recorded child is provably absent. */
function ownerOnlySnapshot(): HerdrSnapshot {
  return snapshot([ownerPane()], [ownerAgent()]);
}

/** A snapshot holding the exact child + optionally the owner pane/session. */
function liveSnapshot(options: { owner?: boolean; ownerSessionValue?: string | null } = {}): HerdrSnapshot {
  const panes: Array<Record<string, unknown>> = [paneRecord({ paneId: "p-child", terminalId: "t1" })];
  const agents: Array<Record<string, unknown>> = [agentRecord({ paneId: "p-child" })];
  if (options.owner === true) {
    const session = options.ownerSessionValue === null ? null : { ...ownerSession, value: options.ownerSessionValue ?? ownerSession.value };
    panes.push(ownerPane(session));
    agents.push(ownerAgent(session));
  }
  return snapshot(panes, agents);
}

interface FakeSupervision {
  coordinator: SupervisionCoordinator;
  reservations: Array<{ request: Parameters<SupervisionCoordinator["reserve"]>[0]; binding?: SupervisionBinding; released?: string }>;
}

function fakeSupervision(failBind: boolean | Error = false): FakeSupervision {
  const reservations: FakeSupervision["reservations"] = [];
  let n = 0;
  return {
    reservations,
    coordinator: {
      reserve: async (request) => {
        const record: FakeSupervision["reservations"][number] = { request };
        reservations.push(record);
        const jobId = `job_${++n}`;
        const reservation: SupervisionReservation = {
          jobId,
          bind: async (binding) => {
            if (failBind) throw typeof failBind === "boolean" ? new Error("bind refused") : failBind;
            record.binding = binding;
          },
          bindProvisional: async () => { throw new Error("unexpected"); },
          strengthen: async () => { throw new Error("unexpected"); },
          onCompletionSignal: () => undefined,
          release: (reason) => { record.released = reason; },
        };
        return reservation;
      },
    },
  };
}

async function fixture(options: { mailbox?: Mailbox } = {}): Promise<{
  handoffNs: HandoffNamespace;
  daemonNs: DaemonNamespace;
  projectRoot: string;
  allocator: HandoffAllocator;
  intents: IntentStore;
  mailbox: Mailbox;
}> {
  const root = await mkdtemp(join(tmpdir(), "herdr-reattach-"));
  dirs.push(root);
  const handoffNs: HandoffNamespace = { dir: join(root, "herdr-handoffs"), endpoint: join(root, "herdr.sock") };
  const daemonNs: DaemonNamespace = { dir: join(root, "herdr-tools-daemon"), endpoint: join(root, "daemon.sock") };
  const projectRoot = join(root, "project");
  await mkdir(handoffNs.dir, { recursive: true, mode: 0o700 });
  await mkdir(daemonNs.dir, { recursive: true, mode: 0o700 });
  await mkdir(projectRoot, { recursive: true, mode: 0o700 });
  const allocator = createHandoffAllocator({ namespace: handoffNs });
  const intents = createIntentStore({ namespace: daemonNs });
  const mailbox = options.mailbox ?? createMailbox({ namespace: daemonNs });
  return { handoffNs, daemonNs, projectRoot, allocator, intents, mailbox };
}

function deps(fx: Awaited<ReturnType<typeof fixture>>, over: Partial<ReattachDeps>): ReattachDeps {
  return {
    namespace: fx.daemonNs,
    runs: fx.handoffNs,
    allocator: fx.allocator,
    intents: fx.intents,
    supervision: fakeSupervision().coordinator,
    jobs: { activeSupervisorFor: () => undefined } as unknown as Pick<JobRegistry, "activeSupervisorFor">,
    mailbox: fx.mailbox,
    snapshot: async () => liveSnapshot({ owner: true }),
    startedAt: "2026-09-25T01:00:00.000Z",
    lastHeartbeat: "2026-09-25T00:59:00.000Z",
    ...over,
  };
}

describe("daemon restart reattach (D4)", () => {
  it("reattaches an exact match, revalidates the artifact, and emits one downtime_gap to the owner mailbox", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx.allocator, { artifact: true });
    const supervision = fakeSupervision();
    const begun = await fx.intents.begin({ managerSessionKey: ownerKey, idempotencyKey: "key-1", task: { objective: task.objective, scope: task.scope, doneWhen: task.doneWhen, constraints: task.constraints, tier: task.tier, replicas: 1 }, projectRoot: fx.projectRoot });
    if (begun.kind !== "launch") throw new Error("expected launch");
    await fx.intents.markEffecting(begun.intent);
    await fx.intents.recordChildren(begun.intent, [{ name: "worker", runId }]);
    await fx.intents.fail(begun.intent, { effectCertainty: "partial" });

    const report = await reattachDaemonRuns(deps(fx, { supervision: supervision.coordinator }));

    expect(report.runs).toEqual([
      expect.objectContaining({ runId, lifecycle: "awaiting_handoff", disposition: "bound" }),
    ]);
    const reservation = supervision.reservations[0]!;
    expect(reservation.binding?.identity).toMatchObject({ paneId: "p-child", terminalId: "t1", agentName: "worker", agentKind: "pi", agentSession: childSession });
    expect(reservation.binding?.handoff?.owner).toEqual({ paneId: "p-owner", session: ownerSession });
    // reviewLogRoot is the recorded verified project root — never the daemon's cwd.
    expect(reservation.request.settings?.reviewLogRoot).toBe(fx.projectRoot);
    expect(reservation.request.settings?.reviewLogRoot).not.toBe(process.cwd());
    expect(reservation.request.settings?.eventWriter).toBe(fx.mailbox);
    // The recovered run is rebound under the gate before the child binds.
    expect(reservation.binding?.handoff?.allocation.runId).toBe(runId);
    // The intent reconciled: every recorded child bound.
    const intent = await fx.intents.get(ownerKey, "key-1");
    expect(intent?.state).toBe("completed");
    expect(intent?.reconciled).toBe(true);
    expect(intent?.children[0]?.disposition).toBe("bound");
    // One downtime_gap, from the prior heartbeat to this start.
    expect(report.gaps).toEqual([expect.objectContaining({ managerSessionKey: ownerKey, persisted: true })]);
    const unread = await fx.mailbox.list(ownerKey);
    expect(unread).toHaveLength(1);
    const event = await fx.mailbox.read(ownerKey, unread[0]!);
    expect(event).toMatchObject({ kind: "downtime_gap", from: "2026-09-25T00:59:00.000Z", to: "2026-09-25T01:00:00.000Z", lost: {} });
  });

  it("records identity_lost for a provably absent child and writes no terminal state", async () => {
    const fx = await fixture();
    const { allocation, runId } = await seedRun(fx.allocator, { artifact: true });
    const begun = await fx.intents.begin({ managerSessionKey: ownerKey, idempotencyKey: "key-2", task: { ...task }, projectRoot: fx.projectRoot });
    if (begun.kind !== "launch") throw new Error("expected launch");
    await fx.intents.markEffecting(begun.intent);
    await fx.intents.recordChildren(begun.intent, [{ name: "worker", runId }]);
    await fx.intents.fail(begun.intent, { effectCertainty: "partial" });
    const before = JSON.stringify(await readHandoffState(allocation));

    // No pane on the recorded terminal and no recorded pane id: provably absent.
    const report = await reattachDaemonRuns(deps(fx, { snapshot: async () => ownerOnlySnapshot() }));
    expect(report.runs[0]).toMatchObject({ runId, disposition: "identity_lost" });
    // Sidecar preserved untouched — same serialized state, no terminal outcome.
    const after = await readHandoffState(allocation);
    expect(after.lifecycle.state).toBe("awaiting_handoff");
    expect(JSON.stringify(after)).toBe(before);
    const intent = await fx.intents.get(ownerKey, "key-2");
    expect(intent?.state).toBe("completed");
    expect(intent?.children[0]?.disposition).toBe("identity_lost");
    expect(report.gaps).toEqual([expect.objectContaining({ managerSessionKey: ownerKey })]);
  });

  it("keeps an ambiguous match recovery_pending with bounded evidence and binds nothing", async () => {
    const fx = await fixture();
    const { allocation, runId } = await seedRun(fx.allocator);
    const supervision = fakeSupervision();
    const ambiguous = snapshot(
      [paneRecord({ paneId: "p-child", terminalId: "t1" }), paneRecord({ paneId: "p-other", terminalId: "t1" })],
      [agentRecord({ paneId: "p-child" }), agentRecord({ paneId: "p-other" })],
    );
    const report = await reattachDaemonRuns(deps(fx, { supervision: supervision.coordinator, snapshot: async () => ambiguous }));
    expect(report.runs[0]).toMatchObject({ runId, disposition: "ambiguous", reason: "terminal_ambiguous:2" });
    expect(supervision.reservations).toHaveLength(0);
    const state = await readHandoffState(allocation);
    expect(state.lifecycle.state).toBe("recovery_pending");
    expect(state.lifecycle.detail).toBe("daemon_restart_ambiguous:terminal_ambiguous:2");
  });

  it("refuses a terminal/name/kind/session mismatch as ambiguous, never as a reattach", async () => {
    const fx = await fixture();
    await seedRun(fx.allocator, { session: childSession });
    const supervision = fakeSupervision();
    const renamed = snapshot(
      [paneRecord({ paneId: "p-child", terminalId: "t1", agentName: "stranger" }), paneRecord({ paneId: "p-owner", terminalId: "t-owner" })],
      [agentRecord({ paneId: "p-child", agentName: "stranger" }), agentRecord({ paneId: "p-owner", agentName: "manager" })],
    );
    const report = await reattachDaemonRuns(deps(fx, { supervision: supervision.coordinator, snapshot: async () => renamed }));
    expect(report.runs[0]?.disposition).toBe("ambiguous");
    expect(report.runs[0]?.reason).toBe("identity_changed");
    expect(supervision.reservations).toHaveLength(0);
  });

  it("re-matches and rebinds a run a prior host left recovery_pending", async () => {
    const fx = await fixture();
    const { allocation, runId } = await seedRun(fx.allocator, { lifecycle: "recovery_pending" });
    const supervision = fakeSupervision();
    const report = await reattachDaemonRuns(deps(fx, { supervision: supervision.coordinator }));
    expect(report.runs[0]).toMatchObject({ runId, lifecycle: "recovery_pending", disposition: "bound" });
    expect(supervision.reservations).toHaveLength(1);
    expect((await readHandoffState(allocation)).lifecycle.state).toBe("awaiting_handoff");
  });

  it("classifies every child of a multi-replica intent — a matched sibling never clears an absent one", async () => {
    const fx = await fixture();
    const one = await seedRun(fx.allocator, { name: "worker-a", terminalId: "ta", paneId: "pa", session: childSession });
    const two = await seedRun(fx.allocator, { name: "worker-b", terminalId: "tb", paneId: "pb", session: siblingSession });
    const begun = await fx.intents.begin({ managerSessionKey: ownerKey, idempotencyKey: "key-3", task: { ...task, replicas: 2 }, projectRoot: fx.projectRoot });
    if (begun.kind !== "launch") throw new Error("expected launch");
    await fx.intents.markEffecting(begun.intent);
    await fx.intents.recordChildren(begun.intent, [{ name: "worker-a", runId: one.runId }, { name: "worker-b", runId: two.runId }]);
    await fx.intents.fail(begun.intent, { effectCertainty: "partial" });

    const snap = snapshot(
      [paneRecord({ paneId: "pa", terminalId: "ta", agentName: "worker-a" }), paneRecord({ paneId: "p-owner", terminalId: "t-owner" })],
      [agentRecord({ paneId: "pa", agentName: "worker-a" }), agentRecord({ paneId: "p-owner", agentName: "manager" })],
    );
    const report = await reattachDaemonRuns(deps(fx, { snapshot: async () => snap }));
    const byRun = new Map(report.runs.map((run) => [run.runId, run]));
    expect(byRun.get(one.runId)?.disposition).toBe("bound");
    expect(byRun.get(two.runId)?.disposition).toBe("identity_lost");
    const intent = await fx.intents.get(ownerKey, "key-3");
    expect(intent?.state).toBe("completed");
    expect(intent?.children.map((child) => child.disposition)).toEqual(["bound", "identity_lost"]);
  });

  it("leaves an intent unresolved while any recorded child stays ambiguous", async () => {
    const fx = await fixture();
    const one = await seedRun(fx.allocator, { name: "worker-a", terminalId: "ta", paneId: "pa", session: childSession });
    const two = await seedRun(fx.allocator, { name: "worker-b", terminalId: "tb", paneId: "pb", session: siblingSession });
    const begun = await fx.intents.begin({ managerSessionKey: ownerKey, idempotencyKey: "key-4", task: { ...task, replicas: 2 }, projectRoot: fx.projectRoot });
    if (begun.kind !== "launch") throw new Error("expected launch");
    await fx.intents.markEffecting(begun.intent);
    await fx.intents.recordChildren(begun.intent, [{ name: "worker-a", runId: one.runId }, { name: "worker-b", runId: two.runId }]);
    await fx.intents.fail(begun.intent, { effectCertainty: "partial" });

    const snap = snapshot(
      [
        paneRecord({ paneId: "pa", terminalId: "ta", agentName: "worker-a" }),
        paneRecord({ paneId: "pb", terminalId: "tb", agentName: "worker-b", session: { ...siblingSession } }),
        paneRecord({ paneId: "pb2", terminalId: "tb", agentName: "worker-b", session: { ...siblingSession } }),
        paneRecord({ paneId: "p-owner", terminalId: "t-owner" }),
      ],
      [
        agentRecord({ paneId: "pa", agentName: "worker-a" }),
        agentRecord({ paneId: "pb", agentName: "worker-b", session: { ...siblingSession } }),
        agentRecord({ paneId: "pb2", agentName: "worker-b", session: { ...siblingSession } }),
        agentRecord({ paneId: "p-owner", agentName: "manager" }),
      ],
    );
    const report = await reattachDaemonRuns(deps(fx, { snapshot: async () => snap }));
    const byRun = new Map(report.runs.map((run) => [run.runId, run]));
    expect(byRun.get(one.runId)?.disposition).toBe("bound");
    expect(byRun.get(two.runId)?.disposition).toBe("ambiguous");
    const intent = await fx.intents.get(ownerKey, "key-4");
    expect(intent?.state).toBe("unresolved");
    expect(intent?.children.map((child) => child.disposition)).toEqual(["bound", "ambiguous"]);
  });

  it("refuses reattach when the recorded artifact digest no longer matches", async () => {
    const fx = await fixture();
    await seedRun(fx.allocator, { artifact: true });
    const supervision = fakeSupervision();
    // Tamper with the artifact after the digest was recorded.
    const run = (await readdir(fx.handoffNs.dir))[0]!;
    const artifactPath = join(fx.handoffNs.dir, run, "handoff.md");
    await writeFile(artifactPath, `${artifactBody(run)}\nextra`, { mode: 0o600 });
    const report = await reattachDaemonRuns(deps(fx, { supervision: supervision.coordinator }));
    expect(report.runs[0]?.disposition).toBe("unbound");
    expect(report.runs[0]?.reason).toBe("artifact_digest_mismatch");
    expect(supervision.reservations).toHaveLength(0);
    expect(report.gaps).toEqual([expect.objectContaining({ managerSessionKey: ownerKey })]);
  });

  it("refuses reattach when the last review record describes a different child", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx.allocator);
    const begun = await fx.intents.begin({ managerSessionKey: ownerKey, idempotencyKey: "key-5", task: { ...task }, projectRoot: fx.projectRoot });
    if (begun.kind !== "launch") throw new Error("expected launch");
    await fx.intents.markEffecting(begun.intent);
    await fx.intents.recordChildren(begun.intent, [{ name: "worker", runId }]);
    await fx.intents.fail(begun.intent, { effectCertainty: "partial" });
    const supervision = fakeSupervision();

    // The per-reservation review-log root is the intent's verified project root.
    const reviewRoot = join(fx.projectRoot, ".herdr", "supervision");
    await mkdir(reviewRoot, { recursive: true });
    const wrong = {
      type: "review", timestamp: "2026-09-25T00:00:00.000Z", jobId: "old-job", agentName: "worker", agentKind: "pi",
      atMs: 1, classification: "progress", attention: false, signals: null, evidenceSufficiency: null, reason: null,
      lastMeaningfulProgressAtMs: null, linesSinceLastReview: null, previousClassification: null,
      evidence: { paneId: "p-child", terminalId: "OTHER-TERMINAL", agentSession: childSession },
      provenance: null,
    };
    await writeFile(join(reviewRoot, "reviews.jsonl"), `${JSON.stringify(wrong)}\n`, { mode: 0o600 });

    const report = await reattachDaemonRuns(deps(fx, { supervision: supervision.coordinator }));
    expect(report.runs[0]?.disposition).toBe("unbound");
    expect(report.runs[0]?.reason).toBe("review_record_mismatch");
    expect(supervision.reservations).toHaveLength(0);
  });

  it("does not double-bind a child a live supervisor already covers", async () => {
    const fx = await fixture();
    await seedRun(fx.allocator);
    const supervision = fakeSupervision();
    const covered: SupervisedIdentity = { paneId: "p-child", terminalId: "t1", agentName: "worker", agentKind: "pi", agentSession: childSession };
    const jobs = { activeSupervisorFor: (identity: SupervisedIdentity) => (identity.terminalId === covered.terminalId ? { jobId: "job-live" } : undefined) } as unknown as Pick<JobRegistry, "activeSupervisorFor">;
    const report = await reattachDaemonRuns(deps(fx, { supervision: supervision.coordinator, jobs }));
    expect(report.runs[0]).toMatchObject({ disposition: "bound", jobId: "job-live" });
    expect(supervision.reservations).toHaveLength(0);
  });

  it("marks a bind failure with the HandoffError code, not the generic label", async () => {
    const fx = await fixture();
    await seedRun(fx.allocator, { artifact: true });
    const supervision = fakeSupervision(new HandoffError("HANDOFF_UNAVAILABLE", "reserved pane contested"));
    const report = await reattachDaemonRuns(deps(fx, { supervision: supervision.coordinator }));
    expect(report.runs[0]?.disposition).toBe("unbound");
    expect(report.runs[0]?.reason).toBe("HANDOFF_UNAVAILABLE");
    expect(supervision.reservations[0]?.released).toBe("reattach_bind_failed");
  });

  it("binds an ownerless run without recording or gapping an owner mailbox", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx.allocator, { artifact: true, owner: null });
    const supervision = fakeSupervision();
    const report = await reattachDaemonRuns(deps(fx, { supervision: supervision.coordinator }));
    expect(report.runs[0]).toMatchObject({ runId, disposition: "bound" });
    expect(report.runs[0]?.ownerKey).toBeUndefined();
    expect(report.gaps).toEqual([]);
  });

  it("rebinds a live-supervised run whose provenance file never landed", async () => {
    const fx = await fixture();
    const { allocation, runId } = await seedRun(fx.allocator);
    // A crash between allocate() and the provenance write leaves no file to
    // read — the sweep treats the run as ownerless rather than faulting.
    await rm(join(allocation.toolsDir, "provenance.json"));
    const jobs = { activeSupervisorFor: () => ({ jobId: "job-live" }) } as unknown as Pick<JobRegistry, "activeSupervisorFor">;
    const report = await reattachDaemonRuns(deps(fx, { jobs }));
    expect(report.runs[0]).toMatchObject({ runId, disposition: "bound", jobId: "job-live" });
    expect(report.runs[0]?.ownerKey).toBeUndefined();
    expect(report.gaps).toEqual([]);
  });

  it("marks an ownerless ambiguous run without touching any mailbox", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx.allocator, { owner: null });
    const ambiguous = snapshot(
      [paneRecord({ paneId: "p-child", terminalId: "t1" }), paneRecord({ paneId: "p-other", terminalId: "t1" })],
      [agentRecord({ paneId: "p-child" }), agentRecord({ paneId: "p-other" })],
    );
    const report = await reattachDaemonRuns(deps(fx, { snapshot: async () => ambiguous }));
    expect(report.runs[0]).toMatchObject({ runId, disposition: "ambiguous" });
    expect(report.gaps).toEqual([]);
  });

  it("bounds a foreign allocator fault as run_unreadable and keeps sweeping", async () => {
    const fx = await fixture();
    await seedRun(fx.allocator);
    // Every fs fault inside open/readHandoffState is already HandoffError; the
    // label exists for a foreign throw escaping the seam — e.g. an injected
    // allocator whose open rejects raw.
    const allocator = { ...fx.allocator, open: async () => { throw new Error("io-fault"); } } as unknown as HandoffAllocator;
    const report = await reattachDaemonRuns(deps(fx, { allocator }));
    expect(report.runs[0]).toMatchObject({ disposition: "unclassified", reason: "run_unreadable" });
  });

  it("keeps sweeping when an intent reconcile rejects with a non-Error", async () => {
    const fx = await fixture();
    // An unresolved intent with no recorded children reaches reconcile with an
    // empty disposition list; a foreign (non-Error) rejection must land in the
    // log, not escape the sweep.
    const begun = await fx.intents.begin({ managerSessionKey: ownerKey, idempotencyKey: "key-nx", task: { ...task }, projectRoot: fx.projectRoot });
    if (begun.kind !== "launch") throw new Error("expected launch");
    await fx.intents.markEffecting(begun.intent);
    await fx.intents.fail(begun.intent, { effectCertainty: "partial" });
    // A sibling still in-flight is listed but never reconciled — only
    // "unresolved" intents enter the sweep.
    const inflight = await fx.intents.begin({ managerSessionKey: ownerKey, idempotencyKey: "key-inflight", task: { ...task }, projectRoot: fx.projectRoot });
    if (inflight.kind !== "launch") throw new Error("expected launch");
    await fx.intents.markEffecting(inflight.intent);
    const lines: string[] = [];
    const intents = { ...fx.intents, reconcile: async () => Promise.reject("reconcile-nope") } as unknown as IntentStore;
    await reattachDaemonRuns(deps(fx, { intents, log: (line) => lines.push(line) }));
    expect(lines.some((line) => line.includes("reconcile-nope"))).toBe(true);
  });

  it("bounds a non-Error gap-write failure into the gap report", async () => {
    const fx = await fixture();
    await seedRun(fx.allocator, { artifact: true });
    const mailbox = { ...fx.mailbox, writeGapEvent: async () => Promise.reject("gap-nope") } as Mailbox;
    const report = await reattachDaemonRuns(deps(fx, { mailbox }));
    expect(report.gaps[0]).toMatchObject({ managerSessionKey: ownerKey, persisted: false, reason: "gap-nope" });
  });
});

describe("D5 owner-absence review pause", () => {
  function harness(options: {
    snapshots: Array<Promise<HerdrSnapshot> | HerdrSnapshot>;
    binding: SupervisionBinding;
    eventWriter?: MailboxEventWriter;
    handoffs?: HandoffGate;
  }) {
    const queue = [...options.snapshots];
    const wakes: unknown[] = [];
    const logged: SupervisionLogEntry[] = [];
    const written: Array<{ kind: string; runId: string; result?: unknown; error?: unknown }> = [];
    const reviewRequests: SupervisionReviewRequest[] = [];
    let timer: (() => void) | undefined;
    const scheduler: SupervisionScheduler = {
      setTimer: (callback) => { timer = callback; return "timer"; },
      clearTimer: () => { timer = undefined; },
    };
    const deps: SupervisorDependencies = {
      jobId: "job_d5",
      child: { agentName: "worker", agentKind: "pi", operatingPointId: "worker-pi" },
      monitor: {
        addObserver: () => undefined,
        removeObserver: () => undefined,
        snapshot: async () => {
          const next = queue.shift();
          if (next === undefined) throw new Error("no scripted snapshot");
          return await next;
        },
        generation: 1,
        isDegraded: () => false,
      },
      notifier: { wake: (wake) => { wakes.push(wake); } },
      reviewer: { review: async (request) => { reviewRequests.push(request); return { classification: "progress" as const, summary: "moving" }; } },
      reviewLog: async (entry) => { logged.push(entry); },
      cadenceMs: 300_000,
      clock: { now: () => 1_000 },
      scheduler,
      ...(options.handoffs === undefined ? {} : { handoffs: options.handoffs }),
      readTranscript: async () => ["line"],
      traceSource: {
        select: () => "tmux-fallback" as const,
        read: async () => ({ source: "tmux-fallback" as const, cursorFrom: undefined, cursorTo: undefined, events: [], byteCount: 0 }),
      },
      ...(options.eventWriter === undefined ? {} : {
        eventWriter: {
          writeRunEvent: async (input) => {
            try {
              const result = await options.eventWriter!.writeRunEvent(input);
              written.push({ kind: input.kind, runId: input.runId, result });
              return result;
            } catch (error) {
              written.push({ kind: input.kind, runId: input.runId, error });
              throw error;
            }
          },
        } satisfies MailboxEventWriter,
      }),
      idFactory: (() => { let id = 0; return () => `e${++id}`; })(),
      update: () => undefined,
    };
    return {
      supervisor: new Supervisor(deps),
      reviewRequests,
      written,
      fireTimer: () => timer?.(),
      timerArmed: () => timer !== undefined,
    };
  }

  function workingEvent(paneId = "p-child", status = "working", revision = 7, stateChangeSeq = 9): SupervisionSocketEvent {
    return parseSocketLine(JSON.stringify({
      event: "pane_updated",
      data: { type: "pane_updated", pane: { pane_id: paneId, terminal_id: "t1", tab_id: "tab1", workspace_id: "w1", agent_status: status, revision, state_change_seq: stateChangeSeq, agent: "pi", agent_name: "worker", agent_session: childSession } },
    })) as SupervisionSocketEvent;
  }

  it("pauses reviews while the recorded owner session is absent and resumes on reappearance — lifecycle events keep landing", async () => {
    const fx = await fixture();
    const { allocation } = await seedRun(fx.allocator);
    // The bound managed run's events persist to the owner mailbox while paused.
    const mailbox = createMailbox({ namespace: fx.daemonNs, ownership: { ownerOfRun: async () => ownerKey } });
    const gate = createHandoffGate();
    await gate.bind(allocation, { paneId: "p-child", terminalId: "t1", agentName: "worker", agentKind: "pi", agentSession: childSession, agentId: "agent-1" });
    // The sweep's bind carries the recorded owner; the snapshot at bind has no owner pane.
    const ownerAbsent = liveSnapshot({ owner: false });
    const ownerReturns = liveSnapshot({ owner: true });
    const binding: SupervisionBinding = {
      identity: { paneId: "p-child", terminalId: "t1", agentName: "worker", agentKind: "pi", agentSession: childSession },
      operatingPointId: "worker-pi",
      stateChangeSeq: 5,
      handoff: { allocation, owner: { paneId: "p-owner", session: ownerSession } },
    };
    const h = harness({ snapshots: [ownerAbsent], binding, handoffs: gate, eventWriter: mailbox });
    await h.supervisor.bind(binding);

    // Owner absent at bind: paused, cadence armed but no reviewer call.
    expect(h.supervisor.view().reviewer.paused).toBe(true);
    await h.supervisor.onEvent(workingEvent());
    expect(h.supervisor.view().status).toBe("working");
    expect(h.timerArmed()).toBe(true);
    await h.fireTimer();
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.reviewRequests).toHaveLength(0);
    expect(h.timerArmed()).toBe(true);

    // Lifecycle evidence still folds while paused: a second transition lands.
    await h.supervisor.onEvent(workingEvent("p-child", "blocked", 8, 10));
    expect(h.supervisor.view().status).toBe("blocked");
    expect(h.supervisor.view().transitions.at(-1)?.to).toBe("blocked");

    // And the emitted lifecycle events persisted to the owner mailbox (the
    // writer is fire-and-forget; wait for the durable write to land).
    await vi.waitFor(() => expect(h.written.some((entry) => entry.result !== undefined && (entry.result as { persisted: boolean }).persisted)).toBe(true));
    const unread = await mailbox.list(ownerKey);
    expect(unread.length).toBeGreaterThan(0);

    // The exact owner session reappears in the next authoritative snapshot.
    await h.supervisor.onReconciliationSnapshot(ownerReturns);
    await h.supervisor.onEvent(workingEvent("p-child", "working", 9, 11));
    expect(h.supervisor.view().reviewer.paused).toBeUndefined();
    await h.fireTimer();
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.reviewRequests).toHaveLength(1);
  });

  it("does not resume on a pane that merely reuses the owner's pane id under a different session", async () => {
    const fx = await fixture();
    const { allocation } = await seedRun(fx.allocator);
    const binding: SupervisionBinding = {
      identity: { paneId: "p-child", terminalId: "t1", agentName: "worker", agentKind: "pi", agentSession: childSession },
      operatingPointId: "worker-pi",
      stateChangeSeq: 5,
      handoff: { allocation, owner: { paneId: "p-owner", session: ownerSession } },
    };
    const h = harness({ snapshots: [liveSnapshot({ owner: false })], binding });
    await h.supervisor.bind(binding);
    await h.supervisor.onEvent(workingEvent());
    // Same pane id, different session → still absent.
    await h.supervisor.onReconciliationSnapshot(liveSnapshot({ owner: true, ownerSessionValue: "different-session" }));
    expect(h.supervisor.view().reviewer.paused).toBe(true);
    await h.fireTimer();
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.reviewRequests).toHaveLength(0);
  });
});

describe("daemon restart reattach — sweep edge cases", () => {
  it("marks a pane reoccupied by another terminal ambiguous, never a reattach", async () => {
    const fx = await fixture();
    await seedRun(fx.allocator);
    const report = await reattachDaemonRuns(deps(fx, {
      snapshot: async () => snapshot(
        [paneRecord({ paneId: "p-child", terminalId: "t-other" }), ownerPane()],
        [agentRecord({ paneId: "p-child" }), ownerAgent()],
      ),
    }));
    expect(report.runs[0]).toMatchObject({ disposition: "ambiguous", reason: "pane_occupied_by_other_terminal" });
  });

  it("marks a child whose live identity records cannot be trusted ambiguous", async () => {
    const fx = await fixture();
    await seedRun(fx.allocator);
    // The pane at the recorded terminal exists, but no agent record proves it.
    const report = await reattachDaemonRuns(deps(fx, {
      snapshot: async () => snapshot([paneRecord({ paneId: "p-child", terminalId: "t1" }), ownerPane()], [ownerAgent()]),
    }));
    expect(report.runs[0]).toMatchObject({ disposition: "ambiguous", reason: "identity_untrusted" });
  });

  it("fails closed on an untrusted recorded artifact and on review-log faults", async () => {
    const fx = await fixture();
    const { allocation } = await seedRun(fx.allocator, { artifact: true });
    await rm(allocation.artifactPath);
    const report = await reattachDaemonRuns(deps(fx, {}));
    expect(report.runs[0]).toMatchObject({ disposition: "unbound" });
    expect(report.runs[0]!.reason).toContain("artifact_untrusted");

    // Review-log root: no intent names this run, so the namespace dir is used.
    const logDir = join(fx.daemonNs.dir, ".herdr", "supervision");
    const logPath = join(logDir, "reviews.jsonl");
    const reportFor = async (runId: string) => {
      const sweep = await reattachDaemonRuns(deps(fx, {}));
      return sweep.runs.find((run) => run.runId === runId);
    };
    // A directory where the log belongs refuses closed.
    const { runId: secondRun } = await seedRun(fx.allocator);
    await mkdir(logDir, { recursive: true });
    await mkdir(logPath);
    expect(await reportFor(secondRun)).toMatchObject({ disposition: "unbound", reason: "review_log_untrusted" });
    await rm(logPath, { recursive: true });
    // An unreadable path (ENOTDIR via a file where the directory belongs) refuses the same.
    await rm(join(fx.daemonNs.dir, ".herdr"), { recursive: true });
    await writeFile(join(fx.daemonNs.dir, ".herdr"), "x", { mode: 0o600 });
    expect(await reportFor(secondRun)).toMatchObject({ disposition: "unbound", reason: "review_log_untrusted" });
    await rm(join(fx.daemonNs.dir, ".herdr"));
    // Malformed lines and non-record lines both fail closed.
    await mkdir(logDir, { recursive: true });
    await writeFile(logPath, "{bad json\n", { mode: 0o600 });
    expect(await reportFor(secondRun)).toMatchObject({ disposition: "unbound", reason: "review_log_malformed" });
    await writeFile(logPath, "[1,2]\n", { mode: 0o600 });
    expect(await reportFor(secondRun)).toMatchObject({ disposition: "unbound", reason: "review_log_malformed" });
    // A review record for a different child is no contradiction — the run binds.
    await writeFile(logPath, `${JSON.stringify({ type: "review", agentName: "other", agentKind: "pi", evidence: {} })}\n`, { mode: 0o600 });
    expect(await reportFor(secondRun)).toMatchObject({ disposition: "bound" });
    // A record that names this child but contradicts its identity refuses.
    await writeFile(logPath, `${JSON.stringify({ type: "review", agentName: "worker", agentKind: "pi", evidence: { terminalId: "t-different", agentSession: childSession } })}\n`, { mode: 0o600 });
    const fresh = await seedRun(fx.allocator);
    expect(await reportFor(fresh.runId)).toMatchObject({ disposition: "unbound", reason: "review_record_mismatch" });
    // And a matching record lets a later exact match bind.
    await writeFile(logPath, `${JSON.stringify({ type: "review", agentName: "worker", agentKind: "pi", evidence: { terminalId: "t1", agentSession: childSession } })}\n`, { mode: 0o600 });
    const last = await seedRun(fx.allocator);
    expect(await reportFor(last.runId)).toMatchObject({ disposition: "bound" });
  });

  it("releases the reservation and marks the run unbound when the supervisor bind fails", async () => {
    const fx = await fixture();
    await seedRun(fx.allocator);
    const supervision = fakeSupervision(true);
    const report = await reattachDaemonRuns(deps(fx, { supervision: supervision.coordinator }));
    expect(report.runs[0]).toMatchObject({ disposition: "unbound" });
    expect(report.runs[0]!.reason).toContain("bind_failed");
    expect(supervision.reservations[0]!.released).toBe("reattach_bind_failed");
  });

  it("survives a missing runs root, a non-directory root, stray entries, and unbound or ended runs", async () => {
    const fx = await fixture();
    // Missing root → an empty sweep, not a crash.
    const absent = await reattachDaemonRuns(deps(fx, { runs: { dir: join(fx.daemonNs.dir, "no-such-runs"), endpoint: "x" } }));
    expect(absent.runs).toEqual([]);
    // A root that is not a directory propagates the fs error.
    const fileRoot = join(fx.daemonNs.dir, "runs-file");
    await writeFile(fileRoot, "x", { mode: 0o600 });
    await expect(reattachDaemonRuns(deps(fx, { runs: { dir: fileRoot, endpoint: "x" } }))).rejects.toMatchObject({ code: "ENOTDIR" });
    // Stray non-run entries are skipped; an entry with no readable state is
    // recorded unreadable; non-reattachable and identity-unbound runs skip.
    await writeFile(join(fx.handoffNs.dir, "stray.txt"), "x");
    await mkdir(join(fx.handoffNs.dir, randomUUID()));
    const ended = await seedRun(fx.allocator, { lifecycle: "handed_off" });
    const unbound = await seedRun(fx.allocator);
    await updateHandoffState(unbound.allocation, (state) => { state.child.terminalId = null; state.nativeSession = null; });
    const report = await reattachDaemonRuns(deps(fx, { snapshot: async () => ownerOnlySnapshot() }));
    const byRun = new Map(report.runs.map((run) => [run.runId, run]));
    expect(byRun.get(ended.runId)).toMatchObject({ disposition: "skipped" });
    expect(byRun.get(unbound.runId)).toMatchObject({ disposition: "skipped", reason: "child_identity_unbound" });
    expect([...byRun.values()].some((run) => run.disposition === "unclassified")).toBe(true);
  });

  it("keeps an ambiguous run unclassified when the evidence write fails", async () => {
    const fx = await fixture();
    const { allocation } = await seedRun(fx.allocator);
    // Two panes on the recorded terminal → ambiguous → recovery_pending write.
    const dupA = paneRecord({ paneId: "p-a", terminalId: "t1" });
    const dupB = paneRecord({ paneId: "p-b", terminalId: "t1" });
    // The sidecar directory read-only fails the state write after the read passed.
    await chmod(allocation.toolsDir, 0o555);
    const report = await reattachDaemonRuns(deps(fx, {
      snapshot: async () => snapshot([dupA, dupB, ownerPane()], [agentRecord({ paneId: "p-a" }), agentRecord({ paneId: "p-b" }), ownerAgent()]),
    }));
    expect(report.runs[0]).toMatchObject({ disposition: "unclassified", reason: expect.any(String) });
    await chmod(allocation.toolsDir, 0o700);
  });

  it("never reconciles an intent whose recorded child is not in the sweep", async () => {
    const fx = await fixture();
    // A recorded child whose run directory is gone entirely: no classification
    // exists, so the intent stays unresolved rather than closing on the sibling.
    await seedRun(fx.allocator);
    const begun = await fx.intents.begin({ managerSessionKey: ownerKey, idempotencyKey: "key-1", task: { objective: task.objective, scope: task.scope, doneWhen: task.doneWhen, constraints: task.constraints, tier: task.tier, replicas: 1 }, projectRoot: fx.projectRoot });
    if (begun.kind !== "launch") throw new Error("expected launch");
    const effecting = await fx.intents.markEffecting(begun.intent);
    await fx.intents.recordChildren(effecting, [{ name: "ghost", runId: randomUUID() }, { name: "unseen" }]);
    await fx.intents.fail(effecting, { effectCertainty: "partial" });
    const report = await reattachDaemonRuns(deps(fx, { snapshot: async () => ownerOnlySnapshot() }));
    expect(report.runs[0]).toMatchObject({ disposition: "identity_lost" });
    const intent = await fx.intents.get(ownerKey, "key-1");
    expect(intent?.state).toBe("unresolved");
    expect(intent?.reconciled).not.toBe(true);
  });

  it("survives intent-store, gap-accounting, and gap-write failures during the sweep", async () => {
    const fx = await fixture();
    // Intents that cannot be listed are skipped — the sweep continues.
    await seedRun(fx.allocator);
    const broken = { ...fx.intents, listManagers: async () => { throw new Error("store down"); } } as typeof fx.intents;
    const report = await reattachDaemonRuns(deps(fx, { intents: broken, snapshot: async () => ownerOnlySnapshot() }));
    expect(report.runs[0]).toMatchObject({ disposition: "identity_lost" });
    // A failing reconcile is logged, never thrown into the sweep.
    const fx2 = await fixture();
    const seeded = await seedRun(fx2.allocator);
    const begun = await fx2.intents.begin({ managerSessionKey: ownerKey, idempotencyKey: "key-1", task: { objective: task.objective, scope: task.scope, doneWhen: task.doneWhen, constraints: task.constraints, tier: task.tier, replicas: 1 }, projectRoot: fx2.projectRoot });
    if (begun.kind !== "launch") throw new Error("expected launch");
    const effecting = await fx2.intents.markEffecting(begun.intent);
    await fx2.intents.recordChildren(effecting, [{ name: "worker", runId: seeded.runId }]);
    await fx2.intents.fail(effecting, { effectCertainty: "partial" });
    const failing = { ...fx2.intents, reconcile: async () => { throw new Error("reconcile down"); } } as unknown as typeof fx2.intents;
    const mailbox = { ...fx2.mailbox, degradation: async () => { throw new Error("degraded read"); }, writeGapEvent: async () => { throw new Error("gap write down"); } } as unknown as Mailbox;
    const log = vi.fn();
    const second = await reattachDaemonRuns(deps(fx2, { intents: failing, mailbox, snapshot: async () => ownerOnlySnapshot(), log }));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("reconcile failed"));
    // The gap write failure is recorded on the report, never thrown.
    expect(second.gaps[0]).toMatchObject({ managerSessionKey: ownerKey, persisted: false });
  });
});
