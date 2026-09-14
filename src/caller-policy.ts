import { tokenValue } from "./agent-identity.js";
import type { AgentRecord, HerdrSnapshot, PaneRecord } from "./targets.js";

/**
 * Cooperative caller classification for the worker/manager communication
 * contract (ADR-030). This is a cooperative routing restriction inside the
 * typed tools — not an authorization boundary. The identity tokens it reads
 * (`identity_provenance`, `identity_actor`, `identity_session`) remain
 * forgeable shared metadata; a caller that can write metadata or reach the
 * raw CLI can bypass the classification. The guard exists so honest workers
 * route results to their recorded manager and cannot accidentally drive
 * other panes, and so policy evidence problems fail closed instead of
 * silently widening scope.
 *
 * Classification is topology-based. A caller pane is unrestricted when it
 * carries no `identity_provenance=launched` marker (detected or adopted —
 * the legacy floor), or when at least one other pane's records consistently
 * name it as `identity_actor` (it manages children). A launched pane with no
 * recorded children is a leaf worker: text sends may target only its bound
 * `identity_actor` pane and keys/cancel/interrupt are refused entirely.
 */
const TOKEN_VALUE_MAX_LENGTH = 80;
const MAX_EVIDENCE_STRING = 256;

export type CallerPolicyCode = "CALLER_POLICY_UNAVAILABLE" | "CALLER_BINDING_UNAVAILABLE" | "TARGET_SCOPE_REJECTED";

export type CallerPolicyOperation = "prompt" | "steer" | "keys" | "cancel" | "interrupt";

/** Typed caller-policy failure: classification evidence problems, unusable bindings, and scope rejections stay distinct. */
export class CallerPolicyError extends Error {
  readonly details: Record<string, unknown>;

  constructor(readonly code: CallerPolicyCode, message: string, details: Record<string, unknown> = {}) {
    super(`${code}: ${message}`);
    this.name = "CallerPolicyError";
    this.details = details;
  }
}

export type WorkerBinding =
  | { readonly status: "bound"; readonly parentPaneId: string }
  | { readonly status: "unavailable"; readonly reason: string };

export interface UnrestrictedCaller {
  readonly callerPaneId: string;
  readonly scope: "unrestricted";
  readonly basis: "unmarked" | "adopted" | "manages_children";
  /**
   * The caller's own launch binding — present only when provenance is
   * `launched`. It never restricts the caller, but `herdr_inspect` exposes a
   * bound `replyPaneId` so a managing pane (e.g. a planner with sub-lanes)
   * still knows which pane launched it.
   */
  readonly binding?: WorkerBinding;
}

export interface WorkerCaller {
  readonly callerPaneId: string;
  readonly scope: "worker";
  readonly basis: "launched_leaf";
  readonly binding: WorkerBinding;
}

export type CallerPolicy = UnrestrictedCaller | WorkerCaller;

type TokenEvidence =
  | { readonly state: "absent" }
  | { readonly state: "value"; readonly value: string }
  | { readonly state: "malformed" }
  | { readonly state: "contradictory" };

type SessionEvidence =
  | { readonly state: "none" }
  | { readonly state: "value"; readonly value: string }
  | { readonly state: "malformed" }
  | { readonly state: "contradictory" };

function bounded(value: string): string {
  return [...value].slice(0, MAX_EVIDENCE_STRING).join("");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function owns(value: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

/** Herdr normalizes metadata token values on write: control characters stripped, 80-char cap. */
function tokenString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= TOKEN_VALUE_MAX_LENGTH && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value);
}

/**
 * Merge one identity token key across a pane's pane and agent records. Any
 * malformed observation poisons the merge, and two distinct well-formed values
 * are contradictory — policy evidence is never selected by record order.
 */
function mergedToken(records: readonly Record<string, unknown>[], key: string): TokenEvidence {
  const values = new Set<string>();
  let malformed = false;
  for (const candidate of records) {
    if (!owns(candidate, "tokens")) continue;
    const tokens = candidate.tokens;
    if (!record(tokens)) {
      malformed = true;
      continue;
    }
    if (!owns(tokens, key)) continue;
    const value = tokens[key];
    if (!tokenString(value)) {
      malformed = true;
      continue;
    }
    values.add(value);
  }
  if (malformed) return { state: "malformed" };
  if (values.size > 1) return { state: "contradictory" };
  const value = [...values][0];
  return value === undefined ? { state: "absent" } : { state: "value", value };
}

