import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { acquireLaunchGate, assertLaunchNotFrozen } from "../../src/tools/launch-freeze.js";

async function paths(): Promise<{ root: string; freeze: string; lock: string }> {
  const root = await mkdtemp(join(tmpdir(), "herdr-launch-gate-"));
  return { root, freeze: join(root, "freeze"), lock: join(root, "gate.lock") };
}

describe("profile launch freeze gate", () => {
  it("fails closed for a valid, malformed, and symlinked switch", async () => {
    const fixture = await paths();
    try {
      await expect(assertLaunchNotFrozen(fixture.freeze)).resolves.toBeUndefined();
      await writeFile(fixture.freeze, "transaction-1\n1234\n", { mode: 0o600 });
      await expect(assertLaunchNotFrozen(fixture.freeze)).rejects.toMatchObject({ code: "PROFILE_LAUNCH_FROZEN" });
      await writeFile(fixture.freeze, "not a transaction\n", { mode: 0o600 });
      await expect(assertLaunchNotFrozen(fixture.freeze)).rejects.toMatchObject({ code: "PROFILE_LAUNCH_FROZEN" });
      await rm(fixture.freeze);
      await symlink(join(fixture.root, "target"), fixture.freeze);
      await expect(assertLaunchNotFrozen(fixture.freeze)).rejects.toMatchObject({ code: "PROFILE_LAUNCH_FROZEN" });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("holds a shared lock and refuses an exclusive coordinator", async () => {
    const fixture = await paths();
    const first = await acquireLaunchGate({ freezePath: fixture.freeze, lockPath: fixture.lock });
    await first.release();
    const holder = spawn("flock", ["--exclusive", "--nonblock", fixture.lock, "--command", "printf HERDR_EXCLUSIVE_READY; cat"], { stdio: ["pipe", "pipe", "pipe"] });
    try {
      const ready = new Promise<void>((resolve, reject) => {
        holder.stdout.setEncoding("utf8");
        holder.stdout.on("data", (chunk: string) => { if (chunk.includes("HERDR_EXCLUSIVE_READY")) resolve(); });
        holder.once("error", reject);
      });
      await ready;
      await expect(first.check()).rejects.toMatchObject({ code: "PROFILE_LAUNCH_FROZEN" });
      await expect(acquireLaunchGate({ freezePath: fixture.freeze, lockPath: fixture.lock, deadlineMs: 50 })).rejects.toMatchObject({ code: "PROFILE_LAUNCH_FROZEN" });
    } finally {
      holder.stdin.end();
      await once(holder, "exit");
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("can hold the same gate exclusively", async () => {
    const fixture = await paths();
    const gate = await acquireLaunchGate({ freezePath: fixture.freeze, lockPath: fixture.lock, exclusive: true });
    try {
      await expect(acquireLaunchGate({ freezePath: fixture.freeze, lockPath: fixture.lock, deadlineMs: 50 })).rejects.toMatchObject({ code: "PROFILE_LAUNCH_FROZEN" });
    } finally {
      await gate.release();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rechecks the switch while the shared lock is held", async () => {
    const fixture = await paths();
    const gate = await acquireLaunchGate({ freezePath: fixture.freeze, lockPath: fixture.lock });
    try {
      await writeFile(fixture.freeze, "transaction-2\n5678\n", { mode: 0o600 });
      await chmod(fixture.freeze, 0o600);
      await expect(gate.check()).rejects.toMatchObject({ code: "PROFILE_LAUNCH_FROZEN" });
    } finally {
      await gate.release();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("refuses an untrusted lock directory, a symlinked lock, and an unwritable directory", async () => {
    const fixture = await paths();
    try {
      // A group/world-writable lock directory is not owner-only.
      await chmod(fixture.root, 0o777);
      await expect(acquireLaunchGate({ freezePath: fixture.freeze, lockPath: fixture.lock })).rejects.toMatchObject({ code: "PROFILE_LAUNCH_FROZEN" });
      await chmod(fixture.root, 0o700);
      await rm(fixture.lock, { force: true });
      // A lock that is not a plain owned file (here a symlink) is untrusted.
      await symlink(join(fixture.root, "real-lock"), fixture.lock);
      await expect(acquireLaunchGate({ freezePath: fixture.freeze, lockPath: fixture.lock })).rejects.toMatchObject({ code: "PROFILE_LAUNCH_FROZEN" });
      await rm(fixture.lock, { force: true });
      // A directory the holder cannot write to cannot create the lock.
      await chmod(fixture.root, 0o500);
      await expect(acquireLaunchGate({ freezePath: fixture.freeze, lockPath: fixture.lock })).rejects.toMatchObject({ code: "PROFILE_LAUNCH_FROZEN" });
      await chmod(fixture.root, 0o700);
    } finally {
      await chmod(fixture.root, 0o700).catch(() => undefined);
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rechecks a lock path that went missing or became unstatable mid-lease", async () => {
    const fixture = await paths();
    const gate = await acquireLaunchGate({ freezePath: fixture.freeze, lockPath: fixture.lock });
    try {
      // A deleted lock file is tolerated: an absent lock is a fresh lease.
      await rm(fixture.lock);
      await gate.check();
      // A lock whose directory lost search permission cannot be classified.
      await chmod(fixture.root, 0o600);
      await expect(gate.check()).rejects.toMatchObject({ code: "PROFILE_LAUNCH_FROZEN" });
      await chmod(fixture.root, 0o700);
      await gate.release();
    } finally {
      await chmod(fixture.root, 0o700).catch(() => undefined);
      await rm(fixture.root, { recursive: true, force: true });
    }

    // A lock directory deleted outright makes the path unavailable.
    const nested = await paths();
    const sub = join(nested.root, "sub");
    await mkdir(sub, { mode: 0o700 });
    const orphan = await acquireLaunchGate({ freezePath: nested.freeze, lockPath: join(sub, "gate.lock") });
    try {
      await rm(sub, { recursive: true });
      await expect(orphan.check()).rejects.toMatchObject({ code: "PROFILE_LAUNCH_FROZEN" });
      await mkdir(sub, { mode: 0o700 });
      await orphan.release();
    } finally {
      await rm(nested.root, { recursive: true, force: true });
    }
  });

  it("fails closed when the freeze state cannot be inspected", async () => {
    const fixture = await paths();
    const state = join(fixture.root, "state");
    await mkdir(state);
    const gate = await acquireLaunchGate({ freezePath: join(state, "freeze"), lockPath: fixture.lock });
    try {
      await chmod(state, 0o600);
      await expect(gate.check()).rejects.toMatchObject({ code: "PROFILE_LAUNCH_FROZEN" });
    } finally {
      await chmod(state, 0o700).catch(() => undefined);
      await gate.release();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails closed when the lock helper is missing, malformed, or dies abnormally", async () => {
    const fixture = await paths();
    const stubDir = await mkdtemp(join(tmpdir(), "herdr-flock-stub-"));
    const stub = (body: string) => writeFile(join(stubDir, "flock"), `#!/bin/sh\n${body}`, { mode: 0o755 });
    const originalPath = process.env.PATH;
    try {
      // No flock on PATH at all is an indeterminate acquisition, not a timeout.
      process.env.PATH = stubDir;
      await expect(acquireLaunchGate({ freezePath: fixture.freeze, lockPath: fixture.lock })).rejects.toMatchObject({ code: "PROFILE_LAUNCH_FROZEN" });
      // A helper that exits with a code other than flock's contention code 1.
      await stub("exit 2\n");
      await expect(acquireLaunchGate({ freezePath: fixture.freeze, lockPath: fixture.lock })).rejects.toMatchObject({ code: "PROFILE_LAUNCH_FROZEN" });
      // A helper that writes something else and then hangs misses the READY marker.
      await stub("printf 'NOPE\\n'\n/bin/sleep 30\n");
      await expect(acquireLaunchGate({ freezePath: fixture.freeze, lockPath: fixture.lock, deadlineMs: 50 })).rejects.toMatchObject({ code: "PROFILE_LAUNCH_FROZEN" });
      // A helper that dies with a nonzero code when its stdin closes makes the
      // release indeterminate instead of reporting a clean unlock.
      await stub("printf 'HERDR_LAUNCH_GATE_READY\\n'\n/bin/cat\nexit 7\n");
      const gate = await acquireLaunchGate({ freezePath: fixture.freeze, lockPath: fixture.lock });
      await expect(gate.release()).rejects.toMatchObject({ code: "PROFILE_LAUNCH_FROZEN" });
    } finally {
      process.env.PATH = originalPath;
      await rm(stubDir, { recursive: true, force: true });
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("ignores a second release of the same lease", async () => {
    const fixture = await paths();
    const gate = await acquireLaunchGate({ freezePath: fixture.freeze, lockPath: fixture.lock });
    try {
      await gate.release();
      await gate.release();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
