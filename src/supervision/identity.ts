/**
 * The exact-child identity supervision pins, and the continuity rules that
 * decide whether an observation still describes that child.
 *
 * A pane ID alone is never identity: Herdr reuses pane IDs, so a replayed
 * `pane_closed` for a recycled ID would otherwise settle a live supervisor.
 * The occupant is pinned by `terminal_id` plus the full four-part
 * `agent_session`, with the agent name and kind checked wherever a record
 * supplies them.
 */

import type { AgentSessionRecord, SupervisionAgentStatus, SupervisionPaneRecord } from "./protocol.js";

export interface SupervisedIdentity {
  paneId: string;
  terminalId: string;
  agentName: string;
  agentKind: string;
  agentSession: AgentSessionRecord;
}

export interface SupervisionAnchor {
  /** Pane revision at bind. Events below it are historical replay. */
  revision: number;
  stateChangeSeq: number;
  status: SupervisionAgentStatus;
}

/**
 * - `continuous` — the record proves this is still the bound occupant.
 * - `unproven` — nothing contradicts the binding, but the record does not carry
 *   the session evidence needed to prove it. Authoritative reconciliation decides.
 * - `replaced` — a supplied field contradicts the binding.
 */
export type ContinuityVerdict = "continuous" | "unproven" | "replaced";

function sameSession(left: AgentSessionRecord, right: AgentSessionRecord): boolean {
  return left.source === right.source && left.agent === right.agent && left.kind === right.kind && left.value === right.value;
}

export function sameSupervisedIdentity(left: SupervisedIdentity, right: SupervisedIdentity): boolean {
  return left.paneId === right.paneId
    && left.terminalId === right.terminalId
    && left.agentName === right.agentName
    && left.agentKind === right.agentKind
    && sameSession(left.agentSession, right.agentSession);
}

/**
 * Judge one `PaneInfo` against the binding. The pane ID is deliberately not
 * consulted here: the caller has already routed by pane ID, and a move rewrites
 * it under the stricter rule in `movedIdentity`.
 */
export function paneContinuity(identity: SupervisedIdentity, pane: SupervisionPaneRecord): ContinuityVerdict {
  if (pane.terminalId !== identity.terminalId) return "replaced";
  if (pane.agentKind !== undefined && pane.agentKind !== identity.agentKind) return "replaced";
  if (pane.agentSession === undefined) return "unproven";
  return sameSession(pane.agentSession, identity.agentSession) ? "continuous" : "replaced";
}

/**
 * A pane record read back from an authoritative snapshot, joined with the agent
 * record that snapshot holds for the same pane. The agent name is only ever
 * available from the agent record, never from a pane event.
 */
export interface AuthoritativeOccupant {
  pane: SupervisionPaneRecord;
  agentName?: string;
}

/** Judge an authoritative occupant, including the agent name a snapshot supplies. */
export function occupantContinuity(identity: SupervisedIdentity, occupant: AuthoritativeOccupant): ContinuityVerdict {
  if (occupant.agentName !== undefined && occupant.agentName !== identity.agentName) return "replaced";
  return paneContinuity(identity, occupant.pane);
}

/**
 * Requirement 6: a move is followed only when the atomic move event and a fresh
 * authoritative occupant both prove terminal and agent-session continuity, and
 * the fresh revision has not gone backwards. Anything else settles
 * `identity_lost`.
 */
export function movedIdentity(
  identity: SupervisedIdentity,
  moved: SupervisionPaneRecord,
  fresh: AuthoritativeOccupant,
  lastRevision: number,
): SupervisedIdentity | undefined {
  if (paneContinuity(identity, moved) !== "continuous") return undefined;
  if (fresh.pane.paneId !== moved.paneId) return undefined;
  if (occupantContinuity(identity, fresh) !== "continuous") return undefined;
  if (fresh.pane.revision < lastRevision) return undefined;
  return { ...identity, paneId: moved.paneId };
}
