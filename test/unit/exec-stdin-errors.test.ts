import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { DEFAULT_KILL_GRACE_MS, spawnWithStdin } from "../../src/exec-stdin.js";

type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: EventEmitter; kill: ReturnType<typeof vi.fn> };

function child(kill: FakeChild["kill"] = vi.fn()): FakeChild {
  const value = new EventEmitter() as FakeChild;
  value.stdout = new EventEmitter();
  value.stderr = new EventEmitter();
  value.stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
  value.kill = kill;
  return value;
}

const settled = (promise: Promise<unknown>) => promise.then(() => "resolved", () => "rejected");

describe("stdin executor edge events", () => {
  it("propagates synchronous spawn errors", async () => {
    spawnMock.mockImplementationOnce(() => { throw new Error("spawn failed"); });
    await expect(spawnWithStdin("herdr", [], "body")).rejects.toThrow("spawn failed");
  });

  it("bounds stream evidence, handles stdin errors, and ignores duplicate terminal events", async () => {
    const process = child();
    spawnMock.mockReturnValueOnce(process);
    const pending = spawnWithStdin("herdr", [], "body", { killGraceMs: 5 });
    process.stdout.emit("data", Buffer.from("stdout"));
    process.stderr.emit("data", Buffer.from("stderr"));
    process.stdin.emit("error", new Error("pipe closed"));
    process.emit("close", null);
    process.emit("error", new Error("late error"));
    process.stdin.emit("error", new Error("late pipe error"));
    process.emit("close", 0);
    await expect(pending).resolves.toMatchObject({ stdout: "stdout", stderr: "stderrpipe closed", code: 137, killed: true });
    expect(process.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("reports a non-killed close without an exit code as a generic failure", async () => {
    const process = child();
    spawnMock.mockReturnValueOnce(process);
    const pending = spawnWithStdin("herdr", [], "body");
    process.emit("close", null);
    await expect(pending).resolves.toMatchObject({ code: 1, killed: false });
  });

  it("escalates one SIGTERM to SIGKILL after the bounded grace period", async () => {
    const kill = vi.fn();
    const process = child(kill);
    spawnMock.mockReturnValueOnce(process);
    const controller = new AbortController();
    const pending = spawnWithStdin("herdr", [], "body", { signal: controller.signal, timeout: 5, killGraceMs: 10 });
    controller.abort();
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(kill.mock.calls.map((call) => call[0])).toEqual(["SIGTERM", "SIGTERM", "SIGKILL"]);
    process.emit("close", null);
    await expect(pending).resolves.toMatchObject({ killed: true, code: 137 });
  });

  it("survives a child that cannot be signalled", async () => {
    const kill = vi.fn((signal?: string) => { throw Object.assign(new Error(`no such process for ${signal}`), { code: "ESRCH" }); });
    const process = child(kill);
    spawnMock.mockReturnValueOnce(process);
    const pending = spawnWithStdin("herdr", [], "body", { timeout: 1, killGraceMs: 0 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(kill.mock.calls.map((call) => call[0])).toEqual(["SIGTERM", "SIGKILL"]);
    process.emit("close", 143);
    await expect(pending).resolves.toMatchObject({ code: 143, killed: true });
  });

  it("clears the escalation timer once the child exits", async () => {
    const kill = vi.fn();
    const process = child(kill);
    spawnMock.mockReturnValueOnce(process);
    const pending = spawnWithStdin("herdr", [], "body", { timeout: 1, killGraceMs: 15 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.emit("close", null);
    expect(await settled(pending)).toBe("resolved");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(kill.mock.calls.map((call) => call[0])).toEqual(["SIGTERM"]);
  });

  it("rejects a spawn error event and ignores a later close", async () => {
    const process = child();
    spawnMock.mockReturnValueOnce(process);
    const pending = spawnWithStdin("herdr", [], "body");
    process.emit("error", new Error("ENOENT"));
    process.emit("close", 0);
    await expect(pending).rejects.toThrow("ENOENT");
  });

  it("uses a five-second default escalation grace", () => {
    expect(DEFAULT_KILL_GRACE_MS).toBe(5_000);
  });
});
