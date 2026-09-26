import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { modelSafeJson } from "../redaction.js";
import type { HerdrToolDefinition, HerdrToolSurface } from "../tool-surface.js";
import { hostContext, type HerdrToolHost } from "./host.js";
import { LAUNCH_DIAGNOSTIC_MARKER, LAUNCH_RECOVERY_GUIDANCE, type LaunchEffectCertainty } from "../tools/launch.js";
import { appendToolTelemetry, invalidInputError, monotonicDurationMs, telemetryOperation, type ToolInputError } from "../telemetry.js";

/** Total response bound for one MCP tool result. */
export const MCP_RESULT_MAX_BYTES = 60_000;
/** Marker reused from the existing per-tool evidence bounds. */
export const OUTPUT_TRUNCATION_MARKER = "\n[output truncated]";
/** Label of the single appended bounded-details block. */
export const HERDR_DETAILS_LABEL = "herdr-details";

const MARKER_BYTES = Buffer.byteLength(OUTPUT_TRUNCATION_MARKER, "utf8");
const DETAILS_PREFIX = `${HERDR_DETAILS_LABEL}\n`;
const DETAILS_PREFIX_BYTES = Buffer.byteLength(DETAILS_PREFIX, "utf8");
const MIN_DETAILS_BYTES = 256;
const DETAILS_FIELD_BYTES = Buffer.byteLength(",\"details\":", "utf8");
const MAX_ERROR_MESSAGE_CHARS = 2_000;
const MAX_CODE_CHARS = 120;
const MAX_TOOL_NAME_CHARS = 120;


export class AdapterContractError extends Error {
  readonly code = "ADAPTER_CONTRACT_VIOLATION" as const;

  constructor(message: string) {
    super(message);
    this.name = "AdapterContractError";
  }
}

export interface McpToolDescriptor {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: { readonly type: "object"; readonly [key: string]: unknown };
}

export interface McpTextBlock {
  readonly type: "text";
  readonly text: string;
}

export interface McpCallOutcome {
  readonly content: ReadonlyArray<McpTextBlock>;
  readonly isError?: true;
}

/** Only the ordered definitions are needed to serve MCP requests. */
export type McpToolSurface = Pick<HerdrToolSurface, "definitions">;

export interface McpCallRequest {
  readonly surface: McpToolSurface;
  readonly name: string;
  readonly args: unknown;
  readonly host: HerdrToolHost;
  readonly callId: string;
}

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function singleLine(value: string, limit: number): string {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? " " : character;
    })
    .join("")
    .slice(0, limit)
    .trim();
}

/**
 * Publish the shared TypeBox schema structurally. Union roots gain the object
 * type MCP requires while every variant keeps its own `additionalProperties`;
 * no root `additionalProperties` is added, because a root `false` with no
 * `properties` would reject every argument object.
 */
export function publishedInputSchema(schema: unknown): McpToolDescriptor["inputSchema"] {
  const clone = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  if (clone.type === "object") return clone as McpToolDescriptor["inputSchema"];
  if (Array.isArray(clone.anyOf)) return { ...clone, type: "object" } as McpToolDescriptor["inputSchema"];
  throw new AdapterContractError("tool parameters are not a publishable object schema");
}

function descriptor(definition: HerdrToolDefinition): McpToolDescriptor {
  return {
    name: definition.name,
    title: definition.label,
    description: definition.description,
    inputSchema: publishedInputSchema(definition.parameters)
  };
}

/** Describe the shared surface for `tools/list`, in `CORE_TOOL_NAMES` order. */
export function describeTools(surface: McpToolSurface): McpToolDescriptor[] {
  return surface.definitions.map(descriptor);
}

/**
 * Bound one oversized shared text block to `budget` bytes, keeping the head and
 * never splitting a code point. The head is authoritative here: a truncated tail
 * would drop the operation and the outcome the model needs. The caller has
 * already established that `value` does not fit, so the marker is always true.
 */
function boundedHead(value: string, budget: number): string {
  const room = Math.max(0, budget - MARKER_BYTES);
  let kept = "";
  let size = 0;
  for (const character of value) {
    const characterBytes = bytes(character);
    if (size + characterBytes > room) break;
    kept += character;
    size += characterBytes;
  }
  return `${kept}${OUTPUT_TRUNCATION_MARKER}`;
}

/** What one code point costs inside a JSON string literal. */
function escapedBytes(character: string): number {
  return bytes(JSON.stringify(character)) - 2;
}

