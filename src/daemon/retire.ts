/**
 * The ADR-040 lane-retirement sweep (design B3): a daemon-owned periodic pass
 * that closes a finished lane's pane once the full proof chain holds — never
 * on the sidecar's `handed_off` lifecycle alone.
 *
 * One sweep takes exactly one authoritative `api snapshot`, enumerates the
 * endpoint's run sidecars, and for every `handed_off` run proves, in order:
 *
 * 1. sidecar parses, `child.terminalId` and `nativeSession` bound; a missing
 *    provenance record is a legacy run, any other unreadable one refuses;
 * 2. `classifyChild` exact match; the agent record's own lifecycle tuple —
 *    admitted only when the supervision join proves it coherent with the pane
 *    record — reads `idle`/`done`, and both its `state_change_seq` and the
 *    digest of the pane's detection screen (`pane read --source detection`)
 *    stay continuously unchanged for `graceMs` (in-memory
 *    `runId → {seq, screen, since}` — a changed counter or screen, an active or
 *    contradictory status, an unreadable screen, or an absence resets the
 *    clock; restarts conservatively re-observe);
 * 3. pane tokens prove `identity_provenance=launched` and `identity_session`
 *    equals the recorded session — advisory evidence, secondary to the exact
 *    match, and fail-closed when missing, malformed, or contradictory;
 * 4. the pane is no manager: `classifyCaller` must yield a launched leaf, its
 *    session key must hold no open intent ledger (`recorded`, `effecting`, or
 *    `unresolved`) and no nonterminal children, and its own mailbox `unread/`
 *    must be empty;
 * 5. owner topology: the current owner (provenance v2) resolved to a live pane
 *    by exact session — `state.manager.paneId` as the fallback — must not sit
 *    inside the close's cascade (`PROTECTED_RESOURCE` refuses,
 *    `TOPOLOGY_INVALID` defers);
 * 6. a `focused` pane defers, but only for a bounded number of sweeps
 *    (`maxFocusDefers`) — a stuck focus flag cannot park a finished lane;
 * 7. `retention: "keep"` (task field or pane token) marks the run `kept` and
 *    never retires — the task field for good, the pane token for as long as
 *    it stays set (clearing it releases the lane on the next sweep); the kill
 *    switch turns an otherwise-eligible close into a journaled `would_retire`
 *    and a `disabled` view.
 *
 * The close itself runs under the pane write lock and the run flock — the
 * lock ownership transfers and sidecar mutations take — and re-proves the
 * whole chain there: the sidecar, `pane get`/`agent get` identity, tokens,
 * lifecycle and counter, the current owner, the child's intents and mailbox,
 * the owner topology, focus, the screen digest, and the lease itself.
 * `selfClose.begin` correlates the supervisor's own `pane_closed` wake;
 * `closeWithReadback` proves the pane absent. A failed close retries on
 * later sweeps and stops at `maxAttempts` with state `failed`. Only a close
 * whose own mutation the readback confirmed (`reconciled === false`) marks
 * the run retired — the `retiredByDaemon` marker `JobRegistry` consults
 * before suppressing the trailing `job_terminal` — and emits exactly one
 * `lane_retired` event to the run's current owner mailbox; an absence the
 * readback found without that proof is another actor's close, journaled and
 * never claimed.
 */

import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { tokenValue } from "../agent-identity.js";
import { classifyCaller, mergedToken } from "../caller-policy.js";
import type { CliTextResult } from "../cli.js";
import { paneCloseTopology, topologySummary, validateClose, type CloseTopology } from "../close.js";
import {
  currentHandoffOwner,
  HandoffError,
  readHandoffProvenance,
  readHandoffState,
  RUN_ID_PATTERN,
  type HandoffAllocation,
  type HandoffAllocator,
  type HandoffLifecycleState,
  type HandoffNamespace,
  type HandoffProvenance,
  type HandoffState,
} from "../handoff.js";
import type { JobRegistry } from "../job-registry.js";
import { requirePromptTargetIdentity, type AgentSessionIdentity } from "../messages/prompt.js";
import { agentFrom, findSessionPane, paneFrom, snapshotIdentityRecords } from "../messages/prompt-target.js";
import { closeWithReadback, type CloseReadbackCli } from "../mutations.js";
import type { PaneWriteGuard, PaneWriteLease } from "../pane-write-lock.js";
import { joinTargetRecords, type SupervisedIdentity } from "../supervision/identity.js";
import type { SelfCloseTracker } from "../supervision/self-close.js";
import type { HerdrSnapshot } from "../targets.js";
import { managerSessionKey, type IntentStore, type LaunchIntentRecord } from "./intents.js";
import type { Mailbox, MailboxRunOwnership } from "./mailbox.js";
import { classifyChild } from "./reattach.js";

