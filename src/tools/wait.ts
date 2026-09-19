import RE2 from "re2";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CliTextResult, HerdrCli, JsonEnvelope } from "../cli.js";
import { adoptUnnamedTarget, LAZY_ADOPT_KINDS, nameOnlyGap } from "../agent-identity.js";
import { contextRebindingDetails, createContextResolver, type ContextResolutionDiagnostics, type ContextResolver } from "../context.js";
import { loadSettings, type Settings } from "../settings.js";
import { parsePromptTargetIdentityFields } from "../messages/prompt.js";
import { resolveTarget, type CurrentContext, type ResolvedTarget } from "../targets.js";
import { ReviewerFailure, type ReviewerRequest, type ReviewerResult, type WaitReviewer } from "../reviewer.js";
import type { SupervisionPreviousReview, SupervisionSignalProbabilities } from "../supervision/reviewer.js";
import { createConfiguredWaitReviewer, resolveTypesafeApiKey } from "../typesafe-reviewer.js";
import { validateWaitParams, WAIT_LABEL_MAX_BYTES, WAIT_LABEL_MAX_LENGTH, WaitParamsSchema, type SafeRegex, type WaitCondition, type WaitParams, type WaitRawState, type WaitSemanticState } from "../wait-schema.js";
import { boundedText, type JobOperationControl, type JobRegistry, type JobRequestSnapshot, type JobRunResult, type JobTargetError } from "../job-registry.js";
import { createTargetGenerationRef, historicalTargetEvidence, requireWaitTargetIdentity, sameWaitTargetIdentity, type TargetEvidence, type WaitTargetIdentity } from "../wait-target-evidence.js";
import { withoutEnvironment } from "../redaction.js";
import { handoffGateMatches, type HandoffGate, type HandoffValidation, type HandoffValidationState } from "../handoff-gate.js";
import type { HandoffStatus } from "../handoff.js";
import { deltaLines } from "../transcript-delta.js";
import { formatCall, resultForRender, textComponent } from "../tui.js";

export interface WaitClock {
  now(): number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export const realClock: WaitClock = {
  now: () => Date.now(),
  sleep: (milliseconds, signal) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(Object.assign(new Error("Operation aborted"), { code: "ABORTED" }));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(Object.assign(new Error("Operation aborted"), { code: "ABORTED" }));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  })
};

export interface WaitCli {
  runJson(argv: string[], signal: AbortSignal): Promise<JsonEnvelope>;
  runText(argv: string[], signal: AbortSignal): Promise<string>;
  runTextResult?(argv: string[], signal: AbortSignal): Promise<CliTextResult>;
  /** True only when the installed protocol has occupant-pinned agent.wait. */
  supportsNativeAgentWait?: boolean;
  /** Optional test/host seam for the native command; the default uses runJson. */
  runNativeAgentWait?(targetId: string, until: string[], timeoutMs: number, signal: AbortSignal): Promise<unknown>;
}

export type WaitTargetError = JobTargetError;

export interface WaitTargetSnapshot {
  target: string;
  targetId: string;
  metadata: Record<string, unknown>;
  recentUnwrappedLines: string[];
  outputTruncated?: boolean;
  observedAtMs: number;
  matched: boolean;
  target_evidence?: TargetEvidence;
  /**
   * Bounded managed-handoff gate evidence, present only when a strict wait on
   * a managed run evaluated a `completed`/`terminal` condition. `gate` is the
   * current-cycle artifact verdict that decided `matched`.
   */
  handoff?: { runId: string; gate: HandoffValidationState; status?: HandoffStatus; reason?: string };
}

export interface ReviewerSummary {
  target: string;
  targetId: string;
  classification: ReviewerResult["classification"];
  summary: string;
}

interface WaitJobProgressDetails {
  operation: "wait";
  operation_phase: "running";
  contextRebinding?: ContextResolutionDiagnostics;
  label: string;
  match: WaitParams["match"];
  condition: WaitCondition;
  targets: WaitTargetSnapshot[];
  reviewerSummaries?: ReviewerSummary[];
}

export interface BackgroundWaitDetails {
  operation: "wait";
  operation_phase: "accepted";
  contextRebinding?: ContextResolutionDiagnostics;
  jobId: string;
  label: string;
  targets: string[];
  targetIds: string[];
  truncation: {
    targets: number;
    targetIds: number;
    jobIdClipped?: boolean;
    labelClipped?: boolean;
    targetsClipped?: number;
    targetIdsClipped?: number;
  };
}

export type WaitDetails = BackgroundWaitDetails;

export class WaitError extends Error {
  constructor(readonly code: "INVALID_INPUT" | "ABORTED" | "REVIEWER_FAILED" | "CLI_PROTOCOL_ERROR" | "CLI_TIMEOUT" | "TARGET_NOT_FOUND" | "TARGET_AMBIGUOUS" | "TARGET_TYPE_MISMATCH" | "CONTEXT_UNAVAILABLE" | "SESSION_REPLACED", message: string, readonly details: Record<string, unknown> = {}, readonly result?: JobRunResult) {
    super(message);
    this.name = "WaitError";
  }
}

export interface WaitDependencies {
  cli: WaitCli | HerdrCli;
  context: CurrentContext;
  contextResolver?: ContextResolver;
  settingsLoader?: () => Promise<Settings>;
  clock?: WaitClock;
  pollIntervalMs?: number;
  reviewerFactory?: (settings: Settings, context: ExtensionContext) => WaitReviewer;
  jobRegistry: JobRegistry;
  /** Enables strict identity sandwiches for protocol-capable wait runners. */
  requireTargetIdentity?: boolean;
  /**
   * The shared managed-handoff gate. Strict waits on a bound managed run gate
   * `completed`/`terminal` on the durable artifact; identityless or unmanaged
   * waits are untouched.
   */
  handoffs?: HandoffGate;
  targetGenerationRefFactory?: () => string;
}

export interface PreparedWait {
  readonly params: WaitParams;
  readonly contextRebinding?: ContextResolutionDiagnostics;
  readonly label: string;
  readonly validation: { regex?: SafeRegex };
  readonly settings: Settings;
  readonly resolved: ReadonlyArray<{ ref: string; target: ResolvedTarget; targetGenerationRef: string; identity?: WaitTargetIdentity }>;
}

export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : undefined;
}

function abort(): never {
  throw new WaitError("ABORTED", "ABORTED: wait was cancelled");
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) abort();
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new WaitError("CLI_PROTOCOL_ERROR", message);
  return value as Record<string, unknown>;
}

function paneFrom(result: unknown, expectedPaneId: string): Record<string, unknown> {
  const record = asRecord(result, "CLI_PROTOCOL_ERROR: pane response is invalid");
  const pane = asRecord(record.pane ?? record, "CLI_PROTOCOL_ERROR: pane response is invalid");
  if (typeof pane.pane_id !== "string" || pane.pane_id.length === 0 || pane.pane_id !== expectedPaneId) {
    throw new WaitError("CLI_PROTOCOL_ERROR", "CLI_PROTOCOL_ERROR: pane response is missing the requested pane");
  }
  return pane;
}

export function boundedLines(output: string): string[] {
  if (output.length === 0) return [];
  return output.split(/\r?\n/).slice(-100);
}

const KNOWN_WAIT_STATES = new Set<WaitRawState>(["idle", "working", "blocked", "done", "unknown"]);
const AUTHORITATIVE_AGENT_STATE = Symbol("authoritativeAgentState");
type PrivatelyObservedSnapshot = WaitTargetSnapshot & { [AUTHORITATIVE_AGENT_STATE]?: WaitRawState };

function retainAuthoritativeState(snapshot: WaitTargetSnapshot, state: WaitRawState | undefined): WaitTargetSnapshot {
  if (state !== undefined) Object.defineProperty(snapshot, AUTHORITATIVE_AGENT_STATE, { value: state, enumerable: false });
  return snapshot;
}

function retainedAuthoritativeState(snapshot: WaitTargetSnapshot): WaitRawState | undefined {
  return (snapshot as PrivatelyObservedSnapshot)[AUTHORITATIVE_AGENT_STATE];
}

function retainableAgentState(agent: Record<string, unknown>): WaitRawState | undefined {
  const state = agent.agent_status;
  return typeof state === "string" && KNOWN_WAIT_STATES.has(state as WaitRawState) ? state as WaitRawState : undefined;
}

const HANDOFF_VALIDATION = Symbol("handoffValidation");
type HandoffGatedSnapshot = WaitTargetSnapshot & { [HANDOFF_VALIDATION]?: HandoffValidation };

