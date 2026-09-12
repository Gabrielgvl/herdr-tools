import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HerdrCli, type PiExec } from "../../src/cli.js";
import { resetOwnership, runtimeOwnership } from "../../src/ownership.js";
import { createSelfCloseTracker } from "../../src/supervision/self-close.js";
import { createPaneTool as createPaneToolImplementation, type PaneDependencies } from "../../src/tools/pane.js";
import type { HerdrSnapshot, PaneRecord } from "../../src/targets.js";

const testPreflight = async () => undefined;
const createPaneTool = (deps: Omit<PaneDependencies, "preflight"> & Partial<Pick<PaneDependencies, "preflight">>) => createPaneToolImplementation({ ...deps, preflight: deps.preflight ?? testPreflight });

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
    if (argv[0] === "pane" && argv[1] === "current") return response("current", { type: "pane_current", pane: snapshot.panes.find((item) => item.pane_id === context.paneId) });
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
      return response("get", { pane: pane ? { ...pane, environment: { SECRET: "do-not-leak" }, environment_overrides: { SNAKE_SECRET: "do-not-leak-snake" }, history: [{ env: { ARRAY_SECRET: "do-not-leak-array" } }] } : null });
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
    if (argv[0] === "agent" && argv[1] === "rename") {
      const agent = snapshot.agents.find((item) => item.pane_id === argv[2]);
      if (!agent) return { stdout: JSON.stringify({ id: "rename", error: { code: "agent_not_found", message: "no agent" } }), stderr: "", code: 1, killed: false };
      const name = argv[3]!;
      const taken = snapshot.agents.some((item) => item.pane_id !== argv[2] && item.name === name)
        || snapshot.panes.some((item) => item.pane_id !== argv[2] && item.agent_name === name);
      if (taken) return { stdout: "", stderr: JSON.stringify({ id: "rename", error: { code: "agent_name_taken", message: "name taken" } }), code: 1, killed: false };
      agent.name = name;
      const pane = snapshot.panes.find((item) => item.pane_id === argv[2]);
      if (pane) pane.agent_name = name;
      return response("rename", { type: "agent_info", agent });
    }
    if (argv[0] === "agent" && argv[1] === "get") {
      return response("get", { agent: snapshot.agents.find((item) => item.pane_id === argv[2]) ?? null });
    }
    if (argv[0] === "pane" && argv[1] === "report-metadata") return response("metadata", { ok: true });
    if (argv[0] === "pane" && ["resize", "swap", "zoom"].includes(argv[1])) return response(argv[1], { ok: true });
    throw new Error(`unexpected argv ${argv.join(" ")}`);
  });
  const cli = new HerdrCli(exec);
  const ctx = { hasUI: true, cwd: "/repo", signal: undefined, ui: { confirm } } as unknown as ExtensionContext;
  return { cli, calls, snapshot, confirm, ctx };
}

