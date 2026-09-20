import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CliProtocolError, type JsonEnvelope } from "../../src/cli.js";
import { parseCatalog, type Catalog, type ChainCandidate, type RunnerEntry } from "../../src/catalog.js";
import { PublishedLaunchParamsSchema, SpecLaunchParamsSchema, type LaunchSpec, type SpecLaunchRequest } from "../../src/launch-schema.js";
import { SPEC_BASELINE } from "../../src/spec-baseline.js";
import { createLaunchTool, launchTestInternals, validateLaunchParams, type LaunchCli, type LaunchDependencies, type LaunchDetails, type LaunchRouterLog } from "../../src/tools/launch.js";
import { routeSpec } from "../../src/router.js";
import type { SpecModelDecision } from "../../src/router.js";
import type { HerdrSnapshot } from "../../src/targets.js";
import { parsePromptTargetIdentityFields } from "../../src/messages/prompt.js";
import type { AttachmentStore } from "../../src/messages/store.js";
import type { HandoffAllocator } from "../../src/handoff.js";
import type { SupervisionReserveRequest } from "../../src/supervision/registry.js";
import { SupervisionBindError } from "../../src/supervision/supervisor.js";
import type { WorktreeManager } from "../../src/worktree.js";
import { RecipientRegistry } from "../../src/messages/recipients.js";
import { attachmentCapability, handoffWriteCapability } from "../../src/profiles/capability.js";
import { parseProfile, profileSource, refreshBundledProfileResourceSelection, SKILL_BUNDLE_REGISTRY_FILE, skillTreeDigest, validateProfileResourceSelection } from "../../src/profiles/index.js";
import { stubSupervision, type StubSupervision } from "./supervision-fixtures.js";

const context = { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" };
const extensionContext = { cwd: "/repo", signal: new AbortController().signal } as ExtensionContext;
const assignment = (objective = "Ship the focused change.") => ({ objective, scope: "Only the assigned worktree.", verification: "Run the focused test." });
const digest = () => ({ doneWhen: ["The assigned objective is complete and verified."], constraints: ["Do not broaden the assignment."] });
const ok = (id: string, result: unknown): JsonEnvelope => ({ id, result });

function runnerEntry(models: readonly string[]): RunnerEntry {
  return {
    kind: "pi",
    models: [...models],
    quota: { provider: "test-provider", billingProduct: "test-product", account: "test-account", scope: "project" },
    defaults: { timeoutMinutes: 30, sessionPersistence: false, thinking: "low" },
    plumbing: { sessionPersistence: "optional", promptDelivery: "file", skillSelection: "exact", toolSelection: "allowlist" },
    pools: { tools: ["read"], extensions: [], skills: [], plugins: [], mcp: [] },
  };
}

function catalogOf(chain: readonly ChainCandidate[]): Catalog {
  const models = chain.filter((candidate) => candidate.runner === "pi").map((candidate) => candidate.model);
  return {
    version: 1,
    maxAttempts: 4,
    categories: new Map([["worker", [...chain]]]),
    runners: new Map([["pi", runnerEntry(models)]]),
    skills: [],
    plugins: [],
    mcpServers: new Map(),
    quotaSources: [{ name: "reactive-cooldowns", kind: "floor" }],
    source: { path: "/tmp/catalog.yaml", scopeRoot: "/tmp" },
  };
}

function spec(overrides: Partial<LaunchSpec> = {}): LaunchSpec {
  return {
    label: "worker",
    instructions: "Reduce the latency without changing the public contract.",
    assignment: assignment(),
    category: "worker",
    count: 1,
    ...overrides,
  };
}

function request(overrides: Partial<SpecLaunchRequest> = {}): SpecLaunchRequest {
  return { name: "task", specs: [spec()], supervisionDigest: digest(), ...overrides };
}

function responseFor(catalog: Catalog, quality = { instructions_adequate: 0.95, assignment_verifiable: 0.95 }): SpecModelDecision {
  return {
    quality,
    category: { category: "worker", confidence: 0.95 },
    candidates: (catalog.categories.get("worker") ?? []).map((candidate, index) => ({
      index,
      runner: candidate.runner,
      model: candidate.model,
      resources: catalog.runners.get(candidate.runner)?.plumbing.toolSelection === "ambient" ? {} : { tools: ["read"] },
    })),
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
      return { runId, namespaceDir: tmpdir(), directory, artifactPath: join(directory, "handoff.md"), toolsDir: join(directory, ".tools"), statePath: join(directory, ".tools", "state.json"), lockPath: join(directory, ".tools", "lock"), marker: `herdr-run:${runId}` };
    }),
    persist: vi.fn(async () => undefined),
  };
}

type Child = { paneId: string; tabId: string; name: string; kind: string; terminalId: string; session: { source: string; agent: string; kind: string; value: string }; prompt: boolean; agentId?: string };

