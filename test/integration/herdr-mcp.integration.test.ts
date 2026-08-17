import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { HerdrCli } from "../../src/cli.js";
import { JobRegistry } from "../../src/job-registry.js";
import { RuntimeOwnership } from "../../src/ownership.js";
import { publishedInputSchema } from "../../src/mcp/adapter.js";
import { createPreflight, createToolSurface, CORE_TOOL_NAMES } from "../../src/tool-surface.js";

const execFileAsync = promisify(execFile);
const REQUIRED_SESSION = "herdr-tools-integration";
const requestedSession = process.env.HERDR_TOOLS_INTEGRATION_SESSION ?? REQUIRED_SESSION;
const enabled = process.env.HERDR_TOOLS_RUN_INTEGRATION === "1";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const serverEntry = join(repoRoot, "dist/src/mcp-server.js");
/**
 * Herdr 0.8.0 attaches a shell to a freshly created pane asynchronously and
 * exposes no readiness field, so `agent start` against a brand-new pane races
 * with `agent_pane_busy`. The launch therefore targets a pane created earlier in
 * this run, and this bounded settle covers the remainder of that gap. It relaxes
 * no assertion: the launch must still succeed and prove its evidence.
 */
const PANE_SETTLE_MS = 3_000;

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("integration response is not an object");
  return value as Record<string, unknown>;
}

/** The bounded structured evidence block the adapter appends, or the sole JSON block. */
function evidence(result: ToolResult): Record<string, unknown> {
  const details = result.content.find((block) => block.text.startsWith("herdr-details\n"));
  if (details) return record(JSON.parse(details.text.slice("herdr-details\n".length)));
  const only = result.content.at(-1);
  if (!only) throw new Error("tool result carried no content");
  return record(JSON.parse(only.text));
}

function text(result: ToolResult): string {
  return result.content.map((block) => block.text).join("\n");
}

/**
 * A surface built purely to read the shared TypeBox `parameters`, so the wire
 * schema can be compared against the schema the server validates with. No CLI
 * call is made: `tools/list` needs none.
 */
function schemaReferenceSurface() {
  const cli = new HerdrCli(async () => ({ stdout: "{}", stderr: "", code: 0, killed: false }));
  return createToolSurface({
    cli,
    context: { workspaceId: "w", tabId: "w:t", paneId: "w:p" },
    environment: { enabled: true, currentIdsPresent: true, currentIdsValid: true },
    preflight: createPreflight(cli),
    settingsLoader: async () => ({ reviewCadenceMinutes: 5, reviewerModel: "reference", reviewerThinking: "low" }),
    jobs: new JobRegistry(),
    profiles: { load: async () => ({ effective: new Map(), candidates: [], diagnostics: [] }) as never },
    ownership: new RuntimeOwnership(),
    cwd: "/reference"
  });
}

