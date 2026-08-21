import { truncateTail } from "@earendil-works/pi-coding-agent";
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import { spawnWithStdin, type StdinExec, type StdinExecResult } from "./exec-stdin.js";

export type PiExec = (command: string, args: string[], options: ExecOptions) => Promise<ExecResult>;

export type CliFailureCode = "ABORTED" | "CLI_NOT_FOUND" | "BACKEND_UNAVAILABLE" | "CLI_INCOMPATIBLE" | "CLI_PROTOCOL_ERROR" | "CLI_TIMEOUT" | "CLI_OUTPUT_OVERFLOW";

export class CliProtocolError extends Error {
  readonly code: CliFailureCode;
  readonly details: Record<string, unknown>;

  constructor(code: CliFailureCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CliProtocolError";
    this.code = code;
    this.details = details;
  }
}

export interface JsonEnvelope {
  id: string;
  result: unknown;
}

export interface CliTextResult {
  value: string;
  truncated: boolean;
}

const MAX_EVIDENCE_BYTES = 50_000;
export const HERDR_AGENT_START_TIMEOUT_MS = 120_000;
export const HERDR_AGENT_START_EXEC_MARGIN_MS = 5_000;

/** The one evidence bound every host applies to captured CLI output. */
export function boundedEvidence(value: string, limit = MAX_EVIDENCE_BYTES): { value: string; content: string; truncated: boolean } {
  const result = truncateTail(value, { maxBytes: limit, maxLines: 2_000 });
  return { value: result.truncated ? `${result.content}\n[output truncated]` : result.content, content: result.content, truncated: result.truncated };
}

/** Classify a rejected `--stdin` invocation from process text that is never exposed. */
function stdinRejected(result: ExecResult): boolean {
  const evidence = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return evidence.includes("--stdin") && /(unknown|unrecognized|unexpected|invalid|unsupported|option|argument|usage)/u.test(evidence);
}

/**
 * Stdin deliveries carry sender-authored message bodies, which a failing CLI may echo in
 * part. Their evidence is therefore fixed and non-textual: presence, exact byte size, and
 * truncation only.
 */
function nonTextualEvidence(value: string, limit: number, field: "stdout" | "stderr"): Record<string, unknown> {
  const size = Buffer.byteLength(value, "utf8");
  return {
    [`${field}Present`]: size > 0,
    [`${field}Bytes`]: size,
    [`${field}Truncated`]: size > limit
  };
}

function failureFromExec(result: ExecResult, limit = MAX_EVIDENCE_BYTES, input?: string): CliProtocolError {
  if (input !== undefined) {
    const code: CliFailureCode = result.killed ? "CLI_TIMEOUT" : stdinRejected(result) ? "CLI_INCOMPATIBLE" : "CLI_PROTOCOL_ERROR";
    return new CliProtocolError(code, code === "CLI_INCOMPATIBLE" ? "Herdr CLI does not support stdin prompt delivery" : "Herdr CLI did not return a usable response", {
      exitCode: result.code,
      killed: result.killed,
      evidence: "omitted_for_stdin_delivery",
      ...nonTextualEvidence(result.stdout, limit, "stdout"),
      ...nonTextualEvidence(result.stderr, limit, "stderr")
    });
  }
  const stdout = boundedEvidence(result.stdout, limit);
  const stderr = boundedEvidence(result.stderr, limit);
  const code: CliFailureCode = result.killed ? "CLI_TIMEOUT" : "CLI_PROTOCOL_ERROR";
  return new CliProtocolError(code, "Herdr CLI did not return a usable response", {
    exitCode: result.code,
    killed: result.killed,
    stdout: stdout.value,
    stderr: stderr.value,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated
  });
}

function parseEnvelope(stdout: string, evidenceLimit = MAX_EVIDENCE_BYTES, input?: string): JsonEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new CliProtocolError("CLI_PROTOCOL_ERROR", "Herdr CLI returned malformed JSON", input !== undefined
      ? { evidence: "omitted_for_stdin_delivery", ...nonTextualEvidence(stdout, evidenceLimit, "stdout") }
      : { stdout: boundedEvidence(stdout, evidenceLimit).value });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliProtocolError("CLI_PROTOCOL_ERROR", "Herdr CLI returned a non-object envelope");
  }
  const keys = Object.keys(parsed);
  if (keys.length !== 2 || !keys.includes("id") || !keys.includes("result")) {
    throw new CliProtocolError("CLI_PROTOCOL_ERROR", "Herdr CLI returned an incompatible envelope");
  }
  const candidate = parsed as { id?: unknown; result?: unknown };
  if (typeof candidate.id !== "string" || candidate.id.length === 0) {
    throw new CliProtocolError("CLI_PROTOCOL_ERROR", "Herdr CLI envelope is missing required fields");
  }
  return { id: candidate.id, result: candidate.result };
}

