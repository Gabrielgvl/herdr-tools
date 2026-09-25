/**
 * The D4 restart reattach sweep (durable-supervisor §9, node N2.3) plus the
 * D5 owner-binding it carries into every rebound supervisor.
 *
 * Once, at daemon start, after the N1.3 intent sweep: take one fresh
 * authoritative `session.snapshot`, enumerate every v2 run sidecar in the
 * endpoint's handoff namespace, and classify each recorded child identity in
 * `awaiting_handoff` or `recovery_pending`:
 *
 * - exact match on terminal + name + kind + native session → reattach:
 *   revalidate the recorded artifact digest and the last review record, reset
 *   a prior host's `recovery_pending` back to `awaiting_handoff`, and reserve
 *   + bind a supervisor to that exact identity (the recorded owner rides the
 *   binding so D5 review-pausing follows the session, never the pane).
 * - provably absent → `identity_lost`; the sidecar is preserved untouched and
 *   no terminal state is ever written.
 * - ambiguous → `recovery_pending` with bounded evidence — the only restart
 *   path into that state.
 *
 * Then every still-`unresolved` intent whose recorded children all classified
 * reconciles, and exactly one `downtime_gap` event lands in each affected
 * owner mailbox through N2.2's `writeGapEvent` — a full mailbox holds it as
 * `pendingGap`, never drops it.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import {
  HandoffError,
  currentHandoffOwner,
  readHandoffArtifact,
  readHandoffProvenance,
  readHandoffState,
  RUN_ID_PATTERN,
  updateHandoffState,
  type HandoffAllocator,
  type HandoffAllocation,
  type HandoffNamespace,
  type HandoffProvenance,
  type HandoffState,
} from "../handoff.js";
import type { JobRegistry, SupervisionWorkspaceRoot } from "../job-registry.js";
import { requirePromptTargetIdentity, type AgentSessionIdentity } from "../messages/prompt.js";
import { snapshotIdentityRecords } from "../messages/prompt-target.js";
import { modelSafeJson } from "../redaction.js";
import type { SupervisedIdentity } from "../supervision/identity.js";
import { reviewLogPaths } from "../supervision/review-log.js";
import type { SupervisionCoordinator } from "../supervision/registry.js";
import type { HerdrSnapshot } from "../targets.js";
import {
  managerSessionKey,
  type IntentStore,
  type LaunchIntentChildDisposition,
  type LaunchIntentRecord,
} from "./intents.js";
import type { Mailbox } from "./mailbox.js";
import type { DaemonNamespace } from "./namespace.js";
import { createOwnership, OwnershipError } from "./ownership.js";

/** The recorded sidecar states the restart sweep re-matches — never silently skips. */
const REATTACHABLE = new Set(["awaiting_handoff", "recovery_pending"]);

/** Above this the review log is no longer trustworthy evidence; the run stays bound but unverified, so it refuses reattach instead. */
const REVIEW_LOG_MAX_BYTES = 16 * 1024 * 1024;

export type ReattachDisposition = "bound" | "identity_lost" | "ambiguous" | "skipped" | "unbound" | "unclassified";

export interface ReattachRunReport {
  runId: string;
  /** The sidecar lifecycle at sweep entry; `"unreadable"` when the record refused to parse. */
  lifecycle: string;
  disposition: ReattachDisposition;
  /** Bounded failure detail for non-`bound` outcomes. */
  reason?: string;
  /** The reservation job ID when a supervisor bound. */
  jobId?: string;
  /** The recorded owner's mailbox key when resolvable — the gap's destination. */
  ownerKey?: string;
}

export interface ReattachGapReport {
  managerSessionKey: string;
  persisted: boolean;
  /** Bounded reason when the write was refused outright; a held gap reports `pendingGap`. */
  pendingGap?: boolean;
  reason?: string;
}

export interface ReattachReport {
  runs: ReattachRunReport[];
  gaps: ReattachGapReport[];
  /** Capacity-deferred ownership journals; ack/status remain available. */
  pendingTransfers?: string[];
}

