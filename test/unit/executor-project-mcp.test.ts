import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn(() => ({ on: vi.fn(), kill: vi.fn() })) }));

const scripts = join(process.cwd(), "herdr-profiles/profile-plugins/executor/scripts");
const executor = () => import(pathToFileURL(join(scripts, "executor-project-mcp.mjs")).href);
const hindsight = () => import(pathToFileURL(join(scripts, "hindsight-project-mcp.mjs")).href);

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

  it("reconnects once after a transport-level session loss, then returns the retry", async () => {
    const { createProxyHandlers } = await executor();
    const calls: unknown[] = [];
    let connects = 0;
    const sessionLost = () => Object.assign(new Error("Session not found"), { code: -32001 });
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

  it("propagates a second transport loss instead of retrying in a loop", async () => {
    const { createProxyHandlers } = await executor();
    let connects = 0;
    const errors = [
      Object.assign(new Error("Connection closed"), { code: -32000 }),
      Object.assign(new Error("Session not found"), { code: -32001 }),
    ];
    const handlers = createProxyHandlers(async () => { connects += 1; return { callTool: async () => { throw errors[Math.min(connects - 1, errors.length - 1)]; } }; });
    await expect(handlers.callTool({ params: {} })).rejects.toMatchObject({ code: -32001 });
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
