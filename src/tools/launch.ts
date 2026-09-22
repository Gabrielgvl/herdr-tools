import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync, type Stats } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import { writeIdentityProvenance } from "../agent-identity.js";
import type { PromptDispatchEvidence } from "../agent-prompt.js";
import { boundedEvidence, CliProtocolError, HERDR_AGENT_START_TIMEOUT_MS, type HerdrErrorEnvelope, type JsonEnvelope, type PiExec } from "../cli.js";
import type { CompatibilityPreflight } from "../health.js";
import { contextRebindingDetails, createContextResolver, type ContextResolutionDiagnostics, type ContextResolver } from "../context.js";
import type { DevinQueueFlush } from "../messages/devin-queue-flush.js";
import { withDeliveryFailureEvidence } from "../messages/failure.js";
import { createHandoffAllocator, readHandoffState, renderHandoffContract, RUN_ID_PATTERN, type HandoffAllocation, type HandoffAllocator, type HandoffState } from "../handoff.js";
import { assertDeliverySize, assertMessageText, utf8Bytes, ATTACHMENT_MAX_BYTES, MESSAGE_INLINE_MAX_BYTES, type MessageDelivery } from "../messages/limits.js";
import { boundAgentSessionStrings, classifyPromptObservation, compactPromptSubmission, parsePromptSubmission, parsePromptTargetIdentityFields, type AgentSessionIdentity, type PromptConsumption, type PromptIdentityError, type PromptObservation, type PromptObservationBaseline, type PromptSubmissionEvidence, type PromptTargetIdentity } from "../messages/prompt.js";
import { defaultAttachmentStore, type AttachmentStore, type PublishedAttachment, type RecipientGrant } from "../messages/store.js";
import { mintRecipientKey, type RecipientRegistry } from "../messages/recipients.js";
import type { AttachmentCapability } from "../profiles/capability.js";
import { resolveSender, type SenderIdentity } from "../provenance.js";
import type { CurrentContext, HerdrSnapshot } from "../targets.js";
import { parseSnapshotResult } from "../targets.js";
import { formatCall, renderResultComponent, textComponent } from "../tui.js";
import { LaunchTaskSchema, renderTask, type LaunchTask } from "../launch-schema.js";
import { renderTaskInstructions } from "../spec-baseline.js";
import { routeTask, runnerResourceSelection, type AvailabilityGate, type RouterBinding, type RoutingTask, type SpecDecision, type TaskModelDecision, type TaskRouterState } from "../router.js";
import { appendRouterDecision, routerStateDigest, type AppendRouterLogOptions, type SpecRouterLogEntry } from "../router-log.js";
import { TypeSafeSpecClient } from "../typesafe-spec.js";
import { defaultPromptSourceStore, type PromptSourceStore } from "../profiles/index.js";
import type { ProfileKind } from "../profiles/types.js";
import { modelSafeJson } from "../redaction.js";
import { boundedDiagnosticMessage } from "../telemetry.js";
import type { SupervisionForbiddenToolsPolicy, SupervisionWorkspaceRoot } from "../job-registry.js";
import type { SupervisionCoordinator, SupervisionReservation } from "../supervision/registry.js";
import type { ProvisionalSupervisedIdentity } from "../supervision/identity.js";
import { SupervisionBindError } from "../supervision/supervisor.js";
import { acquireLaunchGate, type LaunchGateLease } from "./launch-freeze.js";
import type { SelfCloseTracker } from "../supervision/self-close.js";
import { CATALOG_PATH, loadCatalog, type AvailabilitySubject, type Catalog, type RunnerEntry, type RunnerKind } from "../catalog.js";
import { createWorktreeManager, type WorktreeManager } from "../worktree.js";
import { compileCandidateContract, contractArgv, type CompiledContract, type ResolvedPoint, type ResourceSelection } from "../compile.js";
import { deriveWorkspaceState, maxTier, nextTier, POLICY_REVISION, type QualityTier, type WorkloadIntent, type WorkloadProfile, type WorkspaceState } from "../routing-policy.js";
import { availability as defaultAvailability, classifyLaunchFailure, recordLaunchFailure, type LaunchFailureSignal, type RecordLaunchFailureOptions } from "../availability.js";

export interface LaunchCli {
  runJson(argv: string[], signal: AbortSignal, preserveCompletedMutation?: boolean): Promise<JsonEnvelope>;
  prompt(target: string, text: string, signal: AbortSignal): Promise<JsonEnvelope>;
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
  promptSources?: PromptSourceStore;
  attachments?: AttachmentStore;
  /**
   * Tools-owned handoff allocation for the run. Every managed launch gets one
   * generated run directory; the caller cannot supply or select its path.
   */
  handoffs?: HandoffAllocator;
  recipients?: RecipientRegistry;
  clock?: LaunchClock;
  /** Test hosts may provide the same fail-closed gate with disposable paths. */
  launchGate?: () => Promise<LaunchGateLease>;
  /**
   * The host's shared Devin queue-flush coordinator. A Devin launch's initial
   * prompt write rides its short write section like every other participating
   * text write; holding it never makes a launch eligible for a flush.
   */
  queueFlush?: Pick<DevinQueueFlush, "writeSection">;
  /**
   * Required. Every successful launch creates supervision, so a host that
   * cannot supervise cannot launch. See ADR-019.
   */
  supervision: SupervisionCoordinator;
  /** The host's shared close ledger, forwarded to per-replica worktree managers. */
  selfClose?: SelfCloseTracker;
  /** Compatibility-only host field; the cutover never reads a profile catalog. */
  profiles?: unknown;
  /** B8's immutable catalog and spec evaluator seams. */
  catalog?: { load: () => Promise<Catalog> };
  specClient?: Pick<TypeSafeSpecClient, "evaluate">;
  availability?: AvailabilityGate;
  worktrees?: WorktreeManager;
  /** B2 failure recorder seam; production uses the durable cooldown log. */
  availabilityFailureRecorder?: (candidate: AvailabilitySubject, runner: RunnerEntry, failure: LaunchFailureSignal, options: RecordLaunchFailureOptions) => Promise<unknown>;
  /**
   * The one-shot decision-log append sink, run once per spec decision before
   * any child mutation. Defaults to the local JSONL record rooted at the
   * trusted host working directory — never the caller-controlled child `cwd`.
   */
  routerLog?: LaunchRouterLog;
}

/** The ADR-037 decision-log append seam; `appendRouterDecision` satisfies it. */
export type LaunchRouterLog = (entry: SpecRouterLogEntry, options: AppendRouterLogOptions) => Promise<void>;

export interface LaunchResourceIds {
  tabId?: string;
  paneId?: string;
  agentId?: string;
}

/**
 * One operating-point attempt in a child's start loop. `skipped_unavailable`
 * records the mandatory availability re-probe refusing the point without a
 * start dispatch; no Jev request is re-issued on that verdict.
 */
export interface LaunchAttemptEvidence {
  point: { index: number; id: string; runner: string; model: string };
  outcome: "selected" | "agent_start_failed" | "fallback_refused" | "skipped_unavailable";
  errorCode?: string;
  message?: string;
  postState?: Record<string, unknown>;
}

/**
 * The runtime-resolved-model evidence seam (N4 amendment): no post-start
 * readback carries a model field, so the record is a bounded unavailable fact
 * pinned to the catalog revision — never a fabricated concrete id.
 */
export type LaunchResolvedModel =
  | { available: true; model: string }
  | { available: false; reason: "no-readback-seam"; catalogRevision?: string };

