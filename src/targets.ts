export type ResourceKind = "pane" | "agent" | "tab" | "workspace";
export type TargetRef = string;

export interface CurrentContext {
  workspaceId?: string;
  tabId?: string;
  paneId?: string;
}

export interface WorkspaceRecord {
  workspace_id: string;
  label: string;
  focused?: boolean;
  [key: string]: unknown;
}

export interface TabRecord {
  tab_id: string;
  workspace_id: string;
  label: string;
  focused?: boolean;
  [key: string]: unknown;
}

export interface PaneRecord {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
  label?: string;
  agent_status?: string;
  agent_name?: string;
  agent?: string;
  [key: string]: unknown;
}

export interface AgentRecord {
  pane_id: string;
  name?: string;
  agent?: string;
  agent_status?: string;
  [key: string]: unknown;
}

export interface HerdrSnapshot {
  version: string;
  protocol: number;
  workspaces: WorkspaceRecord[];
  tabs: TabRecord[];
  panes: PaneRecord[];
  agents: AgentRecord[];
  [key: string]: unknown;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw Object.assign(new Error(`Snapshot field ${field} is invalid`), { code: "CLI_PROTOCOL_ERROR" });
  }
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw Object.assign(new Error(`Snapshot field ${field} is invalid`), { code: "CLI_PROTOCOL_ERROR" });
  }
  return value;
}

export function parseSnapshotResult(value: unknown): HerdrSnapshot {
  if (!record(value) || value.type !== "session_snapshot" || !record(value.snapshot)) {
    throw Object.assign(new Error("Herdr snapshot result is incompatible"), { code: "CLI_PROTOCOL_ERROR" });
  }
  const raw = value.snapshot;
  if (!Array.isArray(raw.workspaces) || !Array.isArray(raw.tabs) || !Array.isArray(raw.panes) || !Array.isArray(raw.agents)) {
    throw Object.assign(new Error("Herdr snapshot collections are incompatible"), { code: "CLI_PROTOCOL_ERROR" });
  }
  const workspaces = raw.workspaces.map((item) => {
    if (!record(item)) throw Object.assign(new Error("Herdr workspace record is incompatible"), { code: "CLI_PROTOCOL_ERROR" });
    return { ...item, workspace_id: requiredString(item.workspace_id, "workspace_id"), label: requiredString(item.label, "label") } as WorkspaceRecord;
  });
  const tabs = raw.tabs.map((item) => {
    if (!record(item)) throw Object.assign(new Error("Herdr tab record is incompatible"), { code: "CLI_PROTOCOL_ERROR" });
    return { ...item, tab_id: requiredString(item.tab_id, "tab_id"), workspace_id: requiredString(item.workspace_id, "workspace_id"), label: requiredString(item.label, "label") } as TabRecord;
  });
  const panes = raw.panes.map((item) => {
    if (!record(item)) throw Object.assign(new Error("Herdr pane record is incompatible"), { code: "CLI_PROTOCOL_ERROR" });
    const pane = { ...item, pane_id: requiredString(item.pane_id, "pane_id"), tab_id: requiredString(item.tab_id, "tab_id"), workspace_id: requiredString(item.workspace_id, "workspace_id") } as PaneRecord;
    if (typeof item.name === "string") pane.agent_name = item.name;
    return pane;
  });
  const agents = raw.agents.map((item) => {
    if (!record(item)) throw Object.assign(new Error("Herdr agent record is incompatible"), { code: "CLI_PROTOCOL_ERROR" });
    const agent = { ...item, pane_id: requiredString(item.pane_id, "pane_id") } as AgentRecord;
    if (typeof item.name === "string") agent.name = item.name;
    return agent;
  });
  return { ...raw, version: requiredString(raw.version, "version"), protocol: requiredNumber(raw.protocol, "protocol"), workspaces, tabs, panes, agents } as HerdrSnapshot;
}

export function assertCurrentContext(snapshot: HerdrSnapshot, context: CurrentContext): void {
  if (!context.workspaceId || !context.tabId || !context.paneId) {
    throw new TargetResolutionError("CONTEXT_UNAVAILABLE", "CONTEXT_UNAVAILABLE: current Herdr context is unavailable");
  }
  const workspace = snapshot.workspaces.find((item) => item.workspace_id === context.workspaceId);
  const tab = snapshot.tabs.find((item) => item.tab_id === context.tabId);
  const pane = snapshot.panes.find((item) => item.pane_id === context.paneId);
  if (!workspace || !tab || !pane || tab.workspace_id !== workspace.workspace_id || pane.tab_id !== tab.tab_id || pane.workspace_id !== workspace.workspace_id) {
    throw new TargetResolutionError("CONTEXT_UNAVAILABLE", "CONTEXT_UNAVAILABLE: injected Herdr context is inconsistent", { workspaceId: context.workspaceId, tabId: context.tabId, paneId: context.paneId });
  }
}

