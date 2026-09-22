import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PiModelReviewer,
  REASON_CRITERIA,
  ReviewerFailure,
  type ModelRegistrySeam,
  type ReviewerRequest,
} from "../../src/reviewer.js";
import {
  createConfiguredWaitReviewer,
  resolveTypesafeApiKey,
  TypeSafeReviewer,
} from "../../src/typesafe-reviewer.js";

const request: ReviewerRequest = {
  targetId: "w1:p2",
  metadata: { agent_status: "working", revision: 7, previousReview: { classification: "progress" } },
  transcriptDelta: ["one", "two", "three"],
};

const signals = {
  progress: 0.11,
  stalled: 0.82,
  blocked: 0.04,
  risk: 0.02,
  appears_complete: 0.01,
};

const reasonProbabilities = {
  none: 0.04,
  repetition: 0.5,
  no_output: 0.3,
  oscillation: 0.02,
  external_dependency: 0.02,
  missing_permission: 0.02,
  tool_failure: 0.02,
  scope_drift: 0.02,
  destructive_action: 0.01,
  incorrect_direction: 0.02,
  completion_claim: 0.01,
  artifact_produced: 0.01,
  verification_passed: 0.01,
};

function validAnswers(): Record<string, unknown> {
  return {
    evidence_sufficient: { type: "noul", noul: 0.9 },
    progress: { type: "noul", noul: signals.progress },
    stalled: { type: "noul", noul: signals.stalled },
    blocked: { type: "noul", noul: signals.blocked },
    risk: { type: "noul", noul: signals.risk },
    appears_complete: { type: "noul", noul: signals.appears_complete },
    reason: { type: "choice", choice: "repetition", confidence: 0.5, probabilities: reasonProbabilities },
  };
}

