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
import type { CompiledContract } from "../../src/compile.js";
import {
  appendRouterDecision,
  routerLogPaths,
  routerStateDigest,
  type RouterLogPaths,
  type RouterLogRecord,
  type SpecRouterLogEntry,
} from "../../src/router-log.js";
import { POLICY_REVISION } from "../../src/routing-policy.js";
import type { Abstained, Admitted, RouterBinding, RouterEvidence, TaskRouterState } from "../../src/router.js";

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

const POINTS = [
  { id: "pi:pi-model:low", runner: "pi", model: "pi-model", reasoning: "low", provider: "pi-provider", timeout: 30 },
  { id: "claude:claude-model:high", runner: "claude", model: "claude-model", reasoning: "high", provider: "claude-provider", timeout: 45 },
  { id: "agy:agy-model", runner: "agy", model: "agy-model", provider: "agy-provider", timeout: 30 },
] as const;

const BINDING: RouterBinding = {
  caller: "oom-hunt",
  specRevision: "spec-1",
  policyRevision: POLICY_REVISION,
  launchIdentity: "launch-1",
};

function state(overrides: Record<string, unknown> = {}): TaskRouterState {
  return {
    task: { objective: "Reduce latency.", scope: "Only src/server.", doneWhen: ["npm test passes"], constraints: ["no wire changes"] },
    points: [...POINTS],
    ...overrides,
  } as TaskRouterState;
}

function configuration(): CompiledContract {
  return {
    specLabel: "worker",
    candidate: { index: 0, id: "pi:pi-model:low", runner: "pi", model: "pi-model", reasoning: "low" },
    quota: { provider: "test-provider", billingProduct: "test-product", account: "test-account", scope: "project" },
    scopeRoot: "/scope",
    sessionPersistence: false,
    timeoutMinutes: 30,
    plumbing: { sessionPersistence: "optional", promptDelivery: "file", skillSelection: "exact", toolSelection: "allowlist" },
    runtime: { kind: "pi", model: "pi-model", thinking: "low", tools: ["read"], extensions: [], skills: [] },
    resources: {
      tools: { installed: ["read"], selected: ["read"], exposed: ["read"], permitted: ["read"], denied: [] },
    },
    derivations: [],
    gaps: [],
  };
}

function evidence(): RouterEvidence {
  return {
    quality: { outcome: "not_rejected", done_when_verifiable: 0.9 },
    policyRevision: POLICY_REVISION,
    intent: { value: "implement", confidence: 0.9 },
    modifiers: { mutation_broad: { probability: 0.8, applied: true, confidence: 0.8 } },
    workload: { intent: "implement", mutation: "broad", scope: "local", horizon: "short", verifiability: "strong", workspaceState: "clean", ambiguity: "low" },
    fitness: { "pi:pi-model:low": 0.9, "claude:claude-model:high": 0.8 },
    chainExclusions: [{ id: "agy:agy-model", provider: "agy-provider", reasons: ["attempt_bound"] }],
    selectedPoint: { index: 0, id: "pi:pi-model:low", runner: "pi", model: "pi-model", reasoning: "low" },
    availability: [{ id: "pi:pi-model:low", status: "unknown", retryNotBefore: null }],
  };
}

function specProbabilities(): Record<string, unknown> {
  return {
    quality: { done_when_verifiable: 0.9 },
    intent: { value: "implement", confidence: 0.9, probabilities: { explore: 0.01, reason: 0.01, implement: 0.94, debug: 0.01, verify: 0.01, review: 0.01, coordinate: 0.01 } },
    tier: { value: "standard", confidence: 0.6, probabilities: { utility: 0.02, economy: 0.18, standard: 0.6, strong: 0.15, frontier: 0.04, max: 0.01 } },
    modifiers: { mutation_broad: { probability: 0.8, applied: true, confidence: 0.8 } },
    resources: { pi: { tools: { read: 0.9, executor_execute: 0.5 } } },
    fitness: { "0": { utility: 0.9, economy: 0.9, standard: 0.9, strong: 0.9, frontier: 0.9, max: 0.9 } },
    uncertainDimensions: [],
  };
}

function admitted(overrides: Partial<Admitted> = {}): Admitted {
  return {
    kind: "admitted",
    quality: "not_rejected",
    count: 1,
    requestedTier: "standard",
    workloadFloor: "strong",
    effectiveStartTier: "strong",
    effectiveCeiling: "frontier",
    chain: ["pi:pi-model:low", "claude:claude-model:high"],
    selectedPoint: { index: 0, id: "pi:pi-model:low", runner: "pi", model: "pi-model", reasoning: "low" },
    configuration: configuration(),
    evidence: evidence(),
    ...overrides,
  };
}

function abstained(reason: Abstained["reason"] = "transport_failed", component = "router"): Abstained {
  return { kind: "abstained", reason, component };
}

function entry(overrides: Partial<SpecRouterLogEntry> = {}): SpecRouterLogEntry {
  return {
    caller: "oom-hunt",
    binding: BINDING,
    state: state(),
    result: admitted(),
    ...overrides,
  };
}

/** The exact allowlisted bytes the router's wire body would send for this state. */
function sentStateJson(source: TaskRouterState): string {
  return JSON.stringify({
    task: {
      objective: source.task.objective,
      scope: source.task.scope,
      doneWhen: [...source.task.doneWhen],
      constraints: [...source.task.constraints],
      ...(source.task.tier === undefined ? {} : { tier: source.task.tier }),
    },
    points: source.points.map((point) => ({
      id: point.id,
      runner: point.runner,
      model: point.model,
      ...(point.reasoning === undefined ? {} : { reasoning: point.reasoning }),
      provider: point.provider,
      timeout: point.timeout,
    })),
  });
}

