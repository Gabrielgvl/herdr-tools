import { describe, expect, it, vi } from "vitest";
import type { CandidateAvailability } from "../../src/availability.js";
import type { Catalog, OperatingPoint, RunnerEntry, RunnerKind } from "../../src/catalog.js";
import { CompileError, type CompiledContract, type ResourceSelection } from "../../src/compile.js";
import { POLICY_REVISION, type QualityTier } from "../../src/routing-policy.js";
import { routeTask, runnerResourceSelection, type RoutingTask, type TaskModelDecision, type TaskRouteInput } from "../../src/router.js";

const TASK: RoutingTask = { objective: "Fix it", scope: "src", doneWhen: ["test passes"], constraints: [] };
function runner(kind: RunnerKind, models: string[]): RunnerEntry {
  const defaults: RunnerEntry["defaults"] = kind === "pi"
    ? { timeoutMinutes: 30, sessionPersistence: false, thinking: "low" }
    : kind === "claude"
      ? { timeoutMinutes: 30, sessionPersistence: true, effort: "low", permissionMode: "dontAsk" }
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
    quota: { provider: `${kind}-provider`, billingProduct: kind, account: "primary", scope: "account" },
    defaults,
    plumbing,
    pools: { tools: kind === "pi" ? ["read", "bash", "edit", "write", "ask_user_question", "mcp__executor__execute", "mcp__executor__skills", "mcp__executor__resume", "mcp__hindsight__hindsight_sync_status", "mcp__hindsight__hindsight_diagnose", "mcp__hindsight__hindsight_search_knowledge_pages", "mcp__hindsight__hindsight_list_knowledge_pages", "mcp__hindsight__hindsight_read_knowledge_page", "mcp__hindsight__hindsight_reflect", "mcp__hindsight__hindsight_capture_initiative", "mcp__hindsight__hindsight_ingest_document", "extra"] : kind === "claude" ? ["Read", "Bash", "Write", "Extra"] : [], extensions: [], skills: [], plugins: [], mcp: [] },
  };
}

function point(id: string, runnerKind: RunnerKind, model: string, provider: string): OperatingPoint {
  return {
    id,
    runner: runnerKind,
    model,
    ...(runnerKind === "pi" || runnerKind === "claude" ? { reasoning: "low" as const } : {}),
    provider,
    quota: { provider, billingProduct: provider, account: "primary", scope: "account" },
    costClass: "low",
    latencyClass: "low",
  };
}

const POINTS = [
  point("pi:u:low", "pi", "u", "p-u"),
  point("devin:e", "devin", "e", "p-e"),
  point("pi:s:low", "pi", "s", "p-s"),
  point("claude:s2:low", "claude", "s2", "p-s2"),
  point("agy:h", "agy", "h", "p-h"),
  point("pi:f:low", "pi", "f", "p-f"),
  point("claude:m:low", "claude", "m", "p-m"),
] satisfies OperatingPoint[];

function catalog(points: readonly OperatingPoint[] = POINTS): Catalog {
  const runners = new Map<RunnerKind, RunnerEntry>();
  for (const kind of ["pi", "claude", "agy", "devin"] as const) {
    const models = points.filter((entry) => entry.runner === kind).map((entry) => entry.model);
    if (models.length > 0) runners.set(kind, runner(kind, models));
  }
  return {
    version: 2,
    runners,
    skills: [],
    plugins: [],
    mcpServers: new Map(),
    quotaSources: [{ name: "reactive", kind: "floor" }],
    points,
    tierChains: {
      utility: ["pi:u:low"],
      economy: ["devin:e"],
      standard: ["pi:s:low", "claude:s2:low"],
      strong: ["agy:h"],
      frontier: ["pi:f:low"],
      max: ["claude:m:low"],
    },
    source: { path: "/tmp/catalog.yaml", scopeRoot: "/tmp" },
  };
}

