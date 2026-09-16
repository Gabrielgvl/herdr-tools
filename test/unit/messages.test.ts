import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_RETENTION_HOURS, ATTACHMENT_STORE_MAX_RECORDS, ATTACHMENT_STORE_QUOTA_BYTES, MESSAGE_INLINE_MAX_BYTES, assertDeliverySize, assertMessageText } from "../../src/messages/limits.js";
import { RecipientRegistry, mintRecipientKey, recipientIdentity, verifyRecipient } from "../../src/messages/recipients.js";
import { withDeliveryFailureEvidence } from "../../src/messages/failure.js";
import { attachmentCapability, handoffWriteCapability } from "../../src/profiles/capability.js";
import { ATTACHMENT_GRANT_NAME, ATTACHMENT_LOCK_NAME, ATTACHMENT_LOCK_OWNER_FILE, DEFAULT_GRANT_LEASE_MS, DEFAULT_LOCK_LEASE_MS, attachmentMetadataBytes, createAttachmentStore, publishedAttachmentMatchesDirectory, type AttachmentDirEntry, type AttachmentStoreIo } from "../../src/messages/store.js";
import type { HerdrSnapshot } from "../../src/targets.js";
import type { Profile } from "../../src/profiles/types.js";

const targetIdentity = { terminal_id: "term-worker", agent_session: { source: "herdr:pi", agent: "pi", kind: "id", value: "session-worker" } };
const agySession = { source: "agy", agent: "agy", kind: "id", value: "session-agy" };
const snapshot: HerdrSnapshot = {
  version: "0.8.0",
  protocol: 22,
  workspaces: [],
  tabs: [],
  panes: [{ pane_id: "w:p1", tab_id: "w:t1", workspace_id: "w1", agent_name: "worker", agent_id: "agent-1", agent: "pi", ...targetIdentity }],
  agents: [{ pane_id: "w:p1", name: "worker", agent_id: "agent-1", agent: "pi", ...targetIdentity }]
};

const KEY = "recipient-key";

function profile(kind: "pi" | "claude" | "agy", overrides: Partial<Profile["runtime"]> = {}): Profile {
  const runtime = kind === "pi"
    ? { kind: "pi" as const, model: "test", thinking: "low" as const, tools: [], extensions: [], skills: [], ...overrides }
    : kind === "claude"
      ? { kind: "claude" as const, model: "test", effort: "medium" as const, permissionMode: "default" as const, allowedTools: [], disallowedTools: [], addDirs: [], pluginDirs: [], developmentChannels: [], ...overrides }
      : { kind: "agy" as const, model: "test", mode: "plan" as const, addDirs: [], ...overrides };
  return {
    name: `${kind}-profile`, description: "profile", timeoutMinutes: 1, sessionPersistence: kind !== "pi", runtime: runtime as Profile["runtime"], fallbackProfiles: [], body: "body", source: { kind: "bundled", path: `/profiles/${kind}.md`, scopeRoot: "/profiles", precedence: 0 }
  };
}

/** Real filesystem IO so store sequencing is exercised, with targeted failure injection. */
function io(overrides: Partial<AttachmentStoreIo> = {}): AttachmentStoreIo {
  return {
    mkdir: async (path, options) => { await fs.mkdir(path, options); },
    mkdtemp: (prefix) => fs.mkdtemp(prefix),
    readFile: async (path) => fs.readFile(path),
    writeFile: async (path, data, options) => { await fs.writeFile(path, data, options); },
    chmod: (path, mode) => fs.chmod(path, mode),
    rename: (source, destination) => fs.rename(source, destination),
    rm: (path, options) => fs.rm(path, options),
    readdir: async (path) => fs.readdir(path, { withFileTypes: true }) as Promise<readonly AttachmentDirEntry[]>,
    stat: async (path) => ({ mtimeMs: (await fs.stat(path)).mtimeMs }),
    ...overrides
  };
}

async function root(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `herdr-attachments-${name}-`));
}

function metadata(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    attachmentId: "00000000-0000-4000-8000-000000000000",
    bytes: 1,
    sha256: "0".repeat(64),
    encoding: "utf-8",
    createdAt: "2026-08-20T00:00:00.000Z",
    expiresAt: "2999-08-20T00:00:00.000Z",
    senderPaneId: "w:p0",
    senderDisplay: "caller",
    operation: "prompt",
    ...overrides
  });
}

async function seedRecord(storeRoot: string, key: string, id: string, overrides: Record<string, unknown> = {}, body = "x"): Promise<string> {
  const path = join(storeRoot, key, id);
  await fs.mkdir(path, { recursive: true, mode: 0o700 });
  await fs.writeFile(join(path, "body.txt"), body, { mode: 0o600 });
  await fs.writeFile(join(path, "meta.json"), metadata({ attachmentId: id, bytes: Buffer.byteLength(body), ...overrides }), { mode: 0o600 });
  return path;
}

