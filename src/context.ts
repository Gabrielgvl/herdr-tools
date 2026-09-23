import type { JsonEnvelope } from "./cli.js";
import { boundAgentSessionStrings, optionalCandidateStrings, optionalSessionCandidate, PromptIdentityError, type AgentSessionIdentity } from "./messages/prompt.js";
import { parseSnapshotResult, type CurrentContext, type HerdrSnapshot, type PaneRecord } from "./targets.js";

export interface ResolvedContext {
  readonly workspaceId: string;
  readonly tabId: string;
  readonly paneId: string;
}

export interface ContextResolutionDiagnostics {
  readonly injected: ResolvedContext;
  readonly effective: ResolvedContext;
  readonly rebound: boolean;
  readonly attempts: number;
}

export interface ContextOperationIds {
  readonly current: string;
  readonly snapshot: string;
}

export interface EffectiveContext {
  readonly context: ResolvedContext;
  readonly snapshot: HerdrSnapshot;
  readonly diagnostics: ContextResolutionDiagnostics;
  readonly operationIds: ContextOperationIds;
}

export interface ContextCli {
  runJson(argv: string[], signal: AbortSignal): Promise<JsonEnvelope>;
}

export type ContextResolver = (signal: AbortSignal) => Promise<EffectiveContext>;

export const CONTEXT_RESOLUTION_ATTEMPTS = 2;

export class ContextResolutionError extends Error {
  readonly code = "CONTEXT_UNAVAILABLE" as const;

  constructor(message: string, readonly details: Record<string, unknown> = {}, readonly retryable = false) {
    super(message);
    this.name = "ContextResolutionError";
  }
}

interface CurrentPaneIdentity extends ResolvedContext {
  terminalId?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\u0000") && !value.includes("\r") && !value.includes("\n");
}

function bounded(value: string): string {
  return [...value].slice(0, 256).join("");
}

function diagnosticContext(context: ResolvedContext): ResolvedContext {
  return {
    workspaceId: bounded(context.workspaceId),
    tabId: bounded(context.tabId),
    paneId: bounded(context.paneId)
  };
}

function contextError(message: string, details: Record<string, unknown>, retryable = false): ContextResolutionError {
  return new ContextResolutionError(`CONTEXT_UNAVAILABLE: ${message}`, details, retryable);
}

function protocolError(message: string, details: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`CLI_PROTOCOL_ERROR: ${message}`), { code: "CLI_PROTOCOL_ERROR", details });
}

function injectedContext(context: CurrentContext): ResolvedContext {
  if (!safeIdentifier(context.workspaceId)) throw contextError("injected workspace identity is missing or malformed", { field: "workspaceId" });
  if (!safeIdentifier(context.tabId)) throw contextError("injected tab identity is missing or malformed", { field: "tabId" });
  if (!safeIdentifier(context.paneId)) throw contextError("injected pane identity is missing or malformed", { field: "paneId" });
  return { workspaceId: context.workspaceId, tabId: context.tabId, paneId: context.paneId };
}

function requiredIdentity(value: Record<string, unknown>, source: string): ResolvedContext {
  const fields: Array<[keyof ResolvedContext, string]> = [
    ["paneId", "pane_id"],
    ["tabId", "tab_id"],
    ["workspaceId", "workspace_id"]
  ];
  const result: { workspaceId: string; tabId: string; paneId: string } = { workspaceId: "", tabId: "", paneId: "" };
  for (const [property, field] of fields) {
    if (!safeIdentifier(value[field])) throw protocolError(`${source} response has a missing or malformed ${field}`, { source, field });
    result[property] = value[field] as string;
  }
  return result;
}

function optionalTerminalId(value: Record<string, unknown>, source: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(value, "terminal_id")) return undefined;
  const candidate = value.terminal_id;
  if (candidate === null || candidate === undefined) return undefined;
  if (!safeIdentifier(candidate)) throw protocolError(`${source} response has a malformed terminal_id`, { source, field: "terminal_id" });
  return candidate;
}

function currentPane(value: unknown): CurrentPaneIdentity {
  if (!record(value) || value.type !== "pane_current" || !record(value.pane)) {
    throw protocolError("pane current response is incompatible");
  }
  const pane = value.pane;
  const identity = requiredIdentity(pane, "pane_current");
  const terminalId = optionalTerminalId(pane, "pane_current");
  return { ...identity, ...(terminalId === undefined ? {} : { terminalId }) };
}

function paneRecord(snapshot: HerdrSnapshot, paneId: string): PaneRecord {
  const matches = snapshot.panes.filter((pane) => pane.pane_id === paneId);
  if (matches.length === 0) throw contextError("caller pane could not be resolved in the authoritative snapshot", { paneId: bounded(paneId), reason: "caller_unresolved" }, true);
  if (matches.length > 1) throw contextError("authoritative snapshot contains duplicate caller panes", { paneId: bounded(paneId), reason: "caller_ambiguous", candidates: matches.length });
  return matches[0]!;
}