function response(overrides: {
  evidence?: number;
  signals?: Partial<typeof signals>;
  reason?: string;
} = {}): Response {
  const signalValues = { ...signals, ...overrides.signals };
  return new Response(JSON.stringify({
    model: "jev-latest",
    answers: {
      evidence_sufficient: { type: "noul", noul: overrides.evidence ?? 0.9 },
      progress: { type: "noul", noul: signalValues.progress },
      stalled: { type: "noul", noul: signalValues.stalled },
      blocked: { type: "noul", noul: signalValues.blocked },
      risk: { type: "noul", noul: signalValues.risk },
      appears_complete: { type: "noul", noul: signalValues.appears_complete },
      reason: { type: "choice", choice: overrides.reason ?? "repetition", confidence: 0.5, probabilities: reasonProbabilities },
    },
    usage: {},
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

const model = { id: "testmodel", provider: "test" } as Model<Api>;
function registry(): ModelRegistrySeam {
  return {
    find: (provider, id) => provider === "test" && id === "testmodel" ? model : undefined,
    getAll: () => [model],
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "chat-key" }),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("TypeSafe wait reviewer", () => {
  it("selects the opt-in prefix and preserves the Pi reviewer fallback", () => {
    const selected = createConfiguredWaitReviewer({ modelRegistry: registry() }, "typesafe/jev-latest", {
      apiKey: "key",
      fetch: async () => response(),
    });
    expect(selected).toBeInstanceOf(TypeSafeReviewer);
    expect(createConfiguredWaitReviewer({ modelRegistry: registry() }, "test/testmodel")).toBeInstanceOf(PiModelReviewer);
    const fallbackReviewer = new PiModelReviewer(registry(), "test/testmodel");
    const fallback = vi.fn(() => fallbackReviewer);
    expect(createConfiguredWaitReviewer({ modelRegistry: registry() }, "test/testmodel", undefined, fallback)).toBe(fallbackReviewer);
    const fetchCall = vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>();
    expect(createConfiguredWaitReviewer({ modelRegistry: registry() }, "typesafe/jev-latest", { apiKey: "key", fetch: fetchCall }, fallback)).toBe(fallbackReviewer);
    expect(fallback).toHaveBeenCalledTimes(2);
    expect(fetchCall).not.toHaveBeenCalled();
    expect(() => createConfiguredWaitReviewer({ modelRegistry: registry() }, "typesafe/")).toThrowError(ReviewerFailure);
    expect(() => new TypeSafeReviewer("bad model", { apiKey: "key" })).toThrowError(ReviewerFailure);
  });

  it("makes one typed HTTP call carrying the seven ADR-036 questions and composes a deterministic summary", async () => {
    const calls: Array<{ input: string | URL; init?: RequestInit }> = [];
    const reviewer = new TypeSafeReviewer("jev-latest", {
      apiKey: "secret",
      fetch: async (input, init) => { calls.push({ input, init }); return response(); },
    });
    await expect(reviewer.review(request, new AbortController().signal)).resolves.toEqual({
      targetId: "w1:p2",
      classification: "stalled",
      summary: "stalled (evidence 0.90); stalled 0.82, progress 0.11, blocked 0.04, risk 0.02, appears_complete 0.01; reason repetition; 3 new lines",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ input: "https://api.typesafe.ai/v1/systemone", init: { method: "POST", headers: { Authorization: "Bearer secret", "Content-Type": "application/json" } } });
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body).toEqual({
      state: { ...request, assignmentDigest: { doneWhen: [], constraints: [] } },
      model: "jev-latest",
      questions: {
        evidence_sufficient: {
          type: "noul",
          instructions: "Is the supplied evidence sufficient to make a meaningful judgment about the child's current execution state?",
          criteria: {
            true: "The trace, workspace state, terminal evidence, or previous observation provides concrete evidence about what the agent is doing or has changed.",
            false: "The evidence is absent, purely incidental, too ambiguous, or insufficient to distinguish meaningful execution states.",
          },
        },
        progress: {
          type: "noul",
          instructions: "Does the supplied evidence show meaningful advancement toward the assignment since the previous observation, or within this observation when no previous observation exists?",
          criteria: {
            true: "Relevant implementation changed; new useful evidence established; a previously failing check now passes; a new milestone reached; a meaningful hypothesis tested; failure advanced toward resolution.",
            false: "Mere activity: re-reading, repeated commands, cosmetic churn, progress bars, unchanged failures.",
          },
        },
        stalled: {
          type: "noul",
          instructions: "Does the evidence show repeated activity without meaningful advancement?",
          criteria: {
            true: "Repeated same approach; oscillation; same failure with no new evidence; no relevant artifact change across observations.",
            false: "Mere absence of output is NOT sufficient.",
          },
        },
        blocked: {
          type: "noul",
          instructions: "Does the evidence show the child is waiting on a dependency, permission, information, resource, or action it cannot resolve itself?",
          criteria: { false: "A normal code error is not a blocker." },
        },
        risk: {
          type: "noul",
          instructions: "Does the evidence show the child taking or preparing an incorrect, destructive, unauthorized, or assignment-violating action?",
          criteria: { true: "Includes `constraints` violations." },
        },
        appears_complete: {
          type: "noul",
          instructions: "Does the evidence establish the assignment's doneWhen conditions sufficiently to make the child appear finished despite no terminal lifecycle state?",
          criteria: { false: "`progressMarkers` never count as completion criteria." },
        },
        reason: {
          type: "choice",
          instructions: "Which single factor best explains the supplied evidence's overall picture? Choose none only when no specific factor stands out.",
          criteria: REASON_CRITERIA,
        },
      },
    });
    expect(Object.keys(body.questions.reason.criteria)).toHaveLength(13);
    expect(calls[0]!.init!.signal).toBeInstanceOf(AbortSignal);
  });

  it("raises the stalled bar on a first observation, when the request carries no previous review", async () => {
    // wait.ts omits previousReview from the metadata until a first review completes.
    const firstRequest: ReviewerRequest = { ...request, metadata: { agent_status: "working", revision: 7 } };
    const below = new TypeSafeReviewer("jev-latest", { apiKey: "key", fetch: async () => response({ signals: { stalled: 0.82 } }) });
    await expect(below.review(firstRequest, new AbortController().signal)).resolves.toMatchObject({ classification: "unknown" });
    const atBar = new TypeSafeReviewer("jev-latest", { apiKey: "key", fetch: async () => response({ signals: { stalled: 0.85 } }) });
    await expect(atBar.review(firstRequest, new AbortController().signal)).resolves.toMatchObject({ classification: "stalled" });
    // The shared fixture carries previousReview: the same 0.82 clears the standard bar.
    const grounded = new TypeSafeReviewer("jev-latest", { apiKey: "key", fetch: async () => response({ signals: { stalled: 0.82 } }) });
    await expect(grounded.review(request, new AbortController().signal)).resolves.toMatchObject({ classification: "stalled" });
  });

  it("gates a silent high-stalled window to unknown when evidence is insufficient", async () => {
    const reviewer = new TypeSafeReviewer("jev-latest", {
      apiKey: "key",
      fetch: async () => response({ evidence: 0.42, signals: { stalled: 0.92 }, reason: "no_output" }),
    });
    const result = await reviewer.review(request, new AbortController().signal);
    expect(result.classification).toBe("unknown");
    expect(result.summary).toMatch(/^unknown \(evidence 0\.42\)/);
    expect(result.summary).toContain("stalled 0.92");
    expect(result.summary).toContain("reason no_output");
  });

  it("evaluates the risk and blocked interrupts before the evidence gate", async () => {
    const risky = new TypeSafeReviewer("jev-latest", {
      apiKey: "key",
      fetch: async () => response({ evidence: 0.4, signals: { risk: 0.75 }, reason: "destructive_action" }),
    });
    await expect(risky.review(request, new AbortController().signal)).resolves.toMatchObject({ classification: "risk" });
    const blocked = new TypeSafeReviewer("jev-latest", {
      apiKey: "key",
      fetch: async () => response({ evidence: 0.4, signals: { blocked: 0.81 }, reason: "external_dependency" }),
    });
    await expect(blocked.review(request, new AbortController().signal)).resolves.toMatchObject({ classification: "blocked" });
  });

  it("classifies co-activating progress and blocked as blocked and still records progress", async () => {
    const reviewer = new TypeSafeReviewer("jev-latest", {
      apiKey: "key",
      fetch: async () => response({ evidence: 0.9, signals: { progress: 0.74, blocked: 0.81 }, reason: "external_dependency" }),
    });
    const result = await reviewer.review(request, new AbortController().signal);
    expect(result.classification).toBe("blocked");
    expect(result.summary).toContain("blocked 0.81");
    expect(result.summary).toContain("progress 0.74");
    expect(result.summary).toContain("reason external_dependency");
  });

  it("parses the reason choice only from the fixed thirteen-option set", async () => {
    const reviewer = new TypeSafeReviewer("jev-latest", {
      apiKey: "key",
      fetch: async () => response({ reason: "verification_passed" }),
    });
    const result = await reviewer.review(request, new AbortController().signal);
    expect(result.summary).toContain("reason verification_passed");
    const invalid = new TypeSafeReviewer("jev-latest", {
      apiKey: "key",
      fetch: async () => response({ reason: "something_else" }),
    });
    await expect(invalid.review(request, new AbortController().signal)).rejects.toMatchObject({ code: "REVIEWER_FAILED" });
  });

  it("reads only the process environment by default and fails closed when the key is absent", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "env-key");
    const fetchCall = vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>();
    fetchCall.mockResolvedValue(response({ signals: { progress: 1, stalled: 0, blocked: 0, risk: 0, appears_complete: 0 } }));
    await new TypeSafeReviewer("jev-latest", { fetch: fetchCall }).review(request, new AbortController().signal);
    expect((fetchCall.mock.calls[0]![1]!.headers as Record<string, string>).Authorization).toBe("Bearer env-key");

    await expect(new TypeSafeReviewer("jev-latest", { apiKey: "", fetch: fetchCall }).review(request, new AbortController().signal))
      .rejects.toThrowError("TypeSafe reviewer is not authenticated");
    expect(fetchCall).toHaveBeenCalledTimes(1);
  });

  it("uses the global fetch seam when none is injected", async () => {
    const fetchCall = vi.fn(async () => response({ signals: { progress: 1, stalled: 0, blocked: 0, risk: 0, appears_complete: 0 } }));
    vi.stubGlobal("fetch", fetchCall);
    const result = await new TypeSafeReviewer("jev-latest", { apiKey: "key" }).review(request, new AbortController().signal);
    expect(result.classification).toBe("progress");
    expect(fetchCall).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("propagates abort before, during, and between HTTP response phases", async () => {
    const before = new AbortController();
    before.abort();
    await expect(new TypeSafeReviewer("jev-latest", { apiKey: "key", fetch: async () => response() }).review(request, before.signal))
      .rejects.toMatchObject({ code: "REVIEWER_FAILED", details: { code: "ABORTED" } });

    const during = new AbortController();
    const reviewer = new TypeSafeReviewer("jev-latest", {
      apiKey: "key",
      fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new Error("fetch aborted")), { once: true });
      }),
    });
    const pending = reviewer.review(request, during.signal);
    during.abort();
    await expect(pending).rejects.toMatchObject({ code: "REVIEWER_FAILED", details: { code: "ABORTED" } });

    const afterFetch = new AbortController();
    await expect(new TypeSafeReviewer("jev-latest", {
      apiKey: "key",
      fetch: async () => { afterFetch.abort(); return response(); },
    }).review(request, afterFetch.signal)).rejects.toMatchObject({ details: { code: "ABORTED" } });

  });

  it("fails closed on HTTP, transport, JSON, and incompatible answer failures", async () => {
    const run = (fetchCall: (input: string | URL, init?: RequestInit) => Promise<Response>) =>
      new TypeSafeReviewer("jev-latest", { apiKey: "key", fetch: fetchCall }).review(request, new AbortController().signal);

    await expect(run(async () => new Response("no", { status: 503 }))).rejects.toMatchObject({ details: { status: 503 } });
    await expect(run(async () => { throw new Error("offline"); })).rejects.toMatchObject({ details: { cause: "Connection error: offline" } });
    await expect(run(async () => { throw "offline"; })).rejects.toMatchObject({ details: { cause: "Connection error." } });
    await expect(run(async () => new Response("not json", { status: 200 }))).rejects.toMatchObject({ code: "REVIEWER_FAILED" });

    const answers = validAnswers();
    for (const body of [
      null,
      "text",
      {},
      { answers: [] },
      { answers: {} },
      { answers: { ...answers, evidence_sufficient: { type: "choice", choice: "yes", confidence: 1, probabilities: { yes: 1 } } } },
      { answers: { ...answers, progress: { type: "noul", noul: "high" } } },
      { answers: { ...answers, stalled: { type: "noul", noul: 1.5 } } },
      { answers: { ...answers, blocked: { type: "noul", noul: -0.2 } } },
      { answers: { ...answers, reason: "none" } },
      { answers: { ...answers, reason: { type: "noul", noul: 0.5 } } },
      { answers: { ...answers, reason: { type: "choice", choice: 7, confidence: 1, probabilities: reasonProbabilities } } },
      { answers: { ...answers, reason: { type: "choice", choice: "bogus", confidence: 1, probabilities: reasonProbabilities } } },
      { answers: { ...answers, reason: { type: "choice", choice: "none", confidence: 2, probabilities: reasonProbabilities } } },
      { answers: { ...answers, reason: { type: "choice", choice: "none", confidence: "high", probabilities: reasonProbabilities } } },
      { answers: { ...answers, reason: { type: "choice", choice: "none", confidence: 1, probabilities: [] } } },
      { answers: { ...answers, reason: { type: "choice", choice: "none", confidence: 1, probabilities: { ...reasonProbabilities, repetition: 2 } } } },
      { answers: { ...answers, reason: { type: "choice", choice: "none", confidence: 1, probabilities: { ...reasonProbabilities, oscillation: undefined } } } },
    ]) {
      await expect(run(async () => new Response(JSON.stringify(body), { status: 200 }))).rejects.toMatchObject({ code: "REVIEWER_FAILED" });
    }
  });

  it("bounds a composed summary", async () => {
    const longRequest = { ...request, transcriptDelta: Array.from({ length: 1_000_000 }, () => "line") };
    const result = await new TypeSafeReviewer("jev-latest", { apiKey: "key", fetch: async () => response() }).review(longRequest, new AbortController().signal);
    expect(result.summary.length).toBeLessThanOrEqual(500);
  });
});

