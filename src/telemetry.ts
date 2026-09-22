import { constants } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { lstat, mkdir, open } from "node:fs/promises";
import type { TSchema } from "typebox";
import { Settings } from "typebox/system";
import { Value } from "typebox/value";
import { acquireFlockHolder, assertOwnerOnlyDirectory } from "./pane-write-lock.js";
import { modelSafeJson } from "./redaction.js";

export const TOOL_DIAGNOSTIC_MARKER = "HERDR_TOOL_DIAGNOSTIC";
export const TOOL_DIAGNOSTIC_MAX_BYTES = 8_192;
export const TOOL_DIAGNOSTIC_SUMMARY = "Tool input failed schema validation; inspect the structured diagnostic";
export const TOOL_DIAGNOSTIC_RECOVERY = "Correct the listed arguments to match the tool schema, then retry; no tool effect occurred.";
export const TOOL_TELEMETRY_MAX_BYTES = 1_024;
export const TOOL_TELEMETRY_LOCK_WAIT_MS = 100;
const TOOL_TELEMETRY_READY = "HERDR_TOOL_TELEMETRY_LOCK_READY";
const MAX_DIAGNOSTIC_ERRORS = 8;
const MAX_PATH_BYTES = 256;
const MAX_EXPECTED_BYTES = 160;
// ponytail: finite TypeBox error buffer; inputs with ~256+ simultaneous schema
// violations can still crowd out later errors — raise if that becomes plausible.
const TYPEBOX_ERROR_BUFFER_MAX = 256;
const EFFECT_CERTAINTIES = new Set(["absent", "partial", "unknown", "confirmed"]);
const PHASE_OUTCOMES = new Set(["success", "failure", "skipped"]);
const TOOL_OPERATIONS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  herdr_inspect: new Set(["context", "target", "collection", "health"]),
  herdr_communicate: new Set(["prompt", "steer", "keys", "cancel", "interrupt"]),
  herdr_wait: new Set(["wait"]),
  herdr_jobs: new Set(["list", "get", "cancel"]),
  herdr_launch: new Set(["launch"]),
  herdr_pane: new Set(["split", "move", "rename", "focus", "resize", "swap", "zoom", "adopt", "close"]),
  herdr_tab: new Set(["create", "rename", "focus", "close"]),
});

export type ToolEffectCertainty = "absent" | "partial" | "unknown" | "confirmed";
export type ToolPhaseOutcome = "success" | "failure" | "skipped";

export interface ToolValidationError {
  path: string;
  expected: string;
  received: "missing" | "null" | "array" | "object" | "string" | "number" | "boolean" | "bigint" | "symbol" | "function" | "undefined";
}

export interface ToolValidationDiagnostic {
  tool: string;
  schema: string;
  code: "INVALID_INPUT";
  phase: "validate";
  errors: ToolValidationError[];
  effectCertainty: "absent";
  recoveryGuidance: typeof TOOL_DIAGNOSTIC_RECOVERY;
}

export interface ToolTelemetryEntry {
  tool: string;
  operation: string;
  phases: {
    validate: ToolPhaseOutcome;
    execute: ToolPhaseOutcome;
    persist: "success";
  };
  durationMs: number;
  effectCertainty: ToolEffectCertainty;
}

export interface ToolTelemetryRecord extends ToolTelemetryEntry {
  timestamp: string;
}

export interface AppendToolTelemetryOptions {
  root: string;
  now?: () => Date;
  waitMs?: number;
  deadlineMs?: number;
}

export interface ToolTelemetryPaths {
  directory: string;
  records: string;
  lock: string;
}

export function toolTelemetryPaths(root: string): ToolTelemetryPaths {
  const directory = join(root, ".herdr", "diagnostics");
  return { directory, records: join(directory, "tools.jsonl"), lock: join(directory, "tools.lock") };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: string, maxBytes: number): string {
  let result = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    const safe = code <= 31 || code === 127 ? " " : character;
    if (Buffer.byteLength(`${result}${safe}`, "utf8") > maxBytes) break;
    result += safe;
  }
  return result.trim();
}

/** Build the marker plus JSON trailer used by both launch and schema diagnostics. */
export function boundedDiagnosticMessage(
  summary: string,
  marker: string,
  payload: object,
  maxBytes: number,
  fallback: object,
): string {
  const suffix = `\n${marker} ${JSON.stringify(payload)}`;
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  if (suffixBytes > maxBytes) return `${marker} ${JSON.stringify(fallback)}`;
  return `${boundedText(summary, maxBytes - suffixBytes)}${suffix}`;
}

function paramsOf(error: { params?: unknown }): Record<string, unknown> {
  return error.params as Record<string, unknown>;
}

function propertyPaths(error: { keyword?: unknown; instancePath?: unknown; params?: unknown }): string[] {
  const base = error.instancePath as string;
  const params = paramsOf(error);
  const names = error.keyword === "required"
    ? params.requiredProperties
    : error.keyword === "additionalProperties"
      ? params.additionalProperties
      : undefined;
  if (!Array.isArray(names) || names.length === 0) return [base];
  return names.filter((name): name is string => typeof name === "string").map((name) => `${base}/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`);
}

