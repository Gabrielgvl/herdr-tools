/**
 * N4.3 — ownership transfer/claim canary (durable-supervisor §8).
 *
 * Fixture shape copied from the N4.1 canary: the daemon under test runs as a
 * plain child of this test with `HERDR_SOCKET_PATH` pointed at a recording
 * proxy inside the disposable cwd, so the endpoint namespace (`transfers/`,
 * `claims/`, `mailbox/`), the handoff runs, and every daemon-issued
 * `agent.prompt` are test-readable. Owner, successors, and children are real
 * Pi panes: `verifyDaemonCaller` refuses a shell occupant and the successor
 * proof needs a complete `agent_session` of a supported kind.
 *
 * One deliberate deviation from N4.1, stated rather than absorbed: the daemon
 * entry is a test-generated replica of `src/daemon/main.ts`'s invoked block
 * (the same wiring the N4.2 disposable fixture uses) with `hintKinds:["pi"]`.
 * `retargetHintDestinations` only rewrites each bound supervisor's in-memory
 * hint owner; the stock entry now ships the C9-proved {pi, claude, devin} set
 * (N5.2), but the replica keeps the canary pinned to an explicit Pi-only set
 * either way. With Pi qualified, the first run event after the transfer must
 * hint the SUCCESSOR pane, never the still-live prior owner — a
 * discriminating proof.
 *
 * Crash windows are widened deterministically with mailbox files, never
 * sleeps: each journaled move is a rename plus two directory fsyncs on the
 * host filesystem, so a few hundred unread files hold the window open for
 * seconds while the test polls the journal directory at 5 ms.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { resolveManagerSession } from "../../src/context.js";
import { parseSnapshotResult } from "../../src/targets.js";
import { connectDaemonClient, DaemonCallError, type DaemonClient } from "../../src/daemon/client.js";
import { managerSessionKey } from "../../src/daemon/intents.js";
import { mailboxEventId, MAILBOX_UNREAD_MAX_FILES } from "../../src/daemon/mailbox.js";
import { DAEMON_NAMESPACE_DIR_NAME } from "../../src/daemon/namespace.js";
import type { ClaimRecord, TransferRecord } from "../../src/daemon/ownership.js";
import { HANDOFF_PROVENANCE_NAME, HANDOFF_STATE_DIR_NAME, HANDOFF_TOOLS_DIR_NAME } from "../../src/handoff.js";
import type { AgentSessionIdentity } from "../../src/messages/prompt.js";
import { createDisposableGitWorkspace, startDisposableSocketProxy, stopDisposableServer, waitForCondition } from "./disposable-session.js";

const execFileAsync = promisify(execFile);
const REQUIRED_SESSION = process.env.HERDR_TOOLS_INTEGRATION_SESSION ?? "herdr-tools-integration";
const enabled = process.env.HERDR_TOOLS_RUN_INTEGRATION === "1";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Pi at the utility tier is the cheapest leg that still satisfies `verifyDaemonCaller`. */
const CHILD_TIER = "utility" as const;
const CHILD_OBJECTIVE = "Reply with the single word READY and then stop. Do not run any tool.";
/**
 * Unread files planted to hold the crash windows open. The count keeps every
 * mailbox under the §7 per-mailbox cap after both journaled moves, so the
 * recorded `transfer` events persist instead of deferring as TRANSFER_PENDING.
 */
const WINDOW_FILES = 400;
/** Poll cadence for the journal directories while a change is in flight. */
const WINDOW_POLL_MS = 5;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("integration response is not an object");
  return value as Record<string, unknown>;
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return record(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
}

const stripJson = (name: string) => name.slice(0, -".json".length);

/** The daemon's wire refusal code, or the transport code when the socket dropped. */
async function refusal(call: Promise<unknown>): Promise<string> {
  try {
    const reply = await call;
    throw new Error(`call succeeded instead of refusing: ${JSON.stringify(reply)}`);
  } catch (error) {
    if (error instanceof DaemonCallError) return error.code;
    throw error;
  }
}

/**
 * The daemon entry: production wiring verbatim (`src/daemon/main.ts` invoked
 * block) built against the emitted `dist/`, with the qualified hint-kind set
 * taken from `HERDR_TOOLS_DISPOSABLE_HINT_KINDS` — the same fixture shape the
 * N4.2 hint canary uses. Written into the disposable cwd, never the repo.
 */
