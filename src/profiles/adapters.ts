import { CLAUDE_EFFORTS, THINKING_LEVELS, type ClaudeRuntimeOverrides, type ClaudeEffort, type PiRuntimeOverrides, type Profile, type RuntimeOverrides, type ThinkingLevel } from "./types.js";

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

export function buildPiArgv(profile: Extract<Profile["runtime"], { kind: "pi" }>, sessionPersistence: boolean, overrides: PiRuntimeOverrides = {}, systemPrompt?: string): string[] {
  const args = ["--model", model(overrides.model, profile.model), "--thinking", thinking(overrides.thinking, profile.thinking)];
  if (!sessionPersistence) args.push("--no-session");
  return systemPrompt === undefined ? args : [...args, "--append-system-prompt", systemPrompt];
}

export function buildClaudeArgv(profile: Extract<Profile["runtime"], { kind: "claude" }>, sessionPersistence: boolean, overrides: ClaudeRuntimeOverrides = {}, systemPrompt?: string): string[] {
  const args = ["--model", model(overrides.model, profile.model), "--effort", effort(overrides.effort, profile.effort)];
  if (!sessionPersistence) args.push("--no-session-persistence");
  return systemPrompt === undefined ? args : [...args, "--append-system-prompt", systemPrompt];
}

export function buildProfileArgv(profile: Profile, overrides: RuntimeOverrides = {}): string[] {
  if (profile.runtime.kind === "pi") {
    if ("effort" in overrides && overrides.effort !== undefined) throw new ProfileAdapterError("effort is only valid for Claude profiles");
    return buildPiArgv(profile.runtime, profile.sessionPersistence, overrides as PiRuntimeOverrides, profile.body);
  }
  if ("thinking" in overrides && overrides.thinking !== undefined) throw new ProfileAdapterError("thinking is only valid for Pi profiles");
  return buildClaudeArgv(profile.runtime, profile.sessionPersistence, overrides as ClaudeRuntimeOverrides, profile.body);
}
