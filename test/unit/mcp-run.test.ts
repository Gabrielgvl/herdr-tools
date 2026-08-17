import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CORE_TOOL_NAMES } from "../../src/tool-surface.js";
import type { PiExec } from "../../src/cli.js";
import { AdapterContractError } from "../../src/mcp/adapter.js";
import type * as AdapterModule from "../../src/mcp/adapter.js";
import { StartupRefusal } from "../../src/mcp/host.js";

const readFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", () => ({ readFile: readFileMock }));

const describeFailure = vi.hoisted(() => ({ enabled: false }));
vi.mock("../../src/mcp/adapter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof AdapterModule>();
  return {
    ...actual,
    describeTools: (surface: Parameters<typeof actual.describeTools>[0]) => {
      if (describeFailure.enabled) throw new actual.AdapterContractError("tool parameters are not a publishable object schema");
      return actual.describeTools(surface);
    }
  };
});

const stdioTransports = vi.hoisted(() => [] as Array<{ started: boolean; closed: boolean }>);
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {
    onclose?: () => void;
    onmessage?: () => void;
    onerror?: () => void;
    private readonly record = { started: false, closed: false };
    constructor() {
      stdioTransports.push(this.record);
    }
    async start(): Promise<void> {
      this.record.started = true;
    }
    async send(): Promise<void> {
      // The fake stdio transport never has a peer in unit tests.
    }
    async close(): Promise<void> {
      this.record.closed = true;
      this.onclose?.();
    }
  }
}));

const { runHerdrMcpServer, packageRoot, refusalLine, fatalLine, MCP_SERVER_NAME } = await import("../../src/mcp/run.js");

const health = { client: { version: "0.8.0", protocol: 19 }, server: { status: "running", version: "0.8.0", protocol: 19, compatible: true } };
const snapshot = {
  type: "session_snapshot",
  snapshot: {
    version: "1",
    protocol: 1,
    workspaces: [{ workspace_id: "w", label: "w" }],
    tabs: [{ tab_id: "w:t", workspace_id: "w", label: "t" }],
    // Pane records carry owner-supplied environment values; no model-visible
    // block this host publishes may echo one.
    panes: [
      { pane_id: "w:p", tab_id: "w:t", workspace_id: "w", label: "manager", agent_name: "manager", agent_status: "idle", environment: { SECRET: "run-secret" }, environment_overrides: { SECRET: "run-secret" }, history: [{ env: { SECRET: "run-secret" } }] },
      { pane_id: "w:p2", tab_id: "w:t", workspace_id: "w", label: "worker", agent_name: "worker", agent_status: "working", environment: { SECRET: "run-secret" }, environment_overrides: { SECRET: "run-secret" }, history: [{ env: { SECRET: "run-secret" } }] }
    ],
    agents: [{ pane_id: "w:p", name: "manager", agent_status: "idle" }, { pane_id: "w:p2", name: "worker", agent_status: "working" }]
  }
};

const projectDir = mkdtempSync(join(tmpdir(), "herdr-mcp-run-"));
const env = { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w", HERDR_TAB_ID: "w:t", HERDR_PANE_ID: "w:p", CLAUDE_PROJECT_DIR: projectDir };
const emptyCatalog = { effective: new Map(), candidates: [], diagnostics: [] } as never;

function fakeExec(): { exec: PiExec; calls: string[][] } {
  const calls: string[][] = [];
  const live = structuredClone(snapshot);
  const envelope = (id: string, result: unknown) => ({ stdout: JSON.stringify({ id, result }), stderr: "", code: 0, killed: false });
  const exec: PiExec = async (_command, argv) => {
    calls.push(argv);
    if (argv[0] === "status") return { stdout: JSON.stringify(health), stderr: "", code: 0, killed: false };
    if (argv[0] === "api") return envelope("snapshot", live);
    if (argv[0] === "pane" && argv[1] === "get") return envelope("pane", { pane: live.snapshot.panes.find((pane) => pane.pane_id === argv[2]) });
    if (argv[0] === "pane" && argv[1] === "read") return { stdout: "worker output", stderr: "", code: 0, killed: false };
    if (argv[0] === "tab" && argv[1] === "create") {
      live.snapshot.tabs.push({ tab_id: "w:t2", workspace_id: "w", label: argv[argv.indexOf("--label") + 1]! });
      live.snapshot.panes.push({ pane_id: "w:p9", tab_id: "w:t2", workspace_id: "w", label: "root", agent_name: "root", agent_status: "idle", environment: { SECRET: "run-secret" }, environment_overrides: { SECRET: "run-secret" }, history: [{ env: { SECRET: "run-secret" } }] });
      return envelope("create", { tab: { tab_id: "w:t2" }, root_pane: { pane_id: "w:p9" } });
    }
    if (argv[0] === "tab" && argv[1] === "get") return envelope("get", { tab: live.snapshot.tabs.find((tab) => tab.tab_id === argv[2]) });
    return envelope("other", { ok: true });
  };
  return { exec, calls };
}

interface Harness {
  handle: NonNullable<Awaited<ReturnType<typeof runHerdrMcpServer>>>;
  client: Client;
  calls: string[][];
  exits: number[];
  errors: string[];
  signals: string[];
}

async function start(overrides: Partial<Parameters<typeof runHerdrMcpServer>[0]> = {}): Promise<Harness> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const { exec, calls } = fakeExec();
  const exits: number[] = [];
  const errors: string[] = [];
  const signals: string[] = [];
  const handle = await runHerdrMcpServer({
    env,
    exec,
    transport: serverTransport,
    profiles: { load: async () => emptyCatalog },
    settingsLoader: async () => ({ reviewCadenceMinutes: 30, reviewerModel: "luna", reviewerThinking: "low" }),
    writeStderr: (line) => errors.push(line),
    exit: (code) => exits.push(code),
    onSignal: (signal) => signals.push(signal),
    ...overrides
  });
  if (!handle) throw new Error("server did not start");
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return { handle, client, calls, exits, errors, signals };
}

