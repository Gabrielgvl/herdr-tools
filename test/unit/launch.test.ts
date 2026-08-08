import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HerdrCli, type PiExec } from "../../src/cli.js";
import { createLaunchTool, validateLaunchParams, type LaunchCli } from "../../src/tools/launch.js";
import { LAUNCH_AGENT_KINDS, LaunchParamsSchema, type LaunchParams } from "../../src/launch-schema.js";
import type { HerdrSnapshot } from "../../src/targets.js";

const snapshot: HerdrSnapshot = {
  version: "0.8.0",
  protocol: 19,
  workspaces: [{ workspace_id: "w1", label: "workspace", focused: true }],
  tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main", focused: true }],
  panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "caller", agent_status: "idle" }],
  agents: []
};
const context = { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" };
const assignmentEnvelope = (payload: string) => `[HERDR AGENT MESSAGE v1]\nfrom: caller (w1:p1)\nkind: assignment\nauthority: agent; not user/owner\npayload: all text after this blank line is sender-authored\n\n${payload}`;
const extensionContext = { cwd: "/repo", hasUI: false } as ExtensionContext;
const ok = (id: string, result: unknown) => ({ id, result });

function makeCli(overrides: Partial<LaunchCli> = {}) {
  const calls: string[][] = [];
  const runJson = vi.fn<LaunchCli["runJson"]>(async (argv) => {
    calls.push(argv);
    if (argv[0] === "api") return ok("snapshot", { type: "session_snapshot", snapshot });
    if (argv[0] === "pane" && argv[1] === "split") return ok("split", { pane: { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1" } });
    if (argv[0] === "pane" && argv[1] === "rename") return ok("rename", { pane: { pane_id: "w1:p2", label: "worker" } });
    if (argv[0] === "agent" && argv[1] === "start") return ok("start", { agent: { name: "worker", agent_id: "agent-7", pane_id: "w1:p2" } });
    if (argv[0] === "agent" && argv[1] === "prompt") return ok("prompt", { ok: true });
    if (argv[0] === "pane" && argv[1] === "get") return ok("get", { pane: { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", label: "worker", agent_name: "worker", agent_status: "working" } });
    throw new Error(`unexpected argv: ${argv.join(" ")}`);
  });
  return { cli: { runJson, ...overrides } as LaunchCli, calls };
}

function launch(overrides: Partial<LaunchParams> = {}, deps: { cli?: LaunchCli; cwd?: string } = {}) {
  const { cli, calls } = deps.cli ? { cli: deps.cli, calls: [] as string[][] } : makeCli();
  const tool = createLaunchTool({ cli, context, cwd: deps.cwd });
  const params: LaunchParams = { name: "worker", kind: "pi", ...overrides };
  return { promise: tool.execute("id", params, new AbortController().signal, undefined, extensionContext), calls, tool };
}

describe("herdr_launch schema", () => {
  it("exposes the complete installed supported kind set and a strict required shape", () => {
    expect(LAUNCH_AGENT_KINDS).toEqual(["pi", "claude", "codex", "gemini", "cursor", "devin", "agy", "cline", "omp", "mastracode", "opencode", "copilot", "kimi", "kiro", "droid", "amp", "grok", "hermes", "kilo", "qodercli", "maki"]);
    expect(LaunchParamsSchema).toMatchObject({ anyOf: expect.any(Array) });
    const variants = (LaunchParamsSchema as { anyOf: Array<{ required?: string[]; properties?: Record<string, unknown> }> }).anyOf;
    expect(variants).toHaveLength(2);
    const raw = variants.find((variant) => variant.required?.includes("kind"));
    const profile = variants.find((variant) => variant.required?.includes("profile"));
    expect(raw?.properties).toEqual(expect.objectContaining({ kind: expect.any(Object) }));
    expect(raw?.properties).not.toHaveProperty("profile");
    expect(raw?.properties).not.toHaveProperty("overrides");
    expect(profile?.properties).toEqual(expect.objectContaining({ profile: expect.any(Object) }));
    expect(profile?.properties).not.toHaveProperty("kind");
    expect(profile?.properties).not.toHaveProperty("argv");
    expect(profile?.properties).not.toHaveProperty("env");
  });
});

describe("herdr_launch", () => {
  it("uses current cwd, right split, no focus, caller name label, and separates agent argv", async () => {
    const { promise, calls } = launch({ argv: ["--model", "fast mode"] });
    const result = await promise;
    expect(calls).toEqual([
      ["api", "snapshot"],
      ["pane", "split", "--current", "--direction", "right", "--no-focus", "--cwd", "/repo"],
      ["pane", "rename", "w1:p2", "worker"],
      ["agent", "start", "worker", "--kind", "pi", "--pane", "w1:p2", "--timeout", "120000", "--", "--model", "fast mode"],
      ["pane", "get", "w1:p2"]
    ]);
    expect(result.details).toMatchObject({ outcome: "launched", name: "worker", kind: "pi", paneId: "w1:p2", tabId: "w1:t1", agentId: "agent-7", postState: { agent_status: "working" } });
  });

  it("rejects a pane post-state whose pane ID differs from the resolved placement", async () => {
    const { cli } = makeCli();
    const base = cli.runJson;
    cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserveCompletedMutation) => {
      if (argv[0] === "pane" && argv[1] === "get") return ok("get", { pane: { pane_id: "w1:wrong", tab_id: "w1:t1", workspace_id: "w1", agent_status: "working" } });
      return base(argv, signal, preserveCompletedMutation);
    });
    await expect(createLaunchTool({ cli, context, cwd: "/repo" }).execute("id", { name: "worker", kind: "pi" }, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({
      code: "POSTSTATE_UNAVAILABLE",
      details: { causeCode: "POSTSTATE_UNAVAILABLE", expectedPaneId: "w1:p2" }
    });
  });

  it("records returned launch resources through the narrow shared registry", async () => {
    const { cli } = makeCli();
    const record = vi.fn();
    await createLaunchTool({ cli, context, cwd: "/repo", ownership: { record } }).execute("id", { name: "worker", kind: "pi" }, new AbortController().signal, undefined, extensionContext);
    expect(record).toHaveBeenCalledWith({ kind: "pane", id: "w1:p2", parentId: "w1:t1" });
  });

  it("requires an authoritative agent-start identity instead of fabricating launch success", async () => {
    for (const startResult of [null, {}, { agent: {} }, { agent: null }]) {
      const { cli } = makeCli();
      const base = cli.runJson;
      cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal) => {
        if (argv[0] === "agent" && argv[1] === "start") return ok("start", startResult);
        return base(argv, signal);
      });
      await expect(createLaunchTool({ cli, context, cwd: "/repo" }).execute("id", { name: "worker", kind: "pi" }, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "LAUNCH_FAILED", details: { causeCode: "CLI_PROTOCOL_ERROR" } });
    }
  });

  it("uses a post-state agent name only when the start response supplies an ID", async () => {
    const { cli } = makeCli();
    const base = cli.runJson;
    cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal) => {
      if (argv[0] === "agent" && argv[1] === "start") return ok("start", { agent: { agent_id: "agent-only" } });
      return base(argv, signal);
    });
    await expect(createLaunchTool({ cli, context, cwd: "/repo" }).execute("id", { name: "worker", kind: "pi" }, new AbortController().signal, undefined, extensionContext)).resolves.toMatchObject({ details: { name: "worker", agentId: "agent-only" } });

    const noName = makeCli();
    const noNameBase = noName.cli.runJson;
    noName.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal) => {
      if (argv[0] === "agent" && argv[1] === "start") return ok("start", { agent: { agent_id: "agent-only" } });
      if (argv[0] === "pane" && argv[1] === "get") return ok("get", { pane: { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", agent_status: "idle" } });
      return noNameBase(argv, signal);
    });
    await expect(createLaunchTool({ cli: noName.cli, context, cwd: "/repo" }).execute("id", { name: "worker", kind: "pi" }, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "LAUNCH_FAILED", details: { causeCode: "CLI_PROTOCOL_ERROR" } });
  });

  it("passes arbitrary environment values unchanged and does not mutate process.env", async () => {
    const before = process.env.LAUNCH_TEST_SECRET;
    const { promise, calls } = launch({ env: { LAUNCH_TEST_SECRET: "value with spaces", OTHER: "a=b" } });
    await promise;
    expect(calls[1]).toEqual(["pane", "split", "--current", "--direction", "right", "--no-focus", "--cwd", "/repo", "--env", "LAUNCH_TEST_SECRET=value with spaces", "--env", "OTHER=a=b"]);
    expect(process.env.LAUNCH_TEST_SECRET).toBe(before);
  });

  it("creates and labels a new tab before starting the returned child pane", async () => {
    const { calls, cli } = makeCli();
    cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv) => {
      calls.push(argv);
      if (argv[0] === "api") return ok("snapshot", { type: "session_snapshot", snapshot });
      if (argv[0] === "tab" && argv[1] === "create") return ok("tab", { tab: { tab_id: "w1:t2", workspace_id: "w1" }, root_pane: { pane_id: "w1:p3", tab_id: "w1:t2", workspace_id: "w1" } });
      if (argv[0] === "pane" && argv[1] === "rename") return ok("rename", { pane: { pane_id: "w1:p3" } });
      if (argv[0] === "agent" && argv[1] === "start") return ok("start", { agent: { name: "worker", pane_id: "w1:p3" } });
      if (argv[0] === "pane" && argv[1] === "get") return ok("get", { pane: { pane_id: "w1:p3", tab_id: "w1:t2", workspace_id: "w1", label: "worker", agent_status: "idle" } });
      throw new Error(`unexpected argv: ${argv.join(" ")}`);
    });
    const result = await createLaunchTool({ cli, context, cwd: "/repo" }).execute("id", { name: "worker", kind: "claude", placement: { mode: "new_tab", tabLabel: "agents" }, focus: true }, new AbortController().signal, undefined, extensionContext);
    expect(calls).toEqual([
      ["api", "snapshot"],
      ["tab", "create", "--workspace", "w1", "--cwd", "/repo", "--label", "agents", "--focus"],
      ["pane", "rename", "w1:p3", "worker"],
      ["agent", "start", "worker", "--kind", "claude", "--pane", "w1:p3", "--timeout", "120000"],
      ["pane", "get", "w1:p3"]
    ]);
    expect(calls.some((call) => call[0] === "tab" && call[1] === "get")).toBe(false);
    expect(result.details).toMatchObject({ paneId: "w1:p3", tabId: "w1:t2", placement: { mode: "new_tab", tabLabel: "agents" } });
  });

  it("starts in an exact existing pane without creating a replacement", async () => {
    const existing = { ...snapshot, panes: [{ ...snapshot.panes[0], label: "target" }] };
    const cli: LaunchCli = { runJson: vi.fn<LaunchCli["runJson"]>(async (argv) => {
      if (argv[0] === "api") return ok("snapshot", { type: "session_snapshot", snapshot: existing });
      if (argv[0] === "agent" && argv[1] === "start") return ok("start", { agent: { name: "worker", pane_id: "w1:p1" } });
      if (argv[0] === "pane" && argv[1] === "get") return ok("get", { pane: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "target", agent_status: "idle" } });
      throw new Error(`unexpected argv: ${argv.join(" ")}`);
    }) };
    const result = await createLaunchTool({ cli, context }).execute("id", { name: "worker", kind: "codex", placement: { mode: "existing_pane", target: "target" } }, new AbortController().signal, undefined, extensionContext);
    expect(result.details).toMatchObject({ paneId: "w1:p1", tabId: "w1:t1" });
    expect((cli.runJson as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0])).not.toContainEqual(expect.arrayContaining(["pane", "split"]));
  });

  it("sends an initial prompt only after start and verifies working", async () => {
    const { promise, calls } = launch({ initialPrompt: "begin" });
    const result = await promise;
    expect(calls[3]).toEqual(["agent", "start", "worker", "--kind", "pi", "--pane", "w1:p2", "--timeout", "120000"]);
    expect(calls[4]).toEqual(["agent", "prompt", "w1:p2", assignmentEnvelope("begin"), "--wait", "--until", "working", "--timeout", "5000"]);
    expect(calls[5]).toEqual(["pane", "get", "w1:p2"]);
    expect(result.details).toMatchObject({ postState: { agent_status: "working" }, initialPromptSent: true, envelope: { version: "v1", kind: "assignment" }, sender: { paneId: "w1:p1", display: "caller" } });
  });

  it("fails before placement when an initial-prompt caller pane is absent", async () => {
    const { cli, calls } = makeCli();
    const snapshotWithoutCaller = { ...snapshot, panes: [] };
    cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv) => {
      calls.push(argv);
      if (argv[0] === "api") return ok("snapshot", { type: "session_snapshot", snapshot: snapshotWithoutCaller });
      throw new Error(`unexpected mutation: ${argv.join(" ")}`);
    });
    await expect(createLaunchTool({ cli, context, cwd: "/repo" }).execute("id", { name: "worker", kind: "pi", initialPrompt: "begin" }, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "SENDER_IDENTITY_UNAVAILABLE" });
    expect(calls).toEqual([["api", "snapshot"]]);
  });

  it("rejects unknown kinds, invalid Herdr names, and invalid placement before mutation", async () => {
    const cases: LaunchParams[] = [
      { name: "worker", kind: "unknown" as never },
      { name: "", kind: "pi" },
      { name: "Worker", kind: "pi" },
      { name: "worker.name", kind: "pi" },
      { name: `w${"x".repeat(32)}`, kind: "pi" },
      { name: "worker", kind: "pi", placement: { mode: "new_tab", tabLabel: "" } },
      { name: "worker", kind: "pi", placement: { mode: "existing_pane", target: "missing" } }
    ];
    for (const params of cases) {
      const { cli, calls } = makeCli();
      await expect(createLaunchTool({ cli, context }).execute("id", params, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: expect.any(String) });
      expect(calls.filter((call) => call[0] !== "api")).toHaveLength(0);
    }
  });

  it("rejects duplicate and ambiguous exact names using authoritative snapshot", async () => {
    const duplicate = { ...snapshot, agents: [{ pane_id: "w1:p1", name: "worker" }] };
    const cli: LaunchCli = { runJson: vi.fn<LaunchCli["runJson"]>(async (argv) => ok("x", argv[0] === "api" ? { type: "session_snapshot", snapshot: duplicate } : {})) };
    await expect(createLaunchTool({ cli, context }).execute("id", { name: "worker", kind: "pi" }, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("preserves created IDs and never closes resources on partial failure", async () => {
    const { cli, calls } = makeCli();
    cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv) => {
      calls.push(argv);
      if (argv[0] === "api") return ok("snapshot", { type: "session_snapshot", snapshot });
      if (argv[0] === "pane" && argv[1] === "split") return ok("split", { pane: { pane_id: "w1:p9", tab_id: "w1:t1" } });
      if (argv[0] === "pane" && argv[1] === "rename") throw Object.assign(new Error("rename failed"), { code: "CLI_PROTOCOL_ERROR" });
      throw new Error(`unexpected argv: ${argv.join(" ")}`);
    });
    await expect(createLaunchTool({ cli, context }).execute("id", { name: "worker", kind: "pi" }, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "LAUNCH_FAILED", details: { created: { paneId: "w1:p9", tabId: "w1:t1" } } });
    expect(calls.some((call) => call[0] === "pane" && call[1] === "close")).toBe(false);
  });

  it("streams bounded placement, readiness, and prompt progress", async () => {
    const updates: unknown[] = [];
    const { cli } = makeCli();
    const tool = createLaunchTool({ cli, context, cwd: "/repo" });
    await tool.execute("id", { name: "worker", kind: "pi", initialPrompt: "go" }, new AbortController().signal, (update) => updates.push(update), extensionContext);
    expect(updates.map((update) => (update as { details?: { phase?: string } }).details?.phase)).toEqual(["placement", "agent_start", "ready", "prompt_verification"]);
    expect(updates.every((update) => !(update as { content?: Array<{ text?: string }> }).content?.some((item) => item.text?.includes("value with spaces")))).toBe(true);
  });

  it("keeps runtime validation strict for malformed direct tool calls", () => {
    const valid = { name: "worker", kind: "pi" } as LaunchParams;
    const invalid: unknown[] = [
      null,
      { ...valid, kind: "unknown" },
      { ...valid, name: "" },
      { ...valid, argv: 1 },
      { ...valid, argv: [1] },
      { ...valid, argv: ["bad\0arg"] },
      { ...valid, label: 1 },
      { ...valid, label: "" },
      { ...valid, cwd: 1 },
      { ...valid, cwd: "" },
      { ...valid, initialPrompt: 1 },
      { ...valid, initialPrompt: "" },
      { ...valid, initialPrompt: "bad\0prompt" },
      { ...valid, focus: 1 },
      { ...valid, env: null },
      { ...valid, env: { "": "value" } },
      { ...valid, env: { KEY: 1 } },
      { ...valid, env: { "A=B": "value" } },
      { ...valid, placement: null },
      { ...valid, placement: 1 },
      { ...valid, placement: { mode: 1 } },
      { ...valid, placement: { mode: "same_tab", extra: true } },
      { ...valid, placement: { mode: "new_tab", tabLabel: "agents", extra: true } },
      { ...valid, placement: { mode: "new_tab" } },
      { ...valid, placement: { mode: "existing_pane", target: "target", extra: true } },
      { ...valid, placement: { mode: "existing_pane" } },
      { ...valid, placement: { mode: "unsupported" } }
    ];
    for (const params of invalid) {
      expect(() => validateLaunchParams(params as never)).toThrowError();
    }
    expect(() => validateLaunchParams({ ...valid, argv: [], env: {}, placement: { mode: "same_tab" } })).not.toThrow();
  });

  it("handles authoritative response variants and rejects missing placement IDs", async () => {
    const variants = [
      { new_pane: { pane_id: "w1:p2" } },
      { new_pane: { pane_id: "w1:p2", tab_id: "w1:t1" } },
      { child_pane: { pane_id: "w1:p2", tab_id: "w1:t1" } },
      { created_pane: { pane_id: "w1:p2", tab_id: "w1:t1" } },
      { pane_id: "w1:p2", tab_id: "w1:t1" }
    ];
    for (const placement of variants) {
      const { cli } = makeCli();
      cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv) => {
        if (argv[0] === "api") return ok("snapshot", { type: "session_snapshot", snapshot });
        if (argv[0] === "pane" && argv[1] === "split") return ok("split", placement);
        if (argv[0] === "pane" && argv[1] === "rename") return ok("rename", {});
        if (argv[0] === "agent" && argv[1] === "start") return ok("start", { agent: { name: "worker" } });
        if (argv[0] === "pane" && argv[1] === "get") return ok("get", { pane: { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", agent_status: "idle" } });
        throw new Error(`unexpected argv: ${argv.join(" ")}`);
      });
      await expect(createLaunchTool({ cli, context, cwd: "/repo" }).execute("id", { name: "worker", kind: "pi" }, new AbortController().signal, undefined, extensionContext)).resolves.toMatchObject({ details: { paneId: "w1:p2" } });
    }

    const { cli, calls } = makeCli();
    cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv) => {
      calls.push(argv);
      if (argv[0] === "api") return ok("snapshot", { type: "session_snapshot", snapshot });
      if (argv[0] === "pane" && argv[1] === "split") return ok("split", {});
      throw new Error(`unexpected argv: ${argv.join(" ")}`);
    });
    await expect(createLaunchTool({ cli, context, cwd: "/repo" }).execute("id", { name: "worker", kind: "pi" }, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "LAUNCH_FAILED" });
    expect(calls.some((call) => call[0] === "pane" && call[1] === "close")).toBe(false);
  });

  it("rejects non-object pane placement responses before any dependent mutation", async () => {
    const { cli } = makeCli();
    cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv) => {
      if (argv[0] === "api") return ok("snapshot", { type: "session_snapshot", snapshot });
      if (argv[0] === "pane" && argv[1] === "split") return ok("split", null);
      throw new Error(`unexpected argv: ${argv.join(" ")}`);
    });
    await expect(createLaunchTool({ cli, context, cwd: "/repo" }).execute("id", { name: "worker", kind: "pi" }, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "LAUNCH_FAILED" });
  });

  it("uses the tab lookup fallback and rejects malformed tab responses", async () => {
    const { cli, calls } = makeCli();
    cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv) => {
      calls.push(argv);
      if (argv[0] === "api") return ok("snapshot", { type: "session_snapshot", snapshot });
      if (argv[0] === "tab" && argv[1] === "create") return ok("tab", { tab: { tab_id: "w1:t2", workspace_id: "w1" } });
      if (argv[0] === "tab" && argv[1] === "get") return ok("tab", { pane: { pane_id: "w1:p3", tab_id: "w1:t2", workspace_id: "w1" } });
      if (argv[0] === "pane" && argv[1] === "rename") return ok("rename", {});
      if (argv[0] === "agent" && argv[1] === "start") return ok("start", { name: "authoritative-name" });
      if (argv[0] === "pane" && argv[1] === "get") return ok("get", { pane: { pane_id: "w1:p3", tab_id: "w1:t2", workspace_id: "w1", agent_status: "idle" } });
      throw new Error(`unexpected argv: ${argv.join(" ")}`);
    });
    await expect(createLaunchTool({ cli, context, cwd: "/repo" }).execute("id", { name: "worker", kind: "pi", placement: { mode: "new_tab", tabLabel: "agents" } }, new AbortController().signal, undefined, extensionContext)).resolves.toMatchObject({ details: { name: "authoritative-name", tabId: "w1:t2", paneId: "w1:p3" } });
    expect(calls).toContainEqual(["tab", "get", "w1:t2"]);

    const malformed = [null, {}, { tab: {} }, { tab: [] }];
    for (const result of malformed) {
      const malformedCli: LaunchCli = { runJson: vi.fn<LaunchCli["runJson"]>(async (argv) => {
        if (argv[0] === "api") return ok("snapshot", { type: "session_snapshot", snapshot });
        if (argv[0] === "tab" && argv[1] === "create") return ok("tab", result);
        throw new Error(`unexpected argv: ${argv.join(" ")}`);
      }) };
      await expect(createLaunchTool({ cli: malformedCli, context, cwd: "/repo" }).execute("id", { name: "worker", kind: "pi", placement: { mode: "new_tab", tabLabel: "agents" } }, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "LAUNCH_FAILED" });
    }
  });

  it("fails before mutation for existing-pane environment and missing current context", async () => {
    const { cli, calls } = makeCli();
    await expect(createLaunchTool({ cli, context }).execute("id", { name: "worker", kind: "pi", placement: { mode: "existing_pane", target: "caller" }, env: { SECRET: "do-not-echo" } }, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(calls).toHaveLength(1);

    const noWorkspace = { tabId: "w1:t1", paneId: "w1:p1" };
    const { cli: tabCli, calls: tabCalls } = makeCli();
    await expect(createLaunchTool({ cli: tabCli, context: noWorkspace, cwd: "/repo" }).execute("id", { name: "worker", kind: "pi", placement: { mode: "new_tab", tabLabel: "agents" } }, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "CONTEXT_UNAVAILABLE" });
    expect(tabCalls).toHaveLength(1);
  });

  it("fails closed on malformed snapshots, pane states, and post-prompt state", async () => {
    const malformedSnapshot: LaunchCli = { runJson: vi.fn<LaunchCli["runJson"]>(async (argv) => ok("x", argv[0] === "api" ? { type: "wrong" } : {})) };
    await expect(createLaunchTool({ cli: malformedSnapshot, context, cwd: "/repo" }).execute("id", { name: "worker", kind: "pi" }, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });

    for (const [pane, expectedCode] of [
      [null, "LAUNCH_FAILED"],
      [{}, "LAUNCH_FAILED"],
      [{ pane: null }, "LAUNCH_FAILED"],
      [{ pane: { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1" } }, "POSTSTATE_UNAVAILABLE"]
    ] as const) {
      const { cli } = makeCli();
      cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv) => {
        if (argv[0] === "api") return ok("snapshot", { type: "session_snapshot", snapshot });
        if (argv[0] === "pane" && argv[1] === "split") return ok("split", { pane: { pane_id: "w1:p2", tab_id: "w1:t1" } });
        if (argv[0] === "pane" && argv[1] === "rename") return ok("rename", {});
        if (argv[0] === "agent" && argv[1] === "start") return ok("start", { agent: { name: "worker" } });
        if (argv[0] === "agent" && argv[1] === "prompt") return ok("prompt", {});
        if (argv[0] === "pane" && argv[1] === "get") return ok("get", pane);
        throw new Error(`unexpected argv: ${argv.join(" ")}`);
      });
      await expect(createLaunchTool({ cli, context, cwd: "/repo" }).execute("id", { name: "worker", kind: "pi", initialPrompt: "go" }, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: expectedCode });
    }
  });

  it("recognizes authoritative names and pre-existing pane names without false collisions", async () => {
    const namedSnapshot = { ...snapshot, panes: [{ ...snapshot.panes[0], agent_name: "other" }, { pane_id: "w1:p3", tab_id: "w1:t1", workspace_id: "w1", agent: "third" }], agents: [{ pane_id: "w1:p1" }, { pane_id: "w1:p1", name: "other" }] };
    const { cli } = makeCli();
    const base = cli.runJson;
    cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal) => argv[0] === "api" ? ok("snapshot", { type: "session_snapshot", snapshot: namedSnapshot }) : base(argv, signal));
    await expect(createLaunchTool({ cli, context, cwd: "/repo" }).execute("id", { name: "worker", kind: "pi" }, new AbortController().signal, undefined, extensionContext)).resolves.toMatchObject({ details: { name: "worker" } });
  });

  it("handles aborts and truthful partial failure codes without cleanup", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const { cli, calls } = makeCli();
    await expect(createLaunchTool({ cli, context, cwd: "/repo" }).execute("id", { name: "worker", kind: "pi" }, aborted.signal, undefined, extensionContext)).rejects.toMatchObject({ code: "ABORTED" });
    expect(calls).toHaveLength(0);

    const late = new AbortController();
    const lateCli: LaunchCli = { runJson: vi.fn<LaunchCli["runJson"]>(async (argv) => {
      if (argv[0] === "api") { late.abort(); return ok("snapshot", { type: "session_snapshot", snapshot }); }
      throw new Error("must not mutate");
    }) };
    await expect(createLaunchTool({ cli: lateCli, context, cwd: "/repo" }).execute("id", { name: "worker", kind: "pi" }, late.signal, undefined, extensionContext)).rejects.toMatchObject({ code: "ABORTED" });

    const causes = ["READY_TIMEOUT", "POSTSTATE_UNAVAILABLE", "CLI_TIMEOUT"];
    for (const cause of causes) {
      const { cli: failureCli } = makeCli();
      failureCli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv) => {
        if (argv[0] === "api") return ok("snapshot", { type: "session_snapshot", snapshot });
        if (argv[0] === "pane" && argv[1] === "split") return ok("split", { pane: { pane_id: "w1:p9", tab_id: "w1:t1" } });
        if (argv[0] === "pane" && argv[1] === "rename") return ok("rename", {});
        if (argv[0] === "agent" && argv[1] === "start") throw Object.assign(new Error(cause), { code: cause });
        throw new Error(`unexpected argv: ${argv.join(" ")}`);
      });
      await expect(createLaunchTool({ cli: failureCli, context, cwd: "/repo" }).execute("id", { name: "worker", kind: "pi" }, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: cause === "READY_TIMEOUT" ? "READY_TIMEOUT" : cause === "POSTSTATE_UNAVAILABLE" ? "POSTSTATE_UNAVAILABLE" : "LAUNCH_FAILED", details: { created: { paneId: "w1:p9", tabId: "w1:t1" }, causeCode: cause } });
    }

    const focusFailure = makeCli();
    focusFailure.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv) => {
      if (argv[0] === "api") return ok("snapshot", { type: "session_snapshot", snapshot });
      if (argv[0] === "agent" && argv[1] === "start") return ok("start", { agent: { name: "worker" } });
      if (argv[0] === "agent" && argv[1] === "focus") throw Object.assign(new Error("focus timed out"), { code: "CLI_TIMEOUT" });
      throw new Error(`unexpected argv: ${argv.join(" ")}`);
    });
    await expect(createLaunchTool({ cli: focusFailure.cli, context, cwd: "/repo" }).execute("id", { name: "worker", kind: "pi", placement: { mode: "existing_pane", target: "caller" }, focus: true }, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "READY_TIMEOUT", details: { causeCode: "CLI_TIMEOUT" } });

    const abortedAfterPlacement = new AbortController();
    const abortedCli = makeCli();
    abortedCli.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv) => {
      if (argv[0] === "api") return ok("snapshot", { type: "session_snapshot", snapshot });
      if (argv[0] === "pane" && argv[1] === "split") { abortedAfterPlacement.abort(); return ok("split", { pane: { pane_id: "w1:p9", tab_id: "w1:t1" } }); }
      throw new Error(`unexpected argv: ${argv.join(" ")}`);
    });
    await expect(createLaunchTool({ cli: abortedCli.cli, context, cwd: "/repo" }).execute("id", { name: "worker", kind: "pi" }, abortedAfterPlacement.signal, undefined, extensionContext)).rejects.toMatchObject({ code: "ABORTED", details: { created: { paneId: "w1:p9", tabId: "w1:t1" } } });

    const { cli: stringCli } = makeCli();
    stringCli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv) => {
      if (argv[0] === "api") return ok("snapshot", { type: "session_snapshot", snapshot });
      if (argv[0] === "pane" && argv[1] === "split") return ok("split", { pane: { pane_id: "w1:p9", tab_id: "w1:t1" } });
      if (argv[0] === "pane" && argv[1] === "rename") return ok("rename", {});
      if (argv[0] === "agent" && argv[1] === "start") throw "string failure";
      throw new Error(`unexpected argv: ${argv.join(" ")}`);
    });
    await expect(createLaunchTool({ cli: stringCli, context, cwd: "/repo" }).execute("id", { name: "worker", kind: "pi" }, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "LAUNCH_FAILED", details: { causeCode: "CLI_PROTOCOL_ERROR" } });
  });

  it("preserves IDs from a completed production placement when abort races the CLI response", async () => {
    const controller = new AbortController();
    const exec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { type: "session_snapshot", snapshot } }), stderr: "", code: 0, killed: false };
      if (argv[0] === "pane" && argv[1] === "split") {
        controller.abort();
        return { stdout: JSON.stringify({ id: "split", result: { pane: { pane_id: "w1:p9", tab_id: "w1:t1" } } }), stderr: "", code: 0, killed: false };
      }
      throw new Error(`unexpected argv: ${argv.join(" ")}`);
    });
    const tool = createLaunchTool({ cli: new HerdrCli(exec), context, cwd: "/repo" });
    await expect(tool.execute("id", { name: "worker", kind: "pi" }, controller.signal, undefined, extensionContext)).rejects.toMatchObject({
      code: "ABORTED",
      details: { created: { paneId: "w1:p9", tabId: "w1:t1" } }
    });
  });

  it("renders compact calls and results", () => {
    const tool = createLaunchTool({ cli: makeCli().cli, context, cwd: "/repo" });
    const call = tool.renderCall?.({ name: "worker", kind: "pi" } as never, {} as never, {} as never);
    expect(call?.render(80)).toEqual(["herdr_launch · pi · worker"]);
    call?.invalidate();
    const result = tool.renderResult?.({ content: [], details: { operation: "launch", outcome: "launched", paneId: "w1:p2" }, isError: false } as never, {} as never, {} as never, {} as never);
    expect(result?.render(80)).toEqual(["launch · w1:p2"]);
    result?.invalidate();
    const partial = tool.renderResult?.({ content: [], details: { operation: "launch", outcome: "partial", paneId: "w1:p9" }, isError: true } as never, {} as never, {} as never, {} as never);
    expect(partial?.render(80)).toEqual(["partial · w1:p9"]);
    partial?.invalidate();
  });
});