export interface LaunchTaskEvidence {
  /** The caller's display-only label, when supplied. */
  label?: string;
  replicas: number;
  /** The caller's requested tier after defaulting; omission resolved to `standard`. */
  requestedTier?: QualityTier;
  workloadFloor?: QualityTier;
  effectiveStartTier?: QualityTier;
  effectiveCeiling?: QualityTier;
  quality: Exclude<AdmittedSpecDecision["quality"], "rejected">;
  /** The operating point that actually started this child — the exact point id. */
  selected: { index: number; id: string; runner: string; model: string };
  attempts: LaunchAttemptEvidence[];
  fallbackCandidates: Array<{ index: number; id: string; runner: string; model: string }>;
  resolvedModel: LaunchResolvedModel;
  /** The effective contract that produced the selected child's argv. */
  configuration: CompiledContract;
  /** The prior-run lineage this child was launched under; absent on fresh launches. */
  recovery?: {
    recoveryOf: string;
    workspaceState: WorkspaceState;
    priorRouteTier: QualityTier;
    priorOperatingPointId: string;
    priorPolicyRevision: string;
  };
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

/** The runtime-owned workload-tab fact recorded on a launched child (D12). */
export interface LaunchTopologyEvidence {
  /** The classified workload intent the tab grammar is keyed on. */
  intent: WorkloadIntent;
  tabId: string;
  tabLabel: string;
  /** True when an existing matching tab was reused rather than created. */
  reused: boolean;
  /** A reused tab's internal layout was not created by this launch and is never asserted. */
  layoutUnverified?: true;
}

export interface LaunchDetails extends LaunchResourceIds {
  operation: "launch";
  outcome: "launched" | "partial";
  launchId?: string;
  effectCertainty?: LaunchEffectCertainty;
  reconciliation?: LaunchReconciliationEvidence;
  contextRebinding?: ContextResolutionDiagnostics;
  /** The runtime-minted child identity — also the pane/agent target. */
  name?: string;
  kind?: string;
  topology?: LaunchTopologyEvidence;
  /** The provable replica worktree this child runs in, when replicas > 1. */
  worktree?: string;
  postState?: Record<string, unknown>;
  agentStarted?: boolean;
  initialPromptSent?: boolean;
  promptSubmitted?: boolean;
  recipientRegistered?: boolean;
  promptConsumption?: PromptConsumption;
  promptDispatch?: PromptDispatchEvidence;
  assignmentState?: "confirmed" | "unconfirmed";
  initialPromptDelivery?: MessageDelivery;
  initialPromptSubmission?: PromptSubmissionEvidence;
  initialPromptObservation?: PromptObservation;
  readiness?: LaunchReadinessEvidence;
  promptConfirmation?: PromptConfirmationEvidence;
  timing?: LaunchTimingEvidence;
  /** Advisory identity provenance tokens were written; `provenanceWarning` is set when that write failed. */
  identityProvenance?: "launched";
  provenanceWarning?: string;
  phase?: "validate" | "route" | "compile" | "handoff" | "attachment_publish" | "supervision_reserve" | "placement" | "agent_start" | "ready" | "prompt_verification" | "supervision_bind";
  supervision?:
    | { jobId: string; state: "active"; child: { agentName: string; agentKind: string; paneId: string; terminalId: string; operatingPointId: string } }
    | { jobId: string; state: "provisional"; provisional: { agentName: string; agentKind: "agy"; paneId: string; terminalId: string; operatingPointId: string; baseline: PromptObservationBaseline } };
  created?: LaunchResourceIds;
  causeCode?: string;
  sender?: { paneId: string; display: string; source: SenderIdentity["source"] };
  envelope?: { version: "v1"; kind: "assignment"; delivery: MessageDelivery };
  attachment?: PublishedAttachment;
  /** The generated Tools-owned run and its agent-writable artifact path. */
  handoff?: { runId: string; path: string };
  recipient?: { recipientKey: string; paneId: string; agentName: string; agentId?: string; operatingPointId: string; kind: ProfileKind; capable: boolean; reason: string };
  task?: LaunchTaskEvidence;
}

/**
 * The uniform launch result (ADR-037 D15): one Task in, one result out. A
 * launch that cannot start any child reports `failed`; an admitted decision
 * that started some but not all children reports `partial`.
 */
export interface LaunchResultChild {
  /** The runtime-minted child name — the pane/agent target. */
  target: string;
  state: "launched" | "failed" | "not_started";
  /** The exact operating-point id that started this child, when one did. */
  operatingPointId?: string;
  supervisorJobId?: string;
  worktree?: string;
  /**
   * Bounded, redacted failure fact — never cause prose. `causeCode`,
   * `paneId`, and `supervisorJobId` carry the recovery handles when the
   * child's work may already have been consumed (PROMPT_UNCONFIRMED), so the
   * caller inspects the live child instead of relaunching a duplicate.
   */
  error?: { code: string; message?: string; causeCode?: string; paneId?: string; supervisorJobId?: string };
}

export interface LaunchResult {
  kind: "launch";
  launchId: string;
  outcome: "launched" | "abstained" | "partial" | "failed";
  requestedTier: QualityTier;
  effectiveTier?: QualityTier;
  children: LaunchResultChild[];
  error?: { code: string; message?: string };
  /** Bounded routing abstention fact — the caller-facing reason the request did not launch. Full evidence lives in the decision log. */
  abstention?: { reason: string; component?: string; requestSize?: { questions: number; bytes: number } };
}

const LAUNCH_READINESS_POLL_INTERVAL_MS = 100;
const PROMPT_CONFIRMATION_TIMEOUT_MS = 5_000;
const PROMPT_CONFIRMATION_POLL_INTERVAL_MS = 100;
const AGENT_PANE_SHELL_SETTLE_MS = 10_000;
const AGENT_PANE_SHELL_POLL_MS = 150;
const LAUNCH_RECONCILIATION_TIMEOUT_MS = 5_000;
const SPEC_EVALUATION_TIMEOUT_MS = 20_000;
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
let defaultHandoffs: HandoffAllocator | undefined;

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
  return boundedDiagnosticMessage(LAUNCH_DIAGNOSTIC_SUMMARY, LAUNCH_DIAGNOSTIC_MARKER, payload, LAUNCH_DIAGNOSTIC_MAX_BYTES, minimal);
}

class LaunchError extends Error {
  readonly details: Record<string, unknown>;

