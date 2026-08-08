import { CLAUDE_EFFORTS, CLAUDE_PERMISSION_MODES, THINKING_LEVELS, type ClaudeRuntimeOverrides, type ClaudeEffort, type ClaudePermissionMode, type PiRuntimeOverrides, type Profile, type RuntimeOverrides, type ThinkingLevel } from "./types.js";
import { normalizeScopedResourcePath } from "./parser.js";

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

function scopedValues(value: string[] | undefined, fallback: string[], field: string, scopeRoot: string | undefined): string[] {
  const result = values(value, fallback);
  if (value === undefined) return result;
  if (scopeRoot === undefined) throw new ProfileAdapterError(`${field} overrides require a profile scope root`);
  try {
    return result.map((item) => normalizeScopedResourcePath(item, field, scopeRoot));
  } catch (error) {
    throw new ProfileAdapterError((error as Error).message);
  }
}

function rejectIncompatible(kind: "pi" | "claude", overrides: Record<string, unknown>): void {
  const invalid = kind === "pi"
    ? ["effort", "permissionMode", "allowedTools", "disallowedTools", "addDirs", "pluginDirs"]
    : ["thinking", "tools", "extensions", "skills"];
  for (const key of invalid) if (Object.prototype.hasOwnProperty.call(overrides, key)) throw new ProfileAdapterError(`${key} is only valid for ${kind === "pi" ? "Claude" : "Pi"} profiles`);
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

export function buildPiArgv(profile: Extract<Profile["runtime"], { kind: "pi" }>, sessionPersistence: boolean, overrides: PiRuntimeOverrides = {}, promptFilePath?: string, scopeRoot?: string): string[] {
  rejectIncompatible("pi", overrides as Record<string, unknown>);
  const args = ["--model", model(overrides.model, profile.model), "--thinking", thinking(overrides.thinking, profile.thinking), ...commaSeparated("--tools", values(overrides.tools, profile.tools)), ...repeated("--extension", scopedValues(overrides.extensions, profile.extensions, "overrides.extensions", scopeRoot)), ...repeated("--skill", scopedValues(overrides.skills, profile.skills, "overrides.skills", scopeRoot))];
  if (!sessionPersistence) args.push("--no-session");
  return [...args, ...promptFileArg("--append-system-prompt", promptFilePath)];
}

export function buildClaudeArgv(profile: Extract<Profile["runtime"], { kind: "claude" }>, sessionPersistence: boolean, overrides: ClaudeRuntimeOverrides = {}, promptFilePath?: string, scopeRoot?: string): string[] {
  if (!sessionPersistence) throw new ProfileAdapterError("Claude profiles must set sessionPersistence to true for interactive launches");
  rejectIncompatible("claude", overrides as Record<string, unknown>);
  const args = ["--model", model(overrides.model, profile.model), "--effort", effort(overrides.effort, profile.effort), ...permissionArgs(permissionMode(overrides.permissionMode, profile.permissionMode)), ...repeated("--allowed-tools", values(overrides.allowedTools, profile.allowedTools)), ...repeated("--disallowed-tools", values(overrides.disallowedTools, profile.disallowedTools)), ...repeated("--add-dir", scopedValues(overrides.addDirs, profile.addDirs, "overrides.addDirs", scopeRoot)), ...repeated("--plugin-dir", scopedValues(overrides.pluginDirs, profile.pluginDirs, "overrides.pluginDirs", scopeRoot))];
  return [...args, ...promptFileArg("--append-system-prompt-file", promptFilePath)];
}

export function buildProfileArgv(profile: Profile, overrides: RuntimeOverrides = {}, promptFilePath?: string): string[] {
  if (profile.runtime.kind === "pi") return buildPiArgv(profile.runtime, profile.sessionPersistence, overrides as PiRuntimeOverrides, promptFilePath, profile.source.scopeRoot);
  return buildClaudeArgv(profile.runtime, profile.sessionPersistence, overrides as ClaudeRuntimeOverrides, promptFilePath, profile.source.scopeRoot);
}
