/**
 * The daemon entrypoint (spec: durable-supervisor §4, §9 D4).
 *
 * Startup: resolve the endpoint namespace (N1.1) → take the single-instance
 * lock → probe and bind `daemon.sock` under it (N1.2) → run the D3/D4 restart
 * sweep (`recoverInterrupted`, N1.3) → record `startedAt` and the first
 * `heartbeat` in `daemon.json` → heartbeat every 30 s.
 *
 * Shutdown (SIGTERM/SIGINT) runs the fixed §4 order — flush handoffs → stop
 * supervisors → record `lastStoppedAt` → close the server → release the
 * lock — with no Herdr write at any step: the seams receive no Herdr
 * channel. `flushHandoffs`/`stopSupervisors` are typed stubs until N2.x
 * binds the real runtime; the ordering is the contract this node fixes.
 */

import { randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createNodeExec } from "../mcp/host.js";
import { acquireDaemonInstance } from "./instance.js";
import { createIntentStore } from "./intents.js";
import { resolveHandoffNamespace } from "../handoff.js";
import { daemonRunOwnership, reattachDaemonRuns } from "./reattach.js";
import { parseSnapshotResult } from "../targets.js";
import { createDaemonJsonPort, createMailbox, type DaemonJsonPort, type Mailbox, type MailboxRunOwnership } from "./mailbox.js";
import { resolveDaemonNamespace, type DaemonNamespace } from "./namespace.js";
import { createDaemonRuntime, daemonDispatcher } from "./runtime.js";
import {
  startDaemonServer,
  type DaemonRequestHandler,
  type DaemonServer,
  type DaemonSocketProbe,
} from "./server.js";

export type DaemonMainErrorCode = "DAEMON_STATUS_UNAVAILABLE";

export class DaemonMainError extends Error {
  constructor(readonly code: DaemonMainErrorCode, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "DaemonMainError";
  }
}

/** The lifecycle record beside `daemon.sock` (spec §4). N2.x adds `capacity`, `unpersisted`, `pendingGap`. */
export interface DaemonStatusRecord {
  startedAt?: string;
  heartbeat?: string;
  lastStoppedAt?: string;
  [field: string]: unknown;
}

export const DAEMON_STATUS_NAME = "daemon.json";
export const DAEMON_HEARTBEAT_MS = 30_000;

/**
 * The N2.x runtime seams the shutdown order drains. Neither may write to the
 * Herdr endpoint: shutdown performs zero Herdr writes, so the seams take no
 * Herdr channel. Stubbed at this node — the ordering around them is real.
 */
export interface DaemonShutdownSeams {
  /** Flush pending handoff records to disk before supervisors stop. */
  flushHandoffs(): Promise<void>;
  /** Stop every bound supervisor after handoffs are flushed. */
  stopSupervisors(): Promise<void>;
}

const NO_SHUTDOWN_SEAMS: DaemonShutdownSeams = {
  flushHandoffs: async () => undefined,
  stopSupervisors: async () => undefined,
};

export interface DaemonMainOptions {
  env?: NodeJS.ProcessEnv;
  /** Pre-resolved namespace; defaults to `resolveDaemonNamespace(env)`. */
  namespace?: DaemonNamespace;
  /** Request handler surface; defaults to the N1.2 echo/version plumbing. */
  handler?: DaemonRequestHandler;
  /** Socket probe seam for tests; defaults to the real connect probe. */
  probe?: DaemonSocketProbe;
  /** The N2.x shutdown seams; inert stubs at this node. */
  seams?: DaemonShutdownSeams;
  /**
   * The §7 owner mailbox. Defaults to the namespace mailbox bound to this
   * daemon's serialized status queue — the same `daemon.json` writer the
   * heartbeat uses, so capacity/`unpersisted`/`pendingGap` patches and
   * lifecycle writes can never clobber each other.
   */
  mailbox?: Mailbox;
  /**
   * The run-flock ownership seam the default mailbox resolves destinations
   * through. Required for run-scoped event writes; tests injecting their own
   * mailbox need none.
   */
  ownership?: MailboxRunOwnership;
  /**
   * The D4 restart-reattach sweep (N2.3): runs once after `startedAt` lands and
   * the mailbox exists, before the heartbeat starts. A throw aborts startup —
   * a daemon that cannot classify its recorded children does not run.
   */
  reattach?: (context: { mailbox: Mailbox; startedAt: string; lastHeartbeat?: string }) => Promise<unknown>;
  heartbeatMs?: number;
  now?: () => Date;
  /** Diagnostic sink for lifecycle write failures and shutdown steps; defaults to stderr. */
  log?: (line: string) => void;
  /** Called once the daemon is bound and sweeping is done (sd_notify-style readiness). */
  onStarted?: (daemon: RunningDaemon) => void;
}

