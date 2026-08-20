import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CliProtocolError } from "../../src/cli.js";
import { RuntimeOwnership } from "../../src/ownership.js";
import { createLaunchTool as createLaunchToolImplementation, validateLaunchParams, type LaunchCli, type LaunchDependencies } from "../../src/tools/launch.js";
import { LaunchParamsSchema, type LaunchParams } from "../../src/launch-schema.js";
import { RecipientRegistry } from "../../src/messages/recipients.js";
import type { AttachmentStore } from "../../src/messages/store.js";
import { parseProfile, profileSource, type ProfileCatalog } from "../../src/profiles/index.js";
import type { HerdrSnapshot } from "../../src/targets.js";

const testPreflight = async () => undefined;
const createLaunchTool = (deps: Omit<LaunchDependencies, "preflight"> & Partial<Pick<LaunchDependencies, "preflight">>) => createLaunchToolImplementation({ ...deps, preflight: deps.preflight ?? testPreflight });
const GRANT_PATH = "/cache/recipient";
const fakeGrant = () => ({ path: GRANT_PATH, token: "grant-recipient", renew: async () => undefined, release: async () => undefined });
const publishedAttachment = { attachmentId: "attachment-1", path: "/cache/recipient/attachment-1/body.txt", bytes: 4, sha256: "b".repeat(64), expiresAt: "2026-08-21T12:00:00.000Z" };
function fakeAttachments(overrides: Partial<AttachmentStore> = {}): AttachmentStore {
  return {
    root: "/cache",
    recipientDirectory: (key) => `/cache/${key}`,
    ensureRecipient: vi.fn(async () => fakeGrant()),
    publish: vi.fn(async () => publishedAttachment),
    ...overrides
  };
}

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
const startFailure = () => new CliProtocolError("CLI_PROTOCOL_ERROR", "Herdr CLI did not return a usable response", {
  exitCode: 1,
  killed: false,
  stderrTruncated: false,
  stderr: JSON.stringify({ id: "cli:agent:start", error: { code: "agent_start_failed", message: "agent process exited before becoming interactive" } })
});
const envelope = (payload: string) => `[HERDR AGENT MESSAGE v1]\nfrom: caller (w1:p1)\nkind: assignment\nauthority: agent; not user/owner\ndelivery: inline\npayload: all text after this blank line is sender-authored\n\n${payload}`;
const PROMPT_ARGV = (paneId: string) => ["agent", "prompt", paneId, "--stdin", "--wait", "--until", "working", "--timeout", "5000"];

function profile(name: string, kind: "pi" | "claude" = "pi", fallbackProfiles: string[] = []) {
  const runtime = kind === "pi"
    ? "  kind: pi\n  model: test/model\n  thinking: low\n  tools: [read]"
    : "  kind: claude\n  model: claude/test\n  effort: medium\n  permissionMode: dontAsk\n  allowedTools: [Read]\n  disallowedTools: [Edit]";
  return parseProfile(`---\nname: ${name}\ndescription: ${name}\ntimeoutMinutes: 30\nsessionPersistence: ${kind === "claude"}\nruntime:\n${runtime}\nfallbackProfiles: ${JSON.stringify(fallbackProfiles)}\n---\n\nProfile body for ${name}.\n`, profileSource("bundled", `/profiles/${name}.md`, "/profiles"));
}

function catalog(...profiles: ReturnType<typeof profile>[]): ProfileCatalog {
  return { effective: new Map(profiles.map((item) => [item.name, item])), candidates: [], diagnostics: [] };
}

