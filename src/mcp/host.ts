import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ExecOptions, ExecResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { boundedEvidence, CliProtocolError, type PiExec } from "../cli.js";
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

export type StartupRefusalReason = "HERDR_ENV" | "INJECTED_CONTEXT" | "PROJECT_DIR";

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
  /** Launch-directory source; defaults to `process.cwd`. Injectable so tests stay hermetic. */
  cwd?: () => string;
}

export interface StartupContext {
  readonly context: CurrentContext;
  readonly environment: EnvironmentState;
  readonly projectDir: string;
}

/** The canonical project-root shape: absolute, nonempty, single-line. Shared by startup anchoring and delegated caller roots. */
export function safeDirectory(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  if (value.includes(String.fromCharCode(0)) || value.includes("\r") || value.includes("\n")) return undefined;
  return isAbsolute(value) ? value : undefined;
}

/**
 * Fail-closed startup gating, in order: Herdr environment, injected Herdr
 * identity, then the session's project directory. Messages never echo
 * environment values.
 *
 * The project directory is host-agnostic: an explicit `HERDR_PROJECT_DIR`
 * wins, and when it is unset the server's own launch directory anchors the
 * session, which is the directory every observed MCP host (Claude Code,
 * Devin, pi-mcp-adapter) already spawns stdio servers from. An explicit value
 * that fails validation refuses startup rather than silently re-anchoring to
 * the launch directory, and a launch directory of a filesystem root is not a
 * project anchor.
 *
 * The validated candidate is resolved to its canonical filesystem path before
 * it is accepted, and the canonical result must pass the same non-root
 * single-line shape check, so a symlink to the root or to a path that could
 * never be echoed safely is refused rather than served. Only the canonical
 * directory anchors the session and is returned.
 */
export async function resolveStartup(deps: StartupDependencies = {}): Promise<StartupContext> {
  const env = deps.env ?? process.env;
  const stat = deps.stat ?? ((path: string) => fs.stat(path));
  if (env.HERDR_ENV !== "1") {
    throw new StartupRefusal("HERDR_ENV", "HERDR_ENV must be 1; the Herdr tools MCP server refuses to serve outside a Herdr runtime");
  }
  const injected = readInjectedContext(env);
  // `HERDR_EXECUTOR_DELEGATED=1` (the executor-gateway serve) relaxes only the
  // injected-ids gate: the gateway spawns one server per connection with
  // static env, so the calling pane's identity arrives per call as the
  // `caller` argument instead. Every other gate is unchanged, and a call that
  // carries no caller arg is still refused at connect time when no usable
  // injected identity exists.
  if ((!injected.idsPresent || !injected.idsValid) && env.HERDR_EXECUTOR_DELEGATED !== "1") {
    throw new StartupRefusal("INJECTED_CONTEXT", "injected Herdr workspace, tab, and pane identifiers are missing or malformed");
  }
  let candidate = env.HERDR_PROJECT_DIR;
  if (candidate === undefined) {
    try {
      candidate = (deps.cwd ?? (() => process.cwd()))();
    } catch {
      candidate = undefined;
    }
  }
  const validated = candidate !== undefined && dirname(candidate) !== candidate ? safeDirectory(candidate) : undefined;
  if (validated === undefined) {
    throw new StartupRefusal("PROJECT_DIR", "HERDR_PROJECT_DIR or the server launch directory must be an absolute single-line path to an existing directory below the filesystem root");
  }
  let projectDir: string;
  let directory: DirectoryStat;
  try {
    const resolved = await fs.realpath(validated);
    const canonical = dirname(resolved) !== resolved ? safeDirectory(resolved) : undefined;
    if (canonical === undefined) {
      throw new StartupRefusal("PROJECT_DIR", "HERDR_PROJECT_DIR or the server launch directory must be an absolute single-line path to an existing directory below the filesystem root");
    }
    projectDir = canonical;
    directory = await stat(projectDir);
  } catch {
    throw new StartupRefusal("PROJECT_DIR", "HERDR_PROJECT_DIR or the server launch directory must be an absolute single-line path to an existing directory below the filesystem root");
  }
  if (!directory.isDirectory()) {
    throw new StartupRefusal("PROJECT_DIR", "HERDR_PROJECT_DIR or the server launch directory must be an absolute single-line path to an existing directory below the filesystem root");
  }
  return {
    context: injected.context,
    environment: { enabled: true, currentIdsPresent: injected.idsPresent, currentIdsValid: injected.idsValid },
    projectDir
  };
}

/** Delay between the `SIGTERM` a timeout or abort sends and the `SIGKILL` escalation. */
export const EXEC_FORCE_KILL_MS = 5_000;
/**
 * Post-`exit` grace window before the call settles. This is a deliberate
 * tradeoff, not a magic delay:
 *
 * - `close` cannot be relied on, because a detached Herdr descendant can inherit
 *   the stdout handle and hold the pipe open indefinitely, so waiting for `close`
 *   would hang every launch.
 * - Settling on `exit` alone would drop output still queued in the pipe.
 *
 * Each post-`exit` chunk re-arms the window, so a well-behaved child that emits
 * `close` settles immediately and pays nothing, a child whose pipe stays open
 * pays exactly one grace period, and output that arrives more than one grace
 * period after the last chunk is lost rather than held forever. 100ms is
 * negligible against the 10s CLI timeout and ample for the kernel to drain an
 * already-written pipe buffer.
 */
