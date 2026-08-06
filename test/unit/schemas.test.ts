import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { CommunicateParamsSchema, InspectParamsSchema } from "../../src/schemas.js";

describe("public schemas", () => {
  it("rejects unknown fields and invalid target identifiers", () => {
    expect(Value.Check(InspectParamsSchema, { mode: "health", target: "current" })).toBe(false);
    expect(Value.Check(InspectParamsSchema, { mode: "target", target: "bad\nvalue" })).toBe(false);
    expect(Value.Check(CommunicateParamsSchema, { operation: "prompt", target: "x", text: "hi", extra: true })).toBe(false);
    expect(Value.Check(CommunicateParamsSchema, { operation: "keys", target: "x", keys: ["\u001b"] })).toBe(false);
  });

  it("accepts the three communication discriminants", () => {
    expect(Value.Check(CommunicateParamsSchema, { operation: "prompt", target: "x", text: "hi" })).toBe(true);
    expect(Value.Check(CommunicateParamsSchema, { operation: "steer", target: "x", text: "hi" })).toBe(true);
    expect(Value.Check(CommunicateParamsSchema, { operation: "keys", target: "x", keys: ["esc"] })).toBe(true);
  });
});
