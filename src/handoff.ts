/**
 * The Tools-owned run handoff primitive (ADR-031).
 *
 * Every qualified Pi, Claude, or Devin launch receives one generated run UUID
 * and a run directory under the endpoint-private namespace beside the
 * canonical Herdr socket. The agent owns `handoff.md`; Tools owns `.tools/`
 * (0700), its `state.json` sidecar, and the native flock that serializes sidecar
 * writes. The versioned state reserves endpoint/manager/child/native-session
 * identity, the lifecycle watermark, the artifact digest, and the repair fence
 * for the deferred recovery node.
 *
 * Same-UID agents are cooperative, not isolated: the checks below enforce
 * ownership, modes, and file shape so a swapped or planted artifact is refused,
 * not so one host survives another.
 */

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { acquireFlockHolder, assertOwnerOnlyDirectory } from "./pane-write-lock.js";
import { resolveSocketPath } from "./supervision/socket.js";

export type HandoffErrorCode =
  | "HANDOFF_UNAVAILABLE"
  | "HANDOFF_STORE_FAILED"
  | "HANDOFF_ARTIFACT_MISSING"
  | "HANDOFF_ARTIFACT_UNTRUSTED"
  | "HANDOFF_ARTIFACT_INVALID"
  | "HANDOFF_ARTIFACT_OVERSIZED";

export class HandoffError extends Error {
  constructor(readonly code: HandoffErrorCode, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "HandoffError";
  }
}

const failure = (message: string): HandoffError => new HandoffError("HANDOFF_UNAVAILABLE", message);

/** Endpoint-private namespace every Tools host on one Herdr endpoint resolves. */
export interface HandoffNamespace {
  /** Owner-only directory holding this endpoint's run directories. */
  dir: string;
  /** Canonical endpoint identity the namespace derives from. */
  endpoint: string;
}

export const HANDOFF_STATE_DIR_NAME = "herdr-handoffs";
export const HANDOFF_ARTIFACT_NAME = "handoff.md";
export const HANDOFF_TOOLS_DIR_NAME = ".tools";
export const HANDOFF_STATE_NAME = "state.json";
export const HANDOFF_LOCK_NAME = "lock";
export const HANDOFF_MAX_BYTES = 64 * 1024;
const HANDOFF_LOCK_READY = "HERDR_HANDOFF_LOCK_READY";
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function uid(): number {
  const value = process.getuid?.();
  /* c8 ignore next -- flock platforms all provide getuid. */
  if (value === undefined) throw failure("Handoff owner is unavailable");
  return value;
}

function safePath(value: string): string {
  return value.length <= 512 && !value.includes("\0") && !value.includes("\r") && !value.includes("\n") ? value : "[path omitted]";
}

/**
 * Resolve the endpoint-private run namespace. Like the pane-write lock domain,
 * the directory keys off the canonical socket path so every host on one
 * endpoint computes the same root, and every parent in the path is proven
 * owner-only before it is trusted.
 */
export async function resolveHandoffNamespace(env: NodeJS.ProcessEnv = process.env, runtimeDir?: string): Promise<HandoffNamespace> {
  let socketPath: string;
  try {
    socketPath = resolveSocketPath(env);
  } catch {
    throw new HandoffError("HANDOFF_UNAVAILABLE", "Handoff endpoint is unavailable");
  }
  let endpoint: string;
  try {
    endpoint = await realpath(socketPath);
  } catch {
    throw new HandoffError("HANDOFF_UNAVAILABLE", "Handoff endpoint cannot be canonicalized");
  }
  const dir = runtimeDir ?? join(dirname(endpoint), HANDOFF_STATE_DIR_NAME);
  try {
    assertOwnerOnlyDirectory(dirname(dir), await lstat(dirname(dir)), failure, "Handoff");
  } catch (error) {
    if (error instanceof HandoffError) throw error;
    throw new HandoffError("HANDOFF_UNAVAILABLE", "Handoff state directory is unavailable");
  }
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw new HandoffError("HANDOFF_UNAVAILABLE", "Handoff state directory is unavailable");
  }
  try {
    assertOwnerOnlyDirectory(dir, await lstat(dir), failure, "Handoff");
  } catch (error) {
    if (error instanceof HandoffError) throw error;
    throw new HandoffError("HANDOFF_UNAVAILABLE", "Handoff state directory is unavailable");
  }
  return { dir, endpoint };
}

