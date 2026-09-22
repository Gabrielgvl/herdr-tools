import type { AvailabilitySubject, Catalog, RunnerEntry, RunnerKind } from "./catalog.js";
import { availability as defaultAvailability, type AvailabilityOptions, type CandidateAvailability } from "./availability.js";
import { compileCandidateContract, CompileError, type CompiledContract, type CompileSpec, type ResolvedPoint, type ResourceSelection } from "./compile.js";
import type { ClaudeEffort, ThinkingLevel } from "./profiles/types.js";
import {
  MAX_ATTEMPTS,
  POLICY_REVISION,
  QUALITY_TIERS,
  rankFallbackCandidates,
  resolveTierPolicy,
  type ChainExclusion,
  type QualityTier,
  type ScoredOperatingPoint,
  type WorkloadIntent,
  type WorkloadProfile,
  type WorkloadVerifiability,
  type WorkspaceState,
} from "./routing-policy.js";

/** The old reason vocabulary is retained for every fail-closed abstention. */
export type AbstainReason =
  | "low_confidence"
  | "no_candidates_at_tier"
  | "catalog_unavailable"
  | "invalid_response"
  | "authentication_unavailable"
  | "transport_failed"
  | "aborted";

/**
 * The canonical Task the router admits (ADR-037): one caller-authored
 * contract per launch call. `tier` is the optional requested starting
 * posture; omission resolves to `standard` inside the tier policy.
 */
export interface RoutingTask {
  objective: string;
  scope: string;
  doneWhen: readonly string[];
  constraints: readonly string[];
  tier?: QualityTier;
}

/** One operating point projected into the routing state that binding digests cover. */
export interface RouterPointEntry {
  /** The opaque stable point id; never parsed or split. */
  id: string;
  runner: RunnerKind;
  model: string;
  reasoning?: ThinkingLevel | ClaudeEffort;
  /** The point's declared below-runner provider — pi/codex, pi/zai, and pi/opencode-go are distinct domains. */
  provider: string;
  timeout: number;
}

/** The new-model routing state: the canonical Task plus the ordered operating-point projection. */
export interface TaskRouterState {
  task: RoutingTask;
  points: readonly RouterPointEntry[];
}

export const ROUTER_CONFIDENCE_THRESHOLD = 0.8;
/** Difficult-modifier Nouls are one-sided positives: applied at this probability, never an abstention. */
export const MODIFIER_THRESHOLD = 0.7;

/** The closed intent Choice — the only confidence gate in the workload profile. */
export const WORKLOAD_INTENTS: readonly WorkloadIntent[] = ["explore", "reason", "implement", "debug", "verify", "review", "coordinate"];

/** The four difficult semantic modifiers; each applied one lifts the tier interval by one. */
export const SEMANTIC_MODIFIERS = ["mutation_broad", "scope_repo_wide", "horizon_long", "ambiguity_high"] as const;
export type SemanticModifier = (typeof SEMANTIC_MODIFIERS)[number];

export type QualityRejectionReason = "done_when_unverifiable";
export type QualityOutcome = "not_rejected" | "not_evaluated" | "rejected";

/** One difficult modifier's normalized judgment: the Noul probability and the one-sided application bit. */
export interface ModifierEvidence {
  probability: number;
  applied: boolean;
  confidence: number;
}

/** The workload intent judgment and its validated Choice distribution. */
export interface IntentEvidence {
  value: WorkloadIntent;
  confidence: number;
  probabilities?: Readonly<Record<string, number>>;
}

/** The operating point a decision selected: `index` is the position within `Admitted.chain`. */
export interface SelectedPoint {
  index: number;
  id: string;
  runner: RunnerKind;
  model: string;
  reasoning?: ThinkingLevel | ClaudeEffort;
}