/** The `retire` projection `DaemonStatusRun` carries (durable-supervisor §7). */
export interface RetireView {
  state: "watching" | "eligible" | "deferred" | "refused" | "retired" | "failed" | "kept" | "disabled";
  reason?: string;
  stableForMs?: number;
  at?: string;
}

export interface LaneRetirer {
  /** One retirement pass: enumerate runs, prove, defer/refuse, or close. */
  sweep(): Promise<void>;
  /** The run's current retirement view, or `undefined` when the sweep is not tracking it. */
  view(runId: string): RetireView | undefined;
  /**
   * The `job_terminal` suppression marker: true only for runs whose pane this
   * retirer closed — a `handed_off` run closed by anything else still emits.
   */
  retiredByDaemon(runId: string): boolean;
}

/** The retirer's CLI surface: the readback-proven close plus the detection-screen read. */
export interface LaneRetirerCli extends CloseReadbackCli {
  runTextResult(argv: string[], signal: AbortSignal): Promise<CliTextResult>;
}

export interface LaneRetirerDeps {
  /** The endpoint's handoff run namespace, enumerated directly each sweep. */
  runs: HandoffNamespace;
  allocator: HandoffAllocator;
  /** The run flock ownership transfers take — held across the under-lock re-proof and the close. */
  ownership: Required<Pick<MailboxRunOwnership, "withRunFlock">>;
  intents: IntentStore;
  /** `writeRunEvent` for `lane_retired`; `list` for the child-mailbox guard. */
  mailbox: Pick<Mailbox, "writeRunEvent" | "list">;
  /** `pane get`/`agent get`/`pane read` proofs and the readback-proven `pane close`. */
  cli: LaneRetirerCli;
  /** Shared with the supervision registry: this host's own-close ledger. */
  selfClose: SelfCloseTracker;
  /** Live-supervisor lookup for the `lane_retired` jobId. */
  jobs: Pick<JobRegistry, "activeSupervisorFor">;
  /** One fresh authoritative snapshot per sweep, per under-lock re-proof, and per close readback. */
  snapshot(): Promise<HerdrSnapshot>;
  options: {
    /** The kill switch: false journals `would_retire` and closes nothing. */
    enabled: boolean;
    /** Continuous idle/done stability required before a close (default 15 min). */
    graceMs: number;
    /** The cross-process pane write flock every herdr-tools sender takes. */
    paneLock: PaneWriteGuard;
    /**
     * Bounded focused deferrals: an otherwise-eligible lane whose pane stays
     * `focused` defers at most this many sweeps, then retires anyway — a
     * stale focus flag cannot park a finished lane forever (default 60).
     */
    maxFocusDefers?: number;
    /** Total close attempts — the initial try plus its retries — before `failed` (default 3). */
    maxAttempts?: number;
  };
  now?: () => Date;
  /** Bounded structured journal sink; one line per decision change. */
  log?: (line: string) => void;
}

const DEFAULT_MAX_FOCUS_DEFERS = 60;
const DEFAULT_MAX_ATTEMPTS = 3;
const BOUNDED_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
/** Intent-child run lifecycles that mean the recorded child is finished. */
const TERMINAL_CHILD_LIFECYCLES = new Set<HandoffLifecycleState>(["handed_off", "cancelled", "failed"]);
/** Terminal views persist: a run stays retired/failed once decided. */
const TERMINAL_VIEWS = new Set<RetireView["state"]>(["retired", "failed"]);
/** The immutable task-field keep is terminal too; the pane-token keep is re-read every sweep (F15). */
const TASK_KEEP_REASON = "task_retention_keep";

