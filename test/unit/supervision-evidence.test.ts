import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildEvidenceState,
  buildExecutionDigest,
  buildWorkspaceView,
  canonicalJson,
  createNodeWorkspaceRunner,
  DIGEST_ACTION_CLASSES,
  EVIDENCE_ASSIGNMENT_MAX_BYTES,
  EVIDENCE_CONTRACT_VERSION,
  EVIDENCE_IDENTITY_FIELDS,
  EVIDENCE_PATCH_MAX_BYTES,
  EVIDENCE_STATE_VERSION,
  EVIDENCE_TERMINAL_MAX_BYTES,
  EVIDENCE_TOTAL_MAX_BYTES,
  EVIDENCE_TRACE_MAX_BYTES,
  EXECUTION_DIGEST_VERSION,
  executionDigestBytes,
  executionDigestHash,
  scanEvidenceText,
  WORKSPACE_CHANGED_FILES_MAX,
  WORKSPACE_PATCH_FILES_MAX,
  WORKSPACE_VIEW_VERSION,
  type EvidenceBuild,
  type EvidenceIdentityInput,
  type EvidenceScanner,
  type EvidenceStateOk,
  type EvidenceStateRequest,
  type EvidenceVersionIdentity,
  type WorkspaceChangedFile,
  type WorkspaceCommandRunner,
  type WorkspacePatch,
  type WorkspaceView,
} from "../../src/supervision/evidence.js";
import { createDevinSessionReader } from "../../src/supervision/devin-trace.js";
import {
  createNodeFileReader,
  createTraceSource,
  type TraceCursor,
  type TraceEvent,
  type TraceSourceKind,
  type TraceWindow,
} from "../../src/supervision/trace-source.js";

/**
 * Fixture discipline matches the trace-source suites: canary strings stand in
 * for path-bearing and content-bearing secrets. The digest must carry bounded
 * call targets but never record content, message prose, or transcript lines.
 */
const CANARY_CONTENT = "CANARY-SECRET-CONTENT";

function win(source: TraceSourceKind, events: TraceEvent[], over: Partial<TraceWindow> = {}): TraceWindow {
  return {
    source,
    cursorFrom: undefined,
    cursorTo: undefined,
    events,
    byteCount: events.reduce((total, event) => total + event.bytes, 0),
    ...over,
  };
}

function piEvent(offset: number, record: unknown, kind = "message"): TraceEvent {
  return { kind, offset, bytes: 10, record };
}

/** A Pi assistant message carrying toolCall content items. */
function piCalls(offset: number, calls: Array<{ id?: unknown; name?: unknown; arguments?: unknown }>, messageTs?: unknown, recordTs?: string): TraceEvent {
  return piEvent(offset, {
    type: "message",
    ...(recordTs === undefined ? {} : { timestamp: recordTs }),
    message: {
      role: "assistant",
      ...(messageTs === undefined ? {} : { timestamp: messageTs }),
      content: calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments })),
    },
  });
}

/** A Pi toolResult message. */
function piResult(offset: number, fields: Record<string, unknown>, recordTs?: string): TraceEvent {
  return piEvent(offset, {
    type: "message",
    ...(recordTs === undefined ? {} : { timestamp: recordTs }),
    message: { role: "toolResult", ...fields },
  });
}

/** A Devin ATIF step; the event kind is the step's own `source`. */
function devinStep(stepId: number, fields: Record<string, unknown>): TraceEvent {
  const source = typeof fields.source === "string" ? fields.source : "agent";
  return { kind: source, offset: stepId, bytes: 10, record: { step_id: stepId, source, ...fields } };
}

function devinToolStep(
  stepId: number,
  calls: unknown[],
  results: unknown[] | undefined = [],
): TraceEvent {
  const step: Record<string, unknown> = { tool_calls: calls };
  if (results !== undefined) step.observation = { results };
  return devinStep(stepId, step);
}

function devinCall(id: string, name: string, args?: unknown): Record<string, unknown> {
  return { tool_call_id: id, function_name: name, ...(args === undefined ? {} : { arguments: args }) };
}

function devinResult(id: string, content: unknown): Record<string, unknown> {
  return { source_call_id: id, content };
}

const piCursor = (offset: number): TraceCursor => ({ source: "pi-jsonl", offset, anchor: "a".repeat(64) });
const devinCursor = (steps: number): TraceCursor => ({ source: "devin-session", position: { session: "s", steps, anchor: "b".repeat(64) } });
const tmuxCursor = (window: string[]): TraceCursor => ({ source: "tmux-fallback", window });

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("canonicalJson", () => {
  it("serializes with sorted keys at every depth and no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: { z: 0, y: "s" } } })).toBe('{"a":{"c":{"y":"s","z":0},"d":[2,1]},"b":1}');
  });

  it("drops undefined members and serializes non-JSON primitives deterministically", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson([undefined, 10n])).toBe('[null,"10"]');
  });
});

