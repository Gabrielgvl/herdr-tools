import { randomUUID } from "node:crypto";
import type { JsonEnvelope } from "./cli.js";
import { encodeSocketRequest } from "./supervision/protocol.js";
import { createNodeSupervisionConnect, resolveSocketPath, SupervisionRequestError, SupervisionSocket, type SupervisionConnect } from "./supervision/socket.js";

export type PromptDispatchState = "not_written" | "rejected" | "acknowledged" | "unknown";

export interface PromptDispatchEvidence {
  state: PromptDispatchState;
  requestId?: string;
}

export class AgentPromptError extends Error {
  readonly details: { promptDispatch: PromptDispatchEvidence };

  constructor(readonly code: string, message: string, promptDispatch: PromptDispatchEvidence) {
    super(message);
    this.name = "AgentPromptError";
    this.details = { promptDispatch };
  }
}

export interface AgentPromptClient {
  prompt(target: string, text: string, signal: AbortSignal): Promise<JsonEnvelope>;
  ping(signal: AbortSignal): Promise<void>;
  /** Close in-flight unary requests without replaying them. */
  close?(): void;
}

export interface AgentPromptClientOptions {
  env?: NodeJS.ProcessEnv;
  connect?: SupervisionConnect;
  requestTimeoutMs?: number;
  requestId?: () => string;
}

const HERDR_VERSION = "0.9.0";
const HERDR_PROTOCOL = 22;
const ENDPOINT_PROTOCOL_GENERATION = 1;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createAgentPromptClient(options: AgentPromptClientOptions = {}): AgentPromptClient {
  const connect = options.connect ?? createNodeSupervisionConnect();
  const socketPath = () => resolveSocketPath(options.env);
  const requestId = options.requestId ?? (() => `herdr-tools-${randomUUID()}`);
  const pendingSockets = new Set<SupervisionSocket>();
  const pendingConnects = new Set<() => void>();
  let transportGeneration = 0;

  async function request(method: string, params: Record<string, unknown>, signal: AbortSignal, validate: (result: unknown) => boolean): Promise<JsonEnvelope> {
    if (signal.aborted) throw new AgentPromptError("ABORTED", "Operation aborted", { state: "not_written" });
    const generation = transportGeneration;
    let id: string;
    try {
      id = requestId();
      encodeSocketRequest(id, method, params);
    } catch {
      throw new AgentPromptError("CLI_PROTOCOL_ERROR", "Herdr socket request is too large or malformed", { state: "not_written" });
    }
    let socket: SupervisionSocket;
    let connectCancelled = false;
    let cancelConnect!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      cancelConnect = () => {
        if (connectCancelled) return;
        connectCancelled = true;
        reject(new AgentPromptError("ABORTED", "Operation aborted", { state: "not_written" }));
      };
    });
    pendingConnects.add(cancelConnect);
    const abortConnect = (): void => { cancelConnect(); };
    signal.addEventListener("abort", abortConnect, { once: true });
    let connectPromise: Promise<Awaited<ReturnType<SupervisionConnect>>>;
    try {
      connectPromise = connectCancelled
        ? Promise.reject(new AgentPromptError("ABORTED", "Operation aborted", { state: "not_written" }))
        : Promise.resolve(connect(socketPath()));
    } catch (error) {
      connectPromise = Promise.reject(error);
    }
    // A connect implementation may finish after host shutdown. The resulting
    // stream is never usable and must be destroyed rather than left orphaned.
    void connectPromise.then((stream) => {
      if (connectCancelled || generation !== transportGeneration) stream.destroy();
    }, () => undefined);
    try {
      socket = new SupervisionSocket(await Promise.race([connectPromise, cancelled]), options.requestTimeoutMs);
    } catch (error) {
      if (error instanceof AgentPromptError) throw error;
      throw new AgentPromptError(signal.aborted || generation !== transportGeneration ? "ABORTED" : "BACKEND_UNAVAILABLE", signal.aborted || generation !== transportGeneration ? "Operation aborted" : "Herdr socket is unavailable", { state: "not_written" });
    } finally {
      signal.removeEventListener("abort", abortConnect);
      pendingConnects.delete(cancelConnect);
    }
    pendingSockets.add(socket);
    if (signal.aborted || generation !== transportGeneration) {
      socket.close();
      throw new AgentPromptError("ABORTED", "Operation aborted", { state: "not_written" });
    }

    let writeInvoked = false;
    const abort = () => socket.close();
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted || generation !== transportGeneration) {
        socket.close();
        throw new AgentPromptError("ABORTED", "Operation aborted", { state: "not_written" });
      }
      const response = await socket.requestCorrelated(id, method, params, () => { writeInvoked = true; });
      if (!validate(response.result)) {
        throw new AgentPromptError("CLI_PROTOCOL_ERROR", "Herdr socket returned an incompatible acknowledgement", { state: "unknown", requestId: id });
      }
      return response;
    } catch (error) {
      if (error instanceof AgentPromptError) throw error;
      if (error instanceof SupervisionRequestError && error.herdrCode === "agent_blocked") {
        throw new AgentPromptError("TARGET_BLOCKED", "Herdr rejected input for a blocked target", { state: "rejected", requestId: id });
      }
      throw new AgentPromptError(
        signal.aborted ? "ABORTED" : "PROMPT_DISPATCH_UNKNOWN",
        signal.aborted ? "Operation aborted after prompt dispatch may have begun" : "Prompt dispatch outcome is unknown",
        { state: writeInvoked ? "unknown" : "not_written", ...(writeInvoked ? { requestId: id } : {}) }
      );
    } finally {
      signal.removeEventListener("abort", abort);
      pendingSockets.delete(socket);
      socket.close();
    }
  }

  return {
    prompt: (target, text, signal) => request("agent.prompt", { target, text }, signal, (result) => record(result) && result.type === "agent_prompted" && record(result.agent)),
    ping: async (signal) => {
      await request("ping", {}, signal, (result) => {
        if (!record(result) || result.type !== "pong" || result.version !== HERDR_VERSION || result.protocol !== HERDR_PROTOCOL || !record(result.capabilities)) return false;
        return result.capabilities.endpoint_protocol_generation === ENDPOINT_PROTOCOL_GENERATION;
      });
    },
    close: () => {
      transportGeneration += 1;
      for (const cancel of pendingConnects) cancel();
      pendingConnects.clear();
      for (const socket of pendingSockets) socket.close();
      pendingSockets.clear();
    }
  };
}
