import { describe, expect, it } from "vitest";
import { JobRegistry, SupervisionActiveError } from "../../src/job-registry.js";
import { SessionEventMonitor } from "../../src/supervision/monitor.js";
import { SupervisionRegistry } from "../../src/supervision/registry.js";
import type { SupervisionStream } from "../../src/supervision/socket.js";
import type { SupervisionReviewer } from "../../src/supervision/reviewer.js";
import type { SupervisedIdentity } from "../../src/supervision/identity.js";
import type { ManagerNotifier, SupervisionWake } from "../../src/supervision/notify.js";
import { createJobsTool } from "../../src/tools/jobs.js";

const session = { source: "herdr:pi", agent: "pi", kind: "id", value: "s1" };
const identity: SupervisedIdentity = { paneId: "p1", terminalId: "t1", agentName: "worker", agentKind: "pi", agentSession: session };
const settings = { reviewCadenceMinutes: 5, reviewerModel: "luna", reviewerThinking: "low" as const };

const pane = { pane_id: "p1", terminal_id: "t1", tab_id: "tab1", workspace_id: "w1", agent_status: "working", revision: 3, agent: "pi", agent_session: session };

function snapshotResult(panes: Array<Record<string, unknown>>): unknown {
  return { type: "session_snapshot", snapshot: { version: "0.8.2", protocol: 20, workspaces: [], tabs: [], panes, agents: [{ pane_id: "p1", name: "worker" }] } };
}

/** A scripted socket peer that answers snapshots from a queue. */
function peer(results: unknown[]): { stream: SupervisionStream; push(line: string): void } {
  let onData: (chunk: Buffer) => void = () => undefined;
  const queue = [...results];
  return {
    stream: {
      write: (line) => {
        const request = JSON.parse(line) as { id: string; method: string };
        queueMicrotask(() => {
          const result = request.method === "session.snapshot" ? (queue.shift() ?? snapshotResult([pane])) : { type: "subscription_started" };
          onData(Buffer.from(`${JSON.stringify({ id: request.id, result })}\n`, "utf8"));
        });
      },
      destroy: () => undefined,
      onData: (handler) => { onData = handler; },
      onClose: () => undefined,
    },
    push: (line) => onData(Buffer.from(line, "utf8")),
  };
}

interface Fixture {
  jobs: JobRegistry;
  supervision: SupervisionRegistry;
  wakes: SupervisionWake[];
  push(line: string): void;
}

function fixture(options: { reviewer?: SupervisionReviewer; snapshots?: unknown[] } = {}): Fixture {
  const server = peer(options.snapshots ?? []);
  const jobs = new JobRegistry();
  const wakes: SupervisionWake[] = [];
  const notifier: ManagerNotifier = { wake: (wake) => { wakes.push(wake); } };
  const supervision = new SupervisionRegistry({
    jobs,
    settingsLoader: async () => settings,
    readTranscript: async () => ["line"],
    notifier,
    monitor: new SessionEventMonitor({ connect: async () => server.stream, env: { HERDR_SOCKET_PATH: "/tmp/s.sock" }, clock: { now: () => 0, sleep: async () => undefined } }),
    ...(options.reviewer ? { reviewerFactory: () => options.reviewer! } : {}),
    scheduler: { setTimer: () => "timer", clearTimer: () => undefined },
  });
  return { jobs, supervision, wakes, push: server.push };
}

