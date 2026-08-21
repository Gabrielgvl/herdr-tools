import { spawn, type ChildProcess } from "node:child_process";
import type { ExecResult } from "@earendil-works/pi-coding-agent";

export interface StdinExecOptions {
  signal?: AbortSignal;
  timeout?: number;
  /** Bounded grace period between SIGTERM and SIGKILL for a child that ignores termination. */
  killGraceMs?: number;
}

export interface StdinExecResult extends ExecResult {
  /** Internal race evidence used by the CLI adapter; not part of model-visible errors. */
  signalCode?: NodeJS.Signals | null;
  killDelivered?: boolean;
}

export type StdinExec = (command: string, args: string[], input: string, options: StdinExecOptions) => Promise<StdinExecResult>;

const MAX_CAPTURE_BYTES = 256 * 1024;
export const DEFAULT_KILL_GRACE_MS = 5_000;

function appendBounded(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next, "utf8") <= MAX_CAPTURE_BYTES) return next;
  return Buffer.from(next, "utf8").subarray(-MAX_CAPTURE_BYTES).toString("utf8");
}

/**
 * Run a child with one stdin payload. `exit` is tracked separately from `close`:
 * Node can deliver an abort between those events, and a successful numeric exit
 * code must win over a kill request made after the process was already complete.
 */
export function spawnWithStdin(command: string, args: string[], input: string, options: StdinExecOptions = {}): Promise<StdinExecResult> {
  return new Promise<StdinExecResult>((resolve, reject) => {
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
    let settled = false;
    let exitCode: number | null | undefined;
    let signalCode: NodeJS.Signals | null | undefined;
    let killRequested = false;
    let killDelivered = false;
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
      try {
        if (child.kill("SIGKILL")) killDelivered = true;
      } catch {
        // The child may have exited between the grace timer and SIGKILL.
      }
    };

    function terminate(): void {
      if (settled || exitCode !== undefined || signalCode !== undefined) return;
      killRequested = true;
      try {
        if (child.kill("SIGTERM")) killDelivered = true;
      } catch {
        // The child may have exited before the kill call; close/exit evidence wins.
      }
      if (killTimer) return;
      const grace = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
      killTimer = setTimeout(escalate, Math.max(0, grace));
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
    child.on("exit", (code: number | null, signalName: NodeJS.Signals | null) => {
      exitCode = code;
      signalCode = signalName;
    });
    child.on("close", (code: number | null, signalName: NodeJS.Signals | null) => {
      // Prefer exit's authoritative values, but retain close's values for a
      // defensive fallback if an unusual child implementation omits `exit`.
      const actualCode = exitCode !== undefined ? exitCode : code;
      const actualSignal = signalCode !== undefined ? signalCode : signalName ?? null;
      // A code-0 exit proves successful completion, even if abort was delivered
      // in the exit-to-close window. Any non-zero/no-code completion after an
      // abort remains cancellation evidence; a naturally incomplete close with
      // no abort/kill evidence is only a generic failure.
      const killed = actualCode === 0
        ? false
        : killRequested || actualSignal !== null || killDelivered;
      settle(() => resolve({ stdout, stderr, code: actualCode ?? (killed ? 137 : 1), killed, signalCode: actualSignal, killDelivered }));
    });

    if (signal?.aborted) {
      terminate();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }

    if (options.timeout !== undefined && Number.isFinite(options.timeout) && options.timeout > 0) {
      timeoutTimer = setTimeout(terminate, options.timeout);
    }

    if (!signal?.aborted) {
      child.stdin?.end(input, "utf8");
    }
  });
}
