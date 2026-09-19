import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
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
 * rejected.
 */
const SupervisionDigestItems = Type.Array(Type.String({ minLength: 1, maxLength: 240 }), { minItems: 1, maxItems: 8 });
export const SupervisionDigestSchema = Type.Object({
  doneWhen: SupervisionDigestItems,
  constraints: SupervisionDigestItems
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

export const LaunchParamsSchema = Type.Union([ProfileLaunchParamsSchema, AutoLaunchParamsSchema]);

/**
 * Flat publication shape: the pi harness drops every argument of a tool whose
 * parameters are a root union, so the variants' fields are published as one
 * optional-all object. `LaunchParamsSchema` stays the internal contract and
 * `validateParams` in tools/launch.ts stays the enforcement authority —
 * required fields, the profile/auto discriminator, and per-variant rejections
 * are all re-derived there. `assignment` keeps strict keys but optional fields;
 * `supervisionDigest` keeps its required fields when present.
 */
export const PublishedLaunchParamsSchema = Type.Object({
  name: Type.Optional(AgentName),
  profile: Type.Optional(ProfileName),
  overrides: Type.Optional(ProfileLaunchOverridesSchema),
  placement: Type.Optional(LaunchPlacementSchema),
  label: Type.Optional(Identifier),
  cwd: Type.Optional(Identifier),
  focus: Type.Optional(Type.Boolean()),
  assignment: Type.Optional(Type.Object({
    objective: Type.Optional(LaunchAssignmentSchema.properties.objective),
    scope: Type.Optional(LaunchAssignmentSchema.properties.scope),
    verification: Type.Optional(LaunchAssignmentSchema.properties.verification)
  }, { additionalProperties: false })),
  assignmentDelivery: Type.Optional(StringEnum(["inline", "attachment"] as const)),
  supervisionDigest: Type.Optional(SupervisionDigestSchema)
}, { additionalProperties: false });

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
  /** Authorial done-when/constraints the supervisor's reviewer judges against (ADR-034). Required on every launch. */
  supervisionDigest: { doneWhen: string[]; constraints: string[] };
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
