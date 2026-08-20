export const MESSAGE_INLINE_MAX_BYTES = 16 * 1024;
export const ATTACHMENT_MAX_BYTES = 1 * 1024 * 1024;
export const ATTACHMENT_STORE_QUOTA_BYTES = 64 * 1024 * 1024;
export const ATTACHMENT_STORE_MAX_RECORDS = 256;
export const ATTACHMENT_RETENTION_HOURS = 24;

export type MessageDelivery = "inline" | "attachment";

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
  const limit = delivery === "inline" ? MESSAGE_INLINE_MAX_BYTES : ATTACHMENT_MAX_BYTES;
  if (bytes > limit) {
    throw Object.assign(new Error(`Message payload exceeds the ${delivery} delivery bound`), {
      code: delivery === "inline" ? "PAYLOAD_TOO_LARGE_FOR_INLINE" : "PAYLOAD_TOO_LARGE",
      details: { bytes, limit, delivery }
    });
  }
}
