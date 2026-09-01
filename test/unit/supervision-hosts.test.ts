import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime } from "../../index.js";
import { runHerdrMcpServer } from "../../src/mcp/run.js";
import type { SupervisedIdentity } from "../../src/supervision/identity.js";

const session = { source: "herdr:pi", agent: "pi", kind: "id", value: "s1" };
const identity: SupervisedIdentity = { paneId: "p1", terminalId: "t1", agentName: "worker", agentKind: "pi", agentSession: session };
const pane = { pane_id: "p1", terminal_id: "t1", tab_id: "t", workspace_id: "w", agent_status: "idle", revision: 3, agent: "pi", agent_session: session };
const snapshot = { type: "session_snapshot", snapshot: { version: "0.8.2", protocol: 20, workspaces: [], tabs: [], panes: [pane], agents: [{ pane_id: "p1", name: "worker" }] } };

const servers: Server[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A real Herdr-shaped socket: snapshots on demand, one acknowledged subscription. */
async function herdrSocket(): Promise<{ path: string; push(line: string): void }> {
  const directory = mkdtempSync(join(tmpdir(), "herdr-hosts-"));
  directories.push(directory);
  const path = join(directory, "herdr.sock");
  const clients = new Set<Socket>();
  const server = createServer((socket) => {
    clients.add(socket);
    // Every `session.snapshot` is its own short-lived connection, so by the time
    // an event is pushed most of these sockets are already gone. A closed peer
    // is forgotten rather than written to, and a write that still loses the race
    // is absorbed here: an unhandled socket error is an uncaught exception.
    const forget = (): void => { clients.delete(socket); };
    socket.on("close", forget);
    socket.on("error", forget);
    socket.on("data", (chunk) => {
      for (const line of chunk.toString("utf8").split("\n").filter((value) => value.trim().length > 0)) {
        const request = JSON.parse(line) as { id: string; method: string };
        const result = request.method === "session.snapshot" ? snapshot : { type: "subscription_started" };
        socket.write(`${JSON.stringify({ id: request.id, result })}\n`);
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(path, () => resolve()));
  return { path, push: (line) => { for (const client of clients) if (!client.destroyed) client.write(line); } };
}

const paneUpdated = (status: string, revision: number): string =>
  `${JSON.stringify({ event: "pane_updated", data: { type: "pane_updated", pane: { ...pane, agent_status: status, revision } } })}\n`;

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
    runtime.supervision.shutdown();
  });
});

describe("the MCP host supervision wiring", () => {
  it("advertises the channel capability, resolves its own model service, and wakes by channel notification", async () => {
    const socket = await herdrSocket();
    const directory = mkdtempSync(join(tmpdir(), "herdr-project-"));
    directories.push(directory);
    const notifications: Array<{ method: string }> = [];
    const transport = {
      start: async () => undefined,
      send: async (message: { method?: string }) => { if (message.method) notifications.push({ method: message.method }); },
      close: async () => undefined,
      onclose: undefined,
      onerror: undefined,
      onmessage: undefined,
    };
    // No `env` dependency: the host falls back to the ambient process environment
    // for both startup gating and the supervision monitor.
    const ambient: Record<string, string | undefined> = { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w", HERDR_TAB_ID: "t", HERDR_PANE_ID: "p1", CLAUDE_PROJECT_DIR: directory, HERDR_SOCKET_PATH: socket.path };
    const previous = Object.fromEntries(Object.keys(ambient).map((key) => [key, process.env[key]]));
    Object.assign(process.env, ambient);
    const server = await runHerdrMcpServer({
      exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
      transport: transport as never,
      exit: () => undefined,
    });
    try {
      expect(server).toBeDefined();
      expect((server!.server as unknown as { _capabilities: Record<string, unknown> })._capabilities).toMatchObject({ experimental: { "claude/channel": {} }, tools: {} });

      const reservation = await server!.supervision.reserve({ child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" } });
      await reservation.bind({ identity, profileName: "worker-pi" });
      socket.push(paneUpdated("blocked", 4));
      await vi.waitFor(() => expect(notifications.some((message) => message.method === "notifications/claude/channel")).toBe(true));
      await server!.shutdown();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