const input = { recipientKey: KEY, senderPaneId: "w:p0", senderDisplay: "caller", operation: "prompt" as const };

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

  it("derives Pi and Claude read capabilities from the effective post-override runtime", () => {
    expect(attachmentCapability(profile("pi"))).toMatchObject({ kind: "pi", capable: true });
    expect(attachmentCapability(profile("pi", { tools: ["bash"] }))).toMatchObject({ capable: false });
    expect(attachmentCapability(profile("pi", { tools: ["read", "bash"] }))).toMatchObject({ capable: true });
    expect(attachmentCapability(profile("claude"))).toMatchObject({ kind: "claude", capable: true });
    expect(attachmentCapability(profile("claude", { disallowedTools: ["Read"] }))).toMatchObject({ capable: false });
    expect(attachmentCapability(profile("claude", { allowedTools: ["Bash"] }))).toMatchObject({ capable: false });
    expect(attachmentCapability(profile("claude", { allowedTools: ["Read"] }))).toMatchObject({ capable: true });

    expect(attachmentCapability(profile("pi"), { tools: ["bash"] })).toMatchObject({ capable: false, reason: "Pi profile excludes the local read tool" });
    expect(attachmentCapability(profile("pi", { tools: ["bash"] }), { tools: ["read"] })).toMatchObject({ capable: true });
    expect(attachmentCapability(profile("claude"), { disallowedTools: ["Read"] })).toMatchObject({ capable: false, reason: "Claude profile disallows Read" });
    expect(attachmentCapability(profile("claude"), { allowedTools: ["Bash"] })).toMatchObject({ capable: false, reason: "Claude profile allowlist excludes Read" });
    expect(attachmentCapability(profile("claude", { disallowedTools: ["Read"] }), { disallowedTools: [] })).toMatchObject({ capable: true });
  });

  it("derives handoff write capability from the effective post-override runtime", () => {
    expect(handoffWriteCapability(profile("pi"))).toMatchObject({ kind: "pi", capable: true });
    expect(handoffWriteCapability(profile("pi", { tools: ["read"] }))).toMatchObject({ capable: false, reason: "Pi profile excludes every write-capable tool" });
    expect(handoffWriteCapability(profile("pi", { tools: ["read"] }), { tools: ["apply_patch"] })).toMatchObject({ capable: true });
    expect(handoffWriteCapability(profile("claude"))).toMatchObject({ kind: "claude", capable: true });
    expect(handoffWriteCapability(profile("claude", { disallowedTools: ["Write", "Bash"] }))).toMatchObject({ capable: false, reason: "Claude profile excludes Write and Bash" });
    expect(handoffWriteCapability(profile("claude", { allowedTools: ["Bash"] }))).toMatchObject({ capable: true });
    expect(handoffWriteCapability(profile("claude"), { disallowedTools: ["Write", "Bash"] })).toMatchObject({ capable: false });
    // AGY has no tool allowlist to narrow, so it can always write its artifact.
    expect(handoffWriteCapability(profile("agy"))).toMatchObject({ kind: "agy", capable: true, reason: "AGY profile can write its run handoff" });
  });

  it("tracks runtime-only recipient identities and resets them", () => {
    const registry = new RecipientRegistry();
    const capability = attachmentCapability(profile("pi"));
    const key = mintRecipientKey();
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    const record = registry.recordFor("pi-profile", "w:p1", key, capability, { paneId: "w:p1", terminalId: "term-worker", agentName: "worker", agentKind: "pi", agentSession: targetIdentity.agent_session, agentId: "agent-1" });
    expect(registry.size).toBe(1);
    expect(registry.get("w:p1")).toEqual(record);
    expect(registry.get("missing")).toBeUndefined();
    expect(verifyRecipient(snapshot, record)).toMatchObject({ verified: true, identity: { agentName: "worker", agentId: "agent-1" } });
    expect(verifyRecipient(snapshot, { ...record, capable: false, reason: "restricted" })).toMatchObject({ verified: false, reason: "restricted" });
    // Optional agent IDs are diagnostic only; the stable terminal/session identity is authoritative.
    expect(verifyRecipient(snapshot, { ...record, agentId: "different" })).toMatchObject({ verified: true });
    expect(verifyRecipient(snapshot, { ...record, agentSession: { ...record.agentSession, value: "replacement" } })).toMatchObject({ verified: false });
    expect(verifyRecipient(snapshot, { ...record, terminalId: "replacement-terminal" })).toMatchObject({ verified: false });
    expect(verifyRecipient(snapshot, undefined)).toMatchObject({ verified: false, identity: {} });
    expect(recipientIdentity(snapshot, "missing")).toEqual({});
    const malformedSnapshot = { ...snapshot, panes: [{ ...snapshot.panes[0]!, agent_session: { ...targetIdentity.agent_session, value: "replacement" } }] };
    expect(recipientIdentity(malformedSnapshot, "w:p1")).toEqual({});
    expect(verifyRecipient(malformedSnapshot, record)).toMatchObject({ verified: false, reason: "recipient identity is unavailable or contradictory in the authoritative snapshot" });
    const paneIdOnlySnapshot = { ...snapshot, panes: [{ ...snapshot.panes[0]!, agent_id: "pane-agent" }], agents: [{ ...snapshot.agents[0]!, agent_id: undefined }] };
    expect(recipientIdentity(paneIdOnlySnapshot, "w:p1")).toMatchObject({ agentId: "pane-agent" });
    const noAgentIdSnapshot = { ...snapshot, panes: [{ ...snapshot.panes[0]!, agent_id: undefined }], agents: [{ ...snapshot.agents[0]!, agent_id: undefined }] };
    expect(recipientIdentity(noAgentIdSnapshot, "w:p1")).not.toHaveProperty("agentId");
    expect(() => registry.recordFor("pi-profile", "other-pane", key, capability, { paneId: "w:p1", terminalId: "term-worker", agentName: "worker", agentKind: "pi", agentSession: targetIdentity.agent_session })).toThrow(/does not match/);
    expect(() => registry.recordFor("pi-profile", "w:p1", key, capability, { paneId: "w:p1", terminalId: "term-worker", agentName: "worker", agentKind: "claude", agentSession: targetIdentity.agent_session })).toThrow(/does not match/);
    registry.reset();
    expect(registry.size).toBe(0);
  });

  it("registers AGY only from strengthened exact identity and rejects replacements", () => {
    const registry = new RecipientRegistry();
    const capability = attachmentCapability(profile("agy"));
    const identity = { paneId: "w:p1", terminalId: "term-agy", agentName: "researcher", agentKind: "agy", agentSession: agySession };
    const agySnapshot: HerdrSnapshot = {
      ...snapshot,
      panes: [{ ...snapshot.panes[0]!, terminal_id: "term-agy", agent_name: "researcher", agent: "agy", agent_session: agySession }],
      agents: [{ ...snapshot.agents[0]!, terminal_id: "term-agy", name: "researcher", agent: "agy", agent_session: agySession }]
    };

    expect(() => registry.recordFor("agy-profile", "w:p1", KEY, capability, identity)).toThrow(/strengthened exact identity/u);
    expect(() => registry.recordFor("agy-profile", "w:p1", KEY, capability, { ...identity, agentSession: undefined } as never, { agyStrengthened: true, attachmentDirectory: "/cache/agy" })).toThrow(/does not match/u);
    expect(() => registry.recordFor("agy-profile", "w:p1", KEY, capability, { ...identity, agentSession: { ...agySession, agent: "pi" } }, { agyStrengthened: true, attachmentDirectory: "/cache/agy" })).toThrow(/does not match/u);
    expect(() => registry.recordFor("agy-profile", "w:p1", KEY, capability, identity, { agyStrengthened: true, attachmentDirectory: "relative/agy" })).toThrow(/attachment directory/u);

    const record = registry.recordFor("agy-profile", "w:p1", KEY, capability, identity, { agyStrengthened: true, attachmentDirectory: "/cache/agy" });
    expect(record).toMatchObject({ kind: "agy", agyStrengthened: true, attachmentDirectory: "/cache/agy", agentSession: agySession });
    expect(verifyRecipient(agySnapshot, record)).toMatchObject({ verified: true, identity: { agentKind: "agy", agentSession: agySession } });
    expect(verifyRecipient(agySnapshot, { ...record, agyStrengthened: undefined } as never)).toMatchObject({ verified: false, reason: "AGY recipient has no strengthened attachment capability" });
    expect(verifyRecipient({ ...agySnapshot, agents: [{ ...agySnapshot.agents[0]!, agent_session: { ...agySession, value: "replacement" } }] }, record)).toMatchObject({ verified: false });
    expect(() => registry.register({ ...record, agentKind: "pi" })).toThrow(/does not match/u);
    expect(() => registry.register({ ...record, agyStrengthened: undefined } as never)).toThrow(/strengthened exact identity/u);
  });

  it("adds body-free delivery evidence only to object failures", () => {
    expect(withDeliveryFailureEvidence("string failure", { delivery: "attachment" })).toBe("string failure");
    const typed = Object.assign(new Error("send failed"), { code: "CLI_TIMEOUT", details: { target: "w:p1" } });
    const augmented = withDeliveryFailureEvidence(typed, { delivery: "attachment", route: "prompt_direct", phase: "send", published: { attachmentId: "a", path: "/store/a/body.txt", bytes: 4, sha256: "0".repeat(64), expiresAt: "2999-01-01T00:00:00.000Z" } }) as typeof typed;
    expect(augmented.code).toBe("CLI_TIMEOUT");
    expect(augmented.details).toMatchObject({ target: "w:p1", delivery: "attachment", route: "prompt_direct", phase: "send", attachmentRetained: true, attachment: { path: "/store/a/body.txt" } });
    const untyped = Object.assign(new Error("no details"), { details: "not-a-record" });
    expect((withDeliveryFailureEvidence(untyped, { phase: "publish" }) as typeof untyped).details).toEqual({ phase: "publish" });
    const arrayDetails = Object.assign(new Error("array details"), { details: ["ignored"] });
    expect((withDeliveryFailureEvidence(arrayDetails, { delivery: "inline" }) as typeof arrayDetails).details).toEqual({ delivery: "inline" });

    const unsafeDispatch = Object.assign(new Error("transport text"), { details: { promptDispatch: { state: "unknown", requestId: "request-1", body: "secret prompt" } } });
    const safeDispatch = withDeliveryFailureEvidence(unsafeDispatch, {}) as typeof unsafeDispatch;
    expect(safeDispatch.details).toEqual({ promptDispatch: { state: "unknown", requestId: "request-1" } });
    expect(JSON.stringify(safeDispatch.details)).not.toContain("secret prompt");

    for (const promptDispatch of [
      { state: "invalid" },
      { state: "acknowledged" },
      { state: "rejected", requestId: "" },
      { state: "unknown", requestId: "x".repeat(257) },
      { state: "not_written", requestId: "bad\nrequest" }
    ]) {
      const failure = Object.assign(new Error("dispatch"), { details: { promptDispatch } });
      const expected = ["not_written", "rejected", "acknowledged", "unknown"].includes(promptDispatch.state)
        ? { promptDispatch: { state: promptDispatch.state } }
        : {};
      expect((withDeliveryFailureEvidence(failure, {}) as typeof failure).details).toEqual(expected);
    }
  });
});

