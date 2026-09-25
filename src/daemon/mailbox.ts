/**
 * The owner-only filesystem mailbox (spec: durable-supervisor §7).
 *
 * One mailbox per manager native session at
 * `mailbox/<managerSessionKey>/{unread,acked}/<eventId>.json` inside the
 * owner-only daemon namespace: directories 0700, files 0600, and an owner-only
 * assertion on every open. `eventId` = `<ISO-8601 UTC ms, colons
 * removed>-<randomUUID>` — sortable by time, no durable counter.
 *
 * Writes are the §7 no-clobber discipline: same-directory temp file, fsync,
 * `link(temp, final)` — which fails `EEXIST` rather than silently replacing —
 * then unlink the temp and fsync the directory. A collision is refused, never
 * overwritten, and reported `persistenceFailed` with the existing file left
 * byte-identical. Every run-scoped write resolves its destination from the
 * run's **current** owner — never the owner recorded at supervisor bind — and
 * completes while holding the run flock (`MailboxRunOwnership` seam; N2.4's
 * ownership.ts supplies the lookup).
 *
 * Capacity is a hard bound on event writes, never eviction: per-manager
 * `unread/` 500 files or 8 MiB, global 5 000 `unread/` files, both counted at
 * write time under the fixed flock order — the short global mailbox-index
 * flock first, then the destination mailbox flock (multi-mailbox sections
 * take mailbox flocks in `managerSessionKey` order after the index flock) — so
 * admission is atomic with the `link` and racing writers cannot overshoot.
 * `acked/` counts toward neither cap; it is bounded by the 1 000-record
 * retention each ack enforces. Files moved by `transfer`/`claim` are not
 * exempt: the move always completes, and the moved files count toward the
 * destination's caps, so an over-cap successor refuses later writes until it
 * drains.
 *
 * At cap there is no eviction and no spool: the write is refused as
 * `persistenceFailed`, `daemon.json.unpersisted[<key>]` accounts the loss
 * durably ({count, firstAt, lastAt}), and `daemon.json.capacity` is
 * `"degraded"`; new launches refuse `MAILBOX_CAPACITY` via
 * `checkLaunchCapacity` while existing supervision continues. A refused
 * `downtime_gap` — the disclosure of that very loss — is held in
 * `daemon.json.pendingGap[<key>]` and retried after room (`retryPendingGaps`,
 * rechecked on every heartbeat), cleared only once durably written. Payloads
 * refused at cap are unrecoverable: a failed persist is never claimed as
 * persisted.
 */

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { acquireFlockHolder, assertOwnerOnlyDirectory, type FlockHolderLease } from "../pane-write-lock.js";
import { modelSafeJson } from "../redaction.js";
import type { DaemonNamespace } from "./namespace.js";

/** Per-manager `unread/` file cap (spec §7). */
export const MAILBOX_UNREAD_MAX_FILES = 500;
/** Per-manager `unread/` byte cap (spec §7). */
export const MAILBOX_UNREAD_MAX_BYTES = 8 * 1024 * 1024;
/** Global `unread/` file cap summed across all mailboxes (spec §7). */
export const MAILBOX_GLOBAL_UNREAD_MAX_FILES = 5_000;
/** `acked/` retention: each ack prunes to the newest 1 000 handled records (spec §7). */
export const MAILBOX_ACKED_RETAINED_FILES = 1_000;
/** Event body bound (spec §7). */
export const MAILBOX_EVENT_MAX_BYTES = 32 * 1024;
/** `decision.evidenceExcerpt` bound (spec §7). */
export const MAILBOX_DECISION_EXCERPT_MAX_BYTES = 8 * 1024;

export const DAEMON_MAILBOX_DIR_NAME = "mailbox";
const MAILBOX_INDEX_LOCK_NAME = "index.lock";
const MAILBOX_LOCK_NAME = "mailbox.lock";
const MAILBOX_INDEX_READY = "HERDR_MAILBOX_INDEX_READY";
const MAILBOX_READY = "HERDR_MAILBOX_READY";
const MAILBOX_LOCK_WAIT_MS = 5_000;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const EVENT_ID = /^\d{4}-\d{2}-\d{2}T\d{6}\.\d{3}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type DaemonMailboxErrorCode =
  | "MAILBOX_UNAVAILABLE"
  | "MAILBOX_EVENT_INVALID"
  | "MAILBOX_EVENT_NOT_FOUND";

export class DaemonMailboxError extends Error {
  constructor(readonly code: DaemonMailboxErrorCode, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "DaemonMailboxError";
  }
}

const failure = (message: string): DaemonMailboxError => new DaemonMailboxError("MAILBOX_UNAVAILABLE", message);
const invalid = (message: string): DaemonMailboxError => new DaemonMailboxError("MAILBOX_EVENT_INVALID", message);

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One bounded text form for a logged failure: message when it has one, raw form otherwise. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\0]/u.test(value);
}

/** The durable per-mailbox loss accounting (`daemon.json.unpersisted[<key>]`). */
export interface MailboxUnpersistedAccount {
  count: number;
  firstAt: string;
  lastAt: string;
}

/** The exact bounded child identity a run-scoped event reports. */
export interface MailboxChildIdentity {
  agentName: string;
  agentKind: string;
  paneId: string;
  terminalId?: string;
}

