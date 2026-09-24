import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { QUALITY_TIERS } from "./routing-policy.js";

/** Single-line identifier text: nonempty and free of NUL and line breaks. */
const Identifier = Type.String({ minLength: 1, pattern: "^[^\\u0000\\r\\n]+$" });

/**
 * Shape only: non-empty and NUL-free. Deliberately carries no `maxLength`, so
 * size has exactly one authority — the UTF-8 byte length of the *rendered*
 * Task checked against the delivery bound at runtime (ADR-037 "Delivery").
 */
const TaskText = (description: string) => Type.String({ minLength: 1, pattern: "^[^\\u0000]*$", description });
const TaskItem = Type.String({ minLength: 1, pattern: "^[^\\u0000]*$" });

/**
 * The one public launch input (ADR-037): the flat caller-authored Task. The
 * semantic contract is exactly `objective`, `scope`, `doneWhen`, and
 * `constraints`; the same values feed instruction rendering, Jev evaluation,
 * supervision reservation, and bounded evidence.
 *
 * `tier` is the optional requested quality posture — omission resolves to
 * `standard` inside the tier policy. `replicas` repeats one Task over isolated
 * runtime worktrees. `recoveryOf` names the failed child's managed handoff
 * run UUID (not its child target or launch ID). Recovery requires one replica
 * and forbids `cwd`; it resumes the recorded workspace.
 * `label` is display metadata bounded at 256 UTF-8 bytes that never affects
 * routing, Jev state, Task revision, machine identity, pane naming, tab
 * selection, or target resolution. `cwd` is any accessible directory,
 * canonicalized by the runtime before effects.
 * Unknown fields fail validation.
 */
export const LaunchTaskSchema = Type.Object({
  objective: TaskText("What the child must achieve, stated as work to perform now."),
  scope: TaskText("What the child may and may not change, including files, contracts, and boundaries."),
  doneWhen: Type.Array(TaskItem, {
    minItems: 1,
    maxItems: 8,
    description: "One to eight concrete, falsifiable completion-evidence conditions the supervisor's reviewer judges against."
  }),
  constraints: Type.Optional(Type.Array(TaskItem, {
    minItems: 0,
    maxItems: 8,
    default: [],
    description: "Caller-specific constraints beyond the universal baseline; empty or absent means none."
  })),
  tier: Type.Optional(StringEnum(QUALITY_TIERS, {
    description: "Requested starting quality/compute posture; the workload floor may raise it. Omission means standard.",
    default: "standard"
  })),
  replicas: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 8,
    default: 1,
    description: "Identical Task replicas over provably isolated Git worktrees; values above one fail closed without isolation."
  })),
  recoveryOf: Type.Optional(Type.String({ minLength: 1, pattern: "^[^\\u0000\\r\\n]+$", description: "Managed handoff run UUID from the failed child's Herdr supervision receipt, not a child target or launch ID. Recovery requires one replica and no cwd; close the failed child first." })),
  label: Type.Optional(Type.String({ minLength: 1, pattern: "^[^\\u0000\\r\\n]+$", maxByteLength: 256, description: "Display-only metadata; never enters routing contracts, pane identity, or decision evidence. Bounded at 256 UTF-8 bytes." })),
  cwd: Type.Optional(Identifier)
}, { additionalProperties: false });

/**
 * The published root is the Task itself. A single strict object needs no
 * host-compatibility projection — the published schema IS the contract.
 */
export const PublishedLaunchParamsSchema = LaunchTaskSchema;

/** The caller-authored Task: one per launch call. */
export type LaunchTask = Static<typeof LaunchTaskSchema>;

/**
 * The single deterministic rendering of a Task's four semantic fields into the
 * payload the provenance envelope carries. Fixed order, fixed labels, no caller
 * control over layout, so the same Task always renders byte-identically. This
 * is the canonical render shared by child instructions, routing, supervision,
 * review, and evidence; delivery selection measures its UTF-8 byte length.
 */
export function renderTask(task: { objective: string; scope: string; doneWhen: readonly string[]; constraints?: readonly string[] }): string {
  const constraints = task.constraints ?? [];
  return [
    `Objective:\n${task.objective}`,
    `Scope:\n${task.scope}`,
    `Done when:\n${task.doneWhen.map((entry) => `- ${entry}`).join("\n")}`,
    `Constraints:${constraints.length === 0 ? " (none)" : `\n${constraints.map((entry) => `- ${entry}`).join("\n")}`}`
  ].join("\n\n");
}
