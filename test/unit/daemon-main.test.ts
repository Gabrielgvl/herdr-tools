import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectDaemon, type DaemonClientSocket } from "../../src/daemon/client.js";
import { acquireDaemonInstance, DAEMON_INSTANCE_LOCK_NAME } from "../../src/daemon/instance.js";
import { createIntentStore, DAEMON_INTENTS_DIR_NAME, managerSessionKey } from "../../src/daemon/intents.js";
import {
  DAEMON_STATUS_NAME,
  runDaemonMain,
  startDaemon,
  type DaemonMainOptions,
  type DaemonShutdownSeams,
  type RunningDaemon,
} from "../../src/daemon/main.js";
import { resolveDaemonNamespace, type DaemonNamespace } from "../../src/daemon/namespace.js";
import { DAEMON_SOCKET_NAME } from "../../src/daemon/protocol.js";
import { createDaemonSocketProbe } from "../../src/daemon/server.js";
import type { LaunchTask } from "../../src/launch-schema.js";

const dirs: string[] = [];
const daemons: RunningDaemon[] = [];
const clients: DaemonClientSocket[] = [];
const listeners: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) client.close();
  for (const daemon of daemons.splice(0)) await daemon.shutdown().catch(() => undefined);
  for (const listener of listeners.splice(0)) await new Promise<void>((resolve) => listener.close(() => resolve()));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface Fixture {
  env: NodeJS.ProcessEnv;
  namespace: DaemonNamespace;
  statusPath: string;
  socketPath: string;
  lockPath: string;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "herdr-daemon-main-"));
  dirs.push(root);
  const endpoint = join(root, "herdr.sock");
  await writeFile(endpoint, "");
  const env = { HERDR_SOCKET_PATH: endpoint };
  const namespace = await resolveDaemonNamespace(env);
  return {
    env,
    namespace,
    statusPath: join(namespace.dir, DAEMON_STATUS_NAME),
    socketPath: join(namespace.dir, DAEMON_SOCKET_NAME),
    lockPath: join(namespace.dir, DAEMON_INSTANCE_LOCK_NAME),
  };
}

async function start(fx: Fixture, options: Partial<DaemonMainOptions> = {}): Promise<RunningDaemon> {
  const daemon = await startDaemon({ env: fx.env, ...options });
  daemons.push(daemon);
  return daemon;
}

async function readStatus(fx: Fixture): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(fx.statusPath, "utf8")) as Record<string, unknown>;
}

async function connect(fx: Fixture): Promise<DaemonClientSocket> {
  const client = await connectDaemon(fx.namespace);
  clients.push(client);
  return client;
}

/** Waits until the daemon's socket is bound — signal handlers are armed before startup begins. */
async function untilBound(fx: Fixture): Promise<void> {
  await vi.waitFor(async () => expect((await lstat(fx.socketPath)).isSocket()).toBe(true));
}

/** A fresh instance lease proves the previous daemon released the lock. */
async function expectLockFree(namespace: DaemonNamespace): Promise<void> {
  const lease = await acquireDaemonInstance(namespace);
  await lease.release();
}

const session = { source: "herdr", agent: "pi", kind: "pi", value: "session-A" };
const mgr = managerSessionKey(session);
const task: LaunchTask = { objective: "do the work", scope: "only these files", doneWhen: ["evidence exists"] };
const projectRoot = "/home/gabriel/project";

