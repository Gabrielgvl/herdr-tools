import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { ReviewerFailure, type WaitReviewer } from "../../src/reviewer.js";
import { WaitError, createWaitTool, deltaLines, errorCode, matches, matchesState, mapReviewerFailure, boundedLines, compactMetadata, realClock, type WaitClock, type WaitCli } from "../../src/tools/wait.js";

const snapshot = {
  type: "session_snapshot",
  snapshot: {
    version: "1", protocol: 1,
    workspaces: [{ workspace_id: "w", label: "w" }],
    tabs: [{ tab_id: "w:t", workspace_id: "w", label: "t" }],
    panes: [
      { pane_id: "p1", tab_id: "w:t", workspace_id: "w", label: "one", agent_name: "one", agent_status: "idle" },
      { pane_id: "p2", tab_id: "w:t", workspace_id: "w", label: "two", agent_name: "two", agent_status: "working" }
    ],
    agents: [{ pane_id: "p1", name: "one", agent_status: "idle" }, { pane_id: "p2", name: "two", agent_status: "working" }]
  }
};

function fakeCli(outputs: Record<string, string> = { p1: "already done", p2: "still working" }): WaitCli & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async runJson(argv) {
      calls.push(argv);
      if (argv[0] === "api") return { id: "snapshot", result: snapshot };
      const id = argv[2];
      return { id: "pane", result: { pane: snapshot.snapshot.panes.find((pane) => pane.pane_id === id) } };
    },
    async runText(argv) {
      calls.push(argv);
      return outputs[argv[argv.length - 1]] ?? "";
    }
  };
}

function clock(): WaitClock {
  let now = 0;
  return { now: () => now, sleep: async (milliseconds) => { now += milliseconds; } };
}

const context = { workspaceId: "w", tabId: "w:t", paneId: "p1" };
const extensionContext = { modelRegistry: {} } as ExtensionContext;
const settings = { reviewCadenceMinutes: 1, reviewerModel: "luna", reviewerThinking: "low" as const };

function execute(cli: WaitCli, params: unknown, extra: Partial<Parameters<typeof createWaitTool>[0]> = {}) {
  const tool = createWaitTool({ cli, context, settingsLoader: async () => settings, ...extra });
  return tool.execute("id", params as never, new AbortController().signal, undefined, extensionContext);
}

