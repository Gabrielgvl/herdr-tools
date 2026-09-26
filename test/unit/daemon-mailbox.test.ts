/**
 * The owner-only filesystem mailbox (spec: durable-supervisor §7, node N2.2).
 *
 * Proves the hard-cap refusal contract (per-manager 500 files / 8 MiB, global
 * 5 000 `unread/` files counted under the fixed index-then-destination flock
 * order), the no-clobber `link` write, truthful degradation accounting,
 * `pendingGap` hold/retry, `acked/` retention, the mailbox-global gap body,
 * the run-flock owner-resolution seam, the N2.4 move primitive, and the
 * supervisor / JobRegistry writer wiring.
 */

import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDaemonJsonPort,
  createMailbox,
  DaemonMailboxError,
  DAEMON_MAILBOX_DIR_NAME,
  mailboxEventId,
  MAILBOX_ACKED_RETAINED_FILES,
  MAILBOX_GLOBAL_UNREAD_MAX_FILES,
  MAILBOX_UNREAD_MAX_BYTES,
  MAILBOX_UNREAD_MAX_FILES,
  type Mailbox,
  type MailboxEventWriter,
  type MailboxGapEventInput,
  type MailboxRunEvent,
  type MailboxRunEventInput,
} from "../../src/daemon/mailbox.js";
import { managerSessionKey } from "../../src/daemon/intents.js";
import { startDaemon } from "../../src/daemon/main.js";
import { JobRegistry, type JobRequestSnapshot, type SupervisorJobRequestSnapshot } from "../../src/job-registry.js";
import { resolveDaemonNamespace, type DaemonNamespace } from "../../src/daemon/namespace.js";
import type { SupervisionJobPort, SupervisionJobView } from "../../src/supervision/state.js";
import type { HandoffGate, HandoffRun } from "../../src/handoff-gate.js";
import { parseSocketLine, type SupervisionSocketEvent } from "../../src/supervision/protocol.js";
import { parseSnapshotResult, type HerdrSnapshot } from "../../src/targets.js";
import type { SupervisedIdentity } from "../../src/supervision/identity.js";
import type { SupervisionWake } from "../../src/supervision/notify.js";
import { createTraceSource } from "../../src/supervision/trace-source.js";
import { Supervisor, type SupervisionScheduler, type SupervisorDependencies } from "../../src/supervision/supervisor.js";

const dirs: string[] = [];
afterEach(async () => {
  // Fire-and-forget persists may land while cleanup runs; retry the rm.
  for (const dir of dirs.splice(0)) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
});

const mgrA = managerSessionKey({ source: "herdr", agent: "pi", kind: "pi", value: "session-A" });
const mgrB = managerSessionKey({ source: "herdr", agent: "claude", kind: "claude", value: "session-B" });
const managerKey = (value: string) => managerSessionKey({ source: "herdr", agent: "pi", kind: "pi", value });

async function fixture(overrides: Partial<Parameters<typeof createMailbox>[0]> = {}): Promise<{ mailbox: Mailbox; namespace: DaemonNamespace }> {
  const dir = await mkdtemp(join(tmpdir(), "herdr-mailbox-"));
  dirs.push(dir);
  const socket = join(dir, "herdr.sock");
  await writeFile(socket, "");
  const namespace = await resolveDaemonNamespace({ HERDR_SOCKET_PATH: socket });
  return { mailbox: createMailbox({ namespace, ...overrides }), namespace };
}

const fixedOwner = (key: string) => ({ ownerOfRun: async () => key });

const runEvent = (runId = "run-1", overrides: Partial<MailboxRunEventInput> = {}): MailboxRunEventInput => ({
  kind: "work_cycle_completed",
  runId,
  jobId: "job-1",
  childIdentity: { agentName: "worker", agentKind: "pi", paneId: "p1" },
  actions: [],
  ...overrides,
});

const unreadDir = (namespace: DaemonNamespace, key: string) => join(namespace.dir, DAEMON_MAILBOX_DIR_NAME, key, "unread");
const ackedDir = (namespace: DaemonNamespace, key: string) => join(namespace.dir, DAEMON_MAILBOX_DIR_NAME, key, "acked");

/** Raw seed files: only their names and sizes feed the caps and retention. */
async function seed(namespace: DaemonNamespace, key: string, dir: "unread" | "acked", count: number, options: { bytes?: number; startMs?: number } = {}): Promise<string[]> {
  await mkdir(unreadDir(namespace, key), { recursive: true, mode: 0o700 });
  await mkdir(ackedDir(namespace, key), { recursive: true, mode: 0o700 });
  const base = dir === "unread" ? unreadDir(namespace, key) : ackedDir(namespace, key);
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = mailboxEventId(new Date((options.startMs ?? 1_700_000_000_000) + index));
    ids.push(id);
    await writeFile(join(base, `${id}.json`), "x".repeat(options.bytes ?? 1), { mode: 0o600 });
  }
  return ids;
}

async function countFiles(path: string): Promise<number> {
  return (await readdir(path)).filter((name) => name.endsWith(".json")).length;
}

async function globalUnreadCount(namespace: DaemonNamespace): Promise<number> {
  const root = join(namespace.dir, DAEMON_MAILBOX_DIR_NAME);
  let total = 0;
  for (const name of await readdir(root)) {
    if (!/^[0-9a-f]{64}$/.test(name)) continue;
    total += await countFiles(join(root, name, "unread"));
  }
  return total;
}

