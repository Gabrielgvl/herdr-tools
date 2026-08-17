import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { HerdrCli, type PiExec } from "../cli.js";
import { JobRegistry } from "../job-registry.js";
import { resetOwnership, RuntimeOwnership } from "../ownership.js";
import { discoverProfiles } from "../profiles/discovery.js";
import type { ProfileCatalog } from "../profiles/types.js";
import { ReviewerFailure } from "../reviewer.js";
import { loadSettings, type Settings } from "../settings.js";
import type { CurrentContext } from "../targets.js";
import { createPreflight, createToolSurface, type HerdrToolSurface } from "../tool-surface.js";
import { callTool, describeTools } from "./adapter.js";
import { createNodeExec, resolveStartup, StartupRefusal, type DirectoryStat } from "./host.js";

export const MCP_SERVER_NAME = "herdr-tools";
export const MCP_SERVER_VERSION = "1.0.0";
const BUNDLED_PROFILES_DIRECTORY = "herdr-profiles";
const MAX_STDERR_LINE_CHARS = 500;

export interface McpRunDependencies {
  env?: NodeJS.ProcessEnv;
  stat?: (path: string) => Promise<DirectoryStat>;
  exec?: PiExec;
  transport?: Transport;
  profiles?: { load: () => Promise<ProfileCatalog> };
  settingsLoader?: () => Promise<Settings>;
  fileExists?: (path: string) => boolean;
  writeStderr?: (line: string) => void;
  exit?: (code: number) => void;
  onSignal?: (signal: "SIGINT" | "SIGTERM", handler: () => void) => void;
}

export interface HerdrMcpServer {
  readonly server: Server;
  readonly surface: HerdrToolSurface;
  readonly jobs: JobRegistry;
  readonly ownership: RuntimeOwnership;
  readonly context: CurrentContext;
  readonly projectDir: string;
  shutdown(): Promise<void>;
}

/** The single bounded stderr line a refusal is allowed to write. */
export function refusalLine(error: unknown): string {
  const message = error instanceof StartupRefusal
    ? `${error.reason}: ${error.message}`
    : error instanceof Error ? error.message : String(error);
  const printable = [...message]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? " " : character;
    })
    .join("")
    .slice(0, MAX_STDERR_LINE_CHARS);
  return `${MCP_SERVER_NAME} mcp server refused to start: ${printable}\n`;
}

/**
 * The package root, anchored on the manifest beside the bundled catalog. It
 * resolves identically for `src/mcp/run.ts` and the emitted
 * `dist/src/mcp/run.js`, so the bundled profile directory is the only
 * module-relative path this host derives.
 */
export function packageRoot(moduleUrl: string, exists: (path: string) => boolean = existsSync): string {
  let current = dirname(fileURLToPath(moduleUrl));
  while (!exists(join(current, "package.json"))) {
    const parent = dirname(current);
    if (parent === current) return dirname(fileURLToPath(moduleUrl));
    current = parent;
  }
  return current;
}

/**
 * Start the stdio Herdr tools server for a Claude manager session.
 *
 * Startup is fail-closed and ordered; a refusal writes one bounded stderr line
 * and exits non-zero with no tool registered, no transport connected, and no
 * Herdr CLI call made.
 */
export async function runHerdrMcpServer(deps: McpRunDependencies = {}): Promise<HerdrMcpServer | undefined> {
  const writeStderr = deps.writeStderr ?? ((line: string) => { process.stderr.write(line); });
  const exit = deps.exit ?? ((code: number) => { process.exit(code); });

  let startup;
  try {
    startup = await resolveStartup({ ...(deps.env ? { env: deps.env } : {}), ...(deps.stat ? { stat: deps.stat } : {}) });
  } catch (error) {
    writeStderr(refusalLine(error));
    exit(1);
    return undefined;
  }

  const root = packageRoot(import.meta.url, deps.fileExists);
  const cli = new HerdrCli(deps.exec ?? createNodeExec({ cwd: startup.projectDir }));
  const ownership = new RuntimeOwnership();
  const jobs = new JobRegistry();
  const surface = createToolSurface({
    cli,
    context: startup.context,
    environment: startup.environment,
    preflight: createPreflight(cli),
    settingsLoader: deps.settingsLoader ?? (() => loadSettings()),
    jobs,
    profiles: deps.profiles ?? { load: () => discoverProfiles({ bundledDir: join(root, BUNDLED_PROFILES_DIRECTORY), bundledScopeRoot: root, projectCwd: startup.projectDir }) },
    ownership,
    cwd: startup.projectDir,
    // Model-backed wait review is a Pi capability. Failing closed here keeps a
    // wait beyond the configured review cadence from running unsupervised.
    reviewerFactory: () => { throw new ReviewerFailure("model-backed wait review is unavailable on the MCP host"); }
  });

  let descriptors;
  try {
    descriptors = describeTools(surface);
  } catch (error) {
    writeStderr(refusalLine(error));
    exit(1);
    return undefined;
  }

  const server = new Server({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: descriptors }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const outcome = await callTool({
      surface,
      name: request.params.name,
      args: request.params.arguments,
      host: { cwd: startup.projectDir, signal: extra.signal },
      callId: String(extra.requestId)
    });
    return {
      content: outcome.content.map((block) => ({ type: block.type, text: block.text })),
      ...(outcome.isError ? { isError: true as const } : {})
    };
  });

  let stopped = false;
  const shutdown = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    jobs.shutdown();
    resetOwnership(ownership);
    await server.close();
    exit(0);
  };

  server.onclose = () => { void shutdown(); };
  const onSignal = deps.onSignal ?? ((signal: "SIGINT" | "SIGTERM", handler: () => void) => { process.once(signal, handler); });
  onSignal("SIGINT", () => { void shutdown(); });
  onSignal("SIGTERM", () => { void shutdown(); });

  await server.connect(deps.transport ?? new StdioServerTransport());
  return { server, surface, jobs, ownership, context: startup.context, projectDir: startup.projectDir, shutdown };
}
