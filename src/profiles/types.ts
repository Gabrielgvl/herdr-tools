export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const CLAUDE_EFFORTS = ["low", "medium", "high", "max"] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];

export const PROFILE_KINDS = ["pi", "claude"] as const;
export type ProfileKind = (typeof PROFILE_KINDS)[number];
export type ProfileSourceKind = "bundled" | "user" | "project";

export interface ProfileSource {
  kind: ProfileSourceKind;
  path: string;
  scopeRoot: string;
  precedence: number;
}

export interface PiRuntimeProfile {
  kind: "pi";
  model: string;
  thinking: ThinkingLevel;
  tools?: string[];
}

export interface ClaudeRuntimeProfile {
  kind: "claude";
  model: string;
  effort: ClaudeEffort;
  tools?: string[];
}

export type RuntimeProfile = PiRuntimeProfile | ClaudeRuntimeProfile;

export interface Profile {
  name: string;
  description: string;
  timeoutMinutes: number;
  sessionPersistence: boolean;
  runtime: RuntimeProfile;
  fallbackProfiles: string[];
  body: string;
  source: ProfileSource;
}

export interface ProfileDiagnostic {
  code: "INVALID_PROFILE" | "DUPLICATE_PROFILE" | "SHADOWED_PROFILE" | "BLOCKED_PROFILE" | "DISCOVERY_ERROR";
  message: string;
  path?: string;
  name?: string;
  source?: ProfileSource;
  relatedPath?: string;
}

export interface ProfileCandidate {
  name: string;
  profile?: Profile;
  source: ProfileSource;
  diagnostic?: ProfileDiagnostic;
}

export interface ProfileCatalog {
  effective: ReadonlyMap<string, Profile>;
  candidates: readonly ProfileCandidate[];
  diagnostics: readonly ProfileDiagnostic[];
  blocked?: ReadonlySet<string>;
}

export interface ProfileResolution {
  profile: Profile;
  fallbackProfiles: readonly string[];
  reachableNames: readonly string[];
}

export interface PiRuntimeOverrides {
  model?: string;
  thinking?: ThinkingLevel;
}

export interface ClaudeRuntimeOverrides {
  model?: string;
  effort?: ClaudeEffort;
}

export type RuntimeOverrides = PiRuntimeOverrides | ClaudeRuntimeOverrides;

export const MAX_PROFILE_BYTES = 64 * 1024;
export const MAX_PROFILE_BODY_BYTES = 32 * 1024;
export const MAX_PROFILE_DIAGNOSTICS = 32;
export const MAX_PROFILE_LIST_ITEMS = 100;
export const MAX_PROFILE_BODY_OUTPUT = 8 * 1024;
