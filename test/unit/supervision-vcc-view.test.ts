import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/supervision/evidence.js";
import {
  classifySupervisionAction,
  compileSupervisionView,
  SUPERVISION_ACTION_CLASSES,
  SUPERVISION_EVENT_CLASSES,
  SUPERVISION_VIEW_COMPILER,
  SUPERVISION_VIEW_COMPILER_VERSION,
  SUPERVISION_VIEW_CONTRACT_VERSION,
} from "../../src/supervision/vcc-view.js";
import type { TraceCursor, TraceEvent, TraceSourceKind, TraceWindow } from "../../src/supervision/trace-source.js";

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

function event(source: TraceSourceKind, offset: number, record: unknown, kind = source === "devin-session" ? "agent" : "message"): TraceEvent {
  return { kind, offset, bytes: 10, record };
}

function piMessage(offset: number, message: Record<string, unknown>, recordTimestamp?: string): TraceEvent {
  return event("pi-jsonl", offset, {
    type: "message",
    ...(recordTimestamp === undefined ? {} : { timestamp: recordTimestamp }),
    message,
  });
}

function piCall(offset: number, id: unknown, name: unknown, args?: unknown, timestamp?: unknown): TraceEvent {
  return piMessage(offset, {
    role: "assistant",
    ...(timestamp === undefined ? {} : { timestamp }),
    content: [{ type: "toolCall", id, name, arguments: args }],
  });
}

function piResult(offset: number, id: unknown, name: unknown, content: unknown, isError = false, timestamp?: unknown): TraceEvent {
  return piMessage(offset, {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content,
    isError,
    ...(timestamp === undefined ? {} : { timestamp }),
  });
}

function devinStep(step: number, source: string, fields: Record<string, unknown> = {}): TraceEvent {
  return event("devin-session", step, { step_id: step, source, ...fields }, source);
}

function devinCall(id: unknown, name: unknown, args?: unknown): Record<string, unknown> {
  return { tool_call_id: id, function_name: name, ...(args === undefined ? {} : { arguments: args }) };
}

function devinResult(id: unknown, content: unknown): Record<string, unknown> {
  return { source_call_id: id, content };
}

const piCursor = (offset: number): TraceCursor => ({ source: "pi-jsonl", offset, anchor: offset === 0 ? "" : "a".repeat(64) });
const devinCursor = (position: unknown): TraceCursor => ({ source: "devin-session", position });
const tmuxCursor = (lines: string[]): TraceCursor => ({ source: "tmux-fallback", window: lines });

function texts(window: TraceWindow): string[] {
  return compileSupervisionView(window).lines.map((line) => line.text);
}

describe("semantic action classifier", () => {
  it.each([
    ["bash", "execution"],
    ["functions.ctx_execute", "execution"],
    ["custom_shell_tool", "execution"],
    ["write", "mutation"],
    ["tools.apply_patch", "mutation"],
    ["workspace_create_file", "mutation"],
    ["read", "read"],
    ["web_search", "read"],
    ["repo_inspect_symbol", "read"],
    ["ask_user_question", "other"],
    ["...", "other"],
  ])("classifies %s as %s", (tool, expected) => {
    expect(classifySupervisionAction(tool)).toBe(expected);
  });

  it("publishes the closed event and action vocabularies", () => {
    expect(SUPERVISION_EVENT_CLASSES).toEqual(["narration", "tool", "file-change", "command", "signal"]);
    expect(SUPERVISION_ACTION_CLASSES).toEqual(["read", "mutation", "execution", "other"]);
  });
});

