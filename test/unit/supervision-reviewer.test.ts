import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { ReviewerFailure, type ModelRegistrySeam } from "../../src/reviewer.js";
import {
  createBuiltinModelRegistry,
  createBuiltinModelService,
  createRegistryModelService,
  type BuiltinModelsSeam,
} from "../../src/supervision/model-service.js";
import {
  ModelSupervisionReviewer,
  needsManagerAttention,
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
      getModels: () => found ? [model] : [],
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

  it("presents the same catalogue as the wait reviewer's registry seam", async () => {
    const models = (auth: { auth: { apiKey?: string; headers?: Record<string, string> } } | undefined): BuiltinModelsSeam => ({
      getModel: (provider, id) => provider === "openai-codex" && id === model.id ? model : undefined,
      getModels: () => [model],
      getAuth: async () => auth,
    });
    const rejecting = (cause: unknown): BuiltinModelsSeam => ({ ...models(undefined), getAuth: async () => { throw cause; } });
    const registry = createBuiltinModelRegistry(models({ auth: { apiKey: "k", headers: { a: "b" } } }));
    expect(registry.find("openai-codex", "gpt-5.6-luna")).toBe(model);
    expect(registry.find("openai-codex", "other")).toBeUndefined();
    expect(registry.getAll()).toEqual([model]);
    await expect(registry.getApiKeyAndHeaders(model)).resolves.toEqual({ ok: true, apiKey: "k", headers: { a: "b" } });
    await expect(createBuiltinModelRegistry(models({ auth: {} })).getApiKeyAndHeaders(model)).resolves.toEqual({ ok: true });
    await expect(createBuiltinModelRegistry(models(undefined)).getApiKeyAndHeaders(model)).resolves.toEqual({ ok: false, error: "provider is not authenticated" });
    await expect(createBuiltinModelRegistry(rejecting(new Error("refresh exploded"))).getApiKeyAndHeaders(model)).resolves.toEqual({ ok: false, error: "refresh exploded" });
    await expect(createBuiltinModelRegistry(rejecting("string failure")).getApiKeyAndHeaders(model)).resolves.toEqual({ ok: false, error: "string failure" });
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
    expect(calls[0]!.options).toMatchObject({ reasoningEffort: SUPERVISION_REVIEWER_THINKING, apiKey: "k", headers: { a: "b" } });
    expect(SUPERVISION_REVIEWER_THINKING).toBe("max");
    // The pinned level must travel under the name the transport reads; an
    // option named for the thinking level is accepted by the type and dropped.
    expect(calls[0]!.options).not.toHaveProperty("thinkingLevel");
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

    // The bound is advertised in bytes, so it must hold for multibyte output too.
    await reviewer.review({ ...request, transcriptDelta: ["😀".repeat(20_000)] }, new AbortController().signal);
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(16_000);
    expect(prompt).toContain("continuously working");
    // No code point is split by the bound.
    expect(Buffer.from(prompt, "utf8").toString("utf8")).toBe(prompt);
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

  it("reads a wrapped answer without relaxing the schema and names the shape of an unusable one", async () => {
    const reviewerFor = (raw: string) => new ModelSupervisionReviewer({ resolve: async () => ({ model }) }, async () => message(raw));
    const review = (raw: string) => reviewerFor(raw).review(request, new AbortController().signal);

    // The recurring live failure: the intended object arrives inside a markdown
    // fence after a sentence, which a raw `JSON.parse` of the whole text refused.
    await expect(review("Here is my judgement.\n\n```json\n{\n  \"classification\": \"stalled\",\n  \"summary\": \"no new output for a full cadence\"\n}\n```\n"))
      .resolves.toEqual({ classification: "stalled", summary: "no new output for a full cadence" });

    // The `json` tag is optional, and a brace the child printed, echoed back
    // inside the summary, must not end the object early.
    const answer = JSON.stringify({ classification: "risk", summary: "child printed \"}\" and stopped" });
    await expect(review(`Verdict:\n\`\`\`\n${answer}\n\`\`\`\nThat is my call.`)).resolves.toEqual({ classification: "risk", summary: "child printed \"}\" and stopped" });

    // Recovering the fence must not accept a shape the contract refuses.
    await expect(review("```json\n{\"classification\":\"progress\",\"summary\":\"x\",\"confidence\":0.9}\n```")).rejects.toThrow(/incompatible response/u);
    await expect(review("```json\n{\"verdict\":\"progress\"}\n```")).rejects.toThrow(/incompatible response/u);

    // An unusable response still fails closed, and the failure names its size and
    // structure without echoing any transcript-derived text.
    for (const [raw, shape] of [
      ["  ", "empty response"],
      ["the child seems fine", "20 chars, no JSON fence"],
      ["I judge it {\"classification\":\"progress\",\"summary\":\"x\"}", "54 chars, no JSON fence"],
      ["```json\n{oops}\n```", "18 chars, fenced body did not parse"],
      ["```yaml\nclassification: progress\n```", "36 chars, fenced body did not parse"],
      [`\`\`\`json\n${answer}\n\`\`\`\nor maybe\n\`\`\`json\n${answer}\n\`\`\``, "172 chars, no single JSON fence"],
      ["```json\n{\"classification\": \"progress\"", "37 chars, no single JSON fence"],
    ] as const) {
      await expect(review(raw)).rejects.toMatchObject({ code: "REVIEWER_FAILED", message: `Reviewer returned malformed JSON (${shape})`, details: { responseShape: shape } });
    }
  });

  it("wakes the manager only for the attention classifications", () => {
    for (const classification of ["stalled", "blocked", "risk", "appears_complete", "unknown"] as const) {
      expect(needsManagerAttention(classification)).toBe(true);
    }
    expect(needsManagerAttention("progress")).toBe(false);
  });
});
