import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JsonEnvelope } from "../../src/cli.js";
import type { AvailabilitySubject, Catalog, OperatingPoint, RunnerEntry, RunnerKind } from "../../src/catalog.js";
import type { LaunchTask } from "../../src/launch-schema.js";
import { createLaunchTool, type LaunchCli, type LaunchDependencies, type LaunchResult } from "../../src/tools/launch.js";
import type { TaskModelDecision } from "../../src/router.js";
import type { HerdrSnapshot } from "../../src/targets.js";
import type { AttachmentStore } from "../../src/messages/store.js";
import { createHandoffAllocator, readHandoffProvenance, readHandoffState, type HandoffAllocator } from "../../src/handoff.js";
import { availability, recordLaunchFailure } from "../../src/availability.js";
import type { SelfCloseTracker } from "../../src/supervision/self-close.js";
import type { ClaudeQuotaSignal } from "../../src/supervision/claude-quota.js";
import { stubSupervision } from "./supervision-fixtures.js";

/**
 * FU-live-5: a typed provider_limit on the initial prompt turn with provable
 * zero progress auto-closes the dead child and re-issues the task through the
 * ordinary `recoveryOf` path, which excludes the failed provider itself.
 */

const repoRoot = realpathSync(process.cwd());
const context = { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" };
const extensionContext = { cwd: repoRoot, signal: new AbortController().signal } as ExtensionContext;
const TASK: LaunchTask = { objective: "Reduce the latency without changing the public contract.", scope: "Only the assigned worktree.", doneWhen: ["The assigned objective is complete and verified."] };
const RESET_ISO = "2026-09-24T12:45:00.000Z";
const ok = (id: string, result: unknown): JsonEnvelope => ({ id, result });

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function allocator(): HandoffAllocator {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "herdr-recovery-ns-")));
  dirs.push(dir);
  return createHandoffAllocator({ namespace: { dir, endpoint: "test-endpoint" } });
}

function runnerEntry(modelIds: readonly string[]): RunnerEntry {
  return {
    kind: "pi",
    models: modelIds.map((model) => ({ model, supportedReasoning: ["low" as const] })),
    quota: { provider: "test-provider", billingProduct: "test-product", account: "test-account", scope: "project" },
    defaults: { timeoutMinutes: 30, sessionPersistence: false, thinking: "low" },
    plumbing: { sessionPersistence: "optional", promptDelivery: "file", skillSelection: "exact", toolSelection: "allowlist" },
    pools: { tools: ["read", "bash", "edit", "write", "ask_user_question", "executor_execute", "executor_skills", "executor_resume"], extensions: [], skills: [], plugins: [], mcp: [] },
  };
}

function claudeRunner(modelIds: readonly string[]): RunnerEntry {
  return {
    kind: "claude",
    models: modelIds.map((model) => ({ model, supportedReasoning: ["low" as const] })),
    quota: { provider: "test-provider", billingProduct: "test-product", account: "test-account", scope: "project" },
    defaults: { timeoutMinutes: 30, sessionPersistence: true, effort: "low", permissionMode: "dontAsk" },
    plumbing: { sessionPersistence: "required", promptDelivery: "file", skillSelection: "additive", toolSelection: "allowlist" },
    pools: { tools: ["Read", "Write", "Bash"], extensions: [], skills: [], plugins: [], mcp: [] },
  };
}

