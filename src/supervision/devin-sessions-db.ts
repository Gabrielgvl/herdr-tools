/**
 * The ADR-036 live Devin session reader: the `sessions.db` backend behind the
 * `DevinSessionReader` seam.
 *
 * Devin persists every local session in a private SQLite store at
 * `$XDG_DATA_HOME/devin/cli/sessions.db` and writes the ATIF transcript file
 * only at turn end. The store holds every committed step mid-turn, so reading
 * the committed main chain lets the supervision reviewer see a working Devin
 * lane — the transcript reader alone stays blind until the turn closes.
 *
 * The store is private and undocumented, so the reader fails closed:
 *
 * - A version gate pins the exact observed schema — `app_state`
 *   `schema_compat_version` `"0"`, the seventeen `refinery_schema_history`
 *   migrations verbatim, the `sessions`/`message_nodes` columns the reader
 *   consumes, and the unique `(session_id, node_id)` index. Compat and the
 *   migration allow-list are re-checked on every read — they are data, not
 *   DDL, so the `schema_version` cookie cannot see them change; the column
 *   and index checks stay cached on the cookie. A closed gate is permanent
 *   for the read: an undefined position falls back to the transcript reader,
 *   a store cursor throws `DEVIN_DB_SCHEMA` → `source_unreadable`.
 *
 * - The cursor's stable position is `node_id` plus a rolling content anchor
 *   over the consumed main chain — never `row_id` or `created_at`, which the
 *   turn-end `INSERT OR REPLACE` batch re-mints. Every continuation read
 *   re-walks the consumed chain's ancestry skeleton and re-rolls the anchor
 *   over the consumed bodies (bounded by the re-verify byte ceiling): the
 *   only check that also sees an in-place UPDATE, which moves neither the
 *   prefix's count nor its max(row_id). The watermark minted into the cursor
 *   is a diagnostic, not a detector.
 *
 * - Reads are one short transaction each: open `readOnly` with a ~250 ms busy
 *   timeout, `PRAGMA query_only = 1`, `BEGIN` … `COMMIT`, close. In WAL a
 *   reader never blocks Devin's writer, and a long reader is what would pin
 *   WAL frames — so the transaction never spans an `await`.
 *
 * - Emitted records are the projected ATIF step — `{step_id, source, message,
 *   tool_calls?, observation?, model_name?}` — the fields the transcript
 *   reader's records carry that are verified equal to the store's. Nothing
 *   else is projected: no `thinking`, `restore_file` bodies, or system-prompt
 *   bulk rides into evidence, and diagnostics stay path- and content-free.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { checkStep, devinCliDataDir, DEVIN_SOURCE_MAX_BYTES } from "./devin-trace.js";
import {
  DevinSourceError,
  TRACE_WINDOW_MAX_BYTES,
  type DevinSessionRead,
  type DevinSessionReader,
  type TraceEvent,
} from "./trace-source.js";

/** The largest consumed chain a turn-end re-mint may re-hash: 8× the document ceiling. */
export const DEVIN_DB_REVERIFY_MAX_BYTES = 64 * 1024 * 1024;
/** New forest rows one read will classify before refusing the window. */
export const DEVIN_DB_NEW_NODES_MAX = 20_000;
/** Busy timeout on the read-only connection; WAL recovery can briefly busy an open. */
export const DEVIN_DB_BUSY_TIMEOUT_MS = 250;

const EXPECTED_COMPAT_VERSION = "0";
const EXPECTED_MIGRATIONS: ReadonlyArray<readonly [number, string]> = [
  [1, "initial_schema"],
  [2, "add_thinking_column"],
  [3, "add_prompt_history"],
  [4, "add_metadata_column"],
  [5, "message_forest"],
  [6, "add_node_metadata"],
  [7, "add_shell_context"],
  [8, "add_session_cogs"],
  [9, "add_rendered_commits"],
  [10, "add_workspace_dirs"],
  [11, "add_prompt_history_is_shell"],
  [12, "add_app_state"],
  [13, "rename_permission_mode_to_agent_mode"],
  [14, "tool_call_state"],
  [15, "add_hidden_column"],
  [16, "add_session_json_metadata"],
  [17, "subagent_heads"],
];

