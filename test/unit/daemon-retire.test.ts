/**
 * The ADR-040 lane-retirement sweep (design B3, node B8).
 *
 * Proves the full proof chain — only a `handed_off` run whose exact child
 * stays continuously idle past the grace, carries the launch tokens, manages
 * nothing live, drains its own mailbox, and sits clear of the owner's
 * topology is closed under the pane write lock — plus the dry-run kill
 * switch, the bounded focused deferral, close uncertainty retries, the
 * one-shot `lane_retired` event, and the ledger's replay/idempotency.
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tokenValue } from "../../src/agent-identity.js";
import type { JsonEnvelope } from "../../src/cli.js";
import {
  createHandoffAllocator,
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
import type { CloseReadbackCli } from "../../src/mutations.js";
import type { PaneWriteGuard } from "../../src/pane-write-lock.js";
import { createSelfCloseTracker } from "../../src/supervision/self-close.js";
import { parseSnapshotResult, type HerdrSnapshot } from "../../src/targets.js";
import { createIntentStore, managerSessionKey, type IntentStore } from "../../src/daemon/intents.js";
import { createMailbox, type Mailbox } from "../../src/daemon/mailbox.js";
import type { DaemonNamespace } from "../../src/daemon/namespace.js";
import { daemonRunOwnership } from "../../src/daemon/ownership.js";
import { createLaneRetirer, type LaneRetirerDeps } from "../../src/daemon/retire.js";

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

/** The live child records the sweep observes; empty `pane` means it is gone. */
interface Live {
  pane?: RawRecord;
  agent?: RawRecord;
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

interface FakeCli extends CloseReadbackCli {
  calls: string[][];
}

/**
 * A scripted Herdr CLI over the `live` records. `pane close` clears them (so
 * the readback proves absence) unless `closeError` throws first; `pane get` /
 * `agent get` serve the live records, or `getPane`/`getAgent` overrides when a
 * test needs the under-lock records to differ from the snapshot.
 */
function fakeCli(live: Live, opts: { closeError?: unknown; getError?: unknown; getPane?: RawRecord; getAgent?: RawRecord } = {}): FakeCli {
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
        if (opts.closeError !== undefined) throw opts.closeError;
        live.pane = undefined;
        live.agent = undefined;
        return { id: "op", result: { closed: id } } as JsonEnvelope;
      }
      throw Object.assign(new Error(`unexpected argv: ${argv.join(" ")}`), { code: "CLI_PROTOCOL_ERROR" });
    },
  };
}

