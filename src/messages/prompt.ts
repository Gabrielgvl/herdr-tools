import { CliProtocolError, type JsonEnvelope } from "../cli.js";

export interface AgentSessionIdentity {
  source: string;
  agent: string;
  kind: string;
  value: string;
}

/** Model-visible identity fields are bounded; internal comparisons retain the full strings. */
export const MODEL_AGENT_SESSION_STRING_LIMIT = 256;

function sessionKey(key: string): boolean {
  const normalized = key.replace(/[_.-]/gu, "").toLowerCase();
  return normalized === "agentsession" || normalized.endsWith("agentsession");
}

export function compactAgentSession(value: AgentSessionIdentity): AgentSessionIdentity {
  return {
    source: value.source.slice(0, MODEL_AGENT_SESSION_STRING_LIMIT),
    agent: value.agent.slice(0, MODEL_AGENT_SESSION_STRING_LIMIT),
    kind: value.kind.slice(0, MODEL_AGENT_SESSION_STRING_LIMIT),
    value: value.value.slice(0, MODEL_AGENT_SESSION_STRING_LIMIT)
  };
}

/**
 * Bound every string in a model-visible identity/protocol diagnostic tree.
 * Error details are copied recursively so cyclic or shared protocol values cannot
 * leak unbounded identity evidence; the live identity records remain untouched.
 */
export function boundAgentSessionStrings<T>(value: T): T {
  const visit = (candidate: unknown, seen: Set<object>): unknown => {
    if (typeof candidate === "string") return candidate.slice(0, MODEL_AGENT_SESSION_STRING_LIMIT);
    if (candidate === null || typeof candidate !== "object") return candidate;
    if (seen.has(candidate)) return "[cyclic]";
    seen.add(candidate);
    try {
      if (Array.isArray(candidate)) return candidate.map((item) => visit(item, seen));
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(candidate)) {
        result[key] = sessionKey(key) && record(item)
          ? compactAgentSession({
            source: typeof item.source === "string" ? item.source : "",
            agent: typeof item.agent === "string" ? item.agent : "",
            kind: typeof item.kind === "string" ? item.kind : "",
            value: typeof item.value === "string" ? item.value : ""
          })
          : visit(item, seen);
      }
      return result;
    } finally {
      seen.delete(candidate);
    }
  };
  return visit(value, new Set<object>()) as T;
}

/** The complete identity that must be bound before a text prompt is submitted. */
export interface PromptTargetIdentity {
  paneId: string;
  terminalId: string;
  agentName: string;
  agentKind: string;
  agentSession: AgentSessionIdentity;
}

export type PromptSubmissionExpectation = PromptTargetIdentity;

export interface PromptSubmissionEvidence extends PromptTargetIdentity {
  confirmed: true;
  operationId: string;
  /** Interactivity was proven; `interactiveProof` records which path established it. */
  interactiveReady: true;
  interactiveProof: "managed" | "detection";
  revision: number;
  stateChangeSeq?: number;
  screenDetectionSkipped?: boolean;
}

export type PromptConsumption = "confirmed" | "unconfirmed";

export interface PromptObservationBaseline {
  state: string;
  stateChangeSeq: number;
  revision: number;
  screenDetectionSkipped?: boolean;
}

export type PromptObservationStatus = "working" | "not_working" | "unknown" | "stale" | "unavailable";

export interface PromptObservation {
  status: PromptObservationStatus;
  state?: string;
  stateChangeSeq?: number;
  revision?: number;
  screenDetectionSkipped?: boolean;
  consumption?: PromptConsumption;
  code?: string;
  /** Bounded identity/state evidence for a replaced or otherwise unusable read. */
  evidence?: Record<string, unknown>;
}

type PromptIdentityErrorCode = "TARGET_IDENTITY_UNAVAILABLE" | "TARGET_IDENTITY_CHANGED";

/** A typed refusal raised before a text delivery when authoritative identity is unsafe. */
export class PromptIdentityError extends Error {
  readonly details: Record<string, unknown>;

