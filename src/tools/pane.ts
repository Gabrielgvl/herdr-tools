import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HerdrCli } from "../cli.js";
import { closePolicy, recordCreatedResource, runtimeOwnership, type CloseTopology, type RuntimeOwnership } from "../ownership.js";
import { assertSafeEnvironment, assertSafeIdentifier, PaneParamsSchema, type PaneParams } from "../topology-schema.js";
import { parseSnapshotResult, resolveTarget, type CurrentContext, type HerdrSnapshot, type PaneRecord, type ResolvedTarget } from "../targets.js";
import { formatCall, formatResult, renderResultComponent, textComponent } from "../tui.js";

export interface PaneDetails {
  operation: PaneParams["operation"];
  outcome: "success";
  paneId?: string;
  tabId?: string;
  workspaceId?: string;
  removedIds?: string[];
  containingContext?: { tabId?: string; workspaceId?: string };
  postState?: unknown;
}

export interface PaneDependencies {
  cli: HerdrCli;
  context: CurrentContext;
  cwd?: string;
  ownership?: RuntimeOwnership;
}

interface LayoutPane {
  pane_id: string;
  rect: { x: number; y: number; width: number; height: number };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw Object.assign(new Error("Herdr returned an incompatible topology response"), { code: "CLI_PROTOCOL_ERROR" });
  }
  return value as Record<string, unknown>;
}

function nestedRecord(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const candidate = value[key];
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate) ? candidate as Record<string, unknown> : undefined;
}

function resourceId(value: unknown): string {
  const root = record(value);
  const preferred = [root.pane, nestedRecord(root, "split_result")?.pane, nestedRecord(root, "move_result")?.pane];
  for (const candidate of preferred) {
    const object = typeof candidate === "object" && candidate !== null && !Array.isArray(candidate) ? candidate as Record<string, unknown> : undefined;
    if (typeof object?.pane_id === "string" && object.pane_id.length > 0) return object.pane_id;
  }
  throw Object.assign(new Error("Herdr mutation response is missing pane_id"), { code: "CLI_PROTOCOL_ERROR" });
}

function withoutEnvironment(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutEnvironment);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/^(env|environment|env_vars|environment_variables|environmentoverrides)$/i.test(key))
    .map(([key, item]) => [key, withoutEnvironment(item)]));
}

function paneFrom(value: unknown): PaneRecord {
  const root = record(value);
  const pane = root.pane ?? root;
  const object = record(pane);
  if (typeof object.pane_id !== "string" || typeof object.tab_id !== "string" || typeof object.workspace_id !== "string") {
    throw Object.assign(new Error("Herdr pane response is incompatible"), { code: "CLI_PROTOCOL_ERROR" });
  }
  return object as PaneRecord;
}

function layoutFrom(value: unknown): { tabId: string; focusedPaneId: string; panes: LayoutPane[] } {
  const root = record(value);
  const layout = record(root.layout ?? root);
  const tabId = layout.tab_id;
  const focusedPaneId = layout.focused_pane_id;
  if (typeof tabId !== "string" || typeof focusedPaneId !== "string" || !Array.isArray(layout.panes)) {
    throw Object.assign(new Error("Herdr pane layout response is incompatible"), { code: "CLI_PROTOCOL_ERROR" });
  }
  const panes = layout.panes.map((item) => {
    const pane = record(item);
    const rect = record(pane.rect);
    if (typeof pane.pane_id !== "string" || ![rect.x, rect.y, rect.width, rect.height].every((item) => typeof item === "number" && Number.isFinite(item))) {
      throw Object.assign(new Error("Herdr pane layout record is incompatible"), { code: "CLI_PROTOCOL_ERROR" });
    }
    return { pane_id: pane.pane_id, rect: { x: rect.x as number, y: rect.y as number, width: rect.width as number, height: rect.height as number } };
  });
  return { tabId, focusedPaneId, panes };
}

function assertContext(snapshot: HerdrSnapshot, context: CurrentContext): void {
  if (!context.workspaceId || !context.tabId || !context.paneId) {
    throw Object.assign(new Error("CONTEXT_UNAVAILABLE: current Herdr context is unavailable"), { code: "CONTEXT_UNAVAILABLE" });
  }
  const workspace = snapshot.workspaces.find((item) => item.workspace_id === context.workspaceId);
  const tab = snapshot.tabs.find((item) => item.tab_id === context.tabId);
  const pane = snapshot.panes.find((item) => item.pane_id === context.paneId);
  if (!workspace || !tab || !pane || tab.workspace_id !== workspace.workspace_id || pane.tab_id !== tab.tab_id || pane.workspace_id !== workspace.workspace_id) {
    throw Object.assign(new Error("CONTEXT_UNAVAILABLE: injected Herdr context is inconsistent"), { code: "CONTEXT_UNAVAILABLE" });
  }
}