export interface ReattachDeps {
  /** The daemon namespace — the review-log fallback root when no intent recorded a verified project root. */
  namespace: DaemonNamespace;
  /** The endpoint's handoff run namespace (`herdr-handoffs/`), enumerated directly. */
  runs: HandoffNamespace;
  allocator: HandoffAllocator;
  intents: IntentStore;
  supervision: SupervisionCoordinator;
  /** Live-coverage dedupe: a supervisor already bound this exact identity stays authoritative. */
  jobs: Pick<JobRegistry, "activeSupervisorFor">;
  mailbox: Mailbox;
  /** Exactly one fresh authoritative `session.snapshot`, shared by every classification. */
  snapshot(): Promise<HerdrSnapshot>;
  /** This start's timestamp — the gap's `to`. */
  startedAt: string;
  /** The prior daemon record's heartbeat — the gap's `from`; defaults to `startedAt`. */
  lastHeartbeat?: string;
  log?: (line: string) => void;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function boundedReason(value: string): string {
  return value.slice(0, 256);
}

function sameSession(left: AgentSessionIdentity, right: AgentSessionIdentity): boolean {
  return left.source === right.source
    && left.agent === right.agent
    && left.kind === right.kind
    && left.value === right.value;
}

export { daemonRunOwnership } from "./ownership.js";

/**
 * One exact-match verdict for a recorded child identity against the fresh
 * snapshot — the same rule `resumeHandoff` applies, never pane-id alone:
 * terminal match required, then the live pane's name/kind/session must equal
 * the durable record.
 */
export function classifyChild(
  snapshot: HerdrSnapshot,
  state: HandoffState,
): { kind: "matched"; identity: SupervisedIdentity } | { kind: "absent" } | { kind: "ambiguous"; reason: string } {
  const terminalId = state.child.terminalId!;
  const session = state.nativeSession!;
  const matches = snapshot.panes.filter((pane) => pane.terminal_id === terminalId);
  if (matches.length > 1) return { kind: "ambiguous", reason: `terminal_ambiguous:${matches.length}` };
  if (matches.length === 0) {
    if (state.child.paneId !== null && snapshot.panes.some((pane) => pane.pane_id === state.child.paneId)) {
      return { kind: "ambiguous", reason: "pane_occupied_by_other_terminal" };
    }
    return { kind: "absent" };
  }
  const pane = matches[0]!;
  let live;
  try {
    live = requirePromptTargetIdentity(snapshotIdentityRecords(snapshot, pane.pane_id), pane.pane_id);
  } catch {
    return { kind: "ambiguous", reason: "identity_untrusted" };
  }
  if (live.terminalId !== terminalId
    || live.agentName !== state.child.agentName
    || live.agentKind !== state.child.agentKind
    || !sameSession(live.agentSession, session)) {
    return { kind: "ambiguous", reason: "identity_changed" };
  }
  return {
    kind: "matched",
    identity: {
      paneId: live.paneId,
      terminalId: live.terminalId,
      agentName: live.agentName,
      agentKind: live.agentKind,
      agentSession: live.agentSession,
    },
  };
}

/**
 * The recorded artifact digest still holds: an absent recorded digest passes
 * (nothing accepted yet to contradict), a recorded one must read back
 * byte-identical. Untrusted or changed artifacts refuse the reattach — the
 * supervisor must never complete a run on evidence it did not verify.
 */
async function artifactRevalidates(run: HandoffAllocation, state: HandoffState): Promise<string | undefined> {
  if (state.artifact.sha256 === null) return undefined;
  try {
    const artifact = await readHandoffArtifact(run);
    return artifact.sha256 === state.artifact.sha256 ? undefined : "artifact_digest_mismatch";
  } catch (error) {
    /* c8 ignore next -- every readHandoffArtifact refusal is typed; the rethrow only preserves a foreign programming error. */
    if (!(error instanceof HandoffError)) throw error;
    return `artifact_untrusted:${error.code}`;
  }
}

/**
 * The last `review` record for this child must still describe this run —
 * terminal and native session — before the reattached supervisor may complete
 * it. An absent file or absent record passes (nothing to contradict); a
 * malformed line or a contradictory evidence cursor fails closed.
 */
async function lastReviewRevalidates(root: string, state: HandoffState): Promise<string | undefined> {
  const path = reviewLogPaths(root).reviews;
  let content: string;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > REVIEW_LOG_MAX_BYTES) return "review_log_untrusted";
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    return "review_log_untrusted";
  }
  let last: Record<string, unknown> | undefined;
  for (const line of content.split("\n")) {
    if (line.length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return "review_log_malformed";
    }
    if (!record(entry)) return "review_log_malformed";
    if (entry.type === "review" && entry.agentName === state.child.agentName && entry.agentKind === state.child.agentKind) {
      last = entry;
    }
  }
  if (last === undefined) return undefined;
  const evidence = last.evidence;
  if (!record(evidence)
    || evidence.terminalId !== state.child.terminalId
    || !record(evidence.agentSession)
    || !sameSession(evidence.agentSession as unknown as AgentSessionIdentity, state.nativeSession!)) {
    return "review_record_mismatch";
  }
  return undefined;
}