const REQUIRED_COLUMNS: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, string]>]> = [
  ["sessions", [["id", "TEXT"], ["main_chain_id", "INTEGER"]]],
  ["message_nodes", [["row_id", "INTEGER"], ["session_id", "TEXT"], ["node_id", "INTEGER"], ["parent_node_id", "INTEGER"], ["chat_message", "TEXT"]]],
];

const HEX_64 = /^[0-9a-f]{64}$/;
const EMPTY_ANCHOR = createHash("sha256").digest("hex");

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_IOERR = 10;

/**
 * The store raised a permanent-unavailable condition and no store cursor
 * exists: the router falls back to the transcript reader — exactly today's
 * behaviour. It never crosses the seam, so it needs no typed code; with a
 * store cursor the same conditions surface as `DEVIN_DB_*` unreadable codes
 * instead.
 */
export class DevinSessionsDbFallback extends Error {
  constructor() {
    super("devin sessions db fallback: store unavailable, gate closed, or session absent");
    this.name = "DevinSessionsDbFallback";
  }
}

/**
 * An error the seam maps through its `code` vocabulary: `SQLITE_BUSY` /
 * `SQLITE_LOCKED` / `SQLITE_IOERR` are transient (no cursor minted, retried
 * next cadence); `DEVIN_DB_UNAVAILABLE` and `DEVIN_DB_SCHEMA` are the sticky
 * permanent conditions for an already-minted store cursor.
 */
class DevinDbStoreError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`devin sessions db: ${code}`);
    this.name = "DevinDbStoreError";
    this.code = code;
  }
}

/** The bound-parameter vocabulary every statement uses. */
type DbParam = string | number | bigint | null;

/** The narrow `node:sqlite` surface the reader consumes; production hands over `DatabaseSync`. */
export interface DevinSessionsDbStatement {
  all(...params: DbParam[]): unknown[];
  get(...params: DbParam[]): unknown;
}

export interface DevinSessionsDbHandle {
  prepare(sql: string): DevinSessionsDbStatement;
  exec(sql: string): void;
  close(): void;
}

/** Opens one store connection; production lazily imports `node:sqlite`. */
export type DevinSessionsDbOpener = (path: string, busyTimeoutMs: number) => Promise<DevinSessionsDbHandle> | DevinSessionsDbHandle;

export interface DevinSessionsDbDeps {
  /** Store path; production resolves `$XDG_DATA_HOME/devin/cli/sessions.db`. */
  dbPath?: string;
  /** Connection factory — injected for fixture databases and import-failure tests. */
  openDatabase?: DevinSessionsDbOpener;
  /** `SQLITE_BUSY` wait budget on the connection (default 250 ms). */
  busyTimeoutMs?: number;
  /** Raw `octet_length` ceiling per consumed step (default 8 MiB, the document cap). */
  stepRawMaxBytes?: number;
  /** Consumed-chain ceiling the turn-end re-verify may re-hash (default 64 MiB). */
  reverifyMaxBytes?: number;
  /** Forest rows one read may classify (default 20 000). */
  newNodesMax?: number;
  /** Window budget mirroring the seam's (default `TRACE_WINDOW_MAX_BYTES`). */
  windowMaxBytes?: number;
}

interface DbCursor {
  session: string;
  steps: number;
  anchor: string;
  node: number;
  rows: number;
  maxRow: number;
}

interface GateCache {
  cookie?: number;
  compat?: string;
}

interface SkelRow {
  node?: unknown;
  parent?: unknown;
  len?: unknown;
}

interface Skel {
  node: number;
  parent: number | null;
  len: number;
}

interface ParsedNode {
  node: number;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  toolCallId?: string;
  model?: string;
  /** The raw `chat_message` text the rolling anchor hashes. */
  text: string;
}

const defaultOpenDatabase: DevinSessionsDbOpener = async (path, busyTimeoutMs) => {
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(path, { readOnly: true, timeout: busyTimeoutMs });
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(value: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

/** Integer columns: `node:sqlite` returns numbers (bigint only when asked), never floats. */
function intOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "bigint") {
    const converted = Number(value);
    if (Number.isSafeInteger(converted)) return converted;
  }
  return undefined;
}

function sqliteErrcode(error: unknown): number | undefined {
  const errcode = (error as { errcode?: unknown }).errcode;
  return intOf(errcode);
}

