import type { AgentToolUpdateCallback, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { JsonEnvelope } from "../cli.js";
import type { CompatibilityPreflight } from "../health.js";
import { assertDeliverySize, assertMessageText, type MessageDelivery } from "../messages/limits.js";
import { defaultAttachmentStore, type AttachmentStore, type PublishedAttachment } from "../messages/store.js";
import { mintRecipientKey, type RecipientRegistry } from "../messages/recipients.js";
import { attachmentCapability } from "../profiles/capability.js";
import { buildEnvelope, resolveSender, type SenderIdentity } from "../provenance.js";
import type { CurrentContext, HerdrSnapshot, ResolvedTarget } from "../targets.js";
import { assertCurrentContext, parseSnapshotResult, resolveTarget } from "../targets.js";
import { formatCall, formatResult, renderResultComponent, textComponent } from "../tui.js";
import { isLaunchAgentKind, LaunchParamsSchema, type LaunchPlacement, type LaunchRequest } from "../launch-schema.js";
import { buildProfileArgv, defaultPromptSourceStore, resolveProfile, type ProfileCatalog, type ProfileResolution, type PromptSourceStore } from "../profiles/index.js";

export interface LaunchCli {
  runJson(argv: string[], signal: AbortSignal, preserveCompletedMutation?: boolean): Promise<JsonEnvelope>;
  runJsonWithStdin?(argv: string[], input: string, signal: AbortSignal, preserveCompletedMutation?: boolean): Promise<JsonEnvelope>;
}

export interface LaunchResourceRegistry {
  record(resource: { kind: "pane" | "tab"; id: string; parentId?: string }): void;
}

export interface LaunchDependencies {
  cli: LaunchCli;
  context: CurrentContext;
  preflight: CompatibilityPreflight;
  cwd?: string;
  ownership?: LaunchResourceRegistry;
  profiles?: { load: () => Promise<ProfileCatalog> };
  promptSources?: PromptSourceStore;
  attachments?: AttachmentStore;
  recipients?: RecipientRegistry;
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
  initialPromptDelivery?: MessageDelivery;
  phase?: "attachment_publish" | "placement" | "agent_start" | "ready" | "prompt_verification";
  created?: LaunchResourceIds;
  causeCode?: string;
  sender?: { paneId: string; display: string; source: SenderIdentity["source"] };
  envelope?: { version: "v1"; kind: "assignment"; delivery: MessageDelivery };
  attachment?: PublishedAttachment;
  recipient?: { recipientKey: string; paneId: string; agentName: string; agentId?: string; profileName: string; kind: "pi" | "claude"; capable: boolean; reason: string };
  profile?: { name: string; source: { kind: string; path: string }; timeoutMinutes: number; sessionPersistence: boolean; fallbackProfiles: string[]; reachableNames: string[] };
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

function validateParams(params: LaunchRequest): void {
  if (!record(params)) throw new LaunchError("INVALID_INPUT", "launch parameters must be an object");
  if (typeof params.name !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(params.name)) {
    throw new LaunchError("INVALID_INPUT", "name must start with a lowercase letter and contain only lowercase letters, digits, - or _ (1-32 characters)");
  }
  const profileMode = params.profile !== undefined;
  if (profileMode) identifier(params.profile, "profile");
  if (profileMode === (params.kind !== undefined)) throw new LaunchError("INVALID_INPUT", "launch requires exactly one of kind or profile");
  if (!profileMode && !isLaunchAgentKind(params.kind)) throw new LaunchError("INVALID_INPUT", `Unsupported Herdr agent kind: ${String(params.kind)}`);
  if (profileMode && (params.argv !== undefined || params.env !== undefined)) throw new LaunchError("INVALID_INPUT", "profile launches do not accept raw argv or environment overrides");
  if (profileMode && params.overrides !== undefined) {
    if (!record(params.overrides)) throw new LaunchError("INVALID_INPUT", "profile overrides must be an object");
    for (const key of Object.keys(params.overrides)) if (!["model", "thinking", "effort", "tools", "extensions", "skills", "permissionMode", "allowedTools", "disallowedTools", "addDirs", "pluginDirs"].includes(key)) throw new LaunchError("INVALID_INPUT", `Unknown profile override: ${key}`);
    if (params.overrides.model !== undefined) identifier(params.overrides.model, "overrides.model");
    for (const key of ["tools", "extensions", "skills", "allowedTools", "disallowedTools", "addDirs", "pluginDirs"] as const) {
      const value = params.overrides[key];
      if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0 || /[\0\r\n]/.test(item)))) throw new LaunchError("INVALID_INPUT", `overrides.${key} must be non-empty strings without NUL or newlines`);
    }
  }
  if (!profileMode && params.overrides !== undefined) throw new LaunchError("INVALID_INPUT", "overrides are only valid for profile launches");
  if (params.argv !== undefined && (!Array.isArray(params.argv) || params.argv.some((arg) => typeof arg !== "string" || /\0/.test(arg)))) {
    throw new LaunchError("INVALID_INPUT", "argv must contain only strings representable by the CLI transport");
  }
  if (params.label !== undefined) identifier(params.label, "label");
  if (params.cwd !== undefined) identifier(params.cwd, "cwd");
  if (params.initialPrompt !== undefined && (typeof params.initialPrompt !== "string" || params.initialPrompt.length === 0 || /\0/.test(params.initialPrompt))) {
    throw new LaunchError("INVALID_INPUT", "initialPrompt must be a non-empty string without NUL");
  }
  if (params.initialPromptDelivery !== undefined && params.initialPromptDelivery !== "inline" && params.initialPromptDelivery !== "attachment") {
    throw new LaunchError("INVALID_INPUT", "initialPromptDelivery must be inline or attachment");
  }
  if (params.initialPrompt === undefined && params.initialPromptDelivery !== undefined) {
    throw new LaunchError("INVALID_INPUT", "initialPromptDelivery requires initialPrompt");
  }
  if (params.initialPromptDelivery === "attachment" && !profileMode) {
    throw new LaunchError("ATTACHMENT_TARGET_UNVERIFIED", "Attachment initial prompts require a capable profile launch");
  }
  if (params.focus !== undefined && typeof params.focus !== "boolean") throw new LaunchError("INVALID_INPUT", "focus must be a boolean");
  if (params.env !== undefined) {
    if (!record(params.env)) throw new LaunchError("INVALID_INPUT", "env must be a string map");
    for (const [key, value] of Object.entries(params.env)) {
      identifier(key, "environment variable name");
      if (key.includes("=")) throw new LaunchError("INVALID_INPUT", "environment variable names must not contain =");
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

function paneRecord(value: unknown, expectedPaneId: string): Record<string, unknown> {
  if (!record(value) || !record(value.pane)) throw new LaunchError("CLI_PROTOCOL_ERROR", "Herdr did not return a pane post-state");
  const pane = value.pane;
  const actualPaneId = idFrom(pane, "pane_id");
  if (actualPaneId !== expectedPaneId) {
    throw new LaunchError("POSTSTATE_UNAVAILABLE", "Herdr pane post-state does not match the resolved pane", { expectedPaneId, actualPaneId });
  }
  return pane;
}

function agentIdentity(value: unknown): { name?: string; agentId?: string } {
  if (!record(value)) throw new LaunchError("CLI_PROTOCOL_ERROR", "Herdr agent-start response is incompatible");
  const agent = Object.prototype.hasOwnProperty.call(value, "agent") ? value.agent : value;
  const name = stringFrom(agent, "name");
  const agentId = idFrom(agent, "agent_id") ?? idFrom(agent, "id");
  if (!name && !agentId) throw new LaunchError("CLI_PROTOCOL_ERROR", "Herdr agent-start response omitted authoritative agent identity");
  return { name, agentId };
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

async function runPrompt(cli: LaunchCli, paneId: string, envelope: string, signal: AbortSignal): Promise<unknown> {
  if (!cli.runJsonWithStdin) throw new LaunchError("CLI_INCOMPATIBLE", "Herdr CLI stdin prompt transport is unavailable");
  const argv = ["agent", "prompt", paneId, "--stdin", "--wait", "--until", "working", "--timeout", "5000"];
  try {
    const response = await cli.runJsonWithStdin(argv, envelope, signal);
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
    async execute(_id, rawParams, signal, onUpdate, ctx) {
      const params = rawParams as unknown as LaunchRequest;
      validateParams(params);
      const abortSignal = signal ?? ctx.signal ?? new AbortController().signal;
      const initialPromptDelivery: MessageDelivery | undefined = params.initialPrompt === undefined ? undefined : (params.initialPromptDelivery ?? "inline");
      if (params.initialPrompt !== undefined) {
        assertMessageText(params.initialPrompt);
        assertDeliverySize(params.initialPrompt, initialPromptDelivery!);
      }
      await deps.preflight(abortSignal);
      const cwd = params.cwd ?? deps.cwd ?? ctx.cwd;
      identifier(cwd, "cwd");
      const placement = params.placement ?? { mode: "same_tab" as const };
      const label = params.label ?? params.name;
      let profileResolution: ProfileResolution | undefined;
      let profileArgv: string[] | undefined;
      let capability: ReturnType<typeof attachmentCapability> | undefined;
      if (params.profile !== undefined) {
        if (!deps.profiles) throw new LaunchError("PROFILE_CATALOG_UNAVAILABLE", "Profile catalog is unavailable");
        profileResolution = resolveProfile(params.profile, await deps.profiles.load());
        capability = attachmentCapability(profileResolution.profile);
        if (initialPromptDelivery === "attachment" && !capability.capable) {
          throw new LaunchError("ATTACHMENT_TARGET_UNVERIFIED", "Profile cannot read a local attachment", { profile: profileResolution.profile.name, reason: capability.reason });
        }
        buildProfileArgv(profileResolution.profile, params.overrides);
      }
      const effectiveKind = profileResolution?.profile.runtime.kind ?? params.kind!;
      const effectiveArgv = profileResolution ? undefined : params.argv;
      const promptSource = profileResolution
        ? await (deps.promptSources ?? defaultPromptSourceStore).create(profileResolution.profile.body)
        : undefined;
      const attachmentStore = deps.attachments ?? defaultAttachmentStore;
      let recipientKey: string | undefined;
      let recipientDirectory: string | undefined;
      let published: PublishedAttachment | undefined;
      if (profileResolution) {
        recipientKey = mintRecipientKey();
        recipientDirectory = await attachmentStore.ensureRecipient(recipientKey);
        if (initialPromptDelivery !== "attachment") profileArgv = buildProfileArgv(profileResolution.profile, params.overrides, promptSource!.path, recipientDirectory);
      }
      const snapshot = snapshotOf(await run(deps.cli, ["api", "snapshot"], abortSignal));
      const sender = params.initialPrompt !== undefined ? resolveSender(snapshot, deps.context.paneId) : undefined;
      assertCurrentContext(snapshot, deps.context);
      if (existingAgentNames(snapshot).filter((name) => name === params.name).length > 0) {
        throw new LaunchError("INVALID_INPUT", `Agent name is already in use: ${params.name}`);
      }
      if (placement.mode === "existing_pane" && params.env !== undefined) {
        throw new LaunchError("INVALID_INPUT", "Environment overrides are supported only when Herdr creates the child pane or tab");
      }
      const existingTarget = placement.mode === "existing_pane" ? paneForPlacement(snapshot, placement.target, deps.context) : undefined;
      const workspaceId = placement.mode === "new_tab" ? deps.context.workspaceId! : undefined;
      let paneId: string | undefined;
      let tabId: string | undefined;
      let phase: LaunchDetails["phase"] = "placement";
      const created: LaunchResourceIds = {};
      if (profileResolution && initialPromptDelivery === "attachment") {
          phase = "attachment_publish";
          progress(onUpdate, phase, created);
          published = await attachmentStore.publish({
            body: params.initialPrompt!,
            recipientKey: recipientKey!,
            ...(existingTarget?.paneId ? { recipientPaneId: existingTarget.paneId } : {}),
            recipientAgentName: params.name,
            senderPaneId: sender!.paneId,
            senderDisplay: sender!.display,
            operation: "assignment"
          });
        profileArgv = buildProfileArgv(profileResolution.profile, params.overrides, promptSource!.path, recipientDirectory);
      }
      try {
        phase = "placement";
        progress(onUpdate, phase, created);
        if (placement.mode === "existing_pane") {
          paneId = existingTarget!.paneId!;
          tabId = existingTarget!.tabId;
        } else if (placement.mode === "new_tab") {
          const result = tabRefFrom(await run(deps.cli, ["tab", "create", "--workspace", workspaceId!, "--cwd", cwd, "--label", placement.tabLabel, ...focusArgs(params.focus === true), ...envArgs(params.env)], abortSignal, true));
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
          const result = paneRefFrom(await run(deps.cli, ["pane", "split", "--current", "--direction", "right", ...focusArgs(params.focus === true), "--cwd", cwd, ...envArgs(params.env)], abortSignal, true));
          paneId = result.paneId;
          tabId = result.tabId ?? deps.context.tabId!;
          created.paneId = paneId;
          created.tabId = tabId;
          deps.ownership?.record({ kind: "pane", id: paneId!, parentId: tabId! });
        }
        const resolvedPaneId = paneId!;
        if (placement.mode !== "existing_pane") {
          await run(deps.cli, ["pane", "rename", resolvedPaneId, label], abortSignal);
        }
        phase = "agent_start";
        progress(onUpdate, phase, created);
        let started: unknown;
        if (profileResolution) {
          started = await run(deps.cli, ["agent", "start", params.name, "--kind", effectiveKind, "--pane", resolvedPaneId, "--timeout", "120000", "--", ...profileArgv!], abortSignal, true);
        } else {
          const startArgs = ["agent", "start", params.name, "--kind", effectiveKind, "--pane", resolvedPaneId, "--timeout", "120000"];
          if (effectiveArgv !== undefined && effectiveArgv.length > 0) startArgs.push("--", ...effectiveArgv);
          started = await run(deps.cli, startArgs, abortSignal, true);
        }
        const startedAgent = agentIdentity(started);
        let agentId = startedAgent.agentId;
        const returnedName = startedAgent.name;
        if (agentId) created.agentId = agentId;
        phase = "ready";
        progress(onUpdate, phase, created);
        if (placement.mode === "existing_pane" && params.focus === true) await run(deps.cli, ["agent", "focus", resolvedPaneId], abortSignal);
        let initialPromptSent = false;
        if (params.initialPrompt !== undefined) {
          phase = "prompt_verification";
          const envelope = initialPromptDelivery === "attachment"
            ? buildEnvelope(sender!, "assignment", params.initialPrompt, "attachment", { ...published!, encoding: "utf-8" })
            : buildEnvelope(sender!, "assignment", params.initialPrompt, "inline");
          await runPrompt(deps.cli, resolvedPaneId, envelope, abortSignal);
          initialPromptSent = true;
          progress(onUpdate, phase, created);
        }
        const postState = paneRecord(await run(deps.cli, ["pane", "get", resolvedPaneId], abortSignal), resolvedPaneId);
        if (params.initialPrompt !== undefined && stateFrom(postState) !== "working") {
          throw new LaunchError("POSTSTATE_UNAVAILABLE", "Initial prompt did not produce a verified working state");
        }
        agentId ??= idFrom(postState, "agent_id");
        const authoritativeName = returnedName ?? stringFrom(postState, "agent_name") ?? stringFrom(postState, "name");
        if (!authoritativeName) throw new LaunchError("CLI_PROTOCOL_ERROR", "Herdr launch post-state omitted authoritative agent name");
        const identity = { agentName: authoritativeName, ...(agentId ? { agentId } : {}) };
        const recipient = profileResolution && recipientKey && capability
          ? { recipientKey, paneId: resolvedPaneId, agentName: authoritativeName, ...(agentId ? { agentId } : {}), profileName: profileResolution.profile.name, kind: capability.kind, capable: capability.capable, reason: capability.reason }
          : undefined;
        if (recipient && deps.recipients) deps.recipients.recordFor(profileResolution!.profile.name, resolvedPaneId, recipient.recipientKey, capability!, identity);
        const details: LaunchDetails = {
          operation: "launch",
          outcome: "launched",
          name: authoritativeName,
          kind: effectiveKind,
          placement,
          tabId,
          paneId: resolvedPaneId,
          ...(agentId ? { agentId } : {}),
          postState,
          initialPromptSent,
          ...(initialPromptDelivery ? { initialPromptDelivery } : {}),
          ...(sender ? {
            sender: { paneId: sender.paneId, display: sender.display, source: sender.source },
            envelope: { version: "v1" as const, kind: "assignment" as const, delivery: initialPromptDelivery! },
            ...(published ? { attachment: published } : {})
          } : {}),
          ...(recipient ? { recipient } : {}),
          ...(profileResolution ? { profile: { name: profileResolution.profile.name, source: { kind: profileResolution.profile.source.kind, path: profileResolution.profile.source.path }, timeoutMinutes: profileResolution.profile.timeoutMinutes, sessionPersistence: profileResolution.profile.sessionPersistence, fallbackProfiles: [...profileResolution.fallbackProfiles], reachableNames: [...profileResolution.reachableNames] } } : {})
        };
        return { content: [{ type: "text", text: formatResult({ operation: "launch", outcome: "success", targetId: paneId, delivery: initialPromptDelivery }) }], details };
      } catch (error) {
        throw partialError(error, created, phase);
      }
    },
    renderCall(args, theme) {
      const kind = "kind" in args ? args.kind : "profile";
      const delivery = args.initialPrompt !== undefined ? args.initialPromptDelivery ?? "inline" : undefined;
      return textComponent(formatCall("herdr_launch", delivery ? `${kind} · ${delivery}` : kind, args.name), theme, "accent");
    },
    renderResult(result, options, theme) {
      return renderResultComponent("launch", result, options, theme, result.details?.paneId);
    }
  };
}

export { validateParams as validateLaunchParams };