function response(patch: Partial<TaskModelDecision> = {}): TaskModelDecision {
  return {
    quality: { done_when_verifiable: 0.9 },
    intent: { value: "implement", confidence: 0.9 },
    tier: { value: "economy", confidence: 0.1 },
    ...patch,
  };
}

function compiled(resolved: { index: number; point: OperatingPoint }, selection: ResourceSelection = {}): CompiledContract {
  return {
    specLabel: "task",
    candidate: { index: resolved.index, id: resolved.point.id, runner: resolved.point.runner, model: resolved.point.model, ...(resolved.point.reasoning === undefined ? {} : { reasoning: resolved.point.reasoning }) },
    quota: resolved.point.quota,
    scopeRoot: "/tmp",
    sessionPersistence: false,
    timeoutMinutes: 30,
    plumbing: { sessionPersistence: "optional", promptDelivery: "file", skillSelection: "exact", toolSelection: "allowlist" },
    runtime: { kind: "pi", model: resolved.point.model, thinking: "low", tools: [...(selection.tools ?? [])], extensions: [], skills: [] },
    resources: {},
    derivations: [],
    gaps: [],
  };
}

const status = (value: CandidateAvailability["status"]): CandidateAvailability => ({ status: value, retryNotBefore: null, evidence: { records: value === "unknown" ? 0 : 1 } });

function input(overrides: Partial<TaskRouteInput> = {}): TaskRouteInput {
  return {
    task: TASK,
    spec: { label: "task", count: 2 },
    catalog: catalog(),
    response: response(),
    availability: async () => status("unknown"),
    compile: async (_catalog, _spec, resolved, selection) => compiled(resolved, selection),
    ...overrides,
  };
}