export interface RouterEvidence {
  quality?: {
    outcome: QualityOutcome;
    done_when_verifiable?: number;
  };
  /** The deterministic policy revision that produced the decision. */
  policyRevision?: string;
  intent?: IntentEvidence;
  /** Every semantic modifier judgment, applied or not — the probability is the evidence, `applied` is the threshold bit. */
  modifiers?: Partial<Record<SemanticModifier, ModifierEvidence>>;
  /** The full derived workload profile, including the runtime-owned workspace state and the no-floor verifiability label. */
  workload?: WorkloadProfile;
  /** The effective-tier fitness consumed per point, keyed by point id — a ranking signal, never a gate. */
  fitness?: Readonly<Record<string, number>>;
  /** The deterministic evidence for every point kept out of the chain — envelope, recovery, resource, availability, or attempt bound. */
  chainExclusions?: readonly ChainExclusion[];
  selectedPoint?: SelectedPoint;
  /** Probe outcomes in probe order, keyed by catalog point id — never by chain position. */
  availability?: readonly {
    id: string;
    status: CandidateAvailability["status"];
    retryNotBefore: string | null;
  }[];
  exclusions?: readonly ResourceExclusion[];
}

export interface Admitted {
  kind: "admitted";
  /** `not_rejected` is deliberately not a certification. */
  quality: Exclude<QualityOutcome, "rejected">;
  count: number;
  /** The caller's requested tier (`standard` when omitted). */
  requestedTier?: QualityTier;
  /** The workload floor after intent base plus per-modifier lifts. */
  workloadFloor?: QualityTier;
  effectiveStartTier?: QualityTier;
  effectiveCeiling?: QualityTier;
  /** The generated pre-execution fallback chain: catalog point ids in attempt order. */
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
  /** Bounded diagnostics for transport rejections: the measured outbound request size, so a provider-side limit is visible without the API body. */
  requestSize?: { questions: number; bytes: number };
}

export type SpecDecision = Admitted | Rejected | Abstained;

export interface RouterBinding {
  caller: string;
  specRevision: string;
  policyRevision: string;
  launchIdentity: string;
}

export interface QualityJudgment {
  done_when_verifiable: unknown;
}

/**
 * The normalized Jev response the router consumes: one done_when_verifiable
 * Noul, the intent Choice, four one-sided modifier Nouls, runner-qualified
 * resource Nouls, and the six tier-fitness Nouls keyed by catalog point index.
 */
export interface TaskModelDecision {
  quality?: QualityJudgment;
  intent?: IntentEvidence | string;
  modifiers?: Partial<Record<SemanticModifier, ModifierEvidence | number | { noul: number }>>;
  /** Resource judgments per runner, then pool field, then exact pool name. */
  resources?: Record<string, Record<string, Record<string, unknown>>>;
  /** Fitness judgments per catalog point index, then quality tier. */
  fitness?: Record<string, Record<string, unknown>>;
  uncertainDimensions?: readonly string[];
  transport?: boolean | { component?: string };
}

export type AvailabilityGate = (
  candidate: AvailabilitySubject,
  runner: RunnerEntry,
  options: AvailabilityOptions
) => Promise<CandidateAvailability>;
export type CompileGate = (
  catalog: Catalog,
  spec: CompileSpec,
  resolved: ResolvedPoint,
  selection: ResourceSelection
) => Promise<CompiledContract>;

export interface TaskRouteInput {
  task: RoutingTask;
  /** The launch-facing remnant of the old spec: identity and replica count only. */
  spec: CompileSpec & { count?: number };
  catalog: Catalog;
  response: unknown;
  /** Trusted manager/session root used by B2. */
  root?: string;
  availability?: AvailabilityGate;
  compile?: CompileGate;
  now?: () => Date;
  /** Runtime-owned workspace state — lifecycle and handoff evidence, never a Jev answer. */
  workspaceState?: WorkspaceState;
  /**
   * Recovery lineage the chain honors before the attempt bound: the failed
   * prior point is excluded, and when the failed provider would head the
   * ranking a different provider is preferred.
   */
  recovery?: { priorOperatingPointId: string };
}

interface ParsedBinary {
  probability: number;
  confidence: number;
}

interface QualityGateResult {
  status: "missing" | "invalid" | "not_rejected" | "rejected";
  reason?: QualityRejectionReason;
  doneWhen?: ParsedBinary;
}

export interface ResourceExclusion {
  field: PoolField;
  name: string;
  noul: number;
}

interface CandidateSelectionResult {
  selection: ResourceSelection;
  exclusions: ResourceExclusion[];
}

const POOL_FIELDS = ["tools", "extensions", "skills", "plugins", "mcp"] as const;
type PoolField = (typeof POOL_FIELDS)[number];

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
  return {
    kind: "abstained",
    reason,
    ...(component === undefined ? {} : { component }),
    ...(evidence === undefined ? {} : { evidence })
  };
}

