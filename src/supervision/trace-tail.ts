/**
 * The ADR-040 retirement tail scan (amendment node D): a supervisor-independent
 * proof that a handed-off child received no follow-up after the accepted
 * artifact was written.
 *
 * The anchor is the accepted artifact's write time persisted on the sidecar
 * (`artifact.mtimeMs`, recorded when that content was first validated). The
 * child's native trace — Claude JSONL, Pi JSONL, or Devin ATIF — is read
 * **once**, from an fstat-verified EOF, through a bounded tail
 * (`TRACE_TAIL_BUDGET_BYTES`), and scanned backwards. Any user turn — a prompt
 * submitted to the agent, including the runtime's own repair prompt, hints,
 * slash commands and interruptions — timestamped at or after the anchor is a
 * follow-up. Before anything is interpreted the trace must still *extend* the
 * history fingerprint captured at validation (`artifact.traceHistory`); a
 * shorter trace or a prefix mismatch is a same-session rollback (`/revert`,
 * compaction rewrite, recycled file) and refuses.
 *
 * Append order is not timestamp-monotonic (observed: Claude non-user records
 * up to 83 s backwards, Devin `system`/`agent` steps up to 345 s), so the
 * reverse scan never stops at the first record older than the anchor. One
 * rule serves both early exit and the budget verdict: the scan stops only
 * once it reaches a timestamped record older than `anchor − TRACE_TAIL_SLACK_MS`;
 * a tail read from `start > 0` that never reaches that boundary cannot vouch
 * for the unscanned prefix and is `ambiguous:scan_budget`. A whole-file scan
 * (`start === 0`) returns `none` without the boundary.
 *
 * Everything unprovable refuses: an unterminated record at EOF (a user turn
 * may be mid-flush), a user turn without a parseable timestamp, a Pi
 * compaction at or after the anchor, a Claude session-id drift inside the
 * tail, a Pi `custom_message` of unknown origin, a malformed line or step, an
 * unreadable or untrusted source. Results carry only fixed vocabulary and
 * counts — never a path or record content.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { HANDOFF_TRACE_KINDS, type HandoffTraceHistory, type HandoffTraceKind, type HandoffWorkspaceRecord } from "../handoff.js";
import type { AgentSessionIdentity } from "../messages/prompt.js";
import { claudeSessionTrace } from "./claude-quota.js";
import { checkStep, DEVIN_SOURCE_MAX_BYTES, devinSessionFilenameSafe, devinTranscriptsDir, hashSteps, parseDevinDocument } from "./devin-trace.js";
import { openTrustedTraceFile, TraceFileError } from "./trace-file.js";
import { DevinSourceError } from "./trace-source.js";

/** The post-anchor tail the scan is willing to read: one Devin source ceiling. */
export const TRACE_TAIL_BUDGET_BYTES = DEVIN_SOURCE_MAX_BYTES;
/** How far below the anchor a record must sit before the prefix is proven clear of follow-ups. */
export const TRACE_TAIL_SLACK_MS = 10 * 60_000;
/** The prefix bytes the JSONL history fingerprint hashes. */
export const TRACE_HISTORY_ANCHOR_BYTES = 1024;

export type TailScanFailureKind = "source_unreadable" | "source_malformed" | "source_exceeds_budget" | "session_pointer_invalid" | "source_rewritten";

export type TailScan =
  | { kind: "none" }
  | { kind: "user_turn"; atMs: number }
  | { kind: "pending_tail" }
  | { kind: "ambiguous"; reason: string }
  | { kind: "failure"; failure: TailScanFailureKind; reason: string };

/** The child whose trace is read: its kind, native session, and the launch workspace (Claude's path derives from it). */
export interface TraceTailTarget {
  agentKind: string;
  session: AgentSessionIdentity;
  workspace?: HandoffWorkspaceRecord;
}