describe("the Jev API key resolver", () => {
  const storeWith = (credential: unknown) => ({ read: async () => credential as never });

  it("reads the typesafe api_key entry from the credential store when env is absent", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    await expect(resolveTypesafeApiKey(storeWith({ type: "api_key", key: "store-key" }))).resolves.toBe("store-key");
  });

  it("prefers the auth store over a stale environment value", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "env-key");
    const store = vi.fn(async () => ({ type: "api_key" as const, key: "store-key" }));
    await expect(resolveTypesafeApiKey({ read: store })).resolves.toBe("store-key");
    expect(store).toHaveBeenCalledWith("typesafe");
  });

  it("falls back to the environment when the auth store has no usable key", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "env-key");
    await expect(resolveTypesafeApiKey(storeWith(undefined))).resolves.toBe("env-key");
  });

  it("refuses non-api-key entries and degrades on store or missing-key failures", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    await expect(resolveTypesafeApiKey(storeWith({ type: "oauth", refresh: "r", access: "a", expires: 1 }))).resolves.toBeUndefined();
    await expect(resolveTypesafeApiKey(storeWith({ type: "api_key" }))).resolves.toBeUndefined();
    await expect(resolveTypesafeApiKey(storeWith(undefined))).resolves.toBeUndefined();
    await expect(resolveTypesafeApiKey({ read: async () => { throw new Error("io"); } })).resolves.toBeUndefined();
  });

  it("leaves a clean typed authentication failure when nothing resolves, with no key material in it", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    const apiKey = await resolveTypesafeApiKey(storeWith({ type: "api_key", key: "store-key" }));
    expect(apiKey).toBe("store-key");
    const missing = await resolveTypesafeApiKey(storeWith(undefined));
    expect(missing).toBeUndefined();
    const fetchCall = vi.fn(async () => response());
    const failure = await new TypeSafeReviewer("jev-latest", { apiKey: missing, fetch: fetchCall })
      .review(request, new AbortController().signal)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ReviewerFailure);
    expect((failure as Error).message).toContain("not authenticated");
    expect(JSON.stringify(failure)).not.toContain("store-key");
    expect(fetchCall).not.toHaveBeenCalled();
  });
});