function retainHandoffValidation(snapshot: WaitTargetSnapshot, validation: HandoffValidation): void {
  Object.defineProperty(snapshot, HANDOFF_VALIDATION, { value: validation, enumerable: false, configurable: true });
}

function handoffValidation(snapshot: WaitTargetSnapshot): HandoffValidation | undefined {
  return (snapshot as HandoffGatedSnapshot)[HANDOFF_VALIDATION];
}

function rawState(metadata: Record<string, unknown>): string {
  const value = metadata.agent_status;
  return typeof value === "string" ? value : "unknown";
}

function explicitState(metadata: Record<string, unknown>, source: string): string | undefined {
  const value = metadata.agent_status;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !KNOWN_WAIT_STATES.has(value as WaitRawState)) throw new WaitError("CLI_PROTOCOL_ERROR", `CLI_PROTOCOL_ERROR: ${source} response contains an invalid state`);
  return value;
}

export function matchesState(state: string, requested: string): boolean {
  if (["idle", "working", "blocked", "done", "unknown"].includes(requested)) return state === requested;
  if (requested === "started") return state === "working";
  if (requested === "completed") return state === "idle" || state === "done";
  if (requested === "terminal") return state === "idle" || state === "blocked" || state === "done";
  return requested === "needs_input" && state === "blocked";
}

export function matches(snapshot: WaitTargetSnapshot, condition: WaitCondition, regex?: SafeRegex): boolean {
  if (condition.kind === "state") {
    // A managed target's completed/terminal verdict comes from the durable
    // artifact, validated before this snapshot's matched flag is computed.
    const validation = handoffValidation(snapshot);
    if (validation !== undefined && (condition.state === "completed" || condition.state === "terminal")) {
      return handoffGateMatches(validation, condition.state, rawState(snapshot.metadata));
    }
    return matchesState(rawState(snapshot.metadata), condition.state);
  }
  const output = snapshot.recentUnwrappedLines.join("\n");
  const compactOutput = snapshot.recentUnwrappedLines.map((line) => line.trim()).join("");
  if (condition.match.kind === "literal") {
    return output.includes(condition.match.value) || (!/\s/.test(condition.match.value) && compactOutput.includes(condition.match.value));
  }
  const safeRegex = regex ?? new RE2(condition.match.value);
  return safeRegex.test(output) || safeRegex.test(compactOutput);
}

const COMPACT_METADATA_KEYS = ["pane_id", "tab_id", "workspace_id", "label", "agent_name", "agent", "agent_status", "cwd", "revision"] as const;
const BACKGROUND_TARGET_LIMIT = 16;
const BACKGROUND_TARGET_BYTES = 256;

function singleLine(value: string): string {
  const printable = [...value].map((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? " " : character;
  }).join("");
  return printable.replace(/\s+/gu, " ").trim();
}

export function deriveWaitLabel(params: WaitParams, resolved: ReadonlyArray<{ ref: string; target: ResolvedTarget }>): string {
  if (params.label !== undefined) return params.label;
  const first = resolved[0];
  if (!first) throw new WaitError("INVALID_INPUT", "INVALID_INPUT: wait label derivation requires a resolved target");
  const primary = first.target.agentName ?? first.target.label ?? first.ref;
  const targets = `${singleLine(primary)}${resolved.length > 1 ? ` +${resolved.length - 1}` : ""}`;
  const condition = params.condition.kind === "state"
    ? params.condition.state
    : params.condition.match.kind === "literal"
      ? `contains "${singleLine(params.condition.match.value)}"`
      : `matches /${singleLine(params.condition.match.value)}/`;
  return [...`${targets} → ${condition}`].slice(0, WAIT_LABEL_MAX_LENGTH).join("");
}

export function compactMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(COMPACT_METADATA_KEYS.filter((key) => metadata[key] !== undefined).map((key) => [key, metadata[key]]));
}

async function guardedCall<T>(call: () => Promise<T>, signal: AbortSignal, control?: JobOperationControl): Promise<T> {
  control?.check();
  const release = control?.beginActivity();
  try {
    const value = await call();
    control?.check();
    checkAbort(signal);
    return value;
  } finally {
    release?.();
  }
}

function waitIdentity(values: unknown[], expectedPaneId: string): WaitTargetIdentity {
  try {
    return requireWaitTargetIdentity(values, expectedPaneId);
  } catch (error) {
    const code = errorCode(error);
    throw new WaitError("CLI_PROTOCOL_ERROR", code === "TARGET_IDENTITY_CHANGED"
      ? "CLI_PROTOCOL_ERROR: wait target identity changed"
      : "CLI_PROTOCOL_ERROR: wait target identity is unavailable");
  }
}

const WAIT_IDENTITY_KEYS = new Set([
  "terminal_id",
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
  "session_value",
  "agent_process_id",
  "agent_terminal_id"
]);

function stripWaitIdentity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripWaitIdentity);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !WAIT_IDENTITY_KEYS.has(key))
    .map(([key, item]) => [key, stripWaitIdentity(item)]));
}

function metadataWithoutIdentity(value: Record<string, unknown>): Record<string, unknown> {
  return stripWaitIdentity(withoutEnvironment(value)) as Record<string, unknown>;
}

interface ReadTargetInput {
  ref: string;
  target: ResolvedTarget;
  targetGenerationRef: string;
  identity?: WaitTargetIdentity;
}

interface WaitObservation {
  snapshots: WaitTargetSnapshot[];
  targetErrors: WaitTargetError[];
  expired: boolean;
}

function protocolErrorCode(error: unknown): string | undefined {
  if (errorCode(error) !== "CLI_PROTOCOL_ERROR") return undefined;
  const details = (error as { details?: unknown }).details;
  if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
  const envelope = (details as Record<string, unknown>).errorEnvelope;
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) return undefined;
  const body = (envelope as Record<string, unknown>).error;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const code = (body as Record<string, unknown>).code;
  return typeof code === "string" ? code : undefined;
}

function isNativePredicateTimeout(error: unknown): boolean {
  return protocolErrorCode(error) === "timeout";
}

function isAgentAbsentError(error: unknown): boolean {
  const code = protocolErrorCode(error);
  return code === "agent_not_found" || code === "agent_not_running";
}

function agentRecordFrom(value: unknown): Record<string, unknown> | undefined {
  const root = asRecord(value, "CLI_PROTOCOL_ERROR: agent response is invalid");
  if (!Object.prototype.hasOwnProperty.call(root, "agent") || root.agent === null || root.agent === undefined) return undefined;
  return asRecord(root.agent, "CLI_PROTOCOL_ERROR: agent response is invalid");
}

function sameAgentFreePaneIdentity(pane: Record<string, unknown>, item: ReadTargetInput): boolean {
  const identity = item.identity;
  if (!identity || pane.pane_id !== identity.paneId || pane.terminal_id !== identity.terminalId || pane.tab_id !== item.target.tabId || pane.workspace_id !== item.target.workspaceId) return false;
  const expectedRecord = item.target.record as Record<string, unknown>;
  for (const [field, expected] of [["agent_id", expectedRecord.agent_id], ["agent_process_id", expectedRecord.agent_process_id], ["agent_terminal_id", expectedRecord.agent_terminal_id]] as const) {
    if (Object.prototype.hasOwnProperty.call(pane, field) && pane[field] !== expected) return false;
  }

  let sessionEvidence = false;
  const session = pane.agent_session;
  if (session !== undefined) {
    if (session === null || typeof session !== "object" || Array.isArray(session)) return false;
    const candidate = session as Record<string, unknown>;
    if (!["source", "agent", "kind", "value"].every((field) => typeof candidate[field] === "string" && (candidate[field] as string).length > 0)) return false;
    if (candidate.source !== identity.agentSession.source || candidate.agent !== identity.agentSession.agent || candidate.kind !== identity.agentSession.kind || candidate.value !== identity.agentSession.value) return false;
    sessionEvidence = true;
  }
  for (const fields of [
    ["agent_session_source", "agent_session_agent", "agent_session_kind", "agent_session_value"],
    ["session_source", "session_agent", "session_kind", "session_value"]
  ] as const) {
    const supplied = fields.some((field) => pane[field] !== undefined);
    if (!supplied) continue;
    if (!fields.every((field) => typeof pane[field] === "string" && (pane[field] as string).length > 0)) return false;
    if (pane[fields[0]] !== identity.agentSession.source || pane[fields[1]] !== identity.agentSession.agent || pane[fields[2]] !== identity.agentSession.kind || pane[fields[3]] !== identity.agentSession.value) return false;
    sessionEvidence = true;
  }
  if (!sessionEvidence) return false;

  for (const [field, expected] of [["agent_name", identity.agentName], ["name", identity.agentName], ["agent", identity.agentKind], ["agent_kind", identity.agentKind], ["kind", identity.agentKind]] as const) {
    if (Object.prototype.hasOwnProperty.call(pane, field) && pane[field] !== undefined && pane[field] !== expected) return false;
  }
  return true;
}

