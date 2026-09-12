/**
 * A `CredentialStore` backed by the Pi agent's `auth.json`
 * (`$PI_CODING_AGENT_DIR/auth.json`, default `~/.pi/agent/auth.json`).
 *
 * The MCP host runs no Pi model registry, so the supervision reviewer's
 * `Models` resolves credentials through this store against the same file the Pi
 * host already logs into. Sharing the file is the point: the stored
 * `openai-codex` OAuth credential — including its rotating refresh token — has
 * exactly one owner, and refresh writes made here are visible to the Pi host and
 * vice versa.
 *
 * The semantics deliberately mirror `@earendil-works/pi-coding-agent`'s
 * `AuthStorage`/`FileAuthStorageBackend`, which is not reachable through that
 * package's exports map: writes hold a `proper-lockfile` lock on
 * `auth.json.lock` — the same convention the Pi host uses — so a refresh here
 * and a host refresh cannot interleave into a lost update. Two deliberate
 * divergences suit a consumer of another process's file: reads never create the
 * file (a missing file is simply "no credentials"), and the persisted write is
 * atomic (temp file + rename) instead of in place.
 *
 * Degradation contract: `read`/`list` treat a missing or unparseable file as
 * empty, matching `AuthStorage.reload()`'s keep-last-snapshot behaviour.
 * `modify`/`delete` let a parse or I/O failure reject, matching
 * `AuthStorage.modify`'s propagation. Either way the caller inside `Models`
 * surfaces "not authenticated" or an auth `ModelsError`, which the supervisor's
 * review catch turns into `reviewer_degraded` — never a crash.
 *
 * One schema limitation: stored `api_key` `key` values are returned verbatim.
 * Pi additionally resolves `!command` and `$ENV` indirections in that field;
 * this store does not — a `!command` value is passed through unresolved rather
 * than executing a command read from the credentials file. Only providers
 * configured with such indirection are affected; `openai-codex` OAuth, the
 * only credential this service consumes, is unaffected.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { lock } from "proper-lockfile";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

type AuthJsonData = Record<string, Credential>;
type LockOutcome<T> = { result: T; next?: string };

/** The same lock parameters `FileAuthStorageBackend.withLockAsync` uses. */
const LOCK_OPTIONS = {
  stale: 30_000,
  retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 10_000, randomize: true },
} as const;

/** `~` and `~/…` expand against the process home; everything else is already a path. */
function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (/^~[\\/]/u.test(input)) return join(homedir(), input.slice(2));
  return input;
}

/**
 * Where the Pi host keeps credentials on this build (`piConfig.configDir` is
 * `.pi`), honouring the same `PI_CODING_AGENT_DIR` relocation its `getAgentDir`
 * honours. Resolved per construction so tests can redirect it through the env.
 */
export function defaultAuthJsonPath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.PI_CODING_AGENT_DIR;
  // Truthy like upstream's `getAgentDir`: an empty override means unset, not cwd.
  return join(dir ? expandHome(dir) : join(homedir(), ".pi", "agent"), "auth.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A stored entry is a credential only when it carries a known `type` tag. */
function asCredential(value: unknown): Credential | undefined {
  if (!isRecord(value) || (value.type !== "api_key" && value.type !== "oauth")) return undefined;
  return value as Credential;
}

/** Strict parse for the write path: the file is a provider→credential map; anything else is malformed. */
function parseAuthJson(content: string | undefined): AuthJsonData {
  if (!content) return {};
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed)) throw new Error("auth.json is not a provider-to-credential object");
  return parsed as AuthJsonData;
}

export class AuthJsonCredentialStore implements CredentialStore {
  constructor(private readonly authPath: string = defaultAuthJsonPath()) {}

  /** Read-only view of the file: missing or malformed means no credentials. */
  private readData(): AuthJsonData {
    try {
      return parseAuthJson(readFileSync(this.authPath, "utf8"));
    } catch {
      return {};
    }
  }

  private ensureWritableFile(): void {
    const dir = dirname(this.authPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!existsSync(this.authPath)) writeFileSync(this.authPath, "{}", { encoding: "utf-8", mode: 0o600 });
  }

  /** Atomic replace: a torn write must never leave the shared file half-parsed. */
  private writeData(serialized: string): void {
    const temporary = `${this.authPath}.${process.pid}.tmp`;
    writeFileSync(temporary, serialized, { encoding: "utf-8", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.authPath);
  }

  /**
   * Serialized cross-process read-modify-write against the file. The lock is
   * real only while uncompromised: if it is stale-broken mid-operation (a
   * refresh call can outlive `stale`), the operation fails rather than writing
   * unprotected.
   */
  private async withLock<T>(fn: (current: string | undefined) => Promise<LockOutcome<T>>): Promise<T> {
    this.ensureWritableFile();
    let compromised: Error | undefined;
    const release = await lock(this.authPath, {
      ...LOCK_OPTIONS,
      onCompromised: (error) => {
        compromised = error;
      },
    });
    const throwIfCompromised = () => {
      if (compromised) throw compromised;
    };
    try {
      throwIfCompromised();
      const { result, next } = await fn(readFileSync(this.authPath, "utf8"));
      // Compromise during `fn` (the OAuth refresh window) means the write below
      // would run unprotected. Between this check and `writeData` nothing
      // awaits, so a compromise cannot newly arrive afterwards.
      throwIfCompromised();
      if (next !== undefined) this.writeData(next);
      return result;
    } finally {
      try {
        await release();
      } catch {
        // A compromised lock fails its release too; the operation already threw.
      }
    }
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return asCredential(this.readData()[providerId]);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.readData()).flatMap(([providerId, credential]) =>
      asCredential(credential) === undefined ? [] : [{ providerId, type: credential.type }],
    );
  }

  async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    return this.withLock(async (content) => {
      const data = parseAuthJson(content);
      const next = await fn(asCredential(data[providerId]));
      if (next === undefined) return { result: asCredential(data[providerId]) };
      const merged = { ...data, [providerId]: next };
      return { result: next, next: JSON.stringify(merged, null, 2) };
    });
  }

  async delete(providerId: string): Promise<void> {
    await this.withLock(async (content) => {
      const data = parseAuthJson(content);
      delete data[providerId];
      return { result: undefined, next: JSON.stringify(data, null, 2) };
    });
  }
}
