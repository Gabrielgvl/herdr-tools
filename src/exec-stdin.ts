import { spawn } from "node:child_process";
import type { ExecResult } from "@earendil-works/pi-coding-agent";

export interface StdinExecOptions {
  signal?: AbortSignal;
  timeout?: number;
}

export type StdinExec = (command: string, args: string[], input: string, options: StdinExecOptions) => Promise<ExecResult>;

const MAX_CAPTURE_BYTES = 256 * 1024;

function appendBounded(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next, "utf8") <= MAX_CAPTURE_BYTES) return next;
  return Buffer.from(next, "utf8").subarray(-MAX_CAPTURE_BYTES).toString("utf8");
}

export function spawnWithStdin(command: string, args: string[], input: string, options: StdinExecOptions = {}): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = "";
    let stderr = "";
    let killed = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (result: ExecResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    const terminate = (): void => {
      if (settled) return;
      killed = true;
      child.kill();
    };

    const signal = options.signal;
    const onAbort = (): void => terminate();
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
      if (!settled) reject(error);
    });
    child.on("close", (code: number | null) => {
      signal?.removeEventListener("abort", onAbort);
      finish({ stdout, stderr, code: code ?? (killed ? 137 : 1), killed });
    });

    if (options.timeout !== undefined && Number.isFinite(options.timeout) && options.timeout > 0) {
      timer = setTimeout(terminate, options.timeout);
    }

    if (!signal?.aborted) {
      child.stdin?.end(input, "utf8");
    }
  });
}
