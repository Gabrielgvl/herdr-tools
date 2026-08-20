import { CliProtocolError } from "./cli.js";

export interface HealthDetails {
  client: { version: string; protocol: number };
  server: { status: string; version?: string; protocol?: number };
  socketReachable: boolean;
  compatible?: boolean;
}

export interface HealthCli {
  runText(argv: string[], signal: AbortSignal): Promise<string>;
}

export type CompatibilityPreflight = (signal: AbortSignal) => Promise<void>;

export const MAX_HEALTH_VERSION_LENGTH = 128;
export const MAX_HEALTH_STATUS_LENGTH = 64;

function validVersion(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_HEALTH_VERSION_LENGTH;
}

function validStatus(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_HEALTH_STATUS_LENGTH;
}

function validProtocol(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function incompatibleHealth(): CliProtocolError {
  return new CliProtocolError("CLI_INCOMPATIBLE", "Herdr health output is incompatible");
}

/** Parse the stable, non-secret health contract shared by inspection and preflight. */
export function parseHealth(text: string): HealthDetails {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliProtocolError("CLI_INCOMPATIBLE", "Herdr health output is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw incompatibleHealth();
  const root = parsed as Record<string, unknown>;
  const client = root.client;
  const server = root.server;
  if (typeof client !== "object" || client === null || Array.isArray(client) || typeof server !== "object" || server === null || Array.isArray(server)) throw incompatibleHealth();
  const clientRecord = client as Record<string, unknown>;
  const serverRecord = server as Record<string, unknown>;
  const status = serverRecord.status;
  const serverVersion = serverRecord.version === null ? undefined : serverRecord.version;
  const serverProtocol = serverRecord.protocol === null ? undefined : serverRecord.protocol;
  const compatible = serverRecord.compatible === null ? undefined : serverRecord.compatible;
  if (!validVersion(clientRecord.version) || !validProtocol(clientRecord.protocol) || !validStatus(status)) throw incompatibleHealth();
  if ((serverVersion !== undefined && !validVersion(serverVersion)) || (serverProtocol !== undefined && !validProtocol(serverProtocol)) || (compatible !== undefined && typeof compatible !== "boolean")) throw incompatibleHealth();
  if (status === "running" && (serverVersion === undefined || serverProtocol === undefined || typeof compatible !== "boolean")) throw incompatibleHealth();
  return {
    client: { version: clientRecord.version, protocol: clientRecord.protocol },
    server: {
      status,
      ...(serverVersion === undefined ? {} : { version: serverVersion }),
      ...(serverProtocol === undefined ? {} : { protocol: serverProtocol })
    },
    socketReachable: status === "running",
    ...(compatible === undefined ? {} : { compatible })
  };
}

function safeHealthDetails(value: unknown): HealthDetails | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const root = value as Record<string, unknown>;
  const client = root.client;
  const server = root.server;
  if (typeof client !== "object" || client === null || Array.isArray(client) || typeof server !== "object" || server === null || Array.isArray(server)) return undefined;
  const clientRecord = client as Record<string, unknown>;
  const serverRecord = server as Record<string, unknown>;
  const status = serverRecord.status;
  const serverVersion = serverRecord.version;
  const serverProtocol = serverRecord.protocol;
  const compatible = root.compatible;
  if (!validVersion(clientRecord.version) || !validProtocol(clientRecord.protocol) || !validStatus(status) || (serverVersion !== undefined && !validVersion(serverVersion)) || (serverProtocol !== undefined && !validProtocol(serverProtocol)) || (compatible !== undefined && typeof compatible !== "boolean") || typeof root.socketReachable !== "boolean") return undefined;
  return {
    client: { version: clientRecord.version, protocol: clientRecord.protocol },
    server: {
      status,
      ...(serverVersion === undefined ? {} : { version: serverVersion }),
      ...(serverProtocol === undefined ? {} : { protocol: serverProtocol })
    },
    socketReachable: root.socketReachable,
    ...(compatible === undefined ? {} : { compatible })
  };
}

function safePreflightDetails(details: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  if (typeof details.exitCode === "number" && Number.isSafeInteger(details.exitCode)) safe.exitCode = details.exitCode;
  for (const key of ["killed", "stdoutTruncated", "stderrTruncated"] as const) {
    if (typeof details[key] === "boolean") safe[key] = details[key];
  }
  const health = safeHealthDetails(details.health);
  if (health) safe.health = health;
  return safe;
}

export function mapPreflightFailure(error: unknown): CliProtocolError {
  if (error instanceof CliProtocolError) {
    if (error.code === "ABORTED") return error;
    const details = safePreflightDetails(error.details);
    if (error.code === "CLI_INCOMPATIBLE" || error.code === "BACKEND_UNAVAILABLE") return new CliProtocolError(error.code, error.message, details);
    if (error.code === "CLI_TIMEOUT") return new CliProtocolError("BACKEND_UNAVAILABLE", "Herdr backend health check timed out", details);
    if (error.code === "CLI_PROTOCOL_ERROR") {
      const exitCode = error.details.exitCode;
      const failedProcess = typeof exitCode === "number" && Number.isSafeInteger(exitCode) && exitCode !== 0;
      return new CliProtocolError(failedProcess ? "BACKEND_UNAVAILABLE" : "CLI_INCOMPATIBLE", "Herdr health preflight failed", details);
    }
    /* c8 ignore next -- the installed CLI path is covered by the HerdrCli adapter contract. */
    if (error.code === "CLI_NOT_FOUND") return new CliProtocolError("CLI_INCOMPATIBLE", "Herdr CLI is unavailable", details);
  }
  return new CliProtocolError("BACKEND_UNAVAILABLE", "Herdr backend health check failed");
}

/** Verify client/server compatibility before a Herdr mutation is dispatched. */
export async function preflightCompatibility(cli: HealthCli, signal: AbortSignal): Promise<HealthDetails> {
  let health: HealthDetails;
  try {
    health = parseHealth(await cli.runText(["status", "--json"], signal));
  } catch (error) {
    throw mapPreflightFailure(error);
  }
  if (!health.socketReachable) throw new CliProtocolError("BACKEND_UNAVAILABLE", "Herdr backend is unavailable", safePreflightDetails({ health }));
  if (health.compatible === true && health.server.protocol !== health.client.protocol) {
    throw new CliProtocolError("CLI_INCOMPATIBLE", "Herdr CLI and backend report contradictory protocol compatibility", safePreflightDetails({ health }));
  }
  if (health.compatible !== true) throw new CliProtocolError("CLI_INCOMPATIBLE", "Herdr CLI and backend are incompatible", safePreflightDetails({ health }));
  return health;
}
