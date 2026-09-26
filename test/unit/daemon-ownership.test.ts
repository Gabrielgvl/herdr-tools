import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as handoff from "../../src/handoff.js";
import { acquireFlockHolder } from "../../src/pane-write-lock.js";
import { createHandoffAllocator, currentHandoffOwner, handoffOwners, readHandoffProvenance, readHandoffState, updateHandoffState } from "../../src/handoff.js";
import { createIntentStore, managerSessionKey } from "../../src/daemon/intents.js";
import { createMailbox, mailboxEventId, type Mailbox } from "../../src/daemon/mailbox.js";
import { createOwnership, daemonRunOwnership, isClaimRecord, isTransferRecord, type ClaimRecord, type TransferRecord } from "../../src/daemon/ownership.js";
import { reattachDaemonRuns } from "../../src/daemon/reattach.js";
import { parseSnapshotResult } from "../../src/targets.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const session = (value: string) => ({ source: "herdr:pi", agent: "pi", kind: "path", value });
const owner = { paneId: "owner", session: session("/owner.jsonl") };
const successor = { paneId: "successor", session: session("/successor.jsonl") };
const fromKey = managerSessionKey(owner.session);
const toKey = managerSessionKey(successor.session);
const pane = (id: string, native = session(`/${id}.jsonl`)) => ({
  pane_id: id, terminal_id: `term-${id}`, workspace_id: "w1", tab_id: "t1", agent: native.agent, agent_name: id,
  agent_session: native, agent_status: "idle", revision: 1, state_change_seq: 1,
});
const snapshot = (panes = [pane(owner.paneId, owner.session), pane(successor.paneId, successor.session)]) => parseSnapshotResult({
  type: "session_snapshot", snapshot: { version: "test", protocol: 22, workspaces: [], tabs: [], panes, agents: panes.map((entry) => ({ ...entry, name: entry.agent_name })) },
});
const task = { objective: "test", scope: "test", doneWhen: ["test"], constraints: [], tier: "standard" as const, replicas: 1 };
async function fixture(count = 1) {
  const root = await mkdtemp(join(tmpdir(), "ownership-")); roots.push(root);
  const namespace = { dir: join(root, "daemon"), endpoint: join(root, "socket") };
  const runNamespace = { dir: join(root, "runs"), endpoint: namespace.endpoint };
  await mkdir(namespace.dir, { mode: 0o700 }); await mkdir(runNamespace.dir, { mode: 0o700 });
  const allocator = createHandoffAllocator({ namespace: runNamespace });
  const runs = [];
  for (let index = 0; index < count; index++) {
    const run = await allocator.allocate();
    await allocator.persist(run, { manager: { paneId: owner.paneId, display: "owner", source: "agent_name" },
      child: { agentName: `child-${index}`, agentKind: "pi", operatingPointId: "pi", specLabel: "test", fallbackCandidates: [] } }, { managerSession: owner.session, task });
    await updateHandoffState(run, (state) => { state.child.paneId = `child-${index}`; state.child.terminalId = `term-child-${index}`; state.nativeSession = session(`/child-${index}.jsonl`); });
    runs.push(run);
  }
  const intents = createIntentStore({ namespace });
  const mailbox = createMailbox({ namespace, ownership: daemonRunOwnership(allocator) });
  const readSnapshot = vi.fn(async () => snapshot());
  const retarget = vi.fn(async () => undefined);
  const options = { namespace, allocator, intents, mailbox, snapshot: readSnapshot, retarget };
  const ownership = createOwnership(options);
  const runIds = runs.map((run) => run.runId);
  async function instruction(ids = runIds, incidentId = "incident") {
    await mkdir(join(namespace.dir, "claims"), { mode: 0o700, recursive: true });
    const record: ClaimRecord = { priorOwnerSession: owner.session, successorSession: successor.session, runIds: ids, instructedAt: new Date().toISOString(), instruction: "Recover these runs." };
    await writeFile(join(namespace.dir, "claims", `${incidentId}.json`), JSON.stringify(record), { mode: 0o600 });
    return record;
  }
  return { root, namespace, runNamespace, allocator, intents, mailbox, options, ownership, runs, runIds, readSnapshot, retarget, instruction };
}
async function interruptedIntent(f: Awaited<ReturnType<typeof fixture>>) {
  const begin = await f.intents.begin({ managerSessionKey: fromKey, idempotencyKey: "key", task, projectRoot: f.root });
  const effecting = await f.intents.markEffecting(begin.intent);
  return f.intents.fail(effecting, { effectCertainty: "partial", children: f.runIds.map((runId, index) => ({ name: `child-${index}`, runId })) });
}
async function journal(f: Awaited<ReturnType<typeof fixture>>) {
  const names = (await readdir(join(f.namespace.dir, "transfers"))).filter((name) => name.endsWith(".json"));
  return JSON.parse(await readFile(join(f.namespace.dir, "transfers", names[0]!), "utf8")) as TransferRecord;
}

