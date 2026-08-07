import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HerdrCli } from "../cli.js";
import { runtimeOwnership, type RuntimeOwnership } from "../ownership.js";
import { tabCloseTopology, snapshotIds, topologySummary, validateClose } from "../close.js";
import { closeWithReadback } from "../mutations.js";
import { assertSafeEnvironment, assertSafeIdentifier, TabParamsSchema, type TabParams } from "../topology-schema.js";
import { parseSnapshotResult, type CurrentContext, type HerdrSnapshot, type TabRecord } from "../targets.js";
import { formatCall, formatResult, renderResultComponent, textComponent } from "../tui.js";

export interface TabDetails {
  operation: TabParams["operation"];
  outcome: "success" | "reconciled";
  tabId?: string;
  workspaceId?: string;
  rootPaneId?: string;
  operationId?: string;
  mutationResult?: unknown;
  reconciliation?: { targetAbsent: true; causality: "absence_proven_only"; operationIdAvailable: false };
  removedIds?: string[];
  postState?: unknown;
}

export interface TabDependencies {
  cli: HerdrCli;
  context: CurrentContext;
  cwd?: string;
  ownership?: RuntimeOwnership;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw Object.assign(new Error("Herdr returned an incompatible tab response"), { code: "CLI_PROTOCOL_ERROR" });
  return value as Record<string, unknown>;
}

function withoutEnvironment(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutEnvironment);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/^(env|environment|env_vars|environment_variables|environmentoverrides)$/i.test(key))
    .map(([key, item]) => [key, withoutEnvironment(item)]));
}

function tabFrom(value: unknown): TabRecord {
  const root = object(value);
  const tab = object(root.tab ?? root);
  if (typeof tab.tab_id !== "string" || typeof tab.workspace_id !== "string" || typeof tab.label !== "string") throw Object.assign(new Error("Herdr tab response is incompatible"), { code: "CLI_PROTOCOL_ERROR" });
  return tab as TabRecord;
}

function createdTab(value: unknown): { tabId: string; rootPaneId?: string } {
  const root = object(value);
  const tab = object(root.tab ?? root);
  if (typeof tab.tab_id !== "string" || tab.tab_id.length === 0) throw Object.assign(new Error("Herdr tab create response is missing tab_id"), { code: "CLI_PROTOCOL_ERROR" });
  const rootPane = root.root_pane ?? root.rootPane ?? root.pane ?? (tab as Record<string, unknown>).pane;
  let rootPaneId: string | undefined;
  if (typeof rootPane === "object" && rootPane !== null && !Array.isArray(rootPane)) {
    const candidate = (rootPane as Record<string, unknown>).pane_id;
    if (typeof candidate === "string" && candidate.length > 0) rootPaneId = candidate;
  }
  return { tabId: tab.tab_id, rootPaneId };
}

function postStateTab(value: unknown, expectedTabId: string, expectedWorkspaceId: string): TabRecord {
  const tab = tabFrom(value);
  if (tab.tab_id !== expectedTabId || tab.workspace_id !== expectedWorkspaceId) {
    throw Object.assign(new Error("Herdr tab post-state does not match the requested tab"), {
      code: "POSTSTATE_UNAVAILABLE",
      details: {
        expectedTabId,
        actualTabId: tab.tab_id,
        expectedWorkspaceId,
        actualWorkspaceId: tab.workspace_id
      }
    });
  }
  return tab;
}

