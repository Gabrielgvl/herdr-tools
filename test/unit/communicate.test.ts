import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HerdrCli, type PiExec } from "../../src/cli.js";
import { createCommunicateTool } from "../../src/tools/communicate.js";
import type { HerdrSnapshot } from "../../src/targets.js";

const pane = { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", label: "reviewer", agent_status: "idle", agent_name: "reviewer" };
const snapshot: HerdrSnapshot = {
  version: "0.8.0", protocol: 19,
  workspaces: [{ workspace_id: "w1", label: "workspace", focused: true }],
  tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main", focused: true }],
  panes: [pane], agents: [{ pane_id: "w1:p2", name: "reviewer", agent_status: "idle" }]
};
const context = { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p2" };
const extensionContext = {} as ExtensionContext;

function makeCli(initial: "idle" | "working" = "idle") {
  const calls: string[][] = [];
  let state = initial;
  const exec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
    calls.push(argv);
    if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { snapshot: { ...snapshot, panes: [{ ...pane, agent_status: state }], agents: [{ pane_id: "w1:p2", name: "reviewer", agent_status: state }] }, type: "session_snapshot" } }), stderr: "", code: 0, killed: false };
    if (argv[0] === "pane" && argv[1] === "get") return { stdout: JSON.stringify({ id: "get", result: { pane: { ...pane, agent_status: state }, type: "pane_info" } }), stderr: "", code: 0, killed: false };
    if (argv[0] === "agent" && argv[1] === "send-keys") { state = "working"; return { stdout: JSON.stringify({ id: "keys", result: { ok: true } }), stderr: "", code: 0, killed: false }; }
    if (argv[0] === "agent" && argv[1] === "prompt") { state = "working"; return { stdout: JSON.stringify({ id: "prompt", result: { ok: true } }), stderr: "", code: 0, killed: false }; }
    throw new Error(`unexpected argv ${argv.join(" ")}`);
  });
  return { cli: new HerdrCli(exec), calls };
}

describe("herdr_communicate", () => {
  it("refuses a normal prompt while the target is working without mutation", async () => {
    const { cli, calls } = makeCli("working");
    await expect(createCommunicateTool({ cli, context }).execute("id", { target: "reviewer", operation: "prompt", text: "hello" }, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "TARGET_BUSY" });
    expect(calls.some((call) => call[0] === "agent" && (call[1] === "prompt" || call[1] === "send-keys"))).toBe(false);
  });

  it("sends a normal prompt with bounded working verification", async () => {
    const { cli, calls } = makeCli();
    await expect(createCommunicateTool({ cli, context }).execute("id", { target: "reviewer", operation: "prompt", text: "hello" }, new AbortController().signal, undefined, extensionContext)).resolves.toMatchObject({ details: { operation: "prompt", outcome: "sent", postState: { agent_status: "working" } } });
    expect(calls).toContainEqual(["agent", "prompt", "w1:p2", "hello", "--wait", "--until", "working", "--timeout", "5000"]);
  });

  it("steers with named Escape before the prompt and verifies working", async () => {
    const { cli, calls } = makeCli();
    const result = await createCommunicateTool({ cli, context }).execute("id", { target: "reviewer", operation: "steer", text: "new direction" }, new AbortController().signal, undefined, extensionContext);
    expect(calls).toEqual([
      ["api", "snapshot"],
      ["pane", "get", "w1:p2"],
      ["agent", "send-keys", "w1:p2", "esc"],
      ["agent", "prompt", "w1:p2", "new direction", "--wait", "--until", "working", "--timeout", "5000"],
      ["pane", "get", "w1:p2"]
    ]);
    expect(result.details).toMatchObject({ operation: "steer", outcome: "sent", target: { paneId: "w1:p2" }, postState: { agent_status: "working" } });
  });

  it("fails closed for malformed pane responses and contradictory post-state", async () => {
    for (const paneResult of [null, {}, { pane: null }]) {
      const exec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
        if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { snapshot, type: "session_snapshot" } }), stderr: "", code: 0, killed: false };
        return { stdout: JSON.stringify({ id: "get", result: paneResult }), stderr: "", code: 0, killed: false };
      });
      await expect(createCommunicateTool({ cli: new HerdrCli(exec), context }).execute("id", { target: "reviewer", operation: "prompt", text: "hello" }, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    }

    const unknownState = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { snapshot, type: "session_snapshot" } }), stderr: "", code: 0, killed: false };
      if (argv[0] === "pane" && argv[1] === "get") {
        return { stdout: JSON.stringify({ id: "get", result: { pane: {} } }), stderr: "", code: 0, killed: false };
      }
      return { stdout: JSON.stringify({ id: "keys", result: { ok: true } }), stderr: "", code: 0, killed: false };
    });
    await expect(createCommunicateTool({ cli: new HerdrCli(unknownState), context }).execute("id", { target: "reviewer", operation: "keys", keys: ["enter"] }, new AbortController().signal, undefined, extensionContext)).resolves.toMatchObject({ details: { outcome: "sent" } });

    let gets = 0;
    const contradictory = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { snapshot, type: "session_snapshot" } }), stderr: "", code: 0, killed: false };
      if (argv[0] === "pane" && argv[1] === "get") {
        gets += 1;
        const state = gets === 1 ? "idle" : "idle";
        return { stdout: JSON.stringify({ id: "get", result: { pane: { ...pane, agent_status: state } } }), stderr: "", code: 0, killed: false };
      }
      return { stdout: JSON.stringify({ id: "prompt", result: { ok: true } }), stderr: "", code: 0, killed: false };
    });
    await expect(createCommunicateTool({ cli: new HerdrCli(contradictory), context }).execute("id", { target: "reviewer", operation: "prompt", text: "hello" }, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "POSTSTATE_UNAVAILABLE" });
  });

  it("validates keys before CLI and never asks for confirmation", async () => {
    const { cli, calls } = makeCli();
    await expect(createCommunicateTool({ cli, context }).execute("id", { target: "reviewer", operation: "keys", keys: ["enter", "ctrl+c"] }, new AbortController().signal, undefined, extensionContext)).resolves.toMatchObject({ details: { outcome: "sent" } });
    expect(calls).toContainEqual(["agent", "send-keys", "w1:p2", "enter", "ctrl+c"]);

    const before = calls.length;
    await expect(createCommunicateTool({ cli, context }).execute("id", { target: "reviewer", operation: "keys", keys: ["\\u001b" as never] }, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "KEY_REJECTED" });
    expect(calls).toHaveLength(before);
  });

  it("renders compact call and result rows", () => {
    const tool = createCommunicateTool({ cli: makeCli().cli, context });
    const call = tool.renderCall?.({ target: "reviewer", operation: "prompt", text: "hi" } as never, {} as never, {} as never);
    expect(call?.render(80)).toEqual(["herdr_communicate · prompt · reviewer"]);
    call?.invalidate();
    const result = tool.renderResult?.({ content: [], details: { operation: "prompt", outcome: "sent", target: { paneId: "w1:p2" }, postState: { agent_status: "working" } }, isError: false } as never, {} as never, {} as never, {} as never);
    expect(result?.render(80)).toEqual(["sent · w1:p2 · working"]);
    result?.invalidate();
    const empty = tool.renderResult?.({ content: [], isError: true } as never, {} as never, {} as never, {} as never);
    expect(empty?.render(80)).toEqual(["sent"]);
  });
});
