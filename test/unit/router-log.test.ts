import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireFlockHolder } from "../../src/pane-write-lock.js";
import type * as PaneWriteLock from "../../src/pane-write-lock.js";
import {
  appendRouterDecision,
  routerLogPaths,
  routerStateDigest,
  type RouterLogEntry,
  type RouterLogPaths,
  type RouterLogRecord,
} from "../../src/router-log.js";
import type { RouterState } from "../../src/router.js";
import type { RouterProbabilities } from "../../src/typesafe-router.js";

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
  const target = (path: unknown) => String(path).endsWith("decisions.jsonl");
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
  const dir = await mkdtemp(join(tmpdir(), "herdr-router-log-"));
  dirs.push(dir);
  return dir;
}

/** Pre-create the log directories owner-only, as `ensureLogDirectory` does on first append. */
async function seedLogDir(root: string): Promise<RouterLogPaths> {
  const paths = routerLogPaths(root);
  await mkdir(paths.directory, { recursive: true });
  await chmod(join(root, ".herdr"), 0o700);
  await chmod(paths.directory, 0o700);
  return paths;
}

const CATALOG = [
  { name: "scout-pi", description: "Scouts.", runner: "pi", model: "pi-model", timeout: 30 },
  { name: "worker-claude", description: "Works claude.", runner: "claude", model: "claude-model", timeout: 45 },
  { name: "worker-pi", description: "Works pi.", runner: "pi", model: "pi-model", timeout: 30 },
];

const SCORE_DISTRIBUTION = { "0": 0.02, "1": 0.03, "2": 0.9, "3": 0.03, "4": 0.02 };

function state(overrides: Record<string, unknown> = {}): RouterState {
  return {
    assignment: { objective: "Reduce latency.", scope: "Only src/server.", verification: "npm test" },
    catalog: CATALOG,
    ...overrides,
  } as RouterState;
}

function probabilities(): RouterProbabilities {
  return {
    worker_useful: { type: "noul", noul: 0.9 },
    worker_count: { type: "score", score: 2, confidence: 0.9, probabilities: { ...SCORE_DISTRIBUTION } },
    worker_profile: { type: "choice", choice: "worker-pi", confidence: 0.9, probabilities: { "worker-claude": 0.1, "worker-pi": 0.9 } },
    scout_useful: { type: "noul", noul: 0.1 },
    scout_count: { type: "score", score: 0, confidence: 0.9, probabilities: { "0": 0.9, "1": 0.05, "2": 0.03, "3": 0.01, "4": 0.01 } },
  };
}

function entry(overrides: Record<string, unknown> = {}): RouterLogEntry {
  return {
    name: "oom-hunt",
    state: state(),
    probabilities: probabilities(),
    result: { kind: "route", assignments: [{ profile: "worker-pi", count: 3, purpose: "Perform the worker role for the supplied objective." }] },
    ...overrides,
  } as RouterLogEntry;
}

/** The exact allowlisted bytes the router's wire body would send for this state. */
function sentStateJson(source: RouterState): string {
  return JSON.stringify({
    assignment: { objective: source.assignment.objective, scope: source.assignment.scope, verification: source.assignment.verification },
    catalog: source.catalog.map(({ name, description, runner, model, timeout }) => ({ name, description, runner, model, timeout })),
  });
}

function expectedDigest(source: RouterState): string {
  return createHash("sha256").update(sentStateJson(source)).digest("hex");
}

async function readRecords(path: string): Promise<RouterLogRecord[]> {
  const content = await readFile(path, "utf8");
  return content.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as RouterLogRecord);
}

const eacces = () => Object.assign(new Error("EACCES"), { code: "EACCES" });
const eio = () => Object.assign(new Error("EIO"), { code: "EIO" });

