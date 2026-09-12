import { describe, expect, it } from "vitest";
import { JobRegistry, type JobRequestSnapshot } from "../../src/job-registry.js";
import { createJobsTool, boundedContent, detailContent } from "../../src/tools/jobs.js";

const request: JobRequestSnapshot = {
  kind: "wait",
  label: "wait for worker",
  targets: ["worker"], targetIds: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 10,
  settings: { reviewCadenceMinutes: 1, reviewerModel: "luna", reviewerThinking: "max" }
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
    expect(listed.details).toMatchObject({ operation: "jobs", view: "list", total: 1, jobs: [{ jobId: handle.jobId, label: "wait for worker", operation_phase: "accepted" }] });
    const got = await tool.execute("id", { operation: "get", jobId: handle.jobId } as never, undefined, undefined, {} as never);
    expect(got.details).toMatchObject({ operation: "jobs", view: "job", jobId: handle.jobId, operation_phase: "accepted", request: { label: "wait for worker" } });
    const cancelled = await tool.execute("id", { operation: "cancel", jobId: handle.jobId } as never, undefined, undefined, {} as never);
    expect(cancelled.details).toMatchObject({ jobId: handle.jobId, operation_phase: "settled", wait_result: "unknown" });
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

  it("renders list, unknown errors, and settled wait-result tones", async () => {
    const jobs = registry();
    const tool = createJobsTool(jobs);
    const listCall = tool.renderCall?.({ operation: "list" } as never, {} as never, {} as never);
    expect(listCall?.render(80)).toEqual(["herdr_jobs · list"]);
    listCall?.invalidate();
    const defaultCall = tool.renderCall?.({} as never, {} as never, {} as never);
    expect(defaultCall?.render(80)).toEqual(["herdr_jobs · jobs"]);
    defaultCall?.invalidate();
    const listResult = tool.renderResult?.({ content: [], details: { operation: "jobs", view: "list", jobs: [], total: 0, offset: 0, limit: 20, nextOffset: null }, isError: false } as never, { expanded: false, isPartial: false }, {} as never, {} as never);
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

    const acceptedWithoutResult = tool.renderResult?.({ content: [], details: { operation: "jobs", view: "job", operation_phase: "settled" }, isError: false } as never, { expanded: false, isPartial: false }, {} as never, {} as never);
    expect(acceptedWithoutResult?.render(80)).toEqual(["job · settled"]);
    acceptedWithoutResult?.invalidate();
    const failed = jobs.register(request, async () => { throw new Error("failed"); });
    await failed.promise;
    const failedResult = await tool.execute("id", { operation: "get", jobId: failed.jobId } as never, undefined, undefined, {} as never);
    const failedRendered = tool.renderResult?.(failedResult as never, { expanded: false, isPartial: false }, {} as never, {} as never);
    expect(failedRendered?.render(80)).toEqual(["job · settled · failed"]);
    failedRendered?.invalidate();
    const cancelled = jobs.register(request, async () => new Promise<never>(() => undefined));
    await jobs.cancel(cancelled.jobId);
    const cancelledResult = await tool.execute("id", { operation: "get", jobId: cancelled.jobId } as never, undefined, undefined, {} as never);
    const cancelledRendered = tool.renderResult?.(cancelledResult as never, { expanded: false, isPartial: false }, {} as never, {} as never);
    expect(cancelledRendered?.render(80)).toEqual(["job · settled · cancelled"]);
    cancelledRendered?.invalidate();
  });

  it("returns model-visible summaries and bounded aggregate public results", async () => {
    const jobs = registry();
    const tool = createJobsTool(jobs);
    const oversizedRequest: JobRequestSnapshot = {
      ...request,
      targets: Array.from({ length: 100 }, (_, index) => `target-${index}-${"x".repeat(1_000)}`),
      targetIds: Array.from({ length: 100 }, (_, index) => `pane-${index}-${"y".repeat(1_000)}`),
      condition: { kind: "output", match: { kind: "literal", value: "z".repeat(100_000) } }
    };
    const oversized = jobs.register(oversizedRequest, async (_signal, update) => {
      update("progress ".repeat(500), { evidence: "d".repeat(100_000) });
      return {
        wait_result: "condition_met",
        matched: true,
        reason: "condition_met",
        targets: Array.from({ length: 100 }, (_, index) => ({
          target: `target-${index}`,
          targetId: `pane-${index}`,
          metadata: { agent_status: "done", evidence: "m".repeat(100_000) },
          recentUnwrappedLines: Array.from({ length: 100 }, (__, line) => `line-${line}-${"l".repeat(2_000)}`),
          observedAtMs: index,
          matched: index === 3
        })),
        reviewerSummaries: Array.from({ length: 100 }, (_, index) => ({ target: `target-${index}`, targetId: `pane-${index}`, classification: "progress", summary: "review ".repeat(500) }))
      };
    });
    await oversized.promise;
    const summaryPage = jobs.list("settled", 0, 100);
    expect(summaryPage.jobs[0]).toMatchObject({ truncation: { targetIds: 98, targets: 98 } });
    const got = await tool.execute("id", { operation: "get", jobId: oversized.jobId } as never, undefined, undefined, {} as never);
    const detailText = JSON.stringify(got.details, null, 2);
    const contentText = got.content.map((item) => item.type === "text" ? item.text : "").join("\\n");
    expect(detailText).toContain('"truncation"');
    expect(detailText).toContain('"resultTargets"');
    expect(detailText).toContain('"wait_result": "condition_met"');
    expect(Buffer.byteLength(detailText, "utf8")).toBeLessThan(50_000);
    expect(detailText.split("\\n").length).toBeLessThanOrEqual(2_000);
    expect(Buffer.byteLength(contentText, "utf8")).toBeLessThan(50_000);
    expect(contentText.split("\\n").length).toBeLessThanOrEqual(2_000);
    expect(contentText).toContain(oversized.jobId);
    expect(contentText).toContain("condition_met");

    const listRegistry = registry();
    const listTool = createJobsTool(listRegistry);
    const pending = new Promise<never>(() => undefined);
    const running = Array.from({ length: 30 }, (_, index) => listRegistry.register({ ...request, targets: [`worker-${index}`], targetIds: [`p-${index}`] }, async (_signal, update) => { update("progress ".repeat(500)); return pending; }));
    const listed = await listTool.execute("id", { operation: "list", limit: 100 } as never, undefined, undefined, {} as never);
    const listedText = listed.content.map((item) => item.type === "text" ? item.text : "").join("\\n");
    expect((listed.details as { jobs: unknown[]; truncation?: { jobs: number } }).jobs.length).toBe(30);
    expect(listed.details).toMatchObject({ nextOffset: null });
    expect(listedText).toContain("job_1");
    expect(listedText).toContain('"operation_phase": "accepted"');
    expect(Buffer.byteLength(JSON.stringify(listed.details, null, 2), "utf8")).toBeLessThan(50_000);
    expect(listedText.split("\\n").length).toBeLessThanOrEqual(2_000);
    const cancelled = await listTool.execute("id", { operation: "cancel", jobId: running[0]!.jobId } as never, undefined, undefined, {} as never);
    const cancelledText = cancelled.content.map((item) => item.type === "text" ? item.text : "").join("\\n");
    expect(cancelled.details).toMatchObject({ operation_phase: "settled", wait_result: "unknown" });
    expect(Buffer.byteLength(JSON.stringify(cancelled.details, null, 2), "utf8")).toBeLessThan(50_000);
    expect(Buffer.byteLength(cancelledText, "utf8")).toBeLessThan(50_000);
    running.forEach((handle) => listRegistry.cancel(handle.jobId));
  });

  it("returns 100 requested summaries without changing pagination semantics", async () => {
    const jobs = registry();
    const tool = createJobsTool(jobs);
    const pending = new Promise<never>(() => undefined);
    const handles = Array.from({ length: 100 }, (_, index) => jobs.register({ ...request, targets: [`worker-${index}`], targetIds: [`p-${index}`] }, async () => pending));
    const listed = await tool.execute("id", { operation: "list", limit: 100 } as never, undefined, undefined, {} as never);
    const detailsText = JSON.stringify(listed.details, null, 2);
    const contentText = listed.content.map((item) => item.type === "text" ? item.text : "").join("\\n");
    expect((listed.details as { jobs: unknown[] }).jobs).toHaveLength(100);
    expect(listed.details).toMatchObject({ total: 100, offset: 0, limit: 100, nextOffset: null });
    expect(Buffer.byteLength(detailsText, "utf8")).toBeLessThan(50_000);
    expect(detailsText.split("\\n").length).toBeLessThanOrEqual(2_000);
    expect(Buffer.byteLength(contentText, "utf8")).toBeLessThan(50_000);
    expect(contentText.split("\\n").length).toBeLessThanOrEqual(2_000);
    const offsetPage = await tool.execute("id", { operation: "list", offset: 30, limit: 100 } as never, undefined, undefined, {} as never);
    expect(offsetPage.details).toMatchObject({ total: 100, offset: 30, limit: 100, nextOffset: null });
    expect((offsetPage.details as { jobs: unknown[] }).jobs).toHaveLength(70);
    handles.forEach((handle) => jobs.cancel(handle.jobId));
  });

  it("supports strict pagination and bounded list/get render content", async () => {
    const jobs = registry();
    const tool = createJobsTool(jobs);
    const first = jobs.register({ ...request, targets: ["a"], targetIds: ["a"] }, async (_signal, update) => { update("x".repeat(2_000)); return { wait_result: "condition_met", matched: true, reason: "condition_met" }; });
    await first.promise;
    const page = await tool.execute("id", { operation: "list", operation_phase: "settled", offset: 0, limit: 1 } as never, undefined, undefined, {} as never);
    expect(page.details).toMatchObject({ total: 1 });
    expect((page.details as { nextOffset: number | null }).nextOffset).toBeNull();
    expect(JSON.stringify(page).length).toBeGreaterThan(0);
    const detail = await tool.execute("id", { operation: "get", jobId: first.jobId } as never, undefined, undefined, {} as never);
    const withRefs = jobs.register({ ...request, target_generation_refs: ["r".repeat(100), "r2", "r3"] }, async () => new Promise<never>(() => undefined));
    expect(jobs.get(withRefs.jobId)?.request.target_generation_refs).toHaveLength(3);
    expect(jobs.list().jobs.find((job) => job.jobId === withRefs.jobId)).toMatchObject({ target_generation_refs: [expect.any(String), "r2"], truncation: { targetGenerationRefs: 1, targetGenerationRefsClipped: 1 } });
    await jobs.cancel(withRefs.jobId);
    expect(detailContent(detail.details as never).length).toBeLessThanOrEqual(50_000 + 40);
    expect(boundedContent({ text: "x".repeat(100_000) }).length).toBeLessThanOrEqual(50_000 + 40);
    const call = tool.renderCall?.({ operation: "get", jobId: first.jobId } as never, {} as never, {} as never);
    expect(call?.render(80)).toEqual([`herdr_jobs · get · ${first.jobId}`]);
    call?.invalidate();
    const rendered = tool.renderResult?.(detail as never, { expanded: false, isPartial: false }, {} as never, {} as never);
    expect(rendered?.render(80)).toEqual(["job · settled · condition_met"]);
    rendered?.invalidate();
    const partial = tool.renderResult?.(detail as never, { expanded: false, isPartial: true }, {} as never, {} as never);
    expect(partial?.render(80)).toEqual(["partial · jobs"]);
    partial?.invalidate();
    const error = tool.renderResult?.({ content: [], details: { code: "JOB_NOT_FOUND" }, isError: true } as never, { expanded: false, isPartial: false }, {} as never, {} as never);
    expect(error?.render(80)).toEqual(["error JOB_NOT_FOUND"]);
    error?.invalidate();
  });
});
