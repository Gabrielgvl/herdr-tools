import type { AgentToolUpdateCallback, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { boundedEvidence, CliProtocolError, HERDR_AGENT_START_TIMEOUT_MS, type HerdrErrorEnvelope, type JsonEnvelope } from "../cli.js";
import type { CompatibilityPreflight } from "../health.js";
import { contextRebindingDetails, createContextResolver, type ContextResolutionDiagnostics, type ContextResolver } from "../context.js";
import { withDeliveryFailureEvidence } from "../messages/failure.js";
import { assertDeliverySize, assertMessageText, type MessageDelivery } from "../messages/limits.js";
import { boundAgentSessionStrings, classifyPromptObservation, compactPromptSubmission, parsePromptSubmission, parsePromptTargetIdentityFields, type AgentSessionIdentity, type PromptConsumption, type PromptIdentityError, type PromptObservation, type PromptObservationBaseline, type PromptSubmissionEvidence, type PromptTargetIdentity } from "../messages/prompt.js";
import { defaultAttachmentStore, type AttachmentStore, type PublishedAttachment, type RecipientGrant } from "../messages/store.js";
import { mintRecipientKey, type RecipientRegistry } from "../messages/recipients.js";
import { attachmentCapability } from "../profiles/capability.js";
import { buildEnvelope, resolveSender, type SenderIdentity } from "../provenance.js";
import type { CurrentContext, HerdrSnapshot, ResolvedTarget } from "../targets.js";
import { parseSnapshotResult, resolveTarget } from "../targets.js";
import { formatCall, formatResult, renderResultComponent, textComponent } from "../tui.js";
import { LaunchParamsSchema, type LaunchPlacement, type LaunchRequest } from "../launch-schema.js";
import { buildRuntimeArgv, defaultPromptSourceStore, refreshBundledProfileResourceSelection, RESERVED_BUNDLED_PROFILE_NAMES, resolveProfile, resolveProfileRuntime, SkillSelectionError, validateProfileResourceSelection, type Profile, type ProfileCatalog, type ProfileResolution, type PromptSourceStore } from "../profiles/index.js";
import { CLAUDE_EFFORTS, CLAUDE_PERMISSION_MODES, THINKING_LEVELS, type ProfileKind, type RuntimeProfile } from "../profiles/types.js";
import { modelSafeJson } from "../redaction.js";
import type { ProvisionalSupervisedIdentity } from "../supervision/identity.js";
import type { SupervisionCoordinator, SupervisionReservation } from "../supervision/registry.js";
import { SupervisionBindError } from "../supervision/supervisor.js";
import { acquireLaunchGate, type LaunchGateLease } from "./launch-freeze.js";

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
  contextResolver?: ContextResolver;
  preflight: CompatibilityPreflight;
  cwd?: string;
  ownership?: LaunchResourceRegistry;
  profiles?: { load: () => Promise<ProfileCatalog> };
  promptSources?: PromptSourceStore;
  attachments?: AttachmentStore;
  recipients?: RecipientRegistry;
  clock?: LaunchClock;
  /** Test hosts may provide the same fail-closed gate with disposable paths. */
  launchGate?: () => Promise<LaunchGateLease>;
  /**
   * Required. Every successful launch creates supervision, so a host that
   * cannot supervise cannot launch. See ADR-019.
   */
  supervision: SupervisionCoordinator;
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

export type LaunchEffectCertainty = "absent" | "partial" | "unknown" | "confirmed";

export interface LaunchReconciliationEvidence {
  effectCertainty: Exclude<LaunchEffectCertainty, "confirmed">;
  snapshot: "present" | "unavailable";
  pane: "present" | "absent" | "unknown";
  agent: "present" | "absent" | "unknown";
  tabId?: string;
  paneId?: string;
  agentId?: string;
  agentName?: string;
  readFailures?: string[];
}

export interface LaunchDetails extends LaunchResourceIds {
  operation: "launch";
  outcome: "launched" | "partial";
  effectCertainty?: LaunchEffectCertainty;
  reconciliation?: LaunchReconciliationEvidence;
  contextRebinding?: ContextResolutionDiagnostics;
  name?: string;
  kind?: string;
  placement?: LaunchPlacement;
  postState?: Record<string, unknown>;
  agentStarted?: boolean;
  initialPromptSent?: boolean;
  promptSubmitted?: boolean;
  recipientRegistered?: boolean;
  promptConsumption?: PromptConsumption;
  assignmentState?: "confirmed" | "unconfirmed";
  initialPromptDelivery?: MessageDelivery;
  initialPromptSubmission?: PromptSubmissionEvidence;
  initialPromptObservation?: PromptObservation;
  readiness?: LaunchReadinessEvidence;
  promptConfirmation?: PromptConfirmationEvidence;
  timing?: LaunchTimingEvidence;
  phase?: "validate" | "resolve_profile" | "attachment_publish" | "supervision_reserve" | "placement" | "agent_start" | "ready" | "focus" | "prompt_verification" | "supervision_bind";
  supervision?:
    | { jobId: string; state: "active"; child: { agentName: string; agentKind: string; paneId: string; terminalId: string; profileName: string } }
    | { jobId: string; state: "provisional"; provisional: { agentName: string; agentKind: "agy"; paneId: string; terminalId: string; profileName: string; baseline: PromptObservationBaseline } };
  created?: LaunchResourceIds;
  causeCode?: string;
  sender?: { paneId: string; display: string; source: SenderIdentity["source"] };
  envelope?: { version: "v1"; kind: "assignment"; delivery: MessageDelivery };
  attachment?: PublishedAttachment;
  recipient?: { recipientKey: string; paneId: string; agentName: string; agentId?: string; profileName: string; kind: ProfileKind; capable: boolean; reason: string };
  profile?: LaunchEffectiveProfile & { name: string; sessionPersistence: boolean };
}

const LAUNCH_READINESS_POLL_INTERVAL_MS = 100;
const PROMPT_CONFIRMATION_TIMEOUT_MS = 5_000;
const PROMPT_CONFIRMATION_POLL_INTERVAL_MS = 100;
const LAUNCH_RECONCILIATION_TIMEOUT_MS = 5_000;
export const LAUNCH_DIAGNOSTIC_MAX_BYTES = 8_192;
export const LAUNCH_DIAGNOSTIC_MARKER = "HERDR_LAUNCH_DIAGNOSTIC";
/**
 * The prose that precedes every structured diagnostic. No cause message is ever
 * echoed there: `CliProtocolError` adopts the Herdr error envelope's `message`
 * verbatim, which can quote a command line, an environment value, or a credential,
 * and this module's own validation messages quote caller-supplied keys and values.
 * Neither is safe to publish, and a per-cause allowlist would have to be right
 * about every message on every path, so the summary is fixed and the cause's
 * bounded prose is kept in details instead.
 */
export const LAUNCH_DIAGNOSTIC_SUMMARY = "Launch failed; inspect the structured diagnostic";
/** Shape of every failure code this module and the CLI transport define. */
const LAUNCH_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;
const realLaunchClock: LaunchClock = { now: () => performance.now() };

export const LAUNCH_RECOVERY_GUIDANCE = Object.freeze({
  inspectBeforeRetry: "Inspect the affected pane and agent with herdr_inspect before retrying; do not assume that no agent started.",
  preserveUnconfirmed: "Inspect the existing child with herdr_inspect and its active supervisor with herdr_jobs get; do not relaunch, resend, close or reuse the pane, register a recipient, or continue dependent work while assignment consumption is unconfirmed.",
  noEffect: "No launch mutation was dispatched; correct the failure and retry only after validating the request.",
  unknownEffect: "Inspect the affected pane and agent with herdr_inspect before any retry; the launch effect is unknown and must not be assumed absent."
} as const);

type LaunchPhase = NonNullable<LaunchDetails["phase"]>;
type LaunchRecoveryGuidance = typeof LAUNCH_RECOVERY_GUIDANCE[keyof typeof LAUNCH_RECOVERY_GUIDANCE];

interface LaunchModelDiagnostic {
  code: string;
  phase: LaunchPhase;
  created: LaunchResourceIds;
  paneId?: string;
  supervisorJobId?: string;
  assignmentState?: "unconfirmed";
  agentStarted: boolean;
  promptSubmitted: boolean;
  recipientRegistered: boolean;
  effectCertainty: LaunchEffectCertainty;
  recoveryGuidance: LaunchRecoveryGuidance;
}

function boundedDiagnosticText(value: string, maxBytes: number): string {
  let result = "";
  for (const character of value) {
    const candidate = `${result}${character}`;
    if (Buffer.byteLength(candidate, "utf8") > maxBytes) break;
    result = candidate;
  }
  return result;
}

function safeDiagnosticString(value: unknown, limit = 256): string | undefined {
  if (typeof value !== "string") return undefined;
  const printable = [...value].map((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? " " : character;
  }).join("").trim();
  const bounded = boundedDiagnosticText(printable, limit);
  return bounded.length === 0 ? undefined : bounded;
}

function safeDiagnosticIds(created: LaunchResourceIds): LaunchResourceIds {
  return {
    ...(safeDiagnosticString(created.tabId) === undefined ? {} : { tabId: safeDiagnosticString(created.tabId) }),
    ...(safeDiagnosticString(created.paneId) === undefined ? {} : { paneId: safeDiagnosticString(created.paneId) }),
    ...(safeDiagnosticString(created.agentId) === undefined ? {} : { agentId: safeDiagnosticString(created.agentId) })
  };
}

function diagnosticRecovery(effectCertainty: LaunchEffectCertainty, promptSubmitted: boolean, mutationDispatched: boolean): LaunchRecoveryGuidance {
  if (promptSubmitted) return LAUNCH_RECOVERY_GUIDANCE.preserveUnconfirmed;
  if (effectCertainty === "absent" && !mutationDispatched) return LAUNCH_RECOVERY_GUIDANCE.noEffect;
  if (effectCertainty === "unknown") return LAUNCH_RECOVERY_GUIDANCE.unknownEffect;
  return LAUNCH_RECOVERY_GUIDANCE.inspectBeforeRetry;
}

/**
 * A failure code reaches the model inside the diagnostic payload, so only a code
 * this module or the CLI transport defines may appear there. A foreign error can
 * carry any string on `code`; anything outside the known code shape is untrusted
 * text and is classified rather than echoed.
 */
function safeLaunchCode(code: unknown): string {
  return typeof code === "string" && LAUNCH_CODE_PATTERN.test(code) ? code : "LAUNCH_FAILED";
}

/**
 * Every part of the result is authored here: the prose is fixed, `phase` and
 * `recoveryGuidance` are typed to module-owned unions, `created` holds identifiers
 * this module resolved, and `code` is classified above. The model-visible message
 * is therefore free of cause text by construction rather than by filtering, and it
 * carries exactly one diagnostic record.
 */
function launchDiagnosticMessage(diagnostic: LaunchModelDiagnostic): string {
  const paneId = safeDiagnosticString(diagnostic.paneId);
  const supervisorJobId = safeDiagnosticString(diagnostic.supervisorJobId);
  const assignmentUnconfirmed = diagnostic.assignmentState === "unconfirmed" && paneId !== undefined && supervisorJobId !== undefined;
  const payload: LaunchModelDiagnostic = {
    code: safeLaunchCode(diagnostic.code),
    phase: diagnostic.phase,
    created: safeDiagnosticIds(diagnostic.created),
    ...(assignmentUnconfirmed ? { paneId, supervisorJobId, assignmentState: "unconfirmed" as const } : {}),
    agentStarted: diagnostic.agentStarted,
    promptSubmitted: diagnostic.promptSubmitted,
    recipientRegistered: diagnostic.recipientRegistered,
    effectCertainty: diagnostic.effectCertainty,
    recoveryGuidance: diagnostic.recoveryGuidance
  };
  const suffix = `\n${LAUNCH_DIAGNOSTIC_MARKER} ${JSON.stringify(payload)}`;
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  /* c8 ignore next -- the fixed-shape payload is bounded below this defensive fallback. */
  if (suffixBytes > LAUNCH_DIAGNOSTIC_MAX_BYTES) {
    // The normal fixed-shape payload is comfortably below the bound. Keep a
    // valid, smaller payload if that invariant ever changes instead of slicing
    // JSON in the middle of a multibyte character or escaped field.
    const minimal = {
      code: payload.code,
      phase: payload.phase,
      created: {},
      ...(payload.assignmentState === "unconfirmed" ? { paneId: payload.paneId, supervisorJobId: payload.supervisorJobId, assignmentState: payload.assignmentState } : {}),
      agentStarted: payload.agentStarted,
      promptSubmitted: payload.promptSubmitted,
      recipientRegistered: payload.recipientRegistered,
      effectCertainty: payload.effectCertainty,
      recoveryGuidance: LAUNCH_RECOVERY_GUIDANCE.unknownEffect
    } satisfies LaunchModelDiagnostic;
    return `${LAUNCH_DIAGNOSTIC_MARKER} ${JSON.stringify(minimal)}`;
  }
  const available = LAUNCH_DIAGNOSTIC_MAX_BYTES - suffixBytes;
  return `${boundedDiagnosticText(LAUNCH_DIAGNOSTIC_SUMMARY, available)}${suffix}`;
}

class LaunchError extends Error {
  readonly details: Record<string, unknown>;

  constructor(readonly code: string, message: string, details: Record<string, unknown> = {}, diagnostic?: Omit<LaunchModelDiagnostic, "code"> & { code?: string }) {
    super(diagnostic === undefined ? message : launchDiagnosticMessage({ ...diagnostic, code: diagnostic.code ?? code }));
    this.name = "LaunchError";
    this.details = boundAgentSessionStrings(details);
  }
}

/**
 * Fail-closed resource validation for one profile, with the skill-selection
 * verdict carried through as a launch failure and any unexpected IO error
 * re-raised as itself.
 */
async function assertResourceSelection(profile: Profile, runtime: RuntimeProfile, refresh = false): Promise<void> {
  try {
    await (refresh ? refreshBundledProfileResourceSelection(profile, runtime) : validateProfileResourceSelection(profile, runtime));
  } catch (error) {
    if (!(error instanceof SkillSelectionError)) throw error;
    // `causeCode` keeps the skill-selection verdict legible when this runs after
    // the first effect, where the outer handler reports `LAUNCH_FAILED`.
    throw new LaunchError(error.code, error.message, { causeCode: error.code, profile: profile.name, ...error.details });
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
    if (RESERVED_BUNDLED_PROFILE_NAMES.has(params.profile)) throw new LaunchError("INVALID_INPUT", `Reserved profile ${params.profile} does not accept runtime overrides`);
    for (const key of Object.keys(params.overrides)) if (!["model", "thinking", "effort", "tools", "permissionMode", "allowedTools", "disallowedTools", "addDirs"].includes(key)) throw new LaunchError("INVALID_INPUT", `Unknown profile override: ${key}`);
    if (params.overrides.model !== undefined) identifier(params.overrides.model, "overrides.model");
    if (params.overrides.thinking !== undefined && (typeof params.overrides.thinking !== "string" || !THINKING_LEVELS.includes(params.overrides.thinking as typeof THINKING_LEVELS[number]))) throw new LaunchError("INVALID_INPUT", "overrides.thinking is invalid");
    if (params.overrides.effort !== undefined && (typeof params.overrides.effort !== "string" || !CLAUDE_EFFORTS.includes(params.overrides.effort as typeof CLAUDE_EFFORTS[number]))) throw new LaunchError("INVALID_INPUT", "overrides.effort is invalid");
    if (params.overrides.permissionMode !== undefined && (typeof params.overrides.permissionMode !== "string" || !CLAUDE_PERMISSION_MODES.includes(params.overrides.permissionMode as typeof CLAUDE_PERMISSION_MODES[number]))) throw new LaunchError("INVALID_INPUT", "overrides.permissionMode is invalid");
    for (const key of ["tools", "allowedTools", "disallowedTools", "addDirs"] as const) {
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
    if (!own(pane, field)) return [];
    const value = pane[field];
    if (typeof value === "string") {
      const safe = safeDiagnosticString(value);
      return safe === undefined ? [] : [[field, safe]];
    }
    if (typeof value === "number" || typeof value === "boolean" || value === null) return [[field, value]];
    return [];
  }));
  const session = own(pane, "agent_session") ? pane.agent_session : undefined;
  if (record(session) && ["source", "agent", "kind", "value"].every((field) => own(session, field) && typeof session[field] === "string")) {
    result.agent_session = {
      source: safeDiagnosticString(session.source) ?? "",
      agent: safeDiagnosticString(session.agent) ?? "",
      kind: safeDiagnosticString(session.kind) ?? "",
      value: safeDiagnosticString(session.value) ?? ""
    };
  }
  return result;
}

