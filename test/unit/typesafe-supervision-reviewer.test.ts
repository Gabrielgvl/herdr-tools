import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewerFailure } from "../../src/reviewer.js";
import {
  SUPERVISION_REASONS,
  SUPERVISION_REVIEWER_MODEL,
  TypeSafeSupervisionReviewer,
  type SupervisionReviewRequest,
} from "../../src/supervision/reviewer.js";

const request: SupervisionReviewRequest = {
  paneId: "p1",
  agentName: "worker",
  workingForMs: 300_000,
  metadata: { agentKind: "pi", status: "working", revision: 7 },
  transcriptDelta: ["one", "two"],
};

const REASON_DISTRIBUTION = Object.fromEntries(SUPERVISION_REASONS.map((name) => [name, name === "repetition" ? 0.7 : 0.025]));

function noul(probability: number): Record<string, unknown> {
  return { type: "noul", noul: probability };
}

interface AnswerOverrides {
  evidenceSufficiency?: unknown;
  progress?: unknown;
  stalled?: unknown;
  blocked?: unknown;
  risk?: unknown;
  appearsComplete?: unknown;
  reason?: unknown;
}

function answers(overrides: AnswerOverrides = {}): Record<string, unknown> {
  return {
    evidence_sufficient: overrides.evidenceSufficiency ?? noul(0.95),
    making_progress: overrides.progress ?? noul(0.11),
    stalled: overrides.stalled ?? noul(0.82),
    blocked: overrides.blocked ?? noul(0.04),
    risk: overrides.risk ?? noul(0.02),
    appears_complete: overrides.appearsComplete ?? noul(0.01),
    reason: overrides.reason ?? { type: "choice", choice: "repetition", confidence: 0.7, probabilities: REASON_DISTRIBUTION },
  };
}

