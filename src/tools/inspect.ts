import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { callerPolicyDiagnostics, callerPolicyFailure, classifyCaller } from "../caller-policy.js";
import type { HerdrCli } from "../cli.js";
import { contextRebindingDetails, createContextResolver, type ContextResolutionDiagnostics, type ContextResolver } from "../context.js";
import { projectHandoffEvidence, type HandoffGate, type HandoffInspection, type HandoffUngatedReason } from "../handoff-gate.js";
import { parseHealth } from "../health.js";
import { PromptIdentityError } from "../messages/prompt.js";
import { InspectParamsSchema, type InspectParams } from "../schemas.js";
import { resolvePaneOrAgentTarget, type CurrentContext, type HerdrSnapshot } from "../targets.js";
import { requireWaitTargetIdentity, type WaitTargetIdentity } from "../wait-target-evidence.js";
import { formatCall, renderResultComponent, textComponent } from "../tui.js";
import { RESERVED_BUNDLED_PROFILE_NAMES, resolveProfile, type Profile, type ProfileCandidate, type ProfileCatalog, MAX_PROFILE_BODY_OUTPUT, MAX_PROFILE_LIST_ITEMS, MAX_PROFILE_RESULT_BYTES } from "../profiles/index.js";
import { boundedText } from "../job-registry.js";
import { modelSafeJson } from "../redaction.js";

interface InspectDetails {
  operation: "inspect";
  kind: "target" | "collection" | "health" | "profile";
  outcome: "success";
  target?: { paneId?: string; tabId?: string; workspaceId?: string; label?: string; agentName?: string };
  collection?: string;
  items?: unknown[];
  profile?: unknown;
  diagnostics?: unknown[];
  context?: ContextResolutionDiagnostics;
  callerPolicy?: unknown;
  contextRebinding?: ContextResolutionDiagnostics;
  truncated?: boolean;
  omittedCount?: number;
  diagnosticOmittedCount?: number;
  metadata?: unknown;
  /** Bounded managed-handoff evidence for the exact current occupant, or why the target is ungated. */
  handoff?: HandoffInspection;
  recentUnwrappedLines?: string[];
  client?: { version: string; protocol: number };
  server?: { status: string; version?: string; protocol?: number };
  socketReachable?: boolean;
  compatible?: boolean;
  environment?: { enabled: boolean; currentIdsPresent: boolean; currentIdsValid: boolean };
}

export interface InspectDependencies {
  cli: HerdrCli;
  context: CurrentContext;
  contextResolver?: ContextResolver;
  environment?: { enabled: boolean; currentIdsPresent: boolean; currentIdsValid: boolean };
  profiles?: { load: () => Promise<ProfileCatalog> };
  /** The shared managed-handoff gate; absent on a host that cannot gate. */
  handoffs?: HandoffGate;
}

function asPane(result: unknown): Record<string, unknown> {
  if (typeof result !== "object" || result === null || !("pane" in result) || typeof (result as { pane?: unknown }).pane !== "object" || (result as { pane?: unknown }).pane === null) {
    throw Object.assign(new Error("Invalid Herdr pane response"), { code: "CLI_PROTOCOL_ERROR" });
  }
  return (result as { pane: Record<string, unknown> }).pane;
}

const COMPACT_COLLECTION_KEYS: Record<"panes" | "agents" | "tabs", readonly string[]> = {
  panes: ["pane_id", "tab_id", "workspace_id", "parent_id", "agent_id", "label", "agent_name", "agent", "agent_status", "status"],
  agents: ["agent_id", "pane_id", "parent_id", "name", "agent", "agent_status", "status"],
  tabs: ["tab_id", "workspace_id", "parent_id", "label"]
};

const MAX_INSPECT_COLLECTION_ITEMS = 100;
const MAX_COLLECTION_FIELD_BYTES = 256;

function compactEnvironment(value: InspectDependencies["environment"] | undefined, context: CurrentContext): InspectDetails["environment"] {
  return {
    enabled: value?.enabled ?? true,
    currentIdsPresent: value?.currentIdsPresent ?? Boolean(context.workspaceId && context.tabId && context.paneId),
    currentIdsValid: value?.currentIdsValid ?? true
  };
}

