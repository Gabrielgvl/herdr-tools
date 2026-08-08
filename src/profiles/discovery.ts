import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseProfile, profileSource } from "./parser.js";
import {
  MAX_PROFILE_DIAGNOSTICS,
  type Profile,
  type ProfileCandidate,
  type ProfileCatalog,
  type ProfileDiagnostic,
  type ProfileSourceKind,
} from "./types.js";

export interface ProfileDiscoveryOptions {
  bundledDir: string;
  projectCwd?: string;
  userHome?: string;
  userDir?: string;
  projectDir?: string;
}

function diagnostic(input: ProfileDiagnostic): ProfileDiagnostic {
  return input;
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

async function readSource(kind: ProfileSourceKind, directory: string, candidates: ProfileCandidate[], diagnostics: ProfileDiagnostic[]): Promise<void> {
  const paths = await filesIn(directory);
  for (const path of paths) {
    const source = profileSource(kind, path, directory);
    try {
      const text = await fs.readFile(path, "utf8");
      const profile = parseProfile(text, source);
      candidates.push({ name: profile.name, profile, source });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
      const item = diagnostic({ code: "INVALID_PROFILE", message, path, name, source });
      candidates.push({ name, source, diagnostic: item });
      addDiagnostic(diagnostics, item);
    }
  }
}

export async function discoverProfiles(options: ProfileDiscoveryOptions): Promise<ProfileCatalog> {
  const candidates: ProfileCandidate[] = [];
  const diagnostics: ProfileDiagnostic[] = [];
  const userDir = options.userDir ?? join(options.userHome ?? homedir(), ".pi", "agent", "herdr-profiles");
  const projectDir = options.projectDir ?? (options.projectCwd ? await existingNearestProjectDir(options.projectCwd) : undefined);
  const sources: Array<[ProfileSourceKind, string]> = [["bundled", resolve(options.bundledDir)], ["user", resolve(userDir)]];
  if (projectDir) sources.push(["project", resolve(projectDir)]);
  for (const [kind, directory] of sources) {
    try {
      await readSource(kind, directory, candidates, diagnostics);
    } catch (error) {
      const source = profileSource(kind, directory, directory);
      addDiagnostic(diagnostics, diagnostic({ code: "DISCOVERY_ERROR", message: error instanceof Error ? error.message : String(error), path: directory, source }));
    }
  }

  const effective = new Map<string, Profile>();
  for (const candidate of candidates) {
    if (!candidate.profile) continue;
    const prior = effective.get(candidate.name);
    if (!prior || candidate.source.precedence > prior.source.precedence) {
      if (prior) {
        const shadow = diagnostic({ code: "SHADOWED_PROFILE", message: `${prior.source.path} is shadowed by ${candidate.source.path}`, path: prior.source.path, name: candidate.name, source: prior.source, relatedPath: candidate.source.path });
        addDiagnostic(diagnostics, shadow);
      }
      effective.set(candidate.name, candidate.profile);
    } else {
      const shadow = diagnostic({ code: "SHADOWED_PROFILE", message: `${candidate.source.path} is shadowed by ${prior.source.path}`, path: candidate.source.path, name: candidate.name, source: candidate.source, relatedPath: prior.source.path });
      addDiagnostic(diagnostics, shadow);
    }
  }
  return { effective, candidates, diagnostics };
}

export function profileCatalog(options: ProfileDiscoveryOptions): () => Promise<ProfileCatalog> {
  return () => discoverProfiles(options);
}
