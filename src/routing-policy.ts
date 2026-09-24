/**
 * Deterministic workload/tier routing policy (ADR-037). This module is a
 * pure leaf: no imports, no I/O, no catalog or runtime dependencies. Every
 * input arrives as a typed value from the caller; recovery evidence that
 * cannot be resolved fails closed with a typed error instead of a guess.
 */

/** Policy revision recorded in decision evidence. */
export const POLICY_REVISION = "adr-037-p4";

/**
 * The caller's requested starting quality and compute posture, in ascending
 * order: `utility < economy < standard < strong < frontier < max`.
 * Omission resolves to `standard`.
 */
export const QUALITY_TIERS = ["utility", "economy", "standard", "strong", "frontier", "max"] as const;
export type QualityTier = (typeof QUALITY_TIERS)[number];

/** Position of a tier in the total order. */
export function tierRank(tier: QualityTier): number {
  return QUALITY_TIERS.indexOf(tier);
}

/** Signed order comparison: negative when `a` is the weaker tier. */
export function compareTiers(a: QualityTier, b: QualityTier): number {
  return tierRank(a) - tierRank(b);
}

/** The stronger of two tiers. */
export function maxTier(a: QualityTier, b: QualityTier): QualityTier {
  return compareTiers(a, b) >= 0 ? a : b;
}

/** The next stronger tier; `max` stays `max`. */
export function nextTier(tier: QualityTier): QualityTier {
  return QUALITY_TIERS[Math.min(tierRank(tier) + 1, QUALITY_TIERS.length - 1)];
}

/** The tier `rank` steps above `utility`, clamped at `max`. */
function tierAt(rank: number): QualityTier {
  return QUALITY_TIERS[Math.min(rank, QUALITY_TIERS.length - 1)];
}

export type CostClass = "low" | "medium" | "high" | "extreme";
export type LatencyClass = "low" | "medium" | "high" | "extreme";

/** Envelope bound: a class ceiling, or `unbounded` for the `max` tier. */
export type ClassBound = CostClass | "unbounded";

/** Class order `low < medium < high < extreme`. */
const CLASS_RANK: Record<CostClass, number> = { low: 0, medium: 1, high: 2, extreme: 3 };

function boundRank(bound: ClassBound): number {
  return bound === "unbounded" ? CLASS_RANK.extreme + 1 : CLASS_RANK[bound];
}

/** Per-tier admission envelope: the strongest cost and latency classes a point may carry. */
export interface TierEnvelope {
  readonly maxCostClass: ClassBound;
  readonly maxLatencyClass: ClassBound;
}

export const TIER_ENVELOPES: Readonly<Record<QualityTier, TierEnvelope>> = {
  utility: { maxCostClass: "low", maxLatencyClass: "low" },
  economy: { maxCostClass: "low", maxLatencyClass: "medium" },
  standard: { maxCostClass: "medium", maxLatencyClass: "medium" },
  strong: { maxCostClass: "high", maxLatencyClass: "high" },
  frontier: { maxCostClass: "extreme", maxLatencyClass: "extreme" },
  max: { maxCostClass: "unbounded", maxLatencyClass: "unbounded" }
};

export type WorkloadIntent = "explore" | "reason" | "implement" | "debug" | "verify" | "review" | "coordinate" | "unknown";
export type WorkloadMutation = "none" | "bounded" | "broad";
export type WorkloadScope = "local" | "multi_file" | "repo_wide";
export type WorkloadHorizon = "short" | "medium" | "long";
export type WorkloadVerifiability = "strong" | "partial" | "weak";
export type WorkspaceState = "clean" | "partial" | "failed";
export type WorkloadAmbiguity = "low" | "medium" | "high";

/** The runtime-derived workload shape; every field is a closed union. */
export interface WorkloadProfile {
  readonly intent: WorkloadIntent;
  readonly mutation: WorkloadMutation;
  readonly scope: WorkloadScope;
  readonly horizon: WorkloadHorizon;
  readonly verifiability: WorkloadVerifiability;
  readonly workspaceState: WorkspaceState;
  readonly ambiguity: WorkloadAmbiguity;
}

/** The base admission floor and recovery ceiling each intent supplies. */
export const INTENT_TIER_INTERVALS: Readonly<Record<WorkloadIntent, { readonly floor: QualityTier; readonly ceiling: QualityTier }>> = {
  explore: { floor: "utility", ceiling: "standard" },
  reason: { floor: "economy", ceiling: "frontier" },
  implement: { floor: "standard", ceiling: "frontier" },
  debug: { floor: "standard", ceiling: "max" },
  verify: { floor: "utility", ceiling: "standard" },
  review: { floor: "standard", ceiling: "frontier" },
  coordinate: { floor: "standard", ceiling: "frontier" },
  unknown: { floor: "standard", ceiling: "max" }
};

