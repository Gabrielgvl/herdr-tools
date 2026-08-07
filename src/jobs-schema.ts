import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { Static } from "typebox";
import { JOB_STATUSES } from "./job-registry.js";

const JobId = Type.String({ minLength: 5, pattern: "^job_[^\\u0000\\r\\n]+$" });
const Status = StringEnum(JOB_STATUSES);

export const JobsParamsSchema = Type.Union([
  Type.Object({
    operation: Type.Literal("list"),
    status: Type.Optional(Status),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 }))
  }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("get"), jobId: JobId }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("cancel"), jobId: JobId }, { additionalProperties: false })
]);

export type JobsParams = Static<typeof JobsParamsSchema>;

function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: "INVALID_INPUT" });
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("INVALID_INPUT: jobs input must be an object");
  return value as Record<string, unknown>;
}

function strictKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid("INVALID_INPUT: unknown jobs fields are not allowed");
}

function validJobId(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("job_") && value.length > 4 && !value.includes(String.fromCharCode(0)) && !value.includes("\r") && !value.includes("\n");
}

export function validateJobsParams(value: unknown): JobsParams {
  const input = object(value);
  if (input.operation === "list") {
    strictKeys(input, ["operation", "status", "offset", "limit"]);
    if (input.status !== undefined && !(JOB_STATUSES as readonly string[]).includes(input.status as string)) invalid("INVALID_INPUT: status is invalid");
    if (input.offset !== undefined && (!Number.isInteger(input.offset) || (input.offset as number) < 0)) invalid("INVALID_INPUT: offset must be a non-negative integer");
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 100)) invalid("INVALID_INPUT: limit must be an integer from 1 through 100");
    return input as JobsParams;
  }
  if (input.operation !== "get" && input.operation !== "cancel") invalid("INVALID_INPUT: operation is invalid");
  strictKeys(input, ["operation", "jobId"]);
  if (!validJobId(input.jobId)) invalid("INVALID_INPUT: jobId must be an opaque job identifier");
  return input as JobsParams;
}
