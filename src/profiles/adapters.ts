import { CLAUDE_EFFORTS, CLAUDE_PERMISSION_MODES, THINKING_LEVELS, type AgyRuntimeOverrides, type ClaudeRuntimeOverrides, type ClaudeEffort, type ClaudePermissionMode, type PiRuntimeOverrides, type Profile, type ProfileKind, type RuntimeOverrides, type ThinkingLevel } from "./types.js";
import { normalizeScopedResourcePath } from "./parser.js";
import { isAbsolute } from "node:path";

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

function rejectIncompatible(kind: ProfileKind, overrides: Record<string, unknown>): void {
  if (kind === "agy") {
    for (const key of Object.keys(overrides)) if (key !== "model" && key !== "addDirs") throw new ProfileAdapterError(`${key} is only valid for AGY profiles`);
    return;
  }
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

/**
 * The local Channels research-preview opt-in. Both flags are variadic on Claude
 * 2.1.252, and each is followed only by tagged entries, so the flags that come
 * after them are unaffected.
 */
function channelArgs(entries: string[]): string[] {
  return entries.length === 0 ? [] : ["--dangerously-load-development-channels", ...entries];
}

function promptFileArg(flag: string, path: string | undefined): string[] {
  if (path === undefined) return [];
  if (path.length === 0 || /[\0\r\n]/.test(path)) throw new ProfileAdapterError("prompt file path must be a non-empty single-line string");
  return [flag, path];
}

function attachmentDirectoryArg(path: string | undefined): string[] {
  if (path === undefined) return [];
  if (path.length === 0 || /[\0\r\n]/.test(path) || !isAbsolute(path)) throw new ProfileAdapterError("attachment directory must be an absolute single-line path");
  return ["--add-dir", path];
}

const AGY_BOOTSTRAP_PROMPT = "Initialize this interactive session and reply with exactly AGY_READY.";

export function resolvePiRuntime(profile: Extract<Profile["runtime"], { kind: "pi" }>, overrides: PiRuntimeOverrides = {}, scopeRoot?: string): Extract<Profile["runtime"], { kind: "pi" }> {
  rejectIncompatible("pi", overrides as Record<string, unknown>);
  return {
    kind: "pi",
    model: model(overrides.model, profile.model),
    thinking: thinking(overrides.thinking, profile.thinking),
    tools: values(overrides.tools, profile.tools),
    extensions: scopedValues(overrides.extensions, profile.extensions, "overrides.extensions", scopeRoot),
    skills: scopedValues(overrides.skills, profile.skills, "overrides.skills", scopeRoot)
  };
}

export function resolveClaudeRuntime(profile: Extract<Profile["runtime"], { kind: "claude" }>, overrides: ClaudeRuntimeOverrides = {}, scopeRoot?: string): Extract<Profile["runtime"], { kind: "claude" }> {
  rejectIncompatible("claude", overrides as Record<string, unknown>);
  return {
    kind: "claude",
    model: model(overrides.model, profile.model),
    effort: effort(overrides.effort, profile.effort),
    permissionMode: permissionMode(overrides.permissionMode, profile.permissionMode),
    allowedTools: values(overrides.allowedTools, profile.allowedTools),
    disallowedTools: values(overrides.disallowedTools, profile.disallowedTools),
    addDirs: scopedValues(overrides.addDirs, profile.addDirs, "overrides.addDirs", scopeRoot),
    pluginDirs: scopedValues(overrides.pluginDirs, profile.pluginDirs, "overrides.pluginDirs", scopeRoot),
    developmentChannels: [...profile.developmentChannels]
  };
}

export function resolveAgyRuntime(profile: Extract<Profile["runtime"], { kind: "agy" }>, overrides: AgyRuntimeOverrides = {}, scopeRoot?: string): Extract<Profile["runtime"], { kind: "agy" }> {
  rejectIncompatible("agy", overrides as Record<string, unknown>);
  return {
    kind: "agy",
    model: model(overrides.model, profile.model),
    addDirs: scopedValues(overrides.addDirs, profile.addDirs, "overrides.addDirs", scopeRoot)
  };
}

export function resolveProfileRuntime(profile: Profile, overrides: RuntimeOverrides = {}): Profile["runtime"] {
  if (profile.runtime.kind === "pi") return resolvePiRuntime(profile.runtime, overrides as PiRuntimeOverrides, profile.source.scopeRoot);
  if (profile.runtime.kind === "claude") return resolveClaudeRuntime(profile.runtime, overrides as ClaudeRuntimeOverrides, profile.source.scopeRoot);
  return resolveAgyRuntime(profile.runtime, overrides as AgyRuntimeOverrides, profile.source.scopeRoot);
}

export function buildPiArgv(profile: Extract<Profile["runtime"], { kind: "pi" }>, sessionPersistence: boolean, overrides: PiRuntimeOverrides = {}, promptFilePath?: string, scopeRoot?: string): string[] {
  const effective = resolvePiRuntime(profile, overrides, scopeRoot);
  const args = ["--model", effective.model, "--thinking", effective.thinking, ...commaSeparated("--tools", effective.tools), ...repeated("--extension", effective.extensions), ...repeated("--skill", effective.skills)];
  if (!sessionPersistence) args.push("--no-session");
  return [...args, ...promptFileArg("--append-system-prompt", promptFilePath)];
}

export function buildClaudeArgv(profile: Extract<Profile["runtime"], { kind: "claude" }>, sessionPersistence: boolean, overrides: ClaudeRuntimeOverrides = {}, promptFilePath?: string, scopeRoot?: string, attachmentDirectory?: string): string[] {
  if (!sessionPersistence) throw new ProfileAdapterError("Claude profiles must set sessionPersistence to true for interactive launches");
  const effective = resolveClaudeRuntime(profile, overrides, scopeRoot);
  const args = ["--model", effective.model, "--effort", effective.effort, ...permissionArgs(effective.permissionMode), ...repeated("--allowed-tools", effective.allowedTools), ...repeated("--disallowed-tools", effective.disallowedTools), ...repeated("--add-dir", effective.addDirs), ...repeated("--plugin-dir", effective.pluginDirs), ...channelArgs(effective.developmentChannels), ...attachmentDirectoryArg(attachmentDirectory)];
  return [...args, ...promptFileArg("--append-system-prompt-file", promptFilePath)];
}

export function buildAgyArgv(profile: Extract<Profile["runtime"], { kind: "agy" }>, sessionPersistence: boolean, overrides: AgyRuntimeOverrides = {}, promptFilePath?: string, scopeRoot?: string, attachmentDirectory?: string): string[] {
  if (!sessionPersistence) throw new ProfileAdapterError("AGY profiles must set sessionPersistence to true for interactive launches");
  if (promptFilePath !== undefined) throw new ProfileAdapterError("AGY profiles do not accept prompt source files");
  const effective = resolveAgyRuntime(profile, overrides, scopeRoot);
  return ["--model", effective.model, "--mode", "plan", "--dangerously-skip-permissions", ...repeated("--add-dir", effective.addDirs), ...attachmentDirectoryArg(attachmentDirectory), "--prompt-interactive", AGY_BOOTSTRAP_PROMPT];
}

export function buildRuntimeArgv(profile: Profile, runtime: Profile["runtime"], promptFilePath?: string, attachmentDirectory?: string): string[] {
  if (runtime.kind === "pi") return buildPiArgv(runtime, profile.sessionPersistence, {}, promptFilePath);
  if (runtime.kind === "claude") return buildClaudeArgv(runtime, profile.sessionPersistence, {}, promptFilePath, undefined, attachmentDirectory);
  return buildAgyArgv(runtime, profile.sessionPersistence, {}, promptFilePath, profile.source.scopeRoot, attachmentDirectory);
}

export function buildProfileArgv(profile: Profile, overrides: RuntimeOverrides = {}, promptFilePath?: string, attachmentDirectory?: string): string[] {
  return buildRuntimeArgv(profile, resolveProfileRuntime(profile, overrides), promptFilePath, attachmentDirectory);
}