async function readFreshPane(cli: WaitCli, paneId: string, signal: AbortSignal, control?: JobOperationControl): Promise<Record<string, unknown>> {
  return paneFrom((await guardedCall(() => cli.runJson(["pane", "get", paneId], signal), signal, control)).result, paneId);
}

async function readFreshAgent(cli: WaitCli, paneId: string, signal: AbortSignal, control?: JobOperationControl): Promise<Record<string, unknown> | undefined> {
  try {
    return agentRecordFrom((await guardedCall(() => cli.runJson(["agent", "get", paneId], signal), signal, control)).result);
  } catch (error) {
    if (isAgentAbsentError(error)) return undefined;
    throw error;
  }
}

async function readStrictIdentity(cli: WaitCli, pane: Record<string, unknown>, paneId: string, signal: AbortSignal, control?: JobOperationControl): Promise<{ identity: WaitTargetIdentity; agent: Record<string, unknown> }> {
  const agent = await readFreshAgent(cli, paneId, signal, control);
  if (!agent) throw new WaitError("CLI_PROTOCOL_ERROR", "CLI_PROTOCOL_ERROR: wait target identity is unavailable");
  return { identity: waitIdentity([pane, agent], paneId), agent };
}

/**
 * A strict wait on a bound managed run must never match off raw lifecycle
 * alone: the current-cycle artifact verdict attaches to the snapshot before
 * `matched` is computed, and the bounded evidence rides the published target
 * projection. Identityless or unmanaged targets attach nothing and stay raw.
 */
async function attachHandoffGate(
  handoffs: HandoffGate | undefined,
  item: ReadTargetInput,
  snapshot: WaitTargetSnapshot,
  condition: WaitCondition,
): Promise<void> {
  if (handoffs === undefined || item.identity === undefined || condition.kind !== "state"
    || (condition.state !== "completed" && condition.state !== "terminal")) return;
  const run = handoffs.lookup(item.identity);
  if (run === undefined) return;
  const validation = await handoffs.validate(run);
  retainHandoffValidation(snapshot, validation);
  snapshot.handoff = {
    runId: run.runId,
    gate: validation.state,
    ...(validation.artifact?.status !== undefined ? { status: validation.artifact.status } : {}),
    ...(validation.reason !== undefined ? { reason: validation.reason } : {})
  };
}

async function readTarget(cli: WaitCli, item: ReadTargetInput, clock: WaitClock, signal: AbortSignal, condition: WaitCondition, control?: JobOperationControl, strict = false, handoffs?: HandoffGate): Promise<WaitTargetSnapshot> {
  checkAbort(signal);
  const paneId = item.target.paneId!;
  try {
    const pane = paneFrom((await guardedCall(() => cli.runJson(["pane", "get", paneId], signal), signal, control)).result, paneId);
    let identityA: WaitTargetIdentity | undefined;
    let finalAgentState: WaitRawState | undefined;
    if (strict) {
      const before = await readStrictIdentity(cli, pane, paneId, signal, control);
      identityA = before.identity;
      if (!item.identity || !sameWaitTargetIdentity(identityA, item.identity)) throw new WaitError("CLI_PROTOCOL_ERROR", "CLI_PROTOCOL_ERROR: wait target identity changed");
    }
    const readArgs = ["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", "100", "--format", "text"];
    const output = cli.runTextResult
      ? await guardedCall(() => cli.runTextResult!(readArgs, signal), signal, control)
      : { value: await guardedCall(() => cli.runText(readArgs, signal), signal, control), truncated: false };
    if (strict) {
      const after = paneFrom((await guardedCall(() => cli.runJson(["pane", "get", paneId], signal), signal, control)).result, paneId);
      const verified = await readStrictIdentity(cli, after, paneId, signal, control);
      if (!identityA || !sameWaitTargetIdentity(identityA, verified.identity) || !item.identity || !sameWaitTargetIdentity(verified.identity, item.identity)) {
        throw new WaitError("CLI_PROTOCOL_ERROR", "CLI_PROTOCOL_ERROR: wait target identity changed");
      }
      finalAgentState = retainableAgentState(verified.agent);
    }
    checkAbort(signal);
    const snapshot = retainAuthoritativeState({ target: item.ref, targetId: paneId, metadata: metadataWithoutIdentity(pane), recentUnwrappedLines: boundedLines(output.value), outputTruncated: output.truncated, observedAtMs: clock.now(), matched: false }, finalAgentState);
    await attachHandoffGate(handoffs, item, snapshot, condition);
    return snapshot;
  } catch (error) {
    if (signal.aborted || errorCode(error) === "ABORTED") abort();
    if (error instanceof WaitError) throw error;
    // Keep unknown target failures raw until fan-out aggregation can attach the
    // target identity and preserve successful sibling observations.
    throw error;
  }
}

async function readCurrentStateTarget(
  cli: WaitCli,
  item: ReadTargetInput,
  clock: WaitClock,
  signal: AbortSignal,
  deadline: number,
  condition: Extract<WaitCondition, { kind: "state" }>,
  control?: JobOperationControl,
  handoffs?: HandoffGate,
): Promise<WaitTargetSnapshot> {
  checkAbort(signal);
  const paneId = item.target.paneId!;
  try {
    const pane = await readFreshPane(cli, paneId, signal, control);
    const paneStatus = explicitState(pane, "pane");
    const agent = await readFreshAgent(cli, paneId, signal, control);
    const agentAbsent = agent === undefined;
    let status: string;
    let metadata: Record<string, unknown>;
    if (agentAbsent) {
      if (paneStatus !== "unknown") throw new WaitError("CLI_PROTOCOL_ERROR", "CLI_PROTOCOL_ERROR: wait target identity is unavailable");
      if (!sameAgentFreePaneIdentity(pane, item)) throw new WaitError("CLI_PROTOCOL_ERROR", "CLI_PROTOCOL_ERROR: wait target identity changed");
      status = "unknown";
      metadata = { ...pane, agent_status: status };
    } else {
      const agentStatus = explicitState(agent, "agent");
      if (agentStatus === undefined) throw new WaitError("CLI_PROTOCOL_ERROR", "CLI_PROTOCOL_ERROR: agent response omitted its authoritative state");
      const identity = waitIdentity([pane, agent], paneId);
      if (!item.identity || !sameWaitTargetIdentity(identity, item.identity)) throw new WaitError("CLI_PROTOCOL_ERROR", "CLI_PROTOCOL_ERROR: wait target identity changed");
      // Agent-get owns lifecycle state. Pane state is continuity/metadata only;
      // an omitted or stale pane status cannot turn a live agent into unknown.
      status = agentStatus;
      metadata = targetMetadata(item, agent, pane, { agent_status: status });
    }
    const observedAtMs = clock.now();
    const snapshot = retainAuthoritativeState({
      target: item.ref,
      targetId: paneId,
      metadata: metadataWithoutIdentity(metadata),
      recentUnwrappedLines: [],
      observedAtMs,
      matched: false,
      target_evidence: historicalTargetEvidence(agentAbsent ? "agent_absent_observed" : "predicate_observed", observedAtMs, item.targetGenerationRef, "composite_observation")
    }, agentAbsent ? undefined : status as WaitRawState);
    await attachHandoffGate(handoffs, item, snapshot, condition);
    snapshot.matched = observedAtMs < deadline && matches(snapshot, condition);
    return snapshot;
  } catch (error) {
    if (signal.aborted || errorCode(error) === "ABORTED") abort();
    if (error instanceof WaitError) throw error;
    throw new WaitError((errorCode(error) as WaitError["code"] | undefined) ?? "CLI_PROTOCOL_ERROR", `Unable to read target ${item.ref}`, { target: item.ref, targetId: paneId, cause: error instanceof Error ? error.message : String(error) });
  }
}

type TargetOutcome<T> = { index: number; value: T } | { index: number; error: unknown };