/**
 * Bounded caller-policy evidence for context mode (ADR-030). A caller whose
 * policy evidence is malformed still gets its context report — the failure is
 * surfaced as `{scope:"unavailable", code}` instead of breaking inspection.
 */
function callerPolicyEvidence(snapshot: HerdrSnapshot, paneId: string): Record<string, unknown> {
  try {
    return callerPolicyDiagnostics(classifyCaller(snapshot, paneId));
  } catch (error) {
    return callerPolicyFailure(error);
  }
}

function compactCollectionRecord(value: Record<string, unknown>, collection: "panes" | "agents" | "tabs"): Record<string, unknown> {
  const allowed = new Set(COMPACT_COLLECTION_KEYS[collection]);
  return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => allowed.has(key) && typeof item === "string")
    .map(([key, item]) => [key, boundedText(item as string, MAX_COLLECTION_FIELD_BYTES)]));
}

function compactCollection(snapshot: HerdrSnapshot, collection: "panes" | "agents" | "tabs", context: { workspaceId: string; tabId: string }): Record<string, unknown>[] {
  if (collection === "panes") return snapshot.panes.filter((pane) => pane.workspace_id === context.workspaceId && pane.tab_id === context.tabId).map((pane) => compactCollectionRecord(pane, collection));
  if (collection === "tabs") return snapshot.tabs.filter((tab) => tab.workspace_id === context.workspaceId).map((tab) => compactCollectionRecord(tab, collection));
  const currentPaneIds = new Set(snapshot.panes.filter((pane) => pane.workspace_id === context.workspaceId && pane.tab_id === context.tabId).map((pane) => pane.pane_id));
  return snapshot.agents.filter((agent) => currentPaneIds.has(agent.pane_id)).map((agent) => compactCollectionRecord(agent, collection));
}

function sourceDetails(profile: Profile): Record<string, unknown> {
  return { kind: boundedText(profile.source.kind, 32), path: boundedText(profile.source.path, 512), scopeRoot: boundedText(profile.source.scopeRoot, 512), precedence: profile.source.precedence };
}

function boundedValues(values: readonly string[], limit = 16, fieldLimit = 256): string[] {
  return values.slice(0, limit).map((value) => boundedText(value, fieldLimit));
}

function compactProfile(profile: Profile): Record<string, unknown> {
  const runtime = profile.runtime.kind === "pi"
    ? {
      thinking: profile.runtime.thinking,
      tools: boundedValues(profile.runtime.tools, 32, 128),
      extensions: boundedValues(profile.runtime.extensions, 16, 512),
      skills: boundedValues(profile.runtime.skills, 16, 512)
    }
    : profile.runtime.kind === "claude"
      ? {
        effort: profile.runtime.effort,
        permissionMode: profile.runtime.permissionMode,
        allowedTools: boundedValues(profile.runtime.allowedTools, 32, 128),
        disallowedTools: boundedValues(profile.runtime.disallowedTools, 16, 128),
        addDirs: boundedValues(profile.runtime.addDirs, 16, 512),
        pluginDirs: boundedValues(profile.runtime.pluginDirs, 16, 512)
      }
      : profile.runtime.kind === "devin"
        ? {
          permissionMode: profile.runtime.permissionMode
        }
        : {
          mode: profile.runtime.mode,
          dangerouslySkipPermissions: true,
          addDirs: boundedValues(profile.runtime.addDirs, 16, 512)
        };
  return {
    name: boundedText(profile.name, 128),
    description: boundedText(profile.description, 512),
    kind: profile.runtime.kind,
    model: boundedText(profile.runtime.model, 256),
    ...runtime,
    timeoutMinutes: profile.timeoutMinutes,
    sessionPersistence: profile.sessionPersistence,
    fallbackProfiles: boundedValues(profile.fallbackProfiles, 16, 128),
    source: sourceDetails(profile)
  };
}

