/**
 * C9 idle-turn hint consumption canary (spec §11, plan node N4.2).
 *
 * For each qualified kind (pi, claude, devin) this proves the whole §11 chain
 * on live agents: a run-scoped event lands in the owner mailbox as one file
 * per event, the daemon sends exactly one `agent.prompt` whose body matches
 * the §11 form (counted at the disposable socket proxy), the owner pane
 * consumes the prompt as a real turn (state working → idle/done, mailbox line
 * in the transcript), a busy owner receives zero prompts, `herdr_run` `ack`
 * renames unread → acked, bursts inside 5 s coalesce to one prompt, agy panes
 * are inert even when configured, and the stock daemon entrypoint ships the
 * C9-proved {pi, claude, devin} qualified set (N5.2 — it was EMPTY until this
 * canary passed).
 *
 * Event provenance note: the supervisor's `eventWriter` seam is wired on the
 * D4 reattach path (`src/daemon/reattach.ts` passes `settings.eventWriter`),
 * while the launch-path reservation in `src/tools/launch.ts` passes none, so
 * each consumption leg bounces the disposable daemon while the child is still
 * `awaiting_handoff` — the rebound supervisor is production-identical and its
 * persisted events drive the real hint sink. A dedicated leg asserts the
 * launch path itself persists events; it is the N2.2 wiring gate and must go
 * green before cutover.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chmod, readdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createDisposableGitWorkspace,
  startDisposableSocketProxy,
  stopDisposableServer,
  waitForCondition,
  type DisposableSocketProxy,
} from "./disposable-session.js";

const execFileAsync = promisify(execFile);
const REQUIRED_SESSION = process.env.HERDR_TOOLS_INTEGRATION_SESSION ?? "herdr-tools-integration";
const requestedSession = process.env.HERDR_TOOLS_INTEGRATION_SESSION ?? REQUIRED_SESSION;
const enabled = process.env.HERDR_TOOLS_RUN_INTEGRATION === "1";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const serverEntry = join(repoRoot, "dist/src/mcp-server.js");
const disposableDaemonEntry = join(repoRoot, "test/integration/fixtures/daemon-disposable.mjs");
const stockDaemonEntry = join(repoRoot, "dist/src/daemon/main.js");
const socketPath = `/home/gabriel/.config/herdr/sessions/${REQUIRED_SESSION}/herdr.sock`;
const proxyPath = `/home/gabriel/.config/herdr/sessions/${REQUIRED_SESSION}/herdr-proxy.sock`;
const HINT_KINDS = "pi,claude,devin,agy";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("integration response is not an object");
  return value as Record<string, unknown>;
}

function text(result: ToolResult): string {
  return result.content.map((block) => block.text).join("\n");
}

interface Owner {
  kind: string;
  paneId: string;
  workspaceId: string;
  tabId: string;
  cwd: string;
  client: Client;
}

interface LaunchedChild {
  runId: string;
  name: string;
  paneId?: string;
}

/** `agent.prompt` frames carrying the §11 body, counted at the proxied socket. */
function mailboxPrompts(proxy: DisposableSocketProxy, paneId: string): Array<{ id: string; text: string }> {
  return proxy.requests
    .filter((request) => request.target === paneId && typeof request.text === "string" && request.text.startsWith("herdr mailbox:"))
    .map((request) => ({ id: request.id, text: request.text as string }));
}

