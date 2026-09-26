/** §8 ownership: one frozen transfer journal, replayed under run + mailbox flocks. */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveManagerSession } from "../context.js";
import {
  currentHandoffOwner, handoffOwners, readHandoffProvenance, readHandoffState,
  RUN_ID_PATTERN, validHandoffOwners, writeFileAtomic, writeHandoffProvenance,
  type HandoffAllocator, type HandoffProvenanceV2,
} from "../handoff.js";
import type { AgentSessionIdentity } from "../messages/prompt.js";
import { acquireFlockHolder, assertOwnerOnlyDirectory } from "../pane-write-lock.js";
import type { SupervisedIdentity } from "../supervision/identity.js";
import type { HerdrSnapshot } from "../targets.js";
import { managerSessionKey, type IntentStore, type LaunchIntentRecord, type LaunchIntentChild } from "./intents.js";
import { mailboxEventId, type LockedMailboxes, type Mailbox, type MailboxRunEvent, type MailboxRunOwnership } from "./mailbox.js";
import type { DaemonNamespace } from "./namespace.js";
import { classifyChild } from "./reattach.js";

export class OwnershipError extends Error {
  constructor(readonly code: string) { super(code); this.name = "OwnershipError"; }
}
const refuse = (code: string): never => { throw new OwnershipError(code); };
const same = (a: AgentSessionIdentity, b: AgentSessionIdentity) => managerSessionKey(a) === managerSessionKey(b);
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const session = (value: unknown): value is AgentSessionIdentity => {
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return Object.keys(obj).length === 4 && ["source", "agent", "kind", "value"].every((key) => typeof obj[key] === "string" && obj[key].length > 0 && !/[\0\r\n]/.test(obj[key]));
};
function runs(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((id) => typeof id === "string" && RUN_ID_PATTERN.test(id)) && new Set(value).size === value.length;
}

/** Owner-written, per-incident instruction. No subset/superset authorization. */
export interface ClaimRecord {
  priorOwnerSession: AgentSessionIdentity;
  successorSession: AgentSessionIdentity;
  runIds: string[];
  instructedAt: string;
  instruction: string;
}
export function isClaimRecord(value: unknown): value is ClaimRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as ClaimRecord;
  return Object.keys(record).length === 5 && session(record.priorOwnerSession) && session(record.successorSession)
    && runs(record.runIds) && typeof record.instructedAt === "string" && Number.isFinite(Date.parse(record.instructedAt))
    && typeof record.instruction === "string" && record.instruction.trim().length > 0 && !record.instruction.includes("\0");
}
export interface OwnershipCaller { paneId: string; session: AgentSessionIdentity }
export interface TransferRecord {
  v: 1;
  transferId: string;
  runIds: string[];
  priorOwnerSession: AgentSessionIdentity;
  successor: OwnershipCaller;
  fromKey: string;
  toKey: string;
  provenance: Array<Pick<HandoffProvenanceV2, "runId" | "owners">>;
  /** Exact frozen filenames, including mailbox-global events. */
  unread: string[];
  events: [MailboxRunEvent, MailboxRunEvent];
  incidentId?: string;
  /** Checkpoint before event-capacity retries, so handled moved files are not mistaken for loss. */
  movesComplete?: true;
}
const EVENT_FILE = /^\d{4}-\d{2}-\d{2}T\d{6}\.\d{3}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
export function isTransferRecord(value: unknown): value is TransferRecord {
  if (value === null || typeof value !== "object") return false;
  const plan = value as TransferRecord;
  if (plan.v !== 1 || !RUN_ID_PATTERN.test(plan.transferId) || !runs(plan.runIds)
    || !session(plan.priorOwnerSession) || !session(plan.successor?.session)
    || typeof plan.successor.paneId !== "string" || plan.successor.paneId.length === 0
    || plan.fromKey !== managerSessionKey(plan.priorOwnerSession) || plan.toKey !== managerSessionKey(plan.successor.session) || plan.fromKey === plan.toKey
    || !Array.isArray(plan.provenance) || plan.provenance.length !== plan.runIds.length
    || plan.provenance.some((entry, index) => entry?.runId !== plan.runIds[index] || !validHandoffOwners(entry.owners)
      || entry.owners.length < 2 || entry.owners.at(-1)!.session === null || !same(entry.owners.at(-1)!.session!, plan.successor.session))
    || !Array.isArray(plan.unread) || !plan.unread.every((entry) => typeof entry === "string" && EVENT_FILE.test(entry)) || new Set(plan.unread).size !== plan.unread.length
    || (plan.incidentId !== undefined && !identifier(plan.incidentId))
    || (plan.movesComplete !== undefined && plan.movesComplete !== true)
    || !Array.isArray(plan.events) || plan.events.length !== 2) return false;
  return plan.events.every((event) => event !== null && typeof event === "object"
    && EVENT_FILE.test(`${event.id}.json`) && typeof event.at === "string" && Number.isFinite(Date.parse(event.at))
    && event.kind === "transfer" && event.runId === plan.runIds[0] && event.jobId === plan.transferId
    && Array.isArray(event.actions) && event.actions.length === 2 && event.actions[0] === plan.fromKey && event.actions[1] === plan.toKey)
    && plan.events[0].id !== plan.events[1].id;
}
export interface OwnershipOptions {
  namespace: DaemonNamespace;
  allocator: HandoffAllocator;
  intents: IntentStore;
  /** Only the multi-mailbox flock section is used; projection reads go elsewhere. */
  mailbox: Pick<Mailbox, "withMailboxes">;
  snapshot(): Promise<HerdrSnapshot>;
  /** In-memory supervisor/hint retarget, replay-safe; D4 rebinds afterward. */
  retarget?(runIds: string[], successor: OwnershipCaller): Promise<void>;
  now?: () => Date;
}

