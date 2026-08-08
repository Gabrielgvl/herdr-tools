import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HerdrCli } from "../cli.js";
import { InspectParamsSchema, type InspectParams } from "../schemas.js";
import { assertCurrentContext, parseSnapshotResult, resolvePaneOrAgentTarget, type CurrentContext, type HerdrSnapshot } from "../targets.js";
import { formatCall, formatResult, renderResultComponent, textComponent } from "../tui.js";
import { resolveProfile, type Profile, type ProfileCatalog, MAX_PROFILE_BODY_OUTPUT, MAX_PROFILE_LIST_ITEMS, MAX_PROFILE_RESULT_BYTES } from "../profiles/index.js";
import { boundedText } from "../job-registry.js";

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
  return { kind: boundedText(profile.source.kind, 32), path: boundedText(profile.source.path, 512), scopeRoot: boundedText(profile.source.scopeRoot, 512), precedence: profile.source.precedence };
}

function boundedValues(values: readonly string[], limit = 16, fieldLimit = 256): string[] {
  return values.slice(0, limit).map((value) => boundedText(value, fieldLimit));
}

function compactProfile(profile: Profile): Record<string, unknown> {
  const runtime = profile.runtime.kind === "pi"
    ? {
      thinking: profile.runtime.thinking,
      tools: boundedValues(profile.runtime.tools, 32, 128),
      extensions: boundedValues(profile.runtime.extensions, 16, 512),
      skills: boundedValues(profile.runtime.skills, 16, 512)
    }
    : {
      effort: profile.runtime.effort,
      permissionMode: profile.runtime.permissionMode,
      allowedTools: boundedValues(profile.runtime.allowedTools, 32, 128),
      disallowedTools: boundedValues(profile.runtime.disallowedTools, 16, 128),
      addDirs: boundedValues(profile.runtime.addDirs, 16, 512),
      pluginDirs: boundedValues(profile.runtime.pluginDirs, 16, 512)
    };
  return {
    name: boundedText(profile.name, 128),
    description: boundedText(profile.description, 512),
    kind: profile.runtime.kind,
    model: boundedText(profile.runtime.model, 256),
    ...runtime,
    timeoutMinutes: profile.timeoutMinutes,
    sessionPersistence: profile.sessionPersistence,
    fallbackProfiles: boundedValues(profile.fallbackProfiles, 16, 128),
    source: sourceDetails(profile)
  };
}

function profileBlockedByUnreadableScope(profile: Profile, catalog: ProfileCatalog): boolean {
  const precedence = { bundled: 0, user: 1, project: 2 } as const;
  return catalog.unreadableScopes?.some((scope) => precedence[scope] > profile.source.precedence) === true;
}

function profileCollection(catalog: ProfileCatalog): Record<string, unknown>[] {
  const entries = new Map<string, Record<string, unknown>>();
  for (const candidate of catalog.candidates) {
    if (candidate.profile && catalog.effective.get(candidate.name) === candidate.profile && !catalog.blocked?.has(candidate.name) && !profileBlockedByUnreadableScope(candidate.profile, catalog)) entries.set(candidate.name, compactProfile(candidate.profile));
    else if (!entries.has(candidate.name)) {
      const diagnostic = candidate.diagnostic?.message
        ?? (catalog.blocked?.has(candidate.name)
          ? "blocked by invalid higher-precedence profile"
          : candidate.profile && profileBlockedByUnreadableScope(candidate.profile, catalog)
            ? "blocked by unreadable higher-precedence profile scope"
            : "invalid profile");
      entries.set(candidate.name, {
        name: boundedText(candidate.name, 128),
        valid: false,
        source: { kind: boundedText(candidate.source.kind, 32), path: boundedText(candidate.source.path, 512) },
        diagnostic: boundedText(diagnostic, 512)
      });
    }
  }
  const result: Record<string, unknown>[] = [];
  for (const entry of [...entries.values()].sort((left, right) => String(left.name).localeCompare(String(right.name))).slice(0, MAX_PROFILE_LIST_ITEMS)) {
    const candidate = [...result, entry];
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_PROFILE_RESULT_BYTES - 8_000) break;
    result.push(entry);
  }
  return result;
}

function boundedBody(body: string): string {
  if (Buffer.byteLength(body, "utf8") <= MAX_PROFILE_BODY_OUTPUT) return body;
  return `${boundedText(body, MAX_PROFILE_BODY_OUTPUT - 64)}\n[profile body truncated]`;
}

