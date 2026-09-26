/**
 * N4.1 — restart/reattach + idempotency canary (durable-supervisor §6, §9).
 *
 * The daemon under test is the emitted `dist/src/daemon/main.js`, spawned as a
 * plain child of this test with `HERDR_SOCKET_PATH` pointed at a recording
 * proxy inside the disposable cwd — so the endpoint namespace, the handoff run
 * namespace, and every `agent.prompt` the daemon issues all land where the
 * test can read and count them. Owner and children are real Pi panes:
 * `verifyDaemonCaller` refuses a shell occupant, and the D4 sweep re-matches
 * terminal + name + kind + native session, which only a real agent carries.
 *
 * The SIGKILL window is deterministic: the proxy observes the child's
 * `agent.prompt` frame (a point that is provably after the child effect), the
 * test then polls `<ns>/intents/<managerSessionKey>/<key>.json` until it reads
 * `state:"effecting"` with a recorded runId, and only then kills the daemon —
 * the intent can no longer be `recorded`, and the daemon dies before it can
 * ever read the prompt reply, so it can never reach `completed`.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chmod, readdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { resolveManagerSession } from "../../src/context.js";
import { parseSnapshotResult } from "../../src/targets.js";
import { connectDaemonClient, DaemonCallError, type DaemonClient } from "../../src/daemon/client.js";
import { managerSessionKey } from "../../src/daemon/intents.js";
import { DAEMON_NAMESPACE_DIR_NAME } from "../../src/daemon/namespace.js";
import { HANDOFF_STATE_DIR_NAME } from "../../src/handoff.js";
import { loadSettings } from "../../src/settings.js";
import { reviewLogPaths } from "../../src/supervision/review-log.js";
import { resolveTypesafeApiKey } from "../../src/typesafe-reviewer.js";
import { createDisposableGitWorkspace, startDisposableSocketProxy, stopDisposableServer, waitForCondition } from "./disposable-session.js";

const execFileAsync = promisify(execFile);
const REQUIRED_SESSION = process.env.HERDR_TOOLS_INTEGRATION_SESSION ?? "herdr-tools-integration";
const enabled = process.env.HERDR_TOOLS_RUN_INTEGRATION === "1";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const daemonEntry = join(repoRoot, "dist/src/daemon/main.js");

/** Pi at the utility tier is the cheapest leg that still satisfies `verifyDaemonCaller`. */
const CHILD_TIER = "utility" as const;
/** How long the K2 child keeps a tool call running so it stays `working` across the D5 window. */
const CHILD_WORK_SECONDS = 600;

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

async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
}