describe("event file discipline (§7 no-clobber write)", () => {
  it("writes one 0600 file per event under 0700 dirs with a sortable ID and the typed body", async () => {
    const { mailbox, namespace } = await fixture({ ownership: fixedOwner(mgrA) });
    const result = await mailbox.writeRunEvent(runEvent("run-1", {
      decision: { verdict: "blocked", labels: ["stuck"], evidenceDigest: "abc123", evidenceExcerpt: "one line", reviewerModel: "paused" },
      handoff: { state: "awaiting_handoff", artifactSha256: "d".repeat(64) },
      actions: ["recover"],
    }));
    expect(result).toMatchObject({ persisted: true });
    if (!result.persisted) return;
    expect(result.path).toBe(join(unreadDir(namespace, mgrA), `${result.eventId}.json`));
    const value = await lstat(result.path);
    expect(Number(value.mode) & 0o777).toBe(0o600);
    for (const path of [join(namespace.dir, DAEMON_MAILBOX_DIR_NAME), join(namespace.dir, DAEMON_MAILBOX_DIR_NAME, mgrA), unreadDir(namespace, mgrA), ackedDir(namespace, mgrA)]) {
      expect(Number((await lstat(path)).mode) & 0o777).toBe(0o700);
    }
    expect(result.eventId).toMatch(/^\d{4}-\d{2}-\d{2}T\d{6}\.\d{3}Z-[0-9a-f-]{36}$/);
    const body = JSON.parse(await readFile(result.path, "utf8")) as MailboxRunEvent;
    expect(body).toEqual({
      id: result.eventId,
      at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      kind: "work_cycle_completed",
      runId: "run-1",
      jobId: "job-1",
      childIdentity: { agentName: "worker", agentKind: "pi", paneId: "p1" },
      decision: { verdict: "blocked", labels: ["stuck"], evidenceDigest: "abc123", evidenceExcerpt: "one line", reviewerModel: "paused" },
      handoff: { state: "awaiting_handoff", artifactSha256: "d".repeat(64) },
      actions: ["recover"],
    });
    expect(await mailbox.list(mgrA)).toEqual([result.eventId]);
    expect(await mailbox.read(mgrA, result.eventId)).toEqual(body);
  });

  it("writes the mailbox-global downtime_gap body variant with no runId or jobId", async () => {
    const { mailbox, namespace } = await fixture();
    const gap: MailboxGapEventInput = {
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-01T00:05:00.000Z",
      lost: { [mgrB]: { count: 2, firstAt: "2026-01-01T00:00:00.000Z", lastAt: "2026-01-01T00:04:00.000Z" } },
    };
    const result = await mailbox.writeGapEvent(mgrA, gap);
    expect(result).toMatchObject({ persisted: true });
    if (!result.persisted) return;
    const body = JSON.parse(await readFile(join(unreadDir(namespace, mgrA), `${result.eventId}.json`), "utf8")) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["at", "from", "id", "kind", "lost", "to"]);
    expect(body).toMatchObject({ id: result.eventId, kind: "downtime_gap", from: gap.from, to: gap.to, lost: gap.lost });
    expect(body).not.toHaveProperty("runId");
    expect(body).not.toHaveProperty("jobId");
  });

  it("refuses a link EEXIST collision and leaves the existing file byte-identical", async () => {
    const { mailbox, namespace } = await fixture({ ownership: fixedOwner(mgrA) });
    const id = mailboxEventId(new Date("2026-01-01T00:00:00.000Z"));
    const first = await mailbox.writeRunEvent(runEvent("run-1", { id }));
    expect(first.persisted).toBe(true);
    const path = join(unreadDir(namespace, mgrA), `${id}.json`);
    const before = await readFile(path);
    const second = await mailbox.writeRunEvent(runEvent("run-2", { id, actions: ["replaced?"] }));
    expect(second).toMatchObject({ persisted: false, persistenceFailed: true, eventId: id, reason: "collision" });
    expect(await readFile(path)).toEqual(before);
    expect((await readdir(unreadDir(namespace, mgrA))).filter((name) => name.includes(".tmp"))).toEqual([]);
    // The refused payload is unrecoverable and accounted, never claimed persisted.
    expect((await mailbox.degradation()).unpersisted[mgrA]).toMatchObject({ count: 1 });
  });
});

describe("hard capacity (§7)", () => {
  it("refuses at the per-manager 500-file cap: MAILBOX_CAPACITY for launches, no file written, loss accounted in the status projection", async () => {
    const { mailbox, namespace } = await fixture({ ownership: fixedOwner(mgrA) });
    expect(await mailbox.checkLaunchCapacity(mgrA)).toEqual({ ok: true });
    await seed(namespace, mgrA, "unread", MAILBOX_UNREAD_MAX_FILES);
    const verdict = await mailbox.checkLaunchCapacity(mgrA);
    expect(verdict).toMatchObject({ ok: false, code: "MAILBOX_CAPACITY" });
    expect(await countFiles(unreadDir(namespace, mgrA))).toBe(MAILBOX_UNREAD_MAX_FILES);
    const result = await mailbox.writeRunEvent(runEvent());
    expect(result).toMatchObject({ persisted: false, persistenceFailed: true, reason: "capacity" });
    // No file written — the hard bound holds and nothing was evicted or spooled.
    expect(await countFiles(unreadDir(namespace, mgrA))).toBe(MAILBOX_UNREAD_MAX_FILES);
    const degradation = await mailbox.degradation();
    expect(degradation.capacity).toBe("degraded");
    expect(degradation.unpersisted[mgrA]).toEqual({ count: 1, firstAt: expect.any(String), lastAt: expect.any(String) });
    // The status projection is the raw `daemon.json` herdr_status reads.
    const raw = JSON.parse(await readFile(join(namespace.dir, "daemon.json"), "utf8")) as Record<string, unknown>;
    expect(raw.capacity).toBe("degraded");
    expect(raw.unpersisted).toMatchObject({ [mgrA]: { count: 1 } });
    // Existing supervision continues at cap: the durable mailbox surface stays
    // fully usable and the refused write never throws into its caller.
    const [first] = await mailbox.list(mgrA);
    expect(await mailbox.ack(mgrA, first!)).toBe("acked");
    expect(await mailbox.ack(mgrA, first!)).toBe("already-acked");
  });

  it("refuses at the per-manager 8 MiB byte cap", async () => {
    const { mailbox, namespace } = await fixture({ ownership: fixedOwner(mgrA) });
    expect(MAILBOX_UNREAD_MAX_BYTES).toBe(8 * 1024 * 1024);
    await seed(namespace, mgrA, "unread", 3, { bytes: 3 * 1024 * 1024 });
    const result = await mailbox.writeRunEvent(runEvent());
    expect(result).toMatchObject({ persisted: false, persistenceFailed: true, reason: "capacity" });
    expect(await countFiles(unreadDir(namespace, mgrA))).toBe(3);
    expect((await mailbox.degradation()).unpersisted[mgrA]).toMatchObject({ count: 1 });
  });

  it("binds the global 5 000-unread bound under the index-then-destination lock order: racing writers cannot overshoot", async () => {
    const { mailbox, namespace } = await fixture({ ownership: fixedOwner(managerKey("g10")) });
    // 10 mailboxes at 499 + one at 9 = 4 999 unread with per-manager room in
    // the eleventh: only the GLOBAL cap binds the racing writers below.
    const racingKey = managerKey("g10");
    for (let index = 0; index < 10; index += 1) await seed(namespace, managerKey(`g${index}`), "unread", MAILBOX_UNREAD_MAX_FILES - 1);
    await seed(namespace, racingKey, "unread", 9);
    expect(await globalUnreadCount(namespace)).toBe(4_999);
    const results = await Promise.all(["run-g10", "run-g10", "run-g10"].map((runId) => mailbox.writeRunEvent(runEvent(runId))));
    expect(results.filter((result) => result.persisted)).toHaveLength(1);
    expect(results.filter((result) => !result.persisted)).toHaveLength(2);
    for (const result of results) if (!result.persisted) expect(result.reason).toBe("capacity");
    // The hard bound: exactly 5 000, never 5 001.
    expect(await globalUnreadCount(namespace)).toBe(MAILBOX_GLOBAL_UNREAD_MAX_FILES);
  });

  it("resolves the destination from the run's current owner inside the run flock", async () => {
    let inRunFlock = false;
    const seen: string[] = [];
    const { mailbox } = await fixture({
      ownership: {
        ownerOfRun: async (runId) => {
          seen.push(runId);
          // The lookup runs under the run flock: the owner it returns is the
          // CURRENT one, never the owner recorded at supervisor bind.
          expect(inRunFlock).toBe(true);
          return mgrB;
        },
        withRunFlock: async (_runId, section) => {
          inRunFlock = true;
          try {
            return await section();
          } finally {
            inRunFlock = false;
          }
        },
      },
    });
    const result = await mailbox.writeRunEvent(runEvent("run-1"));
    expect(result).toMatchObject({ persisted: true });
    expect(seen).toEqual(["run-1"]);
    expect(await mailbox.list(mgrB)).toHaveLength(1);
    expect(await mailbox.list(mgrA)).toEqual([]);
    // Without an ownership seam no run event can resolve a destination.
    const orphan = await fixture();
    await expect(orphan.mailbox.writeRunEvent(runEvent())).rejects.toThrow(/ownership seam/);
  });
});

