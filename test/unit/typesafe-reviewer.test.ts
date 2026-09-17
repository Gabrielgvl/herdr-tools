import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiModelReviewer, ReviewerFailure, type ModelRegistrySeam, type ReviewerRequest } from "../../src/reviewer.js";
import {
  createConfiguredWaitReviewer,
  TypeSafeReviewer,
  TYPESAFE_REVIEW_CONFIDENCE_THRESHOLD,
} from "../../src/typesafe-reviewer.js";

const request: ReviewerRequest = {
  targetId: "w1:p2",
  metadata: { agent_status: "working", revision: 7 },
  transcriptDelta: ["one", "two", "three"],
};
const probabilities = {
  progress: 0.11,
  stalled: 0.82,
  blocked: 0.04,
  risk: 0.02,
  appears_complete: 0.01,
};

function response(
  choice = "stalled",
  confidence = 0.82,
  distribution: Record<string, unknown> = probabilities,
): Response {
  return new Response(JSON.stringify({
    model: "jev-latest",
    answers: { classification: { type: "choice", choice, confidence, probabilities: distribution } },
    usage: {},
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

const model = { id: "luna", provider: "test" } as Model<Api>;
function registry(): ModelRegistrySeam {
  return {
    find: (provider, id) => provider === "test" && id === "luna" ? model : undefined,
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
      fetch: async () => response("progress", 0.9),
    });
    expect(selected).toBeInstanceOf(TypeSafeReviewer);
    expect(createConfiguredWaitReviewer({ modelRegistry: registry() }, "test/luna")).toBeInstanceOf(PiModelReviewer);
    const fallbackReviewer = new PiModelReviewer(registry(), "test/luna");
    const fallback = vi.fn(() => fallbackReviewer);
    expect(createConfiguredWaitReviewer({ modelRegistry: registry() }, "test/luna", undefined, fallback)).toBe(fallbackReviewer);
    const fetchCall = vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>();
    expect(createConfiguredWaitReviewer({ modelRegistry: registry() }, "typesafe/jev-latest", { apiKey: "key", fetch: fetchCall }, fallback)).toBe(fallbackReviewer);
    expect(fallback).toHaveBeenCalledTimes(2);
    expect(fetchCall).not.toHaveBeenCalled();
    expect(() => createConfiguredWaitReviewer({ modelRegistry: registry() }, "typesafe/")).toThrowError(ReviewerFailure);
    expect(() => new TypeSafeReviewer("bad model", { apiKey: "key" })).toThrowError(ReviewerFailure);
  });

  it("makes one typed HTTP call and composes a probability-ranked summary", async () => {
    const calls: Array<{ input: string | URL; init?: RequestInit }> = [];
    const reviewer = new TypeSafeReviewer("jev-latest", {
      apiKey: "secret",
      fetch: async (input, init) => { calls.push({ input, init }); return response(); },
    });
    await expect(reviewer.review(request, new AbortController().signal)).resolves.toEqual({
      targetId: "w1:p2",
      classification: "stalled",
      summary: "stalled (confidence 0.82); stalled 0.82, progress 0.11, blocked 0.04, risk 0.02, appears_complete 0.01; 3 new lines",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ input: "https://api.typesafe.ai/v1/systemone", init: { method: "POST", headers: { Authorization: "Bearer secret", "Content-Type": "application/json" } } });
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body).toEqual({
      state: request,
      model: "jev-latest",
      questions: {
        classification: {
          type: "choice",
          instructions: "Judge only from the supplied evidence how this Herdr child agent is doing.",
          criteria: {
            progress: "Output shows the assignment advancing",
            stalled: "Output is repeating or idling with no advance",
            blocked: "It is waiting on something it cannot resolve itself",
            risk: "It is advancing toward a wrong or damaging outcome",
            appears_complete: "The assignment looks finished but no terminal state was reached",
          },
        },
      },
    });
    expect(calls[0]!.init!.signal).toBeInstanceOf(AbortSignal);
  });

  it("derives unknown below the exported confidence threshold", async () => {
    const reviewer = new TypeSafeReviewer("jev-latest", { apiKey: "key", fetch: async () => response("progress", TYPESAFE_REVIEW_CONFIDENCE_THRESHOLD - 0.01) });
    const result = await reviewer.review(request, new AbortController().signal);
    expect(result.classification).toBe("unknown");
    expect(result.summary).toMatch(/^unknown \(confidence 0\.49\)/);
  });

  it("reads only the process environment by default and fails closed when the key is absent", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "env-key");
    const fetchCall = vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>();
    fetchCall.mockResolvedValue(response("progress", 1));
    await new TypeSafeReviewer("jev-latest", { fetch: fetchCall }).review(request, new AbortController().signal);
    expect((fetchCall.mock.calls[0]![1]!.headers as Record<string, string>).Authorization).toBe("Bearer env-key");

    await expect(new TypeSafeReviewer("jev-latest", { apiKey: "", fetch: fetchCall }).review(request, new AbortController().signal))
      .rejects.toThrowError("TypeSafe reviewer is not authenticated");
    expect(fetchCall).toHaveBeenCalledTimes(1);
  });

  it("uses the global fetch seam when none is injected", async () => {
    const fetchCall = vi.fn(async () => response("progress", 1));
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

    const afterJson = new AbortController();
    const body = await response().json();
    const delayedJson = { ok: true, status: 200, json: async () => { afterJson.abort(); return body; } } as Response;
    await expect(new TypeSafeReviewer("jev-latest", {
      apiKey: "key",
      fetch: async () => delayedJson,
    }).review(request, afterJson.signal)).rejects.toMatchObject({ details: { code: "ABORTED" } });
  });

  it("fails closed on HTTP, transport, JSON, and incompatible answer failures", async () => {
    const run = (fetchCall: (input: string | URL, init?: RequestInit) => Promise<Response>) =>
      new TypeSafeReviewer("jev-latest", { apiKey: "key", fetch: fetchCall }).review(request, new AbortController().signal);

    await expect(run(async () => new Response("no", { status: 503 }))).rejects.toMatchObject({ details: { status: 503 } });
    await expect(run(async () => { throw new Error("offline"); })).rejects.toMatchObject({ details: { cause: "offline" } });
    await expect(run(async () => { throw "offline"; })).rejects.toMatchObject({ details: { cause: "offline" } });
    await expect(run(async () => new Response("not json", { status: 200 }))).rejects.toMatchObject({ code: "REVIEWER_FAILED" });

    for (const body of [
      null,
      {},
      { answers: {} },
      { answers: { classification: { type: "score", choice: "progress", confidence: 1, probabilities } } },
      { answers: { classification: { type: "choice", choice: "other", confidence: 1, probabilities } } },
      { answers: { classification: { type: "choice", choice: "progress", confidence: 2, probabilities } } },
      { answers: { classification: { type: "choice", choice: "progress", confidence: 1, probabilities: [] } } },
      { answers: { classification: { type: "choice", choice: "progress", confidence: 1, probabilities: { ...probabilities, risk: -1 } } } },
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
