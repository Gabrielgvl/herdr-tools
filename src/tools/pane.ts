import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { adoptAgentIdentity, assertAgentName } from "../agent-identity.js";
import type { HerdrCli } from "../cli.js";
import { contextRebindingDetails, createContextResolver, type ContextResolutionDiagnostics, type ContextResolver, type EffectiveContext } from "../context.js";
import type { CompatibilityPreflight } from "../health.js";
import { compactPromptTargetIdentity, type PromptTargetIdentity } from "../messages/prompt.js";
import { recordCreatedResource, runtimeOwnership, type RuntimeOwnership } from "../ownership.js";
import { paneCloseTopology, snapshotIds, topologySummary, validateClose } from "../close.js";
import { closeWithReadback } from "../mutations.js";
import type { SelfCloseTracker } from "../supervision/self-close.js";
import { withoutEnvironment } from "../redaction.js";
import { assertSafeEnvironment, assertSafeIdentifier, PaneParamsSchema, type PaneParams } from "../topology-schema.js";
import { parseSnapshotResult, resolvePaneOrAgentTarget, type CurrentContext, type HerdrSnapshot, type PaneRecord, type ResolvedTarget } from "../targets.js";
import { formatCall, formatResult, renderResultComponent, textComponent } from "../tui.js";

export interface PaneDetails {
  operation: PaneParams["operation"];
  outcome: "success" | "reconciled";
  contextRebinding?: ContextResolutionDiagnostics;
  paneId?: string;
  tabId?: string;
  workspaceId?: string;
  operationId?: string;
  mutationResult?: unknown;
  reconciliation?: { targetAbsent: true; causality: "absence_proven_only"; operationIdAvailable: false };
  removedIds?: string[];
  containingContext?: { tabId?: string; workspaceId?: string };
  postState?: unknown;
  agentName?: string;
  /** The verified post-adopt prompt identity; presence proves the pane is prompt-addressable by name. */
  identity?: PromptTargetIdentity;
  namePreexisting?: true;
  provenanceWarning?: string;
}

