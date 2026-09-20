import { afterEach, describe, expect, it, vi } from "vitest";
import type { Catalog, ChainCandidate, RunnerEntry, RunnerKind, RunnerPools } from "../../src/catalog.js";
import type { CompiledContract } from "../../src/compile.js";
import type { LaunchSpec } from "../../src/launch-schema.js";
import { routeSpec, type CandidateJudgment } from "../../src/router.js";
import { TypeSafeSpecClient, type SpecEvaluation } from "../../src/typesafe-spec.js";

const SCOPE = "/repo";

const SPEC: LaunchSpec = {
  label: "worker",
  instructions: "Implement the fix as the single writer and report the changed paths.",
  assignment: { objective: "Fix the bug", scope: "src/ only", verification: "the focused test passes" },
};

function runnerEntry(kind: RunnerKind, models: string[], pools: Partial<RunnerPools>): RunnerEntry {
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
    models,
    quota: { provider: "test-provider", billingProduct: "test-product", account: "test-account", scope: "project" },
    defaults,
    plumbing,
    pools: { tools: [], extensions: [], skills: [], plugins: [], mcp: [], ...pools },
  };
}

/** pi appears in two chains; its nouls are asked once and cover both candidates. */
const CATALOG: Catalog = {
  version: 1,
  maxAttempts: 4,
  categories: new Map<string, ChainCandidate[]>([
    ["frontier", [{ runner: "pi", model: "pi-1" }, { runner: "claude", model: "cl-1" }]],
    ["cheap", [{ runner: "agy", model: "agy-1" }, { runner: "pi", model: "pi-2", account: "alt" }]],
  ]),
  runners: new Map<RunnerKind, RunnerEntry>([
    ["pi", runnerEntry("pi", ["pi-1", "pi-2"], { tools: ["read", "write"], skills: [`${SCOPE}/skills/worker`], mcp: ["herdr"] })],
    ["claude", runnerEntry("claude", ["cl-1"], { tools: ["Read"], plugins: [`${SCOPE}/plugins/worker`] })],
    ["agy", runnerEntry("agy", ["agy-1"], {})],
  ]),
  skills: [],
  plugins: [],
  mcpServers: new Map(),
  quotaSources: [{ name: "reactive-cooldowns", kind: "floor" }],
  source: { path: `${SCOPE}/catalog.yaml`, scopeRoot: SCOPE },
};

const RESOURCE_IDS = [
  "resource_pi_tools_0",
  "resource_pi_tools_1",
  "resource_pi_skills_0",
  "resource_pi_mcp_0",
  "resource_claude_tools_0",
  "resource_claude_plugins_0",
];

const QUESTION_IDS = ["instructions_adequate", "assignment_verifiable", "category", "missing_area", ...RESOURCE_IDS];

function resourceIds(catalog: Catalog): string[] {
  const ids: string[] = [];
  const runners = new Set<RunnerKind>();
  for (const chain of catalog.categories.values()) for (const candidate of chain) runners.add(candidate.runner);
  for (const runner of runners) {
    const pools = catalog.runners.get(runner)!.pools;
    for (const field of ["tools", "extensions", "skills", "plugins", "mcp"] as const) {
      pools[field].forEach((_name, index) => ids.push(`resource_${runner}_${field}_${index}`));
    }
  }
  return ids;
}

function noulAnswer(probability = 0.9): Record<string, unknown> {
  return { type: "noul", noul: probability };
}

function choiceAnswer(pick = "frontier", confidence = 0.9, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const names = [...CATALOG.categories.keys()];
  return {
    type: "choice",
    choice: pick,
    confidence,
    probabilities: Object.fromEntries(names.map((name) => [name, name === pick ? 0.9 : 0.1])),
    ...overrides,
  };
}

