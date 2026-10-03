import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDevinSessionReader, type DevinTraceDeps } from "../../src/supervision/devin-trace.js";
import {
  createDevinSessionsDbReader,
  type DevinSessionsDbHandle,
  type DevinSessionsDbOpener,
} from "../../src/supervision/devin-sessions-db.js";
import {
  createTraceSource,
  TRACE_WINDOW_MAX_BYTES,
  type DevinSessionReader,
  type TraceCursor,
  type TraceSource,
  type TraceSourceIdentity,
} from "../../src/supervision/trace-source.js";
import {
  addNode,
  addNodes,
  addSession,
  assistantMessage,
  atifDoc,
  atifStep,
  createFixtureDb,
  remintNodes,
  setHead,
  systemMessage,
  toolMessage,
  userMessage,
  type FixtureNode,
} from "./devin-sessions-db-fixture.js";

/**
 * Fixture discipline mirrors the transcript-reader suite: canary strings
 * stand in for path- and content-bearing secrets, and every typed failure is
 * asserted to carry neither. The real `sessions.db` is never opened — every
 * store is a fixture database in `mkdtemp` on an injected path.
 */
const CANARY_PATH = "/tmp/CANARY-SECRET-PATH/session.json";
const CANARY_CONTENT = "CANARY-SECRET-CONTENT";

const DIR = "/virtual/devin-transcripts";

function identity(value = "sess-1"): TraceSourceIdentity {
  return {
    paneId: "w:p1",
    agentKind: "devin",
    agentSession: { source: "herdr:devin", agent: "devin", kind: "id", value },
  };
}

function files(map: Record<string, Uint8Array>): NonNullable<DevinTraceDeps["readFile"]> {
  return async (path, maxBytes) => {
    const data = map[path];
    if (data === undefined) throw Object.assign(new Error("no such file"), { code: "ENOENT" });
    return data.subarray(0, maxBytes);
  };
}

function router(map: Record<string, Uint8Array>, sessionsDb: NonNullable<DevinTraceDeps["sessionsDb"]>): DevinSessionReader {
  return createDevinSessionReader({ transcriptsDir: DIR, readFile: files(map), sessionsDb });
}

function source(reader: DevinSessionReader): TraceSource {
  return createTraceSource({ devinSession: reader });
}

const signal = () => new AbortController().signal;
const pathOf = (sessionId: string) => `${DIR}/${sessionId}.json`;

const dirs: string[] = [];
const handles: DatabaseSync[] = [];

