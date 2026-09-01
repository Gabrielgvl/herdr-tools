import { describe, expect, it, vi } from "vitest";
import { JobRegistry, publicDetail, type JobDetail, type SupervisorJobRequestSnapshot } from "../../src/job-registry.js";
import { SUPERVISION_MAX_EVENTS, type SupervisionEvent } from "../../src/supervision/events.js";
import type { SupervisionJobPort, SupervisionJobView } from "../../src/supervision/state.js";
import { SupervisionSocket, type SupervisionStream } from "../../src/supervision/socket.js";
import { ModelSupervisionReviewer } from "../../src/supervision/reviewer.js";

const request: SupervisorJobRequestSnapshot = {
  kind: "supervisor",
  label: "supervise worker",
  targets: ["worker"],
  targetIds: [],
  child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" },
  settings: { reviewCadenceMinutes: 5, reviewerModel: "openai-codex/gpt-5.6-luna", reviewerThinking: "max" },
};

function event(index: number, summary = `event-${index}`): SupervisionEvent {
  return { eventId: `sev_${index}`, atMs: index, type: "work_cycle_completed", priority: "normal", summary };
}

function view(overrides: Partial<SupervisionJobView> = {}): SupervisionJobView {
  return {
    state: "active",
    monitor: { connected: true, degraded: false, generation: 1, evidenceGaps: 0 },
    reviewer: { model: "openai-codex/gpt-5.6-luna", thinking: "max", cadenceMinutes: 5, degraded: false, reviews: [], truncatedReviews: 0 },
    transitions: [],
    truncatedTransitions: 0,
    events: [],
    truncatedEvents: 0,
    unobservedEvents: 0,
    ...overrides,
  };
}

function detail(overrides: Partial<JobDetail> = {}): JobDetail {
  return { jobId: "job_projection", kind: "supervisor", operation_phase: "running", sequence: 1, createdAtMs: 0, request, ...overrides };
}

describe("the public supervision projection", () => {
  it("keeps the newest bounded transitions, events, and reviews and counts what it dropped", () => {
    const projected = publicDetail(detail({
      supervision: view({
        transitions: Array.from({ length: 20 }, (_, index) => ({ atMs: index, from: "working" as const, to: "idle" as const, revision: index, source: "event" as const })),
        truncatedTransitions: 3,
        events: Array.from({ length: 20 }, (_, index) => event(index)),
        truncatedEvents: 4,
        unobservedEvents: 2,
        reviewer: { model: "openai-codex/gpt-5.6-luna", thinking: "max", cadenceMinutes: 5, degraded: true, lastReviewAtMs: 9, truncatedReviews: 1, reviews: Array.from({ length: 12 }, (_, index) => ({ atMs: index, classification: "progress" as const, summary: `r-${index}` })) },
        child: { agentName: "worker", agentKind: "pi", paneId: "p1", terminalId: "t1", profileName: "worker-pi" },
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
    expect(supervision.child).toMatchObject({ paneId: "p1" });
    expect(supervision.settledReason).toBe("event:pane_closed");
    expect(projected.pending_events).toHaveLength(1);
    expect(projected.truncation).toMatchObject({ supervisionTransitions: 12, supervisionEvents: 12, supervisionReviews: 6 });
  });

  it("clips oversized supervision fields and records that it did", () => {
    const projected = publicDetail(detail({
      supervision: view({
        events: [{ ...event(1), eventId: `sev_${"i".repeat(2_000)}`, summary: "s".repeat(2_000), details: { note: "n" } }],
        reviewer: { model: "openai-codex/gpt-5.6-luna", thinking: "max", cadenceMinutes: 5, degraded: false, truncatedReviews: 0, reviews: [{ atMs: 1, classification: "risk", summary: "r".repeat(2_000) }] },
      }),
    }));
    expect(projected.truncation?.supervisionFieldsClipped).toBe(2);

    // A clipped review with no clipped event starts the count on its own.
    const reviewOnly = publicDetail(detail({
      supervision: view({ reviewer: { model: "openai-codex/gpt-5.6-luna", thinking: "max", cadenceMinutes: 5, degraded: false, truncatedReviews: 0, reviews: [{ atMs: 1, classification: "risk", summary: "r".repeat(2_000) }] } }),
    }));
    expect(reviewOnly.truncation?.supervisionFieldsClipped).toBe(1);
    expect(projected.supervision!.events[0]!.details).toEqual({ note: "n" });
    expect(projected.supervision!.events[0]!.summary.length).toBeLessThan(2_000);
  });

  it("drops supervision evidence and pending receipts before it drops the job", () => {
    const projected = publicDetail(detail({
      supervision: view({
        transitions: [{ atMs: 1, from: "working", to: "idle", revision: 1, source: "event" }],
        events: [event(1, "e".repeat(30_000))],
        reviewer: { model: "openai-codex/gpt-5.6-luna", thinking: "max", cadenceMinutes: 5, degraded: false, truncatedReviews: 0, reviews: [{ atMs: 1, classification: "progress", summary: "r" }] },
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
    shutdown: () => undefined,
    ...overrides,
  });

  it("attaches only to an existing supervisor job", () => {
    const registry = new JobRegistry({ idFactory: (() => { let id = 0; return () => `job_${++id}`; })() });
    expect(() => registry.attachSupervision("job_missing", port())).toThrow(/JOB_NOT_FOUND/u);
    const wait = registry.register(
      { kind: "wait", label: "w", targets: ["a"], targetIds: ["p1"], match: "any", condition: {}, timeoutMs: 1, settings: { reviewCadenceMinutes: 1, reviewerModel: "luna", reviewerThinking: "low" } },
      async () => new Promise<never>(() => undefined),
    );
    expect(() => registry.attachSupervision(wait.jobId, port())).toThrow(/JOB_KIND_MISMATCH/u);
    void registry.cancel(wait.jobId);
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

  it("reports a non-Error reviewer transport rejection without losing the cause", async () => {
    const model = { id: "gpt-5.6-luna", provider: "openai-codex", api: "openai-completions" } as never;
    const reviewer = new ModelSupervisionReviewer({ resolve: async () => ({ model }) }, async () => { throw "socket hangup"; });
    await expect(reviewer.review({ paneId: "p1", agentName: "worker", workingForMs: 0, metadata: {}, transcriptDelta: [] }, new AbortController().signal))
      .rejects.toMatchObject({ details: { cause: "socket hangup" } });
  });
});
