import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HerdrCli } from "./src/cli.js";
import { createPreflight, createToolSurface, readInjectedContext } from "./src/tool-surface.js";
import type { StdinExec } from "./src/exec-stdin.js";
import { defaultAttachmentStore, type AttachmentStore } from "./src/messages/store.js";
import { RecipientRegistry } from "./src/messages/recipients.js";
import { boundedText, JobRegistry, type JobDetail } from "./src/job-registry.js";
import { WaitJobsUi } from "./src/wait-jobs-ui.js";
import { WAIT_LABEL_MAX_BYTES } from "./src/wait-schema.js";
import { RuntimeOwnership, resetOwnership, type OwnedResource } from "./src/ownership.js";
import { loadSettings, type Settings } from "./src/settings.js";
import type { CurrentContext } from "./src/targets.js";
import type { ProfileCatalog } from "./src/profiles/types.js";
import { discoverProfiles } from "./src/profiles/discovery.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export { CORE_TOOL_NAMES, createPreflight, readInjectedContext, type InjectedContextState } from "./src/tool-surface.js";

export interface CreatedResourceRegistry {
  record(resource: OwnedResource): void;
}

export interface ExtensionRuntime {
  cli: HerdrCli;
  context: CurrentContext;
  ownership: RuntimeOwnership;
  jobs: JobRegistry;
  waitJobsUi: WaitJobsUi;
  attachments: AttachmentStore;
  recipients: RecipientRegistry;
  settings: { load: () => Promise<Settings> };
  profiles: { load: () => Promise<ProfileCatalog> };
  idsPresent: boolean;
  idsValid: boolean;
}

function safeNotificationPart(value: unknown, limit = 500): string {
  const text = typeof value === "string" ? value : String(value);
  const safe = [...text].map((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? " " : character;
  }).join("");
  return boundedText(safe, limit);
}

export function notificationForJob(detail: JobDetail): { content: string; details: Record<string, unknown> } {
  const manager = detail.outcome === "manager_judgment_required";
  const success = detail.status === "completed" && detail.outcome === "success";
  const status = detail.status === "completed" ? detail.outcome ?? "completed" : detail.status;
  const reason = detail.result?.reason ?? detail.cancelReason ?? detail.error?.code ?? detail.error?.message ?? "completed";
  const requestedTargets = detail.request.targets.map((target, index) => `${safeNotificationPart(target)} (${safeNotificationPart(detail.request.targetIds[index] ?? "unknown")})`).join(", ");
  const matchedRefs = success ? detail.result?.matchedTargets ?? detail.result?.targets?.filter((target) => target.matched).map((target) => ({ target: target.target, targetId: target.targetId })) ?? [] : [];
  const matchedCount = success ? detail.result?.matchedTargetCount ?? matchedRefs.length : 0;
  const matchedOmitted = success ? Math.max(detail.truncation?.resultMatchedTargets ?? 0, matchedCount - matchedRefs.length) : 0;
  const matchedTargets = matchedRefs.map((target) => `${safeNotificationPart(target.target)} (${safeNotificationPart(target.targetId)})`).join(", ");
  const matchedSuffix = matchedOmitted > 0 ? `; matchedTargetsOmitted=${matchedOmitted}` : "";
  const reviewer = detail.result?.reviewerSummaries?.map((summary) => `${safeNotificationPart(summary.targetId)}: ${safeNotificationPart(summary.summary)}`).join("; ");
  const error = detail.error ? `${safeNotificationPart(detail.error.code ?? "error")}: ${safeNotificationPart(detail.error.message)}` : undefined;
  const prefix = manager ? "HIGH PRIORITY: MANAGER JUDGMENT REQUIRED\n" : "";
  const content = `${prefix}Herdr wait job ${safeNotificationPart(detail.jobId)} (${safeNotificationPart(detail.request.label, WAIT_LABEL_MAX_BYTES)}) reported: action=wait, outcome=${safeNotificationPart(status)}, reason=${safeNotificationPart(reason)} (wait condition only; target lifecycle unchanged), matchedTargets=${safeNotificationPart(matchedTargets || "none", 2_000)}${matchedSuffix}, requestedTargets=${safeNotificationPart(requestedTargets, 2_000)}${error ? `, error=${safeNotificationPart(error)}` : ""}${reviewer ? `, reviewer=${safeNotificationPart(reviewer, 2_000)}` : ""}`;
  const requestedIds = detail.request.targetIds.slice(0, 16).map((targetId) => safeNotificationPart(targetId, 256));
  const requestedOmitted = Math.max(detail.truncation?.requestTargetIds ?? 0, detail.request.targetIds.length - requestedIds.length);
  return {
    content: boundedText(content, 8_000),
    details: {
      jobId: safeNotificationPart(detail.jobId, 256),
      label: safeNotificationPart(detail.request.label, WAIT_LABEL_MAX_BYTES),
      action: "wait",
      outcome: status,
      reason: safeNotificationPart(reason),
      targets: matchedRefs.slice(0, 16).map((target) => safeNotificationPart(target.targetId, 256)),
      matchedTargets: matchedRefs.slice(0, 16).map((target) => safeNotificationPart(target.targetId, 256)),
      matchedTargetCount: matchedCount,
      ...(matchedOmitted > 0 ? { matchedTargetsOmitted: matchedOmitted } : {}),
      requestedTargets: requestedIds,
      ...(requestedOmitted > 0 ? { requestedTargetsOmitted: requestedOmitted } : {}),
      priority: manager ? "high" : "normal"
    }
  };
}