describe("journaled ownership", () => {
  it("reports pending IDs/bodies without creating or changing any durable state", async () => {
    const f = await fixture();
    const before = await readdir(f.namespace.dir);
    expect(await f.ownership.pendingTransfers()).toEqual([]);
    expect(await readdir(f.namespace.dir)).toEqual(before);
    f.retarget.mockRejectedValueOnce(new Error("interrupted"));
    await expect(f.ownership.transfer({ caller: owner, runIds: f.runIds, successorPaneId: successor.paneId })).rejects.toThrow("interrupted");
    const plan = await journal(f);
    const path = join(f.namespace.dir, "transfers", `${plan.transferId}.json`);
    const bytes = await readFile(path, "utf8");
    expect(await f.ownership.pendingTransfers()).toEqual([{ transferId: plan.transferId, runIds: f.runIds, fromKey, toKey, events: plan.events }]);
    expect(await readFile(path, "utf8")).toBe(bytes);
    expect(isTransferRecord(plan)).toBe(true);
    for (const changed of [null, {}, { ...plan, unread: ["../bad.json"] }, { ...plan, events: [] }, { ...plan, movesComplete: false }]) expect(isTransferRecord(changed)).toBe(false);
    await writeFile(path, JSON.stringify({ ...plan, unread: ["bad.json"] }));
    await expect(f.ownership.completePending()).rejects.toMatchObject({ code: "TRANSFER_MALFORMED" });
  });

  it("transfers v1 runs and ALL unread including mailbox-global downtime_gap, retargets, and routes later writes to current owner", async () => {
    const f = await fixture(2);
    const event = await f.mailbox.writeRunEvent({ kind: "review", runId: f.runIds[0]!, jobId: "job" });
    const gap = await f.mailbox.writeGapEvent(fromKey, { from: "before", to: "now", lost: {} });
    const plan = await f.ownership.transfer({ caller: owner, runIds: f.runIds, successorPaneId: successor.paneId });
    expect(plan.unread.sort()).toEqual([`${event.eventId}.json`, `${gap.eventId}.json`].sort());
    expect(await f.mailbox.list(fromKey)).toEqual([plan.events[0].id]);
    expect(await f.mailbox.list(toKey)).toEqual(expect.arrayContaining([gap.eventId, event.eventId, plan.events[1].id]));
    for (const run of f.runs) {
      const provenance = await readHandoffProvenance(run);
      expect(provenance.v).toBe(2);
      expect(provenance.manager.session).toEqual(owner.session);
      expect(handoffOwners(provenance)).toHaveLength(2);
      expect(currentHandoffOwner(provenance)).toEqual(successor.session);
    }
    expect(f.retarget).toHaveBeenCalledWith(f.runIds, successor);
    expect(await readdir(join(f.namespace.dir, "transfers", "done"))).toEqual([`${plan.transferId}.json`]);
    const late = await f.mailbox.writeRunEvent({ kind: "late", runId: f.runIds[0]!, jobId: "job" });
    expect(await f.mailbox.list(toKey)).toContain(late.eventId);
  });

  it("refuses unverified owners, unsupported or incomplete successors, and unresolved owner intents without retargeting", async () => {
    const f = await fixture();
    await expect(f.ownership.transfer({ caller: successor, runIds: f.runIds, successorPaneId: owner.paneId })).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
    f.readSnapshot.mockResolvedValueOnce(snapshot([pane(owner.paneId, owner.session), pane(successor.paneId, { ...successor.session, agent: "agy" })]));
    await expect(f.ownership.transfer({ caller: owner, runIds: f.runIds, successorPaneId: successor.paneId })).rejects.toMatchObject({ code: "SUCCESSOR_UNPROVEN" });
    const incomplete = snapshot(); delete incomplete.panes[1]!.agent_session; delete incomplete.agents[1]!.agent_session;
    f.readSnapshot.mockResolvedValueOnce(incomplete);
    await expect(f.ownership.transfer({ caller: owner, runIds: f.runIds, successorPaneId: successor.paneId })).rejects.toMatchObject({ code: "SUCCESSOR_UNPROVEN" });
    await interruptedIntent(f);
    await expect(f.ownership.transfer({ caller: owner, runIds: f.runIds, successorPaneId: successor.paneId })).rejects.toMatchObject({ code: "OWNER_INTENT_UNRESOLVED" });
    expect(f.retarget).not.toHaveBeenCalled();
  });

  it("recovers an actual SIGKILL after the first transfer event: once-only files/events and successor history", async () => {
    const f = await fixture();
    const gap = await f.mailbox.writeGapEvent(fromKey, { from: "before", to: "now", lost: {} });
    const modules = (path: string) => JSON.stringify(resolve(`src/${path}.ts`));
    const code = `
      import { createHandoffAllocator } from ${modules("handoff")};
      import { createIntentStore } from ${modules("daemon/intents")};
      import { createMailbox } from ${modules("daemon/mailbox")};
      import { createOwnership, daemonRunOwnership } from ${modules("daemon/ownership")};
      const namespace = ${JSON.stringify(f.namespace)};
      const allocator = createHandoffAllocator({namespace: ${JSON.stringify(f.runNamespace)}});
      const mailbox = createMailbox({namespace, ownership: daemonRunOwnership(allocator)});
      const real = mailbox.withMailboxes.bind(mailbox);
      mailbox.withMailboxes = (keys, section) => real(keys, locked => section({...locked, writeRecordedEvent: async (key, event) => {
        const result = await locked.writeRecordedEvent(key, event); process.kill(process.pid, 'SIGKILL'); return result;
      }}));
      await createOwnership({namespace, allocator, intents:createIntentStore({namespace}), mailbox, snapshot:async()=>(${JSON.stringify(snapshot())})})
        .transfer(${JSON.stringify({ caller: owner, runIds: f.runIds, successorPaneId: successor.paneId })});`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = ""; child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    const result = await new Promise<{ code: number | null; signal: string | null }>((done, reject) => { child.once("error", reject); child.once("close", (code, signal) => done({ code, signal })); });
    expect(result, stderr).toEqual({ code: null, signal: "SIGKILL" });
    const plan = await journal(f);
    expect(await f.mailbox.list(toKey)).toContain(gap.eventId);
    await f.ownership.completePending(); await f.ownership.completePending();
    expect(await f.mailbox.list(fromKey)).toEqual([plan.events[0].id]);
    expect((await f.mailbox.list(toKey)).sort()).toEqual([gap.eventId, plan.events[1].id].sort());
    expect(handoffOwners(await readHandoffProvenance(f.runs[0]!))).toHaveLength(2);
  });

  it("holds run AND mailbox flocks across the frozen journal/provenance/move/event section", async () => {
    const f = await fixture();
    let release!: () => void; let entered!: () => void;
    const paused = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const withMailboxes = f.mailbox.withMailboxes.bind(f.mailbox);
    const wrapped: Mailbox = { ...f.mailbox, withMailboxes: (keys, section) => withMailboxes(keys, (locked) => section({ ...locked,
      moveUnread: async (...args) => { entered(); await gate; return locked.moveUnread(...args); },
    })) };
    const operation = createOwnership({ ...f.options, mailbox: wrapped }).transfer({ caller: owner, runIds: f.runIds, successorPaneId: successor.paneId });
    await paused;
    expect((await journal(f)).runIds).toEqual(f.runIds);
    expect(currentHandoffOwner(await readHandoffProvenance(f.runs[0]!))).toEqual(successor.session);
    for (const path of [f.runs[0]!.lockPath, join(f.namespace.dir, "mailbox", "index.lock"),
      ...[fromKey, toKey].map((key) => join(f.namespace.dir, "mailbox", key, "mailbox.lock"))]) {
      await expect(acquireFlockHolder({ lockPath: path, wait: "nonblock", readyMarker: "TEST_READY", subject: "test", failure: (message) => new Error(message) })).rejects.toThrow();
    }
    const late = f.mailbox.writeRunEvent({ kind: "late", runId: f.runIds[0]!, jobId: "job" });
    const ack = f.mailbox.checkLaunchCapacity(fromKey);
    release(); await operation;
    const written = await late; await ack;
    expect(await f.mailbox.list(toKey)).toContain(written.eventId);
    expect(await f.mailbox.list(fromKey)).not.toContain(written.eventId);
  });

  it("records double-absent frozen files as durable loss, never moved", async () => {
    const f = await fixture();
    const gap = await f.mailbox.writeGapEvent(fromKey, { from: "before", to: "now", lost: {} });
    const original = f.mailbox.withMailboxes.bind(f.mailbox);
    const outcomes: unknown[] = [];
    const wrapped: Mailbox = { ...f.mailbox, withMailboxes: (keys, section) => original(keys, (locked) => section({ ...locked,
      moveUnread: async (...args) => {
        await rm(join(f.namespace.dir, "mailbox", fromKey, "unread", `${gap.eventId}.json`));
        const outcome = await locked.moveUnread(...args); outcomes.push(outcome); return outcome;
      },
    })) };
    await createOwnership({ ...f.options, mailbox: wrapped }).transfer({ caller: owner, runIds: f.runIds, successorPaneId: successor.paneId });
    expect(outcomes).toEqual([{ moved: [], alreadyAtDestination: [], lost: [gap.eventId] }]);
    expect((await f.mailbox.degradation()).unpersisted[fromKey]?.count).toBe(1);
  });

  it("claims require exact instructed sets, absent owner, exact successor, and no unresolved intent", async () => {
    const f = await fixture(2);
    await f.instruction();
    await expect(f.ownership.claim({ caller: successor, runIds: f.runIds, incidentId: "incident" })).rejects.toMatchObject({ code: "OWNER_PRESENT" });
    f.readSnapshot.mockResolvedValue(snapshot([pane(successor.paneId, successor.session)]));
    await expect(f.ownership.claim({ caller: successor, runIds: [f.runIds[0]!], incidentId: "incident" })).rejects.toMatchObject({ code: "CLAIM_NOT_INSTRUCTED" });
    await f.instruction([f.runIds[0]!]);
    await expect(f.ownership.claim({ caller: successor, runIds: f.runIds, incidentId: "incident" })).rejects.toMatchObject({ code: "CLAIM_NOT_INSTRUCTED" });
    await f.instruction(); await interruptedIntent(f);
    await expect(f.ownership.claim({ caller: successor, runIds: f.runIds, incidentId: "incident" })).rejects.toMatchObject({ code: "OWNER_INTENT_UNRESOLVED" });
    expect(f.retarget).not.toHaveBeenCalled();
    expect(isClaimRecord({ ...(await f.instruction()), instruction: "" })).toBe(false);
  });

  it("consumes the claim before mutations; resumes without it; refuses a crash-leftover instruction afterward", async () => {
    const f = await fixture(); const record = await f.instruction();
    f.readSnapshot.mockResolvedValue(snapshot([pane(successor.paneId, successor.session)]));
    const writeProvenance = handoff.writeHandoffProvenance;
    const verifyConsumption = vi.spyOn(handoff, "writeHandoffProvenance").mockImplementation(async (run, provenance) => {
      await expect(readFile(join(f.namespace.dir, "claims", "incident.json"))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readHandoffProvenance(run)).v).toBe(1);
      return writeProvenance(run, provenance);
    });
    const original = f.mailbox.withMailboxes.bind(f.mailbox);
    const wrapped: Mailbox = { ...f.mailbox, withMailboxes: (keys, section) => original(keys, (locked) => section({ ...locked,
      moveUnread: async () => {
        expect(await readdir(join(f.namespace.dir, "claims", "used"))).toEqual(["incident.json"]);
        expect(currentHandoffOwner(await readHandoffProvenance(f.runs[0]!))).toEqual(successor.session);
        throw new Error("interrupted");
      },
    })) };
    await expect(createOwnership({ ...f.options, mailbox: wrapped }).claim({ caller: successor, runIds: f.runIds, incidentId: "incident" })).rejects.toThrow("interrupted");
    verifyConsumption.mockRestore();
    expect((await journal(f)).incidentId).toBe("incident");
    await rm(join(f.namespace.dir, "claims", "used", "incident.json"));
    await f.ownership.completePending();
    await writeFile(join(f.namespace.dir, "claims", "incident.json"), JSON.stringify(record), { mode: 0o600 });
    await expect(f.ownership.claim({ caller: successor, runIds: f.runIds, incidentId: "incident" })).rejects.toMatchObject({ code: "CLAIM_NOT_INSTRUCTED" });
  });

  it("retains failed event journals and does not disguise storage faults as capacity", async () => {
    const f = await fixture();
    const original = f.mailbox.withMailboxes.bind(f.mailbox);
    const wrapped: Mailbox = { ...f.mailbox, withMailboxes: (keys, section) => original(keys, (locked) => section({ ...locked,
      writeRecordedEvent: async (_key, event) => ({ persisted: false, persistenceFailed: true, eventId: event.id, reason: "unavailable", at: event.at }),
    })) };
    await expect(createOwnership({ ...f.options, mailbox: wrapped }).transfer({ caller: owner, runIds: f.runIds, successorPaneId: successor.paneId })).rejects.toMatchObject({ code: "TRANSFER_EVENT_FAILED" });
    expect(await f.ownership.pendingTransfers()).toHaveLength(1);
    await expect(reattachDaemonRuns({ ...f.options, mailbox: wrapped, runs: f.runNamespace, startedAt: new Date().toISOString(),
      jobs: { activeSupervisorFor: () => undefined }, supervision: { reserve: vi.fn() } as never,
    })).rejects.toMatchObject({ code: "TRANSFER_EVENT_FAILED" });
  });

  it("D4 completes the journal before reading its fresh snapshot", async () => {
    const f = await fixture();
    f.retarget.mockRejectedValueOnce(new Error("stop"));
    await expect(f.ownership.transfer({ caller: owner, runIds: f.runIds, successorPaneId: successor.paneId })).rejects.toThrow("stop");
    const plan = await journal(f);
    await reattachDaemonRuns({ ...f.options, runs: f.runNamespace, startedAt: new Date().toISOString(),
      snapshot: async () => {
        expect(await readdir(join(f.namespace.dir, "transfers", "done"))).toContain(`${plan.transferId}.json`);
        return snapshot();
      }, jobs: { activeSupervisorFor: () => undefined }, supervision: { reserve: vi.fn() } as never,
    });
  });

  it("keeps ack/status available at cap; draining resumes frozen events without repeating moved files", async () => {
    const f = await fixture();
    const moved = await f.mailbox.writeGapEvent(fromKey, { from: "before", to: "now", lost: {} });
    await f.mailbox.checkLaunchCapacity(toKey); // create the successor directories
    const ids = Array.from({ length: 500 }, () => mailboxEventId());
    await Promise.all(ids.map((id) => writeFile(join(f.namespace.dir, "mailbox", toKey, "unread", `${id}.json`), JSON.stringify({ id }), { mode: 0o600 })));
    await expect(f.ownership.transfer({ caller: owner, runIds: f.runIds, successorPaneId: successor.paneId })).rejects.toMatchObject({ code: "TRANSFER_PENDING" });
    expect(f.retarget).not.toHaveBeenCalled();
    const plan = await journal(f);
    expect(plan.movesComplete).toBe(true);
    expect(await f.mailbox.list(toKey)).toHaveLength(501);
    await expect(f.mailbox.checkLaunchCapacity(toKey)).resolves.toMatchObject({ ok: false, code: "MAILBOX_CAPACITY" });
    await expect(reattachDaemonRuns({ ...f.options, runs: f.runNamespace, startedAt: new Date().toISOString(),
      jobs: { activeSupervisorFor: () => undefined }, supervision: { reserve: vi.fn() } as never,
    })).resolves.toMatchObject({ pendingTransfers: [plan.transferId] });
    await f.mailbox.ack(toKey, moved.eventId);
    await f.mailbox.ack(toKey, ids[0]!);
    const losses = (await f.mailbox.degradation()).unpersisted[fromKey]?.count;
    // Every ownership operation first completes the frozen journal; this caller
    // then refuses because the now-current owner is the successor.
    await expect(f.ownership.transfer({ caller: owner, runIds: f.runIds, successorPaneId: successor.paneId })).rejects.toMatchObject({ code: "OWNER_MISMATCH" });
    await f.ownership.completePending();
    expect((await f.mailbox.degradation()).unpersisted[fromKey]?.count).toBe(losses);
    expect((await f.mailbox.list(fromKey)).filter((id) => id === plan.events[0].id)).toHaveLength(1);
    expect((await f.mailbox.list(toKey)).filter((id) => id === plan.events[1].id)).toHaveLength(1);
    expect(handoffOwners(await readHandoffProvenance(f.runs[0]!))).toHaveLength(2);
    expect(await readdir(join(f.namespace.dir, "transfers", "done"))).toEqual([`${plan.transferId}.json`]);
  });

  it("reconciles EVERY replica: exact bind + absent disposition cannot close while any child is ambiguous", async () => {
    const f = await fixture(3); const intent = await interruptedIntent(f);
    const before = await readHandoffState(f.runs[1]!);
    const bind = vi.fn(async () => undefined);
    const ambiguous = pane("child-2", session("/different.jsonl"));
    f.readSnapshot.mockResolvedValue(snapshot([pane("child-0"), ambiguous]));
    const partial = await f.ownership.reconcile(intent, bind);
    expect(partial.state).toBe("unresolved");
    expect(partial.children.map((child) => child.disposition)).toEqual(["bound", "identity_lost", "ambiguous"]);
    expect(bind).toHaveBeenCalledWith(f.runIds[0], { paneId: "child-0", terminalId: "term-child-0", agentName: "child-0", agentKind: "pi", agentSession: session("/child-0.jsonl") });
    const reread = await f.intents.get(fromKey, "key");
    expect(reread?.children[1]?.evidence).toMatchObject({ reason: "absent_from_snapshot", terminalId: "term-child-1", session: session("/child-1.jsonl") });
    expect(reread?.children[2]?.evidence).toMatchObject({ reason: "identity_ambiguous", terminalId: "term-child-2" });
    f.readSnapshot.mockResolvedValue(snapshot([pane("child-0")]));
    const completed = await f.ownership.reconcile(partial, bind);
    expect(completed).toMatchObject({ state: "completed", reconciled: true });
    expect(completed.children.map((child) => child.disposition)).toEqual(["bound", "identity_lost", "identity_lost"]);
    expect(await readHandoffState(f.runs[1]!)).toEqual(before);
  });

  it("does not count unresolved/no-run children or failed binds as classified", async () => {
    const f = await fixture(); const intent = await interruptedIntent(f);
    f.readSnapshot.mockResolvedValue(snapshot([pane("child-0")]));
    const pending = await f.ownership.reconcile(intent, async () => { throw new Error("bind failed"); });
    expect(pending.state).toBe("unresolved");
    expect(pending.children[0]?.disposition).toBe("ambiguous");
    const begin = await f.intents.begin({ managerSessionKey: fromKey, idempotencyKey: "no-run", task, projectRoot: f.root });
    const unknown = await f.intents.fail(begin.intent, { effectCertainty: "unknown", children: [{ name: "unknown" }] });
    const bind = vi.fn(async () => undefined);
    expect(await f.ownership.reconcile(unknown, bind)).toMatchObject({ state: "unresolved", children: [{ disposition: "ambiguous" }] });
    expect(bind).not.toHaveBeenCalled();
    expect(await f.ownership.ownerOfRun(f.runIds[0]!)).toBe(fromKey);
    expect(isClaimRecord({ priorOwnerSession: owner.session, successorSession: successor.session, runIds: [randomUUID(), randomUUID()], instruction: "ok", instructedAt: "invalid" })).toBe(false);
    expect(mailboxEventId()).toMatch(/Z-/);
  });

  it("refuses malformed runIds and callers the snapshot cannot verify", async () => {
    const f = await fixture();
    await expect(f.ownership.transfer({ caller: owner, runIds: ["not-a-run"], successorPaneId: successor.paneId }))
      .rejects.toMatchObject({ code: "RUN_IDS_INVALID" });
    // The caller's pane is absent from the authoritative snapshot — unverifiable.
    f.readSnapshot.mockResolvedValue(snapshot([pane(successor.paneId, successor.session)]));
    await expect(f.ownership.transfer({ caller: owner, runIds: f.runIds, successorPaneId: successor.paneId }))
      .rejects.toMatchObject({ code: "CONTEXT_UNAVAILABLE" });
  });

  it("refuses claim instructions that are absent, malformed, misscoped, or unreadable", async () => {
    const f = await fixture();
    f.readSnapshot.mockResolvedValue(snapshot([pane(successor.paneId, successor.session)]));
    const claim = () => f.ownership.claim({ caller: successor, runIds: f.runIds, incidentId: "incident" });
    await expect(claim()).rejects.toMatchObject({ code: "CLAIM_NOT_INSTRUCTED" });
    const claims = join(f.namespace.dir, "claims");
    const write = async (body: unknown) => {
      await mkdir(claims, { recursive: true, mode: 0o700 });
      await writeFile(join(claims, "incident.json"), JSON.stringify(body), { mode: 0o600 });
    };
    // A session that is not a record fails the shape validator.
    await write({ priorOwnerSession: "not-a-record", successorSession: successor.session, runIds: f.runIds, instructedAt: new Date().toISOString(), instruction: "x" });
    await expect(claim()).rejects.toMatchObject({ code: "CLAIM_NOT_INSTRUCTED" });
    // A record missing a field fails the same way.
    await write({ priorOwnerSession: owner.session, successorSession: successor.session, runIds: f.runIds });
    await expect(claim()).rejects.toMatchObject({ code: "CLAIM_NOT_INSTRUCTED" });
    // An instruction whose run set is not exactly the claimed set refuses.
    await f.instruction([...f.runIds, randomUUID()]);
    await expect(claim()).rejects.toMatchObject({ code: "CLAIM_NOT_INSTRUCTED" });
    // A record path that is not a file fails the trust check the same way.
    await rm(join(claims, "incident.json"));
    await mkdir(join(claims, "incident.json"), { mode: 0o700 });
    await expect(claim()).rejects.toMatchObject({ code: "CLAIM_NOT_INSTRUCTED" });
  });

  it("reports a run with no live owner as OWNER_UNAVAILABLE, never silently owns it", async () => {
    const f = await fixture();
    const orphan = await f.allocator.allocate();
    await f.allocator.persist(orphan, { manager: { paneId: "x", display: "x", source: "agent_name" }, child: { agentName: "c", agentKind: "pi", operatingPointId: "pi", specLabel: "t", fallbackCandidates: [] } }, { managerSession: null, task });
    await expect(f.mailbox.writeRunEvent({ kind: "work_cycle_completed", runId: orphan.runId, jobId: "j" }))
      .rejects.toMatchObject({ code: "OWNER_UNAVAILABLE" });
  });

  it("fails closed when the journal root or a pending record is untrusted", async () => {
    const f = await fixture();
    // The pending projection on a never-created root is empty, not an error.
    await expect(f.ownership.pendingTransfers()).resolves.toEqual([]);
    // A root that exists but is not a directory fails closed.
    const transfers = join(f.namespace.dir, "transfers");
    await writeFile(transfers, "x", { mode: 0o600 });
    await expect(f.ownership.pendingTransfers()).rejects.toMatchObject({ code: "OWNERSHIP_UNTRUSTED" });
    await rm(transfers);
    // A record whose content is not a transfer plan, or whose name does not
    // match its transferId, refuses the whole projection.
    await mkdir(transfers, { mode: 0o700 });
    await writeFile(join(transfers, "zzz.json"), JSON.stringify({ v: 1 }), { mode: 0o600 });
    await expect(f.ownership.pendingTransfers()).rejects.toMatchObject({ code: "TRANSFER_MALFORMED" });
    await rm(join(transfers, "zzz.json"));
    await f.ownership.transfer({ caller: owner, runIds: f.runIds, successorPaneId: successor.paneId });
    const [done] = await readdir(join(transfers, "done"));
    await writeFile(join(transfers, "wrong-name.json"), await readFile(join(transfers, "done", done!)), { mode: 0o600 });
    await expect(f.ownership.pendingTransfers()).rejects.toMatchObject({ code: "TRANSFER_MALFORMED" });
  });

  it("fails closed when the journal or run flock cannot be taken", { timeout: 15_000 }, async () => {
    const f = await fixture();
    await mkdir(join(f.namespace.dir, "transfers"), { mode: 0o700 });
    const opts = { wait: "nonblock" as const, readyMarker: "TEST_READY", subject: "test", failure: (m: string) => new Error(m) };
    const [journal, run] = await Promise.all([
      acquireFlockHolder({ lockPath: join(f.namespace.dir, "transfers", "lock"), ...opts }),
      acquireFlockHolder({ lockPath: f.runs[0]!.lockPath, ...opts }),
    ]);
    try {
      await Promise.all([
        expect(f.ownership.completePending()).rejects.toMatchObject({ code: "OWNERSHIP_UNAVAILABLE" }),
        expect(daemonRunOwnership(f.allocator).withRunFlock(f.runIds[0]!, async () => 1)).rejects.toMatchObject({ code: "OWNERSHIP_UNAVAILABLE" }),
      ]);
    } finally {
      await journal.release();
      await run.release();
    }
  });

  it("fails closed when the journal directory cannot be created or trusted", async () => {
    const f = await fixture();
    const transfers = join(f.namespace.dir, "transfers");
    // mkdir on an existing non-directory passes EEXIST into the trust assert.
    await writeFile(transfers, "x", { mode: 0o600 });
    await expect(f.ownership.completePending()).rejects.toMatchObject({ code: "OWNERSHIP_UNTRUSTED" });
    await rm(transfers);
    // A non-EEXIST mkdir failure propagates raw — the namespace root read-only.
    await chmod(f.namespace.dir, 0o500);
    try {
      await expect(f.ownership.completePending()).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await chmod(f.namespace.dir, 0o700);
    }
  });

  it("vetoes a transfer while any owner intent is unresolved or mid-effect", async () => {
    const f = await fixture();
    const begun = await f.intents.begin({ managerSessionKey: fromKey, idempotencyKey: "k", task, projectRoot: f.root });
    if (begun.kind !== "launch") throw new Error("expected launch");
    await f.intents.markEffecting(begun.intent);
    await expect(f.ownership.transfer({ caller: owner, runIds: f.runIds, successorPaneId: successor.paneId }))
      .rejects.toMatchObject({ code: "OWNER_INTENT_UNRESOLVED" });
  });

  it("refuses to reconcile an intent that has already settled", async () => {
    const f = await fixture();
    const intent = await interruptedIntent(f);
    f.readSnapshot.mockResolvedValue(snapshot([pane("child-0")]));
    const settled = await f.ownership.reconcile(intent, async () => undefined);
    expect(settled.state).toBe("completed");
    // Both the settled record and the now-stale unresolved one conflict.
    await expect(f.ownership.reconcile(settled, async () => undefined)).rejects.toMatchObject({ code: "INTENT_STATE_CONFLICT" });
    await expect(f.ownership.reconcile(intent, async () => undefined)).rejects.toMatchObject({ code: "INTENT_STATE_CONFLICT" });
  });

  it("classifies a child whose recorded identity carries no terminal or session", async () => {
    const f = await fixture();
    await updateHandoffState(f.runs[0]!, (state) => { state.child.terminalId = null; state.nativeSession = null; });
    const intent = await interruptedIntent(f);
    const partial = await f.ownership.reconcile(intent, async () => undefined);
    expect(partial.state).toBe("unresolved");
    expect(partial.children[0]!).toMatchObject({ disposition: "ambiguous", evidence: { reason: "identity_unproven" } });
    expect(partial.children[0]!.evidence).not.toHaveProperty("terminalId");
    expect(partial.children[0]!.evidence).not.toHaveProperty("session");
  });

  it("refuses non-record claim instructions before reading any field", async () => {
    for (const value of [null, "instruction", 7]) expect(isClaimRecord(value)).toBe(false);
  });

  it("fails closed when a caller's pane resolves to no session at all", async () => {
    const f = await fixture();
    // The caller's pane is present but carries no agent_session — the claimed
    // session can never be proven, so the refusal is a mismatch, not absent.
    const unproven = snapshot([pane(owner.paneId, owner.session), pane(successor.paneId, successor.session)]);
    delete unproven.panes[0]!.agent_session;
    delete unproven.agents[0]!.agent_session;
    f.readSnapshot.mockResolvedValueOnce(unproven);
    await expect(f.ownership.transfer({ caller: owner, runIds: f.runIds, successorPaneId: successor.paneId }))
      .rejects.toMatchObject({ code: "OWNER_MISMATCH" });
  });

  it("refuses a transfer of a run whose provenance records no owner", async () => {
    const f = await fixture();
    const orphan = await f.allocator.allocate();
    await f.allocator.persist(orphan, { manager: { paneId: owner.paneId, display: "owner", source: "agent_name" },
      child: { agentName: "orphan", agentKind: "pi", operatingPointId: "pi", specLabel: "test", fallbackCandidates: [] } },
      { managerSession: null, task });
    await expect(f.ownership.transfer({ caller: owner, runIds: [orphan.runId], successorPaneId: successor.paneId }))
      .rejects.toMatchObject({ code: "OWNER_MISMATCH" });
  });

  it("refuses a malformed incident id before touching the claims directory", async () => {
    const f = await fixture();
    f.readSnapshot.mockResolvedValue(snapshot([pane(successor.paneId, successor.session)]));
    await expect(f.ownership.claim({ caller: successor, runIds: f.runIds, incidentId: "not an identifier" }))
      .rejects.toMatchObject({ code: "CLAIM_NOT_INSTRUCTED" });
  });

  it("propagates a non-absent journal fault instead of swallowing it as a remnant", async () => {
    const f = await fixture();
    // A directory where a journaled record belongs fails the open, not the filter.
    await mkdir(join(f.namespace.dir, "transfers", "planted.json"), { mode: 0o700, recursive: true });
    await expect(f.ownership.pendingTransfers()).rejects.toThrow();
  });

  it("propagates a rename fault inside the pending-journal replay", async () => {
    const f = await fixture();
    f.retarget.mockRejectedValueOnce(new Error("interrupted"));
    await expect(f.ownership.transfer({ caller: owner, runIds: f.runIds, successorPaneId: successor.paneId })).rejects.toThrow("interrupted");
    const plan = await journal(f);
    // A directory occupying the done slot makes the journal's rename fail with EISDIR, never ENOENT.
    await mkdir(join(f.namespace.dir, "transfers", "done", `${plan.transferId}.json`), { mode: 0o700, recursive: true });
    await expect(f.ownership.transfer({ caller: owner, runIds: f.runIds, successorPaneId: successor.paneId })).rejects.toThrow();
  });

  it("preserves already-closed owner entries when a run transfers a second time", async () => {
    const f = await fixture();
    await f.ownership.transfer({ caller: owner, runIds: f.runIds, successorPaneId: successor.paneId });
    // The second transfer maps an owner history whose first entry already has
    // `to` set — the journal must close only the open tail, not rewrite history.
    const third = { paneId: "third", session: session("/third.jsonl") };
    f.readSnapshot.mockResolvedValueOnce(snapshot([pane(successor.paneId, successor.session), pane(third.paneId, third.session)]));
    await f.ownership.transfer({ caller: successor, runIds: f.runIds, successorPaneId: third.paneId });
    const record = await readHandoffProvenance(await f.allocator.open(f.runIds[0]!));
    const owners = handoffOwners(record);
    expect(owners).toHaveLength(3);
    expect(owners.map((entry) => entry.session?.value)).toEqual(["/owner.jsonl", "/successor.jsonl", "/third.jsonl"]);
    expect(owners[0]!.to).not.toBeNull();
    expect(owners[1]!.to).not.toBeNull();
    expect(owners[2]!.to).toBeNull();
  });
});
