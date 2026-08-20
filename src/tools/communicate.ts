import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HerdrCli, JsonEnvelope } from "../cli.js";
import type { CompatibilityPreflight } from "../health.js";
import { withDeliveryFailureEvidence } from "../messages/failure.js";
import { assertDeliverySize, assertMessageText, type MessageDelivery } from "../messages/limits.js";
import type { AttachmentStore, PublishedAttachment } from "../messages/store.js";
import { verifyRecipient, type RecipientRegistry } from "../messages/recipients.js";
import { buildEnvelope, resolveSender, type SenderIdentity } from "../provenance.js";
import { CommunicateParamsSchema, isNamedKey, type CommunicateParams } from "../schemas.js";
import { parseSnapshotResult, resolveTarget, type CurrentContext } from "../targets.js";
import { formatCall, formatResult, renderResultComponent, textComponent } from "../tui.js";

export type CommunicateRoute = "prompt_direct" | "steer_direct";
export type CommunicateState = "idle" | "working" | "blocked" | "done" | "unknown";
export type CommunicatePhase = "validate" | "resolve_target" | "verify_recipient" | "pre_state" | "publish" | "send" | "post_state";

export interface CommunicateDetails {
  operation: "prompt" | "steer" | "keys";
  outcome: "sent";
  target: { paneId?: string; tabId?: string; workspaceId?: string; label?: string; agentName?: string };
  delivery?: MessageDelivery;
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
  envelope?: { version: "v1"; kind: "prompt" | "steer"; delivery: MessageDelivery };
  attachment?: { attachmentId: string; path: string; bytes: number; sha256: string; expiresAt: string; recipientPaneId?: string };
}

