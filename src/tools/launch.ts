import type { AgentToolUpdateCallback, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { boundedEvidence, CliProtocolError, HERDR_AGENT_START_TIMEOUT_MS, type HerdrErrorEnvelope, type JsonEnvelope } from "../cli.js";
import type { CompatibilityPreflight } from "../health.js";
import { withDeliveryFailureEvidence } from "../messages/failure.js";
import { assertDeliverySize, assertMessageText, type MessageDelivery } from "../messages/limits.js";
import { boundAgentSessionStrings, classifyPromptObservation, compactPromptSubmission, parsePromptSubmission, parsePromptTargetIdentityFields, type PromptConsumption, type PromptIdentityError, type PromptObservation, type PromptObservationBaseline, type PromptSubmissionEvidence, type PromptTargetIdentity } from "../messages/prompt.js";
import { defaultAttachmentStore, type AttachmentStore, type PublishedAttachment, type RecipientGrant } from "../messages/store.js";
import { mintRecipientKey, type RecipientRegistry } from "../messages/recipients.js";
import { attachmentCapability } from "../profiles/capability.js";
import { buildEnvelope, resolveSender, type SenderIdentity } from "../provenance.js";
import type { CurrentContext, HerdrSnapshot, ResolvedTarget } from "../targets.js";
import { assertCurrentContext, parseSnapshotResult, resolveTarget } from "../targets.js";
import { formatCall, formatResult, renderResultComponent, textComponent } from "../tui.js";
import { LaunchParamsSchema, type LaunchPlacement, type LaunchRequest } from "../launch-schema.js";
import { buildRuntimeArgv, defaultPromptSourceStore, resolveProfile, resolveProfileRuntime, type Profile, type ProfileCatalog, type ProfileResolution, type PromptSourceStore } from "../profiles/index.js";
import { CLAUDE_EFFORTS, CLAUDE_PERMISSION_MODES, THINKING_LEVELS, type RuntimeProfile } from "../profiles/types.js";
import { withoutEnvironment } from "../redaction.js";

export interface LaunchCli {
  runJson(argv: string[], signal: AbortSignal, preserveCompletedMutation?: boolean): Promise<JsonEnvelope>;
  runJsonWithStdin?(argv: string[], input: string, signal: AbortSignal, preserveCompletedMutation?: boolean): Promise<JsonEnvelope>;
}

export interface LaunchResourceRegistry {
  record(resource: { kind: "pane" | "tab"; id: string; parentId?: string }): void;
  has?(resource: { kind: "pane" | "tab"; id: string }): boolean;
}

export interface LaunchClock {
  /** Monotonic milliseconds. */
  now(): number;
}

export interface LaunchDependencies {
  cli: LaunchCli;
  context: CurrentContext;
  preflight: CompatibilityPreflight;
  cwd?: string;
  ownership?: LaunchResourceRegistry;
  profiles?: { load: () => Promise<ProfileCatalog> };
  promptSources?: PromptSourceStore;
  attachments?: AttachmentStore;
  recipients?: RecipientRegistry;
  clock?: LaunchClock;
}

export interface LaunchResourceIds {
  tabId?: string;
  paneId?: string;
  agentId?: string;
}

export interface LaunchAttemptEvidence {
  profile: string;
  outcome: "selected" | "agent_start_failed" | "fallback_refused";
  errorCode?: string;
  message?: string;
  postState?: Record<string, unknown>;
}

export interface LaunchEffectiveProfile {
  requested: string;
  selected: string;
  source: { kind: string; path: string };
  timeoutMinutes: number;
  runtime: Record<string, unknown>;
  permissions: Record<string, unknown>;
  attempts: LaunchAttemptEvidence[];
  fallbackProfiles: string[];
  reachableNames: string[];
}

export interface LaunchReadinessEvidence {
  budgetBasis: "immediately_before_selected_agent_start";
  budgetMs: number;
  pollIntervalMs: number;
  elapsedMs: number;
  samples: number;
  lastPendingReason?: string;
  records: Record<string, unknown>[];
  baselineRequired: boolean;
}

export interface PromptConfirmationEvidence {
  timeoutMs: number;
  pollIntervalMs: number;
  elapsedMs: number;
  samples: number;
  reason: "working" | "state_change_seq_advanced" | "timeout" | "caller_aborted" | "identity_changed" | "identity_unavailable" | "contradictory" | "read_failed";
  baseline: PromptObservationBaseline;
  last?: Pick<PromptObservation, "status" | "state" | "stateChangeSeq" | "revision" | "screenDetectionSkipped" | "code">;
  sourceCode?: string;
}

export interface LaunchTimingEvidence {
  selectedStartReadinessMs?: number;
  promptSubmissionAckMs?: number;
  postAckConfirmationMs?: number;
}

export interface LaunchDetails extends LaunchResourceIds {
  operation: "launch";
  outcome: "launched" | "partial";
  name?: string;
  kind?: string;
  placement?: LaunchPlacement;
  postState?: Record<string, unknown>;
  agentStarted?: boolean;
  initialPromptSent?: boolean;
  promptSubmitted?: boolean;
  recipientRegistered?: boolean;
  promptConsumption?: PromptConsumption;
  initialPromptDelivery?: MessageDelivery;
  initialPromptSubmission?: PromptSubmissionEvidence;
  initialPromptObservation?: PromptObservation;
  readiness?: LaunchReadinessEvidence;
  promptConfirmation?: PromptConfirmationEvidence;
  timing?: LaunchTimingEvidence;
  phase?: "validate" | "resolve_profile" | "attachment_publish" | "placement" | "agent_start" | "ready" | "focus" | "prompt_verification";
  created?: LaunchResourceIds;
  causeCode?: string;
  sender?: { paneId: string; display: string; source: SenderIdentity["source"] };
  envelope?: { version: "v1"; kind: "assignment"; delivery: MessageDelivery };
  attachment?: PublishedAttachment;
  recipient?: { recipientKey: string; paneId: string; agentName: string; agentId?: string; profileName: string; kind: "pi" | "claude"; capable: boolean; reason: string };
  profile?: LaunchEffectiveProfile & { name: string; sessionPersistence: boolean };
}

const LAUNCH_READINESS_POLL_INTERVAL_MS = 100;
const PROMPT_CONFIRMATION_TIMEOUT_MS = 5_000;
const PROMPT_CONFIRMATION_POLL_INTERVAL_MS = 100;
const realLaunchClock: LaunchClock = { now: () => performance.now() };

class LaunchError extends Error {
  readonly details: Record<string, unknown>;

  constructor(readonly code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "LaunchError";
    this.details = boundAgentSessionStrings(details);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identifier(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/.test(value)) {
    throw new LaunchError("INVALID_INPUT", `${field} must be a non-empty single identifier`);
  }
}

function profileIdentifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)) {
    throw new LaunchError("INVALID_INPUT", "profile must be lowercase kebab-case");
  }
}

function validateParams(params: LaunchRequest): void {
  if (!record(params)) throw new LaunchError("INVALID_INPUT", "launch parameters must be an object");
  if (typeof params.name !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(params.name)) {
    throw new LaunchError("INVALID_INPUT", "name must start with a lowercase letter and contain only lowercase letters, digits, - or _ (1-32 characters)");
  }
  const allowedKeys = new Set(["name", "profile", "overrides", "placement", "label", "cwd", "focus", "initialPrompt", "initialPromptDelivery"]);
  for (const key of Object.keys(params)) if (!allowedKeys.has(key)) throw new LaunchError("INVALID_INPUT", `Unknown launch field: ${key}`);
  profileIdentifier(params.profile);
  if (params.overrides !== undefined) {
    if (!record(params.overrides)) throw new LaunchError("INVALID_INPUT", "profile overrides must be an object");
    for (const key of Object.keys(params.overrides)) if (!["model", "thinking", "effort", "tools", "extensions", "skills", "permissionMode", "allowedTools", "disallowedTools", "addDirs", "pluginDirs"].includes(key)) throw new LaunchError("INVALID_INPUT", `Unknown profile override: ${key}`);
    if (params.overrides.model !== undefined) identifier(params.overrides.model, "overrides.model");
    if (params.overrides.thinking !== undefined && (typeof params.overrides.thinking !== "string" || !THINKING_LEVELS.includes(params.overrides.thinking as typeof THINKING_LEVELS[number]))) throw new LaunchError("INVALID_INPUT", "overrides.thinking is invalid");
    if (params.overrides.effort !== undefined && (typeof params.overrides.effort !== "string" || !CLAUDE_EFFORTS.includes(params.overrides.effort as typeof CLAUDE_EFFORTS[number]))) throw new LaunchError("INVALID_INPUT", "overrides.effort is invalid");
    if (params.overrides.permissionMode !== undefined && (typeof params.overrides.permissionMode !== "string" || !CLAUDE_PERMISSION_MODES.includes(params.overrides.permissionMode as typeof CLAUDE_PERMISSION_MODES[number]))) throw new LaunchError("INVALID_INPUT", "overrides.permissionMode is invalid");
    for (const key of ["tools", "extensions", "skills", "allowedTools", "disallowedTools", "addDirs", "pluginDirs"] as const) {
      const value = params.overrides[key];
      if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0 || /[\0\r\n]/.test(item)))) throw new LaunchError("INVALID_INPUT", `overrides.${key} must be non-empty strings without NUL or newlines`);
    }
  }
  if (params.label !== undefined) identifier(params.label, "label");
  if (params.cwd !== undefined) identifier(params.cwd, "cwd");
  if (params.initialPrompt !== undefined && (typeof params.initialPrompt !== "string" || params.initialPrompt.length === 0 || /\0/.test(params.initialPrompt))) {
    throw new LaunchError("INVALID_INPUT", "initialPrompt must be a non-empty string without NUL");
  }
  if (params.initialPromptDelivery !== undefined && params.initialPromptDelivery !== "inline" && params.initialPromptDelivery !== "attachment") {
    throw new LaunchError("INVALID_INPUT", "initialPromptDelivery must be inline or attachment");
  }
  if (params.initialPrompt === undefined && params.initialPromptDelivery !== undefined) {
    throw new LaunchError("INVALID_INPUT", "initialPromptDelivery requires initialPrompt");
  }
  if (params.focus !== undefined && typeof params.focus !== "boolean") throw new LaunchError("INVALID_INPUT", "focus must be a boolean");
  const placement = params.placement;
  if (placement === undefined) return;
  if (!record(placement) || typeof placement.mode !== "string") throw new LaunchError("INVALID_INPUT", "placement is invalid");
  if (placement.mode === "same_tab") {
    if (Object.keys(placement).length !== 1) throw new LaunchError("INVALID_INPUT", "same_tab placement has no additional fields");
  } else if (placement.mode === "new_tab") {
    identifier(placement.tabLabel, "placement.tabLabel");
    if (Object.keys(placement).some((key) => key !== "mode" && key !== "tabLabel")) throw new LaunchError("INVALID_INPUT", "new_tab placement has unknown fields");
  } else if (placement.mode === "existing_pane") {
    identifier(placement.target, "placement.target");
    if (Object.keys(placement).some((key) => key !== "mode" && key !== "target")) throw new LaunchError("INVALID_INPUT", "existing_pane placement has unknown fields");
  } else {
    throw new LaunchError("INVALID_INPUT", "Unsupported placement mode");
  }
}

