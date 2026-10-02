/**
 * The ADR-040 lane-retirement sweep (design B3, node B8).
 *
 * Proves the full proof chain — only a `handed_off` run whose exact child
 * stays continuously idle past the grace with an unchanged lifecycle counter
 * and detection-screen digest, carries the launch tokens, manages nothing
 * live, drains its own mailbox, and sits clear of the owner's topology is
 * closed under the pane write lock and the run flock — plus the dry-run kill
 * switch, the bounded focused deferral, close uncertainty retries, the
 * one-shot `lane_retired` event, and the ledger's replay/idempotency.
 *
 * The PR #62 review regressions (F1–F13) each pin a destructive path that
 * f0ae1ed admitted: stale pane scalars over a fresh agent record, a silent
 * screen, a `recorded` child launch, a reconciled absence claimed as a close,
 * an ownership transfer inside the lock window, unreadable keep provenance,
 * a dead lease, and the env knobs.
 */

import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tokenValue } from "../../src/agent-identity.js";
import type { CliTextResult, JsonEnvelope } from "../../src/cli.js";
import {
  createHandoffAllocator,
  HANDOFF_PROVENANCE_NAME,
  readHandoffProvenance,
  updateHandoffState,
  writeHandoffProvenance,
  type HandoffAllocation,
  type HandoffAllocator,
  type HandoffLifecycleState,
  type HandoffNamespace,
  type HandoffProvenanceInput,
  type HandoffRunIdentity,
  type HandoffTaskContract,
} from "../../src/handoff.js";
import type { JobRegistry } from "../../src/job-registry.js";
import type { AgentSessionIdentity } from "../../src/messages/prompt.js";
import { acquireFlockHolder, type PaneWriteGuard } from "../../src/pane-write-lock.js";
import { createSelfCloseTracker } from "../../src/supervision/self-close.js";
import { parseSnapshotResult, type HerdrSnapshot } from "../../src/targets.js";
import { createIntentStore, managerSessionKey, type IntentStore } from "../../src/daemon/intents.js";
import { createMailbox, type Mailbox } from "../../src/daemon/mailbox.js";
import type { DaemonNamespace } from "../../src/daemon/namespace.js";
import { daemonRunOwnership, OwnershipError } from "../../src/daemon/ownership.js";
import { createLaneRetirer, type LaneRetirerCli, type LaneRetirerDeps } from "../../src/daemon/retire.js";

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
const childKey = managerSessionKey(childSession);
const successorSession: AgentSessionIdentity = { source: "herdr", agent: "pi", kind: "pi", value: "successor-session" };

const task: HandoffTaskContract = {
  objective: "do the thing",
  scope: "repo",
  doneWhen: ["it works"],
  constraints: [],
  tier: "standard",
};

const GRACE_MS = 60_000;
const SCREEN_READ = ["pane", "read", "p-child", "--source", "detection", "--format", "text"];

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
    "- src/daemon/retire.ts",
    "",
    "## Verification",
    "npx vitest run test/unit/daemon-retire.test.ts",
    "",
    "## Blockers",
    "None.",
    "",
    "## Continuation",
    "None.",
  ].join("\n");
}