/** One allocated run. Paths are launcher-generated; callers never supply them. */
export interface HandoffAllocation {
  runId: string;
  /** The endpoint-private namespace directory this run lives under. */
  namespaceDir: string;
  /** The run's private directory; the agent writes `handoff.md` inside it. */
  directory: string;
  /** The exact artifact path injected into the assignment. */
  artifactPath: string;
  /** Tools-owned sidecar directory, 0700. */
  toolsDir: string;
  statePath: string;
  lockPath: string;
  /** The verbatim line the artifact must carry: `herdr-run:<runId>`. */
  marker: string;
}

/**
 * The run's durable lifecycle. `awaiting_handoff` holds until a terminal
 * outcome is recorded: `handed_off` when the agent's own artifact is the
 * accepted record, `cancelled`/`failed` only on a runtime-authored fallback
 * backed by confirmed run-level cancellation or authoritative exit, and
 * `recovery_pending` when the host stopped with the outcome unresolved.
 */
export type HandoffLifecycleState = "awaiting_handoff" | "handed_off" | "recovery_pending" | "cancelled" | "failed";

/**
 * The versioned sidecar. Identity fields that only exist after agent start are
 * reserved as null at allocation and bound by the gate once the launched
 * identity is proven; the deferred recovery node reads them.
 */
export interface HandoffState {
  v: 1;
  runId: string;
  endpoint: string;
  createdAt: string;
  manager: { paneId: string; display: string; source: string };
  child: {
    agentName: string;
    agentKind: string;
    candidateName: string;
    specLabel: string;
    fallbackCandidates: string[];
    paneId: string | null;
    terminalId: string | null;
    agentId: string | null;
  };
  nativeSession: { source: string; agent: string; kind: string; value: string } | null;
  lifecycle: { state: HandoffLifecycleState; watermark: { stateChangeSeq: number; revision: number } | null; detail?: string };
  artifact: { path: string; sha256: string | null; bytes: number | null; version: number; status?: HandoffStatus };
  repair: { attempts: number; fence: { version: number; token: string } | null };
}

export interface HandoffRunIdentity {
  manager: { paneId: string; display: string; source: string };
  child: { agentName: string; agentKind: string; candidateName: string; specLabel: string; fallbackCandidates: string[] };
}

function allocateIn(namespace: HandoffNamespace): HandoffAllocation {
  const runId = randomUUID();
  /* c8 ignore next -- randomUUID always matches this shape; the guard exists so a swapped id source cannot silently widen the run layout. */
  if (!RUN_ID_PATTERN.test(runId)) throw new HandoffError("HANDOFF_UNAVAILABLE", "Handoff run id is malformed");
  const directory = join(namespace.dir, runId);
  const toolsDir = join(directory, HANDOFF_TOOLS_DIR_NAME);
  return {
    runId,
    namespaceDir: namespace.dir,
    directory,
    artifactPath: join(directory, HANDOFF_ARTIFACT_NAME),
    toolsDir,
    statePath: join(toolsDir, HANDOFF_STATE_NAME),
    lockPath: join(toolsDir, HANDOFF_LOCK_NAME),
    marker: `herdr-run:${runId}`
  };
}

/** Paths must be exactly the UUID-derived layout; anything else is refused. */
function assertRunPaths(run: HandoffAllocation, code: "HANDOFF_STORE_FAILED" | "HANDOFF_ARTIFACT_UNTRUSTED"): void {
  const consistent = RUN_ID_PATTERN.test(run.runId)
    && basename(resolve(run.directory)) === run.runId
    && dirname(resolve(run.directory)) === resolve(run.namespaceDir)
    && run.artifactPath === join(run.directory, HANDOFF_ARTIFACT_NAME)
    && run.toolsDir === join(run.directory, HANDOFF_TOOLS_DIR_NAME)
    && run.statePath === join(run.toolsDir, HANDOFF_STATE_NAME)
    && run.lockPath === join(run.toolsDir, HANDOFF_LOCK_NAME)
    && run.marker === `herdr-run:${run.runId}`;
  if (!consistent) throw new HandoffError(code, "Handoff run paths are inconsistent", { path: safePath(run.directory) });
}

