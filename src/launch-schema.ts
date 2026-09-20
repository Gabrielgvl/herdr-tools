import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static, type TUnsafe } from "typebox";
import { CLAUDE_EFFORTS, CLAUDE_PERMISSION_MODES, DEVIN_PERMISSION_MODES, THINKING_LEVELS, type ClaudeEffort, type ClaudePermissionMode, type DevinPermissionMode, type ThinkingLevel } from "./profiles/types.js";
import { type MessageDelivery } from "./messages/limits.js";

const AgentName = Type.String({ minLength: 1, maxLength: 32, pattern: "^[a-z][a-z0-9_-]{0,31}$" });
const ProfileName = Type.String({ minLength: 1, pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$" });
const Identifier = Type.String({ minLength: 1, pattern: "^[^\\u0000\\r\\n]+$" });

export const LaunchPlacementSchema = Type.Union([
  Type.Object({ mode: Type.Literal("same_tab") }, { additionalProperties: false }),
  Type.Object({ mode: Type.Literal("new_tab"), tabLabel: Identifier }, { additionalProperties: false }),
  Type.Object({ mode: Type.Literal("existing_pane"), target: Identifier }, { additionalProperties: false })
]);

const ProfileValues = Type.Array(Identifier);

/**
 * Resource selection (`extensions`, `skills`, `pluginDirs`) is intentionally
 * absent: it is owned by the profile so callers cannot bypass role scoping.
 */
export const ProfileLaunchOverridesSchema = Type.Object({
  model: Type.Optional(Identifier),
  thinking: Type.Optional(StringEnum(THINKING_LEVELS)),
  effort: Type.Optional(StringEnum(CLAUDE_EFFORTS)),
  tools: Type.Optional(ProfileValues),
  permissionMode: Type.Optional(StringEnum([...CLAUDE_PERMISSION_MODES, ...DEVIN_PERMISSION_MODES])),
  allowedTools: Type.Optional(ProfileValues),
  disallowedTools: Type.Optional(ProfileValues),
  addDirs: Type.Optional(ProfileValues)
}, { additionalProperties: false });

/**
 * Shape only: non-empty and NUL-free. Deliberately carries no `maxLength`, so
 * size has exactly one authority -- the UTF-8 byte length of the *rendered*
 * assignment checked against the selected delivery bound at runtime. A public
 * per-field bound would reject an oversized field as `INVALID_INPUT` during
 * schema validation, before rendering, and callers would see a different code
 * depending on whether the field or the rendered payload crossed the limit.
 */
const AssignmentText = (description: string) => Type.String({ minLength: 1, pattern: "^[^\\u0000]*$", description });

/**
 * Every launch carries exactly these three sections. The assignment is the
 * child's only instruction channel (an AGY profile body never reaches the
 * agent), so it must be self-contained.
 */
export const LaunchAssignmentSchema = Type.Object({
  objective: AssignmentText("What the child must achieve, stated as work to perform now."),
  scope: AssignmentText("What the child may and may not change, including files, contracts, and boundaries."),
  verification: AssignmentText("How the child must prove the result, including the checks and commands to run.")
}, { additionalProperties: false });

/**
 * The authorial supervision digest every launch must carry (ADR-034, amended
 * 2026-09-18): done-when conditions and constraints the supervisor's reviewer
 * judges against. Both arrays are required and non-empty — a caller with no
 * constraints authors `["none"]`. Bounded and strict — extra fields are
 * rejected. `readOnly` (ADR-036 W0) is the caller's claim that the assignment
 * must not mutate the workspace: optional, boolean, absent means false.
 */
const SupervisionDigestItems = Type.Array(Type.String({ minLength: 1, maxLength: 240 }), { minItems: 1, maxItems: 8 });
export const SupervisionDigestSchema = Type.Object({
  doneWhen: SupervisionDigestItems,
  constraints: SupervisionDigestItems,
  readOnly: Type.Optional(Type.Boolean())
}, { additionalProperties: false });

const LaunchCommonProperties = {
  name: AgentName,
  placement: Type.Optional(LaunchPlacementSchema),
  label: Type.Optional(Identifier),
  cwd: Type.Optional(Identifier),
  focus: Type.Optional(Type.Boolean()),
  assignment: LaunchAssignmentSchema,
  assignmentDelivery: Type.Optional(StringEnum(["inline", "attachment"] as const)),
  supervisionDigest: SupervisionDigestSchema
};

/**
 * Explicit request: a named Profile is the single-child launch path and the
 * only variant that may carry `overrides`, because they apply to that Profile.
 */
export const ProfileLaunchParamsSchema = Type.Object({
  ...LaunchCommonProperties,
  profile: ProfileName,
  overrides: Type.Optional(ProfileLaunchOverridesSchema)
}, { additionalProperties: false });

/**
 * Auto (Batch) request: an assignment with no `profile`. The Router chooses
 * Role, Profile, and fan-out, so there is no `profile` and no `overrides` --
 * no primary Profile has been named to receive them.
 */
export const AutoLaunchParamsSchema = Type.Object({
  ...LaunchCommonProperties
}, { additionalProperties: false });

/**
 * The legacy N4 contract. It stays the internal shape `validateLaunchParams`
 * in tools/launch.ts enforces — and the shape launch-batch.ts still expands —
 * until B8 rewires the executor to the spec request below. It is no longer
 * the published contract: `PublishedLaunchParamsSchema` now serves the spec
 * shape.
 */
export const LaunchParamsSchema = Type.Union([ProfileLaunchParamsSchema, AutoLaunchParamsSchema]);

/**
 * The caller-authored spec: the ADR-035 unit of launch. `label` is the Role —
 * the caller's name for the spec that derived child names
 * `{request.name}-{label}-{N}` are built from — so it is constrained to the
 * kebab contract at the boundary: an out-of-pattern label is INVALID_INPUT at
 * validation, never a BATCH_CHILD_NAME_INVALID after routing (plan R2), and it
 * caps at 12 characters so the label's segment of the derived name is bounded;
 * name overflow stays a structured per-child failure at expansion (audit
 * amendment 4). `instructions` is the caller's own text, provenance-wrapped by
 * src/spec-baseline.ts before it reaches the child; `assignment` is the typed
 * contract reused unchanged. `category` names a catalog chain — the schema
 * checks the kebab shape only, membership is the catalog's — and `count`
 * defaults to 1.
 */
const SPEC_LABEL_PATTERN = "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$";
const SpecLabel = Type.String({ minLength: 1, maxLength: 12, pattern: SPEC_LABEL_PATTERN });
const SpecCategory = Type.String({ minLength: 1, pattern: SPEC_LABEL_PATTERN });
export const LaunchSpecSchema = Type.Object({
  label: SpecLabel,
  instructions: AssignmentText("The caller's instruction text for this spec, provenance-wrapped before it reaches the child."),
  assignment: LaunchAssignmentSchema,
  category: Type.Optional(SpecCategory),
  count: Type.Optional(Type.Integer({ minimum: 1, default: 1 }))
}, { additionalProperties: false });

/**
 * The first `spec.label` occurring twice in a specs array, or undefined. The
 * `~refine` engine invokes it only after the array's structural checks pass,
 * so it reads `label` off a valid `LaunchSpec[]` directly.
 */
function duplicateSpecLabel(specs: LaunchSpec[]): string | undefined {
  const seen = new Set<string>();
  for (const spec of specs) {
    if (seen.has(spec.label)) return spec.label;
    seen.add(spec.label);
  }
  return undefined;
}

/**
 * The ADR-035 launch request: the caller composes `specs` (at least one) and
 * the compiler configures each — there is no `profile` and no `overrides`.
 * Spec labels are unique per request: JSON Schema cannot express field-level
 * uniqueness, so `specs` carries a `~refine` check — `Value.Check` fails and
 * `Value.Errors` reports a `~refine` error naming the duplicate (audit
 * amendment 4). The request-level `label` keeps its pane-label meaning and is
 * not a spec label (CONTEXT.md). `supervisionDigest` stays a required
 * request-level field, never per-spec (plan R3): a request without done-when
 * conditions is unjudgeable and fails validation (ADR-035 amendment).
 */
export const SpecLaunchParamsSchema = Type.Object({
  name: AgentName,
  transportBypass: Type.Optional(Identifier),
  specs: Type.Refine(
    Type.Array(LaunchSpecSchema, { minItems: 1 }),
    (specs) => duplicateSpecLabel(specs) === undefined,
    (specs) => `duplicate spec.label "${duplicateSpecLabel(specs)}"`
  ),
  placement: Type.Optional(LaunchPlacementSchema),
  label: Type.Optional(Identifier),
  cwd: Type.Optional(Identifier),
  focus: Type.Optional(Type.Boolean()),
  assignmentDelivery: Type.Optional(StringEnum(["inline", "attachment"] as const)),
  supervisionDigest: SupervisionDigestSchema
}, { additionalProperties: false });

/**
 * The static params shape `tool.execute` keeps until B8. `Static` of the
 * published schema is the compile-time contract of every direct execute call,
 * and the unchanged executor still accepts the permissive flat form the
 * deleted union mirror declared: every field optional, legacy keys present.
 * The schema VALUE below is the strict spec contract; this type is what the
 * wire still admits.
 */
type FlatLaunchParams = {
  name?: string;
  transportBypass?: string;
  profile?: string;
  overrides?: ProfileLaunchOverrides;
  placement?: LaunchPlacement;
  label?: string;
  cwd?: string;
  focus?: boolean;
  assignment?: { objective?: string; scope?: string; verification?: string };
  assignmentDelivery?: MessageDelivery;
  supervisionDigest?: { doneWhen: string[]; constraints: string[]; readOnly?: boolean };
};

/**
 * The published root is the spec request itself. The dual union needed an
 * optional-all flat mirror because the pi harness drops every argument of a
 * tool whose parameters are a root union; the spec request is a single strict
 * object, so that workaround is gone and the published schema IS the
 * contract. The TUnsafe cast keeps `Static` at the flat executor params above
 * while the published value validates the spec shape.
 */
export const PublishedLaunchParamsSchema = SpecLaunchParamsSchema as unknown as TUnsafe<FlatLaunchParams>;

export type LaunchPlacement =
  | { mode: "same_tab" }
  | { mode: "new_tab"; tabLabel: string }
  | { mode: "existing_pane"; target: string };

export interface ProfileLaunchOverrides {
  model?: string;
  thinking?: ThinkingLevel;
  effort?: ClaudeEffort;
  tools?: string[];
  permissionMode?: ClaudePermissionMode | DevinPermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  addDirs?: string[];
}

export type LaunchParams = Static<typeof LaunchParamsSchema>;

/** Batch request: the strict auto variant of the public launch schema. */
export type AutoLaunchRequest = Static<typeof AutoLaunchParamsSchema>;

/** One caller-authored spec inside an ADR-035 launch request. */
export type LaunchSpec = Static<typeof LaunchSpecSchema>;

/** The ADR-035 launch request: a named composition of caller-authored specs. */
export type SpecLaunchRequest = Static<typeof SpecLaunchParamsSchema>;

export interface LaunchAssignment {
  objective: string;
  scope: string;
  verification: string;
}

export interface LaunchRequest {
  name: string;
  profile: string;
  overrides?: ProfileLaunchOverrides;
  placement?: LaunchPlacement;
  label?: string;
  cwd?: string;
  focus?: boolean;
  assignment: LaunchAssignment;
  assignmentDelivery?: MessageDelivery;
  /** Authorial done-when/constraints the supervisor's reviewer judges against (ADR-034), plus the bounded readOnly claim (ADR-036 W0). Required on every launch. */
  supervisionDigest: { doneWhen: string[]; constraints: string[]; readOnly?: boolean };
}

export const LAUNCH_ASSIGNMENT_FIELDS = ["objective", "scope", "verification"] as const;

/**
 * The single rendering of a typed assignment into the sender-authored payload
 * that the provenance envelope wraps. Fixed order, fixed labels, no caller
 * control over layout, so the same assignment always renders byte-identically.
 */
export function renderAssignment(assignment: LaunchAssignment): string {
  return `Objective:\n${assignment.objective}\n\nScope:\n${assignment.scope}\n\nVerification:\n${assignment.verification}`;
}