describe("degradation accounting", () => {
  it("keeps unpersisted accounting across a daemon.json rewrite and a restart", async () => {
    const first = await fixture({ ownership: fixedOwner(mgrA), now: () => new Date("2026-01-01T00:00:01.000Z") });
    await seed(first.namespace, mgrA, "unread", MAILBOX_UNREAD_MAX_FILES);
    await first.mailbox.writeRunEvent(runEvent());
    // Simulated restart: a heartbeat-style read-merge-write rewrite of
    // daemon.json, then a fresh mailbox instance over the same namespace.
    const port = createDaemonJsonPort(first.namespace.dir);
    await port.write({ heartbeat: "2026-01-01T00:00:02.000Z" });
    const reopened = createMailbox({ namespace: first.namespace, ownership: fixedOwner(mgrA), now: () => new Date("2026-01-01T00:00:03.000Z") });
    expect((await reopened.degradation()).unpersisted[mgrA]).toEqual({
      count: 1,
      firstAt: "2026-01-01T00:00:01.000Z",
      lastAt: "2026-01-01T00:00:01.000Z",
    });
    await reopened.writeRunEvent(runEvent());
    expect((await reopened.degradation()).unpersisted[mgrA]).toEqual({
      count: 2,
      firstAt: "2026-01-01T00:00:01.000Z",
      lastAt: "2026-01-01T00:00:03.000Z",
    });
    // The daemon.json the projection reads is still the merged record.
    const raw = JSON.parse(await readFile(join(first.namespace.dir, "daemon.json"), "utf8")) as Record<string, unknown>;
    expect(raw.heartbeat).toBe("2026-01-01T00:00:02.000Z");
    expect(raw.unpersisted).toMatchObject({ [mgrA]: { count: 2 } });
  });

  it("reports the persist as failed even when the daemon.json accounting write fails", async () => {
    const failures: string[] = [];
    const { mailbox, namespace } = await fixture({
      ownership: fixedOwner(mgrA),
      status: {
        read: async () => ({}),
        write: async () => {
          throw new Error("daemon.json is down");
        },
      },
      log: (line) => failures.push(line),
    });
    await mkdir(unreadDir(namespace, mgrA), { recursive: true, mode: 0o700 });
    // A collision is a failed persist whose loss accounting runs immediately.
    const id = mailboxEventId(new Date("2026-01-01T00:00:00.000Z"));
    await writeFile(join(unreadDir(namespace, mgrA), `${id}.json`), "pre-existing", { mode: 0o600 });
    const colliding = await mailbox.writeRunEvent(runEvent("run-2", { id }));
    expect(colliding).toMatchObject({ persisted: false, persistenceFailed: true, reason: "collision" });
    // Nothing claims persistence when the daemon.json write itself fails; the
    // failure is logged and the result still reports the persist as failed.
    expect(failures.some((line) => line.includes("loss accounting failed"))).toBe(true);
    // A successful write with a failing capacity patch logs and still persists.
    const ok = await mailbox.writeRunEvent(runEvent("run-3"));
    expect(ok.persisted).toBe(true);
    expect(failures.some((line) => line.includes("capacity write failed"))).toBe(true);
  });

  it("reads a non-record or malformed daemon.json as empty and refuses untrusted event files", async () => {
    const { mailbox, namespace } = await fixture({ ownership: fixedOwner(mgrA) });
    const port = createDaemonJsonPort(namespace.dir);
    await writeFile(join(namespace.dir, "daemon.json"), "[]");
    expect(await port.read()).toEqual({});
    await writeFile(join(namespace.dir, "daemon.json"), "not json");
    expect(await port.read()).toEqual({});
    await port.write({ capacity: "degraded" });
    expect(await port.read()).toEqual({ capacity: "degraded" });
    // An untrusted (group/other-writable) file is refused on open.
    const ids = await seed(namespace, mgrA, "unread", 1);
    await chmod(join(unreadDir(namespace, mgrA), `${ids[0]}.json`), 0o666);
    await expect(mailbox.read(mgrA, ids[0]!)).rejects.toThrow(/not trusted/);
    // Malformed JSON and a misfiled id are refused the same way.
    const malformed = mailboxEventId(new Date("2026-01-01T00:00:00.000Z"));
    await writeFile(join(unreadDir(namespace, mgrA), `${malformed}.json`), "not json", { mode: 0o600 });
    await expect(mailbox.read(mgrA, malformed)).rejects.toThrow(/not trusted/);
    const wrongId = mailboxEventId(new Date("2026-01-01T00:00:01.000Z"));
    await writeFile(join(unreadDir(namespace, mgrA), `${wrongId}.json`), JSON.stringify({ id: "somewhere-else" }), { mode: 0o600 });
    await expect(mailbox.read(mgrA, wrongId)).rejects.toThrow(/not trusted/);
    // A missing event reports absent, and an unknown mailbox reports absent.
    await expect(mailbox.read(mgrA, mailboxEventId(new Date("2026-01-01T00:00:02.000Z")))).rejects.toThrow(/absent/);
    await expect(mailbox.read(managerKey("ghost"), mailboxEventId())).rejects.toThrow(/absent/);
  });
});