function stateTarget(snapshot: HerdrSnapshot, ref: string | undefined, context: CurrentContext): ResolvedTarget {
  assertContext(snapshot, context);
  return resolvePaneRef(snapshot, ref ?? "current", context);
}

function paneTopology(snapshot: HerdrSnapshot, context: CurrentContext): CloseTopology {
  return {
    caller: context,
    nodes: [
      ...snapshot.workspaces.map((workspace) => ({ kind: "workspace" as const, id: workspace.workspace_id })),
      ...snapshot.tabs.map((tab) => ({ kind: "tab" as const, id: tab.tab_id, parentId: tab.workspace_id })),
      ...snapshot.panes.map((pane) => ({
        kind: "pane" as const,
        id: pane.pane_id,
        parentId: typeof pane.parent_id === "string" ? pane.parent_id : pane.tab_id
      }))
    ]
  };
}

function allSnapshotIds(snapshot: HerdrSnapshot): string[] {
  return [
    ...snapshot.workspaces.map((item) => item.workspace_id),
    ...snapshot.tabs.map((item) => item.tab_id),
    ...snapshot.panes.map((item) => item.pane_id)
  ];
}

function envArgs(env: Record<string, string> | undefined): string[] {
  assertSafeEnvironment(env);
  return Object.entries(env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
}

function focusDirection(source: LayoutPane, target: LayoutPane): "left" | "right" | "up" | "down" {
  const sourceRight = source.rect.x + source.rect.width;
  const sourceBottom = source.rect.y + source.rect.height;
  const targetRight = target.rect.x + target.rect.width;
  const targetBottom = target.rect.y + target.rect.height;
  const verticalOverlap = Math.min(sourceBottom, targetBottom) > Math.max(source.rect.y, target.rect.y);
  const horizontalOverlap = Math.min(sourceRight, targetRight) > Math.max(source.rect.x, target.rect.x);
  if (verticalOverlap && target.rect.x >= sourceRight) return "right";
  if (verticalOverlap && targetRight <= source.rect.x) return "left";
  if (horizontalOverlap && target.rect.y >= sourceBottom) return "down";
  if (horizontalOverlap && targetBottom <= source.rect.y) return "up";
  const dx = target.rect.x + target.rect.width / 2 - (source.rect.x + source.rect.width / 2);
  const dy = target.rect.y + target.rect.height / 2 - (source.rect.y + source.rect.height / 2);
  return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? "right" : "left") : (dy >= 0 ? "down" : "up");
}

async function readSnapshot(cli: HerdrCli, signal: AbortSignal): Promise<HerdrSnapshot> {
  return parseSnapshotResult((await cli.runJson(["api", "snapshot"], signal)).result);
}

async function readPane(cli: HerdrCli, paneId: string, signal: AbortSignal): Promise<PaneRecord> {
  return paneFrom((await cli.runJson(["pane", "get", paneId], signal)).result);
}

async function focusExactPane(cli: HerdrCli, target: ResolvedTarget, signal: AbortSignal): Promise<void> {
  let layout = layoutFrom((await cli.runJson(["pane", "layout", "--current"], signal)).result);
  if (layout.tabId !== target.tabId) {
    await cli.runJson(["tab", "focus", target.tabId!], signal);
    layout = layoutFrom((await cli.runJson(["pane", "layout", "--current"], signal)).result);
  }
  for (let step = 0; step <= layout.panes.length; step += 1) {
    if (layout.focusedPaneId === target.paneId) return;
    const source = layout.panes.find((pane) => pane.pane_id === layout.focusedPaneId);
    const destination = layout.panes.find((pane) => pane.pane_id === target.paneId);
    if (!source || !destination) throw Object.assign(new Error("Target pane is absent from authoritative layout"), { code: "TARGET_NOT_FOUND" });
    const direction = focusDirection(source, destination);
    await cli.runJson(["pane", "focus", "--direction", direction, "--pane", source.pane_id], signal);
    layout = layoutFrom((await cli.runJson(["pane", "layout", "--current"], signal)).result);
  }
  throw Object.assign(new Error("Herdr could not reach the exact pane through authoritative layout"), { code: "CLI_PROTOCOL_ERROR" });
}

