import { truncateTail } from "@earendil-works/pi-coding-agent";
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";

export type PiExec = (command: string, args: string[], options: ExecOptions) => Promise<ExecResult>;

export type CliFailureCode = "ABORTED" | "CLI_NOT_FOUND" | "BACKEND_UNAVAILABLE" | "CLI_INCOMPATIBLE" | "CLI_PROTOCOL_ERROR" | "CLI_TIMEOUT";

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

function bounded(value: string, limit = MAX_EVIDENCE_BYTES): { value: string; content: string; truncated: boolean } {
  const result = truncateTail(value, { maxBytes: limit, maxLines: 2_000 });
  return { value: result.truncated ? `${result.content}\n[output truncated]` : result.content, content: result.content, truncated: result.truncated };
}

function failureFromExec(result: ExecResult, limit = MAX_EVIDENCE_BYTES): CliProtocolError {
  const stdout = bounded(result.stdout, limit);
  const stderr = bounded(result.stderr, limit);
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

function parseEnvelope(stdout: string, evidenceLimit = MAX_EVIDENCE_BYTES): JsonEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new CliProtocolError("CLI_PROTOCOL_ERROR", "Herdr CLI returned malformed JSON", { stdout: bounded(stdout, evidenceLimit).value });
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
    private readonly evidenceLimit = MAX_EVIDENCE_BYTES
  ) {}

  async runJson(argv: string[], signal: AbortSignal, preserveCompletedMutation = false): Promise<JsonEnvelope> {
    const result = await this.runRaw(argv, signal, preserveCompletedMutation);
    if (result.code !== 0 || result.killed) throw failureFromExec(result, this.evidenceLimit);
    return parseEnvelope(result.stdout, this.evidenceLimit);
  }

  async runTextResult(argv: string[], signal: AbortSignal): Promise<CliTextResult> {
    const result = await this.runRaw(argv, signal);
    if (result.code !== 0 || result.killed) {
      const stdout = bounded(result.stdout, this.evidenceLimit);
      const stderr = bounded(result.stderr, this.evidenceLimit);
      throw new CliProtocolError(result.killed ? "CLI_TIMEOUT" : "CLI_PROTOCOL_ERROR", "Herdr CLI command failed", {
        exitCode: result.code,
        killed: result.killed,
        stdout: stdout.value,
        stderr: stderr.value,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated
      });
    }
    const output = bounded(result.stdout, this.evidenceLimit);
    return { value: output.content, truncated: output.truncated };
  }

  async runText(argv: string[], signal: AbortSignal): Promise<string> {
    const output = await this.runTextResult(argv, signal);
    return output.truncated ? `${output.value}\n[output truncated]` : output.value;
  }

  private async runRaw(argv: string[], signal: AbortSignal, preserveCompletedMutation = false): Promise<ExecResult> {
    if (signal.aborted) throw new CliProtocolError("ABORTED", "Operation aborted");
    try {
      const timeout = argv[0] === "agent" && argv[1] === "start"
        ? Math.max(this.timeout, requestedAgentStartTimeout(argv) + HERDR_AGENT_START_EXEC_MARGIN_MS)
        : this.timeout;
      const result = await this.exec("herdr", argv, { signal, timeout });
      if (signal.aborted && !preserveCompletedMutation) throw new CliProtocolError("ABORTED", "Operation aborted");
      return result;
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        throw new CliProtocolError("ABORTED", "Operation aborted");
      }
      if (error instanceof CliProtocolError) throw error;
      throw new CliProtocolError("CLI_NOT_FOUND", "Herdr CLI could not be executed", { cause: error instanceof Error ? error.message : String(error) });
    }
  }
}
