import { describe, expect, it } from "vitest";
import {
  INTENT_TIER_INTERVALS,
  MAX_ATTEMPTS,
  POLICY_REVISION,
  QUALITY_TIERS,
  RoutingPolicyError,
  TIER_ENVELOPES,
  compareTiers,
  deriveWorkspaceState,
  maxTier,
  nextTier,
  rankFallbackCandidates,
  resolveTierPolicy,
  tierRank,
  type CostClass,
  type LatencyClass,
  type QualityTier,
  type RecoveryEvidence,
  type ScoredOperatingPoint,
  type WorkloadProfile
} from "../../src/routing-policy.js";

function profile(overrides: Partial<WorkloadProfile> = {}): WorkloadProfile {
  return {
    intent: "implement",
    mutation: "none",
    scope: "local",
    horizon: "short",
    verifiability: "strong",
    workspaceState: "clean",
    ambiguity: "low",
    ...overrides
  };
}

function point(id: string, provider: string, costClass: CostClass, latencyClass: LatencyClass, fitness: number | Partial<Record<QualityTier, number>>): ScoredOperatingPoint {
  const fitnessByTier = (
    typeof fitness === "number" ? { utility: fitness, economy: fitness, standard: fitness, strong: fitness, frontier: fitness, max: fitness } : { utility: 0, economy: 0, standard: 0, strong: 0, frontier: 0, max: 0, ...fitness }
  ) as Record<QualityTier, number>;
  return { id, provider, costClass, latencyClass, fitnessByTier };
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  expect.unreachable("expected a routing-policy failure");
}

describe("policy revision", () => {
  it("stamps the ADR-037 p2 revision", () => {
    expect(POLICY_REVISION).toBe("adr-037-p2");
  });
});

