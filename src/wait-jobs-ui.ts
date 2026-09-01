import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JobRegistry, RunningJobOverview } from "./job-registry.js";

const STATUS_KEY = "herdr-waits";
const WIDGET_KEY = "herdr-waits";
const MAX_WIDGET_LINES = 10;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export interface WaitJobsUiScheduler {
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface WaitJobsUiOptions {
  now?: () => number;
  scheduler?: WaitJobsUiScheduler;
}

const realScheduler: WaitJobsUiScheduler = {
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
};

export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m${remainingSeconds.toString().padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h${remainingMinutes.toString().padStart(2, "0")}m`;
}

export class WaitJobsUi {
  private readonly now: () => number;
  private readonly scheduler: WaitJobsUiScheduler;
  private context?: ExtensionContext;
  private timer?: unknown;
  private widgetEnabled = false;
  private spinnerIndex = 0;

  constructor(private readonly registry: JobRegistry, options: WaitJobsUiOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.scheduler = options.scheduler ?? realScheduler;
  }

  beginSession(context: ExtensionContext): void {
    this.clearRenderedState();
    this.stopTimer();
    this.context = context;
    this.widgetEnabled = false;
    this.spinnerIndex = 0;
    this.refresh();
  }

  endSession(): void {
    this.clearRenderedState();
    this.stopTimer();
    this.context = undefined;
    this.widgetEnabled = false;
    this.spinnerIndex = 0;
  }

  toggle(context: ExtensionContext): boolean {
    this.context = context;
    this.widgetEnabled = !this.widgetEnabled;
    this.refresh();
    return this.widgetEnabled;
  }

  refresh(): void {
    const context = this.context;
    if (!context?.hasUI) {
      this.stopTimer();
      return;
    }
    const overview = this.registry.runningOverview(MAX_WIDGET_LINES);
    if (overview.total === 0) {
      this.stopTimer();
      this.safeSetStatus(undefined);
      this.safeSetWidget(undefined);
      return;
    }
    this.render(overview);
    this.startTimer();
  }

  private startTimer(): void {
    if (this.timer !== undefined) return;
    this.timer = this.scheduler.setInterval(() => {
      this.spinnerIndex = (this.spinnerIndex + 1) % SPINNER_FRAMES.length;
      this.refresh();
    }, 1_000);
  }

  private stopTimer(): void {
    if (this.timer === undefined) return;
    this.scheduler.clearInterval(this.timer);
    this.timer = undefined;
  }

  private render(overview: RunningJobOverview): void {
    const now = this.now();
    const oldest = formatElapsed(now - overview.oldestStartedAtMs!);
    const spinner = SPINNER_FRAMES[this.spinnerIndex]!;
    const unobserved = overview.jobs.reduce((total, job) => total + (job.unobservedEvents ?? 0), 0);
    this.safeSetStatus(`${spinner} Herdr jobs: ${overview.total} · oldest ${oldest}${unobserved > 0 ? ` · ${unobserved} unobserved` : ""} · /herdr-waits`);
    if (!this.widgetEnabled) {
      this.safeSetWidget(undefined);
      return;
    }
    const visibleJobs = overview.total > overview.jobs.length ? overview.jobs.slice(0, MAX_WIDGET_LINES - 1) : overview.jobs;
    const rows = visibleJobs.map((job) => `${job.kind === "supervisor" ? "supervisor" : "wait"} · ${job.label} · ${formatElapsed(now - (job.startedAtMs ?? job.createdAtMs))}${job.unobservedEvents ? ` · ${job.unobservedEvents} unobserved` : ""} · ${job.jobId}`);
    if (overview.total > visibleJobs.length) rows.push(`… ${overview.total - visibleJobs.length} more active jobs`);
    this.safeSetWidget(rows);
  }

  private clearRenderedState(): void {
    if (!this.context?.hasUI) return;
    this.safeSetStatus(undefined);
    this.safeSetWidget(undefined);
  }

  private safeSetStatus(value: string | undefined): void {
    try {
      this.context?.ui.setStatus(STATUS_KEY, value);
    } catch {
      // UI rendering is best effort and cannot affect job state.
    }
  }

  private safeSetWidget(value: string[] | undefined): void {
    try {
      this.context?.ui.setWidget(WIDGET_KEY, value, { placement: "aboveEditor" });
    } catch {
      // UI rendering is best effort and cannot affect job state.
    }
  }
}
