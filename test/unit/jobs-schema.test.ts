import Value from "typebox/value";
import { describe, expect, it } from "vitest";
import { OPERATION_PHASES } from "../../src/job-registry.js";
import { JobsParamsSchema, validateJobsParams } from "../../src/jobs-schema.js";

describe("herdr_jobs schema and runtime validation", () => {
  it("accepts each operation and the documented list bounds", () => {
    expect(Value.Check(JobsParamsSchema, { operation: "list" })).toBe(true);
    expect(Value.Check(JobsParamsSchema, { operation: "list", operation_phase: OPERATION_PHASES[0], offset: 0, limit: 100 })).toBe(true);
    expect(validateJobsParams({ operation: "list" })).toEqual({ operation: "list" });
    expect(validateJobsParams({ operation: "get", jobId: "job_get" })).toEqual({ operation: "get", jobId: "job_get" });
    expect(validateJobsParams({ operation: "cancel", jobId: "job_cancel" })).toEqual({ operation: "cancel", jobId: "job_cancel" });
  });

  it("rejects malformed top-level input and missing or invalid operation", () => {
    for (const value of [null, [], "jobs", {}, { operation: "unknown" }]) {
      expect(() => validateJobsParams(value)).toThrowError(/INVALID_INPUT/);
      expect(Value.Check(JobsParamsSchema, value)).toBe(false);
    }
  });

  it("rejects list operation phase, offset, limit, and unknown fields", () => {
    const invalid = [
      { operation: "list", operation_phase: "unknown" },
      { operation: "list", offset: -1 },
      { operation: "list", offset: 1.5 },
      { operation: "list", limit: 0 },
      { operation: "list", limit: 101 },
      { operation: "list", limit: 1.5 },
      { operation: "list", extra: true },
    ];
    for (const value of invalid) {
      expect(() => validateJobsParams(value)).toThrowError(/INVALID_INPUT/);
      expect(Value.Check(JobsParamsSchema, value)).toBe(false);
    }
  });

  it("rejects missing, malformed, and operation-specific unknown job fields", () => {
    const invalid = [
      { operation: "get" },
      { operation: "cancel" },
      { operation: "get", jobId: "bad" },
      { operation: "get", jobId: "job_" },
      { operation: "cancel", jobId: "job_\u0000bad" },
      { operation: "cancel", jobId: "job_bad\rvalue" },
      { operation: "get", jobId: "job_bad\nvalue" },
      { operation: "get", jobId: "job_good", extra: true },
      { operation: "cancel", jobId: "job_good", operation_phase: "running" },
    ];
    for (const value of invalid) {
      expect(() => validateJobsParams(value)).toThrowError(/INVALID_INPUT/);
      expect(Value.Check(JobsParamsSchema, value)).toBe(false);
    }
    expect(() => validateJobsParams({ operation: "get", jobId: null })).toThrowError(/jobId/);
    expect(() => validateJobsParams({ operation: "cancel", jobId: 1 })).toThrowError(/jobId/);
  });
});
