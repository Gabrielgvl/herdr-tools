/**
 * The ADR-035 decision log. Inputs are reduced to a fixed, typed record before
 * modelSafeJson runs: caller/binding identity, the decision kind, quality,
 * bounded evidence, and the compiled contract's reviewed fields only.
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { lstat, mkdir, open } from "node:fs/promises";
import { acquireFlockHolder, assertOwnerOnlyDirectory } from "./pane-write-lock.js";
import { CLAUDE_EFFORTS, THINKING_LEVELS, type ClaudeEffort, type ThinkingLevel } from "./profiles/types.js";
import { modelSafeJson } from "./redaction.js";
import type {
  Abstained,
  Admitted,
  RouterBinding,
  RouterEvidence,
  Rejected,
  SelectedPoint,
  SpecDecision,
  TaskRouterState
} from "./router.js";
import { SEMANTIC_MODIFIERS, WORKLOAD_INTENTS } from "./router.js";
import { QUALITY_TIERS } from "./routing-policy.js";

export class RouterLogError extends Error {
  readonly code = "ROUTER_LOG_UNAVAILABLE";

  constructor(message = "Router decision log is unavailable") {
    super(message);
    this.name = "RouterLogError";
  }
}

const routerLogFailure = (message: string): RouterLogError => new RouterLogError(message);

export const ROUTER_LOG_LOCK_WAIT_MS = 5_000;
const ROUTER_LOG_READY = "HERDR_ROUTER_LOG_LOCK_READY";
const REASONS = new Set([
  "low_confidence",
  "no_candidates_at_tier",
  "catalog_unavailable",
  "invalid_response",
  "authentication_unavailable",
  "transport_failed",
  "aborted"
]);
const QUALITY = new Set(["not_rejected", "not_evaluated", "rejected"]);
const AVAILABILITY = new Set(["known-exhausted", "degraded", "unknown", "local-capacity-limited"]);
const RUNNERS = new Set(["pi", "claude", "agy", "devin"]);
const TIERS = new Set<string>(QUALITY_TIERS);
const INTENTS = new Set<string>(WORKLOAD_INTENTS);
const MODIFIERS = new Set<string>(SEMANTIC_MODIFIERS);
const REASONING = new Set<string>([...THINKING_LEVELS, ...CLAUDE_EFFORTS]);
const WORKLOAD_FIELDS = {
  intent: INTENTS,
  mutation: new Set(["none", "bounded", "broad"]),
  scope: new Set(["local", "multi_file", "repo_wide"]),
  horizon: new Set(["short", "medium", "long"]),
  verifiability: new Set(["strong", "partial", "weak"]),
  workspaceState: new Set(["clean", "partial", "failed"]),
  ambiguity: new Set(["low", "medium", "high"])
} as const;
const CHAIN_EXCLUSION_REASONS = new Set(["cost_class_exceeded", "latency_class_exceeded", "attempt_bound", "unavailable", "required_resource", "recovery_excluded"]);
const POOL_FIELDS = ["tools", "extensions", "skills", "plugins", "mcp"] as const;
const PROBABILITY_SUM_TOLERANCE = 1e-6;

export interface UnavailableRouterState {
  status: "unavailable";
  reason: "catalog_unavailable";
}

/** ADR-035 record input; no model text or raw response is accepted. */
export interface SpecRouterLogEntry {
  caller: string;
  result: SpecDecision;
  binding?: RouterBinding;
  evidence?: RouterEvidence;
  specRevision?: string;
  policyRevision?: string;
  launchIdentity?: string;
  /** The catalog content digest the decision was routed against. */
  catalogRevision?: string;
  /** Recovery lineage: the managed handoff run this route recovers. */
  recoveryOf?: string;
  /** Recovery lineage: the failed operating point the chain excludes. */
  priorOperatingPointId?: string;
  state?: TaskRouterState | UnavailableRouterState;
  probabilities?: unknown;
}

export interface RouterLogRecord {
  timestamp: string;
  /** Caller alias; it equals `caller`. */
  name: string;
  caller: string;
  binding: RouterBinding | null;
  catalogRevision: string | null;
  /** Recovery lineage pair — both null on ordinary routes, both set on recovery. */
  recoveryOf: string | null;
  priorOperatingPointId: string | null;
  stateDigest: string | null;
  stateUnavailable: { reason: "catalog_unavailable" } | null;
  probabilities: Record<string, unknown>;
  result: LoggedRouterResult;
  evidence: LoggedEvidence;
}

