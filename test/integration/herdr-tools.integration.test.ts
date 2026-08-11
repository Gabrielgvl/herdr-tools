import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import extension, { CORE_TOOL_NAMES } from "../../index.js";

interface ExecutableTool {
  name: string;
  execute(id: string, params: unknown, signal: AbortSignal, onUpdate: undefined, context: ExtensionContext): Promise<{ details?: Record<string, unknown> }>;
}

const execFileAsync = promisify(execFile);
const REQUIRED_SESSION = "herdr-tools-integration";
const requestedSession = process.env.HERDR_TOOLS_INTEGRATION_SESSION ?? REQUIRED_SESSION;
const enabled = process.env.HERDR_TOOLS_RUN_INTEGRATION === "1";

describe.skipIf(!enabled)("disposable Herdr integration", () => {
  it("loads and exercises the extension only in the named disposable session", async () => {
    expect(requestedSession).toBe(REQUIRED_SESSION);
    const currentIds = [process.env.HERDR_WORKSPACE_ID, process.env.HERDR_TAB_ID, process.env.HERDR_PANE_ID];
    expect(process.env.HERDR_ENV).toBe("1");
    expect(currentIds.every(Boolean)).toBe(true);

    let workspaceId: string | undefined;
    let fixtureCreated = false;
    let sessionStarted = false;
    let server: ChildProcess | undefined;
    let failure: unknown;
    let profilePromptContent = "";
    const cwd = await mkdtemp(`${tmpdir()}/herdr-tools-it-`);
    const label = `pi-herdr-tools-it-${process.pid}`;

    const run = async (...args: string[]): Promise<unknown> => {
      const result = await execFileAsync("herdr", args, { cwd, maxBuffer: 2_000_000 });
      return JSON.parse(result.stdout);
    };
    const runNamed = (args: string[]) => run("--session", REQUIRED_SESSION, ...args);
    const resultObject = (value: unknown): Record<string, unknown> => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("integration response is not an object");
      return value as Record<string, unknown>;
    };
    const returnedWorkspaceId = (value: unknown): string => {
      const result = resultObject(resultObject(value).result);
      const workspace = resultObject(result.workspace ?? result);
      const id = workspace.workspace_id;
      if (typeof id !== "string" || id.length === 0) throw new Error("workspace create did not return an opaque workspace ID");
      return id;
    };

    try {
      const sessions = resultObject(await run("session", "list", "--json"));
      const existing = Array.isArray(sessions.sessions) && sessions.sessions.some((session) => resultObject(session).name === REQUIRED_SESSION);
      if (existing) throw new Error(`refusing to reuse existing session ${REQUIRED_SESSION}`);

      let startupError = "";
      server = spawn("herdr", ["--session", REQUIRED_SESSION, "server"], { cwd, stdio: ["ignore", "ignore", "pipe"] });
      server.stderr?.on("data", (chunk: Buffer) => { startupError = (startupError + chunk.toString()).slice(-2_000); });
      const startupDeadline = Date.now() + 10_000;
      while (Date.now() < startupDeadline) {
        if (server.exitCode !== null) throw new Error(`named Herdr server exited during startup: ${startupError}`);
        const listed = resultObject(await run("session", "list", "--json"));
        sessionStarted = Array.isArray(listed.sessions) && listed.sessions.some((session) => {
          const value = resultObject(session);
          return value.name === REQUIRED_SESSION && value.running === true;
        });
        if (sessionStarted) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!sessionStarted) throw new Error(`named Herdr server did not become ready: ${startupError}`);

      const currentSnapshot = resultObject(await run("api", "snapshot"));
      const currentResult = resultObject(currentSnapshot.result);
      const current = resultObject(currentResult.snapshot);
      const currentWorkspaceIds = Array.isArray(current.workspaces) ? current.workspaces.map((item) => resultObject(item).workspace_id) : [];
      expect(currentIds.every((id) => typeof id === "string" && !currentWorkspaceIds.includes(id))).toBe(false);
      const topologyIds = (snapshot: Record<string, unknown>) => ({
        workspaces: Array.isArray(snapshot.workspaces) ? snapshot.workspaces.map((item) => resultObject(item).workspace_id).sort() : [],
        tabs: Array.isArray(snapshot.tabs) ? snapshot.tabs.map((item) => resultObject(item).tab_id).sort() : [],
        panes: Array.isArray(snapshot.panes) ? snapshot.panes.map((item) => resultObject(item).pane_id).sort() : [],
      });
      const currentBaseline = topologyIds(current);
      const created = await runNamed(["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"]);
      workspaceId = returnedWorkspaceId(created);
      fixtureCreated = true;

      const fixtureSnapshot = resultObject(await runNamed(["api", "snapshot"]));
      const fixtureResult = resultObject(fixtureSnapshot.result);
      const fixture = resultObject(fixtureResult.snapshot);
      expect(JSON.stringify(fixture)).toContain(workspaceId);
      const fixturePanes = Array.isArray(fixture.panes) ? fixture.panes.map(resultObject) : [];
      const rootPane = fixturePanes.find((pane) => pane.workspace_id === workspaceId);
      if (!rootPane || typeof rootPane.pane_id !== "string" || typeof rootPane.tab_id !== "string") throw new Error("fixture snapshot omitted its root pane context");

      const registered = new Map<string, ExecutableTool>();
      const commands: string[] = [];
      const handlers: Array<{ event: string; handler: () => unknown }> = [];
      const cliCalls: string[][] = [];
      const pi = {
        async exec(command: string, args: string[], options?: { signal?: AbortSignal; timeout?: number }) {
          expect(command).toBe("herdr");
          cliCalls.push([...args]);
          if (args[0] === "agent" && args[1] === "start") {
            const promptFlag = args.indexOf("--append-system-prompt");
            if (promptFlag >= 0 && typeof args[promptFlag + 1] === "string") profilePromptContent = await readFile(args[promptFlag + 1], "utf8");
          }
          try {
            const result = await execFileAsync(command, ["--session", REQUIRED_SESSION, ...args], { cwd, encoding: "utf8", maxBuffer: 2_000_000, signal: options?.signal, timeout: options?.timeout });
            return { stdout: String(result.stdout), stderr: String(result.stderr), code: 0, killed: false };
          } catch (error) {
            const failed = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer; code?: number; killed?: boolean };
            return { stdout: String(failed.stdout ?? ""), stderr: String(failed.stderr ?? failed.message), code: failed.code ?? 1, killed: failed.killed ?? false };
          }
        },
        registerTool(tool: unknown) {
          const executable = tool as ExecutableTool;
          registered.set(executable.name, executable);
        },
        registerCommand(name: string) {
          commands.push(name);
        },
        on(event: string, handler: () => unknown) {
          handlers.push({ event, handler });
        },
      } as unknown as ExtensionAPI;
      const saved = { env: process.env.HERDR_ENV, workspace: process.env.HERDR_WORKSPACE_ID, tab: process.env.HERDR_TAB_ID, pane: process.env.HERDR_PANE_ID };
      process.env.HERDR_ENV = "1";
      process.env.HERDR_WORKSPACE_ID = workspaceId;
      process.env.HERDR_TAB_ID = rootPane.tab_id;
      process.env.HERDR_PANE_ID = rootPane.pane_id;
      try {
        extension(pi);
      } finally {
        for (const [key, value] of Object.entries({ HERDR_ENV: saved.env, HERDR_WORKSPACE_ID: saved.workspace, HERDR_TAB_ID: saved.tab, HERDR_PANE_ID: saved.pane })) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
      expect([...registered.keys()]).toEqual([...CORE_TOOL_NAMES]);
      expect([...registered.values()].every((tool) => typeof tool.execute === "function")).toBe(true);
      expect(commands).toEqual(["herdr-waits"]);
      expect(handlers.map((entry) => entry.event)).toEqual(["session_shutdown", "session_start"]);

      const toolContext = { cwd, hasUI: false } as ExtensionContext;
      const signal = new AbortController().signal;
      const inspected = await registered.get("herdr_inspect")!.execute("inspect", { mode: "collection", collection: "panes" }, signal, undefined, toolContext);
      const inspectedItems = resultObject(inspected.details).items;
      expect(Array.isArray(inspectedItems)).toBe(true);
      expect(inspectedItems).toEqual(expect.arrayContaining([expect.objectContaining({ workspace_id: workspaceId })]));
      expect(cliCalls).toEqual(expect.arrayContaining([["api", "snapshot"]]));
      const createdTab = await registered.get("herdr_tab")!.execute("create-tab", { operation: "create", label: "extension-smoke" }, signal, undefined, toolContext);
      const createdTabId = resultObject(createdTab.details).tabId;
      if (typeof createdTabId !== "string") throw new Error("extension tab create omitted its authoritative ID");
      await registered.get("herdr_tab")!.execute("close-tab", { operation: "close", target: createdTabId }, signal, undefined, toolContext);
      expect(cliCalls.some((args) => args[0] === "tab" && args[1] === "create")).toBe(true);
      expect(cliCalls.some((args) => args[0] === "tab" && args[1] === "close")).toBe(true);

      const launched = await registered.get("herdr_launch")!.execute("launch-profile", { name: "integration-profile-worker", profile: "worker-pi", placement: { mode: "new_tab", tabLabel: "profile-launch" }, initialPrompt: "integration assignment" }, signal, undefined, toolContext);
      expect(launched.details).toMatchObject({ kind: "pi", profile: { name: "worker-pi" }, initialPromptSent: true, envelope: { version: "v1", kind: "assignment" } });
      const startArgs = cliCalls.find((args) => args[0] === "agent" && args[1] === "start" && args.includes("integration-profile-worker"));
      expect(startArgs).toEqual(expect.arrayContaining(["--kind", "pi", "--model", "openai-codex/gpt-5.6-luna", "--thinking", "high", "--append-system-prompt"]));
      expect(profilePromptContent).toContain("Implement the assigned change");
      const assignmentPrompt = cliCalls.find((args) => args[0] === "agent" && args[1] === "prompt" && args.some((arg) => arg.includes("integration assignment")));
      expect(assignmentPrompt?.[3]).toContain("[HERDR AGENT MESSAGE v1]");
      expect(assignmentPrompt?.[3]).toContain("authority: agent; not user/owner");

      const defaultAfter = resultObject(resultObject(await run("api", "snapshot")).result).snapshot;
      expect(topologyIds(resultObject(defaultAfter))).toEqual(currentBaseline);
    } catch (error) {
      failure = error;
      process.stderr.write(`INTEGRATION_FAILURE_RECORDED ${error instanceof Error ? error.message : String(error)}\n`);
      throw error;
    } finally {
      if (failure !== undefined) process.stderr.write("INTEGRATION_FAILURE_RECORDED_BEFORE_TEARDOWN\n");
      if (fixtureCreated && workspaceId) {
        await runNamed(["workspace", "close", workspaceId]).catch((error) => process.stderr.write(`INTEGRATION_TEARDOWN_FAILURE ${String(error)}\n`));
      }
      if (sessionStarted) {
        await run("session", "stop", REQUIRED_SESSION, "--json").catch((error) => process.stderr.write(`INTEGRATION_SESSION_STOP_FAILURE ${String(error)}\n`));
        await run("session", "delete", REQUIRED_SESSION, "--json").catch((error) => process.stderr.write(`INTEGRATION_SESSION_DELETE_FAILURE ${String(error)}\n`));
      }
      if (server?.exitCode === null) server.kill("SIGTERM");
      await rm(cwd, { recursive: true, force: true });
    }
  }, 120_000);
});