export interface TraceTailDeps {
  /** Home directory for the Claude project chain; production uses the process owner's. */
  home?: string;
  /** Devin record directory override. */
  devinTranscriptsDir?: string;
  /** Test seam: absolute Pi session paths resolve beneath this directory. */
  rootDir?: string;
  /** The trust-chain opener; tests count or fault it. */
  openFile?: typeof openTrustedTraceFile;
}

type Located =
  | { kind: "claude-jsonl" | "pi-jsonl"; path: string; directories: readonly string[] }
  | { kind: "devin-session"; path: string; sessionId: string };

type Locate = Located | { failure: "session_pointer_invalid"; reason: string };

const utf8 = new TextDecoder("utf-8", { fatal: true });
const NEWLINE = 0x0a;
/* c8 ignore next -- a read-only descriptor's close has nothing left to fail on; the swallow only keeps a verdict from turning into a sweep fault. */
const ignoreClose = (): undefined => undefined;
const DEVIN_SOURCES = new Set(["system", "user", "agent"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function parseInstant(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function locate(target: TraceTailTarget, deps: TraceTailDeps): Locate {
  const kind = HANDOFF_TRACE_KINDS[target.agentKind];
  if (kind === "claude-jsonl") {
    if (target.workspace === undefined) return { failure: "session_pointer_invalid", reason: "workspace_unbound" };
    const trace = claudeSessionTrace(target.session, target.workspace.resolvedCwd, deps.home ?? homedir());
    if (trace === undefined) return { failure: "session_pointer_invalid", reason: "claude_session" };
    return { kind, path: trace.path, directories: trace.directories };
  }
  if (kind === "pi-jsonl") {
    if (target.session.kind !== "path") return { failure: "session_pointer_invalid", reason: "kind_not_path" };
    if (!isAbsolute(target.session.value)) return { failure: "session_pointer_invalid", reason: "path_not_absolute" };
    return { kind, path: deps.rootDir === undefined ? target.session.value : join(deps.rootDir, target.session.value), directories: [] };
  }
  if (kind === "devin-session") {
    if (target.session.kind !== "id") return { failure: "session_pointer_invalid", reason: "kind_not_id" };
    if (!devinSessionFilenameSafe(target.session.value)) return { failure: "session_pointer_invalid", reason: "id_not_filename_safe" };
    return { kind, path: join(deps.devinTranscriptsDir ?? devinTranscriptsDir(), `${target.session.value}.json`), sessionId: target.session.value };
  }
  return { failure: "session_pointer_invalid", reason: "kind_unsupported" };
}

/** One classified record: a user turn, anything else, or a shape the scan cannot place. */
type Turn =
  | { kind: "user"; atMs: number }
  | { kind: "other"; atMs: number | undefined }
  | { kind: "ambiguous"; reason: string };

function blockTypes(message: unknown): string[] {
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content.flatMap((block) => (isRecord(block) && typeof block.type === "string" ? [block.type] : []));
}

/** §2.1: a prompt submitted to the Claude agent — not tool output, not runtime-injected context, not a sidechain. */
function claudeTurn(record: Record<string, unknown>, sessionId: string): Turn {
  if (typeof record.sessionId === "string" && record.sessionId !== sessionId) return { kind: "ambiguous", reason: "session_drift" };
  const atMs = parseInstant(record.timestamp);
  if (record.type !== "user") return { kind: "other", atMs };
  const message = record.message;
  if (!isRecord(message) || message.role !== "user") return { kind: "other", atMs };
  if (record.toolUseResult !== undefined || blockTypes(message).includes("tool_result")) return { kind: "other", atMs };
  if (record.isMeta === true || record.isCompactSummary === true || record.isSidechain === true) return { kind: "other", atMs };
  const content = message.content;
  const prompt = (typeof content === "string" && content.length > 0) || blockTypes(message).includes("text");
  if (!prompt) return { kind: "other", atMs };
  return atMs === undefined ? { kind: "ambiguous", reason: "timestamp_missing" } : { kind: "user", atMs };
}

/** §2.2: a Pi `message` of role `user`; an extension `custom_message` counts unless it declares `fromHook`; compaction at or after the anchor is unplaceable. */
function piTurn(record: Record<string, unknown>, anchorMs: number): Turn {
  const message = isRecord(record.message) ? record.message : undefined;
  const atMs = parseInstant(record.timestamp)
    ?? (typeof message?.timestamp === "number" && Number.isFinite(message.timestamp) ? message.timestamp : undefined);
  if (record.type === "compaction") {
    return atMs === undefined || atMs >= anchorMs ? { kind: "ambiguous", reason: "compaction" } : { kind: "other", atMs };
  }
  const user = (record.type === "message" && message?.role === "user")
    || (record.type === "custom_message" && record.fromHook !== true && message?.fromHook !== true);
  if (!user) return { kind: "other", atMs };
  return atMs === undefined ? { kind: "ambiguous", reason: "timestamp_missing" } : { kind: "user", atMs };
}

/** §2.3: a Devin step whose `source` is `user`. */
function devinTurn(step: Record<string, unknown>): Turn {
  const atMs = parseInstant(step.timestamp);
  if (step.source !== "user") return { kind: "other", atMs };
  return atMs === undefined ? { kind: "ambiguous", reason: "timestamp_missing" } : { kind: "user", atMs };
}

/**
 * The single reverse-scan rule (F14): classify from the end; a user turn at or
 * after the anchor refuses; the scan is complete only once a timestamped
 * record older than the slack boundary is reached.
 */
function scanBackwards(turns: readonly Turn[], anchorMs: number): { scan: TailScan; reachedSlack: boolean } {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    if (turn.kind === "ambiguous") return { scan: { kind: "ambiguous", reason: turn.reason }, reachedSlack: false };
    if (turn.kind === "user" && turn.atMs >= anchorMs) return { scan: { kind: "user_turn", atMs: turn.atMs }, reachedSlack: false };
    if (turn.atMs !== undefined && turn.atMs <= anchorMs - TRACE_TAIL_SLACK_MS) return { scan: { kind: "none" }, reachedSlack: true };
  }
  return { scan: { kind: "none" }, reachedSlack: false };
}

function unreadable(error: unknown): TailScan {
  if (error instanceof TraceFileError) return { kind: "failure", failure: "source_unreadable", reason: `${error.failure}:${error.reason}` };
  throw error;
}

/**
 * A positional read that fills `length` bytes or stops at EOF. A descriptor
 * I/O failure (EIO, ESTALE, EBADF, …: any error carrying an errno-style code)
 * becomes the bounded `unreadable` refusal; anything else is a programming
 * defect and propagates.
 */
async function pread(handle: { read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }> }, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    let bytesRead: number;
    try {
      ({ bytesRead } = await handle.read(buffer, filled, length - filled, position + filled));
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code)) throw new TraceFileError("unreadable", `read:${code}`);
      throw error;
    }
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

