import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HerdrCli, type PiExec } from "../../src/cli.js";
import { resetOwnership, runtimeOwnership } from "../../src/ownership.js";
import { createPaneTool } from "../../src/tools/pane.js";
import type { HerdrSnapshot, PaneRecord } from "../../src/targets.js";

const context = { workspaceId: "w1", tabId: "t1", paneId: "p1" };
const basePane = (id: string, tabId = "t1", label = id): PaneRecord => ({ pane_id: id, tab_id: tabId, workspace_id: "w1", label, agent_status: "idle" });

function fixture(): HerdrSnapshot {
  return {
    version: "1",
    protocol: 1,
    workspaces: [{ workspace_id: "w1", label: "workspace" }],
    tabs: [
      { tab_id: "t1", workspace_id: "w1", label: "main", focused: true },
      { tab_id: "t2", workspace_id: "w1", label: "secondary" }
    ],
    panes: [basePane("p1", "t1", "caller"), basePane("p2", "t1", "worker")],
    agents: []
  };
}

interface Harness {
  cli: HerdrCli;
  calls: string[][];
  snapshot: HerdrSnapshot;
  confirm: ReturnType<typeof vi.fn>;
  ctx: ExtensionContext;
}

function makeHarness(): Harness {
  const snapshot = fixture();
  let nextPane = 3;
  let focusedPaneId = "p1";
  const calls: string[][] = [];
  const confirm = vi.fn().mockResolvedValue(true);
  const response = (id: string, result: unknown) => ({ stdout: JSON.stringify({ id, result }), stderr: "", code: 0, killed: false });
  const exec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
    calls.push(argv);
    if (argv[0] === "api" && argv[1] === "snapshot") return response("snapshot", { type: "session_snapshot", snapshot });
    if (argv[0] === "pane" && argv[1] === "split") {
      const id = `p${nextPane++}`;
      snapshot.panes.push({ ...basePane(id), label: undefined });
      return response("split", { pane: { pane_id: id } });
    }
    if (argv[0] === "pane" && argv[1] === "rename") {
      const pane = snapshot.panes.find((item) => item.pane_id === argv[2]);
      if (pane) pane.label = argv[3];
      return response("rename", { ok: true });
    }
    if (argv[0] === "pane" && argv[1] === "get") {
      const pane = snapshot.panes.find((item) => item.pane_id === argv[2]);
      return response("get", { pane: pane ? { ...pane, environment: { SECRET: "do-not-leak" }, environment_overrides: { SNAKE_SECRET: "do-not-leak-snake" } } : null });
    }
    if (argv[0] === "pane" && argv[1] === "layout") {
      return response("layout", { layout: { tab_id: "t1", focused_pane_id: focusedPaneId, panes: [
        { pane_id: "p1", rect: { x: 0, y: 0, width: 50, height: 100 } },
        { pane_id: "p2", rect: { x: 50, y: 0, width: 50, height: 100 } }
      ] } });
    }
    if (argv[0] === "pane" && argv[1] === "focus") {
      focusedPaneId = argv[2] === "--direction" ? (argv[5] === "p1" ? "p2" : "p1") : "p2";
      return response("focus", { ok: true });
    }
    if (argv[0] === "pane" && argv[1] === "move") {
      const pane = snapshot.panes.find((item) => item.pane_id === argv[2]);
      const tabIndex = argv.indexOf("--tab");
      if (pane && tabIndex >= 0) pane.tab_id = argv[tabIndex + 1];
      const result: Record<string, unknown> = { pane: { pane_id: argv[2] } };
      if (argv.includes("--new-tab")) {
        snapshot.tabs.push({ tab_id: "t-new", workspace_id: "w1", label: argv[argv.indexOf("--label") + 1] });
        if (pane) pane.tab_id = "t-new";
        result.tab = { tab_id: "t-new" };
      }
      return response("move", result);
    }
    if (argv[0] === "pane" && argv[1] === "close") {
      snapshot.panes = snapshot.panes.filter((item) => item.pane_id !== argv[2]);
      return response("close", { ok: true });
    }
    if (argv[0] === "pane" && ["resize", "swap", "zoom"].includes(argv[1])) return response(argv[1], { ok: true });
    throw new Error(`unexpected argv ${argv.join(" ")}`);
  });
  const cli = new HerdrCli(exec);
  const ctx = { hasUI: true, cwd: "/repo", signal: undefined, ui: { confirm } } as unknown as ExtensionContext;
  return { cli, calls, snapshot, confirm, ctx };
}

