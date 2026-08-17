import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HerdrCli, type PiExec } from "../../src/cli.js";
import { JobRegistry } from "../../src/job-registry.js";
import { RuntimeOwnership } from "../../src/ownership.js";
import { createPreflight, createToolSurface } from "../../src/tool-surface.js";
import { createCommunicateTool } from "../../src/tools/communicate.js";
import { createLaunchTool } from "../../src/tools/launch.js";
import { HOST_FIELDS, HostCapabilityError, StartupRefusal, createNodeExec, hostContext, resolveStartup, type ChildProcessLike, type SpawnLike } from "../../src/mcp/host.js";

const snapshot = {
  type: "session_snapshot",
  snapshot: {
    version: "1",
    protocol: 1,
    workspaces: [{ workspace_id: "w", label: "w" }],
    tabs: [{ tab_id: "w:t", workspace_id: "w", label: "t" }],
    panes: [
      { pane_id: "w:p", tab_id: "w:t", workspace_id: "w", label: "caller", agent_name: "caller", agent_status: "idle" },
      { pane_id: "w:p2", tab_id: "w:t", workspace_id: "w", label: "worker", agent_name: "worker", agent_status: "idle" }
    ],
    agents: [{ pane_id: "w:p", name: "caller", agent_status: "idle" }, { pane_id: "w:p2", name: "worker", agent_status: "idle" }]
  }
};
const health = { client: { version: "0.8.0", protocol: 19 }, server: { status: "running", version: "0.8.0", protocol: 19, compatible: true } };
const context = { workspaceId: "w", tabId: "w:t", paneId: "w:p" };
const validEnv = { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w", HERDR_TAB_ID: "w:t", HERDR_PANE_ID: "w:p" };

function fakeCli(): HerdrCli {
  const envelope = (id: string, result: unknown) => ({ stdout: JSON.stringify({ id, result }), stderr: "", code: 0, killed: false });
  const exec: PiExec = async (_command, argv) => {
    if (argv[0] === "status") return { stdout: JSON.stringify(health), stderr: "", code: 0, killed: false };
    if (argv[0] === "api") return envelope("snapshot", snapshot);
    if (argv[0] === "pane" && argv[1] === "get") return envelope("pane", { pane: snapshot.snapshot.panes.find((pane) => pane.pane_id === argv[2]) });
    if (argv[0] === "pane" && argv[1] === "read") return { stdout: "output", stderr: "", code: 0, killed: false };
    return envelope("other", { ok: true });
  };
  return new HerdrCli(exec);
}

function recordingHost(signal: AbortSignal): { host: { cwd: string; signal: AbortSignal }; reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    host: {
      get cwd() { reads.push("cwd"); return "/project"; },
      get signal() { reads.push("signal"); return signal; }
    }
  };
}