/** The bounded decision evidence carried on run-scoped events. */
export interface MailboxDecision {
  verdict: string;
  labels: string[];
  /** Digest of the reviewed evidence; empty when the review recorded no digest. */
  evidenceDigest: string;
  evidenceExcerpt?: string;
  /** The reviewer model, or `"paused"` while reviews are paused (D5). */
  reviewerModel: string;
}

export interface MailboxHandoff {
  state: string;
  artifactSha256?: string;
}

/** The run-scoped event body (spec §7). */
export interface MailboxRunEvent {
  id: string;
  at: string;
  kind: string;
  runId: string;
  jobId: string;
  childIdentity?: MailboxChildIdentity;
  decision?: MailboxDecision;
  handoff?: MailboxHandoff;
  actions: string[];
}

/** The mailbox-global `downtime_gap` body: no `runId`/`jobId` (spec §7/§9). */
export interface MailboxGapEvent {
  id: string;
  at: string;
  kind: "downtime_gap";
  from: string;
  to: string;
  lost: Record<string, MailboxUnpersistedAccount>;
}

export type MailboxEvent = MailboxRunEvent | MailboxGapEvent;

/** Caller fields of a run-scoped event; `id` is minted unless a journaled replay supplies one. */
export interface MailboxRunEventInput {
  kind: string;
  runId: string;
  jobId: string;
  childIdentity?: MailboxChildIdentity;
  decision?: MailboxDecision;
  handoff?: MailboxHandoff;
  actions?: string[];
  /** Pre-minted event ID for journaled replays (N2.4); omitted mints a fresh one. */
  id?: string;
}

/** Caller fields of a `downtime_gap` event; `id`/`at` persist across `pendingGap` retries. */
export interface MailboxGapEventInput {
  from: string;
  to: string;
  lost: Record<string, MailboxUnpersistedAccount>;
  id?: string;
  at?: string;
}

export type MailboxWriteFailureReason = "capacity" | "collision" | "unavailable";

export type MailboxWriteResult =
  | { persisted: true; eventId: string; path: string }
  /**
   * The persist failed and is never claimed as persisted. `pendingGap` is set
   * only when the event was durably held in `daemon.json.pendingGap` for
   * retry; every other refused payload is unrecoverable and accounted in
   * `daemon.json.unpersisted`.
   */
  | { persisted: false; persistenceFailed: true; eventId: string; reason: MailboxWriteFailureReason; at: string; pendingGap?: true };

export type MailboxCapacityVerdict =
  | { ok: true }
  | { ok: false; code: "MAILBOX_CAPACITY"; at: string };

/** Per-file outcome of a journaled `transfer`/`claim` move (N2.4). */
export interface MailboxMoveOutcome {
  moved: string[];
  alreadyAtDestination: string[];
  /** Absent from source and destination — recorded in the durable loss accounting, never silently skipped. */
  lost: string[];
}

/** What `herdr_status` projects: the `daemon.json` degradation fields. */
export interface MailboxDegradation {
  capacity: "ok" | "degraded";
  unpersisted: Record<string, MailboxUnpersistedAccount>;
  pendingGap: Record<string, MailboxGapEvent>;
}

/** The run-flock ownership seam N2.4's `ownership.ts` supplies. */
export interface MailboxRunOwnership {
  /** The run's CURRENT owner `managerSessionKey`, resolved under the run flock. */
  ownerOfRun(runId: string): Promise<string>;
  /** The run-flock section every event write resolves and completes inside. */
  withRunFlock?<T>(runId: string, section: () => Promise<T>): Promise<T>;
}

/** The writer seam supervisor events and `JobRegistry` terminals route through. */
export interface MailboxEventWriter {
  writeRunEvent(input: MailboxRunEventInput): Promise<MailboxWriteResult>;
}

/** The `daemon.json` read-merge-write port; `main.ts` binds it to its serialized status queue. */
export interface DaemonJsonPort {
  read(): Promise<Record<string, unknown>>;
  write(patch: Record<string, unknown>): Promise<void>;
}

/** Operations valid only inside withMailboxes; no nested flock acquisition. */
export interface LockedMailboxes {
  list(key: string): Promise<string[]>;
  read(key: string, eventId: string): Promise<MailboxEvent>;
  moveUnread(from: string, to: string, eventIds: string[]): Promise<MailboxMoveOutcome>;
  writeRecordedEvent(key: string, event: MailboxRunEvent): Promise<MailboxWriteResult>;
}

export interface Mailbox extends MailboxEventWriter {
  withMailboxes<T>(keys: string[], section: (locked: LockedMailboxes) => Promise<T>): Promise<T>;
  /** Mailbox-global `downtime_gap`; a cap refusal is held in `daemon.json.pendingGap` for retry. */
  writeGapEvent(key: string, gap: MailboxGapEventInput): Promise<MailboxWriteResult>;
  /** Retry every held `pendingGap` after room; cleared only once durably written. */
  retryPendingGaps(): Promise<void>;
  /** The launch-handler check: refuse `MAILBOX_CAPACITY` with no child effect at cap. */
  checkLaunchCapacity(managerSessionKey: string): Promise<MailboxCapacityVerdict>;
  /** Unread event IDs, sorted by eventId order. */
  list(managerSessionKey: string): Promise<string[]>;
  read(managerSessionKey: string, eventId: string): Promise<MailboxEvent>;
  /** Rename `unread/` → `acked/` after handling; idempotent; then prune `acked/` to the newest 1 000. */
  ack(managerSessionKey: string, eventId: string): Promise<"acked" | "already-acked">;
  /** The journaled-move primitive (N2.4): always completes; moved files count toward the destination caps. */
  moveUnread(from: string, to: string, eventIds: string[]): Promise<MailboxMoveOutcome>;
  degradation(): Promise<MailboxDegradation>;
}