function qualityEvidence(outcome: QualityOutcome, doneWhen: ParsedBinary): RouterEvidence {
  return {
    quality: {
      outcome,
      done_when_verifiable: doneWhen.probability
    }
  };
}

function parseBinary(value: unknown): ParsedBinary | undefined {
  if (finiteProbability(value)) return { probability: value, confidence: Math.max(value, 1 - value) };
  if (typeof value === "boolean") return { probability: value ? 1 : 0, confidence: 1 };
  if (!record(value)) return undefined;

  let probability: number | undefined;
  if (finiteProbability(value.probability)) probability = value.probability;
  else if (finiteProbability(value.noul)) probability = value.noul;
  else if (finiteProbability(value.yes)) probability = value.yes;
  else if (finiteProbability(value.value)) probability = value.value;
  else if (typeof value.value === "boolean") probability = value.value ? 1 : 0;
  else if (typeof value.choice === "string") {
    const choice = value.choice.toLowerCase();
    if (["yes", "true", "adequate", "verifiable", "pass"].includes(choice)) probability = 1;
    else if (["no", "false", "inadequate", "unverifiable", "fail"].includes(choice)) probability = 0;
  }
  if (probability === undefined && record(value.probabilities)) {
    const yes = value.probabilities.yes ?? value.probabilities.true ?? value.probabilities.adequate;
    const no = value.probabilities.no ?? value.probabilities.false ?? value.probabilities.inadequate;
    if (finiteProbability(yes) && finiteProbability(no) && Math.abs(yes + no - 1) <= 1e-6) probability = yes;
  }
  if (probability === undefined) return undefined;
  const confidence = value.confidence === undefined ? Math.max(probability, 1 - probability) : value.confidence;
  return finiteProbability(confidence) ? { probability, confidence } : undefined;
}

/**
 * The only semantic launch-quality gate: a confident bad answer on
 * `done_when_verifiable` rejects; anything else is not_rejected — never a
 * certification.
 */
function qualityGate(value: unknown): QualityGateResult {
  if (!record(value)) return { status: "missing" };
  const quality = value.quality === undefined ? value : record(value.quality) ? value.quality : undefined;
  if (!quality) return { status: "invalid" };
  const doneWhen = parseBinary(quality.done_when_verifiable ?? quality.doneWhenVerifiable);
  if (doneWhen !== undefined && doneWhen.probability <= 1 - ROUTER_CONFIDENCE_THRESHOLD && doneWhen.confidence >= ROUTER_CONFIDENCE_THRESHOLD) {
    return { status: "rejected", reason: "done_when_unverifiable", doneWhen };
  }
  if (doneWhen === undefined) return { status: "invalid" };
  return { status: "not_rejected", doneWhen };
}

function transportComponent(value: unknown): string | undefined {
  if (!record(value)) return undefined;
  if (value.transport === true || value.kind === "transport_failed" || value.kind === "transport") {
    const component = value.component;
    return bounded(component) ? component : "transport";
  }
  if (record(value.transport) && value.transport.failed === true) {
    return bounded(value.transport.component) ? value.transport.component : "transport";
  }
  return undefined;
}

function intentJudgment(value: unknown): IntentEvidence | undefined {
  if (typeof value === "string") return (WORKLOAD_INTENTS as readonly string[]).includes(value) ? { value: value as WorkloadIntent, confidence: 1 } : undefined;
  if (!record(value)) return undefined;
  const raw = value.value ?? value.choice ?? value.intent;
  const confidence = value.confidence ?? value.probability;
  if (typeof raw !== "string" || !(WORKLOAD_INTENTS as readonly string[]).includes(raw) || !finiteProbability(confidence)) return undefined;
  if (value.probabilities === undefined) return { value: raw as WorkloadIntent, confidence };
  if (!record(value.probabilities)) return undefined;
  const keys = Object.keys(value.probabilities);
  if (keys.length !== WORKLOAD_INTENTS.length) return undefined;
  let sum = 0;
  for (const key of keys) {
    if (!(WORKLOAD_INTENTS as readonly string[]).includes(key)) return undefined;
    const entry = value.probabilities[key]!;
    if (!finiteProbability(entry)) return undefined;
    sum += entry;
  }
  if (Math.abs(sum - 1) > 1e-6) return undefined;
  return { value: raw as WorkloadIntent, confidence, probabilities: value.probabilities as Record<string, number> };
}

