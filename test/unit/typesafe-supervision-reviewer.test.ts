import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewerFailure } from "../../src/reviewer.js";
import { executionDigestHash, type EvidenceDrift, type EvidenceState } from "../../src/supervision/evidence.js";
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
  previousReview: { classification: "progress" },
  evidence: evidenceFixture(),
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
    progress: overrides.progress ?? noul(0.11),
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

function bodyOf(calls: Array<{ init?: RequestInit }>) {
  return JSON.parse(calls[0]!.init!.body as string);
}

/** An assembled V2.1 evidence state, as `buildEvidenceState` would emit it. */
function evidenceFixture(over: { drift?: EvidenceDrift; workspaceUnavailable?: boolean; cursorFrom?: boolean; cursorNoPosition?: boolean } = {}): EvidenceState {
  return {
    version: 1,
    assignment: { objective: "finish R1", doneWhen: ["tests pass"], progressMarkers: ["reducer amended"], constraints: ["no commits"] },
    trace: {
      version: 1,
      source: "tmux-fallback",
      events: 3,
      bytes: 42,
      ...(over.cursorFrom === true ? { cursorFrom: { source: "tmux-fallback" as const, position: 1, hash: "e".repeat(64) } } : {}),
      cursorTo: over.cursorNoPosition === true
        ? { source: "pi-jsonl" as const, hash: "t".repeat(64) }
        : { source: "tmux-fallback" as const, position: 3, hash: "t".repeat(64) },
      actions: [],
      other: [],
      incidental: { "terminal-line": 3 },
    },
    workspace: over.workspaceUnavailable === true
      ? { version: 1, available: false, failure: { reason: "adapter_unavailable" } }
      : {
          version: 1,
          available: true,
          baseRevision: "a".repeat(40),
          headRevision: "b".repeat(40),
          dirty: false,
          changedFiles: [],
          omittedFiles: 0,
          stats: { filesChanged: 0, insertions: 0, deletions: 0, untrackedFiles: 0 },
          fingerprint: "f".repeat(64),
        },
    terminal: { lines: ["line"], droppedLines: 0 },
    scan: "safe",
    identity: {
      contractVersion: "2.1",
      model: "typesafe/jev-latest",
      questionSetHash: "q".repeat(64),
      reducerVersion: 2,
      thresholds: { evidence: 0.6, risk: 0.6, blocked: 0.65, appears_complete: 0.7, stalled: 0.7, stalled_first_observation: 0.85, progress: 0.6 },
      compilerConfigHash: "c".repeat(64),
      stateBuilderHash: "s".repeat(64),
      hash: "h".repeat(64),
    },
    drift: over.drift ?? { drifted: false, fields: [] },
  };
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

  it("sends the ADR-036 questions with their exact verbatim wording, ids, and criteria", async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    await reviewerFor(async (_input, init) => { calls.push({ init }); return response(); }).review(request, new AbortController().signal);
    const questions = bodyOf(calls).questions;
    expect(Object.keys(questions)).toEqual(["evidence_sufficient", "progress", "stalled", "blocked", "risk", "appears_complete", "reason"]);
    expect(questions.evidence_sufficient).toEqual({
      type: "noul",
      instructions: "Is the supplied evidence sufficient to make a meaningful judgment about the child's current execution state?",
      criteria: {
        true: "The trace, workspace state, terminal evidence, or previous observation provides concrete evidence about what the agent is doing or has changed.",
        false: "The evidence is absent, purely incidental, too ambiguous, or insufficient to distinguish meaningful execution states.",
      },
    });
    expect(questions.progress).toEqual({
      type: "noul",
      instructions: "Does the supplied evidence show meaningful advancement toward the assignment since the previous observation, or within this observation when no previous observation exists?",
      criteria: {
        true: "Relevant implementation changed; new useful evidence established; a previously failing check now passes; a new milestone reached; a meaningful hypothesis tested; failure advanced toward resolution.",
        false: "Mere activity: re-reading, repeated commands, cosmetic churn, progress bars, unchanged failures.",
      },
    });
    expect(questions.stalled).toEqual({
      type: "noul",
      instructions: "Does the evidence show repeated activity without meaningful advancement?",
      criteria: {
        true: "Repeated same approach; oscillation; same failure with no new evidence; no relevant artifact change across observations.",
        false: "Mere absence of output is NOT sufficient.",
      },
    });
    expect(questions.blocked).toEqual({
      type: "noul",
      instructions: "Does the evidence show the child is waiting on a dependency, permission, information, resource, or action it cannot resolve itself?",
      criteria: { false: "A normal code error is not a blocker." },
    });
    expect(questions.risk).toEqual({
      type: "noul",
      instructions: "Does the evidence show the child taking or preparing an incorrect, destructive, unauthorized, or assignment-violating action?",
      criteria: { true: "Includes `constraints` violations." },
    });
    expect(questions.appears_complete).toEqual({
      type: "noul",
      instructions: "Does the evidence establish the assignment's doneWhen conditions sufficiently to make the child appear finished despite no terminal lifecycle state?",
      criteria: { false: "`progressMarkers` never count as completion criteria." },
    });
    expect(questions.reason).toMatchObject({
      type: "choice",
      instructions: "Which single factor best explains the supplied evidence's overall picture? Choose none only when no specific factor stands out.",
    });
    expect(Object.keys(questions.reason.criteria).sort()).toEqual([...SUPERVISION_REASONS].sort());
    expect(Object.keys(questions.reason.criteria)).toHaveLength(13);
  });

  it("sends the assembled evidence state verbatim — and nothing else a caller attached", async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    const evidence = evidenceFixture();
    // A caller trying to smuggle raw fields alongside the evidence is dropped:
    // the envelope is rebuilt from closed slots, not forwarded.
    const smuggled = {
      ...request,
      evidence,
      linesSinceLastReview: 5,
      transcriptDelta: ["raw", "unscanned"],
      assignmentDigest: { doneWhen: ["x"], constraints: [] },
      extra: { secret: "value" },
    } as unknown as SupervisionReviewRequest;
    await reviewerFor(async (_input, init) => { calls.push({ init }); return response(); })
      .review(smuggled, new AbortController().signal);
    const state = bodyOf(calls).state;
    expect(state.evidence).toEqual(JSON.parse(JSON.stringify(evidence)));
    expect(state).not.toHaveProperty("transcriptDelta");
    expect(state).not.toHaveProperty("assignmentDigest");
    expect(state).not.toHaveProperty("extra");
    expect(state.previousReview).toEqual({ classification: "progress" });
    expect(state.linesSinceLastReview).toBe(5);
    expect(state.metadata).toEqual({ agentKind: "pi", status: "working", revision: 7, agentName: "worker", workingForMs: 300_000 });
  });

  it("resolves to reviewer_unavailable when no assembled evidence state is supplied", async () => {
    // The raw-fallback path is gone: a request without the scanned assembly has
    // nothing safe to send, so it resolves silently unavailable and no request
    // ever leaves.
    const fetchCall = vi.fn<FetchCall>(async () => response());
    const result = await reviewerFor(fetchCall).review({ ...request, evidence: undefined as unknown as EvidenceState }, new AbortController().signal);
    expect(result).toMatchObject({ classification: "unknown", reason: "none", outcome: "reviewer_unavailable", attention: "none" });
    expect(result).not.toHaveProperty("evidence");
    expect(fetchCall).not.toHaveBeenCalled();
  });

  it("returns evidence provenance, identity hash, and drift for an assembled state", async () => {
    const evidence = evidenceFixture({ cursorFrom: true });
    const result = await reviewerFor(async () => response()).review({ ...request, evidence }, new AbortController().signal);
    expect(result).toMatchObject({
      classification: "stalled",
      schemaVersion: 2,
      identityHash: "h".repeat(64),
      drift: { drifted: false, fields: [] },
      evidence: {
        traceFromCursor: `tmux-fallback@1:${"e".repeat(64)}`,
        traceToCursor: `tmux-fallback@3:${"t".repeat(64)}`,
        traceDigestHash: executionDigestHash(evidence.trace),
        workspaceFingerprint: "f".repeat(64),
      },
    });
  });

  it("withholds a drifted predecessor and reduces as a first observation, surfacing the drift", async () => {
    const evidence = evidenceFixture({ drift: { drifted: true, fields: ["questionSetHash", "thresholds"] } });
    const calls: Array<{ init?: RequestInit }> = [];
    const result = await reviewerFor(async (_input, init) => { calls.push({ init }); return response({ stalled: noul(0.82) }); })
      .review({ ...request, evidence }, new AbortController().signal);
    // The drifted predecessor is never sent: no incompatible trajectory is compared.
    expect(bodyOf(calls).state).not.toHaveProperty("previousReview");
    // First-observation semantics apply: 0.82 is below the raised 0.85 stalled bar.
    expect(result.classification).toBe("unknown");
    // The drift itself stays visible on the result and inside the summary.
    expect(result.drift).toEqual({ drifted: true, fields: ["questionSetHash", "thresholds"] });
    expect(result.summary).toContain("drift questionSetHash+thresholds");
  });

  it("maps the pane to the target and rebuilds the envelope from closed scalar fields", async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    // A caller-attached key beyond the closed metadata shape never reaches the wire.
    const metadata = { agentKind: "pi", status: "working", revision: 7, smuggled: { raw: "secret" } } as unknown as SupervisionReviewRequest["metadata"];
    const result = await reviewerFor(async (_input, init) => { calls.push({ init }); return response({ progress: noul(0.9) }); }).review({ ...request, metadata }, new AbortController().signal);
    expect(result).toMatchObject({ classification: "stalled" });
    expect(result).not.toHaveProperty("targetId");
    const state = bodyOf(calls).state;
    expect(state.targetId).toBe("p1");
    expect(state.metadata).toEqual({ agentKind: "pi", status: "working", revision: 7, agentName: "worker", workingForMs: 300_000 });
    expect(state.metadata).not.toHaveProperty("smuggled");
    // The caller's metadata object is read, never mutated in place.
    expect(metadata).toMatchObject({ agentKind: "pi", status: "working", revision: 7 });
  });

  it("supplies the previous review and the line count as closed state", async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    const reviewer = reviewerFor(async (_input, init) => { calls.push({ init }); return response(); });
    await reviewer.review({
      ...request,
      previousReview: {
        classification: "progress",
        signals: { progress: 0.9, stalled: 0.1, blocked: 0.05, risk: 0.01, appears_complete: 0.02 },
        lastMeaningfulProgressAtMs: 123_000,
      },
      linesSinceLastReview: 2,
    }, new AbortController().signal);
    const state = bodyOf(calls).state;
    // The assignment digest now rides the assembled evidence, not a raw field.
    expect(state.evidence.assignment).toEqual({ objective: "finish R1", doneWhen: ["tests pass"], progressMarkers: ["reducer amended"], constraints: ["no commits"] });
    expect(state).not.toHaveProperty("assignmentDigest");
    expect(state.previousReview).toEqual({
      classification: "progress",
      signals: { progress: 0.9, stalled: 0.1, blocked: 0.05, risk: 0.01, appears_complete: 0.02 },
      lastMeaningfulProgressAtMs: 123_000,
    });
    expect(state.linesSinceLastReview).toBe(2);
  });

  it("omits previousReview on the first review", async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    await reviewerFor(async (_input, init) => { calls.push({ init }); return response(); }).review({ ...request, previousReview: undefined }, new AbortController().signal);
    expect(bodyOf(calls).state).not.toHaveProperty("previousReview");
  });

  it("raises the stalled bar on a first observation and keeps the standard bar once a review exists", async () => {
    const firstRequest: SupervisionReviewRequest = { ...request, previousReview: undefined };
    const below = reviewerFor(async () => response({ stalled: noul(0.82) }));
    await expect(below.review(firstRequest, new AbortController().signal)).resolves.toMatchObject({ classification: "unknown" });
    const atBar = reviewerFor(async () => response({ stalled: noul(0.85) }));
    await expect(atBar.review(firstRequest, new AbortController().signal)).resolves.toMatchObject({ classification: "stalled" });
    // The shared fixture carries a previous review: the same 0.82 clears the standard bar.
    const grounded = reviewerFor(async () => response({ stalled: noul(0.82) }));
    await expect(grounded.review(request, new AbortController().signal)).resolves.toMatchObject({ classification: "stalled" });
  });

  it("lets risk and blocked interrupt the evidence gate, which still governs the rest", async () => {
    // ADR-036 amendment: low evidence no longer mutes a wake-a-human interrupt.
    const risky = reviewerFor(async () => response({ evidenceSufficiency: noul(0.59), risk: noul(0.99) }));
    await expect(risky.review(request, new AbortController().signal)).resolves.toMatchObject({ classification: "risk" });
    const stuck = reviewerFor(async () => response({ evidenceSufficiency: noul(0.59), blocked: noul(0.99) }));
    await expect(stuck.review(request, new AbortController().signal)).resolves.toMatchObject({ classification: "blocked" });
    // The gate still governs non-interrupt signals.
    const quiet = reviewerFor(async () => response({ evidenceSufficiency: noul(0.59), stalled: noul(0.99) }));
    await expect(quiet.review(request, new AbortController().signal)).resolves.toMatchObject({ classification: "unknown" });
    const sufficient = reviewerFor(async () => response({ evidenceSufficiency: noul(0.60), stalled: noul(0.99) }));
    await expect(sufficient.review(request, new AbortController().signal)).resolves.toMatchObject({ classification: "stalled" });
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

  it("carries the code-owned attention decision and outcome on the result", async () => {
    // A wake classification wakes; no cadence was supplied so a fallback unknown would also wake.
    const stalled = await reviewerFor(async () => response()).review(request, new AbortController().signal);
    expect(stalled).toMatchObject({ classification: "stalled", attention: "wake_manager", outcome: "classified" });
    // A first-observation unknown inside baseline grace is the silent baseline acquisition.
    const baseline = await reviewerFor(async () => response({ evidenceSufficiency: noul(0.2), stalled: noul(0), progress: noul(0) }))
      .review({ ...request, previousReview: undefined, workingForMs: 300_000, cadenceMs: 300_000 }, new AbortController().signal);
    expect(baseline).toMatchObject({ classification: "unknown", attention: "none", outcome: "baseline" });
    // The same unknown past grace wakes as insufficient_evidence.
    const expired = await reviewerFor(async () => response({ evidenceSufficiency: noul(0.2), stalled: noul(0), progress: noul(0) }))
      .review({ ...request, previousReview: undefined, workingForMs: 900_000, cadenceMs: 300_000 }, new AbortController().signal);
    expect(expired).toMatchObject({ classification: "unknown", attention: "wake_manager", outcome: "insufficient_evidence" });
    // Sufficient evidence whose signals cross nothing is a signal_conflict.
    const conflict = await reviewerFor(async () => response({ stalled: noul(0), progress: noul(0) }))
      .review({ ...request, previousReview: undefined, workingForMs: 900_000, cadenceMs: 300_000 }, new AbortController().signal);
    expect(conflict).toMatchObject({ classification: "unknown", attention: "wake_manager", outcome: "signal_conflict" });
    // Progress is always silent.
    const progress = await reviewerFor(async () => response({ progress: noul(0.9), stalled: noul(0) }))
      .review(request, new AbortController().signal);
    expect(progress).toMatchObject({ classification: "progress", attention: "none", outcome: "classified" });
  });

  it("composes the summary deterministically from code-owned values only", async () => {
    const evidence = evidenceFixture();
    const run = () => reviewerFor(async () => response()).review({ ...request, evidence }, new AbortController().signal);
    const first = await run();
    const second = await run();
    // Identical inputs produce byte-identical summaries.
    expect(second.summary).toBe(first.summary);
    // The summary is exactly the code-composed string — no model prose exists in it.
    expect(first.summary).toBe(
      `stalled (evidence 0.95); stalled 0.82, progress 0.11, blocked 0.04, risk 0.02, appears_complete 0.01; reason repetition; trace tmux-fallback@3:${"t".repeat(64)}; workspace ${"f".repeat(64)}`,
    );
    // Relevant anchors changing changes the summary; unrelated response text cannot.
    const drifted = await reviewerFor(async () => response())
      .review({ ...request, evidence: evidenceFixture({ drift: { drifted: true, fields: ["model"] } }) }, new AbortController().signal);
    expect(drifted.summary).not.toBe(first.summary);
    expect(drifted.summary).toContain("drift model");
    const unavailable = await reviewerFor(async () => response())
      .review({ ...request, evidence: evidenceFixture({ workspaceUnavailable: true }) }, new AbortController().signal);
    expect(unavailable.summary).toContain("workspace unavailable:adapter_unavailable");
    expect(unavailable.evidence?.workspaceFingerprint).toBeNull();
    // A cursor with no source position hint labels as `source:hash`.
    const noPosition = await reviewerFor(async () => response())
      .review({ ...request, evidence: evidenceFixture({ cursorNoPosition: true }) }, new AbortController().signal);
    expect(noPosition.summary).toContain(`trace pi-jsonl:${"t".repeat(64)}`);
    expect(noPosition.evidence?.traceToCursor).toBe(`pi-jsonl:${"t".repeat(64)}`);
    const otherReason = await reviewerFor(async () => response({ reason: { type: "choice", choice: "no_output", confidence: 0.8, probabilities: Object.fromEntries(SUPERVISION_REASONS.map((name) => [name, name === "no_output" ? 0.8 : 0.017])) } }))
      .review({ ...request, evidence }, new AbortController().signal);
    expect(otherReason.summary).toContain("reason no_output");
    expect(otherReason.summary).not.toBe(first.summary);
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

  it("fails closed on a transport error with no status to report", async () => {
    const failure = await reviewerFor(async () => { throw new TypeError("socket hangup"); })
      .review(request, new AbortController().signal)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ReviewerFailure);
    expect(failure).toMatchObject({ code: "REVIEWER_FAILED", details: { targetId: "p1", model: "typesafe/jev-latest" } });
    expect((failure as ReviewerFailure).details).not.toHaveProperty("status");
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
      { answers: { evidence_sufficient: noul(0.9), progress: noul(0.1), stalled: noul(0.1), blocked: noul(0.1), risk: noul(0.1), appears_complete: noul(0.1) } },
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