export interface MailboxOptions {
  namespace: DaemonNamespace | (() => Promise<DaemonNamespace>);
  /** Defaults to the file-backed port over `daemon.json` in the namespace. */
  status?: DaemonJsonPort;
  /** Required for run-scoped writes: destination resolution happens under the run flock. */
  ownership?: MailboxRunOwnership;
  now?: () => Date;
  /** Bound on flock's own contention wait for one lock section. */
  waitMs?: number;
  /** Diagnostic sink for loss-accounting write failures; defaults to stderr. */
  log?: (line: string) => void;
}

/** `<ISO-8601 UTC ms, colons removed>-<randomUUID>` — sortable by time, no durable counter (spec §7). */
export function mailboxEventId(at: Date = new Date()): string {
  return `${at.toISOString().replace(/:/g, "")}-${randomUUID()}`;
}

function assertEventId(eventId: string): void {
  if (typeof eventId !== "string" || !EVENT_ID.test(eventId)) throw invalid("event ID is malformed");
}

function assertManagerSessionKey(value: string): void {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) throw invalid("manager session key is malformed");
}

function validDecision(value: MailboxDecision): boolean {
  return boundedText(value.verdict, 64)
    && Array.isArray(value.labels) && value.labels.length <= 16 && value.labels.every((label) => boundedText(label, 64))
    && typeof value.evidenceDigest === "string" && value.evidenceDigest.length <= 128
    && (value.evidenceExcerpt === undefined || (typeof value.evidenceExcerpt === "string" && Buffer.byteLength(value.evidenceExcerpt, "utf8") <= MAILBOX_DECISION_EXCERPT_MAX_BYTES))
    && boundedText(value.reviewerModel, 64);
}

function validHandoff(value: MailboxHandoff): boolean {
  return boundedText(value.state, 64) && (value.artifactSha256 === undefined || boundedText(value.artifactSha256, 128));
}

function assertRunEventInput(input: MailboxRunEventInput): void {
  if (!boundedText(input.kind, 64) || !boundedText(input.runId, 200) || !boundedText(input.jobId, 200)) {
    throw invalid("run event identity fields are malformed");
  }
  const actions = input.actions ?? [];
  if (!Array.isArray(actions) || !actions.every((action) => boundedText(action, 256))) throw invalid("run event actions are malformed");
  if (input.decision !== undefined && !validDecision(input.decision)) throw invalid("run event decision is malformed");
  if (input.handoff !== undefined && !validHandoff(input.handoff)) throw invalid("run event handoff is malformed");
}

function assertGapEventInput(gap: MailboxGapEventInput): void {
  if (!boundedText(gap.from, 64) || !boundedText(gap.to, 64) || !record(gap.lost)) throw invalid("gap event is malformed");
}

function serialize(body: MailboxEvent): string {
  const data = JSON.stringify(modelSafeJson(body));
  if (Buffer.byteLength(data, "utf8") > MAILBOX_EVENT_MAX_BYTES) throw invalid("mailbox event body exceeds the byte bound");
  return data;
}

/**
 * The file-backed default port: read-merge-write `daemon.json` with the D1
 * discipline on one queue, so sibling fields a patch does not own survive.
 * `main.ts` injects its own port bound to the daemon's status queue; this one
 * serves standalone hosts and tests.
 */
export function createDaemonJsonPort(dir: string): DaemonJsonPort {
  const path = join(dir, "daemon.json");
  const read = async (): Promise<Record<string, unknown>> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      return record(parsed) ? parsed : {};
    } catch (error) {
      if (isNodeError(error, "ENOENT") || error instanceof SyntaxError) return {};
      throw failure("Daemon status record is unavailable");
    }
  };
  let queue: Promise<void> = Promise.resolve();
  const write = (patch: Record<string, unknown>): Promise<void> => {
    const next = queue.then(async () => {
      const existing = await read();
      const temporary = join(dir, `.${randomUUID()}.tmp`);
      /* c8 ignore next -- O_NOFOLLOW exists on every platform that ships flock. */
      const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
      let handle;
      try {
        handle = await open(temporary, flags, 0o600);
      } catch {
        throw failure("Daemon status record could not be staged");
      }
      try {
        await handle.writeFile(JSON.stringify({ ...existing, ...patch }));
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
        /* c8 ignore start -- a rename failure after a committed stage is an fs fault tests cannot force. */
        await rm(temporary, { force: true }).catch(() => undefined);
        throw failure("Daemon status record could not be committed");
        /* c8 ignore stop */
      }
      let dirHandle;
      try {
        dirHandle = await open(dir, constants.O_RDONLY);
        await dirHandle.sync();
        /* c8 ignore start -- a directory open/sync fault after a committed rename is not forceable in tests. */
      } catch {
        throw failure("Daemon status directory could not be synced");
      } finally {
        await dirHandle?.close().catch(() => undefined);
        /* c8 ignore stop */
      }
    });
    queue = next.then(() => undefined, () => undefined);
    return next;
  };
  return { read, write };
}

