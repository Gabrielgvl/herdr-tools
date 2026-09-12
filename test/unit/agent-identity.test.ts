import { describe, expect, it, vi } from "vitest";
import {
  adoptAgentIdentity,
  adoptTargetPreconditions,
  assertAgentName,
  isAgentName,
  mintAgentName,
  nameOnlyGap,
  selfNameCandidates,
  writeIdentityProvenance,
  type AdoptIdentityCli
} from "../../src/agent-identity.js";
import { CliProtocolError } from "../../src/cli.js";
import type { HerdrSnapshot } from "../../src/targets.js";

const signal = new AbortController().signal;
const session = { source: "herdr:devin", agent: "devin", kind: "id", value: "sess-1" };

function paneRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pane_id: "w6:p1y",
    tab_id: "w6:t1",
    workspace_id: "w6",
    label: "scratch",
    terminal_id: "term-1",
    agent: "devin",
    agent_session: session,
    agent_status: "idle",
    ...overrides
  };
}

function agentRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pane_id: "w6:p1y",
    agent: "devin",
    terminal_id: "term-1",
    agent_session: session,
    agent_status: "idle",
    revision: 3,
    ...overrides
  };
}

function snapshot(overrides: { panes?: unknown[]; agents?: unknown[] } = {}): HerdrSnapshot {
  return {
    version: "0.9.0",
    protocol: 22,
    workspaces: [{ workspace_id: "w6", label: "w6" }],
    tabs: [{ tab_id: "w6:t1", workspace_id: "w6", label: "t1" }],
    panes: (overrides.panes ?? [paneRecord()]) as HerdrSnapshot["panes"],
    agents: (overrides.agents ?? [agentRecord()]) as HerdrSnapshot["agents"]
  };
}

const namedAgent = { ...agentRecord(), name: "devin-w6p1y" };
const namedPane = { ...paneRecord(), agent_name: "devin-w6p1y" };

interface MockCli extends AdoptIdentityCli {
  calls: string[][];
  renames: string[][];
}

function mockCli(options: {
  postSnapshot?: HerdrSnapshot;
  agentGet?: unknown;
  paneGet?: unknown;
  renameError?: unknown;
  metadataError?: unknown;
} = {}): MockCli {
  const calls: string[][] = [];
  const renames: string[][] = [];
  return {
    calls,
    renames,
    runJson: vi.fn(async (argv: string[]) => {
      calls.push(argv);
      const key = argv.join(" ");
      if (key.startsWith("agent rename")) {
        renames.push(argv);
        if (options.renameError !== undefined) throw options.renameError;
        const name = argv[3]!;
        return { id: "rename", result: { type: "agent_info", agent: { ...agentRecord(), name } } };
      }
      if (key.startsWith("api snapshot")) {
        return { id: "snapshot", result: { type: "session_snapshot", snapshot: options.postSnapshot ?? snapshot({ panes: [namedPane], agents: [namedAgent] }) } };
      }
      if (key.startsWith("agent get")) {
        return { id: "agent-get", result: options.agentGet ?? { agent: namedAgent } };
      }
      if (key.startsWith("pane get")) {
        return { id: "pane-get", result: options.paneGet ?? { pane: namedPane } };
      }
      if (key.startsWith("pane report-metadata")) {
        if (options.metadataError !== undefined) throw options.metadataError;
        return { id: "metadata", result: { ok: true } };
      }
      throw new Error(`unexpected argv: ${key}`);
    })
  };
}

const herdrError = (code: string, message = "failed"): CliProtocolError =>
  new CliProtocolError("CLI_PROTOCOL_ERROR", message, { errorEnvelope: { id: "x", error: { code, message } } });

describe("agent name grammar", () => {
  it("accepts the launch grammar exactly", () => {
    for (const good of ["a", "devin-w6p1y", "x".repeat(32), "a-b_c9"]) expect(isAgentName(good)).toBe(true);
    for (const bad of ["", "A", "9lives", "-lead", "with space", "x".repeat(33), "dot.name", 7, null]) expect(isAgentName(bad)).toBe(false);
    expect(() => assertAgentName("worker-1", "name")).not.toThrow();
    expect(() => assertAgentName("Bad Name", "name")).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  });
});

