import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ReviewerFailure, type WaitReviewer } from "../../src/reviewer.js";
import { createJobsTool } from "../../src/tools/jobs.js";
import { WaitError, boundedBackgroundDetails, createWaitTool, deltaLines, deriveWaitLabel, errorCode, matches, matchesState, mapReviewerFailure, boundedLines, compactMetadata, prepareWait, realClock, runPreparedWait, type WaitClock, type WaitCli } from "../../src/tools/wait.js";
import { JobRegistry } from "../../src/job-registry.js";
import { createTargetGenerationRef, historicalTargetEvidence, isTargetEvidence, requireWaitTargetIdentity, sameWaitTargetIdentity } from "../../src/wait-target-evidence.js";

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

const currentPane = () => ({ id: "current", result: { type: "pane_current", pane: snapshot.snapshot.panes[0] } });

function fakeCli(outputs: Record<string, string> = { p1: "already done", p2: "still working" }): WaitCli & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async runJson(argv) {
      calls.push(argv);
      if (argv[0] === "pane" && argv[1] === "current") return { id: "current", result: { type: "pane_current", pane: snapshot.snapshot.panes[0] } };
      if (argv[0] === "api") return { id: "snapshot", result: snapshot };
      const id = argv[2];
      return { id: "pane", result: { pane: snapshot.snapshot.panes.find((pane) => pane.pane_id === id) } };
    },
    async runText(argv) {
      calls.push(argv);
      return outputs[argv[0] === "pane" && argv[1] === "read" ? argv[2]! : argv[argv.length - 1]!] ?? "";
    }
  };
}

function clock(): WaitClock {
  let now = 0;
  return { now: () => now, sleep: async (milliseconds) => { now += milliseconds; } };
}

function nativeSnapshot(statuses: Record<string, string> = { p1: "idle", p2: "working" }) {
  const base = structuredClone(snapshot);
  base.snapshot.panes = base.snapshot.panes.map((pane) => ({
    ...pane,
    agent: "pi",
    terminal_id: `term-${pane.pane_id}`,
    agent_session: { source: "pi", agent: "pi", kind: "id", value: `${pane.pane_id}-session` },
    agent_status: statuses[pane.pane_id] ?? pane.agent_status
  }));
  base.snapshot.agents = base.snapshot.agents.map((agent) => ({
    ...agent,
    agent: "pi",
    terminal_id: `term-${agent.pane_id}`,
    agent_session: { source: "pi", agent: "pi", kind: "id", value: `${agent.pane_id}-session` },
    agent_status: statuses[agent.pane_id] ?? agent.agent_status
  }));
  return base;
}

function nativeCli(options: { statuses?: Record<string, string>; complete?: boolean; timeout?: boolean; mismatch?: boolean; fail?: boolean } = {}): WaitCli & { calls: string[][] } {
  const calls: string[][] = [];
  const live = nativeSnapshot(options.statuses);
  const pane = (paneId: string) => live.snapshot.panes.find((candidate) => candidate.pane_id === paneId)!;
  return {
    calls,
    supportsNativeAgentWait: true,
    async runJson(argv) {
      calls.push(argv);
      if (argv[0] === "pane" && argv[1] === "current") return { id: "current", result: { type: "pane_current", pane: live.snapshot.panes[0] } };
      if (argv[0] === "api") return { id: "snapshot", result: live };
      if (argv[0] === "agent" && argv[1] === "wait") {
        if (options.timeout) throw Object.assign(new Error("native wait timed out"), { code: "CLI_TIMEOUT" });
        const value = pane(argv[2]!);
        if (options.fail) throw new Error("native wait failed");
        if (options.mismatch) return { id: "wait", result: { agent: { ...value, terminal_id: "replaced-terminal" } } };
        if (options.complete) return { id: "wait", result: { agent: value } };
        return { id: "wait", result: { type: "wait_matched", event: { event: "pane_agent_status_changed", data: { pane_id: value.pane_id, workspace_id: "w", agent_status: value.agent_status } } } };
      }
      if (argv[0] === "agent" && argv[1] === "get") return { id: "agent", result: { agent: pane(argv[2]!) } };
      return { id: "pane", result: { pane: pane(argv[2]!) } };
    },
    async runText(argv) {
      calls.push(argv);
      return "native output";
    }
  };
}

const context = { workspaceId: "w", tabId: "w:t", paneId: "p1" };
const extensionContext = { modelRegistry: {} } as ExtensionContext;
const settings = { reviewCadenceMinutes: 1, reviewerModel: "luna", reviewerThinking: "low" as const };

async function execute(cli: WaitCli, params: unknown, extra: Partial<Parameters<typeof createWaitTool>[0]> = {}) {
  const { jobRegistry = new JobRegistry(), ...rest } = extra;
  const deps = { cli, context, settingsLoader: async () => settings, jobRegistry, ...rest } as Parameters<typeof prepareWait>[0];
  const prepared = await prepareWait(deps, params, new AbortController().signal);
  return runPreparedWait(deps, prepared, new AbortController().signal, () => undefined, extensionContext);
}

