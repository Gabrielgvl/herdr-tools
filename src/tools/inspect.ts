import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HerdrCli } from "../cli.js";
import { InspectParamsSchema, type InspectParams } from "../schemas.js";
import { assertCurrentContext, parseSnapshotResult, resolvePaneOrAgentTarget, type CurrentContext, type HerdrSnapshot } from "../targets.js";
import { formatCall, formatResult, renderResultComponent, textComponent } from "../tui.js";
import { resolveProfile, type Profile, type ProfileCatalog, MAX_PROFILE_BODY_OUTPUT, MAX_PROFILE_LIST_ITEMS } from "../profiles/index.js";

interface InspectDetails {
  operation: "inspect";
  kind: "target" | "collection" | "health" | "profile";
  outcome: "success";
  target?: { paneId?: string; tabId?: string; workspaceId?: string; label?: string; agentName?: string };
  collection?: string;
  items?: unknown[];
  profile?: unknown;
  diagnostics?: unknown[];
  metadata?: unknown;
  recentUnwrappedLines?: string[];
  client?: { version: string; protocol: number };
  server?: { status: string; version?: string; protocol?: number };
  socketReachable?: boolean;
  compatible?: boolean;
  environment?: { enabled: boolean; currentIdsPresent: boolean; currentIdsValid: boolean };
}

export interface InspectDependencies {
  cli: HerdrCli;
  context: CurrentContext;
  environment?: { enabled: boolean; currentIdsPresent: boolean; currentIdsValid: boolean };
  profiles?: { load: () => Promise<ProfileCatalog> };
}

function asPane(result: unknown): Record<string, unknown> {
  if (typeof result !== "object" || result === null || !("pane" in result) || typeof (result as { pane?: unknown }).pane !== "object" || (result as { pane?: unknown }).pane === null) {
    throw Object.assign(new Error("Invalid Herdr pane response"), { code: "CLI_PROTOCOL_ERROR" });
  }
  return (result as { pane: Record<string, unknown> }).pane;
}

const COMPACT_COLLECTION_KEYS: Record<"panes" | "agents" | "tabs", readonly string[]> = {
  panes: ["pane_id", "tab_id", "workspace_id", "parent_id", "agent_id", "label", "agent_name", "agent", "agent_status", "status"],
  agents: ["agent_id", "pane_id", "parent_id", "name", "agent", "agent_status", "status"],
  tabs: ["tab_id", "workspace_id", "parent_id", "label"]
};

function compactCollectionRecord(value: Record<string, unknown>, collection: "panes" | "agents" | "tabs"): Record<string, unknown> {
  const allowed = new Set(COMPACT_COLLECTION_KEYS[collection]);
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => allowed.has(key) && typeof item === "string"));
}

function compactCollection(snapshot: HerdrSnapshot, collection: "panes" | "agents" | "tabs", context: CurrentContext): Record<string, unknown>[] {
  assertCurrentContext(snapshot, context);
  if (collection === "panes") return snapshot.panes.filter((pane) => pane.workspace_id === context.workspaceId && pane.tab_id === context.tabId).map((pane) => compactCollectionRecord(pane, collection));
  if (collection === "tabs") return snapshot.tabs.filter((tab) => tab.workspace_id === context.workspaceId).map((tab) => compactCollectionRecord(tab, collection));
  const currentPaneIds = new Set(snapshot.panes.filter((pane) => pane.workspace_id === context.workspaceId && pane.tab_id === context.tabId).map((pane) => pane.pane_id));
  return snapshot.agents.filter((agent) => currentPaneIds.has(agent.pane_id)).map((agent) => compactCollectionRecord(agent, collection));
}

function sourceDetails(profile: Profile): Record<string, unknown> {
  return { kind: profile.source.kind, path: profile.source.path, scopeRoot: profile.source.scopeRoot, precedence: profile.source.precedence };
}

