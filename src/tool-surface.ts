import type { AgentToolResult, ExtensionContext, ToolExecutionMode } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { HerdrCli } from "./cli.js";
import type { DevinQueueFlush } from "./messages/devin-queue-flush.js";
import { preflightCompatibility, type CompatibilityPreflight, type HealthCli } from "./health.js";
import type { JobRegistry } from "./job-registry.js";
import type { RecipientRegistry } from "./messages/recipients.js";
import type { AttachmentStore } from "./messages/store.js";
import type { RuntimeOwnership } from "./ownership.js";
import type { ProfileCatalog } from "./profiles/types.js";
import type { WaitReviewer } from "./reviewer.js";
import type { Settings } from "./settings.js";
import type { SupervisionCoordinator } from "./supervision/registry.js";
import type { SelfCloseTracker } from "./supervision/self-close.js";
import type { CurrentContext } from "./targets.js";
import { createContextResolver, type ContextResolver } from "./context.js";
import { createCommunicateTool } from "./tools/communicate.js";
import { createInspectTool } from "./tools/inspect.js";
import { createJobsTool } from "./tools/jobs.js";
import { createLaunchTool } from "./tools/launch.js";
import { createPaneTool } from "./tools/pane.js";
import { createTabTool } from "./tools/tab.js";
import { createWaitTool } from "./tools/wait.js";

export const CORE_TOOL_NAMES = [
  "herdr_inspect",
  "herdr_communicate",
  "herdr_wait",
  "herdr_jobs",
  "herdr_launch",
  "herdr_pane",
  "herdr_tab",
] as const;

export type CoreToolName = (typeof CORE_TOOL_NAMES)[number];

export interface InjectedContextState {
  context: CurrentContext;
  idsPresent: boolean;
  idsValid: boolean;
}

export interface EnvironmentState {
  enabled: boolean;
  currentIdsPresent: boolean;
  currentIdsValid: boolean;
}

function injectedId(value: string | undefined): { value?: string; valid: boolean } {
  if (value === undefined) return { valid: true };
  if (value.length === 0 || value.includes(String.fromCharCode(0)) || value.includes("\r") || value.includes("\n")) return { valid: false };
  return { value, valid: true };
}

/** Read the authoritative Herdr identity injected into every host process. */
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

/** Herdr CLI compatibility stays a per-call preflight for every host. */
export function createPreflight(cli: HealthCli): CompatibilityPreflight {
  return (signal, requirement) => preflightCompatibility(cli, signal, requirement).then(() => undefined);
}

/**
 * The host-agnostic view of one shared tool. Both hosts construct the exact
 * same definitions; only this narrow projection is used by the MCP adapter.
 */
export interface HerdrToolDefinition {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: TSchema;
  /**
   * The Pi scheduling contract the mutating tools declare. Both hosts must
   * honor it, so it is part of the host-agnostic projection rather than a
   * Pi-registration detail.
   */
  readonly executionMode?: ToolExecutionMode;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext
  ): Promise<AgentToolResult<unknown>>;
}

export interface HerdrToolSurfaceDependencies {
  cli: HerdrCli;
  context: CurrentContext;
  contextResolver?: ContextResolver;
  environment: EnvironmentState;
  preflight: CompatibilityPreflight;
  settingsLoader: () => Promise<Settings>;
  jobs: JobRegistry;
  profiles: { load: () => Promise<ProfileCatalog> };
  ownership: RuntimeOwnership;
  cwd: string;
  reviewerFactory?: (settings: Settings, context: ExtensionContext) => WaitReviewer;
  /**
   * Large-message delivery is owned by the tools, so a host that cannot own an
   * attachment cache simply omits these and every attachment delivery is
   * refused as unverified rather than degraded to an inline send.
   */
  attachments?: AttachmentStore;
  recipients?: RecipientRegistry;
  /**
   * The host's shared Devin queue-flush coordinator. Communicate and launch
   * pass Devin text writes through its short write section, and an
   * acknowledged busy Devin write schedules the bounded flush.
   */
  queueFlush?: DevinQueueFlush;
  /**
   * Required. Every successful `herdr_launch` creates supervision, so a host
   * that cannot supervise cannot construct a launch tool. See ADR-019.
   */
  supervision: SupervisionCoordinator;
  /**
   * The host's own-close ledger, shared with the supervision registry. A host
   * that omits it keeps the always-wake behavior for `pane_closed`.
   */
  selfClose?: SelfCloseTracker;
}

export interface HerdrToolSurface {
  readonly inspect: ReturnType<typeof createInspectTool>;
  readonly communicate: ReturnType<typeof createCommunicateTool>;
  readonly wait: ReturnType<typeof createWaitTool>;
  readonly jobs: ReturnType<typeof createJobsTool>;
  readonly launch: ReturnType<typeof createLaunchTool>;
  readonly pane: ReturnType<typeof createPaneTool>;
  readonly tab: ReturnType<typeof createTabTool>;
  /** The same seven definitions, in `CORE_TOOL_NAMES` order. */
  readonly definitions: readonly HerdrToolDefinition[];
}

/** Construct the seven Herdr tools once for every host. */
export function createToolSurface(deps: HerdrToolSurfaceDependencies): HerdrToolSurface {
  const contextResolver = deps.contextResolver ?? createContextResolver(deps.cli, deps.context);
  const inspect = createInspectTool({ cli: deps.cli, context: deps.context, contextResolver, environment: deps.environment, profiles: deps.profiles });
  const communicate = createCommunicateTool({
    cli: deps.cli,
    context: deps.context,
    contextResolver,
    preflight: deps.preflight,
    queueFlush: deps.queueFlush,
    ...(deps.attachments ? { attachments: deps.attachments } : {}),
    ...(deps.recipients ? { recipients: deps.recipients } : {}),
  });
  const wait = createWaitTool({
    cli: deps.cli,
    context: deps.context,
    contextResolver,
    settingsLoader: deps.settingsLoader,
    jobRegistry: deps.jobs,
    ...(deps.reviewerFactory ? { reviewerFactory: deps.reviewerFactory } : {}),
  });
  const jobs = createJobsTool(deps.jobs);
  const launch = createLaunchTool({
    cli: deps.cli,
    context: deps.context,
    contextResolver,
    cwd: deps.cwd,
    ownership: deps.ownership,
    profiles: deps.profiles,
    preflight: deps.preflight,
    supervision: deps.supervision,
    queueFlush: deps.queueFlush,
    ...(deps.attachments ? { attachments: deps.attachments } : {}),
    ...(deps.recipients ? { recipients: deps.recipients } : {}),
  });
  const pane = createPaneTool({
    cli: deps.cli,
    context: deps.context,
    contextResolver,
    cwd: deps.cwd,
    ownership: deps.ownership,
    preflight: deps.preflight,
    ...(deps.selfClose ? { selfClose: deps.selfClose } : {}),
  });
  const tab = createTabTool({
    cli: deps.cli,
    context: deps.context,
    contextResolver,
    cwd: deps.cwd,
    ownership: deps.ownership,
    preflight: deps.preflight,
  });
  return {
    inspect,
    communicate,
    wait,
    jobs,
    launch,
    pane,
    tab,
    definitions: [inspect, communicate, wait, jobs, launch, pane, tab],
  };
}
