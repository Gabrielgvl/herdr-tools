import type { SupervisionCoordinator, SupervisionReservation } from "../../src/supervision/registry.js";
import type { SupervisionBinding } from "../../src/supervision/supervisor.js";

export interface StubSupervision extends SupervisionCoordinator {
  readonly reserved: Array<{ agentName: string; agentKind: string; profileName: string }>;
  readonly bindAttempts: SupervisionBinding[];
  readonly bound: SupervisionBinding[];
  readonly released: string[];
  readonly jobId: string;
}

export interface StubSupervisionOptions {
  jobId?: string;
  reserveError?: Error;
  bindError?: Error;
  onBind?: (binding: SupervisionBinding) => void | Promise<void>;
}

/**
 * A launch-facing supervision coordinator that records the reserve/bind/release
 * calls without opening a socket. The real coordinator is exercised in
 * `supervision-registry.test.ts`.
 */
export function stubSupervision(options: StubSupervisionOptions = {}): StubSupervision {
  const jobId = options.jobId ?? "job_supervisor";
  const reserved: StubSupervision["reserved"] = [];
  const bindAttempts: SupervisionBinding[] = [];
  const bound: SupervisionBinding[] = [];
  const released: string[] = [];
  const reservation: SupervisionReservation = {
    jobId,
    bind: async (binding) => {
      bindAttempts.push(binding);
      await options.onBind?.(binding);
      if (options.bindError) throw options.bindError;
      bound.push(binding);
    },
    release: (reason) => { released.push(reason); },
  };
  return {
    jobId,
    reserved,
    bindAttempts,
    bound,
    released,
    reserve: async (request) => {
      if (options.reserveError) throw options.reserveError;
      reserved.push({ ...request.child });
      return reservation;
    },
  };
}
