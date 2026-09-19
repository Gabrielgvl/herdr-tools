import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireFlockHolder } from "../../src/pane-write-lock.js";
import type * as PaneWriteLock from "../../src/pane-write-lock.js";
import {
  appendSupervisionDisposition,
  appendSupervisionReview,
  defaultReviewLogRoot,
  reviewLogPaths,
  type SupervisionDispositionLogEntry,
  type SupervisionLogRecord,
  type SupervisionReviewLogEntry,
  type SupervisionReviewLogPaths,
} from "../../src/supervision/review-log.js";

/** fs failures the filesystem alone cannot schedule deterministically. */
const fsControl = vi.hoisted(() => ({
  failLstat: undefined as undefined | ((path: string) => Error | undefined),
  failOpen: undefined as undefined | ((path: string) => Error | undefined),
  failAppend: undefined as undefined | ((path: string) => Error | undefined),
  failClose: undefined as undefined | (() => Error | undefined),
  statMode: undefined as undefined | number,
  onClose: undefined as undefined | (() => void),
}));

/** Lease substitutions for holder failures a real flock cannot schedule deterministically. */
const lockControl = vi.hoisted(() => ({
  acquire: undefined as undefined | (() => Promise<{ check(): Promise<void>; release(): Promise<void> }>),
}));

vi.mock("../../src/pane-write-lock.js", async (importOriginal) => {
  const real = await importOriginal<typeof PaneWriteLock>();
  return {
    ...real,
    acquireFlockHolder: (options: Parameters<typeof real.acquireFlockHolder>[0]) =>
      lockControl.acquire === undefined ? real.acquireFlockHolder(options) : lockControl.acquire(),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof FsPromises>();
  const target = (path: unknown) => String(path).endsWith("reviews.jsonl");
  return {
    ...real,
    lstat: async (path: Parameters<typeof real.lstat>[0], options?: Parameters<typeof real.lstat>[1]) => {
      const error = fsControl.failLstat?.(String(path));
      if (error !== undefined) throw error;
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
          if (fsControl.statMode !== undefined) Object.assign(value, { mode: fsControl.statMode });
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
        },
      } as typeof handle;
    },
  };
});

const dirs: string[] = [];
afterEach(async () => {
  fsControl.failLstat = undefined;
  fsControl.failOpen = undefined;
  fsControl.failAppend = undefined;
  fsControl.failClose = undefined;
  fsControl.statMode = undefined;
  fsControl.onClose = undefined;
  lockControl.acquire = undefined;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempdir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "herdr-review-log-"));
  dirs.push(dir);
  return dir;
}

/** Pre-create the log directories owner-only, as `ensureLogDirectory` does on first append. */
async function seedLogDir(root: string): Promise<SupervisionReviewLogPaths> {
  const paths = reviewLogPaths(root);
  await mkdir(paths.directory, { recursive: true });
  await chmod(join(root, ".herdr"), 0o700);
  await chmod(paths.directory, 0o700);
  return paths;
}

const SIGNALS = { progress: 0.88, stalled: 0.1, blocked: 0.2, risk: 0.72, appears_complete: 0.02 };
const AGENT_SESSION = { source: "herdr:pi", agent: "pi", kind: "id", value: "s1" };

function entry(overrides: Record<string, unknown> = {}): SupervisionReviewLogEntry {
  return {
    jobId: "job_supervisor",
    agentName: "worker",
    agentKind: "pi",
    atMs: 1_000,
    classification: "stalled",
    attention: true,
    signals: { ...SIGNALS },
    evidenceSufficiency: 0.9,
    reason: "no_output",
    lastMeaningfulProgressAtMs: 800,
    linesSinceLastReview: 12,
    previousClassification: "progress",
    evidence: {
      paneId: "p1",
      terminalId: "t1",
      agentSession: { ...AGENT_SESSION },
      revision: 5,
      stateChangeSeq: 9,
      transcriptLines: 42,
      workingForMs: 300_000,
    },
    ...overrides,
  } as SupervisionReviewLogEntry;
}

