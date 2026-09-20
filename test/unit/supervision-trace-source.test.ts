import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNodeFileReader,
  createTraceSource,
  selectTraceSource,
  TRACE_FALLBACK_CURSOR_MAX_BYTES,
  TRACE_FALLBACK_CURSOR_MAX_LINES,
  TRACE_SOURCE_KINDS,
  TRACE_WINDOW_MAX_BYTES,
  type DevinSessionRead,
  type TraceCursor,
  type TraceSourceIdentity,
} from "../../src/supervision/trace-source.js";

/**
 * Fixture discipline: canary strings stand in for path-bearing and
 * content-bearing secrets. Failures are asserted to carry no canary — a
 * typed failure must never smuggle a path or a record out in its detail.
 */
const CANARY_PATH = "/tmp/CANARY-SECRET-PATH/session.jsonl";
const CANARY_CONTENT = "CANARY-SECRET-CONTENT";

function identity(agentKind: string, agentSession?: { source: string; agent: string; kind: string; value: string }): TraceSourceIdentity {
  return {
    paneId: "w:p1",
    agentKind,
    ...(agentSession === undefined ? {} : { agentSession }),
  };
}

const piPath = (value = CANARY_PATH): TraceSourceIdentity => identity("pi", { source: "pi", agent: "pi", kind: "path", value });
const devinId = (value = "devin-session-1"): TraceSourceIdentity => identity("devin", { source: "devin", agent: "devin", kind: "id", value });

function jsonl(records: unknown[]): Uint8Array {
  return new TextEncoder().encode(records.map((record) => `${JSON.stringify(record)}\n`).join(""));
}

function files(map: Record<string, Uint8Array>) {
  return async (path: string, offset: number, maxBytes: number): Promise<Uint8Array> => {
    const data = map[path];
    if (data === undefined) throw Object.assign(new Error("no such file"), { code: "ENOENT" });
    return data.subarray(offset, offset + maxBytes);
  };
}

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("selectTraceSource", () => {
  const cases: Array<[string, TraceSourceIdentity, string]> = [
    ["pi with a path session", piPath(), "pi-jsonl"],
    ["pi whose record lacks a path still selects its structured source", identity("pi", { source: "pi", agent: "pi", kind: "id", value: "s1" }), "pi-jsonl"],
    ["devin keyed by session id", devinId(), "devin-session"],
    ["agy", identity("agy", { source: "agy", agent: "agy", kind: "id", value: "a1" }), "tmux-fallback"],
    ["provisional agy with no session", identity("agy"), "tmux-fallback"],
    ["claude with a path session (not a contract source)", identity("claude", { source: "claude", agent: "claude", kind: "path", value: "/x" }), "tmux-fallback"],
    ["an unknown runner", identity("codex"), "tmux-fallback"],
  ];
  it.each(cases)("%s → %s", (_name, target, source) => {
    expect(selectTraceSource(target)).toBe(source);
  });

  it("exposes the closed label set", () => {
    expect([...TRACE_SOURCE_KINDS]).toEqual(["pi-jsonl", "devin-session", "tmux-fallback"]);
  });
});

