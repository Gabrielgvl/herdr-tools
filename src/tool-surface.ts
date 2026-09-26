import type { AgentToolResult, ExtensionContext, ToolExecutionMode } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { preflightCompatibility, type CompatibilityPreflight, type HealthCli } from "./health.js";
import type { CurrentContext } from "./targets.js";
import type { DaemonClient, DaemonRunInput, DaemonStatusInput } from "./daemon/client.js";
import { DaemonRunParamsSchema, DaemonStatusParamsSchema } from "./daemon/client.js";
import { DaemonLaunchRequestSchema, type DaemonLaunchRequest, type DelegatedCaller } from "./launch-schema.js";
import { appendToolTelemetry, invalidInputError, monotonicDurationMs, telemetryEffectCertainty, telemetryOperation, type ToolTelemetryEntry } from "./telemetry.js";

/**
 * The universal tool surface (durable-supervisor §10): exactly three tools,
 * each a stateless proxy over the daemon socket. `herdr_run` carries every
 * run operation — observe, reconcile, transfer, claim, and the mailbox `ack`
 * — and `herdr_status` is the read-only projection including the mailbox
 * list/read surface. There is no CLI path and no in-process fallback.
 */
export const CORE_TOOL_NAMES = [
  "herdr_launch",
  "herdr_run",
  "herdr_status",
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
  /**
   * The daemon-connect seam: one fresh connected, identity-bound client per
   * tool call. The host owns no supervision, jobs, or mailbox state — the
   * daemon is the serialization boundary — and a missing daemon surfaces as
   * the typed `DaemonCallError`, never an in-process fallback (§10).
   * `caller` is the optional delegated-mode assertion (executor gateway);
   * absent it the implementation claims the environment-injected identity.
   */
  connectDaemon(signal: AbortSignal | undefined, caller?: DelegatedCaller): Promise<DaemonClient>;
  /** The tool-telemetry root — the session's project directory. */
  cwd: string;
}

export interface HerdrToolSurface {
  readonly launch: HerdrToolDefinition;
  readonly run: HerdrToolDefinition;
  readonly status: HerdrToolDefinition;
  /** The same three definitions, in `CORE_TOOL_NAMES` order. */
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

/**
 * One daemon-backed tool definition: validate against the published schema
 * (instrumentation), connect, issue the one typed call, publish the daemon's
 * reply as both the text body and the structured details. An aborted call
 * closes its socket — the caller learns the call did not land, exactly like
 * a transport failure mid-request.
 */
function daemonTool(
  deps: HerdrToolSurfaceDependencies,
  options: {
    name: CoreToolName;
    label: string;
    description: string;
    parameters: TSchema;
    call(client: DaemonClient, params: never): Promise<unknown>;
  },
): HerdrToolDefinition {
  return instrumentTool({
    name: options.name,
    label: options.label,
    description: options.description,
    parameters: options.parameters,
    async execute(_toolCallId, params, signal) {
      // `caller` selects the delegated claim path on executor-gateway serves;
      // validation already ran, so a present value is a {paneId, projectRoot} pair.
      const caller = (params as { caller?: DelegatedCaller }).caller;
      const client = await deps.connectDaemon(signal, caller);
      try {
        signal?.addEventListener("abort", () => client.close(), { once: true });
        const reply = await options.call(client, params as never);
        return { content: [{ type: "text", text: JSON.stringify(reply, null, 2) }], details: reply };
      } finally {
        client.close();
      }
    },
  }, options.parameters, deps.cwd);
}

/**
 * Construct the three daemon-backed tools once for every host. Each call is a
 * fresh daemon connection — the host holds nothing between calls, so a
 * client restart can never strand supervision state on this side.
 */
export function createToolSurface(deps: HerdrToolSurfaceDependencies): HerdrToolSurface {
  const launch = daemonTool(deps, {
    name: "herdr_launch",
    label: "Herdr Launch",
    description: "Launch one supervised Herdr agent run under a durable intent. `task` is the flat Task contract (objective, scope, doneWhen, optional constraints/tier/replicas/recoveryOf/label/cwd); `idempotencyKey` is required and binds this call to at most one effect — retry with the same key after an interrupted attempt instead of launching again.",
    parameters: DaemonLaunchRequestSchema,
    call: (client, params: DaemonLaunchRequest) => client.launch(params),
  });
  const run = daemonTool(deps, {
    name: "herdr_run",
    label: "Herdr Run",
    description: "Operate on your own runs through the durable daemon. `observe` reads a run's handoff observation plus its unread mailbox event IDs; `reconcile` closes an unresolved launch intent once every recorded child is accounted for; `transfer`/`claim` move run ownership between sessions under the journaled ownership contract; `ack` marks one mailbox event handled (idempotent unread→acked rename).",
    parameters: DaemonRunParamsSchema,
    call: (client, params: DaemonRunInput) => client.run(params),
  });
  const status = daemonTool(deps, {
    name: "herdr_status",
    label: "Herdr Status",
    description: "Read-only daemon status: daemon health, your runs and intents (unresolved first), your unread mailbox event IDs and the mailbox path, and one event's bounded body when `eventId` is set. It never acks and never mutates — handle an event, then `herdr_run` `ack` it.",
    parameters: DaemonStatusParamsSchema,
    call: (client, params: DaemonStatusInput) => client.status(params),
  });
  return { launch, run, status, definitions: [launch, run, status] };
}
