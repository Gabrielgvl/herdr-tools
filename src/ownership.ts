import type { ResourceKind } from "./targets.js";

export type OwnedResourceKind = Extract<ResourceKind, "pane" | "tab" | "workspace">;

export interface OwnedResource {
  kind: OwnedResourceKind;
  id: string;
  parentId?: string;
}

export interface TopologyNode {
  kind: OwnedResourceKind;
  id: string;
  parentId?: string;
  children?: string[];
}

export interface CloseTopology {
  nodes: TopologyNode[];
  caller?: { paneId?: string; tabId?: string; workspaceId?: string };
}

export interface ClosePolicyContext {
  topology: CloseTopology;
  target: OwnedResource;
  hasUI: boolean;
}

export type ClosePolicyResult =
  | { allowed: true; requiresConfirmation: false; resourceIds: string[] }
  | { allowed: false; code: "PROTECTED_RESOURCE" | "CONFIRMATION_UNAVAILABLE" | "TOPOLOGY_INVALID"; resourceIds: string[] }
  | { allowed: false; requiresConfirmation: true; resourceIds: string[] };

function nodeKey(kind: OwnedResourceKind, id: string): string {
  return `${kind}:${id}`;
}

function directChildren(nodes: Map<string, TopologyNode>, node: TopologyNode): TopologyNode[] {
  const result: TopologyNode[] = [];
  for (const candidate of nodes.values()) {
    if (candidate.parentId === node.id || candidate.parentId === nodeKey(node.kind, node.id)) result.push(candidate);
  }
  for (const childId of node.children ?? []) {
    const child = [...nodes.values()].find((candidate) => candidate.id === childId);
    if (child && !result.some((candidate) => nodeKey(candidate.kind, candidate.id) === nodeKey(child.kind, child.id))) result.push(child);
  }
  return result;
}

function parentNode(nodes: Map<string, TopologyNode>, node: TopologyNode): TopologyNode | undefined {
  if (!node.parentId) return undefined;
  return [...nodes.values()].find((candidate) => candidate.id === node.parentId || nodeKey(candidate.kind, candidate.id) === node.parentId);
}

interface AffectedResources {
  resources: OwnedResource[];
  malformed: boolean;
}

function collectAffectedResources(topology: CloseTopology, target: OwnedResource): AffectedResources {
  const nodes = new Map(topology.nodes.map((node) => [nodeKey(node.kind, node.id), node]));
  const root = nodes.get(nodeKey(target.kind, target.id)) ?? { ...target };
  const result: OwnedResource[] = [];
  const visited = new Set<string>();
  const visit = (node: TopologyNode | OwnedResource): void => {
    const key = nodeKey(node.kind, node.id);
    if (visited.has(key)) return;
    visited.add(key);
    result.push({ kind: node.kind, id: node.id, parentId: node.parentId });
    for (const child of directChildren(nodes, node)) visit(child);
  };
  visit(root);

  let child = nodes.get(nodeKey(root.kind, root.id));
  let malformed = false;
  while (child) {
    const parent = parentNode(nodes, child);
    if (!parent) break;
    const parentKey = nodeKey(parent.kind, parent.id);
    if (visited.has(parentKey)) {
      malformed = true;
      break;
    }
    const remainingChildren = directChildren(nodes, parent).filter((candidate) => !visited.has(nodeKey(candidate.kind, candidate.id)));
    if (remainingChildren.length > 0) break;
    visit(parent);
    child = parent;
  }
  return { resources: result, malformed };
}

function affectedResources(topology: CloseTopology, target: OwnedResource): OwnedResource[] {
  return collectAffectedResources(topology, target).resources;
}

function protectedByCaller(topology: CloseTopology, affected: OwnedResource[], target: OwnedResource): boolean {
  const caller = topology.caller;
  if (!caller) return false;
  const protectedIds = new Set([
    caller.paneId ? nodeKey("pane", caller.paneId) : "",
    caller.tabId ? nodeKey("tab", caller.tabId) : "",
    caller.workspaceId ? nodeKey("workspace", caller.workspaceId) : ""
  ]);
  if (affected.some((resource) => protectedIds.has(nodeKey(resource.kind, resource.id)))) return true;
  return protectedIds.has(nodeKey(target.kind, target.id));
}

export class RuntimeOwnership {
  private readonly owned = new Map<string, OwnedResource>();

  record(resource: OwnedResource): void {
    this.owned.set(nodeKey(resource.kind, resource.id), { ...resource });
  }

  recordMany(resources: OwnedResource[]): void {
    for (const resource of resources) this.record(resource);
  }

  transfer(from: Pick<OwnedResource, "kind" | "id">, to: OwnedResource): void {
    const oldKey = nodeKey(from.kind, from.id);
    if (!this.owned.has(oldKey)) return;
    this.owned.delete(oldKey);
    this.record(to);
  }

  has(resource: Pick<OwnedResource, "kind" | "id">): boolean {
    return this.owned.has(nodeKey(resource.kind, resource.id));
  }

  reset(): void {
    this.owned.clear();
  }

  clear(): void {
    this.reset();
  }

  snapshot(): OwnedResource[] {
    return [...this.owned.values()].map((resource) => ({ ...resource }));
  }

  policy(context: ClosePolicyContext): ClosePolicyResult {
    const affected = collectAffectedResources(context.topology, context.target);
    const resources = affected.resources;
    const resourceIds = resources.map((resource) => resource.id);
    if (affected.malformed) return { allowed: false, code: "TOPOLOGY_INVALID", resourceIds };
    if (protectedByCaller(context.topology, resources, context.target)) {
      return { allowed: false, code: "PROTECTED_RESOURCE", resourceIds };
    }
    const whollyOwned = resources.every((resource) => this.has(resource));
    if (whollyOwned) return { allowed: true, requiresConfirmation: false, resourceIds };
    if (!context.hasUI) return { allowed: false, code: "CONFIRMATION_UNAVAILABLE", resourceIds };
    return { allowed: false, requiresConfirmation: true, resourceIds };
  }
}

export const runtimeOwnership = new RuntimeOwnership();

export function recordCreatedResource(resource: OwnedResource, ledger: RuntimeOwnership = runtimeOwnership): void {
  ledger.record(resource);
}

export function resetOwnership(ledger: RuntimeOwnership = runtimeOwnership): void {
  ledger.reset();
}

export function closePolicy(context: ClosePolicyContext, ledger: RuntimeOwnership = runtimeOwnership): ClosePolicyResult {
  return ledger.policy(context);
}

export function descendantsForClose(topology: CloseTopology, target: OwnedResource): OwnedResource[] {
  return affectedResources(topology, target);
}
