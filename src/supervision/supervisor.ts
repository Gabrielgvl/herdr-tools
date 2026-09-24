/**
 * One child's supervisor.
 *
 * It observes raw child lifecycle. Managed handoff integration may withhold Tools
 * completion acceptance and issue one identity-bound repair prompt without vetoing
 * the core state transition. Every exact child transition is recorded, and
 * a wake is best effort — the manager recovers a dropped one with
 * `herdr_jobs get`, which returns the pending events and marks exactly those
 * observed.
 */

import { ReviewerFailure, type ReviewClassification } from "../reviewer.js";
import { renderHandoffContract, type HandoffAllocation } from "../handoff.js";
import { handoffGateMatches, type HandoffGate, type HandoffInspection, type HandoffRun, type HandoffValidation } from "../handoff-gate.js";
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
  classifyProvisionalSnapshotTarget,
  classifySnapshotTarget,
  movedIdentity,
  occupantContinuity,
  paneContinuity,
  provisionalEventLifecycle,
  provisionalOccupantContinuity,
  sameSupervisedIdentity,
  type AuthoritativeOccupant,
  type ProvisionalSupervisedIdentity,
  type ProvisionalSupervisionBinding,
  type SupervisedIdentity,
  type SupervisionAnchor,
} from "./identity.js";
import { SUPERVISION_RECONCILIATION_INTERVAL_MS, type SessionEventMonitor, type SupervisionObserver } from "./monitor.js";
import type { ManagerNotifier, SupervisionWake } from "./notify.js";
import type { SelfCloseTracker } from "./self-close.js";
import {
  isPaneRecordEvent,
  type SupervisionAgentStatus,
  type SupervisionPaneRecord,
  type SupervisionSocketEvent,
} from "./protocol.js";
import { deltaLines } from "../transcript-delta.js";
import { createDevinSessionReader } from "./devin-trace.js";
import {
  buildEvidenceState,
  buildExecutionDigest,
  buildWorkspaceView,
  createNodeWorkspaceRunner,
  executionDigestHash,
  WORKSPACE_VIEW_VERSION,
  type DigestCursorRef,
  type EvidenceBuild,
  type EvidenceScanner,
  type EvidenceVersionIdentity,
  type WorkspaceCommandRunner,
  type WorkspaceView,
} from "./evidence.js";
import {
  createNodeFileReader,
  createTraceSource,
  type TraceCursor,
  type TraceSource,
  type TraceSourceKind,
  type TraceWindow,
} from "./trace-source.js";
import {
  supervisionAttention,
  supervisionReviewerUnavailable,
  SUPERVISION_PROGRESS_THRESHOLD,
  SUPERVISION_REVIEWER_IDENTITY,
  SUPERVISION_REVIEWER_MODEL,
  type SupervisionPreviousReview,
  type SupervisionReason,
  type SupervisionReviewer,
  type SupervisionReviewResult,
  type SupervisionSignalProbabilities,
} from "./reviewer.js";
import {
  appendSupervisionReview,
  defaultReviewLogRoot,
  representationForTraceSource,
  type SupervisionReviewLog,
  type SupervisionTier0Violation,
} from "./review-log.js";
import type {
  SupervisionChildView,
  SupervisionJobPort,
  SupervisionJobView,
  SupervisionReviewView,
  SupervisionState,
} from "./state.js";
import type {
  SupervisionChildBindingPublication,
  SupervisionReservationDigest,
  SupervisionResult,
  SupervisionWorkspaceRoot,
} from "../job-registry.js";

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
  operatingPointId: string;
}

/**
 * The V2 review record: the public `{atMs, classification, summary}` triple
 * plus the telemetry ADR-034 persists on every review — all signal
 * probabilities including the non-activating ones, the reason code, and the
 * evidence-sufficiency probability. The public projection keeps only the
 * triple, so existing consumers never see a shape change.
 */
interface SupervisionReviewRecord extends SupervisionReviewView {
  signals?: SupervisionSignalProbabilities;
  reason?: SupervisionReason;
  evidenceSufficiency?: number;
}

/** Reservation-local trajectory memory, including the exact compiled trace range of that review. */
interface SupervisorPreviousReview extends SupervisionPreviousReview {
  traceFromCursor: string | null;
  traceToCursor: string | null;
}

/** What binding proves. Every field comes from the launch's own readiness evidence. */
export interface SupervisionBinding {
  identity: SupervisedIdentity;
  /**
   * The compiled candidate that actually started the child. Fallback selection
   * happens after the reservation, so the reserved candidate can differ and the
   * supervisor must publish the candidate it is really watching.
   */
  operatingPointId: string;
  /** Present only where the authoritative agent record supplied one. */
  stateChangeSeq?: number;
  /**
   * The allocated managed-handoff run this binding must bind to the exact
   * identity. Present on every qualified managed launch; the registry binds it
   * through the shared gate before the child binding is accepted.
   */
  handoff?: { allocation: HandoffAllocation; agentId?: string };
}

export interface SupervisorDependencies {
  jobId: string;
  child: SupervisionChildRequest;
  monitor: Pick<SessionEventMonitor, "addObserver" | "removeObserver" | "snapshot" | "generation" | "isDegraded">;
  notifier: ManagerNotifier;
  reviewer: SupervisionReviewer;
  /**
   * The reservation's authorial digest plus its bounded `readOnly` claim,
   * supplied to every review as state (ADR-034; ADR-036 W0). Private: it is
   * never part of the public projection.
   */
  assignmentDigest?: SupervisionReservationDigest;
  /**
   * The trusted launch workspace root the per-cadence workspace evidence reads
   * (ADR-036 W0). Absent or a typed gap ⇒ the view reports the gap verbatim;
   * the supervisor's own `cwd` is never consulted.
   */
  workspaceRoot?: SupervisionWorkspaceRoot;
  /** The workspace view completed by `reserve()` before any child effect. */
  workspaceBase?: WorkspaceView;
  /**
   * The durable review-log append seam; `appendSupervisionReview` satisfies it
   * directly. A failed append degrades exactly like a reviewer failure —
   * telemetry is not a launch precondition, so a logging failure must never
   * blind the supervisor or kill the child.
   */
  reviewLog?: SupervisionReviewLog;
  /**
   * The trusted project root the review log appends under; defaults to
   * `HERDR_PROJECT_DIR` when set, else the host's own launch directory — the
   * same anchoring rule `resolveStartup` applies.
   */
  reviewLogRoot?: string;
  cadenceMs: number;
  clock: { now(): number };
  scheduler?: SupervisionScheduler;
  /**
   * The host's own-close ledger, consulted only for `pane_closed` wakes. Its
   * absence keeps every event waking exactly as before.
   */
  selfClose?: SelfCloseTracker;
  /**
   * The shared managed-handoff gate. When a bound run exists for the exact
   * identity, authoritative working transitions open a fresh artifact cycle,
   * terminal observations validate and may send one fenced repair prompt, and
   * an exit settlement persists the run's outcome first.
   */
  handoffs?: HandoffGate;
  /**
   * Exact-child repair prompt transport (`cli.prompt`). Absent on hosts that
   * cannot prompt; without one no repair fence is ever consumed.
   */
  repairPrompt?: (paneId: string, text: string, signal: AbortSignal) => Promise<unknown>;
  /** Bounded transcript delta source for the reviewer; the CLI's authoritative pane read. */
  readTranscript: (paneId: string, signal: AbortSignal) => Promise<string[]>;
  /**
   * The per-runner structured-trace seam (ADR-036 T1/T2). Defaults to the
   * production readers: Pi session JSONL by `agent_session.kind = "path"`,
   * Devin session records by `kind = "id"`, and this same transcript reader as
   * the explicitly-labelled `tmux-fallback` for every other runner.
   */
  traceSource?: TraceSource;
  /** The workspace command seam (ADR-036 E2); defaults to the stdlib git runner. */
  workspaceRunner?: WorkspaceCommandRunner;
  /** The local sensitive-context scan (ADR-036 E3); defaults to `scanEvidenceText`. */
  evidenceScanner?: EvidenceScanner;
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

interface ProvisionalLifecycle {
  stateChangeSeq: number;
  revision: number;
  status: SupervisionAgentStatus;
  events: SupervisionTransition[];
}

interface StrengtheningCandidate extends ProvisionalLifecycle {
  binding: SupervisionBinding;
  initialRevision: number;
}

interface SupervisionEndpoint {
  revision: number;
  status: SupervisionAgentStatus;
  stateChangeSeq: number | undefined;
}

type StateChangeSeqObservation = "advanced" | "unchanged" | "missing" | "regressed";

function compareStateChangeSeq(previous: number | undefined, observed: number | undefined): StateChangeSeqObservation {
  if (observed === undefined || previous === undefined) return "missing";
  if (observed < previous) return "regressed";
  return observed === previous ? "unchanged" : "advanced";
}

const inertBindingPublication: SupervisionChildBindingPublication = {
  commit: () => undefined,
  rollback: () => undefined,
  publish: () => undefined,
};

/** The build-side causes that are ADR-036 E3 byte-budget overflows. */
const EVIDENCE_OVERFLOW_CAUSES: ReadonlySet<string> = new Set(["assignment_over_budget", "trace_over_budget", "state_over_budget"]);
/** The seam-side failures that are those same budgets refusing a window. */
const EVIDENCE_OVERFLOW_FAILURES: ReadonlySet<string> = new Set(["record_exceeds_budget", "window_exceeds_budget"]);

/** One emitted Tier-0 wake paired with its closed violation kind, for the durable append that follows it. */
interface Tier0ViolationReport {
  violation: SupervisionTier0Violation;
  event: SupervisionEvent;
}

/** A digest cursor ref as the `source@position:hash` label the reviewer's provenance uses; absent positions omit the segment. */
function digestCursorLabel(cursor: DigestCursorRef | undefined): string | null {
  if (cursor === undefined) return null;
  return cursor.position === undefined ? `${cursor.source}:${cursor.hash}` : `${cursor.source}@${cursor.position}:${cursor.hash}`;
}

export class Supervisor implements SupervisionObserver, SupervisionJobPort {
  private readonly log: SupervisionEventLog;
  private readonly transitions = new BoundedHistory<SupervisionTransition>(SUPERVISION_MAX_TRANSITIONS);
  private readonly reviews = new BoundedHistory<SupervisionReviewRecord>(SUPERVISION_MAX_REVIEWS);
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
  private completionSignal?: (identity: SupervisedIdentity) => Promise<boolean>;
  private completionRecorded = false;
  private completionLogDegraded = false;
  private completionAttempts = 0;
  private completionRetry?: NodeJS.Timeout;
  private provisional: ProvisionalSupervisionBinding | undefined;
  private provisionalFailure: string | undefined;
  private provisionalNativeIdentity: SupervisedIdentity | undefined;
  private provisionalLifecycle: ProvisionalLifecycle | undefined;
  private anchor: SupervisionAnchor | undefined;
  private strengtheningCandidate: StrengtheningCandidate | undefined;
  private status: SupervisionAgentStatus | undefined;
  /**
   * The highest pane revision this supervisor has folded, always relative to the
   * pane it is currently bound to. It is the whole deduplication mechanism: a
   * `PaneInfo` event below it describes state already reflected here, and a
   * proven move resets it to the destination pane's own numbering.
   */
  private lastRevision = 0;
  /** The highest authoritative lifecycle sequence folded for the current exact child. */
  private lastStateChangeSeq: number | undefined;
  /** The last exact endpoint folded, including a raw sequence for replay checks. */
  private lastEndpoint: SupervisionEndpoint | undefined;
  /**
   * The destination of a move already proven to be this child's, retained
   * because the destination's own snapshot was invalid at the time. The child is
   * there and not in the origin pane, so the origin's later absence is only this
   * move's shadow: every authoritative read classifies this destination instead,
   * until one is valid enough to follow or to settle on.
   */
  private pendingMoveDestination: SupervisionPaneRecord | undefined;
  /** Exact move endpoints retained in arrival order until the destination is proven. */
  private readonly pendingMoveEndpoints: SupervisionEndpoint[] = [];
  private pendingMoveInitialStateChangeSeq: number | undefined;
  /**
   * Advances on every change to the pane this supervisor believes holds the
   * child — a retained move destination as well as an adopted one. A review
   * captures it before reading a transcript and must still hold it to dispatch
   * or store: `pendingMoveDestination` alone cannot express a move that is
   * proven immediately, nor one whose retained destination resolves, while a
   * read is in flight. Both leave the origin pane's transcript in hand with a
   * new pane bound, and Herdr reuses pane ids, so submitting it would review a
   * stranger's output under this child's new identity.
   */
  private paneIdentityGeneration = 0;
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
  /**
   * The V2 temporal memory handed back as state on the next review: the prior
   * classification and signals plus the progress watermark. In-memory only for
   * the life of the reservation — a restart resets it, which is acceptable on
   * a five-minute cadence (ADR-034).
   */
  private previousReview: SupervisorPreviousReview | undefined;
  /** The last review whose progress signal crossed its threshold; once set it only moves forward. */
  private lastMeaningfulProgressAtMs: number | undefined;
  private reviewTimer: unknown;
  private reviewing = false;
  /** The per-runner structured-trace seam (ADR-036 T1/T2). */
  private readonly traceSource: TraceSource;
  /** The injected workspace command seam (ADR-036 E2). */
  private readonly workspaceRunner: WorkspaceCommandRunner;
  /** The trace cursor the last completed cadence consumed — opaque, minted by the source. */
  private traceCursor: TraceCursor | undefined;
  /** The reservation's evidence version identity; drift is measured against it. */
  private evidenceBaseline: EvidenceVersionIdentity | undefined;
  private settlement: Settlement | undefined;
  private selectedOperatingPointId: string | undefined;
  private bindStarted = false;
  private strengtheningStarted = false;
  /** True from the moment the anchor is prepared until a bind/strengthen task resolves. */
  private bindPending = false;
  private bindingPublished = false;
  private provisionalPublished = false;
  private stopped = false;
  /** The bound managed run, retained so its evidence still projects after the gate drops a resolved run. */
  private boundHandoff: { gate: HandoffGate; run: HandoffRun } | undefined;
  private readonly abort = new AbortController();

