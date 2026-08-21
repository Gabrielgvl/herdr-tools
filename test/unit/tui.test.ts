import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatCall, formatResult, resultForRender, textComponent } from "../../src/tui.js";

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

  it("renders partial, timeout, aborted, and error states truthfully", () => {
    expect(resultForRender("wait", { details: { outcome: "progress" } }, {}, "p1")).toEqual({ text: "partial · p1", tone: "warning" });
    expect(resultForRender("wait", { details: { outcome: "timeout" } })).toEqual({ text: "timeout", tone: "warning" });
    expect(resultForRender("wait", { details: { outcome: "aborted" } })).toEqual({ text: "aborted", tone: "warning" });
    expect(resultForRender("wait", { details: { outcome: "aborted" } }, {}, "p1")).toEqual({ text: "aborted · p1", tone: "warning" });
    expect(resultForRender("wait", { details: { outcome: "background" } })).toEqual({ text: "background", tone: "success" });
    expect(resultForRender("wait", { details: { outcome: "progress" } }, { isPartial: true })).toEqual({ text: "partial · wait", tone: "warning" });
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

  it("keeps rows compact for omitted targets and every non-success outcome", () => {
    expect(formatCall("herdr_wait", "waiting")).toBe("herdr_wait · waiting");
    expect(formatResult({ operation: "communicate", outcome: "error" })).toBe("error UNKNOWN");
    expect(formatResult({ operation: "wait", outcome: "timeout" })).toBe("timeout");
    expect(formatResult({ operation: "wait", outcome: "aborted", targetId: "p" })).toBe("aborted · p");
    expect(formatResult({ operation: "wait", outcome: "partial" })).toBe("partial");
    expect(formatResult({ operation: "other", outcome: "success" })).toBe("other");
  });
});
