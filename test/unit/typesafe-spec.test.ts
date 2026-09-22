import { afterEach, describe, expect, it, vi } from "vitest";
import type { Catalog, OperatingPoint, RunnerEntry, RunnerKind, RunnerPools } from "../../src/catalog.js";
import type { CompiledContract } from "../../src/compile.js";
import { routeTask, type RoutingTask, type TaskModelDecision } from "../../src/router.js";
import { QUALITY_TIERS } from "../../src/routing-policy.js";
import { buildEvaluationRequest, specRequestSize, TypeSafeSpecClient, type TaskEvaluation } from "../../src/typesafe-spec.js";

const SCOPE = "/repo";

const TASK: RoutingTask = {
  objective: "Fix the bug",
  scope: "src/ only",
  doneWhen: ["the focused test passes"],
  constraints: ["stay inside src/"],
};

function runnerEntry(kind: RunnerKind, modelIds: string[], pools: Partial<RunnerPools>): RunnerEntry {
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
    models: modelIds.map((model) => ({ model })),
    quota: { provider: "test-provider", billingProduct: "test-product", account: "test-account", scope: "project" },
    defaults,
    plumbing,
    pools: { tools: [], extensions: [], skills: [], plugins: [], mcp: [], ...pools },
  };
}

function pointEntry(runner: RunnerKind, model: string, reasoning?: "low" | "high"): OperatingPoint {
  return {
    id: `${runner}:${model}${reasoning === undefined ? "" : `:${reasoning}`}`,
    runner,
    model,
    ...(reasoning === undefined ? {} : { reasoning }),
    provider: `${runner}-provider`,
    quota: { provider: `${runner}-provider`, billingProduct: "test-product", account: "test-account", scope: "project" },
    costClass: "medium",
    latencyClass: "medium",
  };
}

const POINTS: OperatingPoint[] = [
  pointEntry("pi", "pi-1", "low"),
  pointEntry("pi", "pi-2", "high"),
  pointEntry("claude", "cl-1", "high"),
  pointEntry("agy", "agy-1"),
];

/** pi runs two points; its resource nouls are asked once and cover both. */
const CATALOG: Catalog = {
  version: 2,
  runners: new Map<RunnerKind, RunnerEntry>([
    ["pi", runnerEntry("pi", ["pi-1", "pi-2"], { tools: ["read", "write"], skills: [`${SCOPE}/skills/worker`], mcp: ["herdr"] })],
    ["claude", runnerEntry("claude", ["cl-1"], { tools: ["Read"], plugins: [`${SCOPE}/plugins/worker`] })],
    ["agy", runnerEntry("agy", ["agy-1"], {})],
  ]),
  skills: [],
  plugins: [],
  mcpServers: new Map(),
  quotaSources: [{ name: "reactive-cooldowns", kind: "floor" }],
  points: POINTS,
  source: { path: `${SCOPE}/catalog.yaml`, scopeRoot: SCOPE },
};

const INTENTS = ["explore", "reason", "implement", "debug", "verify", "review", "coordinate"];
const MODIFIER_IDS = ["mutation_broad", "scope_repo_wide", "horizon_long", "ambiguity_high"];

function resourceIds(catalog: Catalog): string[] {
  const built = buildEvaluationRequest({ task: TASK, catalog });
  return built!.resourceQuestions.map((question) => question.id);
}

function fitnessIds(catalog: Catalog): string[] {
  const built = buildEvaluationRequest({ task: TASK, catalog });
  return built!.fitnessQuestions.map((question) => question.id);
}

function noulAnswer(probability = 0.9): Record<string, unknown> {
  return { type: "noul", noul: probability };
}

function intentAnswer(pick = "implement", confidence = 0.9, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "choice",
    choice: pick,
    confidence,
    probabilities: Object.fromEntries(INTENTS.map((name) => [name, name === pick ? 0.94 : 0.01])),
    ...overrides,
  };
}

function answerSet(overrides: Record<string, unknown> = {}, pick = "implement"): Record<string, unknown> {
  const answers: Record<string, unknown> = {
    done_when_verifiable: noulAnswer(),
    intent: intentAnswer(pick),
    mutation_broad: noulAnswer(0.4),
    scope_repo_wide: noulAnswer(0.4),
    horizon_long: noulAnswer(0.4),
    ambiguity_high: noulAnswer(0.4),
  };
  for (const id of [...resourceIds(CATALOG), ...fitnessIds(CATALOG)]) answers[id] = noulAnswer();
  return { ...answers, ...overrides };
}