  constructor(private readonly deps: SupervisorDependencies) {
    this.log = new SupervisionEventLog(deps.idFactory);
    this.scheduler = deps.scheduler ?? realSupervisionScheduler;
    this.traceSource = deps.traceSource ?? createTraceSource({
      readFileRange: createNodeFileReader(),
      readTerminal: deps.readTranscript,
      devinSession: createDevinSessionReader(),
    });
    this.workspaceRunner = deps.workspaceRunner ?? createNodeWorkspaceRunner();
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
    if (occupant.stateChangeSeq !== undefined && binding.stateChangeSeq !== undefined && occupant.stateChangeSeq < binding.stateChangeSeq) {
      this.resetPreparedBinding();
      throw new SupervisionBindError("Supervision binding observed regressed lifecycle evidence", this.bindEvidence(binding, {
        cause: "lifecycle_regressed",
        previousStateChangeSeq: binding.stateChangeSeq,
        observedStateChangeSeq: occupant.stateChangeSeq,
      }));
    }

    // Prepare the exact child privately. Queued evidence folds against this
    // anchor, but the public view stays reserved until the drain proves the
    // supervisor did not settle.
    this.identity = binding.identity;
    this.selectedOperatingPointId = binding.operatingPointId;
    const stateChangeSeq = occupant.stateChangeSeq ?? binding.stateChangeSeq;
    this.anchor = { revision: occupant.pane.revision, status: occupant.pane.agentStatus, ...(stateChangeSeq === undefined ? {} : { stateChangeSeq }) };
    this.status = occupant.pane.agentStatus;
    this.lastRevision = occupant.pane.revision;
    this.lastStateChangeSeq = stateChangeSeq;
    this.lastEndpoint = { revision: occupant.pane.revision, status: occupant.pane.agentStatus, stateChangeSeq: occupant.stateChangeSeq };
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

  /** Bind AGY before its native session exists, publishing only reduced evidence. */
  async bindProvisional(binding: ProvisionalSupervisionBinding, publication: SupervisionChildBindingPublication = inertBindingPublication): Promise<void> {
    if (this.bindStarted || this.stopped || this.state !== "reserved") {
      throw new SupervisionBindError("Supervision binding is single-use", this.bindEvidence(binding, { cause: "bind_already_attempted" }));
    }
    if (binding.identity.agentKind !== "agy") {
      throw new SupervisionBindError("Provisional supervision is AGY-only", this.bindEvidence(binding, { cause: "provisional_kind_invalid" }));
    }
    if (!validProvisionalBinding(binding)) {
      throw new SupervisionBindError("AGY provisional binding evidence is malformed", this.bindEvidence(binding, { cause: "provisional_baseline_invalid" }));
    }
    this.bindStarted = true;
    this.paneId = binding.identity.paneId;
    this.deps.monitor.addObserver(this);
    let snapshot: HerdrSnapshot;
    try {
      snapshot = await this.deps.monitor.snapshot();
    } catch (error) {
      this.resetPreparedBinding();
      throw new SupervisionBindError("AGY provisional binding could not read authoritative state", this.bindEvidence(binding, { cause: reasonOf(error) }));
    }
    const target = classifyProvisionalSnapshotTarget(snapshot, binding.identity.paneId);
    if (target.kind !== "unique" || !target.occupant.agentPresent) {
      this.resetPreparedBinding();
      const cause = target.kind === "invalid" ? target.reason : target.kind === "absent" ? "occupant_absent" : "agent_absent";
      throw new SupervisionBindError("AGY provisional binding found no valid unique authoritative occupant", this.bindEvidence(binding, { cause }));
    }
    const occupant = target.occupant;
    if (provisionalOccupantContinuity(binding.identity, occupant) !== "continuous") {
      this.resetPreparedBinding();
      throw new SupervisionBindError("AGY provisional binding could not prove the launched identity", this.bindEvidence(binding, { cause: "identity_mismatch", observedStatus: occupant.pane.agentStatus }));
    }
    if (occupant.pane.agentStatus !== "idle" || occupant.stateChangeSeq !== binding.baseline.stateChangeSeq || occupant.pane.revision !== binding.baseline.revision) {
      this.resetPreparedBinding();
      throw new SupervisionBindError("AGY provisional binding baseline changed before publication", this.bindEvidence(binding, {
        cause: "baseline_changed",
        observedStatus: occupant.pane.agentStatus,
        observedRevision: occupant.pane.revision,
        ...(occupant.stateChangeSeq === undefined ? {} : { observedStateChangeSeq: occupant.stateChangeSeq }),
      }));
    }

    this.provisional = {
      identity: { ...binding.identity },
      operatingPointId: binding.operatingPointId,
      baseline: { ...binding.baseline },
    };
    if (occupant.pane.agentSession !== undefined) {
      this.provisionalNativeIdentity = { ...binding.identity, agentSession: { ...occupant.pane.agentSession } };
    }
    this.selectedOperatingPointId = binding.operatingPointId;
    this.status = "idle";
    this.provisionalLifecycle = {
      stateChangeSeq: binding.baseline.stateChangeSeq,
      revision: binding.baseline.revision,
      status: "idle",
      events: [],
    };
    this.anchor = { revision: binding.baseline.revision, status: "idle", stateChangeSeq: binding.baseline.stateChangeSeq };
    this.lastRevision = binding.baseline.revision;
    this.lastStateChangeSeq = binding.baseline.stateChangeSeq;
    this.bindPending = true;
    await this.serialize(async () => {
      try {
        await this.commitProvisional(binding, publication);
      } finally {
        this.bindPending = false;
      }
    });
  }

  /** Strengthen one AGY provisional binding from a fresh exact native-session read. */
  async strengthen(binding: SupervisionBinding, publication: SupervisionChildBindingPublication = inertBindingPublication): Promise<void> {
    if (!this.provisionalPublished || this.stopped || this.state !== "provisional" || this.bindingPublished || this.strengtheningStarted) {
      throw new SupervisionBindError("AGY supervision strengthening is single-use", this.bindEvidence(binding, { cause: "strengthen_already_attempted" }));
    }
    if (binding.identity.agentKind !== "agy" || binding.identity.paneId !== this.provisional!.identity.paneId) {
      throw new SupervisionBindError("AGY supervision strengthening identity is invalid", this.bindEvidence(binding, { cause: "strengthening_identity_invalid" }));
    }
    this.strengtheningStarted = true;
    this.bindPending = true;
    await this.serialize(async () => {
      try {
        await this.commitStrengthening(binding, publication);
      } finally {
        this.bindPending = false;
      }
    });
  }

  private async commitProvisional(binding: ProvisionalSupervisionBinding, publication: SupervisionChildBindingPublication): Promise<void> {
    try {
      await this.drainAdmitted();
      if (this.provisionalFailure !== undefined) throw new Error(this.provisionalFailure);
    } catch (error) {
      const cause = this.provisionalFailure ?? reasonOf(error);
      publication.rollback();
      this.resetPreparedBinding();
      throw new SupervisionBindError("AGY provisional supervision could not drain queued evidence", this.bindEvidence(binding, { cause }));
    }
    if (this.isSettled()) {
      publication.rollback();
      throw new SupervisionBindError("Supervision settled while AGY provisional evidence was drained", this.bindEvidence(binding, {
        cause: "settled_during_bind",
        settledDuringBind: true,
        ...(this.settlement === undefined ? {} : { supervisionOutcome: this.settlement.outcome, supervisionReason: this.settlement.reason }),
      }));
    }
    try {
      publication.commit();
      this.provisionalPublished = true;
      this.state = "provisional";
      publication.publish();
    } catch (error) {
      publication.rollback();
      this.resetPreparedBinding();
      throw new SupervisionBindError("AGY provisional supervision could not publish its reduced evidence", this.bindEvidence(binding, { cause: reasonOf(error) }));
    }
    this.publish(`supervising ${this.deps.child.agentName} provisionally`);
  }

  private async commitStrengthening(binding: SupervisionBinding, publication: SupervisionChildBindingPublication): Promise<void> {
    if (this.provisionalFailure !== undefined) {
      throw this.strengtheningError(binding, this.provisionalFailure, publication);
    }
    const provisional = this.provisional!;
    let snapshot: HerdrSnapshot;
    try {
      snapshot = await this.deps.monitor.snapshot();
    } catch (error) {
      throw this.strengtheningError(binding, reasonOf(error), publication);
    }
    const target = classifyProvisionalSnapshotTarget(snapshot, provisional.identity.paneId);
    if (target.kind !== "unique" || !target.occupant.agentPresent) {
      const cause = target.kind === "invalid" ? target.reason : target.kind === "absent" ? "occupant_absent" : "agent_absent";
      throw this.strengtheningError(binding, cause, publication);
    }
    const occupant = target.occupant;
    if (provisionalOccupantContinuity(provisional.identity, occupant) !== "continuous") {
      throw this.strengtheningError(binding, "identity_mismatch", publication);
    }
    if (occupant.stateChangeSeq === undefined || occupant.stateChangeSeq <= provisional.baseline.stateChangeSeq) {
      throw this.strengtheningError(binding, "lifecycle_not_advanced", publication);
    }
    const retained = this.provisionalLifecycle!;
    if (occupant.pane.revision < retained.revision) {
      throw this.strengtheningError(binding, "revision_regressed", publication);
    }
    if (occupant.stateChangeSeq < retained.stateChangeSeq) {
      throw this.strengtheningError(binding, "lifecycle_regressed", publication);
    }
    if (occupant.pane.revision === retained.revision && occupant.stateChangeSeq === retained.stateChangeSeq && occupant.pane.agentStatus !== retained.status) {
      throw this.strengtheningError(binding, "lifecycle_contradiction", publication);
    }
    const observedIdentity: SupervisedIdentity = { ...provisional.identity, agentSession: { ...occupant.pane.agentSession! } };
    if (observedIdentity.agentSession.agent !== observedIdentity.agentKind
      || (this.provisionalNativeIdentity !== undefined && !sameSupervisedIdentity(this.provisionalNativeIdentity, observedIdentity))
      || !sameSupervisedIdentity(binding.identity, observedIdentity)) {
      throw this.strengtheningError(binding, "native_identity_mismatch", publication);
    }
    this.provisionalNativeIdentity ??= observedIdentity;

    this.strengtheningCandidate = {
      binding: {
        identity: observedIdentity,
        operatingPointId: binding.operatingPointId,
        stateChangeSeq: occupant.stateChangeSeq,
      },
      stateChangeSeq: occupant.stateChangeSeq,
      revision: occupant.pane.revision,
      status: occupant.pane.agentStatus,
      initialRevision: retained.events.length === 0 ? occupant.pane.revision : provisional.baseline.revision,
      events: [
        ...retained.events,
        ...(retained.events.length === 0 || occupant.pane.agentStatus === retained.status ? [] : [{
          atMs: this.deps.clock.now(),
          from: retained.status,
          to: occupant.pane.agentStatus,
          revision: occupant.pane.revision,
          source: "snapshot" as const,
        }]),
      ],
    };
    try {
      do {
        await this.drainAdmitted();
      } while (this.queued.length !== 0);
      if (this.provisionalFailure !== undefined) throw new Error(this.provisionalFailure);
    } catch (error) {
      const cause = this.provisionalFailure ?? reasonOf(error);
      this.strengtheningCandidate = undefined;
      throw this.strengtheningError(binding, cause, publication);
    }
    const candidate = this.strengtheningCandidate;
    if (candidate === undefined) throw this.strengtheningError(binding, "strengthening_candidate_missing", publication);
    if (this.isSettled()) throw this.strengtheningError(binding, "settled_during_strengthen", publication);

    const previous = {
      provisional: this.provisional,
      status: this.status,
      anchor: this.anchor,
      lastRevision: this.lastRevision,
      selectedOperatingPointId: this.selectedOperatingPointId,
      bindingPublished: this.bindingPublished,
      provisionalPublished: this.provisionalPublished,
      state: this.state,
      identity: this.identity,
      lastStateChangeSeq: this.lastStateChangeSeq,
      lastEndpoint: this.lastEndpoint,
    };
    try {
      if (this.queued.length !== 0) throw new Error("evidence_admitted_before_exact_commit");
      publication.commit();
      this.identity = { ...candidate.binding.identity, agentSession: { ...candidate.binding.identity.agentSession } };
      this.selectedOperatingPointId = candidate.binding.operatingPointId;
      this.anchor = { revision: candidate.revision, status: candidate.status, stateChangeSeq: candidate.stateChangeSeq };
      this.status = candidate.status;
      this.lastRevision = candidate.revision;
      this.lastStateChangeSeq = candidate.stateChangeSeq;
      this.lastEndpoint = { revision: candidate.revision, status: candidate.status, stateChangeSeq: candidate.stateChangeSeq };
      this.provisional = undefined;
      this.provisionalPublished = false;
      this.bindingPublished = true;
      this.state = "active";
      this.eventStreamDegraded = this.deps.monitor.isDegraded();
      this.refreshActiveState();
      publication.publish();
    } catch {
      try { publication.rollback(); } catch { /* rollback is best effort after a failed private commit */ }
      this.provisional = previous.provisional;
      this.status = previous.status;
      this.anchor = previous.anchor;
      this.lastRevision = previous.lastRevision;
      this.lastStateChangeSeq = previous.lastStateChangeSeq;
      this.lastEndpoint = previous.lastEndpoint;
      this.selectedOperatingPointId = previous.selectedOperatingPointId;
      this.bindingPublished = previous.bindingPublished;
      this.provisionalPublished = previous.provisionalPublished;
      this.state = previous.state;
      this.identity = previous.identity;
      this.strengtheningCandidate = undefined;
      throw this.strengtheningError(binding, "publication_failed", publication);
    }
    this.strengtheningCandidate = undefined;
    try {
      this.enterStatus(this.status!);
      let previousRevision = candidate.initialRevision;
      for (const event of candidate.events) {
        this.transitions.push(event);
        // AGY provisional folding has already required a strictly advancing
        // lifecycle sequence for every same-revision status transition.
        if (event.revision > previousRevision + 1) this.recordEvidenceGap("event", "revision_jump", previousRevision, event.revision, event.revision - previousRevision - 1);
        previousRevision = event.revision;
        const material = materialTransitionEvent(event.from, event.to);
        if (material !== undefined) this.emit(material, `child ${event.from} → ${event.to}`, { from: event.from, to: event.to, revision: event.revision });
      }
    } catch {
      this.reviewerDegraded = true;
      this.publish("supervision reviewer cadence could not be armed");
    }
    this.publish(`supervising ${this.deps.child.agentName}`);
  }

  private strengtheningError(binding: SupervisionBinding, cause: string, publication: SupervisionChildBindingPublication): SupervisionBindError {
    try { publication.rollback(); } catch { /* the provisional recovery handle remains authoritative */ }
    this.markProvisionalFailure(cause);
    return new SupervisionBindError("AGY supervision strengthening could not prove the exact child", this.bindEvidence(binding, { cause }));
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

  /** Called after the launched prompt was acknowledged; also checks an already-terminal child. */
  onCompletionSignal(signal: (identity: SupervisedIdentity) => Promise<boolean>): void {
    if (this.completionSignal !== undefined || !this.bindingPublished || this.isSettled()) return;
    this.completionSignal = signal;
    this.scheduleCompletionSignal();
  }

  private async recordCompletionSignal(): Promise<void> {
    if (this.completionRecorded || this.completionSignal === undefined || this.identity === undefined) return;
    try {
      this.completionRecorded = await this.completionSignal(this.identity);
    } catch {
      // The production reader turns missing/untrusted evidence into false. A
      // thrown callback means the typed signal could not be persisted: surface
      // one fixed-code gap, never a transcript, message, path, or credential.
      if (!this.completionLogDegraded) {
        this.completionLogDegraded = true;
        this.emit("evidence_gap", "Claude quota cooldown could not be recorded", { reason: "availability_record_unavailable" });
      }
    }
  }

  private scheduleCompletionSignal(): void {
    if (this.stopped || this.completionRecorded || this.completionSignal === undefined || !this.bindingPublished || this.isSettled()
      || (this.status !== "idle" && this.status !== "done")) return;
    void this.serialize(async () => {
      if (this.stopped || !this.bindingPublished || this.isSettled()
        || (this.status !== "idle" && this.status !== "done")) return;
      await this.recordCompletionSignal();
      // The native writer can flush just after completion. Check twice more
      // promptly; later same-status reconciliation can catch a slower response.
      if (!this.completionRecorded && ++this.completionAttempts < 3 && this.completionRetry === undefined) {
        this.completionRetry = setTimeout(() => {
          this.completionRetry = undefined;
          this.scheduleCompletionSignal();
        }, 250);
        this.completionRetry.unref();
      }
    }).catch(() => undefined);
  }

  /** Resolve when the supervisor settles. This is the supervisor job's run body. */
  async run(): Promise<Settlement> {
    return this.settled;
  }

  private bindEvidence(binding: SupervisionBinding | ProvisionalSupervisionBinding, extra: Record<string, unknown>): Record<string, unknown> {
    const evidence = {
      jobId: this.deps.jobId,
      child: { ...this.deps.child, paneId: binding.identity.paneId, terminalId: binding.identity.terminalId },
      ...extra,
    };
    return "baseline" in binding
      ? { ...evidence, baseline: { ...binding.baseline } }
      : { ...evidence, agentSession: { ...binding.identity.agentSession } };
  }

  private resetPreparedBinding(): void {
    this.clearReviewTimer();
    this.deps.monitor.removeObserver(this);
    this.queued.length = 0;
    this.paneId = undefined;
    this.identity = undefined;
    this.provisional = undefined;
    this.provisionalFailure = undefined;
    this.provisionalNativeIdentity = undefined;
    this.provisionalLifecycle = undefined;
    this.strengtheningCandidate = undefined;
    this.anchor = undefined;
    this.status = undefined;
    this.lastRevision = 0;
    this.lastStateChangeSeq = undefined;
    this.lastEndpoint = undefined;
    this.pendingMoveDestination = undefined;
    this.pendingMoveEndpoints.length = 0;
    this.pendingMoveInitialStateChangeSeq = undefined;
    this.selectedOperatingPointId = undefined;
    this.eventStreamDegraded = false;
    this.bindingPublished = false;
    this.provisionalPublished = false;
    if (!this.isSettled()) this.state = "reserved";
  }

  // ----------------------------------------------------------------- observer

  /** Read through a method so a caller's narrowing cannot outlive an async settle. */
  private isSettled(): boolean {
    return this.state === "settled";
  }

  /**
   * A retained move destination is routed as well as the origin pane. The child
   * is already there, so its lifecycle events — including a further move out of
   * it — are this supervisor's evidence; without them a chained move would reach
   * nobody and the origin pane's emptiness would later read as a closure.
   */
  matches(paneId: string): boolean {
    return !this.stopped && (this.paneId === paneId || this.pendingMoveDestination?.paneId === paneId);
  }

  /** The pane this supervisor currently believes holds the child. */
  private currentPaneId(): string {
    return this.pendingMoveDestination?.paneId ?? this.identity!.paneId;
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
      if (this.stopped || this.isSettled()) return;
      if (this.provisional !== undefined && !this.bindingPublished) {
        this.applyProvisionalSnapshot(snapshot, "reconnect");
        return;
      }
      if (this.identity === undefined || this.anchor === undefined) return;
      await this.applyAuthoritativeSnapshot(snapshot, "reconnect", "identity_lost");
    });
  }

