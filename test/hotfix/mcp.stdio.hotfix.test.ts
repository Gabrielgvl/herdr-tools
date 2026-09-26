import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgentPromptClient, type AgentPromptClient } from "../../src/agent-prompt.js";
import { CORE_TOOL_NAMES } from "../../src/tool-surface.js";
import { HOTFIX_HOST_FILES, HOTFIX_LABEL, HOTFIX_MANDATORY_CASES, REQUIRED_SESSION } from "../../scripts/test-stdin-hotfix.js";
import { createDisposableGitWorkspace, startDisposableSocketProxy, stopDisposableServer, waitForCondition, type DisposableSocketProxy, type PromptSocketRequest } from "../integration/disposable-session.js";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

const execFileAsync = promisify(execFile);
const enabled = process.env.HERDR_TOOLS_HOTFIX === "1";
// The env-selected disposable session (HERDR_TOOLS_INTEGRATION_SESSION) keeps
// parallel hotfix runs isolated; unset falls back to the contract default.
const requestedSession = process.env.HERDR_TOOLS_INTEGRATION_SESSION ?? REQUIRED_SESSION;
const EVIDENCE_DIR = process.env.HERDR_TOOLS_HOTFIX_EVIDENCE_DIR;
const LIVE_TIMEOUT_MS = 120_000;
const CALL_TIMEOUT_MS = 600_000;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const serverEntry = join(repoRoot, "dist/src/mcp-server.js");
const daemonEntry = join(repoRoot, "dist/src/daemon/main.js");

