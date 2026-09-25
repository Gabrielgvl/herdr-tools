import type { AvailabilitySubject, Catalog, RunnerEntry, RunnerKind } from "./catalog.js";
import { availability as defaultAvailability, type AvailabilityOptions, type CandidateAvailability } from "./availability.js";
import { compileCandidateContract, CompileError, type CompiledContract, type CompileSpec, type ResolvedPoint, type ResourceSelection } from "./compile.js";
import type { ClaudeEffort, ThinkingLevel } from "./profiles/types.js";
import {
  POLICY_REVISION,
  QUALITY_TIERS,
  maxTier,
  tierRank,
  type ChainExclusion,
  type QualityTier,
  type WorkloadIntent,
  type WorkloadProfile,
  type WorkspaceState,
} from "./routing-policy.js";

export type AbstainReason = "low_confidence" | "no_candidates_at_tier" | "catalog_unavailable" | "invalid_response" | "authentication_unavailable" | "transport_failed" | "aborted";

export interface RoutingTask {
  objective: string;
  scope: string;
  doneWhen: readonly string[];
  constraints: readonly string[];
  tier?: QualityTier;
}

export interface RouterPointEntry {
  id: string;
  runner: RunnerKind;
  model: string;
  reasoning?: ThinkingLevel | ClaudeEffort;
  provider: string;
  timeout: number;
}

export interface TaskRouterState {
  task: RoutingTask;
  points: readonly RouterPointEntry[];
}

export const ROUTER_CONFIDENCE_THRESHOLD = 0.8;
/** Retained for log compatibility; modifiers are no longer asked or routed on. */
export const MODIFIER_THRESHOLD = 0.7;
export const WORKLOAD_INTENTS: readonly WorkloadIntent[] = ["explore", "reason", "implement", "debug", "verify", "review", "coordinate", "unknown"];
export const SEMANTIC_MODIFIERS = ["mutation_broad", "scope_repo_wide", "horizon_long", "ambiguity_high"] as const;
export type SemanticModifier = (typeof SEMANTIC_MODIFIERS)[number];

export type QualityRejectionReason = "done_when_unverifiable";
export type QualityOutcome = "not_rejected" | "not_evaluated" | "rejected";

export interface ModifierEvidence {
  probability: number;
  applied: boolean;
  confidence: number;
}

export interface IntentEvidence {
  value: WorkloadIntent;
  confidence: number;
  probabilities?: Readonly<Record<string, number>>;
}

export interface TierEvidence {
  value: QualityTier;
  confidence: number;
  probabilities?: Readonly<Record<string, number>>;
}

export interface SelectedPoint {
  index: number;
  id: string;
  runner: RunnerKind;
  model: string;
  reasoning?: ThinkingLevel | ClaudeEffort;
}

export interface ResourceExclusion {
  field: "tools" | "extensions" | "skills" | "plugins" | "mcp";
  name: string;
  noul: number;
}

export interface RouterEvidence {
  quality?: { outcome: QualityOutcome; done_when_verifiable?: number };
  policyRevision?: string;
  intent?: IntentEvidence;
  modifiers?: Partial<Record<SemanticModifier, ModifierEvidence>>;
  workload?: WorkloadProfile;
  fitness?: Readonly<Record<string, number>>;
  chainExclusions?: readonly ChainExclusion[];
  selectedPoint?: SelectedPoint;
  availability?: readonly { id: string; status: CandidateAvailability["status"]; retryNotBefore: string | null }[];
  exclusions?: readonly ResourceExclusion[];
}

export interface Admitted {
  kind: "admitted";
  quality: Exclude<QualityOutcome, "rejected">;
  count: number;
  requestedTier?: QualityTier;
  /** Jev's weakest-sufficient tier. */
  workloadFloor?: QualityTier;
  effectiveStartTier?: QualityTier;
  effectiveCeiling?: QualityTier;
  chain: readonly string[];
  selectedPoint: SelectedPoint;
  configuration: CompiledContract;
  evidence: RouterEvidence;
}

