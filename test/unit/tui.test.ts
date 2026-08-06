import { describe, expect, it } from "vitest";
import { formatCall, formatResult } from "../../src/tui.js";

describe("compact tool rows", () => {
  it("shows operation and target without raw transcripts or JSON", () => {
    expect(formatCall("herdr_inspect", "target", "w1:p2")).toBe("herdr_inspect · target · w1:p2");
    expect(formatResult({ operation: "inspect", outcome: "success", targetId: "w1:p2" })).toBe("inspected · w1:p2");
    expect(formatResult({ operation: "communicate", outcome: "error", code: "TARGET_BUSY", targetId: "w1:p2" })).toBe("error TARGET_BUSY · w1:p2");
    expect(formatResult({ operation: "communicate", outcome: "success", targetId: "w1:p2", postState: { agent_status: "working" } })).toBe("sent · w1:p2 · working");
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
