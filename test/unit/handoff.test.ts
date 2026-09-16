import { chmod, lstat, link, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileHandle } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import type * as PaneWriteLockModule from "../../src/pane-write-lock.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHandoffAllocator,
  HANDOFF_ARTIFACT_NAME,
  HANDOFF_HEADINGS,
  HANDOFF_MAX_BYTES,
  HANDOFF_STATE_DIR_NAME,
  parseHandoffArtifact,
  readHandoffArtifact,
  readHandoffState,
  renderHandoffContract,
  resolveHandoffNamespace,
  updateHandoffState,
  type HandoffAllocation,
  type HandoffRunIdentity,
  type HandoffState,
} from "../../src/handoff.js";

/**
 * Faults the real filesystem cannot schedule between two of the module's own
 * syscalls (an lstat that succeeds and a later open that does not, a handle
 * whose close rejects after a clean fsync). Every hook is opt-in per test and
 * cleared afterwards, so the unmocked suite still runs against the real tree.
 */
const fsControl = vi.hoisted(() => ({
  failLstat: undefined as undefined | ((path: string) => Error | undefined),
  failMkdir: undefined as undefined | ((path: string) => Error | undefined),
  failOpen: undefined as undefined | ((path: string) => Error | undefined),
  failRename: undefined as undefined | ((path: string) => Error | undefined),
  failReadFile: undefined as undefined | ((path: string) => Error | undefined),
  failRm: undefined as undefined | ((path: string) => Error | undefined),
  readFileResult: undefined as undefined | ((path: string) => string | undefined),
  wrapHandle: undefined as undefined | ((path: string, handle: FileHandle) => FileHandle),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>();
  return {
    ...real,
    lstat: async (path: Parameters<typeof real.lstat>[0], options?: Parameters<typeof real.lstat>[1]) => {
      const error = fsControl.failLstat?.(String(path));
      if (error !== undefined) throw error;
      return real.lstat(path, options as never);
    },
    mkdir: async (path: Parameters<typeof real.mkdir>[0], options?: Parameters<typeof real.mkdir>[1]) => {
      const error = fsControl.failMkdir?.(String(path));
      if (error !== undefined) throw error;
      return real.mkdir(path, options as never);
    },
    rename: async (from: Parameters<typeof real.rename>[0], to: Parameters<typeof real.rename>[1]) => {
      const error = fsControl.failRename?.(String(to));
      if (error !== undefined) throw error;
      return real.rename(from, to);
    },
    rm: async (path: Parameters<typeof real.rm>[0], options?: Parameters<typeof real.rm>[1]) => {
      const error = fsControl.failRm?.(String(path));
      if (error !== undefined) throw error;
      return real.rm(path, options);
    },
    readFile: async (path: Parameters<typeof real.readFile>[0], options?: Parameters<typeof real.readFile>[1]) => {
      const error = fsControl.failReadFile?.(String(path));
      if (error !== undefined) throw error;
      const override = fsControl.readFileResult?.(String(path));
      return override ?? real.readFile(path, options as never);
    },
    open: async (path: Parameters<typeof real.open>[0], flags?: Parameters<typeof real.open>[1], mode?: Parameters<typeof real.open>[2]) => {
      const error = fsControl.failOpen?.(String(path));
      if (error !== undefined) throw error;
      const handle = await real.open(path, flags, mode);
      return fsControl.wrapHandle?.(String(path), handle) ?? handle;
    },
  };
});

/** A lock release that fails after the section really was released. */
const lockControl = vi.hoisted(() => ({ releaseRejects: false }));

vi.mock("../../src/pane-write-lock.js", async (importOriginal) => {
  const real = await importOriginal<typeof PaneWriteLockModule>();
  return {
    ...real,
    acquireFlockHolder: async (options: Parameters<typeof real.acquireFlockHolder>[0]) => {
      const holder = await real.acquireFlockHolder(options);
      if (!lockControl.releaseRejects) return holder;
      return {
        check: () => holder.check(),
        release: async () => {
          await holder.release();
          throw new Error("lock release failed");
        },
      };
    },
  };
});

afterEach(() => {
  fsControl.failLstat = undefined;
  fsControl.failMkdir = undefined;
  fsControl.failOpen = undefined;
  fsControl.failRename = undefined;
  fsControl.failReadFile = undefined;
  fsControl.failRm = undefined;
  fsControl.readFileResult = undefined;
  vi.unstubAllEnvs();
  fsControl.wrapHandle = undefined;
  lockControl.releaseRejects = false;
});

const eacces = () => Object.assign(new Error("EACCES"), { code: "EACCES" });
const eloop = () => Object.assign(new Error("ELOOP"), { code: "ELOOP" });
const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });

/** Delegating handle wrapper: only the overridden method misbehaves. */
function handleWith(handle: FileHandle, overrides: Partial<FileHandle>): FileHandle {
  return {
    writeFile: (...args: Parameters<FileHandle["writeFile"]>) => handle.writeFile(...args),
    sync: () => handle.sync(),
    close: () => handle.close(),
    stat: (...args: Parameters<FileHandle["stat"]>) => handle.stat(...args),
    read: (...args: never[]) => (handle.read as (...a: never[]) => unknown)(...args),
    ...overrides,
  } as unknown as FileHandle;
}

const MODE = 0o7777;

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "herdr-handoff-test-"));
  await chmod(dir, 0o700);
  return dir;
}

/** A realpath-able stand-in for the Herdr socket inside a fresh tmpdir. */
async function socketEnv(base: string): Promise<NodeJS.ProcessEnv> {
  const socketPath = join(base, "herdr.sock");
  await writeFile(socketPath, "");
  return { HERDR_SOCKET_PATH: socketPath };
}

const identity: HandoffRunIdentity = {
  manager: { paneId: "w1:p1", display: "caller", source: "injected" },
  child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi", requestedProfile: "worker-pi", fallbackProfiles: ["worker-claude"] }
};

function allocatorFor(dir: string, endpoint = "test-endpoint") {
  return createHandoffAllocator({ namespace: { dir, endpoint } });
}

const validBody = (marker: string) => `${marker}

## Status
done

## Summary
Implemented the change.

## Changes
- src/a.ts
- src/b.ts

## Verification
npm test passed.

## Blockers
None

## Continuation
None
`;

describe("handoff namespace", () => {
  it("derives the state directory beside the canonical endpoint", async () => {
    const base = await root();
    const env = await socketEnv(base);
    const namespace = await resolveHandoffNamespace(env);
    expect(namespace.dir).toBe(join(base, HANDOFF_STATE_DIR_NAME));
    expect(namespace.endpoint).toBe(join(base, "herdr.sock"));
    expect((await lstat(namespace.dir)).mode & MODE).toBe(0o700);
  });

  it("canonicalizes a symlink-spelled socket path to the same endpoint", async () => {
    const base = await root();
    await socketEnv(base);
    const alias = join(base, "alias.sock");
    await symlink(join(base, "herdr.sock"), alias);
    const namespace = await resolveHandoffNamespace({ HERDR_SOCKET_PATH: alias });
    expect(namespace.endpoint).toBe(join(base, "herdr.sock"));
  });

  it("refuses when the endpoint identity is absent or uncanonicalizable", async () => {
    await expect(resolveHandoffNamespace({})).rejects.toMatchObject({ code: "HANDOFF_UNAVAILABLE" });
    await expect(resolveHandoffNamespace({ HERDR_SOCKET_PATH: join(await root(), "missing.sock") })).rejects.toMatchObject({ code: "HANDOFF_UNAVAILABLE" });
  });
});