function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content.map((block) => block.text).join("\n");
}

beforeEach(() => {
  describeFailure.enabled = false;
  stdioTransports.length = 0;
  readFileMock.mockReset();
  readFileMock.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MCP server startup", () => {
  it("refuses to serve without gating and never connects a transport or calls the CLI", async () => {
    const refusals: Array<[NodeJS.ProcessEnv, string]> = [
      [{ CLAUDE_PROJECT_DIR: projectDir }, "HERDR_ENV"],
      [{ HERDR_ENV: "1", CLAUDE_PROJECT_DIR: projectDir }, "INJECTED_CONTEXT"],
      [{ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w", HERDR_TAB_ID: "w:t", HERDR_PANE_ID: "w:p" }, "CLAUDE_PROJECT_DIR"]
    ];
    for (const [refusedEnv, reason] of refusals) {
      const [, serverTransport] = InMemoryTransport.createLinkedPair();
      const started = vi.spyOn(serverTransport, "start");
      const { exec, calls } = fakeExec();
      const errors: string[] = [];
      const exits: number[] = [];
      const handle = await runHerdrMcpServer({
        env: refusedEnv,
        exec,
        transport: serverTransport,
        profiles: { load: async () => emptyCatalog },
        writeStderr: (line) => errors.push(line),
        exit: (code) => exits.push(code)
      });
      expect(handle).toBeUndefined();
      expect(exits).toEqual([1]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(`${MCP_SERVER_NAME} mcp server refused to start: ${reason}`);
      expect(errors[0]!.endsWith("\n")).toBe(true);
      expect(started).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    }
  });

  it("refuses when a tool schema is not publishable", async () => {
    describeFailure.enabled = true;
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const started = vi.spyOn(serverTransport, "start");
    const errors: string[] = [];
    const exits: number[] = [];
    const handle = await runHerdrMcpServer({
      env,
      exec: fakeExec().exec,
      transport: serverTransport,
      profiles: { load: async () => emptyCatalog },
      writeStderr: (line) => errors.push(line),
      exit: (code) => exits.push(code)
    });
    expect(handle).toBeUndefined();
    expect(exits).toEqual([1]);
    expect(errors[0]).toContain("not a publishable object schema");
    expect(started).not.toHaveBeenCalled();
    expect(new AdapterContractError("check")).toMatchObject({ code: "ADAPTER_CONTRACT_VIOLATION" });
  });

  it("reports an unexpected startup failure without serving", async () => {
    const errors: string[] = [];
    const exits: number[] = [];
    const handle = await runHerdrMcpServer({
      env,
      stat: async () => { throw Object.assign(new Error("stat exploded"), { code: "EACCES" }); },
      exec: fakeExec().exec,
      transport: InMemoryTransport.createLinkedPair()[1],
      writeStderr: (line) => errors.push(line),
      exit: (code) => exits.push(code)
    });
    expect(handle).toBeUndefined();
    expect(exits).toEqual([1]);
    expect(errors[0]).toContain("CLAUDE_PROJECT_DIR");
  });

  it("writes refusals to stderr and exits the process by default", async () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    await expect(runHerdrMcpServer({ env: {} })).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    const inherited = process.env.HERDR_ENV;
    try {
      delete process.env.HERDR_ENV;
      await expect(runHerdrMcpServer()).resolves.toBeUndefined();
    } finally {
      if (inherited === undefined) delete process.env.HERDR_ENV;
      else process.env.HERDR_ENV = inherited;
    }
    expect(exit).toHaveBeenCalledTimes(2);
  });

  it("bounds every refusal to one printable stderr line", () => {
    expect(refusalLine(new StartupRefusal("HERDR_ENV", "must be 1"))).toBe(`${MCP_SERVER_NAME} mcp server refused to start: HERDR_ENV: must be 1\n`);
    expect(refusalLine(new Error("plain\nfailure"))).toBe(`${MCP_SERVER_NAME} mcp server refused to start: plain failure\n`);
    expect(refusalLine("string failure")).toContain("string failure");
    const long = refusalLine(new Error(`${"x".repeat(2_000)}`));
    expect(long.endsWith("\n")).toBe(true);
    expect(long.split(": ")[1]).toHaveLength(501);
  });

  it("bounds and sanitizes the fatal entry line with the same conventions", () => {
    expect(fatalLine(new Error("transport exploded"))).toBe(`${MCP_SERVER_NAME} mcp server failed: transport exploded\n`);
    const hostile = fatalLine(new Error(`forged\nCLAUDE_PROJECT_DIR=/etc\r ${"y".repeat(2_000)}`));
    expect(hostile.split("\n")).toHaveLength(2);
    expect(hostile.endsWith("\n")).toBe(true);
    expect(hostile.slice(`${MCP_SERVER_NAME} mcp server failed: `.length, -1)).toHaveLength(500);
    expect(fatalLine("not an error object")).toBe(`${MCP_SERVER_NAME} mcp server failed: not an error object\n`);
  });

  it("anchors the bundled profile catalog on the package root", async () => {
    expect(packageRoot(import.meta.url)).toBe(process.cwd());
    expect(packageRoot("file:///a/b/c/run.js", () => false)).toBe("/a/b/c");
  });

  it("serves the bundled catalog and the real settings file by default", async () => {
    const harness = await start({ profiles: undefined, settingsLoader: undefined });
    const profiles = await harness.client.callTool({ name: "herdr_inspect", arguments: { mode: "collection", collection: "profiles" } });
    expect(profiles.isError).toBeUndefined();
    expect(textOf(profiles)).toContain("manager-pi");
    const beyondDefaultCadence = await harness.client.callTool({ name: "herdr_wait", arguments: { targets: ["w:p2"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 600_000 } });
    expect(beyondDefaultCadence.isError).toBe(true);
    expect(textOf(beyondDefaultCadence)).toContain("REVIEWER_FAILED");
    expect(readFileMock).toHaveBeenCalled();
    await harness.handle.shutdown();
  });

  it("uses the stdio transport and process signal handlers when none are injected", async () => {
    const once = vi.spyOn(process, "once").mockReturnValue(process);
    const exits: number[] = [];
    const handle = await runHerdrMcpServer({
      env,
      profiles: { load: async () => emptyCatalog },
      settingsLoader: async () => ({ reviewCadenceMinutes: 30, reviewerModel: "luna", reviewerThinking: "low" }),
      exit: (code) => exits.push(code)
    });
    expect(handle).toBeDefined();
    expect(stdioTransports).toHaveLength(1);
    expect(stdioTransports[0]).toMatchObject({ started: true });
    expect(once.mock.calls.map((call) => call[0])).toEqual(["SIGINT", "SIGTERM"]);
    await handle!.shutdown();
    expect(stdioTransports[0]).toMatchObject({ closed: true });
    expect(exits).toEqual([0]);
  });
});

describe("MCP tool serving", () => {
  it("lists exactly the seven shared tools with object input schemas", async () => {
    const harness = await start();
    const list = await harness.client.listTools();
    expect(list.tools.map((tool) => tool.name)).toEqual([...CORE_TOOL_NAMES]);
    expect(list.tools.every((tool) => tool.inputSchema.type === "object")).toBe(true);
    expect(list.tools.map((tool) => tool.title)).toEqual(["Herdr Inspect", "Herdr Communicate", "Herdr Wait", "Herdr Jobs", "Herdr Launch", "Herdr Pane", "Herdr Tab"]);
    await harness.handle.shutdown();
  });

  it("returns bounded authoritative evidence and typed failures", async () => {
    const harness = await start();
    const context = await harness.client.callTool({ name: "herdr_inspect", arguments: {} });
    expect(context.isError).toBeUndefined();
    expect(textOf(context)).toContain("herdr-details");
    const health = await harness.client.callTool({ name: "herdr_inspect", arguments: { mode: "health" } });
    expect(textOf(health)).toContain("\"socketReachable\":true");
    const invalid = await harness.client.callTool({ name: "herdr_inspect", arguments: { mode: "health", target: "w:p2" } });
    expect(invalid.isError).toBe(true);
    expect(textOf(invalid)).toContain("INVALID_INPUT");
    const selfTarget = await harness.client.callTool({ name: "herdr_communicate", arguments: { target: "current", operation: "prompt", text: "hello" } });
    expect(selfTarget.isError).toBe(true);
    expect(textOf(selfTarget)).toContain("SELF_TARGET_REJECTED");
    await harness.handle.shutdown();
  });

  it("never publishes an environment value in any model-visible block", async () => {
    const harness = await start();
    const results = [
      await harness.client.callTool({ name: "herdr_inspect", arguments: { mode: "target", target: "w:p2" } }),
      await harness.client.callTool({ name: "herdr_inspect", arguments: { mode: "collection", collection: "panes" } }),
      await harness.client.callTool({ name: "herdr_wait", arguments: { targets: ["w:p2"], match: "any", condition: { kind: "state", state: "working" }, timeoutMs: 1_000 } })
    ];
    const detached = await harness.client.callTool({ name: "herdr_wait", arguments: { targets: ["w:p2"], match: "any", condition: { kind: "state", state: "working" }, timeoutMs: 1_000, runInBackground: true } });
    const jobId = (JSON.parse(textOf(detached).split("herdr-details\n")[1]!) as { jobId: string }).jobId;
    await vi.waitFor(() => expect(harness.handle.jobs.get(jobId)?.status).toBe("completed"));
    results.push(detached, await harness.client.callTool({ name: "herdr_jobs", arguments: { operation: "get", jobId } }));
    for (const result of results) {
      expect(result.isError, textOf(result)).toBeUndefined();
      expect(textOf(result)).not.toContain("run-secret");
    }
    // The pane evidence itself still reaches the model.
    expect(textOf(results[0]!)).toContain("agent_status");
    await harness.handle.shutdown();
  });

  it("serializes overlapping sequential tool calls", async () => {
    const base = fakeExec();
    const calls = base.calls;
    // Every CLI step yields to the event loop, so two unserialized herdr_pane
    // calls would interleave their read/mutate/read sequences here.
    const exec: PiExec = async (command, argv, options) => {
      await new Promise((settle) => setTimeout(settle, 2));
      return base.exec(command, argv, options);
    };
    const harness = await start({ exec });
    const outcomes = await Promise.all([
      harness.client.callTool({ name: "herdr_pane", arguments: { operation: "rename", target: "w:p2", label: "rename-first" } }),
      harness.client.callTool({ name: "herdr_pane", arguments: { operation: "rename", target: "w:p2", label: "rename-second" } })
    ]);
    expect(outcomes.every((outcome) => outcome.isError === undefined)).toBe(true);
    const sequence = calls.filter((call) => call[0] === "pane" && (call[1] === "rename" || call[1] === "get")).map((call) => call.slice(1).join(" "));
    const first = ["rename w:p2 rename-first", "get w:p2", "rename w:p2 rename-second", "get w:p2"];
    const second = ["rename w:p2 rename-second", "get w:p2", "rename w:p2 rename-first", "get w:p2"];
    expect([first, second]).toContainEqual(sequence);
    await harness.handle.shutdown();
  });

  it("raises MethodNotFound for an unknown tool", async () => {
    const harness = await start();
    const failure = await harness.client.callTool({ name: "herdr_admin", arguments: {} }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: ErrorCode.MethodNotFound });
    await harness.handle.shutdown();
  });

  it("uses CLAUDE_PROJECT_DIR as the operational working directory", async () => {
    const harness = await start();
    expect(harness.handle.projectDir).toBe(projectDir);
    expect(projectDir).not.toBe(process.cwd());
    const created = await harness.client.callTool({ name: "herdr_tab", arguments: { operation: "create", label: "worker-tab" } });
    expect(created.isError).toBeUndefined();
    const create = harness.calls.find((call) => call[0] === "tab" && call[1] === "create");
    expect(create?.[create.indexOf("--cwd") + 1]).toBe(projectDir);
    expect(harness.handle.ownership.snapshot().map((resource) => resource.kind)).toEqual(["tab", "pane"]);
    await harness.handle.shutdown();
  });

  it("cancels a running tool call through the request signal", async () => {
    const harness = await start();
    const controller = new AbortController();
    const pending = harness.client.callTool(
      { name: "herdr_wait", arguments: { targets: ["w:p2"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 60_000 } },
      undefined,
      { signal: controller.signal }
    ).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort(new Error("manager cancelled"));
    expect(await pending).toBeInstanceOf(Error);
    await harness.handle.shutdown();
  });
});

describe("MCP wait and job semantics", () => {
  it("fails closed for a foreground wait beyond the review cadence", async () => {
    const harness = await start({ settingsLoader: async () => ({ reviewCadenceMinutes: 1, reviewerModel: "luna", reviewerThinking: "low" }) });
    const outcome = await harness.client.callTool({ name: "herdr_wait", arguments: { targets: ["w:p2"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 120_000 } });
    expect(outcome.isError).toBe(true);
    expect(textOf(outcome)).toContain("REVIEWER_FAILED");
    expect(textOf(outcome)).toContain("model-backed wait review is unavailable on the MCP host");
    await harness.handle.shutdown();
  });

  it("registers a detached wait that is polled through herdr_jobs and fails closed beyond the cadence", async () => {
    const harness = await start({ settingsLoader: async () => ({ reviewCadenceMinutes: 1, reviewerModel: "luna", reviewerThinking: "low" }) });
    const detached = await harness.client.callTool({ name: "herdr_wait", arguments: { targets: ["w:p2"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 120_000, runInBackground: true } });
    expect(detached.isError).toBeUndefined();
    const jobId = (JSON.parse(textOf(detached).split("herdr-details\n")[1]!) as { jobId: string }).jobId;
    expect(jobId.startsWith("job_")).toBe(true);
    const listed = await harness.client.callTool({ name: "herdr_jobs", arguments: { operation: "list" } });
    expect(textOf(listed)).toContain(jobId);
    await harness.handle.jobs.get(jobId)?.status;
    await vi.waitFor(() => expect(harness.handle.jobs.get(jobId)?.status).toBe("failed"));
    const job = await harness.client.callTool({ name: "herdr_jobs", arguments: { operation: "get", jobId } });
    expect(textOf(job)).toContain("REVIEWER_FAILED");
    const cancelled = await harness.client.callTool({ name: "herdr_jobs", arguments: { operation: "cancel", jobId: "job_missing" } });
    expect(cancelled.isError).toBe(true);
    expect(textOf(cancelled)).toContain("JOB_NOT_FOUND");
    await harness.handle.shutdown();
  });

  it("keeps a wait within the cadence free of any reviewer", async () => {
    const harness = await start({ settingsLoader: async () => ({ reviewCadenceMinutes: 1, reviewerModel: "luna", reviewerThinking: "low" }) });
    const outcome = await harness.client.callTool({ name: "herdr_wait", arguments: { targets: ["w:p2"], match: "any", condition: { kind: "state", state: "working" }, timeoutMs: 1_000 } });
    expect(outcome.isError).toBeUndefined();
    expect(textOf(outcome)).toContain("success");
    await harness.handle.shutdown();
  });
});

describe("MCP server lifecycle", () => {
  it("marks jobs shut down, resets ownership, and exits zero exactly once", async () => {
    const harness = await start();
    const detached = await harness.client.callTool({ name: "herdr_wait", arguments: { targets: ["w:p2"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 60_000, runInBackground: true } });
    const jobId = (JSON.parse(textOf(detached).split("herdr-details\n")[1]!) as { jobId: string }).jobId;
    harness.handle.ownership.record({ kind: "pane", id: "w:p9" });
    await harness.handle.shutdown();
    expect(harness.handle.jobs.get(jobId)).toBeUndefined();
    expect(harness.handle.ownership.snapshot()).toEqual([]);
    expect(harness.exits).toEqual([0]);
    await harness.handle.shutdown();
    expect(harness.exits).toEqual([0]);
    expect(harness.calls.every((call) => call[0] !== "pane" || call[1] !== "close")).toBe(true);
  });

  it("shuts down when the transport closes and when a signal arrives", async () => {
    const closing = await start();
    await closing.client.close();
    await vi.waitFor(() => expect(closing.exits).toEqual([0]));

    const signalled: Array<() => void> = [];
    const harness = await start({ onSignal: (_signal, handler) => signalled.push(handler) });
    expect(signalled).toHaveLength(2);
    signalled[0]!();
    await vi.waitFor(() => expect(harness.exits).toEqual([0]));
    signalled[1]!();
    expect(harness.exits).toEqual([0]);
  });
});
