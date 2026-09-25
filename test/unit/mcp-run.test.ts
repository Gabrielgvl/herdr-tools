import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CORE_TOOL_NAMES } from "../../src/tool-surface.js";
import type { PiExec } from "../../src/cli.js";
import type { DaemonCallerContext, DaemonClient } from "../../src/daemon/client.js";
import type { DaemonNamespace } from "../../src/daemon/namespace.js";
import { CLAUDE_CHANNEL_CAPABILITY } from "../../src/supervision/notify.js";
import { AdapterContractError } from "../../src/mcp/adapter.js";
import type * as AdapterModule from "../../src/mcp/adapter.js";
import { StartupRefusal } from "../../src/mcp/host.js";

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

/**
 * The snapshot the D2a claim is derived from. The hosting pane's
 * `agent_session` is the verified identity the daemon re-reads, so every
 * proxied call must claim exactly this record.
 */
const snapshot = {
  type: "session_snapshot",
  snapshot: {
    version: "1",
    protocol: 1,
    workspaces: [{ workspace_id: "w", label: "w" }],
    tabs: [{ tab_id: "w:t", workspace_id: "w", label: "t" }],
    panes: [
      { pane_id: "w:p", tab_id: "w:t", workspace_id: "w", label: "manager", agent_name: "manager", agent: "pi", terminal_id: "term-manager", agent_session: { source: "pi", agent: "pi", kind: "id", value: "manager-session" }, agent_status: "idle" },
      { pane_id: "w:p2", tab_id: "w:t", workspace_id: "w", label: "worker", agent_name: "worker", agent: "pi", terminal_id: "term-worker", agent_session: { source: "pi", agent: "pi", kind: "id", value: "worker-session" }, agent_status: "working" }
    ],
    agents: [
      { pane_id: "w:p", name: "manager", agent: "pi", terminal_id: "term-manager", agent_session: { source: "pi", agent: "pi", kind: "id", value: "manager-session" }, agent_status: "idle" },
      { pane_id: "w:p2", name: "worker", agent: "pi", terminal_id: "term-worker", agent_session: { source: "pi", agent: "pi", kind: "id", value: "worker-session" }, agent_status: "working" }
    ]
  }
};