/**
 * A bounded structured block stays valid JSON. Cutting a serialized object at a
 * byte boundary would publish malformed syntax, so an oversized value is
 * replaced by this envelope instead: the head of the serialized evidence is
 * carried as a JSON string, and the original size is stated so the truncation is
 * explicit rather than inferred from a trailing marker.
 */
interface TruncationEnvelope {
  readonly truncated: true;
  readonly originalBytes: number;
  readonly preview: string;
}

function truncationEnvelope(serialized: string, budget: number): TruncationEnvelope {
  const empty: TruncationEnvelope = { truncated: true, originalBytes: bytes(serialized), preview: "" };
  const room = budget - bytes(JSON.stringify(empty));
  let preview = "";
  let size = 0;
  for (const character of serialized) {
    const cost = escapedBytes(character);
    if (size + cost > room) break;
    preview += character;
    size += cost;
  }
  return { ...empty, preview };
}

/**
 * Bound one structured value to `budget` serialized bytes, as a value rather
 * than as text, so every block this adapter publishes is parseable JSON. The
 * caller must pass a budget with room for the empty envelope; both call sites
 * hold at least `MIN_DETAILS_BYTES`.
 */
function boundedJsonValue(value: unknown, budget: number): unknown {
  const serialized = JSON.stringify(value) ?? "null";
  return bytes(serialized) <= budget ? value : truncationEnvelope(serialized, budget);
}

function boundedJsonText(value: unknown, budget: number): string {
  return JSON.stringify(boundedJsonValue(value, budget)) ?? "null";
}

function detailsBlock(details: unknown, budget: number): McpTextBlock | undefined {
  const room = budget - DETAILS_PREFIX_BYTES;
  if (room < MIN_DETAILS_BYTES) return undefined;
  return { type: "text", text: `${DETAILS_PREFIX}${boundedJsonText(details, room)}` };
}

function boundedSharedBlocks(texts: readonly string[], budget: number): McpTextBlock[] {
  const blocks: McpTextBlock[] = [];
  let remaining = budget;
  for (const text of texts) {
    if (remaining <= 0) break;
    const size = bytes(text);
    if (size <= remaining) {
      blocks.push({ type: "text", text });
      remaining -= size;
      continue;
    }
    blocks.push({ type: "text", text: boundedHead(text, remaining) });
    remaining = 0;
  }
  return blocks;
}

/**
 * A shared tool whose content block already is its own `details` serialized
 * (`herdr_jobs`, pretty-printed) needs no appended copy: the structured evidence
 * is present, complete, and untruncated. The comparison is a JSON round trip, so
 * only an exact same-value block qualifies. A projection, a truncated rendering,
 * or any non-JSON text is not the same evidence and still gets its block.
 */
function alreadyPublished(details: unknown, texts: readonly string[]): boolean {
  const serialized = JSON.stringify(details);
  if (serialized === undefined) return false;
  return texts.some((text) => {
    try {
      return JSON.stringify(JSON.parse(text)) === serialized;
    } catch {
      return false;
    }
  });
}

/**
 * Shared text blocks pass through verbatim, followed by one bounded
 * `herdr-details` block. The details block is bounded first, then the shared
 * blocks, so the total response stays within `MCP_RESULT_MAX_BYTES`.
 */
export function successOutcome(result: { content: ReadonlyArray<{ type: string; text?: string }>; details?: unknown }): McpCallOutcome {
  const texts = result.content.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string").map((block) => block.text);
  const sharedBytes = texts.reduce((total, text) => total + bytes(text), 0);
  const safeDetails = modelSafeJson(result.details);
  const details = result.details === undefined || alreadyPublished(safeDetails, texts)
    ? undefined
    : detailsBlock(safeDetails, MCP_RESULT_MAX_BYTES - sharedBytes);
  const sharedBudget = MCP_RESULT_MAX_BYTES - (details ? bytes(details.text) : 0);
  return { content: [...boundedSharedBlocks(texts, sharedBudget), ...(details ? [details] : [])] };
}

function errorCode(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
  const safe = typeof code === "string" ? singleLine(code, MAX_CODE_CHARS) : "";
  return safe.length > 0 ? safe : "INTERNAL_ERROR";
}

function errorDetails(error: unknown): unknown {
  const details = typeof error === "object" && error !== null && "details" in error ? (error as { details?: unknown }).details : undefined;
  return typeof details === "object" && details !== null ? details : undefined;
}

const LAUNCH_DIAGNOSTIC_PHASES = new Set(["validate", "route", "compile", "handoff", "attachment_publish", "supervision_reserve", "placement", "agent_start", "ready", "prompt_verification", "supervision_bind"]);
const LAUNCH_EFFECT_CERTAINTIES = new Set<string>(["absent", "partial", "unknown", "confirmed"]);
const LAUNCH_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;

