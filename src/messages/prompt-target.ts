/**
 * The prompt-target record helpers shared by `herdr_communicate` and the MCP
 * host wake path. The identity sandwich belongs to the identity layer, not the
 * tool layer: supervision proves the same pane+agent+snapshot+get records the
 * tool does without importing tool internals.
 */

import { PromptIdentityError } from "./prompt.js";
import type { HerdrSnapshot } from "../targets.js";

export type CommunicateState = "idle" | "working" | "blocked" | "done" | "unknown";

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

export function agentFrom(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || typeof (value as { agent?: unknown }).agent !== "object" || (value as { agent?: unknown }).agent === null || Array.isArray((value as { agent?: unknown }).agent)) {
    throw new PromptIdentityError("TARGET_IDENTITY_UNAVAILABLE", "Fresh Herdr agent identity is unavailable");
  }
  return (value as { agent: Record<string, unknown> }).agent;
}

export function snapshotIdentityRecords(snapshot: HerdrSnapshot, paneId: string): Record<string, unknown>[] {
  const panes = snapshot.panes.filter((pane) => pane.pane_id === paneId);
  const agents = snapshot.agents.filter((agent) => agent.pane_id === paneId);
  if (panes.length !== 1 || agents.length !== 1) {
    throw new PromptIdentityError("TARGET_IDENTITY_UNAVAILABLE", "Fresh snapshot does not contain one authoritative target agent", { paneId, paneRecords: panes.length, agentRecords: agents.length });
  }
  return [panes[0]!, agents[0]!];
}

export function stateOf(pane: Record<string, unknown>): CommunicateState {
  const state = pane.agent_status;
  if (typeof state !== "string" || !VALID_STATES.has(state as CommunicateState)) {
    throw Object.assign(new Error("Authoritative target state is unavailable"), { code: "TARGET_STATE_UNAVAILABLE", details: { target: pane.pane_id } });
  }
  return state as CommunicateState;
}

export function assertSendableState(pane: Record<string, unknown>): CommunicateState {
  const state = stateOf(pane);
  if (state === "unknown") {
    throw Object.assign(new Error("Target state is unknown; no communication was sent"), { code: "TARGET_STATE_UNKNOWN", details: { target: pane.pane_id, state } });
  }
  return state;
}
