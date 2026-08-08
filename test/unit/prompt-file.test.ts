import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createPromptSource, defaultPromptSourceStore, type PromptSourceIo } from "../../src/profiles/prompt-file.js";

describe("profile prompt source transport", () => {
  it("writes exact UTF-8 bytes with owner-only modes and reuses the stable content address", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-tools-test-"));
    try {
      const body = "raw\nbody\n☃";
      const first = await createPromptSource(body, undefined, root);
      const second = await createPromptSource(body, undefined, root);
      expect(second).toEqual(first);
      expect(await readFile(first.path)).toEqual(Buffer.from(body, "utf8"));
      expect((await stat(root)).mode & 0o777).toBe(0o700);
      expect((await stat(first.path)).mode & 0o777).toBe(0o600);
      expect(first.path).toMatch(/[a-f0-9]{64}\.md$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes the default durable store", async () => {
    expect(defaultPromptSourceStore.create).toEqual(expect.any(Function));
  });

  it("writes through the injected store I/O and cleans only temporary staging", async () => {
    const calls: Array<{ operation: string; path: string; data?: Uint8Array; options?: unknown }> = [];
    const io: PromptSourceIo = {
      mkdir: vi.fn(async (path, options) => { calls.push({ operation: "mkdir", path, options }); }),
      mkdtemp: vi.fn(async (prefix) => { calls.push({ operation: "mkdtemp", path: prefix }); return "/cache/.tmp-test"; }),
      readFile: vi.fn(async () => { const error = Object.assign(new Error("missing"), { code: "ENOENT" }); throw error; }),
      writeFile: vi.fn(async (path, data, options) => { calls.push({ operation: "writeFile", path, data, options }); }),
      chmod: vi.fn(async (path, mode) => { calls.push({ operation: "chmod", path, options: mode }); }),
      rename: vi.fn(async (source, destination) => { calls.push({ operation: "rename", path: `${source}->${destination}` }); }),
      rm: vi.fn(async (path, options) => { calls.push({ operation: "rm", path, options }); })
    };
    const result = await createPromptSource("body\n☃", io, "/cache");
    expect(result.path).toMatch(/^\/cache\/[a-f0-9]{64}\.md$/);
    expect(calls).toContainEqual({ operation: "mkdir", path: "/cache", options: { recursive: true, mode: 0o700 } });
    expect(calls).toContainEqual({ operation: "writeFile", path: "/cache/.tmp-test/prompt.md", data: Buffer.from("body\n☃"), options: { mode: 0o600 } });
    expect(calls).toContainEqual({ operation: "rename", path: expect.stringContaining(`->${result.path}`) });
    expect(calls.at(-1)).toEqual({ operation: "rm", path: "/cache/.tmp-test", options: { force: true, recursive: true } });
  });

  it("does not remove an existing shared source and preserves store failures", async () => {
    const io: PromptSourceIo = {
      mkdir: async () => undefined,
      mkdtemp: async () => { throw new Error("must not stage"); },
      readFile: async () => Buffer.from("same"),
      writeFile: async () => { throw new Error("must not write"); },
      chmod: vi.fn(async () => undefined),
      rename: async () => { throw new Error("must not rename"); },
      rm: vi.fn(async () => { throw new Error("must not remove shared source"); })
    };
    const result = await createPromptSource("same", io, "/cache");
    expect(result.path).toMatch(/^\/cache\/[a-f0-9]{64}\.md$/);
    expect(io.rm).not.toHaveBeenCalled();

    const corruptIo: PromptSourceIo = {
      mkdir: async () => undefined,
      mkdtemp: async () => "/cache/.tmp-corrupt",
      readFile: async () => Buffer.from("different"),
      writeFile: vi.fn(async () => undefined),
      chmod: async () => undefined,
      rename: vi.fn(async () => undefined),
      rm: vi.fn(async () => undefined)
    };
    await createPromptSource("same", corruptIo, "/cache");
    expect(corruptIo.writeFile).toHaveBeenCalled();

    const unreadableIo: PromptSourceIo = {
      mkdir: async () => undefined,
      mkdtemp: async () => { throw new Error("must not stage"); },
      readFile: async () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); },
      writeFile: async () => { throw new Error("must not write"); },
      chmod: async () => undefined,
      rename: async () => undefined,
      rm: vi.fn(async () => undefined)
    };
    await expect(createPromptSource("same", unreadableIo, "/cache")).rejects.toThrow("permission denied");

    const failure = new Error("cache unavailable");
    const failingIo: PromptSourceIo = {
      mkdir: async () => undefined,
      mkdtemp: async () => "/cache/.tmp-failure",
      readFile: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      writeFile: async () => { throw failure; },
      chmod: async () => undefined,
      rename: async () => undefined,
      rm: vi.fn(async () => undefined)
    };
    await expect(createPromptSource("new", failingIo, "/cache")).rejects.toBe(failure);
    expect(failingIo.rm).toHaveBeenCalledWith("/cache/.tmp-failure", { force: true, recursive: true });

    const stagingFailureIo: PromptSourceIo = {
      mkdir: async () => undefined,
      mkdtemp: async () => { throw new Error("staging failed"); },
      readFile: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      writeFile: async () => undefined,
      chmod: async () => undefined,
      rename: async () => undefined,
      rm: vi.fn(async () => undefined)
    };
    await expect(createPromptSource("staging", stagingFailureIo, "/cache")).rejects.toThrow("staging failed");
    expect(stagingFailureIo.rm).not.toHaveBeenCalled();

    const cleanupFailureIo: PromptSourceIo = {
      mkdir: async () => undefined,
      mkdtemp: async () => "/cache/.tmp-cleanup",
      readFile: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      writeFile: async () => undefined,
      chmod: async () => undefined,
      rename: async () => undefined,
      rm: vi.fn(async () => { throw new Error("cleanup failed"); })
    };
    await expect(createPromptSource("cleanup", cleanupFailureIo, "/cache")).resolves.toEqual(expect.objectContaining({ path: expect.any(String) }));
  });
});
