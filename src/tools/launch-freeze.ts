import { lstat, readFile } from "node:fs/promises";
import { acquireFlockHolder } from "../pane-write-lock.js";

export const HERDR_LAUNCH_FREEZE_PATH = "/home/gabriel/.pi/agent/herdr-launch-freeze";
export const HERDR_LAUNCH_GATE_PATH = "/home/gabriel/.pi/agent/herdr-launch-gate.lock";
const LOCK_READY = "HERDR_LAUNCH_GATE_READY";
const DEFAULT_LOCK_DEADLINE_MS = 1_000;
const FREEZE_CONTENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\n[1-9][0-9]{0,9}\n$/u;

export class LaunchFreezeError extends Error {
  readonly code = "PROFILE_LAUNCH_FROZEN";

  constructor(message = "Profile launches are frozen") {
    super(message);
    this.name = "LaunchFreezeError";
  }
}

const launchGateFailure = (message: string): LaunchFreezeError => new LaunchFreezeError(message);

export interface LaunchGateLease {
  check(): Promise<void>;
  release(): Promise<void>;
}

export interface LaunchGateOptions {
  freezePath?: string;
  lockPath?: string;
  deadlineMs?: number;
  exclusive?: boolean;
  nonblock?: boolean;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function uid(): number {
  const value = process.getuid?.();
  /* c8 ignore next -- flock only exists on platforms that provide getuid. */
  if (value === undefined) throw new LaunchFreezeError("Launch gate owner is unavailable");
  return value;
}

export async function assertLaunchNotFrozen(freezePath = HERDR_LAUNCH_FREEZE_PATH, read: (path: string) => Promise<string> = (path) => readFile(path, "utf8")): Promise<void> {
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
    content = await read(freezePath);
  } catch {
    throw new LaunchFreezeError("Launch freeze state is unreadable");
  }
  if (Buffer.byteLength(content, "utf8") > 512 || !FREEZE_CONTENT.test(content)) {
    throw new LaunchFreezeError("Launch freeze state is malformed");
  }
  throw new LaunchFreezeError();
}

/**
 * The launch gate is a *shared* native flock by default: concurrent launchers
 * all hold it while the freeze file remains the authorization decision — the
 * lock exists to keep the check/settle section ordered, not to exclude peers.
 * The holder itself lives in `pane-write-lock.ts`, which also powers the Devin
 * composer write lock; this wrapper only adds the freeze-file policy.
 */
export async function acquireLaunchGate(options: LaunchGateOptions = {}): Promise<LaunchGateLease> {
  const freezePath = options.freezePath ?? HERDR_LAUNCH_FREEZE_PATH;
  const holder = await acquireFlockHolder({
    lockPath: options.lockPath ?? HERDR_LAUNCH_GATE_PATH,
    mode: options.exclusive === true ? "exclusive" : "shared",
    wait: options.nonblock === false ? "wait" : "nonblock",
    deadlineMs: options.deadlineMs ?? DEFAULT_LOCK_DEADLINE_MS,
    readyMarker: LOCK_READY,
    subject: "Launch gate",
    failure: launchGateFailure,
  });
  return {
    async check(): Promise<void> {
      await holder.check();
      await assertLaunchNotFrozen(freezePath);
    },
    release: () => holder.release(),
  };
}
