#!/home/gabriel/.volta/tools/image/node/25.9.0/bin/node
/* global AbortSignal, fetch */
import { realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const EXECUTOR_ORIGIN = "https://dev-server.piranha-palermo.ts.net";
const TOKEN_ENV = "/home/gabriel/.hermes/.env";
const TOOLKIT = "coding-agents";

export function desiredConnectionPatterns(connections) {
  return connections
    .filter(({ address, integration }) =>
      typeof address === "string" && address.startsWith("tools.") &&
      typeof integration === "string" && integration !== "hindsight" &&
      !integration.startsWith("hindsight-bank-"),
    )
    .map(({ address }) => `${address.slice("tools.".length)}.*`)
    .sort();
}

export function executorToolkitUrl(url) {
  const endpoint = new URL(url);
  endpoint.searchParams.set("artifacts", "false");
  return endpoint.toString();
}

// A dead upstream session is either a transport close (MCP -32000) or the
// Executor daemon's "Session not found" JSON-RPC -32001 after its restart.
function isTransportLoss(error) {
  return error !== null && typeof error === "object" && typeof error.code === "number"
    && (error.code === ErrorCode.ConnectionClosed || error.code === -32001);
}

export function createProxyHandlers(connectUpstream) {
  // The upstream is lazy and reconnects: an Executor daemon restart leaves the
  // cached client holding a dead HTTP session, so a transport loss drops it and
  // the next call connects fresh. One reconnect per call, never a retry loop.
  let upstream;
  let opening;
  const ensureUpstream = () => {
    if (upstream !== undefined) return Promise.resolve(upstream);
    opening ??= connectUpstream().then(client => {
      client.onclose = () => { if (upstream === client) upstream = undefined; };
      upstream = client;
      return client;
    }).finally(() => { opening = undefined; });
    return opening;
  };
  const reconnectable = async call => {
    try {
      return await call(await ensureUpstream());
    } catch (error) {
      if (!isTransportLoss(error)) throw error;
      upstream = undefined;
      return call(await ensureUpstream());
    }
  };
  return {
    listTools: () => reconnectable(client => client.listTools()),
    callTool: request => reconnectable(client => client.callTool(request.params)),
    close: async () => {
      const client = upstream;
      upstream = undefined;
      await client?.close();
    },
  };
}

class HttpError extends Error {
  constructor(method, path, status) {
    super(`Executor API ${method} ${path} failed with HTTP ${status}`);
    this.status = status;
  }
}

async function requestJson(token, method, path, body) {
  const response = await fetch(`${EXECUTOR_ORIGIN}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new HttpError(method, path, response.status);
  return response.status === 204 ? null : response.json();
}

async function ensureToolkit(token) {
  let listed = await requestJson(token, "GET", "/toolkits");
  let toolkit = listed.toolkits.find(entry => entry.slug === TOOLKIT);
  if (!toolkit) {
    try {
      await requestJson(token, "POST", "/toolkits", { owner: "user", name: "Coding agents", slug: TOOLKIT });
    } catch (error) {
      if (!(error instanceof HttpError) || ![400, 409].includes(error.status)) throw error;
    }
    listed = await requestJson(token, "GET", "/toolkits");
    toolkit = listed.toolkits.find(entry => entry.slug === TOOLKIT);
  }
  if (!toolkit || toolkit.owner !== "user") throw new Error("Coding-agents toolkit is missing or has the wrong owner");
  return toolkit;
}

async function syncToolkitConnections(token, toolkit, desired) {
  const path = `/toolkits/${encodeURIComponent(toolkit.id)}/connections`;
  const current = (await requestJson(token, "GET", path)).connections;
  const wanted = new Set(desired);
  for (const connection of current) {
    if (!wanted.has(connection.pattern)) await requestJson(token, "DELETE", `${path}/${encodeURIComponent(connection.id)}`);
  }
  const existing = new Set(current.map(connection => connection.pattern));
  for (const pattern of desired) {
    if (!existing.has(pattern)) {
      try { await requestJson(token, "POST", path, { pattern }); } catch (error) {
        if (!(error instanceof HttpError) || ![400, 409].includes(error.status)) throw error;
        const refreshed = (await requestJson(token, "GET", path)).connections;
        if (!refreshed.some(connection => connection.pattern === pattern)) throw error;
      }
    }
  }
}

function loadToken() {
  if (!process.env.MCP_EXECUTOR_API_KEY) process.loadEnvFile(TOKEN_ENV);
  const token = process.env.MCP_EXECUTOR_API_KEY;
  if (!token) throw new Error("MCP_EXECUTOR_API_KEY is not configured");
  return token;
}

async function main() {
  const token = loadToken();
  const connections = await requestJson(token, "GET", "/connections");
  const toolkit = await ensureToolkit(token);
  await syncToolkitConnections(token, toolkit, desiredConnectionPatterns(connections));
  if (process.argv.includes("--sync")) {
    process.stdout.write(`${JSON.stringify({ toolkit: TOOLKIT, memoryIncluded: false })}\n`);
    return;
  }
  const connectUpstream = async () => {
    const client = new Client({ name: "executor-coding-agents", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(
      new URL(executorToolkitUrl(`${EXECUTOR_ORIGIN}/mcp/toolkits/${TOOLKIT}`)),
      { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
    ));
    return client;
  };
  const handlers = createProxyHandlers(connectUpstream);
  const server = new Server({ name: "executor-coding-agents", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, handlers.listTools);
  server.setRequestHandler(CallToolRequestSchema, handlers.callTool);
  server.onclose = () => handlers.close();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch(error => {
    process.stderr.write(`executor-coding-agents: ${error instanceof HttpError ? error.message : "startup failed"}\n`);
    process.exitCode = 1;
  });
}
