import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HerdrCli, JsonEnvelope } from "../cli.js";
import type { PromptDispatchEvidence } from "../agent-prompt.js";
import { contextRebindingDetails, createContextResolver, type ContextResolutionDiagnostics, type ContextResolver } from "../context.js";
import type { CompatibilityPreflight } from "../health.js";
import { queueFlushEligible, type DevinQueueFlush } from "../messages/devin-queue-flush.js";
import { withDeliveryFailureEvidence } from "../messages/failure.js";
import { assertDeliverySize, assertMessageText, type MessageDelivery } from "../messages/limits.js";
import { classifyPromptObservation, compactPromptSubmission, requirePromptTargetIdentity, parsePromptSubmission, samePromptTargetIdentity, unavailablePromptObservation, type PromptObservation, type PromptSubmissionEvidence, type PromptTargetIdentity } from "../messages/prompt.js";
import { agentFrom, assertQualifiedPromptTarget, assertSendableState, compactPane, paneFrom, snapshotIdentityRecords, stateOf, type CommunicateState } from "../messages/prompt-target.js";
import type { AttachmentStore, PublishedAttachment } from "../messages/store.js";
import { verifyRecipient, type RecipientRegistry } from "../messages/recipients.js";
import { buildEnvelope, resolveSender, type SenderIdentity } from "../provenance.js";
import { CommunicateParamsSchema, isNamedKey, type CommunicateParams } from "../schemas.js";
import { resolveTarget, type CurrentContext } from "../targets.js";
import { executeTurnControl, type TurnControlDetails } from "./turn-control.js";
import { formatCall, formatResult, renderResultComponent, textComponent } from "../tui.js";

export type CommunicateRoute = "prompt_direct" | "steer_direct";
export type { CommunicateState };
export { compactPane, paneFrom };
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
  promptDispatch?: PromptDispatchEvidence;
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
  /**
   * The host's shared Devin queue-flush coordinator. A Devin-kind send rides
   * its short write section and an acknowledged busy write schedules the
   * bounded flush; when absent, sends proceed without either.
   */
  queueFlush?: DevinQueueFlush;
}

function assertPromptState(pane: Record<string, unknown>, state: CommunicateState): void {
  if (state === "working") {
    throw Object.assign(new Error("Target is working; normal prompt refuses to interrupt"), { code: "TARGET_BUSY", details: { target: pane.pane_id, state } });
  }
  if (state === "blocked") {
    throw Object.assign(new Error("Target is blocked; normal prompt refuses delivery"), { code: "TARGET_BLOCKED", details: { target: pane.pane_id, state } });
  }
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
      const route: CommunicateRoute | undefined = legacyParams.operation === "keys" ? undefined : (legacyParams.operation === "steer" ? "steer_direct" : "prompt_direct");
      let prompt: JsonEnvelope | undefined;
      let keys: JsonEnvelope | undefined;
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
      let promptDispatch: PromptDispatchEvidence | undefined;
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
        if (legacyParams.operation === "keys") await deps.preflight(activeSignal);
        else await deps.preflight(activeSignal, "agent.prompt");
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
        if (legacyParams.operation !== "keys") {
          assertQualifiedPromptTarget([
            ...snapshot.panes.filter((pane) => pane.pane_id === target.paneId),
            ...snapshot.agents.filter((agent) => agent.pane_id === target.paneId)
          ], target.paneId!);
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
        if (legacyParams.operation === "prompt") assertPromptState(before, beforeState);
        if (params.operation !== "keys") {
          const preIdentityRecords = [
            ...snapshotIdentityRecords(snapshot, target.paneId!),
            agentFrom(preAgentEnvelope!.result),
            before
          ];
          assertQualifiedPromptTarget(preIdentityRecords, target.paneId!);
          promptIdentity = requirePromptTargetIdentity(preIdentityRecords, target.paneId!);
        }

        if (legacyParams.operation === "keys") {
          phase = "send";
          keys = await deps.cli.runJson(["agent", "send-keys", target.paneId!, ...legacyParams.keys], activeSignal);
        } else {
          const verifyFreshPromptTarget = async (): Promise<{ identity: PromptTargetIdentity; state: CommunicateState }> => {
            phase = "pre_state";
            const finalAgentEnvelope = await deps.cli.runJson(["agent", "get", target.paneId!], activeSignal);
            const finalEnvelope = await deps.cli.runJson(["pane", "get", target.paneId!], activeSignal);
            const finalPane = paneFrom(finalEnvelope.result, target.paneId!);
            const finalState = assertSendableState(finalPane);
            if (legacyParams.operation === "prompt") assertPromptState(finalPane, finalState);
            const finalIdentityRecords = [
              ...snapshotIdentityRecords(snapshot, target.paneId!),
              agentFrom(finalAgentEnvelope.result),
              finalPane
            ];
            assertQualifiedPromptTarget(finalIdentityRecords, target.paneId!);
            const identity = requirePromptTargetIdentity(finalIdentityRecords, target.paneId!);
            return { identity, state: finalState };
          };
          // Check the fresh occupant before attachment publication as well as
          // immediately before the prompt. This keeps an AGY replacement from
          // receiving a published body while still retaining any race evidence.
          if (delivery === "attachment") {
            promptIdentity = (await verifyFreshPromptTarget()).identity;
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
          phase = "send";
          let sentState: CommunicateState | undefined;
          const sendPrompt = async (): Promise<void> => {
            const fresh = await verifyFreshPromptTarget();
            promptIdentity = fresh.identity;
            sentState = fresh.state;
            phase = "send";
            const envelope = delivery === "attachment"
              ? buildEnvelope(sender!, legacyParams.operation, legacyParams.text, "attachment", { ...published!, encoding: "utf-8" })
              : buildEnvelope(sender!, legacyParams.operation, legacyParams.text, "inline");
            prompt = await deps.cli.prompt(target.paneId!, envelope, activeSignal);
            const requestId = prompt.id;
            try {
              submission = parsePromptSubmission(prompt, promptIdentity);
            } catch (error) {
              promptDispatch = { state: "unknown", requestId };
              throw error;
            }
            promptDispatch = { state: "acknowledged", requestId };
          };
          // For a Devin target the final verify+write is the shared locked
          // section: a flush's proof/Enter in another host can never interleave
          // between the check and the bracketed-paste submission. The kind comes
          // from the latest verified identity — a replacement swapping kinds
          // between reads degrades to an unlocked write, never a wrong one.
          if (promptIdentity!.agentKind === "devin" && deps.queueFlush !== undefined) {
            const lease = await deps.queueFlush.writeSection(target.paneId!);
            try {
              await sendPrompt();
            } finally {
              await lease.release();
            }
          } else {
            await sendPrompt();
          }
          // The last verified pre-send state — never the post-send observation —
          // decides whether this acknowledged write needs a queue flush.
          if (submission !== undefined && sentState !== undefined && queueFlushEligible(submission, sentState)) {
            deps.queueFlush?.schedule({ submission, sentState });
          }
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
        throw withDeliveryFailureEvidence(error, { delivery, route, phase, published, promptDispatch });
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
        ...(promptDispatch ? { promptDispatch } : {}),
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
