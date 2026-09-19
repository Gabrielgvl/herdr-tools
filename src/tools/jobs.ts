import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { PublishedJobsParamsSchema, validateJobsParams, type JobsParams } from "../jobs-schema.js";
import { jobDetailContent, JOB_OUTPUT_LIMITS, type JobDetail, type JobListResult, type JobRegistry } from "../job-registry.js";
import { formatCall, textComponent } from "../tui.js";
import { truncateTail } from "@earendil-works/pi-coding-agent";

const OUTPUT_TRUNCATION_MARKER = "\n[output truncated]";

/**
 * `view` rather than `kind`: `kind` now names the job kind on every job detail
 * and summary, so the result's own list/job discriminator needs its own name.
 */
export type JobsDetails =
  | ({ operation: "jobs"; view: "list" } & JobListResult)
  | ({ operation: "jobs"; view: "job" } & JobDetail);

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

export function createJobsTool(registry: JobRegistry): ToolDefinition<typeof PublishedJobsParamsSchema, JobsDetails> {
  return {
    name: "herdr_jobs",
    label: "Herdr Jobs",
    description: "List, inspect, or cancel the detached Herdr jobs this session owns: wait jobs and the supervisor jobs herdr_launch creates for every child. list accepts an optional kind filter and shows unobserved supervision event counts; get returns a supervisor's pending events and marks exactly those observed; cancel is refused for a supervisor whose exact child is still live.",
    parameters: PublishedJobsParamsSchema,
    async execute(_id, rawParams) {
      let params: JobsParams;
      try {
        params = validateJobsParams(rawParams);
      } catch (error) {
        throw new JobsError("INVALID_INPUT", error instanceof Error ? error.message : String(error));
      }
      if (params.operation === "list") {
        const page = registry.list(params.operation_phase, params.offset ?? 0, params.limit ?? 20, params.kind);
        return resultFor({ operation: "jobs", view: "list", ...page });
      }
      if (params.operation === "cancel") {
        if (!registry.get(params.jobId)) throw new JobsError("JOB_NOT_FOUND", `JOB_NOT_FOUND: unknown Herdr job ${params.jobId}`, { jobId: params.jobId });
        // A supervision refusal is a typed model-visible failure, not a job result.
        const cancelled = await registry.cancel(params.jobId);
        if (!cancelled) throw new JobsError("JOB_NOT_FOUND", `JOB_NOT_FOUND: unknown Herdr job ${params.jobId}`, { jobId: params.jobId });
        return resultFor({ operation: "jobs", view: "job", ...cancelled });
      }
      // A `get` is the soft-receipt read: it returns pending supervision events
      // and marks exactly the events it returned.
      const job = registry.get(params.jobId, { observeEvents: true });
      if (!job) throw new JobsError("JOB_NOT_FOUND", `JOB_NOT_FOUND: unknown Herdr job ${params.jobId}`, { jobId: params.jobId });
      return resultFor({ operation: "jobs", view: "job", ...job });
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
      if (details.view === "list") return textComponent(`jobs · ${details.jobs.length}/${details.total}`, theme, "muted");
      const phase = details.operation_phase;
      const outcome = details.wait_result ?? details.supervision_result;
      const state = phase === "settled" && outcome ? `settled · ${outcome}` : phase;
      const unobserved = details.unobservedEvents === undefined || details.unobservedEvents === 0 ? "" : ` · ${details.unobservedEvents} unobserved`;
      const tone = outcome === "failed" ? "error" : outcome === "manager_judgment_required" || outcome === "unknown" || outcome === "cancelled" || outcome === "identity_lost" || outcome === "identity_replaced" ? "warning" : "muted";
      return textComponent(`${details.kind === "supervisor" ? "supervisor" : "job"} · ${state}${unobserved}`, theme, tone);
    }
  };
}

export { detailContent, boundedContent };
