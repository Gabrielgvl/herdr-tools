import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HerdrCli, type PiExec } from "../../src/cli.js";
import { resetOwnership, runtimeOwnership } from "../../src/ownership.js";
import { createTabTool } from "../../src/tools/tab.js";
import type { HerdrSnapshot } from "../../src/targets.js";

const context = { workspaceId: "w1", tabId: "t1", paneId: "p1" };

function fixture(): HerdrSnapshot {
  return {
    version: "1",
    protocol: 1,
    workspaces: [{ workspace_id: "w1", label: "workspace" }],
    tabs: [
      { tab_id: "t1", workspace_id: "w1", label: "main", focused: true },
      { tab_id: "t2", workspace_id: "w1", label: "secondary" }
    ],
    panes: [
      { pane_id: "p1", tab_id: "t1", workspace_id: "w1", label: "caller" },
      { pane_id: "p2", tab_id: "t2", workspace_id: "w1", label: "other" }
    ],
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
  const calls: string[][] = [];
  const confirm = vi.fn().mockResolvedValue(true);
  const response = (id: string, result: unknown) => ({ stdout: JSON.stringify({ id, result }), stderr: "", code: 0, killed: false });
  const exec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
    calls.push(argv);
    if (argv[0] === "api" && argv[1] === "snapshot") return response("snapshot", { type: "session_snapshot", snapshot });
    if (argv[0] === "tab" && argv[1] === "create") {
      snapshot.tabs.push({ tab_id: "t3", workspace_id: "w1", label: argv[argv.indexOf("--label") + 1] });
      snapshot.panes.push({ pane_id: "p3", tab_id: "t3", workspace_id: "w1", label: "root" });
      return response("create", { tab: { tab_id: "t3" }, root_pane: { pane_id: "p3" } });
    }
    if (argv[0] === "tab" && argv[1] === "get") {
      const tab = snapshot.tabs.find((item) => item.tab_id === argv[2]);
      return response("get", { tab: tab ?? null, environment: { SECRET: "do-not-leak" } });
    }
    if (argv[0] === "tab" && argv[1] === "rename") {
      const tab = snapshot.tabs.find((item) => item.tab_id === argv[2]);
      if (tab) tab.label = argv[3];
      return response("rename", { ok: true });
    }
    if (argv[0] === "tab" && argv[1] === "focus") {
      for (const tab of snapshot.tabs) tab.focused = tab.tab_id === argv[2];
      return response("focus", { ok: true });
    }
    if (argv[0] === "tab" && argv[1] === "close") {
      snapshot.tabs = snapshot.tabs.filter((item) => item.tab_id !== argv[2]);
      snapshot.panes = snapshot.panes.filter((item) => item.tab_id !== argv[2]);
      return response("close", { ok: true });
    }
    throw new Error(`unexpected argv ${argv.join(" ")}`);
  });
  const cli = new HerdrCli(exec);
  const ctx = { hasUI: true, cwd: "/repo", signal: undefined, ui: { confirm } } as unknown as ExtensionContext;
  return { cli, calls, snapshot, confirm, ctx };
}

function execute(harness: Harness, params: Record<string, unknown>, overrides: Partial<ExtensionContext> = {}) {
  const tool = createTabTool({ cli: harness.cli, context, cwd: "/cwd" });
  return tool.execute("call", params as never, new AbortController().signal, undefined, { ...harness.ctx, ...overrides } as ExtensionContext);
}

afterEach(() => resetOwnership());