const PROFILE_SCOPE_PRECEDENCE = { bundled: 0, user: 1, project: 2 } as const;

function highestUnreadableScope(catalog: ProfileCatalog): Profile["source"]["kind"] | undefined {
  return [...(catalog.unreadableScopes ?? [])].sort((left, right) => PROFILE_SCOPE_PRECEDENCE[right] - PROFILE_SCOPE_PRECEDENCE[left])[0];
}

function invalidCandidate(candidates: readonly ProfileCandidate[]): ProfileCandidate | undefined {
  return [...candidates]
    .filter((candidate) => candidate.diagnostic !== undefined)
    .sort((left, right) => right.source.precedence - left.source.precedence)[0];
}

interface ProfileCollectionResult {
  items: Record<string, unknown>[];
  totalCount: number;
}

type CollectionBlocker =
  | { kind: "effective"; precedence: number; profile: Profile }
  | { kind: "invalid"; precedence: number; candidate: ProfileCandidate }
  | { kind: "unreadable"; precedence: number; scope: Profile["source"]["kind"] };

function compareCollectionBlockers(left: CollectionBlocker, right: CollectionBlocker): number {
  const precedence = right.precedence - left.precedence;
  return precedence !== 0 ? precedence : Number(right.kind !== "unreadable") - Number(left.kind !== "unreadable");
}

function highestCollectionBlocker(catalog: ProfileCatalog, name: string, value: Profile | undefined, candidates: readonly ProfileCandidate[]): CollectionBlocker | undefined {
  if (RESERVED_BUNDLED_PROFILE_NAMES.has(name) && value?.source.kind === "bundled") return { kind: "effective", precedence: value.source.precedence, profile: value };
  const blockers: CollectionBlocker[] = [];
  if (value) blockers.push({ kind: "effective", precedence: value.source.precedence, profile: value });
  const invalid = invalidCandidate(candidates);
  if (invalid) blockers.push({ kind: "invalid", precedence: invalid.source.precedence, candidate: invalid });
  const unreadable = highestUnreadableScope(catalog);
  if (unreadable) blockers.push({ kind: "unreadable", precedence: PROFILE_SCOPE_PRECEDENCE[unreadable], scope: unreadable });
  blockers.sort(compareCollectionBlockers);
  return blockers[0];
}

function profileCollection(catalog: ProfileCatalog): ProfileCollectionResult {
  const grouped = new Map<string, ProfileCandidate[]>();
  for (const candidate of catalog.candidates) grouped.set(candidate.name, [...(grouped.get(candidate.name) ?? []), candidate]);
  const entries = new Map<string, Record<string, unknown>>();
  for (const [name, candidates] of grouped) {
    const effective = catalog.effective.get(name);
    const blocker = highestCollectionBlocker(catalog, name, effective, candidates);
    if (blocker?.kind === "effective") {
      entries.set(name, compactProfile(blocker.profile));
      continue;
    }
    if (blocker?.kind === "invalid") {
      entries.set(name, {
        name: boundedText(name, 128),
        valid: false,
        source: { kind: boundedText(blocker.candidate.source.kind, 32), path: boundedText(blocker.candidate.source.path, 512) },
        diagnostic: boundedText(blocker.candidate.diagnostic?.message ?? "invalid profile", 512)
      });
      continue;
    }
    if (blocker?.kind === "unreadable") {
      const unreadableDiagnostic = catalog.diagnostics.find((item) => item.code === "DISCOVERY_ERROR" && item.source?.kind === blocker.scope);
      entries.set(name, {
        name: boundedText(name, 128),
        valid: false,
        source: unreadableDiagnostic?.source
          ? { kind: boundedText(unreadableDiagnostic.source.kind, 32), path: boundedText(unreadableDiagnostic.source.path, 512) }
          : { kind: boundedText(blocker.scope, 32), path: "<unreadable scope>" },
        diagnostic: boundedText(unreadableDiagnostic?.message ?? `blocked by unreadable ${blocker.scope} profile scope`, 512)
      });
    }
  }
  const allEntries = [...entries.values()].sort((left, right) => String(left.name).localeCompare(String(right.name)));
  const items: Record<string, unknown>[] = [];
  for (const entry of allEntries) {
    if (items.length >= MAX_PROFILE_LIST_ITEMS) break;
    const candidate = [...items, entry];
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_PROFILE_RESULT_BYTES) break;
    items.push(entry);
  }
  return { items, totalCount: allEntries.length };
}

