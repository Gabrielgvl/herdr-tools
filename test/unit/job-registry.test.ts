import { describe, expect, it, vi } from "vitest";
import { boundedList, fitsPublic, JobRegistry, jobDetailContent, publicDetail, type JobDetail, type JobListResult, type JobRequestSnapshot, type JobRunResult } from "../../src/job-registry.js";

const request: JobRequestSnapshot = {
  label: "wait for one",
  targets: ["one"],
  targetIds: ["p1"],
  match: "any",
  condition: { kind: "state", state: "done" },
  timeoutMs: 1_000,
  settings: { reviewCadenceMinutes: 1, reviewerModel: "luna", reviewerThinking: "low" }
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const success: JobRunResult = { outcome: "success", matched: true, reason: "condition_met", targets: [{ target: "one", targetId: "p1", metadata: { agent_status: "done" }, recentUnwrappedLines: ["done"], observedAtMs: 1, matched: true }] };

describe("JobRegistry", () => {
  it("starts jobs without a cap and retains only the latest bounded progress", async () => {
    let ids = 0;
    const registry = new JobRegistry({ idFactory: () => `job_${++ids}`, clock: { now: () => 10 } });
    const first = deferred<JobRunResult>();
    const second = deferred<JobRunResult>();
    const one = registry.register(request, async (_signal, update) => { update("a".repeat(10_000), { sequence: 1 }); return first.promise; });
    const two = registry.register({ ...request, targets: ["two"], targetIds: ["p2"] }, async (_signal, update) => { update("latest"); return second.promise; });
    expect(registry.size()).toBe(2);
    expect(registry.get(one.jobId)?.progress?.text.length).toBeLessThan(10_000);
    expect(registry.get(two.jobId)?.progress?.text).toBe("latest");
    first.resolve(success);
    second.resolve({ outcome: "timeout", matched: false, reason: "timeout" });
    await Promise.all([one.promise, two.promise]);
    expect(registry.get(one.jobId)).toMatchObject({ status: "completed", outcome: "success" });
    expect(registry.get(two.jobId)).toMatchObject({ status: "completed", outcome: "timeout" });
  });

  it("orders newest first, filters before pagination, and returns immutable views", async () => {
    let id = 0;
    let now = 0;
    const registry = new JobRegistry({ idFactory: () => `job_${++id}`, clock: { now: () => ++now } });
    const handles = [0, 1, 2].map(() => registry.register(request, async () => success));
    registry.update(handles[0]!.jobId, "still running");
    await Promise.all(handles.map((handle) => handle.promise));
    const page = registry.list("completed", 1, 1);
    expect(page.total).toBe(3);
    expect(page.nextOffset).toBe(2);
    expect(page.jobs[0]?.jobId).toBe("job_2");
    page.jobs[0]!.targets.push("mutated");
    const detail = registry.get("job_2")!;
    detail.request.targets.push("mutated");
    expect(registry.get("job_2")!.request.targets).toEqual(["one"]);
    expect(registry.list(undefined, 100, 20).jobs).toEqual([]);
  });

  it("uses first-wins cancellation and ignores late settlement", async () => {
    const pending = deferred<JobRunResult>();
    const terminal = vi.fn();
    const registry = new JobRegistry({ idFactory: () => "job_cancel", onTerminal: terminal, clock: { now: () => 1 } });
    const handle = registry.register(request, async (signal) => {
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) reject(new Error("aborted"));
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { code: "ABORTED" })), { once: true });
      });
      return pending.promise;
    });
    const cancelled = registry.cancel(handle.jobId)!;
    expect(cancelled).toMatchObject({ status: "cancelled", cancelReason: "cancelled" });
    expect(registry.cancel(handle.jobId)).toMatchObject({ status: "cancelled" });
    pending.resolve(success);
    await handle.promise;
    expect(registry.get(handle.jobId)).toMatchObject({ status: "cancelled" });
    expect(registry.list().jobs[0]).toMatchObject({ status: "cancelled", reason: "cancelled" });
    expect(terminal).not.toHaveBeenCalled();
    expect(registry.cancel("job_missing")).toBeUndefined();
  });

  it("maps failures and protects generation and shutdown", async () => {
    let failureId = 0;
    const registry = new JobRegistry({ idFactory: () => `job_failure_${++failureId}`, clock: { now: () => 1 } });
    const failure = registry.register(request, async () => { throw Object.assign(new Error("broken"), { code: "BROKEN", details: { safe: true } }); });
    await failure.promise;
    expect(registry.get(failure.jobId)).toMatchObject({ status: "failed", error: { code: "BROKEN", message: "broken" } });
    const stringFailure = registry.register({ ...request, targetIds: ["p2"] }, async () => { throw "string failure"; });
    await stringFailure.promise;
    expect(registry.get(stringFailure.jobId)).toMatchObject({ status: "failed", error: { message: "string failure" } });
    const oversizedFailure = registry.register(request, async () => { throw Object.assign(new Error("large failure"), { details: { evidence: "x".repeat(100_000) } }); });
    await oversizedFailure.promise;
    expect(registry.get(oversizedFailure.jobId)).toMatchObject({ truncation: { errorDetails: true }, error: { details: { truncated: true } } });
    expect(registry.list("failed").jobs).toEqual(expect.arrayContaining([expect.objectContaining({ error: { code: "BROKEN", message: "broken" } }), expect.objectContaining({ error: { message: "string failure" } })]));
    const generation = registry.captureGeneration();
    registry.shutdown();
    expect(registry.isCurrent(generation)).toBe(false);
    expect(registry.get(failure.jobId)).toBeUndefined();
    expect(() => registry.register(request, async () => success, generation)).toThrow(/SESSION_REPLACED/);
    const next = registry.beginSession();
    expect(registry.isCurrent(next)).toBe(true);
    const active = deferred<JobRunResult>();
    const handle = registry.register(request, async () => active.promise, next);
    registry.beginSession();
    active.resolve(success);
    await handle.promise;
    expect(registry.size()).toBe(0);
  });

  it("rejects invalid and duplicate generated IDs and handles missing updates", () => {
    const invalid = new JobRegistry({ idFactory: () => "bad" });
    expect(() => invalid.register(request, async () => success)).toThrow(/JOB_ID_INVALID/);
    let id = 0;
    const duplicate = new JobRegistry({ idFactory: () => "job_same" });
    duplicate.register(request, async () => success);
    expect(() => duplicate.register(request, async () => success)).toThrow(/JOB_ID_INVALID/);
    const valid = new JobRegistry({ idFactory: () => `job_${++id}` });
    expect(() => valid.update("job_missing", "progress")).toThrow(/JOB_NOT_FOUND/);
    const cancelled = valid.register(request, async () => success);
    valid.cancel(cancelled.jobId);
    expect(valid.update(cancelled.jobId, "late")).toMatchObject({ status: "cancelled" });
  });

  it("handles already-terminal records when beginning a session", async () => {
    const registry = new JobRegistry({ idFactory: (() => { let id = 0; return () => `job_terminal_${++id}`; })() });
    const done = registry.register(request, async () => success);
    await done.promise;
    const next = registry.beginSession();
    expect(next.generation).toBe(1);
    expect(registry.size()).toBe(0);
  });

  it("bounds uncloneable and oversized progress details", () => {
    const registry = new JobRegistry({ idFactory: () => "job_details" });
    const handle = registry.register(request, async (_signal, update) => { update("progress", () => undefined); return new Promise(() => undefined); });
    expect(registry.get(handle.jobId)?.progress?.details).toMatchObject({ truncated: true, content: "[details unavailable]" });
    const oversized = { text: "x".repeat(100_000) };
    registry.update(handle.jobId, "progress", oversized);
    expect(JSON.stringify(registry.get(handle.jobId)?.progress).length).toBeLessThan(50_000);
    registry.update(handle.jobId, "progress", { truncated: true, content: "x".repeat(100_000) });
    expect(registry.get(handle.jobId)?.progress?.details).toMatchObject({ truncated: true, content: expect.any(String) });
    registry.update(handle.jobId, "bigint", 1n);
    expect(registry.get(handle.jobId)?.progress?.details).toMatchObject({ truncated: true, content: "[details unavailable]" });
    registry.cancel(handle.jobId);

    const truncatedRegistry = new JobRegistry({ idFactory: () => "job_truncated_detail" });
    const large = truncatedRegistry.register({ ...request, condition: { transcript: "x".repeat(100_000) } }, async () => new Promise<never>(() => undefined));
    expect(jobDetailContent(truncatedRegistry.get(large.jobId)!)).toContain('"requestCondition": true');
    truncatedRegistry.cancel(large.jobId);
  });

  it("preserves valid maximum-length multibyte labels across job views", () => {
    const label = "😀".repeat(120);
    const registry = new JobRegistry({ idFactory: () => "job_unicode_label" });
    const handle = registry.register({ ...request, label }, async () => new Promise<never>(() => undefined));
    expect(registry.get(handle.jobId)?.request.label).toBe(label);
    expect(registry.list().jobs[0]?.label).toBe(label);
    expect(registry.runningOverview().jobs[0]?.label).toBe(label);
    registry.cancel(handle.jobId);
  });

  it("copies optional result fields and keeps small public details untruncated", async () => {
    const registry = new JobRegistry({ idFactory: () => "job_optional" });
    const handle = registry.register(request, async () => ({
      outcome: "success",
      matched: true,
      targets: [{ target: "one", targetId: "p1", metadata: { agent_status: "done" }, recentUnwrappedLines: ["done"], outputTruncated: true, observedAtMs: 1, matched: true }]
    }));
    await handle.promise;
    const detail = registry.get(handle.jobId)!;
    expect(detail.result).toMatchObject({ outcome: "success", targets: [{ outputTruncated: true }] });
    expect(detail.result?.reason).toBeUndefined();
    expect(jobDetailContent(detail)).not.toContain("[output truncated]");
  });

  it("prioritizes a match beyond the public evidence window and keeps exact counts", async () => {
    const registry = new JobRegistry({ idFactory: () => "job_match_window" });
    const targets = Array.from({ length: 7 }, (_, index) => ({
      target: `target-${index + 1}`,
      targetId: `p${index + 1}`,
      metadata: { agent_status: index === 6 ? "done" : "working" },
      recentUnwrappedLines: [],
      observedAtMs: index,
      matched: index === 6
    }));
    const handle = registry.register({ ...request, targets: targets.map((target) => target.target), targetIds: targets.map((target) => target.targetId) }, async () => ({ outcome: "success", matched: true, reason: "condition_met", matchedTargetCount: 1, matchedTargets: [{ target: "target-7", targetId: "p7" }], targets }));
    await handle.promise;
    const detail = registry.get(handle.jobId)!;
    expect(detail.result).toMatchObject({ matchedTargetCount: 1, matchedTargets: [{ target: "target-7", targetId: "p7" }] });
    expect(detail.result?.targets?.some((target) => target.targetId === "p7" && target.matched)).toBe(true);
    expect(detail.truncation).toMatchObject({ resultTargets: 1 });
  });

  it("preserves a sole match after the original 101-target result", async () => {
    const registry = new JobRegistry({ idFactory: () => "job_match_101" });
    const targets = Array.from({ length: 101 }, (_, index) => ({
      target: `target-${index + 1}`,
      targetId: `p${index + 1}`,
      metadata: {},
      recentUnwrappedLines: [],
      observedAtMs: index,
      matched: index === 100
    }));
    const handle = registry.register({ ...request, targets: targets.map((target) => target.target), targetIds: targets.map((target) => target.targetId) }, async () => ({ outcome: "success", matched: true, targets }));
    await handle.promise;
    const detail = registry.get(handle.jobId)!;
    expect(detail.result).toMatchObject({ matchedTargetCount: 1, matchedTargets: [{ targetId: "p101" }] });
    expect(detail.result?.targets?.some((target) => target.targetId === "p101" && target.matched)).toBe(true);
    expect(detail.truncation).toMatchObject({ resultTargets: 95 });
    expect(jobDetailContent(detail)).toContain('"targetId": "p101"');
  });

  it("bounds escaped structured details and records clipped evidence fields", async () => {
    const registry = new JobRegistry({ idFactory: () => "job_escaped_details" });
    const long = "\u0000\u0001\u000b\u001f".repeat(100_000);
    const handle = registry.register({
      ...request,
      label: "label-" + "a".repeat(2_000),
      targets: ["request-" + "t".repeat(2_000)],
      targetIds: ["request-id-" + "i".repeat(2_000)],
      settings: { ...request.settings, reviewerModel: "model-" + "m".repeat(2_000) }
    }, async () => ({
      outcome: "success",
      matched: true,
      targets: [{ target: "result-" + "r".repeat(2_000), targetId: "result-id-" + "d".repeat(2_000), metadata: { evidence: long }, recentUnwrappedLines: ["line-" + "l".repeat(2_000)], observedAtMs: 1, matched: true }],
      reviewerSummaries: [{ target: "review-" + "v".repeat(2_000), targetId: "review-id-" + "q".repeat(2_000), classification: "classification-" + "c".repeat(2_000), summary: "summary-" + "s".repeat(2_000) }]
    }));
    await handle.promise;
    const detail = registry.get(handle.jobId)!;
    const serialized = jobDetailContent(detail);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(50_000);
    expect(serialized.split("\n").length).toBeLessThanOrEqual(2_000);
    expect(() => JSON.parse(serialized)).not.toThrow();
    expect(detail).toMatchObject({
      truncation: {
        requestTargetsClipped: 1,
        requestTargetIdsClipped: 1,
        requestLabelClipped: true,
        requestReviewerModelClipped: true,
        resultTargetValuesClipped: 1,
        resultTargetIdsClipped: 1,
        resultTargetLinesClipped: 1,
        reviewerFieldsClipped: 1,
        resultTargetMetadata: 1
      },
      result: { targets: [{ metadata: { truncated: true } }] }
    });
    expect(registry.list().jobs[0]).toMatchObject({ truncation: { labelClipped: true } });
  });

  it("degrades oversized public detail and list projections without invalid JSON", () => {
    const detail = publicDetail({
      jobId: "job_" + "j".repeat(2_000),
      status: "cancelled",
      sequence: 1,
      createdAtMs: 1,
      request,
      progress: { text: "progress", atMs: 1, details: { evidence: "e".repeat(100_000) } },
      result: {
        outcome: "timeout",
        matched: false,
        targets: [{ target: "target", targetId: "p1", metadata: { evidence: "m".repeat(100_000) }, recentUnwrappedLines: ["line"], observedAtMs: 1, matched: false }],
        reviewerSummaries: [{ target: "target", targetId: "p1", classification: "blocked", summary: "review" }]
      },
      cancelReason: "cancelled",
      truncation: { padding: "x".repeat(100_000) } as unknown as JobDetail["truncation"]
    });
    expect(detail.status).toBe("cancelled");
    expect(detail.truncation).toMatchObject({ jobIdClipped: true, resultTargetMetadata: 1 });
    expect(Buffer.byteLength(jobDetailContent(detail), "utf8")).toBeLessThan(50_000);
    expect(() => JSON.parse(jobDetailContent(detail))).not.toThrow();
    const forced = publicDetail({ ...detail, progress: { text: "p".repeat(10_000), atMs: 1, details: { evidence: "e" } } }, 1);
    expect(forced.truncation).toMatchObject({ publicEvidenceOmitted: true, progressTextClipped: true });
    const manyMatches = publicDetail({
      jobId: "job_many_matches",
      status: "completed",
      sequence: 1,
      createdAtMs: 1,
      request,
      result: { outcome: "success", matched: true, targets: Array.from({ length: 7 }, (_, index) => ({ target: `target-${index}`, targetId: `p${index}`, metadata: {}, recentUnwrappedLines: [], observedAtMs: index, matched: true })) }
    });
    expect(manyMatches.truncation).toMatchObject({ resultMatchedTargets: 1 });

    const invalidProjection = publicDetail({ jobId: "job_invalid", status: "running", sequence: 1, createdAtMs: 1, request, truncation: { bad: 1n } as unknown as JobDetail["truncation"] });
    expect(invalidProjection.truncation ?? {}).not.toHaveProperty("bad");
    expect(fitsPublic(1n)).toBe(false);
    const malformedCondition = publicDetail({ jobId: "job_condition", status: "running", sequence: 1, createdAtMs: 1, request: { ...request, condition: (() => undefined) as unknown as JobRequestSnapshot["condition"] } });
    expect(malformedCondition.truncation).toMatchObject({ requestCondition: true });
    const clippedCondition = publicDetail({ jobId: "job_condition_clip", status: "running", sequence: 1, createdAtMs: 1, request: { ...request, condition: { kind: "output", match: { kind: "literal", value: "x".repeat(10_000) } } } });
    expect(clippedCondition.truncation).toMatchObject({ requestCondition: true, requestConditionClipped: true });
    const unclippedCondition = publicDetail({ jobId: "job_condition_extra", status: "running", sequence: 1, createdAtMs: 1, request: { ...request, condition: { kind: "output", match: { kind: "literal", value: "short" }, extra: "x".repeat(10_000) } as unknown as JobRequestSnapshot["condition"] } });
    expect(unclippedCondition.truncation).toMatchObject({ requestCondition: true });
    expect(unclippedCondition.truncation?.requestConditionClipped).toBeUndefined();
    const clippedError = publicDetail({ jobId: "job_error", status: "failed", sequence: 1, createdAtMs: 1, request, error: { code: "c".repeat(2_000), message: "m".repeat(2_000) } });
    expect(clippedError.truncation).toMatchObject({ errorCodeClipped: true, errorMessageClipped: true });

    const compacted = publicDetail({
      jobId: "job_compact",
      status: "completed",
      sequence: 1,
      createdAtMs: 1,
      request,
      progress: { text: "progress", atMs: 1, details: { evidence: "x" } },
      result: { outcome: "success", matched: true, targets: [{ target: "target", targetId: "p1", metadata: {}, recentUnwrappedLines: ["line"], observedAtMs: 1, matched: true }], reviewerSummaries: [{ target: "target", targetId: "p1", classification: "blocked", summary: "review" }] }
    }, 1);
    expect(compacted.truncation).toMatchObject({ publicEvidenceOmitted: true });
    const minimalWithMatch = publicDetail({
      jobId: "job_compact_match",
      status: "cancelled",
      sequence: 1,
      createdAtMs: 1,
      startedAtMs: 1,
      finishedAtMs: 2,
      request,
      outcome: "success",
      cancelReason: "cancelled",
      result: { outcome: "success", matched: true, matchedTargetCount: 2, matchedTargets: [{ target: "target", targetId: "p1" }] }
    }, 1);
    expect(minimalWithMatch.result).toMatchObject({ matchedTargetCount: 2, matchedTargets: [{ targetId: "p1" }] });
    const noResult = publicDetail({ jobId: "job_no_result", status: "running", sequence: 1, createdAtMs: 1, request }, 1);
    expect(noResult.result).toBeUndefined();
    const noLines = publicDetail({
      jobId: "job_no_lines",
      status: "completed",
      sequence: 1,
      createdAtMs: 1,
      request,
      result: { outcome: "success", matched: true, targets: [{ target: "target", targetId: "p1", metadata: {}, recentUnwrappedLines: [], observedAtMs: 1, matched: true }] }
    }, 1);
    expect(noLines.truncation).toMatchObject({ publicEvidenceOmitted: true });
    const untouched = publicDetail({ jobId: "job_untouched", status: "running", sequence: 1, createdAtMs: 1, request }, 1);
    expect(untouched.status).toBe("running");

    const jobs = Array.from({ length: 100 }, (_, index) => ({
      jobId: index === 0 ? "job_" + "z".repeat(1_000) : `job_${index}`,
      label: index === 0 ? "label-" + "q".repeat(1_000) : `wait ${index}`,
      status: "running" as const,
      sequence: index,
      createdAtMs: index,
      startedAtMs: index === 0 ? index : undefined,
      finishedAtMs: index === 0 ? index : undefined,
      targetIds: [`p${index}`],
      targets: [`target-${index}`],
      ...(index === 0 ? { outcome: "success" as const, reason: "condition_met", error: { code: "CODE", message: "message" } } : index === 1 ? { error: { message: "message" } } : {}),
      ...(index === 0 ? { progress: { text: "progress", atMs: index } } : {}),
      ...(index === 0 ? { truncation: { jobIdClipped: true } } : {})
    }));
    const listed = boundedList({ jobs, total: 100, offset: 0, limit: 100, nextOffset: null, truncation: { jobs: 1, padding: "x".repeat(100_000) } as unknown as JobListResult["truncation"] });
    expect(listed.jobs).toHaveLength(100);
    expect(listed.truncation).toMatchObject({ jobs: 1, jobIdsClipped: 100 });
    expect(listed.jobs[0]).toMatchObject({ truncation: { jobIdClipped: true, labelClipped: true } });
    expect(Buffer.byteLength(JSON.stringify(listed, null, 2), "utf8")).toBeLessThan(50_000);

    const largeJobs = jobs.map((job) => ({ ...job, targetIds: ["x".repeat(10_000)], targets: ["y".repeat(10_000)] }));
    const compactList = boundedList({ jobs: largeJobs, total: 100, offset: 0, limit: 100, nextOffset: null });
    expect(compactList.jobs).toHaveLength(100);
    const noJobCount = boundedList({ jobs: largeJobs, total: 100, offset: 0, limit: 100, nextOffset: null, truncation: { padding: "x".repeat(100_000) } as unknown as JobListResult["truncation"] });
    expect(noJobCount.truncation).toMatchObject({ jobIdsClipped: 100 });

    const longIdRegistry = new JobRegistry({ idFactory: () => "job_" + "l".repeat(1_000) });
    const longIdHandle = longIdRegistry.register(request, async () => new Promise<never>(() => undefined));
    expect(longIdRegistry.list().jobs[0]).toMatchObject({ truncation: { jobIdClipped: true } });
    longIdRegistry.cancel(longIdHandle.jobId);
  });

  it("does not let notification or change-listener failures escape", async () => {
    const syncChange = new JobRegistry({ idFactory: () => "job_change_sync", onChange: () => { throw new Error("ui down"); } });
    const syncChangeHandle = syncChange.register(request, async () => success);
    await expect(syncChangeHandle.promise).resolves.toBeUndefined();
    const asyncChange = new JobRegistry({ idFactory: () => "job_change_async", onChange: async () => { throw new Error("async ui down"); } });
    const asyncChangeHandle = asyncChange.register(request, async () => success);
    await expect(asyncChangeHandle.promise).resolves.toBeUndefined();
    await new Promise<void>((resolve) => setImmediate(resolve));

    const registry = new JobRegistry({ idFactory: () => "job_notify", onTerminal: () => { throw new Error("ui down"); } });
    const handle = registry.register(request, async () => success);
    await expect(handle.promise).resolves.toBeUndefined();
    expect(registry.get(handle.jobId)).toMatchObject({ status: "completed" });

    const rejected = new JobRegistry({ idFactory: () => "job_notify_async", onTerminal: async () => { throw new Error("async ui down"); } });
    const asyncHandle = rejected.register(request, async () => success);
    await expect(asyncHandle.promise).resolves.toBeUndefined();
    expect(rejected.get(asyncHandle.jobId)).toMatchObject({ status: "completed" });
  });
});
