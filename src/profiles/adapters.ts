import { resolve } from "node:path";
import { CLAUDE_PERMISSION_MODES, THINKING_LEVELS, type ClaudePermissionMode, type PiRuntimeOverrides, type Profile, type RuntimeOverrides, type ThinkingLevel } from "./types.js";

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

function permissionMode(value: unknown, fallback: ClaudePermissionMode): ClaudePermissionMode {
  const result = value ?? fallback;
  if (!CLAUDE_PERMISSION_MODES.includes(result as ClaudePermissionMode)) throw new ProfileAdapterError("permissionMode override is invalid");
  return result as ClaudePermissionMode;
}

function resourceArgs(flag: string, values: readonly string[]): string[] {
  return values.flatMap((value) => [flag, resolve(value)]);
}

export function buildPiArgv(profile: Extract<Profile["runtime"], { kind: "pi" }>, overrides: PiRuntimeOverrides = {}, systemPrompt?: string): string[] {
  const args = ["--model", model(overrides.model, profile.model), "--thinking", thinking(overrides.thinking, profile.thinking), ...resourceArgs("--extension", profile.extensions), ...resourceArgs("--skill", profile.skills)];
  return systemPrompt === undefined ? args : [...args, "--append-system-prompt", systemPrompt];
}

export function buildClaudeArgv(profile: Extract<Profile["runtime"], { kind: "claude" }>, overrides: RuntimeOverrides = {}, systemPrompt?: string): string[] {
  const selected = permissionMode("permissionMode" in overrides ? overrides.permissionMode : undefined, profile.permissionMode);
  const args = ["--model", model(overrides.model, profile.model), "--permission-mode", selected];
  if (selected === "bypassPermissions") args.push("--dangerously-skip-permissions");
  const resources = [...args, ...resourceArgs("--extension", profile.extensions), ...resourceArgs("--skill", profile.skills)];
  return systemPrompt === undefined ? resources : [...resources, "--append-system-prompt", systemPrompt];
}

export function buildProfileArgv(profile: Profile, overrides: RuntimeOverrides = {}): string[] {
  if (profile.runtime.kind === "pi") {
    if ("permissionMode" in overrides && overrides.permissionMode !== undefined) throw new ProfileAdapterError("permissionMode is only valid for Claude profiles");
    return buildPiArgv(profile.runtime, overrides as PiRuntimeOverrides, profile.body);
  }
  if ("thinking" in overrides && overrides.thinking !== undefined) throw new ProfileAdapterError("thinking is only valid for Pi profiles");
  return buildClaudeArgv(profile.runtime, overrides, profile.body);
}
