import { existsSync, promises as fsp } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { PiExec } from "../cli.js";
import { HerdrCli } from "../cli.js";
import { resolveManagerSession } from "../context.js";
import { connectDaemonClient, DaemonCallError, type DaemonCallerContext, type DaemonClient } from "../daemon/client.js";
import { resolveDaemonNamespace, type DaemonNamespace } from "../daemon/namespace.js";
import type { DelegatedCaller } from "../launch-schema.js";
import { CLAUDE_CHANNEL_CAPABILITY } from "../supervision/notify.js";
import { parseSnapshotResult, type CurrentContext } from "../targets.js";
import { createToolSurface, type HerdrToolSurface } from "../tool-surface.js";
import { callTool, describeTools } from "./adapter.js";
import { createNodeExec, resolveStartup, safeDirectory, StartupRefusal, type DirectoryStat } from "./host.js";

export const MCP_SERVER_NAME = "herdr-tools";
export const MCP_SERVER_VERSION = "1.0.0";
const MAX_STDERR_LINE_CHARS = 500;

export interface McpRunDependencies {
  env?: NodeJS.ProcessEnv;
  stat?: (path: string) => Promise<DirectoryStat>;
  cwd?: () => string;
  exec?: PiExec;
  transport?: Transport;
  /** The daemon namespace resolver — injectable so tests never touch the endpoint filesystem. */
  resolveNamespace?: (env: NodeJS.ProcessEnv) => Promise<DaemonNamespace>;
  /** The daemon socket seam — injectable so tests never open a real socket. */
  connectDaemon?: (namespace: DaemonNamespace, caller: DaemonCallerContext) => Promise<DaemonClient>;
  writeStderr?: (line: string) => void;
  exit?: (code: number) => void;
  onSignal?: (signal: "SIGINT" | "SIGTERM", handler: () => void) => void;
}