describe("pendingGap (§7/§9)", () => {
  it("holds a refused downtime_gap as pendingGap and lands it once the mailbox drains", async () => {
    const { mailbox, namespace } = await fixture();
    // Fresh retry with nothing held is a no-op.
    await mailbox.retryPendingGaps();
    const seeded = await seed(namespace, mgrA, "unread", MAILBOX_UNREAD_MAX_FILES);
    const gap: MailboxGapEventInput = {
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-01T00:05:00.000Z",
      lost: { [mgrA]: { count: 3, firstAt: "2026-01-01T00:00:00.000Z", lastAt: "2026-01-01T00:04:00.000Z" } },
    };
    const refused = await mailbox.writeGapEvent(mgrA, gap);
    expect(refused).toMatchObject({ persisted: false, persistenceFailed: true, reason: "capacity", pendingGap: true });
    const held = (await mailbox.degradation()).pendingGap[mgrA];
    expect(held).toMatchObject({ kind: "downtime_gap", from: gap.from, to: gap.to, lost: gap.lost });
    expect(held).not.toHaveProperty("runId");
    expect(held).not.toHaveProperty("jobId");
    // Retried every heartbeat while pending: still at cap, still held.
    await mailbox.retryPendingGaps();
    expect((await mailbox.degradation()).pendingGap[mgrA]?.id).toBe(held.id);
    // Drain some room; the retry lands the held disclosure verbatim.
    for (const id of seeded.slice(0, 3)) await mailbox.ack(mgrA, id);
    await mailbox.retryPendingGaps();
    expect((await mailbox.degradation()).pendingGap).toEqual({});
    const landed = JSON.parse(await readFile(join(unreadDir(namespace, mgrA), `${held.id}.json`), "utf8")) as Record<string, unknown>;
    expect(landed).toMatchObject({ id: held.id, at: held.at, kind: "downtime_gap" });
    // Cleared only once durably written: a further retry changes nothing.
    await mailbox.retryPendingGaps();
    expect((await mailbox.degradation()).pendingGap).toEqual({});

    // A crash between the write and the clear is recovered without duplicating:
    // an on-disk copy of the held ID counts as landed.
    const port = createDaemonJsonPort(namespace.dir);
    await port.write({ pendingGap: { [mgrA]: held } });
    await mailbox.retryPendingGaps();
    expect((await mailbox.degradation()).pendingGap).toEqual({});
    expect(await countFiles(join(unreadDir(namespace, mgrA)))).toBe(await mailbox.list(mgrA).then((ids) => ids.length));

    // A malformed held entry is skipped, never silently rewritten.
    await port.write({ pendingGap: { [mgrA]: "junk" } });
    await mailbox.retryPendingGaps();
    expect((await mailbox.degradation()).pendingGap).toEqual({ [mgrA]: "junk" });

    // A held entry without a minted ID (an older record) mints one on landing.
    await port.write({ pendingGap: { [mgrB]: { kind: "downtime_gap", at: "2026-01-01T00:05:00.000Z", ...gap } } });
    await mailbox.retryPendingGaps();
    expect((await mailbox.degradation()).pendingGap).toEqual({});
    expect(await mailbox.list(mgrB)).toHaveLength(1);
  });
});

describe("ack and bounded acked retention", () => {
  it("acks idempotently after handling and prunes acked/ to the newest 1 000", async () => {
    const { mailbox, namespace } = await fixture({ ownership: fixedOwner(mgrA) });
    const seededAcked = await seed(namespace, mgrA, "acked", MAILBOX_ACKED_RETAINED_FILES + 2, { startMs: 1_700_000_000_000 });
    const result = await mailbox.writeRunEvent(runEvent());
    if (!result.persisted) throw new Error("expected persist");
    expect(await mailbox.ack(mgrA, result.eventId)).toBe("acked");
    const remaining = (await readdir(ackedDir(namespace, mgrA))).filter((name) => name.endsWith(".json")).sort();
    expect(remaining).toHaveLength(MAILBOX_ACKED_RETAINED_FILES);
    // The newest are kept; the oldest three seeded records were pruned.
    expect(remaining).toContain(`${result.eventId}.json`);
    for (const id of seededAcked.slice(0, 3)) expect(remaining).not.toContain(`${id}.json`);
    expect(remaining).toContain(`${seededAcked[seededAcked.length - 1]!}.json`);
    // Idempotent: the handled record stays exactly once.
    expect(await mailbox.ack(mgrA, result.eventId)).toBe("already-acked");
    expect((await readdir(ackedDir(namespace, mgrA))).filter((name) => name.endsWith(".json"))).toHaveLength(MAILBOX_ACKED_RETAINED_FILES);
    // A read falls through to the handled record; an unknown event is absent.
    expect(await mailbox.read(mgrA, result.eventId)).toMatchObject({ id: result.eventId });
    await expect(mailbox.ack(mgrA, mailboxEventId())).rejects.toThrow(/absent/);
  });
});

