/**
 * The ADR-035 decision log. Inputs are reduced to a fixed, typed record before
 * modelSafeJson runs: caller/bypass identity, the decision kind, quality,
 * bounded evidence, and the compiled contract's reviewed fields only.
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { lstat, mkdir, open } from "node:fs/promises";
import { acquireFlockHolder, assertOwnerOnlyDirectory } from "./pane-write-lock.js";
import { modelSafeJson } from "./redaction.js";
import type {
  Abstain,
  Abstained,
  Admitted,
  RouterBinding,
  RouterEvidence,
  RouterResult,
  RouterState,
  RouteDecision,
  Rejected,
  SpecDecision
} from "./router.js";

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
  "no_assignments",
  "catalog_unavailable",
  "invalid_response",
  "authentication_unavailable",
  "transport_failed",
  "aborted"
]);
const QUALITY = new Set(["not_rejected", "not_evaluated", "rejected"]);
const AVAILABILITY = new Set(["known-exhausted", "degraded", "unknown", "local-capacity-limited"]);
const RUNNERS = new Set(["pi", "claude", "agy", "devin"]);
const POOL_FIELDS = ["tools", "extensions", "skills", "plugins", "mcp"] as const;
const PROBABILITY_SUM_TOLERANCE = 1e-6;

export interface UnavailableRouterState {
  status: "unavailable";
  reason: "catalog_unavailable";
}

/** The pre-cutover shape stays assignable to B8 while the new overload is added below. */
export interface RouterLogEntry {
  name: string;
  state: RouterState | UnavailableRouterState;
  probabilities: unknown;
  result: RouterResult;
  caller?: string;
  binding?: RouterBinding;
  specRevision?: string;
  policyRevision?: string;
  launchIdentity?: string;
  evidence?: RouterEvidence;
}

/** ADR-035 record input; no model text or raw response is accepted. */
export interface SpecRouterLogEntry {
  caller: string;
  result: SpecDecision;
  binding?: RouterBinding;
  evidence?: RouterEvidence;
  name?: string;
  specRevision?: string;
  policyRevision?: string;
  launchIdentity?: string;
  state?: RouterState | UnavailableRouterState;
  probabilities?: unknown;
}

export interface RouterLogRecord {
  timestamp: string;
  /** Caller alias retained for the B8 reader; it equals `caller`. */
  name: string;
  caller: string;
  binding: RouterBinding | null;
  stateDigest: string | null;
  stateUnavailable: { reason: "catalog_unavailable" } | null;
  probabilities: Record<string, unknown>;
  result: LoggedRouterResult;
  evidence: LoggedEvidence;
}

export type LoggedRouterResult =
  | Pick<Admitted, "kind" | "quality" | "category" | "count" | "configuration" | "evidence">
  | Pick<Rejected, "kind" | "quality" | "reason" | "evidence">
  | Pick<Abstained, "kind" | "reason" | "component" | "evidence">
  | RouteDecision
  | Abstain;

export interface LoggedEvidence {
  quality?: RouterEvidence["quality"];
  category?: RouterEvidence["category"];
  selectedCandidate?: RouterEvidence["selectedCandidate"];
  availability?: RouterEvidence["availability"];
  exclusions?: RouterEvidence["exclusions"];
  bypass?: RouterEvidence["bypass"];
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
    if (!record(value.quality) || !probability(value.quality.instructions_adequate) || !probability(value.quality.assignment_verifiable)) {
      throw routerLogFailure("Router decision probabilities are untrusted");
    }
    out.quality = { instructions_adequate: value.quality.instructions_adequate, assignment_verifiable: value.quality.assignment_verifiable };
  }
  if (value.category !== undefined) {
    if (!record(value.category) || !bounded(value.category.category) || !probability(value.category.confidence)) {
      throw routerLogFailure("Router decision probabilities are untrusted");
    }
    out.category = {
      category: value.category.category,
      confidence: value.category.confidence,
      ...(value.category.probabilities === undefined ? {} : { probabilities: distribution(value.category.probabilities) })
    };
  }
  if (value.candidates !== undefined) {
    if (!Array.isArray(value.candidates)) throw routerLogFailure("Router decision probabilities are untrusted");
    out.candidates = value.candidates.map((candidate) => {
      if (!record(candidate) || !Number.isInteger(candidate.index) || !RUNNERS.has(candidate.runner as string) || !bounded(candidate.model) || !record(candidate.resources)) {
        throw routerLogFailure("Router decision probabilities are untrusted");
      }
      const resources: Record<string, Record<string, number>> = {};
      for (const field of POOL_FIELDS) {
        if (candidate.resources[field] !== undefined) resources[field] = probabilityRecord(candidate.resources[field]);
      }
      return { index: candidate.index, runner: candidate.runner, model: candidate.model, resources };
    });
  }
  if (value.composition !== undefined) {
    if (!record(value.composition) || !probability(value.composition.missing_area)) throw routerLogFailure("Router decision probabilities are untrusted");
    out.composition = { missing_area: value.composition.missing_area };
  }
  return out;
}

