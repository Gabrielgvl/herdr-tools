import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { availability, recordLaunchFailure, type CandidateAvailability } from "../../src/availability.js";
import type { Catalog, ChainCandidate, RunnerEntry, RunnerKind } from "../../src/catalog.js";
import { CompileError, type CompiledContract, type ResourceSelection } from "../../src/compile.js";
import type { LaunchSpec } from "../../src/launch-schema.js";
import {
  COMPOSITION_ADVISORY_THRESHOLD,
  ROUTER_CONFIDENCE_THRESHOLD,
  assembleSpecDecision,
  createBypassReceipt,
  replayBypassReceipt,
  routeSpec,
  type AbstainReason,
  type Abstained,
  type BypassReceipt,
  type RouterBinding,
  type SpecRouteInput,
} from "../../src/router.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const SHARED_QUOTA = { provider: "test-provider", billingProduct: "test-product", account: "test-account", scope: "project" };

const SPEC: LaunchSpec = {
  label: "worker",
  instructions: "Reduce the latency.",
  assignment: { objective: "Reduce the latency.", scope: "Only the test fixture.", verification: "Run the focused tests." },
  count: 2,
};

const BINDING: RouterBinding = {
  caller: "oom-hunt",
  specRevision: "spec-1",
  policyRevision: "adr-035-b6",
  launchIdentity: "launch-1",
};