describe("buildExecutionDigest — envelope", () => {
  it("digests an empty window to an empty fixed-version envelope", () => {
    const digest = buildExecutionDigest(win("pi-jsonl", []));
    expect(digest).toEqual({
      version: EXECUTION_DIGEST_VERSION,
      source: "pi-jsonl",
      events: 0,
      bytes: 0,
      actions: [],
      other: [],
      incidental: {},
    });
    expect(DIGEST_ACTION_CLASSES).toEqual(["read", "search", "edit", "command"]);
  });

  it("carries a typed source failure verbatim", () => {
    const failure = { kind: "source_rewritten" as const, detail: { reason: "anchor_mismatch" } };
    const digest = buildExecutionDigest(win("devin-session", [], { typedFailure: failure }));
    expect(digest.failure).toEqual(failure);
    expect(digest.actions).toEqual([]);
  });

  it("references cursors by source, position hint, and hash — never raw payload", () => {
    const digest = buildExecutionDigest(
      win("pi-jsonl", [], { cursorFrom: piCursor(0), cursorTo: piCursor(4096) }),
    );
    expect(digest.cursorFrom).toMatchObject({ source: "pi-jsonl", position: 0, hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(digest.cursorTo).toMatchObject({ source: "pi-jsonl", position: 4096 });
    expect(digest.cursorTo!.hash).not.toBe(digest.cursorFrom!.hash);
  });

  it("keeps equal cursors equal and distinct positions distinct", () => {
    const a = buildExecutionDigest(win("devin-session", [], { cursorTo: devinCursor(7) }));
    const b = buildExecutionDigest(win("devin-session", [], { cursorTo: devinCursor(7) }));
    expect(a.cursorTo).toEqual(b.cursorTo);
    expect(a.cursorTo).toMatchObject({ position: 7 });
  });

  it.each([
    ["pi cursor with a fractional offset", { source: "pi-jsonl", offset: 1.5, anchor: "x" } as TraceCursor],
    ["devin cursor with a non-object position", { source: "devin-session", position: 5 } as TraceCursor],
    ["devin cursor with a non-integer steps", { source: "devin-session", position: { steps: "x" } } as TraceCursor],
    ["tmux cursor with a non-array window", { source: "tmux-fallback", window: "x" } as unknown as TraceCursor],
  ])("omits the position hint on a malformed cursor: %s", (_name, cursor) => {
    const digest = buildExecutionDigest(win(cursor.source, [], { cursorTo: cursor }));
    expect(digest.cursorTo!.position).toBeUndefined();
    expect(digest.cursorTo!.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("buildExecutionDigest — pi-jsonl", () => {
  it("classifies calls and pairs results by toolCallId", () => {
    const digest = buildExecutionDigest(
      win("pi-jsonl", [
        piCalls(0, [{ id: "c1", name: "read", arguments: { path: "/a" } }]),
        piCalls(10, [{ id: "c2", name: "bash", arguments: { command: "npm test" } }], 1000),
        piResult(20, { toolCallId: "c1", toolName: "read", content: [{ type: "text", text: CANARY_CONTENT }], isError: false, timestamp: 1100 }),
        piResult(30, { toolCallId: "c2", toolName: "bash", content: [{ type: "text", text: "ok\n\nCommand exited with code 0" }], isError: true, timestamp: 2000 }),
      ]),
    );
    expect(digest.actions).toEqual([
      { class: "read", tool: "read", target: "/a", count: 1, first: 0, last: 0 },
      { class: "command", tool: "bash", target: "npm test", count: 1, first: 10, last: 10, exitCode: 0, durationMs: 1000, error: true },
    ]);
    expect(JSON.stringify(digest)).not.toContain(CANARY_CONTENT);
  });

  it("parses a failure exit code only when the tool reported error", () => {
    const digest = buildExecutionDigest(
      win("pi-jsonl", [
        piResult(0, { toolCallId: "x", toolName: "bash", content: [{ type: "text", text: `out mentions Command exited with code 9 inside\n` }], isError: false }),
        piResult(10, { toolCallId: "y", toolName: "bash", content: [{ type: "text", text: "boom\n\nCommand exited with code 2" }], isError: true }),
      ]),
    );
    expect(digest.actions[0]).toMatchObject({ class: "command" });
    expect(digest.actions[0]!.target).toBeUndefined();
    expect(digest.actions[0]!.exitCode).toBeUndefined();
    expect(digest.actions[0]!.error).toBeUndefined();
    expect(digest.actions[1]).toMatchObject({ class: "command", exitCode: 2, error: true });
  });

  it("emits an orphan result as its own action so a boundary-split failure survives", () => {
    const digest = buildExecutionDigest(
      win("pi-jsonl", [piResult(50, { toolCallId: "gone", toolName: "bash", content: [{ type: "text", text: "Command exited with code 3" }], isError: true })]),
    );
    expect(digest.actions).toEqual([{ class: "command", tool: "bash", count: 1, first: 50, last: 50, exitCode: 3, error: true }]);
  });

  it("names an orphan result without toolName as unpaired_result", () => {
    const digest = buildExecutionDigest(win("pi-jsonl", [piResult(5, { toolCallId: 9, content: "x", isError: false })]));
    expect(digest.other).toEqual([{ tool: "unpaired_result", count: 1, first: 5, last: 5 }]);
  });

  it("consumes a pairing once; a second result for the same id is an orphan", () => {
    const digest = buildExecutionDigest(
      win("pi-jsonl", [
        piCalls(0, [{ id: "c1", name: "bash", arguments: { command: "x" } }]),
        piResult(10, { toolCallId: "c1", toolName: "bash", content: "done", isError: false }),
        piResult(20, { toolCallId: "c1", toolName: "bash", content: "again", isError: false }),
      ]),
    );
    expect(digest.actions).toHaveLength(2);
    expect(digest.actions[1]).toMatchObject({ first: 20 });
  });

  it("treats a toolResult with a non-string id as an orphan", () => {
    const digest = buildExecutionDigest(win("pi-jsonl", [piResult(3, { toolCallId: 42, toolName: "read", content: "x", isError: false })]));
    expect(digest.actions).toEqual([{ class: "read", tool: "read", count: 1, first: 3, last: 3 }]);
  });

  it("handles result content that is neither string nor text parts", () => {
    const digest = buildExecutionDigest(
      win("pi-jsonl", [
        piResult(0, { toolCallId: "x", toolName: "bash", content: 42, isError: true }),
        piResult(10, { toolCallId: "y", toolName: "bash", content: [{ type: "image", data: "…" }, { type: "text", text: "Command exited with code 7" }], isError: true }),
      ]),
    );
    expect(digest.actions[0]).toMatchObject({ class: "command", error: true });
    expect(digest.actions[0]!.exitCode).toBeUndefined();
    expect(digest.actions[1]).toMatchObject({ class: "command", exitCode: 7, error: true });
  });

  it("keeps an orphan result timestamp from inventing a duration", () => {
    const digest = buildExecutionDigest(
      win("pi-jsonl", [piResult(0, { toolCallId: "gone", toolName: "bash", content: "ok", isError: false, timestamp: 500 })]),
    );
    expect(digest.actions[0]!.durationMs).toBeUndefined();
  });

  it("bounds oversized tool names and event kinds", () => {
    const digest = buildExecutionDigest(
      win("pi-jsonl", [
        piCalls(0, [{ id: "a", name: "t".repeat(100), arguments: {} }]),
        piEvent(10, { type: "x".repeat(200) }, "k".repeat(200)),
      ]),
    );
    expect(digest.other[0]!.tool).toBe(`${"t".repeat(64)}…`);
    expect(digest.incidental).toEqual({ [`${"k".repeat(128)}…`]: 1 });
  });

  it("skips empty and all-unusable argument values before the next key", () => {
    const digest = buildExecutionDigest(
      win("devin-session", [
        devinToolStep(1, [devinCall("a", "exec", { command: "", pattern: "fallback" })], []),
        devinToolStep(2, [devinCall("b", "ctx_search", { queries: [1, {}] })], []),
      ]),
    );
    expect(digest.actions[0]!.target).toBe("fallback");
    expect(digest.actions[1]!.target).toBeUndefined();
  });

  it("counts non-tool messages as incidental by kind", () => {
    const digest = buildExecutionDigest(
      win("pi-jsonl", [
        piEvent(0, { type: "session", id: "s" }, "session"),
        piEvent(10, { type: "message", message: { role: "user", content: [{ type: "text", text: CANARY_CONTENT }] } }),
        piEvent(20, { type: "message", message: { role: "assistant", content: "plain text not an array" } }),
        piEvent(30, { type: "message", message: { role: "assistant", content: [{ type: "text", text: "only prose" }] } }),
        piEvent(40, { type: "message", message: "not-an-object" }),
        piEvent(50, "scalar-record", "message"),
        piEvent(60, { type: "custom", data: 1 }, "custom"),
      ]),
    );
    expect(digest.incidental).toEqual({ session: 1, message: 5, custom: 1 });
    expect(digest.actions).toEqual([]);
    expect(JSON.stringify(digest)).not.toContain(CANARY_CONTENT);
  });

  it("emits malformed call items as bounded other entries", () => {
    const digest = buildExecutionDigest(
      win("pi-jsonl", [piCalls(0, [{ id: "c1", name: 7, arguments: {} }, { name: "read", arguments: {} }])]),
    );
    expect(digest.other).toEqual([{ tool: "malformed_tool_call", count: 1, first: 0, last: 0 }]);
    expect(digest.actions).toEqual([{ class: "read", tool: "read", count: 1, first: 0, last: 0 }]);
  });

  it("falls back to the record timestamp when the message carries none", () => {
    const digest = buildExecutionDigest(
      win("pi-jsonl", [
        piCalls(0, [{ id: "c1", name: "bash", arguments: { command: "x" } }], undefined, "2026-01-01T00:00:00.000Z"),
        piResult(10, { toolCallId: "c1", toolName: "bash", content: "ok", isError: false }, "2026-01-01T00:00:02.500Z"),
      ]),
    );
    expect(digest.actions[0]).toMatchObject({ durationMs: 2500 });
  });

  it.each([
    ["a non-numeric message timestamp and a bad record timestamp", "not-a-date", "also-bad", undefined],
    ["a result timestamp older than the call", 5000, undefined, -1],
  ])("omits duration on %s", (_name, callTs, recordTs, resultTs) => {
    const digest = buildExecutionDigest(
      win("pi-jsonl", [
        piCalls(0, [{ id: "c1", name: "bash", arguments: { command: "x" } }], callTs, typeof recordTs === "string" ? recordTs : undefined),
        piResult(10, { toolCallId: "c1", toolName: "bash", content: "ok", isError: false, ...(typeof resultTs === "number" ? { timestamp: resultTs } : {}) }),
      ]),
    );
    expect(digest.actions[0]!.durationMs).toBeUndefined();
  });

  it("ignores a non-finite message timestamp", () => {
    const digest = buildExecutionDigest(
      win("pi-jsonl", [
        piCalls(0, [{ id: "c1", name: "bash", arguments: { command: "x" } }], Number.NaN),
        piResult(10, { toolCallId: "c1", toolName: "bash", content: "ok", isError: false, timestamp: 9 }),
      ]),
    );
    expect(digest.actions[0]!.durationMs).toBeUndefined();
  });
});

describe("buildExecutionDigest — devin-session", () => {
  it("classifies step tool calls and pairs observation results by source_call_id", () => {
    const digest = buildExecutionDigest(
      win("devin-session", [
        devinStep(1, { source: "system", message: CANARY_CONTENT }),
        devinToolStep(2, [devinCall("a", "exec", { command: "npm test" })], [devinResult("a", "output\n\nExit code: 1")]),
        devinToolStep(3, [devinCall("b", "edit", { file_path: "/src/x.ts" }), devinCall("c", "read", { file_path: "/src/y.ts" })], [
          devinResult("c", "contents"),
          devinResult("b", "applied"),
        ]),
      ]),
    );
    expect(digest.actions).toEqual([
      { class: "command", tool: "exec", target: "npm test", count: 1, first: 2, last: 2, exitCode: 1 },
      { class: "edit", tool: "edit", target: "/src/x.ts", count: 1, first: 3, last: 3 },
      { class: "read", tool: "read", target: "/src/y.ts", count: 1, first: 3, last: 3 },
    ]);
    expect(digest.incidental).toEqual({ system: 1 });
    expect(JSON.stringify(digest)).not.toContain(CANARY_CONTENT);
  });

  it("keeps calls pending when the step carries no observation", () => {
    const digest = buildExecutionDigest(win("devin-session", [devinToolStep(1, [devinCall("a", "exec", { command: "x" })], undefined)]));
    expect(digest.actions).toEqual([{ class: "command", tool: "exec", target: "x", count: 1, first: 1, last: 1 }]);
  });

  it("treats a malformed observation as no results", () => {
    for (const observation of [5, { results: "x" }]) {
      const digest = buildExecutionDigest(
        win("devin-session", [devinStep(1, { tool_calls: [devinCall("a", "read", { file_path: "/f" })], observation })]),
      );
      expect(digest.actions).toEqual([{ class: "read", tool: "read", target: "/f", count: 1, first: 1, last: 1 }]);
    }
  });

  it("marks malformed result entries and unpaired results as bounded other entries", () => {
    const digest = buildExecutionDigest(
      win("devin-session", [
        devinToolStep(1, [devinCall("a", "read", { file_path: "/f" })], [7, { content: "no id" }, devinResult("a", "ok"), devinResult("zz", "orphan")]),
      ]),
    );
    expect(digest.actions).toEqual([{ class: "read", tool: "read", target: "/f", count: 1, first: 1, last: 1 }]);
    expect(digest.other).toEqual([
      { tool: "malformed_tool_result", count: 2, first: 1, last: 1 },
      { tool: "unpaired_result", target: "zz", count: 1, first: 1, last: 1 },
    ]);
  });

  it("emits malformed call entries and leaves an unkeyed call pending", () => {
    const digest = buildExecutionDigest(
      win("devin-session", [
        devinStep(1, { tool_calls: [5, { function_name: 9 }, devinCall("a", "write", { file_path: "/w" }), { function_name: "read", arguments: { file_path: "/r" } }] }),
      ]),
    );
    expect(digest.actions.map((a) => a.class)).toEqual(["edit", "read"]);
    expect(digest.other).toEqual([{ tool: "malformed_tool_call", count: 2, first: 1, last: 1 }]);
  });

  it("parses the last exit marker in an exec result, not an echoed one", () => {
    const digest = buildExecutionDigest(
      win("devin-session", [
        devinToolStep(1, [devinCall("a", "exec", { command: "cat log" })], [devinResult("a", `printed Exit code: 9 earlier\n\nExit code: 0`)]),
      ]),
    );
    expect(digest.actions[0]).toMatchObject({ exitCode: 0 });
  });

  it("drops an out-of-range exit marker and a result with non-string content", () => {
    const digest = buildExecutionDigest(
      win("devin-session", [
        devinToolStep(1, [devinCall("a", "exec", { command: "x" }), devinCall("b", "exec", { command: "y" })], [
          devinResult("a", "Exit code: 99999999999999999999999"),
          devinResult("b", { structured: true }),
        ]),
      ]),
    );
    expect(digest.actions[0]!.exitCode).toBeUndefined();
    expect(digest.actions[1]!.exitCode).toBeUndefined();
  });

  it("counts non-agent and call-free agent steps as incidental", () => {
    const digest = buildExecutionDigest(
      win("devin-session", [
        devinStep(1, { source: "user", message: CANARY_CONTENT }),
        devinStep(2, { source: "agent", message: "thinking" }),
        devinStep(3, { source: "agent", tool_calls: [] }),
        devinStep(4, { source: "agent", tool_calls: "bad" }),
        { kind: "agent", offset: 5, bytes: 1, record: "not-an-object" },
      ]),
    );
    expect(digest.incidental).toEqual({ user: 1, agent: 4 });
    expect(JSON.stringify(digest)).not.toContain(CANARY_CONTENT);
  });
});

describe("buildExecutionDigest — tmux-fallback", () => {
  it("counts terminal lines as incidental and never embeds their content", () => {
    const cursor = tmuxCursor([`line ${CANARY_CONTENT}`, "plain"]);
    const digest = buildExecutionDigest(
      win("tmux-fallback", [
        { kind: "terminal-line", offset: 0, bytes: 5, record: CANARY_CONTENT },
        { kind: "terminal-line", offset: 1, bytes: 5, record: "second" },
      ], { cursorTo: cursor }),
    );
    expect(digest).toMatchObject({ actions: [], other: [], incidental: { "terminal-line": 2 } });
    expect(digest.droppedPrefix).toBeUndefined();
    expect(digest.cursorTo!.position).toBe(2);
    const bytes = new TextDecoder().decode(executionDigestBytes(digest));
    expect(bytes).not.toContain(CANARY_CONTENT);
    expect(bytes).not.toContain("plain");
  });

  it("carries the omitted fallback prefix count without carrying omitted content", () => {
    const digest = buildExecutionDigest(win("tmux-fallback", [
      { kind: "terminal-line", offset: 18, bytes: 4, record: "kept" },
      { kind: "terminal-line", offset: 19, bytes: 4, record: "tail" },
    ]));
    expect(digest).toMatchObject({ events: 2, droppedPrefix: 18, incidental: { "terminal-line": 2 } });
    expect(JSON.stringify(digest)).not.toContain("kept");
    expect(JSON.stringify(digest)).not.toContain("tail");
  });

  it("omits the prefix marker for an empty fallback window", () => {
    expect(buildExecutionDigest(win("tmux-fallback", [])).droppedPrefix).toBeUndefined();
  });
});

describe("compaction", () => {
  it("compacts a run of identical non-causal reads keeping first/last", () => {
    const events = [0, 1, 2, 3].map((i) => devinToolStep(i + 1, [devinCall(`c${i}`, "read", { file_path: "/f" })], [devinResult(`c${i}`, "ok")]));
    const digest = buildExecutionDigest(win("devin-session", events));
    expect(digest.actions).toEqual([{ class: "read", tool: "read", target: "/f", count: 4, first: 1, last: 4 }]);
  });

  it("merges identical clean commands and sums their durations", () => {
    const digest = buildExecutionDigest(
      win("pi-jsonl", [
        piCalls(0, [{ id: "a", name: "bash", arguments: { command: "make" } }], 0),
        piResult(10, { toolCallId: "a", toolName: "bash", content: "ok", isError: false, timestamp: 100 }),
        piCalls(20, [{ id: "b", name: "bash", arguments: { command: "make" } }], 200),
        piResult(30, { toolCallId: "b", toolName: "bash", content: "ok", isError: false, timestamp: 350 }),
      ]),
    );
    expect(digest.actions).toEqual([{ class: "command", tool: "bash", target: "make", count: 2, first: 0, last: 20, durationMs: 250 }]);
  });

  it("omits the merged duration when a member reports none", () => {
    const digest = buildExecutionDigest(
      win("pi-jsonl", [
        piCalls(0, [{ id: "a", name: "bash", arguments: { command: "make" } }]),
        piCalls(10, [{ id: "b", name: "bash", arguments: { command: "make" } }], 0),
        piResult(20, { toolCallId: "b", toolName: "bash", content: "ok", isError: false, timestamp: 50 }),
      ]),
    );
    expect(digest.actions).toEqual([{ class: "command", tool: "bash", target: "make", count: 2, first: 0, last: 10 }]);
  });

  it("preserves an edit → failing test → edit → passing test chain", () => {
    const digest = buildExecutionDigest(
      win("devin-session", [
        devinToolStep(1, [devinCall("e1", "edit", { file_path: "/src/a.ts" })], [devinResult("e1", "ok")]),
        devinToolStep(2, [devinCall("t1", "exec", { command: "npm test" })], [devinResult("t1", "failures\n\nExit code: 1")]),
        devinToolStep(3, [devinCall("e2", "edit", { file_path: "/src/a.ts" })], [devinResult("e2", "ok")]),
        devinToolStep(4, [devinCall("t2", "exec", { command: "npm test" })], [devinResult("t2", "pass\n\nExit code: 0")]),
      ]),
    );
    expect(digest.actions.map((a) => `${a.class}:${a.exitCode ?? "-"}`)).toEqual(["edit:-", "command:1", "edit:-", "command:0"]);
  });

  it("never merges writes, errors, or non-zero exits", () => {
    const digest = buildExecutionDigest(
      win("devin-session", [
        devinToolStep(1, [devinCall("a", "write", { file_path: "/f" }), devinCall("b", "write", { file_path: "/f" })], [
          devinResult("a", "ok"),
          devinResult("b", "ok"),
        ]),
        devinToolStep(2, [devinCall("c", "exec", { command: "t" }), devinCall("d", "exec", { command: "t" })], [
          devinResult("c", "Exit code: 1"),
          devinResult("d", "Exit code: 1"),
        ]),
      ]),
    );
    expect(digest.actions.map((a) => [a.class, a.count])).toEqual([
      ["edit", 1],
      ["edit", 1],
      ["command", 1],
      ["command", 1],
    ]);
  });

  it("breaks a merge across a differing signature and across a causal boundary", () => {
    const digest = buildExecutionDigest(
      win("pi-jsonl", [
        piCalls(0, [{ id: "a", name: "bash", arguments: { command: "x" } }]),
        piResult(1, { toolCallId: "a", toolName: "bash", content: "Command exited with code 4", isError: true }),
        piCalls(2, [{ id: "b", name: "bash", arguments: { command: "x" } }]),
        piResult(3, { toolCallId: "b", toolName: "bash", content: "ok", isError: false }),
        piCalls(4, [{ id: "c", name: "bash", arguments: { command: "y" } }]),
        piCalls(6, [{ id: "d", name: "read", arguments: { path: "/p" } }]),
        piCalls(8, [{ id: "e", name: "read", arguments: { path: "/q" } }]),
      ]),
    );
    expect(digest.actions.map((a) => [a.target, a.count])).toEqual([
      ["x", 1],
      ["x", 1],
      ["y", 1],
      ["/p", 1],
      ["/q", 1],
    ]);
    expect(digest.actions[0]).toMatchObject({ exitCode: 4, error: true });
  });

  it("does not compact classified calls across an unclassified failure", () => {
    const digest = buildExecutionDigest(
      win("pi-jsonl", [
        piCalls(0, [{ id: "a", name: "read", arguments: { path: "/f" } }]),
        piCalls(1, [{ id: "x", name: "unknown_tool", arguments: { query: "middle" } }]),
        piResult(2, { toolCallId: "x", toolName: "unknown_tool", content: "failed", isError: true }),
        piCalls(3, [{ id: "b", name: "read", arguments: { path: "/f" } }]),
      ]),
    );
    expect(digest.actions).toEqual([
      { class: "read", tool: "read", target: "/f", count: 1, first: 0, last: 0 },
      { class: "read", tool: "read", target: "/f", count: 1, first: 3, last: 3 },
    ]);
    expect(digest.other).toEqual([
      { tool: "unknown_tool", target: "middle", count: 1, first: 1, last: 1, error: true },
    ]);
  });

  it("compacts unclassified tools but keeps their errors distinct", () => {
    const digest = buildExecutionDigest(
      win("pi-jsonl", [
        piCalls(0, [{ id: "a", name: "skill", arguments: { skill: "herdr" } }]),
        piCalls(1, [{ id: "b", name: "skill", arguments: { skill: "herdr" } }]),
        piCalls(2, [{ id: "c", name: "skill", arguments: { skill: "herdr" } }]),
        piResult(3, { toolCallId: "c", toolName: "skill", content: "failed", isError: true }),
      ]),
    );
    expect(digest.other).toEqual([
      { tool: "skill", target: "herdr", count: 2, first: 0, last: 1 },
      { tool: "skill", target: "herdr", count: 1, first: 2, last: 2, error: true },
    ]);
  });
});

describe("targets and classification", () => {
  it.each([
    ["read", "read"],
    ["webfetch", "read"],
    ["grep", "search"],
    ["find_file_by_name", "search"],
    ["ctx_search", "search"],
    ["web_search", "search"],
    ["ls", "search"],
    ["write", "edit"],
    ["notebook_edit", "edit"],
    ["exec", "command"],
    ["ctx_batch_execute", "command"],
    ["write_to_process", "command"],
    ["EXEC", "command"],
  ])("classifies %s as %s", (tool, cls) => {
    const digest = buildExecutionDigest(win("devin-session", [devinToolStep(1, [devinCall("a", tool, {})], [])]));
    expect(digest.actions[0]!.class).toBe(cls);
  });

  it("prefers the command target key and bounds long targets", () => {
    const long = "x".repeat(300);
    const digest = buildExecutionDigest(
      win("devin-session", [
        devinToolStep(1, [devinCall("a", "exec", { command: long, file_path: "/f", pattern: "p" })], []),
      ]),
    );
    expect(digest.actions[0]!.target).toBe(`${"x".repeat(160)}…`);
  });

  it("joins array-valued targets and reads object elements", () => {
    const digest = buildExecutionDigest(
      win("devin-session", [
        devinToolStep(1, [devinCall("a", "ctx_batch_execute", { commands: [{ label: "l", command: "go test" }, { command: "go vet" }, 5] })], []),
        devinToolStep(2, [devinCall("b", "ctx_search", { queries: ["one", "two"] })], []),
      ]),
    );
    expect(digest.actions[0]!.target).toBe("go test; go vet");
    expect(digest.actions[1]!.target).toBe("one; two");
  });

  it("composes an MCP server:tool target and omits unidentifiable ones", () => {
    const digest = buildExecutionDigest(
      win("devin-session", [
        devinToolStep(1, [devinCall("a", "mcp_call_tool", { server_name: "github", tool_name: "push", arguments: {} })], []),
        devinToolStep(2, [devinCall("b", "mcp_call_tool", { server_name: "github" })], []),
        devinToolStep(3, [devinCall("c", "todo_write", { todos: [1] })], []),
        devinToolStep(4, [devinCall("d", "read", "not-an-object")], []),
      ]),
    );
    expect(digest.other[0]!.target).toBe("github:push");
    expect(digest.other[1]!.target).toBeUndefined();
    expect(digest.other[2]!.target).toBeUndefined();
    expect(digest.actions[0]!.target).toBeUndefined();
  });
});

describe("determinism and content hygiene", () => {
  const FIXTURE = win("devin-session", [
    devinStep(1, { source: "user", message: CANARY_CONTENT }),
    devinToolStep(2, [devinCall("a", "exec", { command: "npm test" }), devinCall("b", "read", { file_path: "/f" })], [
      devinResult("a", `output ${CANARY_CONTENT}\n\nExit code: 1`),
      devinResult("b", "x"),
    ]),
  ], { cursorFrom: devinCursor(0), cursorTo: devinCursor(2) });

  it("produces byte-identical canonical output for identical events", () => {
    const a = buildExecutionDigest(FIXTURE);
    const b = buildExecutionDigest(FIXTURE);
    expect(executionDigestBytes(a)).toEqual(executionDigestBytes(b));
    expect(executionDigestHash(a)).toBe(executionDigestHash(b));
    expect(executionDigestHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes the hash when the window changes", () => {
    const changed = win("devin-session", [...FIXTURE.events, devinStep(3, { source: "agent", message: "more" })], {
      cursorFrom: devinCursor(0),
      cursorTo: devinCursor(3),
    });
    expect(executionDigestHash(buildExecutionDigest(changed))).not.toBe(executionDigestHash(buildExecutionDigest(FIXTURE)));
  });

  it("carries no raw record content, message text, or transcript", () => {
    const serialized = new TextDecoder().decode(executionDigestBytes(buildExecutionDigest(FIXTURE)));
    expect(serialized).not.toContain(CANARY_CONTENT);
    expect(serialized).not.toContain("output");
  });
});

describe("through the real readers", () => {
  it("digests a devin window produced by the T2 reader", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-e1-"));
    dirs.push(dir);
    const document = {
      schema_version: "ATIF-v1.7",
      session_id: "sess-1",
      steps: [
        { step_id: 1, source: "user", message: "do it" },
        {
          step_id: 2,
          source: "agent",
          tool_calls: [{ tool_call_id: "c", function_name: "exec", arguments: { command: "npm test" } }],
          observation: { results: [{ source_call_id: "c", content: "fails\n\nExit code: 1" }] },
        },
        {
          step_id: 3,
          source: "agent",
          tool_calls: [{ tool_call_id: "w", function_name: "edit", arguments: { file_path: "/src/x.ts" } }],
          observation: { results: [{ source_call_id: "w", content: "ok" }] },
        },
        {
          step_id: 4,
          source: "agent",
          tool_calls: [{ tool_call_id: "p", function_name: "exec", arguments: { command: "npm test" } }],
          observation: { results: [{ source_call_id: "p", content: "pass\n\nExit code: 0" }] },
        },
      ],
    };
    await writeFile(join(dir, "sess-1.json"), JSON.stringify(document));
    const source = createTraceSource({ devinSession: createDevinSessionReader({ transcriptsDir: dir }) });
    const window = await source.read(
      { paneId: "w:p1", agentKind: "devin", agentSession: { source: "devin", agent: "devin", kind: "id", value: "sess-1" } },
      undefined,
      new AbortController().signal,
    );
    const digest = buildExecutionDigest(window);
    expect(digest.actions.map((a) => `${a.class}:${a.exitCode ?? "-"}`)).toEqual(["command:1", "edit:-", "command:0"]);
    expect(digest.cursorTo).toMatchObject({ source: "devin-session", position: 4 });
  });

  it("digests a pi window produced by the T1 reader", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-e1-pi-"));
    dirs.push(dir);
    const records = [
      { type: "session", id: "s" },
      {
        type: "message",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "assistant", timestamp: 1000, content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } }] },
      },
      {
        type: "message",
        message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "fails\n\nCommand exited with code 1" }], isError: true, timestamp: 1800 },
      },
    ];
    const path = join(dir, "session.jsonl");
    await writeFile(path, records.map((r) => `${JSON.stringify(r)}\n`).join(""));
    const source = createTraceSource({ readFileRange: createNodeFileReader() });
    const window = await source.read(
      { paneId: "w:p1", agentKind: "pi", agentSession: { source: "pi", agent: "pi", kind: "path", value: path } },
      undefined,
      new AbortController().signal,
    );
    const digest = buildExecutionDigest(window);
    expect(digest.actions).toEqual([
      { class: "command", tool: "bash", target: "npm test", count: 1, first: digest.actions[0]!.first, last: digest.actions[0]!.first, exitCode: 1, durationMs: 800, error: true },
    ]);
    expect(digest.incidental).toEqual({ session: 1 });
  });
});

