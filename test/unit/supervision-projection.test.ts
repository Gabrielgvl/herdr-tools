import { describe, expect, it, vi } from "vitest";
import { JobRegistry, publicDetail, type JobDetail, type SupervisorJobRequestSnapshot } from "../../src/job-registry.js";
import { SUPERVISION_MAX_EVENTS, type SupervisionEvent } from "../../src/supervision/events.js";
import { isSupervisionJobView, type SupervisionJobPort, type SupervisionJobView } from "../../src/supervision/state.js";
import { SupervisionSocket, type SupervisionStream } from "../../src/supervision/socket.js";
import { TypeSafeSupervisionReviewer } from "../../src/supervision/reviewer.js";
import type { EvidenceState } from "../../src/supervision/evidence.js";

const request: SupervisorJobRequestSnapshot = {
  kind: "supervisor",
  label: "supervise worker",
  targets: ["worker"],
  targetIds: [],
  target_generation_refs: ["target_generation_projection"],
  child: { agentName: "worker", agentKind: "pi", operatingPointId: "worker-pi" },
  settings: { reviewCadenceMinutes: 5, reviewerModel: "typesafe/jev-latest", reviewerThinking: "max" },
};

function event(index: number, summary = `event-${index}`): SupervisionEvent {
  return { eventId: `sev_${index}`, atMs: index, type: "work_cycle_completed", priority: "normal", summary };
}

function view(overrides: Partial<SupervisionJobView> = {}): SupervisionJobView {
  const merged = {
    state: "active" as const,
    monitor: { connected: true, degraded: false, generation: 1, evidenceGaps: 0 },
    reviewer: { model: "typesafe/jev-latest", thinking: "max" as const, cadenceMinutes: 5, degraded: false, reviews: [], truncatedReviews: 0 },
    transitions: [],
    truncatedTransitions: 0,
    events: [],
    truncatedEvents: 0,
    unobservedEvents: 0,
    child: { agentName: "worker", agentKind: "pi", paneId: "p1", terminalId: "t1", operatingPointId: "worker-pi" },
    status: "idle" as const,
    ...overrides,
  };
  if (merged.state === "provisional") return { ...merged, child: undefined } as SupervisionJobView;
  if (merged.state === "reserved") return { ...merged, child: undefined, status: undefined } as SupervisionJobView;
  return merged as SupervisionJobView;
}

function detail(overrides: Partial<JobDetail> = {}): JobDetail {
  return { jobId: "job_projection", kind: "supervisor", operation_phase: "running", sequence: 1, createdAtMs: 0, request, ...overrides };
}

