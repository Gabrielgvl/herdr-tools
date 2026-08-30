import RE2 from "re2";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CliTextResult, HerdrCli, JsonEnvelope } from "../cli.js";
import { contextRebindingDetails, createContextResolver, type ContextResolutionDiagnostics, type ContextResolver } from "../context.js";
import { loadSettings, type Settings } from "../settings.js";
import { resolveTarget, type CurrentContext, type ResolvedTarget } from "../targets.js";
import { createPiModelReviewer, ReviewerFailure, type ReviewerRequest, type ReviewerResult, type WaitReviewer } from "../reviewer.js";
import { validateWaitParams, WAIT_LABEL_MAX_BYTES, WAIT_LABEL_MAX_LENGTH, WaitParamsSchema, type SafeRegex, type WaitCondition, type WaitParams, type WaitRawState, type WaitSemanticState } from "../wait-schema.js";
import { boundedText, type JobOperationControl, type JobRegistry, type JobRequestSnapshot, type JobRunResult } from "../job-registry.js";
import { createTargetGenerationRef, historicalTargetEvidence, requireWaitTargetIdentity, sameWaitTargetIdentity, type TargetEvidence, type WaitTargetIdentity } from "../wait-target-evidence.js";
import { withoutEnvironment } from "../redaction.js";
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

