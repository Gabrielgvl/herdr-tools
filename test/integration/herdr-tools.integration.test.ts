import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import extension, { CORE_TOOL_NAMES } from "../../index.js";
import { spawnWithStdin } from "../../src/exec-stdin.js";

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
    const attachmentPaths: string[] = [];
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
      const stdinCalls: Array<{ args: string[]; input: string }> = [];
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
        // Stdin deliveries must reach the same disposable named session as pi.exec.
        async execStdin(command: string, args: string[], input: string, options?: { signal?: AbortSignal; timeout?: number }) {
          expect(command).toBe("herdr");
          cliCalls.push([...args]);
          stdinCalls.push({ args: [...args], input });
          return spawnWithStdin(command, ["--session", REQUIRED_SESSION, ...args], input, { signal: options?.signal, timeout: options?.timeout });
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
      /**
       * A headless named session accepts prompt submission but cannot always drive an
       * agent into `working`, so wrapped-text deliveries are asserted on invariants that
       * hold either way: the published artifact, the envelope, and the transport. The
       * observed mode is always recorded.
       */
      const delivery = async (label: string, call: Promise<{ details?: Record<string, unknown> }>): Promise<Record<string, unknown>> => {
        try {
          const result = await call;
          process.stderr.write(`INTEGRATION_DELIVERY_CONFIRMED ${label}\n`);
          return resultObject(result.details);
        } catch (error) {
          const failure = error as { code?: string; details?: Record<string, unknown> };
          if (failure.code === "ATTACHMENT_TARGET_UNVERIFIED" || failure.code === "INVALID_INPUT" || failure.details === undefined) throw error;
          process.stderr.write(`INTEGRATION_DELIVERY_UNCONFIRMED ${label} code=${String(failure.code)} phase=${String(failure.details.phase)}\n`);
          return failure.details;
        }
      };
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

      const inlineDetails = await delivery("pi-inline-launch", registered.get("herdr_launch")!.execute("launch-profile", { name: "integration-profile-worker", profile: "worker-pi", placement: { mode: "new_tab", tabLabel: "profile-launch" }, initialPrompt: "integration assignment" }, signal, undefined, toolContext));
      expect(inlineDetails).toMatchObject({ initialPromptDelivery: "inline" });
      const startArgs = cliCalls.find((args) => args[0] === "agent" && args[1] === "start" && args.includes("integration-profile-worker"));
      expect(startArgs).toEqual(expect.arrayContaining(["--kind", "pi", "--model", "openai-codex/gpt-5.6-luna", "--thinking", "high", "--append-system-prompt"]));
      expect(profilePromptContent).toContain("Implement the assigned change");

      // Wrapped text travels over the session-bound stdin transport, never argv.
      const inlinePaneId = String(inlineDetails.paneId ?? resultObject(inlineDetails.created).paneId);
      const inlineDelivery = stdinCalls.find((call) => call.input.includes("integration assignment"));
      expect(inlineDelivery?.args).toEqual(["agent", "prompt", inlinePaneId, "--stdin", "--wait", "--until", "working", "--timeout", "5000"]);
      expect(inlineDelivery?.input).toContain("[HERDR AGENT MESSAGE v1]");
      expect(inlineDelivery?.input).toContain("authority: agent; not user/owner");
      expect(inlineDelivery?.input).toContain("delivery: inline");
      expect(cliCalls.some((args) => args.some((arg) => arg.includes("integration assignment")))).toBe(false);

      // Pi attachment readback: the published artifact is exactly what the recipient reads.
      const piBody = `Read this attachment and stop without changing anything.\n${"detail line\n".repeat(200)}`;
      const piDetails = await delivery("pi-attachment-launch", registered.get("herdr_launch")!.execute("launch-pi-attachment", { name: "integration-pi-attach", profile: "worker-pi", placement: { mode: "new_tab", tabLabel: "pi-attachment" }, initialPrompt: piBody, initialPromptDelivery: "attachment" }, signal, undefined, toolContext));
      const piAttachment = resultObject(piDetails.attachment);
      attachmentPaths.push(String(piAttachment.path));
      expect(piDetails).toMatchObject({ initialPromptDelivery: "attachment" });
      expect(await readFile(String(piAttachment.path), "utf8")).toBe(piBody);
      expect(createHash("sha256").update(piBody, "utf8").digest("hex")).toBe(piAttachment.sha256);
      expect(piAttachment.bytes).toBe(Buffer.byteLength(piBody, "utf8"));
      expect((await stat(String(piAttachment.path))).mode & 0o777).toBe(0o600);
      const piEnvelope = stdinCalls.find((call) => call.input.includes(String(piAttachment.path)));
      expect(piEnvelope?.input).toContain("delivery: attachment");
      expect(piEnvelope?.input).toContain(`attachment-sha256: ${String(piAttachment.sha256)}`);
      expect(piEnvelope?.input).not.toContain("detail line");
      expect(cliCalls.some((args) => args.some((arg) => arg.includes("detail line")))).toBe(false);

      // Claude attachment readback inside the extension-owned --add-dir grant.
      const claudeLaunch = await registered.get("herdr_launch")!.execute("launch-claude", { name: "integration-claude-attach", profile: "worker-claude", placement: { mode: "new_tab", tabLabel: "claude-attachment" } }, signal, undefined, toolContext);
      const claudeDetails = resultObject(claudeLaunch.details);
      const claudePaneId = String(claudeDetails.paneId);
      expect(claudeDetails).toMatchObject({ recipient: { capable: true, kind: "claude", profileName: "worker-claude" } });
      const claudeStart = cliCalls.find((args) => args[0] === "agent" && args[1] === "start" && args.includes("integration-claude-attach"));
      const grantIndex = claudeStart!.indexOf("--add-dir");
      expect(grantIndex).toBeGreaterThan(0);
      const grantedDirectory = claudeStart![grantIndex + 1]!;
      expect((await stat(grantedDirectory)).mode & 0o777).toBe(0o700);
      const claudeBody = `Read this attachment and stop without changing anything.\n${"claude line\n".repeat(200)}`;
      const claudeSendDetails = await delivery("claude-attachment-send", registered.get("herdr_communicate")!.execute("send-claude-attachment", { target: claudePaneId, operation: "prompt", text: claudeBody, delivery: "attachment" }, signal, undefined, toolContext));
      const claudeAttachment = resultObject(claudeSendDetails.attachment);
      attachmentPaths.push(String(claudeAttachment.path));
      expect(claudeSendDetails).toMatchObject({ delivery: "attachment" });
      expect(dirname(dirname(String(claudeAttachment.path)))).toBe(grantedDirectory);
      expect(await readFile(String(claudeAttachment.path), "utf8")).toBe(claudeBody);
      const claudeEnvelope = stdinCalls.find((call) => call.input.includes(String(claudeAttachment.path)));
      expect(claudeEnvelope?.input).toContain("delivery: attachment");
      expect(claudeEnvelope?.input).not.toContain("claude line");

      // Unprofiled targets are refused visibly instead of receiving an unusable reference.
      const rawLaunch = await registered.get("herdr_launch")!.execute("launch-raw", { name: "integration-raw-worker", kind: "pi", placement: { mode: "new_tab", tabLabel: "raw-launch" } }, signal, undefined, toolContext);
      const rawPaneId = String(resultObject(rawLaunch.details).paneId);
      const promptsBefore = stdinCalls.length;
      await expect(registered.get("herdr_communicate")!.execute("refuse-raw-attachment", { target: rawPaneId, operation: "prompt", text: "unusable reference", delivery: "attachment" }, signal, undefined, toolContext))
        .rejects.toMatchObject({ code: "ATTACHMENT_TARGET_UNVERIFIED" });
      expect(stdinCalls).toHaveLength(promptsBefore);
      await expect(registered.get("herdr_launch")!.execute("refuse-raw-launch", { name: "integration-raw-attach", kind: "pi", initialPrompt: "unusable reference", initialPromptDelivery: "attachment" }, signal, undefined, toolContext))
        .rejects.toMatchObject({ code: "ATTACHMENT_TARGET_UNVERIFIED" });

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
      // Remove only the recipient directories this run published into the owner-only store.
      for (const path of attachmentPaths) {
        await rm(dirname(dirname(path)), { recursive: true, force: true }).catch((error) => process.stderr.write(`INTEGRATION_ATTACHMENT_CLEANUP_FAILURE ${String(error)}\n`));
      }
      await rm(cwd, { recursive: true, force: true });
    }
  }, 420_000);
});
