/**
 * Cross-process exclusion for Devin composer writes and flush key proofs.
 *
 * A delayed Enter into Devin's composer is only defensible while no other
 * participating process is mid-write or mid-proof. The socket exposes no such
 * primitive, so cooperating hosts serialize those short sections on a native
 * `flock` holder keyed by the canonical Herdr endpoint and pane id. This is a
 * cooperative boundary only: raw `herdr` CLI clients and human input never
 * take the lock, and nothing here serializes them.
 *
 * Beside each lock lives a spent-proof fence — the one cross-process fact the
 * in-memory coordinator cannot hold: which identity-bound composer frames
 * already earned a key. Only bounded digests are stored, never pane text.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveSocketPath } from "./supervision/socket.js";

export class PaneWriteLockError extends Error {
  readonly code = "PANE_WRITE_LOCK_UNAVAILABLE";

  constructor(message = "Pane write lock is unavailable") {
    super(message);
    this.name = "PaneWriteLockError";
  }
}

const paneWriteFailure = (message: string): PaneWriteLockError => new PaneWriteLockError(message);

/** One held native flock: liveness and lock-path trust re-checks, then release. */
export interface FlockHolderLease {
  check(): Promise<void>;
  release(): Promise<void>;
}

export interface FlockHolderOptions {
  lockPath: string;
  /** Defaults to "exclusive"; the launch gate deliberately shares its lock. */
  mode?: "exclusive" | "shared";
  /**
   * Contention behavior inside the holder: "nonblock" refuses at once, "wait"
   * blocks until the ready-marker deadline, and `{ timeoutMs }` bounds flock's
   * own wait so a held section cannot stall an acquirer forever.
   */
  wait?: "nonblock" | "wait" | { timeoutMs: number };
  /** Bound on the holder printing its ready marker; defaults cover the wait. */
  deadlineMs?: number;
  /**
   * The marker line the holder prints once it owns the lock. It is interpolated
   * into the holder's shell command, so it must always be a fixed constant —
   * never untrusted text.
   */
  readyMarker: string;
  /** Message subject, e.g. "Launch gate" or "Pane write lock". */
  subject: string;
  /** Typed failure factory so each facility keeps its own error shape. */
  failure(message: string): Error;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function uid(failure: (message: string) => Error, subject: string): number {
  const value = process.getuid?.();
  /* c8 ignore next -- flock only exists on platforms that provide getuid. */
  if (value === undefined) throw failure(`${subject} owner is unavailable`);
  return value;
}

export function assertOwnerOnlyDirectory(path: string, value: Awaited<ReturnType<typeof lstat>>, failure: (message: string) => Error, subject: string): void {
  const mode = Number(value.mode);
  if (!value.isDirectory() || value.isSymbolicLink() || value.uid !== uid(failure, subject) || (mode & 0o22) !== 0) {
    throw failure(`${subject} directory is not trusted: ${path}`);
  }
}

async function assertLockPath(lockPath: string, failure: (message: string) => Error, subject: string): Promise<void> {
  let parent;
  try {
    parent = await lstat(dirname(lockPath));
  } catch {
    throw failure(`${subject} directory is unavailable`);
  }
  assertOwnerOnlyDirectory(dirname(lockPath), parent, failure, subject);

  let value;
  try {
    value = await lstat(lockPath);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw failure(`${subject} lock is indeterminate`);
  }
  if (value !== undefined && (!value.isFile() || value.isSymbolicLink() || value.uid !== uid(failure, subject) || (Number(value.mode) & 0o22) !== 0)) {
    throw failure(`${subject} lock is not trusted`);
  }
}

interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function exitResult(child: ChildProcessWithoutNullStreams): Promise<ExitResult> {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function assertHolderAlive(child: ChildProcessWithoutNullStreams, holderExited: boolean, failure: (message: string) => Error, subject: string): void {
  if (holderExited || child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
    throw failure(`${subject} holder is not live`);
  }
  try {
    process.kill(child.pid, 0);
  } catch {
    throw failure(`${subject} holder is not live`);
  }
}

async function stop(child: ChildProcessWithoutNullStreams, exit: Promise<ExitResult>): Promise<void> {
  child.kill("SIGKILL");
  await Promise.race([
    exit,
    new Promise<void>((resolve) => setTimeout(resolve, 100)),
  ]);
}

async function ensureLockPath(lockPath: string, failure: (message: string) => Error, subject: string): Promise<void> {
  /* c8 ignore next -- O_NOFOLLOW exists on every platform that ships flock. */
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);
  try {
    const handle = await open(lockPath, flags, 0o600);
    await handle.close();
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw failure(`${subject} lock is unavailable`);
  }
  await assertLockPath(lockPath, failure, subject);
}

/**
 * Spawn a native `flock` helper that owns `lockPath` while its stdin stays
 * open. The lease never removes or recreates the lock inode: an active flock
 * survives on the file description, and unlinking it would split the exclusion
 * domain. Every rejection site already produces the caller's typed failure, so
 * errors propagate unchanged.
 */
export async function acquireFlockHolder(options: FlockHolderOptions): Promise<FlockHolderLease> {
  const { lockPath, subject, failure } = options;
  const waitArgs = options.wait === "wait"
    ? []
    : typeof options.wait === "object"
      ? ["--timeout", String(options.wait.timeoutMs / 1000)]
      : ["--nonblock"];
  const waitBoundMs = typeof options.wait === "object" ? options.wait.timeoutMs : 0;
  const deadlineMs = options.deadlineMs ?? Math.max(1_000, waitBoundMs + 2_000);
  await ensureLockPath(lockPath, failure, subject);

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn("flock", [options.mode === "shared" ? "--shared" : "--exclusive", ...waitArgs, lockPath, "--command", `printf '${options.readyMarker}\\n'; cat`], {
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    /* c8 ignore next -- spawn reports a missing binary through the error event, not a synchronous throw. */
    throw failure(`${subject} lock could not be started`);
  }
  const exit = exitResult(child);
  let holderExited = false;
  void exit.then(() => { holderExited = true; });
  const acquisition = new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(failure(`${subject} lock was unavailable`)), deadlineMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.includes(`${options.readyMarker}\n`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(failure(`${subject} lock is indeterminate`));
    });
    child.once("exit", (code) => {
      if (!output.includes(`${options.readyMarker}\n`)) {
        clearTimeout(timer);
        reject(code === 1 ? failure(`${subject} lock was unavailable`) : failure(`${subject} lock is indeterminate`));
      }
    });
  });

  try {
    await acquisition;
    assertHolderAlive(child, holderExited, failure, subject);
    await assertLockPath(lockPath, failure, subject);
  } catch (error) {
    await stop(child, exit);
    throw error;
  }

  let released = false;
  return {
    async check(): Promise<void> {
      assertHolderAlive(child, holderExited, failure, subject);
      await assertLockPath(lockPath, failure, subject);
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        await assertLockPath(lockPath, failure, subject);
      } catch (error) {
        // A release that fails before stdin closes must still reap the holder:
        // the child keeps the flock alive on its own file description.
        await stop(child, exit);
        throw error;
      }
      child.stdin.end();
      const result = await Promise.race([exit, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 100))]);
      if (result === undefined) {
        // A wedged holder cannot hang release: kill it and reap, bounded.
        await stop(child, exit);
        throw failure(`${subject} release is indeterminate`);
      }
      if (result.code !== 0 || result.signal !== null) throw failure(`${subject} release is indeterminate`);
      await assertLockPath(lockPath, failure, subject);
    },
  };
}