function paneRecord(value: unknown, expectedPaneId: string): Record<string, unknown> {
  if (!record(value) || !record(value.pane)) throw new LaunchError("CLI_PROTOCOL_ERROR", "Herdr did not return a pane post-state");
  const pane = value.pane;
  const actualPaneId = idFrom(pane, "pane_id");
  if (actualPaneId !== expectedPaneId) {
    throw new LaunchError("POSTSTATE_UNAVAILABLE", "Herdr pane post-state does not match the resolved pane", { expectedPaneId, actualPaneId });
  }
  return pane;
}

function agentGetRecord(value: unknown): Record<string, unknown> {
  if (!record(value) || !record(value.agent)) throw new LaunchError("TARGET_IDENTITY_UNAVAILABLE", "Fresh Herdr agent identity is unavailable");
  return value.agent;
}

interface StartedAgent {
  /** Only identity fields actually supplied by agent_started are joined later. */
  startRecord: Record<string, unknown>;
  agentId?: string;
}

function agentIdentity(value: unknown, expectedName: string, expectedPaneId: string, expectedKind: string): StartedAgent {
  if (!record(value)) throw new LaunchError("CLI_PROTOCOL_ERROR", "Herdr agent-start response is incompatible");
  const hasAgentField = Object.prototype.hasOwnProperty.call(value, "agent");
  let agent: unknown = value;
  if (hasAgentField) {
    if (record(value.agent)) agent = value.agent;
    else if (typeof value.agent !== "string") agent = undefined;
  }
  if (!record(agent)) throw new LaunchError("CLI_PROTOCOL_ERROR", "Herdr agent-start response omitted the authoritative agent record");
  // Start lifecycle values describe an earlier process-start observation. Their
  // shapes are authoritative enough to validate, but their values never anchor or
  // overwrite a later coherent readiness sample.
  readinessLifecycle(agent, "agent_start");
  let fields: Partial<PromptTargetIdentity>;
  try {
    // Herdr 0.8.2 can omit identity fields from agent_started. Validate every
    // field it does supply now, but let bounded fresh coherent polling samples
    // fill only the missing fields. No expected value is fabricated into startRecord.
    fields = parsePromptTargetIdentityFields(agent, expectedPaneId);
  } catch (error) {
    const identityError = error as PromptIdentityError;
    throw new LaunchError(identityError.code, "Herdr agent-start response contains an unusable identity field", identityError.details);
  }
  const actualName = fields.agentName;
  const actualKind = fields.agentKind ?? fields.agentSession?.agent;
  if ((actualName !== undefined && actualName !== expectedName) || (actualKind !== undefined && actualKind !== expectedKind)) {
    throw new LaunchError("CLI_PROTOCOL_ERROR", "Herdr agent-start response does not match the requested identity", { expectedName, ...(actualName === undefined ? {} : { actualName }), expectedPaneId, ...(fields.paneId === undefined ? {} : { actualPaneId: fields.paneId }), expectedKind, ...(actualKind === undefined ? {} : { actualKind }) });
  }
  const agentId = idFrom(agent, "agent_id") ?? idFrom(agent, "id");
  return { startRecord: agent, ...(agentId ? { agentId } : {}) };
}

function idFrom(value: unknown, field: string): string | undefined {
  if (!record(value)) return undefined;
  const candidate = value[field];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function paneRefFrom(result: unknown): LaunchResourceIds {
  if (!record(result)) throw new LaunchError("CLI_PROTOCOL_ERROR", "Herdr placement response is incompatible");
  const candidates = [result.pane, result.root_pane, result.rootPane, result.new_pane, result.child_pane, result.created_pane, result];
  for (const candidate of candidates) {
    const paneId = idFrom(candidate, "pane_id");
    if (paneId) return { paneId, tabId: idFrom(candidate, "tab_id") };
  }
  throw new LaunchError("CLI_PROTOCOL_ERROR", "Herdr placement response omitted the authoritative pane ID");
}

function tabRefFrom(result: unknown): { tabId: string; paneId?: string } {
  if (!record(result)) throw new LaunchError("CLI_PROTOCOL_ERROR", "Herdr tab response is incompatible");
  const tab = record(result.tab) ? result.tab : result;
  const tabId = idFrom(tab, "tab_id");
  if (!tabId) throw new LaunchError("CLI_PROTOCOL_ERROR", "Herdr tab response omitted the authoritative tab ID");
  const pane = result.pane ?? result.root_pane ?? result.rootPane ?? (tab as Record<string, unknown>).pane;
  const paneId = idFrom(pane, "pane_id");
  return { tabId, paneId };
}

function noAgentFromPane(pane: Record<string, unknown>): boolean {
  const agentFields = ["agent", "agent_name", "display_agent", "agent_id", "agent_session", "agent_session_id", "agent_terminal_id", "agent_process_id", "agent_kind", "managed_kind", "session_id", "kind"];
  return pane.agent_status === "unknown" && agentFields.every((field) => pane[field] === undefined || pane[field] === null);
}

function compactAttemptState(pane: Record<string, unknown>): Record<string, unknown> {
  const result = Object.fromEntries(["pane_id", "tab_id", "workspace_id", "agent_id", "agent_name", "name", "agent_kind", "agent", "kind", "agent_status", "state_change_seq", "status"].flatMap((field): Array<[string, unknown]> => {
    const value = pane[field];
    if (value === undefined) return [];
    if (typeof value === "string") return [[field, value.slice(0, 256)]];
    if (typeof value === "number" || typeof value === "boolean" || value === null) return [[field, value]];
    return [];
  }));
  const session = pane.agent_session;
  if (record(session) && ["source", "agent", "kind", "value"].every((field) => typeof session[field] === "string")) {
    result.agent_session = {
      source: (session.source as string).slice(0, 256),
      agent: (session.agent as string).slice(0, 256),
      kind: (session.kind as string).slice(0, 256),
      value: (session.value as string).slice(0, 256)
    };
  }
  return result;
}

function cliErrorEnvelope(error: unknown): HerdrErrorEnvelope | undefined {
  if (!(error instanceof CliProtocolError) || !record(error.details.errorEnvelope)) return undefined;
  const envelope = error.details.errorEnvelope;
  if (typeof envelope.id !== "string" || !record(envelope.error)) return undefined;
  const { code, message } = envelope.error;
  if (typeof code !== "string" || typeof message !== "string") return undefined;
  return { id: envelope.id, error: { code, message } };
}

function startFailureEvidence(error: unknown): { code: string; message: string } | undefined {
  if (!(error instanceof CliProtocolError)) return undefined;
  const { exitCode, killed, errorStream, stderrTruncated } = error.details;
  if (error.code !== "CLI_PROTOCOL_ERROR" || exitCode !== 1 || killed !== false || errorStream !== "stderr" || stderrTruncated !== false) return undefined;
  const envelope = cliErrorEnvelope(error);
  if (!envelope || envelope.id !== "cli:agent:start") return undefined;
  if (envelope.error.code !== "agent_start_failed" || envelope.error.message !== "agent process exited before becoming interactive") return undefined;
  return { ...envelope.error };
}

function effectiveDetails(profile: Profile, runtime: RuntimeProfile): { runtime: Record<string, unknown>; permissions: Record<string, unknown> } {
  return runtime.kind === "pi"
    ? {
      runtime: { kind: "pi", model: runtime.model, thinking: runtime.thinking },
      permissions: { sessionPersistence: profile.sessionPersistence, tools: [...runtime.tools], extensions: [...runtime.extensions], skills: [...runtime.skills] }
    }
    : {
      runtime: { kind: "claude", model: runtime.model, effort: runtime.effort },
      permissions: { sessionPersistence: profile.sessionPersistence, permissionMode: runtime.permissionMode, allowedTools: [...runtime.allowedTools], disallowedTools: [...runtime.disallowedTools], addDirs: [...runtime.addDirs], pluginDirs: [...runtime.pluginDirs] }
    };
}

function snapshotOf(result: unknown): HerdrSnapshot {
  return parseSnapshotResult(result);
}

interface ReadinessRecord {
  source: "snapshot_pane" | "snapshot_agent" | "agent_get" | "pane_get";
  value: Record<string, unknown>;
}

interface LaunchReadinessResult {
  identity: PromptTargetIdentity;
  agent: Record<string, unknown>;
  pane: Record<string, unknown>;
  baseline?: PromptObservationBaseline;
  evidence: LaunchReadinessEvidence;
}

const READINESS_RECORD_LIMIT = 4;
const READINESS_MALFORMED = "[malformed]";
const READINESS_SESSION_MISSING = "[missing]";

function readinessScalar(value: unknown): string | number | boolean | null {
  if (typeof value === "string") return value.slice(0, 256);
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "boolean" || value === null) return value;
  return READINESS_MALFORMED;
}

