import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatCall, formatResult, renderResultComponent, resultForRender, textComponent } from "../../src/tui.js";

describe("compact tool rows", () => {
  it("shows operation and target without raw transcripts or JSON", () => {
    expect(formatCall("herdr_inspect", "target", "w1:p2")).toBe("herdr_inspect · target · w1:p2");
    expect(formatResult({ operation: "inspect", outcome: "success", targetId: "w1:p2" })).toBe("inspected · w1:p2");
    expect(formatResult({ operation: "communicate", outcome: "error", code: "TARGET_BUSY", targetId: "w1:p2" })).toBe("error TARGET_BUSY · w1:p2");
    expect(formatResult({ operation: "communicate", outcome: "error", code: "CLI_INCOMPATIBLE", delivery: "attachment", targetId: "w1:p2" })).toBe("error CLI_INCOMPATIBLE · attachment · w1:p2");
    expect(formatResult({ operation: "communicate", outcome: "success", targetId: "w1:p2", postState: { agent_status: "working" } })).toBe("sent · w1:p2 · working");
    expect(formatResult({ operation: "communicate", outcome: "cancelled", targetId: "w1:p2", postState: { agent_status: "idle" } })).toBe("cancelled · w1:p2 · idle");
    expect(formatResult({ operation: "communicate", outcome: "interrupted", targetId: "w1:p2", postState: { agent_status: "blocked" } })).toBe("interrupted · w1:p2 · blocked");
    expect(formatResult({ operation: "communicate", outcome: "agent_exited", targetId: "w1:p2", postState: { agent_status: "unknown" } })).toBe("agent_exited · w1:p2 · unknown");
  });

  it("uses Pi components that wrap to narrow widths and keep every line bounded", () => {
    const component = textComponent("herdr_inspect · target · ".padEnd(120, "x"));
    for (const line of component.render(17)) expect(visibleWidth(line)).toBeLessThanOrEqual(17);
    component.invalidate();
  });

  it("renders detached, partial, and error states truthfully", () => {
    expect(resultForRender("launch", { details: { outcome: "partial" } }, {}, "p1")).toEqual({ text: "partial · p1", tone: "warning" });
    expect(resultForRender("launch", { details: { outcome: "partial" } })).toEqual({ text: "partial", tone: "warning" });
    expect(resultForRender("wait", { details: { operation_phase: "accepted" } })).toEqual({ text: "accepted", tone: "muted" });
    expect(resultForRender("wait", { details: { operation_phase: "accepted", jobId: "job_1" } })).toEqual({ text: "accepted · job_1", tone: "muted" });
    expect(resultForRender("wait", { details: { operation_phase: "accepted" } }, { isPartial: true })).toEqual({ text: "partial · wait", tone: "warning" });
    expect(resultForRender("wait", { details: { operation_phase: "running", jobId: "job_1" } })).toEqual({ text: "running · job_1", tone: "muted" });
    expect(resultForRender("wait", { details: { operation_phase: "running" } })).toEqual({ text: "running", tone: "muted" });
    expect(resultForRender("wait", { details: { operation_phase: "cancel_requested", jobId: "job_1" } })).toEqual({ text: "cancel_requested · job_1", tone: "warning" });
    expect(resultForRender("wait", { details: { operation_phase: "cancel_requested" } }, {}, "p1")).toEqual({ text: "cancel_requested", tone: "warning" });
    expect(resultForRender("wait", { details: { operation_phase: "settled", wait_result: "condition_met" } })).toEqual({ text: "settled · condition_met", tone: "muted" });
    expect(resultForRender("wait", { details: { operation_phase: "settled", wait_result: "timed_out" } }, {}, "p1")).toEqual({ text: "settled · timed_out · p1", tone: "muted" });
    expect(resultForRender("wait", { details: { operation_phase: "settled", wait_result: "failed" } })).toEqual({ text: "settled · failed", tone: "error" });
    expect(resultForRender("wait", { details: { operation_phase: "settled", wait_result: "manager_judgment_required" } })).toEqual({ text: "settled · manager_judgment_required", tone: "warning" });
    expect(resultForRender("wait", { details: { operation_phase: "settled", wait_result: "cancelled" } })).toEqual({ text: "settled · cancelled", tone: "warning" });
    expect(resultForRender("wait", { details: { operation_phase: "settled", wait_result: "unknown" } })).toEqual({ text: "settled · unknown", tone: "warning" });
    expect(resultForRender("wait", { details: { operation_phase: "settled" } })).toEqual({ text: "settled · unknown", tone: "warning" });
    expect(resultForRender("wait", {}, {})).toEqual({ text: "error UNKNOWN", tone: "error" });
    expect(resultForRender("wait", { isError: true, details: { code: "REVIEWER_FAILED" } })).toEqual({ text: "error REVIEWER_FAILED", tone: "error" });
    expect(resultForRender("communicate", { details: { outcome: "success", delivery: "attachment" } })).toEqual({ text: "sent · attachment", tone: "success" });
    expect(resultForRender("communicate", { details: { outcome: "cancelled", postState: { agent_status: "idle" } } }, {}, "p2")).toEqual({ text: "cancelled · p2 · idle", tone: "success" });
    expect(resultForRender("communicate", { details: { outcome: "agent_exited", postState: { agent_status: "unknown" } } }, {}, "p2")).toEqual({ text: "agent_exited · p2 · unknown", tone: "warning" });
    expect(resultForRender("communicate", { isError: true, details: { code: "CLI_TIMEOUT", delivery: "attachment" } }, {}, "p2")).toEqual({ text: "error CLI_TIMEOUT · attachment · p2", tone: "error" });
    expect(resultForRender("launch", { isError: true, details: { code: "LAUNCH_FAILED", delivery: "inline" } })).toEqual({ text: "error LAUNCH_FAILED · inline", tone: "error" });
    expect(resultForRender("wait", { isError: true })).toEqual({ text: "error UNKNOWN", tone: "error" });
    const theme = { fg: (name: string, value: string) => `${name}:${value}` };
    expect(textComponent("status", theme, "success").render(20)[0]).toBe("success:status");
  });

  it("renders the exact assignment-unconfirmed launch recovery row from active supervision", () => {
    const details = {
      causeCode: "PROMPT_UNCONFIRMED",
      phase: "prompt_verification",
      assignmentState: "unconfirmed",
      promptConsumption: "unconfirmed",
      agentStarted: true,
      promptSubmitted: true,
      recipientRegistered: false,
      paneId: "w1:p2",
      supervision: {
        jobId: "job_supervisor_2",
        state: "active",
        child: { paneId: "w1:p2", agentName: "worker", agentKind: "pi", terminalId: "term-secret", candidateName: "worker-pi" }
      }
    };
    expect(resultForRender("launch", { isError: true, details }, {}, "stale-target")).toEqual({
      text: "error LAUNCH_FAILED · assignment unconfirmed · w1:p2 · supervisor job_supervisor_2",
      tone: "error"
    });
    expect(resultForRender("launch", {
      isError: true,
      details: { ...details, code: "LAUNCH_FAILED", supervisorJobId: "job_other" }
    }, {}, "w1:p2")).toEqual({ text: "error LAUNCH_FAILED · w1:p2", tone: "error" });
    expect(resultForRender("launch", { isError: true, details: { ...details, code: "LAUNCH_FAILED", paneId: "" } })).toEqual({ text: "error LAUNCH_FAILED", tone: "error" });
    expect(resultForRender("launch", { isError: true, details: { ...details, code: "LAUNCH_FAILED", supervision: { ...details.supervision, state: "settled" } } })).toEqual({ text: "error LAUNCH_FAILED", tone: "error" });
    expect(resultForRender("launch", { isError: true, details: { ...details, code: "LAUNCH_FAILED", supervision: { ...details.supervision, child: { ...details.supervision.child, paneId: "w1:p3" } } } })).toEqual({ text: "error LAUNCH_FAILED", tone: "error" });
  });

  it("renders the recovery handles for every unconfirmed shape the launch window produces", () => {
    const supervision = {
      jobId: "job_supervisor_2",
      state: "active",
      child: { paneId: "w1:p2", agentName: "worker", agentKind: "pi", terminalId: "term-secret", candidateName: "worker-pi" }
    };
    const unconfirmed = {
      assignmentState: "unconfirmed",
      agentStarted: true,
      recipientRegistered: false,
      paneId: "w1:p2",
      supervisorJobId: "job_supervisor_2",
      supervision
    };
    const row = (details: Record<string, unknown>) => resultForRender("launch", { isError: true, details }, {}, "w1:p2");
    const handles = "assignment unconfirmed · w1:p2 · supervisor job_supervisor_2";
    // Pre-acknowledgement: the prompt transport failed before any acknowledgement,
    // so nothing observed consumption and the child may still hold the assignment.
    expect(row({ ...unconfirmed, promptSubmitted: false, phase: "prompt_verification", causeCode: "CLI_INCOMPATIBLE" }))
      .toEqual({ text: `error LAUNCH_FAILED · ${handles}`, tone: "error" });
    // Before the prompt phase is even entered, while supervision is already bound.
    expect(row({ ...unconfirmed, promptSubmitted: false, phase: "supervision_bind", causeCode: "ENVELOPE_TOO_LARGE" }))
      .toEqual({ text: `error LAUNCH_FAILED · ${handles}`, tone: "error" });
    // Acknowledged, then a non-PROMPT_UNCONFIRMED transport failure carrying its own
    // code: that code is a cause, never the row prefix, so the handles stay put.
    expect(row({ ...unconfirmed, promptSubmitted: true, code: "ABORTED", causeCode: "ABORTED" }))
      .toEqual({ text: `error LAUNCH_FAILED · ${handles}`, tone: "error" });
    expect(row({ ...unconfirmed, promptSubmitted: true, code: "POSTSTATE_UNAVAILABLE", promptConsumption: "unconfirmed" }))
      .toEqual({ text: `error LAUNCH_FAILED · ${handles}`, tone: "error" });
    // An untrusted or non-string code neither reaches the prefix nor costs the handles.
    expect(row({ ...unconfirmed, promptSubmitted: true, code: "launch failed\u0007" }))
      .toEqual({ text: `error LAUNCH_FAILED · ${handles}`, tone: "error" });
    expect(row({ ...unconfirmed, promptSubmitted: true, code: 7 }))
      .toEqual({ text: `error LAUNCH_FAILED · ${handles}`, tone: "error" });
  });

  it("falls back to the generic error row for malformed or contradictory unconfirmed details", () => {
    const details = {
      causeCode: "PROMPT_UNCONFIRMED",
      phase: "prompt_verification",
      assignmentState: "unconfirmed",
      promptConsumption: "unconfirmed",
      agentStarted: true,
      promptSubmitted: true,
      recipientRegistered: false,
      paneId: "w1:p2",
      supervision: {
        jobId: "job_supervisor_2",
        state: "active",
        child: { paneId: "w1:p2", agentName: "worker", agentKind: "pi", terminalId: "term-secret", candidateName: "worker-pi" }
      }
    };
    const generic = { text: "error LAUNCH_FAILED · w1:p2", tone: "error" };
    const row = (overrides: Record<string, unknown>) => resultForRender("launch", { isError: true, details: { ...details, code: "LAUNCH_FAILED", ...overrides } }, {}, "w1:p2");
    expect(row({ agentStarted: false })).toEqual(generic);
    expect(row({ recipientRegistered: true })).toEqual(generic);
    expect(row({ promptSubmitted: "yes" })).toEqual(generic);
    // Consumption cannot be confirmed while the assignment is unconfirmed.
    expect(row({ promptConsumption: "confirmed" })).toEqual(generic);
    expect(row({ supervision: { ...details.supervision, child: "w1:p2" } })).toEqual(generic);
    expect(row({ supervision: { ...details.supervision, jobId: "job supervisor" } })).toEqual(generic);
    expect(row({ paneId: " w1:p2" })).toEqual(generic);
    expect(row({ paneId: "w".repeat(257) })).toEqual({ text: "error LAUNCH_FAILED · w1:p2", tone: "error" });
    // Generic launch rows keep their existing code behavior, untrusted text included.
    expect(row({ agentStarted: false, code: "launch failed\u0007" })).toEqual({ text: "error launch failed\u0007 · w1:p2", tone: "error" });
    expect(row({ agentStarted: false, code: 7 })).toEqual({ text: "error UNKNOWN · w1:p2", tone: "error" });
  });

  it("keeps rows compact for omitted targets and every non-success outcome", () => {
    expect(formatCall("herdr_wait", "waiting")).toBe("herdr_wait · waiting");
    expect(formatResult({ operation: "communicate", outcome: "error" })).toBe("error UNKNOWN");
    expect(formatResult({ operation: "wait", outcome: "partial" })).toBe("partial");
    expect(formatResult({ operation: "other", outcome: "success" })).toBe("other");
    expect(renderResultComponent("communicate", { details: { outcome: "success" } }, {}, { fg: (name: string, value: string) => `${name}:${value}` }, "p1").render(40)[0]).toBe("success:sent · p1");
  });
});
