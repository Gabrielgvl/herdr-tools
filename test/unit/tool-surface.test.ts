import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { HerdrCli, type PiExec } from "../../src/cli.js";
import { JobRegistry } from "../../src/job-registry.js";
import { LaunchParamsSchema } from "../../src/launch-schema.js";
import { RuntimeOwnership } from "../../src/ownership.js";
import { CommunicateParamsSchema, InspectParamsSchema } from "../../src/schemas.js";
import { JobsParamsSchema } from "../../src/jobs-schema.js";
import { PaneParamsSchema, TabParamsSchema } from "../../src/topology-schema.js";
import { WaitParamsSchema } from "../../src/wait-schema.js";
import { CORE_TOOL_NAMES, createPreflight, createToolSurface, readInjectedContext, type HerdrToolSurfaceDependencies } from "../../src/tool-surface.js";
import { createInspectTool } from "../../src/tools/inspect.js";
import { createCommunicateTool } from "../../src/tools/communicate.js";
import { createJobsTool } from "../../src/tools/jobs.js";
import { createLaunchTool } from "../../src/tools/launch.js";
import { createPaneTool } from "../../src/tools/pane.js";
import { createTabTool } from "../../src/tools/tab.js";
import { createWaitTool } from "../../src/tools/wait.js";
import { stubSupervision } from "./supervision-fixtures.js";

const snapshot = {
  type: "session_snapshot",
  snapshot: {
    version: "1",
    protocol: 1,
    workspaces: [{ workspace_id: "w", label: "w" }],
    tabs: [{ tab_id: "w:t", workspace_id: "w", label: "t" }],
    panes: [
      { pane_id: "w:p", tab_id: "w:t", workspace_id: "w", label: "caller", agent_name: "caller", agent: "pi", terminal_id: "term-caller", agent_session: { source: "pi", agent: "pi", kind: "id", value: "caller-session" }, agent_status: "idle" },
      { pane_id: "w:p2", tab_id: "w:t", workspace_id: "w", label: "worker", agent_name: "worker", agent: "pi", terminal_id: "term-worker", agent_session: { source: "pi", agent: "pi", kind: "id", value: "worker-session" }, agent_status: "working" }
    ],
    agents: [
      { pane_id: "w:p", name: "caller", agent: "pi", terminal_id: "term-caller", agent_session: { source: "pi", agent: "pi", kind: "id", value: "caller-session" }, agent_status: "idle" },
      { pane_id: "w:p2", name: "worker", agent: "pi", terminal_id: "term-worker", agent_session: { source: "pi", agent: "pi", kind: "id", value: "worker-session" }, agent_status: "working" }
    ]
  }
};

const health = { client: { version: "0.8.0", protocol: 20 }, server: { status: "running", version: "0.8.0", protocol: 20, compatible: true } };
const context = { workspaceId: "w", tabId: "w:t", paneId: "w:p" };
const settings = { reviewCadenceMinutes: 1, reviewerModel: "luna", reviewerThinking: "low" as const };

function fakeExec(): { exec: PiExec; calls: string[][] } {
  const calls: string[][] = [];
  const envelope = (id: string, result: unknown) => ({ stdout: JSON.stringify({ id, result }), stderr: "", code: 0, killed: false });
  const exec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
    calls.push(argv);
    if (argv[0] === "status") return { stdout: JSON.stringify(health), stderr: "", code: 0, killed: false };
    if (argv[0] === "pane" && argv[1] === "current") return envelope("current", { type: "pane_current", pane: snapshot.snapshot.panes[0] });
    if (argv[0] === "api") return envelope("snapshot", snapshot);
    if (argv[0] === "agent" && argv[1] === "wait") return envelope("agent-wait", { agent: snapshot.snapshot.panes.find((item) => item.pane_id === argv[2]) });
    if (argv[0] === "agent" && argv[1] === "get") return envelope("agent-get", { agent: snapshot.snapshot.panes.find((item) => item.pane_id === argv[2]) });
    if (argv[0] === "pane" && argv[1] === "get") {
      const pane = snapshot.snapshot.panes.find((item) => item.pane_id === argv[2]) ?? { pane_id: argv[2], tab_id: "w:t", workspace_id: "w", label: "created", agent_status: "idle" };
      return envelope("pane", { pane });
    }
    if (argv[0] === "pane" && argv[1] === "read") return { stdout: "worker output", stderr: "", code: 0, killed: false };
    if (argv[0] === "pane" && argv[1] === "split") return envelope("split", { pane: { pane_id: "w:p3" } });
    if (argv[0] === "pane" && argv[1] === "rename") return envelope("rename", { ok: true });
    return envelope("other", { ok: true });
  });
  return { exec, calls };
}

function surfaceFor(overrides: Partial<HerdrToolSurfaceDependencies> = {}) {
  const { exec, calls } = fakeExec();
  const cli = new HerdrCli(exec);
  const deps: HerdrToolSurfaceDependencies = {
    cli,
    context,
    environment: { enabled: true, currentIdsPresent: true, currentIdsValid: true },
    preflight: createPreflight(cli),
    settingsLoader: async () => settings,
    jobs: new JobRegistry(),
    profiles: { load: async () => { throw new Error("profiles must not load in this test"); } },
    ownership: new RuntimeOwnership(),
    supervision: stubSupervision(),
    cwd: "/project",
    ...overrides
  };
  return { surface: createToolSurface(deps), calls, deps };
}