export interface PaneDependencies {
  cli: HerdrCli;
  context: CurrentContext;
  contextResolver?: ContextResolver;
  preflight: CompatibilityPreflight;
  cwd?: string;
  ownership?: RuntimeOwnership;
  /** The host's own-close ledger; omitted on hosts whose wakes are never gated. */
  selfClose?: SelfCloseTracker;
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

function stateTarget(snapshot: HerdrSnapshot, ref: string | undefined, context: CurrentContext): ResolvedTarget {
  return resolvePaneRef(snapshot, ref ?? "current", context);
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

async function closePane(deps: PaneDependencies, params: Extract<PaneParams, { operation: "close" }>, signal: AbortSignal, effective: EffectiveContext): Promise<PaneDetails> {
  const before = effective.snapshot;
  const target = stateTarget(before, params.target, effective.context);
  const validation = validateClose(paneCloseTopology(before, effective.context), { kind: "pane", id: target.id, parentId: target.tabId });
  if (!validation.allowed) {
    throw Object.assign(new Error(`${validation.code}: pane close is not permitted`), { code: validation.code, details: { resourceIds: validation.resourceIds } });
  }
  // Tracking starts only after the resolved target passed validation, and the
  // finisher runs on every exit. Only the close's own proven success — a
  // successful envelope plus an absence-proving readback — may suppress the
  // matching pane_closed wake; a reconciled absence proves the pane is gone
  // but not that this close did it, and every failure still wakes.
  const finish = deps.selfClose?.begin(target.id);
  let confirmed = false;
  try {
    const closed = await closeWithReadback({
      cli: deps.cli,
      argv: ["pane", "close", target.id],
      signal,
      targetId: target.id,
      readback: (readbackSignal) => readSnapshot(deps.cli, readbackSignal),
      targetPresent: (snapshot) => snapshot.panes.some((pane) => pane.pane_id === target.id),
      summarize: topologySummary
    });
    confirmed = closed.reconciled === false;
    const afterIds = new Set(snapshotIds(closed.readback));
    const removed = snapshotIds(before).filter((id) => !afterIds.has(id));
    return {
      operation: "close",
      outcome: closed.reconciled ? "reconciled" : "success",
      paneId: target.id,
      tabId: target.tabId,
      workspaceId: target.workspaceId,
      ...(closed.operationId ? { operationId: closed.operationId } : {}),
      ...(closed.mutationResult === undefined ? {} : { mutationResult: closed.mutationResult }),
      ...(closed.reconciled ? { reconciliation: { targetAbsent: true, causality: "absence_proven_only" as const, operationIdAvailable: false } } : {}),
      removedIds: removed,
      containingContext: { tabId: target.tabId, workspaceId: target.workspaceId },
      postState: topologySummary(closed.readback),
      ...contextRebindingDetails(effective.diagnostics)
    };
  } finally {
    finish?.(confirmed);
  }
}

export function createPaneTool(deps: PaneDependencies): ToolDefinition<typeof PaneParamsSchema, PaneDetails> {
  const contextResolver = deps.contextResolver ?? createContextResolver(deps.cli, deps.context);
  return {
    name: "herdr_pane",
    label: "Herdr Pane",
    description: "Inspect and mutate exact Herdr pane topology through explicit stable targets; adopt binds a verified agent name to a detected pane for prompt routing.",
    executionMode: "sequential",
    parameters: PaneParamsSchema,
    async execute(_id, rawParams, signal, _onUpdate, ctx) {
      const activeSignal = signal ?? ctx.signal ?? new AbortController().signal;
      const params = rawParams as unknown as PaneParams;
      if (params.operation === "split") {
        await deps.preflight(activeSignal);
        assertSafeIdentifier(params.label, "label");
        assertSafeEnvironment(params.env);
        const effective = await contextResolver(activeSignal);
        const snapshot = effective.snapshot;
        const target = stateTarget(snapshot, params.target, effective.context);
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
        return result({ operation: "split", outcome: "success", paneId, tabId: postState.tab_id, workspaceId: postState.workspace_id, postState: withoutEnvironment(postState), ...contextRebindingDetails(effective.diagnostics) }, "split", paneId);
      }
      if (params.operation === "move") {
        await deps.preflight(activeSignal);
        const effective = await contextResolver(activeSignal);
        const snapshot = effective.snapshot;
        const source = stateTarget(snapshot, params.target, effective.context);
        const destination = params.destination;
        let argv = ["pane", "move", source.id];
        if (destination.kind === "tab") {
          const tab = exactTabTarget(snapshot, destination.target, effective.context);
          argv = [...argv, "--tab", tab.id, "--split", params.direction ?? "right"];
        } else {
          assertSafeIdentifier(destination.label, "destination.label");
          argv = [...argv, "--new-tab", "--workspace", effective.context.workspaceId, "--label", destination.label];
        }
        argv = [...argv, ...(params.focus ? ["--focus"] : ["--no-focus"] )];
        const moved = await deps.cli.runJson(argv, activeSignal);
        const paneId = resourceId(moved.result);
        const postState = await readPane(deps.cli, paneId, activeSignal);
        const ledger = deps.ownership ?? runtimeOwnership;
        if (destination.kind === "new_tab") ledger.record({ kind: "tab", id: postState.tab_id, parentId: postState.workspace_id });
        if (ledger.has({ kind: "pane", id: source.id })) {
          if (source.id === paneId) ledger.record({ kind: "pane", id: paneId, parentId: postState.tab_id });
          else ledger.transfer({ kind: "pane", id: source.id }, { kind: "pane", id: paneId, parentId: postState.tab_id });
        }
        return result({ operation: "move", outcome: "success", paneId, tabId: postState.tab_id, workspaceId: postState.workspace_id, postState: withoutEnvironment(postState), ...contextRebindingDetails(effective.diagnostics) }, "move", paneId);
      }
      if (params.operation === "rename") {
        assertSafeIdentifier(params.label, "label");
        await deps.preflight(activeSignal);
        const effective = await contextResolver(activeSignal);
        const snapshot = effective.snapshot;
        const target = stateTarget(snapshot, params.target, effective.context);
        await deps.cli.runJson(["pane", "rename", target.id, params.label], activeSignal);
        const postState = await readPane(deps.cli, target.id, activeSignal);
        return result({ operation: "rename", outcome: "success", paneId: postState.pane_id, tabId: postState.tab_id, workspaceId: postState.workspace_id, postState: withoutEnvironment(postState), ...contextRebindingDetails(effective.diagnostics) }, "rename", postState.pane_id);
      }
      if (params.operation === "focus") {
        await deps.preflight(activeSignal);
        const effective = await contextResolver(activeSignal);
        const snapshot = effective.snapshot;
        const target = stateTarget(snapshot, params.target, effective.context);
        await focusExactPane(deps.cli, target, activeSignal);
        const postState = await readPane(deps.cli, target.id, activeSignal);
        return result({ operation: "focus", outcome: "success", paneId: postState.pane_id, tabId: postState.tab_id, workspaceId: postState.workspace_id, postState: withoutEnvironment(postState), ...contextRebindingDetails(effective.diagnostics) }, "focus", postState.pane_id);
      }
      if (params.operation === "resize") {
        if (typeof params.amount !== "number" || !Number.isFinite(params.amount) || params.amount <= 0) throw Object.assign(new Error("resize amount must be finite and positive"), { code: "INVALID_INPUT" });
        await deps.preflight(activeSignal);
        const effective = await contextResolver(activeSignal);
        const snapshot = effective.snapshot;
        const target = stateTarget(snapshot, params.target, effective.context);
        await deps.cli.runJson(["pane", "resize", "--direction", params.direction, "--amount", String(params.amount), "--pane", target.id], activeSignal);
        const postState = await readPane(deps.cli, target.id, activeSignal);
        return result({ operation: "resize", outcome: "success", paneId: postState.pane_id, tabId: postState.tab_id, workspaceId: postState.workspace_id, postState: withoutEnvironment(postState), ...contextRebindingDetails(effective.diagnostics) }, "resize", postState.pane_id);
      }
      if (params.operation === "swap") {
        await deps.preflight(activeSignal);
        const effective = await contextResolver(activeSignal);
        const snapshot = effective.snapshot;
        const source = stateTarget(snapshot, params.source, effective.context);
        const withTarget = params.with;
        const argv = ["pane", "swap", ...(isDirection(withTarget) ? ["--direction", withTarget, "--pane", source.id] : ["--source-pane", source.id, "--target-pane", resolvePaneRef(snapshot, withTarget, effective.context).id])];
        await deps.cli.runJson(argv, activeSignal);
        const postState = await readPane(deps.cli, source.id, activeSignal);
        return result({ operation: "swap", outcome: "success", paneId: postState.pane_id, tabId: postState.tab_id, workspaceId: postState.workspace_id, postState: withoutEnvironment(postState), ...contextRebindingDetails(effective.diagnostics) }, "swap", postState.pane_id);
      }
      if (params.operation === "zoom") {
        await deps.preflight(activeSignal);
        const effective = await contextResolver(activeSignal);
        const snapshot = effective.snapshot;
        const target = stateTarget(snapshot, params.target, effective.context);
        const mode = params.mode ?? "toggle";
        await deps.cli.runJson(["pane", "zoom", target.id, `--${mode}`], activeSignal);
        const postState = await readPane(deps.cli, target.id, activeSignal);
        return result({ operation: "zoom", outcome: "success", paneId: postState.pane_id, tabId: postState.tab_id, workspaceId: postState.workspace_id, postState: withoutEnvironment(postState), ...contextRebindingDetails(effective.diagnostics) }, "zoom", postState.pane_id);
      }
      if (params.operation === "adopt") {
        assertAgentName(params.name, "name");
        await deps.preflight(activeSignal);
        const effective = await contextResolver(activeSignal);
        const target = stateTarget(effective.snapshot, params.target, effective.context);
        const adopted = await adoptAgentIdentity(deps.cli, effective.snapshot, target.id, params.name, effective.context.paneId, activeSignal);
        return result({
          operation: "adopt",
          outcome: "success",
          paneId: adopted.paneId,
          agentName: adopted.agentName,
          identity: compactPromptTargetIdentity(adopted.identity),
          ...(adopted.namePreexisting === undefined ? {} : { namePreexisting: true }),
          ...(adopted.provenanceWarning === undefined ? {} : { provenanceWarning: adopted.provenanceWarning }),
          ...contextRebindingDetails(effective.diagnostics)
        }, "adopt", adopted.paneId);
      }
      await deps.preflight(activeSignal);
      const effective = await contextResolver(activeSignal);
      const details = await closePane(deps, params, activeSignal, effective);
      return { content: [{ type: "text", text: formatResult({ operation: "pane", outcome: details.outcome, targetId: details.paneId }) }], details };
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
  return resolvePaneOrAgentTarget(snapshot, ref, context);
}

function isDirection(value: string): value is "right" | "down" | "left" | "up" {
  return value === "right" || value === "down" || value === "left" || value === "up";
}

function result(details: PaneDetails, operation: string, targetId: string): { content: [{ type: "text"; text: string }]; details: PaneDetails } {
  return { content: [{ type: "text", text: formatResult({ operation, outcome: "success", targetId }) }], details };
}
