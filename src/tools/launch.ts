import type { AgentToolUpdateCallback, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { JsonEnvelope } from "../cli.js";
import type { CurrentContext, HerdrSnapshot, ResolvedTarget } from "../targets.js";
import { parseSnapshotResult, resolveTarget } from "../targets.js";
import { formatCall, formatResult } from "../tui.js";
import { isLaunchAgentKind, LaunchParamsSchema, type LaunchParams, type LaunchPlacement } from "../launch-schema.js";

export interface LaunchCli {
  runJson(argv: string[], signal: AbortSignal): Promise<JsonEnvelope>;
}

export interface LaunchDependencies {
  cli: LaunchCli;
  context: CurrentContext;
  cwd?: string;
}

export interface LaunchResourceIds {
  tabId?: string;
  paneId?: string;
  agentId?: string;
}

export interface LaunchDetails extends LaunchResourceIds {
  operation: "launch";
  outcome: "launched" | "partial";
  name?: string;
  kind?: string;
  placement?: LaunchPlacement;
  postState?: Record<string, unknown>;
  initialPromptSent?: boolean;
  phase?: "placement" | "agent_start" | "ready" | "prompt_verification";
  created?: LaunchResourceIds;
  causeCode?: string;
}

class LaunchError extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "LaunchError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identifier(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/.test(value)) {
    throw new LaunchError("INVALID_INPUT", `${field} must be a non-empty single identifier`);
  }
}

function validateParams(params: LaunchParams): void {
  if (!record(params)) throw new LaunchError("INVALID_INPUT", "launch parameters must be an object");
  identifier(params.name, "name");
  if (!isLaunchAgentKind(params.kind)) throw new LaunchError("INVALID_INPUT", `Unsupported Herdr agent kind: ${String(params.kind)}`);
  if (params.argv !== undefined && (!Array.isArray(params.argv) || params.argv.some((arg) => typeof arg !== "string" || /\0/.test(arg)))) {
    throw new LaunchError("INVALID_INPUT", "argv must contain only strings representable by the CLI transport");
  }
  if (params.label !== undefined) identifier(params.label, "label");
  if (params.cwd !== undefined) identifier(params.cwd, "cwd");
  if (params.initialPrompt !== undefined && (typeof params.initialPrompt !== "string" || params.initialPrompt.length === 0 || /\0/.test(params.initialPrompt))) {
    throw new LaunchError("INVALID_INPUT", "initialPrompt must be a non-empty string without NUL");
  }
  if (params.focus !== undefined && typeof params.focus !== "boolean") throw new LaunchError("INVALID_INPUT", "focus must be a boolean");
  if (params.env !== undefined) {
    if (!record(params.env)) throw new LaunchError("INVALID_INPUT", "env must be a string map");
    for (const [key, value] of Object.entries(params.env)) {
      identifier(key, "environment variable name");
      if (typeof value !== "string" || /\0/.test(value)) throw new LaunchError("INVALID_INPUT", "environment values must be strings without NUL");
    }
  }
  const placement = params.placement;
  if (placement === undefined) return;
  if (!record(placement) || typeof placement.mode !== "string") throw new LaunchError("INVALID_INPUT", "placement is invalid");
  if (placement.mode === "same_tab") {
    if (Object.keys(placement).length !== 1) throw new LaunchError("INVALID_INPUT", "same_tab placement has no additional fields");
  } else if (placement.mode === "new_tab") {
    identifier(placement.tabLabel, "placement.tabLabel");
    if (Object.keys(placement).some((key) => key !== "mode" && key !== "tabLabel")) throw new LaunchError("INVALID_INPUT", "new_tab placement has unknown fields");
  } else if (placement.mode === "existing_pane") {
    identifier(placement.target, "placement.target");
    if (Object.keys(placement).some((key) => key !== "mode" && key !== "target")) throw new LaunchError("INVALID_INPUT", "existing_pane placement has unknown fields");
  } else {
    throw new LaunchError("INVALID_INPUT", "Unsupported placement mode");
  }
}

function paneRecord(value: unknown): Record<string, unknown> {
  if (!record(value) || !record(value.pane)) throw new LaunchError("CLI_PROTOCOL_ERROR", "Herdr did not return a pane post-state");
  return value.pane;
}

