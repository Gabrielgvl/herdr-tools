import type { HerdrCli } from "../cli.js";
import { assertControlScope, CallerPolicyError, classifyCaller } from "../caller-policy.js";
import { contextRebindingDetails, type ContextResolutionDiagnostics, type ContextResolver } from "../context.js";
import { formatResult } from "../tui.js";
import { joinPromptTargetIdentity, type PromptIdentityError, type PromptTargetIdentity } from "../messages/prompt.js";
import { parseSnapshotResult, resolveTarget, type CurrentContext, type HerdrSnapshot, type ResolvedTarget } from "../targets.js";
import type { TurnControlOperation } from "../schemas.js";

export const TURN_CONTROL_WINDOW_MS = 5_000;
const TURN_CONTROL_SIGNAL_GRACE_MS = 250;
const MAX_EVIDENCE_STRING = 256;
const TERMINAL_STATES = new Set(["idle", "blocked", "done"] as const);
const KNOWN_STATES = new Set(["idle", "working", "blocked", "done", "unknown"] as const);
const SESSION_FIELDS = [
  "agent_session",
  "agent_session_id",
  "session_id",
  "agent_session_source",
  "agent_session_agent",
  "agent_session_kind",
  "agent_session_value",
  "session_source",
  "session_agent",
  "session_kind",
  "session_value"
] as const;
const FLATTENED_SESSION_FAMILIES = [
  {
    source: "agent_session_source",
    agent: "agent_session_agent",
    kind: "agent_session_kind",
    value: "agent_session_value"
  },
  {
    source: "session_source",
    agent: "session_agent",
    kind: "session_kind",
    value: "session_value"
  }
] as const;
const AGENT_IDENTITY_FIELDS = [
  "agent",
  "agent_name",
  "display_agent",
  "agent_id",
  ...SESSION_FIELDS,
  "agent_terminal_id",
  "agent_process_id",
  "agent_kind",
  "managed_kind",
  "kind",
  "name"
] as const;

type AgentState = "idle" | "working" | "blocked" | "done" | "unknown";
type TurnControlPhase = "preflight" | "snapshot" | "caller_policy" | "pre_state" | "identity" | "dispatch" | "wait" | "final_snapshot" | "confirmation" | "confirmed";
type ConfirmationKind = "same_agent" | "agent_exited" | "unconfirmed";

interface AgentSessionIdentity {
  source: string;
  agent: string;
  kind: string;
  value: string;
}

interface StableIdentity {
  paneId: string;
  terminalId: string;
  agentName: string;
  agentKind: string;
  agentSession: AgentSessionIdentity;
}

interface TurnIdentity extends StableIdentity {
  tabId: string;
  workspaceId: string;
}

interface TurnRecordIdentity extends TurnIdentity {
  state: AgentState;
}

interface TargetRecords {
  pane?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  paneCount: number;
  agentCount: number;
}

export interface TurnControlDetails {
  operation: TurnControlOperation;
  outcome: "cancelled" | "interrupted" | "agent_exited";
  target: {
    paneId: string;
    tabId: string;
    workspaceId: string;
    terminalId: string;
    agentSession: AgentSessionIdentity;
    label?: string;
    agentName?: string;
  };
  preState: Record<string, unknown>;
  finalState?: Record<string, unknown>;
  preEvidence: Record<string, unknown>;
  finalEvidence: Record<string, unknown>;
  phase: TurnControlPhase;
  reason: string;
  dispatchAcknowledged: boolean;
  dispatchAttempted: boolean;
  operationIds: {
    snapshot?: string;
    agentGet?: string;
    dispatch?: string;
    wait?: string;
    finalSnapshot?: string;
  };
  control: { key: "esc" | "ctrl+c"; windowMs: 5000 };
  controlKey: "esc" | "ctrl+c";
  windowMs: 5000;
  dispatch?: { outcome: "acknowledged" | "failed"; code?: string };
  confirmation: {
    kind: ConfirmationKind;
    state?: AgentState;
    stateChangeSeq?: { before: number; after: number };
    causality?: "post_dispatch_absence_proven";
  };
  wait?: { outcome: "completed" | "failed"; code?: string };
  contextRebinding?: ContextResolutionDiagnostics;
}

export interface TurnControlDependencies {
  cli: HerdrCli;
  context: CurrentContext;
  contextResolver: ContextResolver;
  preflight: (signal: AbortSignal) => Promise<void>;
}

export class TurnControlError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "TurnControlError";
    this.code = code;
    this.details = details;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bounded(value: string): string {
  return [...value].slice(0, MAX_EVIDENCE_STRING).join("");
}

function boundedOperationId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? bounded(value) : undefined;
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? bounded(value) : undefined;
}

/** Read an authoritative identifier without applying the model-visible evidence bound. */
function authoritativeString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function errorCode(error: unknown): string | undefined {
  if (!record(error)) return undefined;
  return typeof error.code === "string" && error.code.length > 0 ? bounded(error.code) : undefined;
}

function errorMessage(error: unknown): string {
  return bounded(error instanceof Error ? error.message : String(error));
}

