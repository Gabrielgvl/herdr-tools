import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { stopDisposableServer } from "../integration/disposable-session.js";

describe("disposable integration server cleanup", () => {
  it("waits for the named server child to close before returning", async () => {
    const child = new EventEmitter() as EventEmitter & { exitCode: number | null; kill: ChildProcess["kill"] };
    child.exitCode = null;
    child.kill = vi.fn(() => true);
    let settled = false;
    const stopping = stopDisposableServer(child as ChildProcess).then(() => { settled = true; });

    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(settled).toBe(false);

    child.exitCode = 0;
    child.emit("close", 0, "SIGTERM");
    await stopping;
    expect(settled).toBe(true);
  });

  it("does not signal an already exited server", async () => {
    const child = new EventEmitter() as EventEmitter & { exitCode: number | null; kill: ChildProcess["kill"] };
    child.exitCode = 0;
    child.kill = vi.fn(() => true);

    await stopDisposableServer(child as ChildProcess);

    expect(child.kill).not.toHaveBeenCalled();
  });
});