function idFrom(value: unknown, field: string): string | undefined {
  if (!record(value)) return undefined;
  const candidate = value[field];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function stringFrom(value: unknown, field: string): string | undefined {
  if (!record(value)) return undefined;
  const candidate = value[field];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function paneRefFrom(result: unknown): LaunchResourceIds {
  if (!record(result)) throw new LaunchError("CLI_PROTOCOL_ERROR", "Herdr placement response is incompatible");
  const candidates = [result.pane, result.new_pane, result.child_pane, result.created_pane, result];
  for (const candidate of candidates) {
    const paneId = idFrom(candidate, "pane_id");
    if (paneId) return { paneId, tabId: idFrom(candidate, "tab_id") };
  }
  throw new LaunchError("CLI_PROTOCOL_ERROR", "Herdr placement response omitted the authoritative pane ID");
}

function tabRefFrom(result: unknown): { tabId: string; paneId?: string } {
  if (!record(result)) throw new LaunchError("CLI_PROTOCOL_ERROR", "Herdr tab response is incompatible");
  const tab = record(result.tab) ? result.tab : result;
  const tabId = idFrom(tab, "tab_id");
  if (!tabId) throw new LaunchError("CLI_PROTOCOL_ERROR", "Herdr tab response omitted the authoritative tab ID");
  const pane = result.pane ?? (tab as Record<string, unknown>).pane;
  const paneId = idFrom(pane, "pane_id");
  return { tabId, paneId };
}

function stateFrom(pane: Record<string, unknown>): string {
  return typeof pane.agent_status === "string" ? pane.agent_status : "unknown";
}

function snapshotOf(result: unknown): HerdrSnapshot {
  return parseSnapshotResult(result);
}

function existingAgentNames(snapshot: HerdrSnapshot): string[] {
  const names = snapshot.agents.flatMap((agent) => typeof agent.name === "string" ? [agent.name] : []);
  for (const pane of snapshot.panes) {
    const name = typeof pane.agent_name === "string" ? pane.agent_name : typeof pane.agent === "string" ? pane.agent : undefined;
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function paneForPlacement(snapshot: HerdrSnapshot, target: string, context: CurrentContext): ResolvedTarget {
  return resolveTarget(snapshot, target, "pane", context);
}

function envArgs(env: Record<string, string> | undefined): string[] {
  if (!env) return [];
  return Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
}

function focusArgs(focus: boolean): string[] {
  return [focus ? "--focus" : "--no-focus"];
}

function partialError(error: unknown, created: LaunchResourceIds, phase: LaunchDetails["phase"]): LaunchError {
  const causeCode = error instanceof LaunchError ? error.code : error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "CLI_PROTOCOL_ERROR";
  const message = error instanceof Error ? error.message : String(error);
  const code = causeCode === "ABORTED" ? "ABORTED" : causeCode === "POSTSTATE_UNAVAILABLE" ? "POSTSTATE_UNAVAILABLE" : causeCode === "READY_TIMEOUT" || (causeCode === "CLI_TIMEOUT" && phase === "ready") ? "READY_TIMEOUT" : "LAUNCH_FAILED";
  return new LaunchError(code, `Launch did not complete: ${message}`, {
    ...(error instanceof LaunchError ? error.details : {}),
    created: { ...created },
    causeCode
  });
}

function progress(onUpdate: AgentToolUpdateCallback<LaunchDetails> | undefined, phase: LaunchDetails["phase"], created: LaunchResourceIds): void {
  onUpdate?.({
    content: [{ type: "text", text: `Launch ${phase}` }],
    details: { operation: "launch", outcome: "partial", phase, created: { ...created } }
  });
}

async function run(cli: LaunchCli, argv: string[], signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) throw new LaunchError("ABORTED", "Operation aborted");
  try {
    const response = await cli.runJson(argv, signal);
    if (signal.aborted) throw new LaunchError("ABORTED", "Operation aborted");
    return response.result;
  } catch (error) {
    if (signal.aborted) throw new LaunchError("ABORTED", "Operation aborted");
    throw error;
  }
}

export function createLaunchTool(deps: LaunchDependencies): ToolDefinition<typeof LaunchParamsSchema, LaunchDetails> {
  return {
    name: "herdr_launch",
    label: "Herdr Launch",
    description: "Launch a supported Herdr agent in an explicitly selected pane placement.",
    parameters: LaunchParamsSchema,
    async execute(_id, params, signal, onUpdate, ctx) {
      validateParams(params);
      const abortSignal = signal!;
      const cwd = params.cwd ?? deps.cwd ?? ctx.cwd;
      identifier(cwd, "cwd");
      const placement = params.placement ?? { mode: "same_tab" as const };
      const label = params.label ?? params.name;
      const snapshot = snapshotOf(await run(deps.cli, ["api", "snapshot"], abortSignal));
      if (existingAgentNames(snapshot).filter((name) => name === params.name).length > 0) {
        throw new LaunchError("INVALID_INPUT", `Agent name is already in use: ${params.name}`);
      }
      if (placement.mode === "existing_pane" && params.env !== undefined) {
        throw new LaunchError("INVALID_INPUT", "Environment overrides are supported only when Herdr creates the child pane or tab");
      }
      const existingTarget = placement.mode === "existing_pane" ? paneForPlacement(snapshot, placement.target, deps.context) : undefined;
      const workspaceId = placement.mode === "new_tab" ? requiredContext(deps.context, "workspaceId") : undefined;
      let paneId: string | undefined;
      let tabId: string | undefined;
      let phase: LaunchDetails["phase"] = "placement";
      const created: LaunchResourceIds = {};
      try {
        progress(onUpdate, phase, created);
        if (placement.mode === "existing_pane") {
          paneId = existingTarget!.paneId!;
          tabId = existingTarget!.tabId;
        } else if (placement.mode === "new_tab") {
          const result = tabRefFrom(await run(deps.cli, ["tab", "create", "--workspace", workspaceId!, "--cwd", cwd, "--label", placement.tabLabel, ...focusArgs(params.focus === true), ...envArgs(params.env)], abortSignal));
          tabId = result.tabId;
          paneId = result.paneId;
          created.tabId = tabId;
          if (!paneId) {
            const tab = await run(deps.cli, ["tab", "get", tabId], abortSignal);
            paneId = paneRefFrom(tab).paneId;
          }
          created.paneId = paneId;
        } else {
          const result = paneRefFrom(await run(deps.cli, ["pane", "split", "--current", "--direction", "right", ...focusArgs(params.focus === true), "--cwd", cwd, ...envArgs(params.env)], abortSignal));
          paneId = result.paneId;
          tabId = result.tabId ?? deps.context.tabId;
          created.paneId = paneId;
          if (tabId) created.tabId = tabId;
          if (!paneId || !tabId) throw new LaunchError("CLI_PROTOCOL_ERROR", "Created pane did not return an authoritative pane ID and tab context");
        }
        const resolvedPaneId = paneId!;
        if (placement.mode !== "existing_pane") {
          await run(deps.cli, ["pane", "rename", resolvedPaneId, label], abortSignal);
        }
        phase = "agent_start";
        progress(onUpdate, phase, created);
        const startArgs = ["agent", "start", params.name, "--kind", params.kind, "--pane", resolvedPaneId, "--timeout", "30000"];
        if (params.argv !== undefined && params.argv.length > 0) startArgs.push("--", ...params.argv);
        const started = await run(deps.cli, startArgs, abortSignal);
        const agent = record(started) && record(started.agent) ? started.agent : started;
        const agentId = idFrom(agent, "agent_id") ?? idFrom(agent, "id");
        const returnedName = stringFrom(agent, "name");
        if (agentId) {
          created.agentId = agentId;
        }
        phase = "ready";
        progress(onUpdate, phase, created);
        if (placement.mode === "existing_pane" && params.focus === true) await run(deps.cli, ["agent", "focus", resolvedPaneId], abortSignal);
        let initialPromptSent = false;
        if (params.initialPrompt !== undefined) {
          phase = "prompt_verification";
          await run(deps.cli, ["agent", "prompt", resolvedPaneId, params.initialPrompt, "--wait", "--until", "working", "--timeout", "5000"], abortSignal);
          initialPromptSent = true;
          progress(onUpdate, phase, created);
        }
        const postState = paneRecord(await run(deps.cli, ["pane", "get", resolvedPaneId], abortSignal));
        if (params.initialPrompt !== undefined && stateFrom(postState) !== "working") {
          throw new LaunchError("POSTSTATE_UNAVAILABLE", "Initial prompt did not produce a verified working state");
        }
        const details: LaunchDetails = {
          operation: "launch",
          outcome: "launched",
          name: returnedName ?? stringFrom(postState, "agent_name") ?? stringFrom(postState, "name") ?? params.name,
          kind: params.kind,
          placement,
          tabId,
          paneId: resolvedPaneId,
          ...(agentId ? { agentId } : {}),
          postState,
          initialPromptSent
        };
        return { content: [{ type: "text", text: formatResult({ operation: "launch", outcome: "success", targetId: paneId }) }], details };
      } catch (error) {
        throw partialError(error, created, phase);
      }
    },
    renderCall(args) {
      return { render: () => [formatCall("herdr_launch", args.kind, args.name)], invalidate() {} };
    },
    renderResult(result) {
      return { render: () => [formatResult({ operation: "launch", outcome: result.details?.outcome === "launched" ? "success" : "partial", targetId: result.details?.paneId })], invalidate() {} };
    }
  };
}

function requiredContext(context: CurrentContext, field: "workspaceId" | "tabId" | "paneId"): string {
  const value = context[field];
  if (!value) throw new LaunchError("CONTEXT_UNAVAILABLE", `Current Herdr ${field} is unavailable`);
  return value;
}

export { validateParams as validateLaunchParams };