function expectedDigest(source: TaskRouterState): string {
  return createHash("sha256").update(sentStateJson(source)).digest("hex");
}

async function readRecords(path: string): Promise<RouterLogRecord[]> {
  const content = await readFile(path, "utf8");
  return content.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as RouterLogRecord);
}

const eacces = () => Object.assign(new Error("EACCES"), { code: "EACCES" });
const eio = () => Object.assign(new Error("EIO"), { code: "EIO" });

describe("routerStateDigest", () => {
  it("is the deterministic SHA-256 of the exact sent TaskRouterState JSON", () => {
    const source = state();
    expect(routerStateDigest(source)).toBe(expectedDigest(source));
    expect(routerStateDigest(source)).toBe(routerStateDigest(state()));
    expect(routerStateDigest(source)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("digests a task carrying its requested tier", () => {
    const tiered = state();
    tiered.task = { ...tiered.task, tier: "strong" as const };
    expect(routerStateDigest(tiered)).toBe(expectedDigest(tiered));
    expect(routerStateDigest(tiered)).not.toBe(routerStateDigest(state()));
  });

  it("changes when the sent state changes", () => {
    const changedObjective = state();
    changedObjective.task = { ...changedObjective.task, objective: "Different objective." };
    expect(routerStateDigest(changedObjective)).not.toBe(routerStateDigest(state()));
    const changedPoints = state({ points: POINTS.map((item) => ({ ...item, timeout: item.timeout + 1 })) });
    expect(routerStateDigest(changedPoints)).not.toBe(routerStateDigest(state()));
  });

  it("covers only the allowlisted wire projection, never stray input fields", () => {
    const dirty = {
      task: { objective: "Reduce latency.", scope: "Only src/server.", doneWhen: ["npm test passes"], constraints: ["no wire changes"], extra: "junk" },
      points: POINTS.map((item) => ({ ...item, body: "secret body", tools: ["exec"] })),
      leaked: "field",
    } as unknown as TaskRouterState;
    expect(routerStateDigest(dirty)).toBe(routerStateDigest(state()));
  });
});

describe("appendRouterDecision records", () => {
  it("persists the fixed per-spec record shape with digest, binding, evidence, and final newline", async () => {
    const root = await tempdir();
    const paths = routerLogPaths(root);
    await appendRouterDecision(entry({ probabilities: specProbabilities() }), { root, now: () => new Date("2026-09-18T10:00:00.000Z"), deadlineMs: 10_000 });
    const content = await readFile(paths.decisions, "utf8");
    expect(content.endsWith("\n")).toBe(true);
    const records = await readRecords(paths.decisions);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(Object.keys(record)).toEqual(["timestamp", "name", "caller", "binding", "catalogRevision", "recoveryOf", "priorOperatingPointId", "stateDigest", "stateUnavailable", "probabilities", "result", "evidence"]);
    expect(record.timestamp).toBe("2026-09-18T10:00:00.000Z");
    expect(record.name).toBe("oom-hunt");
    expect(record.caller).toBe("oom-hunt");
    expect(record.binding).toEqual(BINDING);
    expect(record.stateDigest).toBe(expectedDigest(state()));
    expect(record.stateUnavailable).toBeNull();
    expect(record.probabilities).toEqual(specProbabilities());
    // A fresh route carries no catalog or recovery lineage.
    expect(record.catalogRevision).toBeNull();
    expect(record.recoveryOf).toBeNull();
    expect(record.priorOperatingPointId).toBeNull();
    expect(record.result).toMatchObject({
      kind: "admitted",
      quality: "not_rejected",
      count: 1,
      requestedTier: "standard",
      workloadFloor: "strong",
      effectiveStartTier: "strong",
      effectiveCeiling: "frontier",
      chain: ["pi:pi-model:low", "claude:claude-model:high"],
      selectedPoint: { index: 0, id: "pi:pi-model:low", runner: "pi", model: "pi-model", reasoning: "low" },
    });
    expect(record.evidence).toEqual(evidence());
    expect((await lstat(paths.decisions)).mode & 0o777).toBe(0o600);
  });

  it("persists every abstention reason in the new result shape", async () => {
    const root = await tempdir();
    const reasons: readonly Abstained["reason"][] = [
      "low_confidence",
      "no_candidates_at_tier",
      "catalog_unavailable",
      "invalid_response",
      "authentication_unavailable",
      "transport_failed",
      "aborted",
    ];
    for (const reason of reasons) await appendRouterDecision(entry({ caller: `hunt-${reason}`, result: abstained(reason) }), { root });
    const records = await readRecords(routerLogPaths(root).decisions);
    expect(records.map((record) => (record.result as { reason: string }).reason)).toEqual(reasons);
    expect(records.every((record) => record.result.kind === "abstained")).toBe(true);
  });

  it("persists a bounded requestSize diagnostic on transport abstentions and refuses malformed sizes", async () => {
    const root = await tempdir();
    const paths = routerLogPaths(root);
    const ok = await appendRouterDecision(entry({ result: { ...abstained("transport_failed"), requestSize: { questions: 445, bytes: 240254 } } }), { root, now: () => new Date("2026-09-22T10:00:00.000Z"), deadlineMs: 10_000 });
    expect(ok).toBeUndefined();
    const [record] = await readRecords(paths.decisions);
    expect(record.result).toMatchObject({ requestSize: { questions: 445, bytes: 240254 } });

    const bad = await tempdir();
    const badPaths = routerLogPaths(bad);
    await expect(
      appendRouterDecision(entry({ result: { ...abstained("transport_failed"), requestSize: { questions: -1, bytes: 240254 } } }), { root: bad, deadlineMs: 10_000 }),
    ).rejects.toMatchObject({ code: "ROUTER_LOG_UNAVAILABLE" });
    await expect(readFile(badPaths.decisions, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists rejected quality as rejected and discards the legacy probabilities bag", async () => {
    const root = await tempdir();
    await appendRouterDecision(
      entry({
        probabilities: { raw: "must not be logged" },
        result: {
          kind: "rejected",
          quality: "rejected",
          reason: "done_when_unverifiable",
          evidence: { quality: { outcome: "rejected", done_when_verifiable: 0.1 } },
        },
      }),
      { root },
    );
    const record = (await readRecords(routerLogPaths(root).decisions))[0]!;
    expect(record.probabilities).toEqual({});
    expect(record.result).toEqual({
      kind: "rejected",
      quality: "rejected",
      reason: "done_when_unverifiable",
      evidence: { quality: { outcome: "rejected", done_when_verifiable: 0.1 } },
    });
  });

  it("tolerates a pre-existing shared (group-writable) .herdr parent when the router leaf is owner-only", async () => {
    const root = await tempdir();
    const paths = routerLogPaths(root);
    await mkdir(join(root, ".herdr"), { mode: 0o775 });
    await chmod(join(root, ".herdr"), 0o775);
    await appendRouterDecision(entry({ probabilities: specProbabilities() }), { root, now: () => new Date("2026-09-18T10:00:00.000Z"), deadlineMs: 10_000 });
    expect((await lstat(paths.directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(paths.decisions)).mode & 0o777).toBe(0o600);
    expect(await readRecords(paths.decisions)).toHaveLength(1);
  });

  it("still refuses a group-writable router leaf", async () => {
    const root = await tempdir();
    const paths = routerLogPaths(root);
    await mkdir(paths.directory, { recursive: true, mode: 0o700 });
    await chmod(paths.directory, 0o775);
    await expect(appendRouterDecision(entry({ probabilities: specProbabilities() }), { root, deadlineMs: 10_000 })).rejects.toMatchObject({ code: "ROUTER_LOG_UNAVAILABLE" });
    await expect(readFile(paths.decisions, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists the catalog revision and recovery lineage on a recovery route", async () => {
    const root = await tempdir();
    await appendRouterDecision(
      entry({ catalogRevision: "a".repeat(64), recoveryOf: "run-7", priorOperatingPointId: "pi:old:low" }),
      { root },
    );
    const record = (await readRecords(routerLogPaths(root).decisions))[0]!;
    expect(record.catalogRevision).toBe("a".repeat(64));
    expect(record.recoveryOf).toBe("run-7");
    expect(record.priorOperatingPointId).toBe("pi:old:low");
  });

  it("persists an explicit unavailable-state marker instead of a digest of unsent state", async () => {
    const root = await tempdir();
    await appendRouterDecision(
      entry({
        state: { status: "unavailable", reason: "catalog_unavailable" },
        result: abstained("catalog_unavailable", "catalog"),
      }),
      { root },
    );
    const record = (await readRecords(routerLogPaths(root).decisions))[0]!;
    expect(record.stateDigest).toBeNull();
    expect(record.stateUnavailable).toEqual({ reason: "catalog_unavailable" });
    expect(record.result).toEqual({ kind: "abstained", reason: "catalog_unavailable", component: "catalog" });
  });

  it("treats a state that happens to carry marker-like extra fields as sent state", async () => {
    const root = await tempdir();
    const markerish = { ...state(), status: "unavailable", reason: "catalog_unavailable" } as unknown as TaskRouterState;
    await appendRouterDecision(entry({ state: markerish }), { root });
    const record = (await readRecords(routerLogPaths(root).decisions))[0]!;
    expect(record.stateDigest).toBe(expectedDigest(state()));
    expect(record.stateUnavailable).toBeNull();
  });

  it("preserves the first line across two appends", async () => {
    const root = await tempdir();
    const paths = routerLogPaths(root);
    await appendRouterDecision(entry({ caller: "hunt-a" }), { root });
    await appendRouterDecision(entry({ caller: "hunt-b", result: abstained("no_candidates_at_tier") }), { root });
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
    const callers = ["hunt-a", "hunt-b", "hunt-c", "hunt-d", "hunt-e"];
    await Promise.all(callers.map((caller) => appendRouterDecision(entry({ caller }), { root })));
    const content = await readFile(paths.decisions, "utf8");
    const lines = content.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(5);
    const seen: string[] = [];
    for (const line of lines) {
      const record = JSON.parse(line) as RouterLogRecord;
      expect(record.stateDigest).toBe(expectedDigest(state()));
      seen.push(record.name);
    }
    expect(seen.sort()).toEqual(callers);
  });
});

describe("appendRouterDecision refusal", () => {
  const cases: Array<{ name: string; mutate: (input: SpecRouterLogEntry) => unknown }> = [
    { name: "a null entry", mutate: () => null },
    { name: "an empty caller", mutate: (input) => ({ ...input, caller: "" }) },
    { name: "a caller containing a newline", mutate: (input) => ({ ...input, caller: "bad\ncaller" }) },
    { name: "an invalid binding", mutate: (input) => ({ ...input, binding: { ...BINDING, policyRevision: "" } }) },
    { name: "an unbounded catalog revision", mutate: (input) => ({ ...input, catalogRevision: "" }) },
    { name: "a catalog revision carrying a newline", mutate: (input) => ({ ...input, catalogRevision: "rev\n" }) },
    { name: "recoveryOf without priorOperatingPointId", mutate: (input) => ({ ...input, recoveryOf: "run-1" }) },
    { name: "priorOperatingPointId without recoveryOf", mutate: (input) => ({ ...input, priorOperatingPointId: "pi:x" }) },
    { name: "an unbounded recoveryOf", mutate: (input) => ({ ...input, recoveryOf: "", priorOperatingPointId: "pi:x" }) },
    { name: "an unbounded priorOperatingPointId", mutate: (input) => ({ ...input, recoveryOf: "run-1", priorOperatingPointId: "" }) },
    { name: "a malformed unavailable marker", mutate: (input) => ({ ...input, state: { status: "unavailable", reason: "other" } }) },
    { name: "an unavailable marker carrying task", mutate: (input) => ({ ...input, state: { status: "unavailable", reason: "catalog_unavailable", task: state().task } }) },
    { name: "a non-record state", mutate: (input) => ({ ...input, state: "junk" }) },
    { name: "a malformed task in state", mutate: (input) => ({ ...input, state: { task: null, points: [...POINTS] } }) },
    { name: "a non-array points in state", mutate: (input) => ({ ...input, state: { task: state().task, points: {} } }) },
    { name: "a non-record point entry", mutate: (input) => ({ ...input, state: state({ points: ["junk"] }) }) },
    { name: "a point entry without an id", mutate: (input) => ({ ...input, state: state({ points: [{ runner: "pi" }] }) }) },
    { name: "a non-record result", mutate: (input) => ({ ...input, result: "junk" }) },
    { name: "an unknown result kind", mutate: (input) => ({ ...input, result: { kind: "weird" } }) },
    { name: "an admitted result without configuration", mutate: (input) => ({ ...input, result: { kind: "admitted", quality: "not_rejected", count: 1, chain: ["pi:pi-model:low"], selectedPoint: admitted().selectedPoint, evidence: {} } }) },
    { name: "an admitted result with an empty chain", mutate: (input) => ({ ...input, result: { ...admitted(), chain: [] } }) },
    { name: "an admitted result with an unbounded chain id", mutate: (input) => ({ ...input, result: { ...admitted(), chain: [""] } }) },
    { name: "an admitted result with an unknown tier", mutate: (input) => ({ ...input, result: { ...admitted(), effectiveStartTier: "weird" } }) },
    { name: "a rejected result with the wrong quality", mutate: (input) => ({ ...input, result: { kind: "rejected", quality: "not_rejected", reason: "done_when_unverifiable", evidence: {} } }) },
    { name: "a rejected result with an unknown reason", mutate: (input) => ({ ...input, result: { kind: "rejected", quality: "rejected", reason: "instructions_inadequate", evidence: {} } }) },
    { name: "an unknown abstention reason", mutate: (input) => ({ ...input, result: { kind: "abstained", reason: "exploded" } }) },
    { name: "a non-string abstention component", mutate: (input) => ({ ...input, result: { kind: "abstained", reason: "aborted", component: 42 } }) },
    { name: "an invalid evidence quality", mutate: (input) => ({ ...input, evidence: { quality: { outcome: "accepted" } } }) },
    { name: "a binding with an unbounded caller", mutate: (input) => ({ ...input, binding: { ...BINDING, caller: "" } }) },
    { name: "a flat binding without specRevision", mutate: (input) => ({ ...input, binding: undefined, policyRevision: "p" }) },
    { name: "a flat binding without policyRevision", mutate: (input) => ({ ...input, binding: undefined, specRevision: "s" }) },
    { name: "a flat binding without launchIdentity", mutate: (input) => ({ ...input, binding: undefined, specRevision: "s", policyRevision: "p" }) },
    { name: "a non-record evidence", mutate: (input) => ({ ...input, evidence: 5 }) },
    { name: "a non-record evidence quality", mutate: (input) => ({ ...input, evidence: { quality: 5 } }) },
    { name: "a non-string evidence quality outcome", mutate: (input) => ({ ...input, evidence: { quality: { outcome: 5 } } }) },
    { name: "a non-probability done_when evidence", mutate: (input) => ({ ...input, evidence: { quality: { outcome: "not_rejected", done_when_verifiable: 2 } } }) },
    { name: "an unbounded evidence policyRevision", mutate: (input) => ({ ...input, evidence: { policyRevision: "" } }) },
    { name: "a non-record evidence intent", mutate: (input) => ({ ...input, evidence: { intent: 5 } }) },
    { name: "an unknown evidence intent value", mutate: (input) => ({ ...input, evidence: { intent: { value: "ghost", confidence: 0.9 } } }) },
    { name: "a non-probability evidence intent confidence", mutate: (input) => ({ ...input, evidence: { intent: { value: "implement", confidence: 2 } } }) },
    { name: "a non-record evidence modifiers", mutate: (input) => ({ ...input, evidence: { modifiers: 5 } }) },
    { name: "an unknown evidence modifier", mutate: (input) => ({ ...input, evidence: { modifiers: { ghost: { probability: 0.9, applied: true, confidence: 0.9 } } } }) },
    { name: "a malformed evidence modifier", mutate: (input) => ({ ...input, evidence: { modifiers: { mutation_broad: { probability: 0.9, applied: "yes", confidence: 0.9 } } } }) },
    { name: "a non-record evidence workload", mutate: (input) => ({ ...input, evidence: { workload: 5 } }) },
    { name: "an unknown workload field value", mutate: (input) => ({ ...input, evidence: { workload: { ...evidence().workload, intent: "ghost" } } }) },
    { name: "a non-record evidence fitness", mutate: (input) => ({ ...input, evidence: { fitness: 5 } }) },
    { name: "a non-probability evidence fitness entry", mutate: (input) => ({ ...input, evidence: { fitness: { "pi:x": 2 } } }) },
    { name: "a non-array chainExclusions", mutate: (input) => ({ ...input, evidence: { chainExclusions: {} } }) },
    { name: "a non-record chainExclusion", mutate: (input) => ({ ...input, evidence: { chainExclusions: [5] } }) },
    { name: "an unknown chainExclusion reason", mutate: (input) => ({ ...input, evidence: { chainExclusions: [{ id: "x", provider: "p", reasons: ["weird"] }] } }) },
    { name: "a non-record evidence selectedPoint", mutate: (input) => ({ ...input, evidence: { selectedPoint: 5 } }) },
    { name: "a non-integer selectedPoint index", mutate: (input) => ({ ...input, evidence: { selectedPoint: { index: 0.5, id: "pi:x", runner: "pi", model: "m" } } }) },
    { name: "an unbounded selectedPoint id", mutate: (input) => ({ ...input, evidence: { selectedPoint: { index: 0, id: "", runner: "pi", model: "m" } } }) },
    { name: "an unknown selectedPoint runner", mutate: (input) => ({ ...input, evidence: { selectedPoint: { index: 0, id: "x", runner: "weird", model: "m" } } }) },
    { name: "an unknown selectedPoint reasoning", mutate: (input) => ({ ...input, evidence: { selectedPoint: { index: 0, id: "x", runner: "pi", model: "m", reasoning: "weird" } } }) },
    { name: "a non-array evidence availability", mutate: (input) => ({ ...input, evidence: { availability: {} } }) },
    { name: "a non-record availability item", mutate: (input) => ({ ...input, evidence: { availability: [5] } }) },
    { name: "an unbounded availability id", mutate: (input) => ({ ...input, evidence: { availability: [{ id: "", status: "unknown", retryNotBefore: null }] } }) },
    { name: "a non-string availability status", mutate: (input) => ({ ...input, evidence: { availability: [{ id: "x", status: 5, retryNotBefore: null }] } }) },
    { name: "an unknown availability status", mutate: (input) => ({ ...input, evidence: { availability: [{ id: "x", status: "weird", retryNotBefore: null }] } }) },
    { name: "an unbounded availability retryNotBefore", mutate: (input) => ({ ...input, evidence: { availability: [{ id: "x", status: "unknown", retryNotBefore: "" }] } }) },
    { name: "a non-record probability record", mutate: (input) => ({ ...input, probabilities: 5 }) },
    { name: "a non-record probability quality", mutate: (input) => ({ ...input, probabilities: { quality: 5 } }) },
    { name: "an invalid done_when probability", mutate: (input) => ({ ...input, probabilities: { quality: { done_when_verifiable: 2 } } }) },
    { name: "a non-record probability intent", mutate: (input) => ({ ...input, probabilities: { intent: 5 } }) },
    { name: "an unknown probability intent value", mutate: (input) => ({ ...input, probabilities: { intent: { value: "ghost", confidence: 0.9 } } }) },
    { name: "an invalid intent confidence", mutate: (input) => ({ ...input, probabilities: { intent: { value: "implement", confidence: 2 } } }) },
    { name: "a non-record intent distribution", mutate: (input) => ({ ...input, probabilities: { intent: { value: "implement", confidence: 0.9, probabilities: 5 } } }) },
    { name: "an intent distribution that does not sum to one", mutate: (input) => ({ ...input, probabilities: { intent: { value: "implement", confidence: 0.9, probabilities: { implement: 0.5 } } } }) },
    { name: "a non-record probability tier", mutate: (input) => ({ ...input, probabilities: { tier: 5 } }) },
    { name: "an unknown probability tier value", mutate: (input) => ({ ...input, probabilities: { tier: { value: "ghost", confidence: 0.9 } } }) },
    { name: "an invalid tier confidence", mutate: (input) => ({ ...input, probabilities: { tier: { value: "standard", confidence: 2 } } }) },
    { name: "a tier distribution that does not sum to one", mutate: (input) => ({ ...input, probabilities: { tier: { value: "standard", confidence: 0.9, probabilities: { standard: 0.5 } } } }) },
    { name: "a non-record probability modifiers", mutate: (input) => ({ ...input, probabilities: { modifiers: 5 } }) },
    { name: "an unknown probability modifier", mutate: (input) => ({ ...input, probabilities: { modifiers: { ghost: { probability: 0.9, applied: true, confidence: 0.9 } } } }) },
    { name: "a malformed probability modifier", mutate: (input) => ({ ...input, probabilities: { modifiers: { horizon_long: { probability: 0.9, confidence: 0.9 } } } }) },
    { name: "a non-record probability resources", mutate: (input) => ({ ...input, probabilities: { resources: 5 } }) },
    { name: "an unknown probability resource runner", mutate: (input) => ({ ...input, probabilities: { resources: { weird: {} } } }) },
    { name: "a probability resource field outside pools", mutate: (input) => ({ ...input, probabilities: { resources: { pi: { weird: {} } } } }) },
    { name: "an invalid resource probability", mutate: (input) => ({ ...input, probabilities: { resources: { pi: { tools: { read: 2 } } } } }) },
    { name: "a non-record probability fitness", mutate: (input) => ({ ...input, probabilities: { fitness: 5 } }) },
    { name: "a non-numeric fitness index", mutate: (input) => ({ ...input, probabilities: { fitness: { x: {} } } }) },
    { name: "an unknown fitness tier", mutate: (input) => ({ ...input, probabilities: { fitness: { "0": { weird: 0.9 } } } }) },
    { name: "a non-array uncertainDimensions", mutate: (input) => ({ ...input, probabilities: { uncertainDimensions: "intent" } }) },
    { name: "an unbounded uncertainDimensions entry", mutate: (input) => ({ ...input, probabilities: { uncertainDimensions: [""] } }) },
    { name: "a non-array exclusion list", mutate: (input) => ({ ...input, evidence: { exclusions: {} } }) },
    { name: "a non-record exclusion", mutate: (input) => ({ ...input, evidence: { exclusions: [5] } }) },
    { name: "an exclusion outside pool fields", mutate: (input) => ({ ...input, evidence: { exclusions: [{ field: "other", name: "x", noul: 0.5 }] } }) },
    { name: "an exclusion with an unbounded name", mutate: (input) => ({ ...input, evidence: { exclusions: [{ field: "tools", name: "", noul: 0.5 }] } }) },
    { name: "an exclusion with an invalid probability", mutate: (input) => ({ ...input, evidence: { exclusions: [{ field: "tools", name: "x", noul: 2 }] } }) },
    { name: "a non-record runtime", mutate: (input) => ({ ...input, result: admitted({ configuration: { ...configuration(), runtime: 5 as never } }) }) },
    { name: "an unbounded runtime kind", mutate: (input) => ({ ...input, result: admitted({ configuration: { ...configuration(), runtime: { kind: "" } as never } }) }) },
    { name: "an unknown runtime kind", mutate: (input) => ({ ...input, result: admitted({ configuration: { ...configuration(), runtime: { kind: "weird", model: "m" } as never } }) }) },
    { name: "an unbounded runtime model", mutate: (input) => ({ ...input, result: admitted({ configuration: { ...configuration(), runtime: { kind: "pi", model: "" } as never } }) }) },
    { name: "a non-array runtime tool list", mutate: (input) => ({ ...input, result: admitted({ configuration: { ...configuration(), runtime: { kind: "pi", model: "m", tools: "x" } as never } }) }) },
    { name: "a runtime tool that is not bounded", mutate: (input) => ({ ...input, result: admitted({ configuration: { ...configuration(), runtime: { kind: "pi", model: "m", tools: ["ok", 5] } as never } }) }) },
    { name: "a non-record resources", mutate: (input) => ({ ...input, result: admitted({ configuration: { ...configuration(), resources: 5 as never } }) }) },
    { name: "a non-record resource pool", mutate: (input) => ({ ...input, result: admitted({ configuration: { ...configuration(), resources: { tools: 5 } as never } }) }) },
    { name: "a non-string-array resource list", mutate: (input) => ({ ...input, result: admitted({ configuration: { ...configuration(), resources: { tools: { installed: "x", selected: [], exposed: [], permitted: [], denied: [] } } as never } }) }) },
    { name: "a non-record derivation", mutate: (input) => ({ ...input, result: admitted({ configuration: { ...configuration(), derivations: [5] as never } }) }) },
    { name: "an unknown derivation action", mutate: (input) => ({ ...input, result: admitted({ configuration: { ...configuration(), derivations: [{ action: "weird", field: "tools", name: "x", reason: "r" }] as never } }) }) },
    { name: "a derivation outside pool fields", mutate: (input) => ({ ...input, result: admitted({ configuration: { ...configuration(), derivations: [{ action: "deny", field: "weird", name: "x", reason: "r" }] as never } }) }) },
    { name: "a derivation with an unbounded name", mutate: (input) => ({ ...input, result: admitted({ configuration: { ...configuration(), derivations: [{ action: "deny", field: "tools", name: "", reason: "r" }] as never } }) }) },
    { name: "a derivation with an unbounded reason", mutate: (input) => ({ ...input, result: admitted({ configuration: { ...configuration(), derivations: [{ action: "deny", field: "tools", name: "x", reason: "" }] as never } }) }) },
    { name: "a non-record gap", mutate: (input) => ({ ...input, result: admitted({ configuration: { ...configuration(), gaps: [5] as never } }) }) },
    { name: "an unknown gap kind", mutate: (input) => ({ ...input, result: admitted({ configuration: { ...configuration(), gaps: [{ kind: "weird", message: "m" }] as never } }) }) },
    { name: "a gap with an unbounded message", mutate: (input) => ({ ...input, result: admitted({ configuration: { ...configuration(), gaps: [{ kind: "deny-coverage", message: "" }] as never } }) }) },
    { name: "an admitted result with bad quality", mutate: (input) => ({ ...input, result: { ...admitted(), quality: "weird" } }) },
    { name: "an admitted result with a fractional count", mutate: (input) => ({ ...input, result: { ...admitted(), count: 1.5 } }) },
    { name: "an admitted result with a zero count", mutate: (input) => ({ ...input, result: { ...admitted(), count: 0 } }) },
    { name: "a candidate without a point id", mutate: (input) => ({ ...input, result: admitted({ configuration: { ...configuration(), candidate: { index: 0, id: "", runner: "pi", model: "m" } } }) }) },
    { name: "a candidate with an unknown reasoning", mutate: (input) => ({ ...input, result: admitted({ configuration: { ...configuration(), candidate: { index: 0, id: "pi:x", runner: "pi", model: "m", reasoning: "weird" } } as never }) }) },
  ];

  for (const { name, mutate } of cases) {
    it(`refuses ${name} without persisting a line`, async () => {
      const root = await tempdir();
      const paths = routerLogPaths(root);
      await expect(appendRouterDecision(mutate(entry()) as SpecRouterLogEntry, { root })).rejects.toMatchObject({ code: "ROUTER_LOG_UNAVAILABLE" });
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

describe("appendRouterDecision projections", () => {
  it("persists claude, agy, and devin runtime projections plus derivations and gaps", async () => {
    const root = await tempdir();
    const runtimes: Record<string, unknown> = {
      claude: { kind: "claude", model: "cl-1", effort: "medium", permissionMode: "dontAsk", allowedTools: ["Read"], disallowedTools: [], addDirs: ["/a"], pluginDirs: ["/p"], developmentChannels: [] },
      agy: { kind: "agy", model: "a-1", mode: "plan", addDirs: ["/a"] },
      devin: { kind: "devin", model: "d-1", permissionMode: "dangerous" },
    };
    for (const kind of ["claude", "agy", "devin"]) {
      await appendRouterDecision(entry({
        caller: `hunt-${kind}`,
        result: admitted({
          configuration: {
            ...configuration(),
            candidate: { index: 0, id: `${kind}:${kind}-m`, runner: kind, model: `${kind}-m` },
            runtime: runtimes[kind],
            derivations: [{ action: "dependency", field: "tools", name: "write", reason: "needed" }],
            gaps: [{ kind: "deny-coverage", message: "no tool coverage" }],
          } as never,
        }),
      }), { root });
    }
    const records = await readRecords(routerLogPaths(root).decisions);
    const kinds = records.map((record) => (record.result as { configuration: { runtime: { kind: string } } }).configuration.runtime.kind);
    expect(kinds).toEqual(["claude", "agy", "devin"]);
    const claude = records[0]!.result as Admitted;
    expect(claude.configuration.candidate).toMatchObject({ id: "claude:claude-m", runner: "claude" });
    expect(claude.configuration.derivations).toEqual([{ action: "dependency", field: "tools", name: "write", reason: "needed" }]);
    expect(claude.configuration.gaps).toEqual([{ kind: "deny-coverage", message: "no tool coverage" }]);
  });

  it("persists entry-level evidence with a future retryNotBefore", async () => {
    const root = await tempdir();
    await appendRouterDecision(entry({
      evidence: {
        availability: [{ id: "agy:agy-model", status: "known-exhausted", retryNotBefore: "2026-09-19T00:00:00.000Z" }],
      },
    }), { root });
    const record = (await readRecords(routerLogPaths(root).decisions))[0]!;
    expect(record.evidence).toMatchObject({
      availability: [{ id: "agy:agy-model", status: "known-exhausted", retryNotBefore: "2026-09-19T00:00:00.000Z" }],
    });
  });

  it("persists allowlisted resource exclusions in result and entry evidence", async () => {
    const root = await tempdir();
    const exclusions = [{ field: "tools" as const, name: "executor_execute", noul: 0.5 }];
    const withExclusions = { ...evidence(), exclusions };
    await appendRouterDecision(entry({ evidence: withExclusions, result: admitted({ evidence: withExclusions }) }), { root });
    const record = (await readRecords(routerLogPaths(root).decisions))[0]!;
    expect(record.evidence.exclusions).toEqual(exclusions);
    expect((record.result as Admitted).evidence.exclusions).toEqual(exclusions);
  });

  it("persists the intent distribution and a reasoning-less selectedPoint when present", async () => {
    const root = await tempdir();
    await appendRouterDecision(entry({
      evidence: {
        ...evidence(),
        intent: { value: "implement", confidence: 0.9, probabilities: { explore: 0.01, reason: 0.01, implement: 0.94, debug: 0.01, verify: 0.01, review: 0.01, coordinate: 0.01 } },
        selectedPoint: { index: 2, id: "agy:agy-model", runner: "agy", model: "agy-model" },
      },
    }), { root });
    const records = await readRecords(routerLogPaths(root).decisions);
    expect(records[0]!.evidence).toMatchObject({
      intent: { probabilities: { implement: 0.94 } },
      selectedPoint: { index: 2, id: "agy:agy-model", runner: "agy", model: "agy-model" },
    });
  });

  it("persists intent evidence when its optional distribution is absent", async () => {
    const root = await tempdir();
    await appendRouterDecision(entry({ probabilities: { intent: { value: "implement", confidence: 0.9 } } }), { root });
    const record = (await readRecords(routerLogPaths(root).decisions))[0]!;
    expect(record.probabilities).toEqual({ intent: { value: "implement", confidence: 0.9 } });
  });

  it("persists abstained results with and without a component, and attached evidence", async () => {
    const root = await tempdir();
    await appendRouterDecision(entry({ caller: "bare", result: { kind: "abstained", reason: "no_candidates_at_tier" } }), { root });
    await appendRouterDecision(entry({ caller: "full", result: { kind: "abstained", reason: "transport_failed", component: "t", evidence: { quality: { outcome: "not_evaluated" } } } }), { root });
    const records = await readRecords(routerLogPaths(root).decisions);
    expect(records[0]!.result).toEqual({ kind: "abstained", reason: "no_candidates_at_tier" });
    expect(records[1]!.result).toEqual({ kind: "abstained", reason: "transport_failed", component: "t", evidence: { quality: { outcome: "not_evaluated" } } });
    expect(records[1]!.evidence).toEqual({ quality: { outcome: "not_evaluated" } });
  });

  it("assembles the binding from flat fields and tolerates entries without binding or state", async () => {
    const root = await tempdir();
    const flat = entry();
    delete flat.binding;
    Object.assign(flat, { specRevision: "s", policyRevision: "p", launchIdentity: "l" });
    await appendRouterDecision(flat, { root });
    const bare = { caller: "bare", result: { kind: "abstained", reason: "aborted" } } as SpecRouterLogEntry;
    await appendRouterDecision(bare, { root });
    const records = await readRecords(routerLogPaths(root).decisions);
    expect(records[0]!.binding).toEqual({ caller: "oom-hunt", specRevision: "s", policyRevision: "p", launchIdentity: "l" });
    expect(records[1]!.binding).toBeNull();
    expect(records[1]!.stateDigest).toBeNull();
    expect(records[1]!.stateUnavailable).toBeNull();
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

  it("refuses a symlinked or non-directory .herdr, tolerating a writable one (leaf + 0600 file are the trust boundary)", async () => {
    for (const kind of ["symlink", "writable", "file"] as const) {
      const root = await tempdir();
      const dotHerdr = join(root, ".herdr");
      if (kind === "symlink") {
        await symlink(join(root, "elsewhere"), dotHerdr);
        await expect(appendRouterDecision(entry(), { root })).rejects.toMatchObject({ code: "ROUTER_LOG_UNAVAILABLE" });
      } else if (kind === "writable") {
        // A shared/writable parent is tolerated: the router leaf is created
        // owner-only and the decisions file is 0600 with O_NOFOLLOW and
        // post-open verification, so a writable parent cannot forge the log.
        await mkdir(dotHerdr, { mode: 0o777 });
        await appendRouterDecision(entry(), { root });
        const paths = routerLogPaths(root);
        expect((await lstat(paths.directory)).mode & 0o777).toBe(0o700);
        expect((await lstat(paths.decisions)).mode & 0o777).toBe(0o600);
      } else {
        await writeFile(dotHerdr, "", { mode: 0o600 });
        await expect(appendRouterDecision(entry(), { root })).rejects.toMatchObject({ code: "ROUTER_LOG_UNAVAILABLE" });
      }
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
    const lease = await acquireFlockHolder({
      lockPath: paths.lock,
      wait: "nonblock",
      readyMarker: "HERDR_TEST_LOCK_READY",
      subject: "Test lock",
      failure: (message) => new Error(message),
    });
    await lease.release();
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
    await appendRouterDecision(entry({ caller: "hunt-a" }), { root });
    const holder = spawn("flock", ["--exclusive", "--nonblock", paths.lock, "--command", "printf HERDR_HELD_READY; cat"], { stdio: ["pipe", "pipe", "pipe"] });
    try {
      const ready = new Promise<void>((resolve, reject) => {
        holder.stdout.setEncoding("utf8");
        holder.stdout.on("data", (chunk: string) => { if (chunk.includes("HERDR_HELD_READY")) resolve(); });
        holder.once("error", reject);
      });
      await ready;
      await expect(appendRouterDecision(entry({ caller: "hunt-b" }), { root, waitMs: 50 })).rejects.toMatchObject({ code: "ROUTER_LOG_UNAVAILABLE" });
    } finally {
      holder.stdin.end();
      await once(holder, "exit");
    }
    const records = await readRecords(paths.decisions);
    expect(records).toHaveLength(1);
    expect(records[0]!.name).toBe("hunt-a");
  });

  it("settles failed close and release after the line is appended", async () => {
    const root = await tempdir();
    fsControl.failClose = () => eio();
    await appendRouterDecision(entry(), { root });
    fsControl.failClose = undefined;
    lockControl.acquire = async () => ({
      check: async () => {},
      release: async () => { throw new Error("wedged holder"); },
    });
    await appendRouterDecision(entry({ caller: "hunt-b" }), { root });
    const records = await readRecords(routerLogPaths(root).decisions);
    expect(records).toHaveLength(2);
    expect(records[0]!.name).toBe("oom-hunt");
    expect(records[1]!.name).toBe("hunt-b");
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
  it("allowlists typed fields before modelSafeJson and never persists planted canaries", async () => {
    const root = await tempdir();
    const paths = routerLogPaths(root);
    const dirtyState = {
      task: {
        objective: "CANARY-objective",
        scope: "CANARY-scope",
        doneWhen: ["CANARY-done"],
        constraints: ["CANARY-constraint"],
        extra: "CANARY-extra",
      },
      points: POINTS.map((item) => ({
        ...item,
        description: "CANARY-description",
        body: "CANARY-body",
        tools: ["CANARY-tool"],
        environment: { SECRET: "CANARY-env" },
      })),
      request: "CANARY-request",
    } as unknown as TaskRouterState;
    const dirtyConfiguration = {
      ...configuration(),
      environment: { SECRET: "CANARY-config-env" },
      runtime: { ...configuration().runtime, environment: { SECRET: "CANARY-runtime-env" } },
    };
    const dirtyResult = {
      ...admitted({ configuration: dirtyConfiguration as CompiledContract }),
      rawResponse: "CANARY-raw-response",
      environment: { SECRET: "CANARY-result-env" },
    } as unknown as Admitted;
    const dirtyEntry = {
      caller: "oom-hunt",
      name: "CANARY-name",
      binding: BINDING,
      state: dirtyState,
      probabilities: { raw: "CANARY-probabilities", environment: { SECRET: "CANARY-prob-env" } },
      result: dirtyResult,
      evidence: { ...evidence(), raw: "CANARY-evidence" },
      rawResponse: "CANARY-response",
    } as unknown as SpecRouterLogEntry;

    await appendRouterDecision(dirtyEntry, { root });
    const content = await readFile(paths.decisions, "utf8");
    expect(content).not.toContain("CANARY");
    const record = JSON.parse(content.trim()) as RouterLogRecord;
    expect(record.name).toBe("oom-hunt");
    expect(record.stateDigest).toBe(expectedDigest(dirtyState));
    expect(record.probabilities).toEqual({});
    expect(record.result).toMatchObject({ kind: "admitted", quality: "not_rejected", count: 1 });
    expect(record.evidence).toEqual(evidence());
  });
});