function answerSet(overrides: Record<string, unknown> = {}, pick = "frontier"): Record<string, unknown> {
  const answers: Record<string, unknown> = {
    instructions_adequate: noulAnswer(),
    assignment_verifiable: noulAnswer(),
    category: choiceAnswer(pick),
    missing_area: noulAnswer(),
  };
  for (const id of resourceIds(CATALOG)) answers[id] = noulAnswer();
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

function responseFor(pick = "frontier", composition: { missing_area: number; assessed: readonly string[] } = { missing_area: 0.9, assessed: ["worker"] }): SpecEvaluation {
  const piResources = { tools: { read: 0.9, write: 0.9 }, skills: { [`${SCOPE}/skills/worker`]: 0.9 }, mcp: { herdr: 0.9 } };
  const claudeResources = { tools: { Read: 0.9 }, plugins: { [`${SCOPE}/plugins/worker`]: 0.9 } };
  const candidates: CandidateJudgment[] = pick === "frontier"
    ? [
        { index: 0, runner: "pi", model: "pi-1", resources: piResources },
        { index: 1, runner: "claude", model: "cl-1", resources: claudeResources },
      ]
    : [
        { index: 0, runner: "agy", model: "agy-1", resources: {} },
        { index: 1, runner: "pi", model: "pi-2", resources: piResources },
      ];
  return {
    kind: "response",
    response: {
      quality: { instructions_adequate: 0.9, assignment_verifiable: 0.9 },
      category: { category: pick, confidence: 0.9, probabilities: { frontier: pick === "frontier" ? 0.9 : 0.1, cheap: pick === "cheap" ? 0.9 : 0.1 } },
      candidates,
      composition,
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
  it("sends exactly one POST carrying the allowlisted spec state, the literal probe-2b gate, the category choice, and one noul per resource × candidate runner", async () => {
    const calls: Array<{ input: string | URL; init?: RequestInit }> = [];
    const outcome = await new TypeSafeSpecClient({
      apiKey: "key",
      fetch: async (input, init) => {
        calls.push({ input, init });
        return response();
      },
    }).evaluate({ spec: SPEC, catalog: CATALOG }, signal());
    expect(outcome).toEqual(responseFor());
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      input: "https://api.typesafe.ai/v1/systemone",
      init: { method: "POST", headers: { Authorization: "Bearer key", "Content-Type": "application/json" } },
    });
    expect(calls[0]!.init!.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(Object.keys(body).sort()).toEqual(["model", "questions", "state"]);
    expect(body.model).toBe("jev-latest");

    // Exact state allowlist: the spec's semantic fields plus the planned team
    // projection — no catalog, pools, tools, argv, quota, environment, or host
    // source paths.
    expect(Object.keys(body.state)).toEqual(["spec", "team"]);
    expect(body.state.spec).toEqual({
      label: "worker",
      instructions: "Implement the fix as the single writer and report the changed paths.",
      assignment: { objective: "Fix the bug", scope: "src/ only", verification: "the focused test passes" },
    });
    expect(body.state.team).toEqual([body.state.spec]);
    expect(JSON.stringify(body.state)).not.toContain(SCOPE);

    // The literal probe-2b gate wording, verbatim.
    expect(body.questions.instructions_adequate).toEqual({
      type: "noul",
      instructions:
        "Are these instructions sufficient for a competent agent to begin this work correctly? Detailed methodology may arrive via separately selected skills — judge only whether the instructions state the agent's job and conduct clearly enough to start.",
      criteria: {
        true: "The instructions state the job and expected conduct clearly enough to begin correctly.",
        false: "The instructions are too vague or missing for the agent to know what job it has or how to behave.",
      },
    });
    expect(body.questions.assignment_verifiable).toEqual({
      type: "noul",
      instructions: "Does assignment.verification name concrete, checkable evidence a supervisor could verify without re-doing the work?",
      criteria: {
        true: "Verification specifies concrete, falsifiable evidence (tests, outputs, diffs, artifacts).",
        false: "Verification is vague ('it works'), absent, or requires re-doing the work to check.",
      },
    });

    // The category confirm/override choice over the catalog's category chains.
    expect(body.questions.category).toEqual({
      type: "choice",
      instructions:
        "Which catalog category best fits this spec's label, instructions, and assignment? Each option lists that category's ordered chain of runner/model candidates; the first eligible candidate is used.",
      criteria: {
        frontier: { chain: [{ runner: "pi", model: "pi-1" }, { runner: "claude", model: "cl-1" }] },
        cheap: { chain: [{ runner: "agy", model: "agy-1" }, { runner: "pi", model: "pi-2", account: "alt" }] },
      },
    });

    // The B13 composition advisory noul over the planned team.
    expect(body.questions.missing_area).toEqual({
      type: "noul",
      instructions:
        "Is the planned team in `team` missing a distinct contribution — work the specs' assignments call for but no listed spec provides?",
      criteria: {
        true: "A distinct contribution is missing — e.g., independent verification of a member's own work, research before implementation, or coordination across members.",
        false: "The listed specs cover their assignments; another member would duplicate, not complement.",
      },
    });

    // One noul per (resource × candidate runner): pi 4 + claude 2, agy none;
    // pi's four answers cover its candidates in both chains.
    expect(Object.keys(body.questions)).toEqual(QUESTION_IDS);
    for (const id of RESOURCE_IDS) expect(body.questions[id].type).toBe("noul");
    expect(body.questions.resource_pi_skills_0.instructions).toBe(
      'Would an agent executing this spec on the pi runner plausibly need the skill "skills/worker" to complete the assignment within scope?'
    );
    expect(body.questions.resource_pi_mcp_0.instructions).toContain('the MCP server "herdr"');
    expect(body.questions.resource_claude_plugins_0.instructions).toContain('the plugin "plugins/worker"');
  });

  it("projects the caller's planned team into state.team and records its labels as the assessed team", async () => {
    const reviewer: LaunchSpec = {
      label: "reviewer",
      instructions: "Independently review the migrated code for contract drift; never edit.",
      assignment: { objective: "Review the migration", scope: "src/profiles/", verification: "a written verdict" },
      category: "cheap",
    };
    const calls: Array<{ init?: RequestInit }> = [];
    const outcome = await client(async (_input, init) => (calls.push({ init }), response())).evaluate(
      { spec: SPEC, catalog: CATALOG, team: [SPEC, reviewer] },
      signal()
    );
    expect(outcome).toEqual(responseFor("frontier", { missing_area: 0.9, assessed: ["worker", "reviewer"] }));
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.state.team).toEqual([
      body.state.spec,
      {
        label: "reviewer",
        instructions: "Independently review the migrated code for contract drift; never edit.",
        assignment: { objective: "Review the migration", scope: "src/profiles/", verification: "a written verdict" },
        category: "cheap",
      },
    ]);
  });

  it("asks the confirm/override wording and carries the proposed category in state when the spec names one", async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    await client(async (_input, init) => (calls.push({ init }), response())).evaluate(
      { spec: { ...SPEC, category: "cheap" }, catalog: CATALOG },
      signal()
    );
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.state.spec.category).toBe("cheap");
    expect(body.questions.category.instructions).toContain('The caller proposed the "cheap" category.');
    expect(body.questions.category.instructions).toContain("Confirm the proposed category, or override it only when another category is a clearly better fit.");
    expect(Object.keys(body.questions.category.criteria)).toEqual(["frontier", "cheap"]);
  });

  it("emits no SDK log output at any level", async () => {
    const spies = [vi.spyOn(console, "debug"), vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    await client(async () => response()).evaluate({ spec: SPEC, catalog: CATALOG }, signal());
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("uses the global fetch seam when none is injected", async () => {
    const fetchCall = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetchCall);
    const outcome = await new TypeSafeSpecClient({ apiKey: "key" }).evaluate({ spec: SPEC, catalog: CATALOG }, signal());
    expect(outcome.kind).toBe("response");
    expect(fetchCall).toHaveBeenCalledOnce();
  });
});

