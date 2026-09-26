/**
 * `run` — the ownership/handoff surface (durable-supervisor §8). `observe`
 * delegates to `resumeHandoff` — read-only, provenance-verified — plus the
 * intent that recorded the run and the run's unread mailbox events.
 * `reconcile` drives N2.4's ownership reconcile: classify an `unresolved`
 * intent's recorded children against the request's one fresh snapshot, bind
 * the live matches, and close it once every child is accounted for.
 * `transfer`/`claim` dispatch to the journaled N2.4 ownership change; `ack`
 * performs the caller's own-mailbox `unread/` → `acked/` rename after
 * handling — the key comes from the verified session, never from the wire.
 */

import { Value } from "typebox/value";
import { readHandoffProvenance, readHandoffState, RUN_ID_PATTERN } from "../../handoff.js";
import { resumeHandoff } from "../../handoff-resume.js";
import { IdempotencyKeySchema } from "../../launch-schema.js";
import type { SupervisedIdentity } from "../../supervision/identity.js";
import {
  daemonEffectiveContext,
  daemonRequestError,
  parseCallerClaim,
  requireDaemonMailbox,
  verifyDaemonCaller,
  type DaemonRuntime,
  type VerifiedDaemonCaller,
} from "../runtime.js";
import { DaemonRequestError } from "../protocol.js";
import type { LaunchIntentChild, LaunchIntentRecord, LaunchIntentState } from "../intents.js";
import { DaemonMailboxError } from "../mailbox.js";
import type { OwnershipCaller, TransferRecord } from "../ownership.js";
import { bindMatchedRun } from "../reattach.js";

interface DaemonIntentProjection {
  launchId: string;
  idempotencyKey: string;
  state: LaunchIntentState;
  children: LaunchIntentChild[];
  resolution?: LaunchIntentRecord["resolution"];
  reconciled?: true;
}

function projectIntent(intent: LaunchIntentRecord): DaemonIntentProjection {
  return {
    launchId: intent.launchId,
    idempotencyKey: intent.idempotencyKey,
    state: intent.state,
    children: intent.children,
    ...(intent.resolution === undefined ? {} : { resolution: intent.resolution }),
    ...(intent.reconciled === undefined ? {} : { reconciled: intent.reconciled }),
  };
}

/** The bounded transfer/claim reply projection of one frozen journal record. */
interface DaemonRunTransfer {
  transferId: string;
  runIds: string[];
  fromKey: string;
  toKey: string;
  successor: OwnershipCaller;
  incidentId?: string;
}

function projectTransfer(record: TransferRecord): DaemonRunTransfer {
  return {
    transferId: record.transferId,
    runIds: record.runIds,
    fromKey: record.fromKey,
    toKey: record.toKey,
    successor: record.successor,
    ...(record.incidentId === undefined ? {} : { incidentId: record.incidentId }),
  };
}

export type DaemonRunReply =
  | {
      kind: "run";
      action: "observe";
      observation: Awaited<ReturnType<typeof resumeHandoff>>;
      intent?: DaemonIntentProjection;
      /** This run's unread event IDs in the caller's own mailbox (§7). */
      unread: string[];
    }
  | {
      kind: "run";
      action: "reconcile";
      launchId: string;
      idempotencyKey: string;
      state: LaunchIntentState;
      children: LaunchIntentChild[];
      reconciled?: true;
    }
  | { kind: "run"; action: "transfer"; transfer: DaemonRunTransfer }
  | { kind: "run"; action: "claim"; transfer: DaemonRunTransfer }
  | { kind: "run"; action: "ack"; eventId: string; result: "acked" | "already-acked" };

/** The §8 caller record N2.4 expects — the VERIFIED pane and session, never the claimed ones. */
function ownershipCaller(caller: VerifiedDaemonCaller): OwnershipCaller {
  return { paneId: caller.context.paneId, session: caller.session };
}

/**
 * `observe` (§8, read-only): the `resumeHandoff` result, the intent that
 * recorded this run when one did, and the caller's unread event IDs that name
 * this run — the runId lives in the event body, never the filename, so each
 * unread file is read (never written, acked, or moved).
 */
