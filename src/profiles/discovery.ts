import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseProfile, profileSource } from "./parser.js";
import { MAX_PROFILE_DIAGNOSTICS, type Profile, type ProfileCandidate, type ProfileCatalog, type ProfileDiagnostic, type ProfileSourceKind } from "./types.js";

export interface ProfileDiscoveryOptions {
  bundledDir: string;
  bundledScopeRoot?: string;
  projectCwd?: string;
  userHome?: string;
  userDir?: string;
  userScopeRoot?: string;
  projectDir?: string;
  projectRoot?: string;
}

function addDiagnostic(list: ProfileDiagnostic[], item: ProfileDiagnostic): void {
  if (list.length < MAX_PROFILE_DIAGNOSTICS) list.push(item);
}

async function filesIn(directory: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => join(directory, entry.name)).sort();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function existingNearestProjectDir(cwd: string): Promise<string | undefined> {
  let current = resolve(cwd);
  while (true) {
    const candidate = join(current, ".pi", "herdr-profiles");
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) return candidate;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function readSource(kind: ProfileSourceKind, directory: string, scopeRoot: string, candidates: ProfileCandidate[], diagnostics: ProfileDiagnostic[]): Promise<void> {
  for (const path of await filesIn(directory)) {
    const source = profileSource(kind, path, scopeRoot);
    try {
      const profile = parseProfile(await fs.readFile(path, "utf8"), source);
      candidates.push({ name: profile.name, profile, source });
    } catch (error) {
      const message = String(error);
      const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
      const item: ProfileDiagnostic = { code: "INVALID_PROFILE", message, path, name, source };
      candidates.push({ name, source, diagnostic: item });
      addDiagnostic(diagnostics, item);
    }
  }
}

export async function discoverProfiles(options: ProfileDiscoveryOptions): Promise<ProfileCatalog> {
  const candidates: ProfileCandidate[] = [];
  const diagnostics: ProfileDiagnostic[] = [];
  const home = options.userHome ?? homedir();
  const userDir = options.userDir ?? join(home, ".pi", "agent", "herdr-profiles");
  const projectDir = options.projectDir ?? (options.projectCwd ? await existingNearestProjectDir(options.projectCwd) : undefined);
  const sources: Array<[ProfileSourceKind, string, string]> = [
    ["bundled", resolve(options.bundledDir), resolve(options.bundledScopeRoot ?? dirname(options.bundledDir))],
    ["user", resolve(userDir), resolve(options.userScopeRoot ?? join(home, ".pi", "agent"))],
  ];
  if (projectDir) sources.push(["project", resolve(projectDir), resolve(options.projectRoot ?? join(projectDir, "..", ".."))]);
  for (const [kind, directory, scopeRoot] of sources) {
    try {
      await readSource(kind, directory, scopeRoot, candidates, diagnostics);
    } catch (error) {
      const source = profileSource(kind, directory, scopeRoot);
      addDiagnostic(diagnostics, { code: "DISCOVERY_ERROR", message: String(error), path: directory, source });
    }
  }

  const effective = new Map<string, Profile>();
  for (const candidate of candidates) {
    if (!candidate.profile) continue;
    const prior = effective.get(candidate.name);
    if (!prior) effective.set(candidate.name, candidate.profile);
    else {
      addDiagnostic(diagnostics, { code: "SHADOWED_PROFILE", message: `${prior.source.path} is shadowed by ${candidate.source.path}`, path: prior.source.path, name: candidate.name, source: prior.source, relatedPath: candidate.source.path });
      effective.set(candidate.name, candidate.profile);
    }
  }

  const blocked = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.diagnostic) continue;
    const selected = effective.get(candidate.name);
    if (selected && candidate.source.precedence >= selected.source.precedence) {
      effective.delete(candidate.name);
      blocked.add(candidate.name);
      addDiagnostic(diagnostics, { code: "BLOCKED_PROFILE", message: `${candidate.source.path} blocks lower-precedence profile ${selected.source.path}`, path: candidate.source.path, name: candidate.name, source: candidate.source, relatedPath: selected.source.path });
    }
  }
  return { effective, candidates, diagnostics, blocked };
}

export function profileCatalog(options: ProfileDiscoveryOptions): () => Promise<ProfileCatalog> {
  return () => discoverProfiles(options);
}