/* ------------------------------------------------------------------ */
/* E2 — the per-cadence read-only workspace view.                       */
/*                                                                     */
/* The command seam is injected fake-git keyed on the exact argv tail;   */
/* an unscripted command exits 128 so a surprise invocation is a visible */
/* failure, not silent output. Every call's cwd is recorded — the        */
/* builder must only ever see the trusted launch root, never the        */
/* supervisor's own process cwd.                                        */
/* ------------------------------------------------------------------ */

const WS_ROOT = "/child/workspace";
const WS_HEAD = "a".repeat(40);
const WS_BASE = "b".repeat(40);
const WS_HEAD_2 = "c".repeat(40);

const GIT_HEAD = "rev-parse --verify HEAD";
const GIT_STATUS = "status --porcelain=v1 -z --untracked-files=normal";
const gitNameStatus = (base: string) => `diff -M --name-status -z ${base} --`;
const gitNumstat = (base: string) => `diff -M --numstat -z ${base} --`;
const gitPatch = (base: string, path: string) => `diff --no-ext-diff --no-color --unified=3 ${base} -- :(literal)${path}`;
const gitUntrackedPatch = (path: string) => `diff --no-index --no-ext-diff --no-color --unified=3 -- /dev/null ./${path}`;

interface WorkspaceCall {
  argv: string[];
  cwd: string;
}

type GitResponse = string | { stdout: string; exitCode: number } | Error;

/** The four read-only commands a view is allowed to run, and nothing else. */
function cleanWorkspace(head = WS_HEAD): Record<string, GitResponse> {
  return {
    [GIT_HEAD]: `${head}\n`,
    [GIT_STATUS]: "",
    [gitNameStatus(head)]: "",
    [gitNumstat(head)]: "",
  };
}

function fakeGit(responses: Record<string, GitResponse>, calls: WorkspaceCall[], hook?: (argv: readonly string[]) => void): WorkspaceCommandRunner {
  return async (argv, cwd) => {
    calls.push({ argv: [...argv], cwd });
    hook?.(argv);
    const scripted = responses[argv.slice(1).join(" ")];
    if (scripted === undefined) return { stdout: "", exitCode: 128 };
    if (scripted instanceof Error) throw scripted;
    return typeof scripted === "string" ? { stdout: scripted, exitCode: 0 } : scripted;
  };
}

function git(
  responses: Record<string, GitResponse>,
  hook?: (argv: readonly string[]) => void,
): { run: WorkspaceCommandRunner; calls: WorkspaceCall[] } {
  const calls: WorkspaceCall[] = [];
  return { run: fakeGit(responses, calls, hook), calls };
}

const okView = { version: WORKSPACE_VIEW_VERSION, available: true };