class FakeStream {
  listener?: (chunk: unknown) => void;
  destroyed = false;
  on(_event: "data", listener: (chunk: unknown) => void): this {
    this.listener = listener;
    return this;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

class FakeChild implements ChildProcessLike {
  readonly stdout: FakeStream | null;
  readonly stderr: FakeStream | null;
  readonly signals: string[] = [];
  private readonly handlers = new Map<string, (value: never) => void>();

  constructor(withStreams = true) {
    this.stdout = withStreams ? new FakeStream() : null;
    this.stderr = withStreams ? new FakeStream() : null;
  }

  once(event: "error" | "exit" | "close", listener: (value: never) => void): this {
    this.handlers.set(event, listener);
    return this;
  }

  kill(signal: "SIGTERM" | "SIGKILL"): boolean {
    this.signals.push(signal);
    return true;
  }

  fire(event: "error" | "exit" | "close", value?: unknown): void {
    this.handlers.get(event)?.(value as never);
  }
}

function spawnFake(child: ChildProcessLike): { spawn: SpawnLike; options: Array<{ cwd: string }> } {
  const options: Array<{ cwd: string }> = [];
  return {
    options,
    spawn: (_command, _args, spawnOptions) => {
      options.push({ cwd: spawnOptions.cwd });
      return child;
    }
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("MCP host capability proxy", () => {
  it("exposes only the working directory and cancellation signal", () => {
    const signal = new AbortController().signal;
    const ctx = hostContext({ cwd: "/project", signal });
    expect(HOST_FIELDS).toEqual(["cwd", "signal"]);
    expect(ctx.cwd).toBe("/project");
    expect(ctx.signal).toBe(signal);
    expect((ctx as unknown as Record<symbol, unknown>)[Symbol.toPrimitive]).toBeUndefined();
    expect(() => ctx.modelRegistry).toThrowError(HostCapabilityError);
    try {
      void ctx.modelRegistry;
    } catch (error) {
      expect(error).toMatchObject({ code: "HOST_CAPABILITY_UNAVAILABLE", name: "HostCapabilityError" });
      expect((error as Error).message).toContain("modelRegistry");
    }
    expect(() => (ctx as unknown as { sendMessage: unknown }).sendMessage).toThrowError(HostCapabilityError);
    expect(() => (ctx as unknown as { ui: unknown }).ui).toThrowError(HostCapabilityError);
  });

  it("proves the seven shared tools read no other host field", async () => {
    const signal = new AbortController().signal;
    const { host, reads } = recordingHost(signal);
    const cli = fakeCli();
    const surface = createToolSurface({
      cli,
      context,
      environment: { enabled: true, currentIdsPresent: true, currentIdsValid: true },
      preflight: createPreflight(cli),
      settingsLoader: async () => ({ reviewCadenceMinutes: 30, reviewerModel: "luna", reviewerThinking: "low" }),
      jobs: new JobRegistry(),
      profiles: { load: async () => ({ effective: new Map(), candidates: [], diagnostics: [] }) as never },
      ownership: new RuntimeOwnership(),
      cwd: "/project",
      reviewerFactory: () => { throw new Error("unused"); }
    });
    const args: Record<string, unknown> = {
      herdr_inspect: { mode: "context" },
      herdr_communicate: { target: "w:p2", operation: "prompt", text: "hello" },
      herdr_wait: { targets: ["w:p2"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 5 },
      herdr_jobs: { operation: "list" },
      herdr_launch: { name: "worker", profile: "worker-pi" },
      herdr_pane: { operation: "focus", target: "w:p2" },
      herdr_tab: { operation: "focus", target: "w:t" }
    };
    for (const definition of surface.definitions) {
      await definition.execute("id", args[definition.name], signal, undefined, hostContext(host)).catch(() => undefined);
    }
    expect([...new Set(reads)].sort()).toEqual([]);

    // The proxy must still serve both fields when a tool falls back to the host.
    const fallbackCommunicate = createCommunicateTool({ cli, context, preflight: createPreflight(cli) });
    await fallbackCommunicate.execute("id", { target: "w:p2", operation: "keys", keys: ["enter"] } as never, undefined, undefined, hostContext(host));
    const fallbackLaunch = createLaunchTool({ cli, context, preflight: createPreflight(cli) });
    await fallbackLaunch.execute("id", { name: "worker", profile: "worker-pi" } as never, signal, undefined, hostContext(host)).catch(() => undefined);
    expect([...new Set(reads)].sort()).toEqual(["cwd", "signal"]);
  });
});

describe("MCP startup gating", () => {
  const directory = mkdtempSync(join(tmpdir(), "herdr-mcp-host-"));
  const file = join(directory, "not-a-directory");
  writeFileSync(file, "");

  it("resolves the injected context and project directory in order", async () => {
    await expect(resolveStartup({ env: { ...validEnv, CLAUDE_PROJECT_DIR: directory } })).resolves.toEqual({
      context,
      environment: { enabled: true, currentIdsPresent: true, currentIdsValid: true },
      projectDir: directory
    });
  });

  it("refuses without HERDR_ENV, without valid injected identity, and without a usable project directory", async () => {
    const refusals: Array<[NodeJS.ProcessEnv, string]> = [
      [{ CLAUDE_PROJECT_DIR: directory }, "HERDR_ENV"],
      [{ HERDR_ENV: "0", CLAUDE_PROJECT_DIR: directory }, "HERDR_ENV"],
      [{ HERDR_ENV: "1", CLAUDE_PROJECT_DIR: directory }, "INJECTED_CONTEXT"],
      [{ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w", HERDR_TAB_ID: "w:t", HERDR_PANE_ID: "bad\npane", CLAUDE_PROJECT_DIR: directory }, "INJECTED_CONTEXT"],
      [{ ...validEnv }, "CLAUDE_PROJECT_DIR"],
      [{ ...validEnv, CLAUDE_PROJECT_DIR: "" }, "CLAUDE_PROJECT_DIR"],
      [{ ...validEnv, CLAUDE_PROJECT_DIR: "relative/project" }, "CLAUDE_PROJECT_DIR"],
      [{ ...validEnv, CLAUDE_PROJECT_DIR: `${directory}\nother` }, "CLAUDE_PROJECT_DIR"],
      [{ ...validEnv, CLAUDE_PROJECT_DIR: join(directory, "missing") }, "CLAUDE_PROJECT_DIR"],
      [{ ...validEnv, CLAUDE_PROJECT_DIR: file }, "CLAUDE_PROJECT_DIR"]
    ];
    for (const [env, reason] of refusals) {
      const refusal = await resolveStartup({ env }).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(StartupRefusal);
      expect(refusal).toMatchObject({ code: "STARTUP_REFUSED", reason });
      expect((refusal as Error).message).not.toContain(directory);
    }
  });

  it("reads the ambient environment and a real directory stat by default", async () => {
    const original = { ...process.env };
    try {
      Object.assign(process.env, validEnv, { CLAUDE_PROJECT_DIR: directory });
      await expect(resolveStartup()).resolves.toMatchObject({ projectDir: directory });
    } finally {
      for (const key of ["HERDR_ENV", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID", "CLAUDE_PROJECT_DIR"]) {
        if (original[key] === undefined) delete process.env[key];
        else process.env[key] = original[key];
      }
    }
  });
});

describe("MCP node exec adapter", () => {
  it("resolves on close with the operational working directory and no shell", async () => {
    const child = new FakeChild();
    const { spawn, options } = spawnFake(child);
    const pending = createNodeExec({ cwd: "/project", spawn })("herdr", ["status", "--json"], {});
    child.stdout?.listener?.("out");
    child.stderr?.listener?.("err");
    child.fire("close", 0);
    await expect(pending).resolves.toEqual({ stdout: "out", stderr: "err", code: 0, killed: false });
    expect(options).toEqual([{ cwd: "/project" }]);
    expect(child.stdout?.destroyed).toBe(true);
    expect(child.stderr?.destroyed).toBe(true);
  });

  it("settles after exit when close never fires and keeps reading late output", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const { spawn } = spawnFake(child);
    const pending = createNodeExec({ cwd: "/project", spawn })("herdr", ["api", "snapshot"], {});
    child.fire("exit", 0);
    await vi.advanceTimersByTimeAsync(50);
    child.stdout?.listener?.("late");
    child.stderr?.listener?.("also late");
    await vi.advanceTimersByTimeAsync(50);
    child.stdout?.listener?.("later still");
    await vi.advanceTimersByTimeAsync(200);
    await expect(pending).resolves.toEqual({ stdout: "latelater still", stderr: "also late", code: 0, killed: false });
  });

  it("treats a spawn error and a missing exit code as a failed process", async () => {
    const failing = new FakeChild(false);
    const errored = createNodeExec({ cwd: "/project", spawn: spawnFake(failing).spawn })("herdr", ["status"], {});
    failing.fire("error", new Error("spawn herdr ENOENT"));
    await expect(errored).resolves.toEqual({ stdout: "", stderr: "", code: 1, killed: false });
    const child = new FakeChild();
    const pending = createNodeExec({ cwd: "/project", spawn: spawnFake(child).spawn })("herdr", ["status"], {});
    child.fire("close", null);
    await expect(pending).resolves.toMatchObject({ code: 0, killed: false });
  });

  it("kills on timeout and escalates to SIGKILL once", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const pending = createNodeExec({ cwd: "/project", spawn: spawnFake(child).spawn })("herdr", ["agent", "start"], { timeout: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.signals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    child.fire("close", 143);
    await expect(pending).resolves.toEqual({ stdout: "", stderr: "", code: 143, killed: true });
  });

  it("kills for an already aborted signal and for an abort during execution", async () => {
    vi.useFakeTimers();
    const preAborted = new AbortController();
    preAborted.abort();
    const first = new FakeChild();
    const pendingFirst = createNodeExec({ cwd: "/project", spawn: spawnFake(first).spawn })("herdr", ["status"], { signal: preAborted.signal, timeout: 10 });
    expect(first.signals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(10);
    expect(first.signals).toEqual(["SIGTERM"]);
    first.fire("close", 1);
    await expect(pendingFirst).resolves.toMatchObject({ killed: true });
    vi.useRealTimers();

    const controller = new AbortController();
    const second = new FakeChild();
    const pendingSecond = createNodeExec({ cwd: "/project", spawn: spawnFake(second).spawn })("herdr", ["status"], { signal: controller.signal });
    controller.abort();
    controller.abort();
    expect(second.signals).toEqual(["SIGTERM"]);
    second.fire("close", 1);
    second.fire("close", 1);
    await expect(pendingSecond).resolves.toMatchObject({ code: 1, killed: true });
  });

  it("executes a real process with the default spawn", async () => {
    const exec = createNodeExec({ cwd: tmpdir() });
    await expect(exec(process.execPath, ["-e", "process.stdout.write(process.cwd())"], { timeout: 10_000 })).resolves.toMatchObject({ code: 0, killed: false, stdout: expect.stringContaining(tmpdir()) as unknown as string });
  });
});