/** Transient store conditions keep the sqlite code name; everything else is a permanent condition. */
function busyError(error: unknown): DevinDbStoreError | undefined {
  const errcode = sqliteErrcode(error);
  if (errcode === SQLITE_BUSY) return new DevinDbStoreError("SQLITE_BUSY");
  if (errcode === SQLITE_LOCKED) return new DevinDbStoreError("SQLITE_LOCKED");
  if (errcode === SQLITE_IOERR) return new DevinDbStoreError("SQLITE_IOERR");
  return undefined;
}

/**
 * Classify a store-layer throw: typed reader failures pass through, busy
 * codes keep their name, and any other store failure is permanent — the
 * transcript fallback without a cursor, `DEVIN_DB_UNAVAILABLE` with one.
 */
function mapStoreError(error: unknown, prior: DbCursor | undefined): Error {
  if (error instanceof DevinDbStoreError || error instanceof DevinSourceError || error instanceof DevinSessionsDbFallback) return error;
  const busy = busyError(error);
  if (busy !== undefined) return busy;
  return prior === undefined ? new DevinSessionsDbFallback() : new DevinDbStoreError("DEVIN_DB_UNAVAILABLE");
}

function cursorMalformed(reason: string): DevinSourceError {
  return new DevinSourceError("cursor_malformed", { reason });
}

function malformedNode(node: number, reason: string): DevinSourceError {
  return new DevinSourceError("source_malformed", { node, reason });
}

/** Validate a position this backend minted; anything else fails closed. */
function parseDbPosition(position: unknown, sessionId: string): DbCursor {
  if (!isRecord(position)) throw cursorMalformed("position_not_object");
  if (position.session !== sessionId) throw cursorMalformed("session_mismatch");
  if (!Number.isSafeInteger(position.steps) || (position.steps as number) < 0) throw cursorMalformed("steps_invalid");
  if (typeof position.anchor !== "string" || !HEX_64.test(position.anchor)) throw cursorMalformed("anchor_invalid");
  const db = position.db;
  if (!isRecord(db) || db.v !== 1) throw cursorMalformed("db_invalid");
  const node = intOf(db.node);
  const rows = intOf(db.rows);
  const maxRow = intOf(db.maxRow);
  if (node === undefined || node < -1 || rows === undefined || rows < 0 || maxRow === undefined || maxRow < 0) {
    throw cursorMalformed("db_invalid");
  }
  return { session: sessionId, steps: position.steps as number, anchor: position.anchor, node, rows, maxRow };
}

function prepareGet(db: DevinSessionsDbHandle, sql: string, params: DbParam[]): Record<string, unknown> | undefined {
  const row = db.prepare(sql).get(...params);
  return isRecord(row) ? row : undefined;
}

/** The version gate. Throws only busy errors; every other failure is a closed gate. */
function gateOpen(db: DevinSessionsDbHandle, cache: GateCache): boolean {
  try {
    const cookie = intOf(prepareGet(db, "PRAGMA schema_version", [])?.schema_version);
    const compatRow = prepareGet(db, "SELECT value AS v FROM app_state WHERE key = 'schema_compat_version' LIMIT 1", []);
    const compat = typeof compatRow?.v === "string" ? compatRow.v : undefined;
    if (compat !== EXPECTED_COMPAT_VERSION) return false;
    // The migration allow-list is data, not DDL: a new migration row does not
    // move the schema cookie, so it is re-checked on every read.
    if (!migrationsMatch(db)) return false;
    if (cache.cookie === cookie && cache.compat === compat) return true;
    if (!columnsMatch(db) || !chainIndexMatch(db)) return false;
    cache.cookie = cookie;
    cache.compat = compat;
    return true;
  } catch (error) {
    const busy = busyError(error);
    if (busy !== undefined) throw busy;
    return false;
  }
}

function migrationsMatch(db: DevinSessionsDbHandle): boolean {
  const rows = db.prepare("SELECT version AS v, name AS n FROM refinery_schema_history ORDER BY version LIMIT 64").all();
  if (rows.length !== EXPECTED_MIGRATIONS.length) return false;
  return rows.every((row, index) => {
    const expected = EXPECTED_MIGRATIONS[index]!;
    return isRecord(row) && intOf(row.v) === expected[0] && row.n === expected[1];
  });
}

