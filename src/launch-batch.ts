import { AGENT_NAME_MAX_LENGTH, isAgentName } from "./agent-identity.js";
import type { LaunchPlacement, LaunchSpec, SpecLaunchRequest } from "./launch-schema.js";
import type { SpecDecision } from "./router.js";

/** One spec replica the cutover executor dispatches through the shared launch lifecycle. */
export interface BatchPlannedChild {
  /** Exact derived target `{name}-{spec.label}-{N}`; never truncated. */
  name: string;
  specLabel: string;
  spec: LaunchSpec;
  ordinal: number;
  count: number;
  placement: LaunchPlacement;
  label?: string;
}

export type BatchChildFailureCode = "BATCH_CHILD_NAME_INVALID" | "BATCH_NAME_COLLISION";

export interface BatchChildFailure {
  code: BatchChildFailureCode;
  name: string;
  specLabel: string;
  ordinal: number;
  message: string;
}

export type BatchExpansion =
  | { kind: "expanded"; children: BatchPlannedChild[]; failures: BatchChildFailure[] }
  | { kind: "invalid"; code: "BATCH_PLACEMENT_INVALID"; message: string };

type AdmittedDecision = Extract<SpecDecision, { kind: "admitted" }>;

/**
 * Expand accepted spec decisions without effects. The decision array is paired
 * with `request.specs` by position, so a rejected spec simply produces no child.
 */
export function expandBatchRequest(
  request: SpecLaunchRequest,
  decisions: readonly SpecDecision[],
  existing: ReadonlySet<string>
): BatchExpansion {
  const placement = request.placement ?? { mode: "same_tab" as const };
  const admitted = request.specs.flatMap((spec, index) => {
    const decision = decisions[index];
    return decision?.kind === "admitted" ? [{ spec, decision: decision as AdmittedDecision }] : [];
  });
  const total = admitted.reduce((sum, item) => sum + item.decision.count, 0);
  if (placement.mode === "existing_pane" && total !== 1) {
    return {
      kind: "invalid",
      code: "BATCH_PLACEMENT_INVALID",
      message: "existing_pane placement requires exactly one admitted spec replica"
    };
  }

  const claimed = new Set(existing);
  const ordinals = new Map<string, number>();
  const children: BatchPlannedChild[] = [];
  const failures: BatchChildFailure[] = [];
  for (const { spec, decision } of admitted) {
    const count = decision.count;
    for (let index = 0; index < count; index += 1) {
      const ordinal = (ordinals.get(spec.label) ?? 0) + 1;
      ordinals.set(spec.label, ordinal);
      const name = `${request.name}-${spec.label}-${ordinal}`;
      const identity = { name, specLabel: spec.label, ordinal };
      if (!isAgentName(name)) {
        failures.push({ ...identity, code: "BATCH_CHILD_NAME_INVALID", message: `derived child name is outside the ${AGENT_NAME_MAX_LENGTH}-character AgentName contract` });
        continue;
      }
      if (claimed.has(name)) {
        failures.push({ ...identity, code: "BATCH_NAME_COLLISION", message: "derived child name is already held by an existing target or planned child" });
        continue;
      }
      const label = request.label === undefined ? undefined : `${request.label}-${spec.label}-${ordinal}`;
      if (label !== undefined && claimed.has(label)) {
        failures.push({ ...identity, code: "BATCH_NAME_COLLISION", message: "derived child label is already held by an existing target or planned child" });
        continue;
      }
      claimed.add(name);
      if (label !== undefined) claimed.add(label);
      children.push({
        ...identity,
        spec: { ...spec, count: 1 },
        count,
        ...(label === undefined ? {} : { label }),
        placement: placement.mode === "new_tab"
          ? { mode: "new_tab", tabLabel: `${placement.tabLabel}-${spec.label}-${ordinal}` }
          : placement
      });
    }
  }
  return { kind: "expanded", children, failures };
}
