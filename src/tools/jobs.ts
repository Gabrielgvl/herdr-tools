import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { JobsParamsSchema, validateJobsParams, type JobsParams } from "../jobs-schema.js";
import { jobDetailContent, JOB_OUTPUT_LIMITS, type JobDetail, type JobListResult, type JobRegistry } from "../job-registry.js";
import { formatCall, textComponent } from "../tui.js";
import { truncateTail } from "@earendil-works/pi-coding-agent";

export type JobsDetails =
  | ({ operation: "jobs"; kind: "list" } & JobListResult)
  | ({ operation: "jobs"; kind: "job" } & JobDetail);

export class JobsError extends Error {
  constructor(readonly code: "INVALID_INPUT" | "JOB_NOT_FOUND", message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "JobsError";
  }
}

function boundedContent(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2);
  const bounded = truncateTail(serialized, { maxBytes: JOB_OUTPUT_LIMITS.maxBytes, maxLines: JOB_OUTPUT_LIMITS.maxLines });
  return bounded.truncated ? `${bounded.content}\n[output truncated]` : bounded.content;
}

function detailContent(detail: JobDetail): string {
  return jobDetailContent(detail);
}

export function createJobsTool(registry: JobRegistry): ToolDefinition<typeof JobsParamsSchema, JobsDetails> {
  return {
    name: "herdr_jobs",
    label: "Herdr Jobs",
    description: "List, inspect, or cancel detached Herdr wait jobs owned by this Pi session.",
    parameters: JobsParamsSchema,
    async execute(_id, rawParams) {
      let params: JobsParams;
      try {
        params = validateJobsParams(rawParams);
      } catch (error) {
        throw new JobsError("INVALID_INPUT", error instanceof Error ? error.message : String(error));
      }
      if (params.operation === "list") {
        const page = registry.list(params.status, params.offset ?? 0, params.limit ?? 20);
        return {
          content: [{ type: "text", text: `jobs · ${page.jobs.length}/${page.total}` }],
          details: { operation: "jobs", kind: "list", ...page }
        };
      }
      const job = registry.get(params.jobId);
      if (!job) throw new JobsError("JOB_NOT_FOUND", `JOB_NOT_FOUND: unknown Herdr job ${params.jobId}`, { jobId: params.jobId });
      if (params.operation === "cancel") {
        const cancelled = registry.cancel(params.jobId);
        if (!cancelled) throw new JobsError("JOB_NOT_FOUND", `JOB_NOT_FOUND: unknown Herdr job ${params.jobId}`, { jobId: params.jobId });
        return {
          content: [{ type: "text", text: `job ${cancelled.jobId} · ${cancelled.status}` }],
          details: { operation: "jobs", kind: "job", ...cancelled }
        };
      }
      return {
        content: [{ type: "text", text: `job ${job.jobId} · ${job.status}` }],
        details: { operation: "jobs", kind: "job", ...job }
      };
    },
    renderCall(rawArgs, theme) {
      const args = rawArgs as JobsParams;
      return textComponent(formatCall("herdr_jobs", args.operation ?? "jobs", "jobId" in args ? args.jobId : undefined), theme, "accent");
    },
    renderResult(result, options, theme) {
      if (options.isPartial) return textComponent("partial · jobs", theme, "warning");
      if ((result as unknown as { isError?: boolean }).isError) {
        const details = result.details as unknown as { code?: unknown } | undefined;
        const code = typeof details?.code === "string" ? details.code : "UNKNOWN";
        return textComponent(`error ${code}`, theme, "error");
      }
      const details = result.details as JobsDetails | undefined;
      if (!details || details.operation !== "jobs") return textComponent("error UNKNOWN", theme, "error");
      if (details.kind === "list") return textComponent(`jobs · ${details.jobs.length}/${details.total}`, theme, "success");
      return textComponent(`job · ${details.status}`, theme, details.status === "failed" ? "error" : details.status === "cancelled" ? "warning" : "success");
    }
  };
}

export { detailContent, boundedContent };
