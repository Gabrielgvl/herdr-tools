import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { CliProtocolError } from "../../src/cli.js";
import { ReviewerFailure, type ReviewerRequest, type WaitReviewer } from "../../src/reviewer.js";
import { createJobsTool } from "../../src/tools/jobs.js";
import { WaitError, boundedBackgroundDetails, createWaitTool, deriveWaitLabel, errorCode, linkedSignal, matches, matchesState, mapReviewerFailure, boundedLines, compactMetadata, prepareWait, realClock, runPreparedWait, type WaitClock, type WaitCli } from "../../src/tools/wait.js";
import { JobRegistry } from "../../src/job-registry.js";
import { createTargetGenerationRef, historicalTargetEvidence, isTargetEvidence, requireWaitTargetIdentity, sameWaitTargetIdentity } from "../../src/wait-target-evidence.js";
import { deltaLines } from "../../src/transcript-delta.js";

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

function nativeCli(options: { statuses?: Record<string, string>; currentStatuses?: Record<string, string>; complete?: boolean; timeout?: boolean; mismatch?: boolean; fail?: boolean } = {}): WaitCli & { calls: string[][] } {
  const calls: string[][] = [];
  const live = nativeSnapshot(options.statuses);
  const current = nativeSnapshot(options.currentStatuses ?? options.statuses);
  const pane = (paneId: string) => live.snapshot.panes.find((candidate) => candidate.pane_id === paneId)!;
  const currentPane = (paneId: string) => current.snapshot.panes.find((candidate) => candidate.pane_id === paneId)!;
  return {
    calls,
    supportsNativeAgentWait: true,
    async runJson(argv) {
      calls.push(argv);
      if (argv[0] === "pane" && argv[1] === "current") return { id: "current", result: { type: "pane_current", pane: live.snapshot.panes[0] } };
      if (argv[0] === "api") return { id: "snapshot", result: current };
      if (argv[0] === "pane" && argv[1] === "get") return { id: "pane", result: { pane: currentPane(argv[2]!) } };
      if (argv[0] === "agent" && argv[1] === "wait") {
        if (options.timeout) throw Object.assign(new Error("native wait timed out"), { code: "CLI_TIMEOUT" });
        const value = pane(argv[2]!);
        if (options.fail) throw new Error("native wait failed");
        if (options.mismatch) return { id: "wait", result: { agent: { ...value, terminal_id: "replaced-terminal" } } };
        if (options.complete) return { id: "wait", result: { agent: value } };
        return { id: "wait", result: { type: "wait_matched", event: { event: "pane_agent_status_changed", data: { pane_id: value.pane_id, workspace_id: "w", agent_status: value.agent_status } } } };
      }
      if (argv[0] === "agent" && argv[1] === "get") return { id: "agent", result: { agent: currentPane(argv[2]!) } };
      return { id: "pane", result: { pane: currentPane(argv[2]!) } };
    },
    async runText(argv) {
      calls.push(argv);
      return "native output";
    }
  };
}

const context = { workspaceId: "w", tabId: "w:t", paneId: "p1" };
const extensionContext = { modelRegistry: {} } as ExtensionContext;
const settings = { reviewCadenceMinutes: 1, reviewerModel: "luna", reviewerThinking: "max" as const };