function sessionValue(value: unknown): string | undefined {
  if (!record(value)) return undefined;
  const source = value.source;
  const agent = value.agent;
  const kind = value.kind;
  const session = value.value;
  if (typeof source !== "string" || source.length === 0 || typeof agent !== "string" || agent.length === 0 || typeof kind !== "string" || kind.length === 0 || typeof session !== "string" || session.length === 0) return undefined;
  return session;
}

/** The caller's current session from its structured `agent_session` evidence, with malformed and contradictory shapes kept distinct. */
function callerSession(records: readonly Record<string, unknown>[]): SessionEvidence {
  const values = new Set<string>();
  let malformed = false;
  for (const candidate of records) {
    if (!owns(candidate, "agent_session")) continue;
    const value = sessionValue(candidate.agent_session);
    if (value === undefined) {
      malformed = true;
      continue;
    }
    values.add(value);
  }
  if (malformed) return { state: "malformed" };
  if (values.size > 1) return { state: "contradictory" };
  const value = [...values][0];
  return value === undefined ? { state: "none" } : { state: "value", value };
}

function paneRecords(snapshot: HerdrSnapshot, paneId: string): Record<string, unknown>[] {
  return [
    ...(snapshot.panes as PaneRecord[]).filter((pane) => pane.pane_id === paneId),
    ...(snapshot.agents as AgentRecord[]).filter((agent) => agent.pane_id === paneId)
  ];
}

/**
 * Whether `paneId`'s records consistently claim `callerPaneId` as their
 * `identity_actor`. A child whose own records are malformed or contradictory
 * names nobody — the child fails its own binding check when it calls.
 */
function claimsActor(snapshot: HerdrSnapshot, paneId: string, callerPaneId: string): boolean {
  const actor = mergedToken(paneRecords(snapshot, paneId), "identity_actor");
  return actor.state === "value" && actor.value === callerPaneId;
}

function unavailable(reason: string): WorkerBinding {
  return { status: "unavailable", reason };
}

/**
 * The recorded launch-parent binding for a leaf worker. `identity_actor` must
 * be a well-formed token value, distinct from the caller, and still resolve to
 * a live pane; `identity_session` must equal the caller's current
 * `agent_session.value`, which catches a stale token left behind by a reused
 * pane. Every shortfall denies closed — a missing or stale binding is never
 * upgraded to a legacy/unscoped caller.
 */
function workerBinding(snapshot: HerdrSnapshot, callerPaneId: string, records: readonly Record<string, unknown>[]): WorkerBinding {
  const actor = mergedToken(records, "identity_actor");
  if (actor.state === "malformed") return unavailable("actor_malformed");
  if (actor.state === "contradictory") return unavailable("actor_contradictory");
  if (actor.state === "absent") return unavailable("actor_missing");
  if (actor.value === callerPaneId) return unavailable("actor_self");
  if (!snapshot.panes.some((pane) => pane.pane_id === actor.value)) return unavailable("actor_stale");
  const token = mergedToken(records, "identity_session");
  if (token.state === "malformed") return unavailable("session_malformed");
  if (token.state === "contradictory") return unavailable("session_contradictory");
  if (token.state === "absent") return unavailable("session_missing");
  const current = callerSession(records);
  if (current.state === "contradictory") return unavailable("session_contradictory");
  if (current.state !== "value") return unavailable("session_unverifiable");
  // The stored token was normalized at write time (tokenValue strips control
  // characters and caps at 80 chars), so a long session id — e.g. a Pi session
  // path — must be normalized identically before comparing.
  if (tokenValue(current.value) !== token.value) return unavailable("session_stale");
  return { status: "bound", parentPaneId: actor.value };
}

/**
 * Classify the effective caller pane against the authoritative snapshot.
 * Throws `CALLER_POLICY_UNAVAILABLE` when the policy evidence itself is
 * absent, malformed, or contradictory — classification never guesses.
 */
