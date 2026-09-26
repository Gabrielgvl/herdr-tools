import { chmod, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireDaemonInstance, DAEMON_INSTANCE_LOCK_NAME } from "../../src/daemon/instance.js";
import { DAEMON_NAMESPACE_DIR_NAME, resolveDaemonNamespace } from "../../src/daemon/namespace.js";

/** Mutable fs-fault injection for the namespace directory stat. */
const fsControl: { failLstat?: (path: string) => Error | undefined } = {};

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
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempdir(prefix = "herdr-daemon-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function endpointFixture(): Promise<{ root: string; socket: string; env: NodeJS.ProcessEnv }> {
  const root = await tempdir();
  const socket = join(root, "herdr.sock");
  await writeFile(socket, "");
  return { root, socket, env: { HERDR_SOCKET_PATH: socket } };
}

describe("resolveDaemonNamespace", () => {
  it("derives the namespace from the canonicalized socket path, not the env spelling", async () => {
    const { root, socket, env } = await endpointFixture();
    const resolved = await resolveDaemonNamespace(env);
    const endpoint = await realpath(socket);
    expect(resolved.endpoint).toBe(endpoint);
    expect(resolved.dir).toBe(join(dirname(endpoint), DAEMON_NAMESPACE_DIR_NAME));
    const stat = await lstat(resolved.dir);
    expect(stat.isDirectory()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o700);

    // A symlink-spelled socket resolves to the identical canonical namespace.
    const alias = join(root, "alias.sock");
    await symlink(socket, alias);
    const aliased = await resolveDaemonNamespace({ HERDR_SOCKET_PATH: alias });
    expect(aliased.endpoint).toBe(endpoint);
    expect(aliased.dir).toBe(resolved.dir);

    // A symlinked directory in the env path resolves to the real parent, so
    // the namespace lands beside the canonical socket, not beside the alias.
    const real = await tempdir("herdr-daemon-real-");
    const link = join(root, "linked-dir");
    await symlink(real, link);
    const linkedSocket = join(real, "herdr.sock");
    await writeFile(linkedSocket, "");
    const throughLink = await resolveDaemonNamespace({ HERDR_SOCKET_PATH: join(link, "herdr.sock") });
    expect(throughLink.dir).toBe(join(real, DAEMON_NAMESPACE_DIR_NAME));
    expect(throughLink.dir).not.toBe(join(link, DAEMON_NAMESPACE_DIR_NAME));
  });

  it("fails closed when the endpoint is missing or cannot be canonicalized", async () => {
    await expect(resolveDaemonNamespace({})).rejects.toMatchObject({
      name: "DaemonNamespaceError",
      code: "DAEMON_NAMESPACE_UNAVAILABLE",
      message: "Daemon endpoint is unavailable",
    });
    const root = await tempdir();
    await expect(resolveDaemonNamespace({ HERDR_SOCKET_PATH: join(root, "missing.sock") })).rejects.toMatchObject({
      code: "DAEMON_NAMESPACE_UNAVAILABLE",
      message: "Daemon endpoint cannot be canonicalized",
    });
  });

  it("refuses untrusted parents: group/world-writable, wrong owner, or unwritable", async () => {
    const { root, env } = await endpointFixture();

    // World-writable socket directory: a stranger could swap the namespace inode.
    await chmod(root, 0o777);
    await expect(resolveDaemonNamespace(env)).rejects.toMatchObject({
      code: "DAEMON_NAMESPACE_UNAVAILABLE",
      message: expect.stringContaining("directory is not trusted"),
    });
    await chmod(root, 0o700);

    // Group-writable is refused on the same boundary.
    await chmod(root, 0o770);
    await expect(resolveDaemonNamespace(env)).rejects.toMatchObject({
      code: "DAEMON_NAMESPACE_UNAVAILABLE",
      message: expect.stringContaining("directory is not trusted"),
    });
    await chmod(root, 0o700);

    // A parent owned by anyone but this uid is untrusted even at mode 0700.
    vi.spyOn(process, "getuid").mockReturnValue((process.getuid?.() ?? 0) + 1);
    await expect(resolveDaemonNamespace(env)).rejects.toMatchObject({
      code: "DAEMON_NAMESPACE_UNAVAILABLE",
      message: expect.stringContaining("directory is not trusted"),
    });
    vi.restoreAllMocks();

    // A parent that cannot be classified is unavailable, never a fallback.
    await expect(resolveDaemonNamespace(env, join(root, "missing", "daemon"))).rejects.toMatchObject({
      code: "DAEMON_NAMESPACE_UNAVAILABLE",
      message: "Daemon namespace directory is unavailable",
    });

    // A trusted but unwritable parent cannot mint the namespace directory.
    const readonly = join(root, "readonly");
    await mkdir(readonly, { mode: 0o500 });
    await expect(resolveDaemonNamespace(env, join(readonly, "daemon"))).rejects.toMatchObject({
      code: "DAEMON_NAMESPACE_UNAVAILABLE",
      message: "Daemon namespace directory is unavailable",
    });
  });

  it("refuses an untrusted pre-existing namespace directory", async () => {
    const { root, env } = await endpointFixture();
    const dir = join(root, DAEMON_NAMESPACE_DIR_NAME);

    // A symlink where the namespace belongs survives mkdir as EEXIST but is refused.
    await symlink(join(root, "elsewhere"), dir);
    await expect(resolveDaemonNamespace(env)).rejects.toMatchObject({
      code: "DAEMON_NAMESPACE_UNAVAILABLE",
      message: expect.stringContaining("directory is not trusted"),
    });
    await rm(dir, { force: true });

    // A regular file where the namespace belongs is not a directory.
    await writeFile(dir, "", { mode: 0o600 });
    await expect(resolveDaemonNamespace(env)).rejects.toMatchObject({
      code: "DAEMON_NAMESPACE_UNAVAILABLE",
      message: expect.stringContaining("directory is not trusted"),
    });
    await rm(dir, { force: true });

    // A world-writable directory is equally untrusted.
    await mkdir(dir);
    await chmod(dir, 0o777);
    await expect(resolveDaemonNamespace(env)).rejects.toMatchObject({
      code: "DAEMON_NAMESPACE_UNAVAILABLE",
      message: expect.stringContaining("directory is not trusted"),
    });
  });

  it("fails closed when the namespace directory stat throws a foreign error", async () => {
    const { env } = await endpointFixture();
    fsControl.failLstat = (path) => path.endsWith(DAEMON_NAMESPACE_DIR_NAME) ? Object.assign(new Error("io fault"), { code: "EIO" }) : undefined;
    try {
      await expect(resolveDaemonNamespace(env)).rejects.toMatchObject({
        code: "DAEMON_NAMESPACE_UNAVAILABLE",
        message: "Daemon namespace directory is unavailable",
      });
    } finally {
      fsControl.failLstat = undefined;
    }
  });
});

