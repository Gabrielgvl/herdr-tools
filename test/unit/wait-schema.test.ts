import Value from "typebox/value";
import { describe, expect, it } from "vitest";
import { WaitParamsSchema, isRawState, isSemanticState, validateWaitParams } from "../../src/wait-schema.js";

describe("herdr_wait schema and runtime validation", () => {
  it("is strict and accepts the documented state and output forms", () => {
    expect(Value.Check(WaitParamsSchema, { targets: ["w1:p1"], match: "any", condition: { kind: "state", state: "completed" }, timeoutMs: 1 })).toBe(true);
    expect(Value.Check(WaitParamsSchema, { targets: ["w1:p1"], match: "all", condition: { kind: "output", match: { kind: "literal", value: "done" } }, timeoutMs: 3_600_000 })).toBe(true);
    expect(Value.Check(WaitParamsSchema, { targets: ["p"], match: "any", condition: { kind: "output", match: { kind: "regex", value: "done" } }, timeoutMs: 1, reviewerModel: "bad" })).toBe(false);
    expect(Value.Check(WaitParamsSchema, { targets: ["p"], match: "any", condition: { kind: "state", state: "bad" }, timeoutMs: 1 })).toBe(false);
  });

  it("rejects exact duplicate and resolved-invalid input at runtime", () => {
    expect(() => validateWaitParams({ targets: ["p", "p"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 })).toThrowError(/duplicate/);
    expect(() => validateWaitParams({ targets: ["p\n"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 })).toThrowError(/single-line/);
    expect(() => validateWaitParams({ targets: ["p"], match: "any", condition: { kind: "output", match: { kind: "regex", value: "[" } }, timeoutMs: 1 })).toThrowError(/regex syntax/);
    expect(() => validateWaitParams({ targets: [], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 })).toThrowError(/at least one/);
    expect(() => validateWaitParams({ targets: ["p"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 0 })).toThrowError(/timeout/);
  });

  it("keeps literal output literal", () => {
    const validation = validateWaitParams({ targets: ["p"], match: "any", condition: { kind: "output", match: { kind: "literal", value: ".*" } }, timeoutMs: 1 });
    expect(validation.regex).toBeUndefined();
  });

  it("uses the bounded RE2 engine for pathological regex input", () => {
    const validation = validateWaitParams({ targets: ["p"], match: "any", condition: { kind: "output", match: { kind: "regex", value: "(a+)+$" } }, timeoutMs: 1 });
    expect(validation.regex?.constructor.name).toBe("RE2");
    expect(validation.regex?.test(`${"a".repeat(10_000)}!`)).toBe(false);
  });

  it("rejects every malformed runtime shape before polling", () => {
    const valid = { targets: ["p"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 };
    const invalid: unknown[] = [
      null,
      [],
      { ...valid, extra: true },
      { ...valid, targets: [] },
      { ...valid, targets: ["\0"] },
      { ...valid, match: "sometimes" },
      { ...valid, timeoutMs: 3_600_001 },
      { ...valid, timeoutMs: Number.NaN },
      { ...valid, condition: null },
      { ...valid, condition: [] },
      { ...valid, condition: { kind: "state", state: "idle", extra: true } },
      { ...valid, condition: { kind: "state", state: "not-a-state" } },
      { ...valid, condition: { kind: "output", match: { kind: "literal", value: "x" }, extra: true } },
      { ...valid, condition: { kind: "output", match: null } },
      { ...valid, condition: { kind: "output", match: [] } },
      { ...valid, condition: { kind: "output", match: { kind: "literal", value: "x", extra: true } } },
      { ...valid, condition: { kind: "output", match: { kind: "other", value: "x" } } },
      { ...valid, condition: { kind: "output", match: { kind: "literal", value: "" } } },
      { ...valid, condition: { kind: "unknown" } }
    ];
    for (const value of invalid) expect(() => validateWaitParams(value)).toThrowError(/INVALID_INPUT/);
  });

  it("covers state helpers and schema duplicate rejection", () => {
    expect(isRawState("idle")).toBe(true);
    expect(isRawState("started")).toBe(false);
    expect(isSemanticState("completed")).toBe(true);
    expect(isSemanticState("working")).toBe(false);
    expect(Value.Check(WaitParamsSchema, { targets: ["p", "p"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 })).toBe(false);
    expect(Value.Check(WaitParamsSchema, { targets: ["p"], match: "any", condition: { kind: "output", match: { kind: "regex", value: "" } }, timeoutMs: 1 })).toBe(false);
  });
});