async function scanJsonl(located: Extract<Located, { kind: "claude-jsonl" | "pi-jsonl" }>, sessionId: string, anchorMs: number, history: HandoffTraceHistory, deps: TraceTailDeps): Promise<TailScan> {
  const position = history.position;
  if (!("offset" in position)) return { kind: "failure", failure: "source_rewritten", reason: "history_kind" };
  let opened;
  try {
    opened = await (deps.openFile ?? openTrustedTraceFile)(located.path, { directories: located.directories });
  } catch (error) {
    return unreadable(error);
  }
  const { handle, stat } = opened;
  try {
    const size = stat.size;
    // F15 rollback proof, before anything else is interpreted.
    if (size < position.offset) return { kind: "failure", failure: "source_rewritten", reason: "truncated" };
    const span = Math.min(TRACE_HISTORY_ANCHOR_BYTES, position.offset);
    const prefix = await pread(handle, position.offset - span, span);
    if (prefix.length !== span || sha256Hex(prefix) !== position.anchor) return { kind: "failure", failure: "source_rewritten", reason: "anchor_mismatch" };

    const start = Math.max(0, size - TRACE_TAIL_BUDGET_BYTES);
    const tail = await pread(handle, start, size - start);
    if (tail.length !== size - start) return { kind: "failure", failure: "source_rewritten", reason: "short_read" };
    if (tail.length > 0 && tail[tail.length - 1] !== NEWLINE) return { kind: "pending_tail" };

    const turns: Turn[] = [];
    let index = 0;
    if (start > 0) {
      // The first line began before `start`: drop it whole.
      const newline = tail.indexOf(NEWLINE);
      index = newline + 1;
    }
    while (index < tail.length) {
      const newline = tail.indexOf(NEWLINE, index);
      let parsed: unknown;
      try {
        parsed = JSON.parse(utf8.decode(tail.subarray(index, newline)));
      } catch {
        return { kind: "failure", failure: "source_malformed", reason: `record:${start + index}` };
      }
      if (!isRecord(parsed) || typeof parsed.type !== "string" || parsed.type.length === 0) {
        return { kind: "failure", failure: "source_malformed", reason: `record:${start + index}` };
      }
      turns.push(located.kind === "claude-jsonl" ? claudeTurn(parsed, sessionId) : piTurn(parsed, anchorMs));
      index = newline + 1;
    }
    const { scan, reachedSlack } = scanBackwards(turns, anchorMs);
    if (scan.kind !== "none") return scan;
    // F14: a partial tail is proven only once it reached the slack boundary.
    if (start > 0 && !reachedSlack) return { kind: "ambiguous", reason: "scan_budget" };
    return scan;
  } catch (error) {
    return unreadable(error);
  } finally {
    await handle.close().catch(ignoreClose);
  }
}