/**
 * Difficult semantic modifiers. Each raises the admission floor and the base
 * recovery ceiling by one tier; weak verifiability is not a modifier.
 */
export type DifficultModifier =
  | "mutation_broad"
  | "scope_repo_wide"
  | "horizon_long"
  | "ambiguity_high"
  | "workspace_state_partial"
  | "workspace_state_failed";

function difficultModifiers(profile: WorkloadProfile): DifficultModifier[] {
  const modifiers: DifficultModifier[] = [];
  if (profile.mutation === "broad") modifiers.push("mutation_broad");
  if (profile.scope === "repo_wide") modifiers.push("scope_repo_wide");
  if (profile.horizon === "long") modifiers.push("horizon_long");
  if (profile.ambiguity === "high") modifiers.push("ambiguity_high");
  if (profile.workspaceState === "partial") modifiers.push("workspace_state_partial");
  if (profile.workspaceState === "failed") modifiers.push("workspace_state_failed");
  return modifiers;
}

/**
 * The resolved tier interval for one workload: the intent base shifted by
 * each difficult modifier, the requested tier applied as the start
 * preference, and the ceiling lifted to at least the effective start.
 */
export interface WorkloadTierPolicy {
  readonly requestedTier: QualityTier;
  readonly baseFloor: QualityTier;
  readonly baseCeiling: QualityTier;
  readonly difficultModifiers: readonly DifficultModifier[];
  readonly adjustedFloor: QualityTier;
  readonly adjustedCeiling: QualityTier;
  readonly effectiveStart: QualityTier;
  readonly effectiveCeiling: QualityTier;
}

/**
 * Compute the effective tier interval. The floor is the intent base plus one
 * tier per difficult modifier, capped at `max`. The ceiling is the intent
 * base plus the same modifiers — `max` outright on a failed workspace — then
 * lifted to the effective start when the adjusted floor or requested tier
 * would exceed it. `effectiveStart = max(requested ?? "standard", floor)`.
 */
export function resolveTierPolicy(profile: WorkloadProfile, requestedTier?: QualityTier): WorkloadTierPolicy {
  const requested = requestedTier ?? "standard";
  const base = INTENT_TIER_INTERVALS[profile.intent];
  const modifiers = difficultModifiers(profile);
  const adjustedFloor = tierAt(tierRank(base.floor) + modifiers.length);
  const adjustedCeiling = profile.workspaceState === "failed" ? "max" : tierAt(tierRank(base.ceiling) + modifiers.length);
  const effectiveStart = maxTier(requested, adjustedFloor);
  return {
    requestedTier: requested,
    baseFloor: base.floor,
    baseCeiling: base.ceiling,
    difficultModifiers: modifiers,
    adjustedFloor,
    adjustedCeiling,
    effectiveStart,
    effectiveCeiling: maxTier(adjustedCeiling, effectiveStart)
  };
}

/**
 * Recovery start tier: folded into the router's Task admission (the lifted
 * RoutingTask carries the prior route tier; `maxTier(effectiveStart,
 * nextTier(prior))` applies there).
 */

export type RoutingPolicyErrorCode = "RECOVERY_SOURCE_UNRESOLVABLE";

/** Typed fail-closed policy failure. */
export class RoutingPolicyError extends Error {
  readonly details: Record<string, unknown>;

  constructor(readonly code: RoutingPolicyErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(`${code}: ${message}`);
    this.name = "RoutingPolicyError";
    this.details = details;
  }
}

/** Prior-run evidence resolved from the managed handoff run named by `recoveryOf`. */
export interface RecoveryEvidence {
  readonly lifecycle: string;
  readonly artifactStatus?: string;
}

const MAX_EVIDENCE_STRING = 128;

function bounded(value: unknown): string {
  return typeof value === "string" ? [...value].slice(0, MAX_EVIDENCE_STRING).join("") : typeof value;
}

/**
 * The artifact statuses that count as terminal evidence on a `handed_off`
 * run: the child finished and can no longer write to its workspace.
 */
const TERMINAL_ARTIFACT_STATUSES: ReadonlySet<string> = new Set(["done", "blocked", "cancelled", "failed"]);

