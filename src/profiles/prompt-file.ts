import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PromptSource {
  path: string;
}

export interface PromptSourceIo {
  mkdir(path: string, options: { recursive: boolean; mode: number }): Promise<void>;
  mkdtemp(prefix: string): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array, options: { mode: number }): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  rm(path: string, options: { force: boolean; recursive: boolean }): Promise<void>;
}

const nodePromptSourceIo: PromptSourceIo = {
  mkdir: async (path, options) => { await fs.mkdir(path, options); },
  mkdtemp: (prefix) => fs.mkdtemp(prefix),
  readFile: async (path) => fs.readFile(path),
  writeFile: async (path, data, options) => { await fs.writeFile(path, data, options); },
  chmod: (path, mode) => fs.chmod(path, mode),
  rename: (source, destination) => fs.rename(source, destination),
  rm: (path, options) => fs.rm(path, options)
};

export const DEFAULT_PROMPT_SOURCE_CACHE = join(homedir(), ".cache", "herdr-tools", "profile-prompts");

function errorCode(error: unknown): unknown {
  return error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isAlreadyPublishedRace(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

async function removeTemp(io: PromptSourceIo, path: string | undefined): Promise<void> {
  if (!path) return;
  try { await io.rm(path, { force: true, recursive: true }); } catch { /* preserve the startup/store error */ }
}

export async function createPromptSource(body: string, io: PromptSourceIo = nodePromptSourceIo, cacheDirectory = DEFAULT_PROMPT_SOURCE_CACHE): Promise<PromptSource> {
  const data = Buffer.from(body, "utf8");
  const digest = createHash("sha256").update(data).digest("hex");
  const path = join(cacheDirectory, `${digest}.md`);
  await io.mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  await io.chmod(cacheDirectory, 0o700);
  try {
    const existing = Buffer.from(await io.readFile(path));
    if (existing.equals(data)) {
      await io.chmod(path, 0o600);
      return { path };
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  let temporaryDirectory: string | undefined;
  try {
    temporaryDirectory = await io.mkdtemp(join(cacheDirectory, ".tmp-"));
    const temporaryPath = join(temporaryDirectory, "prompt.md");
    await io.writeFile(temporaryPath, data, { mode: 0o600 });
    await io.chmod(temporaryPath, 0o600);
    try {
      await io.rename(temporaryPath, path);
    } catch (error) {
      if (isAlreadyPublishedRace(error)) {
        try {
          if (Buffer.from(await io.readFile(path)).equals(data)) {
            await removeTemp(io, temporaryDirectory);
            return { path };
          }
        } catch {
          // Preserve the original publication error when the racing destination is unavailable.
        }
      }
      throw error;
    }
  } catch (error) {
    await removeTemp(io, temporaryDirectory);
    throw error;
  }
  await removeTemp(io, temporaryDirectory);
  return { path };
}

export interface PromptSourceStore {
  create(body: string): Promise<PromptSource>;
}

export const defaultPromptSourceStore: PromptSourceStore = {
  create: createPromptSource
};