/** A fixture store in a fresh temp dir; the write handle stays open for appends. */
function seededStore(head: number | null, nodes: FixtureNode[] = midTurnChain()): { dbPath: string; db: DatabaseSync } {
  const dir = mkdtempSync(join(tmpdir(), "herdr-devin-db-"));
  const dbPath = join(dir, "sessions.db");
  const db = createFixtureDb(dbPath);
  dirs.push(dir);
  handles.push(db);
  addSession(db, "sess-1", head);
  addNodes(db, "sess-1", nodes);
  return { dbPath, db };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const db of handles.splice(0)) {
    try {
      db.close();
    } catch {
      // A test that closed its own handle leaves nothing to close.
    }
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/**
 * The mid-turn session from the research note: an abandoned root chain
 * (nodes 0–2), the main chain rooted at 3, a draft sibling (5) superseded by
 * its committed twin (6), tool nodes 7–8, and an in-flight draft tail (9)
 * past the committed head.
 */
function midTurnChain(): FixtureNode[] {
  return [
    { nodeId: 0, parent: null, message: systemMessage("abandoned prefix", "r0") },
    { nodeId: 1, parent: 0, message: userMessage("abandoned prompt", "r1") },
    { nodeId: 2, parent: 1, message: assistantMessage("abandoned reply", { messageId: "r2" }) },
    { nodeId: 3, parent: null, message: systemMessage("system prompt") },
    { nodeId: 4, parent: 3, message: userMessage("do the thing") },
    {
      nodeId: 5,
      parent: 4,
      message: assistantMessage("draft", { messageId: "a1", calls: [{ id: "c1", name: "exec", arguments: { command: "ls" } }] }),
    },
    {
      nodeId: 6,
      parent: 4,
      message: assistantMessage("running tools", {
        messageId: "a1",
        calls: [
          { id: "c1", name: "exec", arguments: { command: "ls" } },
          { id: "c2", name: "read", arguments: { file_path: "/repo/x.ts" } },
        ],
      }),
    },
    { nodeId: 7, parent: 6, message: toolMessage("c1", "file list") },
    { nodeId: 8, parent: 7, message: toolMessage("c2", "file contents") },
    {
      nodeId: 9,
      parent: 8,
      message: assistantMessage("draft in flight", { messageId: "a2", calls: [{ id: "c3", name: "exec", arguments: { command: "npm test" } }] }),
    },
  ];
}

describe("devin sessions.db reader", () => {
  it("emits the main chain's committed steps mid-turn, excluding drafts and abandoned roots", async () => {
    const { dbPath } = seededStore(8);
    const window = await source(router({}, { dbPath })).read(identity(), undefined, signal());
    expect(window.typedFailure).toBeUndefined();
    expect(window.source).toBe("devin-session");
    expect(window.events.map((event) => event.kind)).toEqual(["system", "user", "agent"]);
    expect(window.events.map((event) => event.offset)).toEqual([1, 2, 3]);
    const record = window.events[2]!.record as Record<string, unknown>;
    expect(record).toEqual({
      step_id: 3,
      source: "agent",
      message: "running tools",
      tool_calls: [
        { tool_call_id: "c1", function_name: "exec", arguments: { command: "ls" } },
        { tool_call_id: "c2", function_name: "read", arguments: { file_path: "/repo/x.ts" } },
      ],
      observation: { results: [{ source_call_id: "c1", content: "file list" }, { source_call_id: "c2", content: "file contents" }] },
      model_name: "swe-2-max",
    });
    // The store projection carries only the ATIF fields — none of the
    // transcript-only keys and none of the row-only metadata.
    expect(record).not.toHaveProperty("timestamp");
    expect(record).not.toHaveProperty("metrics");
    expect(JSON.stringify(window)).not.toContain(CANARY_CONTENT);
    expect(window.cursorTo).toEqual({
      source: "devin-session",
      position: { session: "sess-1", steps: 3, anchor: expect.stringMatching(/^[0-9a-f]{64}$/), db: { v: 1, node: 8, rows: 9, maxRow: 9 } },
    });
    expect(window.byteCount).toBe(window.events.reduce((total, event) => total + event.bytes, 0));
  });

  it("continues from the cursor and emits only newly committed steps", async () => {
    const { dbPath, db } = seededStore(8);
    const trace = source(router({}, { dbPath }));
    const first = await trace.read(identity(), undefined, signal());
    expect(first.events).toHaveLength(3);
    addNodes(db, "sess-1", [
      {
        nodeId: 10,
        parent: 8,
        message: assistantMessage("tests pass", { messageId: "a2", calls: [{ id: "c3", name: "exec", arguments: { command: "npm test" } }] }),
      },
      { nodeId: 11, parent: 10, message: toolMessage("c3", "ok") },
    ]);
    setHead(db, "sess-1", 11);
    const second = await trace.read(identity(), first.cursorTo, signal());
    expect(second.typedFailure).toBeUndefined();
    expect(second.cursorFrom).toEqual(first.cursorTo);
    expect(second.events.map((event) => event.offset)).toEqual([4]);
    expect((second.events[0]!.record as { message: string }).message).toBe("tests pass");
    expect(second.cursorTo).toMatchObject({ position: { session: "sess-1", steps: 4, db: { v: 1, node: 11 } } });
    const third = await trace.read(identity(), second.cursorTo, signal());
    expect(third.typedFailure).toBeUndefined();
    expect(third.events).toEqual([]);
    expect(third.cursorTo).toEqual(second.cursorTo);
  });

  it("defers the last step while its tool call is still in flight, then emits it whole", async () => {
    const { dbPath, db } = seededStore(4, midTurnChain().slice(0, 5));
    const trace = source(router({}, { dbPath }));
    addNodes(db, "sess-1", [
      {
        nodeId: 6,
        parent: 4,
        message: assistantMessage("running tools", {
          messageId: "a1",
          calls: [
            { id: "c1", name: "exec", arguments: { command: "ls" } },
            { id: "c2", name: "read", arguments: { file_path: "/repo/x.ts" } },
          ],
        }),
      },
      { nodeId: 7, parent: 6, message: toolMessage("c1", "file list") },
    ]);
    setHead(db, "sess-1", 7);
    const first = await trace.read(identity(), undefined, signal());
    // The committed sibling waits for c2's tool node: only the two opening
    // steps are consumed, and the cursor stops before node 6.
    expect(first.typedFailure).toBeUndefined();
    expect(first.events.map((event) => event.offset)).toEqual([1, 2]);
    expect(first.cursorTo).toMatchObject({ position: { steps: 2, db: { node: 4 } } });
    addNode(db, "sess-1", { nodeId: 8, parent: 7, message: toolMessage("c2", "file contents") });
    setHead(db, "sess-1", 8);
    const second = await trace.read(identity(), first.cursorTo, signal());
    expect(second.typedFailure).toBeUndefined();
    expect(second.events.map((event) => event.offset)).toEqual([3]);
    expect((second.events[0]!.record as { observation: { results: unknown[] } }).observation.results).toHaveLength(2);
  });

  it("survives the turn-end INSERT OR REPLACE re-mint without loss or duplication", async () => {
    const { dbPath, db } = seededStore(8);
    const trace = source(router({}, { dbPath }));
    const first = await trace.read(identity(), undefined, signal());
    remintNodes(db, "sess-1");
    // The batch moved every row_id; the node_id + anchor cursor re-verifies.
    const second = await trace.read(identity(), first.cursorTo, signal());
    expect(second.typedFailure).toBeUndefined();
    expect(second.events).toEqual([]);
    expect(second.cursorTo).toMatchObject({ position: { session: "sess-1", steps: 3, db: { v: 1, node: 8 } } });
    expect(second.cursorTo).not.toEqual(first.cursorTo); // the watermark re-minted
    addNode(db, "sess-1", { nodeId: 10, parent: 8, message: assistantMessage("turn end", { messageId: "a3" }) });
    setHead(db, "sess-1", 10);
    const third = await trace.read(identity(), second.cursorTo, signal());
    expect(third.typedFailure).toBeUndefined();
    expect(third.events.map((event) => event.offset)).toEqual([4]);
  });

  it("fails source_rewritten when a consumed node's content is replaced", async () => {
    const { dbPath, db } = seededStore(8);
    const trace = source(router({}, { dbPath }));
    const first = await trace.read(identity(), undefined, signal());
    db.prepare("INSERT OR REPLACE INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at, metadata) VALUES ('sess-1', 6, 4, ?, 2, NULL)").run(
      JSON.stringify(assistantMessage("REWRITTEN", { messageId: "a1" })),
    );
    const window = await trace.read(identity(), first.cursorTo, signal());
    expect(window.typedFailure).toMatchObject({ kind: "source_rewritten", detail: { reason: "anchor_mismatch" } });
    expect(window.events).toEqual([]);
    expect(window.cursorTo).toEqual(first.cursorTo);
  });

  it("fails source_rewritten when a consumed node is UPDATEd in place, without a remint", async () => {
    const { dbPath, db } = seededStore(8);
    const trace = source(router({}, { dbPath }));
    const first = await trace.read(identity(), undefined, signal());
    // An in-place UPDATE moves neither count(*) nor max(row_id): the prefix
    // watermark alone cannot see it, so the anchor must re-verify regardless.
    db.prepare("UPDATE message_nodes SET chat_message = ? WHERE session_id = 'sess-1' AND node_id = 6").run(
      JSON.stringify(assistantMessage("EDITED IN PLACE", { messageId: "a1" })),
    );
    const window = await trace.read(identity(), first.cursorTo, signal());
    expect(window.typedFailure).toMatchObject({ kind: "source_rewritten", detail: { reason: "anchor_mismatch" } });
    expect(window.events).toEqual([]);
    expect(window.cursorTo).toEqual(first.cursorTo);
  });

  it("fails source_rewritten when the committed head rewinds to an already-consumed node", async () => {
    const { dbPath, db } = seededStore(8);
    const trace = source(router({}, { dbPath }));
    const first = await trace.read(identity(), undefined, signal());
    // A revert: main_chain_id moves back to consumed node 4. The walk from the
    // head can never reach the cursor at node 8 — a rewrite, not corruption.
    setHead(db, "sess-1", 4);
    const window = await trace.read(identity(), first.cursorTo, signal());
    expect(window.typedFailure).toMatchObject({ kind: "source_rewritten", detail: { reason: "not_ancestor" } });
    expect(window.events).toEqual([]);
    expect(window.cursorTo).toEqual(first.cursorTo);
  });

  it("fails source_rewritten when the head re-roots to a branch without the cursor", async () => {
    const { dbPath, db } = seededStore(8);
    const trace = source(router({}, { dbPath }));
    const first = await trace.read(identity(), undefined, signal());
    // A revert: the head moves to a new branch hanging off node 4, so the
    // consumed node 8 is no longer an ancestor of the committed head.
    addNode(db, "sess-1", { nodeId: 10, parent: 4, message: userMessage("different direction", "u2") });
    setHead(db, "sess-1", 10);
    const window = await trace.read(identity(), first.cursorTo, signal());
    expect(window.typedFailure).toMatchObject({ kind: "source_rewritten", detail: { reason: "not_ancestor" } });
    expect(window.events).toEqual([]);
    expect(JSON.stringify(window.typedFailure)).not.toContain(CANARY_CONTENT);
  });

  it("fails source_rewritten when the session row is deleted", async () => {
    const { dbPath, db } = seededStore(8);
    const trace = source(router({}, { dbPath }));
    const first = await trace.read(identity(), undefined, signal());
    db.prepare("DELETE FROM sessions WHERE id = 'sess-1'").run();
    db.prepare("DELETE FROM message_nodes WHERE session_id = 'sess-1'").run();
    const window = await trace.read(identity(), first.cursorTo, signal());
    expect(window.typedFailure).toMatchObject({ kind: "source_rewritten", detail: { reason: "session_absent" } });
  });

  it("keeps a store cursor on the store even after the store disappears — never downgraded to the transcript", async () => {
    const { dbPath, db } = seededStore(8);
    const trace = source(router({ [pathOf("sess-1")]: atifDoc("sess-1", [atifStep(1, { source: "user", message: "hi" })]) }, { dbPath }));
    const first = await trace.read(identity(), undefined, signal());
    expect(first.typedFailure).toBeUndefined();
    db.close();
    await rm(dbPath, { force: true });
    const window = await trace.read(identity(), first.cursorTo, signal());
    expect(window.typedFailure).toEqual({ kind: "source_unreadable", detail: { code: "DEVIN_DB_UNAVAILABLE" } });
    expect(window.events).toEqual([]);
  });

  it("keeps a transcript cursor on the transcript backend even while the store is healthy", async () => {
    const { dbPath } = seededStore(8);
    const document = atifDoc("sess-1", [atifStep(1, { source: "user", message: "prompt" }), atifStep(2, { source: "agent", message: "done" })]);
    const transcriptOnly = router({ [pathOf("sess-1")]: document }, false);
    const transcriptRead = await transcriptOnly("sess-1", undefined, signal());
    // The same router — store present — still honours the transcript-minted
    // cursor on its own backend: the cursor never upgrades mid-run.
    const window = await source(router({ [pathOf("sess-1")]: document }, { dbPath })).read(identity(), { source: "devin-session", position: transcriptRead.position }, signal());
    expect(window.typedFailure).toBeUndefined();
    expect((window.cursorTo as TraceCursor & { position: { db?: unknown } }).position.db).toBeUndefined();
  });

  it("falls back to the transcript reader when the store file is absent", async () => {
    const document = atifDoc("sess-1", [atifStep(1, { source: "user", message: "prompt" })]);
    const window = await source(router({ [pathOf("sess-1")]: document }, { dbPath: join(tmpdir(), "no-such-devin-store-9e7f", "sessions.db") })).read(identity(), undefined, signal());
    expect(window.typedFailure).toBeUndefined();
    expect(window.events.map((event) => event.kind)).toEqual(["user"]);
    expect((window.events[0]!.record as Record<string, unknown>).timestamp).toBe("t1");
  });

  it("falls back to the transcript reader when node:sqlite cannot be imported", async () => {
    const document = atifDoc("sess-1", [atifStep(1, { source: "user", message: "prompt" })]);
    const openDatabase: DevinSessionsDbOpener = async () => {
      throw Object.assign(new Error("Cannot find module 'node:sqlite'"), { code: "ERR_MODULE_NOT_FOUND" });
    };
    const window = await source(router({ [pathOf("sess-1")]: document }, { dbPath: "x", openDatabase })).read(identity(), undefined, signal());
    expect(window.typedFailure).toBeUndefined();
    expect(window.events.map((event) => event.kind)).toEqual(["user"]);
  });

  it("falls back to the transcript reader when the session id is not in the store", async () => {
    const { dbPath } = seededStore(8);
    const document = atifDoc("sess-9", [atifStep(1, { source: "user", message: "prompt" })]);
    const window = await source(router({ [pathOf("sess-9")]: document }, { dbPath })).read(identity("sess-9"), undefined, signal());
    expect(window.typedFailure).toBeUndefined();
    expect(window.events.map((event) => event.kind)).toEqual(["user"]);
  });

  it.each([
    ["an unknown compat version", (db: DatabaseSync) => db.prepare("UPDATE app_state SET value = '1' WHERE key = 'schema_compat_version'").run()],
    ["an unknown migration", (db: DatabaseSync) => db.prepare("INSERT INTO refinery_schema_history (version, name) VALUES (18, 'unknown_future')").run()],
    ["a dropped column", (db: DatabaseSync) => db.prepare("ALTER TABLE message_nodes DROP COLUMN chat_message").run()],
    ["a dropped unique index", (db: DatabaseSync) => {
      db.exec("CREATE TABLE message_nodes_new (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, node_id INTEGER NOT NULL, parent_node_id INTEGER, chat_message TEXT NOT NULL, created_at INTEGER NOT NULL, metadata TEXT)");
      db.exec("INSERT INTO message_nodes_new SELECT * FROM message_nodes");
      db.exec("DROP TABLE message_nodes");
      db.exec("ALTER TABLE message_nodes_new RENAME TO message_nodes");
      db.exec("CREATE INDEX idx_message_nodes_session ON message_nodes(session_id)");
    }],
  ])("falls back to the transcript reader on a closed gate: %s", async (_name, mutate) => {
    const { dbPath, db } = seededStore(8);
    mutate(db);
    const document = atifDoc("sess-1", [atifStep(1, { source: "user", message: "prompt" })]);
    const window = await source(router({ [pathOf("sess-1")]: document }, { dbPath })).read(identity(), undefined, signal());
    expect(window.typedFailure).toBeUndefined();
    expect(window.events.map((event) => event.kind)).toEqual(["user"]);
    expect((window.events[0]!.record as Record<string, unknown>).timestamp).toBe("t1");
  });

  it("fails source_unreadable DEVIN_DB_SCHEMA when the gate closes under a store cursor", async () => {
    const { dbPath, db } = seededStore(8);
    const trace = source(router({ [pathOf("sess-1")]: atifDoc("sess-1", [atifStep(1, { source: "user", message: "prompt" })]) }, { dbPath }));
    const first = await trace.read(identity(), undefined, signal());
    expect(first.typedFailure).toBeUndefined();
    db.prepare("UPDATE app_state SET value = '9' WHERE key = 'schema_compat_version'").run();
    const window = await trace.read(identity(), first.cursorTo, signal());
    expect(window.typedFailure).toEqual({ kind: "source_unreadable", detail: { code: "DEVIN_DB_SCHEMA" } });
    expect(window.events).toEqual([]);
  });

  it("closes the gate when a migration row appears after a successful read", async () => {
    const { dbPath, db } = seededStore(8);
    const document = atifDoc("sess-1", [atifStep(1, { source: "user", message: "prompt" })]);
    const trace = source(router({ [pathOf("sess-1")]: document }, { dbPath }));
    const first = await trace.read(identity(), undefined, signal());
    expect(first.typedFailure).toBeUndefined();
    // Migration rows are data, not DDL: inserting one does not bump the
    // schema cookie, so the allow-list is re-checked on every read.
    db.prepare("INSERT INTO refinery_schema_history (version, name) VALUES (18, 'unknown_future')").run();
    const window = await trace.read(identity(), first.cursorTo, signal());
    expect(window.typedFailure).toEqual({ kind: "source_unreadable", detail: { code: "DEVIN_DB_SCHEMA" } });
    expect(window.events).toEqual([]);
    const fresh = await trace.read(identity(), undefined, signal());
    expect(fresh.typedFailure).toBeUndefined();
    expect(fresh.events.map((event) => event.kind)).toEqual(["user"]);
    expect((fresh.events[0]!.record as Record<string, unknown>).timestamp).toBe("t1");
  });

  it.each([5, 6, 10])("treats sqlite errcode %i as transient — never a transcript fallback", async (errcode) => {
    const openDatabase: DevinSessionsDbOpener = async () => {
      throw Object.assign(new Error("database is busy"), { errcode });
    };
    const document = atifDoc("sess-1", [atifStep(1, { source: "user", message: "prompt" })]);
    const window = await source(router({ [pathOf("sess-1")]: document }, { dbPath: "x", openDatabase })).read(identity(), undefined, signal());
    expect(window.typedFailure).toMatchObject({ kind: "source_unreadable" });
    expect(window.events).toEqual([]);
    expect(window.cursorTo).toBeUndefined();
  });

  it("reports an oversized first step once and resumes past it", async () => {
    const { dbPath, db } = seededStore(4, midTurnChain().slice(0, 5));
    const trace = source(router({}, { dbPath }));
    addNodes(db, "sess-1", [
      { nodeId: 6, parent: 4, message: assistantMessage("x".repeat(TRACE_WINDOW_MAX_BYTES), { messageId: "a9" }) },
      { nodeId: 8, parent: 6, message: assistantMessage("after", { messageId: "a10" }) },
    ]);
    setHead(db, "sess-1", 8);
    const first = await trace.read(identity(), undefined, signal());
    expect(first.events.map((event) => event.offset)).toEqual([1, 2]);
    const overflow = await trace.read(identity(), first.cursorTo, signal());
    expect(overflow.typedFailure).toEqual({ kind: "record_exceeds_budget", detail: { step: 3, bytes: expect.any(Number), skipped: true } });
    expect(overflow.events).toEqual([]);
    expect(overflow.cursorTo).toMatchObject({ position: { steps: 3, db: { node: 6 } } });
    const resumed = await trace.read(identity(), overflow.cursorTo, signal());
    expect(resumed.typedFailure).toBeUndefined();
    expect(resumed.events.map((event) => event.offset)).toEqual([4]);
  });

  it("defers a step that would cross the window budget and resumes it next cadence", async () => {
    const { dbPath, db } = seededStore(4, midTurnChain().slice(0, 5));
    const trace = source(router({}, { dbPath }));
    addNodes(db, "sess-1", [
      { nodeId: 6, parent: 4, message: assistantMessage("x".repeat(20_000), { messageId: "a5" }) },
      { nodeId: 8, parent: 6, message: assistantMessage("y".repeat(20_000), { messageId: "a6" }) },
    ]);
    setHead(db, "sess-1", 8);
    const first = await trace.read(identity(), undefined, signal());
    expect(first.typedFailure).toBeUndefined();
    expect(first.byteCount).toBeLessThanOrEqual(TRACE_WINDOW_MAX_BYTES);
    expect(first.events.map((event) => event.offset)).toEqual([1, 2, 3]);
    const second = await trace.read(identity(), first.cursorTo, signal());
    expect(second.typedFailure).toBeUndefined();
    expect(second.events.map((event) => event.offset)).toEqual([4]);
  });

  it("fails source_exceeds_budget past the per-step raw cap", async () => {
    const { dbPath, db } = seededStore(4, midTurnChain().slice(0, 5));
    const trace = source(router({}, { dbPath, stepRawMaxBytes: 1024 }));
    addNode(db, "sess-1", { nodeId: 6, parent: 4, message: assistantMessage("x".repeat(2_000), { messageId: "a7" }) });
    setHead(db, "sess-1", 6);
    const window = await trace.read(identity(), undefined, signal());
    expect(window.typedFailure).toMatchObject({ kind: "source_exceeds_budget", detail: { reason: "step_raw" } });
    expect(JSON.stringify(window.typedFailure)).not.toContain(CANARY_CONTENT);
  });

  it("fails source_exceeds_budget past the new-nodes cap", async () => {
    const { dbPath } = seededStore(4, midTurnChain().slice(0, 5));
    const trace = source(router({}, { dbPath, newNodesMax: 3 }));
    const window = await trace.read(identity(), undefined, signal());
    expect(window.typedFailure).toMatchObject({ kind: "source_exceeds_budget", detail: { reason: "new_nodes" } });
  });

  it("reads the forest skeleton only — bodies off the main chain are never parsed or budgeted", async () => {
    const { dbPath, db } = seededStore(8);
    // A second abandoned branch past the head: a >8 MiB body that is not even
    // valid JSON, plus its child. Neither can be a consumed chain node, so
    // neither may be parsed — and the oversized one may not trip any byte cap.
    addNodes(db, "sess-1", [
      { nodeId: 10, parent: null, message: `{${"x".repeat(9 * 1024 * 1024)}` },
      { nodeId: 11, parent: 10, message: userMessage("abandoned too", "r11") },
    ]);
    const prepared: string[] = [];
    const openDatabase: DevinSessionsDbOpener = (path, timeout) => {
      const inner = new DatabaseSync(path, { readOnly: true, timeout });
      return {
        prepare: (sql) => {
          prepared.push(sql);
          return inner.prepare(sql);
        },
        exec: (sql) => inner.exec(sql),
        close: () => inner.close(),
      };
    };
    const window = await source(router({}, { dbPath, openDatabase })).read(identity(), undefined, signal());
    expect(window.typedFailure).toBeUndefined();
    expect(window.events.map((event) => event.offset)).toEqual([1, 2, 3]);
    // Skeleton queries select ids, parents and lengths only; roles and bodies
    // are read per consumed node, never by parsing every forest row.
    for (const sql of prepared) {
      expect(sql).not.toMatch(/json_(valid|extract)/i);
    }
  });

  it("fails source_exceeds_budget when a folded tool node alone crosses the raw cap", async () => {
    const { dbPath, db } = seededStore(4, midTurnChain().slice(0, 5));
    const trace = source(router({}, { dbPath, stepRawMaxBytes: 1024 }));
    addNodes(db, "sess-1", [
      { nodeId: 6, parent: 4, message: assistantMessage("working", { messageId: "a1", calls: [{ id: "c1", name: "exec", arguments: {} }] }) },
      { nodeId: 7, parent: 6, message: toolMessage("c1", "x".repeat(2_000)) },
    ]);
    setHead(db, "sess-1", 7);
    const window = await trace.read(identity(), undefined, signal());
    expect(window.typedFailure).toMatchObject({ kind: "source_exceeds_budget", detail: { reason: "step_raw", step: 3 } });
  });

  it("fails source_exceeds_budget on an oversized node whose body is not even valid JSON", async () => {
    const { dbPath, db } = seededStore(4, midTurnChain().slice(0, 5));
    const trace = source(router({}, { dbPath, stepRawMaxBytes: 1024 }));
    addNode(db, "sess-1", { nodeId: 6, parent: 4, message: `{${"x".repeat(2_000)}` });
    setHead(db, "sess-1", 6);
    const window = await trace.read(identity(), undefined, signal());
    expect(window.typedFailure).toMatchObject({ kind: "source_exceeds_budget", detail: { reason: "step_raw", step: 3 } });
  });

  it("fails source_malformed on an oversized orphan tool node", async () => {
    const { dbPath, db } = seededStore(4, midTurnChain().slice(0, 5));
    const trace = source(router({}, { dbPath, stepRawMaxBytes: 1024 }));
    addNode(db, "sess-1", { nodeId: 6, parent: 4, message: toolMessage("c1", "x".repeat(2_000)) });
    setHead(db, "sess-1", 6);
    const window = await trace.read(identity(), undefined, signal());
    expect(window.typedFailure).toMatchObject({ kind: "source_malformed", detail: { reason: "orphan_tool_node" } });
  });

  it("fails source_exceeds_budget when a step's combined node bytes cross the raw cap", async () => {
    const { dbPath, db } = seededStore(4, midTurnChain().slice(0, 5));
    const trace = source(router({}, { dbPath, stepRawMaxBytes: 1024 }));
    addNodes(db, "sess-1", [
      {
        nodeId: 6,
        parent: 4,
        message: assistantMessage("working", {
          messageId: "a1",
          calls: [
            { id: "c1", name: "exec", arguments: {} },
            { id: "c2", name: "exec", arguments: {} },
          ],
        }),
      },
      { nodeId: 7, parent: 6, message: toolMessage("c1", "x".repeat(900)) },
      { nodeId: 8, parent: 7, message: toolMessage("c2", "x".repeat(900)) },
    ]);
    setHead(db, "sess-1", 8);
    const window = await trace.read(identity(), undefined, signal());
    expect(window.typedFailure).toMatchObject({ kind: "source_exceeds_budget", detail: { reason: "step_raw", step: 3 } });
  });

  it("fails source_exceeds_budget when the turn-end re-verify exceeds its cap", async () => {
    const { dbPath, db } = seededStore(8);
    const trace = source(router({}, { dbPath, reverifyMaxBytes: 10 }));
    const first = await trace.read(identity(), undefined, signal());
    remintNodes(db, "sess-1");
    const window = await trace.read(identity(), first.cursorTo, signal());
    expect(window.typedFailure).toMatchObject({ kind: "source_exceeds_budget", detail: { reason: "reverify" } });
  });

  it("measures the re-verify ceiling on the consumed chain only, ignoring abandoned-branch bytes", async () => {
    const chain = midTurnChain();
    chain[1] = { nodeId: 1, parent: 0, message: userMessage("x".repeat(4_000), "r1") };
    const { dbPath, db } = seededStore(8, chain);
    const trace = source(router({}, { dbPath, reverifyMaxBytes: 2_000 }));
    const first = await trace.read(identity(), undefined, signal());
    expect(first.typedFailure).toBeUndefined();
    remintNodes(db, "sess-1");
    // The prefix below the cursor holds ~4 KiB of abandoned-branch bodies the
    // anchor never hashed; only the small consumed ancestry counts.
    const window = await trace.read(identity(), first.cursorTo, signal());
    expect(window.typedFailure).toBeUndefined();
    expect(window.events).toEqual([]);
  });

  it.each([
    ["invalid JSON", "not-json{{{", "invalid_json"],
    ["a non-object", "42", "not_object"],
    ["an unknown role", { message_id: "m", role: "alien", content: "x" }, "role_invalid"],
    ["a missing message_id", { role: "user", content: "x" }, "message_id_invalid"],
    ["a non-string content", { message_id: "m", role: "user", content: 5 }, "content_invalid"],
    ["non-array tool_calls", { message_id: "m", role: "assistant", content: "x", tool_calls: {} }, "tool_calls_invalid"],
    ["a call without id", { message_id: "m", role: "assistant", content: "x", tool_calls: [{ name: "exec", arguments: {} }] }, "tool_call_invalid"],
  ])("fails source_malformed on a consumed node with %s", async (_name, message, reason) => {
    const { dbPath, db } = seededStore(4, midTurnChain().slice(0, 5));
    addNode(db, "sess-1", { nodeId: 6, parent: 4, message: message as FixtureNode["message"] });
    setHead(db, "sess-1", 6);
    const window = await source(router({}, { dbPath })).read(identity(), undefined, signal());
    expect(window.typedFailure).toMatchObject({ kind: "source_malformed", detail: { reason } });
    expect(JSON.stringify(window.typedFailure)).not.toContain(CANARY_CONTENT);
    expect(JSON.stringify(window.typedFailure)).not.toContain(CANARY_PATH);
  });

  it("fails source_malformed on an orphaned tool node", async () => {
    const { dbPath, db } = seededStore(4, midTurnChain().slice(0, 5));
    addNode(db, "sess-1", { nodeId: 6, parent: 4, message: toolMessage("c1", "unpaired") });
    setHead(db, "sess-1", 6);
    const window = await source(router({}, { dbPath })).read(identity(), undefined, signal());
    expect(window.typedFailure).toMatchObject({ kind: "source_malformed", detail: { reason: "orphan_tool_node" } });
  });

  it("fails source_malformed on a folded tool node without tool_call_id", async () => {
    const { dbPath, db } = seededStore(4, midTurnChain().slice(0, 5));
    addNodes(db, "sess-1", [
      { nodeId: 6, parent: 4, message: assistantMessage("working", { messageId: "a1", calls: [{ id: "c1", name: "exec", arguments: {} }] }) },
      { nodeId: 7, parent: 6, message: { message_id: "t1", role: "tool", content: "no call id" } },
    ]);
    setHead(db, "sess-1", 7);
    const window = await source(router({}, { dbPath })).read(identity(), undefined, signal());
    expect(window.typedFailure).toMatchObject({ kind: "source_malformed", detail: { reason: "tool_call_id_invalid" } });
  });

  it("projects records identical to the transcript reader's on the same session", async () => {
    const { dbPath } = seededStore(8);
    const live = await router({}, { dbPath })("sess-1", undefined, signal());
    const document = atifDoc("sess-1", [
      atifStep(1, { source: "system", message: "system prompt" }),
      atifStep(2, { source: "user", message: "do the thing" }),
      atifStep(3, {
        source: "agent",
        message: "running tools",
        tool_calls: [
          { tool_call_id: "c1", function_name: "exec", arguments: { command: "ls" } },
          { tool_call_id: "c2", function_name: "read", arguments: { file_path: "/repo/x.ts" } },
        ],
        observation: { results: [{ source_call_id: "c1", content: "file list" }, { source_call_id: "c2", content: "file contents" }] },
        model_name: "swe-2-max",
        metrics: { prompt_tokens: 10 },
      }),
    ]);
    const transcript = await router({ [pathOf("sess-1")]: document }, false)("sess-1", undefined, signal());
    const project = (record: unknown): unknown => {
      const step = record as Record<string, unknown>;
      const out: Record<string, unknown> = { step_id: step.step_id, source: step.source, message: step.message };
      for (const key of ["tool_calls", "observation", "model_name"] as const) {
        if (Object.prototype.hasOwnProperty.call(step, key)) out[key] = step[key];
      }
      return out;
    };
    expect(live.events.map((event) => event.record)).toEqual(transcript.events.map((event) => project(event.record)));
  });

  it("reads the last committed snapshot while a writer holds an open transaction", async () => {
    const { dbPath, db } = seededStore(8);
    const writer = new DatabaseSync(dbPath);
    handles.push(writer);
    writer.exec("BEGIN IMMEDIATE");
    writer.prepare("INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at) VALUES ('sess-1', 12, 8, ?, 1)").run(
      JSON.stringify(userMessage("uncommitted")),
    );
    const executed: string[] = [];
    const prepared: string[] = [];
    const openDatabase: DevinSessionsDbOpener = (path, timeout) => {
      const inner = new DatabaseSync(path, { readOnly: true, timeout });
      return {
        prepare: (sql) => { prepared.push(sql); return inner.prepare(sql); },
        exec: (sql) => { executed.push(sql); inner.exec(sql); },
        close: () => inner.close(),
      };
    };
    const window = await source(router({}, { dbPath, openDatabase })).read(identity(), undefined, signal());
    expect(window.typedFailure).toBeUndefined();
    expect(window.events.map((event) => event.offset)).toEqual([1, 2, 3]);
    expect(executed).toContain("PRAGMA query_only = 1");
    expect(executed.filter((sql) => sql === "BEGIN" || sql === "COMMIT")).toEqual(["BEGIN", "COMMIT"]);
    // Every production SELECT is an index seek or a bounded ordered index
    // walk — except the two tiny allow-list tables (17 migration rows, the
    // 1-row app_state), which the real store also scans.
    for (const sql of prepared) {
      if (!/^\s*select/i.test(sql) || /pragma_/i.test(sql)) continue;
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail?: unknown }>;
      expect(plan.length).toBeGreaterThan(0);
      for (const line of plan) {
        const detail = String(line.detail);
        const indexed = /SEARCH|USING (COVERING )?INDEX/i.test(detail);
        const tinyScan = /FROM (refinery_schema_history|app_state)/i.test(sql) && /SCAN (refinery_schema_history|app_state)/i.test(detail);
        expect(indexed || tinyScan).toBe(true);
      }
    }
    writer.exec("ROLLBACK");
  });

  it.each([
    ["a non-object position", "x"],
    ["a store position minted for another session", { session: "sess-2", steps: 0, anchor: "a".repeat(64), db: { v: 1, node: -1, rows: 0, maxRow: 0 } }],
    ["a non-integer node", { session: "sess-1", steps: 0, anchor: "a".repeat(64), db: { v: 1, node: 1.5, rows: 0, maxRow: 0 } }],
    ["a negative watermark", { session: "sess-1", steps: 0, anchor: "a".repeat(64), db: { v: 1, node: -1, rows: -1, maxRow: 0 } }],
    ["an unknown cursor version", { session: "sess-1", steps: 0, anchor: "a".repeat(64), db: { v: 2, node: -1, rows: 0, maxRow: 0 } }],
    ["a malformed db block", { session: "sess-1", steps: 0, anchor: "a".repeat(64), db: "x" }],
    ["a fractional steps count", { session: "sess-1", steps: 1.5, anchor: "a".repeat(64), db: { v: 1, node: -1, rows: 0, maxRow: 0 } }],
  ])("fails closed on a malformed store position: %s", async (_name, position) => {
    const { dbPath } = seededStore(8);
    const prior: TraceCursor = { source: "devin-session", position };
    const window = await source(router({}, { dbPath })).read(identity(), prior, signal());
    expect(window.typedFailure).toMatchObject({ kind: "cursor_malformed" });
    expect(window.cursorTo).toEqual(prior);
  });

  it("fails cursor_malformed when a store position reaches a transcript-only reader", async () => {
    const document = atifDoc("sess-1", [atifStep(1, { source: "user", message: "prompt" })]);
    const prior: TraceCursor = { source: "devin-session", position: { session: "sess-1", steps: 1, anchor: "a".repeat(64), db: { v: 1, node: 3, rows: 4, maxRow: 4 } } };
    const window = await source(router({ [pathOf("sess-1")]: document }, false)).read(identity(), prior, signal());
    expect(window.typedFailure).toMatchObject({ kind: "cursor_malformed" });
  });

  it("reports an aborted read", async () => {
    const { dbPath } = seededStore(8);
    const controller = new AbortController();
    controller.abort();
    const window = await source(router({}, { dbPath })).read(identity(), undefined, controller.signal);
    expect(window.typedFailure).toMatchObject({ kind: "aborted" });
  });

  it("pins a steps-0 store cursor on a session with no committed head", async () => {
    const { dbPath } = seededStore(null, []);
    const window = await source(router({}, { dbPath })).read(identity(), undefined, signal());
    expect(window.typedFailure).toBeUndefined();
    expect(window.events).toEqual([]);
    expect(window.cursorTo).toEqual({
      source: "devin-session",
      position: { session: "sess-1", steps: 0, anchor: expect.stringMatching(/^[0-9a-f]{64}$/), db: { v: 1, node: -1, rows: 0, maxRow: 0 } },
    });
  });

  it("re-verifies a steps-0 store cursor while the session still has no head", async () => {
    const { dbPath } = seededStore(null, []);
    const trace = source(router({}, { dbPath }));
    const first = await trace.read(identity(), undefined, signal());
    const second = await trace.read(identity(), first.cursorTo, signal());
    expect(second.typedFailure).toBeUndefined();
    expect(second.events).toEqual([]);
    expect(second.cursorTo).toEqual(first.cursorTo);
  });

  it("issues the prefix watermark query only once per read", async () => {
    const { dbPath } = seededStore(8);
    const trace = source(router({}, { dbPath }));
    const first = await trace.read(identity(), undefined, signal());
    const prepared: string[] = [];
    const openDatabase: DevinSessionsDbOpener = (path, timeout) => {
      const inner = new DatabaseSync(path, { readOnly: true, timeout });
      return {
        prepare: (sql) => {
          prepared.push(sql);
          return inner.prepare(sql);
        },
        exec: (sql) => inner.exec(sql),
        close: () => inner.close(),
      };
    };
    // An unchanged continuation mints exactly one watermark — the cursor's —
    // instead of a second identical one in the same transaction.
    const window = await source(router({}, { dbPath, openDatabase })).read(identity(), first.cursorTo, signal());
    expect(window.typedFailure).toBeUndefined();
    expect(window.cursorTo).toEqual(first.cursorTo);
    expect(prepared.filter((sql) => sql.includes("count(*) AS rows"))).toHaveLength(1);
  });
});