  constructor(readonly code: PromptIdentityErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "PromptIdentityError";
    this.details = boundAgentSessionStrings(details);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(value: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function identityString(value: unknown, field: string, source: string): string {
  if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/u.test(value)) {
    throw new PromptIdentityError("TARGET_IDENTITY_UNAVAILABLE", "Authoritative prompt identity is malformed", { field, source });
  }
  return value;
}

function requiredPaneId(value: unknown, expectedPaneId: string, source: string): string {
  const paneId = identityString(value, "pane_id", source);
  if (paneId !== expectedPaneId) {
    throw new PromptIdentityError("TARGET_IDENTITY_CHANGED", "Authoritative prompt identity does not match the target pane", { expectedPaneId, actualPaneId: paneId, source });
  }
  return paneId;
}

/**
 * The single value a record set proves for one field alias group: absent/null
 * fields contribute nothing, and any two supplied values that differ are a
 * contradiction — never merged or averaged.
 */
export function optionalCandidateStrings(records: Record<string, unknown>[], fields: string[], field: string): string | undefined {
  let selected: string | undefined;
  let selectedSource: string | undefined;
  for (const [recordIndex, value] of records.entries()) {
    for (const alias of fields) {
      if (!own(value, alias) || value[alias] === null) continue;
      const candidate = identityString(value[alias], alias, `${field}[${recordIndex}]`);
      if (selected !== undefined && candidate !== selected) {
        throw new PromptIdentityError("TARGET_IDENTITY_CHANGED", "Authoritative prompt identity is contradictory", { field, expected: selected, actual: candidate, source: `${field}[${recordIndex}]`, expectedSource: selectedSource });
      }
      selected ??= candidate;
      selectedSource ??= `${field}[${recordIndex}]`;
    }
  }
  return selected;
}

function candidateStrings(records: Record<string, unknown>[], fields: string[], field: string): string {
  const selected = optionalCandidateStrings(records, fields, field);
  if (selected === undefined) {
    throw new PromptIdentityError("TARGET_IDENTITY_UNAVAILABLE", "Authoritative prompt identity is missing", { field });
  }
  return selected;
}

function sameSession(left: AgentSessionIdentity, right: AgentSessionIdentity): boolean {
  return left.source === right.source && left.agent === right.agent && left.kind === right.kind && left.value === right.value;
}

/**
 * The single native-session candidate a record set proves: absent/null
 * `agent_session` fields contribute nothing, every present session must be a
 * complete `{source,agent,kind,value}`, and any disagreement between records is
 * a contradiction — never merged or averaged.
 */
export function optionalSessionCandidate(records: Record<string, unknown>[]): AgentSessionIdentity | undefined {
  let selected: AgentSessionIdentity | undefined;
  for (const [recordIndex, value] of records.entries()) {
    if (!own(value, "agent_session") || value.agent_session === null) continue;
    const raw = value.agent_session;
    if (!record(raw)) {
      throw new PromptIdentityError("TARGET_IDENTITY_UNAVAILABLE", "Authoritative agent_session is malformed", { field: "agent_session", source: `agent_session[${recordIndex}]` });
    }
    const candidate: AgentSessionIdentity = {
      source: identityString(raw.source, "source", `agent_session[${recordIndex}]`),
      agent: identityString(raw.agent, "agent", `agent_session[${recordIndex}]`),
      kind: identityString(raw.kind, "kind", `agent_session[${recordIndex}]`),
      value: identityString(raw.value, "value", `agent_session[${recordIndex}]`)
    };
    if (selected && !sameSession(selected, candidate)) {
      throw new PromptIdentityError("TARGET_IDENTITY_CHANGED", "Authoritative agent_session is contradictory", { field: "agent_session", expected: selected, actual: candidate });
    }
    selected ??= candidate;
  }
  return selected;
}

function sessionCandidates(records: Record<string, unknown>[]): AgentSessionIdentity {
  const selected = optionalSessionCandidate(records);
  if (!selected) throw new PromptIdentityError("TARGET_IDENTITY_UNAVAILABLE", "Authoritative agent_session is missing", { field: "agent_session" });
  return selected;
}

/**
 * Validate and extract only the identity fields a single record actually supplies.
 * This is intentionally incomplete: launch start envelopes may omit fields while
 * the bounded post-start preflight waits for one coherent fresh sample to supply
 * them. Contradictions within the record still fail immediately.
 */
export function parsePromptTargetIdentityFields(value: unknown, expectedPaneId?: string): Partial<PromptTargetIdentity> {
  if (!record(value)) throw new PromptIdentityError("TARGET_IDENTITY_UNAVAILABLE", "Authoritative prompt identity record is malformed");
  const records = [value];
  const paneId = optionalCandidateStrings(records, ["pane_id"], "pane_id");
  if (paneId !== undefined && expectedPaneId !== undefined && paneId !== expectedPaneId) {
    throw new PromptIdentityError("TARGET_IDENTITY_CHANGED", "Authoritative prompt identity does not match the target pane", { expectedPaneId, actualPaneId: paneId, source: "pane_id[0]" });
  }
  const terminalId = optionalCandidateStrings(records, ["terminal_id"], "terminal_id");
  const agentName = optionalCandidateStrings(records, ["name", "agent_name"], "agent_name");
  const agentKind = optionalCandidateStrings(records, ["agent", "agent_kind", "kind"], "agent_kind");
  const agentSession = optionalSessionCandidate(records);
  if (agentSession && agentKind !== undefined && agentSession.agent !== agentKind) {
    throw new PromptIdentityError("TARGET_IDENTITY_CHANGED", "Authoritative prompt identity is contradictory", { field: "agent_session.agent", expected: agentKind, actual: agentSession.agent });
  }
  return {
    ...(paneId === undefined ? {} : { paneId }),
    ...(terminalId === undefined ? {} : { terminalId }),
    ...(agentName === undefined ? {} : { agentName }),
    ...(agentKind === undefined ? {} : { agentKind }),
    ...(agentSession === undefined ? {} : { agentSession })
  };
}

/**
 * Join the authoritative pane, snapshot-agent, agent-get, and start/ack records.
 * Every complete supplied record must refer to the requested pane; fields may be
 * supplied by different records, but any repeated field must agree exactly.
 * Launch may mark only its first start record as incomplete because Herdr 0.8.2
 * can omit identity fields from that envelope while a bounded fresh sample fills
 * them in.
 */
export function joinPromptTargetIdentity(values: unknown[], expectedPaneId: string, options: { allowIncompleteFirstRecord?: boolean } = {}): PromptTargetIdentity {
  const paneId = identityString(expectedPaneId, "pane_id", "target");
  if (values.length === 0) throw new PromptIdentityError("TARGET_IDENTITY_UNAVAILABLE", "Authoritative prompt identity is missing");
  const records = values.map((value, index) => {
    if (!record(value)) throw new PromptIdentityError("TARGET_IDENTITY_UNAVAILABLE", "Authoritative prompt identity record is malformed", { source: `record[${index}]` });
    if (options.allowIncompleteFirstRecord === true && index === 0) {
      parsePromptTargetIdentityFields(value, paneId);
    } else {
      requiredPaneId(value.pane_id, paneId, `record[${index}]`);
    }
    return value;
  });
  const terminalId = candidateStrings(records, ["terminal_id"], "terminal_id");
  const agentName = candidateStrings(records, ["name", "agent_name"], "agent_name");
  const agentKind = candidateStrings(records, ["agent", "agent_kind", "kind"], "agent_kind");
  const agentSession = sessionCandidates(records);
  if (agentSession.agent !== agentKind) {
    throw new PromptIdentityError("TARGET_IDENTITY_CHANGED", "Authoritative prompt identity is contradictory", { field: "agent_session.agent", expected: agentKind, actual: agentSession.agent });
  }
  return { paneId, terminalId, agentName, agentKind, agentSession };
}

export function requirePromptTargetIdentity(values: unknown[], expectedPaneId: string): PromptTargetIdentity {
  // Evidence records are intentionally joined as a set. Herdr pane records may
  // omit agent_name while the paired agent record supplies it; validating each
  // record as a complete identity would reject that protocol-realistic shape.
  return joinPromptTargetIdentity(values, expectedPaneId);
}

export function samePromptTargetIdentity(left: PromptTargetIdentity, right: PromptTargetIdentity): boolean {
  return left.paneId === right.paneId
    && left.terminalId === right.terminalId
    && left.agentName === right.agentName
    && left.agentKind === right.agentKind
    && sameSession(left.agentSession, right.agentSession);
}

/** The identity retained in tool details, without weakening the internal identity. */
export function compactPromptTargetIdentity(identity: PromptTargetIdentity): PromptTargetIdentity {
  return {
    paneId: identity.paneId.slice(0, MODEL_AGENT_SESSION_STRING_LIMIT),
    terminalId: identity.terminalId.slice(0, MODEL_AGENT_SESSION_STRING_LIMIT),
    agentName: identity.agentName.slice(0, MODEL_AGENT_SESSION_STRING_LIMIT),
    agentKind: identity.agentKind.slice(0, MODEL_AGENT_SESSION_STRING_LIMIT),
    agentSession: compactAgentSession(identity.agentSession)
  };
}

export function compactPromptSubmission(submission: PromptSubmissionEvidence): PromptSubmissionEvidence {
  return {
    ...submission,
    ...compactPromptTargetIdentity(submission)
  };
}

function compactIdentityRecord(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of ["pane_id", "terminal_id", "name", "agent_name", "agent", "agent_kind", "kind", "agent_status", "revision", "state_change_seq", "interactive_ready", "screen_detection_skipped"] as const) {
    const candidate = value[field];
    if (candidate === undefined) continue;
    result[field] = typeof candidate === "string" ? candidate.slice(0, MODEL_AGENT_SESSION_STRING_LIMIT) : candidate;
  }
  if (record(value.agent_session)) result.agent_session = compactAgentSession({
    source: typeof value.agent_session.source === "string" ? value.agent_session.source : "",
    agent: typeof value.agent_session.agent === "string" ? value.agent_session.agent : "",
    kind: typeof value.agent_session.kind === "string" ? value.agent_session.kind : "",
    value: typeof value.agent_session.value === "string" ? value.agent_session.value : ""
  });
  return result;
}

function boundedObservationEvidence(records: Record<string, unknown>[]): Record<string, unknown> {
  return { records: records.map(compactIdentityRecord) };
}

function optionalSafeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new CliProtocolError("CLI_PROTOCOL_ERROR", "Herdr prompt acknowledgement contains an invalid authoritative counter", { field });
  }
  return value;
}

