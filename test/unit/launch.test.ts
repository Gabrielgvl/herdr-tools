import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CliProtocolError, type JsonEnvelope } from "../../src/cli.js";
import { parseCatalog, type AvailabilitySubject, type Catalog, type OperatingPoint, type RunnerEntry, type RunnerKind } from "../../src/catalog.js";
import { PublishedLaunchParamsSchema, LaunchTaskSchema, renderTask, type LaunchTask } from "../../src/launch-schema.js";
import { SPEC_BASELINE } from "../../src/spec-baseline.js";
import { createLaunchTool, launchTestInternals, validateLaunchParams, type LaunchCli, type LaunchDependencies, type LaunchResult, type LaunchRouterLog } from "../../src/tools/launch.js";
import { routeTask } from "../../src/router.js";
import type { RoutingTask, TaskModelDecision } from "../../src/router.js";
import type { HerdrSnapshot } from "../../src/targets.js";
import { parsePromptTargetIdentityFields } from "../../src/messages/prompt.js";
import type { AttachmentStore } from "../../src/messages/store.js";
import { createHandoffAllocator, HANDOFF_PROVENANCE_NAME, readHandoffState, updateHandoffState, type HandoffAllocation, type HandoffAllocator, type HandoffRunIdentity, type HandoffState, type HandoffStatus } from "../../src/handoff.js";
import { POLICY_REVISION, type QualityTier, type WorkspaceState } from "../../src/routing-policy.js";
import type { TypeSafeSpecClient } from "../../src/typesafe-spec.js";
import type { SupervisionReserveRequest } from "../../src/supervision/registry.js";
import { SupervisionBindError } from "../../src/supervision/supervisor.js";
import { canonicalJson, EVIDENCE_ASSIGNMENT_MAX_BYTES } from "../../src/supervision/evidence.js";
import type { WorktreeManager } from "../../src/worktree.js";
import { RecipientRegistry } from "../../src/messages/recipients.js";
import { attachmentCapability, handoffWriteCapability } from "../../src/profiles/capability.js";
import { parseProfile, profileSource, refreshBundledProfileResourceSelection, SKILL_BUNDLE_REGISTRY_FILE, skillTreeDigest, validateProfileResourceSelection } from "../../src/profiles/index.js";
import { stubSupervision, type StubSupervision } from "./supervision-fixtures.js";