describe("run allocation and state", () => {
  it("mints UUID-isolated run directories under the namespace", async () => {
    const dir = await root();
    const allocator = allocatorFor(dir);
    const first = await allocator.allocate();
    const second = await allocator.allocate();
    expect(first.runId).not.toBe(second.runId);
    expect(first.directory).toBe(join(dir, first.runId));
    expect(second.directory).toBe(join(dir, second.runId));
    expect(first.artifactPath).toBe(join(first.directory, HANDOFF_ARTIFACT_NAME));
    expect(first.marker).toBe(`herdr-run:${first.runId}`);
  });

  it("persists a locked 0700 tools directory and an atomic 0600 versioned state", async () => {
    const dir = await root();
    const allocator = allocatorFor(dir, "endpoint-A");
    const run = await allocator.allocate();
    await allocator.persist(run, identity);

    expect((await lstat(run.directory)).mode & MODE).toBe(0o700);
    expect((await lstat(run.toolsDir)).mode & MODE).toBe(0o700);
    const stateStat = await lstat(run.statePath);
    expect(stateStat.isFile() && stateStat.isSymbolicLink()).toBe(false);
    expect(stateStat.mode & MODE).toBe(0o600);
    expect(stateStat.nlink).toBe(1);
    expect((await lstat(run.lockPath)).isFile()).toBe(true);

    const state = JSON.parse(await readFile(run.statePath, "utf8")) as HandoffState;
    expect(state).toEqual({
      v: 1,
      runId: run.runId,
      endpoint: "endpoint-A",
      createdAt: expect.any(String),
      manager: identity.manager,
      child: {
        agentName: "worker",
        agentKind: "pi",
        profileName: "worker-pi",
        requestedProfile: "worker-pi",
        fallbackProfiles: ["worker-claude"],
        paneId: null,
        terminalId: null,
        agentId: null
      },
      nativeSession: null,
      lifecycle: { state: "awaiting_handoff", watermark: null },
      artifact: { path: run.artifactPath, sha256: null, bytes: null, version: 0 },
      repair: { attempts: 0, fence: null }
    });
    // No staging files survive the atomic commit.
    expect((await readdir(run.toolsDir)).sort()).toEqual(["lock", "state.json"]);
  });

  it("refuses to adopt a pre-existing or inconsistent run directory", async () => {
    const dir = await root();
    const allocator = allocatorFor(dir);
    const run = await allocator.allocate();
    await mkdir(run.directory, { recursive: true });
    await expect(allocator.persist(run, identity)).rejects.toMatchObject({ code: "HANDOFF_STORE_FAILED" });

    const foreign = { ...(await allocator.allocate()), directory: join(dir, "not-a-uuid") };
    await expect(allocator.persist(foreign, identity)).rejects.toMatchObject({ code: "HANDOFF_STORE_FAILED" });
    const escaped = { ...(await allocator.allocate()), directory: join(dir, "..", "escape") };
    await expect(allocator.persist(escaped, identity)).rejects.toMatchObject({ code: "HANDOFF_STORE_FAILED" });
  });
});

describe("artifact parser", () => {
  const marker = "herdr-run:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  it("accepts a contract-valid artifact and extracts status and sections", () => {
    const parsed = parseHandoffArtifact(validBody(marker), marker);
    expect(parsed.runId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(parsed.status).toBe("done");
    expect(Object.keys(parsed.sections)).toEqual([...HANDOFF_HEADINGS]);
    expect(parsed.sections.Changes).toBe("- src/a.ts\n- src/b.ts");
  });

  it("rejects missing, duplicate, and foreign markers", () => {
    expect(() => parseHandoffArtifact(validBody("other-marker"), marker)).toThrowError(expect.objectContaining({ code: "HANDOFF_ARTIFACT_INVALID", details: { reason: "marker_missing" } }));
    expect(() => parseHandoffArtifact(`${marker}\n${marker}\n${validBody(marker)}`, marker)).toThrowError(expect.objectContaining({ details: { reason: "marker_duplicate" } }));
    expect(() => parseHandoffArtifact(validBody("herdr-run:bbbbbbbb-0000-0000-0000-000000000000"), marker)).toThrowError(expect.objectContaining({ details: { reason: "foreign_run" } }));
  });

  it("rejects missing, duplicate, extra, and misordered headings", () => {
    const drop = (name: string) => validBody(marker).replace(new RegExp(`## ${name}\\n[^#]*\\n\\n`), "");
    expect(() => parseHandoffArtifact(drop("Summary"), marker)).toThrowError(expect.objectContaining({ details: { reason: "headings_mismatch" } }));
    expect(() => parseHandoffArtifact(validBody(marker).replace("## Continuation", "## Notes\nmore\n\n## Continuation"), marker)).toThrowError(expect.objectContaining({ details: { reason: "headings_mismatch" } }));
    expect(() => parseHandoffArtifact(validBody(marker).replace("## Status\ndone", "## Status\ndone\n\n## Status\nfailed"), marker)).toThrowError(expect.objectContaining({ details: { reason: "headings_mismatch" } }));
    // Misordered: Summary and Verification swapped.
    const swapped = validBody(marker).replace("## Summary\nImplemented the change.", "## Verification\nnpm test passed.").replace("## Verification\nnpm test passed.\n\n## Blockers", "## Summary\nImplemented the change.\n\n## Blockers");
    expect(() => parseHandoffArtifact(swapped, marker)).toThrowError(expect.objectContaining({ details: { reason: "headings_mismatch" } }));
    // A top-level title heading before the marker puts the marker after a heading.
    expect(() => parseHandoffArtifact(`# Title\n\n${validBody(marker)}`, marker)).toThrowError(expect.objectContaining({ details: { reason: "marker_after_heading" } }));
    // A nested heading inside a section is an extra heading.
    expect(() => parseHandoffArtifact(validBody(marker).replace("npm test passed.", "npm test passed.\n\n### Detail\nnested"), marker)).toThrowError(expect.objectContaining({ details: { reason: "headings_mismatch" } }));
  });

  it("rejects empty sections, placeholders, and non-enumerated status", () => {
    expect(() => parseHandoffArtifact(validBody(marker).replace("Implemented the change.", ""), marker)).toThrowError(expect.objectContaining({ details: { reason: "empty:Summary" } }));
    expect(() => parseHandoffArtifact(validBody(marker).replace("Implemented the change.", "TBD"), marker)).toThrowError(expect.objectContaining({ details: { reason: "placeholder:Summary" } }));
    expect(() => parseHandoffArtifact(validBody(marker).replace("done", "finished"), marker)).toThrowError(expect.objectContaining({ details: { reason: "status" } }));
    expect(() => parseHandoffArtifact(validBody(marker).replace("Implemented the change.", "None"), marker)).toThrowError();
  });

  it("rejects a nul byte before any structural parsing", () => {
    expect(() => parseHandoffArtifact(validBody(marker).replace("done", "do\0ne"), marker)).toThrowError(expect.objectContaining({ details: { reason: "nul_byte" } }));
  });

  it("rejects a marker-only body that carries no headings at all", () => {
    expect(() => parseHandoffArtifact(`${marker}\nnothing else\n`, marker)).toThrowError(expect.objectContaining({ details: { reason: "headings_mismatch" } }));
  });

  it("accepts Changes as None or a bullet list and rejects other shapes", () => {
    const withChanges = (body: string) => validBody(marker).replace("- src/a.ts\n- src/b.ts", body);
    expect(parseHandoffArtifact(withChanges("None"), marker).status).toBe("done");
    expect(parseHandoffArtifact(withChanges("- only.ts"), marker).sections.Changes).toBe("- only.ts");
    expect(() => parseHandoffArtifact(withChanges("src/a.ts"), marker)).toThrowError(expect.objectContaining({ details: { reason: "changes" } }));
  });
});