describe("the supervision registry", () => {
  it("registers a supervisor job whose request records the requested child", async () => {
    const f = fixture();
    const reservation = await f.supervision.reserve({ child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" } });
    const detail = f.jobs.get(reservation.jobId)!;
    expect(detail.kind).toBe("supervisor");
    expect(detail.request).toMatchObject({
      kind: "supervisor",
      label: "supervise worker",
      targets: ["worker"],
      // No pane exists at reservation time, so no target id is back-dated into the request.
      targetIds: [],
      child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" },
      settings: { reviewerModel: "openai-codex/gpt-5.6-luna", reviewerThinking: "max", reviewCadenceMinutes: 5 },
    });
    expect(detail.request.target_generation_refs?.[0]).toMatch(/^target_generation_/u);
    f.supervision.shutdown();
  });

  it("binds, publishes a live view, and settles when the exact child goes away", async () => {
    const f = fixture({ snapshots: [snapshotResult([pane]), snapshotResult([pane]), snapshotResult([])] });
    const reservation = await f.supervision.reserve({ child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" } });
    await reservation.bind({ identity, stateChangeSeq: 2 });
    expect(f.jobs.get(reservation.jobId)).toMatchObject({ kind: "supervisor", supervision: { state: "active", status: "working", child: { paneId: "p1" } } });

    f.push(`${JSON.stringify({ event: "pane_closed", data: { type: "pane_closed", pane_id: "p1", workspace_id: "w1" } })}\n`);
    await vi_waitForSettled(f.jobs, reservation.jobId);
    expect(f.jobs.get(reservation.jobId)).toMatchObject({ operation_phase: "settled", supervision_result: "released", supervision_reason: "event:pane_closed" });
    expect(f.wakes.map((wake) => wake.event.type)).toEqual(["pane_closed"]);
    f.supervision.shutdown();
  });

  it("refuses herdr_jobs cancel while the exact child is live and allows it afterwards", async () => {
    const f = fixture({ snapshots: [snapshotResult([pane]), snapshotResult([pane]), snapshotResult([])] });
    const reservation = await f.supervision.reserve({ child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" } });
    await reservation.bind({ identity });
    const tool = createJobsTool(f.jobs);
    await expect(tool.execute("id", { operation: "cancel", jobId: reservation.jobId } as never, undefined, undefined, {} as never)).rejects.toBeInstanceOf(SupervisionActiveError);
    await expect(f.jobs.cancel(reservation.jobId)).rejects.toMatchObject({ code: "SUPERVISION_ACTIVE" });

    f.push(`${JSON.stringify({ event: "pane_closed", data: { type: "pane_closed", pane_id: "p1", workspace_id: "w1" } })}\n`);
    await vi_waitForSettled(f.jobs, reservation.jobId);
    await expect(f.jobs.cancel(reservation.jobId)).resolves.toMatchObject({ operation_phase: "settled" });
    f.supervision.shutdown();
  });

  it("returns soft receipts through herdr_jobs get and counts them in list", async () => {
    const f = fixture({ snapshots: [snapshotResult([pane]), snapshotResult([pane])] });
    const reservation = await f.supervision.reserve({ child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" } });
    await reservation.bind({ identity });
    f.push(`${JSON.stringify({ event: "pane_updated", data: { type: "pane_updated", pane: { ...pane, agent_status: "blocked", revision: 4 } } })}\n`);
    await vi_waitFor(() => (f.jobs.get(reservation.jobId)?.unobservedEvents ?? 0) > 0);

    expect(f.jobs.list(undefined, 0, 20, "supervisor").jobs[0]).toMatchObject({ kind: "supervisor", unobservedEvents: 1 });
    expect(f.jobs.list(undefined, 0, 20, "wait").jobs).toEqual([]);

    const tool = createJobsTool(f.jobs);
    const first = await tool.execute("id", { operation: "get", jobId: reservation.jobId } as never, undefined, undefined, {} as never);
    expect(first.details).toMatchObject({ view: "job", kind: "supervisor", unobservedEvents: 0 });
    expect((first.details as { pending_events: Array<{ type: string }> }).pending_events.map((event) => event.type)).toEqual(["blocked"]);
    const second = await tool.execute("id", { operation: "get", jobId: reservation.jobId } as never, undefined, undefined, {} as never);
    expect(second.details).not.toHaveProperty("pending_events");
    f.supervision.shutdown();
  });

  it("settles a released reservation instead of leaking its job", async () => {
    const f = fixture();
    const reservation = await f.supervision.reserve({ child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" } });
    reservation.release("launch_failed_placement");
    await vi_waitForSettled(f.jobs, reservation.jobId);
    expect(f.jobs.get(reservation.jobId)).toMatchObject({ supervision_result: "failed", supervision_reason: "launch_failed_placement" });
    f.supervision.shutdown();
  });

  it("cancels every supervisor on manager-session shutdown", async () => {
    const f = fixture({ snapshots: [snapshotResult([pane]), snapshotResult([pane])] });
    const reservation = await f.supervision.reserve({ child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" } });
    await reservation.bind({ identity });
    f.supervision.shutdown();
    await vi_waitForSettled(f.jobs, reservation.jobId);
    expect(f.jobs.get(reservation.jobId)).toMatchObject({ supervision_result: "cancelled", supervision_reason: "manager_session_shutdown" });
    f.supervision.shutdown();
  });

  it("keeps a host with no model service visibly degraded rather than silently unreviewed", async () => {
    const f = fixture();
    const reservation = await f.supervision.reserve({ child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" } });
    expect(f.jobs.get(reservation.jobId)?.supervision?.reviewer).toMatchObject({ model: "openai-codex/gpt-5.6-luna", thinking: "max", degraded: false });
    // The default reviewer for a host without a model service always fails.
    const registry = f.supervision as unknown as { reviewer(): SupervisionReviewer };
    await expect(registry.reviewer().review({ paneId: "p1", agentName: "worker", workingForMs: 0, metadata: {}, transcriptDelta: [] }, new AbortController().signal))
      .rejects.toThrow(/No supervision reviewer model service is available/u);
    f.supervision.shutdown();
  });

  it("refuses to reserve when the monitor cannot start", async () => {
    const jobs = new JobRegistry();
    const supervision = new SupervisionRegistry({
      jobs,
      settingsLoader: async () => settings,
      readTranscript: async () => [],
      monitorOptions: { env: {} },
    });
    await expect(supervision.reserve({ child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" } })).rejects.toMatchObject({ code: "SUPERVISION_SOCKET_UNAVAILABLE" });
    expect(jobs.size()).toBe(0);
    supervision.shutdown();
  });
});

async function vi_waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function vi_waitForSettled(jobs: JobRegistry, jobId: string): Promise<void> {
  await vi_waitFor(() => jobs.get(jobId)?.operation_phase === "settled");
}