function errorDetails(error: unknown): Record<string, unknown> {
  if (!record(error) || !record(error.details)) return {};
  const details = error.details;
  return {
    ...(typeof details.target === "string" ? { target: bounded(details.target) } : {}),
    ...(typeof details.actualKind === "string" ? { actualKind: bounded(details.actualKind) } : {}),
    ...(Array.isArray(details.candidates) ? { candidates: details.candidates.filter((candidate): candidate is string => typeof candidate === "string").slice(0, 16).map(bounded) } : {})
  };
}

function compactEvidence(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value) return { status: "unavailable" };
  const evidence: Record<string, unknown> = {};
  const fields = [
    "pane_id",
    "tab_id",
    "workspace_id",
    "terminal_id",
    "agent_id",
    "name",
    "agent_name",
    "agent",
    "agent_status",
    "state_change_seq",
    "status",
    "interactive_ready",
    "launch_pending"
  ] as const;
  for (const field of fields) {
    const item = value[field];
    if (typeof item === "string") evidence[field] = bounded(item);
    else if (typeof item === "number" && Number.isFinite(item)) evidence[field] = item;
    else if (typeof item === "boolean" || item === null) evidence[field] = item;
  }
  const session = sessionFrom(value.agent_session);
  if (session) evidence.agent_session = session;
  return evidence;
}

function authoritativeSessionFrom(value: unknown): AgentSessionIdentity | undefined {
  if (!record(value)) return undefined;
  const source = authoritativeString(value.source);
  const agent = authoritativeString(value.agent);
  const kind = authoritativeString(value.kind);
  const sessionValue = authoritativeString(value.value);
  if (!source || !agent || !kind || !sessionValue) return undefined;
  return { source, agent, kind, value: sessionValue };
}

/** Project a complete authoritative session identity into bounded evidence. */
function sessionFrom(value: unknown): AgentSessionIdentity | undefined {
  const session = authoritativeSessionFrom(value);
  if (!session) return undefined;
  return {
    source: bounded(session.source),
    agent: bounded(session.agent),
    kind: bounded(session.kind),
    value: bounded(session.value)
  };
}

type SessionEvidenceKind = "none" | "matching" | "different" | "malformed" | "contradictory";
interface SessionEvidence {
  kind: SessionEvidenceKind;
  fingerprint?: string;
}