describe("adoptTargetPreconditions", () => {
  const unqualified = (snap: HerdrSnapshot, reason: string) =>
    expect(() => adoptTargetPreconditions(snap, "w6:p1y")).toThrowError(expect.objectContaining({ code: "ADOPT_TARGET_UNQUALIFIED", details: expect.objectContaining({ reason }) }));

  it("accepts a detected pane with one complete agent record", () => {
    const conditions = adoptTargetPreconditions(snapshot(), "w6:p1y");
    expect(conditions.terminalId).toBe("term-1");
    expect(conditions.agentSession).toEqual(session);
    expect(conditions.suppliedName).toBeUndefined();
  });

  it.each([
    ["pane_absent", snapshot({ panes: [] })],
    ["pane_duplicate", snapshot({ panes: [paneRecord(), paneRecord()] })],
    ["agent_absent", snapshot({ agents: [] })],
    ["agent_duplicate", snapshot({ agents: [agentRecord(), agentRecord()] })],
    ["agent_session_incomplete", snapshot({ panes: [paneRecord({ agent_session: undefined })], agents: [agentRecord({ agent_session: { source: "herdr:devin" } })] })],
    ["agent_session_incomplete", snapshot({ panes: [paneRecord({ agent_session: "bogus" })], agents: [agentRecord({ agent_session: 9 })] })],
    ["terminal_id_missing", snapshot({ panes: [paneRecord({ terminal_id: undefined })], agents: [agentRecord({ terminal_id: undefined })] })],
    ["agent_status_missing", snapshot({ panes: [paneRecord({ agent_status: undefined })], agents: [agentRecord({ agent_status: undefined })] })],
    ["agent_status_unknown", snapshot({ panes: [paneRecord({ agent_status: "unknown" })], agents: [agentRecord({ agent_status: "unknown" })] })],
    ["identity_contradictory", snapshot({ panes: [paneRecord({ terminal_id: "term-other" })] })],
    ["identity_contradictory", snapshot({ panes: [paneRecord({ agent: "pi" })] })],
    ["identity_contradictory", snapshot({ panes: [paneRecord({ agent_session: { ...session, value: "other" } })] })],
    ["identity_contradictory", snapshot({ panes: [paneRecord({ agent_name: "a-name" })], agents: [agentRecord({ name: "b-name" })] })]
  ])("rejects %s before any rename is attempted", (reason, snap) => {
    unqualified(snap as HerdrSnapshot, reason);
  });

  it("reports a supplied name when the pane is already named", () => {
    expect(adoptTargetPreconditions(snapshot({ panes: [namedPane], agents: [namedAgent] }), "w6:p1y").suppliedName).toBe("devin-w6p1y");
  });
});

describe("nameOnlyGap", () => {
  it("reports named when any record supplies a name", () => {
    expect(nameOnlyGap([paneRecord(), agentRecord({ name: "w6-manager" })], "w6:p1y")).toBe("named");
    expect(nameOnlyGap([paneRecord({ agent_name: "w6-manager" }), agentRecord()], "w6:p1y")).toBe("named");
  });

  it("reports ready when the name is the sole missing join field", () => {
    expect(nameOnlyGap([paneRecord(), agentRecord()], "w6:p1y")).toBe("ready");
  });

  it.each([
    ["contradictory names", [paneRecord({ agent_name: "one" }), agentRecord({ name: "two" })]],
    ["missing terminal", [paneRecord({ terminal_id: undefined }), agentRecord({ terminal_id: undefined })]],
    ["missing session", [paneRecord({ agent_session: undefined }), agentRecord({ agent_session: undefined })]],
    ["wrong pane", [paneRecord({ pane_id: "w6:other" }), agentRecord()]],
    ["malformed record", ["bogus"]]
  ])("reports unqualified on %s", (_label, records) => {
    expect(nameOnlyGap(records as Record<string, unknown>[], "w6:p1y")).toBe("unqualified");
  });
});

describe("selfNameCandidates", () => {
  it("derives <kind>-<normalized paneId> plus the collision range", () => {
    expect(selfNameCandidates("devin", "w6:p1Y")).toEqual([
      "devin-w6p1y", "devin-w6p1y-2", "devin-w6p1y-3", "devin-w6p1y-4", "devin-w6p1y-5",
      "devin-w6p1y-6", "devin-w6p1y-7", "devin-w6p1y-8", "devin-w6p1y-9"
    ]);
    for (const candidate of selfNameCandidates("claude", "wB:p1K")!) expect(isAgentName(candidate)).toBe(true);
  });

  it("keeps the suffix range inside the 32-char grammar for long pane ids", () => {
    const candidates = selfNameCandidates("devin", "w9:" + "p".repeat(40))!;
    for (const candidate of candidates) expect(isAgentName(candidate)).toBe(true);
    expect(candidates[0]!.length).toBeLessThanOrEqual(30);
  });

  it("refuses pane ids that cannot normalize into a valid name", () => {
    expect(selfNameCandidates("devin", ":::")).toBeUndefined();
    expect(selfNameCandidates("9lives", "w1:p9")).toBeUndefined();
  });
});

