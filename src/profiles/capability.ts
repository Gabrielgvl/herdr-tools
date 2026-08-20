import type { Profile, ProfileKind } from "./types.js";

export interface AttachmentCapability {
  capable: boolean;
  reason: string;
}

function piCapability(profile: Extract<Profile["runtime"], { kind: "pi" }>): AttachmentCapability {
  if (profile.tools.length === 0 || profile.tools.includes("read")) {
    return { capable: true, reason: "Pi profile has the bounded local read tool" };
  }
  return { capable: false, reason: "Pi profile excludes the local read tool" };
}

function claudeCapability(profile: Extract<Profile["runtime"], { kind: "claude" }>): AttachmentCapability {
  if (profile.disallowedTools.includes("Read")) {
    return { capable: false, reason: "Claude profile disallows Read" };
  }
  if (profile.allowedTools.length > 0 && !profile.allowedTools.includes("Read")) {
    return { capable: false, reason: "Claude profile allowlist excludes Read" };
  }
  return { capable: true, reason: "Claude profile can read its granted attachment directory" };
}

export function attachmentCapability(profile: Profile): AttachmentCapability & { kind: ProfileKind } {
  const capability = profile.runtime.kind === "pi" ? piCapability(profile.runtime) : claudeCapability(profile.runtime);
  return { kind: profile.runtime.kind, ...capability };
}
