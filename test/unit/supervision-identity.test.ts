import { describe, expect, it } from "vitest";
import {
  classifyProvisionalSnapshotTarget,
  classifySnapshotTarget,
  movedIdentity,
  occupantContinuity,
  paneContinuity,
  provisionalOccupantContinuity,
  sameSupervisedIdentity,
  type ProvisionalSupervisedIdentity,
  type SupervisedIdentity,
} from "../../src/supervision/identity.js";
import type { SupervisionPaneRecord } from "../../src/supervision/protocol.js";
import { parseSnapshotResult, type HerdrSnapshot } from "../../src/targets.js";

const session = { source: "herdr:pi", agent: "pi", kind: "id", value: "s1" };

const identity: SupervisedIdentity = {
  paneId: "p1",
  terminalId: "t1",
  agentName: "worker",
  agentKind: "pi",
  agentSession: session,
};

const agyIdentity: ProvisionalSupervisedIdentity = { paneId: "p1", terminalId: "t1", agentName: "worker", agentKind: "agy" };

function pane(overrides: Partial<SupervisionPaneRecord> = {}): SupervisionPaneRecord {
  return {
    paneId: "p1", terminalId: "t1", tabId: "tab1", workspaceId: "w1",
    agentStatus: "working", revision: 5, agentKind: "pi", agentSession: session,
    ...overrides,
  };
}

function rawPane(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pane_id: "p1", terminal_id: "t1", tab_id: "tab1", workspace_id: "w1",
    agent_status: "working", revision: 5, agent: "pi", agent_session: session,
    ...overrides,
  };
}

function snapshot(panes: Record<string, unknown>[], agents: Record<string, unknown>[]): HerdrSnapshot {
  return parseSnapshotResult({ type: "session_snapshot", snapshot: { version: "0.8.2", protocol: 20, workspaces: [], tabs: [], panes, agents } });
}

function agyPane(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pane_id: "p1", terminal_id: "t1", tab_id: "tab1", workspace_id: "w1",
    agent_status: "idle", revision: 2, agent: "agy", agent_session: null, state_change_seq: 4,
    ...overrides,
  };
}

function agyAgent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { pane_id: "p1", name: "worker", agent: "agy", agent_session: null, state_change_seq: 4, revision: 2, agent_status: "idle", ...overrides };
}