export type LoggedRouterResult =
  | Pick<Admitted, "kind" | "quality" | "count" | "requestedTier" | "workloadFloor" | "effectiveStartTier" | "effectiveCeiling" | "chain" | "selectedPoint" | "configuration" | "evidence">
  | Pick<Rejected, "kind" | "quality" | "reason" | "evidence">
  | Pick<Abstained, "kind" | "reason" | "component" | "requestSize" | "evidence">;

export interface LoggedEvidence {
  quality?: RouterEvidence["quality"];
  policyRevision?: string;
  intent?: RouterEvidence["intent"];
  modifiers?: RouterEvidence["modifiers"];
  workload?: RouterEvidence["workload"];
  fitness?: RouterEvidence["fitness"];
  chainExclusions?: RouterEvidence["chainExclusions"];
  selectedPoint?: RouterEvidence["selectedPoint"];
  availability?: RouterEvidence["availability"];
  exclusions?: RouterEvidence["exclusions"];
}

export interface AppendRouterLogOptions {
  /** Trusted manager/session project root — never a caller-controlled child cwd. */
  root: string;
  now?: () => Date;
  waitMs?: number;
  deadlineMs?: number;
}

export interface RouterLogPaths {
  directory: string;
  decisions: string;
  lock: string;
}

export function routerLogPaths(root: string): RouterLogPaths {
  const directory = join(root, ".herdr", "router");
  return { directory, decisions: join(directory, "decisions.jsonl"), lock: join(directory, "decisions.lock") };
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function uid(): number {
  const value = process.getuid?.();
  /* c8 ignore next -- flock only exists on platforms that provide getuid. */
  if (value === undefined) throw routerLogFailure("Router decision log owner is unavailable");
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bounded(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\0\r\n]/.test(value) && Buffer.byteLength(value, "utf8") <= 512;
}

function number(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function probability(value: unknown): value is number {
  return number(value) && value >= 0 && value <= 1;
}

function probabilityRecord(value: unknown): Record<string, number> {
  if (!record(value)) throw routerLogFailure("Router decision probabilities are untrusted");
  const out: Record<string, number> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!bounded(name) || !probability(entry)) throw routerLogFailure("Router decision probabilities are untrusted");
    out[name] = entry;
  }
  return out;
}

function distribution(value: unknown): Record<string, number> {
  const out = probabilityRecord(value);
  const sum = Object.values(out).reduce((total, entry) => total + entry, 0);
  if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) throw routerLogFailure("Router decision probabilities are untrusted");
  return out;
}