  async onReconciliationSnapshot(snapshot: HerdrSnapshot): Promise<void> {
    if (this.stopped) return;
    await this.serialize(async () => {
      if (this.stopped || this.isSettled()) return;
      if (this.provisional !== undefined && !this.bindingPublished) {
        this.applyProvisionalSnapshot(snapshot, "periodic_snapshot");
        return;
      }
      if (this.identity === undefined || this.anchor === undefined) return;
      await this.applyAuthoritativeSnapshot(snapshot, "periodic_snapshot", "released");
    });
  }

  onReconciliationFailure(reason: ReconciliationFailureReason): void {
    if (this.stopped || this.isSettled()) return;
    if (this.provisional !== undefined && !this.bindingPublished) {
      this.markProvisionalFailure(`reconciliation_${reason}`);
      return;
    }
    if (this.identity === undefined) return;
    this.markReconciliationFailure(reason);
  }

  onMonitorDegraded(reason: string): void {
    // A reservation is not yet supervising anything, so it has no health to report.
    if (this.stopped || (this.identity === undefined && this.provisional === undefined) || this.isSettled() || this.eventStreamDegraded) return;
    this.eventStreamDegraded = true;
    this.refreshActiveState();
    this.emit("monitor_degraded", `supervision lost its Herdr event connection (${reason}) and is retrying`, { reason });
  }