/**
 * The shared namespace every package process on one Herdr endpoint resolves.
 * Anchoring the directory on the canonical socket path — not on per-process
 * environment or checkout location — is what makes two hosts compute the same
 * lock file for the same pane; when no common namespace exists the caller
 * must fail closed rather than fall back to a weaker domain.
 */
export interface PaneWriteNamespace {
  /** Owner-only directory holding this endpoint's lock and fence files. */
  dir: string;
  /** Canonical endpoint identity the lock key derives from. */
  endpoint: string;
}

export const PANE_WRITE_LOCK_DIR_NAME = "herdr-pane-locks";

/**
 * Resolve the common namespace for this host's Herdr endpoint. The socket path
 * is canonicalized so symlink-spelled endpoints still share one directory, and
 * every directory in the new path is proven owner-only: a stranger-writable
 * parent could swap the lock directory's inode and split the domain mid-lease.
 * `runtimeDir` exists for tests; production callers omit it.
 */
export async function resolvePaneWriteNamespace(env: NodeJS.ProcessEnv = process.env, runtimeDir?: string): Promise<PaneWriteNamespace> {
  let socketPath: string;
  try {
    socketPath = resolveSocketPath(env);
  } catch {
    throw new PaneWriteLockError("Pane write lock endpoint is unavailable");
  }
  let endpoint: string;
  try {
    endpoint = await realpath(socketPath);
  } catch {
    throw new PaneWriteLockError("Pane write lock endpoint cannot be canonicalized");
  }
  const dir = runtimeDir ?? join(dirname(endpoint), PANE_WRITE_LOCK_DIR_NAME);
  try {
    assertOwnerOnlyDirectory(dirname(dir), await lstat(dirname(dir)), paneWriteFailure, "Pane write lock");
  } catch (error) {
    if (error instanceof PaneWriteLockError) throw error;
    throw new PaneWriteLockError("Pane write lock directory is unavailable");
  }
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw new PaneWriteLockError("Pane write lock directory is unavailable");
  }
  try {
    assertOwnerOnlyDirectory(dir, await lstat(dir), paneWriteFailure, "Pane write lock");
  } catch (error) {
    if (error instanceof PaneWriteLockError) throw error;
    throw new PaneWriteLockError("Pane write lock directory is unavailable");
  }
  return { dir, endpoint };
}

