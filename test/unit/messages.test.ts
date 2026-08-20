import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_RETENTION_HOURS, ATTACHMENT_STORE_MAX_RECORDS, ATTACHMENT_STORE_QUOTA_BYTES, MESSAGE_INLINE_MAX_BYTES, assertDeliverySize, assertMessageText } from "../../src/messages/limits.js";
import { RecipientRegistry, mintRecipientKey, recipientIdentity, verifyRecipient } from "../../src/messages/recipients.js";
import { attachmentCapability } from "../../src/profiles/capability.js";
import { attachmentMetadataBytes, createAttachmentStore, type AttachmentDirEntry, type AttachmentStoreIo } from "../../src/messages/store.js";
import type { HerdrSnapshot } from "../../src/targets.js";
import type { Profile } from "../../src/profiles/types.js";

const snapshot: HerdrSnapshot = {
  version: "0.8.0",
  protocol: 19,
  workspaces: [],
  tabs: [],
  panes: [{ pane_id: "w:p1", tab_id: "w:t1", workspace_id: "w1", agent_name: "worker", agent_id: "agent-1" }],
  agents: [{ pane_id: "w:p1", name: "worker", agent_id: "agent-1" }]
};

function profile(kind: "pi" | "claude", overrides: Partial<Profile["runtime"]> = {}): Profile {
  const runtime = kind === "pi"
    ? { kind: "pi" as const, model: "test", thinking: "low" as const, tools: [], extensions: [], skills: [], ...overrides }
    : { kind: "claude" as const, model: "test", effort: "medium" as const, permissionMode: "default" as const, allowedTools: [], disallowedTools: [], addDirs: [], pluginDirs: [], ...overrides };
  return {
    name: `${kind}-profile`, description: "profile", timeoutMinutes: 1, sessionPersistence: kind === "claude", runtime: runtime as Profile["runtime"], fallbackProfiles: [], body: "body", source: { kind: "bundled", path: `/profiles/${kind}.md`, scopeRoot: "/profiles", precedence: 0 }
  };
}

function ioWith(overrides: Partial<AttachmentStoreIo> = {}): AttachmentStoreIo {
  return {
    mkdir: vi.fn(async () => undefined),
    mkdtemp: vi.fn(async (prefix: string) => `${prefix}stage`),
    readFile: vi.fn(async () => Buffer.from("{}")),
    writeFile: vi.fn(async () => undefined),
    chmod: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
    readdir: vi.fn(async () => [] as readonly AttachmentDirEntry[]),
    ...overrides
  };
}

function entry(name: string, directory = true): AttachmentDirEntry {
  return { name, isDirectory: () => directory };
}

describe("large message limits and recipient capabilities", () => {
  it("enforces text and route bounds", () => {
    expect(() => assertMessageText("")).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => assertMessageText("bad\0text")).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => assertMessageText(12)).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => assertDeliverySize("x".repeat(MESSAGE_INLINE_MAX_BYTES + 1), "inline")).toThrowError(expect.objectContaining({ code: "PAYLOAD_TOO_LARGE_FOR_INLINE" }));
    expect(() => assertDeliverySize("x".repeat(ATTACHMENT_MAX_BYTES + 1), "attachment")).toThrowError(expect.objectContaining({ code: "PAYLOAD_TOO_LARGE" }));
    expect(() => assertDeliverySize("ok", "inline")).not.toThrow();
    expect(() => assertDeliverySize("ok", "attachment")).not.toThrow();
  });

  it("derives Pi and Claude read capabilities without inferring from kind", () => {
    expect(attachmentCapability(profile("pi"))).toMatchObject({ kind: "pi", capable: true });
    expect(attachmentCapability(profile("pi", { tools: ["bash"] }))).toMatchObject({ capable: false });
    expect(attachmentCapability(profile("pi", { tools: ["read", "bash"] }))).toMatchObject({ capable: true });
    expect(attachmentCapability(profile("claude"))).toMatchObject({ kind: "claude", capable: true });
    expect(attachmentCapability(profile("claude", { disallowedTools: ["Read"] }))).toMatchObject({ capable: false });
    expect(attachmentCapability(profile("claude", { allowedTools: ["Bash"] }))).toMatchObject({ capable: false });
    expect(attachmentCapability(profile("claude", { allowedTools: ["Read"] }))).toMatchObject({ capable: true });
  });

  it("tracks runtime-only recipient identities and resets them", () => {
    const registry = new RecipientRegistry();
    const capability = attachmentCapability(profile("pi"));
    const key = mintRecipientKey();
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    const record = registry.recordFor("pi-profile", "w:p1", key, capability, { agentName: "worker", agentId: "agent-1" });
    expect(registry.size).toBe(1);
    expect(registry.get("w:p1")).toEqual(record);
    expect(registry.get("missing")).toBeUndefined();
    expect(verifyRecipient(snapshot, record)).toMatchObject({ verified: true, identity: { agentName: "worker", agentId: "agent-1" } });
    expect(verifyRecipient(snapshot, { ...record, capable: false, reason: "restricted" })).toMatchObject({ verified: false, reason: "restricted" });
    expect(verifyRecipient(snapshot, { ...record, agentId: "different" })).toMatchObject({ verified: false });
    expect(verifyRecipient(snapshot, undefined)).toMatchObject({ verified: false, identity: {} });
    expect(recipientIdentity(snapshot, "missing")).toEqual({});
    registry.reset();
    expect(registry.size).toBe(0);
  });
});