  constructor(readonly code: string, message: string, details: Record<string, unknown> = {}, diagnostic?: Omit<LaunchModelDiagnostic, "code"> & { code?: string }) {
    super(diagnostic === undefined ? message : launchDiagnosticMessage({ ...diagnostic, code: diagnostic.code ?? code }));
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

function validateParams(params: unknown): asserts params is LaunchTask {
  if (!record(params) || !Value.Check(LaunchTaskSchema, params)) {
    throw new LaunchError("INVALID_INPUT", "launch parameters must be a valid task");
  }
  // The label is display-only metadata bounded at 256 UTF-8 bytes so it can
  // never push a bounded routing-evidence record over its cap.
  if (params.label !== undefined && Buffer.byteLength(params.label, "utf8") > 256) {
    throw new LaunchError("INVALID_INPUT", "label exceeds the 256-byte bound");
  }
  // ADR-037 recovery contract: exactly one replica and no caller cwd — the
  // runtime resumes the prior run's managed workspace itself.
  if (params.recoveryOf !== undefined && (params.cwd !== undefined || (params.replicas ?? 1) !== 1)) {
    throw new LaunchError("INVALID_INPUT", "a recovery launch forbids cwd and requires exactly one replica");
  }
}

/** The caller's Task with every schema default made concrete. */
interface NormalizedLaunchTask extends LaunchTask {
  constraints: string[];
  replicas: number;
  tier: QualityTier;
}

function normalizedParams(params: unknown): NormalizedLaunchTask {
  validateParams(params);
  return { ...params, constraints: params.constraints ?? [], replicas: params.replicas ?? 1, tier: params.tier ?? "standard" };
}

/**
 * Grammar-valid runtime child identity (D11): a launchId segment plus the
 * replica ordinal. Callers never name children; no `{name}-{label}-{N}`
 * derivation or collision reservation exists anymore.
 */
function mintChildName(launchId: string, ordinal: number): string {
  return `task-${launchId.slice(0, 8)}-${ordinal}`;
}

/**
 * Canonical working directory (D13): the caller's `cwd` (or the host root by
 * default) resolved through realpath before any effect. It must exist, be a
 * directory, and be readable/searchable; anything else fails closed.
 */
async function resolveLaunchCwd(rawCwd: string | undefined, root: string): Promise<string> {
  identifier(root, "cwd");
  const candidate = rawCwd === undefined ? root : isAbsolute(rawCwd) ? rawCwd : resolve(root, rawCwd);
  let resolved: string;
  let stats: Stats;
  try {
    resolved = await realpath(candidate);
    stats = await stat(resolved);
  } catch {
    throw new LaunchError("CWD_UNAVAILABLE", "Launch cwd is not an accessible directory");
  }
  if (!stats.isDirectory()) {
    throw new LaunchError("CWD_UNAVAILABLE", "Launch cwd is not an accessible directory");
  }
  try {
    await access(resolved, constants.R_OK | constants.X_OK);
  } catch {
    throw new LaunchError("CWD_UNAVAILABLE", "Launch cwd is not an accessible directory");
  }
  return resolved;
}

/**
 * Prior-run lineage resolved from the managed handoff record `recoveryOf`
 * names (ADR-037): the derived workspace state, the resumed managed workspace,
 * and the route evidence the recovery's routing policy consumes.
 */
interface RecoveryContext {
  runId: string;
  workspaceState: WorkspaceState;
  /** The prior run's managed workspace, re-canonicalized and proven accessible. */
  resumedWorkspace: string;
  /** The persisted worktree root when the prior child ran inside one. */
  resumedWorktree?: string;
  priorRouteTier: QualityTier;
  priorOperatingPointId: string;
  priorPolicyRevision: string;
  priorWorkload: WorkloadProfile;
}

/**
 * Resolve `recoveryOf` to verified prior-run lineage: the run id opens a
 * managed allocation inside this endpoint's namespace, the sidecar must be a
 * trusted v2 record carrying route and workspace evidence, and the recorded
 * workspace must still resolve to itself. Every gap fails closed — a recovery
 * never falls back to the caller or ambient cwd.
 */
async function resolveRecoveryOf(params: NormalizedLaunchTask, handoffs: HandoffAllocator, root: string): Promise<RecoveryContext> {
  const recoveryOf = params.recoveryOf;
  const unresolvable = (reason: string): LaunchError =>
    new LaunchError("RECOVERY_UNRESOLVABLE", "recoveryOf cannot be resolved by this runtime", { recoveryOf, reason });
  /* c8 ignore next 3 -- validateParams already enforces the recovery contract; the re-assertion keeps a validation bypass fail-closed. */
  if (recoveryOf === undefined || params.replicas !== 1 || params.cwd !== undefined) {
    throw new LaunchError("INVALID_INPUT", "a recovery launch forbids cwd and requires exactly one replica");
  }
  if (!RUN_ID_PATTERN.test(recoveryOf)) throw unresolvable("run_id_malformed");
  let allocation: HandoffAllocation;
  try {
    allocation = await handoffs.open(recoveryOf);
  } catch {
    throw unresolvable("run_unavailable");
  }
  let prior: HandoffState;
  try {
    prior = await readHandoffState(allocation);
  } catch {
    throw unresolvable("state_unreadable");
  }
  const route = prior.child.route;
  const workspace = prior.child.workspace;
  if (route === undefined || workspace === undefined) throw unresolvable("lineage_incomplete");
  // Reuse requires terminal evidence: the durable lifecycle record is what
  // proves the prior child can no longer write to the workspace being
  // resumed. awaiting_handoff — and a handed_off mark with no terminal
  // artifact — may still have a live writer; recovery rejects before any
  // effect rather than risk a second writer over partial state.
  const lifecycle = prior.lifecycle.state;
  const terminal =
    lifecycle === "failed" ||
    lifecycle === "cancelled" ||
    lifecycle === "recovery_pending" ||
    (lifecycle === "handed_off" && prior.artifact.status !== undefined);
  if (!terminal && (lifecycle === "awaiting_handoff" || lifecycle === "handed_off")) {
    throw unresolvable("lifecycle_non_terminal");
  }
  let workspaceState: WorkspaceState;
  try {
    workspaceState = deriveWorkspaceState({ lifecycle: prior.lifecycle.state, artifactStatus: prior.artifact.status });
  } catch {
    throw unresolvable("evidence_unresolvable");
  }
  const recorded = workspace.worktree ?? workspace.resolvedCwd;
  let resumedWorkspace: string;
  try {
    resumedWorkspace = await resolveLaunchCwd(recorded, root);
  } catch {
    throw unresolvable("workspace_unavailable");
  }
  // The recorded path was canonical when written; a path that now resolves
  // elsewhere is not the prior workspace.
  if (resumedWorkspace !== recorded) throw unresolvable("workspace_moved");
  return {
    runId: recoveryOf,
    workspaceState,
    resumedWorkspace,
    ...(workspace.worktree === undefined ? {} : { resumedWorktree: workspace.worktree }),
    priorRouteTier: route.tier,
    priorOperatingPointId: route.operatingPointId,
    priorPolicyRevision: route.policyRevision,
    priorWorkload: route.workload
  };
}

function paneRecord(value: unknown, expectedPaneId: string): Record<string, unknown> {
  if (!record(value)) throw new LaunchError("CLI_PROTOCOL_ERROR", "Herdr did not return a pane post-state");
  const pane = value.pane;
  if (!record(pane)) throw new LaunchError("CLI_PROTOCOL_ERROR", "Herdr did not return a pane post-state");
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
  return { startRecord: agent, agentId };
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
  const envelope = cliErrorEnvelope(error);
  const { exitCode, killed, errorStream, stderrTruncated } = error.details;
  if (error.code === "CLI_TIMEOUT" && killed === true) return { code: error.code, message: envelope?.error.message ?? error.message };
  if (error.code !== "CLI_PROTOCOL_ERROR" || exitCode !== 1 || killed !== false || errorStream !== "stderr" || stderrTruncated !== false) return undefined;
  if (!envelope || envelope.id !== "cli:agent:start") return undefined;
  const provenPreSpawn = envelope.error.code === "agent_start_failed" && envelope.error.message === "agent process exited before becoming interactive";
  const quotaFailure = classifyLaunchFailure({ code: error.code, causeCode: envelope.error.code }) === "quota";
  if (!provenPreSpawn && !quotaFailure) return undefined;
  return { ...envelope.error };
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

function waitForAgentStartSettle(signal: AbortSignal, intervalMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("caller aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, intervalMs);
    signal.addEventListener("abort", onAbort, { once: true });
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
          return { identity, agent: authoritativeAgent, pane: paneRecordResult.record.value, ...(baseline === undefined ? /* c8 ignore next -- the only caller always requires a baseline, so a ready result always carries one. */ {} : { baseline }), evidence };
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
  if (typeof response.id !== "string"
    || response.id.length === 0
    || /[\0\r\n]/u.test(response.id)
    || !record(response.result)
    || response.result.type !== "agent_prompted"
    || !record(response.result.agent)) {
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
            interactiveProof: "managed" as const,
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

/**
 * The runtime-minted name must not already resolve to a live pane/agent or
 * pane label — a collision means the identity grammar was violated, so the
 * launch fails closed rather than targeting an existing surface.
 */
function mintedNameTaken(snapshot: HerdrSnapshot, name: string): boolean {
  return snapshot.agents.some((agent) => agent.name === name)
    || snapshot.panes.some((pane) => pane.agent_name === name || pane.agent === name || pane.label === name);
}

/**
 * The workload-tab grammar (D12): `workload:<intent>` is the first tab of an
 * intent, `workload:<intent>:<n>` its numbered spillovers. Matching is exact —
 * a caller-labeled tab that only resembles the grammar is never reused.
 */
function workloadTabOrdinal(intent: string, label: string | undefined): number | undefined {
  if (label === `workload:${intent}`) return 1;
  const prefix = `workload:${intent}:`;
  if (label === undefined || !label.startsWith(prefix)) return undefined;
  const suffix = label.slice(prefix.length);
  return /^[0-9]+$/u.test(suffix) ? Number(suffix) : undefined;
}

const WORKLOAD_TAB_MAX_PANES = 4;

/**
 * The runtime topology decision for one child: reuse the lowest-ordinal tab of
 * this intent that still holds fewer than four panes (counting every pane in
 * the snapshot), else create the next label in the grammar — `workload:<intent>`
 * when no matching tab exists yet, `workload:<intent>:{n+1}` past the highest
 * existing ordinal.
 */
function selectWorkloadTab(snapshot: HerdrSnapshot, workspaceId: string, intent: WorkloadIntent): { reuse?: { tabId: string; tabLabel: string; anchorPaneId: string }; create?: { tabLabel: string } } {
  const matching = snapshot.tabs
    .filter((tab) => tab.workspace_id === workspaceId)
    .flatMap((tab) => {
      const ordinal = workloadTabOrdinal(intent, tab.label);
      return ordinal === undefined ? [] : [{ tab, ordinal, panes: snapshot.panes.filter((pane) => pane.tab_id === tab.tab_id) }];
    })
    .sort((left, right) => left.ordinal - right.ordinal);
  const reusable = matching.find((entry) => entry.panes.length > 0 && entry.panes.length < WORKLOAD_TAB_MAX_PANES);
  if (reusable !== undefined) return { reuse: { tabId: reusable.tab.tab_id, tabLabel: reusable.tab.label, anchorPaneId: reusable.panes.at(-1)!.pane_id } };
  const nextOrdinal = matching.length === 0 ? 1 : Math.max(...matching.map((entry) => entry.ordinal)) + 1;
  return { create: { tabLabel: nextOrdinal === 1 ? `workload:${intent}` : `workload:${intent}:${nextOrdinal}` } };
}

/**
 * The reservation's trusted workspace root (ADR-036 W0): the canonical launch
 * `cwd` resolved before effects. A missing or relative value degrades to a
 * typed gap — the reservation never falls back to this process's cwd.
 */
function supervisionWorkspaceRoot(launchCwd: string | undefined): SupervisionWorkspaceRoot {
  if (typeof launchCwd !== "string" || launchCwd.length === 0) return { available: false, reason: "root_unavailable" };
  return isAbsolute(launchCwd) ? { available: true, root: launchCwd } : { available: false, reason: "root_not_absolute" };
}

/**
 * Every compiled chain candidate's deny-list fact (ADR-036 W0). Only the
 * claude runtime has a `disallowedTools` argv surface; other runners record
 * the typed gap rather than a list inferred from prose. The tag is the exact
 * operating-point id the binding reports (ADR-037).
 */
function supervisionForbiddenTools(contracts: ReadonlyMap<string, CompiledContract>): SupervisionForbiddenToolsPolicy[] {
  return [...contracts.values()].map((contract) => ({
    agentKind: contract.runtime.kind,
    operatingPointId: contract.candidate.id,
    forbiddenTools: contract.runtime.kind === "claude"
      ? { available: true, tools: [...contract.runtime.disallowedTools] }
      : { available: false, reason: "runner_lacks_disallowed_tools" },
  }));
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
    if (sourceDetails.evidence === "omitted_for_prompt_delivery") details.evidence = sourceDetails.evidence;
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
  effects: { agentStarted: boolean; promptSubmitted: boolean; recipientRegistered: boolean; mutationDispatched: boolean; promptDispatch?: PromptDispatchEvidence; assignmentState?: "confirmed" | "unconfirmed"; initialPromptSubmission?: AgyPromptSubmissionEvidence; readiness?: LaunchReadinessEvidence; supervision?: NonNullable<LaunchDetails["supervision"]>; timing: LaunchTimingEvidence; attempts: LaunchAttemptEvidence[] },
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
        // PROMPT_UNCONFIRMED stays distinguishable: the work may already be
        // consumed, so a relaunch must never look like an ordinary failure.
        : error instanceof LaunchError && error.code === "PROMPT_UNCONFIRMED"
          ? "PROMPT_UNCONFIRMED"
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
    ...(effects.promptDispatch === undefined ? {} : { promptDispatch: effects.promptDispatch }),
    ...(effects.supervision === undefined ? {} : { paneId: supervisionPaneId, supervisorJobId: effects.supervision.jobId, supervision: effects.supervision }),
    effectCertainty,
    ...(Object.keys(effects.timing).length === 0 ? {} : { timing: effects.timing }),
    ...(effects.attempts.length === 0 ? {} : { attempts: effects.attempts }),
    ...(cliFailure ? { cliFailure } : {}),
    ...(delivery ? { delivery, initialPromptDelivery: delivery } : /* c8 ignore next -- partialError runs only after the delivery route is fixed at precondition time. */ {}),
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

function progress(onUpdate: AgentToolUpdateCallback<LaunchResult> | undefined, launchId: string, childTarget: string, phase: LaunchPhase, requestedTier: QualityTier): void {
  onUpdate?.({
    content: [{ type: "text", text: `Launch ${phase}` }],
    details: { kind: "launch", launchId, outcome: "partial", requestedTier, children: [{ target: childTarget, state: "not_started" }] }
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
  return cli.prompt(paneId, envelope, signal);
}

/**
 * The bounded, redacted failure fact one failed child retains in the result.
 * Only this module's own fixed prose may be published: a foreign cause can
 * quote a command line or credential, and the diagnostic blob belongs to the
 * thrown-error channel, not the uniform result. Recovery handles — the cause
 * code, the pane, and the retained supervisor job — are bounded identifiers
 * the caller needs to inspect a possibly-consumed child instead of relaunching.
 */
function launchChildError(error: unknown): LaunchResultChild["error"] {
  const message = error instanceof LaunchError
    ? safeDiagnosticString(error.message.split(`\n${LAUNCH_DIAGNOSTIC_MARKER}`)[0], 256)
    : undefined;
  const details = error instanceof LaunchError ? error.details : undefined;
  const causeCode = safeDiagnosticString(details?.causeCode, 64);
  const paneId = safeDiagnosticString(details?.paneId, 128);
  const supervisorJobId = safeDiagnosticString(details?.supervisorJobId, 128);
  return {
    code: safeLaunchCode(launchTransportCode(error)),
    ...(message === undefined ? {} : { message }),
    ...(causeCode === undefined ? {} : { causeCode }),
    ...(paneId === undefined ? {} : { paneId }),
    ...(supervisorJobId === undefined ? {} : { supervisorJobId })
  };
}

/**
 * The all-child manifest rendered ahead of verbose details. Every minted child
 * gets exactly one line, so a bounded response can never masquerade as a
 * smaller launch.
 */
function launchManifest(result: LaunchResult): string {
  const head = `herdr_launch outcome=${result.outcome} launch=${result.launchId} tier=${result.requestedTier}${result.effectiveTier === undefined ? "" : ` effective=${result.effectiveTier}`} children=${result.children.length}${result.error === undefined ? "" : ` error=${result.error.code}`}`;
  const lines = result.children.map((child) =>
    `- ${child.target} state=${child.state}${child.operatingPointId === undefined ? "" : ` point=${child.operatingPointId}`}${child.supervisorJobId === undefined ? "" : ` supervisor=${child.supervisorJobId}`}${child.worktree === undefined ? "" : ` worktree=${child.worktree}`}${child.error === undefined ? "" : ` error=${child.error.code}`}`
  );
  return [head, ...lines].join("\n");
}

type AdmittedSpecDecision = Extract<SpecDecision, { kind: "admitted" }>;

type TaskRouteRecord = {
  /** The canonical Task the decision and its evidence were produced from. */
  task: RoutingTask;
  decision: SpecDecision;
  response?: TaskModelDecision;
  state?: SpecRouterLogEntry["state"];
  binding?: RouterBinding;
  /** The catalog content digest the decision was routed against. */
  catalogRevision?: string;
  /** Recovery lineage for the decision log: the run being recovered. */
  recoveryOf?: string;
  /** Recovery lineage for the decision log: the failed prior operating point. */
  priorOperatingPointId?: string;
};

/** The attempt-evidence identity of one chain point: exact id included. */
function pointIdentity(point: { index: number; id: string; runner: string; model: string }): LaunchAttemptEvidence["point"] {
  return { index: point.index, id: point.id, runner: point.runner, model: point.model };
}

function resolvedPointIdentity(resolved: ResolvedPoint): LaunchAttemptEvidence["point"] {
  return { index: resolved.index, id: resolved.point.id, runner: resolved.point.runner, model: resolved.point.model };
}

/** A chain position keyed by point id — immutable for the whole decision. */
function resolvedPointKey(resolved: ResolvedPoint): string {
  return resolved.point.id;
}

function isAdmitted(decision: SpecDecision): decision is AdmittedSpecDecision {
  return decision.kind === "admitted";
}

function launchBinding(launchId: string, state: TaskRouterState): RouterBinding {
  return {
    caller: launchId,
    specRevision: routerStateDigest(state),
    policyRevision: POLICY_REVISION,
    launchIdentity: createHash("sha256").update(JSON.stringify({ launchId, task: state.task })).digest("hex")
  };
}

function allReviewedResources(resolved: ResolvedPoint): ResourceSelection {
  const pools = resolved.runner.pools;
  return resolved.runner.kind === "pi"
    ? { tools: pools.tools, extensions: pools.extensions, skills: pools.skills, mcp: pools.mcp }
    : resolved.runner.kind === "claude"
      ? { tools: pools.tools, plugins: pools.plugins, mcp: pools.mcp }
      : {};
}

function recipientCapability(kind: RunnerKind): AttachmentCapability & { kind: ProfileKind } {
  return { kind: kind as ProfileKind, capable: true, reason: "compiled task contract grants the launch runtime" };
}

/** The Task plus the ordered operating-point projection that the binding digest covers. */
function taskRouterState(task: RoutingTask, catalog: Catalog): TaskRouterState {
  return {
    task,
    points: (catalog.points ?? []).map((point) => ({
      id: point.id,
      runner: point.runner,
      model: point.model,
      ...(point.reasoning === undefined ? {} : { reasoning: point.reasoning }),
      provider: point.provider,
      timeout: catalog.runners.get(point.runner)?.defaults.timeoutMinutes ?? 0
    }))
  };
}

function taskRouteLogEntry(launchId: string, record: TaskRouteRecord): SpecRouterLogEntry {
  return {
    caller: launchId,
    result: record.decision,
    ...(record.binding === undefined ? {} : { binding: record.binding }),
    ...(record.catalogRevision === undefined ? {} : { catalogRevision: record.catalogRevision }),
    ...(record.recoveryOf === undefined ? {} : { recoveryOf: record.recoveryOf, priorOperatingPointId: record.priorOperatingPointId }),
    ...(record.decision.evidence === undefined ? {} : { evidence: record.decision.evidence }),
    ...(record.response === undefined ? {} : { probabilities: record.response }),
    ...(record.state === undefined ? {} : { state: record.state })
  };
}

export function createLaunchTool<T extends LaunchDependencies>(deps: T): ToolDefinition<typeof LaunchTaskSchema, LaunchResult> {
  const contextResolver = deps.contextResolver ?? createContextResolver(deps.cli, deps.context);
  const specClient = deps.specClient ?? new TypeSafeSpecClient();
  const worktrees = deps.worktrees ?? (() => {
    const exec = (deps.cli as unknown as { exec?: PiExec }).exec;
    return exec === undefined ? undefined : createWorktreeManager({ exec, ...(deps.selfClose === undefined ? {} : { selfClose: deps.selfClose }) });
  })();
  const availabilityGate = deps.availability ?? defaultAvailability;

  let packageRoot = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(packageRoot, "package.json"))) packageRoot = dirname(packageRoot);
  const loadLaunchCatalog = async (): Promise<Catalog> => {
    if (deps.catalog !== undefined) return deps.catalog.load();
    return loadCatalog(join(packageRoot, CATALOG_PATH));
  };

  /**
   * One Task, one routing decision (ADR-037): the runtime minted `launchId`
   * binds the evaluation, and the emitted decision's generated chain is the
   * only fallback order the execution loop may consume.
   */
  const routeTaskOnce = async (params: NormalizedLaunchTask, task: RoutingTask, launchId: string, signal: AbortSignal, ctx: ExtensionContext, recovery?: RecoveryContext): Promise<{ catalog?: Catalog; record: TaskRouteRecord }> => {
    const root = deps.cwd ?? ctx.cwd;
    let catalog: Catalog;
    try {
      catalog = await loadLaunchCatalog();
    } catch {
      return {
        record: { task, decision: { kind: "abstained", reason: "catalog_unavailable", component: "catalog" }, state: { status: "unavailable", reason: "catalog_unavailable" } }
      };
    }

    // A recovery's start preference lifts one tier over the prior route (max
    // stays max); the model request still sees the caller's raw Task and tier.
    const routingTask: RoutingTask = recovery === undefined ? task : { ...task, tier: maxTier(params.tier, nextTier(recovery.priorRouteTier)) };
    const state = taskRouterState(routingTask, catalog);
    const binding = launchBinding(launchId, state);
    // The compiled contract label is runtime-owned; the caller's label is
    // display metadata that never enters routing contracts or evidence.
    const spec = { label: "task", count: params.replicas };
    const workspaceState = recovery?.workspaceState;
    let evaluation: Awaited<ReturnType<TypeSafeSpecClient["evaluate"]>>;
    const timeoutController = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      evaluation = await Promise.race([
        specClient.evaluate({ task, catalog, ...(workspaceState === undefined ? {} : { workspaceState }) }, AbortSignal.any([signal, timeoutController.signal])),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            const reason = new DOMException("Task evaluation timed out", "TimeoutError");
            timeoutController.abort(reason);
            reject(reason);
          }, SPEC_EVALUATION_TIMEOUT_MS);
        }),
      ]);
    } catch {
      evaluation = timeoutController.signal.aborted && !signal.aborted
        ? { kind: "abstained", reason: "transport_failed", component: "evaluation" }
        : { kind: "abstained", reason: signal.aborted ? "aborted" : "transport_failed", component: "transport" };
    } finally {
      clearTimeout(timeout);
    }
    let decision: SpecDecision;
    let response: TaskModelDecision | undefined;
    if (evaluation.kind === "response") {
      response = evaluation.response;
      try {
        decision = await routeTask({ task: routingTask, spec, catalog, response: evaluation.response, root, availability: availabilityGate, ...(workspaceState === undefined ? {} : { workspaceState }), ...(recovery === undefined ? {} : { recovery: { priorOperatingPointId: recovery.priorOperatingPointId } }) });
      } catch {
        decision = { kind: "abstained", reason: "invalid_response", component: "routing" };
      }
    } else {
      decision = evaluation;
    }
    return {
      catalog,
      record: {
        task: routingTask,
        decision,
        ...(response === undefined ? {} : { response }),
        state,
        binding,
        ...(catalog.catalogRevision === undefined ? {} : { catalogRevision: catalog.catalogRevision }),
        ...(recovery === undefined ? {} : { recoveryOf: recovery.runId, priorOperatingPointId: recovery.priorOperatingPointId })
      }
    };
  };

  /**
   * Everything the sibling children of one launch share: the admitted decision,
   * the resolved catalog, the canonical working directory, the classified
   * workload intent, and the minted launch identity.
   */
  interface LaunchShared {
    launchId: string;
    catalog: Catalog;
    resolvedCwd: string;
    intent: WorkloadIntent;
    replicas: number;
    specLabel: string;
    /** Prior-run lineage when this launch is a recovery (ADR-037). */
    recovery?: RecoveryContext;
  }

  const executeChild = async (
    params: NormalizedLaunchTask,
    routed: TaskRouteRecord & { decision: AdmittedSpecDecision },
    shared: LaunchShared,
    childName: string,
    signal: AbortSignal,
    onUpdate: AgentToolUpdateCallback<LaunchResult> | undefined,
    ctx: ExtensionContext
  ): Promise<LaunchDetails> => {
    const abortSignal = signal;
    let launchGate: LaunchGateLease | undefined;
    try {
      launchGate = await (deps.launchGate ?? (() => acquireLaunchGate()))();
      await launchGate.check();
    } catch {
      await launchGate?.release().catch(() => undefined);
      throw new LaunchError("LAUNCH_FROZEN", "Launch is frozen");
    }

    const attachmentStore = deps.attachments ?? defaultAttachmentStore;
    const handoffs = deps.handoffs ?? (defaultHandoffs ??= createHandoffAllocator({}));
    const clock = deps.clock ?? realLaunchClock;
    const decision = routed.decision;
    const task = routed.task;
    let assignmentText = renderTask(task);
    let promptText: string | undefined;
    let launchCwd: string | undefined;
    let topology: LaunchTopologyEvidence | undefined;
    let recipientKey: string | undefined;
    let grant: RecipientGrant | undefined;
    let published: PublishedAttachment | undefined;
    let sender: SenderIdentity | undefined;
    let contextDiagnostics: ContextResolutionDiagnostics | undefined;
    let effectiveContext: CurrentContext | undefined;
    let topologyBaseline: HerdrSnapshot | undefined;
    let topologyMutationDispatched = false;
    let reservation: SupervisionReservation | undefined;
    let handoffRun: HandoffAllocation | undefined;
    let phase: LaunchPhase = "validate";
    let prepared: Awaited<ReturnType<WorktreeManager["prepare"]>> | undefined;
    let worktreeBound = false;
    let chainCandidates: ResolvedPoint[] = [];
    const created: LaunchResourceIds = {};
    const attempts: LaunchAttemptEvidence[] = [];
    const contracts = new Map<string, CompiledContract>();
    const dispatchMutation = async <T>(operation: () => Promise<T>): Promise<T> => {
      if (abortSignal.aborted) throw new LaunchError("ABORTED", "Operation aborted");
      topologyMutationDispatched = true;
      return operation();
    };
    const tick = (next: LaunchPhase): void => progress(onUpdate, shared.launchId, childName, next, params.tier);

    // The delivery the runtime selected for this child's rendered payload.
    let delivery: MessageDelivery | undefined;
    try {
      phase = "compile";
      const catalog = shared.catalog;
      const pointById = new Map(catalog.points!.map((point) => [point.id, point]));
      // The attempt loop may only consume the decision's generated chain.
      const chain = decision.chain.map((id, index): ResolvedPoint => {
        const point = pointById.get(id)!;
        return { index, point, runner: catalog.runners.get(point.runner)! };
      });
      const selectedIndex = decision.selectedPoint.index;
      const availability = new Map(decision.evidence.availability?.map((entry) => [entry.id, entry.status]));
      // The router already excluded the failed prior point and ranked a
      // different provider first on recovery routes — the emitted chain is
      // the recovery order, so the attempt loop consumes it verbatim.
      chainCandidates = chain.filter((candidate) => {
        /* c8 ignore next -- admitted decisions place the selected point at chain head; the guard refuses a foreign decision whose head moved. */
        if (candidate.index < selectedIndex) return false;
        const status = availability.get(candidate.point.id);
        return candidate.index === selectedIndex || (status !== "known-exhausted" && status !== "local-capacity-limited");
      });

      const contractFor = async (resolved: ResolvedPoint): Promise<CompiledContract> => {
        const key = resolvedPointKey(resolved);
        const selected = decision.configuration;
        if (selected.candidate.id === resolved.point.id) {
          contracts.set(key, selected);
          return selected;
        }
        /* c8 ignore next -- admitted decisions always carry the evaluation response; the fallback exists so a foreign record cannot crash compile. */
        const selection = routed.response === undefined
          ? allReviewedResources(resolved)
          : runnerResourceSelection(routed.response, resolved.point.runner, resolved.runner);
        const compiled = await compileCandidateContract(catalog, { label: shared.specLabel }, resolved, selection);
        contracts.set(key, compiled);
        return compiled;
      };

      // Compile and prepare before handoff, topology, or agent start. A typed
      // pre-spawn refusal records exactly one candidate and moves to the next.
      let replicaPrepared = shared.replicas <= 1;
      for (const candidate of chainCandidates) {
        const identity = resolvedPointIdentity(candidate);
        let contract: CompiledContract;
        try {
          contract = await contractFor(candidate);
        } catch (error) {
          attempts.push({ point: identity, outcome: "agent_start_failed", errorCode: launchTransportCode(error), message: causeMessage(error) });
          continue;
        }
        if (!replicaPrepared) {
          try {
            prepared = await worktrees!.prepare({ childName, cwd: shared.resolvedCwd, count: shared.replicas, signal: abortSignal });
            replicaPrepared = true;
          } catch (error) {
            contracts.delete(resolvedPointKey(candidate));
            attempts.push({ point: identity, outcome: "agent_start_failed", errorCode: launchTransportCode(error), message: causeMessage(error) });
            continue;
          }
        }
        contracts.set(resolvedPointKey(candidate), contract);
        launchCwd = prepared?.cwd ?? shared.resolvedCwd;
      }
      const initialCandidate = chainCandidates.find((candidate) => contracts.has(resolvedPointKey(candidate)));
      const initialContract = initialCandidate === undefined ? undefined : contracts.get(resolvedPointKey(initialCandidate));
      if (initialCandidate === undefined || initialContract === undefined) {
        throw new LaunchError("SPEC_NO_USABLE_CANDIDATE", "No task chain candidate could be prepared", { attempts });
      }
      const initialRuntime = initialContract.runtime;

      const effective = await contextResolver(abortSignal);
      contextDiagnostics = effective.diagnostics;
      const snapshot = effective.snapshot;
      topologyBaseline = snapshot;
      effectiveContext = effective.context;
      sender = resolveSender(snapshot, effective.context.paneId);
      if (mintedNameTaken(snapshot, childName)) {
        throw new LaunchError("TARGET_IDENTITY_UNAVAILABLE", "Minted child identity collides with an existing pane or agent", { childName });
      }

      handoffRun = await handoffs.allocate();
      assignmentText += renderHandoffContract(handoffRun);
      assertMessageText(assignmentText);
      // Delivery is runtime-owned (D14): the rendered Task plus contract is
      // measured once; inline up to 16 KiB, attachment to 1 MiB, else reject.
      delivery = utf8Bytes(assignmentText) <= MESSAGE_INLINE_MAX_BYTES ? "inline" : "attachment";
      assertDeliverySize(assignmentText, delivery);
      if (delivery === "inline") {
        promptText = renderTaskInstructions(sender, assignmentText, "inline");
        assertMessageText(promptText);
      }

      phase = "handoff";
      tick(phase);
      // The run's route and managed workspace are the lineage a later
      // recovery resolves against this record.
      const recordWorktree = prepared?.worktreePath ?? shared.recovery?.resumedWorktree;
      await handoffs.persist(handoffRun, {
        manager: { paneId: sender.paneId, display: sender.display, source: sender.source },
        child: {
          agentName: childName,
          agentKind: initialRuntime.kind,
          operatingPointId: initialContract.candidate.id,
          specLabel: shared.specLabel,
          fallbackCandidates: chainCandidates.slice(1).map((candidate) => candidate.point.id),
          route: {
            tier: decision.effectiveStartTier!,
            operatingPointId: initialContract.candidate.id,
            policyRevision: POLICY_REVISION,
            workload: decision.evidence.workload!
          },
          workspace: {
            resolvedCwd: launchCwd!,
            ...(recordWorktree === undefined ? {} : { worktree: recordWorktree })
          }
        }
      });
      recipientKey = mintRecipientKey();
      grant = await attachmentStore.ensureRecipient(recipientKey);
      if (delivery === "attachment") {
        phase = "attachment_publish";
        tick(phase);
        published = await attachmentStore.publish({
          body: assignmentText,
          recipientKey,
          recipientAgentName: childName,
          senderPaneId: sender.paneId,
          senderDisplay: sender.display,
          operation: "assignment"
        });
        promptText = renderTaskInstructions(sender, assignmentText, "attachment", { ...published, encoding: "utf-8" });
        assertMessageText(promptText);
      }

      // Keep this reservation allowlist and serialization unchanged from R3,
      // now built from the canonical Task rather than a caller digest.
      phase = "supervision_reserve";
      tick(phase);
      try {
        const supervisionDigest = modelSafeJson({
          doneWhen: task.doneWhen,
          constraints: task.constraints
        }) as { doneWhen: string[]; constraints: string[] };
        reservation = await deps.supervision.reserve({
          child: { agentName: childName, agentKind: initialRuntime.kind, operatingPointId: initialContract.candidate.id },
          settings: {
            supervisionDigest,
            forbiddenTools: supervisionForbiddenTools(contracts),
            workspaceRoot: supervisionWorkspaceRoot(launchCwd)
          }
        });
      } catch (error) {
        throw new LaunchError("SUPERVISION_UNAVAILABLE", "Automatic child supervision could not be reserved", {
          causeCode: safeDiagnosticString(record(error) && typeof error.code === "string" ? error.code : undefined, 120) ?? "SUPERVISION_UNAVAILABLE"
        });
      }
    } catch (error) {
      const failure = withDeliveryFailureEvidence(error, { delivery, phase, published, handoffRunId: handoffRun?.runId });
      try {
        await grant?.release();
        reservation?.release("launch_precondition_failed");
        if (prepared !== undefined && !worktreeBound) await worktrees?.release(childName);
      } finally {
        await launchGate?.release();
      }
      throw earlyLaunchFailure(failure, phase);
    }

    let paneId: string | undefined;
    let tabId: string | undefined;
    let agentStarted = false;
    let promptSubmitted = false;
    let promptDispatch: PromptDispatchEvidence | undefined;
    let assignmentState: "confirmed" | "unconfirmed" | undefined;
    let agyAcknowledgement: AgyPromptAcknowledgement | undefined;
    let agyInitialPromptSubmission: AgyPromptSubmissionEvidence | undefined;
    let recipientRegistered = false;
    let supervisionBound = false;
    let provenanceWarning: string | undefined;
    let boundSupervision: LaunchDetails["supervision"] | undefined;
    let readiness: LaunchReadinessEvidence | undefined;
    let selectedAttemptStartedAt: number | undefined;
    let chosenContract: CompiledContract | undefined;
    const timing: LaunchTimingEvidence = {};

    try {
      // Runtime-owned workload-tab topology (D12): classify first, then reuse a
      // matching tab under the pane cap or create the next grammar label. Panes
      // are created by right-split only; existing panes are never closed,
      // replaced, or moved.
      phase = "placement";
      tick(phase);
      const workspaceId = effectiveContext!.workspaceId;
      if (typeof workspaceId !== "string" || workspaceId.length === 0) {
        throw new LaunchError("WORKSPACE_UNAVAILABLE", "Caller workspace is unavailable for workload topology");
      }
      const tabChoice = selectWorkloadTab(topologyBaseline!, workspaceId, shared.intent);
      if (tabChoice.reuse !== undefined) {
        const reuse = tabChoice.reuse;
        const result = paneRefFrom(await dispatchMutation(() => run(deps.cli, ["pane", "split", reuse.anchorPaneId, "--direction", "right", ...noFocusArgs(), "--cwd", launchCwd!], abortSignal, true)));
        paneId = result.paneId;
        tabId = result.tabId ?? reuse.tabId;
        created.paneId = paneId;
        created.tabId = tabId;
        deps.ownership?.record({ kind: "pane", id: paneId!, parentId: tabId });
        topology = { intent: shared.intent, tabId: tabId!, tabLabel: reuse.tabLabel, reused: true, layoutUnverified: true };
      } else {
        const tabLabel = tabChoice.create!.tabLabel;
        const result = tabRefFrom(await dispatchMutation(() => run(deps.cli, ["tab", "create", "--workspace", workspaceId, "--cwd", launchCwd!, "--label", tabLabel, ...noFocusArgs()], abortSignal, true)));
        tabId = result.tabId;
        paneId = result.paneId;
        created.tabId = tabId;
        deps.ownership?.record({ kind: "tab", id: tabId, parentId: workspaceId });
        if (!paneId) paneId = paneRefFrom(await run(deps.cli, ["tab", "get", tabId], abortSignal)).paneId;
        created.paneId = paneId;
        deps.ownership?.record({ kind: "pane", id: paneId!, parentId: tabId });
        topology = { intent: shared.intent, tabId: tabId!, tabLabel, reused: false };
      }
      const resolvedPaneId = paneId!;
      if (prepared !== undefined && shared.replicas > 1) {
        worktrees!.bindPane(childName, resolvedPaneId);
        worktreeBound = true;
      }
      // Pane identity stays runtime-minted: the caller's label is
      // display-only metadata and never renames the pane.
      await dispatchMutation(() => run(deps.cli, ["pane", "rename", resolvedPaneId, childName], abortSignal));

      phase = "agent_start";
      tick(phase);
      // The pre-mutation compile loop retained each usable contract for the
      // attempt machinery; no candidate is rebuilt or duplicated here.
      const attemptCandidates = [...contracts.keys()];
      let started: unknown;
      let startedAgent: StartedAgent | undefined;
      for (const candidate of attemptCandidates) {
        const contract = contracts.get(candidate)!;
        const attemptIdentity = pointIdentity(contract.candidate);
        await launchGate!.check();
        // Availability is re-probed immediately before every start attempt
        // across the whole fallback loop (ADR-037): a changed status skips the
        // point without another Jev request, and a probe that cannot answer
        // fails closed the same way.
        const resolved = chainCandidates.find((entry) => entry.point.id === candidate)!;
        try {
          const probe = await availabilityGate({ runner: contract.candidate.runner, model: contract.candidate.model }, resolved.runner, { root: deps.cwd ?? ctx.cwd });
          if (probe.status === "known-exhausted" || probe.status === "local-capacity-limited") {
            attempts.push({ point: attemptIdentity, outcome: "skipped_unavailable", errorCode: "CANDIDATE_UNAVAILABLE", message: `availability re-probe: ${probe.status}` });
            continue;
          }
        } catch {
          attempts.push({ point: attemptIdentity, outcome: "skipped_unavailable", errorCode: "AVAILABILITY_UNAVAILABLE", message: "availability re-probe failed closed" });
          continue;
        }
        let promptPath: string | undefined;
        let startArgs: string[];
        try {
          if (contract.runtime.kind !== "agy" && contract.runtime.kind !== "devin") {
            promptPath = (await (deps.promptSources ?? defaultPromptSourceStore).create(promptText!)).path;
          }
          startArgs = ["agent", "start", childName, "--kind", contract.runtime.kind, "--pane", resolvedPaneId, "--timeout", String(HERDR_AGENT_START_TIMEOUT_MS), "--", ...contractArgv(contract, promptPath, grant!.path, handoffRun!.directory)];
        } catch (error) {
          attempts.push({ point: attemptIdentity, outcome: "agent_start_failed", errorCode: launchTransportCode(error), message: causeMessage(error) });
          continue;
        }
        const attemptStartedAt = clock.now();
        try {
          const shellSettleDeadline = attemptStartedAt + AGENT_PANE_SHELL_SETTLE_MS;
          while (true) {
            try {
              started = await dispatchMutation(() => run(deps.cli, startArgs, abortSignal, true));
              break;
            } catch (startError) {
              const envelope = cliErrorEnvelope(startError);
              const shellPending = envelope?.id === "cli:agent:start" && envelope.error.code === "agent_pane_busy";
              if (!shellPending || clock.now() >= shellSettleDeadline || abortSignal.aborted) throw startError;
              await waitForAgentStartSettle(abortSignal, AGENT_PANE_SHELL_POLL_MS);
            }
          }
          agentStarted = true;
          attempts.push({ point: attemptIdentity, outcome: "selected" });
          selectedAttemptStartedAt = attemptStartedAt;
          chosenContract = contract;
          startedAgent = agentIdentity(started, childName, resolvedPaneId, contract.runtime.kind);
          break;
        } catch (error) {
          const envelope = cliErrorEnvelope(error);
          await (deps.availabilityFailureRecorder ?? recordLaunchFailure)(contract.candidate, resolved.runner, {
            code: launchTransportCode(error),
            ...(envelope === undefined ? {} : { causeCode: envelope.error.code })
          }, { root: deps.cwd ?? ctx.cwd });
          const eligible = startFailureEvidence(error);
          if (!eligible) {
            attempts.push({ point: attemptIdentity, outcome: "agent_start_failed", errorCode: launchTransportCode(error), message: causeMessage(error) });
            throw error;
          }
          let failedPane: Record<string, unknown>;
          try {
            failedPane = paneRecord(await run(deps.cli, ["pane", "get", resolvedPaneId], abortSignal), resolvedPaneId);
          } catch (readError) {
            throw new LaunchError("POSTSTATE_UNAVAILABLE", "Fallback eligibility could not be proven from authoritative pane state", { causeCode: "POSTSTATE_UNAVAILABLE", startFailureCode: eligible.code, readError: readError instanceof Error ? readError.message : String(readError), attempts });
          }
          if (!noAgentFromPane(failedPane)) {
            attempts.push({ point: attemptIdentity, outcome: "fallback_refused", errorCode: eligible.code, message: "authoritative pane still reports an agent", postState: compactAttemptState(failedPane) });
            throw new LaunchError("LAUNCH_FAILED", "Automatic fallback refused because the failed pane still has an agent", { causeCode: eligible.code, attempts });
          }
          attempts.push({ point: attemptIdentity, outcome: "agent_start_failed", errorCode: eligible.code, message: eligible.message, postState: compactAttemptState(failedPane) });
        }
      }
      if (chosenContract === undefined || startedAgent === undefined || selectedAttemptStartedAt === undefined) {
        throw new LaunchError("LAUNCH_FAILED", "Task fallback chain exhausted after agent start failure", { attempts });
      }
      const chosenRuntime = chosenContract.runtime;
      // The N4 amendment's runtime-resolved-model record is committed to the
      // durable run state alongside the started point, then mirrored into the
      // launch evidence below. No post-start readback carries a model field,
      // so the degraded fact is recorded — never a fabricated id.
      const resolvedModel: LaunchResolvedModel = { available: false, reason: "no-readback-seam", ...(shared.catalog.catalogRevision === undefined ? {} : { catalogRevision: shared.catalog.catalogRevision }) };
      await handoffs.selectCandidate(handoffRun!, chosenContract.candidate.id, chosenRuntime.kind, resolvedModel);
      const chosenAgent = startedAgent;
      let agentId = chosenAgent.agentId;
      if (agentId) created.agentId = agentId;
      phase = "ready";
      tick(phase);
      await grant?.renew();
      const ready = await waitForLaunchReadiness(deps.cli, resolvedPaneId, abortSignal, childName, chosenRuntime.kind, chosenAgent, selectedAttemptStartedAt, true, clock, chosenRuntime.kind === "agy");
      readiness = ready.evidence;
      timing.selectedStartReadinessMs = readiness.elapsedMs;
      let capturedIdentity = ready.identity;
      agentId ??= idFrom(ready.agent, "agent_id") ?? idFrom(ready.agent, "id") ?? idFrom(ready.pane, "agent_id");

      phase = "supervision_bind";
      tick(phase);
      try {
        if (chosenRuntime.kind === "agy") {
          const provisionalIdentity = capturedIdentity as ProvisionalSupervisedIdentity;
          const provisionalBaseline = { ...ready.baseline!, state: "idle" as const };
          await reservation!.bindProvisional({ identity: provisionalIdentity, operatingPointId: chosenContract.candidate.id, baseline: provisionalBaseline });
          boundSupervision = { jobId: reservation!.jobId, state: "provisional", provisional: { ...provisionalIdentity, operatingPointId: chosenContract.candidate.id, baseline: provisionalBaseline } };
        } else {
          const exactIdentity = capturedIdentity as PromptTargetIdentity;
          await reservation!.bind({ identity: exactIdentity, operatingPointId: chosenContract.candidate.id, stateChangeSeq: ready.baseline!.stateChangeSeq, handoff: { allocation: handoffRun!, ...(agentId ? { agentId } : {}) } });
          boundSupervision = { jobId: reservation!.jobId, state: "active", child: { agentName: exactIdentity.agentName, agentKind: exactIdentity.agentKind, paneId: resolvedPaneId, terminalId: exactIdentity.terminalId, operatingPointId: chosenContract.candidate.id } };
        }
      } catch (error) {
        if (!(error instanceof SupervisionBindError)) throw error;
        throw new LaunchError("SUPERVISION_UNCONFIRMED", "Automatic child supervision could not be bound to the launched agent", { causeCode: "SUPERVISION_UNCONFIRMED", supervisionJobId: reservation!.jobId, supervisionEvidence: boundAgentSessionStrings(error.details) });
      }
      supervisionBound = true;
      if (chosenRuntime.kind !== "agy") {
        provenanceWarning = await writeIdentityProvenance(deps.cli, resolvedPaneId, "launched", sender?.paneId, (capturedIdentity as PromptTargetIdentity).agentSession, abortSignal);
      }
      if (agentId) created.agentId = agentId;

      let initialPromptSubmission: PromptSubmissionEvidence | undefined;
      let initialPromptObservation: PromptObservation | undefined;
      let promptConfirmation: PromptConfirmationEvidence | undefined;
      let postState: Record<string, unknown> | undefined = ready.pane;
      assignmentState = "unconfirmed";
      const baseline = ready.baseline!;
      const envelope = promptText!;
      phase = "prompt_verification";
      tick(phase);
      const promptSubmissionStartedAt = clock.now();
      try {
        let promptResponse: JsonEnvelope;
        try {
          promptResponse = await dispatchMutation(async () => {
            if (capturedIdentity.agentKind !== "devin" || deps.queueFlush === undefined) return runPrompt(deps.cli, resolvedPaneId, envelope, abortSignal);
            const lease = await deps.queueFlush.writeSection(resolvedPaneId);
            try { return await runPrompt(deps.cli, resolvedPaneId, envelope, abortSignal); } finally { await lease.release(); }
          });
        } catch (error) {
          const details = record(error) && record(error.details) ? error.details : undefined;
          const dispatch = details?.promptDispatch;
          if (record(dispatch) && (dispatch.state === "not_written" || dispatch.state === "rejected" || dispatch.state === "acknowledged" || dispatch.state === "unknown")) {
            const requestId = dispatch.requestId;
            promptDispatch = { state: dispatch.state, ...(typeof requestId === "string" && requestId.length > 0 && requestId.length <= 256 && !/[\0\r\n]/u.test(requestId) ? { requestId } : {}) };
          }
          throw error;
        }
        try {
          if (chosenRuntime.kind === "agy") {
            agyAcknowledgement = parseAgyPromptAcknowledgement(promptResponse, capturedIdentity as ProvisionalSupervisedIdentity);
            agyInitialPromptSubmission = agyPromptSubmissionEvidence(agyAcknowledgement);
          } else {
            initialPromptSubmission = parsePromptSubmission(promptResponse, capturedIdentity as PromptTargetIdentity);
          }
        } catch (error) {
          promptDispatch = { state: "unknown", requestId: promptResponse.id };
          throw error;
        }
        promptSubmitted = true;
        promptDispatch = { state: "acknowledged", requestId: promptResponse.id };
      } finally {
        timing.promptSubmissionAckMs = monotonicDurationMs(clock, promptSubmissionStartedAt);
      }

      const confirmationStartedAt = clock.now();
      try {
        if (chosenRuntime.kind === "agy") {
          const confirmed = await confirmAgyNativeSession(deps.cli, abortSignal, agyAcknowledgement!, baseline, clock, confirmationStartedAt);
          initialPromptSubmission = confirmed.submission;
          initialPromptObservation = confirmed.observation;
          promptConfirmation = confirmed.confirmation;
          timing.postAckConfirmationMs = confirmed.confirmation.elapsedMs;
          postState = confirmed.pane;
          capturedIdentity = confirmed.identity;
          agentId ??= idFrom(confirmed.agent, "agent_id") ?? idFrom(confirmed.agent, "id") ?? idFrom(confirmed.pane, "agent_id");
          phase = "supervision_bind";
          tick(phase);
          await reservation!.strengthen({ identity: confirmed.identity, operatingPointId: chosenContract.candidate.id, stateChangeSeq: confirmed.observation.stateChangeSeq, handoff: { allocation: handoffRun!, ...(agentId ? { agentId } : {}) } });
          boundSupervision = { jobId: reservation!.jobId, state: "active", child: { agentName: confirmed.identity.agentName, agentKind: confirmed.identity.agentKind, paneId: resolvedPaneId, terminalId: confirmed.identity.terminalId, operatingPointId: chosenContract.candidate.id } };
          provenanceWarning = await writeIdentityProvenance(deps.cli, resolvedPaneId, "launched", sender?.paneId, confirmed.identity.agentSession, abortSignal);
          phase = "prompt_verification";
        } else {
          const confirmed = await confirmPromptConsumption(deps.cli, resolvedPaneId, abortSignal, initialPromptSubmission!, baseline, clock, confirmationStartedAt);
          initialPromptObservation = confirmed.observation;
          promptConfirmation = confirmed.confirmation;
          timing.postAckConfirmationMs = confirmed.confirmation.elapsedMs;
          postState = confirmed.pane;
          agentId ??= idFrom(confirmed.agent, "agent_id") ?? idFrom(confirmed.agent, "id") ?? idFrom(confirmed.pane, "agent_id");
        }
      } catch (error) {
        const errorDetails = record(error) && record(error.details) ? error.details : undefined;
        const confirmation = errorDetails?.promptConfirmation;
        if (record(confirmation) && typeof confirmation.elapsedMs === "number") timing.postAckConfirmationMs = confirmation.elapsedMs;
        if (error instanceof LaunchError && error.code === "PROMPT_UNCONFIRMED") {
          throw new LaunchError(error.code, error.message, { ...error.details, paneId: resolvedPaneId, supervisorJobId: reservation!.jobId, assignmentState: "unconfirmed", supervision: boundSupervision! });
        }
        throw error;
      }
      assignmentState = "confirmed";
      if (agentId) created.agentId = agentId;
      const exactIdentity = capturedIdentity as PromptTargetIdentity;
      const capability = recipientCapability(chosenRuntime.kind);
      const recipient = { recipientKey: recipientKey!, paneId: resolvedPaneId, agentName: exactIdentity.agentName, ...(agentId ? { agentId } : {}), operatingPointId: chosenContract.candidate.id, kind: capability.kind, capable: capability.capable, reason: capability.reason };
      deps.recipients?.recordFor(chosenContract.candidate.id, resolvedPaneId, recipient.recipientKey, capability, { ...exactIdentity, ...(agentId ? { agentId } : {}) }, chosenRuntime.kind === "agy" ? { agyStrengthened: true, attachmentDirectory: grant!.path } : undefined);
      recipientRegistered = deps.recipients !== undefined;
      const launchDetails: LaunchDetails = {
        operation: "launch", outcome: "launched", launchId: shared.launchId, name: exactIdentity.agentName, kind: chosenRuntime.kind, topology, tabId, paneId: resolvedPaneId,
        ...(prepared?.worktreePath === undefined ? {} : { worktree: prepared.worktreePath }),
        ...contextRebindingDetails(contextDiagnostics!),
        ...(agentId ? { agentId } : {}),
        postState: boundAgentSessionStrings(modelSafeJson(postState)) as Record<string, unknown>,
        agentStarted, initialPromptSent: true, promptSubmitted, recipientRegistered, readiness,
        promptConsumption: "confirmed", promptDispatch: promptDispatch!, assignmentState: assignmentState!, initialPromptDelivery: delivery,
        initialPromptSubmission: compactPromptSubmission(initialPromptSubmission!),
        initialPromptObservation: initialPromptObservation!,
        promptConfirmation: promptConfirmation!,
        timing, identityProvenance: "launched", ...(provenanceWarning === undefined ? {} : { provenanceWarning }),
        sender: { paneId: sender!.paneId, display: sender!.display, source: sender!.source },
        envelope: { version: "v1" as const, kind: "assignment" as const, delivery: delivery! },
        ...(published ? { attachment: published } : {}),
        handoff: { runId: handoffRun!.runId, path: handoffRun!.artifactPath }, recipient, effectCertainty: "confirmed",
        supervision: boundSupervision!,
        task: {
          ...(params.label === undefined ? {} : { label: params.label }),
          replicas: shared.replicas,
          quality: decision.quality,
          requestedTier: decision.requestedTier,
          workloadFloor: decision.workloadFloor,
          effectiveStartTier: decision.effectiveStartTier,
          effectiveCeiling: decision.effectiveCeiling,
          selected: pointIdentity(chosenContract.candidate),
          attempts,
          fallbackCandidates: chainCandidates.slice(1).map((candidate) => resolvedPointIdentity(candidate)),
          resolvedModel,
          configuration: chosenContract,
          ...(shared.recovery === undefined ? {} : {
            recovery: {
              recoveryOf: shared.recovery.runId,
              workspaceState: shared.recovery.workspaceState,
              priorRouteTier: shared.recovery.priorRouteTier,
              priorOperatingPointId: shared.recovery.priorOperatingPointId,
              priorPolicyRevision: shared.recovery.priorPolicyRevision
            }
          })
        }
      };
      return launchDetails;
    } catch (error) {
      if (agentStarted && selectedAttemptStartedAt !== undefined && timing.selectedStartReadinessMs === undefined) {
        const failureReadiness = error instanceof LaunchError && record(error.details.readiness) ? error.details.readiness.elapsedMs : undefined;
        timing.selectedStartReadinessMs = typeof failureReadiness === "number" && Number.isSafeInteger(failureReadiness) && failureReadiness >= 0 ? failureReadiness : monotonicDurationMs(clock, selectedAttemptStartedAt);
      }
      let reconciliation: LaunchReconciliationEvidence | undefined;
      if (topologyMutationDispatched) {
        try {
          reconciliation = await reconcileLaunch({ cli: deps.cli, baseline: topologyBaseline!, ...(paneId === undefined ? {} : { paneId }), ...(tabId === undefined ? {} : { tabId }), agentStarted, promptSubmitted, agentName: childName });
        } catch (readbackError) {
          reconciliation = { effectCertainty: "unknown", snapshot: "unavailable", pane: "unknown", agent: "unknown", readFailures: [`reconciliation:${reconciliationFailureCode(readbackError)}`] };
        }
        if (reconciliation?.tabId !== undefined && created.tabId === undefined) created.tabId = reconciliation.tabId;
        if (reconciliation?.paneId !== undefined && created.paneId === undefined) created.paneId = reconciliation.paneId;
        if (reconciliation?.agentId !== undefined && created.agentId === undefined) created.agentId = reconciliation.agentId;
      }
      if (!supervisionBound) reservation?.release(`launch_failed_${phase}`);
      if (prepared !== undefined && !worktreeBound) await worktrees?.release(childName);
      withDeliveryFailureEvidence(error, { handoffRunId: handoffRun!.runId });
      throw partialError(error, created, phase, grant!, { agentStarted, promptSubmitted, recipientRegistered, mutationDispatched: topologyMutationDispatched, ...(assignmentState === undefined ? {} : { assignmentState }), ...(agyInitialPromptSubmission === undefined ? {} : { initialPromptSubmission: agyInitialPromptSubmission }), ...(promptDispatch === undefined ? {} : { promptDispatch }), ...(readiness === undefined ? {} : { readiness }), ...(boundSupervision === undefined ? {} : { supervision: boundSupervision }), timing, attempts }, delivery, published, reconciliation);
    } finally {
      try { await grant?.release(); } finally { await launchGate?.release(); }
    }
  };

  const executeRequest = async (
    rawParams: unknown,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<LaunchResult> | undefined,
    ctx: ExtensionContext
  ): Promise<AgentToolResult<LaunchResult>> => {
    const launchId = randomUUID();
    const emit = (result: LaunchResult): AgentToolResult<LaunchResult> => ({ content: [{ type: "text", text: launchManifest(result) }], details: result });
    // Fail-closed preconditions run before the gate: they are pure reads and
    // must reject without any launch effect.
    let params: NormalizedLaunchTask;
    let recovery: RecoveryContext | undefined;
    try {
      params = normalizedParams(rawParams);
      // A recovery resolves the prior run's managed lineage — namespace, v2
      // record, route and workspace evidence — before any launch effect.
      if (params.recoveryOf !== undefined) {
        recovery = await resolveRecoveryOf(params, deps.handoffs ?? (defaultHandoffs ??= createHandoffAllocator({})), deps.cwd ?? ctx.cwd);
      }
      if (params.replicas > 1 && worktrees === undefined) {
        throw new LaunchError("WORKTREE_UNAVAILABLE", "Replica isolation requires a worktree manager");
      }
    } catch (error) {
      throw earlyLaunchFailure(error, "validate");
    }
    const abortSignal = signal ?? ctx.signal ?? new AbortController().signal;
    let gate: LaunchGateLease | undefined;
    try {
      gate = await (deps.launchGate ?? (() => acquireLaunchGate()))();
      await gate.check();
    } catch {
      await gate?.release().catch(() => undefined);
      throw new LaunchError("LAUNCH_FROZEN", "Launch is frozen");
    }
    let resolvedCwd: string;
    try {
      // Early size gate on the caller-authored Task body alone — a pure check
      // that rejects before any filesystem or CLI touch; the child's full
      // payload (Task plus contract) is measured again after compile.
      const body = renderTask(params);
      assertMessageText(body);
      if (utf8Bytes(body) > ATTACHMENT_MAX_BYTES) {
        throw new LaunchError("MESSAGE_TOO_LARGE", "Rendered task exceeds the attachment delivery bound");
      }
      // The canonical cwd is resolved and recorded before any effect (D13); a
      // recovery resumes the prior run's managed workspace instead.
      resolvedCwd = recovery === undefined ? await resolveLaunchCwd(params.cwd, deps.cwd ?? ctx.cwd) : recovery.resumedWorkspace;
      if (typeof deps.cli.prompt !== "function") throw new LaunchError("CLI_INCOMPATIBLE", "Herdr prompt transport is unavailable");
      await deps.preflight(abortSignal, "agent.prompt");
    } catch (error) {
      await gate.release();
      throw earlyLaunchFailure(error, "validate");
    }
    await gate.release();

    const task: RoutingTask = { objective: params.objective, scope: params.scope, doneWhen: params.doneWhen, constraints: params.constraints, tier: params.tier };
    const routed = await routeTaskOnce(params, task, launchId, abortSignal, ctx, recovery);
    // The router consumed the lifted start preference; requestedTier on the
    // recorded decision keeps its documented meaning — the caller's ask.
    const routedRecord: TaskRouteRecord = recovery !== undefined && isAdmitted(routed.record.decision)
      ? { ...routed.record, decision: { ...routed.record.decision, requestedTier: params.tier } }
      : routed.record;
    const routerLog = deps.routerLog ?? appendRouterDecision;
    try {
      await routerLog(taskRouteLogEntry(launchId, routedRecord), { root: deps.cwd ?? ctx.cwd });
    } catch {
      return emit({ kind: "launch", launchId, outcome: "failed", requestedTier: params.tier, children: [], error: { code: "ROUTER_LOG_UNAVAILABLE", message: "Task decision could not be persisted" } });
    }

    const decision = routedRecord.decision;
    if (!isAdmitted(decision)) {
      /* Bounded caller-facing abstention fact: the full probabilities and
       * evidence stay in the decision log; this is the minimum a caller needs
       * to self-correct (e.g. clarify the Task after a low-confidence intent). */
      const abstention = decision.kind === "abstained"
        ? { reason: decision.reason, ...(decision.component === undefined ? {} : { component: decision.component }) }
        : undefined;
      return emit({ kind: "launch", launchId, outcome: "abstained", requestedTier: params.tier, children: [], ...(abstention === undefined ? {} : { abstention }) });
    }
    const catalog = routed.catalog!;
    const intent = decision.evidence.intent?.value;
    /* c8 ignore next 4 -- admitted decisions always carry the workload classification; the guard keeps a malformed decision from launching blind. */
    if (intent === undefined) {
      return emit({ kind: "launch", launchId, outcome: "failed", requestedTier: params.tier, effectiveTier: decision.effectiveStartTier, children: [], error: { code: "ROUTER_EVIDENCE_INCOMPLETE", message: "Admitted decision lacks the workload classification" } });
    }
    const shared: LaunchShared = {
      launchId,
      catalog,
      resolvedCwd,
      intent,
      replicas: params.replicas,
      specLabel: "task",
      ...(recovery === undefined ? {} : { recovery })
    };

    const children: LaunchResultChild[] = [];
    let halted = false;
    for (let ordinal = 1; ordinal <= params.replicas; ordinal += 1) {
      const childName = mintChildName(launchId, ordinal);
      if (halted || abortSignal.aborted) {
        halted = true;
        children.push({ target: childName, state: "not_started", error: { code: "ABORTED", message: "Launch aborted before this child started" } });
        continue;
      }
      const childUpdate: AgentToolUpdateCallback<LaunchResult> | undefined = onUpdate === undefined ? undefined : (update) => onUpdate({ ...update, content: [{ type: "text", text: `[${childName}]` }, ...update.content] });
      try {
        const details = await executeChild(params, { ...routedRecord, decision }, shared, childName, abortSignal, childUpdate, ctx);
        children.push({
          target: childName,
          state: "launched",
          operatingPointId: details.task?.selected.id,
          supervisorJobId: details.supervision?.jobId,
          ...(details.worktree === undefined ? {} : { worktree: details.worktree })
        });
      } catch (error) {
        /* c8 ignore next -- executeChild throws only LaunchError; the fallback keeps a foreign throw fail-closed. */
        const failureDetails = error instanceof LaunchError ? error.details : undefined;
        const retainedJobId = safeDiagnosticString(failureDetails?.supervisorJobId, 128);
        children.push({ target: childName, state: "failed", error: launchChildError(error), ...(retainedJobId === undefined ? {} : { supervisorJobId: retainedJobId }) });
      }
    }
    const launched = children.filter((child) => child.state === "launched").length;
    const outcome: LaunchResult["outcome"] = launched === 0 ? "failed" : launched === children.length ? "launched" : "partial";
    return emit({ kind: "launch", launchId, outcome, requestedTier: params.tier, effectiveTier: decision.effectiveStartTier, children });
  };

  return {
    name: "herdr_launch",
    label: "Herdr Launch",
    description: "Launch one Task as supervised Herdr children; the runtime owns identity, topology, delivery, supervision, and evidence.",
    parameters: LaunchTaskSchema,
    async execute(_id, rawParams, signal, onUpdate, ctx) {
      return executeRequest(rawParams, signal, onUpdate, ctx);
    },
    renderCall(args, theme) {
      const label = typeof args.label === "string" ? args.label : "task";
      const tier = typeof args.tier === "string" ? args.tier : "standard";
      const replicas = typeof args.replicas === "number" ? args.replicas : 1;
      return textComponent(formatCall("herdr_launch", `${label} · ${tier}${replicas > 1 ? ` ×${replicas}` : ""}`), theme, "accent");
    },
    renderResult(result, options, theme) {
      const details = result.details;
      return renderResultComponent("launch", result, options, theme, details?.kind === "launch" ? details.launchId : undefined);
    }
  };
}

export { validateParams as validateLaunchParams, boundedReconciliationRead as boundedLaunchReconciliationRead };

/** Test-only seams for the exhaustive launch lifecycle fixtures. */
export const launchTestInternals = {
  boundedDiagnosticText,
  safeDiagnosticString,
  safeDiagnosticIds,
  diagnosticRecovery,
  safeLaunchCode,
  launchDiagnosticMessage,
  record,
  identifier,
  normalizedParams,
  mintChildName,
  resolveLaunchCwd,
  mintedNameTaken,
  workloadTabOrdinal,
  selectWorkloadTab,
  supervisionWorkspaceRoot,
  paneRecord,
  agentGetRecord,
  agentIdentity,
  idFrom,
  paneRefFrom,
  tabRefFrom,
  noAgentFromPane,
  compactAttemptState,
  reconciliationFailureCode,
  reconciliationTimeout,
  boundedReconciliationRead,
  readbackAgentName,
  readbackAgentId,
  malformedReadback,
  readbackPaneRecord,
  readbackAgentRecord,
  launchEffectCertainty,
  reconcileLaunch,
  cliErrorEnvelope,
  startFailureEvidence,
  snapshotOf,
  readinessScalar,
  readinessSessionField,
  ownReadinessSessionField,
  compactIdentityRecord,
  compactReadinessRecords,
  own,
  sameSession,
  mergeReadinessIdentity,
  completeReadinessIdentity,
  completeProvisionalReadinessIdentity,
  agyInteractiveReadiness,
  requiredReadinessPaneId,
  snapshotReadinessRecords,
  readinessAgentRecord,
  readinessPaneRecord,
  readinessLifecycle,
  readinessLifecycleSkew,
  readinessBaseline,
  createReadWindow,
  readWithinWindow,
  waitForReadPoll,
  waitForAgentStartSettle,
  monotonicDurationMs,
  readinessEvidence,
  compactReadinessErrorValue,
  compactReadinessErrorMetadata,
  readinessFailure,
  waitForLaunchReadiness,
  compactConfirmationObservation,
  promptConfirmationEvidence,
  promptUnconfirmed,
  confirmPromptConsumption,
  agyPromptSubmissionEvidence,
  parseAgyPromptAcknowledgement,
  agyPromptUnconfirmed,
  confirmAgyNativeSession,
  noFocusArgs,
  compactCliFailureEvidence,
  cliFailureEvidence,
  launchTransportCode,
  causeMessage,
  earlyLaunchFailure,
  failureEffectCertainty,
  partialError,
  progress,
  run,
  runPrompt,
  launchChildError,
  launchManifest,
  pointIdentity,
  launchBinding,
  allReviewedResources,
  resolvedPointIdentity,
  resolvedPointKey,
  isAdmitted,
  recipientCapability,
  taskRouterState,
  taskRouteLogEntry
} as const;
