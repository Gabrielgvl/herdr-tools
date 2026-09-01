import type { SupervisionStream } from "../../src/supervision/socket.js";

/**
 * A scripted Herdr socket peer.
 *
 * Herdr 0.8.2 answers exactly one request per connection, so this peer does the
 * same: every connect gets a fresh stream, a stream answers once, and only the
 * stream that issued `events.subscribe` carries pushed events.
 */
export interface ScriptedServer {
  connect(): Promise<SupervisionStream>;
  push(line: string): void;
  closeSubscription(): void;
  readonly requests: readonly string[];
  readonly connects: number;
}

export interface ScriptedServerOptions {
  /** Answers `events.subscribe` with the wrong result type. */
  failSubscribe?: boolean;
  /** Consumed in order by `session.snapshot`; the last one repeats. */
  snapshots?: unknown[];
}

export const emptySnapshotResult = {
  type: "session_snapshot",
  snapshot: { version: "0.8.2", protocol: 20, workspaces: [], tabs: [], panes: [], agents: [] },
};

export function scriptedServer(options: ScriptedServerOptions = {}): ScriptedServer {
  const queue = [...(options.snapshots ?? [])];
  const requests: string[] = [];
  let connects = 0;
  let pushTo: ((chunk: Buffer) => void) | undefined;
  let closeSubscribed: (() => void) | undefined;
  let lastSnapshot: unknown;
  return {
    connect: async () => {
      connects += 1;
      let onData: (chunk: Buffer) => void = () => undefined;
      let onClose: (() => void) | undefined;
      let answered = false;
      return {
        write: (line) => {
          const request = JSON.parse(line) as { id: string; method: string };
          requests.push(request.method);
          if (answered) return;
          answered = true;
          queueMicrotask(() => {
            if (request.method === "session.snapshot") {
              lastSnapshot = queue.shift() ?? lastSnapshot ?? emptySnapshotResult;
              onData(Buffer.from(`${JSON.stringify({ id: request.id, result: lastSnapshot })}\n`, "utf8"));
              return;
            }
            if (options.failSubscribe) {
              onData(Buffer.from(`${JSON.stringify({ id: request.id, result: { type: "pong" } })}\n`, "utf8"));
              return;
            }
            pushTo = onData;
            closeSubscribed = () => onClose?.();
            onData(Buffer.from(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`, "utf8"));
          });
        },
        destroy: () => undefined,
        onData: (handler) => { onData = handler; },
        onClose: (handler) => { onClose = () => handler(); },
      };
    },
    push: (line) => pushTo?.(Buffer.from(line, "utf8")),
    closeSubscription: () => closeSubscribed?.(),
    get requests() { return requests; },
    get connects() { return connects; },
  };
}
