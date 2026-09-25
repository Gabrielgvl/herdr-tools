import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import type { JsonEnvelope, PiExec } from "../../src/cli.js";
import type { AgentPromptClient } from "../../src/agent-prompt.js";
import type { Catalog, OperatingPoint, RunnerEntry, RunnerKind } from "../../src/catalog.js";
import { createHandoffAllocator, readHandoffState, type HandoffAllocator, type HandoffProvenanceInput, type HandoffRunIdentity } from "../../src/handoff.js";
import { createHandoffGate } from "../../src/handoff-gate.js";
import type { JobRegistry } from "../../src/job-registry.js";
import type { LaunchTask } from "../../src/launch-schema.js";
import type { AgentSessionIdentity } from "../../src/messages/prompt.js";
import type { AttachmentStore } from "../../src/messages/store.js";
import type { TaskModelDecision } from "../../src/router.js";
import type { SupervisedIdentity } from "../../src/supervision/identity.js";
import type { ClaudeQuotaSignal } from "../../src/supervision/claude-quota.js";
import type { HerdrSnapshot } from "../../src/targets.js";
import { createLaunchTool, type LaunchResult, type LaunchRouterLog } from "../../src/tools/launch.js";
import { handleDaemonLaunch, type DaemonLaunchReply } from "../../src/daemon/handlers/launch.js";
import { handleDaemonRun } from "../../src/daemon/handlers/run.js";
import { handleDaemonStatus } from "../../src/daemon/handlers/status.js";
import { createIntentStore, DaemonIntentError, managerSessionKey, type IntentStore } from "../../src/daemon/intents.js";
import { createMailbox, DaemonMailboxError, DAEMON_MAILBOX_DIR_NAME, mailboxEventId, type Mailbox } from "../../src/daemon/mailbox.js";
import { daemonRunOwnership, type ClaimRecord } from "../../src/daemon/ownership.js";
import { resolveDaemonNamespace, type DaemonNamespace } from "../../src/daemon/namespace.js";
import { createDaemonRuntime, type DaemonRuntime } from "../../src/daemon/runtime.js";
import { stubSupervision, type StubSupervision } from "./supervision-fixtures.js";

const dirs: string[] = [];
const runtimes: DaemonRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.supervision.shutdown().catch(() => undefined);
    runtime.jobs.shutdown();
    await runtime.queueFlush.shutdown().catch(() => undefined);
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const managerSession: AgentSessionIdentity = { source: "herdr:pi", agent: "pi", kind: "id", value: "mgr-session" };
const managerKey = managerSessionKey(managerSession);
const claim = { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", agentSession: managerSession };
const task: LaunchTask = { objective: "Reduce the latency without changing the public contract.", scope: "Only the assigned worktree.", doneWhen: ["The assigned objective is complete and verified."] };
const otherSession: AgentSessionIdentity = { source: "herdr:pi", agent: "pi", kind: "id", value: "other-session" };

const ok = (id: string, result: unknown): JsonEnvelope => ({ id, result });
const envelope = (id: string, result: unknown): ExecResult => ({ stdout: JSON.stringify(ok(id, result)), stderr: "", code: 0, killed: false });

interface Child {
  paneId: string;
  tabId: string;
  name: string;
  kind: string;
  terminalId: string;
  session: AgentSessionIdentity;
  prompt: boolean;
  agentId?: string;
}

function agentRecord(child: Child): Record<string, unknown> {
  return { name: child.name, pane_id: child.paneId, agent: child.kind, terminal_id: child.terminalId, agent_session: child.session, agent_status: child.prompt ? "working" : "idle", state_change_seq: child.prompt ? 8 : 7, revision: child.prompt ? 4 : 3, interactive_ready: true };
}

function paneRecord(child: Child): Record<string, unknown> {
  return { pane_id: child.paneId, tab_id: child.tabId, workspace_id: "w1", agent_name: child.name, agent: child.kind, terminal_id: child.terminalId, agent_session: child.session, agent_status: child.prompt ? "working" : "idle", state_change_seq: child.prompt ? 8 : 7, revision: child.prompt ? 4 : 3, interactive_ready: true };
}

interface HarnessOptions {
  /** Mutate the produced snapshot (extra panes/agents, a different caller record). */
  caller?: { pane?: Record<string, unknown>; agent?: Record<string, unknown> | null; panes?: Record<string, unknown>[]; agents?: Record<string, unknown>[] };
  /** Throw for `agent start` at these attempt indices (0-based). */
  startErrors?: Record<number, unknown>;
  splitError?: unknown;
  /** Throw inside the topology mutation (`tab create` / `pane split`) — after persist, before bind. */
  mutationError?: unknown;
  promptError?: unknown;
  routerLogError?: unknown;
  specError?: unknown;
  /** Throw at launch-gate acquisition — the lease never exists. */
  gateError?: unknown;
  /** Throw inside the acquired lease's `check` — exercises the release path. */
  gateCheckError?: unknown;
  /** Throw inside the `effecting` write — the before-first-effect refusal. */
  effectingError?: unknown;
  /** Mutate the intent store before the runtime is returned (fault injection). */
  intentsWrap?: (intents: IntentStore) => void;
  /** Build the runtime with no launch-pipeline seams — every dep default engages. */
  noLaunchDeps?: boolean;
  /** A fake job registry wired in as the host's registry. */
  jobs?: { list: JobRegistry["list"]; get: JobRegistry["get"]; shutdown: () => void };
  /** Override the launch preflight — e.g. park a request before its first effect. */
  preflight?: () => Promise<void>;
  /** Admit a claude operating point instead of the pi one. */
  claude?: boolean;
  claudeQuotaReader?: (session: AgentSessionIdentity, cwd: string, notBeforeMs: number) => Promise<ClaudeQuotaSignal>;
  supervision?: StubSupervision;
}

interface Harness {
  runtime: DaemonRuntime;
  namespace: DaemonNamespace;
  intents: IntentStore;
  allocator: HandoffAllocator;
  mailbox: Mailbox;
  runsDir: string;
  calls: string[][];
  prompts: string[];
  children: Child[];
  projectRoot: string;
  routerLog: ReturnType<typeof vi.fn>;
  failureRecorder: ReturnType<typeof vi.fn>;
  supervision: StubSupervision;
  bindGate: ReturnType<typeof createHandoffGate>;
  gateRelease: ReturnType<typeof vi.fn>;
  /** Ordered boundary events: `effecting`, `routerLog`, `recorded`, `reserve`, `mutation`, `bind`. */
  events: string[];
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

function catalogOf(models: readonly string[], kind: RunnerKind = "pi"): Catalog {
  const runner = kind === "claude" ? claudeRunner(models) : runnerEntry(models);
  const runners = new Map<RunnerKind, RunnerEntry>([[kind, runner]]);
  const points: OperatingPoint[] = models.map((model) => ({
    id: `${kind}:${model}:low`,
    runner: kind,
    model,
    reasoning: "low" as const,
    provider: `test-provider-${model}`,
    quota: { provider: `test-provider-${model}`, billingProduct: "test-product", account: "test-account", scope: "project" as const },
    costClass: "low",
    latencyClass: "low",
  }));
  return {
    version: 2,
    runners,
    skills: [],
    plugins: [],
    mcpServers: new Map(),
    quotaSources: [{ name: "reactive-cooldowns", kind: "floor" }],
    points,
    pointPolicy: new Map(points.map((point) => [point.id, { costClass: point.costClass, latencyClass: point.latencyClass }])),
    tierChains: { utility: points.map((p) => p.id), economy: points.map((p) => p.id), standard: points.map((p) => p.id), strong: points.map((p) => p.id), frontier: points.map((p) => p.id), max: points.map((p) => p.id) },
    source: { path: "/tmp/catalog.yaml", scopeRoot: "/tmp" },
  };
}

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

const openLaunchGate = async () => ({ check: async () => undefined, release: async () => undefined });

/** A persisted-but-unbound run: durable identity, no bound child record yet. */
async function persistRun(fx: Harness, agentName = "task-aa-1"): Promise<Awaited<ReturnType<HandoffAllocator["allocate"]>>> {
  const allocation = await fx.allocator.allocate();
  const identity: HandoffRunIdentity = {
    manager: { paneId: "w1:p1", display: "manager", source: "agent_name" },
    child: { agentName, agentKind: "pi", operatingPointId: "pi:pi-model:low", specLabel: "task", fallbackCandidates: [] },
  };
  const provenance: HandoffProvenanceInput = {
    managerSession,
    task: { objective: task.objective, scope: task.scope, doneWhen: task.doneWhen, constraints: [], tier: "standard", replicas: 1 },
  };
  await fx.allocator.persist(allocation, identity, provenance);
  return allocation;
}

/** A persisted run whose bound child identity is durable through the real gate. */
async function boundRun(fx: Harness, bound: { terminalId: string; agentName?: string; agentKind?: string; session?: AgentSessionIdentity }): Promise<Awaited<ReturnType<HandoffAllocator["allocate"]>>> {
  const allocation = await persistRun(fx, bound.agentName);
  await fx.bindGate.bind(allocation, {
    paneId: "w1:p9",
    terminalId: bound.terminalId,
    agentName: bound.agentName ?? "task-aa-1",
    agentKind: bound.agentKind ?? "pi",
    agentSession: bound.session ?? { source: "herdr:pi", agent: "pi", kind: "id", value: "sess-bound" },
  });
  return allocation;
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "herdr-daemon-n21-"));
  dirs.push(root);
  const endpoint = join(root, "herdr.sock");
  await writeFile(endpoint, "");
  const env = { HERDR_SOCKET_PATH: endpoint };
  const namespace = await resolveDaemonNamespace(env);
  await mkdir(join(root, "project"));
  const projectRoot = await realpath(join(root, "project"));

  const children: Child[] = [];
  const events: string[] = [];
  const calls: string[][] = [];
  const prompts: string[] = [];
  const byPane = new Map<string, Child>();
  let nextPane = 2;
  let nextTab = 2;
  let starts = 0;
  let active: Child | undefined;

  const snapshot = (): HerdrSnapshot => ({
    version: "0.8.0",
    protocol: 22,
    workspaces: [{ workspace_id: "w1", label: "workspace", focused: true }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main", focused: true }],
    panes: [
      { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "manager", agent: "pi", terminal_id: "t-mgr", agent_session: managerSession, agent_status: "idle", ...(options.caller?.pane ?? {}) },
      ...(options.caller?.panes ?? []),
      ...children.map((child) => paneRecord(child)),
    ] as HerdrSnapshot["panes"],
    agents: [
      ...(options.caller?.agent === null ? [] : [{ pane_id: "w1:p1", name: "manager", agent: "pi", terminal_id: "t-mgr", agent_session: managerSession, agent_status: "idle", ...(options.caller?.agent ?? {}) }]),
      ...(options.caller?.agents ?? []),
      ...children.map((child) => agentRecord(child)),
    ] as HerdrSnapshot["agents"],
  });

  const newChild = (tabId: string): Child => {
    const paneId = `w1:p${nextPane++}`;
    const child: Child = { paneId, tabId, name: "", kind: "pi", terminalId: `terminal-${paneId}`, session: { source: "herdr:pi", agent: "pi", kind: "id", value: `session-${paneId}` }, prompt: false };
    byPane.set(paneId, child);
    return child;
  };

  const exec: PiExec = async (_command, argv) => {
    calls.push(argv);
    if (argv[0] === "api" && argv[1] === "snapshot") return envelope("snapshot", { type: "session_snapshot", snapshot: snapshot() });
    if (argv[0] === "pane" && argv[1] === "current") return envelope("current", { type: "pane_current", pane: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" } });
    if (argv[0] === "pane" && argv[1] === "split") {
      events.push("mutation");
      if (options.splitError !== undefined) throw options.splitError;
      if (options.mutationError !== undefined) throw options.mutationError;
      const child = newChild("w1:t1");
      active = child;
      return envelope("split", { pane: { pane_id: child.paneId, tab_id: "w1:t1", workspace_id: "w1" } });
    }
    if (argv[0] === "tab" && argv[1] === "create") {
      events.push("mutation");
      if (options.mutationError !== undefined) throw options.mutationError;
      const tabId = `w1:t${nextTab++}`;
      const child = newChild(tabId);
      active = child;
      return envelope("tab", { tab: { tab_id: tabId, workspace_id: "w1" }, root_pane: { pane_id: child.paneId, tab_id: tabId, workspace_id: "w1" } });
    }
    if (argv[0] === "tab" && argv[1] === "get") return envelope("tab-get", { pane: { pane_id: active?.paneId, tab_id: active?.tabId, workspace_id: "w1" } });
    if (argv[0] === "pane" && argv[1] === "rename") { events.push("mutation"); return envelope("rename", {}); }
    if (argv[0] === "agent" && argv[1] === "start") {
      events.push("mutation");
      const attempt = starts++;
      const paneId = String(argv[argv.indexOf("--pane") + 1]);
      const child = byPane.get(paneId) ?? active;
      if (child === undefined) throw new Error("no pane");
      if (options.startErrors?.[attempt] !== undefined) throw options.startErrors[attempt];
      child.name = String(argv[2]);
      child.kind = String(argv[4]);
      child.session = { source: `herdr:${child.kind}`, agent: child.kind, kind: "id", value: `session-${attempt}` };
      if (!children.includes(child)) children.push(child);
      active = child;
      return envelope("start", { agent: agentRecord(child) });
    }
    if (argv[0] === "agent" && argv[1] === "focus") return envelope("focus", {});
    if (argv[0] === "pane" && argv[1] === "report-metadata") return envelope("metadata", {});
    if (argv[0] === "agent" && argv[1] === "get") {
      const child = byPane.get(String(argv[2])) ?? active;
      if (child === undefined) throw new Error("no active pane");
      return envelope("agent-get", { agent: agentRecord(child) });
    }
    if (argv[0] === "pane" && argv[1] === "get") {
      const child = byPane.get(String(argv[2])) ?? active;
      if (child === undefined) throw new Error("no active pane");
      return envelope("pane-get", { pane: paneRecord(child) });
    }
    if (argv[0] === "pane" && argv[1] === "send-text") return envelope("shell", {});
    if (argv[0] === "pane" && argv[1] === "wait-output") return envelope("shell", { type: "output_matched", pane_id: argv[2], matched_line: argv[4] });
    throw new Error(`unexpected argv: ${argv.join(" ")}`);
  };

  const promptClient: AgentPromptClient = {
    prompt: async (target, text) => {
      calls.push(["agent", "prompt", target]);
      prompts.push(text);
      const child = byPane.get(target) ?? active;
      if (options.promptError !== undefined) throw options.promptError;
      if (child === undefined) throw new Error("no child to prompt");
      child.prompt = true;
      return ok("prompt", { type: "agent_prompted", agent: agentRecord(child) });
    },
    ping: async () => undefined,
  };

  const intents = createIntentStore({ namespace });
  const runsDir = join(root, "runs");
  await mkdir(runsDir, { mode: 0o700 });
  const allocator = createHandoffAllocator({ namespace: { dir: runsDir, endpoint: "test-endpoint" } });
  const mailbox = createMailbox({ namespace, ownership: daemonRunOwnership(allocator) });
  // The stub reservation's bind performs the real gate write so the run's
  // bound child identity lands on disk exactly as the registry would write it.
  const bindGate = createHandoffGate();
  const supervision = options.supervision ?? stubSupervision({
    onBind: async (binding) => {
      events.push("bind");
      await bindGate.bind(binding.handoff!.allocation, binding.identity);
    },
  });
  const routerLog = vi.fn<LaunchRouterLog>(async () => {
    if (options.routerLogError !== undefined) throw options.routerLogError;
    events.push("routerLog");
  });
  const catalog = catalogOf(["pi-model"], options.claude === true ? "claude" : "pi");
  const gateRelease = vi.fn(async () => undefined);
  const failureRecorder = vi.fn(async () => undefined);
  const launchGate = options.gateError === undefined && options.gateCheckError === undefined
    ? openLaunchGate
    : options.gateError !== undefined
      ? async () => { throw options.gateError; }
      : async () => ({ check: async () => { throw options.gateCheckError; }, release: gateRelease });
  const runtime = createDaemonRuntime({
    exec,
    env,
    promptClient,
    namespace,
    intents,
    allocator,
    mailbox,
    ...(options.jobs === undefined ? {} : { wire: () => ({ jobs: options.jobs as never }) }),
    ...(options.noLaunchDeps === true ? {} : {
      launchDeps: {
        preflight: options.preflight ?? (async () => undefined),
        supervision,
        specClient: { evaluate: vi.fn(async () => { if (options.specError !== undefined) throw options.specError; return { kind: "response" as const, response: responseFor(catalog) }; }) },
        catalog: { load: async () => catalog },
        attachments: fakeAttachments(),
        routerLog,
        launchGate,
        availabilityFailureRecorder: failureRecorder,
        ...(options.claudeQuotaReader === undefined ? {} : { claudeQuotaReader: options.claudeQuotaReader }),
        worktrees: {
          prepare: vi.fn(async ({ cwd }: { cwd: string }) => ({ cwd, worktreePath: cwd })),
          bindPane: vi.fn(),
          release: vi.fn(async () => undefined),
        } as never,
      },
    }),
  });
  runtimes.push(runtime);
  // Record the boundary order the daemon owns: the `effecting` write lands
  // before the decision log, and the recorded child lands before the
  // supervision bind.
  const markEffecting = intents.markEffecting.bind(intents);
  intents.markEffecting = async (intent) => {
    events.push("effecting");
    if (options.effectingError !== undefined) throw options.effectingError;
    return markEffecting(intent);
  };
  const recordChildren = intents.recordChildren.bind(intents);
  intents.recordChildren = async (intent, intentChildren) => { events.push("recorded"); return recordChildren(intent, intentChildren); };
  const baseReserve = supervision.reserve.bind(supervision);
  supervision.reserve = async (request) => { events.push("reserve"); return baseReserve(request); };
  options.intentsWrap?.(intents);
  return { runtime, namespace, intents, allocator, mailbox, runsDir, calls, prompts, children, projectRoot, routerLog, failureRecorder, supervision, bindGate, gateRelease, events };
}

const launchParams = (projectRoot: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  identity: claim,
  projectRoot,
  task,
  idempotencyKey: "idem-1",
  ...overrides,
});

const runParams = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ identity: claim, ...overrides });