function record(value: unknown, label = "value"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is not an object`);
  return value as Record<string, unknown>;
}

function digest(value: string | Uint8Array): string {
  const hash = createHash("sha256");
  if (typeof value === "string") hash.update(value, "utf8");
  else hash.update(value);
  return hash.digest("hex");
}

function envWithoutInjected(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.HERDR_SOCKET_PATH;
  delete env.HERDR_WORKSPACE_ID;
  delete env.HERDR_TAB_ID;
  delete env.HERDR_PANE_ID;
  return env;
}

function textOf(result: ToolResult): string {
  return result.content.map((block) => block.text).join("\n");
}

function evidence(result: ToolResult): Record<string, unknown> {
  const block = result.content.find((item) => item.text.startsWith("herdr-details\n"));
  if (block) return record(JSON.parse(block.text.slice("herdr-details\n".length)), "MCP details");
  const last = result.content.at(-1);
  if (!last) throw new Error("MCP result omitted evidence");
  return record(JSON.parse(last.text), "MCP result");
}

describe.skipIf(!enabled)(`${HOTFIX_LABEL} MCP stdio host`, () => {
  const state: {
    cwd: string;
    server?: ChildProcess;
    serverStarted: boolean;
    daemon?: ChildProcess;
    daemonStderr: string;
    workspaceId?: string;
    rootPaneId?: string;
    rootTabId?: string;
    socketPath?: string;
    proxy?: DisposableSocketProxy;
    client?: Client;
    transport?: StdioClientTransport;
    /** The C8 follow-up transport (the `herdr agent prompt` socket write), routed through the recording proxy. */
    prompts?: AgentPromptClient;
    commandExitCodes: number[];
    confirmedPanes: string[];
    attachmentPaths: string[];
    provenReceipts: Record<string, unknown>[];
    /** The most recent joined recipient identity, retained for a failing case. */
    lastJoinedIdentity?: Record<string, unknown>;
    receipt?: Record<string, unknown>;
    preserve: boolean;
  } = { cwd: "", serverStarted: false, daemonStderr: "", commandExitCodes: [], confirmedPanes: [], attachmentPaths: [], provenReceipts: [], preserve: false };

  const run = async (...args: string[]): Promise<unknown> => {
    try {
      const result = await execFileAsync("herdr", args, { cwd: state.cwd, env: envWithoutInjected(), maxBuffer: 4_000_000 });
      state.commandExitCodes.push(0);
      return JSON.parse(String(result.stdout));
    } catch (error) {
      const failed = error as Error & { code?: unknown };
      // An aborted exec has no exit code (execFile reports ABORT_ERR, not a
      // number); the ledgers count real process exits only.
      if (typeof failed.code === "number") state.commandExitCodes.push(failed.code);
      throw error;
    }
  };
  const runNamed = (args: string[]) => run("--session", requestedSession, ...args);

  const runText = async (args: string[]): Promise<string> => {
    try {
      const result = await execFileAsync("herdr", args, { cwd: state.cwd, env: envWithoutInjected(), maxBuffer: 4_000_000 });
      state.commandExitCodes.push(0);
      return String(result.stdout);
    } catch (error) {
      const failed = error as Error & { code?: unknown };
      if (typeof failed.code === "number") state.commandExitCodes.push(failed.code);
      throw error;
    }
  };
  const runTextNamed = (args: string[]) => runText(["--session", requestedSession, ...args]);
  const paneRead = (paneId: string) => runTextNamed(["pane", "read", "--lines", "400", paneId]);

  const rawCall = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    if (!state.client) throw new Error("MCP client is not connected");
    const result = await state.client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS, maxTotalTimeout: CALL_TIMEOUT_MS }) as ToolResult;
    return result;
  };
  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const result = await rawCall(name, args);
    if (result.isError) throw new Error(`${name} failed: ${textOf(result)}`);
    return evidence(result);
  };

  /** The launched child of an intent-gated `herdr_launch` reply, or a hard failure. */
  const launchedChildOf = (launch: Record<string, unknown>, label: string): Record<string, unknown> => {
    if (launch.kind !== "launch" || launch.state !== "completed") throw new Error(`${label} launch intent did not complete`);
    const result = record(launch.result, `${label} result`);
    const launched = Array.isArray(result.children) ? result.children : [];
    const recorded = Array.isArray(launch.children) ? launch.children : [];
    if (result.outcome !== "launched" || launched.length !== 1 || recorded.length !== 1) throw new Error(`${label} did not return one launched child`);
    const child = record(launched[0], `${label} child`);
    if (child.state !== "launched" || typeof child.supervisorJobId !== "string" || typeof child.operatingPointId !== "string") throw new Error(`${label} child was not launched under supervision`);
    const intent = record(recorded[0], `${label} intent child`);
    if (typeof intent.runId !== "string" || intent.runId.length === 0) throw new Error(`${label} intent omitted the child run ID`);
    return { ...child, runId: intent.runId };
  };

  /**
   * The caller's read-only status projection: `runs[]` carries each run's
   * presence-verified child pane and live agent status. This is the surface's
   * live-state read — `herdr_run` `observe` additionally verifies the retained
   * artifact digest, so it legitimately refuses while a child rewrites its
   * own handoff mid-turn.
   */
  const statusChild = async (runId: string, label: string): Promise<Record<string, unknown>> => {
    const status = await call("herdr_status", {});
    const run = (Array.isArray(status.runs) ? status.runs : []).map((item) => record(item)).find((item) => item.runId === runId);
    if (!run) throw new Error(`${label} run is absent from the status projection`);
    const child = record(run.child ?? {}, `${label} status child`);
    if (child.presence !== "present" || typeof child.paneId !== "string") throw new Error(`${label} child is not present in the status projection`);
    return child;
  };

  const waitStatusChild = async (runId: string, label: string): Promise<Record<string, unknown>> => {
    const found = await waitForCondition(
      async () => statusChild(runId, label).catch(() => undefined),
      (value) => value !== undefined,
      30_000,
      250
    );
    if (!found) throw new Error(`${label} child never appeared in the status projection`);
    return found;
  };

  const waitStatusState = async (runId: string, states: readonly string[], timeoutMs: number, label: string): Promise<Record<string, unknown>> => {
    const found = await waitForCondition(
      async () => statusChild(runId, label).then((child) => (states.includes(String(child.agentStatus)) ? child : undefined)).catch(() => undefined),
      (value) => value !== undefined,
      timeoutMs,
      250
    );
    if (!found) throw new Error(`${label} child never reached ${states.join("/")}`);
    return found;
  };

  /**
   * `herdr_run` `observe` on a settled run: the artifact digest is stable once
   * the child's own write has been recorded, so the provenance-verified
   * observation is read after completion rather than raced against mid-turn
   * artifact rewrites.
   */
  const observeChild = async (runId: string, label: string): Promise<Record<string, unknown>> => {
    const reply = await call("herdr_run", { action: "observe", runId });
    const observation = record(reply.observation, `${label} observation`);
    if (observation.observationOnly !== true || observation.supervisionRestored !== false || observation.replayed !== false || observation.ownershipTransferred !== false) throw new Error(`${label} observation reported mutation`);
    const child = record(observation.currentChild ?? {}, `${label} current child`);
    if (child.presence !== "present" || typeof child.paneId !== "string") throw new Error(`${label} child is not present in the run observation`);
    return child;
  };

  /** The recipient's authoritative joined identity at delivery time. */
  const expectedIdentityOf = async (paneId: string, expectedKind: string, label: string): Promise<Record<string, unknown>> => {
    const live = record(record(await runNamed(["agent", "get", paneId])).result);
    return joinedIdentity(record(live.agent ?? live), paneId, expectedKind, `${label} expected identity`);
  };

  /** The runner the router actually selected for a launched child. */
  const routedKind = (child: Record<string, unknown>): string => String(child.operatingPointId).split(":")[0]!;

  const joinedIdentity = (value: Record<string, unknown>, paneId: string, expectedKind: string, label: string, expected?: Record<string, unknown>): Record<string, unknown> => {
    const identity = {
      paneId,
      terminalId: value.terminal_id ?? value.terminalId,
      agentName: value.agent_name ?? value.agentName ?? value.name,
      agentKind: value.agent_kind ?? value.agentKind ?? value.agent ?? value.kind,
      agentSession: value.agent_session ?? value.agentSession
    };
    for (const field of ["terminalId", "agentName", "agentKind"] as const) {
      if (typeof identity[field] !== "string" || identity[field].length === 0 || /^(?:unknown|undefined|null|placeholder|n\/a)$/iu.test(identity[field])) throw new Error(`${label} omitted joined ${field}`);
    }
    if (identity.agentKind !== expectedKind) throw new Error(`${label} completed with the wrong recipient kind`);
    const session = record(identity.agentSession, `${label} agent session`);
    for (const field of ["source", "agent", "kind", "value"]) {
      if (typeof session[field] !== "string" || session[field].length === 0 || /^(?:unknown|undefined|null|placeholder|n\/a)$/iu.test(session[field])) throw new Error(`${label} omitted joined agentSession.${field}`);
    }
    if (expected) {
      for (const field of ["paneId", "terminalId", "agentName", "agentKind"] as const) if (identity[field] !== expected[field]) throw new Error(`${label} completion identity changed ${field}`);
      const expectedSession = record(expected.agentSession, `${label} expected agent session`);
      for (const field of ["source", "agent", "kind", "value"]) if (session[field] !== expectedSession[field]) throw new Error(`${label} completion identity changed agentSession.${field}`);
    }
    // Retain the joined identity for failure evidence; it is not a current
    // snapshot or body-proof claim.
    state.lastJoinedIdentity = { label, ...identity };
    return identity;
  };

  const waitForRecipientCompletion = async (paneId: string, expectedKind: string, expected: Record<string, unknown>, label: string): Promise<Record<string, unknown>> => {
    const completed = await waitForCondition(
      async () => {
        const live = record(record(await runNamed(["agent", "get", paneId])).result);
        const agent = record(live.agent ?? live);
        return agent.agent_status === "idle" || agent.agent_status === "done" ? agent : undefined;
      },
      (value) => value !== undefined,
      LIVE_TIMEOUT_MS,
      100
    );
    if (!completed) throw new Error(`${label} did not reach an authoritative completed state`);
    return joinedIdentity(completed, paneId, expectedKind, label, expected);
  };

  /**
   * The retired detached-wait surface has no daemon-proxy operation, so the
   * reply proof polls the pane's rendered output for the literal body, then
   * the authoritative `agent get` completion.
   */
  const waitForBody = async (paneId: string, body: string, expectedKind: string, expected: Record<string, unknown>, label: string): Promise<Record<string, unknown>> => {
    const rendered = await waitForCondition(
      async () => paneRead(paneId).catch(() => ""),
      (text) => text.includes(body),
      LIVE_TIMEOUT_MS,
      500
    );
    if (rendered === undefined || !rendered.includes(body)) throw new Error(`${label} reply body never appeared in pane output`);
    return waitForRecipientCompletion(paneId, expectedKind, expected, label);
  };

  const generatedBody = async (path: string, expected: string, exitPath: string): Promise<{ body: string; bytes: number; sha256: string; commandExitCode: number }> => {
    const bytes = await waitForCondition(
      async () => readFile(path).catch(() => undefined),
      (value) => value !== undefined && value.toString("utf8") === expected,
      LIVE_TIMEOUT_MS,
      100
    );
    if (bytes === undefined) throw new Error(`recipient did not generate exact body file ${path}`);
    const exitBytes = await waitForCondition(
      async () => readFile(exitPath).catch(() => undefined),
      (value) => value !== undefined && /^\d+\n?$/u.test(value.toString("utf8")),
      LIVE_TIMEOUT_MS,
      100
    );
    if (exitBytes === undefined) throw new Error(`recipient did not generate command exit file ${exitPath}`);
    const body = bytes.toString("utf8");
    return { body, bytes: bytes.byteLength, sha256: digest(bytes), commandExitCode: Number.parseInt(exitBytes.toString("utf8"), 10) };
  };

  const receipt = (caseName: string, details: Record<string, unknown>, request: PromptSocketRequest, completion: Record<string, unknown>, expected: string, observed: string, actualCommandExitCode: number, extra: Record<string, unknown> = {}): Record<string, unknown> => {
    if (request.method !== "agent.prompt" || typeof request.id !== "string") throw new Error(`${caseName} did not produce exactly one socket request`);
    // The daemon launch reply publishes no dispatch block; where a surface
    // still carries one (the prompt transport's correlated id), the socket
    // request must match it.
    if (details.promptDispatch !== undefined) {
      const dispatch = record(details.promptDispatch, `${caseName} prompt dispatch`);
      if (dispatch.requestId !== request.id) throw new Error(`${caseName} socket request does not match the tool request ID`);
    }
    return {
      case: caseName,
      effect: "confirmed",
      source: "recipient-generated",
      observedBodySource: "recipient-body-file",
      session: requestedSession,
      expectedBodyBytes: Buffer.byteLength(expected, "utf8"),
      observedBodyBytes: Buffer.byteLength(observed, "utf8"),
      expectedBodySha256: digest(expected),
      observedBodySha256: digest(observed),
      nativeRequestId: request.id,
      requestCount: 1,
      actualCommandExitCode,
      identity: completion,
      ...extra
    };
  };

  const saveProvenReceipt = async (proven: Record<string, unknown>): Promise<void> => {
    state.provenReceipts.push(proven);
    if (EVIDENCE_DIR) await writeFile(join(EVIDENCE_DIR, "mcp.partial.json"), `${JSON.stringify({ label: HOTFIX_LABEL, host: "mcp", status: "blocked", actualExitCode: 1, session: requestedSession, receipts: state.provenReceipts }, null, 2)}\n`);
  };

  const assertOneRequest = (before: number, label: string): PromptSocketRequest => {
    const requests = state.proxy?.requests.slice(before) ?? [];
    if (requests.length !== 1) throw new Error(`${label} expected one socket request, observed ${requests.length}`);
    const request = requests[0]!;
    if (request.method !== "agent.prompt" || typeof request.target !== "string" || typeof request.text !== "string") throw new Error(`${label} socket receipt was incomplete`);
    return request;
  };

  /**
   * Follow-up delivery on the new contract is the `agent prompt` recipe, not a
   * tool call: the same `agent.prompt` socket write the CLI issues, sent here
   * through the prompt transport the daemon itself uses so the disposable
   * proxy still proves exactly one request.
   */
  const prompt = async (paneId: string, text: string, label: string): Promise<{ request: PromptSocketRequest; details: Record<string, unknown> }> => {
    const before = state.proxy!.requests.length;
    const envelope = await state.prompts!.prompt(paneId, text, new AbortController().signal);
    const result = record(envelope.result ?? {}, `${label} prompt result`);
    if (result.type !== "agent_prompted") throw new Error(`${label} prompt was not acknowledged`);
    const request = assertOneRequest(before, label);
    if (request.id !== envelope.id) throw new Error(`${label} socket request does not match the prompt request ID`);
    return { request, details: { promptDispatch: { state: "acknowledged", requestId: envelope.id } } };
  };

  const closePane = async (paneId: string, label: string): Promise<void> => {
    if (typeof paneId !== "string" || paneId.length === 0) throw new Error(`${label} omitted pane ID`);
    await runNamed(["pane", "close", paneId]);
    state.confirmedPanes = state.confirmedPanes.filter((value) => value !== paneId);
  };

  beforeAll(async () => {
    if (process.env.HERDR_ENV !== "1") throw new Error("MCP hotfix requires HERDR_ENV=1");
    if (![process.env.HERDR_WORKSPACE_ID, process.env.HERDR_TAB_ID, process.env.HERDR_PANE_ID].every(Boolean)) throw new Error("MCP hotfix requires an injected caller identity");
    if (!existsSync(serverEntry)) throw new Error(`built MCP entry is missing: ${serverEntry}`);
    if (!existsSync(daemonEntry)) throw new Error(`built daemon entry is missing: ${daemonEntry}`);
    // The durable supervisor pins a git workspace base at launch, so the
    // disposable cwd must be a repository with a resolvable HEAD.
    state.cwd = await createDisposableGitWorkspace("herdr-tools-hotfix-mcp-");
    const sessions = record(await run("session", "list", "--json"));
    if (Array.isArray(sessions.sessions) && sessions.sessions.some((item) => record(item).name === requestedSession)) throw new Error(`refusing to reuse existing session ${requestedSession}`);
    state.server = spawn("herdr", ["--session", requestedSession, "server"], { cwd: state.cwd, stdio: ["ignore", "ignore", "pipe"] });
    let startupError = "";
    state.server.stderr?.on("data", (chunk: Buffer) => { startupError = (startupError + chunk.toString()).slice(-2_000); });
    const started = await waitForCondition(
      async () => {
        if (state.server?.exitCode !== null) throw new Error(`named Herdr server exited during startup: ${startupError}`);
        const listed = record(await run("session", "list", "--json"));
        return Array.isArray(listed.sessions) ? listed.sessions.map((item) => record(item)).find((item) => item.name === requestedSession && item.running === true) : undefined;
      },
      (value) => value !== undefined,
      10_000,
      100
    );
    if (!started || typeof started.socket_path !== "string") throw new Error(`named Herdr server did not become ready: ${startupError}`);
    state.serverStarted = true;
    state.socketPath = started.socket_path;
    state.proxy = await startDisposableSocketProxy(state.socketPath, join(state.cwd, "herdr-prompt.sock"));

    // The three tools are stateless daemon proxies: a bare `herdr server`
    // does not serve them, so the suite runs the stock daemon entrypoint
    // against the same endpoint (the canary disposable-daemon pattern — the
    // production wiring, no hint kinds). Its traffic rides the proxy so
    // launch prompt deliveries stay countable.
    state.daemon = spawn(process.execPath, [daemonEntry], {
      cwd: state.cwd,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        HERDR_ENV: "1",
        HERDR_SOCKET_PATH: state.proxy.path
      },
      stdio: ["ignore", "ignore", "pipe"]
    });
    state.daemon.stderr?.on("data", (chunk: Buffer) => { state.daemonStderr = (state.daemonStderr + chunk.toString()).slice(-8_000); });
    const listening = await waitForCondition(
      async () => {
        if (state.daemon !== undefined && state.daemon.exitCode !== null) throw new Error(`disposable daemon exited during startup: ${state.daemonStderr}`);
        return state.daemonStderr.includes("listening on") ? true : undefined;
      },
      (value) => value === true,
      30_000,
      100
    );
    if (!listening) throw new Error(`disposable daemon did not bind: ${state.daemonStderr}`);

    const created = record(record(await runNamed(["workspace", "create", "--cwd", state.cwd, "--label", `hotfix-mcp-${process.pid}`, "--no-focus"])).result);
    state.workspaceId = String(record(created.workspace ?? created).workspace_id);
    const fixture = record(record(record(await runNamed(["api", "snapshot"])).result).snapshot);
    const root = (Array.isArray(fixture.panes) ? fixture.panes.map((item) => record(item)) : []).find((pane) => pane.workspace_id === state.workspaceId);
    if (!root || typeof root.pane_id !== "string" || typeof root.tab_id !== "string") throw new Error("hotfix fixture omitted its root pane context");
    state.rootPaneId = root.pane_id;
    state.rootTabId = root.tab_id;

    // The daemon's D2a gate requires the claimed caller pane to carry a live
    // agent session, so the fixture pane runs a real agent as the manager.
    await runNamed(["agent", "start", "hotfix-mcp-owner", "--kind", "pi", "--pane", state.rootPaneId, "--timeout", "120000"]);
    const ownerReady = await waitForCondition(
      async () => record(record(record(await runNamed(["agent", "get", state.rootPaneId!])).result).agent ?? {}),
      (agent) => (agent.agent_status === "idle" || agent.agent_status === "done") && agent.agent_session != null,
      120_000,
      1_000
    );
    if (!ownerReady) throw new Error("owner pane never reported a live agent session");

    state.transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverEntry],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        HERDR_ENV: "1",
        HERDR_SOCKET_PATH: state.proxy.path,
        HERDR_WORKSPACE_ID: state.workspaceId,
        HERDR_TAB_ID: state.rootTabId,
        HERDR_PANE_ID: state.rootPaneId,
        HERDR_PROJECT_DIR: state.cwd
      },
      stderr: "pipe"
    });
    state.client = new Client({ name: HOTFIX_LABEL, version: "1.0.0" }, { capabilities: {} });
    await state.client.connect(state.transport);
    state.prompts = createAgentPromptClient({ env: { HERDR_SOCKET_PATH: state.proxy.path } });
  }, 300_000);

  afterAll(async () => {
    await state.client?.close().catch(() => undefined);
    state.prompts?.close?.();
    if (state.preserve) {
      process.stderr.write(`${HOTFIX_LABEL} MCP host failure retained session=${requestedSession} evidence=${EVIDENCE_DIR ?? "unset"}\n`);
      await state.proxy?.close();
      state.server?.stderr?.removeAllListeners();
      state.server?.unref();
      state.daemon?.unref();
    } else {
      for (const paneId of [...state.confirmedPanes]) await runNamed(["pane", "close", paneId]).catch(() => undefined);
      if (state.workspaceId) await runNamed(["workspace", "close", state.workspaceId]).catch(() => undefined);
      await stopDisposableServer(state.daemon);
      if (state.serverStarted) await run("session", "stop", requestedSession, "--json").catch(() => undefined);
      await stopDisposableServer(state.server);
      await state.proxy?.close();
      if (state.serverStarted) await run("session", "delete", requestedSession, "--json").catch(() => undefined);
      if (state.cwd) await rm(state.cwd, { recursive: true, force: true });
    }
    if (state.preserve && EVIDENCE_DIR) {
      await writeFile(join(EVIDENCE_DIR, "mcp.partial.json"), `${JSON.stringify({
        label: HOTFIX_LABEL,
        host: "mcp",
        status: "blocked",
        actualExitCode: 1,
        session: requestedSession,
        requests: state.proxy?.requests ?? [],
        receipts: state.provenReceipts,
        ...(state.lastJoinedIdentity ? { lastJoinedIdentity: state.lastJoinedIdentity } : {}),
        confirmedPanes: state.confirmedPanes,
        workspaceId: state.workspaceId,
        rootPaneId: state.rootPaneId,
        socketPath: state.socketPath,
        daemonStderr: state.daemonStderr.slice(-2_000)
      }, null, 2)}\n`);
    }
    if (state.receipt && EVIDENCE_DIR) await writeFile(join(EVIDENCE_DIR, "mcp.json"), `${JSON.stringify(state.receipt, null, 2)}\n`);
  }, 120_000);

  it(`${HOTFIX_LABEL} executes built MCP stdio with exact socket receipts`, async () => {
    try {
      const listed = await state.client!.listTools();
      expect(listed.tools.map((item) => item.name)).toEqual([...CORE_TOOL_NAMES]);
      expect(listed.tools.every((item) => typeof item.inputSchema === "object" && item.inputSchema !== null && (item.inputSchema as { type?: unknown }).type === "object")).toBe(true);
      expect(HOTFIX_HOST_FILES).toHaveLength(2);

      // The read-only projection replaces the retired inspect surface:
      // daemon health, the caller's runs and intents, and the mailbox.
      const status = await call("herdr_status", {});
      expect(status.kind).toBe("status");
      expect(record(status.daemon, "status daemon").status).toBe("running");
      expect(Array.isArray(status.runs)).toBe(true);
      expect(Array.isArray(status.intents)).toBe(true);
      expect(typeof record(status.unread, "status unread").count).toBe("number");
      expect(typeof status.mailbox).toBe("string");

      // Schema enforcement on the proxy surface replaces the retired keys
      // rejection: both an unknown run action and a launch missing its
      // required idempotency key refuse before any daemon call.
      const invalidRun = await rawCall("herdr_run", { action: "not-a-run-action" });
      expect(invalidRun.isError).toBe(true);
      expect(textOf(invalidRun)).toContain("INVALID_INPUT");
      const missingKey = await rawCall("herdr_launch", { task: { objective: "noop", scope: "noop", doneWhen: ["noop"] } });
      expect(missingKey.isError).toBe(true);
      expect(textOf(missingKey)).toContain("INVALID_INPUT");

      const piNonce = randomUUID();
      const piBody = `HOTFIX PI COMPLETE BODY ${piNonce}`;
      const piBodyPath = join(state.cwd, `pi-inline-${piNonce}.txt`);
      const piBefore = state.proxy!.requests.length;
      const piTask = {
        objective: `Use Bash to write exactly ${piBody} to ${piBodyPath} with no trailing newline, capture that command's exit code, and write the decimal code to ${piBodyPath}.exit before replying with exactly ${piBody}. Remain ready for subsequent normal prompts.`,
        scope: `Write only ${piBodyPath} and ${piBodyPath}.exit; do not change any other resource.`,
        doneWhen: [`The recipient-generated file ${piBodyPath} contains exactly ${piBody}.`],
        constraints: ["none"],
        label: `hotfix-mcp-pi-inline-${process.pid}`
      };
      const piKey = `mcp-inline-${piNonce}`;
      const pi = await call("herdr_launch", { task: piTask, idempotencyKey: piKey });
      const piChild = launchedChildOf(pi, "MCP Pi inline launch");
      const piKind = routedKind(piChild);
      const piRunId = String(piChild.runId);
      const piStatus = await waitStatusChild(piRunId, "MCP Pi inline launch");
      const piPaneId = String(piStatus.paneId);
      state.confirmedPanes.push(piPaneId);
      const piRequest = assertOneRequest(piBefore, "MCP Pi inline launch");
      expect(piRequest.text).toContain("delivery: inline");
      expect(piRequest.text).toContain("[HERDR AGENT MESSAGE v1]");
      const piExpectedIdentity = await expectedIdentityOf(piPaneId, piKind, "MCP Pi inline");

      // The idempotency binding replays with zero new effect: same launch ID
      // and children, and no second prompt reaches the socket.
      const replayBefore = state.proxy!.requests.length;
      const replay = await call("herdr_launch", { task: piTask, idempotencyKey: piKey });
      expect(replay).toMatchObject({ kind: "launch", launchId: pi.launchId, state: "completed", replayed: false });
      expect(state.proxy!.requests.length).toBe(replayBefore);

      // The intent and run now project into the caller's read-only status.
      const projected = await call("herdr_status", {});
      const ownIntent = (Array.isArray(projected.intents) ? projected.intents : []).map((item) => record(item)).find((item) => item.idempotencyKey === piKey);
      expect(ownIntent?.state).toBe("completed");
      expect((Array.isArray(projected.runs) ? projected.runs : []).map((item) => record(item)).some((item) => item.runId === piRunId)).toBe(true);

      const piGenerated = await generatedBody(piBodyPath, piBody, `${piBodyPath}.exit`);
      const piCompletion = await waitForBody(piPaneId, piBody, piKind, piExpectedIdentity, "MCP Pi inline launch");
      // `herdr_run` observe coverage on the settled run: the
      // provenance-verified observation cross-checks the status-projected
      // pane and asserts the read-only flags the daemon surface guarantees.
      const piObserved = await observeChild(piRunId, "MCP Pi inline run observation");
      expect(piObserved.paneId).toBe(piPaneId);
      const piReceipt = receipt("pi-inline-launch", pi, piRequest, piCompletion, piBody, piGenerated.body, piGenerated.commandExitCode, { bodyFilePath: piBodyPath, commandExitFilePath: `${piBodyPath}.exit`, generatedBodySha256: piGenerated.sha256 });
      await saveProvenReceipt(piReceipt);

      const steerNonce = randomUUID();
      const steerBody = `HOTFIX STEER COMPLETE BODY ${steerNonce}`;
      const steerPath = join(state.cwd, `mcp-steer-${steerNonce}.txt`);
      const steerGatePath = join(state.cwd, `mcp-steer-gate-${steerNonce}.txt`);
      const steerGateToken = `HOTFIX STEER GATE ${steerNonce}`;
      await execFileAsync("mkfifo", [steerGatePath]);
      const steer = await call("herdr_launch", {
        task: {
          objective: `Use Bash to run the bounded condition command timeout 90s bash -c 'IFS= read -r gate < ${steerGatePath} && test "$gate" = "${steerGateToken}"' in the foreground. Do not use sleep. Remain in this turn until that condition exits, then remain ready for the subsequent steer instruction. Do not write a body or send a final response before the steer.`,
          scope: `Read only ${steerGatePath}; write only ${steerPath} and ${steerPath}.exit; do not change any other resource.`,
          // ADR-037 quality gate: doneWhen must name falsifiable evidence —
          // "stays pending" is rejected as unverifiable, so name the checkable
          // facts (no reply sent, no body file) instead.
          doneWhen: [`The turn stays open on the bounded gate: the recipient sends no reply and ${steerPath} does not exist before the follow-up steer instruction.`],
          constraints: ["none"],
          label: `hotfix-mcp-steer-${process.pid}`
        },
        idempotencyKey: `mcp-steer-${steerNonce}`
      });
      const steerChild = launchedChildOf(steer, "MCP steer launch");
      const steerKind = routedKind(steerChild);
      const steerRunId = String(steerChild.runId);
      const steerStatus = await waitStatusChild(steerRunId, "MCP steer launch");
      const steerPaneId = String(steerStatus.paneId);
      state.confirmedPanes.push(steerPaneId);
      const steerExpectedIdentity = await expectedIdentityOf(steerPaneId, steerKind, "MCP steer");
      // The working state is observed through the status projection the
      // retired inspect call used to provide.
      await waitStatusState(steerRunId, ["working"], 30_000, "MCP steer while working");
      const steerText = `After the current Bash condition completes, use Bash to write exactly ${steerBody} to ${steerPath} with no trailing newline, capture that command's exit code, write the decimal code to ${steerPath}.exit, then reply exactly ${steerBody}.`;
      const steered = await prompt(steerPaneId, steerText, "MCP steer while working");
      const steerRequest = steered.request;
      expect(steerRequest.text).toBe(steerText);
      await appendFile(steerGatePath, `${steerGateToken}\n`);
      const steerGenerated = await generatedBody(steerPath, steerBody, `${steerPath}.exit`);
      const steerCompletion = await waitForBody(steerPaneId, steerBody, steerKind, steerExpectedIdentity, "MCP steer while working");
      const steerReceipt = receipt("steer-working", steered.details, steerRequest, steerCompletion, steerBody, steerGenerated.body, steerGenerated.commandExitCode, { bodyFilePath: steerPath, commandExitFilePath: `${steerPath}.exit`, generatedBodySha256: steerGenerated.sha256 });
      await saveProvenReceipt(steerReceipt);
      await closePane(steerPaneId, "MCP steer recipient");

      const smokeNonce = randomUUID();
      const smokeBody = `HOTFIX SEVEN TOOL SMOKE BODY ${smokeNonce}`;
      const smokePath = join(state.cwd, `mcp-smoke-${smokeNonce}.txt`);
      const smokeText = `For this normal follow-up, use Bash to write exactly ${smokeBody} to ${smokePath} with no trailing newline, capture that command's exit code, write the decimal code to ${smokePath}.exit, then reply exactly ${smokeBody}. Do not reply before both files are exact.`;
      const smoked = await prompt(piPaneId, smokeText, "MCP normal prompt smoke");
      const smokeRequest = smoked.request;
      expect(smokeRequest.text).toBe(smokeText);
      const smokeGenerated = await generatedBody(smokePath, smokeBody, `${smokePath}.exit`);
      const smokeCompletion = await waitForBody(piPaneId, smokeBody, piKind, piExpectedIdentity, "MCP Pi three-tool normal prompt");
      const smokeReceipt = receipt("seven-tool-smoke", smoked.details, smokeRequest, smokeCompletion, smokeBody, smokeGenerated.body, smokeGenerated.commandExitCode, { bodyFilePath: smokePath, commandExitFilePath: `${smokePath}.exit`, generatedBodySha256: smokeGenerated.sha256 });
      await saveProvenReceipt(smokeReceipt);

      const normalNonce = randomUUID();
      const normalBody = `HOTFIX NORMAL COMPLETE BODY ${normalNonce}`;
      const normalPath = join(state.cwd, `mcp-normal-${normalNonce}.txt`);
      const normalText = `For this normal follow-up, use Bash to write exactly ${normalBody} to ${normalPath} with no trailing newline, capture that command's exit code, write the decimal code to ${normalPath}.exit, then reply exactly ${normalBody}. Do not reply before both files are exact.`;
      const normal = await prompt(piPaneId, normalText, "MCP normal prompt");
      const normalRequest = normal.request;
      expect(normalRequest.text).toBe(normalText);
      const normalGenerated = await generatedBody(normalPath, normalBody, `${normalPath}.exit`);
      const normalCompletion = await waitForBody(piPaneId, normalBody, piKind, piExpectedIdentity, "MCP Pi normal prompt");
      const normalReceipt = receipt("normal-prompt", normal.details, normalRequest, normalCompletion, normalBody, normalGenerated.body, normalGenerated.commandExitCode, { bodyFilePath: normalPath, commandExitFilePath: `${normalPath}.exit`, generatedBodySha256: normalGenerated.sha256 });
      await saveProvenReceipt(normalReceipt);

      // Attachment delivery is runtime-owned on the new surface: a Task whose
      // rendered assignment exceeds the inline bound publishes an attachment
      // and the prompt carries only the envelope reference.
      const attachmentNonce = randomUUID();
      const generatedAttachmentPath = join(state.cwd, `mcp-attachment-readback-${attachmentNonce}.txt`);
      const attachmentPad = `PADDING ${attachmentNonce}\n${"attachment-delivery-fixture\n".repeat(700)}`;
      const attachmentTask = {
        objective: [
          `The assignment arrives as an attachment. Read the entire attachment file named by attachment-path in your message envelope using Bash; do not use a summary, nonce, or partial body.`,
          `Use Bash to copy the attachment bytes exactly to the private expected output file ${generatedAttachmentPath}; do not add or remove a trailing newline.`,
          `Verify the copied file SHA-256 equals the independent expected attachment-sha256 from the envelope, capture that copy-and-verify command's exit code, and write the decimal code to ${generatedAttachmentPath}.exit.`,
          `Then reply with exactly attachment-sha256: <that hash> and no other text.`,
          `The block below exists only to push this assignment past the inline delivery bound; ignore its content entirely.`,
          attachmentPad
        ].join("\n"),
        scope: `Read the published attachment and write only ${generatedAttachmentPath} and ${generatedAttachmentPath}.exit; do not change any other resource.`,
        doneWhen: [`The recipient-generated file ${generatedAttachmentPath} contains exactly the bytes of the published attachment.`],
        constraints: ["none"],
        label: `hotfix-mcp-attachment-${process.pid}`
      };
      const attachmentBefore = state.proxy!.requests.length;
      const attachmentReply = await call("herdr_launch", { task: attachmentTask, idempotencyKey: `mcp-attachment-${attachmentNonce}` });
      const attachmentChild = launchedChildOf(attachmentReply, "MCP attachment launch");
      const attachmentKind = routedKind(attachmentChild);
      const attachmentRunId = String(attachmentChild.runId);
      const attachmentStatus = await waitStatusChild(attachmentRunId, "MCP attachment launch");
      const attachmentPaneId = String(attachmentStatus.paneId);
      state.confirmedPanes.push(attachmentPaneId);
      const attachmentRequest = assertOneRequest(attachmentBefore, "MCP attachment launch");
      // The attachment fields ride the delivered envelope — the wire contract
      // itself — since the uniform launch reply deliberately omits them.
      const attachmentText = attachmentRequest.text ?? "";
      const attachmentField = (name: string): string => {
        const found = attachmentText.match(new RegExp(`^attachment-${name}: (.+)$`, "m"));
        if (!found) throw new Error(`MCP attachment envelope omitted attachment-${name}`);
        return found[1]!.trim();
      };
      const attachmentPath = attachmentField("path");
      const attachmentSha256 = attachmentField("sha256");
      const attachmentBytesDeclared = Number(attachmentField("bytes"));
      state.attachmentPaths.push(attachmentPath);
      const attachmentBytes = await readFile(attachmentPath);
      const expectedAttachmentBody = attachmentBytes.toString("utf8");
      expect(attachmentText).toContain("delivery: attachment");
      expect(attachmentText).not.toContain(attachmentNonce);
      expect(attachmentBytes.byteLength).toBe(attachmentBytesDeclared);
      expect(digest(attachmentBytes)).toBe(attachmentSha256);
      const attachmentExpectedIdentity = await expectedIdentityOf(attachmentPaneId, attachmentKind, "MCP attachment");
      const generatedAttachment = await generatedBody(generatedAttachmentPath, expectedAttachmentBody, `${generatedAttachmentPath}.exit`);
      expect(generatedAttachment.bytes).toBe(attachmentBytes.byteLength);
      expect(generatedAttachment.sha256).toBe(digest(attachmentBytes));
      expect(generatedAttachment.sha256).toBe(attachmentSha256);
      const attachmentCompletion = await waitForRecipientCompletion(attachmentPaneId, attachmentKind, attachmentExpectedIdentity, "MCP attachment readback");
      const attachmentReceipt = receipt("attachment-complete-body", attachmentReply, attachmentRequest, attachmentCompletion, expectedAttachmentBody, generatedAttachment.body, generatedAttachment.commandExitCode, {
        bodyFilePath: attachmentPath,
        generatedBodyFilePath: generatedAttachmentPath,
        commandExitFilePath: `${generatedAttachmentPath}.exit`,
        generatedBodySha256: generatedAttachment.sha256,
        attachmentSha256: digest(attachmentBytes)
      });
      await saveProvenReceipt(attachmentReceipt);
      await closePane(attachmentPaneId, "MCP attachment recipient");
      await closePane(piPaneId, "MCP Pi recipient");

      const receipts = [smokeReceipt, piReceipt, normalReceipt, steerReceipt, attachmentReceipt];
      expect(new Set(receipts.map((item) => item.case))).toEqual(new Set(HOTFIX_MANDATORY_CASES));
      expect(state.commandExitCodes.length).toBeGreaterThan(0);
      expect(state.commandExitCodes.every((code) => code === 0)).toBe(true);
      state.receipt = {
        label: HOTFIX_LABEL,
        host: "mcp",
        status: "passed",
        actualExitCode: 0,
        mandatoryCases: [...HOTFIX_MANDATORY_CASES],
        toolSmoke: [...CORE_TOOL_NAMES],
        mcpPollingDifference: "MCP serves only the daemon-proxy surface (herdr_launch/herdr_run/herdr_status); this gate reads run state through herdr_run observe and herdr_status, and delivers follow-up prompts through the session-socket agent.prompt transport (the C8 agent prompt recipe), which the disposable proxy records.",
        receipts,
        socketRequests: state.proxy!.requests.length,
        literalStdin: false,
        builtEntry: serverEntry,
        modelQualification: "The hotfix recipient is the runtime-routed operating point; completion identity is cross-checked against the routed runner."
      };
    } catch (error) {
      state.preserve = true;
      throw error;
    }
  }, 900_000);
});