function exactProfile(catalog: ProfileCatalog, name: string): Record<string, unknown> {
  const resolution = resolveProfile(name, catalog);
  const profile = resolution.profile;
  const runtime = profile.runtime.kind === "pi"
    ? {
      kind: "pi",
      model: boundedText(profile.runtime.model, 256),
      thinking: profile.runtime.thinking,
      tools: boundedValues(profile.runtime.tools, 32, 128),
      extensions: boundedValues(profile.runtime.extensions, 16, 512),
      skills: boundedValues(profile.runtime.skills, 16, 512)
    }
    : {
      kind: "claude",
      model: boundedText(profile.runtime.model, 256),
      effort: profile.runtime.effort,
      permissionMode: profile.runtime.permissionMode,
      allowedTools: boundedValues(profile.runtime.allowedTools, 32, 128),
      disallowedTools: boundedValues(profile.runtime.disallowedTools, 16, 128),
      addDirs: boundedValues(profile.runtime.addDirs, 16, 512),
      pluginDirs: boundedValues(profile.runtime.pluginDirs, 16, 512)
    };
  return {
    ...compactProfile(profile),
    runtime,
    body: boundedBody(profile.body),
    fallbackProfiles: boundedValues(resolution.fallbackProfiles, 16, 128),
    reachableNames: boundedValues(resolution.reachableNames, 16, 128)
  };
}

function modelVisibleProfile(profile: Record<string, unknown>): Record<string, unknown> {
  const runtime = profile.runtime as Record<string, unknown> | undefined;
  const source = profile.source as Record<string, unknown> | undefined;
  return {
    name: boundedText(String(profile.name), 128),
    description: boundedText(String(profile.description), 512),
    kind: boundedText(String(profile.kind), 32),
    ...(runtime?.model !== undefined ? { model: boundedText(String(runtime.model), 256) } : { model: boundedText(String(profile.model), 256) }),
    ...(runtime?.thinking !== undefined ? { thinking: boundedText(String(runtime.thinking), 32) } : profile.thinking !== undefined ? { thinking: boundedText(String(profile.thinking), 32) } : {}),
    ...(runtime?.effort !== undefined ? { effort: boundedText(String(runtime.effort), 32) } : profile.effort !== undefined ? { effort: boundedText(String(profile.effort), 32) } : {}),
    tools: boundedValues((profile.tools as string[] | undefined) || [], 32, 128),
    extensions: boundedValues((profile.extensions as string[] | undefined) || [], 16, 512),
    skills: boundedValues((profile.skills as string[] | undefined) || [], 16, 512),
    permissionMode: profile.permissionMode ?? runtime?.permissionMode,
    allowedTools: boundedValues((profile.allowedTools as string[] | undefined) || [], 32, 128),
    disallowedTools: boundedValues((profile.disallowedTools as string[] | undefined) || [], 32, 128),
    addDirs: boundedValues((profile.addDirs as string[] | undefined) || [], 16, 512),
    pluginDirs: boundedValues((profile.pluginDirs as string[] | undefined) || [], 16, 512),
    timeoutMinutes: profile.timeoutMinutes,
    sessionPersistence: profile.sessionPersistence,
    fallbackProfiles: (profile.fallbackProfiles as string[]).slice(0, 16).map((item) => boundedText(String(item), 128)),
    source: { kind: boundedText(String(source?.kind), 32), path: boundedText(String(source?.path), 512) }
  };
}

function modelVisibleDiagnostics(diagnostics: readonly unknown[]): unknown[] {
  return diagnostics.slice(0, 16).map((diagnostic) => {
    const value = diagnostic as Record<string, unknown>;
    return {
      code: boundedText(String(value.code), 64),
      ...(value.name !== undefined ? { name: boundedText(String(value.name), 128) } : {}),
      message: boundedText(String(value.message), 512),
      path: boundedText(String(value.path), 512)
    };
  });
}

function modelVisibleContent(value: Record<string, unknown>): string {
  return boundedText(JSON.stringify(value), 16_000);
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
        if (mode === "collection") {
          const items = profileCollection(catalog);
          const diagnostics = modelVisibleDiagnostics(catalog.diagnostics.slice(0, 16));
          return { content: [{ type: "text", text: modelVisibleContent({ collection: "profiles", items: items.map((item) => item.valid === false ? { name: item.name, valid: false, source: item.source, diagnostic: item.diagnostic } : modelVisibleProfile(item)), diagnostics }) }], details: { operation: "inspect", kind: "collection", collection: "profiles", outcome: "success", items, diagnostics } };
        }
        const profile = exactProfile(catalog, input.profile!);
        const diagnostics = modelVisibleDiagnostics(catalog.diagnostics.filter((item) => item.name === input.profile).slice(0, 8));
        const visibleProfile = {
          ...modelVisibleProfile(profile),
          body: boundedText(String(profile.body), MAX_PROFILE_BODY_OUTPUT),
          fallbackProfiles: (profile.fallbackProfiles as string[]).slice(0, 16).map((item) => boundedText(String(item), 128)),
          reachableNames: (profile.reachableNames as string[]).slice(0, 16).map((item) => boundedText(String(item), 128))
        };
        const content = modelVisibleContent({ profile: visibleProfile, diagnostics });
        return { content: [{ type: "text", text: content }], details: { operation: "inspect", kind: "profile", outcome: "success", profile, diagnostics } };
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
