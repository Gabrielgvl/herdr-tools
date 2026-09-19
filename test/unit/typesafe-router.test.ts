import { afterEach, describe, expect, it, vi } from "vitest";
import { ROUTER_CONFIDENCE_THRESHOLD, roleForProfile, type RouterCatalogEntry, type RouterState } from "../../src/router.js";
import { TypeSafeRouter } from "../../src/typesafe-router.js";
import { TYPESAFE_REVIEW_CONFIDENCE_THRESHOLD } from "../../src/typesafe-reviewer.js";

const CATALOG: RouterCatalogEntry[] = [
  { name: "manager-pi", description: "Manages work.", runner: "pi", model: "pi-model", timeout: 30 },
  { name: "planner-pi", description: "Plans work.", runner: "pi", model: "pi-model", timeout: 30 },
  { name: "promoter-pi", description: "Promotes work.", runner: "pi", model: "pi-model", timeout: 30 },
  { name: "researcher-pi", description: "Researches work.", runner: "pi", model: "pi-model", timeout: 30 },
  { name: "reviewer-claude", description: "Reviews work.", runner: "claude", model: "claude-model", timeout: 15 },
  { name: "scout-agy", description: "Scouts with agy.", runner: "agy", model: "agy-model", timeout: 10 },
  { name: "scout-pi", description: "Scouts with pi.", runner: "pi", model: "pi-model", timeout: 30 },
  { name: "worker-claude", description: "Works with claude.", runner: "claude", model: "claude-model", timeout: 45 },
  { name: "worker-pi", description: "Works with pi.", runner: "pi", model: "pi-model", timeout: 30 }
];

const ROLES = ["manager", "planner", "promoter", "researcher", "reviewer", "scout", "worker"] as const;

const SCORE_CRITERIA = [
  "One agent covers this role's useful contribution without a distinct contribution for an additional agent.",
  "Two agents have distinct useful contributions in this role; additional agents would duplicate that work.",
  "Three agents have distinct useful contributions in this role; additional agents would duplicate that work.",
  "Four agents have distinct useful contributions in this role; additional agents would duplicate that work.",
  "Five agents have distinct useful contributions in this role."
];

const SCORE_LEGEND = {
  "0": SCORE_CRITERIA[0]!,
  "1": SCORE_CRITERIA[1]!,
  "2": SCORE_CRITERIA[2]!,
  "3": SCORE_CRITERIA[3]!,
  "4": SCORE_CRITERIA[4]!
};

function candidatesOf(role: string): string[] {
  return CATALOG.filter((entry) => roleForProfile(entry.name) === role).map((entry) => entry.name);
}

function noulAnswer(probability = 0.9): Record<string, unknown> {
  return { type: "noul", noul: probability };
}

function scoreAnswer(value = 0, confidence = 0.9, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "score",
    score: value,
    confidence,
    legend: { ...SCORE_LEGEND },
    probabilities: { "0": 0.9, "1": 0.05, "2": 0.03, "3": 0.01, "4": 0.01 },
    ...overrides
  };
}

function choiceAnswer(role: string, pick?: string, confidence = 0.9, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const candidates = candidatesOf(role);
  const selected = pick ?? candidates[0]!;
  const probabilities = Object.fromEntries(
    candidates.map((name) => [name, name === selected ? (candidates.length === 1 ? 1 : 0.9) : 0.1 / (candidates.length - 1)])
  );
  return { type: "choice", choice: selected, confidence, probabilities, ...overrides };
}

function answerSet(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const role of ROLES) {
    answers[`${role}_useful`] = noulAnswer();
    answers[`${role}_count`] = scoreAnswer();
    answers[`${role}_profile`] = choiceAnswer(role);
  }
  return { ...answers, ...overrides };
}

