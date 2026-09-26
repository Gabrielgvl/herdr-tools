import { chmod, lstat, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createIntentStore,
  DAEMON_INTENTS_DIR_NAME,
  managerSessionKey,
  taskDigest,
  type IntentStore,
  type LaunchIntentRecord,
} from "../../src/daemon/intents.js";
import { resolveDaemonNamespace, type DaemonNamespace } from "../../src/daemon/namespace.js";
import type { LaunchTask } from "../../src/launch-schema.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempdir(prefix = "herdr-intents-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const sessionA = { source: "herdr", agent: "pi", kind: "pi", value: "session-A" };
const sessionB = { source: "herdr", agent: "claude", kind: "claude", value: "session-B" };
const mgrA = managerSessionKey(sessionA);
const mgrB = managerSessionKey(sessionB);

const task: LaunchTask = { objective: "do the work", scope: "only these files", doneWhen: ["evidence exists"] };
const root = "/home/gabriel/project";

async function fixture(): Promise<{ store: IntentStore; namespace: DaemonNamespace; dir: string }> {
  const dir = await tempdir();
  const socket = join(dir, "herdr.sock");
  await writeFile(socket, "");
  const namespace = await resolveDaemonNamespace({ HERDR_SOCKET_PATH: socket });
  return { store: createIntentStore({ namespace }), namespace, dir };
}

const begin = (mgr: string, key: string, overrides: Record<string, unknown> = {}) =>
  ({ managerSessionKey: mgr, idempotencyKey: key, task, projectRoot: root, ...overrides });

async function rawRecord(namespace: DaemonNamespace, mgr: string, key: string): Promise<LaunchIntentRecord> {
  return JSON.parse(await readFile(join(namespace.dir, DAEMON_INTENTS_DIR_NAME, mgr, `${key}.json`), "utf8"));
}

