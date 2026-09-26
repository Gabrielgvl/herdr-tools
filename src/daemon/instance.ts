/**
 * The single-instance primitive (spec: durable-supervisor §4): exactly one
 * daemon per endpoint namespace.
 *
 * The lock is a native `flock` held by the spawned holder from
 * `acquireFlockHolder` while its stdin stays open; acquisition is nonblocking,
 * so a live daemon owning the lock refuses a second start instead of letting
 * it queue behind the incumbent. The lock inode is never unlinked while held:
 * unlinking would split the exclusion domain between the holder's file
 * description and a new acquirer's fresh inode.
 */

import { join } from "node:path";
import { acquireFlockHolder, type FlockHolderLease } from "../pane-write-lock.js";
import type { DaemonNamespace } from "./namespace.js";

export type DaemonInstanceErrorCode = "DAEMON_INSTANCE_HELD" | "DAEMON_INSTANCE_UNAVAILABLE";

export class DaemonInstanceError extends Error {
  constructor(readonly code: DaemonInstanceErrorCode, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "DaemonInstanceError";
  }
}

export const DAEMON_INSTANCE_LOCK_NAME = "daemon.lock";
const DAEMON_INSTANCE_READY = "HERDR_DAEMON_INSTANCE_LOCK_READY";
const SUBJECT = "Daemon instance";
/**
 * Nonblocking contention — flock's exit 1 or a ready-marker deadline — is the
 * one "another daemon owns this endpoint" class; `acquireFlockHolder` reports
 * it as `${subject} lock was unavailable`. Every other rejection is an
 * unverifiable lock, not a busy one, so it stays UNAVAILABLE.
 */
const HELD_MESSAGE = `${SUBJECT} lock was unavailable`;

const failure = (message: string): DaemonInstanceError =>
  new DaemonInstanceError(message === HELD_MESSAGE ? "DAEMON_INSTANCE_HELD" : "DAEMON_INSTANCE_UNAVAILABLE", message);

/** One held instance lock: liveness and lock-path trust re-checks, then release. */
export type DaemonInstanceLease = FlockHolderLease;

/**
 * Take the endpoint's instance lock or refuse. `DAEMON_INSTANCE_HELD` means a
 * live daemon already owns this namespace; `DAEMON_INSTANCE_UNAVAILABLE` means
 * the lock could not be acquired or verified and the caller must fail closed.
 */
export async function acquireDaemonInstance(namespace: DaemonNamespace): Promise<DaemonInstanceLease> {
  return acquireFlockHolder({
    lockPath: join(namespace.dir, DAEMON_INSTANCE_LOCK_NAME),
    wait: "nonblock",
    readyMarker: DAEMON_INSTANCE_READY,
    subject: SUBJECT,
    failure,
  });
}
