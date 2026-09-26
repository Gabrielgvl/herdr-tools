import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import type { JsonEnvelope, PiExec } from "../../src/cli.js";
import { ContextResolutionError } from "../../src/context.js";
import { createHandoffAllocator } from "../../src/handoff.js";
import { createRuntime } from "../../index.js";
import { JobRegistry } from "../../src/job-registry.js";
import type { LaunchTask } from "../../src/launch-schema.js";
import { RecipientRegistry } from "../../src/messages/recipients.js";
import { RuntimeOwnership } from "../../src/ownership.js";
import { SupervisionRegistry } from "../../src/supervision/registry.js";
import type { HerdrSnapshot } from "../../src/targets.js";
import { createIntentStore, DaemonIntentError, DAEMON_INTENTS_DIR_NAME, managerSessionKey, type IntentStore, type LaunchIntentRecord } from "../../src/daemon/intents.js";
import { resolveDaemonNamespace, type DaemonNamespace } from "../../src/daemon/namespace.js";
import { DaemonRequestError } from "../../src/daemon/protocol.js";
import {
  createDaemonRuntime,
  createSharedRuntime,
  requireDaemonMailbox,
  daemonContextResolver,
  daemonDispatcher,
  daemonEffectiveContext,
  daemonRequestError,
  parseCallerClaim,
  verifyDaemonCaller,
  type DaemonCli,
  type DaemonRuntime,
} from "../../src/daemon/runtime.js";

const dirs: string[] = [];
const runtimes: DaemonRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.supervision.shutdown().catch(() => undefined);
    runtime.jobs.shutdown();
    await runtime.queueFlush.shutdown().catch(() => undefined);
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const managerSession = { source: "herdr:pi", agent: "pi", kind: "id", value: "mgr-session" };
const managerKey = managerSessionKey(managerSession);
const claim = { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", agentSession: managerSession };

function callerPane(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "manager", agent: "pi", terminal_id: "t-mgr", agent_session: managerSession, agent_status: "idle", ...overrides };
}

function callerAgent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { pane_id: "w1:p1", name: "manager", agent: "pi", terminal_id: "t-mgr", agent_session: managerSession, agent_status: "idle", ...overrides };
}

function snapshot(overrides: { panes?: Record<string, unknown>[]; agents?: Record<string, unknown>[] } = {}): HerdrSnapshot {
  return {
    version: "0.8.0",
    protocol: 22,
    workspaces: [{ workspace_id: "w1", label: "workspace" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "main" }],
    panes: [callerPane(), ...(overrides.panes ?? [])] as HerdrSnapshot["panes"],
    agents: [callerAgent(), ...(overrides.agents ?? [])] as HerdrSnapshot["agents"],
  };
}

const ok = (result: unknown): JsonEnvelope => ({ id: "op", result });
const envelope = (result: unknown): ExecResult => ({ stdout: JSON.stringify(ok(result)), stderr: "", code: 0, killed: false });

/** An exec stub that serves `api snapshot` from a mutable snapshot producer. */
function execStub(options: { snapshot?: () => HerdrSnapshot; error?: unknown } = {}): { exec: PiExec; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    exec: async (_command, argv) => {
      calls.push(argv);
      if (options.error !== undefined) throw options.error;
      if (argv[0] === "api" && argv[1] === "snapshot") return envelope({ type: "session_snapshot", snapshot: (options.snapshot ?? snapshot)() });
      throw new Error(`unexpected argv: ${argv.join(" ")}`);
    },
  };
}

/** A minimal `DaemonCli` that serves `api snapshot` without an exec hop. */
function cliStub(options: { snapshot?: () => HerdrSnapshot; error?: unknown } = {}): { cli: DaemonCli; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    cli: {
      runJson: async (argv) => {
        calls.push(argv);
        if (options.error !== undefined) throw options.error;
        return ok({ type: "session_snapshot", snapshot: (options.snapshot ?? snapshot)() });
      },
    },
  };
}