describe("routerStateDigest", () => {
  it("is the deterministic SHA-256 of the exact sent RouterState JSON", () => {
    const source = state();
    expect(routerStateDigest(source)).toBe(expectedDigest(source));
    expect(routerStateDigest(source)).toBe(routerStateDigest(state()));
    expect(routerStateDigest(source)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the sent state changes", () => {
    const changedObjective = state();
    changedObjective.assignment.objective = "Different objective.";
    expect(routerStateDigest(changedObjective)).not.toBe(routerStateDigest(state()));
    const changedCatalog = state({ catalog: CATALOG.map((item) => ({ ...item, timeout: item.timeout + 1 })) });
    expect(routerStateDigest(changedCatalog)).not.toBe(routerStateDigest(state()));
  });

  it("covers only the allowlisted wire projection, never stray input fields", () => {
    const dirty = {
      assignment: { objective: "Reduce latency.", scope: "Only src/server.", verification: "npm test", extra: "junk" },
      catalog: CATALOG.map((item) => ({ ...item, body: "secret body", tools: ["exec"] })),
      leaked: "field",
    } as unknown as RouterState;
    expect(routerStateDigest(dirty)).toBe(routerStateDigest(state()));
  });
});

describe("appendRouterDecision records", () => {
  it("persists one fixed-schema line per decision with digest, probabilities, assignments, final newline, and 0600", async () => {
    const root = await tempdir();
    const paths = routerLogPaths(root);
    await appendRouterDecision(entry(), { root, now: () => new Date("2026-09-18T10:00:00.000Z"), deadlineMs: 10_000 });
    const content = await readFile(paths.decisions, "utf8");
    expect(content.endsWith("\n")).toBe(true);
    const records = await readRecords(paths.decisions);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(Object.keys(record)).toEqual(["timestamp", "name", "stateDigest", "stateUnavailable", "probabilities", "result"]);
    expect(record.timestamp).toBe("2026-09-18T10:00:00.000Z");
    expect(record.name).toBe("oom-hunt");
    expect(record.stateDigest).toBe(expectedDigest(state()));
    expect(record.stateUnavailable).toBeNull();
    expect(Object.keys(record.probabilities)).toEqual(["scout_count", "scout_useful", "worker_count", "worker_profile", "worker_useful"]);
    expect(record.probabilities["worker_useful"]).toEqual({ type: "noul", noul: 0.9 });
    expect(record.probabilities["worker_count"]).toEqual({ type: "score", score: 2, confidence: 0.9, probabilities: SCORE_DISTRIBUTION });
    expect(record.probabilities["worker_profile"]).toEqual({ type: "choice", choice: "worker-pi", confidence: 0.9, probabilities: { "worker-claude": 0.1, "worker-pi": 0.9 } });
    expect(record.result).toEqual({ kind: "route", assignments: [{ profile: "worker-pi", count: 3, purpose: "Perform the worker role for the supplied objective." }] });
    // The deterministic purpose is retained while the raw objective is not persisted.
    expect(content).toContain("Perform the worker role for the supplied objective.");
    expect(content).not.toContain("Reduce latency.");
    expect((await lstat(paths.decisions)).mode & 0o777).toBe(0o600);
  });

  it("persists an Abstain outcome with validated probabilities", async () => {
    const root = await tempdir();
    await appendRouterDecision(
      entry({ result: { kind: "abstain", reason: "low_confidence", component: "worker_useful" }, probabilities: { worker_useful: { type: "noul", noul: 0.5 } } }),
      { root }
    );
    const records = await readRecords(routerLogPaths(root).decisions);
    expect(records[0]!.result).toEqual({ kind: "abstain", reason: "low_confidence", component: "worker_useful" });
    expect(records[0]!.probabilities).toEqual({ worker_useful: { type: "noul", noul: 0.5 } });
    expect(records[0]!.stateDigest).toBe(expectedDigest(state()));
  });

  it("persists a transport failure with absent probabilities", async () => {
    const root = await tempdir();
    await appendRouterDecision(entry({ result: { kind: "abstain", reason: "transport_failed", component: "http_503" }, probabilities: {} }), { root });
    const records = await readRecords(routerLogPaths(root).decisions);
    expect(records[0]!.result).toEqual({ kind: "abstain", reason: "transport_failed", component: "http_503" });
    expect(records[0]!.probabilities).toEqual({});
    expect(records[0]!.stateDigest).toBe(expectedDigest(state()));
  });

  it("persists an explicit unavailable-state marker instead of a digest of unsent state", async () => {
    const root = await tempdir();
    await appendRouterDecision(
      entry({
        state: { status: "unavailable", reason: "catalog_unavailable" },
        result: { kind: "abstain", reason: "catalog_unavailable", component: "catalog" },
        probabilities: {},
      }),
      { root }
    );
    const records = await readRecords(routerLogPaths(root).decisions);
    expect(records[0]!.stateDigest).toBeNull();
    expect(records[0]!.stateUnavailable).toEqual({ reason: "catalog_unavailable" });
    expect(records[0]!.result).toEqual({ kind: "abstain", reason: "catalog_unavailable", component: "catalog" });
  });

  it("treats a state that happens to carry marker-like extra fields as sent state", async () => {
    const root = await tempdir();
    const markerish = { ...state(), status: "unavailable", reason: "catalog_unavailable" } as unknown as RouterState;
    await appendRouterDecision(entry({ state: markerish }), { root });
    const records = await readRecords(routerLogPaths(root).decisions);
    expect(records[0]!.stateDigest).toBe(expectedDigest(state()));
    expect(records[0]!.stateUnavailable).toBeNull();
  });

  it("preserves the first line across two appends", async () => {
    const root = await tempdir();
    const paths = routerLogPaths(root);
    await appendRouterDecision(entry({ name: "hunt-a" }), { root });
    await appendRouterDecision(entry({ name: "hunt-b", result: { kind: "abstain", reason: "no_assignments" } }), { root });
    const content = await readFile(paths.decisions, "utf8");
    const records = await readRecords(paths.decisions);
    expect(records).toHaveLength(2);
    expect(records[0]!.name).toBe("hunt-a");
    expect(records[1]!.name).toBe("hunt-b");
    expect(content.split("\n").filter((line) => line.length > 0)).toHaveLength(2);
  });

  it("serializes concurrent cooperating appenders into parseable noninterleaved lines", async () => {
    const root = await tempdir();
    const paths = routerLogPaths(root);
    const names = ["hunt-a", "hunt-b", "hunt-c", "hunt-d", "hunt-e"];
    await Promise.all(names.map((name) => appendRouterDecision(entry({ name }), { root })));
    const content = await readFile(paths.decisions, "utf8");
    const lines = content.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(5);
    const seen: string[] = [];
    for (const line of lines) {
      const record = JSON.parse(line) as RouterLogRecord;
      expect(record.stateDigest).toBe(expectedDigest(state()));
      seen.push(record.name);
    }
    expect(seen.sort()).toEqual(names);
  });

  it("accepts every bounded abstain component token", async () => {
    const root = await tempdir();
    for (const component of ["catalog", "api_key", "response", "transport", "http_503", "worker_count"]) {
      await appendRouterDecision(entry({ result: { kind: "abstain", reason: "invalid_response", component } }), { root });
    }
    const records = await readRecords(routerLogPaths(root).decisions);
    expect(records.map((record) => (record.result as { component?: string }).component)).toEqual([
      "catalog", "api_key", "response", "transport", "http_503", "worker_count",
    ]);
  });
});

describe("appendRouterDecision refusal", () => {
  const cases: Array<{ name: string; mutate: (input: RouterLogEntry) => unknown }> = [
    { name: "a null entry", mutate: () => null },
    { name: "an untrusted caller name", mutate: (input) => ({ ...input, name: "Bad Name" }) },
    { name: "an empty caller name", mutate: (input) => ({ ...input, name: "" }) },
    { name: "a malformed unavailable marker", mutate: (input) => ({ ...input, state: { status: "unavailable", reason: "other" } }) },
    { name: "an unavailable marker carrying catalog but no assignment", mutate: (input) => ({ ...input, state: { status: "unavailable", reason: "catalog_unavailable", catalog: CATALOG } }) },
    { name: "a non-record state", mutate: (input) => ({ ...input, state: "junk" }) },
    { name: "a malformed assignment in state", mutate: (input) => ({ ...input, state: { assignment: null, catalog: CATALOG } }) },
    { name: "a non-array catalog in state", mutate: (input) => ({ ...input, state: { assignment: { objective: "x" }, catalog: {} } }) },
    { name: "a non-record catalog entry", mutate: (input) => ({ ...input, state: state({ catalog: ["junk"] }) }) },
    { name: "a catalog entry without a name", mutate: (input) => ({ ...input, state: state({ catalog: [{ description: "x" }] }) }) },
    { name: "a non-record probabilities bag", mutate: (input) => ({ ...input, probabilities: "junk" }) },
    { name: "a foreign question id", mutate: (input) => ({ ...input, probabilities: { ...input.probabilities, intruder_useful: { type: "noul", noul: 0.9 } } }) },
    { name: "probabilities without a sent state", mutate: (input) => ({ ...input, state: { status: "unavailable", reason: "catalog_unavailable" }, probabilities: probabilities() }) },
    { name: "a non-record evidence entry", mutate: (input) => ({ ...input, probabilities: { ...input.probabilities, worker_useful: "junk" } }) },
    { name: "a noul under the wrong question type", mutate: (input) => ({ ...input, probabilities: { ...input.probabilities, worker_count: { type: "noul", noul: 0.9 } } }) },
    { name: "an out-of-range noul", mutate: (input) => ({ ...input, probabilities: { ...input.probabilities, worker_useful: { type: "noul", noul: 1.5 } } }) },
    { name: "a nonfinite score", mutate: (input) => ({ ...input, probabilities: { ...input.probabilities, worker_count: { type: "score", score: Number.NaN, confidence: 0.9, probabilities: SCORE_DISTRIBUTION } } }) },
    { name: "a score above the rubric", mutate: (input) => ({ ...input, probabilities: { ...input.probabilities, worker_count: { type: "score", score: 4.5, confidence: 0.9, probabilities: SCORE_DISTRIBUTION } } }) },
    { name: "a negative score", mutate: (input) => ({ ...input, probabilities: { ...input.probabilities, worker_count: { type: "score", score: -1, confidence: 0.9, probabilities: SCORE_DISTRIBUTION } } }) },
    { name: "an out-of-range score confidence", mutate: (input) => ({ ...input, probabilities: { ...input.probabilities, worker_count: { type: "score", score: 2, confidence: 1.2, probabilities: SCORE_DISTRIBUTION } } }) },
    { name: "non-record score probabilities", mutate: (input) => ({ ...input, probabilities: { ...input.probabilities, worker_count: { type: "score", score: 2, confidence: 0.9, probabilities: "junk" } } }) },
    { name: "score probabilities missing a key", mutate: (input) => ({ ...input, probabilities: { ...input.probabilities, worker_count: { type: "score", score: 2, confidence: 0.9, probabilities: { "0": 0.9, "1": 0.05, "2": 0.03, "3": 0.02 } } } }) },
    { name: "score probabilities with an extra key", mutate: (input) => ({ ...input, probabilities: { ...input.probabilities, worker_count: { type: "score", score: 2, confidence: 0.9, probabilities: { ...SCORE_DISTRIBUTION, "5": 0 } } } }) },
    { name: "score probabilities with a wrong key", mutate: (input) => ({ ...input, probabilities: { ...input.probabilities, worker_count: { type: "score", score: 2, confidence: 0.9, probabilities: { "0": 0.9, "1": 0.05, "2": 0.03, "3": 0.02, x: 0 } } } }) },
    { name: "a non-numeric score probability value", mutate: (input) => ({ ...input, probabilities: { ...input.probabilities, worker_count: { type: "score", score: 2, confidence: 0.9, probabilities: { ...SCORE_DISTRIBUTION, "4": "junk" } } } }) },
    { name: "score probabilities not summing to one", mutate: (input) => ({ ...input, probabilities: { ...input.probabilities, worker_count: { type: "score", score: 2, confidence: 0.9, probabilities: { "0": 0.5, "1": 0.5, "2": 0.5, "3": 0.5, "4": 0.5 } } } }) },
    { name: "a choice outside the role candidates", mutate: (input) => ({ ...input, probabilities: { ...input.probabilities, worker_profile: { type: "choice", choice: "worker-foreign", confidence: 0.9, probabilities: { "worker-claude": 0.1, "worker-pi": 0.9 } } } }) },
    { name: "an out-of-range choice confidence", mutate: (input) => ({ ...input, probabilities: { ...input.probabilities, worker_profile: { type: "choice", choice: "worker-pi", confidence: 1.5, probabilities: { "worker-claude": 0.1, "worker-pi": 0.9 } } } }) },
    { name: "choice probabilities with a foreign key", mutate: (input) => ({ ...input, probabilities: { ...input.probabilities, worker_profile: { type: "choice", choice: "worker-pi", confidence: 0.9, probabilities: { "worker-claude": 0.1, "worker-pi": 0.85, intruder: 0.05 } } } }) },
    { name: "a non-record result", mutate: (input) => ({ ...input, result: "junk" }) },
    { name: "an unknown result kind", mutate: (input) => ({ ...input, result: { kind: "weird" } }) },
    { name: "a route without a sent state", mutate: (input) => ({ ...input, state: { status: "unavailable", reason: "catalog_unavailable" }, probabilities: {} }) },
    { name: "a non-array assignment list", mutate: (input) => ({ ...input, result: { kind: "route", assignments: "junk" } }) },
    { name: "an empty route assignment list", mutate: (input) => ({ ...input, result: { kind: "route", assignments: [] } }) },
    { name: "a non-record assignment", mutate: (input) => ({ ...input, result: { kind: "route", assignments: ["junk"] } }) },
    { name: "a non-string assignment profile", mutate: (input) => ({ ...input, result: { kind: "route", assignments: [{ profile: 5, count: 1, purpose: "x" }] } }) },
    { name: "an assignment for a foreign profile", mutate: (input) => ({ ...input, result: { kind: "route", assignments: [{ profile: "foreign-pi", count: 1, purpose: "x" }] } }) },
    { name: "a non-integer count", mutate: (input) => ({ ...input, result: { kind: "route", assignments: [{ profile: "worker-pi", count: 2.5, purpose: "Perform the worker role for the supplied objective." }] } }) },
    { name: "a zero count", mutate: (input) => ({ ...input, result: { kind: "route", assignments: [{ profile: "worker-pi", count: 0, purpose: "Perform the worker role for the supplied objective." }] } }) },
    { name: "a count above five", mutate: (input) => ({ ...input, result: { kind: "route", assignments: [{ profile: "worker-pi", count: 6, purpose: "Perform the worker role for the supplied objective." }] } }) },
    { name: "a purpose that is not the deterministic template", mutate: (input) => ({ ...input, result: { kind: "route", assignments: [{ profile: "worker-pi", count: 1, purpose: "Reduce latency. plus injected text" }] } }) },
    { name: "a purpose for the wrong role", mutate: (input) => ({ ...input, result: { kind: "route", assignments: [{ profile: "worker-pi", count: 1, purpose: "Perform the scout role for the supplied objective." }] } }) },
    { name: "an unknown abstain reason", mutate: (input) => ({ ...input, result: { kind: "abstain", reason: "exploded" } }) },
    { name: "a non-string abstain component", mutate: (input) => ({ ...input, result: { kind: "abstain", reason: "aborted", component: 42 } }) },
    { name: "an arbitrary abstain component", mutate: (input) => ({ ...input, result: { kind: "abstain", reason: "transport_failed", component: "server-secret-text" } }) },
    { name: "a malformed http component", mutate: (input) => ({ ...input, result: { kind: "abstain", reason: "transport_failed", component: "http_server_error" } }) },
  ];

  for (const { name, mutate } of cases) {
    it(`refuses ${name} without persisting a line`, async () => {
      const root = await tempdir();
      const paths = routerLogPaths(root);
      await expect(appendRouterDecision(mutate(entry()) as RouterLogEntry, { root })).rejects.toMatchObject({ code: "ROUTER_LOG_UNAVAILABLE" });
      await expect(readFile(paths.decisions, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  }

  it("refuses a relative or empty root", async () => {
    await expect(appendRouterDecision(entry(), { root: "relative/path" })).rejects.toMatchObject({ code: "ROUTER_LOG_UNAVAILABLE" });
    await expect(appendRouterDecision(entry(), { root: "" })).rejects.toMatchObject({ code: "ROUTER_LOG_UNAVAILABLE" });
  });

  it("wraps unexpected clock failures in ROUTER_LOG_UNAVAILABLE", async () => {
    const root = await tempdir();
    await expect(appendRouterDecision(entry(), { root, now: () => new Date("garbage") })).rejects.toMatchObject({ code: "ROUTER_LOG_UNAVAILABLE" });
  });
});

describe("appendRouterDecision target safety", () => {
  it("refuses a symlinked decision log without touching the target", async () => {
    const root = await tempdir();
    const paths = await seedLogDir(root);
    const elsewhere = join(root, "elsewhere.jsonl");
    await writeFile(elsewhere, "", { mode: 0o600 });
    await symlink(elsewhere, paths.decisions);
    await expect(appendRouterDecision(entry(), { root })).rejects.toMatchObject({ code: "ROUTER_LOG_UNAVAILABLE" });
    expect(await readFile(elsewhere, "utf8")).toBe("");
  });

  it("refuses a directory or world-writable file at the decision path", async () => {
    const root = await tempdir();
    const paths = await seedLogDir(root);
    await mkdir(paths.decisions);
    await expect(appendRouterDecision(entry(), { root })).rejects.toMatchObject({ code: "ROUTER_LOG_UNAVAILABLE" });
    await rm(paths.decisions, { recursive: true });
    await writeFile(paths.decisions, "", { mode: 0o600 });
    await chmod(paths.decisions, 0o666);
    await expect(appendRouterDecision(entry(), { root })).rejects.toMatchObject({ code: "ROUTER_LOG_UNAVAILABLE" });
    expect(await readFile(paths.decisions, "utf8")).toBe("");
  });

  it("refuses a symlinked, world-writable, or non-directory .herdr", async () => {
    for (const kind of ["symlink", "writable", "file"] as const) {
      const root = await tempdir();
      const dotHerdr = join(root, ".herdr");
      if (kind === "symlink") await symlink(join(root, "elsewhere"), dotHerdr);
      else if (kind === "writable") await mkdir(dotHerdr, { mode: 0o777 });
      else await writeFile(dotHerdr, "", { mode: 0o600 });
      await expect(appendRouterDecision(entry(), { root })).rejects.toMatchObject({ code: "ROUTER_LOG_UNAVAILABLE" });
    }
  });

  it("surfaces indeterminate lstat, open failure, and an untrusted opened file", async () => {
    const root = await tempdir();
    const paths = routerLogPaths(root);
    fsControl.failLstat = (path) => (path === join(root, ".herdr") ? eacces() : undefined);
    await expect(appendRouterDecision(entry(), { root })).rejects.toMatchObject({ code: "ROUTER_LOG_UNAVAILABLE" });
    fsControl.failLstat = (path) => (path === paths.decisions ? eacces() : undefined);
    await expect(appendRouterDecision(entry(), { root })).rejects.toMatchObject({ code: "ROUTER_LOG_UNAVAILABLE" });
    fsControl.failLstat = undefined;

    fsControl.failOpen = () => eacces();
    await expect(appendRouterDecision(entry(), { root })).rejects.toMatchObject({ code: "ROUTER_LOG_UNAVAILABLE" });
    fsControl.failOpen = undefined;

    fsControl.statMode = 0o644;
    await expect(appendRouterDecision(entry(), { root })).rejects.toMatchObject({ code: "ROUTER_LOG_UNAVAILABLE" });
    expect(await readFile(paths.decisions, "utf8")).toBe("");
  });

  it("surfaces a directory creation failure", async () => {
    const file = join(await tempdir(), "not-a-dir");
    await writeFile(file, "", { mode: 0o600 });
    await expect(appendRouterDecision(entry(), { root: file })).rejects.toMatchObject({ code: "ROUTER_LOG_UNAVAILABLE" });
  });

  it("releases the lock and closes the handle when the write fails", async () => {
    const root = await tempdir();
    const paths = routerLogPaths(root);
    let closes = 0;
    fsControl.onClose = () => { closes += 1; };
    fsControl.failAppend = () => eio();
    await expect(appendRouterDecision(entry(), { root })).rejects.toMatchObject({ code: "ROUTER_LOG_UNAVAILABLE" });
    expect(closes).toBe(1);
    expect(await readFile(paths.decisions, "utf8")).toBe("");
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
    await appendRouterDecision(entry(), { root });
    const records = await readRecords(paths.decisions);
    expect(records).toHaveLength(1);
    expect(records[0]!.name).toBe("oom-hunt");
  });

  it("fails the append when another process holds the lock, without writing", async () => {
    const root = await tempdir();
    const paths = routerLogPaths(root);
    await appendRouterDecision(entry({ name: "hunt-a" }), { root });
    const holder = spawn("flock", ["--exclusive", "--nonblock", paths.lock, "--command", "printf HERDR_HELD_READY; cat"], { stdio: ["pipe", "pipe", "pipe"] });
    try {
      const ready = new Promise<void>((resolve, reject) => {
        holder.stdout.setEncoding("utf8");
        holder.stdout.on("data", (chunk: string) => { if (chunk.includes("HERDR_HELD_READY")) resolve(); });
        holder.once("error", reject);
      });
      await ready;
      await expect(appendRouterDecision(entry({ name: "hunt-b" }), { root, waitMs: 50 })).rejects.toMatchObject({ code: "ROUTER_LOG_UNAVAILABLE" });
    } finally {
      holder.stdin.end();
      await once(holder, "exit");
    }
    // The refused append never wrote; the first record is intact.
    const records = await readRecords(paths.decisions);
    expect(records).toHaveLength(1);
    expect(records[0]!.name).toBe("hunt-a");
  });

  it("settles a failed close after the line is appended", async () => {
    const root = await tempdir();
    fsControl.failClose = () => eio();
    await appendRouterDecision(entry(), { root });
    const records = await readRecords(routerLogPaths(root).decisions);
    expect(records).toHaveLength(1);
    expect(records[0]!.name).toBe("oom-hunt");
  });

  it("settles a failed release after the line is appended", async () => {
    const root = await tempdir();
    lockControl.acquire = async () => ({
      check: async () => {},
      release: async () => { throw new Error("wedged holder"); },
    });
    await appendRouterDecision(entry(), { root });
    const records = await readRecords(routerLogPaths(root).decisions);
    expect(records).toHaveLength(1);
    expect(records[0]!.name).toBe("oom-hunt");
  });

  it("surfaces a failed acquisition as ROUTER_LOG_UNAVAILABLE without writing", async () => {
    const root = await tempdir();
    lockControl.acquire = async () => { throw new Error("no flock binary"); };
    await expect(appendRouterDecision(entry(), { root })).rejects.toMatchObject({ code: "ROUTER_LOG_UNAVAILABLE" });
    const paths = routerLogPaths(root);
    await expect(readFile(paths.decisions, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("appendRouterDecision redaction", () => {
  it("never persists canary strings planted in raw text, environment-shaped, or extra response fields", async () => {
    const root = await tempdir();
    const paths = routerLogPaths(root);
    const dirty = {
      assignment: {
        objective: "CANARY-objective",
        scope: "CANARY-scope",
        verification: "CANARY-verification",
        extra: "CANARY-extra",
      },
      catalog: CATALOG.map((item) => ({
        ...item,
        description: "CANARY-description",
        body: "CANARY-body",
        tools: ["CANARY-tool"],
        environment: { SECRET: "CANARY-env" },
        source: { path: "/CANARY-path" },
      })),
      request: "CANARY-request",
    } as unknown as RouterState;
    const dirtyProbabilities = {
      worker_useful: { type: "noul", noul: 0.9, environment: { KEY: "CANARY-env" }, note: "CANARY-note", raw: { answers: "CANARY-answers" } },
      worker_count: { type: "score", score: 2, confidence: 0.9, probabilities: SCORE_DISTRIBUTION, legend: "CANARY-legend" },
      worker_profile: { type: "choice", choice: "worker-pi", confidence: 0.9, probabilities: { "worker-claude": 0.1, "worker-pi": 0.9 }, response: "CANARY-response" },
      scout_useful: { type: "noul", noul: 0.1 },
      scout_count: { type: "score", score: 0, confidence: 0.9, probabilities: { "0": 0.9, "1": 0.05, "2": 0.03, "3": 0.01, "4": 0.01 } },
    } as unknown as RouterProbabilities;
    const dirtyEntry = {
      name: "oom-hunt",
      state: dirty,
      probabilities: dirtyProbabilities,
      result: {
        kind: "route",
        assignments: [{ profile: "worker-pi", count: 3, purpose: "Perform the worker role for the supplied objective.", leak: "CANARY-leak" }],
        apiError: "CANARY-api-error",
        rawAnswers: { tree: "CANARY-tree" },
      },
      rawResponse: "CANARY-raw-response",
    } as unknown as RouterLogEntry;
    await appendRouterDecision(dirtyEntry, { root });
    const content = await readFile(paths.decisions, "utf8");
    expect(content).not.toContain("CANARY");
    const record = JSON.parse(content.trim()) as RouterLogRecord;
    // Only the digest of the sent state, validated numerics, and allowlisted fields persist.
    expect(record.stateDigest).toBe(expectedDigest(dirty));
    expect(record.probabilities["worker_useful"]).toEqual({ type: "noul", noul: 0.9 });
    expect(record.probabilities["worker_count"]).toEqual({ type: "score", score: 2, confidence: 0.9, probabilities: SCORE_DISTRIBUTION });
    expect(record.result).toEqual({ kind: "route", assignments: [{ profile: "worker-pi", count: 3, purpose: "Perform the worker role for the supplied objective." }] });
  });
});
