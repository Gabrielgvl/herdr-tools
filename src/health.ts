import { CliProtocolError } from "./cli.js";

export interface HealthDetails {
  client: { version: string; protocol: number; endpointProtocolGeneration?: number };
  server: { status: string; version?: string; protocol?: number; endpointCompatible?: boolean; endpointProtocolGeneration?: number };
  socketReachable: boolean;
  compatible?: boolean;
}

export interface HealthCli {
  runText(argv: string[], signal: AbortSignal): Promise<string>;
  readApiSchema?(signal: AbortSignal): Promise<string>;
  pingPromptEndpoint?(signal: AbortSignal): Promise<void>;
}

export type CompatibilityPreflight = (signal: AbortSignal, requirement?: "agent.prompt") => Promise<void>;

export const MAX_HEALTH_VERSION_LENGTH = 128;
export const MAX_HEALTH_STATUS_LENGTH = 64;
export const REQUIRED_HERDR_PROTOCOL = 22;
export const REQUIRED_HERDR_VERSION = "0.9.0";
export const REQUIRED_ENDPOINT_PROTOCOL_GENERATION = 1;

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
  const endpointCompatible = serverRecord.endpoint_compatible === null ? undefined : serverRecord.endpoint_compatible;
  const clientGeneration = clientRecord.endpoint_protocol_generation === null ? undefined : clientRecord.endpoint_protocol_generation;
  const capabilities = serverRecord.capabilities;
  if (capabilities !== undefined && capabilities !== null && !record(capabilities)) throw incompatibleHealth();
  const serverGeneration = record(capabilities) && capabilities.endpoint_protocol_generation === null
    ? undefined
    : record(capabilities) ? capabilities.endpoint_protocol_generation : undefined;
  if (!validVersion(clientRecord.version) || !validProtocol(clientRecord.protocol) || !validStatus(status)) throw incompatibleHealth();
  if ((serverVersion !== undefined && !validVersion(serverVersion)) || (serverProtocol !== undefined && !validProtocol(serverProtocol)) || (compatible !== undefined && typeof compatible !== "boolean") || (endpointCompatible !== undefined && typeof endpointCompatible !== "boolean") || (clientGeneration !== undefined && !validProtocol(clientGeneration)) || (serverGeneration !== undefined && !validProtocol(serverGeneration))) throw incompatibleHealth();
  if (clientRecord.protocol !== REQUIRED_HERDR_PROTOCOL || (serverProtocol !== undefined && serverProtocol !== REQUIRED_HERDR_PROTOCOL)) throw incompatibleHealth();
  if (status === "running" && (serverVersion === undefined || serverProtocol === undefined || typeof compatible !== "boolean")) throw incompatibleHealth();
  return {
    client: { version: clientRecord.version, protocol: clientRecord.protocol, ...(clientGeneration === undefined ? {} : { endpointProtocolGeneration: clientGeneration as number }) },
    server: {
      status,
      ...(serverVersion === undefined ? {} : { version: serverVersion }),
      ...(serverProtocol === undefined ? {} : { protocol: serverProtocol }),
      ...(endpointCompatible === undefined ? {} : { endpointCompatible }),
      ...(serverGeneration === undefined ? {} : { endpointProtocolGeneration: serverGeneration as number })
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
  const clientGeneration = clientRecord.endpointProtocolGeneration;
  const endpointCompatible = serverRecord.endpointCompatible;
  const serverGeneration = serverRecord.endpointProtocolGeneration;
  if (!validVersion(clientRecord.version) || !validProtocol(clientRecord.protocol) || !validStatus(status) || (serverVersion !== undefined && !validVersion(serverVersion)) || (serverProtocol !== undefined && !validProtocol(serverProtocol)) || (compatible !== undefined && typeof compatible !== "boolean") || (clientGeneration !== undefined && !validProtocol(clientGeneration)) || (endpointCompatible !== undefined && typeof endpointCompatible !== "boolean") || (serverGeneration !== undefined && !validProtocol(serverGeneration)) || typeof root.socketReachable !== "boolean") return undefined;
  if (clientRecord.protocol !== REQUIRED_HERDR_PROTOCOL || (serverProtocol !== undefined && serverProtocol !== REQUIRED_HERDR_PROTOCOL)) return undefined;
  return {
    client: { version: clientRecord.version, protocol: clientRecord.protocol, ...(clientGeneration === undefined ? {} : { endpointProtocolGeneration: clientGeneration as number }) },
    server: {
      status,
      ...(serverVersion === undefined ? {} : { version: serverVersion }),
      ...(serverProtocol === undefined ? {} : { protocol: serverProtocol }),
      ...(endpointCompatible === undefined ? {} : { endpointCompatible }),
      ...(serverGeneration === undefined ? {} : { endpointProtocolGeneration: serverGeneration as number })
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
  const dispatch = details.promptDispatch;
  if (record(dispatch) && (dispatch.state === "not_written" || dispatch.state === "rejected" || dispatch.state === "acknowledged" || dispatch.state === "unknown")) {
    safe.promptDispatch = {
      state: dispatch.state,
      ...(typeof dispatch.requestId === "string" && dispatch.requestId.length <= 256 ? { requestId: dispatch.requestId } : {})
    };
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
    if (error.code === "CLI_OUTPUT_OVERFLOW") return new CliProtocolError("CLI_INCOMPATIBLE", "Herdr schema output exceeded the accepted bound", details);
    /* c8 ignore next -- the installed CLI path is covered by the HerdrCli adapter contract. */
    if (error.code === "CLI_NOT_FOUND") return new CliProtocolError("CLI_INCOMPATIBLE", "Herdr CLI is unavailable", details);
  }
  if (record(error) && typeof error.code === "string") {
    if (error.code === "ABORTED") return new CliProtocolError("ABORTED", "Operation aborted");
    if (error.code === "CLI_PROTOCOL_ERROR") return new CliProtocolError("CLI_INCOMPATIBLE", "Herdr health preflight failed");
    if (error.code === "BACKEND_UNAVAILABLE" || error.code === "SUPERVISION_SOCKET_UNAVAILABLE") return new CliProtocolError("BACKEND_UNAVAILABLE", "Herdr backend health check failed");
  }
  return new CliProtocolError("BACKEND_UNAVAILABLE", "Herdr backend health check failed");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactStrings(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && expected.every((item) => value.includes(item));
}

function schemaRef(value: unknown, expected: string): boolean {
  return record(value) && value.$ref === expected;
}

export function validateAgentPromptSchema(text: string): void {
  let root: unknown;
  try { root = JSON.parse(text); } catch { throw incompatibleHealth(); }
  if (!record(root) || root.protocol !== REQUIRED_HERDR_PROTOCOL || root.schema_version !== 1 || !record(root.schemas)) throw incompatibleHealth();
  const request = root.schemas.request;
  const success = root.schemas.success_response;
  if (!record(request) || !record(request.$defs) || !record(success) || !record(success.$defs)) throw incompatibleHealth();
  const promptParams = request.$defs.AgentPromptParams;
  const responseResult = success.$defs.ResponseResult;
  const requests = Array.isArray(request.oneOf) ? request.oneOf : [];
  const responses = record(responseResult) && Array.isArray(responseResult.oneOf) ? responseResult.oneOf : [];
  const requestVariant = requests.find((value) => record(value) && record(value.properties) && record(value.properties.method) && value.properties.method.const === "agent.prompt");
  const responseVariant = responses.find((value) => record(value) && record(value.properties) && record(value.properties.type) && value.properties.type.const === "agent_prompted");
  const validParams = record(promptParams) && record(promptParams.properties)
    && record(promptParams.properties.target) && promptParams.properties.target.type === "string"
    && record(promptParams.properties.text) && promptParams.properties.text.type === "string"
    && exactStrings(promptParams.required, ["target", "text"]);
  const validRequest = record(requestVariant)
    && record(requestVariant.properties)
    && record(requestVariant.properties.method)
    && requestVariant.properties.method.type === "string"
    && requestVariant.properties.method.const === "agent.prompt"
    && schemaRef(requestVariant.properties.params, "#/schemas/request/$defs/AgentPromptParams")
    && exactStrings(requestVariant.required, ["method", "params"]);
  const validResponse = record(responseVariant)
    && record(responseVariant.properties)
    && record(responseVariant.properties.type)
    && responseVariant.properties.type.type === "string"
    && responseVariant.properties.type.const === "agent_prompted"
    && schemaRef(responseVariant.properties.agent, "#/schemas/success_response/$defs/AgentInfo")
    && exactStrings(responseVariant.required, ["type", "agent"]);
  if (!validParams || !validRequest || !validResponse) throw incompatibleHealth();
}

async function preflightPromptEndpoint(cli: HealthCli, signal: AbortSignal, health: HealthDetails): Promise<HealthDetails> {
  if (health.server.endpointCompatible !== true
    || health.client.version !== REQUIRED_HERDR_VERSION
    || health.server.version !== REQUIRED_HERDR_VERSION
    || health.client.endpointProtocolGeneration !== REQUIRED_ENDPOINT_PROTOCOL_GENERATION
    || health.server.endpointProtocolGeneration !== REQUIRED_ENDPOINT_PROTOCOL_GENERATION
    || !cli.readApiSchema
    || !cli.pingPromptEndpoint) {
    throw new CliProtocolError("CLI_INCOMPATIBLE", "Herdr prompt endpoint is incompatible", safePreflightDetails({ health }));
  }
  try {
    validateAgentPromptSchema(await cli.readApiSchema(signal));
    await cli.pingPromptEndpoint(signal);
  } catch (error) {
    throw mapPreflightFailure(error);
  }
  return health;
}

/** Verify client/server compatibility before a Herdr mutation is dispatched. */
export async function preflightCompatibility(cli: HealthCli, signal: AbortSignal, requirement?: "agent.prompt"): Promise<HealthDetails> {
  let health: HealthDetails;
  try {
    health = parseHealth(await cli.runText(["status", "--json"], signal));
  } catch (error) {
    throw mapPreflightFailure(error);
  }
  if (!health.socketReachable) throw new CliProtocolError("BACKEND_UNAVAILABLE", "Herdr backend is unavailable", safePreflightDetails({ health }));
  if (health.compatible !== true) throw new CliProtocolError("CLI_INCOMPATIBLE", "Herdr CLI and backend are incompatible", safePreflightDetails({ health }));
  if (requirement === "agent.prompt") {
    try {
      return await preflightPromptEndpoint(cli, signal, health);
    } catch (error) {
      throw mapPreflightFailure(error);
    }
  }
  return health;
}

export function preflightPromptCompatibility(cli: HealthCli, signal: AbortSignal): Promise<HealthDetails> {
  return preflightCompatibility(cli, signal, "agent.prompt");
}