describe("daemon startup and lifecycle record", () => {
  it("binds daemon.sock, records startedAt and the first heartbeat at 0600, and serves requests", async () => {
    const fx = await fixture();
    const started = new Date("2026-09-24T12:00:00.000Z");
    const daemon = await start(fx, { now: () => started });
    expect((await lstat(daemon.socketPath)).isSocket()).toBe(true);
    const status = await readStatus(fx);
    expect(status.startedAt).toBe("2026-09-24T12:00:00.000Z");
    expect(status.heartbeat).toBe("2026-09-24T12:00:00.000Z");
    const stat = await lstat(fx.statusPath);
    expect(stat.mode & 0o777).toBe(0o600);
    const client = await connect(fx);
    await expect(client.request("echo", { alive: true })).resolves.toEqual({ alive: true });
  });

  it("refuses a second instance on the same namespace and leaves the first serving", async () => {
    const fx = await fixture();
    await start(fx);
    await expect(startDaemon({ env: fx.env })).rejects.toMatchObject({
      name: "DaemonInstanceError",
      code: "DAEMON_INSTANCE_HELD",
    });
    const client = await connect(fx);
    await expect(client.request("echo", { still: "alive" })).resolves.toEqual({ still: "alive" });
  });

  it("probes an existing daemon.sock through main before binding", async () => {
    const fx = await fixture();
    await writeFile(fx.socketPath, "left by a dead process");
    const real = createDaemonSocketProbe();
    const probed: string[] = [];
    const daemon = await start(fx, {
      probe: async (path) => {
        probed.push(path);
        return real(path);
      },
    });
    expect(probed).toEqual([fx.socketPath]);
    // The stale path was unlinked and rebound: it answers as a real socket.
    expect((await lstat(daemon.socketPath)).isSocket()).toBe(true);
    const client = await connect(fx);
    await expect(client.request("echo", { rebound: true })).resolves.toEqual({ rebound: true });
  });

  it("tears down lock and socket when the lock is lost between probe and bind", async () => {
    const fx = await fixture();
    await expect(
      startDaemon({
        namespace: fx.namespace,
        probe: async () => {
          // The lock path turns untrusted mid-startup (a plain unlink is
          // tolerated — the flock survives on the holder's fd): the post-bind
          // check must fail and the failed start must release what it holds.
          await rm(fx.lockPath);
          await mkdir(fx.lockPath);
          return "vanished";
        },
      }),
    ).rejects.toMatchObject({ code: "DAEMON_INSTANCE_UNAVAILABLE" });
    // The teardown released the lease despite the lock fault: clear the bogus
    // path and a fresh acquire succeeds.
    await rm(fx.lockPath, { recursive: true });
    await expectLockFree(fx.namespace);
    await expect(lstat(fx.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails startup when the reattach sweep throws, and tears down lock and socket", async () => {
    const fx = await fixture();
    await expect(startDaemon({ env: fx.env, reattach: async () => { throw new Error("sweep exploded"); } }))
      .rejects.toThrow("sweep exploded");
    await expectLockFree(fx.namespace);
    await expect(lstat(fx.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("F3: the socket accepts nothing until the restart sweep completes — listen follows the sweep", async () => {
    const fx = await fixture();
    // Hold the D4 reattach sweep open: the daemon is mid-recovery.
    let releaseSweep: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { releaseSweep = resolve; });
    let sweepEntered = false;
    const starting = startDaemon({
      env: fx.env,
      reattach: async () => {
        sweepEntered = true;
        await gate;
      },
    });
    await vi.waitFor(() => expect(sweepEntered).toBe(true));
    // Mid-sweep the lifecycle record already carries startedAt + heartbeat —
    // the daemon.json write order is unchanged — but no socket exists yet, so
    // no request can reach the dispatcher against a half-swept intent ledger.
    expect((await readStatus(fx)).startedAt).toEqual(expect.any(String));
    expect(await createDaemonSocketProbe()(fx.socketPath)).not.toBe("answered");
    await expect(connectDaemon(fx.namespace)).rejects.toThrow();
    releaseSweep();
    const daemon = await starting;
    daemons.push(daemon);
    const client = await connect(fx);
    await expect(client.request("echo", { alive: true })).resolves.toEqual({ alive: true });
  });

  it("runs the N1.3 restart sweep: an interrupted effecting intent becomes unresolved before serving", async () => {
    const fx = await fixture();
    const store = createIntentStore({ namespace: fx.namespace });
    const begun = await store.begin({ managerSessionKey: mgr, idempotencyKey: "k1", task, projectRoot });
    if (begun.kind !== "launch") throw new Error("expected a fresh intent");
    await store.markEffecting(begun.intent);
    await start(fx);
    await expect(store.get(mgr, "k1")).resolves.toMatchObject({ state: "unresolved", resolution: "interrupted" });
  });

  it("fails startup when the restart sweep cannot run, and tears down lock and socket", async () => {
    const fx = await fixture();
    // A plain file where the intents directory belongs fails the sweep closed.
    await writeFile(join(fx.namespace.dir, DAEMON_INTENTS_DIR_NAME), "x");
    await expect(startDaemon({ env: fx.env })).rejects.toMatchObject({ name: "DaemonIntentError" });
    await expectLockFree(fx.namespace);
    await expect(lstat(fx.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rewrites heartbeat on cadence and preserves fields the lifecycle writer does not own", async () => {
    const fx = await fixture();
    await writeFile(fx.statusPath, JSON.stringify({ capacity: "degraded", unpersisted: { m1: { count: 2 } } }));
    await start(fx, { heartbeatMs: 20 });
    const first = await readStatus(fx);
    expect(first.capacity).toBe("degraded");
    expect(first.startedAt).toBeDefined();
    await vi.waitFor(async () => {
      const next = await readStatus(fx);
      expect(next.heartbeat).not.toBe(first.heartbeat);
    });
    const next = await readStatus(fx);
    expect(next.capacity).toBe("degraded");
    expect(next.unpersisted).toEqual({ m1: { count: 2 } });
    expect(next.startedAt).toBe(first.startedAt);
  });

  it("quarantines a malformed daemon.json instead of clobbering it or blocking restart", async () => {
    const fx = await fixture();
    await writeFile(fx.statusPath, "this is not json");
    const daemon = await start(fx);
    expect(await readFile(`${fx.statusPath}.malformed`, "utf8")).toBe("this is not json");
    expect((await readStatus(fx)).startedAt).toBeDefined();

    // A parseable non-object record is equally malformed and gets the same
    // quarantine on the next start.
    await daemon.shutdown();
    await writeFile(fx.statusPath, "42");
    await start(fx);
    expect(await readFile(`${fx.statusPath}.malformed`, "utf8")).toBe("42");
    expect((await readStatus(fx)).startedAt).toBeDefined();
  });

  it("fails startup when daemon.json cannot be read, and tears down lock and socket", async () => {
    const fx = await fixture();
    await mkdir(fx.statusPath);
    await expect(startDaemon({ env: fx.env })).rejects.toMatchObject({
      name: "DaemonMainError",
      code: "DAEMON_STATUS_UNAVAILABLE",
      message: "Daemon status record is unavailable",
    });
    await expectLockFree(fx.namespace);
    await expect(lstat(fx.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails startup when the lifecycle record cannot be staged, and the teardown still frees the lock", async () => {
    const fx = await fixture();
    await writeFile(fx.statusPath, JSON.stringify({ capacity: "ok" }));
    // The fault lands after lock acquisition, inside the first clock read:
    // the dir goes read-only (staging fails) and the lock path is untrusted
    // (release faults inside the teardown guard).
    await expect(
      startDaemon({
        env: fx.env,
        now: () => {
          rmSync(fx.lockPath);
          mkdirSync(fx.lockPath);
          chmodSync(fx.namespace.dir, 0o500);
          return new Date("2026-09-24T12:00:00.000Z");
        },
      }),
    ).rejects.toMatchObject({
      code: "DAEMON_STATUS_UNAVAILABLE",
      message: "Daemon status record could not be staged",
    });
    chmodSync(fx.namespace.dir, 0o700);
    rmSync(fx.lockPath, { recursive: true });
    await expectLockFree(fx.namespace);
    // The listener is dead — a leftover path (if the read-only dir blocked
    // the unlink) is stale, never answered.
    expect(await createDaemonSocketProbe()(fx.socketPath)).not.toBe("answered");
  });

  it("fails closed when a malformed daemon.json cannot be quarantined", async () => {
    const fx = await fixture();
    await writeFile(fx.statusPath, "not json");
    await expect(
      startDaemon({
        env: fx.env,
        now: () => {
          chmodSync(fx.namespace.dir, 0o500);
          return new Date("2026-09-24T12:00:00.000Z");
        },
      }),
    ).rejects.toMatchObject({
      code: "DAEMON_STATUS_UNAVAILABLE",
      message: "Daemon status record is malformed and cannot be preserved",
    });
    chmodSync(fx.namespace.dir, 0o700);
    await expectLockFree(fx.namespace);
  });

  it("logs a failing heartbeat clock and keeps serving", async () => {
    const fx = await fixture();
    const lines: string[] = [];
    let ticks = 0;
    await start(fx, {
      heartbeatMs: 20,
      log: (line) => lines.push(line),
      now: () => {
        ticks += 1;
        if (ticks > 1) throw "clock broke";
        return new Date("2026-09-24T12:00:00.000Z");
      },
    });
    await vi.waitFor(() => {
      expect(lines.some((line) => line.includes("heartbeat write failed: clock broke"))).toBe(true);
    });
    const client = await connect(fx);
    await expect(client.request("echo", { alive: true })).resolves.toEqual({ alive: true });
  });

  it("logs a heartbeat write failure and keeps serving", async () => {
    const fx = await fixture();
    const daemon = await start(fx, { heartbeatMs: 20 });
    const stderr = vi.spyOn(process.stderr, "write");
    await rm(fx.statusPath);
    await mkdir(fx.statusPath);
    await vi.waitFor(() => {
      expect(stderr.mock.calls.some(([text]) => String(text).includes("heartbeat write failed"))).toBe(true);
    });
    const client = await connect(fx);
    await expect(client.request("echo", { alive: true })).resolves.toEqual({ alive: true });
    // Restore so shutdown's lastStoppedAt write lands.
    await rm(fx.statusPath, { recursive: true });
    await daemon.shutdown();
    expect((await readStatus(fx)).lastStoppedAt).toBeDefined();
  });
});

describe("daemon shutdown order", () => {
  it("runs flushHandoffs → stopSupervisors → recordStoppedAt → closeServer → releaseLock, with no Herdr writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "herdr-daemon-main-"));
    dirs.push(root);
    const endpoint = join(root, "herdr.sock");
    // The Herdr endpoint is a real listener: any daemon write to it is counted.
    let herdrWrites = 0;
    const listener = createServer((socket) => {
      herdrWrites += 1;
      socket.destroy();
    });
    listeners.push(listener);
    await new Promise<void>((resolve) => listener.listen(endpoint, resolve));
    const namespace = await resolveDaemonNamespace({ HERDR_SOCKET_PATH: endpoint });
    const statusPath = join(namespace.dir, DAEMON_STATUS_NAME);
    const socketPath = join(namespace.dir, DAEMON_SOCKET_NAME);
    const probe = createDaemonSocketProbe();

    const order: string[] = [];
    const midShutdown = async (name: string) => {
      order.push(name);
      // Mid-order: the lifecycle record has no lastStoppedAt yet and the
      // socket still answers — recordStoppedAt and closeServer have not run.
      expect(JSON.parse(await readFile(statusPath, "utf8"))).not.toHaveProperty("lastStoppedAt");
      expect(await probe(socketPath)).toBe("answered");
    };
    const seams: DaemonShutdownSeams = {
      flushHandoffs: () => midShutdown("flushHandoffs"),
      stopSupervisors: () => midShutdown("stopSupervisors"),
    };
    const lines: string[] = [];
    const daemon = await startDaemon({ namespace, seams, log: (line) => lines.push(line) });
    daemons.push(daemon);

    await daemon.shutdown();

    expect(order).toEqual(["flushHandoffs", "stopSupervisors"]);
    // The journal records the full fixed order: the seams first, then the
    // lifecycle record, then the socket close and the lock release.
    const steps = lines.filter((line) => line.includes("shutdown step:"));
    expect(steps).toEqual([
      "herdr-tools-daemon shutdown step: flushHandoffs",
      "herdr-tools-daemon shutdown step: stopSupervisors",
      "herdr-tools-daemon shutdown step: recordStoppedAt",
      "herdr-tools-daemon shutdown step: closeServer",
      "herdr-tools-daemon shutdown step: releaseLock",
    ]);
    expect(JSON.parse(await readFile(statusPath, "utf8")).lastStoppedAt).toBeDefined();
    expect(await probe(socketPath)).not.toBe("answered");
    await expectLockFree(namespace);
    expect(herdrWrites).toBe(0);
  });

  it("runs shutdown once even when called twice", async () => {
    const fx = await fixture();
    const order: string[] = [];
    const seams: DaemonShutdownSeams = {
      flushHandoffs: async () => void order.push("flushHandoffs"),
      stopSupervisors: async () => void order.push("stopSupervisors"),
    };
    const daemon = await start(fx, { seams });
    await Promise.all([daemon.shutdown(), daemon.shutdown()]);
    expect(order).toEqual(["flushHandoffs", "stopSupervisors"]);
  });

  it("completes every shutdown step when a seam fails, then rejects with its error", async () => {
    const fx = await fixture();
    const order: string[] = [];
    const seams: DaemonShutdownSeams = {
      flushHandoffs: async () => {
        order.push("flushHandoffs");
        throw new Error("flush broke");
      },
      stopSupervisors: async () => void order.push("stopSupervisors"),
    };
    const daemon = await start(fx, { seams });
    await expect(daemon.shutdown()).rejects.toThrow("flush broke");
    // A stuck flush could not strand the record, the socket, or the lock.
    expect(order).toEqual(["flushHandoffs", "stopSupervisors"]);
    expect((await readStatus(fx)).lastStoppedAt).toBeDefined();
    expect(await createDaemonSocketProbe()(fx.socketPath)).not.toBe("answered");
    await expectLockFree(fx.namespace);
  });
});

describe("daemon entrypoint", () => {
  it("runs the ordered shutdown on SIGTERM and exits 0", async () => {
    const fx = await fixture();
    const lines: string[] = [];
    const run = runDaemonMain({ env: fx.env, log: (line) => lines.push(line), onStarted: (daemon) => daemons.push(daemon) });
    await untilBound(fx);
    process.kill(process.pid, "SIGTERM");
    await expect(run).resolves.toBe(0);
    expect(lines.some((line) => line.includes("received SIGTERM"))).toBe(true);
    expect((await readStatus(fx)).lastStoppedAt).toBeDefined();
    expect(await createDaemonSocketProbe()(fx.socketPath)).not.toBe("answered");
    await expectLockFree(fx.namespace);
  });

  it("runs the ordered shutdown on SIGINT and exits 0", async () => {
    const fx = await fixture();
    const stderr = vi.spyOn(process.stderr, "write");
    const run = runDaemonMain({ env: fx.env, onStarted: (daemon) => daemons.push(daemon) });
    await untilBound(fx);
    process.kill(process.pid, "SIGINT");
    await expect(run).resolves.toBe(0);
    expect(stderr.mock.calls.some(([text]) => String(text).includes("received SIGINT"))).toBe(true);
    expect((await readStatus(fx)).lastStoppedAt).toBeDefined();
  });

  it("exits 1 with a logged refusal when a live instance owns the namespace", async () => {
    const fx = await fixture();
    await start(fx);
    const lines: string[] = [];
    await expect(runDaemonMain({ env: fx.env, log: (line) => lines.push(line) })).resolves.toBe(1);
    expect(lines.some((line) => line.includes("startup failed"))).toBe(true);
    const client = await connect(fx);
    await expect(client.request("echo", { first: true })).resolves.toEqual({ first: true });
  });

  it("exits 1 with a logged refusal when startup rejects with a non-Error", async () => {
    const fx = await fixture();
    const lines: string[] = [];
    await expect(
      runDaemonMain({
        env: fx.env,
        log: (line) => lines.push(line),
        now: () => {
          throw "clock broke";
        },
      }),
    ).resolves.toBe(1);
    expect(lines.some((line) => line.includes("startup failed: clock broke"))).toBe(true);
  });

  it("exits 1 with a logged refusal when the environment carries no endpoint", async () => {
    const saved = process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_SOCKET_PATH;
    const lines: string[] = [];
    try {
      // Neither env nor namespace is given: the entrypoint must fall back to
      // process.env and fail closed with a logged refusal, not a crash.
      await expect(runDaemonMain({ log: (line) => lines.push(line) })).resolves.toBe(1);
    } finally {
      if (saved !== undefined) process.env.HERDR_SOCKET_PATH = saved;
    }
    expect(lines.some((line) => line.includes("startup failed"))).toBe(true);
  });

  it("exits 1 when shutdown cannot complete", async () => {
    for (const failure of [new Error("stuck flush"), "stuck flush"]) {
      const fx = await fixture();
      const lines: string[] = [];
      const seams: DaemonShutdownSeams = {
        flushHandoffs: () => Promise.reject(failure),
        stopSupervisors: async () => undefined,
      };
      const run = runDaemonMain({
        env: fx.env,
        log: (line) => lines.push(line),
        seams,
        onStarted: (daemon) => daemons.push(daemon),
      });
      await untilBound(fx);
      process.kill(process.pid, "SIGTERM");
      await expect(run).resolves.toBe(1);
      expect(lines.some((line) => line.includes("shutdown incomplete: stuck flush"))).toBe(true);
      // Every later step still ran: the lock is free and the socket is dead.
      await expectLockFree(fx.namespace);
      expect(await createDaemonSocketProbe()(fx.socketPath)).not.toBe("answered");
    }
  });
});