describe("pi-jsonl adapter", () => {
  const SESSION = jsonl([
    { type: "session", version: 1, id: "sess-1", timestamp: "t", cwd: "/w" },
    { type: "message", id: "m1", message: { role: "user", content: CANARY_CONTENT } },
    { type: "model_change", id: "m2", provider: "p", modelId: "m" },
  ]);

  it("reads a bounded structured window from byte 0", async () => {
    const source = createTraceSource({ readFileRange: files({ [CANARY_PATH]: SESSION }) });
    const window = await source.read(piPath(), undefined, new AbortController().signal);
    expect(window.typedFailure).toBeUndefined();
    expect(window.source).toBe("pi-jsonl");
    expect(window.cursorFrom).toBeUndefined();
    expect(window.events.map((event) => event.kind)).toEqual(["session", "message", "model_change"]);
    expect(window.events[0]!.offset).toBe(0);
    expect(window.events[1]!.offset).toBe(window.events[0]!.bytes);
    expect(window.byteCount).toBe(SESSION.length);
    expect(window.cursorTo).toMatchObject({ source: "pi-jsonl", offset: SESSION.length });
    expect((window.events[1]!.record as { message: { content: string } }).message.content).toBe(CANARY_CONTENT);
  });

  it("resumes incrementally from the prior cursor", async () => {
    const grown = jsonl([
      { type: "session", version: 1, id: "sess-1" },
      { type: "message", id: "m1", message: { role: "user" } },
    ]);
    const appended = jsonl([
      { type: "session", version: 1, id: "sess-1" },
      { type: "message", id: "m1", message: { role: "user" } },
      { type: "message", id: "m2", message: { role: "assistant" } },
      { type: "thinking_level_change", id: "m3", thinkingLevel: "high" },
    ]);
    const mutable: Record<string, Uint8Array> = { [CANARY_PATH]: grown };
    const source = createTraceSource({ readFileRange: files(mutable) });
    const first = await source.read(piPath(), undefined, new AbortController().signal);
    mutable[CANARY_PATH] = appended;
    const second = await source.read(piPath(), first.cursorTo, new AbortController().signal);
    expect(second.typedFailure).toBeUndefined();
    expect(second.cursorFrom).toEqual(first.cursorTo);
    expect(second.events.map((event) => event.kind)).toEqual(["message", "thinking_level_change"]);
    expect(second.events[0]!.offset).toBe(grown.length);
    expect(second.byteCount).toBe(appended.length - grown.length);
    expect(second.cursorTo).toMatchObject({ offset: appended.length });
  });

  it("keeps an empty read at an unchanged offset", async () => {
    const source = createTraceSource({ readFileRange: files({ [CANARY_PATH]: SESSION }) });
    const first = await source.read(piPath(), undefined, new AbortController().signal);
    const second = await source.read(piPath(), first.cursorTo, new AbortController().signal);
    expect(second.events).toEqual([]);
    expect(second.byteCount).toBe(0);
    expect(second.cursorTo).toEqual(first.cursorTo);
  });

  it("keeps an empty file at the initial offset", async () => {
    const source = createTraceSource({ readFileRange: files({ [CANARY_PATH]: new Uint8Array(0) }) });
    const window = await source.read(piPath(), undefined, new AbortController().signal);
    expect(window.typedFailure).toBeUndefined();
    expect(window.events).toEqual([]);
    expect(window.cursorTo).toEqual({ source: "pi-jsonl", offset: 0, anchor: "" });
  });

  it("bounds a window at the trace budget and resumes mid-file", async () => {
    const big = "x".repeat(TRACE_WINDOW_MAX_BYTES - 100);
    const records = [
      { type: "session", id: "s" },
      { type: "custom", id: "c1", data: big },
      { type: "message", id: "m", message: { role: "assistant" } },
    ];
    const data = jsonl(records);
    const source = createTraceSource({ readFileRange: files({ [CANARY_PATH]: data }) });
    const first = await source.read(piPath(), undefined, new AbortController().signal);
    expect(first.typedFailure).toBeUndefined();
    expect(first.byteCount).toBeLessThanOrEqual(TRACE_WINDOW_MAX_BYTES);
    // The session header and the big record fit; the message is deferred.
    expect(first.events.map((event) => event.kind)).toEqual(["session", "custom"]);
    const second = await source.read(piPath(), first.cursorTo, new AbortController().signal);
    expect(second.typedFailure).toBeUndefined();
    expect(second.events.map((event) => event.kind)).toEqual(["message"]);
    expect(second.byteCount + first.byteCount).toBe(data.length);
  });

  it("fails closed on a complete record that alone exceeds the budget", async () => {
    const data = jsonl([{ type: "custom", data: "x".repeat(TRACE_WINDOW_MAX_BYTES) }]);
    const source = createTraceSource({ readFileRange: files({ [CANARY_PATH]: data }) });
    const window = await source.read(piPath(), undefined, new AbortController().signal);
    expect(window.typedFailure).toMatchObject({ kind: "record_exceeds_budget" });
    expect(window.events).toEqual([]);
  });

  it("fails closed on an unterminated record wider than the window", async () => {
    const data = new TextEncoder().encode(`{"type":"custom","data":"${"x".repeat(TRACE_WINDOW_MAX_BYTES)}`); // no \n
    const source = createTraceSource({ readFileRange: files({ [CANARY_PATH]: data }) });
    const window = await source.read(piPath(), undefined, new AbortController().signal);
    expect(window.typedFailure).toMatchObject({ kind: "record_exceeds_budget" });
  });

  it("leaves an in-flight unterminated tail for the next read", async () => {
    const part1 = new TextEncoder().encode(`{"type":"session","id":"s"}\n{"type":"mes`);
    const part2 = jsonl([{ type: "session", id: "s" }, { type: "message", id: "m1" }]);
    const mutable: Record<string, Uint8Array> = { [CANARY_PATH]: part1 };
    const source = createTraceSource({ readFileRange: files(mutable) });
    const first = await source.read(piPath(), undefined, new AbortController().signal);
    expect(first.typedFailure).toBeUndefined();
    expect(first.events.map((event) => event.kind)).toEqual(["session"]);
    mutable[CANARY_PATH] = part2;
    const second = await source.read(piPath(), first.cursorTo, new AbortController().signal);
    expect(second.events.map((event) => event.kind)).toEqual(["message"]);
  });

  it("decodes multi-byte UTF-8 only at record boundaries", async () => {
    const line = `${JSON.stringify({ type: "message", id: "m", text: "héllo·wörld·日本語" })}\n`;
    const encoded = new TextEncoder().encode(line);
    // Split the file mid-codepoint with no terminator: a pending tail, not an error.
    const splitAt = encoded.length - 4;
    const mutable: Record<string, Uint8Array> = { [CANARY_PATH]: encoded.subarray(0, splitAt) };
    const source = createTraceSource({ readFileRange: files(mutable) });
    const pending = await source.read(piPath(), undefined, new AbortController().signal);
    expect(pending.typedFailure).toBeUndefined();
    expect(pending.events).toEqual([]);
    expect(pending.cursorTo).toMatchObject({ offset: 0 });
    mutable[CANARY_PATH] = encoded;
    const whole = await source.read(piPath(), pending.cursorTo, new AbortController().signal);
    expect(whole.typedFailure).toBeUndefined();
    expect((whole.events[0]!.record as { text: string }).text).toBe("héllo·wörld·日本語");
    expect(whole.events[0]!.bytes).toBe(encoded.length);
  });

  it.each([
    ["invalid JSON", new TextEncoder().encode(`{"type":"${CANARY_CONTENT}"` + "\n")],
    ["a scalar line", new TextEncoder().encode("5\n")],
    ["an array line", new TextEncoder().encode("[1]\n")],
    ["an object without a type", jsonl([{ id: "m1" }])],
    ["a non-string type", jsonl([{ type: 5 }])],
    ["an empty line", new TextEncoder().encode('{"type":"session","id":"s"}\n\n')],
    ["invalid UTF-8 in a record", new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x7d, 0x0a])],
  ])("fails closed on malformed input: %s", async (_name, data) => {
    const source = createTraceSource({ readFileRange: files({ [CANARY_PATH]: data }) });
    const window = await source.read(piPath(), undefined, new AbortController().signal);
    expect(window.typedFailure).toMatchObject({ kind: "source_malformed" });
    expect(window.events).toEqual([]);
    expect(window.cursorTo).toBeUndefined();
    expect(JSON.stringify(window.typedFailure)).not.toContain(CANARY_CONTENT);
    expect(JSON.stringify(window.typedFailure)).not.toContain(CANARY_PATH);
  });

  it("detects a file rewritten under a live cursor", async () => {
    const before = jsonl([{ type: "session", id: "s" }, { type: "message", id: "m1" }]);
    const after = jsonl([{ type: "session", id: "s" }, { type: "message", id: "ZZ" }]); // same length, different bytes
    const mutable: Record<string, Uint8Array> = { [CANARY_PATH]: before };
    const source = createTraceSource({ readFileRange: files(mutable) });
    const first = await source.read(piPath(), undefined, new AbortController().signal);
    mutable[CANARY_PATH] = after;
    const second = await source.read(piPath(), first.cursorTo, new AbortController().signal);
    expect(second.typedFailure).toMatchObject({ kind: "source_rewritten" });
    expect(second.cursorTo).toEqual(first.cursorTo);
  });

  it("detects a file truncated below the cursor", async () => {
    const long = jsonl([{ type: "session", id: "s" }, { type: "custom", data: "y".repeat(5000) }]);
    const mutable: Record<string, Uint8Array> = { [CANARY_PATH]: long };
    const source = createTraceSource({ readFileRange: files(mutable) });
    const first = await source.read(piPath(), undefined, new AbortController().signal);
    mutable[CANARY_PATH] = jsonl([{ type: "session", id: "s" }]);
    const second = await source.read(piPath(), first.cursorTo, new AbortController().signal);
    expect(second.typedFailure).toMatchObject({ kind: "source_rewritten" });
  });

  it("survives a cursor minted at offset 0", async () => {
    const source = createTraceSource({ readFileRange: files({ [CANARY_PATH]: SESSION }) });
    const cursor: TraceCursor = { source: "pi-jsonl", offset: 0, anchor: "ignored-at-zero" };
    const window = await source.read(piPath(), cursor, new AbortController().signal);
    expect(window.typedFailure).toBeUndefined();
    expect(window.events.length).toBe(3);
  });

  it.each([
    ["a fractional offset", { source: "pi-jsonl", offset: 1.5, anchor: "" }],
    ["a negative offset", { source: "pi-jsonl", offset: -1, anchor: "" }],
    ["a missing anchor", JSON.parse('{"source":"pi-jsonl","offset":5}') as TraceCursor],
    ["a non-hex anchor", { source: "pi-jsonl", offset: 5, anchor: "not-hex" }],
  ])("fails closed on a malformed cursor: %s", async (_name, cursor) => {
    const source = createTraceSource({ readFileRange: files({ [CANARY_PATH]: SESSION }) });
    const window = await source.read(piPath(), cursor as TraceCursor, new AbortController().signal);
    expect(window.typedFailure).toMatchObject({ kind: "cursor_malformed" });
    expect(window.cursorTo).toEqual(cursor);
  });

  it.each([
    ["no session record", identity("pi"), "session_absent"],
    ["a non-path session kind", identity("pi", { source: "pi", agent: "pi", kind: "id", value: "s1" }), "kind_not_path"],
    ["a relative path", piPath("relative/session.jsonl"), "path_not_absolute"],
  ])("fails closed when the session pointer is unusable: %s", async (_name, target, reason) => {
    const source = createTraceSource({ readFileRange: files({}) });
    const window = await source.read(target, undefined, new AbortController().signal);
    expect(window.source).toBe("pi-jsonl");
    expect(window.typedFailure).toMatchObject({ kind: "session_pointer_invalid", detail: { reason } });
  });

  it("reports an unreadable source with a code but never the path", async () => {
    const source = createTraceSource({ readFileRange: files({}) });
    const window = await source.read(piPath(), undefined, new AbortController().signal);
    expect(window.typedFailure).toMatchObject({ kind: "source_unreadable", detail: { code: "ENOENT" } });
    expect(JSON.stringify(window.typedFailure)).not.toContain(CANARY_PATH);
  });

  it("reports an unreadable source without a code-bearing error", async () => {
    const source = createTraceSource({
      readFileRange: async () => { throw new Error(`cannot read ${CANARY_PATH} ${CANARY_CONTENT}`); },
    });
    const window = await source.read(piPath(), undefined, new AbortController().signal);
    expect(window.typedFailure).toEqual({ kind: "source_unreadable" });
    expect(JSON.stringify(window.typedFailure)).not.toContain(CANARY_PATH);
    expect(JSON.stringify(window.typedFailure)).not.toContain(CANARY_CONTENT);
  });

  it("drops an error code that carries message text", async () => {
    const source = createTraceSource({
      readFileRange: async () => { throw Object.assign(new Error("x"), { code: `bad ${CANARY_PATH}` }); },
    });
    const window = await source.read(piPath(), undefined, new AbortController().signal);
    expect(window.typedFailure).toEqual({ kind: "source_unreadable" });
    expect(JSON.stringify(window.typedFailure)).not.toContain(CANARY_PATH);
  });

  it("reports a missing file reader as adapter_unavailable", async () => {
    const source = createTraceSource({});
    const window = await source.read(piPath(), undefined, new AbortController().signal);
    expect(window.typedFailure).toMatchObject({ kind: "adapter_unavailable" });
  });

  it("refuses a cursor minted by another source", async () => {
    const source = createTraceSource({ readFileRange: files({ [CANARY_PATH]: SESSION }) });
    const foreign: TraceCursor = { source: "tmux-fallback", window: ["line"] };
    const window = await source.read(piPath(), foreign, new AbortController().signal);
    expect(window.typedFailure).toMatchObject({ kind: "cursor_mismatch", detail: { cursorSource: "tmux-fallback" } });
  });

  it("reports an aborted read", async () => {
    const controller = new AbortController();
    const source = createTraceSource({
      readFileRange: async (path, offset, maxBytes) => {
        controller.abort();
        return SESSION.subarray(offset, offset + maxBytes);
      },
    });
    const window = await source.read(piPath(), undefined, controller.signal);
    expect(window.typedFailure).toMatchObject({ kind: "aborted" });
  });

  it("produces byte-identical output for identical input and cursor", async () => {
    const source = createTraceSource({ readFileRange: files({ [CANARY_PATH]: SESSION }) });
    const first = await source.read(piPath(), undefined, new AbortController().signal);
    const again = await source.read(piPath(), undefined, new AbortController().signal);
    expect(JSON.stringify(again)).toBe(JSON.stringify(first));
    const secondA = await source.read(piPath(), first.cursorTo, new AbortController().signal);
    const secondB = await source.read(piPath(), first.cursorTo, new AbortController().signal);
    expect(JSON.stringify(secondA)).toBe(JSON.stringify(secondB));
  });

  it("reads through the node file reader", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-trace-"));
    dirs.push(dir);
    const path = join(dir, "session.jsonl");
    await writeFile(path, SESSION);
    const source = createTraceSource({ readFileRange: createNodeFileReader() });
    const window = await source.read(piPath(path), undefined, new AbortController().signal);
    expect(window.typedFailure).toBeUndefined();
    expect(window.byteCount).toBe(SESSION.length);
    const missing = await source.read(piPath(join(dir, "gone.jsonl")), undefined, new AbortController().signal);
    expect(missing.typedFailure).toMatchObject({ kind: "source_unreadable", detail: { code: "ENOENT" } });
  });
});