async function assertTrustedDirectory(path: string, subject: string): Promise<void> {
  let value;
  try {
    value = await lstat(path);
  } catch {
    throw new HandoffError("HANDOFF_ARTIFACT_UNTRUSTED", `${subject} directory is unavailable`, { path: safePath(path) });
  }
  try {
    assertOwnerOnlyDirectory(path, value, (message) => new HandoffError("HANDOFF_ARTIFACT_UNTRUSTED", message), subject);
  } catch (error) {
    /* c8 ignore start -- assertOwnerOnlyDirectory only ever throws the HandoffError this factory mints, so the remap below is unreachable. */
    if (error instanceof HandoffError) throw error;
    throw new HandoffError("HANDOFF_ARTIFACT_UNTRUSTED", `${subject} directory is not trusted`, { path: safePath(path) });
    /* c8 ignore stop */
  }
}

/** Same-directory temp + fsync + rename + directory fsync, 0600 throughout. */
async function writeFileAtomic(path: string, data: string): Promise<void> {
  const directory = dirname(path);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  /* c8 ignore next -- O_NOFOLLOW is defined on every POSIX platform the flock sidecar runs on; the `?? 0` is a non-POSIX guard. */
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    handle = await open(temporary, flags, 0o600);
  } catch (error) {
    throw new HandoffError("HANDOFF_STORE_FAILED", "Handoff state could not be staged", { path: safePath(path), causeCode: (error as { code?: unknown }).code });
  }
  try {
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    /* c8 ignore next -- file-handle writes only ever reject with errno errors, never a HandoffError. */
    if (error instanceof HandoffError) throw error;
    throw new HandoffError("HANDOFF_STORE_FAILED", "Handoff state could not be written", { path: safePath(path) });
  }
  try {
    await rename(temporary, path);
  } catch {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new HandoffError("HANDOFF_STORE_FAILED", "Handoff state could not be committed", { path: safePath(path) });
  }
  let dirHandle;
  try {
    dirHandle = await open(directory, constants.O_RDONLY);
    await dirHandle.sync();
  } catch {
    throw new HandoffError("HANDOFF_STORE_FAILED", "Handoff state directory could not be synced", { path: safePath(path) });
  } finally {
    await dirHandle?.close().catch(() => undefined);
  }
}

export interface HandoffAllocator {
  /**
   * Resolve the namespace and mint a run. Creates only the shared namespace
   * directory; the run directory and sidecar are written by `persist` once the
   * manager identity is known, still before any launch effect.
   */
  allocate(): Promise<HandoffAllocation>;
  /** Create the run directory and `.tools`, then write `state.json` under the short flock. */
  persist(run: HandoffAllocation, identity: HandoffRunIdentity): Promise<void>;
}

