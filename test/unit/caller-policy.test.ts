import { describe, expect, it } from "vitest";
import {
  assertControlScope,
  assertSendScope,
  callerPolicyDiagnostics,
  callerPolicyFailure,
  CallerPolicyError,
  classifyCaller,
  type CallerPolicy
} from "../../src/caller-policy.js";
import type { HerdrSnapshot } from "../../src/targets.js";

function denied(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  expect.unreachable("expected a caller-policy denial");
}
const CALLER = "w1:p1";
const MANAGER = "w1:pM";
const callerSession = { source: "herdr:pi", agent: "pi", kind: "id", value: "session-caller" };
const launchedTokens = { identity_provenance: "launched", identity_actor: MANAGER, identity_session: "session-caller" };

function snap(panes: Record<string, unknown>[], agents: Record<string, unknown>[] = []): HerdrSnapshot {
  return { version: "0.9.0", protocol: 1, workspaces: [], tabs: [], panes, agents } as unknown as HerdrSnapshot;
}

function callerPane(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { pane_id: CALLER, tab_id: "w1:t1", workspace_id: "w1", label: "caller", agent_status: "idle", ...overrides };
}

function callerAgent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { pane_id: CALLER, name: "caller", agent_status: "idle", ...overrides };
}

function managerPane(): Record<string, unknown> {
  return { pane_id: MANAGER, tab_id: "w1:t1", workspace_id: "w1", label: "manager", agent_status: "idle" };
}

function launchedCaller(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return callerPane({ agent_session: callerSession, tokens: { ...launchedTokens }, ...overrides });
}

function childPane(paneId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { pane_id: paneId, tab_id: "w1:t1", workspace_id: "w1", label: "child", agent_status: "idle", tokens: { identity_provenance: "launched", identity_actor: CALLER, identity_session: "session-child" }, ...overrides };
}