export interface RunningDaemon {
  /** The bound `daemon.sock` path inside the namespace. */
  socketPath: string;
  namespace: DaemonNamespace;
  /** The §7 owner mailbox; its `pendingGap` retries ride the heartbeat. */
  mailbox: Mailbox;
  /**
   * Run the fixed §4 shutdown order once: flush handoffs → stop supervisors →
   * record `lastStoppedAt` → close the server → release the instance lock.
   * A failed step is recorded and the order still runs to completion — a
   * stuck flush cannot strand the lock — then the first failure rejects.
   * Later calls return the same shutdown.
   */
  shutdown(): Promise<void>;
}

const failure = (message: string): DaemonMainError => new DaemonMainError("DAEMON_STATUS_UNAVAILABLE", message);

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Same-directory temp + fsync + rename + directory fsync, 0600 throughout — the D1 discipline. */
async function writeStatusAtomic(path: string, data: string): Promise<void> {
  const directory = dirname(path);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  /* c8 ignore next -- O_NOFOLLOW exists on every platform that ships flock. */
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(temporary, flags, 0o600);
  } catch {
    throw failure("Daemon status record could not be staged");
  }
  try {
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
  } catch {
    /* c8 ignore start -- a write/sync/close failure on an open handle is an fs fault tests cannot force. */
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw failure("Daemon status record could not be written");
    /* c8 ignore stop */
  }
  try {
    await rename(temporary, path);
  } catch {
    /* c8 ignore start -- a rename failure after a successful stage is an fs fault tests cannot force. */
    await rm(temporary, { force: true }).catch(() => undefined);
    throw failure("Daemon status record could not be committed");
    /* c8 ignore stop */
  }
  let dirHandle;
  try {
    dirHandle = await open(directory, constants.O_RDONLY);
    await dirHandle.sync();
    /* c8 ignore start -- a directory open/sync fault after a committed rename is not forceable in tests. */
  } catch {
    throw failure("Daemon status directory could not be synced");
  } finally {
    await dirHandle?.close().catch(() => undefined);
    /* c8 ignore stop */
  }
}

/**
 * Read-merge-write `daemon.json`: lifecycle fields land on top of whatever a
 * prior write recorded, so fields this node does not own (N2.x `capacity`,
 * `unpersisted`, `pendingGap`) survive every heartbeat. A malformed record is
 * quarantined to `daemon.json.malformed` rather than clobbered or allowed to
 * block every restart: `Restart=on-failure` must not loop on a corrupt file.
 */
async function writeDaemonStatus(dir: string, patch: DaemonStatusRecord): Promise<void> {
  const path = join(dir, DAEMON_STATUS_NAME);
  let existing: Record<string, unknown> = {};
  let text: string | undefined;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw failure("Daemon status record is unavailable");
  }
  if (text !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (isRecord(parsed)) {
      existing = parsed;
    } else {
      try {
        await rename(path, `${path}.malformed`);
      } catch {
        throw failure("Daemon status record is malformed and cannot be preserved");
      }
    }
  }
  await writeStatusAtomic(path, JSON.stringify({ ...existing, ...patch }));
}

/**
 * Start the daemon for one endpoint namespace. Startup refuses — with the
 * lock released and nothing bound — when the instance is held, the socket
 * probe or bind fails, the restart sweep cannot complete, or the first
 * lifecycle write fails: a daemon that cannot prove its own startup state
 * does not run.
 */
