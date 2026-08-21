import { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { spawnWithStdin } from "../../src/exec-stdin.js";

describe("stdin prompt executor", () => {
  it("uses an argv array, writes the input, closes stdin, and bounds output", async () => {
    const result = await spawnWithStdin(process.execPath, ["-e", "process.stdin.setEncoding('utf8'); process.stdin.on('data', d => process.stdout.write(d));"], "hello", {});
    expect(result).toMatchObject({ code: 0, killed: false, stdout: "hello" });

    const large = await spawnWithStdin(process.execPath, ["-e", "process.stdout.write('x'.repeat(300000));"], "ignored", {});
    expect(large.stdout.length).toBeLessThanOrEqual(256 * 1024);
  });

  it("does not mark a successful exit killed when abort races the close event", async () => {
    const controller = new AbortController();
    const abortParent = (): void => controller.abort();
    process.once("SIGUSR2", abortParent);
    try {
      const script = "process.on('SIGTERM', () => {}); process.stdout.write('ack'); process.kill(process.ppid, 'SIGUSR2'); setTimeout(() => process.exit(0), 25);";
      await expect(spawnWithStdin(process.execPath, ["-e", script], "", { signal: controller.signal, killGraceMs: 500 })).resolves.toMatchObject({ code: 0, killed: false, stdout: "ack" });
    } finally {
      process.removeListener("SIGUSR2", abortParent);
    }
  }, 15_000);

  it("reports timeout, abort, already-aborted, and spawn failures", async () => {
    const timedOut = await spawnWithStdin(process.execPath, ["-e", "setTimeout(() => {}, 1000);"], "input", { timeout: 10 });
    expect(timedOut.killed).toBe(true);

    const controller = new AbortController();
    const aborted = spawnWithStdin(process.execPath, ["-e", "setTimeout(() => {}, 1000);"], "input", { signal: controller.signal });
    controller.abort();
    await expect(aborted).resolves.toMatchObject({ killed: true });

    const already = new AbortController();
    already.abort();
    await expect(spawnWithStdin(process.execPath, ["-e", "setTimeout(() => {}, 1000);"], "input", { signal: already.signal })).resolves.toMatchObject({ killed: true });

    await expect(spawnWithStdin("/definitely/missing/herdr", [], "input", {})).rejects.toBeInstanceOf(Error);
  });

  it("records a false SIGKILL delivery result when the child exits during escalation", async () => {
    const originalKill = ChildProcess.prototype.kill;
    const kill = vi.spyOn(ChildProcess.prototype, "kill").mockImplementation(function (this: ChildProcess, signal?: NodeJS.Signals | number) {
      const delivered = originalKill.call(this, signal);
      return signal === "SIGTERM" || signal === "SIGKILL" ? false : delivered;
    });
    try {
      const ignoresTerm = "process.on('SIGTERM', () => {}); process.stdin.resume(); setInterval(() => {}, 1000);";
      const result = await spawnWithStdin(process.execPath, ["-e", ignoresTerm], "input", { timeout: 25, killGraceMs: 50 });
      expect(result).toMatchObject({ killed: true, killDelivered: false, code: 137 });
    } finally {
      kill.mockRestore();
    }
  }, 15_000);

  it("kills a real child that ignores SIGTERM", async () => {
    const ignoresTerm = "process.on('SIGTERM', () => {}); process.stdin.resume(); setInterval(() => {}, 1000);";
    const result = await spawnWithStdin(process.execPath, ["-e", ignoresTerm], "input", { timeout: 25, killGraceMs: 50 });
    expect(result.killed).toBe(true);
    expect(result.code).toBe(137);
  }, 15_000);
});
