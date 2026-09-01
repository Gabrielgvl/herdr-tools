import { describe, expect, it } from "vitest";
import {
  movedIdentity,
  occupantContinuity,
  paneContinuity,
  sameSupervisedIdentity,
  type SupervisedIdentity,
} from "../../src/supervision/identity.js";
import type { SupervisionPaneRecord } from "../../src/supervision/protocol.js";

const session = { source: "herdr:pi", agent: "pi", kind: "id", value: "s1" };

const identity: SupervisedIdentity = {
  paneId: "p1",
  terminalId: "t1",
  agentName: "worker",
  agentKind: "pi",
  agentSession: session,
};

function pane(overrides: Partial<SupervisionPaneRecord> = {}): SupervisionPaneRecord {
  return {
    paneId: "p1", terminalId: "t1", tabId: "tab1", workspaceId: "w1",
    agentStatus: "working", revision: 5, agentKind: "pi", agentSession: session,
    ...overrides,
  };
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
    expect(occupantContinuity(identity, { pane: pane(), agentName: "worker" })).toBe("continuous");
    expect(occupantContinuity(identity, { pane: pane() })).toBe("continuous");
    expect(occupantContinuity(identity, { pane: pane(), agentName: "other" })).toBe("replaced");
  });

  it("follows a move only on atomic evidence plus a fresh matching occupant", () => {
    const moved = pane({ paneId: "p2", revision: 9 });
    const fresh = { pane: pane({ paneId: "p2", revision: 9 }), agentName: "worker" };
    expect(movedIdentity(identity, moved, fresh, 5)).toEqual({ ...identity, paneId: "p2" });

    // The move event itself must prove continuity.
    expect(movedIdentity(identity, pane({ paneId: "p2", agentSession: undefined }), fresh, 5)).toBeUndefined();
    // The fresh read must describe the pane the move named.
    expect(movedIdentity(identity, moved, { pane: pane({ paneId: "p3" }) }, 5)).toBeUndefined();
    // The fresh occupant must still be the same agent.
    expect(movedIdentity(identity, moved, { pane: pane({ paneId: "p2" }), agentName: "other" }, 5)).toBeUndefined();
    // A revision that went backwards is not continuity.
    expect(movedIdentity(identity, moved, { pane: pane({ paneId: "p2", revision: 1 }) }, 5)).toBeUndefined();
  });
});
