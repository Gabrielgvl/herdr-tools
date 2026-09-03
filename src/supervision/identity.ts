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

import type { HerdrSnapshot } from "../targets.js";
import type { ReconciliationFailureReason } from "./events.js";
import { isPaneRecordEvent, parsePaneRecord, SUPERVISION_AGENT_STATUSES, type AgentSessionRecord, type SupervisionAgentStatus, type SupervisionPaneRecord, type SupervisionSocketEvent } from "./protocol.js";

export interface SupervisedIdentity {
  paneId: string;
  terminalId: string;
  agentName: string;
  agentKind: string;
  agentSession: AgentSessionRecord;
}

/** Reduced-assurance identity used only by AGY before its native session exists. */
export interface ProvisionalSupervisedIdentity {
  paneId: string;
  terminalId: string;
  agentName: string;
  agentKind: "agy";
}

export interface ProvisionalLifecycleBaseline {
  state: "idle";
  stateChangeSeq: number;
  revision: number;
}

export interface ProvisionalSupervisionBinding {
  identity: ProvisionalSupervisedIdentity;
  profileName: string;
  baseline: ProvisionalLifecycleBaseline;
}

export interface SupervisionAnchor {
  /** Pane revision at bind. Events below it are historical replay. */
  revision: number;
  status: SupervisionAgentStatus;
  /** Recorded when the authoritative binding or occupant supplied one. */
  stateChangeSeq?: number;
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
  agentPresent: boolean;
  agentName?: string;
  stateChangeSeq?: number;
}

/** A target-local occupant with the lifecycle counter needed by AGY strengthening. */
export interface ProvisionalAuthoritativeOccupant extends AuthoritativeOccupant {
  stateChangeSeq?: number;
}

export type TargetLocalReconciliationFailure = Extract<
  ReconciliationFailureReason,
  | "duplicate_target_pane"
  | "duplicate_target_agent"
  | "orphan_target_agent"
  | "target_identity_contradiction"
  | "target_record_malformed"
>;

export type SnapshotTargetEvidence =
  | { kind: "unique"; occupant: AuthoritativeOccupant }
  | { kind: "absent" }
  | { kind: "invalid"; reason: TargetLocalReconciliationFailure };

