import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

  const diagnosticRecord = (value: unknown): Record<string, unknown> => {
    const source = resultObject(value);
    const diagnostic = Object.fromEntries(["pane_id", "terminal_id", "agent_id", "name", "agent_name", "agent", "agent_status", "state_change_seq", "revision", "interactive_ready", "screen_detection_skipped"].flatMap((field): Array<[string, unknown]> => {
      const candidate = source[field];
      return typeof candidate === "string" || typeof candidate === "number" || typeof candidate === "boolean" || candidate === null ? [[field, candidate]] : [];
    }));
    const session = source.agent_session;
    if (typeof session === "object" && session !== null && !Array.isArray(session)) {
      const identity = session as Record<string, unknown>;
      if (["source", "agent", "kind", "value"].every((field) => typeof identity[field] === "string")) {
        const full = [identity.source, identity.agent, identity.kind, identity.value] as string[];
        diagnostic.agent_session = { source: full[0]!.slice(0, 256), agent: full[1]!.slice(0, 256), kind: full[2]!.slice(0, 256), value: full[3]!.slice(0, 256) };
        diagnostic.agent_session_fingerprint = createHash("sha256").update(JSON.stringify(full)).digest("hex");
      }
    }
    const identityTuple = [source.pane_id, source.terminal_id, source.name ?? source.agent_name, source.agent, diagnostic.agent_session_fingerprint];
    if (identityTuple.every((field) => typeof field === "string")) {
      diagnostic.identity_fingerprint = createHash("sha256").update(JSON.stringify(identityTuple)).digest("hex");
    }
    return diagnostic;
  };

  const readinessDiagnostic = (details: Record<string, unknown>): Record<string, unknown> => {
    const readiness = resultObject(details.readiness ?? {});
    const records = Array.isArray(readiness.records) ? readiness.records.map((value) => {
      const record = resultObject(value);
      return { recordSource: record.source, ...diagnosticRecord(record) };
    }) : [];
    return {
      budgetBasis: readiness.budgetBasis,
      budgetMs: readiness.budgetMs,
      elapsedMs: readiness.elapsedMs,
      samples: readiness.samples,
      lastPendingReason: readiness.lastPendingReason,
      baselineRequired: readiness.baselineRequired,
      records
    };
  };

  const SCHEDULING_TOLERANCE_MS = 500;
  const assertLaunchPhaseTiming = (details: Record<string, unknown>, monotonicWallElapsedMs: number, confirmationTimedOut: boolean): void => {
    const readiness = resultObject(details.readiness);
    const confirmation = resultObject(details.promptConfirmation);
    const timing = resultObject(details.timing);
    const selectedStartReadinessMs = timing.selectedStartReadinessMs;
    const promptSubmissionAckMs = timing.promptSubmissionAckMs;
    const postAckConfirmationMs = timing.postAckConfirmationMs;
    for (const duration of [selectedStartReadinessMs, promptSubmissionAckMs, postAckConfirmationMs]) {
      expect(Number.isSafeInteger(duration)).toBe(true);
      expect(Number(duration)).toBeGreaterThanOrEqual(0);
    }
    const decomposedPhaseElapsedMs = Number(selectedStartReadinessMs) + Number(promptSubmissionAckMs) + Number(postAckConfirmationMs);
    expect(decomposedPhaseElapsedMs).toBeLessThanOrEqual(monotonicWallElapsedMs + SCHEDULING_TOLERANCE_MS);
    expect(readiness.elapsedMs).toBe(selectedStartReadinessMs);
    expect(confirmation.elapsedMs).toBe(postAckConfirmationMs);
    if (confirmationTimedOut) {
      expect(Number(postAckConfirmationMs)).toBeGreaterThanOrEqual(5_000 - SCHEDULING_TOLERANCE_MS);
      expect(Number(postAckConfirmationMs)).toBeLessThanOrEqual(monotonicWallElapsedMs + SCHEDULING_TOLERANCE_MS);
    }
  };

  const recordDeliveryFailureBeforeTeardown = async (label: string, failure: { code?: string; details: Record<string, unknown> }, elapsedMs: number): Promise<void> => {
    const details = failure.details;
    process.stderr.write(`INTEGRATION_DELIVERY_FAILURE_DETAILS ${label} ${JSON.stringify({ elapsedMs, code: failure.code, causeCode: details.causeCode, phase: details.phase, promptSubmitted: details.promptSubmitted, promptConsumption: details.promptConsumption, readiness: readinessDiagnostic(details), initialPromptSubmission: details.initialPromptSubmission, promptConfirmation: details.promptConfirmation, timing: details.timing, created: details.created })}\n`);
    const created = resultObject(details.created ?? {});
    const paneId = typeof created.paneId === "string" ? created.paneId : typeof details.paneId === "string" ? details.paneId : undefined;
    if (!paneId) return;
    for (const [diagnostic, args] of [
      ["agent_get", ["agent", "get", paneId]],
      ["pane_get", ["pane", "get", paneId]]
    ] as const) {
      try {
        const value = resultObject(resultObject(await runNamed([...args])).result);
        process.stderr.write(`INTEGRATION_DELIVERY_${diagnostic.toUpperCase()} ${label} ${JSON.stringify(diagnosticRecord(value.agent ?? value.pane ?? value))}\n`);
      } catch (error) {
        process.stderr.write(`INTEGRATION_DELIVERY_${diagnostic.toUpperCase()}_FAILED ${label} ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    try {
      const snapshot = resultObject(resultObject(resultObject(await runNamed(["api", "snapshot"])).result).snapshot);
      const panes = Array.isArray(snapshot.panes) ? snapshot.panes.map(resultObject).filter((item) => item.pane_id === paneId).map(diagnosticRecord) : [];
      const agents = Array.isArray(snapshot.agents) ? snapshot.agents.map(resultObject).filter((item) => item.pane_id === paneId).map(diagnosticRecord) : [];
      process.stderr.write(`INTEGRATION_DELIVERY_SNAPSHOT ${label} ${JSON.stringify({ panes, agents })}\n`);
    } catch (error) {
      process.stderr.write(`INTEGRATION_DELIVERY_SNAPSHOT_FAILED ${label} ${error instanceof Error ? error.message : String(error)}\n`);
    }
  };

  /**
   * Every feature delivery is a gate. Keep bounded diagnostic evidence, then
   * rethrow so a lost or unacknowledged prompt/attachment fails the run rather
   * than being converted into a skipped acceptance claim.
   */
  const deliver = async (label: string, call: Promise<{ details?: Record<string, unknown> }>): Promise<{ confirmed: true; details: Record<string, unknown> }> => {
    const startedAt = performance.now();
    try {
      const result = await call;
      process.stderr.write(`INTEGRATION_DELIVERY_CONFIRMED ${label}\n`);
      return { confirmed: true, details: resultObject(result.details) };
    } catch (error) {
      const failure = error as { code?: string; details?: Record<string, unknown> };
      if (failure.details === undefined) throw error;
      // Argv-path failures keep bounded CLI text; stdin deliveries are non-textual by design.
      const evidence = [failure.details.stdout, failure.details.stderr].filter((value) => typeof value === "string" && value.length > 0).join(" | ").slice(0, 600).replace(/\s+/gu, " ");
      const attachment = resultObject(failure.details.attachment ?? {});
      if (typeof attachment.path === "string") state.attachmentPaths.push(attachment.path);
      process.stderr.write(`INTEGRATION_DELIVERY_FAILED ${label} code=${String(failure.code)} causeCode=${String(failure.details.causeCode)} phase=${String(failure.details.phase)}${evidence ? ` evidence=${evidence}` : ""}\n`);
      await recordDeliveryFailureBeforeTeardown(label, { code: failure.code, details: failure.details }, performance.now() - startedAt);
      throw error;
    }
  };

  type LaunchDelivery = { confirmed: true; details: Record<string, unknown> } | { confirmed: false; details: Record<string, unknown> };

  const deliverLaunch = async (label: string, call: () => Promise<{ details?: Record<string, unknown> }>): Promise<LaunchDelivery> => {
    const startedAt = performance.now();
    const stdinStart = state.stdinCalls.length;
    try {
      const result = await call();
      const wallElapsedMs = performance.now() - startedAt;
      const details = resultObject(result.details);
      expect(details).toMatchObject({
        promptSubmitted: true,
        promptConsumption: "confirmed",
        readiness: { budgetBasis: "immediately_before_selected_agent_start", budgetMs: 120_000, elapsedMs: expect.any(Number), samples: expect.any(Number), baselineRequired: true, records: expect.any(Array) },
        initialPromptSubmission: { confirmed: true, operationId: "cli:agent:prompt" },
        promptConfirmation: { elapsedMs: expect.any(Number) },
        timing: { selectedStartReadinessMs: expect.any(Number), promptSubmissionAckMs: expect.any(Number), postAckConfirmationMs: expect.any(Number) }
      });
      assertLaunchPhaseTiming(details, wallElapsedMs, false);
      expect(state.stdinCalls.slice(stdinStart).filter(({ args }) => args[0] === "agent" && args[1] === "prompt")).toHaveLength(1);
      process.stderr.write(`INTEGRATION_LAUNCH_READINESS ${label} ${JSON.stringify(readinessDiagnostic(details))}\n`);
      process.stderr.write(`INTEGRATION_DELIVERY_CONFIRMED ${label}\n`);
      return { confirmed: true, details };
    } catch (error) {
      const failure = error as { code?: string; details?: Record<string, unknown> };
      if (failure.details === undefined) throw error;
      const attachment = resultObject(failure.details.attachment ?? {});
      if (typeof attachment.path === "string") state.attachmentPaths.push(attachment.path);
      const elapsedMs = performance.now() - startedAt;
      process.stderr.write(`INTEGRATION_DELIVERY_FAILED ${label} code=${String(failure.code)} causeCode=${String(failure.details.causeCode)} phase=${String(failure.details.phase)}\n`);
      await recordDeliveryFailureBeforeTeardown(label, { code: failure.code, details: failure.details }, elapsedMs);
      if (failure.code !== "LAUNCH_FAILED" || failure.details.causeCode !== "PROMPT_UNCONFIRMED") throw error;
      expect(failure.details).toMatchObject({
        phase: "prompt_verification",
        promptSubmitted: true,
        promptConsumption: "unconfirmed",
        readiness: { budgetBasis: "immediately_before_selected_agent_start", budgetMs: 120_000, elapsedMs: expect.any(Number), samples: expect.any(Number), baselineRequired: true, records: expect.any(Array) },
        initialPromptSubmission: { confirmed: true, operationId: "cli:agent:prompt", agentSession: { source: expect.any(String), agent: expect.any(String), kind: expect.any(String), value: expect.any(String) } },
        promptConfirmation: { timeoutMs: 5_000, pollIntervalMs: 100, elapsedMs: expect.any(Number) },
        timing: { selectedStartReadinessMs: expect.any(Number), promptSubmissionAckMs: expect.any(Number), postAckConfirmationMs: expect.any(Number) },
        created: expect.any(Object)
      });
      expect(state.stdinCalls.slice(stdinStart).filter(({ args }) => args[0] === "agent" && args[1] === "prompt")).toHaveLength(1);
      assertLaunchPhaseTiming(failure.details, elapsedMs, resultObject(failure.details.promptConfirmation).reason === "timeout");
      // An exact fail-closed uncertainty is a valid live outcome. The prompt may
      // have been consumed, so callers must not retry or run dependent assertions.
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
    const deadline = performance.now() + deadlineMs;
    while (performance.now() < deadline) {
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
    const startupDeadline = performance.now() + 10_000;
    while (performance.now() < startupDeadline) {
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
          const result = await execFileAsync(command, ["--session", REQUIRED_SESSION, ...args], {
            cwd: state.cwd,
            encoding: "utf8",
            maxBuffer: 2_000_000,
            signal: options?.signal,
            timeout: options?.timeout,
            env: {
              ...process.env,
              HERDR_ENV: "1",
              HERDR_WORKSPACE_ID: state.workspaceId,
              HERDR_TAB_ID: state.rootTabId,
              HERDR_PANE_ID: state.rootPaneId
            }
          });
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
    expect(resultObject(manager.details).profile).toMatchObject({ name: "manager-pi", kind: "pi", model: "openai-codex/gpt-5.6-sol", thinking: "high", tools: ["read", "grep", "find", "ls", "herdr_inspect", "herdr_launch", "herdr_communicate", "herdr_wait", "herdr_jobs", "herdr_pane", "herdr_tab"], extensions: [], skills: [expect.stringContaining("herdr-profiles/role-plugins/manager/skills/manager")], fallbackProfiles: [] });
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

  it("fails closed for a deterministic Bash-tool interrupt in the disposable session", async () => {
    const turnMarker = `turn-control-${randomUUID()}`;
    const turnMarkerPath = join(state.cwd, "turn-control-started.txt");
    const turnScriptPath = join(state.cwd, "turn-control.sh");
    await writeFile(turnScriptPath, `printf '%s' '${turnMarker}' > '${turnMarkerPath}'\nsleep 120\n`, { mode: 0o700 });
    const launched = await deliverLaunch("turn-control-launch", () => tool("herdr_launch").execute("turn-control-launch", {
      name: `integration-turn-control-${process.pid}`,
      profile: "worker-pi",
      placement: { mode: "new_tab", tabLabel: "turn-control" },
      initialPrompt: `Use Bash to execute exactly ${turnScriptPath} now. Do not use any other tool. Remain in this turn until the script exits; do not finish the task or send a final response.`
    }, signal(), undefined, toolContext()));
    if (!launched.confirmed) return;
    expect(await waitForMarker(turnMarkerPath, turnMarker, 60_000), "turn-control fixture did not reach its deterministic sleep command").toBe(true);
    const details = launched.details;
    const paneId = details.paneId;
    if (typeof paneId !== "string") throw new Error("turn-control fixture launch did not return an authoritative pane ID");

    const fixtureSnapshot = resultObject(resultObject(resultObject(await runNamed(["api", "snapshot"])).result).snapshot);
    const fixturePanes = Array.isArray(fixtureSnapshot.panes) ? fixtureSnapshot.panes.map(resultObject) : [];
    const fixtureAgents = Array.isArray(fixtureSnapshot.agents) ? fixtureSnapshot.agents.map(resultObject) : [];
    expect(fixturePanes).toEqual(expect.arrayContaining([expect.objectContaining({ pane_id: paneId, agent_status: "working" })]));
    expect(fixtureAgents).toEqual(expect.arrayContaining([expect.objectContaining({ pane_id: paneId, agent_status: "working" })]));

    let failure: { code?: unknown; details?: Record<string, unknown> } | undefined;
    try {
      await tool("herdr_communicate").execute("turn-control", { target: paneId, operation: "interrupt" }, signal(), undefined, toolContext());
    } catch (error) {
      failure = error as { code?: unknown; details?: Record<string, unknown> };
    }
    expect(failure?.code).toBe("INTERRUPT_UNCONFIRMED");
    const failureDetails = resultObject(failure?.details);
    expect(failureDetails).toMatchObject({
      dispatchAttempted: true,
      dispatchAcknowledged: true,
      confirmation: { kind: "unconfirmed" }
    });
    const preEvidence = resultObject(failureDetails.preEvidence);
    const finalEvidence = resultObject(failureDetails.finalEvidence);
    expect(finalEvidence).toMatchObject({
      pane_id: paneId,
      terminal_id: preEvidence.terminal_id,
      agent_session: preEvidence.agent_session,
      agent_status: "working"
    });
    const controls = state.cliCalls.filter((args) => args[0] === "agent" && args[1] === "send-keys" && args[2] === paneId);
    expect(controls).toEqual([["agent", "send-keys", paneId, "ctrl+c"]]);
  }, 180_000);

  // The unprofiled-launch refusal this suite used to cover has no reachable path left:
  // launch is profile-only, so an unregistered recipient can no longer be created here.
  // The `ATTACHMENT_TARGET_UNVERIFIED` contract is covered by the unit suites instead.

  /**
   * Transport smoke: non-gating evidence about the route, the transport, and the published
   * artifact. It deliberately makes no claim about what a recipient agent read; the
   * acceptance tests below own that claim.
   */
  it("routes wrapped text over the session-bound stdin transport and publishes exact artifacts", async () => {
    const inlineBody = ["integration assignment", ...Array.from({ length: 320 }, (_value, index) => `long assignment line ${index}`)].join("\n");
    const inline = await deliverLaunch("pi-inline-launch", () => tool("herdr_launch").execute("launch-profile", { name: "integration-profile-worker", profile: "worker-pi", placement: { mode: "new_tab", tabLabel: "profile-launch" }, initialPrompt: inlineBody }, signal(), undefined, toolContext()));
    if (!inline.confirmed) return;
    expect(inline.details).toMatchObject({ initialPromptDelivery: "inline", initialPromptSubmission: { confirmed: true } });
    const startArgs = state.cliCalls.find((args) => args[0] === "agent" && args[1] === "start" && args.includes("integration-profile-worker"));
    expect(startArgs).toEqual(expect.arrayContaining(["--kind", "pi", "--model", "openai-codex/gpt-5.6-luna", "--thinking", "max", "--tools", "read,bash,grep,find,ls,ffgrep,fffind,ctx_execute,ctx_execute_file,ctx_search,web_search,source_check,fetch_content,get_search_content,edit,write,bash_bg,jobs,job_decide,monitor", "--skill", expect.stringContaining("herdr-profiles/role-plugins/worker/skills/worker"), "--append-system-prompt"]));
    expect(state.profilePromptContent).toContain("Use the worker role skill");

    const inlinePaneId = String(inline.details.paneId ?? resultObject(inline.details.created).paneId);
    const inlineDelivery = state.stdinCalls.find((call) => call.input.includes("integration assignment"));
    expect(inlineDelivery, `pi-inline-launch did not record its stdin submission (phase=${String(inline.details.phase)})`).toBeDefined();
    expect(inlineDelivery!.args).toEqual(["agent", "prompt", inlinePaneId, "--stdin"]);
    expect(inlineDelivery!.input).toContain("[HERDR AGENT MESSAGE v1]");
    expect(inlineDelivery!.input).toContain("authority: agent; not user/owner");
    expect(inlineDelivery!.input).toContain("delivery: inline");
    expect(state.cliCalls.some((args) => args.some((arg) => arg.includes("integration assignment")))).toBe(false);

    const body = `Transport smoke body.\n${"detail line\n".repeat(200)}`;
    const attachmentLaunch = await deliverLaunch("pi-attachment-launch", () => tool("herdr_launch").execute("launch-pi-attachment", { name: "integration-pi-attach", profile: "worker-pi", placement: { mode: "new_tab", tabLabel: "pi-attachment" }, initialPrompt: body, initialPromptDelivery: "attachment" }, signal(), undefined, toolContext()));
    if (!attachmentLaunch.confirmed) return;
    const attachment = resultObject(attachmentLaunch.details.attachment);
    state.attachmentPaths.push(String(attachment.path));
    expect(attachmentLaunch.details).toMatchObject({ initialPromptDelivery: "attachment" });
    expect(await readFile(String(attachment.path), "utf8")).toBe(body);
    expect(createHash("sha256").update(body, "utf8").digest("hex")).toBe(attachment.sha256);
    expect(attachment.bytes).toBe(Buffer.byteLength(body, "utf8"));
    expect((await stat(String(attachment.path))).mode & 0o777).toBe(0o600);
    const envelope = state.stdinCalls.find((call) => call.input.includes(String(attachment.path)));
    expect(envelope, `pi-attachment-launch did not record its stdin submission (phase=${String(attachmentLaunch.details.phase)})`).toBeDefined();
    expect(envelope!.input).toContain("delivery: attachment");
    expect(envelope!.input).toContain(`attachment-sha256: ${String(attachment.sha256)}`);
    expect(envelope!.input).not.toContain("detail line");
    expect(state.cliCalls.some((args) => args.some((arg) => arg.includes("detail line")))).toBe(false);
  }, 240_000);

  /**
   * Acceptance: a semantically confirmed recipient must produce evidence obtainable
   * only from the attachment. Exact fail-closed launch uncertainty is accepted but
   * returns before marker assertions because the prompt was possibly consumed.
   */
  it("accepts Pi recipient readback only with agent-produced evidence", async () => {
    const nonce = randomUUID();
    const markerPath = join(state.cwd, "readback-pi.txt");
    const body = [
      "Herdr integration acceptance check.",
      `Write the file ${markerPath} whose only content is this exact token:`,
      nonce,
      "Then stop. Do not change anything else and do not reply."
    ].join("\n");

    const launched = await deliverLaunch("pi-acceptance-launch", () => tool("herdr_launch").execute("accept-pi", { name: "integration-accept-pi", profile: "worker-pi", placement: { mode: "new_tab", tabLabel: "accept-pi" }, initialPrompt: body, initialPromptDelivery: "attachment" }, signal(), undefined, toolContext()));
    if (!launched.confirmed) return;
    const attachment = resultObject(launched.details.attachment);
    state.attachmentPaths.push(String(attachment.path));
    expect(await readFile(String(attachment.path), "utf8")).toContain(nonce);
    const produced = await waitForMarker(markerPath, nonce, ACCEPTANCE_DEADLINE_MS);
    expect(produced, `Pi recipient did not produce ${markerPath} containing the attachment token`).toBe(true);
  }, 300_000);

  it("accepts Claude recipient readback only with agent-produced evidence", async () => {
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
    expect(await readFile(String(attachment.path), "utf8")).toContain(nonce);
    const produced = await waitForMarker(markerPath, nonce, ACCEPTANCE_DEADLINE_MS);
    expect(produced, `Claude recipient did not produce ${markerPath} containing the attachment token`).toBe(true);
  }, 300_000);
});
