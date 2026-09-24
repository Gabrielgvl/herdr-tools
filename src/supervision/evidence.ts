/**
 * The ADR-036 deterministic execution digest (E1), the read-only
 * per-cadence workspace view (E2), and the assembled outbound evidence
 * state (E3). The workspace section begins after the digest exports, the
 * state builder after the workspace exports; every builder is pure code
 * output — no model writes or summarizes any of them.
 *
 * A trace window's events compact into a fixed-vocabulary action sequence —
 * read / search / edit / command — plus a bounded list of unclassified tool
 * calls and a per-kind count of events carrying no tool activity at all. The
 * digest is code output end to end: no model writes or summarizes it.
 *
 * Compaction rules:
 *
 * - Only adjacent, identical, non-causal actions merge: `count` tracks the
 *   run length and `first`/`last` keep the run's source positions, so the
 *   first and last occurrence of any repeat survive.
 * - Causal actions never merge: every edit (a write changes workspace
 *   state), every tool-reported error, and every non-zero exit keeps its own
 *   entry. An `edit → failing command → edit → passing command` chain always
 *   survives intact and in order.
 * - Commands carry the exit code and duration the source itself records.
 *   Devin exec results end in the tool's own `Exit code: N` footer (the last
 *   match wins — a command's output can echo the marker; the tool's trailer
 *   is final). Pi's bash tool appends `Command exited with code N` only on
 *   failure, so a Pi code is parsed only when `isError` is set — a clean Pi
 *   command records no code, and an absent `exitCode` is an honest "not
 *   recorded", never an inferred 0. Pi `durationMs` is the runner's own
 *   call→result timestamp interval; ATIF carries no per-call duration, so
 *   Devin commands honestly omit it.
 * - Calls and results pair by the source's own call id inside the window. A
 *   result whose call was consumed by an earlier window still emits its own
 *   entry — a non-zero exit at a window boundary is never lost.
 * - Cursors enter as references, never payloads: `{source, position, hash}`
 *   where `hash` is SHA-256 over the cursor's canonical serialization. A
 *   tmux cursor holds raw terminal lines — hashing pins its identity without
 *   leaking transcript content.
 * - No record content crosses: `target` is a bounded tool-call argument and
 *   `terminal-line` records are counted, never embedded. The digest holds no
 *   transcript text, no message prose, no observation output, and no diff.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { TraceCursor, TraceEvent, TraceFailure, TraceSourceKind, TraceWindow } from "./trace-source.js";

export const EXECUTION_DIGEST_VERSION = 2;

export const DIGEST_ACTION_CLASSES = ["read", "search", "edit", "command"] as const;
export type DigestActionClass = (typeof DIGEST_ACTION_CLASSES)[number];

/** Per-field bounds keep one record's content from crowding the digest. */
const TOOL_NAME_MAX_CHARS = 64;
const TARGET_MAX_CHARS = 160;
const KIND_MAX_CHARS = 128;

/**
 * A cursor's identity without its payload: the source label, a
 * source-relative position hint (Pi byte offset, Devin consumed steps, tmux
 * snapshot line count), and the SHA-256 over the cursor's canonical
 * serialization. Two cursor refs are equal iff the cursors are.
 */
export interface DigestCursorRef {
  source: TraceSourceKind;
  position?: number;
  hash: string;
}

/** One classified action; `count > 1` marks a compacted repeat run. */
export interface DigestAction {
  class: DigestActionClass;
  /** The source's tool name, bounded. */
  tool: string;
  /** Bounded tool-call argument: the file, pattern, or command text. */
  target?: string;
  count: number;
  /** Event offset of the first / last merged occurrence. */
  first: number;
  last: number;
  /** Command class only: the exit code the source recorded. */
  exitCode?: number;
  /** Command class only: the source-recorded call→result interval in ms. */
  durationMs?: number;
  /** The tool reported failure (Pi `isError`). */
  error?: true;
}

/** An unclassified tool call — outside the four-class vocabulary but never dropped. */
export interface DigestOtherTool {
  tool: string;
  target?: string;
  count: number;
  first: number;
  last: number;
  error?: true;
}

export interface ExecutionDigest {
  version: number;
  source: TraceSourceKind;
  /** Events and source bytes this window consumed. */
  events: number;
  bytes: number;
  cursorFrom?: DigestCursorRef;
  cursorTo?: DigestCursorRef;
  /** Oldest fallback delta lines omitted by the trace byte budget. */
  droppedPrefix?: number;
  /** The window's typed failure, verbatim — a failed source stays typed. */
  failure?: TraceFailure;
  /** The compacted causal sequence over the four classes, in event order. */
  actions: DigestAction[];
  /** Compacted unclassified tool calls, in event order. */
  other: DigestOtherTool[];
  /** Events with no tool activity, counted by event kind (messages, terminal lines, session records). */
  incidental: Record<string, number>;
}

/**
 * The closed tool-name → class vocabulary, matched case-insensitively. Names
 * absent here land in `other`; semantic classification beyond a name table is
 * V2.2's job, not this builder's.
 */
const TOOL_CLASS: Record<string, DigestActionClass> = {
  read: "read",
  webfetch: "read",
  grep: "search",
  find: "search",
  glob: "search",
  ls: "search",
  search: "search",
  web_search: "search",
  find_file_by_name: "search",
  fffind: "search",
  ctx_search: "search",
  write: "edit",
  edit: "edit",
  multi_edit: "edit",
  notebook_edit: "edit",
  apply_patch: "edit",
  bash: "command",
  exec: "command",
  shell: "command",
  run: "command",
  run_command: "command",
  write_to_process: "command",
  ctx_execute: "command",
  ctx_execute_file: "command",
  ctx_batch_execute: "command",
};

/** Argument keys that identify what a call acted on, in preference order. */
const TARGET_KEYS = ["command", "pattern", "query", "skill", "file_path", "notebook_path", "path", "url", "file", "code", "commands", "queries"] as const;