export function createHandoffAllocator(options: {
  env?: NodeJS.ProcessEnv;
  namespace?: HandoffNamespace | (() => Promise<HandoffNamespace>);
  now?: () => Date;
} = {}): HandoffAllocator {
  const now = options.now ?? (() => new Date());
  let resolved: Promise<HandoffNamespace> | undefined;
  const namespace = (): Promise<HandoffNamespace> => {
    resolved ??= Promise.resolve(
      typeof options.namespace === "function" ? options.namespace() : options.namespace ?? resolveHandoffNamespace(options.env ?? process.env)
    ).catch((error: unknown) => {
      resolved = undefined;
      throw error instanceof HandoffError ? error : new HandoffError("HANDOFF_UNAVAILABLE", "Handoff namespace is unavailable");
    });
    return resolved;
  };
  return {
    async allocate() {
      return allocateIn(await namespace());
    },
    async persist(run, identity) {
      const ns = await namespace();
      assertRunPaths(run, "HANDOFF_STORE_FAILED");
      if (resolve(run.namespaceDir) !== resolve(ns.dir)) {
        throw new HandoffError("HANDOFF_STORE_FAILED", "Handoff run is outside this endpoint namespace", { path: safePath(run.directory) });
      }
      // A run directory is minted from a fresh UUID, so anything already there
      // is foreign: refuse rather than adopt it.
      try {
        await lstat(run.directory);
        throw new HandoffError("HANDOFF_STORE_FAILED", "Handoff run directory already exists", { path: safePath(run.directory) });
      } catch (error) {
        if (error instanceof HandoffError) throw error;
        if (!isNodeError(error, "ENOENT")) throw new HandoffError("HANDOFF_STORE_FAILED", "Handoff run directory is indeterminate", { path: safePath(run.directory) });
      }
      try {
        await mkdir(run.directory, { mode: 0o700 });
        await mkdir(run.toolsDir, { mode: 0o700 });
      } catch (error) {
        throw new HandoffError("HANDOFF_STORE_FAILED", "Handoff run directory could not be created", { path: safePath(run.directory), causeCode: (error as { code?: unknown}).code });
      }
      const state: HandoffState = {
        v: 1,
        runId: run.runId,
        endpoint: ns.endpoint,
        createdAt: now().toISOString(),
        manager: { paneId: identity.manager.paneId, display: identity.manager.display, source: identity.manager.source },
        child: {
          agentName: identity.child.agentName,
          agentKind: identity.child.agentKind,
          candidateName: identity.child.candidateName,
          specLabel: identity.child.specLabel,
          fallbackCandidates: [...identity.child.fallbackCandidates],
          paneId: null,
          terminalId: null,
          agentId: null
        },
        nativeSession: null,
        lifecycle: { state: "awaiting_handoff", watermark: null },
        artifact: { path: run.artifactPath, sha256: null, bytes: null, version: 0 },
        repair: { attempts: 0, fence: null }
      };
      const holder = await acquireFlockHolder({
        lockPath: run.lockPath,
        wait: "nonblock",
        readyMarker: HANDOFF_LOCK_READY,
        subject: "Handoff state lock",
        failure: (message) => new HandoffError("HANDOFF_STORE_FAILED", message, { path: safePath(run.lockPath) })
      });
      try {
        await writeFileAtomic(run.statePath, JSON.stringify(state));
      } finally {
        await holder.release().catch(() => undefined);
      }
    }
  };
}

/** Bound on flock's own contention wait for one sidecar section. */
const HANDOFF_LOCK_WAIT_MS = 5_000;
const HANDOFF_STATE_MAX_BYTES = HANDOFF_MAX_BYTES;

function stateRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHandoffState(content: string, run: HandoffAllocation): HandoffState {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new HandoffError("HANDOFF_STORE_FAILED", "Handoff state is malformed", { path: safePath(run.statePath) });
  }
  const state = value as HandoffState;
  if (!stateRecord(state) || state.v !== 1 || state.runId !== run.runId
    || !stateRecord(state.lifecycle) || !stateRecord(state.artifact) || !stateRecord(state.repair)) {
    throw new HandoffError("HANDOFF_STORE_FAILED", "Handoff state is malformed", { path: safePath(run.statePath) });
  }
  return state;
}

/**
 * Read the sidecar without the flock. Writers commit whole documents via
 * same-directory rename, so a reader either sees the last committed state or
 * fails; the leaf itself is re-verified regular, owned, owner-only, and bounded.
 */
export async function readHandoffState(run: HandoffAllocation): Promise<HandoffState> {
  assertRunPaths(run, "HANDOFF_STORE_FAILED");
  let leaf;
  try {
    leaf = await lstat(run.statePath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) throw new HandoffError("HANDOFF_STORE_FAILED", "Handoff state is missing", { path: safePath(run.statePath) });
    throw new HandoffError("HANDOFF_STORE_FAILED", "Handoff state is indeterminate", { path: safePath(run.statePath) });
  }
  if (!leaf.isFile() || leaf.isSymbolicLink() || leaf.uid !== uid() || (Number(leaf.mode) & 0o22) !== 0 || leaf.nlink !== 1 || leaf.size > HANDOFF_STATE_MAX_BYTES) {
    throw new HandoffError("HANDOFF_STORE_FAILED", "Handoff state is not trusted", { path: safePath(run.statePath) });
  }
  let content: string;
  try {
    content = await readFile(run.statePath, "utf8");
  } catch {
    throw new HandoffError("HANDOFF_STORE_FAILED", "Handoff state could not be read", { path: safePath(run.statePath) });
  }
  if (Buffer.byteLength(content, "utf8") > HANDOFF_STATE_MAX_BYTES) {
    throw new HandoffError("HANDOFF_STORE_FAILED", "Handoff state exceeds the accepted bound", { path: safePath(run.statePath) });
  }
  return parseHandoffState(content, run);
}

