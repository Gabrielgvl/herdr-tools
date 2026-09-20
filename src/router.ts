import { createHash } from "node:crypto";
import type { CandidateGate, Catalog, ChainCandidate, ChainResolution, ResolvedCandidate, RunnerEntry, RunnerKind } from "./catalog.js";
import { resolveChain } from "./catalog.js";
import { availability as defaultAvailability, type AvailabilityOptions, type CandidateAvailability } from "./availability.js";
import { compileCandidateContract, CompileError, type CompiledContract, type ResourceSelection } from "./compile.js";
import type { LaunchAssignment, LaunchSpec } from "./launch-schema.js";
import type { Profile } from "./profiles/types.js";

/** The old reason vocabulary is retained for every fail-closed abstention. */
export type AbstainReason =
  | "low_confidence"
  | "no_assignments"
  | "catalog_unavailable"
  | "invalid_response"
  | "authentication_unavailable"
  | "transport_failed"
  | "aborted";

/** Legacy launch compatibility; the ADR-035 policy never emits this shape. */
export interface Abstain {
  kind: "abstain";
  reason: AbstainReason;
  component?: string;
}

/** Legacy launch compatibility; retained until the B8 executor cuts over. */
export interface Assignment {
  profile: string;
  count: number;
  purpose: string;
}

/** Legacy launch compatibility; retained until the B8 executor cuts over. */
export interface RouteDecision {
  kind: "route";
  assignments: Assignment[];
}

export interface RouterCatalogEntry {
  name: string;
  description: string;
  runner: Profile["runtime"]["kind"];
  model: string;
  timeout: number;
}

/** Legacy ADR-032 state shape required by the in-flight B8 adapter. */
export interface RouterState {
  assignment: LaunchAssignment;
  catalog: RouterCatalogEntry[];
}

export const ROUTER_CONFIDENCE_THRESHOLD = 0.8;
/** B13: `missing_area` surfaces as an advisory at this probability — never a gate. */
export const COMPOSITION_ADVISORY_THRESHOLD = 0.8;

export type QualityRejectionReason = "instructions_inadequate" | "assignment_unverifiable";
export type QualityOutcome = "not_rejected" | "not_evaluated" | "rejected";

export interface RouterEvidence {
  quality?: {
    outcome: QualityOutcome;
    instructions_adequate?: number;
    assignment_verifiable?: number;
  };
  category?: { name: string; confidence: number };
  selectedCandidate?: { index: number; runner: RunnerKind; model: string };
  availability?: readonly {
    index: number;
    status: CandidateAvailability["status"];
    retryNotBefore: string | null;
  }[];
  exclusions?: readonly ResourceExclusion[];
  bypass?: {
    label: "transport-abstain" | "abstain";
    quality: QualityOutcome;
  };
}

/**
 * The B13 composition advisory (ADR-035): surfaced only when Jev's
 * `missing_area` probability reaches `COMPOSITION_ADVISORY_THRESHOLD`. It is
 * informational — it never blocks a launch, caps fan-out, or alters the
 * caller's composition.
 */
export interface CompositionAdvisory {
  /** Jev's P(a distinct contribution is missing from the assessed team). */
  missing_area: number;
  /** Spec labels of the team the assessment ran over. */
  assessed: readonly string[];
  /** Tagged when the launched team differs from the assessed team. */
  diverged: boolean;
}

export interface Admitted {
  kind: "admitted";
  /** `not_rejected` is deliberately not a certification. */
  quality: Exclude<QualityOutcome, "rejected">;
  category: string;
  count: number;
  configuration: CompiledContract;
  evidence: RouterEvidence;
  advisory?: CompositionAdvisory;
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
  /** Opaque launch-surface token issued only after a transport abstention is logged. */
  receipt?: string;
}

export type SpecDecision = Admitted | Rejected | Abstained;

/** B8's pre-cutover adapter still consumes this legacy union; new policy callers use SpecDecision. */
export type RouterResult = RouteDecision | Abstain;
export type RouterOutcome = SpecDecision;

export interface RouterBinding {
  caller: string;
  specRevision: string;
  policyRevision: string;
  launchIdentity: string;
}

export interface BypassReceipt {
  version: 1;
  kind: "bypass_receipt";
  binding: RouterBinding;
  /** A receipt can only be issued from a persisted abstention. */
  recorded: true;
  abstention: Pick<Abstained, "kind" | "reason" | "component">;
  result: Admitted;
  digest: string;
}