function nativePredicateTimeout(): CliProtocolError {
  return new CliProtocolError("CLI_PROTOCOL_ERROR", "timed out waiting for agent status", {
    errorEnvelope: { error: { code: "timeout", message: "timed out waiting for agent status" } }
  });
}

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
      const cli = nativeCli({ statuses: { p1: observed }, currentStatuses: { p1: ["working", "started"].includes(state) ? "idle" : "working" } });
      const result = await execute(cli, { targets: ["p1"], match: "any", condition: { kind: "state", state }, timeoutMs: 1 }, { clock: clock() });
      expect(result).toMatchObject({ wait_result: "condition_met", matched: true, targets: [{ target_evidence: { source: "native_agent_wait", currency: "historical_non_current" } }] });
      expect(cli.calls.some((call) => call[0] === "agent" && call[1] === "wait")).toBe(true);
      expect(cli.calls.some((call) => call[1] === "read")).toBe(false);
    }
  });

  it("uses the authoritative fresh agent lifecycle state over stale pane state", async () => {
    const cli = nativeCli({ statuses: { p1: "working" }, currentStatuses: { p1: "idle" } });
    const original = cli.runJson.bind(cli);
    cli.runJson = async (argv, signal) => {
      if (argv[0] === "pane" && argv[1] === "get") return { id: "pane", result: { pane: nativeSnapshot({ p1: "idle" }).snapshot.panes[0] } };
      if (argv[0] === "agent" && argv[1] === "get") return { id: "agent", result: { agent: nativeSnapshot({ p1: "working" }).snapshot.agents[0] } };
      return original(argv, signal);
    };
    await expect(execute(cli, { targets: ["p1"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 10 }, { clock: clock() })).resolves.toMatchObject({ wait_result: "timed_out", matched: false });
  });

  it("rejects missing and malformed fresh lifecycle fields", async () => {
    const missingPaneState = nativeCli({ statuses: { p1: "working" }, currentStatuses: { p1: "working" } });
    const missingPaneStateOriginal = missingPaneState.runJson.bind(missingPaneState);
    missingPaneState.runJson = async (argv, signal) => {
      if (argv[0] === "pane" && argv[1] === "get") {
        const pane = { ...nativeSnapshot({ p1: "working" }).snapshot.panes[0] } as Record<string, unknown>;
        delete pane.agent_status;
        return { id: "pane", result: { pane } };
      }
      return missingPaneStateOriginal(argv, signal);
    };
    await expect(execute(missingPaneState, { targets: ["p1"], match: "any", condition: { kind: "state", state: "working" }, timeoutMs: 10 }, { clock: clock() })).resolves.toMatchObject({ wait_result: "condition_met" });

    const malformedPaneState = nativeCli({ statuses: { p1: "working" }, currentStatuses: { p1: "working" } });
    const malformedPaneStateOriginal = malformedPaneState.runJson.bind(malformedPaneState);
    malformedPaneState.runJson = async (argv, signal) => {
      if (argv[0] === "pane" && argv[1] === "get") return { id: "pane", result: { pane: { ...nativeSnapshot({ p1: "working" }).snapshot.panes[0], agent_status: "malformed" } } };
      return malformedPaneStateOriginal(argv, signal);
    };
    await expect(execute(malformedPaneState, { targets: ["p1"], match: "any", condition: { kind: "state", state: "working" }, timeoutMs: 10 }, { clock: clock() })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });

    const missingAgentState = nativeCli({ statuses: { p1: "working" }, currentStatuses: { p1: "working" } });
    const missingAgentStateOriginal = missingAgentState.runJson.bind(missingAgentState);
    missingAgentState.runJson = async (argv, signal) => {
      if (argv[0] === "agent" && argv[1] === "get") {
        const agent = { ...nativeSnapshot({ p1: "working" }).snapshot.agents[0] } as Record<string, unknown>;
        delete agent.agent_status;
        return { id: "agent", result: { agent } };
      }
      return missingAgentStateOriginal(argv, signal);
    };
    await expect(execute(missingAgentState, { targets: ["p1"], match: "any", condition: { kind: "state", state: "working" }, timeoutMs: 10 }, { clock: clock() })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
  });

  it("fresh-checks an already-satisfied state before invoking transition-oriented native wait", async () => {
    const cli = nativeCli({ statuses: { p1: "idle" } });
    const fresh = nativeSnapshot({ p1: "working" });
    let nativeWaitCalls = 0;
    const originalRunJson = cli.runJson.bind(cli);
    cli.runJson = async (argv, signal) => {
      if (argv[0] === "api") return originalRunJson(argv, signal);
      if (argv[0] === "pane" && argv[1] === "get") return { id: "pane", result: { pane: fresh.snapshot.panes.find((pane) => pane.pane_id === argv[2]) } };
      if (argv[0] === "agent" && argv[1] === "get") return { id: "agent", result: { agent: fresh.snapshot.agents.find((agent) => agent.pane_id === argv[2]) } };
      if (argv[0] === "agent" && argv[1] === "wait") {
        nativeWaitCalls += 1;
        return Promise.reject(nativePredicateTimeout());
      }
      return originalRunJson(argv, signal);
    };
    const result = await execute(cli, { targets: ["p1"], match: "any", condition: { kind: "state", state: "working" }, timeoutMs: 1 }, { clock: clock() });
    expect(result).toMatchObject({ wait_result: "condition_met", matched: true, targets: [{ metadata: { agent_status: "working" } }] });
    expect(nativeWaitCalls).toBe(0);
  });

  it("fails closed when the fresh native state identity changes", async () => {
    const cli = nativeCli({ statuses: { p1: "working" }, currentStatuses: { p1: "working" } });
    const replacement = nativeSnapshot({ p1: "working" });
    replacement.snapshot.panes[0] = { ...replacement.snapshot.panes[0]!, terminal_id: "replacement-terminal" } as never;
    replacement.snapshot.agents[0] = { ...replacement.snapshot.agents[0]!, terminal_id: "replacement-terminal" } as never;
    const originalRunJson = cli.runJson.bind(cli);
    cli.runJson = async (argv, signal) => {
      if (argv[0] === "pane" && argv[1] === "get") return { id: "pane", result: { pane: replacement.snapshot.panes[0] } };
      if (argv[0] === "agent" && argv[1] === "get") return { id: "agent", result: { agent: replacement.snapshot.agents[0] } };
      return originalRunJson(argv, signal);
    };
    await expect(execute(cli, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: clock() })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
  });

  it("accepts an already-observed agent-free unknown state and preserves read failures", async () => {
    const absent = nativeCli({ statuses: { p1: "unknown" }, currentStatuses: { p1: "unknown" } });
    const absentRunJson = absent.runJson.bind(absent);
    absent.runJson = async (argv, signal) => argv[0] === "agent" && argv[1] === "get"
      ? Promise.reject(new CliProtocolError("CLI_PROTOCOL_ERROR", "agent not found", { errorEnvelope: { error: { code: "agent_not_found", message: "agent is absent" } } }))
      : absentRunJson(argv, signal);
    await expect(execute(absent, { targets: ["p1"], match: "any", condition: { kind: "state", state: "unknown" }, timeoutMs: 1 }, { clock: clock() })).resolves.toMatchObject({ wait_result: "condition_met", targets: [{ target_evidence: { kind: "agent_absent_observed" } }] });

    const failed = nativeCli({ statuses: { p1: "working" }, currentStatuses: { p1: "working" } });
    const failedRunJson = failed.runJson.bind(failed);
    failed.runJson = async (argv, signal) => argv[0] === "pane" && argv[1] === "get"
      ? Promise.reject(new Error("pane read failed"))
      : failedRunJson(argv, signal);
    await expect(execute(failed, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: clock() })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    const stringFailed = nativeCli({ statuses: { p1: "working" }, currentStatuses: { p1: "working" } });
    const stringFailedRunJson = stringFailed.runJson.bind(stringFailed);
    stringFailed.runJson = async (argv, signal) => argv[0] === "pane" && argv[1] === "get"
      ? Promise.reject("pane read failed")
      : stringFailedRunJson(argv, signal);
    await expect(execute(stringFailed, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: clock() })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
  });

  it("uses native identity evidence, fails closed on replacement, and handles timeout/malformed responses", async () => {
    const incomplete = nativeCli({ statuses: { p1: "done" }, currentStatuses: { p1: "working" } });
    const incompleteResult = await execute(incomplete, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: clock() });
    expect(incompleteResult).toMatchObject({
      wait_result: "condition_met",
      targets: [{ metadata: { pane_id: "p1", tab_id: "w:t", workspace_id: "w", label: "one", agent_name: "one", agent: "pi", agent_status: "done" } }]
    });
    expect(incomplete.calls.map((call) => call.slice(0, 2))).toContainEqual(["agent", "get"]);

    const sparse = nativeSnapshot({ p1: "working" });
    delete (sparse.snapshot.panes[0] as Record<string, unknown>).label;
    delete (sparse.snapshot.panes[0] as Record<string, unknown>).agent_name;
    const sparseResult = await execute(nativeCli({ statuses: { p1: "done" }, currentStatuses: { p1: "working" } }), { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 10 }, {
      contextResolver: async () => ({
        context: { workspaceId: "w", tabId: "w:t", paneId: "p1" },
        snapshot: sparse.snapshot,
        diagnostics: { injected: context, effective: context, rebound: false, attempts: 1 },
        operationIds: { current: "current", snapshot: "snapshot" }
      })
    });
    expect(sparseResult).toMatchObject({ wait_result: "condition_met", targets: [{ metadata: { pane_id: "p1", label: "one", agent_name: "one" } }] });

    const mismatch = nativeCli({ statuses: { p1: "done" }, currentStatuses: { p1: "working" }, mismatch: true });
    await expect(execute(mismatch, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: clock() })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    const replacedNative = nativeCli({ statuses: { p1: "done" }, currentStatuses: { p1: "working" } });
    const replacedPane = { ...nativeSnapshot({ p1: "done" }).snapshot.panes[0], terminal_id: "replaced-terminal" };
    const replacedAgent = { ...nativeSnapshot({ p1: "done" }).snapshot.agents[0], terminal_id: "replaced-terminal" };
    const replacedOriginal = replacedNative.runJson.bind(replacedNative);
    let replacedPaneGets = 0;
    let replacedAgentGets = 0;
    replacedNative.runJson = async (argv, signal) => {
      if (argv[0] === "pane" && argv[1] === "get" && ++replacedPaneGets > 1) return { id: "pane", result: { pane: replacedPane } };
      if (argv[0] === "agent" && argv[1] === "get" && ++replacedAgentGets > 1) return { id: "agent", result: { agent: replacedAgent } };
      if (argv[0] === "agent" && argv[1] === "wait") return { id: "wait", result: { type: "wait_matched", event: { event: "pane_agent_status_changed", data: { pane_id: "p1", workspace_id: "w", agent_status: "done" } } } };
      return replacedOriginal(argv, signal);
    };
    await expect(execute(replacedNative, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: clock() })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    const malformed: WaitCli = { ...nativeCli({ statuses: { p1: "done" } }), async runJson(argv) {
      if (argv[0] === "pane" && argv[1] === "current") return currentPane();
      if (argv[0] === "api") return { id: "snapshot", result: nativeSnapshot({ p1: "working" }) };
      if (argv[0] === "agent" && argv[1] === "wait") return { id: "wait", result: { agent: { pane_id: "p1" } } };
      return { id: "agent", result: { agent: nativeSnapshot().snapshot.panes[0] } };
    } };
    await expect(execute(malformed, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: clock() })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    await expect(execute(nativeCli({ timeout: true }), { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: clock() })).rejects.toMatchObject({ code: "CLI_TIMEOUT" });
    const missingNativeAgentState = nativeCli({ statuses: { p1: "done" }, currentStatuses: { p1: "working" } });
    const missingNativeAgentStateOriginal = missingNativeAgentState.runJson.bind(missingNativeAgentState);
    let missingNativeAgentGets = 0;
    missingNativeAgentState.runJson = async (argv, signal) => {
      if (argv[0] === "agent" && argv[1] === "get" && ++missingNativeAgentGets > 1) return { id: "agent", result: { agent: { pane_id: "p1" } } };
      return missingNativeAgentStateOriginal(argv, signal);
    };
    await expect(execute(missingNativeAgentState, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 10 }, { clock: clock() })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });

    const predicateExpired = nativeCli({ statuses: { p1: "working" } });
    const originalPredicateExpired = predicateExpired.runJson.bind(predicateExpired);
    predicateExpired.runJson = async (argv, signal) => argv[0] === "agent" && argv[1] === "wait" ? Promise.reject(nativePredicateTimeout()) : originalPredicateExpired(argv, signal);
    await expect(execute(predicateExpired, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: clock() })).resolves.toMatchObject({ wait_result: "timed_out", matched: false });
    const verificationTimeout = nativeCli({ statuses: { p1: "working" } });
    const originalVerificationTimeout = verificationTimeout.runJson.bind(verificationTimeout);
    verificationTimeout.runJson = async (argv, signal) => argv[0] === "agent" && argv[1] === "get" ? Promise.reject(Object.assign(new Error("agent verification hung"), { code: "CLI_TIMEOUT" })) : originalVerificationTimeout(argv, signal);
    await expect(execute(verificationTimeout, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: clock() })).rejects.toMatchObject({ code: "CLI_TIMEOUT" });
  });

  it("rejects agent-free unknown when the replacement has no session continuity evidence", async () => {
    const noSession = { ...nativeSnapshot({ p1: "unknown" }).snapshot.panes[0] } as Record<string, unknown>;
    for (const field of ["agent_session", "agent_session_source", "agent_session_agent", "agent_session_kind", "agent_session_value", "session_source", "session_agent", "session_kind", "session_value"] as const) delete noSession[field];
    const cli = nativeCli({ statuses: { p1: "unknown" }, currentStatuses: { p1: "working" } });
    const original = cli.runJson.bind(cli);
    cli.runJson = async (argv, signal) => {
      if (argv[0] === "pane" && argv[1] === "get") return { id: "pane", result: { pane: noSession } };
      if (argv[0] === "agent" && argv[1] === "get") return Promise.reject(new CliProtocolError("CLI_PROTOCOL_ERROR", "agent not found", { errorEnvelope: { error: { code: "agent_not_found", message: "agent is absent" } } }));
      return original(argv, signal);
    };
    await expect(execute(cli, { targets: ["p1"], match: "any", condition: { kind: "state", state: "unknown" }, timeoutMs: 10 }, { clock: clock() })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
  });

  it("accepts an agent-free raw unknown transition with historical absence evidence", async () => {
    const cli = nativeCli({ statuses: { p1: "unknown" }, currentStatuses: { p1: "working" } });
    const originalRunJson = cli.runJson.bind(cli);
    let paneGets = 0;
    let agentGets = 0;
    cli.runJson = async (argv, signal) => {
      if (argv[0] === "pane" && argv[1] === "get" && ++paneGets > 1) return { id: "pane", result: { pane: { ...nativeSnapshot({ p1: "unknown" }).snapshot.panes[0], agent_status: "unknown" } } };
      if (argv[0] === "agent" && argv[1] === "get" && ++agentGets > 1) return Promise.reject(new CliProtocolError("CLI_PROTOCOL_ERROR", "agent not found", { errorEnvelope: { error: { code: "agent_not_found", message: "agent is absent" } } }));
      return originalRunJson(argv, signal);
    };
    const result = await execute(cli, { targets: ["p1"], match: "any", condition: { kind: "state", state: "unknown" }, timeoutMs: 1 }, { clock: clock() });
    expect(result).toMatchObject({
      wait_result: "condition_met",
      matched: true,
      targets: [{ metadata: { pane_id: "p1", agent_status: "unknown" }, target_evidence: { kind: "agent_absent_observed", source: "native_agent_wait", currency: "historical_non_current" } }]
    });
    const absentForWorking = nativeCli({ statuses: { p1: "working" }, currentStatuses: { p1: "working" } });
    const absentForWorkingRunJson = absentForWorking.runJson.bind(absentForWorking);
    let absentForWorkingAgentGets = 0;
    absentForWorking.runJson = async (argv, signal) => argv[0] === "agent" && argv[1] === "get" && ++absentForWorkingAgentGets > 1
      ? Promise.resolve({ id: "agent", result: {} })
      : absentForWorkingRunJson(argv, signal);
    await expect(execute(absentForWorking, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: clock() })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
  });

  it("fails closed when an agent-free unknown pane is reused in current and native paths", async () => {
    const absentError = () => new CliProtocolError("CLI_PROTOCOL_ERROR", "agent not found", { errorEnvelope: { error: { code: "agent_not_found", message: "agent is absent" } } });
    const replacementPane = { ...nativeSnapshot({ p1: "unknown" }).snapshot.panes[0] } as Record<string, unknown>;
    replacementPane.terminal_id = "replacement-terminal";
    delete replacementPane.agent_name;
    delete replacementPane.agent;
    delete replacementPane.agent_session;
    delete replacementPane.agent_id;
    const currentPath = nativeCli({ statuses: { p1: "unknown" }, currentStatuses: { p1: "unknown" } });
    const currentOriginal = currentPath.runJson.bind(currentPath);
    currentPath.runJson = async (argv, signal) => {
      if (argv[0] === "pane" && argv[1] === "get") return { id: "pane", result: { pane: replacementPane } };
      if (argv[0] === "agent" && argv[1] === "get") return Promise.reject(absentError());
      return currentOriginal(argv, signal);
    };
    await expect(execute(currentPath, { targets: ["p1"], match: "any", condition: { kind: "state", state: "unknown" }, timeoutMs: 10 }, { clock: clock() })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });

    const nativePath = nativeCli({ statuses: { p1: "unknown" }, currentStatuses: { p1: "working" } });
    const nativeOriginal = nativePath.runJson.bind(nativePath);
    let paneGets = 0;
    let agentGets = 0;
    nativePath.runJson = async (argv, signal) => {
      if (argv[0] === "pane" && argv[1] === "get" && ++paneGets > 1) return { id: "pane", result: { pane: replacementPane } };
      if (argv[0] === "agent" && argv[1] === "get" && ++agentGets > 1) return Promise.reject(absentError());
      return nativeOriginal(argv, signal);
    };
    await expect(execute(nativePath, { targets: ["p1"], match: "any", condition: { kind: "state", state: "unknown" }, timeoutMs: 10 }, { clock: clock() })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });

    const stablePane = { ...nativeSnapshot({ p1: "unknown" }).snapshot.panes[0], agent_id: undefined, agent_process_id: undefined, agent_terminal_id: undefined, agent_session_source: "pi", agent_session_agent: "pi", agent_session_kind: "id", agent_session_value: "p1-session", session_source: "pi", session_agent: "pi", session_kind: "id", session_value: "p1-session", name: "one", agent_kind: "pi", kind: "pi" } as Record<string, unknown>;
    const runAgentFree = async (extra: Record<string, unknown> = {}) => {
      const cli = nativeCli({ statuses: { p1: "unknown" }, currentStatuses: { p1: "unknown" } });
      const original = cli.runJson.bind(cli);
      const pane = { ...stablePane, ...extra };
      cli.runJson = async (argv, signal) => {
        if (argv[0] === "pane" && argv[1] === "get") return { id: "pane", result: { pane } };
        if (argv[0] === "agent" && argv[1] === "get") return Promise.reject(absentError());
        return original(argv, signal);
      };
      return execute(cli, { targets: ["p1"], match: "any", condition: { kind: "state", state: "unknown" }, timeoutMs: 10 }, { clock: clock() });
    };
    await expect(runAgentFree()).resolves.toMatchObject({ wait_result: "condition_met" });
    await expect(runAgentFree({ agent_session: undefined })).resolves.toMatchObject({ wait_result: "condition_met" });
    await expect(runAgentFree({ agent_session: { source: "pi" } })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    await expect(runAgentFree({ agent_session_value: undefined })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    for (const field of ["source", "agent", "kind", "value"] as const) {
      const session = { source: "pi", agent: "pi", kind: "id", value: "p1-session" };
      session[field] = `replacement-${field}`;
      await expect(runAgentFree({ agent_session: session })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    }
    for (const [field, value] of [
      ["agent_id", "replacement-agent"], ["agent_process_id", "replacement-process"], ["agent_terminal_id", "replacement-agent-terminal"],
      ["agent_session", []], ["agent_session", null], ["agent_session_source", "replacement-source"], ["agent_session_agent", "replacement-agent-kind"], ["agent_session_kind", "replacement-kind"], ["agent_session_value", "replacement-session"],
      ["session_source", "replacement-source"], ["session_agent", "replacement-agent-kind"], ["session_kind", "replacement-kind"], ["session_value", "replacement-session"],
      ["agent_name", "replacement-name"], ["name", "replacement-name"], ["agent", "replacement-agent-kind"], ["agent_kind", "replacement-kind"], ["kind", "replacement-kind"]
    ] as const) await expect(runAgentFree({ [field]: value })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
  });

  it("refreshes native predicate-expiry snapshots and fails when refresh cannot be verified", async () => {
    const freshPane = { ...nativeSnapshot({ p1: "working" }).snapshot.panes[0], label: "fresh-label" };
    const cli = nativeCli({ statuses: { p1: "working" }, currentStatuses: { p1: "working" } });
    const originalRunJson = cli.runJson.bind(cli);
    let paneGets = 0;
    cli.runJson = async (argv, signal) => {
      if (argv[0] === "pane" && argv[1] === "get" && ++paneGets > 1) return { id: "pane", result: { pane: freshPane } };
      if (argv[0] === "agent" && argv[1] === "wait") return Promise.reject(nativePredicateTimeout());
      return originalRunJson(argv, signal);
    };
    const result = await execute(cli, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 10 }, { clock: clock() });
    expect(result).toMatchObject({ wait_result: "timed_out", targets: [{ metadata: { label: "fresh-label" }, target_evidence: { source: "composite_observation", currency: "historical_non_current" } }] });

    const broken = nativeCli({ statuses: { p1: "working" }, currentStatuses: { p1: "working" } });
    const brokenOriginal = broken.runJson.bind(broken);
    let brokenPaneGets = 0;
    broken.runJson = async (argv, signal) => {
      if (argv[0] === "pane" && argv[1] === "get" && ++brokenPaneGets > 1) return Promise.reject(new Error("fresh verification failed"));
      if (argv[0] === "agent" && argv[1] === "wait") return Promise.reject(nativePredicateTimeout());
      return brokenOriginal(argv, signal);
    };
    await expect(execute(broken, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 10 }, { clock: clock() })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
  });

  it("rejects a matching native timeout fallback observed at the outer deadline", async () => {
    let now = 0;
    const cli = nativeCli({ statuses: { p1: "working" }, currentStatuses: { p1: "working" } });
    const done = nativeSnapshot({ p1: "done" });
    const original = cli.runJson.bind(cli);
    let timedOut = false;
    cli.runJson = async (argv, signal) => {
      if (argv[0] === "agent" && argv[1] === "wait") {
        timedOut = true;
        now = 10;
        throw nativePredicateTimeout();
      }
      if (timedOut && argv[0] === "pane" && argv[1] === "get") return { id: "pane", result: { pane: done.snapshot.panes[0] } };
      if (timedOut && argv[0] === "agent" && argv[1] === "get") return { id: "agent", result: { agent: done.snapshot.agents[0] } };
      return original(argv, signal);
    };
    await expect(execute(cli, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 10 }, { clock: { now: () => now, sleep: async () => undefined } })).resolves.toMatchObject({ wait_result: "timed_out", matched: false, targets: [{ metadata: { agent_status: "done" }, observedAtMs: 10 }] });

    now = 0;
    let commandTimedOut = false;
    const commandTimeoutCli = nativeCli({ statuses: { p1: "working" }, currentStatuses: { p1: "working" } });
    const commandTimeoutOriginal = commandTimeoutCli.runJson.bind(commandTimeoutCli);
    commandTimeoutCli.runJson = async (argv, signal) => {
      if (argv[0] === "agent" && argv[1] === "wait") {
        commandTimedOut = true;
        now = 10;
        throw Object.assign(new Error("native command timed out"), { code: "CLI_TIMEOUT" });
      }
      if (commandTimedOut && argv[0] === "pane" && argv[1] === "get") return { id: "pane", result: { pane: done.snapshot.panes[0] } };
      if (commandTimedOut && argv[0] === "agent" && argv[1] === "get") return { id: "agent", result: { agent: done.snapshot.agents[0] } };
      return commandTimeoutOriginal(argv, signal);
    };
    await expect(execute(commandTimeoutCli, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 10 }, { clock: { now: () => now, sleep: async () => undefined } })).resolves.toMatchObject({ wait_result: "timed_out", matched: false, targets: [{ metadata: { agent_status: "done" }, observedAtMs: 10 }] });
  });

  it("fails closed on malformed native protocol diagnostics", async () => {
    for (const details of [null, [], { errorEnvelope: null }, { errorEnvelope: [] }, { errorEnvelope: { error: null } }, { errorEnvelope: { error: [] } }, { errorEnvelope: { error: { code: 1 } } }]) {
      const cli = nativeCli({ statuses: { p1: "working" }, currentStatuses: { p1: "working" } });
      const originalRunJson = cli.runJson.bind(cli);
      cli.runJson = async (argv, signal) => argv[0] === "agent" && argv[1] === "wait"
        ? Promise.reject(new CliProtocolError("CLI_PROTOCOL_ERROR", "malformed native diagnostic", details as never))
        : originalRunJson(argv, signal);
      await expect(execute(cli, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: clock() })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    }
  });

  it("accepts native status/state response aliases and rejects a missing state", async () => {
    for (const field of ["status", "state"] as const) {
      const cli = nativeCli({ statuses: { p1: "working" }, currentStatuses: { p1: "working" } });
      const originalRunJson = cli.runJson.bind(cli);
      cli.runJson = async (argv, signal) => {
        if (argv[0] === "agent" && argv[1] === "wait") {
          const agent = { ...nativeSnapshot({ p1: "done" }).snapshot.panes[0] } as Record<string, unknown>;
          delete agent.agent_status;
          agent[field] = "done";
          return { id: "wait", result: { agent } };
        }
        return originalRunJson(argv, signal);
      };
      await expect(execute(cli, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: clock() })).resolves.toMatchObject({ wait_result: "condition_met" });
    }
    const missing = nativeCli({ statuses: { p1: "working" }, currentStatuses: { p1: "working" } });
    const originalMissingRunJson = missing.runJson.bind(missing);
    missing.runJson = async (argv, signal) => {
      if (argv[0] === "agent" && argv[1] === "wait") return { id: "wait", result: { agent: { pane_id: "p1" } } };
      return originalMissingRunJson(argv, signal);
    };
    await expect(execute(missing, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: clock() })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
  });

  it("supports a native wait seam and any/all aggregation without a status read", async () => {
    const base = nativeCli({ statuses: { p1: "working", p2: "done" }, currentStatuses: { p1: "working", p2: "working" } });
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
    const ordered = nativeCli({ statuses: { p1: "working", p2: "done" }, currentStatuses: { p1: "working", p2: "working" } });
    ordered.runNativeAgentWait = async (targetId, _until, _timeoutMs, signal) => {
      if (targetId === "p2") await orderedGate;
      signal.throwIfAborted?.();
      return { result: { agent: nativeSnapshot({ p1: "working", p2: "done" }).snapshot.panes.find((pane) => pane.pane_id === targetId) } };
    };
    const orderedWait = execute(ordered, { targets: ["p1", "p2"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: clock() });
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseOrdered();
    expect(await orderedWait).toMatchObject({ wait_result: "condition_met", matched: true, targets: [expect.objectContaining({ targetId: "p1" }), expect.objectContaining({ targetId: "p2" })] });
    let allNowCalls = 0;
    const all = await execute(nativeCli({ statuses: { p1: "done", p2: "done" }, currentStatuses: { p1: "working", p2: "working" } }), { targets: ["p1", "p2"], match: "all", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: { now: () => allNowCalls++ < 50 ? 0 : 1, sleep: async () => undefined } });
    expect(all).toMatchObject({ wait_result: "condition_met", matched: true });
    await expect(execute(nativeCli({ statuses: { p1: "working" }, timeout: true }), { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: clock() })).rejects.toMatchObject({ code: "CLI_TIMEOUT" });
    const unmatched = await execute(nativeCli({ statuses: { p1: "working" } }), { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: clock() });
    expect(unmatched).toMatchObject({ wait_result: "timed_out", matched: false });
    const unmatchedMany = await execute(nativeCli({ statuses: { p1: "working", p2: "working" } }), { targets: ["p1", "p2"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: clock() });
    expect(unmatchedMany).toMatchObject({ wait_result: "timed_out", matched: false, targets: [expect.objectContaining({ targetId: "p1" }), expect.objectContaining({ targetId: "p2" })] });
    await expect(execute(nativeCli({ statuses: { p1: "working", p2: "working" }, timeout: true }), { targets: ["p1", "p2"], match: "all", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: clock() })).rejects.toMatchObject({ code: "CLI_TIMEOUT" });
    let allDeadlineCalls = 0;
    await expect(execute(nativeCli({ statuses: { p1: "working", p2: "working" }, timeout: true }), { targets: ["p1", "p2"], match: "all", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: { now: () => allDeadlineCalls++ < 10 ? 0 : 1, sleep: async () => undefined } })).rejects.toMatchObject({ code: "CLI_TIMEOUT" });
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
    await expect(execute(badSeam, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: clock() })).resolves.toMatchObject({ wait_result: "timed_out", matched: false });

    const partial = nativeCli({ statuses: { p1: "done" }, currentStatuses: { p1: "working" } });
    partial.runNativeAgentWait = async () => ({ type: "wait_matched", event: { event: "pane_agent_status_changed", data: { pane_id: "p1", workspace_id: "w", agent_status: "done" } } });
    await expect(execute(partial, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 10 }, { clock: clock() })).resolves.toMatchObject({
      wait_result: "condition_met",
      targets: [{ metadata: { pane_id: "p1", tab_id: "w:t", workspace_id: "w", label: "one", agent_name: "one", agent_status: "done" } }]
    });
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
    const atDeadlineCli = nativeCli({ statuses: { p1: "working" }, currentStatuses: { p1: "working" }, complete: true });
    const latestNative = nativeSnapshot({ p1: "done" }).snapshot.panes[0]!;
    const originalAtDeadlineRunJson = atDeadlineCli.runJson.bind(atDeadlineCli);
    atDeadlineCli.runJson = async (argv, signal) => argv[0] === "agent" && argv[1] === "wait"
      ? { id: "wait", result: { agent: latestNative } }
      : originalAtDeadlineRunJson(argv, signal);
    const atDeadline = await execute(atDeadlineCli, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, { clock: { now: () => nowCalls++ < 4 ? 0 : 1, sleep: async () => undefined } });
    expect(atDeadline).toMatchObject({
      wait_result: "timed_out",
      matched: false,
      targets: [{ metadata: { agent_status: "done" }, observedAtMs: 1, target_evidence: { kind: "native_done_observed", currency: "historical_non_current", source: "native_agent_wait" } }]
    });
  });

  it("disposes linked native abort listeners after a native wait settles", async () => {
    const parent = new AbortController();
    const add = vi.spyOn(parent.signal, "addEventListener");
    const remove = vi.spyOn(parent.signal, "removeEventListener");
    const cli = nativeCli({ statuses: { p1: "done" }, currentStatuses: { p1: "working" } });
    const deps = { cli, context, settingsLoader: async () => settings, jobRegistry: new JobRegistry(), clock: clock() } as Parameters<typeof prepareWait>[0];
    const prepared = await prepareWait(deps, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, new AbortController().signal);
    await expect(runPreparedWait(deps, prepared, parent.signal, () => undefined, extensionContext)).resolves.toMatchObject({ wait_result: "condition_met" });
    expect(add.mock.calls.filter(([event]) => event === "abort")).toHaveLength(2);
    expect(remove.mock.calls.filter(([event]) => event === "abort")).toHaveLength(2);
    expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1]);
    expect(remove.mock.calls[1]?.[1]).toBe(add.mock.calls[1]?.[1]);
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    const linked = linkedSignal(alreadyAborted.signal, new AbortController());
    expect(linked.signal.aborted).toBe(true);
    linked.dispose();
    linked.dispose();
  });

  it("fresh-checks native state after reviewer windows before another native wait", async () => {
    let released = false;
    const cli = nativeCli({ statuses: { p1: "working" }, currentStatuses: { p1: "working" } });
    const done = nativeSnapshot({ p1: "done" });
    const originalRunJson = cli.runJson.bind(cli);
    cli.runJson = async (argv, signal) => {
      if (released && argv[0] === "pane" && argv[1] === "get") return { id: "pane", result: { pane: done.snapshot.panes.find((pane) => pane.pane_id === argv[2]) } };
      if (released && argv[0] === "agent" && argv[1] === "get") return { id: "agent", result: { agent: done.snapshot.agents.find((agent) => agent.pane_id === argv[2]) } };
      return originalRunJson(argv, signal);
    };
    const reviewer: WaitReviewer = { review: async ({ targetId }) => { released = true; return { targetId, classification: "progress", summary: "review completed" }; } };
    const result = await execute(cli, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 120_001 }, { clock: clock(), pollIntervalMs: 60_000, reviewerFactory: () => reviewer });
    expect(result).toMatchObject({ wait_result: "condition_met", matched: true });
  });

  it("fresh-checks segmented native waits before invoking the transition predicate", async () => {
    const done = nativeSnapshot({ p1: "done" });
    const cli = nativeCli({ statuses: { p1: "working" }, currentStatuses: { p1: "working" } });
    const originalRunJson = cli.runJson.bind(cli);
    let paneGets = 0;
    cli.runJson = async (argv, signal) => {
      if (argv[0] === "pane" && argv[1] === "get" && ++paneGets > 2) return { id: "pane", result: { pane: done.snapshot.panes[0] } };
      if (argv[0] === "agent" && argv[1] === "get" && paneGets > 2) return { id: "agent", result: { agent: done.snapshot.agents[0] } };
      return originalRunJson(argv, signal);
    };
    const reviewer: WaitReviewer = { review: async ({ targetId }) => ({ targetId, classification: "progress", summary: "not reached" }) };
    await expect(execute(cli, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 120_001 }, { clock: clock(), pollIntervalMs: 60_000, reviewerFactory: () => reviewer })).resolves.toMatchObject({ wait_result: "condition_met", matched: true });

    let now = 0;
    let deadlinePaneGets = 0;
    const deadlineCli = nativeCli({ statuses: { p1: "working" }, currentStatuses: { p1: "working" } });
    const deadlineOriginal = deadlineCli.runJson.bind(deadlineCli);
    deadlineCli.runJson = async (argv, signal) => {
      if (argv[0] === "pane" && argv[1] === "get" && ++deadlinePaneGets === 3) now = 120_001;
      return deadlineOriginal(argv, signal);
    };
    await expect(execute(deadlineCli, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 120_001 }, { clock: { now: () => now, sleep: async (milliseconds) => { now += milliseconds; } }, pollIntervalMs: 60_000, reviewerFactory: () => reviewer })).resolves.toMatchObject({ wait_result: "timed_out", matched: false });
  });

  it("settles timeout from the fresh check after a reviewer refresh reaches the deadline", async () => {
    let now = 0;
    let paneGets = 0;
    const cli = nativeCli({ statuses: { p1: "working" }, currentStatuses: { p1: "working" } });
    const originalRunJson = cli.runJson.bind(cli);
    cli.runJson = async (argv, signal) => {
      if (argv[0] === "pane" && argv[1] === "get" && ++paneGets === 7) now = 120_001;
      return originalRunJson(argv, signal);
    };
    const reviewer: WaitReviewer = { review: async ({ targetId }) => ({ targetId, classification: "progress", summary: "refresh deadline" }) };
    await expect(execute(cli, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 120_001 }, { clock: { now: () => now, sleep: async (milliseconds) => { now += milliseconds; } }, pollIntervalMs: 60_000, reviewerFactory: () => reviewer })).resolves.toMatchObject({ wait_result: "timed_out", matched: false });
  });

  it("settles timeout from the post-review fresh check when review consumes the deadline", async () => {
    let now = 0;
    const cli = nativeCli({ statuses: { p1: "working" }, currentStatuses: { p1: "working" } });
    const reviewer: WaitReviewer = { review: async ({ targetId }) => { now = 120_001; return { targetId, classification: "progress", summary: "review deadline" }; } };
    await expect(execute(cli, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 120_001 }, { clock: { now: () => now, sleep: async (milliseconds) => { now += milliseconds; } }, pollIntervalMs: 60_000, reviewerFactory: () => reviewer })).resolves.toMatchObject({ wait_result: "timed_out", matched: false });
  });

  it("uses a fresh reviewer-window state check before running another native wait", async () => {
    let released = false;
    const cli = nativeCli({ statuses: { p1: "working" }, currentStatuses: { p1: "working" } });
    const done = nativeSnapshot({ p1: "done" });
    const originalRunJson = cli.runJson.bind(cli);
    cli.runJson = async (argv, signal) => {
      if (released && argv[0] === "pane" && argv[1] === "get") return { id: "pane", result: { pane: done.snapshot.panes[0] } };
      if (released && argv[0] === "agent" && argv[1] === "get") return { id: "agent", result: { agent: done.snapshot.agents[0] } };
      return originalRunJson(argv, signal);
    };
    const originalRunText = cli.runText.bind(cli);
    cli.runText = async (...args) => {
      released = true;
      return originalRunText(...args);
    };
    const reviewer: WaitReviewer = { review: async ({ targetId }) => ({ targetId, classification: "progress", summary: "reviewed" }) };
    await expect(execute(cli, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 120_001 }, { clock: clock(), pollIntervalMs: 60_000, reviewerFactory: () => reviewer })).resolves.toMatchObject({ wait_result: "condition_met", matched: true });
  });

  it("fresh-checks manager judgment before the final segmented native wait", async () => {
    const runManagerRefresh = async (mode: "match" | "timeout") => {
      let managerRefresh = false;
      let now = 0;
      const cli = nativeCli({ statuses: { p1: "working" }, currentStatuses: { p1: "working" } });
      const done = nativeSnapshot({ p1: "done" });
      const originalRunJson = cli.runJson.bind(cli);
      cli.runJson = async (argv, signal) => {
        if (managerRefresh && argv[0] === "pane" && argv[1] === "get") {
          if (mode === "timeout") now = 120_001;
          return { id: "pane", result: { pane: mode === "match" ? done.snapshot.panes[0] : nativeSnapshot({ p1: "working" }).snapshot.panes[0] } };
        }
        if (managerRefresh && argv[0] === "agent" && argv[1] === "get" && mode === "match") return { id: "agent", result: { agent: done.snapshot.agents[0] } };
        return originalRunJson(argv, signal);
      };
      const reviewer: WaitReviewer = { review: async ({ targetId }) => ({ targetId, classification: "blocked", summary: "manager judgment" }) };
      const deps = { cli, context, settingsLoader: async () => settings, jobRegistry: new JobRegistry(), clock: { now: () => now, sleep: async (milliseconds: number) => { now += milliseconds; } }, pollIntervalMs: 60_000, reviewerFactory: () => reviewer } as Parameters<typeof prepareWait>[0];
      const prepared = await prepareWait(deps, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 120_001 }, new AbortController().signal);
      return runPreparedWait(deps, prepared, new AbortController().signal, (text) => { if (text.startsWith("review")) managerRefresh = true; }, extensionContext);
    };
    await expect(runManagerRefresh("match")).resolves.toMatchObject({ wait_result: "condition_met", matched: true });
    await expect(runManagerRefresh("timeout")).resolves.toMatchObject({ wait_result: "timed_out", matched: false });
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
    expect(result).toMatchObject({ wait_result: "manager_judgment_required", matched: false, targets: [{ target_evidence: { currency: "historical_non_current", source: "native_agent_wait" } }] });
    expect(reviewed).toEqual(["p1"]);
    expect(cli.calls.some((call) => call[1] === "read")).toBe(true);
    expect(cli.calls.filter((call) => call[0] === "agent" && call[1] === "wait").length).toBeGreaterThan(1);
  });

  it("fails with partial target errors when native reviewer refresh cannot read a target", async () => {
    const cli = nativeCli({ statuses: { p1: "working" }, currentStatuses: { p1: "working" } });
    const originalRunText = cli.runText.bind(cli);
    let reads = 0;
    cli.runText = async (...args) => {
      if (++reads === 1) throw new Error("review refresh unavailable");
      return originalRunText(...args);
    };
    const reviewer: WaitReviewer = { review: async ({ targetId }) => ({ targetId, classification: "progress", summary: "not reached" }) };
    await expect(execute(cli, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 120_001 }, { clock: clock(), pollIntervalMs: 60_000, reviewerFactory: () => reviewer })).rejects.toMatchObject({
      code: "CLI_PROTOCOL_ERROR",
      result: { wait_result: "failed", targetErrors: [{ targetId: "p1", code: "CLI_PROTOCOL_ERROR" }] }
    });
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

  it("joins pane and agent records for strict output identity sandwiches", async () => {
    const live = nativeSnapshot({ p1: "working" });
    let agentGets = 0;
    const joined: WaitCli = {
      supportsNativeAgentWait: false,
      async runJson(argv) {
        if (argv[0] === "pane" && argv[1] === "current") return { id: "current", result: { type: "pane_current", pane: live.snapshot.panes[0] } };
        if (argv[0] === "api") return { id: "snapshot", result: live };
        if (argv[0] === "pane" && argv[1] === "get") {
          const pane = live.snapshot.panes.find((candidate) => candidate.pane_id === argv[2])!;
          const paneWithoutAgentIdentity = { ...pane } as Record<string, unknown>;
          delete paneWithoutAgentIdentity.agent_name;
          delete paneWithoutAgentIdentity.agent;
          delete paneWithoutAgentIdentity.terminal_id;
          delete paneWithoutAgentIdentity.agent_session;
          return { id: "pane", result: { pane: paneWithoutAgentIdentity } };
        }
        if (argv[0] === "agent" && argv[1] === "get") {
          agentGets += 1;
          return { id: "agent", result: { agent: live.snapshot.agents.find((agent) => agent.pane_id === argv[2]) } };
        }
        throw new Error(`unexpected ${argv.join(" ")}`);
      },
      async runTextResult() { return { value: "needle", truncated: false }; },
      async runText() { return "needle"; }
    };
    const result = await execute(joined, { targets: ["p1"], match: "any", condition: { kind: "output", match: { kind: "literal", value: "needle" } }, timeoutMs: 1 }, { clock: clock(), requireTargetIdentity: true });
    expect(result).toMatchObject({ wait_result: "condition_met", matched: true, targets: [{ target_evidence: { source: "composite_observation", currency: "historical_non_current" } }] });
    expect(agentGets).toBe(2);
    const missingAgent: WaitCli = {
      ...joined,
      async runJson(argv, signal) {
        if (argv[0] === "agent" && argv[1] === "get") return { id: "agent", result: {} };
        return joined.runJson(argv, signal);
      }
    };
    await expect(execute(missingAgent, { targets: ["p1"], match: "any", condition: { kind: "output", match: { kind: "literal", value: "needle" } }, timeoutMs: 1 }, { clock: clock(), requireTargetIdentity: true })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    const beforeReplacement = nativeSnapshot({ p1: "working" });
    beforeReplacement.snapshot.panes[0] = { ...beforeReplacement.snapshot.panes[0]!, terminal_id: "before-replacement-terminal" } as never;
    beforeReplacement.snapshot.agents[0] = { ...beforeReplacement.snapshot.agents[0]!, terminal_id: "before-replacement-terminal" } as never;
    const changedBefore: WaitCli = {
      ...joined,
      async runJson(argv, signal) {
        if (argv[0] === "pane" && argv[1] === "get") return { id: "pane", result: { pane: beforeReplacement.snapshot.panes[0] } };
        if (argv[0] === "agent" && argv[1] === "get") return { id: "agent", result: { agent: beforeReplacement.snapshot.agents[0] } };
        return joined.runJson(argv, signal);
      }
    };
    await expect(execute(changedBefore, { targets: ["p1"], match: "any", condition: { kind: "output", match: { kind: "literal", value: "needle" } }, timeoutMs: 1 }, { clock: clock(), requireTargetIdentity: true })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
  });

  it("rejects a strict output sandwich when the joined identity changes between reads", async () => {
    const original = nativeSnapshot({ p1: "working" });
    const replacement = nativeSnapshot({ p1: "working" });
    replacement.snapshot.panes[0] = { ...replacement.snapshot.panes[0]!, terminal_id: "replacement-terminal" } as never;
    replacement.snapshot.agents[0] = { ...replacement.snapshot.agents[0]!, terminal_id: "replacement-terminal" } as never;
    let paneGets = 0;
    const cli: WaitCli = {
      supportsNativeAgentWait: false,
      async runJson(argv) {
        if (argv[0] === "pane" && argv[1] === "current") return { id: "current", result: { type: "pane_current", pane: original.snapshot.panes[0] } };
        if (argv[0] === "api") return { id: "snapshot", result: original };
        if (argv[0] === "pane" && argv[1] === "get") {
          paneGets += 1;
          return { id: "pane", result: { pane: paneGets > 1 ? replacement.snapshot.panes[0] : original.snapshot.panes[0] } };
        }
        if (argv[0] === "agent" && argv[1] === "get") return { id: "agent", result: { agent: paneGets > 1 ? replacement.snapshot.agents[0] : original.snapshot.agents[0] } };
        throw new Error(`unexpected ${argv.join(" ")}`);
      },
      async runTextResult() { return { value: "needle", truncated: false }; },
      async runText() { return "needle"; }
    };
    await expect(execute(cli, { targets: ["p1"], match: "any", condition: { kind: "output", match: { kind: "literal", value: "needle" } }, timeoutMs: 1 }, { clock: clock(), requireTargetIdentity: true })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
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
        if (argv[0] === "agent" && argv[1] === "get") return { id: "agent", result: { agent: live.snapshot.agents.find((agent) => agent.pane_id === argv[2]) } };
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

  it("retains context rebinding in running progress details", async () => {
    const rebound = { workspaceId: "old-workspace", tabId: "old-tab", paneId: "p1" };
    const deps = {
      cli: fakeCli({ p1: "not done" }),
      context: rebound,
      settingsLoader: async () => settings,
      jobRegistry: new JobRegistry(),
      clock: clock(),
      contextResolver: async () => ({
        context,
        snapshot: snapshot.snapshot,
        diagnostics: { injected: rebound, effective: context, rebound: true, attempts: 1 },
        operationIds: { current: "current", snapshot: "snapshot" }
      })
    } as Parameters<typeof prepareWait>[0];
    const prepared = await prepareWait(deps, { targets: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, new AbortController().signal);
    const progress: unknown[] = [];
    await runPreparedWait(deps, prepared, new AbortController().signal, (_text, details) => progress.push(details), extensionContext);
    expect(progress[0]).toMatchObject({ contextRebinding: { rebound: true } });
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

  it("returns on the first matching output target without waiting for unrelated reads", async () => {
    let releaseSlow!: (value: string) => void;
    const slow = new Promise<string>((resolve) => { releaseSlow = resolve; });
    const cli: WaitCli = {
      async runJson(argv) {
        if (argv[0] === "pane" && argv[1] === "current") return currentPane();
        if (argv[0] === "api") return { id: "snapshot", result: snapshot };
        return { id: "pane", result: { pane: snapshot.snapshot.panes.find((pane) => pane.pane_id === argv[2]) } };
      },
      async runText(argv) {
        if (argv[2] === "p1") {
          setImmediate(() => releaseSlow("unrelated"));
          return "needle";
        }
        return slow;
      }
    };
    const result = await execute(cli, { targets: ["p1", "p2"], match: "any", condition: { kind: "output", match: { kind: "literal", value: "needle" } }, timeoutMs: 100 }, { clock: clock() });
    expect(result).toMatchObject({ wait_result: "condition_met", matched: true, targets: [{ targetId: "p1", matched: true }] });
    expect((result.targets ?? []).length).toBe(1);
  });

  it("returns a matching output target with earlier target errors", async () => {
    const cli: WaitCli = {
      async runJson(argv) {
        if (argv[0] === "pane" && argv[1] === "current") return currentPane();
        if (argv[0] === "api") return { id: "snapshot", result: snapshot };
        if (argv[2] === "p1") throw new Error("p1 unavailable");
        return { id: "pane", result: { pane: snapshot.snapshot.panes.find((pane) => pane.pane_id === argv[2]) } };
      },
      async runText() { return "needle"; }
    };
    const result = await execute(cli, { targets: ["p1", "p2"], match: "any", condition: { kind: "output", match: { kind: "literal", value: "needle" } }, timeoutMs: 100 }, { clock: clock() });
    expect(result).toMatchObject({ wait_result: "condition_met", matched: true, targetErrors: [{ targetId: "p1", code: "CLI_PROTOCOL_ERROR" }] });
  });

  it("preserves successful target evidence and structured failures for a partial read", async () => {
    const cli: WaitCli = {
      async runJson(argv) {
        if (argv[0] === "pane" && argv[1] === "current") return currentPane();
        if (argv[0] === "api") return { id: "snapshot", result: snapshot };
        if (argv[2] === "p2") throw new Error("p2 unavailable");
        return { id: "pane", result: { pane: snapshot.snapshot.panes.find((pane) => pane.pane_id === argv[2]) } };
      },
      async runText(argv) {
        if (argv[2] === "p2") throw new Error("p2 unavailable");
        return "not the requested output";
      }
    };
    await expect(execute(cli, { targets: ["p1", "p2"], match: "all", condition: { kind: "output", match: { kind: "literal", value: "needle" } }, timeoutMs: 100 }, { clock: clock() })).rejects.toMatchObject({
      code: "CLI_PROTOCOL_ERROR",
      result: {
        wait_result: "failed",
        targets: [{ targetId: "p1", target_evidence: { currency: "historical_non_current", targetGenerationRef: expect.stringMatching(/^target_generation_/) } }],
        targetErrors: [{ targetId: "p2", code: "CLI_PROTOCOL_ERROR" }]
      }
    });
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

  it("keeps an all-covered long wait reviewer-lazy and publishes exact ownership", async () => {
    const registry = new JobRegistry({ idFactory: () => "job_covered_wait" });
    const coverage = vi.spyOn(registry, "activeSupervisorFor").mockReturnValue({ jobId: "job_supervisor_exact" });
    const reviewerFactory = vi.fn(() => { throw new Error("covered wait reviewer must stay unresolved"); });
    const tool = createWaitTool({
      cli: nativeCli({ statuses: { p1: "working", p2: "working" } }),
      context,
      settingsLoader: async () => settings,
      jobRegistry: registry,
      clock: clock(),
      pollIntervalMs: 60_000,
      reviewerFactory,
      requireTargetIdentity: true,
    });
    const accepted = await tool.execute("id", { targets: ["p1"], match: "all", condition: { kind: "output", match: { kind: "literal", value: "never" } }, timeoutMs: 120_001 } as never, new AbortController().signal, undefined, extensionContext);
    await vi.waitFor(() => expect(registry.get((accepted.details as { jobId: string }).jobId)?.operation_phase).toBe("settled"));
    const detail = registry.get("job_covered_wait")!;
    expect(detail.wait_result).toBe("timed_out");
    expect(detail.semanticReview).toMatchObject({
      supervisorCovered: [{ target: "p1", targetId: "p1", supervisorJobId: "job_supervisor_exact" }],
      explicitReviewerTargetIds: [],
      omittedSupervisorCovered: 0,
      omittedExplicitReviewerTargetIds: 0,
    });
    expect(coverage).toHaveBeenCalled();
    expect(reviewerFactory).not.toHaveBeenCalled();
  });

  it("reviews only uncovered targets in a mixed wait and constructs one reviewer lazily", async () => {
    const registry = new JobRegistry();
    vi.spyOn(registry, "activeSupervisorFor").mockImplementation((identity) => identity.paneId === "p1" ? { jobId: "job_supervisor_p1" } : undefined);
    const reviewed: string[] = [];
    const reviewerFactory = vi.fn((): WaitReviewer => ({ review: async ({ targetId }) => {
      reviewed.push(targetId);
      return { targetId, classification: "progress", summary: "explicit owner" };
    } }));
    const result = await execute(nativeCli({ statuses: { p1: "working", p2: "working" } }), {
      targets: ["p1", "p2"], match: "all", condition: { kind: "output", match: { kind: "literal", value: "never" } }, timeoutMs: 120_001,
    }, { jobRegistry: registry, clock: clock(), pollIntervalMs: 60_000, reviewerFactory, requireTargetIdentity: true });
    expect(result.wait_result).toBe("timed_out");
    expect(reviewed).toEqual(["p2", "p2"]);
    expect(reviewerFactory).toHaveBeenCalledTimes(1);
  });

  it("recomputes coverage each cadence without advancing covered transcript baselines", async () => {
    const cli = nativeCli({ statuses: { p1: "working", p2: "working" } });
    let transcriptRead = 0;
    cli.runText = async (argv) => {
      cli.calls.push(argv);
      transcriptRead += 1;
      return ["base", ...(transcriptRead >= 2 ? ["first"] : []), ...(transcriptRead >= 3 ? ["covered"] : []), ...(transcriptRead >= 4 ? ["after"] : [])].join("\n");
    };
    const registry = new JobRegistry();
    const ownership = [undefined, { jobId: "job_supervisor_p1" }, undefined] as const;
    let ownershipIndex = 0;
    vi.spyOn(registry, "activeSupervisorFor").mockImplementation(() => ownership[ownershipIndex++]);
    const requests: ReviewerRequest[] = [];
    const result = await execute(cli, {
      targets: ["p1"], match: "all", condition: { kind: "output", match: { kind: "literal", value: "never" } }, timeoutMs: 180_001,
    }, {
      jobRegistry: registry,
      clock: clock(),
      pollIntervalMs: 60_000,
      requireTargetIdentity: true,
      reviewerFactory: () => ({ review: async (request) => {
        requests.push(request);
        return { targetId: request.targetId, classification: "progress", summary: "still running" };
      } }),
    });
    expect(result.wait_result).toBe("timed_out");
    expect(requests).toHaveLength(2);
    expect(requests[0]?.transcriptDelta).toEqual(["base", "first"]);
    expect(requests[1]?.transcriptDelta).toEqual(["covered", "after"]);
  });

  it("aborts reviewer calls at the remaining wait deadline", async () => {
    const pending = execute(fakeCli({ p1: "working" }), { targets: ["p1"], match: "all", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, {
      settingsLoader: async () => ({ ...settings, reviewCadenceMinutes: 0 }),
      clock: clock(),
      pollIntervalMs: 0,
      reviewerFactory: () => ({ review: async () => new Promise<never>(() => undefined) })
    });
    const outcome = await Promise.race([
      pending,
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 100))
    ]);
    expect(outcome).not.toBe("hung");
    expect(outcome).toMatchObject({ wait_result: "timed_out", matched: false, reason: "timeout" });
  });

  it("settles a reviewer rejection that arrives at the wait deadline as timeout", async () => {
    let now = 0;
    const reviewer: WaitReviewer = { review: async () => {
      now = 60_001;
      throw new Error("reviewer finished at the deadline");
    } };
    const result = await execute(fakeCli({ p1: "working" }), { targets: ["p1"], match: "all", condition: { kind: "state", state: "done" }, timeoutMs: 60_001 }, {
      clock: { now: () => now, sleep: async (milliseconds) => { now += milliseconds; } },
      pollIntervalMs: 60_000,
      reviewerFactory: () => reviewer
    });
    expect(result).toMatchObject({ wait_result: "timed_out", matched: false, reason: "timeout" });
  });

  it("reports state changes observed between wait polls", async () => {
    let paneGets = 0;
    let now = 0;
    const cli: WaitCli = {
      async runJson(argv) {
        if (argv[0] === "pane" && argv[1] === "current") return currentPane();
        if (argv[0] === "api") return { id: "snapshot", result: snapshot };
        const status = paneGets++ === 0 ? "working" : "blocked";
        return { id: "pane", result: { pane: { ...snapshot.snapshot.panes[0], agent_status: status } } };
      },
      async runText() { return ""; }
    };
    const result = await execute(cli, { targets: ["p1"], match: "all", condition: { kind: "state", state: "done" }, timeoutMs: 2 }, {
      settingsLoader: async () => ({ ...settings, reviewCadenceMinutes: 0 }),
      clock: { now: () => now, sleep: async () => { now += 1; } },
      pollIntervalMs: 0,
      reviewerFactory: () => ({ review: async ({ targetId }) => ({ targetId, classification: "progress", summary: "state changed" }) })
    });
    expect(result).toMatchObject({ wait_result: "timed_out", matched: false });
  });

  it("settles immediately when the reviewer window has no remaining time", async () => {
    let afterSleep = false;
    let reviewWindowReads = 0;
    const clockForWindow: WaitClock = {
      now: () => {
        if (!afterSleep) return 0;
        reviewWindowReads += 1;
        return reviewWindowReads <= 5 ? 60_000 : 60_001;
      },
      sleep: async () => { afterSleep = true; }
    };
    let reviewerEntered = false;
    const reviewer: WaitReviewer = { review: async ({ targetId }) => { reviewerEntered = true; return { targetId, classification: "progress", summary: "not reached" }; } };
    const result = await execute(fakeCli({ p1: "working" }), { targets: ["p1"], match: "all", condition: { kind: "state", state: "done" }, timeoutMs: 60_001 }, {
      clock: clockForWindow,
      pollIntervalMs: 60_000,
      reviewerFactory: () => reviewer
    });
    expect(result).toMatchObject({ wait_result: "timed_out", matched: false, reason: "timeout" });
    expect(reviewerEntered).toBe(false);
  });

  it("drains a reviewer rejection after the deadline race settles", async () => {
    let aborted = false;
    const reviewer: WaitReviewer = { review: async (_request, signal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("reviewer stopped at deadline"));
      }, { once: true });
    }) };
    const result = await execute(fakeCli({ p1: "working" }), { targets: ["p1"], match: "all", condition: { kind: "state", state: "done" }, timeoutMs: 1 }, {
      settingsLoader: async () => ({ ...settings, reviewCadenceMinutes: 0 }),
      clock: clock(),
      pollIntervalMs: 0,
      reviewerFactory: () => reviewer
    });
    expect(result).toMatchObject({ wait_result: "timed_out", matched: false, reason: "timeout" });
    expect(aborted).toBe(true);
  });

  it("runs uncapped reviewers concurrently and ends on manager judgment", async () => {
    const cli = fakeCli({ p1: "working", p2: "working" });
    const entered: string[] = [];
    const reviewer: WaitReviewer = { review: async ({ targetId }) => { entered.push(targetId); return { targetId, classification: "blocked", summary: "needs attention" }; } };
    const result = await execute(cli, { targets: ["p1", "p2"], match: "all", condition: { kind: "state", state: "done" }, timeoutMs: 60_001 }, { clock: clock(), pollIntervalMs: 100_000, reviewerFactory: () => reviewer });
    expect(entered).toEqual(["p1", "p2"]);
    expect(result).toMatchObject({ wait_result: "manager_judgment_required", matched: false, reason: "manager_judgment_required", targets: [
      { target_evidence: { currency: "historical_non_current", source: "composite_observation" } },
      { target_evidence: { currency: "historical_non_current", source: "composite_observation" } }
    ] });
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
    expect(requests[0]?.signal).toBe(requests[1]?.signal);
    expect(requests[2]?.signal).toBe(requests[3]?.signal);
    expect(requests[0]?.signal).not.toBe(requests[2]?.signal);
    expect(maximumActive).toBeGreaterThan(1);
  });

  it("settles manager judgment as timeout when review progress reaches the deadline", async () => {
    let now = 0;
    const cli = fakeCli({ p1: "working" });
    const deps = { cli, context, settingsLoader: async () => settings, jobRegistry: new JobRegistry(), clock: { now: () => now, sleep: async (milliseconds: number) => { now += milliseconds; } }, pollIntervalMs: 60_000, reviewerFactory: () => ({ review: async ({ targetId }) => ({ targetId, classification: "blocked" as const, summary: "deadline" }) }) } as Parameters<typeof prepareWait>[0];
    const prepared = await prepareWait(deps, { targets: ["p1"], match: "all", condition: { kind: "state", state: "done" }, timeoutMs: 60_001 }, new AbortController().signal);
    const result = await runPreparedWait(deps, prepared, new AbortController().signal, (text) => { if (text.startsWith("review")) now = 60_001; }, extensionContext);
    expect(result).toMatchObject({ wait_result: "timed_out", matched: false, reason: "timeout" });
  });

  it.each(["stalled", "blocked", "risk"] as const)("ends with manager judgment for %s reviewer findings", async (classification) => {
    const reviewer: WaitReviewer = { review: async ({ targetId }) => ({ targetId, classification, summary: "attention" }) };
    const result = await execute(fakeCli({ p1: "working" }), { targets: ["p1"], match: "all", condition: { kind: "state", state: "done" }, timeoutMs: 60_001 }, { clock: clock(), pollIntervalMs: 100_000, reviewerFactory: () => reviewer });
    expect(result).toMatchObject({ wait_result: "manager_judgment_required", matched: false, reason: "manager_judgment_required" });
  });

  it("retains unknown but continues only when a post-review exact agent read proves working", async () => {
    const workingCli = nativeCli({ statuses: { p1: "working", p2: "working" } });
    const workingRunJson = workingCli.runJson.bind(workingCli);
    let reviewReturned = false;
    let postReviewAgentGets = 0;
    workingCli.runJson = async (argv, signal) => {
      if (reviewReturned && argv[0] === "agent" && argv[1] === "get") postReviewAgentGets += 1;
      return workingRunJson(argv, signal);
    };
    const reviewer: WaitReviewer = { review: async ({ targetId }) => {
      reviewReturned = true;
      return { targetId, classification: "unknown", summary: "uncertain" };
    } };
    const working = await execute(workingCli, {
      targets: ["p1"], match: "all", condition: { kind: "state", state: "done" }, timeoutMs: 60_001,
    }, { clock: clock(), pollIntervalMs: 60_000, reviewerFactory: () => reviewer });
    expect(working).toMatchObject({ wait_result: "timed_out", reviewerSummaries: [{ targetId: "p1", classification: "unknown" }] });
    // Existing post-review condition precedence performs two current-state
    // refreshes plus the final native verification; unknown adds no fourth read.
    expect(postReviewAgentGets).toBe(3);

    reviewReturned = false;
    const idle = await execute(nativeCli({ statuses: { p1: "idle", p2: "working" } }), {
      targets: ["p1"], match: "all", condition: { kind: "state", state: "done" }, timeoutMs: 60_001,
    }, { clock: clock(), pollIntervalMs: 60_000, reviewerFactory: () => reviewer });
    expect(idle).toMatchObject({ wait_result: "manager_judgment_required", reviewerSummaries: [{ targetId: "p1", classification: "unknown" }] });
  });

  it("uses a fresh exact agent read for unknown reviews and preserves read failures", async () => {
    for (const mode of ["working", "idle", "absent", "missing_state", "changed", "deadline"] as const) {
      const cli = nativeCli({ statuses: { p1: "working", p2: "working" } });
      const original = cli.runJson.bind(cli);
      let reviewReturned = false;
      let postReviewAgentGets = 0;
      let now = 0;
      const runClock: WaitClock = { now: () => now, sleep: async (milliseconds) => { now += milliseconds; } };
      cli.runJson = async (argv, signal) => {
        if (reviewReturned && argv[0] === "agent" && argv[1] === "get") {
          postReviewAgentGets += 1;
          const response = await original(argv, signal);
          const agent = (response.result as { agent: Record<string, unknown> }).agent;
          if (postReviewAgentGets <= 2 || mode === "missing_state") {
            const identityOnly = { ...agent };
            delete identityOnly.agent_status;
            return { ...response, result: { agent: identityOnly } };
          }
          if (mode === "absent") throw new CliProtocolError("CLI_PROTOCOL_ERROR", "agent absent", { errorEnvelope: { error: { code: "agent_not_found", message: "agent absent" } } });
          if (mode === "deadline") {
            now = 60_001;
            throw new Error("agent read deadline");
          }
          if (mode === "changed") return { ...response, result: { agent: { ...agent, terminal_id: "replaced-terminal" } } };
          return { ...response, result: { agent: { ...agent, agent_status: mode } } };
        }
        return original(argv, signal);
      };
      const reviewer: WaitReviewer = { review: async ({ targetId }) => {
        reviewReturned = true;
        return { targetId, classification: "unknown", summary: "uncertain" };
      } };
      const params = { targets: ["p1"], match: "all" as const, condition: { kind: "output" as const, match: { kind: "literal" as const, value: "never" } }, timeoutMs: 60_001 };
      const outcome = execute(cli, params, { clock: runClock, pollIntervalMs: 60_000, requireTargetIdentity: true, reviewerFactory: () => reviewer });
      if (mode === "working") await expect(outcome).resolves.toMatchObject({ wait_result: "timed_out", matched: false });
      else if (mode === "idle") await expect(outcome).resolves.toMatchObject({ wait_result: "manager_judgment_required", matched: false });
      else if (mode === "deadline") await expect(outcome).resolves.toMatchObject({ wait_result: "timed_out", matched: false });
      else await expect(outcome).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR", result: { wait_result: "failed", targetErrors: [{ targetId: "p1", code: "CLI_PROTOCOL_ERROR" }] } });
    }
  });

  it.each([
    ["working", "idle", "manager_judgment_required"],
    ["idle", "working", "timed_out"],
  ] as const)("uses authoritative agent state %s/%s rather than output metadata", async (paneState, agentState, expected) => {
    const cli = nativeCli({ statuses: { p1: "working", p2: "working" } });
    const original = cli.runJson.bind(cli);
    cli.runJson = async (argv, signal) => {
      const envelope = await original(argv, signal);
      if (argv[0] === "pane" && argv[1] === "get") return { ...envelope, result: { pane: { ...((envelope.result as { pane: Record<string, unknown> }).pane), agent_status: paneState } } };
      if (argv[0] === "agent" && argv[1] === "get") return { ...envelope, result: { agent: { ...((envelope.result as { agent: Record<string, unknown> }).agent), agent_status: agentState } } };
      return envelope;
    };
    const result = await execute(cli, {
      targets: ["p1"], match: "all", condition: { kind: "output", match: { kind: "literal", value: "never" } }, timeoutMs: 60_001,
    }, {
      clock: clock(), pollIntervalMs: 60_000, requireTargetIdentity: true,
      reviewerFactory: () => ({ review: async ({ targetId }) => ({ targetId, classification: "unknown", summary: "output uncertain" }) }),
    });
    expect(result.wait_result).toBe(expected);
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

  it("preserves an unmapped unknown reviewer target in the manager summary", async () => {
    const reviewer: WaitReviewer = { review: async () => ({ targetId: "external", classification: "unknown", summary: "attention" }) };
    const result = await execute(fakeCli({ p1: "working" }), { targets: ["p1"], match: "all", condition: { kind: "state", state: "done" }, timeoutMs: 60_001 }, { clock: clock(), pollIntervalMs: 100_000, reviewerFactory: () => reviewer });
    expect(result.wait_result).toBe("manager_judgment_required");
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
    expect(jobDetail.details).toMatchObject({ operation: "jobs", view: "job", kind: "wait", operation_phase: "settled", wait_result: "condition_met", result: { wait_result: "condition_met", reason: "condition_met" } });
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
    const result = await execute(fakeCli(), { targets: ["p1"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 }, { clock: { now: () => ++calls >= 4 ? 2 : 0, sleep: async () => undefined } });
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
    const codedTargetFailure: WaitCli = {
      async runJson(argv) {
        if (argv[0] === "pane" && argv[1] === "current") return currentPane();
        if (argv[0] === "api") return { id: "snapshot", result: snapshot };
        throw Object.assign(new Error("coded target failure"), { code: "BROKEN" });
      },
      async runText() { return ""; }
    };
    await expect(execute(codedTargetFailure, { targets: ["p1"], match: "any", condition: { kind: "output", match: { kind: "literal", value: "missing" } }, timeoutMs: 1 }, { clock: clock() })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR", result: { targetErrors: [{ code: "BROKEN" }] } });

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
    expect(result).toMatchObject({ wait_result: "timed_out", matched: false, reason: "timeout", targets: [{ targetId: "p1", matched: false, target_evidence: { currency: "historical_non_current", source: "composite_observation" } }] });
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
    expect(prepared.settings.reviewerThinking).toBe("max");
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