function compactProfile(profile: Profile): Record<string, unknown> {
  return {
    name: profile.name,
    description: profile.description,
    kind: profile.runtime.kind,
    model: profile.runtime.model,
    ...(profile.runtime.kind === "pi" ? { thinking: profile.runtime.thinking } : { permissionMode: profile.runtime.permissionMode }),
    fallbackNames: [...profile.fallbacks],
    source: sourceDetails(profile)
  };
}

function profileCollection(catalog: ProfileCatalog): Record<string, unknown>[] {
  const entries = new Map<string, Record<string, unknown>>();
  for (const candidate of catalog.candidates) {
    if (candidate.profile && catalog.effective.get(candidate.name) === candidate.profile) entries.set(candidate.name, compactProfile(candidate.profile));
    else if (!entries.has(candidate.name)) entries.set(candidate.name, { name: candidate.name, valid: false, source: { kind: candidate.source.kind, path: candidate.source.path }, diagnostic: candidate.diagnostic?.message ?? "invalid profile" });
  }
  return [...entries.values()].sort((left, right) => String(left.name).localeCompare(String(right.name))).slice(0, MAX_PROFILE_LIST_ITEMS);
}

function exactProfile(catalog: ProfileCatalog, name: string): Record<string, unknown> {
  const resolution = resolveProfile(name, catalog);
  const profile = resolution.profile;
  return {
    ...compactProfile(profile),
    runtime: { ...profile.runtime, extensions: [...profile.runtime.extensions], skills: [...profile.runtime.skills] },
    body: profile.body.length > MAX_PROFILE_BODY_OUTPUT ? `${profile.body.slice(0, MAX_PROFILE_BODY_OUTPUT)}\n[profile body truncated]` : profile.body,
    fallbackNames: [...resolution.fallbackNames],
    reachableNames: [...resolution.reachableNames]
  };
}

function parseHealth(text: string): Pick<InspectDetails, "client" | "server" | "socketReachable" | "compatible"> {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw Object.assign(new Error("Health output is incompatible"), { code: "CLI_PROTOCOL_ERROR" }); }
  if (typeof parsed !== "object" || parsed === null || typeof (parsed as { client?: unknown }).client !== "object" || (parsed as { client?: unknown }).client === null || typeof (parsed as { server?: unknown }).server !== "object" || (parsed as { server?: unknown }).server === null) throw Object.assign(new Error("Health output is incompatible"), { code: "CLI_PROTOCOL_ERROR" });
  const client = (parsed as Record<string, unknown>).client as Record<string, unknown>;
  const server = (parsed as Record<string, unknown>).server as Record<string, unknown>;
  if (typeof client.version !== "string" || typeof client.protocol !== "number" || typeof server.status !== "string" || typeof server.version !== "string" || typeof server.protocol !== "number" || typeof server.compatible !== "boolean") throw Object.assign(new Error("Health output is incompatible"), { code: "CLI_PROTOCOL_ERROR" });
  return { client: { version: client.version, protocol: client.protocol }, server: { status: server.status, version: server.version, protocol: server.protocol }, socketReachable: server.status === "running", compatible: server.compatible };
}