  onMonitorRecovered(): void {
    if (this.stopped || (this.identity === undefined && this.provisional === undefined) || this.isSettled() || !this.eventStreamDegraded) return;
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
    while (!this.stopped && (this.identity !== undefined || this.provisional !== undefined)) {
      const event = this.queued.shift();
      if (event === undefined) return;
      await this.fold(event);
    }
  }

  private foldProvisional(event: SupervisionSocketEvent): void {
    const provisional = this.provisional;
    if (provisional === undefined || this.provisionalFailure !== undefined) return;
    if (event.event === "pane_moved") {
      this.markProvisionalFailure("move_before_strengthening");
      return;
    }
    if (!isPaneRecordEvent(event.event) || event.pane === undefined) {
      this.markProvisionalFailure("event_lifecycle_unvalidated");
      return;
    }
    const pane = event.pane;
    const candidate = this.strengtheningCandidate;
    if (candidate === undefined) {
      if (pane.paneId !== provisional.identity.paneId
        || pane.terminalId !== provisional.identity.terminalId
        || (pane.agentKind !== undefined && pane.agentKind !== provisional.identity.agentKind)) {
        this.markProvisionalFailure("identity_mismatch");
        return;
      }
      if (pane.agentSession !== undefined) {
        const observedIdentity: SupervisedIdentity = { ...provisional.identity, agentSession: { ...pane.agentSession } };
        if (observedIdentity.agentSession.agent !== observedIdentity.agentKind
          || (this.provisionalNativeIdentity !== undefined && !sameSupervisedIdentity(this.provisionalNativeIdentity, observedIdentity))) {
          this.markProvisionalFailure("native_identity_mismatch");
          return;
        }
        this.provisionalNativeIdentity ??= observedIdentity;
      } else if (this.provisionalNativeIdentity !== undefined) {
        this.markProvisionalFailure("native_identity_mismatch");
        return;
      }
    } else {
      if (pane.paneId !== candidate.binding.identity.paneId || paneContinuity(candidate.binding.identity, pane) !== "continuous") {
        this.markProvisionalFailure("native_identity_mismatch");
        return;
      }
    }
    let lifecycle: ReturnType<typeof provisionalEventLifecycle>;
    try {
      lifecycle = provisionalEventLifecycle(event);
    } catch {
      this.markProvisionalFailure("lifecycle_malformed");
      return;
    }
    const baseline = provisional.baseline;
    if (candidate === undefined) {
      const retained = this.provisionalLifecycle!;
      if (lifecycle.revision < retained.revision) {
        this.markProvisionalFailure("revision_regressed");
        return;
      }
      if (lifecycle.stateChangeSeq === undefined) {
        if (lifecycle.revision !== baseline.revision) this.markProvisionalFailure("lifecycle_not_advanced");
        return;
      }
      if (lifecycle.stateChangeSeq < retained.stateChangeSeq) {
        this.markProvisionalFailure("lifecycle_regressed");
        return;
      }
      if (lifecycle.revision === retained.revision && lifecycle.stateChangeSeq === retained.stateChangeSeq) {
        if (lifecycle.status !== retained.status) this.markProvisionalFailure("lifecycle_contradiction");
        return;
      }
      if (lifecycle.status !== retained.status) retained.events.push({
        atMs: this.deps.clock.now(),
        from: retained.status,
        to: lifecycle.status,
        revision: lifecycle.revision,
        source: "event",
      });
      retained.revision = lifecycle.revision;
      retained.stateChangeSeq = lifecycle.stateChangeSeq;
      retained.status = lifecycle.status;
      return;
    }
    if (lifecycle.stateChangeSeq === undefined || lifecycle.stateChangeSeq < baseline.stateChangeSeq) {
      this.markProvisionalFailure("lifecycle_not_advanced");
      return;
    }
    if (lifecycle.revision < baseline.revision || lifecycle.revision < candidate.revision) {
      this.markProvisionalFailure("revision_regressed");
      return;
    }
    if (lifecycle.stateChangeSeq < candidate.stateChangeSeq) {
      this.markProvisionalFailure("lifecycle_regressed");
      return;
    }
    if (lifecycle.revision === candidate.revision && lifecycle.stateChangeSeq === candidate.stateChangeSeq && lifecycle.status !== candidate.status) {
      this.markProvisionalFailure("lifecycle_contradiction");
      return;
    }
    if (lifecycle.status !== candidate.status) candidate.events.push({
      atMs: this.deps.clock.now(),
      from: candidate.status,
      to: lifecycle.status,
      revision: lifecycle.revision,
      source: "event",
    });
    candidate.revision = lifecycle.revision;
    candidate.stateChangeSeq = lifecycle.stateChangeSeq;
    candidate.status = lifecycle.status;
  }

