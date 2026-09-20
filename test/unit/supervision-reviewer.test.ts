import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { ModelRegistrySeam, ReviewClassification } from "../../src/reviewer.js";
import type { EvidenceState } from "../../src/supervision/evidence.js";
import {
  createBuiltinModelRegistry,
  createBuiltinModelService,
  createRegistryModelService,
  type BuiltinModelsSeam,
} from "../../src/supervision/model-service.js";
import {
  needsManagerAttention,
  reduceSupervisionReview,
  supervisionAttention,
  supervisionReviewerUnavailable,
  SUPERVISION_APPEARS_COMPLETE_THRESHOLD,
  SUPERVISION_BLOCKED_THRESHOLD,
  SUPERVISION_PROGRESS_THRESHOLD,
  SUPERVISION_REDUCER_VERSION,
  SUPERVISION_REVIEWER_IDENTITY,
  SUPERVISION_REVIEWER_MODEL,
  SUPERVISION_REVIEWER_QUESTIONS,
  SUPERVISION_RISK_THRESHOLD,
  SUPERVISION_STALLED_FIRST_OBSERVATION_THRESHOLD,
  SUPERVISION_STALLED_THRESHOLD,
  SUPERVISION_THRESHOLDS,
  type SupervisionAttentionInput,
  type SupervisionSignalProbabilities,
} from "../../src/supervision/reviewer.js";

const model = { id: "test-model", name: "Test", provider: "test", api: "openai-completions", baseUrl: "http://test", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000, maxTokens: 1_000 } as Model<Api>;

describe("the supervision reviewer model service", () => {
  it("adapts the Pi host registry and refuses an unauthenticated model", async () => {
    const registry = (ok: boolean, extras: Record<string, unknown> = {}): ModelRegistrySeam => ({
      find: () => model,
      getAll: () => [model],
      getApiKeyAndHeaders: async () => ok ? { ok: true, ...extras } as never : { ok: false, error: "no credential" },
    });
    await expect(createRegistryModelService(registry(true, { apiKey: "k", headers: { a: "b" } })).resolve("test/test-model")).resolves.toEqual({ model, apiKey: "k", headers: { a: "b" } });
    await expect(createRegistryModelService(registry(true)).resolve("test/test-model")).resolves.toEqual({ model });
    await expect(createRegistryModelService(registry(false)).resolve("test/test-model")).rejects.toThrow(/not authenticated/u);
  });

  it("resolves host-independently from the installed built-in catalogue", async () => {
    const models = (found: boolean, auth: unknown): BuiltinModelsSeam => ({
      getModel: () => found ? model : undefined,
      getModels: () => found ? [model] : [],
      getAuth: async () => auth as never,
    });
    await expect(createBuiltinModelService(models(true, { auth: { apiKey: "k", headers: { a: "b" } } })).resolve("test/test-model")).resolves.toEqual({ model, apiKey: "k", headers: { a: "b" } });
    await expect(createBuiltinModelService(models(true, { auth: {} })).resolve("test/test-model")).resolves.toEqual({ model });
    await expect(createBuiltinModelService(models(false, { auth: {} })).resolve("test/test-model")).rejects.toThrow(/could not be resolved/u);
    await expect(createBuiltinModelService(models(true, undefined)).resolve("test/test-model")).rejects.toThrow(/not authenticated/u);
    for (const identifier of ["test-model", "/test-model", "test/"]) {
      await expect(createBuiltinModelService(models(true, { auth: {} })).resolve(identifier)).rejects.toThrow(/must be provider\/model/u);
    }
  });

  it("presents the same catalogue as the wait reviewer's registry seam", async () => {
    const models = (auth: { auth: { apiKey?: string; headers?: Record<string, string> } } | undefined): BuiltinModelsSeam => ({
      getModel: (provider, id) => provider === "test" && id === model.id ? model : undefined,
      getModels: () => [model],
      getAuth: async () => auth,
    });
    const rejecting = (cause: unknown): BuiltinModelsSeam => ({ ...models(undefined), getAuth: async () => { throw cause; } });
    const registry = createBuiltinModelRegistry(models({ auth: { apiKey: "k", headers: { a: "b" } } }));
    expect(registry.find("test", "test-model")).toBe(model);
    expect(registry.find("test", "other")).toBeUndefined();
    expect(registry.getAll()).toEqual([model]);
    await expect(registry.getApiKeyAndHeaders(model)).resolves.toEqual({ ok: true, apiKey: "k", headers: { a: "b" } });
    await expect(createBuiltinModelRegistry(models({ auth: {} })).getApiKeyAndHeaders(model)).resolves.toEqual({ ok: true });
    await expect(createBuiltinModelRegistry(models(undefined)).getApiKeyAndHeaders(model)).resolves.toEqual({ ok: false, error: "provider is not authenticated" });
    await expect(createBuiltinModelRegistry(rejecting(new Error("refresh exploded"))).getApiKeyAndHeaders(model)).resolves.toEqual({ ok: false, error: "refresh exploded" });
    await expect(createBuiltinModelRegistry(rejecting("string failure")).getApiKeyAndHeaders(model)).resolves.toEqual({ ok: false, error: "string failure" });
  });
});

