import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { JobsParamsSchema, validateJobsParams, type JobsParams } from "../jobs-schema.js";
import { jobDetailContent, JOB_OUTPUT_LIMITS, type JobDetail, type JobListResult, type JobRegistry } from "../job-registry.js";
import { formatCall, textComponent } from "../tui.js";
import { truncateTail } from "@earendil-works/pi-coding-agent";

const OUTPUT_TRUNCATION_MARKER = "\n[output truncated]";

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
  const bounded = truncateTail(serialized, {
    maxBytes: JOB_OUTPUT_LIMITS.maxBytes - 1 - Buffer.byteLength(OUTPUT_TRUNCATION_MARKER, "utf8"),
    maxLines: JOB_OUTPUT_LIMITS.maxLines
  });
  return bounded.truncated ? `${bounded.content}${OUTPUT_TRUNCATION_MARKER}` : bounded.content;
}

function detailContent(detail: JobDetail): string {
  return jobDetailContent(detail);
}

function resultFor(value: JobsDetails): { content: Array<{ type: "text"; text: string }>; details: JobsDetails } {
  return { content: [{ type: "text", text: boundedContent(value) }], details: value };
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
        const page = registry.list(params.operation_phase, params.offset ?? 0, params.limit ?? 20);
        return resultFor({ operation: "jobs", kind: "list", ...page });
      }
      const job = registry.get(params.jobId);
      if (!job) throw new JobsError("JOB_NOT_FOUND", `JOB_NOT_FOUND: unknown Herdr job ${params.jobId}`, { jobId: params.jobId });
      if (params.operation === "cancel") {
        const cancelled = await registry.cancel(params.jobId);
        if (!cancelled) throw new JobsError("JOB_NOT_FOUND", `JOB_NOT_FOUND: unknown Herdr job ${params.jobId}`, { jobId: params.jobId });
        return resultFor({ operation: "jobs", kind: "job", ...cancelled });
      }
      return resultFor({ operation: "jobs", kind: "job", ...job });
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
      if (details.kind === "list") return textComponent(`jobs · ${details.jobs.length}/${details.total}`, theme, "muted");
      const phase = details.operation_phase;
      const waitResult = details.wait_result;
      const state = phase === "settled" && waitResult ? `settled · ${waitResult}` : phase;
      const tone = waitResult === "failed" ? "error" : waitResult === "manager_judgment_required" || waitResult === "unknown" || waitResult === "cancelled" ? "warning" : "muted";
      return textComponent(`job · ${state}`, theme, tone);
    }
  };
}

export { detailContent, boundedContent };