function authoritativeCreatedResources(before: HerdrSnapshot, after: HerdrSnapshot, resource: { tabId: string; rootPaneId?: string }, workspaceId: string): { tab: TabRecord; rootPaneId: string } {
  if (before.tabs.some((tab) => tab.tab_id === resource.tabId)) {
    throw Object.assign(new Error("Herdr tab create response reused an existing tab ID"), { code: "POSTSTATE_UNAVAILABLE" });
  }
  const matchingWorkspaces = after.workspaces.filter((workspace) => workspace.workspace_id === workspaceId);
  const matchingTabs = after.tabs.filter((tab) => tab.tab_id === resource.tabId && tab.workspace_id === workspaceId);
  if (matchingWorkspaces.length !== 1 || matchingTabs.length !== 1) {
    throw Object.assign(new Error("Created Herdr tab is not uniquely present in the caller workspace"), { code: "POSTSTATE_UNAVAILABLE" });
  }
  const [tab] = matchingTabs;
  const matchingPanes = resource.rootPaneId
    ? after.panes.filter((pane) => pane.pane_id === resource.rootPaneId)
    : after.panes.filter((pane) => pane.tab_id === resource.tabId && pane.workspace_id === workspaceId);
  if (matchingPanes.length !== 1) {
    throw Object.assign(new Error(resource.rootPaneId ? "Selected Herdr tab root pane is not uniquely present" : "Herdr tab create response omitted a uniquely discoverable root pane"), {
      code: resource.rootPaneId ? "POSTSTATE_UNAVAILABLE" : "CLI_PROTOCOL_ERROR"
    });
  }
  const [rootPane] = matchingPanes;
  if (rootPane.tab_id !== tab.tab_id || rootPane.workspace_id !== tab.workspace_id) {
    throw Object.assign(new Error("Selected Herdr tab root pane does not belong to the created tab and workspace"), { code: "POSTSTATE_UNAVAILABLE" });
  }
  if (before.panes.some((pane) => pane.pane_id === rootPane.pane_id)) {
    throw Object.assign(new Error("Herdr tab create response reused an existing root pane ID"), { code: "POSTSTATE_UNAVAILABLE" });
  }
  return { tab, rootPaneId: rootPane.pane_id };
}

async function snapshot(cli: HerdrCli, signal: AbortSignal): Promise<HerdrSnapshot> {
  return parseSnapshotResult((await cli.runJson(["api", "snapshot"], signal)).result);
}

function assertContext(snapshotValue: HerdrSnapshot, context: CurrentContext): void {
  if (!context.workspaceId || !context.tabId || !context.paneId) {
    throw Object.assign(new Error("CONTEXT_UNAVAILABLE: current Herdr context is unavailable"), { code: "CONTEXT_UNAVAILABLE" });
  }
  const workspace = snapshotValue.workspaces.find((item) => item.workspace_id === context.workspaceId);
  const tab = snapshotValue.tabs.find((item) => item.tab_id === context.tabId);
  const pane = snapshotValue.panes.find((item) => item.pane_id === context.paneId);
  if (!workspace || !tab || !pane || tab.workspace_id !== workspace.workspace_id || pane.tab_id !== tab.tab_id || pane.workspace_id !== workspace.workspace_id) {
    throw Object.assign(new Error("CONTEXT_UNAVAILABLE: injected Herdr context is inconsistent"), { code: "CONTEXT_UNAVAILABLE" });
  }
}

function tabTarget(snapshotValue: HerdrSnapshot, ref: string, context: CurrentContext): TabRecord {
  assertContext(snapshotValue, context);
  assertSafeIdentifier(ref, "target");
  const id = ref === "current" ? context.tabId! : ref;
  const tab = snapshotValue.tabs.find((candidate) => candidate.tab_id === id);
  if (!tab) throw Object.assign(new Error(`TARGET_NOT_FOUND: no exact tab ID matched ${ref}`), { code: "TARGET_NOT_FOUND", details: { target: ref } });
  return tab;
}

