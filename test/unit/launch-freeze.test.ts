import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
});