describe("buildWorkspaceView — evidence", () => {
  it("captures HEAD as the base on the first build and reports a clean workspace", async () => {
    const { run, calls } = git(cleanWorkspace());
    const view = await buildWorkspaceView({ root: WS_ROOT }, { run }, new AbortController().signal);
    expect(view).toEqual({
      ...okView,
      baseRevision: WS_HEAD,
      headRevision: WS_HEAD,
      dirty: false,
      changedFiles: [],
      omittedFiles: 0,
      stats: { filesChanged: 0, insertions: 0, deletions: 0, untrackedFiles: 0 },
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      patch: { hunks: [], omittedHunks: 0, omittedFiles: 0 },
    });
    // Every command ran at the trusted root — never at this process's cwd.
    expect(WS_ROOT).not.toBe(process.cwd());
    expect(calls.map((call) => call.cwd)).toEqual([WS_ROOT, WS_ROOT, WS_ROOT, WS_ROOT]);
    // The exact command set: metadata only, so no patch text can ever exist.
    expect(calls.map((call) => call.argv)).toEqual([
      ["git", "rev-parse", "--verify", "HEAD"],
      ["git", "status", "--porcelain=v1", "-z", "--untracked-files=normal"],
      ["git", "diff", "-M", "--name-status", "-z", WS_HEAD, "--"],
      ["git", "diff", "-M", "--numstat", "-z", WS_HEAD, "--"],
    ]);
  });

  it("reports head movement and the full delta against the reservation's pinned base", async () => {
    const { run } = git({
      [GIT_HEAD]: `${WS_HEAD_2}\n`,
      [GIT_STATUS]: " M src/a.ts\x00",
      [gitNameStatus(WS_BASE)]: "M\x00src/a.ts\x00A\x00src/new.ts\x00",
      [gitNumstat(WS_BASE)]: "5\t2\tsrc/a.ts\x007\t0\tsrc/new.ts\x00",
    });
    const view = await buildWorkspaceView({ root: WS_ROOT, baseRevision: WS_BASE }, { run }, new AbortController().signal);
    expect(view).toMatchObject({
      ...okView,
      baseRevision: WS_BASE,
      headRevision: WS_HEAD_2,
      dirty: true,
      changedFiles: [
        { path: "src/a.ts", status: "modified", added: 5, deleted: 2 },
        { path: "src/new.ts", status: "added", added: 7, deleted: 0 },
      ],
      stats: { filesChanged: 2, insertions: 12, deletions: 2, untrackedFiles: 0 },
    });
  });

  it("reports deleted, modified, binary, and untracked entries with their stats", async () => {
    const { run } = git({
      [GIT_HEAD]: `${WS_HEAD}\n`,
      [GIT_STATUS]: " M m.ts\x00 D d.ts\x00?? fresh.txt\x00",
      [gitNameStatus(WS_HEAD)]: "M\x00m.ts\x00D\x00d.ts\x00M\x00bin.dat\x00",
      [gitNumstat(WS_HEAD)]: "1\t2\tm.ts\x000\t9\td.ts\x00-\t-\tbin.dat\x00",
    });
    const view = await buildWorkspaceView({ root: WS_ROOT }, { run }, new AbortController().signal);
    expect(view).toMatchObject({
      ...okView,
      dirty: true,
      changedFiles: [
        { path: "bin.dat", status: "modified" }, // binary: no line counts
        { path: "d.ts", status: "deleted", added: 0, deleted: 9 },
        { path: "fresh.txt", status: "untracked" },
        { path: "m.ts", status: "modified", added: 1, deleted: 2 },
      ],
      stats: { filesChanged: 3, insertions: 1, deletions: 11, untrackedFiles: 1 },
    });
    expect(JSON.stringify(view)).not.toContain("@@");
  });

  it("reports renames, copies, typechanges, and conflicts; numstat merges by new path", async () => {
    const { run } = git({
      [GIT_HEAD]: `${WS_HEAD}\n`,
      [GIT_STATUS]: "R  renamed.ts\x00old.ts\x00UU conflict.ts\x00",
      [gitNameStatus(WS_HEAD)]: "R050\x00old.ts\x00renamed.ts\x00C\x00src.ts\x00copy.ts\x00T\x00link\x00U\x00conflict.ts\x00",
      [gitNumstat(WS_HEAD)]: "3\t1\t\x00old.ts\x00renamed.ts\x000\t0\t\x00src.ts\x00copy.ts\x000\t0\tlink\x00-\t-\tconflict.ts\x00",
    });
    const view = await buildWorkspaceView({ root: WS_ROOT }, { run }, new AbortController().signal);
    expect(view).toMatchObject({
      ...okView,
      dirty: true,
      changedFiles: [
        { path: "conflict.ts", status: "conflicted" },
        { path: "copy.ts", status: "copied", from: "src.ts", added: 0, deleted: 0 },
        { path: "link", status: "typechanged", added: 0, deleted: 0 },
        { path: "renamed.ts", status: "renamed", from: "old.ts", added: 3, deleted: 1 },
      ],
      stats: { filesChanged: 4, insertions: 3, deletions: 1, untrackedFiles: 0 },
    });
  });

  it("keeps a name-status entry whose numstat raced away, honestly omitting its counts", async () => {
    const { run } = git({
      [GIT_HEAD]: `${WS_HEAD}\n`,
      [GIT_STATUS]: " M m.ts\x00",
      [gitNameStatus(WS_HEAD)]: "M\x00m.ts\x00D\x00gone.ts\x00",
      [gitNumstat(WS_HEAD)]: "4\t1\tm.ts\x00", // gone.ts changed between the two reads
    });
    const view = await buildWorkspaceView({ root: WS_ROOT }, { run }, new AbortController().signal);
    expect(view).toMatchObject({
      changedFiles: [
        { path: "gone.ts", status: "deleted" },
        { path: "m.ts", status: "modified", added: 4, deleted: 1 },
      ],
      stats: { filesChanged: 2, insertions: 4, deletions: 1, untrackedFiles: 0 },
    });
  });

  it("drops an untracked path that raced into the index rather than reporting it twice", async () => {
    const { run } = git({
      [GIT_HEAD]: `${WS_HEAD}\n`,
      [GIT_STATUS]: "?? staged-between-reads.ts\x00",
      [gitNameStatus(WS_HEAD)]: "A\x00staged-between-reads.ts\x00",
      [gitNumstat(WS_HEAD)]: "3\t0\tstaged-between-reads.ts\x00",
    });
    const view = await buildWorkspaceView({ root: WS_ROOT }, { run }, new AbortController().signal);
    expect(view).toMatchObject({
      changedFiles: [{ path: "staged-between-reads.ts", status: "added", added: 3, deleted: 0 }],
      stats: { filesChanged: 1, insertions: 3, deletions: 0, untrackedFiles: 0 },
    });
  });

  it("skips an ignored entry a hostile runner emits and stays honest", async () => {
    const { run } = git({
      [GIT_HEAD]: `${WS_HEAD}\n`,
      [GIT_STATUS]: "!! build/\x00",
      [gitNameStatus(WS_HEAD)]: "",
      [gitNumstat(WS_HEAD)]: "",
    });
    const view = await buildWorkspaceView({ root: WS_ROOT }, { run }, new AbortController().signal);
    expect(view).toMatchObject({ ...okView, dirty: false, changedFiles: [], stats: { untrackedFiles: 0 } });
  });

  it("orders even a repeated path the comparator cannot see from real git", async () => {
    // Real name-status never repeats a path, but a hostile runner can; the sort must stay total.
    const { run } = git({
      [GIT_HEAD]: `${WS_HEAD}\n`,
      [GIT_STATUS]: "",
      [gitNameStatus(WS_HEAD)]: "M\x00b.ts\x00M\x00a.ts\x00M\x00a.ts\x00",
      [gitNumstat(WS_HEAD)]: "1\t0\tb.ts\x003\t0\ta.ts\x00",
    });
    const view = await buildWorkspaceView({ root: WS_ROOT }, { run }, new AbortController().signal);
    expect(view).toMatchObject({
      changedFiles: [
        { path: "a.ts", status: "modified", added: 3, deleted: 0 },
        { path: "a.ts", status: "modified", added: 3, deleted: 0 },
        { path: "b.ts", status: "modified", added: 1, deleted: 0 },
      ],
    });
  });
});

describe("buildWorkspaceView — recent hunks", () => {
  it("reads whole hunks only for changed files named by this cadence's writes", async () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,2 @@ function a()",
      " keep",
      "-old",
      "+new",
      "@@ -10 +10 @@",
      "-before",
      "+after",
      "",
    ].join("\n");
    const { run, calls } = git({
      [GIT_HEAD]: `${WS_HEAD}\n`,
      [GIT_STATUS]: " M src/a.ts\x00 M src/b.ts\x00",
      [gitNameStatus(WS_HEAD)]: "M\x00src/a.ts\x00M\x00src/b.ts\x00",
      [gitNumstat(WS_HEAD)]: "2\t2\tsrc/a.ts\x001\t1\tsrc/b.ts\x00",
      [gitPatch(WS_HEAD, "src/a.ts")]: patch,
    });
    const view = await buildWorkspaceView({
      root: WS_ROOT,
      writtenFiles: [42 as unknown as string, "", "bad\npath", WS_ROOT, "/outside/b.ts", "missing.ts", `${WS_ROOT}/src/a.ts`, "src/a.ts"],
    }, { run }, new AbortController().signal);
    if (!view.available) throw new Error("unreachable");
    expect(view.patch).toEqual({
      hunks: [
        { path: "src/a.ts", header: "@@ -1,2 +1,2 @@ function a()", lines: [" keep", "-old", "+new"] },
        { path: "src/a.ts", header: "@@ -10 +10 @@", lines: ["-before", "+after"] },
      ],
      omittedHunks: 0,
      omittedFiles: 0,
    });
    expect(calls.at(-1)!.argv).toEqual([
      "git", "diff", "--no-ext-diff", "--no-color", "--unified=3", WS_HEAD, "--", ":(literal)src/a.ts",
    ]);
    expect(calls.some((call) => call.argv.includes(":(literal)src/b.ts"))).toBe(false);
  });

  it("orders selected files deterministically and emits an empty patch when git has no hunks", async () => {
    const { run, calls } = git({
      [GIT_HEAD]: `${WS_HEAD}\n`,
      [GIT_STATUS]: " M a.ts\x00 M b.ts\x00",
      [gitNameStatus(WS_HEAD)]: "M\x00a.ts\x00M\x00b.ts\x00",
      [gitNumstat(WS_HEAD)]: "1\t1\ta.ts\x001\t1\tb.ts\x00",
      [gitPatch(WS_HEAD, "a.ts")]: "",
      [gitPatch(WS_HEAD, "b.ts")]: "",
    });
    const view = await buildWorkspaceView({ root: WS_ROOT, writtenFiles: ["b.ts", "a.ts"] }, { run }, new AbortController().signal);
    if (!view.available) throw new Error("unreachable");
    expect(view.patch).toEqual({ hunks: [], omittedHunks: 0, omittedFiles: 0 });
    expect(calls.slice(-2).map((call) => call.argv.at(-1))).toEqual([":(literal)a.ts", ":(literal)b.ts"]);
  });

  it("reads an untracked file with no-index and accepts git's difference exit", async () => {
    const { run, calls } = git({
      [GIT_HEAD]: `${WS_HEAD}\n`,
      [GIT_STATUS]: "?? fresh.txt\x00",
      [gitNameStatus(WS_HEAD)]: "",
      [gitNumstat(WS_HEAD)]: "",
      [gitUntrackedPatch("fresh.txt")]: { stdout: "@@ -0,0 +1 @@\n+fresh", exitCode: 1 },
    });
    const view = await buildWorkspaceView({ root: WS_ROOT, writtenFiles: ["fresh.txt"] }, { run }, new AbortController().signal);
    if (!view.available) throw new Error("unreachable");
    expect(view.patch).toEqual({
      hunks: [{ path: "fresh.txt", header: "@@ -0,0 +1 @@", lines: ["+fresh"] }],
      omittedHunks: 0,
      omittedFiles: 0,
    });
    expect(calls.at(-1)!.argv.slice(1).join(" ")).toBe(gitUntrackedPatch("fresh.txt"));
  });

  it("fails closed when an untracked patch read exits with more than git's difference code", async () => {
    const view = await buildWorkspaceView({ root: WS_ROOT, writtenFiles: ["fresh.txt"] }, git({
      [GIT_HEAD]: `${WS_HEAD}\n`,
      [GIT_STATUS]: "?? fresh.txt\x00",
      [gitNameStatus(WS_HEAD)]: "",
      [gitNumstat(WS_HEAD)]: "",
      [gitUntrackedPatch("fresh.txt")]: { stdout: "private content", exitCode: 2 },
    }), new AbortController().signal);
    expect(view).toEqual({
      version: WORKSPACE_VIEW_VERSION,
      available: false,
      failure: { reason: "command_failed", detail: { command: "diff", exitCode: 2 } },
    });
    expect(JSON.stringify(view)).not.toContain("private content");
  });

  it("bounds the patch at 16 KiB and reports hunk and file omissions", async () => {
    const total = WORKSPACE_PATCH_FILES_MAX + 1;
    const paths = Array.from({ length: total }, (_, index) => `f${String(index).padStart(2, "0")}.ts`);
    const names = paths.map((path) => `M\x00${path}\x00`).join("");
    const counts = paths.map((path) => `1\t1\t${path}\x00`).join("");
    const huge = `@@ -1 +1 @@\n-${"x".repeat(EVIDENCE_PATCH_MAX_BYTES)}\n+replacement\n`;
    const view = await buildWorkspaceView({ root: WS_ROOT, writtenFiles: paths }, git({
      [GIT_HEAD]: `${WS_HEAD}\n`,
      [GIT_STATUS]: "",
      [gitNameStatus(WS_HEAD)]: names,
      [gitNumstat(WS_HEAD)]: counts,
      [gitPatch(WS_HEAD, paths[0]!)]: huge,
    }), new AbortController().signal);
    if (!view.available) throw new Error("unreachable");
    expect(Buffer.byteLength(canonicalJson(view.patch), "utf8")).toBeLessThanOrEqual(EVIDENCE_PATCH_MAX_BYTES);
    expect(view.patch).toEqual({ hunks: [], omittedHunks: 1, omittedFiles: total - 1 });
  });
});

