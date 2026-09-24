/**
 * The session-scoped supervision coordinator.
 *
 * It owns the one event connection, the supervisor jobs, and the reserve → bind
 * → settle contract `herdr_launch` depends on. Supervisor objects remain
 * session-scoped; managed handoff sidecars persist separately as recovery evidence.
 */

import { createTargetGenerationRef } from "../wait-target-evidence.js";
import type { JobGeneration, JobRegistry, SupervisionReservationDigest, SupervisionWorkspaceRoot, SupervisorJobRequestSnapshot } from "../job-registry.js";
import type { Settings } from "../settings.js";
import { SessionEventMonitor, type SupervisionMonitorDependencies } from "./monitor.js";
import { inertNotifier, type ManagerNotifier } from "./notify.js";
import { SUPERVISION_REVIEWER_MODEL, TypeSafeSupervisionReviewer, type SupervisionReviewer } from "./reviewer.js";
import { resolveTypesafeApiKey } from "../typesafe-reviewer.js";
import type { AuthJsonCredentialStore } from "./auth-json-credential-store.js";
import { buildWorkspaceView, createNodeWorkspaceRunner, type WorkspaceCommandRunner, type WorkspaceView } from "./evidence.js";
import type { SupervisionModelService } from "./model-service.js";
import type { ProvisionalSupervisionBinding, SupervisedIdentity } from "./identity.js";
import type { SelfCloseTracker } from "./self-close.js";
import type { HandoffGate, HandoffRun } from "../handoff-gate.js";
import { TRACE_FALLBACK_CURSOR_MAX_LINES } from "./trace-source.js";
import {
  Supervisor,
  SupervisionBindError,
  type SupervisionBinding,
  type SupervisionChildRequest,
  type SupervisionScheduler,
  type ProviderLimitSignal,
} from "./supervisor.js";

/** The transcript source the reviewer reads. Bounded by the CLI's own evidence limits. */
export type SupervisionTranscriptReader = (paneId: string, signal: AbortSignal) => Promise<string[]>;

/** The bounded transcript window a reviewer receives. */
export const SUPERVISION_TRANSCRIPT_LINES = TRACE_FALLBACK_CURSOR_MAX_LINES;

/**
 * The one authoritative transcript read both hosts use. It is the same
 * `pane read` the wait reviewer uses, so supervision adds no new Herdr surface.
 */
