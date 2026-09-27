export const MESSAGE_INLINE_MAX_BYTES = 16 * 1024;

export type MessageDelivery = "inline";

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function assertMessageText(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw Object.assign(new Error("Message text must be non-empty UTF-8 text without NUL"), {
      code: "INVALID_INPUT",
      details: { field: "text" }
    });
  }
}

export function assertDeliverySize(text: string, delivery: MessageDelivery): void {
  const bytes = utf8Bytes(text);
  if (bytes > MESSAGE_INLINE_MAX_BYTES) {
    throw Object.assign(new Error(`Message payload exceeds the ${delivery} delivery bound`), {
      code: "PAYLOAD_TOO_LARGE_FOR_INLINE",
      details: { bytes, limit: MESSAGE_INLINE_MAX_BYTES, delivery }
    });
  }
}