function launchDiagnosticId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const hasControlCharacter = [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (Buffer.byteLength(value, "utf8") > 256 || hasControlCharacter || value.trim() !== value) return undefined;
  return value;
}

/** The launcher certainty an evidence record asserts, validated against the closed set. */
function launchEffectCertainty(value: unknown): LaunchEffectCertainty | undefined {
  return typeof value === "string" && LAUNCH_EFFECT_CERTAINTIES.has(value) ? value as LaunchEffectCertainty : undefined;
}

function launchDiagnosticPayload(message: string): Record<string, unknown> | undefined {
  const marker = `\n${LAUNCH_DIAGNOSTIC_MARKER} `;
  const offset = message.lastIndexOf(marker);
  if (offset < 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.slice(offset + marker.length));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const value = parsed as Record<string, unknown>;
  const phase = value.phase;
  const effectCertainty = value.effectCertainty;
  const recoveryGuidance = value.recoveryGuidance;
  if (typeof phase !== "string" || !LAUNCH_DIAGNOSTIC_PHASES.has(phase)) return undefined;
  if (launchEffectCertainty(effectCertainty) === undefined) return undefined;
  if (typeof recoveryGuidance !== "string" || !Object.values(LAUNCH_RECOVERY_GUIDANCE).includes(recoveryGuidance as typeof LAUNCH_RECOVERY_GUIDANCE[keyof typeof LAUNCH_RECOVERY_GUIDANCE])) return undefined;
  if (typeof value.agentStarted !== "boolean" || typeof value.promptSubmitted !== "boolean" || typeof value.recipientRegistered !== "boolean") return undefined;
  const createdValue = value.created;
  if (typeof createdValue !== "object" || createdValue === null || Array.isArray(createdValue)) return undefined;
  const created = Object.fromEntries(["tabId", "paneId", "agentId"].flatMap((field) => {
    const id = launchDiagnosticId((createdValue as Record<string, unknown>)[field]);
    return id === undefined ? [] : [[field, id] as const];
  }));
  const conditionalFields = ["paneId", "supervisorJobId", "assignmentState"] as const;
  const hasConditionalFields = conditionalFields.some((field) => Object.prototype.hasOwnProperty.call(value, field));
  let assignmentUnconfirmed: { paneId: string; supervisorJobId: string; assignmentState: "unconfirmed" } | undefined;
  if (hasConditionalFields) {
    const paneId = launchDiagnosticId(value.paneId);
    const supervisorJobId = launchDiagnosticId(value.supervisorJobId);
    if (paneId === undefined || supervisorJobId === undefined || value.assignmentState !== "unconfirmed") return undefined;
    assignmentUnconfirmed = { paneId, supervisorJobId, assignmentState: "unconfirmed" };
  }
  const code = typeof value.code === "string" && LAUNCH_CODE_PATTERN.test(value.code) ? value.code : "LAUNCH_FAILED";
  return {
    code,
    phase,
    created,
    ...(assignmentUnconfirmed === undefined ? {} : assignmentUnconfirmed),
    agentStarted: value.agentStarted,
    promptSubmitted: value.promptSubmitted,
    recipientRegistered: value.recipientRegistered,
    effectCertainty,
    recoveryGuidance
  };
}

function promptDispatchPayload(value: unknown): Record<string, unknown> | undefined {
  if (!record(value) || !["not_written", "rejected", "acknowledged", "unknown"].includes(value.state as string)) return undefined;
  const requestId = value.requestId === undefined ? undefined : launchDiagnosticId(value.requestId);
  return {
    state: value.state,
    ...(requestId === undefined ? {} : { requestId })
  };
}

