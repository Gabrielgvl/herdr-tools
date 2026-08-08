import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { CLAUDE_EFFORTS, THINKING_LEVELS, type ClaudeEffort, type ThinkingLevel } from "./profiles/types.js";

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

export const ProfileLaunchOverridesSchema = Type.Object({
  model: Type.Optional(Identifier),
  thinking: Type.Optional(StringEnum(THINKING_LEVELS)),
  effort: Type.Optional(StringEnum(CLAUDE_EFFORTS))
}, { additionalProperties: false });

export const LaunchParamsSchema = Type.Object({
  name: Identifier,
  kind: Type.Optional(StringEnum(LAUNCH_AGENT_KINDS)),
  profile: Type.Optional(Identifier),
  argv: Type.Optional(Type.Array(AgentArgument)),
  overrides: Type.Optional(ProfileLaunchOverridesSchema),
  placement: Type.Optional(LaunchPlacementSchema),
  label: Type.Optional(Identifier),
  cwd: Type.Optional(Identifier),
  env: Type.Optional(Type.Record(Identifier, EnvValue)),
  focus: Type.Optional(Type.Boolean()),
  initialPrompt: Type.Optional(Type.String({ minLength: 1, pattern: "^[^\\u0000]*$" }))
}, { additionalProperties: false });

export type LaunchPlacement =
  | { mode: "same_tab" }
  | { mode: "new_tab"; tabLabel: string }
  | { mode: "existing_pane"; target: string };

export interface ProfileLaunchOverrides {
  model?: string;
  thinking?: ThinkingLevel;
  effort?: ClaudeEffort;
}

export interface LaunchParams {
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
}

export function isLaunchAgentKind(value: unknown): value is LaunchAgentKind {
  return typeof value === "string" && (LAUNCH_AGENT_KINDS as readonly string[]).includes(value);
}