async function scanDevin(located: Extract<Located, { kind: "devin-session" }>, anchorMs: number, history: HandoffTraceHistory, deps: TraceTailDeps): Promise<TailScan> {
  const position = history.position;
  if (!("steps" in position)) return { kind: "failure", failure: "source_rewritten", reason: "history_kind" };
  let opened;
  try {
    opened = await (deps.openFile ?? openTrustedTraceFile)(located.path);
  } catch (error) {
    return unreadable(error);
  }
  const { handle, stat } = opened;
  try {
    if (stat.size > TRACE_TAIL_BUDGET_BYTES) return { kind: "failure", failure: "source_exceeds_budget", reason: "document" };
    const data = await pread(handle, 0, stat.size);
    let steps: unknown[];
    const turns: Turn[] = [];
    try {
      steps = parseDevinDocument(data, located.sessionId);
      // F15 rollback proof: the document must still extend the validated prefix.
      if (steps.length < position.steps) return { kind: "failure", failure: "source_rewritten", reason: "steps_truncated" };
      if (hashSteps(steps, position.steps) !== position.anchor) return { kind: "failure", failure: "source_rewritten", reason: "anchor_mismatch" };
      for (let index = 0; index < steps.length; index += 1) {
        const step = checkStep(steps[index], index);
        if (!DEVIN_SOURCES.has(step.source as string)) return { kind: "failure", failure: "source_malformed", reason: `step:${index + 1}:source_unknown` };
        turns.push(devinTurn(step));
      }
    } catch (error) {
      if (error instanceof DevinSourceError && (error.failure === "source_malformed" || error.failure === "source_exceeds_budget")) {
        return { kind: "failure", failure: error.failure, reason: typeof error.detail?.reason === "string" ? error.detail.reason : "document" };
      }
      /* c8 ignore next -- parseDevinDocument and checkStep throw only the two DevinSourceError kinds mapped above. */
      throw error;
    }
    // The whole document was read: `none` needs no slack boundary.
    return scanBackwards(turns, anchorMs).scan;
  } catch (error) {
    return unreadable(error);
  } finally {
    await handle.close().catch(ignoreClose);
  }
}

