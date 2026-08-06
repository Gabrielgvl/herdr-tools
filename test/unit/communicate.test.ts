import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HerdrCli, type PiExec } from "../../src/cli.js";
import { createCommunicateTool } from "../../src/tools/communicate.js";
import type { HerdrSnapshot } from "../../src/targets.js";

const pane = { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", label: "reviewer", agent_id: "agent-7", agent_status: "idle", agent_name: "reviewer" };
const snapshot: HerdrSnapshot = {
  version: "0.8.0", protocol: 19,
  workspaces: [{ workspace_id: "w1", label: "workspace", focused: true }],
  tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main", focused: true }],
  panes: [pane], agents: [{ pane_id: "w1:p2", agent_id: "agent-7", name: "reviewer", agent_status: "idle" }]
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

  it("resolves an authoritative agent ID to the pane used by communication", async () => {
    const { cli, calls } = makeCli();
    await expect(createCommunicateTool({ cli, context }).execute("id", { target: "agent-7", operation: "keys", keys: ["enter"] }, new AbortController().signal, undefined, extensionContext)).resolves.toMatchObject({ details: { target: { paneId: "w1:p2" } } });
    expect(calls).toContainEqual(["agent", "send-keys", "w1:p2", "enter"]);
  });

  it("rejects pane get identity mismatches before and after mutation", async () => {
    const beforeExec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { snapshot, type: "session_snapshot" } }), stderr: "", code: 0, killed: false };
      if (argv[0] === "pane" && argv[1] === "get") return { stdout: JSON.stringify({ id: "get", result: { pane: { ...pane, pane_id: "w1:wrong", agent_status: "idle" } } }), stderr: "", code: 0, killed: false };
      throw new Error(`mutation should not run: ${argv.join(" ")}`);
    });
    await expect(createCommunicateTool({ cli: new HerdrCli(beforeExec), context }).execute("id", { target: "reviewer", operation: "prompt", text: "hello" }, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR", details: { expectedPaneId: "w1:p2", actualPaneId: "w1:wrong" } });
    expect(beforeExec.mock.calls.some((call) => call[1][0] === "agent")).toBe(false);

    let gets = 0;
    const afterExec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { snapshot, type: "session_snapshot" } }), stderr: "", code: 0, killed: false };
      if (argv[0] === "pane" && argv[1] === "get") {
        gets += 1;
        return { stdout: JSON.stringify({ id: "get", result: { pane: { ...pane, pane_id: gets === 1 ? pane.pane_id : "w1:wrong", agent_status: gets === 1 ? "idle" : "working" } } }), stderr: "", code: 0, killed: false };
      }
      if (argv[0] === "agent" && argv[1] === "prompt") return { stdout: JSON.stringify({ id: "prompt", result: { ok: true } }), stderr: "", code: 0, killed: false };
      throw new Error(`unexpected argv ${argv.join(" ")}`);
    });
    await expect(createCommunicateTool({ cli: new HerdrCli(afterExec), context }).execute("id", { target: "reviewer", operation: "prompt", text: "hello" }, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR", details: { expectedPaneId: "w1:p2", actualPaneId: "w1:wrong" } });
    expect(afterExec.mock.calls.some((call) => call[1][0] === "agent" && call[1][1] === "prompt")).toBe(true);
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
    await expect(createCommunicateTool({ cli: new HerdrCli(unknownState), context }).execute("id", { target: "reviewer", operation: "keys", keys: ["enter"] }, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });

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

  it("requires an authoritative key post-state and strips sensitive metadata", async () => {
    for (const postPane of [
      { ...pane, agent_status: undefined, environment: { SECRET: "missing-state" }, nested: { env_vars: { TOKEN: "nested-secret" } } },
      { ...pane, agent_status: "not-a-state", environment: { SECRET: "invalid-state" } }
    ]) {
      let gets = 0;
      const exec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
        if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { snapshot, type: "session_snapshot" } }), stderr: "", code: 0, killed: false };
        if (argv[0] === "pane" && argv[1] === "get") {
          gets += 1;
          return { stdout: JSON.stringify({ id: "get", result: { pane: gets === 1 ? pane : postPane } }), stderr: "", code: 0, killed: false };
        }
        return { stdout: JSON.stringify({ id: "keys", result: { ok: true } }), stderr: "", code: 0, killed: false };
      });
      await expect(createCommunicateTool({ cli: new HerdrCli(exec), context }).execute("id", { target: "reviewer", operation: "keys", keys: ["enter"] }, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "POSTSTATE_UNAVAILABLE" });
    }

    const sensitive = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { snapshot, type: "session_snapshot" } }), stderr: "", code: 0, killed: false };
      if (argv[0] === "pane" && argv[1] === "get") {
        return { stdout: JSON.stringify({ id: "get", result: { pane: { ...pane, agent_status: "working", environment: { SECRET: "hidden" }, environment_overrides: { SNAKE_SECRET: "snake-hidden" }, nested: { environment_variables: { TOKEN: "nested-hidden" }, environment_overrides: { NESTED_SNAKE_SECRET: "nested-snake-hidden" } }, history: [{ env: { ARRAY_SECRET: "array-hidden" }, environment_overrides: { ARRAY_SNAKE_SECRET: "array-snake-hidden" } }] } } }), stderr: "", code: 0, killed: false };
      }
      return { stdout: JSON.stringify({ id: "keys", result: { ok: true } }), stderr: "", code: 0, killed: false };
    });
    const result = await createCommunicateTool({ cli: new HerdrCli(sensitive), context }).execute("id", { target: "reviewer", operation: "keys", keys: ["enter"] }, new AbortController().signal, undefined, extensionContext);
    expect(result.details.postState).toMatchObject({ pane_id: "w1:p2", agent_status: "working" });
    expect(JSON.stringify(result)).not.toContain("hidden");
    expect(JSON.stringify(result)).not.toContain("TOKEN");
    expect(JSON.stringify(result)).not.toContain("snake-hidden");
    expect(JSON.stringify(result)).not.toContain("environment_overrides");
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
    expect(empty?.render(80)).toEqual(["error UNKNOWN"]);
  });
});