describe("D1 durable record", () => {
  it("records the intent before any effect: temp+rename discipline, 0600 file, 0700 dirs", async () => {
    const { store, namespace } = await fixture();
    const result = await store.begin(begin(mgrA, "k1"));
    expect(result).toMatchObject({ kind: "launch", resumed: false });
    if (result.kind !== "launch") return;
    const intent = result.intent;
    expect(intent).toMatchObject({
      v: 1,
      managerSessionKey: mgrA,
      idempotencyKey: "k1",
      taskDigest: taskDigest(task),
      projectRoot: root,
      state: "recorded",
      children: [],
    });
    expect(intent.launchId).toMatch(/^[0-9a-f-]{36}$/);

    // Durable on disk exactly as returned, in an owner-only tree.
    const mgrDir = join(namespace.dir, DAEMON_INTENTS_DIR_NAME, mgrA);
    expect((await lstat(join(namespace.dir, DAEMON_INTENTS_DIR_NAME))).mode & 0o777).toBe(0o700);
    expect((await lstat(mgrDir)).mode & 0o777).toBe(0o700);
    const file = await lstat(join(mgrDir, "k1.json"));
    expect(file.isFile()).toBe(true);
    expect(file.mode & 0o777).toBe(0o600);
    expect(await rawRecord(namespace, mgrA, "k1")).toEqual(intent);

    // The commit leaves no staged temp behind.
    expect((await readdir(mgrDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("fails closed on an untrusted manager directory or record file", async () => {
    const { store, namespace } = await fixture();
    await store.begin(begin(mgrA, "k1"));
    const mgrDir = join(namespace.dir, DAEMON_INTENTS_DIR_NAME, mgrA);

    await chmod(mgrDir, 0o770);
    await expect(store.list(mgrA)).rejects.toMatchObject({ code: "INTENT_STORE_UNAVAILABLE" });
    await chmod(mgrDir, 0o700);
    await expect(store.get(mgrA, "k1")).resolves.toMatchObject({ state: "recorded" });

    await chmod(join(mgrDir, "k1.json"), 0o622);
    await expect(store.get(mgrA, "k1")).rejects.toMatchObject({ code: "INTENT_STORE_UNAVAILABLE" });
  });

  it("refuses a malformed or misfiled record rather than guessing", async () => {
    const { store, namespace } = await fixture();
    await store.begin(begin(mgrA, "k1"));
    const mgrDir = join(namespace.dir, DAEMON_INTENTS_DIR_NAME, mgrA);

    await writeFile(join(mgrDir, "k1.json"), "{not json", { mode: 0o600 });
    await expect(store.get(mgrA, "k1")).rejects.toMatchObject({ code: "INTENT_MALFORMED" });
    await expect(store.begin(begin(mgrA, "k1"))).rejects.toMatchObject({ code: "INTENT_MALFORMED" });

    // A record whose persisted binding disagrees with its filename is malformed.
    await store.begin(begin(mgrA, "k2"));
    const migrated = { ...(await rawRecord(namespace, mgrA, "k2")), idempotencyKey: "other" };
    await writeFile(join(mgrDir, "k1.json"), JSON.stringify(migrated), { mode: 0o600 });
    await expect(store.get(mgrA, "k1")).rejects.toMatchObject({ code: "INTENT_MALFORMED" });
  });
});

describe("D3 crash windows", () => {
  it("before the recorded fsync there is no intent: a fresh launch proceeds", async () => {
    const { store } = await fixture();
    expect(await store.get(mgrA, "k1")).toBeUndefined();
    const result = await store.begin(begin(mgrA, "k1"));
    expect(result).toMatchObject({ kind: "launch", resumed: false });
  });

  it("between recorded and effecting the launch resumes with the identical launchId", async () => {
    const { store, namespace } = await fixture();
    const first = await store.begin(begin(mgrA, "k1"));
    if (first.kind !== "launch") throw new Error("expected launch");

    // Crash before any effect: the on-disk record is still `recorded`.
    const replayed = await store.begin(begin(mgrA, "k1"));
    expect(replayed).toMatchObject({ kind: "launch", resumed: true });
    if (replayed.kind !== "launch") return;
    expect(replayed.intent.launchId).toBe(first.intent.launchId);
    expect(replayed.intent.state).toBe("recorded");

    // No record mutation happened on the resume path.
    expect(await rawRecord(namespace, mgrA, "k1")).toEqual(first.intent);
  });

  it("after effecting a restart surfaces unresolved and never replays the effect", async () => {
    const { store, namespace } = await fixture();
    const first = await store.begin(begin(mgrA, "k1"));
    if (first.kind !== "launch") throw new Error("expected launch");
    const effecting = await store.markEffecting(first.intent);
    await store.recordChildren(effecting, [{ name: "task-abc-1", runId: "run-1" }]);

    // A live duplicate while the effect is in flight returns recorded state, zero effect.
    const duplicate = await store.begin(begin(mgrA, "k1"));
    expect(duplicate).toMatchObject({ kind: "replay", intent: { state: "effecting" } });

    // Restart: the interrupted effect is recovered as unresolved, durably.
    const recovered = await store.recoverInterrupted(mgrA);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      state: "unresolved",
      resolution: "interrupted",
      effectCertainty: "unknown",
      launchId: first.intent.launchId,
      children: [{ name: "task-abc-1", runId: "run-1" }],
    });
    expect((await rawRecord(namespace, mgrA, "k1")).state).toBe("unresolved");

    // The next begin returns the recorded children for reconcile — never a replay.
    const after = await store.begin(begin(mgrA, "k1"));
    expect(after.kind).toBe("unresolved");
    if (after.kind !== "unresolved") return;
    expect(after.intent.children).toEqual([{ name: "task-abc-1", runId: "run-1" }]);
    expect(after.intent.launchId).toBe(first.intent.launchId);
  });
});

describe("replay rules", () => {
  it("returns recorded state for completed and failed bindings with zero effect", async () => {
    const { store } = await fixture();
    const launched = await store.begin(begin(mgrA, "done"));
    if (launched.kind !== "launch") throw new Error("expected launch");
    const effecting = await store.markEffecting(launched.intent);
    await store.complete(effecting, [{ name: "task-abc-1", runId: "run-1" }]);
    expect(await store.begin(begin(mgrA, "done"))).toMatchObject({ kind: "replay", intent: { state: "completed" } });

    const failed = await store.begin(begin(mgrA, "lost"));
    if (failed.kind !== "launch") throw new Error("expected launch");
    await store.fail(failed.intent, { effectCertainty: "absent" });
    expect(await store.begin(begin(mgrA, "lost"))).toMatchObject({ kind: "replay", intent: { state: "failed" } });
  });
});

describe("conflict rules", () => {
  it("same key + session with a different taskDigest is a per-field conflict", async () => {
    const { store } = await fixture();
    await store.begin(begin(mgrA, "k1"));
    const variants: Array<[string, Partial<LaunchTask>]> = [
      ["objective", { objective: "other work" }],
      ["scope", { scope: "other files" }],
      ["doneWhen", { doneWhen: ["other evidence"] }],
      ["constraints", { constraints: ["c1"] }],
      ["tier", { tier: "frontier" }],
      ["replicas", { replicas: 2 }],
      ["label", { label: "renamed" }],
      ["cwd", { cwd: "/elsewhere" }],
      ["recoveryOf", { recoveryOf: "run-uuid-1" }],
    ];
    for (const [field, change] of variants) {
      await expect(store.begin(begin(mgrA, "k1", { task: { ...task, ...change } })), field).rejects.toMatchObject({
        code: "IDEMPOTENCY_KEY_CONFLICT",
        details: { field: "taskDigest" },
      });
    }
  });

  it("same key + session + task with a different projectRoot is a per-field conflict", async () => {
    const { store } = await fixture();
    await store.begin(begin(mgrA, "k1"));
    await expect(store.begin(begin(mgrA, "k1", { projectRoot: "/other/root" }))).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_CONFLICT",
      details: { field: "projectRoot" },
    });
  });

  it("the same textual key in another managerSessionKey is an independent binding", async () => {
    const { store, namespace } = await fixture();
    await store.begin(begin(mgrA, "shared-key"));
    const other = await store.begin({ ...begin(mgrB, "shared-key"), task: { ...task, objective: "different work entirely" } });
    expect(other).toMatchObject({ kind: "launch", resumed: false });

    // Separate directories, separate records, no fabricated cross-session conflict.
    const dirA = join(namespace.dir, DAEMON_INTENTS_DIR_NAME, mgrA);
    const dirB = join(namespace.dir, DAEMON_INTENTS_DIR_NAME, mgrB);
    expect((await readdir(dirA)).sort()).toEqual(["intents.lock", "shared-key.json"].sort());
    expect((await readdir(dirB)).sort()).toEqual(["intents.lock", "shared-key.json"].sort());
    expect((await rawRecord(namespace, mgrA, "shared-key")).taskDigest).not.toBe(
      (await rawRecord(namespace, mgrB, "shared-key")).taskDigest,
    );
    expect((await store.listManagers()).sort()).toEqual([mgrA, mgrB].sort());
  });
});

describe("failed-only-with-no-child-evidence rule", () => {
  it("settles failed only when certainty is absent and no child was recorded", async () => {
    const { store } = await fixture();
    const launched = await store.begin(begin(mgrA, "k1"));
    if (launched.kind !== "launch") throw new Error("expected launch");

    // Pre-effect failure from `recorded`: provably no child effect.
    const failed = await store.fail(launched.intent, { effectCertainty: "absent", failureCode: "ROUTER_LOG_UNAVAILABLE" });
    expect(failed).toMatchObject({ state: "failed", effectCertainty: "absent", failureCode: "ROUTER_LOG_UNAVAILABLE" });

    // Post-effect but provably nothing landed.
    const second = await store.begin(begin(mgrA, "k2"));
    if (second.kind !== "launch") throw new Error("expected launch");
    const effecting = await store.markEffecting(second.intent);
    expect(await store.fail(effecting, { effectCertainty: "absent" })).toMatchObject({ state: "failed" });
  });

  it.each([
    ["partial", "k-p"],
    ["unknown", "k-u"],
    ["confirmed", "k-c"],
  ] as const)("settles %s certainty as unresolved, never failed", async (effectCertainty, key) => {
    const { store } = await fixture();
    const launched = await store.begin(begin(mgrA, key));
    if (launched.kind !== "launch") throw new Error("expected launch");
    const effecting = await store.markEffecting(launched.intent);
    const settled = await store.fail(effecting, { effectCertainty });
    expect(settled).toMatchObject({ state: "unresolved", resolution: "effect_uncertain", effectCertainty });
    expect(settled.state).not.toBe("failed");
  });

  it("recorded children defeat an absent-certainty failure: still unresolved", async () => {
    const { store } = await fixture();
    const launched = await store.begin(begin(mgrA, "k1"));
    if (launched.kind !== "launch") throw new Error("expected launch");
    const effecting = await store.markEffecting(launched.intent);
    await store.recordChildren(effecting, [{ name: "task-abc-1" }]);
    const settled = await store.fail(effecting, { effectCertainty: "absent" });
    expect(settled.state).toBe("unresolved");
  });
});

describe("reconcile (§8)", () => {
  async function unresolvedIntent(store: IntentStore, key: string): Promise<LaunchIntentRecord> {
    const launched = await store.begin(begin(mgrA, key));
    if (launched.kind !== "launch") throw new Error("expected launch");
    const effecting = await store.markEffecting(launched.intent);
    return store.fail(effecting, { effectCertainty: "partial", children: [{ name: "task-abc-1", runId: "r1" }, { name: "task-abc-2" }] });
  }

  it("closes completed(reconciled) once every recorded child is bound or provably absent", async () => {
    const { store } = await fixture();
    const intent = await unresolvedIntent(store, "k1");
    const reconciled = await store.reconcile(intent, [
      { name: "task-abc-1", disposition: "bound" },
      { name: "task-abc-2", disposition: "identity_lost" },
    ]);
    expect(reconciled).toMatchObject({ state: "completed", reconciled: true });
    expect(reconciled.children).toEqual([
      { name: "task-abc-1", runId: "r1", disposition: "bound" },
      { name: "task-abc-2", disposition: "identity_lost" },
    ]);
    expect(await store.begin(begin(mgrA, "k1"))).toMatchObject({ kind: "replay", intent: { state: "completed" } });
  });

  it("stays unresolved while any replica is ambiguous or unclassified", async () => {
    const { store } = await fixture();
    const intent = await unresolvedIntent(store, "k1");

    const ambiguous = await store.reconcile(intent, [
      { name: "task-abc-1", disposition: "bound" },
      { name: "task-abc-2", disposition: "ambiguous" },
    ]);
    expect(ambiguous.state).toBe("unresolved");
    expect(ambiguous.children[1]).toMatchObject({ disposition: "ambiguous" });

    const partial = await store.reconcile(intent, [{ name: "task-abc-1", disposition: "bound" }]);
    expect(partial.state).toBe("unresolved");

    const launched = await store.begin(begin(mgrA, "k2"));
    if (launched.kind !== "launch") throw new Error("expected launch");
    await expect(store.reconcile(launched.intent, [{ name: "x", disposition: "bound" }])).rejects.toMatchObject({
      code: "INTENT_STATE_CONFLICT",
    });
  });
});

describe("transitions, reads, and request validation", () => {
  it("guards every transition against a moved or stale state", async () => {
    const { store } = await fixture();
    const launched = await store.begin(begin(mgrA, "k1"));
    if (launched.kind !== "launch") throw new Error("expected launch");

    // `recorded` cannot skip to completed or carry children.
    await expect(store.complete(launched.intent)).rejects.toMatchObject({ code: "INTENT_STATE_CONFLICT" });
    await expect(store.recordChildren(launched.intent, [{ name: "task-abc-1" }])).rejects.toMatchObject({ code: "INTENT_STATE_CONFLICT" });

    const effecting = await store.markEffecting(launched.intent);
    await expect(store.markEffecting(effecting)).rejects.toMatchObject({ code: "INTENT_STATE_CONFLICT" });

    // A handle minted for another generation cannot move this binding.
    await expect(store.markEffecting({ ...launched.intent, launchId: "00000000-0000-0000-0000-000000000000" })).rejects.toMatchObject({
      code: "INTENT_STATE_CONFLICT",
    });
  });

  it("merges recorded children by name, filling the run ID once known", async () => {
    const { store } = await fixture();
    const launched = await store.begin(begin(mgrA, "k1"));
    if (launched.kind !== "launch") throw new Error("expected launch");
    const effecting = await store.markEffecting(launched.intent);
    await store.recordChildren(effecting, [{ name: "task-abc-1" }, { name: "task-abc-2", runId: "r2" }]);
    const merged = await store.recordChildren(effecting, [{ name: "task-abc-1", runId: "r1" }]);
    expect(merged.children).toEqual([{ name: "task-abc-1", runId: "r1" }, { name: "task-abc-2", runId: "r2" }]);
  });

  it("validates the request boundary: key, session key, task, project root", async () => {
    const { store } = await fixture();
    for (const badKey of ["", "x".repeat(129), "a/b", "a b", "a\nb", "a%b"]) {
      await expect(store.begin(begin(mgrA, badKey))).rejects.toMatchObject({
        code: "INTENT_REQUEST_INVALID",
        details: { field: "idempotencyKey" },
      });
    }
    await expect(store.begin(begin("not-hex", "k1"))).rejects.toMatchObject({
      code: "INTENT_REQUEST_INVALID",
      details: { field: "managerSessionKey" },
    });
    await expect(store.begin(begin(mgrA, "k1", { task: { objective: "o" } }))).rejects.toMatchObject({
      code: "INTENT_REQUEST_INVALID",
      details: { field: "task" },
    });
    await expect(store.begin(begin(mgrA, "k1", { projectRoot: "" }))).rejects.toMatchObject({
      code: "INTENT_REQUEST_INVALID",
      details: { field: "projectRoot" },
    });
  });

  it("keeps dot-only keys inside the manager directory: '<key>.json' can never traverse", async () => {
    const { store, namespace } = await fixture();
    for (const key of [".", "..", "..."]) {
      expect(await store.begin(begin(mgrA, key))).toMatchObject({ kind: "launch" });
      const dir = join(namespace.dir, DAEMON_INTENTS_DIR_NAME, mgrA);
      expect(await readdir(dir)).toContain(`${key}.json`);
      expect(await store.get(mgrA, key)).toMatchObject({ idempotencyKey: key });
    }
    // Nothing escaped: the namespace root gained no stray entries.
    expect((await readdir(join(namespace.dir, DAEMON_INTENTS_DIR_NAME))).sort()).toEqual([mgrA]);
  });

  it("lists intents per manager and recovers only the targeted scope", async () => {
    const { store } = await fixture();
    for (const [mgr, key] of [[mgrA, "a1"], [mgrA, "a2"], [mgrB, "b1"]] as const) {
      const launched = await store.begin(begin(mgr, key));
      if (launched.kind !== "launch") throw new Error("expected launch");
      if (key !== "a2") await store.markEffecting(launched.intent);
    }
    expect((await store.list(mgrA)).map((intent) => intent.idempotencyKey).sort()).toEqual(["a1", "a2"]);

    // Scoped recovery flips only that manager's effecting records.
    const recovered = await store.recoverInterrupted(mgrA);
    expect(recovered.map((intent) => intent.idempotencyKey)).toEqual(["a1"]);
    expect(await store.get(mgrA, "a2")).toMatchObject({ state: "recorded" });
    expect(await store.get(mgrB, "b1")).toMatchObject({ state: "effecting" });

    // The all-manager sweep catches the rest for the D4 restart path.
    expect((await store.recoverInterrupted()).map((intent) => intent.idempotencyKey)).toEqual(["b1"]);
  });
});

describe("D2 binding derivations", () => {
  it("derives managerSessionKey as sha256 over the complete agent_session tuple", () => {
    expect(mgrA).toMatch(/^[0-9a-f]{64}$/);
    expect(mgrA).not.toBe(mgrB);
    expect(managerSessionKey(sessionA)).toBe(mgrA);
    // Every field participates — a restarted agent (new value) is a new key.
    expect(managerSessionKey({ ...sessionA, value: "session-A2" })).not.toBe(mgrA);
    expect(managerSessionKey({ ...sessionA, kind: "other" })).not.toBe(mgrA);
  });

  it("digests the received task: only semantically-defaulted optionals are invisible, every field counts", () => {
    expect(taskDigest(task)).toMatch(/^[0-9a-f]{64}$/);
    // Omitted and semantically-defaulted digest identically (`constraints` ≡ [], `replicas` ≡ 1).
    expect(taskDigest({ ...task, replicas: 1, constraints: [] })).toBe(taskDigest(task));
    // Key order in the caller's object is irrelevant — canonical form is sorted.
    expect(taskDigest({ doneWhen: task.doneWhen, scope: task.scope, objective: task.objective })).toBe(taskDigest(task));
    // Any real change is a different digest.
    expect(taskDigest({ ...task, replicas: 2 })).not.toBe(taskDigest(task));
    expect(taskDigest({ ...task, label: "x" })).not.toBe(taskDigest(task));
  });

  it("F1: digests an omitted tier differently from an explicit `standard` — the request as received, before default substitution", () => {
    // Omission lets the workload floor decide; `standard` pins it — the router
    // treats them differently, so the idempotency digest must too.
    expect(taskDigest({ ...task, tier: "standard" })).not.toBe(taskDigest(task));
    expect(taskDigest({ ...task, tier: "economy" })).not.toBe(taskDigest({ ...task, tier: "standard" }));
    // Byte-identical replay still digests identically.
    expect(taskDigest({ ...task })).toBe(taskDigest(task));
    expect(taskDigest({ ...task, tier: "standard" })).toBe(taskDigest({ ...task, tier: "standard" }));
  });
});