export interface ResolvedTarget {
  kind: ResourceKind;
  id: string;
  workspaceId: string;
  tabId?: string;
  paneId?: string;
  label?: string;
  agentName?: string;
  record: WorkspaceRecord | TabRecord | PaneRecord | AgentRecord;
}

export class TargetResolutionError extends Error {
  readonly code: "INVALID_INPUT" | "CONTEXT_UNAVAILABLE" | "TARGET_NOT_FOUND" | "TARGET_AMBIGUOUS" | "TARGET_TYPE_MISMATCH";
  constructor(code: TargetResolutionError["code"], message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "TargetResolutionError";
    this.code = code;
  }
}

function exactId(snapshot: HerdrSnapshot, ref: string): ResolvedTarget | undefined {
  const workspace = snapshot.workspaces.find((item) => item.workspace_id === ref);
  if (workspace) return { kind: "workspace", id: workspace.workspace_id, workspaceId: workspace.workspace_id, label: workspace.label, record: workspace };
  const tab = snapshot.tabs.find((item) => item.tab_id === ref);
  if (tab) return { kind: "tab", id: tab.tab_id, workspaceId: tab.workspace_id, tabId: tab.tab_id, label: tab.label, record: tab };
  const pane = snapshot.panes.find((item) => item.pane_id === ref);
  if (pane) return { kind: "pane", id: pane.pane_id, workspaceId: pane.workspace_id, tabId: pane.tab_id, paneId: pane.pane_id, label: pane.label, agentName: pane.agent_name, record: pane };
  return undefined;
}

function candidates(snapshot: HerdrSnapshot, ref: string, kind: ResourceKind): ResolvedTarget[] {
  if (kind === "workspace") return snapshot.workspaces.filter((item) => item.label === ref).map((item) => ({ kind, id: item.workspace_id, workspaceId: item.workspace_id, label: item.label, record: item }));
  if (kind === "tab") return snapshot.tabs.filter((item) => item.label === ref).map((item) => ({ kind, id: item.tab_id, workspaceId: item.workspace_id, tabId: item.tab_id, label: item.label, record: item }));
  if (kind === "pane") return snapshot.panes.filter((item) => item.label === ref).map((item) => ({ kind, id: item.pane_id, workspaceId: item.workspace_id, tabId: item.tab_id, paneId: item.pane_id, label: item.label, agentName: item.agent_name, record: item }));
  const named = snapshot.agents.filter((item) => item.name === ref).map((item) => {
    const pane = snapshot.panes.find((candidate) => candidate.pane_id === item.pane_id);
    return { kind, id: item.pane_id, workspaceId: pane?.workspace_id ?? "", tabId: pane?.tab_id, paneId: item.pane_id, label: pane?.label, agentName: item.name, record: item };
  });
  const labelled = snapshot.panes.filter((item) => item.label === ref && snapshot.agents.some((agent) => agent.pane_id === item.pane_id)).map((item) => ({ kind, id: item.pane_id, workspaceId: item.workspace_id, tabId: item.tab_id, paneId: item.pane_id, label: item.label, agentName: item.agent_name, record: item }));
  return [...named, ...labelled.filter((item) => !named.some((candidate) => candidate.id === item.id))];
}

export function resolveTarget(snapshot: HerdrSnapshot, ref: TargetRef, kind: ResourceKind, context: CurrentContext): ResolvedTarget {
  if (ref.length === 0 || /[\n\r\0]/.test(ref)) throw new TargetResolutionError("INVALID_INPUT", "INVALID_INPUT: target must be a single non-empty identifier");
  if (ref === "current") {
    assertCurrentContext(snapshot, context);
    if (kind === "pane" || kind === "agent") return resolveTarget(snapshot, context.paneId!, kind, context);
    if (kind === "tab") return resolveTarget(snapshot, context.tabId!, kind, context);
    return resolveTarget(snapshot, context.workspaceId!, kind, context);
  }

  const byId = exactId(snapshot, ref);
  if (byId) {
    if (byId.kind === kind || (kind === "agent" && byId.kind === "pane" && snapshot.agents.some((agent) => agent.pane_id === byId.id))) {
      if (kind === "agent" && byId.kind === "pane") return { ...byId, kind: "agent" };
      return byId;
    }
    throw new TargetResolutionError("TARGET_TYPE_MISMATCH", `TARGET_TYPE_MISMATCH: target ${ref} is not a ${kind}`, { target: ref, actualKind: byId.kind });
  }

  const matches = candidates(snapshot, ref, kind);
  if (matches.length === 0) throw new TargetResolutionError("TARGET_NOT_FOUND", `TARGET_NOT_FOUND: no exact ${kind} target matched ${ref}`, { target: ref });
  if (matches.length > 1) throw new TargetResolutionError("TARGET_AMBIGUOUS", `TARGET_AMBIGUOUS: multiple exact ${kind} targets matched ${ref}`, { target: ref, candidates: matches.map((item) => item.id) });
  return matches[0];
}