function execute(harness: Harness, params: Record<string, unknown>, overrides: Partial<ExtensionContext> = {}, signal: AbortSignal = new AbortController().signal, selfClose?: PaneDependencies["selfClose"]) {
  const tool = createPaneTool({ cli: harness.cli, context, cwd: "/cwd", ...(selfClose ? { selfClose } : {}) });
  return tool.execute("call", params as never, signal, undefined, { ...harness.ctx, ...overrides } as ExtensionContext);
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

  it("closes owned and unowned exact non-caller panes autonomously without UI", async () => {
    const harness = makeHarness();
    const created = await execute(harness, { operation: "split", label: "owned" });
    const ownedId = created.details.paneId as string;
    expect(runtimeOwnership.has({ kind: "pane", id: ownedId })).toBe(true);
    await expect(execute(harness, { operation: "close", target: ownedId }, { hasUI: false })).resolves.toMatchObject({ details: { operation: "close", outcome: "success", removedIds: [ownedId], operationId: "close", postState: { paneCount: 2 } } });
    await expect(execute(harness, { operation: "close", target: "p2" }, { hasUI: false })).resolves.toMatchObject({ details: { operation: "close", paneId: "p2", outcome: "success", operationId: "close" } });
    expect(harness.confirm).not.toHaveBeenCalled();
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
        if (argv[0] === "pane" && argv[1] === "current") return { stdout: JSON.stringify({ id: "current", result: { type: "pane_current", pane: harness.snapshot.panes[0] } }), stderr: "", code: 0, killed: false };
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
      if (argv[0] === "pane" && argv[1] === "current") return { stdout: JSON.stringify({ id: "current", result: { type: "pane_current", pane: malformed.snapshot.panes[0] } }), stderr: "", code: 0, killed: false };
      if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { type: "session_snapshot", snapshot: malformed.snapshot } }), stderr: "", code: 0, killed: false };
      if (argv[0] === "pane" && argv[1] === "rename") return { stdout: JSON.stringify({ id: "rename", result: {} }), stderr: "", code: 0, killed: false };
      if (argv[0] === "pane" && argv[1] === "get") return { stdout: JSON.stringify({ id: "get", result: null }), stderr: "", code: 0, killed: false };
      throw new Error(`unexpected argv ${argv.join(" ")}`);
    }));
    await expect(execute(malformed, { operation: "rename", target: "p2", label: "x" })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    const missingField = makeHarness();
    const missingExec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[0] === "pane" && argv[1] === "current") return { stdout: JSON.stringify({ id: "current", result: { type: "pane_current", pane: missingField.snapshot.panes[0] } }), stderr: "", code: 0, killed: false };
      if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { type: "session_snapshot", snapshot: missingField.snapshot } }), stderr: "", code: 0, killed: false };
      if (argv[0] === "pane" && argv[1] === "rename") return { stdout: JSON.stringify({ id: "rename", result: {} }), stderr: "", code: 0, killed: false };
      return { stdout: JSON.stringify({ id: "get", result: { pane: { pane_id: "p2", tab_id: "t1" } } }), stderr: "", code: 0, killed: false };
    });
    await expect(createPaneTool({ cli: new HerdrCli(missingExec), context }).execute("id", { operation: "rename", target: "p2", label: "x" } as never, new AbortController().signal, undefined, missingField.ctx)).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    const invalidLayout = makeHarness();
    invalidLayout.cli = new HerdrCli(vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[0] === "pane" && argv[1] === "current") return { stdout: JSON.stringify({ id: "current", result: { type: "pane_current", pane: invalidLayout.snapshot.panes[0] } }), stderr: "", code: 0, killed: false };
      if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { type: "session_snapshot", snapshot: invalidLayout.snapshot } }), stderr: "", code: 0, killed: false };
      return { stdout: JSON.stringify({ id: "layout", result: null }), stderr: "", code: 0, killed: false };
    }));
    await expect(execute(invalidLayout, { operation: "focus", target: "p2" })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    const badShape = makeHarness();
    const badShapeExec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[0] === "pane" && argv[1] === "current") return { stdout: JSON.stringify({ id: "current", result: { type: "pane_current", pane: badShape.snapshot.panes[0] } }), stderr: "", code: 0, killed: false };
      if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { type: "session_snapshot", snapshot: badShape.snapshot } }), stderr: "", code: 0, killed: false };
      if (argv[0] === "pane" && argv[1] === "layout") return { stdout: JSON.stringify({ id: "layout", result: { layout: { tab_id: "t1", focused_pane_id: "p1", panes: [{ pane_id: "p1", rect: null }] } } }), stderr: "", code: 0, killed: false };
      throw new Error(`unexpected argv ${argv.join(" ")}`);
    });
    await expect(createPaneTool({ cli: new HerdrCli(badShapeExec), context }).execute("id", { operation: "focus", target: "p2" } as never, new AbortController().signal, undefined, badShape.ctx)).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    const badLayoutShape = makeHarness();
    const badLayoutExec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[0] === "pane" && argv[1] === "current") return { stdout: JSON.stringify({ id: "current", result: { type: "pane_current", pane: badLayoutShape.snapshot.panes[0] } }), stderr: "", code: 0, killed: false };
      if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { type: "session_snapshot", snapshot: badLayoutShape.snapshot } }), stderr: "", code: 0, killed: false };
      if (argv[0] === "pane" && argv[1] === "layout") return { stdout: JSON.stringify({ id: "layout", result: { layout: { tab_id: 1, focused_pane_id: "p1", panes: [] } } }), stderr: "", code: 0, killed: false };
      throw new Error(`unexpected argv ${argv.join(" ")}`);
    });
    await expect(createPaneTool({ cli: new HerdrCli(badLayoutExec), context }).execute("id", { operation: "focus", target: "p2" } as never, new AbortController().signal, undefined, badLayoutShape.ctx)).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    const badRectExec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[0] === "pane" && argv[1] === "current") return { stdout: JSON.stringify({ id: "current", result: { type: "pane_current", pane: badLayoutShape.snapshot.panes[0] } }), stderr: "", code: 0, killed: false };
      if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { type: "session_snapshot", snapshot: badLayoutShape.snapshot } }), stderr: "", code: 0, killed: false };
      if (argv[0] === "pane" && argv[1] === "layout") return { stdout: JSON.stringify({ id: "layout", result: { layout: { tab_id: "t1", focused_pane_id: "p1", panes: [{ pane_id: "p1", rect: { x: "bad", y: 0, width: 1, height: 1 } }] } } }), stderr: "", code: 0, killed: false };
      throw new Error(`unexpected argv ${argv.join(" ")}`);
    });
    await expect(createPaneTool({ cli: new HerdrCli(badRectExec), context }).execute("id", { operation: "focus", target: "p2" } as never, new AbortController().signal, undefined, badLayoutShape.ctx)).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    await expect(createPaneTool({ cli: invalidLayout.cli, context: {} }).execute("id", { operation: "split", label: "x" } as never, new AbortController().signal, undefined, invalidLayout.ctx)).rejects.toMatchObject({ code: "CONTEXT_UNAVAILABLE" });
    const staleContext = makeHarness();
    await expect(createPaneTool({ cli: staleContext.cli, context: { workspaceId: "wrong", tabId: "t1", paneId: "p1" } }).execute("id", { operation: "split", label: "x" } as never, new AbortController().signal, undefined, staleContext.ctx)).resolves.toMatchObject({ details: { workspaceId: "w1" } });
    await expect(execute(invalidLayout, { operation: "move", target: "t1", destination: { kind: "tab", target: "t2" } })).rejects.toMatchObject({ code: "TARGET_TYPE_MISMATCH" });

    const focusCase = async (rects: Array<{ pane_id: string; rect: { x: number; y: number; width: number; height: number } }>, expectedFailure = false, differentTab = false) => {
      const harness = makeHarness();
      if (differentTab) {
        harness.snapshot.tabs.push({ tab_id: "t3", workspace_id: "w1", label: "other" });
        harness.snapshot.panes[1]!.tab_id = "t3";
      }
      let focused = "p1";
      const exec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
        if (argv[0] === "pane" && argv[1] === "current") return { stdout: JSON.stringify({ id: "current", result: { type: "pane_current", pane: harness.snapshot.panes[0] } }), stderr: "", code: 0, killed: false };
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

  it("reconciles a lost close response from target absence", async () => {
    const harness = makeHarness();
    const original = harness.cli.runJson.bind(harness.cli);
    harness.cli.runJson = vi.fn<HerdrCli["runJson"]>(async (argv, signal, preserve) => {
      if (argv[0] === "pane" && argv[1] === "close") {
        harness.snapshot.panes = harness.snapshot.panes.filter((pane) => pane.pane_id !== "p2");
        throw Object.assign(new Error("response lost"), { code: "CLI_PROTOCOL_ERROR" });
      }
      return original(argv, signal, preserve);
    });
    const result = await execute(harness, { operation: "close", target: "p2" }, { hasUI: false });
    expect(result.details).toMatchObject({ operation: "close", outcome: "reconciled", paneId: "p2", reconciliation: { targetAbsent: true, causality: "absence_proven_only", operationIdAvailable: false }, removedIds: ["p2"], postState: { paneCount: 1 } });
    expect(result.details.operationId).toBeUndefined();
  });

  it("preserves a completed close when the initiating signal aborts", async () => {
    const harness = makeHarness();
    const controller = new AbortController();
    const original = harness.cli.runJson.bind(harness.cli);
    const signals: AbortSignal[] = [];
    harness.cli.runJson = vi.fn<HerdrCli["runJson"]>(async (argv, signal, preserve) => {
      signals.push(signal);
      const result = await original(argv, signal, preserve);
      if (argv[0] === "pane" && argv[1] === "close") controller.abort();
      return result;
    });
    const result = await execute(harness, { operation: "close", target: "p2" }, {}, controller.signal);
    expect(result.details).toMatchObject({ outcome: "success", operationId: "close", removedIds: ["p2"] });
    expect(signals.at(-1)).not.toBe(controller.signal);
  });

  it("does not use confirmation and reports uncertainty when target remains", async () => {
    const contradictory = makeHarness();
    const base = contradictory.cli.runJson.bind(contradictory.cli);
    contradictory.cli.runJson = vi.fn<HerdrCli["runJson"]>(async (argv, signal) => {
      if (argv[0] === "pane" && argv[1] === "close") return { id: "close", result: {} };
      return base(argv, signal);
    });
    await expect(execute(contradictory, { operation: "close", target: "p2" })).rejects.toMatchObject({ code: "MUTATION_UNCERTAIN", details: { targetId: "p2", readback: { status: "target_present" } } });
    expect(contradictory.confirm).not.toHaveBeenCalled();
  });

  it("marks a proven self-close but never a reconciled one", async () => {
    const success = makeHarness();
    const successTracker = createSelfCloseTracker();
    await expect(execute(success, { operation: "close", target: "p2" }, { hasUI: false }, undefined, successTracker)).resolves.toMatchObject({ details: { outcome: "success" } });
    expect(successTracker.consume("p2")).toBe(true);
    successTracker.clear();

    const reconciled = makeHarness();
    const reconciledTracker = createSelfCloseTracker();
    const base = reconciled.cli.runJson.bind(reconciled.cli);
    reconciled.cli.runJson = vi.fn<HerdrCli["runJson"]>(async (argv, signal, preserve) => {
      if (argv[0] === "pane" && argv[1] === "close") {
        reconciled.snapshot.panes = reconciled.snapshot.panes.filter((pane) => pane.pane_id !== "p2");
        throw Object.assign(new Error("response lost"), { code: "CLI_PROTOCOL_ERROR" });
      }
      return base(argv, signal, preserve);
    });
    // Absence is proven but causality is not: a reconciled close still wakes.
    await expect(execute(reconciled, { operation: "close", target: "p2" }, { hasUI: false }, undefined, reconciledTracker)).resolves.toMatchObject({ details: { outcome: "reconciled" } });
    expect(reconciledTracker.consume("p2")).toBe(false);
    reconciledTracker.clear();
  });

  it("leaves no self-close marker when the close never proved itself", async () => {
    const uncertain = makeHarness();
    const uncertainTracker = createSelfCloseTracker();
    const base = uncertain.cli.runJson.bind(uncertain.cli);
    uncertain.cli.runJson = vi.fn<HerdrCli["runJson"]>(async (argv, signal, preserve) => {
      if (argv[0] === "pane" && argv[1] === "close") return { id: "close", result: {} };
      return base(argv, signal, preserve);
    });
    await expect(execute(uncertain, { operation: "close", target: "p2" }, { hasUI: false }, undefined, uncertainTracker)).rejects.toMatchObject({ code: "MUTATION_UNCERTAIN" });
    expect(uncertainTracker.consume("p2")).toBe(false);
    uncertainTracker.clear();

    const unavailable = makeHarness();
    const unavailableTracker = createSelfCloseTracker();
    const unavailableBase = unavailable.cli.runJson.bind(unavailable.cli);
    unavailable.cli.runJson = vi.fn<HerdrCli["runJson"]>(async (argv, signal, preserve) => {
      if (argv[0] === "pane" && argv[1] === "close") throw Object.assign(new Error("backend gone"), { code: "BACKEND_UNAVAILABLE" });
      return unavailableBase(argv, signal, preserve);
    });
    await expect(execute(unavailable, { operation: "close", target: "p2" }, { hasUI: false }, undefined, unavailableTracker)).rejects.toMatchObject({ code: "BACKEND_UNAVAILABLE" });
    expect(unavailableTracker.consume("p2")).toBe(false);
    unavailableTracker.clear();

    const aborted = makeHarness();
    const abortedTracker = createSelfCloseTracker();
    const controller = new AbortController();
    controller.abort();
    await expect(execute(aborted, { operation: "close", target: "p2" }, { hasUI: false }, controller.signal, abortedTracker)).rejects.toMatchObject({ code: "ABORTED" });
    expect(abortedTracker.consume("p2")).toBe(false);
    abortedTracker.clear();
  });

  it("never tracks a protected target and keeps the marker through a completed abort", async () => {
    const protectedCase = makeHarness();
    const protectedTracker = createSelfCloseTracker();
    const beginSpy = vi.spyOn(protectedTracker, "begin");
    await expect(execute(protectedCase, { operation: "close", target: "current" }, {}, undefined, protectedTracker)).rejects.toMatchObject({ code: "PROTECTED_RESOURCE" });
    expect(beginSpy).not.toHaveBeenCalled();
    expect(protectedTracker.consume("p1")).toBe(false);
    protectedTracker.clear();

    const completed = makeHarness();
    const completedTracker = createSelfCloseTracker();
    const controller = new AbortController();
    const base = completed.cli.runJson.bind(completed.cli);
    completed.cli.runJson = vi.fn<HerdrCli["runJson"]>(async (argv, signal, preserve) => {
      const result = await base(argv, signal, preserve);
      if (argv[0] === "pane" && argv[1] === "close") controller.abort();
      return result;
    });
    // The preserved envelope plus the absence readback still confirm the marker.
    await expect(execute(completed, { operation: "close", target: "p2" }, { hasUI: false }, controller.signal, completedTracker)).resolves.toMatchObject({ details: { outcome: "success" } });
    expect(completedTracker.consume("p2")).toBe(true);
    completedTracker.clear();
  });

  it("protects the caller pane from close and fails closed on malformed create responses", async () => {
    const harness = makeHarness();
    await expect(execute(harness, { operation: "close", target: "current" })).rejects.toMatchObject({ code: "PROTECTED_RESOURCE" });
    expect(harness.calls.some((call) => call[1] === "close")).toBe(false);
    const badExec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[0] === "pane" && argv[1] === "current") return { stdout: JSON.stringify({ id: "current", result: { type: "pane_current", pane: harness.snapshot.panes[0] } }), stderr: "", code: 0, killed: false };
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
    await expect(execute(direct, { operation: "close", target: "p2" })).rejects.toMatchObject({ code: "TOPOLOGY_INVALID" });

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

describe("herdr_pane adopt", () => {
  const detectedSession = { source: "herdr:devin", agent: "devin", kind: "id", value: "sess-p2" };
  const detectedAgent = (overrides: Record<string, unknown> = {}) => ({
    pane_id: "p2",
    agent: "devin",
    terminal_id: "term-2",
    agent_session: detectedSession,
    agent_status: "idle",
    revision: 3,
    ...overrides
  });
  const detectedPane = (overrides: Record<string, unknown> = {}) => ({
    pane_id: "p2",
    tab_id: "t1",
    workspace_id: "w1",
    label: "worker",
    agent: "devin",
    terminal_id: "term-2",
    agent_session: detectedSession,
    agent_status: "idle",
    ...overrides
  });
  /** Swap p2's bare fixture pane for a detected-agent pane plus its agent record. */
  function detected(harness: Harness, paneOverrides: Record<string, unknown> = {}, agentOverrides: Record<string, unknown> = {}): Harness {
    harness.snapshot.panes[1] = detectedPane(paneOverrides) as PaneRecord;
    harness.snapshot.agents.push(detectedAgent(agentOverrides) as never);
    return harness;
  }

  it("adopts a detected non-launched pane, verifies identity, and writes advisory provenance", async () => {
    const harness = detected(makeHarness());
    const result = await execute(harness, { operation: "adopt", target: "p2", name: "adopted-worker" });
    expect(result.details).toMatchObject({
      operation: "adopt",
      outcome: "success",
      paneId: "p2",
      agentName: "adopted-worker",
      identity: { paneId: "p2", agentName: "adopted-worker", agentKind: "devin", terminalId: "term-2", agentSession: detectedSession }
    });
    expect(harness.calls).toContainEqual(["agent", "rename", "p2", "adopted-worker"]);
    expect(harness.calls).toContainEqual([
      "pane", "report-metadata", "p2", "--source", "herdr-tools",
      "--token", "identity_provenance=adopted", "--token", "identity_actor=p1", "--token", "identity_session=sess-p2"
    ]);
    // Label is UI furniture, not routing identity: adoption leaves it untouched.
    expect(harness.snapshot.panes[1]!.label).toBe("worker");
    expect(harness.calls.filter((argv) => argv[0] === "pane" && argv[1] === "rename")).toHaveLength(0);
  });

  it("rejects before any rename when the pane has no agent record", async () => {
    const harness = makeHarness();
    await expect(execute(harness, { operation: "adopt", target: "p2", name: "orphan" })).rejects.toMatchObject({ code: "ADOPT_TARGET_UNQUALIFIED" });
    expect(harness.calls.filter((argv) => argv[0] === "agent" && argv[1] === "rename")).toHaveLength(0);
  });

  it.each([
    ["a malformed name", { operation: "adopt", target: "p2", name: "Bad Name" }, "INVALID_INPUT"],
    ["a workspace id target", { operation: "adopt", target: "w1", name: "valid-name" }, "TARGET_TYPE_MISMATCH"],
    ["a tab id target", { operation: "adopt", target: "t2", name: "valid-name" }, "TARGET_TYPE_MISMATCH"],
    ["an unknown target", { operation: "adopt", target: "no-such", name: "valid-name" }, "TARGET_NOT_FOUND"]
  ])("rejects %s", async (_label, params, code) => {
    const harness = detected(makeHarness());
    await expect(execute(harness, params)).rejects.toMatchObject({ code });
    expect(harness.calls.filter((argv) => argv[0] === "agent" && argv[1] === "rename")).toHaveLength(0);
  });

  it("rejects an ambiguous target that resolves to multiple agents", async () => {
    const harness = detected(makeHarness());
    harness.snapshot.agents.push({ pane_id: "p9", name: "dupe" } as never, { pane_id: "p10", name: "dupe" } as never);
    await expect(execute(harness, { operation: "adopt", target: "dupe", name: "valid-name" })).rejects.toMatchObject({ code: "TARGET_AMBIGUOUS" });
  });

  it("is idempotent on the same name and refuses a different existing name", async () => {
    const harness = detected(makeHarness(), { agent_name: "kept-name" }, { name: "kept-name" });
    const result = await execute(harness, { operation: "adopt", target: "p2", name: "kept-name" });
    expect(result.details).toMatchObject({ operation: "adopt", outcome: "success", namePreexisting: true });
    expect(harness.calls.filter((argv) => argv[0] === "agent" && argv[1] === "rename")).toHaveLength(0);
    // No mint happened, so the no-op adopt must not overwrite an existing
    // provenance marker (e.g. identity_provenance=launched).
    expect(harness.calls.filter((argv) => argv[0] === "pane" && argv[1] === "report-metadata")).toHaveLength(0);
    const fresh = detected(makeHarness(), { agent_name: "kept-name" }, { name: "kept-name" });
    await expect(execute(fresh, { operation: "adopt", target: "p2", name: "other-name" })).rejects.toMatchObject({ code: "AGENT_ALREADY_NAMED" });
  });

  it("rejects a name already held by another pane", async () => {
    const harness = detected(makeHarness());
    harness.snapshot.agents.push({ pane_id: "p9", name: "taken-name", agent: "pi" } as never);
    await expect(execute(harness, { operation: "adopt", target: "p2", name: "taken-name" })).rejects.toMatchObject({ code: "AGENT_NAME_TAKEN" });
  });

  it("maps a server-side collision the snapshot missed to AGENT_NAME_TAKEN", async () => {
    const harness = detected(makeHarness());
    const base = harness.cli.runJson.bind(harness.cli);
    harness.cli.runJson = vi.fn<HerdrCli["runJson"]>(async (argv, signal) => {
      if (argv[0] === "agent" && argv[1] === "rename") {
        throw Object.assign(new Error("name taken"), { details: { errorEnvelope: { id: "r", error: { code: "agent_name_taken", message: "name taken" } } } });
      }
      return base(argv, signal);
    });
    await expect(execute(harness, { operation: "adopt", target: "p2", name: "raced-name" })).rejects.toMatchObject({ code: "AGENT_NAME_TAKEN" });
  });

  it("treats a provenance token failure as a warning, never a failed adopt", async () => {
    const harness = detected(makeHarness());
    const base = harness.cli.runJson.bind(harness.cli);
    harness.cli.runJson = vi.fn<HerdrCli["runJson"]>(async (argv, signal) => {
      if (argv[0] === "pane" && argv[1] === "report-metadata") throw new Error("metadata offline");
      return base(argv, signal);
    });
    const result = await execute(harness, { operation: "adopt", target: "p2", name: "adopted-worker" });
    expect(result.details).toMatchObject({ operation: "adopt", outcome: "success", agentName: "adopted-worker", provenanceWarning: "metadata offline" });
  });

  it("fails closed when the identity changed between precondition and verify", async () => {
    const harness = detected(makeHarness());
    const base = harness.cli.runJson.bind(harness.cli);
    let renamed = false;
    harness.cli.runJson = vi.fn<HerdrCli["runJson"]>(async (argv, signal) => {
      const out = await base(argv, signal);
      if (argv[0] === "agent" && argv[1] === "rename") renamed = true;
      // Once renamed, every fresh read reports a different session: the pane's
      // agent rotated mid-adopt and the post-verify join must refuse.
      if (renamed && argv[0] === "agent" && argv[1] === "get") {
        return { id: "get", result: { agent: detectedAgent({ name: "adopted-worker", agent_session: { ...detectedSession, value: "sess-rotated" } }) } };
      }
      return out;
    });
    await expect(execute(harness, { operation: "adopt", target: "p2", name: "adopted-worker" })).rejects.toMatchObject({ code: "TARGET_IDENTITY_CHANGED" });
  });
});