/** The reservation's supervision digest rebuilt from the recorded task contract. */
function supervisionDigestOf(provenance: HandoffProvenance | undefined) {
  if (provenance === undefined) return undefined;
  return modelSafeJson({
    objective: provenance.task.objective,
    doneWhen: provenance.task.doneWhen,
    constraints: provenance.task.constraints,
  }) as { objective: string; doneWhen: string[]; constraints: string[] };
}

/** The trusted workspace root the recorded child actually ran under. */
function workspaceRootOf(state: HandoffState): SupervisionWorkspaceRoot {
  const workspace = state.child.workspace;
  if (workspace === undefined) return { available: false, reason: "root_unavailable" };
  return { available: true, root: workspace.worktree ?? workspace.resolvedCwd };
}

export interface MatchedRunBindDeps {
  /** The supervision coordinator that reserves and binds the supervisor. */
  supervision: SupervisionCoordinator;
  /** The owner-mailbox writer the bound supervisor persists events through. */
  mailbox: Mailbox;
}

/**
 * The live-bind sequence the D4 restart sweep and the §8 reconcile share: a
 * `recovery_pending` run resets to `awaiting_handoff` on exact-match proof,
 * supervision reserves with the run's recorded digest, workspace root, and
 * review-log root, and the supervisor binds carrying the run's recorded owner
 * so D5 review pausing follows the session, never the pane. Returns the
 * reservation job ID. A failed bind releases the reservation and rethrows —
 * the caller classifies the child `ambiguous`, never absent.
 */
export async function bindMatchedRun(
  deps: MatchedRunBindDeps,
  run: HandoffAllocation,
  state: HandoffState,
  provenance: HandoffProvenance | undefined,
  identity: SupervisedIdentity,
  reviewLogRoot: string,
): Promise<string> {
  // A prior host left this run recovery_pending at shutdown; the exact match
  // is proof enough to supervise it again, so the run returns to
  // awaiting_handoff before the gate re-binds it.
  if (state.lifecycle.state === "recovery_pending") {
    await updateHandoffState(run, (current) => {
      current.lifecycle.state = "awaiting_handoff";
      current.lifecycle.detail = "daemon_restart_reattached";
    });
  }
  const reservation = await deps.supervision.reserve({
    child: {
      agentName: state.child.agentName,
      agentKind: state.child.agentKind,
      operatingPointId: state.child.operatingPointId,
    },
    settings: {
      supervisionDigest: supervisionDigestOf(provenance),
      workspaceRoot: workspaceRootOf(state),
      reviewLogRoot,
      eventWriter: deps.mailbox,
    },
  });
  try {
    await reservation.bind({
      identity,
      operatingPointId: state.child.operatingPointId,
      ...(state.lifecycle.watermark?.stateChangeSeq === undefined ? {} : { stateChangeSeq: state.lifecycle.watermark.stateChangeSeq }),
      handoff: {
        allocation: run,
        ...(state.child.agentId === null ? {} : { agentId: state.child.agentId }),
        ...(provenance === undefined ? {} : { owner: { paneId: provenance.manager.paneId, session: currentHandoffOwner(provenance) } }),
      },
    });
  } catch (error) {
    reservation.release("reattach_bind_failed");
    throw error;
  }
  return reservation.jobId;
}