export async function startDaemon(options: DaemonMainOptions = {}): Promise<RunningDaemon> {
  const now = () => (options.now ?? (() => new Date()))().toISOString();
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const seams = options.seams ?? NO_SHUTDOWN_SEAMS;
  const namespace = options.namespace ?? (await resolveDaemonNamespace(options.env ?? process.env));
  const lease = await acquireDaemonInstance(namespace);

  let server: DaemonServer;
  try {
    server = await startDaemonServer({ namespace, lease, handler: options.handler, probe: options.probe });
  } catch (error) {
    await lease.release().catch(() => undefined);
    throw error;
  }
  const teardown = async (): Promise<void> => {
    /* c8 ignore next -- close() only rejects on a listener fault tests cannot force. */
    await server.close().catch(() => undefined);
    await lease.release().catch(() => undefined);
  };

  // The D4 sweep hook (N1.3): every `effecting` record the last run left is
  // `unresolved(interrupted)` before this start is declared — a live effect
  // is only ever one this process owns.
  try {
    await createIntentStore({ namespace }).recoverInterrupted();
  } catch (error) {
    await teardown();
    throw error;
  }

  // Status writes serialize so a queued heartbeat can never land after
  // `lastStoppedAt`; the merge keeps sibling fields the writer does not own.
  let statusQueue: Promise<void> = Promise.resolve();
  const writeStatus = (patch: DaemonStatusRecord): Promise<void> => {
    const next = statusQueue.then(() => writeDaemonStatus(namespace.dir, patch));
    statusQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  // The prior record's heartbeat is the downtime gap's `from` — captured before
  // this start's lifecycle write replaces it; a missing/corrupt one quarantines
  // inside the merge and the gap degenerates to a zero-width interval.
  const priorHeartbeat = await createDaemonJsonPort(namespace.dir).read()
    .then((prior) => (typeof prior.heartbeat === "string" ? prior.heartbeat : undefined))
    .catch(() => undefined);

  let startedAt: string;
  try {
    startedAt = now();
    await writeStatus({ startedAt, heartbeat: startedAt });
  } catch (error) {
    await teardown();
    throw error;
  }

  // The §7 mailbox shares the serialized status queue: its `unpersisted`/
  // `pendingGap`/`capacity` patches merge through the same writer the
  // heartbeat and lifecycle use, so no read-merge-write can drop a sibling.
  const status: DaemonJsonPort = {
    ...createDaemonJsonPort(namespace.dir),
    write: (patch) => writeStatus(patch as DaemonStatusRecord),
  };
  const mailbox = options.mailbox ?? createMailbox({ namespace, status, ...(options.ownership === undefined ? {} : { ownership: options.ownership }) });

  // The D4 reattach sweep rides this start: classify every recorded child of
  // every `awaiting_handoff`/`recovery_pending` run, reattach the exact
  // matches, and land one `downtime_gap` per affected mailbox before the
  // heartbeat cadence begins.
  if (options.reattach !== undefined) {
    try {
      await options.reattach({ mailbox, startedAt, ...(priorHeartbeat === undefined ? {} : { lastHeartbeat: priorHeartbeat }) });
    } catch (error) {
      await teardown();
      throw error;
    }
  }

  const heartbeat = setInterval(() => {
    // Promise.resolve().then keeps a synchronous now() throw inside the same
    // catch as an async write failure — a bad tick must never kill the loop.
    Promise.resolve()
      .then(() => writeStatus({ heartbeat: now() }))
      // §7: every held `pendingGap` is rechecked each heartbeat and lands once
      // its mailbox has room; the record clears only when durably written.
      .then(() => mailbox.retryPendingGaps())
      .catch((error: unknown) => {
        log(`herdr-tools-daemon heartbeat write failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  }, options.heartbeatMs ?? DAEMON_HEARTBEAT_MS);
  heartbeat.unref();

  let stopping: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    stopping ??= (async () => {
      // Stop the cadence first so no heartbeat can land after `lastStoppedAt`.
      clearInterval(heartbeat);
      const steps: Array<[string, () => Promise<void>]> = [
        ["flushHandoffs", seams.flushHandoffs],
        ["stopSupervisors", seams.stopSupervisors],
        ["recordStoppedAt", () => writeStatus({ lastStoppedAt: now() })],
        ["closeServer", () => server.close()],
        ["releaseLock", () => lease.release()],
      ];
      const failures: unknown[] = [];
      for (const [name, step] of steps) {
        // The journal line doubles as the durable record of the fixed order.
        log(`herdr-tools-daemon shutdown step: ${name}`);
        try {
          await step();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) throw failures[0];
    })();
    return stopping;
  };

  return { socketPath: server.socketPath, namespace, mailbox, shutdown };
}

/**
 * The process entrypoint: signal handlers arm before startup so a SIGTERM
 * delivered mid-start still shuts the finished daemon down in order. Exit 0
 * is a clean signal shutdown; exit 1 is any startup refusal or an incomplete
 * shutdown — `Restart=on-failure` sees both as a failed run, never a stop.
 */
export async function runDaemonMain(options: DaemonMainOptions = {}): Promise<number> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  let wake!: (signal: "SIGTERM" | "SIGINT") => void;
  const signaled = new Promise<"SIGTERM" | "SIGINT">((resolve) => {
    wake = resolve;
  });
  const onTerm = () => wake("SIGTERM");
  const onInt = () => wake("SIGINT");
  process.once("SIGTERM", onTerm);
  process.once("SIGINT", onInt);
  const disarm = () => {
    process.removeListener("SIGTERM", onTerm);
    process.removeListener("SIGINT", onInt);
  };

  let daemon: RunningDaemon;
  try {
    daemon = await startDaemon(options);
  } catch (error) {
    disarm();
    log(`herdr-tools-daemon startup failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  log(`herdr-tools-daemon listening on ${daemon.socketPath}`);
  options.onStarted?.(daemon);
  const signal = await signaled;
  disarm();
  log(`herdr-tools-daemon received ${signal}; shutting down`);
  try {
    await daemon.shutdown();
  } catch (error) {
    log(`herdr-tools-daemon shutdown incomplete: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  return 0;
}

/* c8 ignore start -- the emitted entrypoint fires only under `node dist/src/daemon/main.js`, never under vitest. */
if (process.argv[1] !== undefined) {
  let invoked = false;
  try {
    invoked = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    invoked = false;
  }
  if (invoked) {
    // The production daemon serves the N2.1 request surface: the shared
    // runtime's dispatcher, the D4 reattach sweep over the endpoint's run
    // namespace, and a shutdown seam that drains live supervisors.
    // Injected handlers (tests) keep the N1.2 echo/version plumbing.
    resolveDaemonNamespace(process.env)
      .then(async (namespace) => {
        const env = process.env;
        const runtime = createDaemonRuntime({
          exec: createNodeExec({ cwd: process.cwd() }),
          env,
          namespace,
          // §11 (N5.2): the C9 canary proved pi, claude, and devin owners
          // consume the idle hint as a real turn, so the stock qualified set
          // is these three. `agy` stays hard-blocked inside hints.ts no
          // matter what this set contains. A code default only — the N5.3
          // owner gate still controls activation.
          hintKinds: ["pi", "claude", "devin"],
        });
        const runs = await resolveHandoffNamespace(env);
        const signal = new AbortController().signal;
        return runDaemonMain({
          namespace,
          handler: daemonDispatcher(runtime),
          ownership: daemonRunOwnership(runtime.allocator),
          reattach: ({ mailbox, startedAt, lastHeartbeat }) => {
            // The runtime's §8 ownership and §11 hint ops resolve the mailbox
            // lazily — the serialized status queue exists only now.
            runtime.bindMailbox(mailbox);
            return reattachDaemonRuns({
              namespace,
              runs,
              allocator: runtime.allocator,
              intents: runtime.intents,
              supervision: runtime.supervision,
              jobs: runtime.jobs,
              mailbox,
              snapshot: async () => parseSnapshotResult((await runtime.cli.runJson(["api", "snapshot"], signal)).result),
              startedAt,
              lastHeartbeat,
              log: (line) => process.stderr.write(`${line}\n`),
            });
          },
          seams: { flushHandoffs: async () => undefined, stopSupervisors: () => runtime.supervision.shutdown() },
        });
      })
      .then(
        (code) => {
          process.exitCode = code;
        },
        () => {
          process.exitCode = 1;
        },
      );
  }
}
/* c8 ignore stop */