describe("buildWorkspaceView — determinism and bounding", () => {
  const busyWorkspace = (base = WS_HEAD): Record<string, GitResponse> => ({
    [GIT_HEAD]: `${WS_HEAD}\n`,
    [GIT_STATUS]: " M m.ts\x00?? u.ts\x00",
    [gitNameStatus(base)]: "M\x00m.ts\x00",
    [gitNumstat(base)]: "2\t3\tm.ts\x00",
  });

  it("fingerprints identically for identical checkouts and differently on any change", async () => {
    const a = await buildWorkspaceView({ root: WS_ROOT }, git(busyWorkspace()), new AbortController().signal);
    const b = await buildWorkspaceView({ root: WS_ROOT }, git(busyWorkspace()), new AbortController().signal);
    expect(a).toMatchObject({ available: true });
    if (!a.available || !b.available) throw new Error("unreachable");
    expect(b.fingerprint).toBe(a.fingerprint);
    // The pinned base is part of the fingerprint: the same tree at a
    // different pin is a different view.
    const moved = await buildWorkspaceView({ root: WS_ROOT, baseRevision: WS_BASE }, git(busyWorkspace(WS_BASE)), new AbortController().signal);
    if (!moved.available) throw new Error("unreachable");
    expect(moved.fingerprint).not.toBe(a.fingerprint);
  });

  it("bounds the file list while the fingerprint still covers the omitted tail", async () => {
    const total = WORKSPACE_CHANGED_FILES_MAX + 5;
    const path = (i: number) => `f${String(i).padStart(4, "0")}.ts`;
    const names = Array.from({ length: total }, (_, i) => `M\x00${path(i)}\x00`).join("");
    const counts = (tail: number) => Array.from({ length: total }, (_, i) => `${i === total - 1 ? tail : 1}\t0\t${path(i)}\x00`).join("");
    const respond = git({ [GIT_HEAD]: `${WS_HEAD}\n`, [GIT_STATUS]: "", [gitNameStatus(WS_HEAD)]: names, [gitNumstat(WS_HEAD)]: counts(1) });
    const view = await buildWorkspaceView({ root: WS_ROOT }, respond, new AbortController().signal);
    if (!view.available) throw new Error("unreachable");
    expect(view.changedFiles).toHaveLength(WORKSPACE_CHANGED_FILES_MAX);
    expect(view.omittedFiles).toBe(total - WORKSPACE_CHANGED_FILES_MAX);
    expect(view.stats.filesChanged).toBe(total);
    // Sorted by path: the tail is omitted from the emitted list, not lost.
    expect(view.changedFiles[0]!.path).toBe("f0000.ts");
    expect(view.changedFiles.at(-1)!.path).toBe(path(WORKSPACE_CHANGED_FILES_MAX - 1));
    // The fingerprint still saw every entry — a change in the truncated tail moves it.
    const changedTail = git({
      [GIT_HEAD]: `${WS_HEAD}\n`,
      [GIT_STATUS]: "",
      [gitNameStatus(WS_HEAD)]: names,
      [gitNumstat(WS_HEAD)]: counts(9),
    });
    const again = await buildWorkspaceView({ root: WS_ROOT }, changedTail, new AbortController().signal);
    if (!again.available) throw new Error("unreachable");
    expect(again.fingerprint).not.toBe(view.fingerprint);
    expect(again.changedFiles).toEqual(view.changedFiles);
  });

  it("bounds over-long paths and rename sources with an ellipsis", async () => {
    const longPath = `d${"eep/".repeat(200)}f.ts`;
    const longFrom = `o${"ld/".repeat(200)}f.ts`;
    const { run } = git({
      [GIT_HEAD]: `${WS_HEAD}\n`,
      [GIT_STATUS]: "",
      [gitNameStatus(WS_HEAD)]: `R100\x00${longFrom}\x00${longPath}\x00`,
      [gitNumstat(WS_HEAD)]: `1\t1\t\x00${longFrom}\x00${longPath}\x00`,
    });
    const view = await buildWorkspaceView({ root: WS_ROOT }, { run }, new AbortController().signal);
    if (!view.available) throw new Error("unreachable");
    const [file] = view.changedFiles;
    expect([...file!.path].length).toBe(513);
    expect(file!.path.endsWith("…")).toBe(true);
    expect([...file!.from!].length).toBe(513);
    expect(file!.from!.endsWith("…")).toBe(true);
  });
});

describe("buildWorkspaceView — failures are explicit, never fabricated", () => {
  it("reports adapter_unavailable without touching a runner", async () => {
    const view = await buildWorkspaceView({ root: WS_ROOT }, {}, new AbortController().signal);
    expect(view).toEqual({ version: WORKSPACE_VIEW_VERSION, available: false, failure: { reason: "adapter_unavailable" } });
  });

  it.each([
    ["a missing root", undefined],
    ["a relative root", "child/workspace"],
    ["a newline-bearing root", "/child/wor\nkspace"],
    ["an empty root", ""],
  ])("refuses %s without ever invoking the runner", async (_name, root) => {
    const { run, calls } = git(cleanWorkspace());
    const view = await buildWorkspaceView({ root: root as string }, { run }, new AbortController().signal);
    expect(view).toEqual({ version: WORKSPACE_VIEW_VERSION, available: false, failure: { reason: "root_invalid" } });
    expect(calls).toEqual([]);
  });

  it.each([["a moving ref", "main"], ["an option injection", "--output=/tmp/x"], ["a short sha", "abc123"]])(
    "refuses a pinned base that is not a full sha: %s",
    async (_name, base) => {
      const { run, calls } = git(cleanWorkspace());
      const view = await buildWorkspaceView({ root: WS_ROOT, baseRevision: base }, { run }, new AbortController().signal);
      expect(view).toEqual({ version: WORKSPACE_VIEW_VERSION, available: false, failure: { reason: "base_invalid" } });
      expect(calls).toEqual([]);
    },
  );

  it.each([
    ["rev-parse", GIT_HEAD],
    ["status", GIT_STATUS],
    ["diff", gitNameStatus(WS_HEAD)],
    ["diff", gitNumstat(WS_HEAD)],
  ])("a non-zero %s exit is a typed command failure", async (command, key) => {
    const responses = cleanWorkspace();
    responses[key] = { stdout: "", exitCode: 128 };
    const view = await buildWorkspaceView({ root: WS_ROOT }, git(responses), new AbortController().signal);
    expect(view).toEqual({
      version: WORKSPACE_VIEW_VERSION,
      available: false,
      failure: { reason: "command_failed", detail: { command, exitCode: 128 } },
    });
  });

  it("types a rejected spawn with its error code — never stderr text", async () => {
    const denied = Object.assign(new Error("spawn git ENOENT at /secret/path"), { code: "ENOENT" });
    const view = await buildWorkspaceView({ root: WS_ROOT }, git({ [GIT_HEAD]: denied }), new AbortController().signal);
    expect(view).toEqual({
      version: WORKSPACE_VIEW_VERSION,
      available: false,
      failure: { reason: "command_failed", detail: { command: "rev-parse", code: "ENOENT" } },
    });
    expect(JSON.stringify(view)).not.toContain("/secret/path");
  });

  it("types a rejection with no usable code as a bare command failure", async () => {
    const view = await buildWorkspaceView({ root: WS_ROOT }, git({ [GIT_HEAD]: new Error("boom at /secret/path") }), new AbortController().signal);
    expect(view).toEqual({
      version: WORKSPACE_VIEW_VERSION,
      available: false,
      failure: { reason: "command_failed", detail: { command: "rev-parse" } },
    });
    expect(JSON.stringify(view)).not.toContain("/secret/path");
  });

  it.each([
    ["a non-revision HEAD", { [GIT_HEAD]: "not-a-sha\n" }, "rev-parse"],
    ["a malformed status stream", { [GIT_STATUS]: "??x\x00" }, "status"],
    ["a malformed name-status letter", { [gitNameStatus(WS_HEAD)]: "Q\x00m.ts\x00" }, "diff"],
    ["a malformed name-status score", { [gitNameStatus(WS_HEAD)]: "Rxy\x00a\x00b\x00" }, "diff"],
    ["a truncated rename record", { [gitNameStatus(WS_HEAD)]: "R100\x00old.ts\x00" }, "diff"],
    ["a name-status record missing its path", { [gitNameStatus(WS_HEAD)]: "M\x00" }, "diff"],
    ["a stray empty name-status record", { [gitNameStatus(WS_HEAD)]: "M\x00m.ts\x00\x00D\x00d.ts\x00" }, "diff"],
    ["a malformed numstat record", { [gitNumstat(WS_HEAD)]: "not-a-numstat\x00" }, "diff"],
    ["a stray empty numstat record", { [gitNumstat(WS_HEAD)]: "3\t4\ta.ts\x00\x00" }, "diff"],
    ["a truncated numstat rename", { [gitNumstat(WS_HEAD)]: "1\t2\t\x00old.ts\x00" }, "diff"],
    ["a malformed status mid-record gap", { [GIT_STATUS]: " M a\x00\x00 M b\x00" }, "status"],
  ])("fails closed as output_malformed on %s", async (_name, overrides, command) => {
    const view = await buildWorkspaceView({ root: WS_ROOT }, git({ ...cleanWorkspace(), ...overrides }), new AbortController().signal);
    expect(view).toEqual({ version: WORKSPACE_VIEW_VERSION, available: false, failure: { reason: "output_malformed", detail: { command } } });
  });

  it.each([
    ["non-string stdout", { stdout: 42, exitCode: 0 }],
    ["a non-integer exit code", { stdout: "", exitCode: Number.NaN }],
  ])("fails closed when the runner result itself is malformed: %s", async (_name, result) => {
    const view = await buildWorkspaceView({ root: WS_ROOT }, git({ [GIT_HEAD]: result as GitResponse }), new AbortController().signal);
    expect(view).toMatchObject({ available: false, failure: { reason: "output_malformed", detail: { command: "rev-parse" } } });
  });

  it("never starts a command on an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const { run, calls } = git(cleanWorkspace());
    const view = await buildWorkspaceView({ root: WS_ROOT }, { run }, controller.signal);
    expect(view).toEqual({ version: WORKSPACE_VIEW_VERSION, available: false, failure: { reason: "aborted" } });
    expect(calls).toEqual([]);
  });

  it("types an abort mid-read whether the runner resolves or rejects", async () => {
    const controller = new AbortController();
    const resolving = git(cleanWorkspace(), (argv) => {
      if (argv[1] === "status") controller.abort();
    });
    const view = await buildWorkspaceView({ root: WS_ROOT }, resolving, controller.signal);
    expect(view).toEqual({ version: WORKSPACE_VIEW_VERSION, available: false, failure: { reason: "aborted" } });

    const second = new AbortController();
    const rejecting = git({ [GIT_HEAD]: new Error("killed") }, () => second.abort());
    const rejected = await buildWorkspaceView({ root: WS_ROOT }, rejecting, second.signal);
    expect(rejected).toEqual({ version: WORKSPACE_VIEW_VERSION, available: false, failure: { reason: "aborted" } });
  });
});