function boundedBody(body: string): string {
  if (Buffer.byteLength(body, "utf8") <= MAX_PROFILE_BODY_OUTPUT) return body;
  return `${boundedText(body, MAX_PROFILE_BODY_OUTPUT - 64)}\n[profile body truncated]`;
}

function exactProfile(catalog: ProfileCatalog, name: string): Record<string, unknown> {
  const resolution = resolveProfile(name, catalog);
  const profile = resolution.profile;
  const runtime = profile.runtime.kind === "pi"
    ? {
      kind: "pi",
      model: boundedText(profile.runtime.model, 256),
      thinking: profile.runtime.thinking,
      tools: boundedValues(profile.runtime.tools, 32, 128),
      extensions: boundedValues(profile.runtime.extensions, 16, 512),
      skills: boundedValues(profile.runtime.skills, 16, 512)
    }
    : profile.runtime.kind === "claude"
      ? {
        kind: "claude",
        model: boundedText(profile.runtime.model, 256),
        effort: profile.runtime.effort,
        permissionMode: profile.runtime.permissionMode,
        allowedTools: boundedValues(profile.runtime.allowedTools, 32, 128),
        disallowedTools: boundedValues(profile.runtime.disallowedTools, 16, 128),
        addDirs: boundedValues(profile.runtime.addDirs, 16, 512),
        pluginDirs: boundedValues(profile.runtime.pluginDirs, 16, 512)
      }
      : profile.runtime.kind === "devin"
        ? {
          kind: "devin",
          model: boundedText(profile.runtime.model, 256),
          permissionMode: profile.runtime.permissionMode
        }
        : {
          kind: "agy",
          model: boundedText(profile.runtime.model, 256),
          mode: profile.runtime.mode,
          dangerouslySkipPermissions: true,
          addDirs: boundedValues(profile.runtime.addDirs, 16, 512)
        };
  return {
    ...compactProfile(profile),
    runtime,
    body: boundedBody(profile.body),
    fallbackProfiles: boundedValues(resolution.fallbackProfiles, 16, 128),
    reachableNames: boundedValues(resolution.reachableNames, 16, 128)
  };
}

function modelVisibleProfile(profile: Record<string, unknown>): Record<string, unknown> {
  const runtime = profile.runtime as Record<string, unknown> | undefined;
  const source = profile.source as Record<string, unknown> | undefined;
  return {
    name: boundedText(String(profile.name), 128),
    description: boundedText(String(profile.description), 512),
    kind: boundedText(String(profile.kind), 32),
    ...(runtime?.model !== undefined ? { model: boundedText(String(runtime.model), 256) } : { model: boundedText(String(profile.model), 256) }),
    ...(runtime?.thinking !== undefined ? { thinking: boundedText(String(runtime.thinking), 32) } : profile.thinking !== undefined ? { thinking: boundedText(String(profile.thinking), 32) } : {}),
    ...(runtime?.effort !== undefined ? { effort: boundedText(String(runtime.effort), 32) } : profile.effort !== undefined ? { effort: boundedText(String(profile.effort), 32) } : {}),
    ...(profile.kind === "agy" ? { mode: boundedText(String(runtime?.mode ?? profile.mode), 32), dangerouslySkipPermissions: true } : {}),
    tools: boundedValues((profile.tools as string[] | undefined) || [], 32, 128),
    extensions: boundedValues((profile.extensions as string[] | undefined) || [], 16, 512),
    skills: boundedValues((profile.skills as string[] | undefined) || [], 16, 512),
    permissionMode: profile.permissionMode ?? runtime?.permissionMode,
    allowedTools: boundedValues((profile.allowedTools as string[] | undefined) || [], 32, 128),
    disallowedTools: boundedValues((profile.disallowedTools as string[] | undefined) || [], 32, 128),
    addDirs: boundedValues((profile.addDirs as string[] | undefined) || [], 16, 512),
    pluginDirs: boundedValues((profile.pluginDirs as string[] | undefined) || [], 16, 512),
    timeoutMinutes: profile.timeoutMinutes,
    sessionPersistence: profile.sessionPersistence,
    fallbackProfiles: (profile.fallbackProfiles as string[]).slice(0, 16).map((item) => boundedText(String(item), 128)),
    source: { kind: boundedText(String(source?.kind), 32), path: boundedText(String(source?.path), 512) }
  };
}