interface LaunchReconciliationInput {
  cli: LaunchCli;
  baseline: HerdrSnapshot;
  paneId?: string;
  tabId?: string;
  agentStarted: boolean;
  promptSubmitted: boolean;
  agentName: string;
}

function reconciliationFailureCode(error: unknown): string {
  if (record(error) && typeof error.code === "string") return safeDiagnosticString(error.code, 120) ?? "READ_FAILED";
  if (error instanceof Error && error.name === "LaunchReconciliationTimeout") return "READ_TIMEOUT";
  return "READ_FAILED";
}

function reconciliationTimeout(): Error {
  return Object.assign(new Error("readback deadline expired"), { name: "LaunchReconciliationTimeout" });
}

/**
 * Racing a timer alone only stops the caller waiting: the CLI invocation keeps
 * running and lands its result after reconciliation has already reported. The
 * read therefore runs on its own signal, derived from the caller's, and that
 * signal is aborted at the instant the deadline wins — before the race rejects —
 * so a cooperative read is cancelled rather than abandoned. An operation that
 * ignores its signal still cannot be stopped; the race bounds the caller either
 * way, and this function claims nothing more than that.
 */
async function boundedReconciliationRead<T>(operation: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, deadline: number): Promise<T> {
  if (signal.aborted || Date.now() >= deadline) throw reconciliationTimeout();
  // The read's signal is aborted here with the typed deadline reason rather than
  // derived through `AbortSignal.any`, whose composite-reason propagation is not
  // stable across Node versions: a read must be able to tell a deadline from an
  // ordinary caller abort by inspecting `signal.reason`.
  const readController = new AbortController();
  const onCallerAbort = (): void => readController.abort(signal.reason);
  signal.addEventListener("abort", onCallerAbort, { once: true });
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      readController.abort(reconciliationTimeout());
      reject(reconciliationTimeout());
    }, Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([operation(readController.signal), timeout]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onCallerAbort);
  }
}