export interface HerdrMcpServer {
  readonly server: Server;
  readonly surface: HerdrToolSurface;
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
 * Start the stdio Herdr tools server for a manager session on any MCP host.
 *
 * The server is a stateless daemon proxy (durable-supervisor §10): startup
 * gates on `resolveStartup`, the three tools each open a fresh daemon
 * connection per `tools/call`, and the daemon verifies the claimed identity
 * against its own fresh snapshot (D2a). The host holds no supervision, jobs,
 * queue, or mailbox state of its own. Startup itself is side-effect free: no
 * CLI read or socket connection runs before the transport connects.
 *
 * The D2a claim's `agentSession` is re-derived per call from the authoritative
 * snapshot — the same read the daemon repeats to verify — so a pane whose
 * session changed mid-session claims the live identity rather than a stale
 * one.
 *
 * Under `HERDR_EXECUTOR_DELEGATED=1` (the executor-gateway serve) injected
 * identity may be absent and each tool call supplies a `caller`
 * `{paneId, projectRoot}`; the same per-call derivation then claims the
 * asserted pane's snapshot identity, and the daemon verifies it identically.
 */
export async function runHerdrMcpServer(deps: McpRunDependencies = {}): Promise<HerdrMcpServer | undefined> {
  const writeStderr = deps.writeStderr ?? ((line: string) => { process.stderr.write(line); });
  const exit = deps.exit ?? ((code: number) => { process.exit(code); });

  let startup;
  try {
    startup = await resolveStartup({ ...(deps.env ? { env: deps.env } : {}), ...(deps.stat ? { stat: deps.stat } : {}), ...(deps.cwd ? { cwd: deps.cwd } : {}) });
  } catch (error) {
    writeStderr(refusalLine(error));
    exit(1);
    return undefined;
  }

  const env = deps.env ?? process.env;
  const cli = new HerdrCli(deps.exec ?? createNodeExec({ cwd: startup.projectDir }));
  const delegated = env.HERDR_EXECUTOR_DELEGATED === "1";
  const stat = deps.stat ?? ((path: string) => fsp.stat(path));

  /**
   * The delegated caller's project root, canonicalized exactly like the
   * startup anchor: realpath, then the same single-line/non-root/directory
   * gates. Anything else is a typed refusal, never a re-anchor on cwd.
   */
  const canonicalCallerRoot = async (raw: string): Promise<string> => {
    try {
      const resolved = await fsp.realpath(raw);
      const canonical = dirname(resolved) !== resolved ? safeDirectory(resolved) : undefined;
      if (canonical === undefined || !(await stat(canonical)).isDirectory()) throw new Error("not a usable directory");
      return canonical;
    } catch {
      throw new DaemonCallError("DELEGATED_CALLER_INVALID", "caller.projectRoot must resolve to an existing directory below the filesystem root");
    }
  };

  const connect = async (signal: AbortSignal | undefined, callerArg?: DelegatedCaller): Promise<DaemonClient> => {
    const requestSignal = signal ?? new AbortController().signal;
    // The policy gates precede any socket or CLI traffic, so a refused call
    // leaves no trace on either boundary.
    if (callerArg !== undefined && !delegated) {
      throw new DaemonCallError("DELEGATED_CALLER_DISABLED", "the caller argument is only served when this server runs with HERDR_EXECUTOR_DELEGATED=1");
    }
    if (callerArg === undefined && delegated && !(startup.environment.currentIdsPresent && startup.environment.currentIdsValid)) {
      throw new DaemonCallError("DELEGATED_CALLER_REQUIRED", "delegated serves require the caller {paneId, projectRoot} argument when no injected Herdr identity is present");
    }
    const envelope = await cli.runJson(["api", "snapshot"], requestSignal);
    const snapshot = parseSnapshotResult(envelope.result);
    const paneId = callerArg?.paneId ?? startup.context.paneId!;
    const session = resolveManagerSession(snapshot, paneId);
    const namespace = await (deps.resolveNamespace ?? resolveDaemonNamespace)(env);
    let caller: DaemonCallerContext;
    if (callerArg === undefined) {
      caller = {
        identity: {
          workspaceId: startup.context.workspaceId!,
          tabId: startup.context.tabId!,
          paneId,
          agentSession: session,
        },
        projectRoot: startup.projectDir,
      };
    } else {
      // Delegated caller-asserted identity: cooperative under the same-UID
      // stance — any process that can reach this connection can claim any
      // pane — and strictly weaker custody than env injection, which the
      // harness controls per-spawn. The client derives the claim from the
      // authoritative snapshot; the daemon's D2a verification stays the
      // authority and is unchanged. resolveManagerSession proved exactly one
      // pane record, so the lookup cannot fail.
      const pane = snapshot.panes.find((entry) => entry.pane_id === paneId)!;
      caller = {
        identity: {
          workspaceId: pane.workspace_id,
          tabId: pane.tab_id,
          paneId,
          agentSession: session,
        },
        projectRoot: await canonicalCallerRoot(callerArg.projectRoot),
      };
    }
    return (deps.connectDaemon ?? connectDaemonClient)(namespace, caller);
  };

  const surface = createToolSurface({ connectDaemon: connect, cwd: startup.projectDir });

  let descriptors;
  try {
    descriptors = describeTools(surface);
  } catch (error) {
    writeStderr(refusalLine(error));
    exit(1);
    return undefined;
  }

  // The documented Claude Code Channels research-preview capability is still
  // advertised alongside tools by the same server that serves them (N5.2 owns
  // its removal); the daemon now owns every wake path, so nothing here sends.
  const server = new Server({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION }, { capabilities: { tools: {}, experimental: { [CLAUDE_CHANNEL_CAPABILITY]: {} } } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: descriptors }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const outcome = await callTool({
      surface,
      name: request.params.name,
      args: request.params.arguments,
      host: { cwd: startup.projectDir, signal: extra.signal },
      callId: String(extra.requestId),
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
    cli.closePromptTransport();
    await server.close();
    exit(0);
  };

  server.onclose = () => { void shutdown(); };
  const onSignal = deps.onSignal ?? ((signal: "SIGINT" | "SIGTERM", handler: () => void) => { process.once(signal, handler); });
  onSignal("SIGINT", () => { void shutdown(); });
  onSignal("SIGTERM", () => { void shutdown(); });

  const transport = deps.transport ?? new StdioServerTransport();
  if (!deps.transport) {
    const onClientDisconnect = () => { void shutdown(); };
    process.stdin.once("end", onClientDisconnect);
    process.stdin.once("close", onClientDisconnect);
  }
  await server.connect(transport);
  return { server, surface, context: startup.context, projectDir: startup.projectDir, shutdown };
}
