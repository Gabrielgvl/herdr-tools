import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HerdrCli } from "../cli.js";
import { closePolicy, recordCreatedResource, runtimeOwnership, type CloseTopology, type RuntimeOwnership } from "../ownership.js";
import { assertSafeEnvironment, assertSafeIdentifier, TabParamsSchema, type TabParams } from "../topology-schema.js";
import { parseSnapshotResult, type CurrentContext, type HerdrSnapshot, type TabRecord } from "../targets.js";
import { formatCall, formatResult, renderResultComponent, textComponent } from "../tui.js";

export interface TabDetails {
  operation: TabParams["operation"];
  outcome: "success";
  tabId?: string;
  workspaceId?: string;
  rootPaneId?: string;
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
  const rootPane = root.root_pane ?? root.rootPane;
  let rootPaneId: string | undefined;
  if (typeof rootPane === "object" && rootPane !== null && !Array.isArray(rootPane)) {
    const candidate = (rootPane as Record<string, unknown>).pane_id;
    if (typeof candidate === "string" && candidate.length > 0) rootPaneId = candidate;
  }
  return { tabId: tab.tab_id, rootPaneId };
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

function tabTopology(snapshotValue: HerdrSnapshot, context: CurrentContext): CloseTopology {
  return {
    caller: context,
    nodes: [
      ...snapshotValue.workspaces.map((workspace) => ({ kind: "workspace" as const, id: workspace.workspace_id })),
      ...snapshotValue.tabs.map((tab) => ({ kind: "tab" as const, id: tab.tab_id, parentId: tab.workspace_id })),
      ...snapshotValue.panes.map((pane) => ({ kind: "pane" as const, id: pane.pane_id, parentId: pane.tab_id }))
    ]
  };
}

function ids(snapshotValue: HerdrSnapshot): string[] {
  return [
    ...snapshotValue.workspaces.map((item) => item.workspace_id),
    ...snapshotValue.tabs.map((item) => item.tab_id),
    ...snapshotValue.panes.map((item) => item.pane_id)
  ];
}

function envArgs(env: Record<string, string> | undefined): string[] {
  assertSafeEnvironment(env);
  return Object.entries(env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
}

async function closeTab(deps: TabDependencies, params: Extract<TabParams, { operation: "close" }>, signal: AbortSignal, ctx: ExtensionContext): Promise<TabDetails> {
  const before = await snapshot(deps.cli, signal);
  const target = tabTarget(before, params.target, deps.context);
  const policy = closePolicy({ topology: tabTopology(before, deps.context), target: { kind: "tab", id: target.tab_id, parentId: target.workspace_id }, hasUI: ctx.hasUI }, deps.ownership ?? runtimeOwnership);
  if (policy.allowed === false && "requiresConfirmation" in policy && policy.requiresConfirmation) {
    if (!await ctx.ui.confirm("Close Herdr tab", `Close tab ${target.tab_id} and its descendants?`)) throw Object.assign(new Error("Close confirmation was declined"), { code: "CONFIRMATION_DECLINED" });
  } else if (policy.allowed === false) {
    throw Object.assign(new Error(`${policy.code}: tab close is not permitted`), { code: policy.code, details: { resourceIds: policy.resourceIds } });
  }
  await deps.cli.runJson(["tab", "close", target.tab_id], signal);
  const after = await snapshot(deps.cli, signal);
  if (after.tabs.some((tab) => tab.tab_id === target.tab_id)) throw Object.assign(new Error("Closed tab remains in authoritative topology"), { code: "POSTSTATE_UNAVAILABLE" });
  const afterIds = new Set(ids(after));
  const removedIds = ids(before).filter((id) => !afterIds.has(id));
  return { operation: "close", outcome: "success", tabId: target.tab_id, workspaceId: target.workspace_id, removedIds, postState: withoutEnvironment(after) };
}

export function createTabTool(deps: TabDependencies): ToolDefinition<typeof TabParamsSchema, TabDetails> {
  return {
    name: "herdr_tab",
    label: "Herdr Tab",
    description: "Create and mutate Herdr tabs using stable tab IDs or the explicit current tab.",
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
        const postState = tabFrom((await deps.cli.runJson(["tab", "get", resource.tabId], activeSignal)).result);
        recordCreatedResource({ kind: "tab", id: resource.tabId, parentId: postState.workspace_id }, deps.ownership ?? runtimeOwnership);
        if (resource.rootPaneId) recordCreatedResource({ kind: "pane", id: resource.rootPaneId, parentId: resource.tabId }, deps.ownership ?? runtimeOwnership);
        return tabResult({ operation: "create", outcome: "success", tabId: postState.tab_id, workspaceId: postState.workspace_id, rootPaneId: resource.rootPaneId, postState: withoutEnvironment(postState) }, "create", postState.tab_id);
      }
      const current = await snapshot(deps.cli, activeSignal);
      const target = tabTarget(current, params.target, deps.context);
      if (params.operation === "rename") {
        assertSafeIdentifier(params.label, "label");
        await deps.cli.runJson(["tab", "rename", target.tab_id, params.label], activeSignal);
        const postState = tabFrom((await deps.cli.runJson(["tab", "get", target.tab_id], activeSignal)).result);
        return tabResult({ operation: "rename", outcome: "success", tabId: postState.tab_id, workspaceId: postState.workspace_id, postState: withoutEnvironment(postState) }, "rename", postState.tab_id);
      }
      if (params.operation === "focus") {
        await deps.cli.runJson(["tab", "focus", target.tab_id], activeSignal);
        const postState = tabFrom((await deps.cli.runJson(["tab", "get", target.tab_id], activeSignal)).result);
        return tabResult({ operation: "focus", outcome: "success", tabId: postState.tab_id, workspaceId: postState.workspace_id, postState: withoutEnvironment(postState) }, "focus", postState.tab_id);
      }
      const details = await closeTab(deps, params, activeSignal, ctx);
      return { content: [{ type: "text", text: formatResult({ operation: "tab", outcome: "success", targetId: details.tabId }) }], details };
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
