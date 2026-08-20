import { spawn, type ChildProcess } from "node:child_process";
import type { ExecResult } from "@earendil-works/pi-coding-agent";

export interface StdinExecOptions {
  signal?: AbortSignal;
  timeout?: number;
  /** Bounded grace period between SIGTERM and SIGKILL for a child that ignores termination. */
  killGraceMs?: number;
}

export type StdinExec = (command: string, args: string[], input: string, options: StdinExecOptions) => Promise<ExecResult>;

const MAX_CAPTURE_BYTES = 256 * 1024;
export const DEFAULT_KILL_GRACE_MS = 5_000;

function appendBounded(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next, "utf8") <= MAX_CAPTURE_BYTES) return next;
  return Buffer.from(next, "utf8").subarray(-MAX_CAPTURE_BYTES).toString("utf8");
}

export function spawnWithStdin(command: string, args: string[], input: string, options: StdinExecOptions = {}): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    let spawned: ChildProcess;
    try {
      spawned = spawn(command, args, {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      reject(error);
      return;
    }
    const child = spawned;

    let stdout = "";
    let stderr = "";
    let killed = false;
    let settled = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const signal = options.signal;
    const onAbort = (): void => terminate();

    const cleanup = (): void => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      timeoutTimer = undefined;
      killTimer = undefined;
      signal?.removeEventListener("abort", onAbort);
    };

    const settle = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      outcome();
    };

    const escalate = (): void => {
      try { child.kill("SIGKILL"); } catch { /* the child is already gone */ }
    };

    function terminate(): void {
      if (settled) return;
      killed = true;
      try { child.kill("SIGTERM"); } catch { /* the child is already gone */ }
      if (killTimer) return;
      const grace = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
      killTimer = setTimeout(escalate, Math.max(0, grace));
    }

    if (signal?.aborted) {
      terminate();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => { stdout = appendBounded(stdout, chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = appendBounded(stderr, chunk); });
    child.stdin?.on("error", (error: Error) => {
      stderr = appendBounded(stderr, Buffer.from(error.message, "utf8"));
      terminate();
    });
    child.on("error", (error: Error) => {
      settle(() => reject(error));
    });
    child.on("close", (code: number | null) => {
      settle(() => resolve({ stdout, stderr, code: code ?? (killed ? 137 : 1), killed }));
    });

    if (options.timeout !== undefined && Number.isFinite(options.timeout) && options.timeout > 0) {
      timeoutTimer = setTimeout(terminate, options.timeout);
    }

    if (!signal?.aborted) {
      child.stdin?.end(input, "utf8");
    }
  });
}
