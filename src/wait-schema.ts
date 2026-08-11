import RE2 from "re2";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { Static } from "typebox";

export const WAIT_RAW_STATES = ["idle", "working", "blocked", "done", "unknown"] as const;
export const WAIT_SEMANTIC_STATES = ["started", "completed", "needs_input"] as const;
export const WAIT_LABEL_MAX_LENGTH = 120;
export const WAIT_LABEL_MAX_BYTES = WAIT_LABEL_MAX_LENGTH * 4 + 2;

/** A target selector is deliberately an opaque, single-line identifier. */
export const WaitTargetSchema = Type.String({
  minLength: 1,
  pattern: "^[^\\u0000\\r\\n]+$"
});

const RawStateSchema = StringEnum(WAIT_RAW_STATES);
const SemanticStateSchema = StringEnum(WAIT_SEMANTIC_STATES);

export const WaitStateConditionSchema = Type.Object({
  kind: Type.Literal("state"),
  state: Type.Union([RawStateSchema, SemanticStateSchema])
}, { additionalProperties: false });

export const WaitOutputConditionSchema = Type.Object({
  kind: Type.Literal("output"),
  match: Type.Union([
    Type.Object({ kind: Type.Literal("literal"), value: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("regex"), value: Type.String({ minLength: 1 }) }, { additionalProperties: false })
  ])
}, { additionalProperties: false });

export const WaitParamsSchema = Type.Object({
  targets: Type.Array(WaitTargetSchema, { minItems: 1, uniqueItems: true }),
  match: StringEnum(["any", "all"] as const),
  condition: Type.Union([WaitStateConditionSchema, WaitOutputConditionSchema]),
  timeoutMs: Type.Integer({ minimum: 1, maximum: 3_600_000 }),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: WAIT_LABEL_MAX_LENGTH, pattern: "^[^\\u0000-\\u001f\\u007f]+$" })),
  runInBackground: Type.Optional(Type.Boolean())
}, { additionalProperties: false });

export type WaitRawState = Static<typeof RawStateSchema>;
export type WaitSemanticState = Static<typeof SemanticStateSchema>;
export type WaitCondition = Static<typeof WaitStateConditionSchema> | Static<typeof WaitOutputConditionSchema>;
export type WaitParams = Static<typeof WaitParamsSchema>;

export interface SafeRegex {
  test(value: string): boolean;
}

export interface WaitValidation {
  params: WaitParams;
  regex?: SafeRegex;
}

export interface WaitRequest extends WaitParams {
  runInBackground?: boolean;
}

function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: "INVALID_INPUT" });
}

/**
 * Runtime checks complement the JSON schema: TypeBox can reject duplicate
 * strings, but it cannot reject duplicate resources after target resolution,
 * nor can it validate safe regular-expression syntax.
 */
export function validateWaitParams(value: unknown): WaitValidation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("INVALID_INPUT: wait input must be an object");
  const params = value as Partial<WaitParams>;
  const topLevelKeys = Object.keys(value as object);
  if (topLevelKeys.some((key) => !["targets", "match", "condition", "timeoutMs", "label", "runInBackground"].includes(key))) invalid("INVALID_INPUT: unknown wait fields are not allowed");
  if (!Array.isArray(params.targets) || params.targets.length === 0) invalid("INVALID_INPUT: targets must contain at least one target");
  if (params.label !== undefined && (typeof params.label !== "string" || params.label.trim().length === 0 || [...params.label].length > WAIT_LABEL_MAX_LENGTH || [...params.label].some((character) => { const code = character.charCodeAt(0); return code <= 31 || code === 127; }))) invalid(`INVALID_INPUT: label must be a non-empty printable single-line string of at most ${WAIT_LABEL_MAX_LENGTH} characters`);
  if (params.runInBackground !== undefined && typeof params.runInBackground !== "boolean") invalid("INVALID_INPUT: runInBackground must be a boolean");
  if (params.targets.some((target) => typeof target !== "string" || target.length === 0 || target.includes(String.fromCharCode(0)) || target.includes("\r") || target.includes("\n"))) invalid("INVALID_INPUT: targets must be non-empty single-line identifiers");
  if (new Set(params.targets).size !== params.targets.length) invalid("INVALID_INPUT: duplicate target references are not allowed");
  if (params.match !== "any" && params.match !== "all") invalid("INVALID_INPUT: match must be any or all");
  if (!Number.isInteger(params.timeoutMs) || (params.timeoutMs as number) < 1 || (params.timeoutMs as number) > 3_600_000) invalid("INVALID_INPUT: timeoutMs must be an integer from 1 through 3600000");
  if (typeof params.condition !== "object" || params.condition === null || Array.isArray(params.condition)) invalid("INVALID_INPUT: condition is invalid");
  const condition = params.condition as Record<string, unknown>;
  if (condition.kind === "state") {
    if (Object.keys(condition).some((key) => key !== "kind" && key !== "state")) invalid("INVALID_INPUT: unknown state condition fields are not allowed");
    if (![...WAIT_RAW_STATES, ...WAIT_SEMANTIC_STATES].includes(condition.state as never)) invalid("INVALID_INPUT: state is invalid");
  } else if (condition.kind === "output") {
    if (Object.keys(condition).some((key) => key !== "kind" && key !== "match")) invalid("INVALID_INPUT: unknown output condition fields are not allowed");
    if (typeof condition.match !== "object" || condition.match === null || Array.isArray(condition.match)) invalid("INVALID_INPUT: output match is invalid");
    const output = condition.match as Record<string, unknown>;
    if (Object.keys(output).some((key) => key !== "kind" && key !== "value")) invalid("INVALID_INPUT: unknown output match fields are not allowed");
    if ((output.kind !== "literal" && output.kind !== "regex") || typeof output.value !== "string" || output.value.length === 0) invalid("INVALID_INPUT: output match is invalid");
    if (output.kind === "regex") {
      try {
        return { params: params as WaitParams, regex: new RE2(output.value) };
      } catch (error) {
        invalid(`INVALID_INPUT: regex syntax is invalid: ${String(error)}`);
      }
    }
  } else {
    invalid("INVALID_INPUT: condition kind is invalid");
  }
  return { params: params as WaitParams };
}

export function isRawState(value: string): value is WaitRawState {
  return (WAIT_RAW_STATES as readonly string[]).includes(value);
}

export function isSemanticState(value: string): value is WaitSemanticState {
  return (WAIT_SEMANTIC_STATES as readonly string[]).includes(value);
}