function execute(harness: Harness, params: Record<string, unknown>, overrides: Partial<ExtensionContext> = {}) {
  const tool = createPaneTool({ cli: harness.cli, context, cwd: "/cwd" });
  return tool.execute("call", params as never, new AbortController().signal, undefined, { ...harness.ctx, ...overrides } as ExtensionContext);
}

afterEach(() => resetOwnership());

describe("herdr_pane", () => {
  it("splits right without focusing and uses the returned opaque ID for rename and post-read", async () => {
    const harness = makeHarness();
    const result = await execute(harness, { operation: "split", label: "new pane" });
    expect(result.details).toMatchObject({ operation: "split", paneId: "p3", tabId: "t1", workspaceId: "w1" });
    expect(harness.calls).toContainEqual(["pane", "split", "p1", "--direction", "right", "--cwd", "/cwd", "--no-focus"]);
    expect(harness.calls).toContainEqual(["pane", "rename", "p3", "new pane"]);
    expect(harness.calls).toContainEqual(["pane", "get", "p3"]);
  });

  it("prioritizes an exact agent ID over a conflicting pane label for pane mutations", async () => {
    const harness = makeHarness();
    harness.snapshot.panes[0]!.label = "agent-7";
    harness.snapshot.agents.push({ pane_id: "p2", agent_id: "agent-7", name: "worker" });
    await expect(execute(harness, { operation: "rename", target: "agent-7", label: "renamed" })).resolves.toMatchObject({ details: { paneId: "p2" } });
    expect(harness.calls).toContainEqual(["pane", "rename", "p2", "renamed"]);
  });

  it("honors down/focus/cwd/env and never echoes environment values", async () => {
    const harness = makeHarness();
    const result = await execute(harness, { operation: "split", label: "secret child", direction: "down", focus: true, cwd: "/tmp", env: { CUSTOM: "secret-value", EMPTY: "" } });
    expect(harness.calls).toContainEqual(["pane", "split", "p1", "--direction", "down", "--cwd", "/tmp", "--focus", "--env", "CUSTOM=secret-value", "--env", "EMPTY="]);
    expect(JSON.stringify(result)).not.toContain("secret-value");
    expect(JSON.stringify(result)).not.toContain("do-not-leak");
  });

  it("validates labels, environment transport, finite resize, and exact tab destinations before mutation", async () => {
    const harness = makeHarness();
    await expect(execute(harness, { operation: "split", label: "" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(execute(harness, { operation: "split", label: "x", env: { BAD: "x\n" } })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(execute(harness, { operation: "resize", target: "p2", direction: "right", amount: Number.NaN })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(execute(harness, { operation: "move", target: "p2", destination: { kind: "tab", target: "secondary" } })).rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });
    expect(harness.calls.filter((call) => call[1] === "split" || call[1] === "move" || call[1] === "resize")).toHaveLength(0);
  });

  it("renames, resizes, swaps by explicit target or direction, zooms, and moves to an existing tab", async () => {
    const harness = makeHarness();
    await expect(execute(harness, { operation: "rename", target: "worker", label: "renamed" })).resolves.toMatchObject({ details: { paneId: "p2" } });
    await expect(execute(harness, { operation: "resize", target: "p2", direction: "left", amount: 1.5 })).resolves.toMatchObject({ details: { operation: "resize" } });
    await expect(execute(harness, { operation: "swap", source: "p1", with: "right" })).resolves.toMatchObject({ details: { operation: "swap" } });
    await expect(execute(harness, { operation: "swap", source: "p1", with: "p2" })).resolves.toMatchObject({ details: { operation: "swap" } });
    await expect(execute(harness, { operation: "zoom", mode: "toggle" })).resolves.toMatchObject({ details: { operation: "zoom" } });
    await expect(execute(harness, { operation: "move", target: "p2", destination: { kind: "tab", target: "t2" }, direction: "down", focus: true })).resolves.toMatchObject({ details: { paneId: "p2", tabId: "t2" } });
    expect(harness.calls).toContainEqual(["pane", "move", "p2", "--tab", "t2", "--split", "down", "--focus"]);
  });

  it("focuses an exact pane through authoritative layout reads, not UI focus guessing", async () => {
    const harness = makeHarness();
    const result = await execute(harness, { operation: "focus", target: "p2" });
    expect(result.details).toMatchObject({ operation: "focus", paneId: "p2" });
    expect(harness.calls.some((call) => call[0] === "pane" && call[1] === "focus" && call.includes("p1"))).toBe(true);
    expect(harness.calls.filter((call) => call[1] === "layout").length).toBeGreaterThan(0);
  });

  it("creates and closes only owned non-caller panes, confirms mixed/unowned panes, and fails closed without UI", async () => {
    const harness = makeHarness();
    const created = await execute(harness, { operation: "split", label: "owned" });
    const ownedId = created.details.paneId as string;
    expect(runtimeOwnership.has({ kind: "pane", id: ownedId })).toBe(true);
    await expect(execute(harness, { operation: "close", target: ownedId }, { hasUI: false })).resolves.toMatchObject({ details: { operation: "close", removedIds: [ownedId] } });
    await expect(execute(harness, { operation: "close", target: "p2" }, { hasUI: false })).rejects.toMatchObject({ code: "CONFIRMATION_UNAVAILABLE" });
    expect(harness.calls.some((call) => call[1] === "close" && call[2] === "p2")).toBe(false);
    await expect(execute(harness, { operation: "close", target: "p2" })).resolves.toMatchObject({ details: { operation: "close", paneId: "p2" } });
    expect(harness.confirm).toHaveBeenCalled();
  });

  it("uses all authoritative split response shapes and explicit topology variants", async () => {
    for (const responseShape of [
      { split_result: { pane: { pane_id: "p3" } } },
      { move_result: { pane: { pane_id: "p3" } } },
      { pane: { pane_id: "p3" } },
    ]) {
      const harness = makeHarness();
      harness.cli = new HerdrCli(vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
        harness.calls.push(argv);
        if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { type: "session_snapshot", snapshot: harness.snapshot } }), stderr: "", code: 0, killed: false };
        if (argv[0] === "pane" && argv[1] === "split") return { stdout: JSON.stringify({ id: "split", result: responseShape }), stderr: "", code: 0, killed: false };
        if (argv[0] === "pane" && argv[1] === "rename") return { stdout: JSON.stringify({ id: "rename", result: {} }), stderr: "", code: 0, killed: false };
        if (argv[0] === "pane" && argv[1] === "get") return { stdout: JSON.stringify({ id: "get", result: { pane: { pane_id: "p3", tab_id: "t1", workspace_id: "w1", label: "new", environment: { SECRET: "hidden" } } } }), stderr: "", code: 0, killed: false };
        throw new Error(`unexpected argv ${argv.join(" ")}`);
      }));
      await expect(execute(harness, { operation: "split", label: "new" })).resolves.toMatchObject({ details: { paneId: "p3" } });
    }
    await expect(execute(makeHarness(), { operation: "zoom", target: "p2", mode: "on" })).resolves.toMatchObject({ details: { operation: "zoom" } });
    await expect(execute(makeHarness(), { operation: "zoom", target: "p2", mode: "off" })).resolves.toMatchObject({ details: { operation: "zoom" } });
    await expect(execute(makeHarness(), { operation: "zoom", target: "p2" })).resolves.toMatchObject({ details: { operation: "zoom" } });
  });

  it("moves to a returned new tab and resolves agent-only exact names", async () => {
    const harness = makeHarness();
    runtimeOwnership.record({ kind: "pane", id: "p2", parentId: "t1" });
    harness.snapshot.agents.push({ pane_id: "p2", name: "agent-only" });
    await expect(execute(harness, { operation: "move", target: "agent-only", destination: { kind: "new_tab", label: "moved" } })).resolves.toMatchObject({ details: { operation: "move", paneId: "p2", tabId: "t-new" } });
    expect(runtimeOwnership.has({ kind: "tab", id: "t-new" })).toBe(true);
    await expect(execute(harness, { operation: "move", target: "p2", destination: { kind: "tab", target: "current" } })).resolves.toMatchObject({ details: { operation: "move", paneId: "p2", tabId: "t1" } });
    expect(harness.calls).toContainEqual(["pane", "move", "p2", "--new-tab", "--workspace", "w1", "--label", "moved", "--no-focus"]);
    const transferred = makeHarness();
    runtimeOwnership.record({ kind: "pane", id: "p2", parentId: "t1" });
    const base = transferred.cli.runJson.bind(transferred.cli);
    transferred.cli.runJson = vi.fn<HerdrCli["runJson"]>(async (argv, signal) => {
      if (argv[0] === "pane" && argv[1] === "move") return { id: "move", result: { pane: { pane_id: "p9" } } };
      if (argv[0] === "pane" && argv[1] === "get") return { id: "get", result: { pane: { pane_id: "p9", tab_id: "t2", workspace_id: "w1" } } };
      return base(argv, signal);
    });
    await expect(execute(transferred, { operation: "move", target: "p2", destination: { kind: "tab", target: "t2" } })).resolves.toMatchObject({ details: { paneId: "p9" } });
    expect(runtimeOwnership.has({ kind: "pane", id: "p9" })).toBe(true);
  });

  it("creates moved tabs in the caller workspace even for cross-workspace sources", async () => {
    const harness = makeHarness();
    harness.snapshot.workspaces.push({ workspace_id: "w2", label: "other workspace" });
    harness.snapshot.tabs.push({ tab_id: "t3", workspace_id: "w2", label: "source" });
    harness.snapshot.panes.push({ ...basePane("p-cross", "t3", "cross-workspace"), workspace_id: "w2" });
    const base = harness.cli.runJson.bind(harness.cli);
    harness.cli.runJson = vi.fn<HerdrCli["runJson"]>(async (argv, signal) => {
      harness.calls.push(argv);
      if (argv[0] === "pane" && argv[1] === "move") {
        expect(argv).toContainEqual("--workspace");
        expect(argv[argv.indexOf("--workspace") + 1]).toBe("w1");
        harness.snapshot.tabs.push({ tab_id: "t-new-cross", workspace_id: "w1", label: "moved" });
        const pane = harness.snapshot.panes.find((item) => item.pane_id === "p-cross");
        if (pane) {
          pane.tab_id = "t-new-cross";
          pane.workspace_id = "w1";
        }
        return { id: "move", result: { pane: { pane_id: "p-cross" }, tab: { tab_id: "t-new-cross" } } };
      }
      return base(argv, signal);
    });
    await expect(execute(harness, { operation: "move", target: "p-cross", destination: { kind: "new_tab", label: "moved" } })).resolves.toMatchObject({
      details: { paneId: "p-cross", tabId: "t-new-cross", workspaceId: "w1" }
    });
    expect(harness.calls).toContainEqual(["pane", "move", "p-cross", "--new-tab", "--workspace", "w1", "--label", "moved", "--no-focus"]);
  });

  it("covers authoritative parser failures and every focus direction", async () => {
    const malformed = makeHarness();
    malformed.cli = new HerdrCli(vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { type: "session_snapshot", snapshot: malformed.snapshot } }), stderr: "", code: 0, killed: false };
      if (argv[0] === "pane" && argv[1] === "rename") return { stdout: JSON.stringify({ id: "rename", result: {} }), stderr: "", code: 0, killed: false };
      if (argv[0] === "pane" && argv[1] === "get") return { stdout: JSON.stringify({ id: "get", result: null }), stderr: "", code: 0, killed: false };
      throw new Error(`unexpected argv ${argv.join(" ")}`);
    }));
    await expect(execute(malformed, { operation: "rename", target: "p2", label: "x" })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    const missingField = makeHarness();
    const missingExec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { type: "session_snapshot", snapshot: missingField.snapshot } }), stderr: "", code: 0, killed: false };
      if (argv[0] === "pane" && argv[1] === "rename") return { stdout: JSON.stringify({ id: "rename", result: {} }), stderr: "", code: 0, killed: false };
      return { stdout: JSON.stringify({ id: "get", result: { pane: { pane_id: "p2", tab_id: "t1" } } }), stderr: "", code: 0, killed: false };
    });
    await expect(createPaneTool({ cli: new HerdrCli(missingExec), context }).execute("id", { operation: "rename", target: "p2", label: "x" } as never, new AbortController().signal, undefined, missingField.ctx)).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    const invalidLayout = makeHarness();
    invalidLayout.cli = new HerdrCli(vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { type: "session_snapshot", snapshot: invalidLayout.snapshot } }), stderr: "", code: 0, killed: false };
      return { stdout: JSON.stringify({ id: "layout", result: null }), stderr: "", code: 0, killed: false };
    }));
    await expect(execute(invalidLayout, { operation: "focus", target: "p2" })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    const badShape = makeHarness();
    const badShapeExec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { type: "session_snapshot", snapshot: badShape.snapshot } }), stderr: "", code: 0, killed: false };
      if (argv[0] === "pane" && argv[1] === "layout") return { stdout: JSON.stringify({ id: "layout", result: { layout: { tab_id: "t1", focused_pane_id: "p1", panes: [{ pane_id: "p1", rect: null }] } } }), stderr: "", code: 0, killed: false };
      throw new Error(`unexpected argv ${argv.join(" ")}`);
    });
    await expect(createPaneTool({ cli: new HerdrCli(badShapeExec), context }).execute("id", { operation: "focus", target: "p2" } as never, new AbortController().signal, undefined, badShape.ctx)).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    const badLayoutShape = makeHarness();
    const badLayoutExec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { type: "session_snapshot", snapshot: badLayoutShape.snapshot } }), stderr: "", code: 0, killed: false };
      if (argv[0] === "pane" && argv[1] === "layout") return { stdout: JSON.stringify({ id: "layout", result: { layout: { tab_id: 1, focused_pane_id: "p1", panes: [] } } }), stderr: "", code: 0, killed: false };
      throw new Error(`unexpected argv ${argv.join(" ")}`);
    });
    await expect(createPaneTool({ cli: new HerdrCli(badLayoutExec), context }).execute("id", { operation: "focus", target: "p2" } as never, new AbortController().signal, undefined, badLayoutShape.ctx)).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    const badRectExec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { type: "session_snapshot", snapshot: badLayoutShape.snapshot } }), stderr: "", code: 0, killed: false };
      if (argv[0] === "pane" && argv[1] === "layout") return { stdout: JSON.stringify({ id: "layout", result: { layout: { tab_id: "t1", focused_pane_id: "p1", panes: [{ pane_id: "p1", rect: { x: "bad", y: 0, width: 1, height: 1 } }] } } }), stderr: "", code: 0, killed: false };
      throw new Error(`unexpected argv ${argv.join(" ")}`);
    });
    await expect(createPaneTool({ cli: new HerdrCli(badRectExec), context }).execute("id", { operation: "focus", target: "p2" } as never, new AbortController().signal, undefined, badLayoutShape.ctx)).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    await expect(createPaneTool({ cli: invalidLayout.cli, context: {} }).execute("id", { operation: "split", label: "x" } as never, new AbortController().signal, undefined, invalidLayout.ctx)).rejects.toMatchObject({ code: "CONTEXT_UNAVAILABLE" });
    await expect(createPaneTool({ cli: invalidLayout.cli, context: { workspaceId: "wrong", tabId: "t1", paneId: "p1" } }).execute("id", { operation: "split", label: "x" } as never, new AbortController().signal, undefined, invalidLayout.ctx)).rejects.toMatchObject({ code: "CONTEXT_UNAVAILABLE" });
    await expect(execute(invalidLayout, { operation: "move", target: "t1", destination: { kind: "tab", target: "t2" } })).rejects.toMatchObject({ code: "TARGET_TYPE_MISMATCH" });

    const focusCase = async (rects: Array<{ pane_id: string; rect: { x: number; y: number; width: number; height: number } }>, expectedFailure = false, differentTab = false) => {
      const harness = makeHarness();
      if (differentTab) {
        harness.snapshot.tabs.push({ tab_id: "t3", workspace_id: "w1", label: "other" });
        harness.snapshot.panes[1]!.tab_id = "t3";
      }
      let focused = "p1";
      const exec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
        if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { type: "session_snapshot", snapshot: harness.snapshot } }), stderr: "", code: 0, killed: false };
        if (argv[0] === "pane" && argv[1] === "layout") return { stdout: JSON.stringify({ id: "layout", result: { layout: { tab_id: "t1", focused_pane_id: focused, panes: rects } } }), stderr: "", code: 0, killed: false };
        if (argv[0] === "tab" && argv[1] === "focus") return { stdout: JSON.stringify({ id: "tab-focus", result: {} }), stderr: "", code: 0, killed: false };
        if (argv[0] === "pane" && argv[1] === "focus") { focused = "p2"; return { stdout: JSON.stringify({ id: "focus", result: {} }), stderr: "", code: 0, killed: false }; }
        if (argv[0] === "pane" && argv[1] === "get") return { stdout: JSON.stringify({ id: "get", result: { pane: { pane_id: "p2", tab_id: "t1", workspace_id: "w1" } } }), stderr: "", code: 0, killed: false };
        throw new Error(`unexpected argv ${argv.join(" ")}`);
      });
      const promise = createPaneTool({ cli: new HerdrCli(exec), context }).execute("id", { operation: "focus", target: "p2" } as never, new AbortController().signal, undefined, malformed.ctx);
      if (expectedFailure) await expect(promise).rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });
      else await expect(promise).resolves.toMatchObject({ details: { paneId: "p2" } });
    };
    await focusCase([{ pane_id: "p1", rect: { x: 0, y: 0, width: 10, height: 10 } }, { pane_id: "p2", rect: { x: 10, y: 0, width: 10, height: 10 } }]);
    await focusCase([{ pane_id: "p1", rect: { x: 10, y: 0, width: 10, height: 10 } }, { pane_id: "p2", rect: { x: 0, y: 0, width: 10, height: 10 } }]);
    await focusCase([{ pane_id: "p1", rect: { x: 0, y: 0, width: 10, height: 10 } }, { pane_id: "p2", rect: { x: 0, y: 10, width: 10, height: 10 } }]);
    await focusCase([{ pane_id: "p1", rect: { x: 0, y: 10, width: 10, height: 10 } }, { pane_id: "p2", rect: { x: 0, y: 0, width: 10, height: 10 } }]);
    await focusCase([{ pane_id: "p1", rect: { x: 0, y: 0, width: 10, height: 10 } }, { pane_id: "p2", rect: { x: 5, y: 5, width: 10, height: 10 } }]);
    await focusCase([{ pane_id: "p1", rect: { x: 0, y: 0, width: 100, height: 10 } }, { pane_id: "p2", rect: { x: 50, y: 1, width: 10, height: 100 } }]);
    await focusCase([{ pane_id: "p1", rect: { x: 0, y: 0, width: 100, height: 100 } }, { pane_id: "p2", rect: { x: -50, y: 0, width: 100, height: 100 } }]);
    await focusCase([{ pane_id: "p1", rect: { x: 0, y: 100, width: 100, height: 100 } }, { pane_id: "p2", rect: { x: 50, y: 50, width: 10, height: 100 } }]);
    await focusCase([{ pane_id: "p2", rect: { x: 5, y: 5, width: 10, height: 10 } }], true);
    await focusCase([{ pane_id: "p1", rect: { x: 0, y: 0, width: 10, height: 10 } }, { pane_id: "p2", rect: { x: 5, y: 5, width: 10, height: 10 } }], false, true);
  });

  it("rejects declined confirmation and contradictory close post-state", async () => {
    const declined = makeHarness();
    declined.confirm.mockResolvedValueOnce(false);
    await expect(execute(declined, { operation: "close", target: "p2" })).rejects.toMatchObject({ code: "CONFIRMATION_DECLINED" });
    const contradictory = makeHarness();
    const base = contradictory.cli.runJson.bind(contradictory.cli);
    contradictory.cli.runJson = vi.fn<HerdrCli["runJson"]>(async (argv, signal) => {
      if (argv[0] === "pane" && argv[1] === "close") return { id: "close", result: {} };
      return base(argv, signal);
    });
    await expect(execute(contradictory, { operation: "close", target: "p2" })).rejects.toMatchObject({ code: "POSTSTATE_UNAVAILABLE" });
  });

  it("protects the caller pane from close and fails closed on malformed create responses", async () => {
    const harness = makeHarness();
    await expect(execute(harness, { operation: "close", target: "current" })).rejects.toMatchObject({ code: "PROTECTED_RESOURCE" });
    expect(harness.calls.some((call) => call[1] === "close")).toBe(false);
    const badExec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { type: "session_snapshot", snapshot: harness.snapshot } }), stderr: "", code: 0, killed: false };
      return { stdout: JSON.stringify({ id: "split", result: { ok: true } }), stderr: "", code: 0, killed: false };
    });
    await expect(createPaneTool({ cli: new HerdrCli(badExec), context }).execute("id", { operation: "split", label: "x" }, new AbortController().signal, undefined, harness.ctx)).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
  });

  it("covers direct CLI records, defaults, and optional signal paths", async () => {
    const direct = makeHarness();
    const base = direct.cli.runJson.bind(direct.cli);
    direct.cli.runJson = vi.fn<HerdrCli["runJson"]>(async (argv, signal) => {
      if (argv[0] === "pane" && argv[1] === "get") return { id: "get", result: { pane_id: "p2", tab_id: "t1", workspace_id: "w1", environment: { SECRET: "hidden" } } };
      if (argv[0] === "pane" && argv[1] === "layout") return { id: "layout", result: { tab_id: "t1", focused_pane_id: "p2", panes: [] } };
      return base(argv, signal);
    });
    await expect(createPaneTool({ cli: direct.cli, context }).execute("id", { operation: "rename", target: "p2", label: "direct" } as never, undefined, undefined, direct.ctx)).resolves.toMatchObject({ details: { paneId: "p2" } });
    await expect(createPaneTool({ cli: direct.cli, context }).execute("id", { operation: "focus", target: "p2" } as never, undefined, undefined, direct.ctx)).resolves.toMatchObject({ details: { paneId: "p2" } });
    direct.snapshot.panes[1]!.parent_id = "p2-parent";
    await expect(execute(direct, { operation: "close", target: "p2" })).resolves.toMatchObject({ details: { operation: "close" } });

  });

  it("renders compact calls and results without raw topology", () => {
    const harness = makeHarness();
    const tool = createPaneTool({ cli: harness.cli, context });
    const call = tool.renderCall?.({ operation: "rename", target: "p2", label: "x" } as never, {} as never, {} as never);
    expect(call?.render(80)).toEqual(["herdr_pane · rename · p2"]);
    const splitCall = tool.renderCall?.({ operation: "split", label: "x" } as never, {} as never, {} as never);
    expect(splitCall?.render(80)).toEqual(["herdr_pane · split"]);
    splitCall?.invalidate();
    const swapCall = tool.renderCall?.({ operation: "swap", source: "p1", with: "right" } as never, {} as never, {} as never);
    expect(swapCall?.render(80)).toEqual(["herdr_pane · swap · p1"]);
    swapCall?.invalidate();
    call?.invalidate();
    const result = tool.renderResult?.({ content: [], details: { operation: "rename", outcome: "success", paneId: "p2" } } as never, { expanded: false, isPartial: false } as never, {} as never, { isError: false } as never);
    expect(result?.render(80)).toEqual(["pane · p2"]);
    result?.invalidate();
  });
});