function modelVisibleDiagnostics(diagnostics: readonly unknown[]): unknown[] {
  return diagnostics.slice(0, 16).map((diagnostic) => {
    const value = diagnostic as Record<string, unknown>;
    return {
      code: boundedText(String(value.code), 64),
      ...(value.name !== undefined ? { name: boundedText(String(value.name), 128) } : {}),
      message: boundedText(String(value.message), 512),
      path: boundedText(String(value.path), 512)
    };
  });
}

export const MAX_INSPECT_CONTENT_BYTES = 50 * 1024;
const MAX_PROFILE_CONTENT_BYTES = 16_000;
const OUTPUT_TRUNCATED_DIAGNOSTIC = Object.freeze({ code: "OUTPUT_TRUNCATED", message: "inspection output was truncated to fit the byte limit" });

function jsonBytes(value: unknown): number {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 0 : Buffer.byteLength(encoded, "utf8");
}

function truncationEvidence(value: unknown, maxBytes: number): unknown {
  const objectValue = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const existingDiagnostics = objectValue && Array.isArray(objectValue.diagnostics) ? objectValue.diagnostics : [];
  const marked = objectValue
    ? { ...objectValue, truncated: true, diagnostics: [...existingDiagnostics, OUTPUT_TRUNCATED_DIAGNOSTIC] }
    : { value, truncated: true, diagnostics: [OUTPUT_TRUNCATED_DIAGNOSTIC] };
  return jsonBytes(marked) <= maxBytes ? marked : { truncated: true, diagnostics: [OUTPUT_TRUNCATED_DIAGNOSTIC] };
}

interface MutableValueRef {
  owner: Record<string, unknown> | unknown[];
  key: string | number;
  value: unknown;
}

function collectValueRefs(value: unknown, strings: MutableValueRef[], arrays: MutableValueRef[], objects: MutableValueRef[], owner?: Record<string, unknown> | unknown[], key?: string | number, seen = new WeakSet<object>()): void {
  if (typeof value === "string") {
    if (owner !== undefined && key !== undefined) strings.push({ owner, key, value });
    return;
  }
  if (typeof value !== "object" || value === null) return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    if (owner !== undefined && key !== undefined) arrays.push({ owner, key, value });
    value.forEach((item, index) => collectValueRefs(item, strings, arrays, objects, value, index, seen));
    return;
  }
  if (owner !== undefined && key !== undefined) objects.push({ owner, key, value });
  for (const [childKey, child] of Object.entries(value)) collectValueRefs(child, strings, arrays, objects, value as Record<string, unknown>, childKey, seen);
}

