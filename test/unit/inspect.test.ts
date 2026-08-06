import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { HerdrCli, type PiExec } from "../../src/cli.js";
import { createInspectTool } from "../../src/tools/inspect.js";
import type { HerdrSnapshot } from "../../src/targets.js";

const snapshot: HerdrSnapshot = {
  version: "0.8.0",
  protocol: 19,
  workspaces: [{ workspace_id: "w1", label: "workspace", focused: true }],
  tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main", focused: true }],
  panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "caller", agent_status: "idle", agent_name: "caller" }],
  agents: [{ pane_id: "w1:p1", name: "caller", agent_status: "idle" }]
};

function makeCli(readOutput?: string, snapshotValue: HerdrSnapshot = snapshot) {
  const calls: string[][] = [];
  const lines = Array.from({ length: 137 }, (_, i) => `line-${i + 1}`);
  const output = readOutput ?? lines.join("\n");
  const exec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
    calls.push(argv);
    if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { snapshot: snapshotValue, type: "session_snapshot" } }), stderr: "", code: 0, killed: false };
    if (argv[0] === "pane" && argv[1] === "get") {
      const pane = snapshotValue.panes.find((item) => item.pane_id === argv[2]) ?? snapshotValue.panes[0];
      return { stdout: JSON.stringify({ id: "get", result: { pane, type: "pane_info" } }), stderr: "", code: 0, killed: false };
    }
    if (argv[0] === "pane" && argv[1] === "read") return { stdout: output, stderr: "", code: 0, killed: false };
    throw new Error(`unexpected argv ${argv.join(" ")}`);
  });
  return { cli: new HerdrCli(exec), calls };
}

