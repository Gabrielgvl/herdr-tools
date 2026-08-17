import { describe, expect, it } from "vitest";
import { CYCLIC_MARKER, DEPTH_LIMIT_MARKER, MODEL_SAFE_DEPTH_LIMIT, isEnvironmentKey, modelSafeJson, withoutEnvironment } from "../../src/redaction.js";

const ENVIRONMENT_KEYS = ["env", "ENV", "environment", "Environment", "env_vars", "ENV_VARS", "environment_variables", "environment_overrides", "environmentOverrides"];

describe("environment redaction", () => {
  it("recognizes every environment-shaped key and nothing adjacent to it", () => {
    for (const key of ENVIRONMENT_KEYS) expect(isEnvironmentKey(key), key).toBe(true);
    for (const key of ["envelope", "environments", "agent_env", "cwd", "label", "env_var", ""]) expect(isEnvironmentKey(key), key).toBe(false);
  });

  it("keeps a typed diagnostic record that has no string to leak", () => {
    // The health result reports environment presence, not values; environment
    // values are strings by contract, so a boolean record cannot carry one.
    const health = { environment: { enabled: true, currentIdsPresent: true, currentIdsValid: false }, compatible: true };
    expect(withoutEnvironment(health)).toEqual(health);
    expect(modelSafeJson(health)).toEqual(health);
    expect(withoutEnvironment({ env: {} })).toEqual({ env: {} });
    expect(withoutEnvironment({ env: [1, null, { count: 2 }] })).toEqual({ env: [1, null, { count: 2 }] });

    // Anything string-bearing at any depth is dropped, including a marker the
    // model-safe projection substituted for a cycle.
    expect(withoutEnvironment({ environment: { enabled: true, SECRET: "leak" } })).toEqual({});
    expect(withoutEnvironment({ environment: [{ deeper: ["leak"] }] })).toEqual({});
    const cyclicEnvironment: Record<string, unknown> = { pane_id: "w:p2" };
    cyclicEnvironment.env = { self: cyclicEnvironment };
    expect(modelSafeJson(cyclicEnvironment)).toEqual({ pane_id: "w:p2" });
  });

  it("drops environment-shaped keys at every depth and keeps every other value", () => {
    const record = {
      pane_id: "w:p2",
      env: { SECRET: "one" },
      environment_overrides: { SECRET: "two" },
      history: [{ env_vars: { SECRET: "three" } }, { child: { environment_variables: { SECRET: "four" } } }],
      counts: [1, 2, 3],
      label: "worker",
      missing: null
    };
    expect(withoutEnvironment(record)).toEqual({
      pane_id: "w:p2",
      history: [{}, { child: {} }],
      counts: [1, 2, 3],
      label: "worker",
      missing: null
    });
    expect(withoutEnvironment("text")).toBe("text");
    expect(withoutEnvironment(7)).toBe(7);
    expect(withoutEnvironment(null)).toBe(null);
    expect(withoutEnvironment([{ env: "one" }, "keep"])).toEqual([{}, "keep"]);
  });
});

describe("model-safe projection", () => {
  it("keeps JSON scalars and normalizes the values JSON cannot carry", () => {
    expect(modelSafeJson({ text: "a", flag: false, zero: 0, nothing: null })).toEqual({ text: "a", flag: false, zero: 0, nothing: null });
    expect(modelSafeJson({ broken: Number.NaN, huge: Number.POSITIVE_INFINITY, count: 42n })).toEqual({ broken: null, huge: null, count: "42" });
    expect(modelSafeJson({ fn: () => undefined, sym: Symbol("s"), absent: undefined, kept: 1 })).toEqual({ kept: 1 });
    expect(modelSafeJson([undefined, () => undefined, 1])).toEqual([null, null, 1]);
    expect(modelSafeJson(undefined)).toBeUndefined();
    expect(modelSafeJson(() => undefined)).toBeUndefined();
    expect(modelSafeJson("plain")).toBe("plain");
    expect(modelSafeJson(null)).toBe(null);
  });

  it("honors a custom JSON representation so typed evidence keeps its shape", () => {
    expect(modelSafeJson({ when: new Date("2026-08-17T12:00:00.000Z") })).toEqual({ when: "2026-08-17T12:00:00.000Z" });
    expect(modelSafeJson({ wrapped: { toJSON: () => ({ pane_id: "w:p2", environment: { SECRET: "leak" } }) } })).toEqual({ wrapped: { pane_id: "w:p2" } });
  });

  it("marks cycles instead of throwing and keeps repeated non-cyclic references", () => {
    const shared = { pane_id: "w:p2" };
    const cyclic: Record<string, unknown> = { shared, twice: shared, list: [] as unknown[] };
    cyclic.self = cyclic;
    (cyclic.list as unknown[]).push(cyclic, shared);
    const projected = modelSafeJson(cyclic);
    expect(projected).toEqual({ shared: { pane_id: "w:p2" }, twice: { pane_id: "w:p2" }, list: [CYCLIC_MARKER, { pane_id: "w:p2" }], self: CYCLIC_MARKER });
    expect(() => JSON.stringify(projected)).not.toThrow();
  });

  it("stops at the documented depth limit", () => {
    let deep: Record<string, unknown> = { end: "bottom" };
    for (let level = 0; level < MODEL_SAFE_DEPTH_LIMIT + 5; level += 1) deep = { deep };
    const serialized = JSON.stringify(modelSafeJson(deep));
    expect(serialized).toContain(DEPTH_LIMIT_MARKER);
    expect(serialized).not.toContain("bottom");
    // A record within the limit is projected in full.
    expect(modelSafeJson({ a: { b: { c: { d: "kept" } } } })).toEqual({ a: { b: { c: { d: "kept" } } } });
    expect(modelSafeJson([[[["deep"]]]])).toEqual([[[["deep"]]]]);
  });

  it("strips environment-shaped keys at every depth, including inside arrays", () => {
    const projected = modelSafeJson({
      pane_id: "w:p2",
      environment: { SECRET: "one" },
      snapshots: [{ metadata: { pane_id: "w:p3", env_vars: { SECRET: "two" } } }],
      nested: { deeper: { environmentOverrides: { SECRET: "three" } } }
    });
    expect(JSON.stringify(projected)).not.toMatch(/one|two|three/);
    expect(projected).toEqual({ pane_id: "w:p2", snapshots: [{ metadata: { pane_id: "w:p3" } }], nested: { deeper: {} } });
  });
});
