/**
 * `status` — the read-only daemon surface (durable-supervisor §10): daemon
 * health from `daemon.json`, the caller's runs (durable lifecycle plus live
 * child presence and supervisor review), the caller's intents `unresolved`
 * first, the caller's unread mailbox event count and IDs plus the bounded
 * event body when `eventId` names one, the caller's mailbox path, and the
 * capacity state. It opens nothing for writing, never acks, and never mutates.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readHandoffState, type HandoffState } from "../../handoff.js";
import { requirePromptTargetIdentity } from "../../messages/prompt.js";
import { snapshotIdentityRecords } from "../../messages/prompt-target.js";
import { daemonRequestError, parseCallerClaim, requireDaemonMailbox, verifyDaemonCaller, type DaemonOwnership, type DaemonRuntime, type VerifiedDaemonCaller } from "../runtime.js";
import type { LaunchIntentChild, LaunchIntentRecord, LaunchIntentState } from "../intents.js";
import { DAEMON_MAILBOX_DIR_NAME, type MailboxEvent } from "../mailbox.js";
import { DaemonRequestError } from "../protocol.js";

export interface DaemonStatusIntent {
  launchId: string;
  idempotencyKey: string;
  state: LaunchIntentState;
  children: LaunchIntentChild[];
  effectCertainty?: string;
  failureCode?: string;
  resolution?: LaunchIntentRecord["resolution"];
  reconciled?: true;
  recordedAt: string;
  updatedAt: string;
}

export interface DaemonStatusRun {
  runId: string;
  /** The durable lifecycle state, or `unavailable` when the record cannot be read. */
  lifecycle: string;
  child: {
    agentName: string;
    agentKind: string;
    /** Whether the recorded child identity is occupied in the verified snapshot. */
    presence: "present" | "absent" | "ambiguous";
    paneId?: string;
    agentStatus?: unknown;
  };
  /** `active` while a live supervisor job is bound to the run in this daemon. */
  review: "active" | "paused";
}

/** One frozen transfer journal awaiting completion — the §8 pendingTransfers projection. */
export type DaemonStatusPendingTransfer = Awaited<ReturnType<DaemonOwnership["pendingTransfers"]>>[number];