async function observeRun(runtime: DaemonRuntime, caller: VerifiedDaemonCaller, params: Record<string, unknown>): Promise<DaemonRunReply> {
  if (typeof params.runId !== "string" || !RUN_ID_PATTERN.test(params.runId)) throw new DaemonRequestError("REQUEST_INVALID");
  let run;
  try {
    run = await runtime.allocator.open(params.runId);
  } catch (error) {
    throw daemonRequestError(error);
  }
  let observation;
  try {
    observation = await resumeHandoff(run, daemonEffectiveContext(caller));
  } catch (error) {
    throw daemonRequestError(error);
  }
  let intents: LaunchIntentRecord[];
  try {
    intents = await runtime.intents.list(caller.managerSessionKey);
  } catch (error) {
    throw daemonRequestError(error);
  }
  const intent = intents.find((entry) => entry.children.some((child) => child.runId === params.runId));
  const mailbox = requireDaemonMailbox(runtime);
  let ids: string[];
  try {
    ids = await mailbox.list(caller.managerSessionKey);
  } catch (error) {
    throw daemonRequestError(error);
  }
  const unread: string[] = [];
  for (const eventId of ids) {
    try {
      const event = await mailbox.read(caller.managerSessionKey, eventId);
      if ("runId" in event && event.runId === params.runId) unread.push(eventId);
    } catch (error) {
      // An event acked and pruned between list and read is handled evidence,
      // not unread; every other failure fails the call closed.
      if (error instanceof DaemonMailboxError && error.code === "MAILBOX_EVENT_NOT_FOUND") continue;
      throw daemonRequestError(error);
    }
  }
  return {
    kind: "run",
    action: "observe",
    observation,
    ...(intent === undefined ? {} : { intent: projectIntent(intent) }),
    unread,
  };
}

/**
 * `reconcile` (§8): N2.4's ownership reconcile — a fresh snapshot classifies
 * every recorded child by exact terminal/session identity, each live match
 * binds a supervisor through the shared reattach bind sequence, and the
 * intent closes once every child is `bound` or `identity_lost`. A settled
 * intent returns unchanged — reconcile of it is a no-op, never a verdict.
 */
async function reconcileRun(runtime: DaemonRuntime, caller: VerifiedDaemonCaller, params: Record<string, unknown>): Promise<DaemonRunReply> {
  const idempotencyKey = params.idempotencyKey;
  if (!Value.Check(IdempotencyKeySchema, idempotencyKey)) throw new DaemonRequestError("REQUEST_INVALID");
  let intent: LaunchIntentRecord | undefined;
  try {
    intent = await runtime.intents.get(caller.managerSessionKey, idempotencyKey);
  } catch (error) {
    throw daemonRequestError(error);
  }
  if (intent === undefined) throw new DaemonRequestError("INTENT_NOT_FOUND");
  if (intent.state !== "unresolved") {
    return {
      kind: "run",
      action: "reconcile",
      launchId: intent.launchId,
      idempotencyKey: intent.idempotencyKey,
      state: intent.state,
      children: intent.children,
      ...(intent.reconciled === undefined ? {} : { reconciled: intent.reconciled }),
    };
  }
  // The review-log root is the verified project root the launch recorded —
  // never the daemon's cwd.
  const reviewLogRoot = intent.projectRoot;
  const bind = async (runId: string, identity: SupervisedIdentity): Promise<void> => {
    // A supervisor already bound to this exact identity stays authoritative.
    if (runtime.jobs.activeSupervisorFor(identity) !== undefined) return;
    const run = await runtime.allocator.open(runId);
    const state = await readHandoffState(run);
    const provenance = await readHandoffProvenance(run).catch(() => undefined);
    // The launch-pipeline seam may substitute the coordinator (tests); the
    // daemon assembly's registry is the production default, exactly like the
    // launch handler's `supervision` default.
    const supervision = runtime.launchDeps?.supervision ?? runtime.supervision;
    await bindMatchedRun({ supervision, mailbox: requireDaemonMailbox(runtime) }, run, state, provenance, identity, reviewLogRoot);
  };
  let settled: LaunchIntentRecord;
  try {
    settled = await runtime.daemonOwnership.reconcile(intent, bind);
  } catch (error) {
    throw daemonRequestError(error);
  }
  return {
    kind: "run",
    action: "reconcile",
    launchId: settled.launchId,
    idempotencyKey: settled.idempotencyKey,
    state: settled.state,
    children: settled.children,
    ...(settled.reconciled === undefined ? {} : { reconciled: settled.reconciled }),
  };
}

