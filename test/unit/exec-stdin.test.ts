import { describe, expect, it } from "vitest";
import { spawnWithStdin } from "../../src/exec-stdin.js";

describe("stdin prompt executor", () => {
  it("uses an argv array, writes the input, closes stdin, and bounds output", async () => {
    const result = await spawnWithStdin(process.execPath, ["-e", "process.stdin.setEncoding('utf8'); process.stdin.on('data', d => process.stdout.write(d));"], "hello", {});
    expect(result).toMatchObject({ code: 0, killed: false, stdout: "hello" });

    const large = await spawnWithStdin(process.execPath, ["-e", "process.stdout.write('x'.repeat(300000));"], "ignored", {});
    expect(large.stdout.length).toBeLessThanOrEqual(256 * 1024);
  });

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
});