const extensionContext = { cwd: "/unused-host-cwd", signal: new AbortController().signal, modelRegistry: { find: () => undefined, getAll: () => [] } } as unknown as ExtensionContext;

describe("shared tool surface", () => {
  it("constructs exactly the seven core tools in order with one identity per tool", () => {
    const { surface } = surfaceFor();
    expect(surface.definitions.map((definition) => definition.name)).toEqual([...CORE_TOOL_NAMES]);
    expect(surface.definitions).toHaveLength(7);
    expect(surface.definitions[0]).toBe(surface.inspect);
    expect(surface.definitions[1]).toBe(surface.communicate);
    expect(surface.definitions[2]).toBe(surface.wait);
    expect(surface.definitions[3]).toBe(surface.jobs);
    expect(surface.definitions[4]).toBe(surface.launch);
    expect(surface.definitions[5]).toBe(surface.pane);
    expect(surface.definitions[6]).toBe(surface.tab);
  });

  it("publishes the same schemas, labels, and descriptions the Pi host registers", () => {
    const { surface, deps } = surfaceFor();
    expect(surface.definitions.map((definition) => definition.parameters)).toEqual([
      InspectParamsSchema,
      CommunicateParamsSchema,
      WaitParamsSchema,
      JobsParamsSchema,
      LaunchParamsSchema,
      PaneParamsSchema,
      TabParamsSchema
    ]);
    const direct = [
      createInspectTool({ cli: deps.cli, context, environment: deps.environment, profiles: deps.profiles }),
      createCommunicateTool({ cli: deps.cli, context, preflight: deps.preflight }),
      createWaitTool({ cli: deps.cli, context, settingsLoader: deps.settingsLoader, jobRegistry: deps.jobs }),
      createJobsTool(deps.jobs),
      createLaunchTool({ cli: deps.cli, context, cwd: deps.cwd, ownership: deps.ownership, profiles: deps.profiles, preflight: deps.preflight, supervision: deps.supervision }),
      createPaneTool({ cli: deps.cli, context, cwd: deps.cwd, ownership: deps.ownership, preflight: deps.preflight }),
      createTabTool({ cli: deps.cli, context, cwd: deps.cwd, ownership: deps.ownership, preflight: deps.preflight })
    ];
    expect(surface.definitions.map((definition) => ({ name: definition.name, label: definition.label, description: definition.description })))
      .toEqual(direct.map((definition) => ({ name: definition.name, label: definition.label, description: definition.description })));
    expect(surface.definitions.filter((definition) => "executionMode" in definition).map((definition) => definition.name)).toEqual(["herdr_communicate", "herdr_pane", "herdr_tab"]);
  });

  it("threads the host working directory into topology mutations", async () => {
    const { surface, calls } = surfaceFor({ cwd: "/host/project" });
    await surface.pane.execute("id", { operation: "split", target: "w:p", label: "worker" } as never, new AbortController().signal, undefined, extensionContext);
    const split = calls.find((call) => call[0] === "pane" && call[1] === "split");
    expect(split).toContain("--cwd");
    expect(split?.[split.indexOf("--cwd") + 1]).toBe("/host/project");
  });

  it("forwards an injected reviewer factory and otherwise keeps the Pi model reviewer", async () => {
    const reviewerFactory = vi.fn(() => { throw Object.assign(new Error("no reviewer"), { code: "REVIEWER_FAILED" }); });
    const longWait = { targets: ["w:p2"], match: "any" as const, condition: { kind: "state" as const, state: "blocked" as const }, timeoutMs: 120_000 };
    const injected = surfaceFor({ reviewerFactory });
    const injectedStarted = await injected.surface.wait.execute("id", longWait as never, new AbortController().signal, undefined, extensionContext);
    expect(injectedStarted.details).toMatchObject({ operation_phase: "accepted" });
    await vi.waitFor(() => expect(injected.deps.jobs.list("settled").total).toBe(1));
    expect(reviewerFactory).toHaveBeenCalledTimes(1);
    const piHost = surfaceFor();
    const piStarted = await piHost.surface.wait.execute("id", longWait as never, new AbortController().signal, undefined, extensionContext);
    expect(piStarted.details).toMatchObject({ operation_phase: "accepted" });
    await vi.waitFor(() => expect(piHost.deps.jobs.list("settled").total).toBe(1));
  });

  it("keeps the shared per-call compatibility preflight and injected context reader", async () => {
    const { deps } = surfaceFor();
    await expect(deps.preflight(new AbortController().signal)).resolves.toBeUndefined();
    const incompatible = createPreflight({ runText: async () => JSON.stringify({ ...health, server: { ...health.server, compatible: false } }) });
    await expect(incompatible(new AbortController().signal)).rejects.toMatchObject({ code: "CLI_INCOMPATIBLE" });
    expect(readInjectedContext({ HERDR_WORKSPACE_ID: "w", HERDR_TAB_ID: "w:t", HERDR_PANE_ID: "w:p" })).toEqual({ context, idsPresent: true, idsValid: true });
    expect(readInjectedContext({})).toEqual({ context: {}, idsPresent: false, idsValid: true });
    expect(readInjectedContext({ HERDR_WORKSPACE_ID: "w", HERDR_TAB_ID: "bad\ntab", HERDR_PANE_ID: "w:p" })).toMatchObject({ idsValid: false });
  });
});