describe("mintAgentName", () => {
  const mint = (error: unknown) => mintAgentName({ runJson: async () => { throw error; } }, "w6:p1y", "worker", signal);

  it("maps server rejection codes onto the adopt taxonomy", async () => {
    await expect(mint(herdrError("agent_name_taken"))).rejects.toMatchObject({ code: "AGENT_NAME_TAKEN", details: { causeCode: "agent_name_taken" } });
    await expect(mint(herdrError("agent_not_found"))).rejects.toMatchObject({ code: "ADOPT_TARGET_UNQUALIFIED", details: { causeCode: "agent_not_found" } });
    await expect(mint(herdrError("agent_launch_pending"))).rejects.toMatchObject({ code: "ADOPT_TARGET_UNQUALIFIED", details: { causeCode: "agent_launch_pending" } });
    await expect(mint(herdrError("invalid_agent_name"))).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(mint(new Error("backend down"))).rejects.toThrowError("backend down");
    await expect(mint(herdrError("something_else"))).rejects.toThrowError("failed");
    await expect(mint(new CliProtocolError("CLI_PROTOCOL_ERROR", "no envelope"))).rejects.toThrowError("no envelope");
  });

  it("rethrows errors whose envelopes carry no mappable code", async () => {
    await expect(mint("raw failure")).rejects.toBe("raw failure");
    await expect(mint(Object.assign(new Error("details without envelope"), { details: { note: "x" } }))).rejects.toThrowError("details without envelope");
    await expect(mint(Object.assign(new Error("envelope not a record"), { details: { errorEnvelope: "flat" } }))).rejects.toThrowError("envelope not a record");
    await expect(mint(Object.assign(new Error("error not a record"), { details: { errorEnvelope: { error: "flat" } } }))).rejects.toThrowError("error not a record");
    await expect(mint(Object.assign(new Error("code not a string"), { details: { errorEnvelope: { error: { code: 42 } } } }))).rejects.toThrowError("code not a string");
  });

  it("returns the acknowledged agent record", async () => {
    const cli: AdoptIdentityCli = { runJson: async () => ({ id: "r", result: { type: "agent_info", agent: agentRecord({ name: "worker" }) } }) };
    await expect(mintAgentName(cli, "w6:p1y", "worker", signal)).resolves.toMatchObject({ name: "worker" });
  });
});

describe("writeIdentityProvenance", () => {
  it("writes the advisory token set and tolerates failure", async () => {
    const calls: string[][] = [];
    const cli: AdoptIdentityCli = { runJson: async (argv) => { calls.push(argv); return { id: "m", result: { ok: true } }; } };
    await expect(writeIdentityProvenance(cli, "w6:p1y", "adopted", "w1:p1", session, signal)).resolves.toBeUndefined();
    expect(calls[0]).toEqual([
      "pane", "report-metadata", "w6:p1y", "--source", "herdr-tools",
      "--token", "identity_provenance=adopted", "--token", "identity_actor=w1:p1", "--token", "identity_session=sess-1"
    ]);
    const failing: AdoptIdentityCli = { runJson: async () => { throw new Error("read-only"); } };
    await expect(writeIdentityProvenance(failing, "w6:p1y", "adopted", "w1:p1", session, signal)).resolves.toBe("read-only");
    const weird: AdoptIdentityCli = { runJson: async () => { throw "boom"; } };
    await expect(writeIdentityProvenance(weird, "w6:p1y", "adopted", "w1:p1", session, signal)).resolves.toBe("provenance token write failed");
  });

  it("omits tokens whose values normalize away and strips control characters", async () => {
    const calls: string[][] = [];
    const cli: AdoptIdentityCli = { runJson: async (argv) => { calls.push(argv); return { id: "m", result: { ok: true } }; } };
    await writeIdentityProvenance(cli, "w6:p1y", "launched", undefined, { ...session, value: "a\u0000b\n" }, signal);
    expect(calls[0]).toEqual([
      "pane", "report-metadata", "w6:p1y", "--source", "herdr-tools",
      "--token", "identity_provenance=launched", "--token", "identity_session=ab"
    ]);
    await writeIdentityProvenance(cli, "w6:p1y", "launched", "w1:p1", { ...session, value: "\u0000\u0001" }, signal);
    expect(calls[1]).toEqual([
      "pane", "report-metadata", "w6:p1y", "--source", "herdr-tools",
      "--token", "identity_provenance=launched", "--token", "identity_actor=w1:p1"
    ]);
  });
});

