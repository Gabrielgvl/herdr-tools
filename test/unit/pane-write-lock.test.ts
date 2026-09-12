import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type * as FsPromises from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireFlockHolder,
  createPaneWriteGuard,
  PANE_WRITE_FENCE_MAX_SPENT,
  PANE_WRITE_LOCK_DIR_NAME,
  PaneWriteLockError,
  paneWritePaths,
  resolvePaneWriteNamespace,
  type PaneWriteNamespace,
} from "../../src/pane-write-lock.js";

const IDENTITY = "a".repeat(64);
const IDENTITY_B = "d".repeat(64);
const FRAME = "b".repeat(64);
const FRAME_B = "c".repeat(64);
const PANE = "w1:p9";

/** lstat failures the filesystem alone cannot schedule deterministically. */
const fsControl = vi.hoisted(() => ({
  failLstat: undefined as undefined | ((path: string) => Error | undefined),
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
  };
});

const dirs: string[] = [];
afterEach(async () => {
  fsControl.failLstat = undefined;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempdir(prefix = "herdr-pane-lock-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const namespace = (dir: string, endpoint = "endpoint-a"): PaneWriteNamespace => ({ dir, endpoint });
const guardFor = (dir: string, endpoint = "endpoint-a") => createPaneWriteGuard({ namespace: namespace(dir, endpoint) });
const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
const eacces = () => Object.assign(new Error("EACCES"), { code: "EACCES" });

describe("resolvePaneWriteNamespace", () => {
  it("derives the shared directory from the canonicalized endpoint", async () => {
    const root = await tempdir();
    const socket = join(root, "herdr.sock");
    await writeFile(socket, "");
    const resolved = await resolvePaneWriteNamespace({ HERDR_SOCKET_PATH: socket });
    expect(resolved.endpoint).toBe(await realpath(socket));
    expect(resolved.dir).toBe(join(root, PANE_WRITE_LOCK_DIR_NAME));
    // The directory exists owner-only and two panes get distinct lock files.
    const a = paneWritePaths(resolved, "w1:p1");
    const b = paneWritePaths(resolved, "w1:p2");
    expect(a.lockPath).not.toBe(b.lockPath);
    expect(a.fencePath).not.toBe(b.fencePath);
    // A symlink-spelled endpoint resolves to the same canonical namespace.
    const alias = join(root, "alias.sock");
    await symlink(socket, alias);
    const aliased = await resolvePaneWriteNamespace({ HERDR_SOCKET_PATH: alias });
    expect(aliased.endpoint).toBe(resolved.endpoint);
  });

  it("fails closed when the endpoint is missing or cannot be canonicalized", async () => {
    await expect(resolvePaneWriteNamespace({})).rejects.toMatchObject({ code: "PANE_WRITE_LOCK_UNAVAILABLE", message: "Pane write lock endpoint is unavailable" });
    const root = await tempdir();
    await expect(resolvePaneWriteNamespace({ HERDR_SOCKET_PATH: join(root, "missing.sock") }))
      .rejects.toMatchObject({ message: "Pane write lock endpoint cannot be canonicalized" });
  });

  it("fails closed on an unavailable, untrusted, or unwritable namespace directory", async () => {
    const root = await tempdir();
    const socket = join(root, "herdr.sock");
    await writeFile(socket, "");
    const env = { HERDR_SOCKET_PATH: socket };

    // Missing parent: the lock directory cannot be classified.
    await expect(resolvePaneWriteNamespace(env, join(root, "missing", "locks")))
      .rejects.toMatchObject({ message: "Pane write lock directory is unavailable" });
    // World-writable parent: a stranger could swap the lock dir inode.
    const writable = join(root, "world-writable");
    await mkdir(writable, { mode: 0o777 });
    await expect(resolvePaneWriteNamespace(env, join(writable, "locks")))
      .rejects.toMatchObject({ message: expect.stringContaining("directory is not trusted") });
    // Unwritable parent: mkdir cannot create the lock directory.
    const readonly = join(root, "readonly");
    await mkdir(readonly, { mode: 0o500 });
    await expect(resolvePaneWriteNamespace(env, join(readonly, "locks")))
      .rejects.toMatchObject({ message: "Pane write lock directory is unavailable" });
    // A regular file where the directory belongs survives mkdir (EEXIST) but is not a directory.
    const filePath = join(root, "a-file");
    await writeFile(filePath, "", { mode: 0o600 });
    await expect(resolvePaneWriteNamespace(env, filePath))
      .rejects.toMatchObject({ message: expect.stringContaining("directory is not trusted") });
    // The post-mkdir classification itself failing is "unavailable", never a fallback.
    const fresh = join(root, "locks");
    fsControl.failLstat = (path) => (path === fresh ? enoent() : undefined);
    await expect(resolvePaneWriteNamespace(env, fresh))
      .rejects.toMatchObject({ message: "Pane write lock directory is unavailable" });
    fsControl.failLstat = undefined;
  });
});

describe("createPaneWriteGuard", () => {
  it("holds the section across proof/fence/key and releases idempotently", async () => {
    const dir = await tempdir();
    const guard = guardFor(dir);
    const lease = await guard.acquire(PANE);
    await lease.check();
    expect(await lease.fence.isSpent(IDENTITY, FRAME)).toBe(false);
    await lease.fence.record(IDENTITY, FRAME);
    expect(await lease.fence.isSpent(IDENTITY, FRAME)).toBe(true);
    expect(await lease.fence.isSpent(IDENTITY, FRAME_B)).toBe(false);
    expect(await lease.fence.isSpent(IDENTITY_B, FRAME)).toBe(false);
    await lease.release();
    await lease.release();
    // The fence outlives the lease: the spent frame is still recorded.
    const next = await guard.acquire(PANE, { waitMs: 250, deadlineMs: 2_000 });
    expect(await next.fence.isSpent(IDENTITY, FRAME)).toBe(true);
    await next.release();
  });

  it("serializes same-pane sections while distinct panes and endpoints proceed", async () => {
    const dir = await tempdir();
    const guard = guardFor(dir);
    const lease = await guard.acquire(PANE);
    try {
      await expect(guard.acquire(PANE, { waitMs: 150 })).rejects.toMatchObject({ code: "PANE_WRITE_LOCK_UNAVAILABLE" });
      const otherPane = await guard.acquire("w1:p10");
      await otherPane.release();
      const otherEndpoint = await guardFor(dir, "endpoint-b").acquire(PANE, { waitMs: 250 });
      await otherEndpoint.release();
    } finally {
      await lease.release();
    }
  });

  it("does not cache a failed namespace resolution", async () => {
    const dir = await tempdir();
    let attempts = 0;
    const guard = createPaneWriteGuard({
      namespace: async () => {
        attempts += 1;
        if (attempts === 1) throw new PaneWriteLockError("transient");
        if (attempts === 2) throw new Error("not a lock error");
        return namespace(dir);
      },
    });
    await expect(guard.acquire(PANE)).rejects.toMatchObject({ code: "PANE_WRITE_LOCK_UNAVAILABLE", message: "transient" });
    await expect(guard.acquire(PANE)).rejects.toMatchObject({ message: "Pane write lock namespace is unavailable" });
    const lease = await guard.acquire(PANE);
    await lease.release();
    expect(attempts).toBe(3);
  });

  it("settles quietly when the underlying release fails", async () => {
    const dir = await tempdir();
    const guard = guardFor(dir);
    const lease = await guard.acquire(PANE);
    const { lockPath } = paneWritePaths(namespace(dir), PANE);
    await rm(lockPath);
    await symlink(join(dir, "elsewhere"), lockPath);
    await lease.release();
  });

  it("persists only bounded digests, refuses repeats within and across instances, and rearms explicitly", async () => {
    const dir = await tempdir();
    const first = await guardFor(dir).acquire(PANE);
    await first.fence.record(IDENTITY, FRAME);
    // Recording the same frame again is idempotent — one entry, no growth.
    await first.fence.record(IDENTITY, FRAME);
    await first.release();
    const { fencePath } = paneWritePaths(namespace(dir), PANE);
    const stored = JSON.parse(await readFile(fencePath, "utf8")) as { identity: string; spent: string[] };
    expect(stored.identity).toBe(IDENTITY);
    expect(stored.spent).toEqual([FRAME]);

    // A second guard instance over the same namespace sees the spent frame.
    const second = await guardFor(dir).acquire(PANE);
    expect(await second.fence.isSpent(IDENTITY, FRAME)).toBe(true);
    // A different identity supersedes the spent set rather than mixing frames.
    await second.fence.record(IDENTITY_B, FRAME);
    expect(await second.fence.isSpent(IDENTITY, FRAME)).toBe(false);
    expect(await second.fence.isSpent(IDENTITY_B, FRAME)).toBe(true);
    // Explicit rearm clears this identity's spent set.
    await second.fence.rearm(IDENTITY_B);
    expect(await second.fence.isSpent(IDENTITY_B, FRAME)).toBe(false);
    await second.release();
  });

  it("refuses malformed, untrusted, unwritable, or oversized fences", async () => {
    const dir = await tempdir();
    const guard = guardFor(dir);
    const { fencePath } = paneWritePaths(namespace(dir), PANE);

    const withLease = async (assert: (lease: Awaited<ReturnType<typeof guard.acquire>>) => Promise<void>) => {
      const lease = await guard.acquire(PANE);
      try {
        await assert(lease);
      } finally {
        await lease.release();
      }
    };

    // Garbage JSON is malformed, not "empty".
    await writeFile(fencePath, "not json", { mode: 0o600 });
    await withLease(async (lease) => {
      await expect(lease.fence.isSpent(IDENTITY, FRAME)).rejects.toMatchObject({ message: "Pane write lock fence is malformed" });
      await expect(lease.fence.record(IDENTITY, FRAME)).rejects.toMatchObject({ message: "Pane write lock fence is malformed" });
    });
    // Every schema deviation is malformed: scalar, wrong version, non-digest identity, oversized spent.
    for (const bad of [
      "5",
      JSON.stringify({ v: 2, identity: "", spent: [] }),
      JSON.stringify({ v: 1, identity: "not-hex", spent: [] }),
      JSON.stringify({ v: 1, identity: "", spent: ["not-hex"] }),
      JSON.stringify({ v: 1, identity: "", spent: Array.from({ length: PANE_WRITE_FENCE_MAX_SPENT + 1 }, (_, i) => i.toString(16).padStart(64, "0")) }),
    ]) {
      await writeFile(fencePath, bad, { mode: 0o600 });
      await withLease(async (lease) => {
        await expect(lease.fence.isSpent(IDENTITY, FRAME)).rejects.toMatchObject({ message: "Pane write lock fence is malformed" });
      });
    }

    // A symlinked fence is untrusted for reads and writes — rearm skips the
    // read-side gate, so it is the write-side check that refuses it.
    await rm(fencePath);
    await symlink(join(dir, "real-fence"), fencePath);
    await withLease(async (lease) => {
      await expect(lease.fence.isSpent(IDENTITY, FRAME)).rejects.toMatchObject({ message: "Pane write lock fence is not trusted" });
      await expect(lease.fence.record(IDENTITY, FRAME)).rejects.toMatchObject({ message: "Pane write lock fence is not trusted" });
      await expect(lease.fence.rearm(IDENTITY)).rejects.toMatchObject({ message: "Pane write lock fence is not trusted" });
    });
    await rm(fencePath, { force: true });

    // A fence the process cannot classify is indeterminate on both paths —
    // rearm again exercises the write-side lstat the reads never reach.
    fsControl.failLstat = (path) => (path === fencePath ? eacces() : undefined);
    await withLease(async (lease) => {
      await expect(lease.fence.isSpent(IDENTITY, FRAME)).rejects.toMatchObject({ message: "Pane write lock fence is indeterminate" });
      await expect(lease.fence.record(IDENTITY, FRAME)).rejects.toMatchObject({ message: "Pane write lock fence is indeterminate" });
      await expect(lease.fence.rearm(IDENTITY)).rejects.toMatchObject({ message: "Pane write lock fence is indeterminate" });
    });
    fsControl.failLstat = undefined;

    // A trusted-but-unwritable fence refuses the record rather than guessing.
    await writeFile(fencePath, JSON.stringify({ v: 1, identity: IDENTITY, spent: [] }), { mode: 0o400 });
    await withLease(async (lease) => {
      expect(await lease.fence.isSpent(IDENTITY, FRAME)).toBe(false);
      await expect(lease.fence.record(IDENTITY, FRAME)).rejects.toMatchObject({ message: "Pane write lock fence is unavailable" });
    });

    // A fence at the spent ceiling refuses new frames for that identity.
    await rm(fencePath);
    await writeFile(fencePath, JSON.stringify({
      v: 1,
      identity: IDENTITY,
      spent: Array.from({ length: PANE_WRITE_FENCE_MAX_SPENT }, (_, i) => i.toString(16).padStart(64, "0")),
    }), { mode: 0o600 });
    await withLease(async (lease) => {
      await expect(lease.fence.record(IDENTITY, FRAME)).rejects.toMatchObject({ message: "Pane write lock fence is full" });
    });
  });
});

describe("acquireFlockHolder", () => {
  const subject = "Pane write lock";
  const failure = (message: string): Error => new PaneWriteLockError(message);
  const holderOptions = (lockPath: string, extra: Partial<Parameters<typeof acquireFlockHolder>[0]> = {}) => ({
    lockPath,
    readyMarker: "HERDR_PANE_WRITE_LOCK_READY",
    subject,
    failure,
    ...extra,
  });

  it("refuses a held lock under every wait mode", async () => {
    const dir = await tempdir();
    const lockPath = join(dir, "pane.lock");
    const first = await acquireFlockHolder(holderOptions(lockPath));
    try {
      await expect(acquireFlockHolder(holderOptions(lockPath, { wait: "nonblock" }))).rejects.toMatchObject({ code: "PANE_WRITE_LOCK_UNAVAILABLE" });
      await expect(acquireFlockHolder(holderOptions(lockPath, { wait: "wait", deadlineMs: 150 }))).rejects.toMatchObject({ code: "PANE_WRITE_LOCK_UNAVAILABLE" });
      await expect(acquireFlockHolder(holderOptions(lockPath, { wait: { timeoutMs: 1 }, deadlineMs: 2_000 }))).rejects.toMatchObject({ code: "PANE_WRITE_LOCK_UNAVAILABLE" });
    } finally {
      await first.release();
    }
  });

  it("fails closed when the lock path becomes unverifiable before acquisition returns", async () => {
    const dir = await tempdir();
    const lockPath = join(dir, "pane.lock");
    // The post-acquisition re-proof is the second lstat of the lock path.
    let lockStatCalls = 0;
    fsControl.failLstat = (path) => (path === lockPath && (lockStatCalls += 1) > 1 ? eacces() : undefined);
    await expect(acquireFlockHolder(holderOptions(lockPath))).rejects.toMatchObject({ code: "PANE_WRITE_LOCK_UNAVAILABLE" });
    fsControl.failLstat = undefined;
  });

  it("fails closed when the holder dies between acquisition and dispatch", async () => {
    const dir = await tempdir();
    const stubDir = await tempdir("herdr-flock-stub-");
    const stub = (body: string) => writeFile(join(stubDir, "flock"), `#!/bin/sh\n${body}`, { mode: 0o755 });
    const originalPath = process.env.PATH;
    const lockPath = join(dir, "pane.lock");
    try {
      process.env.PATH = stubDir;
      // READY then a short life: a later check observes the dead holder.
      await stub("printf 'HERDR_PANE_WRITE_LOCK_READY\\n'\n/bin/sleep 0.2\n");
      const lease = await acquireFlockHolder(holderOptions(lockPath));
      await new Promise((resolve) => setTimeout(resolve, 500));
      await expect(lease.check()).rejects.toMatchObject({ code: "PANE_WRITE_LOCK_UNAVAILABLE" });
      await lease.release();
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("reaps the holder when release fails before stdin closes", async () => {
    const dir = await tempdir();
    const lockPath = join(dir, "pane.lock");
    const lease = await acquireFlockHolder(holderOptions(lockPath));
    // The lock path going untrusted between acquire and release must not leave
    // the holder child alive: it would keep the flock on the unlinked inode.
    await rm(lockPath);
    await symlink(join(dir, "elsewhere"), lockPath);
    await expect(lease.release()).rejects.toMatchObject({ message: "Pane write lock lock is not trusted" });
    // Reaped, not merely reported: the holder can no longer hold the inode.
    await expect(lease.check()).rejects.toMatchObject({ message: "Pane write lock holder is not live" });
    await lease.release();
  });

  it("bounds a wedged release and still reaps the holder", async () => {
    const dir = await tempdir();
    const stubDir = await tempdir("herdr-flock-stub-");
    const originalPath = process.env.PATH;
    const lockPath = join(dir, "pane.lock");
    try {
      process.env.PATH = stubDir;
      // READY then ignores its stdin closing: only SIGKILL ends it.
      await writeFile(join(stubDir, "flock"), "#!/bin/sh\nprintf 'HERDR_PANE_WRITE_LOCK_READY\\n'\nexec /bin/sleep 60\n", { mode: 0o755 });
      const lease = await acquireFlockHolder(holderOptions(lockPath));
      await expect(lease.release()).rejects.toMatchObject({ message: "Pane write lock release is indeterminate" });
      // Reaped within the bounded wait, not merely timed out.
      await expect(lease.check()).rejects.toMatchObject({ message: "Pane write lock holder is not live" });
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

describe("the real second process", () => {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const modulePath = fileURLToPath(new URL("../../src/pane-write-lock.ts", import.meta.url));

  function spawnChild(scriptPath: string, args: string[]): { child: ReturnType<typeof spawn>; ready: Promise<void>; output: () => string } {
    // `--import tsx` runs the script inside this process — no supervisor
    // re-exec — so SIGKILL on the child also frees the flock holder it owns.
    const child = spawn(process.execPath, ["--import", "tsx", scriptPath, ...args], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stderr.on("data", (chunk: string) => { output += chunk; });
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child never signalled: ${output}`)), 30_000);
      child.stdout.on("data", () => {
        if (output.includes("CHILD_READY")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`child exited ${code} before ready: ${output}`)));
    });
    return { child, ready, output: () => output };
  }

  async function writeChild(dir: string): Promise<string> {
    const scriptPath = join(dir, "pane-lock-child.mts");
    await writeFile(scriptPath, `
import { createPaneWriteGuard } from ${JSON.stringify(modulePath)};
const [mode, dir, endpoint, pane, identity, frame] = process.argv.slice(2);
const guard = createPaneWriteGuard({ namespace: { dir, endpoint } });
const lease = await guard.acquire(pane, { waitMs: 10_000 });
if (mode === "record") await lease.fence.record(identity, frame);
console.log("CHILD_READY");
await new Promise(() => undefined);
`);
    return scriptPath;
  }

  it("excludes a concurrent holder and preserves the spent frame across a crashed process", async () => {
    const dir = await tempdir();
    const endpoint = "endpoint-a";
    const script = await writeChild(dir);
    const guard = guardFor(dir, endpoint);

    // A holder in another process records the spent frame, then dies mid-lease.
    const recorder = spawnChild(script, ["record", dir, endpoint, PANE, IDENTITY, FRAME]);
    await recorder.ready;
    // While it holds the section, this process cannot enter.
    await expect(guard.acquire(PANE, { waitMs: 150 })).rejects.toMatchObject({ code: "PANE_WRITE_LOCK_UNAVAILABLE" });
    recorder.child.kill("SIGKILL");
    await once(recorder.child, "exit");

    // The lock frees with the dead holder, and the spent frame it wrote before
    // dispatching still fences this process's view of the pane.
    const lease = await guard.acquire(PANE, { waitMs: 2_000 });
    try {
      expect(await lease.fence.isSpent(IDENTITY, FRAME)).toBe(true);
      expect(await lease.fence.isSpent(IDENTITY, FRAME_B)).toBe(false);
    } finally {
      await lease.release();
    }

    // A live holder in another process excludes this host for the same pane
    // only — a different pane or endpoint key remains acquirable.
    const holder = spawnChild(script, ["hold", dir, endpoint, PANE, IDENTITY, FRAME]);
    await holder.ready;
    try {
      await expect(guard.acquire(PANE, { waitMs: 150 })).rejects.toMatchObject({ code: "PANE_WRITE_LOCK_UNAVAILABLE" });
      const otherPane = await guard.acquire("w1:p10", { waitMs: 1_000 });
      await otherPane.release();
      const otherEndpoint = await guardFor(dir, "endpoint-b").acquire(PANE, { waitMs: 1_000 });
      await otherEndpoint.release();
    } finally {
      holder.child.kill("SIGKILL");
      await once(holder.child, "exit");
    }
    // After the holder dies, the pane's section is acquirable again.
    const free = await guard.acquire(PANE, { waitMs: 2_000 });
    await free.release();
  }, 60_000);
});
