import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HerdrCli, type PiExec } from "../../src/cli.js";
import { compactPane, createCommunicateTool, paneFrom } from "../../src/tools/communicate.js";
import { CommunicateParamsSchema } from "../../src/schemas.js";
import type { HerdrSnapshot } from "../../src/targets.js";

const basePane = { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", label: "reviewer", agent_id: "agent-7", agent_status: "idle", agent_name: "reviewer" };
const callerPane = { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "caller", agent_status: "idle" };
const baseSnapshot: HerdrSnapshot = {
  version: "0.8.0",
  protocol: 19,
  workspaces: [{ workspace_id: "w1", label: "workspace", focused: true }],
  tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main", focused: true }],
  panes: [callerPane, basePane],
  agents: [{ pane_id: "w1:p1", agent_id: "agent-caller", name: "caller", agent_status: "idle" }, { pane_id: "w1:p2", agent_id: "agent-7", name: "reviewer", agent_status: "idle" }]
};
const context = { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" };
const senderEnvelope = (kind: "prompt" | "steer", payload: string) => `[HERDR AGENT MESSAGE v1]\nfrom: caller (w1:p1)\nkind: ${kind}\nauthority: agent; not user/owner\npayload: all text after this blank line is sender-authored\n\n${payload}`;
const extensionContext = { signal: undefined, hasUI: false } as unknown as ExtensionContext;

type State = "idle" | "working" | "blocked" | "done" | "unknown" | "malformed";

function makeCli(initial: State = "idle", options: { postState?: State } = {}) {
  const calls: string[][] = [];
  const states: State[] = [];
  let state = initial;
  const response = (id: string, result: unknown) => ({ stdout: JSON.stringify({ id, result }), stderr: "", code: 0, killed: false });
  const exec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
    calls.push(argv);
    if (argv[0] === "api") {
      return response("snapshot-1", { snapshot: { ...baseSnapshot, panes: [{ ...callerPane }, { ...basePane, agent_status: state }], agents: [{ ...baseSnapshot.agents[0]! }, { ...baseSnapshot.agents[1]!, agent_status: state }] }, type: "session_snapshot" });
    }
    if (argv[0] === "pane" && argv[1] === "get") {
      const readState = options.postState && calls.filter((call) => call[0] === "pane" && call[1] === "get").length > 1 ? options.postState : state;
      states.push(readState);
      const pane = readState === "malformed" ? { ...basePane, agent_status: undefined } : { ...basePane, agent_status: readState };
      return response(`pane-${states.length}`, { pane });
    }
    if (argv[0] === "agent" && argv[1] === "send-keys") {
      state = argv[3] === "esc" ? "idle" : "working";
      return response("interrupt-1", { ok: true });
    }
    if (argv[0] === "agent" && argv[1] === "prompt") {
      state = "working";
      return response("prompt-1", { ok: true });
    }
    throw new Error(`unexpected argv ${argv.join(" ")}`);
  });
  return { cli: new HerdrCli(exec), calls, exec };
}

function execute(cli: HerdrCli, params: Record<string, unknown>) {
  return createCommunicateTool({ cli, context }).execute("id", params as never, new AbortController().signal, undefined, extensionContext);
}