/** Allowlist the normalized spec response. Raw model bodies never reach this boundary. */
function projectSpecProbabilities(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!record(value)) throw routerLogFailure("Router decision probabilities are untrusted");
  const out: Record<string, unknown> = {};
  if (value.quality !== undefined) {
    if (!record(value.quality) || !probability(value.quality.done_when_verifiable)) {
      throw routerLogFailure("Router decision probabilities are untrusted");
    }
    out.quality = { done_when_verifiable: value.quality.done_when_verifiable };
  }
  if (value.intent !== undefined) {
    if (!record(value.intent) || !INTENTS.has(value.intent.value as string) || !probability(value.intent.confidence)) {
      throw routerLogFailure("Router decision probabilities are untrusted");
    }
    out.intent = {
      value: value.intent.value,
      confidence: value.intent.confidence,
      ...(value.intent.probabilities === undefined ? {} : { probabilities: distribution(value.intent.probabilities) })
    };
  }
  if (value.tier !== undefined) {
    if (!record(value.tier) || !TIERS.has(value.tier.value as string) || !probability(value.tier.confidence)) {
      throw routerLogFailure("Router decision probabilities are untrusted");
    }
    out.tier = {
      value: value.tier.value,
      confidence: value.tier.confidence,
      ...(value.tier.probabilities === undefined ? {} : { probabilities: distribution(value.tier.probabilities) })
    };
  }
  if (value.modifiers !== undefined) {
    if (!record(value.modifiers)) throw routerLogFailure("Router decision probabilities are untrusted");
    const modifiers: Record<string, unknown> = {};
    for (const [name, entry] of Object.entries(value.modifiers)) {
      if (!MODIFIERS.has(name) || !record(entry) || !probability(entry.probability) || typeof entry.applied !== "boolean" || !probability(entry.confidence)) {
        throw routerLogFailure("Router decision probabilities are untrusted");
      }
      modifiers[name] = { probability: entry.probability, applied: entry.applied, confidence: entry.confidence };
    }
    out.modifiers = modifiers;
  }
  if (value.resources !== undefined) {
    if (!record(value.resources)) throw routerLogFailure("Router decision probabilities are untrusted");
    const resources: Record<string, Record<string, Record<string, number>>> = {};
    for (const [runner, fields] of Object.entries(value.resources)) {
      if (!RUNNERS.has(runner) || !record(fields)) throw routerLogFailure("Router decision probabilities are untrusted");
      const projected: Record<string, Record<string, number>> = {};
      for (const [field, names] of Object.entries(fields)) {
        if (!(POOL_FIELDS as readonly string[]).includes(field)) throw routerLogFailure("Router decision probabilities are untrusted");
        projected[field] = probabilityRecord(names);
      }
      resources[runner] = projected;
    }
    out.resources = resources;
  }
  if (value.fitness !== undefined) {
    if (!record(value.fitness)) throw routerLogFailure("Router decision probabilities are untrusted");
    const fitness: Record<string, Record<string, number>> = {};
    for (const [index, tiers] of Object.entries(value.fitness)) {
      if (!bounded(index) || !/^\d+$/.test(index) || !record(tiers)) throw routerLogFailure("Router decision probabilities are untrusted");
      const byTier: Record<string, number> = {};
      for (const [tier, entry] of Object.entries(tiers)) {
        if (!TIERS.has(tier) || !probability(entry)) throw routerLogFailure("Router decision probabilities are untrusted");
        byTier[tier] = entry;
      }
      fitness[index] = byTier;
    }
    out.fitness = fitness;
  }
  if (value.uncertainDimensions !== undefined) {
    if (!Array.isArray(value.uncertainDimensions) || !value.uncertainDimensions.every((entry) => bounded(entry))) {
      throw routerLogFailure("Router decision probabilities are untrusted");
    }
    out.uncertainDimensions = [...value.uncertainDimensions];
  }
  return out;
}

function stateForTask(state: TaskRouterState): unknown {
  return {
    task: {
      objective: state.task.objective,
      scope: state.task.scope,
      doneWhen: [...state.task.doneWhen],
      constraints: [...state.task.constraints],
      ...(state.task.tier === undefined ? {} : { tier: state.task.tier })
    },
    points: state.points.map((point) => ({
      id: point.id,
      runner: point.runner,
      model: point.model,
      ...(point.reasoning === undefined ? {} : { reasoning: point.reasoning }),
      provider: point.provider,
      timeout: point.timeout
    }))
  };
}

export function routerStateDigest(state: TaskRouterState): string {
  return createHash("sha256").update(JSON.stringify(stateForTask(state))).digest("hex");
}

function isUnavailableMarker(state: TaskRouterState | UnavailableRouterState): state is UnavailableRouterState {
  return record(state) && state.status === "unavailable" && state.reason === "catalog_unavailable" && !("assignment" in state) && !("catalog" in state) && !("task" in state);
}

function validateState(state: TaskRouterState | UnavailableRouterState): void {
  if (isUnavailableMarker(state)) return;
  if (!record(state) || !record(state.task) || !Array.isArray(state.points)) throw routerLogFailure("Router decision state is malformed");
  for (const entry of state.points) if (!record(entry) || !bounded(entry.id)) throw routerLogFailure("Router decision state is malformed");
}

function bindingFromEntry(entry: SpecRouterLogEntry, caller: string): RouterBinding | null {
  if (entry.binding !== undefined) {
    if (!record(entry.binding) || !bounded(entry.binding.caller) || !bounded(entry.binding.specRevision) || !bounded(entry.binding.policyRevision) || !bounded(entry.binding.launchIdentity)) {
      throw routerLogFailure("Router decision binding is untrusted");
    }
    return {
      caller: entry.binding.caller,
      specRevision: entry.binding.specRevision,
      policyRevision: entry.binding.policyRevision,
      launchIdentity: entry.binding.launchIdentity
    };
  }
  const { specRevision, policyRevision, launchIdentity } = entry;
  if (specRevision === undefined && policyRevision === undefined && launchIdentity === undefined) return null;
  if (!bounded(specRevision) || !bounded(policyRevision) || !bounded(launchIdentity)) throw routerLogFailure("Router decision binding is untrusted");
  return { caller, specRevision, policyRevision, launchIdentity };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(bounded)) throw routerLogFailure("Router decision evidence is untrusted");
  return [...value];
}

