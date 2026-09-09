import { describe, expect, it, vi } from "vitest";
import {
  boundedSemanticReview,
  JobRegistry,
  publicDetail,
  type JobRequestSnapshot,
  type SupervisorJobRequestSnapshot,
} from "../../src/job-registry.js";
import { classifySnapshotTarget } from "../../src/supervision/identity.js";
import type { SupervisionJobPort, SupervisionJobView } from "../../src/supervision/state.js";
import type { HerdrSnapshot } from "../../src/targets.js";

const waitRequest: JobRequestSnapshot = {
  kind: "wait",
  label: "wait",
  targets: ["worker"],
  targetIds: ["p1"],
  match: "any",
  condition: { kind: "state", state: "done" },
  timeoutMs: 1_000,
  settings: { reviewCadenceMinutes: 1, reviewerModel: "luna", reviewerThinking: "low" },
};

const supervisorRequest: SupervisorJobRequestSnapshot = {
  kind: "supervisor",
  label: "supervise worker",
  targets: ["worker"],
  targetIds: [],
  target_generation_refs: ["generation-1"],
  child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" },
  settings: { reviewCadenceMinutes: 5, reviewerModel: "openai-codex/gpt-5.6-luna", reviewerThinking: "max" },
};

const session = { source: "pi", agent: "pi", kind: "id", value: "session-1" };

function snapshot(panes: Record<string, unknown>[], agents: Record<string, unknown>[]): HerdrSnapshot {
  return { version: "1", protocol: 22, workspaces: [], tabs: [], panes, agents } as unknown as HerdrSnapshot;
}

function pane(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pane_id: "p1",
    terminal_id: "t1",
    tab_id: "tab1",
    workspace_id: "w1",
    agent_status: "working",
    revision: 1,
    agent: "pi",
    agent_session: session,
    ...overrides,
  };
}

function installedView(request: SupervisorJobRequestSnapshot): SupervisionJobView {
  return {
    state: "active",
    monitor: { connected: true, degraded: false, generation: 1, evidenceGaps: 0 },
    reviewer: { model: "openai-codex/gpt-5.6-luna", thinking: "max", cadenceMinutes: 5, degraded: false, reviews: [], truncatedReviews: 0 },
    transitions: [],
    truncatedTransitions: 0,
    events: [],
    truncatedEvents: 0,
    unobservedEvents: 0,
    child: { agentName: request.child.agentName, agentKind: request.child.agentKind, paneId: "p1", terminalId: "t1", profileName: request.child.profileName },
    status: "working",
  };
}

async function runningSupervisor(registry: JobRegistry, request: SupervisorJobRequestSnapshot = supervisorRequest): Promise<string> {
  const handle = registry.register(request, async () => new Promise<never>(() => undefined));
  registry.attachSupervision(handle.jobId, {
    view: () => installedView(request),
    takePendingEvents: () => [],
    childLive: () => true,
    shutdown: () => undefined,
  } satisfies SupervisionJobPort);
  await vi.waitFor(() => expect(registry.get(handle.jobId)?.operation_phase).toBe("running"));
  return handle.jobId;
}

