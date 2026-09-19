import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { type MessageDelivery } from "./messages/limits.js";

const Identifier = Type.String({ minLength: 1, pattern: "^[^\\u0000\\r\\n]+$" });

export const InspectParamsSchema = Type.Union([
  Type.Object({}, { additionalProperties: false }),
  Type.Object({ mode: StringEnum(["context"] as const) }, { additionalProperties: false }),
  Type.Object({ mode: StringEnum(["target"] as const), target: Identifier }, { additionalProperties: false }),
  Type.Object({ mode: StringEnum(["collection"] as const), collection: StringEnum(["panes", "agents", "tabs", "profiles"] as const) }, { additionalProperties: false }),
  Type.Object({ mode: StringEnum(["profile"] as const), profile: Identifier }, { additionalProperties: false }),
  Type.Object({ mode: StringEnum(["health"] as const) }, { additionalProperties: false })
]);

/**
 * Flat publication shape: the pi harness drops every argument of a tool whose
 * parameters are a root union, so the per-mode fields are published as one
 * optional-all object. `InspectParamsSchema` stays the internal contract — the
 * tool's execute checks incoming params against it before dispatching on mode.
 */
export const PublishedInspectParamsSchema = Type.Object({
  mode: Type.Optional(StringEnum(["context", "target", "collection", "profile", "health"] as const)),
  target: Type.Optional(Identifier),
  collection: Type.Optional(StringEnum(["panes", "agents", "tabs", "profiles"] as const)),
  profile: Type.Optional(Identifier)
}, { additionalProperties: false });

export const SUPPORTED_NAMED_KEYS = ["esc", "escape", "enter", "tab", "space", "backspace", "delete", "up", "down", "left", "right", "home", "end", "pageup", "pagedown", "ctrl+c", "ctrl+d", "ctrl+z"] as const;
const NamedKey = StringEnum(SUPPORTED_NAMED_KEYS);
const Delivery = StringEnum(["inline", "attachment"] as const);
const MessageText = Type.String({ minLength: 1, pattern: "^[^\\u0000]*$" });

export const CommunicateParamsSchema = Type.Union([
  Type.Object({ target: Identifier, operation: Type.Literal("prompt"), text: MessageText, delivery: Type.Optional(Delivery), kind: Type.Optional(Type.Literal("result")) }, { additionalProperties: false }),
  Type.Object({ target: Identifier, operation: Type.Literal("steer"), text: MessageText, delivery: Type.Optional(Delivery), kind: Type.Optional(Type.Literal("result")) }, { additionalProperties: false }),
  Type.Object({ target: Identifier, operation: Type.Literal("keys"), keys: Type.Array(NamedKey, { minItems: 1 }) }, { additionalProperties: false }),
  Type.Object({ target: Identifier, operation: Type.Literal("cancel") }, { additionalProperties: false }),
  Type.Object({ target: Identifier, operation: Type.Literal("interrupt") }, { additionalProperties: false })
]);

/**
 * Flat publication shape: the pi harness drops every argument of a tool whose
 * parameters are a root union, so the per-operation fields are published as one
 * optional-all object. `CommunicateParamsSchema` stays the internal contract —
 * the tool's execute checks incoming params against it before dispatching on
 * operation.
 */
export const PublishedCommunicateParamsSchema = Type.Object({
  target: Type.Optional(Identifier),
  operation: Type.Optional(StringEnum(["prompt", "steer", "keys", "cancel", "interrupt"] as const)),
  text: Type.Optional(MessageText),
  delivery: Type.Optional(Delivery),
  kind: Type.Optional(Type.Literal("result")),
  keys: Type.Optional(Type.Array(NamedKey, { minItems: 1 }))
}, { additionalProperties: false });

export type InspectParams = { mode?: "context" | "target" | "collection" | "profile" | "health"; target?: string; collection?: "panes" | "agents" | "tabs" | "profiles"; profile?: string };
export type TurnControlOperation = "cancel" | "interrupt";
export type CommunicateParams =
  | { target: string; operation: "prompt"; text: string; delivery?: MessageDelivery; kind?: "result" }
  | { target: string; operation: "steer"; text: string; delivery?: MessageDelivery; kind?: "result" }
  | { target: string; operation: "keys"; keys: string[] }
  | { target: string; operation: TurnControlOperation };

const SUPPORTED_NAMED_KEY_SET = new Set<string>(SUPPORTED_NAMED_KEYS);
export function isNamedKey(value: string): boolean {
  return SUPPORTED_NAMED_KEY_SET.has(value.toLowerCase());
}