describe("tier order", () => {
  it("orders utility < economy < standard < strong < frontier < max", () => {
    expect(QUALITY_TIERS).toEqual(["utility", "economy", "standard", "strong", "frontier", "max"]);
    expect(QUALITY_TIERS.map(tierRank)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(compareTiers("economy", "strong")).toBeLessThan(0);
    expect(compareTiers("frontier", "standard")).toBeGreaterThan(0);
    expect(compareTiers("standard", "standard")).toBe(0);
  });

  it("picks the stronger tier and the next tier, with max staying max", () => {
    expect(maxTier("utility", "frontier")).toBe("frontier");
    expect(maxTier("max", "economy")).toBe("max");
    expect(maxTier("standard", "standard")).toBe("standard");
    expect(nextTier("utility")).toBe("economy");
    expect(nextTier("frontier")).toBe("max");
    expect(nextTier("max")).toBe("max");
  });
});

describe("tier envelopes", () => {
  it("matches the ADR envelope table", () => {
    expect(TIER_ENVELOPES).toEqual({
      utility: { maxCostClass: "low", maxLatencyClass: "low" },
      economy: { maxCostClass: "low", maxLatencyClass: "medium" },
      standard: { maxCostClass: "medium", maxLatencyClass: "medium" },
      strong: { maxCostClass: "high", maxLatencyClass: "high" },
      frontier: { maxCostClass: "extreme", maxLatencyClass: "extreme" },
      max: { maxCostClass: "unbounded", maxLatencyClass: "unbounded" }
    });
  });
});

describe("resolveTierPolicy", () => {
  it.each([
    ["explore", "utility", "standard"],
    ["reason", "economy", "frontier"],
    ["implement", "standard", "frontier"],
    ["debug", "standard", "max"],
    ["verify", "utility", "standard"],
    ["review", "standard", "frontier"],
    ["coordinate", "standard", "frontier"]
  ] as const)("gives %s the base interval %s..%s", (intent, floor, ceiling) => {
    const policy = resolveTierPolicy(profile({ intent }));
    expect(policy).toMatchObject({ baseFloor: floor, baseCeiling: ceiling, adjustedFloor: floor, adjustedCeiling: ceiling, difficultModifiers: [] });
    expect(INTENT_TIER_INTERVALS[intent]).toEqual({ floor, ceiling });
  });

  it("defaults an omitted request to standard and applies the floor when it is stronger", () => {
    expect(resolveTierPolicy(profile({ intent: "verify" }))).toMatchObject({ requestedTier: "standard", effectiveStart: "standard", effectiveCeiling: "standard" });
    expect(resolveTierPolicy(profile({ intent: "implement" }), "utility")).toMatchObject({ requestedTier: "utility", effectiveStart: "standard" });
    expect(resolveTierPolicy(profile({ intent: "implement" }), "strong")).toMatchObject({ effectiveStart: "strong" });
  });

  it.each([
    [{ mutation: "broad" }, "mutation_broad"],
    [{ scope: "repo_wide" }, "scope_repo_wide"],
    [{ horizon: "long" }, "horizon_long"],
    [{ ambiguity: "high" }, "ambiguity_high"],
    [{ workspaceState: "partial" }, "workspace_state_partial"],
    [{ workspaceState: "failed" }, "workspace_state_failed"]
  ] as const)("raises the floor one tier for %o", (overrides, modifier) => {
    const policy = resolveTierPolicy(profile({ intent: "explore", ...overrides }));
    expect(policy.adjustedFloor).toBe("economy");
    expect(policy.difficultModifiers).toEqual([modifier]);
  });

  it("accumulates modifiers and caps the floor at max", () => {
    const two = resolveTierPolicy(profile({ intent: "explore", mutation: "broad", scope: "repo_wide" }));
    expect(two).toMatchObject({ adjustedFloor: "standard", difficultModifiers: ["mutation_broad", "scope_repo_wide"] });
    const all = resolveTierPolicy(profile({ intent: "implement", mutation: "broad", scope: "repo_wide", horizon: "long", ambiguity: "high", workspaceState: "partial" }));
    expect(all).toMatchObject({ adjustedFloor: "max", effectiveStart: "max", effectiveCeiling: "max" });
    expect(all.difficultModifiers).toEqual(["mutation_broad", "scope_repo_wide", "horizon_long", "ambiguity_high", "workspace_state_partial"]);
  });

  it("adds nothing for weak verifiability", () => {
    const policy = resolveTierPolicy(profile({ intent: "verify", verifiability: "weak" }));
    expect(policy).toMatchObject({ adjustedFloor: "utility", adjustedCeiling: "standard", difficultModifiers: [] });
  });

  it("raises the base ceiling one tier per modifier and to max on a failed workspace", () => {
    expect(resolveTierPolicy(profile({ intent: "explore", mutation: "broad" })).adjustedCeiling).toBe("strong");
    expect(resolveTierPolicy(profile({ intent: "verify", mutation: "broad", horizon: "long" })).adjustedCeiling).toBe("frontier");
    const failed = resolveTierPolicy(profile({ intent: "verify", workspaceState: "failed" }));
    expect(failed).toMatchObject({ adjustedFloor: "economy", adjustedCeiling: "max", effectiveCeiling: "max" });
  });

  it("lifts the effective ceiling to the effective start when the requested tier exceeds it", () => {
    const policy = resolveTierPolicy(profile({ intent: "verify" }), "frontier");
    expect(policy).toMatchObject({ requestedTier: "frontier", adjustedFloor: "utility", adjustedCeiling: "standard", effectiveStart: "frontier", effectiveCeiling: "frontier" });
  });
});

describe("deriveWorkspaceState", () => {
  it("derives clean without recovery input", () => {
    expect(deriveWorkspaceState()).toBe("clean");
  });

  it("derives partial from recovery_pending", () => {
    expect(deriveWorkspaceState({ lifecycle: "recovery_pending" })).toBe("partial");
  });

  it.each(["failed", "cancelled"] as const)("derives failed from %s", (lifecycle) => {
    expect(deriveWorkspaceState({ lifecycle })).toBe("failed");
  });

  it("derives failed whenever the artifact status is failed on a terminal lifecycle", () => {
    expect(deriveWorkspaceState({ lifecycle: "recovery_pending", artifactStatus: "failed" })).toBe("failed");
    expect(deriveWorkspaceState({ lifecycle: "handed_off", artifactStatus: "failed" })).toBe("failed");
  });

  it("derives clean from handed_off only when a terminal artifact accompanies it", () => {
    expect(deriveWorkspaceState({ lifecycle: "handed_off", artifactStatus: "done" })).toBe("clean");
    expect(deriveWorkspaceState({ lifecycle: "handed_off", artifactStatus: "blocked" })).toBe("clean");
    expect(deriveWorkspaceState({ lifecycle: "handed_off", artifactStatus: "cancelled" })).toBe("clean");
  });

  it.each([
    ["awaiting_handoff lifecycle", { lifecycle: "awaiting_handoff" }],
    ["awaiting_handoff with a terminal artifact", { lifecycle: "awaiting_handoff", artifactStatus: "done" }],
    ["bare handed_off without an artifact record", { lifecycle: "handed_off" }],
    ["handed_off with a foreign artifact status", { lifecycle: "handed_off", artifactStatus: "bogus" }],
    ["unrecognized lifecycle", { lifecycle: "running" }],
    ["empty lifecycle", { lifecycle: "" }],
    ["non-string lifecycle", { lifecycle: 42 }],
    ["null recovery source", null],
    ["evidence without lifecycle", { artifactStatus: "done" }]
  ] as const)("fails closed on %s", (_label, recovery) => {
    const error = thrown(() => deriveWorkspaceState(recovery as unknown as RecoveryEvidence | null));
    expect(error).toBeInstanceOf(RoutingPolicyError);
    expect(error).toMatchObject({ code: "RECOVERY_SOURCE_UNRESOLVABLE" });
  });

  it("carries bounded evidence details on the fail-closed error", () => {
    const error = thrown(() => deriveWorkspaceState({ lifecycle: "running", artifactStatus: "done" }));
    expect(error).toMatchObject({ details: { lifecycle: "running", artifactStatus: "done" } });
    const noArtifact = thrown(() => deriveWorkspaceState({ lifecycle: "running" }));
    expect((noArtifact as RoutingPolicyError).details).toEqual({ lifecycle: "running" });
    const nonString = thrown(() => deriveWorkspaceState({ lifecycle: 42 } as unknown as RecoveryEvidence));
    expect((nonString as RoutingPolicyError).details).toEqual({ lifecycle: "number" });
  });
});

describe("rankFallbackCandidates", () => {
  it("excludes points outside the tier envelope with per-class evidence", () => {
    const result = rankFallbackCandidates(
      [
        point("in", "a", "low", "medium", 0.5),
        point("costly", "b", "high", "low", 0.9),
        point("slow", "c", "low", "high", 0.8),
        point("both", "d", "extreme", "extreme", 0.7)
      ],
      "economy"
    );
    expect(result.ordered.map((p) => p.id)).toEqual(["in"]);
    expect(result.excluded).toEqual([
      { id: "both", provider: "d", reasons: ["cost_class_exceeded", "latency_class_exceeded"] },
      { id: "costly", provider: "b", reasons: ["cost_class_exceeded"] },
      { id: "slow", provider: "c", reasons: ["latency_class_exceeded"] }
    ]);
  });

  it("admits every class at the unbounded max tier", () => {
    const result = rankFallbackCandidates([point("x", "a", "extreme", "extreme", 0.1)], "max");
    expect(result.ordered.map((p) => p.id)).toEqual(["x"]);
    expect(result.excluded).toEqual([]);
  });

  it("returns an empty chain when nothing survives the envelope", () => {
    const result = rankFallbackCandidates([point("x", "a", "medium", "low", 0.9)], "utility");
    expect(result.ordered).toEqual([]);
    expect(result.excluded).toEqual([{ id: "x", provider: "a", reasons: ["cost_class_exceeded"] }]);
    expect(rankFallbackCandidates([], "standard")).toEqual({ ordered: [], excluded: [] });
  });

  it("ranks by the effective tier's fitness even when every score is low", () => {
    const result = rankFallbackCandidates(
      [
        point("p1", "a", "low", "low", { standard: 0.1, utility: 0.9 }),
        point("p2", "b", "low", "low", { standard: 0.3 }),
        point("p3", "c", "low", "low", { standard: 0.2 })
      ],
      "standard"
    );
    expect(result.ordered.map((p) => p.id)).toEqual(["p2", "p3", "p1"]);
  });

  it("breaks fitness ties by ascending id", () => {
    const result = rankFallbackCandidates(
      [point("p9", "a", "low", "low", 0.5), point("p2", "b", "low", "low", 0.5), point("p5", "c", "low", "low", 0.5)],
      "standard"
    );
    expect(result.ordered.map((p) => p.id)).toEqual(["p2", "p5", "p9"]);
  });

  it("prefers unrepresented providers first, then continues by fitness — unbounded, since the caller applies the attempt bound after admission filters", () => {
    const result = rankFallbackCandidates(
      [
        point("p1", "a", "low", "low", 0.9),
        point("p2", "a", "low", "low", 0.8),
        point("p3", "b", "low", "low", 0.7),
        point("p4", "c", "low", "low", 0.6),
        point("p5", "a", "low", "low", 0.5),
        point("p6", "d", "low", "low", 0.4),
        point("p7", "e", "low", "low", 0.3)
      ],
      "standard"
    );
    expect(result.ordered.map((p) => p.id)).toEqual(["p1", "p3", "p4", "p6", "p7", "p2", "p5"]);
    expect(result.excluded).toEqual([]);
    expect(MAX_ATTEMPTS).toBe(4);
  });

  it("continues by fitness within a provider when distinct providers run out", () => {
    const result = rankFallbackCandidates(
      [
        point("p1", "a", "low", "low", 0.9),
        point("p2", "a", "low", "low", 0.8),
        point("p3", "b", "low", "low", 0.7)
      ],
      "standard"
    );
    expect(result.ordered.map((p) => p.id)).toEqual(["p1", "p3", "p2"]);
  });

  it("keeps duplicate-id equal-fitness input stable and does not chain it twice", () => {
    const result = rankFallbackCandidates(
      [point("p1", "a", "low", "low", 0.5), point("p1", "b", "low", "low", 0.5)],
      "standard"
    );
    expect(result.ordered.map((p) => p.id)).toEqual(["p1", "p1"]);
  });
});
