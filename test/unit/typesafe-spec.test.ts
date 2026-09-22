import { afterEach, describe, expect, it, vi } from "vitest";
import type { Catalog } from "../../src/catalog.js";
import type { RoutingTask } from "../../src/router.js";
import { MAX_SPEC_REQUEST_BYTES, TypeSafeSpecClient, buildEvaluationRequest, specRequestSize } from "../../src/typesafe-spec.js";

const TASK: RoutingTask = {
  objective: "Fix the bug",
  scope: "src only",
  doneWhen: ["the focused test passes"],
  constraints: ["do not change the API"],
  tier: "strong",
};
const CATALOG = {} as Catalog;
const INTENTS = ["explore", "reason", "implement", "debug", "verify", "review", "coordinate"];
const TIERS = ["utility", "economy", "standard", "strong", "frontier", "max"];

const choiceAnswer = (choice: string, keys: string[], confidence = 0.9) => ({
  type: "choice",
  choice,
  confidence,
  probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 1 : 0])),
});

const answers = (overrides: Record<string, unknown> = {}) => ({
  done_when_verifiable: { type: "noul", noul: 0.9 },
  intent: choiceAnswer("implement", INTENTS),
  weakest_sufficient_tier: choiceAnswer("economy", TIERS),
  ...overrides,
});

const wire = (value: unknown = { answers: answers() }, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "Content-Type": "application/json" },
});
const signal = () => new AbortController().signal;