describe("move support for N2.4", () => {
  it("moves unread files that count toward the destination caps and accounts double-absent files as loss", async () => {
    const { mailbox, namespace } = await fixture({ ownership: fixedOwner(mgrB) });
    const [a, b] = await seed(namespace, mgrA, "unread", 2);
    const missing = mailboxEventId(new Date("2026-01-01T00:00:00.000Z"));
    const outcome = await mailbox.moveUnread(mgrA, mgrB, [a!, b!, missing]);
    expect(outcome).toEqual({ moved: [a, b], alreadyAtDestination: [], lost: [missing] });
    expect(await countFiles(unreadDir(namespace, mgrA))).toBe(0);
    expect(await countFiles(unreadDir(namespace, mgrB))).toBe(2);
    // A file absent from both goes to the durable loss accounting, never skipped.
    expect((await mailbox.degradation()).unpersisted[mgrA]).toMatchObject({ count: 1 });
    // Moved files count toward the destination's caps: fill the successor to
    // its cap and later writes refuse until it drains.
    await seed(namespace, mgrB, "unread", MAILBOX_UNREAD_MAX_FILES - 2);
    const result = await mailbox.writeRunEvent(runEvent());
    expect(result).toMatchObject({ persisted: false, persistenceFailed: true, reason: "capacity" });
    // A source-absent file counts as moved only when the destination holds it.
    expect(await mailbox.moveUnread(mgrA, mgrB, [a!])).toEqual({ moved: [], alreadyAtDestination: [a], lost: [] });
    await expect(mailbox.moveUnread(mgrA, mgrA, [a!])).rejects.toThrow(/identical/);
    await expect(mailbox.moveUnread(mgrA, mgrB, ["nope"])).rejects.toThrow(/malformed/);
  });

  it("reads an absent mailbox as empty rather than conjuring directories", async () => {
    const { mailbox, namespace } = await fixture();
    expect(await mailbox.list(mgrA)).toEqual([]);
    // The read left no mailbox root behind — create:false stays side-effect free.
    expect(await mailbox.list(mgrA)).toEqual([]);
    expect((await readdir(namespace.dir)).filter((name) => name === DAEMON_MAILBOX_DIR_NAME)).toEqual([]);
  });

  it("fences every locked operation to exactly the held lock set", async () => {
    const { mailbox, namespace } = await fixture({ ownership: fixedOwner(mgrA) });
    const seeded = await mailbox.writeRunEvent(runEvent());
    if (!seeded.persisted) throw new Error("expected persist");
    await mailbox.withMailboxes([mgrA, mgrB], async (locked) => {
      // The journaled move primitive inside the held lock pair.
      const outcome = await locked.moveUnread(mgrA, mgrB, [seeded.eventId]);
      expect(outcome.moved).toEqual([seeded.eventId]);
      expect(await readdir(unreadDir(namespace, mgrB))).toContain(`${seeded.eventId}.json`);
      // A malformed move plan refuses before any rename.
      await expect(locked.moveUnread(mgrA, mgrA, [seeded.eventId])).rejects.toThrow(/malformed/);
    });
    // A key outside the held set refuses before any filesystem touch.
    await expect(mailbox.withMailboxes([mgrA], async (locked) => locked.list(mgrB))).rejects.toThrow(/outside the held lock set/);
    await expect(mailbox.withMailboxes([mgrA], async (locked) => locked.read(mgrB, seeded.eventId))).rejects.toThrow(/outside the held lock set/);
  });

  it("surfaces an untrusted mailbox root as its own error, never wrapped", async () => {
    const { mailbox, namespace } = await fixture();
    // A group-writable mailbox root fails the owner-only check inside the
    // resolution try; the DaemonMailboxError must propagate unwrapped.
    await mkdir(join(namespace.dir, DAEMON_MAILBOX_DIR_NAME), { mode: 0o775, recursive: true });
    await expect(mailbox.list(mgrA)).rejects.toThrowError(DaemonMailboxError);
  });

  it("wraps a foreign fault beneath the namespace root as mailbox-unavailable", async () => {
    const { mailbox, namespace } = await fixture();
    // An unreadable namespace root makes the mailbox lstat fail EACCES — not
    // DaemonMailboxError, not ENOENT — so the root wraps it as unavailable.
    await chmod(namespace.dir, 0o000);
    try {
      await expect(mailbox.list(mgrA)).rejects.toThrowError(/unavailable/);
    } finally {
      await chmod(namespace.dir, 0o700);
    }
  });

  it("counts an already-acked recorded id as landed and rethrows non-absent read faults", async () => {
    const { mailbox, namespace } = await fixture({ ownership: fixedOwner(mgrA) });
    const seeded = await mailbox.writeRunEvent(runEvent());
    if (!seeded.persisted) throw new Error("expected persist");
    await mailbox.ack(mgrA, seeded.eventId);
    const event: MailboxRunEvent = { id: seeded.eventId, at: "2026-01-01T00:00:00.000Z", kind: "work_cycle_completed", runId: "run-1", jobId: "job-1", actions: [] };
    const reply = await mailbox.withMailboxes([mgrA], (locked) => locked.writeRecordedEvent(mgrA, event));
    expect(reply).toEqual({ persisted: true, eventId: seeded.eventId, path: join(ackedDir(namespace, mgrA), `${seeded.eventId}.json`) });

    // An untrusted manager directory surfaces the read fault, never a silent rewrite.
    const foreign = managerKey("untrusted");
    await writeFile(join(namespace.dir, DAEMON_MAILBOX_DIR_NAME, foreign), "x");
    await expect(mailbox.withMailboxes([foreign], (locked) => locked.writeRecordedEvent(foreign, event))).rejects.toThrow();
  });

  it("keeps a held gap pending when the mailbox directory itself is unreadable", async () => {
    const lines: string[] = [];
    const { mailbox, namespace } = await fixture({ log: (line) => lines.push(line) });
    const port = createDaemonJsonPort(namespace.dir);
    const held = { kind: "downtime_gap", at: "2026-01-01T00:05:00.000Z", id: mailboxEventId(new Date("2026-01-01T00:05:00.000Z")), from: "a", to: "b", lost: {} };
    await port.write({ pendingGap: { [mgrA]: held } });
    // A plain file where the manager mailbox belongs makes the durable-check
    // read reject — the held gap must survive, logged.
    await mkdir(join(namespace.dir, DAEMON_MAILBOX_DIR_NAME), { mode: 0o700, recursive: true });
    await writeFile(join(namespace.dir, DAEMON_MAILBOX_DIR_NAME, mgrA), "x");
    await mailbox.retryPendingGaps();
    expect((await mailbox.degradation()).pendingGap).toEqual({ [mgrA]: held });
    expect(lines.some((line) => line.includes("pendingGap retry failed"))).toBe(true);
  });
});

describe("event boundary validation", () => {
  it("refuses malformed identity, actions, decision, handoff, IDs, and oversized bodies", async () => {
    const { mailbox } = await fixture({ ownership: fixedOwner(mgrA) });
    await expect(mailbox.writeRunEvent({ ...runEvent(), runId: "" })).rejects.toThrow(/identity/);
    await expect(mailbox.writeRunEvent({ ...runEvent(), actions: [1 as unknown as string] })).rejects.toThrow(/actions/);
    await expect(mailbox.writeRunEvent({ ...runEvent(), decision: { verdict: "", labels: [], evidenceDigest: "", reviewerModel: "m" } })).rejects.toThrow(/decision/);
    await expect(mailbox.writeRunEvent({ ...runEvent(), handoff: { state: "" } })).rejects.toThrow(/handoff/);
    await expect(mailbox.writeRunEvent({ ...runEvent(), id: "../escape" })).rejects.toThrow(/event ID/);
    await expect(mailbox.writeRunEvent({ ...runEvent(), id: "2026-01-01T000000.000Z-00000000-0000-0000-0000-000000000000", actions: ["x".repeat(300)] })).rejects.toThrow(/actions/);
    await expect(mailbox.writeGapEvent(mgrA, { from: "", to: "t", lost: {} })).rejects.toThrow(/gap event/);
    const huge: MailboxGapEventInput = {
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-01T00:05:00.000Z",
      lost: Object.fromEntries(Array.from({ length: 400 }, (_unused, index) => [`m${index}`, { count: index, firstAt: "f".repeat(64), lastAt: "l".repeat(64) }])),
    };
    await expect(mailbox.writeGapEvent(mgrA, huge)).rejects.toThrow(/byte bound/);
    await expect(mailbox.checkLaunchCapacity("junk")).rejects.toThrow(/manager session key/);
    // Every optional body field may be absent.
    await expect(mailbox.writeRunEvent({ kind: "evidence_gap", runId: "run-1", jobId: "job-1" })).resolves.toMatchObject({ persisted: true });
  });
});

// ---------------------------------------------------------------- wiring seams

const session = { source: "herdr:pi", agent: "pi", kind: "path", value: "/pi/session.jsonl" };
const identity: SupervisedIdentity = { paneId: "p1", terminalId: "t1", agentName: "worker", agentKind: "pi", agentSession: session };

function paneRecord(options: { status?: string; revision?: number } = {}): Record<string, unknown> {
  return {
    pane_id: "p1",
    terminal_id: "t1",
    tab_id: "tab1",
    workspace_id: "w1",
    agent_status: options.status ?? "idle",
    revision: options.revision ?? 5,
    agent: "pi",
    agent_session: session,
  };
}

function snapshot(panes: Array<Record<string, unknown>>): HerdrSnapshot {
  return parseSnapshotResult({ type: "session_snapshot", snapshot: { version: "0.8.2", protocol: 22, workspaces: [], tabs: [], panes, agents: [{ pane_id: "p1", name: "worker" }] } });
}

function paneEvent(kind: string, pane: Record<string, unknown>): SupervisionSocketEvent {
  return parseSocketLine(JSON.stringify({ event: kind, data: { type: kind, pane } })) as SupervisionSocketEvent;
}