/** The SAME run lock used by sidecar mutations and every run-scoped event write. */
export function daemonRunOwnership(allocator: HandoffAllocator): MailboxRunOwnership & Required<Pick<MailboxRunOwnership, "withRunFlock">> {
  return {
    async ownerOfRun(runId) {
      const owner = currentHandoffOwner(await readHandoffProvenance(await allocator.open(runId)));
      if (owner === null) return refuse("OWNER_UNAVAILABLE");
      return managerSessionKey(owner);
    },
    async withRunFlock(runId, section) {
      const run = await allocator.open(runId);
      const holder = await acquireFlockHolder({
        lockPath: run.lockPath, wait: { timeoutMs: 5_000 }, readyMarker: "HERDR_HANDOFF_LOCK_READY",
        subject: "Handoff state lock", failure: () => new OwnershipError("OWNERSHIP_UNAVAILABLE"),
      });
      try { return await section(); } finally { await holder.release(); }
    },
  };
}

async function directory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 }).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  assertOwnerOnlyDirectory(path, await lstat(path), () => new OwnershipError("OWNERSHIP_UNTRUSTED"), "Ownership");
}
async function sync(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function moveRecord(source: string, destination: string, sourceOptional = false): Promise<void> {
  await directory(dirname(destination));
  try { await rename(source, destination); }
  catch (error) {
    if (!absent(error)) throw error;
    /* c8 ignore next -- a required source is proven present before the move; only a crash-remnant race reaches the verify. */
    if (!sourceOptional) await lstat(destination);
  }
  await sync(dirname(source));
  await sync(dirname(destination));
}
async function readRecord(path: string): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) refuse("OWNERSHIP_UNTRUSTED");
    return JSON.parse(await handle.readFile("utf8")) as unknown;
  } finally { await handle.close(); }
}