describe("the public supervision projection", () => {
  it("publishes provisional AGY evidence without native-session or exact-child claims", () => {
    const projected = publicDetail(detail({
      supervision: view({
        state: "provisional",
        provisional: {
          agentName: "worker",
          agentKind: "agy",
          paneId: "p1",
          terminalId: "t1",
          operatingPointId: "researcher-agy",
          baseline: { state: "idle", stateChangeSeq: 7, revision: 3 },
        },
        status: "idle",
      }),
    }));
    expect(projected).toMatchObject({
      operation_phase: "running",
      supervision: {
        state: "provisional",
        provisional: {
          agentName: "worker",
          agentKind: "agy",
          paneId: "p1",
          terminalId: "t1",
          operatingPointId: "researcher-agy",
          baseline: { state: "idle", stateChangeSeq: 7, revision: 3 },
        },
      },
    });
    expect(projected.supervision).not.toHaveProperty("child");
    expect(projected.supervision?.reviewer).not.toHaveProperty("thinking");
    expect(projected.request.settings).not.toHaveProperty("reviewerThinking");
    expect(JSON.stringify(projected.supervision)).not.toContain("agentSession");
  });

  it("omits malformed state evidence instead of projecting contradictory claims", () => {
    const provisional = view({
      state: "provisional",
      provisional: {
        agentName: "worker",
        agentKind: "agy",
        paneId: "p1",
        terminalId: "t1",
        operatingPointId: "researcher-agy",
        baseline: { state: "idle", stateChangeSeq: 7, revision: 3 },
      },
      status: "idle",
    });
    const exact = view({
      state: "active",
      child: { agentName: "worker", agentKind: "agy", paneId: "p1", terminalId: "t1", operatingPointId: "researcher-agy" },
      status: "idle",
    });
    const malformed = [
      { ...provisional, child: exact.child },
      { ...provisional, provisional: { ...provisional.provisional!, agentKind: "pi" } },
      { ...exact, provisional: provisional.provisional },
    ];
    for (const supervision of malformed) {
      const projected = publicDetail(detail({ supervision: supervision as unknown as SupervisionJobView }));
      expect(projected).not.toHaveProperty("supervision");
      expect(projected.truncation?.publicEvidenceOmitted).toBe(true);
    }
  });

  it("rejects malformed state evidence at every public boundary without throwing", () => {
    const active = view();
    const provisional = view({
      state: "provisional",
      provisional: {
        agentName: "worker",
        agentKind: "agy",
        paneId: "p1",
        terminalId: "t1",
        operatingPointId: "researcher-agy",
        requestedOperatingPointId: "",
        baseline: { state: "idle", stateChangeSeq: 1, revision: 1 },
      },
      status: "idle",
    });
    const malformed = [
      null,
      { state: "unknown" },
      { ...active, monitor: null },
      { ...active, reviewer: { ...active.reviewer, reviews: [null] } },
      { ...active, events: [null] },
      { ...active, settledReason: 1 },
      { ...active, child: undefined },
      provisional,
    ];
    for (const value of malformed) expect(isSupervisionJobView(value)).toBe(false);
    expect(isSupervisionJobView(new Proxy({}, { get: () => { throw new Error("unavailable"); } }))).toBe(false);
  });

  it("keeps the newest bounded transitions, events, and reviews and counts what it dropped", () => {
    const projected = publicDetail(detail({
      supervision: view({
        transitions: Array.from({ length: 20 }, (_, index) => ({ atMs: index, from: "working" as const, to: "idle" as const, revision: index, source: "event" as const })),
        truncatedTransitions: 3,
        events: Array.from({ length: 20 }, (_, index) => event(index)),
        truncatedEvents: 4,
        unobservedEvents: 2,
        reviewer: { model: "typesafe/jev-latest", thinking: "max", cadenceMinutes: 5, degraded: true, lastReviewAtMs: 9, truncatedReviews: 1, reviews: Array.from({ length: 12 }, (_, index) => ({ atMs: index, classification: "progress" as const, summary: `r-${index}` })) },
        child: { agentName: "worker", agentKind: "pi", paneId: "p1", terminalId: "t1", operatingPointId: "worker-claude", requestedOperatingPointId: "worker-pi" },
        status: "working",
        settledReason: "event:pane_closed",
      }),
      unobservedEvents: 2,
      pending_events: [event(99, "pending")],
    }));
    const supervision = projected.supervision!;
    expect(supervision.transitions).toHaveLength(8);
    expect(supervision.transitions.at(-1)!.revision).toBe(19);
    expect(supervision.truncatedTransitions).toBe(3 + 12);
    expect(supervision.events).toHaveLength(8);
    expect(supervision.truncatedEvents).toBe(4 + 12);
    expect(supervision.reviewer.reviews).toHaveLength(6);
    expect(supervision.reviewer).toMatchObject({ truncatedReviews: 1 + 6, degraded: true, lastReviewAtMs: 9 });
    // A fallback-selected profile is published beside the one that was reserved.
    expect(supervision.child).toMatchObject({ paneId: "p1", operatingPointId: "worker-claude", requestedOperatingPointId: "worker-pi" });
    expect(supervision.settledReason).toBe("event:pane_closed");
    expect(projected.pending_events).toHaveLength(1);
    expect(projected.truncation).toMatchObject({ supervisionTransitions: 12, supervisionEvents: 12, supervisionReviews: 6 });
  });

  it("clips oversized supervision fields and records that it did", () => {
    const projected = publicDetail(detail({
      supervision: view({
        events: [{ ...event(1), eventId: `sev_${"i".repeat(2_000)}`, summary: "s".repeat(2_000), details: { note: "n" } }],
        reviewer: { model: "typesafe/jev-latest", thinking: "max", cadenceMinutes: 5, degraded: false, truncatedReviews: 0, reviews: [{ atMs: 1, classification: "risk", summary: "r".repeat(2_000) }] },
      }),
    }));
    expect(projected.truncation?.supervisionFieldsClipped).toBe(2);

    // A clipped review with no clipped event starts the count on its own.
    const reviewOnly = publicDetail(detail({
      supervision: view({ reviewer: { model: "typesafe/jev-latest", thinking: "max", cadenceMinutes: 5, degraded: false, truncatedReviews: 0, reviews: [{ atMs: 1, classification: "risk", summary: "r".repeat(2_000) }] } }),
    }));
    expect(reviewOnly.truncation?.supervisionFieldsClipped).toBe(1);
    expect(projected.supervision!.events[0]!.details).toEqual({ note: "n" });
    expect(projected.supervision!.events[0]!.summary.length).toBeLessThan(2_000);

    const long = "x".repeat(2_000);
    const clippedProvisional = publicDetail(detail({ supervision: view({
      state: "provisional",
      provisional: {
        agentName: long,
        agentKind: "agy",
        paneId: long,
        terminalId: long,
        operatingPointId: long,
        requestedOperatingPointId: long,
        baseline: { state: "idle", stateChangeSeq: 1, revision: 1 },
      },
      status: undefined,
    }) }));
    expect(clippedProvisional.supervision).toMatchObject({ state: "provisional", provisional: { requestedOperatingPointId: expect.any(String) } });
    expect(clippedProvisional.supervision).not.toHaveProperty("status");
    expect(clippedProvisional.truncation?.supervisionFieldsClipped).toBe(1);

    const clippedChild = publicDetail(detail({ supervision: view({ child: {
      agentName: long,
      agentKind: long,
      paneId: long,
      terminalId: long,
      operatingPointId: long,
      requestedOperatingPointId: long,
      requestedAgentKind: long,
    } }) }));
    expect(clippedChild.truncation?.supervisionFieldsClipped).toBe(1);
  });

  it("drops supervision evidence and pending receipts before it drops the job", () => {
    const projected = publicDetail(detail({
      supervision: view({
        transitions: [{ atMs: 1, from: "working", to: "idle", revision: 1, source: "event" }],
        events: [event(1, "e".repeat(30_000))],
        reviewer: { model: "typesafe/jev-latest", thinking: "max", cadenceMinutes: 5, degraded: false, truncatedReviews: 0, reviews: [{ atMs: 1, classification: "progress", summary: "r" }] },
      }),
      pending_events: Array.from({ length: SUPERVISION_MAX_EVENTS }, (_, index) => event(index, "p".repeat(20_000))),
    }), 4_000);
    expect(projected.supervision!.events).toEqual([]);
    expect(projected.supervision!.transitions).toEqual([]);
    expect(projected.supervision!.reviewer.reviews).toEqual([]);
    expect(projected).not.toHaveProperty("pending_events");
    expect(projected.truncation).toMatchObject({ publicEvidenceOmitted: true, pendingEvents: SUPERVISION_MAX_EVENTS });
  });

  it("keeps the settled supervisor outcome and unobserved count in a minimal projection", () => {
    const projected = publicDetail(detail({
      jobId: `job_${"j".repeat(2_000)}`,
      operation_phase: "settled",
      supervision_result: "released",
      supervision_reason: "event:pane_closed",
      unobservedEvents: 2,
      progress: { text: "p".repeat(40_000), atMs: 1 },
      error: { code: "X", message: "m".repeat(40_000) },
    }), 600);
    expect(projected).toMatchObject({ kind: "supervisor", supervision_result: "released", unobservedEvents: 2, request: { kind: "supervisor", targets: [], targetIds: [] } });
    expect(projected.truncation?.publicEvidenceOmitted).toBe(true);
  });
});