describe("herdr_communicate", () => {
  it.each(["idle", "done", "blocked"] as const)("steers %s directly without Escape", async (state) => {
    const harness = makeCli(state);
    const result = await execute(harness.cli, { target: "reviewer", operation: "steer", text: "new direction" });
    expect(harness.calls).toEqual([
      ["api", "snapshot"],
      ["pane", "get", "w1:p2"],
      ["agent", "prompt", "w1:p2", senderEnvelope("steer", "new direction"), "--wait", "--until", "working", "--timeout", "5000"],
      ["pane", "get", "w1:p2"]
    ]);
    expect(harness.calls.some((call) => call.includes("esc"))).toBe(false);
    expect(result.details).toMatchObject({ route: "steer_direct", preState: { agent_status: state }, postState: { agent_status: "working" }, operationIds: { prompt: "prompt-1", postState: "pane-2" } });
  });

  it("steers a working agent by submitting directly without interrupting", async () => {
    const harness = makeCli("working");
    const result = await execute(harness.cli, { target: "reviewer", operation: "steer", text: "replace direction" });
    expect(harness.calls).toEqual([
      ["api", "snapshot"],
      ["pane", "get", "w1:p2"],
      ["agent", "prompt", "w1:p2", senderEnvelope("steer", "replace direction")],
      ["pane", "get", "w1:p2"]
    ]);
    expect(harness.calls.some((call) => call[0] === "agent" && call[1] === "send-keys")).toBe(false);
    expect(result.details).toMatchObject({ route: "steer_direct", preState: { agent_status: "working" }, operationIds: { prompt: "prompt-1", postState: "pane-2" } });
  });

  it("refuses prompt against working without mutation", async () => {
    const harness = makeCli("working");
    await expect(execute(harness.cli, { target: "reviewer", operation: "prompt", text: "hello" })).rejects.toMatchObject({ code: "TARGET_BUSY" });
    expect(harness.calls.some((call) => call[0] === "agent")).toBe(false);
  });

  it("rejects text self-targeting before pane read or send", async () => {
    const harness = makeCli();
    await expect(execute(harness.cli, { target: "current", operation: "prompt", text: "do not send" })).rejects.toMatchObject({ code: "SELF_TARGET_REJECTED" });
    expect(harness.calls).toEqual([["api", "snapshot"]]);
    const exact = makeCli();
    await expect(execute(exact.cli, { target: "w1:p1", operation: "steer", text: "do not send" })).rejects.toMatchObject({ code: "SELF_TARGET_REJECTED" });
    const label = makeCli();
    await expect(execute(label.cli, { target: "caller", operation: "steer", text: "do not send" })).rejects.toMatchObject({ code: "SELF_TARGET_REJECTED" });
    expect(label.calls).toEqual([["api", "snapshot"]]);
  });

  it("fails with unavailable sender before any send when caller is absent", async () => {
    const harness = makeCli();
    harness.exec.mockImplementation(async (_command, argv) => {
      if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { type: "session_snapshot", snapshot: { ...baseSnapshot, panes: [basePane] } } }), stderr: "", code: 0, killed: false };
      throw new Error(`unexpected mutation: ${argv.join(" ")}`);
    });
    await expect(execute(harness.cli, { target: "reviewer", operation: "prompt", text: "do not send" })).rejects.toMatchObject({ code: "SENDER_IDENTITY_UNAVAILABLE" });
    expect(harness.calls.some((call) => call[0] === "agent")).toBe(false);
  });

  it("prompts idle directly and returns bounded operation IDs and states", async () => {
    const harness = makeCli();
    const result = await execute(harness.cli, { target: "reviewer", operation: "prompt", text: "hello" });
    expect(harness.calls[2]).toEqual(["agent", "prompt", "w1:p2", senderEnvelope("prompt", "hello"), "--wait", "--until", "working", "--timeout", "5000"]);
    expect(result.details).toMatchObject({ operation: "prompt", route: "prompt_direct", preState: { agent_status: "idle" }, postState: { agent_status: "working" }, operationIds: { snapshot: "snapshot-1", preState: "pane-1", prompt: "prompt-1", postState: "pane-2" }, envelope: { version: "v1", kind: "prompt" } });
    expect(JSON.stringify(result)).not.toContain("environment");
  });

  it("does not expose a provenance opt-out field", () => {
    expect(JSON.stringify(CommunicateParamsSchema)).not.toContain("provenance");
    expect(JSON.stringify(CommunicateParamsSchema)).not.toContain("raw");
  });

  it("sends validated named keys and rejects unsupported keys before CLI", async () => {
    const harness = makeCli();
    await expect(execute(harness.cli, { target: "agent-7", operation: "keys", keys: ["enter", "ctrl+c"] })).resolves.toMatchObject({ details: { operation: "keys", operationIds: { keys: "interrupt-1", postState: "pane-2" } } });
    const callsBefore = harness.calls.length;
    await expect(execute(harness.cli, { target: "reviewer", operation: "keys", keys: ["raw-byte"] })).rejects.toMatchObject({ code: "KEY_REJECTED" });
    expect(harness.calls).toHaveLength(callsBefore);
  });

  it("fails typed and sends zero prompt/key bytes for unknown or malformed states", async () => {
    for (const state of ["unknown", "malformed"] as const) {
      const harness = makeCli(state);
      await expect(execute(harness.cli, { target: "reviewer", operation: "steer", text: "must not send" })).rejects.toMatchObject({ code: state === "unknown" ? "TARGET_STATE_UNKNOWN" : "TARGET_STATE_UNAVAILABLE" });
      expect(harness.calls.some((call) => call[0] === "agent")).toBe(false);
    }
  });

  it("fails on contradictory or unknown post-state after prompt", async () => {
    const contradictory = makeCli("idle", { postState: "idle" });
    await expect(execute(contradictory.cli, { target: "reviewer", operation: "prompt", text: "hello" })).rejects.toMatchObject({ code: "POSTSTATE_UNAVAILABLE" });
    const unknown = makeCli("idle", { postState: "unknown" });
    await expect(execute(unknown.cli, { target: "reviewer", operation: "prompt", text: "hello" })).rejects.toMatchObject({ code: "POSTSTATE_UNAVAILABLE" });
  });

  it("fails closed on malformed pane protocol responses", async () => {
    const exec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { snapshot: baseSnapshot } }), stderr: "", code: 0, killed: false };
      return { stdout: JSON.stringify({ id: "pane", result: { pane: null } }), stderr: "", code: 0, killed: false };
    });
    await expect(execute(new HerdrCli(exec), { target: "reviewer", operation: "prompt", text: "hello" })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
  });

  it("rejects missing authoritative identifiers and identity mismatches before bytes", async () => {
    for (const malformedPane of [{ pane: { ...basePane, pane_id: "" } }, { pane: { ...basePane, tab_id: "" } }, { pane: { ...basePane, workspace_id: "" } }, { pane: { ...basePane, pane_id: "wrong" } }]) {
      const exec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
        if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { snapshot: baseSnapshot } }), stderr: "", code: 0, killed: false };
        return { stdout: JSON.stringify({ id: "pane", result: malformedPane }), stderr: "", code: 0, killed: false };
      });
      await expect(execute(new HerdrCli(exec), { target: "reviewer", operation: "prompt", text: "hello" })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
      expect(exec.mock.calls.some((call) => call[1][0] === "agent")).toBe(false);
    }
  });

  it("validates pane envelopes, identifiers, and identity directly", () => {
    expect(() => paneFrom(null, "w1:p2")).toThrowError(/Invalid Herdr pane response/);
    expect(() => paneFrom({ pane: {} }, "w1:p2")).toThrowError(/missing authoritative identifiers/);
    expect(() => paneFrom({ pane: { pane_id: "wrong", tab_id: "t1", workspace_id: "w1" } }, "w1:p2")).toThrowError(/does not match/);
    expect(paneFrom({ pane: { pane_id: "w1:p2", tab_id: "t1", workspace_id: "w1" } }, "w1:p2")).toMatchObject({ pane_id: "w1:p2" });
  });

  it("covers compact optional metadata and omitted-signal execution", async () => {
    expect(compactPane({ pane_id: "p", tab_id: "t", workspace_id: "w", agent_status: "idle" })).toEqual({ pane_id: "p", tab_id: "t", workspace_id: "w", agent_status: "idle" });
    const harness = makeCli();
    const tool = createCommunicateTool({ cli: harness.cli, context });
    await expect(tool.execute("id", { target: "reviewer", operation: "prompt", text: "hello" }, undefined, undefined, extensionContext)).resolves.toMatchObject({ details: { operation: "prompt" } });
  });

  it("renders compact call/result rows", () => {
    const tool = createCommunicateTool({ cli: makeCli().cli, context });
    const call = tool.renderCall?.({ target: "reviewer", operation: "prompt", text: "hi" } as never, {} as never, {} as never);
    expect(call?.render(80)).toEqual(["herdr_communicate · prompt · reviewer"]);
    call?.invalidate();
    const result = tool.renderResult?.({ content: [], details: { operation: "prompt", outcome: "sent", target: { paneId: "w1:p2" }, preState: {}, postState: { agent_status: "working" }, operationIds: {} }, isError: false } as never, {} as never, {} as never, {} as never);
    expect(result?.render(80)).toEqual(["sent · w1:p2 · working"]);
    result?.invalidate();
  });
});