export function createOwnership(options: OwnershipOptions) {
  const ownership = daemonRunOwnership(options.allocator);
  const root = join(options.namespace.dir, "transfers");
  const claims = join(options.namespace.dir, "claims");
  const now = options.now ?? (() => new Date());
  async function withRuns<T>(ids: string[], section: () => Promise<T>): Promise<T> {
    const ordered = [...ids].sort();
    const next = (index: number): Promise<T> => index === ordered.length ? section() : ownership.withRunFlock(ordered[index]!, () => next(index + 1));
    return next(0);
  }
  function verify(snapshot: HerdrSnapshot, caller: OwnershipCaller): AgentSessionIdentity {
    const found = resolveManagerSession(snapshot, caller.paneId);
    if (found === null || !session(caller.session) || !same(found, caller.session)) return refuse("OWNER_MISMATCH");
    return found;
  }
  function successor(snapshot: HerdrSnapshot, paneId: string): OwnershipCaller {
    const found = resolveManagerSession(snapshot, paneId);
    if (found === null || !["pi", "claude", "devin"].includes(found.agent)) return refuse("SUCCESSOR_UNPROVEN");
    return { paneId, session: found };
  }
  async function finish(plan: TransferRecord, locked: LockedMailboxes): Promise<void> {
    // Consumed BEFORE provenance, moves, or events. Restart never reads it.
    if (plan.incidentId !== undefined) {
      await directory(claims);
      await moveRecord(join(claims, `${plan.incidentId}.json`), join(claims, "used", `${plan.incidentId}.json`), true);
    }
    for (const entry of plan.provenance) {
      const run = await options.allocator.open(entry.runId);
      const original = await readHandoffProvenance(run);
      await writeHandoffProvenance(run, { ...original, v: 2, owners: entry.owners });
    }
    if (plan.movesComplete !== true) {
      await locked.moveUnread(plan.fromKey, plan.toKey, plan.unread.map((name) => name.slice(0, -5)));
      plan.movesComplete = true;
      await writeFileAtomic(join(root, `${plan.transferId}.json`), JSON.stringify(plan));
    }
    for (const [index, key] of [plan.fromKey, plan.toKey].entries()) {
      const result = await locked.writeRecordedEvent(key, plan.events[index]!);
      if (!result.persisted) refuse(result.reason === "capacity" ? "TRANSFER_PENDING" : "TRANSFER_EVENT_FAILED");
    }
    await options.retarget?.(plan.runIds, plan.successor);
    await moveRecord(join(root, `${plan.transferId}.json`), join(root, "done", `${plan.transferId}.json`));
  }
  async function pendingRecords(): Promise<TransferRecord[]> {
    let names: string[];
    try {
      assertOwnerOnlyDirectory(root, await lstat(root), () => new OwnershipError("OWNERSHIP_UNTRUSTED"), "Ownership");
      names = await readdir(root);
    } catch (error) { if (absent(error)) return []; throw error; }
    const plans: TransferRecord[] = [];
    for (const name of names.filter((name) => name.endsWith(".json")).sort()) {
      let plan: TransferRecord;
      try { plan = await readRecord(join(root, name)) as TransferRecord; }
      catch (error) {
        /* c8 ignore next -- a journal vanishing between readdir and read is a crash-remnant TOCTOU the retry absorbs. */
        if (absent(error)) continue;
        throw error;
      }
      if (!isTransferRecord(plan) || name !== `${plan.transferId}.json`) refuse("TRANSFER_MALFORMED");
      plans.push(plan);
    }
    return plans;
  }
  /** Read-only status projection: no mkdir, lock files, writes, or cursors. */
  async function pendingTransfers() {
    return (await pendingRecords()).map(({ transferId, runIds, fromKey, toKey, events }) => ({ transferId, runIds, fromKey, toKey, events }));
  }
  async function replayPending(): Promise<void> {
    for (const plan of await pendingRecords()) {
      await withRuns(plan.runIds, () => options.mailbox.withMailboxes([plan.fromKey, plan.toKey], (locked) => finish(plan, locked)));
    }
  }
  // ponytail: ownership operations serialize globally; per-run locks still arbitrate
  // mailbox writers. Split the journal lock only if ownership throughput matters.
  async function serialized<T>(section: () => Promise<T>): Promise<T> {
    await directory(root);
    const holder = await acquireFlockHolder({ lockPath: join(root, "lock"), wait: { timeoutMs: 5_000 },
      readyMarker: "HERDR_TRANSFER_READY", subject: "Ownership", failure: () => new OwnershipError("OWNERSHIP_UNAVAILABLE") });
    try { return await section(); } finally { await holder.release(); }
  }
  const completePending = () => serialized(replayPending);
  async function change(input: { caller: OwnershipCaller; runIds: string[]; successorPaneId?: string; incidentId?: string }): Promise<TransferRecord> {
    if (!runs(input.runIds)) return refuse("RUN_IDS_INVALID");
    return serialized(async () => {
      await replayPending();
      return withRuns(input.runIds, async () => {
        const snapshot = await options.snapshot();
        const caller = verify(snapshot, input.caller);
        const records = await Promise.all(input.runIds.map(async (id) => readHandoffProvenance(await options.allocator.open(id))));
        const prior = currentHandoffOwner(records[0]!);
        const claiming = input.incidentId !== undefined;
        const mismatch = claiming ? "CLAIM_NOT_INSTRUCTED" : "OWNER_MISMATCH";
        if (prior === null || records.some((record) => { const owner = currentHandoffOwner(record); return owner === null || !same(owner, prior); })) return refuse(mismatch);
        const target = successor(snapshot, claiming ? input.caller.paneId : input.successorPaneId!);
        if (claiming) {
          if (!identifier(input.incidentId)) return refuse("CLAIM_NOT_INSTRUCTED");
          await directory(claims);
          let instruction: unknown;
          try { instruction = await readRecord(join(claims, `${input.incidentId}.json`)); } catch { return refuse("CLAIM_NOT_INSTRUCTED"); }
          if (!isClaimRecord(instruction) || !same(instruction.priorOwnerSession, prior) || !same(instruction.successorSession, caller)
            || instruction.runIds.length !== input.runIds.length || instruction.runIds.some((id) => !input.runIds.includes(id))) return refuse("CLAIM_NOT_INSTRUCTED");
          for (const pane of snapshot.panes) {
            const occupant = resolveManagerSession(snapshot, pane.pane_id);
            if (occupant !== null && same(occupant, prior)) return refuse("OWNER_PRESENT");
          }
        } else if (!same(caller, prior)) return refuse("OWNER_MISMATCH");
        /* c8 ignore next -- resolveManagerSession binds a session to exactly one pane, so a successor resolving to `prior` fails CONTEXT_UNAVAILABLE (transfer) or OWNER_PRESENT (claim) before this line; kept as a fail-closed defense. */
        if (same(target.session, prior)) return refuse(mismatch);
        const fromKey = managerSessionKey(prior);
        if ((await options.intents.list(fromKey)).some((intent) => (intent.state === "unresolved" || intent.state === "effecting")
          && (!claiming || intent.children.length === 0 || intent.children.some((child) => child.runId === undefined || input.runIds.includes(child.runId))))) return refuse("OWNER_INTENT_UNRESOLVED");
        const toKey = managerSessionKey(target.session);
        return options.mailbox.withMailboxes([fromKey, toKey], async (locked) => {
          const at = now();
          const transferId = randomUUID();
          const plan: TransferRecord = {
            v: 1, transferId, runIds: [...input.runIds], priorOwnerSession: prior, successor: target, fromKey, toKey,
            provenance: records.map((record) => ({ runId: record.runId, owners: [
              ...handoffOwners(record).map((entry) => entry.to === null ? { ...entry, to: at.toISOString() } : entry),
              { session: target.session, from: at.toISOString(), to: null, reason: claiming ? "claim" : "transfer" },
            ] })),
            unread: (await locked.list(fromKey)).map((id) => `${id}.json`),
            events: [0, 1].map(() => ({ id: mailboxEventId(at), at: at.toISOString(), kind: "transfer", runId: input.runIds[0]!, jobId: transferId,
              actions: [fromKey, toKey] })) as [MailboxRunEvent, MailboxRunEvent],
            ...(input.incidentId === undefined ? {} : { incidentId: input.incidentId }),
          };
          const data = JSON.stringify(plan);
          /* c8 ignore next -- the record was just assembled from validated parts; the bound is a defense-in-depth guard. */
          if (!isTransferRecord(plan) || Buffer.byteLength(data) > 16 * 1024 * 1024) return refuse("TRANSFER_MALFORMED");
          await writeFileAtomic(join(root, `${transferId}.json`), data);
          await finish(plan, locked);
          return plan;
        });
      });
    });
  }
  return {
    ...ownership, completePending, pendingTransfers,
    transfer: (input: { caller: OwnershipCaller; runIds: string[]; successorPaneId: string }) => change(input),
    claim: (input: { caller: OwnershipCaller; runIds: string[]; incidentId: string }) => change(input),
    async reconcile(intent: LaunchIntentRecord, bind: (runId: string, identity: SupervisedIdentity) => Promise<void>): Promise<LaunchIntentRecord> {
      await completePending();
      const current = await options.intents.get(intent.managerSessionKey, intent.idempotencyKey);
      if (current === undefined || current.launchId !== intent.launchId || current.state !== "unresolved") return refuse("INTENT_STATE_CONFLICT");
      const snapshot = await options.snapshot();
      const dispositions = await Promise.all(current.children.map(async (child) => {
        let evidence: NonNullable<LaunchIntentChild["evidence"]> = { at: now().toISOString(), reason: "identity_unproven" };
        let disposition: "bound" | "identity_lost" | "ambiguous" = "ambiguous";
        if (child.runId !== undefined) {
          try {
            const state = await readHandoffState(await options.allocator.open(child.runId));
            evidence = { ...evidence, ...(state.child.terminalId === null ? {} : { terminalId: state.child.terminalId }), ...(state.nativeSession === null ? {} : { session: state.nativeSession }) };
            if (state.child.agentName === child.name && state.nativeSession !== null && state.child.terminalId !== null) {
              const verdict = classifyChild(snapshot, state);
              if (verdict.kind === "absent") { disposition = "identity_lost"; evidence.reason = "absent_from_snapshot"; }
              if (verdict.kind === "ambiguous") evidence.reason = "identity_ambiguous";
              if (verdict.kind === "matched") { await bind(child.runId, verdict.identity); disposition = "bound"; evidence.reason = "live_bound"; }
            }
          } catch { /* Unreadable sidecar or failed bind is ambiguous, never absence. */ }
        }
        return { ...child, disposition, evidence };
      }));
      return options.intents.reconcile(current, dispositions);
    },
  };
}
