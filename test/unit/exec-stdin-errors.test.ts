import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { spawnWithStdin } from "../../src/exec-stdin.js";

type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: EventEmitter; kill: ReturnType<typeof vi.fn> };

function child(): FakeChild {
  const value = new EventEmitter() as FakeChild;
  value.stdout = new EventEmitter();
  value.stderr = new EventEmitter();
  value.stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
  value.kill = vi.fn();
  return value;
}

describe("stdin executor edge events", () => {
  it("propagates synchronous spawn errors", async () => {
    spawnMock.mockImplementationOnce(() => { throw new Error("spawn failed"); });
    await expect(spawnWithStdin("herdr", [], "body")).rejects.toThrow("spawn failed");
  });

  it("bounds stream evidence, handles stdin errors, and ignores duplicate terminal events", async () => {
    const process = child();
    spawnMock.mockReturnValueOnce(process);
    const pending = spawnWithStdin("herdr", [], "body");
    process.stdout.emit("data", Buffer.from("stdout"));
    process.stderr.emit("data", Buffer.from("stderr"));
    process.stdin.emit("error", new Error("pipe closed"));
    process.emit("close", null);
    process.emit("error", new Error("late error"));
    process.emit("close", 0);
    await expect(pending).resolves.toMatchObject({ stdout: "stdout", stderr: "stderrpipe closed", code: 137, killed: true });
    expect(process.kill).toHaveBeenCalled();
  });
});