/** The shell-runner exit markers both sources append after command output. */
const EXIT_CODE_PATTERN = /(?:Command exited with code|Exit code:)\s*(-?\d+)/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Codepoint-safe bound; a trailing ellipsis marks the cut. */
function bounded(text: string, maxChars: number): string {
  const chars = [...text];
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join("")}…` : text;
}

function classify(name: string): DigestActionClass | undefined {
  return TOOL_CLASS[name.toLowerCase()];
}

function pickValue(value: unknown): string | undefined {
  if (typeof value === "string") return value === "" ? undefined : value;
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => (typeof item === "string" ? item : pickTarget(item)))
      .filter((part): part is string => part !== undefined);
    return parts.length > 0 ? parts.join("; ") : undefined;
  }
  return undefined;
}

/** The call's target: first known argument key, else an MCP server:tool pair. */
function pickTarget(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined;
  for (const key of TARGET_KEYS) {
    const picked = pickValue(args[key]);
    if (picked !== undefined) return bounded(picked, TARGET_MAX_CHARS);
  }
  if (typeof args.server_name === "string" && typeof args.tool_name === "string") {
    return bounded(`${args.server_name}:${args.tool_name}`, TARGET_MAX_CHARS);
  }
  return undefined;
}

/** Result content to text: a bare string, or the joined text parts of a Pi content list. */
function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("");
  }
  return undefined;
}

/** The last exit marker wins — a command's output can echo the phrase; the tool's trailer is final. */
function parseExitCode(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  let code: number | undefined;
  for (const match of text.matchAll(EXIT_CODE_PATTERN)) {
    const parsed = Number.parseInt(match[1]!, 10);
    code = Number.isSafeInteger(parsed) ? parsed : code;
  }
  return code;
}

/** A millisecond timestamp: the runner's epoch-ms number, or an ISO string parsed. */
function msOf(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

interface RawAction {
  cls: DigestActionClass | undefined;
  tool: string;
  target: string | undefined;
  /** The event's source-relative offset. */
  at: number;
  error?: true;
  exitCode?: number;
  durationMs?: number;
  /** Internal pairing state: the call-side timestamp a result interval measures from. */
  callTs?: number;
}

function newAction(name: string, args: unknown, at: number, callTs?: number): RawAction {
  const action: RawAction = { cls: classify(name), tool: bounded(name, TOOL_NAME_MAX_CHARS), target: pickTarget(args), at };
  if (callTs !== undefined) action.callTs = callTs;
  return action;
}

/**
 * Attach a result's outcome to an action. Pi reports failure via `isError`
 * and writes an exit marker only then; Devin has no error flag, but the exec
 * footer is always present, so its code parses unconditionally. Duration is
 * the source's own call→result interval and only fills a Pi pairing.
 */
function attachOutcome(action: RawAction, text: string | undefined, isError: boolean, resultTs: number | undefined, source: TraceSourceKind): void {
  if (isError) action.error = true;
  if (action.cls !== "command") return;
  const code = source === "pi-jsonl" && !isError ? undefined : parseExitCode(text);
  if (code !== undefined) action.exitCode = code;
  if (resultTs !== undefined && action.callTs !== undefined && resultTs >= action.callTs) {
    action.durationMs = resultTs - action.callTs;
  }
}

/**
 * Pi: assistant `message` records carry `toolCall` content items; `toolResult`
 * records answer them by `toolCallId`. Pairing is consumed-once so a result
 * can never double-count. A result with no in-window call emits its own
 * action — the outcome survives the window boundary.
 */
function extractPi(events: TraceEvent[], raw: RawAction[], incidental: Map<string, number>): void {
  const pending = new Map<string, RawAction>();
  for (const event of events) {
    const record = isRecord(event.record) ? event.record : undefined;
    const message = event.kind === "message" && record !== undefined && isRecord(record.message) ? record.message : undefined;
    if (message === undefined) {
      bump(incidental, event.kind);
      continue;
    }
    if (message.role === "toolResult") {
      const text = contentText(message.content);
      const resultTs = msOf(message.timestamp) ?? msOf(record?.timestamp);
      const id = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
      const call = id === undefined ? undefined : pending.get(id);
      if (id !== undefined && call !== undefined) {
        pending.delete(id);
        attachOutcome(call, text, message.isError === true, resultTs, "pi-jsonl");
      } else {
        const orphan = newAction(typeof message.toolName === "string" ? message.toolName : "unpaired_result", undefined, event.offset);
        attachOutcome(orphan, text, message.isError === true, resultTs, "pi-jsonl");
        raw.push(orphan);
      }
      continue;
    }
    let calls = 0;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const item of message.content) {
        if (!isRecord(item) || item.type !== "toolCall") continue;
        const action = newAction(
          typeof item.name === "string" ? item.name : "malformed_tool_call",
          item.arguments,
          event.offset,
          msOf(message.timestamp) ?? msOf(record?.timestamp),
        );
        if (typeof item.id === "string") pending.set(item.id, action);
        raw.push(action);
        calls += 1;
      }
    }
    if (calls === 0) bump(incidental, event.kind);
  }
}

/**
 * Devin: `agent` steps carry `tool_calls` and `observation.results` paired
 * within the step by `source_call_id`. A result keyed to no call in its step
 * is corrupt-but-visible — it lands in `other`, never parsed as a command
 * (arbitrary file content can echo an exit marker).
 */
function extractDevin(events: TraceEvent[], raw: RawAction[], incidental: Map<string, number>): void {
  for (const event of events) {
    const record = event.record;
    if (event.kind !== "agent" || !isRecord(record) || !Array.isArray(record.tool_calls) || record.tool_calls.length === 0) {
      bump(incidental, event.kind);
      continue;
    }
    const results = new Map<string, Record<string, unknown>>();
    const observation = record.observation;
    if (isRecord(observation) && Array.isArray(observation.results)) {
      for (const result of observation.results) {
        if (isRecord(result) && typeof result.source_call_id === "string") {
          results.set(result.source_call_id, result);
        } else {
          raw.push({ cls: undefined, tool: "malformed_tool_result", target: undefined, at: event.offset });
        }
      }
    }
    for (const call of record.tool_calls) {
      const name = isRecord(call) && typeof call.function_name === "string" ? call.function_name : "malformed_tool_call";
      const action = newAction(name, isRecord(call) ? call.arguments : undefined, event.offset);
      const id = isRecord(call) && typeof call.tool_call_id === "string" ? call.tool_call_id : undefined;
      const result = id === undefined ? undefined : results.get(id);
      if (id !== undefined && result !== undefined) {
        results.delete(id);
        attachOutcome(action, typeof result.content === "string" ? result.content : undefined, false, undefined, "devin-session");
      }
      raw.push(action);
    }
    // A result keyed to no call in its step is corrupt-but-visible; its id is
    // its only identity, so each stays a distinct `other` entry.
    for (const id of results.keys()) {
      raw.push({ cls: undefined, tool: "unpaired_result", target: bounded(id, TARGET_MAX_CHARS), at: event.offset });
    }
  }
}

function bump(incidental: Map<string, number>, kind: string): void {
  const key = bounded(kind, KIND_MAX_CHARS);
  incidental.set(key, (incidental.get(key) ?? 0) + 1);
}

/** An edit, an error, or a non-zero exit is causal and never merges away. */
function causal(action: { cls: DigestActionClass | undefined; error?: true; exitCode?: number }): boolean {
  return action.cls === "edit" || action.error === true || (action.exitCode !== undefined && action.exitCode !== 0);
}

function sameSignature(a: RawAction, b: RawAction): boolean {
  return a.cls === b.cls && a.tool === b.tool && a.target === b.target && a.error === b.error && a.exitCode === b.exitCode;
}

interface CompactEntry extends RawAction {
  count: number;
  first: number;
  last: number;
}

/**
 * Merge adjacent identical non-causal repeats into one entry; durations sum
 * when every member reports one, else the merged entry honestly omits the
 * total. Causal entries always break the run.
 */
function compact(raw: RawAction[]): { actions: CompactEntry[]; other: CompactEntry[] } {
  const actions: CompactEntry[] = [];
  const other: CompactEntry[] = [];
  let previous: RawAction | undefined;
  for (const action of raw) {
    const out = action.cls === undefined ? other : actions;
    const last = out[out.length - 1];
    const adjacentMatch = previous !== undefined && sameSignature(previous, action);
    previous = action;
    if (last !== undefined && adjacentMatch && !causal(last) && !causal(action)) {
      last.count += 1;
      last.last = action.at;
      last.durationMs = last.durationMs !== undefined && action.durationMs !== undefined ? last.durationMs + action.durationMs : undefined;
      continue;
    }
    out.push({ ...action, count: 1, first: action.at, last: action.at });
  }
  return { actions, other };
}

function toDigestAction(entry: CompactEntry): DigestAction {
  const action: DigestAction = { class: entry.cls as DigestActionClass, tool: entry.tool, count: entry.count, first: entry.first, last: entry.last };
  if (entry.target !== undefined) action.target = entry.target;
  if (entry.exitCode !== undefined) action.exitCode = entry.exitCode;
  if (entry.durationMs !== undefined) action.durationMs = entry.durationMs;
  if (entry.error === true) action.error = true;
  return action;
}

function toOtherTool(entry: CompactEntry): DigestOtherTool {
  const tool: DigestOtherTool = { tool: entry.tool, count: entry.count, first: entry.first, last: entry.last };
  if (entry.target !== undefined) tool.target = entry.target;
  if (entry.error === true) tool.error = true;
  return tool;
}

function cursorRef(cursor: TraceCursor): DigestCursorRef {
  const ref: DigestCursorRef = { source: cursor.source, hash: sha256Hex(canonicalJson(cursor)) };
  const position = cursorPosition(cursor);
  if (position !== undefined) ref.position = position;
  return ref;
}

function cursorPosition(cursor: TraceCursor): number | undefined {
  switch (cursor.source) {
    case "pi-jsonl":
      return Number.isSafeInteger(cursor.offset) ? cursor.offset : undefined;
    case "devin-session":
      return isRecord(cursor.position) && Number.isSafeInteger(cursor.position.steps) ? (cursor.position.steps as number) : undefined;
    case "tmux-fallback":
      return Array.isArray(cursor.window) ? cursor.window.length : undefined;
  }
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The pipeline's canonical form: object keys sorted at every depth, no
 * whitespace, `undefined` dropped. Identical content serializes to identical
 * bytes regardless of construction order — the digest's byte representation
 * and hash ride on it.
 */
export function canonicalJson(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === null || typeof value !== "object") {
    const primitive = JSON.stringify(value);
    return primitive === undefined ? "null" : primitive;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/** The window's deterministic digest: pure code output over the common trace events. */
export function buildExecutionDigest(window: TraceWindow): ExecutionDigest {
  const raw: RawAction[] = [];
  const incidental = new Map<string, number>();
  let droppedPrefix: number | undefined;
  switch (window.source) {
    case "pi-jsonl":
      extractPi(window.events, raw, incidental);
      break;
    case "devin-session":
      extractDevin(window.events, raw, incidental);
      break;
    case "tmux-fallback":
      for (const event of window.events) bump(incidental, event.kind);
      if (window.events[0] !== undefined && window.events[0].offset > 0) droppedPrefix = window.events[0].offset;
      break;
  }
  const { actions, other } = compact(raw);
  const digest: ExecutionDigest = {
    version: EXECUTION_DIGEST_VERSION,
    source: window.source,
    events: window.events.length,
    bytes: window.byteCount,
    actions: actions.map(toDigestAction),
    other: other.map(toOtherTool),
    incidental: Object.fromEntries(incidental),
  };
  if (window.cursorFrom !== undefined) digest.cursorFrom = cursorRef(window.cursorFrom);
  if (window.cursorTo !== undefined) digest.cursorTo = cursorRef(window.cursorTo);
  if (droppedPrefix !== undefined) digest.droppedPrefix = droppedPrefix;
  if (window.typedFailure !== undefined) digest.failure = window.typedFailure;
  return digest;
}

/** The digest's canonical byte representation: UTF-8 of its canonical JSON. */
export function executionDigestBytes(digest: ExecutionDigest): Uint8Array {
  return new TextEncoder().encode(canonicalJson(digest));
}

/** SHA-256 over the canonical bytes — the digest's content hash. */
export function executionDigestHash(digest: ExecutionDigest): string {
  return sha256Hex(canonicalJson(digest));
}

/**
 * The ADR-036 per-cadence workspace view (E2): a read-only git snapshot of the
 * supervised child's checkout, taken against the reservation's pinned base.
 *
 * - The workspace root is input, not discovery: it is the launch's resolved
 *   child `cwd` (`params.cwd ?? deps.cwd ?? ctx.cwd`, the same value launch
 *   hands `tab create --cwd` / `pane split --cwd`), carried through the
 *   reservation by W0/W1. The builder requires an absolute root and passes it
 *   to every command; it never reads `process.cwd()` — the supervisor's own
 *   launch directory says nothing about the child's checkout.
 * - The base is pinned once per reservation: the first build captures HEAD
 *   and reports it as `baseRevision`; the caller stores that value and passes
 *   it back on later cadences. A supplied base must be a full commit sha —
 *   the only pin this builder mints — so a moving ref can never silently
 *   re-anchor "what changed".
 * - Metadata always comes from `rev-parse --verify HEAD`,
 *   `status --porcelain=v1 -z`, and `diff --name-status`/`--numstat` against
 *   the base with an explicit `--` rev/path separator. Patch reads are added
 *   only for literal repo paths named by non-error edit actions in this trace
 *   window. Their unified hunks are bounded before they enter the view.
 * - `changedFiles` is the base→worktree delta (committed and uncommitted
 *   tracked changes) plus untracked paths, sorted and capped at
 *   `WORKSPACE_CHANGED_FILES_MAX`. `dirty` is the standard working-tree
 *   meaning — porcelain non-empty (uncommitted work or untracked files);
 *   head movement alone is reported by `headRevision`, not `dirty`.
 * - `stats` aggregates exactly the emitted set: `filesChanged` is the tracked
 *   entry count, `insertions`/`deletions` sum the numstat counts, and
 *   `untrackedFiles` counts untracked entries (git diff stats never include
 *   them). `fingerprint` is SHA-256 over the canonical full-resolution view
 *   before bounding, so two cadences fingerprint differently whenever the
 *   checkout differs — even inside the truncated tail.
 * - Every failure is an explicit `available: false` value with a typed
 *   reason — a git/read failure is never a fabricated clean workspace.
 *   Internal parse failures fail closed as `output_malformed`; diagnostics
 *   carry the git subcommand label and exit/error codes only, never output
 *   text (stderr can carry paths and content).
 */
export const WORKSPACE_VIEW_VERSION = 1;

/** Cap on emitted changed-file entries; overflow is counted in `omittedFiles`. */
export const WORKSPACE_CHANGED_FILES_MAX = 256;
/** Cap on files whose recent hunks may be read in one cadence. */
export const WORKSPACE_PATCH_FILES_MAX = 32;
/** The ADR-036 V2.2 patch slot. E3 re-applies it at the outbound boundary. */
export const EVIDENCE_PATCH_MAX_BYTES = 16 * 1024;
/** Codepoint bound on emitted repo-relative paths; a trailing ellipsis marks the cut. */
const WORKSPACE_PATH_MAX_CHARS = 512;
/** Git's standard context depth for a bounded recent hunk. */
const WORKSPACE_PATCH_CONTEXT_LINES = 3;
/** A pinned base is the full sha this builder minted — immutable by construction. */
const PINNED_REVISION_PATTERN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
/** Git reads are evidence, not interactive work: bounded time and output. */
const WORKSPACE_COMMAND_TIMEOUT_MS = 10_000;
const WORKSPACE_COMMAND_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export const WORKSPACE_FILE_STATUSES = ["added", "modified", "deleted", "renamed", "copied", "typechanged", "conflicted", "untracked"] as const;
export type WorkspaceFileStatus = (typeof WORKSPACE_FILE_STATUSES)[number];

export interface WorkspaceChangedFile {
  /** Repo-relative path, bounded; for `renamed`/`copied` this is the new path. */
  path: string;
  status: WorkspaceFileStatus;
  /** Numstat line counts vs the base; absent for untracked, binary, and conflicted entries. */
  added?: number;
  deleted?: number;
  /** Rename/copy source path, bounded. */
  from?: string;
}

export interface WorkspaceDiffStats {
  /** Tracked files differing from the pinned base. */
  filesChanged: number;
  insertions: number;
  deletions: number;
  /** Untracked paths — never inside git's own diff stats, so reported separately. */
  untrackedFiles: number;
}

/** One whole unified hunk for a file named by an edit in this cadence's trace. */
export interface WorkspacePatchHunk {
  path: string;
  header: string;
  lines: string[];
}

/** The bounded patch slot. Omission counts make every cut explicit. */
export interface WorkspacePatch {
  hunks: WorkspacePatchHunk[];
  omittedHunks: number;
  omittedFiles: number;
}

export type WorkspaceUnavailableReason =
  /** No command runner wired. */
  | "adapter_unavailable"
  /** Missing, relative, or unsafe root — the builder never guesses one. */
  | "root_invalid"
  /** A supplied base is not a full commit sha. */
  | "base_invalid"
  /** Git exited non-zero, timed out, or could not be spawned. */
  | "command_failed"
  /** Git output or the runner's own result failed to parse. */
  | "output_malformed"
  /** The read's signal aborted. */
  | "aborted";

export interface WorkspaceFailure {
  reason: WorkspaceUnavailableReason;
  /** Bounded, content-free diagnostics: the subcommand label, an exit code, an errno-style code. */
  detail?: Record<string, string | number | boolean>;
}

export interface WorkspaceViewOk {
  version: number;
  available: true;
  /** The reservation's pin — captured HEAD on the first build, the caller's pin after. */
  baseRevision: string;
  headRevision: string;
  /** Working-tree meaning: uncommitted tracked work or untracked files exist. */
  dirty: boolean;
  /** Sorted, bounded delta vs the base. */
  changedFiles: WorkspaceChangedFile[];
  /** Entries cut by `WORKSPACE_CHANGED_FILES_MAX`; the fingerprint still covers them. */
  omittedFiles: number;
  stats: WorkspaceDiffStats;
  fingerprint: string;
  /** Base-relative hunks only for files named by edit actions since the prior review. */
  patch?: WorkspacePatch;
}

export interface WorkspaceViewUnavailable {
  version: number;
  available: false;
  failure: WorkspaceFailure;
}

/** The per-cadence workspace evidence — either the snapshot or an explicit unavailable value. */
export type WorkspaceView = WorkspaceViewOk | WorkspaceViewUnavailable;

export interface WorkspaceViewRequest {
  /** The trusted launch workspace root. Required, absolute; never inferred from this process. */
  root: string;
  /** The reservation's pinned base (full sha). Absent ⇒ this build captures HEAD as the pin. */
  baseRevision?: string;
  /** Edit-action targets from the trace window that starts at the prior review's cursor. */
  writtenFiles?: readonly string[];
}

export interface WorkspaceCommandResult {
  stdout: string;
  exitCode: number;
}

/**
 * The injected native-command seam. `argv[0]` is the executable; `cwd` is the
 * one workspace root the command may observe. Non-zero exits return as data
 * (`exitCode`); only spawn/abort/overflow failures reject.
 */
export type WorkspaceCommandRunner = (argv: readonly [string, ...string[]], cwd: string, signal: AbortSignal) => Promise<WorkspaceCommandResult>;

export interface WorkspaceViewDeps {
  run?: WorkspaceCommandRunner;
}

const execFileAsync = promisify(execFile);

/**
 * The production runner: stdlib `execFile`, no shell, no git library. A
 * completed child's non-zero exit is data; spawn refusal, abort, timeout, and
 * the output ceiling reject and become typed failures at the builder.
 */
export function createNodeWorkspaceRunner(): WorkspaceCommandRunner {
  return async (argv, cwd, signal) => {
    const [command, ...args] = argv;
    try {
      const { stdout } = await execFileAsync(command, args, {
        cwd,
        signal,
        timeout: WORKSPACE_COMMAND_TIMEOUT_MS,
        maxBuffer: WORKSPACE_COMMAND_MAX_OUTPUT_BYTES,
        encoding: "utf8",
      });
      return { stdout, exitCode: 0 };
    } catch (error) {
      // On a non-zero exit execFile reports the exit code on `error.code` and
      // the decoded stdout alongside it; every other rejection is a real
      // failure (ENOENT, AbortError, kill, overflow) for the builder to type.
      const failed = error as { code?: unknown; stdout?: unknown };
      if (typeof failed.code === "number") return { stdout: failed.stdout as string, exitCode: failed.code };
      throw error;
    }
  };
}

function workspaceUnavailable(reason: WorkspaceUnavailableReason, detail?: WorkspaceFailure["detail"]): WorkspaceView {
  return { version: WORKSPACE_VIEW_VERSION, available: false, failure: { reason, ...(detail === undefined ? {} : { detail }) } };
}

/**
 * The only field a command error may contribute to a diagnostic. Codes are
 * vocabulary (`ENOENT`, `ABORT_ERR`); anything carrying spaces or length is a
 * message and is dropped — messages can hold paths and content.
 */
function commandErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[\w.-]{1,64}$/.test(code) ? code : undefined;
}

/**
 * Porcelain v1 -z records: `XY path\0`, with a rename/copy emitting its
 * destination record followed by the source record. Only `??` paths and the
 * dirty bit are evidence; `!!` is unreachable (we never pass --ignored) but
 * skipped rather than parsed if a runner emits it anyway.
 */
function parsePorcelainZ(text: string): { dirty: boolean; untracked: string[] } | undefined {
  const records = text.split("\0");
  const untracked: string[] = [];
  let dirty = false;
  for (let i = 0; i < records.length; i += 1) {
    const entry = records[i]!;
    if (entry === "") {
      if (i === records.length - 1) break;
      return undefined;
    }
    if (entry.length < 4 || entry[2] !== " ") return undefined;
    const x = entry[0]!;
    const y = entry[1]!;
    if (x === "!" && y === "!") continue;
    dirty = true;
    // A rename/copy may sit in either XY column (staged or worktree rename
    // detection); both emit the source path as the next record.
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      i += 1;
      if (records[i] === undefined || records[i] === "") return undefined;
    }
    if (x === "?" && y === "?") untracked.push(entry.slice(3));
  }
  return { dirty, untracked };
}

interface ParsedNameStatus {
  path: string;
  status: WorkspaceFileStatus;
  from?: string;
}

/** Name-status letters this pipeline reports; anything else fails closed. */
const NAME_STATUS: Record<string, WorkspaceFileStatus> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "typechanged",
  U: "conflicted",
};

/**
 * `git diff --name-status -z` records: `LETTER[score]\0path\0`, or
 * `R###\0from\0to\0` for rename/copy. The status is authoritative for the
 * emitted list — every entry's status is a real git letter.
 */