function readbackAgentName(agent: Record<string, unknown> | undefined, pane: Record<string, unknown> | undefined): string | undefined {
  const candidate = agent && own(agent, "name") ? agent.name : pane && own(pane, "agent_name") ? pane.agent_name : pane && own(pane, "agent") ? pane.agent : undefined;
  return safeDiagnosticString(candidate, 256);
}

function readbackAgentId(agent: Record<string, unknown> | undefined, pane: Record<string, unknown> | undefined): string | undefined {
  const candidate = agent && own(agent, "agent_id") ? agent.agent_id : agent && own(agent, "id") ? agent.id : pane && own(pane, "agent_id") ? pane.agent_id : undefined;
  return safeDiagnosticString(candidate, 256);
}

function malformedReadback(kind: "pane" | "agent"): Error {
  return Object.assign(new Error(`${kind} readback was malformed`), { code: "READ_MALFORMED" });
}

function readbackPaneRecord(value: unknown, expectedPaneId: string): Record<string, unknown> | undefined {
  if (!record(value) || !own(value, "pane")) throw malformedReadback("pane");
  if (value.pane === null) return undefined;
  if (!record(value.pane) || !own(value.pane, "pane_id") || value.pane.pane_id !== expectedPaneId) throw malformedReadback("pane");
  return value.pane;
}

function readbackAgentRecord(value: unknown, expectedPaneId: string): Record<string, unknown> | undefined {
  if (!record(value) || !own(value, "agent")) throw malformedReadback("agent");
  if (value.agent === null) return undefined;
  if (!record(value.agent) || !own(value.agent, "pane_id") || value.agent.pane_id !== expectedPaneId) throw malformedReadback("agent");
  return value.agent;
}

function launchEffectCertainty(
  input: LaunchReconciliationInput,
  snapshot: HerdrSnapshot | undefined,
  pane: Record<string, unknown> | undefined,
  agent: Record<string, unknown> | undefined,
  readFailures: readonly string[],
  candidatePaneId: string | undefined,
  candidateTabId: string | undefined
): Exclude<LaunchEffectCertainty, "confirmed"> {
  const baselinePaneIds = new Set(input.baseline.panes.map((item) => item.pane_id));
  const baselineTabIds = new Set(input.baseline.tabs.map((item) => item.tab_id));
  const currentPane = candidatePaneId === undefined ? undefined : snapshot?.panes.find((item) => item.pane_id === candidatePaneId);
  const currentTab = candidateTabId === undefined ? undefined : snapshot?.tabs.find((item) => item.tab_id === candidateTabId);
  const createdPane = (currentPane !== undefined && !baselinePaneIds.has(currentPane.pane_id)) || (pane !== undefined && candidatePaneId !== undefined && !baselinePaneIds.has(candidatePaneId));
  const createdTab = (currentTab !== undefined && !baselineTabIds.has(currentTab.tab_id)) || (pane !== undefined && candidateTabId !== undefined && !baselineTabIds.has(candidateTabId));

  // A live agent or a newly observed pane/tab proves a partial launch effect,
  // even if another optional read failed. Conversely, a failed read must never
  // be converted into an "absent" conclusion merely because no record was
  // returned from the other reads.
  if (agent !== undefined || createdPane || createdTab) return "partial";
  if (readFailures.length > 0) return "unknown";
  /* c8 ignore next -- an agent or prompt effect always has a resolved candidate pane. */
  if (input.agentStarted || input.promptSubmitted) return "unknown";

  // Absence is only conclusive when the authoritative snapshot identified the
  // candidate pane and proved that it is gone. If no candidate could be
  // identified, the readback is incomplete and remains unknown.
  if (snapshot !== undefined && candidatePaneId !== undefined && currentPane === undefined) return "absent";
  return "unknown";
}

