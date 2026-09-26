#!/home/gabriel/.volta/bin/node
/* global AbortSignal, fetch */

import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { relative, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const EXECUTOR_ORIGIN = "https://dev-server.piranha-palermo.ts.net";
const HINDSIGHT_CONFIG = "/home/gabriel/.hindsight/coding-agent.json";
const HINDSIGHT_SERVER = "/home/gabriel/.hindsight/coding-agents/dist/mcp-server.js";
const TOKEN_ENV = "/home/gabriel/.hermes/.env";
const MEMORY_PREFIX = "hindsight-bank-";

export function resolveProjectBank(config, cwd) {
  const current = realpathSync(cwd);
  const mappings = config?.mapPathToBank;
  if (!mappings || typeof mappings !== "object" || Array.isArray(mappings)) {
    throw new Error("Hindsight path-to-bank mapping is invalid");
  }

  const matches = [];
  for (const [root, bankId] of Object.entries(mappings)) {
    if (typeof root !== "string" || typeof bankId !== "string" || !bankId) continue;
    let canonical;
    try {
      canonical = realpathSync(root);
    } catch {
      continue;
    }
    const rel = relative(canonical, current);
    if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep))) {
      matches.push({ bankId, projectRoot: canonical });
    }
  }

  matches.sort((left, right) => right.projectRoot.length - left.projectRoot.length);
  if (!matches[0]) throw new Error("No Hindsight bank is mapped for this project");
  const selected = matches[0];
  const selectedBanks = new Set(
    matches.filter(({ projectRoot }) => projectRoot === selected.projectRoot).map(({ bankId }) => bankId),
  );
  if (selectedBanks.size !== 1) throw new Error("Ambiguous Hindsight bank mapping for this project");
  return selected;
}

export function bankSlugs(bankId) {
  const id = createHash("sha256").update(bankId).digest("hex").slice(0, 16);
  return { integration: `${MEMORY_PREFIX}${id}`, toolkit: `project-memory-${id}` };
}

export function desiredConnectionPatterns(connections, selectedIntegration) {
  return connections
    .filter(({ address, integration }) =>
      typeof address === "string" &&
      typeof integration === "string" &&
      integration !== "hindsight" &&
      (!integration.startsWith(MEMORY_PREFIX) || integration === selectedIntegration),
    )
    .map(({ address }) => `${address.slice("tools.".length)}.*`)
    .sort();
}

export function executorToolkitUrl(url) {
  const endpoint = new URL(url);
  endpoint.searchParams.set("artifacts", "false");
  return endpoint.toString();
}

export function createProxyHandlers(upstream) {
  return {
    listTools: () => upstream.listTools(),
    callTool: (request) => upstream.callTool(request.params),
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
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new HttpError(method, path, response.status);
  return response.status === 204 ? null : response.json();
}

async function getOrNull(token, path) {
  try {
    return await requestJson(token, "GET", path);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  }
}

async function ensureIntegration(token, integration, projectRoot) {
  const path = `/mcp/servers/${encodeURIComponent(integration)}`;
  let current = await getOrNull(token, path);
  if (!current) {
    try {
      await requestJson(token, "POST", "/mcp/servers", {
        transport: "stdio",
        name: `Hindsight project bank ${integration.slice(-8)}`,
        description: "Project-scoped Hindsight memory selected by the local harness runtime",
        command: "/home/gabriel/.volta/bin/node",
        args: [HINDSIGHT_SERVER],
        staticEnv: {
          HINDSIGHT_MCP_HARNESS: "executor",
          HINDSIGHT_MCP_PROJECT_CWD: projectRoot,
        },
        cwd: projectRoot,
        spawnPerCall: false,
        slug: integration,
      });
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 409) throw error;
    }
    current = await requestJson(token, "GET", path);
  }

  const config = current?.integration?.config ?? current?.config;
  if (
    config?.transport !== "stdio" ||
    config?.cwd !== projectRoot ||
    config?.env?.HINDSIGHT_MCP_PROJECT_CWD !== projectRoot
  ) {
    throw new Error("Existing project-memory integration does not match the mapped project root");
  }
}