describe("artifact read", () => {
  async function persistedRun(): Promise<{ run: HandoffAllocation; dir: string }> {
    const dir = await root();
    const allocator = allocatorFor(dir);
    const run = await allocator.allocate();
    await allocator.persist(run, identity);
    return { run, dir };
  }

  it("returns the validated artifact with bytes and digest", async () => {
    const { run } = await persistedRun();
    const body = validBody(run.marker);
    await writeFile(run.artifactPath, body, { mode: 0o600 });
    const artifact = await readHandoffArtifact(run);
    expect(artifact.status).toBe("done");
    expect(artifact.bytes).toBe(Buffer.byteLength(body, "utf8"));
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports a missing artifact distinctly from an invalid one", async () => {
    const { run } = await persistedRun();
    await expect(readHandoffArtifact(run)).rejects.toMatchObject({ code: "HANDOFF_ARTIFACT_MISSING" });
    await writeFile(run.artifactPath, "garbage\n", { mode: 0o600 });
    await expect(readHandoffArtifact(run)).rejects.toMatchObject({ code: "HANDOFF_ARTIFACT_INVALID" });
  });

  it("refuses symlink, non-regular, unsafe-mode, and multi-link leaves", async () => {
    const { run, dir } = await persistedRun();
    await writeFile(run.artifactPath, validBody(run.marker), { mode: 0o600 });

    const { run: linked } = await persistedRun();
    await symlink(join(dir, "seed"), linked.artifactPath);
    await expect(readHandoffArtifact(linked)).rejects.toMatchObject({ code: "HANDOFF_ARTIFACT_UNTRUSTED" });

    const { run: dirLeaf } = await persistedRun();
    await mkdir(dirLeaf.artifactPath);
    await expect(readHandoffArtifact(dirLeaf)).rejects.toMatchObject({ code: "HANDOFF_ARTIFACT_UNTRUSTED" });

    const { run: permissive } = await persistedRun();
    await writeFile(permissive.artifactPath, validBody(permissive.marker), { mode: 0o600 });
    await chmod(permissive.artifactPath, 0o666);
    await expect(readHandoffArtifact(permissive)).rejects.toMatchObject({ code: "HANDOFF_ARTIFACT_UNTRUSTED" });

    const { run: hardlinked, dir: secondDir } = await persistedRun();
    await writeFile(hardlinked.artifactPath, validBody(hardlinked.marker), { mode: 0o600 });
    await link(hardlinked.artifactPath, join(secondDir, "alias"));
    await expect(readHandoffArtifact(hardlinked)).rejects.toMatchObject({ code: "HANDOFF_ARTIFACT_UNTRUSTED" });
  });

  it("refuses an oversized artifact before parsing it", async () => {
    const { run } = await persistedRun();
    await writeFile(run.artifactPath, `${run.marker}\n\n## Status\ndone\n\n## Summary\n${"x".repeat(HANDOFF_MAX_BYTES)}\n\n## Changes\nNone\n\n## Verification\nok\n\n## Blockers\nNone\n\n## Continuation\nNone\n`, { mode: 0o600 });
    await expect(readHandoffArtifact(run)).rejects.toMatchObject({ code: "HANDOFF_ARTIFACT_OVERSIZED" });
  });

  it("refuses an artifact inside an untrusted directory", async () => {
    const { run } = await persistedRun();
    await writeFile(run.artifactPath, validBody(run.marker), { mode: 0o600 });
    await chmod(run.directory, 0o777);
    await expect(readHandoffArtifact(run)).rejects.toMatchObject({ code: "HANDOFF_ARTIFACT_UNTRUSTED" });
  });
});