export interface CommunicateDependencies {
  cli: HerdrCli;
  context: CurrentContext;
  preflight: CompatibilityPreflight;
  attachments?: AttachmentStore;
  recipients?: RecipientRegistry;
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
      // Establish the route before any precondition so every refusal names it.
      const delivery: MessageDelivery | undefined = params.operation === "keys" ? undefined : (params.delivery === "attachment" ? "attachment" : "inline");
      let prompt: JsonEnvelope | undefined;
      let keys: JsonEnvelope | undefined;
      let route: CommunicateRoute | undefined;
      let published: PublishedAttachment | undefined;
      let phase: CommunicatePhase = "validate";
      let snapshotEnvelope: JsonEnvelope;
      let target: ReturnType<typeof resolveTarget>;
      let preEnvelope: JsonEnvelope;
      let before: Record<string, unknown>;
      let sender: SenderIdentity | undefined;
      let postEnvelope: JsonEnvelope;
      let after: Record<string, unknown>;
      let afterState: CommunicateState;
      try {
        if (params.operation === "keys") {
          if (Object.prototype.hasOwnProperty.call(params, "delivery")) throw Object.assign(new Error("delivery is only valid for prompt and steer"), { code: "INVALID_INPUT", details: { field: "delivery" } });
          if (params.keys.some((key) => !isNamedKey(key))) {
            throw Object.assign(new Error("Unsupported named key"), { code: "KEY_REJECTED" });
          }
        } else {
          assertMessageText(params.text);
          if (params.delivery !== undefined && params.delivery !== "inline" && params.delivery !== "attachment") throw Object.assign(new Error("delivery must be inline or attachment"), { code: "INVALID_INPUT", details: { field: "delivery" } });
          assertDeliverySize(params.text, delivery!);
        }

        phase = "resolve_target";
        await deps.preflight(activeSignal);
        snapshotEnvelope = await deps.cli.runJson(["api", "snapshot"], activeSignal);
        const snapshot = parseSnapshotResult(snapshotEnvelope.result);
        sender = params.operation === "keys" ? undefined : resolveSender(snapshot, deps.context.paneId);
        if (sender && (params.target === "current" || params.target === sender.paneId)) {
          throw Object.assign(new Error("Communication cannot target the caller pane"), { code: "SELF_TARGET_REJECTED", details: { target: sender.paneId } });
        }
        target = resolveTarget(snapshot, params.target, "agent", deps.context);
        if (sender && target.paneId === sender.paneId) {
          throw Object.assign(new Error("Communication cannot target the caller pane"), { code: "SELF_TARGET_REJECTED", details: { target: target.paneId } });
        }
        let recipientKey: string | undefined;
        let recipientAgentName: string | undefined;
        if (delivery === "attachment") {
          phase = "verify_recipient";
          if (!deps.attachments || !deps.recipients || !target.paneId) {
            throw Object.assign(new Error("Attachment target capability is unavailable"), { code: "ATTACHMENT_TARGET_UNVERIFIED", details: { target: target.paneId } });
          }
          const recipient = deps.recipients.get(target.paneId);
          const verification = verifyRecipient(snapshot, recipient);
          if (!verification.verified) {
            throw Object.assign(new Error("Attachment target capability is not verified"), { code: "ATTACHMENT_TARGET_UNVERIFIED", details: { target: target.paneId, reason: verification.reason } });
          }
          recipientKey = recipient!.recipientKey;
          recipientAgentName = verification.identity.agentName;
        }
        phase = "pre_state";
        preEnvelope = await deps.cli.runJson(["pane", "get", target.paneId!], activeSignal);
        before = paneFrom(preEnvelope.result, target.paneId!);
        const beforeState = assertSendableState(before);
        if (params.operation === "prompt" && beforeState === "working") {
          throw Object.assign(new Error("Target is working; normal prompt refuses to interrupt"), { code: "TARGET_BUSY", details: { target: target.paneId, state: beforeState } });
        }

        if (params.operation === "keys") {
          phase = "send";
          keys = await deps.cli.runJson(["agent", "send-keys", target.paneId!, ...params.keys], activeSignal);
        } else {
          route = params.operation === "steer" ? "steer_direct" : "prompt_direct";
          if (delivery === "attachment") {
            phase = "publish";
            published = await deps.attachments!.publish({
              body: params.text,
              recipientKey: recipientKey!,
              recipientPaneId: target.paneId,
              recipientAgentName,
              senderPaneId: sender!.paneId,
              senderDisplay: sender!.display,
              operation: params.operation
            });
          }
          const envelope = delivery === "attachment"
            ? buildEnvelope(sender!, params.operation, params.text, "attachment", { ...published!, encoding: "utf-8" })
            : buildEnvelope(sender!, params.operation, params.text, "inline");
          const promptArgs = params.operation === "steer" && beforeState === "working"
            ? ["agent", "prompt", target.paneId!, "--stdin"]
            : ["agent", "prompt", target.paneId!, "--stdin", "--wait", "--until", "working", "--timeout", "5000"];
          phase = "send";
          prompt = await deps.cli.runJsonWithStdin(promptArgs, envelope, activeSignal);
        }

        phase = "post_state";
        postEnvelope = await deps.cli.runJson(["pane", "get", target.paneId!], activeSignal);
        after = paneFrom(postEnvelope.result, target.paneId!);
        afterState = assertPostState(after);
        if (params.operation !== "keys" && afterState !== "working") {
          throw Object.assign(new Error("Target did not enter working state"), { code: "POSTSTATE_UNAVAILABLE", details: { target: target.paneId, postState: compactPane(after) } });
        }
      } catch (error) {
        throw withDeliveryFailureEvidence(error, { delivery, route, phase, published });
      }

      const details: CommunicateDetails = {
        operation: params.operation,
        outcome: "sent",
        target: { paneId: target.paneId, tabId: target.tabId, workspaceId: target.workspaceId, label: target.label, agentName: target.agentName },
        ...(delivery ? { delivery } : {}),
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
          envelope: { version: "v1" as const, kind: params.operation, delivery: delivery! },
          ...(published ? { attachment: published } : {})
        } : {})
      };
      return { content: [{ type: "text", text: formatResult({ operation: "communicate", outcome: "success", targetId: target.paneId, delivery, postState: { agent_status: afterState } }) }], details };
    },
    renderCall(args, theme) {
      const delivery = args.operation === "keys" ? undefined : args.delivery ?? "inline";
      return textComponent(formatCall("herdr_communicate", delivery ? `${args.operation} · ${delivery}` : args.operation, args.target), theme, "accent");
    },
    renderResult(result, options, theme) {
      return renderResultComponent("communicate", result, options, theme, result.details?.target.paneId);
    }
  };
}