describe("devin-session adapter", () => {
  it("selects the source and fails typed while the T2 reader is absent", async () => {
    const source = createTraceSource({});
    expect(source.select(devinId())).toBe("devin-session");
    const window = await source.read(devinId(), undefined, new AbortController().signal);
    expect(window.source).toBe("devin-session");
    expect(window.typedFailure).toMatchObject({ kind: "adapter_unavailable" });
    expect(window.events).toEqual([]);
  });

  it.each([
    ["no session record", identity("devin"), "session_absent"],
    ["a non-id session kind", identity("devin", { source: "devin", agent: "devin", kind: "path", value: "/x" }), "kind_not_id"],
  ])("fails closed when the session pointer is unusable: %s", async (_name, target, reason) => {
    const source = createTraceSource({});
    const window = await source.read(target, undefined, new AbortController().signal);
    expect(window.typedFailure).toMatchObject({ kind: "session_pointer_invalid", detail: { reason } });
  });

  it("routes an installed reader with the session id and opaque position", async () => {
    const seen: unknown[] = [];
    const read: DevinSessionRead = {
      position: { record: 42 },
      events: [
        { kind: "tool_call", offset: 0, bytes: 40, record: { name: "read" } },
        { kind: "observation", offset: 40, bytes: 60, record: { ok: true } },
      ],
    };
    const source = createTraceSource({
      devinSession: async (sessionId, position) => {
        seen.push(sessionId, position);
        return read;
      },
    });
    const prior: TraceCursor = { source: "devin-session", position: { record: 17 } };
    const window = await source.read(devinId("sess-9"), prior, new AbortController().signal);
    expect(seen).toEqual(["sess-9", { record: 17 }]);
    expect(window.typedFailure).toBeUndefined();
    expect(window.byteCount).toBe(100);
    expect(window.cursorTo).toEqual({ source: "devin-session", position: { record: 42 } });
    expect(window.cursorFrom).toEqual(prior);
    expect(window.events).toHaveLength(2);
  });

  it("passes an absent prior position through as undefined", async () => {
    const seen: unknown[] = [];
    const source = createTraceSource({
      devinSession: async (_sessionId, position) => {
        seen.push(position);
        return { position: { record: 0 }, events: [] };
      },
    });
    const window = await source.read(devinId(), undefined, new AbortController().signal);
    expect(seen).toEqual([undefined]);
    expect(window.typedFailure).toBeUndefined();
  });

  it.each([
    ["a code-bearing failure", Object.assign(new Error("io"), { code: "SESSION_GONE" }), { kind: "source_unreadable", detail: { code: "SESSION_GONE" } }],
    ["a plain failure", new Error(`cannot reach ${CANARY_PATH}`), { kind: "source_unreadable" }],
  ])("wraps a reader throw as %s", async (_name, thrown, expected) => {
    const source = createTraceSource({
      devinSession: async () => { throw thrown; },
    });
    const window = await source.read(devinId(), undefined, new AbortController().signal);
    expect(window.typedFailure).toEqual(expected);
    expect(JSON.stringify(window.typedFailure)).not.toContain(CANARY_PATH);
  });

  it.each([
    ["a non-object result", null],
    ["a non-array events field", { position: 0, events: 5 }],
    ["a non-record event", { position: 0, events: ["x"] }],
    ["an event without a kind", { position: 0, events: [{ offset: 0, bytes: 1, record: {} }] }],
    ["an event with a non-integer offset", { position: 0, events: [{ kind: "k", offset: 0.5, bytes: 1, record: {} }] }],
    ["an event with a negative offset", { position: 0, events: [{ kind: "k", offset: -1, bytes: 1, record: {} }] }],
    ["an event with non-integer bytes", { position: 0, events: [{ kind: "k", offset: 0, bytes: "n", record: {} }] }],
    ["an event with negative bytes", { position: 0, events: [{ kind: "k", offset: 0, bytes: -1, record: {} }] }],
    ["an event without a record", { position: 0, events: [{ kind: "k", offset: 0, bytes: 1 }] }],
  ])("fails closed on a malformed adapter window: %s", async (_name, result) => {
    const source = createTraceSource({ devinSession: async () => result as unknown as DevinSessionRead });
    const window = await source.read(devinId(), undefined, new AbortController().signal);
    expect(window.typedFailure).toMatchObject({ kind: "source_malformed" });
  });

  it("fails closed when the returned window exceeds the trace budget", async () => {
    const source = createTraceSource({
      devinSession: async () => ({
        position: { record: 1 },
        events: [{ kind: "tool_call", offset: 0, bytes: TRACE_WINDOW_MAX_BYTES + 1, record: {} }],
      }),
    });
    const window = await source.read(devinId(), undefined, new AbortController().signal);
    expect(window.typedFailure).toMatchObject({ kind: "window_exceeds_budget" });
    expect(window.events).toEqual([]);
  });

  it("reports an aborted devin read", async () => {
    const controller = new AbortController();
    const source = createTraceSource({
      devinSession: async () => {
        controller.abort();
        return { position: { record: 0 }, events: [] };
      },
    });
    const window = await source.read(devinId(), undefined, controller.signal);
    expect(window.typedFailure).toMatchObject({ kind: "aborted" });
  });
});

