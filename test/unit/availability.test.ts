import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireFlockHolder } from "../../src/pane-write-lock.js";
import type * as PaneWriteLock from "../../src/pane-write-lock.js";
import {
  availability,
  availabilityPaths,
  AVAILABILITY_EVIDENCE_WINDOW_MS,
  classifyLaunchFailure,
  DEFAULT_QUOTA_COOLDOWN_MS,
  LAUNCH_FAILURE_CLASSES,
  recordLaunchFailure,
  type AvailabilityPaths,
  type CooldownRecord,
  type LaunchFailureClass
} from "../../src/availability.js";
import type { AvailabilitySubject, QuotaKey, RunnerEntry, RunnerKind } from "../../src/catalog.js";

/** fs failures the filesystem alone cannot schedule deterministically. */
const fsControl = vi.hoisted(() => ({
  failLstat: undefined as undefined | ((path: string) => unknown),
  lstatResult: undefined as undefined | ((path: string) => object | undefined),
  failOpen: undefined as undefined | ((path: string) => Error | undefined),
  failAppend: undefined as undefined | ((path: string) => Error | undefined),
  failClose: undefined as undefined | (() => Error | undefined),
  failRead: undefined as undefined | ((path: string) => Error | undefined),
  statOverride: undefined as undefined | Record<string, unknown>,
  onClose: undefined as undefined | (() => void)
}));

/** Lease substitutions for holder failures a real flock cannot schedule deterministically. */
const lockControl = vi.hoisted(() => ({
  acquire: undefined as undefined | (() => Promise<{ check(): Promise<void>; release(): Promise<void> }>)
}));

vi.mock("../../src/pane-write-lock.js", async (importOriginal) => {
  const real = await importOriginal<typeof PaneWriteLock>();
  return {
    ...real,
    acquireFlockHolder: (options: Parameters<typeof real.acquireFlockHolder>[0]) =>
      lockControl.acquire === undefined ? real.acquireFlockHolder(options) : lockControl.acquire()
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>();
  const target = (path: unknown) => String(path).endsWith("cooldowns.jsonl");
  return {
    ...real,
    lstat: async (path: Parameters<typeof real.lstat>[0], options?: Parameters<typeof real.lstat>[1]) => {
      const error = fsControl.failLstat?.(String(path));
      if (error !== undefined) throw error;
      const override = target(path) ? fsControl.lstatResult?.(String(path)) : undefined;
      if (override !== undefined) return override;
      return real.lstat(path, options as never);
    },
    open: async (path: Parameters<typeof real.open>[0], flags?: Parameters<typeof real.open>[1], mode?: Parameters<typeof real.open>[2]) => {
      if (target(path)) {
        const error = fsControl.failOpen?.(String(path));
        if (error !== undefined) throw error;
      }
      const handle = await real.open(path, flags, mode);
      if (!target(path)) return handle;
      return {
        stat: async () => {
          const value = await handle.stat();
          if (fsControl.statOverride !== undefined) Object.assign(value, fsControl.statOverride);
          return value;
        },
        appendFile: async (data: string) => {
          const error = fsControl.failAppend?.(String(path));
          if (error !== undefined) throw error;
          return handle.appendFile(data);
        },
        close: async () => {
          fsControl.onClose?.();
          await handle.close();
          const error = fsControl.failClose?.();
          if (error !== undefined) throw error;
        }
      } as typeof handle;
    },
    readFile: async (path: Parameters<typeof real.readFile>[0], options?: Parameters<typeof real.readFile>[1]) => {
      if (target(path)) {
        const error = fsControl.failRead?.(String(path));
        if (error !== undefined) throw error;
      }
      return real.readFile(path, options as never);
    }
  };
});

const dirs: string[] = [];
afterEach(async () => {
  fsControl.failLstat = undefined;
  fsControl.lstatResult = undefined;
  fsControl.failOpen = undefined;
  fsControl.failAppend = undefined;
  fsControl.failClose = undefined;
  fsControl.failRead = undefined;
  fsControl.statOverride = undefined;
  fsControl.onClose = undefined;
  lockControl.acquire = undefined;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempdir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "herdr-availability-"));
  dirs.push(dir);
  return dir;
}

/** Pre-create the record directories owner-only, as `ensureLogDirectory` does on first append. */
async function seedLogDir(root: string): Promise<AvailabilityPaths> {
  const paths = availabilityPaths(root);
  await mkdir(paths.directory, { recursive: true });
  await chmod(join(root, ".herdr"), 0o700);
  await chmod(paths.directory, 0o700);
  return paths;
}

const eacces = (): NodeJS.ErrnoException => Object.assign(new Error("denied"), { code: "EACCES" });
const eio = (): NodeJS.ErrnoException => Object.assign(new Error("io"), { code: "EIO" });

async function readRecords(path: string): Promise<CooldownRecord[]> {
  const content = await readFile(path, "utf8");
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CooldownRecord);
}

/** A quota tuple whose fields contain no runner-name substring. */
const QUOTA: QuotaKey = { provider: "vendex", billingProduct: "plan", account: "acct-1", scope: "account" };

function runner(kind: RunnerKind, quota: Partial<QuotaKey> = {}): RunnerEntry {
  return {
    kind,
    models: [{ model: "model-1" }],
    quota: { ...QUOTA, ...quota },
    defaults: { timeoutMinutes: 30, sessionPersistence: false },
    plumbing: { sessionPersistence: "optional", promptDelivery: "file", skillSelection: "exact", toolSelection: "allowlist" },
    pools: { tools: [], extensions: [], skills: [], plugins: [], mcp: [] }
  };
}

