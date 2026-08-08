import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createPromptFile, defaultPromptFileFactory, type PromptFileIo } from "../../src/profiles/prompt-file.js";

describe("profile prompt file transport", () => {
  it("writes exact UTF-8 body bytes with mode 0600 and removes the temporary directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-tools-test-"));
    try {
      const body = "raw\nbody\n☃";
      const handle = await createPromptFile(body, undefined, root);
      expect(await readFile(handle.path)).toEqual(Buffer.from(body, "utf8"));
      expect((await stat(handle.path)).mode & 0o777).toBe(0o600);
      await handle.cleanup();
      await handle.cleanup();
      await expect(stat(handle.path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes the default factory and keeps file I/O injectable", async () => {
    const calls: Array<{ operation: string; path: string; data?: Uint8Array; options?: unknown }> = [];
    const io: PromptFileIo = {
      mkdtemp: vi.fn(async (prefix) => {
        calls.push({ operation: "mkdtemp", path: prefix });
        return "/tmp/herdr-tools-test-dir";
      }),
      writeFile: vi.fn(async (path, data, options) => {
        calls.push({ operation: "writeFile", path, data, options });
      }),
      chmod: vi.fn(async (path, mode) => {
        calls.push({ operation: "chmod", path, options: mode });
      }),
      rm: vi.fn(async (path, options) => {
        calls.push({ operation: "rm", path, options });
      })
    };
    const handle = await createPromptFile("body\n☃", io, "/tmp");
    expect(calls[1]).toMatchObject({ operation: "writeFile", path: "/tmp/herdr-tools-test-dir/profile-prompt.md", options: { mode: 0o600 } });
    expect(Buffer.from(calls[1].data ?? [])).toEqual(Buffer.from("body\n☃", "utf8"));
    expect(calls[2]).toEqual({ operation: "chmod", path: "/tmp/herdr-tools-test-dir/profile-prompt.md", options: 0o600 });
    await handle.cleanup();
    expect(calls[3]).toEqual({ operation: "rm", path: "/tmp/herdr-tools-test-dir", options: { force: true, recursive: true } });
    const factoryHandle = await defaultPromptFileFactory.create("factory body");
    expect(factoryHandle.path).toEqual(expect.any(String));
    await factoryHandle.cleanup();
  });

  it("cleans the directory when writing or chmod fails", async () => {
    for (const failure of ["writeFile", "chmod"] as const) {
      const io: PromptFileIo = {
        mkdtemp: async () => "/tmp/herdr-tools-failure-dir",
        writeFile: async () => { if (failure === "writeFile") throw new Error("write failed"); },
        chmod: async () => { if (failure === "chmod") throw new Error("chmod failed"); },
        rm: vi.fn(async () => undefined)
      };
      await expect(createPromptFile("body", io, "/tmp")).rejects.toThrow(failure === "writeFile" ? "write failed" : "chmod failed");
      expect(io.rm).toHaveBeenCalledWith("/tmp/herdr-tools-failure-dir", { force: true, recursive: true });
    }
  });
});
