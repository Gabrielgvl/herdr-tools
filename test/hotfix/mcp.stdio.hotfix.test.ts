import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CORE_TOOL_NAMES } from "../../src/tool-surface.js";
import { HOTFIX_HOST_FILES, HOTFIX_LABEL, HOTFIX_MANDATORY_CASES, REQUIRED_SESSION } from "../../scripts/test-stdin-hotfix.js";
import { startDisposableSocketProxy, stopDisposableServer, waitForCondition, type DisposableSocketProxy, type PromptSocketRequest } from "../integration/disposable-session.js";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

const execFileAsync = promisify(execFile);
const enabled = process.env.HERDR_TOOLS_HOTFIX === "1";
const requestedSession = process.env.HERDR_TOOLS_INTEGRATION_SESSION ?? REQUIRED_SESSION;
const EVIDENCE_DIR = process.env.HERDR_TOOLS_HOTFIX_EVIDENCE_DIR;
const LIVE_TIMEOUT_MS = 120_000;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const serverEntry = join(repoRoot, "dist/src/mcp-server.js");

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
    workspaceId?: string;
    rootPaneId?: string;
    rootTabId?: string;
    socketPath?: string;
    proxy?: DisposableSocketProxy;
    client?: Client;
    transport?: StdioClientTransport;
    commandExitCodes: number[];
    confirmedPanes: string[];
    attachmentPaths: string[];
    provenReceipts: Record<string, unknown>[];
    /** The most recent joined recipient identity, retained for a failing case. */
    lastJoinedIdentity?: Record<string, unknown>;
    receipt?: Record<string, unknown>;
    preserve: boolean;
  } = { cwd: "", serverStarted: false, commandExitCodes: [], confirmedPanes: [], attachmentPaths: [], provenReceipts: [], preserve: false };

  const run = async (...args: string[]): Promise<unknown> => {
    try {
      const result = await execFileAsync("herdr", args, { cwd: state.cwd, env: envWithoutInjected(), maxBuffer: 4_000_000 });
      state.commandExitCodes.push(0);
      return JSON.parse(String(result.stdout));
    } catch (error) {
      const failed = error as Error & { code?: number };
      state.commandExitCodes.push(typeof failed.code === "number" ? failed.code : 1);
      throw error;
    }
  };
  const runNamed = (args: string[]) => run("--session", REQUIRED_SESSION, ...args);

  const rawCall = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    if (!state.client) throw new Error("MCP client is not connected");
    const result = await state.client.callTool({ name, arguments: args }) as ToolResult;
    return result;
  };
  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const result = await rawCall(name, args);
    if (result.isError) throw new Error(`${name} failed: ${textOf(result)}`);
    return evidence(result);
  };

  const joinedIdentity = (value: Record<string, unknown>, paneId: string, expectedKind: "pi" | "claude", label: string, expected?: Record<string, unknown>): Record<string, unknown> => {
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

  const waitForRecipientCompletion = async (paneId: string, expectedKind: "pi" | "claude", expected: Record<string, unknown>, label: string): Promise<Record<string, unknown>> => {
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

  const waitForBody = async (paneId: string, body: string, expectedKind: "pi" | "claude", expected: Record<string, unknown>, label: string): Promise<Record<string, unknown>> => {
    const waiting = await call("herdr_wait", {
      targets: [paneId], match: "any", condition: { kind: "output", match: { kind: "literal", value: body } }, timeoutMs: LIVE_TIMEOUT_MS, label
    });
    const jobId = waiting.jobId;
    if (typeof jobId !== "string") throw new Error(`${label} omitted its wait job ID`);
    const settled = await waitForCondition(
      async () => call("herdr_jobs", { operation: "get", jobId }),
      (job) => job?.operation_phase === "settled",
      LIVE_TIMEOUT_MS,
      100
    );
    expect(settled).toMatchObject({ operation_phase: "settled", wait_result: "condition_met", result: { matched: true } });
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
    const dispatch = record(details.promptDispatch, `${caseName} prompt dispatch`);
    if (dispatch.requestId !== request.id) throw new Error(`${caseName} socket request does not match the tool request ID`);
    return {
      case: caseName,
      effect: "confirmed",
      source: "recipient-generated",
      observedBodySource: "recipient-body-file",
      session: REQUIRED_SESSION,
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
    if (EVIDENCE_DIR) await writeFile(join(EVIDENCE_DIR, "mcp.partial.json"), `${JSON.stringify({ label: HOTFIX_LABEL, host: "mcp", status: "blocked", actualExitCode: 1, session: REQUIRED_SESSION, receipts: state.provenReceipts }, null, 2)}\n`);
  };

  const assertOneRequest = (before: number, label: string): PromptSocketRequest => {
    const requests = state.proxy?.requests.slice(before) ?? [];
    if (requests.length !== 1) throw new Error(`${label} expected one socket request, observed ${requests.length}`);
    const request = requests[0]!;
    if (request.method !== "agent.prompt" || typeof request.target !== "string" || typeof request.text !== "string") throw new Error(`${label} socket receipt was incomplete`);
    return request;
  };

  beforeAll(async () => {
    if (requestedSession !== REQUIRED_SESSION) throw new Error(`hotfix session must be ${REQUIRED_SESSION}`);
    if (process.env.HERDR_ENV !== "1") throw new Error("MCP hotfix requires HERDR_ENV=1");
    if (![process.env.HERDR_WORKSPACE_ID, process.env.HERDR_TAB_ID, process.env.HERDR_PANE_ID].every(Boolean)) throw new Error("MCP hotfix requires an injected caller identity");
    if (!existsSync(serverEntry)) throw new Error(`built MCP entry is missing: ${serverEntry}`);
    state.cwd = await mkdtemp(join(tmpdir(), `herdr-tools-hotfix-mcp-${process.pid}-`));
    const sessions = record(await run("session", "list", "--json"));
    if (Array.isArray(sessions.sessions) && sessions.sessions.some((item) => record(item).name === REQUIRED_SESSION)) throw new Error(`refusing to reuse existing session ${REQUIRED_SESSION}`);
    state.server = spawn("herdr", ["--session", REQUIRED_SESSION, "server"], { cwd: state.cwd, stdio: ["ignore", "ignore", "pipe"] });
    let startupError = "";
    state.server.stderr?.on("data", (chunk: Buffer) => { startupError = (startupError + chunk.toString()).slice(-2_000); });
    const started = await waitForCondition(
      async () => {
        if (state.server?.exitCode !== null) throw new Error(`named Herdr server exited during startup: ${startupError}`);
        const listed = record(await run("session", "list", "--json"));
        return Array.isArray(listed.sessions) ? listed.sessions.map((item) => record(item)).find((item) => item.name === REQUIRED_SESSION && item.running === true) : undefined;
      },
      (value) => value !== undefined,
      10_000,
      100
    );
    if (!started || typeof started.socket_path !== "string") throw new Error(`named Herdr server did not become ready: ${startupError}`);
    state.serverStarted = true;
    state.socketPath = started.socket_path;
    state.proxy = await startDisposableSocketProxy(state.socketPath, join(state.cwd, "herdr-prompt.sock"));

    const created = record(record(await runNamed(["workspace", "create", "--cwd", state.cwd, "--label", `hotfix-mcp-${process.pid}`, "--no-focus"])).result);
    state.workspaceId = String(record(created.workspace ?? created).workspace_id);
    const fixture = record(record(record(await runNamed(["api", "snapshot"])).result).snapshot);
    const root = (Array.isArray(fixture.panes) ? fixture.panes.map((item) => record(item)) : []).find((pane) => pane.workspace_id === state.workspaceId);
    if (!root || typeof root.pane_id !== "string" || typeof root.tab_id !== "string") throw new Error("hotfix fixture omitted its root pane context");
    state.rootPaneId = root.pane_id;
    state.rootTabId = root.tab_id;

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
  }, 120_000);

  afterAll(async () => {
    await state.client?.close().catch(() => undefined);
    if (state.preserve) {
      process.stderr.write(`${HOTFIX_LABEL} MCP host failure retained session=${REQUIRED_SESSION} evidence=${EVIDENCE_DIR ?? "unset"}\n`);
      await state.proxy?.close();
      state.server?.stderr?.removeAllListeners();
      state.server?.unref();
    } else {
      for (const paneId of [...state.confirmedPanes]) await runNamed(["pane", "close", paneId]).catch(() => undefined);
      if (state.workspaceId) await runNamed(["workspace", "close", state.workspaceId]).catch(() => undefined);
      if (state.serverStarted) await run("session", "stop", REQUIRED_SESSION, "--json").catch(() => undefined);
      await stopDisposableServer(state.server);
      await state.proxy?.close();
      if (state.serverStarted) await run("session", "delete", REQUIRED_SESSION, "--json").catch(() => undefined);
      if (state.cwd) await rm(state.cwd, { recursive: true, force: true });
    }
    if (state.preserve && EVIDENCE_DIR) {
      await writeFile(join(EVIDENCE_DIR, "mcp.partial.json"), `${JSON.stringify({
        label: HOTFIX_LABEL,
        host: "mcp",
        status: "blocked",
        actualExitCode: 1,
        session: REQUIRED_SESSION,
        requests: state.proxy?.requests ?? [],
        receipts: state.provenReceipts,
        ...(state.lastJoinedIdentity ? { lastJoinedIdentity: state.lastJoinedIdentity } : {}),
        confirmedPanes: state.confirmedPanes,
        workspaceId: state.workspaceId,
        rootPaneId: state.rootPaneId,
        socketPath: state.socketPath
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

      await call("herdr_inspect", { mode: "health" });
      await call("herdr_inspect", { mode: "collection", collection: "profiles" });
      const tab = await call("herdr_tab", { operation: "create", label: `${HOTFIX_LABEL}-tab` });
      expect(typeof tab.tabId).toBe("string");
      await call("herdr_tab", { operation: "close", target: String(tab.tabId) });
      const pane = await call("herdr_pane", { operation: "split", target: state.rootPaneId!, direction: "right", label: `${HOTFIX_LABEL}-pane`, focus: false });
      expect(typeof pane.paneId).toBe("string");
      await call("herdr_pane", { operation: "close", target: String(pane.paneId) });
      const invalidKeys = await rawCall("herdr_communicate", { target: state.rootPaneId!, operation: "keys", keys: ["not-a-supported-key"] });
      expect(invalidKeys.isError).toBe(true);
       expect(textOf(invalidKeys)).toContain("INVALID_INPUT");

      const piNonce = randomUUID();
      const piBody = `HOTFIX PI COMPLETE BODY ${piNonce}`;
      const piBodyPath = join(state.cwd, `pi-inline-${piNonce}.txt`);
      const piBefore = state.proxy!.requests.length;
      const pi = await call("herdr_launch", {
        name: `hotfix-mcp-pi-inline-${process.pid}`,
        profile: "worker-pi",
        placement: { mode: "new_tab", tabLabel: `${HOTFIX_LABEL}-pi-inline` },
        assignmentDelivery: "inline",
        assignment: {
          objective: `Use Bash to write exactly ${piBody} to ${piBodyPath} with no trailing newline, capture that command's exit code, and write the decimal code to ${piBodyPath}.exit before replying with exactly ${piBody}. Remain ready for subsequent normal and attachment prompts.`,
          scope: `Write only ${piBodyPath} and ${piBodyPath}.exit; do not change any other resource.`,
          verification: `The recipient-generated file ${piBodyPath} contains exactly ${piBody}.`
        },
        supervisionDigest: { doneWhen: [`The recipient-generated file ${piBodyPath} contains exactly ${piBody}.`], constraints: ["none"] }
      });
      state.confirmedPanes.push(String(pi.paneId));
      expect(pi).toMatchObject({ initialPromptDelivery: "inline", promptSubmitted: true, promptConsumption: "confirmed", recipient: { kind: "pi" }, promptDispatch: { state: "acknowledged" } });
      const piRequest = assertOneRequest(piBefore, "MCP Pi inline launch");
      expect(piRequest.text).toContain("delivery: inline");
      const piExpectedIdentity = joinedIdentity(record(pi.initialPromptSubmission ?? pi.submission, "MCP Pi inline submission"), String(pi.paneId), "pi", "MCP Pi inline expected identity");
      const piGenerated = await generatedBody(piBodyPath, piBody, `${piBodyPath}.exit`);
      const wait = await call("herdr_wait", { targets: [String(pi.paneId)], match: "any", condition: { kind: "output", match: { kind: "literal", value: `hotfix-impossible-${randomUUID()}` } }, timeoutMs: 30_000, label: `${HOTFIX_LABEL} smoke wait` });
      const waitJobId = wait.jobId;
      if (typeof waitJobId !== "string") throw new Error("smoke wait omitted its job ID");
      await call("herdr_jobs", { operation: "list" });
      const acceptedWait = await call("herdr_jobs", { operation: "get", jobId: waitJobId });
      expect(acceptedWait).toMatchObject({ jobId: waitJobId });
      const cancelledWait = await call("herdr_jobs", { operation: "cancel", jobId: waitJobId });
      expect(cancelledWait).toMatchObject({ jobId: waitJobId, operation_phase: "settled", wait_result: "cancelled" });
      const settledWait = await call("herdr_jobs", { operation: "get", jobId: waitJobId });
      expect(settledWait).toMatchObject({ jobId: waitJobId, operation_phase: "settled", wait_result: "cancelled" });
      const piCompletion = await waitForBody(String(pi.paneId), piBody, "pi", piExpectedIdentity, "MCP Pi inline launch");
      const piReceipt = receipt("pi-inline-launch", pi, piRequest, piCompletion, piBody, piGenerated.body, piGenerated.commandExitCode, { bodyFilePath: piBodyPath, commandExitFilePath: `${piBodyPath}.exit`, generatedBodySha256: piGenerated.sha256 });
      await saveProvenReceipt(piReceipt);
      const steerNonce = randomUUID();
      const steerBody = `HOTFIX STEER COMPLETE BODY ${steerNonce}`;
      const steerPath = join(state.cwd, `mcp-steer-${steerNonce}.txt`);
      const steerGatePath = join(state.cwd, `mcp-steer-gate-${steerNonce}.txt`);
      const steerGateToken = `HOTFIX STEER GATE ${steerNonce}`;
      await execFileAsync("mkfifo", [steerGatePath]);
      const steer = await call("herdr_launch", {
        name: `hotfix-mcp-steer-${process.pid}`,
        profile: "worker-pi",
        placement: { mode: "new_tab", tabLabel: `${HOTFIX_LABEL}-steer` },
        assignmentDelivery: "inline",
        assignment: {
          objective: `Use Bash to run the bounded condition command timeout 90s bash -c 'IFS= read -r gate < ${steerGatePath} && test "$gate" = "${steerGateToken}"' in the foreground. Do not use sleep. Remain in this turn until that condition exits, then remain ready for the subsequent steer instruction. Do not write a body or send a final response before the steer.`,
          scope: `Read only ${steerGatePath}; write only ${steerPath} and ${steerPath}.exit; do not change any other resource.`,
          verification: "The bounded gate remains pending until the subsequent steer instruction."
        },
        supervisionDigest: { doneWhen: ["The bounded gate remains pending until the subsequent steer instruction."], constraints: ["none"] }
      });
      state.confirmedPanes.push(String(steer.paneId));
      const steerWorking = await waitForCondition(
        async () => {
          const live = await call("herdr_inspect", { mode: "target", target: String(steer.paneId) });
          const metadata = record(live.metadata ?? {});
          return metadata.agent_status;
        },
        (value) => value === "working",
        30_000,
        100
      );
      expect(steerWorking).toBe("working");
      const steerBefore = state.proxy!.requests.length;
      const steerDetails = await call("herdr_communicate", { target: String(steer.paneId), operation: "steer", text: `After the current Bash condition completes, use Bash to write exactly ${steerBody} to ${steerPath} with no trailing newline, capture that command's exit code, write the decimal code to ${steerPath}.exit, then reply exactly ${steerBody}.`, delivery: "inline" });
      const steerRequest = assertOneRequest(steerBefore, "MCP steer while working");
      expect(steerRequest.text).toContain("delivery: inline");
      const steerExpectedIdentity = joinedIdentity(record(steerDetails.submission ?? steerDetails.initialPromptSubmission, "MCP steer submission"), String(steer.paneId), "pi", "MCP steer expected identity");
      await appendFile(steerGatePath, `${steerGateToken}\n`);
      const steerGenerated = await generatedBody(steerPath, steerBody, `${steerPath}.exit`);
      const steerCompletion = await waitForBody(String(steer.paneId), steerBody, "pi", steerExpectedIdentity, "MCP steer while working");
      const steerReceipt = receipt("steer-working", steerDetails, steerRequest, steerCompletion, steerBody, steerGenerated.body, steerGenerated.commandExitCode, { bodyFilePath: steerPath, commandExitFilePath: `${steerPath}.exit`, generatedBodySha256: steerGenerated.sha256 });
      await saveProvenReceipt(steerReceipt);
      await rawCall("herdr_pane", { operation: "close", target: String(steer.paneId) });
      state.confirmedPanes = state.confirmedPanes.filter((value) => value !== String(steer.paneId));

      const smokeNonce = randomUUID();
      const smokeBody = `HOTFIX SEVEN TOOL SMOKE BODY ${smokeNonce}`;
      const smokePath = join(state.cwd, `mcp-smoke-${smokeNonce}.txt`);
      const smokeBefore = state.proxy!.requests.length;
      const smokeDetails = await call("herdr_communicate", { target: String(pi.paneId), operation: "prompt", text: `For this normal follow-up, use Bash to write exactly ${smokeBody} to ${smokePath} with no trailing newline, capture that command's exit code, write the decimal code to ${smokePath}.exit, then reply exactly ${smokeBody}. Do not reply before both files are exact.`, delivery: "inline" });
      const smokeRequest = assertOneRequest(smokeBefore, "MCP normal prompt smoke");
      expect(smokeRequest.text).toContain("delivery: inline");
      const smokeExpectedIdentity = joinedIdentity(record(smokeDetails.submission ?? smokeDetails.initialPromptSubmission, "MCP Pi smoke submission"), String(pi.paneId), "pi", "MCP Pi smoke expected identity");
      const smokeGenerated = await generatedBody(smokePath, smokeBody, `${smokePath}.exit`);
      const smokeCompletion = await waitForBody(String(pi.paneId), smokeBody, "pi", smokeExpectedIdentity, "MCP Pi seven-tool normal prompt");
      const smokeReceipt = receipt("seven-tool-smoke", smokeDetails, smokeRequest, smokeCompletion, smokeBody, smokeGenerated.body, smokeGenerated.commandExitCode, { bodyFilePath: smokePath, commandExitFilePath: `${smokePath}.exit`, generatedBodySha256: smokeGenerated.sha256 });
      await saveProvenReceipt(smokeReceipt);

      const normalNonce = randomUUID();
      const normalBody = `HOTFIX NORMAL COMPLETE BODY ${normalNonce}`;
      const normalPath = join(state.cwd, `mcp-normal-${normalNonce}.txt`);
      const normalBefore = state.proxy!.requests.length;
      const normalDetails = await call("herdr_communicate", { target: String(pi.paneId), operation: "prompt", text: `For this normal follow-up, use Bash to write exactly ${normalBody} to ${normalPath} with no trailing newline, capture that command's exit code, write the decimal code to ${normalPath}.exit, then reply exactly ${normalBody}. Do not reply before both files are exact.`, delivery: "inline" });
      const normalRequest = assertOneRequest(normalBefore, "MCP normal prompt");
      const normalExpectedIdentity = joinedIdentity(record(normalDetails.submission ?? normalDetails.initialPromptSubmission, "MCP Pi normal submission"), String(pi.paneId), "pi", "MCP Pi normal expected identity");
      const normalGenerated = await generatedBody(normalPath, normalBody, `${normalPath}.exit`);
      const normalCompletion = await waitForBody(String(pi.paneId), normalBody, "pi", normalExpectedIdentity, "MCP Pi normal prompt");
      const normalReceipt = receipt("normal-prompt", normalDetails, normalRequest, normalCompletion, normalBody, normalGenerated.body, normalGenerated.commandExitCode, { bodyFilePath: normalPath, commandExitFilePath: `${normalPath}.exit`, generatedBodySha256: normalGenerated.sha256 });
      await saveProvenReceipt(normalReceipt);

      const attachmentNonce = randomUUID();
      const generatedAttachmentPath = join(state.cwd, `mcp-pi-attachment-readback-${attachmentNonce}.txt`);
      const attachmentBody = [
        `HOTFIX ATTACHMENT COMPLETE BODY ${attachmentNonce}`,
        "Read the entire attachment from its envelope using attachment-path; do not use a summary, nonce, or partial body.",
        `Use Bash to copy the attachment bytes exactly to the private expected output file ${generatedAttachmentPath}; do not add or remove a trailing newline.`,
        `Verify the copied file SHA-256 equals the independent expected attachment-sha256 from the envelope, capture that copy-and-verify command's exit code, and write the decimal code to ${generatedAttachmentPath}.exit.`,
        "Then reply with exactly attachment-sha256: <that hash> and no other text."
      ].join("\n");
      const attachmentBefore = state.proxy!.requests.length;
      const attachmentDetails = await call("herdr_communicate", { target: String(pi.paneId), operation: "prompt", delivery: "attachment", text: attachmentBody });
      const attachmentRequest = assertOneRequest(attachmentBefore, "MCP attachment prompt");
      const attachment = record(attachmentDetails.attachment, "MCP attachment receipt");
      if (typeof attachment.path !== "string") throw new Error("MCP attachment omitted body path");
      if (typeof attachment.bytes !== "number" || typeof attachment.sha256 !== "string") throw new Error("MCP attachment omitted byte/hash metadata");
      state.attachmentPaths.push(attachment.path);
      const attachmentBytes = await readFile(attachment.path);
      const expectedAttachmentBytes = Buffer.from(attachmentBody, "utf8");
      expect(Buffer.compare(attachmentBytes, expectedAttachmentBytes)).toBe(0);
      expect(attachmentRequest.text).toContain("delivery: attachment");
      expect(attachmentRequest.text).toContain(`attachment-sha256: ${String(attachment.sha256)}`);
      expect(attachmentRequest.text).not.toContain(attachmentBody);
      const attachmentExpectedIdentity = joinedIdentity(record(attachmentDetails.submission ?? attachmentDetails.initialPromptSubmission, "MCP Pi attachment submission"), String(pi.paneId), "pi", "MCP Pi attachment expected identity");
      const generatedAttachment = await generatedBody(generatedAttachmentPath, attachmentBody, `${generatedAttachmentPath}.exit`);
      expect(Buffer.compare(Buffer.from(generatedAttachment.body, "utf8"), expectedAttachmentBytes)).toBe(0);
      expect(generatedAttachment.bytes).toBe(expectedAttachmentBytes.byteLength);
      expect(generatedAttachment.sha256).toBe(digest(expectedAttachmentBytes));
      expect(generatedAttachment.sha256).toBe(attachment.sha256);
      expect(attachmentBytes.byteLength).toBe(expectedAttachmentBytes.byteLength);
      expect(attachment.bytes).toBe(expectedAttachmentBytes.byteLength);
      const attachmentCompletion = await waitForRecipientCompletion(String(pi.paneId), "pi", attachmentExpectedIdentity, "MCP Pi attachment readback");
      const attachmentReceipt = receipt("attachment-complete-body", attachmentDetails, attachmentRequest, attachmentCompletion, attachmentBody, generatedAttachment.body, generatedAttachment.commandExitCode, {
        bodyFilePath: attachment.path,
        generatedBodyFilePath: generatedAttachmentPath,
        commandExitFilePath: `${generatedAttachmentPath}.exit`,
        generatedBodySha256: generatedAttachment.sha256,
        attachmentSha256: digest(attachmentBytes)
      });
      await saveProvenReceipt(attachmentReceipt);
      const piKeys = await call("herdr_communicate", { target: String(pi.paneId), operation: "keys", keys: ["escape"] });
      expect(piKeys).toMatchObject({ operation: "keys" });
      await rawCall("herdr_pane", { operation: "close", target: String(pi.paneId) });
      state.confirmedPanes = state.confirmedPanes.filter((value) => value !== String(pi.paneId));

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
        mcpPollingDifference: "MCP has no Pi push footer or model-backed explicit-wait reviewer; this gate polls herdr_jobs and uses active supervision coverage for the bounded wait.",
        receipts,
        socketRequests: state.proxy!.requests.length,
        literalStdin: false,
        builtEntry: serverEntry,
        modelQualification: "Pi is the only qualified hotfix recipient; Claude and AGY remain explicitly blocked."
      };
    } catch (error) {
      state.preserve = true;
      throw error;
    }
  }, 900_000);
});
