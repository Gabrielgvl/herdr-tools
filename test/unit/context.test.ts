import { describe, expect, it } from "vitest";
import type { JsonEnvelope } from "../../src/cli.js";
import { CONTEXT_RESOLUTION_ATTEMPTS, contextRebindingDetails, createContextResolver, resolveEffectiveContext, resolveManagerSession, type ContextCli } from "../../src/context.js";
import type { CurrentContext, HerdrSnapshot } from "../../src/targets.js";

const injected: CurrentContext = { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" };

function snapshotFor(overrides: Partial<HerdrSnapshot> = {}): HerdrSnapshot {
  return {
    version: "0.8.2",
    protocol: 22,
    workspaces: [
      { workspace_id: "w1", label: "one" },
      { workspace_id: "w2", label: "two" }
    ],
    tabs: [
      { tab_id: "w1:t1", workspace_id: "w1", label: "main" },
      { tab_id: "w1:t2", workspace_id: "w1", label: "moved" },
      { tab_id: "w2:t1", workspace_id: "w2", label: "cross-workspace" }
    ],
    panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", terminal_id: "term-1" }],
    agents: [],
    ...overrides
  };
}

function envelope(id: string, result: unknown): JsonEnvelope {
  return { id, result };
}

function currentPane(pane: Partial<Record<string, unknown>> = {}): JsonEnvelope {
  return envelope("current", { type: "pane_current", pane: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", ...pane } });
}

function snapshotEnvelope(value: HerdrSnapshot): JsonEnvelope {
  return envelope("snapshot", { type: "session_snapshot", snapshot: value });
}

function queuedCli(values: Array<JsonEnvelope | Error>): ContextCli & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async runJson(argv) {
      calls.push(argv);
      const next = values.shift();
      if (next instanceof Error) throw next;
      if (!next) throw new Error("test response queue exhausted");
      return next;
    }
  };
}

describe("shared effective caller context", () => {
  it("requires complete safe injected identity before reading the CLI", async () => {
    for (const context of [
      {},
      { workspaceId: "w1", tabId: "w1:t1", paneId: "" },
      { workspaceId: "w1", tabId: "w1\nt1", paneId: "w1:p1" },
      { workspaceId: "w1", tabId: "w1:t1", paneId: "w1\u0000p1" }
    ]) {
      const cli = queuedCli([]);
      await expect(resolveEffectiveContext(cli, context, new AbortController().signal)).rejects.toMatchObject({ code: "CONTEXT_UNAVAILABLE" });
      expect(cli.calls).toEqual([]);
    }
  });

  it("accepts a coherent unchanged topology and exposes the current and snapshot operation IDs", async () => {
    const cli = queuedCli([currentPane({ terminal_id: "term-1" }), snapshotEnvelope(snapshotFor())]);
    const result = await resolveEffectiveContext(cli, injected, new AbortController().signal);
    expect(result.context).toEqual(injected);
    expect(result.diagnostics).toEqual({ injected, effective: injected, rebound: false, attempts: 1 });
    expect(result.operationIds).toEqual({ current: "current", snapshot: "snapshot" });
    expect(contextRebindingDetails(result.diagnostics)).toEqual({});
    expect(cli.calls).toEqual([["pane", "current", "--current"], ["api", "snapshot"]]);
  });

  it("rebinds a pane moved to another tab in the same workspace", async () => {
    const moved = snapshotFor({
      tabs: snapshotFor().tabs,
      panes: [{ pane_id: "w1:p1", tab_id: "w1:t2", workspace_id: "w1", terminal_id: "term-1" }]
    });
    const cli = queuedCli([
      currentPane({ tab_id: "w1:t2", terminal_id: "term-1" }),
      snapshotEnvelope(moved)
    ]);
    const result = await resolveEffectiveContext(cli, injected, new AbortController().signal);
    expect(result.context).toEqual({ workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p1" });
    expect(result.diagnostics).toMatchObject({ injected, effective: result.context, rebound: true, attempts: 1 });
    expect(contextRebindingDetails(result.diagnostics)).toMatchObject({ contextRebinding: { rebound: true } });
  });

  it("rebinds a pane moved across workspaces when its stable pane alias remains", async () => {
    const moved = snapshotFor({
      panes: [{ pane_id: "w1:p1", tab_id: "w2:t1", workspace_id: "w2", terminal_id: "term-1" }]
    });
    const cli = queuedCli([
      currentPane({ tab_id: "w2:t1", workspace_id: "w2", terminal_id: "term-1" }),
      snapshotEnvelope(moved)
    ]);
    const result = await resolveEffectiveContext(cli, injected, new AbortController().signal);
    expect(result.context).toEqual({ workspaceId: "w2", tabId: "w2:t1", paneId: "w1:p1" });
    expect(result.diagnostics.rebound).toBe(true);
  });

  it("accepts a --current alias that returns a new public pane ID with the same terminal", async () => {
    const aliased = snapshotFor({
      panes: [{ pane_id: "w2:p9", tab_id: "w2:t1", workspace_id: "w2", terminal_id: "term-1" }]
    });
    const cli = queuedCli([
      currentPane({ pane_id: "w2:p9", tab_id: "w2:t1", workspace_id: "w2", terminal_id: "term-1" }),
      snapshotEnvelope(aliased)
    ]);
    const result = await resolveEffectiveContext(cli, injected, new AbortController().signal);
    expect(result.context).toEqual({ workspaceId: "w2", tabId: "w2:t1", paneId: "w2:p9" });
    expect(result.diagnostics).toMatchObject({ injected, effective: result.context, rebound: true, attempts: 1 });

    const replaced = snapshotFor({ panes: [{ pane_id: "w2:p9", tab_id: "w2:t1", workspace_id: "w2", terminal_id: "term-replaced" }] });
    await expect(resolveEffectiveContext(queuedCli([
      currentPane({ pane_id: "w2:p9", tab_id: "w2:t1", workspace_id: "w2", terminal_id: "term-live" }),
      snapshotEnvelope(replaced)
    ]), injected, new AbortController().signal)).rejects.toMatchObject({ code: "CONTEXT_UNAVAILABLE", details: { reason: "pane_replaced" } });

    const oldAliasStillPresent = snapshotFor({ panes: [
      { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", terminal_id: "term-old" },
      { pane_id: "w2:p9", tab_id: "w2:t1", workspace_id: "w2", terminal_id: "term-live" }
    ] });
    await expect(resolveEffectiveContext(queuedCli([
      currentPane({ pane_id: "w2:p9", tab_id: "w2:t1", workspace_id: "w2", terminal_id: "term-live" }),
      snapshotEnvelope(oldAliasStillPresent)
    ]), injected, new AbortController().signal)).rejects.toMatchObject({ code: "CONTEXT_UNAVAILABLE", details: { reason: "pane_replaced" } });
    await expect(resolveEffectiveContext(queuedCli([
      currentPane({ pane_id: "w2:p9", tab_id: "w2:t1", workspace_id: "w2" }),
      snapshotEnvelope(snapshotFor({ panes: [{ pane_id: "w2:p9", tab_id: "w2:t1", workspace_id: "w2" }] }))
    ]), injected, new AbortController().signal)).rejects.toMatchObject({ code: "CONTEXT_UNAVAILABLE", details: { reason: "pane_replaced" } });
    await expect(resolveEffectiveContext(queuedCli([
      currentPane({ pane_id: "w2:p9", tab_id: "w2:t1", workspace_id: "w2", terminal_id: "term-live" }),
      snapshotEnvelope(snapshotFor({ panes: [{ pane_id: "w2:p9", tab_id: "w2:t1", workspace_id: "w2" }] }))
    ]), injected, new AbortController().signal)).rejects.toMatchObject({ code: "CONTEXT_UNAVAILABLE", details: { reason: "pane_replaced" } });
    await expect(resolveEffectiveContext(queuedCli([
      currentPane({ pane_id: "w2:p9", tab_id: "w2:t1", workspace_id: "w2" }),
      snapshotEnvelope(snapshotFor({ panes: [{ pane_id: "w2:p9", tab_id: "w2:t1", workspace_id: "w2", terminal_id: "term-live" }] }))
    ]), injected, new AbortController().signal)).rejects.toMatchObject({ code: "CONTEXT_UNAVAILABLE", details: { reason: "pane_replaced" } });
  });

  it("retries one concurrent topology read and returns only the second coherent sample", async () => {
    const first = snapshotFor({ panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", terminal_id: "term-1" }] });
    const second = snapshotFor({
      panes: [{ pane_id: "w1:p1", tab_id: "w1:t2", workspace_id: "w1", terminal_id: "term-1" }]
    });
    const cli = queuedCli([
      currentPane({ tab_id: "w1:t2", terminal_id: "term-1" }),
      snapshotEnvelope(first),
      currentPane({ tab_id: "w1:t2", terminal_id: "term-1" }),
      snapshotEnvelope(second)
    ]);
    const result = await resolveEffectiveContext(cli, injected, new AbortController().signal);
    expect(result.context.tabId).toBe("w1:t2");
    expect(result.diagnostics.attempts).toBe(2);
    expect(cli.calls).toHaveLength(CONTEXT_RESOLUTION_ATTEMPTS * 2);
  });

  it("fails closed for unresolved, duplicate, and incoherent authoritative caller topology", async () => {
    const unresolved = queuedCli([
      currentPane(),
      snapshotEnvelope(snapshotFor({ panes: [] })),
      currentPane(),
      snapshotEnvelope(snapshotFor({ panes: [] }))
    ]);
    await expect(resolveEffectiveContext(unresolved, injected, new AbortController().signal)).rejects.toMatchObject({ code: "CONTEXT_UNAVAILABLE", details: { reason: "caller_unresolved" } });
    expect(unresolved.calls).toHaveLength(CONTEXT_RESOLUTION_ATTEMPTS * 2);

    const duplicate = snapshotFor({ panes: [snapshotFor().panes[0]!, snapshotFor().panes[0]!] });
    const duplicateCli = queuedCli([currentPane(), snapshotEnvelope(duplicate)]);
    await expect(resolveEffectiveContext(duplicateCli, injected, new AbortController().signal)).rejects.toMatchObject({ code: "CONTEXT_UNAVAILABLE", details: { reason: "caller_ambiguous" } });
    expect(duplicateCli.calls).toHaveLength(2);

    const incoherent = snapshotFor({
      tabs: [
        { tab_id: "w1:t1", workspace_id: "w2", label: "wrong parent" },
        { tab_id: "w1:t2", workspace_id: "w1", label: "unused" },
        { tab_id: "w2:t1", workspace_id: "w2", label: "cross-workspace" }
      ],
      panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" }]
    });
    const incoherentCli = queuedCli([currentPane(), snapshotEnvelope(incoherent), currentPane(), snapshotEnvelope(incoherent)]);
    await expect(resolveEffectiveContext(incoherentCli, injected, new AbortController().signal)).rejects.toMatchObject({ code: "CONTEXT_UNAVAILABLE", details: { reason: "topology_incoherent" } });
  });

  it("fails closed for replacement, terminal replacement, malformed current, and malformed snapshot evidence", async () => {
    const replacementSnapshot = snapshotFor({ panes: [] });
    const replacement = queuedCli([
      currentPane({ pane_id: "w1:p9", tab_id: "w2:t1", workspace_id: "w2", terminal_id: "term-new" }),
      snapshotEnvelope(replacementSnapshot),
      currentPane({ pane_id: "w1:p9", tab_id: "w2:t1", workspace_id: "w2", terminal_id: "term-new" }),
      snapshotEnvelope(replacementSnapshot)
    ]);
    await expect(resolveEffectiveContext(replacement, injected, new AbortController().signal)).rejects.toMatchObject({ code: "CONTEXT_UNAVAILABLE", details: { reason: "caller_unresolved" } });
    expect(replacement.calls).toHaveLength(CONTEXT_RESOLUTION_ATTEMPTS * 2);

    const terminalReplacement = queuedCli([
      currentPane({ terminal_id: "term-new" }),
      snapshotEnvelope(snapshotFor())
    ]);
    await expect(resolveEffectiveContext(terminalReplacement, injected, new AbortController().signal)).rejects.toMatchObject({ code: "CONTEXT_UNAVAILABLE", details: { reason: "pane_replaced" } });
    await expect(resolveEffectiveContext(queuedCli([currentPane({ terminal_id: null }), snapshotEnvelope(snapshotFor())]), injected, new AbortController().signal)).resolves.toMatchObject({ diagnostics: { rebound: false } });
    await expect(resolveEffectiveContext(queuedCli([currentPane({ terminal_id: undefined }), snapshotEnvelope(snapshotFor())]), injected, new AbortController().signal)).resolves.toMatchObject({ diagnostics: { rebound: false } });

    for (const result of [null, {}, { type: "wrong", pane: {} }, { type: "pane_current", pane: null }, { type: "pane_current", pane: { pane_id: "" } }, { type: "pane_current", pane: { pane_id: "w1:p1", tab_id: "bad\n tab", workspace_id: "w1" } }, { type: "pane_current", pane: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", terminal_id: 4 } }]) {
      const cli = queuedCli([envelope("current", result)]);
      await expect(resolveEffectiveContext(cli, injected, new AbortController().signal)).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
      expect(cli.calls).toHaveLength(1);
    }

    const malformedSnapshot = queuedCli([currentPane(), envelope("snapshot", {})]);
    await expect(resolveEffectiveContext(malformedSnapshot, injected, new AbortController().signal)).rejects.toMatchObject({ code: "CLI_PROTOCOL_ERROR" });
  });

  it("fails closed for duplicate or missing containing tabs and workspaces", async () => {
    const missingTab = snapshotFor({ tabs: snapshotFor().tabs.filter((tab) => tab.tab_id !== "w1:t1") });
    const missingTabCli = queuedCli([currentPane(), snapshotEnvelope(missingTab), currentPane(), snapshotEnvelope(missingTab)]);
    await expect(resolveEffectiveContext(missingTabCli, injected, new AbortController().signal)).rejects.toMatchObject({ code: "CONTEXT_UNAVAILABLE", details: { reason: "tab_unresolved" } });

    const duplicateTab = snapshotFor({ tabs: [...snapshotFor().tabs, { tab_id: "w1:t1", workspace_id: "w1", label: "duplicate" }] });
    const duplicateTabCli = queuedCli([currentPane(), snapshotEnvelope(duplicateTab)]);
    await expect(resolveEffectiveContext(duplicateTabCli, injected, new AbortController().signal)).rejects.toMatchObject({ code: "CONTEXT_UNAVAILABLE", details: { reason: "tab_ambiguous" } });

    const missingWorkspace = snapshotFor({ workspaces: [{ workspace_id: "w2", label: "two" }] });
    const missingWorkspaceCli = queuedCli([currentPane(), snapshotEnvelope(missingWorkspace), currentPane(), snapshotEnvelope(missingWorkspace)]);
    await expect(resolveEffectiveContext(missingWorkspaceCli, injected, new AbortController().signal)).rejects.toMatchObject({ code: "CONTEXT_UNAVAILABLE", details: { reason: "workspace_unresolved" } });

    const duplicateWorkspace = snapshotFor({ workspaces: [...snapshotFor().workspaces, { workspace_id: "w1", label: "duplicate" }] });
    const duplicateWorkspaceCli = queuedCli([currentPane(), snapshotEnvelope(duplicateWorkspace)]);
    await expect(resolveEffectiveContext(duplicateWorkspaceCli, injected, new AbortController().signal)).rejects.toMatchObject({ code: "CONTEXT_UNAVAILABLE", details: { reason: "workspace_ambiguous" } });
  });

  it("uses the shared resolver factory for a moved context", async () => {
    const moved = snapshotFor({ panes: [{ pane_id: "w1:p1", tab_id: "w1:t2", workspace_id: "w1" }] });
    const cli = queuedCli([currentPane({ tab_id: "w1:t2" }), snapshotEnvelope(moved)]);
    const resolver = createContextResolver(cli, injected);
    await expect(resolver(new AbortController().signal)).resolves.toMatchObject({ context: { tabId: "w1:t2" }, diagnostics: { rebound: true } });
  });
});

describe("manager native session provenance", () => {
  const session = { source: "herdr:pi", agent: "pi", kind: "id", value: "sess-1" };
  const callerPane = (extra: Record<string, unknown> = {}) => ({ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", terminal_id: "term-1", ...extra });
  const capture = (fn: () => unknown): unknown => { try { fn(); } catch (error) { return error; } return undefined; };

  it("joins the session the authoritative pane and agent records agree on", () => {
    const snapshot = snapshotFor({
      panes: [callerPane({ agent_session: session })],
      agents: [{ pane_id: "w1:p1", name: "manager", agent: "pi", terminal_id: "term-1", agent_session: session }]
    });
    expect(resolveManagerSession(snapshot, "w1:p1")).toEqual(session);
  });

  it("accepts a session supplied by only one of the two records", () => {
    expect(resolveManagerSession(snapshotFor({ panes: [callerPane({ agent_session: session })] }), "w1:p1")).toEqual(session);
    expect(resolveManagerSession(snapshotFor({ agents: [{ pane_id: "w1:p1", agent: "pi", agent_session: session }] }), "w1:p1")).toEqual(session);
  });

  it("records null when the caller has no native session rather than fabricating one", () => {
    expect(resolveManagerSession(snapshotFor(), "w1:p1")).toBeNull();
    expect(resolveManagerSession(snapshotFor({ panes: [callerPane({ agent_session: null })] }), "w1:p1")).toBeNull();
    expect(resolveManagerSession(snapshotFor({ agents: [{ pane_id: "w1:p1", agent: "pi", agent_session: null }] }), "w1:p1")).toBeNull();
  });

  it("fails closed when another pane's paired agent record claims the manager session", () => {
    const otherPane = { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", terminal_id: "term-2" };
    const duplicateSession = snapshotFor({
      panes: [callerPane({ agent_session: session }), otherPane],
      agents: [
        { pane_id: "w1:p1", agent: "pi", agent_session: session },
        { pane_id: "w1:p2", agent: "pi", agent_session: session }
      ]
    });
    expect(capture(() => resolveManagerSession(duplicateSession, "w1:p1"))).toMatchObject({ code: "CONTEXT_UNAVAILABLE", details: { reason: "manager_session_ambiguous", candidates: 2 } });
  });

  it("fails closed when another pane has contradictory paired session evidence", () => {
    const other = { ...session, value: "session-other" };
    const contradictory = snapshotFor({
      panes: [callerPane({ agent_session: session }), { pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", agent_session: other }],
      agents: [
        { pane_id: "w1:p1", agent: "pi", agent_session: session },
        { pane_id: "w1:p2", agent: "pi", agent_session: { ...other, value: "session-third" } }
      ]
    });
    expect(capture(() => resolveManagerSession(contradictory, "w1:p1"))).toMatchObject({ code: "CONTEXT_UNAVAILABLE", details: { reason: "session_untrusted" } });
  });

  it("fails closed on unresolved or ambiguous manager identity", () => {
    const duplicatePane = snapshotFor({ panes: [callerPane(), callerPane()] });
    expect(capture(() => resolveManagerSession(duplicatePane, "w1:p1"))).toMatchObject({ code: "CONTEXT_UNAVAILABLE", details: { reason: "manager_ambiguous", candidates: 2 } });

    const duplicateAgent = snapshotFor({ agents: [{ pane_id: "w1:p1", agent: "pi" }, { pane_id: "w1:p1", agent: "pi" }] });
    expect(capture(() => resolveManagerSession(duplicateAgent, "w1:p1"))).toMatchObject({ code: "CONTEXT_UNAVAILABLE", details: { reason: "manager_ambiguous", candidates: 2 } });

    expect(capture(() => resolveManagerSession(snapshotFor(), "w1:pX"))).toMatchObject({ code: "CONTEXT_UNAVAILABLE", details: { reason: "manager_unresolved" } });
  });

  it("fails closed on contradictory or malformed session evidence", () => {
    const contradictory = snapshotFor({
      panes: [callerPane({ agent_session: session })],
      agents: [{ pane_id: "w1:p1", agent: "pi", agent_session: { ...session, value: "other-session" } }]
    });
    expect(capture(() => resolveManagerSession(contradictory, "w1:p1"))).toMatchObject({ code: "CONTEXT_UNAVAILABLE", details: { reason: "session_untrusted", causeCode: "TARGET_IDENTITY_CHANGED" } });

    const kindMismatch = snapshotFor({ agents: [{ pane_id: "w1:p1", agent: "claude", agent_session: session }] });
    expect(capture(() => resolveManagerSession(kindMismatch, "w1:p1"))).toMatchObject({ code: "CONTEXT_UNAVAILABLE", details: { reason: "session_untrusted" } });

    const terminalMismatch = snapshotFor({
      panes: [callerPane({ terminal_id: "term-1", agent_session: session })],
      agents: [{ pane_id: "w1:p1", agent: "pi", terminal_id: "term-2", agent_session: session }]
    });
    expect(capture(() => resolveManagerSession(terminalMismatch, "w1:p1"))).toMatchObject({ code: "CONTEXT_UNAVAILABLE", details: { reason: "session_untrusted" } });

    for (const bad of [
      callerPane({ agent_session: { source: "herdr:pi" } }),
      callerPane({ agent_session: { ...session, value: "" } }),
      callerPane({ agent_session: "sess-1" }),
      callerPane({ agent_session: { ...session, value: "a\nb" } })
    ]) {
      expect(capture(() => resolveManagerSession(snapshotFor({ panes: [bad] }), "w1:p1"))).toMatchObject({ code: "CONTEXT_UNAVAILABLE", details: { reason: "session_untrusted" } });
    }
  });
});