function columnsMatch(db: DevinSessionsDbHandle): boolean {
  return REQUIRED_COLUMNS.every(([table, required]) => {
    const rows = db.prepare("SELECT name AS n, type AS t FROM pragma_table_info(?) LIMIT 128").all(table);
    const declared = new Map<string, string>();
    for (const row of rows) {
      if (isRecord(row) && typeof row.n === "string" && typeof row.t === "string") declared.set(row.n, row.t.toUpperCase());
    }
    return required.every(([name, type]) => declared.get(name) === type);
  });
}

/** The unique `(session_id, node_id)` index the chain walk's plans and cursor identity rely on. */
function chainIndexMatch(db: DevinSessionsDbHandle): boolean {
  const rows = db.prepare(
    `SELECT il.name AS idx, il."unique" AS uniq, ii.seqno AS seq, ii.name AS col
     FROM pragma_index_list('message_nodes') il JOIN pragma_index_info(il.name) ii
     ORDER BY il.name, ii.seqno LIMIT 256`,
  ).all();
  const columns = new Map<string, string[]>();
  for (const row of rows) {
    if (!isRecord(row) || row.uniq !== 1 || typeof row.idx !== "string" || typeof row.col !== "string") continue;
    (columns.get(row.idx) ?? columns.set(row.idx, []).get(row.idx)!).push(row.col);
  }
  for (const cols of columns.values()) {
    if (cols.length === 2 && cols[0] === "session_id" && cols[1] === "node_id") return true;
  }
  return false;
}

/** `sessions.id` is the herdr `agent_session` value verbatim; the row pins the committed head. */
function sessionHead(db: DevinSessionsDbHandle, sessionId: string): number | null | "absent" {
  const row = prepareGet(db, "SELECT main_chain_id AS head FROM sessions WHERE id = ? LIMIT 1", [sessionId]);
  if (row === undefined) return "absent";
  if (row.head === null) return null;
  const head = intOf(row.head);
  if (head === undefined) throw new DevinSourceError("source_malformed", { reason: "head_invalid" });
  return head;
}

/** `(count, max(row_id))` over the consumed prefix — the AUTOINCREMENT change detector. */
function prefixWatermark(db: DevinSessionsDbHandle, sessionId: string, node: number): { rows: number; maxRow: number } {
  const row = prepareGet(db, "SELECT count(*) AS rows, max(row_id) AS maxRow FROM message_nodes WHERE session_id = ? AND node_id <= ?", [sessionId, node]);
  return { rows: intOf(row?.rows) ?? 0, maxRow: intOf(row?.maxRow) ?? 0 };
}

function rollAnchor(anchor: string, nodeId: number, chatMessage: string): string {
  const inner = createHash("sha256").update(chatMessage, "utf8").digest("hex");
  return createHash("sha256").update(`${anchor}\n${nodeId}:${inner}`, "utf8").digest("hex");
}

/**
 * Re-walk the consumed chain — `cursor.node`'s ancestry — and re-roll the
 * anchor. `undefined` means the chain can no longer be reproduced (a node
 * vanished, a parent dangles, or the walk loops): the caller reports it as
 * `anchor_mismatch`, because the consumed prefix no longer exists.
 */
function recomputeAnchor(node: number, rows: Array<{ node?: unknown; parent?: unknown; msg?: unknown }>): string | undefined {
  const byId = new Map<number, { parent: number | null; msg: string }>();
  for (const row of rows) {
    const id = intOf(row.node);
    if (id === undefined || typeof row.msg !== "string") return undefined;
    const parent = row.parent === null ? null : intOf(row.parent);
    if (parent === undefined) return undefined;
    byId.set(id, { parent, msg: row.msg });
  }
  const chain: Array<{ node: number; msg: string }> = [];
  const seen = new Set<number>();
  let current: number | null = node;
  while (current !== null) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const row = byId.get(current);
    if (row === undefined) return undefined;
    chain.push({ node: current, msg: row.msg });
    current = row.parent;
  }
  let anchor = EMPTY_ANCHOR;
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    anchor = rollAnchor(anchor, chain[index]!.node, chain[index]!.msg);
  }
  return anchor;
}

