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

  it("accepts authoritative tab shapes and rejects malformed post-state", async () => {
    const harness = makeHarness();
    harness.cli = new HerdrCli(vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { type: "session_snapshot", snapshot: harness.snapshot } }), stderr: "", code: 0, killed: false };
      if (argv[0] === "tab" && argv[1] === "create") {
        harness.snapshot.tabs.push({ tab_id: "t4", workspace_id: "w1", label: "created" });
        harness.snapshot.panes.push({ pane_id: "p4", tab_id: "t4", workspace_id: "w1", label: "root" });
        return { stdout: JSON.stringify({ id: "create", result: { tab: { tab_id: "t4", workspace_id: "w1" }, root_pane: { pane_id: "p4" } } }), stderr: "", code: 0, killed: false };
      }
      if (argv[0] === "tab" && argv[1] === "get") return { stdout: JSON.stringify({ id: "get", result: { tab: { tab_id: "t4", workspace_id: "w1", label: "created" } } }), stderr: "", code: 0, killed: false };
      throw new Error(`unexpected argv ${argv.join(" ")}`);
    }));
    await expect(execute(harness, { operation: "create", label: "created" })).resolves.toMatchObject({ details: { tabId: "t4", rootPaneId: "p4" } });
    await expect(createTabTool({ cli: harness.cli, context: {} }).execute("id", { operation: "create", label: "x" }, new AbortController().signal, undefined, harness.ctx)).rejects.toMatchObject({ code: "CONTEXT_UNAVAILABLE" });

    const invalidCreate = new HerdrCli(vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { type: "session_snapshot", snapshot: fixture() } }), stderr: "", code: 0, killed: false };
      return { stdout: JSON.stringify({ id: "create", result: { tab: [] } }), stderr: "", code: 0, killed: false };
    }));
    await expect(createTabTool({ cli: invalidCreate, context }).execute("id", { operation: "create", label: "x" }, new AbortController().signal, undefined, harness.ctx)).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });

    const invalidPostSnapshot = fixture();
    const invalidPost = new HerdrCli(vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { type: "session_snapshot", snapshot: invalidPostSnapshot } }), stderr: "", code: 0, killed: false };
      if (argv[0] === "tab" && argv[1] === "create") {
        invalidPostSnapshot.tabs.push({ tab_id: "t4", workspace_id: "w1", label: "created" });
        invalidPostSnapshot.panes.push({ pane_id: "p4", tab_id: "t4", workspace_id: "w1", label: "root" });
        return { stdout: JSON.stringify({ id: "create", result: { tab: { tab_id: "t4" }, root_pane: { pane_id: "p4" } } }), stderr: "", code: 0, killed: false };
      }
      return { stdout: JSON.stringify({ id: "get", result: { tab: { tab_id: "t4" } } }), stderr: "", code: 0, killed: false };
    }));
    await expect(createTabTool({ cli: invalidPost, context }).execute("id", { operation: "create", label: "x" }, new AbortController().signal, undefined, harness.ctx)).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });

    const invalidObjectSnapshot = fixture();
    const invalidObject = new HerdrCli(vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { type: "session_snapshot", snapshot: invalidObjectSnapshot } }), stderr: "", code: 0, killed: false };
      if (argv[0] === "tab" && argv[1] === "create") {
        invalidObjectSnapshot.tabs.push({ tab_id: "t4", workspace_id: "w1", label: "created" });
        invalidObjectSnapshot.panes.push({ pane_id: "p4", tab_id: "t4", workspace_id: "w1", label: "root" });
        return { stdout: JSON.stringify({ id: "create", result: { tab: { tab_id: "t4" } } }), stderr: "", code: 0, killed: false };
      }
      return { stdout: JSON.stringify({ id: "get", result: null }), stderr: "", code: 0, killed: false };
    }));
    await expect(createTabTool({ cli: invalidObject, context }).execute("id", { operation: "create", label: "x" }, new AbortController().signal, undefined, harness.ctx)).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });

    const directSnapshot = fixture();
    const directTab = new HerdrCli(vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { type: "session_snapshot", snapshot: directSnapshot } }), stderr: "", code: 0, killed: false };
      if (argv[0] === "tab" && argv[1] === "create") {
        directSnapshot.tabs.push({ tab_id: "t5", workspace_id: "w1", label: "direct" });
        directSnapshot.panes.push({ pane_id: "p5", tab_id: "t5", workspace_id: "w1", label: "root" });
        return { stdout: JSON.stringify({ id: "create", result: { tab: { tab_id: "t5" }, root_pane: { pane_id: "p5" } } }), stderr: "", code: 0, killed: false };
      }
      return { stdout: JSON.stringify({ id: "get", result: { tab_id: "t5", workspace_id: "w1", label: "direct" } }), stderr: "", code: 0, killed: false };
    }));
    await expect(createTabTool({ cli: directTab, context }).execute("id", { operation: "create", label: "direct" }, undefined, undefined, harness.ctx)).resolves.toMatchObject({ details: { tabId: "t5", rootPaneId: "p5" } });
  });

  it("discovers and records the created root pane when tab create omits it", async () => {
    const harness = makeHarness();
    const base = harness.cli.runJson.bind(harness.cli);
    harness.cli.runJson = vi.fn<HerdrCli["runJson"]>(async (argv, signal) => {
      if (argv[0] === "tab" && argv[1] === "create") {
        harness.snapshot.tabs.push({ tab_id: "t4", workspace_id: "w1", label: "discovered" });
        harness.snapshot.panes.push({ pane_id: "p4", tab_id: "t4", workspace_id: "w1", label: "root" });
        return { id: "create", result: { tab: { tab_id: "t4", workspace_id: "w1" }, root_pane: {} } };
      }
      return base(argv, signal);
    });
    const result = await execute(harness, { operation: "create", label: "discovered" });
    expect(result.details).toMatchObject({ tabId: "t4", rootPaneId: "p4" });
    expect(runtimeOwnership.snapshot()).toContainEqual({ kind: "pane", id: "p4", parentId: "t4" });
  });

  it("does not record tab resources before a post-create read succeeds", async () => {
    const harness = makeHarness();
    harness.cli.runJson = vi.fn<HerdrCli["runJson"]>(async (argv) => {
      if (argv[0] === "api") return { id: "snapshot", result: { type: "session_snapshot", snapshot: harness.snapshot } };
      if (argv[0] === "tab" && argv[1] === "create") {
        harness.snapshot.tabs.push({ tab_id: "t4", workspace_id: "w1", label: "retained" });
        harness.snapshot.panes.push({ pane_id: "p4", tab_id: "t4", workspace_id: "w1", label: "root" });
        return { id: "create", result: { tab: { tab_id: "t4" }, root_pane: { pane_id: "p4" } } };
      }
      if (argv[0] === "tab" && argv[1] === "get") throw Object.assign(new Error("post-read failed"), { code: "CLI_PROTOCOL_ERROR" });
      throw new Error(`unexpected argv ${argv.join(" ")}`);
    });
    await expect(execute(harness, { operation: "create", label: "retained" })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
    expect(runtimeOwnership.snapshot()).toEqual([]);
  });

  it("rejects contradictory create topology and tab mutation post-state before ownership", async () => {
    const contradictory = makeHarness();
    const base = contradictory.cli.runJson.bind(contradictory.cli);
    contradictory.cli.runJson = vi.fn<HerdrCli["runJson"]>(async (argv, signal) => {
      if (argv[0] === "tab" && argv[1] === "create") {
        contradictory.snapshot.tabs.push({ tab_id: "t3", workspace_id: "w1", label: "created" });
        contradictory.snapshot.panes.push({ pane_id: "p3", tab_id: "t3", workspace_id: "w1", label: "root" });
        return { id: "create", result: { tab: { tab_id: "t3", workspace_id: "wrong" }, root_pane: { pane_id: "p2" } } };
      }
      return base(argv, signal);
    });
    await expect(execute(contradictory, { operation: "create", label: "created" })).rejects.toMatchObject({ code: "POSTSTATE_UNAVAILABLE" });
    expect(runtimeOwnership.snapshot()).toEqual([]);
    expect(contradictory.calls.some((call) => call[0] === "tab" && call[1] === "get")).toBe(false);

    for (const operation of ["rename", "focus"] as const) {
      const mismatch = makeHarness();
      const mismatchBase = mismatch.cli.runJson.bind(mismatch.cli);
      mismatch.cli.runJson = vi.fn<HerdrCli["runJson"]>(async (argv, signal) => {
        if (argv[0] === "tab" && argv[1] === "get") return { id: "get", result: { tab: { tab_id: "t1", workspace_id: "w1", label: "wrong" } } };
        return mismatchBase(argv, signal);
      });
      const params = operation === "rename" ? { operation, target: "t2", label: "new" } : { operation, target: "t2" };
      await expect(execute(mismatch, params)).rejects.toMatchObject({ code: "POSTSTATE_UNAVAILABLE" });
    }
  });

  it("fails closed when create identity is absent, ambiguous, or reuses a root pane", async () => {
    const existingTab = makeHarness();
    const existingBase = existingTab.cli.runJson.bind(existingTab.cli);
    existingTab.cli.runJson = vi.fn<HerdrCli["runJson"]>(async (argv, signal) => {
      if (argv[0] === "tab" && argv[1] === "create") return { id: "create", result: { tab: { tab_id: "t2" }, root_pane: { pane_id: "p2" } } };
      return existingBase(argv, signal);
    });
    await expect(execute(existingTab, { operation: "create", label: "existing" })).rejects.toMatchObject({ code: "POSTSTATE_UNAVAILABLE" });

    const missingTab = makeHarness();
    const missingBase = missingTab.cli.runJson.bind(missingTab.cli);
    missingTab.cli.runJson = vi.fn<HerdrCli["runJson"]>(async (argv, signal) => {
      if (argv[0] === "tab" && argv[1] === "create") return { id: "create", result: { tab: { tab_id: "missing" }, root_pane: { pane_id: "missing-pane" } } };
      return missingBase(argv, signal);
    });
    await expect(execute(missingTab, { operation: "create", label: "missing" })).rejects.toMatchObject({ code: "POSTSTATE_UNAVAILABLE" });

    const missingWorkspace = makeHarness();
    const missingWorkspaceBase = missingWorkspace.cli.runJson.bind(missingWorkspace.cli);
    missingWorkspace.cli.runJson = vi.fn<HerdrCli["runJson"]>(async (argv, signal) => {
      if (argv[0] === "tab" && argv[1] === "create") {
        missingWorkspace.snapshot.workspaces = [];
        missingWorkspace.snapshot.tabs.push({ tab_id: "t3", workspace_id: "w1", label: "missing workspace" });
        missingWorkspace.snapshot.panes.push({ pane_id: "p3", tab_id: "t3", workspace_id: "w1", label: "root" });
        return { id: "create", result: { tab: { tab_id: "t3" }, root_pane: { pane_id: "p3" } } };
      }
      return missingWorkspaceBase(argv, signal);
    });
    await expect(execute(missingWorkspace, { operation: "create", label: "missing workspace" })).rejects.toMatchObject({ code: "POSTSTATE_UNAVAILABLE" });

    const missingRoot = makeHarness();
    const missingRootBase = missingRoot.cli.runJson.bind(missingRoot.cli);
    missingRoot.cli.runJson = vi.fn<HerdrCli["runJson"]>(async (argv, signal) => {
      if (argv[0] === "tab" && argv[1] === "create") {
        missingRoot.snapshot.tabs.push({ tab_id: "t3", workspace_id: "w1", label: "missing root" });
        return { id: "create", result: { tab: { tab_id: "t3" }, root_pane: { pane_id: "p3" } } };
      }
      return missingRootBase(argv, signal);
    });
    await expect(execute(missingRoot, { operation: "create", label: "missing root" })).rejects.toMatchObject({ code: "POSTSTATE_UNAVAILABLE" });

    const ambiguousRoot = makeHarness();
    const ambiguousBase = ambiguousRoot.cli.runJson.bind(ambiguousRoot.cli);
    ambiguousRoot.cli.runJson = vi.fn<HerdrCli["runJson"]>(async (argv, signal) => {
      if (argv[0] === "tab" && argv[1] === "create") {
        ambiguousRoot.snapshot.tabs.push({ tab_id: "t3", workspace_id: "w1", label: "ambiguous root" });
        ambiguousRoot.snapshot.panes.push(
          { pane_id: "p3", tab_id: "t3", workspace_id: "w1", label: "root 1" },
          { pane_id: "p4", tab_id: "t3", workspace_id: "w1", label: "root 2" }
        );
        return { id: "create", result: { tab: { tab_id: "t3" } } };
      }
      return ambiguousBase(argv, signal);
    });
    await expect(execute(ambiguousRoot, { operation: "create", label: "ambiguous root" })).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });

    const reusedRoot = makeHarness();
    const before = fixture();
    before.panes.push({ pane_id: "p3", tab_id: "t1", workspace_id: "w1", label: "old root" });
    const after = fixture();
    let snapshotReads = 0;
    reusedRoot.cli = new HerdrCli(vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[0] === "api") {
        snapshotReads += 1;
        const snapshot = snapshotReads === 1 ? before : after;
        return { stdout: JSON.stringify({ id: "snapshot", result: { type: "session_snapshot", snapshot } }), stderr: "", code: 0, killed: false };
      }
      if (argv[0] === "tab" && argv[1] === "create") {
        after.tabs.push({ tab_id: "t3", workspace_id: "w1", label: "new" });
        after.panes.push({ pane_id: "p3", tab_id: "t3", workspace_id: "w1", label: "new root" });
        return { stdout: JSON.stringify({ id: "create", result: { tab: { tab_id: "t3" }, root_pane: { pane_id: "p3" } } }), stderr: "", code: 0, killed: false };
      }
      throw new Error(`unexpected argv ${argv.join(" ")}`);
    }));
    await expect(execute(reusedRoot, { operation: "create", label: "reused root" })).rejects.toMatchObject({ code: "POSTSTATE_UNAVAILABLE" });
    expect(runtimeOwnership.snapshot()).toEqual([]);
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