describe("tmux-fallback adapter", () => {
  const agy = identity("agy", { source: "agy", agent: "agy", kind: "id", value: "a1" });

  it("labels bounded terminal lines as tmux-fallback evidence", async () => {
    const source = createTraceSource({ readTerminal: async () => ["$ build", "ok", "done"] });
    const window = await source.read(agy, undefined, new AbortController().signal);
    expect(window.source).toBe("tmux-fallback");
    expect(window.typedFailure).toBeUndefined();
    expect(window.events.map((event) => event.kind)).toEqual(["terminal-line", "terminal-line", "terminal-line"]);
    expect(window.events.map((event) => event.record)).toEqual(["$ build", "ok", "done"]);
    expect(window.events.map((event) => event.offset)).toEqual([0, 1, 2]);
    expect(window.byteCount).toBe("$ build".length + 2 + 4);
    expect(window.cursorTo).toEqual({ source: "tmux-fallback", window: ["$ build", "ok", "done"] });
  });

  it("emits only the delta against the prior window", async () => {
    let lines = ["a", "b", "c"];
    const source = createTraceSource({ readTerminal: async () => lines });
    const first = await source.read(agy, undefined, new AbortController().signal);
    lines = ["a", "b", "c", "d", "e"];
    const second = await source.read(agy, first.cursorTo, new AbortController().signal);
    expect(second.events.map((event) => event.record)).toEqual(["d", "e"]);
    expect(second.events.map((event) => event.offset)).toEqual([0, 1]);
    // A quiet window emits nothing but still re-pins the cursor's window.
    const third = await source.read(agy, second.cursorTo, new AbortController().signal);
    expect(third.events).toEqual([]);
    expect(third.byteCount).toBe(0);
    expect(third.cursorTo).toEqual({ source: "tmux-fallback", window: lines });
  });

  it("keeps the newest lines when the delta exceeds the byte budget", async () => {
    const wide = "w".repeat(TRACE_WINDOW_MAX_BYTES - 10);
    const source = createTraceSource({ readTerminal: async () => [wide, "tail-1", "tail-2"] });
    const window = await source.read(agy, undefined, new AbortController().signal);
    expect(window.typedFailure).toBeUndefined();
    expect(window.byteCount).toBeLessThanOrEqual(TRACE_WINDOW_MAX_BYTES);
    expect(window.events.map((event) => event.record)).toEqual(["tail-1", "tail-2"]);
    // The leading offset gap marks the dropped older line.
    expect(window.events[0]!.offset).toBe(1);
  });

  it.each([
    ["too many UTF-16 code units", "x".repeat(TRACE_WINDOW_MAX_BYTES + 1)],
    ["too many UTF-8 bytes", "é".repeat(Math.floor(TRACE_WINDOW_MAX_BYTES / 2) + 1)],
  ])("fails typed and leaves the cursor unadvanced when one line has %s", async (_name, oversized) => {
    let lines = ["seed"];
    const source = createTraceSource({ readTerminal: async () => lines });
    const first = await source.read(agy, undefined, new AbortController().signal);
    lines = ["seed", oversized];
    const overflow = await source.read(agy, first.cursorTo, new AbortController().signal);
    expect(overflow.typedFailure).toMatchObject({ kind: "record_exceeds_budget", detail: { offset: 1 } });
    expect(overflow.events).toEqual([]);
    expect(overflow.cursorFrom).toEqual(first.cursorTo);
    expect(overflow.cursorTo).toEqual(first.cursorTo);
  });

  it.each([
    ["a non-array window", JSON.parse('{"source":"tmux-fallback","window":5}') as TraceCursor],
    ["a non-string line", { source: "tmux-fallback", window: ["ok", 5] } as unknown as TraceCursor],
    ["too many lines", { source: "tmux-fallback", window: Array(TRACE_FALLBACK_CURSOR_MAX_LINES + 1).fill("x") } as TraceCursor],
    ["an oversized line", { source: "tmux-fallback", window: ["é".repeat(Math.floor(TRACE_WINDOW_MAX_BYTES / 2) + 1)] } as TraceCursor],
    ["too many total bytes", { source: "tmux-fallback", window: Array(Math.floor(TRACE_FALLBACK_CURSOR_MAX_BYTES / 16_384) + 1).fill("x".repeat(16_384)) } as TraceCursor],
  ])("fails closed on a malformed cursor: %s", async (_name, cursor) => {
    const readTerminal = vi.fn(async () => ["x"]);
    const source = createTraceSource({ readTerminal });
    const window = await source.read(agy, cursor, new AbortController().signal);
    expect(window.typedFailure).toMatchObject({ kind: "cursor_malformed" });
    expect(window.cursorFrom).toBeUndefined();
    expect(window.cursorTo).toBeUndefined();
    expect(readTerminal).not.toHaveBeenCalled();
  });

  it("rejects a terminal window over the cursor line ceiling", async () => {
    const lines = Array(TRACE_FALLBACK_CURSOR_MAX_LINES + 1).fill("x");
    const source = createTraceSource({ readTerminal: async () => lines });
    const window = await source.read(agy, undefined, new AbortController().signal);
    expect(window.typedFailure).toMatchObject({ kind: "window_exceeds_budget", detail: { lines: lines.length } });
    expect(window.cursorTo).toBeUndefined();
  });

  it("rejects a terminal window whose bounded lines still exceed the cursor byte ceiling", async () => {
    const line = "x".repeat(16_384);
    const lines = Array(Math.floor(TRACE_FALLBACK_CURSOR_MAX_BYTES / Buffer.byteLength(line, "utf8")) + 1).fill(line);
    const source = createTraceSource({ readTerminal: async () => lines });
    const window = await source.read(agy, undefined, new AbortController().signal);
    expect(window.typedFailure).toMatchObject({ kind: "window_exceeds_budget", detail: { bytes: expect.any(Number) } });
    expect(window.cursorTo).toBeUndefined();
  });

  it("reports a missing terminal reader as adapter_unavailable", async () => {
    const source = createTraceSource({});
    const window = await source.read(agy, undefined, new AbortController().signal);
    expect(window.typedFailure).toMatchObject({ kind: "adapter_unavailable" });
  });

  it.each([
    ["a code-bearing failure", Object.assign(new Error("cli"), { code: "CLI_FAILED" }), { kind: "source_unreadable", detail: { code: "CLI_FAILED" } }],
    ["a plain failure", new Error(`cannot read ${CANARY_PATH}`), { kind: "source_unreadable" }],
  ])("wraps a reader throw as %s", async (_name, thrown, expected) => {
    const source = createTraceSource({ readTerminal: async () => { throw thrown; } });
    const window = await source.read(agy, undefined, new AbortController().signal);
    expect(window.typedFailure).toEqual(expected);
    expect(JSON.stringify(window.typedFailure)).not.toContain(CANARY_PATH);
  });

  it.each([
    ["a non-array window", { weird: true }],
    ["a window with non-string lines", ["ok", 7]],
  ])("fails closed on %s", async (_name, result) => {
    const source = createTraceSource({ readTerminal: async () => result as unknown as string[] });
    const window = await source.read(agy, undefined, new AbortController().signal);
    expect(window.typedFailure).toEqual({ kind: "source_unreadable", detail: { reason: "window_malformed" } });
  });

  it("reports an aborted terminal read", async () => {
    const controller = new AbortController();
    const source = createTraceSource({
      readTerminal: async () => {
        controller.abort();
        return ["x"];
      },
    });
    const window = await source.read(agy, undefined, controller.signal);
    expect(window.typedFailure).toMatchObject({ kind: "aborted" });
  });

  it("produces byte-identical output for identical input and cursor", async () => {
    const source = createTraceSource({ readTerminal: async () => ["a", "b"] });
    const first = await source.read(agy, undefined, new AbortController().signal);
    const again = await source.read(agy, undefined, new AbortController().signal);
    expect(JSON.stringify(again)).toBe(JSON.stringify(first));
  });
});
