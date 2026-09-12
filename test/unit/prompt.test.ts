import { describe, expect, it } from "vitest";
import { CliProtocolError, type JsonEnvelope } from "../../src/cli.js";
import { boundAgentSessionStrings, capturePromptObservationBaseline, classifyPromptObservation, compactPromptSubmission, joinPromptTargetIdentity, parsePromptSubmission, parsePromptTargetIdentityFields, requirePromptTargetIdentity, unavailablePromptObservation, type PromptObservationBaseline, type PromptSubmissionEvidence } from "../../src/messages/prompt.js";

const agent = {
  name: "worker",
  pane_id: "w1:p2",
  agent: "pi",
  terminal_id: "term-worker",
  agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-worker" },
  agent_status: "idle",
  interactive_ready: true,
  revision: 7,
  state_change_seq: 4,
  screen_detection_skipped: true
};

const response = (result: unknown, id = "herdr-tools-request-1"): JsonEnvelope => ({ id, result });
const expected = { paneId: "w1:p2", terminalId: "term-worker", agentName: "worker", agentKind: "pi", agentSession: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-worker" } };

function validSubmission(overrides: Record<string, unknown> = {}): PromptSubmissionEvidence {
  return parsePromptSubmission(response({ type: "agent_prompted", agent: { ...agent, ...overrides } }), expected);
}

describe("prompt submission acknowledgement", () => {
  it("accepts the exact Herdr acknowledgement and retains safe observation metadata", () => {
    expect(validSubmission()).toEqual({
      confirmed: true,
      operationId: "herdr-tools-request-1",
      paneId: "w1:p2",
      agentName: "worker",
      agentKind: "pi",
      terminalId: "term-worker",
      agentSession: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-worker" },
      interactiveReady: true,
      interactiveProof: "managed",
      revision: 7,
      stateChangeSeq: 4,
      screenDetectionSkipped: true
    });
    expect(validSubmission({ state_change_seq: undefined, screen_detection_skipped: undefined })).toEqual(expect.objectContaining({ revision: 7, interactiveReady: true }));
    expect(validSubmission({ screen_detection_skipped: "invalid" })).not.toHaveProperty("screenDetectionSkipped");
  });

  it.each(["idle", "working", "blocked", "done"] as const)("accepts a detected-pane acknowledgement without interactive_ready when the lifecycle state proves live (%s)", (agentStatus) => {
    // Detected and adopted panes never emit interactive_ready — only
    // `agent start` marks a managed agent Active. The ack still proves
    // delivery: identity matched and the server verified the foreground
    // process before accepting the write; the required agent_status field
    // carries the detected state.
    expect(validSubmission({ interactive_ready: undefined, agent_status: agentStatus })).toEqual(expect.objectContaining({
      interactiveReady: true,
      interactiveProof: "detection",
      revision: 7
    }));
  });

  it("accepts an explicit launch_pending:false on the detection branch and keeps launch_pending:true off the managed one", () => {
    expect(validSubmission({ interactive_ready: undefined, launch_pending: false, agent_status: "idle" })).toEqual(expect.objectContaining({ interactiveProof: "detection" }));
    // The managed branch never consults launch_pending: the explicit
    // interactive flag is the stronger, server-owned signal.
    expect(validSubmission({ interactive_ready: true, launch_pending: true })).toEqual(expect.objectContaining({ interactiveProof: "managed" }));
  });

  it.each([
    ["missing result", response(undefined)],
    ["wrong result type", response({ type: "other", agent })],
    ["missing agent", response({ type: "agent_prompted" })],
    ["null agent", response({ type: "agent_prompted", agent: null })],
    ["array agent", response({ type: "agent_prompted", agent: [] })]
  ])("rejects %s before claiming delivery", (_label, envelope) => {
    expect(() => parsePromptSubmission(envelope, expected)).toThrowError(CliProtocolError);
  });

  it("can enforce the request ID supplied by the socket transport", () => {
    expect(() => parsePromptSubmission(response({ type: "agent_prompted", agent }, "other-request"), expected, "herdr-tools-request-1")).toThrowError(CliProtocolError);
    expect(parsePromptSubmission(response({ type: "agent_prompted", agent }, "herdr-tools-request-1"), expected, "herdr-tools-request-1").operationId).toBe("herdr-tools-request-1");
  });

  it.each([
    ["pane ID", { pane_id: "w1:p9" }, expected],
    ["terminal ID", { terminal_id: "term-other" }, expected],
    ["name", { name: "other" }, expected],
    ["kind", { agent: "claude" }, expected],
    ["agent session", { agent_session: { source: "pi", agent: "pi", kind: "id", value: "replacement" } }, expected]
  ])("rejects a target %s mismatch", (_label, overrides, wanted) => {
    expect(() => parsePromptSubmission(response({ type: "agent_prompted", agent: { ...agent, ...overrides } }), wanted)).toThrowError(/does not match/);
  });

  it.each([
    ["missing name", { name: undefined }],
    ["empty name", { name: "" }],
    ["missing kind", { agent: undefined }],
    ["empty kind", { agent: "" }],
    ["missing terminal ID", { terminal_id: undefined }],
    ["empty terminal ID", { terminal_id: "" }],
    ["missing agent session", { agent_session: undefined }],
    ["malformed agent session", { agent_session: "session-worker" }],
    ["incomplete agent session", { agent_session: { source: "pi", agent: "pi", kind: "id" } }],
    ["not interactive", { interactive_ready: false }],
    ["missing interactive flag without a live detected state", { interactive_ready: undefined, agent_status: "unknown" }],
    ["missing interactive flag without any detected state", { interactive_ready: undefined, agent_status: undefined }],
    ["missing interactive flag with malformed detected state", { interactive_ready: undefined, agent_status: "bogus" }],
    ["missing interactive flag on a launch-pending managed agent", { interactive_ready: undefined, launch_pending: true }],
    ["missing interactive flag with a malformed launch_pending", { interactive_ready: undefined, launch_pending: "true" }],
    ["missing revision", { revision: undefined }],
    ["negative revision", { revision: -1 }],
    ["fractional revision", { revision: 1.5 }],
    ["invalid state sequence", { state_change_seq: "4" }],
    ["negative state sequence", { state_change_seq: -1 }]
  ])("rejects %s without retaining unsafe evidence", (_label, overrides) => {
    expect(() => parsePromptSubmission(response({ type: "agent_prompted", agent: { ...agent, ...overrides } }), expected)).toThrowError(CliProtocolError);
  });

  it("requires every authoritative identity field before confirming delivery", () => {
    for (const field of ["terminal_id", "agent_session"] as const) {
      const missing = { ...agent };
      delete missing[field];
      expect(() => parsePromptSubmission(response({ type: "agent_prompted", agent: missing }), expected)).toThrowError(CliProtocolError);
    }
  });

  it("rejects empty and malformed identity record collections", () => {
    expect(() => joinPromptTargetIdentity([], "w1:p2")).toThrowError(/identity is missing/);
    expect(() => joinPromptTargetIdentity([null], "w1:p2")).toThrowError(/record is malformed/);
    expect(() => requirePromptTargetIdentity([], "w1:p2")).toThrowError(/identity is missing/);
    expect(() => parsePromptTargetIdentityFields(null)).toThrowError(/record is malformed/);
  });

  it("validates incomplete start fields without inventing omitted identity", () => {
    expect(parsePromptTargetIdentityFields({ name: "worker", agent: "pi" }, "w1:p2")).toEqual({ agentName: "worker", agentKind: "pi" });
    expect(joinPromptTargetIdentity([{ name: "worker", agent: "pi" }, agent], "w1:p2", { allowIncompleteFirstRecord: true })).toEqual(expected);
    expect(() => parsePromptTargetIdentityFields({ agent: "pi", agent_session: { source: "herdr:pi", agent: "claude", kind: "id", value: "replacement" } }, "w1:p2")).toThrowError(/contradictory/);
  });

  it("joins complete identity fields from independent authoritative records", () => {
    const complementary = [
      { pane_id: "w1:p2", terminal_id: "term-worker", agent_name: "worker" },
      { pane_id: "w1:p2", agent: "pi", agent_session: agent.agent_session }
    ];
    expect(joinPromptTargetIdentity(complementary, "w1:p2")).toEqual(expected);
    expect(requirePromptTargetIdentity(complementary, "w1:p2")).toEqual(expected);
    expect(joinPromptTargetIdentity([
      { pane_id: "w1:p2", terminal_id: null, agent_name: null, agent_session: null },
      { pane_id: "w1:p2", terminal_id: "term-worker", name: "worker", agent: "pi", agent_session: agent.agent_session }
    ], "w1:p2")).toEqual(expected);
    expect(() => joinPromptTargetIdentity([
      { pane_id: "w1:p2", terminal_id: "term-worker", agent_name: "worker", agent_session: agent.agent_session },
      { pane_id: "w1:p2", agent: "pi", agent_session: { ...agent.agent_session, value: "replacement" } }
    ], "w1:p2")).toThrowError(/contradictory/);
    expect(() => joinPromptTargetIdentity([
      { pane_id: "w1:p2", terminal_id: "term-worker", agent_name: "worker", agent: "pi" },
      { pane_id: "w1:p2", agent_session: { ...agent.agent_session, agent: "claude" } }
    ], "w1:p2")).toThrowError(/contradictory/);
    expect(() => joinPromptTargetIdentity([{ ...agent, agent_name: "replacement" }], "w1:p2")).toThrowError(/contradictory/);
  });
});

describe("prompt post-dispatch observation", () => {
  const baseline: PromptObservationBaseline = { state: "idle", stateChangeSeq: 4, revision: 7, screenDetectionSkipped: false };

  it("captures a complete idle baseline from one full agent-get record only", () => {
    expect(capturePromptObservationBaseline({ ...agent, screen_detection_skipped: false }, expected)).toEqual(baseline);
    const noFlag = { ...agent } as Record<string, unknown>;
    delete noFlag.screen_detection_skipped;
    expect(capturePromptObservationBaseline(noFlag, expected)).toEqual({ state: "idle", stateChangeSeq: 4, revision: 7 });
    expect(capturePromptObservationBaseline({ ...agent, screen_detection_skipped: "invalid" }, expected)).toEqual({ state: "idle", stateChangeSeq: 4, revision: 7 });
    for (const malformed of [
      { ...agent, agent_status: "working" },
      { ...agent, agent_status: "unknown" },
      { ...agent, agent_status: undefined },
      { ...agent, state_change_seq: undefined },
      { ...agent, revision: undefined }
    ]) {
      expect(() => capturePromptObservationBaseline(malformed, expected)).toThrowError(/complete idle agent-get lifecycle tuple/);
    }
    expect(() => capturePromptObservationBaseline({ ...agent, terminal_id: undefined }, expected)).toThrowError(/identity is malformed/);
    expect(() => capturePromptObservationBaseline({ ...agent, terminal_id: "replacement" }, expected)).toThrowError(/identity changed|does not match|changed/i);
  });

  it("confirms only from an advanced agent-get sequence with a present non-regressed revision", () => {
    const submission = validSubmission({ screen_detection_skipped: false });
    const post = (state?: string, revision: number | undefined = 7, stateChangeSeq: number | undefined = 4, skipped: unknown = false): Record<string, unknown> => ({
      ...agent,
      agent_status: state,
      revision,
      state_change_seq: stateChangeSeq,
      screen_detection_skipped: skipped
    });
    expect(classifyPromptObservation(post("working", 7, 5), submission, baseline)).toEqual({ status: "working", state: "working", stateChangeSeq: 5, revision: 7, screenDetectionSkipped: false, consumption: "confirmed" });
    expect(classifyPromptObservation(post("idle", 8, 5, true), submission, baseline)).toEqual({ status: "not_working", state: "idle", stateChangeSeq: 5, revision: 8, screenDetectionSkipped: true, consumption: "confirmed" });
    expect(classifyPromptObservation(post("done", 7, 5), submission, baseline)).toEqual({ status: "not_working", state: "done", stateChangeSeq: 5, revision: 7, screenDetectionSkipped: false, consumption: "confirmed" });
    expect(classifyPromptObservation(post("working"), submission, baseline)).toMatchObject({ status: "working", stateChangeSeq: 4, consumption: "unconfirmed" });
    expect(classifyPromptObservation(post("working", 7, 3), submission, baseline)).toMatchObject({ status: "working", stateChangeSeq: 3, consumption: "unconfirmed" });
    const missingRevision = post("working", 7, 5);
    delete missingRevision.revision;
    expect(classifyPromptObservation(missingRevision, submission, baseline)).toMatchObject({ status: "working", stateChangeSeq: 5, consumption: "unconfirmed" });
    expect(classifyPromptObservation(post("working", 6, 5), submission, baseline)).toMatchObject({ status: "stale", revision: 6, consumption: "unconfirmed" });
    const missingSequence = post("working", 7, 5);
    delete missingSequence.state_change_seq;
    expect(classifyPromptObservation(missingSequence, submission, baseline)).toMatchObject({ status: "working", consumption: "unconfirmed" });
    expect(classifyPromptObservation(post("unknown", 8, 5), submission, baseline)).toMatchObject({ status: "unknown", consumption: "unconfirmed" });
    expect(classifyPromptObservation(post("idle", 7, 4), submission, baseline)).toMatchObject({ status: "not_working", consumption: "unconfirmed" });
  });

  it("uses agent-get as the sole lifecycle tuple and ignores pane lifecycle/screen skew", () => {
    const submission = validSubmission({ screen_detection_skipped: undefined });
    const skewBaseline: PromptObservationBaseline = { state: "idle", stateChangeSeq: 7, revision: 7 };
    const agentGet = { ...agent, agent_status: "idle", state_change_seq: 7, revision: 7, screen_detection_skipped: false };
    const paneGet = { ...agent, agent_status: "working", state_change_seq: 8, revision: 8, screen_detection_skipped: true };
    expect(classifyPromptObservation(agentGet, submission, skewBaseline, [paneGet])).toEqual({
      status: "not_working",
      state: "idle",
      stateChangeSeq: 7,
      revision: 7,
      screenDetectionSkipped: false,
      consumption: "unconfirmed"
    });
    expect(classifyPromptObservation({ ...agentGet, screen_detection_skipped: "invalid" }, submission, skewBaseline, [paneGet])).toEqual({
      status: "not_working",
      state: "idle",
      stateChangeSeq: 7,
      revision: 7,
      consumption: "unconfirmed"
    });
  });

  it("fails closed on malformed authoritative lifecycle scalars", () => {
    const submission = validSubmission({ screen_detection_skipped: undefined });
    const base = { ...agent } as Record<string, unknown>;
    delete base.screen_detection_skipped;
    for (const malformed of [
      { ...base, agent_status: "other" },
      { ...base, state_change_seq: "4" },
      { ...base, state_change_seq: -1 },
      { ...base, state_change_seq: 1.5 },
      { ...base, revision: "7" },
      { ...base, revision: -1 },
      { ...base, revision: 1.5 }
    ]) {
      expect(classifyPromptObservation(malformed, submission, baseline)).toMatchObject({ status: "unavailable", code: "POSTSTATE_CONTRADICTORY", consumption: "unconfirmed" });
    }
    expect(classifyPromptObservation({ ...base, revision: "invalid" }, submission)).toMatchObject({ status: "unavailable", code: "POSTSTATE_CONTRADICTORY" });
  });

  it("keeps missing state unconfirmed and distinguishes identity failures with a baseline", () => {
    const submission = validSubmission({ screen_detection_skipped: undefined });
    const missingState = { ...agent } as Record<string, unknown>;
    delete missingState.agent_status;
    delete missingState.screen_detection_skipped;
    expect(classifyPromptObservation(missingState, submission, baseline)).toEqual({ status: "unavailable", code: "POSTSTATE_UNAVAILABLE", stateChangeSeq: 4, revision: 7, consumption: "unconfirmed" });
    expect(classifyPromptObservation({ agent_status: "working" }, submission, baseline)).toEqual({ status: "unavailable", code: "POSTSTATE_IDENTITY_UNAVAILABLE", consumption: "unconfirmed" });
    expect(classifyPromptObservation({ ...agent, terminal_id: "replacement" }, submission, baseline)).toMatchObject({ status: "unavailable", code: "POSTSTATE_IDENTITY_CHANGED", consumption: "unconfirmed", evidence: { records: expect.any(Array) } });
  });

  it("keeps communication observation diagnostic-only without a baseline", () => {
    const working = validSubmission({ screen_detection_skipped: false });
    const post = (state?: string, revision: number | undefined = 7): Record<string, unknown> => ({ ...agent, agent_status: state, revision, screen_detection_skipped: false });
    expect(classifyPromptObservation(post("working"), working)).toEqual({ status: "working", state: "working", stateChangeSeq: 4, revision: 7, screenDetectionSkipped: false });
    expect(classifyPromptObservation(post("idle"), working)).toEqual({ status: "not_working", state: "idle", stateChangeSeq: 4, revision: 7, screenDetectionSkipped: false });
    expect(classifyPromptObservation({ ...post("working"), revision: 6 }, working)).toEqual({ status: "stale", state: "working", stateChangeSeq: 4, revision: 6, screenDetectionSkipped: false });
    const noDiagnostics = post("idle");
    delete noDiagnostics.state_change_seq;
    delete noDiagnostics.revision;
    delete noDiagnostics.screen_detection_skipped;
    expect(classifyPromptObservation(noDiagnostics, validSubmission({ screen_detection_skipped: undefined }))).toEqual({ status: "not_working", state: "idle" });
    const noState = post("idle");
    delete noState.agent_status;
    expect(classifyPromptObservation(noState, working)).toEqual({ status: "unavailable", code: "POSTSTATE_UNAVAILABLE", stateChangeSeq: 4, revision: 7, screenDetectionSkipped: false });
    expect(classifyPromptObservation({ ...post(undefined), revision: 7 }, working)).toEqual({ status: "unavailable", code: "POSTSTATE_UNAVAILABLE", stateChangeSeq: 4, revision: 7, screenDetectionSkipped: false });
    expect(classifyPromptObservation({ ...post("working"), terminal_id: "term-replaced" }, working)).toMatchObject({ status: "unavailable", code: "POSTSTATE_IDENTITY_CHANGED", evidence: { records: [expect.objectContaining({ terminal_id: "term-replaced" })] } });
    expect(classifyPromptObservation({ agent_status: "working", revision: 7 }, working)).toEqual({ status: "unavailable", code: "POSTSTATE_IDENTITY_UNAVAILABLE" });
  });

  it("bounds model-visible session evidence while retaining exact internal values", () => {
    const long = "x".repeat(2_000);
    const full = parsePromptSubmission(
      response({ type: "agent_prompted", agent: { ...agent, agent_session: { source: long, agent: "pi", kind: "id", value: long } } }),
      { ...expected, agentSession: { source: long, agent: "pi", kind: "id", value: long } }
    );
    const compact = compactPromptSubmission(full);
    expect(full.agentSession.value).toHaveLength(2_000);
    expect(compact.agentSession.value).toHaveLength(256);
    const bounded = boundAgentSessionStrings({ expectedAgentSession: full.agentSession });
    expect((bounded as { expectedAgentSession: { value: string } }).expectedAgentSession.value).toHaveLength(256);
    expect(boundAgentSessionStrings("plain")).toBe("plain");
    expect(boundAgentSessionStrings([full.agentSession])).toHaveLength(1);
    expect(boundAgentSessionStrings({ agent_session: { source: 1, agent: null, kind: {}, value: undefined } })).toMatchObject({ agent_session: { source: "", agent: "", kind: "", value: "" } });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(boundAgentSessionStrings(cyclic)).toMatchObject({ self: "[cyclic]" });
    const replacementValue = "y".repeat(2_000);
    const malformedObservation = classifyPromptObservation({ pane_id: "w1:p2", terminal_id: 7, name: null, agent: {}, agent_session: { source: 1, agent: null, kind: {}, value: undefined }, agent_status: "working", revision: 7 }, full);
    expect(malformedObservation).toMatchObject({ status: "unavailable", code: "POSTSTATE_IDENTITY_UNAVAILABLE" });
    expect(malformedObservation).not.toHaveProperty("evidence");
    expect(classifyPromptObservation({ ...agent, agent_status: "working", revision: 7, agent_session: { ...agent.agent_session, value: replacementValue } }, full)).toMatchObject({ status: "unavailable", code: "POSTSTATE_IDENTITY_CHANGED", evidence: { records: [expect.objectContaining({ agent_session: expect.objectContaining({ value: replacementValue.slice(0, 256) }) })] } });

    const longValue = (suffix: string): string => `${"z".repeat(256)}${suffix}`;
    const longExpected = {
      paneId: longValue("-pane-expected"),
      terminalId: longValue("-terminal-expected"),
      agentName: longValue("-name-expected"),
      agentKind: longValue("-kind-expected"),
      agentSession: { source: longValue("-source-expected"), agent: longValue("-kind-expected"), kind: longValue("-session-kind-expected"), value: longValue("-session-value-expected") }
    };
    const longActual = {
      pane_id: longExpected.paneId,
      terminal_id: longValue("-terminal-actual"),
      name: longValue("-name-actual"),
      agent: longValue("-kind-actual"),
      agent_session: { source: longValue("-source-actual"), agent: longValue("-kind-actual"), kind: longValue("-session-kind-actual"), value: longValue("-session-value-actual") },
      interactive_ready: true,
      revision: 7
    };
    let acknowledgementError: unknown;
    try {
      parsePromptSubmission(response({ type: "agent_prompted", agent: longActual }), longExpected);
    } catch (error) {
      acknowledgementError = error;
    }
    expect(acknowledgementError).toBeInstanceOf(CliProtocolError);
    const acknowledgementDetails = (acknowledgementError as CliProtocolError).details;
    expect(acknowledgementDetails.expectedTerminalId).toHaveLength(256);
    expect(acknowledgementDetails.actualTerminalId).toHaveLength(256);
    expect((acknowledgementDetails.expectedAgentSession as Record<string, string>).value).toHaveLength(256);
    expect((acknowledgementDetails.actualAgentSession as Record<string, string>).value).toHaveLength(256);
    expect(JSON.stringify(acknowledgementDetails)).not.toContain("-terminal-expected");
    expect(boundAgentSessionStrings({ nested: { protocol: { terminal: longValue("-nested") } } })).toEqual({ nested: { protocol: { terminal: "z".repeat(256) } } });
  });

  it("reports unavailable observation errors without exposing process text", () => {
    expect(unavailablePromptObservation(Object.assign(new Error("secret process output"), { code: "CLI_PROTOCOL_ERROR" }))).toEqual({ status: "unavailable", code: "CLI_PROTOCOL_ERROR" });
    expect(unavailablePromptObservation({ code: "POSTSTATE_UNAVAILABLE" })).toEqual({ status: "unavailable", code: "POSTSTATE_UNAVAILABLE" });
    expect(unavailablePromptObservation("failure")).toEqual({ status: "unavailable", code: "POSTSTATE_UNAVAILABLE" });
    expect(JSON.stringify(unavailablePromptObservation(new Error("secret process output")))).not.toContain("secret");
  });
});