export interface WaitTargetSnapshot {
  target: string;
  targetId: string;
  metadata: Record<string, unknown>;
  recentUnwrappedLines: string[];
  outputTruncated?: boolean;
  observedAtMs: number;
  matched: boolean;
  target_evidence?: TargetEvidence;
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
  constructor(readonly code: "INVALID_INPUT" | "ABORTED" | "REVIEWER_FAILED" | "CLI_PROTOCOL_ERROR" | "CLI_TIMEOUT" | "TARGET_NOT_FOUND" | "TARGET_AMBIGUOUS" | "TARGET_TYPE_MISMATCH" | "CONTEXT_UNAVAILABLE" | "SESSION_REPLACED", message: string, readonly details: Record<string, unknown> = {}) {
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

function rawState(metadata: Record<string, unknown>): string {
  const value = metadata.agent_status;
  return typeof value === "string" ? value : "unknown";
}

export function matchesState(state: string, requested: string): boolean {
  if (["idle", "working", "blocked", "done", "unknown"].includes(requested)) return state === requested;
  if (requested === "started") return state === "working";
  if (requested === "completed") return state === "idle" || state === "done";
  if (requested === "terminal") return state === "idle" || state === "blocked" || state === "done";
  return requested === "needs_input" && state === "blocked";
}

export function matches(snapshot: WaitTargetSnapshot, condition: WaitCondition, regex?: SafeRegex): boolean {
  if (condition.kind === "state") return matchesState(rawState(snapshot.metadata), condition.state);
  const output = snapshot.recentUnwrappedLines.join("\n");
  const compactOutput = snapshot.recentUnwrappedLines.map((line) => line.trim()).join("");
  if (condition.match.kind === "literal") {
    return output.includes(condition.match.value) || (!/\s/.test(condition.match.value) && compactOutput.includes(condition.match.value));
  }
  const safeRegex = regex ?? new RE2(condition.match.value);
  return safeRegex.test(output) || safeRegex.test(compactOutput);
}

function samePrefix(previous: string[], current: string[]): number {
  let index = 0;
  while (index < previous.length && index < current.length && previous[index] === current[index]) index += 1;
  return index;
}

export function deltaLines(previous: string[], current: string[]): string[] {
  if (previous.length === 0) return current.slice(-100);
  if (current.length >= previous.length && previous.every((line, index) => current[index] === line)) return current.slice(previous.length, previous.length + 100);
  let overlap = Math.min(previous.length, current.length);
  while (overlap > 0) {
    const priorTail = previous.slice(previous.length - overlap);
    if (priorTail.every((line, index) => line === current[index])) return current.slice(overlap, overlap + 100);
    overlap -= 1;
  }
  const prefix = samePrefix(previous, current);
  if (prefix === current.length) return [];
  return current.slice(Math.max(prefix, current.length - 100), current.length);
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

async function readFreshAgent(cli: WaitCli, paneId: string, signal: AbortSignal, control?: JobOperationControl): Promise<Record<string, unknown> | undefined> {
  try {
    return agentRecordFrom((await guardedCall(() => cli.runJson(["agent", "get", paneId], signal), signal, control)).result);
  } catch (error) {
    if (isAgentAbsentError(error)) return undefined;
    throw error;
  }
}

async function readStrictIdentity(cli: WaitCli, pane: Record<string, unknown>, paneId: string, signal: AbortSignal, control?: JobOperationControl): Promise<WaitTargetIdentity> {
  const agent = await readFreshAgent(cli, paneId, signal, control);
  if (!agent) throw new WaitError("CLI_PROTOCOL_ERROR", "CLI_PROTOCOL_ERROR: wait target identity is unavailable");
  return waitIdentity([pane, agent], paneId);
}

async function readTarget(cli: WaitCli, item: ReadTargetInput, clock: WaitClock, signal: AbortSignal, control?: JobOperationControl, strict = false): Promise<WaitTargetSnapshot> {
  checkAbort(signal);
  const paneId = item.target.paneId!;
  try {
    const pane = paneFrom((await guardedCall(() => cli.runJson(["pane", "get", paneId], signal), signal, control)).result, paneId);
    let identityA: WaitTargetIdentity | undefined;
    if (strict) {
      identityA = await readStrictIdentity(cli, pane, paneId, signal, control);
      if (!item.identity || !sameWaitTargetIdentity(identityA, item.identity)) throw new WaitError("CLI_PROTOCOL_ERROR", "CLI_PROTOCOL_ERROR: wait target identity changed");
    }
    const readArgs = ["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", "100", "--format", "text"];
    const output = cli.runTextResult
      ? await guardedCall(() => cli.runTextResult!(readArgs, signal), signal, control)
      : { value: await guardedCall(() => cli.runText(readArgs, signal), signal, control), truncated: false };
    if (strict) {
      const after = paneFrom((await guardedCall(() => cli.runJson(["pane", "get", paneId], signal), signal, control)).result, paneId);
      const identityB = await readStrictIdentity(cli, after, paneId, signal, control);
      if (!identityA || !sameWaitTargetIdentity(identityA, identityB) || !item.identity || !sameWaitTargetIdentity(identityB, item.identity)) {
        throw new WaitError("CLI_PROTOCOL_ERROR", "CLI_PROTOCOL_ERROR: wait target identity changed");
      }
    }
    checkAbort(signal);
    return { target: item.ref, targetId: paneId, metadata: metadataWithoutIdentity(pane), recentUnwrappedLines: boundedLines(output.value), outputTruncated: output.truncated, observedAtMs: clock.now(), matched: false };
  } catch (error) {
    if (signal.aborted || errorCode(error) === "ABORTED") abort();
    if (error instanceof WaitError) throw error;
    throw new WaitError((errorCode(error) as WaitError["code"] | undefined) ?? "CLI_PROTOCOL_ERROR", `Unable to read target ${item.ref}`, { target: item.ref, targetId: paneId, cause: error instanceof Error ? error.message : String(error) });
  }
}

async function readCurrentStateTarget(
  cli: WaitCli,
  item: ReadTargetInput,
  clock: WaitClock,
  signal: AbortSignal,
  condition: Extract<WaitCondition, { kind: "state" }>,
  control?: JobOperationControl,
): Promise<WaitTargetSnapshot> {
  checkAbort(signal);
  const paneId = item.target.paneId!;
  try {
    const pane = paneFrom((await guardedCall(() => cli.runJson(["pane", "get", paneId], signal), signal, control)).result, paneId);
    const status = rawState(pane);
    const agent = await readFreshAgent(cli, paneId, signal, control);
    const agentAbsent = agent === undefined;
    if (agentAbsent) {
      if (status !== "unknown") throw new WaitError("CLI_PROTOCOL_ERROR", "CLI_PROTOCOL_ERROR: wait target identity is unavailable");
    } else {
      const identity = waitIdentity([pane, agent], paneId);
      if (!item.identity || !sameWaitTargetIdentity(identity, item.identity)) throw new WaitError("CLI_PROTOCOL_ERROR", "CLI_PROTOCOL_ERROR: wait target identity changed");
    }
    const observedAtMs = clock.now();
    return {
      target: item.ref,
      targetId: paneId,
      metadata: metadataWithoutIdentity({ ...pane, agent_status: status }),
      recentUnwrappedLines: [],
      observedAtMs,
      matched: matchesState(status, condition.state),
      target_evidence: historicalTargetEvidence(agentAbsent ? "agent_absent_observed" : "predicate_observed", observedAtMs, item.targetGenerationRef, "composite_observation")
    };
  } catch (error) {
    if (signal.aborted || errorCode(error) === "ABORTED") abort();
    if (error instanceof WaitError) throw error;
    throw new WaitError((errorCode(error) as WaitError["code"] | undefined) ?? "CLI_PROTOCOL_ERROR", `Unable to read target ${item.ref}`, { target: item.ref, targetId: paneId, cause: error instanceof Error ? error.message : String(error) });
  }
}

async function readCurrentState(
  cli: WaitCli,
  resolved: ReadonlyArray<ReadTargetInput>,
  clock: WaitClock,
  signal: AbortSignal,
  deadline: number,
  condition: Extract<WaitCondition, { kind: "state" }>,
  control?: JobOperationControl,
): Promise<{ snapshots: WaitTargetSnapshot[]; expired: boolean }> {
  const snapshots = await Promise.all(resolved.map((item) => readCurrentStateTarget(cli, item, clock, signal, condition, control)));
  checkAbort(signal);
  return { snapshots, expired: expired(clock, deadline, snapshots) };
}

async function readAll(cli: WaitCli, resolved: ReadonlyArray<ReadTargetInput>, clock: WaitClock, signal: AbortSignal, control?: JobOperationControl, strict = false): Promise<WaitTargetSnapshot[]> {
  checkAbort(signal);
  const values = await Promise.all(resolved.map((item) => readTarget(cli, item, clock, signal, control, strict)));
  checkAbort(signal);
  return values;
}

async function readAndMatch(cli: WaitCli, resolved: ReadonlyArray<ReadTargetInput>, clock: WaitClock, signal: AbortSignal, deadline: number, condition: WaitCondition, regex?: SafeRegex, control?: JobOperationControl, strict = false): Promise<{ snapshots: WaitTargetSnapshot[]; expired: boolean }> {
  const snapshots = await readAll(cli, resolved, clock, signal, control, strict);
  snapshots.forEach((snapshot, index) => {
    // A settled timeout still needs to identify the historical observation even
    // though the late sample cannot satisfy the predicate.
    snapshot.target_evidence = historicalTargetEvidence("predicate_observed", snapshot.observedAtMs, resolved[index]!.targetGenerationRef, "composite_observation");
  });
  if (expired(clock, deadline, snapshots)) return { snapshots, expired: true };
  snapshots.forEach((snapshot) => {
    snapshot.matched = matches(snapshot, condition, regex);
  });
  return { snapshots, expired: expired(clock, deadline, snapshots) };
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

function hasCompleteIdentity(value: Record<string, unknown>, paneId: string): boolean {
  try {
    requireWaitTargetIdentity([value], paneId);
    return true;
  } catch {
    return false;
  }
}

function nativeSnapshot(
  item: ReadTargetInput,
  record: Record<string, unknown>,
  status: string,
  observedAtMs: number,
  matched: boolean,
  agentAbsent = false,
): WaitTargetSnapshot {
  const kind = agentAbsent ? "agent_absent_observed" : status === "done" ? "native_done_observed" : "predicate_observed";
  return {
    target: item.ref,
    targetId: item.target.paneId!,
    metadata: metadataWithoutIdentity({ ...record, agent_status: status }),
    recentUnwrappedLines: [],
    observedAtMs,
    matched,
    target_evidence: historicalTargetEvidence(kind, observedAtMs, item.targetGenerationRef, "native_agent_wait")
  };
}

function nativeTimeoutSnapshot(item: ReadTargetInput, clock: WaitClock): WaitTargetSnapshot {
  const observedAtMs = clock.now();
  return {
    target: item.ref,
    targetId: item.target.paneId!,
    metadata: metadataWithoutIdentity(item.target.record),
    recentUnwrappedLines: [],
    observedAtMs,
    matched: false,
    target_evidence: historicalTargetEvidence("identity_unknown", observedAtMs, item.targetGenerationRef, "native_agent_wait")
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
    // Herdr protocol 20's wait_matched event carries the matched pane/status but
    // not always the complete occupant identity. In that wire shape, one
    // post-wait agent.get verifies the server-pinned result without rebuilding
    // the predicate with a client-side poll/sandwich.
    let agentAbsent = false;
    let identityValues: unknown[] = [record];
    if (!hasCompleteIdentity(record, item.target.paneId!)) {
      if (cli.runNativeAgentWait) throw new WaitError("CLI_PROTOCOL_ERROR", "CLI_PROTOCOL_ERROR: native agent.wait returned incomplete target identity");
      const agent = await readFreshAgent(cli, item.target.paneId!, signal, control);
      if (!agent) {
        if (status !== "unknown") throw new WaitError("CLI_PROTOCOL_ERROR", "CLI_PROTOCOL_ERROR: native agent.wait target identity is unavailable");
        agentAbsent = true;
      } else {
        identityValues = [record, agent];
      }
    }
    if (!agentAbsent) {
      const identity = waitIdentity(identityValues, item.target.paneId!);
      if (!item.identity || !sameWaitTargetIdentity(identity, item.identity)) throw new WaitError("CLI_PROTOCOL_ERROR", "CLI_PROTOCOL_ERROR: native agent.wait target occupant changed");
    }
    const observedAtMs = clock.now();
    const matched = observedAtMs < deadline && matchesState(status, condition.state);
    return nativeSnapshot(item, record, status, observedAtMs, matched, agentAbsent);
  } catch (error) {
    if (signal.aborted || errorCode(error) === "ABORTED") abort();
    // A typed timeout from the native command means its predicate expired; a
    // killed subprocess (or a post-match verification timeout) is a failure.
    if (phase === "native_wait" && isNativePredicateTimeout(error)) return nativeTimeoutSnapshot(item, clock);
    if (errorCode(error) === "CLI_TIMEOUT") throw new WaitError("CLI_TIMEOUT", "CLI_TIMEOUT: native wait or target verification timed out", { target: item.ref, targetId: item.target.paneId! });
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
): Promise<{ snapshots: WaitTargetSnapshot[]; expired: boolean }> {
  const linked = resolved.map(() => {
    const controller = new AbortController();
    return { controller, ...linkedSignal(signal, controller) };
  });
  const promises = resolved.map((item, index) => readNativeTarget(cli, item, clock, linked[index]!.signal, deadline, condition, control, nativeWaitDeadline));
  const cleanup = (): void => linked.forEach(({ controller, dispose }) => { controller.abort(); dispose(); });
  if (match === "all") {
    try {
      const snapshots = await Promise.all(promises);
      return { snapshots, expired: clock.now() >= deadline && !snapshots.every((snapshot) => snapshot.matched) };
    } finally {
      cleanup();
    }
  }
  const pending = new Set(promises.map((_, index) => index));
  const observed: WaitTargetSnapshot[] = [];
  try {
    while (pending.size > 0) {
      const next = await Promise.race([...pending].map((index) => promises[index]!.then((snapshot) => ({ index, snapshot }))));
      pending.delete(next.index);
      observed.push(next.snapshot);
      if (next.snapshot.matched) {
        pending.forEach((index) => { void promises[index]!.catch(() => undefined); });
        return { snapshots: observed.sort((left, right) => resolved.findIndex((item) => item.target.paneId === left.targetId) - resolved.findIndex((item) => item.target.paneId === right.targetId)), expired: false };
      }
    }
    return { snapshots: observed.sort((left, right) => resolved.findIndex((item) => item.target.paneId === left.targetId) - resolved.findIndex((item) => item.target.paneId === right.targetId)), expired: clock.now() >= deadline };
  } finally {
    cleanup();
    pending.forEach((index) => { void promises[index]!.catch(() => undefined); });
  }
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
): Promise<{ snapshots: WaitTargetSnapshot[]; expired: boolean }> {
  const native = cli.supportsNativeAgentWait === true && condition.kind === "state";
  return native
    ? readNative(cli, resolved, clock, signal, deadline, condition, match, control, nativeWaitDeadline)
    : readAndMatch(cli, resolved, clock, signal, deadline, condition, regex, control, strict);
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

function timedOutResult(snapshots: WaitTargetSnapshot[], reviewerSummaries: ReviewerSummary[] = []): JobRunResult {
  return { wait_result: "timed_out", matched: false, reason: "timeout", targets: snapshots, ...reviewerResult(reviewerSummaries) };
}

function conditionMetResult(snapshots: WaitTargetSnapshot[], reviewerSummaries: ReviewerSummary[] = []): JobRunResult {
  const matchedTargets = snapshots.filter((snapshot) => snapshot.matched).map((snapshot) => ({ target: snapshot.target, targetId: snapshot.targetId }));
  return {
    wait_result: "condition_met",
    matched: true,
    reason: "condition_met",
    matchedTargetCount: matchedTargets.length,
    matchedTargets,
    targets: snapshots,
    ...reviewerResult(reviewerSummaries)
  };
}

function managerJudgmentResult(snapshots: WaitTargetSnapshot[], reviewerSummaries: ReviewerSummary[]): JobRunResult {
  return { wait_result: "manager_judgment_required", matched: false, reason: "manager_judgment_required", targets: snapshots, ...reviewerResult(reviewerSummaries) };
}

function timeoutIfExpired(read: { snapshots: WaitTargetSnapshot[]; expired: boolean }, reviewerSummaries: ReviewerSummary[] = []): JobRunResult | undefined {
  return read.expired ? timedOutResult(read.snapshots, reviewerSummaries) : undefined;
}

export function mapReviewerFailure(error: unknown): WaitError {
  if (error instanceof WaitError) return error;
  if (error instanceof ReviewerFailure) return new WaitError("REVIEWER_FAILED", `REVIEWER_FAILED: ${error.message}`, error.details);
  return new WaitError("REVIEWER_FAILED", "REVIEWER_FAILED: reviewer call failed", { cause: error instanceof Error ? error.message : String(error) });
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
  const resolved = params.targets.map((ref) => {
    const target = resolveTarget(initial, ref, "agent", effective.context);
    const paneId = target.paneId!;
    const records = [target.record, ...initial.agents.filter((agent) => agent.pane_id === paneId)];
    const identity = requireIdentity ? waitIdentity(records, paneId) : undefined;
    return {
      ref,
      target,
      targetGenerationRef: createTargetGenerationRef(deps.targetGenerationRefFactory),
      ...(identity ? { identity } : {})
    };
  });
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
    ? await readCurrentState(deps.cli, resolved, clock, signal, deadline, params.condition as Extract<WaitCondition, { kind: "state" }>, control)
    : await readInitialObservation(deps.cli, resolved, clock, signal, deadline, params.condition, params.match, validation.regex, control, strictIdentity, initialNativeDeadline);
  let snapshots = read.snapshots;
  const initialTimeout = timeoutIfExpired(read);
  if (initialTimeout) return initialTimeout;
  if (aggregate(params, snapshots)) return conditionMetResult(snapshots);
  if (nativePredicate) {
    read = await readInitialObservation(deps.cli, resolved, clock, signal, deadline, params.condition, params.match, validation.regex, control, strictIdentity, initialNativeDeadline);
    snapshots = read.snapshots;
    const nativeTimeout = timeoutIfExpired(read);
    if (nativeTimeout) return nativeTimeout;
    if (aggregate(params, snapshots)) return conditionMetResult(snapshots);
  }
  let reviewer: WaitReviewer | undefined;
  if (longWait) {
    try {
      reviewer = deps.reviewerFactory ? deps.reviewerFactory(settings, context) : createPiModelReviewer(context, settings.reviewerModel);
    } catch (error) {
      throw mapReviewerFailure(error);
    }
  }
  const reviewerSummaries: ReviewerSummary[] = [];
  const sentLines = new Map<string, string[]>();
  let lastStates = snapshots.map((snapshot) => rawState(snapshot.metadata));
  const progress = (text: string) => update(text.slice(0, 500), progressDetails(params, label, snapshots, reviewerSummaries, contextRebinding));
  progress("waiting");

  while (true) {
    checkAbort(signal);
    if (aggregate(params, snapshots)) return conditionMetResult(snapshots, reviewerSummaries);
    const now = clock.now();
    if (expired(clock, deadline, snapshots)) return timedOutResult(snapshots, reviewerSummaries);
    const untilReview = longWait ? Math.max(0, nextReview - now) : Number.MAX_SAFE_INTEGER;
    control?.check();
    await clock.sleep(Math.min(deps.pollIntervalMs ?? 250, deadline - now, untilReview), signal);
    control?.check();
    checkAbort(signal);
    if (expired(clock, deadline, snapshots)) return timedOutResult(snapshots, reviewerSummaries);
    const nativePollDeadline = nativePredicate && longWait ? Math.min(deadline, nextReview) : deadline;
    read = await readInitialObservation(deps.cli, resolved, clock, signal, deadline, params.condition, params.match, validation.regex, control, strictIdentity, nativePollDeadline);
    snapshots = read.snapshots;
    const pollTimeout = timeoutIfExpired(read, reviewerSummaries);
    if (pollTimeout) return pollTimeout;
    const newStates = snapshots.map((snapshot) => rawState(snapshot.metadata));
    if (newStates.some((state, index) => state !== lastStates[index])) {
      progress(`state changed: ${newStates.join(", ")}`);
      lastStates = newStates;
    }
    if (aggregate(params, snapshots)) continue;
    if (!longWait || clock.now() < nextReview) continue;
    nextReview += cadenceMs;
    if (nativePredicate) {
      const reviewerRead = await readAndMatch(deps.cli, resolved, clock, signal, deadline, params.condition, validation.regex, control, strictIdentity);
      if (reviewerRead.expired) return timedOutResult(reviewerRead.snapshots, reviewerSummaries);
      // This composite refresh is reviewer context only. A native predicate can
      // be satisfied only by the occupant-pinned agent.wait route below.
      // Keep the reviewer read as historical evidence, but never let its
      // composite match replace the native predicate result.
      snapshots = reviewerRead.snapshots.map((snapshot) => ({ ...snapshot, matched: false }));
      lastStates = snapshots.map((snapshot) => rawState(snapshot.metadata));
    }
    const requests: ReviewerRequest[] = snapshots.map((snapshot) => {
      const previous = sentLines.get(snapshot.targetId) ?? [];
      const delta = deltaLines(previous, snapshot.recentUnwrappedLines);
      sentLines.set(snapshot.targetId, snapshot.recentUnwrappedLines.slice(-100));
      return { targetId: snapshot.targetId, metadata: compactMetadata(snapshot.metadata), transcriptDelta: delta.slice(-100) };
    });
    let reviews: ReviewerResult[];
    try {
      control?.check();
      reviews = await Promise.all(requests.map(async (request) => {
        const release = control?.beginActivity();
        try {
          const review = await reviewer!.review(request, signal);
          control?.check();
          return review;
        } finally {
          release?.();
        }
      }));
      checkAbort(signal);
    } catch (error) {
      if (signal.aborted || errorCode(error) === "ABORTED") abort();
      throw mapReviewerFailure(error);
    }
    let managerJudgment = false;
    for (const review of reviews) {
      const summary: ReviewerSummary = { target: resolved.find((item) => item.target.paneId === review.targetId)?.ref ?? review.targetId, targetId: review.targetId, classification: review.classification, summary: review.summary.slice(0, 500) };
      reviewerSummaries.push(summary);
      const terminal = review.classification === "stalled" || review.classification === "blocked" || review.classification === "risk" || review.classification === "unknown";
      managerJudgment ||= terminal;
      progress(`review ${review.targetId}: ${review.classification} ${review.summary}`);
    }
    if (managerJudgment) {
      if (expired(clock, deadline, snapshots)) return timedOutResult(snapshots, reviewerSummaries);
      const nativeReviewDeadline = nativePredicate ? Math.min(deadline, clock.now() + 1) : deadline;
      read = await readInitialObservation(deps.cli, resolved, clock, signal, deadline, params.condition, params.match, validation.regex, control, strictIdentity, nativeReviewDeadline);
      snapshots = read.snapshots;
      const refreshTimeout = timeoutIfExpired(read, reviewerSummaries);
      if (refreshTimeout) return refreshTimeout;
      if (aggregate(params, snapshots)) return conditionMetResult(snapshots, reviewerSummaries);
      return managerJudgmentResult(snapshots, reviewerSummaries);
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