function response(answers: Record<string, unknown> = answerSet()): Response {
  return new Response(JSON.stringify({ model: "jev-latest", answers, usage: { input_tokens: 1, output_tokens: 1 } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

type FetchCall = (input: string | URL, init?: RequestInit) => Promise<Response>;

function client(fetchCall: FetchCall, apiKey = "key"): TypeSafeSpecClient {
  return new TypeSafeSpecClient({ apiKey, fetch: fetchCall });
}

const signal = () => new AbortController().signal;

/** The normalized decision the wire fixture produces. */
function expectedDecision(overrides: Partial<TaskModelDecision> = {}): TaskEvaluation {
  const resources: Record<string, Record<string, Record<string, number>>> = {
    pi: { tools: { read: 0.9, write: 0.9 }, skills: { [`${SCOPE}/skills/worker`]: 0.9 }, mcp: { herdr: 0.9 } },
    claude: { tools: { Read: 0.9 }, plugins: { [`${SCOPE}/plugins/worker`]: 0.9 } },
  };
  const fitness: Record<string, Record<string, number>> = {};
  for (const index of POINTS.keys()) {
    fitness[String(index)] = Object.fromEntries(QUALITY_TIERS.map((tier) => [tier, 0.9])) as Record<string, number>;
  }
  return {
    kind: "response",
    response: {
      quality: { done_when_verifiable: 0.9 },
      intent: { value: "implement", confidence: 0.9, probabilities: Object.fromEntries(INTENTS.map((name) => [name, name === "implement" ? 0.94 : 0.01])) },
      modifiers: {
        mutation_broad: { probability: 0.4, applied: false, confidence: 0.6 },
        scope_repo_wide: { probability: 0.4, applied: false, confidence: 0.6 },
        horizon_long: { probability: 0.4, applied: false, confidence: 0.6 },
        ambiguity_high: { probability: 0.4, applied: false, confidence: 0.6 },
      },
      resources,
      fitness,
      uncertainDimensions: [],
      ...overrides,
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("TypeSafeSpecClient request", () => {
  it("sends exactly one POST carrying the canonical Task state, the done-when gate, the intent choice, four modifier nouls, and runner-deduped resource and point-fitness nouls", async () => {
    const calls: Array<{ input: string | URL; init?: RequestInit }> = [];
    const outcome = await new TypeSafeSpecClient({
      apiKey: "key",
      fetch: async (input, init) => {
        calls.push({ input, init });
        return response();
      },
    }).evaluate({ task: TASK, catalog: CATALOG }, signal());
    expect(outcome).toEqual(expectedDecision());
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      input: "https://api.typesafe.ai/v1/systemone",
      init: { method: "POST", headers: { Authorization: "Bearer key", "Content-Type": "application/json" } },
    });
    expect(calls[0]!.init!.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(Object.keys(body).sort()).toEqual(["model", "questions", "state"]);
    expect(body.model).toBe("jev-latest");

    // The state projection: the canonical Task, runtime workspace state, the
    // ordered point list the index-keyed fitness nouls refer to, and the
    // runner-qualified resource pools — no argv, quota, or host state.
    expect(Object.keys(body.state).sort()).toEqual(["points", "resources", "task", "workspaceState"]);
    expect(body.state.task).toEqual({
      objective: "Fix the bug",
      scope: "src/ only",
      doneWhen: ["the focused test passes"],
      constraints: ["stay inside src/"],
    });
    expect(body.state.workspaceState).toBe("clean");
    expect(body.state.points).toHaveLength(POINTS.length);
    expect(body.state.points[0]).toMatchObject({ index: 0, id: "pi:pi-1:low", runner: "pi", model: "pi-1" });
    expect(body.state.resources.pi.tools).toEqual(["read", "write"]);
    expect(body.state.resources.pi.skills).toEqual(["skills/worker"]);

    // The quality gate noul and the intent choice — the only confidence gate.
    expect(body.questions.done_when_verifiable).toMatchObject({ type: "noul" });
    expect(body.questions.done_when_verifiable.instructions).toContain("doneWhen");
    expect(body.questions.intent).toMatchObject({ type: "choice" });
    expect(Object.keys(body.questions.intent.criteria).sort()).toEqual([...INTENTS].sort());

    // The four one-sided positive modifier nouls.
    for (const id of MODIFIER_IDS) {
      expect(body.questions[id], id).toMatchObject({ type: "noul" });
    }
    expect(body.questions.mutation_broad.instructions).toContain("delegates");
    expect(body.questions.scope_repo_wide.instructions).toContain("independent subsystems");

    // pi's four resource nouls cover both of its points; agy asks none.
    const ids = Object.keys(body.questions);
    for (const id of resourceIds(CATALOG)) {
      expect(ids).toContain(id);
      expect(body.questions[id].type).toBe("noul");
    }
    expect(body.questions.resource_pi_skills_0.instructions).toContain('the skill "skills/worker"');
    expect(body.questions.resource_pi_mcp_0.instructions).toContain('the MCP server "herdr"');
    expect(body.questions.resource_claude_plugins_0.instructions).toContain('the plugin "plugins/worker"');

    // Six tier-fitness nouls per point, index-keyed because ids contain colons.
    const fitness = fitnessIds(CATALOG);
    expect(fitness).toHaveLength(POINTS.length * QUALITY_TIERS.length);
    for (const id of fitness) expect(body.questions[id].type).toBe("noul");
    expect(body.questions["fitness:t2:0"].instructions).toContain('"pi:pi-1:low"');
    expect(body.questions["fitness:t2:0"].instructions).toContain('"standard"');

    // Total: gate + intent + 4 modifiers + 6 resources + 24 fitness.
    expect(ids).toHaveLength(2 + MODIFIER_IDS.length + resourceIds(CATALOG).length + fitness.length);
  });

  it("carries the requested tier and runtime workspace state into the outbound state", async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    await client(async (_input, init) => (calls.push({ init }), response())).evaluate(
      { task: { ...TASK, tier: "strong" }, catalog: CATALOG, workspaceState: "partial" },
      signal()
    );
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.state.task.tier).toBe("strong");
    expect(body.state.workspaceState).toBe("partial");
  });

  it("measures the outbound request size as question count plus serialized bytes", () => {
    const built = buildEvaluationRequest({ task: TASK, catalog: CATALOG })!;
    const size = specRequestSize(built);
    expect(size.questions).toBe(Object.keys(built.questions).length);
    expect(size.questions).toBe(36);
    expect(size.bytes).toBe(Buffer.byteLength(JSON.stringify({ state: built.state, questions: built.questions }), "utf8"));
    expect(size.bytes).toBeGreaterThan(0);
    // The measurer is pure: it only reads the request projection.
    expect(specRequestSize({ questions: {}, state: {} })).toEqual({ questions: 0, bytes: Buffer.byteLength('{"state":{},"questions":{}}', "utf8") });
  });

  it("emits no SDK log output at any level", async () => {
    const spies = [vi.spyOn(console, "debug"), vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    await client(async () => response()).evaluate({ task: TASK, catalog: CATALOG }, signal());
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("uses the global fetch seam when none is injected", async () => {
    const fetchCall = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetchCall);
    const outcome = await new TypeSafeSpecClient({ apiKey: "key" }).evaluate({ task: TASK, catalog: CATALOG }, signal());
    expect(outcome.kind).toBe("response");
    expect(fetchCall).toHaveBeenCalledOnce();
  });
});

describe("TypeSafeSpecClient normalization", () => {
  it("marks the intent uncertain below the 0.8 confidence gate — modifiers never mark uncertainty", async () => {
    const low = await client(async () => response(answerSet({ intent: intentAnswer("implement", 0.79) }))).evaluate({ task: TASK, catalog: CATALOG }, signal());
    expect(low).toMatchObject({ kind: "response", response: { uncertainDimensions: ["intent"], intent: { value: "implement", confidence: 0.79 } } });
    // A modifier at the same probability carries applied=false and no uncertainty.
    const modifiers = await client(async () => response(answerSet({ mutation_broad: noulAnswer(0.69) }))).evaluate({ task: TASK, catalog: CATALOG }, signal());
    expect(modifiers).toMatchObject({ kind: "response", response: { uncertainDimensions: [], modifiers: { mutation_broad: { probability: 0.69, applied: false } } } });
    const applied = await client(async () => response(answerSet({ mutation_broad: noulAnswer(0.7) }))).evaluate({ task: TASK, catalog: CATALOG }, signal());
    expect(applied).toMatchObject({ kind: "response", response: { modifiers: { mutation_broad: { probability: 0.7, applied: true } } } });
  });

  it("feeds routeTask directly: a normalized response admits through the real policy", async () => {
    const outcome = await client(async () => response()).evaluate({ task: TASK, catalog: CATALOG }, signal());
    if (outcome.kind !== "response") throw new Error("expected a response");
    const configuration: CompiledContract = {
      specLabel: "worker",
      candidate: { index: 0, id: "pi:pi-1:low", runner: "pi", model: "pi-1", reasoning: "low" },
      quota: { provider: "test-provider", billingProduct: "test-product", account: "test-account", scope: "project" },
      scopeRoot: SCOPE,
      sessionPersistence: false,
      timeoutMinutes: 30,
      plumbing: { sessionPersistence: "optional", promptDelivery: "file", skillSelection: "exact", toolSelection: "allowlist" },
      runtime: { kind: "pi", model: "pi-1", thinking: "low", tools: ["read"], extensions: [], skills: [] },
      resources: {},
      derivations: [],
      gaps: [],
    };
    const decision = await routeTask({
      task: TASK,
      spec: { label: "worker", count: 1 },
      catalog: CATALOG,
      response: outcome.response,
      availability: async () => ({ status: "unknown", retryNotBefore: null, evidence: { records: 0 } }),
      compile: async () => configuration,
    });
    expect(decision).toMatchObject({
      kind: "admitted",
      quality: "not_rejected",
      requestedTier: "standard",
      evidence: { intent: { value: "implement", confidence: 0.9 } },
    });
  });

  const invalidCases: Array<{ name: string; overrides: Record<string, unknown>; component: string }> = [
    { name: "missing done_when_verifiable", overrides: { done_when_verifiable: null }, component: "done_when_verifiable" },
    { name: "wrong done_when_verifiable type", overrides: { done_when_verifiable: { type: "score", noul: 0.9 } }, component: "done_when_verifiable" },
    { name: "non-numeric done_when_verifiable noul", overrides: { done_when_verifiable: { type: "noul", noul: "yes" } }, component: "done_when_verifiable" },
    { name: "out-of-range done_when_verifiable noul", overrides: { done_when_verifiable: noulAnswer(1.5) }, component: "done_when_verifiable" },
    { name: "missing intent", overrides: { intent: null }, component: "intent" },
    { name: "wrong intent type", overrides: { intent: noulAnswer() }, component: "intent" },
    { name: "foreign intent choice", overrides: { intent: intentAnswer("implement", 0.9, { choice: "intruder" }) }, component: "intent" },
    { name: "out-of-range intent confidence", overrides: { intent: intentAnswer("implement", 1.5) }, component: "intent" },
    { name: "intent probabilities missing a key", overrides: { intent: intentAnswer("implement", 0.9, { probabilities: { implement: 1 } }) }, component: "intent" },
    { name: "intent probabilities with a foreign key", overrides: { intent: intentAnswer("implement", 0.9, { probabilities: { ...Object.fromEntries(INTENTS.map((n) => [n, 0.1])), intruder: 0.3 } }) }, component: "intent" },
    { name: "intent probabilities not summing to one", overrides: { intent: intentAnswer("implement", 0.9, { probabilities: Object.fromEntries(INTENTS.map((n) => [n, 0.9])) }) }, component: "intent" },
    { name: "missing modifier noul", overrides: { mutation_broad: null }, component: "mutation_broad" },
    { name: "wrong modifier type", overrides: { horizon_long: intentAnswer() }, component: "horizon_long" },
    { name: "out-of-range modifier noul", overrides: { ambiguity_high: noulAnswer(2) }, component: "ambiguity_high" },
    { name: "missing resource noul", overrides: { resource_pi_tools_0: null }, component: "resource_pi_tools_0" },
    { name: "wrong resource noul type", overrides: { resource_pi_tools_0: intentAnswer() }, component: "resource_pi_tools_0" },
    { name: "out-of-range resource noul", overrides: { resource_claude_plugins_0: noulAnswer(2) }, component: "resource_claude_plugins_0" },
    { name: "missing fitness noul", overrides: { "fitness:t0:0": null }, component: "fitness:t0:0" },
    { name: "out-of-range fitness noul", overrides: { "fitness:t5:3": noulAnswer(-0.1) }, component: "fitness:t5:3" },
  ];

  for (const { name, overrides, component } of invalidCases) {
    it(`abstains invalid_response on ${name}`, async () => {
      const outcome = await client(async () => response(answerSet(overrides))).evaluate({ task: TASK, catalog: CATALOG }, signal());
      expect(outcome).toEqual({ kind: "abstained", reason: "invalid_response", component });
    });
  }

  it("abstains invalid_response on malformed or empty top-level bodies", async () => {
    for (const body of [null, {}, { answers: [] }, { answers: null }, "not json"]) {
      const outcome = await client(async () => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })).evaluate({ task: TASK, catalog: CATALOG }, signal());
      expect(outcome).toEqual({ kind: "abstained", reason: "invalid_response", component: "response" });
    }
    const empty = await client(async () => new Response("", { status: 200 })).evaluate({ task: TASK, catalog: CATALOG }, signal());
    expect(empty).toEqual({ kind: "abstained", reason: "invalid_response", component: "response" });
    const text = await client(async () => new Response("not json", { status: 200, headers: { "Content-Type": "application/json" } })).evaluate({ task: TASK, catalog: CATALOG }, signal());
    expect(text).toEqual({ kind: "abstained", reason: "invalid_response", component: "response" });
  });

  it("rejects nonfinite answer values delivered over the wire", async () => {
    // JSON cannot express Infinity: a "NONFINITE" string sentinel is spliced
    // into the wire text as 1e999, which JSON.parse reads as Infinity.
    const wire = (qid: string, answer: Record<string, unknown>) =>
      JSON.stringify({ model: "jev-latest", answers: answerSet({ [qid]: answer }), usage: {} }).replace('"NONFINITE"', "1e999");
    const cases: Array<{ name: string; text: string; component: string }> = [
      { name: "quality noul", text: wire("done_when_verifiable", { type: "noul", noul: "NONFINITE" }), component: "done_when_verifiable" },
      { name: "intent confidence", text: wire("intent", intentAnswer("implement", 0.9, { confidence: "NONFINITE" })), component: "intent" },
      {
        name: "intent probability entry",
        text: wire("intent", intentAnswer("implement", 0.9, { probabilities: { ...Object.fromEntries(INTENTS.map((n) => [n, n === "implement" ? "NONFINITE" : 0.1])) } })),
        component: "intent",
      },
      { name: "modifier noul", text: wire("scope_repo_wide", { type: "noul", noul: "NONFINITE" }), component: "scope_repo_wide" },
      { name: "resource noul", text: wire("resource_pi_tools_1", { type: "noul", noul: "NONFINITE" }), component: "resource_pi_tools_1" },
      { name: "fitness noul", text: wire("fitness:t2:1", { type: "noul", noul: "NONFINITE" }), component: "fitness:t2:1" },
    ];
    for (const { name, text, component } of cases) {
      const outcome = await client(async () => new Response(text, { status: 200, headers: { "Content-Type": "application/json" } })).evaluate({ task: TASK, catalog: CATALOG }, signal());
      expect(outcome, name).toEqual({ kind: "abstained", reason: "invalid_response", component });
    }
  });

  it("ignores foreign answers that carry no question", async () => {
    const outcome = await client(async () => response({ ...answerSet(), unexpected: noulAnswer(0.1), another: "junk" })).evaluate({ task: TASK, catalog: CATALOG }, signal());
    expect(outcome).toEqual(expectedDecision());
  });
});

describe("TypeSafeSpecClient typed outcomes", () => {
  it("abstains authentication_unavailable without any resolvable key and never calls fetch", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    const fetchCall = vi.fn(async () => response());
    const missing = await new TypeSafeSpecClient({ fetch: fetchCall, credentials: { read: async () => undefined } }).evaluate({ task: TASK, catalog: CATALOG }, signal());
    expect(missing).toEqual({ kind: "abstained", reason: "authentication_unavailable", component: "api_key" });
    expect(fetchCall).not.toHaveBeenCalled();

    const empty = await new TypeSafeSpecClient({ apiKey: "", fetch: fetchCall }).evaluate({ task: TASK, catalog: CATALOG }, signal());
    expect(empty).toEqual({ kind: "abstained", reason: "authentication_unavailable", component: "api_key" });
    expect(fetchCall).not.toHaveBeenCalled();
  });

  it("resolves the key env-first, then the Pi auth store, preferring an explicit option over both", async () => {
    const store = { read: async () => ({ type: "api_key", key: "store-key" }) as never };
    vi.stubEnv("TYPESAFE_API_KEY", "");
    const calls: Array<{ init?: RequestInit }> = [];
    const fetchCall: FetchCall = async (_input, init) => (calls.push({ init }), response());
    await new TypeSafeSpecClient({ fetch: fetchCall, credentials: store }).evaluate({ task: TASK, catalog: CATALOG }, signal());
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer store-key");

    vi.stubEnv("TYPESAFE_API_KEY", "env-key");
    calls.length = 0;
    await new TypeSafeSpecClient({ fetch: fetchCall, credentials: store }).evaluate({ task: TASK, catalog: CATALOG }, signal());
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer env-key");

    calls.length = 0;
    await new TypeSafeSpecClient({ apiKey: "explicit", fetch: fetchCall, credentials: store }).evaluate({ task: TASK, catalog: CATALOG }, signal());
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer explicit");
  });

  it("abstains catalog_unavailable on a malformed catalog or a point whose runner is missing, without calling fetch", async () => {
    const fetchCall = vi.fn(async () => response());
    for (const catalog of [undefined, {}, { runners: [] }] as unknown as Catalog[]) {
      const outcome = await client(fetchCall).evaluate({ task: TASK, catalog }, signal());
      expect(outcome).toEqual({ kind: "abstained", reason: "catalog_unavailable", component: "catalog" });
    }
    const missingRunner: Catalog = { ...CATALOG, runners: new Map([...CATALOG.runners].filter(([kind]) => kind !== "pi")) };
    const outcome = await client(fetchCall).evaluate({ task: TASK, catalog: missingRunner }, signal());
    expect(outcome).toEqual({ kind: "abstained", reason: "catalog_unavailable", component: "catalog" });
    expect(fetchCall).not.toHaveBeenCalled();
  });

  it("abstains invalid_response on a malformed task without calling fetch", async () => {
    const fetchCall = vi.fn(async () => response());
    for (const task of [
      undefined,
      {},
      { objective: "x" },
      { ...TASK, doneWhen: "x" },
      { ...TASK, constraints: [5] },
      { ...TASK, tier: "ghost" },
    ] as unknown as RoutingTask[]) {
      const outcome = await client(fetchCall).evaluate({ task, catalog: CATALOG }, signal());
      expect(outcome).toEqual({ kind: "abstained", reason: "invalid_response", component: "task" });
    }
    expect(fetchCall).not.toHaveBeenCalled();
  });

  for (const status of [401, 429, 503]) {
    it(`maps HTTP ${status} to transport_failed with only the bounded status`, async () => {
      const fetchCall = vi.fn(async () => new Response(JSON.stringify({ detail: `server-secret-${status}` }), { status }));
      const outcome = await client(fetchCall).evaluate({ task: TASK, catalog: CATALOG }, signal());
      expect(outcome).toEqual({ kind: "abstained", reason: "transport_failed", component: `http_${status}` });
      expect(fetchCall).toHaveBeenCalledTimes(1);
      const exposed = JSON.stringify(outcome);
      expect(exposed).not.toContain(`server-secret-${status}`);
      expect(exposed).not.toContain("Bearer");
      expect(exposed).not.toContain("key");
    });
  }

  it("maps rejected fetch to transport_failed without exposing raw failure text", async () => {
    for (const thrown of [new Error("offline-secret"), "offline-secret"]) {
      const outcome = await client(async () => {
        throw thrown;
      }).evaluate({ task: TASK, catalog: CATALOG }, signal());
      expect(outcome).toEqual({ kind: "abstained", reason: "transport_failed", component: "transport" });
      expect(JSON.stringify(outcome)).not.toContain("offline-secret");
    }
  });

  it("maps a request timeout to transport_failed", async () => {
    vi.useFakeTimers();
    const hanging: FetchCall = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true });
      });
    const pending = client(hanging).evaluate({ task: TASK, catalog: CATALOG }, signal());
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(pending).resolves.toEqual({ kind: "abstained", reason: "transport_failed", component: "transport" });
  });

  it("aborts before, during, and after the request", async () => {
    const before = new AbortController();
    before.abort();
    const fetchCall = vi.fn(async () => response());
    const outcome = await client(fetchCall).evaluate({ task: TASK, catalog: CATALOG }, before.signal);
    expect(outcome).toEqual({ kind: "abstained", reason: "aborted" });
    expect(fetchCall).not.toHaveBeenCalled();

    const during = new AbortController();
    const hanging: FetchCall = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true });
      });
    const pending = client(hanging).evaluate({ task: TASK, catalog: CATALOG }, during.signal);
    during.abort();
    await expect(pending).resolves.toEqual({ kind: "abstained", reason: "aborted" });

    const after = new AbortController();
    const late = await client(async () => {
      after.abort();
      return response();
    }).evaluate({ task: TASK, catalog: CATALOG }, after.signal);
    expect(late).toEqual({ kind: "abstained", reason: "aborted" });
  });

  it("rechecks cancellation after a fully parsed response before returning", async () => {
    const after = new AbortController();
    // A duck-typed Response that aborts the caller inside text(): the body parses
    // successfully, then the client's pre-return abort check must still win.
    const fake = {
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
      clone: () => ({ body: undefined }),
      text: async () => {
        after.abort();
        return JSON.stringify({ model: "jev-latest", answers: answerSet(), usage: {} });
      },
    } as unknown as Response;
    const outcome = await client(async () => fake).evaluate({ task: TASK, catalog: CATALOG }, after.signal);
    expect(outcome).toEqual({ kind: "abstained", reason: "aborted" });
  });

  it("never exposes key material in any outcome", async () => {
    const outcomes: TaskEvaluation[] = [
      await client(async () => response()).evaluate({ task: TASK, catalog: CATALOG }, signal()),
      await client(async () => new Response("{}", { status: 500 })).evaluate({ task: TASK, catalog: CATALOG }, signal()),
      await client(async () => response(answerSet({ done_when_verifiable: null }))).evaluate({ task: TASK, catalog: CATALOG }, signal()),
    ];
    for (const outcome of outcomes) {
      const exposed = JSON.stringify(outcome);
      expect(exposed).not.toContain('"key"');
      expect(exposed).not.toContain("Bearer");
    }
  });
});