function owns(value: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function sessionEvidenceForSession(session: AgentSessionIdentity, expected: AgentSessionIdentity): SessionEvidence {
  return {
    kind: sameSession(session, expected) ? "matching" : "different",
    fingerprint: JSON.stringify(session)
  };
}

function sessionEvidenceForLegacy(value: unknown, expected: AgentSessionIdentity): SessionEvidence {
  const sessionValue = authoritativeString(value);
  if (!sessionValue) return { kind: "malformed" };
  return { kind: sessionValue === expected.value ? "matching" : "different", fingerprint: `legacy:${sessionValue}` };
}

function sessionEvidenceForFlattenedFamily(value: Record<string, unknown>, expected: AgentSessionIdentity, family: (typeof FLATTENED_SESSION_FAMILIES)[number]): SessionEvidence | undefined {
  const fields = [family.source, family.agent, family.kind, family.value];
  const present = fields.filter((field) => owns(value, field));
  if (present.length === 0) return undefined;
  if (present.length !== fields.length) return { kind: "malformed" };

  const session = {
    source: authoritativeString(value[family.source]),
    agent: authoritativeString(value[family.agent]),
    kind: authoritativeString(value[family.kind]),
    value: authoritativeString(value[family.value])
  };
  if (!session.source || !session.agent || !session.kind || !session.value) return { kind: "malformed" };
  return sessionEvidenceForSession(session as AgentSessionIdentity, expected);
}

/**
 * Evaluate every supported session representation on one record. Complete,
 * different structured sessions are valid evidence for unrelated agents; a
 * partial, malformed, or contradictory representation is never trusted.
 */
function sessionEvidence(value: Record<string, unknown>, expected: AgentSessionIdentity): SessionEvidence {
  const observations: SessionEvidence[] = [];
  if (owns(value, "agent_session")) {
    const raw = value.agent_session;
    if (record(raw)) {
      const session = authoritativeSessionFrom(raw);
      observations.push(session ? sessionEvidenceForSession(session, expected) : { kind: "malformed" });
    } else {
      observations.push(sessionEvidenceForLegacy(raw, expected));
    }
  }
  for (const field of ["agent_session_id", "session_id"] as const) {
    if (owns(value, field)) observations.push(sessionEvidenceForLegacy(value[field], expected));
  }
  for (const family of FLATTENED_SESSION_FAMILIES) {
    const flattened = sessionEvidenceForFlattenedFamily(value, expected, family);
    if (flattened) observations.push(flattened);
  }
  if (observations.length === 0) return { kind: "none" };
  if (observations.some((observation) => observation.kind === "malformed")) return { kind: "malformed" };
  const matching = observations.filter((observation) => observation.kind === "matching");
  const different = observations.filter((observation) => observation.kind === "different");
  if (matching.length > 0 && different.length > 0) return { kind: "contradictory" };
  if (matching.length > 0) return { kind: "matching" };
  const fingerprints = new Set(different.map((observation) => observation.fingerprint).filter((fingerprint): fingerprint is string => fingerprint !== undefined));
  return fingerprints.size > 1 ? { kind: "contradictory" } : { kind: "different" };
}

function hasSessionRepresentation(value: Record<string, unknown>): boolean {
  return SESSION_FIELDS.some((field) => owns(value, field));
}

const TURN_IDENTITY_FIELDS = [
  "pane_id",
  "terminal_id",
  "name",
  "agent_name",
  "agent",
  "agent_kind",
  "managed_kind",
  "kind",
  "agent_session"
] as const;

function identityFailure(error: PromptIdentityError, phase: TurnControlPhase): TurnControlError {
  return new TurnControlError(error.code, error.message, { phase, ...error.details });
}

function validateIdentityFieldShapes(records: Record<string, unknown>[], phase: TurnControlPhase): void {
  for (const value of records) {
    for (const field of TURN_IDENTITY_FIELDS) {
      if (!owns(value, field)) continue;
      if (value[field] === null || value[field] === undefined) {
        throw new TurnControlError("TARGET_IDENTITY_UNAVAILABLE", "Authoritative target identity is malformed", { phase, field });
      }
    }
  }
}

function repeatedString(records: Record<string, unknown>[], fields: readonly string[], field: string, phase: TurnControlPhase): string {
  let selected: string | undefined;
  for (const value of records) {
    for (const alias of fields) {
      if (!owns(value, alias)) continue;
      const candidate = authoritativeString(value[alias]);
      if (!candidate) throw new TurnControlError("TARGET_IDENTITY_UNAVAILABLE", "Authoritative target identity is malformed", { phase, field: alias });
      if (selected !== undefined && selected !== candidate) {
        throw new TurnControlError("TARGET_IDENTITY_CHANGED", "Authoritative target identity is contradictory", { phase, field, expected: bounded(selected), actual: bounded(candidate) });
      }
      selected ??= candidate;
    }
  }
  if (selected === undefined) throw new TurnControlError("TARGET_IDENTITY_UNAVAILABLE", "Authoritative target identity is missing", { phase, field });
  return selected;
}

function stateFromRecords(records: Record<string, unknown>[], phase: TurnControlPhase): AgentState {
  let selected: AgentState | undefined;
  for (const value of records) {
    for (const field of ["agent_status", "status"] as const) {
      if (!owns(value, field)) continue;
      const candidate = value[field];
      if (typeof candidate !== "string" || !KNOWN_STATES.has(candidate as AgentState)) {
        throw new TurnControlError("TARGET_STATE_UNAVAILABLE", "Authoritative target state is unavailable", { phase, state: typeof candidate === "string" ? bounded(candidate) : undefined });
      }
      if (selected !== undefined && selected !== candidate) {
        throw new TurnControlError("TARGET_IDENTITY_CHANGED", "Authoritative target state is contradictory", { phase, expectedState: selected, actualState: candidate });
      }
      selected ??= candidate as AgentState;
    }
  }
  if (selected === undefined) throw new TurnControlError("TARGET_STATE_UNAVAILABLE", "Authoritative target state is unavailable", { phase });
  return selected;
}

function stateFrom(value: Record<string, unknown> | undefined, phase: TurnControlPhase): AgentState {
  return stateFromRecords(value ? [value] : [], phase);
}

function requireWorking(value: Record<string, unknown>, phase: TurnControlPhase): AgentState {
  const state = stateFrom(value, phase);
  if (state === "unknown") throw new TurnControlError("TARGET_STATE_UNKNOWN", "Target state is unknown; no turn-control key was sent", { phase, state });
  if (state !== "working") throw new TurnControlError("TURN_NOT_ACTIVE", "Target does not have an active working turn", { phase, state });
  return state;
}

function snapshotTargetRecords(snapshot: HerdrSnapshot, paneId: string): TargetRecords {
  const panes = snapshot.panes.filter((candidate) => candidate.pane_id === paneId) as Array<Record<string, unknown>>;
  const agents = snapshot.agents.filter((candidate) => candidate.pane_id === paneId) as Array<Record<string, unknown>>;
  return { pane: panes[0], agent: agents[0], paneCount: panes.length, agentCount: agents.length };
}

function requireSnapshotTargetRecords(snapshot: HerdrSnapshot, paneId: string, phase: TurnControlPhase): { pane: Record<string, unknown>; agent: Record<string, unknown> } {
  const located = snapshotTargetRecords(snapshot, paneId);
  if (located.paneCount !== 1 || located.agentCount !== 1 || !located.pane || !located.agent) {
    throw new TurnControlError("TARGET_IDENTITY_UNAVAILABLE", "Snapshot does not contain exactly one target pane and agent record", {
      phase,
      paneId: bounded(paneId),
      targetPaneRecordCount: located.paneCount,
      targetAgentRecordCount: located.agentCount
    });
  }
  return { pane: located.pane, agent: located.agent };
}

function stateChangeSeq(records: Record<string, unknown>[], phase: TurnControlPhase): number | undefined {
  let selected: number | undefined;
  for (const value of records) {
    if (!owns(value, "state_change_seq") || value.state_change_seq === undefined) continue;
    const candidate = safeInteger(value.state_change_seq);
    if (candidate === undefined) throw new TurnControlError("TARGET_STATE_UNAVAILABLE", "Authoritative target state-change sequence is invalid", { phase });
    if (selected !== undefined && selected !== candidate) {
      throw new TurnControlError("TARGET_STATE_UNAVAILABLE", "Authoritative target state-change sequence is contradictory", { phase, expected: selected, actual: candidate });
    }
    selected ??= candidate;
  }
  return selected;
}

function evidenceValueEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeEvidence(records: Record<string, unknown>[], overwrite: readonly string[] = []): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const overwriteFields = new Set(overwrite);
  for (const value of records) {
    const evidence = compactEvidence(value);
    for (const [field, candidate] of Object.entries(evidence)) {
      if (!owns(result, field)) {
        result[field] = candidate;
      } else if (overwriteFields.has(field)) {
        result[field] = candidate;
      } else if (!evidenceValueEqual(result[field], candidate)) {
        throw new TurnControlError("TARGET_IDENTITY_CHANGED", "Authoritative target evidence is contradictory", { field });
      }
    }
  }
  return result;
}