function catalogOf(subjects: readonly AvailabilitySubject[], runners?: ReadonlyMap<RunnerKind, RunnerEntry>): Catalog {
  const resolvedRunners = runners ?? new Map<RunnerKind, RunnerEntry>([["pi", runnerEntry(subjects.filter((s) => s.runner === "pi").map((s) => s.model))]]);
  const points = subjects.map((subject): OperatingPoint => {
    const runner = resolvedRunners.get(subject.runner)!;
    const reasoning = subject.runner === "pi" || subject.runner === "claude" ? ("low" as const) : undefined;
    return {
      id: reasoning === undefined ? `${subject.runner}:${subject.model}` : `${subject.runner}:${subject.model}:${reasoning}`,
      runner: subject.runner,
      model: subject.model,
      ...(reasoning === undefined ? {} : { reasoning }),
      provider: `${runner.quota.provider}-${subject.model}`,
      quota: { ...runner.quota, provider: `${runner.quota.provider}-${subject.model}` },
      costClass: "low",
      latencyClass: "low",
    };
  });
  return {
    version: 2,
    runners: resolvedRunners,
    skills: [],
    plugins: [],
    mcpServers: new Map(),
    quotaSources: [{ name: "reactive-cooldowns", kind: "floor" }],
    points,
    pointPolicy: new Map(points.map((point) => [point.id, { costClass: point.costClass, latencyClass: point.latencyClass }])),
    tierChains: {
      utility: points.map((point) => point.id),
      economy: points.map((point) => point.id),
      standard: points.map((point) => point.id),
      strong: points.map((point) => point.id),
      frontier: points.map((point) => point.id),
      max: points.map((point) => point.id),
    },
    source: { path: "/tmp/catalog.yaml", scopeRoot: "/tmp" },
  };
}

/** The two-provider catalog: claude heads the chain, pi survives the exclusion. */
const twoProviderCatalog = () => catalogOf(
  [{ runner: "claude", model: "c" }, { runner: "pi", model: "a" }],
  new Map<RunnerKind, RunnerEntry>([["claude", claudeRunner(["c"])], ["pi", runnerEntry(["a"])]]),
);

function responseFor(catalog: Catalog): TaskModelDecision {
  const resources: Record<string, Record<string, Record<string, number>>> = {};
  for (const [kind, runner] of catalog.runners) {
    if (runner.plumbing.toolSelection === "ambient" || runner.pools.tools.length === 0) continue;
    resources[kind] = { tools: { read: 0.95 } };
  }
  const fitness: Record<string, Record<string, number>> = {};
  for (const index of (catalog.points ?? []).keys()) {
    const score = 0.95 - index * 0.01;
    fitness[String(index)] = { utility: score, economy: score, standard: score, strong: score, frontier: score, max: score };
  }
  return {
    quality: { done_when_verifiable: 0.95 },
    intent: { value: "implement", confidence: 0.95 },
    tier: { value: "standard", confidence: 0.95 },
    resources,
    fitness,
    uncertainDimensions: [],
  };
}

function fakeAttachments(): AttachmentStore {
  const grant = { path: "/tmp/recipient", token: "grant", renew: vi.fn(async () => undefined), release: vi.fn(async () => undefined) };
  return {
    root: "/tmp",
    recipientDirectory: (key) => `/tmp/${key}`,
    ensureRecipient: vi.fn(async () => grant),
    publish: vi.fn(async () => ({ attachmentId: "attachment", path: "/tmp/recipient/body.txt", bytes: 1, sha256: "a".repeat(64), expiresAt: "2026-09-19T00:00:00.000Z" })),
  };
}

type Child = { paneId: string; tabId: string; name: string; kind: string; terminalId: string; session: { source: string; agent: string; kind: string; value: string }; prompt: boolean; closed: boolean };

function agentRecord(child: Child): Record<string, unknown> {
  return { name: child.name, pane_id: child.paneId, agent: child.kind, terminal_id: child.terminalId, agent_session: child.session, agent_status: child.prompt ? "working" : "idle", state_change_seq: child.prompt ? 8 : 7, revision: child.prompt ? 4 : 3, interactive_ready: true };
}

function paneRecord(child: Child): Record<string, unknown> {
  return { pane_id: child.paneId, tab_id: child.tabId, workspace_id: "w1", agent_name: child.name, agent: child.kind, terminal_id: child.terminalId, agent_session: child.session, agent_status: child.prompt ? "working" : "idle", state_change_seq: child.prompt ? 8 : 7, revision: child.prompt ? 4 : 3, interactive_ready: true };
}

