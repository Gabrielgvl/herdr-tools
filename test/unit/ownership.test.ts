import { afterEach, describe, expect, it } from "vitest";
import {
  RuntimeOwnership,
  closePolicy,
  descendantsForClose,
  recordCreatedResource,
  resetOwnership,
  runtimeOwnership,
  type CloseTopology
} from "../../src/ownership.js";

afterEach(() => resetOwnership());

describe("runtime topology ownership", () => {
  const topology: CloseTopology = {
    caller: { workspaceId: "w-caller", tabId: "t-caller", paneId: "p-caller" },
    nodes: [
      { kind: "workspace", id: "w1" },
      { kind: "tab", id: "t1", parentId: "w1" },
      { kind: "pane", id: "p1", parentId: "t1", children: ["p3"] },
      { kind: "pane", id: "p2", parentId: "pane:p1" },
      { kind: "pane", id: "p3", parentId: "p1" }
    ]
  };

  it("records opaque resources and ancestry only in the runtime ledger", () => {
    const ledger = new RuntimeOwnership();
    ledger.record({ kind: "tab", id: "t1", parentId: "w1" });
    ledger.recordMany([{ kind: "pane", id: "p1", parentId: "t1" }, { kind: "pane", id: "p2", parentId: "p1" }]);
    expect(ledger.has({ kind: "tab", id: "t1" })).toBe(true);
    expect(ledger.snapshot()).toEqual([
      { kind: "tab", id: "t1", parentId: "w1" },
      { kind: "pane", id: "p1", parentId: "t1" },
      { kind: "pane", id: "p2", parentId: "p1" }
    ]);
    const snapshot = ledger.snapshot();
    snapshot[0].id = "mutated-copy";
    expect(ledger.has({ kind: "tab", id: "t1" })).toBe(true);
    ledger.transfer({ kind: "pane", id: "p2" }, { kind: "pane", id: "p2", parentId: "t2" });
    ledger.transfer({ kind: "pane", id: "missing" }, { kind: "pane", id: "new" });
    expect(ledger.snapshot()).toContainEqual({ kind: "pane", id: "p2", parentId: "t2" });
    recordCreatedResource({ kind: "pane", id: "p3", parentId: "p1" }, ledger);
    ledger.clear();
    expect(ledger.snapshot()).toEqual([]);
  });

  it("clears the singleton on explicit runtime/session reset", () => {
    runtimeOwnership.record({ kind: "pane", id: "old", parentId: "t1" });
    expect(runtimeOwnership.has({ kind: "pane", id: "old" })).toBe(true);
    resetOwnership();
    expect(runtimeOwnership.has({ kind: "pane", id: "old" })).toBe(false);
  });

  it("walks every transitive descendant through parent and explicit child ancestry", () => {
    expect(descendantsForClose(topology, { kind: "pane", id: "p1" })).toEqual([
      { kind: "pane", id: "p1", parentId: "t1" },
      { kind: "pane", id: "p2", parentId: "pane:p1" },
      { kind: "pane", id: "p3", parentId: "p1" }
    ]);
  });

  it("silently permits an explicitly requested wholly owned tree", () => {
    const ledger = new RuntimeOwnership();
    ledger.recordMany([
      { kind: "pane", id: "p1", parentId: "t1" },
      { kind: "pane", id: "p2", parentId: "p1" },
      { kind: "pane", id: "p3", parentId: "p1" }
    ]);
    expect(closePolicy({ topology, target: { kind: "pane", id: "p1" }, hasUI: false }, ledger)).toEqual({
      allowed: true,
      requiresConfirmation: false,
      resourceIds: ["p1", "p2", "p3"]
    });
  });

  it("requires confirmation for mixed or unowned trees and fails closed without UI", () => {
    const mixed = new RuntimeOwnership();
    mixed.recordMany([{ kind: "pane", id: "p1" }, { kind: "pane", id: "p2" }]);
    expect(closePolicy({ topology, target: { kind: "pane", id: "p1" }, hasUI: true }, mixed)).toEqual({
      allowed: false,
      requiresConfirmation: true,
      resourceIds: ["p1", "p2", "p3"]
    });
    expect(closePolicy({ topology, target: { kind: "pane", id: "p1" }, hasUI: false }, mixed)).toMatchObject({ allowed: false, code: "CONFIRMATION_UNAVAILABLE" });
    expect(closePolicy({ topology, target: { kind: "pane", id: "p1" }, hasUI: true }, new RuntimeOwnership())).toMatchObject({ allowed: false, requiresConfirmation: true });
    expect(closePolicy({ topology, target: { kind: "pane", id: "p1" }, hasUI: false }, new RuntimeOwnership())).toMatchObject({ allowed: false, code: "CONFIRMATION_UNAVAILABLE" });
  });

  it("protects the caller pane, tab, workspace, and descendants of those ancestors", () => {
    const ledger = new RuntimeOwnership();
    ledger.recordMany([{ kind: "tab", id: "t1" }, { kind: "pane", id: "p1" }, { kind: "pane", id: "p2" }, { kind: "pane", id: "p3" }]);
    expect(closePolicy({ topology: { ...topology, caller: { paneId: "p1", tabId: "t1", workspaceId: "w1" } }, target: { kind: "pane", id: "p1" }, hasUI: true }, ledger)).toMatchObject({ allowed: false, code: "PROTECTED_RESOURCE" });
    expect(closePolicy({ topology: { ...topology, caller: { paneId: "p-caller", tabId: "t1", workspaceId: "w1" } }, target: { kind: "tab", id: "t1" }, hasUI: true }, ledger)).toMatchObject({ allowed: false, code: "PROTECTED_RESOURCE" });
    expect(closePolicy({ topology: { ...topology, caller: { paneId: "p-caller", tabId: "t-caller", workspaceId: "w1" } }, target: { kind: "workspace", id: "w1" }, hasUI: true }, ledger)).toMatchObject({ allowed: false, code: "PROTECTED_RESOURCE" });
  });
});
