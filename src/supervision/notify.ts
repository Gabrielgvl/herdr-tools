/**
 * Manager wake delivery. Report-only, best effort, never retried.
 *
 * A dropped wake is recovered by asking — `herdr_jobs get` returns the pending
 * unobserved events and marks exactly those observed — so nothing here resends,
 * escalates, or waits for an acknowledgement. Delivery failure must never affect
 * supervision state.
 */

import { boundedText, type JobDetail } from "../job-registry.js";
import { notificationForJob } from "../job-notification.js";
import { resolveEffectiveContext } from "../context.js";
import type { JsonEnvelope } from "../cli.js";
import { agentFrom, assertQualifiedPromptTarget, assertSendableState, paneFrom, snapshotIdentityRecords } from "../messages/prompt-target.js";
import { parsePromptSubmission, parsePromptTargetIdentityFields, requirePromptTargetIdentity } from "../messages/prompt.js";
import { buildEnvelope, resolveSender, type ProvenanceKind } from "../provenance.js";
import type { CurrentContext } from "../targets.js";
import type { SupervisionEvent } from "./events.js";

export const SUPERVISION_WAKE_CONTENT_BYTES = 4_000;
export const SUPERVISION_WAKE_FIELD_BYTES = 256;
/** The Claude Code Channels research-preview notification method. */
export const CLAUDE_CHANNEL_NOTIFICATION_METHOD = "notifications/claude/channel";
/** The experimental capability key a Channels-capable MCP server advertises. */
export const CLAUDE_CHANNEL_CAPABILITY = "claude/channel";

export interface SupervisionChildRef {
  agentName: string;
  agentKind: string;
  paneId: string;
}

export interface SupervisionWake {
  jobId: string;
  child: SupervisionChildRef;
  event: SupervisionEvent;
}

export interface ManagerNotifier {
  wake(wake: SupervisionWake): void;
}

function field(value: string): string {
  return boundedText(value, SUPERVISION_WAKE_FIELD_BYTES);
}

export function supervisionWakeContent(wake: SupervisionWake): string {
  const prefix = wake.event.priority === "high" ? "HIGH PRIORITY: " : "";
  return boundedText(
    `${prefix}Herdr supervisor ${field(wake.jobId)} for child ${field(wake.child.agentName)} (${field(wake.child.paneId)}, ${field(wake.child.agentKind)}) reported ${field(wake.event.type)}: ${field(wake.event.summary)}. Read the full event with herdr_jobs get on this job id; returned events are marked observed.`,
    SUPERVISION_WAKE_CONTENT_BYTES,
  );
}

export function supervisionWakeMeta(wake: SupervisionWake): Record<string, unknown> {
  return {
    jobId: field(wake.jobId),
    kind: "supervisor",
    eventId: field(wake.event.eventId),
    eventType: wake.event.type,
    priority: wake.event.priority,
    atMs: wake.event.atMs,
    agentName: field(wake.child.agentName),
    agentKind: field(wake.child.agentKind),
    paneId: field(wake.child.paneId),
    ...(wake.event.details === undefined ? {} : { details: wake.event.details }),
  };
}

export type PiSendMessage = (
  message: { customType: string; content: string; display: boolean; details: Record<string, unknown> },
  options: { deliverAs: "steer"; triggerTurn: true },
) => unknown;

/** The Pi host's existing custom-context wake path. */
export function createPiSupervisionNotifier(sendMessage: PiSendMessage): ManagerNotifier {
  return {
    wake(wake) {
      try {
        void Promise.resolve(sendMessage(
          { customType: "herdr-supervision", content: supervisionWakeContent(wake), display: true, details: supervisionWakeMeta(wake) },
          { deliverAs: "steer", triggerTurn: true },
        )).catch(() => undefined);
      } catch {
        // Pi may be shutting down; the wake is explicitly best effort.
      }
    },
  };
}

export type ChannelNotify = (notification: { method: string; params: { content: string; meta: Record<string, unknown> } }) => unknown;

/**
 * The Claude Code Channels research-preview wake, sent from the same MCP server
 * that serves the tools. There is no delivery acknowledgement by design, and no
 * Herdr agent prompt is injected anywhere.
 */
export function createChannelSupervisionNotifier(notify: ChannelNotify): ManagerNotifier {
  return {
    wake(wake) {
      try {
        void Promise.resolve(notify({
          method: CLAUDE_CHANNEL_NOTIFICATION_METHOD,
          params: { content: supervisionWakeContent(wake), meta: supervisionWakeMeta(wake) },
        })).catch(() => undefined);
      } catch {
        // The client may have disconnected; the wake is explicitly best effort.
      }
    },
  };
}

/** A notifier for a host with no wake channel at all. Supervision still records everything. */
export const inertNotifier: ManagerNotifier = { wake: () => undefined };

/** The narrow CLI surface the MCP host wake router needs — `HerdrCli` satisfies it. */
export interface McpWakeCli {
  runJson(argv: string[], signal: AbortSignal): Promise<JsonEnvelope>;
  prompt(target: string, text: string, signal: AbortSignal): Promise<JsonEnvelope>;
}

export interface McpHostWakeDeps {
  cli: McpWakeCli;
  context: CurrentContext;
  notifyChannel: ChannelNotify;
}