function disposableDaemonEntry(): string {
  const dist = (path: string) => JSON.stringify(pathToFileURL(join(repoRoot, "dist/src", path)).href);
  return `import { createNodeExec } from ${dist("mcp/host.js")};
import { resolveHandoffNamespace } from ${dist("handoff.js")};
import { parseSnapshotResult } from ${dist("targets.js")};
import { runDaemonMain } from ${dist("daemon/main.js")};
import { resolveDaemonNamespace } from ${dist("daemon/namespace.js")};
import { daemonRunOwnership, reattachDaemonRuns } from ${dist("daemon/reattach.js")};
import { createDaemonRuntime, daemonDispatcher } from ${dist("daemon/runtime.js")};
resolveDaemonNamespace(process.env).then(async (namespace) => {
  const env = process.env;
  const runtime = createDaemonRuntime({
    exec: createNodeExec({ cwd: process.cwd() }), env, namespace,
    hintKinds: (env.HERDR_TOOLS_DISPOSABLE_HINT_KINDS ?? "").split(",").map((kind) => kind.trim()).filter((kind) => kind.length > 0),
  });
  const runs = await resolveHandoffNamespace(env);
  const signal = new AbortController().signal;
  return runDaemonMain({
    namespace,
    handler: daemonDispatcher(runtime),
    ownership: daemonRunOwnership(runtime.allocator),
    reattach: ({ mailbox, startedAt, lastHeartbeat }) => {
      runtime.bindMailbox(mailbox);
      return reattachDaemonRuns({
        namespace, runs, allocator: runtime.allocator, intents: runtime.intents, supervision: runtime.supervision, jobs: runtime.jobs, mailbox,
        snapshot: async () => parseSnapshotResult((await runtime.cli.runJson(["api", "snapshot"], signal)).result),
        startedAt, lastHeartbeat, log: (line) => process.stderr.write(line + "\\n"),
      });
    },
    seams: { flushHandoffs: async () => undefined, stopSupervisors: () => runtime.supervision.shutdown() },
  });
}).then((code) => { process.exitCode = code; }, () => { process.exitCode = 1; });
`;
}