/** Hash routing identifiers into stable filenames; message bodies and session values never appear. */
export function paneWritePaths(namespace: PaneWriteNamespace, paneId: string): { lockPath: string; fencePath: string } {
  const key = createHash("sha256").update(namespace.endpoint).update("\0").update(paneId).digest("hex");
  return { lockPath: join(namespace.dir, `${key}.lock`), fencePath: join(namespace.dir, `${key}.fence`) };
}

/** Bound on flock's own contention wait for one pane-write section. */
export const PANE_WRITE_LOCK_WAIT_MS = 5_000;
/** A fence remembers at most this many spent frames per identity — an availability ceiling, never text. */
export const PANE_WRITE_FENCE_MAX_SPENT = 32;
const PANE_WRITE_READY = "HERDR_PANE_WRITE_LOCK_READY";
const DIGEST_HEX = /^[0-9a-f]{64}$/;

interface FenceContent {
  v: 1;
  /** sha256 over the occupant's full prompt-target identity; "" = never written. */
  identity: string;
  /** sha256 digests of composer interiors that already earned a key. */
  spent: string[];
}

function isFenceContent(value: unknown): value is FenceContent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as { v?: unknown; identity?: unknown; spent?: unknown };
  if (candidate.v !== 1 || typeof candidate.identity !== "string" || !Array.isArray(candidate.spent)) return false;
  if ((candidate.identity !== "" && !DIGEST_HEX.test(candidate.identity)) || candidate.spent.length > PANE_WRITE_FENCE_MAX_SPENT) return false;
  return candidate.spent.every((entry) => typeof entry === "string" && DIGEST_HEX.test(entry));
}

async function readFence(fencePath: string): Promise<FenceContent> {
  let value;
  try {
    value = await lstat(fencePath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { v: 1, identity: "", spent: [] };
    throw new PaneWriteLockError("Pane write lock fence is indeterminate");
  }
  if (!value.isFile() || value.isSymbolicLink() || value.uid !== uid(paneWriteFailure, "Pane write lock") || (Number(value.mode) & 0o22) !== 0) {
    throw new PaneWriteLockError("Pane write lock fence is not trusted");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(fencePath, "utf8"));
  } catch {
    throw new PaneWriteLockError("Pane write lock fence is malformed");
  }
  if (!isFenceContent(parsed)) throw new PaneWriteLockError("Pane write lock fence is malformed");
  return parsed;
}

async function writeFence(fencePath: string, content: FenceContent): Promise<void> {
  let value;
  try {
    value = await lstat(fencePath);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw new PaneWriteLockError("Pane write lock fence is indeterminate");
  }
  if (value !== undefined && (!value.isFile() || value.isSymbolicLink() || value.uid !== uid(paneWriteFailure, "Pane write lock") || (Number(value.mode) & 0o22) !== 0)) {
    throw new PaneWriteLockError("Pane write lock fence is not trusted");
  }
  /* c8 ignore next -- O_NOFOLLOW exists on every platform that ships flock. */
  const flags = constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(fencePath, flags, 0o600);
  } catch {
    throw new PaneWriteLockError("Pane write lock fence is unavailable");
  }
  try {
    await handle.writeFile(JSON.stringify(content));
  } finally {
    await handle.close();
  }
}

