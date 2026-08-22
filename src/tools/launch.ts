import type { AgentToolUpdateCallback, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { boundedEvidence, CliProtocolError, HERDR_AGENT_START_TIMEOUT_MS, type HerdrErrorEnvelope, type JsonEnvelope } from "../cli.js";
import type { CompatibilityPreflight } from "../health.js";
import { withDeliveryFailureEvidence } from "../messages/failure.js";
import { assertDeliverySize, assertMessageText, type MessageDelivery } from "../messages/limits.js";
import { boundAgentSessionStrings, classifyPromptObservation, compactPromptSubmission, parsePromptSubmission, parsePromptTargetIdentityFields, PromptIdentityError, requirePromptTargetIdentity, joinPromptTargetIdentity, samePromptTargetIdentity, unavailablePromptObservation, type PromptObservation, type PromptSubmissionEvidence, type PromptTargetIdentity } from "../messages/prompt.js";
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

export interface LaunchDetails extends LaunchResourceIds {
  operation: "launch";
  outcome: "launched" | "partial";
  name?: string;
  kind?: string;
  placement?: LaunchPlacement;
  postState?: Record<string, unknown>;
  initialPromptSent?: boolean;
  initialPromptDelivery?: MessageDelivery;
  initialPromptSubmission?: PromptSubmissionEvidence;
  initialPromptObservation?: PromptObservation;
  phase?: "validate" | "resolve_profile" | "attachment_publish" | "placement" | "agent_start" | "ready" | "prompt_verification";
  created?: LaunchResourceIds;
  causeCode?: string;
  sender?: { paneId: string; display: string; source: SenderIdentity["source"] };
  envelope?: { version: "v1"; kind: "assignment"; delivery: MessageDelivery };
  attachment?: PublishedAttachment;
  recipient?: { recipientKey: string; paneId: string; agentName: string; agentId?: string; profileName: string; kind: "pi" | "claude"; capable: boolean; reason: string };
  profile?: LaunchEffectiveProfile & { name: string; sessionPersistence: boolean };
}

const LAUNCH_IDENTITY_PREFLIGHT_TIMEOUT_MS = 5_000;
const LAUNCH_IDENTITY_PREFLIGHT_POLL_INTERVAL_MS = 100;

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
  let fields: Partial<PromptTargetIdentity>;
  try {
    // Herdr 0.8.2 can omit identity fields from agent_started. Validate every
    // field it does supply now, but let one bounded fresh read-only sample fill
    // only the missing fields. No expected value is fabricated into startRecord.
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

function snapshotIdentityRecords(snapshot: HerdrSnapshot, paneId: string): Record<string, unknown>[] {
  const panes = snapshot.panes.filter((pane) => pane.pane_id === paneId);
  const agents = snapshot.agents.filter((agent) => agent.pane_id === paneId);
  if (panes.length !== 1 || agents.length !== 1) {
    throw new LaunchError("TARGET_IDENTITY_UNAVAILABLE", "Fresh post-start snapshot does not contain one authoritative target agent", { paneId, paneRecords: panes.length, agentRecords: agents.length });
  }
  return [panes[0]!, agents[0]!];
}

function compactIdentityRecord(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of ["pane_id", "terminal_id", "name", "agent_name", "agent", "agent_kind", "kind", "agent_status", "revision", "state_change_seq", "interactive_ready", "screen_detection_skipped"] as const) {
    const candidate = value[field];
    if (candidate === undefined) continue;
    result[field] = typeof candidate === "string" ? candidate.slice(0, 256) : candidate;
  }
  const session = value.agent_session;
  if (record(session)) {
    result.agent_session = {
      source: typeof session.source === "string" ? session.source.slice(0, 256) : "",
      agent: typeof session.agent === "string" ? session.agent.slice(0, 256) : "",
      kind: typeof session.kind === "string" ? session.kind.slice(0, 256) : "",
      value: typeof session.value === "string" ? session.value.slice(0, 256) : ""
    };
  }
  return result;
}

function compactIdentityEvidence(values: unknown[]): Record<string, unknown> {
  return { records: values.filter(record).map(compactIdentityRecord) };
}

function preflightFailureEvidence(error: LaunchError | PromptIdentityError): Record<string, unknown> {
  return { code: error.code, details: boundAgentSessionStrings(error.details) };
}

function identityPreflightTimeout(samples: number, lastEvidence: Record<string, unknown>, lastFailure: Record<string, unknown>): LaunchError {
  return new LaunchError("TARGET_IDENTITY_UNAVAILABLE", "Launch identity did not become ready during the bounded read-only preflight", {
    identityPreflight: {
      timeoutMs: LAUNCH_IDENTITY_PREFLIGHT_TIMEOUT_MS,
      pollIntervalMs: LAUNCH_IDENTITY_PREFLIGHT_POLL_INTERVAL_MS,
      samples,
      lastFailure,
      lastEvidence
    }
  });
}

type IdentityPreflightAbortReason = "caller" | "deadline";

class IdentityPreflightAbort extends Error {
  constructor(readonly reason: IdentityPreflightAbortReason) {
    super(reason === "caller" ? "Operation aborted" : "Identity preflight deadline expired");
    this.name = "IdentityPreflightAbort";
  }
}

interface IdentityPreflightWindow {
  signal: AbortSignal;
  cancellation(): IdentityPreflightAbort | undefined;
  assertActive(): void;
  cleanup(): void;
}

function createIdentityPreflightWindow(callerSignal: AbortSignal): IdentityPreflightWindow {
  const controller = new AbortController();
  const deadline = Date.now() + LAUNCH_IDENTITY_PREFLIGHT_TIMEOUT_MS;
  let reason: IdentityPreflightAbortReason | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = (next: IdentityPreflightAbortReason): void => {
    if (reason !== undefined) return;
    reason = next;
    controller.abort();
  };
  const onCallerAbort = (): void => abort("caller");
  const onDeadline = (): void => abort("deadline");
  const cancellation = (): IdentityPreflightAbort | undefined => {
    if (reason !== undefined) return new IdentityPreflightAbort(reason);
    if (Date.now() >= deadline) {
      abort("deadline");
      return new IdentityPreflightAbort("deadline");
    }
    return undefined;
  };

  if (callerSignal.aborted) {
    abort("caller");
  } else {
    callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    timer = setTimeout(onDeadline, Math.max(0, deadline - Date.now()));
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

async function readWithinIdentityPreflight(cli: LaunchCli, argv: string[], window: IdentityPreflightWindow): Promise<unknown> {
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

function waitForIdentityPreflightPoll(window: IdentityPreflightWindow): Promise<void> {
  window.assertActive();
  return new Promise<void>((resolve, reject) => {
    const timerState: { timer?: ReturnType<typeof setTimeout> } = {};
    const onAbort = (): void => {
      clearTimeout(timerState.timer!);
      window.signal.removeEventListener("abort", onAbort);
      reject(window.cancellation()!);
    };
    const timer = setTimeout(() => {
      window.signal.removeEventListener("abort", onAbort);
      resolve();
    }, LAUNCH_IDENTITY_PREFLIGHT_POLL_INTERVAL_MS);
    timerState.timer = timer;
    window.signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function freshPostStartIdentity(cli: LaunchCli, paneId: string, callerSignal: AbortSignal, expectedName: string, expectedKind: string, expected: StartedAgent): Promise<{ identity: PromptTargetIdentity; agent: Record<string, unknown>; pane: Record<string, unknown> }> {
  const window = createIdentityPreflightWindow(callerSignal);
  let samples = 0;
  let lastEvidence: Record<string, unknown> = { records: [] };
  let lastFailure: Record<string, unknown> = { code: "TARGET_IDENTITY_UNAVAILABLE" };
  try {
    while (true) {
      window.assertActive();
      samples += 1;
      let snapshot: HerdrSnapshot | undefined;
      let agent: Record<string, unknown> | undefined;
      let pane: Record<string, unknown> | undefined;
      try {
        // Every sample is a fresh, ordered snapshot + agent-get + pane read. The
        // three records are joined only after all reads complete; no record from a
        // prior sample is carried into this attempt. Each read races the same
        // whole-window cancellation, so an uncooperative CLI cannot extend it.
        const snapshotResult = await readWithinIdentityPreflight(cli, ["api", "snapshot"], window);
        snapshot = snapshotOf(snapshotResult);
        const agentResult = await readWithinIdentityPreflight(cli, ["agent", "get", paneId], window);
        agent = agentGetRecord(agentResult);
        const paneResult = await readWithinIdentityPreflight(cli, ["pane", "get", paneId], window);
        pane = paneRecord(paneResult, paneId);
        const records = [...snapshotIdentityRecords(snapshot, paneId), agent, pane];
        lastEvidence = compactIdentityEvidence(records);
        const identity = joinPromptTargetIdentity([expected.startRecord, ...records], paneId, { allowIncompleteFirstRecord: true });
        if (identity.agentName !== expectedName || identity.agentKind !== expectedKind) {
          throw new LaunchError("TARGET_IDENTITY_CHANGED", "Fresh launch identity does not match the requested identity", {
            expectedName, actualName: identity.agentName, expectedKind, actualKind: identity.agentKind
          });
        }
        // A read can resolve after the deadline signal was delivered (for example,
        // a test double or an uncooperative child). Never return a success from
        // that sample or proceed to prompt bytes/recipient registration.
        window.assertActive();
        return { identity, agent, pane };
      } catch (error) {
        if (window.cancellation()) throw error;
        if (error instanceof LaunchError) {
          if (error.code === "TARGET_IDENTITY_CHANGED") {
            throw new LaunchError(error.code, "Fresh post-start identity is contradictory", {
              ...error.details,
              identityPreflight: { samples, lastEvidence }
            });
          }
          if (error.code !== "TARGET_IDENTITY_UNAVAILABLE") throw error;
        } else if (error instanceof PromptIdentityError) {
          if (error.code === "TARGET_IDENTITY_CHANGED") {
            throw new LaunchError(error.code, "Fresh post-start identity is contradictory", {
              ...error.details,
              identityPreflight: { samples, lastEvidence }
            });
          }
        } else {
          throw error;
        }
        const available = [
          ...snapshot!.panes.filter((item) => item.pane_id === paneId),
          ...snapshot!.agents.filter((item) => item.pane_id === paneId),
          ...(agent ? [agent] : []),
          ...(pane ? [pane] : [])
        ];
        lastEvidence = compactIdentityEvidence(available);
        lastFailure = preflightFailureEvidence(error as LaunchError | PromptIdentityError);
      }
      await waitForIdentityPreflightPoll(window);
    }
  } catch (error) {
    const aborted = window.cancellation();
    if (aborted?.reason === "caller") throw new LaunchError("ABORTED", "Operation aborted");
    if (aborted?.reason === "deadline") throw identityPreflightTimeout(samples, lastEvidence, lastFailure);
    throw error;
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

function focusArgs(focus: boolean): string[] {
  return [focus ? "--focus" : "--no-focus"];
}

function cliFailureEvidence(error: unknown): Record<string, unknown> | undefined {
  if (!record(error) || !record(error.details)) return undefined;
  const details: Record<string, unknown> = {};
  for (const key of ["exitCode", "stdoutBytes", "stderrBytes"] as const) {
    const value = error.details[key];
    if (typeof value === "number" && Number.isSafeInteger(value)) details[key] = value;
  }
  for (const key of ["killed", "stdoutPresent", "stderrPresent", "stdoutTruncated", "stderrTruncated"] as const) {
    const value = error.details[key];
    if (typeof value === "boolean") details[key] = value;
  }
  if (error.details.evidence === "omitted_for_stdin_delivery") details.evidence = error.details.evidence;
  for (const key of ["stdout", "stderr", "cause"] as const) {
    const value = error.details[key];
    if (typeof value === "string") details[key] = boundedEvidence(value).value;
  }
  if (error.details.errorStream === "stdout" || error.details.errorStream === "stderr") details.errorStream = error.details.errorStream;
  const envelope = cliErrorEnvelope(error);
  if (envelope) details.errorEnvelope = envelope;
  const code = typeof error.code === "string" ? error.code : undefined;
  const message = error instanceof Error ? boundedEvidence(error.message, 2_000).value : undefined;
  if (code === undefined && message === undefined && Object.keys(details).length === 0) return undefined;
  return { ...(code === undefined ? {} : { code }), ...(message === undefined ? {} : { message }), ...(Object.keys(details).length === 0 ? {} : { details }) };
}

function partialError(error: unknown, created: LaunchResourceIds, phase: LaunchDetails["phase"], delivery?: MessageDelivery, published?: PublishedAttachment): LaunchError {
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
    : transportCode === "ABORTED" ? "ABORTED" : transportCode === "POSTSTATE_UNAVAILABLE" ? "POSTSTATE_UNAVAILABLE" : transportCode === "READY_TIMEOUT" || (transportCode === "CLI_TIMEOUT" && phase === "ready") ? "READY_TIMEOUT" : "LAUNCH_FAILED";
  const evidence = error instanceof LaunchError ? undefined : cliFailureEvidence(error);
  return new LaunchError(code, `Launch did not complete: ${message}`, {
    ...(error instanceof LaunchError ? error.details : {}),
    phase,
    ...(evidence ? { cliFailure: evidence } : {}),
    created: { ...created },
    causeCode,
    ...(delivery ? { delivery, initialPromptDelivery: delivery } : {}),
    ...(published ? { attachmentRetained: true, attachment: { ...published } } : {})
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
      try {
        phase = "placement";
        progress(onUpdate, phase, created);
        if (placement.mode === "existing_pane") {
          paneId = existingTarget!.paneId!;
          tabId = existingTarget!.tabId;
        } else if (placement.mode === "new_tab") {
          const result = tabRefFrom(await run(deps.cli, ["tab", "create", "--workspace", workspaceId!, "--cwd", cwd, "--label", placement.tabLabel, ...focusArgs(params.focus === true)], abortSignal, true));
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
          const result = paneRefFrom(await run(deps.cli, ["pane", "split", "--current", "--direction", "right", ...focusArgs(params.focus === true), "--cwd", cwd], abortSignal, true));
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
          try {
            started = await run(deps.cli, startArgs, abortSignal, true);
            startedAgent = agentIdentity(started, params.name, resolvedPaneId, runtime.kind);
            selectedProfile = profile;
            selectedRuntime = runtime;
            attempts.push({ profile: profile.name, outcome: "selected" });
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
        if (placement.mode === "existing_pane" && params.focus === true) await run(deps.cli, ["agent", "focus", resolvedPaneId], abortSignal);

        // The start acknowledgement is not enough to dispatch into a pane that may
        // already have been reused. Always join one fresh post-start snapshot with
        // agent-get and pane evidence before any assignment bytes are opened.
        if (params.initialPrompt !== undefined) {
          phase = "prompt_verification";
          // Keep the grant alive across an arbitrarily long start before delivery.
          await grant?.renew();
        }
        const postStart = await freshPostStartIdentity(deps.cli, resolvedPaneId, abortSignal, params.name, chosenRuntime.kind, chosenAgent);
        const capturedIdentity = postStart.identity;
        agentId ??= idFrom(postStart.agent, "agent_id") ?? idFrom(postStart.agent, "id") ?? idFrom(postStart.pane, "agent_id");
        if (agentId) created.agentId = agentId;

        let initialPromptSent = false;
        let initialPromptSubmission: PromptSubmissionEvidence | undefined;
        let initialPromptObservation: PromptObservation | undefined;
        let postState: Record<string, unknown> | undefined = postStart.pane;
        if (params.initialPrompt !== undefined) {
          const envelope = initialPromptDelivery === "attachment"
            ? buildEnvelope(sender!, "assignment", params.initialPrompt, "attachment", { ...published!, encoding: "utf-8" })
            : buildEnvelope(sender!, "assignment", params.initialPrompt, "inline");
          const promptResponse = await runPrompt(deps.cli, resolvedPaneId, envelope, abortSignal);
          initialPromptSubmission = parsePromptSubmission(promptResponse, capturedIdentity);
          initialPromptSent = true;
          progress(onUpdate, phase, created);

          try {
            const postAgent = agentGetRecord(await run(deps.cli, ["agent", "get", resolvedPaneId], abortSignal));
            const candidate = paneRecord(await run(deps.cli, ["pane", "get", resolvedPaneId], abortSignal), resolvedPaneId);
            const postEvidence = [postAgent, candidate];
            initialPromptObservation = classifyPromptObservation(postEvidence, initialPromptSubmission);
            let identityMatches = false;
            try {
              const postIdentity = requirePromptTargetIdentity(postEvidence, resolvedPaneId);
              identityMatches = samePromptTargetIdentity(postIdentity, initialPromptSubmission);
            } catch {
              // Keep the initialized false value; an unusable identity is never state.
            }
            // A same-name pane replacement is evidence about the race, never the
            // launched recipient's state or identity. Keep only the bounded
            // observation produced above and retain the captured target binding.
            if (identityMatches) {
              postState = candidate;
              agentId ??= idFrom(postAgent, "agent_id") ?? idFrom(postAgent, "id") ?? idFrom(candidate, "agent_id");
              if (agentId) created.agentId = agentId;
            } else {
              postState = undefined;
            }
          } catch (error) {
            // A valid agent_prompted envelope already confirms acceptance. Keep a
            // stale/unavailable identity or state observation visible without
            // resubmitting the prompt. Caller aborts after acknowledgement affect
            // only this optional observation.
            postState = undefined;
            initialPromptObservation = unavailablePromptObservation(error);
          }
        }
        const authoritativeName = capturedIdentity.agentName;
        const capability = capabilities.get(chosenProfile.name)!;
        const recipient = { recipientKey: recipientKey!, paneId: resolvedPaneId, agentName: authoritativeName, ...(agentId ? { agentId } : {}), profileName: chosenProfile.name, kind: capability.kind, capable: capability.capable, reason: capability.reason };
        deps.recipients?.recordFor(chosenProfile.name, resolvedPaneId, recipient.recipientKey, capability, { ...capturedIdentity, ...(agentId ? { agentId } : {}) });
        const effective = effectiveDetails(chosenProfile, chosenRuntime);
        const launchDetails: LaunchDetails = {
          operation: "launch", outcome: "launched", name: authoritativeName, kind: chosenRuntime.kind, placement, tabId, paneId: resolvedPaneId,
          ...(agentId ? { agentId } : {}),
          ...(postState ? { postState: boundAgentSessionStrings(withoutEnvironment(postState)) } : {}),
          initialPromptSent,
          ...(initialPromptDelivery ? { initialPromptDelivery } : {}),
          ...(initialPromptSubmission ? { initialPromptSubmission: compactPromptSubmission(initialPromptSubmission) } : {}),
          ...(initialPromptObservation ? { initialPromptObservation } : {}),
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
        if (error instanceof LaunchError && attempts.length > 0 && error.details.attempts === undefined) error.details.attempts = attempts;
        throw partialError(error, created, phase, initialPromptDelivery, published);
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