function joinTurnIdentity(records: Record<string, unknown>[], expectedPaneId: string, phase: TurnControlPhase): TurnRecordIdentity {
  validateIdentityFieldShapes(records, phase);
  let promptIdentity: PromptTargetIdentity;
  try {
    promptIdentity = joinPromptTargetIdentity(records, expectedPaneId);
  } catch (error) {
    throw identityFailure(error as PromptIdentityError, phase);
  }
  const tabId = repeatedString(records, ["tab_id"], "tab_id", phase);
  const workspaceId = repeatedString(records, ["workspace_id"], "workspace_id", phase);
  const state = stateFromRecords(records, phase);
  return { ...promptIdentity, tabId, workspaceId, state };
}

function stableIdentity(value: Record<string, unknown> | undefined, fallback: ResolvedTarget | undefined, requireOwnPaneId = false): TurnIdentity | undefined {
  const paneId = authoritativeString(value?.pane_id) ?? (requireOwnPaneId ? undefined : fallback?.paneId);
  const terminalId = authoritativeString(value?.terminal_id);
  const tabId = authoritativeString(value?.tab_id) ?? fallback?.tabId;
  const workspaceId = authoritativeString(value?.workspace_id) ?? fallback?.workspaceId;
  const agentName = authoritativeString(value?.name) ?? authoritativeString(value?.agent_name);
  const agentKind = authoritativeString(value?.agent) ?? authoritativeString(value?.agent_kind) ?? authoritativeString(value?.kind);
  const agentSession = authoritativeSessionFrom(value?.agent_session);
  if (!paneId || !terminalId || !tabId || !workspaceId || !agentName || !agentKind || !agentSession) return undefined;
  return { paneId, terminalId, tabId, workspaceId, agentName, agentKind, agentSession };
}

function sameSession(left: AgentSessionIdentity, right: AgentSessionIdentity): boolean {
  return left.source === right.source && left.agent === right.agent && left.kind === right.kind && left.value === right.value;
}

function sameIdentity(left: TurnIdentity, right: TurnIdentity): boolean {
  return left.paneId === right.paneId
    && left.terminalId === right.terminalId
    && left.agentName === right.agentName
    && left.agentKind === right.agentKind
    && sameSession(left.agentSession, right.agentSession)
    && left.tabId === right.tabId
    && left.workspaceId === right.workspaceId;
}

function mergedSnapshotAgent(snapshot: HerdrSnapshot, target: ResolvedTarget): Record<string, unknown> | undefined {
  if (!target.paneId) return undefined;
  const located = snapshotTargetRecords(snapshot, target.paneId);
  if (located.paneCount !== 1 || located.agentCount !== 1 || !located.pane || !located.agent) return undefined;
  try {
    joinTurnIdentity([located.pane, located.agent], target.paneId, "snapshot");
    return mergeEvidence([located.pane, located.agent]);
  } catch {
    return undefined;
  }
}

function agentGetResult(value: unknown): Record<string, unknown> {
  if (!record(value) || !record(value.agent)) throw new TurnControlError("TARGET_IDENTITY_UNAVAILABLE", "Fresh agent identity is unavailable", { phase: "identity" });
  return value.agent;
}

function turnTarget(identity: TurnIdentity, recordValue: Record<string, unknown>): TurnControlDetails["target"] {
  const label = safeString(recordValue.label);
  const agentName = safeString(recordValue.name) ?? safeString(recordValue.agent_name) ?? bounded(identity.agentName);
  return {
    paneId: bounded(identity.paneId),
    tabId: bounded(identity.tabId),
    workspaceId: bounded(identity.workspaceId),
    terminalId: bounded(identity.terminalId),
    agentSession: {
      source: bounded(identity.agentSession.source),
      agent: bounded(identity.agentSession.agent),
      kind: bounded(identity.agentSession.kind),
      value: bounded(identity.agentSession.value)
    },
    ...(label ? { label } : {}),
    agentName
  };
}