describe("classifyCaller", () => {
  it("leaves detected and unmarked callers unrestricted at the legacy floor", () => {
    const policy = classifyCaller(snap([callerPane()], [callerAgent()]), CALLER);
    expect(policy).toEqual({ callerPaneId: CALLER, scope: "unrestricted", basis: "unmarked" });
    const adopted = classifyCaller(snap([callerPane({ tokens: { identity_provenance: "adopted", identity_actor: CALLER, identity_session: "s" } })]), CALLER);
    expect(adopted).toMatchObject({ scope: "unrestricted", basis: "adopted" });
    const emptyTokens = classifyCaller(snap([callerPane({ tokens: {} })]), CALLER);
    expect(emptyTokens).toMatchObject({ scope: "unrestricted", basis: "unmarked" });
  });

  it("classifies a launched pane with no recorded children as a bound leaf worker", () => {
    const policy = classifyCaller(snap([launchedCaller(), managerPane()], [callerAgent({ agent_session: callerSession })]), CALLER);
    expect(policy).toEqual({ callerPaneId: CALLER, scope: "worker", basis: "launched_leaf", binding: { status: "bound", parentPaneId: MANAGER } });
  });

  it("keeps a delegated orchestrator unrestricted before it launches its first lane", () => {
    const orchestrator = launchedCaller({ tokens: { ...launchedTokens, identity_scope: "orchestrator" } });
    const policy = classifyCaller(snap([orchestrator, managerPane()], [callerAgent({ agent_session: callerSession })]), CALLER);
    expect(policy).toEqual({ callerPaneId: CALLER, scope: "unrestricted", basis: "orchestrator", binding: { status: "bound", parentPaneId: MANAGER } });
  });

  it("binds a launched worker whose session id exceeds the token length cap", () => {
    // Pi sessions are file paths longer than the 80-char token cap; the stored
    // token is the normalized truncation, so the raw session value must be
    // normalized before comparing or every launched pi worker is session_stale.
    const longSession = "/home/user/.pi/agent/sessions/--home-user-workspace--/2026-09-12T19-14-47-776Z_01a0970b-2f60-7519-bda4-c6b538c1a470.jsonl";
    const session = { source: "herdr:pi", agent: "pi", kind: "path", value: longSession };
    const policy = classifyCaller(
      snap(
        [callerPane({ agent_session: session, tokens: { identity_provenance: "launched", identity_actor: MANAGER, identity_session: longSession.slice(0, 80) } }), managerPane()],
        [callerAgent({ agent_session: session })]
      ),
      CALLER
    );
    expect(policy).toEqual({ callerPaneId: CALLER, scope: "worker", basis: "launched_leaf", binding: { status: "bound", parentPaneId: MANAGER } });
  });

  it("still rejects a launched worker whose normalized session does not match the token", () => {
    const session = { source: "herdr:pi", agent: "pi", kind: "path", value: "/x/".repeat(30) + "current.jsonl" };
    const policy = classifyCaller(
      snap(
        [callerPane({ agent_session: session, tokens: { identity_provenance: "launched", identity_actor: MANAGER, identity_session: "stale-token" } }), managerPane()],
        [callerAgent({ agent_session: session })]
      ),
      CALLER
    );
    expect(policy).toMatchObject({ scope: "worker", binding: { status: "unavailable", reason: "session_stale" } });
  });

  it("leaves a launched caller unrestricted once it is the recorded actor of a child", () => {
    const policy = classifyCaller(snap([launchedCaller(), managerPane(), childPane("w1:p2")], [callerAgent({ agent_session: callerSession })]), CALLER);
    expect(policy).toEqual({ callerPaneId: CALLER, scope: "unrestricted", basis: "manages_children", binding: { status: "bound", parentPaneId: MANAGER } });
    // Multiple children and non-launched managers stay unrestricted.
    const unmarked = classifyCaller(snap([callerPane(), childPane("w1:p2"), childPane("w1:p3")]), CALLER);
    expect(unmarked).toMatchObject({ scope: "unrestricted", basis: "manages_children" });
  });

  it("does not elevate a caller on a self actor claim or a contradictory child record", () => {
    const selfActor = classifyCaller(snap([callerPane({ tokens: { identity_provenance: "launched", identity_actor: CALLER, identity_session: "session-caller" }, agent_session: callerSession })]), CALLER);
    expect(selfActor).toMatchObject({ scope: "worker", binding: { status: "unavailable", reason: "actor_self" } });
    const contradictoryChild = classifyCaller(snap([launchedCaller(), managerPane(), childPane("w1:p2")], [callerAgent({ agent_session: callerSession }), { pane_id: "w1:p2", name: "child", tokens: { identity_actor: "w1:pZ" } }]), CALLER);
    expect(contradictoryChild).toMatchObject({ scope: "worker", basis: "launched_leaf" });
  });

  it("fails closed when caller pane evidence is absent or ambiguous", () => {
    expect(denied(() => classifyCaller(snap([callerPane({ pane_id: "w1:pX" })]), CALLER))).toMatchObject({ code: "CALLER_POLICY_UNAVAILABLE" });
    expect(denied(() => classifyCaller(snap([callerPane(), callerPane()]), CALLER))).toMatchObject({ code: "CALLER_POLICY_UNAVAILABLE", details: { paneRecords: 2 } });
  });

  it.each([
    ["malformed", { identity_provenance: 7 }, undefined],
    ["contradictory", { identity_provenance: "launched" }, { identity_provenance: "adopted" }]
  ] as const)("fails closed on %s provenance evidence", (_label, paneTokens, agentTokens) => {
    const pane = callerPane({ tokens: paneTokens });
    const agents = agentTokens ? [callerAgent({ tokens: agentTokens })] : [callerAgent()];
    expect(denied(() => classifyCaller(snap([pane], agents), CALLER))).toMatchObject({ code: "CALLER_POLICY_UNAVAILABLE" });
  });

  it("fails closed when the tokens field itself is malformed", () => {
    expect(denied(() => classifyCaller(snap([callerPane({ tokens: "launched" })]), CALLER))).toMatchObject({ code: "CALLER_POLICY_UNAVAILABLE" });
  });

  it("fails closed on an unrecognized provenance value", () => {
    expect(denied(() => classifyCaller(snap([callerPane({ tokens: { identity_provenance: "spawned" } })]), CALLER))).toMatchObject({ code: "CALLER_POLICY_UNAVAILABLE", details: { reason: "provenance_unrecognized" } });
  });

  it.each([
    ["scope_unrecognized", { identity_scope: "manager" }, undefined],
    ["scope_malformed", { identity_scope: 7 }, undefined],
    ["scope_contradictory", { identity_scope: "orchestrator" }, { identity_scope: "worker" }],
  ] as const)("fails closed on %s evidence", (reason, paneScope, agentScope) => {
    const pane = launchedCaller({ tokens: { ...launchedTokens, ...paneScope } });
    const agents = [callerAgent({ agent_session: callerSession, ...(agentScope ? { tokens: agentScope } : {}) })];
    expect(denied(() => classifyCaller(snap([pane, managerPane()], agents), CALLER))).toMatchObject({ code: "CALLER_POLICY_UNAVAILABLE", details: { reason } });
  });

  it.each([
    ["actor_missing", { identity_actor: undefined }],
    ["actor_malformed", { identity_actor: 42 }],
    ["actor_malformed", { identity_actor: "" }],
    ["actor_malformed", { identity_actor: "x".repeat(81) }],
    ["actor_malformed", { identity_actor: "w1:pM\n" }],
    ["actor_self", { identity_actor: CALLER }],
    ["actor_stale", { identity_actor: "w1:pGONE" }],
    ["session_missing", { identity_session: undefined }],
    ["session_malformed", { identity_session: 9 }],
    ["session_stale", { identity_session: "session-other" }]
  ] as const)("reports an unavailable leaf binding for %s", (reason, tokenOverrides) => {
    const tokens: Record<string, unknown> = { ...launchedTokens };
    for (const [key, value] of Object.entries(tokenOverrides)) {
      if (value === undefined) delete tokens[key];
      else tokens[key] = value;
    }
    const policy = classifyCaller(snap([callerPane({ agent_session: callerSession, tokens }), managerPane()], [callerAgent({ agent_session: callerSession })]), CALLER);
    expect(policy).toMatchObject({ scope: "worker", binding: { status: "unavailable", reason } });
  });

  it("reports actor and session contradictions across caller records", () => {
    const actorContradiction = classifyCaller(snap([launchedCaller(), managerPane()], [callerAgent({ agent_session: callerSession, tokens: { identity_actor: "w1:pZ" } })]), CALLER);
    expect(actorContradiction).toMatchObject({ scope: "worker", binding: { status: "unavailable", reason: "actor_contradictory" } });
    const sessionContradiction = classifyCaller(snap([launchedCaller(), managerPane()], [callerAgent({ agent_session: callerSession, tokens: { identity_session: "session-other" } })]), CALLER);
    expect(sessionContradiction).toMatchObject({ scope: "worker", binding: { status: "unavailable", reason: "session_contradictory" } });
  });

  it("cannot verify the binding without a complete caller session", () => {
    for (const session of [undefined, "legacy-string", {}, { source: "s" }, { source: "", agent: "a", kind: "id", value: "v" }, { source: "s", agent: "", kind: "id", value: "v" }, { source: "s", agent: "a", kind: "", value: "v" }, { source: "s", agent: "a", kind: "id", value: "" }] as const) {
      const pane = session === undefined ? launchedCaller() : launchedCaller({ agent_session: session });
      const paneRecord = session === undefined ? (() => { const candidate = { ...pane }; delete candidate.agent_session; return candidate; })() : pane;
      const policy = classifyCaller(snap([paneRecord, managerPane()], [callerAgent()]), CALLER);
      expect(policy).toMatchObject({ scope: "worker", binding: { status: "unavailable", reason: "session_unverifiable" } });
    }
  });

  it("fails the binding on contradictory caller sessions and on a pane-reuse session mismatch", () => {
    const contradictory = classifyCaller(snap([launchedCaller(), managerPane()], [callerAgent({ agent_session: { ...callerSession, value: "session-other" } })]), CALLER);
    expect(contradictory).toMatchObject({ scope: "worker", binding: { status: "unavailable", reason: "session_contradictory" } });
    const stale = classifyCaller(snap([launchedCaller(), managerPane()], [callerAgent({ agent_session: callerSession })]), CALLER);
    expect(stale).toMatchObject({ binding: { status: "bound", parentPaneId: MANAGER } });
  });
});