describe.skipIf(!enabled)("disposable daemon ownership transfer/claim canary (N4.3)", () => {
  it("transfers the whole unread set live, vetoes on an unsettled intent, gates claims on the exact owner record, and completes a killed journal exactly once", async () => {
    expect(process.env.HERDR_TOOLS_INTEGRATION_SESSION ?? REQUIRED_SESSION).toBe(REQUIRED_SESSION);
    expect(process.env.HERDR_ENV).toBe("1");
    expect([process.env.HERDR_WORKSPACE_ID, process.env.HERDR_TAB_ID, process.env.HERDR_PANE_ID].every(Boolean)).toBe(true);

    let workspaceId: string | undefined;
    let sessionStarted = false;
    let server: ChildProcess | undefined;
    let daemon: ChildProcess | undefined;
    const clients = new Set<DaemonClient>();
    let proxy: Awaited<ReturnType<typeof startDisposableSocketProxy>> | undefined;
    let failure: unknown;
    const cwd = await realpath(await createDisposableGitWorkspace("herdr-ownership-it-"));
    const label = `ownership-herdr-tools-it-${process.pid}`;
    const sessionSocket = `/home/gabriel/.config/herdr/sessions/${REQUIRED_SESSION}/herdr.sock`;
    const proxySocket = join(cwd, "herdr.sock");
    const daemonEntry = join(cwd, "daemon-disposable.mjs");
    const namespaceDir = join(cwd, DAEMON_NAMESPACE_DIR_NAME);
    const runsDir = join(cwd, HANDOFF_STATE_DIR_NAME);
    const transfersDir = join(namespaceDir, "transfers");
    const claimsDir = join(namespaceDir, "claims");
    const daemonLog: string[] = [];

    const run = async (...args: string[]): Promise<unknown> => {
      const result = await execFileAsync("herdr", args, { cwd, maxBuffer: 4_000_000 });
      return JSON.parse(result.stdout);
    };
    const runNamed = (args: string[]) => run("--session", REQUIRED_SESSION, ...args);
    const snapshot = async () => {
      const value = record(record(record(await runNamed(["api", "snapshot"])).result).snapshot);
      return { ...value, panes: (Array.isArray(value.panes) ? value.panes : []).map(record) };
    };
    const paneStatus = async (paneId: string): Promise<string | undefined> => {
      const pane = (await snapshot()).panes.find((candidate) => candidate.pane_id === paneId);
      return pane === undefined ? undefined : String(pane.agent_status ?? "");
    };
    const closePane = async (paneId: string): Promise<void> => {
      await runNamed(["pane", "close", paneId]);
      const gone = await waitForCondition(async () => (await snapshot()).panes.some((pane) => pane.pane_id === paneId), (present) => !present, 15_000);
      if (gone === undefined) throw new Error(`pane ${paneId} remained in the snapshot after close`);
    };

    interface Agent { paneId: string; tabId: string; session: AgentSessionIdentity; key: string }
    /** Split a fresh pane off the workspace root and start a real idle Pi agent in it. */
    const startPiPane = async (rootPaneId: string, name: string): Promise<Agent> => {
      const before = new Set((await snapshot()).panes.map((pane) => String(pane.pane_id)));
      await runNamed(["pane", "split", rootPaneId, "--direction", "right", "--no-focus", "--cwd", cwd]);
      const pane = (await snapshot()).panes.find((candidate) => candidate.workspace_id === workspaceId && !before.has(String(candidate.pane_id)));
      if (pane === undefined) throw new Error(`split pane for ${name} missing from the snapshot`);
      const paneId = String(pane.pane_id);
      await runNamed(["agent", "start", name, "--kind", "pi", "--pane", paneId, "--timeout", "120000"]);
      const idle = await waitForCondition(() => paneStatus(paneId), (status) => status === "idle", 120_000, 250);
      if (idle === undefined) throw new Error(`${name} Pi pane never reported idle`);
      const session = resolveManagerSession(parseSnapshotResult(record(await runNamed(["api", "snapshot"])).result), paneId);
      if (session === null) throw new Error(`${name} pane carries no native agent session`);
      return { paneId, tabId: String(pane.tab_id), session, key: managerSessionKey(session) };
    };

    /** Spawn the disposable daemon entry and wait for its readiness line — the D4 sweep has run. */
    const startDaemon = async (): Promise<ChildProcess> => {
      const child = spawn(process.execPath, [daemonEntry], {
        cwd,
        env: {
          ...process.env,
          HERDR_ENV: "1",
          HERDR_SOCKET_PATH: proxySocket,
          HERDR_WORKSPACE_ID: workspaceId!,
          HERDR_TAB_ID: owner.tabId,
          HERDR_PANE_ID: owner.paneId,
          HERDR_PROJECT_DIR: cwd,
          HERDR_TOOLS_DISPOSABLE_HINT_KINDS: "pi",
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let listening = false;
      child.stderr?.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n")) {
          if (line.length === 0) continue;
          daemonLog.push(`[pid ${child.pid}] ${line}`);
          if (line.includes("herdr-tools-daemon listening on")) listening = true;
        }
      });
      const ready = await waitForCondition(async () => listening || child.exitCode !== null, (done) => done, 60_000);
      if (ready === undefined || !listening) throw new Error(`daemon did not become ready: ${daemonLog.slice(-10).join(" | ")}`);
      return child;
    };
    const sigkillDaemon = async (): Promise<void> => {
      const target = daemon!;
      await new Promise<void>((settle) => {
        target.once("exit", () => settle());
        target.kill("SIGKILL");
      });
      for (const client of clients) client.close();
      clients.clear();
    };
    const connect = async (agent: Agent): Promise<DaemonClient> => {
      const client = await connectDaemonClient(
        { dir: namespaceDir, endpoint: await realpath(proxySocket) },
        { identity: { workspaceId: workspaceId!, tabId: agent.tabId, paneId: agent.paneId, agentSession: agent.session }, projectRoot: cwd },
        { requestTimeoutMs: 600_000 },
      );
      clients.add(client);
      return client;
    };

    const unreadDir = (key: string) => join(namespaceDir, "mailbox", key, "unread");
    const ackedDir = (key: string) => join(namespaceDir, "mailbox", key, "acked");
    const unread = (key: string) => listJsonFiles(unreadDir(key));
    const readUnread = async (key: string, name: string) => record(JSON.parse(await readFile(join(unreadDir(key), name), "utf8")));
    /** Every event body under `unread/` and `acked/` of one mailbox. */
    const allEvents = async (key: string) => {
      const bodies: Record<string, unknown>[] = [];
      for (const dir of [unreadDir(key), ackedDir(key)]) {
        for (const name of await listJsonFiles(dir)) bodies.push(record(JSON.parse(await readFile(join(dir, name), "utf8"))));
      }
      return bodies;
    };
    const provenanceOf = async (runId: string) => record(await readJson(join(runsDir, runId, HANDOFF_TOOLS_DIR_NAME, HANDOFF_PROVENANCE_NAME)));
    const ownersOf = async (runId: string) => {
      const provenance = await provenanceOf(runId);
      return (Array.isArray(provenance.owners) ? provenance.owners : []).map(record);
    };
    const intentPath = (key: string, idempotencyKey: string) => join(namespaceDir, "intents", key, `${idempotencyKey}.json`);
    const pendingTransferIds = async () => (await listJsonFiles(transfersDir)).map(stripJson);
    const donePath = (transferId: string) => join(transfersDir, "done", `${transferId}.json`);
    const readTransfer = async (path: string) => record(await readJson(path)) as unknown as TransferRecord;
    const writeClaim = async (incidentId: string, claim: ClaimRecord): Promise<void> => {
      await mkdir(claimsDir, { mode: 0o700, recursive: true });
      await chmod(claimsDir, 0o700);
      const path = join(claimsDir, `${incidentId}.json`);
      await writeFile(path, JSON.stringify(claim), { mode: 0o600 });
      await chmod(path, 0o600);
    };
    /**
     * Plant well-formed run-scoped events straight into a mailbox's `unread/`
     * (owner-only mode, as the daemon writes them). They are inert payload
     * whose only job is to make the journaled move take measurable time.
     */
    const plantWindowFiles = async (key: string, runId: string, count: number): Promise<string[]> => {
      const names: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const id = mailboxEventId(new Date());
        const body = { id, at: new Date().toISOString(), kind: "canary_window", runId, jobId: `window-${index}`, actions: [] };
        await writeFile(join(unreadDir(key), `${id}.json`), JSON.stringify(body), { mode: 0o600 });
        names.push(`${id}.json`);
      }
      return names;
    };
    /** Launch one child under `agent` and return its run ID once the intent completes. */
    const launchChild = async (client: DaemonClient, agent: Agent, key: string): Promise<{ runId: string; paneId: string }> => {
      const reply = await client.launch({ idempotencyKey: key, task: { objective: CHILD_OBJECTIVE, scope: "Only this pane. Change no files.", doneWhen: ["The reply was sent."], tier: CHILD_TIER } });
      expect(reply.state).toBe("completed");
      const intent = record(await readJson(intentPath(agent.key, key)));
      const child = record((intent.children as unknown[])[0]);
      const runId = String(child.runId);
      const state = record(await readJson(join(runsDir, runId, HANDOFF_TOOLS_DIR_NAME, "state.json")));
      const paneId = String(record(state.child).paneId);
      process.stderr.write(`N43_ROUTE key=${key} runId=${runId} agentKind=${String(record(state.child).agentKind)} operatingPointId=${String(record(state.child).operatingPointId)}\n`);
      return { runId, paneId };
    };
    /**
     * Start `change` and SIGKILL the daemon the moment `window()` reports the
     * journal step under test has landed, then verify the kill preceded
     * `transfers/done/`. Returns the frozen record read back from the journal.
     */
    const killInsideWindow = async (change: Promise<unknown>, window: () => Promise<string | undefined>): Promise<TransferRecord> => {
      const settled = change.then((reply) => ({ reply }), (error: unknown) => ({ error }));
      const transferId = await waitForCondition(window, (id) => id !== undefined, 120_000, WINDOW_POLL_MS);
      if (transferId === undefined) throw new Error(`journal record never appeared: ${JSON.stringify(await settled)}`);
      await sigkillDaemon();
      const outcome = await settled;
      // The kill landed inside the window: the plan is frozen, completion is not.
      expect(await exists(donePath(transferId)), `transfer ${transferId} completed before the kill; window missed`).toBe(false);
      expect("error" in outcome && outcome.error instanceof DaemonCallError && outcome.error.code, `change call outcome ${JSON.stringify(outcome)}`).toBe("DAEMON_UNAVAILABLE");
      return readTransfer(join(transfersDir, `${transferId}.json`));
    };
    /** Exactly-once verification of one completed journal record after restart. */
    const assertCompletedOnce = async (plan: TransferRecord, reason: "transfer" | "claim"): Promise<void> => {
      expect(await exists(donePath(plan.transferId))).toBe(true);
      expect(await exists(join(transfersDir, `${plan.transferId}.json`))).toBe(false);
      const source = await unread(plan.fromKey);
      const destination = new Set(await unread(plan.toKey));
      for (const name of plan.unread) {
        expect(source.includes(name), `${name} still in the prior owner's unread`).toBe(false);
        expect(destination.has(name), `${name} missing from the successor's unread`).toBe(true);
      }
      // Both recorded transfer events landed exactly once, under their frozen IDs, nowhere else.
      for (const [index, key] of [plan.fromKey, plan.toKey].entries()) {
        const events = (await allEvents(key)).filter((event) => event.kind === "transfer" && event.jobId === plan.transferId);
        expect(events.length, `transfer events in mailbox ${key}`).toBe(1);
        expect(events[0]!.id).toBe(plan.events[index].id);
      }
      for (const runId of plan.runIds) {
        const owners = await ownersOf(runId);
        const successors = owners.filter((entry) => entry.reason === reason && managerSessionKey(entry.session as AgentSessionIdentity) === plan.toKey);
        expect(successors.length, `successor provenance entries for ${runId}`).toBe(1);
        expect(owners.at(-1)!.to).toBeNull();
        expect(managerSessionKey(owners.at(-1)!.session as AgentSessionIdentity)).toBe(plan.toKey);
        expect(owners.filter((entry) => entry.to === null).length).toBe(1);
      }
      // No file was accounted as lost: the move landed once, not zero times.
      const daemonJson = record(await readJson(join(namespaceDir, "daemon.json")));
      expect(record(daemonJson.unpersisted ?? {})[plan.fromKey]).toBeUndefined();
    };

    let owner!: Agent;
    let successor!: Agent;
    const K1 = `n43-r1-${process.pid}`;
    const K2 = `n43-r2-${process.pid}`;

    try {
      const sessions = record(await run("session", "list", "--json"));
      if (Array.isArray(sessions.sessions) && sessions.sessions.some((session) => record(session).name === REQUIRED_SESSION)) {
        throw new Error(`refusing to reuse existing session ${REQUIRED_SESSION}`);
      }
      await execFileAsync(process.execPath, [join(repoRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"], { cwd: repoRoot, maxBuffer: 4_000_000 });
      await writeFile(daemonEntry, disposableDaemonEntry(), { mode: 0o600 });

      let startupError = "";
      server = spawn("herdr", ["--session", REQUIRED_SESSION, "server"], { cwd, stdio: ["ignore", "ignore", "pipe"] });
      server.stderr?.on("data", (chunk: Buffer) => { startupError = (startupError + chunk.toString()).slice(-2_000); });
      const started = await waitForCondition(async () => {
        if (server!.exitCode !== null) throw new Error(`named Herdr server exited during startup: ${startupError}`);
        const listed = record(await run("session", "list", "--json"));
        return Array.isArray(listed.sessions) && listed.sessions.some((session) => record(session).name === REQUIRED_SESSION && record(session).running === true);
      }, (ready) => ready, 10_000);
      sessionStarted = started === true;
      if (!sessionStarted) throw new Error(`named Herdr server did not become ready: ${startupError}`);
      await chmod(dirname(sessionSocket), 0o700);
      proxy = await startDisposableSocketProxy(sessionSocket, proxySocket);

      const created = record(record(await runNamed(["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"])).result);
      workspaceId = String(record(created.workspace ?? created).workspace_id);
      const rootPane = (await snapshot()).panes.find((pane) => pane.workspace_id === workspaceId);
      if (rootPane === undefined) throw new Error("fixture snapshot omitted its root pane");
      const rootPaneId = String(rootPane.pane_id);
      owner = await startPiPane(rootPaneId, "owner");
      successor = await startPiPane(rootPaneId, "successor");
      expect(owner.key).not.toBe(successor.key);

      daemon = await startDaemon();
      let ownerClient = await connect(owner);
      const r1 = await launchChild(ownerClient, owner, K1);

      // ---- (2) transfer refused while an owner intent is unsettled.
      // The K2 launch is left in flight on one connection; a second owner
      // connection asks for the transfer while the intent file reads
      // `effecting` — an effect-uncertain intent the §8 veto treats exactly as
      // `unresolved` (ownership.ts gates on both states). Stated trade-off: a
      // durably `unresolved` intent needs a child the D4 sweep cannot classify,
      // which this harness cannot manufacture without leaving the owner
      // permanently vetoed for every later assertion.
      const launchK2 = ownerClient.launch({ idempotencyKey: K2, task: { objective: CHILD_OBJECTIVE, scope: "Only this pane. Change no files.", doneWhen: ["The reply was sent."], tier: CHILD_TIER } });
      const effecting = await waitForCondition(() => readJson(intentPath(owner.key, K2)), (intent) => intent?.state === "effecting", 60_000, 50);
      if (effecting === undefined) throw new Error(`intent ${K2} never read effecting: ${JSON.stringify(await readJson(intentPath(owner.key, K2)))}`);
      const vetoClient = await connect(owner);
      expect(await refusal(vetoClient.run({ action: "transfer", runIds: [r1.runId], successorPaneId: successor.paneId }))).toBe("OWNER_INTENT_UNRESOLVED");
      vetoClient.close();
      clients.delete(vetoClient);
      const k2Reply = await launchK2;
      expect(k2Reply.state).toBe("completed");
      const r2 = { runId: String(record((record(await readJson(intentPath(owner.key, K2))).children as unknown[])[0]).runId) };
      expect(await ownersOf(r1.runId)).toEqual([]);
      expect(record(await provenanceOf(r1.runId)).v).toBe(1);

      // A restart lands the mailbox-global `downtime_gap` in the owner mailbox
      // so the live transfer below has a non-run-scoped file to move.
      await sigkillDaemon();
      daemon = await startDaemon();
      const ownerUnreadBefore = await unread(owner.key);
      const gapBodies = await Promise.all(ownerUnreadBefore.map((name) => readUnread(owner.key, name)));
      const gap = gapBodies.find((event) => event.kind === "downtime_gap");
      expect(gap, "downtime_gap in the owner mailbox before transfer").toBeDefined();
      expect("runId" in gap!).toBe(false);
      expect(await unread(successor.key)).toEqual([]);

      // ---- (1) live-owner transfer: entire unread set (run-scoped + global) moves; hints re-target.
      ownerClient = await connect(owner);
      const promptsBeforeTransfer = proxy.requests.length;
      const transferReply = await ownerClient.run({ action: "transfer", runIds: [r1.runId, r2.runId], successorPaneId: successor.paneId });
      expect(transferReply.action).toBe("transfer");
      const transferId = transferReply.action === "transfer" ? transferReply.transfer.transferId : "";
      const plan = await readTransfer(donePath(transferId));
      expect(plan.fromKey).toBe(owner.key);
      expect(plan.toKey).toBe(successor.key);
      expect(plan.successor.paneId).toBe(successor.paneId);
      // The frozen plan holds every file the owner had, gap included, and all landed in the successor's unread.
      for (const name of ownerUnreadBefore) expect(plan.unread).toContain(name);
      const gapFile = ownerUnreadBefore[gapBodies.indexOf(gap!)]!;
      const successorUnread = await unread(successor.key);
      for (const name of plan.unread) expect(successorUnread).toContain(name);
      expect(successorUnread).toContain(gapFile);
      const ownerUnreadAfter = await unread(owner.key);
      for (const name of plan.unread) expect(ownerUnreadAfter).not.toContain(name);
      // The owner keeps only its own recorded transfer event; the successor gained its twin.
      expect(ownerUnreadAfter).toEqual([`${plan.events[0].id}.json`]);
      expect(successorUnread).toContain(`${plan.events[1].id}.json`);
      for (const runId of plan.runIds) {
        const provenance = await provenanceOf(runId);
        expect(provenance.v).toBe(2);
        const owners = (provenance.owners as unknown[]).map(record);
        expect(owners.length).toBe(2);
        expect(managerSessionKey(owners[0]!.session as AgentSessionIdentity)).toBe(owner.key);
        expect(owners[0]!.reason).toBe("launch");
        expect(typeof owners[0]!.to).toBe("string");
        expect(managerSessionKey(owners[1]!.session as AgentSessionIdentity)).toBe(successor.key);
        expect(owners[1]!).toMatchObject({ reason: "transfer", to: null });
      }
      // Hint re-target: the next run event lands in the successor mailbox AND
      // the daemon's idle hint goes to the successor pane. The prior owner is
      // still live and idle, so a hint aimed at it would be a visible failure.
      expect(await paneStatus(owner.paneId)).toBeDefined();
      const successorUnreadBeforeClose = new Set(successorUnread);
      await closePane(r1.paneId);
      // Discriminating: a hint that was NOT re-targeted would list the prior
      // owner's own mailbox at the prior owner's pane; the successor's mailbox
      // path can only appear in a hint whose owner is the successor.
      const hint = await waitForCondition(
        async () => proxy!.requests.slice(promptsBeforeTransfer).find((request) => request.text?.startsWith("herdr mailbox:") === true && request.text.includes(unreadDir(successor.key))),
        (request) => request !== undefined,
        90_000,
        250,
      );
      expect(hint, `no successor-mailbox hint after the transfer; prompts=${JSON.stringify(proxy.requests.slice(promptsBeforeTransfer))} daemon log: ${daemonLog.slice(-10).join(" | ")}`).toBeDefined();
      expect(hint!.target).toBe(successor.paneId);
      const closeEvent = (await Promise.all((await unread(successor.key)).filter((name) => !successorUnreadBeforeClose.has(name)).map((name) => readUnread(successor.key, name))))
        .find((event) => event.runId === r1.runId);
      expect(closeEvent, "run-scoped lifecycle event in the successor mailbox").toBeDefined();

      // ---- (3)-(6) claims: the successor becomes the absent owner, the original owner claims back.
      await closePane(successor.paneId);
      const claimant = await connect(owner);
      const both = [r1.runId, r2.runId];
      const exact: ClaimRecord = { priorOwnerSession: successor.session, successorSession: owner.session, runIds: both, instructedAt: new Date().toISOString(), instruction: "N4.3 canary: hand the runs back to the original owner." };
      // (3) no record at all.
      expect(await refusal(claimant.run({ action: "claim", runIds: both, incidentId: `n43-absent-${process.pid}` }))).toBe("CLAIM_NOT_INSTRUCTED");
      // (4) a record naming a different successor session.
      await writeClaim("n43-wrong-successor", { ...exact, successorSession: { ...owner.session, value: `${owner.session.value}-not-me` } });
      expect(await refusal(claimant.run({ action: "claim", runIds: both, incidentId: "n43-wrong-successor" }))).toBe("CLAIM_NOT_INSTRUCTED");
      // (4) requested runs a strict subset of the record's runIds.
      await writeClaim("n43-subset", exact);
      expect(await refusal(claimant.run({ action: "claim", runIds: [r1.runId], incidentId: "n43-subset" }))).toBe("CLAIM_NOT_INSTRUCTED");
      // (4) requested runs a strict superset of the record's runIds.
      await writeClaim("n43-superset", { ...exact, runIds: [r1.runId] });
      expect(await refusal(claimant.run({ action: "claim", runIds: both, incidentId: "n43-superset" }))).toBe("CLAIM_NOT_INSTRUCTED");
      // Nothing above consumed a record or touched ownership.
      for (const id of ["n43-wrong-successor", "n43-subset", "n43-superset"]) expect(await exists(join(claimsDir, `${id}.json`))).toBe(true);
      expect(await exists(join(claimsDir, "used"))).toBe(false);
      for (const runId of both) expect(managerSessionKey((await ownersOf(runId)).at(-1)!.session as AgentSessionIdentity)).toBe(successor.key);

      // (5) exact record → the claim consumes it FIRST, then mutates. The
      // window is widened with unread files in the absent owner's mailbox and
      // the daemon is killed the instant `claims/used/` holds the record: the
      // frozen journal must exist, `done/` must not, and the successor's unread
      // must still hold plan files — consumption preceded the mutations and the
      // restart completes without the record.
      const planted = await plantWindowFiles(successor.key, r2.runId, WINDOW_FILES);
      expect((await unread(successor.key)).length).toBeLessThan(MAILBOX_UNREAD_MAX_FILES);
      const incidentId = `n43-claim-${process.pid}`;
      await writeClaim(incidentId, exact);
      const usedPath = join(claimsDir, "used", `${incidentId}.json`);
      const claimPlan = await killInsideWindow(
        claimant.run({ action: "claim", runIds: both, incidentId }),
        async () => (await exists(usedPath)) ? (await pendingTransferIds())[0] : undefined,
      );
      expect(claimPlan.incidentId).toBe(incidentId);
      expect(claimPlan.fromKey).toBe(successor.key);
      expect(claimPlan.toKey).toBe(owner.key);
      for (const name of planted) expect(claimPlan.unread).toContain(name);
      expect(await exists(join(claimsDir, `${incidentId}.json`))).toBe(false);
      const stillAtSource = (await unread(successor.key)).filter((name) => claimPlan.unread.includes(name)).length;
      process.stderr.write(`N43_CLAIM_WINDOW planFiles=${claimPlan.unread.length} stillAtSourceAtKill=${stillAtSource}\n`);
      expect(stillAtSource, "the kill landed after every move; window missed").toBeGreaterThan(0);

      daemon = await startDaemon();
      await assertCompletedOnce(claimPlan, "claim");
      for (const runId of both) {
        const owners = await ownersOf(runId);
        expect(owners.map((entry) => entry.reason)).toEqual(["launch", "transfer", "claim"]);
      }
      const claimedStatus = await (await connect(owner)).status();
      expect(claimedStatus.pendingTransfers).toEqual([]);
      for (const name of claimPlan.unread) expect(claimedStatus.unread.ids).toContain(stripJson(name));

      // (6) the same record cannot authorize a second claim: it was consumed
      // before the mutations, and a fresh copy of it fails `priorOwnerSession`
      // because the recorded owner is now the claimant.
      const secondClaim = await connect(owner);
      expect(await refusal(secondClaim.run({ action: "claim", runIds: both, incidentId }))).toBe("CLAIM_NOT_INSTRUCTED");
      await writeClaim(`${incidentId}-leftover`, exact);
      expect(await refusal(secondClaim.run({ action: "claim", runIds: both, incidentId: `${incidentId}-leftover` }))).toBe("CLAIM_NOT_INSTRUCTED");
      expect(await exists(join(claimsDir, `${incidentId}-leftover.json`))).toBe(true);
      for (const runId of both) expect((await ownersOf(runId)).length).toBe(3);

      // ---- (7) SIGKILL mid-transfer → restart completes the journal exactly once.
      const successor2 = await startPiPane(rootPaneId, "successor2");
      expect((await unread(owner.key)).length).toBeLessThan(MAILBOX_UNREAD_MAX_FILES);
      const transferer = await connect(owner);
      const killedPlan = await killInsideWindow(
        transferer.run({ action: "transfer", runIds: both, successorPaneId: successor2.paneId }),
        async () => (await pendingTransferIds())[0],
      );
      expect(killedPlan.incidentId).toBeUndefined();
      expect(killedPlan.fromKey).toBe(owner.key);
      expect(killedPlan.toKey).toBe(successor2.key);
      const stillAtOwner = (await unread(owner.key)).filter((name) => killedPlan.unread.includes(name)).length;
      process.stderr.write(`N43_TRANSFER_WINDOW planFiles=${killedPlan.unread.length} stillAtSourceAtKill=${stillAtOwner}\n`);
      expect(stillAtOwner, "the kill landed after every move; window missed").toBeGreaterThan(0);
      for (const key of [owner.key, successor2.key]) {
        expect((await allEvents(key)).filter((event) => event.kind === "transfer" && event.jobId === killedPlan.transferId)).toEqual([]);
      }

      daemon = await startDaemon();
      await assertCompletedOnce(killedPlan, "transfer");
      for (const runId of both) {
        expect((await ownersOf(runId)).map((entry) => entry.reason)).toEqual(["launch", "transfer", "claim", "transfer"]);
      }
      const finalStatus = await (await connect(successor2)).status();
      expect(finalStatus.pendingTransfers).toEqual([]);
      expect(finalStatus.unread.count).toBe((await unread(successor2.key)).length);
    } catch (error) {
      failure = error;
      process.stderr.write(`INTEGRATION_FAILURE_RECORDED ${error instanceof Error ? error.message : String(error)}\n${daemonLog.slice(-20).join("\n")}\n`);
      throw error;
    } finally {
      if (failure !== undefined) process.stderr.write("INTEGRATION_FAILURE_RECORDED_BEFORE_TEARDOWN\n");
      for (const client of clients) client.close();
      await stopDisposableServer(daemon);
      await proxy?.close().catch(() => undefined);
      if (workspaceId) {
        await runNamed(["workspace", "close", workspaceId]).catch((error: unknown) => process.stderr.write(`INTEGRATION_TEARDOWN_FAILURE ${String(error)}\n`));
      }
      if (sessionStarted) await run("session", "stop", REQUIRED_SESSION, "--json").catch((error: unknown) => process.stderr.write(`INTEGRATION_SESSION_STOP_FAILURE ${String(error)}\n`));
      await stopDisposableServer(server);
      if (sessionStarted) await run("session", "delete", REQUIRED_SESSION, "--json").catch((error: unknown) => process.stderr.write(`INTEGRATION_SESSION_DELETE_FAILURE ${String(error)}\n`));
      await rm(cwd, { recursive: true, force: true });
    }
  }, 1_800_000);
});
