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
export const ATTACHMENT_LOCK_OWNER_FILE = "owner.json";
/** Marker naming an in-progress launch grant for a recipient directory. */
export const ATTACHMENT_GRANT_NAME = ".grant.json";
export const DEFAULT_LOCK_RETRY_MS = 25;
export const DEFAULT_LOCK_ATTEMPTS = 200;
/** A held lock is only reclaimable once its owner stops renewing for this long. */
export const DEFAULT_LOCK_LEASE_MS = 30_000;
/** A launch grant outlives the 120 s agent-start window and is renewed per phase. */
export const DEFAULT_GRANT_LEASE_MS = 300_000;

export interface AttachmentStoreOptions {
  sleep?: (ms: number) => Promise<void>;
  lockRetryMs?: number;
  lockAttempts?: number;
  lockLeaseMs?: number;
  grantLeaseMs?: number;
}

/** An owned lease over the store lock. Every mutation validates it before committing. */
export interface StoreLease {
  readonly token: string;
  renew(): Promise<void>;
  validate(): Promise<void>;
  release(): Promise<void>;
}

/** An owned lease over a recipient directory created for an in-progress launch. */
export interface RecipientGrant {
  readonly path: string;
  readonly token: string;
  renew(): Promise<void>;
  release(): Promise<void>;
}