describe("TypeSafeSpecClient normalization", () => {
  it("normalizes valid answers into the resolved chain's runner-qualified candidates — an override needs no second call", async () => {
    const outcome = await client(async () => response(answerSet({}, "cheap"))).evaluate({ spec: SPEC, catalog: CATALOG }, signal());
    expect(outcome).toEqual(responseFor("cheap"));
  });

  it("feeds routeSpec directly: a normalized response admits through the real policy", async () => {
    const outcome = await client(async () => response()).evaluate({ spec: SPEC, catalog: CATALOG }, signal());
    if (outcome.kind !== "response") throw new Error("expected a response");
    const configuration: CompiledContract = {
      specLabel: SPEC.label,
      candidate: { index: 0, runner: "pi", model: "pi-1" },
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
    const decision = await routeSpec({
      spec: SPEC,
      catalog: CATALOG,
      response: outcome.response,
      availability: async () => ({ status: "unknown", retryNotBefore: null, evidence: { records: 0 } }),
      compile: async () => configuration,
    });
    expect(decision).toMatchObject({
      kind: "admitted",
      quality: "not_rejected",
      category: "frontier",
      advisory: { missing_area: 0.9, assessed: ["worker"], diverged: false },
    });
  });

  it("degrades a missing or malformed missing_area answer to no advisory — it never abstains", async () => {
    for (const answers of [
      answerSet({ missing_area: null }),
      answerSet({ missing_area: { type: "choice", choice: "none", confidence: 0.9, probabilities: { none: 1 } } }),
      answerSet({ missing_area: noulAnswer(1.5) }),
      (() => { const a = answerSet(); delete a.missing_area; return a; })(),
    ]) {
      const outcome = await client(async () => response(answers)).evaluate({ spec: SPEC, catalog: CATALOG }, signal());
      expect(outcome.kind).toBe("response");
      if (outcome.kind === "response") expect(outcome.response).not.toHaveProperty("composition");
    }
  });

  it("carries a low missing_area probability verbatim for the policy to threshold", async () => {
    const outcome = await client(async () => response(answerSet({ missing_area: noulAnswer(0.42) }))).evaluate({ spec: SPEC, catalog: CATALOG }, signal());
    expect(outcome).toEqual(responseFor("frontier", { missing_area: 0.42, assessed: ["worker"] }));
  });

  const invalidCases: Array<{ name: string; overrides: Record<string, unknown>; component: string }> = [
    { name: "missing instructions_adequate", overrides: { instructions_adequate: null }, component: "instructions_adequate" },
    { name: "wrong instructions_adequate type", overrides: { instructions_adequate: { type: "score", noul: 0.9 } }, component: "instructions_adequate" },
    { name: "non-numeric noul", overrides: { assignment_verifiable: { type: "noul", noul: "yes" } }, component: "assignment_verifiable" },
    { name: "out-of-range noul", overrides: { assignment_verifiable: noulAnswer(1.5) }, component: "assignment_verifiable" },
    { name: "negative noul", overrides: { instructions_adequate: noulAnswer(-0.1) }, component: "instructions_adequate" },
    { name: "missing category", overrides: { category: null }, component: "category" },
    { name: "wrong category type", overrides: { category: noulAnswer() }, component: "category" },
    { name: "foreign category choice", overrides: { category: choiceAnswer("frontier", 0.9, { choice: "intruder" }) }, component: "category" },
    { name: "out-of-range category confidence", overrides: { category: choiceAnswer("frontier", 1.5) }, component: "category" },
    { name: "category probabilities missing a key", overrides: { category: choiceAnswer("frontier", 0.9, { probabilities: { frontier: 1 } }) }, component: "category" },
    { name: "category probabilities with a foreign key", overrides: { category: choiceAnswer("frontier", 0.9, { probabilities: { frontier: 0.9, cheap: 0.05, intruder: 0.05 } }) }, component: "category" },
    { name: "category probabilities not summing to one", overrides: { category: choiceAnswer("frontier", 0.9, { probabilities: { frontier: 0.9, cheap: 0.9 } }) }, component: "category" },
    { name: "missing resource noul", overrides: { resource_pi_tools_0: null }, component: "resource_pi_tools_0" },
    { name: "wrong resource noul type", overrides: { resource_pi_tools_0: choiceAnswer() }, component: "resource_pi_tools_0" },
    { name: "out-of-range resource noul", overrides: { resource_claude_plugins_0: noulAnswer(2) }, component: "resource_claude_plugins_0" },
  ];

  for (const { name, overrides, component } of invalidCases) {
    it(`abstains invalid_response on ${name}`, async () => {
      const outcome = await client(async () => response(answerSet(overrides))).evaluate({ spec: SPEC, catalog: CATALOG }, signal());
      expect(outcome).toEqual({ kind: "abstained", reason: "invalid_response", component });
    });
  }

  it("abstains invalid_response on malformed or empty top-level bodies", async () => {
    for (const body of [null, {}, { answers: [] }, { answers: null }, "not json"]) {
      const outcome = await client(async () => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })).evaluate({ spec: SPEC, catalog: CATALOG }, signal());
      expect(outcome).toEqual({ kind: "abstained", reason: "invalid_response", component: "response" });
    }
    const empty = await client(async () => new Response("", { status: 200 })).evaluate({ spec: SPEC, catalog: CATALOG }, signal());
    expect(empty).toEqual({ kind: "abstained", reason: "invalid_response", component: "response" });
    const text = await client(async () => new Response("not json", { status: 200, headers: { "Content-Type": "application/json" } })).evaluate({ spec: SPEC, catalog: CATALOG }, signal());
    expect(text).toEqual({ kind: "abstained", reason: "invalid_response", component: "response" });
  });

  it("rejects nonfinite answer values delivered over the wire", async () => {
    // JSON cannot express Infinity: a "NONFINITE" string sentinel is spliced
    // into the wire text as 1e999, which JSON.parse reads as Infinity.
    const wire = (qid: string, answer: Record<string, unknown>) =>
      JSON.stringify({ model: "jev-latest", answers: answerSet({ [qid]: answer }), usage: {} }).replace('"NONFINITE"', "1e999");
    const cases: Array<{ name: string; text: string; component: string }> = [
      { name: "quality noul", text: wire("instructions_adequate", { type: "noul", noul: "NONFINITE" }), component: "instructions_adequate" },
      { name: "category confidence", text: wire("category", choiceAnswer("frontier", 0.9, { confidence: "NONFINITE" })), component: "category" },
      {
        name: "category probability entry",
        text: wire("category", choiceAnswer("frontier", 0.9, { probabilities: { frontier: "NONFINITE", cheap: 0.1 } })),
        component: "category",
      },
      { name: "resource noul", text: wire("resource_pi_tools_1", { type: "noul", noul: "NONFINITE" }), component: "resource_pi_tools_1" },
    ];
    for (const { name, text, component } of cases) {
      const outcome = await client(async () => new Response(text, { status: 200, headers: { "Content-Type": "application/json" } })).evaluate({ spec: SPEC, catalog: CATALOG }, signal());
      expect(outcome, name).toEqual({ kind: "abstained", reason: "invalid_response", component });
    }
  });

  it("ignores foreign answers that carry no question", async () => {
    const outcome = await client(async () => response({ ...answerSet(), unexpected: noulAnswer(0.1), another: "junk" })).evaluate({ spec: SPEC, catalog: CATALOG }, signal());
    expect(outcome).toEqual(responseFor());
  });
});