function promptProtocolError(message: string, details: Record<string, unknown> = {}): never {
  throw new CliProtocolError("CLI_PROTOCOL_ERROR", message, boundAgentSessionStrings(details));
}

/**
 * Detected lifecycle states that prove a live interactive agent when the
 * managed-only `interactive_ready` flag is absent from an acknowledgement.
 * `unknown` is absent: detection reporting nothing proves nothing.
 */
const DETECTED_LIVE_STATES = new Set(["idle", "working", "blocked", "done"]);

/**
 * A successful prompt request is only a delivery acknowledgement when Herdr
 * returns its typed prompt envelope and the returned process identity is exactly
 * the one captured before submission. The socket owns request correlation; this
 * parser retains the actual correlated ID rather than inventing a CLI operation
 * ID. No terminal text or sender-authored body is retained.
 */
export function parsePromptSubmission(response: JsonEnvelope, expected: PromptSubmissionExpectation, expectedRequestId?: string): PromptSubmissionEvidence {
  if (typeof response.id !== "string"
    || response.id.length === 0
    || /[\0\r\n]/u.test(response.id)
    || (expectedRequestId !== undefined && response.id !== expectedRequestId)
    || !record(response.result)
    || response.result.type !== "agent_prompted"
    || !record(response.result.agent)) {
    promptProtocolError("Herdr prompt acknowledgement is incompatible");
  }
  const agent = response.result.agent;
  let identity: PromptTargetIdentity;
  try {
    identity = joinPromptTargetIdentity([agent], expected.paneId);
  } catch (error) {
    const identityError = error as PromptIdentityError;
    promptProtocolError(
      identityError.code === "TARGET_IDENTITY_CHANGED"
        ? "Herdr prompt acknowledgement does not match the captured target identity"
        : "Herdr prompt acknowledgement does not contain a complete authoritative identity",
      { causeCode: identityError.code, ...identityError.details }
    );
  }
  if (!samePromptTargetIdentity(identity, expected)) {
    promptProtocolError("Herdr prompt acknowledgement does not match the captured target identity", {
      expectedPaneId: expected.paneId,
      actualPaneId: identity.paneId,
      expectedTerminalId: expected.terminalId,
      actualTerminalId: identity.terminalId,
      expectedName: expected.agentName,
      actualName: identity.agentName,
      expectedKind: expected.agentKind,
      actualKind: identity.agentKind,
      expectedAgentSession: expected.agentSession,
      actualAgentSession: identity.agentSession
    });
  }
  // `interactive_ready` is managed-agent proof: only `agent start` or a restore
  // marks a launched agent Active, so detection — including an adopted pane —
  // can never emit it. When the flag is absent, the acknowledgement still proves
  // interactivity through detection itself: the server verified the pane's
  // foreground process hosts the detected agent before accepting the write, and
  // `agent_status` is a required field on every AgentInfo, so a known non-unknown
  // lifecycle state is that proof. `launch_pending` marks the one intermediate
  // shape — a managed agent started but not yet interactive — so the detection
  // branch admits only a proven-false or absent value; anything malformed is
  // terminal. The managed branch never consults it: a contradictory
  // `interactive_ready:true` + `launch_pending:true` still returns "managed"
  // because the explicit flag is the stronger, server-owned signal. An explicit
  // `false` — never serialized today — or an absent/unknown status stays
  // fail-closed.
  const interactiveProof = agent.interactive_ready === true
    ? "managed" as const
    : agent.interactive_ready === undefined && (agent.launch_pending === undefined || agent.launch_pending === false) && typeof agent.agent_status === "string" && DETECTED_LIVE_STATES.has(agent.agent_status)
      ? "detection" as const
      : undefined;
  if (interactiveProof === undefined) {
    promptProtocolError("Herdr prompt acknowledgement did not prove an interactive target", { interactiveReady: agent.interactive_ready, agentStatus: agent.agent_status });
  }
  const revision = optionalSafeInteger(agent.revision, "revision");
  if (revision === undefined) {
    promptProtocolError("Herdr prompt acknowledgement omitted the authoritative revision", { field: "revision" });
  }
  const stateChangeSeq = optionalSafeInteger(agent.state_change_seq, "state_change_seq");
  // Screen detection is best-effort diagnostic metadata. A malformed flag cannot
  // validate or invalidate the acknowledgement; retain it only when it is safe.
  const screenDetectionSkipped = typeof agent.screen_detection_skipped === "boolean" ? agent.screen_detection_skipped : undefined;
  return {
    confirmed: true,
    operationId: response.id,
    ...identity,
    interactiveReady: true,
    interactiveProof,
    revision,
    ...(stateChangeSeq === undefined ? {} : { stateChangeSeq }),
    ...(screenDetectionSkipped === undefined ? {} : { screenDetectionSkipped })
  };
}

