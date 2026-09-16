import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { HerdrCli, type PiExec } from "../../src/cli.js";
import { createHandoffAllocator } from "../../src/handoff.js";
import { createHandoffGate } from "../../src/handoff-gate.js";
import { createInspectTool, MAX_INSPECT_CONTENT_BYTES } from "../../src/tools/inspect.js";
import type { HerdrSnapshot } from "../../src/targets.js";
import { parseProfile, profileSource, type ProfileCatalog } from "../../src/profiles/index.js";

const snapshot: HerdrSnapshot = {
  version: "0.8.0",
  protocol: 22,
  workspaces: [{ workspace_id: "w1", label: "workspace", focused: true }],
  tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main", focused: true }],
  panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "caller", agent_status: "idle", agent_name: "caller" }],
  agents: [{ pane_id: "w1:p1", name: "caller", agent_status: "idle" }]
};

function makeCli(readOutput?: string, snapshotValue: HerdrSnapshot = snapshot) {
  const calls: string[][] = [];
  const lines = Array.from({ length: 137 }, (_, i) => `line-${i + 1}`);
  const output = readOutput ?? lines.join("\n");
  const exec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
    calls.push(argv);
    if (argv[0] === "pane" && argv[1] === "current") return { stdout: JSON.stringify({ id: "current", result: { type: "pane_current", pane: snapshotValue.panes.find((item) => item.pane_id === "w1:p1") } }), stderr: "", code: 0, killed: false };
    if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { snapshot: snapshotValue, type: "session_snapshot" } }), stderr: "", code: 0, killed: false };
    if (argv[0] === "pane" && argv[1] === "get") {
      const pane = snapshotValue.panes.find((item) => item.pane_id === argv[2]) ?? snapshotValue.panes[0];
      return { stdout: JSON.stringify({ id: "get", result: { pane, type: "pane_info" } }), stderr: "", code: 0, killed: false };
    }
    if (argv[0] === "pane" && argv[1] === "read") return { stdout: output, stderr: "", code: 0, killed: false };
    throw new Error(`unexpected argv ${argv.join(" ")}`);
  });
  return { cli: new HerdrCli(exec), calls };
}