export interface RuntimeOptions {
  stdinExecutor?: StdinExec;
  attachments?: AttachmentStore;
  recipients?: RecipientRegistry;
}

export function createRuntime(pi: Pick<ExtensionAPI, "exec"> & Partial<Pick<ExtensionAPI, "sendMessage">> & { execStdin?: StdinExec }, env: NodeJS.ProcessEnv = process.env, options: RuntimeOptions = {}): ExtensionRuntime {
  const injected = readInjectedContext(env);
  const uiRef: { current?: WaitJobsUi } = {};
  const jobs = new JobRegistry({
    onChange: () => uiRef.current?.refresh(),
    onTerminal: (detail) => {
      if (!pi.sendMessage) return;
      const notification = notificationForJob(detail);
      try {
        void Promise.resolve(pi.sendMessage({ customType: "herdr-wait-job", content: notification.content, display: true, details: notification.details }, { deliverAs: "steer", triggerTurn: true })).catch(() => undefined);
      } catch {
        // Pi may be shutting down; notification is best effort.
      }
    }
  });
  const waitJobsUi = new WaitJobsUi(jobs);
  uiRef.current = waitJobsUi;
  return {
    cli: new HerdrCli(pi.exec.bind(pi), 10_000, 50_000, options.stdinExecutor ?? pi.execStdin),
    context: injected.context,
    ownership: new RuntimeOwnership(),
    jobs,
    waitJobsUi,
    attachments: options.attachments ?? defaultAttachmentStore,
    recipients: options.recipients ?? new RecipientRegistry(),
    settings: { load: () => loadSettings() },
    profiles: { load: () => discoverProfiles({ bundledDir: resolve(dirname(fileURLToPath(import.meta.url)), "herdr-profiles"), bundledScopeRoot: dirname(fileURLToPath(import.meta.url)), projectCwd: process.cwd() }) },
    idsPresent: injected.idsPresent,
    idsValid: injected.idsValid,
  };
}

export default function herdrToolsExtension(pi: ExtensionAPI): void {
  if (process.env.HERDR_ENV !== "1") return;

  const runtime = createRuntime(pi);
  const environment = {
    enabled: true,
    currentIdsPresent: runtime.idsPresent,
    currentIdsValid: runtime.idsValid,
  };

  pi.on("session_shutdown", async () => {
    runtime.waitJobsUi.endSession();
    runtime.jobs.shutdown();
    runtime.recipients.reset();
    resetOwnership(runtime.ownership);
  });
  pi.on("session_start", async (_event, context) => {
    runtime.jobs.beginSession();
    runtime.waitJobsUi.beginSession(context);
    runtime.recipients.reset();
    resetOwnership(runtime.ownership);
  });

  pi.registerCommand("herdr-waits", {
    description: "Toggle the active Herdr wait-job list",
    handler: async (_args, context) => {
      const visible = runtime.waitJobsUi.toggle(context);
      context.ui.notify(`Herdr active waits ${visible ? "shown" : "hidden"}`, "info");
    }
  });

  const surface = createToolSurface({
    cli: runtime.cli,
    context: runtime.context,
    environment,
    preflight: createPreflight(runtime.cli),
    settingsLoader: runtime.settings.load,
    jobs: runtime.jobs,
    profiles: runtime.profiles,
    ownership: runtime.ownership,
    cwd: process.cwd(),
    attachments: runtime.attachments,
    recipients: runtime.recipients,
  });
  pi.registerTool(surface.inspect);
  pi.registerTool(surface.communicate);
  pi.registerTool(surface.wait);
  pi.registerTool(surface.jobs);
  pi.registerTool(surface.launch);
  pi.registerTool(surface.pane);
  pi.registerTool(surface.tab);
}