describe("caller-policy assertions", () => {
  const boundWorker: CallerPolicy = { callerPaneId: CALLER, scope: "worker", basis: "launched_leaf", binding: { status: "bound", parentPaneId: MANAGER } };
  const unboundWorker: CallerPolicy = { callerPaneId: CALLER, scope: "worker", basis: "launched_leaf", binding: { status: "unavailable", reason: "actor_stale" } };
  const unrestricted: CallerPolicy = { callerPaneId: CALLER, scope: "unrestricted", basis: "unmarked" };

  it("lets an unrestricted caller send or drive any pane", () => {
    expect(() => assertSendScope(unrestricted, "prompt", "w1:p2")).not.toThrow();
    expect(() => assertSendScope(unrestricted, "steer", undefined)).not.toThrow();
    expect(() => assertControlScope(unrestricted, "keys")).not.toThrow();
    expect(() => assertControlScope(unrestricted, "cancel")).not.toThrow();
  });

  it("allows a bound leaf worker to text only its recorded manager pane", () => {
    expect(() => assertSendScope(boundWorker, "steer", MANAGER)).not.toThrow();
    for (const target of ["w1:p2", undefined] as const) {
      expect(denied(() => assertSendScope(boundWorker, "prompt", target))).toMatchObject({ code: "TARGET_SCOPE_REJECTED", details: { operation: "prompt", callerPaneId: CALLER, parentPaneId: MANAGER } });
    }
  });

  it("denies every send for an unbound leaf worker with CALLER_BINDING_UNAVAILABLE", () => {
    for (const target of [MANAGER, "w1:p2", undefined] as const) {
      expect(denied(() => assertSendScope(unboundWorker, "steer", target))).toMatchObject({ code: "CALLER_BINDING_UNAVAILABLE", details: { operation: "steer", reason: "actor_stale" } });
    }
  });

  it("denies keys and turn control for a leaf worker regardless of binding", () => {
    expect(denied(() => assertControlScope(boundWorker, "keys"))).toMatchObject({ code: "TARGET_SCOPE_REJECTED", details: { operation: "keys", parentPaneId: MANAGER } });
    expect(denied(() => assertControlScope(unboundWorker, "interrupt"))).toMatchObject({ code: "TARGET_SCOPE_REJECTED", details: { operation: "interrupt", reason: "actor_stale" } });
  });

  it("carries a typed code and details on CallerPolicyError", () => {
    const error = new CallerPolicyError("TARGET_SCOPE_REJECTED", "denied", { operation: "keys" });
    expect(error.message).toBe("TARGET_SCOPE_REJECTED: denied");
    expect(error.details).toEqual({ operation: "keys" });
  });
});

