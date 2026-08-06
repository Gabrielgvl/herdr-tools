import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { PaneParamsSchema, TabParamsSchema, assertSafeEnvironment, assertSafeIdentifier } from "../../src/topology-schema.js";

function expectInvalid(call: () => void): void {
  let error: unknown;
  try { call(); } catch (caught) { error = caught; }
  expect(error).toMatchObject({ code: "INVALID_INPUT" });
}

describe("topology schemas", () => {
  it("accepts every pane and tab operation with strict shapes", () => {
    const panes = [
      { operation: "split", label: "child" },
      { operation: "move", target: "p1", destination: { kind: "tab", target: "t2" } },
      { operation: "move", target: "p1", destination: { kind: "new_tab", label: "new" }, direction: "down", focus: true },
      { operation: "rename", target: "p1", label: "renamed" },
      { operation: "focus", target: "p1" },
      { operation: "resize", target: "p1", direction: "left", amount: 0.5 },
      { operation: "swap", source: "p1", with: "right" },
      { operation: "swap", source: "p1", with: "p2" },
      { operation: "zoom", target: "p1", mode: "on" },
      { operation: "close", target: "p1" }
    ];
    const tabs = [
      { operation: "create", label: "new" },
      { operation: "rename", target: "t1", label: "renamed" },
      { operation: "focus", target: "current" },
      { operation: "close", target: "t2" }
    ];
    for (const params of panes) expect(Value.Check(PaneParamsSchema, params)).toBe(true);
    for (const params of tabs) expect(Value.Check(TabParamsSchema, params)).toBe(true);
  });

  it("rejects unknown fields, invalid discriminants, bad amounts, and tab labels", () => {
    expect(Value.Check(PaneParamsSchema, { operation: "split", label: "x", extra: true })).toBe(false);
    expect(Value.Check(PaneParamsSchema, { operation: "split", label: "x", direction: "left" })).toBe(false);
    expect(Value.Check(PaneParamsSchema, { operation: "resize", target: "p1", direction: "right", amount: 0 })).toBe(false);
    expect(Value.Check(PaneParamsSchema, { operation: "swap", source: "p1", with: "x", extra: "no" })).toBe(false);
    expect(Value.Check(TabParamsSchema, { operation: "rename", target: "Tab Label", label: "x" })).toBe(true);
    expect(Value.Check(TabParamsSchema, { operation: "create", label: "" })).toBe(false);
    expect(Value.Check(TabParamsSchema, { operation: "create", label: "bad\nlabel" })).toBe(false);
    expect(Value.Check(PaneParamsSchema, { operation: "close", target: "p1", confirm: true })).toBe(false);
  });

  it("validates identifiers and transport-safe environment values without an allowlist", () => {
    expectInvalid(() => assertSafeIdentifier("", "label"));
    expectInvalid(() => assertSafeIdentifier("x\n", "label"));
    expect(() => assertSafeEnvironment({ CUSTOM_FLAG: "any-value", EMPTY: "" })).not.toThrow();
    expectInvalid(() => assertSafeEnvironment({ "BAD=KEY": "x" }));
    expectInvalid(() => assertSafeEnvironment({ SECRET: "bad\nvalue" }));
    expectInvalid(() => assertSafeEnvironment({ SECRET: "bad\u0000value" }));
  });
});
