import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as HandoffModule from "../../src/handoff.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHandoffAllocator, HandoffError, HANDOFF_MAX_BYTES, readHandoffState, updateHandoffState, type HandoffAllocation, type HandoffRunIdentity } from "../../src/handoff.js";
import { createHandoffGate, handoffGateMatches, projectHandoffEvidence, HANDOFF_MAX_REPAIR_ATTEMPTS, type HandoffBoundIdentity, type HandoffRun } from "../../src/handoff-gate.js";

/**
 * The gate's own refusal taxonomy, exercised for failures the primitive can
 * raise but this test's filesystem cannot stage: an unenumerated handoff error
 * code and a non-handoff throw, on both the artifact read and the sidecar write.
 */
const handoffControl = vi.hoisted(() => ({
  readError: undefined as unknown,
  updateError: undefined as unknown,
}));

vi.mock("../../src/handoff.js", async (importOriginal) => {
  const real = await importOriginal<typeof HandoffModule>();
  return {
    ...real,
    readHandoffArtifact: async (allocation: HandoffAllocation) => {
      if (handoffControl.readError !== undefined) throw handoffControl.readError;
      return real.readHandoffArtifact(allocation);
    },
    updateHandoffState: async (allocation: HandoffAllocation, mutate: (state: never) => void) => {
      if (handoffControl.updateError !== undefined) throw handoffControl.updateError;
      return real.updateHandoffState(allocation, mutate as never);
    },
  };
});

afterEach(() => {
  handoffControl.readError = undefined;
  handoffControl.updateError = undefined;
});

const runIdentity: HandoffRunIdentity = {
  manager: { paneId: "w1:p1", display: "caller", source: "injected" },
  child: { agentName: "worker", agentKind: "pi", operatingPointId: "worker-pi", specLabel: "worker-pi", fallbackCandidates: [] }
};

/** A v2 identity carrying the recovery lineage the launch path persists. */
const runIdentityWithLineage: HandoffRunIdentity = {
  ...runIdentity,
  child: {
    ...runIdentity.child,
    route: {
      tier: "standard",
      operatingPointId: "worker-pi",
      policyRevision: "adr-037-p1",
      workload: { intent: "implement", mutation: "bounded", scope: "local", horizon: "short", verifiability: "strong", workspaceState: "clean", ambiguity: "low" }
    },
    workspace: { resolvedCwd: "/repo", worktree: "/repo/.herdr/worktrees/worker" }
  }
};

const launched: HandoffBoundIdentity = {
  paneId: "w1:p9",
  terminalId: "w1:t4",
  agentName: "worker",
  agentKind: "pi",
  agentSession: { source: "native", agent: "pi", kind: "session", value: "sess-1" },
  agentId: "agent-9"
};

async function boundRun(): Promise<{ run: HandoffRun; gate: ReturnType<typeof createHandoffGate> }> {
  const dir = await mkdtemp(join(tmpdir(), "herdr-handoff-gate-"));
  await chmod(dir, 0o700);
  const allocator = createHandoffAllocator({ namespace: { dir, endpoint: "test-endpoint" } });
  const allocation = await allocator.allocate();
  await allocator.persist(allocation, runIdentity);
  const gate = createHandoffGate();
  const run = await gate.bind(allocation, launched, { stateChangeSeq: 3, revision: 1 });
  return { run, gate };
}

const artifact = (run: HandoffAllocation | HandoffRun, status = "done", summary = "Implemented the change.") => writeFile(
  "allocation" in run ? run.allocation.artifactPath : run.artifactPath,
  `${"allocation" in run ? run.allocation.marker : run.marker}

## Status
${status}

## Summary
${summary}

## Changes
- src/a.ts

## Verification
npm test passed.

## Blockers
None

## Continuation
None
`,
  { mode: 0o600 }
);