async function closePane(deps: PaneDependencies, params: Extract<PaneParams, { operation: "close" }>, signal: AbortSignal, ctx: ExtensionContext): Promise<PaneDetails> {
  const before = await readSnapshot(deps.cli, signal);
  const target = stateTarget(before, params.target, deps.context);
  const ownership = deps.ownership ?? runtimeOwnership;
  const policy = closePolicy({ topology: paneTopology(before, deps.context), target: { kind: "pane", id: target.id, parentId: target.tabId }, hasUI: ctx.hasUI }, ownership);
  if (policy.allowed === false && "requiresConfirmation" in policy && policy.requiresConfirmation) {
    if (!await ctx.ui.confirm("Close Herdr pane", `Close pane ${target.id} and its descendants?`)) throw Object.assign(new Error("Close confirmation was declined"), { code: "CONFIRMATION_DECLINED" });
  } else if (policy.allowed === false) {
    throw Object.assign(new Error(`${policy.code}: pane close is not permitted`), { code: policy.code, details: { resourceIds: policy.resourceIds } });
  }
  await deps.cli.runJson(["pane", "close", target.id], signal);
  const after = await readSnapshot(deps.cli, signal);
  if (after.panes.some((pane) => pane.pane_id === target.id)) throw Object.assign(new Error("Closed pane remains in authoritative topology"), { code: "POSTSTATE_UNAVAILABLE" });
  const afterIds = new Set(allSnapshotIds(after));
  const removed = allSnapshotIds(before).filter((id) => !afterIds.has(id));
  return { operation: "close", outcome: "success", paneId: target.id, tabId: target.tabId, workspaceId: target.workspaceId, removedIds: removed, containingContext: { tabId: target.tabId, workspaceId: target.workspaceId }, postState: withoutEnvironment(after) };
}

export function createPaneTool(deps: PaneDependencies): ToolDefinition<typeof PaneParamsSchema, PaneDetails> {
  return {
    name: "herdr_pane",
    label: "Herdr Pane",
    description: "Inspect and mutate exact Herdr pane topology through explicit stable targets.",
    parameters: PaneParamsSchema,
    async execute(_id, rawParams, signal, _onUpdate, ctx) {
      const activeSignal = signal ?? ctx.signal ?? new AbortController().signal;
      const params = rawParams as unknown as PaneParams;
      if (params.operation === "split") {
        assertSafeIdentifier(params.label, "label");
        assertSafeEnvironment(params.env);
        const snapshot = await readSnapshot(deps.cli, activeSignal);
        const target = stateTarget(snapshot, params.target, deps.context);
        const newPaneResponse = await deps.cli.runJson([
          "pane", "split", target.id, "--direction", params.direction ?? "right",
          "--cwd", params.cwd ?? deps.cwd ?? ctx.cwd,
          ...(params.focus ? ["--focus"] : ["--no-focus"]),
          ...envArgs(params.env)
        ], activeSignal);
        const paneId = resourceId(newPaneResponse.result);
        recordCreatedResource({ kind: "pane", id: paneId, parentId: target.tabId }, deps.ownership ?? runtimeOwnership);
        await deps.cli.runJson(["pane", "rename", paneId, params.label], activeSignal);
        const postState = await readPane(deps.cli, paneId, activeSignal);
        return result({ operation: "split", outcome: "success", paneId, tabId: postState.tab_id, workspaceId: postState.workspace_id, postState: withoutEnvironment(postState) }, "split", paneId);
      }
      if (params.operation === "move") {
        const snapshot = await readSnapshot(deps.cli, activeSignal);
        const source = stateTarget(snapshot, params.target, deps.context);
        const destination = params.destination;
        let argv = ["pane", "move", source.id];
        if (destination.kind === "tab") {
          const tab = exactTabTarget(snapshot, destination.target, deps.context);
          argv = [...argv, "--tab", tab.id, "--split", params.direction ?? "right"];
        } else {
          assertSafeIdentifier(destination.label, "destination.label");
          argv = [...argv, "--new-tab", "--workspace", source.workspaceId, "--tab-label", destination.label];
        }
        argv = [...argv, ...(params.focus ? ["--focus"] : ["--no-focus"] )];
        const moved = await deps.cli.runJson(argv, activeSignal);
        const paneId = resourceId(moved.result);
        const postState = await readPane(deps.cli, paneId, activeSignal);
        const ledger = deps.ownership ?? runtimeOwnership;
        if (ledger.has({ kind: "pane", id: source.id })) {
          if (source.id === paneId) ledger.record({ kind: "pane", id: paneId, parentId: postState.tab_id });
          else ledger.transfer({ kind: "pane", id: source.id }, { kind: "pane", id: paneId, parentId: postState.tab_id });
        }
        return result({ operation: "move", outcome: "success", paneId, tabId: postState.tab_id, workspaceId: postState.workspace_id, postState: withoutEnvironment(postState) }, "move", paneId);
      }
      if (params.operation === "rename") {
        assertSafeIdentifier(params.label, "label");
        const snapshot = await readSnapshot(deps.cli, activeSignal);
        const target = stateTarget(snapshot, params.target, deps.context);
        await deps.cli.runJson(["pane", "rename", target.id, params.label], activeSignal);
        const postState = await readPane(deps.cli, target.id, activeSignal);
        return result({ operation: "rename", outcome: "success", paneId: postState.pane_id, tabId: postState.tab_id, workspaceId: postState.workspace_id, postState: withoutEnvironment(postState) }, "rename", postState.pane_id);
      }
      if (params.operation === "focus") {
        const snapshot = await readSnapshot(deps.cli, activeSignal);
        const target = stateTarget(snapshot, params.target, deps.context);
        await focusExactPane(deps.cli, target, activeSignal);
        const postState = await readPane(deps.cli, target.id, activeSignal);
        return result({ operation: "focus", outcome: "success", paneId: postState.pane_id, tabId: postState.tab_id, workspaceId: postState.workspace_id, postState: withoutEnvironment(postState) }, "focus", postState.pane_id);
      }
      if (params.operation === "resize") {
        if (typeof params.amount !== "number" || !Number.isFinite(params.amount) || params.amount <= 0) throw Object.assign(new Error("resize amount must be finite and positive"), { code: "INVALID_INPUT" });
        const snapshot = await readSnapshot(deps.cli, activeSignal);
        const target = stateTarget(snapshot, params.target, deps.context);
        await deps.cli.runJson(["pane", "resize", "--direction", params.direction, "--amount", String(params.amount), "--pane", target.id], activeSignal);
        const postState = await readPane(deps.cli, target.id, activeSignal);
        return result({ operation: "resize", outcome: "success", paneId: postState.pane_id, tabId: postState.tab_id, workspaceId: postState.workspace_id, postState: withoutEnvironment(postState) }, "resize", postState.pane_id);
      }
      if (params.operation === "swap") {
        const snapshot = await readSnapshot(deps.cli, activeSignal);
        const source = stateTarget(snapshot, params.source, deps.context);
        const withTarget = params.with;
        const argv = ["pane", "swap", ...(isDirection(withTarget) ? ["--direction", withTarget, "--pane", source.id] : ["--source-pane", source.id, "--target-pane", resolvePaneRef(snapshot, withTarget, deps.context).id])];
        await deps.cli.runJson(argv, activeSignal);
        const postState = await readPane(deps.cli, source.id, activeSignal);
        return result({ operation: "swap", outcome: "success", paneId: postState.pane_id, tabId: postState.tab_id, workspaceId: postState.workspace_id, postState: withoutEnvironment(postState) }, "swap", postState.pane_id);
      }
      if (params.operation === "zoom") {
        const snapshot = await readSnapshot(deps.cli, activeSignal);
        const target = stateTarget(snapshot, params.target, deps.context);
        const mode = params.mode ?? "toggle";
        await deps.cli.runJson(["pane", "zoom", target.id, `--${mode}`], activeSignal);
        const postState = await readPane(deps.cli, target.id, activeSignal);
        return result({ operation: "zoom", outcome: "success", paneId: postState.pane_id, tabId: postState.tab_id, workspaceId: postState.workspace_id, postState: withoutEnvironment(postState) }, "zoom", postState.pane_id);
      }
      const details = await closePane(deps, params, activeSignal, ctx);
      return { content: [{ type: "text", text: formatResult({ operation: "pane", outcome: "success", targetId: details.paneId }) }], details };
    },
    renderCall(args, theme) {
      return textComponent(formatCall("herdr_pane", args.operation, "target" in args ? args.target : "source" in args ? args.source : undefined), theme, "accent");
    },
    renderResult(output: AgentToolResult<PaneDetails>, options, theme) {
      return renderResultComponent("pane", output, options, theme, output.details?.paneId);
    }
  };
}