/**
 * One bounded read of the child's native trace, judged against the persisted
 * anchor and history fingerprint. Never throws for source conditions.
 */
export async function tailScan(target: TraceTailTarget, anchorMs: number, history: HandoffTraceHistory, deps: TraceTailDeps = {}): Promise<TailScan> {
  const located = locate(target, deps);
  if ("failure" in located) return { kind: "failure", failure: located.failure, reason: located.reason };
  if (located.kind !== history.kind) return { kind: "failure", failure: "source_rewritten", reason: "history_kind" };
  return located.kind === "devin-session"
    ? scanDevin(located, anchorMs, history, deps)
    : scanJsonl(located, target.session.value, anchorMs, history, deps);
}

/**
 * The history fingerprint the gate persists beside the anchor at first
 * validation: for JSONL the verified EOF less any pending tail (the byte after
 * the last newline) and the SHA-256 of the ≤1 KiB before it; for Devin the
 * step count and `hashSteps` prefix hash. `undefined` when the source cannot
 * be located, trusted, read or bounded — the retire check then refuses
 * `trace_history_missing`, so a failed capture is fail closed, never silent.
 */
export async function captureTraceHistory(
  identity: { agentKind: string; agentSession: AgentSessionIdentity },
  workspace: HandoffWorkspaceRecord | undefined,
  signal: AbortSignal,
  deps: TraceTailDeps = {},
): Promise<HandoffTraceHistory | undefined> {
  const kind: HandoffTraceKind | undefined = HANDOFF_TRACE_KINDS[identity.agentKind];
  if (kind === undefined || signal.aborted) return undefined;
  const located = locate({ agentKind: identity.agentKind, session: identity.agentSession, ...(workspace === undefined ? {} : { workspace }) }, deps);
  if ("failure" in located) return undefined;
  let opened;
  try {
    opened = await (deps.openFile ?? openTrustedTraceFile)(located.path, located.kind === "devin-session" ? {} : { directories: located.directories });
  } catch {
    return undefined;
  }
  const { handle, stat } = opened;
  try {
    const session = { ...identity.agentSession };
    if (located.kind === "devin-session") {
      if (stat.size > TRACE_TAIL_BUDGET_BYTES) return undefined;
      let steps: unknown[];
      try {
        steps = parseDevinDocument(await pread(handle, 0, stat.size), located.sessionId);
      } catch {
        return undefined;
      }
      return { kind, session, position: { session: located.sessionId, steps: steps.length, anchor: hashSteps(steps, steps.length) } };
    }
    const size = stat.size;
    const start = Math.max(0, size - TRACE_TAIL_BUDGET_BYTES);
    const tail = await pread(handle, start, size - start);
    const lastNewline = tail.lastIndexOf(NEWLINE);
    // A tail of unterminated bytes longer than the budget hides where the last record ended.
    if (lastNewline === -1 && start > 0) return undefined;
    const offset = lastNewline === -1 ? 0 : start + lastNewline + 1;
    const span = Math.min(TRACE_HISTORY_ANCHOR_BYTES, offset);
    const prefix = offset - span >= start ? tail.subarray(offset - span - start, offset - start) : await pread(handle, offset - span, span);
    /* c8 ignore next -- the prefix lies inside the file by construction; a short read means the file shrank mid-capture. */
    if (prefix.length !== span) return undefined;
    return { kind, session, position: { path: located.kind === "pi-jsonl" ? identity.agentSession.value : located.path, offset, anchor: sha256Hex(prefix) } };
  } catch (error) {
    // A descriptor read failure is a failed capture (the lane then refuses
    // `trace_history_missing`); a programming defect still propagates.
    if (error instanceof TraceFileError) return undefined;
    throw error;
  } finally {
    await handle.close().catch(ignoreClose);
  }
}