function runner(kind: RunnerKind, model: string, quota = SHARED_QUOTA): RunnerEntry {
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
    models: [model],
    quota,
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

function catalogOf(chain: readonly ChainCandidate[]): Catalog {
  const runners = new Map<RunnerKind, RunnerEntry>();
  for (const candidate of chain) {
    if (!runners.has(candidate.runner)) runners.set(candidate.runner, runner(candidate.runner, candidate.model));
  }
  return {
    version: 1,
    maxAttempts: 4,
    categories: new Map([["worker", [...chain]]]),
    runners,
    skills: [],
    plugins: [],
    mcpServers: new Map(),
    quotaSources: [{ name: "reactive-cooldowns", kind: "floor" }],
    source: { path: "/tmp/catalog.yaml", scopeRoot: "/tmp" },
  };
}

const SINGLE_CATALOG = catalogOf([{ runner: "pi", model: "pi-model" }]);

function configuration(index = 0, model = "pi-model", specLabel = SPEC.label): CompiledContract {
  return {
    specLabel,
    candidate: { index, runner: "pi", model },
    quota: SHARED_QUOTA,
    scopeRoot: "/tmp",
    sessionPersistence: false,
    timeoutMinutes: 30,
    plumbing: { sessionPersistence: "optional", promptDelivery: "file", skillSelection: "exact", toolSelection: "allowlist" },
    runtime: { kind: "pi", model, thinking: "low", tools: ["read"], extensions: [], skills: [] },
    resources: {
      tools: { installed: ["read"], selected: ["read"], exposed: ["read"], permitted: ["read"], denied: [] },
    },
    derivations: [],
    gaps: [],
  };
}

function responseFor(catalog: Catalog, category = "worker", confidence = 0.9): Record<string, unknown> {
  return {
    quality: { instructions_adequate: 0.9, assignment_verifiable: 0.9 },
    category: { category, confidence },
    candidates: (catalog.categories.get(category) ?? []).map((candidate, index) => ({
      index,
      runner: candidate.runner,
      model: candidate.model,
      selection: candidate.runner === "pi" ? { tools: ["read"] } : {},
    })),
  };
}

function availabilityStatus(status: CandidateAvailability["status"]): CandidateAvailability {
  return { status, retryNotBefore: null, evidence: { records: status === "unknown" ? 0 : 1 } };
}

function baseInput(catalog: Catalog = SINGLE_CATALOG): SpecRouteInput {
  return {
    spec: SPEC,
    catalog,
    response: responseFor(catalog),
    root: "/tmp/router-test-root",
    availability: async () => availabilityStatus("unknown"),
    compile: async (_catalog, _spec, resolved) => configuration(resolved.index, resolved.candidate.model),
  };
}

const GOOD_QUALITY = { instructions_adequate: 0.9, assignment_verifiable: 0.9 };

function recordedAbstention(reason: AbstainReason = "transport_failed"): Abstained {
  return { kind: "abstained", reason, component: "fixture" };
}

describe("per-spec router policy", () => {
  it("keeps the policy confidence threshold at 0.8 and admits with not_rejected evidence", async () => {
    expect(ROUTER_CONFIDENCE_THRESHOLD).toBe(0.8);
    const seen: ResourceSelection[] = [];
    const input = baseInput();
    input.compile = async (_catalog, _spec, resolved, selection) => {
      seen.push(selection);
      return configuration(resolved.index, resolved.candidate.model);
    };

    const result = await routeSpec(input);

    expect(result).toMatchObject({ kind: "admitted", quality: "not_rejected", category: "worker", count: 2 });
    expect(result.evidence).toMatchObject({
      quality: { outcome: "not_rejected", instructions_adequate: 0.9, assignment_verifiable: 0.9 },
      category: { name: "worker", confidence: 0.9 },
      selectedCandidate: { index: 0, runner: "pi", model: "pi-model" },
      availability: [{ index: 0, status: "unknown", retryNotBefore: null }],
    });
    expect(seen).toEqual([{ tools: ["read"] }]);
    expect(JSON.stringify(result)).not.toContain("certified");
  });

  it("rejects a confident quality failure before assembling an admission", () => {
    const result = assembleSpecDecision({
      spec: SPEC,
      quality: { instructions_adequate: { probability: 0.1, confidence: 0.9 }, assignment_verifiable: { probability: 0.9, confidence: 0.9 } },
      category: "worker",
      configuration: configuration(),
    });

    expect(result).toEqual({
      kind: "rejected",
      quality: "rejected",
      reason: "instructions_inadequate",
      evidence: { quality: { outcome: "rejected", instructions_adequate: 0.1, assignment_verifiable: 0.9 } },
    });
  });

  it("preserves the complete abstention reason taxonomy without partial output", () => {
    const reasons: readonly AbstainReason[] = [
      "low_confidence",
      "no_assignments",
      "catalog_unavailable",
      "invalid_response",
      "authentication_unavailable",
      "transport_failed",
      "aborted",
    ];

    for (const reason of reasons) {
      const result = assembleSpecDecision({
        spec: SPEC,
        quality: GOOD_QUALITY,
        category: "worker",
        configuration: configuration(),
        abstention: recordedAbstention(reason),
      });
      expect(result).toEqual(recordedAbstention(reason));
      expect(JSON.stringify(result)).not.toContain("pi-model");
    }
  });

  it("fails closed for missing quality, low category confidence, and malformed candidates", async () => {
    const missingQuality = baseInput();
    missingQuality.response = responseFor(SINGLE_CATALOG);
    delete (missingQuality.response as Record<string, unknown>).quality;
    await expect(routeSpec(missingQuality)).resolves.toMatchObject({ kind: "abstained", reason: "invalid_response", component: "quality" });

    const lowCategory = baseInput();
    lowCategory.response = responseFor(SINGLE_CATALOG, "worker", 0.799);
    await expect(routeSpec(lowCategory)).resolves.toMatchObject({ kind: "abstained", reason: "low_confidence", component: "category" });

    const malformedCandidates = baseInput();
    malformedCandidates.response = { ...responseFor(SINGLE_CATALOG), candidates: [] };
    await expect(routeSpec(malformedCandidates)).resolves.toMatchObject({ kind: "abstained", reason: "invalid_response", component: "candidates" });
  });

  it("reports no_assignments for exhausted candidates and transport_failed for local capacity", async () => {
    const exhausted = baseInput();
    exhausted.availability = async () => availabilityStatus("known-exhausted");
    await expect(routeSpec(exhausted)).resolves.toMatchObject({ kind: "abstained", reason: "no_assignments" });

    const local = baseInput();
    local.availability = async () => availabilityStatus("local-capacity-limited");
    await expect(routeSpec(local)).resolves.toMatchObject({ kind: "abstained", reason: "transport_failed", component: "availability" });
  });

  it("returns transport_failed when availability or transport evidence cannot be trusted", async () => {
    const unavailable = baseInput();
    unavailable.availability = async () => { throw new Error("availability read failed"); };
    await expect(routeSpec(unavailable)).resolves.toMatchObject({ kind: "abstained", reason: "transport_failed", component: "availability" });

    const transport = baseInput();
    transport.response = { ...responseFor(SINGLE_CATALOG), transport: { failed: true, component: "router-http" } };
    await expect(routeSpec(transport)).resolves.toMatchObject({ kind: "abstained", reason: "transport_failed", component: "router-http" });
  });

  it("rejects a spec even when a valid bypass receipt is presented", async () => {
    const receipt = createBypassReceipt({
      binding: BINDING,
      abstention: recordedAbstention(),
      configuration: configuration(),
      recorded: true,
    });
    const input = baseInput();
    input.binding = BINDING;
    input.bypass = receipt;
    input.response = {
      quality: { instructions_adequate: 0.1, assignment_verifiable: 0.9 },
      category: { category: "worker", confidence: 0.9 },
    };

    await expect(routeSpec(input)).resolves.toMatchObject({ kind: "rejected", quality: "rejected", reason: "instructions_inadequate" });
  });

  it("requires a recorded transport abstention and replays a receipt deterministically", async () => {
    const abstention = recordedAbstention();
    expect(() => createBypassReceipt({ binding: BINDING, abstention, configuration: configuration() })).toThrow(/recorded transport abstention/);
    expect(() => createBypassReceipt({ binding: BINDING, abstention: recordedAbstention("no_assignments"), configuration: configuration(), recorded: true })).toThrow(/recorded transport abstention/);

    const receipt = createBypassReceipt({ binding: BINDING, abstention, configuration: configuration(), category: "worker", count: 2, recordedAbstention: true });
    const first = replayBypassReceipt(receipt, BINDING);
    const second = replayBypassReceipt(receipt, BINDING);
    expect(first).toEqual(second);
    first.category = "mutated-after-replay";
    expect(replayBypassReceipt(receipt, BINDING)).toEqual(receipt.result);

    const input = baseInput();
    input.binding = BINDING;
    input.bypass = receipt;
    input.response = null;
    input.availability = async () => { throw new Error("bypass must not re-read availability"); };
    input.compile = async () => { throw new Error("bypass must not recompile"); };
    await expect(routeSpec(input)).resolves.toEqual(receipt.result);
  });

  it("labels a transport-abstain bypass as quality not_evaluated", () => {
    const receipt = createBypassReceipt({ binding: BINDING, abstention: recordedAbstention("transport_failed"), configuration: configuration(), recorded: true });
    expect(receipt.result).toMatchObject({
      kind: "admitted",
      quality: "not_evaluated",
      evidence: { quality: { outcome: "not_evaluated" }, bypass: { label: "transport-abstain", quality: "not_evaluated" } },
    });
    expect(replayBypassReceipt(receipt, BINDING)).toEqual(receipt.result);
  });

  it("consumes availability without runner-name bias", async () => {
    const chain: readonly ChainCandidate[] = [
      { runner: "pi", model: "shared-model" },
      { runner: "claude", model: "shared-model" },
    ];
    const catalog = catalogOf(chain);
    const root = await mkdtemp(join(tmpdir(), "herdr-router-availability-"));
    dirs.push(root);
    const first = chain[0]!;
    const second = chain[1]!;
    const pi = catalog.runners.get("pi")!;
    const claude = catalog.runners.get("claude")!;
    const now = () => new Date("2026-09-18T10:00:00.000Z");

    await recordLaunchFailure(first, pi, "quota_exceeded", { root, now });
    await expect(availability(first, pi, { root, now })).resolves.toMatchObject({ status: "known-exhausted", retryNotBefore: null });
    await expect(availability(second, claude, { root, now })).resolves.toMatchObject({ status: "known-exhausted", retryNotBefore: null });

    const seen: CandidateAvailability[] = [];
    const result = await routeSpec({
      spec: SPEC,
      catalog,
      response: responseFor(catalog),
      root,
      now,
      availability: async (candidate, runnerEntry, options) => {
        const value = await availability(candidate, runnerEntry, options);
        seen.push(value);
        return value;
      },
      compile: async () => { throw new Error("an exhausted chain must not compile"); },
    });

    expect(result).toMatchObject({ kind: "abstained", reason: "no_assignments" });
    expect(seen.map((value) => value.status)).toEqual(["known-exhausted", "known-exhausted"]);
    if (result.kind === "abstained") expect(result.evidence?.availability?.map((value) => value.status)).toEqual(["known-exhausted", "known-exhausted"]);
  });
});

describe("response boundary parsing", () => {
  const respond = (patch: Record<string, unknown>): SpecRouteInput => {
    const input = baseInput();
    input.response = { ...responseFor(SINGLE_CATALOG), ...patch };
    return input;
  };
  const respondedWith = (response: unknown): SpecRouteInput => {
    const input = baseInput();
    input.response = response;
    return input;
  };
  const invalid = (component: string): Record<string, unknown> => ({ kind: "abstained", reason: "invalid_response", component });
  const admitted = { kind: "admitted" };
  const candidateEntry = (selection: Record<string, unknown>): Record<string, unknown> => ({ index: 0, runner: "pi", model: "pi-model", ...selection });
  const withEntry = (entry: Record<string, unknown>): SpecRouteInput => respondedWith({ ...responseFor(SINGLE_CATALOG), candidates: [entry] });

  for (const { name, value, expected } of [
    { name: "bare true", value: true, expected: admitted },
    { name: "bare false", value: false, expected: { kind: "rejected", reason: "instructions_inadequate" } },
    { name: "noul key", value: { noul: 0.9 }, expected: admitted },
    { name: "yes key", value: { yes: 0.9 }, expected: admitted },
    { name: "numeric value key", value: { value: 0.9 }, expected: admitted },
    { name: "boolean value key", value: { value: true }, expected: admitted },
    { name: "boolean value key false", value: { value: false }, expected: { kind: "rejected", reason: "instructions_inadequate" } },
    { name: "choice yes", value: { choice: "yes" }, expected: admitted },
    { name: "choice no", value: { choice: "no" }, expected: { kind: "rejected", reason: "instructions_inadequate" } },
    { name: "foreign choice", value: { choice: "maybe" }, expected: invalid("quality") },
    { name: "yes/no probability map", value: { probabilities: { yes: 0.9, no: 0.1 } }, expected: admitted },
    { name: "true/false probability map", value: { probabilities: { true: 0.9, false: 0.1 } }, expected: admitted },
    { name: "adequate/inadequate probability map", value: { probabilities: { adequate: 0.9, inadequate: 0.1 } }, expected: admitted },
    { name: "probability map that does not sum", value: { probabilities: { yes: 0.5, no: 0.6 } }, expected: invalid("quality") },
    { name: "probability map with a non-probability value", value: { probabilities: { yes: "x", no: 0.1 } }, expected: invalid("quality") },
    { name: "probability map with a non-probability complement", value: { probabilities: { yes: 0.9, no: "x" } }, expected: invalid("quality") },
    { name: "explicit confidence override", value: { probability: 0.9, confidence: 0.7 }, expected: admitted },
    { name: "out-of-range confidence", value: { probability: 0.9, confidence: 2 }, expected: invalid("quality") },
    { name: "free text", value: "text", expected: invalid("quality") },
  ]) {
    it(`parses quality operand shape: ${name}`, async () => {
      const result = await routeSpec(respond({ quality: { instructions_adequate: value, assignment_verifiable: 0.9 } }));
      expect(result).toMatchObject(expected);
    });
  }

  it("reads the quality object, camelCase aliases, and keeps only parseable rejection evidence", async () => {
    await expect(routeSpec(respond({ quality: 5 }))).resolves.toMatchObject(invalid("quality"));
    await expect(routeSpec(respond({ quality: { instructionsAdequate: 0.9, assignmentVerifiable: 0.9 } }))).resolves.toMatchObject(admitted);
    await expect(routeSpec(respond({ quality: { instructions_adequate: 0.9, assignment_verifiable: 0.05 } }))).resolves.toMatchObject({ kind: "rejected", reason: "assignment_unverifiable" });
    const partial = await routeSpec(respond({ quality: { instructions_adequate: { probability: 0.05, confidence: 0.9 }, assignment_verifiable: "junk" } }));
    expect(partial).toMatchObject({ kind: "rejected", reason: "instructions_inadequate", evidence: { quality: { outcome: "rejected", instructions_adequate: 0.05 } } });
    const reversed = await routeSpec(respond({ quality: { instructions_adequate: "junk", assignment_verifiable: 0.05 } }));
    expect(reversed).toMatchObject({ kind: "rejected", reason: "assignment_unverifiable", evidence: { quality: { outcome: "rejected", assignment_verifiable: 0.05 } } });
  });

  for (const { name, category, expected } of [
    { name: "bare string", category: "worker", expected: admitted },
    { name: "choice key", category: { choice: "worker", confidence: 0.9 }, expected: admitted },
    { name: "name key", category: { name: "worker", confidence: 0.9 }, expected: admitted },
    { name: "value key", category: { value: "worker", confidence: 0.9 }, expected: admitted },
    { name: "probability key", category: { category: "worker", probability: 0.9 }, expected: admitted },
    { name: "non-record", category: 5, expected: invalid("category") },
    { name: "unbounded name", category: { category: "", confidence: 0.9 }, expected: invalid("category") },
    { name: "missing confidence", category: { category: "worker" }, expected: invalid("category") },
    { name: "category outside the catalog", category: { category: "ghost", confidence: 0.9 }, expected: invalid("category") },
  ]) {
    it(`parses category judgment shape: ${name}`, async () => {
      await expect(routeSpec(respond({ category }))).resolves.toMatchObject(expected);
    });
  }

  it("reads the category from alternates or defaults to the spec's own category", async () => {
    const withoutCategory = responseFor(SINGLE_CATALOG);
    delete withoutCategory.category;
    await expect(routeSpec(respondedWith({ ...withoutCategory, categoryChoice: { category: "worker", confidence: 0.9 } }))).resolves.toMatchObject(admitted);
    await expect(routeSpec(respondedWith({ ...withoutCategory, routing: { category: { category: "worker", confidence: 0.9 } } }))).resolves.toMatchObject(admitted);
    const viaSpec = respondedWith(withoutCategory);
    viaSpec.spec = { ...SPEC, category: "worker" };
    await expect(routeSpec(viaSpec)).resolves.toMatchObject({ kind: "admitted", category: "worker" });
    await expect(routeSpec(respondedWith(withoutCategory))).resolves.toMatchObject(invalid("category"));
  });

  for (const { name, patch, component } of [
    { name: "transport true", patch: { transport: true }, component: "transport" },
    { name: "transport_failed kind", patch: { kind: "transport_failed" }, component: "transport" },
    { name: "transport kind with component", patch: { kind: "transport", component: "http_503" }, component: "http_503" },
    { name: "failed transport object", patch: { transport: { failed: true } }, component: "transport" },
  ]) {
    it(`maps transport marker to a bounded component: ${name}`, async () => {
      await expect(routeSpec(respond(patch))).resolves.toMatchObject({ kind: "abstained", reason: "transport_failed", component });
    });
  }

  it("ignores transport markers that do not report a failure", async () => {
    await expect(routeSpec(respond({ transport: { failed: false } }))).resolves.toMatchObject(admitted);
    await expect(routeSpec(respond({ transport: "junk" }))).resolves.toMatchObject(admitted);
  });

  it("reads candidate judgments from every tolerated key and container", async () => {
    const entry = candidateEntry({ selection: { tools: ["read"] } });
    for (const key of ["candidateSelections", "selections"]) {
      const response = responseFor(SINGLE_CATALOG);
      delete response.candidates;
      response[key] = [entry];
      await expect(routeSpec(respondedWith(response))).resolves.toMatchObject(admitted);
    }
    const recordForm = responseFor(SINGLE_CATALOG);
    recordForm.candidates = { "0": { runner: "pi", model: "pi-model", selection: { tools: ["read"] } } };
    await expect(routeSpec(respondedWith(recordForm))).resolves.toMatchObject(admitted);
    const missing = responseFor(SINGLE_CATALOG);
    delete missing.candidates;
    await expect(routeSpec(respondedWith(missing))).resolves.toMatchObject(invalid("candidates"));
    for (const candidates of [
      [{ index: 5, runner: "pi", model: "pi-model" }],
      [{ index: 0, runner: "claude", model: "pi-model" }],
      [{ index: 0, runner: "pi", model: "other" }],
    ]) {
      await expect(routeSpec(respondedWith({ ...responseFor(SINGLE_CATALOG), candidates })), JSON.stringify(candidates)).resolves.toMatchObject(invalid("candidates"));
    }
  });

  for (const { name, entry, expected } of [
    { name: "resources container", entry: candidateEntry({ resources: { tools: { read: 0.9 } } }), expected: admitted },
    { name: "bare pool fields", entry: candidateEntry({ tools: { read: 0.9 } }), expected: admitted },
    { name: "boolean pool operand", entry: candidateEntry({ selection: { tools: { read: true } } }), expected: admitted },
    { name: "boolean pool operand unselected", entry: candidateEntry({ selection: { tools: { read: false } } }), expected: admitted },
    { name: "array with name records", entry: candidateEntry({ selection: { tools: [{ name: "read", selected: true }] } }), expected: admitted },
    { name: "array record unselected", entry: candidateEntry({ selection: { tools: [{ name: "read", selected: false }] } }), expected: admitted },
    { name: "array with resource-keyed records", entry: candidateEntry({ selection: { tools: [{ resource: "read", selected: 0.9 }] } }), expected: admitted },
    { name: "array record with unbounded name", entry: candidateEntry({ selection: { tools: [{ name: "", selected: true }] } }), expected: invalid("candidates") },
    { name: "array record with no operand", entry: candidateEntry({ selection: { tools: [{ name: "read" }] } }), expected: invalid("candidates") },
    { name: "array with non-record items", entry: candidateEntry({ selection: { tools: [5] } }), expected: invalid("candidates") },
    { name: "non-array non-map pool value", entry: candidateEntry({ selection: { tools: 5 } }), expected: invalid("candidates") },
    { name: "map with unbounded resource name", entry: candidateEntry({ selection: { tools: { "": 0.9 } } }), expected: invalid("candidates") },
    { name: "unparseable pool operand", entry: candidateEntry({ selection: { tools: { read: "x" } } }), expected: invalid("candidates") },
    { name: "record operand with no tolerated key", entry: candidateEntry({ selection: { tools: { read: { weird: 1 } } } }), expected: invalid("candidates") },
    { name: "explicit confidence override on a record operand", entry: candidateEntry({ selection: { tools: { read: { selected: 0.9, confidence: 0.85 } } } }), expected: admitted },
    { name: "out-of-range record confidence", entry: candidateEntry({ selection: { tools: { read: { selected: 0.9, confidence: 2 } } } }), expected: invalid("candidates") },
    { name: "low-probability pool operand is not selected", entry: candidateEntry({ selection: { tools: { read: 0.1 } } }), expected: admitted },
    { name: "every tolerated operand key", entry: candidateEntry({ selection: { tools: { read: { selected: true }, write: { permitted: 0.9 }, exec: { noul: 0.9 }, pi: { probability: 0.9 }, scan: { value: true }, grep: { choice: true } } } }), expected: admitted },
    { name: "bare string choice operand is not tolerated", entry: candidateEntry({ selection: { tools: { read: { choice: "yes" } } } }), expected: invalid("candidates") },
  ]) {
    it(`parses candidate selection shape: ${name}`, async () => {
      await expect(routeSpec(withEntry(entry))).resolves.toMatchObject(expected);
    });
  }

  it("excludes indecisive resources, records the noul, and keeps later candidates parseable", async () => {
    for (const tools of [{ read: 0.7 }, [{ name: "read", selected: 0.7 }]]) {
      const seen: ResourceSelection[] = [];
      const input = withEntry(candidateEntry({ selection: { tools } }));
      input.compile = async (_catalog, _spec, resolved, selection) => {
        seen.push(selection);
        return configuration(resolved.index, resolved.candidate.model);
      };
      const result = await routeSpec(input);
      expect(result).toMatchObject({
        kind: "admitted",
        evidence: { exclusions: [{ field: "tools", name: "read", noul: 0.7 }] },
      });
      expect(seen).toEqual([{}]);
    }

    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }, { runner: "claude", model: "claude-model" }]);
    const input = baseInput(catalog);
    input.response = {
      ...responseFor(catalog),
      candidates: [
        { index: 0, runner: "pi", model: "pi-model", selection: { tools: { read: 0.7 } } },
        { index: 1, runner: "claude", model: "claude-model", selection: {} },
      ],
    };
    const result = await routeSpec(input);
    expect(result).toMatchObject({ kind: "admitted", evidence: { exclusions: [{ field: "tools", name: "read", noul: 0.7 }] } });
  });

  it("keeps confident YES resources and excludes confident NO resources", async () => {
    const yesSeen: ResourceSelection[] = [];
    const yes = withEntry(candidateEntry({ selection: { tools: { read: 0.95 } } }));
    yes.compile = async (_catalog, _spec, resolved, selection) => {
      yesSeen.push(selection);
      return configuration(resolved.index, resolved.candidate.model);
    };
    await expect(routeSpec(yes)).resolves.toMatchObject({ kind: "admitted" });
    expect(yesSeen).toEqual([{ tools: ["read"] }]);

    const noSeen: ResourceSelection[] = [];
    const no = withEntry(candidateEntry({ selection: { tools: { read: 0.1 } } }));
    no.compile = async (_catalog, _spec, resolved, selection) => {
      noSeen.push(selection);
      return configuration(resolved.index, resolved.candidate.model);
    };
    await expect(routeSpec(no)).resolves.toMatchObject({ kind: "admitted", evidence: { exclusions: [{ field: "tools", name: "read", noul: 0.1 }] } });
    expect(noSeen).toEqual([{}]);
  });

  it("abstains when an excluded resource is explicitly required by the instructions", async () => {
    const input = withEntry(candidateEntry({ selection: { tools: { read: 0.7 } } }));
    input.spec = { ...SPEC, instructions: "You must use read to complete this assignment." };
    await expect(routeSpec(input)).resolves.toMatchObject({
      kind: "abstained",
      reason: "low_confidence",
      component: "tools:read",
      evidence: { exclusions: [{ field: "tools", name: "read", noul: 0.7 }] },
    });

    const imperative = withEntry(candidateEntry({ selection: { tools: { read: 0.7 } } }));
    imperative.spec = { ...SPEC, instructions: "Use read to complete this assignment." };
    await expect(routeSpec(imperative)).resolves.toMatchObject({ kind: "abstained", reason: "low_confidence" });

    const forbidden = withEntry(candidateEntry({ selection: { tools: { read: 0.7 } } }));
    forbidden.spec = { ...SPEC, instructions: "Do not use read for this assignment." };
    await expect(routeSpec(forbidden)).resolves.toMatchObject({ kind: "admitted", evidence: { exclusions: [{ field: "tools", name: "read", noul: 0.7 }] } });
  });

  it("assembles the bypass binding only from a complete bounded field set", async () => {
    const receipt = createBypassReceipt({ binding: BINDING, abstention: recordedAbstention(), configuration: configuration(), recorded: true });
    const withFields = (fields: Record<string, unknown>): SpecRouteInput => {
      const input = baseInput();
      input.bypass = receipt;
      Object.assign(input, fields);
      return input;
    };
    const replayed = await routeSpec(withFields({ caller: BINDING.caller, specRevision: BINDING.specRevision, policyRevision: BINDING.policyRevision, launchIdentity: BINDING.launchIdentity }));
    expect(replayed).toEqual(receipt.result);
    for (const fields of [
      { caller: "" },
      { caller: "x", specRevision: "" },
      { caller: "x", specRevision: "s", policyRevision: "" },
      { caller: "x", specRevision: "s", policyRevision: "p", launchIdentity: "" },
    ]) {
      await expect(routeSpec(withFields(fields)), JSON.stringify(fields)).resolves.toMatchObject(invalid("bypass"));
    }
    await expect(routeSpec(withFields({}))).resolves.toMatchObject(invalid("bypass"));
    const tampered = baseInput();
    tampered.binding = BINDING;
    tampered.bypass = { ...receipt, digest: "forged" };
    await expect(routeSpec(tampered)).resolves.toMatchObject(invalid("bypass"));
  });
});