export function createInspectTool(deps: InspectDependencies): ToolDefinition<typeof InspectParamsSchema, InspectDetails> {
  return {
    name: "herdr_inspect",
    label: "Herdr Inspect",
    description: "Inspect exact Herdr context, targets, compact collections, profiles, or health.",
    parameters: InspectParamsSchema,
    async execute(_id, params: InspectParams, signal) {
      const input = params as InspectParams;
      const mode = input.mode ?? "context";
      const profileMode = mode === "profile" || (mode === "collection" && input.collection === "profiles");
      if (profileMode) {
        if (mode === "profile" && (input.profile === undefined || input.collection !== undefined || input.target !== undefined)) throw Object.assign(new Error("profile mode requires profile and rejects target/collection"), { code: "INVALID_INPUT" });
        if (mode === "collection" && (input.profile !== undefined || input.target !== undefined)) throw Object.assign(new Error("profile collection rejects profile/target"), { code: "INVALID_INPUT" });
        if (!deps.profiles) throw Object.assign(new Error("Profile catalog is unavailable"), { code: "PROFILE_CATALOG_UNAVAILABLE" });
        const catalog = await deps.profiles.load();
        if (mode === "collection") return { content: [{ type: "text", text: "Inspected profiles" }], details: { operation: "inspect", kind: "collection", collection: "profiles", outcome: "success", items: profileCollection(catalog), diagnostics: catalog.diagnostics.slice(0, 16) } };
        return { content: [{ type: "text", text: `Inspected profile ${input.profile}` }], details: { operation: "inspect", kind: "profile", outcome: "success", profile: exactProfile(catalog, input.profile!), diagnostics: catalog.diagnostics.filter((item) => item.name === input.profile).slice(0, 8) } };
      }
      if (mode === "health") {
        if (input.target !== undefined || input.collection !== undefined || input.profile !== undefined) throw Object.assign(new Error("health does not accept target, profile, or collection"), { code: "INVALID_INPUT" });
        const health = parseHealth(await deps.cli.runText(["status", "--json"], signal!));
        return { content: [{ type: "text", text: "Herdr health inspected" }], details: { operation: "inspect", kind: "health", outcome: "success", environment: deps.environment ?? { enabled: true, currentIdsPresent: Boolean(deps.context.workspaceId && deps.context.tabId && deps.context.paneId), currentIdsValid: true }, ...health } };
      }
      if (mode === "collection") {
        if (!input.collection || input.target !== undefined || input.profile !== undefined) throw Object.assign(new Error("collection mode requires collection and rejects target/profile"), { code: "INVALID_INPUT" });
      } else if (input.collection !== undefined || input.profile !== undefined || (mode === "context" && input.target !== undefined)) {
        throw Object.assign(new Error("collection, profile, and target are only valid in their respective modes"), { code: "INVALID_INPUT" });
      } else if (mode === "target" && input.target === undefined) throw Object.assign(new Error("target mode requires target"), { code: "INVALID_INPUT" });
      const snapshot = parseSnapshotResult((await deps.cli.runJson(["api", "snapshot"], signal!)).result);
      if (mode === "collection") {
        const items = compactCollection(snapshot, input.collection as "panes" | "agents" | "tabs", deps.context);
        return { content: [{ type: "text", text: `Inspected ${input.collection}` }], details: { operation: "inspect", kind: "collection", outcome: "success", collection: input.collection, items } };
      }
      const target = resolvePaneOrAgentTarget(snapshot, input.target ?? "current", deps.context);
      const pane = asPane((await deps.cli.runJson(["pane", "get", target.paneId!], signal!)).result);
      const raw = await deps.cli.runText(["pane", "read", target.paneId!, "--source", "recent-unwrapped", "--lines", "100", "--format", "text"], signal!);
      const recentUnwrappedLines = raw.length === 0 ? [] : raw.split(/\r?\n/).slice(-100);
      const details: InspectDetails = { operation: "inspect", kind: "target", outcome: "success", target: { paneId: target.paneId, tabId: target.tabId, workspaceId: target.workspaceId, label: target.label, agentName: target.agentName }, metadata: pane, recentUnwrappedLines };
      return { content: [{ type: "text", text: formatResult({ operation: "inspect", outcome: "success", targetId: target.id }) }], details };
    },
    renderCall(rawArgs, theme) {
      const args = rawArgs as InspectParams;
      return textComponent(formatCall("herdr_inspect", args.mode ?? "context", args.target ?? args.profile), theme, "accent");
    },
    renderResult(result, options, theme) { return renderResultComponent("inspect", result, options, theme, result.details?.target?.paneId); }
  };
}