function parseNameStatusZ(text: string): ParsedNameStatus[] | undefined {
  const records = text.split("\0");
  const entries: ParsedNameStatus[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const token = records[i]!;
    if (token === "") {
      if (i === records.length - 1) break;
      return undefined;
    }
    const status = NAME_STATUS[token[0]!];
    if (status === undefined || !/^\d{0,3}$/.test(token.slice(1))) return undefined;
    if (status === "renamed" || status === "copied") {
      const from = records[i + 1];
      const to = records[i + 2];
      if (from === undefined || to === undefined || from === "" || to === "") return undefined;
      entries.push({ path: to, status, from });
      i += 2;
    } else {
      const path = records[i + 1];
      if (path === undefined || path === "") return undefined;
      entries.push({ path, status });
      i += 1;
    }
  }
  return entries;
}

/**
 * `git diff --numstat -z` records: `added\tdeleted\tpath\0`, `-` counts for
 * binary/unmerged files, and `added\tdeleted\t\0from\0to\0` for rename/copy
 * pairs. Keyed by the new path so name-status entries merge on `path`.
 */
function parseNumstatZ(text: string): Map<string, { added?: number; deleted?: number }> | undefined {
  const records = text.split("\0");
  const counts = new Map<string, { added?: number; deleted?: number }>();
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]!;
    if (record === "") {
      if (i === records.length - 1) break;
      return undefined;
    }
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(record);
    if (match === null) return undefined;
    let key = match[3]!;
    if (key === "") {
      const from = records[i + 1];
      const to = records[i + 2];
      if (from === undefined || to === undefined || from === "" || to === "") return undefined;
      key = to;
      i += 2;
    }
    const entry: { added?: number; deleted?: number } = {};
    if (match[1] !== "-") entry.added = Number.parseInt(match[1]!, 10);
    if (match[2] !== "-") entry.deleted = Number.parseInt(match[2]!, 10);
    counts.set(key, entry);
  }
  return counts;
}

