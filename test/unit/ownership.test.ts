import { describe, expect, it } from "vitest";
import { paneCloseTopology, snapshotIds, tabCloseTopology, topologySummary, validateClose } from "../../src/close.js";
import { RuntimeOwnership, recordCreatedResource } from "../../src/ownership.js";
import type { HerdrSnapshot } from "../../src/targets.js";

const snapshot: HerdrSnapshot = {
  version: "0.8",
  protocol: 1,
  workspaces: [{ workspace_id: "w1", label: "workspace" }],
  tabs: [
    { tab_id: "t1", workspace_id: "w1", label: "caller" },
    { tab_id: "t2", workspace_id: "w1", label: "other" }
  ],
  panes: [
    { pane_id: "p1", tab_id: "t1", workspace_id: "w1", label: "caller" },
    { pane_id: "p2", tab_id: "t2", workspace_id: "w1", label: "other" }
  ],
  agents: []
};

const caller = { workspaceId: "w1", tabId: "t1", paneId: "p1" };

describe("runtime ownership bookkeeping", () => {
  it("records, transfers, checks, snapshots, and resets resources", () => {
    const ledger = new RuntimeOwnership();
    ledger.recordMany([{ kind: "pane", id: "p1", parentId: "t1" }, { kind: "tab", id: "t1", parentId: "w1" }]);
    expect(ledger.has({ kind: "pane", id: "p1" })).toBe(true);
    ledger.transfer({ kind: "pane", id: "p1" }, { kind: "pane", id: "p2", parentId: "t2" });
    expect(ledger.has({ kind: "pane", id: "p1" })).toBe(false);
    expect(ledger.snapshot()).toContainEqual({ kind: "pane", id: "p2", parentId: "t2" });
    ledger.transfer({ kind: "pane", id: "missing" }, { kind: "pane", id: "p3" });
    ledger.clear();
    expect(ledger.snapshot()).toEqual([]);
    recordCreatedResource({ kind: "tab", id: "t3" }, ledger);
    expect(ledger.has({ kind: "tab", id: "t3" })).toBe(true);
    ledger.reset();
    expect(ledger.has({ kind: "tab", id: "t3" })).toBe(false);
  });
});

describe("autonomous close validation", () => {
  it("allows any exact non-caller target without ownership or UI", () => {
    expect(validateClose(tabCloseTopology(snapshot, caller), { kind: "tab", id: "t2", parentId: "w1" })).toEqual({ allowed: true, resourceIds: ["t2", "p2"] });
    expect(validateClose(paneCloseTopology(snapshot, caller), { kind: "pane", id: "p2", parentId: "t2" })).toEqual({ allowed: true, resourceIds: ["p2", "t2"] });
  });

  it("protects caller resources and ancestors that would be removed", () => {
    expect(validateClose(paneCloseTopology(snapshot, caller), { kind: "pane", id: "p1", parentId: "t1" })).toMatchObject({ allowed: false, code: "PROTECTED_RESOURCE" });
    const onlyPane: HerdrSnapshot = { ...snapshot, tabs: snapshot.tabs.slice(0, 1), panes: snapshot.panes.slice(0, 1) };
    expect(validateClose(paneCloseTopology(onlyPane, caller), { kind: "pane", id: "p1", parentId: "t1" })).toMatchObject({ allowed: false, code: "PROTECTED_RESOURCE" });
  });

  it("fails closed on duplicate and cyclic topology", () => {
    const duplicate = paneCloseTopology(snapshot, caller);
    duplicate.nodes.push({ kind: "pane", id: "p2", parentId: "t2" });
    expect(validateClose(duplicate, { kind: "pane", id: "p2", parentId: "t2" })).toMatchObject({ allowed: false, code: "TOPOLOGY_INVALID" });
    const cyclic = { ...paneCloseTopology(snapshot, caller), nodes: [
      { kind: "pane" as const, id: "p2", parentId: "p3" },
      { kind: "pane" as const, id: "p3", parentId: "p2" }
    ] };
    expect(validateClose(cyclic, { kind: "pane", id: "p2", parentId: "p3" })).toMatchObject({ allowed: false, code: "TOPOLOGY_INVALID" });
  });

  it("handles explicit children and namespaced parent references", () => {
    const topology = {
      caller: { workspaceId: "w1", tabId: "caller", paneId: "caller-pane" },
      nodes: [
        { kind: "workspace" as const, id: "w1" },
        { kind: "tab" as const, id: "caller", parentId: "w1" },
        { kind: "pane" as const, id: "caller-pane", parentId: "caller" },
        { kind: "tab" as const, id: "target", parentId: "w1", children: ["p-child", "p-child", "missing", "p-explicit"] },
        { kind: "pane" as const, id: "p-child", parentId: "tab:target" },
        { kind: "pane" as const, id: "p-explicit" }
      ]
    };
    expect(validateClose(topology, { kind: "tab", id: "target", parentId: "w1" })).toMatchObject({ allowed: false, code: "TOPOLOGY_INVALID" });
    const completeTopology = { ...topology, nodes: topology.nodes.map((node) => node.id === "target" && node.kind === "tab" ? { ...node, children: ["p-child", "p-explicit"] } : node) };
    expect(validateClose(completeTopology, { kind: "tab", id: "target", parentId: "w1" })).toEqual({ allowed: true, resourceIds: ["target", "p-child", "p-explicit"] });
  });

  it("handles an exact target omitted from the topology and partial callers", () => {
    expect(validateClose({ nodes: [], caller: {} }, { kind: "pane", id: "orphan" })).toEqual({ allowed: true, resourceIds: ["orphan"] });
    expect(validateClose({ nodes: [], caller: { paneId: "", tabId: "", workspaceId: "" } }, { kind: "pane", id: "orphan" })).toEqual({ allowed: true, resourceIds: ["orphan"] });
  });

  it("summarizes topology and retains authoritative IDs", () => {
    expect(snapshotIds(snapshot)).toEqual(["w1", "t1", "t2", "p1", "p2"]);
    expect(topologySummary(snapshot)).toEqual({ workspaceCount: 1, tabCount: 2, paneCount: 2, workspaceIds: ["w1"], tabIds: ["t1", "t2"], paneIds: ["p1", "p2"] });
    const large: HerdrSnapshot = {
      ...snapshot,
      workspaces: Array.from({ length: 9 }, (_, i) => ({ workspace_id: `w${i}`, label: `w${i}` })),
      tabs: Array.from({ length: 17 }, (_, i) => ({ tab_id: `t${i}`, workspace_id: "w0", label: `t${i}` })),
      panes: Array.from({ length: 33 }, (_, i) => ({ pane_id: `p${i}`, tab_id: "t0", workspace_id: "w0" }))
    };
    expect(topologySummary(large)).toMatchObject({ workspaceIdsOmitted: 1, tabIdsOmitted: 1, paneIdsOmitted: 1 });
  });
});