describe("bypass receipt integrity", () => {
  const redigest = (receipt: BypassReceipt, patch: Record<string, unknown>): BypassReceipt => {
    const unsigned = {
      version: receipt.version,
      kind: receipt.kind,
      binding: receipt.binding,
      recorded: receipt.recorded,
      abstention: receipt.abstention,
      result: receipt.result,
      ...patch,
    };
    return { ...unsigned, digest: createHash("sha256").update(JSON.stringify(unsigned)).digest("hex") } as BypassReceipt;
  };

  it("refuses to sign a receipt for anything but a recorded transport abstention", async () => {
    expect(() => createBypassReceipt({ binding: BINDING, abstention: { kind: "admitted" } as never, configuration: configuration(), recorded: true })).toThrow(/recorded transport abstention/);
    expect(() => createBypassReceipt({ binding: BINDING, abstention: recordedAbstention(), configuration: configuration() })).toThrow(/recorded transport abstention/);
    expect(() => createBypassReceipt({ binding: BINDING, abstention: recordedAbstention(), configuration: configuration(), recorded: true })).not.toThrow();
    expect(() => createBypassReceipt({ binding: BINDING, abstention: recordedAbstention(), configuration: configuration(), recordedAbstention: true })).not.toThrow();
    expect(() => createBypassReceipt({ binding: BINDING, abstention: recordedAbstention("no_assignments"), configuration: configuration(), recorded: true })).toThrow(/recorded transport abstention/);
  });

  it("stamps transport provenance defaults: contract spec label for the category, count one, no component key", async () => {
    const receipt = createBypassReceipt({ binding: BINDING, abstention: recordedAbstention(), configuration: configuration(), recorded: true });
    expect(receipt.version).toBe(1);
    expect(receipt.kind).toBe("bypass_receipt");
    expect(receipt.result.category).toBe("worker");
    expect(receipt.result.count).toBe(1);
    expect(receipt.result).not.toHaveProperty("component");
    expect(receipt.digest).toMatch(/^[0-9a-f]{64}$/);
    const transport = createBypassReceipt({ binding: BINDING, abstention: recordedAbstention("transport_failed"), configuration: configuration(), category: "ops", count: 3, recorded: true });
    expect(transport.result.category).toBe("ops");
    expect(transport.result.count).toBe(3);
    expect(transport.result.quality).toBe("not_evaluated");
    expect(transport.abstention.component).toBe("fixture");
    expect(transport.result.evidence?.bypass).toMatchObject({ label: "transport-abstain", quality: "not_evaluated" });
    const withoutComponent = createBypassReceipt({ binding: BINDING, abstention: { kind: "abstained", reason: "transport_failed" }, configuration: configuration(), recorded: true });
    expect(withoutComponent.abstention).toEqual({ kind: "abstained", reason: "transport_failed" });
    expect(() => createBypassReceipt({ binding: BINDING, abstention: { kind: "abstained", reason: "no_assignments" }, configuration: configuration(), recorded: true })).toThrow(/recorded transport abstention/);
  });

  it("refuses malformed bindings, foreign receipts, tampering, and kind confusion at replay", async () => {
    const receipt = createBypassReceipt({ binding: BINDING, abstention: recordedAbstention(), configuration: configuration(), recorded: true });
    expect(() => replayBypassReceipt(receipt, { ...BINDING, caller: "" })).toThrow(/invalid bypass binding/);
    expect(() => replayBypassReceipt({ ...receipt, binding: { ...BINDING, caller: "" } }, BINDING)).toThrow(/invalid bypass binding/);
    for (const foreign of [
      undefined,
      "x",
      { ...receipt, version: 2 },
      { ...receipt, kind: "admitted" },
      { ...receipt, recorded: false },
      { ...receipt, digest: "forged" },
    ]) {
      expect(() => replayBypassReceipt(foreign as BypassReceipt, BINDING)).toThrow(/invalid bypass receipt/);
    }
    expect(() => replayBypassReceipt(receipt, { ...BINDING, launchIdentity: "other" })).toThrow(/binding mismatch/);
    expect(() => replayBypassReceipt(redigest(receipt, { abstention: { ...receipt.abstention, kind: "weird" } }), BINDING)).toThrow(/invalid bypass receipt/);
    expect(() => replayBypassReceipt(redigest(receipt, { result: { ...receipt.result, kind: "abstained" } }), BINDING)).toThrow(/invalid bypass receipt/);
    expect(() => replayBypassReceipt(redigest(receipt, { result: { ...receipt.result, evidence: undefined } }), BINDING)).toThrow(/invalid bypass receipt/);
    expect(() => replayBypassReceipt(redigest(receipt, { result: { ...receipt.result, evidence: {} } }), BINDING)).toThrow(/invalid bypass receipt/);
    expect(() => replayBypassReceipt(redigest(receipt, { result: { ...receipt.result, evidence: { quality: { outcome: "not_evaluated" } } } }), BINDING)).toThrow(/invalid bypass receipt/);
    expect(replayBypassReceipt(receipt, BINDING)).toEqual(receipt.result);
  });
});

