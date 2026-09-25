import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDevinSessionReader, DEVIN_SOURCE_MAX_BYTES, type DevinTraceDeps } from "../../src/supervision/devin-trace.js";
import {
  createTraceSource,
  DevinSourceError,
  TRACE_WINDOW_MAX_BYTES,
  type DevinSessionReader,
  type TraceCursor,
  type TraceSource,
  type TraceSourceIdentity,
} from "../../src/supervision/trace-source.js";

/**
 * Fixture discipline mirrors the Pi adapter suite: canary strings stand in for
 * path-bearing and content-bearing secrets, and every typed failure is
 * asserted to carry no canary — a failure must never smuggle a path or a
 * record out in its detail.
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

function step(fields: Record<string, unknown>): Record<string, unknown> {
  return { source: "agent", message: "", ...fields };
}

/** A step carrying one tool call and its paired per-call result. */
function toolStep(name: string, args: Record<string, unknown>, content: string): Record<string, unknown> {
  const callId = `call_${name}`;
  return step({
    message: "calling the tool",
    model_name: "swe-2-max",
    tool_calls: [{ tool_call_id: callId, function_name: name, arguments: args }],
    observation: { results: [{ source_call_id: callId, content }] },
    metrics: { prompt_tokens: 120, completion_tokens: 30, cached_tokens: 100 },
  });
}

function doc(sessionId: string, steps: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    schema_version: "ATIF-v1.7",
    session_id: sessionId,
    agent: { name: "devin", version: "3000.10.31", model_name: "SWE-2 Max" },
    steps: steps.map((fields, index) => ({ step_id: index + 1, timestamp: `t${index + 1}`, ...fields })),
    final_metrics: { total_prompt_tokens: 1, total_completion_tokens: 1, total_cached_tokens: 0, total_steps: steps.length },
  };
}

/** A document literal without the builder's step numbering — for malformed fixtures. */
function rawDoc(fields: Record<string, unknown>): Uint8Array {
  return bytes({ schema_version: "ATIF-v1.7", session_id: "sess-1", ...fields });
}

function bytes(document: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(document));
}

function files(map: Record<string, Uint8Array>): NonNullable<DevinTraceDeps["readFile"]> {
  return async (path, maxBytes) => {
    const data = map[path];
    if (data === undefined) throw Object.assign(new Error("no such file"), { code: "ENOENT" });
    return data.subarray(0, maxBytes);
  };
}

function source(map: Record<string, Uint8Array>): TraceSource {
  return createTraceSource({ devinSession: reader(map) });
}

function reader(map: Record<string, Uint8Array>): DevinSessionReader {
  return createDevinSessionReader({ transcriptsDir: DIR, readFile: files(map) });
}

