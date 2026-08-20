import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import extension, { CORE_TOOL_NAMES } from "../../index.js";
import { spawnWithStdin } from "../../src/exec-stdin.js";
import { stopDisposableServer } from "./disposable-session.js";

interface ExecutableTool {
  name: string;
  execute(id: string, params: unknown, signal: AbortSignal, onUpdate: undefined, context: ExtensionContext): Promise<{ details?: Record<string, unknown> }>;
}

const execFileAsync = promisify(execFile);
const REQUIRED_SESSION = "herdr-tools-integration";
const requestedSession = process.env.HERDR_TOOLS_INTEGRATION_SESSION ?? REQUIRED_SESSION;
const enabled = process.env.HERDR_TOOLS_RUN_INTEGRATION === "1";
const ACCEPTANCE_DEADLINE_MS = 150_000;

function resultObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("integration response is not an object");
  return value as Record<string, unknown>;
}

function blocked(reason: string): void {
  process.stderr.write(`INTEGRATION_ACCEPTANCE_BLOCKED ${reason}\n`);
}

describe.skipIf(!enabled)("disposable Herdr integration", () => {
  const state: {
    cwd: string;
    workspaceId?: string;
    rootPaneId?: string;
    rootTabId?: string;
    server?: ChildProcess;
    sessionStarted: boolean;
    fixtureCreated: boolean;
    baseline?: { workspaces: string[]; tabs: string[]; panes: string[] };
    registered: Map<string, ExecutableTool>;
    commands: string[];
    handlers: string[];
    cliCalls: string[][];
    stdinCalls: Array<{ args: string[]; input: string }>;
    profilePromptContent: string;
    attachmentPaths: string[];
  } = { cwd: "", sessionStarted: false, fixtureCreated: false, registered: new Map(), commands: [], handlers: [], cliCalls: [], stdinCalls: [], profilePromptContent: "", attachmentPaths: [] };

  const run = async (...args: string[]): Promise<unknown> => {
    const result = await execFileAsync("herdr", args, { cwd: state.cwd, maxBuffer: 2_000_000 });
    return JSON.parse(result.stdout);
  };
  const runNamed = (args: string[]) => run("--session", REQUIRED_SESSION, ...args);
  const topologyIds = (snapshot: Record<string, unknown>) => ({
    workspaces: Array.isArray(snapshot.workspaces) ? snapshot.workspaces.map((item) => String(resultObject(item).workspace_id)).sort() : [],
    tabs: Array.isArray(snapshot.tabs) ? snapshot.tabs.map((item) => String(resultObject(item).tab_id)).sort() : [],
    panes: Array.isArray(snapshot.panes) ? snapshot.panes.map((item) => String(resultObject(item).pane_id)).sort() : []
  });

  /**
   * Deliveries either confirm (the tool returned success) or do not. Callers decide what
   * an unconfirmed delivery means: the transport smoke records it, acceptance blocks on it.
   */
  const deliver = async (label: string, call: Promise<{ details?: Record<string, unknown> }>): Promise<{ confirmed: boolean; details: Record<string, unknown> }> => {
    try {
      const result = await call;
      process.stderr.write(`INTEGRATION_DELIVERY_CONFIRMED ${label}\n`);
      return { confirmed: true, details: resultObject(result.details) };
    } catch (error) {
      const failure = error as { code?: string; details?: Record<string, unknown> };
      if (failure.details === undefined) throw error;
      // Argv-path failures keep bounded CLI text; stdin deliveries are non-textual by design.
      const evidence = [failure.details.stdout, failure.details.stderr].filter((value) => typeof value === "string" && value.length > 0).join(" | ").slice(0, 600).replace(/\s+/gu, " ");
      process.stderr.write(`INTEGRATION_DELIVERY_UNCONFIRMED ${label} code=${String(failure.code)} causeCode=${String(failure.details.causeCode)} phase=${String(failure.details.phase)}${evidence ? ` evidence=${evidence}` : ""}\n`);
      return { confirmed: false, details: failure.details };
    }
  };

  const tool = (name: string): ExecutableTool => {
    const found = state.registered.get(name);
    if (!found) throw new Error(`integration harness did not register ${name}`);
    return found;
  };

  const toolContext = () => ({ cwd: state.cwd, hasUI: false }) as ExtensionContext;
  const signal = () => new AbortController().signal;

  const waitForMarker = async (path: string, nonce: string, deadlineMs: number): Promise<boolean> => {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      const content = await readFile(path, "utf8").catch(() => undefined);
      if (content?.includes(nonce)) return true;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  };

  beforeAll(async () => {
    expect(requestedSession).toBe(REQUIRED_SESSION);
    expect(process.env.HERDR_ENV).toBe("1");
    const currentIds = [process.env.HERDR_WORKSPACE_ID, process.env.HERDR_TAB_ID, process.env.HERDR_PANE_ID];
    expect(currentIds.every(Boolean)).toBe(true);
    state.cwd = await mkdtemp(`${tmpdir()}/herdr-tools-it-`);

    const sessions = resultObject(await run("session", "list", "--json"));
    const existing = Array.isArray(sessions.sessions) && sessions.sessions.some((session) => resultObject(session).name === REQUIRED_SESSION);
    if (existing) throw new Error(`refusing to reuse existing session ${REQUIRED_SESSION}`);

    let startupError = "";
    state.server = spawn("herdr", ["--session", REQUIRED_SESSION, "server"], { cwd: state.cwd, stdio: ["ignore", "ignore", "pipe"] });
    state.server.stderr?.on("data", (chunk: Buffer) => { startupError = (startupError + chunk.toString()).slice(-2_000); });
    const startupDeadline = Date.now() + 10_000;
    while (Date.now() < startupDeadline) {
      if (state.server.exitCode !== null) throw new Error(`named Herdr server exited during startup: ${startupError}`);
      const listed = resultObject(await run("session", "list", "--json"));
      state.sessionStarted = Array.isArray(listed.sessions) && listed.sessions.some((session) => {
        const value = resultObject(session);
        return value.name === REQUIRED_SESSION && value.running === true;
      });
      if (state.sessionStarted) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!state.sessionStarted) throw new Error(`named Herdr server did not become ready: ${startupError}`);

    const current = resultObject(resultObject(resultObject(await run("api", "snapshot")).result).snapshot);
    const currentWorkspaceIds = Array.isArray(current.workspaces) ? current.workspaces.map((item) => resultObject(item).workspace_id) : [];
    expect(currentIds.every((id) => typeof id === "string" && !currentWorkspaceIds.includes(id))).toBe(false);
    state.baseline = topologyIds(current);

    const created = resultObject(resultObject(await runNamed(["workspace", "create", "--cwd", state.cwd, "--label", `pi-herdr-tools-it-${process.pid}`, "--no-focus"])).result);
    state.workspaceId = String(resultObject(created.workspace ?? created).workspace_id);
    state.fixtureCreated = true;

    const fixture = resultObject(resultObject(resultObject(await runNamed(["api", "snapshot"])).result).snapshot);
    const fixturePanes = Array.isArray(fixture.panes) ? fixture.panes.map(resultObject) : [];
    const rootPane = fixturePanes.find((pane) => pane.workspace_id === state.workspaceId);
    if (!rootPane || typeof rootPane.pane_id !== "string" || typeof rootPane.tab_id !== "string") throw new Error("fixture snapshot omitted its root pane context");
    state.rootPaneId = rootPane.pane_id;
    state.rootTabId = rootPane.tab_id;

    const pi = {
      async exec(command: string, args: string[], options?: { signal?: AbortSignal; timeout?: number }) {
        expect(command).toBe("herdr");
        state.cliCalls.push([...args]);
        if (args[0] === "agent" && args[1] === "start") {
          const promptFlag = args.indexOf("--append-system-prompt");
          if (promptFlag >= 0 && typeof args[promptFlag + 1] === "string") state.profilePromptContent = await readFile(args[promptFlag + 1]!, "utf8");
        }
        try {
          const result = await execFileAsync(command, ["--session", REQUIRED_SESSION, ...args], { cwd: state.cwd, encoding: "utf8", maxBuffer: 2_000_000, signal: options?.signal, timeout: options?.timeout });
          return { stdout: String(result.stdout), stderr: String(result.stderr), code: 0, killed: false };
        } catch (error) {
          const failed = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer; code?: number; killed?: boolean };
          return { stdout: String(failed.stdout ?? ""), stderr: String(failed.stderr ?? failed.message), code: failed.code ?? 1, killed: failed.killed ?? false };
        }
      },
      // Stdin deliveries must reach the same disposable named session as pi.exec.
      async execStdin(command: string, args: string[], input: string, options?: { signal?: AbortSignal; timeout?: number }) {
        expect(command).toBe("herdr");
        state.cliCalls.push([...args]);
        state.stdinCalls.push({ args: [...args], input });
        return spawnWithStdin(command, ["--session", REQUIRED_SESSION, ...args], input, { signal: options?.signal, timeout: options?.timeout });
      },
      registerTool(registered: unknown) {
        const executable = registered as ExecutableTool;
        state.registered.set(executable.name, executable);
      },
      registerCommand(name: string) {
        state.commands.push(name);
      },
      on(event: string) {
        state.handlers.push(event);
      }
    } as unknown as ExtensionAPI;

    const saved = { env: process.env.HERDR_ENV, workspace: process.env.HERDR_WORKSPACE_ID, tab: process.env.HERDR_TAB_ID, pane: process.env.HERDR_PANE_ID };
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = state.workspaceId;
    process.env.HERDR_TAB_ID = state.rootTabId;
    process.env.HERDR_PANE_ID = state.rootPaneId;
    try {
      extension(pi);
    } finally {
      for (const [key, value] of Object.entries({ HERDR_ENV: saved.env, HERDR_WORKSPACE_ID: saved.workspace, HERDR_TAB_ID: saved.tab, HERDR_PANE_ID: saved.pane })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }

    }
  }, 120_000);

  afterAll(async () => {
    if (state.fixtureCreated && state.workspaceId) {
      await runNamed(["workspace", "close", state.workspaceId]).catch((error) => process.stderr.write(`INTEGRATION_TEARDOWN_FAILURE ${String(error)}\n`));
    }
    if (state.sessionStarted) {
      await run("session", "stop", REQUIRED_SESSION, "--json").catch((error) => process.stderr.write(`INTEGRATION_SESSION_STOP_FAILURE ${String(error)}\n`));
    }
    await stopDisposableServer(state.server);
    if (state.sessionStarted) {
      await run("session", "delete", REQUIRED_SESSION, "--json").catch((error) => process.stderr.write(`INTEGRATION_SESSION_DELETE_FAILURE ${String(error)}\n`));
    }
    // Remove only the recipient directories this run published into.
    for (const path of state.attachmentPaths) {
      await rm(dirname(dirname(path)), { recursive: true, force: true }).catch((error) => process.stderr.write(`INTEGRATION_ATTACHMENT_CLEANUP_FAILURE ${String(error)}\n`));
    }
    if (state.cwd) await rm(state.cwd, { recursive: true, force: true });
  }, 120_000);

  it("registers the extension surface and mutates only the disposable session", async () => {
    expect([...state.registered.keys()]).toEqual([...CORE_TOOL_NAMES]);
    expect([...state.registered.values()].every((registered) => typeof registered.execute === "function")).toBe(true);
    expect(state.commands).toEqual(["herdr-waits"]);
    expect(state.handlers).toEqual(["session_shutdown", "session_start"]);

    const profiles = await tool("herdr_inspect").execute("profiles", { mode: "collection", collection: "profiles" }, signal(), undefined, toolContext());
    const profileItems = resultObject(profiles.details).items;
    expect(Array.isArray(profileItems) ? profileItems : []).toHaveLength(12);
    expect(profileItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "manager-pi", kind: "pi", model: "openai-codex/gpt-5.6-sol", thinking: "high", tools: expect.arrayContaining(["herdr_tab"]), skills: [expect.stringContaining("herdr-profiles/role-plugins/manager/skills/manager")] }),
      expect.objectContaining({ name: "manager-claude", kind: "claude", model: "claude-fable-5", effort: "high", permissionMode: "default", fallbackProfiles: [] })
    ]));
    const manager = await tool("herdr_inspect").execute("manager", { mode: "profile", profile: "manager-pi" }, signal(), undefined, toolContext());
    expect(resultObject(manager.details).profile).toMatchObject({ name: "manager-pi", kind: "pi", model: "openai-codex/gpt-5.6-sol", thinking: "high", tools: ["read", "grep", "find", "ls", "herdr_inspect", "herdr_launch", "herdr_communicate", "herdr_wait", "herdr_pane", "herdr_tab"], extensions: [], skills: [expect.stringContaining("herdr-profiles/role-plugins/manager/skills/manager")], fallbackProfiles: [] });
    const managerClaude = await tool("herdr_inspect").execute("manager-claude", { mode: "profile", profile: "manager-claude" }, signal(), undefined, toolContext());
    expect(resultObject(managerClaude.details).profile).toMatchObject({ name: "manager-claude", kind: "claude", model: "claude-fable-5", effort: "high", permissionMode: "default", allowedTools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "AskUserQuestion", "Skill", "ToolSearch", "mcp__plugin_herdr-tools_herdr"], disallowedTools: ["Task"], pluginDirs: [expect.stringContaining("herdr-profiles/role-plugins/manager")] });
    const inspected = await tool("herdr_inspect").execute("inspect", { mode: "collection", collection: "panes" }, signal(), undefined, toolContext());
    expect(resultObject(inspected.details).items).toEqual(expect.arrayContaining([expect.objectContaining({ workspace_id: state.workspaceId })]));
    const createdTab = await tool("herdr_tab").execute("create-tab", { operation: "create", label: "extension-smoke" }, signal(), undefined, toolContext());
    const createdTabId = resultObject(createdTab.details).tabId;
    if (typeof createdTabId !== "string") throw new Error("extension tab create omitted its authoritative ID");
    await tool("herdr_tab").execute("close-tab", { operation: "close", target: createdTabId }, signal(), undefined, toolContext());
    expect(state.cliCalls.some((args) => args[0] === "tab" && args[1] === "create")).toBe(true);
    expect(state.cliCalls.some((args) => args[0] === "tab" && args[1] === "close")).toBe(true);

    const defaultAfter = resultObject(resultObject(resultObject(await run("api", "snapshot")).result).snapshot);
    expect(topologyIds(defaultAfter)).toEqual(state.baseline);
  }, 120_000);

  // The unprofiled-launch refusal this suite used to cover has no reachable path left:
  // launch is profile-only, so an unregistered recipient can no longer be created here.
  // The `ATTACHMENT_TARGET_UNVERIFIED` contract is covered by the unit suites instead.

  /**
   * Transport smoke: non-gating evidence about the route, the transport, and the published
   * artifact. It deliberately makes no claim about what a recipient agent read; the
   * acceptance tests below own that claim.
   */
  it("routes wrapped text over the session-bound stdin transport and publishes exact artifacts", async () => {
    const inline = await deliver("pi-inline-launch", tool("herdr_launch").execute("launch-profile", { name: "integration-profile-worker", profile: "worker-pi", placement: { mode: "new_tab", tabLabel: "profile-launch" }, initialPrompt: "integration assignment" }, signal(), undefined, toolContext()));
    expect(inline.details).toMatchObject({ initialPromptDelivery: "inline" });
    const startArgs = state.cliCalls.find((args) => args[0] === "agent" && args[1] === "start" && args.includes("integration-profile-worker"));
    expect(startArgs).toEqual(expect.arrayContaining(["--kind", "pi", "--model", "openai-codex/gpt-5.6-luna", "--thinking", "max", "--tools", "read,bash,grep,find,ls,ffgrep,fffind,ctx_execute,ctx_execute_file,ctx_search,web_search,source_check,fetch_content,get_search_content,edit,write,bash_bg,jobs,job_decide,monitor", "--skill", expect.stringContaining("herdr-profiles/role-plugins/worker/skills/worker"), "--append-system-prompt"]));
    expect(state.profilePromptContent).toContain("Use the worker role skill");

    const inlinePaneId = String(inline.details.paneId ?? resultObject(inline.details.created).paneId);
    const inlineDelivery = state.stdinCalls.find((call) => call.input.includes("integration assignment"));
    // A launch that never reached its prompt phase produces no transport evidence to check.
    if (inlineDelivery === undefined) {
      process.stderr.write(`INTEGRATION_TRANSPORT_UNOBSERVED pi-inline-launch phase=${String(inline.details.phase)}\n`);
    } else {
      expect(inlineDelivery.args).toEqual(["agent", "prompt", inlinePaneId, "--stdin", "--wait", "--until", "working", "--timeout", "5000"]);
      expect(inlineDelivery.input).toContain("[HERDR AGENT MESSAGE v1]");
      expect(inlineDelivery.input).toContain("authority: agent; not user/owner");
      expect(inlineDelivery.input).toContain("delivery: inline");
    }
    expect(state.cliCalls.some((args) => args.some((arg) => arg.includes("integration assignment")))).toBe(false);

    const body = `Transport smoke body.\n${"detail line\n".repeat(200)}`;
    const attachmentLaunch = await deliver("pi-attachment-launch", tool("herdr_launch").execute("launch-pi-attachment", { name: "integration-pi-attach", profile: "worker-pi", placement: { mode: "new_tab", tabLabel: "pi-attachment" }, initialPrompt: body, initialPromptDelivery: "attachment" }, signal(), undefined, toolContext()));
    const attachment = resultObject(attachmentLaunch.details.attachment);
    state.attachmentPaths.push(String(attachment.path));
    expect(attachmentLaunch.details).toMatchObject({ initialPromptDelivery: "attachment" });
    expect(await readFile(String(attachment.path), "utf8")).toBe(body);
    expect(createHash("sha256").update(body, "utf8").digest("hex")).toBe(attachment.sha256);
    expect(attachment.bytes).toBe(Buffer.byteLength(body, "utf8"));
    expect((await stat(String(attachment.path))).mode & 0o777).toBe(0o600);
    const envelope = state.stdinCalls.find((call) => call.input.includes(String(attachment.path)));
    if (envelope === undefined) {
      process.stderr.write(`INTEGRATION_TRANSPORT_UNOBSERVED pi-attachment-launch phase=${String(attachmentLaunch.details.phase)}\n`);
    } else {
      expect(envelope.input).toContain("delivery: attachment");
      expect(envelope.input).toContain(`attachment-sha256: ${String(attachment.sha256)}`);
      expect(envelope.input).not.toContain("detail line");
    }
    expect(state.cliCalls.some((args) => args.some((arg) => arg.includes("detail line")))).toBe(false);
  }, 240_000);

  /**
   * Acceptance: a recipient agent must read the attachment and produce evidence only
   * obtainable from its content. An unconfirmed delivery blocks the gate; it never passes.
   */
  it("accepts Pi recipient readback only with agent-produced evidence", async (context) => {
    const nonce = randomUUID();
    const markerPath = join(state.cwd, "readback-pi.txt");
    const body = [
      "Herdr integration acceptance check.",
      `Write the file ${markerPath} whose only content is this exact token:`,
      nonce,
      "Then stop. Do not change anything else and do not reply."
    ].join("\n");

    const launched = await deliver("pi-acceptance-launch", tool("herdr_launch").execute("accept-pi", { name: "integration-accept-pi", profile: "worker-pi", placement: { mode: "new_tab", tabLabel: "accept-pi" }, initialPrompt: body, initialPromptDelivery: "attachment" }, signal(), undefined, toolContext()));
    const attachment = resultObject(launched.details.attachment);
    state.attachmentPaths.push(String(attachment.path));
    if (!launched.confirmed) {
      blocked(`pi delivery unconfirmed: code=${String(launched.details.causeCode ?? launched.details.code)} phase=${String(launched.details.phase)}; Herdr did not observe the agent entering working in a headless named session`);
      context.skip();
      return;
    }
    expect(await readFile(String(attachment.path), "utf8")).toContain(nonce);
    const produced = await waitForMarker(markerPath, nonce, ACCEPTANCE_DEADLINE_MS);
    expect(produced, `Pi recipient did not produce ${markerPath} containing the attachment token`).toBe(true);
  }, 300_000);

  it("accepts Claude recipient readback only with agent-produced evidence", async (context) => {
    const nonce = randomUUID();
    const markerPath = join(state.cwd, "readback-claude.txt");
    const body = [
      "Herdr integration acceptance check.",
      `Write the file ${markerPath} whose only content is this exact token:`,
      nonce,
      "Then stop. Do not change anything else and do not reply."
    ].join("\n");

    const launched = await tool("herdr_launch").execute("accept-claude", { name: "integration-accept-claude", profile: "worker-claude", overrides: { permissionMode: "bypassPermissions" }, placement: { mode: "new_tab", tabLabel: "accept-claude" } }, signal(), undefined, toolContext());
    const details = resultObject(launched.details);
    expect(details).toMatchObject({ recipient: { capable: true, kind: "claude", profileName: "worker-claude" } });
    const startArgs = state.cliCalls.find((args) => args[0] === "agent" && args[1] === "start" && args.includes("integration-accept-claude"));
    const grantIndex = startArgs!.indexOf("--add-dir");
    expect(grantIndex).toBeGreaterThan(0);
    const grantedDirectory = startArgs![grantIndex + 1]!;

    const sent = await deliver("claude-acceptance-send", tool("herdr_communicate").execute("accept-claude-send", { target: String(details.paneId), operation: "prompt", text: body, delivery: "attachment" }, signal(), undefined, toolContext()));
    const attachment = resultObject(sent.details.attachment);
    state.attachmentPaths.push(String(attachment.path));
    expect(dirname(dirname(String(attachment.path)))).toBe(grantedDirectory);
    if (!sent.confirmed) {
      blocked(`claude delivery unconfirmed: code=${String(sent.details.code)} phase=${String(sent.details.phase)}; Herdr did not observe the agent entering working in a headless named session`);
      context.skip();
      return;
    }
    expect(await readFile(String(attachment.path), "utf8")).toContain(nonce);
    const produced = await waitForMarker(markerPath, nonce, ACCEPTANCE_DEADLINE_MS);
    expect(produced, `Claude recipient did not produce ${markerPath} containing the attachment token`).toBe(true);
  }, 300_000);
});