const context = { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" };
const extensionContext = {} as ExtensionContext;

function execute(cli: HerdrCli, params: Record<string, unknown>) {
  return createInspectTool({ cli, context }).execute("id", params as never, new AbortController().signal, undefined, extensionContext);
}

describe("herdr_inspect", () => {
  it("returns the default current target with exactly the recent-unwrapped tail of 100 lines", async () => {
    const { cli, calls } = makeCli();
    const result = await execute(cli, {});
    expect(result.details).toMatchObject({ kind: "target", target: { paneId: "w1:p1" } });
    expect(result.details.recentUnwrappedLines).toEqual(Array.from({ length: 100 }, (_, i) => `line-${i + 38}`));
    expect(calls).toContainEqual(["pane", "read", "w1:p1", "--source", "recent-unwrapped", "--lines", "100", "--format", "text"]);
  });

  it("returns compact collections without reading transcripts", async () => {
    const { cli, calls } = makeCli();
    const result = await execute(cli, { mode: "collection", collection: "panes" });
    expect(result.details).toMatchObject({ kind: "collection", collection: "panes" });
    expect(result.details.items).toEqual([{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "caller", agent_status: "idle", agent_name: "caller" }]);
    expect(calls.some((call) => call[1] === "read")).toBe(false);
  });

  it("scopes collections to the current workspace/tab and strips non-compact fields", async () => {
    const scopedSnapshot: HerdrSnapshot = {
      ...snapshot,
      workspaces: [...snapshot.workspaces, { workspace_id: "w2", label: "other workspace", secret: "workspace-secret" }],
      tabs: [
        { ...snapshot.tabs[0], secret: "tab-secret" },
        { tab_id: "w1:t2", workspace_id: "w1", label: "other tab", focused: false },
        { tab_id: "w2:t1", workspace_id: "w2", label: "other workspace tab" }
      ],
      panes: [
        { ...snapshot.panes[0], environment: { SECRET: "pane-secret" }, cwd: "/secret" },
        { pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", label: "other tab pane", agent_name: "other-tab", agent_status: "idle", secret: "other-pane-secret" },
        { pane_id: "w2:p1", tab_id: "w2:t1", workspace_id: "w2", label: "other workspace pane", agent_name: "other-workspace", agent_status: "idle" }
      ],
      agents: [
        { ...snapshot.agents[0], agent_id: "agent-1", environment: { SECRET: "agent-secret" } },
        { pane_id: "w1:p2", name: "other-tab", agent_status: "idle" },
        { pane_id: "w2:p1", name: "other-workspace", agent_status: "idle" }
      ]
    };
    const { cli } = makeCli(undefined, scopedSnapshot);
    await expect(execute(cli, { mode: "collection", collection: "panes" })).resolves.toMatchObject({ details: { items: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "caller", agent_status: "idle", agent_name: "caller" }] } });
    await expect(execute(cli, { mode: "collection", collection: "agents" })).resolves.toMatchObject({ details: { items: [{ agent_id: "agent-1", pane_id: "w1:p1", name: "caller", agent_status: "idle" }] } });
    await expect(execute(cli, { mode: "collection", collection: "tabs" })).resolves.toMatchObject({ details: { items: [
      { tab_id: "w1:t1", workspace_id: "w1", label: "main" },
      { tab_id: "w1:t2", workspace_id: "w1", label: "other tab" }
    ] } });
    const results = await Promise.all([
      execute(cli, { mode: "collection", collection: "panes" }),
      execute(cli, { mode: "collection", collection: "agents" }),
      execute(cli, { mode: "collection", collection: "tabs" })
    ]);
    expect(JSON.stringify(results)).not.toContain("secret");
    expect(JSON.stringify(results)).not.toContain("focused");
  });

  it("resolves an exact agent name when its pane label differs and rejects unavailable collection context", async () => {
    const agentSnapshot: HerdrSnapshot = {
      ...snapshot,
      panes: [{ ...snapshot.panes[0], agent_name: "worker" }],
      agents: [{ ...snapshot.agents[0], name: "worker" }]
    };
    const { cli } = makeCli(undefined, agentSnapshot);
    await expect(execute(cli, { mode: "target", target: "worker" })).resolves.toMatchObject({ details: { target: { paneId: "w1:p1", agentName: "worker" } } });
    await expect(execute(cli, { mode: "target", target: "w1:t1" })).rejects.toMatchObject({ code: "TARGET_TYPE_MISMATCH" });
    const invalidContext = createInspectTool({ cli, context: { workspaceId: "w1", tabId: "w1:t1" } });
    await expect(invalidContext.execute("id", { mode: "collection", collection: "panes" } as never, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "CONTEXT_UNAVAILABLE" });
  });

  it("prioritizes an exact agent ID over a conflicting pane label", async () => {
    const agentSnapshot: HerdrSnapshot = {
      ...snapshot,
      panes: [
        { ...snapshot.panes[0], label: "agent-7" },
        { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", label: "other", agent_name: "worker", agent_status: "idle" }
      ],
      agents: [snapshot.agents[0], { pane_id: "w1:p2", agent_id: "agent-7", name: "worker", agent_status: "idle" }]
    };
    const { cli, calls } = makeCli(undefined, agentSnapshot);
    await expect(execute(cli, { mode: "target", target: "agent-7" })).resolves.toMatchObject({ details: { target: { paneId: "w1:p2", agentName: "worker" } } });
    expect(calls).toContainEqual(["pane", "read", "w1:p2", "--source", "recent-unwrapped", "--lines", "100", "--format", "text"]);
  });

  it("reports health without exposing the socket path", async () => {
    const exec = vi.fn<PiExec>().mockResolvedValue({
      stdout: JSON.stringify({ client: { version: "0.8.0", protocol: 19 }, server: { status: "running", version: "0.8.0", protocol: 19, compatible: true, socket: "/secret/socket" } }),
      stderr: "",
      code: 0,
      killed: false
    });
    const result = await execute(new HerdrCli(exec), { mode: "health" });
    expect(result.details).toMatchObject({ kind: "health", client: { version: "0.8.0", protocol: 19 }, server: { status: "running", version: "0.8.0", protocol: 19 }, compatible: true, socketReachable: true });
    expect(JSON.stringify(result.details)).not.toContain("/secret/socket");
  });

  it("reads explicit target mode and every compact collection", async () => {
    const { cli } = makeCli();
    await expect(execute(cli, { mode: "target", target: "caller" })).resolves.toMatchObject({ details: { kind: "target", target: { paneId: "w1:p1" } } });
    await expect(execute(cli, { mode: "collection", collection: "agents" })).resolves.toMatchObject({ details: { kind: "collection", collection: "agents" } });
    await expect(execute(cli, { mode: "collection", collection: "tabs" })).resolves.toMatchObject({ details: { kind: "collection", collection: "tabs" } });
  });

  it("keeps invalid mode combinations before the CLI", async () => {
    const { cli, calls } = makeCli();
    await expect(execute(cli, { mode: "target" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(execute(cli, { mode: "collection" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(execute(cli, { mode: "collection", collection: "panes", target: "current" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(execute(cli, { mode: "context", collection: "panes" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(execute(cli, { mode: "context", target: "caller" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(execute(cli, { mode: "health", target: "current" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(calls).toHaveLength(0);
  });

  it("handles empty recent output and malformed pane reads fail closed", async () => {
    const { cli } = makeCli("");
    await expect(execute(cli, {})).resolves.toMatchObject({ details: { recentUnwrappedLines: [] } });

    const exec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { snapshot, type: "session_snapshot" } }), stderr: "", code: 0, killed: false };
      return { stdout: JSON.stringify({ id: "pane", result: { pane: null } }), stderr: "", code: 0, killed: false };
    });
    await expect(execute(new HerdrCli(exec), {})).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
  });

  it("rejects malformed health output and reports an incompatible running state", async () => {
    for (const stdout of ["not-json", "null", JSON.stringify({ client: {}, server: {} }), JSON.stringify({ client: { version: "0.8.0", protocol: 19 }, server: { status: "stopped", version: "0.8.0", protocol: 19, compatible: false } })]) {
      const exec = vi.fn<PiExec>().mockResolvedValue({ stdout, stderr: "", code: 0, killed: false });
      if (stdout.includes('"compatible":false')) {
        await expect(execute(new HerdrCli(exec), { mode: "health" })).resolves.toMatchObject({ details: { socketReachable: false, compatible: false } });
      } else {
        await expect(execute(new HerdrCli(exec), { mode: "health" })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
      }
    }
  });

  it("renders compact inspect call and result rows", () => {
    const tool = createInspectTool({ cli: makeCli().cli, context });
    const call = tool.renderCall?.({ mode: "target", target: "caller" } as never, {} as never, {} as never);
    expect(call?.render(80)).toEqual(["herdr_inspect · target · caller"]);
    call?.invalidate();
    const defaultCall = tool.renderCall?.({} as never, {} as never, {} as never);
    expect(defaultCall?.render(80)).toEqual(["herdr_inspect · context"]);
    defaultCall?.invalidate();
    const result = tool.renderResult?.({ content: [], details: { operation: "inspect", kind: "target", outcome: "success", target: { paneId: "w1:p1" } }, isError: false } as never, {} as never, {} as never, {} as never);
    expect(result?.render(80)).toEqual(["inspected · w1:p1"]);
    result?.invalidate();
    const empty = tool.renderResult?.({ content: [], isError: true } as never, {} as never, {} as never, {} as never);
    expect(empty?.render(80)).toEqual(["error UNKNOWN"]);
  });
});