describe("TypeSafeSpecClient typed outcomes", () => {
  it("abstains authentication_unavailable without any resolvable key and never calls fetch", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    const fetchCall = vi.fn(async () => response());
    const missing = await new TypeSafeSpecClient({ fetch: fetchCall, credentials: { read: async () => undefined } }).evaluate({ spec: SPEC, catalog: CATALOG }, signal());
    expect(missing).toEqual({ kind: "abstained", reason: "authentication_unavailable", component: "api_key" });
    expect(fetchCall).not.toHaveBeenCalled();

    const empty = await new TypeSafeSpecClient({ apiKey: "", fetch: fetchCall }).evaluate({ spec: SPEC, catalog: CATALOG }, signal());
    expect(empty).toEqual({ kind: "abstained", reason: "authentication_unavailable", component: "api_key" });
    expect(fetchCall).not.toHaveBeenCalled();
  });

  it("resolves the key env-first, then the Pi auth store, preferring an explicit option over both", async () => {
    const store = { read: async () => ({ type: "api_key", key: "store-key" }) as never };
    vi.stubEnv("TYPESAFE_API_KEY", "");
    const calls: Array<{ init?: RequestInit }> = [];
    const fetchCall: FetchCall = async (_input, init) => (calls.push({ init }), response());
    await new TypeSafeSpecClient({ fetch: fetchCall, credentials: store }).evaluate({ spec: SPEC, catalog: CATALOG }, signal());
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer store-key");

    vi.stubEnv("TYPESAFE_API_KEY", "env-key");
    calls.length = 0;
    await new TypeSafeSpecClient({ fetch: fetchCall, credentials: store }).evaluate({ spec: SPEC, catalog: CATALOG }, signal());
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer env-key");

    calls.length = 0;
    await new TypeSafeSpecClient({ apiKey: "explicit", fetch: fetchCall, credentials: store }).evaluate({ spec: SPEC, catalog: CATALOG }, signal());
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer explicit");
  });

  it("abstains catalog_unavailable on a malformed or empty catalog without calling fetch", async () => {
    const fetchCall = vi.fn(async () => response());
    for (const catalog of [undefined, {}, { categories: new Map(), runners: new Map() }, { categories: [], runners: new Map() }] as unknown as Catalog[]) {
      const outcome = await client(fetchCall).evaluate({ spec: SPEC, catalog }, signal());
      expect(outcome).toEqual({ kind: "abstained", reason: "catalog_unavailable", component: "catalog" });
    }
    const missingRunner: Catalog = { ...CATALOG, runners: new Map([...CATALOG.runners].filter(([kind]) => kind !== "pi")) };
    const outcome = await client(fetchCall).evaluate({ spec: SPEC, catalog: missingRunner }, signal());
    expect(outcome).toEqual({ kind: "abstained", reason: "catalog_unavailable", component: "catalog" });
    expect(fetchCall).not.toHaveBeenCalled();
  });

  it("abstains invalid_response on a malformed spec without calling fetch", async () => {
    const fetchCall = vi.fn(async () => response());
    for (const spec of [undefined, {}, { label: "x" }, { ...SPEC, instructions: 7 }] as unknown as LaunchSpec[]) {
      const outcome = await client(fetchCall).evaluate({ spec, catalog: CATALOG }, signal());
      expect(outcome).toEqual({ kind: "abstained", reason: "invalid_response", component: "spec" });
    }
    expect(fetchCall).not.toHaveBeenCalled();
  });

  it("abstains invalid_response on a malformed planned team without calling fetch", async () => {
    const fetchCall = vi.fn(async () => response());
    for (const team of ["worker", [], [SPEC, { label: "x" }], [null]] as unknown as LaunchSpec[][]) {
      const outcome = await client(fetchCall).evaluate({ spec: SPEC, catalog: CATALOG, team }, signal());
      expect(outcome).toEqual({ kind: "abstained", reason: "invalid_response", component: "team" });
    }
    expect(fetchCall).not.toHaveBeenCalled();
  });

  for (const status of [401, 429, 503]) {
    it(`maps HTTP ${status} to transport_failed with only the bounded status`, async () => {
      const fetchCall = vi.fn(async () => new Response(JSON.stringify({ detail: `server-secret-${status}` }), { status }));
      const outcome = await client(fetchCall).evaluate({ spec: SPEC, catalog: CATALOG }, signal());
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
      }).evaluate({ spec: SPEC, catalog: CATALOG }, signal());
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
    const pending = client(hanging).evaluate({ spec: SPEC, catalog: CATALOG }, signal());
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(pending).resolves.toEqual({ kind: "abstained", reason: "transport_failed", component: "transport" });
  });

  it("aborts before, during, and after the request", async () => {
    const before = new AbortController();
    before.abort();
    const fetchCall = vi.fn(async () => response());
    const outcome = await client(fetchCall).evaluate({ spec: SPEC, catalog: CATALOG }, before.signal);
    expect(outcome).toEqual({ kind: "abstained", reason: "aborted" });
    expect(fetchCall).not.toHaveBeenCalled();

    const during = new AbortController();
    const hanging: FetchCall = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true });
      });
    const pending = client(hanging).evaluate({ spec: SPEC, catalog: CATALOG }, during.signal);
    during.abort();
    await expect(pending).resolves.toEqual({ kind: "abstained", reason: "aborted" });

    const after = new AbortController();
    const late = await client(async () => {
      after.abort();
      return response();
    }).evaluate({ spec: SPEC, catalog: CATALOG }, after.signal);
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
    const outcome = await client(async () => fake).evaluate({ spec: SPEC, catalog: CATALOG }, after.signal);
    expect(outcome).toEqual({ kind: "abstained", reason: "aborted" });
  });

  it("never exposes key material in any outcome", async () => {
    const outcomes: SpecEvaluation[] = [
      await client(async () => response()).evaluate({ spec: SPEC, catalog: CATALOG }, signal()),
      await client(async () => new Response("{}", { status: 500 })).evaluate({ spec: SPEC, catalog: CATALOG }, signal()),
      await client(async () => response(answerSet({ instructions_adequate: null }))).evaluate({ spec: SPEC, catalog: CATALOG }, signal()),
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
      }).evaluate({ spec: SPEC, catalog }, signal());
      expect(outcome.kind).toBe("response");
      expect(calls).toHaveLength(1);
      // displayResource fell back to the raw pool entry — the scope-qualified path is sent verbatim.
      expect(calls[0]).toContain(`${SCOPE}/skills/worker`);
    }
  });

  it("leaves an empty resource map for a picked candidate whose runner has no pools", async () => {
    const outcome = await client(async () => response(answerSet({}, "cheap"))).evaluate({ spec: SPEC, catalog: CATALOG }, signal());
    expect(outcome).toEqual(responseFor("cheap"));
  });
});