describe("the code-owned attention policy", () => {
  const at = (classification: ReviewClassification, extra: Partial<SupervisionAttentionInput> = {}) =>
    supervisionAttention({ classification, firstObservation: false, workingForMs: 900_000, cadenceMs: 300_000, ...extra });

  it("wakes on risk, blocked, appears_complete, and stalled", () => {
    for (const classification of ["risk", "blocked", "appears_complete", "stalled"] as const) {
      expect(supervisionAttention({ classification, firstObservation: false, workingForMs: 0 })).toBe("wake_manager");
      expect(supervisionAttention({ classification, firstObservation: true, workingForMs: 0, cadenceMs: 300_000 })).toBe("wake_manager");
    }
  });

  it("keeps progress silent at every age", () => {
    expect(supervisionAttention({ classification: "progress", firstObservation: true, workingForMs: 0, cadenceMs: 300_000 })).toBe("none");
    expect(at("progress")).toBe("none");
  });

  it("keeps a first-observation unknown silent only inside baseline grace", () => {
    const grace = { classification: "unknown" as const, firstObservation: true, cadenceMs: 300_000 };
    expect(supervisionAttention({ ...grace, workingForMs: 600_000 })).toBe("none");
    expect(supervisionAttention({ ...grace, workingForMs: 0 })).toBe("none");
    // Past the grace bound, on a later observation, or without a known cadence it wakes.
    expect(supervisionAttention({ ...grace, workingForMs: 600_001 })).toBe("wake_manager");
    expect(supervisionAttention({ classification: "unknown", firstObservation: false, workingForMs: 0, cadenceMs: 300_000 })).toBe("wake_manager");
    expect(supervisionAttention({ classification: "unknown", firstObservation: true, workingForMs: 0 })).toBe("wake_manager");
  });

  it("never wakes for a reviewer_unavailable outcome", () => {
    expect(supervisionAttention({ classification: "unknown", outcome: "reviewer_unavailable", firstObservation: false, workingForMs: 9_999_999, cadenceMs: 1 })).toBe("none");
    expect(supervisionAttention({ classification: "risk", outcome: "reviewer_unavailable", firstObservation: false, workingForMs: 0 })).toBe("none");
  });

  it("keeps the legacy classification-only gate unchanged for the unwired caller", () => {
    for (const classification of ["stalled", "blocked", "risk", "appears_complete", "unknown"] as const) {
      expect(needsManagerAttention(classification)).toBe(true);
    }
    expect(needsManagerAttention("progress")).toBe(false);
  });
});

const evidenceFixture = (over: Partial<EvidenceState> = {}): EvidenceState => ({
  version: 1,
  assignment: { doneWhen: ["tests pass"], progressMarkers: [], constraints: [] },
  trace: {
    version: 1,
    source: "tmux-fallback",
    events: 3,
    bytes: 42,
    actions: [],
    other: [],
    incidental: { "terminal-line": 3 },
    cursorTo: { source: "tmux-fallback", position: 3, hash: "t".repeat(64) },
  },
  workspace: {
    version: 1,
    available: true,
    baseRevision: "a".repeat(40),
    headRevision: "b".repeat(40),
    dirty: false,
    changedFiles: [],
    omittedFiles: 0,
    stats: { filesChanged: 0, insertions: 0, deletions: 0, untrackedFiles: 0 },
    fingerprint: "f".repeat(64),
  },
  terminal: { lines: ["line"], droppedLines: 0 },
  scan: "safe",
  identity: {
    contractVersion: "2.1",
    model: "typesafe/jev-latest",
    questionSetHash: "q".repeat(64),
    reducerVersion: 2,
    thresholds: { ...SUPERVISION_THRESHOLDS },
    compilerConfigHash: "c".repeat(64),
    stateBuilderHash: "s".repeat(64),
    hash: "h".repeat(64),
  },
  drift: { drifted: false, fields: [] },
  ...over,
});