function expected(error: { keyword?: unknown; params?: unknown }): string {
  const keyword = error.keyword as string;
  const params = paramsOf(error);
  if (keyword === "required") return "required property";
  if (keyword === "additionalProperties") return "property not allowed";
  if (keyword === "type" && typeof params.type === "string") return `type ${boundedText(params.type, 32)}`;
  if (keyword === "const" && ["string", "number", "boolean"].includes(typeof params.allowedValue)) {
    return `literal ${boundedText(JSON.stringify(params.allowedValue), 64)}`;
  }
  if (["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"].includes(keyword) && typeof params.limit === "number") {
    return `${keyword} ${params.limit}`;
  }
  if (["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"].includes(keyword) && typeof params.limit === "number") {
    return `${keyword} ${params.limit}`;
  }
  if (keyword === "pattern") return "string matching schema pattern";
  if (keyword === "anyOf") return "matching schema variant";
  if (keyword === "~refine") return "custom schema constraint";
  return boundedText(`schema constraint ${keyword}`, MAX_EXPECTED_BYTES);
}

function valueAtPath(value: unknown, path: string): { found: boolean; value?: unknown } {
  if (path === "") return { found: true, value };
  let current = value;
  for (const token of path.split("/").slice(1).map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    /* c8 ignore next -- TypeBox paths stop at the field whose container failed. */
    if (!record(current) && !Array.isArray(current)) return { found: false };
    if (!Object.prototype.hasOwnProperty.call(current, token)) return { found: false };
    current = (current as Record<string, unknown>)[token];
  }
  return { found: true, value: current };
}

function receivedType(value: unknown, path: string): ToolValidationError["received"] {
  const found = valueAtPath(value, path);
  if (!found.found) return "missing";
  if (found.value === null) return "null";
  if (Array.isArray(found.value)) return "array";
  return typeof found.value as ToolValidationError["received"];
}

function rawErrors(schema: TSchema, value: unknown): ReturnType<typeof Value.Errors> {
  const maxErrors = Settings.Get().maxErrors;
  Settings.Set({ maxErrors: TYPEBOX_ERROR_BUFFER_MAX });
  try {
    return Value.Errors(schema, value);
  } finally {
    Settings.Set({ maxErrors });
  }
}

function diagnosticErrors(schema: TSchema, value: unknown): ToolValidationError[] {
  const errors: ToolValidationError[] = [];
  const seen = new Set<string>();
  for (const error of rawErrors(schema, value)) {
    // TypeBox 1.3.27+ also reports the `additionalProperties: false` boolean
    // sub-schema per offending property; the keyword error already names them.
    if (error.keyword === "boolean" && error.schemaPath.endsWith("/additionalProperties")) continue;
    for (const rawPath of propertyPaths(error)) {
      const path = boundedText(rawPath || "/", MAX_PATH_BYTES);
      const item = { path, expected: boundedText(expected(error), MAX_EXPECTED_BYTES), received: receivedType(value, rawPath) };
      const key = JSON.stringify(item);
      if (!seen.has(key)) {
        seen.add(key);
        errors.push(item);
      }
      if (errors.length >= MAX_DIAGNOSTIC_ERRORS) return errors;
    }
  }
  return errors;
}

function safeToolName(tool: string): string {
  return /^herdr_[a-z0-9_]{1,64}$/u.test(tool) ? tool : "herdr_tool";
}

export function invalidInputDiagnostic(tool: string, schema: TSchema, value: unknown): ToolValidationDiagnostic | undefined {
  if (Value.Check(schema, value)) return undefined;
  const safeTool = safeToolName(tool);
  return {
    tool: safeTool,
    schema: safeTool,
    code: "INVALID_INPUT",
    phase: "validate",
    errors: diagnosticErrors(schema, value),
    effectCertainty: "absent",
    recoveryGuidance: TOOL_DIAGNOSTIC_RECOVERY,
  };
}

export class ToolInputError extends Error {
  readonly code = "INVALID_INPUT" as const;

  constructor(readonly diagnostic: ToolValidationDiagnostic) {
    const fallback: ToolValidationDiagnostic = { ...diagnostic, errors: [] };
    super(boundedDiagnosticMessage(TOOL_DIAGNOSTIC_SUMMARY, TOOL_DIAGNOSTIC_MARKER, diagnostic, TOOL_DIAGNOSTIC_MAX_BYTES, fallback));
    this.name = "ToolInputError";
  }
}

export function invalidInputError(tool: string, schema: TSchema, value: unknown): ToolInputError | undefined {
  const diagnostic = invalidInputDiagnostic(tool, schema, value);
  return diagnostic === undefined ? undefined : new ToolInputError(diagnostic);
}

