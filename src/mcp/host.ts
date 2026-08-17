import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { isAbsolute } from "node:path";
import type { ExecOptions, ExecResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiExec } from "../cli.js";
import type { CurrentContext } from "../targets.js";
import { readInjectedContext, type EnvironmentState } from "../tool-surface.js";

/** The only host fields the shared tools may read. */
export const HOST_FIELDS = ["cwd", "signal"] as const;

export interface HerdrToolHost {
  readonly cwd: string;
  readonly signal: AbortSignal;
}

export class HostCapabilityError extends Error {
  readonly code = "HOST_CAPABILITY_UNAVAILABLE" as const;

  constructor(message: string) {
    super(message);
    this.name = "HostCapabilityError";
  }
}

/**
 * The single Pi-type seam. Every field outside `HOST_FIELDS` fails loudly, so an
 * upstream tool that starts reading a Pi-only capability cannot silently observe
 * `undefined` on this host.
 */
export function hostContext(host: HerdrToolHost): ExtensionContext {
  const allowed = new Set<string>(HOST_FIELDS);
  return new Proxy(host, {
    get(target, key) {
      if (typeof key === "symbol") return undefined;
      if (!allowed.has(key)) throw new HostCapabilityError(`MCP host does not provide ${key}`);
      return target[key as keyof HerdrToolHost];
    }
  }) as unknown as ExtensionContext;
}

export type StartupRefusalReason = "HERDR_ENV" | "INJECTED_CONTEXT" | "CLAUDE_PROJECT_DIR";

export class StartupRefusal extends Error {
  readonly code = "STARTUP_REFUSED" as const;

  constructor(readonly reason: StartupRefusalReason, message: string) {
    super(message);
    this.name = "StartupRefusal";
  }
}

export interface DirectoryStat {
  isDirectory(): boolean;
}

export interface StartupDependencies {
  env?: NodeJS.ProcessEnv;
  stat?: (path: string) => Promise<DirectoryStat>;
}

export interface StartupContext {
  readonly context: CurrentContext;
  readonly environment: EnvironmentState;
  readonly projectDir: string;
}

function safeDirectory(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  if (value.includes(String.fromCharCode(0)) || value.includes("\r") || value.includes("\n")) return undefined;
  return isAbsolute(value) ? value : undefined;
}

/**
 * Fail-closed startup gating, in order: Herdr environment, injected Herdr
 * identity, then the manager session's project directory. Messages never echo
 * environment values.
 */
export async function resolveStartup(deps: StartupDependencies = {}): Promise<StartupContext> {
  const env = deps.env ?? process.env;
  const stat = deps.stat ?? ((path: string) => fs.stat(path));
  if (env.HERDR_ENV !== "1") {
    throw new StartupRefusal("HERDR_ENV", "HERDR_ENV must be 1; the Herdr tools MCP server refuses to serve outside a Herdr runtime");
  }
  const injected = readInjectedContext(env);
  if (!injected.idsPresent || !injected.idsValid) {
    throw new StartupRefusal("INJECTED_CONTEXT", "injected Herdr workspace, tab, and pane identifiers are missing or malformed");
  }
  const projectDir = safeDirectory(env.CLAUDE_PROJECT_DIR);
  if (projectDir === undefined) {
    throw new StartupRefusal("CLAUDE_PROJECT_DIR", "CLAUDE_PROJECT_DIR must be an absolute single-line path to an existing directory");
  }
  let directory: DirectoryStat;
  try {
    directory = await stat(projectDir);
  } catch {
    throw new StartupRefusal("CLAUDE_PROJECT_DIR", "CLAUDE_PROJECT_DIR must be an absolute single-line path to an existing directory");
  }
  if (!directory.isDirectory()) {
    throw new StartupRefusal("CLAUDE_PROJECT_DIR", "CLAUDE_PROJECT_DIR must be an absolute single-line path to an existing directory");
  }
  return {
    context: injected.context,
    environment: { enabled: true, currentIdsPresent: injected.idsPresent, currentIdsValid: injected.idsValid },
    projectDir
  };
}

const EXEC_FORCE_KILL_MS = 5_000;
const EXEC_IDLE_GRACE_MS = 100;

interface ChildStream {
  on(event: "data", listener: (chunk: unknown) => void): unknown;
  destroy(): unknown;
}

export interface ChildProcessLike {
  readonly stdout: ChildStream | null;
  readonly stderr: ChildStream | null;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: (code: number | null) => void): unknown;
  once(event: "close", listener: (code: number | null) => void): unknown;
  kill(signal: "SIGTERM" | "SIGKILL"): unknown;
}

export type SpawnLike = (command: string, args: string[], options: { cwd: string; shell: false; stdio: ["ignore", "pipe", "pipe"] }) => ChildProcessLike;

export interface NodeExecOptions {
  cwd: string;
  spawn?: SpawnLike;
}

/**
 * The MCP host's process-execution capability, matching the Pi host contract:
 * no shell, bounded by the caller's timeout and signal, and never rejecting. The
 * host owns the working directory, exactly as the Pi runtime does, so a caller's
 * `cwd` option is not consulted.
 *
 * Settling waits for the pipes to fall idle after `exit`, because a detached
 * Herdr descendant can keep an inherited stdout handle open past `exit` and
 * `close` may never fire.
 */
export function createNodeExec(options: NodeExecOptions): PiExec {
  const spawnProcess = options.spawn ?? (spawn as unknown as SpawnLike);
  return (command: string, args: string[], execOptions: ExecOptions) => new Promise<ExecResult>((resolve) => {
    const child = spawnProcess(command, args, { cwd: options.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;
    let settled = false;
    let exited = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    const kill = (): void => {
      if (killed) return;
      killed = true;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), EXEC_FORCE_KILL_MS);
    };
    const settle = (code: number | null): void => {
      if (settled) return;
      settled = true;
      for (const timer of [idleTimer, forceTimer, timeoutTimer]) {
        if (timer) clearTimeout(timer);
      }
      execOptions.signal?.removeEventListener("abort", kill);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ stdout, stderr, code: code ?? 0, killed });
    };
    const armIdle = (code: number | null): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => settle(code), EXEC_IDLE_GRACE_MS);
    };

    let exitCode: number | null = null;
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      if (exited) armIdle(exitCode);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
      if (exited) armIdle(exitCode);
    });
    child.once("exit", (code) => {
      exited = true;
      exitCode = code;
      armIdle(code);
    });
    child.once("close", (code) => settle(code));
    child.once("error", () => settle(1));

    if (execOptions.signal) {
      if (execOptions.signal.aborted) kill();
      else execOptions.signal.addEventListener("abort", kill, { once: true });
    }
    if (execOptions.timeout !== undefined && execOptions.timeout > 0) {
      timeoutTimer = setTimeout(kill, execOptions.timeout);
    }
  });
}