export interface Rejected {
  kind: "rejected";
  quality: "rejected";
  reason: QualityRejectionReason;
  evidence: RouterEvidence;
}

export interface Abstained {
  kind: "abstained";
  reason: AbstainReason;
  component?: string;
  evidence?: RouterEvidence;
  requestSize?: { questions: number; bytes: number };
}

export type SpecDecision = Admitted | Rejected | Abstained;

export interface RouterBinding {
  caller: string;
  specRevision: string;
  policyRevision: string;
  launchIdentity: string;
}

export interface QualityJudgment { done_when_verifiable: unknown }

export interface TaskModelDecision {
  quality?: QualityJudgment;
  intent?: IntentEvidence | string;
  tier?: TierEvidence | QualityTier;
  uncertainDimensions?: readonly string[];
  transport?: boolean | { component?: string };
  /** Legacy fields are ignored; retained so old log fixtures remain readable. */
  modifiers?: Partial<Record<SemanticModifier, ModifierEvidence | number | { noul: number }>>;
  resources?: Record<string, Record<string, Record<string, unknown>>>;
  fitness?: Record<string, Record<string, unknown>>;
}

export type AvailabilityGate = (candidate: AvailabilitySubject, runner: RunnerEntry, options: AvailabilityOptions) => Promise<CandidateAvailability>;
export type CompileGate = (catalog: Catalog, spec: CompileSpec, resolved: ResolvedPoint, selection: ResourceSelection) => Promise<CompiledContract>;

export interface TaskRouteInput {
  task: RoutingTask;
  spec: CompileSpec & { count?: number };
  catalog: Catalog;
  response: unknown;
  root?: string;
  availability?: AvailabilityGate;
  compile?: CompileGate;
  now?: () => Date;
  workspaceState?: WorkspaceState;
  recovery?: { priorOperatingPointId: string };
}

interface ParsedBinary { probability: number; confidence: number }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function bounded(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\0\r\n]/.test(value);
}

function abstain(reason: AbstainReason, component?: string, evidence?: RouterEvidence): Abstained {
  return { kind: "abstained", reason, ...(component === undefined ? {} : { component }), ...(evidence === undefined ? {} : { evidence }) };
}

function parseBinary(value: unknown): ParsedBinary | undefined {
  return finiteProbability(value) ? { probability: value, confidence: Math.max(value, 1 - value) } : undefined;
}

function qualityDecision(value: unknown): { gate?: ParsedBinary; result?: Rejected | Abstained } {
  if (!record(value) || !record(value.quality)) return { result: abstain("invalid_response", "quality") };
  const gate = parseBinary(value.quality.done_when_verifiable);
  if (gate === undefined) return { result: abstain("invalid_response", "quality") };
  if (gate.probability <= 1 - ROUTER_CONFIDENCE_THRESHOLD && gate.confidence >= ROUTER_CONFIDENCE_THRESHOLD) {
    return { gate, result: { kind: "rejected", quality: "rejected", reason: "done_when_unverifiable", evidence: { quality: { outcome: "rejected", done_when_verifiable: gate.probability } } } };
  }
  return { gate };
}

function transportComponent(value: unknown): string | undefined {
  if (!record(value) || value.transport !== true) return undefined;
  return bounded(value.component) ? value.component : "transport";
}

function distribution(value: unknown, keys: readonly string[]): Readonly<Record<string, number>> | undefined {
  if (!record(value) || Object.keys(value).length !== keys.length) return undefined;
  let sum = 0;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key) || !finiteProbability(value[key])) return undefined;
    sum += value[key];
  }
  return Math.abs(sum - 1) <= 1e-6 ? value as Readonly<Record<string, number>> : undefined;
}

function intentJudgment(value: unknown): IntentEvidence | undefined {
  if (!record(value) || typeof value.value !== "string" || !WORKLOAD_INTENTS.includes(value.value as WorkloadIntent) || !finiteProbability(value.confidence)) return undefined;
  if (value.probabilities === undefined) return { value: value.value as WorkloadIntent, confidence: value.confidence };
  const probabilities = distribution(value.probabilities, WORKLOAD_INTENTS.filter((intent) => intent !== "unknown"));
  return probabilities === undefined ? undefined : { value: value.value as WorkloadIntent, confidence: value.confidence, probabilities };
}