export interface CreateBypassReceiptInput {
  binding: RouterBinding;
  abstention: Abstained;
  configuration: CompiledContract;
  category?: string;
  count?: number;
  /** The caller must prove that the abstention was written before bypassing it. */
  recorded?: true;
  recordedAbstention?: true;
}

export interface QualityJudgment {
  instructions_adequate: unknown;
  assignment_verifiable: unknown;
}

export interface CategoryJudgment {
  category: string;
  confidence: number;
  /** The validated choice distribution, retained for decision-log evidence. */
  probabilities?: Readonly<Record<string, number>>;
}

/** One candidate's runner-qualified resource judgments after B6 normalizes Jev output. */
export interface CandidateJudgment {
  index: number;
  runner?: RunnerKind;
  model?: string;
  selection?: ResourceSelection;
  resources?: unknown;
}

/** The normalized B13 composition judgment: raw probability plus the assessed team's labels. */
export interface CompositionJudgment {
  missing_area?: unknown;
  assessed?: unknown;
}

export interface SpecModelDecision {
  quality?: QualityJudgment;
  category?: CategoryJudgment | string;
  candidates?: readonly CandidateJudgment[] | Record<string, unknown>;
  candidateSelections?: readonly CandidateJudgment[] | Record<string, unknown>;
  composition?: CompositionJudgment;
  transport?: boolean | { component?: string };
}

export type AvailabilityGate = (
  candidate: ChainCandidate,
  runner: RunnerEntry,
  options: AvailabilityOptions
) => Promise<CandidateAvailability>;
export type CompileGate = (
  catalog: Catalog,
  spec: Pick<LaunchSpec, "label">,
  resolved: ResolvedCandidate,
  selection: ResourceSelection
) => Promise<CompiledContract>;

export interface SpecRouteInput extends Partial<RouterBinding> {
  spec: LaunchSpec;
  catalog: Catalog;
  response: unknown;
  /** Trusted manager/session root used by B2. */
  root?: string;
  binding?: RouterBinding;
  availability?: AvailabilityGate;
  compile?: CompileGate;
  eligibility?: CandidateGate;
  bypass?: BypassReceipt;
  now?: () => Date;
  /** Labels of the launched team, when the caller knows them; defaults to this spec alone. */
  launched?: readonly string[];
}

export interface AssembleSpecDecisionInput {
  spec: Pick<LaunchSpec, "label" | "count"> & { category?: string };
  quality?: unknown;
  category?: CategoryJudgment | string;
  composition?: CompositionJudgment;
  configuration?: CompiledContract;
  abstention?: Abstained;
  evidence?: RouterEvidence;
  bypass?: BypassReceipt;
  binding?: RouterBinding;
  /** Labels of the launched team, when the caller knows them; defaults to this spec alone. */
  launched?: readonly string[];
}

interface ParsedBinary {
  probability: number;
  confidence: number;
}