const KNOWN_PROMPT_STATES = new Set(["idle", "working", "blocked", "done", "unknown"]);

interface PromptLifecycleValues {
  state?: string;
  stateChangeSeq?: number;
  revision?: number;
  screenDetectionSkipped?: boolean;
  invalid: boolean;
}

/**
 * Read one coherent lifecycle tuple. Agent-get is the only authoritative source
 * for these fields; pane-get is intentionally excluded from scalar selection.
 */
function promptLifecycle(value: Record<string, unknown>): PromptLifecycleValues {
  const rawState = value.agent_status;
  const state = typeof rawState === "string" && KNOWN_PROMPT_STATES.has(rawState) ? rawState : undefined;
  const rawStateChangeSeq = value.state_change_seq;
  const stateChangeSeq = typeof rawStateChangeSeq === "number" && Number.isSafeInteger(rawStateChangeSeq) && rawStateChangeSeq >= 0 ? rawStateChangeSeq : undefined;
  const rawRevision = value.revision;
  const revision = typeof rawRevision === "number" && Number.isSafeInteger(rawRevision) && rawRevision >= 0 ? rawRevision : undefined;
  const screenDetectionSkipped = typeof value.screen_detection_skipped === "boolean" ? value.screen_detection_skipped : undefined;
  return {
    ...(state === undefined ? {} : { state }),
    ...(stateChangeSeq === undefined ? {} : { stateChangeSeq }),
    ...(revision === undefined ? {} : { revision }),
    ...(screenDetectionSkipped === undefined ? {} : { screenDetectionSkipped }),
    invalid: (rawState !== undefined && rawState !== null && state === undefined)
      || (rawStateChangeSeq !== undefined && rawStateChangeSeq !== null && stateChangeSeq === undefined)
      || (rawRevision !== undefined && rawRevision !== null && revision === undefined)
  };
}

