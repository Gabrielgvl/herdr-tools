import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HerdrCli } from "./src/cli.js";
import { type AgentPromptClient } from "./src/agent-prompt.js";
import { type DevinQueueFlush } from "./src/messages/devin-queue-flush.js";
import { type AttachmentStore } from "./src/messages/store.js";
import type { RecipientRegistry } from "./src/messages/recipients.js";
import { JobRegistry } from "./src/job-registry.js";
import { notificationForJob } from "./src/job-notification.js";
import type { SupervisionRegistry } from "./src/supervision/registry.js";
import { type HandoffGate } from "./src/handoff-gate.js";
import { createPiSupervisionNotifier } from "./src/supervision/notify.js";
import { WaitJobsUi } from "./src/wait-jobs-ui.js";
import { type OwnedResource, type RuntimeOwnership } from "./src/ownership.js";
import { createSharedRuntime } from "./src/daemon/runtime.js";
import { readInjectedContext } from "./src/tool-surface.js";
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

/**
 * The shared host assembly plus the Pi-session extras (wait-job UI, terminal
 * notifications, profile discovery) — retained as a construction seam for
 * harnesses and tests that compose `createSharedRuntime` with an injected Pi
 * `exec`. The extension itself never calls this: Pi registers nothing (C7).
 */
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
  // The Pi host's wiring onto the shared assembly: its wait-job UI refresh,
  // terminal notifications, and the Pi wake path.
  const shared = createSharedRuntime({
    exec: pi.exec.bind(pi),
    env,
    ...(options.promptClient === undefined ? {} : { promptClient: options.promptClient }),
    ...(options.attachments === undefined ? {} : { attachments: options.attachments }),
    ...(options.recipients === undefined ? {} : { recipients: options.recipients }),
    wire: () => ({
      jobs: new JobRegistry({
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
      }),
      ...(pi.sendMessage ? { notifier: createPiSupervisionNotifier((message, deliveryOptions) => pi.sendMessage!(message, deliveryOptions)) } : {}),
    }),
  });
  const waitJobsUi = new WaitJobsUi(shared.jobs);
  uiRef.current = waitJobsUi;
  return {
    cli: shared.cli,
    context: injected.context,
    ownership: shared.ownership,
    jobs: shared.jobs,
    supervision: shared.supervision,
    handoffs: shared.handoffs,
    waitJobsUi,
    attachments: shared.attachments,
    recipients: shared.recipients,
    queueFlush: shared.queueFlush,
    settings: { load: () => loadSettings() },
    profiles: { load: () => discoverProfiles({ bundledDir: resolve(dirname(fileURLToPath(import.meta.url)), "herdr-profiles"), bundledScopeRoot: dirname(fileURLToPath(import.meta.url)), projectCwd: process.cwd() }) },
    idsPresent: injected.idsPresent,
    idsValid: injected.idsValid,
  };
}

/**
 * The Pi extension entrypoint (durable-supervisor §10, C7): Pi registers
 * NOTHING — no tools, no commands, no session handlers. The three daemon
 * tools reach Pi through the executor MCP gateway, and the durable daemon
 * owns supervision, mailboxes, and intents, so this host process holds no
 * Herdr state at all.
 */
export default function herdrToolsExtension(): void {}
