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

export const SUPPORTED_NAMED_KEYS = ["esc", "escape", "enter", "tab", "space", "backspace", "delete", "up", "down", "left", "right", "home", "end", "pageup", "pagedown", "ctrl+c", "ctrl+d", "ctrl+z"] as const;
const NamedKey = StringEnum(SUPPORTED_NAMED_KEYS);
const Delivery = StringEnum(["inline", "attachment"] as const);
const MessageText = Type.String({ minLength: 1, pattern: "^[^\\u0000]*$" });

export const CommunicateParamsSchema = Type.Union([
  Type.Object({ target: Identifier, operation: Type.Literal("prompt"), text: MessageText, delivery: Type.Optional(Delivery) }, { additionalProperties: false }),
  Type.Object({ target: Identifier, operation: Type.Literal("steer"), text: MessageText, delivery: Type.Optional(Delivery) }, { additionalProperties: false }),
  Type.Object({ target: Identifier, operation: Type.Literal("keys"), keys: Type.Array(NamedKey, { minItems: 1 }) }, { additionalProperties: false })
]);

export type InspectParams = { mode?: "context" | "target" | "collection" | "profile" | "health"; target?: string; collection?: "panes" | "agents" | "tabs" | "profiles"; profile?: string };
export type CommunicateParams =
  | { target: string; operation: "prompt"; text: string; delivery?: MessageDelivery }
  | { target: string; operation: "steer"; text: string; delivery?: MessageDelivery }
  | { target: string; operation: "keys"; keys: string[] };

const SUPPORTED_NAMED_KEY_SET = new Set<string>(SUPPORTED_NAMED_KEYS);
export function isNamedKey(value: string): boolean {
  return SUPPORTED_NAMED_KEY_SET.has(value.toLowerCase());
}
