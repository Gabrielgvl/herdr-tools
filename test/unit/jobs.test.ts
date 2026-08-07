import { describe, expect, it } from "vitest";
import { JobRegistry, type JobRequestSnapshot } from "../../src/job-registry.js";
import { createJobsTool, boundedContent, detailContent } from "../../src/tools/jobs.js";

const request: JobRequestSnapshot = {
  targets: ["worker"], targetIds: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 10,
  settings: { reviewCadenceMinutes: 1, reviewerModel: "luna", reviewerThinking: "low" }
};

function registry() {
  let id = 0;
  return new JobRegistry({ idFactory: () => `job_${++id}`, clock: { now: () => 1 } });
}

describe("herdr_jobs", () => {
  it("lists, gets, and cancels only owned jobs", async () => {
    const jobs = registry();
    const tool = createJobsTool(jobs);
    const pending = new Promise<never>(() => undefined);
    const handle = jobs.register(request, async () => pending);
    const listed = await tool.execute("id", { operation: "list" } as never, new AbortController().signal, undefined, {} as never);
    expect(listed.details).toMatchObject({ operation: "jobs", kind: "list", total: 1, jobs: [{ jobId: handle.jobId, status: "running" }] });
    const got = await tool.execute("id", { operation: "get", jobId: handle.jobId } as never, undefined, undefined, {} as never);
    expect(got.details).toMatchObject({ operation: "jobs", kind: "job", jobId: handle.jobId, status: "running" });
    const cancelled = await tool.execute("id", { operation: "cancel", jobId: handle.jobId } as never, undefined, undefined, {} as never);
    expect(cancelled.details).toMatchObject({ jobId: handle.jobId, status: "cancelled" });
    await expect(tool.execute("id", { operation: "get", jobId: "job_unknown" } as never, undefined, undefined, {} as never)).rejects.toMatchObject({ code: "JOB_NOT_FOUND" });
    await expect(tool.execute("id", { operation: "list", limit: 101 } as never, undefined, undefined, {} as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(tool.execute("id", { operation: "list", snake_case: true } as never, undefined, undefined, {} as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const hostile = new Proxy({ operation: "list" }, { get: () => { throw "malformed jobs input"; } });
    await expect(tool.execute("id", hostile as never, undefined, undefined, {} as never)).rejects.toMatchObject({ code: "INVALID_INPUT", message: "malformed jobs input" });
  });

  it("handles a cancellation race after the job was inspected", async () => {
    const jobs = registry();
    const pending = new Promise<never>(() => undefined);
    const handle = jobs.register(request, async () => pending);
    const raceRegistry = {
      get: () => jobs.get(handle.jobId),
      cancel: () => undefined,
    } as unknown as JobRegistry;
    const tool = createJobsTool(raceRegistry);
    await expect(tool.execute("id", { operation: "cancel", jobId: handle.jobId } as never, undefined, undefined, {} as never)).rejects.toMatchObject({ code: "JOB_NOT_FOUND" });
    jobs.cancel(handle.jobId);
  });

  it("renders list, unknown errors, and terminal status tones", async () => {
    const jobs = registry();
    const tool = createJobsTool(jobs);
    const listCall = tool.renderCall?.({ operation: "list" } as never, {} as never, {} as never);
    expect(listCall?.render(80)).toEqual(["herdr_jobs · list"]);
    listCall?.invalidate();
    const defaultCall = tool.renderCall?.({} as never, {} as never, {} as never);
    expect(defaultCall?.render(80)).toEqual(["herdr_jobs · jobs"]);
    defaultCall?.invalidate();
    const listResult = tool.renderResult?.({ content: [], details: { operation: "jobs", kind: "list", jobs: [], total: 0, offset: 0, limit: 20, nextOffset: null }, isError: false } as never, { expanded: false, isPartial: false }, {} as never, {} as never);
    expect(listResult?.render(80)).toEqual(["jobs · 0/0"]);
    listResult?.invalidate();
    const small = boundedContent({ ok: true });
    expect(small).toBe("{\n  \"ok\": true\n}");
    const unknownError = tool.renderResult?.({ content: [], details: {}, isError: true } as never, { expanded: false, isPartial: false }, {} as never, {} as never);
    expect(unknownError?.render(80)).toEqual(["error UNKNOWN"]);
    unknownError?.invalidate();
    const malformed = tool.renderResult?.({ content: [], details: { operation: "other" }, isError: false } as never, { expanded: false, isPartial: false }, {} as never, {} as never);
    expect(malformed?.render(80)).toEqual(["error UNKNOWN"]);
    malformed?.invalidate();

    const failed = jobs.register(request, async () => { throw new Error("failed"); });
    await failed.promise;
    const failedResult = await tool.execute("id", { operation: "get", jobId: failed.jobId } as never, undefined, undefined, {} as never);
    const failedRendered = tool.renderResult?.(failedResult as never, { expanded: false, isPartial: false }, {} as never, {} as never);
    expect(failedRendered?.render(80)).toEqual(["job · failed"]);
    failedRendered?.invalidate();
    const cancelled = jobs.register(request, async () => new Promise<never>(() => undefined));
    jobs.cancel(cancelled.jobId);
    const cancelledResult = await tool.execute("id", { operation: "get", jobId: cancelled.jobId } as never, undefined, undefined, {} as never);
    const cancelledRendered = tool.renderResult?.(cancelledResult as never, { expanded: false, isPartial: false }, {} as never, {} as never);
    expect(cancelledRendered?.render(80)).toEqual(["job · cancelled"]);
    cancelledRendered?.invalidate();
  });

  it("supports strict pagination and bounded list/get render content", async () => {
    const jobs = registry();
    const tool = createJobsTool(jobs);
    const first = jobs.register({ ...request, targets: ["a"], targetIds: ["a"] }, async (_signal, update) => { update("x".repeat(2_000)); return { outcome: "success", matched: true, reason: "condition_met" }; });
    await first.promise;
    const page = await tool.execute("id", { operation: "list", status: "completed", offset: 0, limit: 1 } as never, undefined, undefined, {} as never);
    expect(page.details).toMatchObject({ total: 1 });
    expect((page.details as { nextOffset: number | null }).nextOffset).toBeNull();
    expect(JSON.stringify(page).length).toBeGreaterThan(0);
    const detail = await tool.execute("id", { operation: "get", jobId: first.jobId } as never, undefined, undefined, {} as never);
    expect(detailContent(detail.details as never).length).toBeLessThanOrEqual(50_000 + 40);
    expect(boundedContent({ text: "x".repeat(100_000) }).length).toBeLessThanOrEqual(50_000 + 40);
    const call = tool.renderCall?.({ operation: "get", jobId: first.jobId } as never, {} as never, {} as never);
    expect(call?.render(80)).toEqual([`herdr_jobs · get · ${first.jobId}`]);
    call?.invalidate();
    const rendered = tool.renderResult?.(detail as never, { expanded: false, isPartial: false }, {} as never, {} as never);
    expect(rendered?.render(80)).toEqual(["job · completed"]);
    rendered?.invalidate();
    const partial = tool.renderResult?.(detail as never, { expanded: false, isPartial: true }, {} as never, {} as never);
    expect(partial?.render(80)).toEqual(["partial · jobs"]);
    partial?.invalidate();
    const error = tool.renderResult?.({ content: [], details: { code: "JOB_NOT_FOUND" }, isError: true } as never, { expanded: false, isPartial: false }, {} as never, {} as never);
    expect(error?.render(80)).toEqual(["error JOB_NOT_FOUND"]);
    error?.invalidate();
  });
});