interface Harness {
  supervisor: Supervisor;
  wakes: SupervisionWake[];
  updates: Array<{ text: string; details: unknown }>;
  fireTimer(): void;
}

function supervisorHarness(options: { snapshots: HerdrSnapshot[]; gate?: HandoffGate; eventWriter?: MailboxEventWriter; updateThrows?: boolean }): Harness {
  const queue = [...options.snapshots];
  const wakes: SupervisionWake[] = [];
  const updates: Array<{ text: string; details: unknown }> = [];
  let timer: (() => void) | undefined;
  const scheduler: SupervisionScheduler = {
    setTimer: (callback) => {
      timer = callback;
      return "timer";
    },
    clearTimer: () => {
      timer = undefined;
    },
  };
  const deps: SupervisorDependencies = {
    jobId: "job_mailbox",
    child: { agentName: "worker", agentKind: "pi", operatingPointId: "worker-pi" },
    monitor: {
      addObserver: () => undefined,
      removeObserver: () => undefined,
      snapshot: async () => {
        const next = queue.shift();
        if (next === undefined) throw new Error("no scripted snapshot");
        return next;
      },
      generation: 1,
      isDegraded: () => false,
    },
    notifier: { wake: (wake) => { wakes.push(wake); } },
    reviewer: { review: async () => ({ classification: "blocked", summary: "stuck" }) },
    reviewLog: async () => undefined,
    cadenceMs: 300_000,
    clock: { now: () => 1_000 },
    scheduler,
    readTranscript: async () => ["line"],
    traceSource: createTraceSource({
      readFileRange: async () => new Uint8Array(),
      readTerminal: async () => ["line"],
      devinSession: async () => ({ position: undefined, events: [] }),
    }),
    update: (text, details) => {
      if (options.updateThrows === true) throw new Error("progress sink is down");
      updates.push({ text, details });
    },
    ...(options.gate === undefined ? {} : { handoffs: options.gate }),
    ...(options.eventWriter === undefined ? {} : { eventWriter: options.eventWriter }),
  };
  return { supervisor: new Supervisor(deps), wakes, updates, fireTimer: () => timer?.() };
}

/** A minimal managed-run gate: enough for the supervisor to resolve a run ID. */
function stubGate(runId: string, lifecycle: string): HandoffGate {
  return {
    lookup: () => ({ runId, lifecycle } as unknown as HandoffRun),
  } as unknown as HandoffGate;
}

const stubView = (): SupervisionJobView => ({
  monitor: { connected: true, degraded: false, generation: 1, evidenceGaps: 0 },
  reviewer: { model: "testmodel", cadenceMinutes: 1, degraded: false, reviews: [], truncatedReviews: 0 },
  transitions: [],
  truncatedTransitions: 0,
  events: [],
  truncatedEvents: 0,
  unobservedEvents: 0,
  state: "settled",
});

describe("writer wiring seams", () => {
  it("routes supervisor events through the writer and keeps supervision running at cap", async () => {
    const { mailbox, namespace } = await fixture({ ownership: fixedOwner(mgrA) });
    await seed(namespace, mgrA, "unread", MAILBOX_UNREAD_MAX_FILES);
    // The wrapper lets the test await the fire-and-forget persist chain itself.
    const completed: MailboxRunEventInput[] = [];
    const writer: MailboxEventWriter = {
      writeRunEvent: async (input) => {
        const result = await mailbox.writeRunEvent(input);
        completed.push(input);
        return result;
      },
    };
    const h = supervisorHarness({ snapshots: [snapshot([paneRecord({ status: "working" })])], gate: stubGate("run-1", "handed_off"), eventWriter: writer });
    try {
      await h.supervisor.bind({ identity, operatingPointId: "worker-pi" });
      // A review wake carries the bounded decision evidence into the body.
      h.fireTimer();
      await vi.waitFor(() => expect(h.wakes.map((wake) => wake.event.type)).toContain("reviewer_attention"));
      await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "blocked", revision: 6 })));
      await vi.waitFor(() => expect(h.wakes.map((wake) => wake.event.type)).toEqual(["reviewer_attention", "blocked"]));
      // At cap: no file written, every refusal recorded on the job view as
      // `persistenceFailed` with its event ID — and supervision continued.
      expect(await mailbox.list(mgrA)).toHaveLength(MAILBOX_UNREAD_MAX_FILES);
      await vi.waitFor(async () => expect((await mailbox.degradation()).unpersisted[mgrA]).toMatchObject({ count: 2 }));
      const failures = h.updates.filter((update) => (update.details as { persistenceFailed?: boolean }).persistenceFailed === true);
      expect(failures.map((update) => (update.details as { eventId?: string }).eventId).sort())
        .toEqual(h.wakes.map((wake) => wake.event.eventId).sort());
      for (const update of failures) expect(update.details).toMatchObject({ reason: "capacity" });
      expect(h.supervisor.view().state).toBe("active");
      // Drain: the next event lands in the CURRENT owner's mailbox.
      const seededIds = (await readdir(unreadDir(namespace, mgrA))).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length));
      for (const id of seededIds.slice(0, 1)) await mailbox.ack(mgrA, id);
      await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "done", revision: 7 })));
      await vi.waitFor(() => expect(h.wakes.map((wake) => wake.event.type)).toEqual(["reviewer_attention", "blocked", "work_cycle_completed"]));
      await vi.waitFor(async () => expect(await mailbox.list(mgrA)).toHaveLength(MAILBOX_UNREAD_MAX_FILES));
      await vi.waitFor(() => expect(completed).toHaveLength(3));
      const landed = (await mailbox.list(mgrA)).filter((id) => !String(id).startsWith("2023-"));
      expect(landed).toHaveLength(1);
      expect(await mailbox.read(mgrA, landed[0]!)).toMatchObject({ kind: "work_cycle_completed", runId: "run-1", jobId: "job_mailbox" });
    } finally {
      h.supervisor.shutdown();
    }
  });

  it("persists nothing without an owned run and records an unavailable writer failure", async () => {
    // No managed run: the event has no owner mailbox to resolve.
    const withoutRun = supervisorHarness({ snapshots: [snapshot([paneRecord({ status: "working" })])], eventWriter: { writeRunEvent: async () => { throw new Error("must not be called"); } } });
    try {
      await withoutRun.supervisor.bind({ identity, operatingPointId: "worker-pi" });
      await withoutRun.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "blocked", revision: 6 })));
      await vi.waitFor(() => expect(withoutRun.wakes.map((wake) => wake.event.type)).toEqual(["blocked"]));
    } finally {
      withoutRun.supervisor.shutdown();
    }
    // A writer that rejects records `persistenceFailed: "unavailable"` and
    // never claims the event persisted.
    const { mailbox: bare } = await fixture();
    const failing = supervisorHarness({ snapshots: [snapshot([paneRecord({ status: "working" })])], gate: stubGate("run-1", "handed_off"), eventWriter: bare });
    try {
      await failing.supervisor.bind({ identity, operatingPointId: "worker-pi" });
      await failing.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "blocked", revision: 6 })));
      await vi.waitFor(() => expect(failing.wakes.map((wake) => wake.event.type)).toEqual(["blocked"]));
      await vi.waitFor(() => expect(failing.updates.some((update) => (update.details as { reason?: string }).reason === "unavailable")).toBe(true));
      expect(failing.updates.some((update) => (update.details as { persistenceFailed?: boolean }).persistenceFailed === true)).toBe(true);
    } finally {
      failing.supervisor.shutdown();
    }
  });

  it("routes JobRegistry terminal settlement through the writer for the bound run", async () => {
    const captured: MailboxRunEventInput[] = [];
    const writer: MailboxEventWriter = {
      writeRunEvent: async (input) => {
        captured.push(input);
        return { persisted: true, eventId: "e", path: "/x" };
      },
    };
    let jobSequence = 0;
    const registry = new JobRegistry({ idFactory: () => `job_${++jobSequence}`, clock: { now: () => 1 }, eventWriter: writer });
    const supervisorRequest: SupervisorJobRequestSnapshot = {
      kind: "supervisor",
      label: "supervise worker",
      targets: ["p1"],
      targetIds: ["p1"],
      child: { agentName: "worker", agentKind: "pi", operatingPointId: "worker-pi" },
      settings: { reviewCadenceMinutes: 1, reviewerModel: "testmodel" },
    };
    const handle = registry.register(supervisorRequest, async () => ({ supervision_result: "released", reason: "child_exited" }));
    registry.attachSupervision(handle.jobId, {
      view: stubView,
      takePendingEvents: () => [],
      handoffEvidence: () => ({ gated: true, runId: "run-7", path: "/run", state: "handed_off" }),
    } as unknown as SupervisionJobPort);
    await handle.promise;
    await vi.waitFor(() => expect(captured).toHaveLength(1));
    expect(captured[0]).toMatchObject({ kind: "job_terminal", runId: "run-7", jobId: "job_1", handoff: { state: "handed_off" }, actions: ["released"] });

    // A supervisor job with no gated run resolves no destination.
    const none = registry.register({ ...supervisorRequest, label: "supervise ungated" }, async () => ({ supervision_result: "released" }));
    registry.attachSupervision(none.jobId, {
      view: stubView,
      takePendingEvents: () => [],
      handoffEvidence: () => ({ gated: false, reason: "no_managed_run" }),
    } as unknown as SupervisionJobPort);
    await none.promise;
    // A generic (wait) job has no supervision port and no run to resolve.
    const waitRequest: JobRequestSnapshot = {
      kind: "wait",
      label: "wait",
      targets: ["p1"],
      targetIds: ["p1"],
      match: "any",
      condition: { kind: "state", state: "done" },
      timeoutMs: 10,
      settings: { reviewCadenceMinutes: 1, reviewerModel: "testmodel", reviewerThinking: "low" },
    };
    const waitJob = registry.register(waitRequest, async () => ({ wait_result: "condition_met", matched: true }));
    await waitJob.promise;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(captured).toHaveLength(1);

    // A rejecting writer is contained exactly like onTerminal: settlement is
    // untouched and nothing claims the event persisted.
    const rejecting = new JobRegistry({ idFactory: () => `job_r${++jobSequence}`, clock: { now: () => 1 }, eventWriter: { writeRunEvent: async () => { throw new Error("sink down"); } } });
    const rejected = rejecting.register(supervisorRequest, async () => ({ supervision_result: "released" }));
    rejecting.attachSupervision(rejected.jobId, {
      view: stubView,
      takePendingEvents: () => [],
      handoffEvidence: () => ({ gated: true, runId: "run-8", path: "/run", state: "handed_off" }),
    } as unknown as SupervisionJobPort);
    await rejected.promise;
    expect(rejecting.get(rejected.jobId)?.supervision_result).toBe("released");
  });
});