interface MailboxCounts {
  /** Per-manager `unread/` counts, by manager session key. */
  perMailbox: Array<{ key: string; files: number; bytes: number }>;
  /** Global `unread/` file count summed across all mailboxes. */
  global: number;
}

function capState(counts: MailboxCounts): "ok" | "degraded" {
  return counts.perMailbox.some((entry) => entry.files >= MAILBOX_UNREAD_MAX_FILES || entry.bytes >= MAILBOX_UNREAD_MAX_BYTES)
    || counts.global >= MAILBOX_GLOBAL_UNREAD_MAX_FILES ? "degraded" : "ok";
}

function atCap(counts: MailboxCounts, key: string, addBytes: number): boolean {
  // The entry is always present: every admission section creates the mailbox
  // (and thus its `unread/`) before the recomputed scan runs.
  const mine = counts.perMailbox.find((entry) => entry.key === key)!;
  return mine.files + 1 > MAILBOX_UNREAD_MAX_FILES
    || mine.bytes + addBytes > MAILBOX_UNREAD_MAX_BYTES
    || counts.global + 1 > MAILBOX_GLOBAL_UNREAD_MAX_FILES;
}

/**
 * Create the mailbox for one daemon namespace. The namespace resolves lazily
 * on first use and a failure is not cached. Everything is created on demand:
 * constructing the mailbox touches no filesystem state.
 */