function dispositionEntry(overrides: Record<string, unknown> = {}): SupervisionDispositionLogEntry {
  return {
    jobId: "job_supervisor",
    eventId: "sev_1",
    disposition: "acted",
    atMs: 2_000,
    ...overrides,
  } as SupervisionDispositionLogEntry;
}

async function readRecords(path: string): Promise<SupervisionLogRecord[]> {
  const content = await readFile(path, "utf8");
  return content.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as SupervisionLogRecord);
}

const eacces = () => Object.assign(new Error("EACCES"), { code: "EACCES" });
const eio = () => Object.assign(new Error("EIO"), { code: "EIO" });

describe("appendSupervisionReview records", () => {
  it("persists one fixed-schema review line with every probability, decision, watermark, and evidence cursor, plus 0600", async () => {
    const root = await tempdir();
    const paths = reviewLogPaths(root);
    await appendSupervisionReview(entry(), { root, now: () => new Date("2026-09-18T10:00:00.000Z"), deadlineMs: 10_000 });
    const content = await readFile(paths.reviews, "utf8");
    expect(content.endsWith("\n")).toBe(true);
    const records = await readRecords(paths.reviews);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(Object.keys(record)).toEqual([
      "type", "timestamp", "jobId", "agentName", "agentKind", "atMs", "classification", "attention",
      "signals", "evidenceSufficiency", "reason", "lastMeaningfulProgressAtMs", "linesSinceLastReview",
      "previousClassification", "evidence",
    ]);
    expect(record).toMatchObject({
      type: "review",
      timestamp: "2026-09-18T10:00:00.000Z",
      jobId: "job_supervisor",
      agentName: "worker",
      agentKind: "pi",
      atMs: 1_000,
      classification: "stalled",
      attention: true,
      signals: SIGNALS,
      evidenceSufficiency: 0.9,
      reason: "no_output",
      lastMeaningfulProgressAtMs: 800,
      linesSinceLastReview: 12,
      previousClassification: "progress",
      evidence: {
        paneId: "p1",
        terminalId: "t1",
        agentSession: AGENT_SESSION,
        revision: 5,
        stateChangeSeq: 9,
        transcriptLines: 42,
        workingForMs: 300_000,
      },
    });
    expect((await lstat(paths.reviews)).mode & 0o777).toBe(0o600);
  });

  it("persists an attention wake beside its review with an honestly unknown disposition", async () => {
    const root = await tempdir();
    const paths = reviewLogPaths(root);
    await appendSupervisionReview(entry({ wake: { eventId: "sev_1", eventType: "reviewer_attention", atMs: 1_001 } }), { root });
    const records = await readRecords(paths.reviews);
    expect(records).toHaveLength(2);
    expect(records[0]!.type).toBe("review");
    const wake = records[1]!;
    expect(Object.keys(wake)).toEqual(["type", "timestamp", "jobId", "agentName", "agentKind", "eventId", "eventType", "classification", "atMs", "reviewAtMs", "disposition"]);
    expect(wake).toMatchObject({
      type: "wake",
      jobId: "job_supervisor",
      agentName: "worker",
      agentKind: "pi",
      eventId: "sev_1",
      eventType: "reviewer_attention",
      classification: "stalled",
      atMs: 1_001,
      reviewAtMs: 1_000,
      disposition: "unknown",
    });
  });

  it("persists unknown and abstain-style reviews exactly like any other completed review", async () => {
    const root = await tempdir();
    const paths = reviewLogPaths(root);
    await appendSupervisionReview(entry({ classification: "unknown", attention: true, signals: undefined, evidenceSufficiency: undefined, reason: undefined }), { root });
    const records = await readRecords(paths.reviews);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ type: "review", classification: "unknown", attention: true, signals: null, evidenceSufficiency: null, reason: null });
  });

  it("persists a progress review that woke nobody", async () => {
    const root = await tempdir();
    await appendSupervisionReview(entry({ classification: "progress", attention: false }), { root });
    const records = await readRecords(reviewLogPaths(root).reviews);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ type: "review", classification: "progress", attention: false });
  });

  it("records honestly absent telemetry as null rather than refusing", async () => {
    const root = await tempdir();
    await appendSupervisionReview(
      entry({ signals: undefined, evidenceSufficiency: undefined, reason: undefined, lastMeaningfulProgressAtMs: undefined, linesSinceLastReview: undefined, previousClassification: undefined, evidence: undefined }),
      { root }
    );
    const records = await readRecords(reviewLogPaths(root).reviews);
    expect(records[0]).toMatchObject({
      type: "review",
      signals: null,
      evidenceSufficiency: null,
      reason: null,
      lastMeaningfulProgressAtMs: null,
      linesSinceLastReview: null,
      previousClassification: null,
      evidence: null,
    });
  });

  it("persists an evidence record carrying only the cursors the review pinned", async () => {
    const root = await tempdir();
    await appendSupervisionReview(entry({ evidence: { paneId: "p1", terminalId: "t1" } }), { root });
    const records = await readRecords(reviewLogPaths(root).reviews);
    expect(records[0]!.type).toBe("review");
    expect((records[0] as { evidence: unknown }).evidence).toEqual({ paneId: "p1", terminalId: "t1" });
  });

  it("preserves the first line across two appends", async () => {
    const root = await tempdir();
    const paths = reviewLogPaths(root);
    await appendSupervisionReview(entry({ jobId: "job_a", agentName: "worker" }), { root });
    await appendSupervisionReview(entry({ jobId: "job_b", agentName: "worker-2" }), { root });
    const content = await readFile(paths.reviews, "utf8");
    const records = await readRecords(paths.reviews);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ jobId: "job_a", agentName: "worker" });
    expect(records[1]).toMatchObject({ jobId: "job_b", agentName: "worker-2" });
    expect(content.split("\n").filter((line) => line.length > 0)).toHaveLength(2);
  });

  it("serializes concurrent cooperating appenders into parseable noninterleaved lines", async () => {
    const root = await tempdir();
    const paths = reviewLogPaths(root);
    const jobs = ["job_a", "job_b", "job_c", "job_d", "job_e"];
    await Promise.all(jobs.map((jobId) => appendSupervisionReview(entry({ jobId }), { root })));
    const content = await readFile(paths.reviews, "utf8");
    const lines = content.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(5);
    const seen: string[] = [];
    for (const line of lines) {
      const record = JSON.parse(line) as SupervisionLogRecord;
      expect(record.type).toBe("review");
      seen.push(record.jobId);
    }
    expect(seen.sort()).toEqual(jobs);
  });
});

