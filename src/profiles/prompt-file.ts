import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface PromptFileHandle {
  path: string;
  cleanup(): Promise<void>;
}

export interface PromptFileIo {
  mkdtemp(prefix: string): Promise<string>;
  writeFile(path: string, data: Uint8Array, options: { mode: number }): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  rm(path: string, options: { force: boolean; recursive: boolean }): Promise<void>;
}

const nodePromptFileIo: PromptFileIo = {
  mkdtemp: (prefix) => fs.mkdtemp(prefix),
  writeFile: async (path, data, options) => { await fs.writeFile(path, data, options); },
  chmod: (path, mode) => fs.chmod(path, mode),
  rm: (path, options) => fs.rm(path, options)
};

export async function createPromptFile(body: string, io: PromptFileIo = nodePromptFileIo, temporaryRoot = tmpdir()): Promise<PromptFileHandle> {
  const directory = await io.mkdtemp(join(temporaryRoot, "herdr-tools-"));
  const path = join(directory, "profile-prompt.md");
  try {
    await io.writeFile(path, Buffer.from(body, "utf8"), { mode: 0o600 });
    await io.chmod(path, 0o600);
  } catch (error) {
    await io.rm(directory, { force: true, recursive: true });
    throw error;
  }
  let cleaned = false;
  return {
    path,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await io.rm(directory, { force: true, recursive: true });
    }
  };
}

export interface PromptFileFactory {
  create(body: string): Promise<PromptFileHandle>;
}

export const defaultPromptFileFactory: PromptFileFactory = {
  create: (body) => createPromptFile(body)
};