export function telemetryOperation(tool: string, value: unknown, valid: boolean): string {
  if (!valid) return "invalid";
  const input = record(value) ? value : {};
  const candidate = tool === "herdr_inspect"
    ? input.mode ?? "context"
    : tool === "herdr_wait"
      ? "wait"
      : tool === "herdr_launch"
        ? "launch"
        : input.operation;
  return typeof candidate === "string" && TOOL_OPERATIONS[tool]?.has(candidate) ? candidate : "unknown";
}

export function monotonicDurationMs(startedAt: number, now = performance.now()): number {
  const elapsed = now - startedAt;
  return Number.isFinite(elapsed) && elapsed > 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(elapsed)) : 0;
}

export function telemetryEffectCertainty(value: unknown, fallback: ToolEffectCertainty): ToolEffectCertainty {
  const details = record(value) && record(value.details) ? value.details : record(value) ? value : undefined;
  const certainty = details?.effectCertainty;
  return typeof certainty === "string" && EFFECT_CERTAINTIES.has(certainty) ? certainty as ToolEffectCertainty : fallback;
}

function buildTelemetryRecord(entry: ToolTelemetryEntry, now: () => Date): ToolTelemetryRecord {
  const operations = TOOL_OPERATIONS[entry.tool];
  if (operations === undefined || (entry.operation !== "invalid" && entry.operation !== "unknown" && !operations.has(entry.operation))) throw new Error("invalid telemetry operation");
  if (!PHASE_OUTCOMES.has(entry.phases.validate) || !PHASE_OUTCOMES.has(entry.phases.execute) || entry.phases.persist !== "success") throw new Error("invalid telemetry phases");
  if (!Number.isSafeInteger(entry.durationMs) || entry.durationMs < 0) throw new Error("invalid telemetry duration");
  if (!EFFECT_CERTAINTIES.has(entry.effectCertainty)) throw new Error("invalid telemetry certainty");
  return {
    timestamp: now().toISOString(),
    tool: entry.tool,
    operation: entry.operation,
    phases: { validate: entry.phases.validate, execute: entry.phases.execute, persist: "success" },
    durationMs: entry.durationMs,
    effectCertainty: entry.effectCertainty,
  };
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return record(error) && error.code === code;
}

function uid(): number {
  const value = process.getuid?.();
  /* c8 ignore next -- flock is available only on platforms that expose getuid. */
  if (value === undefined) throw new Error("owner unavailable");
  return value;
}

async function ensureTelemetryDirectory(directory: string): Promise<void> {
  for (const path of [dirname(directory), directory]) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
    const value = await lstat(path);
    assertOwnerOnlyDirectory(path, value, /* c8 ignore next -- invoked only by the shared trust assertion. */ () => new Error("untrusted telemetry directory"), "Tool telemetry");
  }
}

async function appendTelemetryLine(path: string, line: string): Promise<void> {
  let existing;
  try {
    existing = await lstat(path);
  } catch (error) {
    /* c8 ignore next -- lstat failures other than absence require an injected filesystem fault. */
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  if (existing !== undefined && (!existing.isFile() || existing.isSymbolicLink() || existing.uid !== uid() || (Number(existing.mode) & 0o22) !== 0)) throw new Error("untrusted telemetry file");
  const handle = await open(path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    const opened = await handle.stat();
    /* c8 ignore next -- pre-open lstat plus O_NOFOLLOW owns the ordinary trust paths. */
    if (!opened.isFile() || opened.uid !== uid() || (Number(opened.mode) & 0o22) !== 0) throw new Error("untrusted telemetry file");
    await handle.appendFile(line);
  } finally {
    await handle.close().catch(/* c8 ignore next -- close failure is best-effort cleanup. */ () => undefined);
  }
}

/** Append one allowlisted operation record. Telemetry failures are deliberately silent. */
export async function appendToolTelemetry(entry: ToolTelemetryEntry, options: AppendToolTelemetryOptions): Promise<void> {
  try {
    if (!isAbsolute(options.root)) return;
    const record = buildTelemetryRecord(entry, options.now ?? (() => new Date()));
    const line = `${JSON.stringify(modelSafeJson(record))}\n`;
    /* c8 ignore next -- the fixed allowlisted record is structurally below the bound. */
    if (Buffer.byteLength(line, "utf8") > TOOL_TELEMETRY_MAX_BYTES) return;
    const paths = toolTelemetryPaths(options.root);
    await ensureTelemetryDirectory(paths.directory);
    const holder = await acquireFlockHolder({
      lockPath: paths.lock,
      wait: { timeoutMs: options.waitMs ?? TOOL_TELEMETRY_LOCK_WAIT_MS },
      ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
      readyMarker: TOOL_TELEMETRY_READY,
      subject: "Tool telemetry",
      failure: /* c8 ignore next -- invoked only by the shared flock helper. */ () => new Error("tool telemetry unavailable"),
    });
    try {
      await appendTelemetryLine(paths.records, line);
    } finally {
      await holder.release().catch(/* c8 ignore next -- release failure cannot change the tool result. */ () => undefined);
    }
  } catch {
    // Diagnostics are observability only. A persistence failure never changes a tool outcome.
  }
}
