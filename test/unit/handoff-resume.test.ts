import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EffectiveContext } from "../../src/context.js";
import { createHandoffAllocator, updateHandoffState } from "../../src/handoff.js";
import { createHandoffGate } from "../../src/handoff-gate.js";
import { resumeHandoff } from "../../src/handoff-resume.js";
import type { HerdrSnapshot } from "../../src/targets.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const session = (value: string) => ({ source: "herdr:pi", agent: "pi", kind: "path", value });
const pane = (paneId: string, value: string, terminalId: string, name: string) => ({
  pane_id: paneId,
  tab_id: "w1:t1",
  workspace_id: "w1",
  terminal_id: terminalId,
  agent: "pi",
  agent_name: name,
  agent_session: session(value),
  agent_status: "working"
});

function context(managerPane = "w1:p1", managerSession = "/sessions/manager.jsonl"): EffectiveContext {
  const panes = [
    pane(managerPane, managerSession, "term-manager", "manager"),
    pane("w1:p2", "/sessions/worker.jsonl", "term-worker", "worker")
  ];
  const resolved = { paneId: managerPane, tabId: "w1:t1", workspaceId: "w1" };
  return {
    context: resolved,
    snapshot: {
      version: "test",
      protocol: 1,
      workspaces: [{ workspace_id: "w1", label: "workspace" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "tab" }],
      panes,
      agents: panes.map((value) => ({ ...value, name: value.agent_name }))
    } as HerdrSnapshot,
    diagnostics: { injected: resolved, effective: resolved, rebound: false, attempts: 1 },
    operationIds: { current: "current", snapshot: "snapshot" }
  };
}

async function rewriteProvenance(run: { toolsDir: string }, mutate: (record: Record<string, unknown>) => void) {
  const path = join(run.toolsDir, "provenance.json");
  const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  mutate(record);
  await writeFile(path, JSON.stringify(record), { mode: 0o600 });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "herdr-handoff-resume-"));
  roots.push(root);
  const namespace = { dir: join(root, "runs"), endpoint: join(root, "socket") };
  await mkdir(namespace.dir, { mode: 0o700 });
  const allocator = createHandoffAllocator({ namespace });
  const run = await allocator.allocate();
  const caller = context();
  const task = {
    objective: "Inspect the original result",
    scope: "Observation only",
    doneWhen: ["Evidence is reported"],
    constraints: ["No replay"],
    tier: "standard" as const,
    replicas: 1
  };
  await allocator.persist(run, {
    manager: { paneId: caller.context.paneId, display: "manager", source: "agent_name" },
    child: { agentName: "worker", agentKind: "pi", operatingPointId: "fixture", specLabel: "fixture", fallbackCandidates: [] }
  }, { managerSession: session("/sessions/manager.jsonl"), task });
  const gate = createHandoffGate();
  const bound = await gate.bind(run, {
    paneId: "w1:p2",
    terminalId: "term-worker",
    agentName: "worker",
    agentKind: "pi",
    agentSession: session("/sessions/worker.jsonl")
  });
  await gate.recordOutcome(bound, "recovery_pending");
  await writeFile(run.artifactPath, `${run.marker}\n\n## Status\ndone\n\n## Summary\nObserved result\n\n## Changes\nNone\n\n## Verification\nFixture\n\n## Blockers\nNone\n\n## Continuation\nNone\n`, { mode: 0o600 });
  return { run, caller, task };
}

