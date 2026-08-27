import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HerdrCli, JsonEnvelope } from "../cli.js";
import { contextRebindingDetails, createContextResolver, type ContextResolutionDiagnostics, type ContextResolver } from "../context.js";
import type { CompatibilityPreflight } from "../health.js";
import { withDeliveryFailureEvidence } from "../messages/failure.js";
import { assertDeliverySize, assertMessageText, type MessageDelivery } from "../messages/limits.js";
import { classifyPromptObservation, compactPromptSubmission, requirePromptTargetIdentity, parsePromptSubmission, PromptIdentityError, samePromptTargetIdentity, unavailablePromptObservation, type PromptObservation, type PromptSubmissionEvidence, type PromptTargetIdentity } from "../messages/prompt.js";
import type { AttachmentStore, PublishedAttachment } from "../messages/store.js";
import { verifyRecipient, type RecipientRegistry } from "../messages/recipients.js";
import { buildEnvelope, resolveSender, type SenderIdentity } from "../provenance.js";
import { CommunicateParamsSchema, isNamedKey, type CommunicateParams } from "../schemas.js";
import { resolveTarget, type CurrentContext, type HerdrSnapshot } from "../targets.js";
import { executeTurnControl, type TurnControlDetails } from "./turn-control.js";
import { formatCall, formatResult, renderResultComponent, textComponent } from "../tui.js";

export type CommunicateRoute = "prompt_direct" | "steer_direct";
export type CommunicateState = "idle" | "working" | "blocked" | "done" | "unknown";
export type CommunicatePhase = "validate" | "resolve_target" | "verify_recipient" | "pre_state" | "publish" | "send" | "post_state";

export interface LegacyCommunicateDetails {
  operation: "prompt" | "steer" | "keys";
  outcome: "sent";
  target: { paneId?: string; tabId?: string; workspaceId?: string; label?: string; agentName?: string };
  delivery?: MessageDelivery;
  route?: CommunicateRoute;
  preState: Record<string, unknown>;
  postState?: Record<string, unknown>;
  submission?: PromptSubmissionEvidence;
  observation?: PromptObservation;
  operationIds: {
    snapshot?: string;
    agentGet?: string;
    preState?: string;
    prompt?: string;
    keys?: string;
    postAgentGet?: string;
    postState?: string;
  };
  sender?: { paneId: string; display: string; source: SenderIdentity["source"] };
  envelope?: { version: "v1"; kind: "prompt" | "steer"; delivery: MessageDelivery };
  contextRebinding?: ContextResolutionDiagnostics;
  attachment?: { attachmentId: string; path: string; bytes: number; sha256: string; expiresAt: string; recipientPaneId?: string };
}

export type CommunicateDetails = LegacyCommunicateDetails | TurnControlDetails;

export interface CommunicateDependencies {
  cli: HerdrCli;
  context: CurrentContext;
  contextResolver?: ContextResolver;
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
    ...(typeof pane.terminal_id === "string" ? { terminal_id: pane.terminal_id.slice(0, 256) } : {}),
    ...(typeof pane.agent_session === "object" && pane.agent_session !== null && !Array.isArray(pane.agent_session)
      && typeof (pane.agent_session as Record<string, unknown>).source === "string"
      && typeof (pane.agent_session as Record<string, unknown>).agent === "string"
      && typeof (pane.agent_session as Record<string, unknown>).kind === "string"
      && typeof (pane.agent_session as Record<string, unknown>).value === "string"
      ? { agent_session: {
        source: ((pane.agent_session as Record<string, unknown>).source as string).slice(0, 256),
        agent: ((pane.agent_session as Record<string, unknown>).agent as string).slice(0, 256),
        kind: ((pane.agent_session as Record<string, unknown>).kind as string).slice(0, 256),
        value: ((pane.agent_session as Record<string, unknown>).value as string).slice(0, 256)
      } } : {}),
    agent_status: pane.agent_status,
    ...(typeof pane.revision === "number" && Number.isSafeInteger(pane.revision) && pane.revision >= 0 ? { revision: pane.revision } : {})
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

function agentFrom(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || typeof (value as { agent?: unknown }).agent !== "object" || (value as { agent?: unknown }).agent === null || Array.isArray((value as { agent?: unknown }).agent)) {
    throw new PromptIdentityError("TARGET_IDENTITY_UNAVAILABLE", "Fresh Herdr agent identity is unavailable");
  }
  return (value as { agent: Record<string, unknown> }).agent;
}