const piCandidate: AvailabilitySubject = { runner: "pi", model: "model-1" };
const claudeCandidate: AvailabilitySubject = { runner: "claude", model: "model-1" };

const T0 = Date.parse("2026-03-01T00:00:00.000Z");
const at = (offsetMs: number) => () => new Date(T0 + offsetMs);

/**
 * Every launch failure code observed at the launch boundary: the module codes
 * surfaced on LaunchError/CliProtocolError and the backend envelope codes that
 * can arrive on `causeCode`, each mapped to exactly one ADR-035 class. The
 * lower_snake rows are provider/backend vocabulary the floor exists to react
 * to; anything unlisted classifies `task-failure` by default.
 */
const OBSERVED_CODES: ReadonlyArray<readonly [string, LaunchFailureClass]> = [
  // Module codes — launch.ts and the collaborators its failures propagate.
  ["ABORTED", "task-failure"],
  ["ADOPT_TARGET_UNQUALIFIED", "task-failure"],
  ["AGENT_NAME_TAKEN", "task-failure"],
  ["ATTACHMENT_QUOTA_EXCEEDED", "task-failure"],
  ["ATTACHMENT_STORE_FAILED", "task-failure"],
  ["ATTACHMENT_TARGET_UNVERIFIED", "unsupported-config"],
  ["AVAILABILITY_LOG_UNAVAILABLE", "transport"],
  ["BACKEND_UNAVAILABLE", "transport"],
  ["BATCH_CHILD_NAME_INVALID", "task-failure"],
  ["BATCH_NAME_COLLISION", "task-failure"],
  ["BATCH_PLACEMENT_INVALID", "task-failure"],
  ["BATCH_ROUTE_EMPTY", "task-failure"],
  ["CHAIN_UNRESOLVABLE", "unsupported-config"],
  ["CLI_INCOMPATIBLE", "transport"],
  ["CLI_NOT_FOUND", "transport"],
  ["CLI_OUTPUT_OVERFLOW", "transport"],
  ["CLI_PROTOCOL_ERROR", "transport"],
  ["CLI_TIMEOUT", "transport"],
  ["HANDOFF_TARGET_UNVERIFIED", "unsupported-config"],
  ["INVALID_CATALOG", "unsupported-config"],
  ["INVALID_INPUT", "task-failure"],
  ["INVALID_PROFILE", "unsupported-config"],
  ["INVALID_PROFILE_OVERRIDE", "unsupported-config"],
  ["LAUNCH_FAILED", "task-failure"],
  ["PANE_WRITE_LOCK_UNAVAILABLE", "transport"],
  ["PAYLOAD_TOO_LARGE", "task-failure"],
  ["PAYLOAD_TOO_LARGE_FOR_INLINE", "task-failure"],
  ["POSTSTATE_CONTRADICTORY", "task-failure"],
  ["POSTSTATE_IDENTITY_CHANGED", "task-failure"],
  ["POSTSTATE_IDENTITY_UNAVAILABLE", "transport"],
  ["POSTSTATE_UNAVAILABLE", "transport"],
  ["PROFILE_CATALOG_UNAVAILABLE", "transport"],
  ["PROFILE_LAUNCH_FROZEN", "transport"],
  ["PROFILE_RESOLUTION_INVALID", "unsupported-config"],
  ["PROFILE_SKILL_BUNDLE_REGISTRY_INVALID", "unsupported-config"],
  ["PROFILE_SKILL_BUNDLE_STALE", "unsupported-config"],
  ["PROFILE_SKILL_PATH_ESCAPES_SCOPE", "unsupported-config"],
  ["PROFILE_SKILL_SOURCE_NOT_APPROVED", "unsupported-config"],
  ["PROFILE_SKILL_TREE_UNSAFE", "unsupported-config"],
  ["PROJECT_SCOPE_DISCOVERY_ERROR", "transport"],
  ["PROMPT_DISPATCH_UNKNOWN", "transport"],
  ["PROMPT_UNCONFIRMED", "task-failure"],
  ["READ_FAILED", "transport"],
  ["READ_MALFORMED", "transport"],
  ["READ_TIMEOUT", "transport"],
  ["READY_TIMEOUT", "task-failure"],
  ["REVIEW_LOG_UNAVAILABLE", "transport"],
  ["ROUTER_LOG_UNAVAILABLE", "transport"],
  ["SUPERVISION_REQUEST_TIMEOUT", "transport"],
  ["SUPERVISION_SOCKET_CLOSED", "transport"],
  ["SUPERVISION_SOCKET_UNAVAILABLE", "transport"],
  ["SUPERVISION_UNAVAILABLE", "transport"],
  ["SUPERVISION_UNCONFIRMED", "task-failure"],
  ["TARGET_BLOCKED", "task-failure"],
  ["TARGET_IDENTITY_CHANGED", "task-failure"],
  ["TARGET_IDENTITY_UNAVAILABLE", "transport"],
  // Backend envelope codes — carried on `causeCode` at agent_start.
  ["agent_blocked", "task-failure"],
  ["agent_name_taken", "task-failure"],
  ["agent_not_found", "task-failure"],
  ["agent_pane_busy", "task-failure"],
  ["agent_prompt_stalled", "task-failure"],
  ["agent_start_failed", "task-failure"],
  ["agent_start_transport_failed", "transport"],
  ["tab_create_failed", "task-failure"],
  ["timeout", "transport"],
  // Provider quota vocabulary — the only codes that may cool a key down.
  ["quota_exceeded", "quota"],
  ["quota_exhausted", "quota"],
  ["insufficient_quota", "quota"],
  ["account_quota_exceeded", "quota"],
  ["billing_exhausted", "quota"],
  ["credits_exhausted", "quota"],
  ["rate_limit", "quota"],
  ["rate_limited", "quota"],
  ["rate_limit_exceeded", "quota"],
  ["too_many_requests", "quota"],
  ["resource_exhausted", "quota"],
  ["overloaded", "quota"],
  ["capacity_exceeded", "quota"],
  ["capacity_exhausted", "quota"],
  // Provider auth vocabulary.
  ["unauthorized", "auth"],
  ["unauthenticated", "auth"],
  ["forbidden", "auth"],
  ["denied", "auth"],
  ["auth_failed", "auth"],
  ["authentication_failed", "auth"],
  ["authentication_required", "auth"],
  ["invalid_credentials", "auth"],
  ["invalid_api_key", "auth"],
  ["credentials_expired", "auth"],
  ["token_expired", "auth"],
  ["login_required", "auth"],
  ["permission_denied", "auth"],
  ["access_denied", "auth"],
  ["account_disabled", "auth"],
  // Provider config vocabulary.
  ["unsupported_config", "unsupported-config"],
  ["invalid_config", "unsupported-config"],
  ["config_not_supported", "unsupported-config"],
  ["unsupported_model", "unsupported-config"],
  ["model_not_found", "unsupported-config"],
  ["unknown_model", "unsupported-config"],
  ["unsupported_capability", "unsupported-config"],
  ["capability_unsupported", "unsupported-config"],
  ["unsupported_operation", "unsupported-config"],
  // Provider interactive-permission vocabulary.
  ["permission_prompt", "permission-prompt"],
  ["permission_required", "permission-prompt"],
  ["interactive_permission_required", "permission-prompt"],
  ["approval_required", "permission-prompt"],
  ["approval_needed", "permission-prompt"],
  ["consent_required", "permission-prompt"],
  ["user_consent_required", "permission-prompt"],
  // Provider transport vocabulary.
  ["transport_failed", "transport"],
  ["connection_failed", "transport"],
  ["connect_failed", "transport"],
  ["connection_refused", "transport"],
  ["network_error", "transport"],
  ["network_unreachable", "transport"],
  ["timed_out", "transport"],
  ["unavailable", "transport"],
  ["deadline_exceeded", "transport"]
];