describe("namespace refusals", () => {
  it("refuses a namespace whose parent directory is group- or world-writable", async () => {
    const base = await root();
    const env = await socketEnv(base);
    await chmod(base, 0o777);
    await expect(resolveHandoffNamespace(env)).rejects.toMatchObject({ code: "HANDOFF_UNAVAILABLE", message: expect.stringContaining("is not trusted") });
  });

  it("refuses to adopt a pre-existing world-writable state directory", async () => {
    const base = await root();
    const env = await socketEnv(base);
    await mkdir(join(base, HANDOFF_STATE_DIR_NAME));
    await chmod(join(base, HANDOFF_STATE_DIR_NAME), 0o777);
    await expect(resolveHandoffNamespace(env)).rejects.toMatchObject({ code: "HANDOFF_UNAVAILABLE", message: expect.stringContaining("is not trusted") });
  });

  it("refuses when either the parent or the state directory cannot be stat-ed", async () => {
    const base = await root();
    const env = await socketEnv(base);
    fsControl.failLstat = (path) => path === base ? eacces() : undefined;
    await expect(resolveHandoffNamespace(env)).rejects.toMatchObject({ code: "HANDOFF_UNAVAILABLE", message: "Handoff state directory is unavailable" });

    const dir = join(base, HANDOFF_STATE_DIR_NAME);
    fsControl.failLstat = (path) => path === dir ? eacces() : undefined;
    await expect(resolveHandoffNamespace(env)).rejects.toMatchObject({ code: "HANDOFF_UNAVAILABLE", message: "Handoff state directory is unavailable" });
  });

  it("refuses when the state directory cannot be created", async () => {
    const base = await root();
    const env = await socketEnv(base);
    fsControl.failMkdir = () => eacces();
    await expect(resolveHandoffNamespace(env)).rejects.toMatchObject({ code: "HANDOFF_UNAVAILABLE", message: "Handoff state directory is unavailable" });
  });
});

describe("allocator namespace resolution", () => {
  it("resolves the endpoint namespace itself when none is injected", async () => {
    const base = await root();
    const allocator = createHandoffAllocator({ env: await socketEnv(base) });
    const run = await allocator.allocate();
    expect(run.directory).toBe(join(base, HANDOFF_STATE_DIR_NAME, run.runId));
  });

  it("re-resolves after a namespace failure instead of caching the rejection", async () => {
    const base = await root();
    const allocator = createHandoffAllocator({ env: await socketEnv(base) });
    fsControl.failMkdir = () => eacces();
    await expect(allocator.allocate()).rejects.toMatchObject({ code: "HANDOFF_UNAVAILABLE" });
    fsControl.failMkdir = undefined;
    await expect(allocator.allocate()).resolves.toMatchObject({ namespaceDir: join(base, HANDOFF_STATE_DIR_NAME) });
  });

  it("falls back to the ambient environment when no env is supplied", async () => {
    const base = await root();
    await socketEnv(base);
    vi.stubEnv("HERDR_SOCKET_PATH", join(base, "herdr.sock"));
    await expect(createHandoffAllocator({}).allocate()).resolves.toMatchObject({ namespaceDir: join(base, HANDOFF_STATE_DIR_NAME) });
  });

  it("wraps a non-handoff namespace failure as unavailable", async () => {
    const allocator = createHandoffAllocator({ namespace: () => Promise.reject(new Error("boom")) });
    await expect(allocator.allocate()).rejects.toMatchObject({ code: "HANDOFF_UNAVAILABLE", message: "Handoff namespace is unavailable" });
  });
});