function readinessSessionField(value: unknown): string {
  if (typeof value === "string") return value.slice(0, 256);
  return value === undefined ? READINESS_SESSION_MISSING : READINESS_MALFORMED;
}

function ownReadinessSessionField(value: Record<string, unknown>, field: "source" | "agent" | "kind" | "value"): string {
  return readinessSessionField(own(value, field) ? value[field] : undefined);
}

function compactIdentityRecord(value: Record<string, unknown>, source: ReadinessRecord["source"]): Record<string, unknown> {
  const result: Record<string, unknown> = { source };
  for (const field of ["pane_id", "terminal_id", "name", "agent_name", "agent", "agent_kind", "kind", "agent_status", "revision", "state_change_seq", "interactive_ready", "screen_detection_skipped"] as const) {
    if (!own(value, field)) continue;
    result[field] = readinessScalar(value[field]);
  }
  if (own(value, "agent_session")) {
    const session = value.agent_session;
    result.agent_session = record(session)
      ? {
        source: ownReadinessSessionField(session, "source"),
        agent: ownReadinessSessionField(session, "agent"),
        kind: ownReadinessSessionField(session, "kind"),
        value: ownReadinessSessionField(session, "value")
      }
      : readinessScalar(session);
  }
  return result;
}

function compactReadinessRecords(values: ReadinessRecord[]): Record<string, unknown>[] {
  return values.slice(0, READINESS_RECORD_LIMIT).map(({ source, value }) => compactIdentityRecord(value, source));
}

function own(value: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function sameSession(left: PromptTargetIdentity["agentSession"], right: PromptTargetIdentity["agentSession"]): boolean {
  return left.source === right.source && left.agent === right.agent && left.kind === right.kind && left.value === right.value;
}

function mergeReadinessIdentity(records: Record<string, unknown>[], paneId: string): Partial<PromptTargetIdentity> {
  const selected: Partial<PromptTargetIdentity> = {};
  for (const value of records) {
    let fields: Partial<PromptTargetIdentity>;
    try {
      fields = parsePromptTargetIdentityFields(value, paneId);
    } catch (error) {
      const identityError = error as PromptIdentityError;
      throw new LaunchError(identityError.code, "Launch readiness identity evidence is malformed or contradictory", identityError.details);
    }
    for (const field of ["paneId", "terminalId", "agentName", "agentKind"] as const) {
      const candidate = fields[field];
      const current = selected[field];
      if (candidate !== undefined && current !== undefined && candidate !== current) {
        throw new LaunchError("TARGET_IDENTITY_CHANGED", "Launch readiness identity evidence is contradictory", { field, expected: current, actual: candidate });
      }
      if (candidate !== undefined) Object.assign(selected, { [field]: candidate });
    }
    if (fields.agentSession !== undefined) {
      if (selected.agentSession !== undefined && !sameSession(selected.agentSession, fields.agentSession)) {
        throw new LaunchError("TARGET_IDENTITY_CHANGED", "Launch readiness agent session is contradictory", { field: "agent_session", expected: selected.agentSession, actual: fields.agentSession });
      }
      selected.agentSession = fields.agentSession;
    }
  }
  if (selected.agentKind !== undefined && selected.agentSession !== undefined && selected.agentKind !== selected.agentSession.agent) {
    throw new LaunchError("TARGET_IDENTITY_CHANGED", "Launch readiness kind and session are contradictory", { field: "agent_session.agent", expected: selected.agentKind, actual: selected.agentSession.agent });
  }
  return selected;
}

function completeReadinessIdentity(fields: Partial<PromptTargetIdentity>, paneId: string, expectedName: string, expectedKind: string): PromptTargetIdentity | undefined {
  if (fields.agentName !== undefined && fields.agentName !== expectedName) {
    throw new LaunchError("TARGET_IDENTITY_CHANGED", "Launch readiness agent name was replaced", { expectedName, actualName: fields.agentName });
  }
  if (fields.agentKind !== undefined && fields.agentKind !== expectedKind) {
    throw new LaunchError("TARGET_IDENTITY_CHANGED", "Launch readiness agent kind was replaced", { expectedKind, actualKind: fields.agentKind });
  }
  if (fields.terminalId === undefined || fields.agentName === undefined || fields.agentKind === undefined || fields.agentSession === undefined) return undefined;
  return { paneId, terminalId: fields.terminalId, agentName: fields.agentName, agentKind: fields.agentKind, agentSession: fields.agentSession };
}

function requiredReadinessPaneId(value: Record<string, unknown>, paneId: string, source: string): string | undefined {
  if (!own(value, "pane_id") || value.pane_id === null || value.pane_id === undefined) return `${source}_pane_id_missing`;
  if (typeof value.pane_id !== "string" || value.pane_id.length === 0 || /[\0\r\n]/u.test(value.pane_id)) {
    throw new LaunchError("TARGET_IDENTITY_UNAVAILABLE", "Launch readiness pane identity is malformed", { field: "pane_id", source });
  }
  if (value.pane_id !== paneId) {
    throw new LaunchError("TARGET_IDENTITY_CHANGED", "Launch readiness pane identity was replaced", { expectedPaneId: paneId, actualPaneId: value.pane_id, source });
  }
  return undefined;
}

function snapshotReadinessRecords(snapshot: HerdrSnapshot, paneId: string): { records: ReadinessRecord[]; pending: string[]; duplicates?: { paneRecords: number; agentRecords: number } } {
  let paneRecord: Record<string, unknown> | undefined;
  let agentRecord: Record<string, unknown> | undefined;
  let paneRecords = 0;
  let agentRecords = 0;
  for (const pane of snapshot.panes) {
    if (pane.pane_id !== paneId) continue;
    paneRecords += 1;
    paneRecord ??= pane;
  }
  for (const agent of snapshot.agents) {
    if (agent.pane_id !== paneId) continue;
    agentRecords += 1;
    agentRecord ??= agent;
  }
  const duplicates = paneRecords > 1 || agentRecords > 1 ? { paneRecords, agentRecords } : undefined;
  const records: ReadinessRecord[] = [
    ...(paneRecord === undefined ? [] : [{ source: "snapshot_pane" as const, value: paneRecord }]),
    ...(agentRecord === undefined ? [] : [{ source: "snapshot_agent" as const, value: agentRecord }])
  ];
  const pending: string[] = [];
  if (paneRecord === undefined) pending.push("snapshot_pane_missing");
  if (agentRecord === undefined) pending.push("snapshot_agent_missing");
  return { records, pending, ...(duplicates === undefined ? {} : { duplicates }) };
}

function readinessAgentRecord(value: unknown): { record?: ReadinessRecord; pending?: string } {
  if (!record(value)) throw new LaunchError("CLI_PROTOCOL_ERROR", "Launch readiness agent-get result is malformed");
  if (!own(value, "agent") || value.agent === null || value.agent === undefined) return { pending: "agent_get_record_missing" };
  if (!record(value.agent)) throw new LaunchError("TARGET_IDENTITY_UNAVAILABLE", "Launch readiness agent-get record is malformed", { source: "agent_get", evidenceKind: "malformed" });
  return { record: { source: "agent_get", value: value.agent } };
}

function readinessPaneRecord(value: unknown): { record?: ReadinessRecord; pending?: string } {
  if (!record(value)) throw new LaunchError("CLI_PROTOCOL_ERROR", "Launch readiness pane-get result is malformed");
  if (!own(value, "pane") || value.pane === null || value.pane === undefined) return { pending: "pane_get_record_missing" };
  if (!record(value.pane)) throw new LaunchError("TARGET_IDENTITY_UNAVAILABLE", "Launch readiness pane-get record is malformed", { source: "pane_get", evidenceKind: "malformed" });
  return { record: { source: "pane_get", value: value.pane } };
}

const READINESS_AGENT_STATES = new Set(["idle", "working", "blocked", "done", "unknown"]);

type ReadinessLifecycleSource = ReadinessRecord["source"] | "agent_start";

interface ReadinessLifecycle {
  agentStatus?: string;
  stateChangeSeq?: number;
  revision?: number;
  screenDetectionSkipped?: boolean;
}

function readinessLifecycle(value: Record<string, unknown>, source: ReadinessLifecycleSource): ReadinessLifecycle {
  const result: ReadinessLifecycle = {};
  const state = value.agent_status;
  if (state !== undefined && state !== null) {
    if (typeof state !== "string" || !READINESS_AGENT_STATES.has(state)) {
      throw new LaunchError("TARGET_IDENTITY_UNAVAILABLE", "Launch readiness agent status is malformed", { field: "agent_status", source, evidenceKind: "malformed" });
    }
    result.agentStatus = state;
  }
  for (const [field, target] of [["state_change_seq", "stateChangeSeq"], ["revision", "revision"]] as const) {
    const candidate = value[field];
    if (candidate === undefined || candidate === null) continue;
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) {
      throw new LaunchError("TARGET_IDENTITY_UNAVAILABLE", "Launch readiness lifecycle counter is malformed", { field, source, evidenceKind: "malformed" });
    }
    result[target] = candidate;
  }
  const skipped = value.screen_detection_skipped;
  if (skipped !== undefined && skipped !== null) {
    if (typeof skipped !== "boolean") {
      throw new LaunchError("TARGET_IDENTITY_UNAVAILABLE", "Launch readiness lifecycle diagnostic is malformed", { field: "screen_detection_skipped", source, evidenceKind: "malformed" });
    }
    result.screenDetectionSkipped = skipped;
  }
  return result;
}