export interface DaemonStatusReply {
  kind: "status";
  daemon: { status: "running" | "missing"; startedAt?: string; heartbeat?: string; lastStoppedAt?: string; capacity?: unknown; unpersisted?: unknown; pendingGap?: unknown };
  runs: DaemonStatusRun[];
  intents: DaemonStatusIntent[];
  /** The caller's own unread mailbox events — the §7 `list` projection. */
  unread: { count: number; ids: string[] };
  /** The named event's bounded body — present only when `eventId` was requested (§7 `read`). */
  event?: MailboxEvent;
  /**
   * Frozen `transfers/<id>.json` journals awaiting completion — the same set
   * `ReattachReport.pendingTransfers` lists by ID, with runIds, session keys,
   * and the frozen event IDs/bodies. Read-only: status never finishes them.
   */
  pendingTransfers: DaemonStatusPendingTransfer[];
  /** The caller's own mailbox directory — `mailbox/<managerSessionKey>/` inside the namespace. */
  mailbox: string;
  capacity: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

/** `daemon.json` — read-only; a missing record is `missing`, never fabricated. */
async function daemonHealth(runtime: DaemonRuntime): Promise<DaemonStatusReply["daemon"]> {
  let text: string;
  try {
    text = await readFile(join(runtime.namespace.dir, "daemon.json"), "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { status: "missing" };
    throw daemonRequestError(error, "DAEMON_STATUS_UNAVAILABLE");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "missing" };
  }
  if (!isRecord(parsed)) return { status: "missing" };
  const stringField = (key: string): string | undefined => (typeof parsed[key] === "string" ? parsed[key] as string : undefined);
  return {
    status: "running",
    ...(stringField("startedAt") === undefined ? {} : { startedAt: stringField("startedAt") }),
    ...(stringField("heartbeat") === undefined ? {} : { heartbeat: stringField("heartbeat") }),
    ...(stringField("lastStoppedAt") === undefined ? {} : { lastStoppedAt: stringField("lastStoppedAt") }),
    ...(parsed.capacity === undefined ? {} : { capacity: parsed.capacity }),
    ...(parsed.unpersisted === undefined ? {} : { unpersisted: parsed.unpersisted }),
    ...(parsed.pendingGap === undefined ? {} : { pendingGap: parsed.pendingGap }),
  };
}

function projectIntent(intent: LaunchIntentRecord): DaemonStatusIntent {
  return {
    launchId: intent.launchId,
    idempotencyKey: intent.idempotencyKey,
    state: intent.state,
    children: intent.children,
    ...(intent.effectCertainty === undefined ? {} : { effectCertainty: intent.effectCertainty }),
    ...(intent.failureCode === undefined ? {} : { failureCode: intent.failureCode }),
    ...(intent.resolution === undefined ? {} : { resolution: intent.resolution }),
    ...(intent.reconciled === undefined ? {} : { reconciled: intent.reconciled }),
    recordedAt: intent.recordedAt,
    updatedAt: intent.updatedAt,
  };
}

/** Whether the run's recorded child identity still occupies its pane — the same rule `resumeHandoff` applies. */
function childPresence(state: HandoffState, snapshot: VerifiedDaemonCaller["snapshot"]): DaemonStatusRun["child"] {
  const child = { agentName: state.child.agentName, agentKind: state.child.agentKind };
  const terminalId = state.child.terminalId;
  if (terminalId === null || state.nativeSession === null) return { ...child, presence: "absent" };
  const matches = snapshot.panes.filter((pane) => pane.terminal_id === terminalId);
  if (matches.length === 0) return { ...child, presence: "absent" };
  if (matches.length > 1) return { ...child, presence: "ambiguous" };
  const pane = matches[0]!;
  let live;
  try {
    live = requirePromptTargetIdentity(snapshotIdentityRecords(snapshot, pane.pane_id), pane.pane_id);
  } catch {
    return { ...child, presence: "absent" };
  }
  const recorded = state.nativeSession;
  if (live.terminalId !== terminalId
    || live.agentName !== state.child.agentName
    || live.agentKind !== state.child.agentKind
    || live.agentSession.source !== recorded.source
    || live.agentSession.agent !== recorded.agent
    || live.agentSession.kind !== recorded.kind
    || live.agentSession.value !== recorded.value) {
    return { ...child, presence: "absent" };
  }
  return { ...child, presence: "present", paneId: pane.pane_id, agentStatus: pane.agent_status };
}

/** `runId → review` from live supervisor jobs; a run no supervisor job names is `paused`. */
async function runReviews(runtime: DaemonRuntime): Promise<Map<string, DaemonStatusRun["review"]>> {
  const reviews = new Map<string, DaemonStatusRun["review"]>();
  for (const summary of runtime.jobs.list(undefined, 0, 100, "supervisor").jobs) {
    const detail = runtime.jobs.get(summary.jobId);
    if (detail === undefined) continue;
    const handoff = detail.handoff;
    if (handoff === undefined || handoff.gated !== true) continue;
    if (detail.operation_phase !== "settled") reviews.set(handoff.runId, "active");
    else if (!reviews.has(handoff.runId)) reviews.set(handoff.runId, "paused");
  }
  return reviews;
}

export async function handleDaemonStatus(runtime: DaemonRuntime, params: Record<string, unknown>): Promise<DaemonStatusReply> {
  const signal = new AbortController().signal;
  const caller = await verifyDaemonCaller(runtime.cli, parseCallerClaim(params.identity), signal);
  const daemon = await daemonHealth(runtime);
  let intents: LaunchIntentRecord[];
  try {
    intents = await runtime.intents.list(caller.managerSessionKey);
  } catch (error) {
    throw daemonRequestError(error);
  }
  const projected = intents.map(projectIntent);
  // `unresolved` first — the intents a caller must act on before retrying.
  const ordered = [
    ...projected.filter((intent) => intent.state === "unresolved"),
    ...projected.filter((intent) => intent.state !== "unresolved"),
  ];
  const reviews = await runReviews(runtime);
  const runIds = new Set<string>();
  for (const intent of intents) {
    for (const child of intent.children) {
      if (child.runId !== undefined) runIds.add(child.runId);
    }
  }
  const runs: DaemonStatusRun[] = [];
  for (const runId of runIds) {
    try {
      const state = await readHandoffState(await runtime.allocator.open(runId));
      runs.push({
        runId,
        lifecycle: state.lifecycle.state,
        child: childPresence(state, caller.snapshot),
        review: reviews.get(runId) ?? "paused",
      });
    } catch {
      runs.push({ runId, lifecycle: "unavailable", child: { agentName: "", agentKind: "", presence: "absent" }, review: reviews.get(runId) ?? "paused" });
    }
  }
  // §7 mailbox projection — `list`/`read` are pure reads: no mkdir, no flock,
  // no rename. A named event ID resolves against the caller's own mailbox only.
  const mailbox = requireDaemonMailbox(runtime);
  let ids: string[];
  try {
    ids = await mailbox.list(caller.managerSessionKey);
  } catch (error) {
    throw daemonRequestError(error);
  }
  let event: MailboxEvent | undefined;
  if (params.eventId !== undefined) {
    if (typeof params.eventId !== "string") throw new DaemonRequestError("REQUEST_INVALID");
    try {
      event = await mailbox.read(caller.managerSessionKey, params.eventId);
    } catch (error) {
      // A malformed ID, an absent event, or a foreign mailbox's event all
      // surface as the mailbox's own typed refusal — never fabricated content.
      throw daemonRequestError(error);
    }
  }
  // §8 pending journals — a read-only directory projection; status opens
  // nothing for writing and never completes a journal.
  let pendingTransfers: DaemonStatusReply["pendingTransfers"];
  try {
    pendingTransfers = await runtime.daemonOwnership.pendingTransfers();
  } catch (error) {
    throw daemonRequestError(error);
  }
  return {
    kind: "status",
    daemon,
    runs,
    intents: ordered,
    unread: { count: ids.length, ids },
    ...(event === undefined ? {} : { event }),
    pendingTransfers,
    mailbox: join(runtime.namespace.dir, DAEMON_MAILBOX_DIR_NAME, caller.managerSessionKey),
    capacity: daemon.capacity ?? "ok",
  };
}