/**
 * The MCP host's one wake surface. The supervisor path feeds `notifier`; the
 * job registry's `onTerminal` feeds `notifyJobTerminal`. Both converge on a
 * single `deliver` that routes by the hosting pane's lazily resolved agent
 * kind, so every wake stays best effort: a failure is a drop, never a retry,
 * and `herdr_jobs get` remains the recovery contract.
 */
export interface McpHostWake {
  readonly notifier: ManagerNotifier;
  notifyJobTerminal(detail: JobDetail): void;
}

/**
 * Kinds whose own pane is proven to render an `agent.prompt` write as a turn.
 * This is an explicit allowlist, not "everything except claude/agy": an unknown
 * future kind stays inert until its TUI proves it consumes typed input.
 */
const PROMPT_WAKE_KINDS = new Set(["devin", "pi"]);
const WAKE_PIPELINE_TIMEOUT_MS = 15_000;

export function createMcpHostWake(deps: McpHostWakeDeps): McpHostWake {
  const ownPaneId = deps.context.paneId;
  // Resolved lazily on the first delivery, never at construction: startup stays
  // side-effect-free. One shared in-flight promise means a burst of wakes pays
  // exactly one `pane get`; a rejected read is not cached, so the next wake
  // retries, while a resolved kind — including "no usable kind" — is permanent
  // for the session.
  let kindPromise: Promise<string | undefined> | undefined;
  const resolveKind = (signal: AbortSignal): Promise<string | undefined> => {
    if (ownPaneId === undefined) return Promise.resolve(undefined);
    if (kindPromise === undefined) {
      const pending = deps.cli
        .runJson(["pane", "get", ownPaneId], signal)
        .then((envelope) => parsePromptTargetIdentityFields(paneFrom(envelope.result, ownPaneId), ownPaneId).agentKind);
      kindPromise = pending;
      void pending.catch(() => {
        // Only a settled rejection clears the slot; it runs before any later
        // wake can install a replacement, so clearing unconditionally is safe.
        kindPromise = undefined;
      });
    }
    return kindPromise;
  };

  const pipeline = async (content: string, meta: Record<string, unknown>, kind: ProvenanceKind): Promise<void> => {
    const signal = AbortSignal.timeout(WAKE_PIPELINE_TIMEOUT_MS);
    const resolved = await resolveKind(signal);
    if (resolved === "claude") {
      // Channels-only for Claude (owner decision): even though targeted prompt
      // delivery to Claude panes is qualified for tool calls, a self-wake is
      // the server prompting its own hosting pane — a deliberately different
      // boundary. The send itself is unproven and ack-free, exactly like the
      // standalone notifier, and `herdr_jobs` polling stays the contract.
      await Promise.resolve(deps.notifyChannel({ method: CLAUDE_CHANNEL_NOTIFICATION_METHOD, params: { content, meta } }));
      return;
    }
    if (resolved === undefined || !PROMPT_WAKE_KINDS.has(resolved)) return;

    // Self-prompt: the target is the server's own hosting pane. The
    // communicate tool's SELF_TARGET_REJECTED policy does not apply here —
    // that rule protects an agent from prompting itself *as a tool call*; the
    // socket has no self-target rule, and this wake is the delivery mechanism,
    // not a user message.
    const effective = await resolveEffectiveContext(deps.cli, deps.context, signal);
    const paneId = effective.context.paneId;
    const agentEnvelope = await deps.cli.runJson(["agent", "get", paneId], signal);
    const paneEnvelope = await deps.cli.runJson(["pane", "get", paneId], signal);
    const pane = paneFrom(paneEnvelope.result, paneId);
    const records = [
      ...snapshotIdentityRecords(effective.snapshot, paneId),
      agentFrom(agentEnvelope.result),
      pane
    ];
    const identity = requirePromptTargetIdentity(records, paneId);
    // Defense in depth: the freshly proven identity must agree with the kind
    // that routed this wake and must itself be prompt-capable.
    if (!PROMPT_WAKE_KINDS.has(identity.agentKind) || identity.agentKind !== resolved) return;
    assertQualifiedPromptTarget(records, paneId);
    // Sendable-state gate only (owner decision): `working` and `blocked` still
    // send — the identical `agent.prompt` write the communicate "steer" route
    // makes without a busy gate — while `unknown` or unproven state drops. A
    // socket-level `agent_blocked` refusal lands as an ordinary drop.
    assertSendableState(pane);
    const envelope = buildEnvelope(resolveSender(effective.snapshot, paneId), kind, content, "inline");
    parsePromptSubmission(await deps.cli.prompt(paneId, envelope, signal), identity);
  };

  const deliver = (content: string, meta: Record<string, unknown>, kind: ProvenanceKind): void => {
    void pipeline(content, meta, kind).catch(() => undefined);
  };

  return {
    notifier: {
      wake(wake) {
        try {
          deliver(supervisionWakeContent(wake), supervisionWakeMeta(wake), "supervision");
        } catch {
          // A wake that cannot even be rendered is dropped; never surfaced.
        }
      },
    },
    notifyJobTerminal(detail) {
      // Mirrors the Pi host guard: only wait-kind settlements notify here;
      // supervisor settlements already arrive as supervision events.
      if (detail.kind !== "wait") return;
      try {
        const notification = notificationForJob(detail);
        deliver(notification.content, notification.details, "wait");
      } catch {
        // Best effort: a notification that cannot be rendered is dropped.
      }
    },
  };
}