describe("herdr_wait", () => {
  it("matches existing literal output immediately and does not treat literal as regex", async () => {
    const cli = fakeCli({ p1: "already done", p2: "x" });
    const result = await execute(cli, { targets: ["p1"], match: "any", condition: { kind: "output", match: { kind: "literal", value: ".*" } }, timeoutMs: 1 }, { clock: clock() });
    expect(result.details).toMatchObject({ outcome: "timeout", matched: false });
    expect(cli.calls.filter((call) => call[1] === "read")).toHaveLength(2);
    const regex = await execute(fakeCli({ p1: "already done", p2: "x" }), { targets: ["p1"], match: "any", condition: { kind: "output", match: { kind: "regex", value: "done" } }, timeoutMs: 1 });
    expect(regex.details).toMatchObject({ outcome: "success", matched: true });
  });

  it("implements semantic states and any/all aggregation", async () => {
    const any = await execute(fakeCli(), { targets: ["p1", "p2"], match: "any", condition: { kind: "state", state: "completed" }, timeoutMs: 1 });
    expect(any.details).toMatchObject({ outcome: "success", matched: true });
    const all = await execute(fakeCli(), { targets: ["p1", "p2"], match: "all", condition: { kind: "state", state: "completed" }, timeoutMs: 1 });
    expect(all.details).toMatchObject({ outcome: "timeout", matched: false, reason: "timeout" });
    expect(all.details.targets).toHaveLength(2);
  });

  it("rejects target aliases that resolve to one resource and preserves timeout snapshots", async () => {
    await expect(execute(fakeCli(), { targets: ["p1", "one"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const controller = new AbortController(); controller.abort();
    const tool = createWaitTool({ cli: fakeCli(), context, settingsLoader: async () => settings });
    await expect(tool.execute("id", { targets: ["p1"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 } as never, controller.signal, undefined, extensionContext)).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("does not require reviewer setup when a long wait is already satisfied", async () => {
    const failingFactory = () => { throw new Error("reviewer must not start"); };
    await expect(execute(fakeCli({ p1: "done" }), { targets: ["p1"], match: "any", condition: { kind: "state", state: "completed" }, timeoutMs: 3_600_000 }, { reviewerFactory: failingFactory })).resolves.toMatchObject({ details: { outcome: "success", matched: true } });
  });

  it("runs uncapped reviewers concurrently and ends on manager judgment", async () => {
    const cli = fakeCli({ p1: "working", p2: "working" });
    const entered: string[] = [];
    const reviewer: WaitReviewer = { review: async ({ targetId }) => { entered.push(targetId); return { targetId, classification: "blocked", summary: "needs attention" }; } };
    const result = await execute(cli, { targets: ["p1", "p2"], match: "all", condition: { kind: "state", state: "done" }, timeoutMs: 60_001 }, { clock: clock(), pollIntervalMs: 100_000, reviewerFactory: () => reviewer });
    expect(entered).toEqual(["p1", "p2"]);
    expect(result.details).toMatchObject({ outcome: "manager_judgment_required", matched: false, reason: "manager_judgment_required" });
    expect(result.details.reviewerSummaries).toHaveLength(2);
  });

  it("reviews each target concurrently with bounded transcript deltas", async () => {
    const requests: Array<{ targetId: string; metadata: Record<string, unknown>; transcriptDelta: string[]; signal: AbortSignal }> = [];
    let readCount = 0;
    const cli: WaitCli = {
      async runJson(argv) {
        if (argv[0] === "api") return { id: "snapshot", result: snapshot };
        return { id: "pane", result: { pane: snapshot.snapshot.panes.find((pane) => pane.pane_id === argv[2]) } };
      },
      async runText() {
        readCount += 1;
        const output = readCount <= 2 ? "initial" : readCount <= 4 ? "old" : readCount <= 6 ? "old\nnew" : "old\nnew";
        return output;
      }
    };
    let active = 0;
    let maximumActive = 0;
    const reviewer: WaitReviewer = { review: async (request, signal) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      requests.push({ ...request, signal });
      await Promise.resolve();
      active -= 1;
      return { targetId: request.targetId, classification: "progress", summary: "still progressing" };
    } };
    const result = await execute(cli, { targets: ["p1", "p2"], match: "all", condition: { kind: "state", state: "done" }, timeoutMs: 120_001 }, { clock: clock(), pollIntervalMs: 60_000, reviewerFactory: () => reviewer });
    expect(result.details).toMatchObject({ outcome: "timeout", matched: false, reviewerSummaries: expect.any(Array) });
    expect(requests).toHaveLength(4);
    expect(requests[0].transcriptDelta).toEqual(["old"]);
    expect(requests[2].transcriptDelta).toEqual(["new"]);
    expect(requests.every((request) => request.metadata.pane_id || request.metadata.agent_status)).toBe(true);
    expect(requests.every((request) => !("ignored" in request.metadata))).toBe(true);
    expect(requests.every((request) => request.signal === requests[0].signal)).toBe(true);
    expect(maximumActive).toBeGreaterThan(1);
  });

  it.each(["stalled", "blocked", "risk", "unknown"] as const)("ends with manager judgment for %s reviewer findings", async (classification) => {
    const reviewer: WaitReviewer = { review: async ({ targetId }) => ({ targetId, classification, summary: "attention" }) };
    const result = await execute(fakeCli({ p1: "working" }), { targets: ["p1"], match: "all", condition: { kind: "state", state: "done" }, timeoutMs: 60_001 }, { clock: clock(), pollIntervalMs: 100_000, reviewerFactory: () => reviewer });
    expect(result.details).toMatchObject({ outcome: "manager_judgment_required", matched: false, reason: "manager_judgment_required" });
  });

  it("covers all wait predicates and bounded transcript helpers", () => {
    const base = { target: "p", targetId: "p", metadata: {}, recentUnwrappedLines: ["hello .* world"], observedAtMs: 0, matched: false };
    for (const state of ["idle", "working", "blocked", "done", "unknown"] as const) {
      expect(matchesState(state, state)).toBe(true);
      expect(matches({ ...base, metadata: { agent_status: state } }, { kind: "state", state })).toBe(true);
    }
    expect(matchesState("working", "started")).toBe(true);
    expect(matchesState("idle", "completed")).toBe(true);
    expect(matchesState("done", "completed")).toBe(true);
    expect(matchesState("blocked", "needs_input")).toBe(true);
    expect(matchesState("idle", "needs_input")).toBe(false);
    expect(matchesState("idle", "not-real")).toBe(false);
    expect(matches({ ...base, metadata: { status: "working" } }, { kind: "state", state: "started" })).toBe(true);
    expect(matches({ ...base, metadata: {} }, { kind: "state", state: "unknown" })).toBe(true);
    expect(matches({ ...base, recentUnwrappedLines: ["literal only"] }, { kind: "output", match: { kind: "literal", value: ".*" } })).toBe(false);
    expect(matches(base, { kind: "output", match: { kind: "regex", value: "hello \\.\\* world" } })).toBe(true);
    expect(matches(base, { kind: "output", match: { kind: "regex", value: "hello" } }, /hello/)).toBe(true);
    expect(boundedLines("")).toEqual([]);
    expect(boundedLines(Array.from({ length: 101 }, (_, i) => String(i)).join("\n"))).toHaveLength(100);
    expect(compactMetadata({ pane_id: "p", label: "x", ignored: "no" })).toEqual({ pane_id: "p", label: "x" });
    expect(deltaLines([], ["a", "b"])).toEqual(["a", "b"]);
    expect(deltaLines(["a", "b"], ["a", "b"])).toEqual([]);
    expect(deltaLines(["a", "b"], ["a"])).toEqual([]);
    expect(deltaLines(["a", "b"], ["a", "b", "c"])).toEqual(["c"]);
    expect(deltaLines(["a", "b", "c"], ["b", "c", "d"])).toEqual(["d"]);
    expect(deltaLines(["a", "b"], ["x", "y"])).toEqual(["x", "y"]);
    expect(errorCode({ code: "X" })).toBe("X");
    expect(errorCode({ code: 1 })).toBeUndefined();
    expect(errorCode(null)).toBeUndefined();
    expect(errorCode("error")).toBeUndefined();
    expect(mapReviewerFailure(new Error("x"))).toMatchObject({ code: "REVIEWER_FAILED" });
    const existing = new WaitError("INVALID_INPUT", "existing");
    expect(mapReviewerFailure(existing)).toBe(existing);
    expect(mapReviewerFailure(new ReviewerFailure("failed", { x: 1 }))).toMatchObject({ code: "REVIEWER_FAILED", details: { x: 1 } });
    expect(mapReviewerFailure("failed")).toMatchObject({ code: "REVIEWER_FAILED", details: { cause: "failed" } });
  });

  it("rejects invalid inputs, resolution failures, settings failures, and reviewer failures before false success", async () => {
    const cli = fakeCli();
    for (const params of [
      { targets: ["p1"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 0 },
      { targets: ["missing"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 },
      { targets: ["p1", "one"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 }
    ]) await expect(execute(cli, params)).rejects.toMatchObject({ code: params.targets[0] === "missing" ? "TARGET_NOT_FOUND" : "INVALID_INPUT" });
    const ambiguousSnapshot = { ...snapshot, snapshot: { ...snapshot.snapshot, panes: [...snapshot.snapshot.panes, { ...snapshot.snapshot.panes[1], pane_id: "p3", label: "same", agent_name: "same" }], agents: [...snapshot.snapshot.agents, { pane_id: "p3", name: "same", agent_status: "idle" }] } };
    const alternateCli: WaitCli = { async runJson(argv) { if (argv[0] === "api") return { id: "snapshot", result: ambiguousSnapshot }; return { id: "pane", result: { pane: ambiguousSnapshot.snapshot.panes[0] } }; }, async runText() { return ""; } };
    await expect(execute(alternateCli, { targets: ["same"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 })).resolves.toMatchObject({ details: { outcome: "success" } });
    const trulyAmbiguous = { ...ambiguousSnapshot, snapshot: { ...ambiguousSnapshot.snapshot, panes: [...ambiguousSnapshot.snapshot.panes.map((pane) => pane.pane_id === "p3" ? { ...pane, agent_name: "same2" } : pane), { ...ambiguousSnapshot.snapshot.panes[0], pane_id: "p4", label: "same", agent_name: "other" }], agents: [...ambiguousSnapshot.snapshot.agents.map((agent) => agent.pane_id === "p3" ? { ...agent, name: "same2" } : agent), { pane_id: "p4", name: "other", agent_status: "idle" }] } };
    const trulyAmbiguousCli: WaitCli = { async runJson(argv) { if (argv[0] === "api") return { id: "snapshot", result: trulyAmbiguous }; return { id: "pane", result: { pane: trulyAmbiguous.snapshot.panes[0] } }; }, async runText() { return ""; } };
    await expect(execute(trulyAmbiguousCli, { targets: ["same"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 })).rejects.toMatchObject({ code: "TARGET_AMBIGUOUS" });
    await expect(execute(cli, { targets: ["w:t"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 })).rejects.toMatchObject({ code: "TARGET_TYPE_MISMATCH" });
    await expect(createWaitTool({ cli, context: {} as typeof context, settingsLoader: async () => settings }).execute("id", { targets: ["current"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 } as never, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "CONTEXT_UNAVAILABLE" });
    const settingsError = Object.assign(new Error("bad config"), { code: "INVALID_SETTINGS" });
    await expect(execute(cli, { targets: ["p1"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 }, { settingsLoader: async () => { throw settingsError; } })).rejects.toBe(settingsError);
    await expect(execute(cli, { targets: ["p1"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 }, { settingsLoader: async () => { throw "bad config"; } })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const defaultLoader = createWaitTool({ cli, context, clock: clock() });
    await expect(defaultLoader.execute("id", { targets: ["p1"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 } as never, undefined, undefined, extensionContext)).resolves.toMatchObject({ details: { outcome: "success" } });
    const reviewerError: WaitReviewer = { review: async () => { throw new Error("model down"); } };
    await expect(execute(fakeCli({ p1: "working" }), { targets: ["p1"], match: "all", condition: { kind: "state", state: "done" }, timeoutMs: 60_001 }, { clock: clock(), pollIntervalMs: 100_000, reviewerFactory: () => reviewerError })).rejects.toMatchObject({ code: "REVIEWER_FAILED", details: { cause: "model down" } });
    await expect(execute(fakeCli({ p1: "working" }), { targets: ["p1"], match: "all", condition: { kind: "state", state: "done" }, timeoutMs: 60_001 }, { clock: clock(), pollIntervalMs: 100_000 })).rejects.toMatchObject({ code: "REVIEWER_FAILED" });
  });

  it("polls authoritatively, streams bounded progress, and supports renderers", async () => {
    let reads = 0;
    const cli: WaitCli & { calls: string[][] } = {
      calls: [],
      async runJson(argv) {
        this.calls.push(argv);
        if (argv[0] === "api") return { id: "snapshot", result: snapshot };
        reads += 1;
        const state = reads > 2 ? "working" : "idle";
        return { id: "pane", result: { pane: { ...snapshot.snapshot.panes[0], agent_status: state } } };
      },
      async runText(argv) {
        this.calls.push(argv);
        return reads > 2 ? "matched" : "not yet";
      }
    };
    const updates: string[] = [];
    const tool = createWaitTool({ cli, context, settingsLoader: async () => settings, clock: clock(), pollIntervalMs: 1 });
    const result = await tool.execute("id", { targets: ["p1"], match: "any", condition: { kind: "output", match: { kind: "literal", value: "matched" } }, timeoutMs: 10 } as never, new AbortController().signal, (update) => updates.push(update.content[0]?.type === "text" ? update.content[0].text : ""), extensionContext);
    expect(result.details).toMatchObject({ outcome: "success", matched: true });
    expect(updates[0]).toBe("waiting");
    expect(cli.calls.filter((call) => call[1] === "read").length).toBeGreaterThan(1);
    const call = tool.renderCall?.({ targets: ["p1"], match: "any" } as never, {} as never, {} as never);
    expect(call?.render(80)).toEqual(["herdr_wait · any · p1"]);
    call?.invalidate();
    const rendered = tool.renderResult?.({ content: [], details: result.details, isError: false } as never, {} as never, {} as never, {} as never);
    expect(rendered?.render(80)).toEqual(["wait"]);
    rendered?.invalidate();
    const partialRendered = tool.renderResult?.({ content: [], details: { ...result.details, outcome: "progress", matched: false }, isError: false } as never, {} as never, {} as never, {} as never);
    expect(partialRendered?.render(80)).toEqual(["partial"]);
    partialRendered?.invalidate();
    const emptyRendered = tool.renderResult?.({ content: [], isError: true } as never, {} as never, {} as never, {} as never);
    expect(emptyRendered?.render(80)).toEqual(["error UNKNOWN"]);
    emptyRendered?.invalidate();
    const timeoutRendered = tool.renderResult?.({ content: [], details: { ...result.details, outcome: "timeout", matched: false, reason: "timeout" }, isError: false } as never, {} as never, {} as never, {} as never);
    expect(timeoutRendered?.render(80)).toEqual(["timeout"]);
    timeoutRendered?.invalidate();
    const managerRendered = tool.renderResult?.({ content: [], details: { ...result.details, outcome: "manager_judgment_required", matched: false, reason: "manager_judgment_required" }, isError: false } as never, {} as never, {} as never, {} as never);
    expect(managerRendered?.render(80)).toEqual(["error MANAGER_JUDGMENT_REQUIRED"]);
    managerRendered?.invalidate();
  });

  it("covers deadline final reads and polling continuation", async () => {
    let calls = 0;
    const deadlineClock: WaitClock = { now: () => ++calls > 1 ? 2 : 0, sleep: async () => undefined };
    let paneReads = 0;
    const finalCli: WaitCli = { async runJson(argv) { if (argv[0] === "api") return { id: "snapshot", result: snapshot }; paneReads += 1; return { id: "pane", result: { pane: { ...snapshot.snapshot.panes[0], agent_status: paneReads > 1 ? "idle" : "working" } } }; }, async runText() { return ""; } };
    const finalMatch = await execute(finalCli, { targets: ["p1"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 }, { clock: deadlineClock });
    expect(finalMatch.details).toMatchObject({ outcome: "success", matched: true });
    let finalNow = 0;
    const finalTimeout = await execute(fakeCli({ p1: "not done" }), { targets: ["p1"], match: "any", condition: { kind: "output", match: { kind: "literal", value: "missing" } }, timeoutMs: 1 }, { clock: { now: () => finalNow, sleep: async () => { finalNow = 2; } } });
    expect(finalTimeout.details).toMatchObject({ outcome: "timeout", matched: false, reason: "timeout" });
    const noMatch = await execute(fakeCli({ p1: "not done" }), { targets: ["p1"], match: "any", condition: { kind: "output", match: { kind: "literal", value: "missing" } }, timeoutMs: 2 }, { clock: clock(), pollIntervalMs: 1 });
    expect(noMatch.details).toMatchObject({ outcome: "timeout", reason: "timeout" });
  });

  it("exercises the real abortable clock seam", async () => {
    await realClock.sleep(0, new AbortController().signal);
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(realClock.sleep(1, alreadyAborted.signal)).rejects.toMatchObject({ code: "ABORTED" });
    const controller = new AbortController();
    const pending = realClock.sleep(10_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("preserves read failures as truthful structured errors", async () => {
    const paneFallback: WaitCli = {
      async runJson(argv) {
        if (argv[0] === "api") return { id: "snapshot", result: snapshot };
        return { id: "pane", result: {} };
      },
      async runText() { return ""; }
    };
    await expect(execute(paneFallback, { targets: ["p1"], match: "any", condition: { kind: "state", state: "unknown" }, timeoutMs: 1 })).resolves.toMatchObject({ details: { outcome: "success" } });
    const malformed: WaitCli = {
      async runJson(argv) {
        if (argv[0] === "api") return { id: "snapshot", result: snapshot };
        return { id: "pane", result: null };
      },
      async runText() { return ""; }
    };
    await expect(execute(malformed, { targets: ["p1"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    const rejected: WaitCli = {
      async runJson(argv) {
        if (argv[0] === "api") return { id: "snapshot", result: snapshot };
        throw new Error("backend down");
      },
      async runText() { return ""; }
    };
    await expect(execute(rejected, { targets: ["p1"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    const aborted: WaitCli = {
      async runJson(argv) {
        if (argv[0] === "api") return { id: "snapshot", result: snapshot };
        throw Object.assign(new Error("aborted"), { code: "ABORTED" });
      },
      async runText() { return ""; }
    };
    await expect(execute(aborted, { targets: ["p1"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 })).rejects.toMatchObject({ code: "ABORTED" });
    const throwingSettings = await execute(fakeCli(), { targets: ["p1"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 });
    expect(throwingSettings.details.outcome).toBe("success");
  });

  it("cannot finish after cancellation while a reviewer is pending", async () => {
    const controller = new AbortController();
    let entered = false;
    const reviewer: WaitReviewer = { review: async (_request, signal) => new Promise((_resolve, reject) => {
      entered = true;
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { code: "ABORTED" })), { once: true });
      controller.abort();
    }) };
    const tool = createWaitTool({ cli: fakeCli({ p1: "working" }), context, settingsLoader: async () => settings, clock: clock(), pollIntervalMs: 100_000, reviewerFactory: () => reviewer });
    await expect(tool.execute("id", { targets: ["p1"], match: "all", condition: { kind: "state", state: "done" }, timeoutMs: 60_001 } as never, controller.signal, undefined, extensionContext)).rejects.toMatchObject({ code: "ABORTED" });
    expect(entered).toBe(true);
  });

  it("returns timeout snapshots and keeps abort distinct from timeout", async () => {
    const result = await execute(fakeCli({ p1: "no match" }), { targets: ["p1"], match: "any", condition: { kind: "output", match: { kind: "literal", value: "missing" } }, timeoutMs: 1 }, { clock: clock(), pollIntervalMs: 1 });
    expect(result.details).toMatchObject({ outcome: "timeout", matched: false, reason: "timeout", targets: [{ targetId: "p1", matched: false }] });
    const controller = new AbortController();
    const pending: WaitClock = { now: () => 0, sleep: async (_ms, signal) => { signal.addEventListener("abort", () => undefined); controller.abort(); throw Object.assign(new Error("cancel"), { code: "ABORTED" }); } };
    const tool = createWaitTool({ cli: fakeCli(), context, settingsLoader: async () => settings, clock: pending });
    await expect(tool.execute("id", { targets: ["p2"], match: "all", condition: { kind: "state", state: "done" }, timeoutMs: 1 } as never, controller.signal, undefined, extensionContext)).rejects.toMatchObject({ code: "ABORTED" });
  });
});