interface LaneEntry {
  /** The continuously observed `state_change_seq` — the stability clock's value. */
  seq?: number;
  /** The continuously observed detection-screen digest — the inactivity proof. */
  screen?: string;
  /** `now()` when the current observation began; cleared on reset. */
  sinceMs?: number;
  /** Consecutive focused deferrals while otherwise eligible. */
  focusDefers: number;
  /** Close attempts spent — a lock or re-proof refusal never spends one. */
  attempts: number;
  view: RetireView;
  /** `<decision>:<reason>` last journaled — one line per change, not per sweep. */
  journaled?: string;
}

/** One coherent lifecycle observation: the agent record's own status and counter. */
interface Lifecycle {
  status: string;
  seq: number;
}

/** A veto from the owner-side chain — the view state it demands and its bounded reason. */
interface Veto {
  state: "refused" | "deferred";
  reason: string;
}

/** What the under-lock section decided; only the `lane_retired` mailbox write happens after the run flock releases. */
type LockedOutcome =
  | { kind: "settled" }
  /** The readback proved our own mutation: marker published and jobId captured under the flock. */
  | { kind: "retired"; jobId: string }
  /** The pane is gone but no mutation of ours proved it — another actor's close. */
  | { kind: "reconciled_absent" }
  | { kind: "faulted"; error: unknown };

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

/** A bounded single-line reason fragment — journal text never carries free-form detail. */
function bounded(value: string): string {
  return value.replace(/[^\x20-\x7e]/gu, "_").slice(0, 64);
}

function codeOf(error: unknown): string {
  const code = error !== null && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && BOUNDED_CODE.test(code) ? code : "ERROR";
}

function sameSession(left: AgentSessionIdentity, right: AgentSessionIdentity): boolean {
  return left.source === right.source
    && left.agent === right.agent
    && left.kind === right.kind
    && left.value === right.value;
}

/**
 * The agent record's lifecycle tuple, admitted only once the supervision join
 * proves it coherent with the pane record: a contradictory or malformed pair
 * and a missing status or counter are bounded refusals — the pane's scalars
 * never stand in for the agent record's.
 */
function lifecycleOf(pane: Record<string, unknown>, agent: Record<string, unknown>): Lifecycle | { refusal: string } {
  const joined = joinTargetRecords(pane, agent);
  if (joined.kind === "invalid") return { refusal: `lifecycle_${joined.reason}` };
  const status = agent.agent_status;
  if (typeof status !== "string") return { refusal: "lifecycle_status_unavailable" };
  const seq = agent.state_change_seq;
  if (typeof seq !== "number") return { refusal: "state_change_seq_unavailable" };
  return { status, seq };
}