describe("persist refusals", () => {
  it("refuses a run minted under a different endpoint namespace", async () => {
    const dirA = await root();
    const dirB = await root();
    const foreign = await allocatorFor(dirB).allocate();
    await expect(allocatorFor(dirA).persist(foreign, identity)).rejects.toMatchObject({ code: "HANDOFF_STORE_FAILED", message: "Handoff run is outside this endpoint namespace" });
  });

  it("omits an unsafe path from refusal details", async () => {
    const dir = await root();
    const run = { ...(await allocatorFor(dir).allocate()) };
    run.directory = `${run.directory}\nrm -rf /`;
    await expect(readHandoffState(run)).rejects.toMatchObject({ code: "HANDOFF_STORE_FAILED", details: { path: "[path omitted]" } });
  });

  it("refuses an indeterminate or uncreatable run directory", async () => {
    const dir = await root();
    const allocator = allocatorFor(dir);
    const run = await allocator.allocate();
    fsControl.failLstat = (path) => path === run.directory ? eacces() : undefined;
    await expect(allocator.persist(run, identity)).rejects.toMatchObject({ code: "HANDOFF_STORE_FAILED", message: "Handoff run directory is indeterminate" });
    fsControl.failLstat = undefined;
    fsControl.failMkdir = (path) => path === run.directory ? eacces() : undefined;
    await expect(allocator.persist(run, identity)).rejects.toMatchObject({ code: "HANDOFF_STORE_FAILED", message: "Handoff run directory could not be created" });
  });

  it("refuses when the sidecar lock cannot be taken", async () => {
    const dir = await root();
    const allocator = allocatorFor(dir);
    const run = await allocator.allocate();
    fsControl.failLstat = (path) => path === run.toolsDir ? eacces() : undefined;
    await expect(allocator.persist(run, identity)).rejects.toMatchObject({ code: "HANDOFF_STORE_FAILED", details: { path: run.lockPath } });
  });

  it("commits the sidecar even when releasing the lock fails", async () => {
    const dir = await root();
    const allocator = allocatorFor(dir);
    const run = await allocator.allocate();
    lockControl.releaseRejects = true;
    await expect(allocator.persist(run, identity)).resolves.toBeUndefined();
    lockControl.releaseRejects = false;
    expect((await readHandoffState(run)).runId).toBe(run.runId);
  });
});

describe("atomic sidecar write failures", () => {
  async function allocated(): Promise<{ run: HandoffAllocation; persist: () => Promise<void> }> {
    const dir = await root();
    const allocator = allocatorFor(dir);
    const run = await allocator.allocate();
    return { run, persist: () => allocator.persist(run, identity) };
  }

  it("refuses when the staging file cannot be opened", async () => {
    const { run, persist } = await allocated();
    fsControl.failOpen = (path) => path.endsWith(".tmp") ? eacces() : undefined;
    await expect(persist()).rejects.toMatchObject({ code: "HANDOFF_STORE_FAILED", message: "Handoff state could not be staged", details: { path: run.statePath, causeCode: "EACCES" } });
  });

  it("removes the staging file and refuses when the write fails", async () => {
    const { run, persist } = await allocated();
    fsControl.wrapHandle = (path, handle) => path.endsWith(".tmp")
      ? handleWith(handle, { writeFile: async () => { throw eacces(); } })
      : handle;
    await expect(persist()).rejects.toMatchObject({ code: "HANDOFF_STORE_FAILED", message: "Handoff state could not be written" });
    fsControl.wrapHandle = undefined;
    expect(await readdir(run.toolsDir)).toEqual(["lock"]);
  });

  it("still refuses the write when neither the close nor the cleanup succeeds", async () => {
    const { persist } = await allocated();
    fsControl.wrapHandle = (path, handle) => path.endsWith(".tmp")
      ? handleWith(handle, { writeFile: async () => { throw eacces(); }, close: async () => { await handle.close(); throw eacces(); } })
      : handle;
    fsControl.failRm = (path) => path.endsWith(".tmp") ? eacces() : undefined;
    await expect(persist()).rejects.toMatchObject({ code: "HANDOFF_STORE_FAILED", message: "Handoff state could not be written" });
  });

  it("removes the staging file and refuses when the rename fails", async () => {
    const { run, persist } = await allocated();
    fsControl.failRename = (path) => path === run.statePath ? eacces() : undefined;
    await expect(persist()).rejects.toMatchObject({ code: "HANDOFF_STORE_FAILED", message: "Handoff state could not be committed" });
    fsControl.failRename = undefined;
    expect(await readdir(run.toolsDir)).toEqual(["lock"]);
  });

  it("still refuses the rename when the staging cleanup also fails", async () => {
    const { run, persist } = await allocated();
    fsControl.failRename = (path) => path === run.statePath ? eacces() : undefined;
    fsControl.failRm = (path) => path.endsWith(".tmp") ? eacces() : undefined;
    await expect(persist()).rejects.toMatchObject({ code: "HANDOFF_STORE_FAILED", message: "Handoff state could not be committed" });
  });

  it("refuses when the run directory cannot be fsynced", async () => {
    const { run, persist } = await allocated();
    fsControl.failOpen = (path) => path === run.toolsDir ? eacces() : undefined;
    await expect(persist()).rejects.toMatchObject({ code: "HANDOFF_STORE_FAILED", message: "Handoff state directory could not be synced" });
  });

  it("commits even when closing the fsynced directory handle fails", async () => {
    const { run, persist } = await allocated();
    fsControl.wrapHandle = (path, handle) => path === run.toolsDir
      ? handleWith(handle, { close: async () => { await handle.close(); throw eacces(); } })
      : handle;
    await expect(persist()).resolves.toBeUndefined();
    fsControl.wrapHandle = undefined;
    expect((await readHandoffState(run)).runId).toBe(run.runId);
  });
});

