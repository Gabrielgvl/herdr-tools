import { describe, expect, it, vi } from "vitest";
import { boundedList, fitsPublic, JobRegistry, jobDetailContent, publicDetail, SupervisionActiveError, type JobDetail, type JobListResult, type JobRequestSnapshot, type JobRunResult, type JobOperationControl, type SupervisorJobRequestSnapshot } from "../../src/job-registry.js";
import { historicalTargetEvidence } from "../../src/wait-target-evidence.js";
import type { SupervisionJobPort, SupervisionJobView } from "../../src/supervision/state.js";
import type { SupervisedIdentity } from "../../src/supervision/identity.js";

const request: JobRequestSnapshot = {
  kind: "wait",
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

const success: JobRunResult = { wait_result: "condition_met", matched: true, reason: "condition_met", targets: [{ target: "one", targetId: "p1", metadata: { agent_status: "done" }, recentUnwrappedLines: ["done"], observedAtMs: 1, matched: true }] };

const provisionalRequest: SupervisorJobRequestSnapshot = {
  kind: "supervisor",
  label: "supervise agy",
  targets: ["agy"],
  targetIds: [],
  target_generation_refs: ["target_generation_provisional"],
  child: { agentName: "agy", agentKind: "agy", profileName: "researcher-agy" },
  settings: { reviewCadenceMinutes: 5, reviewerModel: "typesafe/jev-latest", reviewerThinking: "max" },
};

const provisionalIdentity: SupervisedIdentity = {
  paneId: "p1",
  terminalId: "t1",
  agentName: "agy",
  agentKind: "agy",
  agentSession: { source: "agy", agent: "agy", kind: "id", value: "native-session" },
};

describe("JobRegistry", () => {
  it("starts jobs without a cap and retains only the latest bounded progress", async () => {
    let ids = 0;
    const registry = new JobRegistry({ idFactory: () => `job_${++ids}`, clock: { now: () => 10 } });
    const first = deferred<JobRunResult>();
    const second = deferred<JobRunResult>();
    const one = registry.register(request, async (_signal, update) => { update("a".repeat(10_000), { sequence: 1 }); return first.promise; });
    const two = registry.register({ ...request, targets: ["two"], targetIds: ["p2"] }, async (_signal, update) => { update("latest"); return second.promise; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(registry.size()).toBe(2);
    expect(registry.get(one.jobId)?.progress?.text.length).toBeLessThan(10_000);
    expect(registry.get(two.jobId)?.progress?.text).toBe("latest");
    first.resolve(success);
    second.resolve({ wait_result: "timed_out", matched: false, reason: "timeout" });
    await Promise.all([one.promise, two.promise]);
    expect(registry.get(one.jobId)).toMatchObject({ operation_phase: "settled", wait_result: "condition_met" });
    expect(registry.get(two.jobId)).toMatchObject({ operation_phase: "settled", wait_result: "timed_out" });
  });

  it("publishes AGY provisional supervision without exact coverage or cancellation", async () => {
    const onChange = vi.fn();
    const registry = new JobRegistry({ idFactory: () => "job_provisional", onChange });
    const handle = registry.register(provisionalRequest, async () => new Promise<never>(() => undefined));
    await vi.waitFor(() => expect(registry.get(handle.jobId)?.operation_phase).toBe("running"));

    let shutdownCalls = 0;
    let childLive = false;
    const provisionalView: SupervisionJobView = {
      state: "provisional",
      monitor: { connected: true, degraded: false, generation: 1, evidenceGaps: 0 },
      reviewer: { model: "typesafe/jev-latest", thinking: "max", cadenceMinutes: 5, degraded: false, reviews: [], truncatedReviews: 0 },
      transitions: [],
      truncatedTransitions: 0,
      events: [],
      truncatedEvents: 0,
      unobservedEvents: 0,
      provisional: {
        agentName: "agy",
        agentKind: "agy",
        paneId: "p1",
        terminalId: "t1",
        profileName: "researcher-agy",
        baseline: { state: "idle", stateChangeSeq: 4, revision: 2 },
      },
      status: "idle",
    };
    const port: SupervisionJobPort = {
      view: () => provisionalView,
      takePendingEvents: () => [],
      childLive: () => childLive,
      coversIdentity: () => true,
      shutdown: () => { shutdownCalls += 1; },
    };
    registry.attachSupervision(handle.jobId, port);
    onChange.mockClear();

    const publication = registry.prepareProvisionalSupervisionChildBinding(handle.jobId, { agentKind: "agy", profileName: "researcher-agy" });
    expect(() => publication.publish()).toThrow(/SUPERVISION_BINDING_UNCOMMITTED/u);
    publication.commit();
    expect(onChange).not.toHaveBeenCalled();
    expect(registry.get(handle.jobId)).toMatchObject({
      operation_phase: "running",
      request: { targetIds: [], child: { agentName: "agy", agentKind: "agy", profileName: "researcher-agy" } },
      supervision: { state: "provisional", provisional: { paneId: "p1", terminalId: "t1", baseline: { state: "idle", stateChangeSeq: 4, revision: 2 } } },
    });
    expect(registry.activeSupervisorFor(provisionalIdentity)).toBeUndefined();

    // The child becomes live after cancellation's initial observation but before
    // its locked transition. The locked recheck must refuse the close.
    const cancellation = registry.cancel(handle.jobId);
    childLive = true;
    await expect(cancellation).rejects.toBeInstanceOf(SupervisionActiveError);
    expect(registry.get(handle.jobId)?.operation_phase).toBe("running");

    publication.publish();
    expect(onChange).toHaveBeenCalledTimes(1);
    await expect(registry.cancel(handle.jobId)).rejects.toBeInstanceOf(SupervisionActiveError);
    expect(registry.get(handle.jobId)?.operation_phase).toBe("running");
    expect(registry.size()).toBe(1);

    publication.rollback();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(registry.get(handle.jobId)).toMatchObject({
      operation_phase: "running",
      request: { targetIds: [], child: { agentKind: "agy", profileName: "researcher-agy" } },
    });
    expect(shutdownCalls).toBe(0);
    registry.shutdown();
    expect(shutdownCalls).toBe(1);
  });

  it.each(["pi", "claude"] as const)("allows a %s-requested reservation to bind an AGY fallback provisionally", async (agentKind) => {
    const registry = new JobRegistry({ idFactory: () => "job_agy_fallback" });
    const requestedProfileName = `researcher-${agentKind}`;
    const handle = registry.register({
      ...provisionalRequest,
      child: { agentName: "worker", agentKind, profileName: requestedProfileName },
    }, async () => new Promise<never>(() => undefined));
    await vi.waitFor(() => expect(registry.get(handle.jobId)?.operation_phase).toBe("running"));

    const publication = registry.prepareProvisionalSupervisionChildBinding(handle.jobId, { agentKind: "agy", profileName: "fallback-agy" });
    publication.commit();
    expect(registry.get(handle.jobId)?.request).toMatchObject({
      targetIds: [],
      child: { agentKind: "agy", profileName: "fallback-agy", requestedAgentKind: agentKind, requestedProfileName },
    });
    publication.rollback();
    expect(registry.get(handle.jobId)?.request).toMatchObject({ child: { agentKind, profileName: requestedProfileName } });
    registry.shutdown();
  });

  it.each(["pi", "claude"] as const)("allows an AGY-requested reservation to bind an exact %s fallback", async (agentKind) => {
    const registry = new JobRegistry({ idFactory: () => "job_fallback" });
    const handle = registry.register(provisionalRequest, async () => new Promise<never>(() => undefined));
    await vi.waitFor(() => expect(registry.get(handle.jobId)?.operation_phase).toBe("running"));

    const profileName = `researcher-${agentKind}`;
    const publication = registry.prepareSupervisionChildBinding(handle.jobId, { agentKind, profileName, paneId: "p1" });
    publication.commit();
    expect(registry.get(handle.jobId)?.request).toMatchObject({
      targetIds: ["p1"],
      child: { agentKind, profileName, requestedAgentKind: "agy", requestedProfileName: "researcher-agy" },
    });
    publication.rollback();
    registry.shutdown();
  });

  it("orders newest first, filters before pagination, and returns immutable views", async () => {
    let id = 0;
    let now = 0;
    const registry = new JobRegistry({ idFactory: () => `job_${++id}`, clock: { now: () => ++now } });
    const handles = [0, 1, 2].map(() => registry.register(request, async () => success));
    registry.update(handles[0]!.jobId, "still running");
    await Promise.all(handles.map((handle) => handle.promise));
    const page = registry.list("settled", 1, 1);
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
    const cancelled = await registry.cancel(handle.jobId);
    expect(cancelled).toMatchObject({ operation_phase: "settled", wait_result: "cancelled", cancelReason: "cancelled" });
    expect(await registry.cancel(handle.jobId)).toMatchObject({ operation_phase: "settled", wait_result: "cancelled" });
    pending.resolve(success);
    await handle.promise;
    expect(registry.get(handle.jobId)).toMatchObject({ operation_phase: "settled", wait_result: "cancelled" });
    expect(registry.list().jobs[0]).toMatchObject({ operation_phase: "settled", wait_result: "cancelled", reason: "cancelled" });
    expect(terminal).not.toHaveBeenCalled();
    await expect(registry.cancel("job_missing")).resolves.toBeUndefined();
  });

  it("fences cancellation, drains activities, and records conservative late settlements", async () => {
    const gate = deferred<JobRunResult>();
    const activityStarted = deferred<void>();
    let control!: JobOperationControl;
    const registry = new JobRegistry({ idFactory: () => "job_unknown_cancel", quiescenceMs: 10, clock: { now: () => 2 } });
    const handle = registry.register(request, async (_signal, _update, operationControl) => {
      control = operationControl;
      const release = control.beginActivity();
      activityStarted.resolve();
      const result = await gate.promise;
      release();
      release();
      return result;
    });
    await activityStarted.promise;
    expect(control.isOpen()).toBe(true);
    expect(control.fence).toBe(0);
    const firstCancel = registry.cancel(handle.jobId);
    const secondCancel = registry.cancel(handle.jobId);
    const observedBeforeSettlement = await new Promise<JobDetail>((resolve) => setImmediate(() => resolve(registry.get(handle.jobId)!)));
    expect(observedBeforeSettlement.cancelReason).toBe("cancelled");
    expect(control.isOpen()).toBe(false);
    expect(control.fence).toBe(1);
    expect(() => control.check()).toThrow(/operation fence is closed/);
    expect(() => control.beginActivity()).toThrow(/operation fence is closed/);
    const first = await firstCancel;
    const second = await secondCancel;
    expect(first).toMatchObject({ operation_phase: "settled", wait_result: "unknown", error: { code: "CANCELLATION_UNCERTAIN" } });
    expect(second).toMatchObject({ operation_phase: "settled", wait_result: "unknown" });
    gate.resolve(success);
    await handle.promise;
    expect(registry.get(handle.jobId)).toMatchObject({ late_settlement_observed: { kind: "fulfilled", observedAtMs: 2 } });
    const internals = registry as unknown as {
      jobs: Map<string, unknown>;
      late(record: unknown, kind: "fulfilled" | "rejected"): void;
      settleLocked(record: unknown, waitResult: "failed"): boolean;
      waitForDrain(record: unknown): Promise<boolean>;
    };
    const record = internals.jobs.get(handle.jobId)!;
    internals.late(record, "rejected");
    expect(registry.get(handle.jobId)).toMatchObject({ late_settlement_observed: { kind: "fulfilled" } });
    expect(internals.settleLocked(record, "failed")).toBe(false);
    await expect(internals.waitForDrain(record)).resolves.toBe(true);

    const rejectedGate = deferred<JobRunResult>();
    const rejectedStarted = deferred<void>();
    const rejectedRegistry = new JobRegistry({ idFactory: () => "job_rejected_late", quiescenceMs: 0 });
    const rejected = rejectedRegistry.register(request, async () => { rejectedStarted.resolve(); return rejectedGate.promise; });
    await rejectedStarted.promise;
    const rejectedCancel = rejectedRegistry.cancel(rejected.jobId);
    await rejectedCancel;
    rejectedGate.reject(new Error("late rejection"));
    await rejected.promise;
    expect(rejectedRegistry.get(rejected.jobId)).toMatchObject({ late_settlement_observed: { kind: "rejected" } });
  });

  it("handles cancellation before execution starts and validates bounded constructor settings", async () => {
    const early = new JobRegistry({ idFactory: () => "job_early_cancel", quiescenceMs: 0 });
    const handle = early.register(request, async (signal) => new Promise<never>((_resolve, reject) => {
      if (signal.aborted) reject(Object.assign(new Error("aborted"), { code: "ABORTED" }));
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { code: "ABORTED" })), { once: true });
    }));
    const cancellation = await early.cancel(handle.jobId);
    expect(cancellation).toMatchObject({ operation_phase: "settled", wait_result: "cancelled" });
    await handle.promise;
    expect(early.get(handle.jobId)).toMatchObject({ operation_phase: "settled", wait_result: "cancelled" });
    expect(new JobRegistry({ quiescenceMs: -1 }).runningOverview()).toEqual({ jobs: [], total: 0 });
    expect(new JobRegistry({ quiescenceMs: Number.NaN }).runningOverview()).toEqual({ jobs: [], total: 0 });
  });

  it("projects valid and invalid historical evidence without claiming current state", async () => {
    const registry = new JobRegistry({ idFactory: () => "job_evidence" });
    const evidence = historicalTargetEvidence("native_done_observed", 10, "target_generation_opaque", "native_agent_wait");
    const longEvidence = { ...evidence, targetGenerationRef: "target_generation_" + "x".repeat(1_000) };
    const handle = registry.register(request, async () => ({
      wait_result: "condition_met",
      matched: true,
      targets: [
        { target: "one", targetId: "p1", metadata: {}, recentUnwrappedLines: [], observedAtMs: 10, matched: true, target_evidence: longEvidence },
        { target: "two", targetId: "p2", metadata: {}, recentUnwrappedLines: [], observedAtMs: 11, matched: false, target_evidence: { ...evidence, currency: "current" } as never }
      ]
    }));
    await handle.promise;
    const projected = registry.get(handle.jobId)!;
    expect(projected.result?.targets?.[0]?.target_evidence).toMatchObject({ currency: "historical_non_current", source: "native_agent_wait" });
    expect(projected.result?.targets?.[0]?.target_evidence?.targetGenerationRef.length).toBeLessThan(1_000);
    expect(projected.truncation).toMatchObject({ resultTargetEvidence: 1, resultTargetGenerationRefsClipped: 1 });
  });

  it("maps failures and protects generation and shutdown", async () => {
    let failureId = 0;
    const registry = new JobRegistry({ idFactory: () => `job_failure_${++failureId}`, clock: { now: () => 1 } });
    const failure = registry.register(request, async () => { throw Object.assign(new Error("broken"), { code: "BROKEN", details: { safe: true } }); });
    await failure.promise;
    expect(registry.get(failure.jobId)).toMatchObject({ operation_phase: "settled", wait_result: "failed", error: { code: "BROKEN", message: "broken" } });
    const stringFailure = registry.register({ ...request, targetIds: ["p2"] }, async () => { throw "string failure"; });
    await stringFailure.promise;
    expect(registry.get(stringFailure.jobId)).toMatchObject({ operation_phase: "settled", wait_result: "failed", error: { message: "string failure" } });
    const oversizedFailure = registry.register(request, async () => { throw Object.assign(new Error("large failure"), { details: { evidence: "x".repeat(100_000) } }); });
    await oversizedFailure.promise;
    expect(registry.get(oversizedFailure.jobId)).toMatchObject({ truncation: { errorDetails: true }, error: { details: { truncated: true } } });
    expect(registry.list("settled").jobs).toEqual(expect.arrayContaining([expect.objectContaining({ wait_result: "failed", error: { code: "BROKEN", message: "broken" } }), expect.objectContaining({ wait_result: "failed", error: { message: "string failure" } })]));
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

  it("retains bounded per-target failures in a public failed result", async () => {
    const targetErrors = Array.from({ length: 7 }, (_, index) => ({
      target: `target-${index}`,
      targetId: `pane-${index}`,
      code: "CLI_PROTOCOL_ERROR",
      message: `target ${index} could not be observed`
    }));
    const registry = new JobRegistry({ idFactory: () => "job_partial_result" });
    const handle = registry.register(request, async () => {
      throw Object.assign(new Error("partial target read"), {
        code: "CLI_PROTOCOL_ERROR",
        result: { wait_result: "failed", matched: false, reason: "target_read_failed", targetErrors }
      });
    });
    await handle.promise;
    const detail = registry.get(handle.jobId)!;
    expect(detail.result).toMatchObject({ wait_result: "failed", targetErrors: targetErrors.slice(0, 6) });
    expect(detail.truncation).toMatchObject({ resultTargetErrors: 1 });
    expect(detail.error).toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
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
    expect(valid.update(cancelled.jobId, "late")).toMatchObject({ operation_phase: "accepted" });
  });

  it("handles already-terminal records when beginning a session", async () => {
    const registry = new JobRegistry({ idFactory: (() => { let id = 0; return () => `job_terminal_${++id}`; })() });
    const done = registry.register(request, async () => success);
    await done.promise;
    const next = registry.beginSession();
    expect(next.generation).toBe(1);
    expect(registry.size()).toBe(0);
  });

  it("publishes bounded semantic-review ownership independently and rejects late or wrong-kind writes", async () => {
    const gate = deferred<JobRunResult>();
    let control!: JobOperationControl;
    const registry = new JobRegistry({ idFactory: (() => { let id = 0; return () => `job_semantic_${++id}`; })() });
    const covered = Array.from({ length: 10 }, (_, index) => ({
      target: `target-${index}-${"界".repeat(100)}`,
      targetId: `pane-${index}-${"界".repeat(100)}`,
      supervisorJobId: `job_supervisor_${index}_${"x".repeat(100)}`,
    }));
    const explicit = Array.from({ length: 12 }, (_, index) => `explicit-${index}-${"界".repeat(100)}`);
    const handle = registry.register(request, async (_signal, update, operationControl) => {
      control = operationControl;
      operationControl.publishSemanticReview({
        observedAtMs: 10,
        supervisorCovered: covered,
        explicitReviewerTargetIds: explicit,
        omittedSupervisorCovered: 2,
        omittedExplicitReviewerTargetIds: 3,
      });
      update("ownership published", { oversized: "z".repeat(10_000) });
      return gate.promise;
    });
    await vi.waitFor(() => expect(control).toBeDefined());
    const projected = registry.get(handle.jobId)!;
    expect(projected.progress?.details).toMatchObject({ truncated: true });
    expect(projected.semanticReview).toMatchObject({ observedAtMs: 10 });
    expect(projected.semanticReview?.supervisorCovered.length).toBeLessThanOrEqual(6);
    expect(projected.semanticReview?.explicitReviewerTargetIds.length).toBeLessThanOrEqual(8);
    expect((projected.semanticReview?.supervisorCovered.length ?? 0) + (projected.semanticReview?.omittedSupervisorCovered ?? 0)).toBe(covered.length + 2);
    expect((projected.semanticReview?.explicitReviewerTargetIds.length ?? 0) + (projected.semanticReview?.omittedExplicitReviewerTargetIds ?? 0)).toBe(explicit.length + 3);
    expect(Buffer.byteLength(JSON.stringify(projected.semanticReview), "utf8")).toBeLessThanOrEqual(4_096);
    expect(projected.semanticReview?.supervisorCovered.every((entry) => Buffer.byteLength(entry.target, "utf8") <= 128 && Buffer.byteLength(entry.targetId, "utf8") <= 128 && Buffer.byteLength(entry.supervisorJobId, "utf8") <= 64)).toBe(true);
    expect(projected.semanticReview).not.toHaveProperty("truncated");
    expect(registry.list().jobs[0]).not.toHaveProperty("semanticReview");
    projected.semanticReview!.explicitReviewerTargetIds.push("mutated");
    expect(registry.get(handle.jobId)?.semanticReview?.explicitReviewerTargetIds).not.toContain("mutated");

    gate.resolve(success);
    await handle.promise;
    const terminalProjection = registry.get(handle.jobId)?.semanticReview;
    expect(terminalProjection).toBeDefined();
    expect(() => control.publishSemanticReview({ observedAtMs: 11, supervisorCovered: [], explicitReviewerTargetIds: [], omittedSupervisorCovered: 0, omittedExplicitReviewerTargetIds: 0 })).toThrow(/operation fence is closed/u);
    expect(registry.get(handle.jobId)?.semanticReview).toEqual(terminalProjection);

    let supervisorControl!: JobOperationControl;
    const supervisorGate = deferred<{ supervision_result: "cancelled"; reason: string }>();
    const supervisor = registry.register({
      kind: "supervisor",
      label: "supervise one",
      targets: ["one"],
      targetIds: [],
      target_generation_refs: ["target_generation_semantic"],
      child: { agentName: "one", agentKind: "pi", profileName: "worker-pi" },
      settings: { reviewCadenceMinutes: 1, reviewerModel: "luna", reviewerThinking: "max" },
    }, async (_signal, _update, operationControl) => {
      supervisorControl = operationControl;
      return supervisorGate.promise;
    });
    await vi.waitFor(() => expect(supervisorControl).toBeDefined());
    expect(() => supervisorControl.publishSemanticReview({ observedAtMs: 11, supervisorCovered: [], explicitReviewerTargetIds: [], omittedSupervisorCovered: 0, omittedExplicitReviewerTargetIds: 0 })).toThrow(/JOB_KIND_MISMATCH/u);
    supervisorGate.resolve({ supervision_result: "cancelled", reason: "test_complete" });
    await supervisor.promise;
  });

  it("bounds uncloneable and oversized progress details", async () => {
    const registry = new JobRegistry({ idFactory: () => "job_details" });
    const handle = registry.register(request, async (_signal, update) => { update("progress", () => undefined); return new Promise(() => undefined); });
    await new Promise<void>((resolve) => setImmediate(resolve));
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
    const large = truncatedRegistry.register({ ...(request as Extract<JobRequestSnapshot, { kind: "wait" }>), condition: { transcript: "x".repeat(100_000) } }, async () => new Promise<never>(() => undefined));
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
      wait_result: "condition_met",
      matched: true,
      targets: [{ target: "one", targetId: "p1", metadata: { agent_status: "done" }, recentUnwrappedLines: ["done"], outputTruncated: true, observedAtMs: 1, matched: true }]
    }));
    await handle.promise;
    const detail = registry.get(handle.jobId)!;
    expect(detail.result).toMatchObject({ wait_result: "condition_met", targets: [{ outputTruncated: true }] });
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
    const handle = registry.register({ ...request, targets: targets.map((target) => target.target), targetIds: targets.map((target) => target.targetId) }, async () => ({ wait_result: "condition_met", matched: true, reason: "condition_met", matchedTargetCount: 1, matchedTargets: [{ target: "target-7", targetId: "p7" }], targets }));
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
    const handle = registry.register({ ...request, targets: targets.map((target) => target.target), targetIds: targets.map((target) => target.targetId) }, async () => ({ wait_result: "condition_met", matched: true, targets }));
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
      wait_result: "condition_met",
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
      kind: "wait",
      operation_phase: "settled",
      wait_result: "cancelled",
      sequence: 1,
      createdAtMs: 1,
      request,
      progress: { text: "progress", atMs: 1, details: { evidence: "e".repeat(100_000) } },
      result: {
        wait_result: "timed_out",
        matched: false,
        targets: [{ target: "target", targetId: "p1", metadata: { evidence: "m".repeat(100_000) }, recentUnwrappedLines: ["line"], observedAtMs: 1, matched: false }],
        reviewerSummaries: [{ target: "target", targetId: "p1", classification: "blocked", summary: "review" }]
      },
      cancelReason: "cancelled",
      truncation: { padding: "x".repeat(100_000) } as unknown as JobDetail["truncation"]
    });
    expect(detail.operation_phase).toBe("settled");
    expect(detail.wait_result).toBe("cancelled");
    expect(detail.truncation).toMatchObject({ jobIdClipped: true, resultTargetMetadata: 1 });
    expect(Buffer.byteLength(jobDetailContent(detail), "utf8")).toBeLessThan(50_000);
    expect(() => JSON.parse(jobDetailContent(detail))).not.toThrow();
    const forced = publicDetail({ ...detail, progress: { text: "p".repeat(10_000), atMs: 1, details: { evidence: "e" } } }, 1);
    expect(forced.truncation).toMatchObject({ publicEvidenceOmitted: true, progressTextClipped: true });
    const manyMatches = publicDetail({
      jobId: "job_many_matches", kind: "wait" as const,
      operation_phase: "settled",
      wait_result: "condition_met",
      sequence: 1,
      createdAtMs: 1,
      request,
      result: { wait_result: "condition_met", matched: true, targets: Array.from({ length: 7 }, (_, index) => ({ target: `target-${index}`, targetId: `p${index}`, metadata: {}, recentUnwrappedLines: [], observedAtMs: index, matched: true })) }
    });
    expect(manyMatches.truncation).toMatchObject({ resultMatchedTargets: 1 });

    const lateProjection = publicDetail({ jobId: "job_late_projection", kind: "wait" as const, operation_phase: "settled", wait_result: "unknown", sequence: 1, createdAtMs: 1, request, late_settlement_observed: { kind: "fulfilled", observedAtMs: 2 } });
    expect(lateProjection).toMatchObject({ late_settlement_observed: { kind: "fulfilled", observedAtMs: 2 } });
    const invalidProjection = publicDetail({ jobId: "job_invalid", kind: "wait" as const, operation_phase: "running", sequence: 1, createdAtMs: 1, request, truncation: { bad: 1n } as unknown as JobDetail["truncation"] });
    expect(invalidProjection.truncation ?? {}).not.toHaveProperty("bad");
    expect(fitsPublic(1n)).toBe(false);
    const malformedCondition = publicDetail({ jobId: "job_condition", kind: "wait" as const, operation_phase: "running", sequence: 1, createdAtMs: 1, request: { ...(request as Extract<JobRequestSnapshot, { kind: "wait" }>), condition: (() => undefined) as unknown as Extract<JobRequestSnapshot, { kind: "wait" }>["condition"] } });
    expect(malformedCondition.truncation).toMatchObject({ requestCondition: true });
    const clippedCondition = publicDetail({ jobId: "job_condition_clip", kind: "wait" as const, operation_phase: "running", sequence: 1, createdAtMs: 1, request: { ...(request as Extract<JobRequestSnapshot, { kind: "wait" }>), condition: { kind: "output", match: { kind: "literal", value: "x".repeat(10_000) } } } });
    expect(clippedCondition.truncation).toMatchObject({ requestCondition: true, requestConditionClipped: true });
    const unclippedCondition = publicDetail({ jobId: "job_condition_extra", kind: "wait" as const, operation_phase: "running", sequence: 1, createdAtMs: 1, request: { ...(request as Extract<JobRequestSnapshot, { kind: "wait" }>), condition: { kind: "output", match: { kind: "literal", value: "short" }, extra: "x".repeat(10_000) } as unknown as Extract<JobRequestSnapshot, { kind: "wait" }>["condition"] } });
    expect(unclippedCondition.truncation).toMatchObject({ requestCondition: true });
    expect(unclippedCondition.truncation?.requestConditionClipped).toBeUndefined();
    const clippedError = publicDetail({ jobId: "job_error", kind: "wait" as const, operation_phase: "settled", wait_result: "failed", sequence: 1, createdAtMs: 1, request, error: { code: "c".repeat(2_000), message: "m".repeat(2_000) } });
    expect(clippedError.truncation).toMatchObject({ errorCodeClipped: true, errorMessageClipped: true });

    const lateCompacted = publicDetail({
      jobId: "job_late_compact", kind: "wait" as const,
      operation_phase: "settled",
      wait_result: "unknown",
      sequence: 1,
      createdAtMs: 1,
      request,
      late_settlement_observed: { kind: "fulfilled", observedAtMs: 2 },
      result: { wait_result: "unknown", matched: false, targets: [{ target: "target", targetId: "p1", metadata: { evidence: "x" }, recentUnwrappedLines: ["line"], observedAtMs: 1, matched: false }] }
    }, 1);
    expect(lateCompacted).toMatchObject({ late_settlement_observed: { kind: "fulfilled" } });
    const compacted = publicDetail({
      jobId: "job_compact", kind: "wait" as const,
      operation_phase: "settled",
      wait_result: "condition_met",
      sequence: 1,
      createdAtMs: 1,
      request,
      progress: { text: "progress", atMs: 1, details: { evidence: "x" } },
      result: { wait_result: "condition_met", matched: true, targets: [{ target: "target", targetId: "p1", metadata: {}, recentUnwrappedLines: ["line"], observedAtMs: 1, matched: true }], reviewerSummaries: [{ target: "target", targetId: "p1", classification: "blocked", summary: "review" }] }
    }, 1);
    expect(compacted.truncation).toMatchObject({ publicEvidenceOmitted: true });
    const minimalWithMatch = publicDetail({
      jobId: "job_compact_match", kind: "wait" as const,
      operation_phase: "settled",
      wait_result: "cancelled",
      sequence: 1,
      createdAtMs: 1,
      startedAtMs: 1,
      finishedAtMs: 2,
      request,
      cancelReason: "cancelled",
      result: { wait_result: "condition_met", matched: true, matchedTargetCount: 2, matchedTargets: [{ target: "target", targetId: "p1" }] }
    }, 1);
    expect(minimalWithMatch.result).toMatchObject({ matchedTargetCount: 2, matchedTargets: [{ targetId: "p1" }] });
    const noResult = publicDetail({ jobId: "job_no_result", kind: "wait" as const, operation_phase: "running", sequence: 1, createdAtMs: 1, request }, 1);
    expect(noResult.result).toBeUndefined();
    const noLines = publicDetail({
      jobId: "job_no_lines", kind: "wait" as const,
      operation_phase: "settled",
      wait_result: "condition_met",
      sequence: 1,
      createdAtMs: 1,
      request,
      result: { wait_result: "condition_met", matched: true, targets: [{ target: "target", targetId: "p1", metadata: {}, recentUnwrappedLines: [], observedAtMs: 1, matched: true }] }
    }, 1);
    expect(noLines.truncation).toMatchObject({ publicEvidenceOmitted: true });
    const untouched = publicDetail({ jobId: "job_untouched", kind: "wait" as const, operation_phase: "running", sequence: 1, createdAtMs: 1, request }, 1);
    expect(untouched.operation_phase).toBe("running");

    const jobs = Array.from({ length: 100 }, (_, index) => ({
      jobId: index === 0 ? "job_" + "z".repeat(1_000) : `job_${index}`,
      label: index === 0 ? "label-" + "q".repeat(1_000) : `wait ${index}`,
      operation_phase: "running" as const,
      sequence: index,
      createdAtMs: index,
      startedAtMs: index === 0 ? index : undefined,
      finishedAtMs: index === 0 ? index : undefined,
      kind: "wait" as const,
      targetIds: [`p${index}`],
      targets: [`target-${index}`],
      ...(index === 0 ? { wait_result: "condition_met" as const, reason: "condition_met", error: { code: "CODE", message: "message" } } : index === 1 ? { error: { message: "message" } } : {}),
      ...(index === 0 ? { progress: { text: "progress", atMs: index } } : {}),
      ...(index === 0 ? { truncation: { jobIdClipped: true } } : {})
    }));
    const listed = boundedList({ jobs, total: 100, offset: 0, limit: 100, nextOffset: null, truncation: { jobs: 1, padding: "x".repeat(100_000) } as unknown as JobListResult["truncation"] });
    expect(listed.jobs).toHaveLength(100);
    expect(listed.truncation).toMatchObject({ jobs: 1, jobIdsClipped: 100 });
    expect(listed.jobs[0]).toMatchObject({ truncation: { jobIdClipped: true, labelClipped: true } });
    expect(Buffer.byteLength(JSON.stringify(listed, null, 2), "utf8")).toBeLessThan(50_000);

    const compactLabel = "a".repeat(64);
    const compactOnly = boundedList({ jobs: [{ ...jobs[2]!, label: compactLabel, targets: ["y".repeat(50_000)] }], total: 1, offset: 0, limit: 1, nextOffset: null });
    expect(compactOnly.jobs[0]?.label).not.toBe(compactLabel);
    expect(compactOnly.jobs[0]?.truncation).toMatchObject({ labelClipped: true });

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

  it("preserves bounded handoff evidence through result copy and every detail tier", async () => {
    const registry = new JobRegistry({ idFactory: () => "job_handoff_copy", clock: { now: () => 10 } });
    const result: JobRunResult = {
      wait_result: "condition_met",
      matched: true,
      reason: "condition_met",
      targets: [{ target: "one", targetId: "p1", metadata: { agent_status: "done" }, recentUnwrappedLines: ["done"], observedAtMs: 1, matched: true, handoff: { runId: "run-1", gate: "accepted", status: "done" } }]
    };
    const handle = registry.register(request, async () => result);
    await handle.promise;
    expect(registry.get(handle.jobId)?.result?.targets?.[0]?.handoff).toEqual({ runId: "run-1", gate: "accepted", status: "done" });

    const evidence = {
      gated: true as const,
      runId: "run-1",
      path: "/tmp/run-1/handoff.md",
      state: "handed_off" as const,
      validation: { state: "accepted" as const },
      artifact: { status: "done" as const, version: 2, sha256: "abc123", bytes: 42 },
      repair: { attempts: 1, fenceVersion: 0 }
    };
    const base: JobDetail = { jobId: "job_hf", kind: "supervisor", operation_phase: "settled", supervision_result: "released", sequence: 1, createdAtMs: 1, request: provisionalRequest, handoff: evidence };
    expect(publicDetail(base).handoff).toEqual(evidence);
    // Forcing every tier below the bound runs compact then minimal; the
    // bounded block survives both instead of being silently stripped.
    const bulky: JobDetail = { ...base, progress: { text: "progress", atMs: 1, details: { evidence: "e".repeat(100_000) } } };
    const degraded = publicDetail(bulky, 1);
    expect(degraded.truncation).toMatchObject({ publicEvidenceOmitted: true });
    expect(degraded.handoff).toEqual(evidence);
    // The explicit ungated reason projects through unchanged.
    expect(publicDetail({ ...base, handoff: { gated: false as const, reason: "no_managed_run" as const } }).handoff).toEqual({ gated: false, reason: "no_managed_run" });
    // Malformed evidence is omitted and counted, never projected.
    const malformed = publicDetail({ ...base, handoff: { gated: true, runId: 7 } as unknown as JobDetail["handoff"] });
    expect(malformed.handoff).toBeUndefined();
    expect(malformed.truncation).toMatchObject({ handoffEvidence: 1 });
    // No secret material ever reaches the projection.
    expect(JSON.stringify(publicDetail(base).handoff)).not.toContain("token");
  });

  it("requires a live matching installed supervisor before publishing a binding", async () => {
    let id = 0;
    const registry = new JobRegistry({ idFactory: () => `job_publication_${++id}`, quiescenceMs: 0 });
    const pending = async () => new Promise<never>(() => undefined);
    const common = {
      monitor: { connected: true, degraded: false, generation: 1, evidenceGaps: 0 },
      reviewer: { model: "typesafe/jev-latest", thinking: "max" as const, cadenceMinutes: 5, degraded: false, reviews: [], truncatedReviews: 0 },
      transitions: [],
      truncatedTransitions: 0,
      events: [],
      truncatedEvents: 0,
      unobservedEvents: 0,
    };
    const port = (installed: SupervisionJobView, live = true): SupervisionJobPort => ({
      view: () => installed,
      takePendingEvents: () => [],
      childLive: () => live,
      shutdown: () => undefined,
    });

    const closed = registry.register(provisionalRequest, pending);
    await vi.waitFor(() => expect(registry.get(closed.jobId)?.operation_phase).toBe("running"));
    const closedPublication = registry.prepareProvisionalSupervisionChildBinding(closed.jobId, { agentKind: "agy", profileName: "researcher-agy" });
    closedPublication.commit();
    await registry.cancel(closed.jobId);
    expect(() => closedPublication.publish()).toThrow(/SUPERVISION_BINDING_CLOSED/u);

    const missing = registry.register(provisionalRequest, pending);
    await vi.waitFor(() => expect(registry.get(missing.jobId)?.operation_phase).toBe("running"));
    const missingPublication = registry.prepareProvisionalSupervisionChildBinding(missing.jobId, { agentKind: "agy", profileName: "researcher-agy" });
    missingPublication.commit();
    expect(() => missingPublication.publish()).toThrow(/SUPERVISION_PUBLICATION_UNCONFIRMED/u);

    const invalid = registry.register(provisionalRequest, pending);
    await vi.waitFor(() => expect(registry.get(invalid.jobId)?.operation_phase).toBe("running"));
    registry.attachSupervision(invalid.jobId, port({ state: "reserved", ...common }, false));
    const invalidPublication = registry.prepareProvisionalSupervisionChildBinding(invalid.jobId, { agentKind: "agy", profileName: "researcher-agy" });
    invalidPublication.commit();
    expect(() => invalidPublication.publish()).toThrow(/SUPERVISION_PUBLICATION_UNCONFIRMED/u);

    const exactRequest: SupervisorJobRequestSnapshot = { ...provisionalRequest, targets: ["worker"], child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" } };
    const degraded = registry.register(exactRequest, pending);
    await vi.waitFor(() => expect(registry.get(degraded.jobId)?.operation_phase).toBe("running"));
    registry.attachSupervision(degraded.jobId, port({
      state: "degraded",
      ...common,
      child: { agentName: "worker", agentKind: "pi", paneId: "p1", terminalId: "t1", profileName: "worker-pi" },
      status: "working",
    }));
    const exactPublication = registry.prepareSupervisionChildBinding(degraded.jobId, { agentKind: "pi", profileName: "worker-pi", paneId: "p1" });
    exactPublication.commit();
    exactPublication.publish();
    registry.shutdown();
  });

  it("covers defensive provisional and exact binding transactions", async () => {
    let id = 0;
    const registry = new JobRegistry({ idFactory: () => `job_binding_${++id}`, quiescenceMs: 0 });
    const pending = async () => new Promise<never>(() => undefined);
    const register = async (jobRequest: SupervisorJobRequestSnapshot = provisionalRequest) => {
      const handle = registry.register(jobRequest, pending);
      await vi.waitFor(() => expect(registry.get(handle.jobId)?.operation_phase).toBe("running"));
      return handle;
    };
    const provisional = { agentKind: "agy" as const, profileName: "researcher-agy" };

    expect(() => registry.prepareProvisionalSupervisionChildBinding("job_missing", provisional)).toThrow(/JOB_NOT_FOUND/u);
    const wait = registry.register(request, pending);
    await vi.waitFor(() => expect(registry.get(wait.jobId)?.operation_phase).toBe("running"));
    expect(() => registry.prepareProvisionalSupervisionChildBinding(wait.jobId, provisional)).toThrow(/JOB_KIND_MISMATCH/u);

    const nonAgy = await register();
    expect(() => registry.prepareProvisionalSupervisionChildBinding(nonAgy.jobId, { agentKind: "pi", profileName: "worker-pi" })).toThrow(/SUPERVISION_PROVISIONAL_INVALID/u);
    const malformed = await register();
    expect(() => registry.prepareProvisionalSupervisionChildBinding(malformed.jobId, { agentKind: "agy", profileName: "" })).toThrow(/SUPERVISION_BINDING_INVALID/u);
    const misaligned = await register({ ...provisionalRequest, target_generation_refs: [] });
    expect(() => registry.prepareProvisionalSupervisionChildBinding(misaligned.jobId, provisional)).toThrow(/SUPERVISION_REQUEST_INVALID/u);

    const transactional = await register();
    const first = registry.prepareProvisionalSupervisionChildBinding(transactional.jobId, { agentKind: "agy", profileName: "fallback-agy" });
    const stale = registry.prepareProvisionalSupervisionChildBinding(transactional.jobId, provisional);
    stale.rollback();
    first.commit();
    expect(registry.get(transactional.jobId)?.request).toMatchObject({ child: { profileName: "fallback-agy", requestedProfileName: "researcher-agy" } });
    expect(() => first.commit()).toThrow(/SUPERVISION_ALREADY_BOUND/u);
    expect(() => stale.commit()).toThrow(/SUPERVISION_ALREADY_BOUND/u);
    expect(() => registry.prepareProvisionalSupervisionChildBinding(transactional.jobId, provisional)).toThrow(/SUPERVISION_ALREADY_BOUND/u);
    first.rollback();
    first.rollback();

    const closed = await register();
    const closedPublication = registry.prepareProvisionalSupervisionChildBinding(closed.jobId, provisional);
    await registry.cancel(closed.jobId);
    expect(() => closedPublication.commit()).toThrow(/SUPERVISION_BINDING_CLOSED/u);

    const published = await register();
    const installed: SupervisionJobView = {
      state: "provisional",
      monitor: { connected: true, degraded: false, generation: 1, evidenceGaps: 0 },
      reviewer: { model: "typesafe/jev-latest", thinking: "max", cadenceMinutes: 5, degraded: false, reviews: [], truncatedReviews: 0 },
      transitions: [], truncatedTransitions: 0, events: [], truncatedEvents: 0, unobservedEvents: 0,
      provisional: { agentName: "agy", agentKind: "agy", paneId: "p1", terminalId: "t1", profileName: "researcher-agy", baseline: { state: "idle", stateChangeSeq: 1, revision: 1 } },
    };
    registry.attachSupervision(published.jobId, { view: () => installed, takePendingEvents: () => [], childLive: () => true, shutdown: () => undefined });
    const publishedPublication = registry.prepareProvisionalSupervisionChildBinding(published.jobId, provisional);
    publishedPublication.commit();
    publishedPublication.publish();
    publishedPublication.publish();

    const invalidStrengthening = await register();
    expect(() => registry.prepareSupervisionStrengthening(invalidStrengthening.jobId, { agentKind: "agy", profileName: "researcher-agy", paneId: "p1" })).toThrow(/SUPERVISION_STRENGTHENING_INVALID/u);
    const unavailable = await register();
    registry.prepareProvisionalSupervisionChildBinding(unavailable.jobId, provisional).commit();
    expect(() => registry.prepareSupervisionStrengthening(unavailable.jobId, { agentKind: "agy", profileName: "researcher-agy", paneId: "p1" })).toThrow(/SUPERVISION_PUBLICATION_UNCONFIRMED/u);

    const exactRequest: SupervisorJobRequestSnapshot = { ...provisionalRequest, child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" } };
    const exact = await register(exactRequest);
    const exactFirst = registry.prepareSupervisionChildBinding(exact.jobId, { agentKind: "pi", profileName: "worker-pi", paneId: "p1" });
    const exactStale = registry.prepareSupervisionChildBinding(exact.jobId, { agentKind: "pi", profileName: "worker-pi", paneId: "p1" });
    exactFirst.commit();
    expect(() => exactStale.commit()).toThrow(/SUPERVISION_BINDING_STALE/u);
    const records = (registry as unknown as { jobs: Map<string, { supervisionBindingStage: "reserved" | "provisional" | "exact" }> }).jobs;
    records.get(exact.jobId)!.supervisionBindingStage = "reserved";
    expect(() => exactFirst.publish()).toThrow(/SUPERVISION_BINDING_STALE/u);

    const uncovered = await register({ ...exactRequest, targetIds: ["p1"] });
    expect(registry.activeSupervisorFor(provisionalIdentity)).toBeUndefined();
    expect(registry.get(uncovered.jobId)?.operation_phase).toBe("running");
    registry.shutdown();
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
    expect(registry.get(handle.jobId)).toMatchObject({ operation_phase: "settled", wait_result: "condition_met" });

    const rejected = new JobRegistry({ idFactory: () => "job_notify_async", onTerminal: async () => { throw new Error("async ui down"); } });
    const asyncHandle = rejected.register(request, async () => success);
    await expect(asyncHandle.promise).resolves.toBeUndefined();
    expect(rejected.get(asyncHandle.jobId)).toMatchObject({ operation_phase: "settled", wait_result: "condition_met" });
  });
});