describe("supervised identity continuity", () => {
  it("compares the whole identity, including every agent-session component", () => {
    expect(sameSupervisedIdentity(identity, { ...identity })).toBe(true);
    expect(sameSupervisedIdentity(identity, { ...identity, agentName: "other" })).toBe(false);
    expect(sameSupervisedIdentity(identity, { ...identity, paneId: "p2" })).toBe(false);
    expect(sameSupervisedIdentity(identity, { ...identity, terminalId: "t2" })).toBe(false);
    expect(sameSupervisedIdentity(identity, { ...identity, agentKind: "claude" })).toBe(false);
    expect(sameSupervisedIdentity(identity, { ...identity, agentSession: { ...session, value: "s2" } })).toBe(false);
  });

  it("proves continuity only when the session is supplied and matches", () => {
    expect(paneContinuity(identity, pane())).toBe("continuous");
    expect(paneContinuity(identity, pane({ agentSession: undefined }))).toBe("unproven");
    expect(paneContinuity(identity, pane({ terminalId: "t2" }))).toBe("replaced");
    expect(paneContinuity(identity, pane({ agentKind: "claude" }))).toBe("replaced");
    expect(paneContinuity(identity, pane({ agentSession: { ...session, source: "herdr:claude" } }))).toBe("replaced");
    expect(paneContinuity(identity, pane({ agentSession: { ...session, agent: "claude" } }))).toBe("replaced");
    expect(paneContinuity(identity, pane({ agentSession: { ...session, kind: "path" } }))).toBe("replaced");
    // A pane that omits the kind cannot contradict it.
    expect(paneContinuity(identity, pane({ agentKind: undefined }))).toBe("continuous");
  });

  it("checks the agent name only where a snapshot supplies one", () => {
    expect(occupantContinuity(identity, { pane: pane(), agentPresent: true, agentName: "worker" })).toBe("continuous");
    expect(occupantContinuity(identity, { pane: pane(), agentPresent: true })).toBe("continuous");
    expect(occupantContinuity(identity, { pane: pane(), agentPresent: true, agentName: "other" })).toBe("replaced");
  });

  it("classifies target-local snapshot evidence without conflating invalidity with absence", () => {
    const agent = { pane_id: "p1", name: "worker", terminal_id: "t1", agent: "pi", agent_session: session };
    const unique = classifySnapshotTarget(snapshot([rawPane()], [agent]), "p1");
    expect(unique).toMatchObject({ kind: "unique", occupant: { agentPresent: true, agentName: "worker", pane: { paneId: "p1" } } });
    expect(classifySnapshotTarget(snapshot([], []), "p1")).toEqual({ kind: "absent" });
    expect(classifySnapshotTarget(snapshot([rawPane()], []), "p1")).toMatchObject({ kind: "unique", occupant: { agentPresent: false } });
    expect(classifySnapshotTarget(snapshot([rawPane(), rawPane()], [agent]), "p1")).toEqual({ kind: "invalid", reason: "duplicate_target_pane" });
    expect(classifySnapshotTarget(snapshot([rawPane()], [agent, { ...agent }]), "p1")).toEqual({ kind: "invalid", reason: "duplicate_target_agent" });
    expect(classifySnapshotTarget(snapshot([], [agent]), "p1")).toEqual({ kind: "invalid", reason: "orphan_target_agent" });
    expect(classifySnapshotTarget(snapshot([{ ...rawPane(), agent_status: "spinning" }], [agent]), "p1")).toEqual({ kind: "invalid", reason: "target_record_malformed" });
    expect(classifySnapshotTarget(snapshot([rawPane()], [{ ...agent, terminal_id: { malformed: true } }]), "p1")).toEqual({ kind: "invalid", reason: "target_record_malformed" });
    for (const contradictoryAgent of [
      { ...agent, name: "other" },
      { ...agent, terminal_id: "t2" },
      { ...agent, agent: "claude" },
      { ...agent, agent_session: { ...session, value: "s2" } },
    ]) {
      expect(classifySnapshotTarget(snapshot([{ ...rawPane(), agent_name: "worker" }], [contradictoryAgent]), "p1")).toEqual({ kind: "invalid", reason: "target_identity_contradiction" });
    }
  });

  it("joins identity fields supplied only by the target-local agent record", () => {
    const evidence = classifySnapshotTarget(snapshot(
      [{ ...rawPane(), agent: null, agent_session: null }],
      [{ pane_id: "p1", name: "worker", agent: "pi", terminal_id: "t1", agent_session: session }],
    ), "p1");
    expect(evidence.kind).toBe("unique");
    if (evidence.kind !== "unique") throw new Error("expected unique evidence");
    expect(occupantContinuity(identity, evidence.occupant)).toBe("continuous");
  });

  it("accepts an agent record that omits optional session evidence", () => {
    expect(classifySnapshotTarget(snapshot(
      [rawPane()],
      [{ pane_id: "p1", name: "worker", terminal_id: "t1", agent: "pi" }],
    ), "p1")).toMatchObject({ kind: "unique", occupant: { agentPresent: true, agentName: "worker", pane: { paneId: "p1" } } });
  });

  it("classifies AGY's reduced-assurance occupant and preserves lifecycle coherence", () => {
    const reduced = classifyProvisionalSnapshotTarget(snapshot([agyPane()], [agyAgent()]), "p1");
    expect(reduced).toMatchObject({ kind: "unique", occupant: { agentPresent: true, agentName: "worker", stateChangeSeq: 4, pane: { paneId: "p1", agentKind: "agy" } } });
    if (reduced.kind !== "unique") throw new Error("expected a unique AGY occupant");
    expect(provisionalOccupantContinuity(agyIdentity, reduced.occupant)).toBe("continuous");

    expect(classifyProvisionalSnapshotTarget(snapshot([agyPane({ state_change_seq: 5 })], [agyAgent()]), "p1")).toEqual({ kind: "invalid", reason: "target_identity_contradiction" });
    expect(classifyProvisionalSnapshotTarget(snapshot([agyPane({ state_change_seq: "5" })], [agyAgent()]), "p1")).toEqual({ kind: "invalid", reason: "target_record_malformed" });
    expect(provisionalOccupantContinuity(agyIdentity, { pane: { paneId: "p1", terminalId: "t1", tabId: "tab1", workspaceId: "w1", agentStatus: "idle", revision: 2, agentKind: "pi" }, agentPresent: true, agentName: "worker" })).toBe("replaced");
    expect(provisionalOccupantContinuity(agyIdentity, { pane: { paneId: "p1", terminalId: "t1", tabId: "tab1", workspaceId: "w1", agentStatus: "idle", revision: 2, agentKind: "agy" }, agentPresent: true })).toBe("unproven");
  });

  it("keeps the generic classifier unchanged when AGY lifecycle fields are malformed", () => {
    expect(classifySnapshotTarget(snapshot([agyPane({ state_change_seq: "bad" })], [agyAgent()]), "p1")).toMatchObject({ kind: "unique", occupant: { agentPresent: true } });
  });

  it("follows a move only on atomic evidence plus a fresh matching occupant", () => {
    const moved = pane({ paneId: "p2", revision: 9 });
    const fresh = { pane: pane({ paneId: "p2", revision: 1 }), agentPresent: true, agentName: "worker" };
    // Destination revisions are pane-local and may be lower than the origin.
    expect(movedIdentity(identity, moved, fresh)).toEqual({ ...identity, paneId: "p2" });

    // The move event itself must prove continuity.
    expect(movedIdentity(identity, pane({ paneId: "p2", agentSession: undefined }), fresh)).toBeUndefined();
    // The fresh read must describe the pane the move named.
    expect(movedIdentity(identity, moved, { pane: pane({ paneId: "p3" }), agentPresent: true })).toBeUndefined();
    // The fresh occupant must still be the same agent.
    expect(movedIdentity(identity, moved, { pane: pane({ paneId: "p2" }), agentPresent: true, agentName: "other" })).toBeUndefined();
    // An agent-free destination is not move continuity.
    expect(movedIdentity(identity, moved, { pane: pane({ paneId: "p2" }), agentPresent: false })).toBeUndefined();
  });
});
