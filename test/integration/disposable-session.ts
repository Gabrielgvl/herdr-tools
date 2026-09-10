import { createConnection, createServer, type Server, type Socket } from "node:net";
import { unlink } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";

export interface PromptSocketRequest {
  id: string;
  method: string;
  target?: string;
  text?: string;
}

export interface DisposableSocketProxy {
  readonly path: string;
  readonly requests: PromptSocketRequest[];
  close(): Promise<void>;
}

interface SocketProxyOptions {
  onRequest?: (request: PromptSocketRequest) => void | Promise<void>;
}

const UPSTREAM_GRACE_MS = 30_000;

function promptRequest(value: unknown): PromptSocketRequest | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const frame = value as { id?: unknown; method?: unknown; params?: unknown };
  if (typeof frame.id !== "string" || frame.method !== "agent.prompt" || typeof frame.params !== "object" || frame.params === null || Array.isArray(frame.params)) return undefined;
  const params = frame.params as { target?: unknown; text?: unknown };
  return {
    id: frame.id,
    method: frame.method,
    ...(typeof params.target === "string" ? { target: params.target } : {}),
    ...(typeof params.text === "string" ? { text: params.text } : {})
  };
}

async function removeSocket(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
}

/**
 * Forward the candidate socket unchanged while recording only prompt request
 * metadata. The proxy is fixture-owned and never replaces the real Herdr
 * endpoint; it makes a socket delivery countable by the live integration.
 */
export async function startDisposableSocketProxy(targetPath: string, path: string, options: SocketProxyOptions = {}): Promise<DisposableSocketProxy> {
  await removeSocket(path);
  const requests: PromptSocketRequest[] = [];
  const clients = new Set<Socket>();
  const upstreams = new Set<Socket>();
  const server: Server = createServer((client) => {
    clients.add(client);
    const upstream = createConnection({ path: targetPath });
    upstreams.add(upstream);
    let input = "";
    const capture = (chunk: Buffer): PromptSocketRequest[] => {
      input += chunk.toString("utf8");
      const complete: PromptSocketRequest[] = [];
      let newline = input.indexOf("\n");
      while (newline >= 0) {
        const line = input.slice(0, newline);
        input = input.slice(newline + 1);
        try {
          const request = promptRequest(JSON.parse(line));
          if (request) complete.push(request);
        } catch {
          // The real endpoint remains responsible for protocol validation.
        }
        newline = input.indexOf("\n");
      }
      return complete;
    };
    let forwarding = Promise.resolve();
    client.on("data", (chunk: Buffer) => {
      forwarding = forwarding.then(async () => {
        const observations: Array<Promise<void> | void> = [];
        const captured = capture(chunk);
        upstream.write(chunk);
        for (const request of captured) {
          requests.push(request);
          observations.push(options.onRequest?.(request));
        }
        for (const observation of observations) await observation;
      }).catch(() => {
        client.destroy();
        upstream.destroy();
      });
    });
    let upstreamCloseTimer: ReturnType<typeof setTimeout> | undefined;
    upstream.on("data", (chunk: Buffer) => {
      if (!client.destroyed) client.write(chunk);
    });
    const close = () => {
      clients.delete(client);
      upstreamCloseTimer = setTimeout(() => upstream.destroy(), UPSTREAM_GRACE_MS);
    };
    const fail = () => {
      clients.delete(client);
      upstreams.delete(upstream);
      upstream.destroy();
    };
    client.once("close", close);
    client.once("error", fail);
    upstream.once("close", () => {
      upstreams.delete(upstream);
      if (upstreamCloseTimer) clearTimeout(upstreamCloseTimer);
      client.destroy();
    });
    upstream.once("error", fail);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return {
    path,
    requests,
    close: async () => {
      for (const client of clients) client.destroy();
      for (const upstream of upstreams) upstream.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await removeSocket(path);
    }
  };
}

export async function waitForCondition<T>(
  sample: () => Promise<T>,
  matches: (value: T) => boolean,
  timeoutMs: number,
  intervalMs = 100
): Promise<T | undefined> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await sample();
    if (matches(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return undefined;
}

/**
 * A named integration server is a process-owned resource. Do not let the next
 * test recreate the same session until this child has actually exited.
 */
export async function stopDisposableServer(server: ChildProcess | undefined): Promise<void> {
  if (!server || server.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      server.removeListener("close", finish);
      server.removeListener("error", finish);
      resolve();
    };
    server.once("close", finish);
    server.once("error", finish);
    if (!server.kill("SIGTERM") && server.exitCode !== null) finish();
  });
}