interface QualityGateResult {
  status: "missing" | "invalid" | "not_rejected" | "rejected";
  reason?: QualityRejectionReason;
  instructions?: ParsedBinary;
  assignment?: ParsedBinary;
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

interface CandidateSelectionsResult {
  selections: Map<number, ResourceSelection>;
  exclusions: Map<number, ResourceExclusion[]>;
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

function qualityEvidence(outcome: QualityOutcome, instructions?: ParsedBinary, assignment?: ParsedBinary): RouterEvidence {
  return {
    quality: {
      outcome,
      ...(instructions === undefined ? {} : { instructions_adequate: instructions.probability }),
      ...(assignment === undefined ? {} : { assignment_verifiable: assignment.probability })
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

function qualityGate(value: unknown): QualityGateResult {
  if (!record(value)) return { status: "missing" };
  const quality = value.quality === undefined ? value : record(value.quality) ? value.quality : undefined;
  if (!quality) return { status: "invalid" };
  const instructionsRaw = quality.instructions_adequate ?? quality.instructionsAdequate;
  const assignmentRaw = quality.assignment_verifiable ?? quality.assignmentVerifiable;
  const instructions = parseBinary(instructionsRaw);
  const assignment = parseBinary(assignmentRaw);

  // Look for a confident bad answer before treating another field as invalid.
  if (instructions !== undefined && instructions.probability <= 1 - ROUTER_CONFIDENCE_THRESHOLD && instructions.confidence >= ROUTER_CONFIDENCE_THRESHOLD) {
    return { status: "rejected", reason: "instructions_inadequate", instructions, assignment };
  }
  if (assignment !== undefined && assignment.probability <= 1 - ROUTER_CONFIDENCE_THRESHOLD && assignment.confidence >= ROUTER_CONFIDENCE_THRESHOLD) {
    return { status: "rejected", reason: "assignment_unverifiable", instructions, assignment };
  }
  if (instructions === undefined || assignment === undefined) return { status: "invalid" };
  return { status: "not_rejected", instructions, assignment };
}

function categoryJudgment(value: unknown, spec: { category?: string }): CategoryJudgment | undefined {
  if (value === undefined && spec.category !== undefined) return { category: spec.category, confidence: 1 };
  if (typeof value === "string") return { category: value, confidence: 1 };
  if (!record(value)) return undefined;
  const categoryValue = value.category ?? value.choice ?? value.name ?? value.value;
  const confidence = value.confidence ?? value.probability;
  if (!bounded(categoryValue) || !finiteProbability(confidence)) return undefined;
  return { category: categoryValue, confidence };
}

function categoryFromResponse(response: Record<string, unknown>, spec: Pick<LaunchSpec, "category">): CategoryJudgment | undefined {
  const raw = response.category ?? response.categoryChoice ?? (record(response.routing) ? response.routing.category : undefined);
  return categoryJudgment(raw, spec);
}

/**
 * B13 advisory assembly: parses the raw `composition` judgment leniently and
 * surfaces it only at `missing_area` ≥ 0.8. `launched` is the caller-asserted
 * launched team (spec labels); absent, it is the spec this decision admits.
 * The flag is advisory — a malformed judgment yields no advisory, never an
 * abstention, so it cannot alter the launch outcome.
 */
function compositionAdvisory(value: unknown, launched: readonly string[]): CompositionAdvisory | undefined {
  if (!record(value) || !finiteProbability(value.missing_area)) return undefined;
  if (value.missing_area < COMPOSITION_ADVISORY_THRESHOLD) return undefined;
  const assessed = Array.isArray(value.assessed) ? value.assessed.filter((member): member is string => typeof member === "string") : [];
  return {
    missing_area: value.missing_area,
    assessed,
    diverged: [...assessed].sort().join(" ") !== [...launched].sort().join(" "),
  };
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

function candidateEntries(response: Record<string, unknown>): readonly unknown[] | Record<string, unknown> | undefined {
  const value = response.candidates ?? response.candidateSelections ?? response.selections;
  if (Array.isArray(value) || record(value)) return value;
  return undefined;
}

function candidateEntryFor(entries: readonly unknown[] | Record<string, unknown>, index: number): unknown {
  if (Array.isArray(entries)) {
    return entries.find((entry) => record(entry) && entry.index === index);
  }
  return (entries as Record<string, unknown>)[String(index)];
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

function candidateSelection(value: Record<string, unknown>): CandidateSelectionResult | undefined {
  const raw = record(value.selection) ? value.selection : record(value.resources) ? value.resources : value;
  const selection: ResourceSelection = {};
  const exclusions: ResourceExclusion[] = [];
  for (const field of POOL_FIELDS) {
    const parsed = selectionForField(raw[field], field);
    if (parsed === undefined) return undefined;
    if (parsed.names.length > 0) selection[field] = parsed.names;
    exclusions.push(...parsed.exclusions);
  }
  return { selection, exclusions };
}

function candidateSelections(response: Record<string, unknown>, chain: readonly ChainCandidate[]): CandidateSelectionsResult | undefined {
  const entries = candidateEntries(response);
  if (entries === undefined) return undefined;
  const selections = new Map<number, ResourceSelection>();
  const exclusions = new Map<number, ResourceExclusion[]>();
  for (let index = 0; index < chain.length; index += 1) {
    const entry = candidateEntryFor(entries, index);
    if (!record(entry)) return undefined;
    if (entry.runner !== undefined && entry.runner !== chain[index]!.runner) return undefined;
    if (entry.model !== undefined && entry.model !== chain[index]!.model) return undefined;
    const parsed = candidateSelection(entry);
    if (parsed === undefined) return undefined;
    selections.set(index, parsed.selection);
    exclusions.set(index, parsed.exclusions);
  }
  return { selections, exclusions };
}

/** Only explicit requirements are derivable from free-form instructions. */
function requiredByInstructions(instructions: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mention = new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}(?=$|[^A-Za-z0-9_])`, "i");
  return instructions.split(/[\n.!?;]+/u).some((clause) => {
    if (!mention.test(clause) || /\b(?:do not|don't|must not|should not|never|without|avoid|optional|may|can|could|not required|not necessary|not needed|not use)\b/i.test(clause)) return false;
    return /\b(?:must|required|requires|require|needs|need|necessary|essential)\b/i.test(clause) || /^\s*(?:use|call|run|invoke|execute)\b/i.test(clause);
  });
}

function outcomeBinding(input: SpecRouteInput): RouterBinding | undefined {
  if (input.binding !== undefined) return input.binding;
  const { caller, specRevision, policyRevision, launchIdentity } = input;
  if (!bounded(caller) || !bounded(specRevision) || !bounded(policyRevision) || !bounded(launchIdentity)) return undefined;
  return { caller, specRevision, policyRevision, launchIdentity };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function receiptDigest(receipt: Omit<BypassReceipt, "digest">): string {
  return digest({
    version: receipt.version,
    kind: receipt.kind,
    binding: receipt.binding,
    recorded: receipt.recorded,
    abstention: receipt.abstention,
    result: receipt.result
  });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertBinding(binding: unknown): asserts binding is RouterBinding {
  if (!record(binding) || !bounded(binding.caller) || !bounded(binding.specRevision) || !bounded(binding.policyRevision) || !bounded(binding.launchIdentity)) {
    throw new Error("invalid bypass binding");
  }
}

/** Create a replayable bypass only from a recorded transport abstention. */
export function createBypassReceipt(input: CreateBypassReceiptInput): BypassReceipt {
  if (input.abstention.kind !== "abstained" || input.abstention.reason !== "transport_failed" || (input.recorded !== true && input.recordedAbstention !== true)) {
    throw new Error("bypass receipts require a recorded transport abstention");
  }
  assertBinding(input.binding);
  const category = input.category ?? input.configuration.specLabel;
  const evidence: RouterEvidence = {
    quality: { outcome: "not_evaluated" },
    category: { name: category, confidence: 1 },
    selectedCandidate: { index: input.configuration.candidate.index, runner: input.configuration.candidate.runner, model: input.configuration.candidate.model },
    bypass: { label: "transport-abstain", quality: "not_evaluated" }
  };
  const result: Admitted = {
    kind: "admitted",
    quality: "not_evaluated",
    category,
    count: input.count ?? 1,
    configuration: clone(input.configuration),
    evidence
  };
  const unsigned = {
    version: 1 as const,
    kind: "bypass_receipt" as const,
    binding: clone(input.binding),
    recorded: true as const,
    abstention: {
      kind: "abstained" as const,
      reason: "transport_failed" as const,
      ...(input.abstention.component === undefined ? {} : { component: input.abstention.component })
    },
    result
  };
  return { ...unsigned, digest: receiptDigest(unsigned) };
}

/** Verify the binding and return the frozen result; replay never re-runs Jev. */
export function replayBypassReceipt(receipt: BypassReceipt, binding: RouterBinding): Admitted {
  assertBinding(binding);
  if (!record(receipt) || receipt.version !== 1 || receipt.kind !== "bypass_receipt" || receipt.recorded !== true) throw new Error("invalid bypass receipt");
  assertBinding(receipt.binding);
  if (JSON.stringify(receipt.binding) !== JSON.stringify(binding)) throw new Error("bypass receipt binding mismatch");
  const unsigned = {
    version: receipt.version,
    kind: receipt.kind,
    binding: receipt.binding,
    recorded: receipt.recorded,
    abstention: receipt.abstention,
    result: receipt.result
  } as Omit<BypassReceipt, "digest">;
  const evidence = record(receipt.result) && record(receipt.result.evidence) ? receipt.result.evidence : undefined;
  const quality = record(evidence) && record(evidence.quality) ? evidence.quality : undefined;
  const bypass = record(evidence) && record(evidence.bypass) ? evidence.bypass : undefined;
  if (
    receipt.digest !== receiptDigest(unsigned) ||
    !record(receipt.abstention) ||
    receipt.abstention.kind !== "abstained" ||
    receipt.abstention.reason !== "transport_failed" ||
    !record(receipt.result) ||
    receipt.result.kind !== "admitted" ||
    receipt.result.quality !== "not_evaluated" ||
    !record(quality) ||
    quality.outcome !== "not_evaluated" ||
    !record(bypass) ||
    bypass.label !== "transport-abstain" ||
    bypass.quality !== "not_evaluated"
  ) throw new Error("invalid bypass receipt");
  return clone(receipt.result);
}

function rejected(reason: QualityRejectionReason, gate: QualityGateResult): Rejected {
  return {
    kind: "rejected",
    quality: "rejected",
    reason,
    evidence: qualityEvidence("rejected", gate.instructions, gate.assignment)
  };
}

function qualityDecision(value: unknown): { gate: QualityGateResult; result?: Rejected | Abstained } {
  const gate = qualityGate(value);
  if (gate.status === "rejected") return { gate, result: rejected(gate.reason!, gate) };
  if (gate.status === "invalid") return { gate, result: abstain("invalid_response", "quality") };
  return { gate };
}

function validCategory(category: CategoryJudgment | undefined): category is CategoryJudgment {
  return category !== undefined && bounded(category.category) && finiteProbability(category.confidence);
}

/**
 * Pure final assembly. It contains no model call, launch, or filesystem work:
 * quality rejection is checked before every abstention and a successful quality
 * gate is recorded as `not_rejected`, never as a certification.
 */
export function assembleSpecDecision(input: AssembleSpecDecisionInput): SpecDecision {
  const quality = qualityDecision(input.quality);
  if (quality.result?.kind === "rejected") return quality.result;
  if (quality.result?.kind === "abstained") return quality.result;
  if (input.bypass !== undefined) {
    const binding = input.binding;
    if (binding === undefined) return abstain("invalid_response", "bypass");
    try {
      return replayBypassReceipt(input.bypass, binding);
    } catch {
      return abstain("invalid_response", "bypass");
    }
  }
  if (input.abstention !== undefined) return input.abstention;
  if (input.configuration === undefined) return abstain("invalid_response", "configuration");
  const category = categoryJudgment(input.category, input.spec);
  if (!validCategory(category)) return abstain("invalid_response", "category");
  if (category.confidence < ROUTER_CONFIDENCE_THRESHOLD) return abstain("low_confidence", "category");
  const gate = quality.gate;
  const qualityEvidenceValue = gate.status === "missing" ? "not_evaluated" : "not_rejected";
  const advisory = compositionAdvisory(input.composition, input.launched ?? [input.spec.label]);
  return {
    kind: "admitted",
    quality: qualityEvidenceValue,
    category: category.category,
    count: input.spec.count ?? 1,
    configuration: input.configuration,
    ...(advisory === undefined ? {} : { advisory }),
    evidence: {
      ...(qualityEvidenceValue === "not_rejected" ? qualityEvidence("not_rejected", gate.instructions, gate.assignment) : { quality: { outcome: "not_evaluated" as const } }),
      category: { name: category.category, confidence: category.confidence },
      ...(input.evidence ?? {})
    }
  };
}

/** Every chain index is probed in order above, so the statuses map mirrors the chain. */
function resolutionEvidence(statuses: Map<number, CandidateAvailability>): RouterEvidence["availability"] {
  return [...statuses.entries()].map(([index, value]) => ({
    index,
    status: value.status,
    retryNotBefore: value.retryNotBefore ?? null
  }));
}

/**
 * Per-spec policy orchestration. The only side effects are the injected B2
 * availability reads and B4 compilation; Jev and launch remain outside this
 * module. One normalized response covers the complete chain, so fallback does
 * not trigger another model call.
 */
export async function routeSpec(input: SpecRouteInput): Promise<SpecDecision> {
  const quality = qualityDecision(input.response);
  if (quality.result?.kind === "rejected") return quality.result;
  if (quality.result?.kind === "abstained") return quality.result;

  const binding = outcomeBinding(input);
  const transport = transportComponent(input.response);
  if (input.bypass !== undefined) {
    if (binding === undefined) return abstain("invalid_response", "bypass");
    try {
      return replayBypassReceipt(input.bypass, binding);
    } catch {
      return abstain("invalid_response", "bypass");
    }
  }
  if (quality.gate.status === "missing") return abstain("invalid_response", "quality");
  if (transport !== undefined) return abstain("transport_failed", transport);

  // Past the quality gate the response is a record; the helpers take it typed.
  const response = input.response as Record<string, unknown>;
  const category = categoryFromResponse(response, input.spec);
  if (!validCategory(category)) return abstain("invalid_response", "category");
  if (category.confidence < ROUTER_CONFIDENCE_THRESHOLD) return abstain("low_confidence", "category");

  let chain: readonly ChainCandidate[];
  try {
    chain = input.catalog.categories.get(category.category) ?? [];
    if (chain.length === 0) return abstain("invalid_response", "category");
  } catch {
    return abstain("catalog_unavailable", "catalog");
  }
  const selections = candidateSelections(response, chain);
  if (selections === undefined) return abstain("invalid_response", "candidates");

  const statuses = new Map<number, CandidateAvailability>();
  const availabilityGate = input.availability ?? defaultAvailability;
  const root = input.root;
  if (root === undefined && input.availability === undefined) return abstain("transport_failed", "availability");
  const availabilityOptions: AvailabilityOptions = { root: root ?? "", ...(input.now === undefined ? {} : { now: input.now }) };
  // The resolver is intentionally runner-name-blind: each exact chain
  // candidate is handed to B2 together with its runner entry, and only the
  // returned admission status is consumed by the policy.
  for (const [index, candidate] of chain.entries()) {
    const runner = input.catalog.runners.get(candidate.runner);
    if (runner === undefined) return abstain("catalog_unavailable", "catalog");
    let status: CandidateAvailability;
    try {
      status = await availabilityGate(candidate, runner, availabilityOptions);
    } catch {
      return abstain("transport_failed", "availability");
    }
    statuses.set(index, status);
  }
  let resolution: ChainResolution;
  try {
    resolution = resolveChain(
      input.catalog,
      category.category,
      input.eligibility ?? (() => true),
      (candidate) => {
        const index = chain.indexOf(candidate);
        const status = statuses.get(index);
        return status === undefined || (status.status !== "known-exhausted" && status.status !== "local-capacity-limited");
      }
    );
  } catch {
    return abstain("catalog_unavailable", "catalog");
  }
  if (resolution.selected === undefined) {
    const allLocal = chain.length > 0 && chain.every((_, index) => statuses.get(index)?.status === "local-capacity-limited");
    return abstain(allLocal ? "transport_failed" : "no_assignments", allLocal ? "availability" : undefined, {
      ...qualityEvidence("not_rejected", quality.gate.instructions, quality.gate.assignment),
      category: { name: category.category, confidence: category.confidence },
      availability: resolutionEvidence(statuses)
    });
  }

  const selectedExclusions = selections.exclusions.get(resolution.selected.index)!;
  const requiredExclusion = selectedExclusions.find((exclusion) => requiredByInstructions(input.spec.instructions, exclusion.name));
  if (requiredExclusion !== undefined) {
    return abstain("low_confidence", `${requiredExclusion.field}:${requiredExclusion.name}`, {
      ...qualityEvidence("not_rejected", quality.gate.instructions, quality.gate.assignment),
      category: { name: category.category, confidence: category.confidence },
      selectedCandidate: { index: resolution.selected.index, runner: resolution.selected.candidate.runner, model: resolution.selected.candidate.model },
      availability: resolutionEvidence(statuses),
      exclusions: selectedExclusions
    });
  }

  const compile = input.compile ?? compileCandidateContract;
  let configuration: CompiledContract;
  try {
    // `candidateSelections` stored a selection for every chain index.
    configuration = await compile(input.catalog, input.spec, resolution.selected, selections.selections.get(resolution.selected.index)!);
  } catch (error) {
    if (error instanceof CompileError && ["INVALID_SELECTION", "SELECTION_OUTSIDE_POOL"].includes(error.code)) return abstain("invalid_response", "candidates");
    return abstain("catalog_unavailable", "configuration");
  }
  const advisory = compositionAdvisory(response.composition, input.launched ?? [input.spec.label]);
  return {
    kind: "admitted",
    quality: "not_rejected",
    category: category.category,
    count: input.spec.count ?? 1,
    configuration,
    ...(advisory === undefined ? {} : { advisory }),
    evidence: {
      ...qualityEvidence("not_rejected", quality.gate.instructions, quality.gate.assignment),
      category: { name: category.category, confidence: category.confidence },
      selectedCandidate: { index: resolution.selected.index, runner: resolution.selected.candidate.runner, model: resolution.selected.candidate.model },
      availability: resolutionEvidence(statuses),
      ...(selectedExclusions.length === 0 ? {} : { exclusions: selectedExclusions })
    }
  };
}

/** Stable aliases make the policy seam explicit to the B6 client and B8 executor. */
export const decideSpec = routeSpec;
export const assembleDecision = assembleSpecDecision;