describe("availability, catalog, and compile edges", () => {
  it("abstains invalid_response when the response is not a record at all", async () => {
    for (const response of ["junk", null]) {
      const input = baseInput();
      input.response = response;
      await expect(routeSpec(input)).resolves.toMatchObject({ kind: "abstained", reason: "invalid_response", component: "quality" });
    }
  });

  it("abstains transport_failed when neither a root nor an availability gate is provided", async () => {
    const input = baseInput();
    delete input.root;
    delete input.availability;
    await expect(routeSpec(input)).resolves.toMatchObject({ kind: "abstained", reason: "transport_failed", component: "availability" });
  });

  it("passes an empty root to an injected gate and reaches the real availability reader by default", async () => {
    const rootless = baseInput();
    delete rootless.root;
    const seen: string[] = [];
    rootless.availability = async (_candidate, _runner, options) => {
      seen.push(options.root);
      return availabilityStatus("unknown");
    };
    await expect(routeSpec(rootless)).resolves.toMatchObject({ kind: "admitted" });
    expect(seen).toEqual([""]);

    const root = await mkdtemp(join(tmpdir(), "herdr-router-root-"));
    dirs.push(root);
    const real = baseInput();
    real.root = root;
    delete real.availability;
    real.now = () => new Date("2026-09-18T10:00:00.000Z");
    await expect(routeSpec(real)).resolves.toMatchObject({ kind: "admitted" });
  });

  it("abstains catalog_unavailable when a chain runner is absent or the catalog read throws", async () => {
    const missingRunner = baseInput({ ...SINGLE_CATALOG, runners: new Map() });
    await expect(routeSpec(missingRunner)).resolves.toMatchObject({ kind: "abstained", reason: "catalog_unavailable", component: "catalog" });
    const throwing = baseInput();
    throwing.catalog = { ...SINGLE_CATALOG, categories: { get: () => { throw new Error("down"); } } as unknown as Catalog["categories"] };
    await expect(routeSpec(throwing)).resolves.toMatchObject({ kind: "abstained", reason: "catalog_unavailable", component: "catalog" });
    const gateDown = baseInput();
    gateDown.eligibility = () => { throw new Error("gate down"); };
    await expect(routeSpec(gateDown)).resolves.toMatchObject({ kind: "abstained", reason: "catalog_unavailable", component: "catalog" });
  });

  it("maps compile failures to typed abstains and reaches the real compiler by default", async () => {
    const invalidSelection = baseInput();
    invalidSelection.compile = async () => { throw new CompileError("INVALID_SELECTION", "bad selection"); };
    await expect(routeSpec(invalidSelection)).resolves.toMatchObject({ kind: "abstained", reason: "invalid_response", component: "candidates" });
    const otherCode = baseInput();
    otherCode.compile = async () => { throw new CompileError("CANDIDATE_NOT_REVIEWED", "unreviewed"); };
    await expect(routeSpec(otherCode)).resolves.toMatchObject({ kind: "abstained", reason: "catalog_unavailable", component: "configuration" });
    const generic = baseInput();
    generic.compile = async () => { throw new Error("compile down"); };
    await expect(routeSpec(generic)).resolves.toMatchObject({ kind: "abstained", reason: "catalog_unavailable", component: "configuration" });

    const realCompile = baseInput();
    delete realCompile.compile;
    await expect(routeSpec(realCompile)).resolves.toMatchObject({ kind: "admitted" });
  });
});