/**
 * Run the D4 sweep once. A failure of the shared snapshot is fatal — no
 * classification is ever inferred — but a single run's failure is recorded
 * and the sweep continues; gaps and reconciles are per-mailbox/per-intent
 * and never strand each other.
 */
export async function reattachDaemonRuns(deps: ReattachDeps): Promise<ReattachReport> {
  const log = deps.log ?? (() => undefined);
  const ownership = createOwnership(deps);
  try {
    await ownership.completePending();
  } catch (error) {
    // Event caps may defer the journal, never its moves. Keep ack/status available
    // so the successor can drain; ownership operations still gate on completion.
    if (!(error instanceof OwnershipError) || error.code !== "TRANSFER_PENDING") throw error;
    log("herdr-tools-daemon transfer pending: mailbox capacity; ack remains available");
  }
  const snapshot = await deps.snapshot();

  const intentByRun = new Map<string, LaunchIntentRecord>();
  const unresolved: LaunchIntentRecord[] = [];
  for (const manager of await deps.intents.listManagers().catch(() => [] as string[])) {
    for (const intent of await deps.intents.list(manager).catch(() => [] as LaunchIntentRecord[])) {
      for (const child of intent.children) {
        if (child.runId !== undefined) intentByRun.set(child.runId, intent);
      }
      if (intent.state === "unresolved") unresolved.push(intent);
    }
  }

  let entries: Dirent[];
  try {
    entries = await readdir(deps.runs.dir, { withFileTypes: true });
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    entries = [];
  }

  const runs: ReattachRunReport[] = [];
  const affected = new Set<string>();

  for (const entry of entries) {
    if (!entry.isDirectory() || !RUN_ID_PATTERN.test(entry.name)) continue;
    const runId = entry.name;
    const report: ReattachRunReport = { runId, lifecycle: "unreadable", disposition: "unclassified" };
    runs.push(report);

    let run: HandoffAllocation;
    let state: HandoffState;
    try {
      run = await deps.allocator.open(runId);
      state = await readHandoffState(run);
    } catch (error) {
      report.reason = boundedReason(error instanceof HandoffError ? error.code : "run_unreadable");
      continue;
    }
    report.lifecycle = state.lifecycle.state;
    if (!REATTACHABLE.has(state.lifecycle.state)) {
      report.disposition = "skipped";
      continue;
    }
    if (state.child.terminalId === null || state.nativeSession === null) {
      report.disposition = "skipped";
      report.reason = "child_identity_unbound";
      continue;
    }

    let provenance: HandoffProvenance | undefined;
    try {
      provenance = await readHandoffProvenance(run);
    } catch {
      // A run without provenance still supervises — it simply has no recorded
      // owner to pause reviews on and no mailbox to gap.
    }
    const owner = provenance === undefined ? null : currentHandoffOwner(provenance);
    const ownerKey = owner === null ? undefined : managerSessionKey(owner);
    if (ownerKey !== undefined) report.ownerKey = ownerKey;
    const mark = (disposition: ReattachDisposition, reason?: string) => {
      report.disposition = disposition;
      if (reason !== undefined) report.reason = reason;
      if (ownerKey !== undefined) affected.add(ownerKey);
    };

    const verdict = classifyChild(snapshot, state);
    if (verdict.kind === "absent") {
      // Provably absent: the sidecar is preserved untouched — no lifecycle
      // write, no terminal state — and the intent disposition records the loss.
      mark("identity_lost");
      continue;
    }
    if (verdict.kind === "ambiguous") {
      // The only restart path into recovery_pending: bounded evidence on the
      // sidecar, no supervisor bound to an uncertain child.
      const detail = boundedReason(`daemon_restart_ambiguous:${verdict.reason}`);
      try {
        await updateHandoffState(run, (current) => {
          current.lifecycle.state = "recovery_pending";
          current.lifecycle.detail = detail;
        });
      } catch (error) {
        mark("unclassified", error instanceof HandoffError ? error.code : /* c8 ignore next -- updateHandoffState wraps every failure in HandoffError; the literal only labels a foreign fault. */ "state_write_failed");
        continue;
      }
      mark("ambiguous", verdict.reason);
      continue;
    }

    // Matched: revalidate before any supervisor — and therefore any completion
    // event — may exist. The review-log root is the run's recorded project
    // root, or the endpoint namespace, never the daemon's cwd.
    const intent = intentByRun.get(runId);
    const reviewLogRoot = intent?.projectRoot ?? deps.namespace.dir;
    const refusal = (await artifactRevalidates(run, state)) ?? (await lastReviewRevalidates(reviewLogRoot, state));
    if (refusal !== undefined) {
      mark("unbound", refusal);
      continue;
    }
    const identity = verdict.identity;
    const live = deps.jobs.activeSupervisorFor(identity);
    if (live !== undefined) {
      report.disposition = "bound";
      report.jobId = live.jobId;
      if (ownerKey !== undefined) affected.add(ownerKey);
      continue;
    }
    try {
      report.jobId = await bindMatchedRun(deps, run, state, provenance, identity, reviewLogRoot);
      report.disposition = "bound";
      if (ownerKey !== undefined) affected.add(ownerKey);
    } catch (error) {
      mark("unbound", boundedReason(error instanceof HandoffError ? error.code : "bind_failed"));
    }
  }

  // §8 reconcile: an unresolved intent closes only when every recorded child
  // is live-bound or provably absent; anything unaccounted stays unresolved —
  // a matched sibling never clears an unaccounted one.
  const dispositionByRun = new Map(runs.map((report) => [report.runId, report.disposition] as const));
  for (const intent of unresolved) {
    const dispositions = intent.children.map((child) => {
      if (child.runId === undefined) return { ...child, disposition: "ambiguous" as LaunchIntentChildDisposition };
      const outcome = dispositionByRun.get(child.runId);
      const disposition: LaunchIntentChildDisposition | undefined =
        outcome === "bound" ? "bound"
          : outcome === "identity_lost" ? "identity_lost"
            : outcome === "ambiguous" || outcome === "unbound" ? "ambiguous"
              : undefined;
      return disposition === undefined ? { ...child } : { ...child, disposition };
    });
    if (dispositions.some((child) => child.disposition === undefined)) continue;
    try {
      await deps.intents.reconcile(intent, dispositions);
    } catch (error) {
      log(`herdr-tools-daemon reattach reconcile failed for ${intent.launchId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // One downtime_gap per affected mailbox; `lost` carries the durable
  // unpersisted accounting for that mailbox only.
  const gaps: ReattachGapReport[] = [];
  const unpersisted = await deps.mailbox.degradation().then((report) => report.unpersisted).catch(() => ({} as Record<string, never>));
  for (const key of affected) {
    const account = unpersisted[key];
    try {
      const result = await deps.mailbox.writeGapEvent(key, {
        from: deps.lastHeartbeat ?? deps.startedAt,
        to: deps.startedAt,
        lost: account === undefined ? {} : { [key]: account },
      });
      gaps.push({ managerSessionKey: key, persisted: result.persisted, ...("pendingGap" in result && result.pendingGap === true ? { pendingGap: true } : {}) });
    } catch (error) {
      gaps.push({ managerSessionKey: key, persisted: false, reason: boundedReason(error instanceof Error ? error.message : String(error)) });
    }
  }
  const pending = await ownership.pendingTransfers();
  return { runs, gaps, ...(pending.length === 0 ? {} : { pendingTransfers: pending.map((plan) => plan.transferId) }) };
}
