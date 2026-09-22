import type { JsonEnvelope } from "./cli.js";
import {
  boundAgentSessionStrings,
  joinPromptTargetIdentity,
  PromptIdentityError,
  requirePromptTargetIdentity,
  type AgentSessionIdentity,
  type PromptTargetIdentity
} from "./messages/prompt.js";
import { agentFrom, paneFrom, snapshotIdentityRecords } from "./messages/prompt-target.js";
import { parseSnapshotResult, type HerdrSnapshot } from "./targets.js";

/**
 * Shared agent-name grammar. Identical to the launch schema so adopted,
 * launched, and renamed agents are indistinguishable to name-based resolution.
 */
export const AGENT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
export const AGENT_NAME_MAX_LENGTH = 32;
/** `...-2` through `...-9` collision suffixes on a derived name; `-1` is the unsuffixed mint. */
const SELF_NAME_SUFFIX_LIMIT = 9;
/** Herdr normalizes metadata token values: control characters stripped, 80-char cap. */
const TOKEN_VALUE_MAX_LENGTH = 80;
/** Probe name injected into a local-only join to test whether the name is the sole missing field. */
const NAME_PROBE = "__adopt_probe__";

export function isAgentName(value: unknown): value is string {
  return typeof value === "string" && AGENT_NAME_PATTERN.test(value);
}

export function assertAgentName(value: unknown, field: string): asserts value is string {
  if (!isAgentName(value)) {
    throw Object.assign(new Error(`INVALID_INPUT: ${field} must match ${AGENT_NAME_PATTERN}`), {
      code: "INVALID_INPUT",
      details: { field }
    });
  }
}

export type AdoptErrorCode = "ADOPT_TARGET_UNQUALIFIED" | "AGENT_ALREADY_NAMED" | "AGENT_NAME_TAKEN";

/** Typed adopt failure: unqualified preconditions, existing names, and held names are distinguished. */
export class AdoptError extends Error {
  readonly details: Record<string, unknown>;

  constructor(readonly code: AdoptErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(`${code}: ${message}`);
    this.name = "AdoptError";
    this.details = boundAgentSessionStrings(details);
  }
}

export interface AdoptIdentityCli {
  runJson(argv: string[], signal: AbortSignal): Promise<JsonEnvelope>;
}

export type AdoptOutcome = "named" | "refused" | "unqualified";

export interface AdoptedIdentity {
  paneId: string;
  agentName: string;
  identity: PromptTargetIdentity;
  /** The name already bound to this pane; set when the adopt was an idempotent re-check. */
  namePreexisting?: true;
  /** Set when the advisory provenance token write failed; the adopt itself succeeded. */
  provenanceWarning?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
}

function completeSession(value: unknown): AgentSessionIdentity | undefined {
  if (!record(value)) return undefined;
  const source = stringField(value, "source");
  const agent = stringField(value, "agent");
  const kind = stringField(value, "kind");
  const sessionValue = stringField(value, "value");
  if (source === undefined || agent === undefined || kind === undefined || sessionValue === undefined) return undefined;
  return { source, agent, kind, value: sessionValue };
}

function sameSession(left: AgentSessionIdentity, right: AgentSessionIdentity): boolean {
  return left.source === right.source && left.agent === right.agent && left.kind === right.kind && left.value === right.value;
}

function unqualified(message: string, details: Record<string, unknown>): AdoptError {
  return new AdoptError("ADOPT_TARGET_UNQUALIFIED", message, details);
}

/** All name fields a pane or agent record can carry: `name` and `agent_name` are both authoritative aliases. */
function suppliedNames(records: ReadonlyArray<Record<string, unknown>>): string[] {
  const names = new Set<string>();
  for (const candidate of records) {
    const name = stringField(candidate, "name", "agent_name");
    if (name !== undefined) names.add(name);
  }
  return [...names];
}

/**
 * The explicit-adopt precondition bundle: exactly one pane and one agent record for the
 * pane, a complete agent_session, a terminal id, a detected non-unknown lifecycle state,
 * and at most one name supplied across both records — returned as `suppliedName` so the
 * caller can accept an idempotent same-name adopt or refuse a conflicting one. Throws
 * AdoptError(ADOPT_TARGET_UNQUALIFIED) for every shortfall and contradiction; the rename
 * is never attempted.
 */