export function fitInspectionValue(value: unknown, maxBytes: number): unknown {
  let candidate: unknown;
  try { candidate = structuredClone(value); } catch { return truncationEvidence({ value: "inspection value could not be cloned" }, maxBytes); }
  if (jsonBytes(candidate) <= maxBytes) return candidate;
  const fittingLimit = Math.max(0, maxBytes - jsonBytes({ truncated: true, diagnostics: [OUTPUT_TRUNCATED_DIAGNOSTIC] }) - 16);
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (jsonBytes(candidate) <= fittingLimit) return truncationEvidence(candidate, maxBytes);
    const strings: MutableValueRef[] = [];
    const arrays: MutableValueRef[] = [];
    const objects: MutableValueRef[] = [];
    collectValueRefs(candidate, strings, arrays, objects);
    const longest = strings.sort((left, right) => Buffer.byteLength(String(right.value), "utf8") - Buffer.byteLength(String(left.value), "utf8"))[0];
    if (longest) {
      const current = String(longest.value);
      const next = boundedText(current, Math.max(2, Math.ceil(Buffer.byteLength(current, "utf8") / 2)));
      const replacement = next === current ? "" : next;
      (longest.owner as Record<string | number, unknown>)[longest.key] = replacement;
      continue;
    }
    const largestArray = arrays.filter((item) => Array.isArray(item.value) && item.key !== "diagnostics").sort((left, right) => (right.value as unknown[]).length - (left.value as unknown[]).length)[0];
    if (largestArray && Array.isArray(largestArray.value) && largestArray.value.length > 0) {
      largestArray.value.splice(Math.ceil(largestArray.value.length / 2));
      continue;
    }
    const removable = objects.flatMap((item) => Object.keys(item.value as Record<string, unknown>).filter((objectKey) => !["profile", "diagnostics", "source", "name", "kind", "handoff"].includes(objectKey)).map((objectKey) => ({ owner: item.value as Record<string, unknown>, key: objectKey })))[0];
    if (removable) {
      delete removable.owner[removable.key];
      continue;
    }
    break;
  }
  return truncationEvidence(candidate, maxBytes);
}

function boundedInspectionDetails<T extends InspectDetails>(details: T): T {
  return fitInspectionValue(details, MAX_PROFILE_RESULT_BYTES) as T;
}

function fitProfileCollection(value: Record<string, unknown>, totalCount: number, maxBytes: number, totalDiagnostics: number): Record<string, unknown> {
  const items = value.items as unknown[];
  const diagnostics = value.diagnostics as unknown[];
  if (jsonBytes(value) <= maxBytes && items.length === totalCount && diagnostics.length === totalDiagnostics && value.truncated !== true) return value;
  const fixed = { ...value };
  delete fixed.items;
  delete fixed.diagnostics;
  delete fixed.truncated;
  delete fixed.omittedCount;
  delete fixed.diagnosticOmittedCount;
  const retainedDiagnostics = diagnostics.filter((diagnostic) => !(typeof diagnostic === "object" && diagnostic !== null && (diagnostic as Record<string, unknown>).code === "OUTPUT_TRUNCATED"));
  const selectItems = (diagnosticSubset: unknown[]): Record<string, unknown> | undefined => {
    for (let count = items.length; count >= 0; count -= 1) {
      const candidate = {
        ...fixed,
        items: items.slice(0, count),
        truncated: true,
        omittedCount: totalCount - count,
        diagnosticOmittedCount: totalDiagnostics - diagnosticSubset.length,
        diagnostics: [...diagnosticSubset, OUTPUT_TRUNCATED_DIAGNOSTIC]
      };
      if (jsonBytes(candidate) <= maxBytes) return candidate;
    }
    return undefined;
  };
  let candidate = selectItems(retainedDiagnostics);
  for (let count = retainedDiagnostics.length - 1; !candidate && count >= 0; count -= 1) candidate = selectItems(retainedDiagnostics.slice(0, count));
  return candidate!;
}

function modelVisibleContent(value: Record<string, unknown>, maxBytes = MAX_PROFILE_CONTENT_BYTES): string {
  const safe = modelSafeJson(value);
  return JSON.stringify(fitInspectionValue(safe, maxBytes)) as string;
}

function modelVisibleInspectionContent(value: InspectDetails): string {
  // Keep the model-bound result self-describing. The marker also prevents the
  // MCP host from mistaking this Pi-facing projection for its authoritative
  // details block and dropping the latter.
  return modelVisibleContent({ ...value, modelVisible: true }, MAX_INSPECT_CONTENT_BYTES);
}

