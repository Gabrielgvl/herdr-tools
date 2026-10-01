import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn(() => ({ on: vi.fn(), kill: vi.fn() })) }));

const scripts = join(process.cwd(), "herdr-profiles/profile-plugins/executor/scripts");
const executor = () => import(pathToFileURL(join(scripts, "executor-project-mcp.mjs")).href);
const hindsight = () => import(pathToFileURL(join(scripts, "hindsight-project-mcp.mjs")).href);
// Exactly what the SDK client raises for Executor's answer to a forgotten session.
const UNKNOWN_SESSION_BODY = JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
const sessionLost = () => new StreamableHTTPError(404, `Error POSTing to endpoint: ${UNKNOWN_SESSION_BODY}`);

describe("direct project memory and shared Executor routing", () => {
  it("binds canonical roots and rejects unmapped, ambiguous, and divergent mappings", async () => {
    const { resolveProjectBank } = await hindsight();
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hindsight-project-mcp-")));
    const repo = join(root, "nlp");
    const worktree = join(root, "worktrees", "nlp", "feature");
    const outside = join(root, "nlp-copy");
    for (const dir of [repo, worktree, outside]) mkdirSync(join(dir, "src"), { recursive: true });
    const alias = join(root, "alias");
    symlinkSync(worktree, alias);
    const escape = join(repo, "escape");
    symlinkSync(outside, escape);
    const config = { mapPathToBank: { [repo]: "nlp", [worktree]: "nlp-feature" } };
    expect(resolveProjectBank(config, join(repo, "src"))).toEqual({ bankId: "nlp", projectRoot: repo, cwd: join(repo, "src") });
    expect(resolveProjectBank(config, join(alias, "src"))).toEqual({ bankId: "nlp-feature", projectRoot: worktree, cwd: join(worktree, "src") });
    for (const cwd of [escape, outside]) expect(() => resolveProjectBank(config, cwd)).toThrow("No Hindsight bank is mapped");
    expect(() => resolveProjectBank({ mapPathToBank: { [worktree]: "nlp", [alias]: "other" } }, worktree)).toThrow("Ambiguous Hindsight bank");
    expect(() => resolveProjectBank({ mapPathToBank: { [alias]: "nlp" } }, worktree)).toThrow("mapping differs");
    expect(() => resolveProjectBank({ ...config, banks: { nlp: { bank: "other" } } }, repo)).toThrow("bank override differs");
    expect(() => resolveProjectBank({ mapPathToBank: { [repo]: "" } }, repo)).toThrow("mapping is invalid");
  });

  it("validates the effective per-harness mapping rather than ignoring overrides", async () => {
    const { resolveHarnessConfig, resolveProjectBank } = await hindsight();
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hindsight-harness-")));
    const raw = { mapPathToBank: { [root]: "base" }, harnesses: { codex: { mapPathToBank: { [root]: "codex" } } } };
    expect(resolveProjectBank(resolveHarnessConfig(raw, "pi"), root).bankId).toBe("base");
    expect(resolveProjectBank(resolveHarnessConfig(raw, "codex"), root).bankId).toBe("codex");
    expect(() => resolveHarnessConfig(raw, "unknown")).toThrow("supported Hindsight harness");
  });

  it("keeps ordinary Executor connections and excludes every memory bank", async () => {
    const { desiredConnectionPatterns } = await executor();
    expect(desiredConnectionPatterns([
      { address: "tools.github.org.courier", integration: "github" },
      { address: "tools.linear.user.courier", integration: "linear" },
      { address: "tools.hindsight.org.default", integration: "hindsight" },
      { address: "tools.hindsight-bank-aaaaaaaaaaaaaaaa.user.default", integration: "hindsight-bank-aaaaaaaaaaaaaaaa" },
      { address: "tools.hindsight-bank-bbbbbbbbbbbbbbbb.user.default", integration: "hindsight-bank-bbbbbbbbbbbbbbbb" },
    ])).toEqual(["github.org.courier.*", "linear.user.courier.*"]);
  });

  it("preserves the generic Executor tools and their request/results", async () => {
    const { createProxyHandlers, executorToolkitUrl } = await executor();
    let forwarded: unknown;
    const upstream = {
      listTools: async () => ({ tools: ["execute", "skills", "resume"].map(name => ({ name })) }),
      callTool: async (params: unknown) => { forwarded = params; return { content: [{ type: "text", text: "ok" }] }; },
    };
    const handlers = createProxyHandlers(async () => upstream);
    expect(executorToolkitUrl("https://executor.example/mcp/toolkits/coding-agents")).toBe("https://executor.example/mcp/toolkits/coding-agents?artifacts=false");
    expect((await handlers.listTools()).tools.map(({ name }: { name: string }) => name)).toEqual(["execute", "skills", "resume"]);
    const params = { name: "execute", arguments: { code: "return 1" } };
    expect(await handlers.callTool({ params })).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(forwarded).toEqual(params);
  });

  it("reconnects once after the server forgets the session (HTTP 404), then returns the replay", async () => {
    const { createProxyHandlers } = await executor();
    const calls: unknown[] = [];
    let connects = 0;
    const clients = [
      { callTool: async (params: unknown) => { calls.push(params); throw sessionLost(); } },
      { callTool: async (params: unknown) => { calls.push(params); return { content: [{ type: "text", text: "ok" }] }; } },
    ];
    const handlers = createProxyHandlers(async () => clients[connects++]);
    const params = { name: "execute", arguments: { code: "1" } };
    expect(await handlers.callTool({ params })).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(connects).toBe(2);
    expect(calls).toEqual([params, params]);
  });

  it("drops the cached client when its transport closes so the next call reconnects", async () => {
    const { createProxyHandlers } = await executor();
    let connects = 0;
    const clients: Array<{ callTool: () => Promise<unknown>; onclose?: () => void }> = [];
    const handlers = createProxyHandlers(async () => {
      connects += 1;
      const client = { callTool: async () => ({ ok: true }) };
      clients.push(client);
      return client;
    });
    await handlers.callTool({ params: {} });
    await handlers.callTool({ params: {} });
    expect(connects).toBe(1);
    clients[0]!.onclose!();
    await handlers.callTool({ params: {} });
    expect(connects).toBe(2);
  });

  it("propagates a failure on the replayed call instead of retrying in a loop", async () => {
    const { createProxyHandlers } = await executor();
    let connects = 0;
    const errors = [
      sessionLost(),
      Object.assign(new Error("Connection closed"), { code: -32000 }),
    ];
    const handlers = createProxyHandlers(async () => { connects += 1; return { callTool: async () => { throw errors[Math.min(connects - 1, errors.length - 1)]; } }; });
    await expect(handlers.callTool({ params: {} })).rejects.toMatchObject({ code: -32000 });
    expect(connects).toBe(2);
  });

  it("never replays a mid-flight connection close — the mutating call may already have run", async () => {
    const { createProxyHandlers } = await executor();
    let connects = 0;
    const calls: unknown[] = [];
    const clients = [
      { callTool: async (params: unknown) => { calls.push(params); throw Object.assign(new Error("Connection closed"), { code: -32000 }); } },
      { callTool: async (params: unknown) => { calls.push(params); return { ok: true }; } },
    ];
    const handlers = createProxyHandlers(async () => clients[connects++]);
    const params = { name: "execute", arguments: { code: "mutate()" } };
    await expect(handlers.callTool({ params })).rejects.toMatchObject({ code: -32000 });
    // The original error returns unreplayed: the request may have executed.
    expect(connects).toBe(1);
    expect(calls).toEqual([params]);
    // The dead client was still dropped, so the next call reconnects fresh.
    expect(await handlers.callTool({ params })).toEqual({ ok: true });
    expect(connects).toBe(2);
  });

  it("keeps the session and never replays on a client-side request timeout (McpError -32001)", async () => {
    const { createProxyHandlers } = await executor();
    let connects = 0;
    const calls: unknown[] = [];
    const client = {
      callTool: async (params: unknown) => {
        calls.push(params);
        if (calls.length === 1) throw Object.assign(new Error("Request timed out"), { code: -32001 });
        return { ok: true };
      },
    };
    const handlers = createProxyHandlers(async () => { connects += 1; return client; });
    const params = { name: "execute", arguments: { code: "mutate()" } };
    await expect(handlers.callTool({ params })).rejects.toMatchObject({ code: -32001, message: "Request timed out" });
    expect(calls).toEqual([params]);
    // A timeout says nothing about the session: the next call reuses it.
    expect(await handlers.callTool({ params })).toEqual({ ok: true });
    expect(connects).toBe(1);
  });

  it("re-initializes over the real SDK transport after the server restarts, running the call once", async () => {
    const { createProxyHandlers } = await executor();
    let sessions = new Map<string, StreamableHTTPServerTransport>();
    let initializations = 0;
    let executions = 0;
    const readBody = async (req: IncomingMessage) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      return chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString("utf8"));
    };
    const http = createServer((req, res) => void (async () => {
      const body = await readBody(req);
      const id = req.headers["mcp-session-id"];
      let transport = typeof id === "string" ? sessions.get(id) : undefined;
      if (transport === undefined) {
        // Executor's own answer to a session it does not know.
        if (id !== undefined || !isInitializeRequest(body)) {
          res.writeHead(404, { "content-type": "application/json" }).end(UNKNOWN_SESSION_BODY);
          return;
        }
        initializations += 1;
        const fresh = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: (sid) => { sessions.set(sid, fresh); } });
        const server = new Server({ name: "executor-fake", version: "0" }, { capabilities: { tools: {} } });
        server.setRequestHandler(CallToolRequestSchema, async () => { executions += 1; return { content: [{ type: "text", text: `run ${executions}` }] }; });
        await server.connect(fresh);
        transport = fresh;
      }
      await transport.handleRequest(req, res, body);
    })());
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`);
    const clients: Client[] = [];
    const handlers = createProxyHandlers(async () => {
      const client = new Client({ name: "proxy-test", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(url));
      clients.push(client);
      return client;
    });
    try {
      const params = { name: "execute", arguments: { code: "mutate()" } };
      expect(await handlers.callTool({ params })).toMatchObject({ content: [{ text: "run 1" }] });
      // Daemon restart: every session the server knew is gone.
      for (const transport of sessions.values()) await transport.close();
      sessions = new Map();
      expect(await handlers.callTool({ params })).toMatchObject({ content: [{ text: "run 2" }] });
      expect(initializations).toBe(2);
      expect(executions).toBe(2);
    } finally {
      await handlers.close();
      for (const client of clients) await client.close();
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
    }
  });

  it("keeps a concurrently reconnected client when a late loss lands on the superseded one", async () => {
    const { createProxyHandlers } = await executor();
    let connects = 0;
    const rejecters: Array<(error: Error) => void> = [];
    const replayed: unknown[] = [];
    const clients = [
      { callTool: () => new Promise((_resolve, reject) => { rejecters.push(reject); }) },
      { callTool: async (params: unknown) => { replayed.push(params); return { ok: true }; } },
    ];
    const handlers = createProxyHandlers(async () => clients[connects++]);
    const first = handlers.callTool({ params: { name: "execute", arguments: { n: 1 } } });
    const second = handlers.callTool({ params: { name: "execute", arguments: { n: 2 } } });
    await vi.waitFor(() => expect(rejecters).toHaveLength(2));
    // The first failure reconnects and replays before the superseded client's
    // second rejection lands; that late loss must not evict the healthy client.
    rejecters[0]!(sessionLost());
    await expect(first).resolves.toEqual({ ok: true });
    rejecters[1]!(sessionLost());
    await expect(second).resolves.toEqual({ ok: true });
    expect(connects).toBe(2);
    expect(replayed).toHaveLength(2);
    // The survivor is still cached: a later call pays no reconnect.
    expect(await handlers.callTool({ params: { name: "execute", arguments: { n: 3 } } })).toEqual({ ok: true });
    expect(connects).toBe(2);
  });

  it("propagates non-transport errors without reconnecting", async () => {
    const { createProxyHandlers } = await executor();
    let connects = 0;
    const failures = [Object.assign(new Error("invalid params"), { code: -32602 }), "plain failure", { code: "string-code" }];
    for (const failure of failures) {
      const handlers = createProxyHandlers(async () => { connects += 1; return { callTool: async () => { throw failure; } }; });
      await expect(handlers.callTool({ params: {} })).rejects.toBe(failure);
    }
    expect(connects).toBe(3);
  });

  it("coalesces concurrent first calls into one connection and close() ends the cached upstream", async () => {
    const { createProxyHandlers } = await executor();
    let connects = 0;
    let closed = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const handlers = createProxyHandlers(async () => {
      connects += 1;
      await gate;
      return { callTool: async () => ({}), listTools: async () => ({ tools: [] }), close: async () => { closed = true; } };
    });
    const pending = Promise.all([handlers.callTool({ params: {} }), handlers.listTools()]);
    release();
    await pending;
    expect(connects).toBe(1);
    await handlers.close();
    expect(closed).toBe(true);
  });
});

describe("hindsight wrapper process replacement", () => {
  function boundLane() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hindsight-main-")));
    const workdir = join(root, "lane");
    mkdirSync(workdir, { recursive: true });
    const config = join(root, "config.json");
    writeFileSync(config, JSON.stringify({ mapPathToBank: { [root]: "bank" } }));
    const argv = process.argv;
    process.argv = [argv[0]!, argv[1]!, "pi"];
    vi.stubEnv("HINDSIGHT_CONFIG", config);
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(workdir);
    return { workdir, restore: () => { process.argv = argv; vi.unstubAllEnvs(); cwd.mockRestore(); } };
  }

  it("execve-replaces the wrapper with the real server on the canonical cwd", async () => {
    const { main } = await hindsight();
    const { workdir, restore } = boundLane();
    const chdir = vi.spyOn(process, "chdir").mockImplementation(() => {});
    const execve = vi.spyOn(process, "execve").mockImplementation(() => undefined as never);
    try {
      main();
      expect(chdir).toHaveBeenCalledWith(workdir);
      expect(execve).toHaveBeenCalledWith(
        process.execPath,
        [process.execPath, expect.stringContaining("mcp-server.js")],
        expect.objectContaining({ HINDSIGHT_MCP_PROJECT_CWD: workdir, HINDSIGHT_MCP_HARNESS: "pi" }),
      );
      expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    } finally {
      chdir.mockRestore();
      execve.mockRestore();
      restore();
    }
  });

  it("keeps the spawn shim only for Node versions without execve", async () => {
    const { main } = await hindsight();
    const { workdir, restore } = boundLane();
    const descriptor = Object.getOwnPropertyDescriptor(process, "execve")!;
    Object.defineProperty(process, "execve", { configurable: true, writable: true, value: undefined });
    try {
      main();
      expect(vi.mocked(spawn)).toHaveBeenCalledWith(
        process.execPath,
        [expect.stringContaining("mcp-server.js")],
        expect.objectContaining({ cwd: workdir, stdio: "inherit", env: expect.objectContaining({ HINDSIGHT_MCP_HARNESS: "pi" }) }),
      );
    } finally {
      Object.defineProperty(process, "execve", descriptor);
      restore();
    }
  });
});
