import type { HerdrSnapshot } from "./targets.js";

export type CloseResourceKind = "pane" | "tab" | "workspace";

export interface CloseResource {
  kind: CloseResourceKind;
  id: string;
  parentId?: string;
}

export interface CloseTopologyNode extends CloseResource {
  children?: string[];
}

export interface CloseTopology {
  nodes: CloseTopologyNode[];
  caller: { paneId?: string; tabId?: string; workspaceId?: string };
}

export type CloseValidation = {
  allowed: true;
  resourceIds: string[];
} | {
  allowed: false;
  code: "PROTECTED_RESOURCE" | "TOPOLOGY_INVALID";
  resourceIds: string[];
};

function key(resource: Pick<CloseResource, "kind" | "id">): string {
  return `${resource.kind}:${resource.id}`;
}

function directChildren(nodes: Map<string, CloseTopologyNode>, node: CloseTopologyNode): CloseTopologyNode[] {
  const result: CloseTopologyNode[] = [];
  for (const candidate of nodes.values()) {
    if (candidate.parentId === node.id || candidate.parentId === key(node)) result.push(candidate);
  }
  for (const childId of node.children ?? []) {
    const child = [...nodes.values()].find((candidate) => candidate.id === childId);
    if (child && !result.some((candidate) => key(candidate) === key(child))) result.push(child);
  }
  return result;
}

function parentNode(nodes: Map<string, CloseTopologyNode>, node: CloseTopologyNode): CloseTopologyNode | undefined {
  if (!node.parentId) return undefined;
  return [...nodes.values()].find((candidate) => candidate.id === node.parentId || key(candidate) === node.parentId);
}

function collectAffected(topology: CloseTopology, target: CloseResource): { resources: CloseResource[]; malformed: boolean } {
  const nodes = new Map<string, CloseTopologyNode>();
  let malformed = false;
  for (const node of topology.nodes) {
    const nodeKey = key(node);
    if (nodes.has(nodeKey)) malformed = true;
    nodes.set(nodeKey, node);
  }
  for (const node of nodes.values()) {
    if (node.parentId && ![...nodes.values()].some((candidate) => candidate.id === node.parentId || key(candidate) === node.parentId)) malformed = true;
    if ((node.children ?? []).some((childId) => ![...nodes.values()].some((candidate) => candidate.id === childId))) malformed = true;
  }
  const root = nodes.get(key(target)) ?? { ...target };
  const resources: CloseResource[] = [];
  const visited = new Set<string>();
  const visit = (node: CloseTopologyNode | CloseResource): void => {
    const nodeKey = key(node);
    if (visited.has(nodeKey)) return;
    visited.add(nodeKey);
    resources.push({ kind: node.kind, id: node.id, parentId: node.parentId });
    for (const child of directChildren(nodes, node)) visit(child);
  };
  visit(root);

  let child: CloseTopologyNode | undefined = nodes.get(key(root));
  while (child) {
    const parent = parentNode(nodes, child);
    if (!parent) break;
    const parentKey = key(parent);
    if (visited.has(parentKey)) {
      malformed = true;
      break;
    }
    const remainingChildren = directChildren(nodes, parent).filter((candidate) => !visited.has(key(candidate)));
    if (remainingChildren.length > 0) break;
    visit(parent);
    child = parent;
  }
  return { resources, malformed };
}

export function validateClose(topology: CloseTopology, target: CloseResource): CloseValidation {
  const affected = collectAffected(topology, target);
  const resourceIds = affected.resources.map((resource) => resource.id);
  if (affected.malformed) return { allowed: false, code: "TOPOLOGY_INVALID", resourceIds };
  const protectedIds = new Set([
    topology.caller.paneId ? key({ kind: "pane", id: topology.caller.paneId }) : "",
    topology.caller.tabId ? key({ kind: "tab", id: topology.caller.tabId }) : "",
    topology.caller.workspaceId ? key({ kind: "workspace", id: topology.caller.workspaceId }) : ""
  ]);
  if (affected.resources.some((resource) => protectedIds.has(key(resource)))) {
    return { allowed: false, code: "PROTECTED_RESOURCE", resourceIds };
  }
  return { allowed: true, resourceIds };
}

function boundedIds(ids: string[], limit: number): { ids: string[]; omitted: number } {
  return { ids: ids.slice(0, limit), omitted: Math.max(0, ids.length - limit) };
}

export function topologySummary(snapshot: HerdrSnapshot): Record<string, unknown> {
  const workspaces = boundedIds(snapshot.workspaces.map((item) => item.workspace_id), 8);
  const tabs = boundedIds(snapshot.tabs.map((item) => item.tab_id), 16);
  const panes = boundedIds(snapshot.panes.map((item) => item.pane_id), 32);
  return {
    workspaceCount: snapshot.workspaces.length,
    tabCount: snapshot.tabs.length,
    paneCount: snapshot.panes.length,
    workspaceIds: workspaces.ids,
    tabIds: tabs.ids,
    paneIds: panes.ids,
    ...(workspaces.omitted ? { workspaceIdsOmitted: workspaces.omitted } : {}),
    ...(tabs.omitted ? { tabIdsOmitted: tabs.omitted } : {}),
    ...(panes.omitted ? { paneIdsOmitted: panes.omitted } : {})
  };
}

export function paneCloseTopology(snapshot: HerdrSnapshot, caller: CloseTopology["caller"]): CloseTopology {
  return {
    caller,
    nodes: [
      ...snapshot.workspaces.map((workspace) => ({ kind: "workspace" as const, id: workspace.workspace_id })),
      ...snapshot.tabs.map((tab) => ({ kind: "tab" as const, id: tab.tab_id, parentId: tab.workspace_id })),
      ...snapshot.panes.map((pane) => ({ kind: "pane" as const, id: pane.pane_id, parentId: typeof pane.parent_id === "string" ? pane.parent_id : pane.tab_id }))
    ]
  };
}

export function tabCloseTopology(snapshot: HerdrSnapshot, caller: CloseTopology["caller"]): CloseTopology {
  return {
    caller,
    nodes: [
      ...snapshot.workspaces.map((workspace) => ({ kind: "workspace" as const, id: workspace.workspace_id })),
      ...snapshot.tabs.map((tab) => ({ kind: "tab" as const, id: tab.tab_id, parentId: tab.workspace_id })),
      ...snapshot.panes.map((pane) => ({ kind: "pane" as const, id: pane.pane_id, parentId: pane.tab_id }))
    ]
  };
}

export function snapshotIds(snapshot: HerdrSnapshot): string[] {
  return [
    ...snapshot.workspaces.map((item) => item.workspace_id),
    ...snapshot.tabs.map((item) => item.tab_id),
    ...snapshot.panes.map((item) => item.pane_id)
  ];
}