/**
 * `transfer`/`claim` (§8): the journaled ownership change — runIds shape is
 * checked here, everything else (verified live owner, proven successor,
 * owner-instruction record, unresolved-intent gate, mailbox move, provenance
 * v2, hint retarget) lives in N2.4's `createOwnership` and refuses typed.
 */
async function changeOwnership(runtime: DaemonRuntime, caller: VerifiedDaemonCaller, params: Record<string, unknown>, claiming: boolean): Promise<DaemonRunReply> {
  if (!Array.isArray(params.runIds) || params.runIds.length === 0
    || !params.runIds.every((id) => typeof id === "string" && RUN_ID_PATTERN.test(id))) {
    throw new DaemonRequestError("REQUEST_INVALID");
  }
  const input = { caller: ownershipCaller(caller), runIds: params.runIds };
  let record: TransferRecord;
  try {
    if (claiming) {
      if (typeof params.incidentId !== "string" || params.incidentId.length === 0) throw new DaemonRequestError("REQUEST_INVALID");
      record = await runtime.daemonOwnership.claim({ ...input, incidentId: params.incidentId });
    } else {
      if (typeof params.successorPaneId !== "string" || params.successorPaneId.length === 0) throw new DaemonRequestError("REQUEST_INVALID");
      record = await runtime.daemonOwnership.transfer({ ...input, successorPaneId: params.successorPaneId });
    }
  } catch (error) {
    if (error instanceof DaemonRequestError) throw error;
    throw daemonRequestError(error);
  }
  return { kind: "run", action: claiming ? "claim" : "transfer", transfer: projectTransfer(record) };
}

/**
 * `ack` (§8): the caller has handled the event — rename `unread/<id>.json` to
 * `acked/<id>.json` in the caller's own mailbox. The session-derived key is
 * never caller-supplied; a malformed or foreign event ID fails closed, and an
 * already-acked ID is an idempotent success.
 */
async function ackEvent(runtime: DaemonRuntime, caller: VerifiedDaemonCaller, params: Record<string, unknown>): Promise<DaemonRunReply> {
  if (typeof params.eventId !== "string") throw new DaemonRequestError("REQUEST_INVALID");
  let result: "acked" | "already-acked";
  try {
    result = await requireDaemonMailbox(runtime).ack(caller.managerSessionKey, params.eventId);
  } catch (error) {
    throw daemonRequestError(error);
  }
  return { kind: "run", action: "ack", eventId: params.eventId, result };
}

/**
 * The `run` request: `{identity, action, ...}` — every action passes the D2a
 * verified-caller gate first, then its own validation. Unknown actions refuse
 * `REQUEST_INVALID`; nothing acts on an unverified caller.
 */
export async function handleDaemonRun(runtime: DaemonRuntime, params: Record<string, unknown>): Promise<DaemonRunReply> {
  const signal = new AbortController().signal;
  const caller = await verifyDaemonCaller(runtime.cli, parseCallerClaim(params.identity), signal);
  switch (params.action) {
    case "observe": return observeRun(runtime, caller, params);
    case "reconcile": return reconcileRun(runtime, caller, params);
    case "transfer": return changeOwnership(runtime, caller, params, false);
    case "claim": return changeOwnership(runtime, caller, params, true);
    case "ack": return ackEvent(runtime, caller, params);
    default: throw new DaemonRequestError("REQUEST_INVALID", "daemon run action is not recognized");
  }
}