describe("daemon launch handler — verified identity (D2a)", () => {
  it("refuses a caller whose claimed pane does not exist, before any effect", async () => {
    const fx = await harness();
    await expect(handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot, { identity: { ...claim, paneId: "w1:p9" } })))
      .rejects.toMatchObject({ daemonCode: "CALLER_IDENTITY_UNPROVEN" });
    // One fresh authoritative snapshot was taken — and nothing else happened.
    expect(fx.calls).toEqual([["api", "snapshot"]]);
    expect(await fx.intents.list(managerKey)).toEqual([]);
    expect(fx.routerLog).not.toHaveBeenCalled();
  });

  it("refuses ambiguous identity — a duplicate caller pane — before any effect", async () => {
    const fx = await harness({ caller: { panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", agent: "pi", terminal_id: "t-mgr", agent_session: managerSession }] } });
    await expect(handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot)))
      .rejects.toMatchObject({ daemonCode: "CALLER_IDENTITY_UNPROVEN" });
    expect(await fx.intents.list(managerKey)).toEqual([]);
  });

  it("refuses a session mismatch and a caller with no proven session", async () => {
    const fx = await harness();
    await expect(handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot, { identity: { ...claim, agentSession: otherSession } })))
      .rejects.toMatchObject({ daemonCode: "CALLER_IDENTITY_MISMATCH" });
    await expect(handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot, { identity: { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" } })))
      .rejects.toMatchObject({ daemonCode: "CALLER_IDENTITY_MISMATCH" });
    expect(await fx.intents.list(managerKey)).toEqual([]);
  });

  it("refuses when the verified pane carries no native session", async () => {
    const fx = await harness({ caller: { pane: { agent: undefined, agent_session: null }, agent: null } });
    await expect(handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot)))
      .rejects.toMatchObject({ daemonCode: "MANAGER_SESSION_UNAVAILABLE" });
    expect(await fx.intents.list(managerKey)).toEqual([]);
  });

  it("refuses malformed identity, a non-canonical project root, a bad key, and a malformed task", async () => {
    const fx = await harness();
    await expect(handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot, { identity: null })))
      .rejects.toMatchObject({ daemonCode: "CALLER_IDENTITY_MALFORMED" });
    await expect(handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot, { projectRoot: join(fx.projectRoot, "missing") })))
      .rejects.toMatchObject({ daemonCode: "PROJECT_ROOT_UNVERIFIED" });
    await expect(handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot, { projectRoot: `${fx.projectRoot}/` })))
      .rejects.toMatchObject({ daemonCode: "PROJECT_ROOT_UNVERIFIED" });
    await expect(handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot, { idempotencyKey: 7 })))
      .rejects.toMatchObject({ daemonCode: "REQUEST_INVALID" });
    await expect(handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot, { task: { objective: "x" } })))
      .rejects.toMatchObject({ daemonCode: "REQUEST_INVALID" });
    expect(await fx.intents.list(managerKey)).toEqual([]);
  });
});

