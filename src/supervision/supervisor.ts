/**
 * One child's supervisor.
 *
 * It observes; it never mutates the child and never gates its work. Every exact
 * child transition is recorded, only the material subset wakes the manager, and
 * a wake is best effort — the manager recovers a dropped one with
 * `herdr_jobs get`, which returns the pending events and marks exactly those
 * observed.
 */

import { ReviewerFailure } from "../reviewer.js";
import type { HerdrSnapshot } from "../targets.js";
import {
  BoundedHistory,
  materialTransitionEvent,
  SupervisionEventLog,
  SUPERVISION_MAX_REVIEWS,
  SUPERVISION_MAX_TRANSITIONS,
  type SupervisionEvent,
  type SupervisionEventType,
  type SupervisionTransition,
} from "./events.js";
import {
  movedIdentity,
  occupantContinuity,
  paneContinuity,
  type AuthoritativeOccupant,
  type SupervisedIdentity,
  type SupervisionAnchor,
} from "./identity.js";
import type { SessionEventMonitor, SupervisionObserver } from "./monitor.js";
import type { ManagerNotifier } from "./notify.js";
import {
  isPaneRecordEvent,
  parsePaneRecord,
  type SupervisionAgentStatus,
  type SupervisionPaneRecord,
  type SupervisionSocketEvent,
} from "./protocol.js";
import { deltaLines } from "../transcript-delta.js";
import { needsManagerAttention, SUPERVISION_REVIEWER_MODEL, type SupervisionReviewer } from "./reviewer.js";
import type {
  SupervisionChildView,
  SupervisionJobPort,
  SupervisionJobView,
  SupervisionReviewView,
  SupervisionState,
} from "./state.js";
import type { SupervisionResult } from "../job-registry.js";

export interface SupervisionScheduler {
  setTimer(callback: () => void, milliseconds: number): unknown;
  clearTimer(handle: unknown): void;
}

