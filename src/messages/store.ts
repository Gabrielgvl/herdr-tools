import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_RETENTION_HOURS,
  ATTACHMENT_STORE_MAX_RECORDS,
  ATTACHMENT_STORE_QUOTA_BYTES,
  utf8Bytes
} from "./limits.js";

export const DEFAULT_ATTACHMENT_STORE_ROOT = resolve(join(homedir(), ".cache", "herdr-tools", "message-attachments"));

export interface AttachmentStoreIo {
  mkdir(path: string, options: { recursive: boolean; mode: number }): Promise<void>;
  mkdtemp(prefix: string): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array, options: { mode: number }): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  rm(path: string, options: { force: boolean; recursive: boolean }): Promise<void>;
  readdir(path: string): Promise<readonly AttachmentDirEntry[]>;
}

export interface AttachmentDirEntry {
  name: string;
  isDirectory(): boolean;
}

const nodeAttachmentStoreIo: AttachmentStoreIo = {
  mkdir: async (path, options) => { await fs.mkdir(path, options); },
  mkdtemp: (prefix) => fs.mkdtemp(prefix),
  readFile: async (path) => fs.readFile(path),
  writeFile: async (path, data, options) => { await fs.writeFile(path, data, options); },
  chmod: (path, mode) => fs.chmod(path, mode),
  rename: (source, destination) => fs.rename(source, destination),
  rm: (path, options) => fs.rm(path, options),
  readdir: async (path) => fs.readdir(path, { withFileTypes: true })
};

export interface AttachmentMetadata {
  attachmentId: string;
  bytes: number;
  sha256: string;
  encoding: "utf-8";
  createdAt: string;
  expiresAt: string;
  senderPaneId: string;
  senderDisplay: string;
  recipientAgentName?: string;
  recipientPaneId?: string;
  operation: "prompt" | "steer" | "assignment";
}

export interface AttachmentPublishInput {
  body: string;
  recipientKey: string;
  recipientPaneId?: string;
  recipientAgentName?: string;
  senderPaneId: string;
  senderDisplay: string;
  operation: AttachmentMetadata["operation"];
}

export interface PublishedAttachment {
  attachmentId: string;
  path: string;
  bytes: number;
  sha256: string;
  expiresAt: string;
  recipientPaneId?: string;
}

export type AttachmentStoreErrorCode = "ATTACHMENT_STORE_FAILED" | "ATTACHMENT_QUOTA_EXCEEDED";

export class AttachmentStoreError extends Error {
  readonly code: AttachmentStoreErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: AttachmentStoreErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "AttachmentStoreError";
    this.code = code;
    this.details = details;
  }
}

export interface AttachmentStore {
  readonly root: string;
  recipientDirectory(recipientKey: string): string;
  ensureRecipient(recipientKey: string): Promise<string>;
  publish(input: AttachmentPublishInput): Promise<PublishedAttachment>;
}

interface LiveRecord {
  path: string;
  metadata: AttachmentMetadata;
}

function errorCode(error: unknown): unknown {
  return error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
}

function safePath(value: string): string {
  return value.length <= 512 && !value.includes("\0") && !value.includes("\r") && !value.includes("\n") ? value : "[path omitted]";
}

function validKey(value: string): boolean {
  return /^[A-Za-z0-9_-]{8,128}$/.test(value);
}

function validateKey(value: string): void {
  if (!validKey(value)) throw new AttachmentStoreError("ATTACHMENT_STORE_FAILED", "Attachment recipient key is invalid", { operation: "validate_recipient" });
}

function validateBody(body: string): Buffer {
  if (typeof body !== "string" || body.length === 0 || body.includes("\0")) {
    throw Object.assign(new Error("Attachment body must be non-empty UTF-8 text without NUL"), { code: "INVALID_INPUT", details: { field: "text" } });
  }
  const data = Buffer.from(body, "utf8");
  if (data.byteLength > ATTACHMENT_MAX_BYTES) {
    throw Object.assign(new Error("Attachment body exceeds the attachment bound"), {
      code: "PAYLOAD_TOO_LARGE",
      details: { bytes: data.byteLength, limit: ATTACHMENT_MAX_BYTES, delivery: "attachment" }
    });
  }
  return data;
}