export function createLaneRetirer(deps: LaneRetirerDeps): LaneRetirer {
  const now = () => (deps.now ?? (() => new Date()))();
  const log = deps.log ?? (() => undefined);
  const maxFocusDefers = deps.options.maxFocusDefers ?? DEFAULT_MAX_FOCUS_DEFERS;
  const maxAttempts = deps.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const signal = new AbortController().signal;
  const ledger = new Map<string, LaneEntry>();
  /** Runs this daemon provably closed — the `job_terminal` suppression marker. */
  const retired = new Set<string>();

  /** One bounded journal line per decision change — never per sweep. */
  function journal(runId: string, entry: LaneEntry, decision?: string): void {
    const outcome = decision ?? entry.view.state;
    const key = `${outcome}:${entry.view.reason ?? "-"}`;
    if (entry.journaled === key) return;
    entry.journaled = key;
    log(`herdr-tools-daemon lane_retire run=${runId} decision=${outcome}${entry.view.reason === undefined ? "" : ` reason=${entry.view.reason}`}`);
  }

  function setView(runId: string, entry: LaneEntry, state: RetireView["state"], reason?: string, stableForMs?: number, decision?: string): void {
    entry.view = {
      state,
      ...(reason === undefined ? {} : { reason }),
      ...(stableForMs === undefined ? {} : { stableForMs }),
      at: now().toISOString(),
    };
    journal(runId, entry, decision);
  }

  function resetClock(entry: LaneEntry): void {
    entry.seq = undefined;
    entry.screen = undefined;
    entry.sinceMs = undefined;
  }

  /**
   * The independent inactivity proof: sha256 over the pane's detection-screen
   * text. A failed or truncated read is a refusal, never a digest — the
   * screen must be fully observed to count as unchanged.
   */
  async function screenDigest(paneId: string): Promise<{ digest: string } | { refusal: string }> {
    let read: CliTextResult;
    try {
      read = await deps.cli.runTextResult(["pane", "read", paneId, "--source", "detection", "--format", "text"], signal);
    } catch {
      return { refusal: "screen_unavailable" };
    }
    if (read.truncated) return { refusal: "screen_truncated" };
    return { digest: createHash("sha256").update(read.value, "utf8").digest("hex") };
  }

  /**
   * The run's provenance. Only a genuinely missing record is a legacy run with
   * no owner history; a malformed, untrusted, oversized, or unreadable one
   * refuses — it may hide a `retention: "keep"` or a transferred owner.
   */
  async function readProvenance(run: HandoffAllocation): Promise<{ provenance: HandoffProvenance | undefined } | { refusal: string }> {
    try {
      return { provenance: await readHandoffProvenance(run) };
    } catch (error) {
      if (error instanceof HandoffError && error.details.reason === "missing") return { provenance: undefined };
      return { refusal: "provenance_unreadable" };
    }
  }

  /**
   * A sub-manager protection check: `undefined` only when every intent under
   * the candidate's own session key is closed and every recorded child run is
   * in a terminal lifecycle. Anything open or unproven refuses — including a
   * `recorded` intent, whose launch request may already be executing.
   */
  async function managedChildrenReason(intents: LaunchIntentRecord[]): Promise<string | undefined> {
    for (const intent of intents) {
      if (intent.state === "recorded" || intent.state === "unresolved" || intent.state === "effecting") return "child_intent_open";
      for (const child of intent.children) {
        if (child.runId === undefined) continue;
        let lifecycle: HandoffLifecycleState;
        try {
          lifecycle = (await readHandoffState(await deps.allocator.open(child.runId))).lifecycle.state;
        } catch {
          return "child_intent_child_untrusted";
        }
        if (!TERMINAL_CHILD_LIFECYCLES.has(lifecycle)) return "child_manages_live_intent";
      }
    }
    return undefined;
  }

  /**
   * The owner-side veto chain, proven against one snapshot and the current
   * provenance: the child's own ledger holds no open intent and no nonterminal
   * child, its mailbox is drained, and the current owner's pane — the v2
   * owner's session resolved to a live pane, else the launch record's manager
   * pane — sits outside the close's cascade. Re-run under the locks
   * immediately before dispatch.
   */
  async function vetoes(snapshot: HerdrSnapshot, paneId: string, tabId: string, childKey: string, state: HandoffState, provenance: HandoffProvenance | undefined): Promise<Veto | undefined> {
    const childIntents = await deps.intents.list(childKey).catch(() => undefined);
    if (childIntents === undefined) return { state: "deferred", reason: "intents_unavailable" };
    const managed = await managedChildrenReason(childIntents);
    if (managed !== undefined) return { state: "refused", reason: managed };
    const unread = await deps.mailbox.list(childKey).catch(() => undefined);
    if (unread === undefined) return { state: "deferred", reason: "mailbox_unavailable" };
    if (unread.length > 0) return { state: "refused", reason: "child_mailbox_unread" };

    const owner = provenance === undefined ? null : currentHandoffOwner(provenance);
    const ownerPaneId = (owner === null ? undefined : findSessionPane(snapshot, owner)?.pane_id) ?? state.manager.paneId;
    const ownerRecord = snapshot.panes.find((candidate) => candidate.pane_id === ownerPaneId);
    const caller: CloseTopology["caller"] = {
      paneId: ownerPaneId,
      ...(ownerRecord?.tab_id === undefined ? {} : { tabId: ownerRecord.tab_id }),
      ...(ownerRecord?.workspace_id === undefined ? {} : { workspaceId: ownerRecord.workspace_id }),
    };
    const close = validateClose(paneCloseTopology(snapshot, caller), { kind: "pane", id: paneId, parentId: tabId });
    if (close.allowed) return undefined;
    return close.code === "PROTECTED_RESOURCE"
      ? { state: "refused", reason: "owner_topology_protected" }
      : { state: "deferred", reason: "topology_invalid" };
  }

  /**
   * The under-lock re-proof — holding the pane write lock and the run flock —
   * and the close. The sidecar must still read `handed_off` for the matched
   * child; `pane get`/`agent get` must still carry the recorded identity, the
   * launch tokens, an idle/done lifecycle and the clock's unchanged counter;
   * the current owner, the child's intents and mailbox, and the owner
   * topology must still permit the close; the pane must not be focused
   * within its defer bound; the screen digest must be unchanged; and the
   * lease must still be held. Every refusal sets its view and settles
   * without spending an attempt.
   */
  async function lockedClose(runId: string, run: HandoffAllocation, identity: SupervisedIdentity, childKey: string, lease: PaneWriteLease, entry: LaneEntry): Promise<LockedOutcome> {
    const paneId = identity.paneId;
    const settle = (state: Exclude<RetireView["state"], "retired">, reason: string): LockedOutcome => {
      setView(runId, entry, state, reason);
      return { kind: "settled" };
    };
    let state: HandoffState;
    try {
      state = await readHandoffState(run);
    } catch {
      return settle("deferred", "recheck_sidecar");
    }
    if (state.lifecycle.state !== "handed_off"
      || state.child.terminalId !== identity.terminalId
      || state.child.agentName !== identity.agentName
      || state.child.agentKind !== identity.agentKind
      || state.nativeSession === null
      || !sameSession(state.nativeSession, identity.agentSession)) return settle("deferred", "recheck_lifecycle");

    const paneGet = await deps.cli.runJson(["pane", "get", paneId], signal);
    const agentGet = await deps.cli.runJson(["agent", "get", paneId], signal);
    const pane = paneFrom(paneGet.result, paneId);
    const agent = agentFrom(agentGet.result);
    const records = [pane, agent];
    let live;
    try {
      live = requirePromptTargetIdentity(records, paneId);
    } catch {
      return settle("deferred", "recheck_identity");
    }
    if (live.terminalId !== identity.terminalId
      || live.agentName !== identity.agentName
      || live.agentKind !== identity.agentKind
      || !sameSession(live.agentSession, identity.agentSession)) return settle("deferred", "recheck_identity");
    const provenanceToken = mergedToken(records, "identity_provenance");
    if (provenanceToken.state !== "value" || provenanceToken.value !== "launched") return settle("deferred", "recheck_tokens");
    const sessionToken = mergedToken(records, "identity_session");
    if (sessionToken.state !== "value" || sessionToken.value !== tokenValue(identity.agentSession.value)) return settle("deferred", "recheck_tokens");
    const lifecycle = lifecycleOf(pane, agent);
    if ("refusal" in lifecycle) {
      resetClock(entry);
      return settle("deferred", `recheck_${lifecycle.refusal}`);
    }
    if (lifecycle.status !== "idle" && lifecycle.status !== "done") {
      resetClock(entry);
      return settle("deferred", "recheck_status");
    }
    if (lifecycle.seq !== entry.seq) {
      // The lane worked between the sweep's observation and this lock — the
      // stability clock restarts; nothing about the pane is as observed.
      resetClock(entry);
      return settle("deferred", "recheck_seq");
    }

    const provenance = await readProvenance(run);
    if ("refusal" in provenance) return settle("deferred", `recheck_${provenance.refusal}`);
    if (provenance.provenance?.task.retention === "keep") return settle("kept", TASK_KEEP_REASON);
    const retentionToken = mergedToken(records, "retention");
    if (retentionToken.state === "value" && retentionToken.value === "keep") {
      resetClock(entry);
      return settle("kept", "token_retention_keep");
    }
    // The owner chain against a fresh snapshot: a transfer that landed since
    // the sweep's approval — it holds the run flock we now hold — shows here.
    const snapshot = await deps.snapshot();
    const veto = await vetoes(snapshot, paneId, pane.tab_id as string, childKey, state, provenance.provenance);
    if (veto !== undefined) return settle(veto.state, `recheck_${veto.reason}`);
    if (pane.focused === true && entry.focusDefers < maxFocusDefers) return settle("deferred", "recheck_focused");

    const screen = await screenDigest(paneId);
    if ("refusal" in screen) {
      resetClock(entry);
      return settle("deferred", `recheck_${screen.refusal}`);
    }
    if (screen.digest !== entry.screen) {
      // Something printed since the sweep observed the screen: the lane is
      // not provably inactive, whatever its lifecycle fields say.
      resetClock(entry);
      return settle("deferred", "recheck_screen");
    }
    try {
      await lease.check();
    } catch {
      // The flock holder died or the lock path lost trust during the reads —
      // the proof above was taken under exclusion that no longer exists.
      return settle("deferred", "pane_lock_lost");
    }

    const finish = deps.selfClose.begin(paneId);
    entry.attempts += 1;
    try {
      const closed = await closeWithReadback<HerdrSnapshot>({
        cli: deps.cli,
        argv: ["pane", "close", paneId],
        signal,
        targetId: paneId,
        readback: () => deps.snapshot(),
        targetPresent: (after) => after.panes.some((candidate) => candidate.pane_id === paneId),
        summarize: topologySummary,
      });
      if (closed.reconciled) {
        // Absent without a mutation of ours: no marker, and the pane_closed
        // wake lands normally.
        finish(false);
        return { kind: "reconciled_absent" };
      }
      // F14 ordering: `finish(true)` resolves a supervisor already waiting in
      // `selfClose.consume`, and its settlement can run before this flock
      // releases. The marker `JobRegistry` consults and the live supervisor's
      // jobId must therefore both exist before the waiter is released — the
      // restart case has no supervisor, and the event names the retirer itself.
      retired.add(runId);
      const jobId = deps.jobs.activeSupervisorFor(identity)?.jobId ?? "daemon-retire";
      setView(runId, entry, "retired", undefined, undefined, `retired pane=${paneId}`);
      finish(true);
      return { kind: "retired", jobId };
    } catch (error) {
      finish(false);
      const code = `close_${codeOf(error)}`;
      return settle(entry.attempts >= maxAttempts ? "failed" : "deferred", code);
    }
  }

  async function closeLane(runId: string, run: HandoffAllocation, state: HandoffState, identity: SupervisedIdentity, childKey: string, entry: LaneEntry): Promise<void> {
    const paneId = identity.paneId;
    let lease: PaneWriteLease;
    try {
      lease = await deps.options.paneLock.acquire(paneId);
    } catch {
      // Contention or an unavailable lock domain defers — it never spends an attempt.
      setView(runId, entry, "deferred", "pane_lock_unavailable");
      return;
    }
    try {
      // The run flock serializes the re-proof and the close against ownership
      // transfers and sidecar mutations; a proven close publishes its marker
      // and captures the supervisor jobId inside it. Only `lane_retired` is
      // written after it releases: the mailbox resolves the owner under the
      // same flock.
      let outcome: LockedOutcome | undefined;
      try {
        await deps.ownership.withRunFlock(runId, async () => {
          try {
            outcome = await lockedClose(runId, run, identity, childKey, lease, entry);
          } catch (error) {
            outcome = { kind: "faulted", error };
          }
        });
      } catch {
        // Only an unacquired flock leaves no outcome; a release fault after the
        // section ran cannot recall what it did, so the recorded outcome stands.
      }
      if (outcome === undefined) {
        setView(runId, entry, "deferred", "run_lock_unavailable");
        return;
      }
      if (outcome.kind === "faulted") throw outcome.error;
      if (outcome.kind === "settled") return;
      if (outcome.kind === "reconciled_absent") {
        // The pane is gone, but no mutation of ours proved it: another actor
        // closed it in the window. Neither the marker nor a `lane_retired`
        // claim — the supervisor's own pane_closed path settles the run and
        // its job_terminal still emits; the next sweep observes the absence.
        resetClock(entry);
        setView(runId, entry, "deferred", "close_reconciled_absent");
        return;
      }
      const { jobId } = outcome;
      try {
        const result = await deps.mailbox.writeRunEvent({
          kind: "lane_retired",
          runId,
          jobId,
          childIdentity: { agentName: identity.agentName, agentKind: identity.agentKind, paneId, terminalId: identity.terminalId },
          handoff: { state: "handed_off", ...(state.artifact.sha256 === null ? {} : { artifactSha256: state.artifact.sha256 }) },
          actions: [`pane_closed:${paneId}`, `artifact:${run.artifactPath}`],
        });
        if (!result.persisted) {
          log(`herdr-tools-daemon lane_retire run=${runId} decision=retired_event_unpersisted reason=${result.reason}`);
        }
      } catch {
        // The retirement already landed; a failed event write is journaled,
        // never claimed — the mailbox's own accounting records the loss.
        log(`herdr-tools-daemon lane_retire run=${runId} decision=retired_event_unpersisted reason=unavailable`);
      }
    } finally {
      await lease.release().catch(() => undefined);
    }
  }

  async function evaluate(runId: string, snapshot: HerdrSnapshot): Promise<void> {
    const prior = ledger.get(runId);
    if (prior !== undefined && (TERMINAL_VIEWS.has(prior.view.state) || (prior.view.state === "kept" && prior.view.reason === TASK_KEEP_REASON))) return;
    const entry = prior ?? { focusDefers: 0, attempts: 0, view: { state: "watching" as const } };

    let run: HandoffAllocation;
    let state: HandoffState;
    try {
      run = await deps.allocator.open(runId);
      state = await readHandoffState(run);
    } catch (error) {
      ledger.set(runId, entry);
      setView(runId, entry, "refused", `sidecar_${codeOf(error)}`);
      return;
    }
    if (state.lifecycle.state !== "handed_off") {
      ledger.delete(runId);
      return;
    }
    ledger.set(runId, entry);
    if (state.child.terminalId === null || state.nativeSession === null) {
      setView(runId, entry, "refused", "child_identity_unbound");
      return;
    }
    const childSession = state.nativeSession;

    const provenanceRead = await readProvenance(run);
    if ("refusal" in provenanceRead) {
      setView(runId, entry, "refused", provenanceRead.refusal);
      return;
    }
    const provenance = provenanceRead.provenance;
    // The ADR-040 opt-out precedes live-identity work: a kept run never
    // retires, so nothing past this point is worth proving for it.
    if (provenance?.task.retention === "keep") {
      setView(runId, entry, "kept", TASK_KEEP_REASON);
      return;
    }
    // The child's own session key — the sub-manager and mailbox guards key on
    // it; a record whose session cannot form a key fails closed.
    let childKey: string;
    try {
      childKey = managerSessionKey(childSession);
    } catch {
      setView(runId, entry, "refused", "child_session_invalid");
      return;
    }

    const verdict = classifyChild(snapshot, state);
    if (verdict.kind === "absent") {
      ledger.delete(runId);
      log(`herdr-tools-daemon lane_retire run=${runId} decision=skipped reason=child_absent`);
      return;
    }
    if (verdict.kind === "ambiguous") {
      resetClock(entry);
      setView(runId, entry, "deferred", bounded(`child_${verdict.reason}`));
      return;
    }
    const identity = verdict.identity;
    const paneId = identity.paneId;
    const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId)!;
    const records = snapshotIdentityRecords(snapshot, paneId);

    // The cooperative no-contract opt-out (design B3 fallback): a `retention=keep`
    // pane token parks the lane exactly like the task field. It is read before
    // any clock work so a kept lane accrues no grace: every kept sweep resets
    // the window, and clearing the token starts a full grace from scratch.
    const retentionToken = mergedToken(records, "retention");
    if (retentionToken.state === "value" && retentionToken.value === "keep") {
      resetClock(entry);
      setView(runId, entry, "kept", "token_retention_keep");
      return;
    }

    const lifecycle = lifecycleOf(records[0]!, records[1]!);
    if ("refusal" in lifecycle) {
      resetClock(entry);
      setView(runId, entry, "deferred", lifecycle.refusal);
      return;
    }
    if (lifecycle.status !== "idle" && lifecycle.status !== "done") {
      resetClock(entry);
      setView(runId, entry, "deferred", `child_active:${bounded(lifecycle.status)}`);
      return;
    }
    const screen = await screenDigest(paneId);
    if ("refusal" in screen) {
      resetClock(entry);
      setView(runId, entry, "deferred", screen.refusal);
      return;
    }
    const nowMs = now().getTime();
    if (entry.seq !== lifecycle.seq || entry.screen !== screen.digest || entry.sinceMs === undefined) {
      entry.seq = lifecycle.seq;
      entry.screen = screen.digest;
      entry.sinceMs = nowMs;
    }
    const stableForMs = nowMs - entry.sinceMs;
    if (stableForMs < deps.options.graceMs) {
      setView(runId, entry, "watching", undefined, stableForMs);
      return;
    }

    const provenanceToken = mergedToken(records, "identity_provenance");
    if (provenanceToken.state !== "value" || provenanceToken.value !== "launched") {
      setView(runId, entry, "refused", `token_provenance_${provenanceToken.state === "value" ? "not_launched" : provenanceToken.state}`);
      return;
    }
    const sessionToken = mergedToken(records, "identity_session");
    if (sessionToken.state !== "value") {
      setView(runId, entry, "refused", `token_session_${sessionToken.state}`);
      return;
    }
    if (sessionToken.value !== tokenValue(childSession.value)) {
      setView(runId, entry, "refused", "token_session_mismatch");
      return;
    }
    let policy;
    try {
      policy = classifyCaller(snapshot, paneId);
    } catch {
      setView(runId, entry, "refused", "caller_policy_unavailable");
      return;
    }
    if (policy.scope !== "worker") {
      setView(runId, entry, "refused", `child_is_manager:${policy.basis}`);
      return;
    }
    const veto = await vetoes(snapshot, paneId, pane.tab_id, childKey, state, provenance);
    if (veto !== undefined) {
      setView(runId, entry, veto.state, veto.reason);
      return;
    }

    if (pane.focused === true && entry.focusDefers < maxFocusDefers) {
      entry.focusDefers += 1;
      setView(runId, entry, "deferred", "focused", stableForMs);
      return;
    }
    // An exhausted bound keeps its count so the under-lock re-check does not
    // re-defer the same pane forever; only a genuinely unfocused sweep resets.
    if (pane.focused !== true) entry.focusDefers = 0;

    if (!deps.options.enabled) {
      setView(runId, entry, "disabled", undefined, stableForMs, "would_retire");
      return;
    }
    setView(runId, entry, "eligible", undefined, stableForMs);
    try {
      await closeLane(runId, run, state, identity, childKey, entry);
    } catch (error) {
      // A close-path fault the lease's finally already unwound — the run
      // keeps its spent attempts and retries on a later sweep.
      setView(runId, entry, "deferred", `sweep_error:${codeOf(error)}`);
    }
  }

  return {
    async sweep() {
      let snapshot: HerdrSnapshot;
      try {
        snapshot = await deps.snapshot();
      } catch (error) {
        // No observation, no proof: the sweep holds every clock and retries next tick.
        log(`herdr-tools-daemon lane_retire decision=sweep_unavailable reason=${bounded(codeOf(error))}`);
        return;
      }
      let entries: Dirent[];
      try {
        entries = await readdir(deps.runs.dir, { withFileTypes: true });
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) {
          log(`herdr-tools-daemon lane_retire decision=sweep_unavailable reason=${bounded(codeOf(error))}`);
          return;
        }
        entries = [];
      }
      const seen = new Set<string>();
      for (const entry of entries) {
        if (!entry.isDirectory() || !RUN_ID_PATTERN.test(entry.name)) continue;
        seen.add(entry.name);
        try {
          await evaluate(entry.name, snapshot);
        } catch (error) {
          // Every fallible step inside evaluate() records its own deferral or
          // refusal before it can throw, so an escape here is a defect — not
          // a verdict. Journal it; the run retries with its last proven view.
          log(`herdr-tools-daemon lane_retire run=${entry.name} decision=sweep_error reason=${bounded(codeOf(error))}`);
        }
      }
      // A vanished run directory leaves nothing to project or retire.
      for (const runId of [...ledger.keys()]) {
        if (!seen.has(runId)) ledger.delete(runId);
      }
    },
    view(runId) {
      const entry = ledger.get(runId);
      return entry === undefined ? undefined : { ...entry.view };
    },
    retiredByDaemon(runId) {
      return retired.has(runId);
    },
  };
}