describe("herdr_tab", () => {
  it("creates a labeled tab in the current workspace with no focus and reads the returned ID", async () => {
    const harness = makeHarness();
    const result = await execute(harness, { operation: "create", label: "new tab" });
    expect(result.details).toMatchObject({ operation: "create", tabId: "t3", workspaceId: "w1", rootPaneId: "p3" });
    expect(harness.calls).toContainEqual(["tab", "create", "--workspace", "w1", "--label", "new tab", "--cwd", "/cwd", "--no-focus"]);
    expect(harness.calls).toContainEqual(["tab", "get", "t3"]);
    expect(runtimeOwnership.snapshot()).toEqual([
      { kind: "tab", id: "t3", parentId: "w1" },
      { kind: "pane", id: "p3", parentId: "t3" }
    ]);
  });

  it("honors explicit focus and arbitrary env keys while keeping values out of details", async () => {
    const harness = makeHarness();
    const result = await execute(harness, { operation: "create", label: "focused", focus: true, cwd: "/tmp", env: { ANY_NAME: "secret-value" } });
    expect(harness.calls).toContainEqual(["tab", "create", "--workspace", "w1", "--label", "focused", "--cwd", "/tmp", "--focus", "--env", "ANY_NAME=secret-value"]);
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });

  it("rejects missing labels, unsafe environments, inconsistent context, and fuzzy tab labels before mutation", async () => {
    const harness = makeHarness();
    await expect(execute(harness, { operation: "create", label: "" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(execute(harness, { operation: "create", label: "x", env: { BAD: "line\nvalue" } })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(execute(harness, { operation: "rename", target: "secondary", label: "x" })).rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });
    const before = harness.calls.length;
    await expect(createTabTool({ cli: harness.cli, context: { workspaceId: "wrong", tabId: "t1", paneId: "p1" } }).execute("id", { operation: "create", label: "x" }, new AbortController().signal, undefined, harness.ctx)).rejects.toMatchObject({ code: "CONTEXT_UNAVAILABLE" });
    expect(harness.calls.slice(before).filter((call) => call[1] === "create" || call[1] === "rename")).toHaveLength(0);
  });

  it("renames and focuses exact IDs/current, then closes owned and confirmed tabs", async () => {
    const harness = makeHarness();
    await expect(execute(harness, { operation: "rename", target: "t2", label: "renamed" })).resolves.toMatchObject({ details: { tabId: "t2" } });
    await expect(execute(harness, { operation: "focus", target: "current" })).resolves.toMatchObject({ details: { tabId: "t1" } });
    const created = await execute(harness, { operation: "create", label: "owned" });
    await expect(execute(harness, { operation: "close", target: created.details.tabId as string }, { hasUI: false })).resolves.toMatchObject({ details: { tabId: "t3", removedIds: ["t3", "p3"] } });
    await expect(execute(harness, { operation: "close", target: "t2" })).resolves.toMatchObject({ details: { tabId: "t2" } });
    expect(harness.confirm).toHaveBeenCalled();
  });

  it("protects the caller tab, rejects no-UI unowned close, and does not echo response environment fields", async () => {
    const harness = makeHarness();
    await expect(execute(harness, { operation: "close", target: "current" })).rejects.toMatchObject({ code: "PROTECTED_RESOURCE" });
    await expect(execute(harness, { operation: "close", target: "t2" }, { hasUI: false })).rejects.toMatchObject({ code: "CONFIRMATION_UNAVAILABLE" });
    expect(harness.calls.some((call) => call[1] === "close")).toBe(false);
    const result = await execute(harness, { operation: "rename", target: "t2", label: "safe" });
    expect(JSON.stringify(result)).not.toContain("do-not-leak");
  });

  it("accepts the authoritative create_result tab shape and handles missing context", async () => {
    const harness = makeHarness();
    harness.cli = new HerdrCli(vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { type: "session_snapshot", snapshot: harness.snapshot } }), stderr: "", code: 0, killed: false };
      if (argv[0] === "tab" && argv[1] === "create") return { stdout: JSON.stringify({ id: "create", result: { tab: { tab_id: "t4", workspace_id: "w1" }, root_pane: { pane_id: "p4" } } }), stderr: "", code: 0, killed: false };
      if (argv[0] === "tab" && argv[1] === "get") return { stdout: JSON.stringify({ id: "get", result: { tab: { tab_id: "t4", workspace_id: "w1", label: "created" } } }), stderr: "", code: 0, killed: false };
      throw new Error(`unexpected argv ${argv.join(" ")}`);
    }));
    await expect(execute(harness, { operation: "create", label: "created" })).resolves.toMatchObject({ details: { tabId: "t4", rootPaneId: "p4" } });
    await expect(createTabTool({ cli: harness.cli, context: {} }).execute("id", { operation: "create", label: "x" }, new AbortController().signal, undefined, harness.ctx)).rejects.toMatchObject({ code: "CONTEXT_UNAVAILABLE" });

    const invalidCreate = new HerdrCli(vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { type: "session_snapshot", snapshot: harness.snapshot } }), stderr: "", code: 0, killed: false };
      return { stdout: JSON.stringify({ id: "create", result: { tab: { tab_id: "" } } }), stderr: "", code: 0, killed: false };
    }));
    await expect(createTabTool({ cli: invalidCreate, context }).execute("id", { operation: "create", label: "x" }, new AbortController().signal, undefined, harness.ctx)).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });

    const invalidPost = new HerdrCli(vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { type: "session_snapshot", snapshot: harness.snapshot } }), stderr: "", code: 0, killed: false };
      if (argv[0] === "tab" && argv[1] === "create") return { stdout: JSON.stringify({ id: "create", result: { tab: { tab_id: "t4" } } }), stderr: "", code: 0, killed: false };
      return { stdout: JSON.stringify({ id: "get", result: { tab: { tab_id: "t4" } } }), stderr: "", code: 0, killed: false };
    }));
    await expect(createTabTool({ cli: invalidPost, context }).execute("id", { operation: "create", label: "x" }, new AbortController().signal, undefined, harness.ctx)).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    const invalidObject = new HerdrCli(vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { type: "session_snapshot", snapshot: harness.snapshot } }), stderr: "", code: 0, killed: false };
      if (argv[0] === "tab" && argv[1] === "create") return { stdout: JSON.stringify({ id: "create", result: { tab: { tab_id: "t4" } } }), stderr: "", code: 0, killed: false };
      return { stdout: JSON.stringify({ id: "get", result: null }), stderr: "", code: 0, killed: false };
    }));
    await expect(createTabTool({ cli: invalidObject, context }).execute("id", { operation: "create", label: "x" }, new AbortController().signal, undefined, harness.ctx)).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });

    const directTab = new HerdrCli(vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { type: "session_snapshot", snapshot: harness.snapshot } }), stderr: "", code: 0, killed: false };
      if (argv[0] === "tab" && argv[1] === "create") return { stdout: JSON.stringify({ id: "create", result: { tab_id: "t5", root_pane: {} } }), stderr: "", code: 0, killed: false };
      return { stdout: JSON.stringify({ id: "get", result: { tab_id: "t5", workspace_id: "w1", label: "direct" } }), stderr: "", code: 0, killed: false };
    }));
    await expect(createTabTool({ cli: directTab, context }).execute("id", { operation: "create", label: "direct" }, undefined, undefined, harness.ctx)).resolves.toMatchObject({ details: { tabId: "t5", rootPaneId: undefined } });
  });

  it("rejects confirmation declines and contradictory close post-state", async () => {
    const harness = makeHarness();
    harness.confirm.mockResolvedValueOnce(false);
    await expect(execute(harness, { operation: "close", target: "t2" })).rejects.toMatchObject({ code: "CONFIRMATION_DECLINED" });
    const original = harness.cli;
    original.runJson = vi.fn<HerdrCli["runJson"]>(async (argv) => {
      if (argv[0] === "api") return { id: "snapshot", result: { type: "session_snapshot", snapshot: harness.snapshot } };
      if (argv[0] === "tab" && argv[1] === "close") return { id: "close", result: { ok: true } };
      if (argv[0] === "tab" && argv[1] === "get") return { id: "get", result: { tab: harness.snapshot.tabs[1] } };
      return { id: "other", result: {} };
    });
    await expect(execute(harness, { operation: "close", target: "t2" })).rejects.toMatchObject({ code: "POSTSTATE_UNAVAILABLE" });
  });

  it("fails closed when tab creation does not return an opaque ID and renders compact rows", async () => {
    const harness = makeHarness();
    const badExec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { type: "session_snapshot", snapshot: harness.snapshot } }), stderr: "", code: 0, killed: false };
      return { stdout: JSON.stringify({ id: "create", result: { ok: true } }), stderr: "", code: 0, killed: false };
    });
    await expect(createTabTool({ cli: new HerdrCli(badExec), context }).execute("id", { operation: "create", label: "x" }, new AbortController().signal, undefined, harness.ctx)).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    const tool = createTabTool({ cli: harness.cli, context });
    const call = tool.renderCall?.({ operation: "create", label: "new" } as never, {} as never, {} as never);
    expect(call?.render(80)).toEqual(["herdr_tab · create"]);
    const targetedCall = tool.renderCall?.({ operation: "focus", target: "t2" } as never, {} as never, {} as never);
    expect(targetedCall?.render(80)).toEqual(["herdr_tab · focus · t2"]);
    targetedCall?.invalidate();
    call?.invalidate();
    const result = tool.renderResult?.({ content: [], details: { operation: "create", outcome: "success", tabId: "t2" } } as never, { expanded: false, isPartial: false } as never, {} as never, { isError: false } as never);
    expect(result?.render(80)).toEqual(["tab · t2"]);
    result?.invalidate();
  });
});
