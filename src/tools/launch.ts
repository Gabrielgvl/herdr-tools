import type { AgentToolUpdateCallback, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { JsonEnvelope } from "../cli.js";
import type { CompatibilityPreflight } from "../health.js";
import { buildEnvelope, resolveSender, type SenderIdentity } from "../provenance.js";
import type { CurrentContext, HerdrSnapshot, ResolvedTarget } from "../targets.js";
import { assertCurrentContext, parseSnapshotResult, resolveTarget } from "../targets.js";
import { formatCall, formatResult, renderResultComponent, textComponent } from "../tui.js";
import { LaunchParamsSchema, type LaunchPlacement, type LaunchRequest } from "../launch-schema.js";
import { buildRuntimeArgv, defaultPromptSourceStore, resolveProfile, resolveProfileRuntime, type Profile, type ProfileCatalog, type ProfileResolution, type PromptSourceStore } from "../profiles/index.js";
import { CLAUDE_EFFORTS, CLAUDE_PERMISSION_MODES, THINKING_LEVELS, type RuntimeProfile } from "../profiles/types.js";
import { boundedEvidence, HERDR_AGENT_START_TIMEOUT_MS } from "../cli.js";
import { withoutEnvironment } from "../redaction.js";

export interface LaunchCli {
  runJson(argv: string[], signal: AbortSignal, preserveCompletedMutation?: boolean): Promise<JsonEnvelope>;
}

export interface LaunchResourceRegistry {
  record(resource: { kind: "pane" | "tab"; id: string; parentId?: string }): void;
  has?(resource: { kind: "pane" | "tab"; id: string }): boolean;
}

export interface LaunchDependencies {
  cli: LaunchCli;
  context: CurrentContext;
  preflight: CompatibilityPreflight;
  cwd?: string;
  ownership?: LaunchResourceRegistry;
  profiles?: { load: () => Promise<ProfileCatalog> };
  promptSources?: PromptSourceStore;
}

export interface LaunchResourceIds {
  tabId?: string;
  paneId?: string;
  agentId?: string;
}

export interface LaunchAttemptEvidence {
  profile: string;
  outcome: "selected" | "agent_start_failed" | "fallback_refused";
  errorCode?: string;
  message?: string;
  postState?: Record<string, unknown>;
}

export interface LaunchEffectiveProfile {
  requested: string;
  selected: string;
  source: { kind: string; path: string };
  timeoutMinutes: number;
  runtime: Record<string, unknown>;
  permissions: Record<string, unknown>;
  attempts: LaunchAttemptEvidence[];
  fallbackProfiles: string[];
  reachableNames: string[];
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
  sender?: { paneId: string; display: string; source: SenderIdentity["source"] };
  envelope?: { version: "v1"; kind: "assignment" };
  profile?: LaunchEffectiveProfile & { name: string; sessionPersistence: boolean };
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

function profileIdentifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)) {
    throw new LaunchError("INVALID_INPUT", "profile must be lowercase kebab-case");
  }
}