export const realSupervisionScheduler: SupervisionScheduler = {
  setTimer: (callback, milliseconds) => {
    const timer = setTimeout(callback, milliseconds);
    timer.unref?.();
    return timer;
  },
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface SupervisionChildRequest {
  agentName: string;
  agentKind: string;
  profileName: string;
}

/** What binding proves. Every field comes from the launch's own readiness evidence. */
export interface SupervisionBinding {
  identity: SupervisedIdentity;
  /**
   * The profile that actually started the child. Fallback selection happens
   * after the reservation, so the reserved profile can name a different one and
   * the supervisor must publish the profile it is really watching.
   */
  profileName: string;
  /** Present only where the authoritative agent record supplied one. */
  stateChangeSeq?: number;
}

export interface SupervisorDependencies {
  jobId: string;
  child: SupervisionChildRequest;
  monitor: Pick<SessionEventMonitor, "addObserver" | "removeObserver" | "snapshot" | "generation" | "isDegraded">;
  notifier: ManagerNotifier;
  reviewer: SupervisionReviewer;
  cadenceMs: number;
  clock: { now(): number };
  scheduler?: SupervisionScheduler;
  /** Bounded transcript delta source for the reviewer; the CLI's authoritative pane read. */
  readTranscript: (paneId: string, signal: AbortSignal) => Promise<string[]>;
  idFactory?: () => string;
  update: (text: string, details?: unknown) => void;
}

export class SupervisionBindError extends Error {
  readonly code = "SUPERVISION_UNCONFIRMED" as const;

  constructor(message: string, readonly details: Record<string, unknown>) {
    super(message);
    this.name = "SupervisionBindError";
  }
}

interface Settlement {
  outcome: SupervisionResult;
  reason: string;
}

/** Find the authoritative occupant of one pane in a snapshot. */
export function snapshotOccupant(snapshot: HerdrSnapshot, paneId: string): AuthoritativeOccupant | undefined {
  const panes = snapshot.panes.filter((item) => item.pane_id === paneId);
  if (panes.length !== 1) return undefined;
  let pane: SupervisionPaneRecord;
  try {
    pane = parsePaneRecord(panes[0]);
  } catch {
    return undefined;
  }
  const agents = snapshot.agents.filter((item) => item.pane_id === paneId);
  if (agents.length > 1) return undefined;
  const name = agents[0]?.name;
  return { pane, ...(typeof name === "string" ? { agentName: name } : {}) };
}

export class Supervisor implements SupervisionObserver, SupervisionJobPort {
  private readonly log: SupervisionEventLog;
  private readonly transitions = new BoundedHistory<SupervisionTransition>(SUPERVISION_MAX_TRANSITIONS);
  private readonly reviews = new BoundedHistory<SupervisionReviewView>(SUPERVISION_MAX_REVIEWS);
  private readonly scheduler: SupervisionScheduler;
  private readonly settled: Promise<Settlement>;
  private resolveSettled!: (settlement: Settlement) => void;
  private readonly queued: SupervisionSocketEvent[] = [];
  private state: SupervisionState = "reserved";
  private paneId: string | undefined;
  private identity: SupervisedIdentity | undefined;
  private anchor: SupervisionAnchor | undefined;
  private status: SupervisionAgentStatus | undefined;
  private lastRevision = 0;
  /**
   * The highest connection-stream ordinal this supervisor has folded. The monitor
   * counts every accepted event, not only routed ones, so the ordinal names the
   * same log entry on every connection and survives a pane move rewriting the
   * routing key.
   */
  private foldedThrough = 0;
  private evidenceGaps = 0;
  private reviewerDegraded = false;
  private lastReviewAtMs: number | undefined;
  private workingSinceMs: number | undefined;
  /** Increments on each entry into `working`, so a review can prove it is still reviewing its own run. */
  private workingRun = 0;
  /** The transcript window the previous completed review consumed. */
  private reviewedTranscript: string[] = [];
  private reviewTimer: unknown;
  private reviewing = false;
  private reconciling = false;
  private reconcileAgain = false;
  private settlement: Settlement | undefined;
  private selectedProfileName: string | undefined;
  private stopped = false;
  private readonly abort = new AbortController();

  constructor(private readonly deps: SupervisorDependencies) {
    this.log = new SupervisionEventLog(deps.idFactory);
    this.scheduler = deps.scheduler ?? realSupervisionScheduler;
    this.settled = new Promise<Settlement>((resolve) => { this.resolveSettled = resolve; });
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Bind the supervisor to the exact child the launch proved. The observer is
   * registered *before* the confirming snapshot, so an event that lands between
   * the snapshot and the anchor is queued rather than lost.
   */
  async bind(binding: SupervisionBinding): Promise<void> {
    this.paneId = binding.identity.paneId;
    this.deps.monitor.addObserver(this);
    let snapshot: HerdrSnapshot;
    try {
      snapshot = await this.deps.monitor.snapshot();
    } catch (error) {
      this.deps.monitor.removeObserver(this);
      throw new SupervisionBindError("Supervision binding could not read authoritative state", this.bindEvidence(binding, { cause: reasonOf(error) }));
    }
    const occupant = snapshotOccupant(snapshot, binding.identity.paneId);
    if (!occupant) {
      this.deps.monitor.removeObserver(this);
      throw new SupervisionBindError("Supervision binding found no unique authoritative occupant", this.bindEvidence(binding, { cause: "occupant_not_unique" }));
    }
    if (occupantContinuity(binding.identity, occupant) !== "continuous") {
      this.deps.monitor.removeObserver(this);
      throw new SupervisionBindError("Supervision binding could not prove the launched identity", this.bindEvidence(binding, { cause: "identity_mismatch", observedStatus: occupant.pane.agentStatus }));
    }
    this.identity = binding.identity;
    this.selectedProfileName = binding.profileName;
    this.anchor = { revision: occupant.pane.revision, status: occupant.pane.agentStatus, ...(binding.stateChangeSeq === undefined ? {} : { stateChangeSeq: binding.stateChangeSeq }) };
    this.status = occupant.pane.agentStatus;
    this.lastRevision = occupant.pane.revision;
    this.state = "active";
    this.enterStatus(occupant.pane.agentStatus);
    this.publish(`supervising ${this.deps.child.agentName}`);
    await this.drainQueued();
  }

  /** Resolve when the supervisor settles. This is the supervisor job's run body. */
  async run(): Promise<Settlement> {
    return this.settled;
  }

  private bindEvidence(binding: SupervisionBinding, extra: Record<string, unknown>): Record<string, unknown> {
    return {
      jobId: this.deps.jobId,
      child: { ...this.deps.child, paneId: binding.identity.paneId, terminalId: binding.identity.terminalId },
      agentSession: { ...binding.identity.agentSession },
      ...extra,
    };
  }

  // ----------------------------------------------------------------- observer

  /** Read through a method so a caller's narrowing cannot outlive an async settle. */
  private isSettled(): boolean {
    return this.state === "settled";
  }

  matches(paneId: string): boolean {
    return !this.stopped && this.paneId === paneId;
  }

  async onEvent(event: SupervisionSocketEvent, ordinal: number): Promise<void> {
    if (this.stopped) return;
    if (this.identity === undefined) {
      this.queued.push(event);
      return;
    }
    if (ordinal <= this.foldedThrough) return;
    this.foldedThrough = ordinal;
    await this.fold(event);
  }

  async onBootstrap(snapshot: HerdrSnapshot, _generation: number, reconnected: boolean): Promise<void> {
    if (this.stopped || this.identity === undefined || this.anchor === undefined) return;
    if (!reconnected) return;
    const occupant = snapshotOccupant(snapshot, this.identity.paneId);
    if (!occupant || occupantContinuity(this.identity, occupant) !== "continuous") {
      await this.settle("identity_lost", "reconnect_identity_unproven");
      return;
    }
    // Requirement 7: resume silently only when nothing advanced. A revision past
    // the last folded one proves the lifecycle sequence moved while the socket
    // was down, whether or not the retained log can still replay it.
    if (occupant.pane.revision > this.lastRevision) {
      this.evidenceGaps += 1;
      this.emit("evidence_gap", `supervision reconnected with the child's lifecycle already advanced (revision ${this.lastRevision} to ${occupant.pane.revision})`, {
        lastFoldedRevision: this.lastRevision,
        observedRevision: occupant.pane.revision,
      });
    }
  }

  onMonitorDegraded(reason: string): void {
    // A reservation is not yet supervising anything, so it has no health to report.
    if (this.stopped || this.identity === undefined || this.isSettled()) return;
    this.state = "degraded";
    this.emit("monitor_degraded", `supervision lost its Herdr event connection (${reason}) and is retrying`, { reason });
  }

  onMonitorRecovered(): void {
    if (this.stopped || this.identity === undefined || this.isSettled()) return;
    this.state = "active";
    this.emit("monitor_recovered", "supervision restored its Herdr event connection");
  }

  // -------------------------------------------------------------------- folding

  /**
   * Events that arrived between adding the observer and proving the anchor. Their
   * ordinals were assigned by the monitor before binding completed, so they are
   * folded in arrival order and the watermark advances with them.
   */
  private async drainQueued(): Promise<void> {
    const pending = this.queued.splice(0);
    for (const event of pending) {
      if (this.stopped) return;
      await this.fold(event);
    }
  }

  private async fold(event: SupervisionSocketEvent): Promise<void> {
    if (this.state === "settled") return;
    if (!isPaneRecordEvent(event.event)) {
      // A thin event carries only a pane id, and Herdr reuses pane ids, so it is
      // a reconciliation trigger and never a conclusion.
      await this.reconcile(`event:${event.event}`);
      return;
    }
    // The protocol boundary refused every malformed known event, so a
    // `PaneInfo`-bearing kind always carries its validated record.
    const pane = event.pane!;
    if (event.event === "pane_moved") {
      await this.followMove(event, pane);
      return;
    }
    if (pane.revision < this.anchor!.revision) return;
    const verdict = paneContinuity(this.identity!, pane);
    if (verdict === "replaced") {
      await this.reconcile("event:continuity_broken");
      return;
    }
    if (verdict === "unproven") {
      await this.reconcile("event:continuity_unproven");
      return;
    }
    this.lastRevision = Math.max(this.lastRevision, pane.revision);
    this.applyStatus(pane.agentStatus, pane.revision, "event");
  }

  /**
   * Requirement 6: follow a move only when the atomic event and a fresh
   * authoritative occupant both prove terminal and agent-session continuity.
   */
  private async followMove(event: SupervisionSocketEvent, pane: SupervisionPaneRecord): Promise<void> {
    // Atomicity is a protocol-boundary guarantee: a `pane_moved` without a
    // previous pane id never reaches a supervisor.
    if (event.previousPaneId! !== this.identity!.paneId) {
      await this.settle("identity_lost", "move_previous_pane_mismatch");
      return;
    }
    let snapshot: HerdrSnapshot;
    try {
      snapshot = await this.deps.monitor.snapshot();
    } catch {
      await this.settle("identity_lost", "move_reconciliation_unavailable");
      return;
    }
    const occupant = snapshotOccupant(snapshot, pane.paneId);
    const next = occupant === undefined ? undefined : movedIdentity(this.identity!, pane, occupant, this.lastRevision);
    if (next === undefined) {
      await this.settle("identity_lost", "move_continuity_unproven");
      return;
    }
    this.identity = next;
    this.paneId = next.paneId;
    this.lastRevision = Math.max(this.lastRevision, occupant!.pane.revision);
    this.publish(`child moved to pane ${next.paneId}`);
    this.applyStatus(occupant!.pane.agentStatus, occupant!.pane.revision, "snapshot");
  }

  /** One coalesced authoritative reconciliation. Concurrent triggers collapse into a re-run. */
  private async reconcile(trigger: string): Promise<void> {
    // `fold` and `followMove` are the only callers and both refuse once settled,
    // so this method needs no settled guard of its own.
    if (this.reconciling) {
      this.reconcileAgain = true;
      return;
    }
    this.reconciling = true;
    try {
      do {
        this.reconcileAgain = false;
        let snapshot: HerdrSnapshot;
        try {
          snapshot = await this.deps.monitor.snapshot();
        } catch (error) {
          this.publish(`reconciliation unavailable (${trigger}: ${reasonOf(error)})`);
          return;
        }
        const occupant = snapshotOccupant(snapshot, this.identity!.paneId);
        if (occupant === undefined) {
          await this.settleWithEvent("pane_closed", "released", trigger, `the child's pane is no longer present (${trigger})`);
          return;
        }
        const verdict = occupantContinuity(this.identity!, occupant);
        if (verdict === "replaced") {
          await this.settleWithEvent("identity_replaced", "identity_replaced", trigger, `the child's pane is now occupied by a different agent (${trigger})`);
          return;
        }
        if (verdict === "unproven") {
          await this.settleWithEvent("released", "released", trigger, `the child agent is no longer present in its pane (${trigger})`);
          return;
        }
        this.lastRevision = Math.max(this.lastRevision, occupant.pane.revision);
        this.applyStatus(occupant.pane.agentStatus, occupant.pane.revision, "snapshot");
      } while (this.reconcileAgain && !this.isSettled());
    } finally {
      this.reconciling = false;
    }
  }

  // --------------------------------------------------------------- transitions

  private applyStatus(next: SupervisionAgentStatus, revision: number, source: SupervisionTransition["source"]): void {
    const from = this.status!;
    if (from === next) return;
    this.status = next;
    this.transitions.push({ atMs: this.deps.clock.now(), from, to: next, revision, source });
    this.enterStatus(next);
    const material = materialTransitionEvent(from, next);
    if (material === undefined) {
      // Working starts and every other non-material change are recorded silently.
      this.publish(`child ${from} → ${next}`);
      return;
    }
    this.emit(material, `child ${from} → ${next}`, { from, to: next, revision });
  }

  /** Reset or arm the review cadence for the status the child just entered. */
  private enterStatus(status: SupervisionAgentStatus): void {
    this.clearReviewTimer();
    if (status !== "working") {
      this.workingSinceMs = undefined;
      return;
    }
    this.workingSinceMs = this.deps.clock.now();
    this.workingRun += 1;
    this.armReview(this.deps.cadenceMs);
  }

  private armReview(delayMs: number): void {
    this.clearReviewTimer();
    this.reviewTimer = this.scheduler.setTimer(() => { void this.review(); }, delayMs);
  }

  private clearReviewTimer(): void {
    if (this.reviewTimer === undefined) return;
    this.scheduler.clearTimer(this.reviewTimer);
    this.reviewTimer = undefined;
  }

  // ------------------------------------------------------------------ reviewer

  /**
   * Review a child that has been working for a whole cadence. A failure enters
   * one visible degraded episode and retries at the next cadence; the first
   * success afterwards notifies recovery once. The supervisor stays active
   * either way.
   */
  private async review(): Promise<void> {
    if (!this.reviewable()) return;
    this.reviewing = true;
    const run = this.workingRun;
    const workingSinceMs = this.workingSinceMs!;
    try {
      const transcript = await this.deps.readTranscript(this.identity!.paneId, this.abort.signal);
      // The child may have finished its work cycle while the read was in flight.
      // A review of a run that is over is not evidence about anything, so it is
      // abandoned before the model call rather than stored or announced. The
      // transcript cursor does not advance: those lines were never reviewed.
      if (!this.reviewable(run)) return;
      const result = await this.deps.reviewer.review({
        paneId: this.identity!.paneId,
        agentName: this.identity!.agentName,
        workingForMs: Math.max(0, this.deps.clock.now() - workingSinceMs),
        metadata: { agentKind: this.identity!.agentKind, status: this.status, revision: this.lastRevision },
        // Only what is new since the previous completed review. Handing the whole
        // window back every cadence would let stale output keep reading as fresh
        // progress from a stalled child.
        transcriptDelta: deltaLines(this.reviewedTranscript, transcript),
      }, this.abort.signal);
      if (!this.reviewable(run)) return;
      this.reviewedTranscript = transcript;
      this.lastReviewAtMs = this.deps.clock.now();
      this.reviews.push({ atMs: this.lastReviewAtMs, classification: result.classification, summary: result.summary });
      if (this.reviewerDegraded) {
        this.reviewerDegraded = false;
        this.emit("reviewer_recovered", "the supervision reviewer recovered");
      }
      if (needsManagerAttention(result.classification)) {
        this.emit("reviewer_attention", `supervision review says ${result.classification}: ${result.summary}`, { classification: result.classification });
      } else {
        // Progress stores silently.
        this.publish(`review ${result.classification}: ${result.summary}`);
      }
    } catch (error) {
      if (!this.reviewerDegraded) {
        this.reviewerDegraded = true;
        this.emit("reviewer_degraded", `the supervision reviewer failed (${reviewerReason(error)}) and will retry at the next cadence`, { reason: reviewerReason(error) });
      } else {
        this.publish(`review failed again (${reviewerReason(error)})`);
      }
    } finally {
      this.reviewing = false;
      if (!this.stopped && !this.isSettled() && this.status === "working") this.armReview(this.deps.cadenceMs);
    }
  }

  /**
   * A review is only meaningful while the child is still inside the same
   * continuous working run it was started for.
   */
  private reviewable(run?: number): boolean {
    if (this.stopped || this.isSettled() || this.status !== "working") return false;
    return run === undefined ? !this.reviewing : this.workingRun === run;
  }

  // -------------------------------------------------------------------- events

  private emit(type: SupervisionEventType, summary: string, details?: Record<string, string | number | boolean>): SupervisionEvent {
    const event = this.log.record(type, this.deps.clock.now(), summary, details);
    this.publish(`${type}: ${summary}`);
    this.deps.notifier.wake({
      jobId: this.deps.jobId,
      // Every material event is emitted after binding, so the bound identity is
      // authoritative here rather than the requested profile's shape.
      child: { agentName: this.identity!.agentName, agentKind: this.identity!.agentKind, paneId: this.identity!.paneId },
      event,
    });
    return event;
  }

  private publish(text: string): void {
    try {
      this.deps.update(text, { operation: "supervision", jobId: this.deps.jobId, state: this.state, status: this.status });
    } catch {
      // Job progress is best effort and cannot affect supervision state.
    }
  }

  private async settleWithEvent(type: SupervisionEventType, outcome: SupervisionResult, trigger: string, summary: string): Promise<void> {
    this.emit(type, summary, { trigger });
    await this.settle(outcome, trigger);
  }

  private async settle(outcome: SupervisionResult, reason: string): Promise<void> {
    if (this.state === "settled") return;
    // `identity_lost` is the one settling outcome reached without its own event,
    // because a move or a reconnect proves it directly rather than observing it.
    if (outcome === "identity_lost") this.emit("identity_lost", `supervision lost the exact child's identity (${reason})`, { reason });
    this.state = "settled";
    this.settlement = { outcome, reason };
    this.clearReviewTimer();
    this.deps.monitor.removeObserver(this);
    this.publish(`supervision settled ${outcome}`);
    this.resolveSettled(this.settlement);
  }

  // ----------------------------------------------------------------- job port

  view(): SupervisionJobView {
    return {
      state: this.state,
      monitor: {
        connected: !this.deps.monitor.isDegraded(),
        degraded: this.deps.monitor.isDegraded(),
        generation: this.deps.monitor.generation,
        evidenceGaps: this.evidenceGaps,
      },
      reviewer: {
        model: SUPERVISION_REVIEWER_MODEL,
        thinking: "max",
        cadenceMinutes: Math.round(this.deps.cadenceMs / 60_000),
        degraded: this.reviewerDegraded,
        reviews: this.reviews.entries(),
        truncatedReviews: this.reviews.truncated(),
        ...(this.lastReviewAtMs === undefined ? {} : { lastReviewAtMs: this.lastReviewAtMs }),
      },
      transitions: this.transitions.entries(),
      truncatedTransitions: this.transitions.truncated(),
      events: this.log.history(),
      truncatedEvents: this.log.truncatedEvents(),
      unobservedEvents: this.log.unobserved(),
      ...(this.identity === undefined ? {} : { child: this.childView(this.identity) }),
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.settlement === undefined ? {} : { settledReason: this.settlement.reason }),
    };
  }

  private childView(identity: SupervisedIdentity): SupervisionChildView {
    // The bound profile is the one that actually started this child; binding sets
    // it alongside the identity this view already requires. The reserved profile
    // is kept beside it only when fallback selection changed it, so the two never
    // silently contradict each other.
    const profileName = this.selectedProfileName!;
    return {
      agentName: identity.agentName,
      agentKind: identity.agentKind,
      paneId: identity.paneId,
      terminalId: identity.terminalId,
      profileName,
      ...(profileName === this.deps.child.profileName ? {} : { requestedProfileName: this.deps.child.profileName }),
    };
  }

  takePendingEvents(): SupervisionEvent[] {
    const pending = this.log.pending();
    this.log.markObserved(pending.map((event) => event.eventId));
    return pending;
  }

  childLive(): boolean {
    return this.state !== "settled" && this.identity !== undefined;
  }

  shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearReviewTimer();
    this.abort.abort();
    this.deps.monitor.removeObserver(this);
    if (this.isSettled()) return;
    this.state = "settled";
    this.settlement = { outcome: "cancelled", reason: "manager_session_shutdown" };
    this.resolveSettled(this.settlement);
  }

  /** Release a reservation that never bound, so its job settles instead of leaking. */
  release(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearReviewTimer();
    this.abort.abort();
    this.deps.monitor.removeObserver(this);
    if (this.isSettled()) return;
    this.state = "settled";
    this.settlement = { outcome: "failed", reason };
    this.resolveSettled(this.settlement);
  }
}

function reasonOf(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : "UNKNOWN";
}

function reviewerReason(error: unknown): string {
  return error instanceof ReviewerFailure ? error.message : reasonOf(error);
}