/**
 * Exact-current-run handoff evidence for a pane/agent target. The identity is
 * joined from the fresh pane read and the snapshot's agent record; when those
 * records cannot prove the current occupant the block reports why it is
 * ungated rather than staying silent. A bound run gets a fresh artifact
 * verdict so the projection never reports a stale gate state.
 */
async function targetHandoff(deps: InspectDependencies, pane: Record<string, unknown>, agent: Record<string, unknown> | undefined, paneId: string): Promise<HandoffInspection> {
  let identity: WaitTargetIdentity | undefined;
  let reason: HandoffUngatedReason = "identity_unavailable";
  try {
    identity = requireWaitTargetIdentity(agent === undefined ? [pane] : [pane, agent], paneId);
  } catch (error) {
    if (error instanceof PromptIdentityError && error.code === "TARGET_IDENTITY_CHANGED") reason = "identity_changed";
  }
  const gate = deps.handoffs;
  if (identity !== undefined && gate !== undefined) {
    const run = gate.lookup(identity);
    if (run !== undefined) await gate.validate(run).catch(() => undefined);
  }
  return projectHandoffEvidence(gate, identity, reason);
}

export function createInspectTool(deps: InspectDependencies): ToolDefinition<typeof InspectParamsSchema, InspectDetails> {
  return {
    name: "herdr_inspect",
    label: "Herdr Inspect",
    description: "Inspect exact Herdr context, targets, compact collections, profiles, or health.",
    parameters: InspectParamsSchema,
    async execute(_id, params: InspectParams, signal) {
      const input = params as InspectParams;
      const activeSignal = signal ?? new AbortController().signal;
      const mode = input.mode ?? "context";
      const profileMode = mode === "profile" || (mode === "collection" && input.collection === "profiles");
      if (profileMode) {
        if (mode === "profile" && (input.profile === undefined || input.collection !== undefined || input.target !== undefined)) throw Object.assign(new Error("profile mode requires profile and rejects target/collection"), { code: "INVALID_INPUT" });
        if (mode === "collection" && (input.profile !== undefined || input.target !== undefined)) throw Object.assign(new Error("profile collection rejects profile/target"), { code: "INVALID_INPUT" });
        if (!deps.profiles) throw Object.assign(new Error("Profile catalog is unavailable"), { code: "PROFILE_CATALOG_UNAVAILABLE" });
        const catalog = await deps.profiles.load();
        if (mode === "collection") {
          const collection = profileCollection(catalog);
          const diagnostics = modelVisibleDiagnostics(catalog.diagnostics.slice(0, 16));
          const totalDiagnostics = catalog.diagnosticCount ?? catalog.diagnostics.length;
          const details = fitProfileCollection({ operation: "inspect", kind: "collection", collection: "profiles", outcome: "success", items: collection.items, diagnostics }, collection.totalCount, MAX_PROFILE_RESULT_BYTES, totalDiagnostics) as unknown as InspectDetails;
          const content = fitProfileCollection({ collection: "profiles", items: collection.items.map((item) => item.valid === false ? { name: item.name, valid: false, source: item.source, diagnostic: item.diagnostic } : modelVisibleProfile(item)), diagnostics }, collection.totalCount, MAX_PROFILE_CONTENT_BYTES, totalDiagnostics);
          return { content: [{ type: "text", text: JSON.stringify(content) }], details };
        }
        const profile = exactProfile(catalog, input.profile!);
        const diagnostics = modelVisibleDiagnostics(catalog.diagnostics.filter((item) => item.name === input.profile).slice(0, 8));
        const visibleProfile = {
          ...modelVisibleProfile(profile),
          body: boundedText(String(profile.body), MAX_PROFILE_BODY_OUTPUT),
          fallbackProfiles: (profile.fallbackProfiles as string[]).slice(0, 16).map((item) => boundedText(String(item), 128)),
          reachableNames: (profile.reachableNames as string[]).slice(0, 16).map((item) => boundedText(String(item), 128))
        };
        const content = modelVisibleContent({ profile: visibleProfile, diagnostics });
        const details = boundedInspectionDetails({ operation: "inspect", kind: "profile", outcome: "success", profile, diagnostics });
        return { content: [{ type: "text", text: content }], details };
      }
      if (mode === "health") {
        if (input.target !== undefined || input.collection !== undefined || input.profile !== undefined) throw Object.assign(new Error("health does not accept target, profile, or collection"), { code: "INVALID_INPUT" });
        const health = parseHealth(await deps.cli.runText(["status", "--json"], activeSignal));
        const environment = compactEnvironment(deps.environment, deps.context);
        const details: InspectDetails = { operation: "inspect", kind: "health", outcome: "success", environment, ...health };
        const bounded = boundedInspectionDetails(details);
        return { content: [{ type: "text", text: modelVisibleInspectionContent(bounded) }], details: bounded };
      }
      if (mode === "collection") {
        if (!input.collection || input.target !== undefined || input.profile !== undefined) throw Object.assign(new Error("collection mode requires collection and rejects target/profile"), { code: "INVALID_INPUT" });
      } else if (input.collection !== undefined || input.profile !== undefined || (mode === "context" && input.target !== undefined)) {
        throw Object.assign(new Error("collection, profile, and target are only valid in their respective modes"), { code: "INVALID_INPUT" });
      } else if (mode === "target" && input.target === undefined) throw Object.assign(new Error("target mode requires target"), { code: "INVALID_INPUT" });
      const effective = await (deps.contextResolver ?? createContextResolver(deps.cli, deps.context))(activeSignal);
      const snapshot = effective.snapshot;
      if (mode === "collection") {
        const allItems = compactCollection(snapshot, input.collection as "panes" | "agents" | "tabs", effective.context);
        const items = allItems.slice(0, MAX_INSPECT_COLLECTION_ITEMS);
        const omittedCount = allItems.length - items.length;
        const details: InspectDetails = {
          operation: "inspect",
          kind: "collection",
          outcome: "success",
          collection: input.collection,
          items,
          ...(omittedCount > 0 ? { truncated: true, omittedCount } : {}),
          ...contextRebindingDetails(effective.diagnostics)
        };
        const bounded = boundedInspectionDetails(details);
        return { content: [{ type: "text", text: modelVisibleInspectionContent(bounded) }], details: bounded };
      }
      const target = resolvePaneOrAgentTarget(snapshot, input.target ?? "current", effective.context);
      const pane = asPane((await deps.cli.runJson(["pane", "get", target.paneId!], activeSignal)).result);
      const raw = await deps.cli.runTextResult(["pane", "read", target.paneId!, "--source", "recent-unwrapped", "--lines", "100", "--format", "text"], activeSignal);
      const recentUnwrappedLines = raw.value.length === 0 ? [] : raw.value.split(/\r?\n/).slice(-100);
      const handoff = await targetHandoff(deps, pane, snapshot.agents.find((agent) => agent.pane_id === target.paneId), target.paneId!);
      const details: InspectDetails = {
        operation: "inspect",
        kind: "target",
        outcome: "success",
        target: { paneId: target.paneId, tabId: target.tabId, workspaceId: target.workspaceId, label: target.label, agentName: target.agentName },
        handoff,
        ...(mode === "context" ? { context: effective.diagnostics, callerPolicy: callerPolicyEvidence(snapshot, effective.context.paneId) } : contextRebindingDetails(effective.diagnostics)),
        metadata: modelSafeJson(pane),
        recentUnwrappedLines,
        ...(raw.truncated ? { truncated: true } : {})
      };
      const bounded = boundedInspectionDetails(details);
      return { content: [{ type: "text", text: modelVisibleInspectionContent(bounded) }], details: bounded };
    },
    renderCall(rawArgs, theme) {
      const args = rawArgs as InspectParams;
      return textComponent(formatCall("herdr_inspect", args.mode ?? "context", args.target ?? args.profile), theme, "accent");
    },
    renderResult(result, options, theme) { return renderResultComponent("inspect", result, options, theme, result.details?.target?.paneId); }
  };
}