function makeCli(options: { start?: (argv: string[], attempt: number) => unknown; paneStates?: Array<Record<string, unknown>>; calls?: string[][]; stdinInputs?: string[]; snapshot?: HerdrSnapshot } = {}) {
  const calls = options.calls ?? [];
  const stdinInputs = options.stdinInputs ?? [];
  const liveSnapshot = options.snapshot ?? snapshot;
  let paneReads = 0;
  let starts = 0;
  let lastKind = "pi";
  const cli: LaunchCli = {
    runJsonWithStdin: vi.fn<NonNullable<LaunchCli["runJsonWithStdin"]>>(async (argv, input) => {
      calls.push(argv);
      stdinInputs.push(input);
      if (argv[0] === "agent" && argv[1] === "prompt") return ok("prompt", { ok: true });
      throw new Error(`unexpected stdin argv: ${argv.join(" ")}`);
    }),
    runJson: vi.fn<LaunchCli["runJson"]>(async (argv) => {
      calls.push(argv);
      if (argv[0] === "api") return ok("snapshot", { type: "session_snapshot", snapshot: liveSnapshot });
      if (argv[0] === "pane" && argv[1] === "split") return ok("split", { pane: { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1" } });
      if (argv[0] === "pane" && argv[1] === "rename") return ok("rename", {});
      if (argv[0] === "tab" && argv[1] === "create") return ok("tab", { tab: { tab_id: "w1:t2", workspace_id: "w1" }, root_pane: { pane_id: "w1:p3", tab_id: "w1:t2", workspace_id: "w1" } });
      if (argv[0] === "agent" && argv[1] === "start") {
        const attempt = starts++;
        lastKind = String(argv[4]);
        if (options.start) return options.start(argv, attempt) as Awaited<ReturnType<LaunchCli["runJson"]>>;
        const paneId = calls.some((call) => call[0] === "tab" && call[1] === "create") ? "w1:p3" : "w1:p2";
        return ok("start", { agent: { name: "worker", pane_id: paneId, agent: argv[4], terminal_id: `terminal-${attempt}` } });
      }
      if (argv[0] === "agent" && argv[1] === "prompt") return ok("prompt", { ok: true });
      if (argv[0] === "agent" && argv[1] === "focus") return ok("focus", {});
      if (argv[0] === "agent" && argv[1] === "get") return ok("agent-get", { agent: { name: "worker", pane_id: calls.some((call) => call[0] === "tab" && call[1] === "create") ? "w1:p3" : "w1:p2", agent: lastKind, agent_status: "working", state_change_seq: 7, agent_session: "session-worker" } });
      if (argv[0] === "pane" && argv[1] === "get") {
        const configured = options.paneStates?.[paneReads++];
        const paneId = calls.some((call) => call[0] === "tab" && call[1] === "create") ? "w1:p3" : "w1:p2";
        return ok("get", { pane: configured ?? { pane_id: paneId, tab_id: paneId === "w1:p3" ? "w1:t2" : "w1:t1", workspace_id: "w1", agent: lastKind, agent_status: "working" } });
      }
      if (argv[0] === "tab" && argv[1] === "get") return ok("tab-get", { pane: { pane_id: "w1:p3", tab_id: "w1:t2", workspace_id: "w1:t2" } });
      throw new Error(`unexpected argv: ${argv.join(" ")}`);
    })
  };
  return { cli, calls, stdinInputs };
}

function launch(
  params: LaunchParams,
  profiles: ProfileCatalog,
  cli = makeCli().cli,
  promptSources = { create: vi.fn(async () => ({ path: "/cache/body.md" })) },
  extras: { attachments?: AttachmentStore; recipients?: RecipientRegistry } = {}
) {
  const tool = createLaunchTool({
    cli,
    context,
    cwd: "/repo",
    profiles: { load: async () => profiles },
    promptSources,
    attachments: extras.attachments ?? fakeAttachments(),
    recipients: extras.recipients ?? new RecipientRegistry()
  });
  return tool.execute("id", params, new AbortController().signal, undefined, extensionContext);
}

describe("herdr_launch evidence redaction", () => {
  it("strips environment values from the authoritative post-state at every depth", async () => {
    const leaky = {
      pane_id: "w1:p2",
      tab_id: "w1:t1",
      workspace_id: "w1",
      agent: "pi",
      agent_status: "working",
      environment: { SECRET: "pane-secret" },
      env_vars: { SECRET: "vars-secret" },
      history: [{ env: { SECRET: "array-secret" } }, { child: { environment_overrides: { SECRET: "deep-secret" } } }]
    };
    const result = await launch({ name: "worker", profile: "worker" }, catalog(profile("worker")), makeCli({ paneStates: [leaky, leaky] }).cli);
    expect(result.details).toMatchObject({ operation: "launch", outcome: "launched", paneId: "w1:p2" });
    expect(result.details?.postState).toEqual({ pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", agent: "pi", agent_status: "working", history: [{}, { child: {} }] });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});

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
      { ...valid, overrides: { thinking: "invalid" } }, { ...valid, overrides: { effort: "invalid" } }, { ...valid, overrides: { permissionMode: "invalid" } },
      ...["tools", "extensions", "skills", "allowedTools", "disallowedTools", "addDirs", "pluginDirs"].map((key) => ({ ...valid, overrides: { [key]: ["bad\nvalue"] } })),
      ...["tools", "extensions", "skills", "allowedTools", "disallowedTools", "addDirs", "pluginDirs"].map((key) => ({ ...valid, overrides: { [key]: 1 } })),
      { ...valid, label: "" }, { ...valid, cwd: "" }, { ...valid, initialPrompt: "" }, { ...valid, initialPrompt: 1 }, { ...valid, focus: 1 },
      { ...valid, initialPrompt: "go", initialPromptDelivery: "elsewhere" }, { ...valid, initialPromptDelivery: "attachment" },
      { ...valid, placement: null }, { ...valid, placement: 1 }, { ...valid, placement: { mode: "same_tab", extra: true } },
      { ...valid, placement: { mode: "new_tab" } }, { ...valid, placement: { mode: "new_tab", tabLabel: "agents", extra: true } },
      { ...valid, placement: { mode: "existing_pane" } }, { ...valid, placement: { mode: "existing_pane", target: "target", extra: true } },
      { ...valid, placement: { mode: "unsupported" } }
    ];
    for (const value of invalid) expect(() => validateLaunchParams(value as never)).toThrow();
    expect(() => validateLaunchParams({ ...valid, overrides: { model: "m", tools: [], extensions: [], skills: [], allowedTools: [], disallowedTools: [], addDirs: [], pluginDirs: [] }, placement: { mode: "same_tab" } })).not.toThrow();
  });

  it("retains the failing phase and bounded CLI evidence at the launch boundary", async () => {
    const failure = new CliProtocolError("CLI_PROTOCOL_ERROR", "Herdr CLI did not return a usable response", {
      exitCode: 1,
      killed: false,
      stdout: "",
      stderr: JSON.stringify({ id: "cli:tab:create", error: { code: "tab_create_failed", message: "disposable placement failed" } }),
      stdoutTruncated: false,
      stderrTruncated: false
    });
    const harness = makeCli();
    const base = harness.cli.runJson;
    harness.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => argv[0] === "tab" && argv[1] === "create" ? Promise.reject(failure) : base(argv, signal, preserve));

    await expect(launch({ name: "worker", profile: "worker", placement: { mode: "new_tab", tabLabel: "agents" } }, catalog(profile("worker")), harness.cli)).rejects.toMatchObject({
      code: "LAUNCH_FAILED",
      details: {
        phase: "placement",
        causeCode: "CLI_PROTOCOL_ERROR",
        cliFailure: {
          code: "CLI_PROTOCOL_ERROR",
          message: "Herdr CLI did not return a usable response",
          details: { exitCode: 1, killed: false, stdout: "", stderr: failure.details.stderr, stdoutTruncated: false, stderrTruncated: false }
        }
      }
    });

    const noEvidence = makeCli();
    const noEvidenceBase = noEvidence.cli.runJson;
    noEvidence.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => argv[0] === "tab" && argv[1] === "create" ? Promise.reject({ details: {} }) : noEvidenceBase(argv, signal, preserve));
    await expect(launch({ name: "worker", profile: "worker", placement: { mode: "new_tab", tabLabel: "agents" } }, catalog(profile("worker")), noEvidence.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED", details: { phase: "placement", causeCode: "CLI_PROTOCOL_ERROR" } });

    const detailsOnly = makeCli();
    const detailsOnlyBase = detailsOnly.cli.runJson;
    detailsOnly.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => argv[0] === "tab" && argv[1] === "create" ? Promise.reject({ details: { stderr: "placement evidence" } }) : detailsOnlyBase(argv, signal, preserve));
    await expect(launch({ name: "worker", profile: "worker", placement: { mode: "new_tab", tabLabel: "agents" } }, catalog(profile("worker")), detailsOnly.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED", details: { phase: "placement", causeCode: "CLI_PROTOCOL_ERROR", cliFailure: { details: { stderr: "placement evidence" } } } });

    const messageOnly = makeCli();
    const messageOnlyBase = messageOnly.cli.runJson;
    messageOnly.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => argv[0] === "tab" && argv[1] === "create" ? Promise.reject(Object.assign(new Error("placement message"), { details: {} })) : messageOnlyBase(argv, signal, preserve));
    await expect(launch({ name: "worker", profile: "worker", placement: { mode: "new_tab", tabLabel: "agents" } }, catalog(profile("worker")), messageOnly.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED", details: { phase: "placement", causeCode: "CLI_PROTOCOL_ERROR", cliFailure: { message: "placement message" } } });
  });

  it("covers exact startup identities, pane variants, prompt recovery, and terminal renderers", async () => {
    const worker = profile("worker");
    for (const startResult of [null, {}, { agent: {} }, { agent: null }]) {
      const harness = makeCli();
      const base = harness.cli.runJson;
      harness.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => argv[0] === "agent" && argv[1] === "start" ? ok("start", startResult) : base(argv, signal, preserve));
      await expect(launch({ name: "worker", profile: "worker" }, catalog(worker), harness.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED" });
    }
    for (const agent of [
      { name: "other", pane_id: "w1:p2", agent: "pi", terminal_id: "terminal-wrong-name" },
      { name: "worker", pane_id: "w1:p9", agent: "pi", terminal_id: "terminal-wrong-pane" },
      { name: "worker", pane_id: "w1:p2", agent: "claude", terminal_id: "terminal-wrong-kind" }
    ]) {
      const harness = makeCli();
      const base = harness.cli.runJson;
      harness.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => argv[0] === "agent" && argv[1] === "start" ? ok("start", { agent }) : base(argv, signal, preserve));
      await expect(launch({ name: "worker", profile: "worker" }, catalog(worker), harness.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED" });
      expect(harness.calls.some((call) => call[0] === "pane" && call[1] === "get")).toBe(false);
    }

    const terminalOnly = makeCli({ start: () => ok("start", { agent: { name: "worker", pane_id: "w1:p2", agent: "pi", terminal_id: "terminal-worker" } }) });
    const terminalOnlyResult = await launch({ name: "worker", profile: "worker" }, catalog(worker), terminalOnly.cli);
    expect(terminalOnlyResult.details).toMatchObject({ name: "worker" });
    expect(terminalOnlyResult.details).not.toHaveProperty("agentId");
    const explicitAgentId = makeCli({ start: () => ok("start", { agent: { name: "worker", pane_id: "w1:p2", agent: "pi", agent_id: "agent-worker", terminal_id: "terminal-worker" } }) });
    await expect(launch({ name: "worker", profile: "worker" }, catalog(worker), explicitAgentId.cli)).resolves.toMatchObject({ details: { agentId: "agent-worker" } });

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

    // The stalled envelope is recovered on both transports: a textual stderr envelope, and
    // the stdin transport whose evidence is non-textual by design.
    for (const stalledDetails of [
      { exitCode: 1, killed: false, stderr: JSON.stringify({ id: "cli:agent:prompt", error: { code: "agent_prompt_stalled", message: "agent prompt produced no observed state change within 5000 ms; status is idle and state_change_seq remained 7" } }) },
      { exitCode: 1, killed: false, evidence: "omitted_for_stdin_delivery", stdoutPresent: false, stdoutBytes: 0, stdoutTruncated: false }
    ]) {
      const recovery: string[][] = [];
      const stalled = makeCli();
      const stalledBase = stalled.cli.runJson;
      stalled.cli.runJsonWithStdin = vi.fn(async () => { throw Object.assign(new Error("stalled"), { code: "CLI_PROTOCOL_ERROR", details: stalledDetails }); });
      stalled.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
        if (argv[0] === "agent" && (argv[1] === "send-keys" || argv[1] === "wait")) { recovery.push(argv); return ok("recovery", {}); }
        return stalledBase(argv, signal, preserve);
      });
      await expect(launch({ name: "worker", profile: "worker", initialPrompt: "go" }, catalog(worker), stalled.cli)).resolves.toMatchObject({ details: { initialPromptSent: true } });
      expect(recovery).toEqual([["agent", "send-keys", "w1:p2", "enter"], ["agent", "wait", "w1:p2", "--until", "working", "--timeout", "5000"]]);
    }

    // Non-textual stdin evidence preserves new-pane recovery but cannot authorize
    // an existing-pane recovery key without the exact stalled sequence.
    const existingStalled = makeCli();
    const existingStalledBase = existingStalled.cli.runJson;
    existingStalled.cli.runJsonWithStdin = vi.fn(async () => { throw Object.assign(new Error("stalled"), { code: "CLI_PROTOCOL_ERROR", details: { exitCode: 1, killed: false, evidence: "omitted_for_stdin_delivery" } }); });
    existingStalled.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
      if (argv[0] === "agent" && argv[1] === "start") return ok("start", { agent: { name: "worker", pane_id: "w1:p1", agent: "pi", terminal_id: "terminal-existing-stalled" } });
      if (argv[0] === "pane" && argv[1] === "get") return ok("get", { pane: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", agent: "pi", agent_status: "idle" } });
      return existingStalledBase(argv, signal, preserve);
    });
    await expect(launch({ name: "worker", profile: "worker", placement: { mode: "existing_pane", target: "caller" }, initialPrompt: "go" }, catalog(worker), existingStalled.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED", details: { causeCode: "agent_prompt_stalled", promptRecovery: "refused_existing_pane_stall_evidence_unavailable" } });
    expect(existingStalled.calls.some((call) => call[1] === "send-keys")).toBe(false);

    const safeEvidence = makeCli({ paneStates: [{ pane_id: "w1:p2", tab_id: "w1:t1", agent_status: "unknown", agent_id: 1, status: {} }] });
    const safeBase = safeEvidence.cli.runJson;
    safeEvidence.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
      if (argv[0] === "agent" && argv[1] === "start") throw startFailure();
      return safeBase(argv, signal, preserve);
    });
    await expect(launch({ name: "worker", profile: "worker" }, catalog(worker), safeEvidence.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED" });

    const tool = createLaunchTool({ cli: makeCli().cli, context, cwd: "/repo", profiles: { load: async () => catalog(worker) }, attachments: fakeAttachments(), recipients: new RecipientRegistry() });
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
      if (argv[0] === "agent" && argv[1] === "start") return ok("start", { agent: { name: "worker", pane_id: "w1:p3", agent: "pi", terminal_id: "terminal-tab" } });
      if (argv[0] === "pane" && argv[1] === "get") return ok("get", { pane: { pane_id: "w1:p3", tab_id: "w1:t2", workspace_id: "w1", agent: "pi", agent_status: "idle" } });
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

  it.each([
    ["wrapped agent record", true, undefined],
    ["direct agent record", false, undefined],
    ["wrapped agent record with ID", true, "agent-worker"]
  ] as const)("recovers a stalled prompt only for an owned agent-free existing pane with an exact %s", async (_shape, wrapped, agentId) => {
    const emptyTargetPane = { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", label: "owned-target", agent_status: "unknown" };
    const emptyTargetSnapshot: HerdrSnapshot = { ...snapshot, panes: [...snapshot.panes, emptyTargetPane], agents: [] };
    const stalledAgent = { name: "worker", pane_id: "w1:p2", agent: "pi", agent_status: "idle", state_change_seq: 7, agent_session: "session-worker", ...(agentId ? { agent_id: agentId } : {}) };
    const workingPane = { ...emptyTargetPane, agent: "pi", agent_status: "working" };
    const stall = () => new CliProtocolError("CLI_PROTOCOL_ERROR", "Herdr CLI did not return a usable response", {
      exitCode: 1,
      killed: false,
      stderrTruncated: false,
      stderr: JSON.stringify({ id: "cli:agent:prompt", error: { code: "agent_prompt_stalled", message: "agent prompt produced no observed state change within 5000 ms; status is idle and state_change_seq remained 7" } })
    });
    const owned = new RuntimeOwnership();
    owned.record({ kind: "pane", id: "w1:p2", parentId: "w1:t1" });
    const harness = makeCli({
      snapshot: emptyTargetSnapshot,
      paneStates: [workingPane],
      ...(agentId ? { start: () => ok("start", { agent: { name: "worker", pane_id: "w1:p2", agent: "pi", agent_id: agentId } }) } : {})
    });
    const base = harness.cli.runJson;
    harness.cli.runJsonWithStdin = vi.fn(async (argv, input) => {
      harness.calls.push(argv);
      harness.stdinInputs.push(input);
      throw stall();
    });
    harness.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
      if (argv[0] === "agent" && argv[1] === "get") { harness.calls.push(argv); return ok("agent-get", wrapped ? { agent: stalledAgent } : stalledAgent); }
      if (argv[0] === "agent" && argv[1] === "send-keys") { harness.calls.push(argv); return ok("keys", {}); }
      if (argv[0] === "agent" && argv[1] === "wait") { harness.calls.push(argv); return ok("wait", {}); }
      return base(argv, signal, preserve);
    });
    const tool = createLaunchTool({ cli: harness.cli, context, cwd: "/repo", ownership: owned, profiles: { load: async () => catalog(profile("worker")) } });
    await expect(tool.execute("id", { name: "worker", profile: "worker", placement: { mode: "existing_pane", target: "owned-target" }, initialPrompt: "go" }, new AbortController().signal, undefined, extensionContext)).resolves.toMatchObject({ details: { initialPromptSent: true, paneId: "w1:p2" } });
    expect(harness.calls.filter((call) => call[0] === "agent" && call[1] === "send-keys")).toHaveLength(1);
    expect(harness.calls.filter((call) => call[0] === "agent" && call[1] === "get")).toHaveLength(1);
    expect(harness.calls.filter((call) => call[0] === "agent" && call[1] === "wait")).toHaveLength(1);
    expect(harness.calls.filter((call) => call[0] === "pane" && call[1] === "get")).toHaveLength(1);
  });

  it.each([
    ["unowned", undefined, "refused_existing_pane_not_owned"],
    ["preexisting agent", "occupied", "refused_existing_pane_preexisting_agent"]
  ] as const)("does not recover a stalled prompt for an %s existing pane", async (_name, occupied, promptRecovery) => {
    const targetPane = occupied === undefined
      ? { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", label: "target", agent_status: "unknown" }
      : { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", label: "target", agent_name: "existing", agent: "pi", agent_status: "idle" };
    const targetSnapshot: HerdrSnapshot = { ...snapshot, panes: [...snapshot.panes, targetPane], agents: occupied === undefined ? [{ pane_id: "w1:p1", name: "caller", agent: "pi", agent_status: "idle" }] : [{ pane_id: "w1:p2", name: "existing", agent: "pi", agent_status: "idle" }] };
    const harness = makeCli({ snapshot: targetSnapshot });
    harness.cli.runJsonWithStdin = vi.fn(async (argv, input) => {
      harness.calls.push(argv);
      harness.stdinInputs.push(input);
      throw Object.assign(new Error("stalled"), { code: "CLI_PROTOCOL_ERROR", details: { exitCode: 1, killed: false, stderrTruncated: false, stderr: JSON.stringify({ id: "cli:agent:prompt", error: { code: "agent_prompt_stalled", message: "agent prompt produced no observed state change within 5000 ms; status is idle and state_change_seq remained 7" } }) } });
    });
    const ownership = new RuntimeOwnership();
    if (occupied !== undefined) ownership.record({ kind: "pane", id: "w1:p2", parentId: "w1:t1" });
    const tool = createLaunchTool({ cli: harness.cli, context, cwd: "/repo", ownership, profiles: { load: async () => catalog(profile("worker")) } });
    await expect(tool.execute("id", { name: "worker", profile: "worker", placement: { mode: "existing_pane", target: "target" }, initialPrompt: "go" }, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "LAUNCH_FAILED", details: { causeCode: "agent_prompt_stalled", promptRecovery } });
    expect(harness.calls.some((call) => call[0] === "agent" && call[1] === "send-keys")).toBe(false);
  });

  it.each([
    ["mismatched", { name: "other", pane_id: "w1:p2", agent: "pi", agent_status: "idle", state_change_seq: 7, agent_session: "session-other" }],
    ["missing", null]
  ] as const)("does not send keys when the owned existing pane has %s agent recovery post-state", async (_name, postState) => {
    const targetPane = { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", label: "target", agent_status: "unknown" };
    const targetSnapshot: HerdrSnapshot = { ...snapshot, panes: [...snapshot.panes, targetPane], agents: [] };
    const harness = makeCli({ snapshot: targetSnapshot });
    const base = harness.cli.runJson;
    let agentGets = 0;
    harness.cli.runJsonWithStdin = vi.fn(async (argv, input) => {
      harness.calls.push(argv);
      harness.stdinInputs.push(input);
      throw Object.assign(new Error("stalled"), { code: "CLI_PROTOCOL_ERROR", details: { exitCode: 1, killed: false, stderrTruncated: false, stderr: JSON.stringify({ id: "cli:agent:prompt", error: { code: "agent_prompt_stalled", message: "agent prompt produced no observed state change within 5000 ms; status is idle and state_change_seq remained 7" } }) } });
    });
    harness.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
      if (argv[0] === "agent" && argv[1] === "get" && agentGets++ === 0) { harness.calls.push(argv); return ok("get", postState === null ? null : { agent: postState }); }
      return base(argv, signal, preserve);
    });
    const ownership = new RuntimeOwnership();
    ownership.record({ kind: "pane", id: "w1:p2", parentId: "w1:t1" });
    const tool = createLaunchTool({ cli: harness.cli, context, cwd: "/repo", ownership, profiles: { load: async () => catalog(profile("worker")) } });
    await expect(tool.execute("id", { name: "worker", profile: "worker", placement: { mode: "existing_pane", target: "target" }, initialPrompt: "go" }, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "POSTSTATE_UNAVAILABLE", details: { causeCode: "agent_prompt_stalled", promptRecovery: expect.stringMatching(/^refused_existing_pane_post_state_/) } });
    expect(harness.calls.some((call) => call[0] === "agent" && call[1] === "send-keys")).toBe(false);
  });

  it("does not recover a non-matching protocol error in an existing pane", async () => {
    const targetPane = { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", label: "target", agent_status: "unknown" };
    const targetSnapshot: HerdrSnapshot = { ...snapshot, panes: [...snapshot.panes, targetPane], agents: [] };
    const harness = makeCli({ snapshot: targetSnapshot });
    harness.cli.runJsonWithStdin = vi.fn(async (argv, input) => {
      harness.calls.push(argv);
      harness.stdinInputs.push(input);
      throw new CliProtocolError("CLI_PROTOCOL_ERROR", "Herdr CLI did not return a usable response", { exitCode: 1, killed: false, stderrTruncated: false, stderr: JSON.stringify({ id: "cli:agent:prompt", error: { code: "agent_prompt_stalled", message: "agent prompt produced no observed state change within 5000 ms; status is idle" } }) });
    });
    const ownership = new RuntimeOwnership();
    ownership.record({ kind: "pane", id: "w1:p2", parentId: "w1:t1" });
    const tool = createLaunchTool({ cli: harness.cli, context, cwd: "/repo", ownership, profiles: { load: async () => catalog(profile("worker")) } });
    await expect(tool.execute("id", { name: "worker", profile: "worker", placement: { mode: "existing_pane", target: "target" }, initialPrompt: "go" }, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "LAUNCH_FAILED", details: { causeCode: "CLI_PROTOCOL_ERROR" } });
    expect(harness.calls.some((call) => call[0] === "agent" && call[1] === "send-keys")).toBe(false);
  });

  it("does not recover a prompt stall with an unsafe state-change sequence", async () => {
    const targetPane = { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", label: "target", agent_status: "unknown" };
    const targetSnapshot: HerdrSnapshot = { ...snapshot, panes: [...snapshot.panes, targetPane], agents: [] };
    const harness = makeCli({ snapshot: targetSnapshot });
    harness.cli.runJsonWithStdin = vi.fn(async (argv, input) => {
      harness.calls.push(argv);
      harness.stdinInputs.push(input);
      throw new CliProtocolError("CLI_PROTOCOL_ERROR", "Herdr CLI did not return a usable response", { exitCode: 1, killed: false, stderrTruncated: false, stderr: JSON.stringify({ id: "cli:agent:prompt", error: { code: "agent_prompt_stalled", message: `agent prompt produced no observed state change within 5000 ms; status is idle and state_change_seq remained ${"9".repeat(400)}` } }) });
    });
    const ownership = new RuntimeOwnership();
    ownership.record({ kind: "pane", id: "w1:p2", parentId: "w1:t1" });
    const tool = createLaunchTool({ cli: harness.cli, context, cwd: "/repo", ownership, profiles: { load: async () => catalog(profile("worker")) } });
    await expect(tool.execute("id", { name: "worker", profile: "worker", placement: { mode: "existing_pane", target: "target" }, initialPrompt: "go" }, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "LAUNCH_FAILED", details: { causeCode: "CLI_PROTOCOL_ERROR" } });
    expect(harness.calls.some((call) => call[0] === "agent" && call[1] === "send-keys")).toBe(false);
  });

  it("covers guarded fallback, focus, and authoritative post-state refusals", async () => {
    const primary = profile("primary", "pi", ["fallback"]);
    const fallback = profile("fallback");

    const readFailure = makeCli({ start: () => { throw startFailure(); } });
    const readBase = readFailure.cli.runJson;
    readFailure.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => argv[0] === "pane" && argv[1] === "get" ? Promise.reject(new Error("read failed")) : readBase(argv, signal, preserve));
    await expect(launch({ name: "worker", profile: "primary" }, catalog(primary, fallback), readFailure.cli)).rejects.toMatchObject({ code: "POSTSTATE_UNAVAILABLE", details: { causeCode: "POSTSTATE_UNAVAILABLE", startFailureCode: "agent_start_failed" } });
    const readStringFailure = makeCli({ start: () => { throw startFailure(); } });
    const readStringBase = readStringFailure.cli.runJson;
    readStringFailure.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => argv[0] === "pane" && argv[1] === "get" ? Promise.reject("read failed") : readStringBase(argv, signal, preserve));
    await expect(launch({ name: "worker", profile: "primary" }, catalog(primary, fallback), readStringFailure.cli)).rejects.toMatchObject({ code: "POSTSTATE_UNAVAILABLE" });

    const aborted = new AbortController();
    const abortHarness = makeCli();
    const abortBase = abortHarness.cli.runJson;
    abortHarness.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
      if (argv[0] === "pane" && argv[1] === "split") { aborted.abort(); return abortBase(argv, signal, preserve); }
      return abortBase(argv, signal, preserve);
    });
    await expect(createLaunchTool({ cli: abortHarness.cli, context, cwd: "/repo", profiles: { load: async () => catalog(profile("worker")) }, attachments: fakeAttachments(), recipients: new RecipientRegistry() }).execute("id", { name: "worker", profile: "worker" }, aborted.signal, undefined, extensionContext)).rejects.toMatchObject({ code: "ABORTED" });

    const exhausted = makeCli({ paneStates: [{ pane_id: "w1:p2", tab_id: "w1:t1", agent_status: "unknown" }, { pane_id: "w1:p2", tab_id: "w1:t1", agent_status: "unknown" }], start: () => { throw startFailure(); } });
    await expect(launch({ name: "worker", profile: "primary" }, catalog(primary, fallback), exhausted.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED", details: { causeCode: "agent_start_failed", attempts: expect.arrayContaining([expect.objectContaining({ profile: "fallback" })]) } });

    const focused = makeCli();
    const focusedBase = focused.cli.runJson;
    focused.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
      if (argv[0] === "agent" && argv[1] === "start") return ok("start", { agent: { name: "worker", pane_id: "w1:p1", agent: "pi", terminal_id: "terminal-focused" } });
      if (argv[0] === "pane" && argv[1] === "get") return ok("get", { pane: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", agent: "pi", agent_status: "idle" } });
      return focusedBase(argv, signal, preserve);
    });
    await expect(launch({ name: "worker", profile: "worker", placement: { mode: "existing_pane", target: "caller" }, focus: true }, catalog(profile("worker")), focused.cli)).resolves.toMatchObject({ details: { paneId: "w1:p1" } });
    expect(focused.calls).toContainEqual(["agent", "focus", "w1:p1"]);
    for (const focusError of ["CLI_TIMEOUT", "READY_TIMEOUT"]) {
      const focusFailure = makeCli();
      const focusBase = focusFailure.cli.runJson;
      focusFailure.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
        if (argv[0] === "agent" && argv[1] === "start") return ok("start", { agent: { name: "worker", pane_id: "w1:p1", agent: "pi", terminal_id: "terminal-focus-failure" } });
        if (argv[0] === "agent" && argv[1] === "focus") throw Object.assign(new Error(focusError), { code: focusError });
        if (argv[0] === "pane" && argv[1] === "get") return ok("get", { pane: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", agent: "pi", agent_status: "idle" } });
        return focusBase(argv, signal, preserve);
      });
      await expect(launch({ name: "worker", profile: "worker", placement: { mode: "existing_pane", target: "caller" }, focus: true }, catalog(profile("worker")), focusFailure.cli)).rejects.toMatchObject({ code: "READY_TIMEOUT" });
    }

    const idlePrompt = makeCli({ paneStates: [{ pane_id: "w1:p2", tab_id: "w1:t1", agent_name: "worker", agent_status: "idle" }] });
    await expect(launch({ name: "worker", profile: "worker", initialPrompt: "go" }, catalog(profile("worker")), idlePrompt.cli)).rejects.toMatchObject({ code: "POSTSTATE_UNAVAILABLE" });

    const unknownState = makeCli({ paneStates: [{ pane_id: "w1:p2", tab_id: "w1:t1", agent_name: "worker" }] });
    await expect(launch({ name: "worker", profile: "worker", initialPrompt: "go" }, catalog(profile("worker")), unknownState.cli)).rejects.toMatchObject({ code: "POSTSTATE_UNAVAILABLE" });

    const genericPostState = makeCli();
    const genericPostBase = genericPostState.cli.runJson;
    genericPostState.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => argv[0] === "pane" && argv[1] === "get" ? Promise.reject(Object.assign(new Error("post-state unavailable"), { code: "POSTSTATE_UNAVAILABLE" })) : genericPostBase(argv, signal, preserve));
    await expect(launch({ name: "worker", profile: "worker" }, catalog(profile("worker")), genericPostState.cli)).rejects.toMatchObject({ code: "POSTSTATE_UNAVAILABLE" });

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

    const nestedEvidence = makeCli({ paneStates: [{ pane_id: "w1:p2", tab_id: "w1:t1", agent_status: "unknown" }] });
    const nestedBase = nestedEvidence.cli.runJson;
    nestedEvidence.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
      if (argv[0] === "agent" && argv[1] === "start") throw startFailure();
      return nestedBase(argv, signal, preserve);
    });
    await expect(launch({ name: "worker", profile: "worker" }, catalog(profile("worker")), nestedEvidence.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED" });

    for (const error of [
      Object.assign(new Error("bad"), { code: "CLI_PROTOCOL_ERROR" }),
      Object.assign(new Error("bad"), { code: "CLI_PROTOCOL_ERROR", details: { exitCode: 2, killed: false, stderr: "{}" } }),
      Object.assign(new Error("bad"), { code: "CLI_PROTOCOL_ERROR", details: { exitCode: 1, killed: false } }),
      Object.assign(new Error("bad"), { code: "CLI_PROTOCOL_ERROR", details: { exitCode: 1, killed: false, stderr: "{" } }),
      Object.assign(new Error("bad"), { code: "CLI_PROTOCOL_ERROR", details: { exitCode: 1, killed: false, stderr: JSON.stringify({ id: "wrong", error: {} }) } }),
      new Error("plain")
    ]) {
      const promptFailure = makeCli();
      promptFailure.cli.runJsonWithStdin = vi.fn(async () => Promise.reject(error));
      await expect(launch({ name: "worker", profile: "worker", initialPrompt: "go" }, catalog(profile("worker")), promptFailure.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED" });
      expect(promptFailure.calls.some((call) => call[1] === "send-keys")).toBe(false);
    }
  });

  it("refuses to deliver a prompt when the stdin transport is unavailable", async () => {
    const unavailable = makeCli();
    delete (unavailable.cli as { runJsonWithStdin?: unknown }).runJsonWithStdin;
    await expect(launch({ name: "worker", profile: "worker", initialPrompt: "go" }, catalog(profile("worker")), unavailable.cli))
      .rejects.toMatchObject({ code: "LAUNCH_FAILED", details: { causeCode: "CLI_INCOMPATIBLE" } });
  });

  it("maps an aborted stdin prompt to ABORTED whether it throws or returns", async () => {
    for (const outcome of ["throw", "return"] as const) {
      const controller = new AbortController();
      const aborted = makeCli();
      aborted.cli.runJsonWithStdin = vi.fn(async () => {
        controller.abort();
        if (outcome === "throw") throw new Error("transport closed");
        return ok("prompt", { ok: true });
      });
      const tool = createLaunchTool({ cli: aborted.cli, context, cwd: "/repo", profiles: { load: async () => catalog(profile("worker")) }, promptSources: { create: vi.fn(async () => ({ path: "/cache/body.md" })) }, attachments: fakeAttachments(), recipients: new RecipientRegistry() });
      await expect(tool.execute("id", { name: "worker", profile: "worker", initialPrompt: "go" }, controller.signal, undefined, extensionContext)).rejects.toMatchObject({ code: "ABORTED" });
    }
  });

  it("falls back to the context signal and then to a fresh signal", async () => {
    const withContextSignal = makeCli();
    const contextSignal = new AbortController().signal;
    const contextTool = createLaunchTool({ cli: withContextSignal.cli, context, cwd: "/repo", profiles: { load: async () => catalog(profile("worker")) }, promptSources: { create: vi.fn(async () => ({ path: "/cache/body.md" })) }, attachments: fakeAttachments(), recipients: new RecipientRegistry() });
    await expect(contextTool.execute("id", { name: "worker", profile: "worker" }, undefined, undefined, { ...extensionContext, signal: contextSignal } as ExtensionContext)).resolves.toMatchObject({ details: { outcome: "launched" } });

    const withoutSignal = makeCli();
    const freshTool = createLaunchTool({ cli: withoutSignal.cli, context, cwd: "/repo", profiles: { load: async () => catalog(profile("worker")) }, promptSources: { create: vi.fn(async () => ({ path: "/cache/body.md" })) }, attachments: fakeAttachments(), recipients: new RecipientRegistry() });
    await expect(freshTool.execute("id", { name: "worker", profile: "worker" }, undefined, undefined, { cwd: "/repo", hasUI: false } as ExtensionContext)).resolves.toMatchObject({ details: { outcome: "launched" } });
  });

  it("publishes an attachment before placement, grants its directory, and registers the recipient", async () => {
    const harness = makeCli();
    const attachments = fakeAttachments();
    const recipients = new RecipientRegistry();
    const claude = profile("worker-claude", "claude");
    const result = await launch({ name: "worker", profile: "worker-claude", initialPrompt: "body", initialPromptDelivery: "attachment" }, catalog(claude), harness.cli, undefined, { attachments, recipients });
    expect(attachments.ensureRecipient).toHaveBeenCalledTimes(1);
    expect(attachments.publish).toHaveBeenCalledWith(expect.objectContaining({ body: "body", operation: "assignment", recipientAgentName: "worker" }));
    expect(harness.calls).toContainEqual(PROMPT_ARGV("w1:p2"));
    expect(harness.calls.find((call) => call[1] === "start")).toEqual(expect.arrayContaining(["--add-dir", GRANT_PATH]));
    expect(harness.stdinInputs[0]).toContain("delivery: attachment");
    expect(result.details).toMatchObject({
      initialPromptDelivery: "attachment",
      attachment: { attachmentId: "attachment-1" },
      envelope: { delivery: "attachment" },
      recipient: { paneId: "w1:p2", profileName: "worker-claude", capable: true, kind: "claude" }
    });
    expect(recipients.get("w1:p2")).toMatchObject({ capable: true });
  });

  it("records an incapable recipient for an inline launch without refusing it", async () => {
    const recipients = new RecipientRegistry();
    const restricted = profile("restricted", "claude");
    await launch({ name: "worker", profile: "restricted", overrides: { disallowedTools: ["Read"] } }, catalog(restricted), makeCli().cli, undefined, { recipients });
    expect(recipients.get("w1:p2")).toMatchObject({ capable: false, reason: "Claude profile disallows Read" });
  });

  it("rejects an incapable attachment profile, in the chain or after overrides, before topology mutation", async () => {
    const calls: string[][] = [];
    const restricted = profile("restricted", "claude");
    await expect(launch({ name: "worker", profile: "restricted", overrides: { disallowedTools: ["Read"] }, initialPrompt: "body", initialPromptDelivery: "attachment" }, catalog(restricted), makeCli({ calls }).cli))
      .rejects.toMatchObject({ code: "ATTACHMENT_TARGET_UNVERIFIED", details: { profile: "restricted", reason: "Claude profile disallows Read", delivery: "attachment", phase: "resolve_profile" } });
    expect(calls).toHaveLength(0);

    const chainCalls: string[][] = [];
    const primary = profile("primary", "claude", ["incapable-fallback"]);
    const incapableFallback = profile("incapable-fallback", "pi");
    const withoutRead = { ...incapableFallback, runtime: { ...incapableFallback.runtime, tools: ["bash"] } } as typeof incapableFallback;
    await expect(launch({ name: "worker", profile: "primary", initialPrompt: "body", initialPromptDelivery: "attachment" }, catalog(primary, withoutRead), makeCli({ calls: chainCalls }).cli))
      .rejects.toMatchObject({ code: "ATTACHMENT_TARGET_UNVERIFIED", details: { profile: "incapable-fallback", reason: "Pi profile excludes the local read tool" } });
    expect(chainCalls).toHaveLength(0);
  });

  it("reports a retained attachment when delivery fails and releases the grant either way", async () => {
    const released: string[] = [];
    const grant = { path: GRANT_PATH, token: "grant-recipient", renew: async () => { released.push("renew"); }, release: async () => { released.push("release"); } };
    const attachments = fakeAttachments({ ensureRecipient: vi.fn(async () => grant) });
    const sendFailure = makeCli();
    sendFailure.cli.runJsonWithStdin = vi.fn(async () => { throw Object.assign(new Error("submission failed"), { code: "CLI_TIMEOUT" }); });
    await expect(launch({ name: "worker", profile: "worker-claude", initialPrompt: "body", initialPromptDelivery: "attachment" }, catalog(profile("worker-claude", "claude")), sendFailure.cli, undefined, { attachments }))
      .rejects.toMatchObject({
        code: "LAUNCH_FAILED",
        details: { causeCode: "CLI_TIMEOUT", phase: "prompt_verification", delivery: "attachment", initialPromptDelivery: "attachment", attachmentRetained: true, attachment: { attachmentId: "attachment-1" } }
      });
    expect(released).toEqual(["renew", "release"]);
  });

  it("keeps a failed publication out of topology and releases the grant", async () => {
    const released: string[] = [];
    const grant = { path: GRANT_PATH, token: "grant-recipient", renew: async () => undefined, release: async () => { released.push("release"); } };
    const attachments = fakeAttachments({
      ensureRecipient: vi.fn(async () => grant),
      publish: vi.fn(async () => { throw Object.assign(new Error("quota"), { code: "ATTACHMENT_QUOTA_EXCEEDED", details: { operation: "quota" } }); })
    });
    const publishFailure = makeCli();
    await expect(launch({ name: "worker", profile: "worker-claude", initialPrompt: "body", initialPromptDelivery: "attachment" }, catalog(profile("worker-claude", "claude")), publishFailure.cli, undefined, { attachments }))
      .rejects.toMatchObject({ code: "ATTACHMENT_QUOTA_EXCEEDED", details: { operation: "quota", delivery: "attachment", phase: "attachment_publish" } });
    expect(publishFailure.calls.some((call) => call[0] === "pane" && call[1] === "split")).toBe(false);
    expect(released).toEqual(["release"]);
  });

  it("scopes a published attachment to an exact existing recipient pane", async () => {
    const recipientPanes: Array<string | undefined> = [];
    const attachments = fakeAttachments({ publish: vi.fn(async (request) => { recipientPanes.push(request.recipientPaneId); return publishedAttachment; }) });
    const existingPane = makeCli();
    const existingBase = existingPane.cli.runJson;
    existingPane.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
      if (argv[0] === "agent" && argv[1] === "start") return ok("start", { agent: { name: "worker", pane_id: "w1:p1", agent: "claude", terminal_id: "terminal-existing-attachment" } });
      if (argv[0] === "pane" && argv[1] === "get") return ok("get", { pane: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", agent: "claude", agent_status: "working" } });
      return existingBase(argv, signal, preserve);
    });
    const result = await launch({ name: "worker", profile: "worker-claude", placement: { mode: "existing_pane", target: "caller" }, initialPrompt: "body", initialPromptDelivery: "attachment" }, catalog(profile("worker-claude", "claude")), existingPane.cli, undefined, { attachments });
    expect(recipientPanes).toEqual(["w1:p1"]);
    expect(result.details).toMatchObject({ paneId: "w1:p1", initialPromptDelivery: "attachment" });
  });

  it("refuses payloads beyond the delivery bound before any mutation", async () => {
    const inlineCalls: string[][] = [];
    await expect(launch({ name: "worker", profile: "worker", initialPrompt: "x".repeat(16 * 1024 + 1) }, catalog(profile("worker")), makeCli({ calls: inlineCalls }).cli))
      .rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE_FOR_INLINE", details: { delivery: "inline" } });
    expect(inlineCalls).toHaveLength(0);

    const attachmentCalls: string[][] = [];
    await expect(launch({ name: "worker", profile: "worker-claude", initialPrompt: "x".repeat(1024 * 1024 + 1), initialPromptDelivery: "attachment" }, catalog(profile("worker-claude", "claude")), makeCli({ calls: attachmentCalls }).cli))
      .rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE", details: { delivery: "attachment" } });
    expect(attachmentCalls).toHaveLength(0);
  });

  it("launches an arbitrary valid profile and reports effective runtime details", async () => {
    const worker = profile("custom-profile");
    const calls: string[][] = [];
    const promptSources = { create: vi.fn(async () => ({ path: "/cache/custom.md" })) };
    const result = await launch({ name: "worker", profile: "custom-profile", overrides: { model: "override/model", thinking: "high" } }, catalog(worker), makeCli({ calls }).cli, promptSources);
    expect(calls).toContainEqual(["agent", "start", "worker", "--kind", "pi", "--pane", "w1:p2", "--timeout", "120000", "--", "--model", "override/model", "--thinking", "high", "--tools", "read", "--no-session", "--append-system-prompt", "/cache/custom.md"]);
    expect(result.details).toMatchObject({ profile: { name: "custom-profile", requested: "custom-profile", selected: "custom-profile", source: { path: "/profiles/custom-profile.md" }, timeoutMinutes: 30, runtime: { kind: "pi", model: "override/model", thinking: "high" }, permissions: { sessionPersistence: false, tools: ["read"], extensions: [], skills: [] }, attempts: [{ profile: "custom-profile", outcome: "selected" }] } });
  });

  it("reports normalized primary capability overrides instead of profile defaults", async () => {
    const base = profile("resource-profile");
    const resourceProfile = {
      ...base,
      runtime: { kind: "pi" as const, model: "test/model", thinking: "low" as const, tools: ["read"], extensions: ["/profiles/base-extension"], skills: ["/profiles/base-skill"] }
    };
    const calls: string[][] = [];
    const result = await launch({ name: "worker", profile: "resource-profile", overrides: { model: "override/model", thinking: "high", tools: ["read", "grep"], extensions: ["./override-extension"], skills: ["./override-skill"] } }, catalog(resourceProfile), makeCli({ calls }).cli);
    expect(calls).toContainEqual(["agent", "start", "worker", "--kind", "pi", "--pane", "w1:p2", "--timeout", "120000", "--", "--model", "override/model", "--thinking", "high", "--tools", "read,grep", "--extension", "/profiles/override-extension", "--skill", "/profiles/override-skill", "--no-session", "--append-system-prompt", "/cache/body.md"]);
    expect(result.details).toMatchObject({ profile: { runtime: { model: "override/model", thinking: "high" }, permissions: { tools: ["read", "grep"], extensions: ["/profiles/override-extension"], skills: ["/profiles/override-skill"] } } });
  });

  it("stops before mutation when the catalog is unavailable and preserves abort evidence", async () => {
    const noProfiles = createLaunchTool({ cli: makeCli().cli, context, cwd: "/repo" });
    await expect(noProfiles.execute("id", { name: "worker", profile: "worker" }, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "PROFILE_CATALOG_UNAVAILABLE" });

    const preAborted = new AbortController();
    preAborted.abort();
    const preWorker = profile("pre-worker");
    const preTool = createLaunchTool({ cli: makeCli().cli, context, cwd: "/repo", profiles: { load: async () => catalog(preWorker) }, attachments: fakeAttachments(), recipients: new RecipientRegistry() });
    await expect(preTool.execute("id", { name: "worker", profile: "pre-worker" }, preAborted.signal, undefined, extensionContext)).rejects.toMatchObject({ code: "ABORTED" });

    const controller = new AbortController();
    const worker = profile("worker");
    const harness = makeCli();
    const base = harness.cli.runJson;
    harness.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
      if (argv[0] === "api") { controller.abort(); return base(argv, signal, preserve); }
      return base(argv, signal, preserve);
    });
    const abortTool = createLaunchTool({ cli: harness.cli, context, cwd: "/repo", profiles: { load: async () => catalog(worker) }, promptSources: { create: vi.fn(async () => ({ path: "/cache/body.md" })) }, attachments: fakeAttachments(), recipients: new RecipientRegistry() });
    await expect(abortTool.execute("id", { name: "worker", profile: "worker" }, controller.signal, undefined, extensionContext)).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("keeps prompt source creation and provenance before topology mutation", async () => {
    const order: string[] = [];
    const worker = profile("worker");
    const promptSources = { create: vi.fn(async () => { order.push("source"); return { path: "/cache/body.md" }; }) };
    const base = makeCli();
    const cli: LaunchCli = {
      runJson: vi.fn(async (argv, signal, preserve) => { order.push(argv.slice(0, 2).join(" ")); return base.cli.runJson(argv, signal, preserve); }),
      runJsonWithStdin: vi.fn(async (argv, input, signal, preserve) => { order.push(argv.slice(0, 2).join(" ")); return base.cli.runJsonWithStdin!(argv, input, signal, preserve); })
    };
    const result = await launch({ name: "worker", profile: "worker", initialPrompt: "begin" }, catalog(worker), cli, promptSources);
    expect(order.slice(0, 4)).toEqual(["source", "api snapshot", "pane split", "pane rename"]);
    // The wrapped envelope travels over stdin, never in argv.
    expect(base.calls).toContainEqual(PROMPT_ARGV("w1:p2"));
    expect(base.stdinInputs).toEqual([envelope("begin")]);
    expect(base.calls.flat()).not.toContain(envelope("begin"));
    expect(result.details).toMatchObject({ initialPromptSent: true, initialPromptDelivery: "inline", envelope: { version: "v1", kind: "assignment", delivery: "inline" } });
  });

  it("falls back only after exact typed start failure and authoritative no-agent proof", async () => {
    const first = profile("primary", "pi", ["fallback"]);
    const second = profile("fallback", "claude");
    const calls: string[][] = [];
    const result = await launch({ name: "worker", profile: "primary", overrides: { model: "override/model", thinking: "high" } }, catalog(first, second), makeCli({ calls, paneStates: [{ pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", agent_status: "unknown" }] , start: (argv, attempt) => {
      if (attempt === 0) throw startFailure();
      return ok("start", { agent: { name: "worker", pane_id: "w1:p2", agent: "claude", terminal_id: "terminal-fallback" } });
    }}).cli);
    expect(calls.find((call) => call[0] === "agent" && call[1] === "start" && call[4] === "claude")).toEqual(["agent", "start", "worker", "--kind", "claude", "--pane", "w1:p2", "--timeout", "120000", "--", "--model", "claude/test", "--effort", "medium", "--permission-mode", "dontAsk", "--allowed-tools", "Read", "--disallowed-tools", "Edit", "--add-dir", GRANT_PATH, "--append-system-prompt-file", "/cache/body.md"]);
    expect(calls.filter((call) => call[0] === "agent" && call[1] === "start")).toHaveLength(2);
    expect(result.details).toMatchObject({ kind: "claude", profile: { requested: "primary", selected: "fallback", attempts: [{ profile: "primary", outcome: "agent_start_failed", errorCode: "agent_start_failed" }, { profile: "fallback", outcome: "selected" }] } });
  });

  it("refuses fallback for mismatched errors, uncertain post-state, or an occupied pane", async () => {
    const primary = profile("primary", "pi", ["fallback"]);
    const fallback = profile("fallback", "pi");
    const mismatched = makeCli({ start: () => { throw startFailure(); }, paneStates: [{ pane_id: "w1:p2", tab_id: "w1:t1", agent: "pi", agent_session: { source: "pi", agent: "pi", kind: "managed", value: "session" }, agent_status: "working" }] });
    await expect(launch({ name: "worker", profile: "primary" }, catalog(primary, fallback), mismatched.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED", details: { causeCode: "agent_start_failed" } });
    expect(mismatched.calls.filter((call) => call[0] === "agent" && call[1] === "start")).toHaveLength(1);

    const wrongMessage = makeCli({ start: () => { throw Object.assign(new Error("other failure"), { code: "agent_start_failed" }); } });
    await expect(launch({ name: "worker", profile: "primary" }, catalog(primary, fallback), wrongMessage.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED" });
    expect(wrongMessage.calls.some((call) => call[0] === "pane" && call[1] === "get")).toBe(false);
    const malformedEnvelope = makeCli({ start: () => { throw new CliProtocolError("CLI_PROTOCOL_ERROR", "failure", { exitCode: 1, killed: false, stderrTruncated: false, stderr: "{" }); } });
    await expect(launch({ name: "worker", profile: "primary" }, catalog(primary, fallback), malformedEnvelope.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED" });

    for (const errorEnvelope of [
      { id: "cli:agent:other", error: { code: "agent_start_failed", message: "agent process exited before becoming interactive" } },
      { id: "cli:agent:start", error: { code: "agent_start_transport_failed", message: "agent process exited before becoming interactive" } },
      { id: "cli:agent:start", error: { code: "agent_start_failed", message: "process exited before becoming interactive" } }
    ]) {
      const invalid = makeCli({ start: () => { throw new CliProtocolError("CLI_PROTOCOL_ERROR", "failure", { exitCode: 1, killed: false, stderrTruncated: false, stderr: JSON.stringify(errorEnvelope) }); } });
      await expect(launch({ name: "worker", profile: "primary" }, catalog(primary, fallback), invalid.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED" });
      expect(invalid.calls.filter((call) => call[0] === "agent" && call[1] === "start")).toHaveLength(1);
    }
  });

  it("preserves all placement modes without exposing raw environment launch", async () => {
    const worker = profile("worker");
    const newTab = makeCli();
    await expect(launch({ name: "worker", profile: "worker", placement: { mode: "new_tab", tabLabel: "agents" }, focus: true }, catalog(worker), newTab.cli)).resolves.toMatchObject({ details: { placement: { mode: "new_tab", tabLabel: "agents" }, tabId: "w1:t2", paneId: "w1:p3" } });
    expect(newTab.calls).toContainEqual(["tab", "create", "--workspace", "w1", "--cwd", "/repo", "--label", "agents", "--focus"]);

    const existing = { ...snapshot, panes: [{ ...snapshot.panes[0], label: "target" }] };
    const existingCli: LaunchCli = { runJson: vi.fn(async (argv) => {
      if (argv[0] === "api") return ok("snapshot", { type: "session_snapshot", snapshot: existing });
      if (argv[0] === "agent" && argv[1] === "start") return ok("start", { agent: { name: "worker", pane_id: "w1:p1", agent: "pi", terminal_id: "terminal-existing" } });
      if (argv[0] === "pane" && argv[1] === "get") return ok("get", { pane: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", agent: "pi", agent_status: "idle" } });
      throw new Error(`unexpected ${argv.join(" ")}`);
    }) };
    await expect(launch({ name: "worker", profile: "worker", placement: { mode: "existing_pane", target: "target" } }, catalog(worker), existingCli)).resolves.toMatchObject({ details: { paneId: "w1:p1" } });
    expect((existingCli.runJson as ReturnType<typeof vi.fn>).mock.calls.some((call) => call[0][0] === "pane" && call[0][1] === "split")).toBe(false);
  });

  it("renders the requested profile and keeps communication independent", () => {
    const tool = createLaunchTool({ cli: makeCli().cli, context, cwd: "/repo", profiles: { load: async () => catalog(profile("worker")) }, attachments: fakeAttachments(), recipients: new RecipientRegistry() });
    const call = tool.renderCall?.({ name: "worker", profile: "worker" } as never, {} as never, {} as never);
    expect(call?.render(80)).toEqual(["herdr_launch · worker · worker"]);
    const inlineCall = tool.renderCall?.({ name: "worker", profile: "worker", initialPrompt: "go" } as never, {} as never, {} as never);
    expect(inlineCall?.render(80)).toEqual(["herdr_launch · worker · inline · worker"]);
    const attachmentCall = tool.renderCall?.({ name: "worker", profile: "worker", initialPrompt: "go", initialPromptDelivery: "attachment" } as never, {} as never, {} as never);
    expect(attachmentCall?.render(80)).toEqual(["herdr_launch · worker · attachment · worker"]);
  });
});