function makeCli(options: {
  start?: (argv: string[], attempt: number) => JsonEnvelope | never;
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
      { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "caller", agent_status: "idle" },
      ...children.map((child) => ({ pane_id: child.paneId, tab_id: child.tabId, workspace_id: "w1", label: child.name, agent_name: child.name, agent: child.kind, terminal_id: child.terminalId, agent_session: child.session, agent_status: child.prompt ? "working" : "idle", state_change_seq: child.prompt ? 8 : 7, revision: child.prompt ? 4 : 3, interactive_ready: true, ...(child.agentId === undefined ? {} : { agent_id: child.agentId }) })), 
    ],
    agents: children.map((child) => ({ pane_id: child.paneId, name: child.name, agent: child.kind, terminal_id: child.terminalId, agent_session: child.session, agent_status: child.prompt ? "working" : "idle", state_change_seq: child.prompt ? 8 : 7, revision: child.prompt ? 4 : 3, interactive_ready: true, ...(child.agentId === undefined ? {} : { agent_id: child.agentId }) })), 
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
    runJson: vi.fn(async (argv) => {
      calls.push(argv);
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
          const result = options.start(argv, attempt);
          children.push(active);
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

function toolFor(options: {
  catalog: Catalog;
  cli: LaunchCli;
  specClient?: LaunchDependencies["specClient"];
  supervision?: StubSupervision;
  attachments?: AttachmentStore;
  ownership?: LaunchDependencies["ownership"];
  launchGate?: LaunchDependencies["launchGate"];
  worktrees?: WorktreeManager;
  routerLog?: LaunchRouterLog;
  catalogLoad?: () => Promise<Catalog>;
  preflight?: LaunchDependencies["preflight"];
  contextResolver?: LaunchDependencies["contextResolver"];
  promptSources?: LaunchDependencies["promptSources"];
  queueFlush?: LaunchDependencies["queueFlush"];
  clock?: LaunchDependencies["clock"];
}): ReturnType<typeof createLaunchTool> {
  const supervision = options.supervision ?? stubSupervision();
  const specClient = options.specClient ?? { evaluate: vi.fn(async () => ({ kind: "response" as const, response: responseFor(options.catalog) })) };
  return createLaunchTool({
    cli: options.cli,
    context,
    cwd: "/repo",
    preflight: options.preflight ?? (async () => undefined),
    supervision,
    specClient,
    catalog: { load: options.catalogLoad ?? (async () => options.catalog) },
    attachments: options.attachments ?? fakeAttachments(),
    handoffs: fakeHandoffs(),
    ...(options.ownership === undefined ? {} : { ownership: options.ownership }),
    recipients: new RecipientRegistry(),
    routerLog: options.routerLog ?? (vi.fn(async () => undefined) as LaunchRouterLog),
    ...(options.contextResolver === undefined ? {} : { contextResolver: options.contextResolver }),
    ...(options.promptSources === undefined ? {} : { promptSources: options.promptSources }),
    ...(options.queueFlush === undefined ? {} : { queueFlush: options.queueFlush }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.launchGate === undefined ? {} : { launchGate: options.launchGate }),
    ...(options.worktrees === undefined ? {} : { worktrees: options.worktrees }),
  });
}

type UnsafeTestValue = { (...args: unknown[]): UnsafeTestValue; [key: string]: UnsafeTestValue };
type UnsafeLaunchInternals = { [K in keyof typeof launchTestInternals]: UnsafeTestValue };

async function execute(tool: ReturnType<typeof createLaunchTool>, params: unknown): Promise<AgentToolResult<LaunchDetails>> {
  const result = await tool.execute("call", params as never, new AbortController().signal, undefined, extensionContext);
  if (result.details?.operation !== "launch") throw new Error("expected one launched child");
  return result as AgentToolResult<LaunchDetails>;
}

describe("herdr_launch spec cutover", () => {
  it("publishes and validates only the strict spec request", () => {
    const valid = request();
    expect(Value.Check(SpecLaunchParamsSchema, valid)).toBe(true);
    expect(Value.Check(SpecLaunchParamsSchema, { ...valid, transportBypass: "receipt-token" })).toBe(true);
    expect(Value.Check(SpecLaunchParamsSchema, { ...valid, transportBypass: "" })).toBe(false);
    expect(Value.Check(PublishedLaunchParamsSchema, valid)).toBe(true);
    expect(() => validateLaunchParams(valid)).not.toThrow();
    expect(Value.Check(SpecLaunchParamsSchema, { ...valid, profile: "worker" })).toBe(false);
    expect(() => validateLaunchParams({ ...valid, profile: "worker" } as never)).toThrow();
    expect(() => validateLaunchParams({ ...valid, supervisionDigest: undefined } as never)).toThrow();
    const duplicate = { ...valid, specs: [spec(), spec({ label: "worker" })] };
    expect(Value.Check(SpecLaunchParamsSchema, duplicate)).toBe(false);
    expect(() => validateLaunchParams(duplicate)).toThrow();
    expect([...Value.Errors(SpecLaunchParamsSchema, duplicate)]).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining("duplicate spec.label") })]));
    expect(Value.Check(SpecLaunchParamsSchema, { ...valid, specs: [spec({ label: "worker-overlong" })] })).toBe(false);
  });

  it("derives the child name, carries the universal baseline, and reserves the caller digest", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const harness = makeCli({ agentId: "agent-task-worker-1" });
    const supervision = stubSupervision();
    const requests: SupervisionReserveRequest[] = [];
    const reserve = supervision.reserve;
    supervision.reserve = vi.fn(async (value) => { requests.push(value); return reserve(value); });
    const result = await execute(toolFor({ catalog, cli: harness.cli, supervision }), request());

    expect(result.details).toMatchObject({ outcome: "launched", name: "task-worker-1", kind: "pi", spec: { label: "worker", count: 1, selected: { model: "pi-model" } }, supervision: { state: "active" } });
    expect(harness.prompts).toHaveLength(1);
    expect(harness.prompts[0]).toContain(SPEC_BASELINE);
    expect(harness.prompts[0]).toContain("Reduce the latency without changing the public contract.");
    expect(requests[0]).toMatchObject({ child: { agentName: "task-worker-1", agentKind: "pi", candidateName: "pi-model" }, settings: { supervisionDigest: digest() } });
    expect(Object.keys(requests[0]!.settings!.supervisionDigest!).sort()).toEqual(["constraints", "doneWhen"]);
  });

  it("rejects digest-absent and legacy profile requests before any CLI mutation", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const harness = makeCli();
    const tool = toolFor({ catalog, cli: harness.cli });
    await expect(tool.execute("call", { name: "task", specs: [spec()] } as never, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(tool.execute("call", { name: "task", profile: "worker", assignment: assignment(), supervisionDigest: digest() } as never, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(harness.calls).toEqual([]);
  });

  it("keeps rejected specs rejected and performs no launch mutation", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const harness = makeCli();
    const specClient = { evaluate: vi.fn(async () => ({ kind: "response" as const, response: responseFor(catalog, { instructions_adequate: 0.1, assignment_verifiable: 0.1 }) })) };
    const tool = toolFor({ catalog, cli: harness.cli, specClient });
    const result = await tool.execute("call", request(), new AbortController().signal, undefined, extensionContext);
    expect(result.details).toMatchObject({ operation: "launch_batch", outcome: "abstained", router: [{ kind: "rejected", quality: "rejected" }], children: [] });
    expect(harness.calls).toEqual([]);
  });

  it("launches a Bash-only task after excluding every hedged alternative execution tool", async () => {
    const baseCatalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const pi = baseCatalog.runners.get("pi")!;
    const runners = new Map(baseCatalog.runners);
    runners.set("pi", { ...pi, pools: { ...pi.pools, tools: ["read", "bash", "executor_execute", "exec_command"] } });
    const catalog: Catalog = { ...baseCatalog, runners };
    const response: SpecModelDecision = {
      ...responseFor(catalog),
      candidates: [{ index: 0, runner: "pi", model: "pi-model", resources: { tools: { read: 0.95, bash: 0.95, executor_execute: 0.5, exec_command: 0.5 } } }],
    };
    const exclusions = [
      { field: "tools", name: "executor_execute", noul: 0.5 },
      { field: "tools", name: "exec_command", noul: 0.5 },
    ];
    const routerLog = vi.fn(async () => undefined) as LaunchRouterLog;
    const result = await execute(toolFor({
      catalog,
      cli: makeCli().cli,
      routerLog,
      specClient: { evaluate: vi.fn(async () => ({ kind: "response" as const, response })) },
    }), request({ specs: [spec({ instructions: "Use only the Bash tool for the git commands and only the Read tool for CONTEXT.md; use no other tool." })] }));

    expect(result.details).toMatchObject({ outcome: "launched", kind: "pi" });
    expect(routerLog).toHaveBeenCalledWith(expect.objectContaining({
      probabilities: response,
      result: expect.objectContaining({
        evidence: expect.objectContaining({ exclusions }),
        configuration: expect.objectContaining({ runtime: expect.objectContaining({ tools: ["read", "bash"] }) }),
      }),
    }), expect.anything());
  });

  it("retries the next chain candidate after a proven pre-spawn start failure", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "primary" }, { runner: "pi", model: "fallback" }]);
    const harness = makeCli({
      failedPane: { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", agent_status: "unknown" },
      start: (_argv, attempt) => {
        if (attempt === 0) throw new CliProtocolError("CLI_PROTOCOL_ERROR", "start failed", { exitCode: 1, killed: false, errorStream: "stderr", stderrTruncated: false, errorEnvelope: { id: "cli:agent:start", error: { code: "agent_start_failed", message: "agent process exited before becoming interactive" } } });
        return ok("start", { agent: { name: "task-worker-1", pane_id: "w1:p2", agent: "pi", terminal_id: "terminal-w1:p2", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-1" } } });
      },
    });
    const result = await execute(toolFor({ catalog, cli: harness.cli }), request());
    expect(result.details).toMatchObject({ spec: { selected: { model: "fallback" }, attempts: [{ outcome: "agent_start_failed" }, { outcome: "selected" }] } });
    expect(harness.calls.filter((call) => call[0] === "agent" && call[1] === "start")).toHaveLength(2);
  });

  it("preserves fallback_refused when authoritative pane state still has an agent", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "primary" }, { runner: "pi", model: "fallback" }]);
    const harness = makeCli({
      failedPane: { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", agent_status: "working", agent_name: "task-worker-1", agent: "pi" },
      start: () => { throw new CliProtocolError("CLI_PROTOCOL_ERROR", "start failed", { exitCode: 1, killed: false, errorStream: "stderr", stderrTruncated: false, errorEnvelope: { id: "cli:agent:start", error: { code: "agent_start_failed", message: "agent process exited before becoming interactive" } } }); },
    });
    await expect(execute(toolFor({ catalog, cli: harness.cli }), request())).rejects.toMatchObject({ details: { attempts: [{ outcome: "fallback_refused" }] } });
    expect(harness.calls.filter((call) => call[0] === "agent" && call[1] === "start")).toHaveLength(1);
  });

  it("does not duplicate a spawned but unacknowledged agent", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "primary" }, { runner: "pi", model: "fallback" }]);
    const harness = makeCli({ start: () => ok("start", { agent: { name: "unexpected", pane_id: "w1:p2", agent: "pi" } }) });
    await expect(execute(toolFor({ catalog, cli: harness.cli }), request())).rejects.toMatchObject({ code: "LAUNCH_FAILED" });
    expect(harness.calls.filter((call) => call[0] === "agent" && call[1] === "start")).toHaveLength(1);
  });

  it("prepares and binds one isolated worktree per replica", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const harness = makeCli();
    const isolated = worktrees();
    const result = await toolFor({ catalog, cli: harness.cli, worktrees: isolated.manager }).execute("call", request({ specs: [spec({ count: 2 })] }), new AbortController().signal, undefined, extensionContext);
    expect(result.details).toMatchObject({ operation: "launch_batch", outcome: "launched", children: [{ name: "task-worker-1", status: "launched" }, { name: "task-worker-2", status: "launched" }] });
    expect(isolated.prepare).toHaveBeenCalledTimes(2);
    expect(isolated.prepare.mock.calls.map(([value]) => value.childName)).toEqual(["task-worker-1", "task-worker-2"]);
    expect(isolated.prepare.mock.calls.every(([value]) => value.cwd === "/repo" && value.count === 2)).toBe(true);
    expect(harness.prompts).toHaveLength(2);
    expect(harness.prompts.every((prompt) => prompt.includes(SPEC_BASELINE))).toBe(true);
    expect(isolated.bindPane).toHaveBeenCalledTimes(2);
    expect(isolated.bindPane.mock.calls.map(([name]) => name)).toEqual(["task-worker-1", "task-worker-2"]);
    const children = (result.details as { children: Array<{ launch?: LaunchDetails }> }).children;
    expect(new Set(children.map((child) => child.launch?.handoff?.runId)).size).toBe(2);
    expect(new Set(children.map((child) => child.launch?.recipient?.recipientKey)).size).toBe(2);
  });

  it("retains expansion failures, partial children, and aborted tails", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const occupiedSnapshot = {
      version: "0.8.0", protocol: 22, workspaces: [{ workspace_id: "w1", label: "workspace", focused: true }], tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main", focused: true }], panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "caller", agent_status: "idle" }, { pane_id: "w1:p9", tab_id: "w1:t1", workspace_id: "w1", label: "occupied", agent_name: "task-worker-1", agent_status: "working" }], agents: [{ pane_id: "w1:p9", name: "task-worker-1", agent: "pi", agent_status: "working" }]
    } as HerdrSnapshot;
    const resolver = async () => ({ snapshot: occupiedSnapshot, context, diagnostics: { injected: context, effective: context, rebound: false, attempts: 1 }, operationIds: { current: "current", snapshot: "snapshot" } });
    const collision = await toolFor({ catalog, cli: makeCli().cli, contextResolver: resolver, worktrees: worktrees().manager }).execute("call", request({ specs: [spec({ count: 2 })] }), new AbortController().signal, undefined, extensionContext);
    expect(collision.details).toMatchObject({ outcome: "partial", children: [{ status: "failed", failure: { code: "BATCH_NAME_COLLISION" } }, { status: "launched" }] });
    const invalidPlacement = await toolFor({ catalog, cli: makeCli().cli }).execute("call", request({ specs: [spec({ count: 2 })], placement: { mode: "existing_pane", target: "w1:p1" } }), new AbortController().signal, undefined, extensionContext);
    expect(invalidPlacement.details).toMatchObject({ outcome: "failed", failure: { code: "BATCH_PLACEMENT_INVALID" } });
    const failedHarness = makeCli({
      failedPane: { pane_id: "w1:p3", tab_id: "w1:t1", workspace_id: "w1", agent_status: "unknown" },
      start: (_argv, attempt) => {
        if (attempt === 1) throw new CliProtocolError("CLI_PROTOCOL_ERROR", "start failed", { exitCode: 1, killed: false, errorStream: "stderr", stderrTruncated: false, errorEnvelope: { id: "cli:agent:start", error: { code: "agent_start_failed", message: "agent process exited before becoming interactive" } } });
        return ok("start", { agent: { name: "task-worker-1", pane_id: "w1:p2", agent: "pi", terminal_id: "terminal-w1:p2", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-0" } } });
      }
    });
    const partial = await toolFor({ catalog, cli: failedHarness.cli, worktrees: worktrees().manager }).execute("call", request({ specs: [spec({ count: 2 })] }), new AbortController().signal, undefined, extensionContext);
    expect(partial.details).toMatchObject({ outcome: "partial", children: [{ status: "launched" }, { status: "failed" }] });
    const abort = new AbortController();
    abort.abort();
    const abortedBatch = await toolFor({ catalog, cli: makeCli().cli }).execute("call", request({ specs: [spec({ count: 2 })] }), abort.signal, undefined, extensionContext);
    expect(abortedBatch.details).toMatchObject({ outcome: "failed", children: [{ status: "not_started", code: "ABORTED" }, { status: "not_started", code: "ABORTED" }] });
  });

  it("covers existing-pane, tab fallback, replica preconditions, and start recovery", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const targetSnapshot = {
      version: "0.8.0", protocol: 22, workspaces: [{ workspace_id: "w1", label: "workspace", focused: true }], tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main", focused: true }], panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "caller", agent_status: "idle" }, { pane_id: "w1:p9", tab_id: "w1:t1", workspace_id: "w1", label: "target", agent_status: "idle" }], agents: []
    } as HerdrSnapshot;
    const existingChild: Child = { paneId: "w1:p9", tabId: "w1:t1", name: "", kind: "pi", terminalId: "terminal-w1:p9", session: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-existing" }, prompt: false };
    const existingHarness = makeCli({ existingPane: existingChild });
    const existing = await execute(toolFor({ catalog, cli: existingHarness.cli, contextResolver: async () => ({ snapshot: targetSnapshot, context, diagnostics: { injected: context, effective: context, rebound: false, attempts: 1 }, operationIds: { current: "current", snapshot: "snapshot" } }) }), request({ placement: { mode: "existing_pane", target: "w1:p9" } }));
    expect(existing.details).toMatchObject({ placement: { mode: "existing_pane", target: "w1:p9" }, paneId: "w1:p9" });

    const tabHarness = makeCli({ tabWithoutPane: true });
    const tab = await execute(toolFor({ catalog, cli: tabHarness.cli }), request({ placement: { mode: "new_tab", tabLabel: "worker-tab" } }));
    expect(tab.details.tabId).toBe("w1:t2");
    expect(tabHarness.calls.some((call) => call[0] === "tab" && call[1] === "get")).toBe(true);
    const ownership = { record: vi.fn() };
    const splitHarness = makeCli({ splitWithoutTab: true });
    const split = await execute(toolFor({ catalog, cli: splitHarness.cli, ownership }), request());
    expect(split.details.tabId).toBe("w1:t1");
    expect(ownership.record).toHaveBeenCalledWith(expect.objectContaining({ kind: "pane", id: split.details.paneId }));
    const attachmentExisting = makeCli({ existingPane: { ...existingChild, name: "", prompt: false, session: { ...existingChild.session, value: "session-attachment" } } });
    const attachmentResult = await execute(toolFor({ catalog, cli: attachmentExisting.cli, contextResolver: async () => ({ snapshot: targetSnapshot, context, diagnostics: { injected: context, effective: context, rebound: false, attempts: 1 }, operationIds: { current: "current", snapshot: "snapshot" } }) }), request({ placement: { mode: "existing_pane", target: "w1:p9" }, assignmentDelivery: "attachment" }));
    expect(attachmentResult.details.attachment).toBeDefined();

    const noWorktree = await toolFor({ catalog: catalogOf([{ runner: "pi", model: "primary" }, { runner: "pi", model: "fallback" }]), cli: makeCli().cli }).execute("call", request({ specs: [spec({ count: 2 })] }), new AbortController().signal, undefined, extensionContext);
    expect(noWorktree.details).toMatchObject({ outcome: "failed", children: [{ status: "failed", failure: { code: "SPEC_NO_USABLE_CANDIDATE" } }, { status: "failed" }] });
    const prepared = worktrees();
    const reserveFailure = await toolFor({ catalog, cli: makeCli().cli, worktrees: prepared.manager, supervision: stubSupervision({ reserveError: new Error("reserve") }) }).execute("call", request({ specs: [spec({ count: 2 })] }), new AbortController().signal, undefined, extensionContext).catch((error) => error);
    expect(reserveFailure.details).toMatchObject({ outcome: "failed", children: [{ status: "failed", failure: { code: "SUPERVISION_UNAVAILABLE" } }, { status: "failed" }] });
    expect(prepared.release).toHaveBeenCalledTimes(2);
    expect(prepared.release).toHaveBeenCalledWith("task-worker-1");

    const genericStart = makeCli({ start: () => { throw new Error("start exploded"); } });
    await expect(execute(toolFor({ catalog, cli: genericStart.cli }), request())).rejects.toMatchObject({ code: "LAUNCH_FAILED" });
    const fallbackReadFailure = makeCli({
      paneError: new Error("pane read failed"),
      start: () => { throw new CliProtocolError("CLI_PROTOCOL_ERROR", "start failed", { exitCode: 1, killed: false, errorStream: "stderr", stderrTruncated: false, errorEnvelope: { id: "cli:agent:start", error: { code: "agent_start_failed", message: "agent process exited before becoming interactive" } } }); }
    });
    await expect(execute(toolFor({ catalog: catalogOf([{ runner: "pi", model: "primary" }, { runner: "pi", model: "fallback" }]), cli: fallbackReadFailure.cli }), request())).rejects.toMatchObject({ code: "POSTSTATE_UNAVAILABLE" });
    const nonErrorReadFailure = makeCli({ paneError: "pane read failed", start: () => { throw new CliProtocolError("CLI_PROTOCOL_ERROR", "start failed", { exitCode: 1, killed: false, errorStream: "stderr", stderrTruncated: false, errorEnvelope: { id: "cli:agent:start", error: { code: "agent_start_failed", message: "agent process exited before becoming interactive" } } }); } });
    await expect(execute(toolFor({ catalog: catalogOf([{ runner: "pi", model: "primary" }, { runner: "pi", model: "fallback" }]), cli: nonErrorReadFailure.cli }), request())).rejects.toMatchObject({ code: "POSTSTATE_UNAVAILABLE" });

    let busyAttempt = 0;
    const busy = makeCli({ start: () => {
      if (busyAttempt++ === 0) throw new CliProtocolError("CLI_PROTOCOL_ERROR", "busy", { exitCode: 1, killed: false, errorStream: "stderr", stderrTruncated: false, errorEnvelope: { id: "cli:agent:start", error: { code: "agent_pane_busy", message: "pane busy" } } });
      return ok("start", { agent: { name: "task-worker-1", pane_id: "w1:p2", agent: "pi", terminal_id: "terminal-w1:p2", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-1" } } });
    } });
    const busyResult = await execute(toolFor({ catalog, cli: busy.cli }), request());
    expect(busyResult.details.outcome).toBe("launched");
  });

  it("covers executor guards, abort fencing, expansion errors, and prepared cleanup", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const frozenRelease = vi.fn(async () => { throw new Error("release"); });
    await expect(toolFor({ catalog, cli: makeCli().cli, launchGate: async () => ({ check: vi.fn(async () => { throw new Error("frozen"); }), release: frozenRelease }) }).execute("call", request(), new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "LAUNCH_FROZEN" });
    expect(frozenRelease).toHaveBeenCalled();

    let gateCalls = 0;
    const childRelease = vi.fn(async () => { throw new Error("child release"); });
    await expect(toolFor({ catalog, cli: makeCli().cli, launchGate: async () => gateCalls++ === 0 ? { check: vi.fn(async () => undefined), release: vi.fn(async () => undefined) } : { check: vi.fn(async () => { throw new Error("child frozen"); }), release: childRelease } }).execute("call", request(), new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "LAUNCH_FROZEN" });
    expect(childRelease).toHaveBeenCalled();

    const snapshot = { version: "0.8.0", protocol: 22, workspaces: [{ workspace_id: "w1", label: "workspace", focused: true }], tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main", focused: true }], panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "caller", agent_status: "idle" }], agents: [] } as HerdrSnapshot;
    const abort = new AbortController();
    let resolverCalls = 0;
    await expect(toolFor({ catalog, cli: makeCli().cli, contextResolver: async () => { resolverCalls += 1; if (resolverCalls === 2) abort.abort("caller"); return { snapshot, context, diagnostics: { injected: context, effective: context, rebound: false, attempts: 1 }, operationIds: { current: "current", snapshot: "snapshot" } }; } }).execute("call", request(), abort.signal, undefined, extensionContext)).rejects.toMatchObject({ code: "ABORTED" });

    const expansionFailure = await toolFor({ catalog, cli: makeCli().cli, contextResolver: async () => { throw new Error("expand"); } }).execute("call", request(), new AbortController().signal, undefined, extensionContext);
    expect(expansionFailure.details).toMatchObject({ outcome: "failed", failure: { code: "CLI_PROTOCOL_ERROR" } });

    const isolated = worktrees();
    const splitFailure = await toolFor({ catalog, cli: makeCli({ splitError: new Error("split") }).cli, worktrees: isolated.manager }).execute("call", request({ specs: [spec({ count: 2 })] }), new AbortController().signal, undefined, extensionContext);
    expect(splitFailure.details).toMatchObject({ outcome: "failed", children: [{ status: "failed" }, { status: "failed" }] });
    expect(isolated.release).toHaveBeenCalledWith("task-worker-1");
  });

  it("covers pre-spawn compile/source fallback and existing-pane reconciliation", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "primary" }, { runner: "pi", model: "fallback" }]);
    const invalidFallbackResponse = responseFor(catalog);
    const invalidFallbackCandidates = invalidFallbackResponse.candidates as unknown as Array<Record<string, unknown>>;
    invalidFallbackCandidates[1]!.resources = { tools: ["forbidden"] };
    const compiledFallback = await execute(toolFor({ catalog, cli: makeCli().cli, specClient: { evaluate: vi.fn(async () => ({ kind: "response" as const, response: invalidFallbackResponse })) } }), request());
    expect(compiledFallback.details.spec!.attempts).toEqual(expect.arrayContaining([expect.objectContaining({ candidate: expect.objectContaining({ model: "fallback" }), outcome: "agent_start_failed" })]));

    const promptSources = { create: vi.fn().mockRejectedValueOnce(new Error("prompt source unavailable")).mockResolvedValue({ path: "/tmp/prompt-source" }) };
    const sourceFallback = await execute(toolFor({ catalog, cli: makeCli().cli, promptSources }), request());
    expect(sourceFallback.details.spec!.attempts).toEqual(expect.arrayContaining([expect.objectContaining({ candidate: expect.objectContaining({ model: "primary" }), outcome: "agent_start_failed" }), expect.objectContaining({ outcome: "selected" })]));

    await expect(execute(toolFor({ catalog: catalogOf([{ runner: "pi", model: "pi-model" }]), cli: makeCli().cli, supervision: stubSupervision({ bindError: new Error("bind transport") }) }), request())).rejects.toMatchObject({ code: "LAUNCH_FAILED" });

    const targetSnapshot = { version: "0.8.0", protocol: 22, workspaces: [{ workspace_id: "w1", label: "workspace", focused: true }], tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main", focused: true }], panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "caller", agent_status: "idle" }, { pane_id: "w1:p9", tab_id: "w1:t1", workspace_id: "w1", label: "target", agent_status: "idle" }], agents: [] } as HerdrSnapshot;
    const existingChild: Child = { paneId: "w1:p9", tabId: "w1:t1", name: "", kind: "pi", terminalId: "terminal-w1:p9", session: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-existing" }, prompt: false };
    const existingFailure = makeCli({ existingPane: existingChild, start: () => { throw new Error("existing pane start"); } });
    await expect(execute(toolFor({ catalog: catalogOf([{ runner: "pi", model: "pi-model" }]), cli: existingFailure.cli, contextResolver: async () => ({ snapshot: targetSnapshot, context, diagnostics: { injected: context, effective: context, rebound: false, attempts: 1 }, operationIds: { current: "current", snapshot: "snapshot" } }) }), request({ placement: { mode: "existing_pane", target: "w1:p9" } }))).rejects.toMatchObject({ details: { created: { paneId: "w1:p9", tabId: "w1:t1" } } });
    const readinessId = makeCli({ agentId: "agent-from-readback", readinessError: new Error("readiness failed"), start: () => ok("start", { agent: { name: "task-worker-1", pane_id: "w1:p2", agent: "pi", terminal_id: "terminal-w1:p2", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-0" } } }) });
    await expect(execute(toolFor({ catalog: catalogOf([{ runner: "pi", model: "pi-model" }]), cli: readinessId.cli }), request())).rejects.toMatchObject({ details: { created: { agentId: "agent-from-readback" }, reconciliation: { effectCertainty: "partial" } } });

    const emptySnapshot = { version: "0.8.0", protocol: 22, workspaces: [{ workspace_id: "w1", label: "workspace", focused: true }], tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main", focused: true }], panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "caller", agent_status: "idle" }], agents: [] } as HerdrSnapshot;
    const nameOccupied = { ...emptySnapshot, panes: [...emptySnapshot.panes, { pane_id: "w1:p9", tab_id: "w1:t1", workspace_id: "w1", label: "task-worker-1", agent_status: "idle" }] } as HerdrSnapshot;
    let nameChecks = 0;
    await expect(toolFor({ catalog: catalogOf([{ runner: "pi", model: "pi-model" }]), cli: makeCli().cli, contextResolver: async () => ({ snapshot: nameChecks++ === 0 ? emptySnapshot : nameOccupied, context, diagnostics: { injected: context, effective: context, rebound: false, attempts: 1 }, operationIds: { current: "current", snapshot: "snapshot" } }) }).execute("call", request(), new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "BATCH_NAME_COLLISION" });
    const labelOccupied = { ...emptySnapshot, panes: [...emptySnapshot.panes, { pane_id: "w1:p9", tab_id: "w1:t1", workspace_id: "w1", label: "batch-worker-1", agent_status: "idle" }] } as HerdrSnapshot;
    let labelChecks = 0;
    await expect(toolFor({ catalog: catalogOf([{ runner: "pi", model: "pi-model" }]), cli: makeCli().cli, contextResolver: async () => ({ snapshot: labelChecks++ === 0 ? emptySnapshot : labelOccupied, context, diagnostics: { injected: context, effective: context, rebound: false, attempts: 1 }, operationIds: { current: "current", snapshot: "snapshot" } }) }).execute("call", request({ label: "batch" }), new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "BATCH_NAME_COLLISION" });

    let throwBaseline = false;
    const baselinePanes = [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "caller", agent_status: "idle" }];
    const throwingBaseline = { version: "0.8.0", protocol: 22, workspaces: [{ workspace_id: "w1", label: "workspace", focused: true }], tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main", focused: true }], get panes() { if (throwBaseline) throw new Error("baseline readback"); return baselinePanes; }, agents: [] } as HerdrSnapshot;
    const reconciliationFailure = makeCli({ start: () => { throwBaseline = true; throw new Error("start after baseline"); } });
    await expect(execute(toolFor({ catalog: catalogOf([{ runner: "pi", model: "pi-model" }]), cli: reconciliationFailure.cli, contextResolver: async () => ({ snapshot: throwingBaseline, context, diagnostics: { injected: context, effective: context, rebound: false, attempts: 1 }, operationIds: { current: "current", snapshot: "snapshot" } }) }), request())).rejects.toMatchObject({ details: { reconciliation: { effectCertainty: "unknown", snapshot: "unavailable" } } });
  });

  it("covers prompt dispatch, acknowledgement, and confirmation failures", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const dispatchFailure = makeCli({ prompt: () => { throw Object.assign(new Error("dispatch"), { details: { promptDispatch: { state: "rejected", requestId: "req-1" } } }); } });
    await expect(execute(toolFor({ catalog, cli: dispatchFailure.cli }), request())).rejects.toMatchObject({ code: "LAUNCH_FAILED", details: { promptDispatch: { state: "rejected", requestId: "req-1" } } });
    const invalidAcknowledgement = makeCli({ prompt: () => ok("prompt", { invalid: true }) });
    await expect(execute(toolFor({ catalog, cli: invalidAcknowledgement.cli }), request())).rejects.toMatchObject({ code: "LAUNCH_FAILED", details: { promptDispatch: { state: "unknown", requestId: "prompt" } } });
    const confirmationFailure = makeCli({ agentError: new Error("poststate") });
    await expect(execute(toolFor({ catalog, cli: confirmationFailure.cli }), request())).rejects.toMatchObject({ code: "LAUNCH_FAILED", details: { causeCode: "PROMPT_UNCONFIRMED", assignmentState: "unconfirmed" } });
    for (const state of ["not_written", "acknowledged", "unknown", "other"]) {
      const malformedDispatch = makeCli({ prompt: () => { throw Object.assign(new Error("dispatch state"), { details: { promptDispatch: { state, requestId: "bad\n" } } }); } });
      await expect(execute(toolFor({ catalog, cli: malformedDispatch.cli }), request())).rejects.toMatchObject({ code: "LAUNCH_FAILED" });
    }
    const malformedDetails = makeCli({ prompt: () => { throw Object.assign(new Error("dispatch details"), { details: "bad" }); } });
    await expect(execute(toolFor({ catalog, cli: malformedDetails.cli }), request())).rejects.toMatchObject({ code: "LAUNCH_FAILED" });
  });

  it("covers labeled batch siblings and mixed admitted decisions", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const updates = vi.fn();
    const labeledTool = toolFor({ catalog, cli: makeCli().cli });
    const labeled = await labeledTool.execute("call", request({ label: "batch", specs: [spec(), spec({ label: "review" })] }), new AbortController().signal, updates, extensionContext);
    expect(labeled.details).toMatchObject({ outcome: "launched", children: [{ name: "task-worker-1", status: "launched" }, { name: "task-review-1", status: "launched" }] });
    expect(labeledTool.renderResult?.(labeled as never, {} as never, {} as never, {} as never)).toBeDefined();
    expect(updates).toHaveBeenCalled();
    const mixedSpecClient = { evaluate: vi.fn(async ({ spec: current }: { spec: LaunchSpec }) => current.label === "review" ? { kind: "response" as const, response: responseFor(catalog, { instructions_adequate: 0.1, assignment_verifiable: 0.1 }) } : { kind: "response" as const, response: responseFor(catalog) }) };
    const mixed = await toolFor({ catalog, cli: makeCli().cli, specClient: mixedSpecClient }).execute("call", request({ specs: [spec(), spec({ label: "review" })] }), new AbortController().signal, undefined, extensionContext);
    expect(mixed.details).toMatchObject({ outcome: "launched", children: [{ specLabel: "worker", status: "launched" }] });
  });

  it("covers AGY, Devin, agent identity, and supervision-bind lifecycle branches", async () => {
    const agyCatalog = parseCatalog(`version: 1
categories:
  worker:
    - {runner: agy, model: agy-model}
runners:
  agy:
    models: [agy-model]
    quota: {provider: google, billingProduct: antigravity, account: primary, scope: account}
    defaults: {mode: plan, timeoutMinutes: 30, sessionPersistence: true}
    plumbing: {sessionPersistence: required, promptDelivery: bootstrap, skillSelection: ambient, toolSelection: ambient}
skills: []
plugins: []
mcp: {}
quotaSources:
  - {name: reactive-cooldowns, kind: floor}
`, { path: "/tmp/agy-catalog.yaml", scopeRoot: "/tmp" });
    const agyHarness = makeCli({ agentId: "agy-agent", prompt: () => ok("prompt", { type: "agent_prompted", agent: { name: "task-worker-1", pane_id: "w1:p2", agent: "agy", terminal_id: "terminal-w1:p2", agent_session: { source: "herdr:agy", agent: "agy", kind: "id", value: "session-0" }, agent_status: "working", state_change_seq: 8, revision: 4, interactive_ready: true } }) });
    const agySupervision = stubSupervision();
    const agyResult = await execute(toolFor({ catalog: agyCatalog, cli: agyHarness.cli, supervision: agySupervision }), request());
    expect(agyResult.details).toMatchObject({ kind: "agy", supervision: { state: "active" } });
    expect(agySupervision.provisionalBindAttempts).toHaveLength(1);
    expect(agySupervision.strengthenAttempts).toHaveLength(1);
    await expect(execute(toolFor({ catalog: agyCatalog, cli: makeCli().cli, supervision: stubSupervision({ strengthenError: new Error("strengthen transport") }) }), request())).rejects.toMatchObject({ code: "LAUNCH_FAILED" });
    const managerAgy = makeCli({ prompt: () => ok("prompt", { type: "agent_prompted", agent: { name: "task-manager-1", pane_id: "w1:p2", agent: "agy", terminal_id: "terminal-w1:p2", agent_session: { source: "herdr:agy", agent: "agy", kind: "id", value: "session-0" }, agent_status: "working", state_change_seq: 8, revision: 4, interactive_ready: true } }) });
    await expect(execute(toolFor({ catalog: agyCatalog, cli: managerAgy.cli }), request({ specs: [spec({ label: "manager" })] }))).resolves.toMatchObject({ details: { name: "task-manager-1" } });

    const devinCatalog = parseCatalog(`version: 1
categories:
  worker:
    - {runner: devin, model: devin-model}
runners:
  devin:
    models: [devin-model]
    quota: {provider: cognition, billingProduct: devin, account: primary, scope: account}
    defaults: {permissionMode: dangerous, timeoutMinutes: 30, sessionPersistence: true}
    plumbing: {sessionPersistence: required, promptDelivery: none, skillSelection: ambient, toolSelection: ambient}
skills: []
plugins: []
mcp: {}
quotaSources:
  - {name: reactive-cooldowns, kind: floor}
`, { path: "/tmp/devin-catalog.yaml", scopeRoot: "/tmp" });
    const lease = { release: vi.fn(async () => undefined) };
    const queueFlush = { writeSection: vi.fn(async () => lease) };
    const devin = await execute(toolFor({ catalog: devinCatalog, cli: makeCli().cli, queueFlush: queueFlush as unknown as LaunchDependencies["queueFlush"] }), request());
    expect(devin.details.kind).toBe("devin");
    expect(queueFlush.writeSection).toHaveBeenCalledWith("w1:p2");
    expect(lease.release).toHaveBeenCalled();

    const withId = makeCli({ start: () => ok("start", { agent: { name: "task-worker-1", pane_id: "w1:p2", agent: "pi", terminal_id: "terminal-w1:p2", agent_id: "agent-1", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-0" } } }) });
    const idResult = await execute(toolFor({ catalog: catalogOf([{ runner: "pi", model: "pi-model" }]), cli: withId.cli }), request());
    expect(idResult.details.agentId).toBe("agent-1");

    const bindFailure = new SupervisionBindError("bind failed", { cause: "test" });
    await expect(execute(toolFor({ catalog: catalogOf([{ runner: "pi", model: "pi-model" }]), cli: makeCli().cli, supervision: stubSupervision({ bindError: bindFailure }) }), request())).rejects.toMatchObject({ code: "LAUNCH_FAILED", details: { causeCode: "SUPERVISION_UNCONFIRMED" } });
  });

  it("appends one decision per spec before child mutation", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const harness = makeCli();
    const routerLog = vi.fn(async () => undefined) as LaunchRouterLog;
    const tool = toolFor({ catalog, cli: harness.cli, routerLog });
    await tool.execute("call", request({ specs: [spec({ label: "worker" }), spec({ label: "review" })] }), new AbortController().signal, undefined, extensionContext).catch(() => undefined);
    expect(routerLog).toHaveBeenCalledTimes(2);
    expect(harness.calls.findIndex((call) => call[0] === "pane" && call[1] === "split")).toBeGreaterThanOrEqual(0);
  });

  it("covers routing failures, placement modes, focus, and attachment delivery", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const abstained = await toolFor({ catalog, cli: makeCli().cli, catalogLoad: async () => { throw new Error("catalog unavailable"); } }).execute("call", request(), new AbortController().signal, undefined, extensionContext);
    expect(abstained.details).toMatchObject({ operation: "launch_batch", outcome: "abstained", router: [{ kind: "abstained", reason: "catalog_unavailable" }] });
    const transportFailure = await toolFor({ catalog, cli: makeCli().cli, specClient: { evaluate: vi.fn(async () => { throw new Error("transport"); }) } }).execute("call", request(), new AbortController().signal, undefined, extensionContext);
    expect(transportFailure.details).toMatchObject({ outcome: "abstained", router: [{ reason: "transport_failed", receipt: expect.any(String) }] });
    const token = (transportFailure.details as { router: Array<{ receipt?: string }> }).router[0]!.receipt!;
    const uncategorized = await toolFor({ catalog, cli: makeCli().cli, specClient: { evaluate: vi.fn(async () => { throw new Error("transport"); }) } }).execute("call", request({ specs: [spec({ category: undefined })] }), new AbortController().signal, undefined, extensionContext);
    expect(uncategorized.details).toMatchObject({ outcome: "abstained", router: [{ reason: "transport_failed", receipt: expect.any(String) }] });
    const noCategories = await toolFor({ catalog: { ...catalog, categories: new Map() }, cli: makeCli().cli, specClient: { evaluate: vi.fn(async () => { throw new Error("transport"); }) } }).execute("call", request({ specs: [spec({ category: undefined })] }), new AbortController().signal, undefined, extensionContext);
    expect(noCategories.details).toMatchObject({ outcome: "abstained", router: [{ reason: "transport_failed" }] });
    expect((noCategories.details as { router: Array<{ receipt?: string }> }).router[0]!.receipt).toBeUndefined();
    const replayEvaluate = vi.fn(async () => { throw new Error("replay must not evaluate"); });
    const replayLog = vi.fn(async () => undefined) as LaunchRouterLog;
    const replay = await execute(toolFor({ catalog, cli: makeCli().cli, specClient: { evaluate: replayEvaluate }, routerLog: replayLog }), request({ transportBypass: token }));
    expect(replayEvaluate).not.toHaveBeenCalled();
    expect(replay.details).toMatchObject({ outcome: "launched", spec: { quality: "not_evaluated", bypass: { label: "transport-abstain", quality: "not_evaluated" } } });
    expect(replayLog).toHaveBeenCalledWith(expect.objectContaining({ result: expect.objectContaining({ kind: "admitted", quality: "not_evaluated", evidence: expect.objectContaining({ bypass: { label: "transport-abstain", quality: "not_evaluated" } }) }) }), expect.anything());
    const fallbackCatalog = catalogOf([{ runner: "pi", model: "primary" }, { runner: "pi", model: "fallback" }]);
    const fallbackSource = await toolFor({ catalog: fallbackCatalog, cli: makeCli().cli, specClient: { evaluate: vi.fn(async () => { throw new Error("transport"); }) } }).execute("call", request(), new AbortController().signal, undefined, extensionContext);
    const fallbackToken = (fallbackSource.details as { router: Array<{ receipt?: string }> }).router[0]!.receipt!;
    const fallbackHarness = makeCli({
      failedPane: { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", agent_status: "unknown" },
      start: (_argv, attempt) => {
        if (attempt === 0) throw new CliProtocolError("CLI_PROTOCOL_ERROR", "start failed", { exitCode: 1, killed: false, errorStream: "stderr", stderrTruncated: false, errorEnvelope: { id: "cli:agent:start", error: { code: "agent_start_failed", message: "agent process exited before becoming interactive" } } });
        return ok("start", { agent: { name: "task-worker-1", pane_id: "w1:p2", agent: "pi", terminal_id: "terminal-w1:p2", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-1" } } });
      },
    });
    const fallbackReplay = await execute(toolFor({ catalog: fallbackCatalog, cli: fallbackHarness.cli, specClient: { evaluate: replayEvaluate } }), request({ transportBypass: fallbackToken }));
    expect(fallbackReplay.details.spec).toMatchObject({ selected: { model: "fallback" }, attempts: [{ outcome: "agent_start_failed" }, { outcome: "selected" }] });
    const foreign = await toolFor({ catalog, cli: makeCli().cli, specClient: { evaluate: replayEvaluate } }).execute("call", request({ name: "other", transportBypass: token }), new AbortController().signal, undefined, extensionContext);
    expect(foreign.details).toMatchObject({ outcome: "abstained", router: [{ kind: "abstained", reason: "invalid_response", component: "bypass" }], children: [] });
    const malformed = await toolFor({ catalog, cli: makeCli().cli, specClient: { evaluate: replayEvaluate } }).execute("call", request({ transportBypass: "not-json" }), new AbortController().signal, undefined, extensionContext);
    expect(malformed.details).toMatchObject({ outcome: "abstained", router: [{ kind: "abstained", reason: "invalid_response", component: "bypass" }], children: [] });
    const invalidResponse = await toolFor({ catalog, cli: makeCli().cli, specClient: { evaluate: vi.fn(async () => ({ kind: "response" as const, response: undefined as never })) } }).execute("call", request(), new AbortController().signal, undefined, extensionContext);
    expect(invalidResponse.details).toMatchObject({ outcome: "abstained", router: [{ reason: "invalid_response" }] });
    const logFailure = await toolFor({ catalog, cli: makeCli().cli, routerLog: vi.fn(async () => { throw new Error("log"); }) as LaunchRouterLog }).execute("call", request(), new AbortController().signal, undefined, extensionContext);
    expect(logFailure.details).toMatchObject({ outcome: "failed", failure: { code: "ROUTER_LOG_UNAVAILABLE" } });
    const preflight = await toolFor({ catalog, cli: makeCli().cli, preflight: async () => { throw Object.assign(new Error("preflight"), { code: "PREFLIGHT_FAILED" }); } }).execute("call", request(), new AbortController().signal, undefined, extensionContext).catch((error) => error);
    expect(preflight).toMatchObject({ code: "PREFLIGHT_FAILED", details: { phase: "validate" } });
    const harness = makeCli();
    const placed = await execute(toolFor({ catalog, cli: harness.cli }), request({ placement: { mode: "new_tab", tabLabel: "worker-tab" }, focus: true, assignmentDelivery: "attachment" }));
    expect(placed.details).toMatchObject({ placement: { mode: "new_tab", tabLabel: "worker-tab-worker-1" }, attachment: { attachmentId: "attachment" } });
    expect(harness.calls.some((call) => call[0] === "tab" && call[1] === "create")).toBe(true);
    expect(harness.calls.some((call) => call[0] === "agent" && call[1] === "focus")).toBe(true);
  });

  it("times out and logs a hung spec evaluation without starting a child", async () => {
    vi.useFakeTimers();
    try {
      const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
      const harness = makeCli();
      const routerLog = vi.fn(async () => undefined) as LaunchRouterLog;
      const evaluate = vi.fn(async () => new Promise<never>(() => undefined));
      const tool = toolFor({ catalog, cli: harness.cli, routerLog, specClient: { evaluate } });
      const pending = tool.execute("call", request(), new AbortController().signal, undefined, extensionContext);
      await vi.waitFor(() => expect(evaluate).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(20_000);
      const result = await pending;
      expect(routerLog).toHaveBeenCalledWith(expect.objectContaining({ result: { kind: "abstained", reason: "transport_failed", component: "evaluation" } }), expect.objectContaining({ root: "/repo" }));
      expect(result.details).toMatchObject({ operation: "launch_batch", outcome: "abstained", router: [{ kind: "abstained", reason: "transport_failed", component: "evaluation" }], children: [] });
      expect(harness.children).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("loads the shipped catalog when the project cwd has no catalog", async () => {
    let loaded: Catalog | undefined;
    const tool = createLaunchTool({
      cli: makeCli().cli,
      context,
      cwd: "/tmp/project-without-a-catalog",
      preflight: async () => undefined,
      supervision: stubSupervision(),
      specClient: {
        evaluate: vi.fn(async ({ catalog }) => {
          loaded = catalog;
          return {
            kind: "response" as const,
            response: {
              quality: { instructions_adequate: 0.1, assignment_verifiable: 0.1 },
              category: { category: "frontier", confidence: 0.95 },
              candidates: [],
            },
          };
        }),
      },
      routerLog: vi.fn(async () => undefined) as LaunchRouterLog,
    });
    const result = await tool.execute("call", request({ specs: [spec({ category: "frontier" })] }), new AbortController().signal, undefined, extensionContext);
    expect(loaded?.categories.has("frontier")).toBe(true);
    expect(result.details).toMatchObject({ operation: "launch_batch", outcome: "abstained", router: [{ kind: "rejected", quality: "rejected" }] });
    expect(result.details).not.toMatchObject({ router: [{ reason: "catalog_unavailable" }] });
  });

  it("rechecks the child gate and rejects an unavailable prompt transport", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const gate = { check: vi.fn(async () => undefined), release: vi.fn(async () => undefined) };
    gate.check.mockImplementationOnce(async () => undefined).mockImplementationOnce(async () => { throw new Error("frozen after routing"); });
    await expect(toolFor({ catalog, cli: makeCli().cli, launchGate: async () => gate }).execute("call", request(), new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "LAUNCH_FROZEN" });
    const harness = makeCli();
    const noPrompt = { runJson: harness.cli.runJson } as unknown as LaunchCli;
    await expect(toolFor({ catalog, cli: noPrompt }).execute("call", request(), new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "CLI_INCOMPATIBLE" });
  });

  it("cannot bypass the freeze gate", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const harness = makeCli();
    const gate = { check: vi.fn(async () => { throw new Error("frozen"); }), release: vi.fn(async () => undefined) };
    await expect(toolFor({ catalog, cli: harness.cli, launchGate: async () => gate }).execute("call", request(), new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "LAUNCH_FROZEN" });
    expect(harness.calls).toEqual([]);
    expect(gate.release).toHaveBeenCalled();
  });

  it("retains precondition failures, reservation failures, worktree failures, and provenance warnings", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const reservation = stubSupervision({ reserveError: new Error("reserve failed") });
    const reserveHarness = makeCli();
    await expect(execute(toolFor({ catalog, cli: reserveHarness.cli, supervision: reservation }), request())).rejects.toMatchObject({ code: "SUPERVISION_UNAVAILABLE", details: { phase: "supervision_reserve" } });
    expect(reserveHarness.calls.some((call) => call[0] === "pane" && call[1] === "split")).toBe(false);
    await expect(execute(toolFor({ catalog, cli: makeCli().cli, supervision: stubSupervision({ reserveError: Object.assign(new Error("coded reserve"), { code: "RESERVE_CODE" }) }) }), request())).rejects.toMatchObject({ code: "SUPERVISION_UNAVAILABLE", details: { causeCode: "RESERVE_CODE" } });
    const release = vi.fn(async () => undefined);
    const grant = { path: "/tmp/grant", token: "token", renew: vi.fn(async () => undefined), release };
    const publishFailure: AttachmentStore = { ...fakeAttachments(), ensureRecipient: vi.fn(async () => grant), publish: vi.fn(async () => { throw new Error("publish failed"); }) };
    await expect(execute(toolFor({ catalog, cli: makeCli().cli, attachments: publishFailure }), request({ assignmentDelivery: "attachment" }))).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR", details: { phase: "attachment_publish" } });
    expect(release).toHaveBeenCalled();
    const metadataHarness = makeCli({ metadataError: new Error("metadata failed") });
    const warned = await execute(toolFor({ catalog, cli: metadataHarness.cli }), request({ specs: [spec({ label: "manager" })] }));
    expect(warned.details.provenanceWarning).toContain("metadata failed");
    const failingWorktrees = worktrees();
    failingWorktrees.prepare.mockImplementation(async () => { throw new Error("prepare failed"); });
    const worktreeFailure = await toolFor({ catalog, cli: makeCli().cli, worktrees: failingWorktrees.manager }).execute("call", request({ specs: [spec({ count: 2 })] }), new AbortController().signal, undefined, extensionContext);
    expect(failingWorktrees.prepare).toHaveBeenCalledTimes(2);
    expect(worktreeFailure.details).toMatchObject({ outcome: "failed", children: [{ status: "failed" }, { status: "failed" }] });
    const retryWorktrees = worktrees();
    retryWorktrees.prepare.mockImplementationOnce(async () => { throw new Error("first worktree failed"); });
    const retryHarness = makeCli();
    const retryResult = await toolFor({ catalog: catalogOf([{ runner: "pi", model: "primary" }, { runner: "pi", model: "fallback" }]), cli: retryHarness.cli, worktrees: retryWorktrees.manager }).execute("call", request({ specs: [spec({ count: 2 })] }), new AbortController().signal, undefined, extensionContext);
    expect(retryResult.details).toMatchObject({ outcome: "launched" });
    expect((retryResult.details as { children: Array<unknown> }).children[0]).toMatchObject({ status: "launched", launch: { spec: { selected: { model: "fallback" }, attempts: [{ outcome: "agent_start_failed" }, { outcome: "selected" }] } } });
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

  it("renders spec calls and launch results", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const harness = makeCli();
    const tool = toolFor({ catalog, cli: harness.cli });
    const call = tool.renderCall?.(request(), {} as never, {} as never);
    expect(call).toBeDefined();
    const result = await execute(tool, request());
    const rendered = tool.renderResult?.(result, {} as never, {} as never, {} as never);
    expect(rendered).toBeDefined();
  });

  it("covers remaining defensive identity and reconciliation projections", async () => {
    const i = launchTestInternals as unknown as UnsafeLaunchInternals;
    const bypassCatalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const piResolved = { index: 0, candidate: { runner: "pi" as const, model: "pi-model" }, runner: bypassCatalog.runners.get("pi")! };
    expect(i.allReviewedResources(piResolved)).toMatchObject({ tools: ["read"], extensions: [], skills: [], mcp: [] });
    expect(i.allReviewedResources({ ...piResolved, runner: { ...piResolved.runner, kind: "claude" } })).toMatchObject({ tools: ["read"], plugins: [], mcp: [] });
    expect(i.allReviewedResources({ ...piResolved, runner: { ...piResolved.runner, kind: "agy" } })).toEqual({});
    await expect(i.transportBypassConfiguration(spec({ category: undefined }), { ...bypassCatalog, categories: new Map() })).resolves.toBeUndefined();
    await expect(i.transportBypassConfiguration(spec(), { ...bypassCatalog, categories: new Map() })).resolves.toBeUndefined();
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
    expect(i.normalizedParams(request()).specs[0].count).toBe(1);
    expect(i.normalizedParams(request({ specs: [spec({ count: undefined })] })).specs[0].count).toBe(1);
    expect(i.specPayload(spec({ label: "worker" }))).toContain("Reduce the latency");
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
    expect(i.existingAgentNames({ ...baseline, agents: [{ name: "agent" }], panes: [{ ...baseline.panes[0], label: "label", agent: "pane-agent" }] })).toEqual(["agent", "pane-agent"]);
    expect(i.existingNameTargets({ ...baseline, agents: [{ name: "agent" }], panes: [{ ...baseline.panes[0], label: "label", agent: "pane-agent" }] })).toEqual(new Set(["agent", "pane-agent", "label"]));
    expect(i.existingNameTargets({ ...baseline, agents: [{}], panes: [{ ...baseline.panes[0], label: "", agent: 1 }] })).toEqual(new Set());
    expect(i.paneForPlacement(baseline, "p", context)).toMatchObject({ paneId: "p", tabId: "t" });
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
    expect(i.batchChildFailure(new Error("child failure"))).toMatchObject({ code: "CLI_PROTOCOL_ERROR", details: { causeMessage: "child failure" } });
    expect(i.batchChildFailure(Object.assign(new Error("child"), { code: "CHILD", details: { created: { paneId: "p" } } }))).toMatchObject({ code: "CHILD", details: { created: { paneId: "p" } } });
    expect(i.batchManifest({ operation: "launch_batch", outcome: "partial", router: [{ kind: "abstained", reason: "x", component: "y" }], children: [{ name: "task-worker-1", specLabel: "worker", ordinal: 1, status: "failed", code: "CHILD", failure: { code: "CHILD", details: { paneId: "p", supervisorJobId: "j" } } }] })).toContain("supervisor=j");
    expect(i.candidateIdentity({ index: 1, runner: "pi", model: "m" })).toEqual({ index: 1, runner: "pi", model: "m" });
    expect(i.candidateKey({ index: 1, runner: "pi", model: "m" })).toBe("1:pi:m");
    expect(i.resolvedCandidateIdentity({ index: 1, candidate: { runner: "pi", model: "m" } })).toEqual({ index: 1, runner: "pi", model: "m" });
    expect(i.resolvedCandidateKey({ index: 1, candidate: { runner: "pi", model: "m" } })).toBe("1:pi:m");
    expect(i.isAdmitted({ kind: "admitted" })).toBe(true);
    expect(i.isAdmitted({ kind: "abstained" })).toBe(false);
    expect(i.recipientCapability("pi")).toMatchObject({ kind: "pi", capable: true });
    expect(i.recipientCapability("devin")).toMatchObject({ kind: "devin", capable: true });
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    expect(i.specRouterState(spec(), catalog).catalog).toHaveLength(1);
    expect(i.specRouteLogEntry("task", { spec: spec(), decision: { kind: "abstained", reason: "x", component: "y" } })).toMatchObject({ caller: "task", name: "task" });
    const updates: unknown[] = [];
    i.progress((update: unknown) => updates.push(update), "ready", { paneId: "p" });
    i.progress(undefined, "focus", {});
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
    expect(i.partialError(new Error("\0"), {}, "focus", grant, { agentStarted: false, promptSubmitted: false, recipientRegistered: false, mutationDispatched: false, timing: {}, attempts: [] })).toMatchObject({ code: "LAUNCH_FAILED" });
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
    const tool = createLaunchTool({ cli: cli.cli, context, preflight: async () => undefined, supervision: stubSupervision(), specClient: { evaluate: vi.fn(async () => ({ kind: "response" as const, response: responseFor(catalog) })) }, catalog: { load: async () => catalog }, routerLog: vi.fn(async () => undefined) as LaunchRouterLog });
    const result = await tool.execute("call", request(), undefined, undefined, { cwd: "/repo", signal: undefined } as unknown as ExtensionContext);
    expect(result.details).toMatchObject({ operation: "launch", outcome: "launched" });
    const executableCli = makeCli();
    Object.assign(executableCli.cli, { exec: vi.fn() });
    createLaunchTool({ cli: executableCli.cli, context, preflight: async () => undefined, supervision: stubSupervision(), catalog: { load: async () => catalog } });
    createLaunchTool({ cli: executableCli.cli, context, preflight: async () => undefined, supervision: stubSupervision(), catalog: { load: async () => catalog }, selfClose: { onPaneClosed: vi.fn() } as unknown as NonNullable<LaunchDependencies["selfClose"]> });
  });

  it("covers router availability and compile error projections", async () => {
    const catalog = catalogOf([{ runner: "pi", model: "pi-model" }]);
    const input = { spec: spec(), catalog, response: responseFor(catalog), root: "/tmp", availability: async () => ({ status: "unknown", retryNotBefore: null, evidence: { records: 0 } }), compile: async () => { throw new Error("compile unavailable"); } };
    await expect(routeSpec(input as never)).resolves.toMatchObject({ kind: "abstained", reason: "catalog_unavailable", component: "configuration" });
    const unavailable = { ...input, availability: async () => { throw new Error("availability unavailable"); }, compile: async () => ({}) };
    await expect(routeSpec(unavailable as never)).resolves.toMatchObject({ kind: "abstained", reason: "transport_failed", component: "availability" });
    const throwingResponse = new Proxy(responseFor(catalog), { get() { throw new Error("routing response access"); } });
    const launchRouting = await toolFor({ catalog, cli: makeCli().cli, specClient: { evaluate: vi.fn(async () => ({ kind: "response" as const, response: throwingResponse })) } }).execute("call", request(), new AbortController().signal, undefined, extensionContext);
    expect(launchRouting.details).toMatchObject({ outcome: "abstained", router: [{ reason: "invalid_response", component: "routing" }] });
    const aborted = new AbortController();
    aborted.abort("caller");
    const abortedTool = toolFor({ catalog, cli: makeCli().cli, specClient: { evaluate: vi.fn(async () => { throw new Error("transport"); }) } });
    const abortedResult = await abortedTool.execute("call", request(), aborted.signal, undefined, extensionContext);
    expect(abortedResult.details).toMatchObject({ outcome: "abstained", router: [{ reason: "aborted" }] });
  });

  it("covers diagnostic, batch-manifest, and route-state projections", () => {
    const i = launchTestInternals as unknown as UnsafeLaunchInternals;
    const grant = { path: "/tmp/grant", token: "token", renew: vi.fn(), release: vi.fn() };
    const cliError = new CliProtocolError("CLI_PROTOCOL_ERROR", "cli failure", { exitCode: 1, killed: false, errorStream: "stderr", stderrTruncated: false, errorEnvelope: { id: "cli:agent:start", error: { code: "agent_start_failed", message: "failed" } } });
    expect(i.cliFailureEvidence({ code: "PLAIN", details: { stderr: "stderr" } })).toMatchObject({ code: "PLAIN" });
    expect(i.earlyLaunchFailure(Object.assign(new Error("cause"), { code: "CUSTOM", details: { causeCode: "ORIGINAL", cliFailure: { code: "CLI" } } }), "validate")).toMatchObject({ details: { causeCode: "ORIGINAL" } });
    expect(i.earlyLaunchFailure(Object.assign(new Error("\0"), { code: "CUSTOM" }), "validate")).toMatchObject({ code: "CUSTOM" });
    const activeSupervision = { state: "active", jobId: "job", child: { paneId: "p" } };
    const provisionalSupervision = { state: "provisional", jobId: "job", provisional: { paneId: "p" } };
    const effects = { agentStarted: true, promptSubmitted: true, recipientRegistered: true, mutationDispatched: true, promptDispatch: { state: "acknowledged", requestId: "req" }, assignmentState: "confirmed", initialPromptSubmission: { confirmed: true }, readiness: { elapsedMs: 1 }, supervision: activeSupervision, timing: { selectedStartReadinessMs: 1 }, attempts: [{ candidate: { index: 0, runner: "pi", model: "m" }, outcome: "selected" }] };
    expect(i.partialError(cliError, { paneId: "p" }, "agent_start", grant, effects, "attachment", { attachmentId: "a" }, { effectCertainty: "partial", pane: "present", agent: "present", snapshot: "present" })).toMatchObject({ code: "LAUNCH_FAILED", details: { attachmentRetained: true, supervision: activeSupervision } });
    const readyTimeout = i.earlyLaunchFailure(Object.assign(new Error("timeout"), { code: "READY_TIMEOUT" }), "ready");
    readyTimeout.details.readiness = { elapsedMs: 1 } as unknown as UnsafeTestValue;
    expect(i.partialError(readyTimeout, {}, "ready", grant, { ...effects, supervision: provisionalSupervision, readiness: undefined, assignmentState: undefined, initialPromptSubmission: undefined, promptDispatch: undefined, timing: {}, attempts: [] }, undefined, undefined, undefined)).toMatchObject({ code: "READY_TIMEOUT", details: { readiness: expect.any(Object) } });
    expect(i.partialError(Object.assign(new Error("aborted"), { code: "ABORTED" }), {}, "focus", grant, { agentStarted: false, promptSubmitted: false, recipientRegistered: false, mutationDispatched: false, timing: {}, attempts: [] })).toMatchObject({ code: "ABORTED" });
    expect(i.batchManifest({ operation: "launch_batch", outcome: "failed", router: [], children: [], failure: { code: "FAILED", message: "failed" } })).toContain("router=none");
    const missingRunnerCatalog = { ...catalogOf([{ runner: "pi", model: "m" }]), runners: new Map() };
    expect(i.specRouterState(spec(), missingRunnerCatalog).catalog[0]).toMatchObject({ timeout: 0 });
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
    const baseline = { version: "0.8.0", protocol: 22, workspaces: [{ workspace_id: "w", label: "w", focused: true }], tabs: [{ tab_id: "t", workspace_id: "w", label: "t", focused: true }], panes: [{ pane_id: "p", tab_id: "t", workspace_id: "w" }], agents: [] } as HerdrSnapshot;
    const presentPaneNoAgent: LaunchCli = { runJson: vi.fn(async (argv) => {
      if (argv[0] === "api") return ok("snapshot", { type: "session_snapshot", snapshot: { ...baseline, panes: [...baseline.panes, { pane_id: "p", tab_id: "t", workspace_id: "w" }], agents: [] } });
      if (argv[0] === "pane") return ok("pane", { pane: { pane_id: "p", tab_id: "t", workspace_id: "w" } });
      return ok("agent", { agent: null });
    }), prompt: vi.fn() };
    await expect(i.reconcileLaunch({ cli: presentPaneNoAgent, baseline, paneId: "p", tabId: "t", agentStarted: true, promptSubmitted: false, agentName: "worker" })).resolves.toMatchObject({ pane: "present", agent: "absent" });
  });
});
