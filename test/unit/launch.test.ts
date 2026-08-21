import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CliProtocolError } from "../../src/cli.js";
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
const PROMPT_ARGV = (paneId: string) => ["agent", "prompt", paneId, "--stdin"];

function profile(name: string, kind: "pi" | "claude" = "pi", fallbackProfiles: string[] = []) {
  const runtime = kind === "pi"
    ? "  kind: pi\n  model: test/model\n  thinking: low\n  tools: [read]"
    : "  kind: claude\n  model: claude/test\n  effort: medium\n  permissionMode: dontAsk\n  allowedTools: [Read]\n  disallowedTools: [Edit]";
  return parseProfile(`---\nname: ${name}\ndescription: ${name}\ntimeoutMinutes: 30\nsessionPersistence: ${kind === "claude"}\nruntime:\n${runtime}\nfallbackProfiles: ${JSON.stringify(fallbackProfiles)}\n---\n\nProfile body for ${name}.\n`, profileSource("bundled", `/profiles/${name}.md`, "/profiles"));
}

function catalog(...profiles: ReturnType<typeof profile>[]): ProfileCatalog {
  return { effective: new Map(profiles.map((item) => [item.name, item])), candidates: [], diagnostics: [] };
}

function makeCli(options: { start?: (argv: string[], attempt: number) => unknown; paneStates?: Array<Record<string, unknown>>; calls?: string[][]; stdinInputs?: string[]; snapshot?: HerdrSnapshot; omitFreshAgentSession?: boolean } = {}) {
  const calls = options.calls ?? [];
  const stdinInputs = options.stdinInputs ?? [];
  const liveSnapshot = options.snapshot ?? snapshot;
  let paneReads = 0;
  let starts = 0;
  let lastKind = "pi";
  let lastName = "worker";
  let lastPaneId = "w1:p2";
  let lastTerminalId = "terminal-0";
  let lastAgentSession = { source: "herdr:pi", agent: "pi", kind: "id", value: "session-0" };
  let promptSubmitted = false;
  const stripFreshSession = (value: Record<string, unknown>): Record<string, unknown> => {
    if (!options.omitFreshAgentSession || promptSubmitted || starts === 0) return value;
    const withoutSession = { ...value };
    delete withoutSession.agent_session;
    return withoutSession;
  };
  const cli: LaunchCli = {
    runJsonWithStdin: vi.fn<NonNullable<LaunchCli["runJsonWithStdin"]>>(async (argv, input) => {
      calls.push(argv);
      stdinInputs.push(input);
      if (argv[0] === "agent" && argv[1] === "prompt") {
        promptSubmitted = true;
        return ok("cli:agent:prompt", { type: "agent_prompted", agent: { name: lastName, pane_id: lastPaneId, agent: lastKind, terminal_id: lastTerminalId, agent_session: lastAgentSession, agent_status: "idle", interactive_ready: true, revision: 3, state_change_seq: 7, screen_detection_skipped: true } });
      }
      throw new Error(`unexpected stdin argv: ${argv.join(" ")}`);
    }),
    runJson: vi.fn<LaunchCli["runJson"]>(async (argv) => {
      calls.push(argv);
      if (argv[0] === "api") {
        const currentSnapshot = starts === 0 ? liveSnapshot : {
          ...liveSnapshot,
          panes: [
            ...liveSnapshot.panes.filter((pane) => pane.pane_id !== lastPaneId),
            stripFreshSession({ pane_id: lastPaneId, tab_id: lastPaneId === "w1:p3" ? "w1:t2" : "w1:t1", workspace_id: "w1", agent_name: lastName, agent: lastKind, terminal_id: lastTerminalId, agent_session: lastAgentSession, agent_status: "working", revision: 3 })
          ],
          agents: [
            ...liveSnapshot.agents.filter((agent) => agent.pane_id !== lastPaneId),
            stripFreshSession({ pane_id: lastPaneId, name: lastName, agent: lastKind, terminal_id: lastTerminalId, agent_session: lastAgentSession, agent_status: "working", revision: 3 })
          ]
        };
        return ok("snapshot", { type: "session_snapshot", snapshot: currentSnapshot });
      }
      if (argv[0] === "pane" && argv[1] === "split") return ok("split", { pane: { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1" } });
      if (argv[0] === "pane" && argv[1] === "rename") return ok("rename", {});
      if (argv[0] === "tab" && argv[1] === "create") return ok("tab", { tab: { tab_id: "w1:t2", workspace_id: "w1" }, root_pane: { pane_id: "w1:p3", tab_id: "w1:t2", workspace_id: "w1" } });
      if (argv[0] === "agent" && argv[1] === "start") {
        const attempt = starts++;
        lastKind = String(argv[4]);
        lastName = String(argv[2]);
        lastPaneId = calls.some((call) => call[0] === "tab" && call[1] === "create") ? "w1:p3" : "w1:p2";
        lastTerminalId = `terminal-${attempt}`;
        lastAgentSession = { source: `herdr:${lastKind}`, agent: lastKind, kind: "id", value: `session-${attempt}` };
        if (options.start) {
          const result = options.start(argv, attempt) as { result?: { agent?: Record<string, unknown> } } | null;
          const agent = result?.result?.agent;
          if (agent) {
            if (typeof agent.name === "string") lastName = agent.name;
            if (typeof agent.pane_id === "string") lastPaneId = agent.pane_id;
            if (typeof agent.agent === "string") {
              lastKind = agent.agent;
              lastAgentSession = { source: `herdr:${lastKind}`, agent: lastKind, kind: "id", value: `session-${attempt}` };
            }
            if (typeof agent.terminal_id === "string") lastTerminalId = agent.terminal_id;
            if (typeof agent.agent_session === "object" && agent.agent_session !== null && !Array.isArray(agent.agent_session)) {
              const session = agent.agent_session as Record<string, unknown>;
              if (typeof session.source === "string" && typeof session.agent === "string" && typeof session.kind === "string" && typeof session.value === "string") lastAgentSession = { source: session.source, agent: session.agent, kind: session.kind, value: session.value };
            }
          }
          return result as Awaited<ReturnType<LaunchCli["runJson"]>>;
        }
        return ok("start", { agent: { name: lastName, pane_id: lastPaneId, agent: argv[4], terminal_id: lastTerminalId, agent_session: lastAgentSession } });
      }
      if (argv[0] === "agent" && argv[1] === "prompt") return ok("cli:agent:prompt", { type: "agent_prompted", agent: { name: lastName, pane_id: lastPaneId, agent: lastKind, terminal_id: lastTerminalId, agent_session: lastAgentSession, agent_status: "idle", interactive_ready: true, revision: 3, state_change_seq: 7, screen_detection_skipped: true } });
      if (argv[0] === "agent" && argv[1] === "focus") return ok("focus", {});
      if (argv[0] === "agent" && argv[1] === "get") return ok("agent-get", { agent: stripFreshSession({ name: lastName, pane_id: lastPaneId, agent: lastKind, terminal_id: lastTerminalId, agent_status: "working", state_change_seq: 7, agent_session: lastAgentSession }) });
      if (argv[0] === "pane" && argv[1] === "get") {
        const configured = options.paneStates?.[paneReads++];
        const paneId = lastPaneId;
        return ok("get", { pane: configured ?? stripFreshSession({ pane_id: paneId, tab_id: paneId === "w1:p3" ? "w1:t2" : "w1:t1", workspace_id: "w1", agent: lastKind, terminal_id: lastTerminalId, agent_session: lastAgentSession, agent_status: "working", revision: 3 }) });
      }
      if (argv[0] === "tab" && argv[1] === "get") return ok("tab-get", { pane: { pane_id: "w1:p3", tab_id: "w1:t2", workspace_id: "w1:t2" } });
      throw new Error(`unexpected argv: ${argv.join(" ")}`);
    })
  };
  return { cli, calls, stdinInputs };
}

type LaunchIdentitySample = {
  terminalId?: string;
  name?: string;
  kind?: string;
  agentSession?: Record<string, string>;
};

function configureFreshIdentitySamples(harness: ReturnType<typeof makeCli>, samples: LaunchIdentitySample[]): void {
  const base = harness.cli.runJson;
  let apiReads = 0;
  let current: LaunchIdentitySample | undefined;
  const records = (sample: LaunchIdentitySample) => {
    const shared = {
      ...(sample.terminalId === undefined ? {} : { terminal_id: sample.terminalId }),
      ...(sample.kind === undefined ? {} : { agent: sample.kind }),
      ...(sample.agentSession === undefined ? {} : { agent_session: sample.agentSession })
    };
    return {
      pane: { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", ...shared, ...(sample.name === undefined ? {} : { agent_name: sample.name }), agent_status: "working" },
      agent: { pane_id: "w1:p2", ...shared, ...(sample.name === undefined ? {} : { name: sample.name }), agent_status: "working" }
    };
  };
  harness.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
    if (argv[0] === "api") {
      const result = await base(argv, signal, preserve);
      if (apiReads++ === 0) return result;
      current = samples[Math.min(apiReads - 2, samples.length - 1)]!;
      const value = result.result as { type: string; snapshot: HerdrSnapshot };
      const sample = records(current);
      return { ...result, result: { ...value, snapshot: { ...value.snapshot, panes: [...value.snapshot.panes.filter((pane) => pane.pane_id !== "w1:p2"), sample.pane], agents: [...value.snapshot.agents.filter((agent) => agent.pane_id !== "w1:p2"), sample.agent] } } };
    }
    if (current && argv[0] === "agent" && argv[1] === "get") { harness.calls.push(argv); return ok("agent-get", { agent: records(current).agent }); }
    if (current && argv[0] === "pane" && argv[1] === "get") { harness.calls.push(argv); return ok("pane-get", { pane: records(current).pane }); }
    return base(argv, signal, preserve);
  });
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
  it("waits for delayed identity readiness, then submits exactly once and registers the captured recipient", async () => {
    vi.useFakeTimers();
    try {
      const harness = makeCli({ start: () => ok("start", { agent: { name: "worker", pane_id: "w1:p2", agent: "pi" } }) });
      configureFreshIdentitySamples(harness, [
        { name: "worker", kind: "pi" },
        { name: "worker", kind: "pi", terminalId: "terminal-0", agentSession: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-0" } }
      ]);
      const recipients = new RecipientRegistry();
      const pending = launch({ name: "worker", profile: "worker", initialPrompt: "delayed" }, catalog(profile("worker")), harness.cli, undefined, { recipients });
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(100);
      const result = await pending;
      expect(result.details).toMatchObject({ initialPromptSent: true, initialPromptSubmission: { confirmed: true, agentSession: { value: "session-0" } }, recipient: { paneId: "w1:p2", agentName: "worker" } });
      expect(harness.stdinInputs).toHaveLength(1);
      expect(harness.calls.filter((call) => call[0] === "agent" && call[1] === "prompt")).toHaveLength(1);
      expect(recipients.get("w1:p2")).toMatchObject({ paneId: "w1:p2", agentName: "worker" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts the read-only identity preflight before any prompt bytes or recipient registration", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const harness = makeCli({ start: () => ok("start", { agent: { name: "worker", pane_id: "w1:p2", agent: "pi" } }) });
      configureFreshIdentitySamples(harness, [{ name: "worker", kind: "pi" }]);
      const recipients = new RecipientRegistry();
      const tool = createLaunchTool({ cli: harness.cli, context, cwd: "/repo", profiles: { load: async () => catalog(profile("worker")) }, attachments: fakeAttachments(), recipients });
      const pending = tool.execute("id", { name: "worker", profile: "worker", initialPrompt: "abort" }, controller.signal, undefined, extensionContext);
      await vi.waitFor(() => expect(harness.calls).toContainEqual(["pane", "get", "w1:p2"]), { timeout: 1_000, interval: 1 });
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: "ABORTED", details: { causeCode: "ABORTED" } });
      expect(harness.stdinInputs).toHaveLength(0);
      expect(recipients.get("w1:p2")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a slow successful read to the whole five-second window and cleans up", async () => {
    vi.useFakeTimers();
    try {
      const harness = makeCli();
      const base = harness.cli.runJson;
      let apiReads = 0;
      let releaseFresh!: (value: Awaited<ReturnType<LaunchCli["runJson"]>>) => void;
      const delayedFresh = new Promise<Awaited<ReturnType<LaunchCli["runJson"]>>>((resolve) => { releaseFresh = resolve; });
      harness.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
        if (argv[0] === "api" && apiReads++ === 1) return delayedFresh;
        return base(argv, signal, preserve);
      });
      const recipients = new RecipientRegistry();
      const pending = launch({ name: "worker", profile: "worker", initialPrompt: "slow but valid" }, catalog(profile("worker")), harness.cli, undefined, { recipients });
      await vi.waitFor(() => expect(apiReads).toBe(2), { timeout: 1_000, interval: 1 });
      await vi.advanceTimersByTimeAsync(4_800);
      releaseFresh(await base(["api", "snapshot"], new AbortController().signal));
      const result = await pending;
      expect(result.details).toMatchObject({ initialPromptSent: true, recipient: { paneId: "w1:p2" } });
      expect(harness.stdinInputs).toHaveLength(1);
      expect(recipients.get("w1:p2")).toBeDefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out an in-flight identity read without dispatch, registration, or leaked timers", async () => {
    vi.useFakeTimers();
    try {
      const harness = makeCli();
      const base = harness.cli.runJson;
      let apiReads = 0;
      let releaseFresh!: (value: Awaited<ReturnType<LaunchCli["runJson"]>>) => void;
      const delayedFresh = new Promise<Awaited<ReturnType<LaunchCli["runJson"]>>>((resolve) => { releaseFresh = resolve; });
      harness.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
        if (argv[0] === "api" && apiReads++ === 1) return delayedFresh;
        return base(argv, signal, preserve);
      });
      const recipients = new RecipientRegistry();
      const pending = launch({ name: "worker", profile: "worker", initialPrompt: "must not dispatch" }, catalog(profile("worker")), harness.cli, undefined, { recipients });
      const expectation = expect(pending).rejects.toMatchObject({ code: "LAUNCH_FAILED", details: { causeCode: "TARGET_IDENTITY_UNAVAILABLE", identityPreflight: { timeoutMs: 5_000 } } });
      await vi.waitFor(() => expect(apiReads).toBe(2), { timeout: 1_000, interval: 1 });
      await vi.advanceTimersByTimeAsync(4_000);
      vi.setSystemTime(Date.now() + 2_000);
      releaseFresh(await base(["api", "snapshot"], new AbortController().signal));
      await expectation;
      expect(harness.stdinInputs).toHaveLength(0);
      expect(harness.calls.some((call) => call[0] === "agent" && call[1] === "prompt")).toBe(false);
      expect(recipients.get("w1:p2")).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects when the caller is already aborted at the identity-preflight boundary", async () => {
    const controller = new AbortController();
    const harness = makeCli();
    const base = harness.cli.runJson;
    harness.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
      const result = await base(argv, signal, preserve);
      if (argv[0] === "agent" && argv[1] === "start") controller.abort();
      return result;
    });
    const recipients = new RecipientRegistry();
    const tool = createLaunchTool({ cli: harness.cli, context, cwd: "/repo", profiles: { load: async () => catalog(profile("worker")) }, attachments: fakeAttachments(), recipients });
    await expect(tool.execute("id", { name: "worker", profile: "worker", initialPrompt: "must not dispatch" }, controller.signal, undefined, extensionContext)).rejects.toMatchObject({ code: "ABORTED", details: { causeCode: "ABORTED" } });
    expect(harness.stdinInputs).toHaveLength(0);
    expect(recipients.get("w1:p2")).toBeUndefined();
  });

  it("distinguishes caller abort during an in-flight identity read and cleans up", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const harness = makeCli();
      const base = harness.cli.runJson;
      let apiReads = 0;
      let releaseFresh!: (value: Awaited<ReturnType<LaunchCli["runJson"]>>) => void;
      const delayedFresh = new Promise<Awaited<ReturnType<LaunchCli["runJson"]>>>((resolve) => { releaseFresh = resolve; });
      harness.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
        if (argv[0] === "api" && apiReads++ === 1) return delayedFresh;
        return base(argv, signal, preserve);
      });
      const recipients = new RecipientRegistry();
      const tool = createLaunchTool({ cli: harness.cli, context, cwd: "/repo", profiles: { load: async () => catalog(profile("worker")) }, attachments: fakeAttachments(), recipients });
      const pending = tool.execute("id", { name: "worker", profile: "worker", initialPrompt: "caller abort" }, controller.signal, undefined, extensionContext);
      const expectation = expect(pending).rejects.toMatchObject({ code: "ABORTED", details: { causeCode: "ABORTED" } });
      await vi.waitFor(() => expect(apiReads).toBe(2), { timeout: 1_000, interval: 1 });
      await vi.advanceTimersByTimeAsync(1_000);
      controller.abort();
      vi.advanceTimersByTime(5_000);
      await expectation;
      expect(harness.stdinInputs).toHaveLength(0);
      expect(recipients.get("w1:p2")).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
      releaseFresh(await base(["api", "snapshot"], new AbortController().signal));
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a replacement identity within one coherent sample without waiting or submitting", async () => {
    const harness = makeCli({ start: () => ok("start", { agent: { name: "worker", pane_id: "w1:p2", agent: "pi" } }) });
    const base = harness.cli.runJson;
    let apiReads = 0;
    harness.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
      if (argv[0] === "api") {
        const result = await base(argv, signal, preserve);
        if (apiReads++ === 0) return result;
        const value = result.result as { type: string; snapshot: HerdrSnapshot };
        const identity = { terminal_id: "terminal-sample", name: "worker", agent: "pi", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-sample" } };
        return { ...result, result: { ...value, snapshot: { ...value.snapshot, panes: value.snapshot.panes.map((pane) => pane.pane_id === "w1:p2" ? { ...pane, ...identity, agent_name: identity.name } : pane), agents: value.snapshot.agents.map((agent) => agent.pane_id === "w1:p2" ? { ...agent, ...identity } : agent) } } };
      }
      if (argv[0] === "agent" && argv[1] === "get" && apiReads > 1) return ok("agent-get", { agent: { name: "worker", pane_id: "w1:p2", agent: "pi", terminal_id: "terminal-other", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-sample" } } });
      return base(argv, signal, preserve);
    });
    await expect(launch({ name: "worker", profile: "worker", initialPrompt: "replacement" }, catalog(profile("worker")), harness.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED", details: { causeCode: "TARGET_IDENTITY_CHANGED" } });
    expect(harness.stdinInputs).toHaveLength(0);
    expect(harness.calls.filter((call) => call[0] === "agent" && call[1] === "prompt")).toHaveLength(0);
  });

  it("bounds launch-preflight contradiction evidence without weakening exact comparisons", async () => {
    const suffix = (value: string): string => `${"q".repeat(256)}${value}`;
    const expectedIdentity = {
      terminal_id: suffix("-terminal-expected"),
      agent_name: "worker",
      name: "worker",
      agent: "pi",
      agent_session: { source: suffix("-source-expected"), agent: "pi", kind: "id", value: suffix("-session-expected") }
    };
    const actualIdentity = {
      terminal_id: suffix("-terminal-actual"),
      agent_name: "worker",
      name: "worker",
      agent: "pi",
      agent_session: { source: suffix("-source-actual"), agent: "pi", kind: "id", value: suffix("-session-actual") }
    };
    const harness = makeCli({ start: () => ok("start", { agent: { name: "worker", pane_id: "w1:p2", agent: "pi" } }) });
    const base = harness.cli.runJson;
    let apiReads = 0;
    harness.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
      if (argv[0] === "api") {
        const result = await base(argv, signal, preserve);
        if (apiReads++ === 0) return result;
        const value = result.result as { type: string; snapshot: HerdrSnapshot };
        return { ...result, result: { ...value, snapshot: { ...value.snapshot, panes: value.snapshot.panes.map((pane) => pane.pane_id === "w1:p2" ? { ...pane, ...expectedIdentity } : pane), agents: value.snapshot.agents.map((agent) => agent.pane_id === "w1:p2" ? { ...agent, ...expectedIdentity } : agent) } } };
      }
      if (argv[0] === "agent" && argv[1] === "get") return ok("agent-get", { agent: { pane_id: "w1:p2", ...actualIdentity } });
      if (argv[0] === "pane" && argv[1] === "get") return ok("pane-get", { pane: { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", ...actualIdentity, agent_status: "working" } });
      return base(argv, signal, preserve);
    });
    const recipients = new RecipientRegistry();
    const failure = await (launch({ name: "worker", profile: "worker", initialPrompt: "must not dispatch" }, catalog(profile("worker")), harness.cli, undefined, { recipients }).catch((error: unknown) => error as { code?: string; details?: Record<string, unknown> }) as unknown as Promise<{ code?: string; details?: Record<string, unknown> }>);
    expect(failure).toMatchObject({ code: "LAUNCH_FAILED", details: { causeCode: "TARGET_IDENTITY_CHANGED" } });
    const details = failure.details!;
    expect(details.expected).toHaveLength(256);
    expect(details.actual).toHaveLength(256);
    expect(JSON.stringify(details)).not.toContain("-terminal-expected");
    expect(harness.stdinInputs).toHaveLength(0);
    expect(recipients.get("w1:p2")).toBeUndefined();
  });

  it("rejects an exact-but-replaced name after one sample without submitting", async () => {
    const harness = makeCli({ start: () => ok("start", { agent: { pane_id: "w1:p2", agent: "pi" } }) });
    const base = harness.cli.runJson;
    let apiReads = 0;
    const replacement = { terminal_id: "terminal-replacement", name: "replacement", agent: "pi", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-replacement" } };
    harness.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
      if (argv[0] === "api") {
        const result = await base(argv, signal, preserve);
        if (apiReads++ === 0) return result;
        const value = result.result as { type: string; snapshot: HerdrSnapshot };
        return { ...result, result: { ...value, snapshot: { ...value.snapshot, panes: value.snapshot.panes.map((pane) => pane.pane_id === "w1:p2" ? { ...pane, agent_name: replacement.name, ...replacement } : pane), agents: value.snapshot.agents.map((agent) => agent.pane_id === "w1:p2" ? { ...agent, ...replacement } : agent) } } };
      }
      if (apiReads > 1 && argv[0] === "agent" && argv[1] === "get") return ok("agent-get", { agent: { pane_id: "w1:p2", ...replacement } });
      if (apiReads > 1 && argv[0] === "pane" && argv[1] === "get") return ok("pane-get", { pane: { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", ...replacement, agent_name: replacement.name } });
      return base(argv, signal, preserve);
    });
    await expect(launch({ name: "worker", profile: "worker" }, catalog(profile("worker")), harness.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED", details: { causeCode: "TARGET_IDENTITY_CHANGED" } });
    expect(harness.stdinInputs).toHaveLength(0);
  });

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
      stdoutBytes: 0,
      stderrBytes: 123,
      killed: false,
      evidence: "omitted_for_stdin_delivery",
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
          details: { exitCode: 1, stdoutBytes: 0, stderrBytes: 123, killed: false, evidence: "omitted_for_stdin_delivery", stdout: "", stderr: failure.details.stderr, stdoutTruncated: false, stderrTruncated: false }
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

  it("covers exact startup identities, pane variants, prompt acknowledgement, and terminal renderers", async () => {
    const worker = profile("worker");
    for (const startResult of [null, {}, { agent: {} }, { agent: null }]) {
      const harness = makeCli({ start: () => ok("start", startResult) });
      const pending = launch({ name: "worker", profile: "worker" }, catalog(worker), harness.cli);
      if (startResult === null || (typeof startResult === "object" && startResult !== null && "agent" in startResult && startResult.agent === null)) {
        await expect(pending).rejects.toMatchObject({ code: "LAUNCH_FAILED" });
      } else {
        await expect(pending).resolves.toMatchObject({ details: { outcome: "launched" } });
      }
    }
    for (const agent of [
      { name: "other", pane_id: "w1:p2", agent: "pi", terminal_id: "terminal-wrong-name", agent_session: { source: "pi", agent: "pi", kind: "id", value: "session-wrong-name" } },
      { name: "worker", pane_id: "w1:p9", agent: "pi", terminal_id: "terminal-wrong-pane", agent_session: { source: "pi", agent: "pi", kind: "id", value: "session-wrong-pane" } },
      { name: "worker", pane_id: "w1:p2", agent: "claude", terminal_id: "terminal-wrong-kind", agent_session: { source: "claude", agent: "claude", kind: "id", value: "session-wrong-kind" } },
      { name: "worker", pane_id: "w1:p2", agent: "pi", agent_session: { source: "herdr:pi", agent: "claude", kind: "id", value: "session-wrong-session-kind" } },
      { name: "other" },
      { agent: "claude" }
    ]) {
      const harness = makeCli();
      const base = harness.cli.runJson;
      harness.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => argv[0] === "agent" && argv[1] === "start" ? ok("start", { agent }) : base(argv, signal, preserve));
      await expect(launch({ name: "worker", profile: "worker" }, catalog(worker), harness.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED" });
      expect(harness.calls.some((call) => call[0] === "pane" && call[1] === "get")).toBe(false);
    }

    const terminalOnly = makeCli({ start: () => ok("start", { agent: { name: "worker", pane_id: "w1:p2", agent: "pi", terminal_id: "terminal-worker" } }) });
    await expect(launch({ name: "worker", profile: "worker" }, catalog(worker), terminalOnly.cli)).resolves.toMatchObject({ details: { outcome: "launched", paneId: "w1:p2" } });
    const explicitAgentId = makeCli({ start: () => ok("start", { agent: { name: "worker", pane_id: "w1:p2", agent: "pi", agent_id: "agent-worker", terminal_id: "terminal-worker", agent_session: { source: "pi", agent: "pi", kind: "id", value: "session-worker" } } }) });
    await expect(launch({ name: "worker", profile: "worker" }, catalog(worker), explicitAgentId.cli)).resolves.toMatchObject({ details: { agentId: "agent-worker" } });
    const directStartRecord = makeCli({ start: () => ok("start", { name: "worker", pane_id: "w1:p2", agent: "pi" }) });
    await expect(launch({ name: "worker", profile: "worker" }, catalog(worker), directStartRecord.cli)).resolves.toMatchObject({ details: { outcome: "launched" } });

    const paneVariants = [{ pane: { pane_id: "w1:p2", tab_id: "w1:t1" } }, { root_pane: { pane_id: "w1:p2", tab_id: "w1:t1" } }, { new_pane: { pane_id: "w1:p2" } }, { child_pane: { pane_id: "w1:p2" } }, { created_pane: { pane_id: "w1:p2" } }, { pane_id: "w1:p2", tab_id: "w1:t1" }];
    for (const placement of paneVariants) {
      const harness = makeCli();
      const base = harness.cli.runJson;
      harness.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => argv[0] === "pane" && argv[1] === "split" ? ok("split", placement) : base(argv, signal, preserve));
      await expect(launch({ name: "worker", profile: "worker" }, catalog(worker), harness.cli)).resolves.toMatchObject({ details: { paneId: "w1:p2" } });
    }

    for (const placement of [null, {}, { pane: null }, { pane_id: "" }]) {
      const malformed = makeCli();
      const malformedBase = malformed.cli.runJson;
      malformed.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => argv[0] === "pane" && argv[1] === "split" ? ok("split", placement) : malformedBase(argv, signal, preserve));
      await expect(launch({ name: "worker", profile: "worker" }, catalog(worker), malformed.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED" });
    }

    {
      const harness = makeCli({ paneStates: [
        { pane_id: "w1:p2", tab_id: "w1:t1", agent: "pi", agent_name: "worker", terminal_id: "terminal-0", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-0" }, agent_status: "working", revision: 3 },
        { pane_id: "w1:p2", tab_id: "w1:t1", agent: "pi", agent_name: "worker", terminal_id: "terminal-0", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-0" }, agent_status: "idle", revision: 3 }
      ] });
      const result = await launch({ name: "worker", profile: "worker", initialPrompt: "go" }, catalog(worker), harness.cli);
      expect(result.details).toMatchObject({ initialPromptSent: true, initialPromptSubmission: { confirmed: true, operationId: "cli:agent:prompt", paneId: "w1:p2", interactiveReady: true, revision: 3, screenDetectionSkipped: true }, initialPromptObservation: { status: "detection_skipped", state: "idle", revision: 3 } });
      expect(harness.calls).toContainEqual(["agent", "prompt", "w1:p2", "--stdin"]);
      expect(harness.calls.some((call) => call[1] === "send-keys" || call[1] === "wait")).toBe(false);
      expect(harness.stdinInputs).toHaveLength(1);

      const registrationLag = makeCli({ omitFreshAgentSession: true });
      const registrationLagResult = await launch({ name: "worker", profile: "worker", initialPrompt: "registration lag" }, catalog(worker), registrationLag.cli);
      expect(registrationLagResult.details).toMatchObject({ initialPromptSent: true, initialPromptSubmission: { confirmed: true, agentSession: { value: "session-0" } } });
      expect(registrationLag.stdinInputs).toHaveLength(1);

      vi.useFakeTimers();
      const missingIdentity = makeCli({ start: () => ok("start", { agent: { name: "worker", pane_id: "w1:p2", agent: "pi" } }) });
      const missingBase = missingIdentity.cli.runJson;
      missingIdentity.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
        if (argv[0] === "api") {
          const result = await missingBase(argv, signal, preserve);
          const session = result.result as { snapshot: HerdrSnapshot; type: string };
          return { ...result, result: { ...session, snapshot: { ...session.snapshot, panes: session.snapshot.panes.map((pane) => pane.pane_id === "w1:p2" ? { pane_id: pane.pane_id, tab_id: pane.tab_id, workspace_id: pane.workspace_id, agent_status: "working", agent_session: { source: 1, agent: null, kind: {}, value: undefined } } : pane), agents: session.snapshot.agents.map((agent) => agent.pane_id === "w1:p2" ? { pane_id: agent.pane_id, agent_session: { source: 1, agent: null, kind: {}, value: undefined } } : agent) } } };
        }
        if (argv[0] === "agent" && argv[1] === "get") return ok("agent-get", { agent: { pane_id: "w1:p2", agent_session: { source: 1, agent: null, kind: {}, value: undefined } } });
        if (argv[0] === "pane" && argv[1] === "get") return ok("pane-get", { pane: { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", agent_session: { source: 1, agent: null, kind: {}, value: undefined }, agent_status: "idle" } });
        return missingBase(argv, signal, preserve);
      });
      const missingIdentityPending = launch({ name: "worker", profile: "worker", initialPrompt: "missing fresh agent record" }, catalog(worker), missingIdentity.cli);
      const missingIdentityExpectation = expect(missingIdentityPending).rejects.toMatchObject({ code: "LAUNCH_FAILED", details: { causeCode: "TARGET_IDENTITY_UNAVAILABLE", identityPreflight: { samples: expect.any(Number) } } });
      await vi.advanceTimersByTimeAsync(5_100);
      await missingIdentityExpectation;
      expect(missingIdentity.stdinInputs).toHaveLength(0);

      const missingAgentRecord = makeCli();
      const missingAgentBase = missingAgentRecord.cli.runJson;
      missingAgentRecord.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
        if (argv[0] === "agent" && argv[1] === "get") return ok("agent-get", { agent: null });
        return missingAgentBase(argv, signal, preserve);
      });
      const missingAgentPending = launch({ name: "worker", profile: "worker", initialPrompt: "missing agent record" }, catalog(worker), missingAgentRecord.cli);
      const missingAgentExpectation = expect(missingAgentPending).rejects.toMatchObject({ code: "LAUNCH_FAILED", details: { causeCode: "TARGET_IDENTITY_UNAVAILABLE", identityPreflight: { samples: expect.any(Number) } } });
      await vi.advanceTimersByTimeAsync(5_100);
      await missingAgentExpectation;
      expect(missingAgentRecord.stdinInputs).toHaveLength(0);

      const missingStartedTerminal = makeCli({ start: () => ok("start", { agent: { name: "worker", pane_id: "w1:p2", agent: "pi" } }) });
      await expect(launch({ name: "worker", profile: "worker", initialPrompt: "missing started terminal" }, catalog(worker), missingStartedTerminal.cli)).resolves.toMatchObject({ details: { initialPromptSent: true, initialPromptSubmission: { confirmed: true } } });
      expect(missingStartedTerminal.stdinInputs).toHaveLength(1);

      const missingStartedSession = makeCli({ start: () => ok("start", { agent: { name: "worker", pane_id: "w1:p2", agent: "pi", terminal_id: "terminal-worker" } }) });
      await expect(launch({ name: "worker", profile: "worker", initialPrompt: "missing started session" }, catalog(worker), missingStartedSession.cli)).resolves.toMatchObject({ details: { initialPromptSent: true, initialPromptSubmission: { confirmed: true } } });
      expect(missingStartedSession.stdinInputs).toHaveLength(1);
      vi.useRealTimers();

      const replacementIdentity = makeCli();
      const replacementBase = replacementIdentity.cli.runJson;
      replacementIdentity.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
        if (argv[0] === "agent" && argv[1] === "get") return ok("agent-get", { agent: { name: "worker", pane_id: "w1:p2", agent: "pi", terminal_id: "terminal-0", agent_session: { source: "pi", agent: "pi", kind: "id", value: "replacement" } } });
        return replacementBase(argv, signal, preserve);
      });
      await expect(launch({ name: "worker", profile: "worker", initialPrompt: "must not send" }, catalog(worker), replacementIdentity.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED", details: { causeCode: "TARGET_IDENTITY_CHANGED" } });
      expect(replacementIdentity.stdinInputs).toHaveLength(0);

      const mismatchedAck = makeCli();
      mismatchedAck.cli.runJsonWithStdin = vi.fn(async (argv, input) => {
        mismatchedAck.calls.push(argv);
        mismatchedAck.stdinInputs.push(input);
        return ok("cli:agent:prompt", { type: "agent_prompted", agent: { name: "worker", pane_id: "w1:p2", agent: "pi", terminal_id: "terminal-replacement", agent_session: { source: "pi", agent: "pi", kind: "id", value: "session-0" }, agent_status: "idle", interactive_ready: true, revision: 3 } });
      });
      await expect(launch({ name: "worker", profile: "worker", initialPrompt: "ack mismatch" }, catalog(worker), mismatchedAck.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED", details: { causeCode: "CLI_PROTOCOL_ERROR" } });
      expect(mismatchedAck.stdinInputs).toHaveLength(1);
      expect(mismatchedAck.calls.some((call) => call[1] === "send-keys" || call[1] === "wait")).toBe(false);

      const terminalReplacement = makeCli();
      const terminalBase = terminalReplacement.cli.runJson;
      terminalReplacement.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
        if (argv[0] === "agent" && argv[1] === "get") return ok("agent-get", { agent: { name: "worker", pane_id: "w1:p2", agent: "pi", terminal_id: "terminal-replacement", agent_session: { source: "pi", agent: "pi", kind: "id", value: "replacement" } } });
        if (argv[0] === "pane" && argv[1] === "get") return ok("pane-get", { pane: { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", agent_name: "worker", agent: "pi", terminal_id: "terminal-replacement", agent_session: { source: "pi", agent: "pi", kind: "id", value: "replacement" }, agent_status: "working", revision: 3 } });
        return terminalBase(argv, signal, preserve);
      });
      await expect(launch({ name: "worker", profile: "worker", initialPrompt: "terminal replacement" }, catalog(worker), terminalReplacement.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED", details: { causeCode: "TARGET_IDENTITY_CHANGED" } });
      expect(terminalReplacement.stdinInputs).toHaveLength(0);

      const freshReplacement = makeCli();
      const freshReplacementBase = freshReplacement.cli.runJson;
      let freshApiReads = 0;
      let freshAgentReads = 0;
      freshReplacement.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
        if (argv[0] === "api" && freshApiReads++ > 0) {
          const result = await freshReplacementBase(argv, signal, preserve);
          const value = result.result as { type: string; snapshot: HerdrSnapshot };
          const replacementIdentity = { terminal_id: "terminal-replacement", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "replacement" } };
          return { ...result, result: { ...value, snapshot: { ...value.snapshot, panes: value.snapshot.panes.map((pane) => pane.pane_id === "w1:p2" ? { ...pane, agent_name: "worker", agent: "pi", ...replacementIdentity } : pane), agents: value.snapshot.agents.map((agent) => agent.pane_id === "w1:p2" ? { ...agent, name: "worker", agent: "pi", ...replacementIdentity } : agent) } } };
        }
        if (argv[0] === "agent" && argv[1] === "get") { freshAgentReads++; return ok("agent-replacement", { agent: { name: "worker", pane_id: "w1:p2", agent: "pi", terminal_id: "terminal-replacement", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "replacement" } } }); }
        if (argv[0] === "pane" && argv[1] === "get" && freshAgentReads > 0) return ok("pane-replacement", { pane: { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", agent_name: "worker", agent: "pi", terminal_id: "terminal-replacement", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "replacement" }, agent_status: "working" } });
        return freshReplacementBase(argv, signal, preserve);
      });
      await expect(launch({ name: "worker", profile: "worker" }, catalog(worker), freshReplacement.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED", details: { causeCode: "TARGET_IDENTITY_CHANGED" } });

      const postStateReplacement = makeCli();
      const postStateBase = postStateReplacement.cli.runJson;
      let postAgentReads = 0;
      postStateReplacement.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
        if (argv[0] === "agent" && argv[1] === "get" && postAgentReads++ > 0) return ok("agent-post", { agent: { name: "worker", pane_id: "w1:p2", agent: "pi", terminal_id: "terminal-replacement", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "replacement" }, agent_status: "working" } });
        if (argv[0] === "pane" && argv[1] === "get" && postAgentReads > 1) return ok("pane-post", { pane: { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", agent_name: "worker", agent: "pi", terminal_id: "terminal-replacement", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "replacement" }, agent_status: "working", revision: 4 } });
        return postStateBase(argv, signal, preserve);
      });
      const postStateResult = await launch({ name: "worker", profile: "worker", initialPrompt: "post replacement" }, catalog(worker), postStateReplacement.cli);
      expect(postStateResult.details).toMatchObject({ initialPromptSubmission: { confirmed: true }, initialPromptObservation: { status: "unavailable", code: "POSTSTATE_IDENTITY_CHANGED", evidence: { records: expect.any(Array) } } });
      expect(postStateResult.details).not.toHaveProperty("postState");
      expect(JSON.stringify(postStateResult.content)).not.toContain("working");
      expect(postStateReplacement.stdinInputs).toHaveLength(1);
      const postPromptIndex = postStateReplacement.calls.findIndex((call) => call[0] === "agent" && call[1] === "prompt");
      expect(postStateReplacement.calls.slice(0, postPromptIndex)).toContainEqual(["api", "snapshot"]);
      expect(postStateReplacement.calls.slice(0, postPromptIndex)).toContainEqual(["agent", "get", "w1:p2"]);
      expect(postStateReplacement.calls.slice(0, postPromptIndex)).toContainEqual(["pane", "get", "w1:p2"]);

      const postAgentId = makeCli();
      const postAgentIdBase = postAgentId.cli.runJson;
      let postAgentIdReads = 0;
      postAgentId.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
        if (argv[0] === "agent" && argv[1] === "get") {
          const result = await postAgentIdBase(argv, signal, preserve);
          const value = result.result as { agent: Record<string, unknown> };
          if (postAgentIdReads++ > 0) value.agent.agent_id = "post-agent-id";
          return result;
        }
        return postAgentIdBase(argv, signal, preserve);
      });
      const postAgentIdResult = await launch({ name: "worker", profile: "worker", initialPrompt: "post id" }, catalog(worker), postAgentId.cli);
      expect(postAgentIdResult.details).toMatchObject({ agentId: "post-agent-id", initialPromptSubmission: { confirmed: true } });

      const startedSessionReplacement = makeCli({ start: () => ok("start", { agent: { name: "worker", pane_id: "w1:p2", agent: "pi", terminal_id: "terminal-0", agent_session: { source: "pi", agent: "pi", kind: "id", value: "started" } } }) });
      const startedBase = startedSessionReplacement.cli.runJson;
      startedSessionReplacement.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
        if (argv[0] === "agent" && argv[1] === "get") return ok("agent-get", { agent: { name: "worker", pane_id: "w1:p2", agent: "pi", terminal_id: "terminal-0", agent_session: { source: "pi", agent: "pi", kind: "id", value: "replacement" } } });
        if (argv[0] === "pane" && argv[1] === "get") return ok("pane-get", { pane: { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", agent_name: "worker", agent: "pi", terminal_id: "terminal-0", agent_session: { source: "pi", agent: "pi", kind: "id", value: "replacement" }, agent_status: "working", revision: 3 } });
        return startedBase(argv, signal, preserve);
      });
      await expect(launch({ name: "worker", profile: "worker", initialPrompt: "session replacement" }, catalog(worker), startedSessionReplacement.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED", details: { causeCode: "TARGET_IDENTITY_CHANGED" } });
      expect(startedSessionReplacement.stdinInputs).toHaveLength(0);
    }

    {
      const harness = makeCli();
      const base = harness.cli.runJson;
      let paneReads = 0;
      harness.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
        if (argv[0] === "pane" && argv[1] === "get" && paneReads++ > 0) throw Object.assign(new Error("observation unavailable"), { code: "CLI_PROTOCOL_ERROR" });
        return base.call(harness.cli, argv, signal, preserve);
      });
      const result = await launch({ name: "worker", profile: "worker", initialPrompt: "go" }, catalog(worker), harness.cli);
      expect(result.details).toMatchObject({ initialPromptSubmission: { confirmed: true }, initialPromptObservation: { status: "unavailable", code: "CLI_PROTOCOL_ERROR" } });
      expect(harness.stdinInputs).toHaveLength(1);

      const stringFailure = makeCli();
      const stringBase = stringFailure.cli.runJson;
      let stringPaneReads = 0;
      stringFailure.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => argv[0] === "pane" && argv[1] === "get" && stringPaneReads++ > 0 ? Promise.reject("observation unavailable") : stringBase.call(stringFailure.cli, argv, signal, preserve));
      await expect(launch({ name: "worker", profile: "worker", initialPrompt: "go" }, catalog(worker), stringFailure.cli)).resolves.toMatchObject({ details: { initialPromptSubmission: { confirmed: true }, initialPromptObservation: { status: "unavailable", code: "POSTSTATE_UNAVAILABLE" } } });

      const aborted = makeCli();
      const abortBase = aborted.cli.runJson;
      let abortedPaneReads = 0;
      aborted.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => argv[0] === "pane" && argv[1] === "get" && abortedPaneReads++ > 0 ? Promise.reject(Object.assign(new Error("aborted"), { code: "ABORTED" })) : abortBase.call(aborted.cli, argv, signal, preserve));
      await expect(launch({ name: "worker", profile: "worker", initialPrompt: "go" }, catalog(worker), aborted.cli)).resolves.toMatchObject({ details: { initialPromptSubmission: { confirmed: true }, initialPromptObservation: { status: "unavailable", code: "ABORTED" } } });
    }

    {
      const harness = makeCli();
      harness.cli.runJsonWithStdin = vi.fn(async (_argv, input) => { harness.stdinInputs.push(input); throw new CliProtocolError("CLI_PROTOCOL_ERROR", "Herdr CLI did not return a usable response", { exitCode: 1, killed: false, evidence: "omitted_for_stdin_delivery" }); });
      await expect(launch({ name: "worker", profile: "worker", initialPrompt: "go" }, catalog(worker), harness.cli)).rejects.toMatchObject({ code: "LAUNCH_FAILED", details: { causeCode: "CLI_PROTOCOL_ERROR" } });
      expect(harness.calls.filter((call) => call[0] === "agent" && call[1] === "send-keys")).toHaveLength(0);
      expect(harness.calls.filter((call) => call[0] === "agent" && call[1] === "wait")).toHaveLength(0);
      expect(harness.stdinInputs).toHaveLength(1);
    }

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
    let tabLookupStarted = false;
    const tabLookupIdentity = { terminal_id: "terminal-tab", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-tab" } };
    tabLookup.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
      if (argv[0] === "api" && tabLookupStarted) return ok("snapshot", { type: "session_snapshot", snapshot: { ...snapshot, panes: [{ ...snapshot.panes[0]!, pane_id: "w1:p3", tab_id: "w1:t2", agent_name: "worker", agent: "pi", ...tabLookupIdentity }], agents: [{ pane_id: "w1:p3", name: "worker", agent: "pi", ...tabLookupIdentity }] } });
      if (argv[0] === "tab" && argv[1] === "create") return ok("tab", { tab: { tab_id: "w1:t2" } });
      if (argv[0] === "tab" && argv[1] === "get") return ok("tab", { rootPane: { pane_id: "w1:p3", tab_id: "w1:t2" } });
      if (argv[0] === "agent" && argv[1] === "start") { tabLookupStarted = true; return ok("start", { agent: { name: "worker", pane_id: "w1:p3", agent: "pi", ...tabLookupIdentity } }); }
      if (argv[0] === "agent" && argv[1] === "get") return ok("agent-get", { agent: { pane_id: "w1:p3", name: "worker", agent: "pi", ...tabLookupIdentity } });
      if (argv[0] === "pane" && argv[1] === "get") return ok("get", { pane: { pane_id: "w1:p3", tab_id: "w1:t2", workspace_id: "w1", agent: "pi", ...tabLookupIdentity, agent_status: "idle" } });
      return tabLookupBase(argv, signal, preserve);
    });
    await expect(launch({ name: "worker", profile: "worker", placement: { mode: "new_tab", tabLabel: "agents" } }, catalog(worker), tabLookup.cli)).resolves.toMatchObject({ details: { paneId: "w1:p3" } });

    const nonNamedAgent = makeCli();
    const nonNamedBase = nonNamedAgent.cli.runJson;
    let nonNamedApiReads = 0;
    nonNamedAgent.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => argv[0] === "api" && nonNamedApiReads++ === 0 ? ok("snapshot", { type: "session_snapshot", snapshot: { ...snapshot, agents: [{ pane_id: "w1:p9" }] } }) : nonNamedBase(argv, signal, preserve));
    await expect(launch({ name: "worker", profile: "worker" }, catalog(worker), nonNamedAgent.cli)).resolves.toMatchObject({ details: { name: "worker" } });

    const duplicate = makeCli();
    const duplicateBase = duplicate.cli.runJson;
    duplicate.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => argv[0] === "api" ? ok("snapshot", { type: "session_snapshot", snapshot: { ...snapshot, agents: [{ pane_id: "w1:p9", name: "worker" }] } }) : duplicateBase(argv, signal, preserve));
    await expect(launch({ name: "worker", profile: "worker" }, catalog(worker), duplicate.cli)).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const stringNamedPane = makeCli();
    const stringNamedBase = stringNamedPane.cli.runJson;
    let stringNamedApiReads = 0;
    stringNamedPane.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => argv[0] === "api" && stringNamedApiReads++ === 0 ? ok("snapshot", { type: "session_snapshot", snapshot: { ...snapshot, panes: [...snapshot.panes, { pane_id: "w1:p9", tab_id: "w1:t1", workspace_id: "w1", agent: "other" }] } }) : stringNamedBase(argv, signal, preserve));
    await expect(launch({ name: "worker", profile: "worker" }, catalog(worker), stringNamedPane.cli)).resolves.toMatchObject({ details: { name: "worker" } });

    const namedPane = makeCli();
    const namedBase = namedPane.cli.runJson;
    let namedApiReads = 0;
    namedPane.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => argv[0] === "api" && namedApiReads++ === 0 ? ok("snapshot", { type: "session_snapshot", snapshot: { ...snapshot, panes: [...snapshot.panes, { pane_id: "w1:p9", tab_id: "w1:t1", workspace_id: "w1", agent_name: "other" }] } }) : namedBase(argv, signal, preserve));
    await expect(launch({ name: "worker", profile: "worker" }, catalog(worker), namedPane.cli)).resolves.toMatchObject({ details: { name: "worker" } });
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
    let focusedStarted = false;
    const focusedIdentity = { terminal_id: "terminal-focused", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-focused" } };
    focused.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
      if (argv[0] === "api" && focusedStarted) return ok("snapshot", { type: "session_snapshot", snapshot: { ...snapshot, panes: [{ ...snapshot.panes[0]!, pane_id: "w1:p1", agent_name: "worker", agent: "pi", ...focusedIdentity }], agents: [{ pane_id: "w1:p1", name: "worker", agent: "pi", ...focusedIdentity }] } });
      if (argv[0] === "agent" && argv[1] === "start") { focusedStarted = true; return ok("start", { agent: { name: "worker", pane_id: "w1:p1", agent: "pi", ...focusedIdentity } }); }
      if (argv[0] === "agent" && argv[1] === "get") return ok("agent-get", { agent: { name: "worker", pane_id: "w1:p1", agent: "pi", ...focusedIdentity } });
      if (argv[0] === "pane" && argv[1] === "get") return ok("get", { pane: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", agent: "pi", ...focusedIdentity, agent_status: "idle" } });
      return focusedBase(argv, signal, preserve);
    });
    await expect(launch({ name: "worker", profile: "worker", placement: { mode: "existing_pane", target: "caller" }, focus: true }, catalog(profile("worker")), focused.cli)).resolves.toMatchObject({ details: { paneId: "w1:p1" } });
    expect(focused.calls).toContainEqual(["agent", "focus", "w1:p1"]);
    for (const focusError of ["CLI_TIMEOUT", "READY_TIMEOUT"]) {
      const focusFailure = makeCli();
      const focusBase = focusFailure.cli.runJson;
      focusFailure.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
        if (argv[0] === "agent" && argv[1] === "start") return ok("start", { agent: { name: "worker", pane_id: "w1:p1", agent: "pi", terminal_id: "terminal-focus-failure", agent_session: { source: "pi", agent: "pi", kind: "id", value: "session-focus-failure" } } });
        if (argv[0] === "agent" && argv[1] === "focus") throw Object.assign(new Error(focusError), { code: focusError });
        if (argv[0] === "pane" && argv[1] === "get") return ok("get", { pane: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", agent: "pi", agent_status: "idle" } });
        return focusBase(argv, signal, preserve);
      });
      await expect(launch({ name: "worker", profile: "worker", placement: { mode: "existing_pane", target: "caller" }, focus: true }, catalog(profile("worker")), focusFailure.cli)).rejects.toMatchObject({ code: "READY_TIMEOUT" });
    }

    const idlePrompt = makeCli({ paneStates: [
      { pane_id: "w1:p2", tab_id: "w1:t1", agent: "pi", agent_name: "worker", terminal_id: "terminal-0", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-0" }, agent_status: "working", revision: 3 },
      { pane_id: "w1:p2", tab_id: "w1:t1", agent: "pi", agent_name: "worker", terminal_id: "terminal-0", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-0" }, agent_status: "idle", revision: 3 }
    ] });
    await expect(launch({ name: "worker", profile: "worker", initialPrompt: "go" }, catalog(profile("worker")), idlePrompt.cli)).resolves.toMatchObject({ details: { initialPromptSent: true, initialPromptObservation: { status: "detection_skipped", state: "idle" } } });

    const unknownState = makeCli({ paneStates: [
      { pane_id: "w1:p2", tab_id: "w1:t1", agent: "pi", agent_name: "worker", terminal_id: "terminal-0", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-0" }, agent_status: "working", revision: 3 },
      { pane_id: "w1:p2", tab_id: "w1:t1", agent: "pi", agent_name: "worker", terminal_id: "terminal-0", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-0" } }
    ] });
    await expect(launch({ name: "worker", profile: "worker", initialPrompt: "go" }, catalog(profile("worker")), unknownState.cli)).resolves.toMatchObject({ details: { initialPromptSent: true, initialPromptObservation: { status: "detection_skipped", state: "working" } } });

    const genericPostState = makeCli();
    const genericPostBase = genericPostState.cli.runJson;
    genericPostState.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => argv[0] === "pane" && argv[1] === "get" ? Promise.reject(Object.assign(new Error("post-state unavailable"), { code: "POSTSTATE_UNAVAILABLE" })) : genericPostBase(argv, signal, preserve));
    await expect(launch({ name: "worker", profile: "worker" }, catalog(profile("worker")), genericPostState.cli)).rejects.toMatchObject({ code: "POSTSTATE_UNAVAILABLE" });

    vi.useFakeTimers();
    const noName = makeCli();
    const noNameBase = noName.cli.runJson;
    noName.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
      if (argv[0] === "agent" && argv[1] === "start") return ok("start", { agent: { agent_id: "agent-only" } });
      if (argv[0] === "pane" && argv[1] === "get") return ok("get", { pane: { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", agent_status: "idle" } });
      return noNameBase(argv, signal, preserve);
    });
    const noNamePending = launch({ name: "worker", profile: "worker" }, catalog(profile("worker")), noName.cli);
    const noNameExpectation = expect(noNamePending).rejects.toMatchObject({ code: "LAUNCH_FAILED", details: { causeCode: "TARGET_IDENTITY_UNAVAILABLE", identityPreflight: { samples: expect.any(Number) } } });
    await vi.advanceTimersByTimeAsync(5_100);
    await noNameExpectation;
    vi.useRealTimers();

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

  it("preserves a completed launch prompt acknowledgement when abort arrives after submission", async () => {
    const controller = new AbortController();
    const aborted = makeCli();
    aborted.cli.runJsonWithStdin = vi.fn(async (argv, input, _signal, preserveCompletedMutation) => {
      aborted.calls.push(argv);
      aborted.stdinInputs.push(input);
      expect(preserveCompletedMutation).toBe(true);
      controller.abort();
      return ok("cli:agent:prompt", { type: "agent_prompted", agent: { name: "worker", pane_id: "w1:p2", agent: "pi", terminal_id: "terminal-0", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-0" }, interactive_ready: true, revision: 3 } });
    });
    const tool = createLaunchTool({ cli: aborted.cli, context, cwd: "/repo", profiles: { load: async () => catalog(profile("worker")) }, promptSources: { create: vi.fn(async () => ({ path: "/cache/body.md" })) }, attachments: fakeAttachments(), recipients: new RecipientRegistry() });
    await expect(tool.execute("id", { name: "worker", profile: "worker", initialPrompt: "go" }, controller.signal, undefined, extensionContext)).resolves.toMatchObject({ details: { initialPromptSent: true, initialPromptSubmission: { confirmed: true }, initialPromptObservation: { status: "unavailable", code: "ABORTED" } } });
    expect(aborted.stdinInputs).toHaveLength(1);
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
    let existingStarted = false;
    const existingIdentity = { terminal_id: "terminal-existing-attachment", agent_session: { source: "claude", agent: "claude", kind: "id", value: "session-existing-attachment" } };
    existingPane.cli.runJson = vi.fn<LaunchCli["runJson"]>(async (argv, signal, preserve) => {
      if (argv[0] === "api" && existingStarted) return ok("snapshot", { type: "session_snapshot", snapshot: { ...snapshot, panes: [{ ...snapshot.panes[0]!, pane_id: "w1:p1", agent_name: "worker", agent: "claude", ...existingIdentity }], agents: [{ pane_id: "w1:p1", name: "worker", agent: "claude", ...existingIdentity }] } });
      if (argv[0] === "agent" && argv[1] === "start") { existingStarted = true; return ok("start", { agent: { name: "worker", pane_id: "w1:p1", agent: "claude", ...existingIdentity } }); }
      if (argv[0] === "agent" && argv[1] === "get") return ok("agent-get", { agent: { pane_id: "w1:p1", name: "worker", agent: "claude", ...existingIdentity, agent_status: "working" } });
      if (argv[0] === "pane" && argv[1] === "get") return ok("get", { pane: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", agent_name: "worker", agent: "claude", ...existingIdentity, agent_status: "working", revision: 3 } });
      return existingBase(argv, signal, preserve);
    });
    existingPane.cli.runJsonWithStdin = vi.fn(async (argv, input) => {
      existingPane.calls.push(argv);
      existingPane.stdinInputs.push(input);
      return ok("cli:agent:prompt", { type: "agent_prompted", agent: { name: "worker", pane_id: "w1:p1", agent: "claude", terminal_id: "terminal-existing-attachment", agent_session: { source: "claude", agent: "claude", kind: "id", value: "session-existing-attachment" }, agent_status: "working", interactive_ready: true, revision: 3, state_change_seq: 1, screen_detection_skipped: true } });
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
      return ok("start", { agent: { name: "worker", pane_id: "w1:p2", agent: "claude", terminal_id: "terminal-fallback", agent_session: { source: "claude", agent: "claude", kind: "id", value: "session-fallback" } } });
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

    const existing = { ...snapshot, panes: [{ ...snapshot.panes[0]!, label: "target" }] };
    const existingIdentity = { terminal_id: "terminal-existing", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-existing" } };
    let existingStarted = false;
    const existingCli: LaunchCli = { runJson: vi.fn(async (argv) => {
      if (argv[0] === "api") return ok("snapshot", { type: "session_snapshot", snapshot: existingStarted ? { ...existing, panes: [{ ...existing.panes[0]!, agent_name: "worker", agent: "pi", ...existingIdentity }], agents: [{ pane_id: "w1:p1", name: "worker", agent: "pi", ...existingIdentity }] } : existing });
      if (argv[0] === "agent" && argv[1] === "start") { existingStarted = true; return ok("start", { agent: { name: "worker", pane_id: "w1:p1", agent: "pi", ...existingIdentity } }); }
      if (argv[0] === "agent" && argv[1] === "get") return ok("agent-get", { agent: { name: "worker", pane_id: "w1:p1", agent: "pi", ...existingIdentity } });
      if (argv[0] === "pane" && argv[1] === "get") return ok("get", { pane: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", agent: "pi", ...existingIdentity, agent_status: "idle" } });
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