function exactTabTarget(snapshot: HerdrSnapshot, ref: string, context: CurrentContext): ResolvedTarget {
  assertSafeIdentifier(ref, "destination.target");
  const id = ref === "current" ? context.tabId! : ref;
  const tab = snapshot.tabs.find((candidate) => candidate.tab_id === id);
  if (!tab) throw Object.assign(new Error(`TARGET_NOT_FOUND: no exact tab ID matched ${ref}`), { code: "TARGET_NOT_FOUND", details: { target: ref } });
  return { kind: "tab", id: tab.tab_id, workspaceId: tab.workspace_id, tabId: tab.tab_id, label: tab.label, record: tab };
}

function resolvePaneRef(snapshot: HerdrSnapshot, ref: string, context: CurrentContext): ResolvedTarget {
  try {
    return resolveTarget(snapshot, ref, "pane", context);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "TARGET_NOT_FOUND") return resolveTarget(snapshot, ref, "agent", context);
    throw error;
  }
}

function isDirection(value: string): value is "right" | "down" | "left" | "up" {
  return value === "right" || value === "down" || value === "left" || value === "up";
}

function result(details: PaneDetails, operation: string, targetId: string): { content: [{ type: "text"; text: string }]; details: PaneDetails } {
  return { content: [{ type: "text", text: formatResult({ operation, outcome: "success", targetId }) }], details };
}