  private async fold(event: SupervisionSocketEvent): Promise<void> {
    if (this.state === "settled") return;
    if (this.provisional !== undefined && !this.bindingPublished) {
      this.foldProvisional(event);
      return;
    }
    if (!isPaneRecordEvent(event.event)) {
      // A thin event carries only a pane id, and Herdr reuses pane ids, so it is
      // a reconciliation trigger and never a conclusion. `pane_exited` is no
      // different: its carried exit fact names no occupant, so neither the
      // pane id nor the answering snapshot can bind it to this child — an
      // exit is never a process_exit proof.
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
    // previous pane id never reaches a supervisor. The origin is the pane the
    // child is currently believed to occupy, so a chained move out of a retained
    // destination is followed as this child's move rather than judged foreign —
    // judging it foreign would reconcile a destination the child has already
    // left and settle a false closure on it.
    if (event.previousPaneId! !== this.currentPaneId()) {
      await this.reconcile("event:move_foreign_previous_pane");
      return;
    }
    if (paneContinuity(this.identity!, pane) !== "continuous") {
      await this.reconcile("event:move_identity_unproven");
      return;
    }
    // The move proves the child has left the origin before destination
    // reconciliation starts. Invalidate every origin-pane review immediately;
    // otherwise a transcript already being read could dispatch while this
    // snapshot is pending, and a cadence could start another one. Keep every
    // chained move endpoint so it can be folded before the eventual snapshot.
    if (this.pendingMoveDestination === undefined) {
      this.pendingMoveEndpoints.length = 0;
      this.pendingMoveInitialStateChangeSeq = this.lastStateChangeSeq;
    }
    this.pendingMoveDestination = pane;
    this.paneIdentityGeneration += 1;
    this.observeStateChangeSeq(pane.stateChangeSeq);
    const endpoint = { revision: pane.revision, status: pane.agentStatus, stateChangeSeq: pane.stateChangeSeq };
    this.pendingMoveEndpoints.push(endpoint);
    this.lastEndpoint = endpoint;
    let snapshot: HerdrSnapshot;
    try {
      snapshot = await this.deps.monitor.snapshot();
    } catch {
      await this.settle("identity_lost", "move_reconciliation_unavailable");
      return;
    }
    const target = this.identity!.agentKind === "agy"
      ? classifyProvisionalSnapshotTarget(snapshot, pane.paneId)
      : classifySnapshotTarget(snapshot, pane.paneId);
    if (target.kind === "invalid") {
      // The move itself is proven; only this one read of its destination is
      // unusable. Retaining the destination is what keeps the origin pane's
      // absence — which this very move caused — from later reading as a closure.
      this.markReconciliationFailure(target.reason);
      return;
    }
    if (target.kind === "absent" || !target.occupant.agentPresent) {
      await this.settle("identity_lost", "move_continuity_unproven");
      return;
    }
    const lifecycle = this.mergeMoveOccupant(pane, target.occupant);
    if ("reason" in lifecycle) {
      this.markReconciliationFailure(lifecycle.reason);
      return;
    }
    const occupant = lifecycle.occupant;
    const next = movedIdentity(this.identity!, pane, occupant);
    if (next === undefined) {
      await this.settle("identity_lost", "move_continuity_unproven");
      return;
    }
    if (this.lifecycleSequenceRegressed(occupant.stateChangeSeq)) {
      this.markReconciliationFailure("revision_regressed");
      return;
    }
    this.markReconciliationSuccess();
    this.adoptMove(next, occupant, pane);
  }

  private mergeMoveOccupant(eventPane: SupervisionPaneRecord, occupant: AuthoritativeOccupant): { occupant: AuthoritativeOccupant } | { reason: "revision_regressed" | "target_identity_contradiction" } {
    if (occupant.pane.revision < eventPane.revision) return { reason: "revision_regressed" };
    // Lifecycle sequence is global across moves. Revisions remain local to the
    // latest destination and are never compared across retained endpoints.
    const retainedStatuses = new Map<number, SupervisionAgentStatus>();
    for (const endpoint of this.pendingMoveEndpoints) {
      const endpointSequence = endpoint.stateChangeSeq;
      if (endpointSequence === undefined) continue;
      const retainedStatus = retainedStatuses.get(endpointSequence);
      if (retainedStatus !== undefined && retainedStatus !== endpoint.status) {
        return { reason: "target_identity_contradiction" };
      }
      retainedStatuses.set(endpointSequence, endpoint.status);
      if (occupant.stateChangeSeq === undefined) continue;
      if (endpointSequence > occupant.stateChangeSeq) return { reason: "revision_regressed" };
      if (endpointSequence === occupant.stateChangeSeq && endpoint.status !== occupant.pane.agentStatus) {
        return { reason: "target_identity_contradiction" };
      }
    }
    const eventSequence = eventPane.stateChangeSeq;
    if (eventSequence === undefined || occupant.stateChangeSeq !== undefined) return { occupant };
    if (occupant.pane.revision !== eventPane.revision || occupant.pane.agentStatus !== eventPane.agentStatus) {
      return { reason: "target_identity_contradiction" };
    }
    const pane = { ...occupant.pane, stateChangeSeq: eventSequence };
    return { occupant: { ...occupant, pane, stateChangeSeq: eventSequence } };
  }

  /**
   * Rebase onto a destination pane whose occupant is proven to be this child.
   * Revisions are per pane, so the move endpoint starts the destination's
   * watermark. Its ordered lifecycle evidence is folded before the later
   * snapshot endpoint, which may then advance both revision and lifecycle.
   */
  private adoptMove(next: SupervisedIdentity, occupant: AuthoritativeOccupant, moveEvent: SupervisionPaneRecord): void {
    const endpoints = this.pendingMoveEndpoints.splice(0);
    const initialStateChangeSeq = this.pendingMoveInitialStateChangeSeq;
    this.pendingMoveDestination = undefined;
    this.pendingMoveInitialStateChangeSeq = undefined;
    this.paneIdentityGeneration += 1;
    this.identity = next;
    this.paneId = next.paneId;
    // The gate's run tracks the pane too: a repair prompt must reach the exact
    // child where it actually lives, not where it was launched.
    const managed = this.managedRun();
    if (managed !== undefined) managed.gate.notePane(managed.run, next.paneId);
    this.lastRevision = moveEvent.revision;
    this.anchor = {
      revision: moveEvent.revision,
      status: this.status!,
      ...(this.lastStateChangeSeq === undefined ? {} : { stateChangeSeq: this.lastStateChangeSeq }),
    };
    this.publish(`child moved to pane ${next.paneId}`);
    this.applyMoveEndpoints(endpoints, initialStateChangeSeq);
    this.applySnapshotRevision(occupant);
    this.anchor = {
      revision: this.lastRevision,
      status: this.status!,
      ...(this.lastStateChangeSeq === undefined ? {} : { stateChangeSeq: this.lastStateChangeSeq }),
    };
  }

  private applyMoveEndpoints(endpoints: SupervisionEndpoint[], initialStateChangeSeq: number | undefined): void {
    let previousStateChangeSeq = initialStateChangeSeq;
    for (const endpoint of endpoints) {
      const priorStateChangeSeq = previousStateChangeSeq;
      const sequence = compareStateChangeSeq(priorStateChangeSeq, endpoint.stateChangeSeq);
      this.lastEndpoint = endpoint;
      if (endpoint.stateChangeSeq !== undefined && sequence !== "regressed") previousStateChangeSeq = endpoint.stateChangeSeq;
      if (sequence === "regressed") {
        this.recordEvidenceGap("event", "status_changed_without_revision", endpoint.revision, endpoint.revision, undefined, priorStateChangeSeq, endpoint.stateChangeSeq);
        continue;
      }
      if (endpoint.status !== this.status
        && (priorStateChangeSeq !== undefined || endpoint.stateChangeSeq !== undefined)
        && sequence !== "advanced") {
        this.recordEvidenceGap("event", "status_changed_without_revision", endpoint.revision, endpoint.revision, undefined, priorStateChangeSeq, endpoint.stateChangeSeq);
      }
      this.applyStatus(endpoint.status, endpoint.revision, "event");
    }
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
    if (this.lastEndpoint !== undefined
      && this.lastEndpoint.revision === pane.revision
      && this.lastEndpoint.status === pane.agentStatus
      && this.lastEndpoint.stateChangeSeq === pane.stateChangeSeq) return;
    this.lastEndpoint = { revision: pane.revision, status: pane.agentStatus, stateChangeSeq: pane.stateChangeSeq };
    const previousRevision = this.lastRevision;
    const previousStateChangeSeq = this.lastStateChangeSeq;
    if (pane.revision > previousRevision + 1) {
      this.recordEvidenceGap("event", "revision_jump", previousRevision, pane.revision, pane.revision - previousRevision - 1);
    }
    const sequence = this.observeStateChangeSeq(pane.stateChangeSeq);
    if (sequence === "regressed") {
      this.recordEvidenceGap("event", "status_changed_without_revision", previousRevision, pane.revision, undefined, previousStateChangeSeq, pane.stateChangeSeq);
      return;
    }
    if (pane.revision === previousRevision) {
      if (pane.agentStatus === this.status) {
        this.scheduleCompletionSignal();
        return;
      }
      if (sequence !== "advanced") {
        this.recordEvidenceGap("event", "status_changed_without_revision", previousRevision, pane.revision, undefined, previousStateChangeSeq, pane.stateChangeSeq);
      }
      this.applyStatus(pane.agentStatus, pane.revision, "event");
      return;
    }
    this.lastRevision = pane.revision;
    this.applyStatus(pane.agentStatus, pane.revision, "event");
  }

  private async applyAuthoritativeSnapshot(snapshot: HerdrSnapshot, trigger: string, missingOutcome: "identity_lost" | "released"): Promise<void> {
    // A retained move destination is where the child actually is, so it is the
    // pane every rule below judges. The origin pane's absence is this move's own
    // shadow and proves nothing; only the destination's absence is a closure.
    const moved = this.pendingMoveDestination;
    const targetPaneId = moved?.paneId ?? this.identity!.paneId;
    const target = this.identity!.agentKind === "agy"
      ? classifyProvisionalSnapshotTarget(snapshot, targetPaneId)
      : classifySnapshotTarget(snapshot, targetPaneId);
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
      const lifecycle = this.mergeMoveOccupant(moved, occupant);
      if ("reason" in lifecycle) {
        this.markReconciliationFailure(lifecycle.reason);
        return;
      }
      if (this.lifecycleSequenceRegressed(lifecycle.occupant.stateChangeSeq)) {
        this.markReconciliationFailure("revision_regressed");
        return;
      }
      this.markReconciliationSuccess();
      this.adoptMove({ ...this.identity!, paneId: moved.paneId }, lifecycle.occupant, moved);
      return;
    }
    if (occupant.pane.revision < this.lastRevision) {
      this.markReconciliationFailure("revision_regressed");
      return;
    }
    if (this.lifecycleSequenceRegressed(occupant.stateChangeSeq)) {
      this.markReconciliationFailure("revision_regressed");
      return;
    }
    this.markReconciliationSuccess();
    this.applySnapshotRevision(occupant);
  }

  private applySnapshotRevision(occupant: AuthoritativeOccupant): void {
    const previousRevision = this.lastRevision;
    const previousStateChangeSeq = this.lastStateChangeSeq;
    const sequence = this.observeStateChangeSeq(occupant.stateChangeSeq);
    this.lastEndpoint = { revision: occupant.pane.revision, status: occupant.pane.agentStatus, stateChangeSeq: occupant.stateChangeSeq };
    if (occupant.pane.revision === previousRevision) {
      if (occupant.pane.agentStatus === this.status) {
        this.scheduleCompletionSignal();
        return;
      }
      if (sequence !== "advanced") {
        this.recordEvidenceGap("snapshot", "status_changed_without_revision", previousRevision, occupant.pane.revision, undefined, previousStateChangeSeq, occupant.stateChangeSeq);
      }
      this.applyStatus(occupant.pane.agentStatus, occupant.pane.revision, "snapshot");
      return;
    }
    this.recordEvidenceGap("snapshot", "revision_jump", previousRevision, occupant.pane.revision);
    this.lastRevision = occupant.pane.revision;
    this.applyStatus(occupant.pane.agentStatus, occupant.pane.revision, "snapshot");
  }

  private lifecycleSequenceRegressed(observed: number | undefined): boolean {
    return observed !== undefined && this.lastStateChangeSeq !== undefined && observed < this.lastStateChangeSeq;
  }

  private observeStateChangeSeq(observed: number | undefined): StateChangeSeqObservation {
    const observation = compareStateChangeSeq(this.lastStateChangeSeq, observed);
    if (observed !== undefined && observation !== "regressed") this.lastStateChangeSeq = observed;
    return observation;
  }

  private recordEvidenceGap(source: SupervisionTransition["source"], reason: "revision_jump" | "status_changed_without_revision", previousRevision: number, observedRevision: number, omittedRevisions?: number, previousStateChangeSeq?: number, observedStateChangeSeq?: number): void {
    this.evidenceGaps = Math.min(Number.MAX_SAFE_INTEGER, this.evidenceGaps + 1);
    this.emit("evidence_gap", `supervision observed incomplete ${source} revision evidence (${previousRevision} to ${observedRevision})`, {
      source,
      reason,
      previousRevision,
      observedRevision,
      ...(omittedRevisions === undefined ? {} : { omittedRevisions }),
      ...(previousStateChangeSeq === undefined ? {} : { previousStateChangeSeq }),
      ...(observedStateChangeSeq === undefined ? {} : { observedStateChangeSeq }),
    });
  }

  private applyProvisionalSnapshot(snapshot: HerdrSnapshot, trigger: string): void {
    const provisional = this.provisional;
    if (provisional === undefined || this.provisionalFailure !== undefined) return;
    const target = classifyProvisionalSnapshotTarget(snapshot, provisional.identity.paneId);
    if (target.kind !== "unique" || !target.occupant.agentPresent) {
      const cause = target.kind === "invalid" ? target.reason : target.kind === "absent" ? "occupant_absent" : "agent_absent";
      this.markProvisionalFailure(`${trigger}:${cause}`);
      return;
    }
    const occupant = target.occupant;
    if (provisionalOccupantContinuity(provisional.identity, occupant) !== "continuous") {
      this.markProvisionalFailure(`${trigger}:identity_mismatch`);
      return;
    }
    if (occupant.pane.agentSession !== undefined) {
      const observedIdentity: SupervisedIdentity = { ...provisional.identity, agentSession: { ...occupant.pane.agentSession } };
      if (observedIdentity.agentSession.agent !== observedIdentity.agentKind
        || (this.provisionalNativeIdentity !== undefined && !sameSupervisedIdentity(this.provisionalNativeIdentity, observedIdentity))) {
        this.markProvisionalFailure(`${trigger}:native_identity_mismatch`);
        return;
      }
      this.provisionalNativeIdentity ??= observedIdentity;
    } else if (this.provisionalNativeIdentity !== undefined) {
      this.markProvisionalFailure(`${trigger}:native_identity_mismatch`);
      return;
    }
    if (occupant.stateChangeSeq === undefined) {
      this.markProvisionalFailure(`${trigger}:lifecycle_unavailable`);
      return;
    }
    if (occupant.pane.revision < provisional.baseline.revision) {
      this.markProvisionalFailure(`${trigger}:revision_regressed`);
    }
  }