describe("herdr_wait", () => {
  it("validates opaque historical target evidence and complete occupant identity", () => {
    const generation = createTargetGenerationRef(() => "opaque-1");
    expect(generation).toBe("target_generation_opaque-1");
    expect(() => createTargetGenerationRef(() => "" )).toThrow(/TARGET_GENERATION_REF_INVALID/);
    expect(() => createTargetGenerationRef(() => "bad\nref" )).toThrow(/TARGET_GENERATION_REF_INVALID/);
    expect(() => createTargetGenerationRef(() => 1 as unknown as string)).toThrow(/TARGET_GENERATION_REF_INVALID/);
    const evidence = historicalTargetEvidence("predicate_observed", 10, generation, "composite_observation");
    expect(evidence).toEqual({ kind: "predicate_observed", observedAtMs: 10, targetGenerationRef: generation, currency: "historical_non_current", source: "composite_observation" });
    for (const kind of ["native_done_observed", "agent_absent_observed", "pane_absent_observed", "target_replaced", "identity_unknown"] as const) {
      expect(historicalTargetEvidence(kind, 10, generation, "native_agent_wait").currency).toBe("historical_non_current");
    }
    expect(() => historicalTargetEvidence("not-a-kind" as never, 10, generation, "native_agent_wait")).toThrow(/TARGET_EVIDENCE_INVALID/);
    expect(() => historicalTargetEvidence("predicate_observed", 10, generation, "not-a-source" as never)).toThrow(/TARGET_EVIDENCE_INVALID/);
    expect(() => historicalTargetEvidence("predicate_observed", -1, generation, "native_agent_wait")).toThrow(/TARGET_EVIDENCE_INVALID/);
    expect(() => historicalTargetEvidence("predicate_observed", 1.5, generation, "native_agent_wait")).toThrow(/TARGET_EVIDENCE_INVALID/);
    expect(() => historicalTargetEvidence("predicate_observed", 10, "bad\nref", "native_agent_wait")).toThrow(/TARGET_EVIDENCE_INVALID/);
    const valid = { ...evidence };
    expect(isTargetEvidence(valid)).toBe(true);
    for (const invalid of [
      null,
      [],
      { ...valid, kind: "not-a-kind" },
      { ...valid, observedAtMs: -1 },
      { ...valid, observedAtMs: 1.5 },
      { ...valid, targetGenerationRef: "" },
      { ...valid, targetGenerationRef: "bad\nref" },
      { ...valid, currency: "current" },
      { ...valid, source: "not-a-source" }
    ]) expect(isTargetEvidence(invalid)).toBe(false);
    const pane = { pane_id: "p1", terminal_id: "term-1", agent_name: "one", agent: "pi", agent_session: { source: "pi", agent: "pi", kind: "id", value: "session-1" } };
    const agent = { pane_id: "p1", terminal_id: "term-1", name: "one", agent: "pi", agent_session: { source: "pi", agent: "pi", kind: "id", value: "session-1" } };
    const identity = requireWaitTargetIdentity([pane, agent], "p1");
    expect(identity).toMatchObject({ paneId: "p1", terminalId: "term-1", agentName: "one", agentKind: "pi", agentSession: { value: "session-1" } });
    expect(sameWaitTargetIdentity(identity, { ...identity, agentSession: { ...identity.agentSession } })).toBe(true);
    expect(sameWaitTargetIdentity(identity, { ...identity, terminalId: "term-2" })).toBe(false);
    expect(() => requireWaitTargetIdentity([], "p1")).toThrow(/missing/);
  });

  it("delegates every native-compatible state predicate without client status polling", async () => {
    const cases = [
      ["idle", "idle"], ["working", "working"], ["blocked", "blocked"], ["done", "done"], ["unknown", "unknown"],
      ["started", "working"], ["needs_input", "blocked"], ["completed", "idle"], ["terminal", "idle"]
    ] as const;
    for (const [state, observed] of cases) {
      const cli = nativeCli({ statuses: { p1: observed } });
      const result = await execute(cli, { targets: ["p1"], match: "any", condition: { kind: "state", state }, timeoutMs: 1 }, { clock: clock() });
      expect(result).toMatchObject({ wait_result: "condition_met", matched: true, targets: [{ target_evidence: { source: "native_agent_wait", currency: "historical_non_current" } }] });
      expect(cli.calls.some((call) => call[0] === "agent" && call[1] === "wait")).toBe(true);
      expect(cli.calls.some((call) => call[1] === "read")).toBe(false);
      expect(cli.calls.some((call) => call[0] === "pane" && call[1] === "get")).toBe(false);
    }
  });

  it("uses native identity evidence, fails closed on replacement, and handles timeout/malformed responses", async () => {
    const incomplete = nativeCli({ statuses: { p1: "done" } });
    await expect(execute(incomplete, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: clock() })).resolves.toMatchObject({ wait_result: "condition_met" });
    expect(incomplete.calls.map((call) => call.slice(0, 2))).toContainEqual(["agent", "get"]);
    const mismatch = nativeCli({ statuses: { p1: "done" }, mismatch: true });
    await expect(execute(mismatch, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: clock() })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    const malformed: WaitCli = { ...nativeCli({ statuses: { p1: "done" } }), async runJson(argv) {
      if (argv[0] === "pane" && argv[1] === "current") return currentPane();
      if (argv[0] === "api") return { id: "snapshot", result: nativeSnapshot({ p1: "working" }) };
      if (argv[0] === "agent" && argv[1] === "wait") return { id: "wait", result: { agent: { pane_id: "p1" } } };
      return { id: "agent", result: { agent: nativeSnapshot().snapshot.panes[0] } };
    } };
    await expect(execute(malformed, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: clock() })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    await expect(execute(nativeCli({ timeout: true }), { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: clock() })).resolves.toMatchObject({ wait_result: "timed_out", matched: false });
  });

  it("supports a native wait seam and any/all aggregation without a status read", async () => {
    const base = nativeCli({ statuses: { p1: "working", p2: "done" } });
    const seam: WaitCli = {
      supportsNativeAgentWait: true,
      async runJson(argv, signal) { return base.runJson(argv, signal); },
      async runText(argv, signal) { return base.runText(argv, signal); },
      async runNativeAgentWait(targetId, until, _timeoutMs, signal) {
        expect(until).toEqual(["done"]);
        if (targetId === "p1") return new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("losing native wait"), { code: "ABORTED" })), { once: true }));
        return { result: { agent: nativeSnapshot({ p1: "working", p2: "done" }).snapshot.panes.find((pane) => pane.pane_id === targetId) } };
      }
    };
    const any = await execute(seam, { targets: ["p1", "p2"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: clock() });
    expect(any).toMatchObject({ wait_result: "condition_met", matched: true, targets: [expect.objectContaining({ targetId: "p2" })] });
    let releaseOrdered!: () => void;
    const orderedGate = new Promise<void>((resolve) => { releaseOrdered = resolve; });
    const ordered = nativeCli({ statuses: { p1: "working", p2: "done" } });
    ordered.runNativeAgentWait = async (targetId, _until, _timeoutMs, signal) => {
      if (targetId === "p2") await orderedGate;
      signal.throwIfAborted?.();
      return { result: { agent: nativeSnapshot({ p1: "working", p2: "done" }).snapshot.panes.find((pane) => pane.pane_id === targetId) } };
    };
    const orderedWait = execute(ordered, { targets: ["p1", "p2"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: clock() });
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseOrdered();
    expect(await orderedWait).toMatchObject({ wait_result: "condition_met", matched: true, targets: [expect.objectContaining({ targetId: "p1" }), expect.objectContaining({ targetId: "p2" })] });
    const all = await execute(nativeCli({ statuses: { p1: "done", p2: "done" } }), { targets: ["p1", "p2"], match: "all", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: clock() });
    expect(all).toMatchObject({ wait_result: "condition_met", matched: true });
    const none = await execute(nativeCli({ statuses: { p1: "working" }, timeout: true }), { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: clock() });
    expect(none).toMatchObject({ wait_result: "timed_out", matched: false });
    const unmatched = await execute(nativeCli({ statuses: { p1: "working" } }), { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: clock() });
    expect(unmatched).toMatchObject({ wait_result: "timed_out", matched: false });
    const unmatchedMany = await execute(nativeCli({ statuses: { p1: "working", p2: "working" } }), { targets: ["p1", "p2"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: clock() });
    expect(unmatchedMany).toMatchObject({ wait_result: "timed_out", matched: false, targets: [expect.objectContaining({ targetId: "p1" }), expect.objectContaining({ targetId: "p2" })] });
    const allTimeout = await execute(nativeCli({ statuses: { p1: "working", p2: "working" }, timeout: true }), { targets: ["p1", "p2"], match: "all", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: clock() });
    expect(allTimeout).toMatchObject({ wait_result: "timed_out", matched: false });
    let allDeadlineCalls = 0;
    const allDeadline = await execute(nativeCli({ statuses: { p1: "working", p2: "working" }, timeout: true }), { targets: ["p1", "p2"], match: "all", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: { now: () => allDeadlineCalls++ < 3 ? 0 : 1, sleep: async () => undefined } });
    expect(allDeadline).toMatchObject({ wait_result: "timed_out", matched: false });
    await expect(execute(nativeCli({ statuses: { p1: "working" }, fail: true }), { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: clock() })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    const missing = nativeCli({ statuses: { p1: "working" } });
    const originalRunJson = missing.runJson.bind(missing);
    missing.runJson = async (argv, signal) => {
      if (argv[0] === "agent" && argv[1] === "wait") return { id: "wait", result: { unrelated: { pane_id: "other", agent_status: "working" } } };
      return originalRunJson(argv, signal);
    };
    await expect(execute(missing, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: clock() })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    const badSeam = nativeCli({ statuses: { p1: "working" } });
    badSeam.runNativeAgentWait = async () => ({ type: "wait_matched", event: { event: "pane_agent_status_changed", data: { pane_id: "p1", agent_status: "working" } } });
    await expect(execute(badSeam, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: clock() })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    const fallbackIdentity = nativeCli({ statuses: { p1: "working" } });
    const fallbackRunJson = fallbackIdentity.runJson.bind(fallbackIdentity);
    fallbackIdentity.runJson = async (argv, signal) => argv[0] === "agent" && argv[1] === "get" ? { id: "agent", result: {} } : fallbackRunJson(argv, signal);
    await expect(execute(fallbackIdentity, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: clock() })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    const abortController = new AbortController();
    const prepared = await prepareWait({ cli: nativeCli({ statuses: { p1: "working" } }), context, settingsLoader: async () => settings, jobRegistry: new JobRegistry() }, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, new AbortController().signal);
    abortController.abort();
    await expect(runPreparedWait({ cli: nativeCli({ statuses: { p1: "working" } }), context, settingsLoader: async () => settings, jobRegistry: new JobRegistry(), clock: clock() }, prepared, abortController.signal, () => undefined, extensionContext)).rejects.toMatchObject({ code: "ABORTED" });
    const parentAbort = new AbortController();
    const abortingCli = nativeCli({ statuses: { p1: "working" } });
    abortingCli.runNativeAgentWait = async (_targetId, _until, _timeoutMs, childSignal) => new Promise<never>((_resolve, reject) => {
      queueMicrotask(() => parentAbort.abort());
      childSignal.addEventListener("abort", () => reject(Object.assign(new Error("parent aborted"), { code: "ABORTED" })), { once: true });
    });
    const abortingPrepared = await prepareWait({ cli: abortingCli, context, settingsLoader: async () => settings, jobRegistry: new JobRegistry() }, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 10 }, new AbortController().signal);
    await expect(runPreparedWait({ cli: abortingCli, context, settingsLoader: async () => settings, jobRegistry: new JobRegistry(), clock: clock() }, abortingPrepared, parentAbort.signal, () => undefined, extensionContext)).rejects.toMatchObject({ code: "ABORTED" });
    let nowCalls = 0;
    const atDeadline = await execute(nativeCli({ statuses: { p1: "done" }, complete: true }), { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: { now: () => nowCalls++ < 2 ? 0 : 1, sleep: async () => undefined } });
    expect(atDeadline).toMatchObject({ wait_result: "timed_out", matched: false });
  });

  it("keeps reviewer refreshes composite and never lets them satisfy a native predicate", async () => {
    const cli = nativeCli({ statuses: { p1: "working" } });
    const reviewed: string[] = [];
    const reviewer: WaitReviewer = {
      review: async ({ targetId }) => {
        reviewed.push(targetId);
        return { targetId, classification: "blocked", summary: "needs attention" };
      }
    };
    const result = await execute(cli, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 120_001 }, { clock: clock(), pollIntervalMs: 60_000, reviewerFactory: () => reviewer });
    expect(result).toMatchObject({ wait_result: "manager_judgment_required", matched: false });
    expect(reviewed).toEqual(["p1"]);
    expect(cli.calls.some((call) => call[1] === "read")).toBe(true);
    expect(cli.calls.filter((call) => call[0] === "agent" && call[1] === "wait").length).toBeGreaterThan(1);
  });

  it("returns timed_out when a native review refresh reaches the deadline", async () => {
    let now = 0;
    const cli = nativeCli({ statuses: { p1: "working" } });
    const originalRunText = cli.runText.bind(cli);
    cli.runText = async (...args) => {
      now = 120_001;
      return originalRunText(...args);
    };
    const reviewer: WaitReviewer = { review: async ({ targetId }) => ({ targetId, classification: "blocked", summary: "not reached" }) };
    const result = await execute(cli, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 120_001 }, { clock: { now: () => now, sleep: async (milliseconds) => { now += milliseconds; } }, pollIntervalMs: 60_000, reviewerFactory: () => reviewer });
    expect(result).toMatchObject({ wait_result: "timed_out", matched: false, reason: "timeout" });
  });

  it("keeps composite output identity sandwiches separate from native waits", async () => {
    const live = nativeSnapshot({ p1: "working" });
    let paneGets = 0;
    const strictCli: WaitCli = {
      supportsNativeAgentWait: false,
      async runJson(argv) {
        if (argv[0] === "pane" && argv[1] === "current") return { id: "current", result: { type: "pane_current", pane: live.snapshot.panes[0] } };
        if (argv[0] === "api") return { id: "snapshot", result: live };
        if (argv[0] === "pane" && argv[1] === "get") {
          paneGets += 1;
          const pane = live.snapshot.panes.find((candidate) => candidate.pane_id === argv[2])!;
          return { id: "pane", result: { pane: paneGets > 2 ? { ...pane, terminal_id: "replaced-terminal" } : pane } };
        }
        return { id: "other", result: { ok: true } };
      },
      async runTextResult() { return { value: "needle", truncated: false }; },
      async runText() { return "needle"; }
    };
    const result = await execute(strictCli, { targets: ["p1"], match: "any", condition: { kind: "output", match: { kind: "literal", value: "needle" } }, timeoutMs: 1 }, { clock: clock(), requireTargetIdentity: true });
    expect(result).toMatchObject({ wait_result: "condition_met", targets: [{ target_evidence: { source: "composite_observation", currency: "historical_non_current" } }] });
    expect(paneGets).toBe(2);
    const missingIdentity = fakeCli();
    await expect(prepareWait({ cli: missingIdentity, context, settingsLoader: async () => settings, jobRegistry: new JobRegistry(), requireTargetIdentity: true }, { targets: ["p1"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 }, new AbortController().signal)).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    const contradictory = nativeSnapshot({ p1: "working" });
    contradictory.snapshot.agents[0] = { ...contradictory.snapshot.agents[0]!, terminal_id: "other-terminal" } as unknown as typeof contradictory.snapshot.agents[number];
    const contradictoryCli: WaitCli = { async runJson(argv) { if (argv[0] === "pane" && argv[1] === "current") return { id: "current", result: { type: "pane_current", pane: contradictory.snapshot.panes[0] } }; if (argv[0] === "api") return { id: "snapshot", result: contradictory }; return { id: "pane", result: { pane: contradictory.snapshot.panes[0] } }; }, async runText() { return ""; } };
    await expect(prepareWait({ cli: contradictoryCli, context, settingsLoader: async () => settings, jobRegistry: new JobRegistry(), requireTargetIdentity: true }, { targets: ["p1"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 }, new AbortController().signal)).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR", message: "CLI_PROTOCOL_ERROR: wait target identity changed" });
    paneGets = 1;
    const replacement = await prepareWait({ cli: strictCli, context, settingsLoader: async () => settings, jobRegistry: new JobRegistry(), requireTargetIdentity: true }, { targets: ["p1"], match: "any", condition: { kind: "output", match: { kind: "literal", value: "needle" } }, timeoutMs: 1 }, new AbortController().signal);
    await expect(runPreparedWait({ cli: strictCli, context, settingsLoader: async () => settings, jobRegistry: new JobRegistry(), requireTargetIdentity: true, clock: clock() }, replacement, new AbortController().signal, () => undefined, extensionContext)).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    paneGets = 2;
    await expect(runPreparedWait({ cli: strictCli, context, settingsLoader: async () => settings, jobRegistry: new JobRegistry(), requireTargetIdentity: true, clock: clock() }, replacement, new AbortController().signal, () => undefined, extensionContext)).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
  });

  it("reports a live caller rebind in the detached acknowledgement", async () => {
    const stale = { workspaceId: "old-workspace", tabId: "old-tab", paneId: "p1" };
    const registry = new JobRegistry({ idFactory: () => "job_rebind" });
    const detached = await createWaitTool({ cli: fakeCli(), context: stale, settingsLoader: async () => settings, jobRegistry: registry, clock: clock() }).execute("id", { targets: ["p2"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 } as never, new AbortController().signal, undefined, extensionContext);
    expect(detached.details).toMatchObject({ contextRebinding: { injected: stale, effective: context, rebound: true, attempts: 1 } });
  });

  it("strips environment values from every retained target snapshot at every depth", async () => {
    const leaky: WaitCli = {
      async runJson(argv) {
        if (argv[0] === "pane" && argv[1] === "current") return currentPane();
        if (argv[0] === "api") return { id: "snapshot", result: snapshot };
        return {
          id: "pane",
          result: {
            pane: {
              ...snapshot.snapshot.panes.find((pane) => pane.pane_id === argv[2]),
              environment: { SECRET: "pane-secret" },
              environment_variables: { SECRET: "variables-secret" },
              history: [{ env: { SECRET: "array-secret" } }, { child: { environment_overrides: { SECRET: "deep-secret" } } }]
            }
          }
        };
      },
      async runText() { return "still working"; }
    };
    const result = await execute(leaky, { targets: ["p2"], match: "any", condition: { kind: "state", state: "working" }, timeoutMs: 1 }, { clock: clock() });
    expect(result).toMatchObject({ wait_result: "condition_met", matched: true });
    const targets = (result as { targets: Array<{ metadata: Record<string, unknown> }> }).targets;
    expect(targets[0]!.metadata).toEqual({ pane_id: "p2", tab_id: "w:t", workspace_id: "w", label: "two", agent_name: "two", agent_status: "working", history: [{}, { child: {} }] });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("matches existing literal output immediately and does not treat literal as regex", async () => {
    const cli = fakeCli({ p1: "already done", p2: "x" });
    const result = await execute(cli, { targets: ["p1"], match: "any", condition: { kind: "output", match: { kind: "literal", value: ".*" } }, timeoutMs: 1 }, { clock: clock() });
    expect(result).toMatchObject({ wait_result: "timed_out", matched: false });
    expect(cli.calls.filter((call) => call[1] === "read")).toEqual([
      ["pane", "read", "p1", "--source", "recent-unwrapped", "--lines", "100", "--format", "text"]
    ]);
    const regex = await execute(fakeCli({ p1: "already done", p2: "x" }), { targets: ["p1"], match: "any", condition: { kind: "output", match: { kind: "regex", value: "done" } }, timeoutMs: 1 }, { clock: clock() });
    expect(regex).toMatchObject({ wait_result: "condition_met", matched: true });
  });

  it("implements semantic states and any/all aggregation", async () => {
    const any = await execute(fakeCli(), { targets: ["p1", "p2"], match: "any", condition: { kind: "state", state: "completed" }, timeoutMs: 1 }, { clock: clock() });
    expect(any).toMatchObject({ wait_result: "condition_met", matched: true });
    const all = await execute(fakeCli(), { targets: ["p1", "p2"], match: "all", condition: { kind: "state", state: "completed" }, timeoutMs: 1 }, { clock: clock() });
    expect(all).toMatchObject({ wait_result: "timed_out", matched: false, reason: "timeout" });
    expect(all.targets).toHaveLength(2);
  });

  it("matches terminal to idle, blocked, and done only", () => {
    const expected = new Map([
      ["idle", true],
      ["working", false],
      ["blocked", true],
      ["done", true],
      ["unknown", false]
    ]);
    for (const [state, matches] of expected) expect(matchesState(state, "terminal")).toBe(matches);
  });

  it("describes the terminal semantic state", () => {
    const tool = createWaitTool({ cli: fakeCli(), context, settingsLoader: async () => settings, jobRegistry: new JobRegistry() });
    expect(tool.description).toContain("terminal");
  });

  it("rejects target aliases that resolve to one resource and preserves timeout snapshots", async () => {
    await expect(execute(fakeCli(), { targets: ["p1", "one"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const controller = new AbortController(); controller.abort();
    const tool = createWaitTool({ cli: fakeCli(), context, settingsLoader: async () => settings, jobRegistry: new JobRegistry() });
    await expect(tool.execute("id", { targets: ["p1"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 } as never, controller.signal, undefined, extensionContext)).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("does not require reviewer setup when a long wait is already satisfied", async () => {
    const failingFactory = () => { throw new Error("reviewer must not start"); };
    await expect(execute(fakeCli({ p1: "done" }), { targets: ["p1"], match: "any", condition: { kind: "state", state: "completed" }, timeoutMs: 3_600_000 }, { reviewerFactory: failingFactory })).resolves.toMatchObject({ wait_result: "condition_met", matched: true });
  });

  it("runs uncapped reviewers concurrently and ends on manager judgment", async () => {
    const cli = fakeCli({ p1: "working", p2: "working" });
    const entered: string[] = [];
    const reviewer: WaitReviewer = { review: async ({ targetId }) => { entered.push(targetId); return { targetId, classification: "blocked", summary: "needs attention" }; } };
    const result = await execute(cli, { targets: ["p1", "p2"], match: "all", condition: { kind: "state", state: "done" }, timeoutMs: 60_001 }, { clock: clock(), pollIntervalMs: 100_000, reviewerFactory: () => reviewer });
    expect(entered).toEqual(["p1", "p2"]);
    expect(result).toMatchObject({ wait_result: "manager_judgment_required", matched: false, reason: "manager_judgment_required" });
    expect((result as { reviewerSummaries?: unknown[] }).reviewerSummaries).toHaveLength(2);
  });

  it("honors an authoritative condition that becomes true during reviewer refresh", async () => {
    let reviewerReleased = false;
    const cli: WaitCli = {
      async runJson(argv) {
        if (argv[0] === "pane" && argv[1] === "current") return currentPane();
        if (argv[0] === "api") return { id: "snapshot", result: snapshot };
        const pane = snapshot.snapshot.panes[0];
        return { id: "pane", result: { pane: { ...pane, agent_status: reviewerReleased ? "idle" : "working" } } };
      },
      async runText() { return "still working"; }
    };
    const reviewer: WaitReviewer = {
      review: async ({ targetId }) => {
        reviewerReleased = true;
        return { targetId, classification: "blocked", summary: "stale evidence" };
      }
    };
    const result = await execute(cli, { targets: ["p1"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 120_001 }, { clock: clock(), pollIntervalMs: 60_000, reviewerFactory: () => reviewer });
    expect(result).toMatchObject({ wait_result: "condition_met", matched: true });
  });

  it("reviews each target concurrently with bounded transcript deltas", async () => {
    const requests: Array<{ targetId: string; metadata: Record<string, unknown>; transcriptDelta: string[]; signal: AbortSignal }> = [];
    let readCount = 0;
    const cli: WaitCli = {
      async runJson(argv) {
        if (argv[0] === "pane" && argv[1] === "current") return currentPane();
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
    expect(result).toMatchObject({ wait_result: "timed_out", matched: false, reviewerSummaries: expect.any(Array) });
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
    expect(result).toMatchObject({ wait_result: "manager_judgment_required", matched: false, reason: "manager_judgment_required" });
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
    expect(matches({ ...base, metadata: { agent_status: "working" } }, { kind: "state", state: "started" })).toBe(true);
    expect(matches({ ...base, metadata: {} }, { kind: "state", state: "unknown" })).toBe(true);
    expect(matches({ ...base, recentUnwrappedLines: ["literal only"] }, { kind: "output", match: { kind: "literal", value: ".*" } })).toBe(false);
    const wrappedToken = { ...base, recentUnwrappedLines: [" REVIEW_P", " ROGRESS_", " DONE"] };
    expect(matches(wrappedToken, { kind: "output", match: { kind: "literal", value: "REVIEW_PROGRESS_DONE" } })).toBe(true);
    expect(matches(wrappedToken, { kind: "output", match: { kind: "regex", value: "REVIEW_PROGRESS_D(?:ONE)" } })).toBe(true);
    expect(matches(wrappedToken, { kind: "output", match: { kind: "literal", value: "REVIEW PROGRESS DONE" } })).toBe(false);
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
    const ambiguousSnapshot = { ...snapshot, snapshot: { ...snapshot.snapshot, panes: [...snapshot.snapshot.panes, { ...snapshot.snapshot.panes[1], pane_id: "p3", label: "same", agent_name: "same", agent_status: "idle" }], agents: [...snapshot.snapshot.agents, { pane_id: "p3", name: "same", agent_status: "idle" }] } };
    const alternateCli: WaitCli = { async runJson(argv) { if (argv[0] === "pane" && argv[1] === "current") return currentPane(); if (argv[0] === "api") return { id: "snapshot", result: ambiguousSnapshot }; return { id: "pane", result: { pane: ambiguousSnapshot.snapshot.panes.find((pane) => pane.pane_id === argv[2]) } }; }, async runText() { return ""; } };
    await expect(execute(alternateCli, { targets: ["same"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 }, { clock: clock() })).resolves.toMatchObject({ wait_result: "condition_met" });
    const trulyAmbiguous = { ...ambiguousSnapshot, snapshot: { ...ambiguousSnapshot.snapshot, panes: [...ambiguousSnapshot.snapshot.panes.map((pane) => pane.pane_id === "p3" ? { ...pane, agent_name: "same2" } : pane), { ...ambiguousSnapshot.snapshot.panes[0], pane_id: "p4", label: "same", agent_name: "other" }], agents: [...ambiguousSnapshot.snapshot.agents.map((agent) => agent.pane_id === "p3" ? { ...agent, name: "same2" } : agent), { pane_id: "p4", name: "other", agent_status: "idle" }] } };
    const trulyAmbiguousCli: WaitCli = { async runJson(argv) { if (argv[0] === "pane" && argv[1] === "current") return currentPane(); if (argv[0] === "api") return { id: "snapshot", result: trulyAmbiguous }; return { id: "pane", result: { pane: trulyAmbiguous.snapshot.panes[0] } }; }, async runText() { return ""; } };
    await expect(execute(trulyAmbiguousCli, { targets: ["same"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 })).rejects.toMatchObject({ code: "TARGET_AMBIGUOUS" });
    await expect(execute(cli, { targets: ["w:t"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 })).rejects.toMatchObject({ code: "TARGET_TYPE_MISMATCH" });
    await expect(createWaitTool({ cli, context: {} as typeof context, settingsLoader: async () => settings, jobRegistry: new JobRegistry() }).execute("id", { targets: ["current"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 } as never, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "CONTEXT_UNAVAILABLE" });
    const settingsError = Object.assign(new Error("bad config"), { code: "INVALID_SETTINGS" });
    await expect(execute(cli, { targets: ["p1"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 }, { settingsLoader: async () => { throw settingsError; } })).rejects.toBe(settingsError);
    await expect(execute(cli, { targets: ["p1"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 }, { settingsLoader: async () => { throw "bad config"; } })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(execute(cli, { targets: ["p1"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 }, { settingsLoader: async () => { throw new Error("settings down"); } })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const defaultLoader = createWaitTool({ cli, context, clock: clock(), jobRegistry: new JobRegistry() });
    await expect(defaultLoader.execute("id", { targets: ["p1"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 } as never, undefined, undefined, extensionContext)).resolves.toMatchObject({ details: { operation_phase: "accepted" } });
    const reviewerError: WaitReviewer = { review: async () => { throw new Error("model down"); } };
    await expect(execute(fakeCli({ p1: "working" }), { targets: ["p1"], match: "all", condition: { kind: "state", state: "done" }, timeoutMs: 60_001 }, { clock: clock(), pollIntervalMs: 100_000, reviewerFactory: () => reviewerError })).rejects.toMatchObject({ code: "REVIEWER_FAILED", details: { cause: "model down" } });
    await expect(execute(fakeCli({ p1: "working" }), { targets: ["p1"], match: "all", condition: { kind: "state", state: "done" }, timeoutMs: 60_001 }, { clock: clock(), pollIntervalMs: 100_000 })).rejects.toMatchObject({ code: "REVIEWER_FAILED" });
  });

  it("returns timeout when review supervision itself reaches the deadline", async () => {
    let now = 0;
    const reviewer: WaitReviewer = { review: async () => { now = 60_001; return { targetId: "p1", classification: "blocked", summary: "deadline" }; } };
    const result = await execute(fakeCli({ p1: "working" }), { targets: ["p1"], match: "all", condition: { kind: "state", state: "done" }, timeoutMs: 60_001 }, { clock: { now: () => now, sleep: async (milliseconds) => { now += milliseconds; } }, pollIntervalMs: 60_000, reviewerFactory: () => reviewer });
    expect(result).toMatchObject({ wait_result: "timed_out", matched: false, reason: "timeout" });
  });

  it("returns timeout when the reviewer refresh read reaches the deadline", async () => {
    let now = 0;
    let paneReads = 0;
    const cli: WaitCli = {
      async runJson(argv) {
        if (argv[0] === "pane" && argv[1] === "current") return currentPane();
        if (argv[0] === "api") return { id: "snapshot", result: snapshot };
        paneReads += 1;
        if (paneReads > 2) now = 60_001;
        return { id: "pane", result: { pane: { ...snapshot.snapshot.panes[0], agent_status: "working" } } };
      },
      async runText() { return ""; }
    };
    const reviewer: WaitReviewer = { review: async ({ targetId }) => ({ targetId, classification: "blocked", summary: "refresh deadline" }) };
    const result = await execute(cli, { targets: ["p1"], match: "all", condition: { kind: "state", state: "done" }, timeoutMs: 60_001 }, { clock: { now: () => now, sleep: async (milliseconds) => { now += milliseconds; } }, pollIntervalMs: 60_000, reviewerFactory: () => reviewer });
    expect(result).toMatchObject({ wait_result: "timed_out", matched: false, reason: "timeout" });
  });

  it("preserves an unknown reviewer target in the manager summary", async () => {
    const reviewer: WaitReviewer = { review: async () => ({ targetId: "external", classification: "blocked", summary: "attention" }) };
    const result = await execute(fakeCli({ p1: "working" }), { targets: ["p1"], match: "all", condition: { kind: "state", state: "done" }, timeoutMs: 60_001 }, { clock: clock(), pollIntervalMs: 100_000, reviewerFactory: () => reviewer });
    expect((result as { reviewerSummaries?: Array<{ target?: string }> }).reviewerSummaries?.[0]?.target).toBe("external");
  });

  it("detaches short waits, preserves job progress, and renders the detached acknowledgement", async () => {
    let reads = 0;
    const cli: WaitCli & { calls: string[][] } = {
      calls: [],
      async runJson(argv) {
        this.calls.push(argv);
        if (argv[0] === "pane" && argv[1] === "current") return currentPane();
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
    const registry = new JobRegistry({ idFactory: () => "job_render" });
    const updates = vi.fn(() => { throw new Error("initiating progress must not be called"); });
    const tool = createWaitTool({ cli, context, settingsLoader: async () => settings, jobRegistry: registry, clock: clock(), pollIntervalMs: 1 });
    const started = await tool.execute("id", { targets: ["p1"], match: "any", condition: { kind: "output", match: { kind: "literal", value: "matched" } }, timeoutMs: 10 } as never, new AbortController().signal, updates, extensionContext);
    expect(started.details).toMatchObject({ operation_phase: "accepted", jobId: "job_render" });
    await vi.waitFor(() => expect(registry.get("job_render")).toMatchObject({ operation_phase: "settled", wait_result: "condition_met", progress: { text: expect.any(String), details: expect.anything() } }));
    const jobDetail = await createJobsTool(registry).execute("id", { operation: "get", jobId: "job_render" } as never, undefined, undefined, extensionContext);
    expect(jobDetail.details).toMatchObject({ operation: "jobs", kind: "job", operation_phase: "settled", wait_result: "condition_met", result: { wait_result: "condition_met", reason: "condition_met" } });
    expect(updates).not.toHaveBeenCalled();
    expect(cli.calls.filter((call) => call[1] === "read").length).toBeGreaterThan(1);
    const call = tool.renderCall?.({ targets: ["p1"], match: "any" } as never, {} as never, {} as never);
    expect(call?.render(80)).toEqual(["herdr_wait · any · p1"]);
    call?.invalidate();
    const defaultCall = tool.renderCall?.({} as never, {} as never, {} as never);
    expect(defaultCall?.render(80)).toEqual(["herdr_wait · wait"]);
    defaultCall?.invalidate();
    const labeledCall = tool.renderCall?.({ targets: ["p1"], label: "release gate" } as never, {} as never, {} as never);
    expect(labeledCall?.render(80)).toEqual(["herdr_wait · wait · release gate · p1"]);
    labeledCall?.invalidate();
    const rendered = tool.renderResult?.(started as never, { expanded: false, isPartial: false } as never, {} as never, {} as never);
    expect(rendered?.render(80)).toEqual(["accepted · job_render · one → contains \"matched\""]);
    rendered?.invalidate();
    const emptyRendered = tool.renderResult?.({ content: [], isError: true } as never, {} as never, {} as never, {} as never);
    expect(emptyRendered?.render(80)).toEqual(["error UNKNOWN"]);
    emptyRendered?.invalidate();
  });

  it("returns the final authoritative timeout branch when the deadline is observed before sleeping", async () => {
    const cli = fakeCli({ p1: "not done" });
    let nowCalls = 0;
    const final = await execute(cli, { targets: ["p1"], match: "any", condition: { kind: "output", match: { kind: "literal", value: "missing" } }, timeoutMs: 1 }, { clock: { now: () => nowCalls++ === 0 ? 0 : 2, sleep: async () => undefined } });
    expect(final).toMatchObject({ wait_result: "timed_out", matched: false, reason: "timeout" });
  });

  it("does not accept a read that completes after the deadline", async () => {
    let now = 0;
    const cli: WaitCli = {
      async runJson(argv) {
        if (argv[0] === "pane" && argv[1] === "current") return currentPane();
        if (argv[0] === "api") return { id: "snapshot", result: snapshot };
        now = 2;
        return { id: "pane", result: { pane: { ...snapshot.snapshot.panes[0], agent_status: "idle" } } };
      },
      async runText() { return ""; }
    };
    const result = await execute(cli, { targets: ["p1"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 }, { clock: { now: () => now, sleep: async () => undefined } });
    expect(result).toMatchObject({ wait_result: "timed_out", matched: false, reason: "timeout" });
  });

  it("rejects a match if the deadline passes while evaluating the read", async () => {
    let calls = 0;
    const result = await execute(fakeCli(), { targets: ["p1"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 }, { clock: { now: () => ++calls === 4 ? 2 : 0, sleep: async () => undefined } });
    expect(result).toMatchObject({ wait_result: "timed_out", matched: false, reason: "timeout" });
  });

  it("returns a timeout when a polling read finishes after the deadline", async () => {
    let paneReads = 0;
    let now = 0;
    const cli: WaitCli = {
      async runJson(argv) {
        if (argv[0] === "pane" && argv[1] === "current") return currentPane();
        if (argv[0] === "api") return { id: "snapshot", result: snapshot };
        paneReads += 1;
        if (paneReads > 1) now = 2;
        return { id: "pane", result: { pane: { ...snapshot.snapshot.panes[0], agent_status: "working" } } };
      },
      async runText() { return ""; }
    };
    const result = await execute(cli, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: { now: () => now, sleep: async () => undefined } });
    expect(result).toMatchObject({ wait_result: "timed_out", matched: false, reason: "timeout" });
  });

  it("checks the deadline before starting another poll", async () => {
    let calls = 0;
    const result = await execute(fakeCli({ p1: "not yet" }), { targets: ["p1"], match: "any", condition: { kind: "output", match: { kind: "literal", value: "done" } }, timeoutMs: 1 }, { clock: { now: () => ++calls > 4 ? 2 : 0, sleep: async () => undefined } });
    expect(result).toMatchObject({ wait_result: "timed_out", matched: false, reason: "timeout" });
  });

  it("covers deadline final reads and polling continuation", async () => {
    let calls = 0;
    const deadlineClock: WaitClock = { now: () => ++calls > 1 ? 2 : 0, sleep: async () => undefined };
    let paneReads = 0;
    const finalCli: WaitCli = { async runJson(argv) { if (argv[0] === "pane" && argv[1] === "current") return currentPane(); if (argv[0] === "api") return { id: "snapshot", result: snapshot }; paneReads += 1; return { id: "pane", result: { pane: { ...snapshot.snapshot.panes[0], agent_status: paneReads > 1 ? "idle" : "working" } } }; }, async runText() { return ""; } };
    const finalMatch = await execute(finalCli, { targets: ["p1"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 }, { clock: deadlineClock });
    expect(finalMatch).toMatchObject({ wait_result: "timed_out", matched: false, reason: "timeout" });
    let finalNow = 0;
    const finalTimeout = await execute(fakeCli({ p1: "not done" }), { targets: ["p1"], match: "any", condition: { kind: "output", match: { kind: "literal", value: "missing" } }, timeoutMs: 1 }, { clock: { now: () => finalNow, sleep: async () => { finalNow = 2; } } });
    expect(finalTimeout).toMatchObject({ wait_result: "timed_out", matched: false, reason: "timeout" });
    const noMatch = await execute(fakeCli({ p1: "not done" }), { targets: ["p1"], match: "any", condition: { kind: "output", match: { kind: "literal", value: "missing" } }, timeoutMs: 2 }, { clock: clock(), pollIntervalMs: 1 });
    expect(noMatch).toMatchObject({ wait_result: "timed_out", reason: "timeout" });
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

  it("maps a generic read failure to a structured wait error", async () => {
    const rejected: WaitCli = {
      async runJson(argv) {
        if (argv[0] === "pane" && argv[1] === "current") return currentPane();
        if (argv[0] === "api") return { id: "snapshot", result: snapshot };
        throw new Error("backend down");
      },
      async runText() { return ""; }
    };
    await expect(execute(rejected, { targets: ["p1"], match: "all", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: clock() })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    const stringRejected: WaitCli = { async runJson(argv) { if (argv[0] === "pane" && argv[1] === "current") return currentPane(); if (argv[0] === "api") return { id: "snapshot", result: snapshot }; throw "backend down"; }, async runText() { return ""; } };
    await expect(execute(stringRejected, { targets: ["p1"], match: "all", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: clock() })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
  });

  it("preserves read failures as truthful structured errors", async () => {
    const paneFallback: WaitCli = {
      async runJson(argv) {
        if (argv[0] === "pane" && argv[1] === "current") return currentPane();
        if (argv[0] === "api") return { id: "snapshot", result: snapshot };
        return { id: "pane", result: {} };
      },
      async runText() { return ""; }
    };
    await expect(execute(paneFallback, { targets: ["p1"], match: "any", condition: { kind: "state", state: "unknown" }, timeoutMs: 1 }, { clock: clock() })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    const malformed: WaitCli = {
      async runJson(argv) {
        if (argv[0] === "pane" && argv[1] === "current") return currentPane();
        if (argv[0] === "api") return { id: "snapshot", result: snapshot };
        return { id: "pane", result: null };
      },
      async runText() { return ""; }
    };
    await expect(execute(malformed, { targets: ["p1"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 }, { clock: clock() })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    const rejected: WaitCli = {
      async runJson(argv) {
        if (argv[0] === "pane" && argv[1] === "current") return currentPane();
        if (argv[0] === "api") return { id: "snapshot", result: snapshot };
        throw new Error("backend down");
      },
      async runText() { return ""; }
    };
    await expect(execute(rejected, { targets: ["p1"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 }, { clock: clock() })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    const aborted: WaitCli = {
      async runJson(argv) {
        if (argv[0] === "pane" && argv[1] === "current") return currentPane();
        if (argv[0] === "api") return { id: "snapshot", result: snapshot };
        throw Object.assign(new Error("aborted"), { code: "ABORTED" });
      },
      async runText() { return ""; }
    };
    await expect(execute(aborted, { targets: ["p1"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 }, { clock: clock() })).rejects.toMatchObject({ code: "ABORTED" });
    const throwingSettings = await execute(fakeCli(), { targets: ["p1"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 }, { clock: clock() });
    expect(throwingSettings.wait_result).toBe("condition_met");
  });

  it("cannot finish after cancellation while a reviewer is pending", async () => {
    const controller = new AbortController();
    let entered = false;
    const reviewer: WaitReviewer = { review: async (_request, signal) => new Promise((_resolve, reject) => {
      entered = true;
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { code: "ABORTED" })), { once: true });
      controller.abort();
    }) };
    const deps = { cli: fakeCli({ p1: "working" }), context, settingsLoader: async () => settings, jobRegistry: new JobRegistry(), clock: clock(), pollIntervalMs: 100_000, reviewerFactory: () => reviewer } as Parameters<typeof prepareWait>[0];
    const prepared = await prepareWait(deps, { targets: ["p1"], match: "all", condition: { kind: "state", state: "done" }, timeoutMs: 60_001 }, new AbortController().signal);
    await expect(runPreparedWait(deps, prepared, controller.signal, () => undefined, extensionContext)).rejects.toMatchObject({ code: "ABORTED" });
    expect(entered).toBe(true);
  });

  it("matches a real output line equal to the truncation marker", async () => {
    const cli = fakeCli({ p1: "actual output" });
    cli.runTextResult = async () => ({ value: "actual output\n[output truncated]", truncated: true });
    const result = await execute(cli, { targets: ["p1"], match: "any", condition: { kind: "output", match: { kind: "literal", value: "[output truncated]" } }, timeoutMs: 1 }, { clock: clock(), pollIntervalMs: 1 });
    expect(result).toMatchObject({
      wait_result: "condition_met",
      matched: true,
      targets: [{ recentUnwrappedLines: ["actual output", "[output truncated]"], outputTruncated: true, matched: true }]
    });
  });

  it("does not match a synthetic truncation marker", async () => {
    const cli = fakeCli({ p1: "actual output" });
    cli.runText = async () => "actual output\n[output truncated]";
    cli.runTextResult = async () => ({ value: "actual output", truncated: true });
    const result = await execute(cli, { targets: ["p1"], match: "any", condition: { kind: "output", match: { kind: "literal", value: "[output truncated]" } }, timeoutMs: 1 }, { clock: clock(), pollIntervalMs: 1 });
    expect(result).toMatchObject({ wait_result: "timed_out", matched: false, reason: "timeout", targets: [{ recentUnwrappedLines: ["actual output"], outputTruncated: true }] });
  });

  it("returns timeout snapshots and keeps abort distinct from timeout", async () => {
    const result = await execute(fakeCli({ p1: "no match" }), { targets: ["p1"], match: "any", condition: { kind: "output", match: { kind: "literal", value: "missing" } }, timeoutMs: 1 }, { clock: clock(), pollIntervalMs: 1 });
    expect(result).toMatchObject({ wait_result: "timed_out", matched: false, reason: "timeout", targets: [{ targetId: "p1", matched: false }] });
    const controller = new AbortController();
    const pending: WaitClock = { now: () => 0, sleep: async (_ms, signal) => { signal.addEventListener("abort", () => undefined); controller.abort(); throw Object.assign(new Error("cancel"), { code: "ABORTED" }); } };
    const registry = new JobRegistry({ idFactory: () => "job_abort" });
    const tool = createWaitTool({ cli: fakeCli(), context, settingsLoader: async () => settings, jobRegistry: registry, clock: pending });
    const started = await tool.execute("id", { targets: ["p2"], match: "all", condition: { kind: "state", state: "done" }, timeoutMs: 1 } as never, controller.signal, undefined, extensionContext);
    expect(started.details).toMatchObject({ operation_phase: "accepted", jobId: "job_abort" });
    await vi.waitFor(() => expect(registry.get("job_abort")).toMatchObject({ operation_phase: "settled", wait_result: "failed", error: { code: "ABORTED" } }));
  });

  it("derives bounded effective labels from resolved targets and conditions", async () => {
    const state = await prepareWait({ cli: fakeCli(), context, settingsLoader: async () => settings, jobRegistry: new JobRegistry() }, { targets: ["p1", "p2"], match: "all", condition: { kind: "state", state: "completed" }, timeoutMs: 1 }, new AbortController().signal);
    expect(state.label).toBe("one +1 → completed");
    expect(deriveWaitLabel({ ...state.params, label: undefined, condition: { kind: "output", match: { kind: "literal", value: "done\nnow" } } }, state.resolved)).toBe('one +1 → contains "done now"');
    expect(deriveWaitLabel({ ...state.params, label: undefined, condition: { kind: "output", match: { kind: "regex", value: "done.*" } } }, state.resolved)).toBe("one +1 → matches /done.*/");
    expect(deriveWaitLabel({ ...state.params, label: "release gate" }, state.resolved)).toBe("release gate");
    const paneLabelOnly = [{ ...state.resolved[0]!, target: { ...state.resolved[0]!.target, agentName: undefined, label: "pane one" } }];
    expect(deriveWaitLabel({ ...state.params, label: undefined }, paneLabelOnly)).toBe("pane one → completed");
    const refOnly = [{ ...state.resolved[0]!, target: { ...state.resolved[0]!.target, agentName: undefined, label: undefined } }];
    expect(deriveWaitLabel({ ...state.params, label: undefined }, refOnly)).toBe("p1 → completed");
    expect(() => deriveWaitLabel({ ...state.params, label: undefined }, [])).toThrowError(/resolved target/);
    expect(deriveWaitLabel({ ...state.params, label: undefined, condition: { kind: "output", match: { kind: "literal", value: "x".repeat(1_000) } } }, state.resolved).length).toBeLessThanOrEqual(120);
  });

  it("uses the default settings loader during direct preflight", async () => {
    const prepared = await prepareWait({ cli: fakeCli(), context, jobRegistry: new JobRegistry() }, { targets: ["p1"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 }, new AbortController().signal);
    expect(prepared.params.targets).toEqual(["p1"]);
    expect(prepared.settings.reviewerThinking).toBe("low");
  });

  it("detaches a wait at exactly the review cadence without reviewer supervision", async () => {
    const registry = new JobRegistry({ idFactory: () => "job_exact_cadence" });
    const reviewerFactory = vi.fn(() => { throw new Error("exact-cadence waits must not start review supervision"); });
    const tool = createWaitTool({ cli: fakeCli({ p1: "working" }), context, settingsLoader: async () => settings, jobRegistry: registry, clock: clock(), pollIntervalMs: 100_000, reviewerFactory });
    const started = await tool.execute("id", { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 60_000 } as never, new AbortController().signal, undefined, extensionContext);
    expect(started.details).toMatchObject({ operation_phase: "accepted", jobId: "job_exact_cadence" });
    await vi.waitFor(() => expect(registry.get("job_exact_cadence")).toMatchObject({ operation_phase: "settled", wait_result: "timed_out" }));
    expect(reviewerFactory).not.toHaveBeenCalled();
  });

  it("detaches long waits while retaining the watcher model", async () => {
    const registry = new JobRegistry({ idFactory: () => "job_auto_background" });
    const reviewed: string[] = [];
    const tool = createWaitTool({
      cli: fakeCli({ p1: "working" }),
      context,
      settingsLoader: async () => settings,
      jobRegistry: registry,
      clock: clock(),
      pollIntervalMs: 100_000,
      reviewerFactory: () => ({ review: async ({ targetId }) => { reviewed.push(targetId); return { targetId, classification: "progress", summary: "still progressing" }; } })
    });
    const started = await tool.execute("id", { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 60_001 } as never, new AbortController().signal, undefined, extensionContext);
    expect(started.details).toMatchObject({ operation_phase: "accepted", jobId: "job_auto_background" });
    for (let index = 0; index < 10; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(reviewed).toEqual(["p1"]);
    expect(registry.get("job_auto_background")).toMatchObject({ operation_phase: "settled", wait_result: "timed_out", result: { reviewerSummaries: [{ targetId: "p1", classification: "progress" }] } });
  });

  it("preflights background waits before creating an ID and rejects stale sessions", async () => {
    const registry = new JobRegistry({ idFactory: () => "job_preflight" });
    const tool = createWaitTool({ cli: fakeCli(), context, settingsLoader: async () => settings, jobRegistry: registry, clock: clock() });
    await expect(tool.execute("id", { targets: ["missing"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 10 } as never, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });
    expect(registry.size()).toBe(0);
    const staleGeneration = registry.captureGeneration();
    const staleTool = createWaitTool({ cli: fakeCli(), context, settingsLoader: async () => { registry.beginSession(); return settings; }, jobRegistry: registry });
    await expect(staleTool.execute("id", { targets: ["p1"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 10 } as never, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "SESSION_REPLACED" });
    expect(registry.isCurrent(staleGeneration)).toBe(false);
    const invalid = createWaitTool({ cli: fakeCli(), context, settingsLoader: async () => settings, jobRegistry: registry });
    await expect(invalid.execute("id", { targets: ["p1"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 10, snake_case: true } as never, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(registry.size()).toBe(0);
  });

  it("rejects cancellation during final context resolution before registering a job", async () => {
    const registry = new JobRegistry({ idFactory: () => "job_boundary" });
    const controller = new AbortController();
    let resolved = false;
    const tool = createWaitTool({
      cli: fakeCli(),
      context,
      settingsLoader: async () => settings,
      jobRegistry: registry,
      contextResolver: async () => {
        await Promise.resolve();
        controller.abort();
        resolved = true;
        return {
          context,
          snapshot: snapshot.snapshot,
          diagnostics: { injected: context, effective: context, rebound: false, attempts: 1 },
          operationIds: { current: "current", snapshot: "snapshot" }
        };
      }
    });
    await expect(tool.execute("id", { targets: ["p1"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 } as never, controller.signal, undefined, extensionContext)).rejects.toMatchObject({ code: "ABORTED" });
    expect(resolved).toBe(true);
    expect(registry.size()).toBe(0);
  });

  it("runs background waits on a fresh signal without the initiating update callback", async () => {
    const registry = new JobRegistry({ idFactory: () => "job_background" });
    const entered: AbortSignal[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const cli: WaitCli = {
      async runJson(argv, signal) {
        entered.push(signal);
        if (argv[0] === "pane" && argv[1] === "current") return currentPane();
        if (argv[0] === "api") return { id: "snapshot", result: snapshot };
        await gate;
        return { id: "pane", result: { pane: snapshot.snapshot.panes[0] } };
      },
      async runText(_argv, signal) { entered.push(signal); await gate; return "done"; }
    };
    const initiating = new AbortController();
    const updates = vi.fn(() => { throw new Error("initiating update used"); });
    const tool = createWaitTool({ cli, context, settingsLoader: async () => settings, jobRegistry: registry, clock: clock() });
    const started = await tool.execute("id", { targets: ["p1"], match: "any", condition: { kind: "output", match: { kind: "literal", value: "done" } }, timeoutMs: 100 } as never, initiating.signal, updates, extensionContext);
    expect(started).toMatchObject({ content: [{ type: "text", text: "wait accepted · one → contains \"done\" · job_background" }], details: { operation: "wait", operation_phase: "accepted", jobId: "job_background", label: "one → contains \"done\"", targets: ["p1"], targetIds: ["p1"] } });
    const backgroundRendered = tool.renderResult?.(started as never, { expanded: false, isPartial: false }, {} as never, {} as never);
    expect(backgroundRendered?.render(80)).toEqual(["accepted · job_background · one → contains \"done\""]);
    backgroundRendered?.invalidate();
    initiating.abort();
    release();
    for (let index = 0; index < 10; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(registry.get("job_background")).toMatchObject({ operation_phase: "settled", wait_result: "condition_met" });
    expect(updates).not.toHaveBeenCalled();
    expect(entered.length).toBeGreaterThan(0);
    expect(entered.slice(2).every((signal) => signal !== initiating.signal)).toBe(true);
  });

  it.each([
    ["condition_met", "done", { kind: "state", state: "completed" }, "condition_met"],
    ["timed_out", "working", { kind: "state", state: "done" }, "timed_out"]
  ] as const)("maps detached %s wait results", async (_name, output, condition, expected) => {
    const registry = new JobRegistry({ idFactory: () => `job_${expected}` });
    const tool = createWaitTool({ cli: fakeCli({ p1: output }), context, settingsLoader: async () => settings, jobRegistry: registry, clock: clock(), pollIntervalMs: 1 });
    await tool.execute("id", { targets: ["p1"], match: "any", condition, timeoutMs: 1 } as never, new AbortController().signal, undefined, extensionContext);
    for (let index = 0; index < 10; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(registry.get(`job_${expected}`)).toMatchObject({ operation_phase: "settled", wait_result: expected });
  });

  it("records a background runner protocol failure without escaping the tool call", async () => {
    const registry = new JobRegistry({ idFactory: () => "job_runner_failure" });
    const malformedCli: WaitCli = {
      async runJson(argv) {
        if (argv[0] === "pane" && argv[1] === "current") return currentPane();
        if (argv[0] === "api") return { id: "snapshot", result: snapshot };
        return { id: "pane", result: {} };
      },
      async runText() { return ""; }
    };
    const tool = createWaitTool({ cli: malformedCli, context, settingsLoader: async () => settings, jobRegistry: registry, clock: clock() });
    const started = await tool.execute("id", { targets: ["p1"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 } as never, new AbortController().signal, undefined, extensionContext);
    expect(started.details).toMatchObject({ operation_phase: "accepted", jobId: "job_runner_failure" });
    for (let index = 0; index < 10; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(registry.get("job_runner_failure")).toMatchObject({ operation_phase: "settled", wait_result: "failed", error: { code: "CLI_PROTOCOL_ERROR" } });
  });

  it("preserves a maximum-length multibyte label in background details", () => {
    const label = "界".repeat(120);
    const params = { targets: ["p1"], match: "any" as const, condition: { kind: "state" as const, state: "done" as const }, timeoutMs: 1 };
    const details = boundedBackgroundDetails("job_unicode", label, params, ["p1"]);
    expect(details.label).toBe(label);
    expect(details.truncation.labelClipped).toBeUndefined();
  });

  it("reports clipped and omitted values in a background acknowledgement", () => {
    const params = { targets: Array.from({ length: 17 }, (_, index) => `target-${index}-${"t".repeat(2_000)}`), match: "any" as const, condition: { kind: "state" as const, state: "done" as const }, timeoutMs: 1 };
    const targetIds = params.targets.map((_, index) => `pane-${index}-${"p".repeat(2_000)}`);
    const details = boundedBackgroundDetails(`job_${"j".repeat(2_000)}`, "label".repeat(100), params, targetIds);
    expect(details.targets).toHaveLength(16);
    expect(details.targetIds).toHaveLength(16);
    expect(details.truncation).toMatchObject({ targets: 1, targetIds: 1, jobIdClipped: true, labelClipped: true, targetsClipped: 16, targetIdsClipped: 16 });
    expect(JSON.stringify(details).length).toBeLessThan(50_000);
  });

  it("maps background reviewer failure and manager judgment", async () => {
    const failureRegistry = new JobRegistry({ idFactory: () => "job_failure_bg" });
    const failing: WaitReviewer = { review: async () => { throw new Error("review down"); } };
    const failingTool = createWaitTool({ cli: fakeCli({ p1: "working" }), context, settingsLoader: async () => settings, jobRegistry: failureRegistry, clock: clock(), pollIntervalMs: 100_000, reviewerFactory: () => failing });
    await failingTool.execute("id", { targets: ["p1"], match: "all", condition: { kind: "state", state: "done" }, timeoutMs: 60_001 } as never, new AbortController().signal, undefined, extensionContext);
    for (let index = 0; index < 10; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(failureRegistry.get("job_failure_bg")).toMatchObject({ operation_phase: "settled", wait_result: "failed", error: { code: "REVIEWER_FAILED" } });
    const managerRegistry = new JobRegistry({ idFactory: () => "job_manager_bg" });
    const managerTool = createWaitTool({ cli: fakeCli({ p1: "working" }), context, settingsLoader: async () => settings, jobRegistry: managerRegistry, clock: clock(), pollIntervalMs: 100_000, reviewerFactory: () => ({ review: async ({ targetId }) => ({ targetId, classification: "blocked", summary: "manual" }) }) });
    await managerTool.execute("id", { targets: ["p1"], match: "all", condition: { kind: "state", state: "done" }, timeoutMs: 60_001 } as never, new AbortController().signal, undefined, extensionContext);
    for (let index = 0; index < 10; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(managerRegistry.get("job_manager_bg")).toMatchObject({ operation_phase: "settled", wait_result: "manager_judgment_required" });
  });
});
