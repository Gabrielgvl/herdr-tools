import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { LockOptions } from "proper-lockfile";
import type * as properLockfile from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Credential } from "@earendil-works/pi-ai";
import { AuthJsonCredentialStore, defaultAuthJsonPath } from "../../src/supervision/auth-json-credential-store.js";
import { createBuiltinModelService } from "../../src/supervision/model-service.js";

type LockFn = (file: string, options?: LockOptions) => Promise<() => Promise<void>>;

const lockState = vi.hoisted(() => ({ impl: undefined as LockFn | undefined }));

vi.mock("proper-lockfile", async (importOriginal) => {
  const actual = await importOriginal<typeof properLockfile>();
  return {
    ...actual,
    lock: (file: string, options?: LockOptions) => (lockState.impl ?? actual.lock)(file, options),
  };
});

const oauthEntry = { type: "oauth", access: "fake-access-token", refresh: "fake-refresh-token", expires: Date.now() + 3_600_000, accountId: "fake-account" } satisfies Credential;
const apiKeyEntry = { type: "api_key", key: "fake-api-key" } satisfies Credential;

const directories: string[] = [];
function fixture(): { dir: string; authPath: string; store: AuthJsonCredentialStore } {
  const dir = mkdtempSync(join(tmpdir(), "herdr-auth-store-"));
  directories.push(dir);
  const authPath = join(dir, "auth.json");
  return { dir, authPath, store: new AuthJsonCredentialStore(authPath) };
}
function writeAuth(authPath: string, data: unknown): void {
  writeFileSync(authPath, typeof data === "string" ? data : JSON.stringify(data));
}