function snapshotIdentityRecords(snapshot: HerdrSnapshot, paneId: string): Record<string, unknown>[] {
  const panes = snapshot.panes.filter((pane) => pane.pane_id === paneId);
  const agents = snapshot.agents.filter((agent) => agent.pane_id === paneId);
  if (panes.length !== 1 || agents.length !== 1) {
    throw new PromptIdentityError("TARGET_IDENTITY_UNAVAILABLE", "Fresh snapshot does not contain one authoritative target agent", { paneId, paneRecords: panes.length, agentRecords: agents.length });
  }
  return [panes[0]!, agents[0]!];
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
  const contextResolver = deps.contextResolver ?? createContextResolver(deps.cli, deps.context);
  return {
    name: "herdr_communicate",
    label: "Herdr Communicate",
    description: "Send a normal prompt, explicitly steer, send validated named keys, or perform strict cancel/interrupt turn control on an exact Herdr agent target.",
    executionMode: "sequential",
    parameters: CommunicateParamsSchema,
    async execute(_id, params: CommunicateParams, signal, _onUpdate, ctx) {
      const activeSignal = signal ?? ctx.signal ?? new AbortController().signal;
      if (params.operation === "cancel" || params.operation === "interrupt") {
        return executeTurnControl(params, { cli: deps.cli, context: deps.context, contextResolver, preflight: deps.preflight }, activeSignal);
      }
      // Establish the route before any precondition so every refusal names it.
      const legacyParams = params as Exclude<CommunicateParams, { operation: "cancel" | "interrupt" }>;
      const delivery: MessageDelivery | undefined = legacyParams.operation === "keys" ? undefined : (legacyParams.delivery === "attachment" ? "attachment" : "inline");
      let prompt: JsonEnvelope | undefined;
      let keys: JsonEnvelope | undefined;
      let route: CommunicateRoute | undefined;
      let published: PublishedAttachment | undefined;
      let phase: CommunicatePhase = "validate";
      let snapshotOperationId: string | undefined;
      let target: ReturnType<typeof resolveTarget>;
      let preAgentEnvelope: JsonEnvelope | undefined;
      let preEnvelope: JsonEnvelope;
      let before: Record<string, unknown>;
      let sender: SenderIdentity | undefined;
      let promptIdentity: PromptTargetIdentity | undefined;
      let postAgentEnvelope: JsonEnvelope | undefined;
      let postEnvelope: JsonEnvelope | undefined;
      let after: Record<string, unknown> | undefined;
      let afterState: CommunicateState | undefined;
      let submission: PromptSubmissionEvidence | undefined;
      let observation: PromptObservation | undefined;
      let contextDiagnostics: ContextResolutionDiagnostics | undefined;
      try {
        if (legacyParams.operation === "keys") {
          if (Object.prototype.hasOwnProperty.call(legacyParams, "delivery")) throw Object.assign(new Error("delivery is only valid for prompt and steer"), { code: "INVALID_INPUT", details: { field: "delivery" } });
          if (legacyParams.keys.some((key) => !isNamedKey(key))) {
            throw Object.assign(new Error("Unsupported named key"), { code: "KEY_REJECTED" });
          }
        } else {
          assertMessageText(legacyParams.text);
          if (legacyParams.delivery !== undefined && legacyParams.delivery !== "inline" && legacyParams.delivery !== "attachment") throw Object.assign(new Error("delivery must be inline or attachment"), { code: "INVALID_INPUT", details: { field: "delivery" } });
          assertDeliverySize(legacyParams.text, delivery!);
        }

        phase = "resolve_target";
        await deps.preflight(activeSignal);
        const effective = await contextResolver(activeSignal);
        contextDiagnostics = effective.diagnostics;
        snapshotOperationId = effective.operationIds.snapshot;
        const snapshot = effective.snapshot;
        sender = legacyParams.operation === "keys" ? undefined : resolveSender(snapshot, effective.context.paneId);
        if (sender && (legacyParams.target === "current" || legacyParams.target === sender.paneId)) {
          throw Object.assign(new Error("Communication cannot target the caller pane"), { code: "SELF_TARGET_REJECTED", details: { target: sender.paneId } });
        }
        target = resolveTarget(snapshot, legacyParams.target, "agent", effective.context);
        if (sender && target.paneId === sender.paneId) {
          throw Object.assign(new Error("Communication cannot target the caller pane"), { code: "SELF_TARGET_REJECTED", details: { target: target.paneId } });
        }
        let recipientKey: string | undefined;
        let recipientAgentName: string | undefined;
        let recipientRecord: ReturnType<RecipientRegistry["get"]>;
        if (delivery === "attachment") {
          phase = "verify_recipient";
          if (!deps.attachments || !deps.recipients || !target.paneId) {
            throw Object.assign(new Error("Attachment target capability is unavailable"), { code: "ATTACHMENT_TARGET_UNVERIFIED", details: { target: target.paneId } });
          }
          recipientRecord = deps.recipients.get(target.paneId);
          const verification = verifyRecipient(snapshot, recipientRecord);
          if (!verification.verified) {
            throw Object.assign(new Error("Attachment target capability is not verified"), { code: "ATTACHMENT_TARGET_UNVERIFIED", details: { target: target.paneId, reason: verification.reason } });
          }
          recipientKey = recipientRecord!.recipientKey;
          recipientAgentName = verification.identity.agentName;
        }
        phase = "pre_state";
        if (params.operation !== "keys") {
          preAgentEnvelope = await deps.cli.runJson(["agent", "get", target.paneId!], activeSignal);
        }
        preEnvelope = await deps.cli.runJson(["pane", "get", target.paneId!], activeSignal);
        before = paneFrom(preEnvelope.result, target.paneId!);
        const beforeState = assertSendableState(before);
        if (legacyParams.operation === "prompt" && beforeState === "working") {
          throw Object.assign(new Error("Target is working; normal prompt refuses to interrupt"), { code: "TARGET_BUSY", details: { target: target.paneId, state: beforeState } });
        }
        if (params.operation !== "keys") {
          promptIdentity = requirePromptTargetIdentity([
            ...snapshotIdentityRecords(snapshot, target.paneId!),
            agentFrom(preAgentEnvelope!.result),
            before
          ], target.paneId!);
        }

        if (legacyParams.operation === "keys") {
          phase = "send";
          keys = await deps.cli.runJson(["agent", "send-keys", target.paneId!, ...legacyParams.keys], activeSignal);
        } else {
          route = legacyParams.operation === "steer" ? "steer_direct" : "prompt_direct";
          if (delivery === "attachment") {
            phase = "publish";
            published = await deps.attachments!.publish({
              body: legacyParams.text,
              recipientKey: recipientKey!,
              recipientPaneId: target.paneId,
              recipientAgentName,
              senderPaneId: sender!.paneId,
              senderDisplay: sender!.display,
              operation: legacyParams.operation
            });
          }
          const envelope = delivery === "attachment"
            ? buildEnvelope(sender!, legacyParams.operation, legacyParams.text, "attachment", { ...published!, encoding: "utf-8" })
            : buildEnvelope(sender!, legacyParams.operation, legacyParams.text, "inline");
          const promptArgs = ["agent", "prompt", target.paneId!, "--stdin"];
          phase = "send";
          // The stdin command is a completed mutation once its response arrives.
          // Preserve that response if the caller aborts in the same turn; only
          // the later observation is optional after acknowledgement parsing.
          prompt = await deps.cli.runJsonWithStdin(promptArgs, envelope, activeSignal, true);
          submission = parsePromptSubmission(prompt, promptIdentity!);
        }

        phase = "post_state";
        try {
          if (submission) {
            postAgentEnvelope = await deps.cli.runJson(["agent", "get", target.paneId!], activeSignal);
            postEnvelope = await deps.cli.runJson(["pane", "get", target.paneId!], activeSignal);
            const candidate = paneFrom(postEnvelope.result, target.paneId!);
            const postEvidence = [agentFrom(postAgentEnvelope.result), candidate];
            observation = classifyPromptObservation(postEvidence[0]!, submission, undefined, [postEvidence[1]!]);
            let identityMatches = false;
            try {
              const postIdentity = requirePromptTargetIdentity(postEvidence, target.paneId!);
              identityMatches = samePromptTargetIdentity(postIdentity, submission);
            } catch {
              identityMatches = false;
            }
            // A pane can be reused by a same-name replacement after the prompt
            // acknowledgement. Never retain or render that process as the target.
            if (identityMatches) {
              after = candidate;
              try {
                afterState = stateOf(candidate);
              } catch {
                afterState = undefined;
              }
            } else {
              after = undefined;
              afterState = undefined;
            }
          } else {
            postEnvelope = await deps.cli.runJson(["pane", "get", target.paneId!], activeSignal);
            after = paneFrom(postEnvelope.result, target.paneId!);
            afterState = assertPostState(after);
          }
        } catch (error) {
          if (!submission) throw error;
          // The typed prompt response is the atomic submission acknowledgement. A
          // later identity/state read can be stale or unavailable without changing
          // that fact; an abort after acknowledgement applies only to observation.
          after = undefined;
          afterState = undefined;
          observation = unavailablePromptObservation(error);
        }
      } catch (error) {
        throw withDeliveryFailureEvidence(error, { delivery, route, phase, published });
      }

      const details: CommunicateDetails = {
        operation: legacyParams.operation,
        outcome: "sent",
        target: { paneId: target.paneId, tabId: target.tabId, workspaceId: target.workspaceId, label: target.label, agentName: target.agentName },
        ...contextRebindingDetails(contextDiagnostics!),
        ...(delivery ? { delivery } : {}),
        ...(route ? { route } : {}),
        preState: compactPane(before),
        ...(after ? { postState: compactPane(after) } : {}),
        ...(submission ? { submission: compactPromptSubmission(submission) } : {}),
        ...(observation ? { observation } : {}),
        operationIds: {
          snapshot: snapshotOperationId!,
          ...(preAgentEnvelope ? { agentGet: operationId(preAgentEnvelope) } : {}),
          preState: operationId(preEnvelope),
          ...(prompt ? { prompt: operationId(prompt) } : {}),
          ...(keys ? { keys: operationId(keys) } : {}),
          ...(postAgentEnvelope ? { postAgentGet: operationId(postAgentEnvelope) } : {}),
          ...(postEnvelope ? { postState: operationId(postEnvelope) } : {})
        },
        ...(legacyParams.operation !== "keys" ? {
          sender: { paneId: sender!.paneId, display: sender!.display, source: sender!.source },
          envelope: { version: "v1" as const, kind: legacyParams.operation, delivery: delivery! },
          ...(published ? { attachment: published } : {})
        } : {})
      };
      return { content: [{ type: "text", text: formatResult({ operation: "communicate", outcome: "success", targetId: target.paneId, delivery, ...(afterState === undefined ? {} : { postState: { agent_status: afterState } }) }) }], details };
    },
    renderCall(args, theme) {
      const delivery = args.operation === "keys" || args.operation === "cancel" || args.operation === "interrupt" ? undefined : args.delivery ?? "inline";
      return textComponent(formatCall("herdr_communicate", delivery ? `${args.operation} · ${delivery}` : args.operation, args.target), theme, "accent");
    },
    renderResult(result, options, theme) {
      return renderResultComponent("communicate", result, options, theme, result.details?.target.paneId);
    }
  };
}