export function createMailbox(options: MailboxOptions): Mailbox {
  const now = () => (options.now ?? (() => new Date()))();
  const waitMs = options.waitMs ?? MAILBOX_LOCK_WAIT_MS;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  let resolved: Promise<DaemonNamespace> | undefined;
  const namespace = (): Promise<DaemonNamespace> => {
    resolved ??= Promise.resolve(typeof options.namespace === "function" ? options.namespace() : options.namespace)
      .catch((error: unknown) => {
        resolved = undefined;
        throw error instanceof DaemonMailboxError ? error : failure("Mailbox namespace is unavailable");
      });
    return resolved;
  };
  let port: DaemonJsonPort | undefined = options.status;
  const status = async (): Promise<DaemonJsonPort> => {
    port ??= createDaemonJsonPort((await namespace()).dir);
    return port;
  };

  async function mailboxRoot(create: true): Promise<string>;
  async function mailboxRoot(create: false): Promise<string | undefined>;
  async function mailboxRoot(create: boolean): Promise<string | undefined> {
    const dir = (await namespace()).dir;
    try {
      assertOwnerOnlyDirectory(dir, await lstat(dir), failure, "Mailbox");
    } catch (error) {
      if (error instanceof DaemonMailboxError) throw error;
      throw failure("Mailbox namespace is unavailable");
    }
    const root = join(dir, DAEMON_MAILBOX_DIR_NAME);
    if (create) {
      try {
        await mkdir(root, { mode: 0o700 });
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw failure("Mailbox root is unavailable");
      }
    }
    try {
      assertOwnerOnlyDirectory(root, await lstat(root), failure, "Mailbox");
    } catch (error) {
      // A never-created root under a read (`create: false`) is an empty
      // mailbox, not a fault — the read path must not conjure directories.
      if (error instanceof DaemonMailboxError) throw error;
      if (!create && isNodeError(error, "ENOENT")) return undefined;
      throw failure("Mailbox root is unavailable");
    }
    return root;
  }

  async function trustedDirectory(path: string): Promise<void> {
    try {
      assertOwnerOnlyDirectory(path, await lstat(path), failure, "Mailbox");
    } catch (error) {
      /* c8 ignore start -- typed refusals rethrow; any other lstat failure means the directory changed between stat and use. */
      if (error instanceof DaemonMailboxError) throw error;
      throw failure("Mailbox directory is unavailable");
      /* c8 ignore stop */
    }
  }

  /** The manager's mailbox directories, created on demand and proven owner-only on every call. */
  async function managerDirs(key: string, create: boolean): Promise<{ dir: string; unread: string; acked: string } | undefined> {
    assertManagerSessionKey(key);
    const root = create ? await mailboxRoot(true) : await mailboxRoot(false);
    if (root === undefined) return undefined;
    const dir = join(root, key);
    const unread = join(dir, "unread");
    const acked = join(dir, "acked");
    if (create) {
      for (const path of [dir, unread, acked]) {
        try {
          await mkdir(path, { mode: 0o700 });
        } catch (error) {
          if (!isNodeError(error, "EEXIST")) throw failure("Mailbox directory is unavailable");
        }
      }
    }
    let value;
    try {
      value = await lstat(dir);
    } catch (error) {
      /* c8 ignore start -- a non-ENOENT manager lstat failure is an fs fault tests cannot force. */
      if (isNodeError(error, "ENOENT")) return undefined;
      throw failure("Mailbox directory is unavailable");
      /* c8 ignore stop */
    }
    assertOwnerOnlyDirectory(dir, value, failure, "Mailbox");
    await trustedDirectory(unread);
    await trustedDirectory(acked);
    return { dir, unread, acked };
  }

  /**
   * The fixed §7 flock order: the caller supplies locks in acquisition order —
   * the short global mailbox-index flock first, then mailbox flocks in
   * `managerSessionKey` order — and they release in reverse.
   */
  async function withFlocks<T>(lockPaths: string[], markers: string[], section: () => Promise<T>): Promise<T> {
    const leases: FlockHolderLease[] = [];
    try {
      for (let index = 0; index < lockPaths.length; index += 1) {
        leases.push(await acquireFlockHolder({
          lockPath: lockPaths[index]!,
          wait: { timeoutMs: waitMs },
          readyMarker: markers[index]!,
          subject: "Mailbox",
          failure,
        }));
      }
      return await section();
    } finally {
      for (const lease of leases.reverse()) {
        // A failed release cannot recall what the section already committed;
        // the kernel frees the flock when the holder dies.
        /* c8 ignore next -- holder release only fails on an injected filesystem fault; cleanup is best-effort. */
        await lease.release().catch(() => undefined);
      }
    }
  }

  const indexLockPath = async (): Promise<string> => join(await mailboxRoot(true), MAILBOX_INDEX_LOCK_NAME);
  const mailboxLockPath = async (key: string): Promise<string> => {
    // The lock's parent must exist before `flock` can create the file; the
    // manager directories it creates are the same ones any write needs.
    const dirs = await managerDirs(key, true);
    /* c8 ignore next -- a manager directory created this call is undefined only if it vanished between mkdir and lstat. */
    if (dirs === undefined) throw failure("Mailbox directory is unavailable");
    return join(dirs.dir, MAILBOX_LOCK_NAME);
  };

  /** Index lock first, then one destination mailbox lock. */
  async function admissionLocks<T>(key: string, section: () => Promise<T>): Promise<T> {
    return withFlocks([await indexLockPath(), await mailboxLockPath(key)], [MAILBOX_INDEX_READY, MAILBOX_READY], section);
  }

  /** Multi-mailbox sections take mailbox flocks in `managerSessionKey` order after the index flock. */
  async function multiMailboxLocks<T>(keys: string[], section: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(keys)].sort();
    const lockPaths = [await indexLockPath()];
    const markers = [MAILBOX_INDEX_READY];
    for (const key of ordered) {
      lockPaths.push(await mailboxLockPath(key));
      markers.push(MAILBOX_READY);
    }
    return withFlocks(lockPaths, markers, section);
  }

  /** `unread/` counts only — `acked/` is bounded by retention and counts toward neither cap. */
  async function scanCounts(): Promise<MailboxCounts> {
    const root = await mailboxRoot(true);
    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      /* c8 ignore next -- readdir fails only if the proven root vanished mid-scan. */
      throw failure("Mailbox root is unavailable");
    }
    const perMailbox: Array<{ key: string; files: number; bytes: number }> = [];
    let global = 0;
    for (const name of names.sort()) {
      if (!SHA256_HEX.test(name)) continue;
      const dirs = await managerDirs(name, false);
      /* c8 ignore next -- a manager directory vanishing mid-scan is a filesystem race. */
      if (dirs === undefined) continue;
      let entries: string[];
      try {
        entries = await readdir(dirs.unread);
      } catch {
        /* c8 ignore next -- readdir fails only if the proven unread directory vanished mid-scan. */
        throw failure("Mailbox unread directory is unavailable");
      }
      let files = 0;
      let bytes = 0;
      for (const entry of entries.sort()) {
        if (!entry.endsWith(".json")) continue;
        files += 1;
        try {
          bytes += (await lstat(join(dirs.unread, entry))).size;
        } catch {
          /* c8 ignore next -- a counted file vanishing mid-scan is a filesystem race. */
          throw failure("Mailbox event file is unavailable");
        }
      }
      perMailbox.push({ key: name, files, bytes });
      global += files;
    }
    return { perMailbox, global };
  }

  async function syncDirectory(path: string): Promise<void> {
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY);
      await handle.sync();
    } catch {
      /* c8 ignore next -- a directory open/sync failure is an fs fault tests cannot force. */
      throw failure("Mailbox directory could not be synced");
    } finally {
      /* c8 ignore next -- closing the sync handle is best-effort cleanup. */
      await handle?.close().catch(() => undefined);
    }
  }

  /**
   * The §7 no-clobber write: same-directory temp, fsync, `link(temp, final)` —
   * `EEXIST` refuses without touching the existing file — then unlink the temp
   * and fsync the directory.
   */
  async function writeEventFile(dir: string, eventId: string, data: string): Promise<"written" | "collision"> {
    const temporary = join(dir, `.${randomUUID()}.tmp`);
    const final = join(dir, `${eventId}.json`);
    /* c8 ignore next -- O_NOFOLLOW exists on every platform that ships flock. */
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
    let handle;
    try {
      handle = await open(temporary, flags, 0o600);
    } catch {
      /* c8 ignore next -- the staging open fails only when the locked directory became unwritable mid-section. */
      throw failure("Mailbox event could not be staged");
    }
    try {
      await handle.writeFile(data);
      await handle.sync();
      await handle.close();
    } catch (error) {
      /* c8 ignore start -- handle write/sync/close rejections are errno-only inside a held handle; cleanup is best-effort. */
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      if (error instanceof DaemonMailboxError) throw error;
      throw failure("Mailbox event could not be written");
      /* c8 ignore stop */
    }
    try {
      await link(temporary, final);
    } catch (error) {
      /* c8 ignore next -- the cleanup below only rejects on an injected fs fault. */
      await rm(temporary, { force: true }).catch(() => undefined);
      /* c8 ignore start -- a non-EEXIST link failure is an fs fault tests cannot force. */
      if (isNodeError(error, "EEXIST")) return "collision";
      throw failure("Mailbox event could not be committed");
      /* c8 ignore stop */
    }
    await rm(temporary, { force: true });
    await syncDirectory(dir);
    return "written";
  }

  /**
   * The durable degradation record. `hold` parks a refused `downtime_gap` in
   * `daemon.json.pendingGap`; otherwise the refusal is recorded in
   * `daemon.json.unpersisted` with `{count, firstAt, lastAt}`. Returns whether
   * the gap was durably held. A failed `daemon.json` write claims nothing and
   * is logged — the caller's result still reports the persist as failed.
   */
  async function recordFailure(key: string, at: string, hold?: MailboxGapEvent): Promise<boolean> {
    try {
      const daemon = await status();
      const current = await daemon.read();
      if (hold !== undefined) {
        const pendingGap = record(current.pendingGap) ? current.pendingGap : {};
        await daemon.write({ capacity: "degraded", pendingGap: { ...pendingGap, [key]: hold } });
        return true;
      }
      const all = record(current.unpersisted) ? current.unpersisted : {};
      const previous = record(all[key]) ? all[key] as unknown as MailboxUnpersistedAccount : undefined;
      const next: MailboxUnpersistedAccount = {
        count: (typeof previous?.count === "number" ? previous.count : 0) + 1,
        firstAt: typeof previous?.firstAt === "string" ? previous.firstAt : at,
        lastAt: at,
      };
      await daemon.write({ capacity: "degraded", unpersisted: { ...all, [key]: next } });
      return false;
    } catch (error) {
      log(`herdr-tools-daemon mailbox loss accounting failed: ${errorText(error)}`);
      return false;
    }
  }

  /** Patch `daemon.json.capacity` from recomputed counts; a write failure is logged, never claimed. */
  async function recordCapacity(counts: MailboxCounts): Promise<void> {
    try {
      await (await status()).write({ capacity: capState(counts) });
    } catch (error) {
      // Never claimed: a failed capacity patch is logged, not asserted.
      log(`herdr-tools-daemon mailbox capacity write failed: ${errorText(error)}`);
    }
  }

  /**
   * Admission + no-clobber write under the held locks. Both caps count
   * `unread/` only and are recomputed here at write time, so the bound is
   * atomic with the `link`.
   */
  async function persistEvent(key: string, eventId: string, data: string, hold?: MailboxGapEvent): Promise<MailboxWriteResult> {
    const at = now().toISOString();
    const counts = await scanCounts();
    const dirs = await managerDirs(key, true);
    /* c8 ignore next -- a manager directory created this section is undefined only if it vanished between mkdir and lstat. */
    if (dirs === undefined) throw failure("Mailbox directory is unavailable");
    if (atCap(counts, key, Buffer.byteLength(data, "utf8"))) {
      if (hold !== undefined && await recordFailure(key, at, hold)) {
        return { persisted: false, persistenceFailed: true, eventId, reason: "capacity", at, pendingGap: true };
      }
      await recordFailure(key, at);
      return { persisted: false, persistenceFailed: true, eventId, reason: "capacity", at };
    }
    let outcome: "written" | "collision";
    try {
      outcome = await writeEventFile(dirs.unread, eventId, data);
    } catch {
      await recordFailure(key, at);
      return { persisted: false, persistenceFailed: true, eventId, reason: "unavailable", at };
    }
    if (outcome === "collision") {
      // Never overwritten; the existing file is left byte-identical and the
      // refusal is accounted as a loss of this payload.
      await recordFailure(key, at);
      return { persisted: false, persistenceFailed: true, eventId, reason: "collision", at };
    }
    await recordCapacity(await scanCounts());
    return { persisted: true, eventId, path: join(dirs.unread, `${eventId}.json`) };
  }

  async function buildRunBody(input: MailboxRunEventInput): Promise<{ eventId: string; data: string }> {
    assertRunEventInput(input);
    const at = now();
    const eventId = input.id ?? mailboxEventId(at);
    assertEventId(eventId);
    const body: MailboxRunEvent = {
      id: eventId,
      at: at.toISOString(),
      kind: input.kind,
      runId: input.runId,
      jobId: input.jobId,
      ...(input.childIdentity === undefined ? {} : { childIdentity: input.childIdentity }),
      ...(input.decision === undefined ? {} : { decision: input.decision }),
      ...(input.handoff === undefined ? {} : { handoff: input.handoff }),
      actions: input.actions ?? [],
    };
    return { eventId, data: serialize(body) };
  }

  async function buildGapBody(key: string, gap: MailboxGapEventInput): Promise<{ eventId: string; data: string; body: MailboxGapEvent }> {
    assertGapEventInput(gap);
    assertManagerSessionKey(key);
    const at = now();
    const atText = gap.at ?? at.toISOString();
    const eventId = gap.id ?? mailboxEventId(at);
    assertEventId(eventId);
    const body: MailboxGapEvent = { id: eventId, at: atText, kind: "downtime_gap", from: gap.from, to: gap.to, lost: gap.lost };
    return { eventId, data: serialize(body), body };
  }

  async function readEventBody(path: string, eventId: string): Promise<MailboxEvent> {
    let value;
    try {
      value = await lstat(path);
    } catch (error) {
      /* c8 ignore start -- a non-ENOENT event lstat failure is an fs fault tests cannot force. */
      if (isNodeError(error, "ENOENT")) throw new DaemonMailboxError("MAILBOX_EVENT_NOT_FOUND", "Mailbox event is absent");
      throw failure("Mailbox event is indeterminate");
      /* c8 ignore stop */
    }
    if (!value.isFile() || value.isSymbolicLink() || (Number(value.mode) & 0o22) !== 0) throw failure("Mailbox event is not trusted");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch {
      throw failure("Mailbox event is not trusted");
    }
    if (!record(parsed) || parsed.id !== eventId) throw failure("Mailbox event is not trusted");
    return parsed as unknown as MailboxEvent;
  }

  async function clearPendingGap(key: string): Promise<void> {
    try {
      const daemon = await status();
      const current = await daemon.read();
      const next = { ...(current.pendingGap as Record<string, unknown> | undefined) };
      delete next[key];
      await daemon.write({ pendingGap: next });
    } catch (error) {
      log(`herdr-tools-daemon mailbox pendingGap write failed: ${errorText(error)}`);
    }
  }

  async function moveUnreadLocked(from: string, to: string, eventIds: string[]): Promise<MailboxMoveOutcome> {
    const source = await managerDirs(from, true);
    const destination = await managerDirs(to, true);
    /* c8 ignore next -- the directories created this section are undefined only if one vanished between mkdir and lstat. */
    if (source === undefined || destination === undefined) throw failure("Mailbox directory is unavailable");
    const outcome: MailboxMoveOutcome = { moved: [], alreadyAtDestination: [], lost: [] };
    for (const eventId of eventIds) {
      const target = join(destination.unread, `${eventId}.json`);
      try {
        await rename(join(source.unread, `${eventId}.json`), target);
        await syncDirectory(source.unread);
        await syncDirectory(destination.unread);
        outcome.moved.push(eventId);
      } catch (error) {
        /* c8 ignore start -- a non-ENOENT rename failure is an fs fault tests cannot force. */
        if (!isNodeError(error, "ENOENT")) {
          throw failure("Mailbox event move failed");
        }
        /* c8 ignore stop */
        // A source-absent file counts as moved only when the destination
        // file exists; absent from both it goes to the durable loss
        // accounting, never silently skipped.
        if (await exists(target)) outcome.alreadyAtDestination.push(eventId);
        else outcome.lost.push(eventId);
      }
    }
    for (let index = 0; index < outcome.lost.length; index += 1) {
      // One durable loss account per file absent from both sides.
      await recordFailure(from, now().toISOString());
    }
    await recordCapacity(await scanCounts());
    return outcome;
  }

  return {
    async withMailboxes(keys, section) {
      for (const key of keys) assertManagerSessionKey(key);
      const check = (key: string) => {
        if (!keys.includes(key)) throw invalid("mailbox is outside the held lock set");
      };
      return multiMailboxLocks(keys, () => section({
        list: async (key) => { check(key); return this.list(key); },
        read: async (key, id) => { check(key); return this.read(key, id); },
        moveUnread: async (from, to, ids) => {
          check(from); check(to);
          if (from === to || !ids.every((id) => EVENT_ID.test(id))) throw invalid("move plan is malformed");
          const outcome = await moveUnreadLocked(from, to, ids);
          // A crash may have renamed a file before syncing either directory.
          // Replay also fences the already-at-destination case before journaling.
          await syncDirectory((await managerDirs(from, true))!.unread);
          await syncDirectory((await managerDirs(to, true))!.unread);
          return outcome;
        },
        writeRecordedEvent: async (key, event) => {
          check(key);
          assertRunEventInput(event);
          assertEventId(event.id);
          // An unread OR already-handled recorded ID proves this step landed.
          try {
            await this.read(key, event.id);
            const dirs = (await managerDirs(key, true))!;
            await syncDirectory(dirs.unread);
            await syncDirectory(dirs.acked);
            const unread = join(dirs.unread, `${event.id}.json`);
            return { persisted: true, eventId: event.id, path: await exists(unread) ? unread : join(dirs.acked, `${event.id}.json`) };
          } catch (error) {
            if (!(error instanceof DaemonMailboxError) || error.code !== "MAILBOX_EVENT_NOT_FOUND") throw error;
          }
          return persistEvent(key, event.id, serialize(event));
        },
      }));
    },
    async writeRunEvent(input) {
      const ownership = options.ownership;
      if (ownership === undefined) throw failure("Mailbox ownership seam is unavailable");
      const { eventId, data } = await buildRunBody(input);
      // The destination resolves inside the run flock from the run's CURRENT
      // owner — never the owner recorded at supervisor bind — and the whole
      // admission + link completes there under the fixed flock order.
      const section = async (): Promise<MailboxWriteResult> => {
        const key = await ownership.ownerOfRun(input.runId);
        return admissionLocks(key, () => persistEvent(key, eventId, data));
      };
      return ownership.withRunFlock === undefined ? section() : ownership.withRunFlock(input.runId, section);
    },

    async writeGapEvent(key, gap) {
      const { eventId, data, body } = await buildGapBody(key, gap);
      // A held gap is retried verbatim: its ID and `at` persist, so a retry
      // lands the original disclosure rather than minting a duplicate.
      return admissionLocks(key, () => persistEvent(key, eventId, data, body));
    },

    async retryPendingGaps() {
      const daemon = await status();
      const current = await daemon.read();
      const pendingGap = current.pendingGap as Record<string, unknown> | undefined;
      for (const [key, held] of Object.entries(pendingGap ?? {})) {
        if (!record(held)) continue;
        let eventId: string | undefined;
        try {
          // Durable already? A crash between the write and the clear must not
          // duplicate the event: an on-disk copy means the gap landed.
          eventId = typeof held.id === "string" ? held.id : undefined;
          if (eventId !== undefined) {
            // A mailbox that does not exist yet cannot hold the file; the
            // write below creates it. Untrusted-directory refusals resurface
            // at that write, which performs the authoritative checks.
            const dirs = await managerDirs(key, false).catch(() => undefined);
            if (dirs !== undefined && (await exists(join(dirs.unread, `${eventId}.json`)) || await exists(join(dirs.acked, `${eventId}.json`)))) {
              await clearPendingGap(key);
              continue;
            }
          }
          const result = await this.writeGapEvent(key, held as unknown as MailboxGapEventInput);
          if (result.persisted) await clearPendingGap(key);
        } catch (error) {
          // A held gap whose rewrite fails stays pending and is logged; the
          // disclosure degrades, it is never destroyed.
          log(`herdr-tools-daemon mailbox pendingGap retry failed: ${errorText(error)}`);
        }
      }
    },

    async checkLaunchCapacity(key) {
      assertManagerSessionKey(key);
      return admissionLocks(key, async () => {
        const counts = await scanCounts();
        if (atCap(counts, key, 0)) return { ok: false, code: "MAILBOX_CAPACITY", at: now().toISOString() };
        return { ok: true };
      });
    },

    async list(key) {
      const dirs = await managerDirs(key, false);
      if (dirs === undefined) return [];
      let names: string[];
      try {
        names = await readdir(dirs.unread);
      } catch {
        /* c8 ignore next -- readdir fails only if the proven unread directory vanished mid-list. */
        throw failure("Mailbox unread directory is unavailable");
      }
      return names.filter((name) => name.endsWith(".json")).sort().map((name) => name.slice(0, -".json".length));
    },

    async read(key, eventId) {
      assertEventId(eventId);
      const dirs = await managerDirs(key, false);
      if (dirs === undefined) throw new DaemonMailboxError("MAILBOX_EVENT_NOT_FOUND", "Mailbox event is absent");
      try {
        return await readEventBody(join(dirs.unread, `${eventId}.json`), eventId);
      } catch (error) {
        if (!(error instanceof DaemonMailboxError) || error.code !== "MAILBOX_EVENT_NOT_FOUND") throw error;
        return readEventBody(join(dirs.acked, `${eventId}.json`), eventId);
      }
    },

    async ack(key, eventId) {
      assertEventId(eventId);
      return admissionLocks(key, async () => {
        const dirs = await managerDirs(key, true);
        /* c8 ignore next -- the manager directory created this section is undefined only if it vanished between mkdir and lstat. */
        if (dirs === undefined) throw failure("Mailbox directory is unavailable");
        const unreadPath = join(dirs.unread, `${eventId}.json`);
        const ackedPath = join(dirs.acked, `${eventId}.json`);
        if (await exists(unreadPath)) {
          // The rename happens only after the caller handled the event; it is
          // the durable record of handling.
          await rename(unreadPath, ackedPath);
          await syncDirectory(dirs.unread);
          await syncDirectory(dirs.acked);
          await pruneAcked(dirs.acked);
          await recordCapacity(await scanCounts());
          return "acked" as const;
        }
        if (await exists(ackedPath)) return "already-acked" as const;
        throw new DaemonMailboxError("MAILBOX_EVENT_NOT_FOUND", "Mailbox event is absent");
      });
    },

    async moveUnread(from, to, eventIds) {
      assertManagerSessionKey(from);
      assertManagerSessionKey(to);
      if (from === to) throw invalid("move source and destination are identical");
      if (!Array.isArray(eventIds) || !eventIds.every((eventId) => EVENT_ID.test(eventId))) throw invalid("move event IDs are malformed");
      return multiMailboxLocks([from, to], async () => {
        return moveUnreadLocked(from, to, eventIds);
      });
    },

    async degradation() {
      const current = await (await status()).read();
      return {
        capacity: current.capacity === "degraded" ? "degraded" as const : "ok" as const,
        unpersisted: (record(current.unpersisted) ? current.unpersisted : {}) as Record<string, MailboxUnpersistedAccount>,
        pendingGap: (record(current.pendingGap) ? current.pendingGap : {}) as Record<string, MailboxGapEvent>,
      };
    },
  };

  /** Bounded `acked/` retention: prune to the newest 1 000 files by eventId order (timestamp-prefixed names sort oldest-first). */
  async function pruneAcked(ackedDir: string): Promise<void> {
    let names: string[];
    try {
      names = (await readdir(ackedDir)).filter((name) => name.endsWith(".json")).sort();
    } catch {
      /* c8 ignore next -- readdir fails only if the proven acked directory vanished mid-prune. */
      throw failure("Mailbox acked directory is unavailable");
    }
    const excess = names.length - MAILBOX_ACKED_RETAINED_FILES;
    for (let index = 0; index < excess; index += 1) {
      await rm(join(ackedDir, names[index]!), { force: true });
    }
    if (excess > 0) await syncDirectory(ackedDir);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    /* c8 ignore start -- a non-ENOENT existence lstat failure is an fs fault tests cannot force. */
    if (isNodeError(error, "ENOENT")) return false;
    throw failure("Mailbox event is indeterminate");
    /* c8 ignore stop */
  }
}
