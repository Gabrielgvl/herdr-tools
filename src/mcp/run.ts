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
import { SupervisionRegistry } from "../supervision/registry.js";
import { CLAUDE_CHANNEL_CAPABILITY, createChannelSupervisionNotifier } from "../supervision/notify.js";
import { createBuiltinModelService } from "../supervision/model-service.js";
import { loadSettings, type Settings } from "../settings.js";
import type { CurrentContext } from "../targets.js";
import { createPreflight, createToolSurface, type HerdrToolSurface } from "../tool-surface.js";
import { callTool, describeTools } from "./adapter.js";
import { createNodeExec, resolveStartup, StartupRefusal, type DirectoryStat } from "./host.js";
import { SequentialToolQueue } from "./queue.js";

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
  readonly supervision: SupervisionRegistry;
  readonly ownership: RuntimeOwnership;
  readonly context: CurrentContext;
  readonly projectDir: string;
  shutdown(): Promise<void>;
}

/**
 * The one sanitized, bounded stderr line this server is allowed to write.
 * Control characters become spaces so a hostile message cannot forge extra
 * lines, and the payload is capped so it cannot flood the client's log.
 */
function stderrLine(prefix: string, message: string): string {
  const printable = [...message]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? " " : character;
    })
    .join("")
    .slice(0, MAX_STDERR_LINE_CHARS);
  return `${MCP_SERVER_NAME} mcp server ${prefix}: ${printable}\n`;
}

/** The single bounded stderr line a refusal is allowed to write. */
export function refusalLine(error: unknown): string {
  const message = error instanceof StartupRefusal
    ? `${error.reason}: ${error.message}`
    : error instanceof Error ? error.message : String(error);
  return stderrLine("refused to start", message);
}

/**
 * The same fail-closed line for a failure that escapes startup entirely, so the
 * executable entry never writes raw, unbounded error text to the client.
 */
export function fatalLine(error: unknown): string {
  return stderrLine("failed", error instanceof Error ? error.message : String(error));
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
  // The Channels research preview has no delivery acknowledgement, so the
  // notifier is wired before the transport and every send stays best effort.
  const channel = { current: undefined as ((notification: { method: string; params: { content: string; meta: Record<string, unknown> } }) => Promise<void>) | undefined };
  const supervision = new SupervisionRegistry({
    jobs,
    settingsLoader: deps.settingsLoader ?? (() => loadSettings()),
    readTranscript: (paneId, signal) => cli
      .runText(["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", "100", "--format", "text"], signal)
      .then((output) => (output.length === 0 ? [] : output.split(/\r?\n/u).slice(-100))),
    notifier: createChannelSupervisionNotifier((notification) => channel.current?.(notification)),
    // The MCP host has no Pi model registry, and `hostContext` deliberately
    // still throws for `context.modelRegistry`. It resolves the supervisor's
    // reviewer model through its own host-independent service instead.
    models: () => createBuiltinModelService(),
    monitorOptions: { ...(deps.env ? { env: deps.env } : {}) },
  });
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
    supervision,
    // Model-backed wait review is a Pi capability. Failing closed here keeps a
    // wait beyond the configured review cadence from running unsupervised.
    // Supervision review is separate and does run here, through its own service.
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

  // The documented Claude Code Channels research-preview capability, advertised
  // alongside tools by the same server that serves them.
  const server = new Server({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION }, { capabilities: { tools: {}, experimental: { [CLAUDE_CHANNEL_CAPABILITY]: {} } } });
  channel.current = (notification) => server.notification(notification);
  // One queue per server, so the sequential tools are serialized across every
  // concurrent `tools/call` this session issues.
  const queue = new SequentialToolQueue();
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: descriptors }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const outcome = await callTool({
      surface,
      name: request.params.name,
      args: request.params.arguments,
      host: { cwd: startup.projectDir, signal: extra.signal },
      callId: String(extra.requestId),
      queue
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
    // Closed before the registry and the transport, so a call still waiting for
    // its turn is refused instead of mutating during teardown.
    queue.close();
    supervision.shutdown();
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
  return { server, surface, jobs, supervision, ownership, context: startup.context, projectDir: startup.projectDir, shutdown };
}