describe("the reviewer failure normalization", () => {
  it("produces the silent unknown/none/reviewer_unavailable boundary result", () => {
    const result = supervisionReviewerUnavailable();
    expect(result).toEqual({
      classification: "unknown",
      summary: "unknown (reviewer_unavailable); reason none; trace none; workspace none",
      schemaVersion: 2,
      reason: "none",
      outcome: "reviewer_unavailable",
      attention: "none",
    });
    // The normalized result is byte-identical across failures.
    expect(supervisionReviewerUnavailable()).toEqual(result);
  });

  it("carries evidence provenance — cursor, fingerprint, identity hash, and drift — when a state exists", () => {
    const evidence = evidenceFixture({ drift: { drifted: true, fields: ["questionSetHash", "thresholds"] } });
    const result = supervisionReviewerUnavailable({ evidence });
    expect(result).toMatchObject({
      classification: "unknown",
      reason: "none",
      outcome: "reviewer_unavailable",
      attention: "none",
      identityHash: "h".repeat(64),
      drift: { drifted: true, fields: ["questionSetHash", "thresholds"] },
    });
    expect(result.summary).toBe(`unknown (reviewer_unavailable); reason none; trace tmux-fallback@3:${"t".repeat(64)}; workspace ${"f".repeat(64)}; drift questionSetHash+thresholds`);
  });

  it("keeps provenance from a refused build's identity alone", () => {
    const identity = evidenceFixture().identity;
    expect(supervisionReviewerUnavailable({ identity })).toMatchObject({ identityHash: "h".repeat(64), outcome: "reviewer_unavailable" });
    expect(supervisionReviewerUnavailable({ identity })).not.toHaveProperty("drift");
  });
});

describe("the reviewer version identity", () => {
  it("exposes the exact model, question set, reducer version, and thresholds for the evidence builder", () => {
    expect(SUPERVISION_REVIEWER_IDENTITY).toEqual({
      model: SUPERVISION_REVIEWER_MODEL,
      questions: SUPERVISION_REVIEWER_QUESTIONS,
      reducerVersion: SUPERVISION_REDUCER_VERSION,
      thresholds: SUPERVISION_THRESHOLDS,
    });
    expect(Object.keys(SUPERVISION_REVIEWER_QUESTIONS)).toEqual(["evidence_sufficient", "progress", "stalled", "blocked", "risk", "appears_complete", "reason"]);
  });
});