/** Seed a bound run, `handed_off` with a digested artifact unless overridden. */
async function seedRun(
  allocator: HandoffAllocator,
  options: {
    lifecycle?: HandoffLifecycleState;
    session?: AgentSessionIdentity;
    paneId?: string;
    terminalId?: string;
    task?: HandoffTaskContract;
    owner?: AgentSessionIdentity | null;
    provenance?: boolean;
    digest?: boolean;
    /** A cycle mark on the lifecycle detail. */
    detail?: string;
  } = {},
): Promise<{ allocation: HandoffAllocation; runId: string }> {
  const allocation = await allocator.allocate();
  const provenance: HandoffProvenanceInput = {
    managerSession: options.owner === undefined ? ownerSession : options.owner,
    task: options.task ?? task,
  };
  await allocator.persist(allocation, identityFields("worker"), options.provenance === false ? undefined : provenance);
  await updateHandoffState(allocation, (state) => {
    state.child.paneId = options.paneId ?? "p-child";
    state.child.terminalId = options.terminalId ?? "t1";
    state.child.agentId = "agent-1";
    state.nativeSession = { ...(options.session ?? childSession) };
    state.lifecycle.watermark = { stateChangeSeq: 4, revision: 2 };
    state.lifecycle.state = options.lifecycle ?? "handed_off";
    if (options.detail !== undefined) state.lifecycle.detail = options.detail;
  });
  const content = artifactBody(allocation.runId);
  await writeFile(allocation.artifactPath, content, { mode: 0o600 });
  if (options.digest !== false) {
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

/** Rewrite a run's provenance as v2 with `current` as the open owner entry. */
async function transferTo(allocation: HandoffAllocation, current: AgentSessionIdentity): Promise<void> {
  const prior = await readHandoffProvenance(allocation);
  await writeHandoffProvenance(allocation, {
    ...prior,
    v: 2,
    owners: [
      { session: ownerSession, from: prior.createdAt, to: "2026-10-01T00:00:00.000Z", reason: "transfer" },
      { session: current, from: "2026-10-01T00:00:00.000Z", to: null, reason: "transfer" },
    ],
  });
}

/** The launch tokens an accepted lane carries on both its records. */
function childTokens(session: AgentSessionIdentity = childSession, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { identity_provenance: "launched", identity_actor: "p-owner", identity_session: tokenValue(session.value), ...over };
}

type RawRecord = Record<string, unknown>;

function childPane(over: RawRecord = {}): RawRecord {
  return {
    pane_id: "p-child",
    terminal_id: "t1",
    tab_id: "tab-child",
    workspace_id: "w1",
    agent_status: "idle",
    revision: 5,
    state_change_seq: 5,
    agent: "pi",
    agent_name: "worker",
    agent_session: { ...childSession },
    tokens: childTokens(),
    ...over,
  };
}

function childAgent(over: RawRecord = {}): RawRecord {
  return {
    pane_id: "p-child",
    name: "worker",
    agent: "pi",
    terminal_id: "t1",
    agent_session: { ...childSession },
    agent_status: "idle",
    revision: 5,
    state_change_seq: 5,
    tokens: childTokens(),
    ...over,
  };
}

function ownerPane(over: RawRecord = {}): RawRecord {
  return { pane_id: "p-owner", terminal_id: "t-owner", tab_id: "tab-owner", workspace_id: "w1", agent_status: "idle", revision: 1, agent: "pi", agent_name: "manager", agent_session: { ...ownerSession }, ...over };
}

function ownerAgent(over: RawRecord = {}): RawRecord {
  return { pane_id: "p-owner", name: "manager", agent: "pi", agent_session: { ...ownerSession }, agent_status: "idle", revision: 1, ...over };
}

/** The live child records the sweep observes; empty `pane` means it is gone. `screen` is the detection-screen text. */
interface Live {
  pane?: RawRecord;
  agent?: RawRecord;
  screen?: string;
}

/** Two tabs in one workspace: the lane's own tab cascades, the owner's survives. `omitOwner` drops the owner records entirely. */
function snapshotFor(live: Live, extras: { panes?: RawRecord[]; agents?: RawRecord[]; tabs?: RawRecord[]; omitOwner?: boolean } = {}): HerdrSnapshot {
  const panes: RawRecord[] = [...(extras.omitOwner === true ? [] : [ownerPane()]), ...(extras.panes ?? [])];
  const agents: RawRecord[] = [...(extras.omitOwner === true ? [] : [ownerAgent()]), ...(extras.agents ?? [])];
  if (live.pane !== undefined) panes.push(live.pane);
  if (live.agent !== undefined) agents.push(live.agent);
  return parseSnapshotResult({
    type: "session_snapshot",
    snapshot: {
      version: "0.8.2",
      protocol: 22,
      workspaces: [{ workspace_id: "w1", label: "w" }],
      tabs: [
        ...(extras.omitOwner === true ? [] : [{ tab_id: "tab-owner", workspace_id: "w1", label: "owner" }]),
        { tab_id: "tab-child", workspace_id: "w1", label: "child" },
        ...(extras.tabs ?? []),
      ],
      panes,
      agents,
    },
  });
}

interface FakeCli extends LaneRetirerCli {
  calls: string[][];
}

interface FakeCliOptions {
  closeError?: unknown;
  getError?: unknown;
  getPane?: RawRecord;
  getAgent?: RawRecord;
  /** `pane read` throws. */
  readError?: unknown;
  /** `pane read` reports a truncated result. */
  readTruncated?: boolean;
  /** Runs inside the `pane close` dispatch, before the records clear. */
  onClose?: () => Promise<void>;
}

/**
 * A scripted Herdr CLI over the `live` records. `pane close` clears them (so
 * the readback proves absence) unless `closeError` throws first; `pane get` /
 * `agent get` serve the live records, or `getPane`/`getAgent` overrides when a
 * test needs the under-lock records to differ from the snapshot; `pane read`
 * serves `live.screen`. `opts` is read live, so a test can flip it mid-sweep.
 */
function fakeCli(live: Live, opts: FakeCliOptions = {}): FakeCli {
  const calls: string[][] = [];
  return {
    calls,
    async runJson(argv) {
      calls.push([...argv]);
      const [kind, verb, id] = argv;
      if (verb === "get" && opts.getError !== undefined) throw opts.getError;
      if (kind === "pane" && verb === "get") {
        const pane = opts.getPane ?? live.pane;
        if (pane === undefined || pane.pane_id !== id) throw Object.assign(new Error("pane gone"), { code: "TARGET_NOT_FOUND" });
        return { id: "op", result: { pane } } as JsonEnvelope;
      }
      if (kind === "agent" && verb === "get") {
        const agent = opts.getAgent ?? live.agent;
        if (agent === undefined) throw Object.assign(new Error("agent gone"), { code: "TARGET_NOT_FOUND" });
        return { id: "op", result: { agent } } as JsonEnvelope;
      }
      if (kind === "pane" && verb === "close") {
        await opts.onClose?.();
        if (opts.closeError !== undefined) throw opts.closeError;
        live.pane = undefined;
        live.agent = undefined;
        return { id: "op", result: { closed: id } } as JsonEnvelope;
      }
      throw Object.assign(new Error(`unexpected argv: ${argv.join(" ")}`), { code: "CLI_PROTOCOL_ERROR" });
    },
    async runTextResult(argv): Promise<CliTextResult> {
      calls.push([...argv]);
      if (argv[0] !== "pane" || argv[1] !== "read") throw Object.assign(new Error(`unexpected argv: ${argv.join(" ")}`), { code: "CLI_PROTOCOL_ERROR" });
      if (opts.readError !== undefined) throw opts.readError;
      if (live.pane === undefined) throw Object.assign(new Error("pane gone"), { code: "TARGET_NOT_FOUND" });
      return { value: live.screen ?? "worker> waiting for input", truncated: opts.readTruncated === true };
    },
  };
}

interface FakeLockOptions {
  fails?: boolean;
  releaseError?: unknown;
  /** `lease.check()` rejects — the flock holder died or the lock path lost trust. */
  checkError?: unknown;
  /** Runs inside `acquire`, after the lock is "taken" and before the lease returns — the transfer window. */
  onAcquire?: () => Promise<void>;
}

/** A pane write guard that needs no flock: acquisition and checks are counted, never contended unless told to fail. `opts` is read live. */
function fakePaneLock(opts: FakeLockOptions = {}): { guard: PaneWriteGuard; acquired: string[]; checks: string[] } {
  const acquired: string[] = [];
  const checks: string[] = [];
  return {
    acquired,
    checks,
    guard: {
      async acquire(paneId) {
        if (opts.fails === true) throw Object.assign(new Error("contended"), { code: "PANE_WRITE_LOCK_UNAVAILABLE" });
        acquired.push(paneId);
        await opts.onAcquire?.();
        return {
          check: async () => {
            checks.push(paneId);
            if (opts.checkError !== undefined) throw opts.checkError;
          },
          release: async () => {
            if (opts.releaseError !== undefined) throw opts.releaseError;
          },
          fence: { isSpent: async () => false, record: async () => undefined, rearm: async () => undefined },
        };
      },
    },
  };
}

interface Fx {
  handoffNs: HandoffNamespace;
  daemonNs: DaemonNamespace;
  allocator: HandoffAllocator;
  intents: IntentStore;
  mailbox: Mailbox;
  lines: string[];
}

async function fixture(): Promise<Fx> {
  const root = await mkdtemp(join(tmpdir(), "herdr-retire-"));
  dirs.push(root);
  const handoffNs: HandoffNamespace = { dir: join(root, "herdr-handoffs"), endpoint: join(root, "herdr.sock") };
  const daemonNs: DaemonNamespace = { dir: join(root, "herdr-tools-daemon"), endpoint: join(root, "daemon.sock") };
  await mkdir(handoffNs.dir, { recursive: true, mode: 0o700 });
  await mkdir(daemonNs.dir, { recursive: true, mode: 0o700 });
  const allocator = createHandoffAllocator({ namespace: handoffNs });
  const intents = createIntentStore({ namespace: daemonNs });
  const mailbox = createMailbox({ namespace: daemonNs, ownership: daemonRunOwnership(allocator) });
  return { handoffNs, daemonNs, allocator, intents, mailbox, lines: [] };
}

function retirerDeps(
  fx: Fx,
  live: Live,
  over: Partial<Omit<LaneRetirerDeps, "options">> & { options?: Partial<LaneRetirerDeps["options"]> } = {},
): { deps: LaneRetirerDeps; clock: { nowMs: number } } {
  const clock = { nowMs: 1_000_000 };
  const { options: optionOverrides, ...depsOverrides } = over;
  return {
    clock,
    deps: {
      runs: fx.handoffNs,
      allocator: fx.allocator,
      ownership: daemonRunOwnership(fx.allocator),
      intents: fx.intents,
      mailbox: fx.mailbox,
      cli: fakeCli(live),
      selfClose: createSelfCloseTracker(),
      jobs: { activeSupervisorFor: () => undefined } as unknown as Pick<JobRegistry, "activeSupervisorFor">,
      snapshot: async () => snapshotFor(live),
      options: { enabled: true, graceMs: GRACE_MS, paneLock: fakePaneLock().guard, ...optionOverrides },
      now: () => new Date(clock.nowMs),
      log: (line) => fx.lines.push(line),
      ...depsOverrides,
    },
  };
}

const closes = (deps: LaneRetirerDeps): string[][] => (deps.cli as FakeCli).calls.filter((argv) => argv[1] === "close");
/** Every CLI call past the per-sweep screen reads — the under-lock `get`s and the close. */
const lockedCalls = (deps: LaneRetirerDeps): string[][] => (deps.cli as FakeCli).calls.filter((argv) => argv[1] !== "read");

/** Seed `begin`+`markEffecting`+`recordChildren`+`complete` under the child's own session key. */
async function recordChildIntent(intents: IntentStore, idempotencyKey: string, children: Array<{ name: string; runId?: string }>): Promise<void> {
  const begun = await intents.begin({
    managerSessionKey: childKey,
    idempotencyKey,
    task: { objective: task.objective, scope: task.scope, doneWhen: task.doneWhen, constraints: task.constraints },
    projectRoot: "/project",
  });
  if (begun.kind !== "launch") throw new Error("expected launch");
  await intents.markEffecting(begun.intent);
  await intents.complete(begun.intent, children);
}

/** `begin` only: the intent stays `recorded` — the state a launch request executes under before `effecting`. */
async function recordedChildIntent(intents: IntentStore, idempotencyKey: string): Promise<void> {
  const begun = await intents.begin({
    managerSessionKey: childKey,
    idempotencyKey,
    task: { objective: task.objective, scope: task.scope, doneWhen: task.doneWhen, constraints: task.constraints },
    projectRoot: "/project",
  });
  if (begun.kind !== "launch") throw new Error("expected launch");
}

/** Sweep once at the clock, then once past the grace. */
async function sweepPastGrace(retirer: { sweep(): Promise<void> }, clock: { nowMs: number }): Promise<void> {
  await retirer.sweep();
  clock.nowMs += GRACE_MS;
  await retirer.sweep();
}

describe("lane retirer (ADR-040)", () => {
  it("closes a stable handed_off lane under the lock, confirms self-close, and writes exactly one lane_retired", async () => {
    const fx = await fixture();
    const { allocation, runId } = await seedRun(fx.allocator);
    const live: Live = { pane: childPane(), agent: childAgent() };
    const { deps, clock } = retirerDeps(fx, live);
    const retirer = createLaneRetirer(deps);

    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "watching", stableForMs: 0 });
    // The inactivity proof samples the detection screen every sweep.
    expect((deps.cli as FakeCli).calls).toContainEqual(SCREEN_READ);

    clock.nowMs += GRACE_MS;
    await retirer.sweep();

    expect(live.pane).toBeUndefined();
    expect(retirer.view(runId)).toMatchObject({ state: "retired" });
    expect(retirer.retiredByDaemon(runId)).toBe(true);
    // The own-close ledger carried the confirmed close: one claimable marker.
    expect(await deps.selfClose.consume("p-child")).toBe(true);
    expect(await deps.selfClose.consume("p-child")).toBe(false);
    // Exactly one lane_retired to the run's current owner, carrying the artifact.
    const unread = await fx.mailbox.list(ownerKey);
    expect(unread).toHaveLength(1);
    const event = await fx.mailbox.read(ownerKey, unread[0]!);
    expect(event).toMatchObject({
      kind: "lane_retired",
      runId,
      jobId: "daemon-retire",
      childIdentity: { agentName: "worker", agentKind: "pi", paneId: "p-child", terminalId: "t1" },
      handoff: { state: "handed_off", artifactSha256: expect.any(String) },
      actions: ["pane_closed:p-child", `artifact:${allocation.artifactPath}`],
    });
    // A repeated sweep replays nothing: the terminal view short-circuits.
    await retirer.sweep();
    expect(await fx.mailbox.list(ownerKey)).toHaveLength(1);
    expect(closes(deps)).toHaveLength(1);
    expect(fx.lines.filter((line) => line.includes(`run=${runId}`) && line.includes("decision=retired"))).toHaveLength(1);
  });

  it("reports the live supervisor's jobId and lands the event in a transferred run's successor mailbox", async () => {
    const fx = await fixture();
    const { allocation, runId } = await seedRun(fx.allocator);
    await transferTo(allocation, successorSession);
    const live: Live = { pane: childPane(), agent: childAgent() };
    const { deps, clock } = retirerDeps(fx, live, {
      jobs: { activeSupervisorFor: () => ({ jobId: "job_live" }) } as unknown as Pick<JobRegistry, "activeSupervisorFor">,
    });
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);

    expect(retirer.view(runId)).toMatchObject({ state: "retired" });
    const successorKey = managerSessionKey(successorSession);
    expect(await fx.mailbox.list(ownerKey)).toHaveLength(0);
    const unread = await fx.mailbox.list(successorKey);
    expect(unread).toHaveLength(1);
    expect(await fx.mailbox.read(successorKey, unread[0]!)).toMatchObject({ kind: "lane_retired", runId, jobId: "job_live" });
  });

  it("F14: the retired marker and the live supervisor jobId exist before the self-close waiter resolves", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx.allocator);
    const live: Live = { pane: childPane(), agent: childAgent() };
    const selfClose = createSelfCloseTracker();
    // The supervisor settles the instant its pending claim resolves — the
    // JobRegistry runner then skips the settled record, so a lookup after that
    // moment loses the jobId; its persistTerminalEvent reads the marker there too.
    let settled = false;
    let markerAtWake: boolean | undefined;
    let waiter: Promise<boolean> | undefined;
    const jobs = { activeSupervisorFor: () => (settled ? undefined : { jobId: "job_live" }) } as unknown as Pick<JobRegistry, "activeSupervisorFor">;
    const cli = fakeCli(live, {
      onClose: async () => {
        // Mid-close, the supervisor has observed the pane absent and claimed the
        // pending attempt; it is now waiting on the daemon's outcome.
        const claim = selfClose.consume("p-child");
        expect(claim).toBeInstanceOf(Promise);
        waiter = (claim as Promise<boolean>).then((suppress) => {
          markerAtWake = retirer.retiredByDaemon(runId);
          settled = true;
          return suppress;
        });
      },
    });
    const { deps, clock } = retirerDeps(fx, live, { cli, selfClose, jobs });
    // Declared after the closure that reads it; the closure only runs mid-close, once initialized.
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);

    expect(await waiter).toBe(true);
    expect(markerAtWake).toBe(true);
    expect(retirer.view(runId)).toMatchObject({ state: "retired" });
    const unread = await fx.mailbox.list(ownerKey);
    expect(unread).toHaveLength(1);
    expect(await fx.mailbox.read(ownerKey, unread[0]!)).toMatchObject({ kind: "lane_retired", runId, jobId: "job_live" });
  });

  it("refuses a handed_off run marked provider_limit or cycle_reopened, in the sweep and under the lock", async () => {
    const fx = await fixture();
    // The current cycle stalled on a typed provider limit: the manager decides.
    const limited = await seedRun(fx.allocator, { detail: "provider_limit" });
    // A follow-up cycle reopened the run after the acceptance: the accepted
    // artifact no longer describes the lane until a fresh acceptance clears it.
    const reopened = await seedRun(fx.allocator, { detail: "cycle_reopened", paneId: "p-child-2", terminalId: "t2", session: { ...childSession, value: "/pi/child-2.jsonl" } });
    const live: Live = { pane: childPane(), agent: childAgent() };
    const second: Live = {
      pane: childPane({ pane_id: "p-child-2", terminal_id: "t2", agent_session: { ...childSession, value: "/pi/child-2.jsonl" }, tokens: childTokens({ ...childSession, value: "/pi/child-2.jsonl" }) }),
      agent: childAgent({ pane_id: "p-child-2", terminal_id: "t2", agent_session: { ...childSession, value: "/pi/child-2.jsonl" }, tokens: childTokens({ ...childSession, value: "/pi/child-2.jsonl" }) }),
    };
    const { deps, clock } = retirerDeps(fx, live, { snapshot: async () => snapshotFor(live, { panes: second.pane === undefined ? [] : [second.pane], agents: second.agent === undefined ? [] : [second.agent] }) });
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(limited.runId)).toMatchObject({ state: "refused", reason: "provider_limit" });
    expect(retirer.view(reopened.runId)).toMatchObject({ state: "refused", reason: "cycle_reopened" });
    expect(closes(deps)).toEqual([]);
    // Each refusal journals once, not every sweep.
    await retirer.sweep();
    expect(fx.lines.filter((line) => line.includes("reason=provider_limit"))).toHaveLength(1);
    expect(fx.lines.filter((line) => line.includes("reason=cycle_reopened"))).toHaveLength(1);

    // A fresh acceptance clears the mark, and the lane retires on a later sweep.
    await updateHandoffState(limited.allocation, (state) => { delete state.lifecycle.detail; });
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(limited.runId)).toMatchObject({ state: "retired" });

    // The under-lock re-read refuses a mark that lands in the lock window.
    const late = await seedRun(fx.allocator, { paneId: "p-child-2", terminalId: "t2", session: { ...childSession, value: "/pi/child-2.jsonl" } });
    await updateHandoffState(reopened.allocation, (state) => { state.lifecycle.state = "cancelled"; });
    const lock = fakePaneLock({ onAcquire: async () => { await updateHandoffState(late.allocation, (state) => { state.lifecycle.detail = "cycle_reopened"; }); } });
    const lateDeps = retirerDeps(fx, second, { options: { paneLock: lock.guard } });
    const lateRetirer = createLaneRetirer(lateDeps.deps);
    await sweepPastGrace(lateRetirer, lateDeps.clock);
    expect(lateRetirer.view(late.runId)).toMatchObject({ state: "refused", reason: "recheck_cycle_reopened" });
    expect(closes(lateDeps.deps)).toEqual([]);
  });

  it("never retires a run whose lifecycle is not handed_off", async () => {
    const fx = await fixture();
    for (const lifecycle of ["awaiting_handoff", "recovery_pending", "cancelled", "failed"] as const) {
      const { runId } = await seedRun(fx.allocator, { lifecycle });
      const live: Live = { pane: childPane(), agent: childAgent() };
      const { deps, clock } = retirerDeps(fx, live);
      const retirer = createLaneRetirer(deps);
      await sweepPastGrace(retirer, clock);
      expect(retirer.view(runId)).toBeUndefined();
      expect(live.pane).not.toBeUndefined();
      expect(closes(deps)).toHaveLength(0);
    }
    expect(await fx.mailbox.list(ownerKey)).toHaveLength(0);
  });

  it("refuses a run whose sidecar is missing or malformed", async () => {
    const fx = await fixture();
    const { allocation, runId } = await seedRun(fx.allocator);
    await writeFile(allocation.statePath, "{not json", { mode: 0o600 });
    const live: Live = { pane: childPane(), agent: childAgent() };
    const { deps, clock } = retirerDeps(fx, live);
    const retirer = createLaneRetirer(deps);
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "refused", reason: expect.stringMatching(/^sidecar_/) });
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(live.pane).not.toBeUndefined();
    expect(fx.lines.some((line) => line.includes(`run=${runId}`) && line.includes("decision=refused"))).toBe(true);
  });

  it("refuses an unbound child identity and an unusable session key", async () => {
    const fx = await fixture();
    const unbound = await seedRun(fx.allocator);
    await updateHandoffState(unbound.allocation, (state) => {
      state.child.terminalId = null;
      state.nativeSession = null;
    });
    const malformed = await seedRun(fx.allocator);
    await updateHandoffState(malformed.allocation, (state) => {
      state.nativeSession = { source: "herdr:pi", agent: "pi", kind: "path", value: "bad\nvalue" };
    });
    const live: Live = { pane: childPane(), agent: childAgent() };
    const { deps, clock } = retirerDeps(fx, live);
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(unbound.runId)).toMatchObject({ state: "refused", reason: "child_identity_unbound" });
    expect(retirer.view(malformed.runId)).toMatchObject({ state: "refused", reason: "child_session_invalid" });
    expect(live.pane).not.toBeUndefined();
  });

  it("skips a provably absent child and defers an ambiguous one", async () => {
    const fx = await fixture();
    const absent = await seedRun(fx.allocator, { paneId: "p-absent", terminalId: "t-absent" });
    const ambiguous = await seedRun(fx.allocator);
    const live: Live = {};
    const { deps, clock } = retirerDeps(fx, live, {
      snapshot: async () => snapshotFor(live, {
        panes: [childPane(), childPane({ pane_id: "p-other" })],
        agents: [childAgent(), childAgent({ pane_id: "p-other" })],
      }),
    });
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    // Absent: no ledger entry at all — nothing to project or retire.
    expect(retirer.view(absent.runId)).toBeUndefined();
    // Two panes on the recorded terminal is ambiguity, never a close.
    expect(retirer.view(ambiguous.runId)).toMatchObject({ state: "deferred", reason: "child_terminal_ambiguous:2" });
    expect(fx.lines.some((line) => line.includes(`run=${absent.runId}`) && line.includes("decision=skipped reason=child_absent"))).toBe(true);
  });

  it("journals a skipped child_absent once per decision change, not once per sweep", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx.allocator);
    const live: Live = {};
    const { deps } = retirerDeps(fx, live);
    const retirer = createLaneRetirer(deps);
    const skips = () => fx.lines.filter((line) => line.includes(`run=${runId}`) && line.includes("decision=skipped reason=child_absent"));

    // A long-gone child is skipped on every sweep but journaled only once.
    await retirer.sweep();
    await retirer.sweep();
    await retirer.sweep();
    expect(retirer.view(runId)).toBeUndefined();
    expect(skips()).toHaveLength(1);

    // The pane reappears: a changed decision journals, and the renewed
    // absence journals the skip again — a change, never a repetition.
    live.pane = childPane();
    live.agent = childAgent();
    await retirer.sweep();
    expect(skips()).toHaveLength(1);
    expect(fx.lines.some((line) => line.includes(`run=${runId}`) && line.includes("decision=watching"))).toBe(true);
    live.pane = undefined;
    live.agent = undefined;
    await retirer.sweep();
    await retirer.sweep();
    expect(skips()).toHaveLength(2);
  });

  it("resets the stability clock on seq changes and on working status", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx.allocator);
    const live: Live = { pane: childPane(), agent: childAgent() };
    const { deps, clock } = retirerDeps(fx, live);
    const retirer = createLaneRetirer(deps);
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "watching" });

    // A seq bump inside the grace restarts the observation.
    live.pane = childPane({ state_change_seq: 6 });
    live.agent = childAgent({ state_change_seq: 6 });
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "watching", stableForMs: 0 });
    expect(live.pane).not.toBeUndefined();

    // A working status also resets — the lane must stay idle the whole grace.
    live.pane = childPane({ agent_status: "working", state_change_seq: 7 });
    live.agent = childAgent({ agent_status: "working", state_change_seq: 7 });
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "deferred", reason: "child_active:working" });
    live.pane = childPane({ state_change_seq: 8 });
    live.agent = childAgent({ state_change_seq: 8 });
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "watching", stableForMs: 0 });

    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "retired" });
  });

  it("defers while the agent record carries no usable state_change_seq or status, and reads the agent's counter when only the pane lacks one", async () => {
    // Both records lack the counter.
    const fx = await fixture();
    const { runId } = await seedRun(fx.allocator);
    const pane = childPane();
    const agent = childAgent();
    delete pane.state_change_seq;
    delete agent.state_change_seq;
    let live: Live = { pane, agent };
    let { deps, clock } = retirerDeps(fx, live);
    let retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "deferred", reason: "state_change_seq_unavailable" });
    expect(live.pane).not.toBeUndefined();

    // F2/F12: the pane's counter never stands in for a missing agent counter.
    const fx2 = await fixture();
    const paneOnly = await seedRun(fx2.allocator);
    const agentNoSeq = childAgent();
    delete agentNoSeq.state_change_seq;
    live = { pane: childPane(), agent: agentNoSeq };
    ({ deps, clock } = retirerDeps(fx2, live));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(paneOnly.runId)).toMatchObject({ state: "deferred", reason: "state_change_seq_unavailable" });
    expect(live.pane).not.toBeUndefined();

    // F2/F12: nor does the pane's status stand in for a missing agent status.
    const fx3 = await fixture();
    const noStatus = await seedRun(fx3.allocator);
    const agentNoStatus = childAgent();
    delete agentNoStatus.agent_status;
    live = { pane: childPane(), agent: agentNoStatus };
    ({ deps, clock } = retirerDeps(fx3, live));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(noStatus.runId)).toMatchObject({ state: "deferred", reason: "lifecycle_status_unavailable" });
    expect(live.pane).not.toBeUndefined();

    // The agent record is the authority: a pane without a counter is fine
    // while the agent record carries one.
    const fx4 = await fixture();
    const agentOnly = await seedRun(fx4.allocator);
    const paneNoSeq = childPane();
    delete paneNoSeq.state_change_seq;
    live = { pane: paneNoSeq, agent: childAgent() };
    ({ deps, clock } = retirerDeps(fx4, live));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(agentOnly.runId)).toMatchObject({ state: "retired" });
    expect(live.pane).toBeUndefined();
  });

  it("F2/F12: a stale idle pane record never outvotes a fresh working or advanced agent record in the sweep", async () => {
    const cases: Array<{ name: string; agent: RawRecord; reason: string }> = [
      { name: "pane idle/5, agent working/6", agent: childAgent({ agent_status: "working", state_change_seq: 6 }), reason: "lifecycle_target_identity_contradiction" },
      { name: "pane idle/5, agent idle/6 (agent-only seq bump)", agent: childAgent({ state_change_seq: 6 }), reason: "lifecycle_target_identity_contradiction" },
      { name: "pane idle/5, agent working/5", agent: childAgent({ agent_status: "working" }), reason: "lifecycle_target_identity_contradiction" },
      { name: "pane revision 5, agent revision 6", agent: childAgent({ revision: 6 }), reason: "lifecycle_target_identity_contradiction" },
      { name: "agent status malformed", agent: childAgent({ agent_status: "spinning" }), reason: "lifecycle_target_record_malformed" },
    ];
    for (const entry of cases) {
      const fx = await fixture();
      const { runId } = await seedRun(fx.allocator);
      const live: Live = { pane: childPane(), agent: entry.agent };
      const { deps, clock } = retirerDeps(fx, live);
      const retirer = createLaneRetirer(deps);
      await sweepPastGrace(retirer, clock);
      clock.nowMs += GRACE_MS;
      await retirer.sweep();
      expect(retirer.view(runId), entry.name).toMatchObject({ state: "deferred", reason: entry.reason });
      expect(live.pane, entry.name).not.toBeUndefined();
      expect(closes(deps), entry.name).toHaveLength(0);
    }
  });

  it("F2/F12: the under-lock re-proof rejects a fresh agent record that contradicts the pane, an agent-only counter bump, and vanished counters", async () => {
    const cases: Array<{ name: string; getPane?: RawRecord; getAgent?: RawRecord; reason: string }> = [
      { name: "agent working/6 under lock", getAgent: childAgent({ agent_status: "working", state_change_seq: 6 }), reason: "recheck_lifecycle_target_identity_contradiction" },
      { name: "agent-only seq bump under lock", getAgent: childAgent({ state_change_seq: 6 }), reason: "recheck_lifecycle_target_identity_contradiction" },
      { name: "agent status gone under lock", getAgent: (() => { const agent = childAgent(); delete agent.agent_status; return agent; })(), reason: "recheck_lifecycle_status_unavailable" },
      {
        name: "both counters gone under lock",
        getPane: (() => { const pane = childPane(); delete pane.state_change_seq; return pane; })(),
        getAgent: (() => { const agent = childAgent(); delete agent.state_change_seq; return agent; })(),
        reason: "recheck_state_change_seq_unavailable",
      },
      {
        name: "agent counter advanced while the pane carries none",
        getPane: (() => { const pane = childPane(); delete pane.state_change_seq; return pane; })(),
        getAgent: childAgent({ state_change_seq: 9 }),
        reason: "recheck_seq",
      },
    ];
    for (const entry of cases) {
      const fx = await fixture();
      const { runId } = await seedRun(fx.allocator);
      const live: Live = { pane: childPane(), agent: childAgent() };
      const { deps, clock } = retirerDeps(fx, live, {
        cli: fakeCli(live, { ...(entry.getPane === undefined ? {} : { getPane: entry.getPane }), ...(entry.getAgent === undefined ? {} : { getAgent: entry.getAgent }) }),
      });
      const retirer = createLaneRetirer(deps);
      await sweepPastGrace(retirer, clock);
      expect(retirer.view(runId), entry.name).toMatchObject({ state: "deferred", reason: entry.reason });
      expect(live.pane, entry.name).not.toBeUndefined();
      expect(closes(deps), entry.name).toHaveLength(0);
      // The clock restarted: the next observation is fresh, not stale.
      await retirer.sweep();
      expect(retirer.view(runId), entry.name).toMatchObject({ state: "watching", stableForMs: 0 });
    }
  });

  it("F1/F8: the detection-screen digest must stay unchanged through the grace — a change, a failed read, or a truncated read resets or defers", async () => {
    // A screen change inside the grace restarts the observation even though
    // status and seq never moved — the stale-telemetry case.
    const fx = await fixture();
    const { runId } = await seedRun(fx.allocator);
    const live: Live = { pane: childPane(), agent: childAgent(), screen: "worker> done" };
    let { deps, clock } = retirerDeps(fx, live);
    let retirer = createLaneRetirer(deps);
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "watching", stableForMs: 0 });
    live.screen = "worker> running tests...";
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "watching", stableForMs: 0 });
    expect(live.pane).not.toBeUndefined();
    expect(closes(deps)).toHaveLength(0);
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "retired" });

    // An unreadable screen is no proof: defer and hold the clock.
    const fx2 = await fixture();
    const unreadable = await seedRun(fx2.allocator);
    const live2: Live = { pane: childPane(), agent: childAgent() };
    ({ deps, clock } = retirerDeps(fx2, live2, { cli: fakeCli(live2, { readError: Object.assign(new Error("read failed"), { code: "CLI_PROTOCOL_ERROR" }) }) }));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(unreadable.runId)).toMatchObject({ state: "deferred", reason: "screen_unavailable" });
    expect(live2.pane).not.toBeUndefined();

    // A truncated screen was not fully observed — it cannot count as unchanged.
    const fx3 = await fixture();
    const truncated = await seedRun(fx3.allocator);
    const live3: Live = { pane: childPane(), agent: childAgent() };
    ({ deps, clock } = retirerDeps(fx3, live3, { cli: fakeCli(live3, { readTruncated: true }) }));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(truncated.runId)).toMatchObject({ state: "deferred", reason: "screen_truncated" });
    expect(live3.pane).not.toBeUndefined();
  });

  it("F1/F8: the screen digest is re-read under the lock — a change or an unreadable screen defers and restarts the clock", async () => {
    // The screen changes inside the lock window: the proof is void.
    const fx = await fixture();
    const { runId } = await seedRun(fx.allocator);
    const live: Live = { pane: childPane(), agent: childAgent(), screen: "worker> done" };
    const lock = fakePaneLock({ onAcquire: async () => { live.screen = "worker> one more thing"; } });
    let { deps, clock } = retirerDeps(fx, live, { options: { paneLock: lock.guard } });
    let retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "deferred", reason: "recheck_screen" });
    expect(live.pane).not.toBeUndefined();
    expect(closes(deps)).toHaveLength(0);
    // The digest changed, so the clock restarted from the new screen.
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "watching", stableForMs: 0 });

    // The under-lock read fails: defer, never dispatch.
    const fx2 = await fixture();
    const unreadable = await seedRun(fx2.allocator);
    const live2: Live = { pane: childPane(), agent: childAgent() };
    const cliOpts: FakeCliOptions = {};
    const lock2 = fakePaneLock({ onAcquire: async () => { cliOpts.readError = Object.assign(new Error("read failed"), { code: "CLI_PROTOCOL_ERROR" }); } });
    ({ deps, clock } = retirerDeps(fx2, live2, { cli: fakeCli(live2, cliOpts), options: { paneLock: lock2.guard } }));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(unreadable.runId)).toMatchObject({ state: "deferred", reason: "recheck_screen_unavailable" });
    expect(live2.pane).not.toBeUndefined();
    expect(closes(deps)).toHaveLength(0);
  });

  it("refuses on missing, adopted, malformed, contradictory, or mismatched launch tokens", async () => {
    const fx = await fixture();
    const cases: Array<{ name: string; pane: RawRecord; agent: RawRecord; reason: string }> = [
      {
        name: "absent provenance",
        pane: childPane({ tokens: { identity_actor: "p-owner", identity_session: tokenValue(childSession.value) } }),
        agent: childAgent({ tokens: { identity_actor: "p-owner", identity_session: tokenValue(childSession.value) } }),
        reason: "token_provenance_absent",
      },
      {
        name: "adopted provenance",
        pane: childPane({ tokens: childTokens(childSession, { identity_provenance: "adopted" }) }),
        agent: childAgent({ tokens: childTokens(childSession, { identity_provenance: "adopted" }) }),
        reason: "token_provenance_not_launched",
      },
      {
        name: "malformed tokens",
        pane: childPane({ tokens: "not-a-record" }),
        agent: childAgent(),
        reason: "token_provenance_malformed",
      },
      {
        name: "contradictory provenance",
        pane: childPane({ tokens: childTokens(childSession, { identity_provenance: "adopted" }) }),
        agent: childAgent(),
        reason: "token_provenance_contradictory",
      },
      {
        name: "absent session token",
        pane: childPane({ tokens: { identity_provenance: "launched", identity_actor: "p-owner" } }),
        agent: childAgent({ tokens: { identity_provenance: "launched", identity_actor: "p-owner" } }),
        reason: "token_session_absent",
      },
      {
        name: "mismatched session token",
        pane: childPane({ tokens: childTokens(childSession, { identity_session: "other-session" }) }),
        agent: childAgent({ tokens: childTokens(childSession, { identity_session: "other-session" }) }),
        reason: "token_session_mismatch",
      },
    ];
    for (const entry of cases) {
      const { runId } = await seedRun(fx.allocator);
      const live: Live = { pane: entry.pane, agent: entry.agent };
      const { deps, clock } = retirerDeps(fx, live);
      const retirer = createLaneRetirer(deps);
      await sweepPastGrace(retirer, clock);
      expect(retirer.view(runId), entry.name).toMatchObject({ state: "refused", reason: entry.reason });
      expect(live.pane).not.toBeUndefined();
    }
  });

  it("keeps a lane whose task retention or pane token says keep", async () => {
    const fx = await fixture();
    const keptByTask = await seedRun(fx.allocator, { task: { ...task, retention: "keep" } });
    const live: Live = { pane: childPane(), agent: childAgent() };
    const { deps, clock } = retirerDeps(fx, live);
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(keptByTask.runId)).toMatchObject({ state: "kept", reason: "task_retention_keep" });
    expect(live.pane).not.toBeUndefined();
    expect((deps.cli as FakeCli).calls).toHaveLength(0);
    // `kept` is terminal — later sweeps spend no effort on it.
    await retirer.sweep();
    expect((deps.cli as FakeCli).calls).toHaveLength(0);

    // The cooperative fallback: a `retention=keep` pane token parks the lane.
    const fx2 = await fixture();
    const keptByToken = await seedRun(fx2.allocator);
    const live2: Live = {
      pane: childPane({ tokens: childTokens(childSession, { retention: "keep" }) }),
      agent: childAgent({ tokens: childTokens(childSession, { retention: "keep" }) }),
    };
    const deps2 = retirerDeps(fx2, live2);
    const retirer2 = createLaneRetirer(deps2.deps);
    await sweepPastGrace(retirer2, deps2.clock);
    expect(retirer2.view(keptByToken.runId)).toMatchObject({ state: "kept", reason: "token_retention_keep" });
  });

  it("F15: clearing the retention pane token releases a token-kept lane, while a task-field keep stays kept", async () => {
    const fx = await fixture();
    const keptByTask = await seedRun(fx.allocator, { task: { ...task, retention: "keep" } });
    const keptByToken = await seedRun(fx.allocator);
    const live: Live = {
      pane: childPane({ tokens: childTokens(childSession, { retention: "keep" }) }),
      agent: childAgent({ tokens: childTokens(childSession, { retention: "keep" }) }),
    };
    const { deps, clock } = retirerDeps(fx, live);
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(keptByTask.runId)).toMatchObject({ state: "kept", reason: "task_retention_keep" });
    expect(retirer.view(keptByToken.runId)).toMatchObject({ state: "kept", reason: "token_retention_keep" });
    expect(closes(deps)).toHaveLength(0);

    // `herdr pane report-metadata <pane> --source owner-retention --clear-token retention`
    live.pane = childPane();
    live.agent = childAgent();
    // Clearing the token restarts the stability grace rather than retiring at once.
    await retirer.sweep();
    expect(retirer.view(keptByToken.runId)).toMatchObject({ state: "watching" });
    expect(live.pane).not.toBeUndefined();
    expect(closes(deps)).toHaveLength(0);
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(live.pane).toBeUndefined();
    expect(retirer.view(keptByToken.runId)).toMatchObject({ state: "retired" });
    expect(retirer.retiredByDaemon(keptByToken.runId)).toBe(true);
    expect(closes(deps)).toHaveLength(1);
    // The immutable task field is not released by a pane-token change.
    expect(retirer.view(keptByTask.runId)).toMatchObject({ state: "kept", reason: "task_retention_keep" });
    expect(retirer.retiredByDaemon(keptByTask.runId)).toBe(false);
  });

  it("F16: a token-kept lane accrues no grace across kept sweeps — clearing keep starts a full window", async () => {
    const fx = await fixture();
    const kept = await seedRun(fx.allocator);
    const live: Live = {
      pane: childPane({ tokens: childTokens(childSession, { retention: "keep" }) }),
      agent: childAgent({ tokens: childTokens(childSession, { retention: "keep" }) }),
    };
    const { deps, clock } = retirerDeps(fx, live);
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(kept.runId)).toMatchObject({ state: "kept", reason: "token_retention_keep" });
    // Still kept a sweep later: the keep is read before any clock work.
    clock.nowMs += 60_000;
    await retirer.sweep();
    expect(retirer.view(kept.runId)).toMatchObject({ state: "kept", reason: "token_retention_keep" });
    // Clear the token one full grace later: no grace accrued while kept.
    live.pane = childPane();
    live.agent = childAgent();
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(kept.runId)).toMatchObject({ state: "watching" });
    expect(live.pane).not.toBeUndefined();
    expect(closes(deps)).toHaveLength(0);
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(live.pane).toBeUndefined();
    expect(retirer.view(kept.runId)).toMatchObject({ state: "retired" });
  });

  it("F4: an unreadable provenance never overrides a keep opt-out — only a genuinely missing record is legacy", async () => {
    // Malformed provenance on a kept lane: refuse, never fall back to retire.
    const fx = await fixture();
    const kept = await seedRun(fx.allocator, { task: { ...task, retention: "keep" } });
    await writeFile(join(kept.allocation.toolsDir, HANDOFF_PROVENANCE_NAME), "{not json", { mode: 0o600 });
    let live: Live = { pane: childPane(), agent: childAgent() };
    let { deps, clock } = retirerDeps(fx, live);
    let retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(kept.runId)).toMatchObject({ state: "refused", reason: "provenance_unreadable" });
    expect(live.pane).not.toBeUndefined();
    expect((deps.cli as FakeCli).calls).toHaveLength(0);

    // An untrusted (group/world-writable) record refuses the same way.
    const fx2 = await fixture();
    const untrusted = await seedRun(fx2.allocator, { task: { ...task, retention: "keep" } });
    await chmod(join(untrusted.allocation.toolsDir, HANDOFF_PROVENANCE_NAME), 0o666);
    live = { pane: childPane(), agent: childAgent() };
    ({ deps, clock } = retirerDeps(fx2, live));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(untrusted.runId)).toMatchObject({ state: "refused", reason: "provenance_unreadable" });
    expect(live.pane).not.toBeUndefined();

    // A transferred run whose record became unreadable refuses rather than
    // protecting the original manager pane in the current owner's place.
    const fx3 = await fixture();
    const transferred = await seedRun(fx3.allocator);
    await transferTo(transferred.allocation, successorSession);
    await writeFile(join(transferred.allocation.toolsDir, HANDOFF_PROVENANCE_NAME), "{not json", { mode: 0o600 });
    live = { pane: childPane(), agent: childAgent() };
    ({ deps, clock } = retirerDeps(fx3, live));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(transferred.runId)).toMatchObject({ state: "refused", reason: "provenance_unreadable" });
    expect(live.pane).not.toBeUndefined();
  });

  it("refuses a pane other records name as their manager", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx.allocator);
    const live: Live = { pane: childPane(), agent: childAgent() };
    const { deps, clock } = retirerDeps(fx, live, {
      snapshot: async () => snapshotFor(live, {
        panes: [{ pane_id: "p-grandchild", terminal_id: "t-grand", tab_id: "tab-owner", workspace_id: "w1", agent_status: "idle", tokens: { identity_actor: "p-child" } }],
        agents: [{ pane_id: "p-grandchild", tokens: { identity_actor: "p-child" } }],
      }),
    });
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "refused", reason: "child_is_manager:manages_children" });
    expect(live.pane).not.toBeUndefined();
  });

  it("refuses a caller-policy failure and an open — effecting or merely recorded — intent ledger under the child's session", async () => {
    // Malformed scope evidence makes classification itself refuse.
    const fx = await fixture();
    const policyRun = await seedRun(fx.allocator);
    let live: Live = {
      pane: childPane({ tokens: childTokens(childSession, { identity_scope: { bad: true } }) }),
      agent: childAgent(),
    };
    let { deps, clock } = retirerDeps(fx, live);
    let retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(policyRun.runId)).toMatchObject({ state: "refused", reason: "caller_policy_unavailable" });

    // An `effecting` intent under the child's own session key refuses.
    const fx2 = await fixture();
    const openRun = await seedRun(fx2.allocator);
    const begun = await fx2.intents.begin({
      managerSessionKey: childKey,
      idempotencyKey: "sub-open",
      task: { objective: task.objective, scope: task.scope, doneWhen: task.doneWhen, constraints: task.constraints },
      projectRoot: "/project",
    });
    if (begun.kind !== "launch") throw new Error("expected launch");
    await fx2.intents.markEffecting(begun.intent);
    live = { pane: childPane(), agent: childAgent() };
    ({ deps, clock } = retirerDeps(fx2, live));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(openRun.runId)).toMatchObject({ state: "refused", reason: "child_intent_open" });

    // F5: a `recorded` intent — its launch request may be executing right
    // now, with no child token yet to mark the pane a manager — is open too.
    const fx3 = await fixture();
    const recordedRun = await seedRun(fx3.allocator);
    await recordedChildIntent(fx3.intents, "sub-recorded");
    live = { pane: childPane(), agent: childAgent() };
    ({ deps, clock } = retirerDeps(fx3, live));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(recordedRun.runId)).toMatchObject({ state: "refused", reason: "child_intent_open" });
    expect(live.pane).not.toBeUndefined();
    expect(closes(deps)).toHaveLength(0);
  });

  it("refuses a sub-manager with unproven or nonterminal recorded children, then retires once they settle", async () => {
    // A child runId with no readable sidecar is unproven — refuse.
    const fx = await fixture();
    const unproven = await seedRun(fx.allocator);
    await recordChildIntent(fx.intents, "sub-ghost", [{ name: "ghost", runId: "11111111-2222-4333-8444-555555555555" }]);
    let live: Live = { pane: childPane(), agent: childAgent() };
    let { deps, clock } = retirerDeps(fx, live);
    let retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(unproven.runId)).toMatchObject({ state: "refused", reason: "child_intent_child_untrusted" });

    // A recorded child whose sidecar is not yet terminal refuses the same way.
    const fx2 = await fixture();
    const managed = await seedRun(fx2.allocator);
    const liveChild = await seedRun(fx2.allocator, { lifecycle: "awaiting_handoff", paneId: "p-sub", terminalId: "t-sub" });
    await recordChildIntent(fx2.intents, "sub-live", [{ name: "sub", runId: liveChild.runId }, { name: "alias" }]);
    live = { pane: childPane(), agent: childAgent() };
    ({ deps, clock } = retirerDeps(fx2, live));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(managed.runId)).toMatchObject({ state: "refused", reason: "child_manages_live_intent" });

    // Settled recorded children stop refusing — the close proceeds.
    await updateHandoffState(liveChild.allocation, (state) => {
      state.lifecycle.state = "failed";
    });
    ({ deps, clock } = retirerDeps(fx2, live));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(managed.runId)).toMatchObject({ state: "retired" });
    expect(live.pane).toBeUndefined();
  });

  it("refuses while the child's own mailbox holds unread events", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx.allocator);
    await fx.mailbox.writeGapEvent(childKey, { from: "2026-10-01T00:00:00.000Z", to: "2026-10-01T01:00:00.000Z", lost: {} });
    const live: Live = { pane: childPane(), agent: childAgent() };
    const { deps, clock } = retirerDeps(fx, live);
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "refused", reason: "child_mailbox_unread" });
    expect(live.pane).not.toBeUndefined();
  });

  it("F13: reads the child's own ledger directly — the manager enumeration is never consulted — and defers when the ledger or the mailbox cannot be read", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx.allocator);
    const live: Live = { pane: childPane(), agent: childAgent() };

    // A broken manager enumeration is irrelevant: only the child's ledger is read.
    const listed: string[] = [];
    const noManagers: IntentStore = {
      ...fx.intents,
      listManagers: async () => { throw Object.assign(new Error("io"), { code: "INTENT_STORE_UNAVAILABLE" }); },
      list: async (key) => { listed.push(key); return fx.intents.list(key); },
    };
    let { deps, clock } = retirerDeps(fx, live, { intents: noManagers });
    let retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "retired" });
    expect(listed).toContain(childKey);

    // The child's own ledger read fails — defer.
    const fx2 = await fixture();
    const ledgerRun = await seedRun(fx2.allocator);
    const brokenLedger: IntentStore = {
      ...fx2.intents,
      list: async (key) => (key === childKey ? Promise.reject(Object.assign(new Error("io"), { code: "INTENT_STORE_UNAVAILABLE" })) : fx2.intents.list(key)),
    };
    const live2: Live = { pane: childPane(), agent: childAgent() };
    ({ deps, clock } = retirerDeps(fx2, live2, { intents: brokenLedger }));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(ledgerRun.runId)).toMatchObject({ state: "deferred", reason: "intents_unavailable" });
    expect(live2.pane).not.toBeUndefined();

    // A mailbox list failure also defers — proof gaps never close.
    const brokenMailbox: Pick<Mailbox, "writeRunEvent" | "list"> = {
      writeRunEvent: (input) => fx2.mailbox.writeRunEvent(input),
      list: async () => { throw Object.assign(new Error("io"), { code: "MAILBOX_UNAVAILABLE" }); },
    };
    ({ deps, clock } = retirerDeps(fx2, live2, { mailbox: brokenMailbox }));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(ledgerRun.runId)).toMatchObject({ state: "deferred", reason: "mailbox_unavailable" });
    expect(live2.pane).not.toBeUndefined();
  });

  it("refuses when the owner's pane sits inside the cascade and defers on invalid topology", async () => {
    // The recorded current owner IS the child pane — the cascade always reaches it.
    const fx = await fixture();
    const { allocation, runId } = await seedRun(fx.allocator);
    await transferTo(allocation, childSession);
    let live: Live = { pane: childPane(), agent: childAgent() };
    let { deps, clock } = retirerDeps(fx, live);
    let retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "refused", reason: "owner_topology_protected" });
    expect(live.pane).not.toBeUndefined();

    // A dangling parent — the child's tab has no record — is malformed topology.
    const fx2 = await fixture();
    const dangling = await seedRun(fx2.allocator);
    live = { pane: childPane({ tab_id: "tab-ghost" }), agent: childAgent() };
    ({ deps, clock } = retirerDeps(fx2, live));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(dangling.runId)).toMatchObject({ state: "deferred", reason: "topology_invalid" });
  });

  it("retires with no provenance record by falling back to the launch manager pane", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx.allocator, { provenance: false });
    const live: Live = { pane: childPane(), agent: childAgent() };
    const { deps, clock } = retirerDeps(fx, live);
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "retired" });
  });

  it("defers a focused pane only for the bounded count, then retires", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx.allocator);
    const live: Live = { pane: childPane({ focused: true }), agent: childAgent() };
    const { deps, clock } = retirerDeps(fx, live, { options: { maxFocusDefers: 2 } });
    const retirer = createLaneRetirer(deps);
    await retirer.sweep();
    for (let sweep = 0; sweep < 2; sweep += 1) {
      clock.nowMs += GRACE_MS;
      await retirer.sweep();
      expect(retirer.view(runId)).toMatchObject({ state: "deferred", reason: "focused" });
    }
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "retired" });
    expect(live.pane).toBeUndefined();
  });

  it("defers at close time when the under-lock pane is focused, drifted, or busy", async () => {
    // The snapshot records an unfocused idle pane; `pane get` reveals focused.
    const fx = await fixture();
    const focused = await seedRun(fx.allocator);
    let live: Live = { pane: childPane(), agent: childAgent() };
    let { deps, clock } = retirerDeps(fx, live, { cli: fakeCli(live, { getPane: childPane({ focused: true }) }) });
    let retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(focused.runId)).toMatchObject({ state: "deferred", reason: "recheck_focused" });
    expect(live.pane).not.toBeUndefined();

    // A session that drifted between the snapshot and the lock refuses the close.
    const fx2 = await fixture();
    const drifted = await seedRun(fx2.allocator);
    live = { pane: childPane(), agent: childAgent() };
    ({ deps, clock } = retirerDeps(fx2, live, {
      cli: fakeCli(live, { getAgent: childAgent({ agent_session: { ...childSession, value: "/pi/other.jsonl" } }) }),
    }));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(drifted.runId)).toMatchObject({ state: "deferred", reason: "recheck_identity" });

    // A coherent working tuple under the lock defers without spending an attempt.
    const fx3 = await fixture();
    const busy = await seedRun(fx3.allocator);
    const moved = await seedRun(fx3.allocator);
    live = { pane: childPane(), agent: childAgent() };
    ({ deps, clock } = retirerDeps(fx3, live, {
      cli: fakeCli(live, { getPane: childPane({ agent_status: "working", state_change_seq: 9 }), getAgent: childAgent({ agent_status: "working", state_change_seq: 9 }) }),
    }));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    // Status wins over the seq re-check — both refuse the same way.
    expect(retirer.view(busy.runId)).toMatchObject({ state: "deferred", reason: "recheck_status" });
    expect(retirer.view(moved.runId)).toMatchObject({ state: "deferred", reason: "recheck_status" });
  });

  it("re-proves the terminal identity and the stability seq under the lock", async () => {
    // Records that join cleanly but name a different terminal fail the field check.
    const fx = await fixture();
    const moved = await seedRun(fx.allocator);
    let live: Live = { pane: childPane(), agent: childAgent() };
    let { deps, clock } = retirerDeps(fx, live, {
      cli: fakeCli(live, { getPane: childPane({ terminal_id: "t2" }), getAgent: childAgent({ terminal_id: "t2" }) }),
    });
    let retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(moved.runId)).toMatchObject({ state: "deferred", reason: "recheck_identity" });
    expect(live.pane).not.toBeUndefined();

    // A coherent seq bump observed only under the lock restarts the stability clock.
    const fx2 = await fixture();
    const { runId } = await seedRun(fx2.allocator);
    live = { pane: childPane(), agent: childAgent() };
    ({ deps, clock } = retirerDeps(fx2, live, {
      cli: fakeCli(live, { getPane: childPane({ state_change_seq: 9 }), getAgent: childAgent({ state_change_seq: 9 }) }),
    }));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "deferred", reason: "recheck_seq" });
    expect(live.pane).not.toBeUndefined();
    // The clock restarted: the unchanged observation is fresh, not stale.
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "watching", stableForMs: 0 });
  });

  it("defers when the under-lock records drop the launch tokens", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx.allocator);
    const live: Live = { pane: childPane(), agent: childAgent() };
    const { deps, clock } = retirerDeps(fx, live, {
      cli: fakeCli(live, {
        getPane: childPane({ tokens: { identity_actor: "p-owner" } }),
        getAgent: childAgent({ tokens: { identity_actor: "p-owner" } }),
      }),
    });
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "deferred", reason: "recheck_tokens" });
    expect(live.pane).not.toBeUndefined();

    // The provenance token survives but the session token is gone — the
    // second under-lock token gate refuses the same way.
    const fx2 = await fixture();
    const dropped = await seedRun(fx2.allocator);
    const live2: Live = { pane: childPane(), agent: childAgent() };
    const deps2 = retirerDeps(fx2, live2, {
      cli: fakeCli(live2, {
        getPane: childPane({ tokens: { identity_provenance: "launched", identity_actor: "p-owner" } }),
        getAgent: childAgent({ tokens: { identity_provenance: "launched", identity_actor: "p-owner" } }),
      }),
    });
    const retirer2 = createLaneRetirer(deps2.deps);
    await sweepPastGrace(retirer2, deps2.clock);
    expect(retirer2.view(dropped.runId)).toMatchObject({ state: "deferred", reason: "recheck_tokens" });
  });

  it("F3: re-resolves the owner, the child's mailbox, and the child's intents under the locks — a transfer inside the lock window refuses the close", async () => {
    // The owner transfers the run to its own child between approval and the
    // lock: the fresh provenance makes the child the current owner, and the
    // topology re-validation refuses exactly as a pre-sweep transfer would.
    const fx = await fixture();
    const transferred = await seedRun(fx.allocator);
    let live: Live = { pane: childPane(), agent: childAgent() };
    let lock = fakePaneLock({ onAcquire: () => transferTo(transferred.allocation, childSession) });
    let { deps, clock } = retirerDeps(fx, live, { options: { paneLock: lock.guard } });
    let retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(transferred.runId)).toMatchObject({ state: "refused", reason: "recheck_owner_topology_protected" });
    expect(live.pane).not.toBeUndefined();
    expect(closes(deps)).toHaveLength(0);

    // An event landing in the child's mailbox inside the window refuses.
    const fx2 = await fixture();
    const mailed = await seedRun(fx2.allocator);
    live = { pane: childPane(), agent: childAgent() };
    lock = fakePaneLock({ onAcquire: async () => { await fx2.mailbox.writeGapEvent(childKey, { from: "2026-10-01T00:00:00.000Z", to: "2026-10-01T01:00:00.000Z", lost: {} }); } });
    ({ deps, clock } = retirerDeps(fx2, live, { options: { paneLock: lock.guard } }));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(mailed.runId)).toMatchObject({ state: "refused", reason: "recheck_child_mailbox_unread" });
    expect(live.pane).not.toBeUndefined();
    expect(closes(deps)).toHaveLength(0);

    // A launch intent recorded under the child's key inside the window refuses.
    const fx3 = await fixture();
    const launching = await seedRun(fx3.allocator);
    live = { pane: childPane(), agent: childAgent() };
    lock = fakePaneLock({ onAcquire: () => recordedChildIntent(fx3.intents, "sub-late") });
    ({ deps, clock } = retirerDeps(fx3, live, { options: { paneLock: lock.guard } }));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(launching.runId)).toMatchObject({ state: "refused", reason: "recheck_child_intent_open" });
    expect(live.pane).not.toBeUndefined();
    expect(closes(deps)).toHaveLength(0);
  });

  it("F3: holds the run flock across the re-proof and the close dispatch, defers without an attempt when it cannot be taken, and keeps a proven close through a release fault", async () => {
    // The close dispatch runs while the run's native flock is held: a
    // concurrent transfer (which takes the same flock) cannot interleave.
    const fx = await fixture();
    const { allocation, runId } = await seedRun(fx.allocator);
    const live: Live = { pane: childPane(), agent: childAgent() };
    const probe = async (): Promise<boolean> => {
      try {
        const holder = await acquireFlockHolder({ lockPath: allocation.lockPath, wait: "nonblock", readyMarker: "HERDR_RETIRE_TEST_PROBE", subject: "Probe", failure: (message) => new Error(message) });
        await holder.release();
        return false;
      } catch {
        return true;
      }
    };
    let heldDuringClose: boolean | undefined;
    const cli = fakeCli(live, { onClose: async () => { heldDuringClose = await probe(); } });
    let { deps, clock } = retirerDeps(fx, live, { cli });
    let retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "retired" });
    expect(heldDuringClose).toBe(true);
    // Released afterwards — the lane_retired write took the same flock and landed.
    expect(await probe()).toBe(false);
    expect(await fx.mailbox.list(ownerKey)).toHaveLength(1);

    // An unacquirable run flock defers before any under-lock read and spends
    // no attempt: the first real close failure afterwards is still a retry.
    const fx2 = await fixture();
    const contended = await seedRun(fx2.allocator);
    const live2: Live = { pane: childPane(), agent: childAgent() };
    const real = daemonRunOwnership(fx2.allocator);
    const gate = { fail: true };
    const flaky: LaneRetirerDeps["ownership"] = {
      withRunFlock: (id, section) => (gate.fail ? Promise.reject(new OwnershipError("OWNERSHIP_UNAVAILABLE")) : real.withRunFlock(id, section)),
    };
    const cliOpts: FakeCliOptions = { closeError: Object.assign(new Error("socket dropped"), { code: "CLI_UNAVAILABLE" }) };
    ({ deps, clock } = retirerDeps(fx2, live2, { ownership: flaky, cli: fakeCli(live2, cliOpts), options: { maxAttempts: 2 } }));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(contended.runId)).toMatchObject({ state: "deferred", reason: "run_lock_unavailable" });
    expect(lockedCalls(deps)).toHaveLength(0);
    gate.fail = false;
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(contended.runId)).toMatchObject({ state: "deferred", reason: "close_MUTATION_UNCERTAIN" });
    expect(closes(deps)).toHaveLength(1);

    // A release fault after the section ran cannot recall a proven close:
    // the recorded outcome stands and the event is written.
    const fx3 = await fixture();
    const faulting = await seedRun(fx3.allocator);
    const live3: Live = { pane: childPane(), agent: childAgent() };
    const real3 = daemonRunOwnership(fx3.allocator);
    const leaky: LaneRetirerDeps["ownership"] = {
      withRunFlock: async (id, section) => {
        await real3.withRunFlock(id, section);
        throw new OwnershipError("OWNERSHIP_UNAVAILABLE");
      },
    };
    ({ deps, clock } = retirerDeps(fx3, live3, { ownership: leaky }));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(faulting.runId)).toMatchObject({ state: "retired" });
    expect(retirer.retiredByDaemon(faulting.runId)).toBe(true);
    expect(await fx3.mailbox.list(ownerKey)).toHaveLength(1);
  });

  it("F3: re-reads the sidecar and the provenance under the locks — a released or unreadable run, an unreadable record, or a late keep never closes", async () => {
    // The run left `handed_off` inside the window.
    const fx = await fixture();
    const released = await seedRun(fx.allocator);
    let live: Live = { pane: childPane(), agent: childAgent() };
    let lock = fakePaneLock({ onAcquire: async () => { await updateHandoffState(released.allocation, (state) => { state.lifecycle.state = "cancelled"; }); } });
    let { deps, clock } = retirerDeps(fx, live, { options: { paneLock: lock.guard } });
    let retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(released.runId)).toMatchObject({ state: "deferred", reason: "recheck_lifecycle" });
    expect(live.pane).not.toBeUndefined();
    expect(lockedCalls(deps)).toHaveLength(0);

    // The sidecar became unreadable inside the window.
    const fx2 = await fixture();
    const broken = await seedRun(fx2.allocator);
    live = { pane: childPane(), agent: childAgent() };
    lock = fakePaneLock({ onAcquire: () => writeFile(broken.allocation.statePath, "{not json", { mode: 0o600 }) });
    ({ deps, clock } = retirerDeps(fx2, live, { options: { paneLock: lock.guard } }));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(broken.runId)).toMatchObject({ state: "deferred", reason: "recheck_sidecar" });
    expect(live.pane).not.toBeUndefined();

    // The provenance became unreadable inside the window.
    const fx3 = await fixture();
    const corrupted = await seedRun(fx3.allocator);
    live = { pane: childPane(), agent: childAgent() };
    lock = fakePaneLock({ onAcquire: () => writeFile(join(corrupted.allocation.toolsDir, HANDOFF_PROVENANCE_NAME), "{not json", { mode: 0o600 }) });
    ({ deps, clock } = retirerDeps(fx3, live, { options: { paneLock: lock.guard } }));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(corrupted.runId)).toMatchObject({ state: "deferred", reason: "recheck_provenance_unreadable" });
    expect(live.pane).not.toBeUndefined();
    expect(closes(deps)).toHaveLength(0);

    // A keep that appears under the lock — in the task contract or as a pane
    // token — parks the lane instead of closing it.
    const fx4 = await fixture();
    const lateKeep = await seedRun(fx4.allocator);
    live = { pane: childPane(), agent: childAgent() };
    lock = fakePaneLock({ onAcquire: async () => {
      const prior = await readHandoffProvenance(lateKeep.allocation);
      await writeHandoffProvenance(lateKeep.allocation, { ...prior, v: 2, owners: [{ session: ownerSession, from: prior.createdAt, to: null, reason: "launch" }], task: { ...prior.task, retention: "keep" } });
    } });
    ({ deps, clock } = retirerDeps(fx4, live, { options: { paneLock: lock.guard } }));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(lateKeep.runId)).toMatchObject({ state: "kept", reason: "task_retention_keep" });
    expect(live.pane).not.toBeUndefined();

    const fx5 = await fixture();
    const tokenKeep = await seedRun(fx5.allocator);
    live = { pane: childPane(), agent: childAgent() };
    ({ deps, clock } = retirerDeps(fx5, live, {
      cli: fakeCli(live, {
        getPane: childPane({ tokens: childTokens(childSession, { retention: "keep" }) }),
        getAgent: childAgent({ tokens: childTokens(childSession, { retention: "keep" }) }),
      }),
    }));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(tokenKeep.runId)).toMatchObject({ state: "kept", reason: "token_retention_keep" });
    expect(live.pane).not.toBeUndefined();
  });

  it("F7: checks the lease immediately before dispatch — a lost lease defers without spending an attempt", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx.allocator);
    const live: Live = { pane: childPane(), agent: childAgent() };
    const lockOpts: FakeLockOptions = { checkError: Object.assign(new Error("holder is not live"), { code: "PANE_WRITE_LOCK_UNAVAILABLE" }) };
    const lock = fakePaneLock(lockOpts);
    const cliOpts: FakeCliOptions = { closeError: Object.assign(new Error("socket dropped"), { code: "CLI_UNAVAILABLE" }) };
    const { deps, clock } = retirerDeps(fx, live, { cli: fakeCli(live, cliOpts), options: { paneLock: lock.guard, maxAttempts: 2 } });
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(lock.checks).toEqual(["p-child"]);
    expect(retirer.view(runId)).toMatchObject({ state: "deferred", reason: "pane_lock_lost" });
    expect(closes(deps)).toHaveLength(0);
    expect(live.pane).not.toBeUndefined();
    // No attempt was spent: with the lease live again, the first real close
    // failure is a retry, not the terminal `failed`.
    lockOpts.checkError = undefined;
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(lock.checks).toEqual(["p-child", "p-child"]);
    expect(retirer.view(runId)).toMatchObject({ state: "deferred", reason: "close_MUTATION_UNCERTAIN" });
    expect(closes(deps)).toHaveLength(1);
  });

  it("retires a lane whose artifact carries no recorded digest, omitting artifactSha256", async () => {
    const fx = await fixture();
    const { allocation, runId } = await seedRun(fx.allocator, { digest: false });
    const live: Live = { pane: childPane(), agent: childAgent() };
    const { deps, clock } = retirerDeps(fx, live);
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "retired" });
    const unread = await fx.mailbox.list(ownerKey);
    expect(unread).toHaveLength(1);
    const event = await fx.mailbox.read(ownerKey, unread[0]!);
    expect(event).toMatchObject({
      kind: "lane_retired",
      handoff: { state: "handed_off" },
      actions: ["pane_closed:p-child", `artifact:${allocation.artifactPath}`],
    });
    expect((event as { handoff?: Record<string, unknown> }).handoff).not.toHaveProperty("artifactSha256");
  });

  it("still retires when the pane-lock release rejects", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx.allocator);
    const live: Live = { pane: childPane(), agent: childAgent() };
    const { deps, clock } = retirerDeps(fx, live, {
      options: { paneLock: fakePaneLock({ releaseError: new Error("flock release lost") }).guard },
    });
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "retired" });
    expect(live.pane).toBeUndefined();
    expect(await fx.mailbox.list(ownerKey)).toHaveLength(1);
  });

  it("retires when the recorded owner's pane is absent from the snapshot", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx.allocator);
    const live: Live = { pane: childPane(), agent: childAgent() };
    const { deps, clock } = retirerDeps(fx, live, {
      snapshot: async () => snapshotFor(live, { omitOwner: true }),
    });
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    // Nothing the close could cascade into — the absent owner protects nothing.
    expect(retirer.view(runId)).toMatchObject({ state: "retired" });
    expect(live.pane).toBeUndefined();
    // The event still routes to the recorded owner mailbox.
    const unread = await fx.mailbox.list(ownerKey);
    expect(unread).toHaveLength(1);
    expect(await fx.mailbox.read(ownerKey, unread[0]!)).toMatchObject({ kind: "lane_retired", runId });
  });

  it("defers a malformed pane record, bounds journal fragments, and runs on the default clock and sink", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx.allocator);
    // A non-string status is malformed lifecycle evidence — a bounded
    // deferral, never journal text — and with no injected clock or sink the
    // retirer runs on its defaults.
    const live: Live = { pane: childPane({ agent_status: 7 }), agent: childAgent() };
    const { deps } = retirerDeps(fx, live, { now: undefined, log: undefined });
    const retirer = createLaneRetirer(deps);
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "deferred", reason: "lifecycle_target_record_malformed" });
    expect(live.pane).not.toBeUndefined();

    // A rejection that is not an error object at all still journals as ERROR.
    const broken: HandoffAllocator = {
      ...fx.allocator,
      open: () => Promise.reject<never>("io lost"),
    };
    const { deps: deps2 } = retirerDeps(fx, live, { allocator: broken });
    const retirer2 = createLaneRetirer(deps2);
    await retirer2.sweep();
    expect(retirer2.view(runId)).toMatchObject({ state: "refused", reason: "sidecar_ERROR" });

    // A defect escaping evaluate — an injected clock that throws — is
    // journaled as a sweep error and never strands the sweep.
    const { deps: deps3 } = retirerDeps(fx, { pane: childPane(), agent: childAgent() }, {
      now: () => {
        throw Object.assign(new Error("clock broke"), { code: "CLOCK_STOPPED" });
      },
    });
    await createLaneRetirer(deps3).sweep();
    expect(fx.lines.some((line) => line.includes(`run=${runId}`) && line.includes("decision=sweep_error reason=CLOCK_STOPPED"))).toBe(true);
  });

  it("dry-run journals would_retire and never closes", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx.allocator);
    const live: Live = { pane: childPane(), agent: childAgent() };
    const { deps, clock } = retirerDeps(fx, live, { options: { enabled: false } });
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "disabled" });
    expect(live.pane).not.toBeUndefined();
    // Only the per-sweep screen reads — nothing under a lock, no close.
    expect(lockedCalls(deps)).toHaveLength(0);
    expect(fx.lines.filter((line) => line.includes(`run=${runId}`) && line.includes("decision=would_retire"))).toHaveLength(1);
    expect(await fx.mailbox.list(ownerKey)).toHaveLength(0);
  });

  it("retries an uncertain close on the next sweeps, then marks failed with no event", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx.allocator);
    const live: Live = { pane: childPane(), agent: childAgent() };
    const { deps, clock } = retirerDeps(fx, live, {
      cli: fakeCli(live, { closeError: Object.assign(new Error("socket dropped"), { code: "CLI_UNAVAILABLE" }) }),
    });
    const retirer = createLaneRetirer(deps);
    for (let sweep = 0; sweep < 4; sweep += 1) {
      clock.nowMs += GRACE_MS;
      await retirer.sweep();
    }
    // Three close attempts — the initial plus two retries — then failed.
    expect(closes(deps)).toHaveLength(3);
    expect(retirer.view(runId)).toMatchObject({ state: "failed", reason: "close_MUTATION_UNCERTAIN" });
    expect(retirer.retiredByDaemon(runId)).toBe(false);
    expect(await fx.mailbox.list(ownerKey)).toHaveLength(0);
    expect(live.pane).not.toBeUndefined();
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(closes(deps)).toHaveLength(3);
  });

  it("defers without spending attempts when the pane lock cannot be acquired", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx.allocator);
    const live: Live = { pane: childPane(), agent: childAgent() };
    const { deps, clock } = retirerDeps(fx, live, { options: { paneLock: fakePaneLock({ fails: true }).guard } });
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "deferred", reason: "pane_lock_unavailable" });
    expect(lockedCalls(deps)).toHaveLength(0);
  });

  it("F6/F9: a reconciled absence is another actor's close — no retired marker, no lane_retired, and the next sweep drops the vanished child", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx.allocator);
    const live: Live = { pane: childPane(), agent: childAgent() };
    const selfClose = createSelfCloseTracker();
    // The transport error raced a real close by someone else: the readback
    // finds the pane gone, but no mutation of ours proved it.
    const cli = fakeCli(live, {
      closeError: Object.assign(new Error("socket dropped mid-close"), { code: "CLI_UNAVAILABLE" }),
      onClose: async () => {
        live.pane = undefined;
        live.agent = undefined;
      },
    });
    const { deps, clock } = retirerDeps(fx, live, { cli, selfClose });
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "deferred", reason: "close_reconciled_absent" });
    // Not this daemon's retirement: JobRegistry must still emit job_terminal.
    expect(retirer.retiredByDaemon(runId)).toBe(false);
    // The own-close ledger holds no confirmed marker — the pane_closed wake lands normally.
    expect(await selfClose.consume("p-child")).toBe(false);
    expect(await fx.mailbox.list(ownerKey)).toHaveLength(0);
    expect(fx.lines.some((line) => line.includes(`run=${runId}`) && line.includes("decision=deferred reason=close_reconciled_absent"))).toBe(true);
    // The next sweep observes the absence and stops tracking the run.
    await retirer.sweep();
    expect(retirer.view(runId)).toBeUndefined();
    expect(retirer.retiredByDaemon(runId)).toBe(false);
    expect(await fx.mailbox.list(ownerKey)).toHaveLength(0);
  });

  it("still retires when the lane_retired event cannot persist, and journals the loss", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx.allocator);
    const live: Live = { pane: childPane(), agent: childAgent() };
    const refusing: Pick<Mailbox, "writeRunEvent" | "list"> = {
      writeRunEvent: async () => ({ persisted: false, persistenceFailed: true, eventId: "e", reason: "capacity", at: "2026-10-01T00:00:00.000Z" }),
      list: async () => [],
    };
    const { deps, clock } = retirerDeps(fx, live, { mailbox: refusing });
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "retired" });
    expect(retirer.retiredByDaemon(runId)).toBe(true);
    expect(fx.lines.some((line) => line.includes("decision=retired_event_unpersisted reason=capacity"))).toBe(true);

    const fx2 = await fixture();
    const thrown = await seedRun(fx2.allocator);
    const live2: Live = { pane: childPane(), agent: childAgent() };
    const throwing: Pick<Mailbox, "writeRunEvent" | "list"> = {
      writeRunEvent: async () => { throw new Error("sink down"); },
      list: async () => [],
    };
    const deps2 = retirerDeps(fx2, live2, { mailbox: throwing });
    const retirer2 = createLaneRetirer(deps2.deps);
    await sweepPastGrace(retirer2, deps2.clock);
    expect(retirer2.view(thrown.runId)).toMatchObject({ state: "retired" });
  });

  it("survives a failed snapshot, an absent or unreadable runs dir, and a mid-sweep fault", async () => {
    const fx = await fixture();
    const { allocation, runId } = await seedRun(fx.allocator);
    const live: Live = { pane: childPane(), agent: childAgent() };

    // Snapshot failure: no classification is ever inferred.
    const failing = retirerDeps(fx, live, { snapshot: async () => { throw new Error("socket gone"); } });
    await createLaneRetirer(failing.deps).sweep();
    expect(fx.lines.some((line) => line.includes("decision=sweep_unavailable reason=ERROR"))).toBe(true);

    // An absent runs dir is an empty sweep; a non-directory one is logged.
    const absentRuns: HandoffNamespace = { dir: join(fx.handoffNs.dir, "gone"), endpoint: fx.handoffNs.endpoint };
    const deps2 = retirerDeps(fx, live, { runs: absentRuns });
    await createLaneRetirer(deps2.deps).sweep();
    await writeFile(join(fx.handoffNs.dir, "file"), "x", { mode: 0o600 });
    const fileRuns: HandoffNamespace = { dir: join(fx.handoffNs.dir, "file"), endpoint: fx.handoffNs.endpoint };
    const deps3 = retirerDeps(fx, live, { runs: fileRuns });
    await createLaneRetirer(deps3.deps).sweep();
    expect(deps3.clock.nowMs).toBeGreaterThan(0);

    // A mid-evaluate fault — the get re-read throws — defers that run only,
    // and the run flock it threw under is released.
    const deps4 = retirerDeps(fx, live, { cli: fakeCli(live, { getError: Object.assign(new Error("gone"), { code: "CLI_PROTOCOL_ERROR" }) }) });
    const retirer4 = createLaneRetirer(deps4.deps);
    await sweepPastGrace(retirer4, deps4.clock);
    expect(retirer4.view(runId)).toMatchObject({ state: "deferred", reason: "sweep_error:CLI_PROTOCOL_ERROR" });
    const released = await acquireFlockHolder({ lockPath: allocation.lockPath, wait: "nonblock", readyMarker: "HERDR_RETIRE_TEST_PROBE", subject: "Probe", failure: (message) => new Error(message) });
    await released.release();

    // A vanished run directory drops its ledger entry entirely.
    const deps5 = retirerDeps(fx, live);
    const retirer5 = createLaneRetirer(deps5.deps);
    await retirer5.sweep();
    expect(retirer5.view(runId)).toMatchObject({ state: "watching" });
    await rm(join(fx.handoffNs.dir, runId), { recursive: true, force: true });
    await retirer5.sweep();
    expect(retirer5.view(runId)).toBeUndefined();
  });
});