describe("handoff gate binding", () => {
  it("persists the exact launched identity under the flock before lookup can see the run", async () => {
    const { run, gate } = await boundRun();
    const state = await readHandoffState(run.allocation);
    expect(state.child).toMatchObject({ paneId: "w1:p9", terminalId: "w1:t4", agentId: "agent-9" });
    expect(state.nativeSession).toEqual(launched.agentSession);
    expect(state.lifecycle).toMatchObject({ state: "awaiting_handoff", watermark: { stateChangeSeq: 3, revision: 1 } });
    expect(gate.lookup(launched)).toBe(run);
    expect(run.lifecycle).toBe("awaiting_handoff");
    expect(run.cycleOpen).toBe(true);
  });

  it("reserves the child agent id as null when the launched identity has none", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-handoff-gate-"));
    await chmod(dir, 0o700);
    const allocator = createHandoffAllocator({ namespace: { dir, endpoint: "test-endpoint" } });
    const allocation = await allocator.allocate();
    await allocator.persist(allocation, runIdentity);
    const withoutAgentId: HandoffBoundIdentity = {
      paneId: launched.paneId,
      terminalId: launched.terminalId,
      agentName: launched.agentName,
      agentKind: launched.agentKind,
      agentSession: launched.agentSession,
    };
    await createHandoffGate().bind(allocation, withoutAgentId);
    expect((await readHandoffState(allocation)).child.agentId).toBeNull();
  });

  it("preserves route and workspace lineage through bind and lifecycle mutations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-handoff-gate-"));
    await chmod(dir, 0o700);
    const allocator = createHandoffAllocator({ namespace: { dir, endpoint: "test-endpoint" } });
    const allocation = await allocator.allocate();
    await allocator.persist(allocation, runIdentityWithLineage);
    const gate = createHandoffGate();
    const run = await gate.bind(allocation, launched, { stateChangeSeq: 3, revision: 1 });

    const bound = await readHandoffState(allocation);
    expect(bound.child.route).toEqual(runIdentityWithLineage.child.route);
    expect(bound.child.workspace).toEqual(runIdentityWithLineage.child.workspace);
    expect(bound.child).toMatchObject({ paneId: "w1:p9", terminalId: "w1:t4", agentId: "agent-9" });

    await artifact(run, "failed");
    await gate.recordOutcome(run, "failed");
    const failed = await readHandoffState(allocation);
    expect(failed.child.route).toEqual(runIdentityWithLineage.child.route);
    expect(failed.child.workspace).toEqual(runIdentityWithLineage.child.workspace);
  });

  it("matches on move-stable identity and follows pane moves", async () => {
    const { run, gate } = await boundRun();
    // Everything the bound identity carries except the pane id.
    const moveStable = {
      terminalId: launched.terminalId,
      agentName: launched.agentName,
      agentKind: launched.agentKind,
      agentSession: launched.agentSession,
      agentId: launched.agentId,
    };
    gate.notePane(run, "w2:p1");
    // The moved pane still resolves the run; pane id is never part of the key.
    expect(gate.lookup(moveStable)).toBe(run);
    expect(run.identity.paneId).toBe("w2:p1");
    // A different native session, name, kind, or terminal never matches this run.
    expect(gate.lookup({ ...moveStable, agentSession: { ...moveStable.agentSession, value: "sess-2" } })).toBeUndefined();
    expect(gate.lookup({ ...moveStable, agentName: "other" })).toBeUndefined();
    expect(gate.lookup({ ...moveStable, terminalId: "w1:t5" })).toBeUndefined();
    gate.drop(run);
    expect(gate.lookup(moveStable)).toBeUndefined();
  });

  it("leaves the live run bound when a superseded run for the same identity is dropped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-handoff-gate-"));
    await chmod(dir, 0o700);
    const allocator = createHandoffAllocator({ namespace: { dir, endpoint: "test-endpoint" } });
    const gate = createHandoffGate();
    const bind = async (): Promise<HandoffRun> => {
      const allocation = await allocator.allocate();
      await allocator.persist(allocation, runIdentity);
      return gate.bind(allocation, launched);
    };
    const superseded = await bind();
    const live = await bind();
    gate.drop(superseded);
    expect(gate.lookup(launched)).toBe(live);
  });
});

