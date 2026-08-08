import type { Profile, ProfileCatalog, ProfileResolution } from "./types.js";

export class ProfileResolutionError extends Error {
  readonly code = "PROFILE_RESOLUTION_INVALID" as const;
  constructor(message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ProfileResolutionError";
  }
}

function profile(catalog: ProfileCatalog, name: string): Profile {
  const value = catalog.effective.get(name);
  if (!value) throw new ProfileResolutionError(`Unknown profile ${name}`, { name });
  return value;
}

export function resolveProfile(name: string, catalog: ProfileCatalog, maxAttempts = 3): ProfileResolution {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) throw new ProfileResolutionError("Profile name must be lowercase kebab-case", { name });
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new ProfileResolutionError("maxAttempts must be a positive integer");
  const root = profile(catalog, name);
  const reachable: string[] = [];
  const active: string[] = [];
  const visit = (currentName: string, depth: number): void => {
    if (depth > maxAttempts) throw new ProfileResolutionError("Profile fallback graph exceeds the attempt limit", { name, maxAttempts, path: [...active, currentName] });
    const current = profile(catalog, currentName);
    if (active.includes(currentName)) throw new ProfileResolutionError("Profile fallback graph contains a cycle", { name, cycle: [...active, currentName] });
    if (!reachable.includes(currentName)) reachable.push(currentName);
    active.push(currentName);
    for (const fallback of current.fallbacks) visit(fallback, depth + 1);
    active.pop();
  };
  visit(root.name, 1);
  return { profile: root, fallbackNames: [...root.fallbacks], reachableNames: reachable };
}