function tierJudgment(value: unknown): TierEvidence | undefined {
  if (!record(value) || typeof value.value !== "string" || !QUALITY_TIERS.includes(value.value as QualityTier) || !finiteProbability(value.confidence)) return undefined;
  if (value.probabilities === undefined) return { value: value.value as QualityTier, confidence: value.confidence };
  const probabilities = distribution(value.probabilities, QUALITY_TIERS);
  return probabilities === undefined ? undefined : { value: value.value as QualityTier, confidence: value.confidence, probabilities };
}

/**
 * Deterministic tool surface; skill/plugin/MCP selection remains disabled.
 * Pi lanes pin the five native tools plus the executor-gateway trio — the
 * `--tools` allowlist is the only channel that can reach executor_* tools, so
 * a lane whose reviewed pool carries the gateway recipe gets the trio, and a
 * pool without it degrades to the natives alone.
 */
export function runnerResourceSelection(_response: TaskModelDecision, runner: RunnerKind, entry?: RunnerEntry): ResourceSelection {
  const desired = runner === "pi" ? ["read", "bash", "edit", "write", "ask_user_question", "executor_execute", "executor_skills", "executor_resume"] : runner === "claude" ? ["Read", "Bash", "Write"] : [];
  const tools = entry === undefined ? desired : desired.filter((tool) => entry.pools.tools.includes(tool));
  return tools.length === 0 ? {} : { tools };
}

function availabilityEvidence(statuses: Map<string, CandidateAvailability>): RouterEvidence["availability"] {
  return [...statuses.entries()].map(([id, value]) => ({ id, status: value.status, retryNotBefore: value.retryNotBefore ?? null }));
}

function quotaIdentity(point: { quota: { provider: string; billingProduct: string; account: string; scope: string } }): string {
  const { provider, billingProduct, account, scope } = point.quota;
  return `${provider}\0${billingProduct}\0${account}\0${scope}`;
}

