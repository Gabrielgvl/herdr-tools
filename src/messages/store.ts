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
  stat(path: string): Promise<{ mtimeMs: number }>;
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
  readdir: async (path) => fs.readdir(path, { withFileTypes: true }),
  stat: async (path) => ({ mtimeMs: (await fs.stat(path)).mtimeMs })
};

/** Serializing lock directory; every mutating store phase runs while it is held. */
export const ATTACHMENT_LOCK_NAME = ".lock";
export const DEFAULT_LOCK_RETRY_MS = 25;
export const DEFAULT_LOCK_ATTEMPTS = 200;
export const DEFAULT_LOCK_STALE_MS = 30_000;
/** An empty recipient directory is a live launch grant until it is this old. */
export const EMPTY_RECIPIENT_GRACE_MS = 60_000;

export interface AttachmentStoreOptions {
  sleep?: (ms: number) => Promise<void>;
  lockRetryMs?: number;
  lockAttempts?: number;
  lockStaleMs?: number;
}

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

interface StoreScan {
  records: LiveRecord[];
  staging: string[];
  incomplete: string[];
  recipients: Array<{ path: string; entries: number }>;
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

function isReserved(name: string): boolean {
  return name === ATTACHMENT_LOCK_NAME;
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

export function createAttachmentStore(io: AttachmentStoreIo = nodeAttachmentStoreIo, rootDirectory = DEFAULT_ATTACHMENT_STORE_ROOT, now: () => Date = () => new Date(), options: AttachmentStoreOptions = {}): AttachmentStore {
  const root = resolve(rootDirectory);
  const lockPath = join(root, ATTACHMENT_LOCK_NAME);
  const lockRetryMs = options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS;
  const lockAttempts = options.lockAttempts ?? DEFAULT_LOCK_ATTEMPTS;
  const lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));

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

  const list = async (path: string, operation: string): Promise<readonly AttachmentDirEntry[]> => {
    try {
      return await io.readdir(path);
    } catch (error) {
      throw storeFailure(operation, path, error);
    }
  };

  const remove = async (path: string, operation: string): Promise<void> => {
    try {
      await io.rm(path, { force: true, recursive: true });
    } catch (error) {
      throw storeFailure(operation, path, error);
    }
  };

  /**
   * One traversal of the store. Staging directories and attachment directories without
   * readable metadata are reported separately so the caller can purge them before any
   * quota decision uses their bytes.
   */
  const scan = async (): Promise<StoreScan> => {
    const result: StoreScan = { records: [], staging: [], incomplete: [], recipients: [] };
    for (const recipient of await list(root, "list_recipients")) {
      if (!recipient.isDirectory() || isReserved(recipient.name)) continue;
      const recipientPath = join(root, recipient.name);
      if (isTemporaryDirectory(recipient.name)) {
        result.staging.push(recipientPath);
        continue;
      }
      const attachments = await list(recipientPath, "list_attachments");
      result.recipients.push({ path: recipientPath, entries: attachments.length });
      for (const attachment of attachments) {
        if (!attachment.isDirectory()) continue;
        const attachmentPath = join(recipientPath, attachment.name);
        if (isTemporaryDirectory(attachment.name)) {
          result.staging.push(attachmentPath);
          continue;
        }
        const metadataPath = join(attachmentPath, "meta.json");
        let raw: Uint8Array;
        try {
          raw = await io.readFile(metadataPath);
        } catch (error) {
          if (errorCode(error) === "ENOENT") {
            result.incomplete.push(attachmentPath);
            continue;
          }
          throw storeFailure("read_metadata", metadataPath, error);
        }
        result.records.push({ path: attachmentPath, metadata: parsedMetadata(raw, metadataPath) });
      }
    }
    return result;
  };

  const acquireLock = async (): Promise<void> => {
    for (let attempt = 0; attempt < lockAttempts; attempt += 1) {
      try {
        await io.mkdir(lockPath, { recursive: false, mode: 0o700 });
        return;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw storeFailure("lock", lockPath, error);
      }
      let heldSinceMs: number | undefined;
      try {
        heldSinceMs = (await io.stat(lockPath)).mtimeMs;
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw storeFailure("lock", lockPath, error);
      }
      if (heldSinceMs !== undefined && now().getTime() - heldSinceMs >= lockStaleMs) {
        await remove(lockPath, "lock");
        continue;
      }
      await sleep(lockRetryMs);
    }
    throw new AttachmentStoreError("ATTACHMENT_STORE_FAILED", "Attachment store lock is unavailable", { operation: "lock", path: safePath(lockPath), attempts: lockAttempts });
  };

  const releaseLock = async (): Promise<void> => {
    try {
      await io.rm(lockPath, { force: true, recursive: true });
    } catch {
      // Preserve the publication outcome; a retained lock is reclaimed as stale.
    }
  };

  /** Purge abandoned staging and metadata-less records, then delete expired records. */
  const reclaim = async (): Promise<StoreScan> => {
    const initial = await scan();
    for (const path of initial.staging) await remove(path, "purge_staging");
    for (const path of initial.incomplete) await remove(path, "purge_incomplete");
    const current = now().getTime();
    for (const record of initial.records) {
      const expiry = Date.parse(record.metadata.expiresAt);
      if (!Number.isFinite(expiry)) throw new AttachmentStoreError("ATTACHMENT_STORE_FAILED", "Attachment expiry is invalid", { operation: "sweep", path: safePath(record.path) });
      if (expiry <= current) await remove(record.path, "sweep");
    }
    const remaining = await scan();
    for (const recipient of remaining.recipients) {
      if (recipient.entries > 0) continue;
      let mtimeMs: number | undefined;
      try {
        mtimeMs = (await io.stat(recipient.path)).mtimeMs;
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw storeFailure("sweep", recipient.path, error);
      }
      if (mtimeMs !== undefined && now().getTime() - mtimeMs >= EMPTY_RECIPIENT_GRACE_MS) await remove(recipient.path, "sweep");
    }
    return remaining;
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
    await acquireLock();
    try {
      const live = await reclaim();
      const liveBytes = live.records.reduce((total, item) => total + item.metadata.bytes, 0);
      if (live.records.length >= ATTACHMENT_STORE_MAX_RECORDS || liveBytes + data.byteLength > ATTACHMENT_STORE_QUOTA_BYTES) {
        throw new AttachmentStoreError("ATTACHMENT_QUOTA_EXCEEDED", "Attachment store quota is exhausted", {
          operation: "quota",
          bytes: liveBytes,
          records: live.records.length,
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
    } finally {
      await releaseLock();
    }
  };

  return { root, recipientDirectory, ensureRecipient, publish };
}

export const defaultAttachmentStore = createAttachmentStore();

export function attachmentMetadataBytes(metadata: AttachmentMetadata): number {
  return utf8Bytes(JSON.stringify(metadata));
}