  private markProvisionalFailure(cause: string): void {
    if (this.provisionalFailure !== undefined) return;
    this.provisionalFailure = cause;
    this.emit("evidence_gap", `AGY provisional supervision evidence was rejected (${cause})`, { cause });
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
    if (from === next) {
      this.scheduleCompletionSignal();
      return;
    }
    this.status = next;
    // Claude may normalize a completed turn from done to idle. It carries no
    // new work or manager decision, so do not surface or re-evaluate it.
    if (from === "done" && next === "idle") {
      this.enterStatus(next);
      this.scheduleCompletionSignal();
      return;
    }
    this.transitions.push({ atMs: this.deps.clock.now(), from, to: next, revision, source });
    if (next === "working") {
      this.completionAttempts = 0;
      if (this.completionRetry !== undefined) clearTimeout(this.completionRetry);
      this.completionRetry = undefined;
      // An authoritative working transition opens a fresh artifact cycle: the
      // previously accepted handoff version is stale from this point on.
      const managed = this.managedRun();
      if (managed !== undefined) managed.gate.beginCycle(managed.run);
    }
    this.enterStatus(next);
    if (next === "idle" || next === "done" || next === "blocked") {
      // A managed terminal observation is not acceptance by itself. The
      // current-cycle artifact check runs on the mutation chain behind the
      // fold that produced it, so it sees every earlier transition first.
      this.scheduleHandoffEvaluation();
      this.scheduleCompletionSignal();
    }
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
   * Review a child that has been working for a whole cadence. A reviewer
   * infrastructure failure is silent — it normalizes to the unavailable
   * result and retries at the next cadence (ADR-036 V2-08); an evidence-read
   * or telemetry-sink failure instead enters one visible degraded episode,
   * and the first success afterwards notifies recovery once. The supervisor
   * stays active either way.
   */
  private async review(): Promise<void> {
    if (this.reviewing || this.pendingMoveDestination !== undefined) {
      // Either an obsolete review from an earlier run is still settling, or a
      // proven move has left the child's exact pane unresolved. Neither may read
      // a transcript or reach the model: the origin pane no longer holds this
      // child and Herdr reuses pane ids, so its output can already belong to
      // somebody else. Re-arm so the current run is not starved by a call it
      // could not make, and resume once exact identity is re-established.
      if (this.reviewRunLive()) this.armReview(this.deps.cadenceMs);
      return;
    }
    if (!this.reviewable()) return;
    this.reviewing = true;
    const run = this.workingRun;
    // The exact pane this review is about, pinned before any evidence read.
    // Everything downstream reads the pinned identity, so the trace, the
    // terminal window, and the workspace can never be relabelled with a pane
    // the child moved to while they were being read.
    const paneIdentity = this.paneIdentityGeneration;
    const reviewed = this.identity!;
    const workingSinceMs = this.workingSinceMs!;
    try {
      // Evidence order (ADR-036): the runner's own structured trace is the
      // primary "what happened"; the bounded terminal read is supplemental
      // only. A `tmux-fallback` window already IS that read — its events are
      // the delta and its cursor the reviewed window — so it issues no second
      // pane read.
      const trace = await this.traceSource.read(reviewed, this.traceCursor, this.abort.signal);
      const transcript = trace.source === "tmux-fallback"
        ? (trace.cursorTo?.source === "tmux-fallback" ? trace.cursorTo.window : this.reviewedTranscript)
        : await this.deps.readTranscript(reviewed.paneId, this.abort.signal);
      const transcriptDelta = trace.source === "tmux-fallback"
        ? trace.events.map((event) => event.record as string)
        : deltaLines(this.reviewedTranscript, transcript);
      // This trace begins at the prior completed cadence's cursor. Only its
      // non-error edit targets may select files for the recent-hunk slot.
      const writtenFiles = buildExecutionDigest(trace).actions.flatMap((action) => (
        action.class === "edit" && action.error !== true && action.target !== undefined ? [action.target] : []
      ));
      const workspace = await this.cadenceWorkspace(writtenFiles, this.abort.signal);
      // The child may have finished its work cycle — or left this very pane —
      // while the reads were in flight. A review of a run that is over, or of a
      // pane the child no longer occupies, is not evidence about anything, so it
      // is abandoned before the model call rather than stored or announced. The
      // cursors do not advance: that evidence was never reviewed.
      if (!this.reviewable(run, paneIdentity)) return;
      // Deterministic assembly: compaction, byte budgets, then the local
      // sensitive scan — only a `safe` state may reach the reviewer.
      const build = buildEvidenceState({
        ...(this.deps.assignmentDigest === undefined ? {} : { assignment: this.deps.assignmentDigest }),
        trace,
        workspace,
        terminal: transcriptDelta,
        identity: SUPERVISION_REVIEWER_IDENTITY,
        ...(this.evidenceBaseline === undefined ? {} : { baselineIdentity: this.evidenceBaseline }),
      }, this.deps.evidenceScanner === undefined ? {} : { scan: this.deps.evidenceScanner });
      // The reservation's version identity pins once on the first build — a
      // refused build's identity still counts, since drift compares truth.
      this.evidenceBaseline ??= build.available ? build.state.identity : build.identity;
      // Tier-0 code attention runs before any model call: each violation is a
      // deterministic fact reported as a high-priority attention event — typed
      // violation evidence, never a probabilistic claim. A cadence that
      // reports one consumed this window, so the cursors advance with it and
      // no Jev request leaves.
      const violations = this.emitTier0Violations(trace, workspace, build);
      if (violations.length > 0) {
        this.reviewedTranscript = transcript;
        this.traceCursor = trace.cursorTo;
        // The same append-last contract as persistReview: the wakes and the
        // cursor advance already happened, so a sink failure costs only the
        // dataset rows and degrades like a reviewer failure.
        await this.persistTier0Violations(violations, reviewed, trace, workspace, build);
        return;
      }
      // A source that failed closed, or a state the budget/scan gate refused,
      // is `reviewer_unavailable`: silent, unrecorded, and retried at the next
      // cadence — never an empty-trace review.
      if (!build.available) {
        const result = supervisionReviewerUnavailable({ identity: build.identity });
        this.publish(`review unavailable (evidence ${build.failure.cause}): ${result.summary}`);
        return;
      }
      if (trace.typedFailure !== undefined) {
        const result = supervisionReviewerUnavailable({ evidence: build.state });
        this.publish(`review unavailable (trace ${trace.typedFailure.kind}): ${result.summary}`);
        return;
      }
      const workingForMs = Math.max(0, this.deps.clock.now() - workingSinceMs);
      const result = await this.deps.reviewer.review({
        paneId: reviewed.paneId,
        agentName: reviewed.agentName,
        workingForMs,
        // The dispatch context is closed scalars only — the digest and the
        // delta ride the assembled evidence, never raw caller fields (V2-02).
        metadata: { agentKind: reviewed.agentKind, status: this.status!, revision: this.lastRevision },
        ...(this.previousReview === undefined ? {} : { previousReview: this.previousReview }),
        linesSinceLastReview: transcriptDelta.length,
        evidence: build.state,
        cadenceMs: this.deps.cadenceMs,
      }, this.abort.signal);
      if (!this.reviewable(run, paneIdentity)) return;
      this.reviewedTranscript = transcript;
      this.traceCursor = trace.cursorTo;
      this.lastReviewAtMs = this.deps.clock.now();
      this.reviews.push({
        atMs: this.lastReviewAtMs,
        classification: result.classification,
        summary: result.summary,
        ...(result.signals === undefined ? {} : { signals: result.signals }),
        ...(result.evidenceSufficiency === undefined ? {} : { evidenceSufficiency: result.evidenceSufficiency }),
        ...(result.reason === undefined ? {} : { reason: result.reason }),
      });
      // Meaningful progress is the signal crossing its threshold, not the
      // classification: a child can advance and then block in one window, and
      // the advancement still happened.
      if (result.signals !== undefined && result.signals.progress >= SUPERVISION_PROGRESS_THRESHOLD) {
        this.lastMeaningfulProgressAtMs = this.lastReviewAtMs;
      }
      // The classification this review read as its predecessor, captured
      // before this review becomes that predecessor for the next cadence.
      const previousClassification = this.previousReview?.classification;
      this.previousReview = {
        classification: result.classification,
        ...(result.signals === undefined ? {} : { signals: result.signals }),
        ...(this.lastMeaningfulProgressAtMs === undefined ? {} : { lastMeaningfulProgressAtMs: this.lastMeaningfulProgressAtMs }),
        traceFromCursor: digestCursorLabel(build.state.trace.cursorFrom),
        traceToCursor: digestCursorLabel(build.state.trace.cursorTo),
      };
      if (this.reviewerDegraded) {
        this.reviewerDegraded = false;
        this.emit("reviewer_recovered", "the supervision reviewer recovered");
      }
      let wake: SupervisionEvent | undefined;
      // The code-owned ADR-036 attention policy decides, never the
      // classification's legacy table: the result carries the decision, and
      // the local recompute is the fallback for a reviewer that omitted it.
      const attention = result.attention ?? supervisionAttention({
        classification: result.classification,
        ...(result.outcome === undefined ? {} : { outcome: result.outcome }),
        firstObservation: previousClassification === undefined || result.drift?.drifted === true,
        workingForMs,
        cadenceMs: this.deps.cadenceMs,
      });
      if (attention === "wake_manager") {
        wake = this.emit("reviewer_attention", `supervision review says ${result.classification}: ${result.summary}`, { classification: result.classification });
      } else {
        // Progress stores silently.
        this.publish(`review ${result.classification}: ${result.summary}`);
      }
      // The durable append runs strictly last: the in-memory record, the
      // watermark, the temporal memory, and the wake itself all already
      // happened, so a failed write loses only the dataset row and degrades
      // exactly like a reviewer failure (one reported episode, retry next
      // cadence). That deliberately differs from the router decision log's
      // ROUTER_LOG_UNAVAILABLE veto — that log is a launch precondition and
      // review telemetry never is.
      await this.persistReview(result, reviewed, workingSinceMs, transcriptDelta.length, transcript.length, previousClassification, wake, {
        source: trace.source,
        stateBytes: build.bytes.total,
        terminalBytes: build.bytes.terminal,
      });
    } catch (error) {
      // A failure that belongs to a run which has already ended, or to a pane the
      // child has left, is not evidence about anything either: it must not
      // degrade the reviewer, wake anyone, or publish, exactly as an obsolete
      // success must not.
      if (!this.reviewable(run, paneIdentity)) return;
      // ADR-036 V2-08: a reviewer infrastructure failure — transport, auth,
      // HTTP, malformed response — is not evidence about the child and never
      // wakes the manager. It normalizes to the silent unavailable result and
      // the finally re-arms, so the next cadence retries. A cancelled run's
      // abort never reaches this guard: stopping the run is what made the
      // failure obsolete above, so lifecycle cancellation stays intact.
      if (error instanceof ReviewerFailure) {
        this.publish(`review unavailable (${reviewerReason(error)})`);
        return;
      }
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
      if (!this.stopped && this.reviewRunLive(run)) this.armReview(this.deps.cadenceMs);
    }
  }

  /**
   * Persist one completed review — and the wake's pending disposition entry
   * when it woke the manager — to the durable review log. Runs strictly after
   * every supervision effect so a sink failure can only ever cost the dataset
   * row itself; the caller's catch degrades it like a reviewer failure.
   */
  private async persistReview(
    result: SupervisionReviewResult,
    reviewed: SupervisedIdentity,
    workingSinceMs: number,
    linesSinceLastReview: number,
    transcriptLines: number,
    previousClassification: ReviewClassification | undefined,
    wake: SupervisionEvent | undefined,
    sent: { source: TraceSourceKind; stateBytes: number; terminalBytes: number },
  ): Promise<void> {
    const append = this.deps.reviewLog ?? appendSupervisionReview;
    await append({
      jobId: this.deps.jobId,
      agentName: reviewed.agentName,
      agentKind: reviewed.agentKind,
      atMs: this.lastReviewAtMs!,
      classification: result.classification,
      attention: wake !== undefined,
      ...(result.signals === undefined ? {} : { signals: result.signals }),
      ...(result.evidenceSufficiency === undefined ? {} : { evidenceSufficiency: result.evidenceSufficiency }),
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      ...(this.lastMeaningfulProgressAtMs === undefined ? {} : { lastMeaningfulProgressAtMs: this.lastMeaningfulProgressAtMs }),
      linesSinceLastReview,
      ...(previousClassification === undefined ? {} : { previousClassification }),
      evidence: {
        paneId: reviewed.paneId,
        terminalId: reviewed.terminalId,
        agentSession: reviewed.agentSession,
        revision: this.lastRevision,
        ...(this.lastStateChangeSeq === undefined ? {} : { stateChangeSeq: this.lastStateChangeSeq }),
        transcriptLines,
        workingForMs: Math.max(0, this.lastReviewAtMs! - workingSinceMs),
      },
      provenance: {
        traceSource: sent.source,
        representation: representationForTraceSource(sent.source),
        traceFromCursor: result.evidence?.traceFromCursor ?? null,
        traceToCursor: result.evidence?.traceToCursor ?? null,
        traceDigestHash: result.evidence?.traceDigestHash ?? null,
        workspaceFingerprint: result.evidence?.workspaceFingerprint ?? null,
        stateBytes: sent.stateBytes,
        terminalBytes: sent.terminalBytes,
        identityHash: result.identityHash ?? null,
      },
      ...(wake === undefined ? {} : { wake: { eventId: wake.eventId, eventType: wake.type, atMs: wake.atMs } }),
    }, {
      root: this.deps.reviewLogRoot ?? defaultReviewLogRoot(),
      now: () => new Date(this.deps.clock.now()),
    });
  }

  /**
   * Persist one `violation` record per emitted Tier-0 wake — the closed
   * violation kind, the wake's bounded detail scalars, and the cadence's
   * provenance — through the same append seam. The digest the violations were
   * judged on is the sent state's own when the build produced one, else a
   * fresh digest of the same window (identical input, identical hash). Runs
   * strictly after the wakes and the cursor advance, so a sink failure costs
   * only the dataset rows and degrades like a reviewer failure.
   */
  private async persistTier0Violations(
    violations: Tier0ViolationReport[],
    reviewed: SupervisedIdentity,
    trace: TraceWindow,
    workspace: WorkspaceView,
    build: EvidenceBuild,
  ): Promise<void> {
    const append = this.deps.reviewLog ?? appendSupervisionReview;
    const digest = build.available ? build.state.trace : buildExecutionDigest(trace);
    const identity = build.available ? build.state.identity : build.identity;
    await append({
      jobId: this.deps.jobId,
      agentName: reviewed.agentName,
      agentKind: reviewed.agentKind,
      provenance: {
        traceSource: trace.source,
        representation: representationForTraceSource(trace.source),
        traceFromCursor: digestCursorLabel(digest.cursorFrom),
        traceToCursor: digestCursorLabel(digest.cursorTo),
        traceDigestHash: executionDigestHash(digest),
        workspaceFingerprint: workspace.available ? workspace.fingerprint : null,
        stateBytes: build.available ? build.bytes.total : null,
        terminalBytes: build.available ? build.bytes.terminal : null,
        /* c8 ignore next -- every violation-reachable build already minted an identity; null stays honest if a future pre-identity refusal reaches here. */
        identityHash: identity?.hash ?? null,
      },
      violations: violations.map(({ violation, event }) => ({
        eventId: event.eventId,
        eventType: event.type,
        atMs: event.atMs,
        violation,
        details: event.details,
      })),
    }, {
      root: this.deps.reviewLogRoot ?? defaultReviewLogRoot(),
      now: () => new Date(this.deps.clock.now()),
    });
  }

  /**
   * One cadence's workspace view (ADR-036 E2), read under the trusted launch
   * root and the base that `reserve()` pinned before dispatch. A missing or
   * failed pin stays typed evidence. The cadence never invents a later base.
   */
  private async cadenceWorkspace(writtenFiles: readonly string[], signal: AbortSignal): Promise<WorkspaceView> {
    const root = this.deps.workspaceRoot;
    if (root?.available !== true) {
      // The reservation's typed gap is the view's refusal — the W0 reason
      // verbatim in the detail, under the view vocabulary's `root_invalid`.
      return {
        version: WORKSPACE_VIEW_VERSION,
        available: false,
        failure: { reason: "root_invalid", detail: { gap: root?.available === false ? root.reason : "root_unavailable" } },
      };
    }
    const base = this.deps.workspaceBase;
    if (base === undefined) {
      return {
        version: WORKSPACE_VIEW_VERSION,
        available: false,
        failure: { reason: "base_invalid", detail: { gap: "base_unpinned" } },
      };
    }
    if (!base.available) return base;
    return buildWorkspaceView({ root: root.root, baseRevision: base.baseRevision, writtenFiles }, { run: this.workspaceRunner }, signal);
  }

  /**
   * ADR-036 Tier-0: deterministic attention evaluated before Jev. Each
   * violation emits one high-priority attention event carrying typed
   * violation evidence — no probabilistic classification, no review record —
   * and the cadence is consumed (the emitted reports drive the violation-log
   * append and tell the caller to return). Everything here is a code fact: a
   * read-only reservation whose workspace went dirty, or an E3 byte budget
   * that refused.
   */
  private emitTier0Violations(
    trace: TraceWindow,
    workspace: WorkspaceView,
    build: EvidenceBuild,
  ): Tier0ViolationReport[] {
    const violations: { reason: SupervisionTier0Violation; detail: string; evidence: Record<string, string | number | boolean> }[] = [];
    if (this.deps.assignmentDigest?.readOnly === true && workspace.available) {
      // ADR-036 V2-04: the violation is ANY delta from the reservation's
      // pinned base — a clean worktree does not hide commits. `dirty` covers
      // uncommitted and untracked work; head movement and the base-relative
      // file delta cover what a commit leaves behind.
      const headMoved = workspace.headRevision !== workspace.baseRevision;
      const deltaPaths = workspace.changedFiles.length + workspace.omittedFiles;
      if (workspace.dirty || headMoved || deltaPaths > 0) {
        const delta = [
          ...(workspace.dirty ? ["dirty"] : []),
          ...(headMoved ? ["head moved"] : []),
          ...(deltaPaths > 0 ? [`${deltaPaths} changed paths`] : []),
        ].join(", ");
        violations.push({
          reason: "read_only_dirty_workspace",
          detail: `read-only assignment, but the reserved workspace changed (${delta})`,
          evidence: {
            violation: "read_only_dirty_workspace",
            delta,
            baseRevision: workspace.baseRevision,
            headRevision: workspace.headRevision,
            filesChanged: workspace.stats.filesChanged,
            untrackedFiles: workspace.stats.untrackedFiles,
            omittedFiles: workspace.omittedFiles,
          },
        });
      }
    }
    // The typed detail rides the record too — bounded scalars (bytes, budget,
    // offset) are the violation's own provenance.
    const overflow = trace.typedFailure !== undefined && EVIDENCE_OVERFLOW_FAILURES.has(trace.typedFailure.kind)
      ? { kind: trace.typedFailure.kind, detail: trace.typedFailure.detail }
      : !build.available && EVIDENCE_OVERFLOW_CAUSES.has(build.failure.cause)
        ? { kind: build.failure.cause, detail: build.failure.detail }
        : undefined;
    if (overflow !== undefined) {
      violations.push({
        reason: "evidence_budget_exceeded",
        detail: `the evidence byte budget refused this cadence: ${overflow.kind}`,
        evidence: { ...overflow.detail, violation: "evidence_budget_exceeded", cause: overflow.kind },
      });
    }
    const reported: Tier0ViolationReport[] = [];
    for (const violation of violations) {
      reported.push({
        violation: violation.reason,
        event: this.emit("reviewer_attention", `supervision violation ${violation.reason}: ${violation.detail}`, violation.evidence),
      });
    }
    return reported;
  }

  /**
   * The cadence still belongs to somebody: the child is inside the same
   * continuous working run the review was armed for. This is what decides
   * re-arming, so a run that is merely waiting for its exact pane keeps ticking.
   */
  private reviewRunLive(run?: number): boolean {
    if (this.stopped || this.isSettled() || this.status !== "working") return false;
    return run === undefined || this.workingRun === run;
  }

  /**
   * A review may actually read and dispatch: its run is live, the child's exact
   * pane is proven, and it is still the pane the review pinned. A pending move
   * and a changed pane identity each fail this closed at every checkpoint, so a
   * move landing mid-review discards the result — whether it stays unresolved,
   * resolves, or was proven outright — instead of reviewing a pane the child has
   * left. Re-arming deliberately does not consult this: the run keeps its
   * cadence and the next review reads the pane the child now occupies.
   */
  private reviewable(run?: number, paneIdentity?: number): boolean {
    if (paneIdentity !== undefined && paneIdentity !== this.paneIdentityGeneration) return false;
    return this.pendingMoveDestination === undefined && this.reviewRunLive(run);
  }

  // -------------------------------------------------------------------- events

  private childRef(): { agentName: string; agentKind: string; paneId: string } {
    if (this.identity !== undefined) return { agentName: this.identity.agentName, agentKind: this.identity.agentKind, paneId: this.identity.paneId };
    const provisional = this.provisional!;
    return { agentName: provisional.identity.agentName, agentKind: provisional.identity.agentKind, paneId: provisional.identity.paneId };
  }

  private emit(type: SupervisionEventType, summary: string, details?: Record<string, string | number | boolean>): SupervisionEvent {
    const event = this.log.record(type, this.deps.clock.now(), summary, details);
    this.publish(`${type}: ${summary}`);
    // The wake payload is fixed at emission: a deferred suppression decision
    // must never re-read an identity the settle in between may have dropped.
    const wake: SupervisionWake = {
      jobId: this.deps.jobId,
      // Every material event is emitted after binding, so the bound identity is
      // authoritative here rather than the requested profile's shape.
      child: this.childRef(),
      event,
    };
    this.deps.notifier.wake(wake);
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
    if (type === "pane_closed" && this.deps.selfClose !== undefined) {
      // A manager-requested close is successful bookkeeping, not an event for
      // that same manager. Wait for the bounded close proof before deciding so
      // neither the event ledger nor its wake contains self-authored noise.
      try {
        const paneId = this.pendingMoveDestination?.paneId ?? this.childRef().paneId;
        if (await this.deps.selfClose.consume(paneId)) {
          await this.settle(outcome, trigger);
          return;
        }
      } catch {
        // Tracker failure is not proof; preserve the normal close event.
      }
    }
    this.emit(type, summary, { trigger });
    await this.settle(outcome, trigger);
  }

  private async settle(outcome: SupervisionResult, reason: string): Promise<void> {
    if (this.state === "settled") return;
    // `identity_lost` is the one settling outcome reached without its own event,
    // because a move or a reconnect proves it directly rather than observing it.
    if (outcome === "identity_lost") this.emit("identity_lost", `supervision lost the exact child's identity (${reason})`, { reason });
    // A proven exit may skip idle/done entirely. Check the bound native session
    // before dropping it, then allow one brief flush of a late error record.
    if (outcome === "released" && this.completionSignal !== undefined && !this.completionRecorded && this.identity !== undefined) {
      await this.recordCompletionSignal();
      if (!this.completionRecorded) {
        await new Promise<void>((resolve) => { setTimeout(resolve, 250); });
        await this.recordCompletionSignal();
      }
    }
    // The managed run's outcome is durable before the supervisor settles.
    await this.persistHandoffOutcome(outcome, reason);
    this.state = "settled";
    this.settlement = { outcome, reason };
    this.clearReviewTimer();
    if (this.completionRetry !== undefined) clearTimeout(this.completionRetry);
    this.completionRetry = undefined;
    this.deps.monitor.removeObserver(this);
    this.publish(`supervision settled ${outcome}`);
    this.resolveSettled(this.settlement);
  }

  // ------------------------------------------------------------------ handoff

  /** The bound managed run for the current exact identity, when this host gates one. */
  private managedRun(): { gate: HandoffGate; run: HandoffRun } | undefined {
    const gate = this.deps.handoffs;
    if (gate === undefined || this.identity === undefined) return undefined;
    const run = gate.lookup(this.identity);
    if (run !== undefined) this.boundHandoff = { gate, run };
    return run === undefined ? undefined : { gate, run };
  }

  /**
   * Queue a managed terminal observation for gated evaluation on the mutation
   * chain, behind the fold that produced it and ahead of later evidence.
   */
  private scheduleHandoffEvaluation(): void {
    if (this.deps.handoffs === undefined || this.stopped || this.isSettled()) return;
    void this.serialize(() => this.evaluateHandoff()).catch(() => undefined);
  }

  /**
   * One managed terminal observation: the current-cycle artifact hands the run
   * off when it validates; otherwise the exact child earns at most one repair
   * prompt per artifact version, fenced and persisted before any send.
   * Supervision stays active either way — a missing or invalid artifact is a
   * repair signal, never a settlement and never evidence.
   */
  private async evaluateHandoff(): Promise<void> {
    if (this.stopped || this.isSettled()) return;
    if (this.status !== "idle" && this.status !== "done" && this.status !== "blocked") return;
    const managed = this.managedRun();
    if (managed === undefined || managed.run.lifecycle !== "awaiting_handoff") return;
    const { gate, run } = managed;
    const validation: HandoffValidation | undefined = await gate.validate(run).catch(() => undefined);
    if (validation === undefined) return;
    if (handoffGateMatches(validation, "terminal", this.status)) {
      try {
        await gate.recordOutcome(run, "handed_off");
      } catch {
        // An unpersisted outcome is re-evaluated by the next observation or shutdown.
      }
      return;
    }
    const prompt = this.deps.repairPrompt;
    if (prompt === undefined || this.stopped || this.isSettled()) return;
    // The attempt and fence are durable before this returns a token; a version
    // already fenced is never re-prompted, and a send that fails never
    // un-fences it and never counts as evidence.
    const fence = await gate.beginRepair(run).catch(() => null);
    if (fence === null) return;
    const gateReason = validation.reason === undefined ? validation.state : `${validation.state}:${validation.reason}`;
    try {
      await prompt(run.identity.paneId, [
        `The managed run handoff for this assignment is still awaiting a valid artifact (${gateReason}).`,
        "Write or repair it exactly as specified, then finish the turn.",
        renderHandoffContract(run.allocation),
      ].join("\n"), this.abort.signal);
      this.publish(`handoff repair prompt sent for artifact version ${fence.version} (${gateReason})`);
    } catch {
      this.publish(`handoff repair prompt for artifact version ${fence.version} failed (${gateReason})`);
    }
  }

  /**
   * Persist the run's outcome ahead of settlement. Only an authoritative exit
   * (`released`, `identity_replaced`) authorizes the Tools-authored cancelled
   * fallback, and only after the current artifact had its last chance to hand
   * off. `identity_lost` proves nothing about the run and teardown fabricates
   * nothing — both leave the run unresolved for `recovery_pending`.
   */
  private async persistHandoffOutcome(outcome: SupervisionResult, reason: string): Promise<void> {
    if (outcome !== "released" && outcome !== "identity_replaced") return;
    const managed = this.managedRun();
    if (managed === undefined || managed.run.lifecycle !== "awaiting_handoff") return;
    let handedOff = false;
    try {
      // Authoritative exit has no remaining raw agent state to correlate. Any
      // current valid terminal artifact wins over the Tools-authored fallback.
      handedOff = (await managed.gate.validate(managed.run)).state === "accepted";
    } catch {
      // An unreadable artifact does not weaken the authoritative exit.
    }
    try {
      await managed.gate.recordOutcome(managed.run, handedOff ? "handed_off" : "cancelled", reason);
    } catch {
      // A failed write leaves the run unresolved; recovery owns it from here.
    }
  }

  // ----------------------------------------------------------------- job port

  /**
   * The bound managed run's bounded evidence for `herdr_jobs get`. The gate
   * drops a resolved run once the supervisor settles it, so the retained
   * binding keeps the terminal evidence projectable; an absent binding reports
   * exactly why the job is ungated instead of omitting the block.
   */
  handoffEvidence(): HandoffInspection {
    const managed = this.managedRun() ?? this.boundHandoff;
    if (managed === undefined) {
      return {
        gated: false,
        reason: this.deps.handoffs === undefined ? "gate_unavailable"
          : this.identity === undefined ? "identity_unavailable"
          : "no_managed_run"
      };
    }
    return { gated: true, ...managed.gate.evidence(managed.run) };
  }

  view(): SupervisionJobView {
    const streamDegraded = this.eventStreamDegraded || this.deps.monitor.isDegraded();
    const monitorDegraded = streamDegraded || this.reconciliationDegraded;
    const projectedState = this.bindingPublished && !this.isSettled()
      ? monitorDegraded ? "degraded" : "active"
      : this.state;
    const common = {
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
        cadenceMinutes: Math.round(this.deps.cadenceMs / 60_000),
        degraded: this.reviewerDegraded,
        reviews: this.reviews.entries(),
        truncatedReviews: this.reviews.truncated(),
        ...(this.lastReviewAtMs === undefined ? {} : { lastReviewAtMs: this.lastReviewAtMs }),
      },
      transitions: [
        ...this.transitions.entries(),
        ...(this.bindingPublished ? this.strengtheningCandidate?.events ?? [] : []),
      ],
      truncatedTransitions: this.transitions.truncated(),
      events: this.log.history(),
      truncatedEvents: this.log.truncatedEvents(),
      unobservedEvents: this.log.unobserved(),
      ...(this.settlement === undefined ? {} : { settledReason: this.settlement.reason }),
    };
    if (projectedState === "reserved") return { ...common, state: "reserved" };
    if (projectedState === "provisional") {
      if (this.provisional === undefined) return { ...common, state: "reserved" };
      return { ...common, state: "provisional", provisional: this.provisionalView(this.provisional), status: "idle" };
    }
    if (projectedState === "settled") return {
      ...common,
      state: "settled",
      ...(!this.bindingPublished || this.identity === undefined ? {} : { child: this.childView(this.identity) }),
      ...(!this.bindingPublished || this.status === undefined ? {} : { status: this.status }),
    };
    return {
      ...common,
      state: projectedState,
      child: this.childView(this.identity!),
      status: this.status!,
    };
  }