function targetMetadata(item: ReadTargetInput, ...records: Record<string, unknown>[]): Record<string, unknown> {
  return {
    ...item.target.record,
    ...(item.target.label !== undefined ? { label: item.target.label } : {}),
    ...(item.target.agentName !== undefined ? { agent_name: item.target.agentName } : {}),
    ...records.reduce((merged, record) => ({ ...merged, ...record }), {})
  };
}

function targetError(item: ReadTargetInput, error: unknown): WaitTargetError {
  const code = error instanceof WaitError ? error.code : errorCode(error) ?? "CLI_PROTOCOL_ERROR";
  const message = error instanceof Error ? error.message : String(error);
  return { target: item.ref, targetId: item.target.paneId!, code, message: boundedText(message, 500) };
}

function orderedSnapshots(values: Array<{ index: number; value: WaitTargetSnapshot }>): WaitTargetSnapshot[] {
  return values.sort((left, right) => left.index - right.index).map(({ value }) => value);
}

function orderedTargetErrors(values: Array<{ index: number; error: unknown }>, resolved: ReadonlyArray<ReadTargetInput>): WaitTargetError[] {
  return values.sort((left, right) => left.index - right.index).map(({ index, error }) => targetError(resolved[index]!, error));
}

async function fanOutTargets<T>(
  resolved: ReadonlyArray<ReadTargetInput>,
  signal: AbortSignal,
  match: WaitParams["match"],
  operation: (item: ReadTargetInput, signal: AbortSignal) => Promise<T>,
  isMatch?: (value: T, index: number) => boolean,
): Promise<{ values: Array<{ index: number; value: T }>; errors: Array<{ index: number; error: unknown }> }> {
  checkAbort(signal);
  const linked = resolved.map(() => {
    const controller = new AbortController();
    return { controller, ...linkedSignal(signal, controller) };
  });
  const promises = resolved.map((item, index) => operation(item, linked[index]!.signal).then(
    (value): TargetOutcome<T> => ({ index, value }),
    (error): TargetOutcome<T> => ({ index, error })
  ));
  const pending = new Set(promises.map((_, index) => index));
  const values: Array<{ index: number; value: T }> = [];
  const errors: Array<{ index: number; error: unknown }> = [];
  const cleanup = (): void => linked.forEach(({ controller, dispose }) => { controller.abort(); dispose(); });
  try {
    while (pending.size > 0) {
      const outcome = await Promise.race([...pending].map((index) => promises[index]!));
      pending.delete(outcome.index);
      if ("value" in outcome) {
        values.push({ index: outcome.index, value: outcome.value });
        if (match === "any" && isMatch?.(outcome.value, outcome.index)) return { values, errors };
      } else {
        if (signal.aborted || errorCode(outcome.error) === "ABORTED") abort();
        errors.push({ index: outcome.index, error: outcome.error });
      }
    }
    return { values, errors };
  } finally {
    cleanup();
    // A match or a definitive all-target failure must not wait for unrelated
    // commands. Promise wrappers already capture late rejections; allSettled
    // drains their handlers without giving them terminal authority.
    if (pending.size > 0) void Promise.allSettled([...pending].map((index) => promises[index]!));
  }
}

async function readCurrentState(
  cli: WaitCli,
  resolved: ReadonlyArray<ReadTargetInput>,
  clock: WaitClock,
  signal: AbortSignal,
  deadline: number,
  condition: Extract<WaitCondition, { kind: "state" }>,
  match: WaitParams["match"],
  control?: JobOperationControl,
  handoffs?: HandoffGate,
): Promise<WaitObservation> {
  const fanout = await fanOutTargets(resolved, signal, match, (item, targetSignal) => readCurrentStateTarget(cli, item, clock, targetSignal, deadline, condition, control, handoffs), (snapshot) => snapshot.matched && clock.now() < deadline);
  const snapshots = orderedSnapshots(fanout.values as Array<{ index: number; value: WaitTargetSnapshot }>);
  const targetErrors = orderedTargetErrors(fanout.errors, resolved);
  return { snapshots, targetErrors, expired: expired(clock, deadline, snapshots) };
}

function observeOutput(snapshot: WaitTargetSnapshot, item: ReadTargetInput, clock: WaitClock, deadline: number, condition: WaitCondition, regex?: SafeRegex): boolean {
  snapshot.target_evidence = historicalTargetEvidence("predicate_observed", snapshot.observedAtMs, item.targetGenerationRef, "composite_observation");
  if (clock.now() >= deadline) {
    snapshot.matched = false;
    return false;
  }
  snapshot.matched = matches(snapshot, condition, regex) && clock.now() < deadline;
  return snapshot.matched;
}

async function readAndMatch(cli: WaitCli, resolved: ReadonlyArray<ReadTargetInput>, clock: WaitClock, signal: AbortSignal, deadline: number, condition: WaitCondition, match: WaitParams["match"], regex?: SafeRegex, control?: JobOperationControl, strict = false, handoffs?: HandoffGate): Promise<WaitObservation> {
  const fanout = await fanOutTargets(resolved, signal, match, (item, targetSignal) => readTarget(cli, item, clock, targetSignal, condition, control, strict, handoffs), (snapshot, index) => observeOutput(snapshot, resolved[index]!, clock, deadline, condition, regex));
  const snapshots = orderedSnapshots(fanout.values as Array<{ index: number; value: WaitTargetSnapshot }>);
  if (match === "all") snapshots.forEach((snapshot) => observeOutput(snapshot, resolved.find((item) => item.target.paneId === snapshot.targetId)!, clock, deadline, condition, regex));
  const targetErrors = orderedTargetErrors(fanout.errors, resolved);
  return { snapshots, targetErrors, expired: expired(clock, deadline, snapshots) };
}

const NATIVE_UNTIL: Record<WaitRawState | WaitSemanticState, string[]> = {
  idle: ["idle"],
  working: ["working"],
  blocked: ["blocked"],
  done: ["done"],
  unknown: ["unknown"],
  started: ["working"],
  needs_input: ["blocked"],
  completed: ["idle", "done"],
  terminal: ["idle", "blocked", "done"]
};

function nativeUntil(condition: Extract<WaitCondition, { kind: "state" }>): string[] {
  return NATIVE_UNTIL[condition.state];
}

function nativeRecord(value: unknown): Record<string, unknown> {
  const root = asRecord(value, "CLI_PROTOCOL_ERROR: native agent.wait response is invalid");
  if (root.result !== undefined && typeof root.result === "object" && root.result !== null && !Array.isArray(root.result)) return root.result as Record<string, unknown>;
  return root;
}

function nativeAgentRecord(value: unknown, paneId: string): { record: Record<string, unknown>; status: string } {
  const root = nativeRecord(value);
  const event = root.event;
  const eventData = typeof event === "object" && event !== null && !Array.isArray(event)
    ? (event as Record<string, unknown>).data
    : undefined;
  const candidates = [root.agent, root.pane, root.data, eventData, root].filter((candidate): candidate is Record<string, unknown> => typeof candidate === "object" && candidate !== null && !Array.isArray(candidate));
  const candidate = candidates.find((entry) => entry.pane_id === paneId);
  if (!candidate) throw new WaitError("CLI_PROTOCOL_ERROR", "CLI_PROTOCOL_ERROR: native agent.wait returned a different or missing target");
  const state = candidate.agent_status ?? candidate.status ?? candidate.state;
  if (typeof state !== "string" || !["idle", "working", "blocked", "done", "unknown"].includes(state)) throw new WaitError("CLI_PROTOCOL_ERROR", "CLI_PROTOCOL_ERROR: native agent.wait omitted a valid state");
  return { record: candidate, status: state };
}

function nativeSnapshot(
  item: ReadTargetInput,
  metadata: Record<string, unknown>,
  status: string,
  observedAtMs: number,
  matched: boolean,
  agentAbsent = false,
): WaitTargetSnapshot {
  const kind = agentAbsent ? "agent_absent_observed" : status === "done" ? "native_done_observed" : "predicate_observed";
  return {
    target: item.ref,
    targetId: item.target.paneId!,
    metadata: metadataWithoutIdentity({ ...metadata, agent_status: status }),
    recentUnwrappedLines: [],
    observedAtMs,
    matched,
    target_evidence: historicalTargetEvidence(kind, observedAtMs, item.targetGenerationRef, "native_agent_wait")
  };
}

