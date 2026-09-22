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
import type { HandoffGate } from "./handoff-gate.js";
import type { CurrentContext } from "./targets.js";
import { createContextResolver, type ContextResolver } from "./context.js";
import { createCommunicateTool } from "./tools/communicate.js";
import { createInspectTool } from "./tools/inspect.js";
import { createJobsTool } from "./tools/jobs.js";
import { createLaunchTool } from "./tools/launch.js";
import { createPaneTool } from "./tools/pane.js";
import { createTabTool } from "./tools/tab.js";
import { createWaitTool } from "./tools/wait.js";
import { CommunicateParamsSchema, InspectParamsSchema } from "./schemas.js";
import { JobsParamsSchema } from "./jobs-schema.js";
import { PublishedLaunchParamsSchema } from "./launch-schema.js";
import { PaneParamsSchema, TabParamsSchema } from "./topology-schema.js";
import { WaitParamsSchema } from "./wait-schema.js";
import { appendToolTelemetry, invalidInputError, monotonicDurationMs, telemetryEffectCertainty, telemetryOperation, type ToolTelemetryEntry } from "./telemetry.js";

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
  /** The strict runtime schema when `parameters` is the host-compatible flat projection. */
  readonly validationSchema?: TSchema;
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
  /**
   * The host's shared managed-handoff gate. Launch bindings and strict waits
   * consult the same instance so managed completion is never read off raw
   * lifecycle alone.
   */
  handoffs?: HandoffGate;
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

function telemetryEntry(
  tool: string,
  operation: string,
  validate: ToolTelemetryEntry["phases"]["validate"],
  execute: ToolTelemetryEntry["phases"]["execute"],
  startedAt: number,
  effectCertainty: ToolTelemetryEntry["effectCertainty"],
): ToolTelemetryEntry {
  return { tool, operation, phases: { validate, execute, persist: "success" }, durationMs: monotonicDurationMs(startedAt), effectCertainty };
}

function instrumentTool<T extends HerdrToolDefinition>(tool: T, validationSchema: TSchema, root: string): T {
  const execute = tool.execute.bind(tool);
  return {
    ...tool,
    validationSchema,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const startedAt = performance.now();
      const invalid = invalidInputError(tool.name, validationSchema, params);
      if (invalid !== undefined) {
        await appendToolTelemetry(telemetryEntry(tool.name, telemetryOperation(tool.name, params, false), "failure", "skipped", startedAt, "absent"), { root });
        throw invalid;
      }
      const operation = telemetryOperation(tool.name, params, true);
      try {
        const result = await execute(toolCallId, params, signal, onUpdate, ctx);
        await appendToolTelemetry(telemetryEntry(tool.name, operation, "success", "success", startedAt, telemetryEffectCertainty(result, "confirmed")), { root });
        return result;
      } catch (error) {
        await appendToolTelemetry(telemetryEntry(tool.name, operation, "success", "failure", startedAt, telemetryEffectCertainty(error, "unknown")), { root });
        throw error;
      }
    },
  } as T;
}

/** Construct the seven Herdr tools once for every host. */
export function createToolSurface(deps: HerdrToolSurfaceDependencies): HerdrToolSurface {
  const contextResolver = deps.contextResolver ?? createContextResolver(deps.cli, deps.context);
  const inspect = instrumentTool(createInspectTool({ cli: deps.cli, context: deps.context, contextResolver, environment: deps.environment, profiles: deps.profiles, ...(deps.handoffs ? { handoffs: deps.handoffs } : {}) }), InspectParamsSchema, deps.cwd);
  const communicate = instrumentTool(createCommunicateTool({
    cli: deps.cli,
    context: deps.context,
    contextResolver,
    preflight: deps.preflight,
    queueFlush: deps.queueFlush,
    ...(deps.attachments ? { attachments: deps.attachments } : {}),
    ...(deps.recipients ? { recipients: deps.recipients } : {}),
  }), CommunicateParamsSchema, deps.cwd);
  const wait = instrumentTool(createWaitTool({
    cli: deps.cli,
    context: deps.context,
    contextResolver,
    settingsLoader: deps.settingsLoader,
    jobRegistry: deps.jobs,
    ...(deps.reviewerFactory ? { reviewerFactory: deps.reviewerFactory } : {}),
    ...(deps.handoffs ? { handoffs: deps.handoffs } : {}),
  }), WaitParamsSchema, deps.cwd);
  const jobs = instrumentTool(createJobsTool(deps.jobs), JobsParamsSchema, deps.cwd);
  const launch = instrumentTool(createLaunchTool({
    cli: deps.cli,
    context: deps.context,
    contextResolver,
    cwd: deps.cwd,
    ownership: deps.ownership,
    preflight: deps.preflight,
    supervision: deps.supervision,
    selfClose: deps.selfClose,
    queueFlush: deps.queueFlush,
    ...(deps.attachments ? { attachments: deps.attachments } : {}),
    ...(deps.recipients ? { recipients: deps.recipients } : {}),
  }), PublishedLaunchParamsSchema, deps.cwd);
  const pane = instrumentTool(createPaneTool({
    cli: deps.cli,
    context: deps.context,
    contextResolver,
    cwd: deps.cwd,
    ownership: deps.ownership,
    preflight: deps.preflight,
    ...(deps.selfClose ? { selfClose: deps.selfClose } : {}),
  }), PaneParamsSchema, deps.cwd);
  const tab = instrumentTool(createTabTool({
    cli: deps.cli,
    context: deps.context,
    contextResolver,
    cwd: deps.cwd,
    ownership: deps.ownership,
    preflight: deps.preflight,
  }), TabParamsSchema, deps.cwd);
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