/**
 * Re-walk the consumed chain's ancestry skeleton — ids, parents and body
 * lengths only — then re-roll the anchor over just those bodies. Continuation
 * reads always take this path: an in-place UPDATE of a consumed row moves
 * neither the prefix's count nor its max(row_id), so no watermark can see
 * it. Only the consumed ancestry counts against the re-verify ceiling and
 * gets its body loaded — abandoned roots, side branches and drafts below the
 * cursor are neither hashed nor budgeted. A chain that can no longer be
 * reproduced — a vanished node, a dangling or looping parent — is a rewrite.
 */
function verifyPrefix(db: DevinSessionsDbHandle, sessionId: string, prior: DbCursor, reverifyMax: number): void {
  if (prior.node === -1) {
    // A steps-0 cursor consumed nothing; only the empty anchor can verify.
    if (prior.anchor !== EMPTY_ANCHOR) throw new DevinSourceError("source_rewritten", { reason: "anchor_mismatch" });
    return;
  }
  const rows = db
    .prepare(
      `SELECT node_id AS node, parent_node_id AS parent, octet_length(chat_message) AS len
       FROM message_nodes WHERE session_id = ? AND node_id <= ? ORDER BY node_id LIMIT ?`,
    )
    .all(sessionId, prior.node, prior.node + 2) as SkelRow[];
  const byId = new Map<number, { parent: number | null; len: number }>();
  for (const row of rows) {
    const node = intOf(row.node);
    const parent = row.parent === null ? null : intOf(row.parent);
    const len = intOf(row.len);
    // A corrupt row anywhere in the consumed prefix fails closed as a
    // rewrite, matching the anchor's whole-prefix judgement.
    if (node === undefined || parent === undefined || len === undefined) {
      throw new DevinSourceError("source_rewritten", { reason: "anchor_mismatch" });
    }
    byId.set(node, { parent, len });
  }
  const ancestry: Array<{ node: number; parent: number | null }> = [];
  const seen = new Set<number>();
  let bytes = 0;
  let current: number | null = prior.node;
  while (current !== null) {
    if (seen.has(current)) throw new DevinSourceError("source_rewritten", { reason: "anchor_mismatch" });
    seen.add(current);
    const row = byId.get(current);
    if (row === undefined) throw new DevinSourceError("source_rewritten", { reason: "anchor_mismatch" });
    bytes += row.len;
    if (bytes > reverifyMax) {
      throw new DevinSourceError("source_exceeds_budget", { reason: "reverify", bytesAtLeast: bytes, budget: reverifyMax });
    }
    ancestry.push({ node: current, parent: row.parent });
    current = row.parent;
  }
  const consumed = ancestry.map(({ node, parent }) => ({
    node,
    parent,
    msg: prepareGet(db, "SELECT chat_message AS msg FROM message_nodes WHERE session_id = ? AND node_id = ? LIMIT 1", [sessionId, node])?.msg,
  }));
  if (recomputeAnchor(prior.node, consumed) !== prior.anchor) {
    throw new DevinSourceError("source_rewritten", { reason: "anchor_mismatch" });
  }
}

/**
 * The new main-chain segment: the skeleton above the cursor — ids, parents
 * and body lengths only, so bodies of abandoned roots, side branches, draft
 * tails and subagent chains are never parsed here — is walked from the
 * committed head down to the cursor. A head rewound below the cursor, a
 * walk that passes below it, or a root reached first means the chain was
 * re-rooted; a parent that dangles inside the snapshot is malformed.
 */