afterEach(() => {
  lockState.impl = undefined;
  vi.unstubAllEnvs();
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("defaultAuthJsonPath", () => {
  it("follows PI_CODING_AGENT_DIR, expanding ~, and otherwise uses ~/.pi/agent", () => {
    expect(defaultAuthJsonPath({})).toBe(join(homedir(), ".pi", "agent", "auth.json"));
    // An empty override is unset, matching `getAgentDir`'s truthy check — never cwd-relative.
    expect(defaultAuthJsonPath({ PI_CODING_AGENT_DIR: "" })).toBe(join(homedir(), ".pi", "agent", "auth.json"));
    expect(defaultAuthJsonPath({ PI_CODING_AGENT_DIR: "/srv/pi-agent" })).toBe(join("/srv/pi-agent", "auth.json"));
    expect(defaultAuthJsonPath({ PI_CODING_AGENT_DIR: "~" })).toBe(join(homedir(), "auth.json"));
    expect(defaultAuthJsonPath({ PI_CODING_AGENT_DIR: "~/pi-agent" })).toBe(join(homedir(), "pi-agent", "auth.json"));
    expect(defaultAuthJsonPath({ PI_CODING_AGENT_DIR: "~\\pi-agent" })).toBe(join(homedir(), "pi-agent", "auth.json"));
    expect(defaultAuthJsonPath({ PI_CODING_AGENT_DIR: "relative/dir" })).toBe(join("relative/dir", "auth.json"));
  });
});

describe("AuthJsonCredentialStore", () => {
  it("reads and lists a well-formed auth.json, skipping entries that are not credentials", async () => {
    const { authPath, store } = fixture();
    writeAuth(authPath, {
      "openai-codex": oauthEntry,
      opencode: apiKeyEntry,
      "bogus-no-type": { access: "x" },
      "bogus-type": { type: "pat" },
      "bogus-shape": "nope",
      "bogus-null": null,
      "bogus-array": [1],
    });
    await expect(store.read("openai-codex")).resolves.toEqual(oauthEntry);
    await expect(store.read("opencode")).resolves.toEqual(apiKeyEntry);
    for (const providerId of ["bogus-no-type", "bogus-type", "bogus-shape", "bogus-null", "bogus-array", "absent"]) {
      await expect(store.read(providerId)).resolves.toBeUndefined();
    }
    await expect(store.list()).resolves.toEqual([
      { providerId: "openai-codex", type: "oauth" },
      { providerId: "opencode", type: "api_key" },
    ]);
  });

  it("treats a missing, empty, malformed, or non-object file as holding no credentials", async () => {
    const { authPath, store } = fixture();
    await expect(store.read("openai-codex")).resolves.toBeUndefined();
    await expect(store.list()).resolves.toEqual([]);
    // Reads never create the shared file.
    expect(existsSync(authPath)).toBe(false);

    for (const content of ["", "{not json", "[1,2]", '"plain"', "42"]) {
      writeAuth(authPath, content);
      await expect(store.read("openai-codex")).resolves.toBeUndefined();
      await expect(store.list()).resolves.toEqual([]);
    }
  });

  it("persists a modify result, preserves sibling providers, and writes nothing when fn abstains", async () => {
    const { authPath, store } = fixture();
    writeAuth(authPath, { "openai-codex": oauthEntry, opencode: apiKeyEntry });
    const rotated = { ...oauthEntry, access: "fake-access-token-2" } satisfies Credential;

    const seen: Array<Credential | undefined> = [];
    await expect(store.modify("openai-codex", async (current) => { seen.push(current); return rotated; })).resolves.toEqual(rotated);
    expect(seen).toEqual([oauthEntry]);
    expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({ "openai-codex": rotated, opencode: apiKeyEntry });
    await expect(store.read("openai-codex")).resolves.toEqual(rotated);

    const before = readFileSync(authPath, "utf8");
    await expect(store.modify("openai-codex", async () => undefined)).resolves.toEqual(rotated);
    await expect(store.modify("absent", async () => undefined)).resolves.toBeUndefined();
    expect(readFileSync(authPath, "utf8")).toBe(before);

    await expect(store.modify("openai-codex", async () => { throw new Error("refresh failed"); })).rejects.toThrow(/refresh failed/u);
    expect(readFileSync(authPath, "utf8")).toBe(before);
  });

  it("creates the file — and its directory — only when a write path runs", async () => {
    const { dir, authPath, store } = fixture();
    await expect(store.modify("openai-codex", async (current) => current ?? oauthEntry)).resolves.toEqual(oauthEntry);
    expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({ "openai-codex": oauthEntry });

    const nested = join(dir, "deep", "nested");
    const nestedStore = new AuthJsonCredentialStore(join(nested, "auth.json"));
    await expect(nestedStore.delete("anything")).resolves.toBeUndefined();
    expect(existsSync(join(nested, "auth.json"))).toBe(true);
  });

  it("deletes one provider entry and leaves the rest", async () => {
    const { authPath, store } = fixture();
    writeAuth(authPath, { "openai-codex": oauthEntry, opencode: apiKeyEntry });
    await expect(store.delete("opencode")).resolves.toBeUndefined();
    expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({ "openai-codex": oauthEntry });
    await expect(store.read("opencode")).resolves.toBeUndefined();
  });

  it("rejects modify and delete on a malformed file instead of corrupting it", async () => {
    const { authPath, store } = fixture();
    writeAuth(authPath, "{not json");
    await expect(store.modify("openai-codex", async (current) => current ?? oauthEntry)).rejects.toThrow();
    await expect(store.delete("openai-codex")).rejects.toThrow();
    expect(readFileSync(authPath, "utf8")).toBe("{not json");
  });

  it("propagates lock acquisition failure, stops writing when the lock is compromised, and ignores a failed release", async () => {
    const { authPath, store } = fixture();
    writeAuth(authPath, { "openai-codex": oauthEntry });
    const before = readFileSync(authPath, "utf8");

    lockState.impl = async () => { throw new Error("lock unavailable"); };
    await expect(store.modify("openai-codex", async (current) => current)).rejects.toThrow(/lock unavailable/u);

    let releaseReject = false;
    lockState.impl = async (_file, options) => {
      options?.onCompromised?.(new Error("stolen lock"));
      return async () => { if (releaseReject) throw new Error("release failed"); };
    };
    // Compromise known at acquisition: the operation never touches the file.
    await expect(store.modify("openai-codex", async (current) => current)).rejects.toThrow(/stolen lock/u);

    // Compromise arriving inside fn (the OAuth refresh window): no write happens.
    let compromise: ((error: Error) => void) | undefined;
    lockState.impl = async (_file, options) => {
      compromise = (error) => options?.onCompromised?.(error);
      return async () => { if (releaseReject) throw new Error("release failed"); };
    };
    await expect(store.modify("openai-codex", async (current) => { compromise?.(new Error("mid-flight compromise")); return { ...current!, access: "rotated" }; })).rejects.toThrow(/mid-flight compromise/u);
    expect(readFileSync(authPath, "utf8")).toBe(before);

    // A release failure after a successful operation does not mask the result.
    releaseReject = true;
    await expect(store.modify("openai-codex", async () => ({ ...oauthEntry, access: "rotated" }) satisfies Credential)).resolves.toMatchObject({ access: "rotated" });
    expect(JSON.parse(readFileSync(authPath, "utf8"))["openai-codex"].access).toBe("rotated");
  });
});

describe("the builtin supervision model service", () => {
  it("resolves the reviewer model end-to-end through the real catalogue and the auth.json store", async () => {
    const { dir, authPath } = fixture();
    writeAuth(authPath, { "openai-codex": oauthEntry });
    vi.stubEnv("PI_CODING_AGENT_DIR", dir);
    const resolved = await createBuiltinModelService().resolve("openai-codex/gpt-5.6-sol");
    expect(resolved.model.provider).toBe("openai-codex");
    expect(resolved.model.id).toBe("gpt-5.6-sol");
    expect(resolved.apiKey).toBe("fake-access-token");
  });

  it("fails as not-authenticated — never crashes — when the file is missing or malformed", async () => {
    const { dir, authPath } = fixture();
    vi.stubEnv("PI_CODING_AGENT_DIR", dir);
    await expect(createBuiltinModelService().resolve("openai-codex/gpt-5.6-sol")).rejects.toThrow(/not authenticated/u);
    expect(existsSync(authPath)).toBe(false);

    writeAuth(authPath, "{not json");
    await expect(createBuiltinModelService().resolve("openai-codex/gpt-5.6-sol")).rejects.toThrow(/not authenticated/u);

    writeAuth(authPath, { "openai-codex": { type: "api_key", key: "fake" } });
    await expect(createBuiltinModelService().resolve("openai-codex/gpt-5.6-sol")).rejects.toThrow(/not authenticated/u);
  });
});