async function readNativeTarget(
  cli: WaitCli,
  item: ReadTargetInput,
  clock: WaitClock,
  signal: AbortSignal,
  deadline: number,
  condition: Extract<WaitCondition, { kind: "state" }>,
  control?: JobOperationControl,
  nativeWaitDeadline = deadline,
  handoffs?: HandoffGate,
): Promise<WaitTargetSnapshot> {
  const until = nativeUntil(condition);
  const timeoutMs = Math.max(1, nativeWaitDeadline - clock.now());
  const run = async (): Promise<unknown> => {
    if (cli.runNativeAgentWait) return guardedCall(() => cli.runNativeAgentWait!(item.target.paneId!, until, timeoutMs, signal), signal, control);
    const argv = ["agent", "wait", item.target.paneId!, ...until.flatMap((state) => ["--until", state]), "--timeout", String(timeoutMs)];
    return (await guardedCall(() => cli.runJson(argv, signal), signal, control)).result;
  };
  let phase: "native_wait" | "verification" = "native_wait";
  try {
    const raw = await run();
    phase = "verification";
    control?.check();
    checkAbort(signal);
    const { record, status } = nativeAgentRecord(raw, item.target.paneId!);
    // Herdr protocol 22's wait_matched event carries the matched pane/status but
    // not always the complete occupant identity. Fresh pane/agent records supply
    // the resolved metadata and bind partial events to the captured occupant.
    const pane = await readFreshPane(cli, item.target.paneId!, signal, control);
    const agent = await readFreshAgent(cli, item.target.paneId!, signal, control);
    const agentAbsent = agent === undefined;
    let authoritativeAgentState: WaitRawState | undefined;
    if (agentAbsent) {
      if (status !== "unknown" || explicitState(pane, "pane") !== "unknown") throw new WaitError("CLI_PROTOCOL_ERROR", "CLI_PROTOCOL_ERROR: native agent.wait target identity is unavailable");
      if (!sameAgentFreePaneIdentity(pane, item)) throw new WaitError("CLI_PROTOCOL_ERROR", "CLI_PROTOCOL_ERROR: native agent.wait target occupant changed");
    } else {
      const agentState = explicitState(agent, "agent");
      if (agentState === undefined) throw new WaitError("CLI_PROTOCOL_ERROR", "CLI_PROTOCOL_ERROR: native agent.wait omitted the authoritative state");
      authoritativeAgentState = agentState as WaitRawState;
      const identity = waitIdentity([record, pane, agent], item.target.paneId!);
      if (!item.identity || !sameWaitTargetIdentity(identity, item.identity)) throw new WaitError("CLI_PROTOCOL_ERROR", "CLI_PROTOCOL_ERROR: native agent.wait target occupant changed");
    }
    const observedAtMs = clock.now();
    const metadata = agentAbsent ? pane : targetMetadata(item, record, agent, pane);
    const snapshot = retainAuthoritativeState(nativeSnapshot(item, metadata, status, observedAtMs, false, agentAbsent), authoritativeAgentState);
    await attachHandoffGate(handoffs, item, snapshot, condition);
    snapshot.matched = observedAtMs < deadline && matches(snapshot, condition);
    return snapshot;
  } catch (error) {
    if (signal.aborted || errorCode(error) === "ABORTED") abort();
    // A typed timeout from the native command means its predicate expired; a
    // killed subprocess (or a post-match verification timeout) is a failure.
    if (phase === "native_wait" && isNativePredicateTimeout(error)) return readCurrentStateTarget(cli, item, clock, signal, deadline, condition, control, handoffs);
    if (errorCode(error) === "CLI_TIMEOUT") {
      if (clock.now() >= deadline) return readCurrentStateTarget(cli, item, clock, signal, deadline, condition, control, handoffs);
      throw new WaitError("CLI_TIMEOUT", "CLI_TIMEOUT: native wait or target verification timed out", { target: item.ref, targetId: item.target.paneId! });
    }
    if (error instanceof WaitError) throw error;
    throw new WaitError("CLI_PROTOCOL_ERROR", "CLI_PROTOCOL_ERROR: native agent.wait failed", { target: item.ref });
  }
}

interface LinkedAbortSignal {
  signal: AbortSignal;
  dispose(): void;
}

/** @internal Testable link used only by the native wait fan-out. */
export function linkedSignal(parent: AbortSignal, controller: AbortController): LinkedAbortSignal {
  let disposed = false;
  const onAbort = (): void => controller.abort();
  if (parent.aborted) controller.abort();
  else parent.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      parent.removeEventListener("abort", onAbort);
    }
  };
}

async function readNative(
  cli: WaitCli,
  resolved: ReadonlyArray<ReadTargetInput>,
  clock: WaitClock,
  signal: AbortSignal,
  deadline: number,
  condition: Extract<WaitCondition, { kind: "state" }>,
  match: WaitParams["match"],
  control?: JobOperationControl,
  nativeWaitDeadline = deadline,
  handoffs?: HandoffGate,
): Promise<WaitObservation> {
  const fanout = await fanOutTargets(resolved, signal, match, (item, targetSignal) => readNativeTarget(cli, item, clock, targetSignal, deadline, condition, control, nativeWaitDeadline, handoffs), (snapshot) => snapshot.matched && clock.now() < deadline);
  const snapshots = orderedSnapshots(fanout.values as Array<{ index: number; value: WaitTargetSnapshot }>);
  const targetErrors = orderedTargetErrors(fanout.errors, resolved);
  return { snapshots, targetErrors, expired: expired(clock, deadline, snapshots) };
}

async function readInitialObservation(
  cli: WaitCli,
  resolved: ReadonlyArray<ReadTargetInput>,
  clock: WaitClock,
  signal: AbortSignal,
  deadline: number,
  condition: WaitCondition,
  match: WaitParams["match"],
  regex: SafeRegex | undefined,
  control?: JobOperationControl,
  strict = false,
  nativeWaitDeadline = deadline,
  handoffs?: HandoffGate,
): Promise<WaitObservation> {
  const native = cli.supportsNativeAgentWait === true && condition.kind === "state";
  return native
    ? readNative(cli, resolved, clock, signal, deadline, condition, match, control, nativeWaitDeadline, handoffs)
    : readAndMatch(cli, resolved, clock, signal, deadline, condition, match, regex, control, strict, handoffs);
}

export function boundedBackgroundDetails(jobId: string, label: string, params: WaitParams, targetIds: string[]): BackgroundWaitDetails {
  const boundedJobId = boundedText(jobId, BACKGROUND_TARGET_BYTES);
  const boundedLabel = boundedText(label, WAIT_LABEL_MAX_BYTES);
  const boundedTargets = params.targets.slice(0, BACKGROUND_TARGET_LIMIT).map((target) => boundedText(target, BACKGROUND_TARGET_BYTES));
  const boundedTargetIds = targetIds.slice(0, BACKGROUND_TARGET_LIMIT).map((targetId) => boundedText(targetId, BACKGROUND_TARGET_BYTES));
  return {
    operation: "wait",
    operation_phase: "accepted",
    jobId: boundedJobId,
    label: boundedLabel,
    targets: boundedTargets,
    targetIds: boundedTargetIds,
    truncation: {
      targets: Math.max(0, params.targets.length - BACKGROUND_TARGET_LIMIT),
      targetIds: Math.max(0, targetIds.length - BACKGROUND_TARGET_LIMIT),
      ...(boundedJobId !== jobId ? { jobIdClipped: true } : {}),
      ...(boundedLabel !== label ? { labelClipped: true } : {}),
      ...(boundedTargets.filter((target, index) => target !== params.targets[index]).length > 0 ? { targetsClipped: boundedTargets.filter((target, index) => target !== params.targets[index]).length } : {}),
      ...(boundedTargetIds.filter((targetId, index) => targetId !== targetIds[index]).length > 0 ? { targetIdsClipped: boundedTargetIds.filter((targetId, index) => targetId !== targetIds[index]).length } : {})
    }
  };
}

function aggregate(params: WaitParams, snapshots: WaitTargetSnapshot[]): boolean {
  if (snapshots.length === 0) return false;
  const count = snapshots.filter((snapshot) => snapshot.matched).length;
  return params.match === "any" ? count > 0 : count === snapshots.length;
}

function expired(clock: WaitClock, deadline: number, snapshots: WaitTargetSnapshot[]): boolean {
  if (clock.now() < deadline) return false;
  snapshots.forEach((snapshot) => {
    snapshot.matched = false;
  });
  return true;
}

function reviewerResult(reviewerSummaries: ReviewerSummary[]): Pick<JobRunResult, "reviewerSummaries"> {
  return reviewerSummaries.length > 0 ? { reviewerSummaries } : {};
}