function parsedMetadata(value: Uint8Array, path: string): AttachmentMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value).toString("utf8"));
  } catch {
    throw new AttachmentStoreError("ATTACHMENT_STORE_FAILED", "Attachment metadata is unreadable", { operation: "read_metadata", path: safePath(path) });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AttachmentStoreError("ATTACHMENT_STORE_FAILED", "Attachment metadata is incompatible", { operation: "read_metadata", path: safePath(path) });
  }
  const candidate = parsed as Record<string, unknown>;
  const attachmentId = candidate.attachmentId;
  const bytes = candidate.bytes;
  const sha256 = candidate.sha256;
  const encoding = candidate.encoding;
  const createdAt = candidate.createdAt;
  const expiresAt = candidate.expiresAt;
  const senderPaneId = candidate.senderPaneId;
  const senderDisplay = candidate.senderDisplay;
  const operation = candidate.operation;
  if (typeof attachmentId !== "string" || !validKey(attachmentId) || typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 1 || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256) || encoding !== "utf-8" || typeof createdAt !== "string" || typeof expiresAt !== "string" || typeof senderPaneId !== "string" || typeof senderDisplay !== "string" || !["prompt", "steer", "assignment"].includes(operation as string)) {
    throw new AttachmentStoreError("ATTACHMENT_STORE_FAILED", "Attachment metadata is incompatible", { operation: "read_metadata", path: safePath(path) });
  }
  if (candidate.recipientPaneId !== undefined && typeof candidate.recipientPaneId !== "string") {
    throw new AttachmentStoreError("ATTACHMENT_STORE_FAILED", "Attachment metadata is incompatible", { operation: "read_metadata", path: safePath(path) });
  }
  if (candidate.recipientAgentName !== undefined && typeof candidate.recipientAgentName !== "string") {
    throw new AttachmentStoreError("ATTACHMENT_STORE_FAILED", "Attachment metadata is incompatible", { operation: "read_metadata", path: safePath(path) });
  }
  return {
    attachmentId,
    bytes,
    sha256,
    encoding,
    createdAt,
    expiresAt,
    senderPaneId,
    senderDisplay,
    ...(candidate.recipientPaneId === undefined ? {} : { recipientPaneId: candidate.recipientPaneId }),
    ...(candidate.recipientAgentName === undefined ? {} : { recipientAgentName: candidate.recipientAgentName }),
    operation: operation as AttachmentMetadata["operation"]
  };
}

function isTemporaryDirectory(name: string): boolean {
  return name.startsWith(".tmp-");
}

function storeFailure(operation: string, path: string, error: unknown): AttachmentStoreError {
  if (error instanceof AttachmentStoreError) return error;
  const causeCode = errorCode(error);
  return new AttachmentStoreError("ATTACHMENT_STORE_FAILED", "Attachment store operation failed", {
    operation,
    path: safePath(path),
    ...(typeof causeCode === "string" ? { causeCode } : {})
  });
}

