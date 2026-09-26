import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime } from "../../index.js";
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
    const reservation = await runtime.supervision.reserve({ child: { agentName: "worker", agentKind: "pi", operatingPointId: "worker-pi" } });
    await reservation.bind({ identity, operatingPointId: "worker-pi" });
    expect(runtime.jobs.get(reservation.jobId)).toMatchObject({ kind: "supervisor", supervision: { state: "active" } });

    socket.push(paneUpdated("blocked", 4));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.content).toContain("HIGH PRIORITY: ");
    expect(sent[0]!.content).toContain("blocked");
    expect(sent[0]!.options).toEqual({ deliverAs: "steer", triggerTurn: true });
    await runtime.supervision.shutdown();
  });
});