function targetErrorResult(targetErrors: WaitTargetError[]): Pick<JobRunResult, "targetErrors"> {
  return targetErrors.length > 0 ? { targetErrors } : {};
}

function timedOutResult(snapshots: WaitTargetSnapshot[], reviewerSummaries: ReviewerSummary[] = [], targetErrors: WaitTargetError[] = []): JobRunResult {
  return { wait_result: "timed_out", matched: false, reason: "timeout", targets: snapshots, ...targetErrorResult(targetErrors), ...reviewerResult(reviewerSummaries) };
}

function conditionMetResult(snapshots: WaitTargetSnapshot[], reviewerSummaries: ReviewerSummary[] = [], targetErrors: WaitTargetError[] = []): JobRunResult {
  const matchedTargets = snapshots.filter((snapshot) => snapshot.matched).map((snapshot) => ({ target: snapshot.target, targetId: snapshot.targetId }));
  return {
    wait_result: "condition_met",
    matched: true,
    reason: "condition_met",
    matchedTargetCount: matchedTargets.length,
    matchedTargets,
    targets: snapshots,
    ...targetErrorResult(targetErrors),
    ...reviewerResult(reviewerSummaries)
  };
}

function managerJudgmentResult(snapshots: WaitTargetSnapshot[], reviewerSummaries: ReviewerSummary[], targetErrors: WaitTargetError[] = []): JobRunResult {
  return { wait_result: "manager_judgment_required", matched: false, reason: "manager_judgment_required", targets: snapshots, ...targetErrorResult(targetErrors), ...reviewerResult(reviewerSummaries) };
}

function targetReadFailureResult(read: WaitObservation, reviewerSummaries: ReviewerSummary[] = []): JobRunResult {
  return { wait_result: "failed", matched: false, reason: "target_read_failed", targets: read.snapshots, targetErrors: read.targetErrors, ...reviewerResult(reviewerSummaries) };
}

function timeoutIfExpired(read: WaitObservation, reviewerSummaries: ReviewerSummary[] = []): JobRunResult | undefined {
  return read.expired ? timedOutResult(read.snapshots, reviewerSummaries, read.targetErrors) : undefined;
}

function throwTargetReadFailure(read: WaitObservation, reviewerSummaries: ReviewerSummary[] = []): never {
  const result = targetReadFailureResult(read, reviewerSummaries);
  const firstCode = read.targetErrors[0]?.code;
  const sameCode = firstCode !== undefined && read.targetErrors.every((error) => error.code === firstCode);
  const knownCodes: WaitError["code"][] = ["INVALID_INPUT", "ABORTED", "REVIEWER_FAILED", "CLI_PROTOCOL_ERROR", "CLI_TIMEOUT", "TARGET_NOT_FOUND", "TARGET_AMBIGUOUS", "TARGET_TYPE_MISMATCH", "CONTEXT_UNAVAILABLE", "SESSION_REPLACED"];
  const code = sameCode && knownCodes.includes(firstCode as WaitError["code"]) ? firstCode as WaitError["code"] : "CLI_PROTOCOL_ERROR";
  throw new WaitError(code, `${code}: one or more wait targets could not be observed`, { targetErrors: read.targetErrors }, result);
}

function observationResult(params: WaitParams, read: WaitObservation, reviewerSummaries: ReviewerSummary[] = []): JobRunResult | undefined {
  const timeout = timeoutIfExpired(read, reviewerSummaries);
  if (timeout) return timeout;
  if (aggregate(params, read.snapshots)) return conditionMetResult(read.snapshots, reviewerSummaries, read.targetErrors);
  if (read.targetErrors.length > 0) throwTargetReadFailure(read, reviewerSummaries);
  return undefined;
}

async function unknownReviewProvesWorking(
  cli: WaitCli,
  item: ReadTargetInput | undefined,
  snapshot: WaitTargetSnapshot | undefined,
  signal: AbortSignal,
  control?: JobOperationControl,
): Promise<boolean> {
  if (!item?.identity || !snapshot || snapshot.targetId !== item.identity.paneId) return false;
  const retained = retainedAuthoritativeState(snapshot);
  if (retained !== undefined) return retained === "working";
  const agent = await readFreshAgent(cli, item.identity.paneId, signal, control);
  if (!agent) throw new WaitError("CLI_PROTOCOL_ERROR", "CLI_PROTOCOL_ERROR: authoritative agent state is unavailable");
  const state = explicitState(agent, "agent");
  if (state === undefined) throw new WaitError("CLI_PROTOCOL_ERROR", "CLI_PROTOCOL_ERROR: agent response omitted its authoritative state");
  const observed = waitIdentity([agent], item.identity.paneId);
  if (!sameWaitTargetIdentity(observed, item.identity)) throw new WaitError("CLI_PROTOCOL_ERROR", "CLI_PROTOCOL_ERROR: wait target identity changed");
  return state === "working";
}

export function mapReviewerFailure(error: unknown): WaitError {
  if (error instanceof WaitError) return error;
  if (error instanceof ReviewerFailure) return new WaitError("REVIEWER_FAILED", `REVIEWER_FAILED: ${error.message}`, error.details);
  return new WaitError("REVIEWER_FAILED", "REVIEWER_FAILED: reviewer call failed", { cause: error instanceof Error ? error.message : String(error) });
}

type ReviewerRun = { kind: "completed"; reviews: ReviewerResult[] } | { kind: "timed_out" };

async function runReviewersWithDeadline(
  reviewer: WaitReviewer,
  requests: ReviewerRequest[],
  signal: AbortSignal,
  deadline: number,
  clock: WaitClock,
  control?: JobOperationControl,
): Promise<ReviewerRun> {
  checkAbort(signal);
  const remaining = deadline - clock.now();
  checkAbort(signal);
  if (remaining <= 0) return { kind: "timed_out" };
  const controller = new AbortController();
  const linked = linkedSignal(signal, controller);
  let deadlineReached = false;
  let timer!: ReturnType<typeof setTimeout>;
  let resolveDeadline!: () => void;
  const deadlinePromise = new Promise<"deadline">((resolve) => {
    resolveDeadline = () => {
      deadlineReached = true;
      resolve("deadline");
    };
    timer = setTimeout(() => {
      controller.abort();
      resolveDeadline();
    }, Math.min(Math.max(1, remaining), 2_147_483_647));
  });
  let removeAbortListener!: () => void;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error("ABORTED: reviewer operation was cancelled"), { code: "ABORTED" }));
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });
  const reviewsPromise = Promise.all(requests.map(async (request) => {
    const release = control?.beginActivity();
    try {
      const review = await reviewer.review(request, linked.signal);
      control?.check();
      return review;
    } finally {
      release?.();
    }
  }));
  try {
    const outcome = await Promise.race([
      reviewsPromise.then((reviews): ReviewerRun => ({ kind: "completed", reviews })),
      deadlinePromise.then((): ReviewerRun => ({ kind: "timed_out" })),
      abortPromise
    ]);
    if (outcome.kind === "timed_out" || clock.now() >= deadline) {
      controller.abort();
      void reviewsPromise.catch(() => undefined);
      return { kind: "timed_out" };
    }
    return outcome;
  } catch (error) {
    if (deadlineReached || clock.now() >= deadline) {
      controller.abort();
      void reviewsPromise.catch(() => undefined);
      return { kind: "timed_out" };
    }
    if (signal.aborted || errorCode(error) === "ABORTED") abort();
    throw mapReviewerFailure(error);
  } finally {
    clearTimeout(timer);
    removeAbortListener();
    linked.dispose();
  }
}