/**
 * Derive the workload `workspaceState` from recovery evidence. No recovery
 * input means a clean workspace. Only terminal prior-run evidence resolves:
 * `failed`/`cancelled` lifecycles mean `failed`; `recovery_pending` (the
 * dead host's unresolved run) means `partial` — `failed` when its artifact
 * also failed; `handed_off` resolves only when a terminal artifact record
 * accompanies it, `failed` when that record is `failed`. `awaiting_handoff`,
 * a bare `handed_off` mark, and anything foreign may still have a live
 * writer over the workspace, so they throw rather than guess.
 */
export function deriveWorkspaceState(recovery?: RecoveryEvidence | null): WorkspaceState {
  if (recovery === undefined) return "clean";
  const lifecycle = recovery?.lifecycle;
  const artifactStatus = recovery?.artifactStatus;
  if (lifecycle === "failed" || lifecycle === "cancelled") return "failed";
  if (lifecycle === "recovery_pending") return artifactStatus === "failed" ? "failed" : "partial";
  if (lifecycle === "handed_off" && artifactStatus !== undefined && TERMINAL_ARTIFACT_STATUSES.has(artifactStatus)) {
    return artifactStatus === "failed" ? "failed" : "clean";
  }
  throw new RoutingPolicyError("RECOVERY_SOURCE_UNRESOLVABLE", "recovery evidence does not prove a terminal prior run", {
    lifecycle: bounded(lifecycle),
    ...(artifactStatus === undefined ? {} : { artifactStatus: bounded(artifactStatus) })
  });
}

/** A statically scored operating point: reviewed classes plus one fitness value per tier. */
export interface ScoredOperatingPoint {
  readonly id: string;
  readonly provider: string;
  readonly costClass: CostClass;
  readonly latencyClass: LatencyClass;
  readonly fitnessByTier: Readonly<Record<QualityTier, number>>;
}

/** The pre-execution fallback bound. */
export const MAX_ATTEMPTS = 4;

export type ChainExclusionReason =
  | "cost_class_exceeded"
  | "latency_class_exceeded"
  | "attempt_bound"
  | "unavailable"
  | "required_resource"
  | "recovery_excluded";

/** Deterministic evidence for a point kept out of the chain. */
export interface ChainExclusion {
  readonly id: string;
  readonly provider: string;
  readonly reasons: readonly ChainExclusionReason[];
}

/**
 * The full fitness-ranked admissible ordering plus the exclusion evidence
 * for every input point left out of it. The caller applies the attempt
 * bound after admission filters so bound slots go only to candidates that
 * can actually start.
 */
export interface RankedCandidates {
  readonly ordered: readonly ScoredOperatingPoint[];
  readonly excluded: readonly ChainExclusion[];
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Rank the admissible candidate order for the effective tier. Points outside
 * the tier envelope are excluded with evidence. The rest rank by that
 * tier's fitness — a ranking signal only, so uniformly low fitness still
 * ranks — with the best-ranked point of each provider first in fitness
 * order, then the remainder by fitness, and ascending `id` as the final
 * tie-break. The ordering is unbounded: admission filters and the
 * `MAX_ATTEMPTS` bound are applied by the caller over this ranked order.
 */
export function rankFallbackCandidates(points: readonly ScoredOperatingPoint[], effectiveTier: QualityTier): RankedCandidates {
  const envelope = TIER_ENVELOPES[effectiveTier];
  const eligible: ScoredOperatingPoint[] = [];
  const excluded: ChainExclusion[] = [];
  for (const point of points) {
    const reasons: ChainExclusionReason[] = [];
    if (boundRank(envelope.maxCostClass) < CLASS_RANK[point.costClass]) reasons.push("cost_class_exceeded");
    if (boundRank(envelope.maxLatencyClass) < CLASS_RANK[point.latencyClass]) reasons.push("latency_class_exceeded");
    if (reasons.length === 0) eligible.push(point);
    else excluded.push({ id: point.id, provider: point.provider, reasons });
  }
  const ranked = [...eligible].sort((a, b) => b.fitnessByTier[effectiveTier] - a.fitnessByTier[effectiveTier] || compareIds(a.id, b.id));
  const ordered: ScoredOperatingPoint[] = [];
  const chosen = new Set<string>();
  const providers = new Set<string>();
  for (const point of ranked) {
    if (providers.has(point.provider)) continue;
    ordered.push(point);
    chosen.add(point.id);
    providers.add(point.provider);
  }
  for (const point of ranked) {
    if (chosen.has(point.id)) continue;
    ordered.push(point);
    chosen.add(point.id);
  }
  excluded.sort((a, b) => compareIds(a.id, b.id));
  return { ordered, excluded };
}
