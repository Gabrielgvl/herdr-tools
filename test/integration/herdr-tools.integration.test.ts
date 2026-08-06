import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const REQUIRED_SESSION = "herdr-tools-integration";
const requestedSession = process.argv.find((value, index) => value === "--session" ? typeof process.argv[index + 1] === "string" : value.startsWith("--session="))?.replace(/^--session[= ]/, "") ?? REQUIRED_SESSION;
const enabled = process.env.HERDR_TOOLS_RUN_INTEGRATION === "1";

describe.skipIf(!enabled)("disposable Herdr integration", () => {
  it("uses only the named disposable session and never the current context", async () => {
    expect(requestedSession).toBe(REQUIRED_SESSION);
    const currentIds = [process.env.HERDR_WORKSPACE_ID, process.env.HERDR_TAB_ID, process.env.HERDR_PANE_ID];
    expect(process.env.HERDR_ENV).toBe("1");
    expect(currentIds.every(Boolean)).toBe(true);

    let workspaceId: string | undefined;
    let fixtureCreated = false;
    let sessionStarted = false;
    let server: ChildProcess | undefined;
    let failure: unknown;
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
      const currentBaseline = JSON.stringify(current);
      const created = await runNamed(["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"]);
      workspaceId = returnedWorkspaceId(created);
      fixtureCreated = true;

      const fixtureSnapshot = resultObject(await runNamed(["api", "snapshot"]));
      const fixtureResult = resultObject(fixtureSnapshot.result);
      const fixture = resultObject(fixtureResult.snapshot);
      expect(JSON.stringify(fixture)).toContain(workspaceId);
      const defaultAfter = resultObject(resultObject(await run("api", "snapshot")).result).snapshot;
      expect(JSON.stringify(defaultAfter)).toBe(currentBaseline);
    } catch (error) {
      failure = error;
      process.stderr.write(`INTEGRATION_FAILURE_RECORDED ${error instanceof Error ? error.message : String(error)}\n`);
      throw error;
    } finally {
      if (failure !== undefined) process.stderr.write("INTEGRATION_FAILURE_RECORDED_BEFORE_TEARDOWN\n");
      if (fixtureCreated && workspaceId && !currentIds.includes(workspaceId)) {
        await runNamed(["workspace", "close", workspaceId]).catch((error) => process.stderr.write(`INTEGRATION_TEARDOWN_FAILURE ${String(error)}\n`));
      }
      if (sessionStarted) {
        await run("session", "stop", REQUIRED_SESSION, "--json").catch((error) => process.stderr.write(`INTEGRATION_SESSION_STOP_FAILURE ${String(error)}\n`));
        await run("session", "delete", REQUIRED_SESSION, "--json").catch((error) => process.stderr.write(`INTEGRATION_SESSION_DELETE_FAILURE ${String(error)}\n`));
      }
      if (server?.exitCode === null) server.kill("SIGTERM");
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
