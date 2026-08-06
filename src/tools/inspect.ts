import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HerdrCli } from "../cli.js";
import { InspectParamsSchema, type InspectParams } from "../schemas.js";
import { assertCurrentContext, parseSnapshotResult, resolvePaneOrAgentTarget, type CurrentContext, type HerdrSnapshot } from "../targets.js";
import { formatCall, formatResult, renderResultComponent, textComponent } from "../tui.js";

interface InspectDetails {
  operation: "inspect";
  kind: "target" | "collection" | "health";
  outcome: "success";
  target?: { paneId?: string; tabId?: string; workspaceId?: string; label?: string; agentName?: string };
  collection?: string;
  items?: unknown[];
  metadata?: unknown;
  recentUnwrappedLines?: string[];
  client?: { version: string; protocol: number };
  server?: { status: string; version?: string; protocol?: number };
  socketReachable?: boolean;
  compatible?: boolean;
  environment?: {
    enabled: boolean;
    currentIdsPresent: boolean;
    currentIdsValid: boolean;
  };
}

export interface InspectDependencies {
  cli: HerdrCli;
  context: CurrentContext;
  environment?: {
    enabled: boolean;
    currentIdsPresent: boolean;
    currentIdsValid: boolean;
  };
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
  if (collection === "panes") {
    return snapshot.panes
      .filter((pane) => pane.workspace_id === context.workspaceId && pane.tab_id === context.tabId)
      .map((pane) => compactCollectionRecord(pane, collection));
  }
  if (collection === "tabs") {
    return snapshot.tabs
      .filter((tab) => tab.workspace_id === context.workspaceId)
      .map((tab) => compactCollectionRecord(tab, collection));
  }
  const currentPaneIds = new Set(snapshot.panes
    .filter((pane) => pane.workspace_id === context.workspaceId && pane.tab_id === context.tabId)
    .map((pane) => pane.pane_id));
  return snapshot.agents
    .filter((agent) => currentPaneIds.has(agent.pane_id))
    .map((agent) => compactCollectionRecord(agent, collection));
}

function parseHealth(text: string): Pick<InspectDetails, "client" | "server" | "socketReachable" | "compatible"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw Object.assign(new Error("Health output is incompatible"), { code: "CLI_PROTOCOL_ERROR" });
  }
  if (typeof parsed !== "object" || parsed === null || typeof (parsed as { client?: unknown }).client !== "object" || (parsed as { client?: unknown }).client === null || typeof (parsed as { server?: unknown }).server !== "object" || (parsed as { server?: unknown }).server === null) {
    throw Object.assign(new Error("Health output is incompatible"), { code: "CLI_PROTOCOL_ERROR" });
  }
  const parsedRecord = parsed as Record<string, unknown>;
  const client = parsedRecord.client as Record<string, unknown>;
  const server = parsedRecord.server as Record<string, unknown>;
  if (typeof client.version !== "string" || typeof client.protocol !== "number" || typeof server.status !== "string" || typeof server.version !== "string" || typeof server.protocol !== "number" || typeof server.compatible !== "boolean") {
    throw Object.assign(new Error("Health output is incompatible"), { code: "CLI_PROTOCOL_ERROR" });
  }
  return {
    client: { version: client.version, protocol: client.protocol },
    server: { status: server.status, version: server.version, protocol: server.protocol },
    socketReachable: server.status === "running",
    compatible: server.compatible
  };
}

export function createInspectTool(deps: InspectDependencies): ToolDefinition<typeof InspectParamsSchema, InspectDetails> {
  return {
    name: "herdr_inspect",
    label: "Herdr Inspect",
    description: "Inspect exact Herdr context, targets, compact collections, or health.",
    parameters: InspectParamsSchema,
    async execute(_id, params: InspectParams, signal) {
      const input = params as unknown as InspectParams;
      const mode = input.mode ?? "context";
      if (mode === "health") {
        if (input.target !== undefined || input.collection !== undefined) throw Object.assign(new Error("health does not accept target or collection"), { code: "INVALID_INPUT" });
        const health = parseHealth(await deps.cli.runText(["status", "--json"], signal!));
        return {
          content: [{ type: "text", text: "Herdr health inspected" }],
          details: {
            operation: "inspect",
            kind: "health",
            outcome: "success",
            environment: deps.environment ?? { enabled: true, currentIdsPresent: Boolean(deps.context.workspaceId && deps.context.tabId && deps.context.paneId), currentIdsValid: true },
            ...health,
          },
        };
      }
      if (mode === "collection") {
        if (!input.collection || input.target !== undefined) throw Object.assign(new Error("collection mode requires collection and rejects target"), { code: "INVALID_INPUT" });
      } else if (input.collection !== undefined || (mode === "context" && input.target !== undefined)) {
        throw Object.assign(new Error("collection and target are only valid in their respective modes"), { code: "INVALID_INPUT" });
      } else if (mode === "target" && input.target === undefined) {
        throw Object.assign(new Error("target mode requires target"), { code: "INVALID_INPUT" });
      }

      const snapshot = parseSnapshotResult((await deps.cli.runJson(["api", "snapshot"], signal!)).result);
      const targetRef = input.target ?? "current";
      if (mode === "collection") {
        const items = compactCollection(snapshot, input.collection!, deps.context);
        return { content: [{ type: "text", text: `Inspected ${input.collection}` }], details: { operation: "inspect", kind: "collection", outcome: "success", collection: input.collection, items } };
      }
      const target = resolvePaneOrAgentTarget(snapshot, targetRef, deps.context);
      const pane = asPane((await deps.cli.runJson(["pane", "get", target.paneId!], signal!)).result);
      const raw = await deps.cli.runText(["pane", "read", target.paneId!, "--source", "recent-unwrapped", "--lines", "100", "--format", "text"], signal!);
      const recentUnwrappedLines = raw.length === 0 ? [] : raw.split(/\r?\n/).slice(-100);
      const details: InspectDetails = { operation: "inspect", kind: "target", outcome: "success", target: { paneId: target.paneId, tabId: target.tabId, workspaceId: target.workspaceId, label: target.label, agentName: target.agentName }, metadata: pane, recentUnwrappedLines };
      return { content: [{ type: "text", text: formatResult({ operation: "inspect", outcome: "success", targetId: target.id }) }], details };
    },
    renderCall(rawArgs, theme) {
      const args = rawArgs as unknown as InspectParams;
      return textComponent(formatCall("herdr_inspect", args.mode ?? "context", args.target), theme, "accent");
    },
    renderResult(result, options, theme) {
      return renderResultComponent("inspect", result, options, theme, result.details?.target?.paneId);
    }
  };
}