function chainSegment(db: DevinSessionsDbHandle, sessionId: string, priorNode: number, head: number | null, newNodesMax: number): Skel[] {
  const rows = db
    .prepare(
      `SELECT node_id AS node, parent_node_id AS parent, octet_length(chat_message) AS len
       FROM message_nodes WHERE session_id = ? AND node_id > ? ORDER BY node_id LIMIT ?`,
    )
    .all(sessionId, priorNode, newNodesMax + 1) as SkelRow[];
  if (rows.length > newNodesMax) {
    throw new DevinSourceError("source_exceeds_budget", { reason: "new_nodes", rowsAtLeast: rows.length, budget: newNodesMax });
  }
  const byId = new Map<number, Skel>();
  for (const row of rows) {
    const node = intOf(row.node);
    const len = intOf(row.len);
    const parent = row.parent === null || row.parent === undefined ? null : intOf(row.parent);
    if (node === undefined || len === undefined || parent === undefined) {
      throw new DevinSourceError("source_malformed", { reason: "row_invalid" });
    }
    byId.set(node, { node, parent, len });
  }
  if (head === null) {
    // A committed head that vanished under a live cursor is a rewritten source.
    if (priorNode !== -1) throw new DevinSourceError("source_rewritten", { reason: "not_ancestor" });
    return [];
  }
  const segment: Skel[] = [];
  const seen = new Set<number>();
  let current = head;
  for (;;) {
    if (current === priorNode) break;
    // A head rewound below a live cursor is a revert: the consumed cursor is
    // no longer an ancestor — rewritten, never corruption.
    if (priorNode !== -1 && current < priorNode) throw new DevinSourceError("source_rewritten", { reason: "not_ancestor" });
    const row = byId.get(current);
    // Every node above the cursor sits in the `node_id > priorNode` snapshot,
    // so a miss here is always a dangling parent — malformed.
    if (row === undefined) throw new DevinSourceError("source_malformed", { reason: "chain_incomplete" });
    if (seen.has(current)) throw new DevinSourceError("source_malformed", { reason: "chain_cycle" });
    seen.add(current);
    segment.push(row);
    if (row.parent === null) {
      if (priorNode === -1) break;
      throw new DevinSourceError("source_rewritten", { reason: "not_ancestor" });
    }
    if (row.parent < priorNode) throw new DevinSourceError("source_rewritten", { reason: "not_ancestor" });
    current = row.parent;
  }
  return segment.reverse();
}

function loadMessage(db: DevinSessionsDbHandle, sessionId: string, node: number): string {
  const row = prepareGet(db, "SELECT chat_message AS msg FROM message_nodes WHERE session_id = ? AND node_id = ? LIMIT 1", [sessionId, node]);
  if (typeof row?.msg !== "string") throw malformedNode(node, "chain_incomplete");
  return row.msg;
}

/**
 * Role probe for a single selected node whose length alone exceeds the
 * per-step raw cap: only a bounded prefix is loaded, but the step grammar still
 * needs the role — a tool node would fold into the open step, anything else
 * starts a new one.
 */
function roleOf(db: DevinSessionsDbHandle, sessionId: string, node: number): string | null {
  const row = prepareGet(
    db,
    `SELECT substr(chat_message, 1, 4096) AS prefix
     FROM message_nodes WHERE session_id = ? AND node_id = ? LIMIT 1`,
    [sessionId, node],
  );
  // Devin writes message_id before role. Match only these leading top-level
  // members, never a role-like string inside content; other layouts fail closed.
  if (typeof row?.prefix !== "string") return null;
  return /^\s*\{\s*(?:"message_id"\s*:\s*"(?:[^"\\]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*"\s*,\s*)?"role"\s*:\s*"(system|user|assistant|tool)"\s*[,}]/.exec(row.prefix)?.[1] ?? null;
}

/** The row-level shape checks run only on consumed nodes — a deferred tail is never judged. */
function parseNode(node: number, text: string): ParsedNode {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw malformedNode(node, "invalid_json");
  }
  if (!isRecord(value)) throw malformedNode(node, "not_object");
  const role = value.role;
  if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") throw malformedNode(node, "role_invalid");
  if (typeof value.message_id !== "string") throw malformedNode(node, "message_id_invalid");
  if (typeof value.content !== "string") throw malformedNode(node, "content_invalid");
  let toolCalls: ParsedNode["toolCalls"];
  if (own(value, "tool_calls")) {
    if (!Array.isArray(value.tool_calls)) throw malformedNode(node, "tool_calls_invalid");
    toolCalls = value.tool_calls.map((call) => {
      if (!isRecord(call) || typeof call.id !== "string" || typeof call.name !== "string" || !isRecord(call.arguments)) {
        throw malformedNode(node, "tool_call_invalid");
      }
      return { id: call.id, name: call.name, arguments: call.arguments };
    });
  }
  let toolCallId: string | undefined;
  if (role === "tool") {
    if (typeof value.tool_call_id !== "string") throw malformedNode(node, "tool_call_id_invalid");
    toolCallId = value.tool_call_id;
  }
  const model = isRecord(value.metadata) && typeof value.metadata.generation_model === "string" ? value.metadata.generation_model : undefined;
  return { node, role, content: value.content, ...(toolCalls === undefined ? {} : { toolCalls }), ...(toolCallId === undefined ? {} : { toolCallId }), ...(model === undefined ? {} : { model }), text };
}

