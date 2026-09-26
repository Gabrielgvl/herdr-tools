import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentSessionRecord } from "./protocol.js";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAIL_BYTES = 512 * 1024;

/**
 * What one trusted scan of the Claude session record proves. The record file
 * is the provider source: when it carries a reset signal the caller records it
 * as `retryNotBefore`, and `null` means it gave none — never a synthesized ETA.
 * `zeroProgressProven` is true only when the post-prompt window is provably
 * complete AND contains nothing but the prompt and provider error responses:
 * no tool calls, no ordinary assistant output, no foreign record types. A
 * Claude child's only mutation channel is tool calls, so a transcript this
 * clean proves no workspace mutation as well. Any truncation or unrecognized
 * record fails closed to false.
 */
export interface ClaudeQuotaEvidence {
  /** The provider's own reset instant (ISO), or null when the record carried none. */
  retryNotBefore: string | null;
  /** See the interface doc: provable absence of any task activity after prompt submission. */
  zeroProgressProven: boolean;
}

export type ClaudeQuotaSignal = false | ClaudeQuotaEvidence;

/** Absolute reset instants the provider may type onto the record. */
const RESET_INSTANT_FIELDS = ["retryNotBefore", "resetAt", "resetsAt", "retryAt", "reset_at", "retry_at"] as const;
/** Relative reset delays (seconds) the provider may type onto the record. */
const RESET_AFTER_SECONDS_FIELDS = ["retryAfterSeconds", "retry_after_seconds", "retryAfter", "retry_after"] as const;
/** Relative reset delays (milliseconds). */
const RESET_AFTER_MS_FIELDS = ["retryAfterMs", "retry_after_ms"] as const;
/** Claude's explicit retry timestamp inside limit text: `usage limit reached|<epoch>`. */
const LIMIT_RESET_TEXT = /limit reached\|(\d{10,13})/iu;

function epochishMs(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  // 1e12 ms is 2001-09-09; anything below is epoch seconds.
  return Math.abs(value) < 1e12 ? value * 1000 : value;
}

function instantFieldMs(value: unknown): number | undefined {
  if (typeof value === "number") return epochishMs(value);
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * The matching limit record's own reset signal, in epoch ms. Typed fields win
 * (headers-derived retry delays, quota-JSON reset instants), then the explicit
 * timestamp embedded in the limit message text. A candidate that is not finite
 * or not strictly after the record's own timestamp is untrusted and skipped;
 * absent evidence returns undefined — never a guess.
 */
function resetSignalMs(record: Record<string, unknown>, recordMs: number): number | undefined {
  for (const field of RESET_INSTANT_FIELDS) {
    const ms = instantFieldMs(record[field]);
    if (ms !== undefined && ms > recordMs) return ms;
  }
  for (const field of RESET_AFTER_SECONDS_FIELDS) {
    const delay = record[field];
    if (typeof delay === "number" && Number.isFinite(delay) && delay > 0) return recordMs + delay * 1000;
  }
  for (const field of RESET_AFTER_MS_FIELDS) {
    const delay = record[field];
    if (typeof delay === "number" && Number.isFinite(delay) && delay > 0) return recordMs + delay;
  }
  const message = record.message;
  const texts: unknown[] = typeof message === "string"
    ? [message]
    : record !== null && typeof message === "object" && !Array.isArray(message) && Array.isArray((message as Record<string, unknown>).content)
      ? (message as { content: unknown[] }).content
      : [];
  for (const block of texts) {
    const text = typeof block === "string" ? block
      : typeof block === "object" && block !== null ? (block as Record<string, unknown>).text : undefined;
    if (typeof text !== "string") continue;
    const match = LIMIT_RESET_TEXT.exec(text);
    if (match === null) continue;
    // A 10–13 digit capture is always a finite integer; sub-1e12 reads as epoch seconds.
    const epoch = Number(match[1]);
    const ms = epoch < 1e12 ? epoch * 1000 : epoch;
    if (ms > recordMs) return ms;
  }
  return undefined;
}

/** Content-block types on the record's message, for tool-activity detection. */
function blockTypes(record: Record<string, unknown>): string[] {
  const message = record.message;
  if (typeof message !== "object" || message === null || Array.isArray(message)) return [];
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (typeof block !== "object" || block === null) return [];
    const type = (block as Record<string, unknown>).type;
    return typeof type === "string" ? [type] : [];
  });
}