async function reconcileLaunch(input: LaunchReconciliationInput): Promise<LaunchReconciliationEvidence> {
  const controller = new AbortController();
  const deadline = Date.now() + LAUNCH_RECONCILIATION_TIMEOUT_MS;
  const failures: string[] = [];
  let snapshot: HerdrSnapshot | undefined;
  let snapshotAvailable = false;
  let currentPane: Record<string, unknown> | undefined;
  let currentAgent: Record<string, unknown> | undefined;
  try {
    try {
      const result = await boundedReconciliationRead((signal) => input.cli.runJson(["api", "snapshot"], signal).then((response) => response.result), controller.signal, deadline);
      snapshot = snapshotOf(result);
      snapshotAvailable = true;
    } catch (error) {
      failures.push(`snapshot:${reconciliationFailureCode(error)}`);
    }

    const baselinePaneIds = new Set(input.baseline.panes.map((item) => item.pane_id));
    const baselineTabIds = new Set(input.baseline.tabs.map((item) => item.tab_id));
    const newPanes = snapshot?.panes.filter((item) => !baselinePaneIds.has(item.pane_id)) ?? [];
    const newTabs = snapshot?.tabs.filter((item) => !baselineTabIds.has(item.tab_id)) ?? [];
    const snapshotPane = input.paneId === undefined
      ? newPanes.find((item) => item.label === input.agentName) ?? newPanes[0]
      : snapshot?.panes.find((item) => item.pane_id === input.paneId);
    const snapshotTab = input.tabId === undefined
      ? newTabs.find((item) => item.label === input.agentName) ?? newTabs[0]
      : snapshot?.tabs.find((item) => item.tab_id === input.tabId);
    const candidatePaneId = input.paneId ?? snapshotPane?.pane_id;
    const candidateTabId = input.tabId ?? snapshotTab?.tab_id ?? snapshotPane?.tab_id;
    currentPane = snapshotPane;
    currentAgent = candidatePaneId === undefined ? undefined : snapshot?.agents.find((item) => item.pane_id === candidatePaneId);

    // Reconciliation is structured state only. Terminal readback can contain the
    // submitted assignment, environment values, backend text, or session secrets,
    // so no transcript/output channel is part of LaunchError evidence.
    if (candidatePaneId !== undefined) {
      try {
        const result = await boundedReconciliationRead((signal) => input.cli.runJson(["pane", "get", candidatePaneId], signal).then((response) => response.result), controller.signal, deadline);
        const fetched = readbackPaneRecord(result, candidatePaneId);
        if (fetched !== undefined) currentPane = fetched;
      } catch (error) {
        failures.push(`pane:${reconciliationFailureCode(error)}`);
      }
      try {
        const result = await boundedReconciliationRead((signal) => input.cli.runJson(["agent", "get", candidatePaneId], signal).then((response) => response.result), controller.signal, deadline);
        const fetched = readbackAgentRecord(result, candidatePaneId);
        if (fetched !== undefined) currentAgent = fetched;
      } catch (error) {
        failures.push(`agent:${reconciliationFailureCode(error)}`);
      }
    }

    const paneState: LaunchReconciliationEvidence["pane"] = currentPane !== undefined
      ? "present"
      : snapshotAvailable && candidatePaneId !== undefined && !snapshot?.panes.some((item) => item.pane_id === candidatePaneId)
        ? "absent"
        : "unknown";
    const agentState: LaunchReconciliationEvidence["agent"] = currentAgent !== undefined
      ? "present"
      : snapshotAvailable && candidatePaneId !== undefined && (paneState === "absent" || (paneState === "present" && !snapshot?.agents.some((item) => item.pane_id === candidatePaneId)))
        ? "absent"
        : "unknown";
    const certainty = launchEffectCertainty(input, snapshot, currentPane, currentAgent, failures, candidatePaneId, candidateTabId);
    return {
      effectCertainty: certainty,
      snapshot: snapshotAvailable ? "present" : "unavailable",
      pane: paneState,
      agent: agentState,
      ...(candidateTabId === undefined ? {} : { tabId: safeDiagnosticString(candidateTabId) }),
      ...(candidatePaneId === undefined ? {} : { paneId: safeDiagnosticString(candidatePaneId) }),
      ...(readbackAgentId(currentAgent, currentPane) === undefined ? {} : { agentId: readbackAgentId(currentAgent, currentPane) }),
      ...(readbackAgentName(currentAgent, currentPane) === undefined ? {} : { agentName: readbackAgentName(currentAgent, currentPane) }),
      ...(failures.length === 0 ? {} : { readFailures: failures.slice(0, 8) })
    };
  } finally {
    controller.abort();
  }
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
  if (runtime.kind === "pi") {
    return {
      runtime: { kind: "pi", model: runtime.model, thinking: runtime.thinking },
      permissions: { sessionPersistence: profile.sessionPersistence, tools: [...runtime.tools], extensions: [...runtime.extensions], skills: [...runtime.skills] }
    };
  }
  if (runtime.kind === "claude") {
    return {
      runtime: { kind: "claude", model: runtime.model, effort: runtime.effort },
      permissions: { sessionPersistence: profile.sessionPersistence, permissionMode: runtime.permissionMode, allowedTools: [...runtime.allowedTools], disallowedTools: [...runtime.disallowedTools], addDirs: [...runtime.addDirs], pluginDirs: [...runtime.pluginDirs] }
    };
  }
  return {
    runtime: { kind: "agy", model: runtime.model, mode: runtime.mode, dangerouslySkipPermissions: true },
    permissions: { sessionPersistence: profile.sessionPersistence, addDirs: [...runtime.addDirs] }
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
  identity: PromptTargetIdentity | ProvisionalSupervisedIdentity;
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

function completeProvisionalReadinessIdentity(fields: Partial<PromptTargetIdentity>, paneId: string, expectedName: string): ProvisionalSupervisedIdentity | undefined {
  completeReadinessIdentity({ ...fields, agentSession: undefined }, paneId, expectedName, "agy");
  if (fields.terminalId === undefined || fields.agentName === undefined || fields.agentKind === undefined) return undefined;
  return { paneId, terminalId: fields.terminalId, agentName: fields.agentName, agentKind: "agy" };
}

function agyInteractiveReadiness(records: ReadinessRecord[]): string[] {
  const pending: string[] = [];
  for (const { source, value } of records) {
    if (!own(value, "interactive_ready") || value.interactive_ready === null || value.interactive_ready === undefined) {
      if (source === "agent_get") pending.push("agent_get_interactive_ready_missing");
      continue;
    }
    if (typeof value.interactive_ready !== "boolean") {
      throw new LaunchError("TARGET_IDENTITY_UNAVAILABLE", "AGY launch readiness interactive state is malformed", { field: "interactive_ready", source, evidenceKind: "malformed" });
    }
    if (!value.interactive_ready) pending.push(`${source}_not_interactive`);
  }
  return pending;
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

function readinessBaseline(agent: Record<string, unknown>, identity: PromptTargetIdentity | ProvisionalSupervisedIdentity, lifecycle: ReadinessLifecycle): { baseline?: PromptObservationBaseline; pending: string[] } {
  const pending: string[] = [];
  const fields = mergeReadinessIdentity([agent], identity.paneId);
  const independent = identity.agentKind === "agy" && !("agentSession" in identity)
    ? completeProvisionalReadinessIdentity(fields, identity.paneId, identity.agentName)
    : completeReadinessIdentity(fields, identity.paneId, identity.agentName, identity.agentKind);
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
  clock: LaunchClock,
  allowMissingAgentSession = false
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

        const merged = mergeReadinessIdentity([
          ...(allowMissingAgentSession ? [] : [expected.startRecord]),
          ...sampleRecords.map(({ value }) => value)
        ], paneId);
        const identity = allowMissingAgentSession
          ? completeProvisionalReadinessIdentity(merged, paneId, expectedName)
          : completeReadinessIdentity(merged, paneId, expectedName, expectedKind);
        if (identity === undefined) pending.push("identity_incomplete");
        if (allowMissingAgentSession) pending.push(...agyInteractiveReadiness(sampleRecords));

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

/**
 * The authoritative agent record's lifecycle counter, where it supplied one. A
 * launch with no `initialPrompt` has no readiness baseline, so this is the only
 * source, and an absent counter is recorded as absent rather than defaulted.
 */
function readinessStateChangeSeq(agent: Record<string, unknown>): number | undefined {
  const candidate = agent.state_change_seq;
  return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : undefined;
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

interface AgyPromptAcknowledgement {
  operationId: string;
  identity: ProvisionalSupervisedIdentity;
  agentSession?: AgentSessionIdentity;
  revision: number;
  stateChangeSeq?: number;
  screenDetectionSkipped?: boolean;
}

interface AgyPromptSubmissionEvidence extends ProvisionalSupervisedIdentity {
  confirmed: true;
  operationId: string;
  interactiveReady: true;
  agentSession?: AgentSessionIdentity;
  revision: number;
  stateChangeSeq?: number;
  screenDetectionSkipped?: boolean;
}

function agyPromptSubmissionEvidence(acknowledgement: AgyPromptAcknowledgement): AgyPromptSubmissionEvidence {
  return {
    confirmed: true,
    operationId: acknowledgement.operationId,
    ...acknowledgement.identity,
    interactiveReady: true,
    ...(acknowledgement.agentSession === undefined ? {} : { agentSession: acknowledgement.agentSession }),
    revision: acknowledgement.revision,
    ...(acknowledgement.stateChangeSeq === undefined ? {} : { stateChangeSeq: acknowledgement.stateChangeSeq }),
    ...(acknowledgement.screenDetectionSkipped === undefined ? {} : { screenDetectionSkipped: acknowledgement.screenDetectionSkipped })
  };
}

function parseAgyPromptAcknowledgement(response: JsonEnvelope, expected: ProvisionalSupervisedIdentity): AgyPromptAcknowledgement {
  if (response.id !== "cli:agent:prompt" || !record(response.result) || response.result.type !== "agent_prompted" || !record(response.result.agent)) {
    throw new LaunchError("CLI_PROTOCOL_ERROR", "Herdr prompt acknowledgement is incompatible");
  }
  const agent = response.result.agent;
  let fields: Partial<PromptTargetIdentity>;
  try {
    fields = parsePromptTargetIdentityFields(agent, expected.paneId);
  } catch (error) {
    const identityError = error as PromptIdentityError;
    throw new LaunchError("CLI_PROTOCOL_ERROR", "Herdr AGY prompt acknowledgement identity is malformed or contradictory", { causeCode: identityError.code, ...identityError.details });
  }
  const identity = completeProvisionalReadinessIdentity(fields, expected.paneId, expected.agentName);
  if (fields.paneId === undefined || identity === undefined || identity.terminalId !== expected.terminalId || identity.agentKind !== expected.agentKind) {
    throw new LaunchError("CLI_PROTOCOL_ERROR", "Herdr AGY prompt acknowledgement does not match the provisional target identity", {
      expectedPaneId: expected.paneId,
      actualPaneId: fields.paneId,
      expectedTerminalId: expected.terminalId,
      actualTerminalId: fields.terminalId,
      expectedName: expected.agentName,
      actualName: fields.agentName,
      expectedKind: expected.agentKind,
      actualKind: fields.agentKind
    });
  }
  if (agent.interactive_ready !== true) throw new LaunchError("CLI_PROTOCOL_ERROR", "Herdr AGY prompt acknowledgement did not prove an interactive target");
  const lifecycle = readinessLifecycle(agent, "agent_get");
  if (lifecycle.revision === undefined) throw new LaunchError("CLI_PROTOCOL_ERROR", "Herdr AGY prompt acknowledgement omitted the authoritative revision", { field: "revision" });
  return {
    operationId: response.id,
    identity,
    ...(fields.agentSession === undefined ? {} : { agentSession: fields.agentSession }),
    revision: lifecycle.revision,
    ...(lifecycle.stateChangeSeq === undefined ? {} : { stateChangeSeq: lifecycle.stateChangeSeq }),
    ...(lifecycle.screenDetectionSkipped === undefined ? {} : { screenDetectionSkipped: lifecycle.screenDetectionSkipped })
  };
}

function agyPromptUnconfirmed(
  acknowledgement: AgyPromptAcknowledgement,
  clock: LaunchClock,
  startedAt: number,
  samples: number,
  reason: PromptConfirmationEvidence["reason"],
  baseline: PromptObservationBaseline,
  last?: PromptObservation,
  sourceCode?: string
): LaunchError {
  return new LaunchError("PROMPT_UNCONFIRMED", "AGY initial prompt consumption and native session identity were not proven", {
    causeCode: "PROMPT_UNCONFIRMED",
    promptSubmitted: true,
    promptConsumption: "unconfirmed",
    initialPromptSubmission: agyPromptSubmissionEvidence(acknowledgement),
    ...(last === undefined ? {} : { initialPromptObservation: last }),
    promptConfirmation: promptConfirmationEvidence(clock, startedAt, samples, reason, baseline, last, sourceCode)
  });
}

async function confirmAgyNativeSession(
  cli: LaunchCli,
  callerSignal: AbortSignal,
  acknowledgement: AgyPromptAcknowledgement,
  baseline: PromptObservationBaseline,
  clock: LaunchClock,
  startedAt: number
): Promise<{ identity: PromptTargetIdentity; agent: Record<string, unknown>; pane: Record<string, unknown>; submission: PromptSubmissionEvidence; observation: PromptObservation; confirmation: PromptConfirmationEvidence }> {
  const window = createReadWindow(callerSignal, startedAt + PROMPT_CONFIRMATION_TIMEOUT_MS, clock);
  let samples = 0;
  let last: PromptObservation | undefined;
  let observedSession = acknowledgement.agentSession;
  try {
    while (true) {
      window.assertActive();
      samples += 1;
      let snapshot: HerdrSnapshot;
      let agent: Record<string, unknown>;
      let pane: Record<string, unknown>;
      try {
        snapshot = snapshotOf(await readWithinWindow(cli, ["api", "snapshot"], window));
        agent = agentGetRecord(await readWithinWindow(cli, ["agent", "get", acknowledgement.identity.paneId], window));
        pane = paneRecord(await readWithinWindow(cli, ["pane", "get", acknowledgement.identity.paneId], window), acknowledgement.identity.paneId);
      } catch (error) {
        if (window.cancellation()) throw error;
        const sourceCode = record(error) && typeof error.code === "string" ? error.code : "POSTSTATE_UNAVAILABLE";
        throw agyPromptUnconfirmed(acknowledgement, clock, startedAt, samples, sourceCode === "TARGET_IDENTITY_UNAVAILABLE" ? "identity_unavailable" : "read_failed", baseline, last, sourceCode);
      }

      const snapshotRecords = snapshotReadinessRecords(snapshot, acknowledgement.identity.paneId);
      if (snapshotRecords.duplicates !== undefined) {
        throw agyPromptUnconfirmed(acknowledgement, clock, startedAt, samples, "contradictory", baseline, last, "TARGET_IDENTITY_UNAVAILABLE");
      }
      if (snapshotRecords.pending.length > 0) {
        throw agyPromptUnconfirmed(acknowledgement, clock, startedAt, samples, "identity_unavailable", baseline, last, "TARGET_IDENTITY_UNAVAILABLE");
      }
      const records = [...snapshotRecords.records, { source: "agent_get" as const, value: agent }, { source: "pane_get" as const, value: pane }];
      try {
        for (const item of records) {
          const pending = requiredReadinessPaneId(item.value, acknowledgement.identity.paneId, item.source);
          if (pending) throw new LaunchError("TARGET_IDENTITY_UNAVAILABLE", "AGY native-session confirmation record omitted its pane identity", { source: item.source });
        }
        const merged = mergeReadinessIdentity(records.map(({ value }) => value), acknowledgement.identity.paneId);
        const provisional = completeProvisionalReadinessIdentity(merged, acknowledgement.identity.paneId, acknowledgement.identity.agentName);
        if (provisional === undefined || provisional.terminalId !== acknowledgement.identity.terminalId) {
          throw new LaunchError("TARGET_IDENTITY_CHANGED", "AGY native-session confirmation does not match the provisional target");
        }
        const identity = completeReadinessIdentity(merged, acknowledgement.identity.paneId, acknowledgement.identity.agentName, "agy");
        if (identity === undefined) {
          last = { status: "unavailable", code: "POSTSTATE_IDENTITY_UNAVAILABLE" };
          await waitForReadPoll(window, PROMPT_CONFIRMATION_POLL_INTERVAL_MS);
          continue;
        }
        if (observedSession !== undefined && !sameSession(observedSession, identity.agentSession)) {
          throw new LaunchError("TARGET_IDENTITY_CHANGED", "AGY native session changed during confirmation");
        }
        observedSession = identity.agentSession;

        // Lifecycle is coherent only within the authoritative agent-get record.
        // Snapshot and pane records prove identity continuity across the sequential
        // reads, but their lifecycle values may describe adjacent observations.
        const lifecycleAgent = { ...agent };
        delete lifecycleAgent.screen_detection_skipped;
        const authoritative = readinessLifecycle(lifecycleAgent, "agent_get");
        if (typeof agent.screen_detection_skipped === "boolean") authoritative.screenDetectionSkipped = agent.screen_detection_skipped;
        const completeLifecycle = authoritative.agentStatus !== undefined
          && authoritative.stateChangeSeq !== undefined
          && authoritative.revision !== undefined;
        last = {
          status: authoritative.agentStatus === undefined
            ? "unavailable"
            : authoritative.agentStatus === "working"
              ? "working"
              : authoritative.agentStatus === "unknown" ? "unknown" : "not_working",
          ...(authoritative.agentStatus === undefined ? {} : { state: authoritative.agentStatus }),
          ...(authoritative.stateChangeSeq === undefined ? {} : { stateChangeSeq: authoritative.stateChangeSeq }),
          ...(authoritative.revision === undefined ? {} : { revision: authoritative.revision }),
          ...(authoritative.screenDetectionSkipped === undefined ? {} : { screenDetectionSkipped: authoritative.screenDetectionSkipped })
        };
        if (!completeLifecycle
          || authoritative.agentStatus === "unknown"
          || authoritative.stateChangeSeq! <= baseline.stateChangeSeq
          || authoritative.revision! < Math.max(baseline.revision, acknowledgement.revision)) {
          await waitForReadPoll(window, PROMPT_CONFIRMATION_POLL_INTERVAL_MS);
          continue;
        }
        last.consumption = "confirmed";
        const confirmation = promptConfirmationEvidence(clock, startedAt, samples, authoritative.agentStatus === "working" ? "working" : "state_change_seq_advanced", baseline, last);
        return {
          identity,
          agent,
          pane,
          submission: {
            confirmed: true,
            operationId: acknowledgement.operationId,
            ...identity,
            interactiveReady: true,
            revision: acknowledgement.revision,
            ...(acknowledgement.stateChangeSeq === undefined ? {} : { stateChangeSeq: acknowledgement.stateChangeSeq }),
            ...(acknowledgement.screenDetectionSkipped === undefined ? {} : { screenDetectionSkipped: acknowledgement.screenDetectionSkipped })
          },
          observation: last,
          confirmation
        };
      } catch (error) {
        if (window.cancellation()) throw error;
        const sourceCode = error instanceof LaunchError ? error.code : "POSTSTATE_UNAVAILABLE";
        const reason: PromptConfirmationEvidence["reason"] = sourceCode === "TARGET_IDENTITY_CHANGED" ? "identity_changed" : sourceCode === "TARGET_IDENTITY_UNAVAILABLE" ? "identity_unavailable" : "contradictory";
        throw agyPromptUnconfirmed(acknowledgement, clock, startedAt, samples, reason, baseline, last, sourceCode);
      }
    }
  } catch (error) {
    if (error instanceof LaunchError && error.code === "PROMPT_UNCONFIRMED") throw error;
    if (window.cancellation()?.reason === "deadline") throw agyPromptUnconfirmed(acknowledgement, clock, startedAt, samples, "timeout", baseline, last);
    throw agyPromptUnconfirmed(acknowledgement, clock, startedAt, samples, "caller_aborted", baseline, last, "ABORTED");
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

function launchTransportCode(error: unknown): string {
  return error instanceof LaunchError
    ? error.code
    : error instanceof CliProtocolError
      ? error.code
      : error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "CLI_PROTOCOL_ERROR";
}

/**
 * The cause's own prose, bounded for details. It is retained only here: it may
 * hold backend text or caller-supplied input, so it never reaches the fixed
 * model-visible summary.
 */
function causeMessage(error: unknown): string | undefined {
  return safeDiagnosticString(error instanceof Error ? error.message : String(error), 1_024);
}

function earlyLaunchFailure(error: unknown, phase: LaunchPhase): LaunchError {
  const transportCode = launchTransportCode(error);
  const code = safeLaunchCode(transportCode);
  const message = causeMessage(error);
  const originalDetails = error instanceof LaunchError
    ? error.details
    : record(error) && record(error.details) ? error.details : {};
  const cliFailure = error instanceof LaunchError ? compactCliFailureEvidence(originalDetails.cliFailure) : cliFailureEvidence(error);
  const details = {
    ...originalDetails,
    phase,
    created: {},
    causeCode: typeof originalDetails.causeCode === "string" ? originalDetails.causeCode : safeDiagnosticString(transportCode, 120) ?? code,
    ...(message === undefined ? {} : { causeMessage: message }),
    agentStarted: false,
    promptSubmitted: false,
    recipientRegistered: false,
    effectCertainty: "absent" as const,
    ...(cliFailure === undefined ? {} : { cliFailure })
  };
  return new LaunchError(code, LAUNCH_DIAGNOSTIC_SUMMARY, details, {
    phase,
    created: {},
    agentStarted: false,
    promptSubmitted: false,
    recipientRegistered: false,
    effectCertainty: "absent",
    recoveryGuidance: diagnosticRecovery("absent", false, false)
  });
}

function failureEffectCertainty(
  effects: { agentStarted: boolean; promptSubmitted: boolean },
  mutationDispatched: boolean,
  reconciliation: LaunchReconciliationEvidence | undefined
): LaunchEffectCertainty {
  if (reconciliation !== undefined) return reconciliation.effectCertainty;
  /* c8 ignore next -- current launch control always reconciles after a dispatched effect. */
  if (effects.promptSubmitted || effects.agentStarted || mutationDispatched) return "unknown";
  return "absent";
}

function partialError(
  error: unknown,
  created: LaunchResourceIds,
  phase: LaunchPhase,
  grant: RecipientGrant,
  effects: { agentStarted: boolean; promptSubmitted: boolean; recipientRegistered: boolean; mutationDispatched: boolean; assignmentState?: "confirmed" | "unconfirmed"; initialPromptSubmission?: AgyPromptSubmissionEvidence; readiness?: LaunchReadinessEvidence; supervision?: NonNullable<LaunchDetails["supervision"]>; timing: LaunchTimingEvidence; attempts: LaunchAttemptEvidence[] },
  delivery?: MessageDelivery,
  published?: PublishedAttachment,
  reconciliation?: LaunchReconciliationEvidence
): LaunchError {
  const transportCode = launchTransportCode(error);
  const backend = phase === "agent_start" ? cliErrorEnvelope(error) : undefined;
  const causeCode = error instanceof LaunchError && typeof error.details.causeCode === "string"
    ? error.details.causeCode
    : backend?.id === "cli:agent:start" ? backend.error.code : transportCode;
  const message = causeMessage(error);
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
  const effectCertainty = failureEffectCertainty(effects, effects.mutationDispatched, reconciliation);
  const supervisionPaneId = effects.supervision?.state === "active"
    ? effects.supervision.child.paneId
    : effects.supervision?.provisional.paneId;
  const details = {
    ...supplementalDetails,
    phase,
    created: { ...created },
    causeCode,
    ...(message === undefined ? {} : { causeMessage: message }),
    agentStarted: effects.agentStarted,
    promptSubmitted: effects.promptSubmitted,
    recipientRegistered: effects.recipientRegistered,
    ...(effects.assignmentState === undefined ? {} : { assignmentState: effects.assignmentState }),
    ...(effects.initialPromptSubmission === undefined ? {} : { initialPromptSubmission: effects.initialPromptSubmission }),
    ...(effects.supervision === undefined ? {} : { paneId: supervisionPaneId, supervisorJobId: effects.supervision.jobId, supervision: effects.supervision }),
    effectCertainty,
    ...(Object.keys(effects.timing).length === 0 ? {} : { timing: effects.timing }),
    ...(effects.attempts.length === 0 ? {} : { attempts: effects.attempts }),
    ...(cliFailure ? { cliFailure } : {}),
    ...(delivery ? { delivery, initialPromptDelivery: delivery } : {}),
    recipientGrant: { path: grant.path },
    ...(published ? { attachmentRetained: true, attachment: { ...published } } : {}),
    ...(readiness === undefined ? {} : { readiness }),
    ...(reconciliation === undefined ? {} : { reconciliation })
  };
  const assignmentUnconfirmed = effects.assignmentState === "unconfirmed" && effects.supervision !== undefined;
  return new LaunchError(code, LAUNCH_DIAGNOSTIC_SUMMARY, details, {
    phase,
    created,
    ...(assignmentUnconfirmed ? {
      paneId: supervisionPaneId,
      supervisorJobId: effects.supervision!.jobId,
      assignmentState: "unconfirmed" as const,
    } : {}),
    agentStarted: effects.agentStarted,
    promptSubmitted: effects.promptSubmitted,
    recipientRegistered: effects.recipientRegistered,
    effectCertainty,
    recoveryGuidance: assignmentUnconfirmed
      ? LAUNCH_RECOVERY_GUIDANCE.preserveUnconfirmed
      : diagnosticRecovery(effectCertainty, effects.promptSubmitted, effects.mutationDispatched)
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
  const contextResolver = deps.contextResolver ?? createContextResolver(deps.cli, deps.context);
  return {
    name: "herdr_launch",
    label: "Herdr Launch",
    description: "Launch a named Pi, Claude, or AGY Herdr agent from a strict profile in an explicitly selected pane placement.",
    parameters: LaunchParamsSchema,
    async execute(_id, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as unknown as LaunchRequest;
      let launchGate: LaunchGateLease | undefined;
      try {
        launchGate = await (deps.launchGate ?? (() => acquireLaunchGate()))();
        await launchGate.check();
      } catch {
        await launchGate?.release().catch(() => undefined);
        throw new LaunchError("PROFILE_LAUNCH_FROZEN", "Profile launch is frozen");
      }
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
      let contextDiagnostics: ContextResolutionDiagnostics | undefined;
      let effectiveContext: CurrentContext | undefined;
      let topologyBaseline: HerdrSnapshot | undefined;
      let topologyMutationDispatched = false;
      let reservation: SupervisionReservation | undefined;
      let phase: LaunchPhase = "validate";
      const created: LaunchResourceIds = {};
      const attempts: LaunchAttemptEvidence[] = [];
      const dispatchMutation = async <T>(operation: () => Promise<T>): Promise<T> => {
        // A pre-aborted caller has not dispatched a mutation. Once the signal is
        // live, mark before invoking the adapter because an in-flight failure can
        // still have committed a topology or prompt effect.
        if (abortSignal.aborted) throw new LaunchError("ABORTED", "Operation aborted");
        topologyMutationDispatched = true;
        return operation();
      };
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
        // AGY's mandatory assignment is the initial prompt, so a promptless launch
        // is refused only when AGY is the requested profile. A merely reachable AGY
        // fallback is dropped from the launchable chain instead, because starting it
        // without a prompt could never strengthen past provisional supervision, and
        // refusing the whole request would block every promptless launch of a
        // non-AGY chain such as `worker-pi -> worker-agy -> worker-claude`.
        if (params.initialPrompt === undefined) {
          if (profileResolution.profile.runtime.kind === "agy") throw new LaunchError("INVALID_INPUT", "AGY launches require initialPrompt");
          for (const candidate of profiles) {
            if (candidate.runtime.kind === "agy") attempts.push({ profile: candidate.name, outcome: "fallback_refused", errorCode: "INVALID_INPUT", message: "AGY fallback requires initialPrompt" });
          }
          profiles = profiles.filter((candidate) => candidate.runtime.kind !== "agy");
        }
        // Every reachable fallback profile is checked before the first launch
        // effect. Bundled canonical edits are materialized here; unsafe trees
        // and edited generated copies still fail before any effect.
        for (const profile of profiles) {
          const overrides = profile.name === params.profile ? params.overrides : {};
          const runtime = resolveProfileRuntime(profile, overrides);
          effectiveRuntimes.set(profile.name, runtime);
          await assertResourceSelection(profile, runtime, true);
        }
        recipientKey = mintRecipientKey();
        grant = await attachmentStore.ensureRecipient(recipientKey);
        const promptStore = deps.promptSources ?? defaultPromptSourceStore;
        for (const profile of profiles) {
          const overrides = profile.name === params.profile ? params.overrides : {};
          const runtime = effectiveRuntimes.get(profile.name)!;
          const capability = attachmentCapability(profile, overrides);
          capabilities.set(profile.name, capability);
          // Any profile the fallback chain can start may be the one that receives the
          // reference, so an attachment launch requires every one of them to be capable.
          if (initialPromptDelivery === "attachment" && !capability.capable) {
            throw new LaunchError("ATTACHMENT_TARGET_UNVERIFIED", "Profile cannot read a local attachment", { profile: profile.name, reason: capability.reason });
          }
          const promptPath = runtime.kind === "agy" ? undefined : (await promptStore.create(profile.body)).path;
          if (promptPath !== undefined) promptPaths.set(profile.name, promptPath);
          buildRuntimeArgv(profile, runtime, promptPath, grant.path);
        }
        const effective = await contextResolver(abortSignal);
        contextDiagnostics = effective.diagnostics;
        const snapshot = effective.snapshot;
        topologyBaseline = snapshot;
        effectiveContext = effective.context;
        const currentContext = effective.context;
        sender = params.initialPrompt !== undefined ? resolveSender(snapshot, currentContext.paneId) : undefined;
        if (existingAgentNames(snapshot).filter((name) => name === params.name).length > 0) {
          throw new LaunchError("INVALID_INPUT", `Agent name is already in use: ${params.name}`);
        }
        existingTarget = placement.mode === "existing_pane" ? paneForPlacement(snapshot, placement.target, currentContext) : undefined;
        workspaceId = placement.mode === "new_tab" ? currentContext.workspaceId : undefined;
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
        // Supervision is reserved before the first topology mutation, so a host
        // that cannot supervise refuses the launch with no effect at all rather
        // than leaving a child nobody is watching.
        phase = "supervision_reserve";
        progress(onUpdate, phase, created);
        try {
          reservation = await deps.supervision.reserve({ child: { agentName: params.name, agentKind: profiles[0]!.runtime.kind, profileName: profiles[0]!.name } });
        } catch (error) {
          throw new LaunchError("SUPERVISION_UNAVAILABLE", "Automatic child supervision could not be reserved", {
            causeCode: safeDiagnosticString(record(error) && typeof error.code === "string" ? error.code : undefined, 120) ?? "SUPERVISION_UNAVAILABLE"
          });
        }
      } catch (error) {
        const failure = withDeliveryFailureEvidence(error, { delivery: requestedDelivery, phase, published });
        try {
          await grant?.release();
          reservation?.release("launch_precondition_failed");
        } finally {
          await launchGate?.release();
        }
        throw earlyLaunchFailure(failure, phase);
      }
      let paneId: string | undefined;
      let tabId: string | undefined;
      let agentStarted = false;
      let promptSubmitted = false;
      let assignmentState: "confirmed" | "unconfirmed" | undefined;
      let recipientRegistered = false;
      let supervisionBound = false;
      let boundSupervision: LaunchDetails["supervision"] | undefined;
      let readiness: LaunchReadinessEvidence | undefined;
      let agyInitialPromptSubmission: AgyPromptSubmissionEvidence | undefined;
      let selectedAttemptStartedAt: number | undefined;
      const timing: LaunchTimingEvidence = {};
      try {
        phase = "placement";
        progress(onUpdate, phase, created);
        if (placement.mode === "existing_pane") {
          paneId = existingTarget!.paneId!;
          tabId = existingTarget!.tabId;
        } else if (placement.mode === "new_tab") {
          const result = tabRefFrom(await dispatchMutation(() => run(deps.cli, ["tab", "create", "--workspace", workspaceId!, "--cwd", cwd, "--label", placement.tabLabel, ...noFocusArgs()], abortSignal, true)));
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
          const result = paneRefFrom(await dispatchMutation(() => run(deps.cli, ["pane", "split", "--current", "--direction", "right", ...noFocusArgs(), "--cwd", cwd], abortSignal, true)));
          paneId = result.paneId;
          tabId = result.tabId ?? effectiveContext!.tabId;
          created.paneId = paneId;
          created.tabId = tabId;
          deps.ownership?.record({ kind: "pane", id: paneId!, parentId: tabId! });
        }
        const resolvedPaneId = paneId!;
        if (placement.mode !== "existing_pane") {
          await dispatchMutation(() => run(deps.cli, ["pane", "rename", resolvedPaneId, label], abortSignal));
        }
        phase = "agent_start";
        progress(onUpdate, phase, created);
        let started: unknown;
        let selectedProfile: Profile | undefined;
        let selectedRuntime: RuntimeProfile | undefined;
        let startedAgent: StartedAgent | undefined;
        for (const profile of profiles) {
          const runtime = effectiveRuntimes.get(profile.name)!;
          await launchGate!.check();
          // Re-validated for this attempt immediately before its argv is built,
          // because the preflight above is separated from the spawn by recipient
          // creation, prompt-source writes, context resolution, supervision
          // reservation, and topology mutation -- a window of seconds and several
          // CLI round-trips in which a swapped skill tree or repointed symlink
          // would otherwise reach the agent unchecked. This narrows that window
          // to the gap between the last digest read and the child's own open();
          // it does not close it, because the CLI accepts paths rather than open
          // handles. The residual is bounded: winning it needs write access to
          // the profile scope root or a canonical source tree, and anyone with
          // that access can already edit the package's own code or registry, so
          // the race grants no capability they lack.
          await assertResourceSelection(profile, runtime);
          const startArgs = ["agent", "start", params.name, "--kind", runtime.kind, "--pane", resolvedPaneId, "--timeout", String(HERDR_AGENT_START_TIMEOUT_MS), "--", ...buildRuntimeArgv(profile, runtime, promptPaths.get(profile.name), grant!.path)];
          const attemptStartedAt = clock.now();
          try {
            started = await dispatchMutation(() => run(deps.cli, startArgs, abortSignal, true));
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
          clock,
          chosenRuntime.kind === "agy"
        );
        readiness = ready.evidence;
        timing.selectedStartReadinessMs = readiness.elapsedMs;
        let capturedIdentity = ready.identity;
        agentId ??= idFrom(ready.agent, "agent_id") ?? idFrom(ready.agent, "id") ?? idFrom(ready.pane, "agent_id");
        phase = "supervision_bind";
        progress(onUpdate, phase, created);
        const stateChangeSeq = ready.baseline?.stateChangeSeq ?? readinessStateChangeSeq(ready.agent);
        try {
          // AGY publishes only reduced evidence before assignment. Existing
          // runtimes keep their exact pre-prompt session binding unchanged.
          if (chosenRuntime.kind === "agy") {
            const provisionalIdentity = capturedIdentity as ProvisionalSupervisedIdentity;
            const provisionalBaseline = { ...ready.baseline!, state: "idle" as const };
            await reservation!.bindProvisional({ identity: provisionalIdentity, profileName: chosenProfile.name, baseline: provisionalBaseline });
            boundSupervision = {
              jobId: reservation!.jobId,
              state: "provisional",
              provisional: { ...provisionalIdentity, profileName: chosenProfile.name, baseline: provisionalBaseline }
            };
          } else {
            const exactIdentity = capturedIdentity as PromptTargetIdentity;
            await reservation!.bind({ identity: exactIdentity, profileName: chosenProfile.name, ...(stateChangeSeq === undefined ? {} : { stateChangeSeq }) });
            boundSupervision = {
              jobId: reservation!.jobId,
              state: "active",
              child: { agentName: exactIdentity.agentName, agentKind: exactIdentity.agentKind, paneId: resolvedPaneId, terminalId: exactIdentity.terminalId, profileName: chosenProfile.name }
            };
          }
        } catch (error) {
          if (!(error instanceof SupervisionBindError)) throw error;
          throw new LaunchError("SUPERVISION_UNCONFIRMED", "Automatic child supervision could not be bound to the launched agent", {
            causeCode: "SUPERVISION_UNCONFIRMED",
            supervisionJobId: reservation!.jobId,
            supervisionEvidence: boundAgentSessionStrings(error.details)
          });
        }
        supervisionBound = true;
        if (params.focus === true) {
          phase = "focus";
          progress(onUpdate, phase, created);
          await dispatchMutation(() => run(deps.cli, ["agent", "focus", resolvedPaneId], abortSignal));
        }
        if (agentId) created.agentId = agentId;

        let initialPromptSent = false;
        let promptConsumption: PromptConsumption | undefined;
        let initialPromptSubmission: PromptSubmissionEvidence | undefined;
        let initialPromptObservation: PromptObservation | undefined;
        let promptConfirmation: PromptConfirmationEvidence | undefined;
        let postState: Record<string, unknown> | undefined = ready.pane;
        if (params.initialPrompt !== undefined) {
          assignmentState = "unconfirmed";
          // Readiness returned this baseline from the same coherent sample that
          // captured identity; there is no later one-shot baseline read.
          const baseline = ready.baseline!;
          const envelope = initialPromptDelivery === "attachment"
            ? buildEnvelope(sender!, "assignment", params.initialPrompt, "attachment", { ...published!, encoding: "utf-8" })
            : buildEnvelope(sender!, "assignment", params.initialPrompt, "inline");
          phase = "prompt_verification";
          progress(onUpdate, phase, created);
          const promptSubmissionStartedAt = clock.now();
          let agyAcknowledgement: AgyPromptAcknowledgement | undefined;
          try {
            const promptResponse = await dispatchMutation(() => runPrompt(deps.cli, resolvedPaneId, envelope, abortSignal));
            promptSubmitted = true;
            if (chosenRuntime.kind === "agy") {
              agyAcknowledgement = parseAgyPromptAcknowledgement(promptResponse, capturedIdentity as ProvisionalSupervisedIdentity);
              agyInitialPromptSubmission = agyPromptSubmissionEvidence(agyAcknowledgement);
            } else {
              initialPromptSubmission = parsePromptSubmission(promptResponse, capturedIdentity as PromptTargetIdentity);
            }
          } finally {
            timing.promptSubmissionAckMs = monotonicDurationMs(clock, promptSubmissionStartedAt);
          }

          if (chosenRuntime.kind === "agy") {
            const confirmationStartedAt = clock.now();
            try {
              const confirmed = await confirmAgyNativeSession(deps.cli, abortSignal, agyAcknowledgement!, baseline, clock, confirmationStartedAt);
              initialPromptSubmission = confirmed.submission;
              initialPromptObservation = confirmed.observation;
              promptConfirmation = confirmed.confirmation;
              timing.postAckConfirmationMs = confirmed.confirmation.elapsedMs;
              postState = confirmed.pane;
              capturedIdentity = confirmed.identity;
              agentId ??= idFrom(confirmed.agent, "agent_id") ?? idFrom(confirmed.agent, "id") ?? idFrom(confirmed.pane, "agent_id");
              phase = "supervision_bind";
              progress(onUpdate, phase, created);
              await reservation!.strengthen({ identity: confirmed.identity, profileName: chosenProfile.name, stateChangeSeq: confirmed.observation.stateChangeSeq });
              boundSupervision = {
                jobId: reservation!.jobId,
                state: "active",
                child: { agentName: confirmed.identity.agentName, agentKind: confirmed.identity.agentKind, paneId: resolvedPaneId, terminalId: confirmed.identity.terminalId, profileName: chosenProfile.name }
              };
              phase = "prompt_verification";
            } catch (error) {
              const errorDetails = record(error) && record(error.details) ? error.details : undefined;
              const confirmation = errorDetails?.promptConfirmation;
              if (record(confirmation) && typeof confirmation.elapsedMs === "number") timing.postAckConfirmationMs = confirmation.elapsedMs;
              throw error;
            }
          } else {
            const confirmationStartedAt = clock.now();
            try {
              const confirmed = await confirmPromptConsumption(deps.cli, resolvedPaneId, abortSignal, initialPromptSubmission!, baseline, clock, confirmationStartedAt);
              initialPromptObservation = confirmed.observation;
              promptConfirmation = confirmed.confirmation;
              timing.postAckConfirmationMs = confirmed.confirmation.elapsedMs;
              postState = confirmed.pane;
              agentId ??= idFrom(confirmed.agent, "agent_id") ?? idFrom(confirmed.agent, "id") ?? idFrom(confirmed.pane, "agent_id");
            } catch (error) {
              const errorDetails = record(error) && record(error.details) ? error.details : undefined;
              const confirmation = errorDetails?.promptConfirmation;
              if (record(confirmation) && typeof confirmation.elapsedMs === "number") timing.postAckConfirmationMs = confirmation.elapsedMs;
              if (error instanceof LaunchError && error.code === "PROMPT_UNCONFIRMED") {
                throw new LaunchError(error.code, error.message, {
                  ...error.details,
                  paneId: resolvedPaneId,
                  supervisorJobId: reservation!.jobId,
                  assignmentState: "unconfirmed",
                  supervision: boundSupervision!,
                });
              }
              throw error;
            }
          }
          promptConsumption = "confirmed";
          assignmentState = "confirmed";
          initialPromptSent = true;
          if (agentId) created.agentId = agentId;
        }
        const exactIdentity = capturedIdentity as PromptTargetIdentity;
        const authoritativeName = exactIdentity.agentName;
        const capability = capabilities.get(chosenProfile.name)!;
        const recipient = { recipientKey: recipientKey!, paneId: resolvedPaneId, agentName: authoritativeName, ...(agentId ? { agentId } : {}), profileName: chosenProfile.name, kind: capability.kind, capable: capability.capable, reason: capability.reason };
        deps.recipients?.recordFor(
          chosenProfile.name,
          resolvedPaneId,
          recipient.recipientKey,
          capability,
          { ...exactIdentity, ...(agentId ? { agentId } : {}) },
          chosenRuntime.kind === "agy" ? { agyStrengthened: true, attachmentDirectory: grant!.path } : undefined
        );
        recipientRegistered = deps.recipients !== undefined;
        const effective = effectiveDetails(chosenProfile, chosenRuntime);
        const launchDetails: LaunchDetails = {
          operation: "launch", outcome: "launched", name: authoritativeName, kind: chosenRuntime.kind, placement, tabId, paneId: resolvedPaneId,
          ...contextRebindingDetails(contextDiagnostics!),
          ...(agentId ? { agentId } : {}),
          postState: boundAgentSessionStrings(modelSafeJson(postState)) as Record<string, unknown>,
          agentStarted,
          initialPromptSent,
          promptSubmitted,
          recipientRegistered,
          readiness,
          ...(params.initialPrompt === undefined ? {} : { promptConsumption, assignmentState: assignmentState! }),
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
          effectCertainty: "confirmed",
          supervision: boundSupervision!,
          profile: {
            name: chosenProfile.name, requested: params.profile, selected: chosenProfile.name,
            source: { kind: chosenProfile.source.kind, path: chosenProfile.source.path }, timeoutMinutes: chosenProfile.timeoutMinutes,
            runtime: effective.runtime, permissions: effective.permissions, attempts,
            fallbackProfiles: [...profileResolution!.fallbackProfiles], reachableNames: [...profileResolution!.reachableNames], sessionPersistence: chosenProfile.sessionPersistence
          }
        };
        return {
          content: [{ type: "text", text: `${formatResult({ operation: "launch", outcome: "success", targetId: paneId, delivery: initialPromptDelivery })} · supervisor ${reservation!.jobId}` }],
          details: launchDetails
        };
      } catch (error) {
        if (agentStarted && selectedAttemptStartedAt !== undefined && timing.selectedStartReadinessMs === undefined) {
          const failureReadiness = error instanceof LaunchError && record(error.details.readiness)
            ? error.details.readiness.elapsedMs
            : undefined;
          timing.selectedStartReadinessMs = typeof failureReadiness === "number" && Number.isSafeInteger(failureReadiness) && failureReadiness >= 0
            ? failureReadiness
            : monotonicDurationMs(clock, selectedAttemptStartedAt);
        }
        let reconciliation: LaunchReconciliationEvidence | undefined;
        if (topologyMutationDispatched) {
          try {
            reconciliation = await reconcileLaunch({
              cli: deps.cli,
              baseline: topologyBaseline!,
              ...(paneId === undefined ? {} : { paneId }),
              ...(tabId === undefined ? {} : { tabId }),
              agentStarted,
              promptSubmitted,
              agentName: params.name
            });
          } catch (readbackError) {
            reconciliation = {
              effectCertainty: "unknown",
              snapshot: "unavailable",
              pane: "unknown",
              agent: "unknown",
              readFailures: [`reconciliation:${reconciliationFailureCode(readbackError)}`]
            };
          }
          if (reconciliation?.tabId !== undefined && created.tabId === undefined) created.tabId = reconciliation.tabId;
          if (reconciliation?.paneId !== undefined && created.paneId === undefined) created.paneId = reconciliation.paneId;
          if (reconciliation?.agentId !== undefined && created.agentId === undefined) created.agentId = reconciliation.agentId;
        }
        // Releasing an unbound reservation settles its job; a committed exact
        // supervisor is retained through every later launch failure.
        if (!supervisionBound) reservation?.release(`launch_failed_${phase}`);
        throw partialError(error, created, phase, grant!, {
          agentStarted,
          promptSubmitted,
          recipientRegistered,
          mutationDispatched: topologyMutationDispatched,
          ...(assignmentState === undefined ? {} : { assignmentState }),
          ...(agyInitialPromptSubmission === undefined ? {} : { initialPromptSubmission: agyInitialPromptSubmission }),
          ...(readiness === undefined ? {} : { readiness }),
          ...(boundSupervision === undefined ? {} : { supervision: boundSupervision }),
          timing,
          attempts,
        }, initialPromptDelivery, published, reconciliation);
      } finally {
        // The launch window is over; the directory is kept only by its own content.
        try {
          await grant?.release();
        } finally {
          await launchGate?.release();
        }
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

export { validateParams as validateLaunchParams, boundedReconciliationRead as boundedLaunchReconciliationRead };