describe("the registry's supervision port", () => {
  const port = (overrides: Partial<SupervisionJobPort> = {}): SupervisionJobPort => ({
    view: () => view({ unobservedEvents: 1 }),
    takePendingEvents: () => [event(1)],
    childLive: () => false,
    coversIdentity: () => false,
    shutdown: () => undefined,
    ...overrides,
  });

  it("attaches only to an existing supervisor job", () => {
    const registry = new JobRegistry({ idFactory: (() => { let id = 0; return () => `job_${++id}`; })() });
    expect(() => registry.attachSupervision("job_missing", port())).toThrow(/JOB_NOT_FOUND/u);
    const wait = registry.register(
      { kind: "wait", label: "w", targets: ["a"], targetIds: ["p1"], match: "any", condition: {}, timeoutMs: 1, settings: { reviewCadenceMinutes: 1, reviewerModel: "testmodel", reviewerThinking: "low" } },
      async () => new Promise<never>(() => undefined),
    );
    expect(() => registry.attachSupervision(wait.jobId, port())).toThrow(/JOB_KIND_MISMATCH/u);
    // Only a supervisor job has a supervised child binding transaction.
    expect(() => registry.prepareSupervisionChildBinding("job_missing", { agentKind: "pi", operatingPointId: "worker-pi", paneId: "p1" })).toThrow(/JOB_NOT_FOUND/u);
    expect(() => registry.prepareSupervisionChildBinding(wait.jobId, { agentKind: "pi", operatingPointId: "worker-pi", paneId: "p1" })).toThrow(/JOB_KIND_MISMATCH/u);
    void registry.cancel(wait.jobId);
  });

  it("publishes the selected child and exact target through one binding transaction", async () => {
    const registry = new JobRegistry({ idFactory: () => "job_bind" });
    const registered = registry.register(request, async () => new Promise<never>(() => undefined));
    await vi.waitFor(() => expect(registry.get(registered.jobId)?.operation_phase).toBe("running"));
    expect(registry.get(registered.jobId)?.request).toMatchObject({ child: { agentKind: "pi", operatingPointId: "worker-pi" }, targetIds: [] });
    let installed: SupervisionJobView = view({ child: { agentName: "worker", agentKind: "pi", paneId: "p1", terminalId: "t1", operatingPointId: "worker-pi" }, status: "idle" });
    registry.attachSupervision(registered.jobId, port({
      view: () => installed,
      childLive: () => true,
    }));

    const publication = registry.prepareSupervisionChildBinding(registered.jobId, { agentKind: "claude", operatingPointId: "worker-claude", paneId: "p1" });
    publication.commit();
    expect(() => publication.publish()).toThrow(/SUPERVISION_PUBLICATION_MISMATCH/u);
    installed = view({
      child: { agentName: "worker", agentKind: "claude", paneId: "p1", terminalId: "t1", operatingPointId: "worker-claude", requestedAgentKind: "pi", requestedOperatingPointId: "worker-pi" },
      status: "idle",
    });
    publication.publish();
    expect(registry.get(registered.jobId)?.request).toMatchObject({
      targets: ["worker"],
      targetIds: ["p1"],
      target_generation_refs: ["target_generation_projection"],
      child: { agentName: "worker", agentKind: "claude", operatingPointId: "worker-claude", requestedAgentKind: "pi", requestedOperatingPointId: "worker-pi" },
    });
    expect(() => registry.prepareSupervisionChildBinding(registered.jobId, { agentKind: "claude", operatingPointId: "worker-claude", paneId: "p1" })).toThrow(/SUPERVISION_ALREADY_BOUND/u);
    registry.shutdown();
  });

  it("requires an installed matching AGY provisional state before publishing", async () => {
    const registry = new JobRegistry({ idFactory: () => "job_agy_provisional" });
    const registered = registry.register({
      ...request,
      targets: ["agy"],
      child: { agentName: "worker", agentKind: "agy", operatingPointId: "researcher-agy" },
    }, async () => new Promise<never>(() => undefined));
    await vi.waitFor(() => expect(registry.get(registered.jobId)?.operation_phase).toBe("running"));
    let installed: SupervisionJobView = view({ child: { agentName: "worker", agentKind: "agy", paneId: "p1", terminalId: "t1", operatingPointId: "researcher-agy" }, status: "idle" });
    registry.attachSupervision(registered.jobId, port({ view: () => installed, childLive: () => true }));
    const publication = registry.prepareProvisionalSupervisionChildBinding(registered.jobId, { agentKind: "agy", operatingPointId: "researcher-agy" });
    publication.commit();
    expect(() => publication.publish()).toThrow(/SUPERVISION_PUBLICATION_MISMATCH/u);

    installed = view({
      state: "provisional",
      provisional: {
        agentName: "worker",
        agentKind: "agy",
        paneId: "p1",
        terminalId: "t1",
        operatingPointId: "researcher-agy",
        baseline: { state: "idle", stateChangeSeq: 1, revision: 1 },
      },
      status: "idle",
    });
    publication.publish();
    expect(registry.get(registered.jobId)?.supervision?.state).toBe("provisional");
    registry.shutdown();
  });

  it("does not let generic exact binding bypass AGY strengthening", async () => {
    const registry = new JobRegistry({ idFactory: () => "job_agy_strengthen" });
    const registered = registry.register({
      ...request,
      targets: ["agy"],
      child: { agentName: "worker", agentKind: "agy", operatingPointId: "researcher-agy" },
    }, async () => new Promise<never>(() => undefined));
    await vi.waitFor(() => expect(registry.get(registered.jobId)?.operation_phase).toBe("running"));
    expect(() => registry.prepareSupervisionChildBinding(registered.jobId, { agentKind: "agy", operatingPointId: "researcher-agy", paneId: "p1" }))
      .toThrow(/SUPERVISION_STRENGTHENING_REQUIRED/u);
    registry.shutdown();
  });

  it("cancels a supervisor whose child is already gone and stops it on shutdown", async () => {
    const registry = new JobRegistry({ idFactory: () => "job_gone", quiescenceMs: 0 });
    const registered = registry.register(request, async () => new Promise<never>(() => undefined));
    registry.attachSupervision(registered.jobId, port());
    await vi.waitFor(() => expect(registry.get(registered.jobId)?.operation_phase).toBe("running"));
    const cancelled = await registry.cancel(registered.jobId);
    expect(cancelled).toMatchObject({ operation_phase: "settled", supervision_result: "unknown", error: { code: "CANCELLATION_UNCERTAIN" } });
    // A second cancel of a settled supervisor is a no-op projection.
    await expect(registry.cancel(registered.jobId)).resolves.toMatchObject({ operation_phase: "settled" });

    const stopping = new JobRegistry({ idFactory: () => "job_stop" });
    const stopped = stopping.register(request, async () => new Promise<never>(() => undefined));
    let shutdownCalls = 0;
    stopping.attachSupervision(stopped.jobId, port({ shutdown: () => { shutdownCalls += 1; } }));
    stopping.shutdown();
    expect(shutdownCalls).toBe(1);
  });
});