export function createAttachmentStore(io: AttachmentStoreIo = nodeAttachmentStoreIo, rootDirectory = DEFAULT_ATTACHMENT_STORE_ROOT, now: () => Date = () => new Date()): AttachmentStore {
  const root = resolve(rootDirectory);

  const recipientDirectory = (recipientKey: string): string => {
    validateKey(recipientKey);
    return join(root, recipientKey);
  };

  const ensureRoot = async (): Promise<void> => {
    try {
      await io.mkdir(root, { recursive: true, mode: 0o700 });
      await io.chmod(root, 0o700);
    } catch (error) {
      throw storeFailure("ensure_root", root, error);
    }
  };

  const ensureRecipient = async (recipientKey: string): Promise<string> => {
    const directory = recipientDirectory(recipientKey);
    await ensureRoot();
    try {
      await io.mkdir(directory, { recursive: true, mode: 0o700 });
      await io.chmod(directory, 0o700);
      return directory;
    } catch (error) {
      throw storeFailure("ensure_recipient", directory, error);
    }
  };

  const readLiveRecords = async (): Promise<LiveRecord[]> => {
    let recipients: readonly AttachmentDirEntry[];
    try {
      recipients = await io.readdir(root);
    } catch (error) {
      throw storeFailure("list_recipients", root, error);
    }
    const records: LiveRecord[] = [];
    for (const recipient of recipients) {
      if (!recipient.isDirectory() || isTemporaryDirectory(recipient.name)) continue;
      const recipientPath = join(root, recipient.name);
      let attachments: readonly AttachmentDirEntry[];
      try {
        attachments = await io.readdir(recipientPath);
      } catch (error) {
        throw storeFailure("list_attachments", recipientPath, error);
      }
      for (const attachment of attachments) {
        if (!attachment.isDirectory() || isTemporaryDirectory(attachment.name)) continue;
        const attachmentPath = join(recipientPath, attachment.name);
        const metadataPath = join(attachmentPath, "meta.json");
        try {
          const metadata = parsedMetadata(await io.readFile(metadataPath), metadataPath);
          records.push({ path: attachmentPath, metadata });
        } catch (error) {
          throw storeFailure("read_metadata", metadataPath, error);
        }
      }
    }
    return records;
  };

  const sweep = async (): Promise<void> => {
    const current = now().getTime();
    const records = await readLiveRecords();
    const touchedRecipients = new Set<string>();
    for (const record of records) {
      const expiry = Date.parse(record.metadata.expiresAt);
      if (!Number.isFinite(expiry)) throw new AttachmentStoreError("ATTACHMENT_STORE_FAILED", "Attachment expiry is invalid", { operation: "sweep", path: safePath(record.path) });
      if (expiry <= current) {
        touchedRecipients.add(resolve(record.path, ".."));
        try {
          await io.rm(record.path, { force: true, recursive: true });
        } catch (error) {
          throw storeFailure("sweep", record.path, error);
        }
      }
    }
    const recipients = await io.readdir(root).catch((error: unknown) => { throw storeFailure("list_recipients", root, error); });
    for (const recipient of recipients) {
      if (!recipient.isDirectory() || isTemporaryDirectory(recipient.name)) continue;
      const recipientPath = join(root, recipient.name);
      const entries = await io.readdir(recipientPath).catch((error: unknown) => { throw storeFailure("list_attachments", recipientPath, error); });
      if (entries.length === 0 || touchedRecipients.has(recipientPath) && entries.every((entry) => isTemporaryDirectory(entry.name))) {
        try {
          await io.rm(recipientPath, { force: true, recursive: true });
        } catch (error) {
          throw storeFailure("sweep", recipientPath, error);
        }
      }
    }
  };

  const publish = async (input: AttachmentPublishInput): Promise<PublishedAttachment> => {
    const data = validateBody(input.body);
    validateKey(input.recipientKey);
    if (input.recipientPaneId !== undefined && (input.recipientPaneId.length === 0 || /[\0\r\n]/.test(input.recipientPaneId))) throw new AttachmentStoreError("ATTACHMENT_STORE_FAILED", "Attachment recipient pane ID is invalid", { operation: "validate_recipient" });
    const created = now();
    const expires = new Date(created.getTime() + ATTACHMENT_RETENTION_HOURS * 60 * 60 * 1_000);
    const attachmentId = randomUUID();
    const digest = createHash("sha256").update(data).digest("hex");
    await ensureRoot();
    try {
      await sweep();
      const live = await readLiveRecords();
      const liveBytes = live.reduce((total, item) => total + item.metadata.bytes, 0);
      if (live.length >= ATTACHMENT_STORE_MAX_RECORDS || liveBytes + data.byteLength > ATTACHMENT_STORE_QUOTA_BYTES) {
        throw new AttachmentStoreError("ATTACHMENT_QUOTA_EXCEEDED", "Attachment store quota is exhausted", {
          operation: "quota",
          bytes: liveBytes,
          records: live.length,
          requestedBytes: data.byteLength,
          limitBytes: ATTACHMENT_STORE_QUOTA_BYTES,
          limitRecords: ATTACHMENT_STORE_MAX_RECORDS
        });
      }
      const recipientPath = await ensureRecipient(input.recipientKey);
      const finalPath = join(recipientPath, attachmentId);
      const temporaryPath = await io.mkdtemp(join(recipientPath, ".tmp-"));
      const bodyPath = join(temporaryPath, "body.txt");
      const metadataPath = join(temporaryPath, "meta.json");
      const metadata: AttachmentMetadata = {
        attachmentId,
        bytes: data.byteLength,
        sha256: digest,
        encoding: "utf-8",
        createdAt: created.toISOString(),
        expiresAt: expires.toISOString(),
        senderPaneId: input.senderPaneId,
        senderDisplay: input.senderDisplay,
        ...(input.recipientPaneId === undefined ? {} : { recipientPaneId: input.recipientPaneId }),
        ...(input.recipientAgentName === undefined ? {} : { recipientAgentName: input.recipientAgentName }),
        operation: input.operation
      };
      try {
        await io.chmod(temporaryPath, 0o700);
        await io.writeFile(bodyPath, data, { mode: 0o600 });
        await io.chmod(bodyPath, 0o600);
        await io.writeFile(metadataPath, Buffer.from(JSON.stringify(metadata), "utf8"), { mode: 0o600 });
        await io.chmod(metadataPath, 0o600);
        await io.rename(temporaryPath, finalPath);
      } catch (error) {
        try { await io.rm(temporaryPath, { force: true, recursive: true }); } catch { /* preserve the publication error */ }
        throw storeFailure("publish", finalPath, error);
      }
      return { attachmentId, path: join(finalPath, "body.txt"), bytes: data.byteLength, sha256: digest, expiresAt: expires.toISOString(), ...(input.recipientPaneId === undefined ? {} : { recipientPaneId: input.recipientPaneId }) };
    } catch (error) {
      throw storeFailure("publish", root, error);
    }
  };

  return { root, recipientDirectory, ensureRecipient, publish };
}

export const defaultAttachmentStore = createAttachmentStore();

export function attachmentMetadataBytes(metadata: AttachmentMetadata): number {
  return utf8Bytes(JSON.stringify(metadata));
}