export async function prepareWait(deps: WaitDependencies, rawParams: unknown, signal: AbortSignal): Promise<PreparedWait> {
  checkAbort(signal);
  let validation;
  try {
    validation = validateWaitParams(rawParams);
  } catch (error) {
    throw new WaitError("INVALID_INPUT", String(error));
  }
  const params = validation.params;
  let settings: Settings;
  try {
    settings = await (deps.settingsLoader ?? (() => loadSettings()))();
  } catch (error) {
    if (error instanceof Error && errorCode(error) === "INVALID_SETTINGS") throw error;
    throw new WaitError("INVALID_INPUT", "INVALID_SETTINGS: extension-owned wait settings are invalid", { cause: error instanceof Error ? error.message : String(error) });
  }
  checkAbort(signal);
  const contextResolver = deps.contextResolver ?? createContextResolver(deps.cli, deps.context);
  const effective = await contextResolver(signal);
  const initial = effective.snapshot;
  const requireIdentity = deps.requireTargetIdentity === true || (deps.cli as WaitCli).supportsNativeAgentWait === true;
  const resolved = [];
  for (const ref of params.targets) {
    const target = resolveTarget(initial, ref, "agent", effective.context);
    const paneId = target.paneId!;
    const records: Record<string, unknown>[] = [target.record, ...initial.agents.filter((agent) => agent.pane_id === paneId)];
    let identity: WaitTargetIdentity | undefined;
    if (requireIdentity) {
      // Lazy target adoption (ADR-028): a detected pane whose only missing
      // join field is the agent name gets a derived name minted before the
      // wait binding fails closed; later identity reads see it natively.
      if (nameOnlyGap(records, paneId) === "ready") {
        const targetKind = records.map((value) => parsePromptTargetIdentityFields(value, paneId).agentKind).find((kind) => kind !== undefined);
        if (targetKind !== undefined && LAZY_ADOPT_KINDS.has(targetKind)) {
          const adopted = await adoptUnnamedTarget(deps.cli, paneId, targetKind, effective.context.paneId, signal);
          if (adopted.minted !== undefined) records.push(adopted.minted);
        }
      }
      identity = waitIdentity(records, paneId);
    }
    resolved.push({
      ref,
      target,
      targetGenerationRef: createTargetGenerationRef(deps.targetGenerationRefFactory),
      ...(identity ? { identity } : {})
    });
  }
  const ids = new Set<string>();
  for (const item of resolved) {
    if (ids.has(item.target.id)) throw new WaitError("INVALID_INPUT", "INVALID_INPUT: target references resolve to the same resource", { targetId: item.target.id });
    ids.add(item.target.id);
  }
  return {
    params: structuredClone(params),
    ...(effective.diagnostics.rebound ? { contextRebinding: effective.diagnostics } : {}),
    label: deriveWaitLabel(params, resolved),
    validation: { ...(validation.regex ? { regex: validation.regex } : {}) },
    settings: { ...settings },
    resolved: resolved.map((item) => ({ ref: item.ref, target: { ...item.target, record: structuredClone(item.target.record) }, targetGenerationRef: item.targetGenerationRef, ...(item.identity ? { identity: structuredClone(item.identity) } : {}) }))
  };
}

export function jobRequestFromPrepared(prepared: PreparedWait): JobRequestSnapshot {
  return {
    kind: "wait",
    label: prepared.label,
    targets: [...prepared.params.targets],
    targetIds: prepared.resolved.map((item) => item.target.id),
    target_generation_refs: prepared.resolved.map((item) => item.targetGenerationRef),
    match: prepared.params.match,
    condition: structuredClone(prepared.params.condition),
    timeoutMs: prepared.params.timeoutMs,
    settings: { ...prepared.settings }
  };
}

function progressDetails(
  params: WaitParams,
  label: string,
  snapshots: WaitTargetSnapshot[],
  reviewerSummaries: ReviewerSummary[],
  contextRebinding: ContextResolutionDiagnostics | undefined
): WaitJobProgressDetails {
  return {
    operation: "wait",
    operation_phase: "running",
    label,
    match: params.match,
    condition: params.condition,
    targets: snapshots,
    ...(reviewerSummaries.length > 0 ? { reviewerSummaries } : {}),
    ...(contextRebinding ? contextRebindingDetails(contextRebinding) : {})
  };
}

