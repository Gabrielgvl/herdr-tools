import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentPromptError, type AgentPromptClient } from "../../src/agent-prompt.js";
import { HerdrCli, type PiExec } from "../../src/cli.js";
import { RecipientRegistry } from "../../src/messages/recipients.js";
import type { AttachmentStore } from "../../src/messages/store.js";
import type { DevinQueueFlush } from "../../src/messages/devin-queue-flush.js";
import { compactPane, createCommunicateTool as createCommunicateToolImplementation, paneFrom, type CommunicateDependencies } from "../../src/tools/communicate.js";
import { CommunicateParamsSchema } from "../../src/schemas.js";
import type { HerdrSnapshot } from "../../src/targets.js";

const targetIdentity = { terminal_id: "term-reviewer", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-reviewer" } };
// Herdr 0.8.2 pane records do not repeat agent_name; the paired agent and
// identity reads provide the complementary fields used by prompt delivery.
const basePane = { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", label: "reviewer", agent_id: "agent-7", agent_status: "idle", agent: "pi", ...targetIdentity };
const callerPane = { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "caller", agent_status: "idle" };
const baseSnapshot: HerdrSnapshot = {
  version: "0.8.0",
  protocol: 22,
  workspaces: [{ workspace_id: "w1", label: "workspace", focused: true }],
  tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main", focused: true }],
  panes: [callerPane, basePane],
  agents: [{ pane_id: "w1:p1", agent_id: "agent-caller", name: "caller", agent_status: "idle" }, { pane_id: "w1:p2", agent_id: "agent-7", name: "reviewer", agent_status: "idle", agent: "pi", ...targetIdentity }]
};
const testPreflight = async () => undefined;
const fakeGrant = (key: string) => ({ path: `/cache/${key}`, token: `grant-${key}`, renew: async () => undefined, release: async () => undefined });

const createCommunicateTool = (deps: Omit<CommunicateDependencies, "preflight"> & Partial<Pick<CommunicateDependencies, "preflight">>) => createCommunicateToolImplementation({ ...deps, preflight: deps.preflight ?? testPreflight });

const context = { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" };
const senderEnvelope = (kind: "prompt" | "steer", payload: string) => `[HERDR AGENT MESSAGE v1]\nfrom: caller (w1:p1)\nkind: ${kind}\nauthority: agent; not user/owner\ndelivery: inline\npayload: all text after this blank line is sender-authored\n\n${payload}`;
const execResponse = (id: string, result: unknown) => ({ stdout: JSON.stringify({ id, result }), stderr: "", code: 0, killed: false });
const extensionContext = { signal: undefined, hasUI: false } as unknown as ExtensionContext;

type State = "idle" | "working" | "blocked" | "done" | "unknown" | "malformed";

function makeCli(initial: State = "idle", options: { postState?: State } = {}) {
  const calls: string[][] = [];
  const promptInputs: string[] = [];
  const states: State[] = [];
  let state = initial;
  let mutationSubmitted = false;
  const response = (id: string, result: unknown) => ({ stdout: JSON.stringify({ id, result }), stderr: "", code: 0, killed: false });
  const exec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
    if (argv[0] === "pane" && argv[1] === "current") return response("current", { type: "pane_current", pane: callerPane });
    calls.push(argv);
    if (argv[0] === "api") {
      return response("snapshot-1", { snapshot: { ...baseSnapshot, panes: [{ ...callerPane }, { ...basePane, agent_status: state }], agents: [{ ...baseSnapshot.agents[0]! }, { ...baseSnapshot.agents[1]!, agent_status: state }] }, type: "session_snapshot" });
    }
    if (argv[0] === "agent" && argv[1] === "get") {
      const readState = options.postState && mutationSubmitted ? options.postState : state;
      return response("agent-get", { agent: { pane_id: "w1:p2", name: "reviewer", agent: "pi", agent_status: readState, ...targetIdentity } });
    }
    if (argv[0] === "pane" && argv[1] === "get") {
      const readState = options.postState && mutationSubmitted ? options.postState : state;
      states.push(readState);
      const pane = readState === "malformed" ? { ...basePane, agent_status: undefined } : { ...basePane, agent_status: readState };
      return response(`pane-${states.length}`, { pane });
    }
    if (argv[0] === "agent" && argv[1] === "send-keys") {
      mutationSubmitted = true;
      state = argv[3] === "esc" ? "idle" : "working";
      return response("interrupt-1", { ok: true });
    }
    if (argv[0] === "agent" && argv[1] === "prompt") {
      throw new Error("text prompt must use the prompt socket client");
    }
    throw new Error(`unexpected argv ${argv.join(" ")}`);
  });
  const prompt = vi.fn<AgentPromptClient["prompt"]>().mockImplementation(async (_target, input) => {
    promptInputs.push(input);
    mutationSubmitted = true;
    state = "working";
    return { id: "cli:agent:prompt", result: {
      type: "agent_prompted",
      agent: {
        name: "reviewer",
        pane_id: "w1:p2",
        agent: "pi",
        agent_status: "working",
        ...targetIdentity,
        interactive_ready: true,
        revision: 3,
        state_change_seq: 1,
        screen_detection_skipped: true
      }
    } };
  });
  const promptClient: AgentPromptClient = { prompt, ping: vi.fn(async () => undefined) };
  return { cli: new HerdrCli(exec, 10_000, 50_000, promptClient), calls, promptInputs, exec, promptClient, prompt };
}

function execute(cli: HerdrCli, params: Record<string, unknown>, signal: AbortSignal = new AbortController().signal) {
  return createCommunicateTool({ cli, context }).execute("id", params as never, signal, undefined, extensionContext);
}

const claudeIdentity = { terminal_id: "term-claude", agent_session: { source: "herdr:claude", agent: "claude", kind: "id", value: "session-claude" } };

function makeClaudeCli(options: { omitSession?: boolean } = {}) {
  const harness = makeCli();
  const paneRecord = { ...basePane, agent: "claude", ...claudeIdentity };
  const agentRecord = { ...baseSnapshot.agents[1]!, agent: "claude", ...claudeIdentity };
  if (options.omitSession) {
    delete (paneRecord as Record<string, unknown>).agent_session;
    delete (agentRecord as Record<string, unknown>).agent_session;
  }
  const baseExec = harness.exec.getMockImplementation()!;
  harness.exec.mockImplementation(async (_command, argv, execOptions) => {
    if (argv[0] === "api") return execResponse("snapshot-claude", { type: "session_snapshot", snapshot: { ...baseSnapshot, panes: [callerPane, paneRecord], agents: [baseSnapshot.agents[0]!, agentRecord] } });
    if (argv[0] === "agent" && argv[1] === "get") return execResponse("agent-get", { agent: agentRecord });
    if (argv[0] === "pane" && argv[1] === "get") return execResponse("pane-claude", { pane: paneRecord });
    return baseExec(_command, argv, execOptions);
  });
  harness.prompt.mockImplementation(async (_target, input) => {
    harness.promptInputs.push(input);
    return { id: "cli:agent:prompt", result: { type: "agent_prompted", agent: { ...agentRecord, name: "reviewer", interactive_ready: true, revision: 3, state_change_seq: 1, screen_detection_skipped: true } } };
  });
  return harness;
}

describe("herdr_communicate", () => {
  it.each(["idle", "done", "blocked"] as const)("steers %s directly without Escape", async (state) => {
    const harness = makeCli(state);
    const result = await execute(harness.cli, { target: "reviewer", operation: "steer", text: "new direction" });
    expect(harness.calls).toEqual([
      ["api", "snapshot"],
      ["agent", "get", "w1:p2"],
      ["pane", "get", "w1:p2"],
      ["agent", "get", "w1:p2"],
      ["pane", "get", "w1:p2"],
      ["agent", "get", "w1:p2"],
      ["pane", "get", "w1:p2"]
    ]);
    expect(harness.prompt).toHaveBeenCalledWith("w1:p2", senderEnvelope("steer", "new direction"), expect.anything());
    expect(harness.calls.some((call) => call.includes("esc"))).toBe(false);
    expect(result.details).toMatchObject({ route: "steer_direct", preState: { agent_status: state }, postState: { agent_status: "working" }, submission: { confirmed: true, operationId: "cli:agent:prompt", screenDetectionSkipped: true }, promptDispatch: { state: "acknowledged", requestId: "cli:agent:prompt" }, observation: { status: "working", state: "working", screenDetectionSkipped: true }, operationIds: { prompt: "cli:agent:prompt", postState: "pane-3" } });
  });

  it("steers a working agent by submitting directly without interrupting", async () => {
    const harness = makeCli("working");
    const result = await execute(harness.cli, { target: "reviewer", operation: "steer", text: "replace direction" });
    expect(harness.calls).toEqual([
      ["api", "snapshot"],
      ["agent", "get", "w1:p2"],
      ["pane", "get", "w1:p2"],
      ["agent", "get", "w1:p2"],
      ["pane", "get", "w1:p2"],
      ["agent", "get", "w1:p2"],
      ["pane", "get", "w1:p2"]
    ]);
    expect(harness.prompt).toHaveBeenCalledWith("w1:p2", senderEnvelope("steer", "replace direction"), expect.anything());
    expect(harness.calls.some((call) => call[0] === "agent" && call[1] === "send-keys")).toBe(false);
    expect(result.details).toMatchObject({ route: "steer_direct", preState: { agent_status: "working" }, submission: { confirmed: true, operationId: "cli:agent:prompt" }, promptDispatch: { state: "acknowledged", requestId: "cli:agent:prompt" }, observation: { status: "working", screenDetectionSkipped: true }, operationIds: { prompt: "cli:agent:prompt", postState: "pane-3" } });
  });

  it("runs the prompt endpoint preflight before a text mutation", async () => {
    const harness = makeCli();
    const signal = new AbortController().signal;
    const preflight = vi.fn(async () => undefined);
    await createCommunicateTool({ cli: harness.cli, context, preflight }).execute("id", { target: "reviewer", operation: "prompt", text: "hello" }, signal, undefined, extensionContext);
    expect(preflight).toHaveBeenCalledWith(signal, "agent.prompt");
    expect(preflight.mock.invocationCallOrder[0]).toBeLessThan(harness.prompt.mock.invocationCallOrder[0]!);
  });

  it("requires complete pre-submission identity and sends no bytes for missing or replaced records", async () => {
    for (const replacement of [
      { ...targetIdentity, terminal_id: undefined },
      { ...targetIdentity, agent_session: undefined },
      { ...targetIdentity, agent_session: { ...targetIdentity.agent_session, value: "replacement" } }
    ]) {
      const harness = makeCli();
      const base = harness.cli.runJson;
      let agentReads = 0;
      harness.cli.runJson = vi.fn(async (argv, signal, preserve) => {
        if (argv[0] === "agent" && argv[1] === "get" && agentReads++ === 0) return { id: "agent-get", result: { agent: { pane_id: "w1:p2", name: "reviewer", agent: "pi", ...replacement } } };
        return base.call(harness.cli, argv, signal, preserve);
      });
      await expect(execute(harness.cli, { target: "reviewer", operation: "steer", text: "must not send" })).rejects.toMatchObject({ code: expect.stringMatching(/TARGET_IDENTITY|CLI_PROTOCOL/) });
      expect(harness.prompt).not.toHaveBeenCalled();
    }
  });

  it("delivers a prompt to a working target as steering input", async () => {
    const harness = makeCli("working");
    const result = await execute(harness.cli, { target: "reviewer", operation: "prompt", text: "hello" });
    expect(harness.prompt).toHaveBeenCalledTimes(1);
    expect(harness.promptInputs).toEqual([senderEnvelope("prompt", "hello")]);
    expect(result.details).toMatchObject({ outcome: "sent", operation: "prompt", route: "prompt_direct", preState: { agent_status: "working" } });
  });

  it.each([
    ["blocked", "TARGET_BLOCKED"],
    ["unknown", "TARGET_STATE_UNKNOWN"],
    ["malformed", "TARGET_STATE_UNAVAILABLE"]
  ] as const)("refuses normal prompt against %s without prompt bytes", async (state, code) => {
    const harness = makeCli(state);
    await expect(execute(harness.cli, { target: "reviewer", operation: "prompt", text: "hello" })).rejects.toMatchObject({ code });
    expect(harness.prompt).not.toHaveBeenCalled();
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
      if (argv[0] === "pane" && argv[1] === "current") return execResponse("current", { type: "pane_current", pane: callerPane });
      if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { type: "session_snapshot", snapshot: { ...baseSnapshot, panes: [basePane] } } }), stderr: "", code: 0, killed: false };
      throw new Error(`unexpected mutation: ${argv.join(" ")}`);
    });
    await expect(execute(harness.cli, { target: "reviewer", operation: "prompt", text: "do not send" })).rejects.toMatchObject({ code: "CONTEXT_UNAVAILABLE" });
    expect(harness.calls.some((call) => call[0] === "agent" && call[1] === "prompt")).toBe(false);
  });

  it("fails closed when the fresh snapshot has no target pane record", async () => {
    const harness = makeCli();
    const base = harness.cli.runJson;
    harness.cli.runJson = vi.fn(async (argv, signal, preserve) => {
      if (argv[0] === "api") return { id: "snapshot", result: { type: "session_snapshot", snapshot: { ...baseSnapshot, panes: [callerPane], agents: [baseSnapshot.agents[0]!, baseSnapshot.agents[1]!] } } };
      return base.call(harness.cli, argv, signal, preserve);
    });
    await expect(execute(harness.cli, { target: "reviewer", operation: "steer", text: "must not send" })).rejects.toMatchObject({ code: "TARGET_IDENTITY_UNAVAILABLE" });
    expect(harness.prompt).not.toHaveBeenCalled();
  });

  it("lazily adopts a detected unnamed pi target before prompting", async () => {
    const harness = makeCli();
    const base = harness.cli.runJson;
    let adopted = false;
    const renameCalls: string[][] = [];
    const unnamedAgent = { pane_id: "w1:p2", agent_id: "agent-7", agent_status: "idle", agent: "pi", ...targetIdentity };
    const agent = () => adopted ? { ...unnamedAgent, name: "pi-w1p2" } : unnamedAgent;
    const pane = () => adopted ? { ...basePane, agent_name: "pi-w1p2" } : basePane;
    harness.cli.runJson = vi.fn(async (argv, signal, preserve) => {
      const key = argv.join(" ");
      if (argv[0] === "api") return { id: "snapshot", result: { type: "session_snapshot", snapshot: { ...baseSnapshot, panes: [callerPane, pane()], agents: [baseSnapshot.agents[0]!, agent()] } } };
      if (key.startsWith("agent get")) return { id: "agent-get", result: { agent: agent() } };
      if (key.startsWith("pane get")) return { id: "pane-get", result: { pane: pane() } };
      if (key.startsWith("agent rename")) { renameCalls.push(argv); adopted = true; return { id: "rename", result: { type: "agent_info", agent: { ...unnamedAgent, name: argv[3] } } }; }
      if (key.startsWith("pane report-metadata")) return { id: "meta", result: { ok: true } };
      return base.call(harness.cli, argv, signal, preserve);
    });
    harness.prompt.mockImplementation(async (_target, input) => {
      harness.promptInputs.push(input);
      return { id: "cli:agent:prompt", result: { type: "agent_prompted", agent: { ...agent(), agent_status: "working", interactive_ready: true, revision: 3 } } };
    });
    const result = await execute(harness.cli, { target: "reviewer", operation: "prompt", text: "hello" });
    expect(renameCalls).toEqual([["agent", "rename", "w1:p2", "pi-w1p2"]]);
    expect(harness.promptInputs).toEqual([senderEnvelope("prompt", "hello")]);
    expect(result.details).toMatchObject({ operation: "prompt", submission: { confirmed: true } });
  });

  it("still fails closed when a detected target misses identity fields beyond the name", async () => {
    const harness = makeCli();
    const base = harness.cli.runJson;
    const unnamedAgent = { pane_id: "w1:p2", agent_id: "agent-7", agent_status: "idle", agent: "pi", terminal_id: "term-reviewer" };
    const unnamedPane = { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", label: "reviewer", agent_id: "agent-7", agent_status: "idle", agent: "pi", terminal_id: "term-reviewer" };
    harness.cli.runJson = vi.fn(async (argv, signal, preserve) => {
      const key = argv.join(" ");
      if (argv[0] === "api") return { id: "snapshot", result: { type: "session_snapshot", snapshot: { ...baseSnapshot, panes: [callerPane, unnamedPane], agents: [baseSnapshot.agents[0]!, unnamedAgent] } } };
      if (key.startsWith("agent get")) return { id: "agent-get", result: { agent: unnamedAgent } };
      if (key.startsWith("pane get")) return { id: "pane-get", result: { pane: unnamedPane } };
      return base.call(harness.cli, argv, signal, preserve);
    });
    await expect(execute(harness.cli, { target: "reviewer", operation: "prompt", text: "must not send" })).rejects.toMatchObject({ code: "TARGET_IDENTITY_UNAVAILABLE" });
    expect(harness.calls.some((argv) => argv[0] === "agent" && argv[1] === "rename")).toBe(false);
    expect(harness.prompt).not.toHaveBeenCalled();
  });

  it("prompts idle directly and returns bounded operation IDs and states", async () => {
    const harness = makeCli();
    const result = await execute(harness.cli, { target: "reviewer", operation: "prompt", text: "hello" });
    expect(harness.calls[2]).toEqual(["pane", "get", "w1:p2"]);
    expect(harness.promptInputs).toEqual([senderEnvelope("prompt", "hello")]);
    expect(result.details).toMatchObject({ operation: "prompt", delivery: "inline", route: "prompt_direct", preState: { agent_status: "idle" }, postState: { agent_status: "working" }, submission: { confirmed: true, operationId: "cli:agent:prompt", revision: 3 }, promptDispatch: { state: "acknowledged", requestId: "cli:agent:prompt" }, observation: { status: "working", state: "working", screenDetectionSkipped: true }, operationIds: { snapshot: "snapshot-1", preState: "pane-1", prompt: "cli:agent:prompt", postState: "pane-3" }, envelope: { version: "v1", kind: "prompt", delivery: "inline" } });
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

  it.each(["esc", "escape", "ctrl+c"] as const)("keeps raw named key %s on the direct send-keys route", async (key) => {
    const harness = makeCli();
    await expect(execute(harness.cli, { target: "reviewer", operation: "keys", keys: [key] })).resolves.toMatchObject({ details: { operation: "keys" } });
    expect(harness.calls).toContainEqual(["agent", "send-keys", "w1:p2", key]);
    expect(harness.calls.some((call) => call[0] === "api")).toBe(true);
  });

  it("fails closed when a named-key post-state is explicitly unknown", async () => {
    const harness = makeCli("idle", { postState: "unknown" });
    await expect(execute(harness.cli, { target: "reviewer", operation: "keys", keys: ["enter"] })).rejects.toMatchObject({ code: "POSTSTATE_UNAVAILABLE" });
  });

  it("keeps named-key delivery independent of text sender provenance", async () => {
    const calls: string[][] = [];
    const exec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      calls.push(argv);
      const response = (id: string, result: unknown) => ({ stdout: JSON.stringify({ id, result }), stderr: "", code: 0, killed: false });
      if (argv[0] === "pane" && argv[1] === "current") return response("current", { type: "pane_current", pane: callerPane });
      if (argv[0] === "api") return response("snapshot", { type: "session_snapshot", snapshot: { ...baseSnapshot, panes: [callerPane, basePane], agents: [baseSnapshot.agents[0]!, baseSnapshot.agents[1]!] } });
      if (argv[0] === "pane" && argv[1] === "get") return response("pane", { pane: basePane });
      if (argv[0] === "agent" && argv[1] === "send-keys") return response("keys", { ok: true });
      throw new Error(`unexpected argv ${argv.join(" ")}`);
    });
    const result = await execute(new HerdrCli(exec), { target: "reviewer", operation: "keys", keys: ["enter"] });
    expect(calls).toEqual([["pane", "current", "--current"], ["api", "snapshot"], ["pane", "get", "w1:p2"], ["agent", "send-keys", "w1:p2", "enter"], ["pane", "get", "w1:p2"]]);
    expect(result.details).not.toHaveProperty("sender");
    expect(result.details).not.toHaveProperty("envelope");
  });

  it("fails typed and sends zero prompt/key bytes for unknown or malformed states", async () => {
    for (const state of ["unknown", "malformed"] as const) {
      const harness = makeCli(state);
      await expect(execute(harness.cli, { target: "reviewer", operation: "steer", text: "must not send" })).rejects.toMatchObject({ code: state === "unknown" ? "TARGET_STATE_UNKNOWN" : "TARGET_STATE_UNAVAILABLE" });
      expect(harness.calls.some((call) => call[0] === "agent" && call[1] === "prompt")).toBe(false);
    }
  });

  it("reports idle and unknown post-state as observation without rejecting an accepted prompt", async () => {
    const idle = makeCli("idle", { postState: "idle" });
    await expect(execute(idle.cli, { target: "reviewer", operation: "prompt", text: "hello" })).resolves.toMatchObject({ details: { submission: { confirmed: true }, observation: { status: "not_working", state: "idle", screenDetectionSkipped: true } } });
    const unknown = makeCli("idle", { postState: "unknown" });
    await expect(execute(unknown.cli, { target: "reviewer", operation: "prompt", text: "hello" })).resolves.toMatchObject({ details: { submission: { confirmed: true }, observation: { status: "unknown", state: "unknown", screenDetectionSkipped: true } } });

    const replacement = makeCli();
    const replacementBase = replacement.cli.runJson;
    let agentReads = 0;
    replacement.cli.runJson = vi.fn(async (argv, signal, preserve) => {
      if (argv[0] === "agent" && argv[1] === "get" && agentReads++ > 1) return { id: "agent-get-replacement", result: { agent: { pane_id: "w1:p2", name: "reviewer", agent: "pi", terminal_id: "term-reviewer", agent_session: { source: "pi", agent: "pi", kind: "id", value: "replacement" }, agent_status: "working" } } };
      return replacementBase.call(replacement.cli, argv, signal, preserve);
    });
    const replacementResult = await execute(replacement.cli, { target: "reviewer", operation: "prompt", text: "hello" });
    expect(replacementResult).toMatchObject({ details: { submission: { confirmed: true }, observation: { status: "unavailable", code: "POSTSTATE_IDENTITY_CHANGED", evidence: { records: expect.any(Array) } } } });
    expect(replacementResult.details).not.toHaveProperty("postState");
    expect(JSON.stringify(replacementResult.content)).not.toContain("working");
    expect(replacement.prompt).toHaveBeenCalledTimes(1);
  });

  it("keeps post-state identity fail-closed while ignoring pane lifecycle skew", async () => {
    const malformedPost = makeCli();
    const malformedBase = malformedPost.cli.runJson;
    let paneReads = 0;
    malformedPost.cli.runJson = vi.fn(async (argv, signal, preserve) => {
      if (argv[0] === "pane" && argv[1] === "get" && paneReads++ > 1) return { id: "pane-post", result: { pane: { ...basePane, agent_status: undefined } } };
      return malformedBase.call(malformedPost.cli, argv, signal, preserve);
    });
    await expect(execute(malformedPost.cli, { target: "reviewer", operation: "steer", text: "hello" })).resolves.toMatchObject({ details: { submission: { confirmed: true }, observation: { status: "working", state: "working" } } });

    const replacementPost = makeCli();
    const replacementBase = replacementPost.cli.runJson;
    let replacementReads = 0;
    replacementPost.cli.runJson = vi.fn(async (argv, signal, preserve) => {
      if (argv[0] === "agent" && argv[1] === "get" && replacementReads++ > 1) return { id: "agent-post", result: { agent: { pane_id: "w1:p2", name: "reviewer", agent: "pi", terminal_id: "term-reviewer", agent_session: { source: "pi", agent: "pi", kind: "id", value: "replacement" }, agent_status: "working" } } };
      return replacementBase.call(replacementPost.cli, argv, signal, preserve);
    });
    const replacementPostResult = await execute(replacementPost.cli, { target: "reviewer", operation: "steer", text: "hello" });
    expect(replacementPostResult).toMatchObject({ details: { submission: { confirmed: true }, observation: { status: "unavailable", code: "POSTSTATE_IDENTITY_CHANGED" } } });
    expect(replacementPostResult.details).not.toHaveProperty("postState");
    expect(JSON.stringify(replacementPostResult.content)).not.toContain("working");
  });

  it("keeps a confirmed prompt when the optional post-state read fails", async () => {
    const harness = makeCli();
    const base = harness.cli.runJson;
    let paneReads = 0;
    harness.cli.runJson = vi.fn(async (argv, signal, preserve) => {
      if (argv[0] === "pane" && argv[1] === "get" && paneReads++ > 1) throw Object.assign(new Error("post read unavailable"), { code: "CLI_PROTOCOL_ERROR" });
      return base.call(harness.cli, argv, signal, preserve);
    });
    await expect(execute(harness.cli, { target: "reviewer", operation: "prompt", text: "hello" })).resolves.toMatchObject({ details: { submission: { confirmed: true, operationId: "cli:agent:prompt" }, observation: { status: "unavailable", code: "CLI_PROTOCOL_ERROR" } } });
    expect(harness.prompt).toHaveBeenCalledTimes(1);

    const stringFailure = makeCli();
    const stringBase = stringFailure.cli.runJson;
    let stringReads = 0;
    stringFailure.cli.runJson = vi.fn(async (argv, signal, preserve) => argv[0] === "pane" && argv[1] === "get" && stringReads++ > 1 ? Promise.reject("observation unavailable") : stringBase.call(stringFailure.cli, argv, signal, preserve));
    await expect(execute(stringFailure.cli, { target: "reviewer", operation: "prompt", text: "hello" })).resolves.toMatchObject({ details: { submission: { confirmed: true }, observation: { status: "unavailable", code: "POSTSTATE_UNAVAILABLE" } } });

    const aborted = makeCli();
    const abortBase = aborted.cli.runJson;
    let abortReads = 0;
    aborted.cli.runJson = vi.fn(async (argv, signal, preserve) => argv[0] === "pane" && argv[1] === "get" && abortReads++ > 1 ? Promise.reject(Object.assign(new Error("aborted"), { code: "ABORTED" })) : abortBase.call(aborted.cli, argv, signal, preserve));
    await expect(execute(aborted.cli, { target: "reviewer", operation: "prompt", text: "hello" })).resolves.toMatchObject({ details: { submission: { confirmed: true }, observation: { status: "unavailable", code: "ABORTED" } } });
    expect(aborted.prompt).toHaveBeenCalledTimes(1);
  });

  it.each(["prompt", "steer"] as const)("preserves an acknowledgement when %s transport aborts after exactly one submission", async (operation) => {
    const controller = new AbortController();
    const harness = makeCli();
    harness.prompt.mockImplementation(async (_target, input) => {
      harness.promptInputs.push(input);
      controller.abort();
      return {
        id: "cli:agent:prompt",
        result: {
        type: "agent_prompted",
        agent: {
          name: "reviewer",
          pane_id: "w1:p2",
          agent: "pi",
          ...targetIdentity,
          interactive_ready: true,
          revision: 3,
          screen_detection_skipped: true
        }
        }
      };
    });
    await expect(execute(harness.cli, { target: "reviewer", operation, text: "abort after acknowledgement" }, controller.signal)).resolves.toMatchObject({ details: { submission: { confirmed: true }, observation: { status: "unavailable", code: "ABORTED" } } });
    expect(harness.prompt).toHaveBeenCalledTimes(1);
    expect(harness.promptInputs).toHaveLength(1);
  });

  it("bounds long acknowledgement identity mismatches and nested protocol evidence", async () => {
    const long = (suffix: string): string => `${"r".repeat(256)}${suffix}`;
    const captured = {
      terminal_id: long("-terminal-captured"),
      agent_session: { source: long("-source-captured"), agent: "pi", kind: "id", value: long("-session-captured") }
    };
    const returned = {
      terminal_id: long("-terminal-returned"),
      agent_session: { source: long("-source-returned"), agent: "pi", kind: "id", value: long("-session-returned") }
    };
    const harness = makeCli();
    const base = harness.cli.runJson;
    harness.cli.runJson = vi.fn(async (argv, signal, preserve) => {
      if (argv[0] === "api") return { id: "snapshot-long", result: { type: "session_snapshot", snapshot: { ...baseSnapshot, panes: [{ ...callerPane }, { ...basePane, ...captured }], agents: [{ ...baseSnapshot.agents[0]! }, { ...baseSnapshot.agents[1]!, ...captured }] } } };
      if (argv[0] === "agent" && argv[1] === "get") return { id: "agent-long", result: { agent: { pane_id: "w1:p2", name: "reviewer", agent: "pi", ...captured } } };
      if (argv[0] === "pane" && argv[1] === "get") return { id: "pane-long", result: { pane: { ...basePane, ...captured } } };
      return base.call(harness.cli, argv, signal, preserve);
    });
    harness.prompt.mockImplementation(async (_target, input) => {
      harness.promptInputs.push(input);
      return { id: "cli:agent:prompt", result: { type: "agent_prompted", agent: { name: "reviewer", pane_id: "w1:p2", agent: "pi", ...returned, interactive_ready: true, revision: 3 } } };
    });
    const failure = await (execute(harness.cli, { target: "reviewer", operation: "prompt", text: "ack mismatch" }).catch((error: unknown) => error as { code?: string; details?: Record<string, unknown> }) as unknown as Promise<{ code?: string; details?: Record<string, unknown> }>);
    expect(failure).toMatchObject({ code: "CLI_PROTOCOL_ERROR", details: { delivery: "inline", route: "prompt_direct", phase: "send" } });
    const details = failure.details!;
    expect(details.promptDispatch).toEqual({ state: "unknown", requestId: "cli:agent:prompt" });
    expect(details.expectedTerminalId).toHaveLength(256);
    expect(details.actualTerminalId).toHaveLength(256);
    expect((details.expectedAgentSession as Record<string, string>).value).toHaveLength(256);
    expect((details.actualAgentSession as Record<string, string>).value).toHaveLength(256);
    expect(JSON.stringify(details)).not.toContain("-terminal-captured");
    expect(JSON.stringify(details)).not.toContain("-session-returned");
  });

  it("fails closed on malformed pane protocol responses", async () => {
    const exec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { snapshot: baseSnapshot } }), stderr: "", code: 0, killed: false };
      return { stdout: JSON.stringify({ id: "pane", result: { pane: null } }), stderr: "", code: 0, killed: false };
    });
    await expect(execute(new HerdrCli(exec), { target: "reviewer", operation: "prompt", text: "hello" })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
  });

  it("fails closed when the fresh agent record is missing", async () => {
    const harness = makeCli();
    const base = harness.cli.runJson;
    let agentReads = 0;
    harness.cli.runJson = vi.fn(async (argv, signal, preserve) => {
      if (argv[0] === "agent" && argv[1] === "get" && agentReads++ === 0) return { id: "agent-missing", result: { agent: null } };
      return base.call(harness.cli, argv, signal, preserve);
    });
    await expect(execute(harness.cli, { target: "reviewer", operation: "prompt", text: "must not send" })).rejects.toMatchObject({ code: "TARGET_IDENTITY_UNAVAILABLE" });
    expect(harness.prompt).not.toHaveBeenCalled();
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
    expect(compactPane({ pane_id: "p", tab_id: "t", workspace_id: "w", agent_status: "idle", revision: 4 })).toMatchObject({ revision: 4 });
    expect(compactPane({ pane_id: "p", tab_id: "t", workspace_id: "w", agent_status: "idle", revision: -1 })).not.toHaveProperty("revision");
    expect(compactPane({ pane_id: "p", tab_id: "t", workspace_id: "w", agent_status: "idle", revision: 1.5 })).not.toHaveProperty("revision");
    const harness = makeCli();
    const tool = createCommunicateTool({ cli: harness.cli, context });
    await expect(tool.execute("id", { target: "reviewer", operation: "prompt", text: "hello" }, undefined, undefined, extensionContext)).resolves.toMatchObject({ details: { operation: "prompt" } });
  });

  it("publishes explicit attachments only for a verified profile recipient", async () => {
    const harness = makeCli();
    const recipients = new RecipientRegistry();
    recipients.register({ paneId: "w1:p2", terminalId: "term-reviewer", agentName: "reviewer", agentKind: "pi", agentSession: targetIdentity.agent_session, recipientKey: "recipient-key", profileName: "worker-pi", kind: "pi", capable: true, reason: "read", agentId: "agent-7" });
    const attachments: AttachmentStore = {
      root: "/cache",
      recipientDirectory: (key) => `/cache/${key}`,
      ensureRecipient: async (key: string) => fakeGrant(key),
      publish: vi.fn(async () => ({ attachmentId: "attachment-1", path: "/cache/recipient-key/attachment-1/body.txt", bytes: 15, sha256: "a".repeat(64), expiresAt: "2026-08-21T12:00:00.000Z", recipientPaneId: "w1:p2" }))
    };
    const tool = createCommunicateTool({ cli: harness.cli, context, attachments, recipients });
    const result = await tool.execute("id", { target: "reviewer", operation: "prompt", text: "attachment body", delivery: "attachment" }, new AbortController().signal, undefined, extensionContext);
    expect(attachments.publish).toHaveBeenCalledWith(expect.objectContaining({ body: "attachment body", recipientKey: "recipient-key", recipientPaneId: "w1:p2" }));
    expect(harness.promptInputs[0]).toContain("delivery: attachment");
    expect(harness.promptInputs[0]).not.toContain("attachment body");
    expect(result.details).toMatchObject({ delivery: "attachment", attachment: { attachmentId: "attachment-1", bytes: 15 } });

    const unverifiedStore = { ...attachments, publish: vi.fn() } as unknown as AttachmentStore;
    await expect(createCommunicateTool({ cli: harness.cli, context, attachments: unverifiedStore }).execute("id", { target: "reviewer", operation: "prompt", text: "body", delivery: "attachment" }, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "ATTACHMENT_TARGET_UNVERIFIED" });
    expect(unverifiedStore.publish).not.toHaveBeenCalled();
  });

  it.each(["prompt", "steer"] as const)("delivers %s to a qualified Claude recipient", async (operation) => {
    const harness = makeClaudeCli();
    const result = await execute(harness.cli, { target: "reviewer", operation, text: "claude body" });
    expect(harness.prompt).toHaveBeenCalledWith("w1:p2", expect.stringContaining("claude body"), expect.anything());
    expect(harness.promptInputs[0]).toContain(`kind: ${operation}`);
    expect(result.details).toMatchObject({ route: `${operation}_direct`, promptDispatch: { state: "acknowledged", requestId: "cli:agent:prompt" }, submission: { confirmed: true, agentSession: claudeIdentity.agent_session } });
  });

  it("publishes attachments for a verified Claude recipient", async () => {
    const harness = makeClaudeCli();
    const recipients = new RecipientRegistry();
    recipients.register({ paneId: "w1:p2", terminalId: "term-claude", agentName: "reviewer", agentKind: "claude", agentSession: claudeIdentity.agent_session, recipientKey: "claude-recipient-key", profileName: "worker-claude", kind: "claude", capable: true, reason: "read", agentId: "agent-7" });
    const publish = vi.fn(async () => ({ attachmentId: "attachment-1", path: "/cache/claude-recipient-key/attachment-1/body.txt", bytes: 15, sha256: "a".repeat(64), expiresAt: "2026-08-21T12:00:00.000Z", recipientPaneId: "w1:p2" }));
    const attachments = { root: "/cache", recipientDirectory: (key: string) => `/cache/${key}`, ensureRecipient: async (key: string) => fakeGrant(key), publish } as unknown as AttachmentStore;
    const result = await createCommunicateTool({ cli: harness.cli, context, attachments, recipients }).execute("id", { target: "reviewer", operation: "prompt", text: "attachment body", delivery: "attachment" }, new AbortController().signal, undefined, extensionContext);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ body: "attachment body", recipientKey: "claude-recipient-key", recipientPaneId: "w1:p2" }));
    expect(harness.promptInputs[0]).toContain("delivery: attachment");
    expect(harness.promptInputs[0]).not.toContain("attachment body");
    expect(result.details).toMatchObject({ delivery: "attachment", attachment: { attachmentId: "attachment-1" } });
  });

  it.each([["AGY", "agy", "AGY_UNQUALIFIED"]] as const)("rejects %s %s before attachment publication or prompt send", async (_label, kind, code) => {
    const harness = makeCli();
    const targetPane = { ...basePane, agent: kind, terminal_id: `term-${kind}`, agent_session: { source: kind, agent: kind, kind: "id", value: `session-${kind}` } };
    const targetAgent = { ...baseSnapshot.agents[1]!, agent: kind, terminal_id: `term-${kind}`, agent_session: targetPane.agent_session };
    const baseExec = harness.exec.getMockImplementation()!;
    harness.exec.mockImplementation(async (_command, argv, options) => {
      if (argv[0] === "api") return execResponse(`snapshot-${kind}`, { type: "session_snapshot", snapshot: { ...baseSnapshot, panes: [callerPane, targetPane], agents: [baseSnapshot.agents[0]!, targetAgent] } });
      return baseExec(_command, argv, options);
    });
    const publish = vi.fn();
    const attachments = { root: "/cache", recipientDirectory: (key: string) => `/cache/${key}`, ensureRecipient: async (key: string) => fakeGrant(key), publish } as unknown as AttachmentStore;
    const recipients = new RecipientRegistry();
    for (const operation of ["prompt", "steer"] as const) {
      await expect(createCommunicateTool({ cli: harness.cli, context, attachments, recipients }).execute("id", { target: "reviewer", operation, text: "blocked", delivery: "attachment" }, new AbortController().signal, undefined, extensionContext))
        .rejects.toMatchObject({ code, details: { phase: "resolve_target", delivery: "attachment", route: `${operation}_direct` } });
    }
    expect(publish).not.toHaveBeenCalled();
    expect(harness.prompt).not.toHaveBeenCalled();
  });

  it("rejects a partial Claude identity at the strict join before any send", async () => {
    const harness = makeClaudeCli({ omitSession: true });
    for (const operation of ["prompt", "steer"] as const) {
      await expect(execute(harness.cli, { target: "reviewer", operation, text: "blocked" })).rejects.toMatchObject({ code: "TARGET_IDENTITY_UNAVAILABLE" });
    }
    expect(harness.prompt).not.toHaveBeenCalled();
  });

  it.each([["AGY", "agy", "AGY_UNQUALIFIED"]] as const)("rejects a partial %s %s identity before the strict join", async (_label, kind, code) => {
    const harness = makeCli();
    const targetPane = { ...basePane, agent: kind };
    delete (targetPane as Record<string, unknown>).agent_session;
    const targetAgent = { ...baseSnapshot.agents[1]!, agent: kind };
    delete (targetAgent as Record<string, unknown>).agent_session;
    const baseExec = harness.exec.getMockImplementation()!;
    harness.exec.mockImplementation(async (_command, argv, options) => {
      if (argv[0] === "api") return execResponse(`snapshot-${kind}-partial`, { type: "session_snapshot", snapshot: { ...baseSnapshot, panes: [callerPane, targetPane], agents: [baseSnapshot.agents[0]!, targetAgent] } });
      return baseExec(_command, argv, options);
    });
    for (const operation of ["prompt", "steer"] as const) {
      await expect(execute(harness.cli, { target: "reviewer", operation, text: "blocked" })).rejects.toMatchObject({ code });
    }
    expect(harness.prompt).not.toHaveBeenCalled();
  });

  it.each([
    ["AGY", "agy", "AGY_UNQUALIFIED", "prompt", "inline"], ["AGY", "agy", "AGY_UNQUALIFIED", "prompt", "attachment"],
    ["AGY", "agy", "AGY_UNQUALIFIED", "steer", "inline"], ["AGY", "agy", "AGY_UNQUALIFIED", "steer", "attachment"],
    ["Claude", "claude", "TARGET_IDENTITY_CHANGED", "prompt", "inline"], ["Claude", "claude", "TARGET_IDENTITY_CHANGED", "prompt", "attachment"],
    ["Claude", "claude", "TARGET_IDENTITY_CHANGED", "steer", "inline"], ["Claude", "claude", "TARGET_IDENTITY_CHANGED", "steer", "attachment"]
  ] as const)("rejects a %s final-read replacement before %s %s delivery", async (_label, kind, code, operation, delivery) => {
    const harness = makeCli();
    const baseRun = harness.cli.runJson;
    let agentReads = 0;
    harness.cli.runJson = vi.fn(async (argv, signal, preserve) => {
      if (argv[0] === "agent" && argv[1] === "get" && agentReads++ === 1) {
        return { id: `agent-final-${kind}`, result: { agent: { pane_id: "w1:p2", name: "reviewer", agent: kind, terminal_id: `term-${kind}`, agent_session: { source: kind, agent: kind, kind: "id", value: `session-${kind}` }, agent_status: "idle" } } };
      }
      return baseRun.call(harness.cli, argv, signal, preserve);
    });
    const publish = vi.fn(async () => ({ attachmentId: "attachment-1", path: "/cache/recipient-key/body.txt", bytes: 7, sha256: "a".repeat(64), expiresAt: "2026-08-21T12:00:00.000Z", recipientPaneId: "w1:p2" }));
    const attachments: AttachmentStore = { root: "/cache", recipientDirectory: (key) => `/cache/${key}`, ensureRecipient: async (key) => fakeGrant(key), publish };
    const recipients = new RecipientRegistry();
    if (delivery === "attachment") recipients.register({ paneId: "w1:p2", terminalId: "term-reviewer", agentName: "reviewer", agentKind: "pi", agentSession: targetIdentity.agent_session, recipientKey: "recipient-key", profileName: "worker-pi", kind: "pi", capable: true, reason: "read", agentId: "agent-7" });
    const tool = createCommunicateTool({ cli: harness.cli, context, attachments, recipients });
    await expect(tool.execute("id", { target: "reviewer", operation, text: "blocked", ...(delivery === "attachment" ? { delivery } : {}) }, new AbortController().signal, undefined, extensionContext))
      .rejects.toMatchObject({ code, details: { phase: "pre_state" } });
    expect(harness.prompt).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("refuses attachment delivery for unregistered, incapable, and identity-mismatched recipients", async () => {
    const attachments = (publish = vi.fn()): AttachmentStore => ({
      root: "/cache",
      recipientDirectory: (key: string) => `/cache/${key}`,
      ensureRecipient: async (key: string) => fakeGrant(key),
      publish
    } as unknown as AttachmentStore);
    const attachment = { target: "reviewer", operation: "prompt" as const, text: "body", delivery: "attachment" as const };

    const unregistered = makeCli();
    const unregisteredStore = attachments();
    await expect(createCommunicateTool({ cli: unregistered.cli, context, attachments: unregisteredStore, recipients: new RecipientRegistry() }).execute("id", attachment, new AbortController().signal, undefined, extensionContext))
      .rejects.toMatchObject({ code: "ATTACHMENT_TARGET_UNVERIFIED", details: { target: "w1:p2", delivery: "attachment", reason: "recipient capability is not registered in this runtime" } });
    expect(unregisteredStore.publish).not.toHaveBeenCalled();

    const incapable = new RecipientRegistry();
    incapable.register({ paneId: "w1:p2", terminalId: "term-reviewer", agentName: "reviewer", agentKind: "pi", agentSession: targetIdentity.agent_session, recipientKey: "recipient-key", profileName: "restricted", kind: "pi", capable: false, reason: "Pi profile excludes the local read tool", agentId: "agent-7" });
    const incapableStore = attachments();
    await expect(createCommunicateTool({ cli: makeCli().cli, context, attachments: incapableStore, recipients: incapable }).execute("id", attachment, new AbortController().signal, undefined, extensionContext))
      .rejects.toMatchObject({ code: "ATTACHMENT_TARGET_UNVERIFIED", details: { reason: "Pi profile excludes the local read tool" } });
    expect(incapableStore.publish).not.toHaveBeenCalled();

    const mismatched = new RecipientRegistry();
    mismatched.register({ paneId: "w1:p2", terminalId: "term-reviewer", agentName: "reviewer", agentKind: "pi", agentSession: { ...targetIdentity.agent_session, value: "session-replaced" }, recipientKey: "recipient-key", profileName: "worker-pi", kind: "pi", capable: true, reason: "read", agentId: "agent-replaced" });
    const mismatchedStore = attachments();
    await expect(createCommunicateTool({ cli: makeCli().cli, context, attachments: mismatchedStore, recipients: mismatched }).execute("id", attachment, new AbortController().signal, undefined, extensionContext))
      .rejects.toMatchObject({ code: "ATTACHMENT_TARGET_UNVERIFIED", details: { reason: "recipient identity no longer matches the authoritative snapshot" } });
    expect(mismatchedStore.publish).not.toHaveBeenCalled();
  });

  it("keeps typed codes and reports retained attachments when a send or post-read fails", async () => {
    const published = { attachmentId: "attachment-1", path: "/cache/recipient-key/attachment-1/body.txt", bytes: 4, sha256: "a".repeat(64), expiresAt: "2026-08-21T12:00:00.000Z", recipientPaneId: "w1:p2" };
    const recipients = new RecipientRegistry();
    recipients.register({ paneId: "w1:p2", terminalId: "term-reviewer", agentName: "reviewer", agentKind: "pi", agentSession: targetIdentity.agent_session, recipientKey: "recipient-key", profileName: "worker-pi", kind: "pi", capable: true, reason: "read", agentId: "agent-7" });
    const attachments = { root: "/cache", recipientDirectory: (key: string) => `/cache/${key}`, ensureRecipient: async (key: string) => fakeGrant(key), publish: async () => published } as unknown as AttachmentStore;

    const sendFailure = makeCli();
    sendFailure.prompt.mockRejectedValue(Object.assign(new Error("submission refused"), { code: "CLI_PROTOCOL_ERROR", details: { promptDispatch: { state: "unknown", requestId: "request-unknown" } } }));
    const sendError = await createCommunicateTool({ cli: sendFailure.cli, context, attachments, recipients }).execute("id", { target: "reviewer", operation: "prompt", text: "body", delivery: "attachment" }, new AbortController().signal, undefined, extensionContext).catch((error: { code?: string; details?: Record<string, unknown> }) => error);
    expect(sendError).toMatchObject({
      code: "CLI_PROTOCOL_ERROR",
      details: { promptDispatch: { state: "unknown", requestId: "request-unknown" }, delivery: "attachment", route: "prompt_direct", phase: "send", attachmentRetained: true, attachment: { attachmentId: "attachment-1", path: published.path } }
    });
    expect(JSON.stringify(sendError)).not.toContain("submission refused");

    const postFailure = makeCli("idle", { postState: "idle" });
    await expect(createCommunicateTool({ cli: postFailure.cli, context, attachments, recipients }).execute("id", { target: "reviewer", operation: "prompt", text: "body", delivery: "attachment" }, new AbortController().signal, undefined, extensionContext))
      .resolves.toMatchObject({ details: { delivery: "attachment", observation: { status: "not_working", state: "idle", screenDetectionSkipped: true }, attachment: { attachmentId: "attachment-1" } } });

    const publishFailure = { ...attachments, publish: async () => { throw Object.assign(new Error("store"), { code: "ATTACHMENT_STORE_FAILED", details: { operation: "publish" } }); } } as unknown as AttachmentStore;
    await expect(createCommunicateTool({ cli: makeCli().cli, context, attachments: publishFailure, recipients }).execute("id", { target: "reviewer", operation: "prompt", text: "body", delivery: "attachment" }, new AbortController().signal, undefined, extensionContext))
      .rejects.toMatchObject({ code: "ATTACHMENT_STORE_FAILED", details: { operation: "publish", delivery: "attachment", phase: "publish" } });

    const keysFailure = makeCli();
    keysFailure.exec.mockImplementation(async (_command, argv) => {
      if (argv[0] === "pane" && argv[1] === "current") return execResponse("current", { type: "pane_current", pane: callerPane });
      if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot-1", result: { type: "session_snapshot", snapshot: baseSnapshot } }), stderr: "", code: 0, killed: false };
      if (argv[0] === "pane") return { stdout: JSON.stringify({ id: "pane-1", result: { pane: { ...basePane, agent_status: "idle" } } }), stderr: "", code: 0, killed: false };
      return { stdout: "", stderr: "keys rejected", code: 1, killed: false };
    });
    await expect(createCommunicateTool({ cli: keysFailure.cli, context }).execute("id", { target: "reviewer", operation: "keys", keys: ["enter"] }, new AbortController().signal, undefined, extensionContext))
      .rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR", details: { phase: "send" } });
  });

  it.each([
    ["not_written", "BACKEND_UNAVAILABLE", undefined],
    ["rejected", "TARGET_BLOCKED", "request-rejected"],
    ["unknown", "PROMPT_DISPATCH_UNKNOWN", "request-unknown"]
  ] as const)("retains %s prompt dispatch evidence without retrying", async (state, code, requestId) => {
    const harness = makeCli();
    harness.prompt.mockRejectedValue(new AgentPromptError(code, "safe prompt dispatch failure", { state, ...(requestId ? { requestId } : {}) }));
    await expect(execute(harness.cli, { target: "reviewer", operation: "prompt", text: "hello" })).rejects.toMatchObject({ code, details: { promptDispatch: { state, ...(requestId ? { requestId } : {}) } } });
    expect(harness.prompt).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized inline text before any Herdr call and rejects delivery on keys", async () => {
    const harness = makeCli();
    const preflight = vi.fn(async () => undefined);
    const tool = createCommunicateTool({ cli: harness.cli, context, preflight });
    await expect(tool.execute("id", { target: "reviewer", operation: "prompt", text: "x".repeat(16 * 1024 + 1) }, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE_FOR_INLINE" });
    expect(preflight).not.toHaveBeenCalled();
    await expect(tool.execute("id", { target: "reviewer", operation: "keys", keys: ["enter"], delivery: "inline" } as never, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "INVALID_INPUT", details: { field: "delivery" } });
    await expect(tool.execute("id", { target: "reviewer", operation: "keys", keys: ["enter"], kind: "result" } as never, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "INVALID_INPUT", details: { field: "kind" } });
    await expect(tool.execute("id", { target: "reviewer", operation: "prompt", text: "body", delivery: "other" } as never, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(tool.execute("id", { target: "reviewer", operation: "steer", text: "body", kind: "bogus" } as never, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "INVALID_INPUT", details: { field: "kind" } });
  });

  it("locks a Devin steer write and schedules the flush from the last verified pre-send state", async () => {
    const devinIdentity = { terminal_id: "term-devin", agent_session: { source: "herdr:devin", agent: "devin", kind: "id", value: "session-devin" } };
    const makeDevinCli = (initial: State) => {
      const harness = makeCli(initial);
      const baseExec = harness.exec.getMockImplementation()!;
      const devinize = <T extends Record<string, unknown>>(record: T): T => ({ ...record, agent: "devin", ...devinIdentity });
      harness.exec.mockImplementation(async (_command, argv, execOptions) => {
        const base = await baseExec(_command, argv, execOptions);
        const response = JSON.parse(base.stdout) as { id: string; result: Record<string, unknown> };
        const snapshot = (response.result as { snapshot?: { panes?: Record<string, unknown>[]; agents?: Record<string, unknown>[] } }).snapshot;
        if (snapshot) {
          snapshot.panes = snapshot.panes!.map((pane) => (pane.pane_id === "w1:p2" ? devinize(pane) : pane));
          snapshot.agents = snapshot.agents!.map((agent) => (agent.pane_id === "w1:p2" ? devinize(agent) : agent));
        }
        const agent = (response.result as { agent?: Record<string, unknown> }).agent;
        if (agent?.pane_id === "w1:p2") response.result = { ...response.result, agent: devinize(agent) };
        const pane = (response.result as { pane?: Record<string, unknown> }).pane;
        if (pane?.pane_id === "w1:p2") response.result = { ...response.result, pane: devinize(pane) };
        return { ...base, stdout: JSON.stringify(response) };
      });
      harness.prompt.mockImplementation(async (_target, input) => {
        harness.promptInputs.push(input);
        return { id: "cli:agent:prompt", result: { type: "agent_prompted", agent: devinize({ name: "reviewer", pane_id: "w1:p2", agent_status: "working", interactive_ready: true, revision: 3, state_change_seq: 1, screen_detection_skipped: true }) } };
      });
      return harness;
    };
    const fakeQueueFlush = (events: string[]): { flush: DevinQueueFlush; schedule: ReturnType<typeof vi.fn>; writeSection: ReturnType<typeof vi.fn> } => {
      const schedule = vi.fn();
      const writeSection = vi.fn(async () => {
        events.push("acquire");
        return {
          check: async () => undefined,
          release: async () => { events.push("release"); },
          fence: { isSpent: async () => false, record: async () => undefined, rearm: async () => undefined },
        };
      });
      return { schedule, writeSection, flush: { begin: vi.fn(), shutdown: vi.fn(async () => undefined), schedule, writeSection } };
    };

    // A Devin steer acknowledged on a busy pane: the write rides the section
    // and the ack schedules a flush bound to the last verified pre-send state.
    const events: string[] = [];
    const busy = makeDevinCli("working");
    const { flush, schedule, writeSection } = fakeQueueFlush(events);
    busy.prompt.mockImplementation(async (target) => {
      events.push("prompt");
      return { id: "cli:agent:prompt", result: { type: "agent_prompted", agent: { name: "reviewer", pane_id: target, agent: "devin", agent_status: "working", ...devinIdentity, interactive_ready: true, revision: 3, state_change_seq: 1, screen_detection_skipped: true } } };
    });
    const result = await createCommunicateTool({ cli: busy.cli, context, queueFlush: flush })
      .execute("id", { target: "reviewer", operation: "steer", text: "queued direction" }, new AbortController().signal, undefined, extensionContext);
    expect(events).toEqual(["acquire", "prompt", "release"]);
    expect(writeSection).toHaveBeenCalledWith("w1:p2");
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledWith({ submission: expect.objectContaining({ agentKind: "devin", paneId: "w1:p2", agentName: "reviewer", agentSession: devinIdentity.agent_session, confirmed: true }), sentState: "working" });
    expect(result.details).toMatchObject({ outcome: "sent", route: "steer_direct", preState: { agent_status: "working" } });

    // Acknowledged on an idle pane: the write is still locked, but no flush.
    const idleEvents: string[] = [];
    const idle = makeDevinCli("idle");
    const idleFlush = fakeQueueFlush(idleEvents);
    await createCommunicateTool({ cli: idle.cli, context, queueFlush: idleFlush.flush })
      .execute("id", { target: "reviewer", operation: "steer", text: "free direction" }, new AbortController().signal, undefined, extensionContext);
    expect(idleEvents).toEqual(["acquire", "release"]);
    expect(idleFlush.schedule).not.toHaveBeenCalled();

    // A normal prompt to a working Devin pane delivers through the same
    // locked section and schedules the queue flush just like a steer: the
    // submitted text lands in the composer queue while the pane is busy.
    const promptEvents: string[] = [];
    const promptDevin = makeDevinCli("working");
    const promptFlush = fakeQueueFlush(promptEvents);
    const promptResult = await createCommunicateTool({ cli: promptDevin.cli, context, queueFlush: promptFlush.flush })
      .execute("id", { target: "reviewer", operation: "prompt", text: "body" }, new AbortController().signal, undefined, extensionContext);
    expect(promptEvents).toEqual(["acquire", "release"]);
    expect(promptDevin.promptInputs).toHaveLength(1);
    expect(promptFlush.schedule).toHaveBeenCalledTimes(1);
    expect(promptResult.details).toMatchObject({ outcome: "sent", route: "prompt_direct", preState: { agent_status: "working" } });

    // A non-Devin target never touches the coordinator even when one is wired.
    const pi = makeCli("working");
    const piFlush = fakeQueueFlush([]);
    await createCommunicateTool({ cli: pi.cli, context, queueFlush: piFlush.flush })
      .execute("id", { target: "reviewer", operation: "steer", text: "pi direction" }, new AbortController().signal, undefined, extensionContext);
    expect(piFlush.writeSection).not.toHaveBeenCalled();
    expect(piFlush.schedule).not.toHaveBeenCalled();
  });

  it("renders compact call/result rows", () => {
    const tool = createCommunicateTool({ cli: makeCli().cli, context });
    const keyCall = tool.renderCall?.({ target: "reviewer", operation: "keys", keys: ["enter"] } as never, {} as never, {} as never);
    expect(keyCall?.render(80)).toEqual(["herdr_communicate · keys · reviewer"]);
    keyCall?.invalidate();
    const call = tool.renderCall?.({ target: "reviewer", operation: "prompt", text: "hi" } as never, {} as never, {} as never);
    expect(call?.render(80)).toEqual(["herdr_communicate · prompt · inline · reviewer"]);
    call?.invalidate();
    const result = tool.renderResult?.({ content: [], details: { operation: "prompt", outcome: "sent", delivery: "inline", target: { paneId: "w1:p2" }, preState: {}, postState: { agent_status: "working" }, operationIds: {} }, isError: false } as never, {} as never, {} as never, {} as never);
    expect(result?.render(80)).toEqual(["sent · inline · w1:p2 · working"]);
    result?.invalidate();
  });
});

describe("caller policy", () => {
  const workerSession = { source: "herdr:devin", agent: "devin", kind: "id", value: "session-worker" };
  const workerTokens = { identity_provenance: "launched", identity_actor: "w1:pM", identity_session: "session-worker" };
  const managerIdentity = { terminal_id: "term-manager", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-manager" } };

  function makeWorkerCli(options: { tokens?: Record<string, unknown>; callerAgentTokens?: Record<string, unknown>; callerSessionOverride?: unknown; includeManager?: boolean; callerChildren?: number } = {}) {
    const calls: string[][] = [];
    const promptInputs: string[] = [];
    let state: State = "idle";
    const callerSession = options.callerSessionOverride === undefined ? workerSession : options.callerSessionOverride;
    const callerRecord = { ...callerPane, agent_session: callerSession, tokens: options.tokens ?? { ...workerTokens } };
    const callerAgent = { pane_id: "w1:p1", agent_id: "agent-caller", name: "caller", agent_status: "idle", ...(options.callerSessionOverride === undefined ? { agent_session: workerSession } : {}), ...(options.callerAgentTokens ? { tokens: options.callerAgentTokens } : {}) };
    const manager = { pane_id: "w1:pM", tab_id: "w1:t1", workspace_id: "w1", label: "manager", agent_id: "agent-m", agent_status: "idle", agent: "pi", ...managerIdentity };
    const managerAgent = { pane_id: "w1:pM", agent_id: "agent-m", name: "manager", agent_status: "idle", agent: "pi", ...managerIdentity };
    const children = Array.from({ length: options.callerChildren ?? 0 }, (_, index) => ({
      pane: { pane_id: `w1:c${index}`, tab_id: "w1:t1", workspace_id: "w1", label: `scout-${index}`, agent_status: "idle", tokens: { identity_provenance: "launched", identity_actor: "w1:p1", identity_session: `session-child-${index}` } },
      agent: { pane_id: `w1:c${index}`, name: `scout-${index}`, agent_status: "idle", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: `session-child-${index}` } }
    }));
    const snapshot: HerdrSnapshot = {
      ...baseSnapshot,
      panes: [callerRecord, ...(options.includeManager === false ? [] : [manager]), basePane, ...children.map((child) => child.pane)],
      agents: [callerAgent, ...(options.includeManager === false ? [] : [managerAgent]), baseSnapshot.agents[1]!, ...children.map((child) => child.agent)]
    };
    const exec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[0] === "pane" && argv[1] === "current") return execResponse("current", { type: "pane_current", pane: callerRecord });
      calls.push(argv);
      if (argv[0] === "api") return execResponse("snapshot-worker", { type: "session_snapshot", snapshot });
      if (argv[0] === "agent" && argv[1] === "get") {
        const agent = argv[2] === "w1:p2" ? { ...baseSnapshot.agents[1]! } : { ...managerAgent };
        return execResponse("agent-get", { agent: { ...agent, agent_status: state } });
      }
      if (argv[0] === "pane" && argv[1] === "get") {
        const pane = argv[2] === "w1:p2" ? { ...basePane } : { ...manager };
        return execResponse("pane-get", { pane: { ...pane, agent_status: state } });
      }
      if (argv[0] === "agent" && argv[1] === "send-keys") return execResponse("keys-1", { ok: true });
      throw new Error(`unexpected argv ${argv.join(" ")}`);
    });
    const prompt = vi.fn<AgentPromptClient["prompt"]>().mockImplementation(async (target, input) => {
      promptInputs.push(input);
      state = "working";
      const agent = target === "w1:p2" ? { ...baseSnapshot.agents[1]! } : { ...managerAgent };
      return { id: "cli:agent:prompt", result: { type: "agent_prompted", agent: { ...agent, agent_status: "working", interactive_ready: true, revision: 3, state_change_seq: 1, screen_detection_skipped: true } } };
    });
    const promptClient: AgentPromptClient = { prompt, ping: vi.fn(async () => undefined) };
    return { cli: new HerdrCli(exec, 10_000, 50_000, promptClient), calls, promptInputs, prompt };
  }

  it("lets a bound leaf worker steer its recorded manager by ID or by exact alias", async () => {
    const harness = makeWorkerCli();
    for (const target of ["w1:pM", "manager"]) {
      await expect(execute(harness.cli, { target, operation: "steer", text: "status update" })).resolves.toMatchObject({ details: { target: { paneId: "w1:pM" } } });
    }
    expect(harness.promptInputs).toEqual([senderEnvelope("steer", "status update"), senderEnvelope("steer", "status update")]);
  });

  it("marks a worker result with kind result while keeping the steer route", async () => {
    const harness = makeWorkerCli();
    const result = await execute(harness.cli, { target: "manager", operation: "steer", kind: "result", text: "Status: completed" });
    expect(harness.promptInputs[0]).toContain("kind: result");
    expect(result.details).toMatchObject({ operation: "steer", route: "steer_direct", envelope: { version: "v1", kind: "result", delivery: "inline" } });
    const promptHarness = makeWorkerCli();
    const promptResult = await execute(promptHarness.cli, { target: "w1:pM", operation: "prompt", kind: "result", text: "Status: blocked" });
    expect(promptHarness.promptInputs[0]).toContain("kind: result");
    expect(promptResult.details).toMatchObject({ envelope: { version: "v1", kind: "result" } });
  });

  it("keeps an omitted kind byte-identical to the operation envelope", async () => {
    const harness = makeWorkerCli();
    await execute(harness.cli, { target: "manager", operation: "steer", text: "plain steer" });
    expect(harness.promptInputs[0]).toBe(senderEnvelope("steer", "plain steer"));
  });

  it("denies a leaf worker's sends to a peer without touching dispatch", async () => {
    for (const operation of ["prompt", "steer"] as const) {
      const harness = makeWorkerCli();
      await expect(execute(harness.cli, { target: "reviewer", operation, text: "peer message" })).rejects.toMatchObject({ code: "TARGET_SCOPE_REJECTED", details: { phase: "caller_policy", delivery: "inline", route: `${operation}_direct`, callerPaneId: "w1:p1", targetPaneId: "w1:p2", parentPaneId: "w1:pM", operation } });
      expect(harness.calls).toEqual([["api", "snapshot"]]);
      expect(harness.prompt).not.toHaveBeenCalled();
    }
  });

  it("denies a leaf worker attachment send before any recipient lookup or publication", async () => {
    const harness = makeWorkerCli();
    const recipients = new RecipientRegistry();
    recipients.register({ paneId: "w1:p2", terminalId: "term-reviewer", agentName: "reviewer", agentKind: "pi", agentSession: targetIdentity.agent_session, recipientKey: "recipient-key", profileName: "worker-pi", kind: "pi", capable: true, reason: "read", agentId: "agent-7" });
    const publish = vi.fn(async () => { throw new Error("unreachable"); });
    const attachments = { root: "/cache", recipientDirectory: (key: string) => `/cache/${key}`, ensureRecipient: async (key: string) => fakeGrant(key), publish } as unknown as AttachmentStore;
    await expect(createCommunicateTool({ cli: harness.cli, context, attachments, recipients }).execute("id", { target: "reviewer", operation: "steer", kind: "result", text: "peer result", delivery: "attachment" }, new AbortController().signal, undefined, extensionContext))
      .rejects.toMatchObject({ code: "TARGET_SCOPE_REJECTED", details: { phase: "caller_policy", delivery: "attachment", route: "steer_direct", targetPaneId: "w1:p2", parentPaneId: "w1:pM" } });
    expect(publish).not.toHaveBeenCalled();
    expect(harness.calls).toEqual([["api", "snapshot"]]);
  });

  it("denies a leaf worker keys and turn control regardless of binding", async () => {
    const harness = makeWorkerCli();
    await expect(execute(harness.cli, { target: "manager", operation: "keys", keys: ["enter"] })).rejects.toMatchObject({ code: "TARGET_SCOPE_REJECTED", details: { phase: "caller_policy", operation: "keys", callerPaneId: "w1:p1", parentPaneId: "w1:pM" } });
    await expect(execute(harness.cli, { target: "manager", operation: "cancel" })).rejects.toMatchObject({ code: "TARGET_SCOPE_REJECTED", details: { phase: "caller_policy", callerPolicy: { operation: "cancel" } } });
    await expect(execute(harness.cli, { target: "reviewer", operation: "interrupt" })).rejects.toMatchObject({ code: "TARGET_SCOPE_REJECTED" });
    expect(harness.calls.filter((call) => call[1] === "send-keys")).toEqual([]);
  });

  it("fails closed when a launched leaf worker's binding evidence is unusable", async () => {
    const missingActor = makeWorkerCli({ tokens: { identity_provenance: "launched", identity_session: "session-worker" } });
    await expect(execute(missingActor.cli, { target: "manager", operation: "steer", text: "result" })).rejects.toMatchObject({ code: "CALLER_BINDING_UNAVAILABLE", details: { phase: "caller_policy", reason: "actor_missing" } });

    const staleActor = makeWorkerCli({ tokens: { identity_provenance: "launched", identity_actor: "w1:pGONE", identity_session: "session-worker" } });
    await expect(execute(staleActor.cli, { target: "manager", operation: "prompt", text: "result" })).rejects.toMatchObject({ code: "CALLER_BINDING_UNAVAILABLE", details: { reason: "actor_stale" } });

    const staleSession = makeWorkerCli({ tokens: { identity_provenance: "launched", identity_actor: "w1:pM", identity_session: "session-replaced" } });
    await expect(execute(staleSession.cli, { target: "manager", operation: "steer", kind: "result", text: "result" })).rejects.toMatchObject({ code: "CALLER_BINDING_UNAVAILABLE", details: { reason: "session_stale" } });
  });

  it("fails closed when a leaf worker's caller-policy evidence is contradictory", async () => {
    const harness = makeWorkerCli({ callerAgentTokens: { identity_provenance: "adopted" } });
    await expect(execute(harness.cli, { target: "manager", operation: "steer", text: "result" })).rejects.toMatchObject({ code: "CALLER_POLICY_UNAVAILABLE", details: { phase: "caller_policy", reason: "provenance_contradictory" } });
    expect(harness.prompt).not.toHaveBeenCalled();
  });

  it("leaves a launched caller unrestricted once it manages children", async () => {
    const harness = makeWorkerCli({ callerChildren: 1 });
    await expect(execute(harness.cli, { target: "reviewer", operation: "steer", text: "manager can reach anyone" })).resolves.toMatchObject({ details: { target: { paneId: "w1:p2" } } });
  });

  it("publishes a result attachment with kind result while the store keeps the operation", async () => {
    const harness = makeWorkerCli();
    const recipients = new RecipientRegistry();
    recipients.register({ paneId: "w1:pM", terminalId: "term-manager", agentName: "manager", agentKind: "pi", agentSession: managerIdentity.agent_session, recipientKey: "manager-key", profileName: "manager-pi", kind: "pi", capable: true, reason: "read", agentId: "agent-m" });
    const publish = vi.fn(async () => ({ attachmentId: "attachment-1", path: "/cache/manager-key/attachment-1/body.txt", bytes: 20, sha256: "a".repeat(64), expiresAt: "2026-08-21T12:00:00.000Z", recipientPaneId: "w1:pM" }));
    const attachments = { root: "/cache", recipientDirectory: (key: string) => `/cache/${key}`, ensureRecipient: async (key: string) => fakeGrant(key), publish } as unknown as AttachmentStore;
    const result = await createCommunicateTool({ cli: harness.cli, context, attachments, recipients }).execute("id", { target: "manager", operation: "steer", kind: "result", text: "Status: completed", delivery: "attachment" }, new AbortController().signal, undefined, extensionContext);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ operation: "steer" }));
    expect(harness.promptInputs[0]).toContain("kind: result");
    expect(harness.promptInputs[0]).toContain("delivery: attachment");
    expect(result.details).toMatchObject({ envelope: { version: "v1", kind: "result", delivery: "attachment" } });
  });
});