describe("devin sessions.db reader edge paths", () => {
  /** A real `DatabaseSync` behind the handle, with chosen queries' `get` spoofed. */
  function spoofingOpener(dbPath: string, spoof: ReadonlyMap<string, { get?: () => unknown }>): DevinSessionsDbOpener {
    void dbPath;
    return (path, timeout) => {
      const inner = new DatabaseSync(path, { readOnly: true, timeout });
      return {
        prepare: (sql) => {
          for (const [needle, shape] of spoof) {
            if (sql.includes(needle)) {
              return { get: () => shape.get?.(), all: () => [] };
            }
          }
          return inner.prepare(sql);
        },
        exec: (sql) => inner.exec(sql),
        close: () => inner.close(),
      };
    };
  }

  it("rejects below the seam with cursor_malformed on a non-object position", async () => {
    const { dbPath } = seededStore(8);
    const read = createDevinSessionsDbReader({ dbPath });
    await expect(read("sess-1", "x", signal())).rejects.toMatchObject({ name: "DevinSourceError", failure: "cursor_malformed", detail: { reason: "position_not_object" } });
  });

  it("rejects below the seam with cursor_malformed on a bad anchor", async () => {
    const { dbPath } = seededStore(8);
    const read = createDevinSessionsDbReader({ dbPath });
    const position = { session: "sess-1", steps: 0, anchor: "not-hex", db: { v: 1, node: -1, rows: 0, maxRow: 0 } };
    await expect(read("sess-1", position, signal())).rejects.toMatchObject({ failure: "cursor_malformed", detail: { reason: "anchor_invalid" } });
  });

  it("accepts a store position whose ints arrive as bigints", async () => {
    const { dbPath } = seededStore(8);
    const trace = source(router({}, { dbPath }));
    const first = await trace.read(identity(), undefined, signal());
    const position = (first.cursorTo as TraceCursor & { position: { db: { v: number; node: number; rows: number; maxRow: number } } }).position;
    const widened = { ...position, db: { v: 1, node: BigInt(position.db.node), rows: BigInt(position.db.rows), maxRow: BigInt(position.db.maxRow) } };
    const second = await trace.read(identity(), { source: "devin-session", position: widened }, signal());
    expect(second.typedFailure).toBeUndefined();
    expect(second.events).toEqual([]);
  });

  it("falls back to the transcript reader when the compat row is absent and when app_state is gone", async () => {
    const document = atifDoc("sess-1", [atifStep(1, { source: "user", message: "prompt" })]);
    const missingRow = seededStore(8);
    missingRow.db.prepare("DELETE FROM app_state WHERE key = 'schema_compat_version'").run();
    let window = await source(router({ [pathOf("sess-1")]: document }, { dbPath: missingRow.dbPath })).read(identity(), undefined, signal());
    expect(window.typedFailure).toBeUndefined();
    expect(window.events.map((event) => event.kind)).toEqual(["user"]);
    const missingTable = seededStore(8);
    missingTable.db.exec("DROP TABLE app_state");
    window = await source(router({ [pathOf("sess-1")]: document }, { dbPath: missingTable.dbPath })).read(identity(), undefined, signal());
    expect(window.typedFailure).toBeUndefined();
    expect(window.events.map((event) => event.kind)).toEqual(["user"]);
  });

  it("fails source_malformed when the committed head is not an integer", async () => {
    const { dbPath, db } = seededStore(8);
    db.prepare("UPDATE sessions SET main_chain_id = 'not-an-int' WHERE id = 'sess-1'").run();
    const window = await source(router({}, { dbPath })).read(identity(), undefined, signal());
    expect(window.typedFailure).toMatchObject({ kind: "source_malformed", detail: { reason: "head_invalid" } });
  });

  it("fails source_rewritten when a consumed node is deleted between reads", async () => {
    const { dbPath, db } = seededStore(8);
    const trace = source(router({}, { dbPath }));
    const first = await trace.read(identity(), undefined, signal());
    db.prepare("DELETE FROM message_nodes WHERE session_id = 'sess-1' AND node_id = 6").run();
    const window = await trace.read(identity(), first.cursorTo, signal());
    expect(window.typedFailure).toMatchObject({ kind: "source_rewritten", detail: { reason: "anchor_mismatch" } });
  });

  it("fails source_rewritten when the consumed chain forms a parent cycle", async () => {
    const { dbPath, db } = seededStore(8);
    const trace = source(router({}, { dbPath }));
    const first = await trace.read(identity(), undefined, signal());
    db.prepare("UPDATE message_nodes SET parent_node_id = 8 WHERE session_id = 'sess-1' AND node_id = 6").run();
    db.prepare("INSERT OR REPLACE INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at) SELECT session_id, node_id, 6, chat_message, 2 FROM message_nodes WHERE session_id = 'sess-1' AND node_id = 8").run();
    const window = await trace.read(identity(), first.cursorTo, signal());
    expect(window.typedFailure).toMatchObject({ kind: "source_rewritten", detail: { reason: "anchor_mismatch" } });
  });

  it("fails source_rewritten when a consumed node_id is non-integer", async () => {
    const { dbPath, db } = seededStore(8);
    const trace = source(router({}, { dbPath }));
    const first = await trace.read(identity(), undefined, signal());
    db.prepare("INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at) VALUES ('sess-1', 4.5, 3, '{}', 1)").run();
    const window = await trace.read(identity(), first.cursorTo, signal());
    expect(window.typedFailure).toMatchObject({ kind: "source_rewritten", detail: { reason: "anchor_mismatch" } });
  });

  it("fails source_rewritten when a consumed parent is non-integer", async () => {
    const { dbPath, db } = seededStore(8);
    const trace = source(router({}, { dbPath }));
    const first = await trace.read(identity(), undefined, signal());
    db.prepare("INSERT OR REPLACE INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at) SELECT session_id, node_id, 'x', chat_message, 2 FROM message_nodes WHERE session_id = 'sess-1' AND node_id = 4").run();
    const window = await trace.read(identity(), first.cursorTo, signal());
    expect(window.typedFailure).toMatchObject({ kind: "source_rewritten", detail: { reason: "anchor_mismatch" } });
  });

  it("fails source_malformed when a new row's parent is non-integer", async () => {
    const { dbPath, db } = seededStore(4, midTurnChain().slice(0, 5));
    db.prepare("INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at) VALUES ('sess-1', 10, 'x', '{}', 1)").run();
    setHead(db, "sess-1", 10);
    const window = await source(router({}, { dbPath })).read(identity(), undefined, signal());
    expect(window.typedFailure).toMatchObject({ kind: "source_malformed", detail: { reason: "row_invalid" } });
  });

  it("fails source_rewritten when the committed head is nulled under a live cursor", async () => {
    const { dbPath, db } = seededStore(8);
    const trace = source(router({}, { dbPath }));
    const first = await trace.read(identity(), undefined, signal());
    setHead(db, "sess-1", null);
    const window = await trace.read(identity(), first.cursorTo, signal());
    expect(window.typedFailure).toMatchObject({ kind: "source_rewritten", detail: { reason: "not_ancestor" } });
  });

  it("fails source_malformed when the new segment forms a parent cycle", async () => {
    const { dbPath, db } = seededStore(4, midTurnChain().slice(0, 5));
    addNodes(db, "sess-1", [
      { nodeId: 10, parent: 11, message: userMessage("loop a", "u10") },
      { nodeId: 11, parent: 10, message: userMessage("loop b", "u11") },
    ]);
    setHead(db, "sess-1", 10);
    const window = await source(router({}, { dbPath })).read(identity(), undefined, signal());
    expect(window.typedFailure).toMatchObject({ kind: "source_malformed", detail: { reason: "chain_cycle" } });
  });

  it("fails source_rewritten when the head moves to a fresh root under a live cursor", async () => {
    const { dbPath, db } = seededStore(8);
    const trace = source(router({}, { dbPath }));
    const first = await trace.read(identity(), undefined, signal());
    addNode(db, "sess-1", { nodeId: 12, parent: null, message: userMessage("new root", "u12") });
    setHead(db, "sess-1", 12);
    const window = await trace.read(identity(), first.cursorTo, signal());
    expect(window.typedFailure).toMatchObject({ kind: "source_rewritten", detail: { reason: "not_ancestor" } });
  });

  it("fails source_malformed when a consumed node's body vanishes inside the read", async () => {
    const { dbPath } = seededStore(8);
    // Only loadMessage's `node_id = ? LIMIT 1` lookup is spoofed — every other
    // statement still runs on the real fixture database.
    const openDatabase = spoofingOpener(dbPath, new Map([["node_id = ? LIMIT 1", { get: () => undefined }]]));
    const window = await source(router({}, { dbPath, openDatabase })).read(identity(), undefined, signal());
    expect(window.typedFailure).toMatchObject({ kind: "source_malformed", detail: { node: 3, reason: "chain_incomplete" } });
  });

  it("mints a zero watermark when the aggregate row is absent", async () => {
    const { dbPath } = seededStore(8);
    const openDatabase = spoofingOpener(dbPath, new Map([["count(*) AS rows", { get: () => ({ rows: "x" }) }]]));
    const window = await source(router({}, { dbPath, openDatabase })).read(identity(), undefined, signal());
    expect(window.typedFailure).toBeUndefined();
    expect(window.events.map((event) => event.offset)).toEqual([1, 2, 3]);
    expect(window.cursorTo).toMatchObject({ position: { db: { node: 8, rows: 0, maxRow: 0 } } });
  });

  it("fails source_rewritten on a forged steps-0 store cursor", async () => {
    const { dbPath } = seededStore(null, []);
    // node -1 consumed nothing, so only the empty anchor can verify — a
    // minted-looking cursor with any other anchor is a rewrite.
    const prior: TraceCursor = {
      source: "devin-session",
      position: { session: "sess-1", steps: 0, anchor: "f".repeat(64), db: { v: 1, node: -1, rows: 0, maxRow: 0 } },
    };
    const window = await source(router({}, { dbPath })).read(identity(), prior, signal());
    expect(window.typedFailure).toMatchObject({ kind: "source_rewritten", detail: { reason: "anchor_mismatch" } });
  });

  it("re-verifies the consumed chain when the ancestry skeleton returns nothing", async () => {
    const { dbPath, db } = seededStore(8);
    const trace = source(router({}, { dbPath }));
    const first = await trace.read(identity(), undefined, signal());
    remintNodes(db, "sess-1");
    const openDatabase = spoofingOpener(dbPath, new Map([["node_id <= ? ORDER BY node_id", {}]]));
    const window = await source(router({}, { dbPath, openDatabase })).read(identity(), first.cursorTo, signal());
    expect(window.typedFailure).toMatchObject({ kind: "source_rewritten", detail: { reason: "anchor_mismatch" } });
  });

  it("falls back to the transcript reader when the store's exec channel fails", async () => {
    const handle: DevinSessionsDbHandle = {
      prepare: () => ({ get: () => undefined, all: () => [] }),
      exec: () => { throw new Error("exec channel dead"); },
      close: () => {},
    };
    const document = atifDoc("sess-1", [atifStep(1, { source: "user", message: "prompt" })]);
    const window = await source(router({ [pathOf("sess-1")]: document }, { dbPath: "x", openDatabase: () => handle })).read(identity(), undefined, signal());
    expect(window.typedFailure).toBeUndefined();
    expect(window.events.map((event) => event.kind)).toEqual(["user"]);
  });

  it("reports an aborted read when the signal fires mid-read", async () => {
    const { dbPath } = seededStore(8);
    const controller = new AbortController();
    const openDatabase: DevinSessionsDbOpener = (path, timeout) => {
      controller.abort();
      return new DatabaseSync(path, { readOnly: true, timeout });
    };
    const window = await source(router({}, { dbPath, openDatabase })).read(identity(), undefined, controller.signal);
    expect(window.typedFailure).toMatchObject({ kind: "aborted" });
  });

  it("treats a busy error inside the gate check as transient — never a transcript fallback", async () => {
    const { dbPath } = seededStore(8);
    const openDatabase: DevinSessionsDbOpener = (path, timeout) => {
      const inner = new DatabaseSync(path, { readOnly: true, timeout });
      return {
        prepare: (sql) => {
          if (/pragma|app_state/i.test(sql)) throw Object.assign(new Error("database is busy"), { errcode: 5 });
          return inner.prepare(sql);
        },
        exec: (sql) => inner.exec(sql),
        close: () => inner.close(),
      };
    };
    const document = atifDoc("sess-1", [atifStep(1, { source: "user", message: "prompt" })]);
    const window = await source(router({ [pathOf("sess-1")]: document }, { dbPath, openDatabase })).read(identity(), undefined, signal());
    expect(window.typedFailure).toMatchObject({ kind: "source_unreadable", detail: { code: "SQLITE_BUSY" } });
    expect(window.events).toEqual([]);
  });

  it("fails source_malformed when the new segment's parent dangles", async () => {
    const { dbPath, db } = seededStore(4, midTurnChain().slice(0, 5));
    addNode(db, "sess-1", { nodeId: 10, parent: 99, message: userMessage("orphaned", "u10") });
    setHead(db, "sess-1", 10);
    const window = await source(router({}, { dbPath })).read(identity(), undefined, signal());
    expect(window.typedFailure).toMatchObject({ kind: "source_malformed", detail: { reason: "chain_incomplete" } });
  });

  it("resolves the default store path under XDG_DATA_HOME and falls back when it is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-devin-xdg-"));
    dirs.push(dir);
    vi.stubEnv("XDG_DATA_HOME", dir);
    const window = await source(createDevinSessionReader({ sessionsDb: {} })).read(identity("sess-9"), undefined, signal());
    expect(window.typedFailure).toMatchObject({ kind: "source_unreadable" });
    expect(JSON.stringify(window.typedFailure)).not.toContain(dir);
  });
});