describe("assembleSpecDecision edges", () => {
  it("replays a bypass before reading the remaining fields", async () => {
    const receipt = createBypassReceipt({ binding: BINDING, abstention: recordedAbstention(), configuration: configuration(), recorded: true });
    const replayed = assembleSpecDecision({ spec: SPEC, quality: { instructions_adequate: 0.9, assignment_verifiable: 0.9 }, bypass: receipt, binding: BINDING });
    expect(replayed).toEqual(receipt.result);
    expect(assembleSpecDecision({ spec: SPEC, quality: { instructions_adequate: 0.9, assignment_verifiable: 0.9 }, bypass: receipt })).toMatchObject({ kind: "abstained", reason: "invalid_response", component: "bypass" });
    expect(assembleSpecDecision({ spec: SPEC, quality: { instructions_adequate: 0.9, assignment_verifiable: 0.9 }, bypass: { ...receipt, digest: "forged" }, binding: BINDING })).toMatchObject({ kind: "abstained", reason: "invalid_response", component: "bypass" });
  });

  it("abstains invalid_response when the configuration is absent", async () => {
    const result = assembleSpecDecision({ spec: SPEC, quality: { instructions_adequate: 0.9, assignment_verifiable: 0.9 }, category: { category: "worker", confidence: 0.9 } });
    expect(result).toMatchObject({ kind: "abstained", reason: "invalid_response", component: "configuration" });
  });

  it("abstains invalid_response on an unparseable quality gate and low_confidence on a low-confidence category", async () => {
    expect(assembleSpecDecision({ spec: SPEC, quality: { instructions_adequate: "junk", assignment_verifiable: 0.9 } })).toMatchObject({ kind: "abstained", reason: "invalid_response", component: "quality" });
    const low = assembleSpecDecision({ spec: SPEC, quality: GOOD_QUALITY, category: { category: "worker", confidence: 0.5 }, configuration: configuration() });
    expect(low).toMatchObject({ kind: "abstained", reason: "low_confidence", component: "category" });
  });

  it("admits with not_rejected quality evidence and defaults when no caller evidence is supplied", async () => {
    const result = assembleSpecDecision({ spec: { label: "worker" }, quality: GOOD_QUALITY, category: { category: "worker", confidence: 0.9 }, configuration: configuration() });
    expect(result).toMatchObject({
      kind: "admitted",
      quality: "not_rejected",
      category: "worker",
      count: 1,
      evidence: {
        quality: { outcome: "not_rejected", instructions_adequate: 0.9, assignment_verifiable: 0.9 },
        category: { name: "worker", confidence: 0.9 },
      },
    });
  });

  it("admits an unevaluated quality gate and merges caller evidence", async () => {
    const result = assembleSpecDecision({
      spec: { label: "worker" },
      category: { category: "worker", confidence: 0.9 },
      configuration: configuration(),
      evidence: { availability: [{ index: 0, status: "known-exhausted", retryNotBefore: null }] },
    });
    expect(result).toMatchObject({
      kind: "admitted",
      quality: "not_evaluated",
      evidence: {
        quality: { outcome: "not_evaluated" },
        availability: [{ index: 0, status: "known-exhausted", retryNotBefore: null }],
      },
    });
  });

  it("fails closed on a malformed category judgment at this seam too", async () => {
    const result = assembleSpecDecision({ spec: SPEC, quality: { instructions_adequate: 0.9, assignment_verifiable: 0.9 }, configuration: configuration(), category: {} as never });
    expect(result).toMatchObject({ kind: "abstained", reason: "invalid_response", component: "category" });
  });
});