/** The projected ATIF step: exactly the fields verified equal to the transcript's records. */
function projectStep(stepId: number, parsed: ParsedNode[]): Record<string, unknown> {
  const head = parsed[0]!;
  const record: Record<string, unknown> = {
    step_id: stepId,
    source: head.role === "assistant" ? "agent" : head.role,
    message: head.content,
  };
  if (head.toolCalls !== undefined) {
    record.tool_calls = head.toolCalls.map((call) => ({ tool_call_id: call.id, function_name: call.name, arguments: call.arguments }));
  }
  const results = parsed.slice(1).map((tool) => ({ source_call_id: tool.toolCallId as string, content: tool.content }));
  if (results.length > 0) record.observation = { results };
  if (head.model !== undefined) record.model_name = head.model;
  return record;
}

function readCommittedChain(
  db: DevinSessionsDbHandle,
  sessionId: string,
  prior: DbCursor | undefined,
  gateCache: GateCache,
  caps: { stepRaw: number; reverify: number; newNodes: number; window: number },
): DevinSessionRead {
  if (!gateOpen(db, gateCache)) {
    if (prior === undefined) throw new DevinSessionsDbFallback();
    throw new DevinDbStoreError("DEVIN_DB_SCHEMA");
  }
  const head = sessionHead(db, sessionId);
  if (head === "absent") {
    if (prior === undefined) throw new DevinSessionsDbFallback();
    throw new DevinSourceError("source_rewritten", { reason: "session_absent" });
  }
  const priorNode = prior?.node ?? -1;
  const priorSteps = prior?.steps ?? 0;
  if (prior !== undefined) verifyPrefix(db, sessionId, prior, caps.reverify);
  const segment = chainSegment(db, sessionId, priorNode, head, caps.newNodes);

  // The segment folds into steps in chain order — a non-tool node closes the
  // open step and starts one, a tool node joins the open agent step — the
  // main chain's own grammar, mirrored from the transcript projection. Bodies
  // load only here, one selected node at a time under the per-step raw cap.
  const events: TraceEvent[] = [];
  let byteCount = 0;
  let consumed = 0;
  let consumedEnd = priorNode;
  let anchor = prior?.anchor ?? EMPTY_ANCHOR;
  let open: ParsedNode[] = [];
  let openRaw = 0;
  let result: DevinSessionRead | undefined;

  const flush = (last: boolean): "emitted" | "full" | "deferred" | "skipped" => {
    const nodes = open;
    if (nodes.length === 0) return "emitted";
    open = [];
    openRaw = 0;
    const stepNumber = priorSteps + consumed + 1;
    if (last && nodes[0]!.role === "assistant") {
      // The last step is consumed only when every call has its tool node —
      // an in-flight call resolves on the next cadence, mirroring the Pi
      // adapter's unterminated-tail rule.
      const resolved = new Set(nodes.slice(1).map((tool) => tool.toolCallId));
      if (nodes[0]!.toolCalls?.some((call) => !resolved.has(call.id)) === true) return "deferred";
    }
    const record = checkStep(projectStep(stepNumber, nodes), priorSteps + consumed);
    const bytes = Buffer.byteLength(JSON.stringify(record), "utf8");
    if (byteCount + bytes > caps.window) {
      if (events.length === 0) {
        // A first step that can never fit is reported once and consumed, so
        // the next window resumes after it instead of refusing it forever.
        for (const node of nodes) anchor = rollAnchor(anchor, node.node, node.text);
        consumedEnd = nodes[nodes.length - 1]!.node;
        const mark = prefixWatermark(db, sessionId, consumedEnd);
        result = {
          position: { session: sessionId, steps: stepNumber, anchor, db: { v: 1, node: consumedEnd, rows: mark.rows, maxRow: mark.maxRow } },
          events,
          skipped: { step: stepNumber, bytes },
        };
        return "skipped";
      }
      return "full";
    }
    events.push({ kind: record.source as string, offset: stepNumber, bytes, record });
    byteCount += bytes;
    for (const node of nodes) anchor = rollAnchor(anchor, node.node, node.text);
    consumedEnd = nodes[nodes.length - 1]!.node;
    consumed += 1;
    return "emitted";
  };

  for (const skel of segment) {
    if (skel.len > caps.stepRaw) {
      // The node can never be consumed — its step exceeds the raw cap
      // whatever its role is. Only the role decides whether the failing step
      // is the open one or the next, so probe it without loading the body.
      const role = roleOf(db, sessionId, skel.node);
      if (role === "tool" || role === null) {
        // An unknown role might belong to the open step. Do not flush it or
        // advance its cursor: retrying is safer than dropping a tool result.
        if (role === "tool" && (open.length === 0 || open[0]!.role !== "assistant")) throw malformedNode(skel.node, "orphan_tool_node");
        throw new DevinSourceError("source_exceeds_budget", { reason: "step_raw", step: priorSteps + consumed + 1, bytesAtLeast: openRaw + skel.len, budget: caps.stepRaw });
      }
      if (flush(false) !== "emitted") break;
      throw new DevinSourceError("source_exceeds_budget", { reason: "step_raw", step: priorSteps + consumed + 1, bytesAtLeast: skel.len, budget: caps.stepRaw });
    }
    const parsed = parseNode(skel.node, loadMessage(db, sessionId, skel.node));
    if (parsed.role === "tool") {
      if (open.length === 0 || open[0]!.role !== "assistant") throw malformedNode(skel.node, "orphan_tool_node");
      openRaw += skel.len;
      if (openRaw > caps.stepRaw) {
        throw new DevinSourceError("source_exceeds_budget", { reason: "step_raw", step: priorSteps + consumed + 1, bytesAtLeast: openRaw, budget: caps.stepRaw });
      }
      open.push(parsed);
    } else {
      if (flush(false) !== "emitted") break;
      open = [parsed];
      openRaw = skel.len;
    }
  }
  if (result === undefined) {
    flush(true);
  }
  if (result === undefined) {
    const mark = prefixWatermark(db, sessionId, consumedEnd);
    result = {
      position: { session: sessionId, steps: priorSteps + consumed, anchor, db: { v: 1, node: consumedEnd, rows: mark.rows, maxRow: mark.maxRow } },
      events,
    };
  }
  return result;
}