  private provisionalView(binding: ProvisionalSupervisionBinding): NonNullable<Extract<SupervisionJobView, { state: "provisional" }>["provisional"]> {
    return {
      agentName: binding.identity.agentName,
      agentKind: "agy",
      paneId: binding.identity.paneId,
      terminalId: binding.identity.terminalId,
      operatingPointId: binding.operatingPointId,
      ...(binding.operatingPointId === this.deps.child.operatingPointId ? {} : { requestedOperatingPointId: this.deps.child.operatingPointId }),
      baseline: { ...binding.baseline },
    };
  }

  private childView(identity: SupervisedIdentity): SupervisionChildView {
    // The bound profile is the one that actually started this child; binding sets
    // it alongside the identity this view already requires. The reserved profile
    // is kept beside it only when fallback selection changed it, so the two never
    // silently contradict each other.
    const operatingPointId = this.selectedOperatingPointId!;
    return {
      agentName: identity.agentName,
      agentKind: identity.agentKind,
      paneId: identity.paneId,
      terminalId: identity.terminalId,
      operatingPointId,
      ...(operatingPointId === this.deps.child.operatingPointId ? {} : { requestedOperatingPointId: this.deps.child.operatingPointId }),
      ...(identity.agentKind === this.deps.child.agentKind ? {} : { requestedAgentKind: this.deps.child.agentKind }),
    };
  }

