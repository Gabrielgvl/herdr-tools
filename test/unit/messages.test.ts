import { describe, expect, it } from "vitest";
import { MESSAGE_INLINE_MAX_BYTES, assertDeliverySize, assertMessageText } from "../../src/messages/limits.js";
import { withDeliveryFailureEvidence } from "../../src/messages/failure.js";
import { handoffWriteCapability } from "../../src/profiles/capability.js";
import type { Profile } from "../../src/profiles/types.js";

function profile(kind: "pi" | "claude" | "agy", overrides: Partial<Profile["runtime"]> = {}): Profile {
  const runtime = kind === "pi"
    ? { kind: "pi" as const, model: "test", thinking: "low" as const, tools: [], extensions: [], skills: [], ...overrides }
    : kind === "claude"
      ? { kind: "claude" as const, model: "test", effort: "medium" as const, permissionMode: "default" as const, allowedTools: [], disallowedTools: [], addDirs: [], pluginDirs: [], developmentChannels: [], ...overrides }
      : { kind: "agy" as const, model: "test", mode: "plan" as const, addDirs: [], ...overrides };
  return {
    name: `${kind}-profile`, description: "profile", timeoutMinutes: 1, sessionPersistence: kind !== "pi", runtime: runtime as Profile["runtime"], fallbackProfiles: [], body: "body", source: { kind: "bundled", path: `/profiles/${kind}.md`, scopeRoot: "/profiles", precedence: 0 }
  };
}

describe("message limits and capabilities", () => {
  it("enforces text and route bounds", () => {
    expect(() => assertMessageText("")).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => assertMessageText("bad\0text")).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => assertMessageText(12)).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => assertDeliverySize("x".repeat(MESSAGE_INLINE_MAX_BYTES + 1), "inline")).toThrowError(expect.objectContaining({ code: "PAYLOAD_TOO_LARGE_FOR_INLINE" }));
    expect(() => assertDeliverySize("ok", "inline")).not.toThrow();
  });

  it("derives handoff write capability from the effective post-override runtime", () => {
    expect(handoffWriteCapability(profile("pi"))).toMatchObject({ kind: "pi", capable: true });
    expect(handoffWriteCapability(profile("pi", { tools: ["read"] }))).toMatchObject({ capable: false, reason: "Pi profile excludes every write-capable tool" });
    expect(handoffWriteCapability(profile("pi", { tools: ["read"] }), { tools: ["apply_patch"] })).toMatchObject({ capable: true });
    expect(handoffWriteCapability(profile("claude"))).toMatchObject({ kind: "claude", capable: true });
    expect(handoffWriteCapability(profile("claude", { disallowedTools: ["Write", "Bash"] }))).toMatchObject({ capable: false, reason: "Claude profile excludes Write and Bash" });
    expect(handoffWriteCapability(profile("claude", { allowedTools: ["Bash"] }))).toMatchObject({ capable: true });
    expect(handoffWriteCapability(profile("claude"), { disallowedTools: ["Write", "Bash"] })).toMatchObject({ capable: false });
    // AGY has no tool allowlist to narrow, so it can always write its artifact.
    expect(handoffWriteCapability(profile("agy"))).toMatchObject({ kind: "agy", capable: true, reason: "AGY profile can write its run handoff" });
  });

  it("adds body-free delivery evidence only to object failures", () => {
    expect(withDeliveryFailureEvidence("string failure", { delivery: "inline" })).toBe("string failure");
    const typed = Object.assign(new Error("send failed"), { code: "CLI_TIMEOUT", details: { target: "w:p1" } });
    const augmented = withDeliveryFailureEvidence(typed, { delivery: "inline", route: "prompt_direct", phase: "send" }) as typeof typed;
    expect(augmented.code).toBe("CLI_TIMEOUT");
    expect(augmented.details).toMatchObject({ target: "w:p1", delivery: "inline", route: "prompt_direct", phase: "send" });
    const untyped = Object.assign(new Error("no details"), { details: "not-a-record" });
    expect((withDeliveryFailureEvidence(untyped, { phase: "send" }) as typeof untyped).details).toEqual({ phase: "send" });
    const arrayDetails = Object.assign(new Error("array details"), { details: ["ignored"] });
    expect((withDeliveryFailureEvidence(arrayDetails, { delivery: "inline" }) as typeof arrayDetails).details).toEqual({ delivery: "inline" });

    const unsafeDispatch = Object.assign(new Error("transport text"), { details: { promptDispatch: { state: "unknown", requestId: "request-1", body: "secret prompt" } } });
    const safeDispatch = withDeliveryFailureEvidence(unsafeDispatch, {}) as typeof unsafeDispatch;
    expect(safeDispatch.details).toEqual({ promptDispatch: { state: "unknown", requestId: "request-1" } });
    expect(JSON.stringify(safeDispatch.details)).not.toContain("secret prompt");

    for (const promptDispatch of [
      { state: "invalid" },
      { state: "acknowledged" },
      { state: "rejected", requestId: "" },
      { state: "unknown", requestId: "x".repeat(257) },
      { state: "not_written", requestId: "bad\nrequest" }
    ]) {
      const failure = Object.assign(new Error("dispatch"), { details: { promptDispatch } });
      const expected = ["not_written", "rejected", "acknowledged", "unknown"].includes(promptDispatch.state)
        ? { promptDispatch: { state: promptDispatch.state } }
        : {};
      expect((withDeliveryFailureEvidence(failure, {}) as typeof failure).details).toEqual(expected);
    }
  });
});