describe("adoptAgentIdentity", () => {
  it("adopts a detected non-launched pane and writes advisory provenance", async () => {
    const cli = mockCli();
    const outcome = await adoptAgentIdentity(cli, snapshot(), "w6:p1y", "devin-w6p1y", "w1:p1", signal);
    expect(outcome).toMatchObject({
      paneId: "w6:p1y",
      agentName: "devin-w6p1y",
      identity: { agentName: "devin-w6p1y", agentKind: "devin", terminalId: "term-1", agentSession: session }
    });
    expect(outcome).not.toHaveProperty("namePreexisting");
    expect(cli.renames).toEqual([["agent", "rename", "w6:p1y", "devin-w6p1y"]]);
    expect(cli.calls.some((argv) => argv[0] === "pane" && argv[1] === "report-metadata")).toBe(true);
  });

  it("is idempotent when the pane already carries the requested name", async () => {
    const cli = mockCli();
    const outcome = await adoptAgentIdentity(cli, snapshot({ panes: [namedPane], agents: [namedAgent] }), "w6:p1y", "devin-w6p1y", "w1:p1", signal);
    expect(outcome.namePreexisting).toBe(true);
    expect(cli.renames).toHaveLength(0);
    // A no-op adopt must not overwrite an existing provenance marker.
    expect(cli.calls.some((argv) => argv[0] === "pane" && argv[1] === "report-metadata")).toBe(false);
  });

  it("rejects a different existing name without attempting the rename", async () => {
    const cli = mockCli();
    await expect(adoptAgentIdentity(cli, snapshot({ panes: [namedPane], agents: [namedAgent] }), "w6:p1y", "other-name", "w1:p1", signal))
      .rejects.toMatchObject({ code: "AGENT_ALREADY_NAMED", details: { existing: "devin-w6p1y" } });
    expect(cli.renames).toHaveLength(0);
  });

  it("rejects when the name is already held by another pane in the snapshot", async () => {
    const cli = mockCli();
    const incumbent = { ...agentRecord({ name: "taken" }), pane_id: "w6:p9" };
    const incumbentPane = { ...paneRecord({ agent_name: "taken" }), pane_id: "w6:p9" };
    const snap = snapshot({ panes: [paneRecord(), incumbentPane], agents: [agentRecord(), incumbent] });
    await expect(adoptAgentIdentity(cli, snap, "w6:p1y", "taken", "w1:p1", signal))
      .rejects.toMatchObject({ code: "AGENT_NAME_TAKEN", details: { incumbents: expect.arrayContaining(["w6:p9"]) } });
    expect(cli.renames).toHaveLength(0);
  });

  it("propagates a server-side name collision that the snapshot missed", async () => {
    const cli = mockCli({ renameError: herdrError("agent_name_taken") });
    await expect(adoptAgentIdentity(cli, snapshot(), "w6:p1y", "taken", "w1:p1", signal)).rejects.toMatchObject({ code: "AGENT_NAME_TAKEN" });
  });

  it.each([
    // A session that rotated between the pre-mint snapshot and the post-mint
    // reads leaves the fresh records contradictory — the join refuses.
    ["session identity change", { agentGet: { agent: { ...namedAgent, agent_session: { ...session, value: "sess-2" } } }, paneGet: { pane: { ...namedPane, agent_session: { ...session, value: "sess-2" } } } }],
    ["pane reuse (terminal changed)", { agentGet: { agent: { ...namedAgent, terminal_id: "term-2" } }, paneGet: { pane: { ...namedPane, terminal_id: "term-2" } } }],
    ["stale registration (agent record gone)", { postSnapshot: snapshot({ panes: [namedPane], agents: [] }) }],
    ["verified name differs from requested", { agentGet: { agent: { ...namedAgent, name: "other-name" } }, paneGet: { pane: { ...namedPane, agent_name: "other-name" } }, postSnapshot: snapshot({ panes: [{ ...namedPane, agent_name: "other-name" }], agents: [{ ...namedAgent, name: "other-name" }] }) }]
  ])("fails closed on %s after the mint", async (_label, options) => {
    const cli = mockCli(options);
    await expect(adoptAgentIdentity(cli, snapshot(), "w6:p1y", "devin-w6p1y", "w1:p1", signal))
      .rejects.toMatchObject({ code: expect.stringMatching(/^TARGET_IDENTITY_/) });
  });

  it("still verifies when the session rotated coherently — names bind to panes, not sessions", async () => {
    const rotated = { ...session, value: "sess-2" };
    const cli = mockCli({
      postSnapshot: snapshot({ panes: [{ ...namedPane, agent_session: rotated }], agents: [{ ...namedAgent, agent_session: rotated }] }),
      agentGet: { agent: { ...namedAgent, agent_session: rotated } },
      paneGet: { pane: { ...namedPane, agent_session: rotated } }
    });
    const outcome = await adoptAgentIdentity(cli, snapshot(), "w6:p1y", "devin-w6p1y", "w1:p1", signal);
    expect(outcome.identity.agentSession.value).toBe("sess-2");
  });

  it("survives a provenance token write failure as a warning", async () => {
    const cli = mockCli({ metadataError: new Error("metadata read-only") });
    const outcome = await adoptAgentIdentity(cli, snapshot(), "w6:p1y", "devin-w6p1y", "w1:p1", signal);
    expect(outcome.provenanceWarning).toBe("metadata read-only");
    expect(outcome.agentName).toBe("devin-w6p1y");
  });
});
