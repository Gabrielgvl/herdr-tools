import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeExec } from "../../src/mcp/host.js";
import type { PiExec } from "../../src/cli.js";
import { acquireFlockHolder } from "../../src/pane-write-lock.js";
import type * as PaneWriteLock from "../../src/pane-write-lock.js";
import { createSelfCloseTracker } from "../../src/supervision/self-close.js";
import { createWorktreeManager, WorktreeError, worktreePaths, WORKTREE_GIT_TIMEOUT_MS, WORKTREE_LOCK_WAIT_MS } from "../../src/worktree.js";

/** fs failures the filesystem alone cannot schedule deterministically. */
const fsControl = vi.hoisted(() => ({
  failLstat: undefined as undefined | ((path: string) => Error | undefined),
  failOpen: undefined as undefined | ((path: string) => Error | undefined),
  failWrite: undefined as undefined | ((path: string) => Error | undefined),
  failClose: undefined as undefined | (() => Error | undefined),
  failRm: undefined as undefined | ((path: string) => Error | undefined),
}));

/** Lease substitutions for holder failures a real flock cannot schedule deterministically. */
const lockControl = vi.hoisted(() => ({
  acquire: undefined as undefined | ((options: { lockPath: string }) => Promise<{ check(): Promise<void>; release(): Promise<void> }>),
}));

