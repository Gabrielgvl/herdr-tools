import { describe, expect, it, vi } from "vitest";
import { JobRegistry, jobDetailContent, type JobRequestSnapshot, type JobRunResult } from "../../src/job-registry.js";

const request: JobRequestSnapshot = {
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

  it("does not let notification failures escape", async () => {
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
