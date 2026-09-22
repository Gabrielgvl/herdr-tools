import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { availability, recordLaunchFailure, type CandidateAvailability } from "../../src/availability.js";
import type { Catalog, OperatingPoint, RunnerEntry, RunnerKind } from "../../src/catalog.js";
import { CompileError, type CompiledContract, type ResourceSelection } from "../../src/compile.js";
import {
  MODIFIER_THRESHOLD,
  ROUTER_CONFIDENCE_THRESHOLD,
  SEMANTIC_MODIFIERS,
  WORKLOAD_INTENTS,
  routeTask,
  runnerResourceSelection,
  type RoutingTask,
  type TaskRouteInput,
} from "../../src/router.js";
import { MAX_ATTEMPTS, POLICY_REVISION, QUALITY_TIERS, type CostClass, type LatencyClass, type QualityTier } from "../../src/routing-policy.js";
import type { ClaudeEffort, ThinkingLevel } from "../../src/profiles/types.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const SHARED_QUOTA = { provider: "test-provider", billingProduct: "test-product", account: "test-account", scope: "project" };

const TASK: RoutingTask = {
  objective: "Reduce the latency.",
  scope: "Only the test fixture.",
  doneWhen: ["p95 latency below 200ms in the bench output"],
  constraints: ["Do not change the wire protocol"],
};

const SPEC = { label: "worker", count: 2 };

function runnerEntry(kind: RunnerKind, models: string[]): RunnerEntry {
  const defaults: RunnerEntry["defaults"] = kind === "pi"
    ? { timeoutMinutes: 30, sessionPersistence: false, thinking: "low" }
    : kind === "claude"
      ? { timeoutMinutes: 30, sessionPersistence: true, effort: "medium", permissionMode: "dontAsk" }
      : kind === "agy"
        ? { timeoutMinutes: 30, sessionPersistence: true, mode: "plan" }
        : { timeoutMinutes: 30, sessionPersistence: true, permissionMode: "dangerous" };
  const plumbing: RunnerEntry["plumbing"] = kind === "pi"
    ? { sessionPersistence: "optional", promptDelivery: "file", skillSelection: "exact", toolSelection: "allowlist" }
    : kind === "claude"
      ? { sessionPersistence: "required", promptDelivery: "file", skillSelection: "additive", toolSelection: "allowlist" }
      : kind === "agy"
        ? { sessionPersistence: "required", promptDelivery: "bootstrap", skillSelection: "ambient", toolSelection: "ambient" }
        : { sessionPersistence: "required", promptDelivery: "none", skillSelection: "ambient", toolSelection: "ambient" };
  return {
    kind,
    models: models.map((model) => ({ model })),
    quota: SHARED_QUOTA,
    defaults,
    plumbing,
    pools: {
      tools: kind === "pi" ? ["read"] : kind === "claude" ? ["Read"] : [],
      extensions: [],
      skills: [],
      plugins: [],
      mcp: [],
    },
  };
}

function makePoint(
  runner: RunnerKind,
  model: string,
  options: { reasoning?: ThinkingLevel | ClaudeEffort; costClass?: CostClass; latencyClass?: LatencyClass; provider?: string } = {},
): OperatingPoint {
  const provider = options.provider ?? `${runner}-provider`;
  return {
    id: `${runner}:${model}${options.reasoning === undefined ? "" : `:${options.reasoning}`}`,
    runner,
    model,
    ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
    provider,
    quota: { ...SHARED_QUOTA, provider },
    costClass: options.costClass ?? "medium",
    latencyClass: options.latencyClass ?? "medium",
  };
}

function catalogOf(points: readonly OperatingPoint[]): Catalog {
  const runners = new Map<RunnerKind, RunnerEntry>();
  for (const point of points) {
    if (!runners.has(point.runner)) {
      runners.set(point.runner, runnerEntry(point.runner, [...new Set(points.filter((entry) => entry.runner === point.runner).map((entry) => entry.model))]));
    }
  }
  return {
    version: 2,
    runners,
    skills: [],
    plugins: [],
    mcpServers: new Map(),
    quotaSources: [{ name: "reactive-cooldowns", kind: "floor" }],
    points,
    source: { path: "/tmp/catalog.yaml", scopeRoot: "/tmp" },
  };
}

const SINGLE_POINT = makePoint("pi", "pi-model", { reasoning: "low" });
const SINGLE_CATALOG = catalogOf([SINGLE_POINT]);

function configuration(resolved: { index: number; point: OperatingPoint }, specLabel = SPEC.label): CompiledContract {
  const { point } = resolved;
  return {
    specLabel,
    candidate: { index: resolved.index, id: point.id, runner: point.runner, model: point.model, ...(point.reasoning === undefined ? {} : { reasoning: point.reasoning }) },
    quota: point.quota,
    scopeRoot: "/tmp",
    sessionPersistence: false,
    timeoutMinutes: 30,
    plumbing: { sessionPersistence: "optional", promptDelivery: "file", skillSelection: "exact", toolSelection: "allowlist" },
    runtime: { kind: "pi", model: point.model, thinking: "low", tools: ["read"], extensions: [], skills: [] },
    resources: {
      tools: { installed: ["read"], selected: ["read"], exposed: ["read"], permitted: ["read"], denied: [] },
    },
    derivations: [],
    gaps: [],
  };
}

function fitnessFor(catalog: Catalog, probability: number | ((point: OperatingPoint, tier: QualityTier) => number) = 0.9): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [index, point] of (catalog.points ?? []).entries()) {
    const byTier = {} as Record<string, number>;
    for (const tier of QUALITY_TIERS) byTier[tier] = typeof probability === "function" ? probability(point, tier) : probability;
    out[String(index)] = byTier;
  }
  return out;
}

function resourcesFor(catalog: Catalog, probability = 0.95): Record<string, Record<string, Record<string, number>>> {
  const out: Record<string, Record<string, Record<string, number>>> = {};
  for (const [kind, entry] of catalog.runners) {
    const fields: Record<string, Record<string, number>> = {};
    for (const field of ["tools", "extensions", "skills", "plugins", "mcp"] as const) {
      for (const name of entry.pools[field]) (fields[field] ??= {})[name] = probability;
    }
    out[kind] = fields;
  }
  return out;
}

function responseFor(catalog: Catalog, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    quality: { done_when_verifiable: 0.9 },
    intent: { value: "implement", confidence: 0.9 },
    modifiers: {},
    resources: resourcesFor(catalog),
    fitness: fitnessFor(catalog),
    ...patch,
  };
}

