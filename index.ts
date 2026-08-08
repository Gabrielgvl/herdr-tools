import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HerdrCli } from "./src/cli.js";
import { createCommunicateTool } from "./src/tools/communicate.js";
import { createInspectTool } from "./src/tools/inspect.js";
import { createJobsTool } from "./src/tools/jobs.js";
import { createLaunchTool } from "./src/tools/launch.js";
import { createPaneTool } from "./src/tools/pane.js";
import { createTabTool } from "./src/tools/tab.js";
import { createWaitTool } from "./src/tools/wait.js";
import { boundedText, JobRegistry, type JobDetail } from "./src/job-registry.js";
import { RuntimeOwnership, resetOwnership, type OwnedResource } from "./src/ownership.js";
import { loadSettings, type Settings } from "./src/settings.js";
import type { CurrentContext } from "./src/targets.js";
import type { ProfileCatalog } from "./src/profiles/types.js";
import { discoverProfiles } from "./src/profiles/discovery.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CORE_TOOL_NAMES = [
  "herdr_inspect",
  "herdr_communicate",
  "herdr_wait",
  "herdr_jobs",
  "herdr_launch",
  "herdr_pane",
  "herdr_tab",
] as const;

export interface InjectedContextState {
  context: CurrentContext;
  idsPresent: boolean;
  idsValid: boolean;
}

export interface CreatedResourceRegistry {
  record(resource: OwnedResource): void;
}

export interface ExtensionRuntime {
  cli: HerdrCli;
  context: CurrentContext;
  ownership: RuntimeOwnership;
  jobs: JobRegistry;
  settings: { load: () => Promise<Settings> };
  profiles: { load: () => Promise<ProfileCatalog> };
  idsPresent: boolean;
  idsValid: boolean;
}

function injectedId(value: string | undefined): { value?: string; valid: boolean } {
  if (value === undefined) return { valid: true };
  if (value.length === 0 || value.includes(String.fromCharCode(0)) || value.includes("\r") || value.includes("\n")) return { valid: false };
  return { value, valid: true };
}

export function readInjectedContext(env: NodeJS.ProcessEnv = process.env): InjectedContextState {
  const workspace = injectedId(env.HERDR_WORKSPACE_ID);
  const tab = injectedId(env.HERDR_TAB_ID);
  const pane = injectedId(env.HERDR_PANE_ID);
  const values = [workspace.value, tab.value, pane.value];
  const idsPresent = values.every((value) => value !== undefined);
  const idsValid = workspace.valid && tab.valid && pane.valid && (values.every((value) => value === undefined) || idsPresent);
  return {
    context: {
      ...(workspace.value ? { workspaceId: workspace.value } : {}),
      ...(tab.value ? { tabId: tab.value } : {}),
      ...(pane.value ? { paneId: pane.value } : {}),
    },
    idsPresent,
    idsValid,
  };
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
  const content = `${prefix}Herdr wait job ${safeNotificationPart(detail.jobId)} finished: outcome=${safeNotificationPart(status)}, reason=${safeNotificationPart(reason)}, matchedTargets=${safeNotificationPart(matchedTargets || "none", 2_000)}${matchedSuffix}, requestedTargets=${safeNotificationPart(requestedTargets, 2_000)}${error ? `, error=${safeNotificationPart(error)}` : ""}${reviewer ? `, reviewer=${safeNotificationPart(reviewer, 2_000)}` : ""}`;
  const requestedIds = detail.request.targetIds.slice(0, 16).map((targetId) => safeNotificationPart(targetId, 256));
  const requestedOmitted = Math.max(detail.truncation?.requestTargetIds ?? 0, detail.request.targetIds.length - requestedIds.length);
  return {
    content: boundedText(content, 8_000),
    details: {
      jobId: safeNotificationPart(detail.jobId, 256),
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

export function createRuntime(pi: Pick<ExtensionAPI, "exec"> & Partial<Pick<ExtensionAPI, "sendMessage">>, env: NodeJS.ProcessEnv = process.env): ExtensionRuntime {
  const injected = readInjectedContext(env);
  const jobs = new JobRegistry({
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
  return {
    cli: new HerdrCli(pi.exec.bind(pi)),
    context: injected.context,
    ownership: new RuntimeOwnership(),
    jobs,
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
    runtime.jobs.shutdown();
    resetOwnership(runtime.ownership);
  });
  pi.on("session_start", async () => {
    runtime.jobs.beginSession();
    resetOwnership(runtime.ownership);
  });

  pi.registerTool(createInspectTool({ cli: runtime.cli, context: runtime.context, environment, profiles: runtime.profiles }));
  pi.registerTool(createCommunicateTool({ cli: runtime.cli, context: runtime.context }));
  pi.registerTool(createWaitTool({
    cli: runtime.cli,
    context: runtime.context,
    settingsLoader: runtime.settings.load,
    jobRegistry: runtime.jobs,
  }));
  pi.registerTool(createJobsTool(runtime.jobs));
  pi.registerTool(createLaunchTool({
    cli: runtime.cli,
    context: runtime.context,
    cwd: process.cwd(),
    ownership: runtime.ownership,
    profiles: runtime.profiles,
  }));
  pi.registerTool(createPaneTool({
    cli: runtime.cli,
    context: runtime.context,
    cwd: process.cwd(),
    ownership: runtime.ownership,
  }));
  pi.registerTool(createTabTool({
    cli: runtime.cli,
    context: runtime.context,
    cwd: process.cwd(),
    ownership: runtime.ownership,
  }));
}