describe("buildWorkspaceView — through the real git runner", () => {
  const gitIn = (dir: string, args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

  it("builds the real view: initial pin, then head movement, dirty work, renames, untracked", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-e2-"));
    dirs.push(dir);
    gitIn(dir, ["init", "-q"]);
    gitIn(dir, ["config", "user.email", "t@t"]);
    gitIn(dir, ["config", "user.name", "t"]);
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "a.txt"), "one\ntwo\nthree\nfour\nfive\n");
    await writeFile(join(dir, "sub", "b.txt"), "two\n");
    gitIn(dir, ["add", "-A"]);
    gitIn(dir, ["commit", "-qm", "init"]);

    const run = createNodeWorkspaceRunner();
    const first = await buildWorkspaceView({ root: dir }, { run }, new AbortController().signal);
    expect(first).toMatchObject({ ...okView, dirty: false, changedFiles: [], omittedFiles: 0 });
    if (!first.available) throw new Error("unreachable");
    expect(first.baseRevision).toBe(first.headRevision);
    expect(first.baseRevision).toMatch(/^[0-9a-f]{40}$/);

    // Head movement: an exact committed rename, then uncommitted work + untracked.
    gitIn(dir, ["mv", "a.txt", "renamed.txt"]);
    gitIn(dir, ["commit", "-qm", "second"]);
    await writeFile(join(dir, "sub", "b.txt"), "two\nthree\n");
    await writeFile(join(dir, "untracked.txt"), "new\n");

    const view = await buildWorkspaceView({
      root: dir,
      baseRevision: first.baseRevision,
      writtenFiles: ["sub/b.txt", "untracked.txt"],
    }, { run }, new AbortController().signal);
    expect(view).toMatchObject({
      ...okView,
      baseRevision: first.baseRevision,
      dirty: true,
      changedFiles: [
        { path: "renamed.txt", status: "renamed", from: "a.txt", added: 0, deleted: 0 },
        { path: "sub/b.txt", status: "modified", added: 1, deleted: 0 },
        { path: "untracked.txt", status: "untracked" },
      ],
      stats: { filesChanged: 2, insertions: 1, deletions: 0, untrackedFiles: 1 },
    });
    if (!view.available) throw new Error("unreachable");
    expect(view.headRevision).not.toBe(first.baseRevision);
    expect(view.fingerprint).not.toBe(first.fingerprint);
    expect(view.patch!.hunks.map((hunk) => hunk.path)).toEqual(["sub/b.txt", "untracked.txt"]);
  });

  it("reports an unborn HEAD and a non-repo directory as unavailable, not clean", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-e2-unborn-"));
    dirs.push(dir);
    gitIn(dir, ["init", "-q"]);
    const run = createNodeWorkspaceRunner();
    const unborn = await buildWorkspaceView({ root: dir }, { run }, new AbortController().signal);
    expect(unborn).toMatchObject({ available: false, failure: { reason: "command_failed", detail: { command: "rev-parse" } } });

    const plain = await mkdtemp(join(tmpdir(), "herdr-e2-plain-"));
    dirs.push(plain);
    const notRepo = await buildWorkspaceView({ root: plain }, { run }, new AbortController().signal);
    expect(notRepo).toMatchObject({ available: false, failure: { reason: "command_failed", detail: { command: "rev-parse" } } });
  });

  it("types a missing root directory as a spawn failure, never a cwd fallback", async () => {
    const view = await buildWorkspaceView(
      { root: "/definitely/not/a/workspace" },
      { run: createNodeWorkspaceRunner() },
      new AbortController().signal,
    );
    expect(view).toMatchObject({ available: false, failure: { reason: "command_failed", detail: { command: "rev-parse", code: "ENOENT" } } });
  });
});

/* ------------------------------------------------------------------ */
/* E3 — assemble, byte-bound, scan, and version the evidence state.     */
/*                                                                     */
/* The scan seam is injected to prove ordering and the trichotomy; the  */
/* local scanner is exercised directly on shaped canaries. Budget       */
/* fixtures measure UTF-8 bytes, never characters.                      */
/* ------------------------------------------------------------------ */

const E3_PEM = "-----BEGIN RSA PRIVATE KEY-----";
const E3_GH_TOKEN = `ghp_${"a".repeat(36)}`;
const E3_GITLAB_TOKEN = `glpat-${"g".repeat(20)}`;
const E3_AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

const e3Thresholds = (): Record<string, number> => ({
  evidence: 0.6,
  risk: 0.6,
  blocked: 0.65,
  appears_complete: 0.7,
  stalled: 0.7,
  stalled_first_observation: 0.85,
  progress: 0.6,
});

function e3Identity(over: Partial<EvidenceIdentityInput> = {}): EvidenceIdentityInput {
  return {
    model: "typesafe/jev-latest",
    questions: {
      evidence_sufficient: "enough evidence?",
      progress: "meaningful advancement?",
      stalled: "repeated without advancement?",
      blocked: "waiting on unresolvable?",
      risk: "incorrect or destructive?",
      appears_complete: "doneWhen met?",
      reason: "overall factor?",
    },
    reducerVersion: 1,
    thresholds: e3Thresholds(),
    ...over,
  };
}

function e3Workspace(
  changedFiles: WorkspaceChangedFile[] = [],
  patch: WorkspacePatch = { hunks: [], omittedHunks: 0, omittedFiles: 0 },
): WorkspaceView {
  return {
    version: WORKSPACE_VIEW_VERSION,
    available: true,
    baseRevision: WS_BASE,
    headRevision: WS_HEAD,
    dirty: changedFiles.length > 0,
    changedFiles,
    omittedFiles: 0,
    stats: { filesChanged: changedFiles.length, insertions: 0, deletions: 0, untrackedFiles: 0 },
    fingerprint: "f".repeat(64),
    patch,
  };
}

function e3Request(over: Partial<EvidenceStateRequest> = {}): EvidenceStateRequest {
  return {
    assignment: { objective: "ship it", doneWhen: ["tests pass"], progressMarkers: ["tests written"], constraints: ["no new deps"] },
    trace: win("devin-session", [devinToolStep(1, [devinCall("a", "exec", { command: "npm test" })], [devinResult("a", "ok\n\nExit code: 0")])]),
    workspace: e3Workspace(),
    terminal: ["line one", "line two"],
    identity: e3Identity(),
    ...over,
  };
}

function e3Ok(build: EvidenceBuild): EvidenceStateOk {
  if (!build.available) throw new Error(`expected a built state, got ${JSON.stringify(build)}`);
  return build;
}

describe("buildEvidenceState — assembly and assignment normalization", () => {
  it("assembles the evidence hierarchy: assignment, trace digest, workspace, terminal", () => {
    const { state } = e3Ok(buildEvidenceState(e3Request()));
    expect(state.version).toBe(EVIDENCE_STATE_VERSION);
    expect(state.scan).toBe("safe");
    expect(state.assignment).toEqual({
      objective: "ship it",
      doneWhen: ["tests pass"],
      progressMarkers: ["tests written"],
      constraints: ["no new deps"],
    });
    expect(state.trace.actions).toEqual([
      { class: "command", tool: "exec", target: "npm test", count: 1, first: 1, last: 1, exitCode: 0 },
    ]);
    expect(state.workspace.available).toBe(true);
    expect(state.terminal).toEqual({ lines: ["line one", "line two"], droppedLines: 0 });
  });

  it("carries an unavailable workspace unchanged and spends no patch bytes", () => {
    const workspace: WorkspaceView = { version: WORKSPACE_VIEW_VERSION, available: false, failure: { reason: "adapter_unavailable" } };
    const build = e3Ok(buildEvidenceState(e3Request({ workspace })));
    expect(build.state.workspace).toEqual(workspace);
    expect(build.bytes.patch).toBe(0);
  });

  it("normalizes an available pre-V2.2 workspace with no patch slot", () => {
    const workspace = e3Workspace();
    if (!workspace.available) throw new Error("unreachable");
    delete workspace.patch;
    const build = e3Ok(buildEvidenceState(e3Request({ workspace })));
    expect(build.state.workspace).toMatchObject({ patch: { hunks: [], omittedHunks: 0, omittedFiles: 0 } });
  });

  it("emits an empty assignment section when none is carried", () => {
    const { state } = e3Ok(buildEvidenceState(e3Request({ assignment: undefined })));
    expect(state.assignment).toEqual({ doneWhen: [], progressMarkers: [], constraints: [] });
    expect("objective" in state.assignment).toBe(false);
  });

  it("wraps bare strings and drops empty and non-string entries", () => {
    const { state } = e3Ok(
      buildEvidenceState(
        e3Request({
          assignment: { objective: "one", doneWhen: "gate green", progressMarkers: ["m1", 7, "", "m2"], constraints: [null, "c1"] },
        }),
      ),
    );
    expect(state.assignment).toEqual({ objective: "one", doneWhen: ["gate green"], progressMarkers: ["m1", "m2"], constraints: ["c1"] });
  });

  it("never folds progressMarkers into doneWhen — markers are not completion criteria", () => {
    const { state } = e3Ok(
      buildEvidenceState(
        e3Request({ assignment: { doneWhen: ["all checks green"], progressMarkers: ["all checks green", "tests written"] } }),
      ),
    );
    // A marker that duplicates a criterion stays a marker; the terminal
    // criteria list gains nothing it was not given.
    expect(state.assignment.doneWhen).toEqual(["all checks green"]);
    expect(state.assignment.progressMarkers).toEqual(["all checks green", "tests written"]);
  });

  it("omits a non-string or empty objective", () => {
    for (const objective of [42, "", null]) {
      const { state } = e3Ok(buildEvidenceState(e3Request({ assignment: { objective } })));
      expect("objective" in state.assignment).toBe(false);
    }
  });

  it("normalizes a bare-string, absent, or mixed terminal input", () => {
    const bare = e3Ok(buildEvidenceState(e3Request({ terminal: "one line" as unknown as string[] })));
    expect(bare.state.terminal).toEqual({ lines: ["one line"], droppedLines: 0 });
    const absent = e3Ok(buildEvidenceState(e3Request({ terminal: undefined })));
    expect(absent.state.terminal).toEqual({ lines: [], droppedLines: 0 });
    const mixed = e3Ok(buildEvidenceState(e3Request({ terminal: 42 as unknown as string[] })));
    expect(mixed.state.terminal).toEqual({ lines: [], droppedLines: 0 });
    const empty = e3Ok(buildEvidenceState(e3Request({ terminal: "" as unknown as string[] })));
    expect(empty.state.terminal).toEqual({ lines: [], droppedLines: 0 });
    const sparse = e3Ok(buildEvidenceState(e3Request({ terminal: ["a", "", "b"] })));
    expect(sparse.state.terminal).toEqual({ lines: ["a", "b"], droppedLines: 0 });
  });

  it("carries a typed trace failure verbatim inside the trace section", () => {
    const failure = { kind: "source_rewritten" as const, detail: { reason: "anchor_mismatch" } };
    const { state } = e3Ok(buildEvidenceState(e3Request({ trace: win("pi-jsonl", [], { typedFailure: failure }) })));
    expect(state.trace.failure).toEqual(failure);
    expect(state.trace.actions).toEqual([]);
  });

  it("keeps a causal chain un-compacted inside the assembled state", () => {
    const { state } = e3Ok(
      buildEvidenceState(
        e3Request({
          trace: win("devin-session", [
            devinToolStep(1, [devinCall("e1", "edit", { file_path: "/a" })], []),
            devinToolStep(2, [devinCall("t1", "exec", { command: "npm test" })], [devinResult("t1", "fail\n\nExit code: 1")]),
            devinToolStep(3, [devinCall("e2", "edit", { file_path: "/a" })], []),
          ]),
        }),
      ),
    );
    expect(state.trace.actions.map((a) => `${a.class}:${a.exitCode ?? "-"}`)).toEqual(["edit:-", "command:1", "edit:-"]);
  });

  it("builds over a tmux-fallback window and carries its omitted-prefix count", () => {
    const window = win("tmux-fallback", [
      { kind: "terminal-line", offset: 18, bytes: 5, record: "hello" },
      { kind: "terminal-line", offset: 19, bytes: 5, record: "world" },
    ]);
    const { state } = e3Ok(buildEvidenceState(e3Request({ trace: window, terminal: ["hello", "world"] })));
    expect(state.trace).toMatchObject({ source: "tmux-fallback", droppedPrefix: 18, incidental: { "terminal-line": 2 } });
    expect(state.terminal.lines).toEqual(["hello", "world"]);
  });
});