const projectDir = mkdtempSync(join(tmpdir(), "herdr-mcp-run-"));
// The served directory is always the canonical path; the raw spelling is only
// the resolution input.
const canonicalProjectDir = realpathSync(projectDir);
const env = { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w", HERDR_TAB_ID: "w:t", HERDR_PANE_ID: "w:p", HERDR_PROJECT_DIR: projectDir };
const extensionContext = { cwd: projectDir, signal: new AbortController().signal, modelRegistry: { find: () => undefined, getAll: () => [] } } as unknown as ExtensionContext;
const namespace: DaemonNamespace = { dir: join(canonicalProjectDir, "herdr-tools-daemon"), endpoint: join(canonicalProjectDir, "herdr.sock") };

/**
 * The only CLI call the proxy host makes: one fresh `api snapshot` per tool
 * call, to derive the verified agent session for the D2a claim.
 */
function fakeExec(): { exec: PiExec; calls: string[][] } {
  const calls: string[][] = [];
  const envelope = (id: string, result: unknown) => ({ stdout: JSON.stringify({ id, result }), stderr: "", code: 0, killed: false });
  const exec: PiExec = async (_command, argv) => {
    calls.push(argv);
    if (argv[0] === "api") return envelope("snapshot", snapshot);
    return envelope("other", { ok: true });
  };
  return { exec, calls };
}

/** A scripted daemon client plus the connect seam that hands it to the host. */
function fakeDaemon(replies: { launch?: unknown; run?: unknown; status?: unknown } = {}) {
  const calls: Array<{ method: string; params: unknown }> = [];
  let closed = 0;
  const client = {
    launch: async (params: unknown) => { calls.push({ method: "launch", params }); return replies.launch ?? { kind: "launch", state: "completed" }; },
    run: async (params: unknown) => { calls.push({ method: "run", params }); return replies.run ?? { kind: "run" }; },
    status: async (params: unknown) => { calls.push({ method: "status", params }); return replies.status ?? { kind: "status" }; },
    close: () => { closed += 1; },
  };
  const connections: Array<{ namespace: DaemonNamespace; caller: DaemonCallerContext }> = [];
  const connectDaemon = async (ns: DaemonNamespace, caller: DaemonCallerContext): Promise<DaemonClient> => {
    connections.push({ namespace: ns, caller });
    return client as unknown as DaemonClient;
  };
  return { calls, connections, connectDaemon, closed: () => closed };
}

interface Harness {
  handle: NonNullable<Awaited<ReturnType<typeof runHerdrMcpServer>>>;
  client: Client;
  calls: string[][];
  daemon: ReturnType<typeof fakeDaemon>;
  exits: number[];
  errors: string[];
  signals: string[];
}

async function start(overrides: Partial<Parameters<typeof runHerdrMcpServer>[0]> = {}): Promise<Harness> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const { exec, calls } = fakeExec();
  const daemon = fakeDaemon(overridesDaemonReplies);
  const exits: number[] = [];
  const errors: string[] = [];
  const signals: string[] = [];
  const handle = await runHerdrMcpServer({
    env,
    exec,
    transport: serverTransport,
    resolveNamespace: async () => namespace,
    connectDaemon: daemon.connectDaemon,
    writeStderr: (line) => errors.push(line),
    exit: (code) => exits.push(code),
    onSignal: (signal) => signals.push(signal),
    ...overrides
  });
  if (!handle) throw new Error("server did not start");
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return { handle, client, calls, daemon, exits, errors, signals };
}

let overridesDaemonReplies: { launch?: unknown; run?: unknown; status?: unknown } = {};

function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content.map((block) => block.text).join("\n");
}