function readinessLifecycleSkew(records: Array<{ source: ReadinessRecord["source"]; lifecycle: ReadinessLifecycle }>, baseline: PromptObservationBaseline): string[] {
  const anchor: ReadinessLifecycle = {
    agentStatus: baseline.state,
    stateChangeSeq: baseline.stateChangeSeq,
    revision: baseline.revision,
    ...(baseline.screenDetectionSkipped === undefined ? {} : { screenDetectionSkipped: baseline.screenDetectionSkipped })
  };
  const pending: string[] = [];
  for (const { source, lifecycle } of records) {
    for (const [field, diagnostic] of [["agentStatus", "agent_status"], ["stateChangeSeq", "state_change_seq"], ["revision", "revision"], ["screenDetectionSkipped", "screen_detection_skipped"]] as const) {
      const supplied = lifecycle[field];
      if (supplied !== undefined && supplied !== anchor[field]) pending.push(`lifecycle_skew:${source}:${diagnostic}`);
    }
  }
  return pending;
}

function readinessBaseline(agent: Record<string, unknown>, identity: PromptTargetIdentity, lifecycle: ReadinessLifecycle): { baseline?: PromptObservationBaseline; pending: string[] } {
  const pending: string[] = [];
  const fields = mergeReadinessIdentity([agent], identity.paneId);
  const independent = completeReadinessIdentity(fields, identity.paneId, identity.agentName, identity.agentKind);
  if (independent === undefined) pending.push("agent_get_identity_incomplete");

  const state = lifecycle.agentStatus;
  if (state === undefined) pending.push("agent_get_status_missing");
  else if (state !== "idle") pending.push(`agent_get_not_idle:${state}`);
  if (lifecycle.stateChangeSeq === undefined) pending.push("agent_get_state_change_seq_missing");
  if (lifecycle.revision === undefined) pending.push("agent_get_revision_missing");

  if (pending.length > 0 || independent === undefined) return { pending };
  return {
    pending,
    baseline: {
      state: "idle",
      stateChangeSeq: lifecycle.stateChangeSeq!,
      revision: lifecycle.revision!,
      ...(lifecycle.screenDetectionSkipped === undefined ? {} : { screenDetectionSkipped: lifecycle.screenDetectionSkipped })
    }
  };
}

type ReadWindowAbortReason = "caller" | "deadline";

class ReadWindowAbort extends Error {
  constructor(readonly reason: ReadWindowAbortReason) {
    super(reason === "caller" ? "Operation aborted" : "Read deadline expired");
    this.name = "ReadWindowAbort";
  }
}

interface ReadWindow {
  signal: AbortSignal;
  cancellation(): ReadWindowAbort | undefined;
  assertActive(): void;
  cleanup(): void;
}

function createReadWindow(callerSignal: AbortSignal, deadline: number, clock: LaunchClock): ReadWindow {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = (next: ReadWindowAbortReason): void => controller.abort(next);
  const onCallerAbort = (): void => abort("caller");
  const onDeadline = (): void => abort("deadline");
  const cancellation = (): ReadWindowAbort | undefined => {
    const reason = controller.signal.reason;
    if (reason === "caller" || reason === "deadline") return new ReadWindowAbort(reason);
    if (clock.now() >= deadline) {
      abort("deadline");
      return new ReadWindowAbort("deadline");
    }
    return undefined;
  };

  if (callerSignal.aborted) abort("caller");
  else if (clock.now() >= deadline) abort("deadline");
  else {
    callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    timer = setTimeout(onDeadline, Math.max(0, deadline - clock.now()));
  }

  return {
    signal: controller.signal,
    cancellation,
    assertActive(): void {
      const aborted = cancellation();
      if (aborted) throw aborted;
    },
    cleanup(): void {
      if (timer !== undefined) clearTimeout(timer);
      callerSignal.removeEventListener("abort", onCallerAbort);
    }
  };
}

async function readWithinWindow(cli: LaunchCli, argv: string[], window: ReadWindow): Promise<unknown> {
  window.assertActive();
  const read = run(cli, argv, window.signal);
  const cancellationState = {} as { reject: (reason?: unknown) => void };
  const onAbort = (): void => cancellationState.reject(window.cancellation()!);
  const cancellation = new Promise<never>((_resolve, reject) => {
    cancellationState.reject = reject;
    window.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const result = await Promise.race([read, cancellation]);
    window.assertActive();
    return result;
  } finally {
    window.signal.removeEventListener("abort", onAbort);
  }
}

function waitForReadPoll(window: ReadWindow, intervalMs: number): Promise<void> {
  window.assertActive();
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      window.signal.removeEventListener("abort", onAbort);
      reject(window.cancellation()!);
    };
    const timer = setTimeout(() => {
      window.signal.removeEventListener("abort", onAbort);
      resolve();
    }, intervalMs);
    window.signal.addEventListener("abort", onAbort, { once: true });
  });
}

function monotonicDurationMs(clock: LaunchClock, startedAt: number): number {
  const elapsed = clock.now() - startedAt;
  return Number.isFinite(elapsed) && elapsed > 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(elapsed))
    : 0;
}

function readinessEvidence(
  clock: LaunchClock,
  attemptStartedAt: number,
  samples: number,
  records: Record<string, unknown>[],
  baselineRequired: boolean,
  lastPendingReason?: string
): LaunchReadinessEvidence {
  return {
    budgetBasis: "immediately_before_selected_agent_start",
    budgetMs: HERDR_AGENT_START_TIMEOUT_MS,
    pollIntervalMs: LAUNCH_READINESS_POLL_INTERVAL_MS,
    elapsedMs: monotonicDurationMs(clock, attemptStartedAt),
    samples,
    ...(lastPendingReason === undefined ? {} : { lastPendingReason }),
    records,
    baselineRequired
  };
}

const READINESS_ERROR_METADATA_FIELDS = [
  "field", "source", "expectedSource", "evidenceKind", "expected", "actual",
  "expectedName", "actualName", "expectedKind", "actualKind", "expectedPaneId",
  "actualPaneId", "paneId", "paneRecords", "agentRecords", "sourceCode"
] as const;

function compactReadinessErrorValue(value: unknown): unknown {
  if (!record(value)) return readinessScalar(value);
  return {
    source: ownReadinessSessionField(value, "source"),
    agent: ownReadinessSessionField(value, "agent"),
    kind: ownReadinessSessionField(value, "kind"),
    value: ownReadinessSessionField(value, "value")
  };
}

function compactReadinessErrorMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of READINESS_ERROR_METADATA_FIELDS) {
    if (own(value, field)) result[field] = compactReadinessErrorValue(value[field]);
  }
  return result;
}