/**
 * ponytail: this fence is duplicate-key suppression, not a durable queue. Its
 * deliberate availability ceiling is that repeated real queues can render an
 * identical placeholder-only interior — with no drained frame observed since,
 * those frames must be refused conservatively even though the queue is real.
 * Do not widen the parser to hide that limit. The correct upgrade is a native
 * input-generation / conditional-drain primitive inside Devin's composer, and
 * the durable fix is tracked upstream against herdr's devin integration.
 *
 * Every operation re-reads and re-validates the file under the held lock, so
 * corruption or unsafe cleanup fails closed — a malformed or unwritable fence
 * means no key, never a permissive fallback.
 */
export interface PaneWriteFence {
  /** True when this exact identity already spent this exact frame. */
  isSpent(identity: string, frame: string): Promise<boolean>;
  /** Persist the frame as spent before the key is dispatched; failure refuses the key. */
  record(identity: string, frame: string): Promise<void>;
  /**
   * Reset the spent set for this identity. Callers may invoke this only after
   * a fresh identity-bound positively parsed non-queued composer — never on
   * elapsed time, a new ack, a parse failure, or a missing record.
   */
  rearm(identity: string): Promise<void>;
}

export interface PaneWriteLease extends FlockHolderLease {
  /** The spent-frame fence bound to the same endpoint+pane key. */
  readonly fence: PaneWriteFence;
}

export interface PaneWriteAcquireOptions {
  /** Bound on flock's own contention wait (default {@link PANE_WRITE_LOCK_WAIT_MS}). */
  waitMs?: number;
  /** Bound on the holder's ready marker; defaults to waitMs plus spawn margin. */
  deadlineMs?: number;
}

/** The short exclusive section serializing one pane's text writes against flush proofs/keys. */
export interface PaneWriteGuard {
  acquire(paneId: string, options?: PaneWriteAcquireOptions): Promise<PaneWriteLease>;
}

/**
 * Create the guard for one host. The namespace is resolved lazily on first
 * acquisition and cached on success; a failure is not cached, so a host whose
 * endpoint becomes reachable later is not permanently refused.
 */
export function createPaneWriteGuard(options: {
  namespace: PaneWriteNamespace | (() => Promise<PaneWriteNamespace>);
}): PaneWriteGuard {
  let resolved: Promise<PaneWriteNamespace> | undefined;
  const namespace = (): Promise<PaneWriteNamespace> => {
    resolved ??= Promise.resolve(typeof options.namespace === "function" ? options.namespace() : options.namespace)
      .catch((error: unknown) => {
        resolved = undefined;
        throw error instanceof PaneWriteLockError ? error : new PaneWriteLockError("Pane write lock namespace is unavailable");
      });
    return resolved;
  };
  return {
    async acquire(paneId, acquireOptions) {
      const paths = paneWritePaths(await namespace(), paneId);
      const holder = await acquireFlockHolder({
        lockPath: paths.lockPath,
        wait: { timeoutMs: acquireOptions?.waitMs ?? PANE_WRITE_LOCK_WAIT_MS },
        ...(acquireOptions?.deadlineMs === undefined ? {} : { deadlineMs: acquireOptions.deadlineMs }),
        readyMarker: PANE_WRITE_READY,
        subject: "Pane write lock",
        failure: paneWriteFailure,
      });
      return {
        check: () => holder.check(),
        // A failed release cannot recall what the section already did, so the
        // lease settles quietly; the kernel frees the flock when the holder dies.
        release: async () => { await holder.release().catch(() => undefined); },
        fence: {
          isSpent: async (identity, frame) => {
            const content = await readFence(paths.fencePath);
            return content.identity === identity && content.spent.includes(frame);
          },
          record: async (identity, frame) => {
            const content = await readFence(paths.fencePath);
            const current = content.identity === identity ? content : { v: 1 as const, identity, spent: [] as string[] };
            if (!current.spent.includes(frame)) {
              if (current.spent.length >= PANE_WRITE_FENCE_MAX_SPENT) {
                throw new PaneWriteLockError("Pane write lock fence is full");
              }
              current.spent.push(frame);
            }
            await writeFence(paths.fencePath, current);
          },
          rearm: async (identity) => {
            await writeFence(paths.fencePath, { v: 1, identity, spent: [] });
          },
        },
      };
    },
  };
}