function own(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function optionalIdentityString(value: Record<string, unknown>, key: string): string | undefined {
  if (!own(value, key) || value[key] === null || value[key] === undefined) return undefined;
  if (typeof value[key] !== "string" || value[key].length === 0) throw new Error("target identity string is malformed");
  return value[key];
}

function optionalSession(value: Record<string, unknown>): AgentSessionRecord | undefined {
  if (!own(value, "agent_session") || value.agent_session === null || value.agent_session === undefined) return undefined;
  if (typeof value.agent_session !== "object" || Array.isArray(value.agent_session)) throw new Error("target session is malformed");
  const session = value.agent_session as Record<string, unknown>;
  const source = optionalIdentityString(session, "source");
  const agent = optionalIdentityString(session, "agent");
  const kind = optionalIdentityString(session, "kind");
  const sessionValue = optionalIdentityString(session, "value");
  if (source === undefined || agent === undefined || kind === undefined || sessionValue === undefined) throw new Error("target session is incomplete");
  return { source, agent, kind, value: sessionValue };
}

function contradictory(left: string | AgentSessionRecord | undefined, right: string | AgentSessionRecord | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  if (typeof left === "string" || typeof right === "string") return left !== right;
  return !sameSession(left, right);
}

/** Classify one pane's target-local snapshot evidence without conflating invalidity with absence. */
export function classifySnapshotTarget(snapshot: HerdrSnapshot, paneId: string): SnapshotTargetEvidence {
  const panes = snapshot.panes.filter((item) => item.pane_id === paneId);
  const agents = snapshot.agents.filter((item) => item.pane_id === paneId);
  if (panes.length === 0) {
    if (agents.length > 1) return { kind: "invalid", reason: "duplicate_target_agent" };
    if (agents.length === 1) return { kind: "invalid", reason: "orphan_target_agent" };
    return { kind: "absent" };
  }
  if (panes.length > 1) return { kind: "invalid", reason: "duplicate_target_pane" };
  if (agents.length > 1) return { kind: "invalid", reason: "duplicate_target_agent" };

  try {
    const paneRecord = panes[0]!;
    const pane = parsePaneRecord(paneRecord);
    const paneName = optionalIdentityString(paneRecord, "agent_name") ?? optionalIdentityString(paneRecord, "name");
    if (agents.length === 0) return { kind: "unique", occupant: { pane, agentPresent: false, ...(paneName === undefined ? {} : { agentName: paneName }), ...(pane.stateChangeSeq === undefined ? {} : { stateChangeSeq: pane.stateChangeSeq }) } };

    const agentRecord = agents[0]!;
    const agentName = optionalIdentityString(agentRecord, "name") ?? optionalIdentityString(agentRecord, "agent_name");
    const agentTerminal = optionalIdentityString(agentRecord, "terminal_id");
    const agentKind = optionalIdentityString(agentRecord, "agent");
    const agentSession = optionalSession(agentRecord);
    const agentRevision = optionalLifecycleCounter(agentRecord, "revision");
    const agentStatus = optionalLifecycleStatus(agentRecord);
    const agentStateChangeSeq = optionalLifecycleCounter(agentRecord, "state_change_seq");
    if (contradictory(paneName, agentName)
      || contradictory(pane.terminalId, agentTerminal)
      || contradictory(pane.agentKind, agentKind)
      || contradictory(pane.agentSession, agentSession)
      || (agentRevision !== undefined && agentRevision !== pane.revision)
      || (agentStatus !== undefined && agentStatus !== pane.agentStatus)
      || (agentStateChangeSeq !== undefined && pane.stateChangeSeq !== undefined && agentStateChangeSeq !== pane.stateChangeSeq)) {
      return { kind: "invalid", reason: "target_identity_contradiction" };
    }
    const stateChangeSeq = agentStateChangeSeq ?? pane.stateChangeSeq;
    const joinedPane: SupervisionPaneRecord = {
      ...pane,
      ...(pane.agentKind !== undefined || agentKind === undefined ? {} : { agentKind }),
      ...(pane.agentSession !== undefined || agentSession === undefined ? {} : { agentSession }),
      ...(stateChangeSeq === undefined ? {} : { stateChangeSeq }),
    };
    const joinedName = agentName ?? paneName;
    return { kind: "unique", occupant: { pane: joinedPane, agentPresent: true, ...(joinedName === undefined ? {} : { agentName: joinedName }), ...(stateChangeSeq === undefined ? {} : { stateChangeSeq }) } };
  } catch {
    return { kind: "invalid", reason: "target_record_malformed" };
  }
}

export type ProvisionalSnapshotTargetEvidence =
  | { kind: "unique"; occupant: ProvisionalAuthoritativeOccupant }
  | { kind: "absent" }
  | { kind: "invalid"; reason: TargetLocalReconciliationFailure };

function optionalLifecycleCounter(value: Record<string, unknown>, key: string): number | undefined {
  if (!own(value, key) || value[key] === null || value[key] === undefined) return undefined;
  if (typeof value[key] !== "number" || !Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error("target lifecycle counter is malformed");
  return value[key];
}

function optionalLifecycleStatus(value: Record<string, unknown>): SupervisionAgentStatus | undefined {
  if (!own(value, "agent_status") || value.agent_status === null || value.agent_status === undefined) return undefined;
  if (typeof value.agent_status !== "string" || !(SUPERVISION_AGENT_STATUSES as readonly string[]).includes(value.agent_status)) throw new Error("target lifecycle status is malformed");
  return value.agent_status as SupervisionAgentStatus;
}

/** Read AGY's stronger lifecycle tuple and retain its reduced-assurance checks. */
export function classifyProvisionalSnapshotTarget(snapshot: HerdrSnapshot, paneId: string): ProvisionalSnapshotTargetEvidence {
  const target = classifySnapshotTarget(snapshot, paneId);
  if (target.kind !== "unique") return target;
  const rawPane = snapshot.panes.find((item) => item.pane_id === paneId) as Record<string, unknown> | undefined;
  const rawAgent = snapshot.agents.find((item) => item.pane_id === paneId) as Record<string, unknown> | undefined;
  if (rawPane === undefined) return { kind: "absent" };
  try {
    const paneSequence = optionalLifecycleCounter(rawPane, "state_change_seq");
    const agentSequence = rawAgent === undefined ? undefined : optionalLifecycleCounter(rawAgent, "state_change_seq");
    const paneRevision = optionalLifecycleCounter(rawPane, "revision");
    const agentRevision = rawAgent === undefined ? undefined : optionalLifecycleCounter(rawAgent, "revision");
    const paneStatus = optionalLifecycleStatus(rawPane);
    const agentStatus = rawAgent === undefined ? undefined : optionalLifecycleStatus(rawAgent);
    if ((paneSequence !== undefined && agentSequence !== undefined && paneSequence !== agentSequence)
      || (paneRevision !== undefined && agentRevision !== undefined && paneRevision !== agentRevision)
      || (paneStatus !== undefined && agentStatus !== undefined && paneStatus !== agentStatus)) {
      return { kind: "invalid", reason: "target_identity_contradiction" };
    }
    return {
      kind: "unique",
      occupant: {
        ...target.occupant,
        ...(agentSequence ?? paneSequence) === undefined ? {} : { stateChangeSeq: agentSequence ?? paneSequence },
      },
    };
  } catch {
    return { kind: "invalid", reason: "target_record_malformed" };
  }
}

/** AGY's pre-native identity requires every visible identity component except the session. */
export function provisionalOccupantContinuity(identity: ProvisionalSupervisedIdentity, occupant: AuthoritativeOccupant): ContinuityVerdict {
  if (!occupant.agentPresent) return "unproven";
  if (occupant.pane.paneId !== identity.paneId || occupant.pane.terminalId !== identity.terminalId) return "replaced";
  if (occupant.agentName !== undefined && occupant.agentName !== identity.agentName) return "replaced";
  if (occupant.agentName === undefined || occupant.pane.agentKind === undefined) return "unproven";
  if (occupant.pane.agentKind !== identity.agentKind) return "replaced";
  const session = occupant.pane.agentSession;
  if (session !== undefined && session.agent !== identity.agentKind) return "replaced";
  return "continuous";
}

/** Lifecycle fields retained on a validated full pane event for strengthening. */
export interface ProvisionalEventLifecycle {
  status: SupervisionAgentStatus;
  revision: number;
  stateChangeSeq?: number;
}

export function provisionalEventLifecycle(event: SupervisionSocketEvent): ProvisionalEventLifecycle {
  if (!isPaneRecordEvent(event.event) || event.pane === undefined || typeof event.data.pane !== "object" || event.data.pane === null || Array.isArray(event.data.pane)) {
    throw new Error("target lifecycle evidence is unavailable");
  }
  const stateChangeSeq = optionalLifecycleCounter(event.data.pane as Record<string, unknown>, "state_change_seq");
  return {
    status: event.pane.agentStatus,
    revision: event.pane.revision,
    ...(stateChangeSeq === undefined ? {} : { stateChangeSeq }),
  };
}

/** Judge an authoritative occupant, including the agent name a snapshot supplies. */
export function occupantContinuity(identity: SupervisedIdentity, occupant: AuthoritativeOccupant): ContinuityVerdict {
  if (occupant.agentName !== undefined && occupant.agentName !== identity.agentName) return "replaced";
  return paneContinuity(identity, occupant.pane);
}

/**
 * Requirement 6: a move is followed only when the atomic move event and a fresh
 * authoritative occupant both prove terminal and agent-session continuity.
 * Revisions are pane-local, so the destination revision is never compared with
 * the origin pane's watermark. Anything else settles `identity_lost`.
 */
export function movedIdentity(
  identity: SupervisedIdentity,
  moved: SupervisionPaneRecord,
  fresh: AuthoritativeOccupant,
): SupervisedIdentity | undefined {
  if (paneContinuity(identity, moved) !== "continuous") return undefined;
  if (!fresh.agentPresent || fresh.pane.paneId !== moved.paneId) return undefined;
  if (occupantContinuity(identity, fresh) !== "continuous") return undefined;
  return { ...identity, paneId: moved.paneId };
}
