import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import {
  DaemonLaunchRequestSchema,
  IdempotencyKeySchema,
  LaunchTaskSchema,
  PublishedLaunchParamsSchema,
} from "../../src/launch-schema.js";

const task = { objective: "do the work", scope: "only these files", doneWhen: ["evidence exists"] };

describe("IdempotencyKeySchema", () => {
  it("accepts the full allowed charset and the 1–128 length bounds", () => {
    expect(Value.Check(IdempotencyKeySchema, "a")).toBe(true);
    expect(Value.Check(IdempotencyKeySchema, "x".repeat(128))).toBe(true);
    expect(Value.Check(IdempotencyKeySchema, "Az0-9._:-")).toBe(true);
    expect(Value.Check(IdempotencyKeySchema, "..")).toBe(true);
    expect(Value.Check(IdempotencyKeySchema, "deploy:fix-2026.09.24_01")).toBe(true);
  });

  it("rejects empty, over-length, and out-of-charset keys", () => {
    expect(Value.Check(IdempotencyKeySchema, "")).toBe(false);
    expect(Value.Check(IdempotencyKeySchema, "x".repeat(129))).toBe(false);
    for (const bad of ["a/b", "a\\b", "a b", "a\tb", "a\nb", "a\0b", "a%b", "a+b", "a@b", "key!", "clé", "キー"]) {
      expect(Value.Check(IdempotencyKeySchema, bad), bad).toBe(false);
    }
    expect(Value.Check(IdempotencyKeySchema, 42)).toBe(false);
    expect(Value.Check(IdempotencyKeySchema, null)).toBe(false);
  });
});

describe("DaemonLaunchRequestSchema", () => {
  it("requires the task and the idempotency key", () => {
    expect(Value.Check(DaemonLaunchRequestSchema, { task, idempotencyKey: "k" })).toBe(true);
    expect(Value.Check(DaemonLaunchRequestSchema, { task })).toBe(false);
    expect(Value.Check(DaemonLaunchRequestSchema, { idempotencyKey: "k" })).toBe(false);
    expect(Value.Check(DaemonLaunchRequestSchema, { task, idempotencyKey: "bad key" })).toBe(false);
    expect(Value.Check(DaemonLaunchRequestSchema, { task, idempotencyKey: "k", extra: 1 })).toBe(false);
  });

  it("still validates the embedded task against the unchanged contract", () => {
    expect(Value.Check(DaemonLaunchRequestSchema, { task: { ...task, doneWhen: [] }, idempotencyKey: "k" })).toBe(false);
    expect(Value.Check(DaemonLaunchRequestSchema, { task: { ...task, replicas: 9 }, idempotencyKey: "k" })).toBe(false);
    expect(Value.Check(DaemonLaunchRequestSchema, { task: "not-a-task", idempotencyKey: "k" })).toBe(false);
    expect(Value.Check(DaemonLaunchRequestSchema, {
      task: { ...task, tier: "frontier", replicas: 2, label: "x", constraints: ["c"], cwd: "/tmp" },
      idempotencyKey: "k",
    })).toBe(true);
  });
});

describe("live launch surface (zero-impact guard)", () => {
  it("keeps LaunchTaskSchema byte-identical: idempotencyKey is an unknown field", () => {
    expect(Value.Check(LaunchTaskSchema, task)).toBe(true);
    expect(Value.Check(LaunchTaskSchema, { ...task, idempotencyKey: "k" })).toBe(false);
    expect(PublishedLaunchParamsSchema).toBe(LaunchTaskSchema);
  });
});