function projectSelectedPoint(value: unknown): SelectedPoint {
  if (!record(value) || !Number.isInteger(value.index) || !bounded(value.id) || !RUNNERS.has(value.runner as string) || !bounded(value.model)) {
    throw routerLogFailure("Router decision evidence is untrusted");
  }
  if (value.reasoning !== undefined && !REASONING.has(value.reasoning as string)) throw routerLogFailure("Router decision evidence is untrusted");
  return {
    index: value.index as number,
    id: value.id as string,
    runner: value.runner as SelectedPoint["runner"],
    model: value.model as string,
    ...(value.reasoning === undefined ? {} : { reasoning: value.reasoning as SelectedPoint["reasoning"] })
  };
}

function projectEvidence(value: unknown): LoggedEvidence {
  if (value === undefined) return {};
  if (!record(value)) throw routerLogFailure("Router decision evidence is untrusted");
  const out: LoggedEvidence = {};
  if (value.quality !== undefined) {
    if (!record(value.quality) || typeof value.quality.outcome !== "string" || !QUALITY.has(value.quality.outcome)) throw routerLogFailure("Router decision evidence is untrusted");
    const quality: NonNullable<LoggedEvidence["quality"]> = { outcome: value.quality.outcome as "not_rejected" | "not_evaluated" | "rejected" };
    if (value.quality.done_when_verifiable !== undefined) {
      if (!probability(value.quality.done_when_verifiable)) throw routerLogFailure("Router decision evidence is untrusted");
      quality.done_when_verifiable = value.quality.done_when_verifiable;
    }
    out.quality = quality;
  }
  if (value.policyRevision !== undefined) {
    if (!bounded(value.policyRevision)) throw routerLogFailure("Router decision evidence is untrusted");
    out.policyRevision = value.policyRevision;
  }
  if (value.intent !== undefined) {
    if (!record(value.intent) || !INTENTS.has(value.intent.value as string) || !probability(value.intent.confidence)) throw routerLogFailure("Router decision evidence is untrusted");
    out.intent = {
      value: value.intent.value as NonNullable<RouterEvidence["intent"]>["value"],
      confidence: value.intent.confidence,
      ...(value.intent.probabilities === undefined ? {} : { probabilities: distribution(value.intent.probabilities) })
    };
  }
  if (value.modifiers !== undefined) {
    if (!record(value.modifiers)) throw routerLogFailure("Router decision evidence is untrusted");
    const modifiers: NonNullable<LoggedEvidence["modifiers"]> = {};
    for (const [name, entry] of Object.entries(value.modifiers)) {
      if (!MODIFIERS.has(name) || !record(entry) || !probability(entry.probability) || typeof entry.applied !== "boolean" || !probability(entry.confidence)) {
        throw routerLogFailure("Router decision evidence is untrusted");
      }
      modifiers[name as keyof typeof modifiers] = { probability: entry.probability, applied: entry.applied, confidence: entry.confidence };
    }
    out.modifiers = modifiers;
  }
  if (value.workload !== undefined) {
    if (!record(value.workload)) throw routerLogFailure("Router decision evidence is untrusted");
    const workload: Record<string, string> = {};
    for (const [field, members] of Object.entries(WORKLOAD_FIELDS)) {
      const entry = value.workload[field];
      if (typeof entry !== "string" || !members.has(entry)) throw routerLogFailure("Router decision evidence is untrusted");
      workload[field] = entry;
    }
    out.workload = workload as unknown as NonNullable<RouterEvidence["workload"]>;
  }
  if (value.fitness !== undefined) {
    out.fitness = probabilityRecord(value.fitness);
  }
  if (value.chainExclusions !== undefined) {
    if (!Array.isArray(value.chainExclusions)) throw routerLogFailure("Router decision evidence is untrusted");
    out.chainExclusions = value.chainExclusions.map((item) => {
      if (!record(item) || !bounded(item.id) || !bounded(item.provider) || !Array.isArray(item.reasons) || item.reasons.length === 0 || !item.reasons.every((reason: unknown) => typeof reason === "string" && CHAIN_EXCLUSION_REASONS.has(reason))) {
        throw routerLogFailure("Router decision evidence is untrusted");
      }
      return { id: item.id, provider: item.provider, reasons: [...item.reasons] as NonNullable<RouterEvidence["chainExclusions"]>[number]["reasons"] };
    });
  }
  if (value.selectedPoint !== undefined) {
    out.selectedPoint = projectSelectedPoint(value.selectedPoint);
  }
  if (value.availability !== undefined) {
    if (!Array.isArray(value.availability)) throw routerLogFailure("Router decision evidence is untrusted");
    out.availability = value.availability.map((item) => {
      if (!record(item) || !bounded(item.id) || typeof item.status !== "string" || !AVAILABILITY.has(item.status) || (item.retryNotBefore !== null && !bounded(item.retryNotBefore))) {
        throw routerLogFailure("Router decision evidence is untrusted");
      }
      return { id: item.id as string, status: item.status as NonNullable<RouterEvidence["availability"]>[number]["status"], retryNotBefore: item.retryNotBefore as string | null };
    });
  }
  if (value.exclusions !== undefined) {
    if (!Array.isArray(value.exclusions)) throw routerLogFailure("Router decision evidence is untrusted");
    out.exclusions = value.exclusions.map((item) => {
      if (!record(item) || !POOL_FIELDS.includes(item.field as (typeof POOL_FIELDS)[number]) || !bounded(item.name) || !probability(item.noul)) {
        throw routerLogFailure("Router decision evidence is untrusted");
      }
      return { field: item.field as (typeof POOL_FIELDS)[number], name: item.name, noul: item.noul };
    });
  }
  return out;
}