describe("caller-policy diagnostics", () => {
  it("reports scope, basis, and the reply target or binding failure", () => {
    expect(callerPolicyDiagnostics({ callerPaneId: CALLER, scope: "unrestricted", basis: "unmarked" })).toEqual({ scope: "unrestricted", basis: "unmarked" });
    expect(callerPolicyDiagnostics({ callerPaneId: CALLER, scope: "unrestricted", basis: "manages_children", binding: { status: "bound", parentPaneId: MANAGER } })).toEqual({ scope: "unrestricted", basis: "manages_children", replyPaneId: MANAGER });
    expect(callerPolicyDiagnostics({ callerPaneId: CALLER, scope: "worker", basis: "launched_leaf", binding: { status: "bound", parentPaneId: MANAGER } })).toEqual({ scope: "worker", basis: "launched_leaf", replyPaneId: MANAGER });
    expect(callerPolicyDiagnostics({ callerPaneId: CALLER, scope: "worker", basis: "launched_leaf", binding: { status: "unavailable", reason: "session_stale" } })).toEqual({ scope: "worker", basis: "launched_leaf", binding: "unavailable", bindingReason: "session_stale" });
  });

  it("keeps policy failures readable instead of breaking inspection", () => {
    expect(callerPolicyFailure(new CallerPolicyError("CALLER_POLICY_UNAVAILABLE", "bad"))).toEqual({ scope: "unavailable", code: "CALLER_POLICY_UNAVAILABLE" });
    expect(callerPolicyFailure(new Error("unexpected"))).toEqual({ scope: "unavailable", code: "CALLER_POLICY_UNAVAILABLE" });
  });
});
