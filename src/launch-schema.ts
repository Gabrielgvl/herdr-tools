import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { CLAUDE_EFFORTS, CLAUDE_PERMISSION_MODES, THINKING_LEVELS, type ClaudeEffort, type ClaudePermissionMode, type ThinkingLevel } from "./profiles/types.js";

const AgentName = Type.String({ minLength: 1, maxLength: 32, pattern: "^[a-z][a-z0-9_-]{0,31}$" });
const ProfileName = Type.String({ minLength: 1, pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$" });
const Identifier = Type.String({ minLength: 1, pattern: "^[^\\u0000\\r\\n]+$" });

export const LaunchPlacementSchema = Type.Union([
  Type.Object({ mode: Type.Literal("same_tab") }, { additionalProperties: false }),
  Type.Object({ mode: Type.Literal("new_tab"), tabLabel: Identifier }, { additionalProperties: false }),
  Type.Object({ mode: Type.Literal("existing_pane"), target: Identifier }, { additionalProperties: false })
]);

const ProfileValues = Type.Array(Identifier);

export const ProfileLaunchOverridesSchema = Type.Object({
  model: Type.Optional(Identifier),
  thinking: Type.Optional(StringEnum(THINKING_LEVELS)),
  effort: Type.Optional(StringEnum(CLAUDE_EFFORTS)),
  tools: Type.Optional(ProfileValues),
  extensions: Type.Optional(ProfileValues),
  skills: Type.Optional(ProfileValues),
  permissionMode: Type.Optional(StringEnum(CLAUDE_PERMISSION_MODES)),
  allowedTools: Type.Optional(ProfileValues),
  disallowedTools: Type.Optional(ProfileValues),
  addDirs: Type.Optional(ProfileValues),
  pluginDirs: Type.Optional(ProfileValues)
}, { additionalProperties: false });

const LaunchCommonProperties = {
  name: AgentName,
  placement: Type.Optional(LaunchPlacementSchema),
  label: Type.Optional(Identifier),
  cwd: Type.Optional(Identifier),
  focus: Type.Optional(Type.Boolean()),
  initialPrompt: Type.Optional(Type.String({ minLength: 1, pattern: "^[^\\u0000]*$" }))
};

const ProfileLaunchParamsSchema = Type.Object({
  ...LaunchCommonProperties,
  profile: ProfileName,
  overrides: Type.Optional(ProfileLaunchOverridesSchema)
}, { additionalProperties: false });

export const LaunchParamsSchema = ProfileLaunchParamsSchema;

export type LaunchPlacement =
  | { mode: "same_tab" }
  | { mode: "new_tab"; tabLabel: string }
  | { mode: "existing_pane"; target: string };

export interface ProfileLaunchOverrides {
  model?: string;
  thinking?: ThinkingLevel;
  effort?: ClaudeEffort;
  tools?: string[];
  extensions?: string[];
  skills?: string[];
  permissionMode?: ClaudePermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  addDirs?: string[];
  pluginDirs?: string[];
}

export type LaunchParams = Static<typeof LaunchParamsSchema>;

export interface LaunchRequest {
  name: string;
  profile: string;
  overrides?: ProfileLaunchOverrides;
  placement?: LaunchPlacement;
  label?: string;
  cwd?: string;
  focus?: boolean;
  initialPrompt?: string;
}