describe("TypeSafeSpecClient catalog edges", () => {
  it("names pool resources verbatim when the catalog has no usable scopeRoot", async () => {
    for (const source of [undefined, { path: "/x/catalog.yaml", scopeRoot: 5 }, { path: "/x/catalog.yaml", scopeRoot: "" }]) {
      const calls: string[] = [];
      const catalog = { ...CATALOG, source } as unknown as Catalog;
      const outcome = await client(async (_input, init) => {
        calls.push(init!.body as string);
        return response();
      }).evaluate({ task: TASK, catalog }, signal());
      expect(outcome.kind).toBe("response");
      expect(calls).toHaveLength(1);
      // displayResource fell back to the raw pool entry — the scope-qualified path is sent verbatim.
      expect(calls[0]).toContain(`${SCOPE}/skills/worker`);
    }
  });

  it("asks no resource nouls for a catalog whose points ride only ambient runners", async () => {
    const ambient: Catalog = { ...CATALOG, points: [pointEntry("agy", "agy-1"), pointEntry("devin", "dev-1")], runners: new Map([...CATALOG.runners, ["devin", runnerEntry("devin", ["dev-1"], {})]]) };
    const built = buildEvaluationRequest({ task: TASK, catalog: ambient })!;
    expect(built.resourceQuestions).toHaveLength(0);
    expect(built.fitnessQuestions).toHaveLength(2 * QUALITY_TIERS.length);
  });

  it("treats a catalog whose points were never generated as an empty point list", async () => {
    const bare: Catalog = { ...CATALOG };
    delete bare.points;
    const built = buildEvaluationRequest({ task: TASK, catalog: bare })!;
    expect(built.resourceQuestions).toHaveLength(0);
    expect(built.fitnessQuestions).toHaveLength(0);
    expect(built.state.points).toEqual([]);
    expect(Object.keys(built.questions)).toHaveLength(6);
  });
});
