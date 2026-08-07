import type { ResourceKind } from "./targets.js";

export type OwnedResourceKind = Extract<ResourceKind, "pane" | "tab" | "workspace">;

export interface OwnedResource {
  kind: OwnedResourceKind;
  id: string;
  parentId?: string;
}

export class RuntimeOwnership {
  private readonly owned = new Map<string, OwnedResource>();

  record(resource: OwnedResource): void {
    this.owned.set(`${resource.kind}:${resource.id}`, { ...resource });
  }

  recordMany(resources: OwnedResource[]): void {
    for (const resource of resources) this.record(resource);
  }

  transfer(from: Pick<OwnedResource, "kind" | "id">, to: OwnedResource): void {
    const oldKey = `${from.kind}:${from.id}`;
    if (!this.owned.has(oldKey)) return;
    this.owned.delete(oldKey);
    this.record(to);
  }

  has(resource: Pick<OwnedResource, "kind" | "id">): boolean {
    return this.owned.has(`${resource.kind}:${resource.id}`);
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
}

export const runtimeOwnership = new RuntimeOwnership();

export function recordCreatedResource(resource: OwnedResource, ledger: RuntimeOwnership = runtimeOwnership): void {
  ledger.record(resource);
}

export function resetOwnership(ledger: RuntimeOwnership = runtimeOwnership): void {
  ledger.reset();
}