function envArgs(env: Record<string, string> | undefined): string[] {
  assertSafeEnvironment(env);
  return Object.entries(env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
}

async function closeTab(deps: TabDependencies, params: Extract<TabParams, { operation: "close" }>, signal: AbortSignal): Promise<TabDetails> {
  const before = await snapshot(deps.cli, signal);
  const target = tabTarget(before, params.target, deps.context);
  const validation = validateClose(tabCloseTopology(before, deps.context), { kind: "tab", id: target.tab_id, parentId: target.workspace_id });
  if (!validation.allowed) {
    throw Object.assign(new Error(`${validation.code}: tab close is not permitted`), { code: validation.code, details: { resourceIds: validation.resourceIds } });
  }
  const closed = await closeWithReadback({
    cli: deps.cli,
    argv: ["tab", "close", target.tab_id],
    signal,
    targetId: target.tab_id,
    readback: (readbackSignal) => snapshot(deps.cli, readbackSignal),
    targetPresent: (snapshotValue) => snapshotValue.tabs.some((tab) => tab.tab_id === target.tab_id),
    summarize: topologySummary
  });
  const afterIds = new Set(snapshotIds(closed.readback));
  const removedIds = snapshotIds(before).filter((id) => !afterIds.has(id));
  return {
    operation: "close",
    outcome: closed.reconciled ? "reconciled" : "success",
    tabId: target.tab_id,
    workspaceId: target.workspace_id,
    ...(closed.operationId ? { operationId: closed.operationId } : {}),
    ...(closed.mutationResult === undefined ? {} : { mutationResult: closed.mutationResult }),
    ...(closed.reconciled ? { reconciliation: { targetAbsent: true, causality: "absence_proven_only" as const, operationIdAvailable: false } } : {}),
    removedIds,
    postState: topologySummary(closed.readback)
  };
}

export function createTabTool(deps: TabDependencies): ToolDefinition<typeof TabParamsSchema, TabDetails> {
  return {
    name: "herdr_tab",
    label: "Herdr Tab",
    description: "Create and mutate Herdr tabs using stable tab IDs or the explicit current tab.",
    executionMode: "sequential",
    parameters: TabParamsSchema,
    async execute(_id, rawParams, signal, _onUpdate, ctx) {
      const activeSignal = signal ?? ctx.signal ?? new AbortController().signal;
      const params = rawParams as unknown as TabParams;
      if (params.operation === "create") {
        assertSafeIdentifier(params.label, "label");
        assertSafeEnvironment(params.env);
        const current = await snapshot(deps.cli, activeSignal);
        assertContext(current, deps.context);
        const workspaceId = deps.context.workspaceId!;
        const created = await deps.cli.runJson([
          "tab", "create", "--workspace", workspaceId, "--label", params.label,
          "--cwd", params.cwd ?? deps.cwd ?? ctx.cwd,
          ...(params.focus ? ["--focus"] : ["--no-focus"]),
          ...envArgs(params.env)
        ], activeSignal);
        const resource = createdTab(created.result);
        const afterCreate = await snapshot(deps.cli, activeSignal);
        const authoritative = authoritativeCreatedResources(current, afterCreate, resource, workspaceId);
        const postState = postStateTab((await deps.cli.runJson(["tab", "get", resource.tabId], activeSignal)).result, resource.tabId, workspaceId);
        const ledger = deps.ownership ?? runtimeOwnership;
        ledger.record({ kind: "tab", id: authoritative.tab.tab_id, parentId: authoritative.tab.workspace_id });
        ledger.record({ kind: "pane", id: authoritative.rootPaneId, parentId: authoritative.tab.tab_id });
        return tabResult({ operation: "create", outcome: "success", tabId: postState.tab_id, workspaceId: postState.workspace_id, rootPaneId: authoritative.rootPaneId, postState: withoutEnvironment(postState) }, "create", postState.tab_id);
      }
      const current = await snapshot(deps.cli, activeSignal);
      const target = tabTarget(current, params.target, deps.context);
      if (params.operation === "rename") {
        assertSafeIdentifier(params.label, "label");
        await deps.cli.runJson(["tab", "rename", target.tab_id, params.label], activeSignal);
        const postState = postStateTab((await deps.cli.runJson(["tab", "get", target.tab_id], activeSignal)).result, target.tab_id, target.workspace_id);
        return tabResult({ operation: "rename", outcome: "success", tabId: postState.tab_id, workspaceId: postState.workspace_id, postState: withoutEnvironment(postState) }, "rename", postState.tab_id);
      }
      if (params.operation === "focus") {
        await deps.cli.runJson(["tab", "focus", target.tab_id], activeSignal);
        const postState = postStateTab((await deps.cli.runJson(["tab", "get", target.tab_id], activeSignal)).result, target.tab_id, target.workspace_id);
        return tabResult({ operation: "focus", outcome: "success", tabId: postState.tab_id, workspaceId: postState.workspace_id, postState: withoutEnvironment(postState) }, "focus", postState.tab_id);
      }
      const details = await closeTab(deps, params, activeSignal);
      return { content: [{ type: "text", text: formatResult({ operation: "tab", outcome: details.outcome, targetId: details.tabId }) }], details };
    },
    renderCall(args, theme) {
      return textComponent(formatCall("herdr_tab", args.operation, "target" in args ? args.target : undefined), theme, "accent");
    },
    renderResult(output: AgentToolResult<TabDetails>, options, theme) {
      return renderResultComponent("tab", output, options, theme, output.details?.tabId);
    }
  };
}

function tabResult(details: TabDetails, operation: string, tabId: string): { content: [{ type: "text"; text: string }]; details: TabDetails } {
  return { content: [{ type: "text", text: formatResult({ operation, outcome: "success", targetId: tabId }) }], details };
}
