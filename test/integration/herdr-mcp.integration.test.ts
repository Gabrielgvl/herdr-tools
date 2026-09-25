import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chmod, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { publishedInputSchema } from "../../src/mcp/adapter.js";
import { createToolSurface, CORE_TOOL_NAMES } from "../../src/tool-surface.js";
import { createDisposableGitWorkspace, stopDisposableServer } from "./disposable-session.js";

const execFileAsync = promisify(execFile);
const REQUIRED_SESSION = "herdr-tools-integration";
const requestedSession = process.env.HERDR_TOOLS_INTEGRATION_SESSION ?? REQUIRED_SESSION;
const enabled = process.env.HERDR_TOOLS_RUN_INTEGRATION === "1";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const serverEntry = join(repoRoot, "dist/src/mcp-server.js");

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("integration response is not an object");
  return value as Record<string, unknown>;
}

function text(result: ToolResult): string {
  return result.content.map((block) => block.text).join("\n");
}

/**
 * A surface built purely to read the shared TypeBox `parameters`, so the wire
 * schema can be compared against the schema the server validates with. No
 * daemon call is made: `tools/list` needs none.
 */
function schemaReferenceSurface() {
  return createToolSurface({
    connectDaemon: async () => { throw new Error("schema reference connects nothing"); },
    cwd: "/reference"
  });
}

describe.skipIf(!enabled)("disposable Herdr MCP integration", () => {
  it("serves the three daemon-proxy tools over stdio against the named disposable session only", async () => {
    expect(requestedSession).toBe(REQUIRED_SESSION);
    expect(process.env.HERDR_ENV).toBe("1");
    expect([process.env.HERDR_WORKSPACE_ID, process.env.HERDR_TAB_ID, process.env.HERDR_PANE_ID].every(Boolean)).toBe(true);

    let workspaceId: string | undefined;
    let sessionStarted = false;
    let server: ChildProcess | undefined;
    let client: Client | undefined;
    let failure: unknown;
    const cwd = await createDisposableGitWorkspace("herdr-mcp-it-");
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
      const startupDeadline = performance.now() + 10_000;
      while (performance.now() < startupDeadline) {
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
      // `herdr server` creates the session directory honoring the process umask,
      // which is 002 on hosts whose primary group is the user: the dir lands
      // 0775 and the handoff/lock namespaces reject any group-writable parent.
      // The disposable session is deleted at teardown, so tightening it here is
      // safe; it does not relax the production owner-only check.
      await chmod(dirname(socketPath), 0o700);

      const liveBaseline = topologyIds(await defaultSnapshot());
      const created = record(record(await runNamed(["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"])).result);
      workspaceId = record(created.workspace ?? created).workspace_id as string;
      if (typeof workspaceId !== "string" || workspaceId.length === 0) throw new Error("workspace create did not return an opaque workspace ID");
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
          HERDR_PROJECT_DIR: cwd
        },
        stderr: "pipe"
      });
      client = new Client({ name: "herdr-tools-integration", version: "1.0.0" }, { capabilities: {} });
      await client.connect(transport);
      let serverStderr = "";
      transport.stderr?.on("data", (chunk: Buffer) => { serverStderr += chunk.toString(); });

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

      // The proxy is fail-closed: a call that cannot reach a verified daemon
      // path returns one bounded typed error, never an in-process fallback and
      // never a crash. A bare disposable session runs no tools daemon, and the
      // fixture pane carries no agent session either way.
      const status = await (client.callTool({ name: "herdr_status", arguments: {} }) as Promise<ToolResult>);
      expect(status.isError, text(status)).toBe(true);
      const failurePayload = record(JSON.parse(text(status)));
      expect(typeof failurePayload.code).toBe("string");
      expect(typeof failurePayload.message).toBe("string");

      expect(serverStderr).toBe("");
      await client.close();
      client = undefined;

      // Fail-closed startup, exercised against the same built entry.
      const refusals: Array<[NodeJS.ProcessEnv, string]> = [
        [{ HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath, HERDR_WORKSPACE_ID: workspaceId, HERDR_TAB_ID: rootPane.tab_id, HERDR_PANE_ID: rootPane.pane_id, HERDR_PROJECT_DIR: join(cwd, "missing") }, "PROJECT_DIR"],
        [{ HERDR_SOCKET_PATH: socketPath, HERDR_WORKSPACE_ID: workspaceId, HERDR_TAB_ID: rootPane.tab_id, HERDR_PANE_ID: rootPane.pane_id, HERDR_PROJECT_DIR: cwd }, "HERDR_ENV"],
        [{ HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath, HERDR_PROJECT_DIR: cwd }, "INJECTED_CONTEXT"]
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
      if (workspaceId) {
        await runNamed(["workspace", "close", workspaceId]).catch((error: unknown) => process.stderr.write(`INTEGRATION_TEARDOWN_FAILURE ${String(error)}\n`));
      }
      if (sessionStarted) await run("session", "stop", REQUIRED_SESSION, "--json").catch((error: unknown) => process.stderr.write(`INTEGRATION_SESSION_STOP_FAILURE ${String(error)}\n`));
      await stopDisposableServer(server);
      if (sessionStarted) await run("session", "delete", REQUIRED_SESSION, "--json").catch((error: unknown) => process.stderr.write(`INTEGRATION_SESSION_DELETE_FAILURE ${String(error)}\n`));
      await rm(cwd, { recursive: true, force: true });
    }
  }, 240_000);
});