function makeCli(options: {
  /** Throw from `agent start` at these 0-based attempt indices. */
  startFailures?: number[];
  /** `present` — the mutation throws while the pane stays (uncertain close); `gone` — the pane is already absent, so the mutation's "not found" still reconciles. */
  closeFailure?: "present" | "gone";
} = {}): { cli: LaunchCli; calls: string[][]; prompts: string[]; children: Child[]; live: () => Child[]; starts: () => number } {
  const calls: string[][] = [];
  const prompts: string[] = [];
  const children: Child[] = [];
  let nextPane = 2;
  let active: Child | undefined;
  let starts = 0;

  const live = () => children.filter((child) => !child.closed);
  const snapshot = (): HerdrSnapshot => ({
    version: "0.8.0",
    protocol: 22,
    workspaces: [{ workspace_id: "w1", label: "workspace", focused: true }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main", focused: true }],
    panes: [
      { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "caller", agent_status: "idle" },
      ...live().map((child) => paneRecord(child)),
    ] as HerdrSnapshot["panes"],
    agents: live().map((child) => agentRecord(child)) as HerdrSnapshot["agents"],
  });

  const cli: LaunchCli = {
    prompt: vi.fn(async (target, text) => {
      calls.push(["agent", "prompt", target]);
      prompts.push(text);
      if (active === undefined || active.closed) throw new Error("no live child");
      active.prompt = true;
      return ok("prompt", { type: "agent_prompted", agent: agentRecord(active) });
    }),
    runJson: vi.fn(async (argv) => {
      calls.push(argv);
      try {
        return await dispatch(argv);
      } catch (error) {
        console.log("FAILED-ARGV", argv, error);
        throw error;
      }
    }),
  };
  const dispatch = async (argv: string[]): Promise<JsonEnvelope> => {
      if (argv[0] === "pane" && (argv[1] === "send-text" || argv[1] === "wait-output")) {
        return ok("shell", argv[1] === "send-text" ? {} : { type: "output_matched", pane_id: argv[2], matched_line: argv[4] });
      }
      if (argv[0] === "pane" && argv[1] === "current") return ok("current", { type: "pane_current", pane: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" } });
      if (argv[0] === "api") return ok("snapshot", { type: "session_snapshot", snapshot: snapshot() });
      if (argv[0] === "pane" && argv[1] === "split") {
        const paneId = `w1:p${nextPane++}`;
        active = { paneId, tabId: "w1:t1", name: "", kind: "pi", terminalId: `terminal-${paneId}`, session: { source: "herdr:pi", agent: "pi", kind: "id", value: `session-${paneId}` }, prompt: false, closed: false };
        return ok("split", { pane: { pane_id: paneId, tab_id: "w1:t1", workspace_id: "w1" } });
      }
      if (argv[0] === "pane" && argv[1] === "rename") return ok("rename", {});
      if (argv[0] === "tab" && argv[1] === "create") {
        const paneId = `w1:p${nextPane++}`;
        active = { paneId, tabId: "w1:t2", name: "", kind: "pi", terminalId: `terminal-${paneId}`, session: { source: "herdr:pi", agent: "pi", kind: "id", value: `session-${paneId}` }, prompt: false, closed: false };
        return ok("tab", { tab: { tab_id: "w1:t2", workspace_id: "w1" }, root_pane: { pane_id: paneId, tab_id: "w1:t2", workspace_id: "w1" } });
      }
      if (argv[0] === "tab" && argv[1] === "get") return ok("tab-get", { pane: { pane_id: active?.paneId, tab_id: active?.tabId, workspace_id: "w1" } });
      if (argv[0] === "pane" && argv[1] === "close") {
        const child = children.find((entry) => entry.paneId === argv[2]);
        if (options.closeFailure === "gone") { if (child !== undefined) child.closed = true; throw new Error("pane already gone"); }
        if (options.closeFailure === "present" || child === undefined || child.closed) throw new Error("close failed");
        child.closed = true;
        return ok("close", {});
      }
      if (argv[0] === "agent" && argv[1] === "start") {
        const attempt = starts++;
        if (active === undefined || active.closed) throw new Error("no live pane");
        active.name = String(argv[2]);
        active.kind = String(argv[4]);
        active.session = { source: `herdr:${active.kind}`, agent: active.kind, kind: "id", value: `session-${attempt}` };
        if (options.startFailures?.includes(attempt)) throw new Error("start boom");
        children.push(active);
        return ok("start", { agent: agentRecord(active) });
      }
      if (argv[0] === "agent" && argv[1] === "focus") return ok("focus", {});
      if (argv[0] === "pane" && argv[1] === "report-metadata") return ok("metadata", {});
      if (argv[0] === "agent" && argv[1] === "get") {
        if (active === undefined || active.closed) throw new Error("no live pane");
        return ok("agent-get", { agent: agentRecord(active) });
      }
      if (argv[0] === "pane" && argv[1] === "get") {
        if (active === undefined || active.closed) throw new Error("no live pane");
        return ok("pane-get", { pane: paneRecord(active) });
      }
      throw new Error(`unexpected argv: ${argv.join(" ")}`);
  };
  return { cli, calls, prompts, children, live, starts: () => starts };
}

const openLaunchGate: NonNullable<LaunchDependencies["launchGate"]> = async () => ({ check: async () => undefined, release: async () => undefined });

function toolFor(options: {
  catalog: Catalog;
  cli: LaunchCli;
  supervision?: ReturnType<typeof stubSupervision>;
  handoffs?: HandoffAllocator;
  claudeQuotaReader?: LaunchDependencies["claudeQuotaReader"];
  availabilityFailureRecorder?: LaunchDependencies["availabilityFailureRecorder"];
  specClient?: LaunchDependencies["specClient"];
  selfClose?: SelfCloseTracker;
  beforeFirstEffect?: LaunchDependencies["beforeFirstEffect"];
}): ReturnType<typeof createLaunchTool> {
  return createLaunchTool({
    cli: options.cli,
    context,
    cwd: repoRoot,
    preflight: async () => undefined,
    supervision: options.supervision ?? stubSupervision(),
    specClient: options.specClient ?? { evaluate: vi.fn(async () => ({ kind: "response" as const, response: responseFor(options.catalog) })) },
    catalog: { load: async () => options.catalog },
    attachments: fakeAttachments(),
    ...(options.handoffs === undefined ? {} : { handoffs: options.handoffs }),
    availabilityFailureRecorder: options.availabilityFailureRecorder ?? vi.fn(async () => undefined),
    ...(options.claudeQuotaReader === undefined ? {} : { claudeQuotaReader: options.claudeQuotaReader }),
    ...(options.selfClose === undefined ? {} : { selfClose: options.selfClose }),
    ...(options.beforeFirstEffect === undefined ? {} : { beforeFirstEffect: options.beforeFirstEffect }),
    routerLog: vi.fn(async () => undefined),
    launchGate: openLaunchGate,
  });
}

async function execute(tool: ReturnType<typeof createLaunchTool>, params: unknown, ctx: ExtensionContext = extensionContext): Promise<AgentToolResult<LaunchResult>> {
  const result = await tool.execute("call", params as never, new AbortController().signal, undefined, ctx);
  if (result.details?.kind !== "launch") throw new Error("expected a launch result");
  return result;
}

const fakeSelfClose = (): { tracker: SelfCloseTracker; finishers: ReturnType<typeof vi.fn>[] } => {
  const finishers: ReturnType<typeof vi.fn>[] = [];
  return {
    finishers,
    tracker: {
      begin: vi.fn(() => { const finish = vi.fn(); finishers.push(finish); return finish; }),
      consume: vi.fn(() => false),
      onPaneClosed: vi.fn(() => () => undefined),
      clear: vi.fn(),
    } as unknown as SelfCloseTracker,
  };
};

describe("provider-limit auto-recovery", () => {
  it("closes the dead pane, marks the run terminal, and relaunches through recoveryOf with the failed provider excluded", async () => {
    const harness = makeCli();
    const supervision = stubSupervision();
    const handoffs = allocator();
    const availabilityRoot = realpathSync(mkdtempSync(join(tmpdir(), "herdr-availability-")));
    dirs.push(availabilityRoot);
    const recorder = vi.fn(async (candidate: Parameters<typeof recordLaunchFailure>[0], runner: Parameters<typeof recordLaunchFailure>[1], failure: Parameters<typeof recordLaunchFailure>[2]) => recordLaunchFailure(candidate, runner, failure, { root: availabilityRoot }));
    const quota = vi.fn(async (): Promise<ClaudeQuotaSignal> => ({ retryNotBefore: RESET_ISO, zeroProgressProven: true }));
    const result = await execute(toolFor({ catalog: twoProviderCatalog(), cli: harness.cli, supervision, handoffs, availabilityFailureRecorder: recorder, claudeQuotaReader: quota }), TASK);
    expect(result.details!.outcome).toBe("launched");
    expect(result.details!.children[0]).toMatchObject({ state: "launched", operatingPointId: "claude:c:low" });
    const dead = supervision.bound[0]!;
    expect(dead.handoff).toBeDefined();

    const signal = await supervision.completionSignals[0]!(dead.identity);

    // The availability record carries the provider's own reset instant.
    expect(recorder).toHaveBeenCalledWith(expect.objectContaining({ runner: "claude" }), expect.anything(), { code: "CLAUDE_API_ERROR", causeCode: "rate_limit", retryNotBefore: RESET_ISO }, { root: repoRoot });
    // And the gate excludes that provider until the evidenced instant.
    const claudePoint = twoProviderCatalog().points![0]!;
    expect(await availability(claudePoint, claudeRunner(["c"]), { root: availabilityRoot, now: () => new Date(Date.parse(RESET_ISO) - 60_000) }))
      .toMatchObject({ status: "known-exhausted", retryNotBefore: RESET_ISO });
    // The caller sees the second attempt on the signal result.
    expect(signal).toMatchObject({
      cooldownRecorded: true,
      retryNotBefore: RESET_ISO,
      autoRecovery: { outcome: "relaunched", operatingPointId: "pi:a:low", supervisorJobId: "job_supervisor" },
    });
    const recovery = (signal as { autoRecovery: { launchId: string; target: string } }).autoRecovery;
    expect(recovery.launchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(recovery.target).not.toBe(result.details!.children[0]!.target);

    // The dead pane closed before the recovery child started.
    const closeIndex = harness.calls.findIndex((argv) => argv[0] === "pane" && argv[1] === "close" && argv[2] === dead.identity.paneId);
    const starts = harness.calls.map((argv, index) => ({ argv, index })).filter(({ argv }) => argv[0] === "agent" && argv[1] === "start");
    expect(closeIndex).toBeGreaterThanOrEqual(0);
    expect(starts).toHaveLength(2);
    expect(closeIndex).toBeLessThan(starts[1]!.index);
    // Exactly one live child remains.
    expect(harness.children).toHaveLength(2);
    expect(harness.live()).toHaveLength(1);
    expect(harness.live()[0]!.kind).toBe("pi");
    expect(dead.identity.paneId).toBe("w1:p2");
    expect(harness.children[0]!.closed).toBe(true);

    // The dead run carries terminal lineage evidence for the recovery.
    expect((await readHandoffState(dead.handoff!.allocation)).lifecycle).toMatchObject({ state: "failed", detail: "provider_limit_zero_progress" });
    // The recovery launch recorded its lineage and routed off the failed provider.
    const recovered = supervision.bound[1]!;
    expect(recovered.identity.agentKind).toBe("pi");
    expect(recovered.operatingPointId).toBe("pi:a:low");
    const recoveredState = await readHandoffState(recovered.handoff!.allocation);
    expect(recoveredState.child.route?.operatingPointId).toBe("pi:a:low");
    const provenance = await readHandoffProvenance(recovered.handoff!.allocation);
    expect(provenance.task).toMatchObject({ objective: TASK.objective, recoveryOf: dead.handoff!.allocation.runId });
  });

  it("keeps the manual contract when zero progress is not provable, and records the 15-minute default when no reset signal exists", async () => {
    const harness = makeCli();
    const supervision = stubSupervision();
    const availabilityRoot = realpathSync(mkdtempSync(join(tmpdir(), "herdr-availability-")));
    dirs.push(availabilityRoot);
    const recorder = vi.fn(async (candidate: Parameters<typeof recordLaunchFailure>[0], runner: Parameters<typeof recordLaunchFailure>[1], failure: Parameters<typeof recordLaunchFailure>[2]) => recordLaunchFailure(candidate, runner, failure, { root: availabilityRoot }));
    const quota = vi.fn(async (): Promise<ClaudeQuotaSignal> => ({ retryNotBefore: null, zeroProgressProven: false }));
    await execute(toolFor({ catalog: twoProviderCatalog(), cli: harness.cli, supervision, handoffs: allocator(), availabilityFailureRecorder: recorder, claudeQuotaReader: quota }), TASK);

    const signal = await supervision.completionSignals[0]!(supervision.bound[0]!.identity);
    expect(signal).toEqual({ cooldownRecorded: true });
    expect(recorder).toHaveBeenCalledWith(expect.anything(), expect.anything(), { code: "CLAUDE_API_ERROR", causeCode: "rate_limit", retryNotBefore: null }, { root: repoRoot });
    // No source signal → the default cooldown applies; the gate reports no ETA.
    const claudePoint = twoProviderCatalog().points![0]!;
    expect(await availability(claudePoint, claudeRunner(["c"]), { root: availabilityRoot }))
      .toMatchObject({ status: "known-exhausted", retryNotBefore: null });
    expect(harness.starts()).toBe(1);
    expect(harness.calls.filter((argv) => argv[0] === "pane" && argv[1] === "close")).toEqual([]);
    expect(harness.live()).toHaveLength(1);
  });

  it("never auto-recovers a multi-replica launch", async () => {
    const harness = makeCli();
    const supervision = stubSupervision();
    const quota = vi.fn(async (): Promise<ClaudeQuotaSignal> => ({ retryNotBefore: null, zeroProgressProven: true }));
    const worktrees = {
      prepare: vi.fn(async ({ childName, cwd }: { childName: string; cwd: string }) => ({ cwd: join(cwd, ".herdr", "worktrees", childName), worktreePath: join(cwd, ".herdr", "worktrees", childName) })),
      bindPane: vi.fn(),
      release: vi.fn(async () => undefined),
    };
    const tool = createLaunchTool({
      cli: harness.cli,
      context,
      cwd: repoRoot,
      preflight: async () => undefined,
      supervision,
      specClient: { evaluate: vi.fn(async () => ({ kind: "response" as const, response: responseFor(twoProviderCatalog()) })) },
      catalog: { load: async () => twoProviderCatalog() },
      attachments: fakeAttachments(),
      handoffs: allocator(),
      availabilityFailureRecorder: vi.fn(async () => undefined),
      claudeQuotaReader: quota,
      routerLog: vi.fn(async () => undefined),
      launchGate: openLaunchGate,
      worktrees: worktrees as never,
    });
    const result = await tool.execute("call", { ...TASK, replicas: 2 } as never, new AbortController().signal, undefined, extensionContext);
    expect((result.details as LaunchResult).outcome).toBe("launched");
    // Every claude replica registers a signal; the replicas guard keeps all
    // of them on the manual contract.
    for (const [index, signal] of supervision.completionSignals.entries()) {
      expect(await signal(supervision.bound[index]!.identity)).toEqual({ cooldownRecorded: true });
    }
    expect(harness.calls.filter((argv) => argv[0] === "pane" && argv[1] === "close")).toEqual([]);
    expect(harness.live()).toHaveLength(2);
  });

  it("reports an unproven close without launching a second child", async () => {
    const harness = makeCli({ closeFailure: "present" });
    const supervision = stubSupervision();
    const selfClose = fakeSelfClose();
    const quota = vi.fn(async (): Promise<ClaudeQuotaSignal> => ({ retryNotBefore: null, zeroProgressProven: true }));
    await execute(toolFor({ catalog: twoProviderCatalog(), cli: harness.cli, supervision, handoffs: allocator(), claudeQuotaReader: quota, selfClose: selfClose.tracker }), TASK);

    const signal = await supervision.completionSignals[0]!(supervision.bound[0]!.identity);
    expect(signal).toEqual({ cooldownRecorded: true, autoRecovery: { outcome: "failed", code: "MUTATION_UNCERTAIN" } });
    // The close was never proven — its own-close marker retires unconfirmed.
    expect(selfClose.finishers[0]).toHaveBeenCalledWith(false);
    expect(harness.starts()).toBe(1);
    // The pane stayed live — no second child, no run-level damage.
    expect(harness.live()).toHaveLength(1);
  });

  it("still reports the limit when the recovery seam itself throws", async () => {
    const harness = makeCli();
    const supervision = stubSupervision();
    const quota = vi.fn(async (): Promise<ClaudeQuotaSignal> => ({ retryNotBefore: null, zeroProgressProven: true }));
    const broken = { begin: () => { throw new Error("tracker down"); }, consume: () => false, onPaneClosed: () => () => undefined, clear: () => undefined } as unknown as SelfCloseTracker;
    await execute(toolFor({ catalog: twoProviderCatalog(), cli: harness.cli, supervision, handoffs: allocator(), claudeQuotaReader: quota, selfClose: broken }), TASK);

    const signal = await supervision.completionSignals[0]!(supervision.bound[0]!.identity);
    expect(signal).toEqual({ cooldownRecorded: true, autoRecovery: { outcome: "failed", code: "RECOVERY_FAILED" } });
    expect(harness.calls.filter((argv) => argv[0] === "pane" && argv[1] === "close")).toEqual([]);
    expect(harness.live()).toHaveLength(1);
  });

  it("still relaunches when the dead pane is proven already absent", async () => {
    const harness = makeCli({ closeFailure: "gone" });
    const supervision = stubSupervision();
    const quota = vi.fn(async (): Promise<ClaudeQuotaSignal> => ({ retryNotBefore: null, zeroProgressProven: true }));
    await execute(toolFor({ catalog: twoProviderCatalog(), cli: harness.cli, supervision, handoffs: allocator(), claudeQuotaReader: quota }), TASK);

    const signal = await supervision.completionSignals[0]!(supervision.bound[0]!.identity);
    expect(signal).toMatchObject({ cooldownRecorded: true, autoRecovery: { outcome: "relaunched", operatingPointId: "pi:a:low" } });
    expect(harness.starts()).toBe(2);
    expect(harness.live()).toHaveLength(1);
  });

  it("reports a run-state write failure without relaunching", async () => {
    const harness = makeCli();
    const supervision = stubSupervision();
    const quota = vi.fn(async (): Promise<ClaudeQuotaSignal> => ({ retryNotBefore: null, zeroProgressProven: true }));
    await execute(toolFor({ catalog: twoProviderCatalog(), cli: harness.cli, supervision, handoffs: allocator(), claudeQuotaReader: quota }), TASK);
    const dead = supervision.bound[0]!;
    // Break the durable run record so the terminal mark cannot land.
    rmSync(dead.handoff!.allocation.directory, { recursive: true, force: true });

    const signal = await supervision.completionSignals[0]!(dead.identity);
    expect(signal).toEqual({ cooldownRecorded: true, autoRecovery: { outcome: "failed", code: "RUN_STATE_UNAVAILABLE" } });
    expect(harness.starts()).toBe(1);
    expect(harness.live()).toHaveLength(0); // the close still landed; only the relaunch stopped.
  });

  it("abstains when excluding the failed provider empties the chain", async () => {
    const harness = makeCli();
    const supervision = stubSupervision();
    const catalog = catalogOf([{ runner: "claude", model: "c" }], new Map<RunnerKind, RunnerEntry>([["claude", claudeRunner(["c"])]]));
    const quota = vi.fn(async (): Promise<ClaudeQuotaSignal> => ({ retryNotBefore: null, zeroProgressProven: true }));
    await execute(toolFor({ catalog, cli: harness.cli, supervision, handoffs: allocator(), claudeQuotaReader: quota }), TASK);

    const signal = await supervision.completionSignals[0]!(supervision.bound[0]!.identity);
    expect(signal).toMatchObject({ cooldownRecorded: true, autoRecovery: { outcome: "abstained", code: expect.any(String) } });
    expect(harness.starts()).toBe(1);
    expect(harness.live()).toHaveLength(0);
  });

  it("reports a failed relaunch with the child's bounded error code", async () => {
    const harness = makeCli({ startFailures: [1] });
    const supervision = stubSupervision();
    const quota = vi.fn(async (): Promise<ClaudeQuotaSignal> => ({ retryNotBefore: null, zeroProgressProven: true }));
    await execute(toolFor({ catalog: twoProviderCatalog(), cli: harness.cli, supervision, handoffs: allocator(), claudeQuotaReader: quota }), TASK);

    const signal = await supervision.completionSignals[0]!(supervision.bound[0]!.identity);
    expect(signal).toMatchObject({ cooldownRecorded: true, autoRecovery: { outcome: "failed", code: "LAUNCH_FAILED" } });
    expect(harness.live()).toHaveLength(0);
  });

  it("carries an internal launch identity that never re-fires the caller's intent boundary", async () => {
    const harness = makeCli();
    const supervision = stubSupervision();
    const hook = vi.fn(async () => undefined);
    const intentLaunchId = "11111111-1111-4111-8111-111111111111";
    const quota = vi.fn(async (): Promise<ClaudeQuotaSignal> => ({ retryNotBefore: null, zeroProgressProven: true }));
    const result = await execute(toolFor({
      catalog: twoProviderCatalog(), cli: harness.cli, supervision, handoffs: allocator(), claudeQuotaReader: quota,
      beforeFirstEffect: { launchId: intentLaunchId, hook },
    }), TASK);
    expect(result.details!.children[0]!.target).toBe(`task-11111111-1`);

    const signal = await supervision.completionSignals[0]!(supervision.bound[0]!.identity) as { autoRecovery: { launchId: string } };
    expect(signal.autoRecovery.launchId).not.toBe(intentLaunchId);
    // The boundary observed exactly the caller's intent — the relaunch minted
    // its own identity rather than re-firing the same one.
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("marks the close self-initiated and tolerates a session without a signal", async () => {
    const harness = makeCli();
    const supervision = stubSupervision();
    const selfClose = fakeSelfClose();
    const quota = vi.fn(async (): Promise<ClaudeQuotaSignal> => ({ retryNotBefore: null, zeroProgressProven: true }));
    await execute(toolFor({ catalog: twoProviderCatalog(), cli: harness.cli, supervision, handoffs: allocator(), claudeQuotaReader: quota, selfClose: selfClose.tracker }), { ...TASK, label: "recovery-check" }, { cwd: repoRoot } as ExtensionContext);

    const signal = await supervision.completionSignals[0]!(supervision.bound[0]!.identity);
    expect(signal).toMatchObject({ autoRecovery: { outcome: "relaunched" } });
    // The tracker saw the own-close marked and confirmed after readback.
    expect(selfClose.tracker.begin).toHaveBeenCalledWith("w1:p2");
    expect(selfClose.finishers[0]).toHaveBeenCalledWith(true);
  });
});
