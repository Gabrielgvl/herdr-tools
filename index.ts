import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HerdrCli } from "./src/cli.js";
import { createAgentPromptClient, type AgentPromptClient } from "./src/agent-prompt.js";
import { createPreflight, createToolSurface, readInjectedContext } from "./src/tool-surface.js";
import { createDevinQueueFlush, type DevinQueueFlush } from "./src/messages/devin-queue-flush.js";
import { createPaneWriteGuard, resolvePaneWriteNamespace } from "./src/pane-write-lock.js";
import { defaultAttachmentStore, type AttachmentStore } from "./src/messages/store.js";
import { RecipientRegistry } from "./src/messages/recipients.js";
import { JobRegistry } from "./src/job-registry.js";
import { notificationForJob } from "./src/job-notification.js";
import { createCliTranscriptReader, SupervisionRegistry } from "./src/supervision/registry.js";
import { createHandoffGate, type HandoffGate } from "./src/handoff-gate.js";
import { createPiSupervisionNotifier } from "./src/supervision/notify.js";
import { WaitJobsUi } from "./src/wait-jobs-ui.js";
import { RuntimeOwnership, resetOwnership, type OwnedResource } from "./src/ownership.js";
import { loadSettings, type Settings } from "./src/settings.js";
import type { CurrentContext } from "./src/targets.js";
import type { ProfileCatalog } from "./src/profiles/types.js";
import { discoverProfiles } from "./src/profiles/discovery.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export { CORE_TOOL_NAMES, createPreflight, readInjectedContext, type InjectedContextState } from "./src/tool-surface.js";
export { notificationForJob };

export interface CreatedResourceRegistry {
  record(resource: OwnedResource): void;
}

export interface ExtensionRuntime {
  cli: HerdrCli;
  context: CurrentContext;
  ownership: RuntimeOwnership;
  jobs: JobRegistry;
  supervision: SupervisionRegistry;
  /** The host's shared managed-handoff gate: one registry for launch binding and wait gating. */
  handoffs: HandoffGate;
  waitJobsUi: WaitJobsUi;
  attachments: AttachmentStore;
  recipients: RecipientRegistry;
  /**
   * The Pi host's shared Devin queue-flush coordinator. `session_start` arms a
   * fresh controller and `session_shutdown` aborts the old one, so pending
   * cycles from a dead session can never dispatch.
   */
  queueFlush: DevinQueueFlush;
  settings: { load: () => Promise<Settings> };
  profiles: { load: () => Promise<ProfileCatalog> };
  idsPresent: boolean;
  idsValid: boolean;
}

export interface RuntimeOptions {
  promptClient?: AgentPromptClient;
  attachments?: AttachmentStore;
  recipients?: RecipientRegistry;
}

export function createRuntime(pi: Pick<ExtensionAPI, "exec"> & Partial<Pick<ExtensionAPI, "sendMessage">>, env: NodeJS.ProcessEnv = process.env, options: RuntimeOptions = {}): ExtensionRuntime {
  const injected = readInjectedContext(env);
  const uiRef: { current?: WaitJobsUi } = {};
  const jobs = new JobRegistry({
    onChange: () => uiRef.current?.refresh(),
    onTerminal: (detail) => {
      if (!pi.sendMessage || detail.kind !== "wait") return;
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
  const cli = new HerdrCli(pi.exec.bind(pi), 10_000, 50_000, options.promptClient ?? createAgentPromptClient({ env }));
  // The coordinator's namespace resolves lazily on first use, so constructing
  // the runtime still performs no filesystem or Herdr calls.
  const queueFlush = createDevinQueueFlush({ cli, guard: createPaneWriteGuard({ namespace: resolvePaneWriteNamespace.bind(null, env) }) });
  queueFlush.begin();
  const handoffs = createHandoffGate();
  const supervision = new SupervisionRegistry({
    jobs,
    settingsLoader: () => loadSettings(),
    readTranscript: createCliTranscriptReader(cli),
    ...(pi.sendMessage ? { notifier: createPiSupervisionNotifier((message, deliveryOptions) => pi.sendMessage!(message, deliveryOptions)) } : {}),
    monitorOptions: { env },
    handoffs,
    repairPrompt: (paneId, text, signal) => cli.prompt(paneId, text, signal),
  });
  return {
    cli,
    context: injected.context,
    ownership: new RuntimeOwnership(),
    jobs,
    supervision,
    handoffs,
    waitJobsUi,
    attachments: options.attachments ?? defaultAttachmentStore,
    recipients: options.recipients ?? new RecipientRegistry(),
    queueFlush,
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
    // Abort pending flush cycles before the prompt transport closes: no new
    // operation may be dispatched into a closed session.
    await runtime.queueFlush.shutdown();
    runtime.cli.closePromptTransport();
    await runtime.supervision.shutdown();
    runtime.jobs.shutdown();
    runtime.recipients.reset();
    resetOwnership(runtime.ownership);
  });
  pi.on("session_start", async (_event, context) => {
    // A fresh controller per session: cycles a dead session left pending keep
    // their aborted signal and can never revive under the new one.
    runtime.queueFlush.begin();
    // Supervision is session-scoped: the previous session's supervisors and
    // event connection are stopped and a fresh monitor replaces them, so a
    // session that follows a shutdown can still launch.
    await runtime.supervision.beginSession();
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
    supervision: runtime.supervision,
    handoffs: runtime.handoffs,
    queueFlush: runtime.queueFlush,
  });
  pi.registerTool(surface.inspect);
  pi.registerTool(surface.communicate);
  pi.registerTool(surface.wait);
  pi.registerTool(surface.jobs);
  pi.registerTool(surface.launch);
  pi.registerTool(surface.pane);
  pi.registerTool(surface.tab);
}
