import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  PiModelReviewer,
  reduceSupervisionReview,
  ReviewerFailure,
  createPiModelReviewer,
  SUPERVISION_BLOCKED_THRESHOLD,
  SUPERVISION_EVIDENCE_THRESHOLD,
  SUPERVISION_PROGRESS_THRESHOLD,
  SUPERVISION_REDUCER_VERSION,
  SUPERVISION_RISK_THRESHOLD,
  SUPERVISION_STALLED_FIRST_OBSERVATION_THRESHOLD,
  SUPERVISION_STALLED_THRESHOLD,
  SUPERVISION_THRESHOLDS,
  type ModelRegistrySeam,
  type SupervisionSignalProbabilities,
} from "../../src/reviewer.js";

const model = { id: "testmodel", name: "TestModel", provider: "test", api: "openai-completions", baseUrl: "http://test", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 1000 } as Model<Api>;
const message = (text: string): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 });

function registry(authenticated = true): ModelRegistrySeam {
  return { find: () => model, getAll: () => [model], getApiKeyAndHeaders: async () => authenticated ? { ok: true, apiKey: "key" } : { ok: false, error: "missing" } };
}

describe("Pi production reviewer adapter", () => {
  it("resolves the configured model, sends low thinking with no tools, and bounds input", async () => {
    const calls: unknown[] = [];
    const reviewer = new PiModelReviewer(registry(), "testmodel", async (selected, context, options) => {
      calls.push({ selected, context, options });
      return message(JSON.stringify({ classification: "progress", summary: "ok" }));
    });
    const controller = new AbortController();
    const result = await reviewer.review({ targetId: "p1", metadata: { agent_status: "working" }, transcriptDelta: ["new"] }, controller.signal);
    expect(result).toEqual({ targetId: "p1", classification: "progress", summary: "ok" });
    expect(calls[0]).toMatchObject({ selected: model, context: { messages: [{ role: "user" }] }, options: { signal: controller.signal, maxTokens: 256, reasoningEffort: "low" } });
    expect((calls[0] as { options: Record<string, unknown> }).options).not.toHaveProperty("thinkingLevel");
    expect((calls[0] as { context: { messages: [{ content: string }] } }).context.messages[0].content).not.toContain("tools");
  });

  it("omits null-valued auth headers before the provider call", async () => {
    const calls: unknown[] = [];
    const seam: ModelRegistrySeam = { ...registry(), getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", headers: { "x-keep": "1", "x-drop": null } }) };
    const reviewer = new PiModelReviewer(seam, "testmodel", async (_selected, _context, options) => {
      calls.push(options);
      return message(JSON.stringify({ classification: "progress", summary: "ok" }));
    });
    await reviewer.review({ targetId: "p1", metadata: {}, transcriptDelta: [] }, new AbortController().signal);
    expect((calls[0] as { headers: Record<string, string> }).headers).toEqual({ "x-keep": "1" });
  });

  it("fails closed for authentication, malformed JSON, and extra response keys", async () => {
    await expect(new PiModelReviewer(registry(false), "testmodel").review({ targetId: "p", metadata: {}, transcriptDelta: [] }, new AbortController().signal)).rejects.toBeInstanceOf(ReviewerFailure);
    const bad = new PiModelReviewer(registry(), "testmodel", async () => message("not json"));
    await expect(bad.review({ targetId: "p", metadata: {}, transcriptDelta: [] }, new AbortController().signal)).rejects.toMatchObject({ code: "REVIEWER_FAILED" });
    const extra = new PiModelReviewer(registry(), "testmodel", async () => message(JSON.stringify({ classification: "risk", summary: "x", tools: [] })));
    await expect(extra.review({ targetId: "p", metadata: {}, transcriptDelta: [] }, new AbortController().signal)).rejects.toMatchObject({ code: "REVIEWER_FAILED" });
  });

  it("uses exact model resolution and propagates abort", async () => {
    expect(() => new PiModelReviewer({ ...registry(), getAll: () => [] }, "testmodel")).toThrowError(ReviewerFailure);
    expect(() => new PiModelReviewer(registry(), "test/testmodel")).not.toThrow();
    expect(() => new PiModelReviewer(registry(), "bad model")).toThrowError(ReviewerFailure);
    expect(() => new PiModelReviewer(registry(), "\0")).toThrowError(ReviewerFailure);
    const ambiguous = { ...registry(), getAll: () => [model, { ...model, provider: "other" }] };
    expect(() => new PiModelReviewer(ambiguous, "testmodel")).toThrowError(ReviewerFailure);
    const reviewer = new PiModelReviewer(registry(), "testmodel");
    const controller = new AbortController();
    controller.abort();
    await expect(reviewer.review({ targetId: "p", metadata: {}, transcriptDelta: [] }, controller.signal)).rejects.toMatchObject({ code: "REVIEWER_FAILED", details: { code: "ABORTED" } });
    expect(createPiModelReviewer({ modelRegistry: registry() }, "testmodel")).toBeInstanceOf(PiModelReviewer);
  });

  it("rejects invalid response shapes, model failures, and late aborts", async () => {
    const request = { targetId: "p", metadata: {}, transcriptDelta: [] };
    for (const raw of ["null", "[]", JSON.stringify({ classification: "progress" }), JSON.stringify({ summary: "x" }), JSON.stringify({ classification: "invalid", summary: "x" }), JSON.stringify({ classification: "progress", summary: 3 })]) {
      const reviewer = new PiModelReviewer(registry(), "testmodel", async () => message(raw));
      await expect(reviewer.review(request, new AbortController().signal)).rejects.toMatchObject({ code: "REVIEWER_FAILED" });
    }
    const failing = new PiModelReviewer(registry(), "testmodel", async () => { throw new Error("provider down"); });
    await expect(failing.review(request, new AbortController().signal)).rejects.toMatchObject({ code: "REVIEWER_FAILED", details: { cause: "provider down" } });
    const stringFailing = new PiModelReviewer(registry(), "testmodel", async () => { throw "provider down"; });
    await expect(stringFailing.review(request, new AbortController().signal)).rejects.toMatchObject({ code: "REVIEWER_FAILED", details: { cause: "provider down" } });
    const stopped = new PiModelReviewer(registry(), "testmodel", async () => ({ ...message(JSON.stringify({ classification: "appears_complete", summary: "done" })), stopReason: "aborted" }));
    await expect(stopped.review(request, new AbortController().signal)).rejects.toMatchObject({ code: "REVIEWER_FAILED", details: { code: "ABORTED" } });
    const providerError = new PiModelReviewer(registry(), "testmodel", async () => ({ ...message(""), stopReason: "error", errorMessage: "usage limit reached" }));
    await expect(providerError.review(request, new AbortController().signal)).rejects.toMatchObject({ code: "REVIEWER_FAILED", message: "Reviewer model call failed", details: { cause: "usage limit reached" } });
    const unspecifiedProviderError = new PiModelReviewer(registry(), "testmodel", async () => ({ ...message(""), stopReason: "error" }));
    await expect(unspecifiedProviderError.review(request, new AbortController().signal)).rejects.toMatchObject({ details: { cause: "provider returned an unspecified error" } });
    const legacy = new PiModelReviewer(registry(), "testmodel", async () => message(JSON.stringify({ classification: "completed", summary: "done" })));
    await expect(legacy.review(request, new AbortController().signal)).rejects.toMatchObject({ code: "REVIEWER_FAILED" });
  });

  it("recovers the answer from one fenced JSON body and rejects other wrappers", async () => {
    const request = { targetId: "p", metadata: {}, transcriptDelta: [] };
    const tagged = new PiModelReviewer(registry(), "testmodel", async () => message("The result:\n```json\n{\"classification\":\"progress\",\"summary\":\"ok\"}\n```"));
    await expect(tagged.review(request, new AbortController().signal)).resolves.toEqual({ targetId: "p", classification: "progress", summary: "ok" });
    const untagged = new PiModelReviewer(registry(), "testmodel", async () => message("```\n{\"classification\":\"stalled\",\"summary\":\"quiet\"}\n```"));
    await expect(untagged.review(request, new AbortController().signal)).resolves.toMatchObject({ classification: "stalled", summary: "quiet" });
    for (const [raw, shape] of [
      ["   ", "empty response"],
      ["prefix ```json {\"classification\":\"risk\"", "no single JSON fence"],
      ["```\n{}\n``` trailing ```", "no single JSON fence"],
      ["```json\n{not json}\n```", "fenced body did not parse"],
    ] as const) {
      const reviewer = new PiModelReviewer(registry(), "testmodel", async () => message(raw));
      await expect(reviewer.review(request, new AbortController().signal)).rejects.toMatchObject({ code: "REVIEWER_FAILED", details: { responseShape: expect.stringContaining(shape) } });
    }
  });

  it("bounds reviewer prompts and summaries while preserving only text content", async () => {
    let prompt = "";
    const reviewer = new PiModelReviewer(registry(), "test/testmodel", async (_selected, context) => {
      prompt = context.messages[0].content as string;
      return { ...message(JSON.stringify({ classification: "progress", summary: "s".repeat(1_000) })), content: [{ type: "thinking", thinking: "ignored" }, { type: "text", text: JSON.stringify({ classification: "progress", summary: "s".repeat(1_000) }) }] };
    });
    const result = await reviewer.review({ targetId: "p", metadata: { label: "x".repeat(20_000) }, transcriptDelta: ["y".repeat(20_000)] }, new AbortController().signal);
    expect(prompt.length).toBe(16_000);
    expect(result.summary).toHaveLength(500);
  });
});

describe("the ADR-036 interrupt-before-gate amendment", () => {
  const quiet: SupervisionSignalProbabilities = { progress: 0, stalled: 0, blocked: 0, risk: 0, appears_complete: 0 };

  it("evaluates risk and blocked before the evidence gate", () => {
    // Low evidence does not mute an interrupt: a miss is costlier than a false wake.
    expect(reduceSupervisionReview(0, { ...quiet, risk: SUPERVISION_RISK_THRESHOLD })).toBe("risk");
    expect(reduceSupervisionReview(0, { ...quiet, blocked: SUPERVISION_BLOCKED_THRESHOLD })).toBe("blocked");
    expect(reduceSupervisionReview(SUPERVISION_EVIDENCE_THRESHOLD - 0.01, { ...quiet, risk: 0.99 })).toBe("risk");
    expect(reduceSupervisionReview(SUPERVISION_EVIDENCE_THRESHOLD - 0.01, { ...quiet, blocked: 0.99 })).toBe("blocked");
  });

  it("keeps the evidence gate governing every non-interrupt signal", () => {
    for (const signal of ["appears_complete", "stalled", "progress"] as const) {
      expect(reduceSupervisionReview(SUPERVISION_EVIDENCE_THRESHOLD - 0.01, { ...quiet, [signal]: 1 })).toBe("unknown");
    }
    expect(reduceSupervisionReview(0, quiet)).toBe("unknown");
  });

  it("keeps risk ahead of blocked in precedence and honours the below-threshold boundary", () => {
    expect(reduceSupervisionReview(0, { ...quiet, risk: 1, blocked: 1 })).toBe("risk");
    expect(reduceSupervisionReview(0, { ...quiet, risk: SUPERVISION_RISK_THRESHOLD - 0.01, blocked: SUPERVISION_BLOCKED_THRESHOLD })).toBe("blocked");
    expect(reduceSupervisionReview(1, { ...quiet, risk: SUPERVISION_RISK_THRESHOLD - 0.01, blocked: SUPERVISION_BLOCKED_THRESHOLD - 0.01 })).toBe("unknown");
  });
});

describe("the reviewer version identity", () => {
  it("pins the ADR-034 threshold table verbatim under the ADR-036 reducer version", () => {
    expect(SUPERVISION_THRESHOLDS).toEqual({
      evidence: 0.6,
      risk: 0.6,
      blocked: 0.65,
      appears_complete: 0.7,
      stalled: 0.7,
      stalled_first_observation: 0.85,
      progress: 0.6,
    });
    expect(SUPERVISION_REDUCER_VERSION).toBe(2);
  });
});

describe("the ADR-036 first-observation stalled rule", () => {
  const quiet: SupervisionSignalProbabilities = { progress: 0, stalled: 0, blocked: 0, risk: 0, appears_complete: 0 };
  const reduce = (stalled: number, firstObservation: boolean, signals: Partial<SupervisionSignalProbabilities> = {}) =>
    reduceSupervisionReview(1, { ...quiet, stalled, ...signals }, { firstObservation });

  it("requires the raised bar when no prior review grounds the trajectory", () => {
    expect(reduce(SUPERVISION_STALLED_THRESHOLD, true)).toBe("unknown");
    expect(reduce(SUPERVISION_STALLED_FIRST_OBSERVATION_THRESHOLD - 0.01, true)).toBe("unknown");
    expect(reduce(SUPERVISION_STALLED_FIRST_OBSERVATION_THRESHOLD, true)).toBe("stalled");
  });

  it("keeps the standard bar once a prior review exists, and when the option is omitted", () => {
    expect(reduce(SUPERVISION_STALLED_THRESHOLD, false)).toBe("stalled");
    expect(reduce(SUPERVISION_STALLED_FIRST_OBSERVATION_THRESHOLD - 0.01, false)).toBe("stalled");
    expect(reduceSupervisionReview(1, { ...quiet, stalled: SUPERVISION_STALLED_THRESHOLD })).toBe("stalled");
  });

  it("falls through to the progress check when the raised bar is unmet", () => {
    expect(reduce(0.8, true, { progress: SUPERVISION_PROGRESS_THRESHOLD })).toBe("progress");
    expect(reduce(0.8, true, { progress: SUPERVISION_PROGRESS_THRESHOLD - 0.01 })).toBe("unknown");
  });

  it("leaves the signals ahead of stalled in precedence order untouched", () => {
    expect(reduce(0.8, true, { appears_complete: 0.75 })).toBe("appears_complete");
  });
});