function projectRuntime(value: unknown): unknown {
  if (!record(value) || !bounded(value.kind as unknown) || !RUNNERS.has(value.kind as string) || !bounded(value.model)) throw routerLogFailure("Router compiled configuration is untrusted");
  if (value.kind === "pi") return { kind: "pi", model: value.model, thinking: value.thinking, tools: stringArray(value.tools), extensions: stringArray(value.extensions), skills: stringArray(value.skills) };
  if (value.kind === "claude") return { kind: "claude", model: value.model, effort: value.effort, permissionMode: value.permissionMode, allowedTools: stringArray(value.allowedTools), disallowedTools: stringArray(value.disallowedTools), addDirs: stringArray(value.addDirs), pluginDirs: stringArray(value.pluginDirs), developmentChannels: stringArray(value.developmentChannels) };
  if (value.kind === "agy") return { kind: "agy", model: value.model, mode: value.mode, addDirs: stringArray(value.addDirs) };
  return { kind: "devin", model: value.model, permissionMode: value.permissionMode };
}

function projectResources(value: unknown): unknown {
  if (!record(value)) throw routerLogFailure("Router compiled configuration is untrusted");
  const out: Record<string, unknown> = {};
  for (const field of POOL_FIELDS) {
    const item = value[field];
    if (item === undefined) continue;
    if (!record(item)) throw routerLogFailure("Router compiled configuration is untrusted");
    out[field] = {
      installed: stringArray(item.installed),
      selected: stringArray(item.selected),
      exposed: stringArray(item.exposed),
      permitted: stringArray(item.permitted),
      denied: stringArray(item.denied)
    };
  }
  return out;
}