async function namespace(): Promise<{ env: NodeJS.ProcessEnv; namespace: DaemonNamespace }> {
  const root = await mkdtemp(join(tmpdir(), "herdr-daemon-runtime-"));
  dirs.push(root);
  const endpoint = join(root, "herdr.sock");
  await writeFile(endpoint, "");
  const env = { HERDR_SOCKET_PATH: endpoint };
  return { env, namespace: await resolveDaemonNamespace(env) };
}

describe("parseCallerClaim", () => {
  it("parses a complete claimed identity, and one without a native session", () => {
    expect(parseCallerClaim(claim)).toEqual(claim);
    expect(parseCallerClaim({ workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" })).toEqual({ workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", agentSession: null });
  });

  it("refuses malformed identities before any verification is attempted", () => {
    for (const value of [
      null,
      "identity",
      { tabId: "w1:t1", paneId: "w1:p1" },
      { workspaceId: "", tabId: "w1:t1", paneId: "w1:p1" },
      { workspaceId: "w1", tabId: "w1\nt1", paneId: "w1:p1" },
      { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", agentSession: "x" },
      { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", agentSession: { ...managerSession, value: 7 } },
      { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", agentSession: { ...managerSession, kind: "" } },
    ]) {
      expect(() => parseCallerClaim(value)).toThrowError(expect.objectContaining({ daemonCode: "CALLER_IDENTITY_MALFORMED" }));
    }
  });
});

describe("verifyDaemonCaller", () => {
  it("verifies the claimed identity against exactly one fresh session.snapshot", async () => {
    const stub = cliStub();
    const caller = await verifyDaemonCaller(stub.cli, parseCallerClaim(claim), new AbortController().signal);
    // Exactly one authoritative read — no cached identity, no second pass.
    expect(stub.calls).toEqual([["api", "snapshot"]]);
    expect(caller.context).toEqual({ workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" });
    expect(caller.session).toEqual(managerSession);
    expect(caller.managerSessionKey).toBe(managerKey);
    expect(caller.snapshot.panes).toHaveLength(1);
  });

  it("refuses a claimed pane that does not exist", async () => {
    const stub = cliStub();
    await expect(verifyDaemonCaller(stub.cli, parseCallerClaim({ ...claim, paneId: "w1:p9" }), new AbortController().signal))
      .rejects.toMatchObject({ daemonCode: "CALLER_IDENTITY_UNPROVEN" });
    expect(stub.calls).toEqual([["api", "snapshot"]]);
  });

  it("refuses an ambiguous pane claim — two panes carrying the claimed pane id", async () => {
    const stub = cliStub({ snapshot: () => snapshot({ panes: [callerPane()] }) });
    await expect(verifyDaemonCaller(stub.cli, parseCallerClaim(claim), new AbortController().signal))
      .rejects.toMatchObject({ daemonCode: "CALLER_IDENTITY_UNPROVEN" });
  });

  it("refuses a claimed session the snapshot cannot prove — the pane has none", async () => {
    // A non-agent pane: no agent or agent_session keys at all, so the proven
    // native session is `null` rather than contradictory.
    const sessionless = { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", label: "manager", terminal_id: "t-mgr" };
    const produced = (): HerdrSnapshot => ({ ...snapshot(), panes: [sessionless] as HerdrSnapshot["panes"], agents: [] });
    await expect(verifyDaemonCaller({ runJson: async () => ok({ type: "session_snapshot", snapshot: produced() }) }, parseCallerClaim(claim), new AbortController().signal))
      .rejects.toMatchObject({ daemonCode: "MANAGER_SESSION_UNAVAILABLE" });
  });

  it("refuses a session the authoritative snapshot cannot uniquely bind to one pane", async () => {
    // The same complete session on a second pane is ambiguous provenance, not identity.
    const stub = cliStub({
      snapshot: () => snapshot({
        panes: [{ pane_id: "w1:p2", tab_id: "w1:t1", workspace_id: "w1", agent: "pi", terminal_id: "t-2", agent_session: managerSession }],
      }),
    });
    await expect(verifyDaemonCaller(stub.cli, parseCallerClaim(claim), new AbortController().signal))
      .rejects.toMatchObject({ daemonCode: "CALLER_IDENTITY_UNPROVEN" });
  });

  it("refuses when the claimed session differs from the proven one", async () => {
    const stub = cliStub();
    const wrong = { ...managerSession, value: "other-session" };
    await expect(verifyDaemonCaller(stub.cli, parseCallerClaim({ ...claim, agentSession: wrong }), new AbortController().signal))
      .rejects.toMatchObject({ daemonCode: "CALLER_IDENTITY_MISMATCH" });
  });

  it("refuses a claim that omits the session the pane actually carries", async () => {
    const stub = cliStub();
    await expect(verifyDaemonCaller(stub.cli, parseCallerClaim({ workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" }), new AbortController().signal))
      .rejects.toMatchObject({ daemonCode: "CALLER_IDENTITY_MISMATCH" });
  });

  it("refuses when the claimed tab or workspace is not the pane's recorded parent", async () => {
    const stub = cliStub();
    for (const mutated of [{ ...claim, tabId: "w1:t9" }, { ...claim, workspaceId: "w2" }]) {
      await expect(verifyDaemonCaller(stub.cli, parseCallerClaim(mutated), new AbortController().signal))
        .rejects.toMatchObject({ daemonCode: "CALLER_IDENTITY_MISMATCH" });
    }
  });

  it("refuses when the snapshot cannot be read at all", async () => {
    const stub = cliStub({ error: Object.assign(new Error("backend down"), { code: "BACKEND_UNAVAILABLE" }) });
    await expect(verifyDaemonCaller(stub.cli, parseCallerClaim(claim), new AbortController().signal))
      .rejects.toMatchObject({ daemonCode: "BACKEND_UNAVAILABLE" });
    const opaque = cliStub({ error: new Error("socket gone") });
    await expect(verifyDaemonCaller(opaque.cli, parseCallerClaim(claim), new AbortController().signal))
      .rejects.toMatchObject({ daemonCode: "SNAPSHOT_UNAVAILABLE" });
  });
});

describe("daemonContextResolver", () => {
  it("takes a fresh snapshot per call and re-asserts the verified topology", async () => {
    const stub = cliStub();
    const caller = await verifyDaemonCaller(stub.cli, parseCallerClaim(claim), new AbortController().signal);
    const resolver = daemonContextResolver(stub.cli, caller);
    const first = await resolver(new AbortController().signal);
    const second = await resolver(new AbortController().signal);
    expect(stub.calls).toEqual([["api", "snapshot"], ["api", "snapshot"], ["api", "snapshot"]]);
    expect(first.context).toEqual(caller.context);
    expect(second.snapshot.panes).toHaveLength(1);
  });

  it("fails closed when the verified pane moved tabs or vanished after the request", async () => {
    let produced = snapshot();
    const cli: DaemonCli = { runJson: async () => ok({ type: "session_snapshot", snapshot: produced }) };
    const caller = await verifyDaemonCaller(cli, parseCallerClaim(claim), new AbortController().signal);
    const resolver = daemonContextResolver(cli, caller);
    produced = snapshot({ panes: [] });
    produced = { ...produced, panes: [callerPane({ tab_id: "w1:t9" })] as HerdrSnapshot["panes"] };
    await expect(resolver(new AbortController().signal)).rejects.toBeInstanceOf(ContextResolutionError);
    produced = { ...snapshot(), panes: [] };
    await expect(resolver(new AbortController().signal)).rejects.toBeInstanceOf(ContextResolutionError);
  });
});

describe("daemonEffectiveContext", () => {
  it("projects the verified caller as a read-only effective context", async () => {
    const stub = cliStub();
    const caller = await verifyDaemonCaller(stub.cli, parseCallerClaim(claim), new AbortController().signal);
    const effective = daemonEffectiveContext(caller);
    expect(effective.context).toEqual(caller.context);
    expect(effective.snapshot).toBe(caller.snapshot);
    expect(effective.diagnostics.rebound).toBe(false);
  });
});

describe("daemonRequestError", () => {
  it("carries the typed code of the cause, the fallback otherwise, and never wraps twice", () => {
    expect(daemonRequestError(Object.assign(new Error("x"), { code: "HANDOFF_CHILD_UNBOUND" })).daemonCode).toBe("HANDOFF_CHILD_UNBOUND");
    expect(daemonRequestError(new Error("x")).daemonCode).toBe("DAEMON_REQUEST_FAILED");
    expect(daemonRequestError(new Error("x"), "LAUNCH_FAILED").daemonCode).toBe("LAUNCH_FAILED");
    // A non-record cause and an uncodeable cause both take the fallback code.
    expect(daemonRequestError("raw string").daemonCode).toBe("DAEMON_REQUEST_FAILED");
    expect(daemonRequestError({ code: "lowercase" }).daemonCode).toBe("DAEMON_REQUEST_FAILED");
    const typed = new DaemonRequestError("INTENT_NOT_FOUND");
    expect(daemonRequestError(typed)).toBe(typed);
  });
});

describe("createSharedRuntime", () => {
  it("builds the one shared assembly and lets the host wire its own jobs and notifier", async () => {
    const stub = execStub();
    const jobs = new JobRegistry();
    const notifier = { wake: () => undefined };
    let wired: unknown;
    const runtime = createSharedRuntime({
      exec: stub.exec,
      env: {},
      wire: (parts) => {
        wired = parts;
        return { jobs, notifier };
      },
    });
    expect(wired).toMatchObject({ cli: runtime.cli, queueFlush: runtime.queueFlush });
    expect(runtime.jobs).toBe(jobs);
    expect(runtime.supervision).toBeInstanceOf(SupervisionRegistry);
    expect(runtime.ownership).toBeInstanceOf(RuntimeOwnership);
    expect(runtime.recipients).toBeInstanceOf(RecipientRegistry);
    expect(typeof runtime.handoffs.bind).toBe("function");
    expect(typeof runtime.queueFlush.writeSection).toBe("function");
    await runtime.supervision.shutdown();
    runtime.jobs.shutdown();
    await runtime.queueFlush.shutdown();
  });

  it("constructs a default job registry when the host wires nothing", async () => {
    const stub = execStub();
    const runtime = createSharedRuntime({ exec: stub.exec, env: {} });
    expect(runtime.jobs).toBeInstanceOf(JobRegistry);
    await runtime.supervision.shutdown();
    runtime.jobs.shutdown();
    await runtime.queueFlush.shutdown();
  });
});

describe("createDaemonRuntime", () => {
  it("layers the durable intent store, allocator, launch seams, and in-flight ledger on the shared assembly", async () => {
    const { env, namespace: ns } = await namespace();
    const stub = execStub();
    const intents = createIntentStore({ namespace: ns });
    const allocator = createHandoffAllocator({ namespace: { dir: join(ns.dir, "runs"), endpoint: "test" } });
    const launchDeps = { preflight: async () => undefined };
    const runtime = createDaemonRuntime({ exec: stub.exec, env, namespace: ns, intents, allocator, launchDeps });
    runtimes.push(runtime);
    expect(runtime.namespace).toBe(ns);
    expect(runtime.intents).toBe(intents);
    expect(runtime.allocator).toBe(allocator);
    expect(runtime.launchDeps).toBe(launchDeps);
    expect(runtime.inflight.size).toBe(0);
  });
});

describe("createDaemonRuntime defaults", () => {
  it("mints its own durable stores when the caller wires no env, intents, or allocator", async () => {
    const { namespace: ns } = await namespace();
    const stub = execStub();
    const runtime = createDaemonRuntime({ exec: stub.exec, namespace: ns });
    runtimes.push(runtime);
    expect(runtime.intents).toBeDefined();
    expect(runtime.allocator).toBeDefined();
    expect(runtime.namespace).toBe(ns);
  });
});

describe("daemonDispatcher", () => {
  it("routes launch, run, and status to the handlers and refuses unknown methods", async () => {
    const { env, namespace: ns } = await namespace();
    const stub = execStub();
    const runtime = createDaemonRuntime({ exec: stub.exec, env, namespace: ns });
    runtimes.push(runtime);
    const dispatch = daemonDispatcher(runtime);
    const request = (method: string, params: Record<string, unknown>) => dispatch({ id: "r", method, params });
    // Each routed method fails inside its own handler — proving the route —
    // because the missing claimed identity is malformed before anything else.
    for (const method of ["launch", "status"]) {
      await expect(request(method, {})).rejects.toMatchObject({ daemonCode: "CALLER_IDENTITY_MALFORMED" });
    }
    await expect(request("run", { action: "observe" })).rejects.toMatchObject({ daemonCode: "CALLER_IDENTITY_MALFORMED" });
    expect(() => request("restart", {})).toThrowError(expect.objectContaining({ daemonCode: "DAEMON_UNKNOWN_METHOD" }));
  });
});

describe("createRuntime (Pi host)", () => {
  it("accepts host-injected prompt client, attachments, and recipients onto the shared assembly", async () => {
    const stub = execStub();
    const recipients = new RecipientRegistry();
    const runtime = createRuntime(
      { exec: stub.exec },
      {},
      {
        promptClient: { prompt: async () => ok({}), ping: async () => undefined },
        attachments: { root: "/tmp", recipientDirectory: (key: string) => `/tmp/${key}`, ensureRecipient: async () => { throw new Error("unused"); }, publish: async () => { throw new Error("unused"); } },
        recipients,
      },
    );
    expect(runtime.recipients).toBe(recipients);
    await runtime.supervision.shutdown();
    runtime.jobs.shutdown();
    await runtime.queueFlush.shutdown();
  });
});

const intentTask: LaunchTask = { objective: "Reduce the latency.", scope: "The assigned worktree.", doneWhen: ["The objective is verified."] };
const intentBegin = (overrides: Record<string, unknown> = {}) => ({ managerSessionKey: managerKey, idempotencyKey: "k1", task: intentTask, projectRoot: "/project", ...overrides });

async function intentFx(): Promise<{ ns: DaemonNamespace; store: IntentStore; intentsRoot: string; managerDir: string }> {
  const { namespace: ns } = await namespace();
  const store = createIntentStore({ namespace: ns });
  const intentsRoot = join(ns.dir, DAEMON_INTENTS_DIR_NAME);
  return { ns, store, intentsRoot, managerDir: join(intentsRoot, managerKey) };
}

async function begunIntent(store: IntentStore, overrides: Record<string, unknown> = {}): Promise<LaunchIntentRecord> {
  const begun = await store.begin(intentBegin(overrides));
  if (begun.kind !== "launch") throw new Error("expected a launch verdict");
  return begun.intent;
}

describe("daemon intent store — the durable ledger the runtime owns", () => {
  it("rejects malformed manager sessions, keys, tasks, outcomes, and dispositions", async () => {
    const { store } = await intentFx();
    for (const field of ["source", "agent", "kind", "value"] as const) {
      expect(() => managerSessionKey({ ...managerSession, [field]: "" }))
        .toThrowError(expect.objectContaining({ code: "INTENT_REQUEST_INVALID" }));
    }
    await expect(store.begin(intentBegin({ task: { objective: "x" } }))).rejects.toMatchObject({ code: "INTENT_REQUEST_INVALID" });
    await expect(store.begin(intentBegin({ idempotencyKey: "has space" }))).rejects.toMatchObject({ code: "INTENT_REQUEST_INVALID" });
    await expect(store.begin(intentBegin({ projectRoot: "has\0nul" }))).rejects.toMatchObject({ code: "INTENT_REQUEST_INVALID" });
    await expect(store.begin(intentBegin({ managerSessionKey: "not-hex" }))).rejects.toMatchObject({ code: "INTENT_REQUEST_INVALID" });

    const intent = await begunIntent(store);
    const effecting = await store.markEffecting(intent);
    // Outcome validation throws synchronously — wrap in an async fn to assert uniformly.
    await expect(async () => store.fail(effecting, { effectCertainty: "bogus" as never })).rejects.toMatchObject({ code: "INTENT_REQUEST_INVALID" });
    await expect(async () => store.fail(effecting, { effectCertainty: "absent", failureCode: "lowercase" })).rejects.toMatchObject({ code: "INTENT_REQUEST_INVALID" });
    await expect(async () => store.fail(effecting, { effectCertainty: "absent", children: [{ name: 7 } as never] })).rejects.toMatchObject({ code: "INTENT_REQUEST_INVALID" });
    await expect(async () => store.reconcile(effecting, [{ name: "x" }])).rejects.toMatchObject({ code: "INTENT_REQUEST_INVALID" });
    await expect(async () => store.recordChildren(effecting, [{ name: 7 } as never])).rejects.toMatchObject({ code: "INTENT_REQUEST_INVALID" });
    await expect(async () => store.complete(effecting, [{ name: 7 } as never])).rejects.toMatchObject({ code: "INTENT_REQUEST_INVALID" });
  });

  it("arbitrates transitions against the record's current state under the lock", async () => {
    const { store } = await intentFx();
    // A record whose manager directory never existed is `absent`, never creatable by a transition.
    const ghost = { managerSessionKey: "f".repeat(64), idempotencyKey: "k", launchId: "l", projectRoot: "/p", state: "recorded", children: [], recordedAt: "t", updatedAt: "t", v: 1, taskDigest: "a".repeat(64) } as LaunchIntentRecord;
    await expect(store.markEffecting(ghost)).rejects.toMatchObject({ code: "INTENT_STATE_CONFLICT" });

    const intent = await begunIntent(store);
    const completed = await store.complete(await store.markEffecting(intent), []);
    await expect(store.markEffecting(completed)).rejects.toMatchObject({ code: "INTENT_STATE_CONFLICT" });
    // A stale launchId is a moved record — the transition refuses under the same conflict.
    await expect(store.markEffecting({ ...intent, launchId: "different-launch" })).rejects.toMatchObject({ code: "INTENT_STATE_CONFLICT" });
    // A manager directory that exists but holds no record for the key is `absent` under the lock.
    await expect(store.markEffecting({ ...intent, idempotencyKey: "absent-key" })).rejects.toMatchObject({ code: "INTENT_STATE_CONFLICT" });
  });

  it("recovers nothing for a manager key with no directory", async () => {
    const { store } = await intentFx();
    await begunIntent(store);
    await expect(store.recoverInterrupted("0".repeat(64))).resolves.toEqual([]);
  });

  it("returns empty for absent manager keys and skips non-.json and non-key entries", async () => {
    const { store, managerDir, intentsRoot } = await intentFx();
    await expect(store.get("0".repeat(64), "k")).resolves.toBeUndefined();
    await expect(store.list("0".repeat(64))).resolves.toEqual([]);

    await begunIntent(store);
    // A stray non-record file in the manager directory is ignored by list.
    await writeFile(join(managerDir, "note.txt"), "x", { mode: 0o600 });
    await expect(store.list(managerKey)).resolves.toHaveLength(1);
    // A non-key-named directory in the intents root is not a manager.
    await mkdir(join(intentsRoot, "not-a-key"), { mode: 0o700 });
    expect(await store.listManagers()).toEqual([managerKey]);
    // A key-named file that is not a directory fails closed, not silently skipped.
    await writeFile(join(intentsRoot, "e".repeat(64)), "x", { mode: 0o600 });
    await expect(store.listManagers()).rejects.toMatchObject({ code: expect.any(String) });
  });

  it("fails closed on corrupt, untrusted, or misfiled intent records", async () => {
    const { store, managerDir } = await intentFx();
    const path = (key: string) => join(managerDir, `${key}.json`);

    // Unparseable JSON is malformed, never a default record.
    await begunIntent(store);
    await writeFile(path("k1"), "{not json", { mode: 0o600 });
    await expect(store.get(managerKey, "k1")).rejects.toMatchObject({ code: "INTENT_MALFORMED" });

    // A non-record payload is malformed.
    await writeFile(path("k1"), JSON.stringify(["array"]), { mode: 0o600 });
    await expect(store.get(managerKey, "k1")).rejects.toMatchObject({ code: "INTENT_MALFORMED" });

    // Field-level violations each refuse: a bad child shape, wrong-version,
    // and each optional-field enum.
    await begunIntent(store, { idempotencyKey: "k2" });
    // Each mutation lands on the pristine record — a stale mutation left in
    // place would short-circuit the validator before the field under test.
    const pristine = await readFile(path("k2"), "utf8");
    const rewrite = async (mutate: (record: Record<string, unknown>) => void): Promise<void> => {
      const record = JSON.parse(pristine) as Record<string, unknown>;
      mutate(record);
      await writeFile(path("k2"), JSON.stringify(record), { mode: 0o600 });
    };
    for (const mutate of [
      (r: Record<string, unknown>) => { r.v = 2; },
      (r: Record<string, unknown>) => { r.v = "1"; },
      (r: Record<string, unknown>) => { delete r.v; },
      (r: Record<string, unknown>) => { r.children = "not-an-array"; },
      (r: Record<string, unknown>) => { r.children = [7]; },
      (r: Record<string, unknown>) => { r.children = [{ name: 7 }]; },
      (r: Record<string, unknown>) => { r.children = [{ name: "" }]; },
      (r: Record<string, unknown>) => { r.children = [{ name: "bad\0name" }]; },
      (r: Record<string, unknown>) => { r.children = [{ name: "x", runId: 9 }]; },
      (r: Record<string, unknown>) => { r.children = [{ name: "x", runId: "bad\0id" }]; },
      (r: Record<string, unknown>) => { r.children = [{ name: "x", disposition: 7 }]; },
      (r: Record<string, unknown>) => { r.children = [{ name: "x", disposition: "made-up" }]; },
      (r: Record<string, unknown>) => { r.managerSessionKey = 7; },
      (r: Record<string, unknown>) => { r.managerSessionKey = "z".repeat(64); },
      (r: Record<string, unknown>) => { r.idempotencyKey = 7; },
      (r: Record<string, unknown>) => { r.idempotencyKey = "x".repeat(200); },
      (r: Record<string, unknown>) => { r.idempotencyKey = "bad key"; },
      (r: Record<string, unknown>) => { r.taskDigest = 7; },
      (r: Record<string, unknown>) => { r.taskDigest = "z".repeat(64); },
      (r: Record<string, unknown>) => { r.launchId = 7; },
      (r: Record<string, unknown>) => { r.launchId = ""; },
      (r: Record<string, unknown>) => { r.launchId = "bad\0id"; },
      (r: Record<string, unknown>) => { r.projectRoot = 7; },
      (r: Record<string, unknown>) => { r.projectRoot = ""; },
      (r: Record<string, unknown>) => { r.projectRoot = "bad\0root"; },
      (r: Record<string, unknown>) => { r.state = 7; },
      (r: Record<string, unknown>) => { r.recordedAt = ""; },
      (r: Record<string, unknown>) => { r.recordedAt = 7; },
      (r: Record<string, unknown>) => { r.updatedAt = ""; },
      (r: Record<string, unknown>) => { r.updatedAt = 7; },
      (r: Record<string, unknown>) => { r.effectCertainty = "maybe"; },
      (r: Record<string, unknown>) => { r.effectCertainty = 7; },
      (r: Record<string, unknown>) => { r.failureCode = "lowercase"; },
      (r: Record<string, unknown>) => { r.failureCode = 7; },
      (r: Record<string, unknown>) => { r.resolution = "guessed"; },
      (r: Record<string, unknown>) => { r.resolution = 7; },
      (r: Record<string, unknown>) => { r.reconciled = false; },
      (r: Record<string, unknown>) => { r.state = "dreaming"; },
    ]) {
      await rewrite(mutate);
      await expect(store.get(managerKey, "k2")).rejects.toMatchObject({ code: "INTENT_MALFORMED" });
    }

    // A record whose own binding fields disagree with its file location is malformed.
    await rewrite((r) => { r.idempotencyKey = "other-key"; });
    await expect(store.get(managerKey, "k2")).rejects.toMatchObject({ code: "INTENT_MALFORMED" });
    await rewrite((r) => { r.managerSessionKey = "b".repeat(64); });
    await expect(store.get(managerKey, "k2")).rejects.toMatchObject({ code: "INTENT_MALFORMED" });

    // A group-writable record file is untrusted — never read.
    await begunIntent(store, { idempotencyKey: "k3" });
    await chmod(path("k3"), 0o664);
    await expect(store.get(managerKey, "k3")).rejects.toMatchObject({ code: expect.any(String) });
  });

  it("fails closed when the namespace or the intents root cannot be established", async () => {
    // A namespace that rejects resolves nothing — and the failure is not cached.
    const rejecting = createIntentStore({ namespace: () => Promise.reject(new Error("gone")) });
    await expect(rejecting.list(managerKey)).rejects.toMatchObject({ code: expect.any(String) });

    // A typed refusal out of the namespace resolution rethrows untouched.
    const typedRejecting = createIntentStore({ namespace: () => Promise.reject(new DaemonIntentError("INTENT_STORE_UNAVAILABLE", "typed")) });
    await expect(typedRejecting.list(managerKey)).rejects.toMatchObject({ code: "INTENT_STORE_UNAVAILABLE" });

    // A namespace whose directory does not exist is unavailable at the first stat.
    const { ns } = await intentFx();
    const missing = createIntentStore({ namespace: { dir: join(ns.dir, "missing"), endpoint: ns.endpoint } });
    await expect(missing.list(managerKey)).rejects.toMatchObject({ code: expect.any(String) });

    // A group/world-writable namespace directory is untrusted — the typed refusal rethrows.
    const untrusted = await intentFx();
    await chmod(untrusted.ns.dir, 0o777);
    try {
      await expect(untrusted.store.list(managerKey)).rejects.toMatchObject({ code: expect.any(String) });
    } finally {
      await chmod(untrusted.ns.dir, 0o700);
    }

    // A namespace directory that cannot be written cannot mint the intents root.
    const unwritable = await intentFx();
    await chmod(unwritable.ns.dir, 0o500);
    try {
      await expect(unwritable.store.list(managerKey)).rejects.toMatchObject({ code: expect.any(String) });
    } finally {
      await chmod(unwritable.ns.dir, 0o700);
    }

    // A regular file where the intents root belongs is refused, not removed.
    const fileFx = await intentFx();
    await writeFile(fileFx.intentsRoot, "x", { mode: 0o600 });
    await expect(fileFx.store.list(managerKey)).rejects.toMatchObject({ code: expect.any(String) });
  });

  it("fails closed when a manager directory cannot be created or read", async () => {
    const { store, intentsRoot } = await intentFx();
    // The intents root itself is owner-only; make it unwritable and unreadable.
    await begunIntent(store);
    await chmod(intentsRoot, 0o000);
    try {
      // Creating a new manager directory beneath it fails with a foreign errno.
      const otherKey = managerSessionKey({ source: "herdr:pi", agent: "pi", kind: "id", value: "other" });
      await expect(store.begin(intentBegin({ managerSessionKey: otherKey }))).rejects.toMatchObject({ code: expect.any(String) });
      // Reading an existing manager directory beneath it fails the same way.
      await expect(store.get(managerKey, "k1")).rejects.toMatchObject({ code: expect.any(String) });
    } finally {
      await chmod(intentsRoot, 0o700);
    }
  });
});

describe("daemon mailbox binding", () => {
  it("requireDaemonMailbox refuses while the mailbox is unbound", () => {
    expect(() => requireDaemonMailbox({ mailbox: undefined } as unknown as DaemonRuntime)).toThrowError(/not bound/);
  });

  it("createSharedRuntime defaults the env seam to process.env and accepts wired notifier/selfClose/hints", async () => {
    const stub = execStub();
    const runtime = createSharedRuntime({ exec: stub.exec, wire: () => ({
      notifier: { wake: () => undefined },
      selfClose: { begin: () => () => undefined, consume: () => false, onPaneClosed: () => () => undefined, clear: () => undefined },
      hints: () => undefined,
    }) });
    expect(runtime.jobs).toBeInstanceOf(JobRegistry);
    expect(runtime.supervision).toBeInstanceOf(SupervisionRegistry);
    await runtime.supervision.shutdown();
    runtime.jobs.shutdown();
    await runtime.queueFlush.shutdown();
  });
});