function baseDetails(
  operation: TurnControlOperation,
  key: "esc" | "ctrl+c",
  preEvidence: Record<string, unknown>,
  identity: TurnIdentity | undefined,
  phase: TurnControlPhase,
  operationIds: TurnControlDetails["operationIds"],
  dispatchAcknowledged: boolean,
  dispatchAttempted: boolean,
  finalEvidence: Record<string, unknown> = { status: "not_observed" }
): Record<string, unknown> {
  const target = identity
    ? turnTarget(identity, preEvidence)
    : { paneId: safeString(preEvidence.pane_id) ?? "unknown", tabId: safeString(preEvidence.tab_id) ?? "unknown", workspaceId: safeString(preEvidence.workspace_id) ?? "unknown", terminalId: safeString(preEvidence.terminal_id) ?? "unknown", agentSession: sessionFrom(preEvidence.agent_session) ?? { source: "unknown", agent: "unknown", kind: "unknown", value: "unknown" } };
  return {
    operation,
    target,
    preState: preEvidence,
    preEvidence,
    finalEvidence,
    phase,
    reason: "unconfirmed",
    dispatchAcknowledged,
    dispatchAttempted,
    operationIds,
    control: { key, windowMs: TURN_CONTROL_WINDOW_MS },
    controlKey: key,
    windowMs: TURN_CONTROL_WINDOW_MS,
    confirmation: { kind: "unconfirmed" }
  };
}

function fail(
  operation: TurnControlOperation,
  key: "esc" | "ctrl+c",
  code: string,
  message: string,
  preEvidence: Record<string, unknown>,
  identity: TurnIdentity | undefined,
  phase: TurnControlPhase,
  operationIds: TurnControlDetails["operationIds"],
  dispatchAcknowledged: boolean,
  dispatchAttempted: boolean,
  finalEvidence: Record<string, unknown> = { status: "not_observed" },
  extra: Record<string, unknown> = {}
): never {
  throw new TurnControlError(code, message, {
    ...baseDetails(operation, key, preEvidence, identity, phase, operationIds, dispatchAcknowledged, dispatchAttempted, finalEvidence),
    ...extra
  });
}

function boundedSignal(): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURN_CONTROL_WINDOW_MS + TURN_CONTROL_SIGNAL_GRACE_MS);
  if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") timer.unref();
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

function isTerminalState(value: AgentState): value is "idle" | "blocked" | "done" {
  return TERMINAL_STATES.has(value as "idle" | "blocked" | "done");
}

function hasAgentFields(value: Record<string, unknown>): boolean {
  return AGENT_IDENTITY_FIELDS.some((field) => owns(value, field));
}

function hasCapturedSessionElsewhere(snapshot: HerdrSnapshot, identity: TurnIdentity, targetPane?: Record<string, unknown>, targetAgent?: Record<string, unknown>): boolean {
  // Skip only the exact canonical records, never every record sharing their ID. This
  // makes duplicate-ID records visible to the absence scan instead of allowing the
  // first `.find()` result to hide captured session evidence.
  const canonicalPane = targetPane ?? snapshot.panes.find((candidate) => candidate.pane_id === identity.paneId);
  const canonicalAgent = targetAgent ?? snapshot.agents.find((candidate) => candidate.pane_id === identity.paneId);
  const records = [
    ...snapshot.panes.map((value) => ({ value: value as Record<string, unknown>, canonical: value === canonicalPane })),
    ...snapshot.agents.map((value) => ({ value: value as Record<string, unknown>, canonical: value === canonicalAgent }))
  ];
  return records.some(({ value, canonical }) => {
    if (canonical) return false;
    const evidence = sessionEvidence(value, identity.agentSession);
    return evidence.kind === "matching" || evidence.kind === "malformed" || evidence.kind === "contradictory";
  });
}

function isAgentFreeUnknown(snapshot: HerdrSnapshot, pane: Record<string, unknown>, identity: TurnIdentity): boolean {
  let state: AgentState;
  try {
    state = stateFrom(pane, "confirmation");
  } catch {
    return false;
  }
  if (state !== "unknown") return false;
  if (hasAgentFields(pane) || hasSessionRepresentation(pane)) return false;
  const located = finalRecord(snapshot, identity);
  if (located.paneCount !== 1 || located.agentCount !== 0) return false;
  return !hasCapturedSessionElsewhere(snapshot, identity, pane);
}

function sameParent(value: Record<string, unknown>, identity: TurnIdentity): boolean {
  return value.pane_id === identity.paneId && value.terminal_id === identity.terminalId && value.tab_id === identity.tabId && value.workspace_id === identity.workspaceId;
}

function finalRecord(snapshot: HerdrSnapshot, identity: TurnIdentity): {
  pane?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  merged?: Record<string, unknown>;
  paneRecords: Array<Record<string, unknown>>;
  agentRecords: Array<Record<string, unknown>>;
  paneCount: number;
  agentCount: number;
} {
  const paneRecords = snapshot.panes.filter((candidate) => candidate.pane_id === identity.paneId) as Array<Record<string, unknown>>;
  const agentRecords = snapshot.agents.filter((candidate) => candidate.pane_id === identity.paneId) as Array<Record<string, unknown>>;
  const pane = paneRecords[0];
  const agent = agentRecords[0];
  let merged: Record<string, unknown> | undefined;
  if (pane) {
    try {
      merged = mergeEvidence(agent ? [pane, agent] : [pane]);
    } catch {
      merged = undefined;
    }
  }
  return { pane, agent, merged, paneRecords, agentRecords, paneCount: paneRecords.length, agentCount: agentRecords.length };
}

function postWaitDetails(waitError: unknown): { outcome: "completed" | "failed"; code?: string } {
  const code = errorCode(waitError);
  return code ? { outcome: "failed", code } : { outcome: "failed" };
}