function validateParams(params: LaunchRequest): void {
  if (!record(params)) throw new LaunchError("INVALID_INPUT", "launch parameters must be an object");
  if (typeof params.name !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(params.name)) {
    throw new LaunchError("INVALID_INPUT", "name must start with a lowercase letter and contain only lowercase letters, digits, - or _ (1-32 characters)");
  }
  const allowedKeys = new Set(["name", "profile", "overrides", "placement", "label", "cwd", "focus", "initialPrompt"]);
  for (const key of Object.keys(params)) if (!allowedKeys.has(key)) throw new LaunchError("INVALID_INPUT", `Unknown launch field: ${key}`);
  profileIdentifier(params.profile);
  if (params.overrides !== undefined) {
    if (!record(params.overrides)) throw new LaunchError("INVALID_INPUT", "profile overrides must be an object");
    for (const key of Object.keys(params.overrides)) if (!["model", "thinking", "effort", "tools", "extensions", "skills", "permissionMode", "allowedTools", "disallowedTools", "addDirs", "pluginDirs"].includes(key)) throw new LaunchError("INVALID_INPUT", `Unknown profile override: ${key}`);
    if (params.overrides.model !== undefined) identifier(params.overrides.model, "overrides.model");
    if (params.overrides.thinking !== undefined && (typeof params.overrides.thinking !== "string" || !THINKING_LEVELS.includes(params.overrides.thinking as typeof THINKING_LEVELS[number]))) throw new LaunchError("INVALID_INPUT", "overrides.thinking is invalid");
    if (params.overrides.effort !== undefined && (typeof params.overrides.effort !== "string" || !CLAUDE_EFFORTS.includes(params.overrides.effort as typeof CLAUDE_EFFORTS[number]))) throw new LaunchError("INVALID_INPUT", "overrides.effort is invalid");
    if (params.overrides.permissionMode !== undefined && (typeof params.overrides.permissionMode !== "string" || !CLAUDE_PERMISSION_MODES.includes(params.overrides.permissionMode as typeof CLAUDE_PERMISSION_MODES[number]))) throw new LaunchError("INVALID_INPUT", "overrides.permissionMode is invalid");
    for (const key of ["tools", "extensions", "skills", "allowedTools", "disallowedTools", "addDirs", "pluginDirs"] as const) {
      const value = params.overrides[key];
      if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0 || /[\0\r\n]/.test(item)))) throw new LaunchError("INVALID_INPUT", `overrides.${key} must be non-empty strings without NUL or newlines`);
    }
  }
  if (params.label !== undefined) identifier(params.label, "label");
  if (params.cwd !== undefined) identifier(params.cwd, "cwd");
  if (params.initialPrompt !== undefined && (typeof params.initialPrompt !== "string" || params.initialPrompt.length === 0 || /\0/.test(params.initialPrompt))) {
    throw new LaunchError("INVALID_INPUT", "initialPrompt must be a non-empty string without NUL");
  }
  if (params.focus !== undefined && typeof params.focus !== "boolean") throw new LaunchError("INVALID_INPUT", "focus must be a boolean");
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

function paneRecord(value: unknown, expectedPaneId: string): Record<string, unknown> {
  if (!record(value) || !record(value.pane)) throw new LaunchError("CLI_PROTOCOL_ERROR", "Herdr did not return a pane post-state");
  const pane = value.pane;
  const actualPaneId = idFrom(pane, "pane_id");
  if (actualPaneId !== expectedPaneId) {
    throw new LaunchError("POSTSTATE_UNAVAILABLE", "Herdr pane post-state does not match the resolved pane", { expectedPaneId, actualPaneId });
  }
  return pane;
}

interface StartedAgent {
  name: string;
  paneId: string;
  kind: string;
  agentId?: string;
}

function agentIdentity(value: unknown, expectedName: string, expectedPaneId: string, expectedKind: string): StartedAgent {
  if (!record(value)) throw new LaunchError("CLI_PROTOCOL_ERROR", "Herdr agent-start response is incompatible");
  const agent = Object.prototype.hasOwnProperty.call(value, "agent") ? value.agent : value;
  const name = stringFrom(agent, "name");
  const paneId = stringFrom(agent, "pane_id");
  const kind = stringFrom(agent, "agent");
  const agentId = idFrom(agent, "agent_id") ?? idFrom(agent, "id");
  if (!name || !paneId || !kind) throw new LaunchError("CLI_PROTOCOL_ERROR", "Herdr agent-start response omitted authoritative name, pane, or kind");
  if (name !== expectedName || paneId !== expectedPaneId || kind !== expectedKind) {
    throw new LaunchError("CLI_PROTOCOL_ERROR", "Herdr agent-start response does not match the requested identity", { expectedName, actualName: name, expectedPaneId, actualPaneId: paneId, expectedKind, actualKind: kind });
  }
  return { name, paneId, kind, ...(agentId ? { agentId } : {}) };
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
  const candidates = [result.pane, result.root_pane, result.rootPane, result.new_pane, result.child_pane, result.created_pane, result];
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
  const pane = result.pane ?? result.root_pane ?? result.rootPane ?? (tab as Record<string, unknown>).pane;
  const paneId = idFrom(pane, "pane_id");
  return { tabId, paneId };
}

