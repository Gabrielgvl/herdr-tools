import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export const HERDR_LAUNCH_FREEZE_PATH = "/home/gabriel/.pi/agent/herdr-launch-freeze";
export const HERDR_LAUNCH_GATE_PATH = "/home/gabriel/.pi/agent/herdr-launch-gate.lock";
const LOCK_READY = "HERDR_LAUNCH_GATE_READY";
const LOCK_COMMAND = `printf '${LOCK_READY}\\n'; cat`;
const DEFAULT_LOCK_DEADLINE_MS = 1_000;
const FREEZE_CONTENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\n[1-9][0-9]{0,9}\n$/u;

export class LaunchFreezeError extends Error {
  readonly code = "PROFILE_LAUNCH_FROZEN";

  constructor(message = "Profile launches are frozen") {
    super(message);
    this.name = "LaunchFreezeError";
  }
}

export interface LaunchGateLease {
  check(): Promise<void>;
  release(): Promise<void>;
}

export interface LaunchGateOptions {
  freezePath?: string;
  lockPath?: string;
  deadlineMs?: number;
}

function uid(): number {
  const value = process.getuid?.();
  if (value === undefined) throw new LaunchFreezeError("Launch gate owner is unavailable");
  return value;
}

function assertOwnerOnlyDirectory(path: string, value: Awaited<ReturnType<typeof lstat>>): void {
  const mode = Number(value.mode);
  if (!value.isDirectory() || value.isSymbolicLink() || value.uid !== uid() || (mode & 0o22) !== 0) {
    throw new LaunchFreezeError(`Launch gate directory is not trusted: ${path}`);
  }
}

async function assertLockPath(lockPath: string): Promise<void> {
  let parent;
  try {
    parent = await lstat(dirname(lockPath));
  } catch {
    throw new LaunchFreezeError("Launch gate directory is unavailable");
  }
  assertOwnerOnlyDirectory(dirname(lockPath), parent);

  try {
    const value = await lstat(lockPath);
    const mode = Number(value.mode);
    if (!value.isFile() || value.isSymbolicLink() || value.uid !== uid() || (mode & 0o22) !== 0) {
      throw new LaunchFreezeError("Launch gate lock is not trusted");
    }
  } catch (error) {
    if (error instanceof LaunchFreezeError) throw error;
    if (!isNodeError(error, "ENOENT")) throw new LaunchFreezeError("Launch gate lock is indeterminate");
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

export async function assertLaunchNotFrozen(freezePath = HERDR_LAUNCH_FREEZE_PATH): Promise<void> {
  let value;
  try {
    value = await lstat(freezePath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw new LaunchFreezeError("Launch freeze state is unreadable");
  }
  if (!value.isFile() || value.isSymbolicLink() || value.uid !== uid() || (Number(value.mode) & 0o7777) !== 0o600) {
    throw new LaunchFreezeError("Launch freeze state is invalid");
  }
  let content: string;
  try {
    content = await readFile(freezePath, "utf8");
  } catch {
    throw new LaunchFreezeError("Launch freeze state is unreadable");
  }
  if (Buffer.byteLength(content, "utf8") > 512 || !FREEZE_CONTENT.test(content)) {
    throw new LaunchFreezeError("Launch freeze state is malformed");
  }
  throw new LaunchFreezeError();
}

interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function exitResult(child: ChildProcessWithoutNullStreams): Promise<ExitResult> {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function assertHolderAlive(child: ChildProcessWithoutNullStreams, holderExited: boolean): void {
  if (holderExited || child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
    throw new LaunchFreezeError("Launch gate holder is not live");
  }
  try {
    process.kill(child.pid, 0);
  } catch {
    throw new LaunchFreezeError("Launch gate holder is not live");
  }
}

async function stop(child: ChildProcessWithoutNullStreams, exit: Promise<ExitResult>): Promise<void> {
  child.kill("SIGKILL");
  await Promise.race([
    exit,
    new Promise<void>((resolve) => setTimeout(resolve, 100)),
  ]);
}

async function ensureLockPath(lockPath: string): Promise<void> {
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);
  try {
    const handle = await open(lockPath, flags, 0o600);
    await handle.close();
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw new LaunchFreezeError("Launch gate lock is unavailable");
  }
  await assertLockPath(lockPath);
}

export async function acquireLaunchGate(options: LaunchGateOptions = {}): Promise<LaunchGateLease> {
  const freezePath = options.freezePath ?? HERDR_LAUNCH_FREEZE_PATH;
  const lockPath = options.lockPath ?? HERDR_LAUNCH_GATE_PATH;
  const deadlineMs = options.deadlineMs ?? DEFAULT_LOCK_DEADLINE_MS;
  try {
    await ensureLockPath(lockPath);
  } catch (error) {
    throw error instanceof LaunchFreezeError ? error : new LaunchFreezeError("Launch gate lock is unavailable");
  }

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn("flock", ["--shared", "--nonblock", lockPath, "--command", LOCK_COMMAND], {
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    throw new LaunchFreezeError("Launch gate lock could not be started");
  }
  const exit = exitResult(child);
  let holderExited = false;
  void exit.then(() => { holderExited = true; });
  const acquisition = new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new LaunchFreezeError("Launch gate lock was unavailable")), deadlineMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.includes(`${LOCK_READY}\n`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(new LaunchFreezeError("Launch gate lock is indeterminate"));
    });
    child.once("exit", (code) => {
      if (!output.includes(`${LOCK_READY}\n`)) {
        clearTimeout(timer);
        reject(code === 1 ? new LaunchFreezeError("Launch gate lock was unavailable") : new LaunchFreezeError("Launch gate lock is indeterminate"));
      }
    });
  });

  try {
    await acquisition;
    assertHolderAlive(child, holderExited);
    await assertLockPath(lockPath);
  } catch (error) {
    await stop(child, exit);
    throw error instanceof LaunchFreezeError ? error : new LaunchFreezeError("Launch gate lock is indeterminate");
  }

  let released = false;
  return {
    async check(): Promise<void> {
      assertHolderAlive(child, holderExited);
      await assertLockPath(lockPath);
      await assertLaunchNotFrozen(freezePath);
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      await assertLockPath(lockPath);
      child.stdin.end();
      const result = await exit;
      if (result.code !== 0 || result.signal !== null) throw new LaunchFreezeError("Launch gate release is indeterminate");
      await assertLockPath(lockPath);
    },
  };
}
