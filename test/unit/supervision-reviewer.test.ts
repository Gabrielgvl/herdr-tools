import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { ReviewerFailure, type ModelRegistrySeam } from "../../src/reviewer.js";
import {
  createBuiltinModelService,
  createRegistryModelService,
  type BuiltinModelsSeam,
} from "../../src/supervision/model-service.js";
import {
  ModelSupervisionReviewer,
  needsManagerAttention,
  SUPERVISION_REVIEWER_MAX_TOKENS,
  SUPERVISION_REVIEWER_MODEL,
  SUPERVISION_REVIEWER_THINKING,
} from "../../src/supervision/reviewer.js";

const model = { id: "gpt-5.6-luna", name: "Luna", provider: "openai-codex", api: "openai-completions", baseUrl: "http://test", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000, maxTokens: 1_000 } as Model<Api>;

function message(text: string): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 };
}

const request = { paneId: "p1", agentName: "worker", workingForMs: 300_000, metadata: { status: "working" }, transcriptDelta: ["line"] };

describe("the supervision reviewer model service", () => {
  it("adapts the Pi host registry and refuses an unauthenticated model", async () => {
    const registry = (ok: boolean, extras: Record<string, unknown> = {}): ModelRegistrySeam => ({
      find: () => model,
      getAll: () => [model],
      getApiKeyAndHeaders: async () => ok ? { ok: true, ...extras } as never : { ok: false, error: "no credential" },
    });
    await expect(createRegistryModelService(registry(true, { apiKey: "k", headers: { a: "b" } })).resolve("openai-codex/gpt-5.6-luna")).resolves.toEqual({ model, apiKey: "k", headers: { a: "b" } });
    await expect(createRegistryModelService(registry(true)).resolve("openai-codex/gpt-5.6-luna")).resolves.toEqual({ model });
    await expect(createRegistryModelService(registry(false)).resolve("openai-codex/gpt-5.6-luna")).rejects.toThrow(/not authenticated/u);
  });

  it("resolves host-independently from the installed built-in catalogue", async () => {
    const models = (found: boolean, auth: unknown): BuiltinModelsSeam => ({
      getModel: () => found ? model : undefined,
      getAuth: async () => auth as never,
    });
    await expect(createBuiltinModelService(models(true, { auth: { apiKey: "k", headers: { a: "b" } } })).resolve("openai-codex/gpt-5.6-luna")).resolves.toEqual({ model, apiKey: "k", headers: { a: "b" } });
    await expect(createBuiltinModelService(models(true, { auth: {} })).resolve("openai-codex/gpt-5.6-luna")).resolves.toEqual({ model });
    await expect(createBuiltinModelService(models(false, { auth: {} })).resolve("openai-codex/gpt-5.6-luna")).rejects.toThrow(/could not be resolved/u);
    await expect(createBuiltinModelService(models(true, undefined)).resolve("openai-codex/gpt-5.6-luna")).rejects.toThrow(/not authenticated/u);
    for (const identifier of ["luna", "/luna", "openai-codex/"]) {
      await expect(createBuiltinModelService(models(true, { auth: {} })).resolve(identifier)).rejects.toThrow(/must be provider\/model/u);
    }
  });
});

describe("the supervision reviewer", () => {
  it("pins the exact model at maximum thinking and never consults wait settings", async () => {
    const calls: Array<{ model: Model<Api>; options: Record<string, unknown> }> = [];
    const reviewer = new ModelSupervisionReviewer(
      { resolve: async (identifier) => { expect(identifier).toBe(SUPERVISION_REVIEWER_MODEL); return { model, apiKey: "k", headers: { a: "b" } }; } },
      async (selected, _context, options) => { calls.push({ model: selected as Model<Api>, options: options as Record<string, unknown> }); return message(JSON.stringify({ classification: "progress", summary: "moving" })); },
    );
    await expect(reviewer.review(request, new AbortController().signal)).resolves.toEqual({ classification: "progress", summary: "moving" });
    expect(SUPERVISION_REVIEWER_MODEL).toBe("openai-codex/gpt-5.6-luna");
    expect(calls[0]!.options).toMatchObject({ thinkingLevel: SUPERVISION_REVIEWER_THINKING, maxTokens: SUPERVISION_REVIEWER_MAX_TOKENS, apiKey: "k", headers: { a: "b" } });
    expect(SUPERVISION_REVIEWER_THINKING).toBe("max");
  });

  it("omits credentials the service did not supply and bounds the prompt", async () => {
    let prompt = "";
    const reviewer = new ModelSupervisionReviewer(
      { resolve: async () => ({ model }) },
      async (_model, context, options) => {
        prompt = String((context.messages[0] as { content: string }).content);
        expect(options).not.toHaveProperty("apiKey");
        expect(options).not.toHaveProperty("headers");
        return message(JSON.stringify({ classification: "stalled", summary: "no output" }));
      },
    );
    await reviewer.review({ ...request, transcriptDelta: ["x".repeat(50_000)] }, new AbortController().signal);
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(16_000);
    expect(prompt).toContain("continuously working");
  });

  it("fails closed on abort, on an unusable response, and on a transport error", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const reviewer = new ModelSupervisionReviewer({ resolve: async () => ({ model }) }, async () => message("{}"));
    await expect(reviewer.review(request, aborted.signal)).rejects.toBeInstanceOf(ReviewerFailure);

    const abortedMidflight = new ModelSupervisionReviewer({ resolve: async () => ({ model }) }, async () => ({ ...message(""), stopReason: "aborted" }));
    await expect(abortedMidflight.review(request, new AbortController().signal)).rejects.toThrow(/aborted/u);

    const malformed = new ModelSupervisionReviewer({ resolve: async () => ({ model }) }, async () => message("not json"));
    await expect(malformed.review(request, new AbortController().signal)).rejects.toThrow(/malformed JSON/u);

    const broken = new ModelSupervisionReviewer({ resolve: async () => ({ model }) }, async () => { throw new Error("network down"); });
    await expect(broken.review(request, new AbortController().signal)).rejects.toThrow(/model call failed/u);

    const unresolvable = new ModelSupervisionReviewer({ resolve: async () => { throw new ReviewerFailure("no model"); } }, async () => message("{}"));
    await expect(unresolvable.review(request, new AbortController().signal)).rejects.toThrow(/no model/u);
  });

  it("wakes the manager only for the attention classifications", () => {
    for (const classification of ["stalled", "blocked", "risk", "appears_complete", "unknown"] as const) {
      expect(needsManagerAttention(classification)).toBe(true);
    }
    expect(needsManagerAttention("progress")).toBe(false);
  });
});