function stateFrom(pane: Record<string, unknown>): string {
  return typeof pane.agent_status === "string" ? pane.agent_status : "unknown";
}

function noAgentFromPane(pane: Record<string, unknown>): boolean {
  const agentFields = ["agent", "agent_name", "display_agent", "agent_id", "agent_session", "agent_session_id", "agent_terminal_id", "agent_process_id", "agent_kind", "managed_kind", "session_id", "kind"];
  return pane.agent_status === "unknown" && agentFields.every((field) => pane[field] === undefined || pane[field] === null);
}

function prelaunchPaneIsAgentFree(snapshot: HerdrSnapshot, pane: Record<string, unknown>): boolean {
  return noAgentFromPane(pane) && !snapshot.agents.some((agent) => agent.pane_id === pane.pane_id);
}

function agentRecord(result: unknown): Record<string, unknown> {
  if (!record(result)) throw new LaunchError("CLI_PROTOCOL_ERROR", "Herdr agent post-state is incompatible");
  const agent = record(result.agent) ? result.agent : result;
  return agent;
}

function exactPromptRecoveryAgent(agent: Record<string, unknown>, started: StartedAgent, stateChangeSeq: number): boolean {
  const actualSequence = agent.state_change_seq;
  const actualAgentId = idFrom(agent, "agent_id") ?? idFrom(agent, "id");
  return stringFrom(agent, "name") === started.name
    && idFrom(agent, "pane_id") === started.paneId
    && stringFrom(agent, "agent") === started.kind
    && stateFrom(agent) === "idle"
    && typeof actualSequence === "number"
    && Number.isSafeInteger(actualSequence)
    && actualSequence === stateChangeSeq
    && (started.agentId === undefined || actualAgentId === started.agentId);
}

function compactAttemptState(pane: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(["pane_id", "tab_id", "workspace_id", "agent_id", "agent_name", "name", "agent_kind", "agent", "kind", "agent_status", "state_change_seq", "agent_session", "status"].flatMap((field): Array<[string, unknown]> => {
    const value = pane[field];
    if (value === undefined) return [];
    if (typeof value === "string") return [[field, value.slice(0, 256)]];
    if (typeof value === "number" || typeof value === "boolean" || value === null) return [[field, value]];
    return [];
  }));
}

function startFailureEvidence(error: unknown): { code: string; message: string } | undefined {
  if (!record(error) || !record(error.details)) return undefined;
  const { exitCode, killed, stderr, stderrTruncated } = error.details;
  if (exitCode !== 1 || killed !== false || stderrTruncated !== false || typeof stderr !== "string") return undefined;
  let envelope: unknown;
  try { envelope = JSON.parse(stderr); } catch { return undefined; }
  if (!record(envelope) || envelope.id !== "cli:agent:start" || !record(envelope.error)) return undefined;
  if (envelope.error.code !== "agent_start_failed" || envelope.error.message !== "agent process exited before becoming interactive") return undefined;
  return { code: envelope.error.code, message: envelope.error.message };
}