function availabilityStatus(status: CandidateAvailability["status"]): CandidateAvailability {
  return { status, retryNotBefore: null, evidence: { records: status === "unknown" ? 0 : 1 } };
}

function baseInput(catalog: Catalog = SINGLE_CATALOG): TaskRouteInput {
  return {
    task: TASK,
    spec: SPEC,
    catalog,
    response: responseFor(catalog),
    root: "/tmp/router-test-root",
    availability: async () => availabilityStatus("unknown"),
    compile: async (_catalog, _spec, resolved) => configuration(resolved),
  };
}

describe("task routing policy", () => {
  it("keeps the intent confidence threshold at 0.8, the modifier threshold at 0.7, and admits with not_rejected evidence", async () => {
    expect(ROUTER_CONFIDENCE_THRESHOLD).toBe(0.8);
    expect(MODIFIER_THRESHOLD).toBe(0.7);
    const seen: ResourceSelection[] = [];
    const input = baseInput();
    input.compile = async (_catalog, _spec, resolved, selection) => {
      seen.push(selection);
      return configuration(resolved);
    };

    const result = await routeTask(input);

    expect(result).toMatchObject({
      kind: "admitted",
      quality: "not_rejected",
      count: 2,
      requestedTier: "standard",
      workloadFloor: "standard",
      effectiveStartTier: "standard",
      effectiveCeiling: "frontier",
      chain: [SINGLE_POINT.id],
      selectedPoint: { index: 0, id: SINGLE_POINT.id, runner: "pi", model: "pi-model", reasoning: "low" },
    });
    expect(result.evidence).toMatchObject({
      quality: { outcome: "not_rejected", done_when_verifiable: 0.9 },
      policyRevision: POLICY_REVISION,
      intent: { value: "implement", confidence: 0.9 },
      workload: { intent: "implement", mutation: "none", scope: "local", horizon: "short", workspaceState: "clean", ambiguity: "low" },
      selectedPoint: { index: 0, id: SINGLE_POINT.id },
      availability: [{ id: "pi:pi-model:low", status: "unknown", retryNotBefore: null }],
      fitness: { [SINGLE_POINT.id]: 0.9 },
    });
    expect(seen).toEqual([{ tools: ["read"] }]);
    expect(JSON.stringify(result)).not.toContain("certified");
  });

  it("rejects a confident done_when failure before assembling an admission", async () => {
    const input = baseInput();
    input.response = { quality: { done_when_verifiable: 0.1 } };
    await expect(routeTask(input)).resolves.toMatchObject({ kind: "rejected", quality: "rejected", reason: "done_when_unverifiable" });

    const rejected = await routeTask(baseInput());
    expect(rejected.kind).toBe("admitted");
    const failing = baseInput();
    failing.response = { ...responseFor(SINGLE_CATALOG), quality: { done_when_verifiable: { probability: 0.05, confidence: 0.9 } } };
    await expect(routeTask(failing)).resolves.toEqual({
      kind: "rejected",
      quality: "rejected",
      reason: "done_when_unverifiable",
      evidence: { quality: { outcome: "rejected", done_when_verifiable: 0.05 } },
    });
  });

  it("abstains invalid_response/quality on missing or malformed quality evidence", async () => {
    for (const quality of [undefined, "junk", { done_when_verifiable: "junk" }, { done_when_verifiable: { probabilities: { yes: 0.5, no: 0.6 } } }]) {
      const input = baseInput();
      input.response = quality === undefined ? { ...responseFor(SINGLE_CATALOG), quality: undefined } : { ...responseFor(SINGLE_CATALOG), quality };
      await expect(routeTask(input), JSON.stringify(quality)).resolves.toMatchObject({ kind: "abstained", reason: "invalid_response", component: "quality" });
    }
    for (const response of ["junk", null]) {
      const input = baseInput();
      input.response = response;
      await expect(routeTask(input)).resolves.toMatchObject({ kind: "abstained", reason: "invalid_response", component: "quality" });
    }
  });

  it("abstains low_confidence naming intent when the intent judgment is under 0.8 — the only abstaining classification", async () => {
    for (const confidence of [0.799, 0.5, 0]) {
      const input = baseInput();
      input.response = responseFor(SINGLE_CATALOG, { intent: { value: "implement", confidence } });
      await expect(routeTask(input), `confidence ${confidence}`).resolves.toMatchObject({
        kind: "abstained",
        reason: "low_confidence",
        component: "intent",
        evidence: { quality: { outcome: "not_rejected" }, policyRevision: POLICY_REVISION, intent: { value: "implement", confidence } },
      });
    }
    const boundary = baseInput();
    boundary.response = responseFor(SINGLE_CATALOG, { intent: { value: "implement", confidence: 0.8 } });
    await expect(routeTask(boundary)).resolves.toMatchObject({ kind: "admitted" });
  });

  it("abstains invalid_response/intent on a malformed or foreign intent judgment", async () => {
    for (const intent of [undefined, 5, "ghost", { value: "implement" }, { value: "ghost", confidence: 0.9 }, { value: "implement", confidence: 2 }, { value: "implement", confidence: 0.9, probabilities: { implement: 0.9 } }]) {
      const input = baseInput();
      input.response = responseFor(SINGLE_CATALOG, { intent });
      await expect(routeTask(input), JSON.stringify(intent)).resolves.toMatchObject({ kind: "abstained", reason: "invalid_response", component: "intent" });
    }
  });

  it("applies each difficult modifier only at P >= 0.70, adding exactly one tier, and never abstains on modifier uncertainty", async () => {
    // implement has the standard base floor, so one applied modifier lifts it to strong.
    for (const name of SEMANTIC_MODIFIERS) {
      const applied = baseInput();
      applied.response = responseFor(SINGLE_CATALOG, {
        intent: { value: "implement", confidence: 0.9 },
        modifiers: { [name]: MODIFIER_THRESHOLD },
      });
      const result = await routeTask(applied);
      expect(result, name).toMatchObject({ kind: "admitted", workloadFloor: "strong", effectiveStartTier: "strong" });
      expect(result.evidence?.modifiers?.[name]).toMatchObject({ probability: MODIFIER_THRESHOLD, applied: true });

      const skipped = baseInput();
      skipped.response = responseFor(SINGLE_CATALOG, {
        intent: { value: "implement", confidence: 0.9 },
        modifiers: { [name]: MODIFIER_THRESHOLD - 0.001 },
      });
      const skippedResult = await routeTask(skipped);
      expect(skippedResult, `${name} below threshold`).toMatchObject({ kind: "admitted", workloadFloor: "standard", effectiveStartTier: "standard" });
      expect(skippedResult.evidence?.modifiers?.[name]).toMatchObject({ applied: false });
    }
    // Malformed and low-probability modifiers are one-sided: never an abstention.
    const malformed = baseInput();
    malformed.response = responseFor(SINGLE_CATALOG, { modifiers: { mutation_broad: "junk", horizon_long: 0.2 } });
    await expect(routeTask(malformed)).resolves.toMatchObject({ kind: "admitted", workloadFloor: "standard" });
  });

  it("lifts the floor once per applied modifier and the ceiling past the effective start", async () => {
    const input = baseInput();
    input.response = responseFor(SINGLE_CATALOG, {
      intent: { value: "implement", confidence: 0.9 },
      modifiers: { mutation_broad: 0.9, scope_repo_wide: 0.9 },
    });
    // implement floor standard + two modifiers = frontier; the frontier base ceiling lifted twice clamps at max.
    await expect(routeTask(input)).resolves.toMatchObject({ kind: "admitted", workloadFloor: "frontier", effectiveStartTier: "frontier", effectiveCeiling: "max" });
    // A requested tier above the lifted floor wins the start; the ceiling follows it.
    const requested = baseInput();
    requested.task = { ...TASK, tier: "max" };
    requested.response = responseFor(SINGLE_CATALOG, { intent: { value: "verify", confidence: 0.9 } });
    await expect(routeTask(requested)).resolves.toMatchObject({ kind: "admitted", requestedTier: "max", workloadFloor: "utility", effectiveStartTier: "max", effectiveCeiling: "max" });
    // A requested tier below the floor loses to the floor.
    const floored = baseInput();
    floored.task = { ...TASK, tier: "utility" };
    floored.response = responseFor(SINGLE_CATALOG, { intent: { value: "implement", confidence: 0.9 } });
    await expect(routeTask(floored)).resolves.toMatchObject({ kind: "admitted", requestedTier: "utility", effectiveStartTier: "standard" });
  });

  it("maps runtime workspace state into the profile — partial lifts once, failed opens the ceiling to max", async () => {
    const partial = baseInput();
    partial.workspaceState = "partial";
    partial.response = responseFor(SINGLE_CATALOG, { intent: { value: "verify", confidence: 0.9 } });
    await expect(routeTask(partial)).resolves.toMatchObject({ kind: "admitted", workloadFloor: "economy", evidence: { workload: { workspaceState: "partial" } } });
    const failed = baseInput();
    failed.workspaceState = "failed";
    failed.response = responseFor(SINGLE_CATALOG, { intent: { value: "verify", confidence: 0.9 } });
    await expect(routeTask(failed)).resolves.toMatchObject({ kind: "admitted", workloadFloor: "economy", effectiveCeiling: "max", evidence: { workload: { workspaceState: "failed" } } });
  });

  it("ranks the chain by effective-tier fitness, prefers distinct providers, tie-breaks on id, and bounds at MAX_ATTEMPTS", async () => {
    const points = [
      makePoint("pi", "a-model", { reasoning: "low", provider: "shared" }),
      makePoint("pi", "b-model", { reasoning: "low", provider: "shared" }),
      makePoint("claude", "c-model", { reasoning: "high", provider: "other" }),
      makePoint("agy", "d-model", { provider: "third" }),
      makePoint("devin", "e-model", { provider: "fourth" }),
    ];
    const catalog = catalogOf(points);
    const input = baseInput(catalog);
    // Fitness at standard: agy strongest, then claude, then the two shared-provider
    // points (a before b on id), devin weakest — but devin still chains ahead of
    // the second shared-provider point on provider diversity.
    input.response = responseFor(catalog, {
      fitness: fitnessFor(catalog, (point) => ({ "agy:d-model": 0.95, "claude:c-model:high": 0.9, "pi:a-model:low": 0.8, "pi:b-model:low": 0.7, "devin:e-model": 0.1 })[point.id] ?? 0),
    });
    const result = await routeTask(input);
    expect(result).toMatchObject({ kind: "admitted" });
    if (result.kind !== "admitted") return;
    expect(result.chain).toEqual(["agy:d-model", "claude:c-model:high", "pi:a-model:low", "devin:e-model"]);
    expect(result.selectedPoint).toMatchObject({ index: 0, id: "agy:d-model", runner: "agy", model: "d-model" });
    expect(result.evidence?.chainExclusions).toEqual([{ id: "pi:b-model:low", provider: "shared", reasons: ["attempt_bound"] }]);
    expect(result.evidence?.fitness).toMatchObject({ "agy:d-model": 0.95, "devin:e-model": 0.1 });
    expect(result.chain.length).toBeLessThanOrEqual(MAX_ATTEMPTS);
  });

  it("excludes points outside the tier envelope with typed reasons and abstains no_candidates_at_tier when the envelope is empty", async () => {
    const catalog = catalogOf([
      makePoint("pi", "cheap-model", { reasoning: "low", costClass: "low", latencyClass: "low" }),
      makePoint("claude", "dear-model", { reasoning: "high", costClass: "extreme", latencyClass: "low" }),
      makePoint("agy", "slow-model", { costClass: "low", latencyClass: "extreme" }),
      makePoint("devin", "both-model", { costClass: "extreme", latencyClass: "extreme" }),
    ]);
    const input = baseInput(catalog);
    input.response = responseFor(catalog);
    const result = await routeTask(input);
    expect(result).toMatchObject({ kind: "admitted", effectiveStartTier: "standard" });
    if (result.kind === "admitted") {
      // standard admits at most medium/medium: only the cheap pi point survives.
      expect(result.chain).toEqual(["pi:cheap-model:low"]);
      expect(result.evidence?.chainExclusions).toEqual([
        { id: "agy:slow-model", provider: "agy-provider", reasons: ["latency_class_exceeded"] },
        { id: "claude:dear-model:high", provider: "claude-provider", reasons: ["cost_class_exceeded"] },
        { id: "devin:both-model", provider: "devin-provider", reasons: ["cost_class_exceeded", "latency_class_exceeded"] },
      ]);
    }

    const empty = catalogOf([makePoint("pi", "dear-model", { reasoning: "low", costClass: "extreme" })]);
    const nothing = baseInput(empty);
    nothing.response = responseFor(empty);
    await expect(routeTask(nothing)).resolves.toMatchObject({ kind: "abstained", reason: "no_candidates_at_tier" });
    // A catalog with no reviewed points at all abstains the same way.
    const bare = catalogOf([]);
    const noPoints = baseInput(bare);
    noPoints.response = responseFor(bare);
    await expect(routeTask(noPoints)).resolves.toMatchObject({ kind: "abstained", reason: "no_candidates_at_tier" });
  });

  it("probes every chain point after scoring, then abstains no_candidates_at_tier when all are exhausted and transport_failed when all are local-limited", async () => {
    const catalog = catalogOf([SINGLE_POINT, makePoint("claude", "claude-model", { reasoning: "high" })]);
    const seen: CandidateAvailability[] = [];
    const exhausted = baseInput(catalog);
    exhausted.response = responseFor(catalog);
    exhausted.availability = async () => {
      const value = availabilityStatus("known-exhausted");
      seen.push(value);
      return value;
    };
    const result = await routeTask(exhausted);
    expect(result).toMatchObject({ kind: "abstained", reason: "no_candidates_at_tier" });
    expect(seen).toHaveLength(2);
    if (result.kind === "abstained") expect(result.evidence?.availability?.map((entry) => entry.status)).toEqual(["known-exhausted", "known-exhausted"]);

    const local = baseInput(catalog);
    local.response = responseFor(catalog);
    local.availability = async () => availabilityStatus("local-capacity-limited");
    await expect(routeTask(local)).resolves.toMatchObject({ kind: "abstained", reason: "transport_failed", component: "availability" });

    // Equal fitness ranks by id: claude:claude-model:high is probed first and
    // its exhaustion excludes it before the bound, so the pi point chains at 0.
    const mixed = baseInput(catalog);
    mixed.response = responseFor(catalog);
    let calls = 0;
    mixed.availability = async () => availabilityStatus(calls++ === 0 ? "known-exhausted" : "unknown");
    const mixedResult = await routeTask(mixed);
    expect(mixedResult).toMatchObject({ kind: "admitted", selectedPoint: { index: 0, id: "pi:pi-model:low" }, chain: ["pi:pi-model:low"] });
    if (mixedResult.kind === "admitted") {
      expect(mixedResult.evidence?.chainExclusions).toEqual([{ id: "claude:claude-model:high", provider: "claude-provider", reasons: ["unavailable"] }]);
      expect(mixedResult.evidence?.availability?.map((entry) => [entry.id, entry.status])).toEqual([["claude:claude-model:high", "known-exhausted"], ["pi:pi-model:low", "unknown"]]);
    }
  });

  it("returns transport_failed when the availability read fails or no root and no gate exist", async () => {
    const throwing = baseInput();
    throwing.availability = async () => { throw new Error("availability read failed"); };
    await expect(routeTask(throwing)).resolves.toMatchObject({ kind: "abstained", reason: "transport_failed", component: "availability" });

    const bare = baseInput();
    delete bare.root;
    delete bare.availability;
    await expect(routeTask(bare)).resolves.toMatchObject({ kind: "abstained", reason: "transport_failed", component: "availability" });
  });

  it("abstains invalid_response/fitness when any point's tier judgments are missing or malformed", async () => {
    const missing = baseInput();
    missing.response = responseFor(SINGLE_CATALOG, { fitness: {} });
    await expect(routeTask(missing)).resolves.toMatchObject({ kind: "abstained", reason: "invalid_response", component: "fitness" });
    const partial = baseInput();
    partial.response = responseFor(SINGLE_CATALOG, { fitness: { "0": { standard: 0.9 } } });
    await expect(routeTask(partial)).resolves.toMatchObject({ kind: "abstained", reason: "invalid_response", component: "fitness" });
    const malformed = baseInput();
    malformed.response = responseFor(SINGLE_CATALOG, { fitness: "junk" });
    await expect(routeTask(malformed)).resolves.toMatchObject({ kind: "abstained", reason: "invalid_response", component: "fitness" });
  });

  it("abstains invalid_response/candidates when a pool-owning chain runner has no resource map or a malformed one", async () => {
    const missing = baseInput();
    const response = responseFor(SINGLE_CATALOG);
    delete (response.resources as Record<string, unknown>).pi;
    missing.response = response;
    await expect(routeTask(missing)).resolves.toMatchObject({ kind: "abstained", reason: "invalid_response", component: "candidates" });
    const malformed = baseInput();
    malformed.response = responseFor(SINGLE_CATALOG, { resources: { pi: { tools: "junk" } } });
    await expect(routeTask(malformed)).resolves.toMatchObject({ kind: "abstained", reason: "invalid_response", component: "candidates" });
  });

  it("excludes indecisive resources, records the noul, and abstains low_confidence only when the task text explicitly requires one", async () => {
    const input = baseInput();
    input.response = responseFor(SINGLE_CATALOG, { resources: { pi: { tools: { read: 0.7 } } } });
    const seen: ResourceSelection[] = [];
    input.compile = async (_catalog, _spec, resolved, selection) => {
      seen.push(selection);
      return configuration(resolved);
    };
    const result = await routeTask(input);
    expect(result).toMatchObject({ kind: "admitted", evidence: { exclusions: [{ field: "tools", name: "read", noul: 0.7 }] } });
    expect(seen).toEqual([{}]);

    const required = baseInput();
    required.task = { ...TASK, constraints: ["You must use read to complete this assignment."] };
    required.response = responseFor(SINGLE_CATALOG, { resources: { pi: { tools: { read: 0.7 } } } });
    await expect(routeTask(required)).resolves.toMatchObject({
      kind: "abstained",
      reason: "low_confidence",
      component: "tools:read",
      evidence: { exclusions: [{ field: "tools", name: "read", noul: 0.7 }] },
    });

    const forbidden = baseInput();
    forbidden.task = { ...TASK, constraints: ["Do not use read for this assignment."] };
    forbidden.response = responseFor(SINGLE_CATALOG, { resources: { pi: { tools: { read: 0.7 } } } });
    await expect(routeTask(forbidden)).resolves.toMatchObject({ kind: "admitted" });

    const imperative = baseInput();
    imperative.task = { ...TASK, constraints: ["Use read for this assignment."] };
    imperative.response = responseFor(SINGLE_CATALOG, { resources: { pi: { tools: { read: 0.7 } } } });
    await expect(routeTask(imperative)).resolves.toMatchObject({ kind: "abstained", reason: "low_confidence", component: "tools:read" });
  });

  it("abstains catalog_unavailable when a chain point's runner is absent from the catalog", async () => {
    const catalog = catalogOf([SINGLE_POINT]);
    catalog.runners = new Map();
    const input = baseInput(catalog);
    input.response = responseFor(catalog, { resources: {} });
    await expect(routeTask(input)).resolves.toMatchObject({ kind: "abstained", reason: "catalog_unavailable", component: "catalog" });
  });

  it("maps compile failures to typed abstains and reaches the real compiler by default", async () => {
    const invalidSelection = baseInput();
    invalidSelection.compile = async () => { throw new CompileError("INVALID_SELECTION", "bad selection"); };
    await expect(routeTask(invalidSelection)).resolves.toMatchObject({ kind: "abstained", reason: "invalid_response", component: "candidates" });
    const outsidePool = baseInput();
    outsidePool.compile = async () => { throw new CompileError("SELECTION_OUTSIDE_POOL", "outside"); };
    await expect(routeTask(outsidePool)).resolves.toMatchObject({ kind: "abstained", reason: "invalid_response", component: "candidates" });
    const otherCode = baseInput();
    otherCode.compile = async () => { throw new CompileError("CANDIDATE_NOT_REVIEWED", "unreviewed"); };
    await expect(routeTask(otherCode)).resolves.toMatchObject({ kind: "abstained", reason: "catalog_unavailable", component: "configuration" });
    const generic = baseInput();
    generic.compile = async () => { throw new Error("compile down"); };
    await expect(routeTask(generic)).resolves.toMatchObject({ kind: "abstained", reason: "catalog_unavailable", component: "configuration" });
  });

  it("maps transport markers to a bounded component before any classification", async () => {
    for (const { patch, component } of [
      { patch: { transport: true }, component: "transport" },
      { patch: { kind: "transport_failed" }, component: "transport" },
      { patch: { kind: "transport", component: "http_503" }, component: "http_503" },
      { patch: { transport: { failed: true } }, component: "transport" },
      { patch: { transport: { failed: true, component: "quota_429" } }, component: "quota_429" },
    ]) {
      const input = baseInput();
      input.response = responseFor(SINGLE_CATALOG, patch);
      await expect(routeTask(input), JSON.stringify(patch)).resolves.toMatchObject({ kind: "abstained", reason: "transport_failed", component });
    }
  });

  it("parses every recorded binary-answer form Jev may emit on the quality gate", async () => {
    const route = async (answer: unknown) => {
      const input = baseInput();
      input.response = responseFor(SINGLE_CATALOG, { quality: { done_when_verifiable: answer } });
      return routeTask(input);
    };
    // Scalar booleans and the record aliases all normalize to the same judgment.
    await expect(route(true)).resolves.toMatchObject({ kind: "admitted" });
    await expect(route(false)).resolves.toMatchObject({ kind: "rejected" });
    for (const answer of [{ noul: 0.9 }, { yes: 0.9 }, { value: 0.9 }, { value: true }, { choice: "pass" }, { choice: "verifiable" }, { probabilities: { yes: 0.9, no: 0.1 } }, { probabilities: { true: 0.8, false: 0.2 } }, { probabilities: { adequate: 0.7, inadequate: 0.3 } }, { probability: 0.9, confidence: 0.8 }]) {
      await expect(route(answer), JSON.stringify(answer)).resolves.toMatchObject({ kind: "admitted" });
    }
    for (const answer of [{ choice: "no" }, { choice: "unverifiable" }, { choice: "fail" }, { value: false }]) {
      await expect(route(answer), JSON.stringify(answer)).resolves.toMatchObject({ kind: "rejected" });
    }
    // An explicit confidence outside [0,1] or an unrecognized choice invalidates the answer; a set probability never consults the map.
    for (const answer of [{ choice: "maybe" }, { probability: 0.9, confidence: 1.5 }, { value: "junk" }]) {
      await expect(route(answer), JSON.stringify(answer)).resolves.toMatchObject({ kind: "abstained", reason: "invalid_response", component: "quality" });
    }
    await expect(route({ probability: 0.9, probabilities: { yes: 0.1, no: 0.9 } })).resolves.toMatchObject({ kind: "admitted" });
    // A bare done_when answer without the quality wrapper is the same judgment.
    const bare = baseInput();
    const rest = responseFor(SINGLE_CATALOG) as Record<string, unknown>;
    delete rest.quality;
    bare.response = { ...rest, done_when_verifiable: 0.9 };
    await expect(routeTask(bare)).resolves.toMatchObject({ kind: "admitted" });
  });

  it("labels done_when verifiability strong, partial, or weak — a bounded evidence label, never a gate", async () => {
    for (const [probability, label] of [[0.9, "strong"], [0.6, "partial"], [0.3, "weak"]] as const) {
      const input = baseInput();
      input.response = responseFor(SINGLE_CATALOG, { quality: { done_when_verifiable: probability } });
      await expect(routeTask(input), `p=${probability}`).resolves.toMatchObject({ kind: "admitted", evidence: { workload: { verifiability: label } } });
    }
  });

  it("parses the intent judgment's alternate keys and carries its validated distribution into evidence", async () => {
    for (const intent of ["implement", { choice: "implement", confidence: 0.9 }, { intent: "implement", confidence: 0.9 }, { value: "implement", probability: 0.9 }]) {
      const input = baseInput();
      input.response = responseFor(SINGLE_CATALOG, { intent });
      await expect(routeTask(input), JSON.stringify(intent)).resolves.toMatchObject({ kind: "admitted" });
    }
    const distribution = { explore: 0.01, reason: 0.01, implement: 0.94, debug: 0.01, verify: 0.01, review: 0.01, coordinate: 0.01 };
    const input = baseInput();
    input.response = responseFor(SINGLE_CATALOG, { intent: { value: "implement", confidence: 0.9, probabilities: distribution } });
    await expect(routeTask(input)).resolves.toMatchObject({ kind: "admitted", evidence: { intent: { probabilities: { implement: 0.94 } } } });
    // The map must be a record over exactly the seven intents whose probabilities sum to one.
    const foreign: Record<string, number> = { ...distribution, ghost: 0.01 };
    delete foreign.explore;
    for (const probabilities of ["junk", foreign, { ...distribution, implement: "junk" }, Object.fromEntries(WORKLOAD_INTENTS.map((name) => [name, 0.9]))]) {
      const malformed = baseInput();
      malformed.response = responseFor(SINGLE_CATALOG, { intent: { value: "implement", confidence: 0.9, probabilities } });
      await expect(routeTask(malformed), JSON.stringify(probabilities)).resolves.toMatchObject({ kind: "abstained", reason: "invalid_response", component: "intent" });
    }
    const nonString = baseInput();
    nonString.response = responseFor(SINGLE_CATALOG, { intent: { value: 5, confidence: 0.9 } });
    await expect(routeTask(nonString)).resolves.toMatchObject({ kind: "abstained", reason: "invalid_response", component: "intent" });
  });

  it("parses resource judgments in every recorded form and fails closed on malformed entries", async () => {
    for (const [judgment, selected] of [
      [true, true],
      [false, false],
      [{ selected: true, confidence: 0.9 }, true],
      [{ selected: false, confidence: 0.9 }, false],
      [{ permitted: true, confidence: 0.9 }, true],
      [{ noul: 0.9 }, true],
      [{ probability: 0.9 }, true],
      [{ value: true }, true],
    ] as const) {
      const seen: ResourceSelection[] = [];
      const input = baseInput();
      input.response = responseFor(SINGLE_CATALOG, { resources: { pi: { tools: { read: judgment } } } });
      input.compile = async (_c, _s, resolved, selection) => {
        seen.push(selection);
        return configuration(resolved);
      };
      await expect(routeTask(input), JSON.stringify(judgment)).resolves.toMatchObject({ kind: "admitted" });
      expect(seen[0]?.tools ?? [], JSON.stringify(judgment)).toEqual(selected ? ["read"] : []);
    }
    // Array-of-record selections: bare strings select, `{name, judgment}` and the `{resource}` alias carry the same judgment.
    const seenArray: ResourceSelection[] = [];
    const arrayForm = baseInput();
    arrayForm.response = responseFor(SINGLE_CATALOG, { resources: { pi: { tools: ["read", { name: "read", selected: false, confidence: 0.9 }] } } });
    arrayForm.compile = async (_c, _s, resolved, selection) => {
      seenArray.push(selection);
      return configuration(resolved);
    };
    await expect(routeTask(arrayForm)).resolves.toMatchObject({ kind: "admitted", evidence: { exclusions: [{ field: "tools", name: "read", noul: 0 }] } });
    expect(seenArray).toEqual([{ tools: ["read"] }]);
    const seenAlias: ResourceSelection[] = [];
    const aliasForm = baseInput();
    aliasForm.response = responseFor(SINGLE_CATALOG, { resources: { pi: { tools: [{ resource: "read", noul: 0.9 }] } } });
    aliasForm.compile = async (_c, _s, resolved, selection) => {
      seenAlias.push(selection);
      return configuration(resolved);
    };
    await expect(routeTask(aliasForm)).resolves.toMatchObject({ kind: "admitted" });
    expect(seenAlias).toEqual([{ tools: ["read"] }]);
    // Every malformed judgment abstains closed — never a silent default.
    for (const resources of [
      { pi: { tools: { read: "junk" } } },
      { pi: { tools: { read: { selected: "junk" } } } },
      { pi: { tools: { read: { choice: "yes" } } } },
      { pi: { tools: { read: { selected: true, confidence: "junk" } } } },
      { pi: { tools: { read: { name: "read" } } } },
      { pi: { tools: { "": 0.9 } } },
      { pi: { tools: [5] } },
      { pi: { tools: [{ name: "read" }] } },
      { pi: { tools: [{ name: "" }] } },
      { pi: { tools: [{ name: "bad\nname", noul: 0.9 }] } },
      { pi: "junk" },
      "junk",
    ]) {
      const input = baseInput();
      input.response = responseFor(SINGLE_CATALOG, { resources });
      await expect(routeTask(input), JSON.stringify(resources)).resolves.toMatchObject({ kind: "abstained", reason: "invalid_response", component: "candidates" });
    }
  });

  it("admits an ambient-only chain whose runner owns no pools — an absent map is an empty selection", async () => {
    const catalog = catalogOf([makePoint("agy", "agy-model")]);
    const input = baseInput(catalog);
    input.response = responseFor(catalog, { resources: {} });
    await expect(routeTask(input)).resolves.toMatchObject({ kind: "admitted", selectedPoint: { id: "agy:agy-model", runner: "agy" } });
  });

  it("abstains catalog_unavailable when a later candidate's runner disappears mid-admission", async () => {
    const catalog = catalogOf([SINGLE_POINT, makePoint("claude", "claude-model", { reasoning: "high" })]);
    const real = catalog.runners;
    let calls = 0;
    catalog.runners = new Proxy(real, {
      get(target, property) {
        if (property === "get") return (key: RunnerKind) => (++calls <= 1 ? target.get(key) : undefined);
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as ReadonlyMap<RunnerKind, RunnerEntry>;
    const input = baseInput(catalog);
    await expect(routeTask(input)).resolves.toMatchObject({ kind: "abstained", reason: "catalog_unavailable", component: "catalog" });
  });

  it("reduces malformed resource maps to an empty selection through the export seam", () => {
    expect(runnerResourceSelection("junk" as never, "pi")).toEqual({});
    expect(runnerResourceSelection({ resources: "junk" } as never, "pi")).toEqual({});
    expect(runnerResourceSelection({ resources: {} } as never, "pi")).toEqual({});
    expect(runnerResourceSelection({ resources: { pi: "junk" } } as never, "pi")).toEqual({});
    expect(runnerResourceSelection({ resources: { pi: { tools: "junk" } } } as never, "pi")).toEqual({});
    expect(runnerResourceSelection({ resources: { pi: { tools: { read: 0.9 } } } } as never, "pi")).toEqual({ tools: ["read"] });
  });

  it("abstains no_candidates_at_tier on a catalog whose points were never generated", async () => {
    const bare: Catalog = { ...SINGLE_CATALOG };
    delete bare.points;
    const input = baseInput(bare);
    input.response = responseFor(bare);
    await expect(routeTask(input)).resolves.toMatchObject({ kind: "abstained", reason: "no_candidates_at_tier" });
  });

  it("defaults the replica count to one when the spec omits it", async () => {
    const input = baseInput();
    input.spec = { label: "worker" };
    await expect(routeTask(input)).resolves.toMatchObject({ kind: "admitted", count: 1 });
  });

  it("consumes availability without runner-name bias: a shared quota exhausts every point on the tuple", async () => {
    const points = [
      makePoint("pi", "shared-model", { reasoning: "low", provider: "test-provider" }),
      makePoint("claude", "shared-model", { reasoning: "high", provider: "test-provider" }),
    ];
    const catalog = catalogOf(points);
    const root = await mkdtemp(join(tmpdir(), "herdr-router-availability-"));
    dirs.push(root);
    const now = () => new Date("2026-09-18T10:00:00.000Z");
    const pi = catalog.runners.get("pi")!;
    const claude = catalog.runners.get("claude")!;

    await recordLaunchFailure({ runner: "pi", model: "shared-model" }, pi, "quota_exceeded", { root, now });
    await expect(availability({ runner: "pi", model: "shared-model" }, pi, { root, now })).resolves.toMatchObject({ status: "known-exhausted" });
    await expect(availability({ runner: "claude", model: "shared-model" }, claude, { root, now })).resolves.toMatchObject({ status: "known-exhausted" });

    const seen: CandidateAvailability[] = [];
    const result = await routeTask({
      task: TASK,
      spec: SPEC,
      catalog,
      response: responseFor(catalog),
      root,
      now,
      availability: async (candidate, runner, options) => {
        const value = await availability(candidate, runner, options);
        seen.push(value);
        return value;
      },
      compile: async () => { throw new Error("an exhausted chain must not compile"); },
    });

    expect(result).toMatchObject({ kind: "abstained", reason: "no_candidates_at_tier" });
    expect(seen.map((value) => value.status)).toEqual(["known-exhausted", "known-exhausted"]);
  });

  it("applies the attempt bound after availability admission — four exhausted points cannot hide a fifth admissible one", async () => {
    const points = [1, 2, 3, 4, 5].map((n) => makePoint("pi", `p${n}`, { reasoning: "low", provider: `provider-${n}` }));
    const catalog = catalogOf(points);
    const input = baseInput(catalog);
    input.response = responseFor(catalog, {
      fitness: fitnessFor(catalog, (point) => ({ "pi:p1:low": 0.9, "pi:p2:low": 0.8, "pi:p3:low": 0.7, "pi:p4:low": 0.6, "pi:p5:low": 0.5 })[point.id] ?? 0),
    });
    const seen: string[] = [];
    input.availability = async (candidate) => {
      seen.push(candidate.model);
      return availabilityStatus(candidate.model === "p5" ? "unknown" : "known-exhausted");
    };
    const result = await routeTask(input);
    expect(result).toMatchObject({ kind: "admitted", chain: ["pi:p5:low"], selectedPoint: { index: 0, id: "pi:p5:low" } });
    // All five ranked candidates were probed in order; the four exhausted ones
    // are excluded evidence, not bound slots.
    expect(seen).toEqual(["p1", "p2", "p3", "p4", "p5"]);
    if (result.kind === "admitted") {
      expect(result.evidence?.chainExclusions?.filter((entry) => entry.reasons.includes("unavailable"))).toHaveLength(4);
      expect(result.evidence?.availability?.map((entry) => entry.id)).toEqual(["pi:p1:low", "pi:p2:low", "pi:p3:low", "pi:p4:low", "pi:p5:low"]);
    }
  });

  it("excludes the failed prior point before the attempt bound so the chain holds four other admissible points", async () => {
    const points = [1, 2, 3, 4, 5, 6].map((n) => makePoint("pi", `p${n}`, { reasoning: "low", provider: `provider-${n}` }));
    const catalog = catalogOf(points);
    const input = baseInput(catalog);
    input.response = responseFor(catalog, {
      fitness: fitnessFor(catalog, (point) => ({ "pi:p1:low": 0.95, "pi:p2:low": 0.9, "pi:p3:low": 0.8, "pi:p4:low": 0.7, "pi:p5:low": 0.6, "pi:p6:low": 0.5 })[point.id] ?? 0),
    });
    input.recovery = { priorOperatingPointId: "pi:p1:low" };
    const result = await routeTask(input);
    expect(result).toMatchObject({ kind: "admitted" });
    if (result.kind !== "admitted") return;
    // The failed point never consumes a slot: four admissible points chain.
    expect(result.chain).toEqual(["pi:p2:low", "pi:p3:low", "pi:p4:low", "pi:p5:low"]);
    expect(result.evidence?.chainExclusions).toEqual([
      { id: "pi:p1:low", provider: "provider-1", reasons: ["recovery_excluded"] },
      { id: "pi:p6:low", provider: "provider-6", reasons: ["attempt_bound"] },
    ]);
  });

  it("prefers a different provider first when the failed provider's next point would head the recovery chain", async () => {
    const points = [
      makePoint("pi", "p0", { reasoning: "low", provider: "shared" }),
      makePoint("pi", "failed", { reasoning: "low", provider: "shared" }),
      makePoint("pi", "p2", { reasoning: "low", provider: "other" }),
      makePoint("pi", "p3", { reasoning: "low", provider: "third" }),
    ];
    const catalog = catalogOf(points);
    const input = baseInput(catalog);
    input.response = responseFor(catalog, {
      fitness: fitnessFor(catalog, (point) => ({ "pi:p0:low": 0.95, "pi:failed:low": 0.9, "pi:p2:low": 0.8, "pi:p3:low": 0.7 })[point.id] ?? 0),
    });
    input.recovery = { priorOperatingPointId: "pi:failed:low" };
    const result = await routeTask(input);
    expect(result).toMatchObject({ kind: "admitted" });
    if (result.kind !== "admitted") return;
    // Ranked order puts p0 (same provider as the failed point) first; the
    // different-provider preference moves p2 ahead before the bound.
    expect(result.chain).toEqual(["pi:p2:low", "pi:p0:low", "pi:p3:low"]);
    expect(result.selectedPoint).toMatchObject({ id: "pi:p2:low" });
    expect(result.evidence?.chainExclusions).toEqual([{ id: "pi:failed:low", provider: "shared", reasons: ["recovery_excluded"] }]);
  });

  it("keeps ranked order when no different provider remains after the recovery exclusion", async () => {
    const points = [
      makePoint("pi", "p1", { reasoning: "low", provider: "shared" }),
      makePoint("pi", "p2", { reasoning: "low", provider: "shared" }),
    ];
    const catalog = catalogOf(points);
    const input = baseInput(catalog);
    input.response = responseFor(catalog, {
      fitness: fitnessFor(catalog, (point) => (point.id === "pi:p1:low" ? 0.9 : 0.8)),
    });
    input.recovery = { priorOperatingPointId: "pi:p1:low" };
    // The failed point's provider is the only provider left, so the surviving
    // same-provider point heads the chain — the preference is a no-op.
    const result = await routeTask(input);
    expect(result).toMatchObject({ kind: "admitted", chain: ["pi:p2:low"], selectedPoint: { index: 0, id: "pi:p2:low" } });
    if (result.kind === "admitted") {
      expect(result.evidence?.chainExclusions).toEqual([{ id: "pi:p1:low", provider: "shared", reasons: ["recovery_excluded"] }]);
    }
  });

  it("abstains low_confidence carrying probe evidence when required-resource and exhausted exclusions empty the chain", async () => {
    const catalog = catalogOf([makePoint("pi", "pi-model", { reasoning: "low" }), makePoint("claude", "claude-model", { reasoning: "high" })]);
    const input = baseInput(catalog);
    input.task = { ...TASK, constraints: ["You must use read to complete this assignment."] };
    input.response = responseFor(catalog, {
      fitness: fitnessFor(catalog, (point) => (point.id === "pi:pi-model:low" ? 0.9 : 0.8)),
      resources: { pi: { tools: { read: 0.7 } }, claude: { tools: { Read: 0.95 } } },
    });
    input.availability = async () => availabilityStatus("known-exhausted");
    const result = await routeTask(input);
    // pi drops the required read tool; claude selects it but probes exhausted —
    // the abstain names the resource component and still reports the probe.
    expect(result).toMatchObject({ kind: "abstained", reason: "low_confidence", component: "tools:read" });
    if (result.kind === "abstained") {
      expect(result.evidence?.availability).toEqual([{ id: "claude:claude-model:high", status: "known-exhausted", retryNotBefore: null }]);
      expect(result.evidence?.chainExclusions).toEqual([
        { id: "claude:claude-model:high", provider: "claude-provider", reasons: ["unavailable"] },
        { id: "pi:pi-model:low", provider: "pi-provider", reasons: ["required_resource"] },
      ]);
    }
  });

  it("dedupes one runner's resource exclusions across every candidate on it", async () => {
    const catalog = catalogOf([makePoint("pi", "m1", { reasoning: "low" }), makePoint("pi", "m2", { reasoning: "low" })]);
    const input = baseInput(catalog);
    input.response = responseFor(catalog, { resources: { pi: { tools: { read: 0.95, exec_command: 0.5 } } } });
    const result = await routeTask(input);
    expect(result).toMatchObject({ kind: "admitted", chain: ["pi:m1:low", "pi:m2:low"] });
    // Both pi candidates iterate the same cached selection — the shared
    // exclusion lands in evidence exactly once.
    if (result.kind === "admitted") {
      expect(result.evidence?.exclusions).toEqual([{ field: "tools", name: "exec_command", noul: 0.5 }]);
    }
  });

  it("emits exclusion evidence in stable id order even for duplicate point ids", async () => {
    const points = [
      makePoint("pi", "z1", { reasoning: "low", provider: "a" }),
      makePoint("pi", "a1", { reasoning: "low", provider: "b" }),
      makePoint("pi", "m1", { reasoning: "low", provider: "c" }),
      makePoint("pi", "m1", { reasoning: "low", provider: "d" }),
    ];
    const catalog = catalogOf(points);
    const input = baseInput(catalog);
    input.response = responseFor(catalog);
    input.availability = async () => availabilityStatus("known-exhausted");
    const result = await routeTask(input);
    expect(result).toMatchObject({ kind: "abstained", reason: "no_candidates_at_tier" });
    if (result.kind === "abstained") {
      expect(result.evidence?.chainExclusions?.map((entry) => entry.id)).toEqual(["pi:a1:low", "pi:m1:low", "pi:m1:low", "pi:z1:low"]);
    }
  });

  it("excludes every candidate whose selection drops a task-required resource and abstains when none remain", async () => {
    const piPoint = makePoint("pi", "pi-model", { reasoning: "low" });
    const claudePoint = makePoint("claude", "claude-model", { reasoning: "high" });
    const catalog = catalogOf([piPoint, claudePoint]);
    const requiredTask = { ...TASK, constraints: ["You must use read to complete this assignment."] };

    // The higher-fitness fallback drops the required resource — it is excluded
    // before the bound and the lower-fitness capable point is selected instead.
    const fallback = baseInput(catalog);
    fallback.task = requiredTask;
    fallback.response = responseFor(catalog, {
      fitness: fitnessFor(catalog, (point) => (point.id === "claude:claude-model:high" ? 0.9 : 0.6)),
      resources: { pi: { tools: { read: 0.95 } }, claude: { tools: { Read: 0.7 } } },
    });
    const result = await routeTask(fallback);
    expect(result).toMatchObject({ kind: "admitted", chain: ["pi:pi-model:low"], selectedPoint: { index: 0, id: "pi:pi-model:low" } });
    if (result.kind === "admitted") {
      expect(result.evidence?.chainExclusions).toEqual([{ id: "claude:claude-model:high", provider: "claude-provider", reasons: ["required_resource"] }]);
    }

    // Every candidate dropping the required resource abstains rather than
    // launching under-capable.
    const all = baseInput(catalog);
    all.task = requiredTask;
    all.response = responseFor(catalog, {
      fitness: fitnessFor(catalog, (point) => (point.id === "pi:pi-model:low" ? 0.9 : 0.8)),
      resources: { pi: { tools: { read: 0.7 } }, claude: { tools: { Read: 0.7 } } },
    });
    const abstained = await routeTask(all);
    expect(abstained).toMatchObject({ kind: "abstained", reason: "low_confidence", component: "tools:read" });
    if (abstained.kind === "abstained") {
      expect(abstained.evidence?.chainExclusions).toEqual([
        { id: "claude:claude-model:high", provider: "claude-provider", reasons: ["required_resource"] },
        { id: "pi:pi-model:low", provider: "pi-provider", reasons: ["required_resource"] },
      ]);
    }
  });
});