describe("daemon launch handler — intent-gated execution", () => {
  it("launches end to end: runtime-minted launchId, ordered boundary writes, herdr-run marker, completed intent", async () => {
    const fx = await harness();
    const reply = await handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot)) as DaemonLaunchReply & { result: LaunchResult };
    expect(reply.kind).toBe("launch");
    expect(reply.state).toBe("completed");
    expect("resumed" in reply && reply.resumed === false).toBe(true);
    // The launchId is the intent's runtime-minted identity — never caller input.
    const intent = (await fx.intents.list(managerKey))[0]!;
    expect(intent.launchId).toBe(reply.launchId);
    expect(reply.result.launchId).toBe(intent.launchId);
    expect(intent.state).toBe("completed");
    // The durable child evidence: the minted name and its persisted run.
    const [child] = fx.children;
    expect(intent.children).toEqual([{ name: child.name, runId: expect.any(String), disposition: "bound" }]);
    const run = await fx.allocator.open(intent.children[0]!.runId!);
    const state = await readHandoffState(run);
    expect(state.child.agentName).toBe(child.name);
    // The boundary order the daemon owns, in one ordered chain: the
    // `effecting` write before the decision log; the decision log before the
    // recorded child; the recorded child before the supervision reservation;
    // the reservation before the first topology mutation; every mutation
    // before the supervision bind.
    const order = ["effecting", "routerLog", "recorded", "reserve", "mutation", "bind"];
    const positions = order.map((event) => fx.events.indexOf(event));
    expect(positions).toEqual([0, 1, 2, 3, 4, fx.events.length - 1]);
    // The contract the child received carries the run's herdr-run marker.
    expect(fx.prompts[0]).toContain(`herdr-run:${intent.children[0]!.runId}`);
  });

  it("proves gate evidence is durable before the child supervision bind", async () => {
    const fx = await harness();
    const reply = await handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot)) as DaemonLaunchReply;
    const intent = (await fx.intents.list(managerKey))[0]!;
    // At bind time the durable record already carried the child's run — the
    // recorded gate evidence strictly precedes the supervision bind event.
    expect(fx.events.indexOf("recorded")).toBeLessThan(fx.events.indexOf("bind"));
    expect(fx.supervision.bound).toHaveLength(1);
    expect(intent.children[0]!.runId).toBeDefined();
    expect(reply.state).toBe("completed");
  });

  it("replays a completed intent with zero effect: same launchId, no second mutation", async () => {
    const fx = await harness();
    const first = await handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot)) as DaemonLaunchReply;
    const callCount = fx.calls.length;
    const replay = await handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot)) as DaemonLaunchReply;
    expect(replay.state).toBe("completed");
    expect(replay.launchId).toBe(first.launchId);
    expect("replayed" in replay && replay.replayed === false).toBe(true);
    // Zero additional effect — the only new call is the one fresh snapshot
    // the second request takes; no mutation, no new prompt, no new intent.
    expect(fx.calls.slice(callCount)).toEqual([["api", "snapshot"]]);
    expect(fx.events.filter((event) => event === "mutation").length).toBeGreaterThan(0);
    expect(fx.prompts).toHaveLength(1);
    expect(await fx.intents.list(managerKey)).toHaveLength(1);
  });

  it("resumes a still-recorded intent under its original launchId", async () => {
    const fx = await harness();
    const begun = await fx.intents.begin({ managerSessionKey: managerKey, idempotencyKey: "idem-1", task, projectRoot: fx.projectRoot });
    if (begun.kind !== "launch") throw new Error("expected a launch verdict");
    const reply = await handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot)) as DaemonLaunchReply & { result: LaunchResult };
    expect("resumed" in reply && reply.resumed === true).toBe(true);
    expect(reply.launchId).toBe(begun.intent.launchId);
    expect(reply.state).toBe("completed");
    expect(fx.events.filter((event) => event === "mutation").length).toBeGreaterThan(0);
  });

  it("refuses the same idempotency key under a different task or project root", async () => {
    const fx = await harness();
    await handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot));
    await expect(handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot, { task: { ...task, objective: "different work entirely" } })))
      .rejects.toMatchObject({ daemonCode: "IDEMPOTENCY_KEY_CONFLICT" });
    const otherDir = join(fx.projectRoot, "..", "other-project");
    await mkdir(otherDir);
    const otherRoot = await realpath(otherDir);
    await expect(handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot, { projectRoot: otherRoot })))
      .rejects.toMatchObject({ daemonCode: "IDEMPOTENCY_KEY_CONFLICT" });
  });

  it("replays effecting, failed, and unresolved records with zero new effect", async () => {
    const fx = await harness();
    // effecting — an attempt owned by a crashed executor replays its state.
    const begun = await fx.intents.begin({ managerSessionKey: managerKey, idempotencyKey: "idem-1", task, projectRoot: fx.projectRoot });
    if (begun.kind !== "launch") throw new Error("expected launch");
    await fx.intents.markEffecting(begun.intent);
    const effecting = await handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot)) as DaemonLaunchReply;
    expect(effecting.state).toBe("effecting");
    expect(fx.events.filter((event) => event === "mutation")).toHaveLength(0);
    // failed — a proven-absent failure replays as failed, not a retry.
    const failedIntent = await fx.intents.begin({ managerSessionKey: managerKey, idempotencyKey: "idem-2", task, projectRoot: fx.projectRoot });
    if (failedIntent.kind !== "launch") throw new Error("expected launch");
    await fx.intents.markEffecting(failedIntent.intent);
    await fx.intents.fail(failedIntent.intent, { effectCertainty: "absent" });
    const failed = await handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot, { idempotencyKey: "idem-2" })) as DaemonLaunchReply;
    expect(failed.state).toBe("failed");
    // unresolved — the recorded children come back for reconciliation.
    const unresolvedIntent = await fx.intents.begin({ managerSessionKey: managerKey, idempotencyKey: "idem-3", task, projectRoot: fx.projectRoot });
    if (unresolvedIntent.kind !== "launch") throw new Error("expected launch");
    await fx.intents.markEffecting(unresolvedIntent.intent);
    await fx.intents.recordChildren(unresolvedIntent.intent, [{ name: "task-aa-1", runId: "11111111-2222-3333-4444-555555555555" }]);
    await fx.intents.fail(unresolvedIntent.intent, { effectCertainty: "partial", children: [{ name: "task-aa-1", runId: "11111111-2222-3333-4444-555555555555" }] });
    const unresolved = await handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot, { idempotencyKey: "idem-3" })) as DaemonLaunchReply;
    expect(unresolved.state).toBe("unresolved");
    expect(unresolved.children).toEqual([{ name: "task-aa-1", runId: "11111111-2222-3333-4444-555555555555" }]);
    expect(fx.events.filter((event) => event === "mutation")).toHaveLength(0);
  });

  it("lands partial launch effect certainty as unresolved — never a fabricated completion", async () => {
    const fx = await harness({ startErrors: { 1: Object.assign(new Error("start refused"), { code: "CLI_PROTOCOL_ERROR" }) } });
    const reply = await handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot, { task: { ...task, replicas: 2 } })) as DaemonLaunchReply & { result: LaunchResult };
    expect(reply.result.outcome).toBe("partial");
    expect(reply.state).toBe("unresolved");
    const intent = (await fx.intents.list(managerKey))[0]!;
    expect(intent.state).toBe("unresolved");
    expect(intent.effectCertainty).toBe("partial");
    expect(intent.resolution).toBe("effect_uncertain");
    // Both runs were durably recorded — the failed child's persist is itself evidence.
    expect(intent.children).toHaveLength(2);
  });

  it("lands unknown thrown-effect certainty as unresolved, and propagates the typed failure", async () => {
    // A launch-gate refusal throws without its own certainty evidence — the
    // daemon must not claim `absent` it cannot prove.
    const fx = await harness({ gateError: new Error("gate wedged") });
    await expect(handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot)))
      .rejects.toMatchObject({ daemonCode: "LAUNCH_FROZEN" });
    const intent = (await fx.intents.list(managerKey))[0]!;
    expect(intent.state).toBe("unresolved");
    expect(intent.effectCertainty).toBe("unknown");
    // The gate refused before the effecting boundary — no mutation happened.
    expect(fx.events.filter((event) => event === "mutation")).toHaveLength(0);
  });

  it("settles a routing abstention as completed — the decision ran, no child effect exists", async () => {
    const fx = await harness({ specError: new Error("jev unavailable") });
    const reply = await handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot)) as DaemonLaunchReply & { result: LaunchResult };
    expect(reply.result.outcome).toBe("abstained");
    expect(reply.state).toBe("completed");
    expect((await fx.intents.list(managerKey))[0]!.state).toBe("completed");
  });

  it("lands a proven-absent failure as failed — the intent is never left dangling", async () => {
    const fx = await harness({ routerLogError: new Error("disk full") });
    const reply = await handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot)) as DaemonLaunchReply & { result: LaunchResult };
    expect(reply.result.outcome).toBe("failed");
    expect(reply.result.error?.code).toBe("ROUTER_LOG_UNAVAILABLE");
    expect(reply.state).toBe("failed");
    const intent = (await fx.intents.list(managerKey))[0]!;
    expect(intent.state).toBe("failed");
    expect(intent.effectCertainty).toBe("absent");
    expect(intent.failureCode).toBe("ROUTER_LOG_UNAVAILABLE");
    expect(fx.events.indexOf("effecting")).toBeGreaterThanOrEqual(0);
    expect(fx.events.filter((event) => event === "mutation")).toHaveLength(0);
  });

  it("refuses a non-string project root before any intent work", async () => {
    const fx = await harness();
    await expect(handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot, { projectRoot: 7 })))
      .rejects.toMatchObject({ daemonCode: "PROJECT_ROOT_UNVERIFIED" });
    expect(await fx.intents.list(managerKey)).toEqual([]);
  });

  it("runs a recoveryOf through the intent allocator's open and fails closed on an unresolvable run", async () => {
    const fx = await harness();
    // A well-formed but nonexistent run: `deps.handoffs.open` resolves, the
    // state read fails, and the recovery refuses before any effect.
    await expect(handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot, { task: { ...task, recoveryOf: "11111111-2222-3333-4444-555555555555" } })))
      .rejects.toMatchObject({ daemonCode: "RECOVERY_UNRESOLVABLE" });
    const intent = (await fx.intents.list(managerKey))[0]!;
    // The thrown launch carried its own absent certainty — a proven no-effect failure.
    expect(intent.state).toBe("failed");
    expect(intent.effectCertainty).toBe("absent");
    expect(intent.failureCode).toBe("RECOVERY_UNRESOLVABLE");
    expect(fx.events.filter((event) => event === "mutation")).toHaveLength(0);
  });

  it("maps a settle-time intent failure into the typed refusal, after effects ran", async () => {
    const fx = await harness({
      intentsWrap: (intents) => {
        intents.complete = async () => { throw new DaemonIntentError("INTENT_STATE_CONFLICT", "state moved", { state: "failed" }); };
      },
    });
    await expect(handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot)))
      .rejects.toMatchObject({ daemonCode: "INTENT_STATE_CONFLICT" });
    // The launch itself ran to completion — the refusal is the ledger's, not the pipeline's.
    expect(fx.events.filter((event) => event === "mutation").length).toBeGreaterThan(0);
  });

  it("waits out a concurrent executor for the same binding instead of launching a duplicate", async () => {
    // Park the first request inside preflight — before the `effecting` write and
    // outside the intent lock — so the second request's `begin` still observes
    // `recorded` and takes the in-flight wait branch rather than a second launch.
    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let parked = true;
    let begins = 0;
    const fx = await harness({
      preflight: async () => { if (parked) { parked = false; await gate; } },
      intentsWrap: (intents) => {
        const base = intents.begin.bind(intents);
        intents.begin = async (begin) => { const verdict = await base(begin); begins += 1; return verdict; };
      },
    });
    const first = handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot));
    // The first request is inside execution — its flight key is registered.
    await vi.waitFor(() => expect(fx.runtime.inflight.size).toBe(1));
    const second = handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot));
    // The second request re-begins the still-recorded intent and parks on the
    // in-flight execution rather than mutating anything itself.
    await vi.waitFor(() => expect(begins).toBe(2));
    releaseFirst();
    const [firstReply, secondReply] = await Promise.all([first, second]) as DaemonLaunchReply[];
    expect(firstReply.state).toBe("completed");
    expect(secondReply.state).toBe("completed");
    expect(secondReply.launchId).toBe(firstReply.launchId);
    // Exactly one pipeline executed: one prompt, one set of mutations.
    expect(fx.prompts).toHaveLength(1);
    expect(await fx.intents.list(managerKey)).toHaveLength(1);
  });

  it("a concurrent waiter survives the first executor's failure and answers as a replay", async () => {
    // The first request parks in preflight; the second waits on the in-flight
    // execution, which then fails — the waiter re-begins and the settled
    // intent answers it rather than launching a duplicate.
    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let parked = true;
    let begins = 0;
    const fx = await harness({
      preflight: async () => {
        if (parked) { parked = false; await gate; throw new Error("preflight wedged"); }
      },
      intentsWrap: (intents) => {
        const base = intents.begin.bind(intents);
        intents.begin = async (begin) => { const verdict = await base(begin); begins += 1; return verdict; };
      },
    });
    const first = handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot));
    await vi.waitFor(() => expect(fx.runtime.inflight.size).toBe(1));
    const second = handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot));
    // The second request re-begins the still-recorded intent and parks on the
    // in-flight execution — only then is the first released to fail.
    await vi.waitFor(() => expect(begins).toBe(2));
    releaseFirst();
    // The pre-effect throw settles the intent `failed` with `absent` certainty.
    await expect(first).rejects.toMatchObject({ daemonCode: expect.any(String) });
    const secondReply = await second as DaemonLaunchReply;
    expect(secondReply.state).toBe("failed");
    // The waiter's replay carried the first attempt's launchId — no second execution ran.
    expect(fx.prompts).toHaveLength(0);
    expect(await fx.intents.list(managerKey)).toHaveLength(1);
  });

  it("records a persisted-then-failed child as ambiguous — reconcile's input, not a verdict", async () => {
    const fx = await harness({ mutationError: new Error("topology refused") });
    const reply = await handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot)) as DaemonLaunchReply & { result: LaunchResult };
    expect(reply.result.outcome).toBe("failed");
    const intent = (await fx.intents.list(managerKey))[0]!;
    // The run persisted before the topology mutation failed — partial effect,
    // and the recorded child is reconcile work, never auto-closed.
    expect(intent.state).toBe("unresolved");
    expect(intent.effectCertainty).toBe("partial");
    expect(intent.children).toEqual([{ name: expect.any(String), runId: expect.any(String), disposition: "ambiguous" }]);
  });

  it("settles a failed outcome carrying no top-level error and an invalid failure code", async () => {
    // Every child failing lands `outcome: failed` with no top-level error to code.
    const fx = await harness({ startErrors: { 0: Object.assign(new Error("refused"), { code: "lowercase-code" }) } });
    const reply = await handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot)) as DaemonLaunchReply & { result: LaunchResult };
    expect(reply.result.outcome).toBe("failed");
    const intent = (await fx.intents.list(managerKey))[0]!;
    expect(intent.state).toBe("unresolved");
    expect(intent.effectCertainty).toBe("partial");
    expect(intent.failureCode).toBeUndefined();
  });

  it("fails the launch closed when the before-first-effect intent write refuses", async () => {
    const fx = await harness({ effectingError: new DaemonIntentError("INTENT_STATE_CONFLICT", "state moved", { state: "failed" }) });
    const reply = await handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot)) as DaemonLaunchReply & { result: LaunchResult };
    expect(reply.result.outcome).toBe("failed");
    expect(reply.result.error?.code).toBe("LAUNCH_INTENT_REFUSED");
    const intent = (await fx.intents.list(managerKey))[0]!;
    expect(intent.state).toBe("failed");
    expect(intent.failureCode).toBe("LAUNCH_INTENT_REFUSED");
    expect(fx.events.filter((event) => event === "mutation")).toHaveLength(0);
  });

  it("releases an acquired launch-gate lease whose check refuses", async () => {
    const fx = await harness({ gateCheckError: new Error("frozen") });
    await expect(handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot)))
      .rejects.toMatchObject({ daemonCode: "LAUNCH_FROZEN" });
    expect(fx.gateRelease).toHaveBeenCalledTimes(1);
  });

  it("propagates a thrown launch's own code and missing certainty to the intent record", async () => {
    const fx = await harness({ gateError: "wedged" });
    await expect(handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot)))
      .rejects.toMatchObject({ daemonCode: "LAUNCH_FROZEN" });
    const intent = (await fx.intents.list(managerKey))[0]!;
    expect(intent.state).toBe("unresolved");
    // LAUNCH_FROZEN carries no effectCertainty in its details — normalized to unknown.
    expect(intent.effectCertainty).toBe("unknown");
    expect(intent.failureCode).toBe("LAUNCH_FROZEN");
  });

  it("executes through every pipeline default when the runtime wires no launch seams", async () => {
    // No launchDeps at all: the daemon-owned boundary still applies and every
    // host seam falls back to its production default.
    const fx = await harness({ noLaunchDeps: true });
    try {
      const reply = await handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot)) as DaemonLaunchReply;
      expect(reply.state).toBeDefined();
    } catch (error) {
      // Default preflight/spec paths may refuse in the fixture environment —
      // the refusal still lands on a typed, intent-settled boundary.
      expect(error).toMatchObject({ daemonCode: expect.any(String) });
    }
    expect(await fx.intents.list(managerKey)).toHaveLength(1);
  });

  it("reaches the pipeline's injected-dependency fallbacks on a bare launch tool", async () => {
    // A launch tool built like the host surfaces build it: no attachments,
    // handoffs, or clock injected — the production `??` defaults engage inside
    // executeChild. A throwing context resolver stops the child after those
    // defaults bind but before the default allocator can touch disk.
    const fx = await harness();
    const catalog = catalogOf(["pi-model"]);
    const tool = createLaunchTool({
      cli: { runJson: async () => ok("cli", {}), prompt: async () => ok("cli", {}) },
      context: { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" },
      contextResolver: async () => { throw new Error("unproven"); },
      preflight: async () => undefined,
      supervision: fx.supervision,
      specClient: { evaluate: async () => ({ kind: "response" as const, response: responseFor(catalog) }) },
      catalog: { load: async () => catalog },
      routerLog: vi.fn(async () => undefined),
      launchGate: openLaunchGate,
    });
    const signal = new AbortController().signal;
    const result = await tool.execute("bare", task, signal, undefined, { cwd: fx.projectRoot, signal } as never);
    const launched = result.details as LaunchResult;
    // The admitted route resolved with the default stores engaged; the child
    // failed closed at context resolution — no run was allocated anywhere.
    expect(launched.outcome).toBe("failed");
    expect(launched.children[0]?.state).toBe("failed");
    // A second execute reuses the module-level default allocator (`??=` left side).
    const second = await tool.execute("bare2", task, signal, undefined, { cwd: fx.projectRoot, signal } as never);
    expect((second.details as LaunchResult).children[0]?.state).toBe("failed");
  });

  it("registers the claude completion-signal callback on a claude runner", async () => {
    const quotaReader = vi.fn(async (): Promise<ClaudeQuotaSignal> => ({ retryNotBefore: null, zeroProgressProven: false }));
    const fx = await harness({ claude: true, claudeQuotaReader: quotaReader });
    const reply = await handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot)) as DaemonLaunchReply;
    expect(reply.state).toBe("completed");
    expect(fx.supervision.completionSignals).toHaveLength(1);
    const identity: SupervisedIdentity = {
      paneId: "w1:p2",
      terminalId: "terminal-x",
      agentName: "worker",
      agentKind: "claude",
      agentSession: { source: "herdr:claude", agent: "claude", kind: "id", value: "5ab55aa9-8ec3-47dd-896b-156ad524e7e6" },
    };
    const signal = fx.supervision.completionSignals[0]!;
    // A positive native signal records the cooldown through the injected recorder.
    await expect(signal(identity)).resolves.toEqual({ cooldownRecorded: true });
    expect(quotaReader).toHaveBeenCalledTimes(1);
    // A negative native signal is a plain false — no failure is recorded.
    quotaReader.mockResolvedValueOnce(false);
    await expect(signal(identity)).resolves.toBe(false);
    // A cooldown-write failure reports the typed false result — never a throw.
    fx.failureRecorder.mockRejectedValueOnce(new Error("disk full"));
    await expect(signal(identity)).resolves.toEqual({ cooldownRecorded: false });
  });

  it("a bare claude launch uses the default quota reader and failure recorder", async () => {
    // Host surfaces build the tool without a cwd, quota reader, or failure
    // recorder — the production `??` defaults engage inside the completion
    // callback: `claudeQuotaSignal`, `recordLaunchFailure`, and `ctx.cwd`.
    const fx = await harness({ claude: true });
    const launchDeps = { ...fx.runtime.launchDeps };
    delete launchDeps.availabilityFailureRecorder;
    const buildTool = (extra: Record<string, unknown> = {}) => createLaunchTool({
      ownership: fx.runtime.ownership,
      supervision: fx.supervision,
      queueFlush: fx.runtime.queueFlush,
      recipients: fx.runtime.recipients,
      preflight: async () => undefined,
      ...launchDeps,
      cli: fx.runtime.cli,
      context: { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" },
      handoffs: fx.runtime.allocator,
      ...extra,
    } as never);
    const signal = new AbortController().signal;
    const identity: SupervisedIdentity = {
      paneId: "w1:p2",
      terminalId: "terminal-x",
      agentName: "worker",
      agentKind: "claude",
      agentSession: { source: "herdr:claude", agent: "claude", kind: "id", value: "no-such-session-file" },
    };
    // The default quota reader resolves no native signal for a foreign session — plain false.
    const first = await buildTool().execute("claude-default-reader", task, signal, undefined, { cwd: fx.projectRoot, signal } as never);
    expect((first.details as LaunchResult).outcome).toBe("launched");
    await expect(fx.supervision.completionSignals[0]!(identity)).resolves.toBe(false);
    // The default recorder writes the cooldown under `ctx.cwd` (no `deps.cwd`).
    const second = await buildTool({ claudeQuotaReader: async () => ({ retryNotBefore: null, zeroProgressProven: false }) }).execute("claude-default-recorder", task, signal, undefined, { cwd: fx.projectRoot, signal } as never);
    expect((second.details as LaunchResult).outcome).toBe("launched");
    await expect(fx.supervision.completionSignals[1]!(identity)).resolves.toEqual({ cooldownRecorded: true });
  });
});

