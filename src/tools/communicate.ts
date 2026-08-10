import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HerdrCli, JsonEnvelope } from "../cli.js";
import type { CompatibilityPreflight } from "../health.js";
import { buildEnvelope, resolveSender, type SenderIdentity } from "../provenance.js";
import { CommunicateParamsSchema, isNamedKey, type CommunicateParams } from "../schemas.js";
import { parseSnapshotResult, resolveTarget, type CurrentContext } from "../targets.js";
import { formatCall, formatResult, renderResultComponent, textComponent } from "../tui.js";

export type CommunicateRoute = "prompt_direct" | "steer_direct";
export type CommunicateState = "idle" | "working" | "blocked" | "done" | "unknown";

export interface CommunicateDetails {
  operation: "prompt" | "steer" | "keys";
  outcome: "sent";
  target: { paneId?: string; tabId?: string; workspaceId?: string; label?: string; agentName?: string };
  route?: CommunicateRoute;
  preState: Record<string, unknown>;
  postState: Record<string, unknown>;
  operationIds: {
    snapshot?: string;
    preState?: string;
    prompt?: string;
    keys?: string;
    postState?: string;
  };
  sender?: { paneId: string; display: string; source: SenderIdentity["source"] };
  envelope?: { version: "v1"; kind: "prompt" | "steer" };
}

export interface CommunicateDependencies {
  cli: HerdrCli;
  context: CurrentContext;
  preflight: CompatibilityPreflight;
}

const VALID_STATES = new Set<CommunicateState>(["idle", "working", "blocked", "done", "unknown"]);
export function compactPane(pane: Record<string, unknown>): Record<string, unknown> {
  return {
    pane_id: pane.pane_id,
    tab_id: pane.tab_id,
    workspace_id: pane.workspace_id,
    ...(typeof pane.label === "string" ? { label: pane.label.slice(0, 256) } : {}),
    ...(typeof pane.agent_id === "string" ? { agent_id: pane.agent_id.slice(0, 256) } : {}),
    ...(typeof pane.agent_name === "string" ? { agent_name: pane.agent_name.slice(0, 256) } : {}),
    agent_status: pane.agent_status
  };
}

export function paneFrom(value: unknown, expectedPaneId: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || typeof (value as { pane?: unknown }).pane !== "object" || (value as { pane?: unknown }).pane === null) {
    throw Object.assign(new Error("Invalid Herdr pane response"), { code: "CLI_PROTOCOL_ERROR" });
  }
  const pane = (value as { pane: Record<string, unknown> }).pane;
  if (!["pane_id", "tab_id", "workspace_id"].every((field) => typeof pane[field] === "string" && (pane[field] as string).length > 0)) {
    throw Object.assign(new Error("Herdr pane response is missing authoritative identifiers"), { code: "CLI_PROTOCOL_ERROR" });
  }
  if (pane.pane_id !== expectedPaneId) {
    throw Object.assign(new Error("Herdr pane response does not match the resolved target"), { code: "CLI_PROTOCOL_ERROR", details: { expectedPaneId, actualPaneId: pane.pane_id } });
  }
  return pane;
}

function stateOf(pane: Record<string, unknown>): CommunicateState {
  const state = pane.agent_status;
  if (typeof state !== "string" || !VALID_STATES.has(state as CommunicateState)) {
    throw Object.assign(new Error("Authoritative target state is unavailable"), { code: "TARGET_STATE_UNAVAILABLE", details: { target: pane.pane_id } });
  }
  return state as CommunicateState;
}

function assertSendableState(pane: Record<string, unknown>): CommunicateState {
  const state = stateOf(pane);
  if (state === "unknown") {
    throw Object.assign(new Error("Target state is unknown; no communication was sent"), { code: "TARGET_STATE_UNKNOWN", details: { target: pane.pane_id, state } });
  }
  return state;
}

function assertPostState(pane: Record<string, unknown>): CommunicateState {
  const state = stateOf(pane);
  if (state === "unknown") {
    throw Object.assign(new Error("Authoritative target post-state is unknown"), { code: "POSTSTATE_UNAVAILABLE", details: { postState: compactPane(pane) } });
  }
  return state;
}

function operationId(envelope: JsonEnvelope | undefined): string | undefined {
  return envelope?.id;
}