/** A pane write guard that needs no flock: acquisition is counted, never contended unless told to fail; `releaseError` makes the lease release reject. */
function fakePaneLock(opts: { fails?: boolean; releaseError?: unknown } = {}): { guard: PaneWriteGuard; acquired: string[] } {
  const acquired: string[] = [];
  return {
    acquired,
    guard: {
      async acquire(paneId) {
        if (opts.fails === true) throw Object.assign(new Error("contended"), { code: "PANE_WRITE_LOCK_UNAVAILABLE" });
        acquired.push(paneId);
        return {
          check: async () => undefined,
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

describe("lane retirer (ADR-040)", () => {
  it("closes a stable handed_off lane under the lock, confirms self-close, and writes exactly one lane_retired", async () => {
    const fx = await fixture();
    const { allocation, runId } = await seedRun(fx.allocator);
    const live: Live = { pane: childPane(), agent: childAgent() };
    const { deps, clock } = retirerDeps(fx, live);
    const retirer = createLaneRetirer(deps);

    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "watching", stableForMs: 0 });

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
    expect((deps.cli as FakeCli).calls.filter((argv) => argv[1] === "close")).toHaveLength(1);
    expect(fx.lines.filter((line) => line.includes(`run=${runId}`) && line.includes("decision=retired"))).toHaveLength(1);
  });

  it("reports the live supervisor's jobId and lands the event in a transferred run's successor mailbox", async () => {
    const fx = await fixture();
    const { allocation, runId } = await seedRun(fx.allocator);
    const prior = await readHandoffProvenance(allocation);
    await writeHandoffProvenance(allocation, {
      ...prior,
      v: 2,
      owners: [
        { session: ownerSession, from: prior.createdAt, to: "2026-10-01T00:00:00.000Z", reason: "transfer" },
        { session: successorSession, from: "2026-10-01T00:00:00.000Z", to: null, reason: "transfer" },
      ],
    });
    const live: Live = { pane: childPane(), agent: childAgent() };
    const { deps, clock } = retirerDeps(fx, live, {
      jobs: { activeSupervisorFor: () => ({ jobId: "job_live" }) } as unknown as Pick<JobRegistry, "activeSupervisorFor">,
    });
    const retirer = createLaneRetirer(deps);
    await retirer.sweep();
    clock.nowMs += GRACE_MS;
    await retirer.sweep();

    expect(retirer.view(runId)).toMatchObject({ state: "retired" });
    const successorKey = managerSessionKey(successorSession);
    expect(await fx.mailbox.list(ownerKey)).toHaveLength(0);
    const unread = await fx.mailbox.list(successorKey);
    expect(unread).toHaveLength(1);
    expect(await fx.mailbox.read(successorKey, unread[0]!)).toMatchObject({ kind: "lane_retired", runId, jobId: "job_live" });
  });

  it("never retires a run whose lifecycle is not handed_off", async () => {
    const fx = await fixture();
    for (const lifecycle of ["awaiting_handoff", "recovery_pending", "cancelled", "failed"] as const) {
      const { runId } = await seedRun(fx.allocator, { lifecycle });
      const live: Live = { pane: childPane(), agent: childAgent() };
      const { deps, clock } = retirerDeps(fx, live);
      const retirer = createLaneRetirer(deps);
      await retirer.sweep();
      clock.nowMs += GRACE_MS;
      await retirer.sweep();
      expect(retirer.view(runId)).toBeUndefined();
      expect(live.pane).not.toBeUndefined();
      expect((deps.cli as FakeCli).calls.filter((argv) => argv[1] === "close")).toHaveLength(0);
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
    await retirer.sweep();
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
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
    await retirer.sweep();
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    // Absent: no ledger entry at all — nothing to project or retire.
    expect(retirer.view(absent.runId)).toBeUndefined();
    // Two panes on the recorded terminal is ambiguity, never a close.
    expect(retirer.view(ambiguous.runId)).toMatchObject({ state: "deferred", reason: "child_terminal_ambiguous:2" });
    expect(fx.lines.some((line) => line.includes(`run=${absent.runId}`) && line.includes("decision=skipped reason=child_absent"))).toBe(true);
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
    live.agent = childAgent({ state_change_seq: 7 });
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

  it("defers while no usable state_change_seq is observed", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx.allocator);
    const pane = childPane();
    const agent = childAgent();
    delete pane.state_change_seq;
    delete agent.state_change_seq;
    const live: Live = { pane, agent };
    const { deps, clock } = retirerDeps(fx, live);
    const retirer = createLaneRetirer(deps);
    await retirer.sweep();
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "deferred", reason: "state_change_seq_unavailable" });
    expect(live.pane).not.toBeUndefined();
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
      await retirer.sweep();
      clock.nowMs += GRACE_MS;
      await retirer.sweep();
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
    await retirer.sweep();
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
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
    await retirer2.sweep();
    deps2.clock.nowMs += GRACE_MS;
    await retirer2.sweep();
    expect(retirer2.view(keptByToken.runId)).toMatchObject({ state: "kept", reason: "token_retention_keep" });
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
    await retirer.sweep();
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "refused", reason: "child_is_manager:manages_children" });
    expect(live.pane).not.toBeUndefined();
  });

  it("refuses a caller-policy failure and an open or live intent ledger under the child's session", async () => {
    // Malformed scope evidence makes classification itself refuse.
    const fx = await fixture();
    const policyRun = await seedRun(fx.allocator);
    let live: Live = {
      pane: childPane({ tokens: childTokens(childSession, { identity_scope: { bad: true } }) }),
      agent: childAgent(),
    };
    let { deps, clock } = retirerDeps(fx, live);
    let retirer = createLaneRetirer(deps);
    await retirer.sweep();
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
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
    await retirer.sweep();
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(openRun.runId)).toMatchObject({ state: "refused", reason: "child_intent_open" });
  });

  it("refuses a sub-manager with unproven or nonterminal recorded children, then retires once they settle", async () => {
    // A child runId with no readable sidecar is unproven — refuse.
    const fx = await fixture();
    const unproven = await seedRun(fx.allocator);
    await recordChildIntent(fx.intents, "sub-ghost", [{ name: "ghost", runId: "11111111-2222-4333-8444-555555555555" }]);
    let live: Live = { pane: childPane(), agent: childAgent() };
    let { deps, clock } = retirerDeps(fx, live);
    let retirer = createLaneRetirer(deps);
    await retirer.sweep();
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(unproven.runId)).toMatchObject({ state: "refused", reason: "child_intent_child_untrusted" });

    // A recorded child whose sidecar is not yet terminal refuses the same way.
    const fx2 = await fixture();
    const managed = await seedRun(fx2.allocator);
    const liveChild = await seedRun(fx2.allocator, { lifecycle: "awaiting_handoff", paneId: "p-sub", terminalId: "t-sub" });
    await recordChildIntent(fx2.intents, "sub-live", [{ name: "sub", runId: liveChild.runId }, { name: "alias" }]);
    live = { pane: childPane(), agent: childAgent() };
    ({ deps, clock } = retirerDeps(fx2, live));
    retirer = createLaneRetirer(deps);
    await retirer.sweep();
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(managed.runId)).toMatchObject({ state: "refused", reason: "child_manages_live_intent" });

    // Settled recorded children stop refusing — the close proceeds.
    await updateHandoffState(liveChild.allocation, (state) => {
      state.lifecycle.state = "failed";
    });
    ({ deps, clock } = retirerDeps(fx2, live));
    retirer = createLaneRetirer(deps);
    await retirer.sweep();
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
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
    await retirer.sweep();
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "refused", reason: "child_mailbox_unread" });
    expect(live.pane).not.toBeUndefined();
  });

  it("defers when the intent store or the mailbox cannot be read", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx.allocator);
    const live: Live = { pane: childPane(), agent: childAgent() };

    const noManagers: IntentStore = {
      ...fx.intents,
      listManagers: async () => { throw Object.assign(new Error("io"), { code: "INTENT_STORE_UNAVAILABLE" }); },
    };
    let { deps, clock } = retirerDeps(fx, live, { intents: noManagers });
    let retirer = createLaneRetirer(deps);
    await retirer.sweep();
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "deferred", reason: "intents_unavailable" });

    // The child is a recorded manager whose own ledger read fails.
    await recordChildIntent(fx.intents, "sub-led", []);
    const brokenLedger: IntentStore = {
      ...fx.intents,
      list: async (key) => (key === childKey ? Promise.reject(Object.assign(new Error("io"), { code: "INTENT_STORE_UNAVAILABLE" })) : fx.intents.list(key)),
    };
    ({ deps, clock } = retirerDeps(fx, live, { intents: brokenLedger }));
    retirer = createLaneRetirer(deps);
    await retirer.sweep();
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "deferred", reason: "intents_unavailable" });

    // A mailbox list failure also defers — proof gaps never close.
    const brokenMailbox: Pick<Mailbox, "writeRunEvent" | "list"> = {
      writeRunEvent: (input) => fx.mailbox.writeRunEvent(input),
      list: async () => { throw Object.assign(new Error("io"), { code: "MAILBOX_UNAVAILABLE" }); },
    };
    ({ deps, clock } = retirerDeps(fx, live, { mailbox: brokenMailbox }));
    retirer = createLaneRetirer(deps);
    await retirer.sweep();
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "deferred", reason: "mailbox_unavailable" });
  });

  it("refuses when the owner's pane sits inside the cascade and defers on invalid topology", async () => {
    // The recorded current owner IS the child pane — the cascade always reaches it.
    const fx = await fixture();
    const { allocation, runId } = await seedRun(fx.allocator);
    const prior = await readHandoffProvenance(allocation);
    await writeHandoffProvenance(allocation, {
      ...prior,
      v: 2,
      owners: [
        { session: ownerSession, from: prior.createdAt, to: "2026-10-01T00:00:00.000Z", reason: "transfer" },
        { session: childSession, from: "2026-10-01T00:00:00.000Z", to: null, reason: "transfer" },
      ],
    });
    let live: Live = { pane: childPane(), agent: childAgent() };
    let { deps, clock } = retirerDeps(fx, live);
    let retirer = createLaneRetirer(deps);
    await retirer.sweep();
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "refused", reason: "owner_topology_protected" });
    expect(live.pane).not.toBeUndefined();

    // A dangling parent — the child's tab has no record — is malformed topology.
    const fx2 = await fixture();
    const dangling = await seedRun(fx2.allocator);
    live = { pane: childPane({ tab_id: "tab-ghost" }), agent: childAgent() };
    ({ deps, clock } = retirerDeps(fx2, live));
    retirer = createLaneRetirer(deps);
    await retirer.sweep();
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(dangling.runId)).toMatchObject({ state: "deferred", reason: "topology_invalid" });
  });

  it("retires with no provenance record by falling back to the launch manager pane", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx.allocator, { provenance: false });
    const live: Live = { pane: childPane(), agent: childAgent() };
    const { deps, clock } = retirerDeps(fx, live);
    const retirer = createLaneRetirer(deps);
    await retirer.sweep();
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
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
    await retirer.sweep();
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
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
    await retirer.sweep();
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(drifted.runId)).toMatchObject({ state: "deferred", reason: "recheck_identity" });

    // Under-lock status or seq changes defer without spending an attempt.
    const fx3 = await fixture();
    const busy = await seedRun(fx3.allocator);
    const moved = await seedRun(fx3.allocator);
    live = { pane: childPane(), agent: childAgent() };
    ({ deps, clock } = retirerDeps(fx3, live, {
      cli: fakeCli(live, { getPane: childPane({ agent_status: "working" }), getAgent: childAgent({ state_change_seq: 9 }) }),
    }));
    retirer = createLaneRetirer(deps);
    await retirer.sweep();
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
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
    await retirer.sweep();
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(moved.runId)).toMatchObject({ state: "deferred", reason: "recheck_identity" });
    expect(live.pane).not.toBeUndefined();

    // A seq bump observed only under the lock restarts the stability clock.
    const fx2 = await fixture();
    const { runId } = await seedRun(fx2.allocator);
    live = { pane: childPane(), agent: childAgent() };
    ({ deps, clock } = retirerDeps(fx2, live, {
      cli: fakeCli(live, { getPane: childPane({ state_change_seq: 9 }) }),
    }));
    retirer = createLaneRetirer(deps);
    await retirer.sweep();
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
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
    await retirer.sweep();
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
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
    await retirer2.sweep();
    deps2.clock.nowMs += GRACE_MS;
    await retirer2.sweep();
    expect(retirer2.view(dropped.runId)).toMatchObject({ state: "deferred", reason: "recheck_tokens" });
  });

  it("retires a lane whose artifact carries no recorded digest, omitting artifactSha256", async () => {
    const fx = await fixture();
    const { allocation, runId } = await seedRun(fx.allocator, { digest: false });
    const live: Live = { pane: childPane(), agent: childAgent() };
    const { deps, clock } = retirerDeps(fx, live);
    const retirer = createLaneRetirer(deps);
    await retirer.sweep();
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
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
    await retirer.sweep();
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
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
    await retirer.sweep();
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    // Nothing the close could cascade into — the absent owner protects nothing.
    expect(retirer.view(runId)).toMatchObject({ state: "retired" });
    expect(live.pane).toBeUndefined();
    // The event still routes to the recorded owner mailbox.
    const unread = await fx.mailbox.list(ownerKey);
    expect(unread).toHaveLength(1);
    expect(await fx.mailbox.read(ownerKey, unread[0]!)).toMatchObject({ kind: "lane_retired", runId });
  });

  it("bounds journal fragments and runs on the default clock and sink", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx.allocator);
    // A non-string status is evidence, never journal text — and with no
    // injected clock or sink the retirer runs on its defaults.
    const live: Live = { pane: childPane({ agent_status: 7 }), agent: childAgent() };
    const { deps } = retirerDeps(fx, live, { now: undefined, log: undefined });
    const retirer = createLaneRetirer(deps);
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "deferred", reason: "child_active:unavailable" });
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
    const { deps: deps3 } = retirerDeps(fx, live, {
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
    await retirer.sweep();
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "disabled" });
    expect(live.pane).not.toBeUndefined();
    expect((deps.cli as FakeCli).calls).toHaveLength(0);
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
    expect((deps.cli as FakeCli).calls.filter((argv) => argv[1] === "close")).toHaveLength(3);
    expect(retirer.view(runId)).toMatchObject({ state: "failed", reason: "close_MUTATION_UNCERTAIN" });
    expect(retirer.retiredByDaemon(runId)).toBe(false);
    expect(await fx.mailbox.list(ownerKey)).toHaveLength(0);
    expect(live.pane).not.toBeUndefined();
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect((deps.cli as FakeCli).calls.filter((argv) => argv[1] === "close")).toHaveLength(3);
  });

  it("defers without spending attempts when the pane lock or the get re-reads fail", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx.allocator);
    const live: Live = { pane: childPane(), agent: childAgent() };
    const { deps, clock } = retirerDeps(fx, live, { options: { paneLock: fakePaneLock({ fails: true }).guard } });
    const retirer = createLaneRetirer(deps);
    await retirer.sweep();
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "deferred", reason: "pane_lock_unavailable" });
    expect((deps.cli as FakeCli).calls).toHaveLength(0);
  });

  it("records an absent-after-mutation-error close as retired without a confirmed marker", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx.allocator);
    const live: Live = { pane: childPane(), agent: childAgent() };
    const selfClose = createSelfCloseTracker();
    const cli = fakeCli(live, { closeError: Object.assign(new Error("socket dropped mid-close"), { code: "CLI_UNAVAILABLE" }) });
    // The transport error raced a real close: the readback finds the pane gone.
    const realRunJson = cli.runJson.bind(cli);
    cli.runJson = async (argv, signal, preserve) => {
      if (argv[0] === "pane" && argv[1] === "close") {
        live.pane = undefined;
        live.agent = undefined;
      }
      return realRunJson(argv, signal, preserve);
    };
    const { deps, clock } = retirerDeps(fx, live, { cli, selfClose });
    const retirer = createLaneRetirer(deps);
    await retirer.sweep();
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "retired" });
    expect(retirer.retiredByDaemon(runId)).toBe(true);
    // reconciled=true — the absence was not proven to be this host's mutation.
    expect(await selfClose.consume("p-child")).toBe(false);
    expect(await fx.mailbox.list(ownerKey)).toHaveLength(1);
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
    await retirer.sweep();
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
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
    await retirer2.sweep();
    deps2.clock.nowMs += GRACE_MS;
    await retirer2.sweep();
    expect(retirer2.view(thrown.runId)).toMatchObject({ state: "retired" });
  });

  it("survives a failed snapshot, an absent or unreadable runs dir, and a mid-sweep fault", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx.allocator);
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

    // A mid-evaluate fault — the get re-read throws — defers that run only.
    const deps4 = retirerDeps(fx, live, { cli: fakeCli(live, { getError: Object.assign(new Error("gone"), { code: "CLI_PROTOCOL_ERROR" }) }) });
    const retirer4 = createLaneRetirer(deps4.deps);
    await retirer4.sweep();
    deps4.clock.nowMs += GRACE_MS;
    await retirer4.sweep();
    expect(retirer4.view(runId)).toMatchObject({ state: "deferred", reason: "sweep_error:CLI_PROTOCOL_ERROR" });

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