function readinessFailure(code: string, message: string, evidence: LaunchReadinessEvidence, details: Record<string, unknown> = {}): LaunchError {
  const cliFailure = compactCliFailureEvidence(details.cliFailure);
  return new LaunchError(code.slice(0, 256), message, {
    ...compactReadinessErrorMetadata(details),
    ...(cliFailure === undefined ? {} : { cliFailure }),
    causeCode: code.slice(0, 256),
    agentStarted: true,
    promptSubmitted: false,
    recipientRegistered: false,
    readiness: evidence
  });
}

async function waitForLaunchReadiness(
  cli: LaunchCli,
  paneId: string,
  callerSignal: AbortSignal,
  expectedName: string,
  expectedKind: string,
  expected: StartedAgent,
  attemptStartedAt: number,
  baselineRequired: boolean,
  clock: LaunchClock
): Promise<LaunchReadinessResult> {
  const deadline = attemptStartedAt + HERDR_AGENT_START_TIMEOUT_MS;
  const window = createReadWindow(callerSignal, deadline, clock);
  let samples = 0;
  let lastRecords: Record<string, unknown>[] = [];
  let lastPendingReason: string | undefined;
  try {
    while (true) {
      window.assertActive();
      samples += 1;
      // A new sample owns new record evidence. If any later read fails,
      // diagnostics must not retain records from the preceding sample.
      lastRecords = [];
      const sampleRecords: ReadinessRecord[] = [];
      try {
        // One readiness sample is always ordered snapshot -> agent get -> pane get.
        // All records are local to this iteration and are discarded before polling.
        const snapshot = snapshotOf(await readWithinWindow(cli, ["api", "snapshot"], window));
        const snapshotRecords = snapshotReadinessRecords(snapshot, paneId);
        sampleRecords.push(...snapshotRecords.records);
        lastRecords = compactReadinessRecords(sampleRecords);

        const agentResult = await readWithinWindow(cli, ["agent", "get", paneId], window);
        const currentAgentRecord = record(agentResult) && own(agentResult, "agent") && record(agentResult.agent)
          ? { source: "agent_get" as const, value: agentResult.agent }
          : undefined;
        if (currentAgentRecord !== undefined) {
          sampleRecords.push(currentAgentRecord);
          lastRecords = compactReadinessRecords(sampleRecords);
        }
        const paneResult = await readWithinWindow(cli, ["pane", "get", paneId], window);

        // All three reads complete before readiness is evaluated. The early compact
        // agent projection above exists only so a pane-read failure retains current-
        // sample evidence rather than falling back to the preceding sample.
        const agentRecord = readinessAgentRecord(agentResult);
        lastRecords = compactReadinessRecords(sampleRecords);
        const paneRecordResult = readinessPaneRecord(paneResult);
        if (paneRecordResult.record) sampleRecords.push(paneRecordResult.record);
        lastRecords = compactReadinessRecords(sampleRecords);

        if (snapshotRecords.duplicates !== undefined) {
          throw new LaunchError("TARGET_IDENTITY_UNAVAILABLE", "Launch readiness snapshot contains duplicate target records", { paneId, ...snapshotRecords.duplicates, evidenceKind: "duplicate" });
        }
        const pending = [...snapshotRecords.pending];
        if (agentRecord.pending) pending.push(agentRecord.pending);
        if (paneRecordResult.pending) pending.push(paneRecordResult.pending);
        for (const item of sampleRecords) {
          const panePending = requiredReadinessPaneId(item.value, paneId, item.source);
          if (panePending) pending.push(panePending);
        }
        const sampleLifecycles = sampleRecords.map(({ source, value }) => ({ source, lifecycle: readinessLifecycle(value, source) }));

        const merged = mergeReadinessIdentity([expected.startRecord, ...sampleRecords.map(({ value }) => value)], paneId);
        const identity = completeReadinessIdentity(merged, paneId, expectedName, expectedKind);
        if (identity === undefined) pending.push("identity_incomplete");

        let baseline: PromptObservationBaseline | undefined;
        const authoritativeAgent = agentRecord.record?.value;
        const authoritativeLifecycle = sampleLifecycles.find(({ source }) => source === "agent_get")?.lifecycle;
        if (baselineRequired && authoritativeAgent !== undefined && authoritativeLifecycle !== undefined && identity !== undefined) {
          const baselineState = readinessBaseline(authoritativeAgent, identity, authoritativeLifecycle);
          pending.push(...baselineState.pending);
          baseline = baselineState.baseline;
          if (baseline !== undefined) {
            pending.push(...readinessLifecycleSkew(sampleLifecycles.filter(({ source }) => source !== "agent_get"), baseline));
          }
        } else if (baselineRequired && authoritativeAgent === undefined) {
          pending.push("baseline_agent_get_missing");
        }

        if (pending.length === 0 && identity !== undefined && authoritativeAgent !== undefined && paneRecordResult.record !== undefined && (!baselineRequired || baseline !== undefined)) {
          window.assertActive();
          const evidence = readinessEvidence(clock, attemptStartedAt, samples, lastRecords, baselineRequired, lastPendingReason);
          return { identity, agent: authoritativeAgent, pane: paneRecordResult.record.value, ...(baseline === undefined ? {} : { baseline }), evidence };
        }
        lastPendingReason = [...new Set(pending)].join(",");
      } catch (error) {
        const cancellation = window.cancellation();
        if (cancellation) throw cancellation;
        const evidence = readinessEvidence(clock, attemptStartedAt, samples, lastRecords, baselineRequired, lastPendingReason);
        if (error instanceof LaunchError) throw readinessFailure(error.code, error.message, evidence, error.details);
        const sourceCode = record(error) && typeof error.code === "string" ? error.code : "CLI_PROTOCOL_ERROR";
        const failureCode = sourceCode === "READY_TIMEOUT" ? "CLI_PROTOCOL_ERROR" : sourceCode;
        const cliFailure = cliFailureEvidence(error);
        throw readinessFailure(failureCode, error instanceof Error ? error.message : String(error), evidence, {
          ...(sourceCode === failureCode ? {} : { sourceCode }),
          ...(cliFailure ? { cliFailure } : {})
        });
      }
      await waitForReadPoll(window, LAUNCH_READINESS_POLL_INTERVAL_MS);
    }
  } catch (error) {
    const cancellation = window.cancellation();
    if (cancellation?.reason === "caller") {
      throw readinessFailure("ABORTED", "Operation aborted during launch readiness", readinessEvidence(clock, attemptStartedAt, samples, lastRecords, baselineRequired, lastPendingReason));
    }
    if (cancellation?.reason === "deadline") {
      const pendingReason = lastPendingReason ?? "readiness_budget_exhausted_before_sample";
      throw readinessFailure("READY_TIMEOUT", "Launch did not become ready within the selected agent-start attempt budget", readinessEvidence(clock, attemptStartedAt, samples, lastRecords, baselineRequired, pendingReason));
    }
    throw error;
  } finally {
    window.cleanup();
  }
}

function compactConfirmationObservation(observation: PromptObservation | undefined): PromptConfirmationEvidence["last"] | undefined {
  if (!observation) return undefined;
  return {
    status: observation.status,
    ...(observation.state === undefined ? {} : { state: observation.state }),
    ...(observation.stateChangeSeq === undefined ? {} : { stateChangeSeq: observation.stateChangeSeq }),
    ...(observation.revision === undefined ? {} : { revision: observation.revision }),
    ...(observation.screenDetectionSkipped === undefined ? {} : { screenDetectionSkipped: observation.screenDetectionSkipped }),
    ...(observation.code === undefined ? {} : { code: observation.code })
  };
}

function promptConfirmationEvidence(
  clock: LaunchClock,
  startedAt: number,
  samples: number,
  reason: PromptConfirmationEvidence["reason"],
  baseline: PromptObservationBaseline,
  last?: PromptObservation,
  sourceCode?: string
): PromptConfirmationEvidence {
  return {
    timeoutMs: PROMPT_CONFIRMATION_TIMEOUT_MS,
    pollIntervalMs: PROMPT_CONFIRMATION_POLL_INTERVAL_MS,
    elapsedMs: monotonicDurationMs(clock, startedAt),
    samples,
    reason,
    baseline,
    ...(compactConfirmationObservation(last) ? { last: compactConfirmationObservation(last) } : {}),
    ...(sourceCode === undefined ? {} : { sourceCode })
  };
}

function promptUnconfirmed(
  submission: PromptSubmissionEvidence,
  confirmation: PromptConfirmationEvidence,
  last?: PromptObservation
): LaunchError {
  return new LaunchError("PROMPT_UNCONFIRMED", "Initial prompt consumption was not proven; the acknowledged prompt was possibly consumed", {
    causeCode: "PROMPT_UNCONFIRMED",
    promptSubmitted: true,
    promptConsumption: "unconfirmed",
    initialPromptSubmission: compactPromptSubmission(submission),
    ...(last === undefined ? {} : { initialPromptObservation: last }),
    promptConfirmation: confirmation
  });
}