/**
 * Serialize one read-modify-write of the sidecar under the run's native flock.
 * The mutation returns nothing; the committed state is handed back so callers
 * can refresh their cached projection from exactly what was persisted.
 */
export async function updateHandoffState(run: HandoffAllocation, mutate: (state: HandoffState) => void): Promise<HandoffState> {
  assertRunPaths(run, "HANDOFF_STORE_FAILED");
  const holder = await acquireFlockHolder({
    lockPath: run.lockPath,
    wait: { timeoutMs: HANDOFF_LOCK_WAIT_MS },
    readyMarker: HANDOFF_LOCK_READY,
    subject: "Handoff state lock",
    failure: (message) => new HandoffError("HANDOFF_STORE_FAILED", message, { path: safePath(run.lockPath) })
  });
  try {
    const state = await readHandoffState(run);
    mutate(state);
    await writeFileAtomic(run.statePath, JSON.stringify(state));
    return state;
  } finally {
    await holder.release().catch(() => undefined);
  }
}

export const HANDOFF_HEADINGS = ["Status", "Summary", "Changes", "Verification", "Blockers", "Continuation"] as const;
export const HANDOFF_STATUSES = ["done", "blocked", "cancelled", "failed"] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

const HEADING_PATTERN = /^#{1,6}\s+(.+?)\s*$/;
const MARKER_PATTERN = /^herdr-run:(\S+)$/;
const PLACEHOLDER_PATTERN = /^(<[^>]*>|\.{2,}|todo|tbd|fixme|placeholder|n\/a)$/i;
const NONE_PATTERN = /^none$/i;

/** The one block appended to every mandatory assignment before size validation. */
export function renderHandoffContract(run: HandoffAllocation): string {
  return [
    "",
    "",
    "Handoff:",
    `When the assignment is done, blocked, cancelled, or failed, write exactly one Markdown file at this exact path: ${run.artifactPath}`,
    `The first line of the file must be this run marker verbatim: ${run.marker}`,
    "After writing it, run `chmod 600` on that exact path so Tools can trust the artifact.",
    "It must then contain exactly these six headings in this order, each followed by non-empty content, and no other headings:",
    "",
    "## Status",
    "done, blocked, cancelled, or failed",
    "",
    "## Summary",
    "What you did.",
    "",
    "## Changes",
    "One '- <path>' line per changed path, or None.",
    "",
    "## Verification",
    "The checks you ran and their outcomes.",
    "",
    "## Blockers",
    "What remains blocked, or None.",
    "",
    "## Continuation",
    "Remaining work, or None."
  ].join("\n");
}

export interface HandoffArtifact {
  runId: string;
  status: HandoffStatus;
  sections: Record<(typeof HANDOFF_HEADINGS)[number], string>;
  bytes: number;
  sha256: string;
}

function invalid(reason: string): HandoffError {
  return new HandoffError("HANDOFF_ARTIFACT_INVALID", "Handoff artifact is invalid", { reason });
}

/**
 * Parse artifact bytes against the fixed contract: one run-marker line before
 * the first heading, exactly the six headings in order, non-empty non-placeholder
 * bodies, an enumerated status, and a `None`-or-bullet Changes list.
 */
export function parseHandoffArtifact(content: string, expectedMarker: string): Omit<HandoffArtifact, "bytes" | "sha256"> {
  if (content.includes("\0")) throw invalid("nul_byte");
  const lines = content.split("\n");
  const markerIndexes = lines.flatMap((line, index) => MARKER_PATTERN.test(line.trim()) ? [index] : []);
  if (markerIndexes.length !== 1) throw invalid(markerIndexes.length === 0 ? "marker_missing" : "marker_duplicate");
  const marker = MARKER_PATTERN.exec(lines[markerIndexes[0]!]!.trim())!;
  if (marker[0] !== expectedMarker) throw invalid("foreign_run");
  const headings = lines.flatMap((line, index) => {
    const match = HEADING_PATTERN.exec(line);
    return match ? [{ index, level: line.indexOf(" "), name: match[1]! }] : [];
  });
  if (markerIndexes[0]! > (headings[0]?.index ?? lines.length)) throw invalid("marker_after_heading");
  if (headings.length !== HANDOFF_HEADINGS.length || headings.some((heading, position) => heading.level !== 2 || heading.name !== HANDOFF_HEADINGS[position])) {
    throw invalid("headings_mismatch");
  }
  const sections = {} as Record<(typeof HANDOFF_HEADINGS)[number], string>;
  for (const [position, heading] of headings.entries()) {
    const body = lines.slice(heading.index + 1, headings[position + 1]?.index ?? lines.length).join("\n").trim();
    if (body.length === 0) throw invalid(`empty:${heading.name}`);
    if (PLACEHOLDER_PATTERN.test(body)) throw invalid(`placeholder:${heading.name}`);
    sections[HANDOFF_HEADINGS[position]!] = body;
  }
  if (!(HANDOFF_STATUSES as readonly string[]).includes(sections.Status)) throw invalid("status");
  if (NONE_PATTERN.test(sections.Summary) || NONE_PATTERN.test(sections.Verification)) throw invalid("placeholder");
  if (!NONE_PATTERN.test(sections.Changes)) {
    const entries = sections.Changes.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    if (entries.length === 0 || entries.some((line) => !/^-\s+\S/.test(line))) throw invalid("changes");
  }
  return { runId: marker[1]!, status: sections.Status as HandoffStatus, sections };
}