function response(answers: Record<string, unknown> = answerSet()): Response {
  return new Response(JSON.stringify({ model: "jev-latest", answers, usage: { input_tokens: 1, output_tokens: 1 } }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

function state(catalog: RouterCatalogEntry[] = CATALOG): RouterState {
  return {
    assignment: { objective: "Reduce latency.", scope: "Only src/server.", verification: "npm test" },
    catalog
  };
}

type FetchCall = (input: string | URL, init?: RequestInit) => Promise<Response>;

function router(fetchCall: FetchCall, apiKey = "key"): TypeSafeRouter {
  return new TypeSafeRouter({ apiKey, fetch: fetchCall });
}

const signal = () => new AbortController().signal;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("TypeSafeRouter request", () => {
  it("sends one POST with the allowlisted state, all 21 literal role questions, jev-latest, and the process env key", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "env-key");
    const calls: Array<{ input: string | URL; init?: RequestInit }> = [];
    const outcome = await new TypeSafeRouter({
      fetch: async (input, init) => {
        calls.push({ input, init });
        return response();
      }
    }).route(state(), signal());
    expect(outcome.result.kind).toBe("route");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      input: "https://api.typesafe.ai/v1/systemone",
      init: { method: "POST", headers: { Authorization: "Bearer env-key", "Content-Type": "application/json" } }
    });
    expect(calls[0]!.init!.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(Object.keys(body).sort()).toEqual(["model", "questions", "state"]);
    expect(body.model).toBe("jev-latest");
    expect(Object.keys(body.state).sort()).toEqual(["assignment", "catalog"]);
    expect(body.state.assignment).toEqual({ objective: "Reduce latency.", scope: "Only src/server.", verification: "npm test" });
    expect(body.state.catalog).toEqual(CATALOG);
    for (const entry of body.state.catalog) {
      expect(Object.keys(entry).sort()).toEqual(["description", "model", "name", "runner", "timeout"]);
    }
    expect(Object.keys(body.questions)).toEqual(ROLES.flatMap((role) => [`${role}_useful`, `${role}_count`, `${role}_profile`]));
    for (const role of ROLES) {
      expect(body.questions[`${role}_useful`]).toEqual({
        type: "noul",
        instructions: `Would agents performing the ${role} role contribute useful, in-scope work toward assignment.objective, given assignment.scope, assignment.verification, and the profiles for this role in catalog?`,
        criteria: {
          true: `The ${role} role has useful work within the supplied scope that contributes to the objective and verification.`,
          false: `The ${role} role has no useful in-scope contribution to the supplied objective and verification.`
        }
      });
      expect(body.questions[`${role}_count`]).toEqual({
        type: "score",
        instructions: `Assuming the ${role} role is useful, how many agents performing this role are warranted by distinct useful contributions within assignment.scope? Each receives the same objective, scope, and verification.`,
        criteria: SCORE_CRITERIA
      });
      const roleEntries = CATALOG.filter((entry) => roleForProfile(entry.name) === role);
      expect(body.questions[`${role}_profile`]).toEqual({
        type: "choice",
        instructions: `Assuming the ${role} role is useful, which profile for this role best fits assignment.objective, assignment.scope, and assignment.verification, considering its description, runner, model, and timeout in catalog?`,
        criteria: Object.fromEntries(roleEntries.map(({ name, description, runner, model, timeout }) => [name, { description, runner, model, timeout }]))
      });
      expect(Object.keys(body.questions[`${role}_profile`].criteria)).toEqual(roleEntries.map((entry) => entry.name));
    }
  });

  it("strips non-allowlisted state fields before sending", async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    const dirty = {
      assignment: { objective: "o", scope: "s", verification: "v", extra: "junk" },
      catalog: [{ name: "worker-pi", description: "d", runner: "pi", model: "m", timeout: 30, body: "secret body", tools: ["exec"] }],
      leaked: "field"
    } as unknown as RouterState;
    await new TypeSafeRouter({ apiKey: "key", fetch: async (_input, init) => (calls.push({ init }), response()) }).route(dirty, signal());
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(Object.keys(body.state).sort()).toEqual(["assignment", "catalog"]);
    expect(body.state.assignment).toEqual({ objective: "o", scope: "s", verification: "v" });
    expect(body.state.catalog).toEqual([{ name: "worker-pi", description: "d", runner: "pi", model: "m", timeout: 30 }]);
    expect(JSON.stringify(body.state)).not.toContain("secret body");
    expect(JSON.stringify(body.state)).not.toContain("leaked");
  });

  it("prefers an explicit apiKey over the environment and uses the global fetch seam when none is injected", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "env-key");
    const envCalls: Array<{ init?: RequestInit }> = [];
    await new TypeSafeRouter({ apiKey: "explicit", fetch: async (_input, init) => (envCalls.push({ init }), response()) }).route(state(), signal());
    expect((envCalls[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer explicit");

    const fetchCall = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetchCall);
    const outcome = await new TypeSafeRouter({ apiKey: "key" }).route(state(), signal());
    expect(outcome.result.kind).toBe("route");
    expect(fetchCall).toHaveBeenCalledOnce();
  });

  it("emits no SDK log output at any level", async () => {
    const spies = [vi.spyOn(console, "debug"), vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    await router(async () => response()).route(state(), signal());
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("TypeSafeRouter routing", () => {
  it("routes valid answers through N1 policy and returns only the used probability evidence", async () => {
    const answers = answerSet({
      worker_useful: noulAnswer(0.9),
      worker_count: scoreAnswer(2, 0.9),
      worker_profile: choiceAnswer("worker", "worker-pi", 0.9),
      manager_useful: noulAnswer(0.1),
      planner_useful: noulAnswer(0.15),
      promoter_useful: noulAnswer(0.2),
      researcher_useful: noulAnswer(0.05),
      reviewer_useful: noulAnswer(0.1),
      scout_useful: noulAnswer(0.1)
    });
    const outcome = await router(async () => response(answers)).route(state(), signal());
    expect(outcome.result).toEqual({
      kind: "route",
      assignments: [{ profile: "worker-pi", count: 3, purpose: "Perform the worker role for the supplied objective." }]
    });
    expect(outcome.probabilities["worker_useful"]).toEqual({ type: "noul", noul: 0.9 });
    expect(outcome.probabilities["worker_count"]).toEqual({
      type: "score",
      score: 2,
      confidence: 0.9,
      probabilities: { "0": 0.9, "1": 0.05, "2": 0.03, "3": 0.01, "4": 0.01 }
    });
    expect(outcome.probabilities["worker_profile"]).toEqual({
      type: "choice",
      choice: "worker-pi",
      confidence: 0.9,
      probabilities: { "worker-claude": 0.1, "worker-pi": 0.9 }
    });
    expect(outcome.probabilities["scout_useful"]).toEqual({ type: "noul", noul: 0.1 });
    for (const role of ROLES) {
      if (role !== "worker") expect(outcome.probabilities).not.toHaveProperty(`${role}_profile`);
    }
  });

  it("maps fractional raw scores to counts via nearest-level half-up conversion", async () => {
    const route = async (rawScore: number) =>
      (await router(async () => response(answerSet({
        worker_useful: noulAnswer(0.9),
        worker_count: scoreAnswer(rawScore, 0.9),
        worker_profile: choiceAnswer("worker", "worker-pi", 0.9),
        manager_useful: noulAnswer(0.1),
        planner_useful: noulAnswer(0.1),
        promoter_useful: noulAnswer(0.1),
        researcher_useful: noulAnswer(0.1),
        reviewer_useful: noulAnswer(0.1),
        scout_useful: noulAnswer(0.1)
      }))).route(state(), signal())).result;
    await expect(route(0.4)).resolves.toEqual({
      kind: "route",
      assignments: [{ profile: "worker-pi", count: 1, purpose: "Perform the worker role for the supplied objective." }]
    });
    await expect(route(2.5)).resolves.toEqual({
      kind: "route",
      assignments: [{ profile: "worker-pi", count: 4, purpose: "Perform the worker role for the supplied objective." }]
    });
    await expect(route(4)).resolves.toEqual({
      kind: "route",
      assignments: [{ profile: "worker-pi", count: 5, purpose: "Perform the worker role for the supplied objective." }]
    });
  });

  it("abstains low_confidence on an uncertain noul while retaining validated evidence", async () => {
    const outcome = await router(async () => response(answerSet({ worker_useful: noulAnswer(0.5) }))).route(state(), signal());
    expect(outcome.result).toEqual({ kind: "abstain", reason: "low_confidence", component: "worker_useful" });
    expect(outcome.probabilities["worker_useful"]).toEqual({ type: "noul", noul: 0.5 });
  });

  it("abstains no_assignments when every role confidently answers no", async () => {
    const overrides = Object.fromEntries(ROLES.map((role) => [`${role}_useful`, noulAnswer(0.1)]));
    const outcome = await router(async () => response(answerSet(overrides))).route(state(), signal());
    expect(outcome.result).toEqual({ kind: "abstain", reason: "no_assignments" });
    expect(Object.keys(outcome.probabilities).filter((id) => id.endsWith("_profile"))).toHaveLength(0);
  });

  it("tolerates unusable choice content for a role answered no", async () => {
    const overrides: Record<string, unknown> = {
      scout_useful: noulAnswer(0.1),
      scout_profile: "not an answer at all",
      worker_profile: choiceAnswer("worker", "worker-pi", 0.9)
    };
    for (const role of ROLES) if (role !== "worker" && role !== "scout") overrides[`${role}_useful`] = noulAnswer(0.1);
    const outcome = await router(async () => response(answerSet(overrides))).route(state(), signal());
    expect(outcome.result).toEqual({
      kind: "route",
      assignments: [{ profile: "worker-pi", count: 1, purpose: "Perform the worker role for the supplied objective." }]
    });
    expect(outcome.probabilities).not.toHaveProperty("scout_profile");
  });

  it("rejects a missing or unusable choice for a role answered yes", async () => {
    for (const bad of [null, "junk", noulAnswer(), choiceAnswer("worker", "worker-pi", 0.9, { choice: "worker-foreign" })]) {
      const outcome = await router(async () => response(answerSet({ worker_profile: bad }))).route(state(), signal());
      expect(outcome.result).toEqual({ kind: "abstain", reason: "invalid_response", component: "worker_profile" });
    }
    const deleted = answerSet();
    delete deleted["worker_profile"];
    const outcome = await router(async () => response(deleted)).route(state(), signal());
    expect(outcome.result).toEqual({ kind: "abstain", reason: "invalid_response", component: "worker_profile" });
  });

  const invalidCases: Array<{ name: string; answers: Record<string, unknown>; component: string }> = [
    { name: "missing noul answer", answers: answerSet({ manager_useful: null }), component: "manager_useful" },
    { name: "wrong noul answer type", answers: answerSet({ manager_useful: { type: "score", noul: 0.9 } }), component: "manager_useful" },
    { name: "non-numeric noul", answers: answerSet({ manager_useful: { type: "noul", noul: "yes" } }), component: "manager_useful" },
    { name: "out-of-range noul", answers: answerSet({ manager_useful: noulAnswer(1.5) }), component: "manager_useful" },
    { name: "missing score answer", answers: answerSet({ manager_count: null }), component: "manager_count" },
    { name: "wrong score answer type", answers: answerSet({ manager_count: noulAnswer() }), component: "manager_count" },
    { name: "score above the rubric", answers: answerSet({ manager_count: scoreAnswer(4.5) }), component: "manager_count" },
    { name: "negative score", answers: answerSet({ manager_count: scoreAnswer(-1) }), component: "manager_count" },
    { name: "out-of-range score confidence", answers: answerSet({ manager_count: scoreAnswer(0, 1.5) }), component: "manager_count" },
    { name: "score legend with wrong keys", answers: answerSet({ manager_count: scoreAnswer(0, 0.9, { legend: { "0": "a", "1": "b", "2": "c", "3": "d", "5": "e" } }) }), component: "manager_count" },
    { name: "score legend echoing different criteria", answers: answerSet({ manager_count: scoreAnswer(0, 0.9, { legend: { "0": "x", "1": "x", "2": "x", "3": "x", "4": "x" } }) }), component: "manager_count" },
    { name: "score probabilities missing a key", answers: answerSet({ manager_count: scoreAnswer(0, 0.9, { probabilities: { "0": 0.9, "1": 0.05, "2": 0.03, "3": 0.02 } }) }), component: "manager_count" },
    { name: "score probabilities with an unexpected key", answers: answerSet({ manager_count: scoreAnswer(0, 0.9, { probabilities: { "0": 0.9, "1": 0.04, "2": 0.03, "3": 0.02, "4": 0.01, "5": 0 } }) }), component: "manager_count" },
    { name: "score probabilities not summing to one", answers: answerSet({ manager_count: scoreAnswer(0, 0.9, { probabilities: { "0": 0.5, "1": 0.5, "2": 0.5, "3": 0.5, "4": 0.5 } }) }), component: "manager_count" },
    { name: "out-of-range choice confidence", answers: answerSet({ worker_profile: choiceAnswer("worker", "worker-pi", 1.5) }), component: "worker_profile" },
    { name: "choice probabilities missing a profile", answers: answerSet({ worker_profile: { type: "choice", choice: "worker-pi", confidence: 0.9, probabilities: { "worker-pi": 1 } } }), component: "worker_profile" },
    { name: "choice probabilities with a foreign profile key", answers: answerSet({ worker_profile: { type: "choice", choice: "worker-pi", confidence: 0.9, probabilities: { "worker-pi": 0.9, "worker-claude": 0.05, intruder: 0.05 } } }), component: "worker_profile" },
    { name: "choice probabilities not summing to one", answers: answerSet({ worker_profile: { type: "choice", choice: "worker-pi", confidence: 0.9, probabilities: { "worker-pi": 0.9, "worker-claude": 0.9 } } }), component: "worker_profile" }
  ];

  for (const { name, answers, component } of invalidCases) {
    it(`abstains invalid_response on ${name}`, async () => {
      const outcome = await router(async () => response(answers)).route(state(), signal());
      expect(outcome.result).toEqual({ kind: "abstain", reason: "invalid_response", component });
      expect(outcome.result).not.toHaveProperty("assignments");
    });
  }

  it("abstains invalid_response on malformed or empty top-level bodies", async () => {
    for (const body of [null, {}, { answers: [] }, { answers: null }, "not json"]) {
      const outcome = await router(async () => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })).route(state(), signal());
      expect(outcome.result).toEqual({ kind: "abstain", reason: "invalid_response", component: "response" });
    }
    const empty = await router(async () => new Response("", { status: 200 })).route(state(), signal());
    expect(empty.result).toEqual({ kind: "abstain", reason: "invalid_response", component: "response" });
  });

  it("rejects nonfinite answer values delivered over the wire", async () => {
    // JSON cannot express Infinity: a "NONFINITE" string sentinel is spliced
    // into the wire text as 1e999, which JSON.parse reads as Infinity.
    const wire = (qid: string, answer: Record<string, unknown>) =>
      JSON.stringify({ model: "jev-latest", answers: answerSet({ [qid]: answer }), usage: {} }).replace('"NONFINITE"', "1e999");
    const cases: Array<{ name: string; text: string; component: string }> = [
      { name: "noul", text: wire("worker_useful", { type: "noul", noul: "NONFINITE" }), component: "worker_useful" },
      { name: "score", text: wire("worker_count", scoreAnswer(0, 0.9, { score: "NONFINITE" })), component: "worker_count" },
      { name: "score confidence", text: wire("worker_count", scoreAnswer(0, 0.9, { confidence: "NONFINITE" })), component: "worker_count" },
      {
        name: "score probability entry",
        text: wire("worker_count", scoreAnswer(0, 0.9, { probabilities: { "0": "NONFINITE", "1": 0.05, "2": 0.03, "3": 0.01, "4": 0.01 } })),
        component: "worker_count"
      },
      { name: "choice confidence", text: wire("worker_profile", choiceAnswer("worker", "worker-pi", 0.9, { confidence: "NONFINITE" })), component: "worker_profile" }
    ];
    for (const { name, text, component } of cases) {
      const outcome = await router(async () => new Response(text, { status: 200, headers: { "Content-Type": "application/json" } })).route(state(), signal());
      expect(outcome.result, name).toEqual({ kind: "abstain", reason: "invalid_response", component });
    }
  });
});

describe("TypeSafeRouter typed outcomes", () => {
  it("abstains authentication_unavailable without an API key and never calls fetch", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", undefined);
    const fetchCall = vi.fn(async () => response());
    const outcome = await new TypeSafeRouter({ fetch: fetchCall }).route(state(), signal());
    expect(outcome).toEqual({ result: { kind: "abstain", reason: "authentication_unavailable", component: "api_key" }, probabilities: {} });
    expect(fetchCall).not.toHaveBeenCalled();

    const empty = await new TypeSafeRouter({ apiKey: "", fetch: fetchCall }).route(state(), signal());
    expect(empty.result).toEqual({ kind: "abstain", reason: "authentication_unavailable", component: "api_key" });
    expect(fetchCall).not.toHaveBeenCalled();
  });

  it("abstains catalog_unavailable on an empty or malformed catalog without calling fetch", async () => {
    const fetchCall = vi.fn(async () => response());
    for (const catalog of [[], undefined, {}] as unknown as RouterCatalogEntry[][]) {
      const outcome = await new TypeSafeRouter({ apiKey: "key", fetch: fetchCall }).route({ ...state(), catalog }, signal());
      expect(outcome.result).toEqual({ kind: "abstain", reason: "catalog_unavailable", component: "catalog" });
    }
    expect(fetchCall).not.toHaveBeenCalled();
  });

  for (const status of [401, 429, 503]) {
    it(`maps HTTP ${status} to transport_failed with only the bounded status`, async () => {
      const fetchCall = vi.fn(async () => new Response(JSON.stringify({ detail: `server-secret-${status}` }), { status }));
      const outcome = await router(fetchCall).route(state(), signal());
      expect(outcome).toEqual({ result: { kind: "abstain", reason: "transport_failed", component: `http_${status}` }, probabilities: {} });
      expect(fetchCall).toHaveBeenCalledTimes(1);
      const exposed = JSON.stringify(outcome);
      expect(exposed).not.toContain(`server-secret-${status}`);
      expect(exposed).not.toContain("Bearer");
      expect(exposed).not.toContain("key");
    });
  }

  it("maps rejected fetch to transport_failed without exposing raw failure text", async () => {
    for (const thrown of [new Error("offline-secret"), "offline-secret"]) {
      const outcome = await router(async () => { throw thrown; }).route(state(), signal());
      expect(outcome).toEqual({ result: { kind: "abstain", reason: "transport_failed", component: "transport" }, probabilities: {} });
      expect(JSON.stringify(outcome)).not.toContain("offline-secret");
    }
  });

  it("maps a request timeout to transport_failed", async () => {
    vi.useFakeTimers();
    const hanging: FetchCall = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true });
      });
    const pending = router(hanging).route(state(), signal());
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(pending).resolves.toEqual({ result: { kind: "abstain", reason: "transport_failed", component: "transport" }, probabilities: {} });
  });

  it("aborts before, during, and after the request", async () => {
    const before = new AbortController();
    before.abort();
    const fetchCall = vi.fn(async () => response());
    const outcome = await router(fetchCall).route(state(), before.signal);
    expect(outcome.result).toEqual({ kind: "abstain", reason: "aborted" });
    expect(fetchCall).not.toHaveBeenCalled();

    const during = new AbortController();
    const hanging: FetchCall = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true });
      });
    const pending = router(hanging).route(state(), during.signal);
    during.abort();
    await expect(pending).resolves.toEqual({ result: { kind: "abstain", reason: "aborted" }, probabilities: {} });

    const after = new AbortController();
    const late = await router(async () => {
      after.abort();
      return response();
    }).route(state(), after.signal);
    expect(late.result).toEqual({ kind: "abstain", reason: "aborted" });
  });

  it("rechecks cancellation after a fully parsed response before returning a route", async () => {
    const after = new AbortController();
    // A duck-typed Response that aborts the caller inside text(): the body parses
    // successfully, then the router's pre-return abort check must still win.
    const fake = {
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
      clone: () => ({ body: undefined }),
      text: async () => {
        after.abort();
        return JSON.stringify({ model: "jev-latest", answers: answerSet(), usage: {} });
      }
    } as unknown as Response;
    const outcome = await router(async () => fake).route(state(), after.signal);
    expect(outcome.result).toEqual({ kind: "abstain", reason: "aborted" });
  });
});

describe("router contract", () => {
  it("keeps the router threshold at 0.8 and the wait reviewer threshold at 0.5", () => {
    expect(ROUTER_CONFIDENCE_THRESHOLD).toBe(0.8);
    expect(TYPESAFE_REVIEW_CONFIDENCE_THRESHOLD).toBe(0.5);
  });
});
