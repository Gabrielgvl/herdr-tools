import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, win32 } from "node:path";
import { parseProfile, profileSource } from "./parser.js";
import { MAX_PROFILE_BYTES, MAX_PROFILE_DIAGNOSTICS, RESERVED_BUNDLED_PROFILE_NAMES, type Profile, type ProfileCandidate, type ProfileCatalog, type ProfileDiagnostic, type ProfileSourceKind } from "./types.js";

export interface ProfileDiscoveryOptions {
  bundledDir: string;
  bundledScopeRoot?: string;
  projectCwd?: string;
  userHome?: string;
  userDir?: string;
  userScopeRoot?: string;
  projectDir?: string;
  projectRoot?: string;
  projectStat?: (path: string) => Promise<{ isDirectory(): boolean }>;
}

interface DiagnosticCounter {
  value: number;
}

function addDiagnostic(list: ProfileDiagnostic[], item: ProfileDiagnostic, counter: DiagnosticCounter): void {
  counter.value += 1;
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

class ProjectScopeDiscoveryError extends Error {
  readonly code = "PROJECT_SCOPE_DISCOVERY_ERROR" as const;
  constructor(readonly candidatePath: string, readonly scopeRoot: string, cause: unknown) {
    super(String(cause));
    this.name = "ProjectScopeDiscoveryError";
  }
}

async function existingNearestProjectDir(cwd: string, stat: (path: string) => Promise<{ isDirectory(): boolean }> = fs.stat): Promise<string | undefined> {
  let current = resolve(cwd);
  while (true) {
    const candidate = join(current, ".pi", "herdr-profiles");
    try {
      const result = await stat(candidate);
      if (result.isDirectory()) return candidate;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        // Continue searching ancestors when this candidate simply does not exist.
      } else {
        throw new ProjectScopeDiscoveryError(candidate, resolve(join(candidate, "..", "..")), error);
      }
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export interface ProfileReadHandle {
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  stat(): Promise<{ size: number }>;
  close(): Promise<void>;
}

export interface ProfileReadIo {
  stat(path: string): Promise<{ size: number }>;
  open(path: string, flags: string): Promise<ProfileReadHandle>;
}

export async function readProfileText(path: string, io: ProfileReadIo = fs): Promise<string> {
  const stat = await io.stat(path);
  if (stat.size > MAX_PROFILE_BYTES) throw new Error(`profile exceeds the ${MAX_PROFILE_BYTES}-byte limit`);
  const file = await io.open(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_PROFILE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await file.read(buffer, offset, buffer.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > MAX_PROFILE_BYTES) throw new Error(`profile exceeds the ${MAX_PROFILE_BYTES}-byte limit`);
    const finalStat = await file.stat();
    if (finalStat.size > MAX_PROFILE_BYTES) throw new Error(`profile exceeds the ${MAX_PROFILE_BYTES}-byte limit`);
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await file.close();
  }
}

export function profileNameFromPath(path: string): string {
  const hostBasename = basename(path);
  const fileName = hostBasename === path ? win32.basename(path) : hostBasename;
  return fileName.replace(/\.md$/, "");
}

async function readSource(kind: ProfileSourceKind, directory: string, scopeRoot: string, candidates: ProfileCandidate[], diagnostics: ProfileDiagnostic[], diagnosticCount: DiagnosticCounter): Promise<void> {
  for (const path of await filesIn(directory)) {
    const source = profileSource(kind, path, scopeRoot);
    try {
      const profile = parseProfile(await readProfileText(path), source);
      candidates.push({ name: profile.name, profile, source });
    } catch (error) {
      const message = String(error);
      const name = profileNameFromPath(path);
      const item: ProfileDiagnostic = { code: "INVALID_PROFILE", message, path, name, source };
      candidates.push({ name, source, diagnostic: item });
      addDiagnostic(diagnostics, item, diagnosticCount);
    }
  }
}

export async function discoverProfiles(options: ProfileDiscoveryOptions): Promise<ProfileCatalog> {
  const candidates: ProfileCandidate[] = [];
  const diagnostics: ProfileDiagnostic[] = [];
  const diagnosticCount: DiagnosticCounter = { value: 0 };
  const unreadableScopes: ProfileSourceKind[] = [];
  const home = options.userHome ?? homedir();
  const userDir = options.userDir ?? join(home, ".pi", "agent", "herdr-profiles");
  let projectDir = options.projectDir;
  let projectDiscoveryError: ProjectScopeDiscoveryError | undefined;
  if (!projectDir && options.projectCwd) {
    try {
      projectDir = await existingNearestProjectDir(options.projectCwd, options.projectStat);
    } catch (error) {
      projectDiscoveryError = error as ProjectScopeDiscoveryError;
    }
  }
  const sources: Array<[ProfileSourceKind, string, string]> = [
    ["bundled", resolve(options.bundledDir), resolve(options.bundledScopeRoot ?? dirname(options.bundledDir))],
    ["user", resolve(userDir), resolve(options.userScopeRoot ?? join(home, ".pi", "agent"))],
  ];
  if (projectDir) sources.push(["project", resolve(projectDir), resolve(options.projectRoot ?? join(projectDir, "..", ".."))]);
  if (projectDiscoveryError) {
    const source = profileSource("project", projectDiscoveryError.candidatePath, projectDiscoveryError.scopeRoot);
    addDiagnostic(diagnostics, { code: "DISCOVERY_ERROR", message: projectDiscoveryError.message, path: projectDiscoveryError.candidatePath, source }, diagnosticCount);
    unreadableScopes.push("project");
  }
  for (const [kind, directory, scopeRoot] of sources) {
    try {
      await readSource(kind, directory, scopeRoot, candidates, diagnostics, diagnosticCount);
    } catch (error) {
      const source = profileSource(kind, directory, scopeRoot);
      addDiagnostic(diagnostics, { code: "DISCOVERY_ERROR", message: String(error), path: directory, source }, diagnosticCount);
      unreadableScopes.push(kind);
    }
  }

  const effective = new Map<string, Profile>();
  for (const candidate of candidates) {
    if (!candidate.profile) continue;
    if (candidate.source.kind !== "bundled" && RESERVED_BUNDLED_PROFILE_NAMES.has(candidate.name)) {
      addDiagnostic(diagnostics, { code: "SHADOWED_PROFILE", message: `${candidate.source.path} cannot replace reserved bundled profile ${candidate.name}`, path: candidate.source.path, name: candidate.name, source: candidate.source }, diagnosticCount);
      continue;
    }
    const prior = effective.get(candidate.name);
    if (!prior) effective.set(candidate.name, candidate.profile);
    else {
      addDiagnostic(diagnostics, { code: "SHADOWED_PROFILE", message: `${prior.source.path} is shadowed by ${candidate.source.path}`, path: prior.source.path, name: candidate.name, source: prior.source, relatedPath: candidate.source.path }, diagnosticCount);
      effective.set(candidate.name, candidate.profile);
    }
  }

  const blocked = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.diagnostic || (candidate.source.kind !== "bundled" && RESERVED_BUNDLED_PROFILE_NAMES.has(candidate.name))) continue;
    const selected = effective.get(candidate.name);
    if (selected && candidate.source.precedence >= selected.source.precedence) {
      effective.delete(candidate.name);
      blocked.add(candidate.name);
      addDiagnostic(diagnostics, { code: "BLOCKED_PROFILE", message: `${candidate.source.path} blocks lower-precedence profile ${selected.source.path}`, path: candidate.source.path, name: candidate.name, source: candidate.source, relatedPath: selected.source.path }, diagnosticCount);
    }
  }
  return { effective, candidates, diagnostics, diagnosticCount: diagnosticCount.value, blocked, unreadableScopes };
}

export function profileCatalog(options: ProfileDiscoveryOptions): () => Promise<ProfileCatalog> {
  return () => discoverProfiles(options);
}