const context = { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" };
const extensionContext = {} as ExtensionContext;

function execute(cli: HerdrCli, params: Record<string, unknown>) {
  return createInspectTool({ cli, context }).execute("id", params as never, new AbortController().signal, undefined, extensionContext);
}

function contentText(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
  const block = result.content[0];
  if (block?.type !== "text" || typeof block.text !== "string") throw new Error("expected a text content block");
  return block.text;
}

describe("herdr_inspect", () => {
  it("returns the default current target with exactly the recent-unwrapped tail of 100 lines", async () => {
    const { cli, calls } = makeCli();
    const result = await execute(cli, {});
    expect(result.details).toMatchObject({ kind: "target", target: { paneId: "w1:p1" }, context: { injected: context, effective: context, rebound: false, attempts: 1 } });
    const content = JSON.parse(contentText(result)) as Record<string, unknown>;
    expect(content).toMatchObject({ modelVisible: true, operation: "inspect", kind: "target", context: { injected: context, effective: context, rebound: false, attempts: 1 } });
    expect(result.details.recentUnwrappedLines).toEqual(Array.from({ length: 100 }, (_, i) => `line-${i + 38}`));
    expect(calls).toContainEqual(["pane", "read", "w1:p1", "--source", "recent-unwrapped", "--lines", "100", "--format", "text"]);
    const healthCli = new HerdrCli(vi.fn<PiExec>().mockResolvedValue({ stdout: JSON.stringify({ client: { version: "0.8.0", protocol: 22 }, server: { status: "stopped" } }), stderr: "", code: 0, killed: false }));
    await expect(createInspectTool({ cli: healthCli, context }).execute("id", { mode: "health" } as never, undefined, undefined, extensionContext)).resolves.toMatchObject({ details: { kind: "health" } });
  });

  it("publishes bounded structured model-visible content for target, collection, and health", async () => {
    const hugeOutput = Array.from({ length: 120 }, (_, index) => `${"x".repeat(900)}-${index}`).join("\\n");
    const target = await execute(makeCli(hugeOutput).cli, { mode: "target", target: "caller" });
    const targetContent = JSON.parse(contentText(target)) as Record<string, unknown>;
    expect(targetContent).toMatchObject({ modelVisible: true, operation: "inspect", kind: "target", target: { paneId: "w1:p1" }, metadata: { pane_id: "w1:p1" }, truncated: true });
    expect((targetContent.recentUnwrappedLines as string[]).length).toBeLessThanOrEqual(100);
    expect(Buffer.byteLength(contentText(target), "utf8")).toBeLessThanOrEqual(MAX_INSPECT_CONTENT_BYTES);

    const collectionSnapshot: HerdrSnapshot = {
      ...snapshot,
      panes: [snapshot.panes[0]!, ...Array.from({ length: 120 }, (_, index) => ({ pane_id: `w1:p${index + 2}`, tab_id: "w1:t1", workspace_id: "w1", label: `worker-${index}`, agent_status: "idle" }))]
    };
    const collection = await execute(makeCli(undefined, collectionSnapshot).cli, { mode: "collection", collection: "panes" });
    const collectionContent = JSON.parse(contentText(collection)) as Record<string, unknown>;
    expect(collectionContent).toMatchObject({ modelVisible: true, collection: "panes", truncated: true, omittedCount: 21 });
    expect(collectionContent.items).toHaveLength(100);
    expect(Buffer.byteLength(contentText(collection), "utf8")).toBeLessThanOrEqual(MAX_INSPECT_CONTENT_BYTES);

    const healthExec = vi.fn<PiExec>().mockResolvedValue({
      stdout: JSON.stringify({ client: { version: "0.8.0", protocol: 22 }, server: { status: "running", version: "0.8.0", protocol: 22, compatible: true, socket: "/secret/socket" } }),
      stderr: "",
      code: 0,
      killed: false
    });
    const healthResult = await createInspectTool({ cli: new HerdrCli(healthExec), context, environment: { enabled: true, currentIdsPresent: true, currentIdsValid: true, secret: "health-secret" } as never }).execute("id", { mode: "health" } as never, new AbortController().signal, undefined, extensionContext);
    const healthContent = JSON.parse(contentText(healthResult)) as Record<string, unknown>;
    expect(healthContent).toMatchObject({ modelVisible: true, kind: "health", client: { protocol: 22 }, server: { status: "running", protocol: 22 }, socketReachable: true, compatible: true, environment: { enabled: true, currentIdsPresent: true, currentIdsValid: true } });
    expect(JSON.stringify(healthContent)).not.toContain("/secret/socket");
    expect(JSON.stringify(healthContent)).not.toContain("health-secret");
    expect(Buffer.byteLength(contentText(healthResult), "utf8")).toBeLessThanOrEqual(MAX_INSPECT_CONTENT_BYTES);
  });

  it("exposes the strict AGY runtime and permissions in profile inspection", async () => {
    const agy = parseProfile(`---\nname: researcher-agy\ndescription: AGY researcher\ntimeoutMinutes: 30\nsessionPersistence: true\nruntime:\n  kind: agy\n  model: gemini-3.8-flash-high\n  mode: plan\n  addDirs: [./research]\nfallbackProfiles: [researcher-pi]\n---\n\nCatalog metadata only.\n`, profileSource("bundled", "/profiles/researcher-agy.md", "/profiles"));
    const pi = parseProfile(`---\nname: researcher-pi\ndescription: Pi researcher\ntimeoutMinutes: 30\nsessionPersistence: true\nruntime:\n  kind: pi\n  model: test/model\n  thinking: high\n  tools: [read]\nfallbackProfiles: []\n---\n\nPi fallback.\n`, profileSource("bundled", "/profiles/researcher-pi.md", "/profiles"));
    const workerAgy = parseProfile(`---\nname: worker-agy\ndescription: AGY worker\ntimeoutMinutes: 30\nsessionPersistence: true\nruntime:\n  kind: agy\n  model: gemini-3.8-flash-high\n  mode: accept-edits\n  addDirs: []\nfallbackProfiles: []\n---\n\nCatalog metadata only.\n`, profileSource("bundled", "/profiles/worker-agy.md", "/profiles"));
    const workerDevin = parseProfile(`---\nname: worker-devin\ndescription: Devin worker\ntimeoutMinutes: 30\nsessionPersistence: true\nruntime:\n  kind: devin\n  model: swe-2-max\n  permissionMode: dangerous\nfallbackProfiles: []\n---\n\nCatalog metadata only.\n`, profileSource("bundled", "/profiles/worker-devin.md", "/profiles"));
    const catalog: ProfileCatalog = { effective: new Map([[agy.name, agy], [workerAgy.name, workerAgy], [pi.name, pi], [workerDevin.name, workerDevin]]), candidates: [], diagnostics: [] };
    const result = await createInspectTool({ cli: makeCli().cli, context, profiles: { load: async () => catalog } }).execute("id", { mode: "profile", profile: "researcher-agy" } as never, new AbortController().signal, undefined, extensionContext);

    expect(result.details).toMatchObject({ profile: {
      kind: "agy",
      model: "gemini-3.8-flash-high",
      mode: "plan",
      dangerouslySkipPermissions: true,
      addDirs: ["/profiles/research"],
      sessionPersistence: true,
      runtime: { kind: "agy", model: "gemini-3.8-flash-high", mode: "plan", dangerouslySkipPermissions: true, addDirs: ["/profiles/research"] },
      fallbackProfiles: ["researcher-pi"]
    } });
    expect(JSON.parse(contentText(result))).toMatchObject({ profile: { kind: "agy", model: "gemini-3.8-flash-high", mode: "plan", dangerouslySkipPermissions: true, addDirs: ["/profiles/research"], sessionPersistence: true } });

    const worker = await createInspectTool({ cli: makeCli().cli, context, profiles: { load: async () => catalog } }).execute("id", { mode: "profile", profile: "worker-agy" } as never, new AbortController().signal, undefined, extensionContext);
    expect(worker.details).toMatchObject({ profile: { kind: "agy", mode: "accept-edits", dangerouslySkipPermissions: true, runtime: { kind: "agy", mode: "accept-edits", dangerouslySkipPermissions: true } } });
    expect(JSON.parse(contentText(worker))).toMatchObject({ profile: { kind: "agy", mode: "accept-edits", dangerouslySkipPermissions: true } });

    const devin = await createInspectTool({ cli: makeCli().cli, context, profiles: { load: async () => catalog } }).execute("id", { mode: "profile", profile: "worker-devin" } as never, new AbortController().signal, undefined, extensionContext);
    expect(devin.details).toMatchObject({ profile: { kind: "devin", model: "swe-2-max", permissionMode: "dangerous", sessionPersistence: true, runtime: { kind: "devin", model: "swe-2-max", permissionMode: "dangerous" } } });
    expect(JSON.parse(contentText(devin))).toMatchObject({ profile: { kind: "devin", model: "swe-2-max", permissionMode: "dangerous", sessionPersistence: true } });
  });

  it("reports a stale ancestor rebind in context mode", async () => {
    const { cli } = makeCli();
    const result = await createInspectTool({ cli, context: { workspaceId: "stale-workspace", tabId: "stale-tab", paneId: "w1:p1" } }).execute("id", { mode: "context" } as never, new AbortController().signal, undefined, extensionContext);
    expect(result.details).toMatchObject({ context: { injected: { workspaceId: "stale-workspace", tabId: "stale-tab", paneId: "w1:p1" }, effective: context, rebound: true, attempts: 1 } });
  });

  it("reports bounded, token-free caller-policy evidence in context mode", async () => {
    const callerSession = { source: "herdr:devin", agent: "devin", kind: "id", value: "session-worker" };
    const workerSnapshot: HerdrSnapshot = {
      ...snapshot,
      panes: [
        { ...snapshot.panes[0]!, agent_session: callerSession, tokens: { identity_provenance: "launched", identity_actor: "w1:pM", identity_session: "session-worker" } },
        { pane_id: "w1:pM", tab_id: "w1:t1", workspace_id: "w1", label: "manager", agent_status: "idle" }
      ],
      agents: [
        { pane_id: "w1:p1", name: "caller", agent_status: "idle", agent_session: callerSession },
        { pane_id: "w1:pM", name: "manager", agent_status: "idle" }
      ]
    };
    const worker = await execute(makeCli(undefined, workerSnapshot).cli, { mode: "context" });
    expect(worker.details).toMatchObject({ callerPolicy: { scope: "worker", basis: "launched_leaf", replyPaneId: "w1:pM" } });
    const policyEvidence = JSON.stringify((worker.details as { callerPolicy: unknown }).callerPolicy);
    expect(policyEvidence).not.toContain("identity_");
    expect(policyEvidence).not.toContain("session-worker");
    expect(policyEvidence).not.toContain("tokens");

    const unrestricted = await execute(makeCli().cli, { mode: "context" });
    expect(unrestricted.details).toMatchObject({ callerPolicy: { scope: "unrestricted", basis: "unmarked" } });

    const managerSnapshot: HerdrSnapshot = {
      ...workerSnapshot,
      panes: [...workerSnapshot.panes, { pane_id: "w1:p9", tab_id: "w1:t1", workspace_id: "w1", label: "scout", agent_status: "idle", tokens: { identity_provenance: "launched", identity_actor: "w1:p1", identity_session: "session-child" } }]
    };
    const manager = await execute(makeCli(undefined, managerSnapshot).cli, { mode: "context" });
    expect(manager.details).toMatchObject({ callerPolicy: { scope: "unrestricted", basis: "manages_children", replyPaneId: "w1:pM" } });
  });

  it("keeps context inspection usable when caller-policy evidence is malformed", async () => {
    const broken: HerdrSnapshot = {
      ...snapshot,
      panes: [{ ...snapshot.panes[0]!, tokens: { identity_provenance: "launched" } }],
      agents: [{ pane_id: "w1:p1", name: "caller", agent_status: "idle", tokens: { identity_provenance: "adopted" } }]
    };
    const result = await execute(makeCli(undefined, broken).cli, { mode: "context" });
    expect(result.details).toMatchObject({ kind: "target", callerPolicy: { scope: "unavailable", code: "CALLER_POLICY_UNAVAILABLE" } });
  });

  it("returns compact collections without reading transcripts", async () => {
    const { cli, calls } = makeCli();
    const result = await execute(cli, { mode: "collection", collection: "panes" });
    expect(result.details).toMatchObject({ kind: "collection", collection: "panes" });
    expect(result.details.items).toEqual([{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "caller", agent_status: "idle", agent_name: "caller" }]);
    expect(calls.some((call) => call[1] === "read")).toBe(false);
  });

  it("scopes collections to the current workspace/tab and strips non-compact fields", async () => {
    const scopedSnapshot: HerdrSnapshot = {
      ...snapshot,
      workspaces: [...snapshot.workspaces, { workspace_id: "w2", label: "other workspace", secret: "workspace-secret" }],
      tabs: [
        { ...snapshot.tabs[0], secret: "tab-secret" },
        { tab_id: "w1:t2", workspace_id: "w1", label: "other tab", focused: false },
        { tab_id: "w2:t1", workspace_id: "w2", label: "other workspace tab" }
      ],
      panes: [
        { ...snapshot.panes[0], environment: { SECRET: "pane-secret" }, cwd: "/secret" },
        { pane_id: "w1:p2", tab_id: "w1:t2", workspace_id: "w1", label: "other tab pane", agent_name: "other-tab", agent_status: "idle", secret: "other-pane-secret" },
        { pane_id: "w2:p1", tab_id: "w2:t1", workspace_id: "w2", label: "other workspace pane", agent_name: "other-workspace", agent_status: "idle" }
      ],
      agents: [
        { ...snapshot.agents[0], agent_id: "agent-1", environment: { SECRET: "agent-secret" } },
        { pane_id: "w1:p2", name: "other-tab", agent_status: "idle" },
        { pane_id: "w2:p1", name: "other-workspace", agent_status: "idle" }
      ]
    };
    const { cli } = makeCli(undefined, scopedSnapshot);
    await expect(execute(cli, { mode: "collection", collection: "panes" })).resolves.toMatchObject({ details: { items: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "caller", agent_status: "idle", agent_name: "caller" }] } });
    await expect(execute(cli, { mode: "collection", collection: "agents" })).resolves.toMatchObject({ details: { items: [{ agent_id: "agent-1", pane_id: "w1:p1", name: "caller", agent_status: "idle" }] } });
    await expect(execute(cli, { mode: "collection", collection: "tabs" })).resolves.toMatchObject({ details: { items: [
      { tab_id: "w1:t1", workspace_id: "w1", label: "main" },
      { tab_id: "w1:t2", workspace_id: "w1", label: "other tab" }
    ] } });
    const results = await Promise.all([
      execute(cli, { mode: "collection", collection: "panes" }),
      execute(cli, { mode: "collection", collection: "agents" }),
      execute(cli, { mode: "collection", collection: "tabs" })
    ]);
    expect(JSON.stringify(results)).not.toContain("secret");
    expect(JSON.stringify(results)).not.toContain("focused");
  });

  it("resolves an exact agent name when its pane label differs and rejects unavailable collection context", async () => {
    const agentSnapshot: HerdrSnapshot = {
      ...snapshot,
      panes: [{ ...snapshot.panes[0], agent_name: "worker" }],
      agents: [{ ...snapshot.agents[0], name: "worker" }]
    };
    const { cli } = makeCli(undefined, agentSnapshot);
    await expect(execute(cli, { mode: "target", target: "worker" })).resolves.toMatchObject({ details: { target: { paneId: "w1:p1", agentName: "worker" } } });
    await expect(execute(cli, { mode: "target", target: "w1:t1" })).rejects.toMatchObject({ code: "TARGET_TYPE_MISMATCH" });
    const invalidContext = createInspectTool({ cli, context: { workspaceId: "w1", tabId: "w1:t1" } });
    await expect(invalidContext.execute("id", { mode: "collection", collection: "panes" } as never, new AbortController().signal, undefined, extensionContext)).rejects.toMatchObject({ code: "CONTEXT_UNAVAILABLE" });
  });

  it("prioritizes an exact agent ID over a conflicting pane label", async () => {
    const agentSnapshot: HerdrSnapshot = {
      ...snapshot,
      panes: [
        { ...snapshot.panes[0], label: "agent-7" },
        { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", label: "other", agent_name: "worker", agent_status: "idle" }
      ],
      agents: [snapshot.agents[0], { pane_id: "w1:p2", agent_id: "agent-7", name: "worker", agent_status: "idle" }]
    };
    const { cli, calls } = makeCli(undefined, agentSnapshot);
    await expect(execute(cli, { mode: "target", target: "agent-7" })).resolves.toMatchObject({ details: { target: { paneId: "w1:p2", agentName: "worker" } } });
    expect(calls).toContainEqual(["pane", "read", "w1:p2", "--source", "recent-unwrapped", "--lines", "100", "--format", "text"]);
  });

  it("reports health without exposing the socket path", async () => {
    const exec = vi.fn<PiExec>().mockResolvedValue({
      stdout: JSON.stringify({ client: { version: "0.8.0", protocol: 22 }, server: { status: "running", version: "0.8.0", protocol: 22, compatible: true, socket: "/secret/socket" } }),
      stderr: "",
      code: 0,
      killed: false
    });
    const result = await execute(new HerdrCli(exec), { mode: "health" });
    expect(result.details).toMatchObject({ kind: "health", client: { version: "0.8.0", protocol: 22 }, server: { status: "running", version: "0.8.0", protocol: 22 }, compatible: true, socketReachable: true });
    expect(JSON.stringify(result.details)).not.toContain("/secret/socket");
  });

  it("reads explicit target mode and every compact collection", async () => {
    const { cli } = makeCli();
    await expect(execute(cli, { mode: "target", target: "caller" })).resolves.toMatchObject({ details: { kind: "target", target: { paneId: "w1:p1" } } });
    await expect(execute(cli, { mode: "collection", collection: "agents" })).resolves.toMatchObject({ details: { kind: "collection", collection: "agents" } });
    await expect(execute(cli, { mode: "collection", collection: "tabs" })).resolves.toMatchObject({ details: { kind: "collection", collection: "tabs" } });
  });

  it("strips environment values from retained target metadata at every depth", async () => {
    const leaky: HerdrSnapshot = {
      ...snapshot,
      panes: [{
        ...snapshot.panes[0]!,
        environment: { SECRET: "pane-secret" },
        environment_overrides: { SECRET: "overrides-secret" },
        history: [{ env: { SECRET: "array-secret" } }, { child: { env_vars: { SECRET: "deep-secret" } } }]
      }]
    };
    const { cli } = makeCli(undefined, leaky);
    const result = await execute(cli, { mode: "target", target: "caller" });
    expect(result.details.metadata).toEqual({ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "caller", agent_status: "idle", agent_name: "caller", history: [{}, { child: {} }] });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("keeps invalid mode combinations before the CLI", async () => {
    const { cli, calls } = makeCli();
    await expect(execute(cli, { mode: "target" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(execute(cli, { mode: "collection" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(execute(cli, { mode: "collection", collection: "panes", target: "current" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(execute(cli, { mode: "context", collection: "panes" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(execute(cli, { mode: "context", target: "caller" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(execute(cli, { mode: "health", target: "current" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(calls).toHaveLength(0);
  });

  it("handles empty recent output and malformed pane reads fail closed", async () => {
    const { cli } = makeCli("");
    await expect(execute(cli, {})).resolves.toMatchObject({ details: { recentUnwrappedLines: [] } });

    const exec = vi.fn<PiExec>().mockImplementation(async (_command, argv) => {
      if (argv[0] === "pane" && argv[1] === "current") return { stdout: JSON.stringify({ id: "current", result: { type: "pane_current", pane: snapshot.panes[0] } }), stderr: "", code: 0, killed: false };
      if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: { snapshot, type: "session_snapshot" } }), stderr: "", code: 0, killed: false };
      return { stdout: JSON.stringify({ id: "pane", result: { pane: null } }), stderr: "", code: 0, killed: false };
    });
    await expect(execute(new HerdrCli(exec), {})).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
  });

  it("rejects malformed health output and reports an incompatible running state", async () => {
    for (const stdout of ["not-json", "null", JSON.stringify({ client: {}, server: {} }), JSON.stringify({ client: { version: "0.8.0", protocol: 22 }, server: { status: "stopped", version: "0.8.0", protocol: 22, compatible: false } })]) {
      const exec = vi.fn<PiExec>().mockResolvedValue({ stdout, stderr: "", code: 0, killed: false });
      if (stdout.includes('"compatible":false')) {
        await expect(execute(new HerdrCli(exec), { mode: "health" })).resolves.toMatchObject({ details: { socketReachable: false, compatible: false } });
      } else {
        await expect(execute(new HerdrCli(exec), { mode: "health" })).rejects.toMatchObject({ code: "CLI_INCOMPATIBLE" });
      }
    }
  });

  it("projects bound managed-handoff evidence for the exact current occupant", async () => {
    const session = { source: "native", agent: "pi", kind: "session", value: "sess-1" };
    const managed: HerdrSnapshot = {
      ...snapshot,
      panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "worker", agent_status: "idle", agent_name: "worker", terminal_id: "t1", agent: "pi", agent_session: session }],
      agents: [{ pane_id: "w1:p1", name: "worker", agent: "pi", agent_status: "idle", agent_session: session }]
    };
    const dir = await mkdtemp(join(tmpdir(), "herdr-inspect-handoff-"));
    await chmod(dir, 0o700);
    const allocator = createHandoffAllocator({ namespace: { dir, endpoint: "test-endpoint" } });
    const allocation = await allocator.allocate();
    await allocator.persist(allocation, {
      manager: { paneId: "w1:p0", display: "caller", source: "injected" },
      child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi", requestedProfile: "worker-pi", fallbackProfiles: [] }
    });
    const gate = createHandoffGate();
    await gate.bind(allocation, { paneId: "w1:p1", terminalId: "t1", agentName: "worker", agentKind: "pi", agentSession: session });
    const { cli } = makeCli(undefined, managed);
    const result = await createInspectTool({ cli, context, handoffs: gate }).execute("id", { mode: "target", target: "worker" } as never, new AbortController().signal, undefined, extensionContext);
    expect(result.details.handoff).toMatchObject({ gated: true, runId: allocation.runId, path: allocation.artifactPath, state: "awaiting_handoff" });
    const content = JSON.parse(contentText(result)) as Record<string, unknown>;
    expect(content.handoff).toMatchObject({ gated: true, runId: allocation.runId });
    // Bounded evidence only: no artifact body, marker, or fence token.
    const serialized = JSON.stringify(result.details.handoff);
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain(allocation.marker);
    expect(serialized).not.toContain("## Summary");
  });

  it("reports the explicit ungated handoff reason instead of omitting the block", async () => {
    const session = { source: "native", agent: "pi", kind: "session", value: "sess-1" };
    const managed: HerdrSnapshot = {
      ...snapshot,
      panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "worker", agent_status: "idle", agent_name: "worker", terminal_id: "t1", agent: "pi", agent_session: session }],
      agents: [{ pane_id: "w1:p1", name: "worker", agent: "pi", agent_status: "idle", agent_session: session }]
    };
    // Exact identity but no bound run.
    const { cli: managedCli } = makeCli(undefined, managed);
    const unmanaged = await createInspectTool({ cli: managedCli, context, handoffs: createHandoffGate() })
      .execute("id", { mode: "target", target: "worker" } as never, new AbortController().signal, undefined, extensionContext);
    expect(unmanaged.details.handoff).toEqual({ gated: false, reason: "no_managed_run" });

    // The default snapshot cannot prove the current occupant's identity.
    const { cli } = makeCli();
    const unproven = await createInspectTool({ cli, context, handoffs: createHandoffGate() })
      .execute("id", { mode: "target", target: "caller" } as never, new AbortController().signal, undefined, extensionContext);
    expect(unproven.details.handoff).toEqual({ gated: false, reason: "identity_unavailable" });

    // A host without the shared gate says so.
    const gateless = await execute(managedCli, { mode: "target", target: "worker" });
    expect(gateless.details.handoff).toEqual({ gated: false, reason: "gate_unavailable" });
  });

  it("distinguishes an identity that changed from one that was never provable", async () => {
    const contradictory: HerdrSnapshot = {
      ...snapshot,
      // The pane's own kind and its session's kind disagree, so the join
      // refuses the occupant rather than binding evidence to the wrong child.
      panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "worker", agent_status: "idle", agent_name: "worker", terminal_id: "t1", agent: "pi", agent_session: { source: "native", agent: "claude", kind: "session", value: "sess-1" } }],
      agents: []
    };
    const { cli } = makeCli(undefined, contradictory);
    const result = await createInspectTool({ cli, context, handoffs: createHandoffGate() })
      .execute("id", { mode: "target", target: "worker" } as never, new AbortController().signal, undefined, extensionContext);
    expect(result.details.handoff).toEqual({ gated: false, reason: "identity_changed" });
  });

  it("projects the retained verdict when the fresh artifact read fails", async () => {
    const session = { source: "native", agent: "pi", kind: "session", value: "sess-1" };
    const managed: HerdrSnapshot = {
      ...snapshot,
      panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "worker", agent_status: "idle", agent_name: "worker", terminal_id: "t1", agent: "pi", agent_session: session }],
      agents: [{ pane_id: "w1:p1", name: "worker", agent: "pi", agent_status: "idle", agent_session: session }]
    };
    const dir = await mkdtemp(join(tmpdir(), "herdr-inspect-handoff-"));
    await chmod(dir, 0o700);
    const allocator = createHandoffAllocator({ namespace: { dir, endpoint: "test-endpoint" } });
    const allocation = await allocator.allocate();
    await allocator.persist(allocation, {
      manager: { paneId: "w1:p0", display: "caller", source: "injected" },
      child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi", requestedProfile: "worker-pi", fallbackProfiles: [] }
    });
    const gate = createHandoffGate();
    await gate.bind(allocation, { paneId: "w1:p1", terminalId: "t1", agentName: "worker", agentKind: "pi", agentSession: session });
    gate.validate = async () => { throw new Error("gate exploded"); };
    const { cli } = makeCli(undefined, managed);
    // A failed refresh never fails the inspection; the durable run is still projected.
    const result = await createInspectTool({ cli, context, handoffs: gate })
      .execute("id", { mode: "target", target: "worker" } as never, new AbortController().signal, undefined, extensionContext);
    expect(result.details.handoff).toMatchObject({ gated: true, runId: allocation.runId, state: "awaiting_handoff" });
    expect(result.details.handoff).not.toHaveProperty("validation");
  });

  it("renders compact inspect call and result rows", () => {
    const tool = createInspectTool({ cli: makeCli().cli, context });
    const call = tool.renderCall?.({ mode: "target", target: "caller" } as never, {} as never, {} as never);
    expect(call?.render(80)).toEqual(["herdr_inspect · target · caller"]);
    call?.invalidate();
    const defaultCall = tool.renderCall?.({} as never, {} as never, {} as never);
    expect(defaultCall?.render(80)).toEqual(["herdr_inspect · context"]);
    defaultCall?.invalidate();
    const result = tool.renderResult?.({ content: [], details: { operation: "inspect", kind: "target", outcome: "success", target: { paneId: "w1:p1" } }, isError: false } as never, {} as never, {} as never, {} as never);
    expect(result?.render(80)).toEqual(["inspected · w1:p1"]);
    result?.invalidate();
    const empty = tool.renderResult?.({ content: [], isError: true } as never, {} as never, {} as never, {} as never);
    expect(empty?.render(80)).toEqual(["error UNKNOWN"]);
  });
});