/** Every `review` record naming this child in the run's review log (the reviewer's durable append-last step). */
async function reviewRecordsFor(root: string, agentName: string): Promise<number> {
  let text: string;
  try {
    text = await readFile(reviewLogPaths(root).reviews, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return 0;
    throw error;
  }
  return text.split("\n").filter((line) => line.length > 0).map((line) => record(JSON.parse(line)))
    .filter((entry) => entry.type === "review" && entry.agentName === agentName).length;
}

describe.skipIf(!enabled)("disposable daemon restart/reattach + idempotency canary (N4.1)", () => {
  it("survives SIGKILL mid-effecting, reattaches the live child, replays the key with zero prompts, and pauses reviews when the owner is gone", async () => {
    expect(process.env.HERDR_TOOLS_INTEGRATION_SESSION ?? REQUIRED_SESSION).toBe(REQUIRED_SESSION);
    expect(process.env.HERDR_ENV).toBe("1");
    expect([process.env.HERDR_WORKSPACE_ID, process.env.HERDR_TAB_ID, process.env.HERDR_PANE_ID].every(Boolean)).toBe(true);

    let workspaceId: string | undefined;
    let sessionStarted = false;
    let server: ChildProcess | undefined;
    let daemon: ChildProcess | undefined;
    let client: DaemonClient | undefined;
    let proxy: Awaited<ReturnType<typeof startDisposableSocketProxy>> | undefined;
    let failure: unknown;
    const cwd = await realpath(await createDisposableGitWorkspace("herdr-daemon-it-"));
    const label = `daemon-herdr-tools-it-${process.pid}`;
    const sessionSocket = `/home/gabriel/.config/herdr/sessions/${REQUIRED_SESSION}/herdr.sock`;
    const proxySocket = join(cwd, "herdr.sock");
    const namespaceDir = join(cwd, DAEMON_NAMESPACE_DIR_NAME);
    const runsDir = join(cwd, HANDOFF_STATE_DIR_NAME);
    const daemonLog: string[] = [];
    let pendingKill: ((target: string) => Promise<void>) | undefined;

    const run = async (...args: string[]): Promise<unknown> => {
      const result = await execFileAsync("herdr", args, { cwd, maxBuffer: 4_000_000 });
      return JSON.parse(result.stdout);
    };
    const runNamed = (args: string[]) => run("--session", REQUIRED_SESSION, ...args);
    const snapshot = async () => {
      const value = record(record(record(await runNamed(["api", "snapshot"])).result).snapshot);
      return { ...value, panes: (Array.isArray(value.panes) ? value.panes : []).map(record), agents: (Array.isArray(value.agents) ? value.agents : []).map(record) };
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

    /** Spawn the emitted daemon and wait for its own readiness line — the sweep has run and the mailbox is bound. */
    const startDaemon = async (): Promise<ChildProcess> => {
      const child = spawn(process.execPath, [daemonEntry], {
        cwd,
        env: {
          ...process.env,
          HERDR_ENV: "1",
          HERDR_SOCKET_PATH: proxySocket,
          HERDR_WORKSPACE_ID: workspaceId!,
          HERDR_TAB_ID: ownerTabId,
          HERDR_PANE_ID: ownerPaneId,
          HERDR_PROJECT_DIR: cwd,
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
    };
    const connect = async (): Promise<DaemonClient> => connectDaemonClient(
      { dir: namespaceDir, endpoint: await realpath(proxySocket) },
      { identity: { workspaceId: workspaceId!, tabId: ownerTabId, paneId: ownerPaneId, agentSession: ownerSession }, projectRoot: cwd },
      { requestTimeoutMs: 600_000 },
    );
    const intentPath = (key: string) => join(namespaceDir, "intents", ownerKey, `${key}.json`);
    const mailboxUnread = () => join(namespaceDir, "mailbox", ownerKey, "unread");
    const readEvent = async (id: string) => record(JSON.parse(await readFile(join(mailboxUnread(), `${id}.json`), "utf8")));
    const gapEvents = async () => {
      const events = await Promise.all((await listJsonFiles(mailboxUnread())).map((name) => readEvent(name.slice(0, -".json".length))));
      return events.filter((event) => event.kind === "downtime_gap");
    };

    /**
     * Launch `key` and SIGKILL the daemon inside the effecting window: the proxy
     * sees the child's `agent.prompt`, the intent file is polled to
     * `effecting` with a recorded runId, then the daemon dies before the prompt
     * reply can reach it. Returns the recorded run/child identity.
     */
    const launchAndKill = async (key: string, objective: string) => {
      const before = proxy!.requests.filter((request) => request.method === "agent.prompt").length;
      let killed: Promise<void> | undefined;
      pendingKill = async (target) => {
        if (killed !== undefined) return;
        killed = (async () => {
          const intent = await waitForCondition(
            () => readJson(intentPath(key)),
            (value) => value?.state === "effecting" && Array.isArray(value.children) && value.children.some((child) => typeof record(child).runId === "string"),
            30_000,
            50,
          );
          if (intent === undefined) throw new Error(`intent ${key} never read effecting with a recorded child before the prompt to ${target}`);
          await sigkillDaemon();
        })();
        await killed;
      };
      let rejection: unknown;
      let reply: unknown;
      try {
        reply = await client!.launch({ idempotencyKey: key, task: { objective, scope: "Only this pane. Change no files.", doneWhen: ["The reply was sent."], tier: CHILD_TIER } });
      } catch (error) {
        rejection = error;
      } finally {
        pendingKill = undefined;
      }
      if (killed === undefined) {
        const failedPane = record(reply ?? {}).result === undefined ? undefined : record((record(record(reply).result).children as unknown[])[0] ?? {}).paneId;
        const paneText = typeof failedPane === "string"
          ? await execFileAsync("herdr", ["--session", REQUIRED_SESSION, "pane", "read", failedPane, "--lines", "40"], { cwd }).then((result) => result.stdout, (error: unknown) => String(error))
          : undefined;
        process.stderr.write(`N41_DIAG pane=${String(failedPane)} text=${JSON.stringify(paneText)}\n`);
        throw new Error(`no agent.prompt reached the proxy during launch ${key}; reply=${JSON.stringify(reply)} rejection=${rejection instanceof Error ? `${rejection.message} ${JSON.stringify((rejection as { details?: unknown }).details)}` : String(rejection)} intent=${JSON.stringify(await readJson(intentPath(key)))}`);
      }
      await killed;
      // The client's socket drops with the daemon: a transport-class refusal, never a fabricated state.
      expect(rejection).toBeInstanceOf(DaemonCallError);
      expect((rejection as DaemonCallError).code).toBe("DAEMON_UNAVAILABLE");
      expect((rejection as DaemonCallError).effectCertainty).toBe("unknown");
      client!.close();
      const intent = record(await readJson(intentPath(key)));
      expect(intent.state).toBe("effecting");
      const child = record((intent.children as unknown[])[0]);
      const runId = String(child.runId);
      const statePath = join(runsDir, runId, ".tools", "state.json");
      const sidecar = await readFile(statePath);
      const state = record(JSON.parse(sidecar.toString("utf8")));
      const recorded = record(state.child);
      expect(state.lifecycle && record(state.lifecycle).state).toBe("awaiting_handoff");
      expect(typeof recorded.terminalId).toBe("string");
      expect(state.nativeSession).not.toBeNull();
      expect(proxy!.requests.filter((request) => request.method === "agent.prompt").length).toBe(before + 1);
      // Routing is recorded, never asserted: the tier chain may walk past Pi on availability.
      process.stderr.write(`N41_ROUTE key=${key} runId=${runId} agentKind=${String(recorded.agentKind)} operatingPointId=${String(recorded.operatingPointId)}\n`);
      return { launchId: String(intent.launchId), runId, statePath, sidecar, agentName: String(child.name), paneId: String(recorded.paneId), terminalId: String(recorded.terminalId) };
    };

    let ownerPaneId = "";
    let ownerTabId = "";
    let ownerSession: { source: string; agent: string; kind: string; value: string } | null = null;
    let ownerKey = "";
    const K1 = `n41-lost-${process.pid}`;
    const K2 = `n41-live-${process.pid}`;

    try {
      const sessions = record(await run("session", "list", "--json"));
      if (Array.isArray(sessions.sessions) && sessions.sessions.some((session) => record(session).name === REQUIRED_SESSION)) {
        throw new Error(`refusing to reuse existing session ${REQUIRED_SESSION}`);
      }
      // The reviewer must be able to fire for the D5 pause to prove anything.
      expect(await resolveTypesafeApiKey(), "TypeSafe reviewer credential").toBeTruthy();
      const cadenceMs = (await loadSettings()).reviewCadenceMinutes * 60_000;

      // The daemon under test is the emitted entry, exactly what the systemd unit runs.
      await execFileAsync(process.execPath, [join(repoRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"], { cwd: repoRoot, maxBuffer: 4_000_000 });

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
      // Every daemon-issued prompt is countable here; the namespace derives from this path's realpath.
      proxy = await startDisposableSocketProxy(sessionSocket, proxySocket, {
        onRequest: async (request) => {
          if (request.method === "agent.prompt" && pendingKill !== undefined) await pendingKill(request.target ?? "");
        },
      });

      const created = record(record(await runNamed(["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"])).result);
      workspaceId = String(record(created.workspace ?? created).workspace_id);
      const rootPane = (await snapshot()).panes.find((pane) => pane.workspace_id === workspaceId);
      if (rootPane === undefined) throw new Error("fixture snapshot omitted its root pane");
      // The owner lives in a split, not the workspace root, so closing it later removes only the owner.
      await runNamed(["pane", "split", String(rootPane.pane_id), "--direction", "right", "--no-focus", "--cwd", cwd]);
      const ownerPane = (await snapshot()).panes.find((pane) => pane.workspace_id === workspaceId && pane.pane_id !== rootPane.pane_id);
      if (ownerPane === undefined) throw new Error("owner split pane missing from the snapshot");
      ownerPaneId = String(ownerPane.pane_id);
      ownerTabId = String(ownerPane.tab_id);
      await runNamed(["agent", "start", "owner", "--kind", "pi", "--pane", ownerPaneId, "--timeout", "120000"]);
      const ownerIdle = await waitForCondition(() => paneStatus(ownerPaneId), (status) => status === "idle", 120_000, 250);
      if (ownerIdle === undefined) throw new Error("owner Pi pane never reported idle");
      ownerSession = resolveManagerSession(parseSnapshotResult(record(await runNamed(["api", "snapshot"])).result), ownerPaneId);
      if (ownerSession === null) throw new Error("owner pane carries no native agent session");
      ownerKey = managerSessionKey(ownerSession);

      // ---- (1) launch K1, SIGKILL mid-effecting; (2) child closed during downtime.
      daemon = await startDaemon();
      client = await connect();
      const lost = await launchAndKill(K1, "Reply with the single word READY and then stop. Do not run any tool.");
      await closePane(lost.paneId);

      daemon = await startDaemon();
      const k1 = record(await readJson(intentPath(K1)));
      // `resolution:"interrupted"` is written only by the restart sweep's `recoverInterrupted`.
      expect(k1.resolution).toBe("interrupted");
      expect(k1.effectCertainty).toBe("unknown");
      expect(k1.state).not.toBe("failed");
      const k1Child = record((k1.children as unknown[])[0]);
      expect(k1Child.runId).toBe(lost.runId);
      expect(k1Child.disposition).toBe("identity_lost");
      // Every child classified (provably absent) → the sweep closes the intent reconciled, never failed.
      expect(k1.state).toBe("completed");
      expect(k1.reconciled).toBe(true);
      // The sidecar is preserved untouched: byte-identical, still awaiting_handoff.
      expect(Buffer.compare(await readFile(lost.statePath), lost.sidecar)).toBe(0);
      // ---- (5) downtime_gap in the owner mailbox.
      const gapsAfterFirstRestart = await gapEvents();
      expect(gapsAfterFirstRestart.length).toBe(1);
      expect(typeof gapsAfterFirstRestart[0]!.from).toBe("string");
      expect(typeof gapsAfterFirstRestart[0]!.to).toBe("string");
      expect("runId" in gapsAfterFirstRestart[0]!).toBe(false);
      client = await connect();
      const statusAfterFirst = await client.status({ eventId: String(gapsAfterFirstRestart[0]!.id) });
      expect(statusAfterFirst.event?.kind).toBe("downtime_gap");
      expect(statusAfterFirst.mailbox).toBe(join(namespaceDir, "mailbox", ownerKey));
      const k1Reconcile = await client.run({ action: "reconcile", idempotencyKey: K1 });
      expect(k1Reconcile.action === "reconcile" && k1Reconcile.state).toBe("completed");

      // ---- (1) again for K2, the child that stays alive across the downtime.
      const live = await launchAndKill(K2, `Run the shell command \`sleep ${CHILD_WORK_SECONDS}\` and wait for it to finish, then reply DONE. Do nothing else.`);
      expect(await paneStatus(live.paneId)).toBeDefined();
      const promptsBeforeRestart = proxy.requests.filter((request) => request.method === "agent.prompt").length;
      const heartbeatBeforeRestart = String(record(await readJson(join(namespaceDir, "daemon.json"))).heartbeat);

      daemon = await startDaemon();
      // ---- (3)/(6) reattach bound the live child under the same terminal id; no recovery_pending.
      const k2 = record(await readJson(intentPath(K2)));
      expect(k2.resolution).toBe("interrupted");
      expect(k2.launchId).toBe(live.launchId);
      const k2Child = record((k2.children as unknown[])[0]);
      expect(k2Child.runId).toBe(live.runId);
      expect(k2Child.disposition).toBe("bound");
      expect(k2.state).toBe("completed");
      expect(k2.reconciled).toBe(true);
      const k2State = record(JSON.parse(await readFile(live.statePath, "utf8")));
      expect(record(k2State.lifecycle).state).toBe("awaiting_handoff");
      expect(record(k2State.child).terminalId).toBe(live.terminalId);
      const livePane = (await snapshot()).panes.find((pane) => pane.pane_id === live.paneId);
      expect(livePane?.terminal_id).toBe(live.terminalId);
      client = await connect();
      const statusAfterSecond = await client.status();
      const k2Run = statusAfterSecond.runs.find((entry) => entry.runId === live.runId);
      expect(k2Run?.lifecycle).toBe("awaiting_handoff");
      expect(k2Run?.child.presence).toBe("present");
      expect(k2Run?.child.paneId).toBe(live.paneId);
      expect(k2Run?.review).toBe("active");
      const k2Reconcile = await client.run({ action: "reconcile", idempotencyKey: K2 });
      expect(k2Reconcile.action).toBe("reconcile");
      expect(k2Reconcile.action === "reconcile" && k2Reconcile.state).toBe("completed");
      expect(k2Reconcile.action === "reconcile" && k2Reconcile.children[0]?.disposition).toBe("bound");
      // ---- (5) a second gap, opening at the killed daemon's last heartbeat.
      const gapsAfterSecondRestart = await gapEvents();
      expect(gapsAfterSecondRestart.length).toBe(2);
      expect(gapsAfterSecondRestart.some((event) => event.from === heartbeatBeforeRestart)).toBe(true);
      // ---- (4) second launch K2 → replay with the same minted launchId and zero prompts.
      const replay = await client.launch({ idempotencyKey: K2, task: { objective: `Run the shell command \`sleep ${CHILD_WORK_SECONDS}\` and wait for it to finish, then reply DONE. Do nothing else.`, scope: "Only this pane. Change no files.", doneWhen: ["The reply was sent."], tier: CHILD_TIER } });
      expect(replay.launchId).toBe(live.launchId);
      expect("replayed" in replay && replay.replayed).toBe(false);
      expect(replay.state).toBe("completed");
      expect(proxy.requests.filter((request) => request.method === "agent.prompt").length).toBe(promptsBeforeRestart);
      client.close();
      client = undefined;

      // ---- (7) owner pane closed → reviews paused, lifecycle events still land.
      expect(await paneStatus(live.paneId)).toBe("working");
      const reviewsBefore = await reviewRecordsFor(cwd, live.agentName);
      const unreadBefore = new Set(await listJsonFiles(mailboxUnread()));
      await closePane(ownerPaneId);
      // A full review cadence with the child provably working: a live reviewer would have appended a record.
      const stillWorking = await waitForCondition(async () => ({ at: performance.now(), status: await paneStatus(live.paneId) }), (sample) => sample.status !== "working", cadenceMs + 30_000, 2_000);
      expect(stillWorking, `child left working during the pause window: ${JSON.stringify(stillWorking)}`).toBeUndefined();
      expect(await reviewRecordsFor(cwd, live.agentName)).toBe(reviewsBefore);
      expect(reviewsBefore).toBe(0);
      await closePane(live.paneId);
      const exitEvent = await waitForCondition(async () => {
        const fresh = (await listJsonFiles(mailboxUnread())).filter((name) => !unreadBefore.has(name));
        const events = await Promise.all(fresh.map((name) => readEvent(name.slice(0, -".json".length))));
        return events.find((event) => event.runId === live.runId && (event.kind === "pane_closed" || event.kind === "identity_lost"));
      }, (event) => event !== undefined, 30_000, 250);
      expect(exitEvent, "pane-exit lifecycle event in the unowned mailbox").toBeDefined();
      expect(record(exitEvent!.childIdentity).paneId).toBe(live.paneId);
    } catch (error) {
      failure = error;
      process.stderr.write(`INTEGRATION_FAILURE_RECORDED ${error instanceof Error ? error.message : String(error)}\n${daemonLog.slice(-20).join("\n")}\n`);
      throw error;
    } finally {
      if (failure !== undefined) process.stderr.write("INTEGRATION_FAILURE_RECORDED_BEFORE_TEARDOWN\n");
      client?.close();
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
  }, 1_500_000);
});