function dispatchEvidence(dispatchError: unknown): Record<string, unknown> {
  if (dispatchError === undefined) return { dispatch: { outcome: "acknowledged" } };
  return { dispatch: { outcome: "failed", code: errorCode(dispatchError) ?? "unknown" } };
}

function unconfirmedCode(operation: TurnControlOperation): "CANCEL_UNCONFIRMED" | "INTERRUPT_UNCONFIRMED" {
  return operation === "cancel" ? "CANCEL_UNCONFIRMED" : "INTERRUPT_UNCONFIRMED";
}

/** Execute the strict, one-key turn-control protocol used by herdr_communicate. */
export async function executeTurnControl(
  params: { target: string; operation: TurnControlOperation },
  deps: TurnControlDependencies,
  signal: AbortSignal
): Promise<{ content: Array<{ type: "text"; text: string }>; details: TurnControlDetails }> {
  const operation = params.operation;
  const key = operation === "cancel" ? "esc" : "ctrl+c";
  let phase: TurnControlPhase = "preflight";
  let preEvidence: Record<string, unknown> = { status: "not_observed" };
  let finalEvidence: Record<string, unknown> = { status: "not_observed" };
  let identity: TurnIdentity | undefined;
  const operationIds: TurnControlDetails["operationIds"] = {};
  let dispatchAcknowledged = false;
  let dispatchAttempted = false;
  let dispatchError: unknown;
  let finalValidationFailed = false;
  let waitEvidence: { outcome: "completed" | "failed"; code?: string } | undefined;
  let contextDiagnostics: ContextResolutionDiagnostics | undefined;
  const contextResolver = deps.contextResolver;

  try {
    if (signal.aborted) throw new TurnControlError("ABORTED", "Operation aborted before turn-control dispatch", baseDetails(operation, key, preEvidence, identity, phase, operationIds, false, false, finalEvidence));
    await deps.preflight(signal);
    if (signal.aborted) throw new TurnControlError("ABORTED", "Operation aborted before turn-control dispatch", baseDetails(operation, key, preEvidence, identity, phase, operationIds, false, false, finalEvidence));

    phase = "snapshot";
    const effective = await contextResolver(signal);
    contextDiagnostics = effective.diagnostics;
    operationIds.snapshot = boundedOperationId(effective.operationIds.snapshot);
    const snapshot = effective.snapshot;
    const resolved = resolveTarget(snapshot, params.target, "agent", effective.context);
    // Cooperative worker/manager routing (ADR-030): the same caller policy as
    // text sends — a leaf worker may never send turn-control keys, so the
    // denial is target-independent and happens before any state read or key.
    phase = "caller_policy";
    try {
      assertControlScope(classifyCaller(snapshot, effective.context.paneId), operation);
    } catch (error) {
      /* c8 ignore next -- parseSnapshotResult guarantees well-formed records, so classifyCaller only throws CallerPolicyError. */
      if (!(error instanceof CallerPolicyError)) throw error;
      fail(operation, key, error.code, error.message, preEvidence, identity, phase, operationIds, false, false, finalEvidence, {
        callerPolicy: error.details,
        ...contextRebindingDetails(contextDiagnostics!),
        reason: error.message
      });
    }
    const snapshotRecords = requireSnapshotTargetRecords(snapshot, resolved.paneId!, "pre_state");

    phase = "pre_state";
    const snapshotIdentity = joinTurnIdentity([snapshotRecords.pane, snapshotRecords.agent], resolved.paneId!, phase);
    requireWorking(snapshotRecords.pane, phase);
    requireWorking(snapshotRecords.agent, phase);
    preEvidence = mergeEvidence([snapshotRecords.pane, snapshotRecords.agent]);

    phase = "identity";
    identity = snapshotIdentity;
    const baselineSeq = stateChangeSeq([snapshotRecords.pane, snapshotRecords.agent], phase);

    const agentEnvelope = await deps.cli.runJson(["agent", "get", identity.paneId], signal);
    operationIds.agentGet = boundedOperationId(agentEnvelope.id);
    const freshAgent = agentGetResult(agentEnvelope.result);
    const freshEvidence = compactEvidence(freshAgent);
    requireWorking(freshAgent, phase);
    joinTurnIdentity([snapshotRecords.pane, snapshotRecords.agent, freshAgent], identity.paneId, phase);
    const freshSeq = stateChangeSeq([freshAgent], phase);
    if (freshSeq === undefined && baselineSeq === undefined) fail(operation, key, "TARGET_IDENTITY_UNAVAILABLE", "Target state-change sequence is unavailable", preEvidence, identity, phase, operationIds, false, false, finalEvidence, { freshEvidence });
    if (baselineSeq !== undefined && freshSeq !== undefined && freshSeq < baselineSeq) {
      fail(operation, key, "TARGET_STATE_UNAVAILABLE", "Fresh target state-change sequence regressed from the snapshot baseline", preEvidence, identity, phase, operationIds, false, false, finalEvidence, {
        freshEvidence,
        stateChangeSeq: { snapshot: baselineSeq, fresh: freshSeq }
      });
    }
    const beforeSeq = freshSeq ?? baselineSeq!;
    preEvidence = mergeEvidence([snapshotRecords.pane, snapshotRecords.agent, freshAgent], ["state_change_seq"]);
    preEvidence.state_change_seq = beforeSeq;

    if (signal.aborted) throw new TurnControlError("ABORTED", "Operation aborted before turn-control dispatch", baseDetails(operation, key, preEvidence, identity, phase, operationIds, false, false, finalEvidence));

    phase = "dispatch";
    dispatchAttempted = true;
    try {
      const dispatchEnvelope = await deps.cli.runJson(["agent", "send-keys", identity.paneId, key], signal, true);
      dispatchAcknowledged = true;
      operationIds.dispatch = boundedOperationId(dispatchEnvelope.id);
    } catch (error) {
      dispatchError = error;
    }

    phase = "wait";
    const waitWindow = boundedSignal();
    try {
      const waitEnvelope = await deps.cli.runJson([
        "agent",
        "wait",
        identity.paneId,
        "--until",
        "idle",
        "--until",
        "blocked",
        "--until",
        "done",
        "--until",
        "unknown",
        "--timeout",
        String(TURN_CONTROL_WINDOW_MS)
      ], waitWindow.signal);
      operationIds.wait = boundedOperationId(waitEnvelope.id);
      waitEvidence = { outcome: "completed" };
    } catch (error) {
      waitEvidence = postWaitDetails(error);
    } finally {
      waitWindow.dispose();
    }

    phase = "final_snapshot";
    const finalWindow = boundedSignal();
    let finalSnapshot: HerdrSnapshot | undefined;
    let finalError: unknown;
    try {
      const finalEnvelope = await deps.cli.runJson(["api", "snapshot"], finalWindow.signal);
      operationIds.finalSnapshot = boundedOperationId(finalEnvelope.id);
      finalSnapshot = parseSnapshotResult(finalEnvelope.result);
    } catch (error) {
      finalError = error;
    } finally {
      finalWindow.dispose();
    }

    const failureEvidence = dispatchEvidence(dispatchError);
    if (!finalSnapshot) {
      finalEvidence = { status: "unavailable", error: { code: errorCode(finalError!) ?? "unknown" } };
      fail(operation, key, unconfirmedCode(operation), "Final turn-control state could not be confirmed", preEvidence, identity, phase, operationIds, dispatchAcknowledged, dispatchAttempted, finalEvidence, { wait: waitEvidence!, ...failureEvidence });
    }

    const located = finalRecord(finalSnapshot, identity);
    if (!located.pane) {
      finalEvidence = { pane: "absent" };
      fail(operation, key, unconfirmedCode(operation), "Final target pane did not remain in its original context", preEvidence, identity, phase, operationIds, dispatchAcknowledged, dispatchAttempted, finalEvidence, { wait: waitEvidence!, ...failureEvidence });
    }
    if (!sameParent(located.pane, identity)) {
      finalEvidence = compactEvidence(located.pane);
      fail(operation, key, unconfirmedCode(operation), "Final target pane did not remain in its original context", preEvidence, identity, phase, operationIds, dispatchAcknowledged, dispatchAttempted, finalEvidence, { wait: waitEvidence!, ...failureEvidence });
    }

    finalEvidence = compactEvidence(located.pane);
    if (operation === "cancel" && located.pane.agent_status === "unknown" && !hasAgentFields(located.pane) && located.agent === undefined) {
      fail(operation, key, "CANCEL_UNCONFIRMED", "Target agent disappeared before cancel could be confirmed", preEvidence, identity, "confirmation", operationIds, dispatchAcknowledged, dispatchAttempted, finalEvidence, { wait: waitEvidence!, ...failureEvidence });
    }
    // The exit proof has a strict record shape. Check duplicate target records before
    // scanning global session absence so no duplicate-ID record can be hidden by the
    // canonical record selected for final evidence.
    const exitRecordShapeValid = located.paneCount === 1 && located.agentCount === 0;
    const agentExited = operation === "interrupt" && exitRecordShapeValid && isAgentFreeUnknown(finalSnapshot, located.pane, identity);
    if (operation === "interrupt" && located.pane.agent_status === "unknown" && !agentExited) {
      fail(operation, key, "INTERRUPT_UNCONFIRMED", "Strict agent-exited absence proof was not established", preEvidence, identity, "confirmation", operationIds, dispatchAcknowledged, dispatchAttempted, finalEvidence, {
        wait: waitEvidence!,
        ...failureEvidence,
        targetPaneRecordCount: located.paneCount,
        targetAgentRecordCount: located.agentCount
      });
    }
    if (agentExited) {
      if (!dispatchAcknowledged) fail(operation, key, "INTERRUPT_UNCONFIRMED", "Agent-free post-state cannot prove an acknowledged interrupt dispatch", preEvidence, identity, "confirmation", operationIds, dispatchAcknowledged, dispatchAttempted, finalEvidence, { wait: waitEvidence!, ...failureEvidence });
      const details = {
        ...baseDetails(operation, key, preEvidence, identity, "confirmed", operationIds, dispatchAcknowledged, dispatchAttempted, finalEvidence),
        ...contextRebindingDetails(contextDiagnostics!),
        outcome: "agent_exited" as const,
        finalState: finalEvidence,
        reason: "post_dispatch_absence_proven",
        confirmation: { kind: "agent_exited" as const, causality: "post_dispatch_absence_proven" as const },
        wait: waitEvidence!,
        ...failureEvidence
      } as TurnControlDetails;
      return {
        content: [{ type: "text", text: formatResult({ operation: "communicate", outcome: "agent_exited", targetId: identity.paneId, postState: { agent_status: "unknown" } }) }],
        details
      };
    }

    phase = "confirmation";
    if (located.paneCount !== 1 || located.agentCount !== 1 || !located.agent) {
      fail(operation, key, unconfirmedCode(operation), "Final snapshot does not contain exactly one target pane and agent record", preEvidence, identity, phase, operationIds, dispatchAcknowledged, dispatchAttempted, finalEvidence, {
        wait: waitEvidence!,
        ...failureEvidence,
        targetPaneRecordCount: located.paneCount,
        targetAgentRecordCount: located.agentCount
      });
    }
    finalEvidence = compactEvidence(located.pane);
    let finalIdentity: TurnRecordIdentity;
    try {
      finalIdentity = joinTurnIdentity([located.pane, located.agent], identity.paneId, phase);
      finalEvidence = mergeEvidence([located.pane, located.agent]);
    } catch (error) {
      finalValidationFailed = true;
      throw error;
    }
    if (!sameIdentity(identity, finalIdentity)) fail(operation, key, "TARGET_IDENTITY_CHANGED", "Final target identity changed after turn-control dispatch", preEvidence, identity, phase, operationIds, dispatchAcknowledged, dispatchAttempted, finalEvidence, { wait: waitEvidence!, ...failureEvidence });

    const finalState = finalIdentity.state;
    let afterSeq: number | undefined;
    try {
      afterSeq = stateChangeSeq([located.pane, located.agent], phase);
    } catch (error) {
      finalValidationFailed = true;
      throw error;
    }
    if (!isTerminalState(finalState) || afterSeq === undefined || afterSeq <= beforeSeq) {
      fail(operation, key, unconfirmedCode(operation), "The same agent did not reach a confirmed terminal state", preEvidence, identity, phase, operationIds, dispatchAcknowledged, dispatchAttempted, finalEvidence, { wait: waitEvidence!, ...failureEvidence, finalState });
    }

    const details = {
      ...baseDetails(operation, key, preEvidence, identity, "confirmed", operationIds, dispatchAcknowledged, dispatchAttempted, finalEvidence),
      ...contextRebindingDetails(contextDiagnostics!),
      outcome: operation === "cancel" ? "cancelled" as const : "interrupted" as const,
      finalState: finalEvidence,
      reason: "same_agent_terminal_state",
      confirmation: { kind: "same_agent" as const, state: finalState, stateChangeSeq: { before: beforeSeq, after: afterSeq } },
      wait: waitEvidence!,
      ...failureEvidence
    } as TurnControlDetails;
    return {
      content: [{ type: "text", text: formatResult({ operation: "communicate", outcome: details.outcome, targetId: identity.paneId, postState: { agent_status: finalState } }) }],
      details
    };
  } catch (error) {
    if (error instanceof TurnControlError) {
      if (error.details.preEvidence) throw error;
      if (finalValidationFailed) {
        fail(operation, key, error.code, error.message, preEvidence, identity, phase, operationIds, dispatchAcknowledged, dispatchAttempted, finalEvidence, {
          ...error.details,
          cause: error.details,
          reason: error.message,
          wait: waitEvidence!,
          ...dispatchEvidence(dispatchError)
        });
      }
      throw new TurnControlError(error.code, error.message, {
        ...baseDetails(operation, key, preEvidence, identity, phase, operationIds, dispatchAcknowledged, dispatchAttempted, finalEvidence),
        ...error.details,
        cause: error.details,
        reason: error.message
      });
    }
    const code = errorCode(error) ?? "CLI_PROTOCOL_ERROR";
    /* c8 ignore next -- every expected post-dispatch failure is handled by bounded final verification above. */
    if (dispatchAttempted) {
      fail(operation, key, unconfirmedCode(operation), "Turn-control operation could not be confirmed", preEvidence, identity, phase, operationIds, dispatchAcknowledged, dispatchAttempted, finalEvidence, { wait: waitEvidence!, cause: code });
    }
    throw new TurnControlError(code, errorMessage(error), {
      ...baseDetails(operation, key, preEvidence, identity, phase, operationIds, false, false, finalEvidence),
      ...errorDetails(error),
      reason: errorMessage(error)
    });
  }
}

export const turnControlInternals = {
  bounded,
  boundedOperationId,
  safeString,
  safeInteger,
  errorCode,
  errorMessage,
  errorDetails,
  compactEvidence,
  sessionFrom,
  sessionEvidence,
  hasSessionRepresentation,
  stateFrom,
  stableIdentity,
  sameSession,
  sameIdentity,
  mergedSnapshotAgent,
  snapshotTargetRecords,
  joinTurnIdentity,
  stateChangeSeq,
  mergeEvidence,
  agentGetResult,
  baseDetails,
  boundedSignal,
  isTerminalState,
  hasAgentFields,
  hasCapturedSessionElsewhere,
  isAgentFreeUnknown,
  sameParent,
  finalRecord,
  postWaitDetails,
  dispatchEvidence,
  unconfirmedCode
} as const;
