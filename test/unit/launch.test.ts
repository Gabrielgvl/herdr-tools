import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLaunchTool as createLaunchToolImplementation, validateLaunchParams, type LaunchCli, type LaunchDependencies } from "../../src/tools/launch.js";
import { LaunchParamsSchema, type LaunchParams } from "../../src/launch-schema.js";
import { parseProfile, profileSource, type ProfileCatalog } from "../../src/profiles/index.js"
import type { HerdrSnapshot } from "../../src/targets.js";

const testPreflight = async () => undefined;
const createLaunchTool = (deps: Omit<LaunchDependencies, "preflight"> & Partial<Pick<LaunchDependencies, "preflight">>) => createLaunchToolImplementation({ ...deps, preflight: deps.preflight ?? testPreflight });

const snapshot: HerdrSnapshot = {
  version: "0.8.0",
  protocol: 19,
  workspaces: [{ workspace_id: "w1", label: "workspace", focused: true }],
  tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main", focused: true }],
  panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "caller", agent_status: "idle" }],
  agents: []
};
const context = { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" };
const extensionContext = { cwd: "/repo", hasUI: false } as ExtensionContext;
const ok = (id: string, result: unknown) => ({ id, result });
const envelope = (payload: string) => `[HERDR AGENT MESSAGE v1]\nfrom: caller (w1:p1)\nkind: assignment\nauthority: agent; not user/owner\npayload: all text after this blank line is sender-authored\n\n${payload}`;

function profile(name: string, kind: "pi" | "claude" = "pi", fallbackProfiles: string[] = []) {
  const runtime = kind === "pi"
    ? "  kind: pi\n  model: test/model\n  thinking: low\n  tools: [read]"
    : "  kind: claude\n  model: claude/test\n  effort: medium\n  permissionMode: dontAsk\n  allowedTools: [Read]\n  disallowedTools: [Edit]";
  return parseProfile(`---\nname: ${name}\ndescription: ${name}\ntimeoutMinutes: 30\nsessionPersistence: ${kind === "claude"}\nruntime:\n${runtime}\nfallbackProfiles: ${JSON.stringify(fallbackProfiles)}\n---\n\nProfile body for ${name}.\n`, profileSource("bundled", `/profiles/${name}.md`, "/profiles"));
}

function catalog(...profiles: ReturnType<typeof profile>[]): ProfileCatalog {
  return { effective: new Map(profiles.map((item) => [item.name, item])), candidates: [], diagnostics: [] };
}

function makeCli(options: { start?: (argv: string[], attempt: number) => unknown; paneStates?: Array<Record<string, unknown>>; calls?: string[][] } = {}) {
  const calls = options.calls ?? [];
  let paneReads = 0;
  let starts = 0;
  const cli: LaunchCli = {
    runJson: vi.fn<LaunchCli["runJson"]>(async (argv) => {
      calls.push(argv);
      if (argv[0] === "api") return ok("snapshot", { type: "session_snapshot", snapshot });
      if (argv[0] === "pane" && argv[1] === "split") return ok("split", { pane: { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1" } });
      if (argv[0] === "pane" && argv[1] === "rename") return ok("rename", {});
      if (argv[0] === "tab" && argv[1] === "create") return ok("tab", { tab: { tab_id: "w1:t2", workspace_id: "w1" }, root_pane: { pane_id: "w1:p3", tab_id: "w1:t2", workspace_id: "w1" } });
      if (argv[0] === "agent" && argv[1] === "start") {
        const attempt = starts++;
        if (options.start) return options.start(argv, attempt) as Awaited<ReturnType<LaunchCli["runJson"]>>;
        return ok("start", { agent: { name: "worker", agent_id: `agent-${attempt}` } });
      }
      if (argv[0] === "agent" && argv[1] === "prompt") return ok("prompt", { ok: true });
      if (argv[0] === "agent" && argv[1] === "focus") return ok("focus", {});
      if (argv[0] === "pane" && argv[1] === "get") {
        const configured = options.paneStates?.[paneReads++];
        const paneId = calls.some((call) => call[0] === "tab" && call[1] === "create") ? "w1:p3" : "w1:p2";
        return ok("get", { pane: configured ?? { pane_id: paneId, tab_id: paneId === "w1:p3" ? "w1:t2" : "w1:t1", workspace_id: "w1", agent_name: "worker", agent_status: "working" } });
      }
      if (argv[0] === "tab" && argv[1] === "get") return ok("tab-get", { pane: { pane_id: "w1:p3", tab_id: "w1:t2", workspace_id: "w1:t2" } });
      throw new Error(`unexpected argv: ${argv.join(" ")}`);
    })
  };
  return { cli, calls };
}

function launch(params: LaunchParams, profiles: ProfileCatalog, cli = makeCli().cli, promptSources = { create: vi.fn(async () => ({ path: "/cache/body.md" })) }) {
  const tool = createLaunchTool({ cli, context, cwd: "/repo", profiles: { load: async () => profiles }, promptSources });
  return tool.execute("id", params, new AbortController().signal, undefined, extensionContext);
}

describe("herdr_launch profile-only contract", () => {
  it("rejects raw kind, argv, and env schemas", () => {
    expect(LaunchParamsSchema).toMatchObject({ type: "object", additionalProperties: false, required: expect.arrayContaining(["name", "profile"]) });
    expect(LaunchParamsSchema).not.toHaveProperty("anyOf");
    for (const value of [
      { name: "worker", kind: "pi" },
      { name: "worker", profile: "worker", argv: ["--model", "x"] },
      { name: "worker", profile: "worker", env: { X: "y" } },
      { name: "worker", profile: "worker", kind: "pi" }
    ]) expect(() => validateLaunchParams(value as never)).toThrow();
    expect(() => validateLaunchParams({ name: "worker", profile: "worker" })).not.toThrow();
  });

  it("fails closed for malformed direct calls and every placement shape", () => {
    const valid = { name: "worker", profile: "worker" };
    const invalid: unknown[] = [
      null, {}, { ...valid, name: "" }, { ...valid, name: "Bad" }, { ...valid, name: "x".repeat(33) },
      { ...valid, unknown: true }, { ...valid, profile: "" }, { ...valid, profile: "bad\nprofile" },
      { ...valid, overrides: null }, { ...valid, overrides: { unknown: true } }, { ...valid, overrides: { model: "" } },
      ...["tools", "extensions", "skills", "allowedTools", "disallowedTools", "addDirs", "pluginDirs"].map((key) => ({ ...valid, overrides: { [key]: ["bad\nvalue"] } })),
      ...["tools", "extensions", "skills", "allowedTools", "disallowedTools", "addDirs", "pluginDirs"].map((key) => ({ ...valid, overrides: { [key]: 1 } })),
      { ...valid, label: "" }, { ...valid, cwd: "" }, { ...valid, initialPrompt: "" }, { ...valid, initialPrompt: 1 }, { ...valid, focus: 1 },
      { ...valid, placement: null }, { ...valid, placement: 1 }, { ...valid, placement: { mode: "same_tab", extra: true } },
      { ...valid, placement: { mode: "new_tab" } }, { ...valid, placement: { mode: "new_tab", tabLabel: "agents", extra: true } },
      { ...valid, placement: { mode: "existing_pane" } }, { ...valid, placement: { mode: "existing_pane", target: "target", extra: true } },
      { ...valid, placement: { mode: "unsupported" } }
    ];
    for (const value of invalid) expect(() => validateLaunchParams(value as never)).toThrow();
    expect(() => validateLaunchParams({ ...valid, overrides: { model: "m", tools: [], extensions: [], skills: [], allowedTools: [], disallowedTools: [], addDirs: [], pluginDirs: [] }, placement: { mode: "same_tab" } })).not.toThrow();
  });

  it("covers exact startup identities, pane variants, prompt recovery, and terminal renderers", async () => {
    const worker = profile("worker");
    for (const startResult of [null, {}, { agent: {} }, { agent: null }]) {
      const harness = makeCli();
      const base = harness.cli.runJson;
      harness.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => argv[0] === "agent" && argv[1] === "start" ? ok("start", startResult) : base(argv, signal, preserve));
      await expect(launch({ name: "worker", profile: "worker" }, catalog(worker), harness.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED" });
    }

    const paneVariants = [{ pane: { pane_id: "w1:p2", tab_id: "w1:t1" } }, { root_pane: { pane_id: "w1:p2", tab_id: "w1:t1" } }, { new_pane: { pane_id: "w1:p2" } }, { child_pane: { pane_id: "w1:p2" } }, { created_pane: { pane_id: "w1:p2" } }, { pane_id: "w1:p2", tab_id: "w1:t1" }];
    for (const placement of paneVariants) {
      const harness = makeCli();
      const base = harness.cli.runJson;
      harness.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => argv[0] === "pane" && argv[1] === "split" ? ok("split", placement) : base(argv, signal, preserve));
      await expect(launch({ name: "worker", profile: "worker" }, catalog(worker), harness.cli)).resolves.toMatchObject({ details: { paneId: "w1:p2" } });
    }

    for (const placement of [null, {}, { pane_id: "" }]) {
      const malformed = makeCli();
      const malformedBase = malformed.cli.runJson;
      malformed.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => argv[0] === "pane" && argv[1] === "split" ? ok("split", placement) : malformedBase(argv, signal, preserve));
      await expect(launch({ name: "worker", profile: "worker" }, catalog(worker), malformed.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED" });
    }

    const stalled = makeCli();
    const stalledBase = stalled.cli.runJson;
    stalled.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
      if (argv[0] === "agent" && argv[1] === "prompt") throw Object.assign(new Error("stalled"), { code: "CLI_PROTOCOL_ERROR", details: { exitCode: 1, killed: false, stderr: JSON.stringify({ id: "cli:agent:prompt", error: { code: "agent_prompt_stalled", message: "agent prompt produced no observed state change within 5000 ms; status is idle and state_change_seq remained 7" } }) } });
      if (argv[0] === "agent" && argv[1] === "send-keys") return ok("keys", {});
      if (argv[0] === "agent" && argv[1] === "wait") return ok("wait", {});
      return stalledBase(argv, signal, preserve);
    });
    await expect(launch({ name: "worker", profile: "worker", initialPrompt: "go" }, catalog(worker), stalled.cli)).resolves.toMatchObject({ details: { initialPromptSent: true } });

    const safeEvidence = makeCli({ paneStates: [{ pane_id: "w1:p2", tab_id: "w1:t1", agent_status: "none", agent_id: 1, status: {} }] });
    const safeBase = safeEvidence.cli.runJson;
    safeEvidence.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
      if (argv[0] === "agent" && argv[1] === "start") throw Object.assign(new Error("process exited before becoming interactive"), { code: "agent_start_failed", details: { stderr: "{" } });
      return safeBase(argv, signal, preserve);
    });
    await expect(launch({ name: "worker", profile: "worker" }, catalog(worker), safeEvidence.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED" });

    const tool = createLaunchTool({ cli: makeCli().cli, context, cwd: "/repo", profiles: { load: async () => catalog(worker) } });
    const rendered = tool.renderResult?.({ content: [], details: { operation: "launch", outcome: "launched", paneId: "w1:p2" }, isError: false } as never, {} as never, {} as never, {} as never);
    expect(rendered?.render(80)).toEqual(["launch · w1:p2"]);

    const malformedPane = makeCli();
    const malformedBase = malformedPane.cli.runJson;
    malformedPane.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => argv[0] === "pane" && argv[1] === "get" ? ok("get", null) : malformedBase(argv, signal, preserve));
    await expect(launch({ name: "worker", profile: "worker" }, catalog(worker), malformedPane.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED" });

    const mismatchPane = makeCli();
    const mismatchBase = mismatchPane.cli.runJson;
    mismatchPane.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => argv[0] === "pane" && argv[1] === "get" ? ok("get", { pane: { pane_id: "wrong" } }) : mismatchBase(argv, signal, preserve));
    await expect(launch({ name: "worker", profile: "worker" }, catalog(worker), mismatchPane.cli)).rejects.toMatchObject({ code: "POSTSTATE_UNAVAILABLE" });

    for (const placement of [null, {}, { tab: {} }, { tab: { tab_id: "" } }]) {
      const tabHarness = makeCli();
      const tabBase = tabHarness.cli.runJson;
      tabHarness.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => argv[0] === "tab" && argv[1] === "create" ? ok("tab", placement) : tabBase(argv, signal, preserve));
      await expect(launch({ name: "worker", profile: "worker", placement: { mode: "new_tab", tabLabel: "agents" } }, catalog(worker), tabHarness.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED" });
    }

    const tabLookup = makeCli();
    const tabLookupBase = tabLookup.cli.runJson;
    tabLookup.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
      if (argv[0] === "tab" && argv[1] === "create") return ok("tab", { tab: { tab_id: "w1:t2" } });
      if (argv[0] === "tab" && argv[1] === "get") return ok("tab", { rootPane: { pane_id: "w1:p3", tab_id: "w1:t2" } });
      if (argv[0] === "pane" && argv[1] === "get") return ok("get", { pane: { pane_id: "w1:p3", tab_id: "w1:t2", workspace_id: "w1", agent_name: "worker", agent_status: "idle" } });
      return tabLookupBase(argv, signal, preserve);
    });
    await expect(launch({ name: "worker", profile: "worker", placement: { mode: "new_tab", tabLabel: "agents" } }, catalog(worker), tabLookup.cli)).resolves.toMatchObject({ details: { paneId: "w1:p3" } });

    const nonNamedAgent = makeCli();
    const nonNamedBase = nonNamedAgent.cli.runJson;
    nonNamedAgent.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => argv[0] === "api" ? ok("snapshot", { type: "session_snapshot", snapshot: { ...snapshot, agents: [{ pane_id: "w1:p9" }] } }) : nonNamedBase(argv, signal, preserve));
    await expect(launch({ name: "worker", profile: "worker" }, catalog(worker), nonNamedAgent.cli)).resolves.toMatchObject({ details: { name: "worker" } });

    const duplicate = makeCli();
    const duplicateBase = duplicate.cli.runJson;
    duplicate.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => argv[0] === "api" ? ok("snapshot", { type: "session_snapshot", snapshot: { ...snapshot, agents: [{ pane_id: "w1:p9", name: "worker" }] } }) : duplicateBase(argv, signal, preserve));
    await expect(launch({ name: "worker", profile: "worker" }, catalog(worker), duplicate.cli)).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const stringNamedPane = makeCli();
    const stringNamedBase = stringNamedPane.cli.runJson;
    stringNamedPane.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => argv[0] === "api" ? ok("snapshot", { type: "session_snapshot", snapshot: { ...snapshot, panes: [...snapshot.panes, { pane_id: "w1:p9", tab_id: "w1:t1", workspace_id: "w1", agent: "other" }] } }) : stringNamedBase(argv, signal, preserve));
    await expect(launch({ name: "worker", profile: "worker" }, catalog(worker), stringNamedPane.cli)).resolves.toMatchObject({ details: { name: "worker" } });

    const namedPane = makeCli();
    const namedBase = namedPane.cli.runJson;
    namedPane.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => argv[0] === "api" ? ok("snapshot", { type: "session_snapshot", snapshot: { ...snapshot, panes: [...snapshot.panes, { pane_id: "w1:p9", tab_id: "w1:t1", workspace_id: "w1", agent_name: "other" }] } }) : namedBase(argv, signal, preserve));
    await expect(launch({ name: "worker", profile: "worker" }, catalog(worker), namedPane.cli)).resolves.toMatchObject({ details: { name: "worker" } });
  });

  it("covers guarded fallback, focus, and authoritative post-state refusals", async () => {
    const primary = profile("primary", "pi", ["fallback"]);
    const fallback = profile("fallback");

    const readFailure = makeCli({ start: () => { throw Object.assign(new Error("process exited before becoming interactive"), { code: "agent_start_failed" }); } });
    const readBase = readFailure.cli.runJson;
    readFailure.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => argv[0] === "pane" && argv[1] === "get" ? Promise.reject(new Error("read failed")) : readBase(argv, signal, preserve));
    await expect(launch({ name: "worker", profile: "primary" }, catalog(primary, fallback), readFailure.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED", details: { causeCode: "agent_start_failed" } });
    const readStringFailure = makeCli({ start: () => { throw Object.assign(new Error("process exited before becoming interactive"), { code: "agent_start_failed" }); } });
    const readStringBase = readStringFailure.cli.runJson;
    readStringFailure.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => argv[0] === "pane" && argv[1] === "get" ? Promise.reject("read failed") : readStringBase(argv, signal, preserve));
    await expect(launch({ name: "worker", profile: "primary" }, catalog(primary, fallback), readStringFailure.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED" });

    const aborted = new AbortController();
    const abortHarness = makeCli();
    const abortBase = abortHarness.cli.runJson;
    abortHarness.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
      if (argv[0] === "pane" && argv[1] === "split") { aborted.abort(); return abortBase(argv, signal, preserve); }
      return abortBase(argv, signal, preserve);
    });
    await expect(createLaunchTool({ cli: abortHarness.cli, context, cwd: "/repo", profiles: { load: async () => catalog(profile("worker")) } }).execute("id", { name: "worker", profile: "worker" }, aborted.signal, undefined, extensionContext)).rejects.toMatchObject({ code: "ABORTED" });

    const exhausted = makeCli({ paneStates: [{ pane_id: "w1:p2", tab_id: "w1:t1", agent_status: "none" }, { pane_id: "w1:p2", tab_id: "w1:t1", agent_status: "none" }], start: () => { throw Object.assign(new Error("process exited before becoming interactive"), { code: "agent_start_failed" }); } });
    await expect(launch({ name: "worker", profile: "primary" }, catalog(primary, fallback), exhausted.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED", details: { causeCode: "agent_start_failed", attempts: expect.arrayContaining([expect.objectContaining({ profile: "fallback" })]) } });

    const focused = makeCli();
    const focusedBase = focused.cli.runJson;
    focused.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => argv[0] === "pane" && argv[1] === "get" ? ok("get", { pane: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", agent_name: "worker", agent_status: "idle" } }) : focusedBase(argv, signal, preserve));
    await expect(launch({ name: "worker", profile: "worker", placement: { mode: "existing_pane", target: "caller" }, focus: true }, catalog(profile("worker")), focused.cli)).resolves.toMatchObject({ details: { paneId: "w1:p1" } });
    expect(focused.calls).toContainEqual(["agent", "focus", "w1:p1"]);
    for (const focusError of ["CLI_TIMEOUT", "READY_TIMEOUT"]) {
      const focusFailure = makeCli();
      const focusBase = focusFailure.cli.runJson;
      focusFailure.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => argv[0] === "agent" && argv[1] === "focus" ? Promise.reject(Object.assign(new Error(focusError), { code: focusError })) : focusBase(argv, signal, preserve));
      await expect(launch({ name: "worker", profile: "worker", placement: { mode: "existing_pane", target: "caller" }, focus: true }, catalog(profile("worker")), focusFailure.cli)).rejects.toMatchObject({ code: "READY_TIMEOUT" });
    }

    const idlePrompt = makeCli({ paneStates: [{ pane_id: "w1:p2", tab_id: "w1:t1", agent_name: "worker", agent_status: "idle" }] });
    await expect(launch({ name: "worker", profile: "worker", initialPrompt: "go" }, catalog(profile("worker")), idlePrompt.cli)).rejects.toMatchObject({ code: "POSTSTATE_UNAVAILABLE" });

    const unknownState = makeCli({ paneStates: [{ pane_id: "w1:p2", tab_id: "w1:t1", agent_name: "worker" }] });
    await expect(launch({ name: "worker", profile: "worker", initialPrompt: "go" }, catalog(profile("worker")), unknownState.cli)).rejects.toMatchObject({ code: "POSTSTATE_UNAVAILABLE" });

    const noName = makeCli();
    const noNameBase = noName.cli.runJson;
    noName.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
      if (argv[0] === "agent" && argv[1] === "start") return ok("start", { agent: { agent_id: "agent-only" } });
      if (argv[0] === "pane" && argv[1] === "get") return ok("get", { pane: { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", agent_status: "idle" } });
      return noNameBase(argv, signal, preserve);
    });
    await expect(launch({ name: "worker", profile: "worker" }, catalog(profile("worker")), noName.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED" });

    const disappearingRoot = profile("disappearing-root", "pi", ["disappearing-fallback"]);
    const disappearingFallback = profile("disappearing-fallback");
    const disappearingMap = new Map([[disappearingRoot.name, disappearingRoot], [disappearingFallback.name, disappearingFallback]]);
    let fallbackReads = 0;
    const originalGet = disappearingMap.get.bind(disappearingMap);
    disappearingMap.get = ((name: string) => name === disappearingFallback.name && fallbackReads++ > 0 ? undefined : originalGet(name)) as typeof disappearingMap.get;
    await expect(launch({ name: "worker", profile: "disappearing-root" }, { effective: disappearingMap, candidates: [], diagnostics: [] }, makeCli().cli)).rejects.toMatchObject({ code: "PROFILE_RESOLUTION_INVALID" });

    const stringFailure = makeCli({ start: () => { throw "string failure"; } });
    await expect(launch({ name: "worker", profile: "worker" }, catalog(profile("worker")), stringFailure.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED", details: { causeCode: "CLI_PROTOCOL_ERROR" } });

    const nestedEvidence = makeCli({ paneStates: [{ pane_id: "w1:p2", tab_id: "w1:t1", agent_status: "none" }] });
    const nestedBase = nestedEvidence.cli.runJson;
    nestedEvidence.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
      if (argv[0] === "agent" && argv[1] === "start") throw Object.assign(new Error("outer"), { code: "CLI_PROTOCOL_ERROR", details: { error: { code: "agent_start_failed", message: "process exited before becoming interactive" } } });
      return nestedBase(argv, signal, preserve);
    });
    await expect(launch({ name: "worker", profile: "worker" }, catalog(profile("worker")), nestedEvidence.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED" });

    for (const error of [
      Object.assign(new Error("bad"), { code: "CLI_PROTOCOL_ERROR" }),
      Object.assign(new Error("bad"), { code: "CLI_PROTOCOL_ERROR", details: { exitCode: 2, killed: false, stderr: "{}" } }),
      Object.assign(new Error("bad"), { code: "CLI_PROTOCOL_ERROR", details: { exitCode: 1, killed: false, stderr: "{" } }),
      Object.assign(new Error("bad"), { code: "CLI_PROTOCOL_ERROR", details: { exitCode: 1, killed: false, stderr: JSON.stringify({ id: "wrong", error: {} }) } }),
      new Error("plain")
    ]) {
      const promptFailure = makeCli();
      const promptBase = promptFailure.cli.runJson;
      promptFailure.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => argv[0] === "agent" && argv[1] === "prompt" ? Promise.reject(error) : promptBase(argv, signal, preserve));
      await expect(launch({ name: "worker", profile: "worker", initialPrompt: "go" }, catalog(profile("worker")), promptFailure.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED" });
    }
  });

  it("launches an arbitrary valid profile and reports effective runtime details", async () => {
    const worker = profile("custom-profile");
    const calls: string[][] = [];
    const promptSources = { create: vi.fn(async () => ({ path: "/cache/custom.md" })) };
    const result = await launch({ name: "worker", profile: "custom-profile", overrides: { model: "override/model", thinking: "high" } }, catalog(worker), makeCli({ calls }).cli, promptSources);
    expect(calls).toContainEqual(["agent", "start", "worker", "--kind", "pi", "--pane", "w1:p2", "--timeout", "1800000", "--", "--model", "override/model", "--thinking", "high", "--tools", "read", "--no-session", "--append-system-prompt", "/cache/custom.md"]);
    expect(result.details).toMatchObject({ profile: { name: "custom-profile", requested: "custom-profile", selected: "custom-profile", source: { path: "/profiles/custom-profile.md" }, timeoutMinutes: 30, runtime: { kind: "pi", model: "test/model", thinking: "low" }, permissions: { sessionPersistence: false }, attempts: [{ profile: "custom-profile", outcome: "selected" }] } });
  });

  it("stops before mutation when the catalog is unavailable and preserves abort evidence", async () => {
    const noProfiles = createLaunchTool({ cli: makeCli().cli, context, cwd: "/repo" });
    await expect(noProfiles.execute("id", { name: "worker", profile: "worker" }, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "PROFILE_CATALOG_UNAVAILABLE" });

    const preAborted = new AbortController();
    preAborted.abort();
    const preWorker = profile("pre-worker");
    const preTool = createLaunchTool({ cli: makeCli().cli, context, cwd: "/repo", profiles: { load: async () => catalog(preWorker) } });
    await expect(preTool.execute("id", { name: "worker", profile: "pre-worker" }, preAborted.signal, undefined, extensionContext)).rejects.toMatchObject({ code: "ABORTED" });

    const controller = new AbortController();
    const worker = profile("worker");
    const harness = makeCli();
    const base = harness.cli.runJson;
    harness.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
      if (argv[0] === "api") { controller.abort(); return base(argv, signal, preserve); }
      return base(argv, signal, preserve);
    });
    const abortTool = createLaunchTool({ cli: harness.cli, context, cwd: "/repo", profiles: { load: async () => catalog(worker) }, promptSources: { create: vi.fn(async () => ({ path: "/cache/body.md" })) } });
    await expect(abortTool.execute("id", { name: "worker", profile: "worker" }, controller.signal, undefined, extensionContext)).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("keeps prompt source creation and provenance before topology mutation", async () => {
    const order: string[] = [];
    const worker = profile("worker");
    const promptSources = { create: vi.fn(async () => { order.push("source"); return { path: "/cache/body.md" }; }) };
    const base = makeCli();
    const cli: LaunchCli = { runJson: vi.fn(async (argv, signal, preserve) => { order.push(argv.slice(0, 2).join(" ")); return base.cli.runJson(argv, signal, preserve); }) };
    const result = await launch({ name: "worker", profile: "worker", initialPrompt: "begin" }, catalog(worker), cli, promptSources);
    expect(order.slice(0, 4)).toEqual(["source", "api snapshot", "pane split", "pane rename"]);
    expect(base.calls).toContainEqual(["agent", "prompt", "w1:p2", envelope("begin"), "--wait", "--until", "working", "--timeout", "10000"]);
    expect(result.details).toMatchObject({ initialPromptSent: true, envelope: { version: "v1", kind: "assignment" } });
  });

  it("falls back only after exact typed start failure and authoritative no-agent proof", async () => {
    const first = profile("primary", "pi", ["fallback"]);
    const second = profile("fallback", "claude");
    const calls: string[][] = [];
    const result = await launch({ name: "worker", profile: "primary", overrides: { model: "override/model", thinking: "high" } }, catalog(first, second), makeCli({ calls, paneStates: [{ pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", agent_status: "none" }] , start: (argv, attempt) => {
      if (attempt === 0) throw Object.assign(new Error("process exited before becoming interactive"), { code: "agent_start_failed" });
      return ok("start", { agent: { name: "worker", agent_id: "agent-fallback" } });
    }}).cli);
    expect(calls.find((call) => call[0] === "agent" && call[1] === "start" && call[4] === "claude")).toEqual(["agent", "start", "worker", "--kind", "claude", "--pane", "w1:p2", "--timeout", "1800000", "--", "--model", "claude/test", "--effort", "medium", "--permission-mode", "dontAsk", "--allowed-tools", "Read", "--disallowed-tools", "Edit", "--append-system-prompt-file", "/cache/body.md"]);
    expect(calls.filter((call) => call[0] === "agent" && call[1] === "start")).toHaveLength(2);
    expect(result.details).toMatchObject({ kind: "claude", profile: { requested: "primary", selected: "fallback", attempts: [{ profile: "primary", outcome: "agent_start_failed", errorCode: "agent_start_failed" }, { profile: "fallback", outcome: "selected" }] } });
  });

  it("refuses fallback for mismatched errors, uncertain post-state, or an occupied pane", async () => {
    const primary = profile("primary", "pi", ["fallback"]);
    const fallback = profile("fallback", "pi");
    const mismatched = makeCli({ start: () => { throw Object.assign(new Error("process exited before becoming interactive"), { code: "agent_start_failed" }); }, paneStates: [{ pane_id: "w1:p2", tab_id: "w1:t1", agent_id: "still-running", agent_status: "working" }] });
    await expect(launch({ name: "worker", profile: "primary" }, catalog(primary, fallback), mismatched.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED", details: { causeCode: "agent_start_failed" } });
    expect(mismatched.calls.filter((call) => call[0] === "agent" && call[1] === "start")).toHaveLength(1);

    const wrongMessage = makeCli({ start: () => { throw Object.assign(new Error("other failure"), { code: "agent_start_failed" }); } });
    await expect(launch({ name: "worker", profile: "primary" }, catalog(primary, fallback), wrongMessage.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED" });
    expect(wrongMessage.calls.some((call) => call[0] === "pane" && call[1] === "get")).toBe(false);
  });

  it("preserves all placement modes without exposing raw environment launch", async () => {
    const worker = profile("worker");
    const newTab = makeCli();
    await expect(launch({ name: "worker", profile: "worker", placement: { mode: "new_tab", tabLabel: "agents" }, focus: true }, catalog(worker), newTab.cli)).resolves.toMatchObject({ details: { placement: { mode: "new_tab", tabLabel: "agents" }, tabId: "w1:t2", paneId: "w1:p3" } });
    expect(newTab.calls).toContainEqual(["tab", "create", "--workspace", "w1", "--cwd", "/repo", "--label", "agents", "--focus"]);

    const existing = { ...snapshot, panes: [{ ...snapshot.panes[0], label: "target" }] };
    const existingCli: LaunchCli = { runJson: vi.fn(async (argv) => {
      if (argv[0] === "api") return ok("snapshot", { type: "session_snapshot", snapshot: existing });
      if (argv[0] === "agent" && argv[1] === "start") return ok("start", { agent: { name: "worker" } });
      if (argv[0] === "pane" && argv[1] === "get") return ok("get", { pane: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", agent_name: "worker", agent_status: "idle" } });
      throw new Error(`unexpected ${argv.join(" ")}`);
    }) };
    await expect(launch({ name: "worker", profile: "worker", placement: { mode: "existing_pane", target: "target" } }, catalog(worker), existingCli)).resolves.toMatchObject({ details: { paneId: "w1:p1" } });
    expect((existingCli.runJson as ReturnType<typeof vi.fn>).mock.calls.some((call) => call[0][0] === "pane" && call[0][1] === "split")).toBe(false);
  });

  it("renders the requested profile and keeps communication independent", () => {
    const tool = createLaunchTool({ cli: makeCli().cli, context, cwd: "/repo", profiles: { load: async () => catalog(profile("worker")) } });
    const call = tool.renderCall?.({ name: "worker", profile: "worker" } as never, {} as never, {} as never);
    expect(call?.render(80)).toEqual(["herdr_launch · worker · worker"]);
  });
});