export async function runPreparedWait(
  deps: WaitDependencies,
  prepared: PreparedWait,
  signal: AbortSignal,
  update: (text: string, details?: unknown) => void,
  context: ExtensionContext,
  control?: JobOperationControl
): Promise<JobRunResult> {
  const { params, label, validation, settings, resolved, contextRebinding } = prepared;
  const clock = deps.clock ?? realClock;
  const start = clock.now();
  const deadline = start + params.timeoutMs;
  const cadenceMs = settings.reviewCadenceMinutes * 60_000;
  const longWait = params.timeoutMs > cadenceMs;
  const nativePredicate = deps.cli.supportsNativeAgentWait === true && params.condition.kind === "state";
  const strictIdentity = deps.requireTargetIdentity === true || deps.cli.supportsNativeAgentWait === true;
  let nextReview = start + cadenceMs;
  const initialNativeDeadline = nativePredicate && longWait ? Math.min(deadline, start + cadenceMs) : deadline;
  let read = nativePredicate
    ? await readCurrentState(deps.cli, resolved, clock, signal, deadline, params.condition as Extract<WaitCondition, { kind: "state" }>, params.match, control, deps.handoffs)
    : await readInitialObservation(deps.cli, resolved, clock, signal, deadline, params.condition, params.match, validation.regex, control, strictIdentity, initialNativeDeadline, deps.handoffs);
  let snapshots = read.snapshots;
  let targetErrors = read.targetErrors;
  let settled = observationResult(params, read);
  if (settled) return settled;
  if (nativePredicate) {
    read = await readInitialObservation(deps.cli, resolved, clock, signal, deadline, params.condition, params.match, validation.regex, control, strictIdentity, initialNativeDeadline, deps.handoffs);
    snapshots = read.snapshots;
    targetErrors = read.targetErrors;
    settled = observationResult(params, read);
    if (settled) return settled;
  }
  let reviewer: WaitReviewer | undefined;
  const reviewerSummaries: ReviewerSummary[] = [];
  const sentLines = new Map<string, string[]>();
  const previousReviews = new Map<string, SupervisionPreviousReview>();
  let lastStates = snapshots.map((snapshot) => rawState(snapshot.metadata));
  const progress = (text: string) => update(text.slice(0, 500), progressDetails(params, label, snapshots, reviewerSummaries, contextRebinding));
  progress("waiting");

  while (true) {
    checkAbort(signal);
    const now = clock.now();
    if (expired(clock, deadline, snapshots)) return timedOutResult(snapshots, reviewerSummaries, targetErrors);
    const untilReview = longWait ? Math.max(0, nextReview - now) : Number.MAX_SAFE_INTEGER;
    control?.check();
    await clock.sleep(Math.min(deps.pollIntervalMs ?? 250, deadline - now, untilReview), signal);
    control?.check();
    checkAbort(signal);
    if (expired(clock, deadline, snapshots)) return timedOutResult(snapshots, reviewerSummaries, targetErrors);
    if (nativePredicate) {
      const fresh = await readCurrentState(deps.cli, resolved, clock, signal, deadline, params.condition as Extract<WaitCondition, { kind: "state" }>, params.match, control, deps.handoffs);
      snapshots = fresh.snapshots;
      targetErrors = fresh.targetErrors;
      settled = observationResult(params, fresh, reviewerSummaries);
      if (settled) return settled;
    }
    const nativePollDeadline = nativePredicate && longWait ? Math.min(deadline, nextReview) : deadline;
    read = await readInitialObservation(deps.cli, resolved, clock, signal, deadline, params.condition, params.match, validation.regex, control, strictIdentity, nativePollDeadline, deps.handoffs);
    snapshots = read.snapshots;
    targetErrors = read.targetErrors;
    settled = observationResult(params, read, reviewerSummaries);
    if (settled) return settled;
    const newStates = snapshots.map((snapshot) => rawState(snapshot.metadata));
    if (newStates.some((state, index) => state !== lastStates[index])) {
      progress(`state changed: ${newStates.join(", ")}`);
      lastStates = newStates;
    }
    if (!longWait || clock.now() < nextReview) continue;
    nextReview += cadenceMs;
    if (nativePredicate) {
      const reviewerRead = await readAndMatch(deps.cli, resolved, clock, signal, deadline, params.condition, params.match, validation.regex, control, strictIdentity, deps.handoffs);
      if (reviewerRead.expired) return timedOutResult(reviewerRead.snapshots, reviewerSummaries, reviewerRead.targetErrors);
      if (reviewerRead.targetErrors.length > 0) throwTargetReadFailure(reviewerRead, reviewerSummaries);
      // This composite refresh is reviewer context only. A native predicate can
      // be satisfied only by the occupant-pinned agent.wait route below.
      // Keep the reviewer read as historical evidence, but never let its
      // composite match replace the native predicate result.
      snapshots = reviewerRead.snapshots.map((snapshot) => ({ ...snapshot, matched: false }));
      targetErrors = reviewerRead.targetErrors;
      lastStates = snapshots.map((snapshot) => rawState(snapshot.metadata));
      const fresh = await readCurrentState(deps.cli, resolved, clock, signal, deadline, params.condition as Extract<WaitCondition, { kind: "state" }>, params.match, control, deps.handoffs);
      snapshots = fresh.snapshots;
      targetErrors = fresh.targetErrors;
      settled = observationResult(params, fresh, reviewerSummaries);
      if (settled) return settled;
    }
    const supervisorCovered: Array<{ target: string; targetId: string; supervisorJobId: string }> = [];
    const explicitSnapshots: WaitTargetSnapshot[] = [];
    for (const snapshot of snapshots) {
      const item = resolved.find((candidate) => candidate.target.paneId === snapshot.targetId);
      const coverage = item?.identity ? deps.jobRegistry.activeSupervisorFor(item.identity) : undefined;
      if (coverage) supervisorCovered.push({ target: snapshot.target, targetId: snapshot.targetId, supervisorJobId: coverage.jobId });
      else explicitSnapshots.push(snapshot);
    }
    control?.publishSemanticReview({
      observedAtMs: clock.now(),
      supervisorCovered,
      explicitReviewerTargetIds: explicitSnapshots.map((snapshot) => snapshot.targetId),
      omittedSupervisorCovered: 0,
      omittedExplicitReviewerTargetIds: 0,
    });
    if (explicitSnapshots.length === 0) continue;
    const requests: ReviewerRequest[] = explicitSnapshots.map((snapshot) => {
      const previous = sentLines.get(snapshot.targetId) ?? [];
      const delta = deltaLines(previous, snapshot.recentUnwrappedLines);
      sentLines.set(snapshot.targetId, snapshot.recentUnwrappedLines.slice(-100));
      const previousReview = previousReviews.get(snapshot.targetId);
      // The shared request contract has no temporal fields, so the previous
      // review folds into the copied metadata object — both reviewer
      // implementations forward metadata verbatim into the model's evidence.
      return {
        targetId: snapshot.targetId,
        metadata: {
          ...compactMetadata(snapshot.metadata),
          ...(previousReview === undefined ? {} : { previousReview }),
          linesSinceLastReview: delta.length
        },
        transcriptDelta: delta.slice(-100)
      };
    });
    let reviews: ReviewerResult[];
    try {
      control?.check();
      reviewer ??= createConfiguredWaitReviewer(
        context,
        settings.reviewerModel,
        { apiKey: await resolveTypesafeApiKey() },
        deps.reviewerFactory ? () => deps.reviewerFactory!(settings, context) : undefined,
      );
      const reviewerRun = await runReviewersWithDeadline(reviewer, requests, signal, deadline, clock, control);
      if (reviewerRun.kind === "timed_out") return timedOutResult(snapshots, reviewerSummaries, targetErrors);
      reviews = reviewerRun.reviews;
      checkAbort(signal);
    } catch (error) {
      if (signal.aborted || errorCode(error) === "ABORTED") abort();
      throw mapReviewerFailure(error);
    }
    if (nativePredicate) {
      const fresh = await readCurrentState(deps.cli, resolved, clock, signal, deadline, params.condition as Extract<WaitCondition, { kind: "state" }>, params.match, control, deps.handoffs);
      snapshots = fresh.snapshots;
      targetErrors = fresh.targetErrors;
      settled = observationResult(params, fresh, reviewerSummaries);
      if (settled) return settled;
    }
    let hardManagerJudgment = false;
    const unknownReviews: ReviewerResult[] = [];
    for (const review of reviews) {
      const signals = (review as ReviewerResult & { signals?: SupervisionSignalProbabilities }).signals;
      previousReviews.set(review.targetId, { classification: review.classification, ...(signals === undefined ? {} : { signals }) });
      const summary: ReviewerSummary = { target: resolved.find((item) => item.target.paneId === review.targetId)?.ref ?? review.targetId, targetId: review.targetId, classification: review.classification, summary: review.summary.slice(0, 500) };
      reviewerSummaries.push(summary);
      hardManagerJudgment ||= review.classification === "stalled" || review.classification === "blocked" || review.classification === "risk";
      if (review.classification === "unknown") unknownReviews.push(review);
      progress(`review ${review.targetId}: ${review.classification} ${review.summary}`);
    }
    if (hardManagerJudgment || unknownReviews.length > 0) {
      if (expired(clock, deadline, snapshots)) return timedOutResult(snapshots, reviewerSummaries, targetErrors);
      if (nativePredicate) {
        const fresh = await readCurrentState(deps.cli, resolved, clock, signal, deadline, params.condition as Extract<WaitCondition, { kind: "state" }>, params.match, control, deps.handoffs);
        snapshots = fresh.snapshots;
        targetErrors = fresh.targetErrors;
        settled = observationResult(params, fresh, reviewerSummaries);
        if (settled) return settled;
      }
      const nativeReviewDeadline = nativePredicate ? Math.min(deadline, clock.now() + 1) : deadline;
      read = await readInitialObservation(deps.cli, resolved, clock, signal, deadline, params.condition, params.match, validation.regex, control, strictIdentity, nativeReviewDeadline, deps.handoffs);
      snapshots = read.snapshots;
      targetErrors = read.targetErrors;
      settled = observationResult(params, read, reviewerSummaries);
      if (settled) return settled;
      if (!hardManagerJudgment) {
        let unknownRequiresJudgment = false;
        for (const review of unknownReviews) {
          const item = resolved.find((candidate) => candidate.target.paneId === review.targetId);
          const snapshot = snapshots.find((candidate) => candidate.targetId === review.targetId);
          try {
            unknownRequiresJudgment ||= !(await unknownReviewProvesWorking(deps.cli, item, snapshot, signal, control));
          } catch (error) {
            if (expired(clock, deadline, snapshots)) return timedOutResult(snapshots, reviewerSummaries, targetErrors);
            throwTargetReadFailure({ snapshots, targetErrors: [targetError(item!, error)], expired: false }, reviewerSummaries);
          }
        }
        if (!unknownRequiresJudgment) continue;
      }
      return managerJudgmentResult(snapshots, reviewerSummaries, targetErrors);
    }
  }
}

export function createWaitTool(deps: WaitDependencies): ToolDefinition<typeof WaitParamsSchema, WaitDetails> {
  const settingsLoader = deps.settingsLoader ?? (() => loadSettings());
  return {
    name: "herdr_wait",
    label: "Herdr Wait",
    description: "Wait for exact Herdr agent targets to satisfy an authoritative state or pane-output condition, including terminal states; every call preflights, accepts a detached operation, and returns a job ID for herdr_jobs; state predicates use native occupant-pinned agent.wait when supported.",
    parameters: WaitParamsSchema,
    async execute(_id, rawParams, signal, _onUpdate, context) {
      const activeSignal = signal ?? new AbortController().signal;
      checkAbort(activeSignal);
      const generation = deps.jobRegistry.captureGeneration();
      const prepared = await prepareWait({ ...deps, settingsLoader }, rawParams, activeSignal);
      checkAbort(activeSignal);
      if (!deps.jobRegistry.isCurrent(generation)) throw new WaitError("SESSION_REPLACED", "SESSION_REPLACED: wait session was replaced before registration");
      const registered = deps.jobRegistry.register(
        jobRequestFromPrepared(prepared),
        async (jobSignal, update, control): Promise<JobRunResult> => runPreparedWait({ ...deps, settingsLoader }, prepared, jobSignal, update, context, control),
        generation
      );
      const targetIds = prepared.resolved.map((item) => item.target.id);
      const details = { ...boundedBackgroundDetails(registered.jobId, prepared.label, prepared.params, targetIds), ...(prepared.contextRebinding ? contextRebindingDetails(prepared.contextRebinding) : {}) };
      return {
        content: [{ type: "text", text: `wait accepted · ${details.label} · ${details.jobId}` }],
        details
      };
    },
    renderCall(rawArgs, theme) {
      const args = rawArgs as WaitParams;
      const operation = args.label ? `${args.match ?? "wait"} · ${args.label}` : `${args.match ?? "wait"}`;
      return textComponent(formatCall("herdr_wait", operation, args.targets?.join(",")), theme, "accent");
    },
    renderResult(result, options, theme) {
      const rendered = resultForRender("wait", result, options);
      const label = typeof (result.details as { label?: unknown } | undefined)?.label === "string" ? (result.details as { label: string }).label : undefined;
      return textComponent(`${rendered.text}${label ? ` · ${label}` : ""}`, theme, rendered.tone);
    }
  };
}