describe("daemon run handler", () => {
  it("verifies the caller before dispatch and validates each action's own shape", async () => {
    const fx = await harness();
    // No claim reaches the wire — even a well-formed action name refuses.
    await expect(handleDaemonRun(fx.runtime, { action: "transfer" })).rejects.toMatchObject({ daemonCode: "CALLER_IDENTITY_MALFORMED" });
    expect(fx.calls).toEqual([]);
    // Verified identity, then per-action shape validation.
    await expect(handleDaemonRun(fx.runtime, runParams({ action: "transfer" }))).rejects.toMatchObject({ daemonCode: "REQUEST_INVALID" });
    await expect(handleDaemonRun(fx.runtime, runParams({ action: "transfer", runIds: [] }))).rejects.toMatchObject({ daemonCode: "REQUEST_INVALID" });
    await expect(handleDaemonRun(fx.runtime, runParams({ action: "claim", runIds: ["11111111-2222-3333-4444-555555555555"] }))).rejects.toMatchObject({ daemonCode: "REQUEST_INVALID" });
    await expect(handleDaemonRun(fx.runtime, runParams({ action: "ack" }))).rejects.toMatchObject({ daemonCode: "REQUEST_INVALID" });
    expect(fx.calls.filter((call) => call[0] === "api")).toHaveLength(4);
  });

  it("dispatches transfer and claim through the journaled ownership change", async () => {
    const successorSession: AgentSessionIdentity = { source: "herdr:pi", agent: "pi", kind: "id", value: "succ-session" };
    const fx = await harness({
      caller: {
        panes: [{ pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", agent_name: "successor", agent: "pi", terminal_id: "t-succ", agent_session: successorSession, agent_status: "idle" }],
        agents: [{ pane_id: "w1:p2", name: "successor", agent: "pi", terminal_id: "t-succ", agent_session: successorSession, agent_status: "idle" }],
      },
    });
    const allocation = await boundRun(fx, { terminalId: "t-owned" });
    const reply = await handleDaemonRun(fx.runtime, runParams({ action: "transfer", runIds: [allocation.runId], successorPaneId: "w1:p2" }));
    expect(reply).toMatchObject({ kind: "run", action: "transfer" });
    const { transfer } = reply as { transfer: { transferId: string; runIds: string[]; fromKey: string; toKey: string; successor: { paneId: string } } };
    expect(transfer.transferId).toEqual(expect.any(String));
    expect(transfer.runIds).toEqual([allocation.runId]);
    expect(transfer.fromKey).toBe(managerKey);
    expect(transfer.toKey).toBe(managerSessionKey(successorSession));
    expect(transfer.successor.paneId).toBe("w1:p2");
    // The journaled record finished: no pending journal remains, and the
    // provenance now names the successor as the live owner.
    expect(await fx.runtime.daemonOwnership.pendingTransfers()).toEqual([]);

    // A claim without an owner instruction refuses typed through the same path.
    await expect(handleDaemonRun(fx.runtime, runParams({ action: "claim", runIds: [allocation.runId], incidentId: "incident-1" })))
      .rejects.toMatchObject({ daemonCode: "CLAIM_NOT_INSTRUCTED" });
  });

  it("dispatches a claim through the journaled ownership change once the owner left an instruction", async () => {
    const successorSession: AgentSessionIdentity = { source: "herdr:pi", agent: "pi", kind: "id", value: "succ-session" };
    const fx = await harness({
      caller: {
        // The prior owner is gone: its pane now resolves to a different session.
        pane: { agent_session: otherSession },
        agent: { agent_session: otherSession },
        panes: [{ pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", agent_name: "successor", agent: "pi", terminal_id: "t-succ", agent_session: successorSession, agent_status: "idle" }],
        agents: [{ pane_id: "w1:p2", name: "successor", agent: "pi", terminal_id: "t-succ", agent_session: successorSession, agent_status: "idle" }],
      },
    });
    const allocation = await boundRun(fx, { terminalId: "t-owned" });
    // The departed owner left a durable per-incident instruction naming this successor and exact run set.
    await mkdir(join(fx.namespace.dir, "claims"), { mode: 0o700, recursive: true });
    const record: ClaimRecord = { priorOwnerSession: managerSession, successorSession, runIds: [allocation.runId], instructedAt: new Date().toISOString(), instruction: "Recover these runs." };
    await writeFile(join(fx.namespace.dir, "claims", "inc-1.json"), JSON.stringify(record), { mode: 0o600 });
    const reply = await handleDaemonRun(fx.runtime, {
      identity: { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p2", agentSession: successorSession },
      action: "claim", runIds: [allocation.runId], incidentId: "inc-1",
    });
    expect(reply).toMatchObject({ kind: "run", action: "claim", transfer: { incidentId: "inc-1", runIds: [allocation.runId], fromKey: managerKey, toKey: managerSessionKey(successorSession) } });
    expect(await fx.runtime.daemonOwnership.pendingTransfers()).toEqual([]);
  });

  it("acks the caller's own mailbox event idempotently and refuses a malformed or foreign event", async () => {
    const fx = await harness();
    // Write one event into the caller's mailbox through the real mailbox writer.
    const allocation = await boundRun(fx, { terminalId: "t-evt" });
    const written = await fx.mailbox.writeRunEvent({ kind: "handoff_ready", runId: allocation.runId, jobId: "job-1" });
    expect(written).toMatchObject({ persisted: true });
    const ids = await fx.mailbox.list(managerKey);
    expect(ids).toHaveLength(1);
    const acked = await handleDaemonRun(fx.runtime, runParams({ action: "ack", eventId: ids[0] }));
    expect(acked).toEqual({ kind: "run", action: "ack", eventId: ids[0], result: "acked" });
    // Idempotent: a second ack of the same event is a success, not an error.
    const again = await handleDaemonRun(fx.runtime, runParams({ action: "ack", eventId: ids[0] }));
    expect(again).toEqual({ kind: "run", action: "ack", eventId: ids[0], result: "already-acked" });
    await expect(handleDaemonRun(fx.runtime, runParams({ action: "ack", eventId: "../escape" }))).rejects.toMatchObject({ daemonCode: expect.any(String) });
    await expect(handleDaemonRun(fx.runtime, runParams({ action: "ack", eventId: "evt-never-seen" }))).rejects.toMatchObject({ daemonCode: expect.any(String) });
  });

  it("observes a bound run and links it to the intent that recorded it", async () => {
    const fx = await harness();
    const reply = await handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot)) as DaemonLaunchReply;
    const intent = (await fx.intents.list(managerKey))[0]!;
    const runId = intent.children[0]!.runId!;
    // The child's retained artifact — observe requires it to exist.
    const run = await fx.allocator.open(runId);
    await writeFile(run.artifactPath, `herdr-run:${runId}\n\n## Status\ndone\n\n## Summary\nx\n\n## Changes\nNone\n\n## Verification\nok\n\n## Blockers\nNone\n\n## Continuation\nNone\n`, { mode: 0o600 });
    const observed = await handleDaemonRun(fx.runtime, runParams({ action: "observe", runId })) as { action: string; observation: { runId: string }; intent?: { launchId: string }; unread: string[] };
    expect(observed.action).toBe("observe");
    expect(observed.observation.runId).toBe(runId);
    expect(observed.intent?.launchId).toBe(reply.launchId);
    expect(observed.unread).toEqual([]);
  });

  it("refuses observe for a malformed or missing run, without inventing one", async () => {
    const fx = await harness();
    await expect(handleDaemonRun(fx.runtime, runParams({ action: "observe", runId: "not-a-run" })))
      .rejects.toMatchObject({ daemonCode: "REQUEST_INVALID" });
    await expect(handleDaemonRun(fx.runtime, runParams({ action: "observe", runId: 7 })))
      .rejects.toMatchObject({ daemonCode: "REQUEST_INVALID" });
    await expect(handleDaemonRun(fx.runtime, runParams({ action: "observe", runId: "11111111-2222-3333-4444-555555555555" })))
      .rejects.toBeDefined();
  });

  it("maps an allocator-open failure into the typed refusal", async () => {
    const fx = await harness();
    fx.runtime.allocator.open = async () => { throw new DaemonIntentError("INTENT_STORE_UNAVAILABLE", "gone"); };
    await expect(handleDaemonRun(fx.runtime, runParams({ action: "observe", runId: "11111111-2222-3333-4444-555555555555" })))
      .rejects.toMatchObject({ daemonCode: "INTENT_STORE_UNAVAILABLE" });
  });

  it("observes a durable run no intent child references — without an intent projection", async () => {
    const fx = await harness();
    const allocation = await boundRun(fx, { terminalId: "t-orphan" });
    await writeFile(allocation.artifactPath, `herdr-run:${allocation.runId}\n\n## Status\ndone\n\n## Summary\nx\n\n## Changes\nNone\n\n## Verification\nok\n\n## Blockers\nNone\n\n## Continuation\nNone\n`, { mode: 0o600 });
    const observed = await handleDaemonRun(fx.runtime, runParams({ action: "observe", runId: allocation.runId })) as { observation: { runId: string }; intent?: unknown };
    expect(observed.observation.runId).toBe(allocation.runId);
    expect(observed.intent).toBeUndefined();
  });

  it("projects the intent's resolution and reconciled mark on observe", async () => {
    const fx = await harness();
    const allocation = await boundRun(fx, { terminalId: "t-linked" });
    await writeFile(allocation.artifactPath, `herdr-run:${allocation.runId}\n\n## Status\ndone\n\n## Summary\nx\n\n## Changes\nNone\n\n## Verification\nok\n\n## Blockers\nNone\n\n## Continuation\nNone\n`, { mode: 0o600 });
    const begun = await fx.intents.begin({ managerSessionKey: managerKey, idempotencyKey: "idem-1", task, projectRoot: fx.projectRoot });
    if (begun.kind !== "launch") throw new Error("expected launch");
    const effecting = await fx.intents.markEffecting(begun.intent);
    await fx.intents.recordChildren(effecting, [{ name: "task-aa-1", runId: allocation.runId }]);
    await fx.intents.fail(effecting, { effectCertainty: "partial" });
    // Reconcile settles the recorded child against live evidence — the bound
    // child's terminal is absent, so it lands identity_lost and marks reconciled.
    await handleDaemonRun(fx.runtime, runParams({ action: "reconcile", idempotencyKey: "idem-1" }));
    const observed = await handleDaemonRun(fx.runtime, runParams({ action: "observe", runId: allocation.runId })) as { intent?: { resolution?: string; reconciled?: true } };
    expect(observed.intent).toMatchObject({ resolution: "effect_uncertain", reconciled: true });
  });

  it("reconciles an unresolved intent once every recorded child is accounted for", async () => {
    const liveSession: AgentSessionIdentity = { source: "herdr:pi", agent: "pi", kind: "id", value: "session-live" };
    const fx = await harness();
    // An unresolved intent with two recorded children: one live, one provably
    // absent. Reconcile classifies by the run's bound sidecar identity (D4's
    // rule — terminal + name + kind + session), never the recorded name alone.
    const live: Child = { paneId: "w1:p2", tabId: "w1:t1", name: "task-aa-1", kind: "pi", terminalId: "terminal-live", session: liveSession, prompt: true };
    fx.children.push(live);
    const liveRun = await boundRun(fx, { terminalId: "terminal-live", agentName: "task-aa-1", session: liveSession });
    const goneRun = await boundRun(fx, { terminalId: "terminal-gone", agentName: "task-aa-2" });
    const begun = await fx.intents.begin({ managerSessionKey: managerKey, idempotencyKey: "idem-1", task, projectRoot: fx.projectRoot });
    if (begun.kind !== "launch") throw new Error("expected launch");
    const intent = await fx.intents.markEffecting(begun.intent);
    await fx.intents.recordChildren(intent, [{ name: "task-aa-1", runId: liveRun.runId }, { name: "task-aa-2", runId: goneRun.runId }]);
    await fx.intents.fail(intent, { effectCertainty: "partial" });
    const reply = await handleDaemonRun(fx.runtime, runParams({ action: "reconcile", idempotencyKey: "idem-1" })) as { state: string; children: Array<{ name: string; disposition?: string }>; reconciled?: true };
    expect(reply.state).toBe("completed");
    expect(reply.reconciled).toBe(true);
    expect(reply.children).toEqual([
      { name: "task-aa-1", runId: liveRun.runId, disposition: "bound", evidence: expect.objectContaining({ reason: "live_bound" }) },
      { name: "task-aa-2", runId: goneRun.runId, disposition: "identity_lost", evidence: expect.objectContaining({ reason: "absent_from_snapshot" }) },
    ]);
    // The live match bound a supervisor through the shared reattach sequence.
    expect(fx.supervision.bound).toHaveLength(1);
    expect(fx.supervision.bound[0]!.identity).toMatchObject({ paneId: "w1:p2", terminalId: "terminal-live" });
  });

  it("keeps the intent unresolved while a recorded child is ambiguous", async () => {
    // Two distinct panes carry the recorded child name — nothing may be closed.
    const duplicateA = { pane_id: "w1:p3", tab_id: "w1:t1", workspace_id: "w1", agent_name: "task-aa-1" };
    const duplicateB = { pane_id: "w1:p4", tab_id: "w1:t1", workspace_id: "w1", agent_name: "task-aa-1" };
    const fx = await harness({ caller: { panes: [duplicateA, duplicateB] } });
    const begun = await fx.intents.begin({ managerSessionKey: managerKey, idempotencyKey: "idem-1", task, projectRoot: fx.projectRoot });
    if (begun.kind !== "launch") throw new Error("expected launch");
    const intent = await fx.intents.markEffecting(begun.intent);
    await fx.intents.recordChildren(intent, [{ name: "task-aa-1", runId: "11111111-2222-3333-4444-555555555555" }]);
    await fx.intents.fail(intent, { effectCertainty: "partial" });
    const reply = await handleDaemonRun(fx.runtime, runParams({ action: "reconcile", idempotencyKey: "idem-1" })) as { state: string; children: Array<{ disposition?: string }> };
    expect(reply.state).toBe("unresolved");
    expect(reply.children[0]!.disposition).toBe("ambiguous");
  });

  it("refuses reconcile for a missing intent or a malformed key, and rejects unknown actions", async () => {
    const fx = await harness();
    await expect(handleDaemonRun(fx.runtime, runParams({ action: "reconcile", idempotencyKey: "never-seen" })))
      .rejects.toMatchObject({ daemonCode: "INTENT_NOT_FOUND" });
    await expect(handleDaemonRun(fx.runtime, runParams({ action: "reconcile", idempotencyKey: "" })))
      .rejects.toMatchObject({ daemonCode: "REQUEST_INVALID" });
    await expect(handleDaemonRun(fx.runtime, runParams({ action: "teleport" })))
      .rejects.toMatchObject({ daemonCode: "REQUEST_INVALID" });
  });

  it("maps an unreadable run namespace into a typed refusal at open", async () => {
    const fx = await harness();
    await rm(fx.runsDir, { recursive: true, force: true });
    await expect(handleDaemonRun(fx.runtime, runParams({ action: "observe", runId: "11111111-2222-3333-4444-555555555555" })))
      .rejects.toMatchObject({ daemonCode: expect.any(String) });
  });

  it("maps an intent-store failure during observe into the typed refusal", async () => {
    const fx = await harness();
    const reply = await handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot)) as DaemonLaunchReply;
    const intent = (await fx.intents.list(managerKey))[0]!;
    const runId = intent.children[0]!.runId!;
    const run = await fx.allocator.open(runId);
    await writeFile(run.artifactPath, `herdr-run:${runId}\n\n## Status\ndone\n\n## Summary\nx\n\n## Changes\nNone\n\n## Verification\nok\n\n## Blockers\nNone\n\n## Continuation\nNone\n`, { mode: 0o600 });
    // Break the store after the launch — observe's intent projection must fail closed.
    fx.intents.list = async () => { throw new DaemonIntentError("INTENT_STORE_UNAVAILABLE", "gone"); };
    await expect(handleDaemonRun(fx.runtime, runParams({ action: "observe", runId })))
      .rejects.toMatchObject({ daemonCode: "INTENT_STORE_UNAVAILABLE" });
    expect(reply.launchId).toBe(intent.launchId);
  });

  it("returns a non-unresolved intent unchanged from reconcile — including its reconciled mark", async () => {
    const fx = await harness();
    const begun = await fx.intents.begin({ managerSessionKey: managerKey, idempotencyKey: "idem-1", task, projectRoot: fx.projectRoot });
    if (begun.kind !== "launch") throw new Error("expected launch");
    const effecting = await fx.intents.markEffecting(begun.intent);
    const completed = await fx.intents.complete(effecting, []);
    const first = await handleDaemonRun(fx.runtime, runParams({ action: "reconcile", idempotencyKey: "idem-1" })) as { state: string; reconciled?: true };
    expect(first.state).toBe("completed");
    expect(first.reconciled).toBeUndefined();
    // An already-reconciled record projects its mark without a transition.
    const unresolved = await fx.intents.begin({ managerSessionKey: managerKey, idempotencyKey: "idem-2", task, projectRoot: fx.projectRoot });
    if (unresolved.kind !== "launch") throw new Error("expected launch");
    const effecting2 = await fx.intents.markEffecting(unresolved.intent);
    const nine = await boundRun(fx, { terminalId: "terminal-nine", agentName: "task-aa-9" });
    await fx.intents.recordChildren(effecting2, [{ name: "task-aa-9", runId: nine.runId }]);
    await fx.intents.fail(effecting2, { effectCertainty: "partial" });
    await handleDaemonRun(fx.runtime, runParams({ action: "reconcile", idempotencyKey: "idem-2" }));
    const second = await handleDaemonRun(fx.runtime, runParams({ action: "reconcile", idempotencyKey: "idem-2" })) as { state: string; reconciled?: true };
    expect(second.state).toBe("completed");
    expect(second.reconciled).toBe(true);
    expect(completed.state).toBe("completed");
  });

  it("maps a reconcile-transition failure into the typed refusal", async () => {
    const fx = await harness({
      intentsWrap: (intents) => {
        const base = intents.reconcile.bind(intents);
        intents.reconcile = async (intent, dispositions) => {
          if (intent.state === "unresolved") throw new DaemonIntentError("INTENT_STATE_CONFLICT", "state moved", { state: "failed" });
          return base(intent, dispositions);
        };
      },
    });
    const begun = await fx.intents.begin({ managerSessionKey: managerKey, idempotencyKey: "idem-1", task, projectRoot: fx.projectRoot });
    if (begun.kind !== "launch") throw new Error("expected launch");
    const effecting = await fx.intents.markEffecting(begun.intent);
    await fx.intents.recordChildren(effecting, [{ name: "task-aa-1" }]);
    await fx.intents.fail(effecting, { effectCertainty: "partial" });
    await expect(handleDaemonRun(fx.runtime, runParams({ action: "reconcile", idempotencyKey: "idem-1" })))
      .rejects.toMatchObject({ daemonCode: "INTENT_STATE_CONFLICT" });
  });

  it("maps an intent lookup failure during reconcile into the typed refusal", async () => {
    const fx = await harness({
      intentsWrap: (intents) => {
        intents.get = async () => { throw new DaemonIntentError("INTENT_STORE_UNAVAILABLE", "gone"); };
      },
    });
    await expect(handleDaemonRun(fx.runtime, runParams({ action: "reconcile", idempotencyKey: "idem-1" })))
      .rejects.toMatchObject({ daemonCode: "INTENT_STORE_UNAVAILABLE" });
  });

  it("projects only the observed run's unread events — foreign-run and gap events stay out", async () => {
    const fx = await harness();
    const allocation = await boundRun(fx, { terminalId: "t-unread-mine" });
    const other = await boundRun(fx, { terminalId: "t-unread-other" });
    for (const run of [allocation, other]) {
      await writeFile(run.artifactPath, `herdr-run:${run.runId}\n\n## Status\ndone\n\n## Summary\nx\n\n## Changes\nNone\n\n## Verification\nok\n\n## Blockers\nNone\n\n## Continuation\nNone\n`, { mode: 0o600 });
    }
    const mine = await fx.mailbox.writeRunEvent({ kind: "work_cycle_completed", runId: allocation.runId, jobId: "job-1" });
    await fx.mailbox.writeRunEvent({ kind: "work_cycle_completed", runId: other.runId, jobId: "job-2" });
    await fx.mailbox.writeGapEvent(managerKey, { from: "2026-09-24T00:00:00.000Z", to: "2026-09-24T01:00:00.000Z", lost: {} });
    const observed = await handleDaemonRun(fx.runtime, runParams({ action: "observe", runId: allocation.runId })) as { unread: string[] };
    expect(observed.unread).toEqual([mine.eventId]);
  });

  it("fails observe closed on an unread listing or event read failure, skipping acked-away events", async () => {
    const fx = await harness();
    const allocation = await boundRun(fx, { terminalId: "t-unread-fail" });
    await writeFile(allocation.artifactPath, `herdr-run:${allocation.runId}\n\n## Status\ndone\n\n## Summary\nx\n\n## Changes\nNone\n\n## Verification\nok\n\n## Blockers\nNone\n\n## Continuation\nNone\n`, { mode: 0o600 });
    fx.runtime.bindMailbox({ ...fx.mailbox, list: async () => { throw new DaemonMailboxError("MAILBOX_UNAVAILABLE", "gone"); } });
    await expect(handleDaemonRun(fx.runtime, runParams({ action: "observe", runId: allocation.runId })))
      .rejects.toMatchObject({ daemonCode: "MAILBOX_UNAVAILABLE" });
    // An event acked between list and read is handled evidence, skipped.
    fx.runtime.bindMailbox({
      ...fx.mailbox,
      list: async () => ["evt-raced"],
      read: async () => { throw new DaemonMailboxError("MAILBOX_EVENT_NOT_FOUND", "gone"); },
    });
    const settled = await handleDaemonRun(fx.runtime, runParams({ action: "observe", runId: allocation.runId })) as { unread: string[] };
    expect(settled.unread).toEqual([]);
    // Every other read failure fails the call closed.
    fx.runtime.bindMailbox({
      ...fx.mailbox,
      list: async () => ["evt-bad"],
      read: async () => { throw new DaemonMailboxError("MAILBOX_UNAVAILABLE", "corrupt"); },
    });
    await expect(handleDaemonRun(fx.runtime, runParams({ action: "observe", runId: allocation.runId })))
      .rejects.toMatchObject({ daemonCode: "MAILBOX_UNAVAILABLE" });
  });

  it("refuses a transfer that omits the successor pane", async () => {
    const fx = await harness();
    const allocation = await boundRun(fx, { terminalId: "t-no-successor" });
    await expect(handleDaemonRun(fx.runtime, runParams({ action: "transfer", runIds: [allocation.runId] })))
      .rejects.toMatchObject({ daemonCode: "REQUEST_INVALID" });
  });

  it("does not rebind a run a live supervisor already covers", async () => {
    const liveSession: AgentSessionIdentity = { source: "herdr:pi", agent: "pi", kind: "id", value: "session-covered" };
    const fx = await harness();
    fx.children.push({ paneId: "w1:p2", tabId: "w1:t1", name: "task-aa-1", kind: "pi", terminalId: "t-covered", session: liveSession, prompt: true });
    const liveRun = await boundRun(fx, { terminalId: "t-covered", agentName: "task-aa-1", session: liveSession });
    const begun = await fx.intents.begin({ managerSessionKey: managerKey, idempotencyKey: "idem-1", task, projectRoot: fx.projectRoot });
    if (begun.kind !== "launch") throw new Error("expected launch");
    const intent = await fx.intents.markEffecting(begun.intent);
    await fx.intents.recordChildren(intent, [{ name: "task-aa-1", runId: liveRun.runId }]);
    await fx.intents.fail(intent, { effectCertainty: "partial" });
    vi.spyOn(fx.runtime.jobs, "activeSupervisorFor").mockReturnValue({ jobId: "job-live" } as never);
    const reply = await handleDaemonRun(fx.runtime, runParams({ action: "reconcile", idempotencyKey: "idem-1" })) as { state: string };
    expect(reply.state).toBe("completed");
    // The supervisor already covering the identity stayed authoritative.
    expect(fx.supervision.bound).toHaveLength(0);
  });

  it("reconciles through the assembly's own supervision when no launch seam is wired", async () => {
    const liveSession: AgentSessionIdentity = { source: "herdr:pi", agent: "pi", kind: "id", value: "session-noDeps" };
    const fx = await harness({ noLaunchDeps: true });
    fx.children.push({ paneId: "w1:p2", tabId: "w1:t1", name: "task-aa-1", kind: "pi", terminalId: "t-nodeps", session: liveSession, prompt: true });
    const liveRun = await boundRun(fx, { terminalId: "t-nodeps", agentName: "task-aa-1", session: liveSession });
    // A run whose provenance record is absent still binds — the digest simply
    // has no contract to rebuild.
    await rm(join(liveRun.toolsDir, "provenance.json"));
    const registry = fx.runtime.supervision;
    (fx.supervision as StubSupervision & { shutdown?: () => Promise<void> }).shutdown = () => registry.shutdown();
    (fx.runtime as { supervision: unknown }).supervision = fx.supervision;
    const begun = await fx.intents.begin({ managerSessionKey: managerKey, idempotencyKey: "idem-1", task, projectRoot: fx.projectRoot });
    if (begun.kind !== "launch") throw new Error("expected launch");
    const intent = await fx.intents.markEffecting(begun.intent);
    await fx.intents.recordChildren(intent, [{ name: "task-aa-1", runId: liveRun.runId }]);
    await fx.intents.fail(intent, { effectCertainty: "partial" });
    const reply = await handleDaemonRun(fx.runtime, runParams({ action: "reconcile", idempotencyKey: "idem-1" })) as { state: string; children: Array<{ disposition?: string }> };
    expect(reply.state).toBe("completed");
    expect(reply.children[0]!.disposition).toBe("bound");
    expect(fx.supervision.bound).toHaveLength(1);
  });
});

describe("daemon status handler", () => {
  it("reports daemon health, caller intents unresolved-first, runs, and the unread placeholder", async () => {
    const fx = await harness();
    // One completed launch, plus an unresolved intent — the status surface
    // must put the unresolved one first.
    const reply = await handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot)) as DaemonLaunchReply;
    const begun = await fx.intents.begin({ managerSessionKey: managerKey, idempotencyKey: "idem-2", task, projectRoot: fx.projectRoot });
    if (begun.kind !== "launch") throw new Error("expected launch");
    const pending = await fx.intents.markEffecting(begun.intent);
    await fx.intents.fail(pending, { effectCertainty: "partial" });
    await writeFile(join(fx.namespace.dir, "daemon.json"), JSON.stringify({ startedAt: "2026-09-24T12:00:00.000Z", heartbeat: "2026-09-24T12:00:30.000Z", capacity: "ok" }), { mode: 0o600 });
    const status = await handleDaemonStatus(fx.runtime, runParams()) as { daemon: { status: string; startedAt?: string }; intents: Array<{ state: string; launchId: string }>; runs: Array<{ runId: string; lifecycle: string; review: string; child: { presence: string } }>; unread: { count: number; ids: string[] }; mailbox: string; capacity: unknown };
    expect(status.daemon).toMatchObject({ status: "running", startedAt: "2026-09-24T12:00:00.000Z" });
    expect(status.intents.map((intent) => intent.state)).toEqual(["unresolved", "completed"]);
    expect(status.intents[1]!.launchId).toBe(reply.launchId);
    const intent = (await fx.intents.list(managerKey)).find((entry) => entry.launchId === reply.launchId)!;
    expect(status.runs).toEqual([{ runId: intent.children[0]!.runId, lifecycle: "awaiting_handoff", review: "paused", child: expect.objectContaining({ presence: "present" }) }]);
    expect(status.unread).toEqual({ count: 0, ids: [] });
    expect(status.mailbox).toBe(join(fx.namespace.dir, DAEMON_MAILBOX_DIR_NAME, managerKey));
    expect(status.capacity).toBe("ok");
  });

  it("scopes intents to the verified caller's manager session only", async () => {
    const fx = await harness();
    await handleDaemonLaunch(fx.runtime, launchParams(fx.projectRoot));
    const otherKey = managerSessionKey(otherSession);
    await fx.intents.begin({ managerSessionKey: otherKey, idempotencyKey: "other", task, projectRoot: fx.projectRoot });
    const status = await handleDaemonStatus(fx.runtime, runParams()) as { intents: Array<{ idempotencyKey: string }> };
    expect(status.intents.map((intent) => intent.idempotencyKey)).toEqual(["idem-1"]);
  });

  it("reports a missing daemon.json as missing — never a fabricated health record", async () => {
    const fx = await harness();
    const status = await handleDaemonStatus(fx.runtime, runParams()) as { daemon: { status: string } };
    expect(status.daemon.status).toBe("missing");
  });

  it("projects every daemon.json field and treats unreadable or unshaped records as missing", async () => {
    const fx = await harness();
    const daemonJson = join(fx.namespace.dir, "daemon.json");
    await writeFile(daemonJson, JSON.stringify({ startedAt: "t0", heartbeat: "t1", lastStoppedAt: "t2", capacity: "ok", unpersisted: ["a"], pendingGap: 3 }), { mode: 0o600 });
    const full = await handleDaemonStatus(fx.runtime, runParams()) as { daemon: Record<string, unknown>; capacity: unknown };
    expect(full.daemon).toMatchObject({ status: "running", startedAt: "t0", heartbeat: "t1", lastStoppedAt: "t2", capacity: "ok", unpersisted: ["a"], pendingGap: 3 });
    expect(full.capacity).toBe("ok");

    // Malformed JSON and non-record payloads both read as `missing`, never invented health.
    await writeFile(daemonJson, "{not json", { mode: 0o600 });
    expect((await handleDaemonStatus(fx.runtime, runParams()) as { daemon: { status: string } }).daemon.status).toBe("missing");
    await writeFile(daemonJson, JSON.stringify([1, 2]), { mode: 0o600 });
    expect((await handleDaemonStatus(fx.runtime, runParams()) as { daemon: { status: string } }).daemon.status).toBe("missing");

    // A bare record is `running` with no optional fields projected.
    await writeFile(daemonJson, "{}", { mode: 0o600 });
    const bare = await handleDaemonStatus(fx.runtime, runParams()) as { daemon: Record<string, unknown>; capacity: unknown };
    expect(bare.daemon).toEqual({ status: "running" });
    expect(bare.capacity).toBe("ok");

    // Settled intents project their durable marks — failure code and the reconcile stamp.
    const begun = await fx.intents.begin({ managerSessionKey: managerKey, idempotencyKey: "idem-1", task, projectRoot: fx.projectRoot });
    if (begun.kind !== "launch") throw new Error("expected launch");
    const effecting = await fx.intents.markEffecting(begun.intent);
    const child = { name: "task-aa-1", runId: "11111111-2222-3333-4444-555555555555" };
    await fx.intents.recordChildren(effecting, [child]);
    const unresolved = await fx.intents.fail(effecting, { effectCertainty: "partial", failureCode: "LAUNCH_FROZEN", children: [child] });
    await fx.intents.reconcile(unresolved, [{ ...child, disposition: "identity_lost" }]);
    const projected = (await handleDaemonStatus(fx.runtime, runParams())).intents[0]!;
    expect(projected).toMatchObject({ failureCode: "LAUNCH_FROZEN", reconciled: true, effectCertainty: "partial" });
  });

  it("refuses status when the daemon record cannot be read and when intents cannot be listed", async () => {
    const fx = await harness();
    const daemonJson = join(fx.namespace.dir, "daemon.json");
    await writeFile(daemonJson, "{}", { mode: 0o600 });
    await chmod(daemonJson, 0o000);
    try {
      await expect(handleDaemonStatus(fx.runtime, runParams())).rejects.toMatchObject({ daemonCode: expect.any(String) });
    } finally {
      await chmod(daemonJson, 0o600);
    }

    const wrapped = await harness({
      intentsWrap: (intents) => {
        intents.list = async () => { throw new DaemonIntentError("INTENT_STORE_UNAVAILABLE", "gone"); };
      },
    });
    await expect(handleDaemonStatus(wrapped.runtime, runParams())).rejects.toMatchObject({ daemonCode: "INTENT_STORE_UNAVAILABLE" });
  });

  it("classifies each recorded child's presence against the verified snapshot", async () => {
    const liveSession: AgentSessionIdentity = { source: "herdr:pi", agent: "pi", kind: "id", value: "sess-live" };
    const fx = await harness({
      caller: {
        panes: [
          // Two panes sharing one terminal make a bound identity ambiguous.
          { pane_id: "w1:p5", tab_id: "w1:t1", workspace_id: "w1", agent_name: "dup-a", terminal_id: "t-dup", agent_session: liveSession, agent_status: "idle" },
          { pane_id: "w1:p6", tab_id: "w1:t1", workspace_id: "w1", agent_name: "dup-b", terminal_id: "t-dup", agent_session: liveSession, agent_status: "idle" },
          // A pane whose occupant carries no session — the live identity read
          // refuses, so presence fails closed to absent.
          { pane_id: "w1:p7", tab_id: "w1:t1", workspace_id: "w1", agent_name: "contra", terminal_id: "t-contra", agent_status: "idle" },
          // A present, consistent identity that does not match the bound record.
          { pane_id: "w1:p8", tab_id: "w1:t1", workspace_id: "w1", agent_name: "moved", terminal_id: "t-moved", agent_session: { ...liveSession, value: "sess-moved" }, agent_status: "idle" },
        ],
        agents: [
          { pane_id: "w1:p7", name: "contra", agent: "pi", terminal_id: "t-contra", agent_status: "idle" },
          { pane_id: "w1:p8", name: "moved", agent: "pi", terminal_id: "t-moved", agent_session: { ...liveSession, value: "sess-moved" }, agent_status: "idle" },
        ],
      },
    });
    const begin = await fx.intents.begin({ managerSessionKey: managerKey, idempotencyKey: "idem-1", task, projectRoot: fx.projectRoot });
    if (begin.kind !== "launch") throw new Error("expected launch");
    const effecting = await fx.intents.markEffecting(begin.intent);

    // Four run shapes: unbound, bound-to-absent-terminal, ambiguous, contradictory, and mismatched.
    const unbound = await persistRun(fx);
    const absent = await boundRun(fx, { terminalId: "t-absent", agentName: "gone" });
    const ambiguous = await boundRun(fx, { terminalId: "t-dup", agentName: "dup" });
    const contradictory = await boundRun(fx, { terminalId: "t-contra", agentName: "contra" });
    const moved = await boundRun(fx, { terminalId: "t-moved", agentName: "task-aa-1", session: liveSession });
    const ghost = "11111111-2222-3333-4444-555555555555";
    await fx.intents.recordChildren(effecting, [
      { name: "c-unbound", runId: unbound.runId },
      { name: "c-absent", runId: absent.runId },
      { name: "c-ambiguous", runId: ambiguous.runId },
      { name: "c-contra", runId: contradictory.runId },
      { name: "c-moved", runId: moved.runId },
      { name: "c-ghost", runId: ghost },
      { name: "c-norun" },
    ]);
    const status = await handleDaemonStatus(fx.runtime, runParams()) as { runs: Array<{ runId: string; lifecycle: string; child: { presence: string } }> };
    const presence = new Map(status.runs.map((run) => [run.runId, run.child.presence]));
    expect(presence.get(unbound.runId)).toBe("absent");
    expect(presence.get(absent.runId)).toBe("absent");
    expect(presence.get(ambiguous.runId)).toBe("ambiguous");
    expect(presence.get(contradictory.runId)).toBe("absent");
    expect(presence.get(moved.runId)).toBe("absent");
    expect(status.runs.find((run) => run.runId === ghost)?.lifecycle).toBe("unavailable");
  });

  it("derives run review state from live supervisor jobs", async () => {
    const runActive = "22222222-3333-4444-5555-666666666666";
    const runPaused = "33333333-4444-5555-6666-777777777777";
    const jobs: Record<string, Record<string, unknown> | undefined> = {
      j1: undefined,
      j2: { operation_phase: "running" },
      j3: { operation_phase: "running", handoff: { gated: false, reason: "no_run" } },
      j4: { operation_phase: "running", handoff: { gated: true, runId: runActive } },
      j5: { operation_phase: "settled", handoff: { gated: true, runId: runActive } },
      j6: { operation_phase: "settled", handoff: { gated: true, runId: runPaused } },
    };
    const fx = await harness({
      jobs: {
        list: (() => ({ jobs: Object.keys(jobs).map((jobId) => ({ jobId })) })) as never,
        get: ((jobId: string) => jobs[jobId]) as never,
        shutdown: () => undefined,
      },
    });
    const begin = await fx.intents.begin({ managerSessionKey: managerKey, idempotencyKey: "idem-1", task, projectRoot: fx.projectRoot });
    if (begin.kind !== "launch") throw new Error("expected launch");
    const effecting = await fx.intents.markEffecting(begin.intent);
    await fx.intents.recordChildren(effecting, [{ name: "c-a", runId: runActive }, { name: "c-p", runId: runPaused }]);
    const status = await handleDaemonStatus(fx.runtime, runParams()) as { runs: Array<{ runId: string; lifecycle: string; review: string }> };
    // The runs are unreadable on disk — lifecycle `unavailable` — but review
    // still comes from the live job registry.
    expect(status.runs.find((run) => run.runId === runActive)?.review).toBe("active");
    expect(status.runs.find((run) => run.runId === runPaused)?.review).toBe("paused");
  });

  it("projects one mailbox event body for a named eventId — read-only, nothing acked", async () => {
    const fx = await harness();
    const allocation = await boundRun(fx, { terminalId: "t-evt" });
    const written = await fx.mailbox.writeRunEvent({ kind: "work_cycle_completed", runId: allocation.runId, jobId: "job-1" });
    const status = await handleDaemonStatus(fx.runtime, runParams({ eventId: written.eventId })) as { unread: { ids: string[] }; event?: Record<string, unknown> };
    expect(status.unread.ids).toEqual([written.eventId]);
    expect(status.event).toMatchObject({ id: written.eventId, runId: allocation.runId });
    // A second identical read proves the projection mutates nothing.
    const again = await handleDaemonStatus(fx.runtime, runParams({ eventId: written.eventId })) as { event?: { id?: string } };
    expect(again.event?.id).toBe(written.eventId);
    expect(await fx.mailbox.list(managerKey)).toEqual([written.eventId]);
  });

  it("refuses a non-string or absent eventId, a failed listing, and a broken journal projection", async () => {
    const fx = await harness();
    await expect(handleDaemonStatus(fx.runtime, runParams({ eventId: 42 })))
      .rejects.toMatchObject({ daemonCode: "REQUEST_INVALID" });
    await expect(handleDaemonStatus(fx.runtime, runParams({ eventId: mailboxEventId() })))
      .rejects.toMatchObject({ daemonCode: expect.any(String) });
    fx.runtime.bindMailbox({ ...fx.mailbox, list: async () => { throw new DaemonMailboxError("MAILBOX_UNAVAILABLE", "gone"); } });
    await expect(handleDaemonStatus(fx.runtime, runParams()))
      .rejects.toMatchObject({ daemonCode: "MAILBOX_UNAVAILABLE" });
    fx.runtime.bindMailbox(fx.mailbox);
    // A journal root that is not a directory fails the projection closed.
    await writeFile(join(fx.namespace.dir, "transfers"), "not a dir", { mode: 0o600 });
    await expect(handleDaemonStatus(fx.runtime, runParams()))
      .rejects.toMatchObject({ daemonCode: expect.any(String) });
  });
});
