import { truncateTail } from "@earendil-works/pi-coding-agent";
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import { createAgentPromptClient, type AgentPromptClient } from "./agent-prompt.js";

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

export interface HerdrErrorEnvelope {
  id: string;
  error: {
    code: string;
    message: string;
  };
}

export interface CliTextResult {
  value: string;
  truncated: boolean;
}

const MAX_EVIDENCE_BYTES = 50_000;
export const MAX_SCHEMA_BYTES = 524_288;
const MAX_ERROR_FIELD_BYTES = 4_096;
export const HERDR_AGENT_START_TIMEOUT_MS = 120_000;
export const HERDR_AGENT_START_EXEC_MARGIN_MS = 5_000;
/** Native agent.wait must not be capped by the host's ordinary short-command timeout. */
export const HERDR_AGENT_WAIT_EXEC_MARGIN_MS = 1_000;

/** The one evidence bound every host applies to captured CLI output. */
export function boundedEvidence(value: string, limit = MAX_EVIDENCE_BYTES): { value: string; content: string; truncated: boolean } {
  const result = truncateTail(value, { maxBytes: limit, maxLines: 2_000 });
  return { value: result.truncated ? `${result.content}\n[output truncated]` : result.content, content: result.content, truncated: result.truncated };
}

function boundedErrorField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_ERROR_FIELD_BYTES
    ? value
    : undefined;
}

/** Parse a complete Herdr error response and retain only bounded primitive diagnostics. */
function parseErrorEnvelope(value: string): HerdrErrorEnvelope | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return undefined; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const candidate = parsed as { id?: unknown; error?: unknown };
  if (typeof candidate.error !== "object" || candidate.error === null || Array.isArray(candidate.error)) return undefined;
  const error = candidate.error as { code?: unknown; message?: unknown };
  const id = boundedErrorField(candidate.id);
  const code = boundedErrorField(error.code);
  const message = boundedErrorField(error.message);
  return id && code && message ? { id, error: { code, message } } : undefined;
}

function failureFromExec(result: ExecResult, limit = MAX_EVIDENCE_BYTES): CliProtocolError {
  const stdout = boundedEvidence(result.stdout, limit);
  const stderr = boundedEvidence(result.stderr, limit);
  const stderrEnvelope = !result.killed && !stderr.truncated ? parseErrorEnvelope(result.stderr) : undefined;
  const stdoutEnvelope = !result.killed && !stdout.truncated ? parseErrorEnvelope(result.stdout) : undefined;
  const selected = stderrEnvelope
    ? { stream: "stderr" as const, envelope: stderrEnvelope }
    : stdoutEnvelope ? { stream: "stdout" as const, envelope: stdoutEnvelope } : undefined;
  const code: CliFailureCode = result.killed ? "CLI_TIMEOUT" : "CLI_PROTOCOL_ERROR";
  return new CliProtocolError(code, selected?.envelope.error.message ?? "Herdr CLI did not return a usable response", {
    exitCode: result.code,
    killed: result.killed,
    ...(selected
      ? {
          stdoutPresent: result.stdout.length > 0,
          stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
          stderrPresent: result.stderr.length > 0,
          stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          errorStream: selected.stream,
          errorEnvelope: selected.envelope
        }
      : {
          stdout: stdout.value,
          stderr: stderr.value,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated
        })
  });
}

function parseEnvelope(stdout: string, evidenceLimit = MAX_EVIDENCE_BYTES): JsonEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new CliProtocolError("CLI_PROTOCOL_ERROR", "Herdr CLI returned malformed JSON", { stdout: boundedEvidence(stdout, evidenceLimit).value });
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

function requestedTimeout(argv: string[], fallback: number): number {
  const timeoutIndex = argv.indexOf("--timeout");
  if (timeoutIndex >= 0) {
    const value = Number(argv[timeoutIndex + 1]);
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return fallback;
}

function requestedAgentStartTimeout(argv: string[]): number {
  return requestedTimeout(argv, HERDR_AGENT_START_TIMEOUT_MS);
}

function requestedAgentWaitTimeout(argv: string[], fallback: number): number {
  return requestedTimeout(argv, fallback);
}

export class HerdrCli {
  /** Current Herdr exposes occupant-pinned `agent wait` for state predicates. */
  readonly supportsNativeAgentWait = true;

  private readonly agentPrompts: AgentPromptClient;

  constructor(
    private readonly exec: PiExec,
    private readonly timeout = 10_000,
    private readonly evidenceLimit = MAX_EVIDENCE_BYTES,
    agentPrompts: AgentPromptClient = createAgentPromptClient()
  ) { this.agentPrompts = agentPrompts; }

  async runJson(argv: string[], signal: AbortSignal, preserveCompletedMutation = false): Promise<JsonEnvelope> {
    return this.runJsonInternal(argv, signal, preserveCompletedMutation);
  }

  async prompt(target: string, text: string, signal: AbortSignal): Promise<JsonEnvelope> {
    return this.agentPrompts.prompt(target, text, signal);
  }

  async pingPromptEndpoint(signal: AbortSignal): Promise<void> {
    await this.agentPrompts.ping(signal);
  }

  closePromptTransport(): void {
    this.agentPrompts.close?.();
  }

  async readApiSchema(signal: AbortSignal): Promise<string> {
    const result = await this.runRaw(["api", "schema", "--json"], signal);
    if (result.code !== 0 || result.killed) throw failureFromExec(result, MAX_SCHEMA_BYTES);
    if (Buffer.byteLength(result.stdout, "utf8") > MAX_SCHEMA_BYTES) {
      throw new CliProtocolError("CLI_OUTPUT_OVERFLOW", "Herdr API schema exceeds the accepted bound", { limitBytes: MAX_SCHEMA_BYTES });
    }
    return result.stdout;
  }

  private async runJsonInternal(argv: string[], signal: AbortSignal, preserveCompletedMutation = false): Promise<JsonEnvelope> {
    const result = await this.runRaw(argv, signal, preserveCompletedMutation);
    if (result.code !== 0 || result.killed) throw failureFromExec(result, this.evidenceLimit);
    return parseEnvelope(result.stdout, this.evidenceLimit);
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

  private async runRaw(argv: string[], signal: AbortSignal, preserveCompletedMutation = false): Promise<ExecResult> {
    if (signal.aborted) throw new CliProtocolError("ABORTED", "Operation aborted");
    try {
      const timeout = argv[0] === "agent" && argv[1] === "start"
        ? Math.max(this.timeout, requestedAgentStartTimeout(argv) + HERDR_AGENT_START_EXEC_MARGIN_MS)
        : argv[0] === "agent" && argv[1] === "wait"
          ? requestedAgentWaitTimeout(argv, this.timeout) + HERDR_AGENT_WAIT_EXEC_MARGIN_MS
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
