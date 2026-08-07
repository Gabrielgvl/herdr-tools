import { beforeEach, describe, expect, it, vi } from "vitest";

const readFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", () => ({ readFile: readFileMock }));

import { DEFAULT_SETTINGS, SettingsError, loadSettings, type SettingsFile } from "../../src/settings.js";

function fsWith(value: string | undefined) {
  const paths: string[] = [];
  return {
    paths,
    readFile: async (path: string) => {
      paths.push(path);
      if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return value;
    }
  };
}

describe("extension-owned settings", () => {
  beforeEach(() => readFileMock.mockReset());

  it("uses defaults when the extension-owned config is absent", async () => {
    const fake = fsWith(undefined);
    await expect(loadSettings({ readFile: fake.readFile })).resolves.toEqual(DEFAULT_SETTINGS);
    expect(fake.paths).toEqual(["/home/gabriel/.pi/agent/extensions/herdr-tools/config.json"]);
  });

  it("uses the default filesystem seam when the extension config is absent", async () => {
    readFileMock.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));
    await expect(loadSettings()).resolves.toEqual(DEFAULT_SETTINGS);
    expect(readFileMock).toHaveBeenCalledWith("/home/gabriel/.pi/agent/extensions/herdr-tools/config.json", "utf8");
  });

  it("loads only the documented extension-owned shape without coercion", async () => {
    const fake = fsWith(JSON.stringify({ wait: { reviewCadenceMinutes: 10, reviewerModel: "luna" } }));
    await expect(loadSettings({ readFile: fake.readFile })).resolves.toEqual({
      reviewCadenceMinutes: 10,
      reviewerModel: "luna",
      reviewerThinking: "low"
    });
  });

  it.each([
    "{",
    JSON.stringify({ wait: { reviewCadenceMinutes: 0, reviewerModel: "luna" } }),
    JSON.stringify({ wait: { reviewCadenceMinutes: 31, reviewerModel: "luna" } }),
    JSON.stringify({ wait: { reviewCadenceMinutes: 5.5, reviewerModel: "luna" } }),
    JSON.stringify({ wait: { reviewCadenceMinutes: 5, reviewerModel: "" } }),
    JSON.stringify({ wait: { reviewCadenceMinutes: 5, reviewerModel: "   " } }),
    JSON.stringify({ wait: { reviewCadenceMinutes: 5, reviewerModel: 42 } }),
    JSON.stringify({ wait: { reviewCadenceMinutes: 5, reviewerModel: "luna\nmodel" } }),
    JSON.stringify({ wait: { reviewCadenceMinutes: 5, reviewerModel: "luna" }, extra: true }),
    JSON.stringify({ wait: { reviewCadenceMinutes: 5, reviewerModel: "luna", thinking: "high" } })
  ])("fails closed for malformed or invalid config: %s", async (value) => {
    const fake = fsWith(value);
    await expect(loadSettings({ readFile: fake.readFile })).rejects.toBeInstanceOf(SettingsError);
  });

  it("rejects non-object roots and invalid wait sections", async () => {
    for (const value of ["null", "[]", JSON.stringify({ wait: null })]) {
      await expect(loadSettings({ readFile: fsWith(value).readFile })).rejects.toBeInstanceOf(SettingsError);
    }
  });

  it("rejects filesystem failures other than missing config", async () => {
    const readFile = async () => { throw new Error("permission denied"); };
    await expect(loadSettings({ readFile })).rejects.toMatchObject({ code: "INVALID_SETTINGS", details: { cause: "permission denied" } });
    const stringFailure = async () => { throw "permission denied"; };
    await expect(loadSettings({ readFile: stringFailure })).rejects.toMatchObject({ code: "INVALID_SETTINGS", details: { cause: "permission denied" } });
  });

  it("does not read project or Pi settings and ignores tool override fields", async () => {
    const fake = fsWith(JSON.stringify({ wait: { reviewCadenceMinutes: 7, reviewerModel: "luna" } }));
    await expect(loadSettings({
      readFile: fake.readFile,
      toolInput: { reviewCadenceMinutes: 1, reviewerModel: "other", reviewerThinking: "max" }
    })).resolves.toMatchObject({ reviewCadenceMinutes: 7, reviewerModel: "luna", reviewerThinking: "low" });
    expect(fake.paths).toEqual(["/home/gabriel/.pi/agent/extensions/herdr-tools/config.json"]);
  });

  it("returns a fresh immutable snapshot on each load", async () => {
    let value: SettingsFile = { wait: { reviewCadenceMinutes: 5, reviewerModel: "luna" } };
    const paths: string[] = [];
    const readFile = async (path: string) => {
      paths.push(path);
      return JSON.stringify(value);
    };
    const first = await loadSettings({ readFile });
    value = { wait: { reviewCadenceMinutes: 12, reviewerModel: "luna" } };
    const second = await loadSettings({ readFile });

    expect(first.reviewCadenceMinutes).toBe(5);
    expect(second.reviewCadenceMinutes).toBe(12);
    expect(first).not.toBe(second);
    expect(paths).toHaveLength(2);
  });
});
