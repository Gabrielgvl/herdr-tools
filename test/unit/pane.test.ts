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
      return response("get", { pane: pane ?? null, environment: { SECRET: "do-not-leak" } });
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
        snapshot.tabs.push({ tab_id: "t-new", workspace_id: "w1", label: argv[argv.indexOf("--tab-label") + 1] });
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

  it("renders compact calls and results without raw topology", () => {
    const harness = makeHarness();
    const tool = createPaneTool({ cli: harness.cli, context });
    const call = tool.renderCall?.({ operation: "rename", target: "p2", label: "x" } as never, {} as never, {} as never);
    expect(call?.render(80)).toEqual(["herdr_pane · rename · p2"]);
    call?.invalidate();
    const result = tool.renderResult?.({ content: [], details: { operation: "rename", outcome: "success", paneId: "p2" } } as never, { expanded: false, isPartial: false } as never, {} as never, { isError: false } as never);
    expect(result?.render(80)).toEqual(["pane · p2"]);
    result?.invalidate();
  });
});