function stateForJev(state: RouterState): unknown {
  return {
    assignment: {
      objective: state.assignment.objective,
      scope: state.assignment.scope,
      verification: state.assignment.verification
    },
    catalog: state.catalog.map(({ name, description, runner, model, timeout }) => ({ name, description, runner, model, timeout }))
  };
}

export function routerStateDigest(state: RouterState): string {
  return createHash("sha256").update(JSON.stringify(stateForJev(state))).digest("hex");
}

function isUnavailableMarker(state: RouterState | UnavailableRouterState): state is UnavailableRouterState {
  return record(state) && state.status === "unavailable" && state.reason === "catalog_unavailable" && !("assignment" in state) && !("catalog" in state);
}

function validateState(state: RouterState | UnavailableRouterState): void {
  if (isUnavailableMarker(state)) return;
  if (!record(state) || !record(state.assignment) || !Array.isArray(state.catalog)) throw routerLogFailure("Router decision state is malformed");
  for (const entry of state.catalog) if (!record(entry) || !bounded(entry.name)) throw routerLogFailure("Router decision state is malformed");
}

type AnyRouterLogEntry = RouterLogEntry | SpecRouterLogEntry;

function bindingFromEntry(entry: AnyRouterLogEntry, caller: string): RouterBinding | null {
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

function projectEvidence(value: unknown): LoggedEvidence {
  if (value === undefined) return {};
  if (!record(value)) throw routerLogFailure("Router decision evidence is untrusted");
  const out: LoggedEvidence = {};
  if (value.quality !== undefined) {
    if (!record(value.quality) || typeof value.quality.outcome !== "string" || !QUALITY.has(value.quality.outcome)) throw routerLogFailure("Router decision evidence is untrusted");
    const quality: NonNullable<LoggedEvidence["quality"]> = { outcome: value.quality.outcome as "not_rejected" | "not_evaluated" | "rejected" };
    if (value.quality.instructions_adequate !== undefined) {
      if (!probability(value.quality.instructions_adequate)) throw routerLogFailure("Router decision evidence is untrusted");
      quality.instructions_adequate = value.quality.instructions_adequate;
    }
    if (value.quality.assignment_verifiable !== undefined) {
      if (!probability(value.quality.assignment_verifiable)) throw routerLogFailure("Router decision evidence is untrusted");
      quality.assignment_verifiable = value.quality.assignment_verifiable;
    }
    out.quality = quality;
  }
  if (value.category !== undefined) {
    if (!record(value.category) || !bounded(value.category.name) || !probability(value.category.confidence)) throw routerLogFailure("Router decision evidence is untrusted");
    out.category = { name: value.category.name, confidence: value.category.confidence };
  }
  if (value.selectedCandidate !== undefined) {
    if (!record(value.selectedCandidate) || !Number.isInteger(value.selectedCandidate.index) || !RUNNERS.has(value.selectedCandidate.runner as string) || !bounded(value.selectedCandidate.model)) throw routerLogFailure("Router decision evidence is untrusted");
    out.selectedCandidate = { index: value.selectedCandidate.index as number, runner: value.selectedCandidate.runner as "pi" | "claude" | "agy" | "devin", model: value.selectedCandidate.model as string };
  }
  if (value.availability !== undefined) {
    if (!Array.isArray(value.availability)) throw routerLogFailure("Router decision evidence is untrusted");
    out.availability = value.availability.map((item) => {
      if (!record(item) || !Number.isInteger(item.index) || typeof item.status !== "string" || !AVAILABILITY.has(item.status) || (item.retryNotBefore !== null && !bounded(item.retryNotBefore))) {
        throw routerLogFailure("Router decision evidence is untrusted");
      }
      return { index: item.index as number, status: item.status as NonNullable<RouterEvidence["availability"]>[number]["status"], retryNotBefore: item.retryNotBefore as string | null };
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
  if (value.bypass !== undefined) {
    if (!record(value.bypass) || (value.bypass.label !== "transport-abstain" && value.bypass.label !== "abstain") || typeof value.bypass.quality !== "string" || !QUALITY.has(value.bypass.quality)) throw routerLogFailure("Router decision evidence is untrusted");
    out.bypass = { label: value.bypass.label, quality: value.bypass.quality as "not_rejected" | "not_evaluated" | "rejected" };
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
  if (!record(value) || !bounded(value.specLabel) || !record(value.candidate) || !Number.isInteger(value.candidate.index) || !RUNNERS.has(value.candidate.runner as string) || !bounded(value.candidate.model) || !record(value.quota) || !bounded(value.quota.provider) || !bounded(value.quota.billingProduct) || !bounded(value.quota.account) || !bounded(value.quota.scope) || !bounded(value.scopeRoot) || typeof value.sessionPersistence !== "boolean" || !Number.isInteger(value.timeoutMinutes) || !record(value.plumbing) || !record(value.runtime) || !Array.isArray(value.derivations) || !Array.isArray(value.gaps)) {
    throw routerLogFailure("Router compiled configuration is untrusted");
  }
  const candidateValue = value.candidate;
  const quotaValue = value.quota;
  const candidate = {
    index: candidateValue.index as number,
    runner: candidateValue.runner as "pi" | "claude" | "agy" | "devin",
    model: candidateValue.model as string,
    ...(candidateValue.account === undefined ? {} : { account: candidateValue.account as string })
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
    if (!QUALITY.has(result.quality) || !bounded(result.category) || !Number.isInteger(result.count) || result.count < 1) throw routerLogFailure("Router decision result is malformed");
    return { kind: "admitted", quality: result.quality, category: result.category, count: result.count, configuration: projectConfiguration(result.configuration), evidence: projectEvidence(result.evidence) };
  }
  if (result.kind === "rejected") {
    if (result.quality !== "rejected" || (result.reason !== "instructions_inadequate" && result.reason !== "assignment_unverifiable")) throw routerLogFailure("Router decision result is malformed");
    return { kind: "rejected", quality: "rejected", reason: result.reason, evidence: projectEvidence(result.evidence) };
  }
  if (result.kind !== "abstained" || !REASONS.has(result.reason) || (result.component !== undefined && !bounded(result.component))) throw routerLogFailure("Router decision result is malformed");
  return { kind: "abstained", reason: result.reason, ...(result.component === undefined ? {} : { component: result.component }), ...(result.evidence === undefined ? {} : { evidence: projectEvidence(result.evidence) }) };
}

function projectLegacyResult(result: RouteDecisionOrAbstain): LoggedRouterResult {
  if (result.kind === "abstain") {
    if (!REASONS.has(result.reason) || (result.component !== undefined && !bounded(result.component))) throw routerLogFailure("Router decision result is malformed");
    return result.component === undefined ? { kind: "abstain", reason: result.reason } : { kind: "abstain", reason: result.reason, component: result.component };
  }
  if (!Array.isArray(result.assignments)) throw routerLogFailure("Router decision result is malformed");
  return { kind: "route", assignments: result.assignments.map((item) => {
    if (!record(item) || !bounded(item.profile) || !Number.isInteger(item.count) || item.count < 1 || !bounded(item.purpose)) throw routerLogFailure("Router decision result is malformed");
    return { profile: item.profile, count: item.count, purpose: item.purpose };
  }) };
}

type RouteDecisionOrAbstain = Extract<RouterResult, { kind: "route" | "abstain" }>;

function buildRecord(entry: AnyRouterLogEntry, now: () => Date): RouterLogRecord {
  const caller = entry.caller ?? entry.name;
  if (!bounded(caller)) throw routerLogFailure("Router decision caller is untrusted");
  const binding = bindingFromEntry(entry, caller);
  let stateDigest: string | null = null;
  let stateUnavailable: RouterLogRecord["stateUnavailable"] = null;
  if (entry.state !== undefined) {
    validateState(entry.state);
    if (isUnavailableMarker(entry.state)) stateUnavailable = { reason: "catalog_unavailable" };
    else stateDigest = routerStateDigest(entry.state);
  }
  const specResult = entry.result.kind === "admitted" || entry.result.kind === "rejected" || entry.result.kind === "abstained";
  const result = specResult ? projectSpecResult(entry.result as SpecDecision) : projectLegacyResult(entry.result as RouteDecisionOrAbstain);
  const evidence = projectEvidence(entry.evidence ?? (specResult ? (entry.result as SpecDecision).evidence : undefined));
  const probabilities = specResult ? projectSpecProbabilities(entry.probabilities) : {};
  return { timestamp: now().toISOString(), name: caller, caller, binding, stateDigest, stateUnavailable, probabilities, result, evidence };
}

async function ensureLogDirectory(directory: string): Promise<void> {
  for (const path of [dirname(directory), directory]) {
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
export function appendRouterDecision(entry: RouterLogEntry, options: AppendRouterLogOptions): Promise<void>;
export function appendRouterDecision(entry: SpecRouterLogEntry, options: AppendRouterLogOptions): Promise<void>;
export async function appendRouterDecision(entry: AnyRouterLogEntry, options: AppendRouterLogOptions): Promise<void> {
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