function projectConfiguration(value: unknown): Admitted["configuration"] {
  if (!record(value) || !bounded(value.specLabel) || !record(value.candidate) || !Number.isInteger(value.candidate.index) || !bounded(value.candidate.id) || !RUNNERS.has(value.candidate.runner as string) || !bounded(value.candidate.model) || (value.candidate.reasoning !== undefined && !REASONING.has(value.candidate.reasoning as string)) || !record(value.quota) || !bounded(value.quota.provider) || !bounded(value.quota.billingProduct) || !bounded(value.quota.account) || !bounded(value.quota.scope) || !bounded(value.scopeRoot) || typeof value.sessionPersistence !== "boolean" || !Number.isInteger(value.timeoutMinutes) || !record(value.plumbing) || !record(value.runtime) || !Array.isArray(value.derivations) || !Array.isArray(value.gaps)) {
    throw routerLogFailure("Router compiled configuration is untrusted");
  }
  const candidateValue = value.candidate;
  const quotaValue = value.quota;
  const candidate = {
    index: candidateValue.index as number,
    id: candidateValue.id as string,
    runner: candidateValue.runner as "pi" | "claude" | "agy" | "devin",
    model: candidateValue.model as string,
    ...(candidateValue.reasoning === undefined ? {} : { reasoning: candidateValue.reasoning as ThinkingLevel | ClaudeEffort })
  };
  const derivations = value.derivations.map((item) => {
    if (!record(item) || (item.action !== "dependency" && item.action !== "incompatible" && item.action !== "deny") || !POOL_FIELDS.includes(item.field as (typeof POOL_FIELDS)[number]) || !bounded(item.name) || !bounded(item.reason)) throw routerLogFailure("Router compiled configuration is untrusted");
    return { action: item.action, field: item.field, name: item.name, reason: item.reason };
  });
  const gaps = value.gaps.map((item) => {
    if (!record(item) || (item.kind !== "deny-coverage" && item.kind !== "ambient-exposure") || !bounded(item.message)) throw routerLogFailure("Router compiled configuration is untrusted");
    return { kind: item.kind, message: item.message };
  });
  const plumbingValue = value.plumbing;
  const plumbing = {
    sessionPersistence: plumbingValue.sessionPersistence,
    promptDelivery: plumbingValue.promptDelivery,
    skillSelection: plumbingValue.skillSelection,
    toolSelection: plumbingValue.toolSelection
  };
  return {
    specLabel: value.specLabel as string,
    candidate,
    quota: { provider: quotaValue.provider as string, billingProduct: quotaValue.billingProduct as string, account: quotaValue.account as string, scope: quotaValue.scope as string },
    scopeRoot: value.scopeRoot as string,
    sessionPersistence: value.sessionPersistence as boolean,
    timeoutMinutes: value.timeoutMinutes as number,
    plumbing: plumbing as Admitted["configuration"]["plumbing"],
    runtime: projectRuntime(value.runtime) as Admitted["configuration"]["runtime"],
    resources: projectResources(value.resources) as Admitted["configuration"]["resources"],
    derivations: derivations as Admitted["configuration"]["derivations"],
    gaps: gaps as Admitted["configuration"]["gaps"]
  } as Admitted["configuration"];
}

function projectSpecResult(result: SpecDecision): LoggedRouterResult {
  if (result.kind === "admitted") {
    if (!QUALITY.has(result.quality) || !Number.isInteger(result.count) || result.count < 1) throw routerLogFailure("Router decision result is malformed");
    for (const tier of [result.requestedTier, result.workloadFloor, result.effectiveStartTier, result.effectiveCeiling]) {
      if (tier !== undefined && !TIERS.has(tier)) throw routerLogFailure("Router decision result is malformed");
    }
    if (!Array.isArray(result.chain) || result.chain.length === 0 || !result.chain.every(bounded)) throw routerLogFailure("Router decision result is malformed");
    return {
      kind: "admitted",
      quality: result.quality,
      count: result.count,
      ...(result.requestedTier === undefined ? {} : { requestedTier: result.requestedTier }),
      ...(result.workloadFloor === undefined ? {} : { workloadFloor: result.workloadFloor }),
      ...(result.effectiveStartTier === undefined ? {} : { effectiveStartTier: result.effectiveStartTier }),
      ...(result.effectiveCeiling === undefined ? {} : { effectiveCeiling: result.effectiveCeiling }),
      chain: [...result.chain],
      selectedPoint: projectSelectedPoint(result.selectedPoint),
      configuration: projectConfiguration(result.configuration),
      evidence: projectEvidence(result.evidence)
    };
  }
  if (result.kind === "rejected") {
    if (result.quality !== "rejected" || result.reason !== "done_when_unverifiable") throw routerLogFailure("Router decision result is malformed");
    return { kind: "rejected", quality: "rejected", reason: result.reason, evidence: projectEvidence(result.evidence) };
  }
  if (result.kind !== "abstained" || !REASONS.has(result.reason) || (result.component !== undefined && !bounded(result.component))) throw routerLogFailure("Router decision result is malformed");
  const requestSize = result.requestSize;
  if (requestSize !== undefined && (!Number.isInteger(requestSize.questions) || requestSize.questions < 0 || !Number.isInteger(requestSize.bytes) || requestSize.bytes < 0)) throw routerLogFailure("Router decision result is malformed");
  return { kind: "abstained", reason: result.reason, ...(result.component === undefined ? {} : { component: result.component }), ...(requestSize === undefined ? {} : { requestSize }), ...(result.evidence === undefined ? {} : { evidence: projectEvidence(result.evidence) }) };
}