describe("sidecar reads and updates", () => {
  async function persistedRun(): Promise<HandoffAllocation> {
    const dir = await root();
    const allocator = allocatorFor(dir);
    const run = await allocator.allocate();
    await allocator.persist(run, identity);
    return run;
  }

  it("refuses malformed and wrong-version sidecar documents", async () => {
    const run = await persistedRun();
    await writeFile(run.statePath, "{not json", { mode: 0o600 });
    await expect(readHandoffState(run)).rejects.toMatchObject({ code: "HANDOFF_STORE_FAILED", message: "Handoff state is malformed" });
    await writeFile(run.statePath, JSON.stringify({ v: 2, runId: run.runId, lifecycle: {}, artifact: {}, repair: {} }), { mode: 0o600 });
    await expect(readHandoffState(run)).rejects.toMatchObject({ code: "HANDOFF_STORE_FAILED", message: "Handoff state is malformed" });
  });

  it("separates a missing sidecar from an indeterminate or untrusted one", async () => {
    const run = await persistedRun();
    await rm(run.statePath);
    await expect(readHandoffState(run)).rejects.toMatchObject({ message: "Handoff state is missing" });

    const second = await persistedRun();
    fsControl.failLstat = (path) => path === second.statePath ? eacces() : undefined;
    await expect(readHandoffState(second)).rejects.toMatchObject({ message: "Handoff state is indeterminate" });
    fsControl.failLstat = undefined;

    await chmod(second.statePath, 0o666);
    await expect(readHandoffState(second)).rejects.toMatchObject({ message: "Handoff state is not trusted" });
  });

  it("refuses a sidecar that cannot be read or that grew past the bound after the stat", async () => {
    const run = await persistedRun();
    fsControl.failReadFile = (path) => path === run.statePath ? eacces() : undefined;
    await expect(readHandoffState(run)).rejects.toMatchObject({ message: "Handoff state could not be read" });
    fsControl.failReadFile = undefined;

    fsControl.readFileResult = (path) => path === run.statePath ? "x".repeat(HANDOFF_MAX_BYTES + 1) : undefined;
    await expect(readHandoffState(run)).rejects.toMatchObject({ message: "Handoff state exceeds the accepted bound" });
  });

  it("refuses an update whose lock cannot be taken and survives a failed release", async () => {
    const run = await persistedRun();
    fsControl.failLstat = (path) => path === run.toolsDir ? eacces() : undefined;
    await expect(updateHandoffState(run, () => undefined)).rejects.toMatchObject({ code: "HANDOFF_STORE_FAILED", details: { path: run.lockPath } });
    fsControl.failLstat = undefined;

    lockControl.releaseRejects = true;
    const state = await updateHandoffState(run, (current) => { current.repair.attempts = 4; });
    expect(state.repair.attempts).toBe(4);
    lockControl.releaseRejects = false;
    expect((await readHandoffState(run)).repair.attempts).toBe(4);
  });
});

