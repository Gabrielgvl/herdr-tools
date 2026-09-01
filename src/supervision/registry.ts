/**
 * The session-scoped supervision coordinator.
 *
 * It owns the one event connection, the supervisor jobs, and the reserve → bind
 * → settle contract `herdr_launch` depends on. Nothing here persists across
 * manager sessions.
 */

import { createTargetGenerationRef } from "../wait-target-evidence.js";
import type { JobGeneration, JobRegistry, SupervisorJobRequestSnapshot } from "../job-registry.js";
import type { Settings } from "../settings.js";
import { SessionEventMonitor, type SupervisionMonitorDependencies } from "./monitor.js";
import { inertNotifier, type ManagerNotifier } from "./notify.js";
import { ReviewerFailure } from "../reviewer.js";
import { ModelSupervisionReviewer, SUPERVISION_REVIEWER_MODEL, type SupervisionReviewer } from "./reviewer.js";
import type { SupervisionModelService } from "./model-service.js";
import {
  Supervisor,
  type SupervisionBinding,
  type SupervisionChildRequest,
  type SupervisionScheduler,
} from "./supervisor.js";

/** The transcript source the reviewer reads. Bounded by the CLI's own evidence limits. */
export type SupervisionTranscriptReader = (paneId: string, signal: AbortSignal) => Promise<string[]>;

export interface SupervisionRegistryDependencies {
  jobs: JobRegistry;
  settingsLoader: () => Promise<Settings>;
  readTranscript: SupervisionTranscriptReader;
  notifier?: ManagerNotifier;
  monitor?: SessionEventMonitor;
  monitorOptions?: SupervisionMonitorDependencies;
  /** Absent on a host with no model service; the reviewer then degrades visibly. */
  models?: SupervisionModelService;
  reviewerFactory?: () => SupervisionReviewer;
  clock?: { now(): number };
  scheduler?: SupervisionScheduler;
  idFactory?: () => string;
  targetGenerationRefFactory?: () => string;
}

export interface SupervisionReserveRequest {
  child: SupervisionChildRequest;
}

/** What a launch holds between reserving supervision and binding it. */
export interface SupervisionReservation {
  readonly jobId: string;
  bind(binding: SupervisionBinding): Promise<void>;
  release(reason: string): void;
}

/** The seam `herdr_launch` depends on. Required, so a launch cannot skip supervision. */
export interface SupervisionCoordinator {
  reserve(request: SupervisionReserveRequest, generation?: JobGeneration): Promise<SupervisionReservation>;
}

/**
 * A reviewer that always fails, for a host with no model service. It keeps the
 * supervisor visibly degraded on cadence instead of silently unreviewed, and it
 * never substitutes another model.
 */
class UnavailableReviewer implements SupervisionReviewer {
  async review(): Promise<never> {
    throw new ReviewerFailure("No supervision reviewer model service is available on this host");
  }
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

export class SupervisionRegistry implements SupervisionCoordinator {
  private readonly monitor: SessionEventMonitor;
  private readonly notifier: ManagerNotifier;
  private readonly supervisors = new Set<Supervisor>();

  constructor(private readonly deps: SupervisionRegistryDependencies) {
    this.monitor = deps.monitor ?? new SessionEventMonitor(deps.monitorOptions ?? {});
    this.notifier = deps.notifier ?? inertNotifier;
  }

  private reviewer(): SupervisionReviewer {
    if (this.deps.reviewerFactory) return this.deps.reviewerFactory();
    return this.deps.models ? new ModelSupervisionReviewer(this.deps.models) : new UnavailableReviewer();
  }

  /**
   * Reserve supervision before any topology mutation. This connects, bootstraps,
   * and subscribes the session monitor, then registers the supervisor job so the
   * launch has a stable job ID to return.
   */
  async reserve(request: SupervisionReserveRequest, generation?: JobGeneration): Promise<SupervisionReservation> {
    await this.monitor.ensureStarted();
    const settings = await this.deps.settingsLoader();
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
        reviewerThinking: "max",
      },
    };
    const ready = deferred<Supervisor>();
    const identity = { jobId: "" };
    const registered = this.deps.jobs.register(jobRequest, async (_signal, update) => {
      const supervisor = new Supervisor({
        jobId: identity.jobId,
        child: { ...request.child },
        monitor: this.monitor,
        notifier: this.notifier,
        reviewer: this.reviewer(),
        cadenceMs: settings.reviewCadenceMinutes * 60_000,
        clock: this.deps.clock ?? { now: () => Date.now() },
        ...(this.deps.scheduler ? { scheduler: this.deps.scheduler } : {}),
        readTranscript: this.deps.readTranscript,
        ...(this.deps.idFactory ? { idFactory: this.deps.idFactory } : {}),
        update,
      });
      this.supervisors.add(supervisor);
      this.deps.jobs.attachSupervision(identity.jobId, supervisor);
      ready.resolve(supervisor);
      const settlement = await supervisor.run();
      this.supervisors.delete(supervisor);
      return { supervision_result: settlement.outcome, reason: settlement.reason };
    }, generation);
    identity.jobId = registered.jobId;
    // The runner starts on a later microtask, so the reservation waits for the
    // supervisor object rather than racing it.
    const bound = await ready.promise;
    return {
      jobId: registered.jobId,
      bind: (binding) => bound.bind(binding),
      release: (reason) => bound.release(reason),
    };
  }

  /** Stop every supervisor and close the connection. Manager-session shutdown only. */
  shutdown(): void {
    for (const supervisor of [...this.supervisors]) supervisor.shutdown();
    this.supervisors.clear();
    this.monitor.stop();
  }
}