describe("buildEvidenceState — UTF-8 byte budgets", () => {
  // `{"constraints":[],"doneWhen":[],"objective":"","progressMarkers":[]}`
  const assignmentWrapBytes = Buffer.byteLength(canonicalJson({ constraints: [], doneWhen: [], objective: "", progressMarkers: [] }), "utf8");

  it("admits an assignment at exactly 8 KiB and refuses one byte over — never truncated", () => {
    const pad = EVIDENCE_ASSIGNMENT_MAX_BYTES - assignmentWrapBytes;
    const at = e3Ok(buildEvidenceState(e3Request({ assignment: { objective: "x".repeat(pad) } })));
    expect(at.bytes.assignment).toBe(EVIDENCE_ASSIGNMENT_MAX_BYTES);

    const over = buildEvidenceState(e3Request({ assignment: { objective: "x".repeat(pad + 1) } }));
    if (over.available) throw new Error("expected unavailable");
    expect(over.failure).toEqual({
      reason: "reviewer_unavailable",
      cause: "assignment_over_budget",
      detail: { bytes: assignmentWrapBytes + pad + 1, budget: EVIDENCE_ASSIGNMENT_MAX_BYTES },
    });
    expect("state" in over).toBe(false);
    expect(over.identity).toBeDefined();
  });

  it("measures the assignment budget in UTF-8 bytes, not characters", () => {
    const over = buildEvidenceState(e3Request({ assignment: { objective: "é".repeat(5000) } }));
    if (over.available) throw new Error("expected unavailable");
    // 5000 chars fits a character budget; 10000 bytes does not fit a byte budget.
    expect(over.failure.cause).toBe("assignment_over_budget");
  });

  it("bounds the trace section at 32 KiB — a digest that cannot fit is unavailable, not truncated", () => {
    const calls = Array.from({ length: 400 }, (_, i) => devinCall(`c${i}`, "read", { file_path: `/src/file-${i}.ts` }));
    const build = buildEvidenceState(e3Request({ trace: win("devin-session", [devinToolStep(1, calls, [])]) }));
    if (build.available) throw new Error("expected unavailable");
    expect(build.failure).toMatchObject({ reason: "reviewer_unavailable", cause: "trace_over_budget", detail: { budget: EVIDENCE_TRACE_MAX_BYTES } });
    expect(build.failure.detail!.bytes as number).toBeGreaterThan(EVIDENCE_TRACE_MAX_BYTES);
    expect("state" in build).toBe(false);
  });

  it("bounds patch to 16 KiB as a deterministic prefix of whole hunks", () => {
    const hunks = Array.from({ length: 80 }, (_, index) => ({
      path: `src/f${index}.ts`,
      header: `@@ -${index + 1} +${index + 1} @@`,
      lines: [`-${"é".repeat(100)}`, `+${"x".repeat(100)}`],
    }));
    const build = e3Ok(buildEvidenceState(e3Request({ workspace: e3Workspace([], { hunks, omittedHunks: 2, omittedFiles: 3 }) })));
    if (!build.state.workspace.available) throw new Error("unreachable");
    expect(build.bytes.patch).toBeLessThanOrEqual(EVIDENCE_PATCH_MAX_BYTES);
    expect(build.state.workspace.patch!.hunks.length).toBeGreaterThan(0);
    expect(build.state.workspace.patch!.hunks.length).toBeLessThan(hunks.length);
    expect(build.state.workspace.patch!.omittedHunks).toBe(2 + hunks.length - build.state.workspace.patch!.hunks.length);
    expect(build.state.workspace.patch!.omittedFiles).toBe(3);
  });

  it("bounds terminal to its own 8 KiB, keeping a contiguous newest suffix of whole lines", () => {
    // A line bigger than the whole budget is dropped whole, never sliced.
    const build = e3Ok(buildEvidenceState(e3Request({ terminal: ["oldest", "h".repeat(9000), "new-1", "new-2"] })));
    expect(build.state.terminal).toEqual({ lines: ["new-1", "new-2"], droppedLines: 2 });
  });

  it("measures the terminal section boundary in bytes", () => {
    const overhead = Buffer.byteLength(canonicalJson({ lines: [""], droppedLines: 0 }), "utf8");
    const pad = EVIDENCE_TERMINAL_MAX_BYTES - overhead;
    const exact = e3Ok(buildEvidenceState(e3Request({ terminal: ["x".repeat(pad)] })));
    expect(exact.bytes.terminal).toBe(EVIDENCE_TERMINAL_MAX_BYTES);
    const over = e3Ok(buildEvidenceState(e3Request({ terminal: ["x".repeat(pad + 1)] })));
    expect(over.state.terminal).toEqual({ lines: [], droppedLines: 1 });
  });

  it("bounds terminal in UTF-8 bytes, not characters", () => {
    const overhead = Buffer.byteLength(canonicalJson({ lines: [""], droppedLines: 0 }), "utf8");
    const chars = Math.floor((EVIDENCE_TERMINAL_MAX_BYTES - overhead) / 2);
    const fits = e3Ok(buildEvidenceState(e3Request({ terminal: ["é".repeat(chars)] })));
    expect(fits.state.terminal.lines).toHaveLength(1);
    const over = e3Ok(buildEvidenceState(e3Request({ terminal: ["é".repeat(chars + 1)] })));
    expect(over.state.terminal).toEqual({ lines: [], droppedLines: 1 });
  });

  it("sacrifices terminal below its own budget before touching structural evidence", () => {
    const files = Array.from({ length: 240 }, (_, i) => ({
      path: `f/${String(i).padStart(3, "0")}${"x".repeat(205)}.ts`,
      status: "modified" as const,
    }));
    const terminal = Array.from({ length: 12 }, (_, i) => `t${i}:${"y".repeat(1000)}`);
    const roomy = e3Ok(buildEvidenceState(e3Request({ workspace: e3Workspace(), terminal })));
    const tight = e3Ok(buildEvidenceState(e3Request({ workspace: e3Workspace(files), terminal })));

    expect(tight.bytes.total).toBeLessThanOrEqual(EVIDENCE_TOTAL_MAX_BYTES);
    // Terminal gave way below what its own budget would have kept…
    expect(tight.state.terminal.lines.length).toBeLessThan(roomy.state.terminal.lines.length);
    // …still a contiguous newest suffix…
    expect(tight.state.terminal.lines).toEqual(terminal.slice(terminal.length - tight.state.terminal.lines.length));
    expect(tight.state.terminal.droppedLines).toBe(terminal.length - tight.state.terminal.lines.length);
    // …and every structural byte survived intact.
    expect(tight.state.workspace).toMatchObject({ changedFiles: files });
    expect(tight.state.assignment.objective).toBe("ship it");
    expect(tight.state.trace.actions).toHaveLength(1);
  });

  it("sacrifices terminal before shrinking the 16 KiB patch slot against the total", () => {
    const files = Array.from({ length: 240 }, (_, index) => ({
      path: `f/${String(index).padStart(3, "0")}${"x".repeat(205)}.ts`,
      status: "modified" as const,
    }));
    const inputPatch: WorkspacePatch = {
      hunks: Array.from({ length: 30 }, (_, index) => ({
        path: `src/p${index}.ts`,
        header: `@@ -${index + 1} +${index + 1} @@`,
        lines: [`-${"a".repeat(250)}`, `+${"b".repeat(250)}`],
      })),
      omittedHunks: 0,
      omittedFiles: 0,
    };
    const withoutTerminal = e3Ok(buildEvidenceState(e3Request({ workspace: e3Workspace(files, inputPatch), terminal: [] })));
    const withTerminal = e3Ok(buildEvidenceState(e3Request({
      workspace: e3Workspace(files, inputPatch),
      terminal: Array.from({ length: 12 }, (_, index) => `t${index}:${"z".repeat(1000)}`),
    })));
    if (!withoutTerminal.state.workspace.available || !withTerminal.state.workspace.available) throw new Error("unreachable");
    expect(withTerminal.state.workspace.patch).toEqual(withoutTerminal.state.workspace.patch);
    expect(withTerminal.state.workspace.patch!.omittedHunks).toBeGreaterThan(0);
    expect(withTerminal.state.terminal).toEqual({ lines: [], droppedLines: 12 });
    expect(withTerminal.bytes.total).toBeLessThanOrEqual(EVIDENCE_TOTAL_MAX_BYTES);
  });

  it("returns reviewer_unavailable when even an empty terminal cannot fit — structural overflow", () => {
    const files = Array.from({ length: 256 }, (_, i) => ({
      path: `f/${String(i).padStart(3, "0")}${"x".repeat(230)}.ts`,
      status: "modified" as const,
    }));
    const build = buildEvidenceState(e3Request({ workspace: e3Workspace(files), terminal: ["t"] }));
    if (build.available) throw new Error("expected unavailable");
    expect(build.failure).toEqual({
      reason: "reviewer_unavailable",
      cause: "state_over_budget",
      detail: { bytes: expect.any(Number), budget: EVIDENCE_TOTAL_MAX_BYTES },
    });
    expect("state" in build).toBe(false);
  });
});

describe("scanEvidenceText — the local sensitive scan", () => {
  it.each([
    ["a PEM private key", `line\n${"-----BEGIN OPENSSH PRIVATE KEY-----"}`, "pem_private_key"],
    ["an AWS-style access key", `export AWS_KEY=${E3_AWS_KEY}`, "aws_access_key"],
    ["a GitHub token", `token ${E3_GH_TOKEN}`, "github_token"],
    ["a GitHub PAT", `github_pat_${"p".repeat(30)}`, "github_token"],
    ["a GitLab token", E3_GITLAB_TOKEN, "gitlab_token"],
    ["a Slack token", `xoxb-${"1".repeat(12)}`, "slack_token"],
    ["a Stripe key", `sk_live_${"s".repeat(24)}`, "stripe_key"],
    ["an sk- API key", `sk-${"k".repeat(30)}`, "openai_key"],
    ["a JWT", `eyJ${"h".repeat(12)}.${"p".repeat(12)}.${"s".repeat(8)}`, "jwt"],
    ["URI credentials", "postgres://user:pw123@host/db", "uri_credentials"],
    ["a bearer token", `Authorization: Bearer ${"t".repeat(24)}`, "bearer_token"],
    ["a password assignment", "password: hunter2x", "secret_assignment"],
    ["a key=value secret", `api_key=${"v".repeat(20)}`, "secret_assignment"],
    ["an env-style secret", `CLIENT_SECRET=${"s".repeat(16)}`, "secret_assignment"],
    ["a GitLab token assignment", `GITLAB_TOKEN=${"g".repeat(20)}`, "secret_assignment"],
  ])("flags %s as %s", (_name, text, detector) => {
    expect(scanEvidenceText(text)).toEqual({ outcome: "sensitive", detail: { detector } });
  });

  it.each([
    ["plain output", "tests passed\n12 files changed"],
    ["a sha-256 fingerprint", `{"fingerprint":"${"f".repeat(64)}"}`],
    ["a short assignment value", `{"token":"abc"}`],
    ["key-shaped prose without a value", "rotate the api_key quarterly"],
    ["a bare sensitive word", "password policy"],
  ])("leaves %s safe", (_name, text) => {
    expect(scanEvidenceText(text)).toEqual({ outcome: "safe" });
  });

  it("is indeterminate on unreadable input", () => {
    expect(scanEvidenceText(42 as unknown as string)).toEqual({ outcome: "indeterminate" });
  });
});