describe("truthful degradation under faults", () => {
  it("refuses an untrusted namespace, root, and manager directory", async () => {
    // A namespace that never resolves is a typed refusal, never a fabricated one.
    const rejecting = createMailbox({ namespace: () => Promise.reject(new Error("no endpoint")) });
    await expect(rejecting.list(mgrA)).rejects.toThrow(/namespace is unavailable/);
    const typed = createMailbox({ namespace: () => Promise.reject(new DaemonMailboxError("MAILBOX_EVENT_INVALID", "typed refusal")) });
    await expect(typed.list(mgrA)).rejects.toThrow(/typed refusal/);

    const { mailbox, namespace } = await fixture();
    // A vanished namespace directory is refused; a stranger-writable one is too.
    await rm(namespace.dir, { recursive: true, force: true });
    await expect(mailbox.list(mgrA)).rejects.toThrow(/namespace is unavailable/);
    await mkdir(namespace.dir, { recursive: true, mode: 0o700 });
    await chmod(namespace.dir, 0o777);
    await expect(mailbox.list(mgrA)).rejects.toThrow(/not trusted/);
    await chmod(namespace.dir, 0o700);
  });

  it("refuses a mailbox root it cannot create and one that is not a directory", async () => {
    const { mailbox, namespace } = await fixture({ ownership: fixedOwner(mgrA) });
    await chmod(namespace.dir, 0o500);
    try {
      await expect(mailbox.writeRunEvent(runEvent())).rejects.toThrow(/root is unavailable/);
    } finally {
      await chmod(namespace.dir, 0o700);
    }
    await writeFile(join(namespace.dir, DAEMON_MAILBOX_DIR_NAME), "not a directory");
    await expect(mailbox.writeRunEvent(runEvent())).rejects.toThrow(/not trusted/);
  });

  it("refuses a manager directory that is not a directory", async () => {
    const { mailbox, namespace } = await fixture({ ownership: fixedOwner(mgrA) });
    await mkdir(join(namespace.dir, DAEMON_MAILBOX_DIR_NAME), { recursive: true, mode: 0o700 });
    await writeFile(join(namespace.dir, DAEMON_MAILBOX_DIR_NAME, mgrA), "not a directory");
    await expect(mailbox.writeRunEvent(runEvent())).rejects.toThrow(/directory is unavailable/);
  });

  it("ignores crash-leftover non-event files in the unread counts and reports an unstorable event as failed", async () => {
    const { mailbox, namespace } = await fixture({ ownership: fixedOwner(mgrA) });
    await mkdir(unreadDir(namespace, mgrA), { recursive: true, mode: 0o700 });
    await writeFile(join(unreadDir(namespace, mgrA), ".leftover.tmp"), "junk");
    expect(await mailbox.writeRunEvent(runEvent("run-junk"))).toMatchObject({ persisted: true });
    expect(await mailbox.list(mgrA)).toHaveLength(1);
    // The status projection over an untouched mailbox is truthful and empty.
    const empty = await fixture();
    expect(await empty.mailbox.degradation()).toEqual({ capacity: "ok", unpersisted: {}, pendingGap: {} });
    // A directory that cannot stage the event reports `persistenceFailed`, never success.
    await chmod(unreadDir(namespace, mgrA), 0o500);
    try {
      await expect(mailbox.writeRunEvent(runEvent("run-unwritable"))).resolves.toMatchObject({
        persisted: false,
        persistenceFailed: true,
        reason: "unavailable",
      });
    } finally {
      await chmod(unreadDir(namespace, mgrA), 0o700);
    }
    expect((await mailbox.degradation()).unpersisted[mgrA]).toMatchObject({ count: 1 });
  });

  it("refuses a daemon.json it cannot read or stage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-mailbox-port-"));
    dirs.push(dir);
    const port = createDaemonJsonPort(dir);
    // A daemon.json that is a directory is an unreadable record, never fabricated.
    await mkdir(join(dir, "daemon.json"));
    await expect(port.read()).rejects.toThrow(/status record is unavailable/);
    // A namespace with no writable directory cannot stage a status write; the
    // default log line is exercised because no log sink is injected.
    const { mailbox, namespace } = await fixture({ ownership: fixedOwner(mgrA), status: createDaemonJsonPort(join(dir, "missing")) });
    const id = mailboxEventId(new Date("2026-01-01T00:00:00.000Z"));
    await mkdir(unreadDir(namespace, mgrA), { recursive: true, mode: 0o700 });
    await writeFile(join(unreadDir(namespace, mgrA), `${id}.json`), "pre-existing", { mode: 0o600 });
    await expect(mailbox.writeRunEvent(runEvent("run-2", { id }))).resolves.toMatchObject({ persisted: false, reason: "collision" });
  });

  it("logs and discloses when daemon.json itself cannot be written", async () => {
    const failures: string[] = [];
    const held: Record<string, unknown> = {};
    const failingWrite = async (): Promise<void> => {
      throw "daemon.json is down";
    };
    const { mailbox, namespace } = await fixture({
      ownership: fixedOwner(mgrA),
      status: {
        read: async () => ({ pendingGap: held }),
        write: failingWrite,
      },
      log: (line) => failures.push(line),
    });
    // A collision's loss accounting failing is logged with the raw error.
    const id = mailboxEventId(new Date("2026-01-01T00:00:00.000Z"));
    await mkdir(unreadDir(namespace, mgrA), { recursive: true, mode: 0o700 });
    await writeFile(join(unreadDir(namespace, mgrA), `${id}.json`), "pre-existing", { mode: 0o600 });
    expect(await mailbox.writeRunEvent(runEvent("run-2", { id }))).toMatchObject({ persisted: false, reason: "collision" });
    expect(failures.some((line) => line.includes("loss accounting failed") && line.includes("daemon.json is down"))).toBe(true);
    // A held gap whose file already landed clears through a failing write: logged.
    const gapId = mailboxEventId(new Date("2026-01-01T00:01:00.000Z"));
    await writeFile(join(unreadDir(namespace, mgrA), `${gapId}.json`), "landed", { mode: 0o600 });
    held[mgrA] = { id: gapId, at: "2026-01-01T00:01:00.000Z", kind: "downtime_gap", from: "f", to: "t", lost: {} };
    await mailbox.retryPendingGaps();
    expect(failures.some((line) => line.includes("pendingGap write failed") && line.includes("daemon.json is down"))).toBe(true);
    // A held gap that cannot even be rewritten stays pending and is logged.
    held[mgrA] = { kind: "downtime_gap", at: "t", from: 123, to: "t", lost: {} };
    await mailbox.retryPendingGaps();
    expect(failures.some((line) => line.includes("pendingGap retry failed"))).toBe(true);
  });

  it("records persistenceFailed on the job view even when the progress sink throws", async () => {
    const { mailbox: bare } = await fixture();
    const h = supervisorHarness({
      snapshots: [snapshot([paneRecord({ status: "working" })])],
      gate: stubGate("run-1", "handed_off"),
      eventWriter: bare,
      updateThrows: true,
    });
    try {
      await h.supervisor.bind({ identity, operatingPointId: "worker-pi" });
      await h.supervisor.onEvent(paneEvent("pane_updated", paneRecord({ status: "blocked", revision: 6 })));
      await vi.waitFor(() => expect(h.wakes.map((wake) => wake.event.type)).toEqual(["blocked"]));
      // The refusal is contained: no throw escapes into supervision.
      expect(h.supervisor.view().state).toBe("active");
    } finally {
      h.supervisor.shutdown();
    }
  });
});

