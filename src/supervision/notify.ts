/**
 * Manager wake delivery. Report-only, best effort, never retried.
 *
 * A dropped wake is recovered by asking — `herdr_jobs get` returns the pending
 * unobserved events and marks exactly those observed — so nothing here resends,
 * escalates, or waits for an acknowledgement. Delivery failure must never affect
 * supervision state.
 */

import { boundedText } from "../job-registry.js";
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