/**
 * The live reader behind `createDevinSessionReader`: a fresh position reads
 * the committed main chain and mints a store cursor (any permanent
 * unavailability instead throws `DevinSessionsDbFallback`, which the router
 * turns into exactly today's transcript path); a store cursor continues on
 * the store, where the same conditions surface as typed failures instead.
 */
export function createDevinSessionsDbReader(deps: DevinSessionsDbDeps = {}): DevinSessionReader {
  const path = deps.dbPath ?? join(devinCliDataDir(), "sessions.db");
  const open = deps.openDatabase ?? defaultOpenDatabase;
  const busyTimeoutMs = deps.busyTimeoutMs ?? DEVIN_DB_BUSY_TIMEOUT_MS;
  const caps = {
    stepRaw: deps.stepRawMaxBytes ?? DEVIN_SOURCE_MAX_BYTES,
    reverify: deps.reverifyMaxBytes ?? DEVIN_DB_REVERIFY_MAX_BYTES,
    newNodes: deps.newNodesMax ?? DEVIN_DB_NEW_NODES_MAX,
    window: deps.windowMaxBytes ?? TRACE_WINDOW_MAX_BYTES,
  };
  const gateCache: GateCache = {};
  return async (sessionId, position, signal) => {
    if (signal.aborted) throw new DevinDbStoreError("ABORTED");
    const prior = position === undefined ? undefined : parseDbPosition(position, sessionId);
    let db: DevinSessionsDbHandle;
    try {
      db = await open(path, busyTimeoutMs);
    } catch (error) {
      throw mapStoreError(error, prior);
    }
    try {
      try {
        db.exec("PRAGMA query_only = 1");
        db.exec("BEGIN");
      } catch (error) {
        throw mapStoreError(error, prior);
      }
      let result: DevinSessionRead;
      try {
        result = readCommittedChain(db, sessionId, prior, gateCache, caps);
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Rollback is best-effort; the connection closes right after.
        }
        throw mapStoreError(error, prior);
      }
      if (signal.aborted) throw new DevinDbStoreError("ABORTED");
      return result;
    } finally {
      try {
        db.close();
      } catch {
        // Closing a broken connection is best-effort; the failure was already reported.
      }
    }
  };
}