describe("acquireDaemonInstance", () => {
  it("allows exactly one lock holder per endpoint namespace", async () => {
    const { env } = await endpointFixture();
    const namespace = await resolveDaemonNamespace(env);
    const first = await acquireDaemonInstance(namespace);
    try {
      await expect(acquireDaemonInstance(namespace)).rejects.toMatchObject({
        name: "DaemonInstanceError",
        code: "DAEMON_INSTANCE_HELD",
      });
    } finally {
      await first.release();
    }
    // After the first lease releases, the endpoint can be acquired again.
    const second = await acquireDaemonInstance(namespace);
    await second.release();
  });

  it("reports lease liveness through check", async () => {
    const { env } = await endpointFixture();
    const namespace = await resolveDaemonNamespace(env);
    const lease = await acquireDaemonInstance(namespace);
    await lease.check();
    await lease.release();
    // The holder is dead after release: liveness fails closed, not stale-true.
    await expect(lease.check()).rejects.toMatchObject({
      name: "DaemonInstanceError",
      code: "DAEMON_INSTANCE_UNAVAILABLE",
    });
  });

  it("never unlinks the lock inode while held", async () => {
    const { env } = await endpointFixture();
    const namespace = await resolveDaemonNamespace(env);
    const lockPath = join(namespace.dir, DAEMON_INSTANCE_LOCK_NAME);
    const lease = await acquireDaemonInstance(namespace);
    const held = await lstat(lockPath);
    expect(held.isFile()).toBe(true);
    try {
      // Contention observes the same inode still present and still locked.
      await expect(acquireDaemonInstance(namespace)).rejects.toMatchObject({ code: "DAEMON_INSTANCE_HELD" });
      expect((await lstat(lockPath)).ino).toBe(held.ino);
    } finally {
      await lease.release();
    }
    // Release frees the flock but leaves the inode: unlinking a held lock
    // would let a third party take a fresh inode beside the live holder.
    const after = await lstat(lockPath);
    expect(after.isFile()).toBe(true);
    expect(after.ino).toBe(held.ino);
  });
});