const signal = () => new AbortController().signal;
const pathOf = (sessionId: string) => `${DIR}/${sessionId}.json`;

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("devin session reader", () => {
  it("emits one event per step with tool calls, results, file paths, and metrics intact", async () => {
    const document = doc("sess-1", [
      { source: "system", message: "system prompt" },
      { source: "user", message: "fix the tests" },
      toolStep("exec", { command: "npm test" }, "Output from command in shell ab12cd:\nok"),
      toolStep("write", { file_path: "/repo/src/x.ts", content: "…" }, "Wrote 42 bytes"),
    ]);
    const window = await source({ [pathOf("sess-1")]: bytes(document) }).read(identity(), undefined, signal());
    expect(window.typedFailure).toBeUndefined();
    expect(window.source).toBe("devin-session");
    expect(window.events.map((event) => event.kind)).toEqual(["system", "user", "agent", "agent"]);
    expect(window.events.map((event) => event.offset)).toEqual([1, 2, 3, 4]);
    expect(window.events.every((event) => event.bytes > 0)).toBe(true);
    const exec = window.events[2]!.record as {
      tool_calls: Array<{ tool_call_id: string; function_name: string; arguments: Record<string, unknown> }>;
      observation: { results: Array<{ source_call_id: string; content: string }> };
      metrics: Record<string, number>;
    };
    expect(exec.tool_calls[0]!.function_name).toBe("exec");
    expect(exec.tool_calls[0]!.arguments.command).toBe("npm test");
    expect(exec.observation.results[0]!.source_call_id).toBe(exec.tool_calls[0]!.tool_call_id);
    expect(exec.observation.results[0]!.content).toContain("ok");
    expect(exec.metrics.prompt_tokens).toBe(120);
    const write = window.events[3]!.record as { tool_calls: Array<{ arguments: { file_path: string } }> };
    expect(write.tool_calls[0]!.arguments.file_path).toBe("/repo/src/x.ts");
    expect(window.cursorTo).toEqual({
      source: "devin-session",
      position: { session: "sess-1", steps: 4, anchor: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    expect(window.byteCount).toBe(window.events.reduce((total, event) => total + event.bytes, 0));
  });

  it("carries failed tool outcomes through raw, alongside successful ones", async () => {
    const document = doc("sess-1", [
      toolStep("exec", { command: "npm test" }, "Output from command in shell ab12cd:\nall pass\n\nExit code: 0"),
      toolStep("exec", { command: "npm run lint" }, "Output from command in shell cd34ef:\n2 errors\n\nExit code: 1"),
    ]);
    const window = await source({ [pathOf("sess-1")]: bytes(document) }).read(identity(), undefined, signal());
    expect(window.typedFailure).toBeUndefined();
    const results = window.events.map((event) => (event.record as { observation: { results: Array<{ content: string }> } }).observation.results[0]!.content);
    expect(results[0]).toContain("Exit code: 0");
    expect(results[1]).toContain("Exit code: 1");
  });

  it("accepts agent steps with empty tool-call and result lists", async () => {
    const document = doc("sess-1", [
      step({ message: "done", tool_calls: [], observation: { results: [] }, metrics: { prompt_tokens: 1 } }),
    ]);
    const window = await source({ [pathOf("sess-1")]: bytes(document) }).read(identity(), undefined, signal());
    expect(window.typedFailure).toBeUndefined();
    expect(window.events).toHaveLength(1);
    expect(window.events[0]!.kind).toBe("agent");
  });

  it("accepts a minimal step carrying only the fields the format requires", async () => {
    const document = { schema_version: "ATIF-v1.7", session_id: "sess-1", steps: [{ step_id: 1, source: "user" }] };
    const window = await source({ [pathOf("sess-1")]: bytes(document) }).read(identity(), undefined, signal());
    expect(window.typedFailure).toBeUndefined();
    expect(window.events).toEqual([{ kind: "user", offset: 1, bytes: expect.any(Number), record: { step_id: 1, source: "user" } }]);
  });

  it("resumes from the cursor and emits only newly appended steps", async () => {
    const path = pathOf("sess-1");
    const mutable: Record<string, Uint8Array> = { [path]: bytes(doc("sess-1", [step({ message: "one" }), step({ message: "two" })])) };
    const trace = createTraceSource({ devinSession: reader(mutable) });
    const first = await trace.read(identity(), undefined, signal());
    expect(first.events.map((event) => event.offset)).toEqual([1, 2]);
    mutable[path] = bytes(doc("sess-1", [step({ message: "one" }), step({ message: "two" }), step({ message: "three" })]));
    const second = await trace.read(identity(), first.cursorTo, signal());
    expect(second.typedFailure).toBeUndefined();
    expect(second.cursorFrom).toEqual(first.cursorTo);
    expect(second.events.map((event) => event.offset)).toEqual([3]);
    expect(second.cursorTo).toMatchObject({ position: { session: "sess-1", steps: 3 } });
    expect((second.events[0]!.record as { message: string }).message).toBe("three");
  });

  it("keeps an unchanged session a quiet, non-failed window", async () => {
    const trace = source({ [pathOf("sess-1")]: bytes(doc("sess-1", [step({})])) });
    const first = await trace.read(identity(), undefined, signal());
    const second = await trace.read(identity(), first.cursorTo, signal());
    expect(second.typedFailure).toBeUndefined();
    expect(second.events).toEqual([]);
    expect(second.byteCount).toBe(0);
    expect(second.cursorTo).toEqual(first.cursorTo);
  });

  it("accepts a session with no steps and pins a steps-0 cursor", async () => {
    const window = await source({ [pathOf("sess-1")]: bytes(doc("sess-1", [])) }).read(identity(), undefined, signal());
    expect(window.typedFailure).toBeUndefined();
    expect(window.events).toEqual([]);
    expect(window.cursorTo).toEqual({ source: "devin-session", position: { session: "sess-1", steps: 0, anchor: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    const again = await source({ [pathOf("sess-1")]: bytes(doc("sess-1", [])) }).read(identity(), window.cursorTo, signal());
    expect(again.typedFailure).toBeUndefined();
    expect(again.events).toEqual([]);
  });

  it("defers the step that would cross the byte budget and resumes it", async () => {
    const document = doc("sess-1", [step({}), step({ message: "x".repeat(20_000) }), step({ message: "y".repeat(20_000) })]);
    const trace = source({ [pathOf("sess-1")]: bytes(document) });
    const first = await trace.read(identity(), undefined, signal());
    expect(first.typedFailure).toBeUndefined();
    expect(first.byteCount).toBeLessThanOrEqual(TRACE_WINDOW_MAX_BYTES);
    expect(first.events.map((event) => event.offset)).toEqual([1, 2]);
    const second = await trace.read(identity(), first.cursorTo, signal());
    expect(second.typedFailure).toBeUndefined();
    expect(second.events.map((event) => event.offset)).toEqual([3]);
    expect(second.byteCount + first.byteCount).toBe(
      (document.steps as unknown[]).reduce<number>((total, item) => total + Buffer.byteLength(JSON.stringify(item), "utf8"), 0),
    );
  });

  it("fails closed when one step alone can never fit the budget", async () => {
    const document = doc("sess-1", [step({ message: "x".repeat(TRACE_WINDOW_MAX_BYTES) })]);
    const window = await source({ [pathOf("sess-1")]: bytes(document) }).read(identity(), undefined, signal());
    expect(window.typedFailure).toMatchObject({ kind: "record_exceeds_budget", detail: { step: 1 } });
    expect(window.events).toEqual([]);
  });

  it("reports an oversized step once and resumes past it", async () => {
    const document = doc("sess-1", [step({ message: "first" }), step({ message: "x".repeat(40_000) }), step({ message: "third" })]);
    const trace = source({ [pathOf("sess-1")]: bytes(document) });
    const first = await trace.read(identity(), undefined, signal());
    expect(first.events.map((event) => event.offset)).toEqual([1]);
    const overflow = await trace.read(identity(), first.cursorTo, signal());
    expect(overflow.typedFailure).toEqual({ kind: "record_exceeds_budget", detail: { step: 2, bytes: expect.any(Number), skipped: true } });
    expect(overflow.events).toEqual([]);
    expect(overflow.cursorTo).toMatchObject({ source: "devin-session", position: { session: "sess-1", steps: 2 } });
    expect(overflow.cursorTo).not.toEqual(overflow.cursorFrom);
    const resumed = await trace.read(identity(), overflow.cursorTo, signal());
    expect(resumed.typedFailure).toBeUndefined();
    expect(resumed.events.map((event) => event.offset)).toEqual([3]);
    expect(JSON.stringify(overflow)).not.toContain(CANARY_CONTENT);
  });

  it("fails typed before decoding a source document over the file ceiling", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-devin-oversized-"));
    dirs.push(dir);
    await writeFile(join(dir, "sess-1.json"), new Uint8Array(DEVIN_SOURCE_MAX_BYTES + 1));
    const window = await createTraceSource({ devinSession: createDevinSessionReader({ transcriptsDir: dir }) }).read(identity(), undefined, signal());
    expect(window.typedFailure).toEqual({
      kind: "source_exceeds_budget",
      detail: { bytesAtLeast: DEVIN_SOURCE_MAX_BYTES + 1, budget: DEVIN_SOURCE_MAX_BYTES },
    });
    expect(window.events).toEqual([]);
  });

  it("fails closed when the record's declared session id does not match the key", async () => {
    const window = await source({ [pathOf("sess-1")]: bytes(doc("sess-OTHER", [step({})])) }).read(identity("sess-1"), undefined, signal());
    expect(window.typedFailure).toMatchObject({ kind: "source_malformed", detail: { reason: "session_id_mismatch" } });
    expect(window.events).toEqual([]);
    expect(window.cursorTo).toBeUndefined();
  });

  it("detects a record rewritten under a live cursor", async () => {
    const path = pathOf("sess-1");
    const before = doc("sess-1", [step({ message: "one" }), step({ message: "two" })]);
    const after = doc("sess-1", [step({ message: "one" }), step({ message: "TWO" })]); // same count, different bytes
    const mutable: Record<string, Uint8Array> = { [path]: bytes(before) };
    const trace = createTraceSource({ devinSession: reader(mutable) });
    const first = await trace.read(identity(), undefined, signal());
    mutable[path] = bytes(after);
    const second = await trace.read(identity(), first.cursorTo, signal());
    expect(second.typedFailure).toMatchObject({ kind: "source_rewritten", detail: { reason: "anchor_mismatch" } });
    expect(second.cursorTo).toEqual(first.cursorTo);
    expect(second.events).toEqual([]);
  });

  it("detects a record truncated below the cursor (revert/rewind)", async () => {
    const path = pathOf("sess-1");
    const mutable: Record<string, Uint8Array> = { [path]: bytes(doc("sess-1", [step({}), step({}), step({})])) };
    const trace = createTraceSource({ devinSession: reader(mutable) });
    const first = await trace.read(identity(), undefined, signal());
    mutable[path] = bytes(doc("sess-1", [step({})]));
    const second = await trace.read(identity(), first.cursorTo, signal());
    expect(second.typedFailure).toMatchObject({ kind: "source_rewritten", detail: { reason: "steps_truncated" } });
  });

  it("detects a mid-write torn document as malformed, not a quiet window", async () => {
    const torn = bytes(doc("sess-1", [step({})])).subarray(0, 40);
    const window = await source({ [pathOf("sess-1")]: torn }).read(identity(), undefined, signal());
    expect(window.typedFailure).toMatchObject({ kind: "source_malformed", detail: { reason: "invalid_json" } });
  });

  it.each([
    ["a non-object position", "x"],
    ["a position minted for another session", { session: "sess-2", steps: 0, anchor: "a".repeat(64) }],
    ["a fractional steps count", { session: "sess-1", steps: 1.5, anchor: "a".repeat(64) }],
    ["a negative steps count", { session: "sess-1", steps: -1, anchor: "a".repeat(64) }],
    ["a non-string anchor", { session: "sess-1", steps: 0, anchor: 7 }],
    ["a non-hex anchor", { session: "sess-1", steps: 0, anchor: "not-hex" }],
  ])("fails closed on a malformed position: %s", async (_name, position) => {
    const prior: TraceCursor = { source: "devin-session", position };
    const window = await source({ [pathOf("sess-1")]: bytes(doc("sess-1", [step({})])) }).read(identity(), prior, signal());
    expect(window.typedFailure).toMatchObject({ kind: "cursor_malformed" });
    expect(window.cursorTo).toEqual(prior);
  });

  it("accepts a steps-0 position without re-checking its anchor", async () => {
    const prior: TraceCursor = { source: "devin-session", position: { session: "sess-1", steps: 0, anchor: "0".repeat(64) } };
    const window = await source({ [pathOf("sess-1")]: bytes(doc("sess-1", [step({})])) }).read(identity(), prior, signal());
    expect(window.typedFailure).toBeUndefined();
    expect(window.events).toHaveLength(1);
  });

  it.each(["../escape", "a/b", "a\\b", "a\0b", ".", ".."])(
    "fails closed on a filename-unsafe session id: %s",
    async (value) => {
      const window = await source({}).read(identity(value), undefined, signal());
      expect(window.typedFailure).toEqual({ kind: "session_pointer_invalid", detail: { reason: "id_not_filename_safe" } });
    },
  );

  it.each([
    ["invalid UTF-8", new Uint8Array([0x7b, 0x22, 0xff, 0xfe]), "invalid_utf8"],
    ["invalid JSON", new TextEncoder().encode("{"), "invalid_json"],
    ["a JSON scalar", bytes(5), "document_not_object"],
    ["a JSON array", bytes([1, 2]), "document_not_object"],
    ["a missing schema_version", bytes({ session_id: "sess-1", steps: [] }), "schema_version_unsupported"],
    ["an unknown major schema", bytes({ schema_version: "ATIF-v2.0", session_id: "sess-1", steps: [] }), "schema_version_unsupported"],
    ["a non-string schema_version", bytes({ schema_version: 7, session_id: "sess-1", steps: [] }), "schema_version_unsupported"],
    ["a missing session_id", bytes({ schema_version: "ATIF-v1.7", steps: [] }), "session_id_invalid"],
    ["a non-string session_id", bytes({ schema_version: "ATIF-v1.7", session_id: 9, steps: [] }), "session_id_invalid"],
    ["steps not an array", rawDoc({ steps: {} }), "steps_not_array"],
    ["a non-object step", rawDoc({ steps: [5] }), "step_not_object"],
    ["a wrong step_id", rawDoc({ steps: [{ step_id: 9, source: "agent" }] }), "step_id_mismatch"],
    ["a non-integer step_id", rawDoc({ steps: [{ step_id: "1", source: "agent" }] }), "step_id_mismatch"],
    ["a missing source", rawDoc({ steps: [{ step_id: 1 }] }), "source_invalid"],
    ["an empty source", rawDoc({ steps: [{ step_id: 1, source: "" }] }), "source_invalid"],
    ["a non-string source", rawDoc({ steps: [{ step_id: 1, source: 4 }] }), "source_invalid"],
    ["non-array tool_calls", rawDoc({ steps: [{ step_id: 1, source: "agent", tool_calls: {} }] }), "tool_calls_invalid"],
    ["a non-object tool call", rawDoc({ steps: [{ step_id: 1, source: "agent", tool_calls: [5] }] }), "tool_call_invalid"],
    ["a call without tool_call_id", rawDoc({ steps: [{ step_id: 1, source: "agent", tool_calls: [{ function_name: "exec" }] }] }), "tool_call_invalid"],
    ["a call without function_name", rawDoc({ steps: [{ step_id: 1, source: "agent", tool_calls: [{ tool_call_id: "c1" }] }] }), "tool_call_invalid"],
    ["a non-object observation", rawDoc({ steps: [{ step_id: 1, source: "agent", observation: 5 }] }), "observation_invalid"],
    ["non-array results", rawDoc({ steps: [{ step_id: 1, source: "agent", observation: { results: {} } }] }), "observation_invalid"],
    ["a non-object result", rawDoc({ steps: [{ step_id: 1, source: "agent", observation: { results: ["x"] } }] }), "result_invalid"],
    ["a result without source_call_id", rawDoc({ steps: [{ step_id: 1, source: "agent", observation: { results: [{ content: CANARY_CONTENT }] } }] }), "result_invalid"],
    ["a result without string content", rawDoc({ steps: [{ step_id: 1, source: "agent", observation: { results: [{ source_call_id: "c1", content: 4 }] } }] }), "result_invalid"],
    ["non-object metrics", rawDoc({ steps: [{ step_id: 1, source: "agent", metrics: "x" }] }), "metrics_invalid"],
  ])("fails closed on malformed input: %s", async (_name, data, reason) => {
    const window = await source({ [pathOf("sess-1")]: data }).read(identity(), undefined, signal());
    expect(window.typedFailure).toMatchObject({ kind: "source_malformed", detail: { reason } });
    expect(window.events).toEqual([]);
    expect(window.cursorTo).toBeUndefined();
    expect(JSON.stringify(window.typedFailure)).not.toContain(CANARY_CONTENT);
    expect(JSON.stringify(window.typedFailure)).not.toContain(CANARY_PATH);
  });

  it("reports the failing step index without record content", async () => {
    const document = {
      schema_version: "ATIF-v1.7",
      session_id: "sess-1",
      steps: [
        { step_id: 1, source: "agent", message: CANARY_CONTENT },
        { step_id: 2 },
      ],
    };
    const window = await source({ [pathOf("sess-1")]: bytes(document) }).read(identity(), undefined, signal());
    expect(window.typedFailure).toEqual({ kind: "source_malformed", detail: { step: 2, reason: "source_invalid" } });
    expect(JSON.stringify(window.typedFailure)).not.toContain(CANARY_CONTENT);
  });

  it("reports an unreadable record with a code but never the path", async () => {
    const window = await source({}).read(identity(), undefined, signal());
    expect(window.typedFailure).toEqual({ kind: "source_unreadable", detail: { code: "ENOENT" } });
    expect(JSON.stringify(window.typedFailure)).not.toContain(DIR);
  });

  it("reports an aborted read even when storage aborts by throwing", async () => {
    const controller = new AbortController();
    const readFile: NonNullable<DevinTraceDeps["readFile"]> = async () => {
      controller.abort();
      throw Object.assign(new Error("aborted"), { code: "ABORT_ERR" });
    };
    const trace = createTraceSource({ devinSession: createDevinSessionReader({ transcriptsDir: DIR, readFile }) });
    const window = await trace.read(identity(), undefined, controller.signal);
    expect(window.typedFailure).toMatchObject({ kind: "aborted" });
  });

  it("maps a DevinSourceError without detail to a bare typed failure", async () => {
    const trace = createTraceSource({
      devinSession: async () => {
        throw new DevinSourceError("source_malformed");
      },
    });
    const window = await trace.read(identity(), undefined, signal());
    expect(window.typedFailure).toEqual({ kind: "source_malformed" });
  });

  it("rejects with the typed error when called below the seam", async () => {
    const read = reader({ [pathOf("sess-1")]: bytes(doc("sess-2", [step({})])) });
    await expect(read("sess-1", undefined, signal())).rejects.toMatchObject({ name: "DevinSourceError", failure: "source_malformed" });
  });

  it("produces byte-identical output for identical input and cursor", async () => {
    const trace = source({ [pathOf("sess-1")]: bytes(doc("sess-1", [step({ message: "one" }), toolStep("exec", {}, "ok")])) });
    const first = await trace.read(identity(), undefined, signal());
    const again = await trace.read(identity(), undefined, signal());
    expect(JSON.stringify(again)).toBe(JSON.stringify(first));
    const secondA = await trace.read(identity(), first.cursorTo, signal());
    const secondB = await trace.read(identity(), first.cursorTo, signal());
    expect(JSON.stringify(secondA)).toBe(JSON.stringify(secondB));
  });

  it("passes the read's abort signal through to the storage seam", async () => {
    const seen: AbortSignal[] = [];
    const readFile: NonNullable<DevinTraceDeps["readFile"]> = async (_path, maxBytes, readSignal) => {
      expect(maxBytes).toBe(DEVIN_SOURCE_MAX_BYTES + 1);
      seen.push(readSignal);
      return bytes(doc("sess-1", []));
    };
    const controller = new AbortController();
    await createDevinSessionReader({ transcriptsDir: DIR, readFile })("sess-1", undefined, controller.signal);
    expect(seen).toEqual([controller.signal]);
  });

  it("reads through the node filesystem reader inside a real record dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-devin-trace-"));
    dirs.push(dir);
    const document = doc("sess-1", [step({ source: "system", message: "prompt" }), toolStep("read", { file_path: "/repo/x" }, "contents")]);
    await writeFile(join(dir, "sess-1.json"), bytes(document));
    const window = await createTraceSource({ devinSession: createDevinSessionReader({ transcriptsDir: dir }) }).read(identity(), undefined, signal());
    expect(window.typedFailure).toBeUndefined();
    expect(window.events.map((event) => event.kind)).toEqual(["system", "agent"]);
  });

  it("resolves the default record dir under XDG_DATA_HOME", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-devin-xdg-"));
    dirs.push(dir);
    vi.stubEnv("XDG_DATA_HOME", dir);
    const target = join(dir, "devin", "cli", "transcripts");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "sess-9.json"), bytes(doc("sess-9", [step({ source: "user", message: "hi" })])));
    const window = await createTraceSource({ devinSession: createDevinSessionReader() }).read(identity("sess-9"), undefined, signal());
    expect(window.typedFailure).toBeUndefined();
    expect(window.events).toHaveLength(1);
  });

  it.each([["unset", undefined], ["empty", ""]])(
    "resolves the default record dir under ~/.local/share when XDG_DATA_HOME is %s",
    async (_name, value) => {
      vi.stubEnv("XDG_DATA_HOME", value);
      const window = await createTraceSource({ devinSession: createDevinSessionReader() }).read(identity("zz-herdr-t2-nonexistent-9e7f"), undefined, signal());
      expect(window.typedFailure).toMatchObject({ kind: "source_unreadable" });
    },
  );
});
