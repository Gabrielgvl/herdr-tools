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
  type ReconciliationFailureReason,
  type SupervisionEvent,
  type SupervisionEventType,
  type SupervisionTransition,
} from "./events.js";
import {
  classifySnapshotTarget,
  movedIdentity,
  occupantContinuity,
  paneContinuity,
  sameSupervisedIdentity,
  type AuthoritativeOccupant,
  type SupervisedIdentity,
  type SupervisionAnchor,
} from "./identity.js";
import { SUPERVISION_RECONCILIATION_INTERVAL_MS, type SessionEventMonitor, type SupervisionObserver } from "./monitor.js";
import type { ManagerNotifier } from "./notify.js";
import {
  isPaneRecordEvent,
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
import type { SupervisionChildBindingPublication, SupervisionResult } from "../job-registry.js";

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

const inertBindingPublication: SupervisionChildBindingPublication = {
  commit: () => undefined,
  rollback: () => undefined,
  publish: () => undefined,
};

export class Supervisor implements SupervisionObserver, SupervisionJobPort {
  private readonly log: SupervisionEventLog;
  private readonly transitions = new BoundedHistory<SupervisionTransition>(SUPERVISION_MAX_TRANSITIONS);
  private readonly reviews = new BoundedHistory<SupervisionReviewView>(SUPERVISION_MAX_REVIEWS);
  private readonly scheduler: SupervisionScheduler;
  private readonly settled: Promise<Settlement>;
  private resolveSettled!: (settlement: Settlement) => void;
  /** Admitted evidence, in arrival order, that the mutation chain has not folded yet. */
  private readonly queued: SupervisionSocketEvent[] = [];
  /**
   * The one ordered mutation chain. Every fold and the bind commit run on it, so
   * evidence can never fold beside a fold, out of arrival order, or against a
   * binding whose commit has not yet seen it.
   */
  private chain: Promise<void> = Promise.resolve();
  private state: SupervisionState = "reserved";
  private paneId: string | undefined;
  private identity: SupervisedIdentity | undefined;
  private anchor: SupervisionAnchor | undefined;
  private status: SupervisionAgentStatus | undefined;
  /**
   * The highest pane revision this supervisor has folded, always relative to the
   * pane it is currently bound to. It is the whole deduplication mechanism: a
   * `PaneInfo` event below it describes state already reflected here, and a
   * proven move resets it to the destination pane's own numbering.
   */
  private lastRevision = 0;
  /**
   * The destination of a move already proven to be this child's, retained
   * because the destination's own snapshot was invalid at the time. The child is
   * there and not in the origin pane, so the origin's later absence is only this
   * move's shadow: every authoritative read classifies this destination instead,
   * until one is valid enough to follow or to settle on.
   */
  private pendingMoveDestination: SupervisionPaneRecord | undefined;
  private evidenceGaps = 0;
  private eventStreamDegraded = false;
  private reconciliationDegraded = false;
  private reconciliationConsecutiveFailures = 0;
  private reconciliationLastAttemptAtMs: number | undefined;
  private reconciliationLastSuccessAtMs: number | undefined;
  private reconciliationLastFailureAtMs: number | undefined;
  private reconciliationLastFailureReason: ReconciliationFailureReason | undefined;
  private reviewerDegraded = false;
  private lastReviewAtMs: number | undefined;
  private workingSinceMs: number | undefined;
  /** Increments on each entry into `working`, so a review can prove it is still reviewing its own run. */
  private workingRun = 0;
  /** The transcript window the previous completed review consumed. */
  private reviewedTranscript: string[] = [];
  private reviewTimer: unknown;
  private reviewing = false;
  private settlement: Settlement | undefined;
  private selectedProfileName: string | undefined;
  private bindStarted = false;
  /** True from the moment the anchor is prepared until the bind commit resolves. */
  private bindPending = false;
  private bindingPublished = false;
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
  async bind(binding: SupervisionBinding, publication: SupervisionChildBindingPublication = inertBindingPublication): Promise<void> {
    if (this.bindStarted || this.stopped || this.state !== "reserved") {
      throw new SupervisionBindError("Supervision binding is single-use", this.bindEvidence(binding, { cause: "bind_already_attempted" }));
    }
    this.bindStarted = true;
    this.paneId = binding.identity.paneId;
    this.deps.monitor.addObserver(this);
    let snapshot: HerdrSnapshot;
    try {
      snapshot = await this.deps.monitor.snapshot();
    } catch (error) {
      this.resetPreparedBinding();
      throw new SupervisionBindError("Supervision binding could not read authoritative state", this.bindEvidence(binding, { cause: reasonOf(error) }));
    }
    const target = classifySnapshotTarget(snapshot, binding.identity.paneId);
    if (target.kind !== "unique" || !target.occupant.agentPresent) {
      this.resetPreparedBinding();
      const cause = target.kind === "invalid" ? target.reason : target.kind === "absent" ? "occupant_absent" : "agent_absent";
      throw new SupervisionBindError("Supervision binding found no valid unique authoritative occupant", this.bindEvidence(binding, { cause }));
    }
    const occupant = target.occupant;
    if (occupantContinuity(binding.identity, occupant) !== "continuous") {
      this.resetPreparedBinding();
      throw new SupervisionBindError("Supervision binding could not prove the launched identity", this.bindEvidence(binding, { cause: "identity_mismatch", observedStatus: occupant.pane.agentStatus }));
    }

    // Prepare the exact child privately. Queued evidence folds against this
    // anchor, but the public view stays reserved until the drain proves the
    // supervisor did not settle.
    this.identity = binding.identity;
    this.selectedProfileName = binding.profileName;
    this.anchor = { revision: occupant.pane.revision, status: occupant.pane.agentStatus, ...(binding.stateChangeSeq === undefined ? {} : { stateChangeSeq: binding.stateChangeSeq }) };
    this.status = occupant.pane.agentStatus;
    this.lastRevision = occupant.pane.revision;
    // The drain, the settlement check, and the publication are one task on the
    // mutation chain: an event admitted at any point before the commit folds
    // inside this task, and the commit sees its outcome.
    this.bindPending = true;
    await this.serialize(async () => {
      // Cleared inside the task, so the very next task on the chain folds for
      // itself rather than deferring to a bind that is already over.
      try {
        await this.commitBinding(binding, publication);
      } finally {
        this.bindPending = false;
      }
    });
  }

  private async commitBinding(binding: SupervisionBinding, publication: SupervisionChildBindingPublication): Promise<void> {
    try {
      await this.drainAdmitted();
    } catch (error) {
      publication.rollback();
      this.resetPreparedBinding();
      throw new SupervisionBindError("Supervision binding could not drain queued evidence", this.bindEvidence(binding, { cause: reasonOf(error) }));
    }
    if (this.isSettled()) {
      publication.rollback();
      throw new SupervisionBindError("Supervision settled while queued binding evidence was drained", this.bindEvidence(binding, {
        cause: "settled_during_bind",
        settledDuringBind: true,
        ...(this.settlement === undefined ? {} : { supervisionOutcome: this.settlement.outcome, supervisionReason: this.settlement.reason }),
      }));
    }

    try {
      publication.commit();
      this.bindingPublished = true;
      // Adopt the outage the monitor is already in, so this supervisor owns the
      // episode it was born into: without it the view projects degraded from the
      // monitor's flag while this side believes it is connected, and the
      // reconnect that follows is dropped as a recovery from nothing.
      this.eventStreamDegraded = this.deps.monitor.isDegraded();
      this.state = "active";
      this.refreshActiveState();
      publication.publish();
    } catch (error) {
      publication.rollback();
      this.resetPreparedBinding();
      throw new SupervisionBindError("Supervision binding could not publish its exact child", this.bindEvidence(binding, { cause: reasonOf(error) }));
    }
    try {
      this.enterStatus(this.status!);
    } catch {
      // Lifecycle observation is already active. A reviewer timer failure cannot
      // roll back exact supervision after its public commit.
      this.reviewerDegraded = true;
      this.publish("supervision reviewer cadence could not be armed");
    }
    this.publish(`supervising ${this.deps.child.agentName}`);
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

  private resetPreparedBinding(): void {
    this.clearReviewTimer();
    this.deps.monitor.removeObserver(this);
    this.queued.length = 0;
    this.paneId = undefined;
    this.identity = undefined;
    this.anchor = undefined;
    this.status = undefined;
    this.lastRevision = 0;
    this.pendingMoveDestination = undefined;
    this.selectedProfileName = undefined;
    this.eventStreamDegraded = false;
    this.bindingPublished = false;
    if (!this.isSettled()) this.state = "reserved";
  }

  // ----------------------------------------------------------------- observer

  /** Read through a method so a caller's narrowing cannot outlive an async settle. */
  private isSettled(): boolean {
    return this.state === "settled";
  }

  matches(paneId: string): boolean {
    return !this.stopped && this.paneId === paneId;
  }

  /**
   * Admit evidence. Arrival order is fixed here; the chain folds it. An event
   * that lands while an earlier fold — or the bind commit — is still in flight
   * waits its turn rather than folding beside it.
   */
  async onEvent(event: SupervisionSocketEvent): Promise<void> {
    if (this.stopped) return;
    this.queued.push(event);
    await this.serialize(() => this.foldAdmitted());
  }

  /** Reconnect snapshots use the same identity, validity, and revision rules as periodic snapshots. */
  async onBootstrap(snapshot: HerdrSnapshot, _generation: number, reconnected: boolean): Promise<void> {
    if (this.stopped || !reconnected) return;
    await this.serialize(async () => {
      if (this.stopped || this.identity === undefined || this.anchor === undefined) return;
      await this.applyAuthoritativeSnapshot(snapshot, "reconnect", "identity_lost");
    });
  }

  async onReconciliationSnapshot(snapshot: HerdrSnapshot): Promise<void> {
    if (this.stopped) return;
    await this.serialize(async () => {
      if (this.stopped || this.identity === undefined || this.anchor === undefined || this.isSettled()) return;
      await this.applyAuthoritativeSnapshot(snapshot, "periodic_snapshot", "released");
    });
  }

  onReconciliationFailure(reason: ReconciliationFailureReason): void {
    if (this.stopped || this.identity === undefined || this.isSettled()) return;
    this.markReconciliationFailure(reason);
  }

  onMonitorDegraded(reason: string): void {
    // A reservation is not yet supervising anything, so it has no health to report.
    if (this.stopped || this.identity === undefined || this.isSettled() || this.eventStreamDegraded) return;
    this.eventStreamDegraded = true;
    this.refreshActiveState();
    this.emit("monitor_degraded", `supervision lost its Herdr event connection (${reason}) and is retrying`, { reason });
  }

  onMonitorRecovered(): void {
    if (this.stopped || this.identity === undefined || this.isSettled() || !this.eventStreamDegraded) return;
    this.eventStreamDegraded = false;
    this.refreshActiveState();
    this.emit("monitor_recovered", "supervision restored its Herdr event connection");
  }

  // -------------------------------------------------------------------- folding

  /** Run one task on the mutation chain. A failing task never breaks the chain. */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * While a bind is in flight the drain belongs to it alone, so a fold that
   * fails before the commit still fails the bind rather than escaping through
   * whichever admission happened to reach the chain first.
   */
  private async foldAdmitted(): Promise<void> {
    if (this.bindPending) return;
    await this.drainAdmitted();
  }

  /**
   * Fold every admitted event, in arrival order, against the same revision
   * watermark every other event uses, so a queued historical event is discarded
   * exactly as a replayed one is. Evidence admitted while the loop runs is
   * picked up by the same pass, which is what lets the bind commit prove that
   * nothing it admitted is still unfolded. Before the anchor is proven there is
   * nothing to fold against, so admitted evidence waits for the binding drain.
   */
  private async drainAdmitted(): Promise<void> {
    while (!this.stopped && this.identity !== undefined) {
      const event = this.queued.shift();
      if (event === undefined) return;
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
    // Destination revisions are pane-local. A move proves and rebases the new
    // pane before any revision comparison with later destination evidence.
    if (event.event === "pane_moved") {
      await this.followMove(event, pane);
      return;
    }
    if (this.pendingMoveDestination !== undefined) {
      // The watermark still counts the origin pane's revisions while the child
      // is already elsewhere, so nothing can be folded against it. The retained
      // destination is classified authoritatively instead.
      await this.reconcile(`event:${event.event}`);
      return;
    }
    if (pane.revision < this.lastRevision) return;
    const verdict = paneContinuity(this.identity!, pane);
    if (verdict === "replaced") {
      await this.reconcile("event:continuity_broken");
      return;
    }
    if (verdict === "unproven") {
      await this.reconcile("event:continuity_unproven");
      return;
    }
    this.applyEventRevision(pane);
  }

  /**
   * Requirement 6: follow a move only when the atomic event and a fresh
   * authoritative occupant both prove terminal and agent-session continuity.
   *
   * A move that does not describe *this* occupant leaving *this* pane is not our
   * move at all. Pane ids are reused, so such an event can reach us by routing
   * alone; concluding `identity_lost` from it would settle a live supervisor on
   * somebody else's evidence. Those reconcile from authoritative state instead,
   * and only a move that is provably ours but whose destination cannot be
   * confirmed settles.
   */
  private async followMove(event: SupervisionSocketEvent, pane: SupervisionPaneRecord): Promise<void> {
    // Atomicity is a protocol-boundary guarantee: a `pane_moved` without a
    // previous pane id never reaches a supervisor.
    if (event.previousPaneId! !== this.identity!.paneId) {
      await this.reconcile("event:move_foreign_previous_pane");
      return;
    }
    if (paneContinuity(this.identity!, pane) !== "continuous") {
      await this.reconcile("event:move_identity_unproven");
      return;
    }
    let snapshot: HerdrSnapshot;
    try {
      snapshot = await this.deps.monitor.snapshot();
    } catch {
      await this.settle("identity_lost", "move_reconciliation_unavailable");
      return;
    }
    const target = classifySnapshotTarget(snapshot, pane.paneId);
    if (target.kind === "invalid") {
      // The move itself is proven; only this one read of its destination is
      // unusable. Retaining the destination is what keeps the origin pane's
      // absence — which this very move caused — from later reading as a closure.
      this.pendingMoveDestination = pane;
      this.markReconciliationFailure(target.reason);
      return;
    }
    if (target.kind === "absent" || !target.occupant.agentPresent) {
      await this.settle("identity_lost", "move_continuity_unproven");
      return;
    }
    const occupant = target.occupant;
    const next = movedIdentity(this.identity!, pane, occupant);
    if (next === undefined) {
      await this.settle("identity_lost", "move_continuity_unproven");
      return;
    }
    this.markReconciliationSuccess();
    this.adoptMove(next, occupant);
  }

  /**
   * Rebase onto a destination pane whose occupant is proven to be this child.
   * Revisions are per pane, so the watermark and the anchor take the
   * destination's own numbering. Keeping the origin pane's higher revision would
   * discard every later event on the new pane.
   */
  private adoptMove(next: SupervisedIdentity, occupant: AuthoritativeOccupant): void {
    this.pendingMoveDestination = undefined;
    this.identity = next;
    this.paneId = next.paneId;
    this.lastRevision = occupant.pane.revision;
    this.anchor = { ...this.anchor!, revision: occupant.pane.revision, status: occupant.pane.agentStatus };
    this.publish(`child moved to pane ${next.paneId}`);
    this.applyStatus(occupant.pane.agentStatus, occupant.pane.revision, "snapshot");
  }

  /**
   * One authoritative reconciliation.
   *
   * `fold` and `followMove` are the only callers and both refuse once settled,
   * so this needs no settled guard of its own. Both also run on the mutation
   * chain, so two reconciliations can never overlap and none can be started by
   * evidence this one has not seen — which is why triggers are answered one
   * read each rather than coalesced.
   */
  private async reconcile(trigger: string): Promise<void> {
    let snapshot: HerdrSnapshot;
    try {
      snapshot = await this.deps.monitor.snapshot();
    } catch (error) {
      this.markReconciliationFailure(reconciliationFailureReason(error));
      return;
    }
    await this.applyAuthoritativeSnapshot(snapshot, trigger, "released");
  }

  private applyEventRevision(pane: SupervisionPaneRecord): void {
    const previousRevision = this.lastRevision;
    if (pane.revision === previousRevision) {
      if (pane.agentStatus === this.status) return;
      this.recordEvidenceGap("event", "status_changed_without_revision", previousRevision, pane.revision);
      this.applyStatus(pane.agentStatus, pane.revision, "event");
      return;
    }
    if (pane.revision > previousRevision + 1) {
      this.recordEvidenceGap("event", "revision_jump", previousRevision, pane.revision, pane.revision - previousRevision - 1);
    }
    this.lastRevision = pane.revision;
    this.applyStatus(pane.agentStatus, pane.revision, "event");
  }

  private async applyAuthoritativeSnapshot(snapshot: HerdrSnapshot, trigger: string, missingOutcome: "identity_lost" | "released"): Promise<void> {
    // A retained move destination is where the child actually is, so it is the
    // pane every rule below judges. The origin pane's absence is this move's own
    // shadow and proves nothing; only the destination's absence is a closure.
    const moved = this.pendingMoveDestination;
    const target = classifySnapshotTarget(snapshot, moved?.paneId ?? this.identity!.paneId);
    if (target.kind === "invalid") {
      this.markReconciliationFailure(target.reason);
      return;
    }
    if (target.kind === "absent") {
      this.markReconciliationSuccess();
      if (missingOutcome === "identity_lost") await this.settle("identity_lost", "reconnect_identity_unproven");
      else await this.settleWithEvent("pane_closed", "released", trigger, `the child's pane is no longer present (${trigger})`);
      return;
    }
    const occupant = target.occupant;
    if (!occupant.agentPresent) {
      this.markReconciliationSuccess();
      await this.settleWithEvent("released", "released", trigger, `the child agent is no longer present in its pane (${trigger})`);
      return;
    }
    const verdict = occupantContinuity(this.identity!, occupant);
    if (verdict === "replaced") {
      this.markReconciliationSuccess();
      await this.settleWithEvent("identity_replaced", "identity_replaced", trigger, `the child's pane is now occupied by a different agent (${trigger})`);
      return;
    }
    if (verdict === "unproven") {
      this.markReconciliationSuccess();
      await this.settleWithEvent("released", "released", trigger, `the child agent is no longer present in its pane (${trigger})`);
      return;
    }
    if (moved !== undefined) {
      // Continuity against the destination's own occupant is exactly the proof
      // the move's first read could not supply, so the move completes here. The
      // watermark still counts origin revisions, so it is rebased rather than
      // compared with the destination's pane-local numbering.
      this.markReconciliationSuccess();
      this.adoptMove({ ...this.identity!, paneId: moved.paneId }, occupant);
      return;
    }
    if (occupant.pane.revision < this.lastRevision) {
      this.markReconciliationFailure("revision_regressed");
      return;
    }
    this.markReconciliationSuccess();
    this.applySnapshotRevision(occupant);
  }

  private applySnapshotRevision(occupant: AuthoritativeOccupant): void {
    const previousRevision = this.lastRevision;
    if (occupant.pane.revision === previousRevision) {
      if (occupant.pane.agentStatus === this.status) return;
      this.recordEvidenceGap("snapshot", "status_changed_without_revision", previousRevision, occupant.pane.revision);
      this.applyStatus(occupant.pane.agentStatus, occupant.pane.revision, "snapshot");
      return;
    }
    this.recordEvidenceGap("snapshot", "revision_jump", previousRevision, occupant.pane.revision);
    this.lastRevision = occupant.pane.revision;
    this.applyStatus(occupant.pane.agentStatus, occupant.pane.revision, "snapshot");
  }

  private recordEvidenceGap(source: SupervisionTransition["source"], reason: "revision_jump" | "status_changed_without_revision", previousRevision: number, observedRevision: number, omittedRevisions?: number): void {
    this.evidenceGaps = Math.min(Number.MAX_SAFE_INTEGER, this.evidenceGaps + 1);
    this.emit("evidence_gap", `supervision observed incomplete ${source} revision evidence (${previousRevision} to ${observedRevision})`, {
      source,
      reason,
      previousRevision,
      observedRevision,
      ...(omittedRevisions === undefined ? {} : { omittedRevisions }),
    });
  }

  private markReconciliationFailure(reason: ReconciliationFailureReason): void {
    const now = this.deps.clock.now();
    this.reconciliationLastAttemptAtMs = now;
    this.reconciliationLastFailureAtMs = now;
    this.reconciliationLastFailureReason = reason;
    this.reconciliationConsecutiveFailures = Math.min(Number.MAX_SAFE_INTEGER, this.reconciliationConsecutiveFailures + 1);
    if (this.reconciliationDegraded) {
      this.publish(`authoritative reconciliation remains degraded (${reason})`);
      return;
    }
    this.reconciliationDegraded = true;
    this.refreshActiveState();
    this.emit("reconciliation_degraded", "authoritative supervision reconciliation is degraded and will retry", { reason });
  }

  private markReconciliationSuccess(): void {
    const now = this.deps.clock.now();
    this.reconciliationLastAttemptAtMs = now;
    this.reconciliationLastSuccessAtMs = now;
    this.reconciliationConsecutiveFailures = 0;
    this.reconciliationLastFailureReason = undefined;
    if (!this.reconciliationDegraded) return;
    this.reconciliationDegraded = false;
    this.refreshActiveState();
    this.emit("reconciliation_recovered", "authoritative supervision reconciliation recovered");
  }

  private refreshActiveState(): void {
    if (!this.bindingPublished || this.identity === undefined || this.isSettled()) return;
    this.state = this.eventStreamDegraded || this.reconciliationDegraded ? "degraded" : "active";
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
    if (!this.bindingPublished) {
      this.workingSinceMs = undefined;
      return;
    }
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
    if (this.reviewing) {
      // An obsolete review from an earlier run is still settling. Re-arm so the
      // current run is not starved by a call it could not make.
      if (this.reviewable()) this.armReview(this.deps.cadenceMs);
      return;
    }
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
      // A failure that belongs to a run which has already ended is not evidence
      // about anything either: it must not degrade the reviewer, wake anyone, or
      // publish, exactly as an obsolete success must not.
      if (!this.reviewable(run)) return;
      if (!this.reviewerDegraded) {
        this.reviewerDegraded = true;
        this.emit("reviewer_degraded", `the supervision reviewer failed (${reviewerReason(error)}) and will retry at the next cadence`, { reason: reviewerReason(error) });
      } else {
        this.publish(`review failed again (${reviewerReason(error)})`);
      }
    } finally {
      this.reviewing = false;
      // Only the run this review belonged to may re-arm. A newer run already
      // armed its own cadence when it began, and clearing that here would delay
      // it by a whole interval.
      if (!this.stopped && this.reviewable(run)) this.armReview(this.deps.cadenceMs);
    }
  }

  /**
   * A review is only meaningful while the child is still inside the same
   * continuous working run it was started for.
   */
  private reviewable(run?: number): boolean {
    if (this.stopped || this.isSettled() || this.status !== "working") return false;
    return run === undefined || this.workingRun === run;
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
    const streamDegraded = this.eventStreamDegraded || this.deps.monitor.isDegraded();
    const monitorDegraded = streamDegraded || this.reconciliationDegraded;
    const projectedState = this.bindingPublished && !this.isSettled()
      ? monitorDegraded ? "degraded" : "active"
      : this.state;
    return {
      state: projectedState,
      monitor: {
        connected: !streamDegraded,
        degraded: monitorDegraded,
        generation: this.deps.monitor.generation,
        evidenceGaps: this.evidenceGaps,
        reconciliation: {
          intervalMs: SUPERVISION_RECONCILIATION_INTERVAL_MS,
          degraded: this.reconciliationDegraded,
          consecutiveFailures: this.reconciliationConsecutiveFailures,
          ...(this.reconciliationLastAttemptAtMs === undefined ? {} : { lastAttemptAtMs: this.reconciliationLastAttemptAtMs }),
          ...(this.reconciliationLastSuccessAtMs === undefined ? {} : { lastSuccessAtMs: this.reconciliationLastSuccessAtMs }),
          ...(this.reconciliationLastFailureAtMs === undefined ? {} : { lastFailureAtMs: this.reconciliationLastFailureAtMs }),
          ...(this.reconciliationLastFailureReason === undefined ? {} : { lastFailureReason: this.reconciliationLastFailureReason }),
        },
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
      ...(!this.bindingPublished || this.identity === undefined ? {} : { child: this.childView(this.identity) }),
      ...(!this.bindingPublished || this.status === undefined ? {} : { status: this.status }),
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
      ...(identity.agentKind === this.deps.child.agentKind ? {} : { requestedAgentKind: this.deps.child.agentKind }),
    };
  }

  takePendingEvents(): SupervisionEvent[] {
    const pending = this.log.pending();
    this.log.markObserved(pending.map((event) => event.eventId));
    return pending;
  }

  childLive(): boolean {
    return this.bindingPublished && (this.state === "active" || this.state === "degraded") && this.identity !== undefined;
  }

  coversIdentity(identity: SupervisedIdentity): boolean {
    if (!this.childLive() || this.identity === undefined) return false;
    try {
      return sameSupervisedIdentity(this.identity, identity);
    } catch {
      // The internal query is fail-closed if a structurally incomplete identity
      // crosses the typed seam.
      return false;
    }
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

function reconciliationFailureReason(error: unknown): ReconciliationFailureReason {
  const code = reasonOf(error);
  if (code === "SUPERVISION_SOCKET_UNAVAILABLE") return "connect_failed";
  if (code === "CLI_PROTOCOL_ERROR" || code === "SUPERVISION_PROTOCOL_ERROR") return "snapshot_protocol_invalid";
  return "request_failed";
}

function reviewerReason(error: unknown): string {
  return error instanceof ReviewerFailure ? error.message : reasonOf(error);
}