describe("handoff gate validation", () => {
  it("reports missing, then accepts a valid current artifact once", async () => {
    const { run, gate } = await boundRun();
    expect((await gate.validate(run)).state).toBe("missing");
    await artifact(run);
    const first = await gate.validate(run);
    expect(first.state).toBe("accepted");
    expect(first.artifact).toMatchObject({ status: "done", version: 1 });
    expect(run.cycleOpen).toBe(false);
    const state = await readHandoffState(run.allocation);
    expect(state.artifact).toMatchObject({ version: 1, status: "done" });
    expect(state.artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Re-reading the accepted content without a new cycle stays accepted.
    expect((await gate.validate(run)).state).toBe("accepted");
  });

  it("marks identical content stale once a new cycle opened, then accepts new content", async () => {
    const { run, gate } = await boundRun();
    await artifact(run);
    expect((await gate.validate(run)).state).toBe("accepted");
    gate.beginCycle(run);
    expect((await gate.validate(run)).state).toBe("stale");
    await artifact(run, "done", "Follow-up work finished.");
    const second = await gate.validate(run);
    expect(second.state).toBe("accepted");
    expect(second.artifact?.version).toBe(2);
  });

  it("rejects foreign-run and malformed artifacts without accepting them", async () => {
    const { run, gate } = await boundRun();
    await writeFile(run.artifactPath, `herdr-run:bbbbbbbb-0000-0000-0000-000000000000\n\n## Status\ndone\n\n## Summary\nx\n\n## Changes\nNone\n\n## Verification\nok\n\n## Blockers\nNone\n\n## Continuation\nNone\n`, { mode: 0o600 });
    const foreign = await gate.validate(run);
    expect(foreign.state).toBe("invalid");
    expect(foreign.reason).toBe("foreign_run");
    expect(run.accepted).toBeNull();
    await writeFile(run.artifactPath, "garbage\n", { mode: 0o600 });
    expect((await gate.validate(run)).state).toBe("invalid");
  });

  it("reports unsafe artifacts as untrusted", async () => {
    const { run, gate } = await boundRun();
    await artifact(run);
    await chmod(run.artifactPath, 0o666);
    expect((await gate.validate(run)).state).toBe("untrusted");
  });

  it("reports an over-bound artifact as oversized without accepting it", async () => {
    const { run, gate } = await boundRun();
    await artifact(run, "done", "x".repeat(HANDOFF_MAX_BYTES));
    expect((await gate.validate(run)).state).toBe("oversized");
    expect(run.accepted).toBeNull();
  });

  it("maps an unenumerated handoff failure to unavailable and propagates anything else", async () => {
    const { run, gate } = await boundRun();
    handoffControl.readError = new HandoffError("HANDOFF_STORE_FAILED", "sidecar is unavailable");
    expect((await gate.validate(run)).state).toBe("unavailable");
    expect(gate.evidence(run).validation).toEqual({ state: "unavailable" });
    handoffControl.readError = new TypeError("not a handoff failure");
    await expect(gate.validate(run)).rejects.toThrowError("not a handoff failure");
  });

  it("reports unavailable when a read artifact cannot be committed, and propagates anything else", async () => {
    const { run, gate } = await boundRun();
    await artifact(run);
    handoffControl.updateError = new HandoffError("HANDOFF_STORE_FAILED", "state lock is unavailable");
    expect((await gate.validate(run)).state).toBe("unavailable");
    // A verdict that never reached the sidecar leaves the run unaccepted.
    expect(run.accepted).toBeNull();
    expect(run.cycleOpen).toBe(true);
    handoffControl.updateError = new TypeError("not a handoff failure");
    await expect(gate.validate(run)).rejects.toThrowError("not a handoff failure");
  });
});

describe("handoffGateMatches", () => {
  const accepted = (status: "done" | "blocked" | "cancelled" | "failed") => ({ state: "accepted" as const, artifact: { status, sha256: "a".repeat(64), bytes: 10, version: 1 } });
  const missing = { state: "missing" as const };

  it("gates completed on idle and done until the artifact validates", () => {
    for (const raw of ["idle", "done"]) {
      expect(handoffGateMatches(missing, "completed", raw)).toBe(false);
      expect(handoffGateMatches(accepted("done"), "completed", raw)).toBe(true);
    }
    // The gate only narrows: working never completes.
    expect(handoffGateMatches(accepted("done"), "completed", "working")).toBe(false);
  });

  it("gates terminal on every terminal outcome with a corresponding status", () => {
    expect(handoffGateMatches(missing, "terminal", "done")).toBe(false);
    expect(handoffGateMatches(missing, "terminal", "blocked")).toBe(false);
    expect(handoffGateMatches(accepted("done"), "terminal", "done")).toBe(true);
    expect(handoffGateMatches(accepted("failed"), "terminal", "idle")).toBe(true);
    expect(handoffGateMatches(accepted("blocked"), "terminal", "blocked")).toBe(true);
    // Non-corresponding statuses never match.
    expect(handoffGateMatches(accepted("blocked"), "terminal", "done")).toBe(false);
    expect(handoffGateMatches(accepted("done"), "terminal", "blocked")).toBe(false);
    expect(handoffGateMatches(accepted("done"), "terminal", "working")).toBe(false);
  });
});

describe("handoff gate repair and outcomes", () => {
  it("persists the repair attempt and fence before granting the send", async () => {
    const { run, gate } = await boundRun();
    const fence = await gate.beginRepair(run);
    expect(fence).toMatchObject({ version: 0 });
    const state = await readHandoffState(run.allocation);
    expect(state.repair).toEqual({ attempts: 1, fence: { version: 0, token: fence!.token } });
    // Idempotent for the same artifact version: no second send is fenced.
    expect(await gate.beginRepair(run)).toBeNull();
    expect((await readHandoffState(run.allocation)).repair.attempts).toBe(1);
  });

  it("allows one fence per new artifact version and caps total attempts", async () => {
    const { run, gate } = await boundRun();
    expect(await gate.beginRepair(run)).not.toBeNull();
    for (let version = 1; version < HANDOFF_MAX_REPAIR_ATTEMPTS; version += 1) {
      await artifact(run, "done", `rewrite ${version}`);
      expect((await gate.validate(run)).state).toBe("accepted");
      expect(await gate.beginRepair(run)).not.toBeNull();
      expect(await gate.beginRepair(run)).toBeNull();
    }
    await artifact(run, "done", "rewrite final");
    await gate.validate(run);
    expect(await gate.beginRepair(run)).toBeNull();
    expect((await readHandoffState(run.allocation)).repair.attempts).toBe(HANDOFF_MAX_REPAIR_ATTEMPTS);
  });

  it("persists runtime-authored outcomes before they are observable", async () => {
    const { run, gate } = await boundRun();
    await gate.recordOutcome(run, "failed", "agent_absent");
    const state = await readHandoffState(run.allocation);
    expect(state.lifecycle).toMatchObject({ state: "failed", detail: "agent_absent" });
    expect(gate.evidence(run)).toMatchObject({ runId: run.runId, state: "failed" });
  });

  it("marks unresolved runs recovery_pending on shutdown and leaves resolved ones", async () => {
    const { run, gate } = await boundRun();
    const { run: settled } = await boundRun();
    await artifact(settled);
    await gate.validate(settled);
    await gate.recordOutcome(settled, "handed_off");
    await gate.shutdown();
    expect((await readHandoffState(run.allocation)).lifecycle).toMatchObject({ state: "recovery_pending", detail: "manager_session_shutdown" });
    expect((await readHandoffState(settled.allocation)).lifecycle.state).toBe("handed_off");
  });

  it("projects bounded evidence with accepted artifact and repair ledger", async () => {
    const { run, gate } = await boundRun();
    await artifact(run, "blocked");
    await gate.beginRepair(run);
    await gate.validate(run);
    const evidence = gate.evidence(run);
    expect(evidence.runId).toBe(run.runId);
    expect(evidence.path).toBe(run.artifactPath);
    expect(evidence.state).toBe("awaiting_handoff");
    expect(evidence.validation).toEqual({ state: "accepted" });
    expect(evidence.artifact).toMatchObject({ status: "blocked", version: 1, bytes: expect.any(Number), sha256: expect.any(String) });
    // The fenced artifact version is projected; the secret token never is.
    expect(evidence.repair).toEqual({ attempts: 1, fenceVersion: 0 });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain(run.allocation.marker);
    expect(serialized).not.toContain("## Summary");
  });

  it("retains the latest validation verdict in evidence, including stale", async () => {
    const { run, gate } = await boundRun();
    await artifact(run);
    expect((await gate.validate(run)).state).toBe("accepted");
    gate.beginCycle(run);
    expect((await gate.validate(run)).state).toBe("stale");
    expect(gate.evidence(run).validation).toEqual({ state: "stale" });
  });

  it("projects a sidecar that carries a digest without bytes, status, or a fence", async () => {
    const { run, gate } = await boundRun();
    // A sidecar committed by another host may hold a digest whose optional
    // companions are absent; the projection drops each one independently.
    await updateHandoffState(run.allocation, (state) => {
      state.artifact.sha256 = "a".repeat(64);
      state.artifact.bytes = null;
      state.artifact.version = 2;
      delete state.artifact.status;
      state.repair = { attempts: 3, fence: null };
    });
    await gate.recordOutcome(run, "recovery_pending");
    const evidence = gate.evidence(run);
    expect(evidence).toMatchObject({ state: "recovery_pending", artifact: { version: 2, sha256: "a".repeat(64), bytes: 0 }, repair: { attempts: 3 } });
    expect(evidence.artifact).not.toHaveProperty("status");
    expect(evidence.repair).not.toHaveProperty("fenceVersion");
  });

  it("never lets an unwritable sidecar block shutdown", async () => {
    const { run, gate } = await boundRun();
    handoffControl.updateError = new HandoffError("HANDOFF_STORE_FAILED", "sidecar is unavailable");
    await expect(gate.shutdown()).resolves.toBeUndefined();
    handoffControl.updateError = undefined;
    expect((await readHandoffState(run.allocation)).lifecycle.state).toBe("awaiting_handoff");
  });

  it("projects exact bound runs or the explicit reason a surface is ungated", async () => {
    const { run, gate } = await boundRun();
    expect(projectHandoffEvidence(undefined, launched)).toEqual({ gated: false, reason: "gate_unavailable" });
    expect(projectHandoffEvidence(gate, undefined)).toEqual({ gated: false, reason: "identity_unavailable" });
    expect(projectHandoffEvidence(gate, undefined, "identity_changed")).toEqual({ gated: false, reason: "identity_changed" });
    expect(projectHandoffEvidence(gate, { terminalId: launched.terminalId, agentName: launched.agentName, agentKind: launched.agentKind, agentSession: { source: "other", agent: "pi", kind: "session", value: "foreign" } }))
      .toEqual({ gated: false, reason: "no_managed_run" });
    expect(projectHandoffEvidence(gate, launched)).toMatchObject({ gated: true, runId: run.runId, path: run.artifactPath, state: "awaiting_handoff" });
  });
});