/** Keep the recovery handles a failed launch already proved, without exposing its cause details. */
function launchRecoveryDetails(details: unknown): Record<string, unknown> {
  if (!record(details)) return {};
  const recovery: Record<string, unknown> = {};
  for (const field of ["paneId", "tabId", "supervisorJobId"] as const) {
    const value = launchDiagnosticId(details[field]);
    if (value !== undefined) recovery[field] = value;
  }
  // The launcher-computed certainty is a recovery handle in its own right:
  // without it a caller cannot distinguish a provably absent effect from a
  // possibly-consumed one.
  const certainty = launchEffectCertainty(details.effectCertainty);
  if (certainty !== undefined) recovery.effectCertainty = certainty;
  const dispatch = promptDispatchPayload(details.promptDispatch);
  if (dispatch !== undefined) recovery.promptDispatch = dispatch;
  if (details.attachmentRetained === true) recovery.attachmentRetained = true;
  if (record(details.attachment)) {
    const attachment = details.attachment;
    const attachmentId = launchDiagnosticId(attachment.attachmentId);
    const path = launchDiagnosticId(attachment.path);
    const size = attachment.bytes;
    const sha256 = attachment.sha256;
    const expiresAt = launchDiagnosticId(attachment.expiresAt);
    if (attachmentId !== undefined && path !== undefined && typeof size === "number" && Number.isSafeInteger(size) && size >= 1 && typeof sha256 === "string" && /^[0-9a-f]{64}$/u.test(sha256) && expiresAt !== undefined) {
      recovery.attachment = {
        attachmentId,
        path,
        bytes: size,
        sha256,
        expiresAt,
        ...(launchDiagnosticId(attachment.recipientPaneId) === undefined ? {} : { recipientPaneId: launchDiagnosticId(attachment.recipientPaneId) })
      };
    }
  }
  return recovery;
}

/**
 * Typed tool failures are model-visible tool results, never protocol errors.
 *
 * The typed code and the bounded message are never truncated away: they are
 * serialized first and only the evidence is bounded against what is left. The
 * head is small by construction — `MAX_CODE_CHARS` plus `MAX_ERROR_MESSAGE_CHARS`
 * printable characters cannot exceed roughly 9 KiB even fully escaped — so the
 * evidence always keeps more than `MIN_DETAILS_BYTES` of room.
 */
export function errorOutcome(code: string, message: string, details?: unknown, toolName?: string): McpCallOutcome {
  const head = { code, message: singleLine(message, MAX_ERROR_MESSAGE_CHARS) };
  if (toolName === "herdr_launch") {
    // Launch keeps rich details for Pi/TUI recovery, but its Error.message also
    // carries the sole fixed-shape model diagnostic. Never forward the attached
    // details: they include raw cause and backend evidence by design. A typed
    // daemon-call error carries no embedded record, so the recovery handles —
    // effect certainty and the surviving-resource identifiers — are projected
    // from `details` whether or not a diagnostic parsed.
    const diagnostic = launchDiagnosticPayload(message);
    const launchDetails = { tool: toolName, ...(diagnostic === undefined ? {} : { diagnostic }), ...launchRecoveryDetails(details) };
    return { content: [{ type: "text", text: JSON.stringify({ ...head, details: launchDetails }) }], isError: true };
  }
  const safeDetails = modelSafeJson(details);
  const payload = safeDetails === undefined
    ? head
    : { ...head, details: boundedJsonValue(safeDetails, MCP_RESULT_MAX_BYTES - bytes(JSON.stringify(head)) - DETAILS_FIELD_BYTES) };
  return { content: [{ type: "text", text: JSON.stringify(payload) }], isError: true };
}

function toolInputOutcome(error: ToolInputError): McpCallOutcome {
  return { content: [{ type: "text", text: JSON.stringify({ code: error.code, message: error.message, details: error.diagnostic }) }], isError: true };
}

function validationError(definition: HerdrToolDefinition, args: unknown): ToolInputError | undefined {
  return invalidInputError(definition.name, definition.validationSchema ?? definition.parameters, args);
}

/**
 * Validate against the shared schema, execute the shared tool with the request's
 * cancellation signal, and map the outcome to bounded MCP content.
 *
 * There is no host-side serialization: the daemon is the single serialization
 * boundary (durable-supervisor §10), so every validated call runs directly.
 */
export async function callTool(request: McpCallRequest): Promise<McpCallOutcome> {
  const startedAt = performance.now();
  const definition = request.surface.definitions.find((candidate) => candidate.name === request.name);
  if (!definition) {
    throw new McpError(ErrorCode.MethodNotFound, `unknown Herdr tool ${singleLine(request.name, MAX_TOOL_NAME_CHARS)}`);
  }
  const args = request.args === undefined || request.args === null ? {} : request.args;
  const invalid = validationError(definition, args);
  if (invalid !== undefined) {
    await appendToolTelemetry({
      tool: definition.name,
      operation: telemetryOperation(definition.name, args, false),
      phases: { validate: "failure", execute: "skipped", persist: "success" },
      durationMs: monotonicDurationMs(startedAt),
      effectCertainty: "absent",
    }, { root: request.host.cwd });
    return toolInputOutcome(invalid);
  }
  try {
    const result = await definition.execute(request.callId, args, request.host.signal, undefined, hostContext(request.host));
    return successOutcome(result);
  } catch (error) {
    return errorOutcome(errorCode(error), error instanceof Error ? error.message : String(error), errorDetails(error), definition.name);
  }
}