/** Route from Jev's semantic tier into catalog-owned chains; Jev never ranks operating points. */
export async function routeTask(input: TaskRouteInput): Promise<SpecDecision> {
  const quality = qualityDecision(input.response);
  if (quality.result !== undefined) return quality.result;
  const transport = transportComponent(input.response);
  if (transport !== undefined) return abstain("transport_failed", transport);
  const response = input.response as Record<string, unknown>;
  const intent = intentJudgment(response.intent);
  if (intent === undefined) return abstain("invalid_response", "intent");
  const tier = tierJudgment(response.tier);
  if (tier === undefined) return abstain("invalid_response", "tier");

  const chains = input.catalog.tierChains;
  const points = input.catalog.points ?? [];
  if (chains === undefined || points.length === 0) return abstain("catalog_unavailable", "tierChains");
  const pointById = new Map(points.map((point) => [point.id, point]));
  const requestedTier = input.task.tier ?? "standard";
  const effectiveTier = maxTier(requestedTier, tier.value);
  const ids = [...new Set(QUALITY_TIERS.slice(tierRank(effectiveTier)).flatMap((name) => chains[name]))];
  if (ids.some((id) => !pointById.has(id))) return abstain("catalog_unavailable", "tierChains");

  const chainExclusions: ChainExclusion[] = [];
  let candidates = ids.map((id) => pointById.get(id)!);
  if (input.recovery !== undefined) {
    const failedProvider = pointById.get(input.recovery.priorOperatingPointId)?.provider;
    if (failedProvider === undefined) return abstain("catalog_unavailable", "recovery");
    candidates = candidates.filter((point) => {
      if (point.provider !== failedProvider) return true;
      chainExclusions.push({ id: point.id, provider: point.provider, reasons: ["recovery_excluded"] });
      return false;
    });
  }

  const evidenceBase: RouterEvidence = {
    quality: { outcome: "not_rejected", done_when_verifiable: quality.gate!.probability },
    policyRevision: POLICY_REVISION,
    intent,
    workload: {
      intent: intent.value,
      mutation: "none",
      scope: "local",
      horizon: "short",
      verifiability: quality.gate!.probability >= ROUTER_CONFIDENCE_THRESHOLD ? "strong" : quality.gate!.probability >= 0.5 ? "partial" : "weak",
      workspaceState: input.workspaceState ?? "clean",
      ambiguity: "low",
    },
  };
  const withExclusions = (): Pick<RouterEvidence, "chainExclusions"> => chainExclusions.length === 0 ? {} : { chainExclusions };
  if (candidates.length === 0) return abstain("no_candidates_at_tier", undefined, { ...evidenceBase, ...withExclusions() });

  const availabilityGate = input.availability ?? defaultAvailability;
  if (input.root === undefined && input.availability === undefined) return abstain("transport_failed", "availability");
  const options: AvailabilityOptions = { root: input.root ?? "", ...(input.now === undefined ? {} : { now: input.now }) };
  const statuses = new Map<string, CandidateAvailability>();
  const exhaustedQuotas = new Set<string>();
  const localRunners = new Set<RunnerKind>();
  const available: typeof candidates = [];
  for (const point of candidates) {
    if (exhaustedQuotas.has(quotaIdentity(point)) || localRunners.has(point.runner)) {
      chainExclusions.push({ id: point.id, provider: point.provider, reasons: ["unavailable"] });
      continue;
    }
    const runner = input.catalog.runners.get(point.runner);
    if (runner === undefined) return abstain("catalog_unavailable", "catalog");
    let status: CandidateAvailability;
    try {
      status = await availabilityGate({ runner: point.runner, model: point.model }, runner, options);
    } catch {
      return abstain("transport_failed", "availability");
    }
    statuses.set(point.id, status);
    if (status.status === "known-exhausted") exhaustedQuotas.add(quotaIdentity(point));
    if (status.status === "local-capacity-limited") localRunners.add(point.runner);
    if (status.status === "known-exhausted" || status.status === "local-capacity-limited") {
      chainExclusions.push({ id: point.id, provider: point.provider, reasons: ["unavailable"] });
      continue;
    }
    available.push(point);
  }

  if (available.length === 0) {
    const allLocal = statuses.size > 0 && [...statuses.values()].every((status) => status.status === "local-capacity-limited");
    return abstain(allLocal ? "transport_failed" : "no_candidates_at_tier", allLocal ? "availability" : undefined, {
      ...evidenceBase,
      ...withExclusions(),
      availability: availabilityEvidence(statuses),
    });
  }

  const point = available[0]!;
  const runner = input.catalog.runners.get(point.runner)!;
  const selectedPoint: SelectedPoint = { index: 0, id: point.id, runner: point.runner, model: point.model, ...(point.reasoning === undefined ? {} : { reasoning: point.reasoning }) };
  const selection = runnerResourceSelection(response as TaskModelDecision, point.runner, runner);
  let configuration: CompiledContract;
  try {
    configuration = await (input.compile ?? compileCandidateContract)(input.catalog, input.spec, { index: 0, point, runner }, selection);
  } catch (error) {
    if (error instanceof CompileError && ["INVALID_SELECTION", "SELECTION_OUTSIDE_POOL"].includes(error.code)) return abstain("invalid_response", "candidates");
    return abstain("catalog_unavailable", "configuration");
  }

  return {
    kind: "admitted",
    quality: "not_rejected",
    count: input.spec.count ?? 1,
    requestedTier,
    workloadFloor: tier.value,
    effectiveStartTier: effectiveTier,
    effectiveCeiling: "max",
    chain: available.map((member) => member.id),
    selectedPoint,
    configuration,
    evidence: {
      ...evidenceBase,
      ...withExclusions(),
      selectedPoint,
      availability: availabilityEvidence(statuses),
    },
  };
}