/** Modifier Nouls are one-sided: a malformed or absent answer is "not applied", never an abstention. */
function modifierJudgments(value: unknown): Partial<Record<SemanticModifier, ModifierEvidence>> {
  const modifiers: Partial<Record<SemanticModifier, ModifierEvidence>> = {};
  if (!record(value)) return modifiers;
  for (const name of SEMANTIC_MODIFIERS) {
    const parsed = parseBinary(value[name]);
    if (parsed === undefined) continue;
    modifiers[name] = { probability: parsed.probability, applied: parsed.probability >= MODIFIER_THRESHOLD, confidence: parsed.confidence };
  }
  return modifiers;
}

/**
 * The derived profile. Applied modifiers supply the difficult value; the
 * weakest label records a modifier that was never established — the raw
 * probabilities in `modifiers` carry the real evidence. Verifiability is a
 * bounded evidence label only and never imposes a tier floor.
 */
function workloadProfile(intent: WorkloadIntent, modifiers: Partial<Record<SemanticModifier, ModifierEvidence>>, verifiability: WorkloadVerifiability, workspaceState: WorkspaceState): WorkloadProfile {
  return {
    intent,
    mutation: modifiers.mutation_broad?.applied === true ? "broad" : "none",
    scope: modifiers.scope_repo_wide?.applied === true ? "repo_wide" : "local",
    horizon: modifiers.horizon_long?.applied === true ? "long" : "short",
    verifiability,
    workspaceState,
    ambiguity: modifiers.ambiguity_high?.applied === true ? "high" : "low",
  };
}

function verifiabilityLabel(probability: number): WorkloadVerifiability {
  return probability >= ROUTER_CONFIDENCE_THRESHOLD ? "strong" : probability >= 0.5 ? "partial" : "weak";
}

/** The six tier-fitness Nouls per point, keyed by catalog point index; every point must answer all six. */
function fitnessJudgments(value: unknown, points: readonly { id: string }[]): Record<number, Record<QualityTier, number>> | undefined {
  if (!record(value)) return undefined;
  const out: Record<number, Record<QualityTier, number>> = {};
  for (const [index] of points.entries()) {
    const entry = value[String(index)];
    if (!record(entry)) return undefined;
    const byTier = {} as Record<QualityTier, number>;
    for (const tier of QUALITY_TIERS) {
      const parsed = parseBinary(entry[tier]);
      if (parsed === undefined) return undefined;
      byTier[tier] = parsed.probability;
    }
    out[index] = byTier;
  }
  return out;
}

function selectedFromJudgment(value: unknown): { selected: boolean; confidence: number; probability: number } | undefined {
  if (typeof value === "boolean") return { selected: value, confidence: 1, probability: value ? 1 : 0 };
  if (finiteProbability(value)) return { selected: value >= 0.5, confidence: Math.max(value, 1 - value), probability: value };
  if (!record(value)) return undefined;
  const raw = value.selected ?? value.permitted ?? value.noul ?? value.probability ?? value.value ?? value.choice;
  const parsed = parseBinary(raw);
  if (parsed === undefined) return undefined;
  const confidence = value.confidence === undefined ? parsed.confidence : value.confidence;
  return finiteProbability(confidence) ? { selected: parsed.probability >= 0.5, confidence, probability: parsed.probability } : undefined;
}

function selectionForField(value: unknown, field: PoolField): { names: string[]; exclusions: ResourceExclusion[] } | undefined {
  if (value === undefined) return { names: [], exclusions: [] };
  const names: string[] = [];
  const exclusions: ResourceExclusion[] = [];
  const consider = (name: string, judgment: { selected: boolean; confidence: number; probability: number }): void => {
    if (judgment.confidence < ROUTER_CONFIDENCE_THRESHOLD || !judgment.selected) {
      exclusions.push({ field, name, noul: judgment.probability });
      return;
    }
    names.push(name);
  };
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") {
        names.push(item);
        continue;
      }
      if (!record(item)) return undefined;
      const name = item.name ?? item.resource;
      const judgment = selectedFromJudgment(item);
      if (!bounded(name) || judgment === undefined) return undefined;
      consider(name, judgment);
    }
    return { names, exclusions };
  }
  if (!record(value)) return undefined;
  for (const [name, judgmentValue] of Object.entries(value)) {
    const judgment = selectedFromJudgment(judgmentValue);
    if (!bounded(name) || !judgment) return undefined;
    consider(name, judgment);
  }
  return { names, exclusions };
}