function uniqueParent<T extends { [key: string]: unknown }>(records: T[], field: string, value: string, name: string): T {
  const matches = records.filter((item) => item[field] === value);
  if (matches.length === 0) throw contextError(`caller ${name} could not be resolved in the authoritative snapshot`, { [field]: bounded(value), reason: `${name}_unresolved` }, true);
  if (matches.length > 1) throw contextError(`authoritative snapshot contains duplicate caller ${name}s`, { [field]: bounded(value), reason: `${name}_ambiguous`, candidates: matches.length });
  return matches[0]!;
}

function verifySnapshot(current: CurrentPaneIdentity, snapshot: HerdrSnapshot, injected: ResolvedContext): ResolvedContext {
  if (current.paneId !== injected.paneId && snapshot.panes.some((candidate) => candidate.pane_id === injected.paneId)) {
    throw contextError("injected pane identity and live pane identity resolve to different panes", {
      reason: "pane_replaced",
      injectedPaneId: bounded(injected.paneId),
      livePaneId: bounded(current.paneId)
    });
  }
  const pane = paneRecord(snapshot, current.paneId);
  const tab = uniqueParent(snapshot.tabs as unknown as Array<Record<string, unknown>>, "tab_id", current.tabId, "tab");
  const workspace = uniqueParent(snapshot.workspaces as unknown as Array<Record<string, unknown>>, "workspace_id", current.workspaceId, "workspace");
  const paneIdentity = requiredIdentity(pane, "snapshot pane");
  if (paneIdentity.tabId !== current.tabId || paneIdentity.workspaceId !== current.workspaceId) {
    throw contextError("caller pane and live snapshot disagree about its containing topology", {
      reason: "topology_changed",
      paneId: bounded(current.paneId),
      currentTabId: bounded(current.tabId),
      snapshotTabId: bounded(paneIdentity.tabId),
      currentWorkspaceId: bounded(current.workspaceId),
      snapshotWorkspaceId: bounded(paneIdentity.workspaceId)
    }, true);
  }
  if (tab.workspace_id !== workspace.workspace_id || paneIdentity.tabId !== tab.tab_id || paneIdentity.workspaceId !== workspace.workspace_id) {
    throw contextError("caller pane, tab, and workspace relationships are incoherent", {
      reason: "topology_incoherent",
      paneId: bounded(current.paneId),
      tabId: bounded(current.tabId),
      workspaceId: bounded(current.workspaceId)
    }, true);
  }
  const currentTerminalId = current.terminalId;
  const snapshotTerminalId = optionalTerminalId(pane, "snapshot pane");
  if (currentTerminalId !== undefined && snapshotTerminalId !== undefined && currentTerminalId !== snapshotTerminalId) {
    throw contextError("caller pane terminal identity changed while resolving context", {
      reason: "pane_replaced",
      paneId: bounded(current.paneId),
      currentTerminalId: bounded(currentTerminalId),
      snapshotTerminalId: bounded(snapshotTerminalId)
    });
  }
  if (current.paneId !== injected.paneId && (currentTerminalId === undefined || snapshotTerminalId === undefined)) {
    throw contextError("caller pane replacement could not be ruled out", {
      reason: "pane_replaced",
      paneId: bounded(current.paneId),
      ...(currentTerminalId === undefined ? { currentTerminalId: "[missing]" } : {}),
      ...(snapshotTerminalId === undefined ? { snapshotTerminalId: "[missing]" } : {})
    });
  }
  return { workspaceId: workspace.workspace_id, tabId: tab.tab_id, paneId: paneIdentity.paneId };
}

async function readAttempt(cli: ContextCli, injected: ResolvedContext, signal: AbortSignal): Promise<{ context: ResolvedContext; snapshot: HerdrSnapshot; operationIds: ContextOperationIds }> {
  const currentEnvelope = await cli.runJson(["pane", "current", "--current"], signal);
  const currentResult = currentPane(currentEnvelope.result);
  const snapshotEnvelope = await cli.runJson(["api", "snapshot"], signal);
  const snapshot = parseSnapshotResult(snapshotEnvelope.result);
  const context = verifySnapshot(currentResult, snapshot, injected);
  return {
    context,
    snapshot,
    operationIds: { current: currentEnvelope.id, snapshot: snapshotEnvelope.id }
  };
}

