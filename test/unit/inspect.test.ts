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

function makeCli(readOutput?: string) {
  const calls: string[][] = [];
  const lines = Array.from({ length: 137 }, (_, i) => `line-${i + 1}`);
  const output = readOutput ?? lines.join("\n");
  const exec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
    calls.push(argv);
    if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { snapshot, type: "session_snapshot" } }), stderr: "", code: 0, killed: false };
    if (argv[0] === "pane" && argv[1] === "get") return { stdout: JSON.stringify({ id: "get", result: { pane: snapshot.panes[0], type: "pane_info" } }), stderr: "", code: 0, killed: false };
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
    expect(calls).toContainEqual(["pane", "read", "--source", "recent-unwrapped", "--lines", "100", "--format", "text", "w1:p1"]);
  });

  it("returns compact collections without reading transcripts", async () => {
    const { cli, calls } = makeCli();
    const result = await execute(cli, { mode: "collection", collection: "panes" });
    expect(result.details).toMatchObject({ kind: "collection", collection: "panes" });
    expect(result.details.items).toEqual([{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "caller", agent_status: "idle", agent_name: "caller" }]);
    expect(calls.some((call) => call[1] === "read")).toBe(false);
  });

  it("reports health without exposing the socket path", async () => {
    const exec = vi.fn<PiExec>().mockResolvedValue({
      stdout: JSON.stringify({ client: { version: "0.8.0", protocol: 19 }, server: { status: "running", version: "0.8.0", protocol: 19 }, compatible: true, socket: "/secret/socket" }),
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
    for (const stdout of ["not-json", "null", JSON.stringify({ client: {}, server: {} }), JSON.stringify({ client: { version: "0.8.0", protocol: 19 }, server: { status: "stopped", version: "0.8.0", protocol: 19 }, compatible: false })]) {
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
    expect(empty?.render(80)).toEqual(["inspected"]);
  });
});