describe.skipIf(!enabled)("disposable Herdr MCP integration", () => {
  it("serves the seven tools over stdio against the named disposable session only", async () => {
    expect(requestedSession).toBe(REQUIRED_SESSION);
    expect(process.env.HERDR_ENV).toBe("1");
    expect([process.env.HERDR_WORKSPACE_ID, process.env.HERDR_TAB_ID, process.env.HERDR_PANE_ID].every(Boolean)).toBe(true);

    let workspaceId: string | undefined;
    let fixtureCreated = false;
    let sessionStarted = false;
    let server: ChildProcess | undefined;
    let client: Client | undefined;
    let failure: unknown;
    const cwd = await mkdtemp(`${tmpdir()}/herdr-mcp-it-`);
    const label = `mcp-herdr-tools-it-${process.pid}`;
    const socketPath = `/home/gabriel/.config/herdr/sessions/${REQUIRED_SESSION}/herdr.sock`;

    const run = async (...args: string[]): Promise<unknown> => {
      const result = await execFileAsync("herdr", args, { cwd, maxBuffer: 4_000_000 });
      return JSON.parse(result.stdout);
    };
    const runNamed = (args: string[]) => run("--session", REQUIRED_SESSION, ...args);
    const topologyIds = (snapshot: Record<string, unknown>) => ({
      workspaces: Array.isArray(snapshot.workspaces) ? snapshot.workspaces.map((item) => record(item).workspace_id).sort() : [],
      tabs: Array.isArray(snapshot.tabs) ? snapshot.tabs.map((item) => record(item).tab_id).sort() : [],
      panes: Array.isArray(snapshot.panes) ? snapshot.panes.map((item) => record(item).pane_id).sort() : []
    });
    const defaultSnapshot = async () => record(record(record(await run("api", "snapshot")).result).snapshot);

    try {
      const sessions = record(await run("session", "list", "--json"));
      const existing = Array.isArray(sessions.sessions) && sessions.sessions.some((session) => record(session).name === REQUIRED_SESSION);
      if (existing) throw new Error(`refusing to reuse existing session ${REQUIRED_SESSION}`);

      // The built entry is what the plugin's server map runs, so the run under
      // test is the emitted JavaScript, not the TypeScript sources.
      await execFileAsync(process.execPath, [join(repoRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"], { cwd: repoRoot, maxBuffer: 4_000_000 });

      let startupError = "";
      server = spawn("herdr", ["--session", REQUIRED_SESSION, "server"], { cwd, stdio: ["ignore", "ignore", "pipe"] });
      server.stderr?.on("data", (chunk: Buffer) => { startupError = (startupError + chunk.toString()).slice(-2_000); });
      const startupDeadline = Date.now() + 10_000;
      while (Date.now() < startupDeadline) {
        if (server.exitCode !== null) throw new Error(`named Herdr server exited during startup: ${startupError}`);
        const listed = record(await run("session", "list", "--json"));
        sessionStarted = Array.isArray(listed.sessions) && listed.sessions.some((session) => {
          const value = record(session);
          return value.name === REQUIRED_SESSION && value.running === true;
        });
        if (sessionStarted) break;
        await new Promise((settle) => setTimeout(settle, 100));
      }
      if (!sessionStarted) throw new Error(`named Herdr server did not become ready: ${startupError}`);
      const namedSocket = record((Array.isArray(record(await run("session", "list", "--json")).sessions) ? (record(await run("session", "list", "--json")).sessions as unknown[]) : []).find((session) => record(session).name === REQUIRED_SESSION));
      expect(namedSocket.socket_path).toBe(socketPath);

      const liveBaseline = topologyIds(await defaultSnapshot());
      const created = record(record(await runNamed(["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"])).result);
      workspaceId = record(created.workspace ?? created).workspace_id as string;
      if (typeof workspaceId !== "string" || workspaceId.length === 0) throw new Error("workspace create did not return an opaque workspace ID");
      fixtureCreated = true;

      const fixture = record(record(record(await runNamed(["api", "snapshot"])).result).snapshot);
      const fixturePanes = Array.isArray(fixture.panes) ? fixture.panes.map(record) : [];
      const rootPane = fixturePanes.find((pane) => pane.workspace_id === workspaceId);
      if (!rootPane || typeof rootPane.pane_id !== "string" || typeof rootPane.tab_id !== "string") throw new Error("fixture snapshot omitted its root pane context");

      // The socket path is the only thing that binds the server to the
      // disposable session; every `herdr` call it makes inherits it.
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [serverEntry],
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          HERDR_ENV: "1",
          HERDR_SOCKET_PATH: socketPath,
          HERDR_WORKSPACE_ID: workspaceId,
          HERDR_TAB_ID: rootPane.tab_id,
          HERDR_PANE_ID: rootPane.pane_id,
          CLAUDE_PROJECT_DIR: cwd
        },
        stderr: "pipe"
      });
      client = new Client({ name: "herdr-tools-integration", version: "1.0.0" }, { capabilities: {} });
      await client.connect(transport);
      let serverStderr = "";
      transport.stderr?.on("data", (chunk: Buffer) => { serverStderr += chunk.toString(); });
      const call = (name: string, args: Record<string, unknown>) => client!.callTool({ name, arguments: args }) as Promise<ToolResult>;

      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([...CORE_TOOL_NAMES]);
      expect(listed.tools.every((tool) => tool.inputSchema.type === "object")).toBe(true);

      // The schema the client receives must be the schema the server validates
      // with, so the model can never be shown a looser contract than the one
      // enforced.
      for (const definition of schemaReferenceSurface().definitions) {
        const wire = listed.tools.find((tool) => tool.name === definition.name)?.inputSchema;
        expect(wire, definition.name).toEqual(publishedInputSchema(definition.parameters));
      }
      const mixedShape = await call("herdr_inspect", { mode: "context", collection: "panes" });
      expect(mixedShape.isError).toBe(true);
      expect(text(mixedShape)).toContain("INVALID_INPUT");
      expect(text(mixedShape)).toContain("additionalProperties");

      const health = await call("herdr_inspect", { mode: "health" });
      expect(health.isError).toBeUndefined();
      expect(evidence(health)).toMatchObject({ operation: "inspect", kind: "health", outcome: "success", socketReachable: true, compatible: true, environment: { enabled: true, currentIdsPresent: true, currentIdsValid: true } });

      const profiles = await call("herdr_inspect", { mode: "collection", collection: "profiles" });
      const catalog = evidence(profiles);
      expect(catalog).toMatchObject({ operation: "inspect", kind: "collection", collection: "profiles", outcome: "success" });
      expect(Array.isArray(catalog.items) ? catalog.items : []).toHaveLength(11);
      expect(catalog.items).toEqual(expect.arrayContaining([expect.objectContaining({ name: "worker-pi", kind: "pi" })]));
      expect(catalog.diagnostics ?? []).toEqual([]);

      // Owned resources come first so the launch target has settled by the time
      // it is used, and so cleanup only ever touches this run's own fixtures.
      const split = await call("herdr_pane", { operation: "split", target: rootPane.pane_id, label: "mcp-worker", direction: "right", focus: false });
      const workerPaneId = evidence(split).paneId as string;
      expect(typeof workerPaneId).toBe("string");

      const createdTab = await call("herdr_tab", { operation: "create", label: "mcp-smoke" });
      const createdTabId = evidence(createdTab).tabId as string;
      expect(typeof createdTabId).toBe("string");
      const closedTab = await call("herdr_tab", { operation: "close", target: createdTabId });
      expect(closedTab.isError).toBeUndefined();

      const panes = await call("herdr_inspect", { mode: "collection", collection: "panes" });
      expect(evidence(panes).items).toEqual(expect.arrayContaining([expect.objectContaining({ workspace_id: workspaceId })]));

      await new Promise((settle) => setTimeout(settle, PANE_SETTLE_MS));
      const launched = await call("herdr_launch", { name: "mcp-integration-worker", profile: "worker-pi", placement: { mode: "existing_pane", target: workerPaneId }, initialPrompt: "Use the bash tool to run pwd, then report the working directory." });
      expect(launched.isError, text(launched)).toBeUndefined();
      const launchEvidence = evidence(launched);
      expect(launchEvidence).toMatchObject({
        operation: "launch",
        outcome: "launched",
        kind: "pi",
        paneId: workerPaneId,
        initialPromptSent: true,
        envelope: { version: "v1", kind: "assignment" },
        profile: { name: "worker-pi", selected: "worker-pi", runtime: { kind: "pi", model: "openai-codex/gpt-5.6-luna", thinking: "high" } }
      });
      expect(record(launchEvidence.sender).paneId).toBe(rootPane.pane_id);
      expect(record(record(launchEvidence.profile).source).kind).toBe("bundled");

      const foreground = await call("herdr_wait", { targets: [workerPaneId], match: "any", condition: { kind: "state", state: "working" }, timeoutMs: 10_000 });
      expect(foreground.isError, text(foreground)).toBeUndefined();
      expect(evidence(foreground)).toMatchObject({ operation: "wait", outcome: "success" });

      // `steer` is the provenance-preserving operation for a target that is
      // already working on its assignment; `prompt` correctly refuses to
      // interrupt one.
      const communicated = await call("herdr_communicate", { target: workerPaneId, operation: "steer", text: "Also report the current user." });
      expect(communicated.isError, text(communicated)).toBeUndefined();
      expect(evidence(communicated)).toMatchObject({ operation: "steer", envelope: { version: "v1", kind: "steer" }, sender: { paneId: rootPane.pane_id } });
      const transcript = await call("herdr_inspect", { mode: "target", target: workerPaneId });
      expect(JSON.stringify(evidence(transcript).recentUnwrappedLines)).toContain("[HERDR AGENT MESSAGE v1]");
      const unsupervised = await call("herdr_wait", { targets: [workerPaneId], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 31 * 60_000 });
      expect(unsupervised.isError).toBe(true);
      expect(text(unsupervised)).toContain("REVIEWER_FAILED");

      const detached = await call("herdr_wait", { targets: [workerPaneId], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 20_000, label: "mcp detached", runInBackground: true });
      const jobId = evidence(detached).jobId as string;
      expect(jobId.startsWith("job_")).toBe(true);
      const jobs = await call("herdr_jobs", { operation: "list" });
      expect(jobs.content).toHaveLength(1);
      expect(text(jobs)).toContain(jobId);
      const job = await call("herdr_jobs", { operation: "get", jobId });
      expect(evidence(job)).toMatchObject({ operation: "jobs", kind: "job", jobId });
      const cancelled = await call("herdr_jobs", { operation: "cancel", jobId });
      expect(cancelled.isError).toBeUndefined();

      const closedPane = await call("herdr_pane", { operation: "close", target: workerPaneId });
      expect(closedPane.isError, text(closedPane)).toBeUndefined();

      expect(serverStderr).toBe("");
      await client.close();
      client = undefined;

      // Fail-closed startup, exercised against the same built entry.
      const refusals: Array<[NodeJS.ProcessEnv, string]> = [
        [{ HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath, HERDR_WORKSPACE_ID: workspaceId, HERDR_TAB_ID: rootPane.tab_id, HERDR_PANE_ID: rootPane.pane_id }, "CLAUDE_PROJECT_DIR"],
        [{ HERDR_SOCKET_PATH: socketPath, HERDR_WORKSPACE_ID: workspaceId, HERDR_TAB_ID: rootPane.tab_id, HERDR_PANE_ID: rootPane.pane_id, CLAUDE_PROJECT_DIR: cwd }, "HERDR_ENV"],
        [{ HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath, CLAUDE_PROJECT_DIR: cwd }, "INJECTED_CONTEXT"]
      ];
      for (const [refusedEnv, reason] of refusals) {
        const refusal = await new Promise<{ code: number | null; stderr: string; stdout: string }>((settle) => {
          const child = spawn(process.execPath, [serverEntry], { cwd, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...refusedEnv }, stdio: ["pipe", "pipe", "pipe"] });
          let stderrText = "";
          let stdoutText = "";
          child.stderr.on("data", (chunk: Buffer) => { stderrText += chunk.toString(); });
          child.stdout.on("data", (chunk: Buffer) => { stdoutText += chunk.toString(); });
          child.once("close", (code) => settle({ code, stderr: stderrText, stdout: stdoutText }));
        });
        expect(refusal.code, `${reason}: ${refusal.stderr}`).not.toBe(0);
        expect(refusal.stdout).toBe("");
        expect(refusal.stderr.trimEnd().split("\n")).toHaveLength(1);
        expect(refusal.stderr).toContain(`herdr-tools mcp server refused to start: ${reason}`);
      }

      expect(topologyIds(await defaultSnapshot())).toEqual(liveBaseline);
    } catch (error) {
      failure = error;
      process.stderr.write(`INTEGRATION_FAILURE_RECORDED ${error instanceof Error ? error.message : String(error)}\n`);
      throw error;
    } finally {
      if (failure !== undefined) process.stderr.write("INTEGRATION_FAILURE_RECORDED_BEFORE_TEARDOWN\n");
      await client?.close().catch(() => undefined);
      if (fixtureCreated && workspaceId) {
        await runNamed(["workspace", "close", workspaceId]).catch((error: unknown) => process.stderr.write(`INTEGRATION_TEARDOWN_FAILURE ${String(error)}\n`));
      }
      if (sessionStarted) {
        await run("session", "stop", REQUIRED_SESSION, "--json").catch((error: unknown) => process.stderr.write(`INTEGRATION_SESSION_STOP_FAILURE ${String(error)}\n`));
        await run("session", "delete", REQUIRED_SESSION, "--json").catch((error: unknown) => process.stderr.write(`INTEGRATION_SESSION_DELETE_FAILURE ${String(error)}\n`));
      }
      if (server?.exitCode === null) server.kill("SIGTERM");
      await rm(cwd, { recursive: true, force: true });
    }
  }, 240_000);
});
