import type { ClaudeRuntimeOverrides, PiRuntimeOverrides, Profile, ProfileKind, RuntimeOverrides } from "./types.js";

export interface AttachmentCapability {
  capable: boolean;
  reason: string;
}

function piCapability(tools: readonly string[]): AttachmentCapability {
  if (tools.length === 0 || tools.includes("read")) {
    return { capable: true, reason: "Pi profile has the bounded local read tool" };
  }
  return { capable: false, reason: "Pi profile excludes the local read tool" };
}

function claudeCapability(allowedTools: readonly string[], disallowedTools: readonly string[]): AttachmentCapability {
  if (disallowedTools.includes("Read")) {
    return { capable: false, reason: "Claude profile disallows Read" };
  }
  if (allowedTools.length > 0 && !allowedTools.includes("Read")) {
    return { capable: false, reason: "Claude profile allowlist excludes Read" };
  }
  return { capable: true, reason: "Claude profile can read its granted attachment directory" };
}

/**
 * Capability is derived from the effective post-override runtime, because a typed call
 * override can remove the very read tool an attachment reference depends on.
 */
export function attachmentCapability(profile: Profile, overrides: RuntimeOverrides = {}): AttachmentCapability & { kind: ProfileKind } {
  if (profile.runtime.kind === "pi") {
    const tools = (overrides as PiRuntimeOverrides).tools ?? profile.runtime.tools;
    return { kind: "pi", ...piCapability(tools) };
  }
  if (profile.runtime.kind === "claude") {
    const claudeOverrides = overrides as ClaudeRuntimeOverrides;
    const allowedTools = claudeOverrides.allowedTools ?? profile.runtime.allowedTools;
    const disallowedTools = claudeOverrides.disallowedTools ?? profile.runtime.disallowedTools;
    return { kind: "claude", ...claudeCapability(allowedTools, disallowedTools) };
  }
  if (profile.runtime.kind === "agy") {
    return { kind: "agy", capable: true, reason: "AGY profile can read its granted attachment directory" };
  }
  return { kind: "devin", capable: true, reason: "Devin profile can read its granted attachment directory" };
}