const NON_QUOTA_CODES = OBSERVED_CODES.filter((entry): entry is readonly [string, Exclude<LaunchFailureClass, "quota">] => entry[1] !== "quota");

describe("classifyLaunchFailure", () => {
  it.each(OBSERVED_CODES)("maps %s to %s", (code, expected) => {
    const result = classifyLaunchFailure(code);
    expect(result).toBe(expected);
    expect(LAUNCH_FAILURE_CLASSES).toContain(result);
  });

  it("covers all six ADR classes", () => {
    expect(new Set(OBSERVED_CODES.map(([, klass]) => klass)).size).toBe(LAUNCH_FAILURE_CLASSES.length);
    for (const klass of LAUNCH_FAILURE_CLASSES) expect(OBSERVED_CODES.some(([, k]) => k === klass)).toBe(true);
  });

  it("classifies an unrecognized code as task-failure, never quota", () => {
    expect(classifyLaunchFailure("429")).toBe("task-failure");
    expect(classifyLaunchFailure("FUTURE_CODE")).toBe("task-failure");
    expect(classifyLaunchFailure("mystery_backend_code")).toBe("task-failure");
    expect(classifyLaunchFailure(42 as never)).toBe("task-failure");
    expect(classifyLaunchFailure(null as never)).toBe("task-failure");
    expect(classifyLaunchFailure({ code: "quota\ninjection" })).toBe("task-failure");
  });

  it("prefers a known causeCode over the surfaced code", () => {
    expect(classifyLaunchFailure({ code: "CLAUDE_API_ERROR", causeCode: "rate_limit" })).toBe("quota");
    expect(classifyLaunchFailure({ code: "LAUNCH_FAILED", causeCode: "quota_exceeded" })).toBe("quota");
    expect(classifyLaunchFailure({ code: "LAUNCH_FAILED", causeCode: "agent_start_transport_failed" })).toBe("transport");
    expect(classifyLaunchFailure({ code: "LAUNCH_FAILED", causeCode: "unauthorized" })).toBe("auth");
  });

  it("falls back to the surfaced code when the cause is unknown or absent", () => {
    expect(classifyLaunchFailure({ code: "CLI_TIMEOUT", causeCode: "mystery" })).toBe("transport");
    expect(classifyLaunchFailure({ code: "LAUNCH_FAILED", causeCode: "mystery" })).toBe("task-failure");
    expect(classifyLaunchFailure({ code: "CLI_TIMEOUT", causeCode: 7 as never })).toBe("transport");
    expect(classifyLaunchFailure({ code: "READY_TIMEOUT" })).toBe("task-failure");
  });
});