function response(overrides: AnswerOverrides = {}): Response {
  return new Response(JSON.stringify({
    model: "jev-latest",
    answers: answers(overrides),
    usage: {},
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

type FetchCall = (input: string | URL, init?: RequestInit) => Promise<Response>;

function reviewerFor(fetchCall: FetchCall): TypeSafeSupervisionReviewer {
  return new TypeSafeSupervisionReviewer({ apiKey: "key", fetch: fetchCall });
}

function bodyOf(calls: Array<{ init?: RequestInit }>): Record<string, any> {
  return JSON.parse(calls[0]!.init!.body as string);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("TypeSafe supervision reviewer", () => {
  it("pins the shared Jev model and makes exactly one systemOne call", async () => {
    expect(SUPERVISION_REVIEWER_MODEL).toBe("typesafe/jev-latest");
    vi.stubEnv("TYPESAFE_API_KEY", "env-key");
    const fetchCall = vi.fn<FetchCall>(async () => response());
    vi.stubGlobal("fetch", fetchCall);
    await new TypeSafeSupervisionReviewer().review(request, new AbortController().signal);
    expect(fetchCall).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchCall.mock.calls[0]![1]!.body as string);
    expect(body.model).toBe("jev-latest");
  });

  it("sends the seven fixed questions with their exact wording and ids", async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    await reviewerFor(async (_input, init) => { calls.push({ init }); return response(); }).review(request, new AbortController().signal);
    const questions = bodyOf(calls).questions;
    expect(Object.keys(questions)).toEqual(["evidence_sufficient", "making_progress", "stalled", "blocked", "risk", "appears_complete", "reason"]);
    expect(questions.evidence_sufficient).toMatchObject({
      type: "noul",
      instructions: "Is there enough supplied evidence (transcript delta, metadata, assignment digest, and prior review state) to make a meaningful supervision judgment about this child agent?",
    });
    expect(questions.making_progress).toMatchObject({
      type: "noul",
      instructions: "Does the evidence show meaningful advancement toward the assignment's objective within its constraints?",
    });
    expect(questions.stalled).toMatchObject({
      type: "noul",
      instructions: "Does the evidence show repeated attempts, oscillation, idling, or lack of semantic advancement over the elapsed working time — rather than a single silent long-running operation?",
    });
    expect(questions.blocked).toMatchObject({
      type: "noul",
      instructions: "Does the evidence show the agent is waiting on something it cannot resolve itself, such as credentials, permissions, an external dependency, or human input?",
    });
    expect(questions.risk).toMatchObject({
      type: "noul",
      instructions: "Does the evidence show the agent moving toward an incorrect, unsafe, destructive, or out-of-constraint outcome relative to the assignment digest?",
    });
    expect(questions.appears_complete).toMatchObject({
      type: "noul",
      instructions: "Does the evidence indicate the assignment's done-when conditions are effectively met even though the agent process has not terminated?",
    });
    expect(questions.reason).toMatchObject({
      type: "choice",
      instructions: "Which single factor best explains the supplied evidence's overall picture? Choose none only when no specific factor stands out.",
    });
    expect(Object.keys(questions.reason.criteria).sort()).toEqual([...SUPERVISION_REASONS].sort());
    expect(Object.keys(questions.reason.criteria)).toHaveLength(13);
  });

  it("maps the pane to the target, folds supervision fields into copied metadata, and defaults the digest", async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    const metadata = { agentKind: "pi", status: "working", revision: 7 };
    const result = await reviewerFor(async (_input, init) => { calls.push({ init }); return response({ progress: noul(0.9) }); }).review({ ...request, metadata }, new AbortController().signal);
    expect(result).toMatchObject({ classification: "stalled" });
    expect(result).not.toHaveProperty("targetId");
    const state = bodyOf(calls).state;
    expect(state).toEqual({
      targetId: "p1",
      metadata: { agentKind: "pi", status: "working", revision: 7, agentName: "worker", workingForMs: 300_000 },
      transcriptDelta: ["one", "two"],
      assignmentDigest: { doneWhen: [], constraints: [] },
      linesSinceLastReview: undefined,
    });
    // The caller's metadata is folded into a copy, never mutated in place.
    expect(metadata).toEqual({ agentKind: "pi", status: "working", revision: 7 });
  });

  it("supplies the assignment digest, previous review, and line count as state", async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    const reviewer = reviewerFor(async (_input, init) => { calls.push({ init }); return response(); });
    await reviewer.review({
      ...request,
      assignmentDigest: { doneWhen: ["tests pass"], constraints: ["read-only"] },
      previousReview: {
        classification: "progress",
        signals: { progress: 0.9, stalled: 0.1, blocked: 0.05, risk: 0.01, appears_complete: 0.02 },
        lastMeaningfulProgressAtMs: 123_000,
      },
      linesSinceLastReview: 2,
    }, new AbortController().signal);
    const state = bodyOf(calls).state;
    expect(state.assignmentDigest).toEqual({ doneWhen: ["tests pass"], constraints: ["read-only"] });
    expect(state.previousReview).toEqual({
      classification: "progress",
      signals: { progress: 0.9, stalled: 0.1, blocked: 0.05, risk: 0.01, appears_complete: 0.02 },
      lastMeaningfulProgressAtMs: 123_000,
    });
    expect(state.linesSinceLastReview).toBe(2);
  });

  it("omits previousReview on the first review", async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    await reviewerFor(async (_input, init) => { calls.push({ init }); return response(); }).review(request, new AbortController().signal);
    expect(bodyOf(calls).state).not.toHaveProperty("previousReview");
  });

  it("gates on evidence sufficiency before reading any signal", async () => {
    const reviewer = reviewerFor(async () => response({ evidenceSufficiency: noul(0.59), risk: noul(0.99) }));
    await expect(reviewer.review(request, new AbortController().signal)).resolves.toMatchObject({ classification: "unknown" });
    const sufficient = reviewerFor(async () => response({ evidenceSufficiency: noul(0.60), risk: noul(0.99) }));
    await expect(sufficient.review(request, new AbortController().signal)).resolves.toMatchObject({ classification: "risk" });
  });

  it("classifies co-activating signals by precedence, never by exclusion", async () => {
    const risky = reviewerFor(async () => response({ progress: noul(0.88), risk: noul(0.72) }));
    await expect(risky.review(request, new AbortController().signal)).resolves.toMatchObject({ classification: "risk" });
    const blockedThenProgressed = reviewerFor(async () => response({ progress: noul(0.74), blocked: noul(0.81), stalled: noul(0) }));
    await expect(blockedThenProgressed.review(request, new AbortController().signal)).resolves.toMatchObject({ classification: "blocked" });
  });

  it("returns every signal probability, the reason code, and the evidence sufficiency", async () => {
    const reviewer = reviewerFor(async () => response({ progress: noul(0.88), risk: noul(0.72) }));
    const result = await reviewer.review(request, new AbortController().signal);
    expect(result.signals).toEqual({ progress: 0.88, stalled: 0.82, blocked: 0.04, risk: 0.72, appears_complete: 0.01 });
    expect(result.evidenceSufficiency).toBe(0.95);
    expect(result.reason).toBe("repetition");
    // All probabilities are logged in the summary, including non-activating ones.
    expect(result.summary).toContain("risk 0.72");
    expect(result.summary).toContain("appears_complete 0.01");
    expect(result.summary).toContain("reason repetition");
  });

  it("parses a none reason code like any other label", async () => {
    const noneReason = { type: "choice", choice: "none", confidence: 0.9, probabilities: Object.fromEntries(SUPERVISION_REASONS.map((name) => [name, name === "none" ? 0.9 : 0.008])) };
    const reviewer = reviewerFor(async () => response({ reason: noneReason }));
    await expect(reviewer.review(request, new AbortController().signal)).resolves.toMatchObject({ reason: "none", classification: "stalled" });
  });

  it("fails closed as a typed ReviewerFailure when no credential resolves, with no key material", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    const fetchCall = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetchCall);
    const failure = await new TypeSafeSupervisionReviewer().review(request, new AbortController().signal).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: "ReviewerFailure", code: "REVIEWER_FAILED" });
    expect(JSON.stringify(failure)).not.toContain("env-key");
    expect(fetchCall).not.toHaveBeenCalled();
  });

  it("propagates abort before, during, and after the fetch", async () => {
    const before = new AbortController();
    before.abort();
    await expect(reviewerFor(async () => response()).review(request, before.signal))
      .rejects.toMatchObject({ code: "REVIEWER_FAILED", details: { code: "ABORTED" } });

    const during = new AbortController();
    const pending = reviewerFor(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error("fetch aborted")), { once: true });
    })).review(request, during.signal);
    during.abort();
    await expect(pending).rejects.toMatchObject({ details: { code: "ABORTED" } });

    const after = new AbortController();
    await expect(reviewerFor(async () => { after.abort(); return response(); }).review(request, after.signal))
      .rejects.toMatchObject({ details: { code: "ABORTED" } });
  });

  it("carries only bounded evidence when the API answers an error status", async () => {
    const failure = await reviewerFor(async () => new Response("upstream exploded", { status: 503 }))
      .review(request, new AbortController().signal)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ReviewerFailure);
    expect(failure).toMatchObject({ code: "REVIEWER_FAILED", details: { targetId: "p1", model: "typesafe/jev-latest", status: 503 } });
    // The details carry only the bounded allowlist; the SDK clips the body it folds into the cause.
    expect(Object.keys((failure as ReviewerFailure).details).sort()).toEqual(["cause", "model", "status", "targetId"]);
  });

  it("fails closed with a ReviewerFailure on malformed answers", async () => {
    const run = (fetchCall: FetchCall) => reviewerFor(fetchCall).review(request, new AbortController().signal);

    await expect(run(async () => new Response("not json", { status: 200 }))).rejects.toBeInstanceOf(ReviewerFailure);
    const malformed: unknown[] = [
      null,
      {},
      { answers: {} },
      // A missing question fails closed.
      { answers: { evidence_sufficient: noul(0.9), making_progress: noul(0.1), stalled: noul(0.1), blocked: noul(0.1), risk: noul(0.1), appears_complete: noul(0.1) } },
      // Wrong answer types.
      { answers: answers({ evidenceSufficiency: { type: "choice", choice: "yes", confidence: 1, probabilities: {} } }) },
      // Negative, out-of-range, and non-numeric probabilities fail closed.
      { answers: answers({ stalled: noul(-0.1) }) },
      { answers: answers({ blocked: noul(1.01) }) },
      { answers: answers({ risk: { type: "noul", noul: "high" } }) },
      { answers: answers({ appearsComplete: { type: "noul" } }) },
      // A reason outside the fixed set, or with invalid probabilities, fails closed.
      { answers: answers({ reason: { type: "choice", choice: "other", confidence: 1, probabilities: REASON_DISTRIBUTION } }) },
      { answers: answers({ reason: { type: "choice", choice: "none", confidence: 2, probabilities: REASON_DISTRIBUTION } }) },
      { answers: answers({ reason: { type: "choice", choice: "none", confidence: 1, probabilities: [] } }) },
      { answers: answers({ reason: { type: "choice", choice: "none", confidence: 1, probabilities: { ...REASON_DISTRIBUTION, tool_failure: -1 } } }) },
      { answers: answers({ reason: { type: "noul", noul: 0.5 } }) },
    ];
    for (const body of malformed) {
      await expect(run(async () => new Response(JSON.stringify(body), { status: 200 }))).rejects.toBeInstanceOf(ReviewerFailure);
    }
  });
});
