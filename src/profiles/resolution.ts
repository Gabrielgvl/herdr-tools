import { RESERVED_BUNDLED_PROFILE_NAMES, type Profile, type ProfileCandidate, type ProfileCatalog, type ProfileResolution, type ProfileSourceKind } from "./types.js";

export class ProfileResolutionError extends Error {
  readonly code = "PROFILE_RESOLUTION_INVALID" as const;
  constructor(message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ProfileResolutionError";
  }
}

const PROFILE_SCOPE_PRECEDENCE: Record<ProfileSourceKind, number> = { bundled: 0, user: 1, project: 2 };

type ProfileBlocker =
  | { kind: "effective"; precedence: number; profile: Profile }
  | { kind: "invalid"; precedence: number; candidate: ProfileCandidate }
  | { kind: "unreadable"; precedence: number; scope: ProfileSourceKind };

function highestUnreadableScope(catalog: ProfileCatalog): ProfileSourceKind | undefined {
  return [...(catalog.unreadableScopes ?? [])].sort((left, right) => PROFILE_SCOPE_PRECEDENCE[right] - PROFILE_SCOPE_PRECEDENCE[left])[0];
}

function highestInvalidCandidate(catalog: ProfileCatalog, name: string): ProfileCandidate | undefined {
  return catalog.candidates
    .filter((candidate) => candidate.name === name && candidate.diagnostic !== undefined)
    .sort((left, right) => right.source.precedence - left.source.precedence)[0];
}

function compareBlockers(left: ProfileBlocker, right: ProfileBlocker): number {
  const precedence = right.precedence - left.precedence;
  return precedence !== 0 ? precedence : Number(right.kind !== "unreadable") - Number(left.kind !== "unreadable");
}

function highestBlocker(catalog: ProfileCatalog, name: string, value: Profile | undefined): ProfileBlocker | undefined {
  const blockers: ProfileBlocker[] = [];
  if (value) blockers.push({ kind: "effective", precedence: value.source.precedence, profile: value });
  const invalid = highestInvalidCandidate(catalog, name);
  if (invalid) blockers.push({ kind: "invalid", precedence: invalid.source.precedence, candidate: invalid });
  const unreadable = highestUnreadableScope(catalog);
  if (unreadable) blockers.push({ kind: "unreadable", precedence: PROFILE_SCOPE_PRECEDENCE[unreadable], scope: unreadable });
  blockers.sort(compareBlockers);
  return blockers[0];
}

function profile(catalog: ProfileCatalog, name: string): Profile {
  const value = catalog.effective.get(name);
  if (RESERVED_BUNDLED_PROFILE_NAMES.has(name)) {
    if (value?.source.kind !== "bundled") throw new ProfileResolutionError(`Reserved profile ${name} is unavailable from the bundled catalog`, { name, blocked: true });
    return value;
  }
  const blocker = highestBlocker(catalog, name, value);
  if (blocker?.kind === "invalid") throw new ProfileResolutionError(`Profile ${name} is blocked by an invalid higher-precedence candidate`, { name, blocked: true, candidatePath: blocker.candidate.source.path });
  if (blocker?.kind === "unreadable") {
    const message = value ? `Profile ${name} is blocked by unreadable ${blocker.scope} profile scope` : `Profile ${name} cannot be resolved because the ${blocker.scope} profile scope is unreadable`;
    throw new ProfileResolutionError(message, { name, unreadableScope: blocker.scope, blocked: true });
  }
  if (!value) throw new ProfileResolutionError(catalog.blocked?.has(name) ? `Profile ${name} is blocked by an invalid higher-precedence candidate` : `Unknown profile ${name}`, { name, blocked: catalog.blocked?.has(name) === true });
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
    if (!reachable.includes(currentName)) {
      if (reachable.length >= maxAttempts) throw new ProfileResolutionError("Profile fallback graph exceeds the attempt limit", { name, maxAttempts, path: [...active, currentName] });
      reachable.push(currentName);
    }
    active.push(currentName);
    for (const fallback of current.fallbackProfiles) visit(fallback, depth + 1);
    active.pop();
  };
  visit(root.name, 1);
  return { profile: root, fallbackProfiles: [...root.fallbackProfiles], reachableNames: reachable };
}