async function confirmPromptConsumption(
  cli: LaunchCli,
  paneId: string,
  callerSignal: AbortSignal,
  submission: PromptSubmissionEvidence,
  baseline: PromptObservationBaseline,
  clock: LaunchClock,
  startedAt: number
): Promise<{ agent: Record<string, unknown>; pane: Record<string, unknown>; observation: PromptObservation; confirmation: PromptConfirmationEvidence }> {
  const window = createReadWindow(callerSignal, startedAt + PROMPT_CONFIRMATION_TIMEOUT_MS, clock);
  let samples = 0;
  let last: PromptObservation | undefined;
  try {
    while (true) {
      window.assertActive();
      samples += 1;
      let agent: Record<string, unknown>;
      let pane: Record<string, unknown>;
      try {
        // The two authoritative reads are deliberately sequential and race one
        // shared whole-window cancellation. No source from an earlier sample is
        // carried forward and no prompt/start mutation is retried.
        agent = agentGetRecord(await readWithinWindow(cli, ["agent", "get", paneId], window));
        pane = paneRecord(await readWithinWindow(cli, ["pane", "get", paneId], window), paneId);
      } catch (error) {
        if (window.cancellation()) throw error;
        const sourceCode = record(error) && typeof error.code === "string" ? error.code : "POSTSTATE_UNAVAILABLE";
        const reason: PromptConfirmationEvidence["reason"] = sourceCode === "TARGET_IDENTITY_UNAVAILABLE" ? "identity_unavailable" : "read_failed";
        throw promptUnconfirmed(submission, promptConfirmationEvidence(clock, startedAt, samples, reason, baseline, last, sourceCode), last);
      }
      last = classifyPromptObservation(agent, submission, baseline, [pane]);
      if (last.status === "unavailable" && last.code !== "POSTSTATE_UNAVAILABLE") {
        const reason: PromptConfirmationEvidence["reason"] = last.code === "POSTSTATE_IDENTITY_CHANGED"
          ? "identity_changed"
          : last.code === "POSTSTATE_IDENTITY_UNAVAILABLE"
            ? "identity_unavailable"
            : "contradictory";
        throw promptUnconfirmed(submission, promptConfirmationEvidence(clock, startedAt, samples, reason, baseline, last, last.code), last);
      }
      if (last.consumption === "confirmed") {
        const reason: PromptConfirmationEvidence["reason"] = last.status === "working" ? "working" : "state_change_seq_advanced";
        return { agent, pane, observation: last, confirmation: promptConfirmationEvidence(clock, startedAt, samples, reason, baseline, last) };
      }
      await waitForReadPoll(window, PROMPT_CONFIRMATION_POLL_INTERVAL_MS);
    }
  } catch (error) {
    if (error instanceof LaunchError && error.code === "PROMPT_UNCONFIRMED") throw error;
    // Every non-PromptUnconfirmed escape is the shared window's typed caller or
    // deadline cancellation. The deadline branch is distinct; the remaining
    // bounded cancellation preserves acknowledged effect as caller abort.
    if (window.cancellation()?.reason === "deadline") {
      throw promptUnconfirmed(submission, promptConfirmationEvidence(clock, startedAt, samples, "timeout", baseline, last), last);
    }
    throw promptUnconfirmed(submission, promptConfirmationEvidence(clock, startedAt, samples, "caller_aborted", baseline, last, "ABORTED"), last);
  } finally {
    window.cleanup();
  }
}