interface LeaseRecord {
  token: string;
  acquiredAt: string;
  renewedAt: string;
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
  /** When present, publication refuses a recipient-key directory mismatch. */
  expectedRecipientDirectory?: string;
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

export function publishedAttachmentMatchesDirectory(attachment: PublishedAttachment, directory: string): boolean {
  return validKey(attachment.attachmentId)
    && resolve(directory) === directory
    && attachment.path === join(directory, attachment.attachmentId, "body.txt");
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
  ensureRecipient(recipientKey: string): Promise<RecipientGrant>;
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
  recipients: Array<{ path: string; entries: number; grant?: ObservedLease }>;
}

interface ObservedLease {
  token: string;
  renewedAtMs: number;
}

function errorCode(error: unknown): unknown {
  return error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
}

function leaseRecord(token: string, acquiredAt: string, renewedAt: string): Buffer {
  const record: LeaseRecord = { token, acquiredAt, renewedAt };
  return Buffer.from(JSON.stringify(record), "utf8");
}

/** Parse a lease marker. An unparseable marker is reported as absent, never as live. */
function parsedLease(value: Uint8Array): ObservedLease | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value).toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const candidate = parsed as Record<string, unknown>;
  const renewedAtMs = typeof candidate.renewedAt === "string" ? Date.parse(candidate.renewedAt) : Number.NaN;
  if (typeof candidate.token !== "string" || candidate.token.length === 0 || !Number.isFinite(renewedAtMs)) return undefined;
  return { token: candidate.token, renewedAtMs };
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
  const lockLeaseMs = options.lockLeaseMs ?? DEFAULT_LOCK_LEASE_MS;
  const grantLeaseMs = options.grantLeaseMs ?? DEFAULT_GRANT_LEASE_MS;
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

  const ensureRecipientDirectory = async (recipientKey: string): Promise<string> => {
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

  /**
   * A launch needs its recipient directory to exist before the agent starts, which can
   * take minutes. The grant marker is an owned lease: sweeping skips a directory whose
   * grant is live, and only an abandoned lease is reclaimed.
   */
  const ensureRecipient = async (recipientKey: string): Promise<RecipientGrant> => {
    const directory = await ensureRecipientDirectory(recipientKey);
    const grantPath = join(directory, ATTACHMENT_GRANT_NAME);
    const token = randomUUID();
    const acquiredAt = now().toISOString();
    await writeLease(grantPath, token, acquiredAt, "ensure_recipient");
    return {
      path: directory,
      token,
      renew: async () => {
        const current = await observeLease(grantPath);
        if (current !== undefined && current.token !== token) throw leaseLost(grantPath, "grant_renew");
        await writeLease(grantPath, token, acquiredAt, "grant_renew");
      },
      release: async () => {
        try {
          const current = await observeLease(grantPath);
          if (current?.token !== token) return;
          await io.rm(grantPath, { force: true, recursive: false });
        } catch {
          // An unreleased grant expires on its own; never fail the caller's operation.
        }
      }
    };
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
      const grant = attachments.some((entry) => entry.name === ATTACHMENT_GRANT_NAME)
        ? await observeLease(join(recipientPath, ATTACHMENT_GRANT_NAME))
        : undefined;
      result.recipients.push({
        path: recipientPath,
        entries: attachments.filter((entry) => entry.name !== ATTACHMENT_GRANT_NAME).length,
        ...(grant ? { grant } : {})
      });
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

  const observeLease = async (path: string): Promise<ObservedLease | undefined> => {
    try {
      return parsedLease(await io.readFile(path));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw storeFailure("lock", path, error);
    }
  };

  const writeLease = async (path: string, token: string, acquiredAt: string, operation: string): Promise<void> => {
    try {
      await io.writeFile(path, leaseRecord(token, acquiredAt, now().toISOString()), { mode: 0o600 });
      await io.chmod(path, 0o600);
    } catch (error) {
      throw storeFailure(operation, path, error);
    }
  };

  const leaseLost = (path: string, operation: string): AttachmentStoreError =>
    new AttachmentStoreError("ATTACHMENT_STORE_FAILED", "Attachment store lease is no longer owned", { operation, path: safePath(path) });

  /**
   * A held lock is reclaimed only when its owner has stopped renewing for a full lease
   * and the same owner token is still present on a second read. The owner validates its
   * own lease before committing, so a reclaimed publication aborts instead of racing.
   */
  const acquireLock = async (): Promise<StoreLease> => {
    const ownerPath = join(lockPath, ATTACHMENT_LOCK_OWNER_FILE);
    for (let attempt = 0; attempt < lockAttempts; attempt += 1) {
      let held = false;
      try {
        await io.mkdir(lockPath, { recursive: false, mode: 0o700 });
        held = true;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw storeFailure("lock", lockPath, error);
      }
      if (held) {
        const token = randomUUID();
        const acquiredAt = now().toISOString();
        await writeLease(ownerPath, token, acquiredAt, "lock");
        const owned = async (operation: string): Promise<void> => {
          const current = await observeLease(ownerPath);
          if (current?.token !== token) throw leaseLost(lockPath, operation);
        };
        return {
          token,
          renew: async () => {
            await owned("lock_renew");
            await writeLease(ownerPath, token, acquiredAt, "lock_renew");
          },
          validate: () => owned("lock_validate"),
          release: async () => {
            try {
              const current = await observeLease(ownerPath);
              if (current?.token !== token) return;
              await io.rm(lockPath, { force: true, recursive: true });
            } catch {
              // Preserve the publication outcome; an abandoned lease is reclaimed later.
            }
          }
        };
      }
      const observed = await observeLease(ownerPath);
      const expired = observed === undefined
        ? await lockDirectoryAbandoned()
        : now().getTime() - observed.renewedAtMs >= lockLeaseMs;
      if (expired) {
        const confirmed = await observeLease(ownerPath);
        if (confirmed?.token === observed?.token) {
          await remove(lockPath, "lock");
          continue;
        }
      }
      await sleep(lockRetryMs);
    }
    throw new AttachmentStoreError("ATTACHMENT_STORE_FAILED", "Attachment store lock is unavailable", { operation: "lock", path: safePath(lockPath), attempts: lockAttempts });
  };

  /** A lock whose owner file never appeared is only abandoned once the directory ages out. */
  const lockDirectoryAbandoned = async (): Promise<boolean> => {
    try {
      return now().getTime() - (await io.stat(lockPath)).mtimeMs >= lockLeaseMs;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw storeFailure("lock", lockPath, error);
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
      // A live launch grant keeps its directory even when it holds no attachment yet.
      if (recipient.grant !== undefined && now().getTime() - recipient.grant.renewedAtMs < grantLeaseMs) continue;
      await remove(recipient.path, "sweep");
    }
    return remaining;
  };

  const publish = async (input: AttachmentPublishInput): Promise<PublishedAttachment> => {
    const data = validateBody(input.body);
    validateKey(input.recipientKey);
    const expectedRecipientPath = recipientDirectory(input.recipientKey);
    if (input.expectedRecipientDirectory !== undefined && input.expectedRecipientDirectory !== expectedRecipientPath) {
      throw new AttachmentStoreError("ATTACHMENT_STORE_FAILED", "Attachment recipient directory does not match its key", { operation: "validate_recipient" });
    }
    if (input.recipientPaneId !== undefined && (input.recipientPaneId.length === 0 || /[\0\r\n]/.test(input.recipientPaneId))) throw new AttachmentStoreError("ATTACHMENT_STORE_FAILED", "Attachment recipient pane ID is invalid", { operation: "validate_recipient" });
    const created = now();
    const expires = new Date(created.getTime() + ATTACHMENT_RETENTION_HOURS * 60 * 60 * 1_000);
    const attachmentId = randomUUID();
    const digest = createHash("sha256").update(data).digest("hex");
    await ensureRoot();
    const lease = await acquireLock();
    try {
      const live = await reclaim();
      await lease.renew();
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
      const recipientPath = await ensureRecipientDirectory(input.recipientKey);
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
        // Commit only while the lease is still owned; a reclaimed lock aborts instead.
        await lease.validate();
        await io.rename(temporaryPath, finalPath);
      } catch (error) {
        try { await io.rm(temporaryPath, { force: true, recursive: true }); } catch { /* preserve the publication error */ }
        throw storeFailure("publish", finalPath, error);
      }
      return { attachmentId, path: join(finalPath, "body.txt"), bytes: data.byteLength, sha256: digest, expiresAt: expires.toISOString(), ...(input.recipientPaneId === undefined ? {} : { recipientPaneId: input.recipientPaneId }) };
    } catch (error) {
      throw storeFailure("publish", root, error);
    } finally {
      await lease.release();
    }
  };

  return { root, recipientDirectory, ensureRecipient, publish };
}

export const defaultAttachmentStore = createAttachmentStore();

export function attachmentMetadataBytes(metadata: AttachmentMetadata): number {
  return utf8Bytes(JSON.stringify(metadata));
}
