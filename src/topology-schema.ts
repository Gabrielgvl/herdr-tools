import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const Identifier = Type.String({ minLength: 1, pattern: "^[^\\u0000\\r\\n]+$" });
const EnvironmentKey = Type.String({ minLength: 1, pattern: "^[^=\\u0000\\r\\n]+$" });
const EnvironmentValue = Type.String({ pattern: "^[^\\u0000\\r\\n]*$" });
const Direction = StringEnum(["right", "down", "left", "up"] as const);
const SplitDirection = StringEnum(["right", "down"] as const);
const Focus = Type.Boolean();
const Env = Type.Record(EnvironmentKey, EnvironmentValue);

const TabDestination = Type.Union([
  Type.Object({ kind: Type.Literal("tab"), target: Identifier }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("new_tab"), label: Identifier }, { additionalProperties: false })
]);

export const PaneParamsSchema = Type.Union([
  Type.Object({
    operation: Type.Literal("split"),
    target: Type.Optional(Identifier),
    label: Identifier,
    direction: Type.Optional(SplitDirection),
    focus: Type.Optional(Focus),
    cwd: Type.Optional(Identifier),
    env: Type.Optional(Env)
  }, { additionalProperties: false }),
  Type.Object({
    operation: Type.Literal("move"),
    target: Identifier,
    destination: TabDestination,
    direction: Type.Optional(SplitDirection),
    focus: Type.Optional(Focus)
  }, { additionalProperties: false }),
  Type.Object({
    operation: Type.Literal("rename"),
    target: Identifier,
    label: Identifier
  }, { additionalProperties: false }),
  Type.Object({
    operation: Type.Literal("focus"),
    target: Identifier
  }, { additionalProperties: false }),
  Type.Object({
    operation: Type.Literal("resize"),
    target: Identifier,
    direction: Direction,
    amount: Type.Number({ exclusiveMinimum: 0 })
  }, { additionalProperties: false }),
  Type.Object({
    operation: Type.Literal("swap"),
    source: Identifier,
    with: Type.Union([Identifier, Direction])
  }, { additionalProperties: false }),
  Type.Object({
    operation: Type.Literal("zoom"),
    target: Type.Optional(Identifier),
    mode: Type.Optional(StringEnum(["toggle", "on", "off"] as const))
  }, { additionalProperties: false }),
  Type.Object({
    operation: Type.Literal("close"),
    target: Identifier
  }, { additionalProperties: false })
]);

export const TabParamsSchema = Type.Union([
  Type.Object({
    operation: Type.Literal("create"),
    label: Identifier,
    cwd: Type.Optional(Identifier),
    env: Type.Optional(Env),
    focus: Type.Optional(Focus)
  }, { additionalProperties: false }),
  Type.Object({
    operation: Type.Literal("rename"),
    target: Identifier,
    label: Identifier
  }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("focus"), target: Identifier }, { additionalProperties: false }),
  Type.Object({ operation: Type.Literal("close"), target: Identifier }, { additionalProperties: false })
]);

export type DirectionValue = "right" | "down" | "left" | "up";
export type SplitDirectionValue = "right" | "down";
export type PaneParams =
  | { operation: "split"; target?: string; label: string; direction?: SplitDirectionValue; focus?: boolean; cwd?: string; env?: Record<string, string> }
  | { operation: "move"; target: string; destination: { kind: "tab"; target: string } | { kind: "new_tab"; label: string }; direction?: SplitDirectionValue; focus?: boolean }
  | { operation: "rename"; target: string; label: string }
  | { operation: "focus"; target: string }
  | { operation: "resize"; target: string; direction: DirectionValue; amount: number }
  | { operation: "swap"; source: string; with: string }
  | { operation: "zoom"; target?: string; mode?: "toggle" | "on" | "off" }
  | { operation: "close"; target: string };

export type TabParams =
  | { operation: "create"; label: string; cwd?: string; env?: Record<string, string>; focus?: boolean }
  | { operation: "rename"; target: string; label: string }
  | { operation: "focus"; target: string }
  | { operation: "close"; target: string };

export function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\u0000") && !value.includes("\r") && !value.includes("\n");
}

export function assertSafeIdentifier(value: unknown, field: string): asserts value is string {
  if (!isSafeIdentifier(value)) throw Object.assign(new Error(`INVALID_INPUT: ${field} must be a non-empty single-line identifier`), { code: "INVALID_INPUT" });
}

export function assertSafeEnvironment(env: Record<string, string> | undefined): void {
  if (env === undefined) return;
  for (const [key, value] of Object.entries(env)) {
    if (!isSafeIdentifier(key) || key.includes("=")) {
      throw Object.assign(new Error("environment key must be a non-empty single-line name"), { code: "INVALID_INPUT" });
    }
    if (typeof value !== "string" || value.includes("\u0000") || value.includes("\r") || value.includes("\n")) {
      throw Object.assign(new Error("environment value cannot contain NUL or newlines"), { code: "INVALID_INPUT" });
    }
  }
}
