import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentSessionRecord } from "./protocol.js";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAIL_BYTES = 512 * 1024;

/** Claude Code 2.1.281 emitted these typed fields in two observed Fable quota sessions.
 * Its JSONL format is external and may change; unknown shapes fail closed.
 * The project slug is only a candidate location, never identity evidence. */
export async function claudeQuotaSignal(session: AgentSessionRecord, cwd: string, notBeforeMs: number, home = homedir()): Promise<boolean> {
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
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== stats.dev || opened.ino !== stats.ino || opened.uid !== process.getuid?.() || (opened.mode & 0o22) !== 0) return false;
      const start = Math.max(0, opened.size - TAIL_BYTES);
      const bytes = Buffer.alloc(Math.min(opened.size, TAIL_BYTES));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
      const text = bytes.subarray(0, bytesRead).toString("utf8");
      const lines = text.split("\n");
      if (start > 0) lines.shift(); // the first line may be partial
      if (!text.endsWith("\n")) lines.pop(); // never trust a writer's partial record
      for (const line of lines) {
        let record: unknown;
        try { record = JSON.parse(line); } catch { continue; }
        if (record === null || typeof record !== "object" || Array.isArray(record)) continue;
        const value = record as Record<string, unknown>;
        if (value.type === "assistant" && value.sessionId === session.value && value.cwd === cwd
          && value.isApiErrorMessage === true && value.error === "rate_limit" && value.apiErrorStatus === 429
          && typeof value.requestId === "string" && value.requestId.length > 0
          && typeof value.timestamp === "string" && Number.isFinite(Date.parse(value.timestamp))
          && Date.parse(value.timestamp) >= notBeforeMs) return true;
      }
      return false;
    } finally {
      await handle.close();
    }
  } catch {
    // Unreadable or untrusted native evidence never becomes an availability verdict.
    return false;
  }
}