afterEach(() => {
  describeFailure.enabled = false;
  stdioTransports.length = 0;
  overridesDaemonReplies = {};
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("MCP server startup", () => {
  it("refuses to serve without gating and never connects a transport or calls the CLI", async () => {
    const danglingRoot = mkdtempSync(join(tmpdir(), "herdr-mcp-dangling-"));
    const dangling = join(danglingRoot, "dangling");
    symlinkSync(join(danglingRoot, "missing-target"), dangling, "dir");
    const refusals: Array<[NodeJS.ProcessEnv, string]> = [
      [{ HERDR_PROJECT_DIR: projectDir }, "HERDR_ENV"],
      [{ HERDR_ENV: "1", HERDR_PROJECT_DIR: projectDir }, "INJECTED_CONTEXT"],
      [{ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w", HERDR_TAB_ID: "w:t", HERDR_PANE_ID: "w:p", HERDR_PROJECT_DIR: "relative/project" }, "PROJECT_DIR"],
      // A symlink whose target cannot be resolved fails at startup the same way.
      [{ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w", HERDR_TAB_ID: "w:t", HERDR_PANE_ID: "w:p", HERDR_PROJECT_DIR: dangling }, "PROJECT_DIR"]
    ];
    try {
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
          writeStderr: (line) => errors.push(line),
          exit: (code) => exits.push(code)
        });
        expect(handle).toBeUndefined();
        expect(exits).toEqual([1]);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain(`${MCP_SERVER_NAME} mcp server refused to start: ${reason}`);
        expect(errors[0]!.endsWith("\n")).toBe(true);
        if (refusedEnv.HERDR_PROJECT_DIR !== undefined) {
          expect(errors[0]).not.toContain(refusedEnv.HERDR_PROJECT_DIR);
        }
        expect(started).not.toHaveBeenCalled();
        expect(calls).toEqual([]);
      }
    } finally {
      rmSync(danglingRoot, { recursive: true, force: true });
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
    expect(errors[0]).toContain("PROJECT_DIR");
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
    const long = refusalLine(new Error(`${"x".repeat(2_000)}`));
    expect(long.endsWith("\n")).toBe(true);
    expect(long.split(": ")[1]).toHaveLength(501);
  });

  it("bounds and sanitizes the fatal entry line with the same conventions", () => {
    expect(fatalLine(new Error("transport exploded"))).toBe(`${MCP_SERVER_NAME} mcp server failed: transport exploded\n`);
    const hostile = fatalLine(new Error(`forged\nHERDR_API_KEY=/etc\r ${"y".repeat(2_000)}`));
    expect(hostile.split("\n")).toHaveLength(2);
    expect(hostile.endsWith("\n")).toBe(true);
    expect(hostile.slice(`${MCP_SERVER_NAME} mcp server failed: `.length, -1)).toHaveLength(500);
    expect(fatalLine("not an error object")).toBe(`${MCP_SERVER_NAME} mcp server failed: not an error object\n`);
  });

  it("anchors the package root on the manifest beside the bundled catalog", async () => {
    expect(packageRoot(import.meta.url)).toBe(process.cwd());
    expect(packageRoot("file:///a/b/c/run.js", () => false)).toBe("/a/b/c");
  });

  it("uses the stdio transport and process signal handlers when none are injected", async () => {
    const once = vi.spyOn(process, "once").mockReturnValue(process);
    const stdinOnce = vi.spyOn(process.stdin, "once").mockReturnValue(process.stdin);
    const exits: number[] = [];
    const handle = await runHerdrMcpServer({
      env,
      exit: (code) => exits.push(code)
    });
    expect(handle).toBeDefined();
    expect(stdioTransports).toHaveLength(1);
    expect(stdioTransports[0]).toMatchObject({ started: true });
    expect(once.mock.calls.map((call) => call[0])).toEqual(["SIGINT", "SIGTERM"]);
    expect(stdinOnce.mock.calls.map((call) => call[0])).toEqual(["end", "close"]);
    for (const [, listener] of stdinOnce.mock.calls) listener();
    await vi.waitFor(() => expect(exits).toEqual([0]));
    expect(stdioTransports[0]).toMatchObject({ closed: true });
  });
});

describe("MCP tool serving", () => {
  it("lists exactly the three daemon-proxy tools with object input schemas and keeps the Channels capability", async () => {
    const harness = await start();
    const list = await harness.client.listTools();
    expect(list.tools.map((tool) => tool.name)).toEqual([...CORE_TOOL_NAMES]);
    expect(list.tools).toHaveLength(3);
    expect(list.tools.every((tool) => tool.inputSchema.type === "object")).toBe(true);
    expect(list.tools.map((tool) => tool.title)).toEqual(["Herdr Launch", "Herdr Run", "Herdr Status"]);
    // N5.2 owns the capability's removal; the advertisement stays until then.
    expect(harness.client.getServerCapabilities()).toMatchObject({ experimental: { [CLAUDE_CHANNEL_CAPABILITY]: {} } });
    await harness.handle.shutdown();
  });

  it("proxies each tool call through one fresh verified daemon connection", async () => {
    overridesDaemonReplies = {
      launch: { kind: "launch", launchId: "l-1", state: "completed" },
      run: { kind: "run", action: "ack", result: "acked" },
      status: { kind: "status", daemon: { status: "running" }, unread: { count: 0, ids: [] } }
    };
    const harness = await start();

    const launch = await harness.client.callTool({ name: "herdr_launch", arguments: { task: { objective: "o", scope: "s", doneWhen: ["done"] }, idempotencyKey: "idem-1" } });
    expect(launch.isError).toBeUndefined();
    expect(JSON.parse(textOf(launch))).toMatchObject({ kind: "launch", launchId: "l-1" });

    const run = await harness.client.callTool({ name: "herdr_run", arguments: { action: "ack", eventId: "evt-1" } });
    expect(run.isError).toBeUndefined();
    const status = await harness.client.callTool({ name: "herdr_status", arguments: { eventId: "evt-1" } });
    expect(status.isError).toBeUndefined();

    expect(harness.daemon.calls).toEqual([
      { method: "launch", params: { task: { objective: "o", scope: "s", doneWhen: ["done"] }, idempotencyKey: "idem-1" } },
      { method: "run", params: { action: "ack", eventId: "evt-1" } },
      { method: "status", params: { eventId: "evt-1" } }
    ]);
    // Three calls, three fresh connections, every one closed — and each claim
    // carries the verified identity resolved from the authoritative snapshot.
    expect(harness.daemon.connections).toHaveLength(3);
    for (const connection of harness.daemon.connections) {
      expect(connection.namespace).toEqual(namespace);
      expect(connection.caller).toEqual({
        identity: {
          workspaceId: "w",
          tabId: "w:t",
          paneId: "w:p",
          agentSession: { source: "pi", agent: "pi", kind: "id", value: "manager-session" }
        },
        projectRoot: canonicalProjectDir
      });
    }
    expect(harness.daemon.closed()).toBe(3);
    await harness.handle.shutdown();
  });

  it("rejects malformed input before any daemon connection opens", async () => {
    const harness = await start();
    const invalid = await harness.client.callTool({ name: "herdr_run", arguments: { action: "observe" } });
    expect(invalid.isError).toBe(true);
    expect(textOf(invalid)).toContain("INVALID_INPUT");
    expect(harness.daemon.connections).toEqual([]);
    expect(harness.daemon.calls).toEqual([]);
    await harness.handle.shutdown();
  });

  it("surfaces the daemon's typed failure as a tool error and still closes the client", async () => {
    let daemonClosed = 0;
    const harness = await start({
      connectDaemon: async () => ({
        launch: async () => { throw Object.assign(new Error("unresolved intent"), { code: "INTENT_UNRESOLVED" }); },
        run: async () => { throw new Error("unused"); },
        status: async () => { throw new Error("unused"); },
        close: () => { daemonClosed += 1; }
      }) as unknown as DaemonClient
    });
    const failure = await harness.client.callTool({ name: "herdr_launch", arguments: { task: { objective: "o", scope: "s", doneWhen: ["done"] }, idempotencyKey: "idem-1" } });
    expect(failure.isError).toBe(true);
    expect(textOf(failure)).toContain("INTENT_UNRESOLVED");
    expect(daemonClosed).toBe(1);
    await harness.handle.shutdown();
  });

  it("raises MethodNotFound for an unknown tool", async () => {
    const harness = await start();
    const failure = await harness.client.callTool({ name: "herdr_admin", arguments: {} }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: ErrorCode.MethodNotFound });
    await harness.handle.shutdown();
  });

  it("uses HERDR_PROJECT_DIR as the operational working directory and caller project root", async () => {
    const harness = await start();
    expect(harness.handle.projectDir).toBe(canonicalProjectDir);
    expect(canonicalProjectDir).not.toBe(realpathSync(process.cwd()));
    const status = await harness.client.callTool({ name: "herdr_status", arguments: {} });
    expect(status.isError).toBeUndefined();
    expect(harness.daemon.connections[0]!.caller.projectRoot).toBe(canonicalProjectDir);
    await harness.handle.shutdown();
  });

  it("anchors on the injected launch directory when HERDR_PROJECT_DIR is unset", async () => {
    const launchOnlyEnv = { HERDR_ENV: env.HERDR_ENV, HERDR_WORKSPACE_ID: env.HERDR_WORKSPACE_ID, HERDR_TAB_ID: env.HERDR_TAB_ID, HERDR_PANE_ID: env.HERDR_PANE_ID };
    const harness = await start({ env: launchOnlyEnv, cwd: () => projectDir });
    expect(harness.handle.projectDir).toBe(canonicalProjectDir);
    await harness.handle.shutdown();
  });

  it("resolves a symlinked HERDR_PROJECT_DIR and serves the canonical directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-mcp-alias-"));
    try {
      const target = join(root, "target");
      mkdirSync(target);
      const alias = join(root, "alias");
      symlinkSync(target, alias, "dir");
      const canonical = realpathSync(alias);
      expect(canonical).not.toBe(alias);
      const harness = await start({ env: { ...env, HERDR_PROJECT_DIR: alias } });
      expect(harness.handle.projectDir).toBe(canonical);
      const status = await harness.client.callTool({ name: "herdr_status", arguments: {} });
      expect(status.isError).toBeUndefined();
      expect(harness.daemon.connections[0]!.caller.projectRoot).toBe(canonical);
      await harness.handle.shutdown();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("MCP server lifecycle", () => {
  it("exits zero exactly once and keeps shutdown idempotent", async () => {
    const harness = await start();
    await harness.handle.shutdown();
    expect(harness.exits).toEqual([0]);
    await harness.handle.shutdown();
    expect(harness.exits).toEqual([0]);
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

  it("falls back to process.env and a fresh signal when the host injects neither", async () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    try {
      const harness = await start({ env: undefined });
      // An execute call carrying no signal uses the per-call AbortController seam.
      const reply = await harness.handle.surface.status.execute("call-1", {}, undefined, undefined, extensionContext);
      expect(JSON.parse(textOf(reply))).toMatchObject({ kind: "status" });
      expect(harness.daemon.calls).toEqual([{ method: "status", params: {} }]);
      expect(harness.daemon.connections[0]?.caller.identity).toMatchObject({ workspaceId: "w", tabId: "w:t", paneId: "w:p" });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("delegated caller mode (HERDR_EXECUTOR_DELEGATED)", () => {
  /** Delegated serve: gated in, but no injected per-pane identity is possible. */
  const delegatedEnv = { HERDR_ENV: "1", HERDR_EXECUTOR_DELEGATED: "1", HERDR_PROJECT_DIR: projectDir };
  const caller = { paneId: "w:p", projectRoot: projectDir };

  it("starts without injected identity and builds the identical claim an env caller would", async () => {
    // The env-identity path, under the flag, with no caller argument.
    const envServer = await start({ env: { ...env, HERDR_EXECUTOR_DELEGATED: "1" } });
    const envStatus = await envServer.client.callTool({ name: "herdr_status", arguments: {} });
    expect(envStatus.isError).toBeUndefined();
    const envClaim = envServer.daemon.connections[0]!.caller;
    await envServer.handle.shutdown();

    // The delegated path asserts the same pane; the derived claim is identical.
    const delegated = await start({ env: delegatedEnv });
    const status = await delegated.client.callTool({ name: "herdr_status", arguments: { caller } });
    expect(status.isError).toBeUndefined();
    expect(delegated.daemon.connections).toHaveLength(1);
    expect(delegated.daemon.connections[0]!.caller).toEqual(envClaim);
    // One fresh snapshot per call, identical to the env path's derivation.
    expect(delegated.calls).toEqual([["api", "snapshot"]]);
    await delegated.handle.shutdown();
  });

  it("claims the asserted pane's snapshot identity, not another pane's", async () => {
    const harness = await start({ env: delegatedEnv });
    const status = await harness.client.callTool({ name: "herdr_status", arguments: { caller: { paneId: "w:p2", projectRoot: projectDir } } });
    expect(status.isError).toBeUndefined();
    expect(harness.daemon.connections[0]!.caller).toEqual({
      identity: {
        workspaceId: "w",
        tabId: "w:t",
        paneId: "w:p2",
        agentSession: { source: "pi", agent: "pi", kind: "id", value: "worker-session" }
      },
      projectRoot: canonicalProjectDir
    });
    await harness.handle.shutdown();
  });

  it("refuses a caller argument on a non-delegated server without touching the daemon or the CLI", async () => {
    const harness = await start();
    const cases: Array<[string, Record<string, unknown>]> = [
      ["herdr_status", { caller }],
      ["herdr_run", { action: "ack", eventId: "evt-1", caller }],
      ["herdr_launch", { task: { objective: "o", scope: "s", doneWhen: ["d"] }, idempotencyKey: "idem-1", caller }],
    ];
    for (const [name, args] of cases) {
      const result = await harness.client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("DELEGATED_CALLER_DISABLED");
    }
    expect(harness.daemon.connections).toEqual([]);
    expect(harness.calls).toEqual([]);
    await harness.handle.shutdown();
  });

  it("refuses a caller-less call on a delegated serve with no injected identity", async () => {
    const harness = await start({ env: delegatedEnv });
    const result = await harness.client.callTool({ name: "herdr_status", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("DELEGATED_CALLER_REQUIRED");
    expect(harness.daemon.connections).toEqual([]);
    expect(harness.calls).toEqual([]);
    await harness.handle.shutdown();
  });

  it("refuses a caller asserting a pane absent from the authoritative snapshot", async () => {
    const harness = await start({ env: delegatedEnv });
    const result = await harness.client.callTool({ name: "herdr_status", arguments: { caller: { paneId: "w:p9", projectRoot: projectDir } } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("CONTEXT_UNAVAILABLE");
    // The derivation did run one fresh snapshot; no daemon connection opened.
    expect(harness.calls).toEqual([["api", "snapshot"]]);
    expect(harness.daemon.connections).toEqual([]);
    await harness.handle.shutdown();
  });

  it("rejects a malformed caller at validation before any snapshot or connection", async () => {
    const harness = await start({ env: delegatedEnv });
    for (const bad of [{ caller: { projectRoot: projectDir } }, { caller: { paneId: "w:p" } }, { caller: { paneId: "w:p", projectRoot: "relative/dir" } }, { caller: { paneId: "w:p", projectRoot: projectDir, extra: true } }]) {
      const result = await harness.client.callTool({ name: "herdr_status", arguments: bad });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("INVALID_INPUT");
    }
    expect(harness.daemon.connections).toEqual([]);
    expect(harness.calls).toEqual([]);
    await harness.handle.shutdown();
  });

  it("realpaths caller.projectRoot and refuses an unresolvable one", async () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-mcp-caller-root-"));
    try {
      const target = join(root, "target");
      mkdirSync(target);
      const alias = join(root, "alias");
      symlinkSync(target, alias, "dir");
      const canonical = realpathSync(alias);
      const harness = await start({ env: delegatedEnv });
      const status = await harness.client.callTool({ name: "herdr_status", arguments: { caller: { paneId: "w:p", projectRoot: alias } } });
      expect(status.isError).toBeUndefined();
      expect(harness.daemon.connections[0]!.caller.projectRoot).toBe(canonical);

      const missing = await harness.client.callTool({ name: "herdr_status", arguments: { caller: { paneId: "w:p", projectRoot: join(root, "missing") } } });
      expect(missing.isError).toBe(true);
      expect(textOf(missing)).toContain("DELEGATED_CALLER_INVALID");
      const file = join(root, "file");
      writeFileSync(file, "x");
      const notDir = await harness.client.callTool({ name: "herdr_status", arguments: { caller: { paneId: "w:p", projectRoot: file } } });
      expect(notDir.isError).toBe(true);
      expect(textOf(notDir)).toContain("DELEGATED_CALLER_INVALID");
      // Two successful/failed calls, exactly one connection — the refusals never connect.
      expect(harness.daemon.connections).toHaveLength(1);
      await harness.handle.shutdown();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