export async function resolveEffectiveContext(cli: ContextCli, context: CurrentContext, signal: AbortSignal): Promise<EffectiveContext> {
  const injected = injectedContext(context);
  let lastRetryable: ContextResolutionError | undefined;
  for (let attempt = 1; attempt <= CONTEXT_RESOLUTION_ATTEMPTS; attempt += 1) {
    try {
      const result = await readAttempt(cli, injected, signal);
      const diagnostics: ContextResolutionDiagnostics = {
        injected: diagnosticContext(injected),
        effective: diagnosticContext(result.context),
        rebound: injected.workspaceId !== result.context.workspaceId || injected.tabId !== result.context.tabId || injected.paneId !== result.context.paneId,
        attempts: attempt
      };
      return { ...result, diagnostics };
    } catch (error) {
      if (!(error instanceof ContextResolutionError) || !error.retryable || attempt === CONTEXT_RESOLUTION_ATTEMPTS) throw error;
      lastRetryable = error;
    }
  }
  /* c8 ignore next -- every bounded attempt exits through a successful result or a typed error. */
  throw lastRetryable!;
}

export function createContextResolver(cli: ContextCli, context: CurrentContext): ContextResolver {
  return (signal) => resolveEffectiveContext(cli, context, signal);
}

/**
 * The manager's native agent session captured from the authoritative snapshot —
 * launch provenance resolved from the same records sender identity is, never a
 * caller-overridable field. The caller pane is already verified by context
 * resolution; this join proves which session actually occupied it: every
 * supplied record must agree, a present `agent_session` must be complete, and
 * duplicate or contradictory evidence fails closed. A caller with no native
 * session — a non-agent pane — records `null` rather than fabricating one.
 */
export function resolveManagerSession(snapshot: HerdrSnapshot, paneId: string): AgentSessionIdentity | null {
  const panes = snapshot.panes.filter((pane) => pane.pane_id === paneId);
  if (panes.length === 0) throw contextError("manager pane could not be resolved in the authoritative snapshot", { paneId: bounded(paneId), reason: "manager_unresolved" });
  if (panes.length > 1) throw contextError("authoritative snapshot contains duplicate manager panes", { paneId: bounded(paneId), reason: "manager_ambiguous", candidates: panes.length });
  const agents = snapshot.agents.filter((agent) => agent.pane_id === paneId);
  if (agents.length > 1) throw contextError("authoritative snapshot contains duplicate manager agents", { paneId: bounded(paneId), reason: "manager_ambiguous", candidates: agents.length });
  const records: Record<string, unknown>[] = [panes[0]!, ...agents];
  let session: AgentSessionIdentity | undefined;
  try {
    session = optionalSessionCandidate(records);
    // Records describing one occupant agree on kind and terminal too: a session
    // joined over contradictory evidence is ambiguous provenance, not a fact.
    const kind = optionalCandidateStrings(records, ["agent", "agent_kind", "kind"], "agent_kind");
    optionalCandidateStrings(records, ["terminal_id"], "terminal_id");
    if (session !== undefined && kind !== undefined && kind !== session.agent) {
      throw new PromptIdentityError("TARGET_IDENTITY_CHANGED", "Authoritative manager identity is contradictory", { field: "agent_session.agent", expected: kind, actual: session.agent });
    }
  } catch (error) {
    /* c8 ignore next -- optionalSessionCandidate/optionalCandidateStrings throw only PromptIdentityError. */
    if (error instanceof PromptIdentityError) {
      throw contextError("manager native session identity is malformed or contradictory", {
        paneId: bounded(paneId),
        reason: "session_untrusted",
        causeCode: error.code,
        ...boundAgentSessionStrings(error.details)
      });
    }
    /* c8 ignore next -- optionalSessionCandidate only ever throws PromptIdentityError; the rethrow keeps a foreign throw fail-closed. */
    throw error;
  }
  if (session !== undefined) {
    let matches = 0;
    for (const pane of snapshot.panes) {
      const paired = snapshot.agents.filter((agent) => agent.pane_id === pane.pane_id);
      let candidate: AgentSessionIdentity | undefined;
      try {
        candidate = optionalSessionCandidate([pane, ...paired]);
      } catch (error) {
        /* c8 ignore next -- optionalSessionCandidate throws only PromptIdentityError. */
        if (error instanceof PromptIdentityError) {
          throw contextError("manager native session identity is malformed or contradictory", {
            paneId: bounded(pane.pane_id), reason: "session_untrusted", causeCode: error.code
          });
        }
        /* c8 ignore next -- optionalSessionCandidate only throws PromptIdentityError; preserve a foreign programming error. */
        throw error;
      }
      if (candidate !== undefined
        && candidate.source === session.source
        && candidate.agent === session.agent
        && candidate.kind === session.kind
        && candidate.value === session.value) matches += 1;
    }
    if (matches !== 1) {
      throw contextError("manager native session is not uniquely bound to one pane", {
        paneId: bounded(paneId), reason: "manager_session_ambiguous", candidates: matches
      });
    }
  }
  return session ?? null;
}

export function contextRebindingDetails(diagnostics: ContextResolutionDiagnostics): { contextRebinding?: ContextResolutionDiagnostics } {
  return diagnostics.rebound ? { contextRebinding: diagnostics } : {};
}