describe("recordLaunchFailure", () => {
  it("appends one fixed-schema record and returns the class", async () => {
    const root = await tempdir();
    const paths = availabilityPaths(root);
    expect(paths.records).toBe(join(paths.directory, "cooldowns.jsonl"));
    expect(paths.lock).toBe(join(paths.directory, "cooldowns.lock"));
    const klass = await recordLaunchFailure(piCandidate, runner("pi"), "quota_exceeded", { root, now: at(0) });
    expect(klass).toBe("quota");
    const records = await readRecords(paths.records);
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      timestamp: "2026-03-01T00:00:00.000Z",
      provider: "vendex",
      billingProduct: "plan",
      account: "acct-1",
      scope: "account",
      failureClass: "quota",
      code: "quota_exceeded",
      causeCode: null,
      retryNotBefore: null
    });
    // The key carries no runner field and no runner name can reach the bytes.
    const content = await readFile(paths.records, "utf8");
    expect(content).not.toContain('"runner"');
    expect(content).not.toContain('"pi"');
    expect(content).not.toContain("claude");
    const file = await import("node:fs/promises").then((fs) => fs.lstat(paths.records));
    expect(file.mode & 0o777).toBe(0o600);
    for (const dir of [join(root, ".herdr"), paths.directory]) {
      const stats = await import("node:fs/promises").then((fs) => fs.lstat(dir));
      expect(stats.mode & 0o777).toBe(0o700);
    }
  });

  it("records a causeCode and a source reset signal without fabricating either", async () => {
    const root = await tempdir();
    const reset = T0 + 3_600_000;
    const klass = await recordLaunchFailure(
      piCandidate,
      runner("pi"),
      { code: "LAUNCH_FAILED", causeCode: "insufficient_quota", retryNotBefore: new Date(reset) },
      { root, now: at(0), deadlineMs: 15_000 }
    );
    expect(klass).toBe("quota");
    const records = await readRecords(availabilityPaths(root).records);
    expect(records[0]!.causeCode).toBe("insufficient_quota");
    expect(records[0]!.retryNotBefore).toBe(new Date(reset).toISOString());
  });

  it("accepts a reset signal as ISO string or epoch ms, and null means none", async () => {
    const root = await tempdir();
    await recordLaunchFailure(piCandidate, runner("pi"), { code: "quota_exceeded", retryNotBefore: "2026-03-01T01:00:00.000Z" }, { root, now: at(0) });
    await recordLaunchFailure(piCandidate, runner("pi"), { code: "quota_exceeded", retryNotBefore: T0 + 1_800_000 }, { root, now: at(1) });
    await recordLaunchFailure(piCandidate, runner("pi"), { code: "quota_exceeded", retryNotBefore: null }, { root, now: at(2) });
    const records = await readRecords(availabilityPaths(root).records);
    expect(records.map((entry) => entry.retryNotBefore)).toEqual([
      "2026-03-01T01:00:00.000Z",
      "2026-03-01T00:30:00.000Z",
      null
    ]);
  });

  it("serializes concurrent writers into parseable non-interleaved lines", async () => {
    const root = await tempdir();
    const codes = ["quota_exceeded", "LAUNCH_FAILED", "CLI_TIMEOUT", "unauthorized", "quota_exhausted", "READY_TIMEOUT"];
    await Promise.all(codes.map((code, i) => recordLaunchFailure(piCandidate, runner("pi"), code, { root, now: at(i) })));
    const content = await readFile(availabilityPaths(root).records, "utf8");
    const lines = content.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(codes.length);
    const seen: string[] = [];
    for (const line of lines) {
      const parsed = JSON.parse(line) as CooldownRecord;
      expect(parsed.provider).toBe("vendex");
      seen.push(parsed.code);
    }
    expect(seen.sort()).toEqual([...codes].sort());
  });

  it("keeps the section short: a failed append still releases the lock", async () => {
    const root = await tempdir();
    const paths = availabilityPaths(root);
    let closes = 0;
    fsControl.onClose = () => {
      closes += 1;
    };
    fsControl.failAppend = () => eio();
    await expect(recordLaunchFailure(piCandidate, runner("pi"), "quota_exceeded", { root })).rejects.toMatchObject({
      code: "AVAILABILITY_LOG_UNAVAILABLE"
    });
    expect(closes).toBe(1);
    expect(await readFile(paths.records, "utf8")).toBe("");
    const lease = await acquireFlockHolder({
      lockPath: paths.lock,
      wait: "nonblock",
      readyMarker: "HERDR_TEST_LOCK_READY",
      subject: "Test lock",
      failure: (message) => new Error(message)
    });
    await lease.release();
    fsControl.failAppend = undefined;
    fsControl.onClose = undefined;
    await recordLaunchFailure(piCandidate, runner("pi"), "LAUNCH_FAILED", { root, now: at(0) });
    expect(await readRecords(paths.records)).toHaveLength(1);
  });

  it("fails the append when another process holds the lock, without writing", async () => {
    const root = await tempdir();
    const paths = availabilityPaths(root);
    await recordLaunchFailure(piCandidate, runner("pi"), "LAUNCH_FAILED", { root, now: at(0) });
    const holder = spawn("flock", ["--exclusive", "--nonblock", paths.lock, "--command", "printf HERDR_HELD_READY; cat"], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    try {
      const ready = new Promise<void>((resolve, reject) => {
        holder.stdout.setEncoding("utf8");
        holder.stdout.on("data", (chunk: string) => {
          if (chunk.includes("HERDR_HELD_READY")) resolve();
        });
        holder.once("error", reject);
      });
      await ready;
      await expect(recordLaunchFailure(piCandidate, runner("pi"), "quota_exceeded", { root, waitMs: 50 })).rejects.toMatchObject({
        code: "AVAILABILITY_LOG_UNAVAILABLE"
      });
    } finally {
      holder.stdin.end();
      await once(holder, "exit");
    }
    const records = await readRecords(paths.records);
    expect(records).toHaveLength(1);
    expect(records[0]!.code).toBe("LAUNCH_FAILED");
  });

  it("settles a failed close after the line is appended", async () => {
    const root = await tempdir();
    fsControl.failClose = () => eio();
    await recordLaunchFailure(piCandidate, runner("pi"), "LAUNCH_FAILED", { root, now: at(0) });
    expect(await readRecords(availabilityPaths(root).records)).toHaveLength(1);
  });

  it("settles a failed release after the line is appended", async () => {
    const root = await tempdir();
    lockControl.acquire = async () => ({
      check: async () => {},
      release: async () => {
        throw new Error("wedged holder");
      }
    });
    await recordLaunchFailure(piCandidate, runner("pi"), "LAUNCH_FAILED", { root, now: at(0) });
    expect(await readRecords(availabilityPaths(root).records)).toHaveLength(1);
  });

  it("surfaces a failed acquisition without writing", async () => {
    const root = await tempdir();
    lockControl.acquire = async () => {
      throw new Error("no flock binary");
    };
    await expect(recordLaunchFailure(piCandidate, runner("pi"), "quota_exceeded", { root })).rejects.toMatchObject({
      code: "AVAILABILITY_LOG_UNAVAILABLE"
    });
    await expect(readFile(availabilityPaths(root).records, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("recordLaunchFailure refusal", () => {
  const refusalCases: Array<{ name: string; failure: unknown; candidate?: AvailabilitySubject; runner?: RunnerEntry }> = [
    { name: "a relative root", failure: "quota_exceeded" },
    { name: "a non-code failure", failure: 42 },
    { name: "a null failure", failure: null },
    { name: "a code with untrusted text", failure: { code: "quota exceeded: contact billing" } },
    { name: "an empty code", failure: { code: "" } },
    { name: "a non-string code", failure: { code: 42 } },
    { name: "a bad causeCode", failure: { code: "LAUNCH_FAILED", causeCode: "not a code" } },
    { name: "an unparseable reset signal", failure: { code: "quota_exceeded", retryNotBefore: "soon-ish" } },
    { name: "a nonfinite reset signal", failure: { code: "quota_exceeded", retryNotBefore: Number.NaN } },
    { name: "an out-of-range reset signal", failure: { code: "quota_exceeded", retryNotBefore: Number.MAX_VALUE } },
    { name: "an invalid Date reset signal", failure: { code: "quota_exceeded", retryNotBefore: new Date(Number.NaN) } },
    { name: "a reset signal of the wrong type", failure: { code: "quota_exceeded", retryNotBefore: true } }
  ];

  it.each(refusalCases)("refuses $name", async ({ failure }) => {
    const root = await tempdir();
    const options = failure === "quota_exceeded" ? { root: "relative/root" } : { root };
    await expect(recordLaunchFailure(piCandidate, runner("pi"), failure as never, options)).rejects.toMatchObject({
      code: "AVAILABILITY_LOG_UNAVAILABLE"
    });
  });

  const badKeys: Array<{ name: string; quota: unknown }> = [
    { name: "a non-string provider", quota: { ...QUOTA, provider: 7 } },
    { name: "an empty billingProduct", quota: { ...QUOTA, billingProduct: "" } },
    { name: "an account carrying a newline", quota: { ...QUOTA, account: "acct\n1" } },
    { name: "an oversized scope", quota: { ...QUOTA, scope: "x".repeat(241) } }
  ];

  it.each(badKeys)("refuses $name", async ({ quota }) => {
    const root = await tempdir();
    await expect(
      recordLaunchFailure(piCandidate, runner("pi", quota as Partial<QuotaKey>), "quota_exceeded", { root })
    ).rejects.toMatchObject({ code: "AVAILABILITY_LOG_UNAVAILABLE" });
    await expect(readFile(availabilityPaths(root).records, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("wraps a non-availability failure as AVAILABILITY_LOG_UNAVAILABLE", async () => {
    const root = await tempdir();
    await expect(
      recordLaunchFailure(piCandidate, runner("pi"), "quota_exceeded", {
        root,
        now: () => {
          throw new Error("clock broken");
        }
      })
    ).rejects.toMatchObject({ code: "AVAILABILITY_LOG_UNAVAILABLE", message: "Availability cooldown record is unavailable" });
  });

  it("surfaces directory and file trust failures like the router log", async () => {
    const root = await tempdir();
    const paths = availabilityPaths(root);
    fsControl.failLstat = (path) => (path === join(root, ".herdr") ? eacces() : undefined);
    await expect(recordLaunchFailure(piCandidate, runner("pi"), "quota_exceeded", { root })).rejects.toMatchObject({
      code: "AVAILABILITY_LOG_UNAVAILABLE"
    });
    fsControl.failLstat = (path) => (path === paths.records ? eacces() : undefined);
    await expect(recordLaunchFailure(piCandidate, runner("pi"), "quota_exceeded", { root })).rejects.toMatchObject({
      code: "AVAILABILITY_LOG_UNAVAILABLE"
    });
    fsControl.failLstat = (path) => (path === paths.records ? null : undefined);
    await expect(recordLaunchFailure(piCandidate, runner("pi"), "quota_exceeded", { root })).rejects.toMatchObject({
      code: "AVAILABILITY_LOG_UNAVAILABLE"
    });
    fsControl.failLstat = undefined;

    fsControl.failOpen = () => eacces();
    await expect(recordLaunchFailure(piCandidate, runner("pi"), "quota_exceeded", { root })).rejects.toMatchObject({
      code: "AVAILABILITY_LOG_UNAVAILABLE"
    });
    fsControl.failOpen = undefined;

    fsControl.statOverride = { mode: 0o644 };
    await expect(recordLaunchFailure(piCandidate, runner("pi"), "quota_exceeded", { root })).rejects.toMatchObject({
      code: "AVAILABILITY_LOG_UNAVAILABLE"
    });
    fsControl.statOverride = { isFile: () => false };
    await expect(recordLaunchFailure(piCandidate, runner("pi"), "quota_exceeded", { root })).rejects.toMatchObject({
      code: "AVAILABILITY_LOG_UNAVAILABLE"
    });
    fsControl.statOverride = { uid: process.getuid!() + 1 };
    await expect(recordLaunchFailure(piCandidate, runner("pi"), "quota_exceeded", { root })).rejects.toMatchObject({
      code: "AVAILABILITY_LOG_UNAVAILABLE"
    });
    fsControl.statOverride = undefined;
    expect(await readFile(paths.records, "utf8")).toBe("");
  });

  it("refuses a foreign-owned, symlinked, or world-writable record file", async () => {
    const root = await tempdir();
    const paths = await seedLogDir(root);
    const elsewhere = join(root, "elsewhere.jsonl");
    await writeFile(elsewhere, "", { mode: 0o600 });
    await symlink(elsewhere, paths.records);
    await expect(recordLaunchFailure(piCandidate, runner("pi"), "quota_exceeded", { root })).rejects.toMatchObject({
      code: "AVAILABILITY_LOG_UNAVAILABLE"
    });
    expect(await readFile(elsewhere, "utf8")).toBe("");

    await rm(paths.records);
    await mkdir(paths.records);
    await expect(recordLaunchFailure(piCandidate, runner("pi"), "quota_exceeded", { root })).rejects.toMatchObject({
      code: "AVAILABILITY_LOG_UNAVAILABLE"
    });
    await rm(paths.records, { recursive: true });

    await writeFile(paths.records, "", { mode: 0o600 });
    await chmod(paths.records, 0o666);
    await expect(recordLaunchFailure(piCandidate, runner("pi"), "quota_exceeded", { root })).rejects.toMatchObject({
      code: "AVAILABILITY_LOG_UNAVAILABLE"
    });
    expect(await readFile(paths.records, "utf8")).toBe("");
    await chmod(paths.records, 0o600);

    fsControl.lstatResult = () => ({ isFile: () => true, isSymbolicLink: () => false, uid: process.getuid!() + 1, mode: 0o600 });
    await expect(recordLaunchFailure(piCandidate, runner("pi"), "quota_exceeded", { root })).rejects.toMatchObject({
      code: "AVAILABILITY_LOG_UNAVAILABLE"
    });
    fsControl.lstatResult = undefined;
  });

  it("refuses a symlinked, world-writable, or non-directory .herdr", async () => {
    for (const kind of ["symlink", "writable", "file"] as const) {
      const root = await tempdir();
      const dotHerdr = join(root, ".herdr");
      if (kind === "symlink") await symlink(join(root, "elsewhere"), dotHerdr);
      else if (kind === "writable") await mkdir(dotHerdr, { mode: 0o777 });
      else await writeFile(dotHerdr, "", { mode: 0o600 });
      await expect(recordLaunchFailure(piCandidate, runner("pi"), "quota_exceeded", { root })).rejects.toMatchObject({
        code: "AVAILABILITY_LOG_UNAVAILABLE"
      });
    }
  });

  it("refuses an untrusted availability directory", async () => {
    const root = await tempdir();
    const paths = availabilityPaths(root);
    await mkdir(join(root, ".herdr"), { mode: 0o700 });
    await mkdir(paths.directory, { mode: 0o777 });
    await expect(recordLaunchFailure(piCandidate, runner("pi"), "quota_exceeded", { root })).rejects.toMatchObject({
      code: "AVAILABILITY_LOG_UNAVAILABLE"
    });
  });

  it("surfaces a directory creation failure", async () => {
    const file = join(await tempdir(), "not-a-dir");
    await writeFile(file, "", { mode: 0o600 });
    await expect(recordLaunchFailure(piCandidate, runner("pi"), "quota_exceeded", { root: file })).rejects.toMatchObject({
      code: "AVAILABILITY_LOG_UNAVAILABLE"
    });
  });
});

describe("availability", () => {
  it("answers unknown when no record exists, and unknown is never exhausted", async () => {
    const root = await tempdir();
    const result = await availability(piCandidate, runner("pi"), { root });
    expect(result).toEqual({ status: "unknown", retryNotBefore: null, evidence: { records: 0 } });
  });

  it("marks a quota failure known-exhausted with a null retryNotBefore when the source gave no reset signal", async () => {
    const root = await tempdir();
    await recordLaunchFailure(piCandidate, runner("pi"), "quota_exceeded", { root, now: at(0) });
    const result = await availability(piCandidate, runner("pi"), { root, now: at(60_000) });
    expect(result.status).toBe("known-exhausted");
    expect(result.retryNotBefore).toBeNull();
    expect(result.evidence).toMatchObject({ records: 1, lastClass: "quota", lastCode: "quota_exceeded" });
  });

  it("reports the source's own reset signal when a quota failure carries one", async () => {
    const root = await tempdir();
    const signal = "2026-03-01T01:00:00.000Z";
    await recordLaunchFailure(piCandidate, runner("pi"), { code: "quota_exceeded", retryNotBefore: signal }, { root, now: at(0) });
    const result = await availability(piCandidate, runner("pi"), { root, now: at(60_000) });
    expect(result.status).toBe("known-exhausted");
    expect(result.retryNotBefore).toBe(signal);
  });

  it("shares the cooldown across runner names but not across accounts", async () => {
    const root = await tempdir();
    await recordLaunchFailure(piCandidate, runner("pi"), "quota_exceeded", { root, now: at(0) });
    // A different runner name over the identical provider/billingProduct/account/scope tuple is the same key.
    const shared = await availability(claudeCandidate, runner("claude"), { root, now: at(60_000) });
    expect(shared.status).toBe("known-exhausted");
    // A different account on the same provider is a different key.
    const otherAccount = await availability(piCandidate, runner("pi", { account: "acct-2" }), { root, now: at(60_000) });
    expect(otherAccount.status).toBe("unknown");
    // A model-entry account override lands on the overridden key, not the runner's default.
    const modelKey = { ...runner("pi"), models: [{ model: "model-1", quota: { account: "acct-2" } }] };
    const overridden = await availability(piCandidate, modelKey, { root, now: at(60_000) });
    expect(overridden.status).toBe("unknown");
  });

  it("honors cooldown expiry: a past reset signal or an elapsed fallback quarantine no longer exhausts", async () => {
    const root = await tempdir();
    // Signal expired five minutes ago; the record is still recent evidence → degraded.
    await recordLaunchFailure(
      piCandidate,
      runner("pi"),
      { code: "quota_exceeded", retryNotBefore: "2026-03-01T00:05:00.000Z" },
      { root, now: at(0) }
    );
    const afterSignal = await availability(piCandidate, runner("pi"), { root, now: at(10 * 60_000) });
    expect(afterSignal.status).toBe("degraded");
    expect(afterSignal.retryNotBefore).toBeNull();
    // Past the evidence window the expired record stops counting at all.
    const longAfter = await availability(piCandidate, runner("pi"), { root, now: at(AVAILABILITY_EVIDENCE_WINDOW_MS + 1) });
    expect(longAfter.status).toBe("unknown");

    const root2 = await tempdir();
    await recordLaunchFailure(piCandidate, runner("pi"), "quota_exceeded", { root: root2, now: at(0) });
    const duringFloor = await availability(piCandidate, runner("pi"), { root: root2, now: at(DEFAULT_QUOTA_COOLDOWN_MS - 1) });
    expect(duringFloor.status).toBe("known-exhausted");
    expect(duringFloor.retryNotBefore).toBeNull();
    const afterFloor = await availability(piCandidate, runner("pi"), { root: root2, now: at(DEFAULT_QUOTA_COOLDOWN_MS + 1) });
    expect(afterFloor.status).toBe("unknown");
  });

  it("reports the furthest future signal when several quota records are active", async () => {
    const root = await tempdir();
    await recordLaunchFailure(piCandidate, runner("pi"), { code: "quota_exceeded", retryNotBefore: "2026-03-01T01:00:00.000Z" }, { root, now: at(0) });
    await recordLaunchFailure(piCandidate, runner("pi"), "quota_exhausted", { root, now: at(1) });
    await recordLaunchFailure(piCandidate, runner("pi"), { code: "rate_limited", retryNotBefore: "2026-03-01T02:00:00.000Z" }, { root, now: at(2) });
    const result = await availability(piCandidate, runner("pi"), { root, now: at(60_000) });
    expect(result.status).toBe("known-exhausted");
    expect(result.retryNotBefore).toBe("2026-03-01T02:00:00.000Z");
    expect(result.evidence.records).toBe(3);
  });

  it("marks a recent transport failure local-capacity-limited and other recent failures degraded", async () => {
    const root = await tempdir();
    await recordLaunchFailure(piCandidate, runner("pi"), "CLI_TIMEOUT", { root, now: at(0) });
    const limited = await availability(piCandidate, runner("pi"), { root, now: at(60_000) });
    expect(limited.status).toBe("local-capacity-limited");
    expect(limited.retryNotBefore).toBeNull();

    const root2 = await tempdir();
    await recordLaunchFailure(piCandidate, runner("pi"), "LAUNCH_FAILED", { root: root2, now: at(0) });
    const degraded = await availability(piCandidate, runner("pi"), { root: root2, now: at(60_000) });
    expect(degraded.status).toBe("degraded");
    expect(degraded.retryNotBefore).toBeNull();

    // A transport failure outside the evidence window no longer limits the key.
    const settled = await availability(piCandidate, runner("pi"), { root, now: at(AVAILABILITY_EVIDENCE_WINDOW_MS + 1) });
    expect(settled.status).toBe("unknown");
  });

  it("lets an active quota cooldown take precedence over local capacity evidence", async () => {
    const root = await tempdir();
    await recordLaunchFailure(piCandidate, runner("pi"), "CLI_TIMEOUT", { root, now: at(0) });
    await recordLaunchFailure(piCandidate, runner("pi"), "quota_exceeded", { root, now: at(1) });
    const result = await availability(piCandidate, runner("pi"), { root, now: at(60_000) });
    expect(result.status).toBe("known-exhausted");
  });

  it("never sets a cooldown for a non-quota failure — every non-quota class", async () => {
    const root = await tempdir();
    for (const [index, [code, expected]] of NON_QUOTA_CODES.entries()) {
      const klass = await recordLaunchFailure(piCandidate, runner("pi"), code, { root, now: at(index) });
      expect(klass).toBe(expected);
      const result = await availability(piCandidate, runner("pi"), { root, now: at(index + 1) });
      expect(result.status).not.toBe("known-exhausted");
      expect(result.retryNotBefore).toBeNull();
    }
    // All records were written under the same key and none excluded it.
    const final = await availability(piCandidate, runner("pi"), { root, now: at(NON_QUOTA_CODES.length) });
    expect(final.status).toBe("local-capacity-limited");
    expect(final.evidence.records).toBe(NON_QUOTA_CODES.length);
  });

  it("records a reset signal on a non-quota failure without exhausting the key", async () => {
    const root = await tempdir();
    await recordLaunchFailure(
      piCandidate,
      runner("pi"),
      { code: "LAUNCH_FAILED", retryNotBefore: "2026-03-01T02:00:00.000Z" },
      { root, now: at(0) }
    );
    const result = await availability(piCandidate, runner("pi"), { root, now: at(60_000) });
    expect(result.status).toBe("degraded");
    expect(result.retryNotBefore).toBeNull();
  });

  it("ignores records keyed to a different tuple", async () => {
    const root = await tempdir();
    await recordLaunchFailure(piCandidate, runner("pi", { account: "acct-2" }), "quota_exceeded", { root, now: at(0) });
    const result = await availability(piCandidate, runner("pi"), { root, now: at(60_000) });
    expect(result.status).toBe("unknown");
    expect(result.evidence.records).toBe(0);
  });

  it("answers unknown when the record file is unreadable or untrusted, never exhausted", async () => {
    const root = await tempdir();
    const paths = await seedLogDir(root);
    // Unreadable bytes — the file must exist for the read path to reach it.
    await writeFile(paths.records, "", { mode: 0o600 });
    fsControl.failRead = () => eacces();
    const unreadable = await availability(piCandidate, runner("pi"), { root });
    expect(unreadable.status).toBe("unknown");
    expect(unreadable.evidence.unreadable).toBe(true);
    fsControl.failRead = undefined;

    // Indeterminate stat.
    fsControl.failLstat = (path) => (path === paths.records ? eacces() : undefined);
    expect((await availability(piCandidate, runner("pi"), { root })).status).toBe("unknown");
    fsControl.failLstat = (path) => (path === paths.records ? null : undefined);
    expect((await availability(piCandidate, runner("pi"), { root })).status).toBe("unknown");
    fsControl.failLstat = undefined;

    // Untrusted shapes.
    await rm(paths.records);
    await mkdir(paths.records);
    expect((await availability(piCandidate, runner("pi"), { root })).status).toBe("unknown");
    await rm(paths.records, { recursive: true });
    const elsewhere = join(root, "elsewhere.jsonl");
    await writeFile(elsewhere, "", { mode: 0o600 });
    await symlink(elsewhere, paths.records);
    expect((await availability(piCandidate, runner("pi"), { root })).status).toBe("unknown");
    await rm(paths.records);
    await writeFile(paths.records, "", { mode: 0o600 });
    await chmod(paths.records, 0o666);
    expect((await availability(piCandidate, runner("pi"), { root })).status).toBe("unknown");
    await chmod(paths.records, 0o600);
    fsControl.lstatResult = () => ({ isFile: () => true, isSymbolicLink: () => false, uid: process.getuid!() + 1, mode: 0o600 });
    expect((await availability(piCandidate, runner("pi"), { root })).status).toBe("unknown");
    fsControl.lstatResult = undefined;
  });

  it("skips malformed or foreign lines but still honors valid records", async () => {
    const root = await tempdir();
    const paths = await seedLogDir(root);
    const valid = {
      timestamp: "2026-03-01T00:00:00.000Z",
      provider: "vendex",
      billingProduct: "plan",
      account: "acct-1",
      scope: "account",
      failureClass: "quota",
      code: "quota_exceeded",
      causeCode: null,
      retryNotBefore: null
    };
    const malformed: unknown[] = [
      "not json{",
      null,
      42,
      [1, 2],
      { only: "one" },
      { ...valid, extra: "field" },
      { ...valid, timestamp: 7 },
      { ...valid, timestamp: "not-a-date" },
      { ...valid, provider: 7 },
      { ...valid, provider: "" },
      { ...valid, billingProduct: 7 },
      { ...valid, billingProduct: "" },
      { ...valid, account: 7 },
      { ...valid, account: "" },
      { ...valid, scope: 7 },
      { ...valid, scope: "" },
      { ...valid, failureClass: 7 },
      { ...valid, failureClass: "bogus" },
      { ...valid, code: 7 },
      { ...valid, code: "bad code!" },
      { ...valid, causeCode: 7 },
      { ...valid, causeCode: "bad code!" },
      { ...valid, retryNotBefore: 7 },
      { ...valid, retryNotBefore: "not-a-date" }
    ];
    const lines = malformed.map((entry) => JSON.stringify(entry));
    lines.unshift("{torn-line");
    lines.push(JSON.stringify(valid));
    await writeFile(paths.records, `${lines.join("\n")}\n`, { mode: 0o600 });
    const result = await availability(piCandidate, runner("pi"), { root, now: at(60_000) });
    expect(result.status).toBe("known-exhausted");
    expect(result.evidence.malformed).toBe(malformed.length + 1);
    expect(result.evidence.records).toBe(1);
  });

  it("refuses untrusted inputs with the typed error", async () => {
    const root = await tempdir();
    await expect(availability(piCandidate, runner("pi"), { root: "relative/root" })).rejects.toMatchObject({
      code: "AVAILABILITY_LOG_UNAVAILABLE"
    });
    await expect(
      availability(piCandidate, runner("pi", { account: "acct\n2" }), { root })
    ).rejects.toMatchObject({ code: "AVAILABILITY_LOG_UNAVAILABLE" });
    await expect(availability(piCandidate, runner("pi"), { root, now: () => new Date(Number.NaN) })).rejects.toMatchObject({
      code: "AVAILABILITY_LOG_UNAVAILABLE"
    });
    // An unexpected failure — a null runner — is wrapped, not leaked.
    await expect(availability(piCandidate, null as never, { root })).rejects.toMatchObject({
      code: "AVAILABILITY_LOG_UNAVAILABLE"
    });
  });
});
