import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { CLAUDE_EFFORTS, CLAUDE_PERMISSION_MODES, THINKING_LEVELS, type ClaudeEffort, type ClaudePermissionMode, type ThinkingLevel } from "./profiles/types.js";
import { type MessageDelivery } from "./messages/limits.js";

const Identifier = Type.String({ minLength: 1, pattern: "^[^\\u0000\\r\\n]+$" });
const AgentArgument = Type.String({ pattern: "^[^\\u0000]*$" });
const EnvValue = Type.String({ pattern: "^[^\\u0000]*$" });

export const LAUNCH_AGENT_KINDS = [
  "pi", "claude", "codex", "gemini", "cursor", "devin", "agy", "cline", "omp", "mastracode", "opencode",
  "copilot", "kimi", "kiro", "droid", "amp", "grok", "hermes", "kilo", "qodercli", "maki"
] as const;
export type LaunchAgentKind = (typeof LAUNCH_AGENT_KINDS)[number];

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
  name: Identifier,
  placement: Type.Optional(LaunchPlacementSchema),
  label: Type.Optional(Identifier),
  cwd: Type.Optional(Identifier),
  focus: Type.Optional(Type.Boolean()),
  initialPrompt: Type.Optional(Type.String({ minLength: 1, pattern: "^[^\\u0000]*$" })),
  initialPromptDelivery: Type.Optional(StringEnum(["inline", "attachment"] as const))
};

const RawLaunchParamsSchema = Type.Object({
  ...LaunchCommonProperties,
  kind: StringEnum(LAUNCH_AGENT_KINDS),
  argv: Type.Optional(Type.Array(AgentArgument)),
  env: Type.Optional(Type.Record(Identifier, EnvValue))
}, { additionalProperties: false });

const ProfileLaunchParamsSchema = Type.Object({
  ...LaunchCommonProperties,
  profile: Identifier,
  overrides: Type.Optional(ProfileLaunchOverridesSchema)
}, { additionalProperties: false });

export const LaunchParamsSchema = Type.Union([RawLaunchParamsSchema, ProfileLaunchParamsSchema]);

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
  kind?: LaunchAgentKind;
  profile?: string;
  argv?: string[];
  overrides?: ProfileLaunchOverrides;
  placement?: LaunchPlacement;
  label?: string;
  cwd?: string;
  env?: Record<string, string>;
  focus?: boolean;
  initialPrompt?: string;
  initialPromptDelivery?: MessageDelivery;
}

export function isLaunchAgentKind(value: unknown): value is LaunchAgentKind {
  return typeof value === "string" && (LAUNCH_AGENT_KINDS as readonly string[]).includes(value);
}