export function adoptTargetPreconditions(snapshot: HerdrSnapshot, paneId: string): {
  pane: Record<string, unknown>;
  agent: Record<string, unknown>;
  agentSession: AgentSessionIdentity;
  terminalId: string;
  suppliedName?: string;
} {
  const panes = snapshot.panes.filter((candidate) => candidate.pane_id === paneId);
  const agents = snapshot.agents.filter((candidate) => candidate.pane_id === paneId);
  if (panes.length === 0) throw unqualified("the target pane is absent from the topology", { paneId, reason: "pane_absent" });
  if (panes.length > 1) throw unqualified("the target pane is ambiguous in the topology", { paneId, reason: "pane_duplicate" });
  if (agents.length === 0) throw unqualified("the target pane has no agent record", { paneId, reason: "agent_absent" });
  if (agents.length > 1) throw unqualified("the target pane has multiple agent records", { paneId, reason: "agent_duplicate" });
  const pane = panes[0] as Record<string, unknown>;
  const agent = agents[0] as Record<string, unknown>;
  const paneSession = completeSession(pane.agent_session);
  const agentSession = completeSession(agent.agent_session);
  if (paneSession !== undefined && agentSession !== undefined && !sameSession(paneSession, agentSession)) {
    throw unqualified("pane and agent records disagree on the agent session", { paneId, reason: "identity_contradictory" });
  }
  const session = agentSession ?? paneSession;
  if (session === undefined) {
    throw unqualified("the target agent session is absent or incomplete", { paneId, reason: "agent_session_incomplete" });
  }
  const paneTerminal = stringField(pane, "terminal_id");
  const agentTerminal = stringField(agent, "terminal_id");
  if (paneTerminal !== undefined && agentTerminal !== undefined && paneTerminal !== agentTerminal) {
    throw unqualified("pane and agent records disagree on the terminal", { paneId, reason: "identity_contradictory" });
  }
  const terminalId = agentTerminal ?? paneTerminal;
  if (terminalId === undefined) throw unqualified("the target pane has no terminal identity", { paneId, reason: "terminal_id_missing" });
  const paneKind = stringField(pane, "agent");
  const agentKind = stringField(agent, "agent");
  if (paneKind !== undefined && agentKind !== undefined && paneKind !== agentKind) {
    throw unqualified("pane and agent records disagree on the agent kind", { paneId, reason: "identity_contradictory" });
  }
  const status = stringField(agent, "agent_status") ?? stringField(pane, "agent_status");
  if (status === undefined) throw unqualified("the target agent state is not reported", { paneId, reason: "agent_status_missing" });
  if (status === "unknown") throw unqualified("the target agent state is unknown", { paneId, reason: "agent_status_unknown" });
  const names = suppliedNames([pane, agent]);
  if (names.length > 1) throw unqualified("pane and agent records disagree on the agent name", { paneId, reason: "identity_contradictory" });
  return { pane, agent, agentSession: session, terminalId, suppliedName: names[0] };
}

/**
 * Whether the prompt identity join fails solely because no record supplies a name.
 * A synthetic probe record carries a placeholder name through the real join so every
 * other field — pane id, terminal, kind, and the complete session — is still verified
 * by the fail-closed join itself rather than by a parallel check.
 */
export function nameOnlyGap(records: ReadonlyArray<Record<string, unknown>>, paneId: string): "named" | "ready" | "unqualified" {
  const names = suppliedNames(records);
  if (names.length === 1) return "named";
  if (names.length > 1) return "unqualified";
  try {
    joinPromptTargetIdentity([...records, { pane_id: paneId, name: NAME_PROBE }], paneId);
    return "ready";
  } catch {
    return "unqualified";
  }
}

function cliErrorCode(error: unknown): string | undefined {
  if (!record(error)) return undefined;
  const details = error.details;
  if (!record(details) || !record(details.errorEnvelope)) return undefined;
  const envelopeError = details.errorEnvelope.error;
  return record(envelopeError) && typeof envelopeError.code === "string" ? envelopeError.code : undefined;
}

/**
 * `agent rename <pane> <name>`; returns the acknowledged agent record on success.
 * Server rejection codes are mapped to the adopt taxonomy; the pane's agent record
 * vanishing mid-adopt is a precondition failure, not an authorization failure.
 */