describe("attachment store", () => {
  it("atomically publishes exact owner-only UTF-8 content and metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-attachments-"));
    try {
      let now = new Date("2026-08-20T12:00:00.000Z");
      const store = createAttachmentStore(undefined, root, () => now);
      const key = "recipient-key";
      const directory = await store.ensureRecipient(key);
      const body = "large\n☃";
      const published = await store.publish({ body, recipientKey: key, recipientPaneId: "w:p1", recipientAgentName: "worker", senderPaneId: "w:p0", senderDisplay: "caller", operation: "prompt" });
      expect(published).toMatchObject({ bytes: Buffer.byteLength(body), recipientPaneId: "w:p1", path: join(directory, published.attachmentId, "body.txt") });
      expect(await readFile(published.path, "utf8")).toBe(body);
      const metadata = JSON.parse(await readFile(join(directory, published.attachmentId, "meta.json"), "utf8")) as Record<string, unknown>;
      expect(metadata).toMatchObject({ attachmentId: published.attachmentId, bytes: published.bytes, sha256: published.sha256, encoding: "utf-8", senderPaneId: "w:p0", recipientPaneId: "w:p1", operation: "prompt" });
      expect(JSON.stringify(metadata)).not.toContain(body);
      expect((await stat(root)).mode & 0o777).toBe(0o700);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(published.path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(directory, published.attachmentId, "meta.json"))).mode & 0o777).toBe(0o600);
      now = new Date(now.getTime() + ATTACHMENT_RETENTION_HOURS * 60 * 60 * 1_000 + 1);
      const fresh = await store.publish({ body: "fresh", recipientKey: key, senderPaneId: "w:p0", senderDisplay: "caller", operation: "assignment" });
      await expect(stat(published.path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(fresh.expiresAt).toBe("2026-08-22T12:00:00.001Z");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid keys, bodies, and quota without deleting live records", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-attachments-invalid-"));
    try {
      const store = createAttachmentStore(undefined, root);
      await expect(store.ensureRecipient("bad/key")).rejects.toMatchObject({ code: "ATTACHMENT_STORE_FAILED" });
      await expect(store.publish({ body: "", recipientKey: "recipient-key", senderPaneId: "p", senderDisplay: "s", operation: "prompt" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(store.publish({ body: "bad\0body", recipientKey: "recipient-key", senderPaneId: "p", senderDisplay: "s", operation: "prompt" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(store.publish({ body: "x".repeat(ATTACHMENT_MAX_BYTES + 1), recipientKey: "recipient-key", senderPaneId: "p", senderDisplay: "s", operation: "prompt" })).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
      const fake = ioWith({ readdir: vi.fn(async () => { throw Object.assign(new Error("unavailable"), { code: "EACCES" }); }) });
      const quota = createAttachmentStore(fake, "/cache");
      await expect(quota.publish({ body: "x", recipientKey: "recipient-key", senderPaneId: "p", senderDisplay: "s", operation: "prompt" })).rejects.toMatchObject({ code: "ATTACHMENT_STORE_FAILED" });
      const entries = Array.from({ length: ATTACHMENT_STORE_MAX_RECORDS }, (_, index) => entry(`record-${index}`));
      const metadata = JSON.stringify({ attachmentId: "record-00000000", bytes: 1, sha256: "0".repeat(64), encoding: "utf-8", createdAt: "2026-08-20T00:00:00.000Z", expiresAt: "2999-08-20T00:00:00.000Z", senderPaneId: "p", senderDisplay: "s", operation: "prompt" });
      const recordIo = ioWith({
        readdir: vi.fn(async (path: string) => path === "/cache" ? [entry("recipient-key")] : entries),
        readFile: vi.fn(async () => Buffer.from(metadata))
      });
      const recordStore = createAttachmentStore(recordIo, "/cache");
      await expect(recordStore.publish({ body: "x", recipientKey: "recipient-key", senderPaneId: "p", senderDisplay: "s", operation: "prompt" })).rejects.toMatchObject({ code: "ATTACHMENT_QUOTA_EXCEEDED" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports sweep and publication failures without exposing body text", async () => {
    const failingRead = ioWith({ readdir: vi.fn(async () => [entry("recipient-key")]), readFile: vi.fn(async () => { throw new Error("metadata unavailable"); }) });
    const store = createAttachmentStore(failingRead, "/cache");
    await expect(store.publish({ body: "secret body", recipientKey: "recipient-key", senderPaneId: "p", senderDisplay: "s", operation: "prompt" })).rejects.toMatchObject({ code: "ATTACHMENT_STORE_FAILED", details: { operation: "read_metadata" } });

    const failingWrite = ioWith({ readdir: vi.fn(async () => []), writeFile: vi.fn(async () => { throw new Error("write failed"); }) });
    const writeStore = createAttachmentStore(failingWrite, "/cache");
    await expect(writeStore.publish({ body: "secret body", recipientKey: "recipient-key", senderPaneId: "p", senderDisplay: "s", operation: "prompt" })).rejects.toMatchObject({ code: "ATTACHMENT_STORE_FAILED", details: { operation: "publish" } });
    expect(JSON.stringify((failingWrite.writeFile as ReturnType<typeof vi.fn>).mock.calls)).not.toContain("secret body");

    const failingSweep = ioWith({ readdir: vi.fn(async () => [entry("recipient-key")]), readFile: vi.fn(async () => Buffer.from(JSON.stringify({ attachmentId: "record-00000000", bytes: 1, sha256: "0".repeat(64), encoding: "utf-8", createdAt: "bad", expiresAt: "bad", senderPaneId: "p", senderDisplay: "s", operation: "prompt" }))) });
    const sweepStore = createAttachmentStore(failingSweep, "/cache");
    await expect(sweepStore.publish({ body: "body", recipientKey: "recipient-key", senderPaneId: "p", senderDisplay: "s", operation: "prompt" })).rejects.toMatchObject({ code: "ATTACHMENT_STORE_FAILED" });

    expect(ATTACHMENT_STORE_QUOTA_BYTES).toBe(64 * 1024 * 1024);
    expect(attachmentMetadataBytes({ attachmentId: "record-00000000", bytes: 1, sha256: "0".repeat(64), encoding: "utf-8", createdAt: "2026-08-20T00:00:00.000Z", expiresAt: "2999-08-20T00:00:00.000Z", senderPaneId: "p", senderDisplay: "s", operation: "prompt" })).toBeGreaterThan(0);
  });

  it("fails closed for malformed metadata and every storage boundary", async () => {
    const validMetadata = {
      attachmentId: "record-00000000",
      bytes: 1,
      sha256: "0".repeat(64),
      encoding: "utf-8",
      createdAt: "2026-08-20T00:00:00.000Z",
      expiresAt: "2999-08-20T00:00:00.000Z",
      senderPaneId: "p",
      senderDisplay: "s",
      operation: "prompt"
    };
    const metadataCases: Uint8Array[] = [
      Buffer.from("not json"),
      Buffer.from("[]"),
      Buffer.from(JSON.stringify({ ...validMetadata, bytes: 0 })),
      Buffer.from(JSON.stringify({ ...validMetadata, recipientPaneId: 4 })),
      Buffer.from(JSON.stringify({ ...validMetadata, recipientAgentName: 4 }))
    ];
    for (const metadata of metadataCases) {
      const io = ioWith({
        readdir: vi.fn(async (path: string) => path === "/cache" ? [entry("recipient-key")] : [entry("attachment-1")]),
        readFile: vi.fn(async () => metadata)
      });
      await expect(createAttachmentStore(io, "/cache").publish({ body: "body", recipientKey: "recipient-key", senderPaneId: "p", senderDisplay: "s", operation: "prompt" })).rejects.toMatchObject({ code: "ATTACHMENT_STORE_FAILED" });
    }
    const longName = "r".repeat(600);
    const longPathIo = ioWith({ readdir: vi.fn(async (path: string) => path === "/cache" ? [entry(longName)] : [entry("attachment-1")]), readFile: vi.fn(async () => Buffer.from("not json")) });
    await expect(createAttachmentStore(longPathIo, "/cache").publish({ body: "body", recipientKey: "recipient-key", senderPaneId: "p", senderDisplay: "s", operation: "prompt" })).rejects.toMatchObject({ details: { path: "[path omitted]" } });

    const rootFailure = ioWith({ mkdir: vi.fn(async () => { throw Object.assign(new Error("root"), { code: "EACCES" }); }) });
    await expect(createAttachmentStore(rootFailure, "/cache").publish({ body: "body", recipientKey: "recipient-key", senderPaneId: "p", senderDisplay: "s", operation: "prompt" })).rejects.toMatchObject({ details: { operation: "ensure_root", causeCode: "EACCES" } });

    const recipientFailure = ioWith({ mkdir: vi.fn(async (path: string) => { if (path === "/cache/recipient-key") throw new Error("recipient"); }) });
    await expect(createAttachmentStore(recipientFailure, "/cache").publish({ body: "body", recipientKey: "recipient-key", senderPaneId: "p", senderDisplay: "s", operation: "prompt" })).rejects.toMatchObject({ details: { operation: "ensure_recipient" } });

    const listFailure = ioWith({ readdir: vi.fn(async (path: string) => path === "/cache" ? [entry("recipient-key")] : (() => { throw new Error("list"); })()) });
    await expect(createAttachmentStore(listFailure, "/cache").publish({ body: "body", recipientKey: "recipient-key", senderPaneId: "p", senderDisplay: "s", operation: "prompt" })).rejects.toMatchObject({ details: { operation: "list_attachments" } });

    const skipIo = ioWith({ readdir: vi.fn(async (path: string) => path === "/cache" ? [entry("file", false), entry(".tmp-old"), entry("recipient-key")] : [entry("body.txt", false), entry(".tmp-stage")]) });
    await expect(createAttachmentStore(skipIo, "/cache").publish({ body: "body", recipientKey: "recipient-key", senderPaneId: "p", senderDisplay: "s", operation: "prompt" })).resolves.toMatchObject({ bytes: 4 });

    const expired = { ...validMetadata, expiresAt: "2000-01-01T00:00:00.000Z" };
    const sweepFailure = ioWith({
      readdir: vi.fn(async (path: string) => path === "/cache" ? [entry("recipient-key")] : [entry("attachment-1")]),
      readFile: vi.fn(async () => Buffer.from(JSON.stringify(expired))),
      rm: vi.fn(async () => { throw new Error("remove"); })
    });
    await expect(createAttachmentStore(sweepFailure, "/cache", () => new Date("2026-08-20T00:00:00.000Z")).publish({ body: "body", recipientKey: "recipient-key", senderPaneId: "p", senderDisplay: "s", operation: "prompt" })).rejects.toMatchObject({ details: { operation: "sweep" } });

    const rootAfterSweepFailure = ioWith({ readdir: vi.fn().mockResolvedValueOnce([entry("recipient-key")]).mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("root after sweep")) });
    await expect(createAttachmentStore(rootAfterSweepFailure, "/cache").publish({ body: "body", recipientKey: "recipient-key", senderPaneId: "p", senderDisplay: "s", operation: "prompt" })).rejects.toMatchObject({ details: { operation: "list_recipients" } });

    const recipientAfterSweepFailure = ioWith({ readdir: vi.fn().mockResolvedValueOnce([entry("recipient-key")]).mockResolvedValueOnce([]).mockResolvedValueOnce([entry("recipient-key")]).mockRejectedValueOnce(new Error("recipient after sweep")) });
    await expect(createAttachmentStore(recipientAfterSweepFailure, "/cache").publish({ body: "body", recipientKey: "recipient-key", senderPaneId: "p", senderDisplay: "s", operation: "prompt" })).rejects.toMatchObject({ details: { operation: "list_attachments" } });

    const removeEmptyFailure = ioWith({ readdir: vi.fn().mockResolvedValueOnce([entry("recipient-key")]).mockResolvedValueOnce([]).mockResolvedValueOnce([entry("recipient-key")]).mockResolvedValueOnce([]), rm: vi.fn(async () => { throw new Error("empty"); }) });
    await expect(createAttachmentStore(removeEmptyFailure, "/cache").publish({ body: "body", recipientKey: "recipient-key", senderPaneId: "p", senderDisplay: "s", operation: "prompt" })).rejects.toMatchObject({ details: { operation: "sweep" } });

    const invalidPane = createAttachmentStore(ioWith(), "/cache");
    await expect(invalidPane.publish({ body: "body", recipientKey: "recipient-key", recipientPaneId: "bad\n", senderPaneId: "p", senderDisplay: "s", operation: "prompt" })).rejects.toMatchObject({ code: "ATTACHMENT_STORE_FAILED" });
  });
});