describe("daemon main wiring", () => {
  it("retries pendingGap on every heartbeat through the daemon's status queue", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-mailbox-main-"));
    dirs.push(dir);
    const socket = join(dir, "herdr.sock");
    await writeFile(socket, "");
    const namespace = await resolveDaemonNamespace({ HERDR_SOCKET_PATH: socket });
    let retries = 0;
    const mailbox = {
      retryPendingGaps: async () => {
        retries += 1;
      },
    } as unknown as Mailbox;
    const daemon = await startDaemon({ namespace, heartbeatMs: 15, mailbox });
    try {
        await vi.waitFor(() => expect(retries).toBeGreaterThan(1));
    } finally {
      await daemon.shutdown();
    }
    expect(daemon.mailbox).toBe(mailbox);
  });

  it("lands a held pendingGap through the daemon's own status queue", async () => {
    const dir = await mkdtemp(join(tmpdir(), "herdr-mailbox-gap-"));
    dirs.push(dir);
    const socket = join(dir, "herdr.sock");
    await writeFile(socket, "");
    const namespace = await resolveDaemonNamespace({ HERDR_SOCKET_PATH: socket });
    const gapId = mailboxEventId(new Date("2026-01-01T00:00:00.000Z"));
    const gap = { id: gapId, at: "2026-01-01T00:00:00.000Z", kind: "downtime_gap", from: "f", to: "t", lost: {} };
    await writeFile(join(namespace.dir, "daemon.json"), JSON.stringify({ pendingGap: { [mgrA]: gap } }), { mode: 0o600 });
    // No injected mailbox: the daemon's own carries the retry and clears the
    // hold through the shared status queue once the event lands.
    const daemon = await startDaemon({ namespace, heartbeatMs: 15 });
    try {
      await vi.waitFor(async () => expect((await daemon.mailbox.degradation()).pendingGap).toEqual({}));
    } finally {
      await daemon.shutdown();
    }
    const landed = JSON.parse(await readFile(join(unreadDir(namespace, mgrA), `${gapId}.json`), "utf8")) as Record<string, unknown>;
    expect(landed).toMatchObject({ id: gapId, kind: "downtime_gap" });
    const raw = JSON.parse(await readFile(join(namespace.dir, "daemon.json"), "utf8")) as Record<string, unknown>;
    expect(raw.pendingGap).toEqual({});
    expect(raw.startedAt).toEqual(expect.any(String));
  });
});