describe("attachment store", () => {
  it("atomically publishes exact owner-only UTF-8 content and metadata", async () => {
    const storeRoot = await root("publish");
    try {
      let now = new Date("2026-08-20T12:00:00.000Z");
      const store = createAttachmentStore(undefined, storeRoot, () => now);
      const grant = await store.ensureRecipient(KEY);
      const directory = grant.path;
      const body = "large\n☃";
      const published = await store.publish({ ...input, body, recipientPaneId: "w:p1", recipientAgentName: "worker" });
      expect(published).toMatchObject({ bytes: Buffer.byteLength(body), recipientPaneId: "w:p1", path: join(directory, published.attachmentId, "body.txt") });
      expect(publishedAttachmentMatchesDirectory(published, directory)).toBe(true);
      expect(publishedAttachmentMatchesDirectory({ ...published, path: join(directory, "other", "body.txt") }, directory)).toBe(false);
      expect(await readFile(published.path, "utf8")).toBe(body);
      const record = JSON.parse(await readFile(join(directory, published.attachmentId, "meta.json"), "utf8")) as Record<string, unknown>;
      expect(record).toMatchObject({ attachmentId: published.attachmentId, bytes: published.bytes, sha256: published.sha256, encoding: "utf-8", senderPaneId: "w:p0", recipientPaneId: "w:p1", operation: "prompt" });
      expect(JSON.stringify(record)).not.toContain(body);
      expect((await stat(storeRoot)).mode & 0o777).toBe(0o700);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(published.path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(directory, published.attachmentId, "meta.json"))).mode & 0o777).toBe(0o600);
      await expect(stat(join(storeRoot, ATTACHMENT_LOCK_NAME))).rejects.toMatchObject({ code: "ENOENT" });

      now = new Date(now.getTime() + ATTACHMENT_RETENTION_HOURS * 60 * 60 * 1_000 + 1);
      const fresh = await store.publish({ ...input, body: "fresh", operation: "assignment" });
      await expect(stat(published.path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(fresh.expiresAt).toBe("2026-08-22T12:00:00.001Z");
      expect(await readFile(fresh.path, "utf8")).toBe("fresh");
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it("purges abandoned staging and metadata-less records before any quota decision", async () => {
    const storeRoot = await root("purge");
    try {
      const store = createAttachmentStore(io(), storeRoot);
      await fs.mkdir(join(storeRoot, KEY, ".tmp-abandoned"), { recursive: true });
      await fs.writeFile(join(storeRoot, KEY, ".tmp-abandoned", "body.txt"), "x".repeat(2_048));
      await fs.mkdir(join(storeRoot, ".tmp-orphan"), { recursive: true });
      await fs.writeFile(join(storeRoot, ".tmp-orphan", "body.txt"), "x".repeat(2_048));
      const incomplete = join(storeRoot, KEY, "11111111-1111-4111-8111-111111111111");
      await fs.mkdir(incomplete, { recursive: true });
      await fs.writeFile(join(incomplete, "body.txt"), "x".repeat(2_048));
      await fs.writeFile(join(storeRoot, KEY, "stray.txt"), "not an attachment");

      const published = await store.publish({ ...input, body: "kept" });
      await expect(stat(join(storeRoot, KEY, ".tmp-abandoned"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(storeRoot, ".tmp-orphan"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(incomplete)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(published.path, "utf8")).toBe("kept");
      expect(await readFile(join(storeRoot, KEY, "stray.txt"), "utf8")).toBe("not an attachment");
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it("keeps a launch grant through a slow launch and reclaims only abandoned grants", async () => {
    const storeRoot = await root("grant");
    try {
      let clock = new Date("2026-08-20T12:00:00.000Z");
      const holder = createAttachmentStore(io(), storeRoot, () => clock);
      const sweeper = createAttachmentStore(io(), storeRoot, () => clock);
      const grant = await holder.ensureRecipient("slow-launch-key");
      const marker = JSON.parse(await readFile(join(grant.path, ATTACHMENT_GRANT_NAME), "utf8")) as Record<string, unknown>;
      expect(marker).toMatchObject({ token: grant.token });
      expect((await stat(join(grant.path, ATTACHMENT_GRANT_NAME))).mode & 0o777).toBe(0o600);
      expect(DEFAULT_GRANT_LEASE_MS).toBeGreaterThan(120_000);

      // A launch delayed well past the old 60 s grace keeps its Claude --add-dir path.
      clock = new Date(clock.getTime() + 90_000);
      await sweeper.publish({ ...input, body: "unrelated" });
      expect((await stat(grant.path)).isDirectory()).toBe(true);

      // A renewed grant survives a sweep after the full lease window as well.
      clock = new Date(clock.getTime() + DEFAULT_GRANT_LEASE_MS);
      await grant.renew();
      await sweeper.publish({ ...input, body: "unrelated-again" });
      expect((await stat(grant.path)).isDirectory()).toBe(true);

      // An abandoned grant is reclaimed; a released grant leaves nothing behind.
      clock = new Date(clock.getTime() + DEFAULT_GRANT_LEASE_MS + 1);
      await sweeper.publish({ ...input, body: "after-abandon" });
      await expect(stat(grant.path)).rejects.toMatchObject({ code: "ENOENT" });

      const released = await holder.ensureRecipient("released-key");
      await released.release();
      await expect(stat(join(released.path, ATTACHMENT_GRANT_NAME))).rejects.toMatchObject({ code: "ENOENT" });
      await sweeper.publish({ ...input, body: "after-release" });
      await expect(stat(released.path)).rejects.toMatchObject({ code: "ENOENT" });

      // A grant taken over by a newer launch cannot be renewed or released by the old one.
      const first = await holder.ensureRecipient("replaced-key");
      const second = await holder.ensureRecipient("replaced-key");
      await expect(first.renew()).rejects.toMatchObject({ code: "ATTACHMENT_STORE_FAILED", details: { operation: "grant_renew" } });
      await first.release();
      expect((JSON.parse(await readFile(join(second.path, ATTACHMENT_GRANT_NAME), "utf8")) as { token: string }).token).toBe(second.token);
      await second.renew();
      await second.release();
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it("rejects invalid keys, bodies, recipients, and quota without deleting live records", async () => {
    const storeRoot = await root("invalid");
    try {
      const store = createAttachmentStore(io(), storeRoot);
      await expect(store.ensureRecipient("bad/key")).rejects.toMatchObject({ code: "ATTACHMENT_STORE_FAILED", details: { operation: "validate_recipient" } });
      await expect(store.publish({ ...input, body: "" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(store.publish({ ...input, body: "bad\0body" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(store.publish({ ...input, body: 4 as unknown as string })).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(store.publish({ ...input, body: "x".repeat(ATTACHMENT_MAX_BYTES + 1) })).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
      await expect(store.publish({ ...input, body: "body", recipientKey: "short" })).rejects.toMatchObject({ code: "ATTACHMENT_STORE_FAILED" });
      await expect(store.publish({ ...input, body: "body", expectedRecipientDirectory: join(storeRoot, "wrong-key") })).rejects.toMatchObject({ code: "ATTACHMENT_STORE_FAILED", details: { operation: "validate_recipient" } });
      await expect(store.publish({ ...input, body: "body", recipientPaneId: "bad\n" })).rejects.toMatchObject({ code: "ATTACHMENT_STORE_FAILED", details: { operation: "validate_recipient" } });

      const kept = await seedRecord(storeRoot, KEY, "22222222-2222-4222-8222-222222222222", { bytes: ATTACHMENT_STORE_QUOTA_BYTES }, "x");
      await expect(store.publish({ ...input, body: "over" })).rejects.toMatchObject({ code: "ATTACHMENT_QUOTA_EXCEEDED", details: { operation: "quota", limitBytes: ATTACHMENT_STORE_QUOTA_BYTES } });
      expect(await readFile(join(kept, "body.txt"), "utf8")).toBe("x");
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it("fails closed on the record cap and on malformed metadata", async () => {
    const capRoot = await root("cap");
    try {
      const store = createAttachmentStore(io(), capRoot);
      for (let index = 0; index < ATTACHMENT_STORE_MAX_RECORDS; index += 1) {
        await seedRecord(capRoot, KEY, `3${String(index).padStart(7, "0")}-3333-4333-8333-333333333333`);
      }
      await expect(store.publish({ ...input, body: "over" })).rejects.toMatchObject({ code: "ATTACHMENT_QUOTA_EXCEEDED", details: { limitRecords: ATTACHMENT_STORE_MAX_RECORDS } });
    } finally {
      await rm(capRoot, { recursive: true, force: true });
    }

    const cases = ["not json", "[]", metadata({ bytes: 0 }), metadata({ recipientPaneId: 4 }), metadata({ recipientAgentName: 4 }), metadata({ sha256: "z" })];
    for (const value of cases) {
      const caseRoot = await root("metadata");
      try {
        const record = join(caseRoot, KEY, "44444444-4444-4444-8444-444444444444");
        await fs.mkdir(record, { recursive: true });
        await fs.writeFile(join(record, "meta.json"), value);
        await expect(createAttachmentStore(io(), caseRoot).publish({ ...input, body: "body" })).rejects.toMatchObject({ code: "ATTACHMENT_STORE_FAILED", details: { operation: "read_metadata" } });
      } finally {
        await rm(caseRoot, { recursive: true, force: true });
      }
    }

    const deepRoot = await root("longpath");
    try {
      const longRoot = join(deepRoot, "d".repeat(200), "e".repeat(200), "f".repeat(120));
      const record = join(longRoot, KEY, "55555555-5555-4555-8555-555555555555");
      await fs.mkdir(record, { recursive: true });
      await fs.writeFile(join(record, "meta.json"), "not json");
      expect(join(record, "meta.json").length).toBeGreaterThan(512);
      await expect(createAttachmentStore(io(), longRoot).publish({ ...input, body: "body" })).rejects.toMatchObject({ details: { path: "[path omitted]" } });
    } finally {
      await rm(deepRoot, { recursive: true, force: true });
    }
  });

  it("reports every storage boundary without exposing body text", async () => {
    const storeRoot = await root("failures");
    /** Lock contention is not the subject here, so leftover leases expire immediately. */
    const fast = { lockRetryMs: 1, lockAttempts: 5, lockLeaseMs: 0 };
    /** Fail only the targeted removal so the lock can still be released. */
    const failRemovalOf = (needle: string, message: string) => vi.fn(async (path: string, options: { force: boolean; recursive: boolean }) => {
      if (path.includes(needle)) throw new Error(message);
      await fs.rm(path, options);
    });
    try {
      const secret = "secret body";
      const rootFailure = createAttachmentStore(io({ mkdir: vi.fn(async () => { throw Object.assign(new Error("root"), { code: "EACCES" }); }) }), storeRoot, undefined, fast);
      await expect(rootFailure.publish({ ...input, body: secret })).rejects.toMatchObject({ code: "ATTACHMENT_STORE_FAILED", details: { operation: "ensure_root", causeCode: "EACCES" } });

      const recipientFailure = createAttachmentStore(io({
        mkdir: vi.fn(async (path: string, options: { recursive: boolean; mode: number }) => {
          if (path.endsWith(KEY)) throw new Error("recipient");
          await fs.mkdir(path, options);
        })
      }), storeRoot, undefined, fast);
      await expect(recipientFailure.publish({ ...input, body: secret })).rejects.toMatchObject({ details: { operation: "ensure_recipient" } });

      const listRootFailure = createAttachmentStore(io({ readdir: vi.fn(async () => { throw new Error("list root"); }) }), storeRoot, undefined, fast);
      await expect(listRootFailure.publish({ ...input, body: secret })).rejects.toMatchObject({ details: { operation: "list_recipients" } });

      await fs.mkdir(join(storeRoot, KEY), { recursive: true });
      const listRecipientFailure = createAttachmentStore(io({
        readdir: vi.fn(async (path: string) => path === storeRoot ? fs.readdir(path, { withFileTypes: true }) as unknown as readonly AttachmentDirEntry[] : (() => { throw new Error("list attachments"); })())
      }), storeRoot, undefined, fast);
      await expect(listRecipientFailure.publish({ ...input, body: secret })).rejects.toMatchObject({ details: { operation: "list_attachments" } });

      const unreadable = createAttachmentStore(io({ readFile: vi.fn(async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }) }), storeRoot, undefined, fast);
      await seedRecord(storeRoot, KEY, "66666666-6666-4666-8666-666666666666");
      await expect(unreadable.publish({ ...input, body: secret })).rejects.toMatchObject({ details: { operation: "read_metadata", causeCode: "EACCES" } });
      await rm(join(storeRoot, KEY, "66666666-6666-4666-8666-666666666666"), { recursive: true, force: true });

      const stagingRmFailure = createAttachmentStore(io({ rm: failRemovalOf(".tmp-stuck", "remove staging") }), storeRoot, undefined, fast);
      await fs.mkdir(join(storeRoot, KEY, ".tmp-stuck"), { recursive: true });
      await expect(stagingRmFailure.publish({ ...input, body: secret })).rejects.toMatchObject({ details: { operation: "purge_staging" } });
      await rm(join(storeRoot, KEY, ".tmp-stuck"), { recursive: true, force: true });

      const incompleteRmFailure = createAttachmentStore(io({ rm: failRemovalOf("77777777", "remove incomplete") }), storeRoot, undefined, fast);
      await fs.mkdir(join(storeRoot, KEY, "77777777-7777-4777-8777-777777777777"), { recursive: true });
      await expect(incompleteRmFailure.publish({ ...input, body: secret })).rejects.toMatchObject({ details: { operation: "purge_incomplete" } });
      await rm(join(storeRoot, KEY, "77777777-7777-4777-8777-777777777777"), { recursive: true, force: true });

      const invalidExpiry = createAttachmentStore(io(), storeRoot, undefined, fast);
      await seedRecord(storeRoot, KEY, "88888888-8888-4888-8888-888888888888", { expiresAt: "not a date" });
      await expect(invalidExpiry.publish({ ...input, body: secret })).rejects.toMatchObject({ details: { operation: "sweep" } });
      await rm(join(storeRoot, KEY, "88888888-8888-4888-8888-888888888888"), { recursive: true, force: true });

      await seedRecord(storeRoot, KEY, "99999999-9999-4999-8999-999999999999", { expiresAt: "2000-01-01T00:00:00.000Z" });
      const sweepRmFailure = createAttachmentStore(io({ rm: failRemovalOf("99999999", "remove expired") }), storeRoot, () => new Date("2026-08-20T00:00:00.000Z"), fast);
      await expect(sweepRmFailure.publish({ ...input, body: secret })).rejects.toMatchObject({ details: { operation: "sweep" } });
      await rm(join(storeRoot, KEY, "99999999-9999-4999-8999-999999999999"), { recursive: true, force: true });

      await fs.mkdir(join(storeRoot, "aged-recipient-key"), { recursive: true });
      const grantlessSweepFailure = createAttachmentStore(io({ rm: failRemovalOf("grantless-key", "remove empty recipient") }), storeRoot, undefined, fast);
      await fs.mkdir(join(storeRoot, "grantless-key"), { recursive: true });
      await expect(grantlessSweepFailure.publish({ ...input, body: secret })).rejects.toMatchObject({ details: { operation: "sweep" } });
      const grantless = createAttachmentStore(io(), storeRoot, undefined, fast);
      await expect(grantless.publish({ ...input, body: "kept" })).resolves.toMatchObject({ bytes: 4 });
      await expect(stat(join(storeRoot, "grantless-key"))).rejects.toMatchObject({ code: "ENOENT" });

      const writeFailure = vi.fn(async (path: string, data: Uint8Array, options: { mode: number }) => {
        if (path.endsWith(ATTACHMENT_LOCK_OWNER_FILE) || path.endsWith(ATTACHMENT_GRANT_NAME)) return fs.writeFile(path, data, options);
        throw new Error("write failed");
      });
      const writeStore = createAttachmentStore(io({ writeFile: writeFailure }), storeRoot, undefined, fast);
      await expect(writeStore.publish({ ...input, body: secret })).rejects.toMatchObject({ details: { operation: "publish" } });
      expect(JSON.stringify(writeFailure.mock.calls)).not.toContain(secret);

      const renameFailure = createAttachmentStore(io({ rename: vi.fn(async () => { throw new Error("rename failed"); }), rm: failRemovalOf(".tmp-", "cleanup failed") }), storeRoot, undefined, fast);
      await expect(renameFailure.publish({ ...input, body: secret })).rejects.toMatchObject({ details: { operation: "publish" } });

      expect(ATTACHMENT_STORE_QUOTA_BYTES).toBe(64 * 1024 * 1024);
      expect(attachmentMetadataBytes(JSON.parse(metadata()) as never)).toBeGreaterThan(0);
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it("never reclaims a live owner's lock and only reclaims an abandoned lease", async () => {
    const storeRoot = await root("lock-lease");
    const ownerPath = join(storeRoot, ATTACHMENT_LOCK_NAME, ATTACHMENT_LOCK_OWNER_FILE);
    try {
      let clock = new Date("2026-08-20T12:00:00.000Z");
      await fs.mkdir(join(storeRoot, ATTACHMENT_LOCK_NAME), { recursive: true, mode: 0o700 });
      const holdLock = async (token: string): Promise<void> => {
        await fs.writeFile(ownerPath, JSON.stringify({ token, acquiredAt: clock.toISOString(), renewedAt: clock.toISOString() }), { mode: 0o600 });
      };
      await holdLock("live-owner");
      const competitors = [
        createAttachmentStore(io(), storeRoot, () => clock, { lockAttempts: 3, lockRetryMs: 1 }),
        createAttachmentStore(io(), storeRoot, () => clock, { lockAttempts: 3, lockRetryMs: 1 })
      ];

      // A live publisher renewing past the lease interval keeps its lock against both.
      for (let elapsed = 0; elapsed < DEFAULT_LOCK_LEASE_MS * 3; elapsed += DEFAULT_LOCK_LEASE_MS) {
        clock = new Date(clock.getTime() + DEFAULT_LOCK_LEASE_MS - 1);
        await holdLock("live-owner");
        const blocked = await Promise.allSettled(competitors.map((store) => store.publish({ ...input, body: "blocked" })));
        expect(blocked.every((outcome) => outcome.status === "rejected")).toBe(true);
        for (const outcome of blocked) expect((outcome as PromiseRejectedResult).reason).toMatchObject({ code: "ATTACHMENT_STORE_FAILED", details: { operation: "lock", attempts: 3 } });
        expect((JSON.parse(await readFile(ownerPath, "utf8")) as { token: string }).token).toBe("live-owner");
      }
      expect(await fs.readdir(join(storeRoot, KEY)).catch(() => [])).toEqual([]);

      // Once the owner stops renewing, exactly one competitor reclaims the abandoned lease.
      clock = new Date(clock.getTime() + DEFAULT_LOCK_LEASE_MS + 1);
      const reclaimed = await Promise.allSettled(competitors.map((store) => store.publish({ ...input, body: "reclaimed" })));
      expect(reclaimed.filter((outcome) => outcome.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
      await expect(stat(join(storeRoot, ATTACHMENT_LOCK_NAME))).rejects.toMatchObject({ code: "ENOENT" });

      // A lock directory whose owner file never appeared is reclaimed only once it ages out.
      await fs.mkdir(join(storeRoot, ATTACHMENT_LOCK_NAME), { recursive: true });
      const fresh = new Date(clock.getTime());
      await utimes(join(storeRoot, ATTACHMENT_LOCK_NAME), fresh, fresh);
      await expect(competitors[0]!.publish({ ...input, body: "orphan" })).rejects.toMatchObject({ details: { operation: "lock" } });
      const aged = new Date(clock.getTime() - DEFAULT_LOCK_LEASE_MS - 1);
      await utimes(join(storeRoot, ATTACHMENT_LOCK_NAME), aged, aged);
      await expect(competitors[0]!.publish({ ...input, body: "orphan" })).resolves.toMatchObject({ bytes: 6 });
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it("aborts publication and keeps a replacement lock when the lease is lost", async () => {
    const storeRoot = await root("lease-loss");
    const ownerPath = join(storeRoot, ATTACHMENT_LOCK_NAME, ATTACHMENT_LOCK_OWNER_FILE);
    try {
      const clock = new Date("2026-08-20T12:00:00.000Z");
      const stolen = createAttachmentStore(io({
        // Simulate a competitor reclaiming the lock while this publication is staging.
        writeFile: vi.fn(async (path: string, data: Uint8Array, options: { mode: number }) => {
          await fs.writeFile(path, data, options);
          if (path.endsWith("meta.json")) await fs.writeFile(ownerPath, JSON.stringify({ token: "competitor", acquiredAt: clock.toISOString(), renewedAt: clock.toISOString() }), { mode: 0o600 });
        })
      }), storeRoot, () => clock, { lockAttempts: 2, lockRetryMs: 1 });
      await expect(stolen.publish({ ...input, body: "aborted" })).rejects.toMatchObject({ code: "ATTACHMENT_STORE_FAILED", details: { operation: "lock_validate" } });
      expect((JSON.parse(await readFile(ownerPath, "utf8")) as { token: string }).token).toBe("competitor");
      const staged = await fs.readdir(join(storeRoot, KEY));
      expect(staged).toEqual([]);
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it("treats an unreadable or changing owner marker as unsafe to reclaim", async () => {
    const storeRoot = await root("lock-marker");
    const lockPath = join(storeRoot, ATTACHMENT_LOCK_NAME);
    const ownerPath = join(lockPath, ATTACHMENT_LOCK_OWNER_FILE);
    try {
      const clock = new Date("2026-08-20T12:00:00.000Z");
      // A lock directory with no owner marker at all: reclaimed only once it ages out.
      await fs.mkdir(lockPath, { recursive: true });
      const defaultIoStore = createAttachmentStore(undefined, storeRoot, () => clock, { lockAttempts: 2, lockRetryMs: 1 });
      await expect(defaultIoStore.publish({ ...input, body: "orphan" })).rejects.toMatchObject({ details: { operation: "lock" } });
      const aged = new Date(clock.getTime() - DEFAULT_LOCK_LEASE_MS - 1);
      await utimes(lockPath, aged, aged);
      await expect(defaultIoStore.publish({ ...input, body: "orphan" })).resolves.toMatchObject({ bytes: 6 });

      // A vanished lock directory is retried instead of reported as abandoned.
      await fs.mkdir(lockPath, { recursive: true });
      const vanishing = createAttachmentStore(io({
        stat: vi.fn(async (path: string) => {
          if (path.endsWith(ATTACHMENT_LOCK_NAME)) {
            await fs.rm(path, { recursive: true, force: true });
            throw Object.assign(new Error("gone"), { code: "ENOENT" });
          }
          return { mtimeMs: (await fs.stat(path)).mtimeMs };
        })
      }), storeRoot, () => clock, { lockAttempts: 5, lockRetryMs: 1 });
      await expect(vanishing.publish({ ...input, body: "retried" })).resolves.toMatchObject({ bytes: 7 });

      // An owner marker that changes between reads is never deleted.
      await fs.mkdir(lockPath, { recursive: true });
      const expired = new Date(clock.getTime() - DEFAULT_LOCK_LEASE_MS - 1).toISOString();
      await fs.writeFile(ownerPath, JSON.stringify({ token: "first", acquiredAt: expired, renewedAt: expired }));
      let reads = 0;
      const changing = createAttachmentStore(io({
        readFile: vi.fn(async (path: string) => {
          if (path.endsWith(ATTACHMENT_LOCK_OWNER_FILE)) {
            reads += 1;
            return Buffer.from(JSON.stringify({ token: `owner-${reads}`, acquiredAt: expired, renewedAt: expired }), "utf8");
          }
          return fs.readFile(path);
        })
      }), storeRoot, () => clock, { lockAttempts: 2, lockRetryMs: 1 });
      await expect(changing.publish({ ...input, body: "unsafe" })).rejects.toMatchObject({ details: { operation: "lock" } });
      expect((await stat(lockPath)).isDirectory()).toBe(true);
      expect(reads).toBeGreaterThanOrEqual(2);

      // Malformed markers are reported as absent, never as a live lease.
      for (const malformed of ["not json", "[]", JSON.stringify({ token: "", renewedAt: expired }), JSON.stringify({ token: "t", renewedAt: "nonsense" }), JSON.stringify({ token: "t", renewedAt: 5 })]) {
        await fs.writeFile(ownerPath, malformed);
        const fresh = new Date(clock.getTime());
        await utimes(lockPath, fresh, fresh);
        const malformedStore = createAttachmentStore(io(), storeRoot, () => clock, { lockAttempts: 2, lockRetryMs: 1 });
        await expect(malformedStore.publish({ ...input, body: "malformed" })).rejects.toMatchObject({ details: { operation: "lock" } });
      }
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it("reports lock failures without publishing and tolerates a failed release", async () => {
    const storeRoot = await root("lock-failures");
    const lockPath = join(storeRoot, ATTACHMENT_LOCK_NAME);
    const ownerPath = join(lockPath, ATTACHMENT_LOCK_OWNER_FILE);
    try {
      const clock = new Date("2026-08-20T12:00:00.000Z");
      const lockMkdirFailure = createAttachmentStore(io({
        mkdir: vi.fn(async (path: string, options: { recursive: boolean; mode: number }) => {
          if (path.endsWith(ATTACHMENT_LOCK_NAME)) throw Object.assign(new Error("denied"), { code: "EACCES" });
          await fs.mkdir(path, options);
        })
      }), storeRoot, () => clock);
      await expect(lockMkdirFailure.publish({ ...input, body: "denied" })).rejects.toMatchObject({ details: { operation: "lock", causeCode: "EACCES" } });

      await fs.mkdir(lockPath, { recursive: true });
      await fs.writeFile(ownerPath, "not json");
      const orphanStatFailure = createAttachmentStore(io({ stat: vi.fn(async () => { throw Object.assign(new Error("stat"), { code: "EACCES" }); }) }), storeRoot, () => clock, { lockAttempts: 2, lockRetryMs: 1 });
      await expect(orphanStatFailure.publish({ ...input, body: "denied" })).rejects.toMatchObject({ details: { operation: "lock" } });

      const ownerReadFailure = createAttachmentStore(io({ readFile: vi.fn(async () => { throw Object.assign(new Error("owner"), { code: "EACCES" }); }) }), storeRoot, () => clock, { lockAttempts: 2, lockRetryMs: 1 });
      await expect(ownerReadFailure.publish({ ...input, body: "denied" })).rejects.toMatchObject({ details: { operation: "lock", causeCode: "EACCES" } });

      const aged = new Date(clock.getTime() - DEFAULT_LOCK_LEASE_MS - 1);
      await utimes(lockPath, aged, aged);
      const reclaimRemoveFailure = createAttachmentStore(io({ rm: vi.fn(async () => { throw new Error("stuck lock"); }) }), storeRoot, () => clock, { lockAttempts: 2, lockRetryMs: 1 });
      await expect(reclaimRemoveFailure.publish({ ...input, body: "denied" })).rejects.toMatchObject({ details: { operation: "lock" } });

      await rm(lockPath, { recursive: true, force: true });
      const releaseFailure = createAttachmentStore(io({ rm: vi.fn(async (path: string, options: { force: boolean; recursive: boolean }) => { if (path.endsWith(ATTACHMENT_LOCK_NAME)) throw new Error("release failed"); await fs.rm(path, options); }) }), storeRoot, () => clock);
      await expect(releaseFailure.publish({ ...input, body: "kept" })).resolves.toMatchObject({ bytes: 4 });
      expect((await stat(lockPath)).isDirectory()).toBe(true);

      const ownerWriteFailure = createAttachmentStore(io({
        writeFile: vi.fn(async (path: string) => { if (path.endsWith(ATTACHMENT_LOCK_OWNER_FILE)) throw Object.assign(new Error("owner write"), { code: "EACCES" }); })
      }), storeRoot, () => clock, { lockAttempts: 2, lockRetryMs: 1, lockLeaseMs: 0 });
      await expect(ownerWriteFailure.publish({ ...input, body: "denied" })).rejects.toMatchObject({ details: { operation: "lock", causeCode: "EACCES" } });
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it("admits exactly one concurrent publication at the record cap in one process", async () => {
    const storeRoot = await root("race");
    try {
      for (let index = 0; index < ATTACHMENT_STORE_MAX_RECORDS - 1; index += 1) {
        await seedRecord(storeRoot, KEY, `a${String(index).padStart(7, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`);
      }
      // The loser must wait for the winner rather than give up on the lock.
      const raceOptions = { lockRetryMs: 1, lockAttempts: 20_000 };
      const first = createAttachmentStore(io(), storeRoot, () => new Date("2026-08-20T12:00:00.000Z"), raceOptions);
      const second = createAttachmentStore(io(), storeRoot, () => new Date("2026-08-20T12:00:00.000Z"), raceOptions);
      const outcomes = await Promise.allSettled([
        first.publish({ ...input, body: "first" }),
        second.publish({ ...input, body: "second" })
      ]);
      const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
      const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "ATTACHMENT_QUOTA_EXCEEDED" });
      const records = await fs.readdir(join(storeRoot, KEY));
      expect(records.filter((name) => !name.startsWith(".tmp-"))).toHaveLength(ATTACHMENT_STORE_MAX_RECORDS);
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it("admits exactly one concurrent publication at the record cap across processes", async () => {
    const storeRoot = await root("cross-process");
    try {
      for (let index = 0; index < ATTACHMENT_STORE_MAX_RECORDS - 1; index += 1) {
        await seedRecord(storeRoot, KEY, `b${String(index).padStart(7, "0")}-bbbb-4bbb-8bbb-bbbbbbbbbbbb`);
      }
      const storeModule = join(dirname(new URL(import.meta.url).pathname), "..", "..", "src", "messages", "store.ts");
      const script = `
        import { createAttachmentStore } from ${JSON.stringify(storeModule)};
        const store = createAttachmentStore(undefined, ${JSON.stringify(storeRoot)}, () => new Date(), { lockRetryMs: 1, lockAttempts: 20_000 });
        store.publish({ body: "child", recipientKey: ${JSON.stringify(KEY)}, senderPaneId: "w:p0", senderDisplay: "caller", operation: "prompt" })
          .then(() => process.stdout.write("PUBLISHED"))
          .catch((error) => process.stdout.write(String(error.code)));
      `;
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
      let childOutput = "";
      let childError = "";
      child.stdout.on("data", (chunk: Buffer) => { childOutput += chunk.toString(); });
      child.stderr?.on("data", (chunk: Buffer) => { childError += chunk.toString(); });
      const local = createAttachmentStore(io(), storeRoot, () => new Date(), { lockRetryMs: 1, lockAttempts: 20_000 });
      const localOutcome = await local.publish({ ...input, body: "local" }).then(() => "PUBLISHED").catch((error: { code?: string }) => String(error.code));
      await new Promise<void>((resolve) => child.on("close", () => resolve()));

      expect(childError, `child publish failed: ${childError}`).toBe("");
      expect([localOutcome, childOutput].filter((value) => value === "PUBLISHED")).toHaveLength(1);
      expect([localOutcome, childOutput].filter((value) => value === "ATTACHMENT_QUOTA_EXCEEDED")).toHaveLength(1);
      const records = await fs.readdir(join(storeRoot, KEY));
      expect(records.filter((name) => !name.startsWith(".tmp-") && name !== ATTACHMENT_LOCK_NAME)).toHaveLength(ATTACHMENT_STORE_MAX_RECORDS);
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