/** §11 event IDs: `<ISO UTC ms, colons removed>-<uuid>` — the sortable timestamp prefix. */
function eventTimestamp(eventId: string): number {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})(\d{2}\.\d{3})Z-/u.exec(eventId);
  if (match === null) return Number.NaN;
  return Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`);
}

async function jsonDir(directory: string): Promise<Record<string, unknown>[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const events: Record<string, unknown>[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      events.push(record(JSON.parse(await readFile(join(directory, name), "utf8"))));
    } catch {
      // Mid-rename observation is the writer's business; skip unparsable files.
    }
  }
  return events;
}

describe.skipIf(!enabled)("idle-hint consumption canary (C9)", () => {
  const owners = new Map<string, Owner>();
  const workspaceIds: string[] = [];
  const workdirs: string[] = [];
  let sessionServer: ChildProcess | undefined;
  let proxy: DisposableSocketProxy | undefined;
  let daemon: ChildProcess | undefined;
  let daemonStderr = "";
  let sessionStarted = false;

  const run = async (...args: string[]): Promise<unknown> => {
    const result = await execFileAsync("herdr", args, { cwd: repoRoot, maxBuffer: 8_000_000 });
    return JSON.parse(result.stdout);
  };
  const runSession = (...args: string[]) => run("--session", REQUIRED_SESSION, ...args);

  const cliPrompt = async (paneId: string, prompt: string): Promise<void> => {
    await execFileAsync("herdr", ["--session", REQUIRED_SESSION, "agent", "prompt", paneId, prompt], { cwd: repoRoot });
  };

  const paneStatus = async (paneId: string): Promise<string> => {
    const envelope = record(await runSession("pane", "get", paneId));
    return String(record(record(envelope.result).pane).agent_status);
  };

  const agentInfo = async (target: string): Promise<Record<string, unknown>> => {
    const envelope = record(await runSession("agent", "get", target));
    return record(record(envelope.result).agent);
  };

  const waitStatus = (paneId: string, statuses: string[], timeoutMs: number) =>
    waitForCondition(() => paneStatus(paneId).catch(() => ""), (value) => statuses.includes(value), timeoutMs, 500);

  const paneRead = async (paneId: string): Promise<string> => {
    const result = await execFileAsync("herdr", ["--session", REQUIRED_SESSION, "pane", "read", "--lines", "400", paneId], { cwd: repoRoot, maxBuffer: 4_000_000 });
    return result.stdout;
  };

  /**
   * Devin's pane screen buffer is too shallow to hold a minutes-long
   * mailbox-read turn; its durable session transcript JSON has every step.
   */
  const transcriptText = async (owner: Owner): Promise<string> => {
    if (owner.kind !== "devin") return paneRead(owner.paneId);
    const agent = await agentInfo(owner.paneId);
    const session = String(record(agent.agent_session ?? {}).value ?? "");
    if (session === "") return "";
    try {
      return await readFile(join(process.env.HOME ?? "", ".local/share/devin/cli/transcripts", `${session}.json`), "utf8");
    } catch {
      return "";
    }
  };

  /** One fresh MCP client bound to one owner pane — the §10 thin-client path. */
  const connectClient = async (owner: { paneId: string; tabId: string; workspaceId: string; cwd: string }): Promise<Client> => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverEntry],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        HERDR_ENV: "1",
        HERDR_SOCKET_PATH: proxy?.path ?? "",
        HERDR_WORKSPACE_ID: owner.workspaceId,
        HERDR_TAB_ID: owner.tabId,
        HERDR_PANE_ID: owner.paneId,
        HERDR_PROJECT_DIR: owner.cwd,
      },
      stderr: "pipe",
    });
    const client = new Client({ name: `hint-canary-${owner.paneId}`, version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    return client;
  };

  const call = (client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> =>
    client.callTool({ name, arguments: args }, undefined, { timeout: 600_000, maxTotalTimeout: 600_000 }) as Promise<ToolResult>;

  /** Wait until `daemonStderr` carries the bound-socket line (post-sweep). */
  const waitDaemonListening = async (timeoutMs = 30_000): Promise<void> => {
    const ready = await waitForCondition(async () => daemonStderr, (err) => err.includes("listening on"), timeoutMs, 100);
    expect(ready, `daemon did not bind; stderr:\n${daemonStderr}`).toContain("listening on");
  };

  const spawnDaemon = (entry: string, extra: Record<string, string>): ChildProcess => {
    daemonStderr = "";
    const child = spawn(process.execPath, [entry], {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        HERDR_ENV: "1",
        HERDR_SOCKET_PATH: proxy?.path ?? "",
        ...extra,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      daemonStderr = (daemonStderr + chunk.toString()).slice(-8_000);
    });
    return child;
  };

  const startDisposableDaemon = async () => {
    daemon = spawnDaemon(disposableDaemonEntry, { HERDR_TOOLS_DISPOSABLE_HINT_KINDS: HINT_KINDS });
    await waitDaemonListening();
  };

  /** SIGTERM the live daemon and start a fresh one; the D4 sweep finishes before "listening" logs. */
  const bounceDaemon = async () => {
    await stopDisposableServer(daemon);
    daemon = undefined;
    await startDisposableDaemon();
  };

  /** One workspace + one real agent pane + one MCP client, the §10 shape. */
  const bringUpOwner = async (kind: string): Promise<Owner> => {
    const cwd = await createDisposableGitWorkspace(`hint-${kind}-`);
    workdirs.push(cwd);
    const created = record(record(await runSession("workspace", "create", "--cwd", cwd, "--label", `hint-${kind}-${process.pid}`, "--no-focus")).result);
    const workspaceId = String(record(created.workspace ?? created).workspace_id);
    workspaceIds.push(workspaceId);
    const snapshot = record(record(record(await runSession("api", "snapshot")).result).snapshot);
    const pane = record((snapshot.panes as unknown[]).map(record).find((entry) => entry.workspace_id === workspaceId) ?? {});
    const paneId = String(pane.pane_id);
    const tabId = String(pane.tab_id);
    // Devin's default `auto` permission mode still prompts for MCP tool calls:
    // a mailbox-hint turn stalls at the interactive approval dialog (pane state
    // `blocked`, never settles). A supervised owner must run non-interactively —
    // `dangerous` auto-approves all tools, the same posture AGY launches with.
    const agentArgs = kind === "devin" ? ["--", "--permission-mode", "dangerous"] : [];
    await runSession("agent", "start", `owner-${kind}`, "--kind", kind, "--pane", paneId, "--timeout", "120000", ...agentArgs);
    const ready = await waitForCondition(
      async () => record(record(record(await runSession("agent", "get", paneId)).result).agent),
      (agent) => (agent.agent_status === "idle" || agent.agent_status === "done") && (kind === "agy" ? agent.agent_session == null : agent.agent_session != null),
      120_000,
      1_000,
    );
    expect(ready, `${kind} owner pane never became ready`).toBeDefined();
    const owner: Owner = { kind, paneId, workspaceId, tabId, cwd, client: undefined as unknown as Client };
    owner.client = await connectClient(owner);
    owners.set(kind, owner);
    return owner;
  };

  /** `herdr_launch` one slow child through the owner's MCP surface. */
  const launchChild = async (owner: Owner, token: string, sleepSeconds: number): Promise<LaunchedChild> => {
    const result = await call(owner.client, "herdr_launch", {
      task: {
        objective: `Run \`sleep ${sleepSeconds}\` using the bash tool, then reply with the exact token ${token} and nothing else.`,
        scope: "Read-only besides the sleep; change nothing.",
        doneWhen: [`your reply contains the token ${token}`],
      },
      idempotencyKey: `n42-${token.toLowerCase()}`,
    });
    expect(result.isError, text(result)).not.toBe(true);
    const reply = record(JSON.parse(text(result)));
    const child = record((reply.children as unknown[])[0]);
    return { runId: String(child.runId), name: String(child.name) };
  };

  /** The owner's §7 mailbox directories, learned through `herdr_status`. */
  const mailboxDirs = async (owner: Owner): Promise<{ dir: string; unread: string; acked: string }> => {
    const status = await call(owner.client, "herdr_status", {});
    if (status.isError) throw new Error(`herdr_status refused: ${text(status)}`);
    const dir = String(record(JSON.parse(text(status))).mailbox);
    return { dir, unread: join(dir, "unread"), acked: join(dir, "acked") };
  };

  /** Unread event bodies for this owner's mailbox, optionally filtered to one run. Poll-safe: a mid-bounce daemon refusal reads as empty. */
  const unreadEvents = async (owner: Owner, runId?: string): Promise<Record<string, unknown>[]> => {
    try {
      const { unread } = await mailboxDirs(owner);
      const events = await jsonDir(unread);
      return runId === undefined ? events : events.filter((event) => event.runId === runId);
    } catch {
      return [];
    }
  };

  const waitRunEvent = async (owner: Owner, runId: string, timeoutMs: number) =>
    waitForCondition(() => unreadEvents(owner, runId), (events) => events.length > 0, timeoutMs, 750);

  /**
   * The per-kind consumption spine: launch a slow child, bounce the daemon so
   * the D4 reattach binds a production supervisor (eventWriter-wired), then
   * prove mailbox event → one §11 prompt → real turn → `ack` rename.
   */
  const consumeLeg = async (kind: string): Promise<void> => {
    const owner = owners.get(kind)!;
    const token = `N42${kind.toUpperCase()}1`;
    const promptsBefore = mailboxPrompts(proxy!, owner.paneId).length;
    const child = await launchChild(owner, token, 45);
    await bounceDaemon();
    const event = await waitRunEvent(owner, child.runId, 240_000);
    expect(event, `${kind}: no run-scoped mailbox event landed for ${child.runId}`).toBeDefined();
    const eventIds = event!.map((entry) => String(entry.id));
    child.paneId = String(record(event![0].childIdentity).paneId);

    const prompt = await waitForCondition(
      async () => mailboxPrompts(proxy!, owner.paneId).slice(promptsBefore),
      (prompts) => prompts.length >= 1,
      60_000,
      250,
    );
    expect(prompt, `${kind}: idle owner pane received no herdr mailbox prompt`).toBeDefined();
    expect(prompt!.length, `${kind}: expected exactly one hint prompt`).toBe(1);
    const body = prompt![0].text;
    const match = /^herdr mailbox: (\d+) unread \(([^)]*)\) at (\S+); read via your MCP surface \(herdr_status \/ executor → MCP\)$/u.exec(body);
    expect(match, `${kind}: hint body deviates from the §11 form: ${body}`).not.toBeNull();
    const { unread } = await mailboxDirs(owner);
    expect(match![3]).toBe(unread);
    const listed = match![2].split(", ").filter((entry) => entry.length > 0);
    expect(Number(match![1])).toBe(listed.length);
    expect(listed.some((id) => eventIds.includes(id)), `${kind}: hint lists no new event id`).toBe(true);

    // Consumption: the pane must burn a real turn — working, then back to
    // idle/done, with the mailbox line visible in the agent transcript.
    // Devin's mailbox-read turns run minutes long (it enumerates the MCP
    // surface, then reads and reasons over each event) — it needs the wide
    // settle window; pi/claude settle in well under a minute.
    const seenWorking = await waitForCondition(async () => paneStatus(owner.paneId).catch(() => ""), (status) => status === "working" || status === "blocked", 30_000, 250);
    expect(seenWorking, `${kind}: pane never went working — the prompt was not consumed as a turn`).toBeDefined();
    const settled = await waitStatus(owner.paneId, ["idle", "done"], kind === "devin" ? 540_000 : 240_000);
    expect(settled, `${kind}: owner pane never returned to idle/done after the hint`).toBeDefined();
    const transcript = await waitForCondition(async () => transcriptText(owner), (screen) => screen.includes("herdr mailbox:"), 60_000, 1_000);
    expect(transcript ?? "", `${kind}: transcript shows no herdr mailbox line`).toContain("herdr mailbox:");
    process.stderr.write(`C9_LEG ${kind} consumed hint body="${body.slice(0, 200)}"\n`);

    // §11 read→act→ack: a compliant agent may already have acked its events
    // mid-turn (devin does) — ack whichever remain, then every run event file
    // must sit in acked/ and be gone from unread/; a repeat ack is idempotent.
    for (const eventId of eventIds) {
      const ack = await call(owner.client, "herdr_run", { action: "ack", eventId });
      expect(ack.isError, text(ack)).not.toBe(true);
      expect(["acked", "already-acked"], `${kind}: unexpected ack result ${text(ack)}`).toContain(String(record(JSON.parse(text(ack))).result));
    }
    const dirs = await mailboxDirs(owner);
    for (const eventId of eventIds) {
      expect(existsSync(join(dirs.acked, `${eventId}.json`)), `${kind}: ${eventId} missing from acked/`).toBe(true);
      expect(existsSync(join(dirs.unread, `${eventId}.json`)), `${kind}: ${eventId} still in unread/`).toBe(false);
    }
    const dup = await call(owner.client, "herdr_run", { action: "ack", eventId: eventIds[0] });
    expect(record(JSON.parse(text(dup))).result).toBe("already-acked");
  };

  /**
   * A child that only exists to emit events on cue: `sleep 300` keeps it from
   * finishing inside a leg, so its pane_closed lands exactly when we close it.
   */
  const stagedChild = async (owner: Owner, token: string): Promise<LaunchedChild> => {
    const child = await launchChild(owner, token, 300);
    child.paneId = String((await agentInfo(child.name)).pane_id);
    return child;
  };

  beforeAll(async () => {
    expect(requestedSession).toBe(REQUIRED_SESSION);
    expect(process.env.HERDR_ENV).toBe("1");
    expect([process.env.HERDR_WORKSPACE_ID, process.env.HERDR_TAB_ID, process.env.HERDR_PANE_ID].every(Boolean)).toBe(true);

    const sessions = record(await run("session", "list", "--json"));
    const existing = Array.isArray(sessions.sessions) && sessions.sessions.some((session) => record(session).name === REQUIRED_SESSION);
    if (existing) throw new Error(`refusing to reuse existing session ${REQUIRED_SESSION}`);

    await execFileAsync(process.execPath, [join(repoRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"], { cwd: repoRoot, maxBuffer: 4_000_000 });

    sessionServer = spawn("herdr", ["--session", REQUIRED_SESSION, "server"], { cwd: repoRoot, stdio: ["ignore", "ignore", "pipe"] });
    let serverStderr = "";
    sessionServer.stderr?.on("data", (chunk: Buffer) => { serverStderr = (serverStderr + chunk.toString()).slice(-2_000); });
    const listed = await waitForCondition(
      async () => record(await run("session", "list", "--json")),
      (value) => Array.isArray(value.sessions) && value.sessions.some((session) => {
        const entry = record(session);
        return entry.name === REQUIRED_SESSION && entry.running === true;
      }),
      15_000,
      100,
    );
    if (listed === undefined) throw new Error(`named Herdr server did not become ready: ${serverStderr}`);
    sessionStarted = true;
    // The session directory lands group-writable under umask 002; the handoff
    // namespace asserts owner-only parents, and the disposable session is
    // deleted at teardown — tightening it here is safe.
    await chmod(dirname(socketPath), 0o700);

    proxy = await startDisposableSocketProxy(socketPath, proxyPath);
    await startDisposableDaemon();

    for (const kind of ["pi", "claude", "devin", "agy"]) await bringUpOwner(kind);
  }, 600_000);

  afterEach(async ({ task }) => {
    if (task.result?.state !== "fail") return;
    process.stderr.write(`C9_DIAG ${task.name}\ndaemon stderr tail:\n${daemonStderr.slice(-1500)}\n`);
    for (const [kind, owner] of owners) {
      const status = await paneStatus(owner.paneId).catch(() => "?");
      process.stderr.write(`C9_DIAG ${kind} ${owner.paneId} status=${status} prompts=${mailboxPrompts(proxy!, owner.paneId).length}\n`);
    }
  });

  afterAll(async () => {
    for (const owner of owners.values()) await owner.client?.close().catch(() => undefined);
    await stopDisposableServer(daemon);
    for (const workspaceId of workspaceIds) {
      await runSession("workspace", "close", workspaceId).catch((error: unknown) => process.stderr.write(`INTEGRATION_TEARDOWN_FAILURE ${String(error)}\n`));
    }
    await proxy?.close().catch(() => undefined);
    if (sessionStarted) await run("session", "stop", REQUIRED_SESSION, "--json").catch((error: unknown) => process.stderr.write(`INTEGRATION_SESSION_STOP_FAILURE ${String(error)}\n`));
    await stopDisposableServer(sessionServer);
    if (sessionStarted) await run("session", "delete", REQUIRED_SESSION, "--json").catch((error: unknown) => process.stderr.write(`INTEGRATION_SESSION_DELETE_FAILURE ${String(error)}\n`));
    for (const dir of workdirs) await rm(dir, { recursive: true, force: true });
  }, 240_000);

  it("pi: an idle owner receives exactly one §11 hint and consumes it as a turn", async () => {
    await consumeLeg("pi");
  }, 600_000);

  it("pi: a busy owner receives zero prompts while events still land", async () => {
    const owner = owners.get("pi")!;
    // A trailing consumption turn from a previous leg would poison this leg.
    const settledOwner = await waitStatus(owner.paneId, ["idle", "done"], 240_000);
    expect(settledOwner, "pi owner not settled before the busy leg").toBeDefined();
    const child = await stagedChild(owner, "N42BUSY1");
    await bounceDaemon();
    const promptsBefore = mailboxPrompts(proxy!, owner.paneId).length;
    // The owner goes busy FIRST; the child's pane_closed event then lands inside
    // the busy window on demand — no reliance on when a sleeping child finishes.
    await cliPrompt(owner.paneId, "Run `sleep 150` with bash, then reply with the token N42BUSYOK.");
    const busy = await waitStatus(owner.paneId, ["working", "blocked"], 60_000);
    expect(busy, "pi owner never went busy").toBeDefined();
    await execFileAsync("herdr", ["--session", REQUIRED_SESSION, "pane", "close", child.paneId!], { cwd: repoRoot });
    const event = await waitRunEvent(owner, child.runId, 120_000);
    expect(event, "busy leg: child event never landed").toBeDefined();
    const stillBusy = await paneStatus(owner.paneId);
    expect(stillBusy, `event landed outside the busy window (owner=${stillBusy})`).not.toBe("idle");
    // The event persisted while the owner was working: the hint sink must have
    // dropped it — and nothing may send once the pane goes idle again.
    const idleAgain = await waitStatus(owner.paneId, ["idle", "done"], 240_000);
    expect(idleAgain, "pi owner never returned to idle").toBeDefined();
    await new Promise((settle) => setTimeout(settle, 6_000));
    expect(mailboxPrompts(proxy!, owner.paneId).slice(promptsBefore), "busy owner received a hint prompt").toHaveLength(0);
    process.stderr.write(`C9_LEG pi busy-owner zero-prompts events=${event!.length}\n`);
  }, 600_000);

  it("pi: bursts inside the 5s window coalesce to one prompt", async () => {
    const owner = owners.get("pi")!;
    const settledOwner = await waitStatus(owner.paneId, ["idle", "done"], 240_000);
    expect(settledOwner, "pi owner not settled before the burst").toBeDefined();
    const [first, second] = await Promise.all([
      stagedChild(owner, "N42COAL1"),
      stagedChild(owner, "N42COAL2"),
    ]);
    await bounceDaemon();
    const promptsBefore = mailboxPrompts(proxy!, owner.paneId).length;
    const known = new Set((await unreadEvents(owner)).map((event) => String(event.id)));
    // Two supervised panes close together: each bound supervisor emits
    // pane_closed, a burst well inside the 5 s coalescing window.
    await Promise.all([
      execFileAsync("herdr", ["--session", REQUIRED_SESSION, "pane", "close", first.paneId!], { cwd: repoRoot }),
      execFileAsync("herdr", ["--session", REQUIRED_SESSION, "pane", "close", second.paneId!], { cwd: repoRoot }),
    ]);
    const landed = await waitForCondition(
      () => unreadEvents(owner),
      (events) => events.filter((event) => !known.has(String(event.id))).length >= 2,
      120_000,
      500,
    );
    expect(landed, "coalesce leg: fewer than two events landed").toBeDefined();
    const fresh = landed!.filter((event) => !known.has(String(event.id))).map((event) => eventTimestamp(String(event.id))).filter((at) => !Number.isNaN(at));
    expect(Math.max(...fresh) - Math.min(...fresh), "burst events landed more than 5s apart").toBeLessThan(5_000);
    const prompt = await waitForCondition(
      async () => mailboxPrompts(proxy!, owner.paneId).slice(promptsBefore),
      (prompts) => prompts.length >= 1,
      60_000,
      250,
    );
    expect(prompt, "coalesce leg: burst produced no hint").toBeDefined();
    await new Promise((settle) => setTimeout(settle, 8_000));
    expect(mailboxPrompts(proxy!, owner.paneId).slice(promptsBefore), "burst produced more than one hint").toHaveLength(1);
    process.stderr.write(`C9_LEG pi coalesce burst=${fresh.length} prompts=1\n`);
  }, 600_000);

  it("claude: an idle owner receives exactly one §11 hint and consumes it as a turn", async () => {
    await consumeLeg("claude");
  }, 600_000);

  it("devin: consumes the §11 hint as a turn, plus the C8 raw-prompt follow-up", async () => {
    await consumeLeg("devin");
    // devin settles slowly; keep the leg timeout above its settle window.
    const owner = owners.get("devin")!;
    // C8: a raw `herdr agent prompt` sent to a verified-idle Devin pane is
    // consumed as a turn, never left queued in the composer.
    const fresh = await waitStatus(owner.paneId, ["idle", "done"], 60_000);
    expect(fresh, "devin pane not idle for the C8 send").toBeDefined();
    await cliPrompt(owner.paneId, "Reply with the exact token N42C8OK and nothing else.");
    const working = await waitForCondition(async () => paneStatus(owner.paneId).catch(() => ""), (status) => status === "working", 30_000, 250);
    expect(working, "devin pane never went working — raw prompt left queued (C8)").toBeDefined();
    const settled = await waitStatus(owner.paneId, ["idle", "done"], 240_000);
    expect(settled, "devin pane never settled after the C8 prompt").toBeDefined();
    const transcript = await waitForCondition(async () => transcriptText(owner), (screen) => screen.includes("N42C8OK"), 60_000, 1_000);
    expect(transcript ?? "", "devin transcript shows no C8 token").toContain("N42C8OK");
    process.stderr.write(`C9_LEG devin c8-raw-prompt consumed workingSeen=${working !== undefined}\n`);
  }, 1_200_000);

  it("agy: inert — no daemon session, no prompts, even when configured", async () => {
    const owner = owners.get("agy")!;
    // An agy pane never carries an agent_session, so the D2a gate refuses every
    // daemon call for it — it can never own a run, a mailbox, or a hint.
    const status = await call(owner.client, "herdr_status", {});
    expect(status.isError).toBe(true);
    expect(String(record(JSON.parse(text(status))).code)).toBe("MANAGER_SESSION_UNAVAILABLE");
    const launch = await call(owner.client, "herdr_launch", {
      task: { objective: "noop", scope: "none", doneWhen: ["noop"] },
      idempotencyKey: "n42-agy-1",
    });
    expect(launch.isError).toBe(true);
    expect(String(record(JSON.parse(text(launch))).code)).toBe("MANAGER_SESSION_UNAVAILABLE");
    expect(mailboxPrompts(proxy!, owner.paneId), "agy pane received a prompt frame").toHaveLength(0);
    process.stderr.write("C9_LEG agy inert refusals=MANAGER_SESSION_UNAVAILABLE prompts=0\n");
  }, 120_000);

  it("launch-path gate: a fresh launch-bound supervisor persists its run events", async () => {
    const owner = owners.get("pi")!;
    // No daemon bounce here: the event must land through the supervisor the
    // launch itself bound (N2.2 — `settings.eventWriter` on the reservation).
    const child = await launchChild(owner, "N42DIRECT1", 45);
    const event = await waitRunEvent(owner, child.runId, 180_000);
    expect(
      event,
      "no run-scoped mailbox event persisted for a launch-bound supervisor " +
      "(launch reservations pass no settings.eventWriter — src/tools/launch.ts; " +
      "the daemon JobRegistry likewise carries no eventWriter — N2.2 wiring gap)",
    ).toBeDefined();
  }, 600_000);

  it("stock daemon: the production default qualified set is the C9-proved three kinds", async () => {
    const owner = owners.get("pi")!;
    // Static: the production entrypoint must never read the disposable knob —
    // the fixture's env override is the only place the set is configurable —
    // and its runtime call ships exactly {pi, claude, devin}, never agy.
    const mainSource = await readFile(join(repoRoot, "src/daemon/main.ts"), "utf8");
    const binSource = await readFile(join(repoRoot, "bin/herdr-tools-daemon.mjs"), "utf8");
    expect(mainSource, "production entrypoint references the disposable hint knob").not.toContain("HERDR_TOOLS_DISPOSABLE_HINT_KINDS");
    expect(binSource, "production launcher references the disposable hint knob").not.toContain("HERDR_TOOLS_DISPOSABLE_HINT_KINDS");
    expect(mainSource, "production runtime call does not pass the proved hint set").toMatch(/hintKinds:\s*\[\s*"pi",\s*"claude",\s*"devin"\s*\]/su);
    expect(mainSource, "production hint set admits agy").not.toMatch(/hintKinds:[^\n]*agy/su);

    // Live: a still-working child survives the swap, the stock daemon's D4
    // sweep rebinds it with the mailbox writer, and its close now hints the
    // idle pi owner exactly once — the qualified set is non-empty.
    const child = await launchChild(owner, "N42STOCK1", 90);
    await stopDisposableServer(daemon);
    daemon = undefined;
    daemon = spawnDaemon(stockDaemonEntry, {});
    await waitDaemonListening();
    child.paneId = String((await agentInfo(child.name)).pane_id);
    const promptsBefore = mailboxPrompts(proxy!, owner.paneId).length;
    const known = new Set((await unreadEvents(owner)).map((event) => String(event.id)));
    await execFileAsync("herdr", ["--session", REQUIRED_SESSION, "pane", "close", child.paneId!], { cwd: repoRoot });
    const landed = await waitForCondition(
      () => unreadEvents(owner),
      (events) => events.filter((event) => !known.has(String(event.id))).length >= 1,
      120_000,
      500,
    );
    expect(landed, "stock daemon produced no mailbox event for the rebound child").toBeDefined();
    const idle = await waitStatus(owner.paneId, ["idle", "done"], 60_000);
    expect(idle, "pi owner not idle during stock leg").toBeDefined();
    const prompt = await waitForCondition(
      async () => mailboxPrompts(proxy!, owner.paneId).slice(promptsBefore),
      (prompts) => prompts.length >= 1,
      60_000,
      250,
    );
    expect(prompt, "stock daemon wrote no hint prompt").toBeDefined();
    expect(prompt![0].text, "stock hint body deviates from the §11 form").toMatch(/^herdr mailbox: \d+ unread \([^)]*\) at \S+; read via your MCP surface \(herdr_status \/ executor → MCP\)$/u);
    await new Promise((settle) => setTimeout(settle, 8_000));
    expect(mailboxPrompts(proxy!, owner.paneId).slice(promptsBefore), "stock daemon wrote more than one hint").toHaveLength(1);
    process.stderr.write(`C9_LEG stock three-kind-qualified prompts=1\n`);
  }, 600_000);
});