export function createCliTranscriptReader(cli: { runText(argv: string[], signal: AbortSignal): Promise<string> }): SupervisionTranscriptReader {
  return async (paneId, signal) => {
    const output = await cli.runText(["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(SUPERVISION_TRANSCRIPT_LINES), "--format", "text"], signal);
    return output.length === 0 ? [] : output.split(/\r?\n/u).slice(-SUPERVISION_TRANSCRIPT_LINES);
  };
}

export interface SupervisionRegistryDependencies {
  jobs: JobRegistry;
  settingsLoader: () => Promise<Settings>;
  readTranscript: SupervisionTranscriptReader;
  notifier?: ManagerNotifier;
  /**
   * Builds this session's event monitor. A stopped monitor stays stopped, so a
   * new manager session gets a genuinely new one rather than a revived
   * connection that could outlive the session it belonged to.
   */
  monitorFactory?: () => SessionEventMonitor;
  monitorOptions?: SupervisionMonitorDependencies;
  /**
   * Retained for the hosts that still wire one; the Jev reviewer no longer
   * consults it, so a supplied or missing service changes nothing.
   */
  models?: () => SupervisionModelService | undefined;
  /**
   * The Jev credential source the default reviewer consults when
   * `TYPESAFE_API_KEY` is unset. Tests inject a fake so no real auth file is
   * read; production leaves it undefined for the shared auth.json store.
   */
  typesafeCredentials?: Pick<AuthJsonCredentialStore, "read">;
  reviewerFactory?: () => SupervisionReviewer;
  /** The host's own-close ledger; forwarded to every supervisor it reserves. */
  selfClose?: SelfCloseTracker;
  /**
   * The shared managed-handoff gate. A binding that carries an allocation is
   * bound to the exact identity through it before the child binding commits;
   * a host without one cannot accept a managed binding at all.
   */
  handoffs?: HandoffGate;
  /**
   * Exact-child repair prompt transport, forwarded to every supervisor. A host
   * without one still gates outcomes but never fences a repair attempt.
   */
  repairPrompt?: (paneId: string, text: string, signal: AbortSignal) => Promise<unknown>;
  clock?: { now(): number };
  scheduler?: SupervisionScheduler;
  /** The reserve-time and cadence workspace command seam. */
  workspaceRunner?: WorkspaceCommandRunner;
  idFactory?: () => string;
  targetGenerationRefFactory?: () => string;
}

/** Reservation-scoped settings. Callers pass the digest already bounded and redacted. */
export interface SupervisionReservationSettings {
  /** The launch's authorial done-when/constraints plus the bounded `readOnly` claim (ADR-034; ADR-036 W0). */
  supervisionDigest?: SupervisionReservationDigest;
  /** The trusted launch workspace root the workspace evidence reads; never the supervisor's own cwd. */
  workspaceRoot?: SupervisionWorkspaceRoot;
}

export interface SupervisionReserveRequest {
  child: SupervisionChildRequest;
  settings?: SupervisionReservationSettings;
}

/** What a launch holds between reserving supervision and binding it. */
export interface SupervisionReservation {
  readonly jobId: string;
  bind(binding: SupervisionBinding): Promise<void>;
  bindProvisional(binding: ProvisionalSupervisionBinding): Promise<void>;
  strengthen(binding: SupervisionBinding): Promise<void>;
  /** Observe typed post-prompt completion evidence on the exact bound child. */
  onCompletionSignal(signal: (identity: SupervisedIdentity) => Promise<ProviderLimitSignal>): void;
  release(reason: string): void;
}

/** The seam `herdr_launch` depends on. Required, so a launch cannot skip supervision. */
export interface SupervisionCoordinator {
  reserve(request: SupervisionReserveRequest, generation?: JobGeneration): Promise<SupervisionReservation>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

export class SupervisionWorkspaceBaseError extends Error {
  readonly code = "SUPERVISION_WORKSPACE_BASE_UNAVAILABLE" as const;

  constructor(readonly details: Record<string, string | number | boolean>) {
    super("The supervision workspace base could not be pinned");
    this.name = "SupervisionWorkspaceBaseError";
  }
}

export class SupervisionRegistry implements SupervisionCoordinator {
  private readonly newMonitor: () => SessionEventMonitor;
  private monitor: SessionEventMonitor;
  private readonly notifier: ManagerNotifier;
  private readonly workspaceRunner: WorkspaceCommandRunner;
  private readonly supervisors = new Set<Supervisor>();

  constructor(private readonly deps: SupervisionRegistryDependencies) {
    this.newMonitor = deps.monitorFactory ?? (() => new SessionEventMonitor(deps.monitorOptions ?? {}));
    this.monitor = this.newMonitor();
    this.notifier = deps.notifier ?? inertNotifier;
    this.workspaceRunner = deps.workspaceRunner ?? createNodeWorkspaceRunner();
  }

  private async reviewer(): Promise<SupervisionReviewer> {
    if (this.deps.reviewerFactory) return this.deps.reviewerFactory();
    const apiKey = await resolveTypesafeApiKey(this.deps.typesafeCredentials);
    return new TypeSafeSupervisionReviewer({ apiKey });
  }

  private async pinWorkspaceBase(root: SupervisionWorkspaceRoot | undefined): Promise<WorkspaceView | undefined> {
    if (root?.available !== true) return undefined;
    const view = await buildWorkspaceView({ root: root.root }, { run: this.workspaceRunner }, new AbortController().signal);
    if (!view.available) {
      throw new SupervisionWorkspaceBaseError({ ...(view.failure.detail ?? {}), reason: view.failure.reason });
    }
    return view;
  }

  /**
   * Reserve supervision before any topology mutation. This connects, bootstraps,
   * and subscribes the session monitor, then registers the supervisor job so the
   * launch has a stable job ID to return.
   */
  async reserve(request: SupervisionReserveRequest, generation?: JobGeneration): Promise<SupervisionReservation> {
    // Captured once: a session restart replaces the monitor, and this
    // reservation belongs to the session it started in.
    const monitor = this.monitor;
    await monitor.ensureStarted();
    const settings = await this.deps.settingsLoader();
    // This must settle before the reservation returns. `herdr_launch` performs
    // no child effect until then, so a failed pin cannot re-anchor after dispatch.
    const workspaceBase = await this.pinWorkspaceBase(request.settings?.workspaceRoot);
    // The reservation-scoped digest and Tier-0 policy facts persist on the
    // request record the job keeps; the public projection allowlists request
    // fields and drops every one of them.
    const supervisionDigest = request.settings?.supervisionDigest;
    const jobRequest: SupervisorJobRequestSnapshot = {
      kind: "supervisor",
      label: `supervise ${request.child.agentName}`,
      targets: [request.child.agentName],
      targetIds: [],
      target_generation_refs: [createTargetGenerationRef(this.deps.targetGenerationRefFactory)],
      child: { ...request.child },
      settings: {
        reviewCadenceMinutes: settings.reviewCadenceMinutes,
        reviewerModel: SUPERVISION_REVIEWER_MODEL,
        supervisionDigest,
        workspaceRoot: request.settings?.workspaceRoot,
      },
    };
    const ready = deferred<Supervisor>();
    const identity = { jobId: "" };
    // The gate-bound run this reservation's bind created, if any. The runner
    // forgets it once the supervisor settles it resolved; an unresolved run
    // stays bound so a later shutdown can still mark it recovery_pending.
    let boundHandoffRun: HandoffRun | undefined;
    const registered = this.deps.jobs.register(jobRequest, async (_signal, update) => {
      const supervisor = new Supervisor({
        jobId: identity.jobId,
        child: { ...request.child },
        ...(supervisionDigest === undefined ? {} : { assignmentDigest: supervisionDigest }),
        ...(request.settings?.workspaceRoot === undefined ? {} : { workspaceRoot: request.settings.workspaceRoot }),
        ...(workspaceBase === undefined ? {} : { workspaceBase }),
        workspaceRunner: this.workspaceRunner,
        monitor,
        notifier: this.notifier,
        reviewer: await this.reviewer(),
        cadenceMs: settings.reviewCadenceMinutes * 60_000,
        clock: this.deps.clock ?? { now: () => Date.now() },
        ...(this.deps.scheduler ? { scheduler: this.deps.scheduler } : {}),
        ...(this.deps.selfClose ? { selfClose: this.deps.selfClose } : {}),
        ...(this.deps.handoffs ? { handoffs: this.deps.handoffs } : {}),
        ...(this.deps.repairPrompt ? { repairPrompt: this.deps.repairPrompt } : {}),
        readTranscript: this.deps.readTranscript,
        ...(this.deps.idFactory ? { idFactory: this.deps.idFactory } : {}),
        update,
      });
      this.supervisors.add(supervisor);
      this.deps.jobs.attachSupervision(identity.jobId, supervisor);
      ready.resolve(supervisor);
      const settlement = await supervisor.run();
      this.supervisors.delete(supervisor);
      if (boundHandoffRun !== undefined && boundHandoffRun.lifecycle !== "awaiting_handoff") {
        this.deps.handoffs?.drop(boundHandoffRun);
      }
      return { supervision_result: settlement.outcome, reason: settlement.reason };
    }, generation);
    identity.jobId = registered.jobId;
    // The runner starts on a later microtask, so the reservation waits for the
    // supervisor object rather than racing it.
    const bound = await ready.promise;
    return {
      jobId: registered.jobId,
      bind: async (binding) => {
        const publication = this.deps.jobs.prepareSupervisionChildBinding(registered.jobId, {
          agentKind: binding.identity.agentKind,
          operatingPointId: binding.operatingPointId,
          paneId: binding.identity.paneId,
        });
        try {
          if (binding.handoff !== undefined) {
            // Persist the exact identity binding before the child binding is
            // accepted: the run is gate-visible even if supervision then fails,
            // because the durable contract was already delivered to the child.
            const gate = this.deps.handoffs;
            if (gate === undefined) throw new SupervisionBindError("The managed handoff gate is unavailable on this host", { supervisionJobId: registered.jobId });
            boundHandoffRun = await gate.bind(binding.handoff.allocation, {
              ...binding.identity,
              agentId: binding.handoff.agentId ?? null,
            });
          }
          await bound.bind(binding, publication);
        } catch (error) {
          // Idempotent and required even when Supervisor already rolled back a
          // partially committed publication.
          publication.rollback();
          throw error;
        }
      },
      bindProvisional: async (binding) => {
        const publication = this.deps.jobs.prepareProvisionalSupervisionChildBinding(registered.jobId, {
          agentKind: binding.identity.agentKind,
          operatingPointId: binding.operatingPointId,
        });
        try {
          await bound.bindProvisional(binding, publication);
        } catch (error) {
          publication.rollback();
          throw error;
        }
      },
      strengthen: async (binding) => {
        const publication = this.deps.jobs.prepareSupervisionStrengthening(registered.jobId, {
          agentKind: binding.identity.agentKind,
          operatingPointId: binding.operatingPointId,
          paneId: binding.identity.paneId,
        });
        try {
          await bound.strengthen(binding, publication);
        } catch (error) {
          publication.rollback();
          throw error;
        }
      },
      onCompletionSignal: (signal) => bound.onCompletionSignal(signal),
      release: (reason) => bound.release(reason),
    };
  }

  /** Stop every supervisor and close the connection. Manager-session shutdown only. */
  async shutdown(): Promise<void> {
    // Unresolved managed runs become recovery_pending before any supervisor
    // settles; teardown itself fabricates no terminal status. The durable
    // writes are awaited so a caller can rely on the sidecar surviving even
    // when the process exits immediately after shutdown resolves.
    await this.deps.handoffs?.shutdown();
    for (const supervisor of [...this.supervisors]) supervisor.shutdown();
    this.supervisors.clear();
    this.monitor.stop();
  }

  /**
   * Start a new manager session. Supervision is session-scoped, so the previous
   * session's supervisors and monitor are stopped and a fresh monitor replaces
   * them. Without this a post-shutdown session would keep a permanently stopped
   * monitor and every later launch would refuse at reservation.
   */
  async beginSession(): Promise<void> {
    await this.shutdown();
    this.monitor = this.newMonitor();
  }
}
