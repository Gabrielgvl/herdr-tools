import { describe, expect, it } from "vitest";
import { TargetResolutionError, parseSnapshotResult, resolvePaneOrAgentTarget, resolveTarget, type HerdrSnapshot } from "../../src/targets.js";

const snapshot: HerdrSnapshot = {
  version: "0.8.0",
  protocol: 19,
  workspaces: [{ workspace_id: "w1", label: "workspace", focused: true }],
  tabs: [
    { tab_id: "w1:t1", workspace_id: "w1", label: "main", focused: true }
  ],
  panes: [
    { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "caller", agent_status: "working", agent_name: "foundation" },
    { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", label: "reviewer", agent_status: "idle", agent_name: "reviewer" },
    { pane_id: "w1:p3", tab_id: "w1:t1", workspace_id: "w1", label: "duplicate", agent_status: "idle", agent_name: "same" },
    { pane_id: "w1:p4", tab_id: "w1:t1", workspace_id: "w1", label: "other", agent_status: "idle", agent_name: "same" }
  ],
  agents: [
    { pane_id: "w1:p1", agent_id: "agent-1", name: "foundation", agent_status: "working" },
    { pane_id: "w1:p2", agent_id: "agent-7", name: "reviewer", agent_status: "idle" },
    { pane_id: "w1:p3", name: "same", agent_status: "idle" },
    { pane_id: "w1:p4", name: "same", agent_status: "idle" }
  ]
};

const context = { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" };

describe("exact target resolution", () => {
  it("resolves current, opaque IDs, labels, and unique agent names", () => {
    expect(resolveTarget(snapshot, "current", "pane", context).paneId).toBe("w1:p1");
    expect(resolveTarget(snapshot, "w1:p2", "pane", context).paneId).toBe("w1:p2");
    expect(resolveTarget(snapshot, "reviewer", "pane", context).paneId).toBe("w1:p2");
    expect(resolveTarget(snapshot, "reviewer", "agent", context).paneId).toBe("w1:p2");
    expect(resolveTarget(snapshot, "agent-7", "agent", context)).toMatchObject({ id: "w1:p2", paneId: "w1:p2", agentName: "reviewer" });
  });

  it("prioritizes exact agent IDs over pane labels while preserving pane IDs and ambiguity safety", () => {
    const prioritized = {
      ...snapshot,
      panes: snapshot.panes.map((pane) => pane.pane_id === "w1:p1" ? { ...pane, label: "agent-7" } : pane)
    };
    expect(resolvePaneOrAgentTarget(prioritized, "agent-7", context)).toMatchObject({ paneId: "w1:p2" });

    const collidingPaneId = {
      ...prioritized,
      panes: [...prioritized.panes, { ...snapshot.panes[3], pane_id: "w1:p5", agent_id: "w1:p2" }],
      agents: [...prioritized.agents, { pane_id: "w1:p5", agent_id: "w1:p2", name: "collision" }]
    };
    expect(resolvePaneOrAgentTarget(collidingPaneId, "w1:p2", context)).toMatchObject({ paneId: "w1:p2" });

    const ambiguousAgentId = {
      ...prioritized,
      agents: [...prioritized.agents, { pane_id: "w1:p4", agent_id: "agent-7", name: "other" }]
    };
    expect(() => resolvePaneOrAgentTarget(ambiguousAgentId, "agent-7", context)).toThrowError(/TARGET_AMBIGUOUS/);
    expect(() => resolvePaneOrAgentTarget(snapshot, "", context)).toThrowError(/INVALID_INPUT/);
    expect(() => resolvePaneOrAgentTarget(snapshot, "same", context)).toThrowError(/TARGET_AMBIGUOUS/);
    const ambiguousPaneLabel = { ...snapshot, panes: [...snapshot.panes, { ...snapshot.panes[1], pane_id: "w1:p5", label: "duplicate" }] };
    expect(() => resolvePaneOrAgentTarget(ambiguousPaneLabel, "duplicate", context)).toThrowError(/TARGET_AMBIGUOUS/);
  });

  it("resolves current from injected context rather than focused metadata", () => {
    const unfocused = { ...context, paneId: "w1:p2" };
    expect(resolveTarget(snapshot, "current", "pane", unfocused).paneId).toBe("w1:p2");
  });

  it("fails closed for missing, ambiguous, fuzzy, case-variant, and wrong-kind targets", () => {
    for (const ref of ["missing", "rev", "REVIEWER"]) {
      expect(() => resolveTarget(snapshot, ref, "pane", context)).toThrow(TargetResolutionError);
    }
    expect(() => resolveTarget(snapshot, "same", "agent", context)).toThrowError(/TARGET_AMBIGUOUS/);
    expect(() => resolveTarget(snapshot, "w1:t1", "pane", context)).toThrowError(/TARGET_TYPE_MISMATCH/);
    expect(() => resolveTarget(snapshot, "w1:p2", "tab", context)).toThrowError(/TARGET_TYPE_MISMATCH/);
  });

  it("rejects an unavailable or inconsistent current context before any fallback", () => {
    expect(() => resolveTarget(snapshot, "current", "pane", { workspaceId: "w1", tabId: "w1:t1" })).toThrowError(/CONTEXT_UNAVAILABLE/);
    expect(() => resolveTarget(snapshot, "current", "pane", { workspaceId: "w1", tabId: "w1:t1", paneId: "missing" })).toThrowError(/CONTEXT_UNAVAILABLE/);
    expect(() => resolveTarget(snapshot, "", "pane", context)).toThrowError(/INVALID_INPUT/);
    expect(() => resolveTarget(snapshot, "bad\nvalue", "pane", context)).toThrowError(/INVALID_INPUT/);
  });

  it("resolves workspace and tab IDs, labels, and current context by kind", () => {
    expect(resolveTarget(snapshot, "w1", "workspace", context).id).toBe("w1");
    expect(resolveTarget(snapshot, "workspace", "workspace", context).id).toBe("w1");
    expect(resolveTarget(snapshot, "w1:t1", "tab", context).id).toBe("w1:t1");
    expect(resolveTarget(snapshot, "main", "tab", context).id).toBe("w1:t1");
    expect(resolveTarget(snapshot, "current", "tab", context).id).toBe("w1:t1");
    expect(resolveTarget(snapshot, "current", "workspace", context).id).toBe("w1");
    expect(resolveTarget(snapshot, "current", "agent", context).id).toBe("w1:p1");
  });

  it("resolves an exact pane label for an unnamed agent", () => {
    const unnamed = { ...snapshot, panes: snapshot.panes.map((pane) => pane.pane_id === "w1:p2" ? { ...pane, agent_name: undefined } : pane), agents: snapshot.agents.map((agent) => agent.pane_id === "w1:p2" ? { pane_id: agent.pane_id, agent_status: agent.agent_status } : agent) };
    expect(resolveTarget(unnamed, "reviewer", "agent", context)).toMatchObject({ id: "w1:p2", label: "reviewer", agentName: undefined });
  });

  it("fails closed for ambiguous pane labels and agent IDs while preserving orphan agent metadata", () => {
    const duplicate = { ...snapshot, panes: [...snapshot.panes, { ...snapshot.panes[1], pane_id: "w1:p5", label: "reviewer" }] };
    expect(() => resolveTarget(duplicate, "reviewer", "pane", context)).toThrowError(/TARGET_AMBIGUOUS/);
    const duplicateAgentId = { ...snapshot, agents: [...snapshot.agents, { pane_id: "w1:p4", agent_id: "agent-7", name: "other-agent" }] };
    expect(() => resolveTarget(duplicateAgentId, "agent-7", "agent", context)).toThrowError(/TARGET_AMBIGUOUS/);
    const paneOnlyAgentId = {
      ...snapshot,
      panes: snapshot.panes.map((pane) => pane.pane_id === "w1:p2" ? { ...pane, agent_id: "pane-agent-7" } : pane),
      agents: snapshot.agents.map((agent) => ({ pane_id: agent.pane_id, name: agent.name, agent_status: agent.agent_status }))
    };
    expect(resolveTarget(paneOnlyAgentId, "pane-agent-7", "agent", context)).toMatchObject({ id: "w1:p2", paneId: "w1:p2", agentName: "reviewer" });
    const paneAndAgentId = {
      ...snapshot,
      panes: snapshot.panes.map((pane) => pane.pane_id === "w1:p2" ? { ...pane, agent_id: "agent-fallback" } : pane),
      agents: snapshot.agents.map((agent) => agent.pane_id === "w1:p2" ? { ...agent, agent_id: "agent-fallback", name: undefined } : agent)
    };
    expect(resolveTarget(paneAndAgentId, "agent-fallback", "agent", context)).toMatchObject({ id: "w1:p2", paneId: "w1:p2", agentName: "reviewer" });
    const orphan = { ...snapshot, agents: [...snapshot.agents, { pane_id: "orphan", name: "orphan" }, { pane_id: "orphan-id", agent_id: "orphan-7", name: "orphan-id" }] };
    expect(resolveTarget(orphan, "orphan", "agent", context)).toMatchObject({ id: "orphan", workspaceId: "", tabId: undefined, label: undefined, agentName: "orphan" });
    expect(resolveTarget(orphan, "orphan-7", "agent", context)).toMatchObject({ id: "orphan-id", workspaceId: "", tabId: undefined, label: undefined, agentName: "orphan-id" });
  });
});

describe("authoritative snapshot parser", () => {
  const rawSnapshot = {
    version: "0.8.0",
    protocol: 19,
    workspaces: [{ workspace_id: "w1", label: "workspace" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main" }],
    panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", agent: "pi" }],
    agents: [{ pane_id: "w1:p1", agent: "pi" }]
  };

  it("normalizes the installed snapshot wrapper and authoritative agent names", () => {
    const parsed = parseSnapshotResult({ type: "session_snapshot", snapshot: rawSnapshot });
    expect(parsed.panes[0].agent_name).toBeUndefined();
    expect(parsed.agents[0].name).toBeUndefined();
  });

  it.each([
    null,
    {},
    { type: "wrong", snapshot: rawSnapshot },
    { type: "session_snapshot", snapshot: { ...rawSnapshot, workspaces: null } },
    { type: "session_snapshot", snapshot: { ...rawSnapshot, tabs: null } },
    { type: "session_snapshot", snapshot: { ...rawSnapshot, panes: null } },
    { type: "session_snapshot", snapshot: { ...rawSnapshot, agents: null } },
    { type: "session_snapshot", snapshot: { ...rawSnapshot, version: 1 } },
    { type: "session_snapshot", snapshot: { ...rawSnapshot, protocol: "19" } }
  ])("rejects incompatible top-level snapshots: %s", (value) => {
    expect(() => parseSnapshotResult(value)).toThrow();
  });

  it("rejects malformed workspace, tab, pane, and agent records", () => {
    const cases = [
      { workspaces: [null] },
      { workspaces: [{ workspace_id: "", label: "workspace" }] },
      { workspaces: [{ workspace_id: "w1", label: "" }] },
      { tabs: [null] },
      { tabs: [{ tab_id: "", workspace_id: "w1", label: "main" }] },
      { tabs: [{ tab_id: "t", workspace_id: "", label: "main" }] },
      { tabs: [{ tab_id: "t", workspace_id: "w1", label: "" }] },
      { panes: [null] },
      { panes: [{ pane_id: "", tab_id: "t", workspace_id: "w1" }] },
      { panes: [{ pane_id: "p", tab_id: "", workspace_id: "w1" }] },
      { panes: [{ pane_id: "p", tab_id: "t", workspace_id: "" }] },
      { agents: [null] },
      { agents: [{ pane_id: "" }] }
    ];
    for (const change of cases) {
      expect(() => parseSnapshotResult({ type: "session_snapshot", snapshot: { ...rawSnapshot, ...change } })).toThrow();
    }
  });

  it("accepts explicit agent names and rejects non-finite protocol values", () => {
    const explicit = { ...rawSnapshot, panes: [{ ...rawSnapshot.panes[0], name: "named-pane" }], agents: [{ pane_id: "w1:p1", name: "named" }] };
    const parsed = parseSnapshotResult({ type: "session_snapshot", snapshot: explicit });
    expect(parsed.panes[0].agent_name).toBe("named-pane");
    expect(parsed.agents[0].name).toBe("named");
    expect(() => parseSnapshotResult({ type: "session_snapshot", snapshot: { ...rawSnapshot, protocol: Number.NaN } })).toThrowError(/Snapshot field protocol/);
  });
});