/** Capture the exact idle agent-get lifecycle tuple used as the pre-submit baseline. */
export function capturePromptObservationBaseline(agentState: Record<string, unknown>, identity: PromptTargetIdentity): PromptObservationBaseline {
  // Baseline identity and lifecycle must be complete in this one authoritative
  // agent-get record. Neither start nor pane fields may fill an omission.
  const observedIdentity = requirePromptTargetIdentity([agentState], identity.paneId);
  if (!samePromptTargetIdentity(observedIdentity, identity)) {
    throw new PromptIdentityError("TARGET_IDENTITY_CHANGED", "Prompt observation baseline identity changed", { evidence: boundedObservationEvidence([agentState]) });
  }
  const values = promptLifecycle(agentState);
  if (values.invalid || values.state !== "idle" || values.stateChangeSeq === undefined || values.revision === undefined) {
    throw new PromptIdentityError("TARGET_IDENTITY_UNAVAILABLE", "Prompt observation baseline must be one complete idle agent-get lifecycle tuple", {
      evidence: boundedObservationEvidence([agentState])
    });
  }
  return {
    state: values.state,
    stateChangeSeq: values.stateChangeSeq,
    revision: values.revision,
    ...(values.screenDetectionSkipped === undefined ? {} : { screenDetectionSkipped: values.screenDetectionSkipped })
  };
}