  takePendingEvents(): SupervisionEvent[] {
    const pending = this.log.pending();
    this.log.markObserved(pending.map((event) => event.eventId));
    return pending;
  }

  childLive(): boolean {
    return (this.provisionalPublished && this.state === "provisional" && this.provisional !== undefined)
      || (this.bindingPublished && (this.state === "active" || this.state === "degraded") && this.identity !== undefined);
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
    if (this.completionRetry !== undefined) clearTimeout(this.completionRetry);
    this.completionRetry = undefined;
    this.abort.abort();
    this.deps.monitor.removeObserver(this);
    if (this.isSettled()) return;
    this.state = "settled";
    this.settlement = { outcome: "cancelled", reason: "manager_session_shutdown" };
    this.resolveSettled(this.settlement);
  }

  /** Release a reservation that never bound, so its job settles instead of leaking. */
  release(reason: string): void {
    // A published provisional job may have had prompt effect. Releasing it would
    // destroy the only recovery handle, so manager shutdown is its sole stop path.
    if (this.provisionalPublished && !this.bindingPublished) {
      this.publish(`AGY provisional supervision retained; release refused (${reason})`);
      return;
    }
    if (this.stopped) return;
    this.stopped = true;
    this.clearReviewTimer();
    if (this.completionRetry !== undefined) clearTimeout(this.completionRetry);
    this.completionRetry = undefined;
    this.abort.abort();
    this.deps.monitor.removeObserver(this);
    if (this.isSettled()) return;
    this.state = "settled";
    this.settlement = { outcome: "failed", reason };
    this.resolveSettled(this.settlement);
  }
}

function validProvisionalBinding(binding: ProvisionalSupervisionBinding): boolean {
  try {
    const identity: ProvisionalSupervisedIdentity = binding.identity;
    const baseline = binding.baseline;
    return validProvisionalIdentity(identity)
      && typeof binding.operatingPointId === "string"
      && binding.operatingPointId.length > 0
      && !/[\0\r\n]/u.test(binding.operatingPointId)
      && baseline.state === "idle"
      && Number.isSafeInteger(baseline.stateChangeSeq)
      && baseline.stateChangeSeq >= 0
      && Number.isSafeInteger(baseline.revision)
      && baseline.revision >= 0;
  } catch {
    return false;
  }
}

function validProvisionalIdentity(identity: ProvisionalSupervisedIdentity): boolean {
  return typeof identity === "object"
    && identity !== null
    && typeof identity.paneId === "string"
    && identity.paneId.length > 0
    && !/[\0\r\n]/u.test(identity.paneId)
    && typeof identity.terminalId === "string"
    && identity.terminalId.length > 0
    && !/[\0\r\n]/u.test(identity.terminalId)
    && typeof identity.agentName === "string"
    && identity.agentName.length > 0
    && !/[\0\r\n]/u.test(identity.agentName)
    && identity.agentKind === "agy";
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