function normalizeCompletedStdinResult(result: ExecResult, preserveCompletedMutation: boolean): ExecResult {
  if (!preserveCompletedMutation || result.code !== 0 || !result.killed) return result;
  const evidence = result as StdinExecResult;
  // A code-0 close with no signal and an unsuccessful kill call proves that abort
  // landed after the child had completed but before Node emitted `close`. Do not
  // discard its acknowledgement because a stale killed flag would force a retry.
  if (evidence.signalCode === null && evidence.killDelivered === false) return { ...result, killed: false };
  return result;
}

function requestedAgentStartTimeout(argv: string[]): number {
  const timeoutIndex = argv.indexOf("--timeout");
  if (timeoutIndex >= 0) {
    const value = Number(argv[timeoutIndex + 1]);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return HERDR_AGENT_START_TIMEOUT_MS;
}

export class HerdrCli {
  constructor(
    private readonly exec: PiExec,
    private readonly timeout = 10_000,
    private readonly evidenceLimit = MAX_EVIDENCE_BYTES,
    private readonly stdinExec: StdinExec = spawnWithStdin
  ) {}

  async runJson(argv: string[], signal: AbortSignal, preserveCompletedMutation = false): Promise<JsonEnvelope> {
    return this.runJsonInternal(argv, signal, preserveCompletedMutation);
  }

  async runJsonWithStdin(argv: string[], input: string, signal: AbortSignal, preserveCompletedMutation = true): Promise<JsonEnvelope> {
    // stdin is reserved for prompt mutations. A valid response remains usable
    // when the caller aborts after the child has completed, so callers do not
    // lose the only acknowledgement or retry an already-submitted body.
    return this.runJsonInternal(argv, signal, preserveCompletedMutation, input);
  }

  private async runJsonInternal(argv: string[], signal: AbortSignal, preserveCompletedMutation = false, input?: string): Promise<JsonEnvelope> {
    const result = await this.runRaw(argv, signal, preserveCompletedMutation, input);
    if (result.code !== 0 || result.killed) throw failureFromExec(result, this.evidenceLimit, input);
    return parseEnvelope(result.stdout, this.evidenceLimit, input);
  }

  async runTextResult(argv: string[], signal: AbortSignal): Promise<CliTextResult> {
    const result = await this.runRaw(argv, signal);
    if (result.code !== 0 || result.killed) {
      const stdout = boundedEvidence(result.stdout, this.evidenceLimit);
      const stderr = boundedEvidence(result.stderr, this.evidenceLimit);
      throw new CliProtocolError(result.killed ? "CLI_TIMEOUT" : "CLI_PROTOCOL_ERROR", "Herdr CLI command failed", {
        exitCode: result.code,
        killed: result.killed,
        stdout: stdout.value,
        stderr: stderr.value,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated
      });
    }
    const output = boundedEvidence(result.stdout, this.evidenceLimit);
    return { value: output.content, truncated: output.truncated };
  }

  async runText(argv: string[], signal: AbortSignal): Promise<string> {
    const output = await this.runTextResult(argv, signal);
    return output.truncated ? `${output.value}\n[output truncated]` : output.value;
  }

  private async runRaw(argv: string[], signal: AbortSignal, preserveCompletedMutation = false, input?: string): Promise<ExecResult> {
    if (signal.aborted) throw new CliProtocolError("ABORTED", "Operation aborted");
    try {
      const timeout = argv[0] === "agent" && argv[1] === "start"
        ? Math.max(this.timeout, requestedAgentStartTimeout(argv) + HERDR_AGENT_START_EXEC_MARGIN_MS)
        : this.timeout;
      const result = input === undefined
        ? await this.exec("herdr", argv, { signal, timeout })
        : await this.stdinExec("herdr", argv, input, { signal, timeout });
      const normalized = input === undefined ? result : normalizeCompletedStdinResult(result, preserveCompletedMutation);
      if (signal.aborted && !preserveCompletedMutation) throw new CliProtocolError("ABORTED", "Operation aborted");
      return normalized;
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        throw new CliProtocolError("ABORTED", "Operation aborted");
      }
      if (error instanceof CliProtocolError) throw error;
      throw new CliProtocolError("CLI_NOT_FOUND", "Herdr CLI could not be executed", { cause: error instanceof Error ? error.message : String(error) });
    }
  }
}