describe("the ADR-034 supervision reducer, as amended by ADR-036", () => {
  const quiet: SupervisionSignalProbabilities = { progress: 0, stalled: 0, blocked: 0, risk: 0, appears_complete: 0 };
  const cases: Array<{ name: string; evidence: number; signals: Partial<SupervisionSignalProbabilities>; firstObservation?: boolean; expected: string }> = [
    // ADR-036: risk and blocked are interrupts evaluated before the evidence gate.
    { name: "low evidence plus high risk is risk", evidence: 0.59, signals: { risk: 1 }, expected: "risk" },
    { name: "low evidence plus high blocked is blocked", evidence: 0.59, signals: { blocked: 1 }, expected: "blocked" },
    { name: "evidence 0.60 still admits signals", evidence: 0.60, signals: { risk: 1 }, expected: "risk" },
    // The gate still governs every non-interrupt signal.
    { name: "low evidence mutes appears_complete", evidence: 0.59, signals: { appears_complete: 1 }, expected: "unknown" },
    { name: "low evidence mutes stalled", evidence: 0.59, signals: { stalled: 1 }, expected: "unknown" },
    { name: "low evidence mutes progress", evidence: 0.59, signals: { progress: 1 }, expected: "unknown" },
    // Every threshold boundary: just below stays quiet, exactly on activates.
    { name: "risk just below", evidence: 1, signals: { risk: SUPERVISION_RISK_THRESHOLD - 0.01 }, expected: "unknown" },
    { name: "risk at threshold", evidence: 1, signals: { risk: SUPERVISION_RISK_THRESHOLD }, expected: "risk" },
    { name: "blocked just below", evidence: 1, signals: { blocked: SUPERVISION_BLOCKED_THRESHOLD - 0.01 }, expected: "unknown" },
    { name: "blocked at threshold", evidence: 1, signals: { blocked: SUPERVISION_BLOCKED_THRESHOLD }, expected: "blocked" },
    { name: "appears_complete just below", evidence: 1, signals: { appears_complete: SUPERVISION_APPEARS_COMPLETE_THRESHOLD - 0.01 }, expected: "unknown" },
    { name: "appears_complete at threshold", evidence: 1, signals: { appears_complete: SUPERVISION_APPEARS_COMPLETE_THRESHOLD }, expected: "appears_complete" },
    { name: "stalled just below", evidence: 1, signals: { stalled: SUPERVISION_STALLED_THRESHOLD - 0.01 }, expected: "unknown" },
    { name: "stalled at threshold", evidence: 1, signals: { stalled: SUPERVISION_STALLED_THRESHOLD }, expected: "stalled" },
    { name: "progress just below", evidence: 1, signals: { progress: SUPERVISION_PROGRESS_THRESHOLD - 0.01 }, expected: "unknown" },
    { name: "progress at threshold", evidence: 1, signals: { progress: SUPERVISION_PROGRESS_THRESHOLD }, expected: "progress" },
    // Precedence pairs: co-activating signals classify by the first crossing, never by exclusion.
    { name: "progress .88 + risk .72 is risk", evidence: 1, signals: { progress: 0.88, risk: 0.72 }, expected: "risk" },
    { name: "progress .74 + blocked .81 is blocked", evidence: 1, signals: { progress: 0.74, blocked: 0.81 }, expected: "blocked" },
    { name: "risk + blocked is risk", evidence: 1, signals: { risk: 0.7, blocked: 0.9 }, expected: "risk" },
    { name: "blocked + appears_complete is blocked", evidence: 1, signals: { blocked: 0.9, appears_complete: 0.9 }, expected: "blocked" },
    { name: "appears_complete + stalled is appears_complete", evidence: 1, signals: { appears_complete: 0.9, stalled: 0.9 }, expected: "appears_complete" },
    { name: "stalled + progress is stalled", evidence: 1, signals: { stalled: 0.9, progress: 0.9 }, expected: "stalled" },
    // ADR-036 first observation: no trajectory exists to ground the standard stalled bar.
    { name: "first observation stalled at standard bar", evidence: 1, signals: { stalled: SUPERVISION_STALLED_THRESHOLD }, firstObservation: true, expected: "unknown" },
    { name: "first observation stalled just below raised bar", evidence: 1, signals: { stalled: SUPERVISION_STALLED_FIRST_OBSERVATION_THRESHOLD - 0.01 }, firstObservation: true, expected: "unknown" },
    { name: "first observation stalled at raised bar", evidence: 1, signals: { stalled: SUPERVISION_STALLED_FIRST_OBSERVATION_THRESHOLD }, firstObservation: true, expected: "stalled" },
    { name: "first observation stalled below raised bar still reaches progress", evidence: 1, signals: { stalled: 0.8, progress: SUPERVISION_PROGRESS_THRESHOLD }, firstObservation: true, expected: "progress" },
    { name: "later observation stalled at standard bar", evidence: 1, signals: { stalled: SUPERVISION_STALLED_THRESHOLD }, firstObservation: false, expected: "stalled" },
    // No signal crossing falls through to unknown rather than forcing a label.
    { name: "all quiet falls through", evidence: 1, signals: {}, expected: "unknown" },
    { name: "middling signals fall through", evidence: 0.9, signals: { progress: 0.4, stalled: 0.5, blocked: 0.5, risk: 0.5, appears_complete: 0.5 }, expected: "unknown" },
  ];
  for (const { name, evidence, signals, firstObservation, expected } of cases) {
    it(name, () => {
      expect(reduceSupervisionReview(evidence, { ...quiet, ...signals }, { firstObservation })).toBe(expected);
    });
  }
});