function emptyWorkspacePatch(): WorkspacePatch {
  return { hunks: [], omittedHunks: 0, omittedFiles: 0 };
}

/** Keep a deterministic prefix of whole hunks. A hunk is never sliced into invented patch text. */
function boundWorkspacePatch(input: WorkspacePatch, capBytes: number): WorkspacePatch {
  const kept: WorkspacePatchHunk[] = [];
  let omittedHunks = input.omittedHunks + input.hunks.length;
  for (const hunk of input.hunks) {
    const candidate = { hunks: [...kept, hunk], omittedHunks: omittedHunks - 1, omittedFiles: input.omittedFiles };
    if (utf8Length(canonicalJson(candidate)) > capBytes) break;
    kept.push(hunk);
    omittedHunks -= 1;
  }
  return { hunks: kept, omittedHunks, omittedFiles: input.omittedFiles };
}

/** A trace target becomes a git path only when it resolves lexically inside the trusted root. */
function repoRelativePath(root: string, target: string): string | undefined {
  if (target === "" || /[\0\r\n]/.test(target)) return undefined;
  const path = relative(root, resolve(root, target));
  if (path === "" || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) return undefined;
  return path.split(sep).join("/");
}

/** Associate trace writes with the authoritative changed-file enumeration; failed/no-op writes produce no patch. */
function recentPatchFiles(root: string, writtenFiles: readonly string[], files: WorkspaceChangedFile[]): WorkspaceChangedFile[] {
  const byPath = new Map<string, WorkspaceChangedFile>();
  for (const file of files) {
    byPath.set(file.path, file);
    if (file.from !== undefined) byPath.set(file.from, file);
  }
  const selected = new Map<string, WorkspaceChangedFile>();
  for (const target of writtenFiles) {
    if (typeof target !== "string") continue;
    const path = repoRelativePath(root, target);
    const file = path === undefined ? undefined : byPath.get(path);
    if (file !== undefined) selected.set(file.path, file);
  }
  return [...selected.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Parse only unified hunk bodies. File headers and other git metadata never enter the evidence slot. */
function parseUnifiedHunks(path: string, text: string): WorkspacePatchHunk[] {
  if (text === "") return [];
  const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  const hunks: WorkspacePatchHunk[] = [];
  let current: WorkspacePatchHunk | undefined;
  for (const line of lines) {
    if (/^@@@? /.test(line)) {
      current = { path: bounded(path, WORKSPACE_PATH_MAX_CHARS), header: line, lines: [] };
      hunks.push(current);
    } else if (current !== undefined) {
      current.lines.push(line);
    }
  }
  return hunks;
}

/**
 * Build one cadence's workspace view. Never rejects: a git/read failure is a
 * typed `available: false` value, never a fabricated clean workspace. The
 * file list is name-status's enumeration with numstat counts merged by path;
 * a file that changes between the two reads keeps its status and honestly
 * omits its counts rather than guessing, and `stats` always describes the
 * emitted set.
 */
export async function buildWorkspaceView(request: WorkspaceViewRequest, deps: WorkspaceViewDeps, signal: AbortSignal): Promise<WorkspaceView> {
  const run = deps.run;
  if (run === undefined) return workspaceUnavailable("adapter_unavailable");
  const root = request.root;
  if (typeof root !== "string" || !isAbsolute(root) || /[\0\r\n]/.test(root)) return workspaceUnavailable("root_invalid");
  const pinned = request.baseRevision;
  if (pinned !== undefined && !PINNED_REVISION_PATTERN.test(pinned)) return workspaceUnavailable("base_invalid");

  const step = async (args: [string, ...string[]], differenceExit = false): Promise<{ stdout: string } | { failure: WorkspaceFailure }> => {
    if (signal.aborted) return { failure: { reason: "aborted" } };
    let result: WorkspaceCommandResult;
    try {
      result = await run(["git", ...args], root, signal);
    } catch (error) {
      if (signal.aborted) return { failure: { reason: "aborted" } };
      const code = commandErrorCode(error);
      return { failure: { reason: "command_failed", detail: { command: args[0], ...(code === undefined ? {} : { code }) } } };
    }
    if (signal.aborted) return { failure: { reason: "aborted" } };
    if (!isRecord(result) || typeof result.stdout !== "string" || !Number.isSafeInteger(result.exitCode)) {
      return { failure: { reason: "output_malformed", detail: { command: args[0] } } };
    }
    if (result.exitCode !== 0 && !(differenceExit && result.exitCode === 1)) {
      return { failure: { reason: "command_failed", detail: { command: args[0], exitCode: result.exitCode } } };
    }
    return { stdout: result.stdout };
  };

  const head = await step(["rev-parse", "--verify", "HEAD"]);
  if ("failure" in head) return workspaceUnavailable(head.failure.reason, head.failure.detail);
  const headRevision = head.stdout.trim();
  if (!PINNED_REVISION_PATTERN.test(headRevision)) return workspaceUnavailable("output_malformed", { command: "rev-parse" });
  // Absent a pin this build's HEAD is the reservation's base; the caller
  // stores the reported value and re-pins it on the next cadence.
  const baseRevision = pinned ?? headRevision;

  const status = await step(["status", "--porcelain=v1", "-z", "--untracked-files=normal"]);
  if ("failure" in status) return workspaceUnavailable(status.failure.reason, status.failure.detail);
  // `-M` pins rename detection on — a repo's `diff.renames` config must not
  // change what evidence means, and both listings must pair renames alike.
  const nameStatus = await step(["diff", "-M", "--name-status", "-z", baseRevision, "--"]);
  if ("failure" in nameStatus) return workspaceUnavailable(nameStatus.failure.reason, nameStatus.failure.detail);
  const numstat = await step(["diff", "-M", "--numstat", "-z", baseRevision, "--"]);
  if ("failure" in numstat) return workspaceUnavailable(numstat.failure.reason, numstat.failure.detail);

  const porcelain = parsePorcelainZ(status.stdout);
  if (porcelain === undefined) return workspaceUnavailable("output_malformed", { command: "status" });
  const names = parseNameStatusZ(nameStatus.stdout);
  if (names === undefined) return workspaceUnavailable("output_malformed", { command: "diff" });
  const counts = parseNumstatZ(numstat.stdout);
  if (counts === undefined) return workspaceUnavailable("output_malformed", { command: "diff" });

  const files: WorkspaceChangedFile[] = [];
  const seen = new Set<string>();
  for (const entry of names) {
    seen.add(entry.path);
    const file: WorkspaceChangedFile = { path: entry.path, status: entry.status };
    if (entry.from !== undefined) file.from = entry.from;
    const stat = counts.get(entry.path);
    if (stat?.added !== undefined) file.added = stat.added;
    if (stat?.deleted !== undefined) file.deleted = stat.deleted;
    files.push(file);
  }
  let untrackedFiles = 0;
  for (const path of porcelain.untracked) {
    if (seen.has(path)) continue; // raced into the index between reads — already reported tracked
    untrackedFiles += 1;
    files.push({ path, status: "untracked" });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const stats: WorkspaceDiffStats = { filesChanged: names.length, insertions: 0, deletions: 0, untrackedFiles };
  for (const file of files) {
    stats.insertions += file.added ?? 0;
    stats.deletions += file.deleted ?? 0;
  }

  // The fingerprint covers the full-resolution view — unbounded paths and the
  // untruncated list — so a change inside the emitted tail still shifts it.
  // Patch selection is cadence-relative and therefore deliberately excluded.
  const fingerprint = sha256Hex(canonicalJson({ baseRevision, headRevision, dirty: porcelain.dirty, changedFiles: files, stats }));

  const candidates = recentPatchFiles(root, Array.isArray(request.writtenFiles) ? request.writtenFiles : [], files);
  const selected = candidates.slice(0, WORKSPACE_PATCH_FILES_MAX);
  let patch: WorkspacePatch = { ...emptyWorkspacePatch(), omittedFiles: candidates.length - selected.length };
  for (let index = 0; index < selected.length; index += 1) {
    const file = selected[index]!;
    const args: [string, ...string[]] = file.status === "untracked"
      ? ["diff", "--no-index", "--no-ext-diff", "--no-color", `--unified=${WORKSPACE_PATCH_CONTEXT_LINES}`, "--", "/dev/null", `./${file.path}`]
      : ["diff", "--no-ext-diff", "--no-color", `--unified=${WORKSPACE_PATCH_CONTEXT_LINES}`, baseRevision, "--", `:(literal)${file.path}`];
    const read = await step(args, file.status === "untracked");
    if ("failure" in read) return workspaceUnavailable(read.failure.reason, read.failure.detail);
    const combined: WorkspacePatch = {
      hunks: [...patch.hunks, ...parseUnifiedHunks(file.path, read.stdout)],
      omittedHunks: patch.omittedHunks,
      omittedFiles: patch.omittedFiles,
    };
    patch = boundWorkspacePatch(combined, EVIDENCE_PATCH_MAX_BYTES);
    if (patch.omittedHunks > combined.omittedHunks) {
      patch = boundWorkspacePatch({ ...patch, omittedFiles: patch.omittedFiles + selected.length - index - 1 }, EVIDENCE_PATCH_MAX_BYTES);
      break;
    }
  }

  for (const file of files) {
    file.path = bounded(file.path, WORKSPACE_PATH_MAX_CHARS);
    if (file.from !== undefined) file.from = bounded(file.from, WORKSPACE_PATH_MAX_CHARS);
  }
  const changedFiles = files.slice(0, WORKSPACE_CHANGED_FILES_MAX);
  return {
    version: WORKSPACE_VIEW_VERSION,
    available: true,
    baseRevision,
    headRevision,
    dirty: porcelain.dirty,
    changedFiles,
    omittedFiles: files.length - changedFiles.length,
    stats,
    fingerprint,
    patch,
  };
}

/* ------------------------------------------------------------------ */
/* E3 — assemble, byte-bound, scan, and version the outbound state.     */
/* ------------------------------------------------------------------ */

/**
 * The ADR-036 outbound evidence state: assignment → trace → workspace →
 * terminal, assembled deterministically, byte-bounded, scanned for
 * sensitive content, and versioned. The pipeline order is contract:
 * build → deterministic compaction → byte bounding → local sensitive
 * scan → only a `safe` state may reach the reviewer. `sensitive` and
 * `indeterminate` produce `reviewer_unavailable` and no request ever
 * leaves. There is no semantic redaction: content either ships whole or
 * does not ship.
 *
 * Budgets are UTF-8 bytes (ADR-036):
 *
 * - assignment ≤ 128 KiB, never truncated — over is structural overflow.
 * - trace ≤ 32 KiB — the compacted digest; over is structural overflow
 *   (a truncated digest silently drops causal events, which is the one
 *   thing compaction is forbidden to do).
 * - patch ≤ 16 KiB — whole recent hunks only. It gives way only after the
 *   terminal is empty; every omitted hunk/file remains counted.
 * - terminal ≤ 8 KiB — supplemental narrative, bounded to a contiguous
 *   newest suffix of whole lines (the same rule the trace source applies
 *   to a tmux window), and sacrificed first against the total.
 * - total state ≤ 256 KiB — terminal then patch give way. When the remaining
 *   structural sections still exceed it, the review is unavailable; nothing
 *   causal is ever cut to fit.
 *
 * Diagnostics carry counts, budget figures, and fixed-vocabulary labels
 * only — never a byte of the flagged or dropped content.
 */
export const EVIDENCE_STATE_VERSION = 1;
/** The ADR-036 contract revision this state implements, inside the version identity. */
export const EVIDENCE_CONTRACT_VERSION = "2.1";

export const EVIDENCE_ASSIGNMENT_MAX_BYTES = 128 * 1024;
export const EVIDENCE_TRACE_MAX_BYTES = 32 * 1024;
export const EVIDENCE_TERMINAL_MAX_BYTES = 8 * 1024;
export const EVIDENCE_TOTAL_MAX_BYTES = 256 * 1024;

/**
 * The assignment as the launcher supplied it. Fields are `unknown` because
 * this builder is the normalization boundary: W1's carrier shape can loosen
 * (a bare string where a list was expected) and the state still comes out
 * in the exact contract shape.
 */
export interface EvidenceAssignmentInput {
  objective?: unknown;
  doneWhen?: unknown;
  progressMarkers?: unknown;
  constraints?: unknown;
}

/**
 * The normalized assignment. `doneWhen` is the terminal criteria — the only
 * list a completion judgment may consult. `progressMarkers` are
 * intermediate observable states: they give a first review advancement
 * targets but are never completion criteria, so they are kept verbatim in
 * their own field and never folded into `doneWhen`.
 */
export interface EvidenceAssignment {
  objective?: string;
  doneWhen: string[];
  progressMarkers: string[];
  constraints: string[];
}

/** The bounded terminal supplement: a newest contiguous suffix of whole lines. */
export interface EvidenceTerminal {
  lines: string[];
  /** Input lines not emitted — dropped by the terminal budget or sacrificed to the total. */
  droppedLines: number;
}

/**
 * The reviewer-owned identity components, supplied by the caller rather
 * than imported: hashing what was actually sent keeps the identity honest
 * and keeps this module import-safe for the reviewer that consumes it.
 */
export interface EvidenceIdentityInput {
  /** The pinned reviewer model (e.g. `typesafe/jev-latest`). */
  model: string;
  /** The exact question set sent to the reviewer — hashed canonically, so a wording change is drift. */
  questions: unknown;
  reducerVersion: number;
  /** The threshold table in effect, verbatim — a retune is drift. */
  thresholds: Record<string, number>;
}

/** Identity fields a drift comparison reports; `hash` is derived and never listed. */
export const EVIDENCE_IDENTITY_FIELDS = [
  "contractVersion",
  "model",
  "questionSetHash",
  "reducerVersion",
  "thresholds",
  "compilerConfigHash",
  "stateBuilderHash",
] as const;
export type EvidenceIdentityField = (typeof EVIDENCE_IDENTITY_FIELDS)[number];

/** The version identity carried on every state — a change to any field is config drift. */
export interface EvidenceVersionIdentity {
  contractVersion: string;
  model: string;
  /** SHA-256 over the canonical question set. */
  questionSetHash: string;
  reducerVersion: number;
  thresholds: Record<string, number>;
  /** SHA-256 over this build's deterministic-compilation configuration. */
  compilerConfigHash: string;
  /** SHA-256 over this state builder's version and budget constants. */
  stateBuilderHash: string;
  /** SHA-256 over the canonical identity above — the drift hash. */
  hash: string;
}

/** Drift against the reservation's baseline identity, field by field. */
export interface EvidenceDrift {
  drifted: boolean;
  fields: EvidenceIdentityField[];
}

export interface EvidenceState {
  version: number;
  assignment: EvidenceAssignment;
  trace: ExecutionDigest;
  workspace: WorkspaceView;
  terminal: EvidenceTerminal;
  /** A built state exists only because the scan passed; the field records that. */
  scan: "safe";
  identity: EvidenceVersionIdentity;
  drift: EvidenceDrift;
}

/** The scan trichotomy — exactly these three outcomes, nothing else. */
export type EvidenceScanOutcome = "safe" | "sensitive" | "indeterminate";

export interface EvidenceScanReport {
  outcome: EvidenceScanOutcome;
  /**
   * Fixed-vocabulary diagnostics only (`detector` names a pattern label).
   * A matched value is never a diagnostic — the whole point of the gate is
   * that the value does not travel.
   */
  detail?: Record<string, string | number | boolean>;
}

/** The local scan seam. Input is canonical JSON of one already-bounded section. */
export type EvidenceScanner = (text: string) => EvidenceScanReport;

export interface EvidenceStateDeps {
  /** Defaults to the local pattern scanner. */
  scan?: EvidenceScanner;
}

export interface EvidenceStateRequest {
  /** The typed assignment carried by the launch; absent ⇒ empty assignment evidence. */
  assignment?: EvidenceAssignmentInput;
  /** The cadence's trace window — compacted into the execution digest here. */
  trace: TraceWindow;
  /** The cadence's workspace view, emitted verbatim (available or not). */
  workspace: WorkspaceView;
  /** The bounded terminal delta lines, newest-last; supplemental evidence. */
  terminal?: string[];
  /** The reviewer-owned version-identity components. */
  identity: EvidenceIdentityInput;
  /** The reservation's pinned identity; absent on the first cadence (nothing to drift from). */
  baselineIdentity?: EvidenceVersionIdentity;
}

export type EvidenceUnavailableCause =
  /** The request itself or its identity components are malformed. */
  | "input_invalid"
  /** Assignment bytes exceed the never-truncated 128 KiB budget. */
  | "assignment_over_budget"
  /** The compacted digest exceeds the 32 KiB trace budget. */
  | "trace_over_budget"
  /** Fixed sections alone exceed the 256 KiB total — terminal cannot sacrifice enough. */
  | "state_over_budget"
  /** The scan found sensitive content; nothing is sent. */
  | "sensitive"
  /** The scan could not decide; fail closed, nothing is sent. */
  | "scan_indeterminate";

export interface EvidenceStateUnavailable {
  version: number;
  available: false;
  failure: {
    /** At the review boundary every build failure is `reviewer_unavailable`. */
    reason: "reviewer_unavailable";
    cause: EvidenceUnavailableCause;
    detail?: Record<string, string | number | boolean>;
  };
  /** Present whenever the identity was built — provenance survives a failed build. */
  identity?: EvidenceVersionIdentity;
}

/** Per-section UTF-8 byte accounting of the emitted state. */
export interface EvidenceByteReport {
  total: number;
  assignment: number;
  trace: number;
  workspace: number;
  patch: number;
  terminal: number;
}

export interface EvidenceStateOk {
  available: true;
  state: EvidenceState;
  bytes: EvidenceByteReport;
}

export type EvidenceBuild = EvidenceStateOk | EvidenceStateUnavailable;

/** UTF-8 byte length — budgets measure bytes, never characters. */
function utf8Length(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** The deterministic-compilation configuration this build emits under — V2.1's "compiler" is the digest/workspace builder pair. */
const COMPILER_CONFIG_HASH = sha256Hex(
  canonicalJson({
    compiler: "execution-digest",
    digestVersion: EXECUTION_DIGEST_VERSION,
    workspaceViewVersion: WORKSPACE_VIEW_VERSION,
    actionClasses: DIGEST_ACTION_CLASSES,
    bounds: {
      tool: TOOL_NAME_MAX_CHARS,
      target: TARGET_MAX_CHARS,
      kind: KIND_MAX_CHARS,
      changedFiles: WORKSPACE_CHANGED_FILES_MAX,
      patchFiles: WORKSPACE_PATCH_FILES_MAX,
      patchContextLines: WORKSPACE_PATCH_CONTEXT_LINES,
      path: WORKSPACE_PATH_MAX_CHARS,
    },
  }),
);

/** The state builder's own identity: its version and the budget constants that shape every emitted state. */
const STATE_BUILDER_HASH = sha256Hex(
  canonicalJson({
    builder: "evidence-state",
    stateVersion: EVIDENCE_STATE_VERSION,
    budgets: {
      assignment: EVIDENCE_ASSIGNMENT_MAX_BYTES,
      trace: EVIDENCE_TRACE_MAX_BYTES,
      patch: EVIDENCE_PATCH_MAX_BYTES,
      terminal: EVIDENCE_TERMINAL_MAX_BYTES,
      total: EVIDENCE_TOTAL_MAX_BYTES,
    },
    truncation: ["terminal", "patch"],
  }),
);

/**
 * Coerce a carrier field into a list of non-empty strings. A bare string
 * wraps into one entry; anything else that is not a string is carrier noise
 * and drops out of the list. Entries are never truncated — the assignment
 * budget bounds the whole section, not pieces of it.
 */
function stringList(value: unknown): string[] {
  if (typeof value === "string") return value === "" ? [] : [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item !== "");
}

function normalizeAssignment(input: EvidenceAssignmentInput | undefined): EvidenceAssignment {
  const assignment: EvidenceAssignment = {
    doneWhen: stringList(input?.doneWhen),
    progressMarkers: stringList(input?.progressMarkers),
    constraints: stringList(input?.constraints),
  };
  if (typeof input?.objective === "string" && input.objective !== "") assignment.objective = input.objective;
  return assignment;
}

/**
 * The exact byte measure the build applies to the assignment section:
 * normalize the carrier, serialize canonically, count UTF-8 bytes. The launch
 * preflight measures the same value it will later reserve so an over-budget
 * Task is refused at the launch boundary, not at every review cadence.
 */
export function normalizedAssignmentBytes(input: EvidenceAssignmentInput | undefined): number {
  return utf8Length(canonicalJson(normalizeAssignment(input)));
}

/** Thresholds must be a finite-number table to be a meaningful identity component. */
function validThresholds(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

/**
 * Validate the caller-supplied identity components and stamp the internal
 * ones. A malformed component means the identity — and therefore the drift
 * check — would be fiction, so the build refuses rather than guess.
 */
function versionIdentity(version: unknown): { identity: EvidenceVersionIdentity } | { field: string } {
  if (!isRecord(version)) return { field: "identity" };
  if (typeof version.model !== "string" || version.model === "") return { field: "identity.model" };
  const reducerVersion = version.reducerVersion;
  if (!Number.isSafeInteger(reducerVersion)) return { field: "identity.reducerVersion" };
  if (version.questions === undefined) return { field: "identity.questions" };
  if (!validThresholds(version.thresholds)) return { field: "identity.thresholds" };
  const core = {
    contractVersion: EVIDENCE_CONTRACT_VERSION,
    model: version.model,
    questionSetHash: sha256Hex(canonicalJson(version.questions)),
    reducerVersion: reducerVersion as number,
    thresholds: version.thresholds,
    compilerConfigHash: COMPILER_CONFIG_HASH,
    stateBuilderHash: STATE_BUILDER_HASH,
  };
  return { identity: { ...core, hash: sha256Hex(canonicalJson(core)) } };
}

/**
 * Compare against the reservation's baseline. A malformed baseline is not
 * trusted silently: every field drifts, which is the honest answer to "what
 * did we calibrate against? — unknown".
 */
function identityDrift(current: EvidenceVersionIdentity, baseline: unknown): EvidenceDrift {
  if (baseline === undefined) return { drifted: false, fields: [] };
  if (!isRecord(baseline)) return { drifted: true, fields: [...EVIDENCE_IDENTITY_FIELDS] };
  const fields = EVIDENCE_IDENTITY_FIELDS.filter((field) => canonicalJson(current[field]) !== canonicalJson(baseline[field]));
  return { drifted: fields.length > 0, fields };
}

/**
 * Keep the newest contiguous suffix of whole lines whose serialized section
 * stays under `capBytes`. A line is kept whole or dropped whole — a partial
 * line would be fabricated narrative, and the leading gap is reported by
 * `droppedLines` exactly like the trace source's own bounding.
 */
function boundTerminal(lines: string[], capBytes: number): EvidenceTerminal {
  const kept: string[] = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const candidate = [lines[i]!, ...kept];
    const candidateBytes = utf8Length(canonicalJson({ lines: candidate, droppedLines: lines.length - candidate.length }));
    if (candidateBytes > capBytes) break;
    kept.unshift(lines[i]!);
  }
  return { lines: kept, droppedLines: lines.length - kept.length };
}

function workspacePatch(workspace: WorkspaceView): WorkspacePatch {
  return workspace.available ? workspace.patch ?? emptyWorkspacePatch() : emptyWorkspacePatch();
}

function withWorkspacePatch(workspace: WorkspaceView, patch: WorkspacePatch): WorkspaceView {
  return workspace.available ? { ...workspace, patch } : workspace;
}

function withoutWorkspacePatch(workspace: WorkspaceView): WorkspaceView {
  if (!workspace.available || workspace.patch === undefined) return workspace;
  const structural = { ...workspace };
  delete structural.patch;
  return structural;
}

function omittedWorkspacePatch(patch: WorkspacePatch): WorkspacePatch {
  return { hunks: [], omittedHunks: patch.omittedHunks + patch.hunks.length, omittedFiles: patch.omittedFiles };
}

/**
 * Shaped-secret detectors for the local scan. Deliberately prefix- and
 * context-keyed rather than entropy-based: this state legitimately carries
 * SHA-256 hex in cursor refs, fingerprints, and the identity itself, so a
 * generic high-entropy rule would flag the evidence's own structure. A miss
 * costs a secret to the reviewer; a false positive costs one skipped
 * cadence — the set favours recall but stays shaped enough that ordinary
 * prose and the state's own hashes do not trip it.
 */
const SENSITIVE_DETECTORS: ReadonlyArray<{ detector: string; pattern: RegExp }> = [
  { detector: "pem_private_key", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/ },
  { detector: "aws_access_key", pattern: /\b(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|AROA)[0-9A-Z]{16}\b/ },
  { detector: "github_token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr|ght|ghc)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { detector: "gitlab_token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { detector: "slack_token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { detector: "stripe_key", pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { detector: "openai_key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { detector: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{3,}\b/ },
  { detector: "uri_credentials", pattern: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s/:@]{1,128}:[^\s/@]{1,128}@/i },
  { detector: "bearer_token", pattern: /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}\b/i },
  {
    detector: "secret_assignment",
    pattern: /(?:api[_-]?key|api[_-]?secret|access[_-]?key|secret[_-]?key|client[_-]?secret|private[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|session[_-]?token|bearer[_-]?token|gitlab[_-]?token|password|passwd|credentials?)["'\s]*[:=]["'\s]*[A-Za-z0-9._~+/=-]{6,}/i,
  },
];

/** Canonical JSON plus its decoded string leaves, where JSON quote escapes no longer hide assignments. */
function scanCandidates(text: string): string[] {
  const candidates = [text];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return candidates;
  }
  const pending = [parsed];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") candidates.push(value);
    else if (Array.isArray(value)) pending.push(...value);
    else if (isRecord(value)) pending.push(...Object.values(value));
  }
  return candidates;
}

/**
 * The local sensitive scan over one already-bounded canonical section and
 * its decoded string leaves. Returns exactly `safe`, `sensitive`, or
 * `indeterminate` — an input it cannot even read is `indeterminate`, never a
 * guess. Diagnostics name the detector label only; the matched value never
 * appears.
 */
export function scanEvidenceText(text: string): EvidenceScanReport {
  if (typeof text !== "string") return { outcome: "indeterminate" };
  const candidates = scanCandidates(text);
  for (const { detector, pattern } of SENSITIVE_DETECTORS) {
    if (candidates.some((candidate) => pattern.test(candidate))) return { outcome: "sensitive", detail: { detector } };
  }
  return { outcome: "safe" };
}

function evidenceUnavailable(
  cause: EvidenceUnavailableCause,
  detail: Record<string, string | number | boolean> | undefined,
  identity: EvidenceVersionIdentity | undefined,
): EvidenceStateUnavailable {
  const failure: EvidenceStateUnavailable["failure"] = { reason: "reviewer_unavailable", cause };
  if (detail !== undefined) failure.detail = detail;
  const result: EvidenceStateUnavailable = { version: EVIDENCE_STATE_VERSION, available: false, failure };
  if (identity !== undefined) result.identity = identity;
  return result;
}

/** The sections that carry string content, scanned in evidence-hierarchy order. */
const SCAN_SECTIONS = ["assignment", "trace", "workspace", "terminal", "identity"] as const;

/**
 * Assemble, bound, scan, and version one cadence's evidence state. Never
 * throws: every failure is a typed `reviewer_unavailable` value — an
 * infrastructure or safety failure is not evidence about the child.
 *
 * The scan runs last and only over what would actually ship: the canonical
 * bytes of each already-compacted, already-bounded section. A secret in a
 * dropped terminal line is not outbound and does not gate the state.
 */
export function buildEvidenceState(request: EvidenceStateRequest, deps: EvidenceStateDeps = {}): EvidenceBuild {
  try {
    if (!isRecord(request)) return evidenceUnavailable("input_invalid", { field: "request" }, undefined);
    const identity = versionIdentity(request.identity);
    if ("field" in identity) return evidenceUnavailable("input_invalid", { field: identity.field }, undefined);
    const drift = identityDrift(identity.identity, request.baselineIdentity);

    const assignment = normalizeAssignment(request.assignment);
    const assignmentBytes = utf8Length(canonicalJson(assignment));
    if (assignmentBytes > EVIDENCE_ASSIGNMENT_MAX_BYTES) {
      return evidenceUnavailable("assignment_over_budget", { bytes: assignmentBytes, budget: EVIDENCE_ASSIGNMENT_MAX_BYTES }, identity.identity);
    }

    if (!isRecord(request.trace) || !Array.isArray(request.trace.events)) {
      return evidenceUnavailable("input_invalid", { field: "trace" }, identity.identity);
    }
    const trace = buildExecutionDigest(request.trace);
    const traceBytes = utf8Length(canonicalJson(trace));
    if (traceBytes > EVIDENCE_TRACE_MAX_BYTES) {
      return evidenceUnavailable("trace_over_budget", { bytes: traceBytes, budget: EVIDENCE_TRACE_MAX_BYTES }, identity.identity);
    }

    const requestedWorkspace = request.workspace;
    const structuralWorkspace = withoutWorkspacePatch(requestedWorkspace);
    const workspaceBytes = utf8Length(canonicalJson(structuralWorkspace));
    const ownPatch = boundWorkspacePatch(workspacePatch(requestedWorkspace), EVIDENCE_PATCH_MAX_BYTES);

    // Total-size truncation is explicit: terminal reaches zero before patch
    // loses a hunk. Assignment, trace, workspace metadata, identity, and the
    // empty omission envelopes are structural and are never cut.
    const terminalLines = stringList(request.terminal);
    const emptyTerminal: EvidenceTerminal = { lines: [], droppedLines: terminalLines.length };
    const emptyTerminalBytes = utf8Length(canonicalJson(emptyTerminal));
    const emptyPatch = omittedWorkspacePatch(ownPatch);
    const minimumWorkspace = withWorkspacePatch(structuralWorkspace, emptyPatch);
    const minimumCore = {
      version: EVIDENCE_STATE_VERSION,
      assignment,
      trace,
      workspace: minimumWorkspace,
      scan: "safe" as const,
      identity: identity.identity,
      drift,
    };
    const minimumBytes = utf8Length(canonicalJson({ ...minimumCore, terminal: emptyTerminal }));
    if (minimumBytes > EVIDENCE_TOTAL_MAX_BYTES) {
      return evidenceUnavailable("state_over_budget", { bytes: minimumBytes, budget: EVIDENCE_TOTAL_MAX_BYTES }, identity.identity);
    }

    const emptyPatchBytes = utf8Length(canonicalJson(emptyPatch));
    const patchCap = Math.min(EVIDENCE_PATCH_MAX_BYTES, EVIDENCE_TOTAL_MAX_BYTES - minimumBytes + emptyPatchBytes);
    const patch = boundWorkspacePatch(ownPatch, patchCap);
    const workspace = withWorkspacePatch(structuralWorkspace, patch);
    const patchBytes = requestedWorkspace.available ? utf8Length(canonicalJson(patch)) : 0;
    const core = { ...minimumCore, workspace };
    const fixedBytes = utf8Length(canonicalJson({ ...core, terminal: emptyTerminal }));
    const terminalCap = Math.min(EVIDENCE_TERMINAL_MAX_BYTES, EVIDENCE_TOTAL_MAX_BYTES - fixedBytes + emptyTerminalBytes);
    const terminal = boundTerminal(terminalLines, terminalCap);
    const terminalBytes = utf8Length(canonicalJson(terminal));

    const state: EvidenceState = { ...core, terminal };

    const scan = deps.scan ?? scanEvidenceText;
    for (const section of SCAN_SECTIONS) {
      let report: EvidenceScanReport | undefined;
      try {
        report = scan(canonicalJson(state[section]));
      } catch {
        report = undefined;
      }
      const outcome = report?.outcome;
      if (outcome === "safe") continue;
      const detail: Record<string, string | number | boolean> = { section };
      const detector = report?.detail?.detector;
      if (typeof detector === "string") detail.detector = detector;
      return evidenceUnavailable(outcome === "sensitive" ? "sensitive" : "scan_indeterminate", detail, identity.identity);
    }

    return {
      available: true,
      state,
      bytes: {
        total: utf8Length(canonicalJson(state)),
        assignment: assignmentBytes,
        trace: traceBytes,
        workspace: workspaceBytes,
        patch: patchBytes,
        terminal: terminalBytes,
      },
    };
  } catch {
    // A caller-handing bug (e.g. a cyclic workspace object) is still a
    // reviewer_unavailable outcome — the build never throws into the cadence.
    return evidenceUnavailable("input_invalid", undefined, undefined);
  }
}