describe("residual supervision edges", () => {
  it("ignores a socket line for an event kind supervision does not subscribe to", () => {
    let onData: (chunk: Buffer) => void = () => undefined;
    const stream: SupervisionStream = { write: () => undefined, destroy: () => undefined, onData: (handler) => { onData = handler; }, onClose: () => undefined };
    const socket = new SupervisionSocket(stream, 1_000);
    const events: unknown[] = [];
    socket.onEvent((value) => events.push(value));
    onData(Buffer.from(`${JSON.stringify({ event: "layout_updated", data: { type: "layout_updated" } })}\n`, "utf8"));
    expect(events).toEqual([]);
    expect(socket.isClosed()).toBe(false);
    socket.close();
  });

  it("reports a reviewer transport rejection without losing the cause", async () => {
    const reviewer = new TypeSafeSupervisionReviewer({
      apiKey: "key",
      fetch: async () => { throw new Error("socket hangup"); },
    });
    // The transport rejection is what this test exercises; the evidence stub
    // only needs to exist (ADR-036 V2-02's mandatory slot) — `drift` is the
    // one field read before the request leaves.
    await expect(reviewer.review({ paneId: "p1", agentName: "worker", workingForMs: 0, metadata: { agentKind: "pi", status: "working", revision: 0 }, evidence: { drift: { drifted: false, fields: [] } } as unknown as EvidenceState }, new AbortController().signal))
      .rejects.toMatchObject({ details: { cause: expect.stringContaining("socket hangup") } });
  });
});