export async function mintAgentName(cli: AdoptIdentityCli, paneId: string, name: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  let envelope: JsonEnvelope;
  try {
    envelope = await cli.runJson(["agent", "rename", paneId, name], signal);
  } catch (error) {
    const code = cliErrorCode(error);
    if (code === "agent_name_taken") {
      throw new AdoptError("AGENT_NAME_TAKEN", `agent name "${name}" is already held by another pane`, { paneId, name, causeCode: code });
    }
    if (code === "agent_not_found" || code === "agent_launch_pending") {
      throw new AdoptError("ADOPT_TARGET_UNQUALIFIED", `the pane's agent record vanished or is not yet established (${code})`, { paneId, name, causeCode: code });
    }
    if (code === "invalid_agent_name") {
      throw Object.assign(new Error(`INVALID_INPUT: Herdr rejected agent name "${name}"`), {
        code: "INVALID_INPUT",
        details: { name, causeCode: code }
      });
    }
    throw error;
  }
  return agentFrom(envelope.result);
}

/** Identity-token normalization: control/format/surrogate characters stripped, trimmed, 80-char cap. Shared with caller-policy so stored-token comparisons normalize current evidence identically. */
export function tokenValue(value: string): string | undefined {
  const normalized = value.replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, "").trim().slice(0, TOKEN_VALUE_MAX_LENGTH);
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Best-effort advisory provenance. Tokens are forgeable diagnostics — any source can
 * overwrite them — so a write failure degrades to a warning string, never a failure.
 */
export async function writeIdentityProvenance(
  cli: AdoptIdentityCli,
  paneId: string,
  provenance: "adopted" | "launched",
  actorPaneId: string | undefined,
  session: AgentSessionIdentity,
  signal: AbortSignal
): Promise<string | undefined> {
  const tokens = [`identity_provenance=${provenance}`];
  const actor = actorPaneId === undefined ? undefined : tokenValue(actorPaneId);
  if (actor !== undefined) tokens.push(`identity_actor=${actor}`);
  const sessionValue = tokenValue(session.value);
  if (sessionValue !== undefined) tokens.push(`identity_session=${sessionValue}`);
  try {
    await cli.runJson(["pane", "report-metadata", paneId, "--source", "herdr-tools", ...tokens.flatMap((token) => ["--token", token])], signal);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "provenance token write failed";
  }
}

/**
 * Explicit adopt: validate preconditions on the pre-mint snapshot, mint the caller's
 * name, then re-read a fresh snapshot plus agent/pane gets and prove the identity
 * through requirePromptTargetIdentity. The verified name must equal the requested
 * name — a race that re-points the pane to another name fails closed as
 * TARGET_IDENTITY_CHANGED. Idempotent on same name; rejects a different existing name.
 */
export async function adoptAgentIdentity(
  cli: AdoptIdentityCli,
  snapshot: HerdrSnapshot,
  paneId: string,
  name: string,
  actorPaneId: string | undefined,
  signal: AbortSignal
): Promise<AdoptedIdentity> {
  const conditions = adoptTargetPreconditions(snapshot, paneId);
  if (conditions.suppliedName !== undefined && conditions.suppliedName !== name) {
    throw new AdoptError("AGENT_ALREADY_NAMED", `the pane already carries agent name "${conditions.suppliedName}"`, {
      paneId,
      name,
      existing: conditions.suppliedName
    });
  }
  const incumbents = [
    ...snapshot.agents.filter((agent) => agent.pane_id !== paneId && suppliedNames([agent as Record<string, unknown>]).includes(name)).map((agent) => agent.pane_id),
    ...snapshot.panes.filter((pane) => pane.pane_id !== paneId && suppliedNames([pane as Record<string, unknown>]).includes(name)).map((pane) => pane.pane_id)
  ];
  if (incumbents.length > 0) {
    throw new AdoptError("AGENT_NAME_TAKEN", `agent name "${name}" is already held`, { paneId, name, incumbents });
  }
  const namePreexisting = conditions.suppliedName === name ? (true as const) : undefined;
  if (namePreexisting === undefined) await mintAgentName(cli, paneId, name, signal);
  const freshEnvelope = await cli.runJson(["api", "snapshot"], signal);
  const fresh = parseSnapshotResult(freshEnvelope.result);
  const agentEnvelope = await cli.runJson(["agent", "get", paneId], signal);
  const paneEnvelope = await cli.runJson(["pane", "get", paneId], signal);
  const records = [...snapshotIdentityRecords(fresh, paneId), agentFrom(agentEnvelope.result), paneFrom(paneEnvelope.result, paneId)];
  const identity = requirePromptTargetIdentity(records, paneId);
  if (identity.agentName !== name) {
    throw new PromptIdentityError("TARGET_IDENTITY_CHANGED", `the verified agent name "${identity.agentName}" does not match the adopted name`, {
      expectedAgentName: name,
      actualAgentName: identity.agentName
    });
  }
  // An idempotent adopt minted nothing, so it must not overwrite a stronger
  // provenance marker — e.g. `identity_provenance=launched` on a pane that was
  // launched, not adopted.
  const provenanceWarning = namePreexisting === undefined
    ? await writeIdentityProvenance(cli, paneId, "adopted", actorPaneId, identity.agentSession, signal)
    : undefined;
  return { paneId, agentName: name, identity, ...(namePreexisting === undefined ? {} : { namePreexisting }), ...(provenanceWarning === undefined ? {} : { provenanceWarning }) };
}