describe("artifact read refusals", () => {
  async function persistedRun(): Promise<HandoffAllocation> {
    const dir = await root();
    const allocator = allocatorFor(dir);
    const run = await allocator.allocate();
    await allocator.persist(run, identity);
    return run;
  }

  it("refuses when an enclosing directory cannot be stat-ed", async () => {
    const run = await persistedRun();
    fsControl.failLstat = (path) => path === run.namespaceDir ? eacces() : undefined;
    await expect(readHandoffArtifact(run)).rejects.toMatchObject({ code: "HANDOFF_ARTIFACT_UNTRUSTED", message: "Handoff state directory is unavailable" });
  });

  it("reports an indeterminate leaf distinctly from a missing one", async () => {
    const run = await persistedRun();
    await writeFile(run.artifactPath, validBody(run.marker), { mode: 0o600 });
    fsControl.failLstat = (path) => path === run.artifactPath ? eacces() : undefined;
    await expect(readHandoffArtifact(run)).rejects.toMatchObject({ code: "HANDOFF_ARTIFACT_UNTRUSTED", message: "Handoff artifact is indeterminate" });
  });

  it("maps a lost or symlink-raced open to missing and any other open failure to untrusted", async () => {
    const run = await persistedRun();
    await writeFile(run.artifactPath, validBody(run.marker), { mode: 0o600 });
    for (const error of [eloop(), enoent()]) {
      fsControl.failOpen = (path) => path === run.artifactPath ? error : undefined;
      await expect(readHandoffArtifact(run)).rejects.toMatchObject({ code: "HANDOFF_ARTIFACT_MISSING" });
    }
    fsControl.failOpen = (path) => path === run.artifactPath ? eacces() : undefined;
    await expect(readHandoffArtifact(run)).rejects.toMatchObject({ code: "HANDOFF_ARTIFACT_UNTRUSTED", message: "Handoff artifact is indeterminate" });
  });

  it("refuses a leaf that stopped being trusted between the lstat and the descriptor", async () => {
    const run = await persistedRun();
    await writeFile(run.artifactPath, validBody(run.marker), { mode: 0o600 });
    fsControl.wrapHandle = (path, handle) => path === run.artifactPath
      ? handleWith(handle, { stat: async () => ({ ...(await handle.stat()), isFile: () => true, uid: process.getuid!(), mode: 0o100666, nlink: 1 }) as never })
      : handle;
    await expect(readHandoffArtifact(run)).rejects.toMatchObject({ code: "HANDOFF_ARTIFACT_UNTRUSTED", message: "Handoff artifact is not trusted" });
  });

  it("refuses a leaf that outgrew the bound between the stat and the read", async () => {
    const run = await persistedRun();
    await writeFile(run.artifactPath, validBody(run.marker), { mode: 0o600 });
    fsControl.wrapHandle = (path, handle) => path === run.artifactPath
      ? handleWith(handle, { read: (async () => ({ bytesRead: HANDOFF_MAX_BYTES + 1, buffer: Buffer.alloc(0) })) as never })
      : handle;
    await expect(readHandoffArtifact(run)).rejects.toMatchObject({ code: "HANDOFF_ARTIFACT_OVERSIZED", details: { bytes: HANDOFF_MAX_BYTES + 1 } });
  });

  it("returns the artifact even when closing the descriptor fails", async () => {
    const run = await persistedRun();
    await writeFile(run.artifactPath, validBody(run.marker), { mode: 0o600 });
    fsControl.wrapHandle = (path, handle) => path === run.artifactPath
      ? handleWith(handle, { close: async () => { await handle.close(); throw eacces(); } })
      : handle;
    expect((await readHandoffArtifact(run)).status).toBe("done");
  });
});

describe("contract injection", () => {
  it("renders the exact path, marker, and six headings once", async () => {
    const dir = await root();
    const run = await allocatorFor(dir).allocate();
    const block = renderHandoffContract(run);
    expect(block).toContain(run.artifactPath);
    expect(block).toContain(run.marker);
    for (const heading of HANDOFF_HEADINGS) expect(block).toContain(`## ${heading}`);
    // The injected template is itself a contract-valid skeleton only after the
    // agent replaces the guidance bodies; assert the shape, not acceptance.
    expect(block.match(/## /g)).toHaveLength(6);
  });
});