function existingAgentNames(snapshot: HerdrSnapshot): string[] {
  const names = snapshot.agents.flatMap((agent) => typeof agent.name === "string" ? [agent.name] : []);
  for (const pane of snapshot.panes) {
    const name = typeof pane.agent_name === "string" ? pane.agent_name : typeof pane.agent === "string" ? pane.agent : undefined;
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function paneForPlacement(snapshot: HerdrSnapshot, target: string, context: CurrentContext): ResolvedTarget {
  return resolveTarget(snapshot, target, "pane", context);
}

function noFocusArgs(): string[] {
  return ["--no-focus"];
}

function compactCliFailureEvidence(value: unknown): Record<string, unknown> | undefined {
  if (!record(value)) return undefined;
  const details: Record<string, unknown> = {};
  const sourceDetails = record(value.details) ? value.details : undefined;
  if (sourceDetails !== undefined) {
    for (const key of ["exitCode", "stdoutBytes", "stderrBytes"] as const) {
      const candidate = sourceDetails[key];
      if (typeof candidate === "number" && Number.isSafeInteger(candidate)) details[key] = candidate;
    }
    for (const key of ["killed", "stdoutPresent", "stderrPresent", "stdoutTruncated", "stderrTruncated"] as const) {
      const candidate = sourceDetails[key];
      if (typeof candidate === "boolean") details[key] = candidate;
    }
    if (sourceDetails.evidence === "omitted_for_stdin_delivery") details.evidence = sourceDetails.evidence;
    for (const key of ["stdout", "stderr", "cause"] as const) {
      const candidate = sourceDetails[key];
      if (typeof candidate === "string") details[key] = boundedEvidence(candidate, 2_000).value;
    }
    if (sourceDetails.errorStream === "stdout" || sourceDetails.errorStream === "stderr") details.errorStream = sourceDetails.errorStream;
    if (record(sourceDetails.errorEnvelope) && typeof sourceDetails.errorEnvelope.id === "string" && record(sourceDetails.errorEnvelope.error)) {
      const envelopeError = sourceDetails.errorEnvelope.error;
      if (typeof envelopeError.code === "string" && typeof envelopeError.message === "string") {
        details.errorEnvelope = {
          id: sourceDetails.errorEnvelope.id.slice(0, 256),
          error: { code: envelopeError.code.slice(0, 256), message: boundedEvidence(envelopeError.message, 2_000).value }
        };
      }
    }
  }
  const code = typeof value.code === "string" ? value.code.slice(0, 256) : undefined;
  const message = typeof value.message === "string" ? boundedEvidence(value.message, 2_000).value : undefined;
  if (code === undefined && message === undefined && Object.keys(details).length === 0) return undefined;
  return { ...(code === undefined ? {} : { code }), ...(message === undefined ? {} : { message }), ...(Object.keys(details).length === 0 ? {} : { details }) };
}

function cliFailureEvidence(error: unknown): Record<string, unknown> | undefined {
  if (!record(error)) return undefined;
  const envelope = cliErrorEnvelope(error);
  const sourceDetails = record(error.details)
    ? { ...error.details, ...(envelope === undefined ? {} : { errorEnvelope: envelope }) }
    : undefined;
  return compactCliFailureEvidence({
    ...(typeof error.code === "string" ? { code: error.code } : {}),
    ...(error instanceof Error ? { message: error.message } : {}),
    ...(sourceDetails === undefined ? {} : { details: sourceDetails })
  });
}

function partialError(
  error: unknown,
  created: LaunchResourceIds,
  phase: LaunchDetails["phase"],
  grant: RecipientGrant,
  effects: { agentStarted: boolean; promptSubmitted: boolean; recipientRegistered: boolean; readiness?: LaunchReadinessEvidence; timing: LaunchTimingEvidence; attempts: LaunchAttemptEvidence[] },
  delivery?: MessageDelivery,
  published?: PublishedAttachment
): LaunchError {
  const transportCode = error instanceof LaunchError
    ? error.code
    : error instanceof CliProtocolError
      ? error.code
      : error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "CLI_PROTOCOL_ERROR";
  const backend = phase === "agent_start" ? cliErrorEnvelope(error) : undefined;
  const causeCode = error instanceof LaunchError && typeof error.details.causeCode === "string"
    ? error.details.causeCode
    : backend?.id === "cli:agent:start" ? backend.error.code : transportCode;
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof LaunchError && error.code === "POSTSTATE_UNAVAILABLE"
    ? "POSTSTATE_UNAVAILABLE"
    : transportCode === "ABORTED"
      ? "ABORTED"
      : error instanceof LaunchError && error.code === "READY_TIMEOUT"
        ? "READY_TIMEOUT"
        : "LAUNCH_FAILED";
  const errorDetails = error instanceof LaunchError ? error.details : {};
  const cliFailure = error instanceof LaunchError
    ? compactCliFailureEvidence(errorDetails.cliFailure)
    : cliFailureEvidence(error);
  const errorReadiness = phase === "ready" && error instanceof LaunchError && record(errorDetails.readiness)
    ? errorDetails.readiness as unknown as LaunchReadinessEvidence
    : undefined;
  const readiness = effects.readiness ?? errorReadiness;
  const supplementalDetails = phase === "ready"
    ? compactReadinessErrorMetadata(errorDetails)
    : errorDetails;
  return new LaunchError(code, `Launch did not complete: ${message}`, {
    ...supplementalDetails,
    phase,
    created: { ...created },
    causeCode,
    ...(effects.agentStarted ? {
      agentStarted: true,
      promptSubmitted: effects.promptSubmitted,
      recipientRegistered: effects.recipientRegistered
    } : {}),
    ...(Object.keys(effects.timing).length === 0 ? {} : { timing: effects.timing }),
    ...(effects.attempts.length === 0 ? {} : { attempts: effects.attempts }),
    ...(cliFailure ? { cliFailure } : {}),
    ...(delivery ? { delivery, initialPromptDelivery: delivery } : {}),
    recipientGrant: { path: grant.path },
    ...(published ? { attachmentRetained: true, attachment: { ...published } } : {}),
    ...(readiness === undefined ? {} : { readiness })
  });
}

function progress(onUpdate: AgentToolUpdateCallback<LaunchDetails> | undefined, phase: LaunchDetails["phase"], created: LaunchResourceIds): void {
  onUpdate?.({
    content: [{ type: "text", text: `Launch ${phase}` }],
    details: { operation: "launch", outcome: "partial", phase, created: { ...created } }
  });
}

async function run(cli: LaunchCli, argv: string[], signal: AbortSignal, preserveCompletedMutation = false): Promise<unknown> {
  if (signal.aborted) throw new LaunchError("ABORTED", "Operation aborted");
  try {
    const response = await cli.runJson(argv, signal, preserveCompletedMutation);
    if (signal.aborted && !preserveCompletedMutation) throw new LaunchError("ABORTED", "Operation aborted");
    return response.result;
  } catch (error) {
    if (signal.aborted) throw new LaunchError("ABORTED", "Operation aborted");
    throw error;
  }
}

async function runPrompt(cli: LaunchCli, paneId: string, envelope: string, signal: AbortSignal): Promise<JsonEnvelope> {
  if (!cli.runJsonWithStdin) throw new LaunchError("CLI_INCOMPATIBLE", "Herdr CLI stdin prompt transport is unavailable");
  // The stdin command is a completed mutation once it returns a response. Keep
  // that response if the caller aborts in the same turn; only later observation
  // is optional after the typed acknowledgement has been parsed.
  const argv = ["agent", "prompt", paneId, "--stdin"];
  return cli.runJsonWithStdin(argv, envelope, signal, true);
}

export function createLaunchTool(deps: LaunchDependencies): ToolDefinition<typeof LaunchParamsSchema, LaunchDetails> {
  return {
    name: "herdr_launch",
    label: "Herdr Launch",
    description: "Launch a named Pi or Claude Herdr agent from a strict profile in an explicitly selected pane placement.",
    parameters: LaunchParamsSchema,
    async execute(_id, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as unknown as LaunchRequest;
      // Establish the requested route before any precondition so every refusal names it.
      const requestedDelivery: MessageDelivery | undefined = record(params) && params.initialPrompt !== undefined
        ? (params.initialPromptDelivery === "attachment" ? "attachment" : "inline")
        : undefined;
      const abortSignal = signal ?? ctx.signal ?? new AbortController().signal;
      const attachmentStore = deps.attachments ?? defaultAttachmentStore;
      const clock = deps.clock ?? realLaunchClock;
      let initialPromptDelivery: MessageDelivery | undefined;
      let profileResolution: ProfileResolution | undefined;
      let profiles: Profile[] = [];
      const promptPaths = new Map<string, string>();
      const effectiveRuntimes = new Map<string, RuntimeProfile>();
      const capabilities = new Map<string, ReturnType<typeof attachmentCapability>>();
      let cwd: string;
      let placement: LaunchPlacement;
      let label: string;
      let recipientKey: string | undefined;
      let grant: RecipientGrant | undefined;
      let published: PublishedAttachment | undefined;
      let sender: SenderIdentity | undefined;
      let existingTarget: ResolvedTarget | undefined;
      let workspaceId: string | undefined;
      let phase: LaunchDetails["phase"] = "validate";
      const created: LaunchResourceIds = {};
      const attempts: LaunchAttemptEvidence[] = [];
      try {
        validateParams(params);
        initialPromptDelivery = requestedDelivery;
        if (params.initialPrompt !== undefined) {
          assertMessageText(params.initialPrompt);
          assertDeliverySize(params.initialPrompt, initialPromptDelivery!);
        }
        await deps.preflight(abortSignal);
        cwd = params.cwd ?? deps.cwd ?? ctx.cwd;
        identifier(cwd, "cwd");
        placement = params.placement ?? { mode: "same_tab" as const };
        label = params.label ?? params.name;
        phase = "resolve_profile";
        if (!deps.profiles) throw new LaunchError("PROFILE_CATALOG_UNAVAILABLE", "Profile catalog is unavailable");
        const catalog = await deps.profiles.load();
        profileResolution = resolveProfile(params.profile, catalog);
        profiles = profileResolution.reachableNames.map((name) => {
          const profile = catalog.effective.get(name);
          if (!profile) throw new LaunchError("PROFILE_RESOLUTION_INVALID", `Resolved profile ${name} is unavailable`);
          return profile;
        });
        recipientKey = mintRecipientKey();
        grant = await attachmentStore.ensureRecipient(recipientKey);
        const promptStore = deps.promptSources ?? defaultPromptSourceStore;
        for (const profile of profiles) {
          const overrides = profile.name === params.profile ? params.overrides : {};
          const runtime = resolveProfileRuntime(profile, overrides);
          effectiveRuntimes.set(profile.name, runtime);
          const capability = attachmentCapability(profile, overrides);
          capabilities.set(profile.name, capability);
          // Any profile the fallback chain can start may be the one that receives the
          // reference, so an attachment launch requires every one of them to be capable.
          if (initialPromptDelivery === "attachment" && !capability.capable) {
            throw new LaunchError("ATTACHMENT_TARGET_UNVERIFIED", "Profile cannot read a local attachment", { profile: profile.name, reason: capability.reason });
          }
          const promptSource = await promptStore.create(profile.body);
          promptPaths.set(profile.name, promptSource.path);
          buildRuntimeArgv(profile, runtime, promptSource.path, grant.path);
        }
        const snapshot = snapshotOf(await run(deps.cli, ["api", "snapshot"], abortSignal));
        sender = params.initialPrompt !== undefined ? resolveSender(snapshot, deps.context.paneId) : undefined;
        assertCurrentContext(snapshot, deps.context);
        if (existingAgentNames(snapshot).filter((name) => name === params.name).length > 0) {
          throw new LaunchError("INVALID_INPUT", `Agent name is already in use: ${params.name}`);
        }
        existingTarget = placement.mode === "existing_pane" ? paneForPlacement(snapshot, placement.target, deps.context) : undefined;
        workspaceId = placement.mode === "new_tab" ? deps.context.workspaceId! : undefined;
        if (initialPromptDelivery === "attachment") {
          phase = "attachment_publish";
          progress(onUpdate, phase, created);
          published = await attachmentStore.publish({
            body: params.initialPrompt!,
            recipientKey,
            ...(existingTarget?.paneId ? { recipientPaneId: existingTarget.paneId } : {}),
            recipientAgentName: params.name,
            senderPaneId: sender!.paneId,
            senderDisplay: sender!.display,
            operation: "assignment"
          });
        }
      } catch (error) {
        await grant?.release();
        throw withDeliveryFailureEvidence(error, { delivery: requestedDelivery, phase, published });
      }
      let paneId: string | undefined;
      let tabId: string | undefined;
      let agentStarted = false;
      let promptSubmitted = false;
      let recipientRegistered = false;
      let readiness: LaunchReadinessEvidence | undefined;
      let selectedAttemptStartedAt: number | undefined;
      const timing: LaunchTimingEvidence = {};
      try {
        phase = "placement";
        progress(onUpdate, phase, created);
        if (placement.mode === "existing_pane") {
          paneId = existingTarget!.paneId!;
          tabId = existingTarget!.tabId;
        } else if (placement.mode === "new_tab") {
          const result = tabRefFrom(await run(deps.cli, ["tab", "create", "--workspace", workspaceId!, "--cwd", cwd, "--label", placement.tabLabel, ...noFocusArgs()], abortSignal, true));
          tabId = result.tabId;
          paneId = result.paneId;
          created.tabId = tabId;
          deps.ownership?.record({ kind: "tab", id: tabId, parentId: workspaceId });
          if (!paneId) {
            const tab = await run(deps.cli, ["tab", "get", tabId], abortSignal);
            paneId = paneRefFrom(tab).paneId;
          }
          created.paneId = paneId;
          deps.ownership?.record({ kind: "pane", id: paneId!, parentId: tabId });
        } else {
          const result = paneRefFrom(await run(deps.cli, ["pane", "split", "--current", "--direction", "right", ...noFocusArgs(), "--cwd", cwd], abortSignal, true));
          paneId = result.paneId;
          tabId = result.tabId ?? deps.context.tabId!;
          created.paneId = paneId;
          created.tabId = tabId;
          deps.ownership?.record({ kind: "pane", id: paneId!, parentId: tabId! });
        }
        const resolvedPaneId = paneId!;
        if (placement.mode !== "existing_pane") await run(deps.cli, ["pane", "rename", resolvedPaneId, label], abortSignal);
        phase = "agent_start";
        progress(onUpdate, phase, created);
        let started: unknown;
        let selectedProfile: Profile | undefined;
        let selectedRuntime: RuntimeProfile | undefined;
        let startedAgent: StartedAgent | undefined;
        for (const profile of profiles) {
          const runtime = effectiveRuntimes.get(profile.name)!;
          const startArgs = ["agent", "start", params.name, "--kind", runtime.kind, "--pane", resolvedPaneId, "--timeout", String(HERDR_AGENT_START_TIMEOUT_MS), "--", ...buildRuntimeArgv(profile, runtime, promptPaths.get(profile.name), grant!.path)];
          const attemptStartedAt = clock.now();
          try {
            started = await run(deps.cli, startArgs, abortSignal, true);
            agentStarted = true;
            attempts.push({ profile: profile.name, outcome: "selected" });
            selectedAttemptStartedAt = attemptStartedAt;
            selectedProfile = profile;
            selectedRuntime = runtime;
            startedAgent = agentIdentity(started, params.name, resolvedPaneId, runtime.kind);
            break;
          } catch (error) {
            const eligible = startFailureEvidence(error);
            if (!eligible) throw error;
            let failedPane: Record<string, unknown>;
            try {
              failedPane = paneRecord(await run(deps.cli, ["pane", "get", resolvedPaneId], abortSignal), resolvedPaneId);
            } catch (readError) {
              throw new LaunchError("POSTSTATE_UNAVAILABLE", "Fallback eligibility could not be proven from authoritative pane state", { causeCode: "POSTSTATE_UNAVAILABLE", startFailureCode: eligible.code, readError: readError instanceof Error ? readError.message : String(readError), attempts });
            }
            const evidence: LaunchAttemptEvidence = { profile: profile.name, outcome: "agent_start_failed", errorCode: eligible.code, message: eligible.message, postState: compactAttemptState(failedPane) };
            attempts.push(evidence);
            if (!noAgentFromPane(failedPane)) {
              attempts.push({ profile: profile.name, outcome: "fallback_refused", errorCode: eligible.code, message: "authoritative pane still reports an agent", postState: compactAttemptState(failedPane) });
              throw new LaunchError("LAUNCH_FAILED", "Automatic fallback refused because the failed pane still has an agent", { causeCode: eligible.code, attempts });
            }
            if (profile === profiles.at(-1)) throw new LaunchError("LAUNCH_FAILED", "Profile fallback chain exhausted after agent start failure", { causeCode: eligible.code, attempts });
          }
        }
        const chosenProfile = selectedProfile!;
        const chosenRuntime = selectedRuntime!;
        const chosenAgent = startedAgent!;
        let agentId = chosenAgent.agentId;
        if (agentId) created.agentId = agentId;
        phase = "ready";
        progress(onUpdate, phase, created);
        if (params.initialPrompt !== undefined) {
          // Keep the grant alive while the selected start attempt's remaining
          // absolute startup budget is spent on read-only readiness sampling.
          await grant?.renew();
        }
        const ready = await waitForLaunchReadiness(
          deps.cli,
          resolvedPaneId,
          abortSignal,
          params.name,
          chosenRuntime.kind,
          chosenAgent,
          selectedAttemptStartedAt!,
          params.initialPrompt !== undefined,
          clock
        );
        readiness = ready.evidence;
        timing.selectedStartReadinessMs = readiness.elapsedMs;
        const capturedIdentity = ready.identity;
        agentId ??= idFrom(ready.agent, "agent_id") ?? idFrom(ready.agent, "id") ?? idFrom(ready.pane, "agent_id");
        if (params.focus === true) {
          phase = "focus";
          progress(onUpdate, phase, created);
          await run(deps.cli, ["agent", "focus", resolvedPaneId], abortSignal);
        }
        if (agentId) created.agentId = agentId;

        let initialPromptSent = false;
        let promptConsumption: PromptConsumption | undefined;
        let initialPromptSubmission: PromptSubmissionEvidence | undefined;
        let initialPromptObservation: PromptObservation | undefined;
        let promptConfirmation: PromptConfirmationEvidence | undefined;
        let postState: Record<string, unknown> | undefined = ready.pane;
        if (params.initialPrompt !== undefined) {
          // Readiness returned this baseline from the same coherent sample that
          // captured identity; there is no later one-shot baseline read.
          const baseline = ready.baseline!;
          const envelope = initialPromptDelivery === "attachment"
            ? buildEnvelope(sender!, "assignment", params.initialPrompt, "attachment", { ...published!, encoding: "utf-8" })
            : buildEnvelope(sender!, "assignment", params.initialPrompt, "inline");
          phase = "prompt_verification";
          progress(onUpdate, phase, created);
          const promptSubmissionStartedAt = clock.now();
          try {
            const promptResponse = await runPrompt(deps.cli, resolvedPaneId, envelope, abortSignal);
            promptSubmitted = true;
            initialPromptSubmission = parsePromptSubmission(promptResponse, capturedIdentity);
          } finally {
            timing.promptSubmissionAckMs = monotonicDurationMs(clock, promptSubmissionStartedAt);
          }

          const confirmationStartedAt = clock.now();
          try {
            const confirmed = await confirmPromptConsumption(deps.cli, resolvedPaneId, abortSignal, initialPromptSubmission, baseline, clock, confirmationStartedAt);
            initialPromptObservation = confirmed.observation;
            promptConfirmation = confirmed.confirmation;
            timing.postAckConfirmationMs = confirmed.confirmation.elapsedMs;
            postState = confirmed.pane;
            agentId ??= idFrom(confirmed.agent, "agent_id") ?? idFrom(confirmed.agent, "id") ?? idFrom(confirmed.pane, "agent_id");
          } catch (error) {
            timing.postAckConfirmationMs = ((error as LaunchError).details.promptConfirmation as PromptConfirmationEvidence).elapsedMs;
            throw error;
          }
          promptConsumption = "confirmed";
          initialPromptSent = true;
          if (agentId) created.agentId = agentId;
        }
        const authoritativeName = capturedIdentity.agentName;
        const capability = capabilities.get(chosenProfile.name)!;
        const recipient = { recipientKey: recipientKey!, paneId: resolvedPaneId, agentName: authoritativeName, ...(agentId ? { agentId } : {}), profileName: chosenProfile.name, kind: capability.kind, capable: capability.capable, reason: capability.reason };
        deps.recipients?.recordFor(chosenProfile.name, resolvedPaneId, recipient.recipientKey, capability, { ...capturedIdentity, ...(agentId ? { agentId } : {}) });
        recipientRegistered = deps.recipients !== undefined;
        const effective = effectiveDetails(chosenProfile, chosenRuntime);
        const launchDetails: LaunchDetails = {
          operation: "launch", outcome: "launched", name: authoritativeName, kind: chosenRuntime.kind, placement, tabId, paneId: resolvedPaneId,
          ...(agentId ? { agentId } : {}),
          postState: boundAgentSessionStrings(withoutEnvironment(postState)),
          agentStarted,
          initialPromptSent,
          promptSubmitted,
          recipientRegistered,
          readiness,
          ...(params.initialPrompt === undefined ? {} : { promptConsumption }),
          ...(initialPromptDelivery ? { initialPromptDelivery } : {}),
          ...(initialPromptSubmission ? { initialPromptSubmission: compactPromptSubmission(initialPromptSubmission) } : {}),
          ...(initialPromptObservation ? { initialPromptObservation } : {}),
          ...(promptConfirmation ? { promptConfirmation } : {}),
          timing,
          ...(sender ? {
            sender: { paneId: sender.paneId, display: sender.display, source: sender.source },
            envelope: { version: "v1" as const, kind: "assignment" as const, delivery: initialPromptDelivery! },
            ...(published ? { attachment: published } : {})
          } : {}),
          recipient,
          profile: {
            name: chosenProfile.name, requested: params.profile, selected: chosenProfile.name,
            source: { kind: chosenProfile.source.kind, path: chosenProfile.source.path }, timeoutMinutes: chosenProfile.timeoutMinutes,
            runtime: effective.runtime, permissions: effective.permissions, attempts,
            fallbackProfiles: [...profileResolution!.fallbackProfiles], reachableNames: [...profileResolution!.reachableNames], sessionPersistence: chosenProfile.sessionPersistence
          }
        };
        return { content: [{ type: "text", text: formatResult({ operation: "launch", outcome: "success", targetId: paneId, delivery: initialPromptDelivery }) }], details: launchDetails };
      } catch (error) {
        if (agentStarted && selectedAttemptStartedAt !== undefined && timing.selectedStartReadinessMs === undefined) {
          const failureReadiness = error instanceof LaunchError && record(error.details.readiness)
            ? error.details.readiness.elapsedMs
            : undefined;
          timing.selectedStartReadinessMs = typeof failureReadiness === "number" && Number.isSafeInteger(failureReadiness) && failureReadiness >= 0
            ? failureReadiness
            : monotonicDurationMs(clock, selectedAttemptStartedAt);
        }
        throw partialError(error, created, phase, grant!, { agentStarted, promptSubmitted, recipientRegistered, ...(readiness === undefined ? {} : { readiness }), timing, attempts }, initialPromptDelivery, published);
      } finally {
        // The launch window is over; the directory is kept only by its own content.
        await grant?.release();
      }
    },
    renderCall(args, theme) {
      const delivery = args.initialPrompt !== undefined ? args.initialPromptDelivery ?? "inline" : undefined;
      return textComponent(formatCall("herdr_launch", delivery ? `${args.profile} · ${delivery}` : args.profile, args.name), theme, "accent");
    },
    renderResult(result, options, theme) {
      return renderResultComponent("launch", result, options, theme, result.details?.paneId);
    }
  };
}

export { validateParams as validateLaunchParams };
