import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CliProtocolError, type HerdrCli, type JsonEnvelope } from "../../src/cli.js";
import { createCommunicateTool } from "../../src/tools/communicate.js";
import { turnControlInternals as internals } from "../../src/tools/turn-control.js";
import { CommunicateParamsSchema } from "../../src/schemas.js";
import type { HerdrSnapshot } from "../../src/targets.js";
import { Value } from "typebox/value";

const identity = {
  terminal_id: "term-worker",
  agent_session: { source: "pi", agent: "pi", kind: "id", value: "session-worker" }
};
const callerPane = { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "caller", agent_status: "idle" };
const workerPane = (state: string, seq = 10, extra: Record<string, unknown> = {}) => ({
  pane_id: "w1:p2",
  tab_id: "w1:t1",
  workspace_id: "w1",
  label: "worker",
  agent: "pi",
  agent_name: "worker",
  agent_status: state,
  state_change_seq: seq,
  ...identity,
  ...extra
});
const workerAgent = (state: string, seq = 10, extra: Record<string, unknown> = {}) => ({
  pane_id: "w1:p2",
  name: "worker",
  agent: "pi",
  agent_status: state,
  state_change_seq: seq,
  ...identity,
  ...extra
});
function snapshot(pane: Record<string, unknown> | null = workerPane("working"), agent: Record<string, unknown> | null | undefined = undefined): HerdrSnapshot {
  const effectiveAgent = agent === null || pane === null ? undefined : agent ?? workerAgent(String(pane.agent_status ?? "working"), safeSeq(pane.state_change_seq));
  return {
    version: "0.8.2",
    protocol: 22,
    workspaces: [{ workspace_id: "w1", label: "workspace" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main" }],
    panes: [callerPane, ...(pane ? [pane as never] : [])],
    agents: [
      { pane_id: "w1:p1", name: "caller", agent_status: "idle" },
      ...(effectiveAgent ? [effectiveAgent as never] : [])
    ]
  };
}
function envelope(id: string, result: unknown): JsonEnvelope {
  return { id, result };
}
function safeSeq(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 10;
}
function resultForSnapshot(value: HerdrSnapshot): JsonEnvelope {
  return envelope("snapshot", { type: "session_snapshot", snapshot: value });
}
function responseForAgent(agent: Record<string, unknown>): JsonEnvelope {
  return envelope("agent-get", { agent });
}
function makeCli(finalSnapshot: HerdrSnapshot, options: { waitError?: Error; dispatchError?: Error; initialSnapshot?: HerdrSnapshot } = {}) {
  const calls: string[][] = [];
  const signals: AbortSignal[] = [];
  let wait = false;
  const initialSnapshot = options.initialSnapshot ?? snapshot();
  const runJson = vi.fn(async (argv: string[], signal: AbortSignal): Promise<JsonEnvelope> => {
    if (argv[0] === "pane" && argv[1] === "current") return envelope("current", { type: "pane_current", pane: callerPane });
    calls.push(argv);
    signals.push(signal);
    if (argv[0] === "api") {
      return calls.filter((call) => call[0] === "api").length === 1
        ? resultForSnapshot(initialSnapshot)
        : resultForSnapshot(finalSnapshot);
    }
    if (argv[0] === "agent" && argv[1] === "get") return responseForAgent(workerAgent("working"));
    if (argv[0] === "agent" && argv[1] === "send-keys") {
      if (options.dispatchError) throw options.dispatchError;
      return envelope("dispatch-1", { ok: true });
    }
    if (argv[0] === "agent" && argv[1] === "wait") {
      wait = true;
      if (options.waitError) throw options.waitError;
      return envelope("wait-1", { agent: workerAgent("idle", 11) });
    }
    throw new Error(`unexpected ${argv.join(" ")}`);
  });
  return { cli: { runJson } as unknown as HerdrCli, calls, signals, wasWait: () => wait, runJson };
}
function execute(cli: HerdrCli, params: Record<string, unknown>, signal = new AbortController().signal) {
  const tool = createCommunicateTool({ cli, context: { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" }, preflight: async () => undefined });
  return tool.execute("turn", params as never, signal, undefined, { signal, hasUI: false } as unknown as ExtensionContext);
}

describe("explicit turn-control schema", () => {
  it("accepts strict cancel and interrupt variants and rejects extra fields", () => {
    expect(Value.Check(CommunicateParamsSchema, { target: "worker", operation: "cancel" })).toBe(true);
    expect(Value.Check(CommunicateParamsSchema, { target: "worker", operation: "interrupt" })).toBe(true);
    for (const key of ["esc", "escape", "ctrl+c"] as const) {
      expect(Value.Check(CommunicateParamsSchema, { target: "worker", operation: "keys", keys: [key] })).toBe(true);
    }
    expect(Value.Check(CommunicateParamsSchema, { target: "worker", operation: "cancel", keys: ["esc"] })).toBe(false);
    expect(Value.Check(CommunicateParamsSchema, { target: "worker", operation: "interrupt", delivery: "inline" })).toBe(false);
  });
});

describe("turn-control bounded internal helpers", () => {
  const stable = { paneId: "w1:p2", terminalId: "term-worker", tabId: "w1:t1", workspaceId: "w1", agentName: "worker", agentKind: "pi", agentSession: { source: "pi", agent: "pi", kind: "id", value: "session-worker" } };

  it("covers strict evidence, identity, state, and proof helpers", () => {
    expect(internals.bounded("x".repeat(400))).toHaveLength(256);
    expect(internals.boundedOperationId(undefined)).toBeUndefined();
    expect(internals.boundedOperationId("")).toBeUndefined();
    expect(internals.safeString(undefined)).toBeUndefined();
    expect(internals.safeString(1)).toBeUndefined();
    expect(internals.safeString("")).toBeUndefined();
    expect(internals.safeString("value")).toBe("value");
    expect(internals.safeInteger(undefined)).toBeUndefined();
    expect(internals.safeInteger(-1)).toBeUndefined();
    expect(internals.safeInteger(1.5)).toBeUndefined();
    expect(internals.safeInteger(Number.NaN)).toBeUndefined();
    expect(internals.safeInteger(2)).toBe(2);
    expect(internals.errorCode(null)).toBeUndefined();
    expect(internals.errorCode({ code: "" })).toBeUndefined();
    expect(internals.errorCode({ code: "E" })).toBe("E");
    expect(internals.errorMessage(new Error("boom"))).toBe("boom");
    expect(internals.errorMessage("plain")).toBe("plain");
    expect(internals.errorDetails(null)).toEqual({});
    expect(internals.errorDetails({ details: "not-an-object" })).toEqual({});
    expect(internals.errorDetails({ details: { target: "worker", actualKind: "tab", candidates: ["p1", 2, "p2"] } })).toEqual({ target: "worker", actualKind: "tab", candidates: ["p1", "p2"] });
    expect(internals.errorDetails({ details: { target: "worker" } })).toEqual({ target: "worker" });
    expect(internals.errorDetails({ details: { actualKind: "tab" } })).toEqual({ actualKind: "tab" });
    expect(internals.errorDetails({ details: { candidates: ["p1"] } })).toEqual({ candidates: ["p1"] });

    expect(internals.compactEvidence(undefined)).toEqual({ status: "unavailable" });
    expect(internals.compactEvidence({ pane_id: "p", tab_id: "t", workspace_id: "w", terminal_id: "term", agent_status: "working", state_change_seq: Number.NaN, interactive_ready: true, launch_pending: null, agent_session: stable.agentSession })).toMatchObject({ pane_id: "p", interactive_ready: true, launch_pending: null, agent_session: stable.agentSession });
    for (const value of [null, {}, { source: "" }, { source: "s", agent: "a" }, { source: "s", agent: "a", kind: "k" }, { source: "s", agent: "a", kind: "k", value: "v" }]) {
      const session = internals.sessionFrom(value);
      expect(session === undefined || session.value === "v").toBe(true);
    }
    expect(internals.sessionFrom({ source: "s", agent: "a", kind: "k", value: "v" })).toEqual({ source: "s", agent: "a", kind: "k", value: "v" });
    expect(internals.sessionEvidence({ agent_session: stable.agentSession }, stable.agentSession)).toMatchObject({ kind: "matching" });
    expect(internals.sessionEvidence({ agent_session: "session-worker" }, stable.agentSession)).toMatchObject({ kind: "matching" });
    expect(internals.sessionEvidence({ agent_session_id: "session-worker" }, stable.agentSession)).toMatchObject({ kind: "matching" });
    expect(internals.sessionEvidence({ agent_session_id: null }, stable.agentSession)).toMatchObject({ kind: "malformed" });
    expect(internals.sessionEvidence({ session_id: "other" }, stable.agentSession)).toMatchObject({ kind: "different" });
    const agentSessionFamily = { agent_session_source: "pi", agent_session_agent: "pi", agent_session_kind: "id", agent_session_value: "session-worker" };
    const sessionFamily = { session_source: "pi", session_agent: "pi", session_kind: "id", session_value: "session-worker" };
    expect(internals.sessionEvidence(agentSessionFamily, stable.agentSession)).toMatchObject({ kind: "matching" });
    expect(internals.sessionEvidence(sessionFamily, stable.agentSession)).toMatchObject({ kind: "matching" });
    expect(internals.sessionEvidence({ ...agentSessionFamily, ...sessionFamily }, stable.agentSession)).toMatchObject({ kind: "matching" });
    expect(internals.sessionEvidence({ ...agentSessionFamily, ...sessionFamily, session_value: "replacement" }, stable.agentSession)).toMatchObject({ kind: "contradictory" });
    expect(internals.sessionEvidence({ agent_session_source: "pi", session_agent: "pi", session_kind: "id", session_value: "session-worker" }, stable.agentSession)).toMatchObject({ kind: "malformed" });
    expect(internals.sessionEvidence({ ...agentSessionFamily, session_source: "pi", session_agent: "pi" }, stable.agentSession)).toMatchObject({ kind: "malformed" });
    expect(internals.sessionEvidence({ agent_session_source: "pi" }, stable.agentSession)).toMatchObject({ kind: "malformed" });
    expect(internals.sessionEvidence({ agent_session_source: "pi", agent_session_agent: "pi", agent_session_kind: "id", agent_session_value: 7 }, stable.agentSession)).toMatchObject({ kind: "malformed" });
    expect(internals.sessionEvidence({ agent_session: { source: "pi", agent: "pi", kind: "id" } }, stable.agentSession)).toMatchObject({ kind: "malformed" });
    expect(internals.sessionEvidence({ agent_session: { source: "pi", agent: "pi", kind: "id", value: null } }, stable.agentSession)).toMatchObject({ kind: "malformed" });
    expect(internals.sessionEvidence({ agent_session: { source: "pi", agent: "pi", kind: "id", value: "replacement" }, agent_session_id: "session-worker" }, stable.agentSession)).toMatchObject({ kind: "contradictory" });
    expect(internals.sessionEvidence({ agent_session: { source: "other", agent: "other", kind: "id", value: "one" }, session_id: "two" }, stable.agentSession)).toMatchObject({ kind: "contradictory" });
    expect(internals.sessionEvidence({}, stable.agentSession)).toMatchObject({ kind: "none" });

    expect(() => internals.stateFrom(undefined, "pre_state")).toThrowError(/unavailable/);
    expect(() => internals.stateFrom({}, "pre_state")).toThrowError(/unavailable/);
    expect(() => internals.stateFrom({ agent_status: "not-a-state" }, "pre_state")).toThrowError(/unavailable/);
    expect(internals.stateFrom({ status: "idle" }, "pre_state")).toBe("idle");
    expect(internals.stateFrom({ agent_status: "unknown" }, "pre_state")).toBe("unknown");
    expect(internals.stableIdentity({ pane_id: "p", terminal_id: "t", tab_id: "tab", workspace_id: "w", name: "worker", agent: "pi", agent_session: stable.agentSession }, undefined)).toMatchObject({ paneId: "p" });
    expect(internals.stableIdentity({ pane_id: "p", tab_id: "tab", workspace_id: "w", agent_session: stable.agentSession }, undefined)).toBeUndefined();
    expect(internals.stableIdentity({ pane_id: "p", terminal_id: "t", tab_id: "tab", workspace_id: "w", agent_session: {} }, undefined)).toBeUndefined();
    expect(internals.stableIdentity({ terminal_id: "t", name: "worker", agent: "pi", agent_session: stable.agentSession }, { paneId: "p", tabId: "tab", workspaceId: "w" } as never)).toMatchObject({ paneId: "p", tabId: "tab", workspaceId: "w" });
    expect(internals.stableIdentity({ terminal_id: "t", name: "worker", agent: "pi", agent_session: stable.agentSession }, { paneId: "p", tabId: "tab", workspaceId: "w" } as never, true)).toBeUndefined();
    const sessionVariants = ["source", "agent", "kind", "value"] as const;
    for (const field of sessionVariants) {
      const changed = { ...stable.agentSession, [field]: `${field}-changed` };
      expect(internals.sameSession(stable.agentSession, changed)).toBe(false);
    }
    expect(internals.sameSession(stable.agentSession, stable.agentSession)).toBe(true);
    expect(internals.sameIdentity(stable, { ...stable, paneId: "other" })).toBe(false);
    expect(internals.sameIdentity(stable, { ...stable, terminalId: "other" })).toBe(false);
    expect(internals.sameIdentity(stable, { ...stable, agentSession: { ...stable.agentSession, value: "other" } })).toBe(false);
    expect(internals.sameIdentity(stable, stable)).toBe(true);

    const joinPane = workerPane("working") as Record<string, unknown>;
    const joinAgent = workerAgent("working") as Record<string, unknown>;
    expect(internals.joinTurnIdentity([joinPane, joinAgent], "w1:p2", "pre_state")).toMatchObject({ paneId: "w1:p2", agentName: "worker", agentKind: "pi", state: "working" });
    expect(() => internals.joinTurnIdentity([{ ...joinPane, tab_id: null }, joinAgent], "w1:p2", "pre_state")).toThrowError(/malformed/);
    expect(() => internals.joinTurnIdentity([joinPane, { ...joinAgent, tab_id: "other" }], "w1:p2", "pre_state")).toThrowError(/contradictory/);
    const noTabPane = { ...joinPane };
    const noTabAgent = { ...joinAgent };
    delete noTabPane.tab_id;
    delete noTabAgent.tab_id;
    expect(() => internals.joinTurnIdentity([noTabPane, noTabAgent], "w1:p2", "pre_state")).toThrowError(/missing/);
    expect(() => internals.stateChangeSeq([{ state_change_seq: "bad" }], "identity")).toThrowError(/invalid/);
    expect(() => internals.stateChangeSeq([{ state_change_seq: 1 }, { state_change_seq: 2 }], "identity")).toThrowError(/contradictory/);

    const collisionPrefix = "x".repeat(256);
    const longRecord = (suffix: string) => ({
      pane_id: `${collisionPrefix}-pane-${suffix}`,
      terminal_id: `${collisionPrefix}-terminal-${suffix}`,
      tab_id: `${collisionPrefix}-tab-${suffix}`,
      workspace_id: `${collisionPrefix}-workspace-${suffix}`,
      agent_status: "working",
      name: `${collisionPrefix}-name-${suffix}`,
      agent: `${collisionPrefix}-kind-${suffix}`,
      agent_session: {
        source: `${collisionPrefix}-source-${suffix}`,
        agent: `${collisionPrefix}-agent-${suffix}`,
        kind: `${collisionPrefix}-kind-${suffix}`,
        value: `${collisionPrefix}-value-${suffix}`
      }
    });
    const longBase = internals.stableIdentity(longRecord("base"), undefined)!;
    expect(longBase.paneId).toBe(`${collisionPrefix}-pane-base`);
    expect(longBase.agentSession.value).toBe(`${collisionPrefix}-value-base`);
    for (const field of ["pane_id", "terminal_id"] as const) {
      const replacement = internals.stableIdentity({ ...longRecord("base"), [field]: `${collisionPrefix}-${field}-replacement` }, undefined)!;
      expect(internals.sameIdentity(longBase, replacement)).toBe(false);
    }
    for (const field of ["source", "agent", "kind", "value"] as const) {
      const replacement = internals.stableIdentity({ ...longRecord("base"), agent_session: { ...longRecord("base").agent_session, [field]: `${collisionPrefix}-${field}-replacement` } }, undefined)!;
      expect(internals.sameIdentity(longBase, replacement)).toBe(false);
    }
    expect(internals.sameParent(longRecord("base"), longBase)).toBe(true);
    for (const field of ["tab_id", "workspace_id"] as const) {
      expect(internals.sameParent({ ...longRecord("base"), [field]: `${collisionPrefix}-${field}-replacement` }, longBase)).toBe(false);
    }
    expect(internals.sessionEvidence({ agent_session: { ...longRecord("base").agent_session, value: `${collisionPrefix}-value-replacement` } }, longBase.agentSession)).toMatchObject({ kind: "different" });

    const longAbsenceSnapshot = snapshot({ pane_id: longBase.paneId, tab_id: longBase.tabId, workspace_id: longBase.workspaceId, terminal_id: longBase.terminalId, agent_status: "unknown" }, null);
    longAbsenceSnapshot.panes.push({ pane_id: `${collisionPrefix}-pane-captured`, agent_session: longBase.agentSession } as never);
    expect(internals.hasCapturedSessionElsewhere(longAbsenceSnapshot, longBase)).toBe(true);
    expect(internals.baseDetails("interrupt", "ctrl+c", longRecord("base"), longBase, "confirmed", {}, true, true).target).toMatchObject({ paneId: collisionPrefix.slice(0, 256), terminalId: collisionPrefix.slice(0, 256) });

    const liveSnapshot = snapshot();
    const target = { kind: "agent", id: "w1:p2", workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p2", label: "worker", agentName: "worker", record: liveSnapshot.agents[1]! } as unknown as Parameters<typeof internals.mergedSnapshotAgent>[1];
    expect(internals.mergedSnapshotAgent(liveSnapshot, target)).toMatchObject({ pane_id: "w1:p2" });
    expect(internals.mergedSnapshotAgent(liveSnapshot, { ...target, paneId: undefined } as never)).toBeUndefined();
    expect(internals.mergedSnapshotAgent(liveSnapshot, { ...target, paneId: "missing" })).toBeUndefined();
    const conflictingSnapshot = snapshot(workerPane("working", 10, { agent_name: "different" }));
    expect(internals.mergedSnapshotAgent(conflictingSnapshot, target)).toBeUndefined();
    const paneOnly = snapshot(workerPane("working"), null);
    expect(internals.mergedSnapshotAgent(paneOnly, target)).toBeUndefined();
    expect(internals.agentGetResult({ agent: { pane_id: "p" } })).toEqual({ pane_id: "p" });
    expect(() => internals.agentGetResult(null)).toThrowError(/identity/);
    expect(internals.baseDetails("cancel", "esc", { pane_id: "p" }, undefined, "preflight", {}, false, false)).toMatchObject({ target: { paneId: "p", agentSession: { source: "unknown" } } });
    expect(internals.baseDetails("interrupt", "ctrl+c", { pane_id: "p", label: "worker", agent_name: "worker" }, stable, "confirmed", {}, true, true).target).toMatchObject({ label: "worker", agentName: "worker" });
    expect(internals.baseDetails("interrupt", "ctrl+c", { pane_id: "p" }, { ...stable, agentName: "worker", agentKind: "pi" }, "confirmed", {}, true, true).target).toMatchObject({ agentName: "worker" });
    expect(internals.baseDetails("interrupt", "ctrl+c", { pane_id: "p" }, stable, "confirmed", {}, true, true).target).not.toHaveProperty("label");
    const bounded = internals.boundedSignal();
    bounded.dispose();
    expect(internals.isTerminalState("idle")).toBe(true);
    expect(internals.isTerminalState("working")).toBe(false);
    expect(internals.hasAgentFields({})).toBe(false);
    expect(internals.hasAgentFields({ agent: "pi" })).toBe(true);
    expect(internals.hasAgentFields({ agent_session: null })).toBe(true);
    expect(internals.hasSessionRepresentation({ agent_session_id: "session-worker" })).toBe(true);
    expect(internals.hasSessionRepresentation({})).toBe(false);
    expect(internals.hasCapturedSessionElsewhere(liveSnapshot, stable)).toBe(false);
    const duplicateSession = snapshot(workerPane("working"), workerAgent("working"));
    duplicateSession.panes.push({ ...workerPane("working"), pane_id: "w1:p3" } as never);
    expect(internals.hasCapturedSessionElsewhere(duplicateSession, stable)).toBe(true);
    expect(internals.isAgentFreeUnknown(duplicateSession, { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", terminal_id: "term-worker", agent_status: "unknown" }, stable)).toBe(false);
    const free = snapshot({ pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", terminal_id: "term-worker", agent_status: "unknown" }, null);
    expect(internals.isAgentFreeUnknown(free, free.panes[1] as never, stable)).toBe(true);
    const freePane = free.panes[1] as unknown as Record<string, unknown>;
    expect(internals.isAgentFreeUnknown(free, { ...freePane, terminal_id: "other" }, stable)).toBe(true);
    expect(internals.isAgentFreeUnknown(free, { ...freePane, agent_status: "working" }, stable)).toBe(false);
    expect(internals.isAgentFreeUnknown(free, { ...freePane, status: "working" }, stable)).toBe(false);
    expect(internals.isAgentFreeUnknown(free, { ...freePane, agent_status: "unknown", status: "working" }, stable)).toBe(false);
    expect(internals.isAgentFreeUnknown(free, { ...freePane, agent: "pi" }, stable)).toBe(false);
    expect(internals.isAgentFreeUnknown(free, { ...freePane, agent_session_id: "session-worker" }, stable)).toBe(false);
    expect(internals.isAgentFreeUnknown({ ...free, agents: [workerAgent("unknown") as never] }, freePane, stable)).toBe(false);
    expect(internals.sameParent(freePane, stable)).toBe(true);
    for (const field of ["pane_id", "terminal_id", "tab_id", "workspace_id"] as const) expect(internals.sameParent({ ...freePane, [field]: "other" }, stable)).toBe(false);
    expect(internals.finalRecord(liveSnapshot, stable).merged).toBeDefined();
    expect(internals.finalRecord(free, stable).pane).toBeDefined();
    expect(internals.postWaitDetails({ code: "CLI_TIMEOUT" })).toEqual({ outcome: "failed", code: "CLI_TIMEOUT" });
    expect(internals.postWaitDetails("failed")).toEqual({ outcome: "failed" });
    expect(internals.dispatchEvidence(undefined)).toEqual({ dispatch: { outcome: "acknowledged" } });
    expect(internals.dispatchEvidence(Object.assign(new Error("lost"), { code: "ABORTED" }))).toEqual({ dispatch: { outcome: "failed", code: "ABORTED" } });
    expect(internals.dispatchEvidence(new Error("no code"))).toEqual({ dispatch: { outcome: "failed", code: "unknown" } });
    expect(internals.unconfirmedCode("cancel")).toBe("CANCEL_UNCONFIRMED");
    expect(internals.unconfirmedCode("interrupt")).toBe("INTERRUPT_UNCONFIRMED");
  });

  it("covers both bounded timer branches without leaving a timer armed", () => {
    let callback: (() => void) | undefined;
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation((handler) => {
      callback = handler as () => void;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });
    const clear = vi.spyOn(globalThis, "clearTimeout");
    const bounded = internals.boundedSignal();
    callback?.();
    bounded.dispose();
    expect(clear).toHaveBeenCalledWith(1);
    timer.mockRestore();
    clear.mockRestore();
  });
});

describe("explicit turn control", () => {
  it("resolves identity, dispatches exactly one Escape, waits, and confirms cancel", async () => {
    const harness = makeCli(snapshot(workerPane("idle", 11)));
    const result = await execute(harness.cli, { target: "worker", operation: "cancel" });
    expect(harness.calls).toEqual([
      ["api", "snapshot"],
      ["agent", "get", "w1:p2"],
      ["agent", "send-keys", "w1:p2", "esc"],
      ["agent", "wait", "w1:p2", "--until", "idle", "--until", "blocked", "--until", "done", "--until", "unknown", "--timeout", "5000"],
      ["api", "snapshot"]
    ]);
    expect(harness.calls.filter((call) => call[0] === "agent" && call[1] === "send-keys")).toHaveLength(1);
    expect(result.details).toMatchObject({
      operation: "cancel",
      outcome: "cancelled",
      target: { paneId: "w1:p2", terminalId: "term-worker" },
      phase: "confirmed",
      reason: "same_agent_terminal_state",
      dispatchAcknowledged: true,
      control: { key: "esc", windowMs: 5000 },
      confirmation: { kind: "same_agent", state: "idle", stateChangeSeq: { before: 10, after: 11 } },
      operationIds: { snapshot: "snapshot", agentGet: "agent-get", dispatch: "dispatch-1", wait: "wait-1", finalSnapshot: "snapshot" }
    });
    expect(harness.signals[2]).not.toBe(harness.signals[3]);
    expect(harness.signals[3]).not.toBe(harness.signals[4]);
  });

  it("interrupts a working agent with one ctrl+c and confirms the same agent", async () => {
    const harness = makeCli(snapshot(workerPane("blocked", 12)));
    const result = await execute(harness.cli, { target: "worker", operation: "interrupt" });
    expect(harness.calls.filter((call) => call[0] === "agent" && call[1] === "send-keys")).toEqual([["agent", "send-keys", "w1:p2", "ctrl+c"]]);
    expect(result.details).toMatchObject({ operation: "interrupt", outcome: "interrupted", reason: "same_agent_terminal_state", confirmation: { kind: "same_agent", state: "blocked" }, control: { key: "ctrl+c", windowMs: 5000 } });
  });

  it("rejects a non-working target before dispatch", async () => {
    const initial = snapshot(workerPane("idle"));
    const harness = makeCli(initial, { initialSnapshot: initial });
    await expect(execute(harness.cli, { target: "worker", operation: "cancel" })).rejects.toMatchObject({ code: "TURN_NOT_ACTIVE", details: { phase: "pre_state" } });
    expect(harness.calls.some((call) => call[1] === "send-keys")).toBe(false);
  });

  it("denies a leaf worker turn control before any target state read or dispatch", async () => {
    const callerSession = { source: "herdr:devin", agent: "devin", kind: "id", value: "session-caller" };
    const leafCallerPane = { ...callerPane, agent_session: callerSession, tokens: { identity_provenance: "launched", identity_actor: "w1:pM", identity_session: "session-caller" } };
    const managerPane = { pane_id: "w1:pM", tab_id: "w1:t1", workspace_id: "w1", label: "manager", agent_status: "idle" };
    const leafSnapshot: HerdrSnapshot = {
      ...snapshot(workerPane("working")),
      panes: [leafCallerPane, workerPane("working"), managerPane],
      agents: [
        { pane_id: "w1:p1", name: "caller", agent_status: "idle", agent_session: callerSession },
        workerAgent("working"),
        { pane_id: "w1:pM", name: "manager", agent_status: "idle" }
      ]
    };
    for (const operation of ["cancel", "interrupt"] as const) {
      const harness = makeCli(leafSnapshot, { initialSnapshot: leafSnapshot });
      await expect(execute(harness.cli, { target: "worker", operation })).rejects.toMatchObject({
        code: "TARGET_SCOPE_REJECTED",
        details: { phase: "caller_policy", callerPolicy: { operation, callerPaneId: "w1:p1", parentPaneId: "w1:pM" } }
      });
      expect(harness.calls).toEqual([["api", "snapshot"]]);
    }
  });

  it("fails closed when caller-policy evidence is unusable", async () => {
    const unverifiableSession = { ...callerPane, tokens: { identity_provenance: "launched", identity_actor: "w1:pM", identity_session: "session-caller" } };
    const leafSnapshot: HerdrSnapshot = {
      ...snapshot(workerPane("working")),
      panes: [unverifiableSession, workerPane("working"), { pane_id: "w1:pM", tab_id: "w1:t1", workspace_id: "w1", label: "manager", agent_status: "idle" }],
      agents: [
        { pane_id: "w1:p1", name: "caller", agent_status: "idle" },
        workerAgent("working"),
        { pane_id: "w1:pM", name: "manager", agent_status: "idle" }
      ]
    };
    const harness = makeCli(leafSnapshot, { initialSnapshot: leafSnapshot });
    await expect(execute(harness.cli, { target: "worker", operation: "cancel" })).rejects.toMatchObject({
      code: "TARGET_SCOPE_REJECTED",
      details: { phase: "caller_policy", callerPolicy: { reason: "session_unverifiable" } }
    });

    const contradictoryCaller = { ...callerPane, tokens: { identity_provenance: "launched" } };
    const contradictorySnapshot: HerdrSnapshot = {
      ...leafSnapshot,
      panes: [contradictoryCaller, workerPane("working")],
      agents: [
        { pane_id: "w1:p1", name: "caller", agent_status: "idle", tokens: { identity_provenance: "adopted" } },
        workerAgent("working"),
        { pane_id: "w1:pM", name: "manager", agent_status: "idle" }
      ]
    };
    const contradictory = makeCli(contradictorySnapshot, { initialSnapshot: contradictorySnapshot });
    await expect(execute(contradictory.cli, { target: "worker", operation: "cancel" })).rejects.toMatchObject({
      code: "CALLER_POLICY_UNAVAILABLE",
      details: { phase: "caller_policy", callerPolicy: { reason: "provenance_contradictory" } }
    });
    expect(contradictory.calls).toEqual([["api", "snapshot"]]);
  });

  it("requires a complete stable identity and rejects identity changes", async () => {
    const missingInitial = snapshot(workerPane("working", 10, { agent_session: undefined }), workerAgent("working", 10, { agent_session: undefined }));
    const missing = makeCli(missingInitial, { initialSnapshot: missingInitial });
    await expect(execute(missing.cli, { target: "worker", operation: "cancel" })).rejects.toMatchObject({ code: "TARGET_IDENTITY_UNAVAILABLE" });

    const changed = makeCli(snapshot(workerPane("idle", 11)));
    changed.runJson.mockImplementation(async (argv: string[]) => {
      changed.calls.push(argv);
      if (argv[0] === "pane" && argv[1] === "current") return envelope("current", { type: "pane_current", pane: callerPane });
      if (argv[0] === "api") return resultForSnapshot(snapshot());
      if (argv[0] === "agent" && argv[1] === "get") return responseForAgent(workerAgent("working", 10, { terminal_id: "term-replaced" }));
      throw new Error(`unexpected ${argv.join(" ")}`);
    });
    await expect(execute(changed.cli, { target: "worker", operation: "interrupt" })).rejects.toMatchObject({ code: "TARGET_IDENTITY_CHANGED" });
    expect(changed.calls.some((call) => call[1] === "send-keys")).toBe(false);
  });

  it("requires exactly one pre-dispatch pane and agent record and rejects contradictions without a key", async () => {
    const missingPane = snapshot(workerPane("working"));
    missingPane.panes = [callerPane as never];
    const targetAgent = { ...workerAgent("working"), agent_id: "agent-worker" };
    missingPane.agents = [missingPane.agents[0]!, targetAgent as never];
    const missingPaneHarness = makeCli(snapshot(workerPane("idle", 11)), { initialSnapshot: missingPane });
    await expect(execute(missingPaneHarness.cli, { target: "agent-worker", operation: "cancel" })).rejects.toMatchObject({ code: "TARGET_IDENTITY_UNAVAILABLE" });
    expect(missingPaneHarness.calls.some((call) => call[1] === "send-keys")).toBe(false);

    const missingAgent = snapshot(workerPane("working"), null);
    expect(internals.snapshotTargetRecords(missingAgent, "w1:p2")).toMatchObject({ paneCount: 1, agentCount: 0 });
    const duplicatePane = snapshot(workerPane("working"), workerAgent("working"));
    duplicatePane.panes.push({ ...duplicatePane.panes[1]! } as never);
    const duplicatePaneHarness = makeCli(snapshot(workerPane("idle", 11)), { initialSnapshot: duplicatePane });
    await expect(execute(duplicatePaneHarness.cli, { target: "w1:p2", operation: "interrupt" })).rejects.toMatchObject({ code: "TARGET_IDENTITY_UNAVAILABLE" });
    expect(duplicatePaneHarness.calls.some((call) => call[1] === "send-keys")).toBe(false);

    const duplicateAgent = snapshot(workerPane("working"), workerAgent("working"));
    duplicateAgent.agents.push({ ...duplicateAgent.agents[1]! } as never);
    const duplicateAgentHarness = makeCli(snapshot(workerPane("idle", 11)), { initialSnapshot: duplicateAgent });
    await expect(execute(duplicateAgentHarness.cli, { target: "w1:p2", operation: "cancel" })).rejects.toMatchObject({ code: "TARGET_IDENTITY_UNAVAILABLE" });
    expect(duplicateAgentHarness.calls.some((call) => call[1] === "send-keys")).toBe(false);

    for (const contradiction of [
      { pane: { agent_name: "different" } },
      { agent: { terminal_id: "different" } },
      { agent: { name: "different" } },
      { agent: { agent: "claude" } },
      { agent: { agent_session: { ...identity.agent_session, value: "different" } } },
      { agent: { agent_status: "idle" } }
    ]) {
      const initial = snapshot(workerPane("working", 10, contradiction.pane), workerAgent("working", 10, contradiction.agent));
      const harness = makeCli(snapshot(workerPane("idle", 11)), { initialSnapshot: initial });
      await expect(execute(harness.cli, { target: "w1:p2", operation: "cancel" })).rejects.toMatchObject({ code: "TARGET_IDENTITY_CHANGED" });
      expect(harness.calls.some((call) => call[1] === "send-keys")).toBe(false);
    }
  });

  it("requires fresh agent-get evidence to carry the captured pane ID", async () => {
    const missing = makeCli(snapshot(workerPane("idle", 11)));
    const missingBase = missing.runJson.getMockImplementation()!;
    missing.runJson.mockImplementation(async (argv: string[], signal: AbortSignal) => argv[0] === "agent" && argv[1] === "get"
      ? responseForAgent(workerAgent("working", 10, { pane_id: undefined }))
      : missingBase(argv, signal));
    await expect(execute(missing.cli, { target: "worker", operation: "cancel" })).rejects.toMatchObject({ code: "TARGET_IDENTITY_UNAVAILABLE" });
    expect(missing.calls.filter((call) => call[0] === "agent" && call[1] === "send-keys")).toHaveLength(0);

    const changed = makeCli(snapshot(workerPane("idle", 11)));
    const changedBase = changed.runJson.getMockImplementation()!;
    changed.runJson.mockImplementation(async (argv: string[], signal: AbortSignal) => argv[0] === "agent" && argv[1] === "get"
      ? responseForAgent(workerAgent("working", 10, { pane_id: "w1:p3" }))
      : changedBase(argv, signal));
    await expect(execute(changed.cli, { target: "worker", operation: "interrupt" })).rejects.toMatchObject({ code: "TARGET_IDENTITY_CHANGED" });
    expect(changed.calls.filter((call) => call[0] === "agent" && call[1] === "send-keys")).toHaveLength(0);
  });

  it("always reads a final snapshot and never confirms cancel when the pane disappears", async () => {
    const harness = makeCli(snapshot(null, null));
    await expect(execute(harness.cli, { target: "worker", operation: "cancel" })).rejects.toMatchObject({ code: "CANCEL_UNCONFIRMED", details: { phase: "final_snapshot", finalEvidence: { pane: "absent" }, dispatchAcknowledged: true } });
    expect(harness.calls.at(-1)).toEqual(["api", "snapshot"]);
  });

  it("reports interrupt agent exit only from acknowledged dispatch and strict absence proof", async () => {
    const exitedPane = { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", label: "worker", terminal_id: "term-worker", agent_status: "unknown" };
    const exited = makeCli(snapshot(exitedPane, null), { waitError: Object.assign(new Error("timeout"), { code: "CLI_TIMEOUT" }) });
    const result = await execute(exited.cli, { target: "worker", operation: "interrupt" });
    expect(result.details).toMatchObject({ outcome: "agent_exited", reason: "post_dispatch_absence_proven", dispatchAcknowledged: true, confirmation: { kind: "agent_exited", causality: "post_dispatch_absence_proven" } });

    const elsewhere = [
      { pane_id: "w1:p3", agent_session: "session-worker" },
      { pane_id: "w1:p3", agent_session_id: "session-worker" },
      { pane_id: "w1:p3", session_id: "session-worker" },
      { pane_id: "w1:p3", agent_session_source: "pi", agent_session_agent: "pi", agent_session_kind: "id", agent_session_value: "session-worker" },
      { pane_id: "w1:p3", agent_session: { source: "pi", agent: "pi", kind: "id" } },
      { pane_id: "w1:p3", agent_session: { source: "pi", agent: "pi", kind: "id", value: "replacement" }, agent_session_id: "session-worker" }
    ];
    for (const evidence of elsewhere) {
      const final = snapshot(exitedPane, null);
      final.panes.push(evidence as never);
      const blocked = makeCli(final);
      await expect(execute(blocked.cli, { target: "worker", operation: "interrupt" })).rejects.toMatchObject({ code: "INTERRUPT_UNCONFIRMED" });
      expect(blocked.calls.filter((call) => call[0] === "agent" && call[1] === "send-keys")).toHaveLength(1);
    }

    const agentRecordEvidence = snapshot(exitedPane, null);
    agentRecordEvidence.agents.push({ pane_id: "w1:p3", session_id: "session-worker" } as never);
    const blockedByAgentRecord = makeCli(agentRecordEvidence);
    await expect(execute(blockedByAgentRecord.cli, { target: "worker", operation: "interrupt" })).rejects.toMatchObject({ code: "INTERRUPT_UNCONFIRMED" });

    const lost = makeCli(snapshot(exitedPane, null), { dispatchError: Object.assign(new Error("aborted"), { code: "ABORTED" }) });
    await expect(execute(lost.cli, { target: "worker", operation: "interrupt" })).rejects.toMatchObject({ code: "INTERRUPT_UNCONFIRMED", details: { dispatchAcknowledged: false } });
  });

  it("rejects duplicate exit records before scanning global absence", async () => {
    const exitedPane = { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", label: "worker", terminal_id: "term-worker", agent_status: "unknown" };
    const duplicatePane = snapshot(exitedPane, null);
    duplicatePane.panes.push({ ...exitedPane, agent_session: "session-worker" } as never);
    const duplicatePaneHarness = makeCli(duplicatePane);
    await expect(execute(duplicatePaneHarness.cli, { target: "worker", operation: "interrupt" })).rejects.toMatchObject({
      code: "INTERRUPT_UNCONFIRMED",
      details: { targetPaneRecordCount: 2, targetAgentRecordCount: 0, confirmation: { kind: "unconfirmed" } }
    });

    const duplicateAgent = snapshot(exitedPane, null);
    duplicateAgent.agents.push({ pane_id: "w1:p2", session_id: "session-worker" } as never);
    const duplicateAgentHarness = makeCli(duplicateAgent);
    await expect(execute(duplicateAgentHarness.cli, { target: "worker", operation: "interrupt" })).rejects.toMatchObject({
      code: "INTERRUPT_UNCONFIRMED",
      details: { targetPaneRecordCount: 1, targetAgentRecordCount: 1, confirmation: { kind: "unconfirmed" } }
    });
    expect(duplicatePaneHarness.calls.filter((call) => call[0] === "agent" && call[1] === "send-keys")).toEqual([["agent", "send-keys", "w1:p2", "ctrl+c"]]);
    expect(duplicateAgentHarness.calls.filter((call) => call[0] === "agent" && call[1] === "send-keys")).toEqual([["agent", "send-keys", "w1:p2", "ctrl+c"]]);
  });

  it("bounds every turn-control operation ID at the Pi result surface", async () => {
    const harness = makeCli(snapshot(workerPane("idle", 11)));
    const base = harness.runJson.getMockImplementation()!;
    const oversized = "operation-" + "x".repeat(400);
    harness.runJson.mockImplementation(async (argv: string[], signal: AbortSignal) => {
      const response = await base(argv, signal);
      return { ...response, id: oversized };
    });
    const result = await execute(harness.cli, { target: "worker", operation: "cancel" });
    expect(result.details.operationIds).toEqual({ snapshot: oversized.slice(0, 256), agentGet: oversized.slice(0, 256), dispatch: oversized.slice(0, 256), wait: oversized.slice(0, 256), finalSnapshot: oversized.slice(0, 256) });
    expect(JSON.stringify(result)).not.toContain(oversized);
  });

  it("requires exactly one same-agent record for final confirmation", async () => {
    const finalMissingAgent = makeCli(snapshot(workerPane("idle", 11), null));
    await expect(execute(finalMissingAgent.cli, { target: "worker", operation: "cancel" })).rejects.toMatchObject({ code: "CANCEL_UNCONFIRMED", details: { targetAgentRecordCount: 0 } });

    const finalDuplicatePane = snapshot(workerPane("idle", 11));
    finalDuplicatePane.panes.push({ ...finalDuplicatePane.panes[1]! } as never);
    const duplicatePaneHarness = makeCli(finalDuplicatePane);
    await expect(execute(duplicatePaneHarness.cli, { target: "worker", operation: "cancel" })).rejects.toMatchObject({ code: "CANCEL_UNCONFIRMED", details: { targetPaneRecordCount: 2 } });

    const finalDuplicateAgent = snapshot(workerPane("idle", 11));
    finalDuplicateAgent.agents.push({ ...finalDuplicateAgent.agents[1]! } as never);
    const duplicateAgentHarness = makeCli(finalDuplicateAgent);
    await expect(execute(duplicateAgentHarness.cli, { target: "worker", operation: "cancel" })).rejects.toMatchObject({ code: "CANCEL_UNCONFIRMED", details: { targetAgentRecordCount: 2 } });

    const contradiction = snapshot(workerPane("idle", 11), workerAgent("idle", 11, { agent: "claude" }));
    const contradictionHarness = makeCli(contradiction);
    await expect(execute(contradictionHarness.cli, { target: "worker", operation: "cancel" })).rejects.toMatchObject({ code: "TARGET_IDENTITY_CHANGED" });
  });

  it("preserves post-dispatch evidence for final identity, state, and sequence contradictions", async () => {
    const cases = [
      {
        final: snapshot(workerPane("idle", 11), workerAgent("idle", 11, { terminal_id: "term-replaced" })),
        code: "TARGET_IDENTITY_CHANGED",
        message: "Authoritative prompt identity is contradictory",
        originalDetails: { field: "terminal_id", expected: "term-worker", actual: "term-replaced" }
      },
      {
        final: snapshot(workerPane("idle", 11), workerAgent("done", 11)),
        code: "TARGET_IDENTITY_CHANGED",
        message: "Authoritative target state is contradictory",
        originalDetails: { expectedState: "idle", actualState: "done" }
      },
      {
        final: snapshot(workerPane("idle", 11), workerAgent("idle", 12)),
        code: "TARGET_IDENTITY_CHANGED",
        message: "Authoritative target evidence is contradictory",
        originalDetails: { field: "state_change_seq" }
      },
      {
        final: snapshot(workerPane("idle", 11, { state_change_seq: "invalid" }), workerAgent("idle", 11, { state_change_seq: "invalid" })),
        code: "TARGET_STATE_UNAVAILABLE",
        message: "Authoritative target state-change sequence is invalid",
        originalDetails: {}
      }
    ] as const;

    for (const testCase of cases) {
      const harness = makeCli(testCase.final, { dispatchError: Object.assign(new Error("dispatch lost"), { code: "ABORTED" }) });
      await expect(execute(harness.cli, { target: "worker", operation: "cancel" })).rejects.toMatchObject({
        code: testCase.code,
        message: testCase.message,
        details: {
          ...testCase.originalDetails,
          phase: "confirmation",
          preEvidence: expect.objectContaining({ pane_id: "w1:p2", agent_status: "working" }),
          finalEvidence: expect.objectContaining({ pane_id: "w1:p2", agent_status: "idle" }),
          dispatchAcknowledged: false,
          dispatchAttempted: true,
          wait: { outcome: "completed" },
          dispatch: { outcome: "failed", code: "ABORTED" }
        }
      });
    }
  });

  it("preserves post-dispatch evidence when wait fails and confirms from final state", async () => {
    const harness = makeCli(snapshot(workerPane("done", 11)), { waitError: Object.assign(new Error("wait timed out"), { code: "CLI_TIMEOUT" }) });
    const result = await execute(harness.cli, { target: "worker", operation: "cancel" });
    expect(result.details).toMatchObject({ outcome: "cancelled", reason: "same_agent_terminal_state", dispatchAcknowledged: true, wait: { outcome: "failed", code: "CLI_TIMEOUT" }, finalEvidence: { agent_status: "done" } });
  });

  it("keeps independent verification after a successful dispatch aborts the caller", async () => {
    const controller = new AbortController();
    const harness = makeCli(snapshot(workerPane("idle", 11)));
    const base = harness.runJson.getMockImplementation()!;
    harness.runJson.mockImplementation(async (argv: string[], signal: AbortSignal) => {
      const response = await base(argv, signal);
      if (argv[0] === "agent" && argv[1] === "send-keys") controller.abort();
      return response;
    });
    const result = await execute(harness.cli, { target: "worker", operation: "cancel" }, controller.signal);
    expect(result.details).toMatchObject({
      outcome: "cancelled",
      dispatchAcknowledged: true,
      dispatchAttempted: true,
      dispatch: { outcome: "acknowledged" },
      operationIds: { dispatch: "dispatch-1", finalSnapshot: "snapshot" }
    });
    expect(harness.calls.filter((call) => call[0] === "agent" && call[1] === "send-keys")).toEqual([["agent", "send-keys", "w1:p2", "esc"]]);
    expect(harness.calls.at(-1)).toEqual(["api", "snapshot"]);
    expect(harness.signals[2]).toBe(controller.signal);
    expect(harness.signals[3]).not.toBe(controller.signal);
    expect(harness.signals[4]).not.toBe(controller.signal);
    expect(harness.signals[3]?.aborted).toBe(false);
    expect(harness.signals[4]?.aborted).toBe(false);
  });

  it("fails closed for unknown and malformed fresh states", async () => {
    const unknownInitial = snapshot(workerPane("unknown"), workerAgent("unknown"));
    await expect(execute(makeCli(unknownInitial, { initialSnapshot: unknownInitial }).cli, { target: "worker", operation: "cancel" })).rejects.toMatchObject({ code: "TARGET_STATE_UNKNOWN" });
    const malformedInitial = snapshot(workerPane("working", 10, { agent_status: undefined }), workerAgent("working", 10, { agent_status: undefined }));
    await expect(execute(makeCli(malformedInitial, { initialSnapshot: malformedInitial }).cli, { target: "worker", operation: "cancel" })).rejects.toMatchObject({ code: "TARGET_STATE_UNAVAILABLE" });

    const freshUnknown = makeCli(snapshot(workerPane("idle", 11)));
    const freshBase = freshUnknown.runJson.getMockImplementation()!;
    freshUnknown.runJson.mockImplementation(async (argv: string[], signal: AbortSignal) => argv[0] === "agent" && argv[1] === "get" ? responseForAgent(workerAgent("unknown")) : freshBase(argv, signal));
    await expect(execute(freshUnknown.cli, { target: "worker", operation: "cancel" })).rejects.toMatchObject({ code: "TARGET_STATE_UNKNOWN" });
  });

  it("refuses fresh identity and sequence evidence that cannot be bound", async () => {
    const missingFresh = makeCli(snapshot(workerPane("idle", 11)));
    const missingBase = missingFresh.runJson.getMockImplementation()!;
    missingFresh.runJson.mockImplementation(async (argv: string[], signal: AbortSignal) => argv[0] === "agent" && argv[1] === "get" ? responseForAgent(workerAgent("working", 10, { agent_session: undefined })) : missingBase(argv, signal));
    await expect(execute(missingFresh.cli, { target: "worker", operation: "cancel" })).rejects.toMatchObject({ code: "TARGET_IDENTITY_UNAVAILABLE" });

    const noSequence = snapshot(workerPane("working", 10, { state_change_seq: undefined }), workerAgent("working", 10, { state_change_seq: undefined }));
    const noSequenceHarness = makeCli(noSequence, { initialSnapshot: noSequence });
    const noSequenceBase = noSequenceHarness.runJson.getMockImplementation()!;
    noSequenceHarness.runJson.mockImplementation(async (argv: string[], signal: AbortSignal) => argv[0] === "agent" && argv[1] === "get" ? responseForAgent(workerAgent("working", 10, { state_change_seq: undefined })) : noSequenceBase(argv, signal));
    await expect(execute(noSequenceHarness.cli, { target: "worker", operation: "cancel" })).rejects.toMatchObject({ code: "TARGET_IDENTITY_UNAVAILABLE" });
  });

  it("rejects a regressed fresh sequence before dispatch", async () => {
    const initial = snapshot(workerPane("working", 10), workerAgent("working", 10));
    const final = snapshot(workerPane("idle", 10), workerAgent("idle", 10));
    const harness = makeCli(final, { initialSnapshot: initial });
    const base = harness.runJson.getMockImplementation()!;
    harness.runJson.mockImplementation(async (argv: string[], signal: AbortSignal) => argv[0] === "agent" && argv[1] === "get"
      ? responseForAgent(workerAgent("working", 9))
      : base(argv, signal));
    await expect(execute(harness.cli, { target: "worker", operation: "cancel" })).rejects.toMatchObject({
      code: "TARGET_STATE_UNAVAILABLE",
      details: { phase: "identity", stateChangeSeq: { snapshot: 10, fresh: 9 } }
    });
    expect(harness.calls).toEqual([["api", "snapshot"]]);
    expect(harness.calls.filter((call) => call[0] === "agent" && call[1] === "send-keys")).toHaveLength(0);
  });

  it("binds confirmation to the freshest non-regressed sequence", async () => {
    const initial = snapshot(workerPane("working", 10), workerAgent("working", 10));
    const final = snapshot(workerPane("idle", 12), workerAgent("idle", 12));
    const harness = makeCli(final, { initialSnapshot: initial });
    const base = harness.runJson.getMockImplementation()!;
    harness.runJson.mockImplementation(async (argv: string[], signal: AbortSignal) => argv[0] === "agent" && argv[1] === "get"
      ? responseForAgent(workerAgent("working", 11))
      : base(argv, signal));
    const result = await execute(harness.cli, { target: "worker", operation: "cancel" });
    expect(result.details).toMatchObject({ confirmation: { stateChangeSeq: { before: 11, after: 12 } } });
  });

  it("retains an unacknowledged dispatch failure alongside independent confirmation", async () => {
    const harness = makeCli(snapshot(workerPane("idle", 11)), { dispatchError: Object.assign(new Error("dispatch lost"), { code: "ABORTED" }) });
    const result = await execute(harness.cli, { target: "worker", operation: "cancel" });
    expect(result.details).toMatchObject({ outcome: "cancelled", dispatchAcknowledged: false, dispatch: { outcome: "failed", code: "ABORTED" } });
  });

  it("uses the snapshot sequence when fresh agent sequence is absent", async () => {
    const initial = snapshot(workerPane("working", 10), workerAgent("working", 10));
    const final = snapshot(workerPane("idle", 11), workerAgent("idle", 11));
    const harness = makeCli(final, { initialSnapshot: initial });
    const base = harness.runJson.getMockImplementation()!;
    harness.runJson.mockImplementation(async (argv: string[], signal: AbortSignal) => argv[0] === "agent" && argv[1] === "get" ? responseForAgent(workerAgent("working", undefined as never, { state_change_seq: undefined })) : base(argv, signal));
    const result = await execute(harness.cli, { target: "worker", operation: "cancel" });
    expect(result.details).toMatchObject({ outcome: "cancelled", confirmation: { stateChangeSeq: { before: 10, after: 11 } } });
  });

  it("preserves final-snapshot failure and post-dispatch confirmation races", async () => {
    const finalFailure = makeCli(snapshot(workerPane("idle", 11)));
    const finalBase = finalFailure.runJson.getMockImplementation()!;
    let apiReads = 0;
    finalFailure.runJson.mockImplementation(async (argv: string[], signal: AbortSignal) => {
      if (argv[0] === "api") {
        apiReads += 1;
        if (apiReads === 2) throw new Error("final snapshot unavailable");
      }
      return finalBase(argv, signal);
    });
    await expect(execute(finalFailure.cli, { target: "worker", operation: "cancel" })).rejects.toMatchObject({ code: "CANCEL_UNCONFIRMED", details: { finalEvidence: { status: "unavailable", error: { code: "unknown" } } } });

    const cancelFree = makeCli(snapshot({ pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", terminal_id: "term-worker", agent_status: "unknown" }, null));
    await expect(execute(cancelFree.cli, { target: "worker", operation: "cancel" })).rejects.toMatchObject({ code: "CANCEL_UNCONFIRMED" });

    const missingFinalIdentity = makeCli(snapshot(workerPane("idle", 11, { agent_session: undefined }), workerAgent("idle", 11, { agent_session: undefined })));
    await expect(execute(missingFinalIdentity.cli, { target: "worker", operation: "cancel" })).rejects.toMatchObject({ code: "TARGET_IDENTITY_UNAVAILABLE" });

    const changedSession = { source: "pi", agent: "pi", kind: "id", value: "replacement" };
    const changedFinal = makeCli(snapshot(workerPane("idle", 11, { agent_session: changedSession }), workerAgent("idle", 11, { agent_session: changedSession })));
    await expect(execute(changedFinal.cli, { target: "worker", operation: "cancel" })).rejects.toMatchObject({ code: "TARGET_IDENTITY_CHANGED" });

    const staleFinal = makeCli(snapshot(workerPane("idle", 10)));
    await expect(execute(staleFinal.cli, { target: "worker", operation: "cancel" })).rejects.toMatchObject({ code: "CANCEL_UNCONFIRMED", details: { phase: "confirmation" } });
    const stillWorking = makeCli(snapshot(workerPane("working", 11)));
    await expect(execute(stillWorking.cli, { target: "worker", operation: "cancel" })).rejects.toMatchObject({ code: "CANCEL_UNCONFIRMED" });
    const missingFinalSequence = makeCli(snapshot(workerPane("idle", 11, { state_change_seq: undefined }), workerAgent("idle", 11, { state_change_seq: undefined })));
    await expect(execute(missingFinalSequence.cli, { target: "worker", operation: "cancel" })).rejects.toMatchObject({ code: "CANCEL_UNCONFIRMED" });

    const movedFinal = makeCli(snapshot(workerPane("idle", 11, { tab_id: "w1:t2" }), workerAgent("idle", 11, { tab_id: "w1:t2" })));
    await expect(execute(movedFinal.cli, { target: "worker", operation: "cancel" })).rejects.toMatchObject({ code: "CANCEL_UNCONFIRMED" });
    const movedInterrupt = makeCli(snapshot(workerPane("idle", 11, { tab_id: "w1:t2" }), workerAgent("idle", 11, { tab_id: "w1:t2" })));
    await expect(execute(movedInterrupt.cli, { target: "worker", operation: "interrupt" })).rejects.toMatchObject({ code: "INTERRUPT_UNCONFIRMED" });
    const interruptFinalFailure = makeCli(snapshot(workerPane("idle", 11)));
    const interruptBase = interruptFinalFailure.runJson.getMockImplementation()!;
    let interruptApis = 0;
    interruptFinalFailure.runJson.mockImplementation(async (argv: string[], signal: AbortSignal) => {
      if (argv[0] === "api" && ++interruptApis === 2) throw new Error("final unavailable");
      return interruptBase(argv, signal);
    });
    await expect(execute(interruptFinalFailure.cli, { target: "worker", operation: "interrupt" })).rejects.toMatchObject({ code: "INTERRUPT_UNCONFIRMED" });
  });

  it("handles aborts before preflight, after preflight, and after identity without dispatch", async () => {
    const before = new AbortController();
    before.abort();
    const beforeHarness = makeCli(snapshot(workerPane("idle", 11)));
    await expect(execute(beforeHarness.cli, { target: "worker", operation: "cancel" }, before.signal)).rejects.toMatchObject({ code: "ABORTED" });

    const duringPreflight = new AbortController();
    const preflightTool = createCommunicateTool({ cli: makeCli(snapshot(workerPane("idle", 11))).cli, context: { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" }, preflight: async () => duringPreflight.abort() });
    await expect(preflightTool.execute("id", { target: "worker", operation: "cancel" } as never, duringPreflight.signal, undefined, { signal: duringPreflight.signal } as unknown as ExtensionContext)).rejects.toMatchObject({ code: "ABORTED" });

    const afterIdentity = new AbortController();
    const identityHarness = makeCli(snapshot(workerPane("idle", 11)));
    const identityBase = identityHarness.runJson.getMockImplementation()!;
    identityHarness.runJson.mockImplementation(async (argv: string[], signal: AbortSignal) => {
      const response = await identityBase(argv, signal);
      if (argv[0] === "agent" && argv[1] === "get") afterIdentity.abort();
      return response;
    });
    await expect(execute(identityHarness.cli, { target: "worker", operation: "cancel" }, afterIdentity.signal)).rejects.toMatchObject({ code: "ABORTED" });

    const plainTool = createCommunicateTool({ cli: makeCli(snapshot(workerPane("idle", 11))).cli, context: { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" }, preflight: async () => { throw "plain preflight failure"; } });
    await expect(plainTool.execute("id", { target: "worker", operation: "cancel" } as never, new AbortController().signal, undefined, { signal: new AbortController().signal } as unknown as ExtensionContext)).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR", details: { reason: "plain preflight failure" } });
  });

  it("renders compact turn-control call and result rows", () => {
    const harness = makeCli(snapshot(workerPane("idle", 11)));
    const tool = createCommunicateTool({ cli: harness.cli, context: { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" }, preflight: async () => undefined });
    const call = tool.renderCall?.({ target: "worker", operation: "cancel" } as never, {} as never, {} as never);
    expect(call?.render(80)).toEqual(["herdr_communicate · cancel · worker"]);
    call?.invalidate();
    const result = tool.renderResult?.({ content: [], details: { operation: "cancel", outcome: "cancelled", target: { paneId: "w1:p2" }, preState: {}, finalState: { agent_status: "idle" }, preEvidence: {}, finalEvidence: {}, phase: "confirmed", reason: "same_agent_terminal_state", dispatchAcknowledged: true, dispatchAttempted: true, operationIds: {}, control: { key: "esc", windowMs: 5000 }, confirmation: { kind: "same_agent", state: "idle" } }, isError: false } as never, {} as never, {} as never, {} as never);
    expect(result?.render(80)).toEqual(["cancelled · w1:p2 · idle"]);
    result?.invalidate();
  });

  it("aborts before dispatch without reading final state", async () => {
    const controller = new AbortController();
    controller.abort();
    const harness = makeCli(snapshot(workerPane("idle", 11)));
    await expect(execute(harness.cli, { target: "worker", operation: "cancel" }, controller.signal)).rejects.toMatchObject({ code: "ABORTED" });
    expect(harness.calls).toEqual([]);
  });
});

describe("lazy target adoption in turn control", () => {
  /** A detected worker whose only missing join field is the agent name. */
  function adoptTurnCli(options: { kind?: string; nameTaken?: boolean } = {}) {
    const kind = options.kind ?? "pi";
    const session = { source: kind, agent: kind, kind: "id", value: "session-worker" };
    const renames: string[][] = [];
    let minted: string | undefined;
    let dispatched = false;
    const pane = () => ({
      pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", label: "worker", agent: kind,
      agent_status: dispatched ? "idle" : "working", state_change_seq: dispatched ? 11 : 10,
      terminal_id: "term-worker", agent_session: session,
      ...(minted === undefined ? {} : { agent_name: minted })
    });
    const agent = () => ({
      pane_id: "w1:p2", agent: kind, agent_status: dispatched ? "idle" : "working", state_change_seq: dispatched ? 11 : 10,
      terminal_id: "term-worker", agent_session: session,
      ...(minted === undefined ? {} : { name: minted })
    });
    const snap = (): HerdrSnapshot => ({
      version: "0.8.2", protocol: 22,
      workspaces: [{ workspace_id: "w1", label: "workspace" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main" }],
      panes: [callerPane as never, pane() as never],
      agents: [{ pane_id: "w1:p1", name: "caller", agent_status: "idle" } as never, agent() as never]
    });
    const runJson = vi.fn(async (argv: string[]): Promise<JsonEnvelope> => {
      const key = argv.join(" ");
      if (argv[0] === "pane" && argv[1] === "current") return envelope("current", { type: "pane_current", pane: callerPane });
      if (key.startsWith("agent rename")) {
        renames.push(argv);
        if (options.nameTaken) throw new CliProtocolError("CLI_PROTOCOL_ERROR", "taken", { errorEnvelope: { id: "x", error: { code: "agent_name_taken", message: "taken" } } });
        minted = argv[3];
        return envelope("rename", { type: "agent_info", agent: { ...agent(), name: argv[3] } });
      }
      if (key.startsWith("pane report-metadata")) return envelope("meta", { ok: true });
      if (argv[0] === "api") return resultForSnapshot(snap());
      if (argv[0] === "pane" && argv[1] === "get") return envelope("pane-get", { pane: pane() });
      if (argv[0] === "agent" && argv[1] === "get") return envelope("agent-get", { agent: agent() });
      if (argv[0] === "agent" && argv[1] === "send-keys") { dispatched = true; return envelope("dispatch-1", { ok: true }); }
      if (argv[0] === "agent" && argv[1] === "wait") return envelope("wait-1", { agent: agent() });
      throw new Error(`unexpected ${argv.join(" ")}`);
    });
    return { cli: { runJson } as unknown as HerdrCli, renames };
  }

  it("mints a derived name before the control would fail closed", async () => {
    const { cli, renames } = adoptTurnCli();
    const result = await execute(cli, { target: "w1:p2", operation: "cancel" });
    expect(renames).toEqual([["agent", "rename", "w1:p2", "pi-w1p2"]]);
    expect(result.details).toMatchObject({ operation: "cancel", outcome: "cancelled", target: { paneId: "w1:p2", agentName: "pi-w1p2" } });
  });

  it("never adopts a kind outside the allowlist and still fails closed", async () => {
    const { cli, renames } = adoptTurnCli({ kind: "agy" });
    await expect(execute(cli, { target: "w1:p2", operation: "cancel" })).rejects.toMatchObject({ code: "TARGET_IDENTITY_UNAVAILABLE" });
    expect(renames).toEqual([]);
  });

  it("fails closed when every derived name is already held", async () => {
    const { cli, renames } = adoptTurnCli({ nameTaken: true });
    await expect(execute(cli, { target: "w1:p2", operation: "cancel" })).rejects.toMatchObject({ code: "TARGET_IDENTITY_UNAVAILABLE" });
    expect(renames.length).toBeGreaterThan(1);
  });
});