/**
 * Classify one agent-get observation after a confirmed submission. Optional
 * continuity records prove pane identity only; their lifecycle fields are never
 * merged with or compared against the authoritative agent-get tuple.
 */
export function classifyPromptObservation(
  agentState: Record<string, unknown>,
  submission: PromptSubmissionEvidence,
  baseline?: PromptObservationBaseline,
  identityContinuity: Record<string, unknown>[] = []
): PromptObservation {
  const records = [agentState, ...identityContinuity];
  const evidence = boundedObservationEvidence(records);
  let identity: PromptTargetIdentity;
  try {
    // Requiring the complete agent-get identity first prevents continuity records
    // from filling it. The second join can only preserve that identity or throw on
    // a contradictory pane record.
    requirePromptTargetIdentity([agentState], submission.paneId);
    identity = requirePromptTargetIdentity(records, submission.paneId);
  } catch (error) {
    const identityError = error as PromptIdentityError;
    return {
      status: "unavailable",
      code: `POSTSTATE_${identityError.code === "TARGET_IDENTITY_CHANGED" ? "IDENTITY_CHANGED" : "IDENTITY_UNAVAILABLE"}`,
      ...(identityError.code === "TARGET_IDENTITY_CHANGED" ? { evidence } : {}),
      ...(baseline === undefined ? {} : { consumption: "unconfirmed" })
    };
  }
  if (!samePromptTargetIdentity(identity, submission)) {
    return { status: "unavailable", code: "POSTSTATE_IDENTITY_CHANGED", evidence, ...(baseline === undefined ? {} : { consumption: "unconfirmed" }) };
  }
  const values = promptLifecycle(agentState);
  const diagnosticSkipped = values.screenDetectionSkipped ?? submission.screenDetectionSkipped;
  const common = {
    ...(values.state === undefined ? {} : { state: values.state }),
    ...(values.stateChangeSeq === undefined ? {} : { stateChangeSeq: values.stateChangeSeq }),
    ...(values.revision === undefined ? {} : { revision: values.revision }),
    ...(diagnosticSkipped === undefined ? {} : { screenDetectionSkipped: diagnosticSkipped })
  };
  if (values.invalid) {
    return { status: "unavailable", code: "POSTSTATE_CONTRADICTORY", evidence, ...common, ...(baseline === undefined ? {} : { consumption: "unconfirmed" }) };
  }
  if (values.state === undefined) {
    return { status: "unavailable", code: "POSTSTATE_UNAVAILABLE", ...common, ...(baseline === undefined ? {} : { consumption: "unconfirmed" }) };
  }
  const minimumRevision = baseline === undefined ? submission.revision : Math.max(submission.revision, baseline.revision);
  if (values.revision !== undefined && values.revision < minimumRevision) {
    return { status: "stale", ...common, ...(baseline === undefined ? {} : { consumption: "unconfirmed" }) };
  }
  const status: PromptObservationStatus = values.state === "working"
    ? "working"
    : values.state === "unknown"
      ? "unknown"
      : "not_working";
  if (baseline === undefined) return { status, ...common };
  const confirmed = status !== "unknown"
    && values.stateChangeSeq !== undefined
    && values.stateChangeSeq > baseline.stateChangeSeq
    && values.revision !== undefined
    && values.revision >= minimumRevision;
  return { status, ...common, consumption: confirmed ? "confirmed" : "unconfirmed" };
}

export function unavailablePromptObservation(error: unknown): PromptObservation {
  const code = record(error) && typeof error.code === "string" ? error.code : "POSTSTATE_UNAVAILABLE";
  return { status: "unavailable", code };
}