describe("coverage contract edges", () => {
  it("rejects malformed ownership and bounds both projection tails", () => {
    const base = { observedAtMs: 0, supervisorCovered: [], explicitReviewerTargetIds: [], omittedSupervisorCovered: 0, omittedExplicitReviewerTargetIds: 0 };
    expect(() => boundedSemanticReview({ ...base, observedAtMs: -1 } as never)).toThrow(/SEMANTIC_REVIEW_INVALID/u);
    expect(() => boundedSemanticReview({ ...base, supervisorCovered: [null] } as never)).toThrow(/SEMANTIC_REVIEW_INVALID/u);
    expect(boundedSemanticReview({ ...base, omittedSupervisorCovered: -1, omittedExplicitReviewerTargetIds: 1.5 }).omittedSupervisorCovered).toBe(0);

    const stringify = vi.spyOn(JSON, "stringify").mockReturnValue("x".repeat(5_000));
    let coveredTail;
    let explicitTail;
    try {
      coveredTail = boundedSemanticReview({
        ...base,
        supervisorCovered: [{ target: "target", targetId: "pane", supervisorJobId: "job" }],
      });
      explicitTail = boundedSemanticReview({ ...base, explicitReviewerTargetIds: ["target"] });
    } finally {
      stringify.mockRestore();
    }
    expect(coveredTail).toMatchObject({ supervisorCovered: [], explicitReviewerTargetIds: [], omittedSupervisorCovered: 1 });
    expect(explicitTail).toMatchObject({ supervisorCovered: [], explicitReviewerTargetIds: [], omittedExplicitReviewerTargetIds: 1 });
  });

  it("keeps semantic ownership in the minimal public detail", () => {
    const semanticReview = { observedAtMs: 0, supervisorCovered: [], explicitReviewerTargetIds: [], omittedSupervisorCovered: 0, omittedExplicitReviewerTargetIds: 0 };
    const compact = publicDetail({
      jobId: "job_minimal",
      kind: "wait",
      operation_phase: "running",
      sequence: 1,
      createdAtMs: 0,
      request: waitRequest,
      semanticReview,
    } as never, 1);
    expect(compact.semanticReview).toEqual(semanticReview);
  });

  it("covers every supervised binding publication fence", async () => {
    const registry = new JobRegistry({ idFactory: (() => { let id = 0; return () => `job_coverage_${++id}`; })() });
    const malformed = await runningSupervisor(registry);
    expect(() => registry.prepareSupervisionChildBinding(malformed, { agentKind: "pi", profileName: "worker-pi", paneId: "bad\nid" })).toThrow(/SUPERVISION_BINDING_INVALID/u);

    const misaligned = await runningSupervisor(registry, { ...supervisorRequest, targets: [], target_generation_refs: [] });
    expect(() => registry.prepareSupervisionChildBinding(misaligned, { agentKind: "pi", profileName: "worker-pi", paneId: "p1" })).toThrow(/SUPERVISION_REQUEST_INVALID/u);

    const jobId = await runningSupervisor(registry);
    const publication = registry.prepareSupervisionChildBinding(jobId, { agentKind: "pi", profileName: "worker-pi", paneId: "p1" });
    expect(() => publication.publish()).toThrow(/SUPERVISION_BINDING_UNCOMMITTED/u);
    publication.commit();
    expect(() => publication.commit()).toThrow(/SUPERVISION_ALREADY_BOUND/u);
    publication.rollback();
    publication.commit();
    publication.publish();
    publication.publish();
    publication.rollback();

    const closed = await runningSupervisor(registry);
    const closedPublication = registry.prepareSupervisionChildBinding(closed, { agentKind: "pi", profileName: "worker-pi", paneId: "p2" });
    registry.shutdown();
    expect(() => closedPublication.commit()).toThrow(/SUPERVISION_BINDING_CLOSED/u);
  });

  it("classifies orphan, malformed, named, and nameless target evidence", () => {
    expect(classifySnapshotTarget(snapshot([], [{ pane_id: "p1" }, { pane_id: "p1" }]), "p1")).toEqual({ kind: "invalid", reason: "duplicate_target_agent" });
    expect(classifySnapshotTarget(snapshot([], [{ pane_id: "p1" }]), "p1")).toEqual({ kind: "invalid", reason: "orphan_target_agent" });
    expect(classifySnapshotTarget(snapshot([pane({ agent_name: "worker" })], []), "p1")).toMatchObject({ kind: "unique", occupant: { agentPresent: false, agentName: "worker" } });
    expect(classifySnapshotTarget(snapshot([pane()], [{ pane_id: "p1", agent_name: "worker", agent: "pi", agent_session: session }]), "p1")).toMatchObject({ kind: "unique", occupant: { agentName: "worker" } });
    expect(classifySnapshotTarget(snapshot([pane()], [{ pane_id: "p1", agent: "pi", agent_session: "malformed" }]), "p1")).toEqual({ kind: "invalid", reason: "target_record_malformed" });
    expect(classifySnapshotTarget(snapshot([pane()], [{ pane_id: "p1", agent: "pi", agent_session: { source: "pi" } }]), "p1")).toEqual({ kind: "invalid", reason: "target_record_malformed" });
    expect(classifySnapshotTarget(snapshot([pane()], [{ pane_id: "p1", agent: "pi", agent_session: session }]), "p1")).toMatchObject({ kind: "unique", occupant: { agentPresent: true } });
  });
});
