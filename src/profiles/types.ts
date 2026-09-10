export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const CLAUDE_EFFORTS = ["low", "medium", "high", "max"] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];

export const CLAUDE_PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk"] as const;
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];

export const PROFILE_KINDS = ["pi", "claude", "agy", "devin"] as const;
export type ProfileKind = (typeof PROFILE_KINDS)[number];

export const AGY_MODES = ["plan", "accept-edits"] as const;
export type AgyMode = (typeof AGY_MODES)[number];

/**
 * The canonical Devin `--permission-mode` values. `autonomous` is excluded
 * because it requires `--sandbox`, which profiles cannot express; the CLI's
 * `auto`/`yolo`/`bypass` spellings are aliases of the canonical names.
 */
export const DEVIN_PERMISSION_MODES = ["normal", "accept-edits", "smart", "dangerous"] as const;
export type DevinPermissionMode = (typeof DEVIN_PERMISSION_MODES)[number];
export type ProfileSourceKind = "bundled" | "user" | "project";

export const RESERVED_BUNDLED_PROFILE_NAMES = new Set(["promoter-pi", "promoter-claude"]);

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
  tools: string[];
  extensions: string[];
  skills: string[];
}

export interface ClaudeRuntimeProfile {
  kind: "claude";
  model: string;
  effort: ClaudeEffort;
  permissionMode: ClaudePermissionMode;
  allowedTools: string[];
  disallowedTools: string[];
  addDirs: string[];
  pluginDirs: string[];
  /**
   * Claude Code Channels research-preview opt-in, as tagged entries such as
   * `server:herdr`. Profile-only by design: a launch override must not be able
   * to open an inbound message channel the profile did not declare.
   */
  developmentChannels: string[];
}

export interface AgyRuntimeProfile {
  kind: "agy";
  model: string;
  mode: AgyMode;
  addDirs: string[];
}

/**
 * Devin's native surface is a model plus a permission mode. Reasoning depth is
 * a property of the selected model tier (for example `swe-2-max`); the CLI
 * exposes no effort flag, prompt-file channel, or per-session tool selector.
 */
export interface DevinRuntimeProfile {
  kind: "devin";
  model: string;
  permissionMode: DevinPermissionMode;
}

export type RuntimeProfile = PiRuntimeProfile | ClaudeRuntimeProfile | AgyRuntimeProfile | DevinRuntimeProfile;

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
  /** Total diagnostics generated before the retained diagnostics cap. */
  diagnosticCount?: number;
  blocked?: ReadonlySet<string>;
  unreadableScopes?: readonly ProfileSourceKind[];
}

export interface ProfileResolution {
  profile: Profile;
  fallbackProfiles: readonly string[];
  reachableNames: readonly string[];
}

/**
 * Resource selection is profile-only. A launch override that could repoint
 * `extensions` or `skills` would turn the profile's exact allowlist back into
 * a hint, so those keys do not exist here and are rejected wherever they appear.
 */
export interface PiRuntimeOverrides {
  model?: string;
  thinking?: ThinkingLevel;
  tools?: string[];
}

/** `pluginDirs` is profile-only for the same reason as Pi `skills`. */
export interface ClaudeRuntimeOverrides {
  model?: string;
  effort?: ClaudeEffort;
  permissionMode?: ClaudePermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  addDirs?: string[];
}

export interface AgyRuntimeOverrides {
  model?: string;
  addDirs?: string[];
}

export interface DevinRuntimeOverrides {
  model?: string;
  permissionMode?: DevinPermissionMode;
}

export type RuntimeOverrides = PiRuntimeOverrides | ClaudeRuntimeOverrides | AgyRuntimeOverrides | DevinRuntimeOverrides;

export const MAX_PROFILE_BYTES = 64 * 1024;
export const MAX_PROFILE_BODY_BYTES = 32 * 1024;
export const MAX_PROFILE_DIAGNOSTICS = 32;
export const MAX_PROFILE_LIST_ITEMS = 100;
export const MAX_PROFILE_BODY_OUTPUT = 8 * 1024;
export const MAX_PROFILE_RESULT_BYTES = 50 * 1024;