/**
 * Kinds that may receive a lazily minted name: exactly the kinds policy
 * qualifies for typed inbound delivery. Explicitly allowlisted — never
 * "not agy" — so unknown kinds stay inert rather than acquiring routing names.
 */
export const LAZY_ADOPT_KINDS: ReadonlySet<string> = new Set(["devin", "pi", "claude"]);

export interface LazyAdoptResult {
  outcome: AdoptOutcome;
  /** The acknowledged agent record carrying the minted name; safe to append to a pre-mint record set so the join sees the name. */
  minted?: Record<string, unknown>;
}

/**
 * Lazy target adoption shared by tool call sites that hit a name-only identity
 * gap on a detected pane (ADR-028). Re-reads the authoritative records so a
 * stale caller snapshot cannot mint on outdated evidence, mints the first
 * available derived name, verifies through the real join, then stamps advisory
 * provenance attributed to the acting pane. Returns `minted` only when the
 * post-mint identity verified; callers append it to their record set.
 */
export async function adoptUnnamedTarget(
  cli: AdoptIdentityCli,
  paneId: string,
  kind: string,
  actorPaneId: string | undefined,
  signal: AbortSignal
): Promise<LazyAdoptResult> {
  const snapshot = parseSnapshotResult((await cli.runJson(["api", "snapshot"], signal)).result);
  const agentEnvelope = await cli.runJson(["agent", "get", paneId], signal);
  const paneEnvelope = await cli.runJson(["pane", "get", paneId], signal);
  const records = [...snapshotIdentityRecords(snapshot, paneId), agentFrom(agentEnvelope.result), paneFrom(paneEnvelope.result, paneId)];
  const gap = nameOnlyGap(records, paneId);
  if (gap !== "ready") return { outcome: gap === "named" ? "named" : "unqualified" };
  const candidates = selfNameCandidates(kind, paneId);
  if (candidates === undefined) return { outcome: "refused" };
  for (const candidate of candidates) {
    try {
      const minted = await mintAgentName(cli, paneId, candidate, signal);
      const identity = requirePromptTargetIdentity([...records, minted], paneId);
      if (identity.agentName !== candidate) {
        throw new PromptIdentityError("TARGET_IDENTITY_CHANGED", "the adopted name did not bind to the verified identity", {
          expectedAgentName: candidate,
          actualAgentName: identity.agentName
        });
      }
      await writeIdentityProvenance(cli, paneId, "adopted", actorPaneId, identity.agentSession, signal);
      return { outcome: "named", minted };
    } catch (error) {
      if (error instanceof AdoptError && error.code === "AGENT_NAME_TAKEN") continue;
      throw error;
    }
  }
  return { outcome: "refused" };
}

/**
 * Derived self-adoption names: `<kind>-<normalized paneId>` (e.g. `devin-w6p1y`),
 * truncated so the whole `-N` suffix range still fits the 32-char grammar.
 * Returns every candidate in mint order — base first, then `-2` … `-9`.
 * `undefined` means no valid name can be derived (permanent refusal).
 */
export function selfNameCandidates(kind: string, paneId: string): string[] | undefined {
  const normalized = paneId.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (normalized.length === 0) return undefined;
  const suffixRoom = `-${SELF_NAME_SUFFIX_LIMIT}`.length;
  const base = `${kind}-${normalized}`.slice(0, AGENT_NAME_MAX_LENGTH - suffixRoom);
  if (!isAgentName(base)) return undefined;
  const candidates = [base];
  for (let suffix = 2; suffix <= SELF_NAME_SUFFIX_LIMIT; suffix += 1) {
    candidates.push(`${base}-${suffix}`);
  }
  return candidates;
}
