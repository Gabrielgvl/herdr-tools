import type { SupervisionCoordinator, SupervisionReservation } from "../../src/supervision/registry.js";
import type { ProvisionalSupervisionBinding } from "../../src/supervision/identity.js";
import type { SupervisionBinding } from "../../src/supervision/supervisor.js";

export interface StubSupervision extends SupervisionCoordinator {
  readonly reserved: Array<{ agentName: string; agentKind: string; candidateName: string }>;
  readonly bindAttempts: SupervisionBinding[];
  readonly bound: SupervisionBinding[];
  readonly provisionalBindAttempts: ProvisionalSupervisionBinding[];
  readonly provisionalBound: ProvisionalSupervisionBinding[];
  readonly strengthenAttempts: SupervisionBinding[];
  readonly strengthened: SupervisionBinding[];
  readonly released: string[];
  readonly jobId: string;
}

export interface StubSupervisionOptions {
  jobId?: string;
  reserveError?: Error;
  bindError?: Error;
  provisionalBindError?: Error;
  strengthenError?: Error;
  onBind?: (binding: SupervisionBinding) => void | Promise<void>;
  onProvisionalBind?: (binding: ProvisionalSupervisionBinding) => void | Promise<void>;
  onStrengthen?: (binding: SupervisionBinding) => void | Promise<void>;
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
  const provisionalBindAttempts: ProvisionalSupervisionBinding[] = [];
  const provisionalBound: ProvisionalSupervisionBinding[] = [];
  const strengthenAttempts: SupervisionBinding[] = [];
  const strengthened: SupervisionBinding[] = [];
  const released: string[] = [];
  const reservation: SupervisionReservation = {
    jobId,
    bind: async (binding) => {
      bindAttempts.push(binding);
      await options.onBind?.(binding);
      if (options.bindError) throw options.bindError;
      bound.push(binding);
    },
    bindProvisional: async (binding) => {
      provisionalBindAttempts.push(binding);
      await options.onProvisionalBind?.(binding);
      if (options.provisionalBindError) throw options.provisionalBindError;
      provisionalBound.push(binding);
    },
    strengthen: async (binding) => {
      strengthenAttempts.push(binding);
      await options.onStrengthen?.(binding);
      if (options.strengthenError) throw options.strengthenError;
      strengthened.push(binding);
    },
    release: (reason) => { released.push(reason); },
  };
  return {
    jobId,
    reserved,
    bindAttempts,
    bound,
    provisionalBindAttempts,
    provisionalBound,
    strengthenAttempts,
    strengthened,
    released,
    reserve: async (request) => {
      if (options.reserveError) throw options.reserveError;
      reserved.push({ ...request.child });
      return reservation;
    },
  };
}