function buildRecord(entry: SpecRouterLogEntry, now: () => Date): RouterLogRecord {
  const caller = entry.caller;
  if (!bounded(caller)) throw routerLogFailure("Router decision caller is untrusted");
  const binding = bindingFromEntry(entry, caller);
  let stateDigest: string | null = null;
  let stateUnavailable: RouterLogRecord["stateUnavailable"] = null;
  if (entry.state !== undefined) {
    validateState(entry.state);
    if (isUnavailableMarker(entry.state)) stateUnavailable = { reason: "catalog_unavailable" };
    else stateDigest = routerStateDigest(entry.state);
  }
  const catalogRevision = entry.catalogRevision === undefined ? null : entry.catalogRevision;
  if (catalogRevision !== null && !bounded(catalogRevision)) throw routerLogFailure("Router decision catalog revision is untrusted");
  const recoveryOf = entry.recoveryOf === undefined ? null : entry.recoveryOf;
  const priorOperatingPointId = entry.priorOperatingPointId === undefined ? null : entry.priorOperatingPointId;
  if ((recoveryOf === null) !== (priorOperatingPointId === null) || (recoveryOf !== null && !bounded(recoveryOf)) || (priorOperatingPointId !== null && !bounded(priorOperatingPointId))) {
    throw routerLogFailure("Router decision recovery lineage is untrusted");
  }
  const result = projectSpecResult(entry.result);
  const evidence = projectEvidence(entry.evidence ?? entry.result.evidence);
  const probabilities = projectSpecProbabilities(entry.probabilities);
  return { timestamp: now().toISOString(), name: caller, caller, binding, catalogRevision, recoveryOf, priorOperatingPointId, stateDigest, stateUnavailable, probabilities, result, evidence };
}

async function ensureLogDirectory(directory: string): Promise<void> {
  const parent = dirname(directory);
  for (const [path, ownerOnly] of [[parent, false], [directory, true]] as const) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw routerLogFailure("Router decision log directory is unavailable");
    }
    let value;
    try {
      value = await lstat(path);
    } catch {
      throw routerLogFailure("Router decision log directory is unavailable");
    }
    if (!ownerOnly) {
      // The `.herdr` parent is a shared coordination directory that herdr itself
      // and other tooling may create with a default umask; requiring owner-only
      // here failed every launch in projects whose `.herdr` predated the router
      // log (ROUTER_LOG_UNAVAILABLE). The trust boundary is the router leaf and
      // the 0600 no-follow decisions file below, not the shared parent.
      if (!value.isDirectory() || value.isSymbolicLink() || value.uid !== uid()) throw routerLogFailure("Router decision log directory is unavailable");
      continue;
    }
    assertOwnerOnlyDirectory(path, value, routerLogFailure, "Router decision log");
  }
}

async function appendLine(path: string, line: string): Promise<void> {
  let value;
  try {
    value = await lstat(path);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw routerLogFailure("Router decision log file is indeterminate");
  }
  if (value !== undefined && (!value.isFile() || value.isSymbolicLink() || value.uid !== uid() || (Number(value.mode) & 0o22) !== 0)) throw routerLogFailure("Router decision log file is not trusted");
  const flags = constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW;
  let handle;
  try {
    handle = await open(path, flags, 0o600);
  } catch {
    throw routerLogFailure("Router decision log file is unavailable");
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.uid !== uid() || (Number(opened.mode) & 0o22) !== 0) throw routerLogFailure("Router decision log file is not trusted");
    await handle.appendFile(line);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Validate the typed projection before redaction and append one whole line. */
export async function appendRouterDecision(entry: SpecRouterLogEntry, options: AppendRouterLogOptions): Promise<void> {
  try {
    if (!isAbsolute(options.root)) throw routerLogFailure("Router decision log root is untrusted");
    const line = `${JSON.stringify(modelSafeJson(buildRecord(entry, options.now ?? (() => new Date()))))}\n`;
    const paths = routerLogPaths(options.root);
    await ensureLogDirectory(paths.directory);
    const holder = await acquireFlockHolder({
      lockPath: paths.lock,
      wait: { timeoutMs: options.waitMs ?? ROUTER_LOG_LOCK_WAIT_MS },
      ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
      readyMarker: ROUTER_LOG_READY,
      subject: "Router decision log",
      failure: routerLogFailure
    });
    try {
      await appendLine(paths.decisions, line);
    } finally {
      await holder.release().catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof RouterLogError) throw error;
    throw new RouterLogError();
  }
}