/**
 * Read and validate the run's artifact. The path is reconstructed from the
 * allocation, never taken from the caller; every directory component and the
 * leaf are lstat-checked, and the leaf is opened O_NOFOLLOW and re-verified on
 * its descriptor before a bounded read.
 */
export async function readHandoffArtifact(run: HandoffAllocation): Promise<HandoffArtifact> {
  assertRunPaths(run, "HANDOFF_ARTIFACT_UNTRUSTED");
  await assertTrustedDirectory(run.namespaceDir, "Handoff state");
  await assertTrustedDirectory(run.directory, "Handoff run");
  let leaf;
  try {
    leaf = await lstat(run.artifactPath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) throw new HandoffError("HANDOFF_ARTIFACT_MISSING", "Handoff artifact is missing", { path: safePath(run.artifactPath) });
    throw new HandoffError("HANDOFF_ARTIFACT_UNTRUSTED", "Handoff artifact is indeterminate", { path: safePath(run.artifactPath) });
  }
  if (!leaf.isFile() || leaf.isSymbolicLink() || leaf.uid !== uid() || (Number(leaf.mode) & 0o22) !== 0 || leaf.nlink !== 1) {
    throw new HandoffError("HANDOFF_ARTIFACT_UNTRUSTED", "Handoff artifact is not trusted", { path: safePath(run.artifactPath) });
  }
  let handle;
  try {
    /* c8 ignore next -- O_NOFOLLOW is defined on every POSIX platform the handoff runs on; the `?? 0` is a non-POSIX guard. */
    handle = await open(run.artifactPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (isNodeError(error, "ENOENT") || isNodeError(error, "ELOOP")) throw new HandoffError("HANDOFF_ARTIFACT_MISSING", "Handoff artifact is missing", { path: safePath(run.artifactPath) });
    throw new HandoffError("HANDOFF_ARTIFACT_UNTRUSTED", "Handoff artifact is indeterminate", { path: safePath(run.artifactPath) });
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== uid() || (Number(stat.mode) & 0o22) !== 0 || stat.nlink !== 1) {
      throw new HandoffError("HANDOFF_ARTIFACT_UNTRUSTED", "Handoff artifact is not trusted", { path: safePath(run.artifactPath) });
    }
    if (stat.size > HANDOFF_MAX_BYTES) throw new HandoffError("HANDOFF_ARTIFACT_OVERSIZED", "Handoff artifact exceeds the accepted bound", { bytes: stat.size, limit: HANDOFF_MAX_BYTES });
    const buffer = Buffer.alloc(HANDOFF_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, HANDOFF_MAX_BYTES + 1, 0);
    if (bytesRead > HANDOFF_MAX_BYTES) throw new HandoffError("HANDOFF_ARTIFACT_OVERSIZED", "Handoff artifact exceeds the accepted bound", { bytes: bytesRead, limit: HANDOFF_MAX_BYTES });
    const content = buffer.subarray(0, bytesRead).toString("utf8");
    const parsed = parseHandoffArtifact(content, run.marker);
    return { ...parsed, bytes: bytesRead, sha256: createHash("sha256").update(content, "utf8").digest("hex") };
  } finally {
    await handle.close().catch(() => undefined);
  }
}