async function ensureConnection(token, integration) {
  let connections = await requestJson(token, "GET", "/connections");
  let selected = connections.filter((connection) => connection.integration === integration);
  if (selected.length === 0) {
    try {
      await requestJson(token, "POST", "/connections", {
        owner: "user",
        name: "default",
        integration,
        template: "none",
        value: "",
      });
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 409) throw error;
    }
    connections = await requestJson(token, "GET", "/connections");
    selected = connections.filter((connection) => connection.integration === integration);
  }
  if (selected.length !== 1) throw new Error("Project-memory integration must have exactly one connection");
  return connections;
}

async function ensureToolkit(token, slug) {
  let listed = await requestJson(token, "GET", "/toolkits");
  let toolkit = listed.toolkits.find((entry) => entry.slug === slug);
  if (!toolkit) {
    try {
      await requestJson(token, "POST", "/toolkits", {
        owner: "user",
        name: `Project memory ${slug.slice(-8)}`,
        slug,
      });
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 400) throw error;
    }
    listed = await requestJson(token, "GET", "/toolkits");
    toolkit = listed.toolkits.find((entry) => entry.slug === slug);
  }
  if (!toolkit || toolkit.owner !== "user") throw new Error("Project-memory toolkit is missing or has the wrong owner");
  return toolkit;
}

async function syncToolkitConnections(token, toolkit, desired) {
  const path = `/toolkits/${encodeURIComponent(toolkit.id)}/connections`;
  const current = (await requestJson(token, "GET", path)).connections;
  const wanted = new Set(desired);
  for (const connection of current) {
    if (!wanted.has(connection.pattern)) {
      await requestJson(token, "DELETE", `${path}/${encodeURIComponent(connection.id)}`);
    }
  }
  const existing = new Set(current.map((connection) => connection.pattern));
  for (const pattern of desired) {
    if (!existing.has(pattern)) await requestJson(token, "POST", path, { pattern });
  }
}

async function resolveAndSync(token, cwd) {
  const config = JSON.parse(readFileSync(HINDSIGHT_CONFIG, "utf8"));
  const project = resolveProjectBank(config, cwd);
  const slugs = bankSlugs(project.bankId);
  await ensureIntegration(token, slugs.integration, project.projectRoot);
  const connections = await ensureConnection(token, slugs.integration);
  const toolkit = await ensureToolkit(token, slugs.toolkit);
  const desired = desiredConnectionPatterns(connections, slugs.integration);
  await syncToolkitConnections(token, toolkit, desired);
  return {
    bankId: project.bankId,
    projectRoot: project.projectRoot,
    integration: slugs.integration,
    toolkit: slugs.toolkit,
    url: `${EXECUTOR_ORIGIN}/mcp/toolkits/${slugs.toolkit}`,
  };
}

function loadToken() {
  if (!process.env.MCP_EXECUTOR_API_KEY) process.loadEnvFile(TOKEN_ENV);
  const token = process.env.MCP_EXECUTOR_API_KEY;
  if (!token) throw new Error("MCP_EXECUTOR_API_KEY is not configured");
  return token;
}

async function serve(result, token) {
  const upstream = new Client({ name: "executor-project-selector", version: "1.0.0" });
  const upstreamTransport = new StreamableHTTPClientTransport(new URL(executorToolkitUrl(result.url)), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await upstream.connect(upstreamTransport);

  const handlers = createProxyHandlers(upstream);
  const server = new Server(
    { name: "executor-project-selector", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, handlers.listTools);
  server.setRequestHandler(CallToolRequestSchema, handlers.callTool);
  server.onclose = () => upstream.close();
  await server.connect(new StdioServerTransport());
}

async function main() {
  const token = loadToken();
  const result = await resolveAndSync(token, process.cwd());
  if (process.argv.includes("--sync")) {
    process.stdout.write(`${JSON.stringify({ projectRoot: result.projectRoot, integration: result.integration, toolkit: result.toolkit })}\n`);
    return;
  }
  await serve(result, token);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (isMain) main().catch((error) => {
  process.stderr.write(`executor-project-mcp: ${error instanceof Error ? error.message : "unknown failure"}\n`);
  process.exitCode = 1;
});