describe("read-only handoff recovery", () => {
  it("observes the same-session run without replay, takeover, or supervision claims", async () => {
    const { run, caller, task } = await fixture();
    await expect(resumeHandoff(run, caller)).resolves.toMatchObject({
      runId: run.runId,
      task,
      lifecycle: "recovery_pending",
      currentChild: {
        presence: "present",
        paneId: "w1:p2",
        terminalId: "term-worker",
        agentName: "worker",
        agentKind: "pi",
        agentSession: session("/sessions/worker.jsonl"),
        state: "working"
      },
      observationOnly: true,
      supervisionRestored: false,
      replayed: false,
      ownershipTransferred: false
    });
  });

  it("refuses a missing, different, or duplicate native manager session", async () => {
    const missing = await fixture();
    delete missing.caller.snapshot.panes[0]!.agent_session;
    delete missing.caller.snapshot.agents[0]!.agent_session;
    await expect(resumeHandoff(missing.run, missing.caller)).rejects.toMatchObject({ code: "MANAGER_SESSION_UNAVAILABLE" });

    const { run } = await fixture();
    await expect(resumeHandoff(run, context("w1:p1", "/sessions/other.jsonl"))).rejects.toMatchObject({ code: "HANDOFF_OWNER_MISMATCH" });
    const duplicate = context();
    const extra = pane("w1:p9", "/sessions/manager.jsonl", "term-manager-2", "manager-copy");
    duplicate.snapshot.panes.push(extra);
    duplicate.snapshot.agents.push({ ...extra, name: extra.agent_name });
    await expect(resumeHandoff(run, duplicate)).rejects.toMatchObject({
      code: "CONTEXT_UNAVAILABLE",
      details: { reason: "manager_session_ambiguous" }
    });
  });

  it("refuses missing native provenance and unbound or ambiguous children", async () => {
    const legacy = await fixture();
    await rewriteProvenance(legacy.run, (record) => { (record.manager as Record<string, unknown>).session = null; });
    await expect(resumeHandoff(legacy.run, legacy.caller)).rejects.toMatchObject({ code: "HANDOFF_PROVENANCE_MISSING" });

    const unbound = await fixture();
    await updateHandoffState(unbound.run, (state) => { state.child.terminalId = null; });
    await expect(resumeHandoff(unbound.run, unbound.caller)).rejects.toMatchObject({ code: "HANDOFF_CHILD_UNBOUND" });

    const ambiguous = await fixture();
    const extra = { ...ambiguous.caller.snapshot.panes[1]!, pane_id: "w1:p9" };
    ambiguous.caller.snapshot.panes.push(extra);
    ambiguous.caller.snapshot.agents.push({ ...extra, name: extra.agent_name });
    await expect(resumeHandoff(ambiguous.run, ambiguous.caller)).rejects.toMatchObject({ code: "HANDOFF_CHILD_AMBIGUOUS" });
  });

  it("tracks an exact moved child and refuses replacements or incomplete live identity", async () => {
    const moved = await fixture();
    moved.caller.snapshot.panes[1]!.pane_id = "w1:p8";
    moved.caller.snapshot.agents[1]!.pane_id = "w1:p8";
    await expect(resumeHandoff(moved.run, moved.caller)).resolves.toMatchObject({
      currentChild: {
        presence: "present",
        paneId: "w1:p8",
        terminalId: "term-worker",
        agentName: "worker",
        agentKind: "pi",
        agentSession: session("/sessions/worker.jsonl"),
        state: "working"
      }
    });
    moved.caller.snapshot.panes[1]!.agent_session = session("/sessions/replacement.jsonl");
    moved.caller.snapshot.agents[1]!.agent_session = session("/sessions/replacement.jsonl");
    await expect(resumeHandoff(moved.run, moved.caller)).rejects.toMatchObject({ code: "HANDOFF_CHILD_CHANGED" });

    const replaced = await fixture();
    replaced.caller.snapshot.panes.splice(1);
    replaced.caller.snapshot.agents.splice(1);
    const occupant = pane("w1:p2", "/sessions/replacement.jsonl", "term-replacement", "replacement");
    replaced.caller.snapshot.panes.push(occupant);
    replaced.caller.snapshot.agents.push({ ...occupant, name: occupant.agent_name });
    await expect(resumeHandoff(replaced.run, replaced.caller)).rejects.toMatchObject({ code: "HANDOFF_CHILD_CHANGED" });

    const incomplete = await fixture();
    delete incomplete.caller.snapshot.panes[1]!.agent_name;
    delete incomplete.caller.snapshot.agents[1]!.agent_name;
    delete incomplete.caller.snapshot.agents[1]!.name;
    await expect(resumeHandoff(incomplete.run, incomplete.caller)).rejects.toMatchObject({ code: "HANDOFF_CHILD_CHANGED" });
  });

  it("bounds model-visible child identity while comparing full strings", async () => {
    const { run, caller } = await fixture();
    const longName = `worker-${"w".repeat(300)}`;
    const longSession = session(`/sessions/${"s".repeat(300)}.jsonl`);
    await updateHandoffState(run, (state) => {
      state.child.agentName = longName;
      state.nativeSession = longSession;
    });
    caller.snapshot.panes[1]!.agent_name = longName;
    caller.snapshot.panes[1]!.agent_session = longSession;
    caller.snapshot.agents[1]!.agent_name = longName;
    caller.snapshot.agents[1]!.name = longName;
    caller.snapshot.agents[1]!.agent_session = longSession;

    const resumed = await resumeHandoff(run, caller);
    expect(resumed.currentChild).toMatchObject({
      presence: "present",
      agentName: longName.slice(0, 256),
      agentSession: { ...longSession, value: longSession.value.slice(0, 256) }
    });
    if (resumed.currentChild.presence !== "present") throw new Error("expected a present child");
    expect(resumed.currentChild.agentName).toHaveLength(256);
    expect(resumed.currentChild.agentSession.value).toHaveLength(256);

    // A live occupant differing only beyond the bound still refuses: ownership
    // and child comparisons run on the full identity, not the compacted output.
    caller.snapshot.panes[1]!.agent_name = `${longName}x`;
    caller.snapshot.agents[1]!.agent_name = `${longName}x`;
    caller.snapshot.agents[1]!.name = `${longName}x`;
    await expect(resumeHandoff(run, caller)).rejects.toMatchObject({ code: "HANDOFF_CHILD_CHANGED" });
  });

  it("reports an absent child without inventing completion", async () => {
    const { run, caller } = await fixture();
    caller.snapshot.panes.splice(1);
    caller.snapshot.agents.splice(1);
    await expect(resumeHandoff(run, caller)).resolves.toMatchObject({
      lifecycle: "recovery_pending",
      currentChild: { presence: "absent" },
      observationOnly: true
    });
  });

  it("refuses missing provenance, changed artifacts, and unavailable artifacts", async () => {
    const first = await fixture();
    await rm(join(first.run.toolsDir, "provenance.json"));
    await expect(resumeHandoff(first.run, first.caller)).rejects.toMatchObject({ code: "HANDOFF_STORE_FAILED" });

    const changed = await fixture();
    await updateHandoffState(changed.run, (state) => { state.artifact.sha256 = "a".repeat(64); });
    await expect(resumeHandoff(changed.run, changed.caller)).rejects.toMatchObject({ code: "HANDOFF_ARTIFACT_CHANGED" });

    const unavailable = await fixture();
    await rm(unavailable.run.artifactPath);
    await expect(resumeHandoff(unavailable.run, unavailable.caller)).rejects.toMatchObject({ code: "HANDOFF_ARTIFACT_UNAVAILABLE" });
  });
});