export function createCommunicateTool(deps: CommunicateDependencies): ToolDefinition<typeof CommunicateParamsSchema, CommunicateDetails> {
  return {
    name: "herdr_communicate",
    label: "Herdr Communicate",
    description: "Send a normal prompt, explicitly steer, or send validated named keys to an exact Herdr agent target.",
    executionMode: "sequential",
    parameters: CommunicateParamsSchema,
    async execute(_id, params: CommunicateParams, signal, _onUpdate, ctx) {
      const activeSignal = signal ?? ctx.signal ?? new AbortController().signal;
      if (params.operation === "keys" && params.keys.some((key) => !isNamedKey(key))) {
        throw Object.assign(new Error("Unsupported named key"), { code: "KEY_REJECTED" });
      }

      await deps.preflight(activeSignal);
      const snapshotEnvelope = await deps.cli.runJson(["api", "snapshot"], activeSignal);
      const snapshot = parseSnapshotResult(snapshotEnvelope.result);
      const sender = params.operation === "keys" ? undefined : resolveSender(snapshot, deps.context.paneId);
      if (sender && (params.target === "current" || params.target === sender.paneId)) {
        throw Object.assign(new Error("Communication cannot target the caller pane"), { code: "SELF_TARGET_REJECTED", details: { target: sender.paneId } });
      }
      const target = resolveTarget(snapshot, params.target, "agent", deps.context);
      if (sender && target.paneId === sender.paneId) {
        throw Object.assign(new Error("Communication cannot target the caller pane"), { code: "SELF_TARGET_REJECTED", details: { target: target.paneId } });
      }
      const preEnvelope = await deps.cli.runJson(["pane", "get", target.paneId!], activeSignal);
      const before = paneFrom(preEnvelope.result, target.paneId!);
      const beforeState = assertSendableState(before);
      if (params.operation === "prompt" && beforeState === "working") {
        throw Object.assign(new Error("Target is working; normal prompt refuses to interrupt"), { code: "TARGET_BUSY", details: { target: target.paneId, state: beforeState } });
      }

      let prompt: JsonEnvelope | undefined;
      let keys: JsonEnvelope | undefined;
      let route: CommunicateRoute | undefined;
      if (params.operation === "keys") {
        keys = await deps.cli.runJson(["agent", "send-keys", target.paneId!, ...params.keys], activeSignal);
      } else {
        route = params.operation === "steer" ? "steer_direct" : "prompt_direct";
        const envelope = buildEnvelope(sender!, params.operation, params.text);
        const promptArgs = params.operation === "steer" && beforeState === "working"
          ? ["agent", "prompt", target.paneId!, envelope]
          : ["agent", "prompt", target.paneId!, envelope, "--wait", "--until", "working", "--timeout", "5000"];
        prompt = await deps.cli.runJson(promptArgs, activeSignal);
      }

      const postEnvelope = await deps.cli.runJson(["pane", "get", target.paneId!], activeSignal);
      const after = paneFrom(postEnvelope.result, target.paneId!);
      const afterState = assertPostState(after);
      if (params.operation !== "keys" && afterState !== "working") {
        throw Object.assign(new Error("Target did not enter working state"), { code: "POSTSTATE_UNAVAILABLE", details: { target: target.paneId, postState: compactPane(after) } });
      }

      const details: CommunicateDetails = {
        operation: params.operation,
        outcome: "sent",
        target: { paneId: target.paneId, tabId: target.tabId, workspaceId: target.workspaceId, label: target.label, agentName: target.agentName },
        ...(route ? { route } : {}),
        preState: compactPane(before),
        postState: compactPane(after),
        operationIds: {
          snapshot: operationId(snapshotEnvelope),
          preState: operationId(preEnvelope),
          ...(prompt ? { prompt: operationId(prompt) } : {}),
          ...(keys ? { keys: operationId(keys) } : {}),
          postState: operationId(postEnvelope)
        },
        ...(params.operation !== "keys" ? {
          sender: { paneId: sender!.paneId, display: sender!.display, source: sender!.source },
          envelope: { version: "v1" as const, kind: params.operation }
        } : {})
      };
      return { content: [{ type: "text", text: formatResult({ operation: "communicate", outcome: "success", targetId: target.paneId, postState: { agent_status: afterState } }) }], details };
    },
    renderCall(args, theme) {
      return textComponent(formatCall("herdr_communicate", args.operation, args.target), theme, "accent");
    },
    renderResult(result, options, theme) {
      return renderResultComponent("communicate", result, options, theme, result.details?.target.paneId);
    }
  };
}
