/**
 * The shared trace-file trust chain (ADR-040 amendment node C): directory
 * chain, leaf, O_NOFOLLOW open and descriptor identity, with the forbidden
 * write bits chosen by the caller.
 */
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openTrustedTraceFile, TRACE_FILE_FORBID_GROUP_WORLD_WRITE, TraceFileError } from "../../src/supervision/trace-file.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "herdr-trace-file-"));
  await chmod(dir, 0o700);
  dirs.push(dir);
  return dir;
}

async function refusal(promise: Promise<unknown>): Promise<{ failure: string; reason: string }> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(TraceFileError);
    const typed = error as TraceFileError;
    expect(typed.message).not.toContain("/");
    return { failure: typed.failure, reason: typed.reason };
  }
  throw new Error("expected a refusal");
}

describe("openTrustedTraceFile", () => {
  it("opens a regular owner-only leaf under proven directories and reports its fstat", async () => {
    const dir = await root();
    const nested = join(dir, "a", "b");
    await mkdir(nested, { recursive: true, mode: 0o700 });
    const path = join(nested, "trace.jsonl");
    await writeFile(path, "{}\n", { mode: 0o600 });
    const { handle, stat } = await openTrustedTraceFile(path, { directories: [dir, join(dir, "a"), nested] });
    try {
      expect(stat.size).toBe(3);
      expect(stat.isFile()).toBe(true);
    } finally {
      await handle.close();
    }
  });

  it("refuses a missing leaf, a symlink, a directory, a world-writable file, and an unreadable path", async () => {
    const dir = await root();
    expect(await refusal(openTrustedTraceFile(join(dir, "missing")))).toEqual({ failure: "missing", reason: "leaf_stat" });
    await symlink(join(dir, "elsewhere"), join(dir, "link"));
    expect(await refusal(openTrustedTraceFile(join(dir, "link")))).toEqual({ failure: "untrusted", reason: "leaf" });
    await mkdir(join(dir, "dir"), { mode: 0o700 });
    expect(await refusal(openTrustedTraceFile(join(dir, "dir")))).toEqual({ failure: "untrusted", reason: "leaf" });
    await writeFile(join(dir, "open"), "x", { mode: 0o600 });
    await chmod(join(dir, "open"), 0o606);
    expect(await refusal(openTrustedTraceFile(join(dir, "open")))).toEqual({ failure: "untrusted", reason: "leaf" });
    await writeFile(join(dir, "file"), "x", { mode: 0o600 });
    expect(await refusal(openTrustedTraceFile(join(dir, "file", "below")))).toEqual({ failure: "unreadable", reason: "leaf_stat" });
    await writeFile(join(dir, "locked"), "x", { mode: 0o600 });
    await chmod(join(dir, "locked"), 0o000);
    if (process.getuid?.() !== 0) expect(await refusal(openTrustedTraceFile(join(dir, "locked")))).toEqual({ failure: "unreadable", reason: "open" });
  });

  it("proves every named directory before the leaf", async () => {
    const dir = await root();
    const path = join(dir, "trace.jsonl");
    await writeFile(path, "x", { mode: 0o600 });
    expect(await refusal(openTrustedTraceFile(path, { directories: [join(dir, "absent")] }))).toEqual({ failure: "missing", reason: "directory_stat" });
    expect(await refusal(openTrustedTraceFile(path, { directories: [path] }))).toEqual({ failure: "untrusted", reason: "directory" });
    await mkdir(join(dir, "loose"), { mode: 0o700 });
    await chmod(join(dir, "loose"), 0o707);
    expect(await refusal(openTrustedTraceFile(path, { directories: [join(dir, "loose")] }))).toEqual({ failure: "untrusted", reason: "directory" });
    await symlink(dir, join(dir, "dirlink"));
    expect(await refusal(openTrustedTraceFile(path, { directories: [join(dir, "dirlink")] }))).toEqual({ failure: "untrusted", reason: "directory" });
    await writeFile(join(dir, "file"), "x", { mode: 0o600 });
    expect(await refusal(openTrustedTraceFile(path, { directories: [join(dir, "file", "below")] }))).toEqual({ failure: "unreadable", reason: "directory_stat" });
  });

  it("forbids group-writable nodes only when the caller asks for the quota scanner's stricter bits", async () => {
    const dir = await root();
    const path = join(dir, "trace.jsonl");
    await writeFile(path, "x", { mode: 0o600 });
    await chmod(path, 0o664);
    const { handle } = await openTrustedTraceFile(path);
    await handle.close();
    expect(await refusal(openTrustedTraceFile(path, { forbidModeBits: TRACE_FILE_FORBID_GROUP_WORLD_WRITE }))).toEqual({ failure: "untrusted", reason: "leaf" });
    await chmod(path, 0o600);
    await mkdir(join(dir, "group"), { mode: 0o700 });
    await chmod(join(dir, "group"), 0o770);
    const { handle: again } = await openTrustedTraceFile(path, { directories: [join(dir, "group")] });
    await again.close();
    expect(await refusal(openTrustedTraceFile(path, { directories: [join(dir, "group")], forbidModeBits: TRACE_FILE_FORBID_GROUP_WORLD_WRITE }))).toEqual({ failure: "untrusted", reason: "directory" });
  });
});