/**
 * In-window records that cannot be task activity: the submitted prompt itself
 * (a user record carrying no tool results) and typed provider errors (an
 * assistant API-error record carrying no tool calls). Everything else — tool
 * use, real assistant output, summaries, file-history snapshots, foreign
 * record types — is task activity and defeats the zero-progress proof.
 */
function benignRecord(record: Record<string, unknown>): boolean {
  if (record.type === "user") {
    return record.toolUseResult === undefined && !blockTypes(record).includes("tool_result");
  }
  return record.type === "assistant" && record.isApiErrorMessage === true && !blockTypes(record).includes("tool_use");
}

/** Claude Code 2.1.281 emitted these typed fields in two observed Fable quota sessions.
 * Its JSONL format is external and may change; unknown shapes fail closed.
 * The project slug is only a candidate location, never identity evidence. */
export async function claudeQuotaSignal(session: AgentSessionRecord, cwd: string, notBeforeMs: number, home = homedir()): Promise<ClaudeQuotaSignal> {
  if (session.source !== "herdr:claude" || session.agent !== "claude" || session.kind !== "id"
    || !SESSION_ID.test(session.value) || !cwd.startsWith("/")) return false;
  const directory = join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  const path = join(directory, `${session.value}.jsonl`);
  try {
    for (const entry of [home, join(home, ".claude"), join(home, ".claude", "projects"), directory]) {
      const stats = await lstat(entry);
      if (!stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== process.getuid?.() || (stats.mode & 0o22) !== 0) return false;
    }
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.uid !== process.getuid?.() || (stats.mode & 0o22) !== 0) return false;
    /* c8 ignore next -- O_NOFOLLOW exists on every platform that ships flock. */
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      /* c8 ignore next -- the opened inode diverges from the lstat record only when the file is swapped between the two reads; O_NOFOLLOW pins it otherwise. */
      if (!opened.isFile() || opened.dev !== stats.dev || opened.ino !== stats.ino || opened.uid !== process.getuid?.() || (opened.mode & 0o22) !== 0) return false;
      const start = Math.max(0, opened.size - TAIL_BYTES);
      const bytes = Buffer.alloc(Math.min(opened.size, TAIL_BYTES));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
      const text = bytes.subarray(0, bytesRead).toString("utf8");
      const lines = text.split("\n");
      if (start > 0) lines.shift(); // the first line may be partial
      if (!text.endsWith("\n")) lines.pop(); // never trust a writer's partial record
      let limited = false;
      let resetMs: number | undefined;
      // The tail covers the whole post-prompt window only when it reaches back
      // past the prompt (or begins at the file head). Otherwise earlier task
      // activity could hide above the read window — fail closed.
      let boundarySeen = start === 0;
      let clean = true;
      for (const line of lines) {
        let value: unknown;
        try { value = JSON.parse(line); } catch { continue; }
        if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
        const entry = value as Record<string, unknown>;
        if (entry.sessionId !== session.value || entry.cwd !== cwd) continue;
        const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
        if (Number.isFinite(at) && at < notBeforeMs) {
          boundarySeen = true;
          continue;
        }
        if (!Number.isFinite(at)) {
          // An unorderable record for this session cannot be excluded from the
          // post-prompt window, so the window is unprovable.
          clean = false;
          continue;
        }
        if (entry.type === "assistant" && entry.isApiErrorMessage === true && entry.error === "rate_limit"
          && entry.apiErrorStatus === 429 && typeof entry.requestId === "string" && entry.requestId.length > 0) {
          limited = true;
          resetMs = resetSignalMs(entry, at) ?? resetMs;
          continue;
        }
        if (!benignRecord(entry)) clean = false;
      }
      if (!limited) return false;
      return {
        retryNotBefore: resetMs === undefined ? null : new Date(resetMs).toISOString(),
        zeroProgressProven: clean && boundarySeen
      };
    } finally {
      await handle.close();
    }
  } catch {
    // Unreadable or untrusted native evidence never becomes an availability verdict.
    return false;
  }
}
