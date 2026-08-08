import { CLAUDE_EFFORTS, CLAUDE_PERMISSION_MODES, THINKING_LEVELS, type ClaudeRuntimeOverrides, type ClaudeEffort, type ClaudePermissionMode, type PiRuntimeOverrides, type Profile, type RuntimeOverrides, type ThinkingLevel } from "./types.js";

export class ProfileAdapterError extends Error {
  readonly code = "INVALID_PROFILE_OVERRIDE" as const;
  constructor(message: string) {
    super(message);
    this.name = "ProfileAdapterError";
  }
}

function model(value: string | undefined, fallback: string): string {
  const result = value ?? fallback;
  if (result.length === 0 || /[\0\r\n]/.test(result)) throw new ProfileAdapterError("model override must be a non-empty single-line string");
  return result;
}

function thinking(value: unknown, fallback: ThinkingLevel): ThinkingLevel {
  const result = value ?? fallback;
  if (!THINKING_LEVELS.includes(result as ThinkingLevel)) throw new ProfileAdapterError("thinking override is invalid");
  return result as ThinkingLevel;
}

function effort(value: unknown, fallback: ClaudeEffort): ClaudeEffort {
  const result = value ?? fallback;
  if (!CLAUDE_EFFORTS.includes(result as ClaudeEffort)) throw new ProfileAdapterError("effort override is invalid");
  return result as ClaudeEffort;
}

function permissionMode(value: unknown, fallback: ClaudePermissionMode): ClaudePermissionMode {
  const result = value ?? fallback;
  if (!CLAUDE_PERMISSION_MODES.includes(result as ClaudePermissionMode)) throw new ProfileAdapterError("permission mode override is invalid");
  return result as ClaudePermissionMode;
}

function values(value: string[] | undefined, fallback: string[]): string[] {
  const result = value ?? fallback;
  if (!Array.isArray(result) || result.some((item) => typeof item !== "string" || item.length === 0 || /[\0\r\n]/.test(item))) throw new ProfileAdapterError("runtime values must be non-empty strings without NUL or newlines");
  return result;
}

function repeated(flag: string, items: string[]): string[] {
  return items.flatMap((item) => [flag, item]);
}

function commaSeparated(flag: string, items: string[]): string[] {
  return items.length === 0 ? [] : [flag, items.join(",")];
}

function permissionArgs(mode: ClaudePermissionMode): string[] {
  return mode === "bypassPermissions" ? ["--allow-dangerously-skip-permissions", "--permission-mode", mode] : ["--permission-mode", mode];
}

function promptFileArg(flag: string, path: string | undefined): string[] {
  if (path === undefined) return [];
  if (path.length === 0 || /[\0\r\n]/.test(path)) throw new ProfileAdapterError("prompt file path must be a non-empty single-line string");
  return [flag, path];
}

export function buildPiArgv(profile: Extract<Profile["runtime"], { kind: "pi" }>, sessionPersistence: boolean, overrides: PiRuntimeOverrides = {}, promptFilePath?: string): string[] {
  const args = ["--model", model(overrides.model, profile.model), "--thinking", thinking(overrides.thinking, profile.thinking), ...commaSeparated("--tools", values(overrides.tools, profile.tools)), ...repeated("--extension", values(overrides.extensions, profile.extensions)), ...repeated("--skill", values(overrides.skills, profile.skills))];
  if (!sessionPersistence) args.push("--no-session");
  return [...args, ...promptFileArg("--append-system-prompt", promptFilePath)];
}

export function buildClaudeArgv(profile: Extract<Profile["runtime"], { kind: "claude" }>, sessionPersistence: boolean, overrides: ClaudeRuntimeOverrides = {}, promptFilePath?: string): string[] {
  const args = ["--model", model(overrides.model, profile.model), "--effort", effort(overrides.effort, profile.effort), ...permissionArgs(permissionMode(overrides.permissionMode, profile.permissionMode)), ...repeated("--allowed-tools", values(overrides.allowedTools, profile.allowedTools)), ...repeated("--disallowed-tools", values(overrides.disallowedTools, profile.disallowedTools)), ...repeated("--add-dir", values(overrides.addDirs, profile.addDirs)), ...repeated("--plugin-dir", values(overrides.pluginDirs, profile.pluginDirs))];
  if (!sessionPersistence) args.push("--no-session-persistence");
  return [...args, ...promptFileArg("--append-system-prompt-file", promptFilePath)];
}

export function buildProfileArgv(profile: Profile, overrides: RuntimeOverrides = {}, promptFilePath?: string): string[] {
  if (profile.runtime.kind === "pi") {
    if ("effort" in overrides && overrides.effort !== undefined) throw new ProfileAdapterError("effort is only valid for Claude profiles");
    return buildPiArgv(profile.runtime, profile.sessionPersistence, overrides as PiRuntimeOverrides, promptFilePath);
  }
  if ("thinking" in overrides && overrides.thinking !== undefined) throw new ProfileAdapterError("thinking is only valid for Pi profiles");
  return buildClaudeArgv(profile.runtime, profile.sessionPersistence, overrides as ClaudeRuntimeOverrides, promptFilePath);
}