describe("appendSupervisionReview refusal", () => {
  const cases: Array<{ name: string; mutate: (input: SupervisionReviewLogEntry) => unknown }> = [
    { name: "a null entry", mutate: () => null },
    { name: "an empty job id", mutate: (input) => ({ ...input, jobId: "" }) },
    { name: "a multi-line job id", mutate: (input) => ({ ...input, jobId: "job\nforged" }) },
    { name: "an untrusted agent name", mutate: (input) => ({ ...input, agentName: "Bad Name" }) },
    { name: "an empty agent name", mutate: (input) => ({ ...input, agentName: "" }) },
    { name: "an empty agent kind", mutate: (input) => ({ ...input, agentKind: "" }) },
    { name: "a non-string agent kind", mutate: (input) => ({ ...input, agentKind: 7 }) },
    { name: "a negative atMs", mutate: (input) => ({ ...input, atMs: -1 }) },
    { name: "a nonfinite atMs", mutate: (input) => ({ ...input, atMs: Number.NaN }) },
    { name: "a non-numeric atMs", mutate: (input) => ({ ...input, atMs: "1_000" }) },
    { name: "a foreign classification", mutate: (input) => ({ ...input, classification: "weird" }) },
    { name: "a non-boolean attention", mutate: (input) => ({ ...input, attention: "yes" }) },
    { name: "a non-record signals bag", mutate: (input) => ({ ...input, signals: "junk" }) },
    { name: "signals missing a key", mutate: (input) => ({ ...input, signals: { progress: 0.5, stalled: 0.1, blocked: 0.1, risk: 0.1 } }) },
    { name: "signals with an extra key", mutate: (input) => ({ ...input, signals: { ...SIGNALS, intruder: 0.1 } }) },
    { name: "an out-of-range signal", mutate: (input) => ({ ...input, signals: { ...SIGNALS, risk: 1.5 } }) },
    { name: "a non-numeric signal", mutate: (input) => ({ ...input, signals: { ...SIGNALS, stalled: "x" } }) },
    { name: "an out-of-range evidenceSufficiency", mutate: (input) => ({ ...input, evidenceSufficiency: 1.5 }) },
    { name: "a non-numeric evidenceSufficiency", mutate: (input) => ({ ...input, evidenceSufficiency: "high" }) },
    { name: "a foreign reason", mutate: (input) => ({ ...input, reason: "exploded" }) },
    { name: "a negative progress watermark", mutate: (input) => ({ ...input, lastMeaningfulProgressAtMs: -5 }) },
    { name: "a nonfinite progress watermark", mutate: (input) => ({ ...input, lastMeaningfulProgressAtMs: Number.POSITIVE_INFINITY }) },
    { name: "a negative line count", mutate: (input) => ({ ...input, linesSinceLastReview: -1 }) },
    { name: "a non-integer line count", mutate: (input) => ({ ...input, linesSinceLastReview: 1.5 }) },
    { name: "a non-numeric line count", mutate: (input) => ({ ...input, linesSinceLastReview: "12" }) },
    { name: "a foreign previous classification", mutate: (input) => ({ ...input, previousClassification: "weird" }) },
    { name: "a non-record evidence", mutate: (input) => ({ ...input, evidence: "junk" }) },
    { name: "an evidence without a pane", mutate: (input) => ({ ...input, evidence: { terminalId: "t1" } }) },
    { name: "an evidence without a terminal", mutate: (input) => ({ ...input, evidence: { paneId: "p1" } }) },
    { name: "a non-record agent session", mutate: (input) => ({ ...input, evidence: { paneId: "p1", terminalId: "t1", agentSession: "junk" } }) },
    { name: "an agent session missing a field", mutate: (input) => ({ ...input, evidence: { paneId: "p1", terminalId: "t1", agentSession: { source: "herdr:pi", agent: "pi", kind: "id" } } }) },
    { name: "an agent session with a newline", mutate: (input) => ({ ...input, evidence: { paneId: "p1", terminalId: "t1", agentSession: { ...AGENT_SESSION, value: "s\nforged" } } }) },
    { name: "a negative revision", mutate: (input) => ({ ...input, evidence: { paneId: "p1", terminalId: "t1", revision: -1 } }) },
    { name: "a non-integer sequence", mutate: (input) => ({ ...input, evidence: { paneId: "p1", terminalId: "t1", stateChangeSeq: 1.5 } }) },
    { name: "a non-numeric transcript count", mutate: (input) => ({ ...input, evidence: { paneId: "p1", terminalId: "t1", transcriptLines: "42" } }) },
    { name: "a negative working time", mutate: (input) => ({ ...input, evidence: { paneId: "p1", terminalId: "t1", workingForMs: -1 } }) },
    { name: "a non-record wake", mutate: (input) => ({ ...input, wake: "junk" }) },
    { name: "a wake without an event id", mutate: (input) => ({ ...input, wake: { eventType: "reviewer_attention", atMs: 1 } }) },
    { name: "a wake with a multi-line event id", mutate: (input) => ({ ...input, wake: { eventId: "sev\nforged", eventType: "reviewer_attention", atMs: 1 } }) },
    { name: "a wake with a foreign event type", mutate: (input) => ({ ...input, wake: { eventId: "sev_1", eventType: "bogus", atMs: 1 } }) },
    { name: "a wake with a negative atMs", mutate: (input) => ({ ...input, wake: { eventId: "sev_1", eventType: "reviewer_attention", atMs: -1 } }) },
  ];

  for (const { name, mutate } of cases) {
    it(`refuses ${name} without persisting a line`, async () => {
      const root = await tempdir();
      const paths = reviewLogPaths(root);
      await expect(appendSupervisionReview(mutate(entry()) as SupervisionReviewLogEntry, { root })).rejects.toMatchObject({ code: "REVIEW_LOG_UNAVAILABLE" });
      await expect(readFile(paths.reviews, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  }

  it("refuses a relative or empty root", async () => {
    await expect(appendSupervisionReview(entry(), { root: "relative/path" })).rejects.toMatchObject({ code: "REVIEW_LOG_UNAVAILABLE" });
    await expect(appendSupervisionReview(entry(), { root: "" })).rejects.toMatchObject({ code: "REVIEW_LOG_UNAVAILABLE" });
  });

  it("wraps unexpected clock failures in REVIEW_LOG_UNAVAILABLE", async () => {
    const root = await tempdir();
    await expect(appendSupervisionReview(entry(), { root, now: () => new Date("garbage") })).rejects.toMatchObject({ code: "REVIEW_LOG_UNAVAILABLE" });
  });
});

describe("appendSupervisionReview target safety", () => {
  it("refuses a symlinked review log without touching the target", async () => {
    const root = await tempdir();
    const paths = await seedLogDir(root);
    const elsewhere = join(root, "elsewhere.jsonl");
    await writeFile(elsewhere, "", { mode: 0o600 });
    await symlink(elsewhere, paths.reviews);
    await expect(appendSupervisionReview(entry(), { root })).rejects.toMatchObject({ code: "REVIEW_LOG_UNAVAILABLE" });
    expect(await readFile(elsewhere, "utf8")).toBe("");
  });

  it("refuses a directory or world-writable file at the review path", async () => {
    const root = await tempdir();
    const paths = await seedLogDir(root);
    await mkdir(paths.reviews);
    await expect(appendSupervisionReview(entry(), { root })).rejects.toMatchObject({ code: "REVIEW_LOG_UNAVAILABLE" });
    await rm(paths.reviews, { recursive: true });
    await writeFile(paths.reviews, "", { mode: 0o600 });
    await chmod(paths.reviews, 0o666);
    await expect(appendSupervisionReview(entry(), { root })).rejects.toMatchObject({ code: "REVIEW_LOG_UNAVAILABLE" });
    expect(await readFile(paths.reviews, "utf8")).toBe("");
  });

  it("refuses a symlinked, world-writable, or non-directory .herdr", async () => {
    for (const kind of ["symlink", "writable", "file"] as const) {
      const root = await tempdir();
      const dotHerdr = join(root, ".herdr");
      if (kind === "symlink") await symlink(join(root, "elsewhere"), dotHerdr);
      else if (kind === "writable") await mkdir(dotHerdr, { mode: 0o777 });
      else await writeFile(dotHerdr, "", { mode: 0o600 });
      await expect(appendSupervisionReview(entry(), { root })).rejects.toMatchObject({ code: "REVIEW_LOG_UNAVAILABLE" });
    }
  });

  it("surfaces indeterminate lstat, open failure, and an untrusted opened file", async () => {
    const root = await tempdir();
    const paths = reviewLogPaths(root);
    fsControl.failLstat = (path) => (path === join(root, ".herdr") ? eacces() : undefined);
    await expect(appendSupervisionReview(entry(), { root })).rejects.toMatchObject({ code: "REVIEW_LOG_UNAVAILABLE" });
    fsControl.failLstat = (path) => (path === paths.reviews ? eacces() : undefined);
    await expect(appendSupervisionReview(entry(), { root })).rejects.toMatchObject({ code: "REVIEW_LOG_UNAVAILABLE" });
    fsControl.failLstat = undefined;

    fsControl.failOpen = () => eacces();
    await expect(appendSupervisionReview(entry(), { root })).rejects.toMatchObject({ code: "REVIEW_LOG_UNAVAILABLE" });
    fsControl.failOpen = undefined;

    fsControl.statMode = 0o644;
    await expect(appendSupervisionReview(entry(), { root })).rejects.toMatchObject({ code: "REVIEW_LOG_UNAVAILABLE" });
    expect(await readFile(paths.reviews, "utf8")).toBe("");
  });

  it("surfaces a directory creation failure", async () => {
    const file = join(await tempdir(), "not-a-dir");
    await writeFile(file, "", { mode: 0o600 });
    await expect(appendSupervisionReview(entry(), { root: file })).rejects.toMatchObject({ code: "REVIEW_LOG_UNAVAILABLE" });
  });

  it("releases the lock and closes the handle when the write fails", async () => {
    const root = await tempdir();
    const paths = reviewLogPaths(root);
    let closes = 0;
    fsControl.onClose = () => { closes += 1; };
    fsControl.failAppend = () => eio();
    await expect(appendSupervisionReview(entry(), { root })).rejects.toMatchObject({ code: "REVIEW_LOG_UNAVAILABLE" });
    expect(closes).toBe(1);
    expect(await readFile(paths.reviews, "utf8")).toBe("");
    // The failed append released the section: a nonblock acquisition succeeds.
    const lease = await acquireFlockHolder({
      lockPath: paths.lock,
      wait: "nonblock",
      readyMarker: "HERDR_TEST_LOCK_READY",
      subject: "Test lock",
      failure: (message) => new Error(message),
    });
    await lease.release();
    // And a later cooperating append still writes a whole clean line.
    fsControl.failAppend = undefined;
    fsControl.onClose = undefined;
    await appendSupervisionReview(entry(), { root });
    const records = await readRecords(paths.reviews);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ jobId: "job_supervisor" });
  });

  it("fails the append when another process holds the lock, without writing", async () => {
    const root = await tempdir();
    const paths = reviewLogPaths(root);
    await appendSupervisionReview(entry({ jobId: "job_a" }), { root });
    const holder = spawn("flock", ["--exclusive", "--nonblock", paths.lock, "--command", "printf HERDR_HELD_READY; cat"], { stdio: ["pipe", "pipe", "pipe"] });
    try {
      const ready = new Promise<void>((resolve, reject) => {
        holder.stdout.setEncoding("utf8");
        holder.stdout.on("data", (chunk: string) => { if (chunk.includes("HERDR_HELD_READY")) resolve(); });
        holder.once("error", reject);
      });
      await ready;
      await expect(appendSupervisionReview(entry({ jobId: "job_b" }), { root, waitMs: 50 })).rejects.toMatchObject({ code: "REVIEW_LOG_UNAVAILABLE" });
    } finally {
      holder.stdin.end();
      await once(holder, "exit");
    }
    // The refused append never wrote; the first record is intact.
    const records = await readRecords(paths.reviews);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ jobId: "job_a" });
  });

  it("settles a failed close after the line is appended", async () => {
    const root = await tempdir();
    fsControl.failClose = () => eio();
    await appendSupervisionReview(entry(), { root });
    const records = await readRecords(reviewLogPaths(root).reviews);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ jobId: "job_supervisor" });
  });

  it("settles a failed release after the line is appended", async () => {
    const root = await tempdir();
    lockControl.acquire = async () => ({
      check: async () => {},
      release: async () => { throw new Error("wedged holder"); },
    });
    await appendSupervisionReview(entry(), { root });
    const records = await readRecords(reviewLogPaths(root).reviews);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ jobId: "job_supervisor" });
  });

  it("surfaces a failed acquisition as REVIEW_LOG_UNAVAILABLE without writing", async () => {
    const root = await tempdir();
    lockControl.acquire = async () => { throw new Error("no flock binary"); };
    await expect(appendSupervisionReview(entry(), { root })).rejects.toMatchObject({ code: "REVIEW_LOG_UNAVAILABLE" });
    const paths = reviewLogPaths(root);
    await expect(readFile(paths.reviews, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("appendSupervisionReview redaction", () => {
  it("never persists canary strings planted in extra entry, evidence, session, or signal fields", async () => {
    const root = await tempdir();
    const paths = reviewLogPaths(root);
    const dirty = {
      jobId: "job_supervisor",
      agentName: "worker",
      agentKind: "pi",
      atMs: 1_000,
      classification: "stalled",
      attention: true,
      signals: { ...SIGNALS },
      evidenceSufficiency: 0.9,
      reason: "no_output",
      lastMeaningfulProgressAtMs: 800,
      linesSinceLastReview: 12,
      previousClassification: "progress",
      evidence: {
        paneId: "p1",
        terminalId: "t1",
        agentSession: { ...AGENT_SESSION, raw: "CANARY-session" },
        revision: 5,
        stateChangeSeq: 9,
        transcriptLines: 42,
        workingForMs: 300_000,
        transcript: ["CANARY-line"],
        note: "CANARY-note",
      },
      summary: "CANARY-summary",
      transcriptDelta: ["CANARY-delta"],
      metadata: { environment: { SECRET: "CANARY-env" } },
      rawResponse: "CANARY-response",
    } as unknown as SupervisionReviewLogEntry;
    await appendSupervisionReview(dirty, { root });
    const content = await readFile(paths.reviews, "utf8");
    expect(content).not.toContain("CANARY");
    const record = JSON.parse(content.trim()) as SupervisionLogRecord;
    expect(record).toMatchObject({ type: "review", jobId: "job_supervisor", signals: SIGNALS });
    expect((record as { evidence: unknown }).evidence).toEqual({
      paneId: "p1",
      terminalId: "t1",
      agentSession: AGENT_SESSION,
      revision: 5,
      stateChangeSeq: 9,
      transcriptLines: 42,
      workingForMs: 300_000,
    });
  });

  it("refuses a canary smuggled as a sixth signal key rather than dropping it silently", async () => {
    const root = await tempdir();
    const dirty = { ...entry(), signals: { ...SIGNALS, CANARY: 0.5 } } as unknown as SupervisionReviewLogEntry;
    await expect(appendSupervisionReview(dirty, { root })).rejects.toMatchObject({ code: "REVIEW_LOG_UNAVAILABLE" });
    await expect(readFile(reviewLogPaths(root).reviews, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("appendSupervisionDisposition", () => {
  it("round-trips a wake's disposition through the same JSONL stream, keyed by event id", async () => {
    const root = await tempdir();
    const paths = reviewLogPaths(root);
    await appendSupervisionReview(entry({ wake: { eventId: "sev_1", eventType: "reviewer_attention", atMs: 1_001 } }), { root });
    await appendSupervisionDisposition(dispositionEntry(), { root, now: () => new Date("2026-09-18T10:05:00.000Z") });
    const records = await readRecords(paths.reviews);
    expect(records).toHaveLength(3);
    expect(records.map((item) => item.type)).toEqual(["review", "wake", "disposition"]);
    const disposition = records[2]!;
    expect(Object.keys(disposition)).toEqual(["type", "timestamp", "atMs", "jobId", "eventId", "disposition"]);
    expect(disposition).toMatchObject({
      type: "disposition",
      timestamp: "2026-09-18T10:05:00.000Z",
      atMs: 2_000,
      jobId: "job_supervisor",
      eventId: "sev_1",
      disposition: "acted",
    });
    // The disposition joins its wake by event id; the wake's own record stays the
    // honestly-unknown observation it was written as.
    const wake = records[1]! as { eventId: string; disposition: string };
    expect(wake.eventId).toBe("sev_1");
    expect(wake.disposition).toBe("unknown");
    expect((records[2] as { eventId: string }).eventId).toBe(wake.eventId);
  });

  it("accepts every disposition value and defaults atMs to the append clock", async () => {
    const root = await tempdir();
    const paths = reviewLogPaths(root);
    for (const disposition of ["acknowledged", "acted", "overruled", "unknown"] as const) {
      await appendSupervisionDisposition(dispositionEntry({ disposition, atMs: undefined }), { root, now: () => new Date("2026-09-18T10:05:00.000Z") });
    }
    const records = await readRecords(paths.reviews);
    expect(records.map((item) => (item as { disposition: string }).disposition)).toEqual(["acknowledged", "acted", "overruled", "unknown"]);
    const clockMs = new Date("2026-09-18T10:05:00.000Z").getTime();
    expect(records.map((item) => (item as { atMs: number }).atMs)).toEqual([clockMs, clockMs, clockMs, clockMs]);
  });

  it("refuses untrusted disposition entries without persisting a line", async () => {
    const cases: Array<{ name: string; mutate: (input: SupervisionDispositionLogEntry) => unknown }> = [
      { name: "a null entry", mutate: () => null },
      { name: "an empty job id", mutate: (input) => ({ ...input, jobId: "" }) },
      { name: "a multi-line job id", mutate: (input) => ({ ...input, jobId: "job\nforged" }) },
      { name: "an empty event id", mutate: (input) => ({ ...input, eventId: "" }) },
      { name: "a multi-line event id", mutate: (input) => ({ ...input, eventId: "sev\nforged" }) },
      { name: "a foreign disposition", mutate: (input) => ({ ...input, disposition: "ignored" }) },
      { name: "a non-string disposition", mutate: (input) => ({ ...input, disposition: 7 }) },
      { name: "a negative atMs", mutate: (input) => ({ ...input, atMs: -1 }) },
      { name: "a nonfinite atMs", mutate: (input) => ({ ...input, atMs: Number.NaN }) },
    ];
    for (const { mutate } of cases) {
      const root = await tempdir();
      const paths = reviewLogPaths(root);
      await expect(appendSupervisionDisposition(mutate(dispositionEntry()) as SupervisionDispositionLogEntry, { root })).rejects.toMatchObject({ code: "REVIEW_LOG_UNAVAILABLE" });
      await expect(readFile(paths.reviews, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("refuses a relative root and wraps clock failures", async () => {
    await expect(appendSupervisionDisposition(dispositionEntry(), { root: "relative/path" })).rejects.toMatchObject({ code: "REVIEW_LOG_UNAVAILABLE" });
    const root = await tempdir();
    await expect(appendSupervisionDisposition(dispositionEntry(), { root, now: () => new Date("garbage") })).rejects.toMatchObject({ code: "REVIEW_LOG_UNAVAILABLE" });
  });

  it("honours the same unsafe-target refusal as review appends", async () => {
    const root = await tempdir();
    const paths = await seedLogDir(root);
    const elsewhere = join(root, "elsewhere.jsonl");
    await writeFile(elsewhere, "", { mode: 0o600 });
    await symlink(elsewhere, paths.reviews);
    await expect(appendSupervisionDisposition(dispositionEntry(), { root })).rejects.toMatchObject({ code: "REVIEW_LOG_UNAVAILABLE" });
    expect(await readFile(elsewhere, "utf8")).toBe("");
  });
});

describe("defaultReviewLogRoot", () => {
  it("anchors on HERDR_PROJECT_DIR when set and the launch directory otherwise", () => {
    expect(defaultReviewLogRoot({ HERDR_PROJECT_DIR: "/trusted/root" })).toBe("/trusted/root");
    expect(defaultReviewLogRoot({})).toBe(process.cwd());
  });
});
