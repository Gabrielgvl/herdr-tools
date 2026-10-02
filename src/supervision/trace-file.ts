/**
 * The shared trust chain for reading an agent's native trace file (ADR-040
 * amendment, node C), lifted from the Claude quota scanner so the retirement
 * tail read and the quota tail read prove the same things before trusting a
 * byte: every named directory is a real, unlinked, owner-owned directory; the
 * leaf is a regular, unlinked, owner-owned file; the descriptor is opened
 * `O_NOFOLLOW` and its `fstat` identity (`dev`, `ino`) must equal the lstat
 * record, so a file swapped between the two reads is refused, not read.
 *
 * Write bits: the caller names the forbidden mode bits. The quota scanner
 * keeps its historical `0o022` (group or world writable refuses); the
 * retirement reader forbids world-writable (`0o002`) only, because Pi and
 * Devin write their session files under the agent CLI's own `002` umask
 * (`-rw-rw-r--` on the reference host) — a same-UID private group, not a
 * foreign writer — and a stricter bit would refuse every Pi and Devin lane
 * forever. Same-UID agents are cooperative, not isolated (handoff.ts).
 *
 * Failures are typed and path-free: `missing`, `untrusted`, `unreadable`.
 */
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, open } from "node:fs/promises";
import type { Stats } from "node:fs";

export type TraceFileFailure = "missing" | "untrusted" | "unreadable";

export class TraceFileError extends Error {
  constructor(readonly failure: TraceFileFailure, readonly reason: string) {
    super(`trace file ${failure}: ${reason}`);
    this.name = "TraceFileError";
  }
}

/** Mode bits a trusted trace leaf or directory must not carry. */
export const TRACE_FILE_FORBID_WORLD_WRITE = 0o002;
export const TRACE_FILE_FORBID_GROUP_WORLD_WRITE = 0o022;

export interface OpenTrustedTraceFileOptions {
  /** Directories to prove owner-only before the leaf is touched, in order. */
  directories?: readonly string[];
  /** Forbidden mode bits on every checked node (default: world-writable). */
  forbidModeBits?: number;
}

export interface TrustedTraceFile {
  handle: FileHandle;
  /** The number-based `fstat` of the opened descriptor — the verified EOF is `stat.size`. */
  stat: Stats;
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

/**
 * Open `path` through the trust chain. The caller owns the returned handle
 * and must close it. Throws `TraceFileError` only.
 */
export async function openTrustedTraceFile(path: string, options: OpenTrustedTraceFileOptions = {}): Promise<TrustedTraceFile> {
  const forbid = options.forbidModeBits ?? TRACE_FILE_FORBID_WORLD_WRITE;
  const owner = process.getuid?.();
  for (const directory of options.directories ?? []) {
    let stats: Stats;
    try {
      stats = await lstat(directory);
    } catch (error) {
      throw new TraceFileError(isNodeError(error, "ENOENT") ? "missing" : "unreadable", "directory_stat");
    }
    if (!stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== owner || (stats.mode & forbid) !== 0) {
      throw new TraceFileError("untrusted", "directory");
    }
  }
  let leaf: Stats;
  try {
    leaf = await lstat(path);
  } catch (error) {
    throw new TraceFileError(isNodeError(error, "ENOENT") ? "missing" : "unreadable", "leaf_stat");
  }
  if (!leaf.isFile() || leaf.isSymbolicLink() || leaf.uid !== owner || (leaf.mode & forbid) !== 0) {
    throw new TraceFileError("untrusted", "leaf");
  }
  let handle: FileHandle;
  try {
    /* c8 ignore next -- O_NOFOLLOW exists on every platform that ships flock. */
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    throw new TraceFileError(isNodeError(error, "ENOENT") || isNodeError(error, "ELOOP") ? "missing" : "unreadable", "open");
  }
  let stat: Stats;
  try {
    stat = await handle.stat();
    /* c8 ignore start -- fstat on a descriptor just opened fails only on a dying filesystem. */
  } catch {
    await handle.close().catch(() => undefined);
    throw new TraceFileError("unreadable", "fstat");
  }
  /* c8 ignore stop */
  /* c8 ignore start -- the opened inode diverges from the lstat record only when the file is swapped between the two reads; O_NOFOLLOW pins it otherwise. */
  if (!stat.isFile() || stat.dev !== leaf.dev || stat.ino !== leaf.ino || stat.uid !== owner || (stat.mode & forbid) !== 0) {
    await handle.close().catch(() => undefined);
    throw new TraceFileError("untrusted", "descriptor");
  }
  /* c8 ignore stop */
  return { handle, stat };
}
