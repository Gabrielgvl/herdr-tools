import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { DaemonClient } from "../../src/daemon/client.js";
import { DaemonRunParamsSchema, DaemonStatusParamsSchema } from "../../src/daemon/client.js";
import { DaemonLaunchRequestSchema } from "../../src/launch-schema.js";
import { CORE_TOOL_NAMES, createPreflight, createToolSurface, readInjectedContext, type HerdrToolSurfaceDependencies } from "../../src/tool-surface.js";
import { TOOL_DIAGNOSTIC_MARKER } from "../../src/telemetry.js";

const health = { client: { version: "0.8.0", protocol: 22 }, server: { status: "running", version: "0.8.0", protocol: 22, compatible: true } };
const context = { workspaceId: "w", tabId: "w:t", paneId: "w:p" };

/**
 * A scripted `DaemonClient`: records each typed call, returns the canned
 * reply, and counts closes so a leaked connection fails the test.
 */
function fakeDaemon(replies: { launch?: unknown; run?: unknown; status?: unknown } = {}) {
  const calls: Array<{ method: string; params: unknown }> = [];
  let closed = 0;
  const client = {
    launch: async (params: unknown) => { calls.push({ method: "launch", params }); return replies.launch; },
    run: async (params: unknown) => { calls.push({ method: "run", params }); return replies.run; },
    status: async (params: unknown) => { calls.push({ method: "status", params }); return replies.status; },
    close: () => { closed += 1; },
  };
  return { client: client as unknown as DaemonClient, calls, closed: () => closed };
}

function surfaceFor(overrides: Partial<HerdrToolSurfaceDependencies> = {}, replies: Parameters<typeof fakeDaemon>[0] = {}) {
  const daemon = fakeDaemon(replies);
  let connects = 0;
  const deps: HerdrToolSurfaceDependencies = {
    connectDaemon: async () => { connects += 1; return daemon.client; },
    cwd: "/project",
    ...overrides
  };
  return { surface: createToolSurface(deps), daemon, connects: () => connects, deps };
}

const extensionContext = { cwd: "/unused-host-cwd", signal: new AbortController().signal, modelRegistry: { find: () => undefined, getAll: () => [] } } as unknown as ExtensionContext;

describe("shared tool surface", () => {
  it("constructs exactly the three core tools in order with one identity per tool", () => {
    const { surface } = surfaceFor();
    expect(surface.definitions.map((definition) => definition.name)).toEqual([...CORE_TOOL_NAMES]);
    expect(surface.definitions).toHaveLength(3);
    expect(surface.definitions[0]).toBe(surface.launch);
    expect(surface.definitions[1]).toBe(surface.run);
    expect(surface.definitions[2]).toBe(surface.status);
  });

  it("publishes the daemon wire schemas as each tool's parameters", () => {
    const { surface } = surfaceFor();
    expect(surface.launch.parameters).toBe(DaemonLaunchRequestSchema);
    expect(surface.run.parameters).toBe(DaemonRunParamsSchema);
    expect(surface.status.parameters).toBe(DaemonStatusParamsSchema);
  });

  it("rejects malformed input before any daemon connection opens", async () => {
    const { surface, connects, daemon } = surfaceFor();
    const failure = await surface.status.execute("id", { eventId: 7 } as never, new AbortController().signal, undefined, extensionContext).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "INVALID_INPUT", diagnostic: { tool: "herdr_status", phase: "validate", effectCertainty: "absent" } });
    expect((failure as Error).message).toContain(TOOL_DIAGNOSTIC_MARKER);
    expect(connects()).toBe(0);
    expect(daemon.calls).toEqual([]);
  });

  it("proxies each tool to its daemon call, publishes the reply as text and details, and closes the client", async () => {
    const replies = {
      launch: { kind: "launch", launchId: "l-1", state: "completed" },
      run: { kind: "run", action: "ack", eventId: "evt-1", result: "acked" },
      status: { kind: "status", daemon: { status: "running" } },
    };
    const { surface, daemon, connects } = surfaceFor({}, replies);
    const signal = new AbortController().signal;

    const launchArgs = { task: { objective: "o", scope: "s", doneWhen: ["done"] }, idempotencyKey: "idem-1" };
    const launched = await surface.launch.execute("id", launchArgs, signal, undefined, extensionContext);
    expect(daemon.calls.at(-1)).toEqual({ method: "launch", params: launchArgs });
    expect(launched.details).toEqual(replies.launch);
    expect(JSON.parse((launched.content[0] as { text: string }).text)).toEqual(replies.launch);

    const runArgs = { action: "ack", eventId: "evt-1" };
    const ran = await surface.run.execute("id", runArgs, signal, undefined, extensionContext);
    expect(daemon.calls.at(-1)).toEqual({ method: "run", params: runArgs });
    expect(ran.details).toEqual(replies.run);

    const statusArgs = { eventId: "evt-1" };
    const status = await surface.status.execute("id", statusArgs, signal, undefined, extensionContext);
    expect(daemon.calls.at(-1)).toEqual({ method: "status", params: statusArgs });
    expect(status.details).toEqual(replies.status);

    // Three calls, three fresh connections, every one closed.
    expect(connects()).toBe(3);
    expect(daemon.closed()).toBe(3);
  });

  it("propagates the daemon's typed failure and still closes the client", async () => {
    const refused = Object.assign(new Error("daemon refused"), { code: "INTENT_NOT_FOUND" });
    const daemon = fakeDaemon();
    daemon.client.run = async () => { throw refused; };
    let connects = 0;
    const surface = createToolSurface({ connectDaemon: async () => { connects += 1; return daemon.client; }, cwd: "/project" });
    await expect(surface.run.execute("id", { action: "observe", runId: "r-1" }, new AbortController().signal, undefined, extensionContext)).rejects.toBe(refused);
    expect(connects).toBe(1);
    expect(daemon.closed()).toBe(1);
  });

  it("keeps the shared per-call compatibility preflight and injected context reader", async () => {
    const preflight = createPreflight({ runText: async () => JSON.stringify(health) });
    await expect(preflight(new AbortController().signal)).resolves.toBeUndefined();
    const incompatible = createPreflight({ runText: async () => JSON.stringify({ ...health, server: { ...health.server, compatible: false } }) });
    await expect(incompatible(new AbortController().signal)).rejects.toMatchObject({ code: "CLI_INCOMPATIBLE" });
    expect(readInjectedContext({ HERDR_WORKSPACE_ID: "w", HERDR_TAB_ID: "w:t", HERDR_PANE_ID: "w:p" })).toEqual({ context, idsPresent: true, idsValid: true });
    expect(readInjectedContext({})).toEqual({ context: {}, idsPresent: false, idsValid: true });
    expect(readInjectedContext({ HERDR_WORKSPACE_ID: "w", HERDR_TAB_ID: "bad\ntab", HERDR_PANE_ID: "w:p" })).toMatchObject({ idsValid: false });
  });
});