vi.mock("../../src/pane-write-lock.js", async (importOriginal) => {
  const real = await importOriginal<typeof PaneWriteLock>();
  return {
    ...real,
    acquireFlockHolder: (options: Parameters<typeof real.acquireFlockHolder>[0]) =>
      lockControl.acquire === undefined ? real.acquireFlockHolder(options) : lockControl.acquire(options),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>();
  const isMarker = (path: unknown) => String(path).endsWith(".json");
  return {
    ...real,
    lstat: async (path: Parameters<typeof real.lstat>[0], options?: Parameters<typeof real.lstat>[1]) => {
      const error = fsControl.failLstat?.(String(path));
      if (error !== undefined) throw error;
      return real.lstat(path, options as never);
    },
    open: async (path: Parameters<typeof real.open>[0], flags?: Parameters<typeof real.open>[1], mode?: Parameters<typeof real.open>[2]) => {
      if (isMarker(path)) {
        const error = fsControl.failOpen?.(String(path));
        if (error !== undefined) throw error;
      }
      const handle = await real.open(path, flags, mode);
      if (!isMarker(path)) return handle;
      return {
        writeFile: async (data: string) => {
          const error = fsControl.failWrite?.(String(path));
          if (error !== undefined) throw error;
          return handle.writeFile(data);
        },
        close: async () => {
          await handle.close();
          const error = fsControl.failClose?.();
          if (error !== undefined) throw error;
        },
      } as typeof handle;
    },
    rm: async (path: Parameters<typeof real.rm>[0], options?: Parameters<typeof real.rm>[1]) => {
      const error = fsControl.failRm?.(String(path));
      if (error !== undefined) throw error;
      return real.rm(path, options);
    },
  };
});

const dirs: string[] = [];
afterEach(async () => {
  fsControl.failLstat = undefined;
  fsControl.failOpen = undefined;
  fsControl.failWrite = undefined;
  fsControl.failClose = undefined;
  fsControl.failRm = undefined;
  lockControl.acquire = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempdir(prefix = "herdr-worktree-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const exec = createNodeExec({ cwd: "/" });

/** A real git repository with one committed file, in a fresh owner-only dir. */
async function gitRepo(): Promise<string> {
  const dir = join(await tempdir(), "repo");
  await mkdir(dir);
  await exec("git", ["init", "-q", "-b", "main", dir], {});
  await exec("git", ["-C", dir, "config", "user.email", "t@example.test"], {});
  await exec("git", ["-C", dir, "config", "user.name", "t"], {});
  await exec("git", ["-C", dir, "config", "commit.gpgsign", "false"], {});
  await writeFile(join(dir, "seed.txt"), "seed");
  await exec("git", ["-C", dir, "add", "seed.txt"], {});
  await exec("git", ["-C", dir, "commit", "-qm", "init"], {});
  return dir;
}

const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", code: 0, killed: false });
const fail = (code = 1): ExecResult => ({ stdout: "", stderr: "failed", code, killed: false });

/** An exec stub dispatching on argv; calls are recorded for assertion. */
function execStub(handler: (args: string[]) => ExecResult | Promise<ExecResult>): { exec: PiExec; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    exec: (_command, args) => {
      calls.push(args);
      return Promise.resolve(handler(args));
    },
  };
}

const exists = async (path: string): Promise<boolean> => lstat(path).then(() => true, () => false);

/**
 * Stand up the trusted `.herdr` scaffold exactly the way the manager does —
 * each level owner-only. `mkdir recursive` would let the umask leave the
 * intermediates group-writable, which `assertOwnerOnlyDirectory` refuses.
 */
async function herdrDirs(repo: string): Promise<ReturnType<typeof worktreePaths>> {
  const paths = worktreePaths(repo);
  await mkdir(join(repo, ".herdr"), { mode: 0o700 });
  await mkdir(paths.root, { mode: 0o700 });
  await mkdir(paths.meta, { mode: 0o700 });
  return paths;
}

async function worktreeListed(repo: string, path: string): Promise<boolean> {
  const listed = await exec("git", ["-C", repo, "worktree", "list", "--porcelain"], {});
  return listed.stdout.split("\n").some((line) => line === `worktree ${path}`);
}

async function waitForGone(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (await exists(path)) {
    if (Date.now() >= deadline) throw new Error(`path still present: ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("worktreePaths", () => {
  it("derives the .herdr worktree layout from the repository root", () => {
    const paths = worktreePaths("/repo");
    expect(paths.root).toBe(join("/repo", ".herdr", "worktrees"));
    expect(paths.meta).toBe(join("/repo", ".herdr", "worktrees", ".meta"));
    expect(paths.lock).toBe(join("/repo", ".herdr", "worktrees", "creation.lock"));
    expect(WORKTREE_LOCK_WAIT_MS).toBeGreaterThan(0);
    expect(WORKTREE_GIT_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe("prepare pass-through", () => {
  it("count <= 1 returns the caller cwd unchanged with zero effects", async () => {
    const stub = execStub(() => fail());
    const manager = createWorktreeManager({ exec: stub.exec });
    const cwd = join(await tempdir(), "anywhere");
    for (const count of [1, 0, Number.NaN]) {
      await expect(manager.prepare({ childName: "kid-1", cwd, count })).resolves.toEqual({ cwd });
    }
    // No git call, no directory creation — today's single-child behaviour.
    expect(stub.calls).toHaveLength(0);
    expect(await exists(join(cwd, ".herdr"))).toBe(false);
  });
});

describe("prepare refusals", () => {
  it("rejects a child name outside the AgentName contract", async () => {
    const repo = await gitRepo();
    const manager = createWorktreeManager({ exec });
    await expect(manager.prepare({ childName: "Not A Name!", cwd: repo, count: 2 }))
      .rejects.toBeInstanceOf(WorktreeError);
    await expect(manager.prepare({ childName: "Not A Name!", cwd: repo, count: 2 }))
      .rejects.toMatchObject({ code: "WORKTREE_NAME_INVALID" });
    await expect(manager.prepare({ childName: "../escape", cwd: repo, count: 2 }))
      .rejects.toMatchObject({ code: "WORKTREE_NAME_INVALID" });
  });

  it("refuses a relative, missing, or non-repository cwd rather than sharing a directory", async () => {
    const manager = createWorktreeManager({ exec });
    await expect(manager.prepare({ childName: "kid-1", cwd: "relative/dir", count: 2 }))
      .rejects.toMatchObject({ code: "WORKTREE_NOT_A_REPOSITORY" });
    await expect(manager.prepare({ childName: "kid-1", cwd: join(await tempdir(), "missing"), count: 2 }))
      .rejects.toMatchObject({ code: "WORKTREE_NOT_A_REPOSITORY" });
    // A real directory that is not a repository: git itself refuses.
    const plain = await tempdir();
    await expect(manager.prepare({ childName: "kid-1", cwd: plain, count: 2 }))
      .rejects.toMatchObject({ code: "WORKTREE_NOT_A_REPOSITORY" });
  });

  it("surfaces a rev-parse failure or a dead git as WORKTREE_UNAVAILABLE", async () => {
    const repo = await gitRepo();
    for (const result of [fail(2), { stdout: "", stderr: "", code: 0, killed: true }]) {
      const stub = execStub(() => result);
      const manager = createWorktreeManager({ exec: stub.exec });
      await expect(manager.prepare({ childName: "kid-1", cwd: repo, count: 2 }))
        .rejects.toMatchObject({ code: "WORKTREE_UNAVAILABLE" });
    }
    const rejecting = createWorktreeManager({
      exec: () => Promise.reject(new Error("spawn failed")),
    });
    await expect(rejecting.prepare({ childName: "kid-1", cwd: repo, count: 2 }))
      .rejects.toMatchObject({ code: "WORKTREE_UNAVAILABLE" });
  });

  it("refuses an unresolvable or escaping repository root answer", async () => {
    const repo = await gitRepo();
    const gone = execStub(() => ok(join("/definitely", "missing", "root")));
    await expect(createWorktreeManager({ exec: gone.exec }).prepare({ childName: "kid-1", cwd: repo, count: 2 }))
      .rejects.toMatchObject({ code: "WORKTREE_UNAVAILABLE" });
    const elsewhere = await tempdir();
    const escape = execStub(() => ok(`${elsewhere}\n`));
    await expect(createWorktreeManager({ exec: escape.exec }).prepare({ childName: "kid-1", cwd: repo, count: 2 }))
      .rejects.toMatchObject({ code: "WORKTREE_UNAVAILABLE", message: expect.stringContaining("escapes") });
  });

  it("fails closed when the .herdr directories cannot be made trusted", async () => {
    const repo = await gitRepo();
    const manager = createWorktreeManager({ exec });
    // A regular file where .herdr belongs.
    await writeFile(join(repo, ".herdr"), "x", { mode: 0o600 });
    await expect(manager.prepare({ childName: "kid-1", cwd: repo, count: 2 }))
      .rejects.toMatchObject({ code: "WORKTREE_UNAVAILABLE", message: expect.stringContaining("not trusted") });
    await rm(join(repo, ".herdr"));
    // A stranger-writable .herdr.
    await mkdir(join(repo, ".herdr"), { mode: 0o777 });
    await expect(manager.prepare({ childName: "kid-1", cwd: repo, count: 2 }))
      .rejects.toMatchObject({ code: "WORKTREE_UNAVAILABLE", message: expect.stringContaining("not trusted") });
    await rm(join(repo, ".herdr"), { recursive: true });
    // mkdir cannot create .herdr under a read-only root.
    await exec("chmod", ["0555", repo], {});
    await expect(manager.prepare({ childName: "kid-1", cwd: repo, count: 2 }))
      .rejects.toMatchObject({ code: "WORKTREE_UNAVAILABLE", message: expect.stringContaining("directory is unavailable") });
    await exec("chmod", ["0755", repo], {});
    // The post-mkdir classification itself failing is unavailable, never a fallback.
    const herdr = join(repo, ".herdr");
    fsControl.failLstat = (path) => (path === herdr ? Object.assign(new Error("io"), { code: "EIO" }) : undefined);
    await expect(manager.prepare({ childName: "kid-1", cwd: repo, count: 2 }))
      .rejects.toMatchObject({ code: "WORKTREE_UNAVAILABLE" });
    fsControl.failLstat = undefined;
  });

  it("serializes creation on the shared flock and fails a contended acquire", async () => {
    const repo = await gitRepo();
    const paths = await herdrDirs(repo);
    const holder = await acquireFlockHolder({
      lockPath: paths.lock,
      wait: "nonblock",
      readyMarker: "TEST_HOLD",
      subject: "test",
      failure: (message) => new Error(message),
    });
    try {
      const manager = createWorktreeManager({ exec, waitMs: 150 });
      await expect(manager.prepare({ childName: "kid-1", cwd: repo, count: 2 }))
        .rejects.toMatchObject({ code: "WORKTREE_UNAVAILABLE" });
    } finally {
      await holder.release();
    }
  });

  it("propagates a non-typed lock failure as WORKTREE_UNAVAILABLE", async () => {
    const repo = await gitRepo();
    lockControl.acquire = () => Promise.reject(new Error("holder spawn failed"));
    const manager = createWorktreeManager({ exec, deadlineMs: 3_000 });
    await expect(manager.prepare({ childName: "kid-1", cwd: repo, count: 2 }))
      .rejects.toMatchObject({ code: "WORKTREE_UNAVAILABLE" });
  });

  it("refuses a name whose live replica this process already created", async () => {
    const repo = await gitRepo();
    const manager = createWorktreeManager({ exec });
    await manager.prepare({ childName: "kid-1", cwd: repo, count: 3 });
    await expect(manager.prepare({ childName: "kid-1", cwd: repo, count: 3 }))
      .rejects.toMatchObject({ code: "WORKTREE_PATH_OCCUPIED" });
  });

  it("refuses a path held by a directory it did not create", async () => {
    const repo = await gitRepo();
    const paths = await herdrDirs(repo);
    const occupied = join(paths.root, "kid-1");
    await mkdir(occupied);
    const manager = createWorktreeManager({ exec });
    await expect(manager.prepare({ childName: "kid-1", cwd: repo, count: 2 }))
      .rejects.toMatchObject({ code: "WORKTREE_PATH_OCCUPIED" });
    // The foreign directory is untouched.
    expect(await exists(occupied)).toBe(true);
    // A marker that cannot prove this exact path also refuses: missing,
    // malformed JSON, non-object, wrong version, wrong path.
    for (const content of ["not json", "5", '{"v":2,"path":"' + occupied + '"}', '{"v":1,"path":"/elsewhere"}']) {
      await writeFile(join(paths.meta, "kid-1.json"), content);
      await expect(manager.prepare({ childName: "kid-1", cwd: repo, count: 2 }))
        .rejects.toMatchObject({ code: "WORKTREE_PATH_OCCUPIED" });
      expect(await exists(occupied)).toBe(true);
    }
  });

  it("surfaces an indeterminate worktree path", async () => {
    const repo = await gitRepo();
    const path = join(worktreePaths(repo).root, "kid-1");
    fsControl.failLstat = (candidate) => (candidate === path ? Object.assign(new Error("io"), { code: "EIO" }) : undefined);
    const manager = createWorktreeManager({ exec });
    await expect(manager.prepare({ childName: "kid-1", cwd: repo, count: 2 }))
      .rejects.toMatchObject({ code: "WORKTREE_UNAVAILABLE" });
  });

  it("turns a failed git worktree add into a typed failure with no partial left", async () => {
    // A repository with no commits has no HEAD to detach.
    const repo = join(await tempdir(), "empty-repo");
    await mkdir(repo);
    await exec("git", ["init", "-q", "-b", "main", repo], {});
    const manager = createWorktreeManager({ exec });
    await expect(manager.prepare({ childName: "kid-1", cwd: repo, count: 2 }))
      .rejects.toMatchObject({ code: "WORKTREE_CREATE_FAILED" });
    expect(await exists(join(worktreePaths(repo).root, "kid-1"))).toBe(false);
    expect(await worktreeListed(repo, join(worktreePaths(repo).root, "kid-1"))).toBe(false);

    const killed = execStub((args) => (args.includes("rev-parse") ? ok(`${repo}\n`) : args.includes("add") ? { stdout: "", stderr: "", code: 0, killed: true } : ok()));
    await expect(createWorktreeManager({ exec: killed.exec }).prepare({ childName: "kid-2", cwd: repo, count: 2 }))
      .rejects.toMatchObject({ code: "WORKTREE_CREATE_FAILED" });
  });

  it("fails the create when a proven-stale replica cannot be cleared, keeping its marker", async () => {
    const repo = await gitRepo();
    const paths = await herdrDirs(repo);
    const stale = join(paths.root, "kid-1");
    await mkdir(stale);
    await writeFile(join(paths.meta, "kid-1.json"), JSON.stringify({ v: 1, path: stale }));
    // git never runs: the stale directory cannot be cleared, the create is
    // refused, and the provenance marker survives for a later retry.
    const stub = execStub((args) =>
      args.includes("rev-parse") ? Promise.resolve(ok(`${repo}\n`)) : Promise.reject(new Error("spawn failed")));
    const manager = createWorktreeManager({ exec: stub.exec });
    await expect(manager.prepare({ childName: "kid-1", cwd: repo, count: 2 }))
      .rejects.toMatchObject({ code: "WORKTREE_CREATE_FAILED" });
    expect(await exists(stale)).toBe(true);
    expect(await exists(join(paths.meta, "kid-1.json"))).toBe(true);
  });

  it("removes the worktree when the provenance marker cannot be written", async () => {
    const repo = await gitRepo();
    const marker = join(worktreePaths(repo).meta, "kid-1.json");
    fsControl.failOpen = (path) => (path === marker ? Object.assign(new Error("denied"), { code: "EACCES" }) : undefined);
    const manager = createWorktreeManager({ exec });
    const path = join(worktreePaths(repo).root, "kid-1");
    await expect(manager.prepare({ childName: "kid-1", cwd: repo, count: 2 }))
      .rejects.toMatchObject({ code: "WORKTREE_UNAVAILABLE" });
    expect(await exists(path)).toBe(false);
    expect(await worktreeListed(repo, path)).toBe(false);
  });

  it("wraps a raw marker write failure as WORKTREE_UNAVAILABLE and still cleans up", async () => {
    const repo = await gitRepo();
    const marker = join(worktreePaths(repo).meta, "kid-1.json");
    fsControl.failWrite = (path) => (path === marker ? new Error("disk full") : undefined);
    const manager = createWorktreeManager({ exec });
    const path = join(worktreePaths(repo).root, "kid-1");
    await expect(manager.prepare({ childName: "kid-1", cwd: repo, count: 2 }))
      .rejects.toMatchObject({ code: "WORKTREE_UNAVAILABLE" });
    expect(await exists(path)).toBe(false);
  });
});

describe("prepare creates", () => {
  it("creates one detached worktree per replica at the deterministic path", async () => {
    const repo = await gitRepo();
    const manager = createWorktreeManager({ exec, gitTimeoutMs: 15_000 });
    const paths = worktreePaths(repo);
    const first = await manager.prepare({ childName: "kid-1", cwd: repo, count: 2, signal: new AbortController().signal });
    const second = await manager.prepare({ childName: "kid-2", cwd: repo, count: 2 });
    const pathA = join(paths.root, "kid-1");
    const pathB = join(paths.root, "kid-2");
    expect(first).toEqual({ cwd: pathA, worktreePath: pathA });
    expect(second).toEqual({ cwd: pathB, worktreePath: pathB });
    expect(pathA).not.toBe(pathB);
    // A real detached-HEAD worktree: .git file, checked-out content, registered.
    for (const path of [pathA, pathB]) {
      expect((await lstat(join(path, ".git"))).isFile()).toBe(true);
      expect(await readFile(join(path, "seed.txt"), "utf8")).toBe("seed");
      expect(await worktreeListed(repo, path)).toBe(true);
      expect(JSON.parse(await readFile(join(paths.meta, `${path === pathA ? "kid-1" : "kid-2"}.json`), "utf8"))).toEqual({ v: 1, path });
    }
  });

  it("preserves a subdirectory cwd as the same offset inside the worktree", async () => {
    const repo = await gitRepo();
    await mkdir(join(repo, "sub"));
    const manager = createWorktreeManager({ exec });
    const prepared = await manager.prepare({ childName: "kid-1", cwd: join(repo, "sub"), count: 2 });
    const path = join(worktreePaths(repo).root, "kid-1");
    expect(prepared).toEqual({ cwd: join(path, "sub"), worktreePath: path });
  });

  it("serializes concurrent creation on the shared flock", async () => {
    const repo = await gitRepo();
    const intervals: Array<{ start: number; end: number }> = [];
    const stub = execStub(async (args) => {
      if (args.includes("rev-parse")) return ok(`${repo}\n`);
      if (args.includes("add")) {
        const start = performance.now();
        await new Promise((resolve) => setTimeout(resolve, 30));
        intervals.push({ start, end: performance.now() });
      }
      return ok();
    });
    const manager = createWorktreeManager({ exec: stub.exec });
    const [a, b] = await Promise.all([
      manager.prepare({ childName: "kid-1", cwd: repo, count: 2 }),
      manager.prepare({ childName: "kid-2", cwd: repo, count: 2 }),
    ]);
    expect(a.worktreePath).not.toBe(b.worktreePath);
    const ordered = [...intervals].sort((x, y) => x.start - y.start);
    expect(ordered).toHaveLength(2);
    expect(ordered[1].start).toBeGreaterThanOrEqual(ordered[0].end);
  });

  it("reclaims a proven-stale own replica but never a foreign one", async () => {
    const repo = await gitRepo();
    const first = createWorktreeManager({ exec });
    const prepared = await first.prepare({ childName: "kid-1", cwd: repo, count: 2 });
    await writeFile(join(prepared.worktreePath!, "stale.txt"), "stale");
    // A new incarnation has an empty registry; the marker alone proves ownership.
    const second = createWorktreeManager({ exec });
    const reclaimed = await second.prepare({ childName: "kid-1", cwd: repo, count: 2 });
    expect(reclaimed.worktreePath).toBe(prepared.worktreePath);
    expect(await exists(join(prepared.worktreePath!, "stale.txt"))).toBe(false);
    expect(await worktreeListed(repo, prepared.worktreePath!)).toBe(true);
  });

  it("tolerates a marker close failure and a failing lock release", async () => {
    const repo = await gitRepo();
    fsControl.failClose = () => new Error("close failed");
    lockControl.acquire = () => Promise.resolve({
      check: () => Promise.resolve(),
      release: () => Promise.reject(new Error("release failed")),
    });
    const manager = createWorktreeManager({ exec });
    const prepared = await manager.prepare({ childName: "kid-1", cwd: repo, count: 2 });
    expect(prepared.worktreePath).toBe(join(worktreePaths(repo).root, "kid-1"));
  });
});

describe("release and onPaneClosed", () => {
  it("removes a bound replica on pane close, idempotently", async () => {
    const repo = await gitRepo();
    const manager = createWorktreeManager({ exec });
    const prepared = await manager.prepare({ childName: "kid-1", cwd: repo, count: 2 });
    const path = prepared.worktreePath!;
    manager.bindPane("kid-1", "w1:p9");
    await manager.onPaneClosed("w1:p9");
    expect(await exists(path)).toBe(false);
    expect(await worktreeListed(repo, path)).toBe(false);
    expect(await exists(join(worktreePaths(repo).meta, "kid-1.json"))).toBe(false);
    // Second close observation is a no-op.
    await manager.onPaneClosed("w1:p9");
  });

  it("releases an unbound replica and ignores names it never created", async () => {
    const repo = await gitRepo();
    const manager = createWorktreeManager({ exec });
    await manager.release("never-made");
    const prepared = await manager.prepare({ childName: "kid-1", cwd: repo, count: 2 });
    await manager.release("kid-1");
    expect(await exists(prepared.worktreePath!)).toBe(false);
    await manager.release("kid-1");
    // A foreign directory at a would-be path is never removed.
    const foreign = join(worktreePaths(repo).root, "foreign-1");
    await mkdir(foreign, { recursive: true });
    await manager.release("foreign-1");
    expect(await exists(foreign)).toBe(true);
  });

  it("never removes on an unbound pane and keeps other bindings", async () => {
    const repo = await gitRepo();
    const manager = createWorktreeManager({ exec });
    const a = await manager.prepare({ childName: "kid-1", cwd: repo, count: 2 });
    const b = await manager.prepare({ childName: "kid-2", cwd: repo, count: 2 });
    manager.bindPane("kid-1", "w1:p1");
    manager.bindPane("kid-2", "w1:p2");
    manager.bindPane("kid-3", "w1:p3"); // never created: no-op
    await manager.onPaneClosed("w1:px"); // unbound: no-op
    expect(await exists(a.worktreePath!)).toBe(true);
    await manager.release("kid-1");
    expect(await exists(a.worktreePath!)).toBe(false);
    expect(await exists(b.worktreePath!)).toBe(true);
    // kid-2's pane binding survived its sibling's release.
    await manager.onPaneClosed("w1:p2");
    expect(await exists(b.worktreePath!)).toBe(false);
  });

  it("settles quietly when the lock or filesystem fails during removal", async () => {
    const repo = await gitRepo();
    const manager = createWorktreeManager({ exec });
    const prepared = await manager.prepare({ childName: "kid-1", cwd: repo, count: 2 });
    // The lock is unavailable: removal resolves quietly and the path stays.
    lockControl.acquire = () => Promise.reject(new Error("lock gone"));
    await expect(manager.release("kid-1")).resolves.toBeUndefined();
    expect(await exists(prepared.worktreePath!)).toBe(true);
    lockControl.acquire = undefined;

    // A holder whose release fails cannot un-remove; the drop still settles.
    lockControl.acquire = () => Promise.resolve({
      check: () => Promise.resolve(),
      release: () => Promise.reject(new Error("release failed")),
    });
    const second = createWorktreeManager({ exec });
    const again = await second.prepare({ childName: "kid-2", cwd: repo, count: 2 });
    await expect(second.release("kid-2")).resolves.toBeUndefined();
    expect(await exists(again.worktreePath!)).toBe(false);
    lockControl.acquire = undefined;

    // The marker delete failing after a real removal still settles quietly.
    const third = createWorktreeManager({ exec });
    const more = await third.prepare({ childName: "kid-3", cwd: repo, count: 2 });
    const marker = join(worktreePaths(repo).meta, "kid-3.json");
    fsControl.failRm = (path) => (path === marker ? Object.assign(new Error("denied"), { code: "EACCES" }) : undefined);
    await expect(third.release("kid-3")).resolves.toBeUndefined();
    fsControl.failRm = undefined;
    expect(await exists(more.worktreePath!)).toBe(false);
    expect(await exists(marker)).toBe(true);
  });

  it("falls back to prune plus bounded rm when git reports removal failed", async () => {
    const repo = await gitRepo();
    let removeResult: ExecResult | Promise<ExecResult> = fail(128);
    const stub = execStub((args) => {
      if (args.includes("rev-parse")) return ok(`${repo}\n`);
      if (args.includes("add")) return ok();
      if (args.includes("remove")) return removeResult;
      if (args.includes("prune")) return Promise.reject(new Error("prune failed"));
      return ok();
    });
    const manager = createWorktreeManager({ exec: stub.exec });
    const prepared = await manager.prepare({ childName: "kid-1", cwd: repo, count: 2 });
    // The stubbed add created nothing on disk; stand the directory up.
    await mkdir(prepared.worktreePath!, { recursive: true });
    await manager.release("kid-1");
    expect(await exists(prepared.worktreePath!)).toBe(false);

    // A killed removal takes the same fallback; a failing rm leaves the
    // directory but keeps the marker, so a later create can still reclaim it.
    const second = await manager.prepare({ childName: "kid-2", cwd: repo, count: 2 });
    await mkdir(second.worktreePath!, { recursive: true });
    removeResult = { stdout: "", stderr: "", code: 0, killed: true };
    fsControl.failRm = (path) => (path === second.worktreePath ? new Error("denied") : undefined);
    await manager.release("kid-2");
    fsControl.failRm = undefined;
    expect(await exists(second.worktreePath!)).toBe(true);
    expect(await exists(join(worktreePaths(repo).meta, "kid-2.json"))).toBe(true);
  });

  it("keeps the worktree and its marker when git cannot run during removal", async () => {
    const repo = await gitRepo();
    const stub = execStub((args) => {
      if (args.includes("rev-parse")) return ok(`${repo}\n`);
      if (args.includes("add")) return ok();
      return Promise.reject(new Error("spawn failed"));
    });
    const manager = createWorktreeManager({ exec: stub.exec });
    const prepared = await manager.prepare({ childName: "kid-1", cwd: repo, count: 2 });
    await mkdir(prepared.worktreePath!, { recursive: true });
    await expect(manager.release("kid-1")).resolves.toBeUndefined();
    expect(await exists(prepared.worktreePath!)).toBe(true);
    expect(await exists(join(worktreePaths(repo).meta, "kid-1.json"))).toBe(true);
  });
});

describe("self-close hook", () => {
  it("removes the bound replica when the supervisor observes the pane absent", async () => {
    const repo = await gitRepo();
    const tracker = createSelfCloseTracker();
    const manager = createWorktreeManager({ exec, selfClose: tracker });
    const prepared = await manager.prepare({ childName: "kid-1", cwd: repo, count: 2 });
    manager.bindPane("kid-1", "w1:p9");
    // An untracked consume = a self-close or third-party close observed absent.
    expect(tracker.consume("w1:p9")).toBe(false);
    await waitForGone(prepared.worktreePath!);
    expect(await worktreeListed(repo, prepared.worktreePath!)).toBe(false);
    tracker.clear();
  });

  it("removes the bound replica on a readback-confirmed own close", async () => {
    const repo = await gitRepo();
    const tracker = createSelfCloseTracker();
    const manager = createWorktreeManager({ exec, selfClose: tracker });
    const prepared = await manager.prepare({ childName: "kid-1", cwd: repo, count: 2 });
    manager.bindPane("kid-1", "w1:p9");
    tracker.begin("w1:p9")(true);
    await waitForGone(prepared.worktreePath!);
    // The close observation still suppresses its own wake exactly once.
    expect(tracker.consume("w1:p9")).toBe(true);
    tracker.clear();
  });

  it("fires nothing for unconfirmed, superseded, or expired closes", () => {
    const tracker = createSelfCloseTracker();
    const seen: string[] = [];
    tracker.onPaneClosed((paneId) => seen.push(paneId));
    // Unconfirmed: the close never proved itself.
    tracker.begin("w1:p1")(false);
    expect(seen).toHaveLength(0);
    // Superseded: a newer attempt owns the pane's outcome.
    const stale = tracker.begin("w1:p2");
    tracker.begin("w1:p2");
    stale(true);
    expect(seen).toHaveLength(0);
    // Expired: a deadline-passed proof cannot fire for a possibly-recycled pane.
    vi.useFakeTimers();
    const finish = tracker.begin("w1:p3");
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 61_000);
    finish(true);
    expect(seen).toHaveLength(0);
    vi.restoreAllMocks();
    vi.useRealTimers();
    tracker.clear();
  });

  it("swallows listener errors, supports unsubscribe, and retires with clear", async () => {
    const tracker = createSelfCloseTracker();
    const seen: string[] = [];
    tracker.onPaneClosed(() => {
      throw new Error("listener failed");
    });
    tracker.onPaneClosed((paneId) => seen.push(paneId));
    const unsubscribe = tracker.onPaneClosed((paneId) => seen.push(`late:${paneId}`));
    unsubscribe();
    expect(tracker.consume("w1:p1")).toBe(false);
    expect(seen).toEqual(["w1:p1"]);
    tracker.clear();
    // A cleared tracker adds nothing and fires nothing.
    const noop = tracker.onPaneClosed((paneId) => seen.push(paneId));
    noop();
    expect(tracker.consume("w1:p2")).toBe(false);
    expect(seen).toEqual(["w1:p1"]);
  });
});
