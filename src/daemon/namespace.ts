/**
 * The daemon endpoint namespace (spec: durable-supervisor §4).
 *
 * `<dirname(realpath HERDR_SOCKET_PATH)>/herdr-tools-daemon/` is the single
 * owner-only directory every daemon artifact lives under: `daemon.sock`,
 * `daemon.json`, `intents/`, `claims/`, `transfers/`, `mailbox/`, and the
 * single-instance lock. Anchoring on the canonical socket path — the same
 * discipline as `resolveHandoffNamespace` — makes every host on one endpoint
 * compute the same namespace, and every directory in the path is proven
 * owner-only before it is trusted: a stranger-writable parent could swap the
 * namespace inode and split the trust domain mid-lease.
 */

import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertOwnerOnlyDirectory } from "../pane-write-lock.js";
import { resolveSocketPath } from "../supervision/socket.js";

export type DaemonNamespaceErrorCode = "DAEMON_NAMESPACE_UNAVAILABLE";

export class DaemonNamespaceError extends Error {
  constructor(readonly code: DaemonNamespaceErrorCode, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "DaemonNamespaceError";
  }
}

const failure = (message: string): DaemonNamespaceError => new DaemonNamespaceError("DAEMON_NAMESPACE_UNAVAILABLE", message);

/** Endpoint-private namespace every daemon host on one Herdr endpoint resolves. */
export interface DaemonNamespace {
  /** Owner-only directory holding this endpoint's daemon artifacts. */
  dir: string;
  /** Canonical endpoint identity the namespace derives from. */
  endpoint: string;
}

export const DAEMON_NAMESPACE_DIR_NAME = "herdr-tools-daemon";

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

/**
 * Resolve the daemon namespace for this host's Herdr endpoint. The socket path
 * is canonicalized so symlink-spelled endpoints still share one directory, and
 * both the parent and the namespace directory itself are proven owner-only on
 * every call. `runtimeDir` exists for tests; production callers omit it.
 */
export async function resolveDaemonNamespace(env: NodeJS.ProcessEnv = process.env, runtimeDir?: string): Promise<DaemonNamespace> {
  let socketPath: string;
  try {
    socketPath = resolveSocketPath(env);
  } catch {
    throw new DaemonNamespaceError("DAEMON_NAMESPACE_UNAVAILABLE", "Daemon endpoint is unavailable");
  }
  let endpoint: string;
  try {
    endpoint = await realpath(socketPath);
  } catch {
    throw new DaemonNamespaceError("DAEMON_NAMESPACE_UNAVAILABLE", "Daemon endpoint cannot be canonicalized");
  }
  const dir = runtimeDir ?? join(dirname(endpoint), DAEMON_NAMESPACE_DIR_NAME);
  try {
    assertOwnerOnlyDirectory(dirname(dir), await lstat(dirname(dir)), failure, "Daemon namespace");
  } catch (error) {
    if (error instanceof DaemonNamespaceError) throw error;
    throw new DaemonNamespaceError("DAEMON_NAMESPACE_UNAVAILABLE", "Daemon namespace directory is unavailable");
  }
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw new DaemonNamespaceError("DAEMON_NAMESPACE_UNAVAILABLE", "Daemon namespace directory is unavailable");
  }
  try {
    assertOwnerOnlyDirectory(dir, await lstat(dir), failure, "Daemon namespace");
  } catch (error) {
    if (error instanceof DaemonNamespaceError) throw error;
    throw new DaemonNamespaceError("DAEMON_NAMESPACE_UNAVAILABLE", "Daemon namespace directory is unavailable");
  }
  return { dir, endpoint };
}
