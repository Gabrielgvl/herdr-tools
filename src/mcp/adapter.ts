import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { Value } from "typebox/value";
import type { HerdrToolDefinition, HerdrToolSurface } from "../tool-surface.js";
import { hostContext, type HerdrToolHost } from "./host.js";

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
const MAX_ERROR_MESSAGE_CHARS = 2_000;
const MAX_CODE_CHARS = 120;
const MAX_TOOL_NAME_CHARS = 120;
const MAX_VALIDATION_ERRORS = 3;

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
 * Bound a payload to `budget` bytes, keeping the head and never splitting a code
 * point. The head is authoritative here: a truncated tail would drop the typed
 * code, the operation, and the outcome the model needs.
 */
function boundedHead(value: string, budget: number): string {
  if (bytes(value) <= budget) return value;
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

function boundedJsonText(value: unknown, budget: number): string {
  return boundedHead(JSON.stringify(value) ?? "null", budget);
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
  const details = result.details === undefined || alreadyPublished(result.details, texts)
    ? undefined
    : detailsBlock(result.details, MCP_RESULT_MAX_BYTES - sharedBytes);
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

/** Typed tool failures are model-visible tool results, never protocol errors. */
export function errorOutcome(code: string, message: string, details?: unknown): McpCallOutcome {
  const payload = {
    code,
    message: singleLine(message, MAX_ERROR_MESSAGE_CHARS),
    ...(details === undefined ? {} : { details })
  };
  return { content: [{ type: "text", text: boundedJsonText(payload, MCP_RESULT_MAX_BYTES) }], isError: true };
}

function validationOutcome(definition: HerdrToolDefinition, args: unknown): McpCallOutcome | undefined {
  if (Value.Check(definition.parameters, args)) return undefined;
  const errors = [...Value.Errors(definition.parameters, args)].slice(0, MAX_VALIDATION_ERRORS).map((error) => ({
    keyword: singleLine(String(error.keyword), MAX_CODE_CHARS),
    instancePath: singleLine(String(error.instancePath), MAX_CODE_CHARS),
    schemaPath: singleLine(String(error.schemaPath), MAX_CODE_CHARS),
    message: singleLine(String(error.message), MAX_ERROR_MESSAGE_CHARS)
  }));
  return errorOutcome("INVALID_INPUT", `INVALID_INPUT: arguments do not match the ${definition.name} schema`, { errors });
}

/**
 * Validate against the shared schema, execute the shared tool with the request's
 * cancellation signal, and map the outcome to bounded MCP content.
 */
export async function callTool(request: McpCallRequest): Promise<McpCallOutcome> {
  const definition = request.surface.definitions.find((candidate) => candidate.name === request.name);
  if (!definition) {
    throw new McpError(ErrorCode.MethodNotFound, `unknown Herdr tool ${singleLine(request.name, MAX_TOOL_NAME_CHARS)}`);
  }
  const args = request.args === undefined || request.args === null ? {} : request.args;
  const invalid = validationOutcome(definition, args);
  if (invalid) return invalid;
  try {
    const result = await definition.execute(request.callId, args, request.host.signal, undefined, hostContext(request.host));
    return successOutcome(result);
  } catch (error) {
    return errorOutcome(errorCode(error), error instanceof Error ? error.message : String(error), errorDetails(error));
  }
}
