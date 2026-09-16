import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime } from "../../index.js";
import type { PiExec } from "../../src/cli.js";
import { runHerdrMcpServer } from "../../src/mcp/run.js";
import type { SupervisedIdentity } from "../../src/supervision/identity.js";

const session = { source: "herdr:pi", agent: "pi", kind: "id", value: "s1" };
const identity: SupervisedIdentity = { paneId: "p1", terminalId: "t1", agentName: "worker", agentKind: "pi", agentSession: session };
const pane = { pane_id: "p1", terminal_id: "t1", tab_id: "t", workspace_id: "w", agent_status: "idle", revision: 3, agent: "pi", agent_session: session };
const snapshot = { type: "session_snapshot", snapshot: { version: "0.8.2", protocol: 22, workspaces: [], tabs: [], panes: [pane], agents: [{ pane_id: "p1", name: "worker" }] } };

const servers: Server[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

interface FakeHerdrSocket {
  path: string;
  prompts: Array<{ target: string; text: string }>;
  connections: number;
  push(line: string): void;
}

/**
 * A real Herdr-shaped socket: snapshots on demand, one acknowledged
 * subscription, and an `agent.prompt` endpoint that returns a typed
 * `agent_prompted` ack whose identity is taken verbatim from the ack map.
 */
async function herdrSocket(
  snapshotResult: unknown = snapshot,
  acks: Record<string, Record<string, unknown>> = {},
): Promise<FakeHerdrSocket> {
  const directory = mkdtempSync(join(tmpdir(), "herdr-hosts-"));
  directories.push(directory);
  const path = join(directory, "herdr.sock");
  const clients = new Set<Socket>();
  const prompts: Array<{ target: string; text: string }> = [];
  const handle: FakeHerdrSocket = { path, prompts, connections: 0, push: (line) => { for (const client of clients) if (!client.destroyed) client.write(line); } };
  const server = createServer((socket) => {
    clients.add(socket);
    handle.connections += 1;
    // Every `session.snapshot` is its own short-lived connection, so by the time
    // an event is pushed most of these sockets are already gone. A closed peer
    // is forgotten rather than written to, and a write that still loses the race
    // is absorbed here: an unhandled socket error is an uncaught exception.
    const forget = (): void => { clients.delete(socket); };
    socket.on("close", forget);
    socket.on("error", forget);
    socket.on("data", (chunk) => {
      for (const line of chunk.toString("utf8").split("\n").filter((value) => value.trim().length > 0)) {
        const request = JSON.parse(line) as { id: string; method: string; params?: { target?: string; text?: string } };
        let result: unknown = { type: "subscription_started" };
        if (request.method === "session.snapshot") result = snapshotResult;
        if (request.method === "agent.prompt") {
          prompts.push({ target: request.params?.target ?? "", text: request.params?.text ?? "" });
          result = { type: "agent_prompted", agent: acks[request.params?.target ?? ""] ?? {} };
        }
        socket.write(`${JSON.stringify({ id: request.id, result })}\n`);
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(path, () => resolve()));
  return handle;
}

const paneUpdated = (status: string, revision: number, paneRecord: Record<string, unknown> = pane): string =>
  `${JSON.stringify({ event: "pane_updated", data: { type: "pane_updated", pane: { ...paneRecord, agent_status: status, revision } } })}\n`;

/**
 * The exec seam behind the reads the host wake pipeline issues: `pane get` for
 * own-pane kind resolution and the sandwich, `pane current` + `api snapshot`
 * for effective-context resolution, `agent get` for the sandwich agent record.
 */
function wakeExec(fixture: {
  panes: Record<string, Record<string, unknown>>;
  agents?: Record<string, Record<string, unknown>>;
  current?: Record<string, unknown>;
  snapshot?: unknown;
  onClose?: (paneId: string) => void | Promise<void>;
}): { exec: PiExec; calls: string[][] } {
  const calls: string[][] = [];
  const envelope = (id: string, result: unknown): { stdout: string; stderr: string; code: number; killed: boolean } =>
    ({ stdout: JSON.stringify({ id, result }), stderr: "", code: 0, killed: false });
  const health = {
    client: { version: "0.9.0", protocol: 22, endpoint_protocol_generation: 1 },
    server: { status: "running", version: "0.9.0", protocol: 22, compatible: true, endpoint_compatible: true, capabilities: { endpoint_protocol_generation: 1 } }
  };
  const exec: PiExec = async (_command, argv) => {
    calls.push(argv);
    if (argv[0] === "status") return { stdout: JSON.stringify(health), stderr: "", code: 0, killed: false };
    if (argv[0] === "pane" && argv[1] === "get") return envelope("pane-get", { pane: fixture.panes[argv[2]!] });
    if (argv[0] === "pane" && argv[1] === "current") return envelope("pane-current", { type: "pane_current", pane: fixture.current });
    if (argv[0] === "api" && argv[1] === "snapshot") return envelope("snapshot", fixture.snapshot);
    if (argv[0] === "agent" && argv[1] === "get") return envelope("agent-get", { agent: fixture.agents?.[argv[2]!] });
    if (argv[0] === "pane" && argv[1] === "close") {
      await fixture.onClose?.(argv[2]!);
      return envelope("close", { ok: true });
    }
    return envelope("other", { ok: true });
  };
  return { exec, calls };
}

describe("the Pi host supervision wiring", () => {
  it("reserves through the injected socket, resolves the reviewer model, and wakes by steer", async () => {
    const socket = await herdrSocket();
    const sent: Array<{ content: string; options: unknown }> = [];
    const runtime = createRuntime(
      {
        exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
        sendMessage: (message: { content: string }, options: unknown) => { sent.push({ content: message.content, options }); return Promise.resolve(); },
      } as never,
      { HERDR_SOCKET_PATH: socket.path, HERDR_WORKSPACE_ID: "w", HERDR_TAB_ID: "t", HERDR_PANE_ID: "p1" },
    );
    // The reviewer resolves through the registry the session context supplies.
    runtime.bindModelRegistry({ find: () => undefined, getAll: () => [], getApiKeyAndHeaders: async () => ({ ok: false, error: "no credential" }) });

    const reservation = await runtime.supervision.reserve({ child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" } });
    await reservation.bind({ identity, profileName: "worker-pi" });
    expect(runtime.jobs.get(reservation.jobId)).toMatchObject({ kind: "supervisor", supervision: { state: "active" } });

    socket.push(paneUpdated("blocked", 4));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.content).toContain("HIGH PRIORITY: ");
    expect(sent[0]!.content).toContain("blocked");
    expect(sent[0]!.options).toEqual({ deliverAs: "steer", triggerTurn: true });
    await runtime.supervision.shutdown();
  });
});

describe("the MCP host supervision wiring", () => {
  /** Save/set/restore the ambient env the host reads at startup. */
  async function withAmbient(env: Record<string, string>, run: () => Promise<void>): Promise<void> {
    const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, env);
    try {
      await run();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  const claudePane = { ...pane, agent: "claude", agent_session: { ...session, agent: "claude" } };

  it("advertises the channel capability, wakes a claude host by channel notification, and never prompts", async () => {
    const socket = await herdrSocket();
    const directory = mkdtempSync(join(tmpdir(), "herdr-project-"));
    directories.push(directory);
    const notifications: Array<{ method: string; params: { content: string; meta: Record<string, unknown> } }> = [];
    const { exec, calls } = wakeExec({ panes: { p1: claudePane } });
    let callsAtConnect = -1;
    let connectionsAtConnect = -1;
    const transport = {
      start: async () => { callsAtConnect = calls.length; connectionsAtConnect = socket.connections; },
      send: async (message: { method?: string; params?: { content: string; meta: Record<string, unknown> } }) => { if (message.method) notifications.push({ method: message.method, params: message.params! }); },
      close: async () => undefined,
      onclose: undefined,
      onerror: undefined,
      onmessage: undefined,
    };
    // No `env` dependency: the host falls back to the ambient process environment
    // for both startup gating and the supervision monitor.
    await withAmbient(
      { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w", HERDR_TAB_ID: "t", HERDR_PANE_ID: "p1", HERDR_PROJECT_DIR: directory, HERDR_SOCKET_PATH: socket.path },
      async () => {
        const server = await runHerdrMcpServer({ exec, transport: transport as never, exit: () => undefined });
        try {
          expect(server).toBeDefined();
          // Startup stays side-effect free: no CLI read or socket connection ran
          // before the transport connected.
          expect(callsAtConnect).toBe(0);
          expect(connectionsAtConnect).toBe(0);
          expect((server!.server as unknown as { _capabilities: Record<string, unknown> })._capabilities).toMatchObject({ experimental: { "claude/channel": {} }, tools: {} });

          const reservation = await server!.supervision.reserve({ child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" } });
          await reservation.bind({ identity, profileName: "worker-pi" });
          socket.push(paneUpdated("blocked", 4));
          await vi.waitFor(() => expect(notifications.some((message) => message.method === "notifications/claude/channel")).toBe(true));
          // Claude is Channels-only: one lazy `pane get` resolved the kind and
          // the prompt socket never saw a write.
          expect(socket.prompts).toHaveLength(0);
          expect(calls.filter((argv) => argv[0] === "pane" && argv[1] === "get")).toHaveLength(1);
          expect(notifications[0]!.params.meta).toMatchObject({ kind: "supervisor", eventType: "blocked" });
        } finally {
          await server?.shutdown();
        }
      },
    );
  });

  it("self-prompts a devin host pane for supervision wakes and wait settlements", async () => {
    const devinSession = { source: "herdr:devin", agent: "devin", kind: "id", value: "m-1" };
    const ownPane = { pane_id: "p1", terminal_id: "t1", tab_id: "t", workspace_id: "w", label: "manager", agent_name: "manager", agent_status: "idle", revision: 3, agent: "devin", agent_session: devinSession };
    const ownAgent = { pane_id: "p1", name: "manager", agent: "devin", terminal_id: "t1", agent_session: devinSession, agent_status: "idle" };
    const childPane = { ...pane, pane_id: "p2", terminal_id: "t2" };
    const hostSnapshot = {
      type: "session_snapshot",
      snapshot: {
        version: "0.8.2",
        protocol: 22,
        workspaces: [{ workspace_id: "w", label: "w" }],
        tabs: [{ tab_id: "t", workspace_id: "w", label: "t" }],
        panes: [ownPane, childPane],
        agents: [ownAgent, { pane_id: "p2", name: "worker" }],
      },
    };
    const promptAck = { pane_id: "p1", terminal_id: "t1", name: "manager", agent: "devin", agent_session: devinSession, interactive_ready: true, revision: 4 };
    const socket = await herdrSocket(hostSnapshot, { p1: promptAck });
    const directory = mkdtempSync(join(tmpdir(), "herdr-project-"));
    directories.push(directory);
    const notifications: Array<{ method: string }> = [];
    const { exec, calls } = wakeExec({ panes: { p1: ownPane, p2: childPane }, agents: { p1: ownAgent }, current: ownPane, snapshot: hostSnapshot });
    const transport = {
      start: async () => undefined,
      send: async (message: { method?: string }) => { if (message.method) notifications.push({ method: message.method }); },
      close: async () => undefined,
      onclose: undefined,
      onerror: undefined,
      onmessage: undefined,
    };
    await withAmbient(
      { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w", HERDR_TAB_ID: "t", HERDR_PANE_ID: "p1", HERDR_PROJECT_DIR: directory, HERDR_SOCKET_PATH: socket.path },
      async () => {
        const server = await runHerdrMcpServer({ exec, transport: transport as never, exit: () => undefined });
        try {
          expect(server).toBeDefined();
          const reservation = await server!.supervision.reserve({ child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" } });
          await reservation.bind({ identity: { ...identity, paneId: "p2", terminalId: "t2" }, profileName: "worker-pi" });
          socket.push(paneUpdated("blocked", 4, childPane));
          await vi.waitFor(() => expect(socket.prompts).toHaveLength(1));
          expect(socket.prompts[0]!.target).toBe("p1");
          expect(socket.prompts[0]!.text).toContain("from: manager (p1)");
          expect(socket.prompts[0]!.text).toContain("kind: supervision");
          expect(socket.prompts[0]!.text).toContain("reported blocked");
          expect(notifications).toHaveLength(0);
          // One lazy `pane get` resolved the kind; the sandwich read it again.
          expect(calls.filter((argv) => argv[0] === "pane" && argv[1] === "get")).toHaveLength(2);

          // A settled wait job wakes the same way under `kind: wait`; a settled
          // supervisor job is suppressed (it already wakes via supervision events).
          const wait = server!.jobs.register(
            { kind: "wait", label: "wait for worker", targets: ["worker"], targetIds: ["p2"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1_000, settings: { reviewCadenceMinutes: 1, reviewerModel: "luna", reviewerThinking: "low" } },
            async () => ({ wait_result: "condition_met" as const, matched: true }),
          );
          const supervisor = server!.jobs.register(
            { kind: "supervisor", label: "watch worker", targets: ["worker"], targetIds: [], child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" }, settings: { reviewCadenceMinutes: 1, reviewerModel: "luna", reviewerThinking: "max" } },
            async () => ({ supervision_result: "released" as const }),
          );
          await wait.promise;
          await supervisor.promise;
          await vi.waitFor(() => expect(socket.prompts).toHaveLength(2));
          expect(socket.prompts[1]!.target).toBe("p1");
          expect(socket.prompts[1]!.text).toContain("kind: wait");
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(socket.prompts).toHaveLength(2);
          expect(notifications).toHaveLength(0);
        } finally {
          await server?.shutdown();
        }
      },
    );
  });

  it("suppresses only the pane_closed wake of a close this host itself proved", async () => {
    const devinSession = { source: "herdr:devin", agent: "devin", kind: "id", value: "m-1" };
    const ownPane = { pane_id: "p1", terminal_id: "t1", tab_id: "t", workspace_id: "w", label: "manager", agent_name: "manager", agent_status: "idle", revision: 3, agent: "devin", agent_session: devinSession };
    const ownAgent = { pane_id: "p1", name: "manager", agent: "devin", terminal_id: "t1", agent_session: devinSession, agent_status: "idle" };
    const childPane = { ...pane, pane_id: "p2", terminal_id: "t2" };
    const otherPane = { ...pane, pane_id: "p3", terminal_id: "t3" };
    const laterPane = { ...pane, pane_id: "p4", terminal_id: "t4" };
    const hostSnapshot = {
      type: "session_snapshot",
      snapshot: {
        version: "0.8.2",
        protocol: 22,
        workspaces: [{ workspace_id: "w", label: "w" }],
        tabs: [{ tab_id: "t", workspace_id: "w", label: "t" }],
        panes: [ownPane, childPane, otherPane, laterPane],
        agents: [ownAgent, { pane_id: "p2", name: "worker" }, { pane_id: "p3", name: "worker" }, { pane_id: "p4", name: "worker" }],
      },
    };
    const remove = (paneId: string): void => {
      hostSnapshot.snapshot.panes = hostSnapshot.snapshot.panes.filter((entry) => entry.pane_id !== paneId);
      hostSnapshot.snapshot.agents = hostSnapshot.snapshot.agents.filter((entry) => entry.pane_id !== paneId);
    };
    const promptAck = { pane_id: "p1", terminal_id: "t1", name: "manager", agent: "devin", agent_session: devinSession, interactive_ready: true, revision: 4 };
    const socket = await herdrSocket(hostSnapshot, { p1: promptAck });
    const directory = mkdtempSync(join(tmpdir(), "herdr-project-"));
    directories.push(directory);
    const notifications: Array<{ method: string }> = [];
    // The close lands in Herdr before its response returns, so the supervisor
    // records, settles, and only then learns whether this host may suppress.
    let closeApplied: string | undefined;
    let releaseClose: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { releaseClose = resolve; });
    const { exec } = wakeExec({
      panes: { p1: ownPane, p2: childPane, p3: otherPane, p4: laterPane },
      agents: { p1: ownAgent },
      current: ownPane,
      snapshot: hostSnapshot,
      onClose: async (paneId) => {
        remove(paneId);
        closeApplied = paneId;
        if (paneId === "p2") await gate;
      },
    });
    const transport = {
      start: async () => undefined,
      send: async (message: { method?: string }) => { if (message.method) notifications.push({ method: message.method }); },
      close: async () => undefined,
      onclose: undefined,
      onerror: undefined,
      onmessage: undefined,
    };
    await withAmbient(
      { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w", HERDR_TAB_ID: "t", HERDR_PANE_ID: "p1", HERDR_PROJECT_DIR: directory, HERDR_SOCKET_PATH: socket.path },
      async () => {
        const server = await runHerdrMcpServer({ exec, transport: transport as never, exit: () => undefined });
        try {
          expect(server).toBeDefined();
          const reservation = await server!.supervision.reserve({ child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" } });
          await reservation.bind({ identity: { ...identity, paneId: "p2", terminalId: "t2" }, profileName: "worker-pi" });

          const closing = server!.surface.pane.execute("close-call", { operation: "close", target: "p2" } as never, new AbortController().signal, undefined, { cwd: directory, hasUI: false } as never);
          await vi.waitFor(() => expect(closeApplied).toBe("p2"));
          socket.push(`${JSON.stringify({ event: "pane_closed", data: { type: "pane_closed", pane_id: "p2", workspace_id: "w" } })}\n`);
          // The supervisor waits for the close's bounded proof before deciding
          // whether this absence is manager-authored or externally meaningful.
          expect(server!.jobs.get(reservation.jobId)).toMatchObject({ operation_phase: "running" });
          releaseClose();
          const result = await closing;
          expect(result.details).toMatchObject({ operation: "close", outcome: "success", paneId: "p2" });
          await vi.waitFor(() => expect(server!.jobs.get(reservation.jobId)).toMatchObject({ operation_phase: "settled", supervision_result: "released" }));
          expect(socket.prompts).toHaveLength(0);
          expect(notifications).toHaveLength(0);

          // A manager-authored close settles silently: no event and no receipt.
          const detail = server!.jobs.get(reservation.jobId)!;
          expect(detail.supervision?.events).toEqual([]);
          expect(detail.unobservedEvents).toBe(0);
          const receipt = await server!.surface.jobs.execute("get-call", { operation: "get", jobId: reservation.jobId } as never, new AbortController().signal, undefined, {} as never);
          expect(receipt.details).not.toHaveProperty("pending_events");

          // A close that finished before its absence was observed takes the
          // same suppression path: the confirmed marker is already waiting.
          const later = await server!.supervision.reserve({ child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" } });
          await later.bind({ identity: { ...identity, paneId: "p4", terminalId: "t4" }, profileName: "worker-pi" });
          const finished = await server!.surface.pane.execute("close-call-2", { operation: "close", target: "p4" } as never, new AbortController().signal, undefined, { cwd: directory, hasUI: false } as never);
          expect(finished.details).toMatchObject({ operation: "close", outcome: "success", paneId: "p4" });
          socket.push(`${JSON.stringify({ event: "pane_closed", data: { type: "pane_closed", pane_id: "p4", workspace_id: "w" } })}\n`);
          await vi.waitFor(() => expect(server!.jobs.get(later.jobId)).toMatchObject({ operation_phase: "settled", supervision_result: "released" }));
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(socket.prompts).toHaveLength(0);
          expect(server!.jobs.get(later.jobId)!.supervision?.events).toEqual([]);

          // An absence this host did not close still wakes exactly once.
          const external = await server!.supervision.reserve({ child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" } });
          await external.bind({ identity: { ...identity, paneId: "p3", terminalId: "t3" }, profileName: "worker-pi" });
          remove("p3");
          socket.push(`${JSON.stringify({ event: "pane_closed", data: { type: "pane_closed", pane_id: "p3", workspace_id: "w" } })}\n`);
          await vi.waitFor(() => expect(socket.prompts).toHaveLength(1));
          expect(socket.prompts[0]!.target).toBe("p1");
          expect(socket.prompts[0]!.text).toContain("reported pane_closed");
          expect(notifications).toHaveLength(0);
        } finally {
          await server?.shutdown();
        }
      },
    );
  });
});