/** One runner's resource map — `{field: {name: judgment}}` — reduced to a selection plus exclusion evidence. */
function resourceSelection(value: unknown): CandidateSelectionResult | undefined {
  if (!record(value)) return undefined;
  const selection: ResourceSelection = {};
  const exclusions: ResourceExclusion[] = [];
  for (const field of POOL_FIELDS) {
    const parsed = selectionForField(value[field], field);
    if (parsed === undefined) return undefined;
    if (parsed.names.length > 0) selection[field] = parsed.names;
    exclusions.push(...parsed.exclusions);
  }
  return { selection, exclusions };
}

/** The selection for one runner's resources; absent or malformed degrades to an empty selection, never a throw. */
export function runnerResourceSelection(response: TaskModelDecision, runner: RunnerKind): ResourceSelection {
  if (!record(response) || !record(response.resources)) return {};
  const entry = response.resources[runner];
  if (!record(entry)) return {};
  return resourceSelection(entry)?.selection ?? {};
}

/** Only explicit requirements are derivable from free-form Task text. */
function requiredByTaskText(taskText: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mention = new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}(?=$|[^A-Za-z0-9_])`, "i");
  return taskText.split(/[\n.!?;]+/u).some((clause) => {
    if (!mention.test(clause) || /\b(?:do not|don't|must not|should not|never|without|avoid|optional|may|can|could|not required|not necessary|not needed|not use)\b/i.test(clause)) return false;
    return /\b(?:must|required|requires|require|needs|need|necessary|essential)\b/i.test(clause) || /^\s*(?:use|call|run|invoke|execute)\b/i.test(clause);
  });
}

function rejected(reason: QualityRejectionReason, gate: QualityGateResult): Rejected {
  return {
    kind: "rejected",
    quality: "rejected",
    reason,
    evidence: qualityEvidence("rejected", gate.doneWhen!)
  };
}

function qualityDecision(value: unknown): { gate: QualityGateResult; result?: Rejected | Abstained } {
  const gate = qualityGate(value);
  if (gate.status === "rejected") return { gate, result: rejected(gate.reason!, gate) };
  if (gate.status === "invalid") return { gate, result: abstain("invalid_response", "quality") };
  return { gate };
}

/** Probed candidates record their status keyed by point id, in probe order. */
function availabilityEvidence(statuses: Map<string, CandidateAvailability>): RouterEvidence["availability"] {
  return [...statuses.entries()].map(([id, value]) => ({
    id,
    status: value.status,
    retryNotBefore: value.retryNotBefore ?? null
  }));
}

/**
 * Per-Task policy orchestration (ADR-037). The only side effects are the
 * injected B2 availability reads and B4 compilation; Jev and launch remain
 * outside this module. One normalized response covers the complete point set,
 * so fallback never triggers another model call.
 *
 * Order: the done_when_verifiable gate, transport, the intent confidence gate
 * (the only abstaining classification), one-sided modifiers, the deterministic
 * tier policy, the generated point chain, then availability filtering —
 * scored before filtered.
 */
export async function routeTask(input: TaskRouteInput): Promise<SpecDecision> {
  const quality = qualityDecision(input.response);
  if (quality.result?.kind === "rejected") return quality.result;
  if (quality.result?.kind === "abstained") return quality.result;

  const transport = transportComponent(input.response);
  if (quality.gate.status === "missing") return abstain("invalid_response", "quality");
  if (transport !== undefined) return abstain("transport_failed", transport);

  // Past the quality gate the response is a record; the helpers take it typed.
  const response = input.response as Record<string, unknown>;
  const intent = intentJudgment(response.intent);
  if (intent === undefined) return abstain("invalid_response", "intent");
  if (intent.confidence < ROUTER_CONFIDENCE_THRESHOLD) {
    return abstain("low_confidence", "intent", {
      ...qualityEvidence("not_rejected", quality.gate.doneWhen!),
      policyRevision: POLICY_REVISION,
      intent: { value: intent.value, confidence: intent.confidence }
    });
  }

  const modifiers = modifierJudgments(response.modifiers);
  const profile = workloadProfile(intent.value, modifiers, verifiabilityLabel(quality.gate.doneWhen!.probability), input.workspaceState ?? "clean");
  const policy = resolveTierPolicy(profile, input.task.tier);

  const points = input.catalog.points ?? [];
  const pointById = new Map<string, { index: number; point: (typeof points)[number] }>();
  for (const [index, point] of points.entries()) pointById.set(point.id, { index, point });

  const fitness = fitnessJudgments(response.fitness, points);
  if (fitness === undefined) return abstain("invalid_response", "fitness");
  const scored: ScoredOperatingPoint[] = points.map((point, index) => ({
    id: point.id,
    provider: point.provider,
    costClass: point.costClass,
    latencyClass: point.latencyClass,
    fitnessByTier: fitness[index]!
  }));
  const { ordered, excluded } = rankFallbackCandidates(scored, policy.effectiveStart);
  const chainExclusions: ChainExclusion[] = [...excluded];

  // Recovery lineage lands before the bound: the failed prior point never
  // chains again, and a different provider heads the order when the failed
  // provider would otherwise lead.
  let candidates = [...ordered];
  const recovery = input.recovery;
  if (recovery !== undefined) {
    const dropped = candidates.filter((point) => point.id === recovery.priorOperatingPointId);
    candidates = candidates.filter((point) => point.id !== recovery.priorOperatingPointId);
    for (const point of dropped) chainExclusions.push({ id: point.id, provider: point.provider, reasons: ["recovery_excluded"] });
    const failedProvider = pointById.get(recovery.priorOperatingPointId)?.point.provider;
    if (failedProvider !== undefined && candidates[0]?.provider === failedProvider) {
      const alternative = candidates.findIndex((point) => point.provider !== failedProvider);
      if (alternative > 0) candidates.unshift(candidates.splice(alternative, 1)[0]!);
    }
  }
  const consumedFitness: Record<string, number> = {};
  for (const [index, point] of points.entries()) consumedFitness[point.id] = fitness[index]![policy.effectiveStart];
  const evidenceBase: RouterEvidence = {
    ...qualityEvidence("not_rejected", quality.gate.doneWhen!),
    policyRevision: POLICY_REVISION,
    intent: { value: intent.value, confidence: intent.confidence, ...(intent.probabilities === undefined ? {} : { probabilities: intent.probabilities }) },
    modifiers,
    workload: profile,
    fitness: consumedFitness
  };
  // Exclusion evidence emits in stable id order regardless of push order —
  // policy exclusions, recovery, and the admission loop all feed one set.
  const withChainExclusions = (): Pick<RouterEvidence, "chainExclusions"> =>
    chainExclusions.length === 0 ? {} : { chainExclusions: [...chainExclusions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) };
  if (candidates.length === 0) return abstain("no_candidates_at_tier", undefined, { ...evidenceBase, ...withChainExclusions() });

  const availabilityGate = input.availability ?? defaultAvailability;
  const root = input.root;
  if (root === undefined && input.availability === undefined) return abstain("transport_failed", "availability");
  const availabilityOptions: AvailabilityOptions = { root: root ?? "", ...(input.now === undefined ? {} : { now: input.now }) };

  // Each candidate is admitted in ranked order: the attempt bound, then the
  // required-resource safeguard, then the availability probe. Only an
  // admitted point consumes a bound slot, so unavailable or under-capable
  // candidates never hide a later admissible one. Runner resource answers
  // are deduped across candidates; a pool-owning runner with no map at all
  // is a malformed response, while an ambient runner's absent map is an
  // empty selection, not a failure.
  const selections = new Map<RunnerKind, CandidateSelectionResult>();
  const statuses = new Map<string, CandidateAvailability>();
  const exclusions: ResourceExclusion[] = [];
  const seenExclusions = new Set<string>();
  const chain: ScoredOperatingPoint[] = [];
  const taskText = [input.task.objective, input.task.scope, ...input.task.doneWhen, ...input.task.constraints].join("\n");
  let requiredComponent: string | undefined;
  for (const candidate of candidates) {
    if (chain.length === MAX_ATTEMPTS) {
      chainExclusions.push({ id: candidate.id, provider: candidate.provider, reasons: ["attempt_bound"] });
      continue;
    }
    const point = pointById.get(candidate.id)!.point;
    const runnerEntry = input.catalog.runners.get(point.runner);
    if (runnerEntry === undefined) return abstain("catalog_unavailable", "catalog");
    let selected = selections.get(point.runner);
    if (selected === undefined) {
      const raw = record(response.resources) ? response.resources[point.runner] : undefined;
      if (raw === undefined && POOL_FIELDS.some((field) => runnerEntry.pools[field].length > 0)) return abstain("invalid_response", "candidates");
      const parsed = resourceSelection(raw ?? {});
      if (parsed === undefined) return abstain("invalid_response", "candidates");
      selections.set(point.runner, parsed);
      selected = parsed;
    }
    for (const exclusion of selected.exclusions) {
      const key = `${exclusion.field}:${exclusion.name}`;
      if (!seenExclusions.has(key)) {
        seenExclusions.add(key);
        exclusions.push(exclusion);
      }
    }
    const dropped = selected.exclusions.find((exclusion) => requiredByTaskText(taskText, exclusion.name));
    if (dropped !== undefined) {
      requiredComponent ??= `${dropped.field}:${dropped.name}`;
      chainExclusions.push({ id: candidate.id, provider: candidate.provider, reasons: ["required_resource"] });
      continue;
    }
    let status: CandidateAvailability;
    try {
      // The availability tuple a point resolves to is its model quota key —
      // exactly what a bare `{runner, model}` candidate derives.
      status = await availabilityGate({ runner: point.runner, model: point.model }, runnerEntry, availabilityOptions);
    } catch {
      return abstain("transport_failed", "availability");
    }
    statuses.set(candidate.id, status);
    if (status.status === "known-exhausted" || status.status === "local-capacity-limited") {
      chainExclusions.push({ id: candidate.id, provider: candidate.provider, reasons: ["unavailable"] });
      continue;
    }
    chain.push(candidate);
  }

  if (chain.length === 0) {
    if (requiredComponent !== undefined) {
      return abstain("low_confidence", requiredComponent, {
        ...evidenceBase,
        ...withChainExclusions(),
        ...(statuses.size === 0 ? {} : { availability: availabilityEvidence(statuses) }),
        exclusions
      });
    }
    /* c8 ignore next 3 -- an empty candidates set returns before the loop, and every loop iteration that skips the probe also returns or sets a resource component; this guard stays for a chain emptied without probes. */
    if (statuses.size === 0) return abstain("no_candidates_at_tier", undefined, { ...evidenceBase, ...withChainExclusions() });
    const allLocal = [...statuses.values()].every((status) => status.status === "local-capacity-limited");
    return abstain(allLocal ? "transport_failed" : "no_candidates_at_tier", allLocal ? "availability" : undefined, {
      ...evidenceBase,
      ...withChainExclusions(),
      availability: availabilityEvidence(statuses)
    });
  }

  const selected = chain[0]!;
  const point = pointById.get(selected.id)!.point;
  const runner = input.catalog.runners.get(point.runner)!;
  const selectedPoint: SelectedPoint = {
    index: 0,
    id: point.id,
    runner: point.runner,
    model: point.model,
    ...(point.reasoning === undefined ? {} : { reasoning: point.reasoning })
  };
  const selection = selections.get(point.runner)!;

  const compile = input.compile ?? compileCandidateContract;
  let configuration: CompiledContract;
  try {
    configuration = await compile(input.catalog, input.spec, { index: 0, point, runner }, selection.selection);
  } catch (error) {
    if (error instanceof CompileError && ["INVALID_SELECTION", "SELECTION_OUTSIDE_POOL"].includes(error.code)) return abstain("invalid_response", "candidates");
    return abstain("catalog_unavailable", "configuration");
  }
  return {
    kind: "admitted",
    quality: "not_rejected",
    count: input.spec.count ?? 1,
    requestedTier: policy.requestedTier,
    workloadFloor: policy.adjustedFloor,
    effectiveStartTier: policy.effectiveStart,
    effectiveCeiling: policy.effectiveCeiling,
    chain: chain.map((member) => member.id),
    selectedPoint,
    configuration,
    evidence: {
      ...evidenceBase,
      ...withChainExclusions(),
      selectedPoint,
      availability: availabilityEvidence(statuses),
      ...(exclusions.length === 0 ? {} : { exclusions })
    }
  };
}