/** A real directory: the runtime canonicalizes `cwd` before any effect. */
const repoRoot = realpathSync(process.cwd());
const context = { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" };
const extensionContext = { cwd: repoRoot, signal: new AbortController().signal } as ExtensionContext;
const TASK = {
  objective: "Reduce the latency without changing the public contract.",
  scope: "Only the assigned worktree.",
  doneWhen: ["The assigned objective is complete and verified."],
  constraints: ["Do not broaden the assignment."],
};
const ok = (id: string, result: unknown): JsonEnvelope => ({ id, result });

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

function agyRunner(modelIds: readonly string[]): RunnerEntry {
  return {
    kind: "agy",
    models: modelIds.map((model) => ({ model })),
    quota: { provider: "google", billingProduct: "antigravity", account: "primary", scope: "account" },
    defaults: { timeoutMinutes: 30, sessionPersistence: true, mode: "plan" },
    plumbing: { sessionPersistence: "required", promptDelivery: "bootstrap", skillSelection: "ambient", toolSelection: "ambient" },
    pools: { tools: [], extensions: [], skills: [], plugins: [], mcp: [] },
  };
}

function devinRunner(modelIds: readonly string[]): RunnerEntry {
  return {
    kind: "devin",
    models: modelIds.map((model) => ({ model })),
    quota: { provider: "test-provider", billingProduct: "test-product", account: "test-account", scope: "project" },
    defaults: { timeoutMinutes: 30, sessionPersistence: true, permissionMode: "dangerous" },
    plumbing: { sessionPersistence: "required", promptDelivery: "none", skillSelection: "ambient", toolSelection: "ambient" },
    pools: { tools: [], extensions: [], skills: [], plugins: [], mcp: [] },
  };
}

function catalogOf(subjects: readonly AvailabilitySubject[], runners?: ReadonlyMap<RunnerKind, RunnerEntry>): Catalog {
  const models = subjects.filter((subject) => subject.runner === "pi").map((subject) => subject.model);
  const resolvedRunners = runners ?? new Map<RunnerKind, RunnerEntry>([["pi", runnerEntry(models)]]);
  // One reviewed operating point per subject, in the caller's order.
  // Reasoned runners get their default level; every point sits inside the
  // lowest cost/latency class so the fixtures pass any tier envelope.
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

function task(overrides: Partial<LaunchTask> = {}): LaunchTask {
  return { ...TASK, ...overrides };
}

/** The internal label/count remnant the router seam still annotates. */
function spec(): { label: string; count: number } {
  return { label: "worker", count: 1 };
}

/** The normalized Task response the fixtures admit: verifiable done-when, confident implement intent, per-runner resource picks, and descending point fitness so the generated chain keeps catalog order. */
function responseFor(catalog: Catalog, quality: { done_when_verifiable?: number } = {}): TaskModelDecision {
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
    quality: { done_when_verifiable: quality.done_when_verifiable ?? 0.95 },
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

function fakeHandoffs(): HandoffAllocator {
  return {
    allocate: vi.fn(async () => {
      const runId = randomUUID();
      const directory = join(tmpdir(), `herdr-b8-${runId}`);
      return { runId, namespaceDir: tmpdir(), endpoint: "test-endpoint", directory, artifactPath: join(directory, "handoff.md"), toolsDir: join(directory, ".tools"), statePath: join(directory, ".tools", "state.json"), lockPath: join(directory, ".tools", "lock"), marker: `herdr-run:${runId}` };
    }),
    open: vi.fn(async (runId) => {
      const directory = join(tmpdir(), runId);
      return { runId, namespaceDir: tmpdir(), endpoint: "test-endpoint", directory, artifactPath: join(directory, "handoff.md"), toolsDir: join(directory, ".tools"), statePath: join(directory, ".tools", "state.json"), lockPath: join(directory, ".tools", "lock"), marker: `herdr-run:${runId}` };
    }),
    persist: vi.fn(async () => undefined),
    selectCandidate: vi.fn(async () => undefined),
  };
}

type Child = { paneId: string; tabId: string; name: string; kind: string; terminalId: string; session: { source: string; agent: string; kind: string; value: string }; prompt: boolean; agentId?: string };

function makeCli(options: {
  start?: (argv: string[], attempt: number) => JsonEnvelope | never;
  shell?: (argv: string[], signal: AbortSignal) => Promise<JsonEnvelope>;
  /** Models the live-but-unready verdict: the child stays bound to the pane even when the scripted start throws. */
  startLeavesBoundAgent?: boolean;
  failedPane?: Record<string, unknown>;
  paneError?: unknown;
  splitError?: unknown;
  splitWithoutTab?: boolean;
  agentError?: unknown;
  readinessError?: unknown;
  agentId?: string;
  prompt?: (target: string, text: string) => JsonEnvelope;
  metadataError?: unknown;
  existingPane?: Child;
  tabWithoutPane?: boolean;
  /** Authoritative records for the caller pane w1:p1, plus optional sibling evidence. */
  caller?: { pane?: Record<string, unknown>; panes?: Record<string, unknown>[]; agents?: Record<string, unknown>[] };
} = {}): { cli: LaunchCli; calls: string[][]; prompts: string[]; children: Child[]; starts: number } {
  const calls: string[][] = [];
  const prompts: string[] = [];
  const children: Child[] = [];
  let nextPane = 2;
  let active: Child | undefined = options.existingPane;
  let starts = 0;

  const snapshot = (): HerdrSnapshot => ({
    version: "0.8.0",
    protocol: 22,
    workspaces: [{ workspace_id: "w1", label: "workspace", focused: true }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main", focused: true }],
    panes: [
      { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "caller", agent_status: "idle", ...(options.caller?.pane ?? {}) },
      ...(options.caller?.panes ?? []) as HerdrSnapshot["panes"],
      ...children.map((child) => ({ pane_id: child.paneId, tab_id: child.tabId, workspace_id: "w1", label: child.name, agent_name: child.name, agent: child.kind, terminal_id: child.terminalId, agent_session: child.session, agent_status: child.prompt ? "working" : "idle", state_change_seq: child.prompt ? 8 : 7, revision: child.prompt ? 4 : 3, interactive_ready: true, ...(child.agentId === undefined ? {} : { agent_id: child.agentId }) })),
    ],
    agents: [
      ...(options.caller?.agents ?? []) as HerdrSnapshot["agents"],
      ...children.map((child) => ({ pane_id: child.paneId, name: child.name, agent: child.kind, terminal_id: child.terminalId, agent_session: child.session, agent_status: child.prompt ? "working" : "idle", state_change_seq: child.prompt ? 8 : 7, revision: child.prompt ? 4 : 3, interactive_ready: true, ...(child.agentId === undefined ? {} : { agent_id: child.agentId }) })),
    ],
  });

  const cli: LaunchCli = {
    prompt: vi.fn(async (target, text) => {
      calls.push(["agent", "prompt", target]);
      prompts.push(text);
      if (options.prompt !== undefined) {
        if (active !== undefined) active.prompt = true;
        return options.prompt(target, text);
      }
      if (active === undefined) throw new Error("no active child");
      active.prompt = true;
      return ok("prompt", { type: "agent_prompted", agent: agentRecord(active) });
    }),
    runJson: vi.fn(async (argv, signal) => {
      calls.push(argv);
      if (argv[0] === "pane" && (argv[1] === "send-text" || argv[1] === "wait-output")) {
        if (options.shell !== undefined) return options.shell(argv, signal);
        return ok("shell", argv[1] === "send-text" ? {} : { type: "output_matched", pane_id: argv[2], matched_line: argv[4] });
      }
      if (argv[0] === "pane" && argv[1] === "current") return ok("current", { type: "pane_current", pane: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" } });
      if (argv[0] === "api") return ok("snapshot", { type: "session_snapshot", snapshot: snapshot() });
      if (argv[0] === "pane" && argv[1] === "split") {
        if (options.splitError !== undefined) throw options.splitError;
        const paneId = `w1:p${nextPane++}`;
        active = { paneId, tabId: "w1:t1", name: "", kind: "pi", terminalId: `terminal-${paneId}`, session: { source: "herdr:pi", agent: "pi", kind: "id", value: `session-${paneId}` }, prompt: false };
        return ok("split", { pane: { pane_id: paneId, ...(options.splitWithoutTab ? {} : { tab_id: "w1:t1" }), workspace_id: "w1" } });
      }
      if (argv[0] === "pane" && argv[1] === "rename") return ok("rename", {});
      if (argv[0] === "tab" && argv[1] === "create") {
        const paneId = `w1:p${nextPane++}`;
        active = { paneId, tabId: "w1:t2", name: "", kind: "pi", terminalId: `terminal-${paneId}`, session: { source: "herdr:pi", agent: "pi", kind: "id", value: `session-${paneId}` }, prompt: false };
        return ok("tab", { tab: { tab_id: "w1:t2", workspace_id: "w1" }, ...(options.tabWithoutPane ? {} : { root_pane: { pane_id: paneId, tab_id: "w1:t2", workspace_id: "w1" } }) });
      }
      if (argv[0] === "tab" && argv[1] === "get") return ok("tab-get", { pane: { pane_id: active?.paneId, tab_id: active?.tabId, workspace_id: "w1" } });
      if (argv[0] === "agent" && argv[1] === "start") {
        const attempt = starts++;
        if (active === undefined) throw new Error("no pane");
        active.name = String(argv[2]);
        active.kind = String(argv[4]);
        active.session = { source: `herdr:${active.kind}`, agent: active.kind, kind: "id", value: `session-${attempt}` };
        if (options.agentId !== undefined) active.agentId = options.agentId;
        if (options.start !== undefined) {
          if (options.startLeavesBoundAgent === true) children.push(active);
          const result = options.start(argv, attempt);
          if (!children.includes(active)) children.push(active);
          return result;
        }
        children.push(active);
        return ok("start", { agent: agentRecord(active) });
      }
      if (argv[0] === "agent" && argv[1] === "focus") return ok("focus", {});
      if (argv[0] === "pane" && argv[1] === "report-metadata") {
        if (options.metadataError !== undefined) throw options.metadataError;
        return ok("metadata", {});
      }
      if (argv[0] === "agent" && argv[1] === "get") {
        if (active === undefined) throw new Error("no active pane");
        if (options.readinessError !== undefined && children.includes(active) && !active.prompt) throw options.readinessError;
        if (options.agentError !== undefined && children.includes(active) && active.prompt) throw options.agentError;
        if (options.failedPane !== undefined && !children.includes(active)) return ok("agent-get", { agent: options.failedPane });
        return ok("agent-get", { agent: agentRecord(active) });
      }
      if (argv[0] === "pane" && argv[1] === "get") {
        if (active === undefined) throw new Error("no active pane");
        if (options.paneError !== undefined && !children.includes(active)) throw options.paneError;
        if (options.failedPane !== undefined && !children.includes(active)) return ok("pane-get", { pane: options.failedPane });
        return ok("pane-get", { pane: paneRecord(active) });
      }
      throw new Error(`unexpected argv: ${argv.join(" ")}`);
    }),
  };
  return { cli, calls, prompts, children, get starts() { return starts; } };
}

function agentRecord(child: Child): Record<string, unknown> {
  return { name: child.name, pane_id: child.paneId, agent: child.kind, terminal_id: child.terminalId, agent_session: child.session, agent_status: child.prompt ? "working" : "idle", state_change_seq: child.prompt ? 8 : 7, revision: child.prompt ? 4 : 3, interactive_ready: true, ...(child.agentId === undefined ? {} : { agent_id: child.agentId }) };
}

function paneRecord(child: Child): Record<string, unknown> {
  return { pane_id: child.paneId, tab_id: child.tabId, workspace_id: "w1", agent_name: child.name, agent: child.kind, terminal_id: child.terminalId, agent_session: child.session, agent_status: child.prompt ? "working" : "idle", state_change_seq: child.prompt ? 8 : 7, revision: child.prompt ? 4 : 3, interactive_ready: true, ...(child.agentId === undefined ? {} : { agent_id: child.agentId }) };
}

function worktrees(): { manager: WorktreeManager; prepare: ReturnType<typeof vi.fn>; bindPane: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> } {
  const prepare = vi.fn(async ({ childName, cwd }: { childName: string; cwd: string }) => ({ cwd: join(cwd, ".herdr", "worktrees", childName), worktreePath: join(cwd, ".herdr", "worktrees", childName) }));
  const bindPane = vi.fn();
  const release = vi.fn(async () => undefined);
  return { manager: { prepare, bindPane, release } as unknown as WorktreeManager, prepare, bindPane, release };
}

// Unit fixtures inject an always-open lease; the real fail-closed gate is
// covered by launch-freeze.test.ts.
const openLaunchGate: NonNullable<LaunchDependencies["launchGate"]> = async () => ({ check: async () => undefined, release: async () => undefined });

function toolFor(options: {
  catalog: Catalog;
  cli: LaunchCli;
  specClient?: LaunchDependencies["specClient"];
  supervision?: StubSupervision;
  attachments?: AttachmentStore;
  ownership?: LaunchDependencies["ownership"];
  launchGate?: LaunchDependencies["launchGate"];
  worktrees?: WorktreeManager;
  routerLog?: LaunchRouterLog | null;
  catalogLoad?: () => Promise<Catalog>;
  preflight?: LaunchDependencies["preflight"];
  contextResolver?: LaunchDependencies["contextResolver"];
  promptSources?: LaunchDependencies["promptSources"];
  queueFlush?: LaunchDependencies["queueFlush"];
  clock?: LaunchDependencies["clock"];
  handoffs?: HandoffAllocator | null;
  availability?: LaunchDependencies["availability"];
  availabilityFailureRecorder?: LaunchDependencies["availabilityFailureRecorder"];
  claudeQuotaReader?: LaunchDependencies["claudeQuotaReader"];
  cwd?: string | null;
  useDefaultFailureRecorder?: boolean;
}): ReturnType<typeof createLaunchTool> {
  const supervision = options.supervision ?? stubSupervision();
  const specClient = options.specClient ?? { evaluate: vi.fn(async () => ({ kind: "response" as const, response: responseFor(options.catalog) })) };
  return createLaunchTool({
    cli: options.cli,
    context,
    ...(options.cwd === null ? {} : { cwd: options.cwd ?? repoRoot }),
    preflight: options.preflight ?? (async () => undefined),
    supervision,
    specClient,
    catalog: { load: options.catalogLoad ?? (async () => options.catalog) },
    attachments: options.attachments ?? fakeAttachments(),
    ...(options.handoffs === null ? {} : { handoffs: options.handoffs ?? fakeHandoffs() }),
    ...(options.useDefaultFailureRecorder ? {} : { availabilityFailureRecorder: options.availabilityFailureRecorder ?? vi.fn(async () => undefined) }),
    ...(options.availability === undefined ? {} : { availability: options.availability }),
    ...(options.claudeQuotaReader === undefined ? {} : { claudeQuotaReader: options.claudeQuotaReader }),
    ...(options.ownership === undefined ? {} : { ownership: options.ownership }),
    recipients: new RecipientRegistry(),
    ...(options.routerLog === null ? {} : { routerLog: options.routerLog ?? (vi.fn(async () => undefined) as LaunchRouterLog) }),
    ...(options.contextResolver === undefined ? {} : { contextResolver: options.contextResolver }),
    ...(options.promptSources === undefined ? {} : { promptSources: options.promptSources }),
    ...(options.queueFlush === undefined ? {} : { queueFlush: options.queueFlush }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    launchGate: options.launchGate ?? openLaunchGate,
    ...(options.worktrees === undefined ? {} : { worktrees: options.worktrees }),
  });
}

type UnsafeTestValue = { (...args: unknown[]): UnsafeTestValue; [key: string]: UnsafeTestValue };
type UnsafeLaunchInternals = { [K in keyof typeof launchTestInternals]: UnsafeTestValue };

async function execute(tool: ReturnType<typeof createLaunchTool>, params: unknown): Promise<AgentToolResult<LaunchResult>> {
  const result = await tool.execute("call", params as never, new AbortController().signal, undefined, extensionContext);
  if (result.details?.kind !== "launch") throw new Error("expected a launch result");
  return result;
}

const baseDiagnostics = { injected: context, effective: context, rebound: false, attempts: 1 };
const baseOperationIds = { current: "current", snapshot: "snapshot" };
const resolverFor = (snapshot: HerdrSnapshot) => async () => ({ snapshot, context, diagnostics: baseDiagnostics, operationIds: baseOperationIds });

describe("launch shell readiness", () => {
  const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
  const bareShell = { pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", agent_status: "unknown" };
  const handles = { paneId: "w1:p2", tabId: "w1:t2", supervisorJobId: "job_supervisor", effectCertainty: "partial" };

  it("holds the intact agent command until shell output, not the prompt or input echo, proves readiness", async () => {
    let probe = "";
    let matchedArgv: string[] = [];
    let release!: (response: JsonEnvelope) => void;
    let waiting!: () => void;
    const waitStarted = new Promise<void>((resolve) => { waiting = resolve; });
    const harness = makeCli({ shell: async (argv) => {
      if (argv[1] === "send-text") {
        probe = argv[3]!;
        return ok("sent", {});
      }
      matchedArgv = argv;
      waiting();
      return new Promise<JsonEnvelope>((resolve) => { release = resolve; });
    } });
    const launched = execute(toolFor({ catalog, cli: harness.cli }), task());
    await waitStarted;
    const marker = matchedArgv[4]!;
    expect(probe).not.toContain(marker);
    expect(`shell$ ${probe}`).not.toContain(marker);
    expect(harness.starts).toBe(0);
    const shell = spawnSync("bash", ["--noprofile", "--norc", "-i"], { input: probe, encoding: "utf8", timeout: 1_000 });
    expect(shell.status).toBe(0);
    expect(shell.stderr).toContain("printf"); // interactive prompt/input echo is separate from output
    expect(shell.stdout.trim()).toBe(marker);
    release(ok("matched", { type: "output_matched", pane_id: matchedArgv[2], matched_line: shell.stdout.trim() }));
    expect((await launched).details?.outcome).toBe("launched");
    const start = harness.calls.find((argv) => argv[0] === "agent" && argv[1] === "start")!;
    expect(start.slice(3, 7)).toEqual(["--kind", "pi", "--pane", "w1:p2"]);
    expect(start.slice(start.indexOf("--") + 1, start.indexOf("--") + 3)).toEqual(["--model", "pi-model"]);
    expect(harness.starts).toBe(1);
    expect(harness.calls.some((argv) => argv[1] === "send-keys" || argv[1] === "run")).toBe(false);
  });

  it("lets an update prompt consume only the probe, never the agent command, and retains bare-shell handles", async () => {
    let output = "";
    const supervision = stubSupervision();
    const harness = makeCli({ failedPane: bareShell, shell: async (argv) => {
      if (argv[1] === "send-text") {
        const shell = spawnSync("bash", ["--noprofile", "--norc", "-i"], {
          input: `read -r -n 1 -p 'Update now? [Y/n] '\n${argv[3]}`,
          encoding: "utf8", timeout: 1_000,
        });
        output = shell.stdout + shell.stderr;
        expect(output).toContain("Update now?");
        expect(output).toContain("rintf: command not found");
        return ok("sent", {});
      }
      expect(output).not.toContain(argv[4]);
      throw new CliProtocolError("CLI_PROTOCOL_ERROR", "timed out waiting for output match");
    } });
    const result = await execute(toolFor({ catalog, cli: harness.cli, supervision }), task());
    expect(result.details).toMatchObject({ outcome: "failed", children: [{ state: "failed", ...handles, error: { code: "SHELL_NOT_READY", ...handles } }] });
    expect(harness.starts).toBe(0);
    expect(harness.prompts).toEqual([]);
    expect(supervision.bound).toEqual([]);
    expect(supervision.released).toEqual(["launch_failed_agent_start"]);
    expect(JSON.stringify(result.content)).toContain("pane=w1:p2 tab=w1:t2 effect=partial");
  });

  it.each(["send-text", "wait-output"])("bounds a hung %s call to five seconds even when the transport ignores cancellation", async (hungCall) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let waiting!: () => void;
      const waitStarted = new Promise<void>((resolve) => { waiting = resolve; });
      let probeSignal: AbortSignal | undefined;
      const harness = makeCli({ failedPane: bareShell, shell: async (argv, signal) => {
        if (argv[1] !== hungCall) return ok("sent", {});
        probeSignal = signal;
        waiting();
        return new Promise<JsonEnvelope>(() => undefined);
      } });
      const launched = execute(toolFor({ catalog, cli: harness.cli }), task());
      await waitStarted;
      expect(harness.starts).toBe(0);
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await launched).details).toMatchObject({ outcome: "failed", children: [{ ...handles, error: { code: "SHELL_NOT_READY", ...handles } }] });
      expect(probeSignal?.aborted).toBe(true);
      expect(harness.starts).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([{}, { type: "output_matched", pane_id: "other", matched_line: "wrong" }])("rejects an acknowledgement without matching output: %j", async (response) => {
    const harness = makeCli({ failedPane: bareShell, shell: async () => ok("not-proof", response) });
    expect((await execute(toolFor({ catalog, cli: harness.cli }), task())).details).toMatchObject({ outcome: "failed", children: [{ ...handles, error: { code: "SHELL_NOT_READY" } }] });
    expect(harness.starts).toBe(0);
  });

  it("preserves caller cancellation and its surviving resource handles before agent start", async () => {
    const controller = new AbortController();
    const harness = makeCli({ failedPane: bareShell, shell: async () => {
      controller.abort();
      return ok("sent", {});
    } });
    const result = await toolFor({ catalog, cli: harness.cli }).execute("call", task(), controller.signal, undefined, extensionContext);
    expect(result.details).toMatchObject({ outcome: "failed", children: [{ ...handles, error: { code: "ABORTED", ...handles } }] });
    expect(harness.starts).toBe(0);
  });

  it("retains settled job and topology handles when the start command was sent but all readback is unavailable", async () => {
    const supervision = stubSupervision();
    const harness = makeCli({ start: () => { throw new Error("unconfirmed start"); }, paneError: new Error("pane unavailable") });
    const runJson = harness.cli.runJson;
    harness.cli.runJson = async (argv, signal, preserve) => {
      if (harness.starts > 0 && (argv[0] === "api" || (argv[0] === "agent" && argv[1] === "get"))) throw new Error("readback unavailable");
      return runJson(argv, signal, preserve);
    };
    const result = await execute(toolFor({ catalog, cli: harness.cli, supervision }), task());
    const unknownHandles = { ...handles, effectCertainty: "unknown" };
    expect(result.details).toMatchObject({ outcome: "failed", children: [{ ...unknownHandles, error: { code: "LAUNCH_FAILED", ...unknownHandles } }] });
    expect(harness.starts).toBe(1);
    expect(supervision.released).toEqual(["launch_failed_agent_start"]);
  });
});

describe("herdr_launch task cutover", () => {
  it("publishes and validates only the strict flat Task", () => {
    const valid = task();
    expect(Value.Check(LaunchTaskSchema, valid)).toBe(true);
    expect(Value.Check(PublishedLaunchParamsSchema, valid)).toBe(true);
    expect(() => validateLaunchParams(valid)).not.toThrow();
    // The deleted caller-authority fields are unknown properties now: no alias survives.
    for (const deleted of ["name", "specs", "tasks", "instructions", "assignment", "supervisionDigest", "category", "count", "placement", "focus", "assignmentDelivery", "transportBypass", "profile"]) {
      expect(Value.Check(LaunchTaskSchema, { ...valid, [deleted]: "x" }), deleted).toBe(false);
      expect(() => validateLaunchParams({ ...valid, [deleted]: "x" } as never)).toThrow();
    }
    expect(Value.Check(LaunchTaskSchema, { ...valid, doneWhen: [] })).toBe(false);
    expect(Value.Check(LaunchTaskSchema, { ...valid, doneWhen: Array.from({ length: 9 }, (_, index) => `d${index}`) })).toBe(false);
    expect(Value.Check(LaunchTaskSchema, { ...valid, doneWhen: Array.from({ length: 8 }, (_, index) => `d${index}`) })).toBe(true);
    expect(Value.Check(LaunchTaskSchema, { ...valid, constraints: Array.from({ length: 9 }, (_, index) => `c${index}`) })).toBe(false);
    expect(Value.Check(LaunchTaskSchema, { ...valid, constraints: [] })).toBe(true);
    expect(Value.Check(LaunchTaskSchema, { ...valid, replicas: 0 })).toBe(false);
    expect(Value.Check(LaunchTaskSchema, { ...valid, replicas: 9 })).toBe(false);
    expect(Value.Check(LaunchTaskSchema, { ...valid, replicas: 8 })).toBe(true);
    expect(Value.Check(LaunchTaskSchema, { ...valid, replicas: 1.5 })).toBe(false);
    expect(Value.Check(LaunchTaskSchema, task({ tier: "frontier" }))).toBe(true);
    expect(Value.Check(LaunchTaskSchema, { ...valid, tier: "bogus" })).toBe(false);
    expect(Value.Check(LaunchTaskSchema, task({ objective: "" }))).toBe(false);
    expect(Value.Check(LaunchTaskSchema, task({ objective: "a\0b" }))).toBe(false);
    expect(Value.Check(LaunchTaskSchema, task({ label: "a\nb" }))).toBe(false);
    expect(Value.Check(LaunchTaskSchema, task({ label: "docs sprint" }))).toBe(true);
    const minimal = { objective: "o", scope: "s", doneWhen: ["d"] };
    expect(Value.Check(LaunchTaskSchema, minimal)).toBe(true);
    expect(() => validateLaunchParams(minimal)).not.toThrow();
    expect(() => validateLaunchParams({ objective: "o", scope: "s" } as never)).toThrow();
    expect(() => validateLaunchParams(null as never)).toThrow();
  });

  it("bounds the display label at 256 UTF-8 bytes before any effect", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    // The bound is bytes, not code units: 256 ASCII pass, 257 and 258-byte
    // multibyte strings reject. A 10KB label is refused at validation — it
    // never reaches evaluation, routing persistence, or any CLI mutation.
    expect(() => validateLaunchParams(task({ label: "x".repeat(256) }))).not.toThrow();
    expect(() => validateLaunchParams(task({ label: "x".repeat(257) }))).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => validateLaunchParams(task({ label: "€".repeat(85) }))).not.toThrow();
    expect(() => validateLaunchParams(task({ label: "€".repeat(86) }))).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    const harness = makeCli();
    const specClient = { evaluate: vi.fn(async () => ({ kind: "response" as const, response: responseFor(catalog) })) };
    const routerLog = vi.fn<LaunchRouterLog>(async () => undefined);
    const tool = toolFor({ catalog, cli: harness.cli, specClient, routerLog });
    await expect(tool.execute("call", task({ label: "x".repeat(10 * 1024) }), new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(harness.calls).toEqual([]);
    expect(specClient.evaluate).not.toHaveBeenCalled();
    expect(routerLog).not.toHaveBeenCalled();
  });

  it("keeps the caller label display-only: distinct minted targets, minted pane rename, nothing in routing evidence", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const routerLog = vi.fn<LaunchRouterLog>(async () => undefined);
    // Two Tasks carrying the same label still launch into distinct minted
    // targets — the label never becomes identity.
    const first = makeCli();
    const firstResult = await execute(toolFor({ catalog, cli: first.cli, routerLog }), task({ label: "sprint" }));
    const second = makeCli();
    const secondResult = await execute(toolFor({ catalog, cli: second.cli, routerLog }), task({ label: "sprint" }));
    const firstTarget = firstResult.details!.children[0]!.target;
    const secondTarget = secondResult.details!.children[0]!.target;
    expect(firstTarget).toMatch(/^task-[0-9a-f]{8}-1$/u);
    expect(secondTarget).toMatch(/^task-[0-9a-f]{8}-1$/u);
    expect(firstTarget).not.toBe(secondTarget);
    // The pane rename carries the minted child name, and no CLI argv carries
    // the caller's label.
    const rename = first.calls.find((argv) => argv[0] === "pane" && argv[1] === "rename")!;
    expect(rename[3]).toBe(firstTarget);
    expect(first.calls.some((argv) => argv.includes("sprint"))).toBe(false);
    // The persisted routing decision never contains the caller label.
    for (const call of routerLog.mock.calls) expect(JSON.stringify(call[0])).not.toContain("sprint");
  });

  it("mints the child name, carries the universal baseline, and reserves the task digest", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const harness = makeCli({ agentId: "agent-1" });
    const supervision = stubSupervision();
    const requests: SupervisionReserveRequest[] = [];
    const reserve = supervision.reserve;
    supervision.reserve = vi.fn(async (value) => { requests.push(value); return reserve(value); });
    const result = await execute(toolFor({ catalog, cli: harness.cli, supervision }), task());

    expect(result.details).toMatchObject({ kind: "launch", outcome: "launched", requestedTier: "standard" });
    const child = result.details!.children[0]!;
    expect(child.target).toMatch(/^task-[0-9a-f]{8}-1$/u);
    expect(child).toMatchObject({ state: "launched", operatingPointId: "pi:pi-model:low", supervisorJobId: "job_supervisor" });
    expect(harness.prompts).toHaveLength(1);
    expect(harness.prompts[0]).toContain(SPEC_BASELINE);
    expect(harness.prompts[0]).toContain(renderTask(TASK));
    expect(requests[0]).toMatchObject({ child: { agentName: child.target, agentKind: "pi", operatingPointId: "pi:pi-model:low" }, settings: { supervisionDigest: { objective: TASK.objective, doneWhen: TASK.doneWhen, constraints: TASK.constraints } } });
    expect(Object.keys(requests[0]!.settings!.supervisionDigest!).sort()).toEqual(["constraints", "doneWhen", "objective"]);
  });

  it("reserves the task digest and the trusted workspace root, with no deny-list policy", async () => {
    const catalog = catalogOf(
      [{ runner: "claude", model: "opus" }, { runner: "pi", model: "pi-model" }, { runner: "devin", model: "swe-2-max" }],
      new Map<RunnerKind, RunnerEntry>([["claude", claudeRunner(["opus"])], ["pi", runnerEntry(["pi-model"])], ["devin", devinRunner(["swe-2-max"])]]),
    );
    const harness = makeCli();
    const supervision = stubSupervision();
    const requests: SupervisionReserveRequest[] = [];
    const reserve = supervision.reserve;
    supervision.reserve = vi.fn(async (value) => { requests.push(value); return reserve(value); });
    const result = await execute(toolFor({ catalog, cli: harness.cli, supervision }), task());

    expect(result.details).toMatchObject({ outcome: "launched", children: [{ state: "launched", operatingPointId: "claude:opus:low" }] });
    const settings = requests[0]!.settings!;
    expect(settings.supervisionDigest).toEqual({ objective: TASK.objective, doneWhen: TASK.doneWhen, constraints: TASK.constraints });
    // Tool permission enforcement lives in the compiled argv, not the
    // reservation: the reserve settings carry no forbiddenTools policy.
    expect(settings).not.toHaveProperty("forbiddenTools");
    // The canonical launch cwd is the trusted workspace root.
    expect(settings.workspaceRoot).toEqual({ available: true, root: repoRoot });
  });

  it("canonicalizes the launch cwd and fails closed on unusable directories", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const supervision = stubSupervision();
    const requests: SupervisionReserveRequest[] = [];
    const reserve = supervision.reserve;
    supervision.reserve = vi.fn(async (value) => { requests.push(value); return reserve(value); });

    const real = mkdtempSync(join(tmpdir(), "herdr-launch-cwd-"));
    const link = join(tmpdir(), `herdr-launch-cwd-link-${randomUUID()}`);
    symlinkSync(real, link, "dir");
    const file = join(real, "file");
    writeFileSync(file, "x");
    try {
      const linked = await execute(toolFor({ catalog, cli: makeCli().cli, supervision }), task({ cwd: link }));
      expect(linked.details).toMatchObject({ outcome: "launched" });
      // The canonical realpath is the trusted root — not the caller's spelling.
      expect(requests[0]!.settings!.workspaceRoot).toEqual({ available: true, root: realpathSync(real) });

      const tool = toolFor({ catalog, cli: makeCli().cli, supervision });
      await expect(tool.execute("call", task({ cwd: "definitely/missing" }), new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "CWD_UNAVAILABLE" });
      await expect(tool.execute("call", task({ cwd: file }), new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "CWD_UNAVAILABLE" });
      // A directory that exists but denies search/read fails closed too.
      const locked = join(real, "locked");
      mkdirSync(locked, { mode: 0o000 });
      try {
        await expect(tool.execute("call", task({ cwd: locked }), new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "CWD_UNAVAILABLE" });
      } finally {
        chmodSync(locked, 0o700);
      }
    } finally {
      rmSync(real, { recursive: true, force: true });
      rmSync(link, { force: true });
    }
  });

  it("rejects deleted caller-authority fields before any CLI mutation", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const harness = makeCli();
    const tool = toolFor({ catalog, cli: harness.cli });
    await expect(tool.execute("call", { name: "task", specs: [{ label: "worker" }] } as never, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(tool.execute("call", { ...task(), profile: "worker", assignment: { objective: "o" } } as never, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(tool.execute("call", { ...task(), instructions: "x" } as never, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(harness.calls).toEqual([]);
  });

  it("fails closed on an unresolvable recoveryOf before any effect", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const harness = makeCli();
    const specClient = { evaluate: vi.fn(async () => ({ kind: "response" as const, response: responseFor(catalog) })) };
    await expect(toolFor({ catalog, cli: harness.cli, specClient }).execute("call", task({ recoveryOf: "run-1" }), new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "RECOVERY_UNRESOLVABLE", details: { reason: "run_id_malformed" } });
    expect(harness.calls).toEqual([]);
    expect(specClient.evaluate).not.toHaveBeenCalled();
  });

  it("persists the authoritative manager session and canonical Task before any launch effect", async () => {
    const managerSession = { source: "herdr:pi", agent: "pi", kind: "id", value: "manager-session-1" };
    const harness = makeCli({
      caller: {
        pane: { agent: "pi", terminal_id: "term-w1:p1", agent_session: managerSession },
        agents: [{ pane_id: "w1:p1", name: "manager", agent: "pi", terminal_id: "term-w1:p1", agent_session: managerSession }]
      }
    });
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const handoffs = fakeHandoffs();
    const attachments = fakeAttachments();
    const supervision = stubSupervision();
    const order: string[] = [];
    let callsAtPersist: string[][] = [];
    (handoffs.persist as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push("persist"); callsAtPersist = [...harness.calls]; });
    (attachments.ensureRecipient as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push("recipient"); return { path: "/tmp/recipient", token: "grant", renew: vi.fn(async () => undefined), release: vi.fn(async () => undefined) }; });
    const reserve = supervision.reserve;
    supervision.reserve = vi.fn(async (value) => { order.push("reserve"); return reserve(value); });

    const result = await execute(toolFor({ catalog, cli: harness.cli, handoffs, attachments, supervision }), task({ label: "docs sprint", cwd: repoRoot }));
    expect(result.details).toMatchObject({ outcome: "launched" });

    // The provenance write precedes the first recipient and supervision effect,
    // and every CLI call it observed was a read.
    expect(order.slice(0, 3)).toEqual(["persist", "recipient", "reserve"]);
    expect(callsAtPersist.every((argv) => (argv[0] === "pane" && argv[1] === "current") || argv[0] === "api")).toBe(true);
    expect(handoffs.persist).toHaveBeenCalledTimes(1);
    const [runArg, identityArg, provenanceArg] = (handoffs.persist as ReturnType<typeof vi.fn>).mock.calls[0]! as [HandoffAllocation, HandoffRunIdentity, unknown];
    expect(runArg.marker).toMatch(/^herdr-run:/u);
    // Manager identity comes from the authoritative snapshot — and the session
    // is the manager's own native session, never a caller field.
    expect(identityArg.manager).toEqual({ paneId: "w1:p1", display: "manager", source: "agent_name" });
    expect(provenanceArg).toEqual({
      managerSession,
      task: { ...TASK, tier: "standard", replicas: 1, label: "docs sprint", cwd: repoRoot }
    });
    // D5: the fresh-launch binding records the same owner the reattach path
    // derives from this provenance — the manager pane plus its native session.
    expect(supervision.bound[0]!.handoff!.owner).toEqual({ paneId: "w1:p1", session: managerSession });
  });

  it("persists a null manager session when the caller pane has no native session", async () => {
    const harness = makeCli();
    const handoffs = fakeHandoffs();
    const supervision = stubSupervision();
    const result = await execute(toolFor({ catalog: catalogOf([{ runner: "pi", model: "pi-model" }]), cli: harness.cli, handoffs, supervision }), task());
    expect(result.details).toMatchObject({ outcome: "launched" });
    expect((handoffs.persist as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toMatchObject({ managerSession: null });
    // A non-agent caller still records its pane as owner; D5 pauses reviews on
    // that pane's absence instead of on a session.
    expect(supervision.bound[0]!.handoff!.owner).toEqual({ paneId: "w1:p1", session: null });
  });

  it("fails closed on ambiguous or contradictory manager session evidence before any launch effect", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const session = { source: "herdr:pi", agent: "pi", kind: "id", value: "s-1" };
    const cases: Array<{ name: string; caller: { pane?: Record<string, unknown>; panes?: Record<string, unknown>[]; agents?: Record<string, unknown>[] } }> = [
      { name: "duplicate agent records", caller: { agents: [{ pane_id: "w1:p1", agent: "pi" }, { pane_id: "w1:p1", agent: "pi" }] } },
      { name: "contradictory sessions", caller: { pane: { agent: "pi", agent_session: session }, agents: [{ pane_id: "w1:p1", agent: "pi", agent_session: { ...session, value: "other" } }] } },
      { name: "malformed session", caller: { pane: { agent_session: { source: "herdr:pi" } } } },
      {
        name: "same session supplied only by a sibling agent record",
        caller: {
          pane: { agent: "pi", agent_session: session },
          panes: [{ pane_id: "w1:p9", tab_id: "w1:t1", workspace_id: "w1", agent: "pi" }],
          agents: [
            { pane_id: "w1:p1", agent: "pi", agent_session: session },
            { pane_id: "w1:p9", agent: "pi", agent_session: session }
          ]
        }
      }
    ];
    for (const { name, caller } of cases) {
      const harness = makeCli({ caller });
      const handoffs = fakeHandoffs();
      const specClient = { evaluate: vi.fn(async () => ({ kind: "response" as const, response: responseFor(catalog) })) };
      const result = await execute(toolFor({ catalog, cli: harness.cli, specClient, handoffs }), task());
      // The launch fails closed on the child record rather than starting over
      // ambiguous provenance — and nothing persisted or mutated first.
      expect(result.details!.outcome, name).toBe("failed");
      expect(result.details!.children[0], name).toMatchObject({ state: "failed", error: { code: "CONTEXT_UNAVAILABLE" } });
      expect(handoffs.persist, name).not.toHaveBeenCalled();
      // Only context reads ran — no split, start, prompt, or metadata mutation.
      expect(harness.calls.filter((argv) => !(argv[0] === "pane" && argv[1] === "current") && argv[0] !== "api"), name).toEqual([]);
    }
  });

  describe("recovery lineage (ADR-037)", () => {
    const RECOVERY_WORKLOAD = { intent: "implement" as const, mutation: "bounded" as const, scope: "local" as const, horizon: "short" as const, verifiability: "strong" as const, workspaceState: "clean" as const, ambiguity: "low" as const };

    /**
     * A real allocator over a private namespace dir, plus one persisted prior
     * run whose recorded managed workspace is a canonical real directory.
     */
    async function seedRecoveryRun(options: {
      lifecycle?: HandoffState["lifecycle"]["state"];
      artifactStatus?: HandoffStatus;
      routeTier?: QualityTier;
      operatingPointId?: string;
      endpoint?: string;
      worktree?: string;
      workspaceDir?: string;
      omitRoute?: boolean;
      omitWorkspace?: boolean;
      omitProvenance?: boolean;
    } = {}): Promise<{ run: HandoffAllocation; allocator: HandoffAllocator; namespaceDir: string; workspaceDir: string }> {
      const namespaceDir = realpathSync(mkdtempSync(join(tmpdir(), "herdr-recovery-ns-")));
      const workspaceDir = options.workspaceDir ?? realpathSync(mkdtempSync(join(tmpdir(), "herdr-recovery-ws-")));
      const allocator = createHandoffAllocator({ namespace: { dir: namespaceDir, endpoint: options.endpoint ?? "test-endpoint" } });
      const run = await allocator.allocate();
      const operatingPointId = options.operatingPointId ?? "pi:primary:low";
      // Recovery lineage is only authoritative with its provenance record: the
      // seeded run carries the manager session and canonical Task it launched
      // under — or, with omitProvenance, a pre-provenance legacy record.
      await allocator.persist(run, {
        manager: { paneId: "w1:p1", display: "caller", source: "agent_name" },
        child: {
          agentName: "prior-worker",
          agentKind: "pi",
          operatingPointId,
          specLabel: "worker",
          fallbackCandidates: [],
          ...(options.omitRoute ? {} : { route: { tier: options.routeTier ?? "standard", operatingPointId, policyRevision: "adr-037-p1", workload: RECOVERY_WORKLOAD } }),
          ...(options.omitWorkspace ? {} : { workspace: { resolvedCwd: workspaceDir, ...(options.worktree === undefined ? {} : { worktree: options.worktree }) } })
        }
      }, options.omitProvenance ? undefined : {
        managerSession: { source: "herdr:pi", agent: "pi", kind: "id", value: "prior-manager-session" },
        task: { objective: "prior objective", scope: "prior scope", doneWhen: ["prior done"], constraints: [], tier: "standard", replicas: 1 }
      });
      await updateHandoffState(run, (state) => {
        state.lifecycle.state = options.lifecycle ?? "handed_off";
        if (options.artifactStatus !== undefined) state.artifact.status = options.artifactStatus;
      });
      return { run, allocator, namespaceDir, workspaceDir };
    }

    /** Mutate a persisted state document directly — for records that must fail the v2 parse. */
    function rewriteState(run: HandoffAllocation, mutate: (doc: Record<string, unknown>) => void): void {
      const doc = JSON.parse(readFileSync(run.statePath, "utf8")) as Record<string, unknown>;
      mutate(doc);
      writeFileSync(run.statePath, JSON.stringify(doc), { mode: 0o600 });
    }

    const provenancePathOf = (run: HandoffAllocation): string => join(run.toolsDir, HANDOFF_PROVENANCE_NAME);

    /** Mutate a persisted provenance document directly — for records that must fail the v1 parse. */
    function rewriteProvenance(run: HandoffAllocation, mutate: (doc: Record<string, unknown>) => void): void {
      const doc = JSON.parse(readFileSync(provenancePathOf(run), "utf8")) as Record<string, unknown>;
      mutate(doc);
      writeFileSync(provenancePathOf(run), JSON.stringify(doc), { mode: 0o600 });
    }

    /** The new run id a launch allocated, recovered from the task's injected marker. */
    function launchedRunId(harness: ReturnType<typeof makeCli>): string {
      return /herdr-run:([0-9a-f-]{36})/u.exec(harness.prompts[0]!)![1]!;
    }

    /** The cwd the placement call launched the child into — split or tab create. */
    function placementCwd(harness: ReturnType<typeof makeCli>): string {
      const placement = harness.calls.find((argv) => (argv[0] === "pane" && argv[1] === "split") || (argv[0] === "tab" && argv[1] === "create"))!;
      return placement[placement.indexOf("--cwd") + 1]!;
    }

    it("resumes the prior managed workspace, lifts the route tier, and excludes the failed point", async () => {
      const { run, allocator, workspaceDir } = await seedRecoveryRun({ lifecycle: "handed_off", artifactStatus: "done", operatingPointId: "pi:primary:low", routeTier: "standard" });
      const catalog = catalogOf([{ runner: "pi", model: "primary" }, { runner: "pi", model: "fallback" }]);
      const harness = makeCli();
      const evaluate = vi.fn<TypeSafeSpecClient["evaluate"]>(async () => ({ kind: "response" as const, response: responseFor(catalog) }));
      const result = await execute(toolFor({ catalog, cli: harness.cli, specClient: { evaluate }, handoffs: allocator }), task({ recoveryOf: run.runId, replicas: 1 }));

      // nextTier(standard) lifts the start preference to strong.
      expect(result.details).toMatchObject({ outcome: "launched", requestedTier: "standard", effectiveTier: "strong" });
      // The exact failed point is excluded; the remaining candidate ran.
      expect(result.details!.children[0]).toMatchObject({ state: "launched", operatingPointId: "pi:fallback:low" });
      // The evaluator saw the derived workspace state and the caller's own tier.
      expect(evaluate.mock.calls[0]![0]).toMatchObject({ workspaceState: "clean" as WorkspaceState, task: { tier: "standard" } });
      // The child started inside the resumed prior workspace, not the ambient cwd.
      expect(placementCwd(harness)).toBe(workspaceDir);
      expect(workspaceDir).not.toBe(repoRoot);
      // The new run's record carries its own route and workspace lineage.
      const newState = await readHandoffState(await allocator.open(launchedRunId(harness)));
      expect(newState.child.route).toMatchObject({ tier: "strong", operatingPointId: "pi:fallback:low", policyRevision: POLICY_REVISION });
      expect(newState.child.route?.workload).toMatchObject({ workspaceState: "clean", intent: "implement" });
      expect(newState.child.workspace).toEqual({ resolvedCwd: workspaceDir });
      // The persisted workspace identity did not come from a caller cwd — none was given.
      expect(newState.child.agentName).toBe(result.details!.children[0]!.target);
    });

    it("resumes the recorded worktree when the prior child ran inside one", async () => {
      const worktreeDir = realpathSync(mkdtempSync(join(tmpdir(), "herdr-recovery-wt-")));
      const { run, allocator } = await seedRecoveryRun({ lifecycle: "handed_off", artifactStatus: "done", worktree: worktreeDir });
      const catalog = catalogOf([{ runner: "pi", model: "primary" }, { runner: "pi", model: "fallback" }]);
      const harness = makeCli();
      const result = await execute(toolFor({ catalog, cli: harness.cli, handoffs: allocator }), task({ recoveryOf: run.runId }));

      expect(result.details).toMatchObject({ outcome: "launched" });
      expect(placementCwd(harness)).toBe(worktreeDir);
      const newState = await readHandoffState(await allocator.open(launchedRunId(harness)));
      expect(newState.child.workspace).toEqual({ resolvedCwd: worktreeDir, worktree: worktreeDir });
    });

    it("computes the effective start as max(requested, workload floor, next tier after the prior route)", async () => {
      // prior route strong -> lift frontier; caller asks economy -> frontier wins.
      const { run, allocator } = await seedRecoveryRun({ lifecycle: "handed_off", artifactStatus: "done", routeTier: "strong" });
      const catalog = { ...catalogOf([{ runner: "pi", model: "primary" }, { runner: "pi", model: "fallback" }]), catalogRevision: "f".repeat(64) };
      const routerLog = vi.fn<LaunchRouterLog>(async () => undefined);
      const result = await execute(toolFor({ catalog, cli: makeCli().cli, handoffs: allocator, routerLog }), task({ recoveryOf: run.runId, tier: "economy" }));

      expect(result.details).toMatchObject({ outcome: "launched", requestedTier: "economy", effectiveTier: "frontier" });
      // The logged decision keeps requestedTier = the caller's ask; the lift
      // rides on effectiveStartTier.
      expect(routerLog.mock.calls[0]![0].result).toMatchObject({ requestedTier: "economy", effectiveStartTier: "frontier" });
      // The logged record carries the catalog revision and the recovery
      // lineage pair — the recovered run and the failed point it excludes.
      expect(routerLog.mock.calls[0]![0]).toMatchObject({ catalogRevision: catalog.catalogRevision, recoveryOf: run.runId, priorOperatingPointId: "pi:primary:low" });
    });

    it("derives a partial workspace from an unresolved prior lifecycle and lifts the floor", async () => {
      const { run, allocator } = await seedRecoveryRun({ lifecycle: "recovery_pending", routeTier: "standard" });
      const catalog = catalogOf([{ runner: "pi", model: "primary" }, { runner: "pi", model: "fallback" }]);
      const evaluate = vi.fn<TypeSafeSpecClient["evaluate"]>(async () => ({ kind: "response" as const, response: responseFor(catalog) }));
      const result = await execute(toolFor({ catalog, cli: makeCli().cli, specClient: { evaluate }, handoffs: allocator }), task({ recoveryOf: run.runId }));

      expect(evaluate.mock.calls[0]![0].workspaceState).toBe("partial");
      // partial raises the workload floor to strong; nextTier(standard) agrees.
      expect(result.details).toMatchObject({ outcome: "launched", effectiveTier: "strong" });
    });

    it("resumes a cancelled prior run as failed-workspace evidence", async () => {
      const { run, allocator } = await seedRecoveryRun({ lifecycle: "cancelled", routeTier: "standard" });
      const catalog = catalogOf([{ runner: "pi", model: "primary" }, { runner: "pi", model: "fallback" }]);
      const evaluate = vi.fn<TypeSafeSpecClient["evaluate"]>(async () => ({ kind: "response" as const, response: responseFor(catalog) }));
      const result = await execute(toolFor({ catalog, cli: makeCli().cli, specClient: { evaluate }, handoffs: allocator }), task({ recoveryOf: run.runId }));
      expect(evaluate.mock.calls[0]![0].workspaceState).toBe("failed");
      expect(result.details).toMatchObject({ outcome: "launched" });
    });

    it("reaches the max fixed point when the prior route was frontier", async () => {
      const { run, allocator } = await seedRecoveryRun({ lifecycle: "failed", routeTier: "frontier" });
      const catalog = catalogOf([{ runner: "pi", model: "primary" }, { runner: "pi", model: "fallback" }]);
      const evaluate = vi.fn<TypeSafeSpecClient["evaluate"]>(async () => ({ kind: "response" as const, response: responseFor(catalog) }));
      const result = await execute(toolFor({ catalog, cli: makeCli().cli, specClient: { evaluate }, handoffs: allocator }), task({ recoveryOf: run.runId }));

      expect(evaluate.mock.calls[0]![0].workspaceState).toBe("failed");
      expect(result.details).toMatchObject({ outcome: "launched", effectiveTier: "max" });
    });

    it("ranks a different provider ahead of the failed point's provider", async () => {
      const claude = claudeRunner(["c", "b"]);
      const catalog = catalogOf(
        [{ runner: "claude", model: "c" }, { runner: "pi", model: "a" }, { runner: "claude", model: "b" }],
        new Map<RunnerKind, RunnerEntry>([["claude", { ...claude, quota: { ...claude.quota, provider: "prov-b" } }], ["pi", runnerEntry(["a"])]]),
      );
      const { run, allocator } = await seedRecoveryRun({ lifecycle: "failed", operatingPointId: "claude:b:low", routeTier: "standard" });
      const harness = makeCli();
      const result = await execute(toolFor({ catalog, cli: harness.cli, handoffs: allocator }), task({ recoveryOf: run.runId }));

      expect(result.details).toMatchObject({ outcome: "launched" });
      // The failed provider is excluded; the authoritative chain's first
      // remaining provider starts.
      const firstStart = harness.calls.find((argv) => argv[0] === "agent" && argv[1] === "start")!;
      expect(firstStart[4]).toBe("claude");
      expect(result.details!.children[0]!.operatingPointId).toBe("claude:c:low");
    });

    it("keeps fitness order when the head already carries a different provider, and when the failed point is gone from the catalog", async () => {
      const claude = claudeRunner(["c", "b"]);
      const catalog = catalogOf(
        [{ runner: "pi", model: "a" }, { runner: "claude", model: "c" }, { runner: "claude", model: "b" }],
        new Map<RunnerKind, RunnerEntry>([["claude", { ...claude, quota: { ...claude.quota, provider: "prov-b" } }], ["pi", runnerEntry(["a"])]]),
      );
      // Failed point's provider differs from the post-exclusion head's — order stands.
      const first = await seedRecoveryRun({ lifecycle: "failed", operatingPointId: "claude:b:low" });
      const result = await execute(toolFor({ catalog, cli: makeCli().cli, handoffs: first.allocator }), task({ recoveryOf: first.run.runId }));
      expect(result.details!.children[0]!.operatingPointId).toBe("pi:a:low");

      // A failed point no longer in the catalog cannot resolve its provider,
      // so recovery fails closed instead of guessing.
      const single = catalogOf([{ runner: "pi", model: "primary" }, { runner: "pi", model: "fallback" }]);
      const second = await seedRecoveryRun({ lifecycle: "failed", operatingPointId: "pi:gone:low" });
      const again = await execute(toolFor({ catalog: single, cli: makeCli().cli, handoffs: second.allocator }), task({ recoveryOf: second.run.runId }));
      expect(again.details).toMatchObject({ outcome: "abstained", children: [] });
    });

    it("abstains closed when the exclusion empties the usable chain", async () => {
      const { run, allocator } = await seedRecoveryRun({ lifecycle: "failed", operatingPointId: "pi:primary:low" });
      const catalog = catalogOf([{ runner: "pi", model: "primary" }]);
      const harness = makeCli();
      const result = await execute(toolFor({ catalog, cli: harness.cli, handoffs: allocator }), task({ recoveryOf: run.runId }));
      // The failed point is excluded inside the routing decision itself, so the
      // launch abstains before any child exists rather than failing one.
      expect(result.details).toMatchObject({ outcome: "abstained", children: [] });
      expect(harness.calls.filter((argv) => argv[0] === "agent" && argv[1] === "start")).toEqual([]);
    });

    it("abstains a recovery whose decision does not admit", async () => {
      const { run, allocator } = await seedRecoveryRun({ lifecycle: "handed_off", artifactStatus: "done" });
      const catalog = catalogOf([{ runner: "pi", model: "primary" }]);
      const harness = makeCli();
      const specClient = { evaluate: vi.fn(async () => ({ kind: "response" as const, response: responseFor(catalog, { done_when_verifiable: 0.1 }) })) };
      const result = await execute(toolFor({ catalog, cli: harness.cli, specClient, handoffs: allocator }), task({ recoveryOf: run.runId }));
      expect(result.details).toMatchObject({ outcome: "abstained", children: [] });
      expect(harness.calls).toEqual([]);
    });

    it("fails closed on a missing run before any launch effect", async () => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "herdr-recovery-ns-")));
      const allocator = createHandoffAllocator({ namespace: { dir, endpoint: "test-endpoint" } });
      const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
      const harness = makeCli();
      const specClient = { evaluate: vi.fn(async () => ({ kind: "response" as const, response: responseFor(catalog) })) };
      await expect(toolFor({ catalog, cli: harness.cli, specClient, handoffs: allocator }).execute("call", task({ recoveryOf: randomUUID() }), new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "RECOVERY_UNRESOLVABLE", details: { reason: "state_unreadable" } });
      expect(harness.calls).toEqual([]);
      expect(specClient.evaluate).not.toHaveBeenCalled();
    });

    it("fails closed on every unresolvable source record before any launch effect", async () => {
      const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
      const cases: Array<{ name: string; reason: string; seed: () => Promise<{ run: HandoffAllocation; allocator: HandoffAllocator }> }> = [
        // A v1 record predates recovery lineage — never reinterpreted.
        { name: "v1 record", reason: "state_unreadable", seed: async () => { const seeded = await seedRecoveryRun(); rewriteState(seeded.run, (doc) => { doc.v = 1; }); return seeded; } },
        // A record pinned to a foreign endpoint is not this namespace's lineage —
        // the same run dir opened under this endpoint refuses the pinned record.
        { name: "foreign namespace", reason: "state_unreadable", seed: async () => {
          const seeded = await seedRecoveryRun({ endpoint: "other-endpoint" });
          return { run: seeded.run, allocator: createHandoffAllocator({ namespace: { dir: seeded.namespaceDir, endpoint: "test-endpoint" } }) };
        } },
        { name: "malformed route", reason: "state_unreadable", seed: async () => { const seeded = await seedRecoveryRun(); rewriteState(seeded.run, (doc) => { (doc.child as Record<string, unknown>).route = { tier: "bogus" }; }); return seeded; } },
        { name: "malformed workspace", reason: "state_unreadable", seed: async () => { const seeded = await seedRecoveryRun(); rewriteState(seeded.run, (doc) => { (doc.child as Record<string, unknown>).workspace = {}; }); return seeded; } },
        // A run persisted before provenance existed stays readable as state —
        // and can never authorize a recovery.
        { name: "legacy record without provenance", reason: "provenance_missing", seed: async () => seedRecoveryRun({ omitProvenance: true }) },
        { name: "provenance not JSON", reason: "provenance_unreadable", seed: async () => { const seeded = await seedRecoveryRun(); writeFileSync(provenancePathOf(seeded.run), "not json", { mode: 0o600 }); return seeded; } },
        { name: "provenance pinned to a foreign run", reason: "provenance_unreadable", seed: async () => { const seeded = await seedRecoveryRun(); rewriteProvenance(seeded.run, (doc) => { doc.runId = randomUUID(); }); return seeded; } },
        { name: "provenance pinned to a foreign endpoint", reason: "provenance_unreadable", seed: async () => { const seeded = await seedRecoveryRun(); rewriteProvenance(seeded.run, (doc) => { doc.endpoint = "other-endpoint"; }); return seeded; } },
        { name: "provenance with a malformed Task", reason: "provenance_unreadable", seed: async () => { const seeded = await seedRecoveryRun(); rewriteProvenance(seeded.run, (doc) => { (doc.task as Record<string, unknown>).tier = "bogus"; }); return seeded; } },
        { name: "route absent", reason: "lineage_incomplete", seed: async () => { const seeded = await seedRecoveryRun({ omitRoute: true }); return seeded; } },
        { name: "workspace absent", reason: "lineage_incomplete", seed: async () => { const seeded = await seedRecoveryRun({ omitWorkspace: true }); return seeded; } },
        { name: "unresolvable evidence", reason: "evidence_unresolvable", seed: async () => { const seeded = await seedRecoveryRun(); await updateHandoffState(seeded.run, (state) => { state.lifecycle.state = "bogus" as never; }); return seeded; } },
        // A live prior lifecycle may still have a writer over the workspace —
        // recovery rejects it before any effect, never reuses the workspace.
        { name: "awaiting handoff", reason: "lifecycle_non_terminal", seed: async () => { const seeded = await seedRecoveryRun({ lifecycle: "awaiting_handoff" }); return seeded; } },
        { name: "handed_off without terminal artifact", reason: "lifecycle_non_terminal", seed: async () => { const seeded = await seedRecoveryRun({ lifecycle: "handed_off" }); return seeded; } },
        { name: "workspace gone", reason: "workspace_unavailable", seed: async () => { const seeded = await seedRecoveryRun({ lifecycle: "handed_off", artifactStatus: "done", workspaceDir: join(tmpdir(), `herdr-missing-${randomUUID()}`) }); return seeded; } },
      ];
      for (const { name, reason, seed } of cases) {
        const { run, allocator } = await seed();
        const harness = makeCli();
        const specClient = { evaluate: vi.fn(async () => ({ kind: "response" as const, response: responseFor(catalog) })) };
        await expect(toolFor({ catalog, cli: harness.cli, specClient, handoffs: allocator }).execute("call", task({ recoveryOf: run.runId }), new AbortController().signal, undefined, extensionContext), name).rejects.toMatchObject({ code: "RECOVERY_UNRESOLVABLE", details: { reason } });
        expect(harness.calls, name).toEqual([]);
        expect(specClient.evaluate, name).not.toHaveBeenCalled();
      }
    });

    it("fails closed when the recorded workspace now resolves elsewhere", async () => {
      const real = realpathSync(mkdtempSync(join(tmpdir(), "herdr-recovery-real-")));
      const link = join(tmpdir(), `herdr-recovery-link-${randomUUID()}`);
      symlinkSync(real, link, "dir");
      try {
        const { run, allocator } = await seedRecoveryRun({ lifecycle: "handed_off", artifactStatus: "done", workspaceDir: link });
        const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
        const harness = makeCli();
        const specClient = { evaluate: vi.fn(async () => ({ kind: "response" as const, response: responseFor(catalog) })) };
        await expect(toolFor({ catalog, cli: harness.cli, specClient, handoffs: allocator }).execute("call", task({ recoveryOf: run.runId }), new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "RECOVERY_UNRESOLVABLE", details: { reason: "workspace_moved" } });
        expect(harness.calls).toEqual([]);
        expect(specClient.evaluate).not.toHaveBeenCalled();
      } finally {
        rmSync(link, { force: true });
      }
    });

    it("fails closed when the opener itself cannot resolve the run", async () => {
      const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
      const harness = makeCli();
      const specClient = { evaluate: vi.fn(async () => ({ kind: "response" as const, response: responseFor(catalog) })) };
      const failing: HandoffAllocator = { ...fakeHandoffs(), open: vi.fn(async () => { throw new Error("namespace down"); }) };
      await expect(toolFor({ catalog, cli: harness.cli, specClient, handoffs: failing }).execute("call", task({ recoveryOf: randomUUID() }), new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "RECOVERY_UNRESOLVABLE", details: { reason: "run_unavailable" } });
      expect(harness.calls).toEqual([]);
      expect(specClient.evaluate).not.toHaveBeenCalled();
    });

    it("falls back to the ambient handoff allocator when none is injected", async () => {
      const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
      const harness = makeCli();
      const specClient = { evaluate: vi.fn(async () => ({ kind: "response" as const, response: responseFor(catalog) })) };
      const tool = toolFor({ catalog, cli: harness.cli, specClient, cwd: null, handoffs: null });
      // open() only reads, so an unknown run id fails closed whether or not the
      // ambient endpoint namespace resolves on this machine.
      await expect(tool.execute("call", task({ recoveryOf: randomUUID() }), new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "RECOVERY_UNRESOLVABLE" });
      // A second ambient recovery reuses the memoized default allocator.
      await expect(tool.execute("call", task({ recoveryOf: randomUUID() }), new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "RECOVERY_UNRESOLVABLE" });
      expect(harness.calls).toEqual([]);
      expect(specClient.evaluate).not.toHaveBeenCalled();
    });

    it("rejects a recovery request carrying cwd or replicas > 1 before any effect", async () => {
      const { run, allocator } = await seedRecoveryRun();
      const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
      for (const overrides of [{ cwd: repoRoot }, { replicas: 2 }, { cwd: repoRoot, replicas: 2 }]) {
        const harness = makeCli();
        const specClient = { evaluate: vi.fn(async () => ({ kind: "response" as const, response: responseFor(catalog) })) };
        const params = task({ recoveryOf: run.runId, ...overrides });
        expect(() => validateLaunchParams(params)).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
        await expect(toolFor({ catalog, cli: harness.cli, specClient, handoffs: allocator }).execute("call", params, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "INVALID_INPUT" });
        expect(harness.calls).toEqual([]);
        expect(specClient.evaluate).not.toHaveBeenCalled();
      }
    });
  });

  it("keeps rejected decisions abstained and performs no launch mutation", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const harness = makeCli();
    const specClient = { evaluate: vi.fn(async () => ({ kind: "response" as const, response: responseFor(catalog, { done_when_verifiable: 0.1 }) })) };
    const tool = toolFor({ catalog, cli: harness.cli, specClient });
    const result = await tool.execute("call", task(), new AbortController().signal, undefined, extensionContext);
    expect(result.details).toMatchObject({ kind: "launch", outcome: "abstained", children: [] });
    expect(harness.calls).toEqual([]);
  });

  it("evaluates the one canonical Task against the loaded catalog", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const evaluate = vi.fn(async (input: { task: RoutingTask; catalog: Catalog }) => ({ kind: "response" as const, response: responseFor(input.catalog) }));
    const result = await toolFor({ catalog, cli: makeCli().cli, specClient: { evaluate } }).execute(
      "call",
      task(),
      new AbortController().signal,
      undefined,
      extensionContext,
    );
    expect(evaluate).toHaveBeenCalledTimes(1);
    const input = evaluate.mock.calls[0]![0];
    expect(input.task).toMatchObject({ objective: TASK.objective, scope: TASK.scope, doneWhen: TASK.doneWhen, constraints: TASK.constraints, tier: "standard" });
    expect(input.catalog).toBe(catalog);
    expect(result.details).toMatchObject({ outcome: "launched" });
  });

  it("launches with the fixed native-plus-executor tool surface", async () => {
    const baseCatalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const pi = baseCatalog.runners.get("pi")!;
    const runners = new Map(baseCatalog.runners);
    runners.set("pi", { ...pi, pools: { ...pi.pools, tools: ["read", "bash", "edit", "write", "ask_user_question", "executor_execute", "executor_skills", "executor_resume", "exec_command"] } });
    const catalog: Catalog = { ...baseCatalog, runners };
    const response: TaskModelDecision = {
      ...responseFor(catalog),
      resources: { pi: { tools: { read: 0.95, bash: 0.95, executor_execute: 0.5, exec_command: 0.5 } } },
    };
    const routerLog = vi.fn(async () => undefined) as LaunchRouterLog;
    const result = await execute(toolFor({
      catalog,
      cli: makeCli().cli,
      routerLog,
      specClient: { evaluate: vi.fn(async () => ({ kind: "response" as const, response })) },
    }), task({ objective: "Use only the Bash tool for the git commands and only the Read tool for CONTEXT.md; use no other tool." }));

    expect(result.details).toMatchObject({ outcome: "launched", children: [{ state: "launched", operatingPointId: "pi:pi-model:low" }] });
    expect(routerLog).toHaveBeenCalledWith(expect.objectContaining({
      probabilities: response,
      result: expect.objectContaining({
        configuration: expect.objectContaining({ runtime: expect.objectContaining({ tools: ["read", "bash", "edit", "write", "ask_user_question", "executor_execute", "executor_skills", "executor_resume"] }) }),
      }),
    }), expect.anything());
  });

  it("retries the next chain candidate after a proven pre-spawn start failure", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "primary" }, { runner: "pi", model: "fallback" }]);
    const harness = makeCli({
      failedPane: { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", agent_status: "unknown" },
      start: (argv, attempt) => {
        if (attempt === 0) throw new CliProtocolError("CLI_PROTOCOL_ERROR", "start failed", { exitCode: 1, killed: false, errorStream: "stderr", stderrTruncated: false, errorEnvelope: { id: "cli:agent:start", error: { code: "agent_start_failed", message: "agent process exited before becoming interactive" } } });
        return ok("start", { agent: { name: String(argv[2]), pane_id: "w1:p2", agent: "pi", terminal_id: "terminal-w1:p2", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-1" } } });
      },
    });
    const handoffs = fakeHandoffs();
    const availabilityFailureRecorder = vi.fn(async () => undefined);
    const result = await execute(toolFor({ catalog, cli: harness.cli, handoffs, availabilityFailureRecorder }), task());
    expect(result.details).toMatchObject({ outcome: "launched", children: [{ state: "launched", operatingPointId: "pi:fallback:low" }] });
    expect(availabilityFailureRecorder).toHaveBeenCalledWith(expect.objectContaining({ model: "primary" }), expect.anything(), { code: "CLI_PROTOCOL_ERROR", causeCode: "agent_start_failed" }, { root: repoRoot });
    // The runtime-resolved-model record rides the started-point commit into the durable run state.
    expect(handoffs.selectCandidate).toHaveBeenCalledWith(expect.anything(), "pi:fallback:low", "pi", { available: false, reason: "no-readback-seam" });
    expect(harness.calls.filter((call) => call[0] === "agent" && call[1] === "start")).toHaveLength(2);

    const root = mkdtempSync(join(tmpdir(), "herdr-launch-availability-"));
    try {
      const persistedHarness = makeCli({
        failedPane: { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", agent_status: "unknown" },
        start: (argv, attempt) => {
          if (attempt === 0) throw new CliProtocolError("CLI_PROTOCOL_ERROR", "start failed", { exitCode: 1, killed: false, errorStream: "stderr", stderrTruncated: false, errorEnvelope: { id: "cli:agent:start", error: { code: "agent_start_failed", message: "agent process exited before becoming interactive" } } });
          return ok("start", { agent: { name: String(argv[2]), pane_id: "w1:p2", agent: "pi", terminal_id: "terminal-w1:p2", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-1" } } });
        },
      });
      const persisted = toolFor({ catalog, cli: persistedHarness.cli, cwd: null, useDefaultFailureRecorder: true });
      await persisted.execute("call", task(), new AbortController().signal, undefined, { ...extensionContext, cwd: root });
      expect(readFileSync(join(root, ".herdr", "availability", "cooldowns.jsonl"), "utf8")).toContain('"code":"CLI_PROTOCOL_ERROR"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls through an AGY quota-class pre-spawn failure and reports the launched PI child", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-launch-quota-fallback-"));
    try {
      const catalog = catalogOf(
        [{ runner: "agy", model: "flash-low" }, { runner: "pi", model: "luna" }],
        new Map<RunnerKind, RunnerEntry>([["agy", agyRunner(["flash-low"])], ["pi", runnerEntry(["luna"])]]),
      );
      const harness = makeCli({
        failedPane: { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", agent_status: "unknown" },
        start: (argv, attempt) => {
          if (attempt === 0) throw new CliProtocolError("CLI_PROTOCOL_ERROR", "Individual quota reached", { exitCode: 1, killed: false, errorStream: "stderr", stderrTruncated: false, errorEnvelope: { id: "cli:agent:start", error: { code: "quota_exceeded", message: "Individual quota reached" } } });
          return ok("start", { agent: { name: String(argv[2]), pane_id: "w1:p2", agent: "pi", terminal_id: "terminal-w1:p2", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-1" } } });
        },
      });
      const result = await toolFor({
        catalog,
        cli: harness.cli,
        cwd: null,
        useDefaultFailureRecorder: true,
      }).execute("call", task(), new AbortController().signal, undefined, { ...extensionContext, cwd: root });

      expect(result.details).toMatchObject({ kind: "launch", outcome: "launched", children: [{ state: "launched", operatingPointId: "pi:luna:low" }] });
      expect(result.details!.children).toHaveLength(1);
      expect(harness.starts).toBe(2);
      expect(harness.children).toHaveLength(1);
      expect(readFileSync(join(root, ".herdr", "availability", "cooldowns.jsonl"), "utf8")).toContain('"failureClass":"quota"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls through an AGY spawn deadline after authoritative no-agent proof", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-launch-timeout-fallback-"));
    try {
      const catalog = catalogOf(
        [{ runner: "agy", model: "flash-low" }, { runner: "pi", model: "luna" }],
        new Map<RunnerKind, RunnerEntry>([["agy", agyRunner(["flash-low"])], ["pi", runnerEntry(["luna"])]]),
      );
      const harness = makeCli({
        failedPane: { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", agent_status: "unknown" },
        start: (argv, attempt) => {
          if (attempt === 0) throw new CliProtocolError("CLI_TIMEOUT", "start surfaced timeout", { exitCode: null, killed: true, errorEnvelope: { id: "cli:agent:start", error: { code: "quota_exceeded", message: "AGY individual quota reached" } } });
          return ok("start", { agent: { name: String(argv[2]), pane_id: "w1:p2", agent: "pi", terminal_id: "terminal-w1:p2", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-1" } } });
        },
      });
      const result = await toolFor({
        catalog,
        cli: harness.cli,
        cwd: null,
        useDefaultFailureRecorder: true,
      }).execute("call", task(), new AbortController().signal, undefined, { ...extensionContext, cwd: root });

      expect(result.details).toMatchObject({ kind: "launch", outcome: "launched", children: [{ state: "launched", operatingPointId: "pi:luna:low" }] });
      expect(harness.starts).toBe(2);
      expect(readFileSync(join(root, ".herdr", "availability", "cooldowns.jsonl"), "utf8")).toContain('"failureClass":"quota"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("compiles fallback probability maps with the router parser", async () => {
    const catalog = catalogOf(
      [{ runner: "pi", model: "primary" }, { runner: "claude", model: "fallback" }],
      new Map<RunnerKind, RunnerEntry>([["pi", runnerEntry(["primary"])], ["claude", claudeRunner(["fallback"])]]),
    );
    const response = responseFor(catalog);
    const harness = makeCli({
      failedPane: { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", agent_status: "unknown" },
      start: (argv, attempt) => {
        if (attempt === 0) throw new CliProtocolError("CLI_PROTOCOL_ERROR", "start failed", { exitCode: 1, killed: false, errorStream: "stderr", stderrTruncated: false, errorEnvelope: { id: "cli:agent:start", error: { code: "agent_start_failed", message: "agent process exited before becoming interactive" } } });
        return ok("start", { agent: { name: String(argv[2]), pane_id: "w1:p2", agent: "claude", terminal_id: "terminal-w1:p2", agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "session-1" } } });
      },
    });
    const supervision = stubSupervision();
    const availabilityFailureRecorder = vi.fn(async () => undefined);
    const claudeQuotaReader = vi.fn(async () => ({ retryNotBefore: null, zeroProgressProven: false }));
    const prompt = harness.cli.prompt;
    harness.cli.prompt = vi.fn(async (target, text, signal) => {
      expect(supervision.completionSignals).toHaveLength(1); // registered even before the prompt ack
      return prompt(target, text, signal);
    });
    const result = await execute(toolFor({ catalog, cli: harness.cli, supervision, availabilityFailureRecorder, claudeQuotaReader, specClient: { evaluate: vi.fn(async () => ({ kind: "response" as const, response })) } }), task());
    expect(result.details).toMatchObject({ outcome: "launched", children: [{ state: "launched", operatingPointId: "claude:fallback:low" }] });
    expect(harness.starts).toBe(2);
    expect(supervision.completionSignals).toHaveLength(1);
    expect(await supervision.completionSignals[0](supervision.bound[0].identity)).toEqual({ cooldownRecorded: true });
    expect(claudeQuotaReader).toHaveBeenCalledWith(supervision.bound[0].identity.agentSession, repoRoot, expect.any(Number));
    expect(availabilityFailureRecorder).toHaveBeenLastCalledWith(expect.objectContaining({ runner: "claude", model: "fallback" }), claudeRunner(["fallback"]), { code: "CLAUDE_API_ERROR", causeCode: "rate_limit", retryNotBefore: null }, { root: repoRoot });
    availabilityFailureRecorder.mockRejectedValueOnce(new Error("private cooldown error"));
    expect(await supervision.completionSignals[0](supervision.bound[0].identity)).toEqual({ cooldownRecorded: false });
  });

  it("does not re-admit unavailable candidates into the fallback chain", async () => {
    const catalog = catalogOf(
      [{ runner: "pi", model: "exhausted" }, { runner: "pi", model: "primary" }, { runner: "pi", model: "cooled" }, { runner: "claude", model: "fallback" }],
      new Map<RunnerKind, RunnerEntry>([["pi", runnerEntry(["exhausted", "primary", "cooled"])], ["claude", claudeRunner(["fallback"])]]),
    );
    const availability = vi.fn(async (candidate: AvailabilitySubject) => ({
      status: candidate.model === "exhausted" ? "known-exhausted" as const : candidate.model === "cooled" ? "local-capacity-limited" as const : "unknown" as const,
      retryNotBefore: null,
      evidence: { records: 0 },
    }));
    const harness = makeCli({
      failedPane: { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", agent_status: "unknown" },
      start: (argv, attempt) => {
        if (attempt === 0) throw new CliProtocolError("CLI_PROTOCOL_ERROR", "start failed", { exitCode: 1, killed: false, errorStream: "stderr", stderrTruncated: false, errorEnvelope: { id: "cli:agent:start", error: { code: "agent_start_failed", message: "agent process exited before becoming interactive" } } });
        return ok("start", { agent: { name: String(argv[2]), pane_id: "w1:p2", agent: "claude", terminal_id: "terminal-w1:p2", agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "session-1" } } });
      },
    });
    const result = await execute(toolFor({ catalog, cli: harness.cli, availability }), task());
    expect(result.details).toMatchObject({ outcome: "launched", children: [{ state: "launched", operatingPointId: "claude:fallback:low" }] });
    expect(harness.starts).toBe(2);
  });

  it("skips a candidate whose availability re-probe flips before its start attempt", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "primary" }, { runner: "pi", model: "fallback" }]);
    // The routing-time probe admits both points; the re-probe immediately
    // before the first start reports exhaustion, so only the fallback starts.
    let exhausted = false;
    const availability = vi.fn(async (candidate: AvailabilitySubject) => ({
      status: exhausted && candidate.model === "primary" ? "known-exhausted" as const : "unknown" as const,
      retryNotBefore: null,
      evidence: { records: 0 },
    }));
    const routerLog = vi.fn(async () => { exhausted = true; }) as unknown as LaunchRouterLog;
    const harness = makeCli();
    const result = await execute(toolFor({ catalog, cli: harness.cli, availability, routerLog }), task());
    expect(result.details).toMatchObject({ outcome: "launched", children: [{ state: "launched", operatingPointId: "pi:fallback:low" }] });
    expect(harness.starts).toBe(1);

    // A probe that cannot answer fails closed the same way.
    let throwOnReprobe = false;
    const failingAvailability = vi.fn(async (candidate: AvailabilitySubject) => {
      if (throwOnReprobe && candidate.model === "primary") throw new Error("probe unavailable");
      return { status: "unknown" as const, retryNotBefore: null, evidence: { records: 0 } };
    });
    const failingLog = vi.fn(async () => { throwOnReprobe = true; }) as unknown as LaunchRouterLog;
    const failed = await toolFor({ catalog, cli: makeCli().cli, availability: failingAvailability, routerLog: failingLog }).execute("call", task(), new AbortController().signal, undefined, extensionContext);
    expect(failed.details).toMatchObject({ outcome: "launched", children: [{ state: "launched", operatingPointId: "pi:fallback:low" }] });
  });

  it("preserves fallback_refused when authoritative pane state still has an agent", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "primary" }, { runner: "pi", model: "fallback" }]);
    const harness = makeCli({
      failedPane: { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", agent_status: "working", agent_name: "task-x-1", agent: "pi" },
      start: () => { throw new CliProtocolError("CLI_PROTOCOL_ERROR", "start failed", { exitCode: 1, killed: false, errorStream: "stderr", stderrTruncated: false, errorEnvelope: { id: "cli:agent:start", error: { code: "agent_start_failed", message: "agent process exited before becoming interactive" } } }); },
    });
    const result = await execute(toolFor({ catalog, cli: harness.cli }), task());
    expect(result.details).toMatchObject({ outcome: "failed", children: [{ state: "failed", error: { code: "LAUNCH_FAILED" } }] });
    expect(harness.calls.filter((call) => call[0] === "agent" && call[1] === "start")).toHaveLength(1);
  });

  it("treats agent_not_ready as a live-but-unready start proven by authoritative readiness", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "primary" }, { runner: "pi", model: "fallback" }]);
    const harness = makeCli({
      startLeavesBoundAgent: true,
      start: () => { throw new CliProtocolError("CLI_PROTOCOL_ERROR", "start failed", { exitCode: 1, killed: false, errorStream: "stderr", stderrTruncated: false, errorEnvelope: { id: "cli:agent:start", error: { code: "agent_not_ready", message: "agent is not an active named agent" } } }); },
    });
    const availabilityFailureRecorder = vi.fn(async () => undefined);
    const supervision = stubSupervision();
    const result = await execute(toolFor({ catalog, cli: harness.cli, availabilityFailureRecorder, supervision }), task());
    expect(result.details).toMatchObject({ outcome: "launched", children: [{ state: "launched", operatingPointId: "pi:primary:low" }] });
    expect(harness.starts).toBe(1);
    expect(availabilityFailureRecorder).not.toHaveBeenCalled();
    expect(supervision.bound).toHaveLength(1);
    expect(harness.prompts).toHaveLength(1);
  });

  it("fails closed on an agent_not_ready envelope without authoritative transport metadata", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "primary" }, { runner: "pi", model: "fallback" }]);
    const harness = makeCli({
      startLeavesBoundAgent: true,
      start: () => { throw new CliProtocolError("CLI_PROTOCOL_ERROR", "start failed", { exitCode: 2, killed: false, errorStream: "stderr", stderrTruncated: false, errorEnvelope: { id: "cli:agent:start", error: { code: "agent_not_ready", message: "agent is not an active named agent" } } }); },
    });
    const availabilityFailureRecorder = vi.fn(async () => undefined);
    const result = await execute(toolFor({ catalog, cli: harness.cli, availabilityFailureRecorder }), task());
    expect(result.details).toMatchObject({ outcome: "failed", children: [{ state: "failed", error: { code: "LAUNCH_FAILED" } }] });
    expect(harness.starts).toBe(1);
    expect(harness.prompts).toHaveLength(0);
    expect(availabilityFailureRecorder).toHaveBeenCalledTimes(1);
  });

  it("recovers readiness timing when a post-start readiness check fails", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "primary" }]);
    const harness = makeCli({ readinessError: new Error("poststate") });
    const result = await execute(toolFor({ catalog, cli: harness.cli }), task());
    expect(result.details).toMatchObject({ outcome: "failed", children: [{ state: "failed" }] });
  });

  it("appends the router decision through the default log when none is injected", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-launch-routerlog-"));
    try {
      const catalog = catalogOf([{ runner: "pi", model: "primary" }]);
      const result = await execute(toolFor({ catalog, cli: makeCli().cli, routerLog: null, cwd: root }), task());
      expect(result.details).toMatchObject({ outcome: "launched", children: [{ state: "launched" }] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not duplicate a spawned but unacknowledged agent", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "primary" }, { runner: "pi", model: "fallback" }]);
    const harness = makeCli({ start: () => ok("start", { agent: { name: "unexpected", pane_id: "w1:p2", agent: "pi" } }) });
    const result = await execute(toolFor({ catalog, cli: harness.cli }), task());
    expect(result.details).toMatchObject({ outcome: "failed", children: [{ state: "failed", error: { code: "LAUNCH_FAILED" } }] });
    expect(harness.calls.filter((call) => call[0] === "agent" && call[1] === "start")).toHaveLength(1);
  });

  it("prepares and binds one isolated worktree per replica", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const harness = makeCli();
    const isolated = worktrees();
    const handoffs = fakeHandoffs();
    const result = await toolFor({ catalog, cli: harness.cli, worktrees: isolated.manager, handoffs }).execute("call", task({ replicas: 2 }), new AbortController().signal, undefined, extensionContext);
    expect(result.details).toMatchObject({ outcome: "launched" });
    const children = result.details!.children;
    expect(children).toHaveLength(2);
    expect(children.every((child) => child.state === "launched")).toBe(true);
    expect(children.every((child) => typeof child.worktree === "string")).toBe(true);
    expect(new Set(children.map((child) => child.worktree)).size).toBe(2);
    expect(isolated.prepare).toHaveBeenCalledTimes(2);
    expect(isolated.prepare.mock.calls.map(([value]) => value.childName)).toEqual(children.map((child) => child.target));
    expect(isolated.prepare.mock.calls.every(([value]) => value.cwd === repoRoot && value.count === 2)).toBe(true);
    expect(harness.prompts).toHaveLength(2);
    expect(harness.prompts.every((prompt) => prompt.includes(SPEC_BASELINE))).toBe(true);
    expect(isolated.bindPane).toHaveBeenCalledTimes(2);
    expect(isolated.bindPane.mock.calls.map(([name]) => name)).toEqual(children.map((child) => child.target));
    const runs = (handoffs.persist as ReturnType<typeof vi.fn>).mock.calls.map(([run]) => (run as { runId: string }).runId);
    expect(new Set(runs).size).toBe(2);
  });

  it("retains child failures, partial children, and aborted tails", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);

    // A minted-name collision fails that child only; the sibling still launches.
    let launchId: string | undefined;
    const routerLog = vi.fn(async (entry: { caller?: string }) => { launchId = entry.caller; }) as unknown as LaunchRouterLog;
    const occupiedResolver = async () => {
      const minted = `task-${launchId!.slice(0, 8)}-1`;
      const occupied = {
        version: "0.8.0", protocol: 22, workspaces: [{ workspace_id: "w1", label: "workspace", focused: true }], tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main", focused: true }],
        panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "caller", agent_status: "idle" }, { pane_id: "w1:p9", tab_id: "w1:t1", workspace_id: "w1", label: "occupied", agent_name: minted, agent_status: "working" }],
        agents: [{ pane_id: "w1:p9", name: minted, agent: "pi", agent_status: "working" }],
      } as HerdrSnapshot;
      return { snapshot: occupied, context, diagnostics: baseDiagnostics, operationIds: baseOperationIds };
    };
    const collision = await toolFor({ catalog, cli: makeCli().cli, contextResolver: occupiedResolver, worktrees: worktrees().manager, routerLog }).execute("call", task({ replicas: 2 }), new AbortController().signal, undefined, extensionContext);
    expect(collision.details).toMatchObject({ outcome: "partial", children: [{ state: "failed", error: { code: "TARGET_IDENTITY_UNAVAILABLE" } }, { state: "launched" }] });

    // A failed second child keeps the launched sibling.
    const failedHarness = makeCli({
      failedPane: { pane_id: "w1:p3", tab_id: "w1:t1", workspace_id: "w1", agent_status: "unknown" },
      start: (argv, attempt) => {
        if (attempt === 1) throw new CliProtocolError("CLI_PROTOCOL_ERROR", "start failed", { exitCode: 1, killed: false, errorStream: "stderr", stderrTruncated: false, errorEnvelope: { id: "cli:agent:start", error: { code: "agent_start_failed", message: "agent process exited before becoming interactive" } } });
        return ok("start", { agent: { name: String(argv[2]), pane_id: "w1:p2", agent: "pi", terminal_id: "terminal-w1:p2", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-0" } } });
      }
    });
    const partial = await toolFor({ catalog, cli: failedHarness.cli, worktrees: worktrees().manager }).execute("call", task({ replicas: 2 }), new AbortController().signal, undefined, extensionContext);
    expect(partial.details).toMatchObject({ outcome: "partial", children: [{ state: "launched" }, { state: "failed", error: { code: "LAUNCH_FAILED" } }] });

    // An abort between routing and the first child leaves every tail not_started.
    const abort = new AbortController();
    const abortLog = vi.fn(async () => { abort.abort(); }) as unknown as LaunchRouterLog;
    const abortedLaunch = await toolFor({ catalog, cli: makeCli().cli, worktrees: worktrees().manager, routerLog: abortLog }).execute("call", task({ replicas: 2 }), abort.signal, undefined, extensionContext);
    expect(abortedLaunch.details).toMatchObject({ outcome: "failed", children: [{ state: "not_started", error: { code: "ABORTED" } }, { state: "not_started", error: { code: "ABORTED" } }] });
  });

  it("reuses a matching workload tab under the pane cap and creates the next label past it", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const caller = { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "caller", agent_status: "idle" };
    const snapshotWith = (tabs: HerdrSnapshot["tabs"], panes: HerdrSnapshot["panes"]): HerdrSnapshot => ({
      version: "0.8.0", protocol: 22, workspaces: [{ workspace_id: "w1", label: "workspace", focused: true }], tabs, panes, agents: [],
    } as HerdrSnapshot);

    // Reuse: the matching tab has room, so the child right-splits its last pane.
    const reuseSnapshot = snapshotWith(
      [{ tab_id: "w1:t1", workspace_id: "w1", label: "main", focused: true }, { tab_id: "w1:t9", workspace_id: "w1", label: "workload:implement" }],
      [caller, { pane_id: "w1:p9", tab_id: "w1:t9", workspace_id: "w1", label: "worker", agent_status: "idle" }],
    );
    const reuseHarness = makeCli();
    await execute(toolFor({ catalog, cli: reuseHarness.cli, contextResolver: resolverFor(reuseSnapshot) }), task());
    const split = reuseHarness.calls.find((call) => call[0] === "pane" && call[1] === "split");
    expect(split).toBeDefined();
    expect(split).toEqual(expect.arrayContaining(["w1:p9", "--direction", "right", "--no-focus"]));
    expect(reuseHarness.calls.some((call) => call[0] === "tab" && call[1] === "create")).toBe(false);

    // At the four-pane cap the next grammar label is created instead.
    const cappedSnapshot = snapshotWith(
      [{ tab_id: "w1:t1", workspace_id: "w1", label: "main", focused: true }, { tab_id: "w1:t9", workspace_id: "w1", label: "workload:implement" }],
      [caller, ...Array.from({ length: 4 }, (_, index) => ({ pane_id: `w1:p${9 + index}`, tab_id: "w1:t9", workspace_id: "w1", label: `w${index}`, agent_status: "idle" }))],
    );
    const cappedHarness = makeCli();
    await execute(toolFor({ catalog, cli: cappedHarness.cli, contextResolver: resolverFor(cappedSnapshot) }), task());
    const created = cappedHarness.calls.find((call) => call[0] === "tab" && call[1] === "create");
    expect(created).toBeDefined();
    expect(created).toEqual(expect.arrayContaining(["--label", "workload:implement:2", "--no-focus"]));

    // A caller-labeled tab that merely resembles the grammar is never reused.
    const alienSnapshot = snapshotWith(
      [{ tab_id: "w1:t1", workspace_id: "w1", label: "main", focused: true }, { tab_id: "w1:t9", workspace_id: "w1", label: "workload:implement-extra" }],
      [caller, { pane_id: "w1:p9", tab_id: "w1:t9", workspace_id: "w1", label: "other", agent_status: "idle" }],
    );
    const alienHarness = makeCli();
    await execute(toolFor({ catalog, cli: alienHarness.cli, contextResolver: resolverFor(alienSnapshot) }), task());
    const alienCreate = alienHarness.calls.find((call) => call[0] === "tab" && call[1] === "create");
    expect(alienCreate).toBeDefined();
    expect(alienCreate).toEqual(expect.arrayContaining(["--label", "workload:implement"]));
    expect(alienHarness.calls.some((call) => call[0] === "pane" && call[1] === "split")).toBe(false);

    // With no matching tab the first grammar label is created; focus is never taken.
    const createHarness = makeCli();
    await execute(toolFor({ catalog, cli: createHarness.cli }), task());
    const createdTab = createHarness.calls.find((call) => call[0] === "tab" && call[1] === "create");
    expect(createdTab).toEqual(expect.arrayContaining(["--workspace", "w1", "--label", "workload:implement", "--no-focus"]));
    expect(createHarness.calls.some((call) => call[0] === "agent" && call[1] === "focus")).toBe(false);

    // A tab create without a root pane reads the tab back for its anchor.
    const tabHarness = makeCli({ tabWithoutPane: true });
    await execute(toolFor({ catalog, cli: tabHarness.cli }), task());
    expect(tabHarness.calls.some((call) => call[0] === "tab" && call[1] === "get")).toBe(true);

    // A reuse split that omits the tab id keeps the matched tab's id.
    const ownership = { record: vi.fn() };
    const splitHarness = makeCli({ splitWithoutTab: true });
    await execute(toolFor({ catalog, cli: splitHarness.cli, contextResolver: resolverFor(reuseSnapshot), ownership }), task());
    expect(ownership.record).toHaveBeenCalledWith(expect.objectContaining({ kind: "pane" }));
  });

  it("groups the workload tab by the picked intent even at low confidence", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const harness = makeCli();
    const response: TaskModelDecision = { ...responseFor(catalog), intent: { value: "debug", confidence: 0.2 } };
    const specClient = { evaluate: vi.fn(async () => ({ kind: "response" as const, response })) };
    await execute(toolFor({ catalog, cli: harness.cli, specClient }), task());
    const createdTab = harness.calls.find((call) => call[0] === "tab" && call[1] === "create");
    expect(createdTab).toEqual(expect.arrayContaining(["--label", "workload:debug"]));
    expect(harness.calls.some((call) => call[0] === "tab" && call.slice(1).includes("workload:unknown"))).toBe(false);
  });

  it("covers replica preconditions, reserve failures, and start recovery", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);

    // Replicas require the worktree manager before any effect.
    await expect(toolFor({ catalog, cli: makeCli().cli }).execute("call", task({ replicas: 2 }), new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "WORKTREE_UNAVAILABLE" });

    // A reserve failure fails each child closed and releases its worktree.
    const prepared = worktrees();
    const reserveFailure = await toolFor({ catalog, cli: makeCli().cli, worktrees: prepared.manager, supervision: stubSupervision({ reserveError: new Error("reserve") }) }).execute("call", task({ replicas: 2 }), new AbortController().signal, undefined, extensionContext);
    expect(reserveFailure.details).toMatchObject({ outcome: "failed", children: [{ state: "failed", error: { code: "SUPERVISION_UNAVAILABLE" } }, { state: "failed", error: { code: "SUPERVISION_UNAVAILABLE" } }] });
    expect(prepared.release).toHaveBeenCalledTimes(2);
    expect(prepared.release).toHaveBeenCalledWith(reserveFailure.details!.children[0]!.target);

    const genericStart = makeCli({ start: () => { throw new Error("start exploded"); } });
    const failed = await toolFor({ catalog, cli: genericStart.cli }).execute("call", task(), new AbortController().signal, undefined, extensionContext);
    expect(failed.details).toMatchObject({ outcome: "failed", children: [{ state: "failed", error: { code: "LAUNCH_FAILED" } }] });

    const fallbackReadFailure = makeCli({
      paneError: new Error("pane read failed"),
      start: () => { throw new CliProtocolError("CLI_PROTOCOL_ERROR", "start failed", { exitCode: 1, killed: false, errorStream: "stderr", stderrTruncated: false, errorEnvelope: { id: "cli:agent:start", error: { code: "agent_start_failed", message: "agent process exited before becoming interactive" } } }); }
    });
    const unreadable = await toolFor({ catalog: catalogOf([{ runner: "pi", model: "primary" }, { runner: "pi", model: "fallback" }]), cli: fallbackReadFailure.cli }).execute("call", task(), new AbortController().signal, undefined, extensionContext);
    expect(unreadable.details).toMatchObject({ outcome: "failed", children: [{ state: "failed", error: { code: "POSTSTATE_UNAVAILABLE" } }] });
    const nonErrorReadFailure = makeCli({ paneError: "pane read failed", start: () => { throw new CliProtocolError("CLI_PROTOCOL_ERROR", "start failed", { exitCode: 1, killed: false, errorStream: "stderr", stderrTruncated: false, errorEnvelope: { id: "cli:agent:start", error: { code: "agent_start_failed", message: "agent process exited before becoming interactive" } } }); } });
    const unreadableNonError = await toolFor({ catalog: catalogOf([{ runner: "pi", model: "primary" }, { runner: "pi", model: "fallback" }]), cli: nonErrorReadFailure.cli }).execute("call", task(), new AbortController().signal, undefined, extensionContext);
    expect(unreadableNonError.details).toMatchObject({ outcome: "failed", children: [{ state: "failed", error: { code: "POSTSTATE_UNAVAILABLE" } }] });

    let busyAttempt = 0;
    const busy = makeCli({ start: (argv) => {
      if (busyAttempt++ === 0) throw new CliProtocolError("CLI_PROTOCOL_ERROR", "busy", { exitCode: 1, killed: false, errorStream: "stderr", stderrTruncated: false, errorEnvelope: { id: "cli:agent:start", error: { code: "agent_pane_busy", message: "pane busy" } } });
      return ok("start", { agent: { name: String(argv[2]), pane_id: "w1:p2", agent: "pi", terminal_id: "terminal-w1:p2", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-1" } } });
    } });
    const busyResult = await execute(toolFor({ catalog, cli: busy.cli }), task());
    expect(busyResult.details).toMatchObject({ outcome: "launched" });

    // A spawn-deadline timeout without an error envelope records its own prose.
    let timedAttempt = 0;
    const timedOut = makeCli({
      failedPane: { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", agent_status: "unknown" },
      start: (argv) => {
        if (timedAttempt++ === 0) throw new CliProtocolError("CLI_TIMEOUT", "spawn deadline exceeded", { exitCode: null, killed: true, errorStream: "stderr", stderrTruncated: false });
        return ok("start", { agent: { name: String(argv[2]), pane_id: "w1:p2", agent: "pi", terminal_id: "terminal-w1:p2", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-1" } } });
      },
    });
    const timedResult = await execute(toolFor({ catalog: catalogOf([{ runner: "pi", model: "primary" }, { runner: "pi", model: "fallback" }]), cli: timedOut.cli }), task());
    expect(timedResult.details).toMatchObject({ outcome: "launched", children: [{ state: "launched", operatingPointId: "pi:fallback:low" }] });

    // A mutation whose envelope omitted the ids is reconciled back into
    // `created` from the live snapshot before the failure returns.
    const caller = { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "caller", agent_status: "idle" };
    const baselineSnapshot = { version: "0.8.0", protocol: 22, workspaces: [{ workspace_id: "w1", label: "workspace", focused: true }], tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main", focused: true }], panes: [caller], agents: [] } as HerdrSnapshot;
    const ghostPane = { pane_id: "w1:p9", tab_id: "w1:t9", workspace_id: "w1", label: "ghost" };
    const ghostAgent = { pane_id: "w1:p9", name: "ghost", agent: "pi", agent_id: "agent-9" };
    const ghostSnapshot = { ...baselineSnapshot, tabs: [...baselineSnapshot.tabs, { tab_id: "w1:t9", workspace_id: "w1", label: "workload:implement" }], panes: [...baselineSnapshot.panes, ghostPane], agents: [ghostAgent] } as HerdrSnapshot;
    const ghostCli: LaunchCli = {
      prompt: vi.fn(async () => ok("prompt", {})),
      runJson: vi.fn(async (argv) => {
        if (argv[0] === "pane" && argv[1] === "current") return ok("current", { type: "pane_current", pane: caller });
        if (argv[0] === "api") return ok("snapshot", { type: "session_snapshot", snapshot: ghostSnapshot });
        if (argv[0] === "tab" && argv[1] === "create") return ok("tab", {});
        if (argv[0] === "pane" && argv[1] === "get") return ok("pane-get", { pane: ghostPane });
        if (argv[0] === "agent" && argv[1] === "get") return ok("agent-get", { agent: ghostAgent });
        throw new Error(`unexpected argv: ${argv.join(" ")}`);
      }),
    };
    const ghosted = await toolFor({ catalog, cli: ghostCli, contextResolver: resolverFor(baselineSnapshot) }).execute("call", task(), new AbortController().signal, undefined, extensionContext);
    expect(ghosted.details).toMatchObject({ outcome: "failed", children: [{ state: "failed" }] });
  });

  it("covers executor guards, abort fencing, resolver errors, and prepared cleanup", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const frozenRelease = vi.fn(async () => { throw new Error("release"); });
    await expect(toolFor({ catalog, cli: makeCli().cli, launchGate: async () => ({ check: vi.fn(async () => { throw new Error("frozen"); }), release: frozenRelease }) }).execute("call", task(), new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "LAUNCH_FROZEN" });
    expect(frozenRelease).toHaveBeenCalled();

    // The per-child gate is rechecked; a frozen child fails closed inside the result.
    let gateCalls = 0;
    const childRelease = vi.fn(async () => { throw new Error("child release"); });
    const frozenChild = await toolFor({ catalog, cli: makeCli().cli, launchGate: async () => gateCalls++ === 0 ? { check: vi.fn(async () => undefined), release: vi.fn(async () => undefined) } : { check: vi.fn(async () => { throw new Error("child frozen"); }), release: childRelease } }).execute("call", task(), new AbortController().signal, undefined, extensionContext);
    expect(frozenChild.details).toMatchObject({ outcome: "failed", children: [{ state: "failed", error: { code: "LAUNCH_FROZEN" } }] });
    expect(childRelease).toHaveBeenCalled();

    const snapshot = { version: "0.8.0", protocol: 22, workspaces: [{ workspace_id: "w1", label: "workspace", focused: true }], tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main", focused: true }], panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "caller", agent_status: "idle" }], agents: [] } as HerdrSnapshot;
    const abort = new AbortController();
    const abortedChild = await toolFor({ catalog, cli: makeCli().cli, contextResolver: async () => { abort.abort("caller"); return { snapshot, context, diagnostics: baseDiagnostics, operationIds: baseOperationIds }; } }).execute("call", task(), abort.signal, undefined, extensionContext);
    expect(abortedChild.details).toMatchObject({ outcome: "failed", children: [{ state: "failed", error: { code: "ABORTED" } }] });

    const resolverFailure = await toolFor({ catalog, cli: makeCli().cli, contextResolver: async () => { throw new Error("resolve"); } }).execute("call", task(), new AbortController().signal, undefined, extensionContext);
    expect(resolverFailure.details).toMatchObject({ outcome: "failed", children: [{ state: "failed", error: { code: "CLI_PROTOCOL_ERROR" } }] });

    // A caller context with no workspace id fails the child closed before any
    // workload topology mutation.
    const noWorkspace = await toolFor({ catalog, cli: makeCli().cli, contextResolver: async () => ({ snapshot, context: { workspaceId: "", tabId: "w1:t1", paneId: "w1:p1" }, diagnostics: baseDiagnostics, operationIds: baseOperationIds }) }).execute("call", task(), new AbortController().signal, undefined, extensionContext);
    expect(noWorkspace.details).toMatchObject({ outcome: "failed", children: [{ state: "failed" }] });

    // A failed topology mutation releases the child's prepared worktree.
    const workloadSnapshot = { ...snapshot, tabs: [...snapshot.tabs, { tab_id: "w1:t9", workspace_id: "w1", label: "workload:implement" }], panes: [...snapshot.panes, { pane_id: "w1:p9", tab_id: "w1:t9", workspace_id: "w1", label: "worker", agent_status: "idle" }] } as HerdrSnapshot;
    const isolated = worktrees();
    const splitFailure = await toolFor({ catalog, cli: makeCli({ splitError: new Error("split") }).cli, contextResolver: resolverFor(workloadSnapshot), worktrees: isolated.manager }).execute("call", task({ replicas: 2 }), new AbortController().signal, undefined, extensionContext);
    expect(splitFailure.details).toMatchObject({ outcome: "failed", children: [{ state: "failed" }, { state: "failed" }] });
    expect(isolated.release).toHaveBeenCalledWith(splitFailure.details!.children[0]!.target);
  });

  it("covers pre-spawn compile/source fallback and reconciliation", async () => {
    const catalog = catalogOf(
      [{ runner: "pi", model: "primary" }, { runner: "claude", model: "fallback" }],
      new Map<RunnerKind, RunnerEntry>([["pi", runnerEntry(["primary"])], ["claude", claudeRunner(["fallback"])]]),
    );
    const invalidFallbackResponse: TaskModelDecision = { ...responseFor(catalog), resources: { pi: { tools: { read: 0.95 } }, claude: { tools: { forbidden: 0.95 } } } };
    const compiledFallback = await execute(toolFor({ catalog, cli: makeCli().cli, specClient: { evaluate: vi.fn(async () => ({ kind: "response" as const, response: invalidFallbackResponse })) } }), task());
    expect(compiledFallback.details).toMatchObject({ outcome: "launched", children: [{ state: "launched", operatingPointId: "pi:primary:low" }] });

    const promptSources = { create: vi.fn().mockRejectedValueOnce(new Error("prompt source unavailable")).mockResolvedValue({ path: "/tmp/prompt-source" }) };
    const sourceFallback = await execute(toolFor({ catalog, cli: makeCli().cli, promptSources }), task());
    expect(sourceFallback.details).toMatchObject({ outcome: "launched", children: [{ state: "launched", operatingPointId: "claude:fallback:low" }] });

    const bindFailed = await toolFor({ catalog: catalogOf([{ runner: "pi", model: "pi-model" }]), cli: makeCli().cli, supervision: stubSupervision({ bindError: new Error("bind transport") }) }).execute("call", task(), new AbortController().signal, undefined, extensionContext);
    expect(bindFailed.details).toMatchObject({ outcome: "failed", children: [{ state: "failed", paneId: "w1:p2", tabId: "w1:t2", supervisorJobId: "job_supervisor", effectCertainty: "partial", error: { code: "LAUNCH_FAILED", paneId: "w1:p2", tabId: "w1:t2", supervisorJobId: "job_supervisor", effectCertainty: "partial" } }] });

    // A reconciliation readback that throws mid-failure degrades to unknown certainty.
    let throwBaseline = false;
    const baselinePanes = [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "caller", agent_status: "idle" }];
    const throwingBaseline = { version: "0.8.0", protocol: 22, workspaces: [{ workspace_id: "w1", label: "workspace", focused: true }], tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main", focused: true }], get panes() { if (throwBaseline) throw new Error("baseline readback"); return baselinePanes; }, agents: [] } as HerdrSnapshot;
    const reconciliationFailure = makeCli({ start: () => { throwBaseline = true; throw new Error("start after baseline"); } });
    const reconciled = await toolFor({ catalog: catalogOf([{ runner: "pi", model: "pi-model" }]), cli: reconciliationFailure.cli, contextResolver: resolverFor(throwingBaseline) }).execute("call", task(), new AbortController().signal, undefined, extensionContext);
    expect(reconciled.details).toMatchObject({ outcome: "failed", children: [{ state: "failed", error: { code: "LAUNCH_FAILED" } }] });
  });

  it("covers prompt dispatch, acknowledgement, and confirmation failures", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const dispatchFailure = makeCli({ prompt: () => { throw Object.assign(new Error("dispatch"), { details: { promptDispatch: { state: "rejected", requestId: "req-1" } } }); } });
    const rejected = await toolFor({ catalog, cli: dispatchFailure.cli }).execute("call", task(), new AbortController().signal, undefined, extensionContext);
    expect(rejected.details).toMatchObject({ outcome: "failed", children: [{ state: "failed", error: { code: "LAUNCH_FAILED", paneId: "w1:p2", tabId: "w1:t2", supervisorJobId: "job_supervisor", effectCertainty: "partial" } }] });
    const invalidAcknowledgement = makeCli({ prompt: () => ok("prompt", { invalid: true }) });
    const invalidAck = await toolFor({ catalog, cli: invalidAcknowledgement.cli }).execute("call", task(), new AbortController().signal, undefined, extensionContext);
    expect(invalidAck.details).toMatchObject({ outcome: "failed", children: [{ state: "failed", error: { code: "LAUNCH_FAILED" } }] });
    const confirmationFailure = makeCli({ agentError: new Error("poststate") });
    const unconfirmed = await toolFor({ catalog, cli: confirmationFailure.cli }).execute("call", task(), new AbortController().signal, undefined, extensionContext);
    // PROMPT_UNCONFIRMED stays distinguishable in the uniform child error and
    // carries the recovery handles — the pane and the retained supervisor job —
    // a caller needs to inspect a possibly-consumed child instead of relaunching.
    const unconfirmedError = unconfirmed.details!.children[0]!.error!;
    expect(unconfirmed.details).toMatchObject({ outcome: "failed", children: [{ state: "failed", error: { code: "PROMPT_UNCONFIRMED" } }] });
    expect(unconfirmedError.causeCode).toBe("PROMPT_UNCONFIRMED");
    expect(unconfirmedError.paneId).toMatch(/^w1:p\d+$/u);
    expect(unconfirmedError.supervisorJobId).toBe("job_supervisor");
    expect(unconfirmedError.tabId).toBe("w1:t2");
    expect(unconfirmedError.effectCertainty).toBe("partial");
    for (const state of ["not_written", "acknowledged", "unknown", "other"]) {
      const malformedDispatch = makeCli({ prompt: () => { throw Object.assign(new Error("dispatch state"), { details: { promptDispatch: { state, requestId: "bad\n" } } }); } });
      const malformed = await toolFor({ catalog, cli: malformedDispatch.cli }).execute("call", task(), new AbortController().signal, undefined, extensionContext);
      expect(malformed.details).toMatchObject({ outcome: "failed", children: [{ state: "failed" }] });
    }
    const malformedDetails = makeCli({ prompt: () => { throw Object.assign(new Error("dispatch details"), { details: "bad" }); } });
    const malformedResult = await toolFor({ catalog, cli: malformedDetails.cli }).execute("call", task(), new AbortController().signal, undefined, extensionContext);
    expect(malformedResult.details).toMatchObject({ outcome: "failed", children: [{ state: "failed" }] });
    // The published child error never carries the diagnostic blob or cause prose.
    expect(unconfirmed.details!.children[0]!.error!.message).not.toContain("HERDR_LAUNCH_DIAGNOSTIC");
    expect(unconfirmed.details!.children[0]!.error!.message).not.toContain("poststate");
  });

  it("publishes launch updates and renders task calls and results", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const updates = vi.fn();
    const labeledTool = toolFor({ catalog, cli: makeCli().cli });
    const call = labeledTool.renderCall?.(task({ label: "sprint", replicas: 2, tier: "strong" }), {} as never, {} as never);
    expect(call).toBeDefined();
    const labeled = await labeledTool.execute("call", task({ label: "sprint" }), new AbortController().signal, updates, extensionContext);
    expect(labeled.details).toMatchObject({ outcome: "launched", children: [{ state: "launched" }] });
    expect(updates).toHaveBeenCalled();
    expect((updates.mock.calls[0]![0] as { details: LaunchResult }).details).toMatchObject({ kind: "launch" });
    const rendered = labeledTool.renderResult?.(labeled as never, {} as never, {} as never, {} as never);
    expect(rendered).toBeDefined();
    // renderCall tolerates absent or mistyped display fields.
    expect(labeledTool.renderCall?.({} as never, {} as never, {} as never)).toBeDefined();
    expect(labeledTool.renderCall?.({ label: 7, tier: 3, replicas: "x" } as never, {} as never, {} as never)).toBeDefined();
    expect(labeledTool.renderResult?.({ details: undefined } as never, {} as never, {} as never, {} as never)).toBeDefined();
    expect(labeledTool.renderResult?.({ details: { kind: "other" } } as never, {} as never, {} as never, {} as never)).toBeDefined();
  });

  it("covers AGY, Devin, agent identity, and supervision-bind lifecycle branches", async () => {
    const agyCatalog = parseCatalog(`version: 2
runners:
  agy:
    models: [{model: agy-utility}, {model: agy-economy}, {model: agy-model}, {model: agy-strong}, {model: agy-frontier}, {model: agy-max}]
    quota: {provider: google, billingProduct: antigravity, account: primary, scope: account}
    defaults: {mode: plan, timeoutMinutes: 30, sessionPersistence: true}
    plumbing: {sessionPersistence: required, promptDelivery: bootstrap, skillSelection: ambient, toolSelection: ambient}
skills: []
plugins: []
mcp: {}
quotaSources:
  - {name: reactive-cooldowns, kind: floor}
pointPolicy:
  agy:agy-utility: {costClass: medium, latencyClass: medium}
  agy:agy-economy: {costClass: medium, latencyClass: medium}
  agy:agy-model: {costClass: medium, latencyClass: medium}
  agy:agy-strong: {costClass: medium, latencyClass: medium}
  agy:agy-frontier: {costClass: medium, latencyClass: medium}
  agy:agy-max: {costClass: medium, latencyClass: medium}
tierChains:
  utility: [agy:agy-utility]
  economy: [agy:agy-economy]
  standard: [agy:agy-model]
  strong: [agy:agy-strong]
  frontier: [agy:agy-frontier]
  max: [agy:agy-max]
`, { path: "/tmp/agy-catalog.yaml", scopeRoot: "/tmp" });
    const agyHarness = makeCli({ agentId: "agy-agent", prompt: () => ok("prompt", { type: "agent_prompted", agent: agentRecord(agyHarness.children[0]!) }) });
    const agySupervision = stubSupervision();
    const agyResult = await execute(toolFor({ catalog: agyCatalog, cli: agyHarness.cli, supervision: agySupervision }), task());
    expect(agyResult.details).toMatchObject({ outcome: "launched", children: [{ state: "launched", operatingPointId: "agy:agy-model", supervisorJobId: "job_supervisor" }] });
    expect(agySupervision.provisionalBindAttempts).toHaveLength(1);
    expect(agySupervision.provisionalBindAttempts[0]).toMatchObject({ operatingPointId: "agy:agy-model" });
    expect(agySupervision.strengthenAttempts).toHaveLength(1);
    expect(agySupervision.strengthenAttempts[0]!.handoff!.owner).toEqual({ paneId: "w1:p1", session: null });
    const strengthened = await toolFor({ catalog: agyCatalog, cli: makeCli().cli, supervision: stubSupervision({ strengthenError: new Error("strengthen transport") }) }).execute("call", task(), new AbortController().signal, undefined, extensionContext);
    expect(strengthened.details).toMatchObject({ outcome: "failed", children: [{ state: "failed", error: { code: "LAUNCH_FAILED" } }] });
    const managerAgy = makeCli({ prompt: () => ok("prompt", { type: "agent_prompted", agent: agentRecord(managerAgy.children[0]!) }) });
    const labeled = await execute(toolFor({ catalog: agyCatalog, cli: managerAgy.cli }), task({ label: "manager" }));
    expect(labeled.details!.children[0]!.target).toMatch(/^task-[0-9a-f]{8}-1$/u);
    expect(managerAgy.calls.some((call) => call[0] === "pane" && call[1] === "report-metadata")).toBe(true);

    const devinCatalog = parseCatalog(`version: 2
runners:
  devin:
    models: [{model: devin-utility}, {model: devin-economy}, {model: devin-model}, {model: devin-strong}, {model: devin-frontier}, {model: devin-max}]
    quota: {provider: cognition, billingProduct: devin, account: primary, scope: account}
    defaults: {permissionMode: dangerous, timeoutMinutes: 30, sessionPersistence: true}
    plumbing: {sessionPersistence: required, promptDelivery: none, skillSelection: ambient, toolSelection: ambient}
skills: []
plugins: []
mcp: {}
quotaSources:
  - {name: reactive-cooldowns, kind: floor}
pointPolicy:
  devin:devin-utility: {costClass: medium, latencyClass: medium}
  devin:devin-economy: {costClass: medium, latencyClass: medium}
  devin:devin-model: {costClass: medium, latencyClass: medium}
  devin:devin-strong: {costClass: medium, latencyClass: medium}
  devin:devin-frontier: {costClass: medium, latencyClass: medium}
  devin:devin-max: {costClass: medium, latencyClass: medium}
tierChains:
  utility: [devin:devin-utility]
  economy: [devin:devin-economy]
  standard: [devin:devin-model]
  strong: [devin:devin-strong]
  frontier: [devin:devin-frontier]
  max: [devin:devin-max]
`, { path: "/tmp/devin-catalog.yaml", scopeRoot: "/tmp" });
    const lease = { release: vi.fn(async () => undefined) };
    const queueFlush = { writeSection: vi.fn(async () => lease) };
    const devin = await execute(toolFor({ catalog: devinCatalog, cli: makeCli().cli, queueFlush: queueFlush as unknown as LaunchDependencies["queueFlush"] }), task());
    expect(devin.details).toMatchObject({ children: [{ state: "launched", operatingPointId: "devin:devin-model" }] });
    expect(queueFlush.writeSection).toHaveBeenCalledWith("w1:p2");
    expect(lease.release).toHaveBeenCalled();

    const withId = makeCli({ start: (argv) => ok("start", { agent: { name: String(argv[2]), pane_id: "w1:p2", agent: "pi", terminal_id: "terminal-w1:p2", agent_id: "agent-1", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-0" } } }) });
    const supervision = stubSupervision();
    await execute(toolFor({ catalog: catalogOf([{ runner: "pi", model: "pi-model" }]), cli: withId.cli, supervision }), task());
    expect(supervision.bound[0]).toMatchObject({ handoff: { agentId: "agent-1" } });

    const bindFailure = new SupervisionBindError("bind failed", { cause: "test" });
    const bound = await toolFor({ catalog: catalogOf([{ runner: "pi", model: "pi-model" }]), cli: makeCli().cli, supervision: stubSupervision({ bindError: bindFailure }) }).execute("call", task(), new AbortController().signal, undefined, extensionContext);
    expect(bound.details).toMatchObject({ outcome: "failed", children: [{ state: "failed", error: { code: "LAUNCH_FAILED" } }] });
  });

  it("appends the one decision before any child mutation", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const harness = makeCli();
    const routerLogFn = vi.fn(async () => undefined);
    const tool = toolFor({ catalog, cli: harness.cli, routerLog: routerLogFn as LaunchRouterLog });
    await tool.execute("call", task(), new AbortController().signal, undefined, extensionContext).catch(() => undefined);
    expect(routerLogFn).toHaveBeenCalledTimes(1);
    const firstMutation = (harness.cli.runJson as ReturnType<typeof vi.fn>).mock.calls.findIndex(([argv]) => (argv[0] === "tab" && argv[1] === "create") || (argv[0] === "pane" && argv[1] === "split"));
    expect(firstMutation).toBeGreaterThanOrEqual(0);
    expect(routerLogFn.mock.invocationCallOrder[0]).toBeLessThan((harness.cli.runJson as ReturnType<typeof vi.fn>).mock.invocationCallOrder[firstMutation]!);
  });

  it("covers routing failures and automatic delivery selection", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const catalogRouterLog = vi.fn(async () => undefined) as LaunchRouterLog;
    const abstained = await toolFor({ catalog, cli: makeCli().cli, catalogLoad: async () => { throw new Error("catalog unavailable"); }, routerLog: catalogRouterLog }).execute("call", task(), new AbortController().signal, undefined, extensionContext);
    expect(abstained.details).toMatchObject({ kind: "launch", outcome: "abstained", children: [] });
    expect(catalogRouterLog).toHaveBeenCalledWith(expect.objectContaining({ result: expect.objectContaining({ kind: "abstained", reason: "catalog_unavailable" }) }), expect.anything());
    const transportFailure = await toolFor({ catalog, cli: makeCli().cli, specClient: { evaluate: vi.fn(async () => { throw new Error("transport"); }) } }).execute("call", task(), new AbortController().signal, undefined, extensionContext);
    expect(transportFailure.details).toMatchObject({ outcome: "abstained", children: [] });
    const noPoints = await toolFor({ catalog: { ...catalog, points: [] }, cli: makeCli().cli, specClient: { evaluate: vi.fn(async () => { throw new Error("transport"); }) } }).execute("call", task(), new AbortController().signal, undefined, extensionContext);
    expect(noPoints.details).toMatchObject({ outcome: "abstained", children: [] });
    const invalidResponse = await toolFor({ catalog, cli: makeCli().cli, specClient: { evaluate: vi.fn(async () => ({ kind: "response" as const, response: undefined as never })) } }).execute("call", task(), new AbortController().signal, undefined, extensionContext);
    expect(invalidResponse.details).toMatchObject({ outcome: "abstained", children: [] });
    const logFailure = await toolFor({ catalog, cli: makeCli().cli, routerLog: vi.fn(async () => { throw new Error("log"); }) as LaunchRouterLog }).execute("call", task(), new AbortController().signal, undefined, extensionContext);
    expect(logFailure.details).toMatchObject({ outcome: "failed", children: [], error: { code: "ROUTER_LOG_UNAVAILABLE" } });
    const preflight = await toolFor({ catalog, cli: makeCli().cli, preflight: async () => { throw Object.assign(new Error("preflight"), { code: "PREFLIGHT_FAILED" }); } }).execute("call", task(), new AbortController().signal, undefined, extensionContext).catch((error) => error);
    expect(preflight).toMatchObject({ code: "PREFLIGHT_FAILED", details: { phase: "validate" } });

    // Delivery is runtime-owned: a rendered payload over the inline bound moves
    // to the attachment, and one over the attachment bound fails closed.
    const attachments = fakeAttachments();
    const harness = makeCli();
    const big = await execute(toolFor({ catalog, cli: harness.cli, attachments }), task({ objective: `Ship ${"x".repeat(20_000)}` }));
    expect(big.details).toMatchObject({ outcome: "launched" });
    expect(attachments.publish).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining("Objective:") }));
    expect(harness.prompts[0]).toContain("delivery: attachment");
    expect(harness.prompts[0]).toContain("attachment-path: /tmp/recipient/body.txt");
    expect(harness.prompts[0]).not.toContain("x".repeat(1_000));
    // `scope` stays out of the supervision digest, so it still reaches the
    // delivery bound — an oversized objective is refused earlier by the
    // assignment budget preflight.
    await expect(toolFor({ catalog, cli: makeCli().cli }).execute("call", task({ scope: "x".repeat(1_100_000) }), new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "MESSAGE_TOO_LARGE" });
  });

  it("admits an assignment at the evidence cap and rejects one byte over before any effect", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    // The exact normalized canonical bytes the evidence builder measures:
    // {constraints, doneWhen, objective, progressMarkers} in canonical order.
    const wrapBytes = Buffer.byteLength(canonicalJson({ constraints: TASK.constraints, doneWhen: TASK.doneWhen, objective: "", progressMarkers: [] }), "utf8");
    const objective = "x".repeat(EVIDENCE_ASSIGNMENT_MAX_BYTES - wrapBytes);

    // At the boundary the Task launches and the reservation gets the digest.
    const harness = makeCli();
    const supervision = stubSupervision();
    const requests: SupervisionReserveRequest[] = [];
    const reserve = supervision.reserve;
    supervision.reserve = vi.fn(async (value) => { requests.push(value); return reserve(value); });
    const result = await execute(toolFor({ catalog, cli: harness.cli, supervision }), task({ objective }));
    expect(result.details).toMatchObject({ outcome: "launched" });
    expect(requests[0]!.settings!.supervisionDigest).toMatchObject({ objective });

    // One byte over is a validate-phase refusal with count-only diagnostics —
    // before the gate, evaluation, routing persistence, or any child effect.
    const over = makeCli();
    const specClient = { evaluate: vi.fn(async () => ({ kind: "response" as const, response: responseFor(catalog) })) };
    const routerLog = vi.fn<LaunchRouterLog>(async () => undefined);
    const launchGate = { check: vi.fn(async () => undefined), release: vi.fn(async () => undefined) };
    const overSupervision = stubSupervision();
    await expect(
      toolFor({ catalog, cli: over.cli, specClient, routerLog, launchGate: async () => launchGate, supervision: overSupervision })
        .execute("call", task({ objective: `${objective}y` }), new AbortController().signal, undefined, extensionContext),
    ).rejects.toMatchObject({
      code: "ASSIGNMENT_OVER_BUDGET",
      details: {
        bytes: EVIDENCE_ASSIGNMENT_MAX_BYTES + 1,
        budget: EVIDENCE_ASSIGNMENT_MAX_BYTES,
        phase: "validate",
        causeMessage: "Task assignment exceeds the supervision evidence byte budget",
      },
    });
    expect(over.calls).toEqual([]);
    expect(launchGate.check).not.toHaveBeenCalled();
    expect(specClient.evaluate).not.toHaveBeenCalled();
    expect(routerLog).not.toHaveBeenCalled();
    expect(overSupervision.reserved).toEqual([]);
  });

  it("times out and logs a hung task evaluation without starting a child", async () => {
    vi.useFakeTimers();
    try {
      const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
      const harness = makeCli();
      const routerLog = vi.fn(async () => undefined) as LaunchRouterLog;
      const evaluate = vi.fn(async () => new Promise<never>(() => undefined));
      const tool = toolFor({ catalog, cli: harness.cli, routerLog, specClient: { evaluate } });
      const pending = tool.execute("call", task(), new AbortController().signal, undefined, extensionContext);
      await vi.waitFor(() => expect(evaluate).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(20_000);
      const result = await pending;
      expect(routerLog).toHaveBeenCalledWith(expect.objectContaining({ result: { kind: "abstained", reason: "transport_failed", component: "evaluation" } }), expect.objectContaining({ root: repoRoot }));
      expect(result.details).toMatchObject({ kind: "launch", outcome: "abstained", children: [] });
      expect(harness.children).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("loads the shipped catalog when the project cwd has no catalog", async () => {
    let loaded: Catalog | undefined;
    const routerLog = vi.fn(async () => undefined) as LaunchRouterLog;
    const tool = createLaunchTool({
      cli: makeCli().cli,
      context,
      cwd: repoRoot,
      preflight: async () => undefined,
      supervision: stubSupervision(),
      launchGate: openLaunchGate,
      specClient: {
        evaluate: vi.fn(async (input: { catalog: Catalog }) => {
          loaded = input.catalog;
          return {
            kind: "response" as const,
            response: responseFor(input.catalog, { done_when_verifiable: 0.1 }),
          };
        }),
      },
      routerLog,
    });
    const result = await tool.execute("call", task(), new AbortController().signal, undefined, extensionContext);
    expect(loaded).toBeDefined();
    expect(result.details).toMatchObject({ kind: "launch", outcome: "abstained", children: [] });
    expect(routerLog).toHaveBeenCalledWith(expect.objectContaining({ result: expect.objectContaining({ kind: "rejected" }) }), expect.anything());
  });

  it("rechecks the child gate and rejects an unavailable prompt transport", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const gate = { check: vi.fn(async () => undefined), release: vi.fn(async () => undefined) };
    gate.check.mockImplementationOnce(async () => undefined).mockImplementationOnce(async () => { throw new Error("frozen after routing"); });
    const frozen = await toolFor({ catalog, cli: makeCli().cli, launchGate: async () => gate }).execute("call", task(), new AbortController().signal, undefined, extensionContext);
    expect(frozen.details).toMatchObject({ outcome: "failed", children: [{ state: "failed", error: { code: "LAUNCH_FROZEN" } }] });
    const harness = makeCli();
    const noPrompt = { runJson: harness.cli.runJson } as unknown as LaunchCli;
    await expect(toolFor({ catalog, cli: noPrompt }).execute("call", task(), new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "CLI_INCOMPATIBLE" });
  });

  it("cannot bypass the freeze gate", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const harness = makeCli();
    const gate = { check: vi.fn(async () => { throw new Error("frozen"); }), release: vi.fn(async () => undefined) };
    await expect(toolFor({ catalog, cli: harness.cli, launchGate: async () => gate }).execute("call", task(), new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "LAUNCH_FROZEN" });
    expect(harness.calls).toEqual([]);
    expect(gate.release).toHaveBeenCalled();
  });

  it("retains precondition failures, worktree failures, and provenance warnings", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const reservation = stubSupervision({ reserveError: new Error("reserve failed") });
    const reserveHarness = makeCli();
    const reserved = await toolFor({ catalog, cli: reserveHarness.cli, supervision: reservation }).execute("call", task(), new AbortController().signal, undefined, extensionContext);
    expect(reserved.details).toMatchObject({ outcome: "failed", children: [{ state: "failed", error: { code: "SUPERVISION_UNAVAILABLE" } }] });
    expect(reserveHarness.calls.some((call) => call[0] === "pane" && call[1] === "split")).toBe(false);
    expect(reserveHarness.calls.some((call) => call[0] === "tab" && call[1] === "create")).toBe(false);
    const coded = await toolFor({ catalog, cli: makeCli().cli, supervision: stubSupervision({ reserveError: Object.assign(new Error("coded reserve"), { code: "RESERVE_CODE" }) }) }).execute("call", task(), new AbortController().signal, undefined, extensionContext);
    expect(coded.details).toMatchObject({ outcome: "failed", children: [{ state: "failed", error: { code: "SUPERVISION_UNAVAILABLE" } }] });
    const release = vi.fn(async () => undefined);
    const grant = { path: "/tmp/grant", token: "token", renew: vi.fn(async () => undefined), release };
    const publishFailure: AttachmentStore = { ...fakeAttachments(), ensureRecipient: vi.fn(async () => grant), publish: vi.fn(async () => { throw new Error("publish failed"); }) };
    const unpublished = await toolFor({ catalog, cli: makeCli().cli, attachments: publishFailure }).execute("call", task({ objective: `x${"y".repeat(20_000)}` }), new AbortController().signal, undefined, extensionContext);
    expect(unpublished.details).toMatchObject({ outcome: "failed", children: [{ state: "failed" }] });
    expect(release).toHaveBeenCalled();
    const metadataHarness = makeCli({ metadataError: new Error("metadata failed") });
    const warned = await execute(toolFor({ catalog, cli: metadataHarness.cli }), task());
    expect(warned.details).toMatchObject({ outcome: "launched" });
    const failingWorktrees = worktrees();
    failingWorktrees.prepare.mockImplementation(async () => { throw new Error("prepare failed"); });
    const worktreeFailure = await toolFor({ catalog, cli: makeCli().cli, worktrees: failingWorktrees.manager }).execute("call", task({ replicas: 2 }), new AbortController().signal, undefined, extensionContext);
    expect(failingWorktrees.prepare).toHaveBeenCalledTimes(2);
    expect(worktreeFailure.details).toMatchObject({ outcome: "failed", children: [{ state: "failed", error: { code: "SPEC_NO_USABLE_CANDIDATE" } }, { state: "failed", error: { code: "SPEC_NO_USABLE_CANDIDATE" } }] });
    const retryWorktrees = worktrees();
    retryWorktrees.prepare.mockImplementationOnce(async () => { throw new Error("first worktree failed"); });
    const retryHarness = makeCli();
    const retryResult = await toolFor({ catalog: catalogOf([{ runner: "pi", model: "primary" }, { runner: "pi", model: "fallback" }]), cli: retryHarness.cli, worktrees: retryWorktrees.manager }).execute("call", task({ replicas: 2 }), new AbortController().signal, undefined, extensionContext);
    expect(retryResult.details).toMatchObject({ outcome: "launched", children: [{ state: "launched", operatingPointId: "pi:fallback:low" }, { state: "launched", operatingPointId: "pi:primary:low" }] });
  });

  it("covers runner capability and empty skill-selection branches", async () => {
    const profile = (kind: string, runtime: Record<string, unknown>) => ({ name: kind, description: kind, timeoutMinutes: 1, sessionPersistence: false, runtime: { kind, model: kind, ...runtime }, source: { kind: "bundled", path: `/tmp/${kind}.md`, scopeRoot: "/tmp" } });
    expect(attachmentCapability(profile("pi", { tools: [] }) as never)).toMatchObject({ kind: "pi", capable: true });
    expect(attachmentCapability(profile("claude", { allowedTools: [], disallowedTools: [] }) as never)).toMatchObject({ kind: "claude", capable: true });
    expect(attachmentCapability(profile("agy", { addDirs: [] }) as never)).toMatchObject({ kind: "agy", capable: true });
    expect(attachmentCapability(profile("devin", { permissionMode: "dangerous" }) as never)).toMatchObject({ kind: "devin", capable: true });
    expect(handoffWriteCapability(profile("pi", { tools: [] }) as never)).toMatchObject({ kind: "pi", capable: true });
    expect(handoffWriteCapability(profile("claude", { allowedTools: [], disallowedTools: [] }) as never)).toMatchObject({ kind: "claude", capable: true });
    expect(handoffWriteCapability(profile("agy", { addDirs: [] }) as never)).toMatchObject({ kind: "agy", capable: true });
    expect(handoffWriteCapability(profile("devin", { permissionMode: "dangerous" }) as never)).toMatchObject({ kind: "devin", capable: true });
    const devin = profile("devin", { permissionMode: "dangerous" });
    await expect(validateProfileResourceSelection(devin as never, devin.runtime as never)).resolves.toBeUndefined();
    await expect(refreshBundledProfileResourceSelection(devin as never, devin.runtime as never)).resolves.toBeUndefined();
    const bundled = { name: "bundled", source: { kind: "bundled", path: "/tmp/bundled.md", scopeRoot: "/tmp" } };
    await expect(refreshBundledProfileResourceSelection(bundled as never, undefined as never)).rejects.toThrow();
    const profileFor = (root: string, name: string, skills: string) => parseProfile(`---\nname: ${name}\ndescription: ${name}\ntimeoutMinutes: 30\nsessionPersistence: false\nruntime:\n  kind: pi\n  model: test/model\n  thinking: low\n  tools: [read]\n  skills: [${skills}]\nfallbackProfiles: []\n---\n\nBody.\n`, profileSource("bundled", join(root, `${name}.md`), root));
    const unsafeRoot = mkdtempSync(join(tmpdir(), "herdr-b8-unsafe-"));
    const outside = mkdtempSync(join(tmpdir(), "herdr-b8-outside-"));
    writeFileSync(join(unsafeRoot, SKILL_BUNDLE_REGISTRY_FILE), JSON.stringify({ bundles: {} }));
    symlinkSync(outside, join(unsafeRoot, "escaping"), "dir");
    const unsafeProfile = profileFor(unsafeRoot, "unsafe", "./escaping");
    await expect(refreshBundledProfileResourceSelection(unsafeProfile as never, unsafeProfile.runtime as never)).rejects.toMatchObject({ code: "PROFILE_SKILL_PATH_ESCAPES_SCOPE" });
    const missingRoot = mkdtempSync(join(tmpdir(), "herdr-b8-missing-") );
    const canonical = join(missingRoot, "canonical", "worker");
    mkdirSync(canonical, { recursive: true });
    writeFileSync(join(canonical, "SKILL.md"), "worker skill\n");
    const pin = await skillTreeDigest(canonical);
    writeFileSync(join(missingRoot, SKILL_BUNDLE_REGISTRY_FILE), JSON.stringify({ bundles: { "generated/worker": { source: "./canonical/worker", treeHash: pin } } }));
    const missingProfile = profileFor(missingRoot, "missing", "./generated/worker");
    await expect(refreshBundledProfileResourceSelection(missingProfile as never, missingProfile.runtime as never)).resolves.toBeUndefined();
  });

  it("covers remaining defensive identity and reconciliation projections", async () => {
    const i = launchTestInternals as unknown as UnsafeLaunchInternals;
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const piResolved = { index: 0, point: catalog.points![0]!, runner: catalog.runners.get("pi")! };
    expect(i.allReviewedResources(piResolved)).toMatchObject({ tools: ["read", "bash", "edit", "write", "ask_user_question", "executor_execute", "executor_skills", "executor_resume"], extensions: [], skills: [], mcp: [] });
    expect(i.allReviewedResources({ ...piResolved, runner: { ...piResolved.runner, kind: "claude" } })).toMatchObject({ tools: ["read", "bash", "edit", "write", "ask_user_question", "executor_execute", "executor_skills", "executor_resume"], plugins: [], mcp: [] });
    expect(i.allReviewedResources({ ...piResolved, runner: { ...piResolved.runner, kind: "agy" } })).toEqual({});
    const session = { source: "herdr:pi", agent: "pi", kind: "id", value: "s" };
    expect(i.launchDiagnosticMessage({ code: "OK", phase: "ready", created: {}, assignmentState: "unconfirmed", paneId: "p", agentStarted: true, promptSubmitted: true, recipientRegistered: false, effectCertainty: "unknown", recoveryGuidance: "Inspect" })).toContain("HERDR_LAUNCH_DIAGNOSTIC");
    expect(() => i.agentIdentity(null, "worker", "p", "pi")).toThrow();
    expect(i.agentIdentity({ agent: "pi" }, "worker", "p", "pi")).toMatchObject({ startRecord: { agent: "pi" } });
    expect(i.agentIdentity({ name: "worker", pane_id: "p", terminal_id: "t", agent_session: session, agent_status: "idle" }, "worker", "p", "pi")).toMatchObject({ startRecord: { name: "worker" } });
    expect(i.agentIdentity({ agent: { pane_id: "p", agent_status: "idle" } }, "worker", "p", "pi")).toMatchObject({ startRecord: { pane_id: "p" } });
    expect(() => i.agentIdentity({ agent: { name: "other", agent_status: "idle" } }, "worker", "p", "pi")).toThrow();
    expect(() => i.agentIdentity({ agent: { agent: "other", pane_id: "p", agent_status: "idle" } }, "worker", "p", "pi")).toThrow();
    expect(() => i.paneRefFrom(null)).toThrow();
    expect(() => i.tabRefFrom(null)).toThrow();
    expect(i.paneRefFrom({ pane: {}, rootPane: { pane_id: "p", tab_id: "t" } })).toEqual({ paneId: "p", tabId: "t" });
    expect(i.tabRefFrom({ tab: { tab_id: "t" }, rootPane: { pane_id: "p" } })).toEqual({ tabId: "t", paneId: "p" });
    expect(i.tabRefFrom({ tab: { tab_id: "t", pane: { pane_id: "p" } } })).toEqual({ tabId: "t", paneId: "p" });
    expect(i.compactAttemptState({ pane_id: {}, status: true, state_change_seq: null, agent_session: { source: "", agent: "", kind: "", value: "" } })).toMatchObject({ status: true, state_change_seq: null, agent_session: { source: "", value: "" } });
    expect(i.reconciliationFailureCode({ code: "" })).toBe("READ_FAILED");
    expect(() => i.readbackAgentRecord({ agent: "bad" }, "p")).toThrow();
    const baseline = { version: "0.8.0", protocol: 22, workspaces: [{ workspace_id: "w", label: "w", focused: true }], tabs: [{ tab_id: "t", workspace_id: "w", label: "t", focused: true }], panes: [{ pane_id: "p", tab_id: "t", workspace_id: "w" }], agents: [] } as HerdrSnapshot;
    const newPane = { pane_id: "p2", tab_id: "t2", workspace_id: "w", label: "worker", agent_name: "worker", agent: "pi" };
    const noIdSnapshot = { ...baseline, tabs: [...baseline.tabs, { tab_id: "t2", workspace_id: "w", label: "worker", focused: false }], panes: [...baseline.panes, newPane], agents: [{ pane_id: "p2", name: "worker", agent: "pi" }] } as HerdrSnapshot;
    const noIdReconcile: LaunchCli = { runJson: vi.fn(async (argv) => argv[0] === "api" ? ok("snapshot", { type: "session_snapshot", snapshot: noIdSnapshot }) : argv[0] === "pane" ? ok("pane", { pane: newPane }) : ok("agent", { agent: { pane_id: "p2", name: "worker", agent: "pi", agent_id: "a" } })), prompt: vi.fn() };
    await expect(i.reconcileLaunch({ cli: noIdReconcile, baseline, agentStarted: true, promptSubmitted: false, agentName: "worker" })).resolves.toMatchObject({ paneId: "p2", tabId: "t2" });
    const fallbackSnapshot = { ...noIdSnapshot, tabs: noIdSnapshot.tabs.map((tab) => tab.tab_id === "t2" ? { ...tab, label: "other" } : tab), panes: noIdSnapshot.panes.map((pane) => pane.pane_id === "p2" ? { ...pane, label: "other" } : pane) } as HerdrSnapshot;
    const fallbackReconcile: LaunchCli = { runJson: vi.fn(async (argv) => argv[0] === "api" ? ok("snapshot", { type: "session_snapshot", snapshot: fallbackSnapshot }) : argv[0] === "pane" ? ok("pane", { pane: newPane }) : ok("agent", { agent: { pane_id: "p2", name: "worker", agent: "pi" } })), prompt: vi.fn() };
    await expect(i.reconcileLaunch({ cli: fallbackReconcile, baseline, agentStarted: true, promptSubmitted: false, agentName: "worker" })).resolves.toMatchObject({ paneId: "p2", tabId: "t2" });
    const emptyReconcile: LaunchCli = { runJson: vi.fn(async () => ok("snapshot", { type: "session_snapshot", snapshot: baseline })), prompt: vi.fn() };
    await expect(i.reconcileLaunch({ cli: emptyReconcile, baseline, agentStarted: false, promptSubmitted: false, agentName: "worker" })).resolves.toMatchObject({ effectCertainty: "unknown", snapshot: "present", pane: "unknown" });
    const reconInput = { baseline, paneId: "p", tabId: "t", agentStarted: false, promptSubmitted: false, agentName: "worker" };
    expect(i.launchEffectCertainty(reconInput, { ...baseline, panes: [], tabs: [] }, undefined, undefined, [], "p", "t")).toBe("absent");
    expect(i.launchEffectCertainty({ ...reconInput, paneId: undefined, tabId: undefined }, undefined, undefined, undefined, [], undefined, undefined)).toBe("unknown");
    const invalidEnvelope = new CliProtocolError("CLI_PROTOCOL_ERROR", "x", { exitCode: 1, killed: false, errorStream: "stderr", stderrTruncated: false, errorEnvelope: { id: 1, error: { code: "c", message: "m" } } });
    expect(i.cliErrorEnvelope(invalidEnvelope)).toBeUndefined();
    expect(i.cliErrorEnvelope(new CliProtocolError("CLI_PROTOCOL_ERROR", "x", { exitCode: 1, killed: false, errorStream: "stderr", stderrTruncated: false, errorEnvelope: { id: "id", error: { code: 1, message: "m" } } }))).toBeUndefined();
    expect(i.startFailureEvidence(new CliProtocolError("OTHER" as never, "x", { exitCode: 1, killed: false, errorStream: "stderr", stderrTruncated: false }))).toBeUndefined();
    expect(i.startFailureEvidence(new CliProtocolError("CLI_PROTOCOL_ERROR", "x", { exitCode: 1, killed: false, errorStream: "stderr", stderrTruncated: false, errorEnvelope: { id: "other", error: { code: "agent_start_failed", message: "agent process exited before becoming interactive" } } }))).toBeUndefined();
    expect(i.startFailureEvidence(new CliProtocolError("CLI_PROTOCOL_ERROR", "x", { exitCode: 1, killed: false, errorStream: "stderr", stderrTruncated: false, errorEnvelope: { id: "cli:agent:start", error: { code: "other", message: "agent process exited before becoming interactive" } } }))).toBeUndefined();
    const boundedAbort = new AbortController();
    const pendingAbort = i.boundedReconciliationRead((signal: AbortSignal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })), boundedAbort.signal, Date.now() + 1_000);
    boundedAbort.abort("caller");
    await expect(pendingAbort).rejects.toBe("caller");
    await expect(i.boundedReconciliationRead(() => new Promise(() => undefined), new AbortController().signal, Date.now() + 1)).rejects.toMatchObject({ name: "LaunchReconciliationTimeout" });
    let now = 0;
    const window = i.createReadWindow(new AbortController().signal, 100, { now: () => now });
    now = 101;
    expect(window.cancellation().reason).toBe("deadline");
    window.cleanup();
    const timedWindow = i.createReadWindow(new AbortController().signal, Date.now() + 50, { now: () => Date.now() });
    const timedPoll = i.waitForReadPoll(timedWindow, 100);
    await expect(timedPoll).rejects.toMatchObject({ reason: "deadline" });
    timedWindow.cleanup();
    const syntheticSignal = { reason: undefined, addEventListener: (_name: string, listener: () => void) => queueMicrotask(listener), removeEventListener: vi.fn() } as unknown as AbortSignal;
    await expect(i.waitForAgentStartSettle(syntheticSignal, 0)).rejects.toMatchObject({ message: "caller aborted" });
  });

  it("covers readiness, confirmation, and diagnostic projections", async () => {
    const i = launchTestInternals as unknown as UnsafeLaunchInternals;
    const session = { source: "herdr:pi", agent: "pi", kind: "id", value: "s" };
    const identityRecord = { pane_id: "p", terminal_id: "t", name: "worker", agent: "pi", agent_session: session, agent_status: "idle", state_change_seq: 1, revision: 2, interactive_ready: true };
    expect(i.readinessScalar("x")).toBe("x");
    expect(i.readinessScalar(1)).toBe(1);
    expect(i.readinessScalar(true)).toBe(true);
    expect(i.readinessScalar(null)).toBe(null);
    expect(i.readinessScalar({})).toBe("[malformed]");
    expect(i.readinessSessionField("x")).toBe("x");
    expect(i.readinessSessionField(undefined)).toBe("[missing]");
    expect(i.readinessSessionField({})).toBe("[malformed]");
    expect(i.ownReadinessSessionField(identityRecord, "source")).toBe("[missing]");
    expect(i.compactIdentityRecord(identityRecord, "agent_get")).toMatchObject({ source: "agent_get", pane_id: "p", agent_session: { source: "herdr:pi", value: "s" } });
    expect(i.compactIdentityRecord({ agent_session: "bad" }, "pane_get")).toMatchObject({ agent_session: "bad" });
    expect(i.compactReadinessRecords(Array.from({ length: 5 }, (_, index) => ({ source: "pane_get", value: { pane_id: String(index) } })))).toHaveLength(4);
    expect(i.own(identityRecord, "pane_id")).toBe(true);
    expect(i.sameSession(session, { ...session })).toBe(true);
    expect(i.sameSession(session, { ...session, value: "other" })).toBe(false);
    expect(i.mergeReadinessIdentity([identityRecord], "p")).toMatchObject({ paneId: "p", terminalId: "t", agentName: "worker", agentKind: "pi", agentSession: session });
    expect(() => i.mergeReadinessIdentity([identityRecord, { ...identityRecord, name: "other" }], "p")).toThrow();
    expect(() => i.mergeReadinessIdentity([{ ...identityRecord, agent_session: { ...session, agent: "claude" } }], "p")).toThrow();
    expect(i.completeReadinessIdentity({ paneId: "p", terminalId: "t", agentName: "worker", agentKind: "pi", agentSession: session }, "p", "worker", "pi")).toMatchObject({ paneId: "p" });
    expect(i.completeReadinessIdentity({ paneId: "p" }, "p", "worker", "pi")).toBeUndefined();
    expect(() => i.completeReadinessIdentity({ agentName: "other" }, "p", "worker", "pi")).toThrow();
    expect(i.completeProvisionalReadinessIdentity({ paneId: "p", terminalId: "t", agentName: "worker", agentKind: "agy" }, "p", "worker")).toMatchObject({ agentKind: "agy" });
    expect(i.completeProvisionalReadinessIdentity({ paneId: "p" }, "p", "worker")).toBeUndefined();
    expect(i.agyInteractiveReadiness([{ source: "agent_get", value: {} }])).toEqual(["agent_get_interactive_ready_missing"]);
    expect(i.agyInteractiveReadiness([{ source: "pane_get", value: { interactive_ready: false } }])).toEqual(["pane_get_not_interactive"]);
    expect(i.agyInteractiveReadiness([{ source: "pane_get", value: { interactive_ready: true } }])).toEqual([]);
    expect(() => i.agyInteractiveReadiness([{ source: "pane_get", value: { interactive_ready: "yes" } }])).toThrow();
    expect(i.requiredReadinessPaneId({}, "p", "agent_get")).toBe("agent_get_pane_id_missing");
    expect(i.requiredReadinessPaneId({ pane_id: "p" }, "p", "agent_get")).toBeUndefined();
    expect(() => i.requiredReadinessPaneId({ pane_id: "x" }, "p", "agent_get")).toThrow();
    expect(() => i.requiredReadinessPaneId({ pane_id: 1 }, "p", "agent_get")).toThrow();
    const snapshot = { version: "0.8.0", protocol: 22, workspaces: [{ workspace_id: "w", label: "w", focused: true }], tabs: [{ tab_id: "t", workspace_id: "w", label: "t", focused: true }], panes: [{ tab_id: "t", ...identityRecord }], agents: [{ ...identityRecord }] } as unknown as HerdrSnapshot;
    expect(i.snapshotReadinessRecords(snapshot, "p").duplicates).toBeUndefined();
    expect(i.snapshotReadinessRecords({ ...snapshot, panes: [...snapshot.panes, snapshot.panes[0]], agents: [...snapshot.agents, snapshot.agents[0]] }, "p").duplicates).toEqual({ paneRecords: 2, agentRecords: 2 });
    expect(i.snapshotReadinessRecords({ ...snapshot, panes: [], agents: [] }, "p").pending).toEqual(["snapshot_pane_missing", "snapshot_agent_missing"]);
    expect(i.readinessAgentRecord({ agent: identityRecord }).record.value).toEqual(identityRecord);
    expect(i.readinessAgentRecord({}).pending).toBe("agent_get_record_missing");
    expect(() => i.readinessAgentRecord(null)).toThrow();
    expect(() => i.readinessAgentRecord({ agent: "bad" })).toThrow();
    expect(i.readinessPaneRecord({ pane: identityRecord }).record.value).toEqual(identityRecord);
    expect(i.readinessPaneRecord({}).pending).toBe("pane_get_record_missing");
    expect(() => i.readinessPaneRecord(null)).toThrow();
    expect(() => i.readinessPaneRecord({ pane: "bad" })).toThrow();
    expect(i.readinessLifecycle({ agent_status: "idle", state_change_seq: 1, revision: 2, screen_detection_skipped: true }, "agent_get")).toMatchObject({ agentStatus: "idle", stateChangeSeq: 1, revision: 2, screenDetectionSkipped: true });
    expect(i.readinessLifecycle({}, "agent_get")).toEqual({});
    expect(() => i.readinessLifecycle({ agent_status: "bad" }, "agent_get")).toThrow();
    expect(() => i.readinessLifecycle({ state_change_seq: -1 }, "agent_get")).toThrow();
    expect(() => i.readinessLifecycle({ screen_detection_skipped: "bad" }, "agent_get")).toThrow();
    expect(i.readinessLifecycleSkew([{ source: "pane_get", lifecycle: { agentStatus: "working", stateChangeSeq: 2 } }], { state: "idle", stateChangeSeq: 1, revision: 1 })).toHaveLength(2);
    expect(i.readinessLifecycleSkew([], { state: "idle", stateChangeSeq: 1, revision: 1, screenDetectionSkipped: false })).toEqual([]);
    const normalIdentity = { paneId: "p", terminalId: "t", agentName: "worker", agentKind: "pi", agentSession: session };
    expect(i.readinessBaseline(identityRecord, normalIdentity, { agentStatus: "idle", stateChangeSeq: 1, revision: 2 }).baseline).toMatchObject({ state: "idle", stateChangeSeq: 1, revision: 2 });
    expect(i.readinessBaseline({}, normalIdentity, { agentStatus: "working" }).pending.length).toBeGreaterThan(0);
    const agyRecord = { ...identityRecord, agent: "agy" };
    delete (agyRecord as Record<string, unknown>).agent_session;
    expect(i.readinessBaseline(agyRecord, { paneId: "p", terminalId: "t", agentName: "worker", agentKind: "agy" }, { agentStatus: "idle", stateChangeSeq: 1, revision: 2 }).baseline).toBeDefined();
    const clock = { now: () => 12.2 };
    expect(i.monotonicDurationMs(clock, 10)).toBe(3);
    expect(i.monotonicDurationMs({ now: () => 10 }, 10)).toBe(0);
    expect(i.readinessEvidence(clock, 10, 1, [], true)).toMatchObject({ samples: 1, baselineRequired: true });
    expect(i.compactReadinessErrorValue("x")).toBe("x");
    expect(i.compactReadinessErrorValue(identityRecord)).toMatchObject({ source: "[missing]" });
    expect(i.compactReadinessErrorMetadata({ field: "pane_id", actual: identityRecord })).toMatchObject({ field: "pane_id", actual: { source: "[missing]" } });
    expect(i.readinessFailure("READY_TIMEOUT", "timeout", i.readinessEvidence(clock, 10, 1, [], true), { field: "pane_id", cliFailure: { code: "X" } })).toMatchObject({ code: "READY_TIMEOUT" });
    expect(i.compactConfirmationObservation(undefined)).toBeUndefined();
    const observation = { status: "working", state: "working", stateChangeSeq: 2, revision: 3, screenDetectionSkipped: true, code: "OK" };
    expect(i.compactConfirmationObservation(observation)).toMatchObject({ status: "working", stateChangeSeq: 2 });
    const baseline = { state: "idle", stateChangeSeq: 1, revision: 2 };
    expect(i.promptConfirmationEvidence(clock, 10, 1, "working", baseline, observation)).toMatchObject({ reason: "working", baseline });
    const submission = { confirmed: true, paneId: "p", terminalId: "t", agentName: "worker", agentKind: "pi", agentSession: session, revision: 2 };
    expect(i.promptUnconfirmed(submission, i.promptConfirmationEvidence(clock, 10, 1, "timeout", baseline))).toMatchObject({ code: "PROMPT_UNCONFIRMED" });
    const agyAck = { operationId: "op", identity: { paneId: "p", terminalId: "t", agentName: "worker", agentKind: "agy" }, revision: 2, agentSession: undefined };
    expect(i.agyPromptSubmissionEvidence(agyAck)).toMatchObject({ confirmed: true, operationId: "op", interactiveReady: true });
    expect(i.agyPromptSubmissionEvidence({ ...agyAck, stateChangeSeq: 1, screenDetectionSkipped: true })).toMatchObject({ stateChangeSeq: 1, screenDetectionSkipped: true });
    const agyAgent = { pane_id: "p", terminal_id: "t", name: "worker", agent: "agy", interactive_ready: true, revision: 2, state_change_seq: 1, screen_detection_skipped: true, agent_status: "idle" };
    expect(i.parseAgyPromptAcknowledgement({ id: "op", result: { type: "agent_prompted", agent: agyAgent } }, agyAck.identity)).toMatchObject({ stateChangeSeq: 1, screenDetectionSkipped: true });
    expect(i.parseAgyPromptAcknowledgement({ id: "op", result: { type: "agent_prompted", agent: agyAgent } }, agyAck.identity)).toMatchObject({ operationId: "op", revision: 2 });
    expect(() => i.parseAgyPromptAcknowledgement({ id: "", result: {} }, agyAck.identity)).toThrow();
    expect(i.agyPromptUnconfirmed(agyAck, clock, 10, 1, "timeout", baseline)).toMatchObject({ code: "PROMPT_UNCONFIRMED" });
  });

  it("covers readiness sampling, retry, timeout, and abort branches", async () => {
    const i = launchTestInternals as unknown as UnsafeLaunchInternals;
    const session = { source: "herdr:pi", agent: "pi", kind: "id", value: "ready" };
    const pane = { pane_id: "p", tab_id: "t", workspace_id: "w", agent_name: "worker", agent: "pi", terminal_id: "t0", agent_session: session, agent_status: "idle", state_change_seq: 1, revision: 2, interactive_ready: true };
    const agent = { pane_id: "p", name: "worker", agent: "pi", terminal_id: "t0", agent_session: session, agent_status: "idle", state_change_seq: 1, revision: 2, interactive_ready: true };
    const snapshot = { version: "0.8.0", protocol: 22, workspaces: [{ workspace_id: "w", label: "w", focused: true }], tabs: [{ tab_id: "t", workspace_id: "w", label: "t", focused: true }], panes: [pane], agents: [agent] } as HerdrSnapshot;
    const cli: LaunchCli = { runJson: vi.fn(async (argv) => argv[0] === "api" ? ok("api", { type: "session_snapshot", snapshot }) : argv[0] === "agent" ? ok("agent", { agent }) : ok("pane", { pane })), prompt: vi.fn() };
    const ready = await i.waitForLaunchReadiness(cli, "p", new AbortController().signal, "worker", "pi", { startRecord: { ...agent } }, 0, true, { now: () => 0 });
    expect(ready.identity).toMatchObject({ agentName: "worker", agentKind: "pi" });
    expect(ready.baseline).toMatchObject({ state: "idle", stateChangeSeq: 1, revision: 2 });
    const withoutBaseline = await i.waitForLaunchReadiness(cli, "p", new AbortController().signal, "worker", "pi", { startRecord: { ...agent } }, 0, false, { now: () => 0 });
    expect(withoutBaseline.baseline).toBeUndefined();
    let sample = 0;
    const resamplingCli: LaunchCli = { runJson: vi.fn(async (argv) => {
      if (argv[0] === "api") return ok("api", { type: "session_snapshot", snapshot: sample++ === 0 ? { ...snapshot, agents: [] } : snapshot });
      return argv[0] === "agent" ? ok("agent", { agent }) : ok("pane", { pane });
    }), prompt: vi.fn() };
    const resampling = await i.waitForLaunchReadiness(resamplingCli, "p", new AbortController().signal, "worker", "pi", { startRecord: { ...agent } }, 0, true, { now: () => 0 });
    expect(resampling.evidence.samples).toBeGreaterThan(1);
    const malformedCli: LaunchCli = { runJson: vi.fn(async (argv) => { if (argv[0] === "api") return ok("api", { type: "session_snapshot", snapshot }); throw Object.assign(new Error("bad read"), { code: "READ_BAD" }); }), prompt: vi.fn() };
    await expect(i.waitForLaunchReadiness(malformedCli, "p", new AbortController().signal, "worker", "pi", { startRecord: { ...agent } }, 0, true, { now: () => 0 })).rejects.toMatchObject({ code: "READ_BAD", details: { readiness: expect.any(Object) } });
    const readyTimeoutCli: LaunchCli = { runJson: vi.fn(async () => { throw Object.assign(new Error("deadline"), { code: "READY_TIMEOUT" }); }), prompt: vi.fn() };
    await expect(i.waitForLaunchReadiness(readyTimeoutCli, "p", new AbortController().signal, "worker", "pi", { startRecord: { ...agent } }, 0, true, { now: () => 0 })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    const missingBaselineAgent = { ...agent, state_change_seq: undefined, revision: undefined };
    let missingBaselineTick = 0;
    const missingBaselineCli: LaunchCli = { runJson: vi.fn(async (argv) => argv[0] === "api" ? ok("api", { type: "session_snapshot", snapshot }) : argv[0] === "agent" ? ok("agent", { agent: missingBaselineAgent }) : ok("pane", { pane })), prompt: vi.fn() };
    await expect(i.waitForLaunchReadiness(missingBaselineCli, "p", new AbortController().signal, "worker", "pi", { startRecord: { ...agent } }, 0, true, { now: () => missingBaselineTick++ < 20 ? 0 : 200_000 })).rejects.toMatchObject({ code: "READY_TIMEOUT" });
    const aborted = new AbortController();
    aborted.abort();
    await expect(i.waitForLaunchReadiness(cli, "p", aborted.signal, "worker", "pi", { startRecord: { ...agent } }, 0, true, { now: () => 0 })).rejects.toMatchObject({ code: "ABORTED" });
    await expect(i.waitForLaunchReadiness(cli, "p", new AbortController().signal, "worker", "pi", { startRecord: { ...agent } }, 0, true, { now: () => 120_000 })).rejects.toMatchObject({ code: "READY_TIMEOUT" });
  });

  it("covers readiness identity contradictions and missing-record branches", async () => {
    const i = launchTestInternals as unknown as UnsafeLaunchInternals;
    const session = { source: "herdr:pi", agent: "pi", kind: "id", value: "ready" };
    expect(() => i.mergeReadinessIdentity([{ pane_id: "p", agent_session: session }, { pane_id: "p", agent_session: { ...session, value: "other" } }], "p")).toThrow();
    expect(() => i.mergeReadinessIdentity([{ pane_id: "p", agent: "pi", agent_session: { ...session, agent: "claude" } }], "p")).toThrow();
    expect(() => i.mergeReadinessIdentity([{ pane_id: "p", agent_kind: "pi", agent_session: { ...session, agent: "claude" } }], "p")).toThrow();
    expect(() => i.mergeReadinessIdentity([{ pane_id: "p", agent: "pi" }, { pane_id: "p", agent_session: { ...session, agent: "claude" } }], "p")).toThrow();
    expect(() => i.completeReadinessIdentity({ agentName: "worker", agentKind: "claude" }, "p", "worker", "pi")).toThrow();
    expect(i.readinessBaseline({}, { paneId: "p", terminalId: "t", agentName: "worker", agentKind: "pi", agentSession: session }, {}).pending).toContain("agent_get_status_missing");
    expect(i.readinessEvidence({ now: () => 4 }, 0, 1, [], true, "pending")).toMatchObject({ lastPendingReason: "pending" });
    expect(() => parsePromptTargetIdentityFields({ pane_id: "other" }, "p")).toThrow();

    const base = { version: "0.8.0", protocol: 22, workspaces: [{ workspace_id: "w", label: "w", focused: true }], tabs: [{ tab_id: "t", workspace_id: "w", label: "t", focused: true }], panes: [{ pane_id: "p", tab_id: "t", workspace_id: "w", name: "worker", agent: "pi" }], agents: [{ pane_id: "p", name: "worker", agent: "pi" }] } as HerdrSnapshot;
    let ticks = 0;
    const missingRecords: LaunchCli = { runJson: vi.fn(async (argv) => {
      if (argv[0] === "api") return ok("api", { type: "session_snapshot", snapshot: base });
      if (argv[0] === "agent") return ok("agent", {});
      return ok("pane", {});
    }), prompt: vi.fn() };
    await expect(i.waitForLaunchReadiness(missingRecords, "p", new AbortController().signal, "worker", "pi", { startRecord: { pane_id: "p" } }, 0, true, { now: () => ticks++ > 30 ? 200_000 : 0 })).rejects.toMatchObject({ code: "READY_TIMEOUT" });

    let malformedTicks = 0;
    const malformedRecords: LaunchCli = { runJson: vi.fn(async (argv) => {
      if (argv[0] === "api") return ok("api", { type: "session_snapshot", snapshot: { ...base, panes: [], agents: [] } });
      if (argv[0] === "agent") return ok("agent", { agent: {} });
      return ok("pane", { pane: {} });
    }), prompt: vi.fn() };
    await expect(i.waitForLaunchReadiness(malformedRecords, "p", new AbortController().signal, "worker", "pi", { startRecord: { pane_id: "p" } }, 0, true, { now: () => malformedTicks++ > 30 ? 200_000 : 0 })).rejects.toMatchObject({ code: "READY_TIMEOUT" });

    let agyTicks = 0;
    const agy = { pane_id: "p", name: "worker", agent: "agy", terminal_id: "t0", agent_status: "idle", state_change_seq: 1, revision: 2, interactive_ready: false };
    const agySnapshot = { ...base, panes: [{ ...base.panes[0], ...agy }], agents: [agy] } as HerdrSnapshot;
    const agyNotInteractive: LaunchCli = { runJson: vi.fn(async (argv) => argv[0] === "api" ? ok("api", { type: "session_snapshot", snapshot: agySnapshot }) : argv[0] === "agent" ? ok("agent", { agent: agy }) : ok("pane", { pane: { ...agy, tab_id: "t" } })), prompt: vi.fn() };
    await expect(i.waitForLaunchReadiness(agyNotInteractive, "p", new AbortController().signal, "worker", "agy", { startRecord: { pane_id: "p" } }, 0, true, { now: () => agyTicks++ > 30 ? 200_000 : 0 }, true)).rejects.toMatchObject({ code: "READY_TIMEOUT" });

    const duplicateSnapshot = { ...base, panes: [...base.panes, base.panes[0]], agents: [...base.agents, base.agents[0]] };
    const duplicate: LaunchCli = { runJson: vi.fn(async (argv) => argv[0] === "api" ? ok("api", { type: "session_snapshot", snapshot: duplicateSnapshot }) : argv[0] === "agent" ? ok("agent", { agent: base.agents[0] }) : ok("pane", { pane: base.panes[0] })), prompt: vi.fn() };
    await expect(i.waitForLaunchReadiness(duplicate, "p", new AbortController().signal, "worker", "pi", { startRecord: { ...base.agents[0] } }, 0, true, { now: () => 0 })).rejects.toMatchObject({ code: "TARGET_IDENTITY_UNAVAILABLE" });

    const nonError: LaunchCli = { runJson: vi.fn(async (argv) => { if (argv[0] === "api") return ok("api", { type: "session_snapshot", snapshot: base }); throw 1; }), prompt: vi.fn() };
    await expect(i.waitForLaunchReadiness(nonError, "p", new AbortController().signal, "worker", "pi", { startRecord: { ...base.agents[0] } }, 0, true, { now: () => 0 })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
  });

  it("covers prompt confirmation success, identity failure, timeout, and abort", async () => {
    const i = launchTestInternals as unknown as UnsafeLaunchInternals;
    const session = { source: "herdr:pi", agent: "pi", kind: "id", value: "prompt" };
    const submission = { confirmed: true, paneId: "p", terminalId: "t0", agentName: "worker", agentKind: "pi", agentSession: session, revision: 2, stateChangeSeq: 1 };
    const baseline = { state: "idle", stateChangeSeq: 1, revision: 2 };
    const agent = { pane_id: "p", name: "worker", agent: "pi", terminal_id: "t0", agent_session: session, agent_status: "working", state_change_seq: 2, revision: 3 };
    const pane = { pane_id: "p", tab_id: "t", workspace_id: "w", agent_name: "worker", agent: "pi", terminal_id: "t0", agent_session: session, agent_status: "working", state_change_seq: 2, revision: 3 };
    const cli: LaunchCli = { runJson: vi.fn(async (argv) => argv[0] === "agent" ? ok("agent", { agent }) : ok("pane", { pane })), prompt: vi.fn() };
    const confirmed = await i.confirmPromptConsumption(cli, "p", new AbortController().signal, submission, baseline, { now: () => 10 }, 0);
    expect(confirmed.observation).toMatchObject({ consumption: "confirmed", status: "working" });
    const failedCli: LaunchCli = { runJson: vi.fn(async (argv) => { if (argv[0] === "agent") return ok("agent", { agent }); throw Object.assign(new Error("pane read"), { code: "PANE_READ" }); }), prompt: vi.fn() };
    await expect(i.confirmPromptConsumption(failedCli, "p", new AbortController().signal, submission, baseline, { now: () => 10 }, 0)).rejects.toMatchObject({ code: "PROMPT_UNCONFIRMED", details: { promptConfirmation: { reason: "read_failed" } } });
    const replaced = { ...agent, name: "other" };
    const replacedCli: LaunchCli = { runJson: vi.fn(async (argv) => argv[0] === "agent" ? ok("agent", { agent: replaced }) : ok("pane", { pane })), prompt: vi.fn() };
    await expect(i.confirmPromptConsumption(replacedCli, "p", new AbortController().signal, submission, baseline, { now: () => 10 }, 0)).rejects.toMatchObject({ code: "PROMPT_UNCONFIRMED" });
    const aborted = new AbortController();
    aborted.abort();
    await expect(i.confirmPromptConsumption(cli, "p", aborted.signal, submission, baseline, { now: () => 10 }, 0)).rejects.toMatchObject({ code: "PROMPT_UNCONFIRMED", details: { promptConfirmation: { reason: "caller_aborted" } } });
    await expect(i.confirmPromptConsumption(cli, "p", new AbortController().signal, submission, baseline, { now: () => 5_000 }, 0)).rejects.toMatchObject({ code: "PROMPT_UNCONFIRMED", details: { promptConfirmation: { reason: "timeout" } } });
  });

  it("covers confirmation polling and AGY acknowledgement fail-closed branches", async () => {
    const i = launchTestInternals as unknown as UnsafeLaunchInternals;
    const session = { source: "herdr:pi", agent: "pi", kind: "id", value: "prompt" };
    const submission = { confirmed: true, paneId: "p", terminalId: "t0", agentName: "worker", agentKind: "pi", agentSession: session, revision: 2, stateChangeSeq: 1 };
    const baseline = { state: "idle", stateChangeSeq: 1, revision: 2 };
    const idleAgent = { pane_id: "p", name: "worker", agent: "pi", terminal_id: "t0", agent_session: session, agent_status: "idle", state_change_seq: 1, revision: 2 };
    const idlePane = { pane_id: "p", tab_id: "t", workspace_id: "w", agent_name: "worker", agent: "pi", terminal_id: "t0", agent_session: session, agent_status: "idle", state_change_seq: 1, revision: 2 };
    let ticks = 0;
    const pending: LaunchCli = { runJson: vi.fn(async (argv) => argv[0] === "agent" ? ok("agent", { agent: idleAgent }) : ok("pane", { pane: idlePane })), prompt: vi.fn() };
    await expect(i.confirmPromptConsumption(pending, "p", new AbortController().signal, submission, baseline, { now: () => ticks++ > 20 ? 6_000 : 0 }, 0)).rejects.toMatchObject({ code: "PROMPT_UNCONFIRMED" });
    const midAbort = new AbortController();
    const cancelCli: LaunchCli = { runJson: vi.fn(async (argv) => {
      if (argv[0] === "agent") midAbort.abort("caller");
      return argv[0] === "agent" ? ok("agent", { agent: idleAgent }) : ok("pane", { pane: idlePane });
    }), prompt: vi.fn() };
    await expect(i.confirmPromptConsumption(cancelCli, "p", midAbort.signal, submission, baseline, { now: () => 0 }, 0)).rejects.toMatchObject({ code: "PROMPT_UNCONFIRMED" });

    const expected = { paneId: "p", terminalId: "t0", agentName: "worker", agentKind: "agy" };
    const ack = (agent: Record<string, unknown>) => ({ id: "op", result: { type: "agent_prompted", agent } }) as JsonEnvelope;
    const valid = { pane_id: "p", terminal_id: "t0", name: "worker", agent: "agy", agent_session: { source: "herdr:agy", agent: "agy", kind: "id", value: "s" }, interactive_ready: true, revision: 2, state_change_seq: 1, agent_status: "idle" };
    expect(() => i.parseAgyPromptAcknowledgement(ack({ ...valid, agent_session: "bad" }), expected)).toThrow();
    expect(() => i.parseAgyPromptAcknowledgement(ack({ ...valid, terminal_id: "other" }), expected)).toThrow();
    expect(() => i.parseAgyPromptAcknowledgement(ack({ ...valid, interactive_ready: false }), expected)).toThrow();
    expect(() => i.parseAgyPromptAcknowledgement(ack({ ...valid, revision: undefined }), expected)).toThrow();
    expect(i.parseAgyPromptAcknowledgement(ack({ ...valid, state_change_seq: undefined }), expected)).toMatchObject({ revision: 2 });

    const agySession = { source: "herdr:agy", agent: "agy", kind: "id", value: "s" };
    const agyAck = { operationId: "op", identity: expected, agentSession: agySession, revision: 2 };
    const agyPane = { pane_id: "p", tab_id: "t", workspace_id: "w", agent_name: "worker", agent: "agy", terminal_id: "t0", agent_session: agySession, agent_status: "idle", state_change_seq: 1, revision: 2 };
    const agyAgent = { pane_id: "p", name: "worker", agent: "agy", terminal_id: "t0", agent_session: agySession, agent_status: "idle", state_change_seq: 1, revision: 2, interactive_ready: true };
    const agySnapshot = { version: "0.8.0", protocol: 22, workspaces: [{ workspace_id: "w", label: "w", focused: true }], tabs: [{ tab_id: "t", workspace_id: "w", label: "t", focused: true }], panes: [agyPane], agents: [agyAgent] } as HerdrSnapshot;
    const agyCli = (snapshot: HerdrSnapshot, agent: Record<string, unknown>, pane: Record<string, unknown>): LaunchCli => ({ runJson: vi.fn(async (argv) => argv[0] === "api" ? ok("api", { type: "session_snapshot", snapshot }) : argv[0] === "agent" ? ok("agent", { agent }) : ok("pane", { pane })), prompt: vi.fn() });
    const midAgyAbort = new AbortController();
    const cancelAgy: LaunchCli = { runJson: vi.fn(async (argv) => {
      if (argv[0] === "agent") midAgyAbort.abort("caller");
      return argv[0] === "api" ? ok("api", { type: "session_snapshot", snapshot: agySnapshot }) : argv[0] === "agent" ? ok("agent", { agent: agyAgent }) : ok("pane", { pane: agyPane });
    }), prompt: vi.fn() };
    await expect(i.confirmAgyNativeSession(cancelAgy, midAgyAbort.signal, agyAck, baseline, { now: () => 0 }, 0)).rejects.toMatchObject({ code: "PROMPT_UNCONFIRMED" });
    const readFailureAgy: LaunchCli = { runJson: vi.fn(async (argv) => { if (argv[0] === "api") return ok("api", { type: "session_snapshot", snapshot: agySnapshot }); if (argv[0] === "agent") throw new Error("agent read failed"); return ok("pane", { pane: agyPane }); }), prompt: vi.fn() };
    await expect(i.confirmAgyNativeSession(readFailureAgy, new AbortController().signal, agyAck, baseline, { now: () => 0 }, 0)).rejects.toMatchObject({ code: "PROMPT_UNCONFIRMED" });
    await expect(i.confirmAgyNativeSession(agyCli(agySnapshot, { ...agyAgent, pane_id: undefined }, agyPane), new AbortController().signal, agyAck, baseline, { now: () => 0 }, 0)).rejects.toMatchObject({ code: "PROMPT_UNCONFIRMED" });
    const inconsistentAgent = { ...agyAgent, name: "other" };
    const inconsistentSnapshot = { ...agySnapshot, agents: [inconsistentAgent] } as HerdrSnapshot;
    await expect(i.confirmAgyNativeSession(agyCli(inconsistentSnapshot, inconsistentAgent, agyPane), new AbortController().signal, agyAck, baseline, { now: () => 0 }, 0)).rejects.toMatchObject({ code: "PROMPT_UNCONFIRMED" });
    const malformedLifecycle = { ...agyAgent, agent_status: "malformed" };
    const malformedLifecycleSnapshot = { ...agySnapshot, agents: [malformedLifecycle], panes: [{ ...agyPane, agent_status: "malformed" }] } as HerdrSnapshot;
    await expect(i.confirmAgyNativeSession(agyCli(malformedLifecycleSnapshot, malformedLifecycle, { ...agyPane, agent_status: "malformed" }), new AbortController().signal, agyAck, baseline, { now: () => 0 }, 0)).rejects.toMatchObject({ code: "PROMPT_UNCONFIRMED" });
    const otherTerminal = { ...agyAgent, terminal_id: "other", agent_session: agySession };
    const otherPane = { ...agyPane, terminal_id: "other", agent_session: agySession };
    const otherSnapshot = { ...agySnapshot, panes: [otherPane], agents: [otherTerminal] } as HerdrSnapshot;
    await expect(i.confirmAgyNativeSession(agyCli(otherSnapshot, otherTerminal, otherPane), new AbortController().signal, agyAck, baseline, { now: () => 0 }, 0)).rejects.toMatchObject({ code: "PROMPT_UNCONFIRMED" });
    const changedSession = { ...agySession, value: "other" };
    const changedAgent = { ...agyAgent, agent_session: changedSession };
    const changedPane = { ...agyPane, agent_session: changedSession };
    const changedSnapshot = { ...agySnapshot, panes: [changedPane], agents: [changedAgent] } as HerdrSnapshot;
    await expect(i.confirmAgyNativeSession(agyCli(changedSnapshot, changedAgent, changedPane), new AbortController().signal, agyAck, baseline, { now: () => 0 }, 0)).rejects.toMatchObject({ code: "PROMPT_UNCONFIRMED" });
    let noSessionTicks = 0;
    const noSessionAgent = { ...agyAgent };
    delete (noSessionAgent as Record<string, unknown>).agent_session;
    const noSessionPane = { ...agyPane };
    delete (noSessionPane as Record<string, unknown>).agent_session;
    const noSessionSnapshot = { ...agySnapshot, panes: [noSessionPane], agents: [noSessionAgent] } as HerdrSnapshot;
    await expect(i.confirmAgyNativeSession(agyCli(noSessionSnapshot, noSessionAgent, noSessionPane), new AbortController().signal, { ...agyAck, agentSession: undefined }, baseline, { now: () => noSessionTicks++ > 20 ? 6_000 : 0 }, 0)).rejects.toMatchObject({ code: "PROMPT_UNCONFIRMED" });
    let lifecycleTicks = 0;
    const lifecycleAgent = { ...agyAgent, screen_detection_skipped: true };
    const lifecyclePane = { ...agyPane, screen_detection_skipped: true };
    const lifecycleSnapshot = { ...agySnapshot, panes: [lifecyclePane], agents: [lifecycleAgent] } as HerdrSnapshot;
    await expect(i.confirmAgyNativeSession(agyCli(lifecycleSnapshot, lifecycleAgent, lifecyclePane), new AbortController().signal, agyAck, baseline, { now: () => lifecycleTicks++ > 20 ? 6_000 : 0 }, 0)).rejects.toMatchObject({ code: "PROMPT_UNCONFIRMED" });
  });

  it("covers AGY native-session confirmation success and fail-closed branches", async () => {
    const i = launchTestInternals as unknown as UnsafeLaunchInternals;
    const session = { source: "herdr:agy", agent: "agy", kind: "id", value: "agy-session" };
    const identity = { paneId: "p", terminalId: "t0", agentName: "worker", agentKind: "agy" };
    const acknowledgement = { operationId: "op", identity, agentSession: undefined, revision: 2 };
    const baseline = { state: "idle", stateChangeSeq: 1, revision: 2 };
    const pane = { pane_id: "p", tab_id: "t", workspace_id: "w", agent_name: "worker", agent: "agy", terminal_id: "t0", agent_session: session, agent_status: "working", state_change_seq: 2, revision: 3 };
    const agent = { pane_id: "p", name: "worker", agent: "agy", terminal_id: "t0", agent_session: session, agent_status: "working", state_change_seq: 2, revision: 3, interactive_ready: true };
    const snapshot = { version: "0.8.0", protocol: 22, workspaces: [{ workspace_id: "w", label: "w", focused: true }], tabs: [{ tab_id: "t", workspace_id: "w", label: "t", focused: true }], panes: [pane], agents: [agent] } as HerdrSnapshot;
    const cli: LaunchCli = { runJson: vi.fn(async (argv) => argv[0] === "api" ? ok("api", { type: "session_snapshot", snapshot }) : argv[0] === "agent" ? ok("agent", { agent }) : ok("pane", { pane })), prompt: vi.fn() };
    const confirmed = await i.confirmAgyNativeSession(cli, new AbortController().signal, acknowledgement, baseline, { now: () => 10 }, 0);
    expect(confirmed.identity).toMatchObject({ agentKind: "agy", agentSession: session });
    expect(confirmed.observation).toMatchObject({ consumption: "confirmed", status: "working" });
    const duplicateSnapshot = { ...snapshot, panes: [pane, pane], agents: [agent, agent] };
    const duplicateCli: LaunchCli = { runJson: vi.fn(async (argv) => argv[0] === "api" ? ok("api", { type: "session_snapshot", snapshot: duplicateSnapshot }) : argv[0] === "agent" ? ok("agent", { agent }) : ok("pane", { pane })), prompt: vi.fn() };
    await expect(i.confirmAgyNativeSession(duplicateCli, new AbortController().signal, acknowledgement, baseline, { now: () => 10 }, 0)).rejects.toMatchObject({ code: "PROMPT_UNCONFIRMED" });
    const missingCli: LaunchCli = { runJson: vi.fn(async (argv) => argv[0] === "api" ? ok("api", { type: "session_snapshot", snapshot: { ...snapshot, panes: [], agents: [] } }) : ok(argv[0], argv[0] === "agent" ? { agent } : { pane })), prompt: vi.fn() };
    await expect(i.confirmAgyNativeSession(missingCli, new AbortController().signal, acknowledgement, baseline, { now: () => 10 }, 0)).rejects.toMatchObject({ code: "PROMPT_UNCONFIRMED" });
    const changedCli: LaunchCli = { runJson: vi.fn(async (argv) => {
      if (argv[0] === "api") return ok("api", { type: "session_snapshot", snapshot });
      if (argv[0] === "agent") return ok("agent", { agent: { ...agent, name: "other" } });
      return ok("pane", { pane });
    }), prompt: vi.fn() };
    await expect(i.confirmAgyNativeSession(changedCli, new AbortController().signal, acknowledgement, baseline, { now: () => 10 }, 0)).rejects.toMatchObject({ code: "PROMPT_UNCONFIRMED" });
    const incompleteAgent = { ...agent, agent_status: undefined, state_change_seq: undefined, revision: undefined };
    const incompleteCli: LaunchCli = { runJson: vi.fn(async (argv) => argv[0] === "api" ? ok("api", { type: "session_snapshot", snapshot }) : argv[0] === "agent" ? ok("agent", { agent: incompleteAgent }) : ok("pane", { pane })), prompt: vi.fn() };
    await expect(i.confirmAgyNativeSession(incompleteCli, new AbortController().signal, acknowledgement, baseline, { now: () => 5_000 }, 0)).rejects.toMatchObject({ code: "PROMPT_UNCONFIRMED", details: { promptConfirmation: { reason: "timeout" } } });
    const aborted = new AbortController();
    aborted.abort();
    await expect(i.confirmAgyNativeSession(cli, aborted.signal, acknowledgement, baseline, { now: () => 10 }, 0)).rejects.toMatchObject({ code: "PROMPT_UNCONFIRMED", details: { promptConfirmation: { reason: "caller_aborted" } } });
  });

  it("covers bounded read windows and reconciliation branches", async () => {
    const i = launchTestInternals as unknown as UnsafeLaunchInternals;
    const clock = { now: () => 0 };
    const caller = new AbortController();
    const window = i.createReadWindow(caller.signal, 100, clock);
    const cli = { runJson: vi.fn(async () => ok("read", { value: 1 })) } as unknown as LaunchCli;
    await expect(i.readWithinWindow(cli, ["api", "snapshot"], window)).resolves.toEqual({ value: 1 });
    await i.waitForReadPoll(window, 0);
    window.cleanup();
    const aborted = new AbortController();
    aborted.abort("caller");
    const callerWindow = i.createReadWindow(aborted.signal, 100, clock);
    expect(callerWindow.cancellation().reason).toBe("caller");
    expect(() => callerWindow.assertActive()).toThrow();
    callerWindow.cleanup();
    const deadlineWindow = i.createReadWindow(new AbortController().signal, 0, { now: () => 1 });
    expect(deadlineWindow.cancellation().reason).toBe("deadline");
    deadlineWindow.cleanup();
    const pendingController = new AbortController();
    let resolveRead!: (value: JsonEnvelope) => void;
    const pendingCli = { runJson: vi.fn(() => new Promise<JsonEnvelope>((resolve) => { resolveRead = resolve; })) } as unknown as LaunchCli;
    const pendingWindow = i.createReadWindow(pendingController.signal, 1000, clock);
    const pendingRead = i.readWithinWindow(pendingCli, ["pane", "get"], pendingWindow);
    pendingController.abort("caller");
    await expect(pendingRead).rejects.toMatchObject({ reason: "caller" });
    resolveRead(ok("read", {}));
    pendingWindow.cleanup();
    const pollController = new AbortController();
    const pollWindow = i.createReadWindow(pollController.signal, 1000, clock);
    const poll = i.waitForReadPoll(pollWindow, 1000);
    pollController.abort("caller");
    await expect(poll).rejects.toMatchObject({ reason: "caller" });
    pollWindow.cleanup();
    const settleController = new AbortController();
    const settle = i.waitForAgentStartSettle(settleController.signal, 1000);
    settleController.abort("caller");
    await expect(settle).rejects.toBe("caller");
    await expect(i.boundedReconciliationRead(async () => 1, new AbortController().signal, Date.now() + 1000)).resolves.toBe(1);
    const expired = new AbortController();
    expired.abort();
    await expect(i.boundedReconciliationRead(async () => 1, expired.signal, Date.now() + 1000)).rejects.toMatchObject({ name: "LaunchReconciliationTimeout" });
    const baseline = { version: "0.8.0", protocol: 22, workspaces: [{ workspace_id: "w", label: "w", focused: true }], tabs: [{ tab_id: "t", workspace_id: "w", label: "t", focused: true }], panes: [{ pane_id: "p", tab_id: "t", workspace_id: "w" }], agents: [] } as HerdrSnapshot;
    const livePane = { pane_id: "p2", tab_id: "t", workspace_id: "w", agent_name: "worker", agent: "pi" };
    const reconciledCli: LaunchCli = { runJson: vi.fn(async (argv) => {
      if (argv[0] === "api") return ok("snapshot", { type: "session_snapshot", snapshot: { ...baseline, panes: [...baseline.panes, livePane], agents: [{ pane_id: "p2", name: "worker", agent: "pi" }] } });
      if (argv[0] === "pane") return ok("pane", { pane: livePane });
      return ok("agent", { agent: { pane_id: "p2", name: "worker", agent: "pi", agent_id: "a" } });
    }), prompt: vi.fn() };
    await expect(i.reconcileLaunch({ cli: reconciledCli, baseline, paneId: "p2", tabId: "t", agentStarted: true, promptSubmitted: false, agentName: "worker" })).resolves.toMatchObject({ effectCertainty: "partial", pane: "present", agent: "present", agentId: "a" });
    const absentCli: LaunchCli = { runJson: vi.fn(async (argv) => {
      if (argv[0] === "api") return ok("snapshot", { type: "session_snapshot", snapshot: { ...baseline, panes: [], agents: [] } });
      return ok(argv[0], argv[0] === "pane" ? { pane: null } : { agent: null });
    }), prompt: vi.fn() };
    await expect(i.reconcileLaunch({ cli: absentCli, baseline, paneId: "p", tabId: "t", agentStarted: false, promptSubmitted: false, agentName: "worker" })).resolves.toMatchObject({ effectCertainty: "absent", pane: "absent", agent: "absent" });
    const failedCli: LaunchCli = { runJson: vi.fn(async () => { throw new Error("read failed"); }), prompt: vi.fn() };
    await expect(i.reconcileLaunch({ cli: failedCli, baseline, paneId: "p", tabId: "t", agentStarted: true, promptSubmitted: true, agentName: "worker" })).resolves.toMatchObject({ effectCertainty: "unknown", snapshot: "unavailable", readFailures: expect.any(Array) });
  });

  it("covers defensive launch projections and identity readbacks", async () => {
    const i = launchTestInternals as unknown as UnsafeLaunchInternals;
    const session = { source: "herdr:pi", agent: "pi", kind: "id", value: "s" };
    const pane = { pane_id: "p", tab_id: "t", workspace_id: "w", agent: "pi", agent_name: "worker", agent_session: session, agent_status: "idle", state_change_seq: 1, status: "ok" };
    expect(i.boundedDiagnosticText("éé", 2)).toBe("é");
    expect(i.safeDiagnosticString(" a\n\t")).toBe("a");
    expect(i.safeDiagnosticString(1)).toBeUndefined();
    expect(i.safeDiagnosticIds({ paneId: "p", agentId: "a", tabId: "t" })).toEqual({ paneId: "p", agentId: "a", tabId: "t" });
    expect(i.diagnosticRecovery("absent", false, false)).toContain("No launch mutation");
    expect(i.diagnosticRecovery("unknown", false, true)).toContain("Inspect");
    expect(i.diagnosticRecovery("partial", true, true)).toContain("do not relaunch");
    expect(i.safeLaunchCode("OK_CODE")).toBe("OK_CODE");
    expect(i.safeLaunchCode("not safe")).toBe("LAUNCH_FAILED");
    expect(i.launchDiagnosticMessage({ code: "bad code", phase: "ready", created: { paneId: "p" }, assignmentState: "unconfirmed", paneId: "p", supervisorJobId: "j", agentStarted: true, promptSubmitted: true, recipientRegistered: false, effectCertainty: "unknown", recoveryGuidance: "Inspect the affected pane and agent with herdr_inspect before retrying; do not assume that no agent started." })).toContain("HERDR_LAUNCH_DIAGNOSTIC");
    expect(i.record({})).toBe(true);
    expect(i.record([])).toBe(false);
    expect(() => i.identifier("", "name")).toThrow();
    expect(() => i.identifier("ok", "name")).not.toThrow();
    expect(i.normalizedParams(task())).toMatchObject({ replicas: 1, tier: "standard", constraints: TASK.constraints });
    expect(i.normalizedParams({ objective: "o", scope: "s", doneWhen: ["d"] })).toMatchObject({ replicas: 1, tier: "standard", constraints: [] });
    expect(renderTask(task())).toContain("Reduce the latency");
    expect(renderTask({ objective: "o", scope: "s", doneWhen: ["d"] })).toContain("Constraints: (none)");
    expect(i.mintChildName("abcdef12-3456-7890-abcd-ef1234567890", 2)).toBe("task-abcdef12-2");
    expect(i.supervisionWorkspaceRoot(undefined)).toEqual({ available: false, reason: "root_unavailable" });
    expect(i.supervisionWorkspaceRoot("")).toEqual({ available: false, reason: "root_unavailable" });
    expect(i.supervisionWorkspaceRoot("relative/dir")).toEqual({ available: false, reason: "root_not_absolute" });
    expect(i.supervisionWorkspaceRoot("/abs")).toEqual({ available: true, root: "/abs" });
    expect(i.paneRecord({ pane }, "p")).toEqual(pane);
    expect(() => i.paneRecord({}, "p")).toThrow();
    expect(() => i.paneRecord(null, "p")).toThrow();
    expect(() => i.paneRecord({ pane: null }, "p")).toThrow();
    expect(() => i.paneRecord({ pane: { pane_id: "other" } }, "p")).toThrow();
    expect(i.agentGetRecord({ agent: pane })).toEqual(pane);
    expect(() => i.agentGetRecord({})).toThrow();
    expect(i.agentIdentity({ agent: { ...pane, agent_id: "a" } }, "worker", "p", "pi").agentId).toBe("a");
    expect(i.agentIdentity({ ...pane, name: "worker", id: "a" }, "worker", "p", "pi").agentId).toBe("a");
    expect(i.agentIdentity({ agent: { ...pane, id: "a" } }, "worker", "p", "pi").agentId).toBe("a");
    expect(() => i.agentIdentity({ agent: null }, "worker", "p", "pi")).toThrow();
    expect(() => i.agentIdentity({ agent: { ...pane, agent: "claude" } }, "worker", "p", "pi")).toThrow();
    expect(() => i.agentIdentity({ agent: { ...pane, agent_status: "invalid" } }, "worker", "p", "pi")).toThrow();
    expect(i.idFrom({ id: "x" }, "id")).toBe("x");
    expect(i.idFrom({}, "id")).toBeUndefined();
    for (const key of ["pane", "root_pane", "rootPane", "new_pane", "child_pane", "created_pane"]) expect(i.paneRefFrom({ [key]: { pane_id: "p", tab_id: "t" } })).toEqual({ paneId: "p", tabId: "t" });
    expect(i.paneRefFrom({ pane_id: "p", tab_id: "t" })).toEqual({ paneId: "p", tabId: "t" });
    expect(i.tabRefFrom({ tab: { tab_id: "t" }, pane: { pane_id: "p" } })).toEqual({ tabId: "t", paneId: "p" });
    expect(i.tabRefFrom({ tab_id: "t", root_pane: { pane_id: "p" } })).toEqual({ tabId: "t", paneId: "p" });
    expect(() => i.paneRefFrom({})).toThrow();
    expect(() => i.tabRefFrom({})).toThrow();
    expect(i.noAgentFromPane({ agent_status: "unknown" })).toBe(true);
    expect(i.noAgentFromPane({ agent_status: "working", agent: "pi" })).toBe(false);
    expect(i.compactAttemptState(pane)).toMatchObject({ pane_id: "p", agent_session: session });
    expect(i.reconciliationFailureCode({ code: "CODE" })).toBe("CODE");
    expect(i.reconciliationFailureCode(Object.assign(new Error("x"), { name: "LaunchReconciliationTimeout" }))).toBe("READ_TIMEOUT");
    expect(i.reconciliationFailureCode(new Error("x"))).toBe("READ_FAILED");
    expect(i.reconciliationTimeout().name).toBe("LaunchReconciliationTimeout");
    expect(i.readbackAgentName({ name: "n" }, undefined)).toBe("n");
    expect(i.readbackAgentName(undefined, { agent_name: "n" })).toBe("n");
    expect(i.readbackAgentName(undefined, { agent: "n" })).toBe("n");
    expect(i.readbackAgentId({ id: "a" }, undefined)).toBe("a");
    expect(i.readbackAgentId(undefined, { agent_id: "a" })).toBe("a");
    expect(() => i.readbackPaneRecord({}, "p")).toThrow();
    expect(i.readbackPaneRecord({ pane: null }, "p")).toBeUndefined();
    expect(i.readbackPaneRecord({ pane }, "p")).toEqual(pane);
    expect(() => i.readbackPaneRecord({ pane: { pane_id: "x" } }, "p")).toThrow();
    expect(() => i.readbackAgentRecord({}, "p")).toThrow();
    expect(i.readbackAgentRecord({ agent: null }, "p")).toBeUndefined();
    expect(i.readbackAgentRecord({ agent: pane }, "p")).toEqual(pane);
    const baseline = { version: "0.8.0", protocol: 22, workspaces: [{ workspace_id: "w", label: "workspace", focused: true }], tabs: [{ tab_id: "t", workspace_id: "w", label: "main", focused: true }], panes: [{ pane_id: "p", tab_id: "t", workspace_id: "w" }], agents: [] } as HerdrSnapshot;
    const reconInput = { baseline, paneId: "p", tabId: "t", agentStarted: false, promptSubmitted: false, agentName: "worker" };
    expect(i.launchEffectCertainty(reconInput, baseline, undefined, pane, [], "p", "t")).toBe("partial");
    expect(i.launchEffectCertainty(reconInput, baseline, undefined, undefined, ["agent:READ_FAILED"], "p", "t")).toBe("unknown");
    expect(i.launchEffectCertainty(reconInput, baseline, undefined, undefined, [], "p", "t")).toBe("unknown");
    expect(i.cliErrorEnvelope(new CliProtocolError("CLI_PROTOCOL_ERROR", "x", { exitCode: 1, killed: false, errorStream: "stderr", stderrTruncated: false, errorEnvelope: { id: "id", error: { code: "code", message: "message" } } }))).toMatchObject({ id: "id" });
    expect(i.cliErrorEnvelope(new Error("x"))).toBeUndefined();
    const startFailure = new CliProtocolError("CLI_PROTOCOL_ERROR", "x", { exitCode: 1, killed: false, errorStream: "stderr", stderrTruncated: false, errorEnvelope: { id: "cli:agent:start", error: { code: "agent_start_failed", message: "agent process exited before becoming interactive" } } });
    expect(i.startFailureEvidence(startFailure)).toMatchObject({ code: "agent_start_failed" });
    expect(i.startFailureEvidence(new Error("x"))).toBeUndefined();
    expect(i.snapshotOf({ type: "session_snapshot", snapshot: baseline })).toEqual(baseline);
    const taken = { ...baseline, agents: [{ name: "agent" }], panes: [{ ...baseline.panes[0], label: "label", agent: "pane-agent" }] } as HerdrSnapshot;
    expect(i.mintedNameTaken(taken, "agent")).toBe(true);
    expect(i.mintedNameTaken(taken, "pane-agent")).toBe(true);
    expect(i.mintedNameTaken(taken, "label")).toBe(true);
    expect(i.mintedNameTaken(taken, "free")).toBe(false);
    const cwdDir = mkdtempSync(join(tmpdir(), "herdr-launch-cwd-x-"));
    try {
      await expect(i.resolveLaunchCwd(cwdDir, repoRoot)).resolves.toBe(realpathSync(cwdDir));
      await expect(i.resolveLaunchCwd(undefined, repoRoot)).resolves.toBe(repoRoot);
      await expect(i.resolveLaunchCwd("missing-dir", repoRoot)).rejects.toMatchObject({ code: "CWD_UNAVAILABLE" });
      await expect(i.resolveLaunchCwd("/nonexistent/herdr-x", repoRoot)).rejects.toMatchObject({ code: "CWD_UNAVAILABLE" });
      await expect(i.resolveLaunchCwd(undefined, "bad\0cwd")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    } finally {
      rmSync(cwdDir, { recursive: true, force: true });
    }
    expect(i.workloadTabOrdinal("implement", "workload:implement")).toBe(1);
    expect(i.workloadTabOrdinal("implement", "workload:implement:3")).toBe(3);
    expect(i.workloadTabOrdinal("implement", "workload:implement:x")).toBeUndefined();
    expect(i.workloadTabOrdinal("implement", "workload:review")).toBeUndefined();
    expect(i.workloadTabOrdinal("implement", "other")).toBeUndefined();
    expect(i.workloadTabOrdinal("implement", undefined)).toBeUndefined();
    const tabbed = { ...baseline, tabs: [{ tab_id: "t", workspace_id: "w", label: "workload:implement" }] } as HerdrSnapshot;
    expect(i.selectWorkloadTab(tabbed, "w", "implement")).toMatchObject({ reuse: { tabId: "t", tabLabel: "workload:implement", anchorPaneId: "p" } });
    const empty = { ...baseline, panes: [], tabs: [{ tab_id: "t", workspace_id: "w", label: "workload:implement" }] } as HerdrSnapshot;
    expect(i.selectWorkloadTab(empty, "w", "implement")).toEqual({ create: { tabLabel: "workload:implement:2" } });
    expect(i.selectWorkloadTab(baseline, "w", "implement")).toEqual({ create: { tabLabel: "workload:implement" } });
    const capped = { ...baseline, tabs: [{ tab_id: "t", workspace_id: "w", label: "workload:implement" }], panes: Array.from({ length: 4 }, (_, index) => ({ pane_id: `p${index}`, tab_id: "t", workspace_id: "w" })) } as HerdrSnapshot;
    expect(i.selectWorkloadTab(capped, "w", "implement")).toEqual({ create: { tabLabel: "workload:implement:2" } });
    const spilled = { ...baseline, tabs: [{ tab_id: "t", workspace_id: "w", label: "workload:implement" }, { tab_id: "t2", workspace_id: "w", label: "workload:implement:2" }], panes: [{ pane_id: "p1", tab_id: "t2", workspace_id: "w" }] } as HerdrSnapshot;
    expect(i.selectWorkloadTab(spilled, "w", "implement")).toMatchObject({ reuse: { tabId: "t2" } });
    expect(i.noFocusArgs()).toEqual(["--no-focus"]);
    expect(i.compactCliFailureEvidence({ code: "X", message: "message", details: { exitCode: 1, killed: false, stdout: "out", stderr: "err", errorStream: "stderr", errorEnvelope: { id: "e", error: { code: "C", message: "M" } } } })).toMatchObject({ code: "X", details: { exitCode: 1, errorStream: "stderr", errorEnvelope: { id: "e" } } });
    expect(i.compactCliFailureEvidence({ details: { evidence: "omitted_for_prompt_delivery", errorStream: "stdout", stdout: "out", errorEnvelope: { id: "e", error: { code: 1, message: "bad" } } } })).toMatchObject({ details: { evidence: "omitted_for_prompt_delivery", errorStream: "stdout" } });
    expect(i.compactCliFailureEvidence({})).toBeUndefined();
    expect(i.cliFailureEvidence(1)).toBeUndefined();
    expect(i.cliFailureEvidence(new CliProtocolError("CLI_PROTOCOL_ERROR", "message", { exitCode: 1, killed: false, errorStream: "stderr", stderrTruncated: false }))).toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    expect(i.launchTransportCode(new CliProtocolError("CLI_PROTOCOL_ERROR", "message", { exitCode: 1, killed: false, errorStream: "stderr", stderrTruncated: false }))).toBe("CLI_PROTOCOL_ERROR");
    expect(i.launchTransportCode(Object.assign(new Error("message"), { code: "CUSTOM" }))).toBe("CUSTOM");
    expect(i.launchTransportCode(new Error("message"))).toBe("CLI_PROTOCOL_ERROR");
    expect(i.causeMessage(new Error("message"))).toBe("message");
    expect(i.causeMessage(1)).toBe("1");
    expect(i.earlyLaunchFailure(Object.assign(new Error("failure"), { code: "CUSTOM" }), "validate")).toMatchObject({ code: "CUSTOM" });
    expect(i.earlyLaunchFailure(Object.assign(new Error("empty"), { code: "" }), "validate")).toMatchObject({ code: "LAUNCH_FAILED" });
    expect(i.failureEffectCertainty({ agentStarted: false, promptSubmitted: false }, false, undefined)).toBe("absent");
    expect(i.failureEffectCertainty({ agentStarted: true, promptSubmitted: false }, true, undefined)).toBe("unknown");
    expect(i.failureEffectCertainty({ agentStarted: false, promptSubmitted: false }, true, { effectCertainty: "partial" })).toBe("partial");
    expect(i.launchChildError(new Error("child failure"))).toEqual({ code: "CLI_PROTOCOL_ERROR" });
    expect(i.launchChildError(Object.assign(new Error("child"), { code: "CHILD" }))).toEqual({ code: "CHILD" });
    expect(i.launchChildError(i.earlyLaunchFailure(new Error("hidden cause"), "validate"))).toEqual({ code: "CLI_PROTOCOL_ERROR", message: "Launch failed; inspect the structured diagnostic", causeCode: "CLI_PROTOCOL_ERROR", effectCertainty: "absent" });
    expect(i.launchManifest({ kind: "launch", launchId: "l1", outcome: "partial", requestedTier: "standard", children: [{ target: "task-l1-1", state: "launched", operatingPointId: "pt", supervisorJobId: "j" }, { target: "task-l1-2", state: "failed", error: { code: "CHILD" } }] })).toContain("supervisor=j");
    expect(i.launchManifest({ kind: "launch", launchId: "l1", outcome: "failed", requestedTier: "standard", children: [], error: { code: "FAILED" } })).toContain("error=FAILED");
    expect(i.pointIdentity({ index: 1, id: "pt:m", runner: "pi", model: "m" })).toEqual({ index: 1, id: "pt:m", runner: "pi", model: "m" });
    expect(i.resolvedPointIdentity({ index: 1, point: { id: "pt:m", runner: "pi", model: "m" } })).toEqual({ index: 1, id: "pt:m", runner: "pi", model: "m" });
    expect(i.resolvedPointKey({ index: 1, point: { id: "pt:m", runner: "pi", model: "m" } })).toBe("pt:m");
    expect(i.isAdmitted({ kind: "admitted" })).toBe(true);
    expect(i.isAdmitted({ kind: "abstained" })).toBe(false);
    expect(i.recipientCapability("pi")).toMatchObject({ kind: "pi", capable: true });
    expect(i.recipientCapability("devin")).toMatchObject({ kind: "devin", capable: true });
    const routedTask: RoutingTask = { objective: "o", scope: "s", doneWhen: ["d"], constraints: [] };
    expect(i.taskRouterState(routedTask, catalogOf([{ runner: "pi", model: "pi-model" }])).points).toHaveLength(1);
    expect(i.taskRouteLogEntry("launch-1", { task: routedTask, decision: { kind: "abstained", reason: "x", component: "y" } })).toMatchObject({ caller: "launch-1", result: { kind: "abstained" } });
    const updates: unknown[] = [];
    i.progress((update: unknown) => updates.push(update), "launch-1", "task-l1-1", "ready", "standard");
    i.progress(undefined, "launch-1", "task-l1-1", "agent_start", "standard");
    expect(updates).toHaveLength(1);
    const runCli: LaunchCli = { runJson: vi.fn(async () => ok("run", { value: 1 })), prompt: vi.fn(async () => ok("prompt", {})) };
    expect(await i.run(runCli, ["api"], new AbortController().signal)).toEqual({ value: 1 });
    expect(await i.runPrompt(runCli, "p", "text", new AbortController().signal)).toMatchObject({ id: "prompt" });
    const abortedRun = new AbortController();
    abortedRun.abort();
    await expect(i.run(runCli, ["api"], abortedRun.signal)).rejects.toMatchObject({ code: "ABORTED" });
    const failedRunCli = { runJson: vi.fn(async () => { throw new Error("run failed"); }), prompt: vi.fn() } as LaunchCli;
    await expect(i.run(failedRunCli, ["api"], new AbortController().signal)).rejects.toThrow("run failed");
    const grant = { path: "/tmp/grant", token: "token", renew: vi.fn(), release: vi.fn() };
    expect(i.partialError(new Error("partial"), { paneId: "p" }, "ready", grant, { agentStarted: true, promptSubmitted: true, recipientRegistered: false, mutationDispatched: true, assignmentState: "unconfirmed", timing: {}, attempts: [] }, "inline")).toMatchObject({ code: "LAUNCH_FAILED", details: { phase: "ready" } });
    expect(i.partialError(new Error("\0"), {}, "placement", grant, { agentStarted: false, promptSubmitted: false, recipientRegistered: false, mutationDispatched: false, timing: {}, attempts: [] })).toMatchObject({ code: "LAUNCH_FAILED" });
  });

  it("covers prompt confirmation reason variants", async () => {
    const i = launchTestInternals as unknown as UnsafeLaunchInternals;
    const session = { source: "herdr:pi", agent: "pi", kind: "id", value: "prompt-variants" };
    const submission = { confirmed: true, paneId: "p", terminalId: "t0", agentName: "worker", agentKind: "pi", agentSession: session, revision: 2, stateChangeSeq: 1 };
    const baseline = { state: "idle", stateChangeSeq: 1, revision: 2 };
    const pane = { pane_id: "p", tab_id: "t", workspace_id: "w", agent_name: "worker", agent: "pi", terminal_id: "t0", agent_session: session, agent_status: "idle", state_change_seq: 2, revision: 3 };
    const observation = (agent: Record<string, unknown>): LaunchCli => ({ runJson: vi.fn(async (argv) => argv[0] === "agent" ? ok("agent", { agent }) : ok("pane", { pane })), prompt: vi.fn() });
    const identityUnavailable = { pane_id: "p", agent_status: "idle", state_change_seq: 2, revision: 3 };
    await expect(i.confirmPromptConsumption({ runJson: vi.fn(async (argv) => argv[0] === "agent" ? ok("agent", { agent: identityUnavailable }) : ok("pane", { pane })), prompt: vi.fn() }, "p", new AbortController().signal, submission, baseline, { now: () => 0 }, 0)).rejects.toMatchObject({ details: { promptConfirmation: { reason: "identity_unavailable" } } });
    const contradictory = { pane_id: "p", name: "worker", agent: "pi", terminal_id: "t0", agent_session: session, agent_status: "malformed", state_change_seq: 2, revision: 3 };
    await expect(i.confirmPromptConsumption(observation(contradictory), "p", new AbortController().signal, submission, baseline, { now: () => 0 }, 0)).rejects.toMatchObject({ details: { promptConfirmation: { reason: "contradictory" } } });
    const advanced = await i.confirmPromptConsumption(observation({ pane_id: "p", name: "worker", agent: "pi", terminal_id: "t0", agent_session: session, agent_status: "idle", state_change_seq: 2, revision: 3 }), "p", new AbortController().signal, submission, baseline, { now: () => 0 }, 0);
    expect(advanced.confirmation.reason).toBe("state_change_seq_advanced");
    const targetUnavailable = { runJson: vi.fn(async () => { throw Object.assign(new Error("identity read"), { code: "TARGET_IDENTITY_UNAVAILABLE" }); }), prompt: vi.fn() } as LaunchCli;
    await expect(i.confirmPromptConsumption(targetUnavailable, "p", new AbortController().signal, submission, baseline, { now: () => 0 }, 0)).rejects.toMatchObject({ details: { promptConfirmation: { reason: "identity_unavailable" } } });
  });

  it("covers AGY acknowledgement, lifecycle, and cancellation variants", async () => {
    const i = launchTestInternals as unknown as UnsafeLaunchInternals;
    const session = { source: "herdr:agy", agent: "agy", kind: "id", value: "agy-variants" };
    const identity = { paneId: "p", terminalId: "t0", agentName: "worker", agentKind: "agy" };
    const baseline = { state: "idle", stateChangeSeq: 1, revision: 2 };
    const basePane = { pane_id: "p", tab_id: "t", workspace_id: "w", agent_name: "worker", agent: "agy", terminal_id: "t0", agent_session: session, agent_status: "idle", state_change_seq: 2, revision: 3 };
    const baseAgent = { pane_id: "p", name: "worker", agent: "agy", terminal_id: "t0", agent_session: session, agent_status: "idle", state_change_seq: 2, revision: 3, interactive_ready: true };
    const snapshot = { version: "0.8.0", protocol: 22, workspaces: [{ workspace_id: "w", label: "w", focused: true }], tabs: [{ tab_id: "t", workspace_id: "w", label: "t", focused: true }], panes: [basePane], agents: [baseAgent] } as HerdrSnapshot;
    const ack = { operationId: "op", identity, revision: 2 };
    const cliFor = (agent: Record<string, unknown>, pane: Record<string, unknown> = basePane, currentSnapshot: HerdrSnapshot = snapshot): LaunchCli => ({ runJson: vi.fn(async (argv) => argv[0] === "api" ? ok("api", { type: "session_snapshot", snapshot: currentSnapshot }) : argv[0] === "agent" ? ok("agent", { agent }) : ok("pane", { pane })), prompt: vi.fn() });
    const submitted = await i.confirmAgyNativeSession(cliFor(baseAgent), new AbortController().signal, ack, baseline, { now: () => 0 }, 0);
    expect(submitted.confirmation.reason).toBe("state_change_seq_advanced");
    const screenAck = { ...ack, screenDetectionSkipped: true };
    const screenSubmitted = await i.confirmAgyNativeSession(cliFor({ ...baseAgent, screen_detection_skipped: true }), new AbortController().signal, screenAck, baseline, { now: () => 0 }, 0);
    expect(screenSubmitted.submission.screenDetectionSkipped).toBe(true);
    const doneAgent = { ...baseAgent, agent_status: "done" };
    const done = await i.confirmAgyNativeSession(cliFor(doneAgent, { ...basePane, agent_status: "done" }), new AbortController().signal, ack, baseline, { now: () => 0 }, 0);
    expect(done.observation.status).toBe("not_working");
    const unknownAgent = { ...baseAgent, agent_status: "unknown" };
    let unknownTick = 0;
    await expect(i.confirmAgyNativeSession(cliFor(unknownAgent, { ...basePane, agent_status: "unknown" }), new AbortController().signal, ack, baseline, { now: () => unknownTick++ < 20 ? 0 : 6_000 }, 0)).rejects.toMatchObject({ details: { promptConfirmation: { reason: "timeout" } } });
    const missingLifecycle = { ...baseAgent, agent_status: undefined, state_change_seq: undefined, revision: undefined };
    let missingTick = 0;
    await expect(i.confirmAgyNativeSession(cliFor(missingLifecycle), new AbortController().signal, ack, baseline, { now: () => missingTick++ < 20 ? 0 : 6_000 }, 0)).rejects.toMatchObject({ details: { promptConfirmation: { reason: "timeout" } } });
    const missingStatus = { ...baseAgent, agent_status: undefined };
    let missingStatusTick = 0;
    await expect(i.confirmAgyNativeSession(cliFor(missingStatus), new AbortController().signal, ack, baseline, { now: () => missingStatusTick++ < 20 ? 0 : 6_000 }, 0)).rejects.toMatchObject({ details: { promptConfirmation: { reason: "timeout" } } });
    const innerError = new Error("inner confirmation error");
    const genericInnerCli: LaunchCli = { runJson: vi.fn(async (argv) => {
      if (argv[0] === "api") return ok("api", { type: "session_snapshot", snapshot });
      if (argv[0] === "agent") return ok("agent", { agent: new Proxy(baseAgent, { get(target, property) { if (property === "pane_id") throw innerError; return target[property as keyof typeof target]; } }) });
      return ok("pane", { pane: basePane });
    }), prompt: vi.fn() };
    await expect(i.confirmAgyNativeSession(genericInnerCli, new AbortController().signal, ack, baseline, { now: () => 0 }, 0)).rejects.toMatchObject({ details: { promptConfirmation: { reason: "contradictory", sourceCode: "POSTSTATE_UNAVAILABLE" } } });
    const aborted = new AbortController();
    const abortingAgent = new Proxy(baseAgent, { get(target, property) { if (property === "pane_id") { aborted.abort("caller"); throw innerError; } return target[property as keyof typeof target]; } });
    const abortingCli = cliFor(abortingAgent);
    await expect(i.confirmAgyNativeSession(abortingCli, aborted.signal, ack, baseline, { now: () => 0 }, 0)).rejects.toMatchObject({ code: "PROMPT_UNCONFIRMED" });
    const codedFailure: LaunchCli = { runJson: vi.fn(async (argv) => { if (argv[0] === "api") return ok("api", { type: "session_snapshot", snapshot }); if (argv[0] === "agent") throw Object.assign(new Error("identity read"), { code: "TARGET_IDENTITY_UNAVAILABLE" }); return ok("pane", { pane: basePane }); }), prompt: vi.fn() };
    await expect(i.confirmAgyNativeSession(codedFailure, new AbortController().signal, ack, baseline, { now: () => 0 }, 0)).rejects.toMatchObject({ details: { promptConfirmation: { reason: "identity_unavailable", sourceCode: "TARGET_IDENTITY_UNAVAILABLE" } } });
  });

  it("covers default launch dependencies and omitted signals", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const cli = makeCli();
    const tool = createLaunchTool({ cli: cli.cli, context, preflight: async () => undefined, supervision: stubSupervision(), launchGate: openLaunchGate, handoffs: fakeHandoffs(), specClient: { evaluate: vi.fn(async () => ({ kind: "response" as const, response: responseFor(catalog) })) }, catalog: { load: async () => catalog }, routerLog: vi.fn(async () => undefined) as LaunchRouterLog });
    const result = await tool.execute("call", task(), undefined, undefined, { cwd: repoRoot, signal: undefined } as unknown as ExtensionContext);
    expect(result.details).toMatchObject({ kind: "launch", outcome: "launched", children: [{ state: "launched" }] });
    const executableCli = makeCli();
    Object.assign(executableCli.cli, { exec: vi.fn() });
    createLaunchTool({ cli: executableCli.cli, context, preflight: async () => undefined, supervision: stubSupervision(), catalog: { load: async () => catalog } });
    createLaunchTool({ cli: executableCli.cli, context, preflight: async () => undefined, supervision: stubSupervision(), catalog: { load: async () => catalog }, selfClose: { onPaneClosed: vi.fn() } as unknown as NonNullable<LaunchDependencies["selfClose"]> });
  });

  it("covers router availability and compile error projections", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const input = { task: { objective: "o", scope: "s", doneWhen: ["d"], constraints: [] }, spec: spec(), catalog, response: responseFor(catalog), root: "/tmp", availability: async () => ({ status: "unknown", retryNotBefore: null, evidence: { records: 0 } }), compile: async () => { throw new Error("compile unavailable"); } };
    await expect(routeTask(input as never)).resolves.toMatchObject({ kind: "abstained", reason: "catalog_unavailable", component: "configuration" });
    const unavailable = { ...input, availability: async () => { throw new Error("availability unavailable"); }, compile: async () => ({}) };
    await expect(routeTask(unavailable as never)).resolves.toMatchObject({ kind: "abstained", reason: "transport_failed", component: "availability" });
    const throwingResponse = new Proxy(responseFor(catalog), { get() { throw new Error("routing response access"); } });
    const launchRouting = await toolFor({ catalog, cli: makeCli().cli, specClient: { evaluate: vi.fn(async () => ({ kind: "response" as const, response: throwingResponse })) } }).execute("call", task(), new AbortController().signal, undefined, extensionContext);
    expect(launchRouting.details).toMatchObject({ outcome: "abstained", children: [] });
    const aborted = new AbortController();
    aborted.abort("caller");
    const abortedTool = toolFor({ catalog, cli: makeCli().cli, specClient: { evaluate: vi.fn(async () => { throw new Error("transport"); }) } });
    const abortedResult = await abortedTool.execute("call", task(), aborted.signal, undefined, extensionContext);
    expect(abortedResult.details).toMatchObject({ outcome: "abstained", children: [] });
  });

  it("covers diagnostic, manifest, and route-state projections", () => {
    const i = launchTestInternals as unknown as UnsafeLaunchInternals;
    const grant = { path: "/tmp/grant", token: "token", renew: vi.fn(), release: vi.fn() };
    const cliError = new CliProtocolError("CLI_PROTOCOL_ERROR", "cli failure", { exitCode: 1, killed: false, errorStream: "stderr", stderrTruncated: false, errorEnvelope: { id: "cli:agent:start", error: { code: "agent_start_failed", message: "failed" } } });
    expect(i.cliFailureEvidence({ code: "PLAIN", details: { stderr: "stderr" } })).toMatchObject({ code: "PLAIN" });
    expect(i.earlyLaunchFailure(Object.assign(new Error("cause"), { code: "CUSTOM", details: { causeCode: "ORIGINAL", cliFailure: { code: "CLI" } } }), "validate")).toMatchObject({ details: { causeCode: "ORIGINAL" } });
    expect(i.earlyLaunchFailure(Object.assign(new Error("\0"), { code: "CUSTOM" }), "validate")).toMatchObject({ code: "CUSTOM" });
    const activeSupervision = { state: "active", jobId: "job", child: { paneId: "p" } };
    const provisionalSupervision = { state: "provisional", jobId: "job", provisional: { paneId: "p" } };
    const effects = { agentStarted: true, promptSubmitted: true, recipientRegistered: true, mutationDispatched: true, promptDispatch: { state: "acknowledged", requestId: "req" }, assignmentState: "confirmed", initialPromptSubmission: { confirmed: true }, readiness: { elapsedMs: 1 }, supervision: activeSupervision, timing: { selectedStartReadinessMs: 1 }, attempts: [{ point: { index: 0, id: "pt:m", runner: "pi", model: "m" }, outcome: "selected" }] };
    expect(i.partialError(cliError, { paneId: "p" }, "agent_start", grant, effects, "attachment", { attachmentId: "a" }, { effectCertainty: "partial", pane: "present", agent: "present", snapshot: "present" })).toMatchObject({ code: "LAUNCH_FAILED", details: { attachmentRetained: true, supervision: activeSupervision } });
    const readyTimeout = i.earlyLaunchFailure(Object.assign(new Error("timeout"), { code: "READY_TIMEOUT" }), "ready");
    readyTimeout.details.readiness = { elapsedMs: 1 } as unknown as UnsafeTestValue;
    expect(i.partialError(readyTimeout, {}, "ready", grant, { ...effects, supervision: provisionalSupervision, readiness: undefined, assignmentState: undefined, initialPromptSubmission: undefined, promptDispatch: undefined, timing: {}, attempts: [] }, undefined, undefined, undefined)).toMatchObject({ code: "READY_TIMEOUT", details: { readiness: expect.any(Object) } });
    expect(i.partialError(Object.assign(new Error("aborted"), { code: "ABORTED" }), {}, "placement", grant, { agentStarted: false, promptSubmitted: false, recipientRegistered: false, mutationDispatched: false, timing: {}, attempts: [] })).toMatchObject({ code: "ABORTED" });
    expect(i.launchManifest({ kind: "launch", launchId: "l1", outcome: "failed", requestedTier: "standard", children: [], error: { code: "FAILED", message: "failed" } })).toContain("children=0");
    const missingRunnerCatalog = { ...catalogOf([{ runner: "pi", model: "m" }]), runners: new Map() };
    expect(i.taskRouterState({ objective: "o", scope: "s", doneWhen: ["d"], constraints: [] }, missingRunnerCatalog).points[0]).toMatchObject({ timeout: 0 });
    const ungeneratedCatalog = { ...catalogOf([{ runner: "pi", model: "m" }]) };
    delete ungeneratedCatalog.points;
    expect(i.taskRouterState({ objective: "o", scope: "s", doneWhen: ["d"], constraints: [] }, ungeneratedCatalog).points).toEqual([]);
  });

  it("covers nullish identity and readiness projection variants", async () => {
    const i = launchTestInternals as unknown as UnsafeLaunchInternals;
    const session = { source: "herdr:pi", agent: "pi", kind: "id", value: "s" };
    const identity = { paneId: "p", terminalId: "t", agentName: "worker", agentKind: "pi", agentSession: session };
    expect(i.agentIdentity({ name: "worker", pane_id: "p", agent: "pi", terminal_id: "t", agent_session: session, agent_status: "idle" }, "worker", "p", "pi")).toMatchObject({ startRecord: { name: "worker" } });
    expect(i.tabRefFrom({ tab: { tab_id: "t" }, pane: null, root_pane: null, rootPane: { pane_id: "p" } })).toEqual({ tabId: "t", paneId: "p" });
    expect(i.tabRefFrom({ tab: { tab_id: "t", pane: { pane_id: "p" } }, pane: null, root_pane: null, rootPane: null })).toEqual({ tabId: "t", paneId: "p" });
    expect(i.compactAttemptState({ agent_name: " \n", status: "ok" })).toMatchObject({ status: "ok" });
    expect(i.noAgentFromPane({ agent_status: "unknown", kind: null })).toBe(true);
    expect(i.agyInteractiveReadiness([{ source: "pane_get", value: {} }])).toEqual([]);
    expect(i.readinessBaseline({ pane_id: "p", terminal_id: "t", name: "worker", agent: "pi", agent_session: session, agent_status: "idle", state_change_seq: 1, revision: 2 }, identity, { agentStatus: "idle", stateChangeSeq: 1, revision: 2, screenDetectionSkipped: true }).baseline).toMatchObject({ screenDetectionSkipped: true });
    expect(i.readinessEvidence({ now: () => 1 }, 0, 1, [], false, undefined)).toMatchObject({ baselineRequired: false });
    const baseline = { version: "0.8.0", protocol: 22, workspaces: [{ workspace_id: "w", label: "workspace", focused: true }], tabs: [{ tab_id: "t", workspace_id: "w", label: "main", focused: true }], panes: [{ pane_id: "p", tab_id: "t", workspace_id: "w" }], agents: [] } as HerdrSnapshot;
    const presentPaneNoAgent: LaunchCli = { runJson: vi.fn(async (argv) => {
      if (argv[0] === "api") return ok("snapshot", { type: "session_snapshot", snapshot: { ...baseline, panes: [...baseline.panes, { pane_id: "p", tab_id: "t", workspace_id: "w" }], agents: [] } });
      if (argv[0] === "pane") return ok("pane", { pane: { pane_id: "p", tab_id: "t", workspace_id: "w" } });
      return ok("agent", { agent: null });
    }), prompt: vi.fn() };
    await expect(i.reconcileLaunch({ cli: presentPaneNoAgent, baseline, paneId: "p", tabId: "t", agentStarted: true, promptSubmitted: false, agentName: "worker" })).resolves.toMatchObject({ pane: "present", agent: "absent" });
  });
});