describe("composition advisory (B13)", () => {
  const withComposition = (composition: unknown, launched?: readonly string[]): SpecRouteInput => {
    const input = baseInput();
    input.response = { ...responseFor(SINGLE_CATALOG), composition };
    if (launched !== undefined) input.launched = launched;
    return input;
  };

  it("surfaces the flag at 0.80 but not at 0.79", async () => {
    expect(COMPOSITION_ADVISORY_THRESHOLD).toBe(0.8);
    const flagged = await routeSpec(withComposition({ missing_area: 0.8, assessed: ["worker"] }));
    expect(flagged).toMatchObject({
      kind: "admitted",
      quality: "not_rejected",
      category: "worker",
      count: 2,
      advisory: { missing_area: 0.8, assessed: ["worker"], diverged: false },
    });
    const below = await routeSpec(withComposition({ missing_area: 0.79, assessed: ["worker"] }));
    expect(below).toMatchObject({ kind: "admitted", quality: "not_rejected", category: "worker", count: 2 });
    expect(below).not.toHaveProperty("advisory");
  });

  it("never changes the launch outcome — the flag rides an identical admission", async () => {
    const bare = await routeSpec(baseInput());
    const flagged = await routeSpec(withComposition({ missing_area: 0.94, assessed: ["worker"] }));
    if (flagged.kind !== "admitted") throw new Error("expected admitted");
    const { advisory, ...rest } = flagged;
    expect(advisory).toEqual({ missing_area: 0.94, assessed: ["worker"], diverged: false });
    expect(rest).toEqual(bare);

    const rejected = baseInput();
    rejected.response = {
      quality: { instructions_adequate: 0.05, assignment_verifiable: 0.9 },
      category: { category: "worker", confidence: 0.9 },
      composition: { missing_area: 0.95, assessed: ["worker"] },
    };
    const rejection = await routeSpec(rejected);
    expect(rejection).toMatchObject({ kind: "rejected", reason: "instructions_inadequate" });
    expect(rejection).not.toHaveProperty("advisory");

    const abstaining = baseInput();
    abstaining.response = { ...responseFor(SINGLE_CATALOG), category: { category: "worker", confidence: 0.5 }, composition: { missing_area: 0.95, assessed: ["worker"] } };
    const abstention = await routeSpec(abstaining);
    expect(abstention).toMatchObject({ kind: "abstained", reason: "low_confidence" });
    expect(abstention).not.toHaveProperty("advisory");
  });

  it("tags the advisory when the launched team differs from the assessed team", async () => {
    // Per-record default: the decision launches its own spec, so an assessed
    // team with other members is tagged diverged.
    const diverged = await routeSpec(withComposition({ missing_area: 0.9, assessed: ["worker", "reviewer"] }));
    expect(diverged).toMatchObject({ kind: "admitted", advisory: { missing_area: 0.9, assessed: ["worker", "reviewer"], diverged: true } });
    // A caller that knows the launched team supplies it; equal multisets are untagged regardless of order.
    const same = await routeSpec(withComposition({ missing_area: 0.9, assessed: ["reviewer", "worker"] }, ["worker", "reviewer"]));
    expect(same).toMatchObject({ kind: "admitted", advisory: { diverged: false } });
    const missing = await routeSpec(withComposition({ missing_area: 0.9, assessed: ["worker", "reviewer"] }, ["worker"]));
    expect(missing).toMatchObject({ kind: "admitted", advisory: { diverged: true } });
  });

  it("surfaces nothing for malformed composition judgments and records an unusable assessed team as empty", async () => {
    for (const composition of ["junk", 5, null, {}, { missing_area: "yes" }, { missing_area: 1.5 }]) {
      const result = await routeSpec(withComposition(composition));
      expect(result).toMatchObject({ kind: "admitted" });
      expect(result).not.toHaveProperty("advisory");
    }
    const unlabeled = await routeSpec(withComposition({ missing_area: 0.9, assessed: "worker" }));
    expect(unlabeled).toMatchObject({ kind: "admitted", advisory: { missing_area: 0.9, assessed: [], diverged: true } });
    const partial = await routeSpec(withComposition({ missing_area: 0.9, assessed: ["worker", 7] }));
    expect(partial).toMatchObject({ kind: "admitted", advisory: { assessed: ["worker"], diverged: false } });
  });

  it("attaches the advisory through the assembly seam too", () => {
    const result = assembleSpecDecision({
      spec: SPEC,
      quality: GOOD_QUALITY,
      category: { category: "worker", confidence: 0.9 },
      configuration: configuration(),
      composition: { missing_area: 0.9, assessed: ["worker", "reviewer"] },
      launched: ["worker"],
    });
    expect(result).toMatchObject({ kind: "admitted", advisory: { missing_area: 0.9, assessed: ["worker", "reviewer"], diverged: true } });
  });
});
