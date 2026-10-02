import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { devinCliDataDir } from "./devin-trace.js";
import type { AgentSessionRecord } from "./protocol.js";

/**
 * The Devin counterpart of `claude-quota.ts`: a typed read of Devin's own
 * per-process log for the account-wide free-model rate limit. Devin CLI
 * writes one log per process at `$XDG_DATA_HOME/devin/cli/logs/
 * devin_<YYYYMMDD-HHMMSS>_<pid>.log`; each process hosts one session, named
 * by its `session_db` lines (`Created new session: <id>`, `... for session
 * <id>`), and the session id is the pane's `agent_session` value. A stalled
 * turn is the control loop's `ERROR ... Exhausted inference retries; stopping
 * turn` line carrying the rate-limit message — the `WARN attempt=N` retries
 * before it are not a stall. `retryNotBefore` is that line's own timestamp
 * plus the delay the message states; nothing is guessed, and pane text is
 * never read (task output can quote the same phrase).
 */

const SESSION_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const LOG_NAME = /^devin_\d{8}-\d{6}_\d+\.log$/;
const SESSION_LINE = /(?:Created new session: |for session )([a-z0-9-]+)\b/u;
const LIMIT_LINE = /^(\S+) ERROR affogato::agent::control_loop: attempts=\d+ error=Inference\(ServerError\(message=Reached free model rate limit\.(.*)\)\) Exhausted inference retries; stopping turn\s*$/u;
const RESET_IN = /Your limit will reset in (\d+) (second|minute|hour)s?\b/u;
const UNIT_MS: Record<string, number> = { second: 1000, minute: 60_000, hour: 3_600_000 };
const TAIL_BYTES = 256 * 1024;
/** Newest-first candidate logs read per check; one process per session keeps the bound small. */
const MAX_LOGS = 32;

export interface DevinQuotaEvidence {
  /** The provider's own reset instant (ISO), or null when the line stated none. */
  retryNotBefore: string | null;
}

export type DevinQuotaSignal = false | DevinQuotaEvidence;

/** A log the current user owns outright; Devin creates them group-readable, so only world-writable is refused. */
function trusted(stats: { isFile(): boolean; isSymbolicLink(): boolean; uid: number; mode: number }): boolean {
  return stats.isFile() && !stats.isSymbolicLink() && stats.uid === process.getuid?.() && (stats.mode & 0o002) === 0;
}

/** The bounded tail of one log as whole lines; a partial first or last line is dropped. */
async function tailLines(path: string, expected: { dev: number; ino: number }): Promise<string[] | undefined> {
  /* c8 ignore next -- O_NOFOLLOW exists on every platform that ships flock. */
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    /* c8 ignore next -- the opened inode diverges from the lstat record only when the file is swapped between the two reads. */
    if (!trusted(opened) || opened.dev !== expected.dev || opened.ino !== expected.ino) return undefined;
    const start = Math.max(0, opened.size - TAIL_BYTES);
    const bytes = Buffer.alloc(Math.min(opened.size, TAIL_BYTES));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
    const text = bytes.subarray(0, bytesRead).toString("utf8");
    const lines = text.split("\n");
    if (start > 0) lines.shift();
    if (!text.endsWith("\n")) lines.pop();
    return lines;
  } finally {
    await handle.close();
  }
}

/**
 * Scan one log's tail. The log belongs to the session only when its tail
 * names that session and no other; then the last stall line at or after
 * `notBeforeMs` is the verdict. `undefined` means the log is another
 * process's — keep looking; `false` means it is this session's log and shows
 * no stall in the window.
 */
function scan(lines: string[], sessionId: string, notBeforeMs: number): DevinQuotaSignal | undefined {
  let bound = false;
  let limit: DevinQuotaSignal = false;
  for (const line of lines) {
    const named = SESSION_LINE.exec(line);
    if (named !== null) {
      if (named[1] !== sessionId) return undefined;
      bound = true;
      continue;
    }
    const stall = LIMIT_LINE.exec(line);
    if (stall === null) continue;
    const at = Date.parse(stall[1]!);
    if (!Number.isFinite(at) || at < notBeforeMs) continue;
    const reset = RESET_IN.exec(stall[2]!);
    limit = { retryNotBefore: reset === null ? null : new Date(at + Number(reset[1]) * UNIT_MS[reset[2]!]!).toISOString() };
  }
  return bound ? limit : undefined;
}

/**
 * The Devin log format is external and unversioned; the exact line shapes
 * above were observed on Devin CLI 2026-10-02 and anything else fails closed.
 * `notBeforeMs` is the cycle's prompt time: only a stall logged at or after it
 * counts, and only logs still written since then are candidates.
 */
export async function devinQuotaSignal(session: AgentSessionRecord, notBeforeMs: number, logsDir = join(devinCliDataDir(), "logs")): Promise<DevinQuotaSignal> {
  if (session.source !== "herdr:devin" || session.agent !== "devin" || session.kind !== "id" || !SESSION_ID.test(session.value)) return false;
  try {
    const candidates: Array<{ path: string; mtimeMs: number; dev: number; ino: number }> = [];
    for (const name of await readdir(logsDir)) {
      if (!LOG_NAME.test(name)) continue;
      const path = join(logsDir, name);
      const stats = await lstat(path);
      if (!trusted(stats) || stats.mtimeMs < notBeforeMs) continue;
      candidates.push({ path, mtimeMs: stats.mtimeMs, dev: stats.dev, ino: stats.ino });
    }
    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
    for (const candidate of candidates.slice(0, MAX_LOGS)) {
      const lines = await tailLines(candidate.path, candidate);
      if (lines === undefined) continue;
      const verdict = scan(lines, session.value, notBeforeMs);
      if (verdict !== undefined) return verdict;
    }
    return false;
  } catch {
    // Unreadable or untrusted native evidence never becomes an availability verdict.
    return false;
  }
}