export function classifyCaller(snapshot: HerdrSnapshot, callerPaneId: string): CallerPolicy {
  const callerPanes = snapshot.panes.filter((pane) => pane.pane_id === callerPaneId);
  if (callerPanes.length !== 1) {
    throw new CallerPolicyError("CALLER_POLICY_UNAVAILABLE", "caller pane evidence is absent or ambiguous in the authoritative snapshot", {
      callerPaneId: bounded(callerPaneId),
      paneRecords: callerPanes.length
    });
  }
  const records = paneRecords(snapshot, callerPaneId);
  const provenance = mergedToken(records, "identity_provenance");
  if (provenance.state === "malformed" || provenance.state === "contradictory") {
    throw new CallerPolicyError("CALLER_POLICY_UNAVAILABLE", `caller provenance evidence is ${provenance.state}`, {
      callerPaneId: bounded(callerPaneId),
      reason: `provenance_${provenance.state}`
    });
  }
  if (provenance.state === "value" && provenance.value !== "launched" && provenance.value !== "adopted") {
    throw new CallerPolicyError("CALLER_POLICY_UNAVAILABLE", "caller provenance evidence is not a recognized value", {
      callerPaneId: bounded(callerPaneId),
      reason: "provenance_unrecognized"
    });
  }
  // A pane is never its own child, so a self `identity_actor` does not make a
  // launched caller a manager — it is a leaf with an unusable binding.
  const managesChildren = snapshot.panes.some((pane) => pane.pane_id !== callerPaneId && claimsActor(snapshot, pane.pane_id, callerPaneId));
  if (provenance.state === "value" && provenance.value === "launched") {
    const binding = workerBinding(snapshot, callerPaneId, records);
    if (!managesChildren) return { callerPaneId, scope: "worker", basis: "launched_leaf", binding };
    return { callerPaneId, scope: "unrestricted", basis: "manages_children", binding };
  }
  return {
    callerPaneId,
    scope: "unrestricted",
    basis: managesChildren ? "manages_children" : provenance.state === "value" ? "adopted" : "unmarked"
  };
}

/**
 * Gate a text send (prompt/steer, including `kind: "result"`) for a leaf
 * worker: the binding must be usable and the already-resolved target pane must
 * be exactly the recorded manager pane. Resolution happens before this check,
 * so an exact name/label alias for the bound manager is accepted and a peer
 * alias is not.
 */
export function assertSendScope(policy: CallerPolicy, operation: "prompt" | "steer", targetPaneId: string | undefined): void {
  if (policy.scope !== "worker") return;
  if (policy.binding.status !== "bound") {
    throw new CallerPolicyError("CALLER_BINDING_UNAVAILABLE", "launched worker has no usable manager binding", {
      operation,
      callerPaneId: bounded(policy.callerPaneId),
      reason: policy.binding.reason
    });
  }
  if (targetPaneId !== policy.binding.parentPaneId) {
    throw new CallerPolicyError("TARGET_SCOPE_REJECTED", "launched worker may only send text to its recorded manager pane", {
      operation,
      callerPaneId: bounded(policy.callerPaneId),
      ...(targetPaneId === undefined ? {} : { targetPaneId: bounded(targetPaneId) }),
      parentPaneId: bounded(policy.binding.parentPaneId)
    });
  }
}

/** Keys and turn control are denied entirely for a leaf worker, regardless of target or binding. */
export function assertControlScope(policy: CallerPolicy, operation: "keys" | "cancel" | "interrupt"): void {
  if (policy.scope !== "worker") return;
  throw new CallerPolicyError("TARGET_SCOPE_REJECTED", "launched worker may not send keys or turn control", {
    operation,
    callerPaneId: bounded(policy.callerPaneId),
    ...(policy.binding.status === "bound" ? { parentPaneId: bounded(policy.binding.parentPaneId) } : { reason: policy.binding.reason })
  });
}

/** Bounded, token-free caller-policy evidence for `herdr_inspect` context mode. */
export function callerPolicyDiagnostics(policy: CallerPolicy): Record<string, unknown> {
  const base = { scope: policy.scope, basis: policy.basis };
  if (policy.binding === undefined) return base;
  return policy.binding.status === "bound"
    ? { ...base, replyPaneId: bounded(policy.binding.parentPaneId) }
    : { ...base, binding: "unavailable", bindingReason: policy.binding.reason };
}

/** Policy evidence reported when classification itself cannot be evaluated; inspection stays usable. */
export function callerPolicyFailure(error: unknown): Record<string, unknown> {
  return { scope: "unavailable", code: error instanceof CallerPolicyError ? error.code : "CALLER_POLICY_UNAVAILABLE" };
}