describe("tier-chain routing", () => {
  it("uses max(caller, Jev), then walks that tier and stronger authoritative chains without an attempt cap", async () => {
    const seen: ResourceSelection[] = [];
    const result = await routeTask(input({
      task: { ...TASK, tier: "standard" },
      compile: async (_catalog, _spec, resolved, selection) => (seen.push(selection), compiled(resolved, selection)),
    }));
    expect(result).toMatchObject({
      kind: "admitted",
      count: 2,
      requestedTier: "standard",
      workloadFloor: "economy",
      effectiveStartTier: "standard",
      effectiveCeiling: "max",
      chain: ["pi:s:low", "claude:s2:low", "agy:h", "pi:f:low", "claude:m:low"],
      selectedPoint: { id: "pi:s:low", index: 0 },
      evidence: { policyRevision: POLICY_REVISION, intent: { value: "implement" } },
    });
    expect(seen).toEqual([{ tools: ["read", "bash", "edit", "write", "ask_user_question", "mcp__executor__execute", "mcp__executor__skills", "mcp__executor__resume", "mcp__hindsight__hindsight_sync_status", "mcp__hindsight__hindsight_diagnose", "mcp__hindsight__hindsight_search_knowledge_pages", "mcp__hindsight__hindsight_list_knowledge_pages", "mcp__hindsight__hindsight_read_knowledge_page", "mcp__hindsight__hindsight_reflect", "mcp__hindsight__hindsight_capture_initiative", "mcp__hindsight__hindsight_ingest_document"] }]);
  });

  it("deduplicates operating points repeated across tier segments", async () => {
    const source = catalog();
    const repeated: Catalog = {
      ...source,
      tierChains: { ...source.tierChains!, max: ["pi:f:low", "claude:m:low"] },
    };
    const result = await routeTask(input({
      catalog: repeated,
      response: response({ tier: { value: "frontier", confidence: 0.9 } }),
    }));
    expect(result).toMatchObject({ kind: "admitted", chain: ["pi:f:low", "claude:m:low"] });
  });

  it("accepts low tier confidence, keeps the top low-confidence intent, and validates optional distributions", async () => {
    const intentProbabilities = { explore: 0, reason: 0, implement: 0, debug: 1, verify: 0, review: 0, coordinate: 0 };
    const tierProbabilities = { utility: 0, economy: 0, standard: 0, strong: 0, frontier: 1, max: 0 };
    const result = await routeTask(input({ response: response({ intent: { value: "debug", confidence: 0.2, probabilities: intentProbabilities }, tier: { value: "frontier", confidence: 0, probabilities: tierProbabilities } }) }));
    expect(result).toMatchObject({ kind: "admitted", effectiveStartTier: "frontier", evidence: { policyRevision: "adr-037-p6", intent: { value: "debug", confidence: 0.2, probabilities: intentProbabilities }, workload: { intent: "debug" } } });

    // A persisted historical unknown intent stays readable.
    await expect(routeTask(input({ response: response({ intent: { value: "unknown", confidence: 0.9 } }) }))).resolves.toMatchObject({ kind: "admitted", evidence: { intent: { value: "unknown" }, workload: { intent: "unknown" } } });

    const malformed = [
      null,
      {},
      { ghost: 0, reason: 0, implement: 0, debug: 1, verify: 0, review: 0, coordinate: 0 },
      { ...intentProbabilities, debug: 2 },
      { ...intentProbabilities, debug: 0.5 },
    ];
    for (const probabilities of malformed) {
      await expect(routeTask(input({ response: response({ intent: { value: "debug", confidence: 0.9, probabilities } as never }) }))).resolves.toMatchObject({ kind: "abstained", component: "intent" });
    }
    await expect(routeTask(input({ response: response({ tier: { value: "frontier", confidence: 0.9, probabilities: {} } as never }) }))).resolves.toMatchObject({ kind: "abstained", component: "tier" });
  });

  it("rejects only a confident bad done-when answer and validates semantic fields", async () => {
    await expect(routeTask(input({ response: { quality: { done_when_verifiable: 0.1 } } }))).resolves.toMatchObject({ kind: "rejected", reason: "done_when_unverifiable" });
    for (const [bad, component] of [
      [null, "quality"],
      [{ quality: {} }, "quality"],
      [response({ intent: "bogus" }), "intent"],
      [response({ tier: "bogus" as QualityTier }), "tier"],
    ] as const) {
      await expect(routeTask(input({ response: bad }))).resolves.toMatchObject({ kind: "abstained", reason: "invalid_response", component });
    }
    await expect(routeTask(input({ response: { quality: { done_when_verifiable: 0.9 }, transport: true } }))).resolves.toMatchObject({ kind: "abstained", reason: "transport_failed", component: "transport" });
    await expect(routeTask(input({ response: { quality: { done_when_verifiable: 0.9 }, transport: true, component: "http_503" } }))).resolves.toMatchObject({ component: "http_503" });
    await expect(routeTask(input({ response: { quality: { done_when_verifiable: 0.9 }, transport: true, component: "bad\nvalue" } }))).resolves.toMatchObject({ component: "transport" });
    for (const [probability, label] of [[0.6, "partial"], [0.3, "weak"]] as const) {
      await expect(routeTask(input({ response: response({ quality: { done_when_verifiable: probability } }) }))).resolves.toMatchObject({ kind: "admitted", evidence: { workload: { verifiability: label } } });
    }
  });

  it("lets Jev's floor decide an omitted tier and caps an explicit request one tier above it", async () => {
    const omitted = await routeTask(input());
    expect(omitted).toMatchObject({ kind: "admitted", workloadFloor: "economy", effectiveStartTier: "economy", chain: ["devin:e", "pi:s:low", "claude:s2:low", "agy:h", "pi:f:low", "claude:m:low"] });
    expect(omitted).not.toHaveProperty("requestedTier");
    await expect(routeTask(input({ task: { ...TASK, tier: "frontier" } }))).resolves.toMatchObject({ requestedTier: "frontier", workloadFloor: "economy", effectiveStartTier: "standard" });
    // A recovery minimum is not capped: prior route strong starts recovery at frontier.
    await expect(routeTask(input({ task: { ...TASK, tier: "economy" }, recovery: { priorOperatingPointId: "claude:m:low", priorRouteTier: "strong" } }))).resolves.toMatchObject({ requestedTier: "economy", effectiveStartTier: "frontier", chain: ["pi:f:low"] });
  });

  it("excludes the failed provider across all stronger tiers during recovery", async () => {
    const repeated = catalog(POINTS.map((entry) => entry.id === "pi:f:low" ? { ...entry, provider: "p-s", quota: { ...entry.quota, provider: "p-s", billingProduct: "p-s" } } : entry));
    // Prior route economy: recovery starts one tier higher, at standard.
    const result = await routeTask(input({ catalog: repeated, recovery: { priorOperatingPointId: "pi:s:low", priorRouteTier: "economy" } }));
    expect(result).toMatchObject({ kind: "admitted", effectiveStartTier: "standard", chain: ["claude:s2:low", "agy:h", "claude:m:low"] });
    if (result.kind === "admitted") expect(result.evidence.chainExclusions?.map((entry) => entry.id)).toEqual(["pi:s:low", "pi:f:low"]);
    await expect(routeTask(input({ recovery: { priorOperatingPointId: "missing", priorRouteTier: "economy" } }))).resolves.toMatchObject({ kind: "abstained", component: "recovery" });
  });

  it("keeps the prior route tier on a provider-limit recovery and still excludes the limited provider", async () => {
    // Prior route standard on p-s2: a limited provider says nothing about
    // task difficulty, so the start stays standard instead of lifting.
    const result = await routeTask(input({ recovery: { priorOperatingPointId: "claude:s2:low", priorRouteTier: "standard", priorFailureCause: "provider_limit" } }));
    expect(result).toMatchObject({ kind: "admitted", effectiveStartTier: "standard", chain: ["pi:s:low", "agy:h", "pi:f:low", "claude:m:low"] });
    if (result.kind === "admitted") expect(result.evidence.chainExclusions).toEqual([{ id: "claude:s2:low", provider: "p-s2", reasons: ["recovery_excluded"] }]);
    // Every other recovery cause — an absent cause included — keeps the lift.
    await expect(routeTask(input({ recovery: { priorOperatingPointId: "claude:s2:low", priorRouteTier: "standard" } }))).resolves.toMatchObject({ effectiveStartTier: "strong", chain: ["agy:h", "pi:f:low", "claude:m:low"] });
  });

  it("skips known-unavailable quota domains and local-capacity runners within one admission", async () => {
    const repeated = catalog(POINTS.map((entry) => entry.id === "pi:f:low" ? { ...entry, quota: { ...POINTS[2]!.quota }, provider: POINTS[2]!.provider } : entry));
    const calls: string[] = [];
    const result = await routeTask(input({
      task: { ...TASK, tier: "standard" },
      catalog: repeated,
      availability: async ({ model }) => {
        calls.push(model);
        return status(model === "s" ? "known-exhausted" : model === "s2" ? "local-capacity-limited" : "unknown");
      },
    }));
    expect(result).toMatchObject({ kind: "admitted", chain: ["agy:h"] });
    expect(calls).toEqual(["s", "s2", "h"]);
  });

  it("returns typed exhaustion and availability failures", async () => {
    await expect(routeTask(input({ availability: async () => status("known-exhausted") }))).resolves.toMatchObject({ kind: "abstained", reason: "no_candidates_at_tier" });
    await expect(routeTask(input({ availability: async () => status("local-capacity-limited") }))).resolves.toMatchObject({ kind: "abstained", reason: "transport_failed", component: "availability" });
    await expect(routeTask(input({ availability: async () => { throw new Error("down"); } }))).resolves.toMatchObject({ kind: "abstained", reason: "transport_failed", component: "availability" });
    const noGate = input();
    delete noGate.availability;
    delete noGate.root;
    await expect(routeTask(noGate)).resolves.toMatchObject({ kind: "abstained", reason: "transport_failed", component: "availability" });
  });

  it("fails closed on missing chain policy, missing points/runners, and unusable compile results", async () => {
    const noChains = catalog();
    delete noChains.tierChains;
    await expect(routeTask(input({ catalog: noChains }))).resolves.toMatchObject({ kind: "abstained", reason: "catalog_unavailable", component: "tierChains" });
    await expect(routeTask(input({ catalog: { ...catalog(), points: [] } }))).resolves.toMatchObject({ kind: "abstained", component: "tierChains" });
    const noPoints = catalog();
    delete noPoints.points;
    await expect(routeTask(input({ catalog: noPoints }))).resolves.toMatchObject({ kind: "abstained", component: "tierChains" });
    const missingPoint = catalog();
    missingPoint.tierChains = { ...missingPoint.tierChains!, standard: ["missing"] };
    await expect(routeTask(input({ catalog: missingPoint }))).resolves.toMatchObject({ kind: "abstained", component: "tierChains" });
    const missingRunner = catalog();
    missingRunner.runners = new Map([...missingRunner.runners].filter(([kind]) => kind !== "pi"));
    await expect(routeTask(input({ catalog: missingRunner }))).resolves.toMatchObject({ kind: "abstained", component: "catalog" });
    await expect(routeTask(input({ compile: async () => { throw new CompileError("INVALID_SELECTION", "bad"); } }))).resolves.toMatchObject({ kind: "abstained", reason: "invalid_response", component: "candidates" });
    await expect(routeTask(input({ compile: async () => { throw new Error("bad"); } }))).resolves.toMatchObject({ kind: "abstained", reason: "catalog_unavailable", component: "configuration" });
  });

  it("pins pi lanes to native MCP tool names, filtered by the reviewed pool", () => {
    expect(runnerResourceSelection(response(), "pi")).toEqual({ tools: ["read", "bash", "edit", "write", "ask_user_question", "mcp__executor__execute", "mcp__executor__skills", "mcp__executor__resume", "mcp__hindsight__hindsight_sync_status", "mcp__hindsight__hindsight_diagnose", "mcp__hindsight__hindsight_search_knowledge_pages", "mcp__hindsight__hindsight_list_knowledge_pages", "mcp__hindsight__hindsight_read_knowledge_page", "mcp__hindsight__hindsight_reflect", "mcp__hindsight__hindsight_capture_initiative", "mcp__hindsight__hindsight_ingest_document"] });
    expect(runnerResourceSelection(response(), "claude")).toEqual({ tools: ["Read", "Bash", "Write"], mcp: ["executor", "hindsight"] });
    expect(runnerResourceSelection(response(), "agy")).toEqual({});
    // A pool that does not carry the gateway recipe degrades to the natives alone.
    const sparse = runner("pi", ["x"]);
    sparse.pools = { ...sparse.pools, tools: ["read", "mcp__executor__execute"] };
    expect(runnerResourceSelection(response(), "pi", sparse)).toEqual({ tools: ["read", "mcp__executor__execute"] });
  });

  it("handles empty recovery candidates, degraded candidates, root/clock options, and default replica count", async () => {
    const one = point("pi:s:low", "pi", "s", "p-s");
    const only = catalog([one]);
    only.tierChains = { utility: [], economy: [], standard: [one.id], strong: [], frontier: [], max: [] };
    await expect(routeTask(input({ catalog: only, recovery: { priorOperatingPointId: one.id, priorRouteTier: "economy" } }))).resolves.toMatchObject({ kind: "abstained", reason: "no_candidates_at_tier" });
    await expect(routeTask(input({ availability: async () => status("degraded") }))).resolves.toMatchObject({ kind: "admitted" });
    const now = new Date("2026-01-01T00:00:00.000Z");
    const options = vi.fn(async () => status("unknown"));
    const withoutCount = input({ root: "/tmp", now: () => now, availability: options, spec: { label: "task" } });
    await expect(routeTask(withoutCount)).resolves.toMatchObject({ kind: "admitted", count: 1 });
    expect(options).toHaveBeenCalled();
  });

  it("admits an exact post-gate operatingPoint as the whole chain", async () => {
    const result = await routeTask(input({ operatingPoint: "claude:s2:low" }));
    expect(result).toMatchObject({
      kind: "admitted",
      chain: ["claude:s2:low"],
      selectedPoint: { id: "claude:s2:low", index: 0 },
      configuration: { candidate: { id: "claude:s2:low" } },
    });
  });

  it("refuses an explicit operatingPoint absent from the surviving admissible set", async () => {
    const refused = { kind: "abstained", reason: "no_candidates_at_tier", component: "operatingPoint" } as const;
    // An unknown id.
    await expect(routeTask(input({ operatingPoint: "pi:unknown:low" }))).resolves.toMatchObject(refused);
    // A point below the workload floor's admissible union.
    await expect(routeTask(input({ operatingPoint: "pi:u:low" }))).resolves.toMatchObject(refused);
    // A point below the start an explicit-tier raise produced.
    await expect(routeTask(input({ task: { ...TASK, tier: "strong" }, operatingPoint: "devin:e" }))).resolves.toMatchObject(refused);
    // Excluded by recovery lineage while other points survive.
    await expect(routeTask(input({ recovery: { priorOperatingPointId: "pi:s:low", priorRouteTier: "economy" }, operatingPoint: "pi:s:low" }))).resolves.toMatchObject(refused);
    // Probed known-exhausted.
    await expect(routeTask(input({ operatingPoint: "pi:s:low", availability: async ({ model }) => status(model === "s" ? "known-exhausted" : "unknown") }))).resolves.toMatchObject(refused);
    // Skipped without a probe as an exhausted quota sibling.
    const sibling = catalog(POINTS.map((entry) => entry.id === "pi:f:low" ? { ...entry, quota: { ...POINTS[2]!.quota }, provider: POINTS[2]!.provider } : entry));
    await expect(routeTask(input({ catalog: sibling, operatingPoint: "pi:f:low", availability: async ({ model }) => status(model === "s" ? "known-exhausted" : "unknown") }))).resolves.toMatchObject(refused);
  });

  it("keeps the original early-refusal shapes when an explicit operatingPoint is set", async () => {
    // Recovery emptying the candidate set refuses before selection runs.
    const one = point("pi:s:low", "pi", "s", "p-s");
    const only = catalog([one]);
    only.tierChains = { utility: [], economy: [], standard: [one.id], strong: [], frontier: [], max: [] };
    const candidatesEmpty = await routeTask(input({ catalog: only, recovery: { priorOperatingPointId: one.id, priorRouteTier: "economy" }, operatingPoint: "claude:m:low" }));
    expect(candidatesEmpty).toMatchObject({ kind: "abstained", reason: "no_candidates_at_tier" });
    expect(candidatesEmpty).not.toHaveProperty("component");
    expect(candidatesEmpty).not.toHaveProperty("selectedPoint");
    // Total quota exhaustion keeps its refusal shape.
    const exhausted = await routeTask(input({ availability: async () => status("known-exhausted"), operatingPoint: "claude:m:low" }));
    expect(exhausted).toMatchObject({ kind: "abstained", reason: "no_candidates_at_tier" });
    expect(exhausted).not.toHaveProperty("component");
    expect(exhausted).not.toHaveProperty("selectedPoint");
    // Total local-capacity exhaustion stays transport_failed/availability.
    await expect(routeTask(input({ availability: async () => status("local-capacity-limited"), operatingPoint: "claude:m:low" }))).resolves.toMatchObject({ kind: "abstained", reason: "transport_failed", component: "availability" });
  });
});