function effectiveDetails(profile: Profile, runtime: RuntimeProfile): { runtime: Record<string, unknown>; permissions: Record<string, unknown> } {
  return runtime.kind === "pi"
    ? {
      runtime: { kind: "pi", model: runtime.model, thinking: runtime.thinking },
      permissions: { sessionPersistence: profile.sessionPersistence, tools: [...runtime.tools], extensions: [...runtime.extensions], skills: [...runtime.skills] }
    }
    : {
      runtime: { kind: "claude", model: runtime.model, effort: runtime.effort },
      permissions: { sessionPersistence: profile.sessionPersistence, permissionMode: runtime.permissionMode, allowedTools: [...runtime.allowedTools], disallowedTools: [...runtime.disallowedTools], addDirs: [...runtime.addDirs], pluginDirs: [...runtime.pluginDirs] }
    };
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

function focusArgs(focus: boolean): string[] {
  return [focus ? "--focus" : "--no-focus"];
}

interface PromptStallEvidence {
  stateChangeSeq: number;
}

function promptStallEvidence(error: unknown): PromptStallEvidence | undefined {
  if (!record(error) || error.code !== "CLI_PROTOCOL_ERROR" || !record(error.details)) return undefined;
  const { exitCode, killed, stderr } = error.details;
  if (exitCode !== 1 || killed !== false || typeof stderr !== "string") return undefined;
  let envelope: unknown;
  try {
    envelope = JSON.parse(stderr.trim());
  } catch {
    return undefined;
  }
  if (!record(envelope) || envelope.id !== "cli:agent:prompt" || !record(envelope.error) || envelope.error.code !== "agent_prompt_stalled" || typeof envelope.error.message !== "string") return undefined;
  const match = /^agent prompt produced no observed state change within 5000 ms; status is idle and state_change_seq remained (\d+)$/.exec(envelope.error.message);
  if (!match) return undefined;
  const stateChangeSeq = Number(match[1]);
  return Number.isSafeInteger(stateChangeSeq) ? { stateChangeSeq } : undefined;
}

function cliFailureEvidence(error: unknown): Record<string, unknown> | undefined {
  if (!record(error) || !record(error.details)) return undefined;
  const details: Record<string, unknown> = {};
  for (const key of ["exitCode", "killed", "stdoutTruncated", "stderrTruncated"] as const) {
    const value = error.details[key];
    if (typeof value === "number" && Number.isSafeInteger(value)) details[key] = value;
    if (typeof value === "boolean") details[key] = value;
  }
  for (const key of ["stdout", "stderr", "cause"] as const) {
    const value = error.details[key];
    if (typeof value === "string") details[key] = boundedEvidence(value).value;
  }
  const code = typeof error.code === "string" ? error.code : undefined;
  const message = error instanceof Error ? boundedEvidence(error.message, 2_000).value : undefined;
  if (code === undefined && message === undefined && Object.keys(details).length === 0) return undefined;
  return { ...(code === undefined ? {} : { code }), ...(message === undefined ? {} : { message }), ...(Object.keys(details).length === 0 ? {} : { details }) };
}

function partialError(error: unknown, created: LaunchResourceIds, phase: LaunchDetails["phase"]): LaunchError {
  const causeCode = error instanceof LaunchError && typeof error.details.causeCode === "string"
    ? error.details.causeCode
    : error instanceof LaunchError ? error.code
      : error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "CLI_PROTOCOL_ERROR";
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof LaunchError && error.code === "POSTSTATE_UNAVAILABLE"
    ? "POSTSTATE_UNAVAILABLE"
    : causeCode === "ABORTED" ? "ABORTED" : causeCode === "POSTSTATE_UNAVAILABLE" ? "POSTSTATE_UNAVAILABLE" : causeCode === "READY_TIMEOUT" || (causeCode === "CLI_TIMEOUT" && phase === "ready") ? "READY_TIMEOUT" : "LAUNCH_FAILED";
  const evidence = error instanceof LaunchError ? undefined : cliFailureEvidence(error);
  return new LaunchError(code, `Launch did not complete: ${message}`, {
    ...(error instanceof LaunchError ? error.details : {}),
    phase,
    ...(evidence ? { cliFailure: evidence } : {}),
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

async function run(cli: LaunchCli, argv: string[], signal: AbortSignal, preserveCompletedMutation = false): Promise<unknown> {
  if (signal.aborted) throw new LaunchError("ABORTED", "Operation aborted");
  try {
    const response = await cli.runJson(argv, signal, preserveCompletedMutation);
    if (signal.aborted && !preserveCompletedMutation) throw new LaunchError("ABORTED", "Operation aborted");
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
    description: "Launch a named Pi or Claude Herdr agent from a strict profile in an explicitly selected pane placement.",
    parameters: LaunchParamsSchema,
    async execute(_id, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as unknown as LaunchRequest;
      validateParams(params);
      const abortSignal = signal!;
      await deps.preflight(abortSignal);
      const cwd = params.cwd ?? deps.cwd ?? ctx.cwd;
      identifier(cwd, "cwd");
      const placement = params.placement ?? { mode: "same_tab" as const };
      const label = params.label ?? params.name;
      if (!deps.profiles) throw new LaunchError("PROFILE_CATALOG_UNAVAILABLE", "Profile catalog is unavailable");
      const catalog = await deps.profiles.load();
      const profileResolution: ProfileResolution = resolveProfile(params.profile, catalog);
      const profiles = profileResolution.reachableNames.map((name) => {
        const profile = catalog.effective.get(name);
        if (!profile) throw new LaunchError("PROFILE_RESOLUTION_INVALID", `Resolved profile ${name} is unavailable`);
        return profile;
      });
      const promptStore = deps.promptSources ?? defaultPromptSourceStore;
      const promptPaths = new Map<string, string>();
      const effectiveRuntimes = new Map<string, RuntimeProfile>();
      for (const profile of profiles) {
        const runtime = resolveProfileRuntime(profile, profile.name === params.profile ? params.overrides : {});
        effectiveRuntimes.set(profile.name, runtime);
        const promptSource = await promptStore.create(profile.body);
        promptPaths.set(profile.name, promptSource.path);
        buildRuntimeArgv(profile, runtime, promptSource.path);
      }
      const snapshot = snapshotOf(await run(deps.cli, ["api", "snapshot"], abortSignal));
      const sender = params.initialPrompt !== undefined ? resolveSender(snapshot, deps.context.paneId) : undefined;
      assertCurrentContext(snapshot, deps.context);
      if (existingAgentNames(snapshot).filter((name) => name === params.name).length > 0) {
        throw new LaunchError("INVALID_INPUT", `Agent name is already in use: ${params.name}`);
      }
      const existingTarget = placement.mode === "existing_pane" ? paneForPlacement(snapshot, placement.target, deps.context) : undefined;
      const existingPaneOwned = placement.mode === "existing_pane"
        && existingTarget !== undefined
        && deps.ownership?.has?.({ kind: "pane", id: existingTarget.id }) === true;
      const existingPaneAgentFree = placement.mode === "existing_pane"
        && existingTarget !== undefined
        && prelaunchPaneIsAgentFree(snapshot, existingTarget.record);
      const workspaceId = placement.mode === "new_tab" ? deps.context.workspaceId! : undefined;
      let paneId: string | undefined;
      let tabId: string | undefined;
      let phase: LaunchDetails["phase"] = "placement";
      const created: LaunchResourceIds = {};
      const attempts: LaunchAttemptEvidence[] = [];
      try {
        progress(onUpdate, phase, created);
        if (placement.mode === "existing_pane") {
          paneId = existingTarget!.paneId!;
          tabId = existingTarget!.tabId;
        } else if (placement.mode === "new_tab") {
          const result = tabRefFrom(await run(deps.cli, ["tab", "create", "--workspace", workspaceId!, "--cwd", cwd, "--label", placement.tabLabel, ...focusArgs(params.focus === true)], abortSignal, true));
          tabId = result.tabId;
          paneId = result.paneId;
          created.tabId = tabId;
          deps.ownership?.record({ kind: "tab", id: tabId, parentId: workspaceId });
          if (!paneId) {
            const tab = await run(deps.cli, ["tab", "get", tabId], abortSignal);
            paneId = paneRefFrom(tab).paneId;
          }
          created.paneId = paneId;
          deps.ownership?.record({ kind: "pane", id: paneId!, parentId: tabId });
        } else {
          const result = paneRefFrom(await run(deps.cli, ["pane", "split", "--current", "--direction", "right", ...focusArgs(params.focus === true), "--cwd", cwd], abortSignal, true));
          paneId = result.paneId;
          tabId = result.tabId ?? deps.context.tabId!;
          created.paneId = paneId;
          created.tabId = tabId;
          deps.ownership?.record({ kind: "pane", id: paneId!, parentId: tabId! });
        }
        const resolvedPaneId = paneId!;
        if (placement.mode !== "existing_pane") await run(deps.cli, ["pane", "rename", resolvedPaneId, label], abortSignal);
        phase = "agent_start";
        progress(onUpdate, phase, created);
        let started: unknown;
        let selectedProfile: Profile | undefined;
        let selectedRuntime: RuntimeProfile | undefined;
        let startedAgent: StartedAgent | undefined;
        for (const profile of profiles) {
          const runtime = effectiveRuntimes.get(profile.name)!;
          const startArgs = ["agent", "start", params.name, "--kind", runtime.kind, "--pane", resolvedPaneId, "--timeout", String(HERDR_AGENT_START_TIMEOUT_MS), "--", ...buildRuntimeArgv(profile, runtime, promptPaths.get(profile.name))];
          try {
            started = await run(deps.cli, startArgs, abortSignal, true);
            startedAgent = agentIdentity(started, params.name, resolvedPaneId, runtime.kind);
            selectedProfile = profile;
            selectedRuntime = runtime;
            attempts.push({ profile: profile.name, outcome: "selected" });
            break;
          } catch (error) {
            const eligible = startFailureEvidence(error);
            if (!eligible) throw error;
            let failedPane: Record<string, unknown>;
            try {
              failedPane = paneRecord(await run(deps.cli, ["pane", "get", resolvedPaneId], abortSignal), resolvedPaneId);
            } catch (readError) {
              throw new LaunchError("POSTSTATE_UNAVAILABLE", "Fallback eligibility could not be proven from authoritative pane state", { causeCode: "POSTSTATE_UNAVAILABLE", startFailureCode: eligible.code, readError: readError instanceof Error ? readError.message : String(readError), attempts });
            }
            const evidence: LaunchAttemptEvidence = { profile: profile.name, outcome: "agent_start_failed", errorCode: eligible.code, message: eligible.message, postState: compactAttemptState(failedPane) };
            attempts.push(evidence);
            if (!noAgentFromPane(failedPane)) {
              attempts.push({ profile: profile.name, outcome: "fallback_refused", errorCode: eligible.code, message: "authoritative pane still reports an agent", postState: compactAttemptState(failedPane) });
              throw new LaunchError("LAUNCH_FAILED", "Automatic fallback refused because the failed pane still has an agent", { causeCode: eligible.code, attempts });
            }
            if (profile === profiles.at(-1)) throw new LaunchError("LAUNCH_FAILED", "Profile fallback chain exhausted after agent start failure", { causeCode: eligible.code, attempts });
          }
        }
        const chosenProfile = selectedProfile!;
        const chosenRuntime = selectedRuntime!;
        const chosenAgent = startedAgent!;
        let agentId = chosenAgent.agentId;
        if (agentId) created.agentId = agentId;
        phase = "ready";
        progress(onUpdate, phase, created);
        if (placement.mode === "existing_pane" && params.focus === true) await run(deps.cli, ["agent", "focus", resolvedPaneId], abortSignal);
        let initialPromptSent = false;
        if (params.initialPrompt !== undefined) {
          phase = "prompt_verification";
          const envelope = buildEnvelope(sender!, "assignment", params.initialPrompt);
          try {
            await run(deps.cli, ["agent", "prompt", resolvedPaneId, envelope, "--wait", "--until", "working", "--timeout", "10000"], abortSignal);
          } catch (error) {
            const stalled = promptStallEvidence(error);
            if (!stalled) throw error;
            if (placement.mode === "existing_pane") {
              if (!existingPaneOwned) {
                throw new LaunchError("LAUNCH_FAILED", "Initial prompt stalled; existing-pane recovery requires runtime ownership", { causeCode: "agent_prompt_stalled", promptRecovery: "refused_existing_pane_not_owned" });
              }
              if (!existingPaneAgentFree) {
                throw new LaunchError("LAUNCH_FAILED", "Initial prompt stalled; existing-pane recovery requires an agent-free pre-launch pane", { causeCode: "agent_prompt_stalled", promptRecovery: "refused_existing_pane_preexisting_agent" });
              }
              let stalledAgent: Record<string, unknown>;
              try {
                stalledAgent = agentRecord(await run(deps.cli, ["agent", "get", resolvedPaneId], abortSignal));
              } catch {
                throw new LaunchError("POSTSTATE_UNAVAILABLE", "Initial prompt stalled; authoritative agent post-state was unavailable for bounded recovery", { causeCode: "agent_prompt_stalled", promptRecovery: "refused_existing_pane_post_state_unavailable" });
              }
              if (!exactPromptRecoveryAgent(stalledAgent, chosenAgent, stalled.stateChangeSeq)) {
                throw new LaunchError("POSTSTATE_UNAVAILABLE", "Initial prompt stalled; authoritative agent post-state did not prove the exact idle agent", { causeCode: "agent_prompt_stalled", promptRecovery: "refused_existing_pane_post_state_unproven", postState: compactAttemptState(stalledAgent), expectedStateChangeSeq: stalled.stateChangeSeq });
              }
            }
            await run(deps.cli, ["agent", "send-keys", resolvedPaneId, "enter"], abortSignal);
            await run(deps.cli, ["agent", "wait", resolvedPaneId, "--until", "working", "--timeout", "5000"], abortSignal);
          }
          initialPromptSent = true;
          progress(onUpdate, phase, created);
        }
        const postState = paneRecord(await run(deps.cli, ["pane", "get", resolvedPaneId], abortSignal), resolvedPaneId);
        if (params.initialPrompt !== undefined && stateFrom(postState) !== "working") throw new LaunchError("POSTSTATE_UNAVAILABLE", "Initial prompt did not produce a verified working state");
        agentId ??= idFrom(postState, "agent_id");
        const authoritativeName = chosenAgent.name;
        const details = effectiveDetails(chosenProfile, chosenRuntime);
        const launchDetails: LaunchDetails = {
          operation: "launch", outcome: "launched", name: authoritativeName, kind: chosenRuntime.kind, placement, tabId, paneId: resolvedPaneId,
          ...(agentId ? { agentId } : {}), postState: withoutEnvironment(postState), initialPromptSent,
          ...(sender ? { sender: { paneId: sender.paneId, display: sender.display, source: sender.source }, envelope: { version: "v1" as const, kind: "assignment" as const } } : {}),
          profile: {
            name: chosenProfile.name, requested: params.profile, selected: chosenProfile.name,
            source: { kind: chosenProfile.source.kind, path: chosenProfile.source.path }, timeoutMinutes: chosenProfile.timeoutMinutes,
            runtime: details.runtime, permissions: details.permissions, attempts,
            fallbackProfiles: [...profileResolution.fallbackProfiles], reachableNames: [...profileResolution.reachableNames], sessionPersistence: chosenProfile.sessionPersistence
          }
        };
        return { content: [{ type: "text", text: formatResult({ operation: "launch", outcome: "success", targetId: paneId }) }], details: launchDetails };
      } catch (error) {
        if (error instanceof LaunchError && attempts.length > 0 && error.details.attempts === undefined) error.details.attempts = attempts;
        throw partialError(error, created, phase);
      }
    },
    renderCall(args, theme) {
      return textComponent(formatCall("herdr_launch", args.profile, args.name), theme, "accent");
    },
    renderResult(result, options, theme) {
      return renderResultComponent("launch", result, options, theme, result.details?.paneId);
    }
  };
}

export { validateParams as validateLaunchParams };