function client(fetch: NonNullable<ConstructorParameters<typeof TypeSafeSpecClient>[0]>["fetch"]): TypeSafeSpecClient {
  return new TypeSafeSpecClient({ apiKey: "key", fetch });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("TypeSafeSpecClient", () => {
  it("sends one semantic-only Jev request with no tier, model, runner, provider, chain, workspace, or catalog state", async () => {
    const calls: Array<{ input: string | URL; init?: RequestInit }> = [];
    const outcome = await client(async (input, init) => (calls.push({ input, init }), wire())).evaluate({ task: TASK, catalog: CATALOG, workspaceState: "failed" }, signal());
    expect(outcome).toMatchObject({
      kind: "response",
      response: {
        intent: { value: "implement", confidence: 0.9 },
        tier: { value: "economy", confidence: 0.9 },
        uncertainDimensions: [],
      },
    });
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.model).toBe("jev-latest");
    expect(Object.keys(body.questions).sort()).toEqual(["done_when_verifiable", "intent", "weakest_sufficient_tier"]);
    expect(body.state).toEqual({ task: { objective: TASK.objective, scope: TASK.scope, doneWhen: TASK.doneWhen, constraints: TASK.constraints } });
    expect(JSON.stringify(body.state)).not.toMatch(/strong|failed|model|runner|provider|chain|catalog/u);
  });

  it("maps low-confidence intent to unknown but accepts any structurally valid tier confidence", async () => {
    const outcome = await client(async () => wire({ answers: answers({
      intent: choiceAnswer("debug", INTENTS, 0.1),
      weakest_sufficient_tier: choiceAnswer("frontier", TIERS, 0),
    }) })).evaluate({ task: TASK, catalog: CATALOG }, signal());
    expect(outcome).toMatchObject({ kind: "response", response: { intent: { value: "unknown", confidence: 0.1 }, tier: { value: "frontier", confidence: 0 }, uncertainDimensions: ["intent"] } });
  });

  it("measures the exact serialized SDK request and enforces 96 KiB before fetch or credential lookup", async () => {
    const built = buildEvaluationRequest({ task: TASK, catalog: CATALOG })!;
    expect(specRequestSize(built)).toEqual({ questions: 3, bytes: Buffer.byteLength(JSON.stringify({ model: "jev-latest", state: built.state, questions: built.questions }), "utf8") });
    expect(specRequestSize(built).bytes).toBeLessThan(MAX_SPEC_REQUEST_BYTES);
    const fetch = vi.fn(async () => wire());
    const huge = { ...TASK, objective: "x".repeat(MAX_SPEC_REQUEST_BYTES) };
    const outcome = await new TypeSafeSpecClient({ fetch, credentials: { read: vi.fn(async () => { throw new Error("must not read"); }) } }).evaluate({ task: huge, catalog: CATALOG }, signal());
    expect(outcome).toMatchObject({ kind: "abstained", reason: "invalid_response", component: "request_too_large", requestSize: { questions: 3, bytes: expect.any(Number) } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed tasks before transport", async () => {
    const fetch = vi.fn(async () => wire());
    for (const task of [null, {}, { ...TASK, doneWhen: "no" }, { ...TASK, constraints: [1] }, { ...TASK, tier: "ghost" }] as unknown as RoutingTask[]) {
      await expect(client(fetch).evaluate({ task, catalog: CATALOG }, signal())).resolves.toEqual({ kind: "abstained", reason: "invalid_response", component: "task" });
    }
    expect(buildEvaluationRequest({ task: null as unknown as RoutingTask, catalog: CATALOG })).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("strictly validates all three answers", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ done_when_verifiable: null }, "done_when_verifiable"],
      [{ done_when_verifiable: { type: "noul", noul: 2 } }, "done_when_verifiable"],
      [{ intent: null }, "intent"],
      [{ intent: { ...choiceAnswer("implement", INTENTS), choice: "other" } }, "intent"],
      [{ intent: { ...choiceAnswer("implement", INTENTS), probabilities: { implement: 1 } } }, "intent"],
      [{ intent: { ...choiceAnswer("implement", INTENTS), probabilities: { ghost: 0, reason: 0, implement: 1, debug: 0, verify: 0, review: 0, coordinate: 0 } } }, "intent"],
      [{ intent: { ...choiceAnswer("implement", INTENTS), probabilities: { explore: "no", reason: 0, implement: 1, debug: 0, verify: 0, review: 0, coordinate: 0 } } }, "intent"],
      [{ intent: { ...choiceAnswer("implement", INTENTS), probabilities: Object.fromEntries(INTENTS.map((key) => [key, 1])) } }, "intent"],
      [{ weakest_sufficient_tier: null }, "weakest_sufficient_tier"],
      [{ weakest_sufficient_tier: { ...choiceAnswer("economy", TIERS), confidence: 2 } }, "weakest_sufficient_tier"],
    ];
    for (const [override, component] of cases) {
      await expect(client(async () => wire({ answers: answers(override) })).evaluate({ task: TASK, catalog: CATALOG }, signal())).resolves.toEqual({ kind: "abstained", reason: "invalid_response", component });
    }
    for (const body of [null, {}, { answers: [] }]) {
      await expect(client(async () => wire(body)).evaluate({ task: TASK, catalog: CATALOG }, signal())).resolves.toEqual({ kind: "abstained", reason: "invalid_response", component: "response" });
    }
  });

  it("fails closed on authentication, abort, fetch failures, and sanitized HTTP errors", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    const fetch = vi.fn(async () => wire());
    await expect(new TypeSafeSpecClient({ fetch, credentials: { read: async () => undefined } }).evaluate({ task: TASK, catalog: CATALOG }, signal())).resolves.toEqual({ kind: "abstained", reason: "authentication_unavailable", component: "api_key" });
    const controller = new AbortController();
    controller.abort();
    await expect(client(fetch).evaluate({ task: TASK, catalog: CATALOG }, controller.signal)).resolves.toEqual({ kind: "abstained", reason: "aborted" });
    await expect(client(async () => { throw new Error("secret"); }).evaluate({ task: TASK, catalog: CATALOG }, signal())).resolves.toMatchObject({ kind: "abstained", reason: "transport_failed", component: "transport", requestSize: { questions: 3 } });
    const http = await client(async () => wire({ detail: { error_type: "max_tokens_exceeded", secret: "hidden" } }, 400)).evaluate({ task: TASK, catalog: CATALOG }, signal());
    expect(http).toMatchObject({ kind: "abstained", reason: "transport_failed", component: "http_400_max_tokens_exceeded", requestSize: { questions: 3 } });
    expect(JSON.stringify(http)).not.toContain("hidden");
    await expect(client(async () => wire({ detail: "private" }, 503)).evaluate({ task: TASK, catalog: CATALOG }, signal())).resolves.toMatchObject({ component: "http_503" });
  });

  it("uses store-first credentials, env fallback, explicit credentials, and global fetch", async () => {
    const seen: string[] = [];
    const fetch = async (_input: string | URL, init?: RequestInit) => {
      seen.push((init!.headers as Record<string, string>).Authorization);
      return wire();
    };
    vi.stubEnv("TYPESAFE_API_KEY", "env");
    await new TypeSafeSpecClient({ fetch, credentials: { read: async () => ({ type: "api_key", key: "store" }) as never } }).evaluate({ task: TASK, catalog: CATALOG }, signal());
    await new TypeSafeSpecClient({ fetch, credentials: { read: async () => undefined } }).evaluate({ task: TASK, catalog: CATALOG }, signal());
    await new TypeSafeSpecClient({ apiKey: "explicit", fetch }).evaluate({ task: TASK, catalog: CATALOG }, signal());
    expect(seen).toEqual(["Bearer store", "Bearer env", "Bearer explicit"]);
    const globalFetch = vi.fn(async () => wire());
    vi.stubGlobal("fetch", globalFetch);
    await expect(new TypeSafeSpecClient({ apiKey: "key" }).evaluate({ task: TASK, catalog: CATALOG }, signal())).resolves.toMatchObject({ kind: "response" });
    expect(globalFetch).toHaveBeenCalledOnce();
  });

  it("returns aborted when cancellation lands after the response", async () => {
    const controller = new AbortController();
    const outcome = await client(async () => {
      controller.abort();
      return wire();
    }).evaluate({ task: TASK, catalog: CATALOG }, controller.signal);
    expect(outcome).toEqual({ kind: "abstained", reason: "aborted" });
  });
});