export const EXEC_IDLE_GRACE_MS = 100;
/**
 * Hard ceiling on the decoded bytes this host collects from one child stream.
 *
 * `HerdrCli` bounds evidence only after a call settles, so the ceiling has to be
 * enforced while the pipes are still streaming: without it a runaway `herdr`
 * response would be accumulated in full inside the MCP server first. The
 * configured timeout bounds duration, not volume.
 *
 * 1 MiB is twenty times the 50 KiB evidence bound `HerdrCli` keeps, so every
 * legitimate snapshot, pane read, or protocol envelope fits well below it. A
 * stream that crosses the ceiling is a failure, not a truncation: silently
 * cutting a JSON envelope would turn overflow into a parse error or, worse, into
 * a plausible-looking success.
 */
export const EXEC_MAX_OUTPUT_BYTES = 1_048_576;

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

/** Decode one stream chunk without ever splitting a multi-byte code point. */
function decodeChunk(decoder: StringDecoder, chunk: unknown): string {
  if (ArrayBuffer.isView(chunk)) return decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  return decoder.write(Buffer.from(String(chunk), "utf8"));
}

/** One child stream, decoded as UTF-8 and measured against the host ceiling. */
interface Collected {
  readonly stream: "stdout" | "stderr";
  readonly decoder: StringDecoder;
  text: string;
  bytes: number;
}

function collector(stream: "stdout" | "stderr"): Collected {
  return { stream, decoder: new StringDecoder("utf8"), text: "", bytes: 0 };
}

/**
 * The MCP host's process-execution capability, matching the Pi host contract:
 * no shell, bounded by the caller's timeout and signal, and the host owns the
 * working directory exactly as the Pi runtime does, so a caller's `cwd` option
 * is not consulted.
 *
 * A process that ran settles; a process that could never be spawned rejects with
 * its own error, so `HerdrCli` maps a missing `herdr` binary to `CLI_NOT_FOUND`
 * with the spawn failure as evidence, exactly as it does on the Pi host.
 * Resolving such a failure as an ordinary non-zero exit would discard the
 * evidence and report `CLI_PROTOCOL_ERROR` instead.
 *
 * Both pipes are decoded through a streaming UTF-8 decoder, so a code point
 * split across two chunks cannot corrupt evidence, and each pipe is measured
 * against `EXEC_MAX_OUTPUT_BYTES` while it streams: crossing the ceiling kills
 * the child and rejects with `CLI_OUTPUT_OVERFLOW` instead of accumulating an
 * unbounded string. Nothing is collected after the call settles.
 */
export function createNodeExec(options: NodeExecOptions): PiExec {
  const spawnProcess = options.spawn ?? (spawn as unknown as SpawnLike);
  return (command: string, args: string[], execOptions: ExecOptions) => new Promise<ExecResult>((resolve, reject) => {
    const child = spawnProcess(command, args, { cwd: options.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const out = collector("stdout");
    const err = collector("stderr");
    let killed = false;
    let settled = false;
    let exited = false;
    /** Any chunk or an `exit` event proves the child actually started. */
    let observed = false;
    let exitCode: number | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    const kill = (): void => {
      if (killed) return;
      killed = true;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), EXEC_FORCE_KILL_MS);
    };
    const release = (keepEscalation = false): void => {
      settled = true;
      for (const timer of keepEscalation ? [idleTimer, timeoutTimer] : [idleTimer, forceTimer, timeoutTimer]) {
        if (timer) clearTimeout(timer);
      }
      execOptions.signal?.removeEventListener("abort", kill);
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const settle = (code: number | null): void => {
      if (settled) return;
      release();
      resolve({ stdout: out.text + out.decoder.end(), stderr: err.text + err.decoder.end(), code: code ?? 0, killed });
    };
    const armIdle = (code: number | null): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => settle(code), EXEC_IDLE_GRACE_MS);
    };
    /**
     * Overflow is a rejected call, not a truncated success. The child is torn
     * down with the same `SIGTERM` then `SIGKILL` escalation a timeout uses — the
     * escalation timer deliberately survives `release` here, because the process
     * is still producing output — and `HerdrCli` re-throws this typed failure
     * unchanged, so the model sees `CLI_OUTPUT_OVERFLOW` with bounded evidence.
     */
    const overflow = (target: Collected): void => {
      release(true);
      kill();
      reject(new CliProtocolError("CLI_OUTPUT_OVERFLOW", "Herdr CLI produced more output than the MCP host collects", {
        stream: target.stream,
        limitBytes: EXEC_MAX_OUTPUT_BYTES,
        killed: true,
        stdout: boundedEvidence(out.text).value,
        stderr: boundedEvidence(err.text).value
      }));
    };
    /** Collect one chunk under the ceiling; nothing is collected after settling. */
    const collect = (target: Collected, chunk: unknown): void => {
      if (settled) return;
      observed = true;
      const decoded = decodeChunk(target.decoder, chunk);
      target.text += decoded;
      target.bytes += Buffer.byteLength(decoded, "utf8");
      if (target.bytes > EXEC_MAX_OUTPUT_BYTES) {
        overflow(target);
        return;
      }
      if (exited) armIdle(exitCode);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      // A child that already produced output or exited ran; only a process that
      // never started is a spawn failure.
      if (observed) {
        settle(exitCode ?? 1);
        return;
      }
      release();
      reject(error);
    };

    child.stdout?.on("data", (chunk) => collect(out, chunk));
    child.stderr?.on("data", (chunk) => collect(err, chunk));
    child.once("exit", (code) => {
      exited = true;
      observed = true;
      exitCode = code;
      armIdle(code);
    });
    child.once("close", (code) => settle(code));
    child.once("error", (error) => fail(error));

    if (execOptions.signal) {
      if (execOptions.signal.aborted) kill();
      else execOptions.signal.addEventListener("abort", kill, { once: true });
    }
    if (execOptions.timeout !== undefined && execOptions.timeout > 0) {
      timeoutTimer = setTimeout(kill, execOptions.timeout);
    }
  });
}
