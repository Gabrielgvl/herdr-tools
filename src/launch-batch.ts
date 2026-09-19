/**
 * ADR-032 Batch request expansion: the pure step between a route outcome and
 * the per-child executor. The caller supplies assignments with the role
 * already resolved, so expansion never learns where roles come from -- today
 * a profile name, tomorrow a spec label. Each planned child gets an exact
 * name derived as `{name}-{role}-{N}` with a one-based N within the Role, in
 * assignment order. Explicit labels and new-tab labels carry
 * the same `-${role}-${N}` suffix; an absent label leaves the child's pane
 * labeled with its own name.
 *
 * Every derived name is validated against the shared AgentName contract --
 * an overlong name is a typed `BATCH_CHILD_NAME_INVALID` failure, never a
 * truncation -- and claimed against a supplied set of existing agent names
 * and pane labels, because a pane label can shadow a name in the exact-target
 * resolvers. A colliding or invalid child yields a structured failure entry
 * while unrelated children still expand. An `existing_pane` placement is
 * valid only when expansion yields exactly one child; anything else is a
 * typed `BATCH_PLACEMENT_INVALID` decided before any launch effect. This
 * module performs no effects itself; the executor consumes the result.
 */

import { AGENT_NAME_MAX_LENGTH, isAgentName } from "./agent-identity.js";
import type { AutoLaunchRequest, LaunchPlacement } from "./launch-schema.js";
import { roleForProfile, type RouteDecision } from "./router.js";

/** One expanded child the executor can dispatch through the single-child launch path. */
export interface BatchPlannedChild {
  /** Exact derived target `{name}-{role}-{N}`; never truncated or renamed. */
  name: string;
  role: string;
  /** Profile the Router selected; it heads its own unchanged fallback chain. */
  profile: string;
  /** One-based instance number within the Role. */
  ordinal: number;
  /** Total instances the Router assigned to this Role. */
  count: number;
  /** Deterministic Router purpose for the child assignment objective. */
  purpose: string;
  /** Caller label suffixed `-${role}-${N}`; absent means the pane keeps the child name. */
  label?: string;
  /** Child placement; a new-tab label carries the same `-${role}-${N}` suffix. */
  placement: LaunchPlacement;
}

export type BatchChildFailureCode = "BATCH_CHILD_NAME_INVALID" | "BATCH_NAME_COLLISION";

/** One child's structured pre-dispatch failure; unrelated children still expand. */
export interface BatchChildFailure {
  code: BatchChildFailureCode;
  /** The exact derived name that failed; never truncated or renamed. */
  name: string;
  role: string;
  profile: string;
  ordinal: number;
  message: string;
}

/**
 * `expanded` carries the dispatchable children plus one failure entry per
 * child that could not receive an exact name. `invalid` is a whole-request
 * placement failure decided before any per-child check or launch effect.
 */
export type BatchExpansion =
  | { kind: "expanded"; children: BatchPlannedChild[]; failures: BatchChildFailure[] }
  | { kind: "invalid"; code: "BATCH_PLACEMENT_INVALID"; message: string };

/**
 * Expand an auto (Batch) request against a RouteDecision into planned
 * children. `existing` is the supplied set of existing agent names and pane
 * labels; both can shadow a name during exact-target resolution, so a hit is
 * a collision even when no agent carries the name. Pure: no launch effects.
 */
export function expandBatchRequest(request: AutoLaunchRequest, decision: RouteDecision, existing: ReadonlySet<string>): BatchExpansion {
  const placement = request.placement ?? { mode: "same_tab" as const };
  // One exact pane cannot host several agents; the caller can retry a
  // multi-child placement, so this is decided before any child work.
  if (placement.mode === "existing_pane" && decision.assignments.reduce((total, assignment) => total + assignment.count, 0) !== 1) {
    return { kind: "invalid", code: "BATCH_PLACEMENT_INVALID", message: "existing_pane placement requires the RouteDecision to expand to exactly one child" };
  }
  const claimed = new Set(existing);
  const ordinals = new Map<string, number>();
  const children: BatchPlannedChild[] = [];
  const failures: BatchChildFailure[] = [];
  for (const assignment of decision.assignments) {
    const role = roleForProfile(assignment.profile);
    for (let index = 0; index < assignment.count; index += 1) {
      const ordinal = (ordinals.get(role) ?? 0) + 1;
      ordinals.set(role, ordinal);
      const name = `${request.name}-${role}-${ordinal}`;
      const identity = { name, role, profile: assignment.profile, ordinal };
      if (!isAgentName(name)) {
        failures.push({ ...identity, code: "BATCH_CHILD_NAME_INVALID", message: `derived child name is outside the ${AGENT_NAME_MAX_LENGTH}-character AgentName contract` });
        continue;
      }
      if (claimed.has(name)) {
        failures.push({ ...identity, code: "BATCH_NAME_COLLISION", message: "derived child name is already held by an existing agent name or pane label, or by another planned child" });
        continue;
      }
      claimed.add(name);
      children.push({
        ...identity,
        count: assignment.count,
        purpose: assignment.purpose,
        ...(request.label === undefined ? {} : { label: `${request.label}-${role}-${ordinal}` }),
        placement: placement.mode === "new_tab" ? { mode: "new_tab", tabLabel: `${placement.tabLabel}-${role}-${ordinal}` } : placement
      });
    }
  }
  return { kind: "expanded", children, failures };
}