describe("buildEvidenceState — the outbound safety boundary", () => {
  it("scans each section's canonical bytes in evidence order, after compaction and bounding", () => {
    const seen: string[] = [];
    const scan: EvidenceScanner = (text) => {
      seen.push(text);
      return { outcome: "safe" };
    };
    const huge = `dropped ${E3_PEM} ${"h".repeat(9000)}`;
    const { state } = e3Ok(buildEvidenceState(e3Request({ terminal: [huge, "kept line"] }), { scan }));
    expect(seen).toHaveLength(5);
    expect(seen[0]).toContain('"objective":"ship it"');
    expect(seen[1]).toContain('"class":"command"');
    expect(seen[2]).toContain('"fingerprint"');
    expect(seen[3]).toContain("kept line");
    expect(seen[4]).toContain('"questionSetHash"');
    // The scan only ever sees post-bounding bytes: the dropped line's
    // canary is not outbound, so it is neither scanned nor sent.
    for (const text of seen) expect(text).not.toContain(E3_PEM);
    expect(JSON.stringify(state)).not.toContain(E3_PEM);
  });

  it("scans only patch hunks that survive bounding", () => {
    const dropped = e3Ok(buildEvidenceState(e3Request({
      workspace: e3Workspace([], {
        hunks: [{ path: "src/a.ts", header: "@@ -1 +1 @@", lines: [`+${E3_GH_TOKEN}${"x".repeat(EVIDENCE_PATCH_MAX_BYTES)}`] }],
        omittedHunks: 0,
        omittedFiles: 0,
      }),
    })));
    expect(JSON.stringify(dropped.state)).not.toContain(E3_GH_TOKEN);
    if (!dropped.state.workspace.available) throw new Error("unreachable");
    expect(dropped.state.workspace.patch).toEqual({ hunks: [], omittedHunks: 1, omittedFiles: 0 });

    const kept = buildEvidenceState(e3Request({
      workspace: e3Workspace([], {
        hunks: [{ path: "src/a.ts", header: "@@ -1 +1 @@", lines: [`+${E3_GH_TOKEN}`] }],
        omittedHunks: 0,
        omittedFiles: 0,
      }),
    }));
    if (kept.available) throw new Error("expected unavailable");
    expect(kept.failure).toMatchObject({ cause: "sensitive", detail: { section: "workspace", detector: "github_token" } });
  });

  it("sends nothing when a section scans sensitive — the canary never reaches output or diagnostics", () => {
    const build = buildEvidenceState(e3Request({ terminal: [`leaked ${E3_GH_TOKEN} here`] }));
    if (build.available) throw new Error("expected unavailable");
    expect(build.failure).toEqual({
      reason: "reviewer_unavailable",
      cause: "sensitive",
      detail: { section: "terminal", detector: "github_token" },
    });
    expect(JSON.stringify(build)).not.toContain(E3_GH_TOKEN);
    expect("state" in build).toBe(false);
  });

  it("rejects a quoted assignment hidden by canonical JSON escapes", () => {
    const secret = "hunter2x";
    const build = buildEvidenceState(e3Request({ terminal: [`payload {"password":"${secret}"}`] }));
    if (build.available) throw new Error("expected unavailable");
    expect(build.failure).toEqual({
      reason: "reviewer_unavailable",
      cause: "sensitive",
      detail: { section: "terminal", detector: "secret_assignment" },
    });
    expect(JSON.stringify(build)).not.toContain(secret);
  });

  it("rejects the GitLab token-prefix canary on the build path", () => {
    const build = buildEvidenceState(e3Request({ assignment: { objective: `GITLAB_TOKEN=${E3_GITLAB_TOKEN}` } }));
    if (build.available) throw new Error("expected unavailable");
    expect(build.failure).toEqual({
      reason: "reviewer_unavailable",
      cause: "sensitive",
      detail: { section: "assignment", detector: "gitlab_token" },
    });
    expect(JSON.stringify(build)).not.toContain(E3_GITLAB_TOKEN);
  });

  it.each([
    ["assignment", { assignment: { objective: `key material ${E3_GH_TOKEN}` } }, "github_token"],
    [
      "trace",
      { trace: win("devin-session", [devinToolStep(1, [devinCall("a", "exec", { command: `AWS_ACCESS_KEY_ID=${E3_AWS_KEY}` })], [])]) },
      "aws_access_key",
    ],
    ["workspace", { workspace: e3Workspace([{ path: `leaks/${E3_PEM}.txt`, status: "modified" }]) }, "pem_private_key"],
    ["terminal", { terminal: [`run with ${E3_GH_TOKEN}`] }, "github_token"],
    ["identity", { identity: e3Identity({ model: `sk-${"k".repeat(30)}` }) }, "openai_key"],
  ])("flags the %s section", (section, over, detector) => {
    const build = buildEvidenceState(e3Request(over));
    if (build.available) throw new Error("expected unavailable");
    expect(build.failure).toMatchObject({ reason: "reviewer_unavailable", cause: "sensitive", detail: { section, detector } });
  });

  it("reports the earliest sensitive section in evidence order", () => {
    const build = buildEvidenceState(
      e3Request({ assignment: { objective: `key material ${E3_GH_TOKEN}` }, terminal: [E3_PEM] }),
    );
    if (build.available) throw new Error("expected unavailable");
    expect(build.failure.detail).toMatchObject({ section: "assignment" });
  });

  it.each([
    ["a throwing scanner", (() => { throw new Error("scanner exploded"); }) as EvidenceScanner],
    ["an indeterminate report", ((): ReturnType<EvidenceScanner> => ({ outcome: "indeterminate" })) as EvidenceScanner],
    ["a null report", (() => null) as unknown as EvidenceScanner],
    ["an out-of-vocabulary outcome", (() => ({ outcome: "bogus" })) as unknown as EvidenceScanner],
  ])("fails closed as scan_indeterminate on %s", (_name, scan) => {
    const build = buildEvidenceState(e3Request(), { scan });
    if (build.available) throw new Error("expected unavailable");
    expect(build.failure).toEqual({ reason: "reviewer_unavailable", cause: "scan_indeterminate", detail: { section: "assignment" } });
    expect(build.identity).toBeDefined();
  });

  it("forwards only the detector label from a scanner's detail — never its values", () => {
    const scan: EvidenceScanner = () => ({ outcome: "sensitive", detail: { detector: "custom", matchedValue: E3_GH_TOKEN } });
    const build = buildEvidenceState(e3Request(), { scan });
    if (build.available) throw new Error("expected unavailable");
    expect(build.failure.detail).toEqual({ section: "assignment", detector: "custom" });
    expect(JSON.stringify(build)).not.toContain(E3_GH_TOKEN);
  });

  it("omits the detector when a sensitive report carries none or a non-string", () => {
    const scanners: EvidenceScanner[] = [
      () => ({ outcome: "sensitive" }),
      () => ({ outcome: "sensitive", detail: { detector: 7 } }),
    ];
    for (const scan of scanners) {
      const build = buildEvidenceState(e3Request(), { scan });
      if (build.available) throw new Error("expected unavailable");
      expect(build.failure.detail).toEqual({ section: "assignment" });
    }
  });

  it("emits no semantic-redaction marker anywhere — the boundary is all-or-nothing", () => {
    const refused = buildEvidenceState(e3Request({ terminal: [`secret ${E3_GH_TOKEN}`] }));
    expect(JSON.stringify(refused)).not.toContain("[REDACTED]");
    const ok = e3Ok(buildEvidenceState(e3Request()));
    expect(JSON.stringify(ok)).not.toContain("[REDACTED]");
  });
});

describe("buildEvidenceState — version identity and drift", () => {
  it("carries the full version identity deterministically", () => {
    const a = e3Ok(buildEvidenceState(e3Request()));
    const b = e3Ok(buildEvidenceState(e3Request()));
    expect(a.state.identity).toEqual(b.state.identity);
    expect(a.state.identity).toMatchObject({
      contractVersion: EVIDENCE_CONTRACT_VERSION,
      model: "typesafe/jev-latest",
      reducerVersion: 1,
      thresholds: e3Thresholds(),
      questionSetHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      compilerConfigHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      stateBuilderHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(a.state.drift).toEqual({ drifted: false, fields: [] });
  });

  it("hashes the question set — a wording change is a different set", () => {
    const a = e3Ok(buildEvidenceState(e3Request()));
    const b = e3Ok(buildEvidenceState(e3Request({ identity: e3Identity({ questions: { evidence_sufficient: "reworded?" } }) })));
    expect(b.state.identity.questionSetHash).not.toBe(a.state.identity.questionSetHash);
  });

  it("reports no drift when the baseline is this build's own identity", () => {
    const first = e3Ok(buildEvidenceState(e3Request()));
    const second = e3Ok(buildEvidenceState(e3Request({ baselineIdentity: first.state.identity })));
    expect(second.state.drift).toEqual({ drifted: false, fields: [] });
  });

  it.each([...EVIDENCE_IDENTITY_FIELDS])("flags drift on %s", (field) => {
    const baseline = { ...e3Ok(buildEvidenceState(e3Request())).state.identity };
    const mutated: EvidenceVersionIdentity = { ...baseline };
    if (field === "contractVersion") mutated.contractVersion = "9.9";
    else if (field === "model") mutated.model = "typesafe/other";
    else if (field === "questionSetHash") mutated.questionSetHash = "0".repeat(64);
    else if (field === "reducerVersion") mutated.reducerVersion = 2;
    else if (field === "thresholds") mutated.thresholds = { ...mutated.thresholds, risk: 0.61 };
    else if (field === "compilerConfigHash") mutated.compilerConfigHash = "0".repeat(64);
    else mutated.stateBuilderHash = "0".repeat(64);
    const { state } = e3Ok(buildEvidenceState(e3Request({ baselineIdentity: mutated })));
    expect(state.drift).toEqual({ drifted: true, fields: [field] });
  });

  it.each([["a non-record", 42], ["a record missing fields", {}]])(
    "drifts on every field when the baseline is malformed: %s",
    (_name, baseline) => {
      const { state } = e3Ok(buildEvidenceState(e3Request({ baselineIdentity: baseline as unknown as EvidenceVersionIdentity })));
      expect(state.drift).toEqual({ drifted: true, fields: [...EVIDENCE_IDENTITY_FIELDS] });
    },
  );

  it("keeps the version identity on a failed build for provenance", () => {
    const ok = e3Ok(buildEvidenceState(e3Request()));
    const failed = buildEvidenceState(e3Request({ terminal: [E3_PEM] }));
    if (failed.available) throw new Error("expected unavailable");
    expect(failed.identity).toEqual(ok.state.identity);
  });

  it.each([
    ["a missing identity", { identity: undefined }, "identity"],
    ["a non-record identity", { identity: 7 as unknown as EvidenceIdentityInput }, "identity"],
    ["an empty model", { identity: e3Identity({ model: "" }) }, "identity.model"],
    ["a non-string model", { identity: e3Identity({ model: 7 as unknown as string }) }, "identity.model"],
    ["a non-integer reducer version", { identity: e3Identity({ reducerVersion: 1.5 }) }, "identity.reducerVersion"],
    ["missing questions", { identity: e3Identity({ questions: undefined }) }, "identity.questions"],
    ["non-record thresholds", { identity: e3Identity({ thresholds: "x" as unknown as Record<string, number> }) }, "identity.thresholds"],
    ["a non-string threshold", { identity: e3Identity({ thresholds: { risk: "x" as unknown as number } }) }, "identity.thresholds"],
    ["a non-finite threshold", { identity: e3Identity({ thresholds: { risk: Number.NaN } }) }, "identity.thresholds"],
  ])("is input_invalid on %s", (_name, over, field) => {
    const build = buildEvidenceState(e3Request(over));
    if (build.available) throw new Error("expected unavailable");
    expect(build.failure).toEqual({ reason: "reviewer_unavailable", cause: "input_invalid", detail: { field } });
    expect(build.identity).toBeUndefined();
  });

  it("is input_invalid on a non-record request and on a malformed trace", () => {
    const badRequest = buildEvidenceState(42 as unknown as EvidenceStateRequest);
    if (badRequest.available) throw new Error("expected unavailable");
    expect(badRequest.failure).toMatchObject({ cause: "input_invalid", detail: { field: "request" } });

    const badTrace = buildEvidenceState(e3Request({ trace: { events: "no" } as unknown as TraceWindow }));
    if (badTrace.available) throw new Error("expected unavailable");
    expect(badTrace.failure).toMatchObject({ cause: "input_invalid", detail: { field: "trace" } });
    expect(badTrace.identity).toBeDefined();
  });

  it("fails closed as input_invalid when the workspace object cannot serialize", () => {
    const cyclic: Record<string, unknown> = { version: 1, available: true };
    cyclic.self = cyclic;
    const build = buildEvidenceState(e3Request({ workspace: cyclic as unknown as WorkspaceView }));
    if (build.available) throw new Error("expected unavailable");
    expect(build.failure).toMatchObject({ cause: "input_invalid" });
  });
});

describe("buildEvidenceState — byte accounting and determinism", () => {
  it("reports the canonical UTF-8 byte size of the state and each section", () => {
    const build = e3Ok(buildEvidenceState(e3Request()));
    expect(build.bytes.total).toBe(Buffer.byteLength(canonicalJson(build.state), "utf8"));
    expect(build.bytes.assignment).toBe(Buffer.byteLength(canonicalJson(build.state.assignment), "utf8"));
    expect(build.bytes.trace).toBe(Buffer.byteLength(canonicalJson(build.state.trace), "utf8"));
    if (!build.state.workspace.available) throw new Error("unreachable");
    const structuralWorkspace = { ...build.state.workspace };
    const patch = structuralWorkspace.patch!;
    delete structuralWorkspace.patch;
    expect(build.bytes.workspace).toBe(Buffer.byteLength(canonicalJson(structuralWorkspace), "utf8"));
    expect(build.bytes.patch).toBe(Buffer.byteLength(canonicalJson(patch), "utf8"));
    expect(build.bytes.terminal).toBe(Buffer.byteLength(canonicalJson(build.state.terminal), "utf8"));
    expect(build.bytes.total).toBeLessThanOrEqual(EVIDENCE_TOTAL_MAX_BYTES);
  });

  it("is byte-identical for identical inputs", () => {
    const a = e3Ok(buildEvidenceState(e3Request()));
    const b = e3Ok(buildEvidenceState(e3Request()));
    expect(canonicalJson(a.state)).toBe(canonicalJson(b.state));
    expect(a.bytes).toEqual(b.bytes);
  });
});