describe("Pi JSONL lowering", () => {
  it("emits all five event classes with paired success, failure, exit code, duration, and causal refs", () => {
    const window = win("pi-jsonl", [
      piMessage(0, { role: "assistant", content: [{ type: "thinking", thinking: "Investigating coverage" }] }),
      piCall(10, "r", "read", { path: "src/a.ts" }),
      piResult(20, "r", "read", [{ type: "text", text: "file contents" }]),
      piCall(30, "e", "edit", { file_path: "src/a.ts" }),
      piResult(40, "e", "edit", "applied"),
      piCall(50, "f", "bash", { command: "npm test" }, 1_000),
      piResult(60, "f", "bash", "stderr: failed tests\nCommand exited with code 1", true, 1_250),
      piCall(70, "p", "bash", { command: "npm test" }),
      piResult(80, "p", "bash", "all good", false),
      piMessage(90, { role: "assistant", content: "Done. I am blocked and need your input." }),
    ], { cursorFrom: piCursor(0), cursorTo: piCursor(100) });

    const view = compileSupervisionView(window);
    expect(view).toMatchObject({
      compiler: SUPERVISION_VIEW_COMPILER,
      compilerVersion: SUPERVISION_VIEW_COMPILER_VERSION,
      contractVersion: SUPERVISION_VIEW_CONTRACT_VERSION,
      source: "runner-jsonl",
      rawEventCount: 10,
      truncated: false,
      fromCursor: expect.stringMatching(/^pi-jsonl@0:[0-9a-f]{64}$/u),
      toCursor: expect.stringMatching(/^pi-jsonl@100:[0-9a-f]{64}$/u),
      digestHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(view.lines).toEqual([
      { ref: "pi-jsonl@0", text: "NARRATION role=assistant \"Investigating coverage\"" },
      { ref: "pi-jsonl@10+pi-jsonl@20", text: "TOOL READ tool=\"read\" target=\"src/a.ts\" SUCCESS" },
      { ref: "pi-jsonl@30+pi-jsonl@40", text: "FILE_CHANGE MUTATION tool=\"edit\" target=\"src/a.ts\" SUCCESS" },
      { ref: "pi-jsonl@50+pi-jsonl@60", text: "COMMAND EXECUTION tool=\"bash\" target=\"npm test\" FAILURE EXIT_CODE=1 DURATION_MS=250 TEST_FAILURE STDERR" },
      { ref: "pi-jsonl@70+pi-jsonl@80", text: "COMMAND EXECUTION tool=\"bash\" target=\"npm test\" SUCCESS" },
      { ref: "pi-jsonl@90", text: "SIGNAL BLOCKED+HELP+COMPLETION role=assistant \"Done. I am blocked and need your input.\"" },
    ]);
  });

  it("drops deterministic noise, strips ANSI and harness blocks, and compacts duplicate narration with endpoint refs", () => {
    const repeated = "\u001b[31mChecking\u001b[0m\n50%";
    const view = compileSupervisionView(win("pi-jsonl", [
      event("pi-jsonl", 0, { type: "token_usage", tokens: 4 }, "token_usage"),
      piMessage(1, { role: "assistant", content: [{ type: "text", text: repeated }] }),
      piMessage(2, { role: "assistant", content: [{ type: "text", text: repeated }] }),
      piMessage(3, { role: "assistant", content: [{ type: "text", text: repeated }] }),
      piMessage(4, { role: "assistant", content: "<system-reminder>hidden</system-reminder><harness>noise</harness>" }),
      piMessage(5, { role: "assistant", content: [{ type: "text", text: "⠋ loading..." }, 7] }),
      piMessage(6, { role: "user", content: "Fix Error: permission denied in the completed task" }),
      piMessage(7, { role: "user", content: "Please stop now" }),
      event("pi-jsonl", 8, { type: "runtime_error" }, "runtime_error"),
      event("pi-jsonl", 9, { type: "process_exited" }, "process_exited"),
      event("pi-jsonl", 10, "bad", "message"),
      piMessage(11, { role: "system", content: "ignored" }),
      piMessage(12, { role: "assistant", content: "Error: permission denied; policy prohibits it; process terminated" }),
    ]));

    expect(view.rawEventCount).toBe(13);
    expect(view.lines).toEqual([
      { ref: "pi-jsonl@1..pi-jsonl@3", text: "NARRATION role=assistant \"Checking\" REPEATED=3" },
      { ref: "pi-jsonl@7", text: "SIGNAL TERMINATION role=user \"Please stop now\"" },
      { ref: "pi-jsonl@8", text: "SIGNAL ERROR kind=\"runtime_error\"" },
      { ref: "pi-jsonl@9", text: "SIGNAL PROCESS_TERMINATION kind=\"process_exited\"" },
      { ref: "pi-jsonl@12", text: "SIGNAL AUTH_FAILURE+TOOL_REFUSAL+ERROR+PROCESS_TERMINATION role=assistant \"Error: permission denied; policy prohibits it; process terminated\"" },
    ]);
  });

  it("keeps repeated mutations, compacts successful reads, and pairs duplicate call ids in order", () => {
    const view = compileSupervisionView(win("pi-jsonl", [
      piCall(0, "same", "read", { path: "/f" }),
      piCall(1, "same", "read", { path: "/f" }),
      piResult(2, "same", "read", "ok"),
      piResult(3, "same", "read", "ok"),
      piCall(4, "w1", "write", { path: "/f" }),
      piResult(5, "w1", "write", "ok"),
      piCall(6, "w2", "write", { path: "/f" }),
      piResult(7, "w2", "write", "ok"),
    ]));

    expect(view.lines).toEqual([
      { ref: "pi-jsonl@0+pi-jsonl@2..pi-jsonl@1+pi-jsonl@3", text: "TOOL READ tool=\"read\" target=\"/f\" SUCCESS REPEATED=2" },
      { ref: "pi-jsonl@4+pi-jsonl@5", text: "FILE_CHANGE MUTATION tool=\"write\" target=\"/f\" SUCCESS" },
      { ref: "pi-jsonl@6+pi-jsonl@7", text: "FILE_CHANGE MUTATION tool=\"write\" target=\"/f\" SUCCESS" },
    ]);
  });

  it("keeps orphan and malformed calls honest and extracts array and MCP targets", () => {
    const view = compileSupervisionView(win("pi-jsonl", [
      piResult(0, 7, undefined, 42),
      piCall(1, undefined, undefined, undefined),
      piCall(2, "a", "ctx_batch_execute", { commands: ["npm test", { command: "npm run lint" }, 5, ""] }),
      piResult(3, "a", "ctx_batch_execute", "ok"),
      piCall(4, "m", "mcp_call_tool", { server_name: "github", tool_name: "create_issue" }),
      piResult(5, "m", "mcp_call_tool", "permission denied; policy prohibits this; Traceback"),
      piCall(6, "x", "read", "bad args"),
    ]));

    expect(view.lines).toEqual([
      { ref: "pi-jsonl@0", text: "TOOL OTHER tool=\"unpaired_result\" SUCCESS" },
      { ref: "pi-jsonl@1", text: "TOOL OTHER tool=\"malformed_tool_call\" PENDING" },
      { ref: "pi-jsonl@2+pi-jsonl@3", text: "COMMAND EXECUTION tool=\"ctx_batch_execute\" target=\"npm test; npm run lint\" SUCCESS" },
      { ref: "pi-jsonl@4+pi-jsonl@5", text: "TOOL OTHER tool=\"mcp_call_tool\" target=\"github:create_issue\" FAILURE AUTH_FAILURE TOOL_REFUSAL EXCEPTION" },
      { ref: "pi-jsonl@6", text: "TOOL READ tool=\"read\" PENDING" },
    ]);
  });

  it("uses record timestamps, omits invalid or backwards durations, and ignores echoed clean Pi exit markers", () => {
    const view = compileSupervisionView(win("pi-jsonl", [
      piMessage(0, { role: "assistant", content: [{ type: "toolCall", id: "a", name: "bash", arguments: { command: "echo" } }] }, "2026-01-01T00:00:00.000Z"),
      piResult(1, "a", "bash", "Command exited with code 9", false, "2026-01-01T00:00:00.500Z"),
      piCall(2, "b", "bash", { command: "x" }, Number.POSITIVE_INFINITY),
      piResult(3, "b", "bash", "ok", false, 4),
      piCall(4, "c", "bash", { command: "y" }, 9),
      piResult(5, "c", "bash", "ok", false, 8),
      piCall(6, "d", "bash", { command: "z" }, "bad-date"),
      piResult(7, "d", "bash", "ok", false, "also-bad"),
    ]));

    expect(view.lines.map((line) => line.text)).toEqual([
      "COMMAND EXECUTION tool=\"bash\" target=\"echo\" SUCCESS DURATION_MS=500",
      "COMMAND EXECUTION tool=\"bash\" target=\"x\" SUCCESS",
      "COMMAND EXECUTION tool=\"bash\" target=\"y\" SUCCESS",
      "COMMAND EXECUTION tool=\"bash\" target=\"z\" SUCCESS",
    ]);
  });
});

describe("Devin ATIF lowering", () => {
  it("pairs observation results by source_call_id and preserves edit-test-edit-pass causality", () => {
    const view = compileSupervisionView(win("devin-session", [
      devinStep(1, "agent", { message: "Investigating", tool_calls: [devinCall("t1", "exec", { command: "pnpm test" })], observation: { results: [devinResult("t1", "failed tests\nExit code: 1")] } }),
      devinStep(2, "agent", { tool_calls: [devinCall("e", "edit", { file_path: "src/x.ts" })], observation: { results: [devinResult("e", "ok")] } }),
      devinStep(3, "agent", { tool_calls: [devinCall("t2", "exec", { command: "pnpm test" })], observation: { results: [devinResult("t2", "printed Exit code: 7\nExit code: 0")] } }),
    ], {
      cursorFrom: devinCursor({ session: "s", steps: 0, anchor: "a".repeat(64) }),
      cursorTo: devinCursor({ session: "s", steps: 3, anchor: "b".repeat(64) }),
    }));

    expect(view.source).toBe("runner-jsonl");
    expect(view.lines).toEqual([
      { ref: "devin-session@1", text: "NARRATION role=assistant \"Investigating\"" },
      { ref: "devin-session@1", text: "COMMAND EXECUTION tool=\"exec\" target=\"pnpm test\" FAILURE EXIT_CODE=1 TEST_FAILURE" },
      { ref: "devin-session@2", text: "FILE_CHANGE MUTATION tool=\"edit\" target=\"src/x.ts\" SUCCESS" },
      { ref: "devin-session@3", text: "COMMAND EXECUTION tool=\"exec\" target=\"pnpm test\" SUCCESS EXIT_CODE=0" },
    ]);
    expect(view.fromCursor).toMatch(/^devin-session@0:[0-9a-f]{64}$/u);
    expect(view.toCursor).toMatch(/^devin-session@3:[0-9a-f]{64}$/u);
  });

  it("emits pending malformed calls and unpaired results without fabricating outcomes", () => {
    const view = compileSupervisionView(win("devin-session", [
      devinStep(1, "agent", {
        message: [{ text: "Working" }, { thinking: "carefully" }, 7],
        tool_calls: [5, devinCall("a", "read", { query: ["one", { query: "two" }, 3] })],
        observation: { results: [devinResult("a", "ok"), devinResult("extra", "Exit code: 2")] },
      }),
      devinStep(2, "agent", { tool_calls: [devinCall(9, "exec", { command: "run" })] }),
      devinStep(3, "user", { message: "normal input" }),
      devinStep(4, "user", { message: "Cancel this task" }),
      devinStep(5, "agent", { message: "Done", tool_calls: "bad" }),
      event("devin-session", 6, "bad", "runtime_exception"),
      event("devin-session", 7, { type: "queue_operation" }, "queue_operation"),
    ]));

    expect(view.lines).toEqual([
      { ref: "devin-session@1", text: "NARRATION role=assistant \"Working carefully\"" },
      { ref: "devin-session@1", text: "TOOL OTHER tool=\"malformed_tool_call\" PENDING" },
      { ref: "devin-session@1", text: "TOOL READ tool=\"read\" target=\"one; two\" SUCCESS" },
      { ref: "devin-session@1", text: "TOOL OTHER tool=\"unpaired_result\" target=\"extra\" SUCCESS" },
      { ref: "devin-session@2", text: "COMMAND EXECUTION tool=\"exec\" target=\"run\" PENDING" },
      { ref: "devin-session@4", text: "SIGNAL TERMINATION role=user \"Cancel this task\"" },
      { ref: "devin-session@5", text: "SIGNAL COMPLETION role=assistant \"Done\"" },
      { ref: "devin-session@6", text: "SIGNAL ERROR kind=\"runtime_exception\"" },
    ]);
  });

  it("flags successful git mutation and process termination commands as causal", () => {
    const repeated = [
      devinStep(1, "agent", { tool_calls: [devinCall("a", "exec", { command: "git commit -m x" })], observation: { results: [devinResult("a", "Exit code: 0")] } }),
      devinStep(2, "agent", { tool_calls: [devinCall("b", "exec", { command: "git commit -m x" })], observation: { results: [devinResult("b", "Exit code: 0")] } }),
      devinStep(3, "agent", { tool_calls: [devinCall("c", "exec", { command: "pkill server" })], observation: { results: [devinResult("c", "Exit code: 0")] } }),
    ];
    expect(texts(win("devin-session", repeated))).toEqual([
      "COMMAND EXECUTION tool=\"exec\" target=\"git commit -m x\" SUCCESS EXIT_CODE=0 GIT_MUTATION",
      "COMMAND EXECUTION tool=\"exec\" target=\"git commit -m x\" SUCCESS EXIT_CODE=0 GIT_MUTATION",
      "COMMAND EXECUTION tool=\"exec\" target=\"pkill server\" SUCCESS EXIT_CODE=0 PROCESS_TERMINATION",
    ]);
  });

  it("covers empty targets, source-record oddities, and same-ref compaction without inventing data", () => {
    const view = compileSupervisionView(win("devin-session", [
      devinStep(1, "agent", {
        message: [{ type: "image" }],
        tool_calls: [
          devinCall("a", "read", { command: "", pattern: "fallback" }),
          devinCall("b", "read", { queries: [3, {}, ""] }),
          devinCall("c", "mcp_call_tool", { server_name: "github" }),
          devinCall("d", "exec"),
          devinCall("h", "read", { path: "/missing" }),
        ],
        observation: { results: [
          devinResult("a", "ok"),
          devinResult("b", "ok"),
          devinResult("c", "ok"),
          devinResult("d", "Exit code: 999999999999999999999"),
          devinResult("h", "Error: missing"),
        ] },
      }),
      devinStep(2, "agent", {
        tool_calls: [devinCall("e", "exec", { command: "build" })],
        observation: { results: [devinResult("e", "test failure\nExit code: 1")] },
      }),
      devinStep(3, "agent", {
        tool_calls: [devinCall("f", "read", { path: "/same" }), devinCall("g", "read", { path: "/same" })],
        observation: { results: [devinResult("f", "ok"), devinResult("g", "ok")] },
      }),
    ]));

    expect(view.lines).toEqual([
      { ref: "devin-session@1", text: "TOOL READ tool=\"read\" target=\"fallback\" SUCCESS" },
      { ref: "devin-session@1", text: "TOOL READ tool=\"read\" SUCCESS" },
      { ref: "devin-session@1", text: "TOOL OTHER tool=\"mcp_call_tool\" SUCCESS" },
      { ref: "devin-session@1", text: "COMMAND EXECUTION tool=\"exec\" SUCCESS" },
      { ref: "devin-session@1", text: "TOOL READ tool=\"read\" target=\"/missing\" FAILURE ERROR" },
      { ref: "devin-session@2", text: "COMMAND EXECUTION tool=\"exec\" target=\"build\" FAILURE EXIT_CODE=1 TEST_FAILURE" },
      { ref: "devin-session@3", text: "TOOL READ tool=\"read\" target=\"/same\" SUCCESS REPEATED=2" },
    ]);
  });

  it("labels a cursor without a position hint by source and hash only", () => {
    const view = compileSupervisionView(win("devin-session", [], { cursorTo: devinCursor("opaque") }));
    expect(view.fromCursor).toBeNull();
    expect(view.toCursor).toMatch(/^devin-session:[0-9a-f]{64}$/u);
  });
});

describe("fallback, failures, and determinism", () => {
  it("lowers fallback text, drops progress, compacts repeats, and exposes scroll-off", () => {
    const view = compileSupervisionView(win("tmux-fallback", [
      event("tmux-fallback", 2, "25%", "terminal-line"),
      event("tmux-fallback", 3, "building", "terminal-line"),
      event("tmux-fallback", 4, "building", "terminal-line"),
      event("tmux-fallback", 5, "I cannot proceed because permission is required", "terminal-line"),
      event("tmux-fallback", 6, 7, "process_exit"),
    ], { cursorTo: tmuxCursor(["building"]) }));

    expect(view).toMatchObject({ source: "tmux-fallback", fromCursor: null, truncated: true, rawEventCount: 5 });
    expect(view.toCursor).toMatch(/^tmux-fallback@1:[0-9a-f]{64}$/u);
    expect(view.lines).toEqual([
      { ref: "tmux-fallback@3..tmux-fallback@4", text: "NARRATION role=terminal \"building\" REPEATED=2" },
      { ref: "tmux-fallback@5", text: "SIGNAL BLOCKED role=terminal \"I cannot proceed because permission is required\"" },
      { ref: "tmux-fallback@6", text: "SIGNAL PROCESS_TERMINATION kind=\"process_exit\"" },
    ]);
  });

  it.each([
    ["record_exceeds_budget", true, { offset: 12 }, " detail={\"offset\":12}"],
    ["source_rewritten", false, undefined, ""],
  ] as const)("carries typed failure %s as a non-droppable signal", (kind, truncated, detail, detailText) => {
    const view = compileSupervisionView(win("pi-jsonl", [], { typedFailure: { kind, ...(detail === undefined ? {} : { detail }) } }));
    expect(view.truncated).toBe(truncated);
    expect(view.lines).toEqual([{ ref: "pi-jsonl@failure", text: `SIGNAL TRACE_FAILURE kind=${JSON.stringify(kind)}${detailText}` }]);
  });

  it("is byte-identical for identical input and changes its hash when even dropped raw evidence changes", () => {
    const base = win("pi-jsonl", [piMessage(0, { role: "assistant", content: "Working" })]);
    const first = compileSupervisionView(base);
    const second = compileSupervisionView(structuredClone(base));
    expect(canonicalJson(first)).toBe(canonicalJson(second));

    const changed = compileSupervisionView(win("pi-jsonl", [
      ...base.events,
      event("pi-jsonl", 1, { type: "token_usage" }, "token_usage"),
    ]));
    expect(changed.lines).toEqual(first.lines);
    expect(changed.rawEventCount).toBe(2);
    expect(changed.digestHash).not.toBe(first.digestHash);
  });
});
