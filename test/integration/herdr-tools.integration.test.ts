import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import extension, { CORE_TOOL_NAMES, createRuntime, type ExtensionRuntime } from "../../index.js";
import { createLaunchTool } from "../../src/tools/launch.js";
import type { TaskEvaluation, TaskEvaluationInput, TypeSafeSpecClient } from "../../src/typesafe-spec.js";
import { renderTask } from "../../src/launch-schema.js";
import { renderHandoffContract, type HandoffAllocation } from "../../src/handoff.js";
import { createDisposableGitWorkspace, startDisposableSocketProxy, stopDisposableServer, waitForCondition } from "./disposable-session.js";

interface ExecutableTool {
  name: string;
  execute(id: string, params: unknown, signal: AbortSignal, onUpdate: undefined, context: ExtensionContext): Promise<{ details?: Record<string, unknown> }>;
}

const execFileAsync = promisify(execFile);
const REQUIRED_SESSION = process.env.HERDR_TOOLS_INTEGRATION_SESSION ?? "herdr-tools-integration";
const requestedSession = process.env.HERDR_TOOLS_INTEGRATION_SESSION ?? REQUIRED_SESSION;
const enabled = process.env.HERDR_TOOLS_RUN_INTEGRATION === "1";
const agyEnabled = process.env.HERDR_TOOLS_RUN_AGY_INTEGRATION === "1";
const ACCEPTANCE_DEADLINE_MS = 150_000;

function resultObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("integration response is not an object");
  return value as Record<string, unknown>;
}

/**
 * The uniform launch result (ADR-037): every `herdr_launch` call returns this
 * one shape. Rich per-child evidence (readiness, prompt timing, supervision)
 * is deliberately not published on the result — it lives on the supervisor job
 * and the decision log, which the assertions below read back.
 */
function launchDetails(value: unknown): Record<string, unknown> {
  const details = resultObject(value);
  if (details.kind !== "launch") throw new Error("herdr_launch returned non-launch details");
  return details;
}

function singleLaunchChild(value: unknown): Record<string, unknown> {
  const launch = launchDetails(value);
  const children = launch.children;
  if (!Array.isArray(children) || children.length !== 1) {
    throw new Error(`one-Task launch returned outcome=${String(launch.outcome)} children=${Array.isArray(children) ? children.length : "invalid"}`);
  }
  const child = resultObject(children[0]);
  if (typeof child.target !== "string" || child.target.length === 0) throw new Error("one-Task launch child omitted its runtime-minted target");
  return child;
}

describe.skipIf(!enabled)("disposable Herdr integration", () => {
  const state: {
    cwd: string;
    workspaceId?: string;
    rootPaneId?: string;
    rootTabId?: string;
    server?: ChildProcess;
    sessionStarted: boolean;
    socketPath?: string;
    socketProxy?: { path: string; requests: Array<{ id: string; method: string; target?: string; text?: string }>; close(): Promise<void> };
    savedSocketPath?: string;
    fixtureCreated: boolean;
    baseline?: { workspaces: string[]; tabs: string[]; panes: string[] };
    registered: Map<string, ExecutableTool>;
    commands: string[];
    handlers: string[];
    cliCalls: string[][];
    toolCalls: Array<{ name: string; id: string }>;
    attachmentPaths: string[];
    forceNextPromptConfirmationFailure: boolean;
    promptConfirmationFailurePaneId?: string;
    forceNextAgyStartFailure: boolean;
    /** The exec interceptor shared with the AGY fixture runtime. */
    execCli?: ExtensionAPI["exec"];
    /** The AGY fixture's second runtime: launched only by AGY-gated tests. */
    agyRuntime?: ExtensionRuntime;
    agyLaunch?: ExecutableTool;
    /** Set to capture the provisional supervisor at the next prompt submission; the minted child name is resolved from the agent-start call. */
    captureAgyPrePromptFor?: boolean;
    agyPrePromptJob?: Record<string, unknown>;
    agyPrePromptAgent?: Record<string, unknown>;
    agyPrePromptRecipientFailureCode?: string;
    unconfirmedRecoveries: Array<{ paneId: string; supervisorJobId: string }>;
  } = { cwd: "", sessionStarted: false, fixtureCreated: false, registered: new Map(), commands: [], handlers: [], cliCalls: [], toolCalls: [], attachmentPaths: [], forceNextPromptConfirmationFailure: false, forceNextAgyStartFailure: false, unconfirmedRecoveries: [] };

  const run = async (...args: string[]): Promise<unknown> => {
    // The suite sets HERDR_SOCKET_PATH so the extension's supervision monitor
    // observes the disposable session. This helper predates it and selects its
    // session explicitly, so it must keep the ambient routing it always had.
    const ambient = { ...process.env };
    delete ambient.HERDR_SOCKET_PATH;
    const result = await execFileAsync("herdr", args, { cwd: state.cwd, maxBuffer: 2_000_000, env: ambient });
    return JSON.parse(result.stdout);
  };
  const runNamed = (args: string[]) => run("--session", REQUIRED_SESSION, ...args);
  const topologyIds = (snapshot: Record<string, unknown>) => ({
    workspaces: Array.isArray(snapshot.workspaces) ? snapshot.workspaces.map((item) => String(resultObject(item).workspace_id)).sort() : [],
    tabs: Array.isArray(snapshot.tabs) ? snapshot.tabs.map((item) => String(resultObject(item).tab_id)).sort() : [],
    panes: Array.isArray(snapshot.panes) ? snapshot.panes.map((item) => String(resultObject(item).pane_id)).sort() : []
  });

  const diagnosticRecord = (value: unknown): Record<string, unknown> => {
    const source = resultObject(value);
    const diagnostic = Object.fromEntries(["pane_id", "terminal_id", "agent_id", "name", "agent_name", "agent", "agent_status", "state_change_seq", "revision", "interactive_ready", "screen_detection_skipped"].flatMap((field): Array<[string, unknown]> => {
      const candidate = source[field];
      return typeof candidate === "string" || typeof candidate === "number" || typeof candidate === "boolean" || candidate === null ? [[field, candidate]] : [];
    }));
    const session = source.agent_session;
    if (typeof session === "object" && session !== null && !Array.isArray(session)) {
      const identity = session as Record<string, unknown>;
      if (["source", "agent", "kind", "value"].every((field) => typeof identity[field] === "string")) {
        const full = [identity.source, identity.agent, identity.kind, identity.value] as string[];
        diagnostic.agent_session = { source: full[0]!.slice(0, 256), agent: full[1]!.slice(0, 256), kind: full[2]!.slice(0, 256), value: full[3]!.slice(0, 256) };
        diagnostic.agent_session_fingerprint = createHash("sha256").update(JSON.stringify(full)).digest("hex");
      }
    }
    const identityTuple = [source.pane_id, source.terminal_id, source.name ?? source.agent_name, source.agent, diagnostic.agent_session_fingerprint];
    if (identityTuple.every((field) => typeof field === "string")) {
      diagnostic.identity_fingerprint = createHash("sha256").update(JSON.stringify(identityTuple)).digest("hex");
    }
    return diagnostic;
  };

  /**
   * The supervisor job targeting one runtime-minted child name. A retained
   * supervisor is the authoritative recovery handle for a launch whose prompt
   * submission could not be confirmed: the uniform result publishes no IDs for
   * a failed child, so they are read back here.
   */
  const supervisorJobForTarget = async (target: string): Promise<Record<string, unknown>> => {
    const listed = resultObject((await tool("herdr_jobs").execute(`supervisor-list-${target}`, { operation: "list", kind: "supervisor" }, signal(), undefined, toolContext())).details);
    const summaries = Array.isArray(listed.jobs) ? listed.jobs.map((value) => resultObject(value)) : [];
    const summary = summaries.find((job) => Array.isArray(job.targets) && job.targets.length === 1 && job.targets[0] === target);
    if (!summary || typeof summary.jobId !== "string") throw new Error(`no supervisor job targets child ${target}`);
    return resultObject((await tool("herdr_jobs").execute(`supervisor-get-${target}`, { operation: "get", jobId: summary.jobId }, signal(), undefined, toolContext())).details);
  };

  /** The pane a supervisor job watches: bound child view, provisional view, else committed target ID. */
  const jobPaneId = (job: Record<string, unknown>): string => {
    const supervision = resultObject(job.supervision ?? {});
    for (const view of [supervision.child, supervision.provisional]) {
      const paneId = resultObject(view ?? {}).paneId;
      if (typeof paneId === "string" && paneId.length > 0) return paneId;
    }
    const targetIds = resultObject(job.request ?? {}).targetIds;
    if (Array.isArray(targetIds) && typeof targetIds[0] === "string") return targetIds[0];
    throw new Error("supervisor job carried no child pane identity");
  };

  /**
   * Deterministic reviewed-point selection for the AGY-gated tests: the
   * catalog's AGY points rank first and Pi second at every tier, so the
   * runtime's own policy, tier envelope, and availability re-checks — all real
   * — resolve `agy:gemini-3.8-flash-low` as the first chain member. Every
   * other piece of the launch (socket transport, supervision, attachments,
   * recipients) stays the production plumbing.
   */
  const agyFirstSpecClient: Pick<TypeSafeSpecClient, "evaluate"> = {
    evaluate: async (input: TaskEvaluationInput): Promise<TaskEvaluation> => {
      const fitness: Record<string, Record<string, number>> = {};
      for (const [index, point] of (input.catalog.points ?? []).entries()) {
        const score = point.runner === "agy" ? 0.95 : point.runner === "pi" ? 0.9 : 0.5;
        fitness[String(index)] = { utility: score, economy: score, standard: score, strong: score, frontier: score, max: score };
      }
      const resources: Record<string, Record<string, Record<string, number>>> = {};
      for (const [kind, runner] of input.catalog.runners) {
        const fields: Record<string, Record<string, number>> = {};
        for (const field of ["tools", "extensions", "skills", "plugins", "mcp"] as const) {
          for (const name of runner.pools[field]) (fields[field] ??= {})[name] = 0.9;
        }
        if (Object.keys(fields).length > 0) resources[kind] = fields;
      }
      return {
        kind: "response",
        response: {
          quality: { done_when_verifiable: 0.95 },
          intent: { value: "implement", confidence: 0.95 },
          resources,
          fitness,
          uncertainDimensions: []
        }
      };
    }
  };

  /** The lazily-built AGY fixture: a second runtime bound to the same fixture pane and socket proxy, with only the spec evaluator stubbed. */
  const agyHarness = (): { launch: ExecutableTool; jobs: ExtensionRuntime["jobs"] } => {
    if (state.agyRuntime === undefined) {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HERDR_ENV: "1",
        HERDR_WORKSPACE_ID: state.workspaceId!,
        HERDR_TAB_ID: state.rootTabId!,
        HERDR_PANE_ID: state.rootPaneId!,
        HERDR_SOCKET_PATH: state.socketProxy!.path
      };
      const runtime = createRuntime({ exec: state.execCli! }, env);
      state.agyLaunch = createLaunchTool({
        cli: runtime.cli,
        context: runtime.context,
        cwd: state.cwd,
        preflight: async () => undefined,
        ownership: runtime.ownership,
        supervision: runtime.supervision,
        queueFlush: runtime.queueFlush,
        attachments: runtime.attachments,
        recipients: runtime.recipients,
        specClient: agyFirstSpecClient
      }) as unknown as ExecutableTool;
      state.agyRuntime = runtime;
    }
    return { launch: state.agyLaunch!, jobs: state.agyRuntime.jobs };
  };

  /** The AGY fixture's supervisor job readback — its reservations live in the second runtime's registry, not the registered surface's. */
  const agyJob = (jobId: string): Record<string, unknown> => {
    const detail = state.agyRuntime?.jobs.get(jobId);
    if (detail === undefined) throw new Error(`AGY supervisor job ${jobId} vanished`);
    return resultObject({ operation: "jobs", view: "job", ...detail });
  };

  const agyJobForTarget = (target: string): Record<string, unknown> => {
    const jobs = state.agyRuntime?.jobs;
    if (!jobs) throw new Error("AGY fixture registry absent");
    const summary = jobs.list(undefined, 0, 50, "supervisor").jobs.find((job) => Array.isArray(job.targets) && job.targets.length === 1 && job.targets[0] === target);
    if (!summary || typeof summary.jobId !== "string") throw new Error(`no supervisor job targets child ${target}`);
    return agyJob(summary.jobId);
  };

  const recordDeliveryFailureBeforeTeardown = async (label: string, launch: Record<string, unknown>, child: Record<string, unknown>, paneId: string | undefined, elapsedMs: number): Promise<void> => {
    process.stderr.write(`INTEGRATION_DELIVERY_FAILURE_DETAILS ${label} ${JSON.stringify({ elapsedMs, launch, child })}\n`);
    if (paneId === undefined) return;
    for (const [diagnostic, args] of [
      ["agent_get", ["agent", "get", paneId]],
      ["pane_get", ["pane", "get", paneId]]
    ] as const) {
      try {
        const value = resultObject(resultObject(await runNamed([...args])).result);
        process.stderr.write(`INTEGRATION_DELIVERY_${diagnostic.toUpperCase()} ${label} ${JSON.stringify(diagnosticRecord(value.agent ?? value.pane ?? value))}\n`);
      } catch (error) {
        process.stderr.write(`INTEGRATION_DELIVERY_${diagnostic.toUpperCase()}_FAILED ${label} ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    try {
      const snapshot = resultObject(resultObject(resultObject(await runNamed(["api", "snapshot"])).result).snapshot);
      const panes = Array.isArray(snapshot.panes) ? snapshot.panes.map(resultObject).filter((item) => item.pane_id === paneId).map(diagnosticRecord) : [];
      const agents = Array.isArray(snapshot.agents) ? snapshot.agents.map(resultObject).filter((item) => item.pane_id === paneId).map(diagnosticRecord) : [];
      process.stderr.write(`INTEGRATION_DELIVERY_SNAPSHOT ${label} ${JSON.stringify({ panes, agents })}\n`);
    } catch (error) {
      process.stderr.write(`INTEGRATION_DELIVERY_SNAPSHOT_FAILED ${label} ${error instanceof Error ? error.message : String(error)}\n`);
    }
  };

  const assertUnconfirmedRecovery = async (
    label: string,
    launch: Record<string, unknown>,
    childTarget: string,
    job: Record<string, unknown>,
    promptCanary: string,
    promptStart: number,
    cliStart: number,
    toolCallStart: number
  ): Promise<void> => {
    const supervisorJobId = job.jobId;
    if (typeof supervisorJobId !== "string") throw new Error("unconfirmed launch's supervisor omitted its job ID");
    const supervision = resultObject(job.supervision);
    const childView = resultObject(supervision.child ?? supervision.provisional);
    const paneId = jobPaneId(job);
    expect(job).toMatchObject({
      operation: "jobs",
      view: "job",
      jobId: supervisorJobId,
      kind: "supervisor",
      request: { kind: "supervisor" },
      operation_phase: expect.stringMatching(/^(?:accepted|running)$/u)
    });
    // A bound child commits its pane; a provisional child still waits to bind.
    if (supervision.child !== undefined) expect(job).toMatchObject({ request: { targetIds: [paneId] } });
    expect(childView).toMatchObject({ agentName: childTarget, paneId });
    expect(job).not.toHaveProperty("supervision_result");

    const promptCalls = state.socketProxy?.requests.slice(promptStart) ?? [];
    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0]!.method).toBe("agent.prompt");
    expect(promptCalls[0]!.target).toBe(paneId);
    expect(state.toolCalls.slice(toolCallStart).map(({ name }) => name).filter((name) => name === "herdr_wait" || name === "herdr_communicate")).toEqual([]);

    const launchCliCalls = state.cliCalls.slice(cliStart);
    const cleanupCalls = launchCliCalls.filter((args) =>
      (["pane", "tab", "workspace"].includes(args[0] ?? "") && ["close", "delete", "kill"].includes(args[1] ?? ""))
      || (args[0] === "agent" && ["close", "kill", "stop"].includes(args[1] ?? ""))
    );
    expect(cleanupCalls).toEqual([]);

    const liveResult = resultObject(resultObject(await runNamed(["agent", "get", paneId])).result);
    const liveAgent = resultObject(liveResult.agent ?? liveResult);
    expect({
      paneId: liveAgent.pane_id,
      terminalId: liveAgent.terminal_id,
      agentName: liveAgent.name ?? liveAgent.agent_name,
      agentKind: liveAgent.agent
    }).toEqual({
      paneId,
      terminalId: childView.terminalId,
      agentName: childTarget,
      agentKind: childView.agentKind
    });

    const monitor = resultObject(supervision.monitor);
    const reconciliation = resultObject(monitor.reconciliation);
    const healthKeys = new Set(["intervalMs", "degraded", "consecutiveFailures", "lastAttemptAtMs", "lastSuccessAtMs", "lastFailureAtMs", "lastFailureReason"]);
    expect(Object.keys(reconciliation).every((key) => healthKeys.has(key))).toBe(true);
    expect(Number.isSafeInteger(reconciliation.consecutiveFailures)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(reconciliation), "utf8")).toBeLessThanOrEqual(512);
    const jobEvidence = JSON.stringify(job);
    expect(jobEvidence.includes(promptCanary), "the supervisor job exposed the task prompt canary").toBe(false);
    if (!state.unconfirmedRecoveries.some((entry) => entry.paneId === paneId && entry.supervisorJobId === supervisorJobId)) {
      state.unconfirmedRecoveries.push({ paneId, supervisorJobId });
    }
    process.stderr.write(`INTEGRATION_UNCONFIRMED_RECOVERY ${label} ${JSON.stringify({ paneId, supervisorJobId, operation_phase: job.operation_phase, supervisionState: supervision.state, reconciliation })}\n`);
    expect(JSON.stringify(launch).includes(promptCanary), "the uniform launch result exposed the task prompt canary").toBe(false);
  };

  type LaunchDelivery = {
    confirmed: boolean;
    launch: Record<string, unknown>;
    child: Record<string, unknown>;
    paneId: string;
    supervisorJobId: string;
  };

  const deliverLaunch = async (label: string, promptCanary: string, call: () => Promise<{ details?: Record<string, unknown> }>): Promise<LaunchDelivery> => {
    const startedAt = performance.now();
    const promptStart = state.socketProxy?.requests.length ?? 0;
    const cliStart = state.cliCalls.length;
    const toolCallStart = state.toolCalls.length;
    const result = await call();
    const elapsedMs = performance.now() - startedAt;
    const launch = launchDetails(result.details);
    const child = singleLaunchChild(result.details);
    const childTarget = String(child.target);
    if (child.state === "launched") {
      if (typeof child.supervisorJobId !== "string") throw new Error(`${label} launched child omitted its supervisor job ID`);
      const supervisorJobId = child.supervisorJobId;
      const job = resultObject((await tool("herdr_jobs").execute(`${label}-launch-supervisor`, { operation: "get", jobId: supervisorJobId }, signal(), undefined, toolContext())).details);
      const paneId = jobPaneId(job);
      const promptRequests = state.socketProxy?.requests.slice(promptStart) ?? [];
      expect(promptRequests).toHaveLength(1);
      expect(promptRequests[0]).toMatchObject({ method: "agent.prompt", target: paneId });
      process.stderr.write(`INTEGRATION_DELIVERY_CONFIRMED ${label} ${JSON.stringify({ elapsedMs, target: childTarget, paneId, supervisorJobId, operatingPointId: child.operatingPointId })}\n`);
      return { confirmed: true, launch, child, paneId, supervisorJobId };
    }
    // The tolerated outcome is a post-submission failure: exactly one prompt
    // request reached the socket, so the task may have been consumed.
    // Any other child outcome — abstained, failed before submission, or
    // multiple submissions — is a real defect and fails this run.
    const childError = resultObject(child.error ?? {});
    const promptRequests = (state.socketProxy?.requests.slice(promptStart) ?? []).filter((request) => request.method === "agent.prompt");
    if (child.state !== "failed" || childError.code !== "PROMPT_UNCONFIRMED" || promptRequests.length !== 1) {
      await recordDeliveryFailureBeforeTeardown(label, launch, child, undefined, elapsedMs);
      throw new Error(`${label} returned state=${String(child.state)} code=${String(childError.code)} outcome=${String(launch.outcome)}`);
    }
    const attachmentPath = promptRequests[0]!.text?.match(/attachment-path: (\S+)/u)?.[1];
    if (attachmentPath !== undefined) state.attachmentPaths.push(attachmentPath);
    const job = await supervisorJobForTarget(childTarget);
    const paneId = jobPaneId(job);
    const supervisorJobId = String(job.jobId);
    await recordDeliveryFailureBeforeTeardown(label, launch, child, paneId, elapsedMs);
    await assertUnconfirmedRecovery(label, launch, childTarget, job, promptCanary, promptStart, cliStart, toolCallStart);
    // The helper performed only read-only recovery diagnostics. Callers return
    // immediately, so no marker, wait, communication, retry, or cleanup follows.
    return { confirmed: false, launch, child, paneId, supervisorJobId };
  };

  const tool = (name: string): ExecutableTool => {
    const found = state.registered.get(name);
    if (!found) throw new Error(`integration harness did not register ${name}`);
    return {
      name: found.name,
      execute(id, params, abortSignal, onUpdate, context) {
        state.toolCalls.push({ name, id });
        return found.execute(id, params, abortSignal, onUpdate, context);
      }
    };
  };

  const toolContext = () => ({ cwd: state.cwd, hasUI: false }) as ExtensionContext;
  const signal = () => new AbortController().signal;

  const closeConfirmedFixturePane = async (label: string, paneId: string): Promise<void> => {
    await runNamed(["pane", "close", paneId]);
    const deadline = performance.now() + 10_000;
    while (performance.now() < deadline) {
      try {
        await runNamed(["agent", "get", paneId]);
      } catch {
        process.stderr.write(`INTEGRATION_HARNESS_PANE_CLOSED ${label} ${paneId}\n`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`${label} agent remained visible after harness pane cleanup`);
  };

  beforeAll(async () => {
    expect(requestedSession).toBe(REQUIRED_SESSION);
    expect(process.env.HERDR_ENV).toBe("1");
    const currentIds = [process.env.HERDR_WORKSPACE_ID, process.env.HERDR_TAB_ID, process.env.HERDR_PANE_ID];
    expect(currentIds.every(Boolean)).toBe(true);
    state.cwd = await createDisposableGitWorkspace("herdr-tools-it-");

    const sessions = resultObject(await run("session", "list", "--json"));
    const existing = Array.isArray(sessions.sessions) && sessions.sessions.some((session) => resultObject(session).name === REQUIRED_SESSION);
    if (existing) throw new Error(`refusing to reuse existing session ${REQUIRED_SESSION}`);

    let startupError = "";
    state.server = spawn("herdr", ["--session", REQUIRED_SESSION, "server"], { cwd: state.cwd, stdio: ["ignore", "ignore", "pipe"] });
    state.server.stderr?.on("data", (chunk: Buffer) => { startupError = (startupError + chunk.toString()).slice(-2_000); });
    const startupDeadline = performance.now() + 10_000;
    while (performance.now() < startupDeadline) {
      if (state.server.exitCode !== null) throw new Error(`named Herdr server exited during startup: ${startupError}`);
      const listed = resultObject(await run("session", "list", "--json"));
      const started = Array.isArray(listed.sessions) ? listed.sessions.map(resultObject).find((value) => value.name === REQUIRED_SESSION && value.running === true) : undefined;
      state.sessionStarted = started !== undefined;
      if (started !== undefined) {
        // Supervision observes the same disposable session the CLI targets, so the
        // harness injects that session's socket exactly as Herdr injects a pane's.
        expect(typeof started.socket_path).toBe("string");
        state.socketPath = String(started.socket_path);
        state.socketProxy = await startDisposableSocketProxy(state.socketPath, join(state.cwd, "herdr-prompt.sock"), {
          onRequest: async (request) => {
            if (request.method === "agent.prompt" && state.forceNextPromptConfirmationFailure && request.target) {
              state.forceNextPromptConfirmationFailure = false;
              state.promptConfirmationFailurePaneId = request.target;
            }
            if (request.method === "agent.prompt" && state.captureAgyPrePromptFor && request.target) {
              const startCall = [...state.cliCalls].reverse().find((args) => args[0] === "agent" && args[1] === "start");
              const agentName = startCall?.[2];
              if (typeof agentName !== "string") throw new Error("AGY pre-prompt capture found no agent start call");
              const jobs = state.agyRuntime?.jobs;
              if (!jobs) throw new Error("AGY pre-prompt capture ran without the AGY fixture registry");
              const summary = jobs.list(undefined, 0, 50, "supervisor").jobs.find((job) => Array.isArray(job.targets) && job.targets.length === 1 && job.targets[0] === agentName);
              if (!summary || typeof summary.jobId !== "string") throw new Error("AGY provisional supervisor job was not published before prompt socket submission");
              const detail = jobs.get(summary.jobId);
              if (detail === undefined) throw new Error("AGY provisional supervisor job vanished before prompt socket submission");
              state.agyPrePromptJob = resultObject({ operation: "jobs", view: "job", ...detail });
              const live = resultObject(resultObject(await runNamed(["agent", "get", request.target])).result);
              state.agyPrePromptAgent = resultObject(live.agent ?? live);
              try {
                await tool("herdr_communicate").execute("agy-pre-prompt-recipient", { target: request.target, operation: "prompt", text: "must not publish", delivery: "attachment" }, signal(), undefined, toolContext());
              } catch (error) {
                state.agyPrePromptRecipientFailureCode = (error as { code?: string }).code;
              }
              state.captureAgyPrePromptFor = undefined;
            }
          }
        });
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!state.sessionStarted) throw new Error(`named Herdr server did not become ready: ${startupError}`);

    const current = resultObject(resultObject(resultObject(await run("api", "snapshot")).result).snapshot);
    const currentWorkspaceIds = Array.isArray(current.workspaces) ? current.workspaces.map((item) => resultObject(item).workspace_id) : [];
    expect(currentIds.every((id) => typeof id === "string" && !currentWorkspaceIds.includes(id))).toBe(false);
    state.baseline = topologyIds(current);

    const created = resultObject(resultObject(await runNamed(["workspace", "create", "--cwd", state.cwd, "--label", `pi-herdr-tools-it-${process.pid}`, "--no-focus"])).result);
    state.workspaceId = String(resultObject(created.workspace ?? created).workspace_id);
    state.fixtureCreated = true;

    const fixture = resultObject(resultObject(resultObject(await runNamed(["api", "snapshot"])).result).snapshot);
    const fixturePanes = Array.isArray(fixture.panes) ? fixture.panes.map(resultObject) : [];
    const rootPane = fixturePanes.find((pane) => pane.workspace_id === state.workspaceId);
    if (!rootPane || typeof rootPane.pane_id !== "string" || typeof rootPane.tab_id !== "string") throw new Error("fixture snapshot omitted its root pane context");
    state.rootPaneId = rootPane.pane_id;
    state.rootTabId = rootPane.tab_id;

    const pi = {
      async exec(command: string, args: string[], options?: { signal?: AbortSignal; timeout?: number }) {
        expect(command).toBe("herdr");
        state.cliCalls.push([...args]);
        if (args[0] === "agent" && args[1] === "get" && args[2] === state.promptConfirmationFailurePaneId) {
          state.promptConfirmationFailurePaneId = undefined;
          return { stdout: "", stderr: "forced disposable confirmation read failure", code: 1, killed: false };
        }
        if (state.forceNextAgyStartFailure && args[0] === "agent" && args[1] === "start" && args[args.indexOf("--kind") + 1] === "agy") {
          state.forceNextAgyStartFailure = false;
          return { stdout: "", stderr: JSON.stringify({ id: "cli:agent:start", error: { code: "agent_start_failed", message: "agent process exited before becoming interactive" } }), code: 1, killed: false };
        }
        try {
          const result = await execFileAsync(command, ["--session", REQUIRED_SESSION, ...args], {
            cwd: state.cwd,
            encoding: "utf8",
            maxBuffer: 2_000_000,
            signal: options?.signal,
            timeout: options?.timeout,
            env: {
              ...process.env,
              HERDR_ENV: "1",
              HERDR_WORKSPACE_ID: state.workspaceId,
              HERDR_TAB_ID: state.rootTabId,
              HERDR_PANE_ID: state.rootPaneId
            }
          });
          return { stdout: String(result.stdout), stderr: String(result.stderr), code: 0, killed: false };
        } catch (error) {
          const failed = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer; code?: number; killed?: boolean };
          return { stdout: String(failed.stdout ?? ""), stderr: String(failed.stderr ?? failed.message), code: failed.code ?? 1, killed: failed.killed ?? false };
        }
      },
      registerTool(registered: unknown) {
        const executable = registered as ExecutableTool;
        state.registered.set(executable.name, executable);
      },
      registerCommand(name: string) {
        state.commands.push(name);
      },
      on(event: string) {
        state.handlers.push(event);
      }
    } as unknown as ExtensionAPI;
    state.execCli = pi.exec.bind(pi);

    const saved = { env: process.env.HERDR_ENV, workspace: process.env.HERDR_WORKSPACE_ID, tab: process.env.HERDR_TAB_ID, pane: process.env.HERDR_PANE_ID, socket: process.env.HERDR_SOCKET_PATH };
    const savedCwd = process.cwd();
    process.chdir(state.cwd);
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = state.workspaceId;
    process.env.HERDR_TAB_ID = state.rootTabId;
    process.env.HERDR_PANE_ID = state.rootPaneId;
    // The supervision monitor reads this lazily on its first reservation, so the
    // disposable session's socket stays set for the life of the suite.
    process.env.HERDR_SOCKET_PATH = state.socketProxy!.path;
    try {
      extension();
    } finally {
      process.chdir(savedCwd);
      for (const [key, value] of Object.entries({ HERDR_ENV: saved.env, HERDR_WORKSPACE_ID: saved.workspace, HERDR_TAB_ID: saved.tab, HERDR_PANE_ID: saved.pane })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      state.savedSocketPath = saved.socket;
    }
  }, 120_000);

  afterAll(async () => {
    // The disposable session's socket path was left set for the supervision
    // monitor; restore the ambient value now that the suite is done with it.
    if (state.savedSocketPath === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = state.savedSocketPath;
    if (state.unconfirmedRecoveries.length > 0) {
      const snapshot = resultObject(resultObject(resultObject(await runNamed(["api", "snapshot"])).result).snapshot);
      const panes = Array.isArray(snapshot.panes) ? snapshot.panes.map(resultObject) : [];
      for (const recovery of state.unconfirmedRecoveries) {
        expect(panes).toEqual(expect.arrayContaining([expect.objectContaining({ pane_id: recovery.paneId })]));
      }
      process.stderr.write(`INTEGRATION_UNCONFIRMED_RETAINED_UNTIL_HARNESS_TEARDOWN ${JSON.stringify(state.unconfirmedRecoveries)}\n`);
    }
    if (state.agyRuntime !== undefined) {
      await state.agyRuntime.supervision.shutdown();
      state.agyRuntime.jobs.shutdown();
      await state.agyRuntime.queueFlush.shutdown();
      state.agyRuntime.cli.closePromptTransport();
    }
    if (state.fixtureCreated && state.workspaceId) {
      await runNamed(["workspace", "close", state.workspaceId]).catch((error) => process.stderr.write(`INTEGRATION_TEARDOWN_FAILURE ${String(error)}\n`));
    }
    if (state.sessionStarted) {
      await run("session", "stop", REQUIRED_SESSION, "--json").catch((error) => process.stderr.write(`INTEGRATION_SESSION_STOP_FAILURE ${String(error)}\n`));
    }
    await stopDisposableServer(state.server);
    await state.socketProxy?.close();
    if (state.sessionStarted) {
      await run("session", "delete", REQUIRED_SESSION, "--json").catch((error) => process.stderr.write(`INTEGRATION_SESSION_DELETE_FAILURE ${String(error)}\n`));
    }
    // Remove only the recipient directories this run published into.
    for (const path of new Set(state.attachmentPaths)) {
      await rm(dirname(dirname(path)), { recursive: true, force: true }).catch((error) => process.stderr.write(`INTEGRATION_ATTACHMENT_CLEANUP_FAILURE ${String(error)}\n`));
    }
    if (state.cwd) await rm(state.cwd, { recursive: true, force: true });
  }, 120_000);

  it("registers the extension surface and mutates only the disposable session", async () => {
    expect([...state.registered.keys()]).toEqual([...CORE_TOOL_NAMES]);
    expect([...state.registered.values()].every((registered) => typeof registered.execute === "function")).toBe(true);
    expect(state.commands).toEqual(["herdr-waits"]);
    expect(state.handlers).toEqual(["session_shutdown", "session_start"]);

    const inspected = await tool("herdr_inspect").execute("inspect", { mode: "collection", collection: "panes" }, signal(), undefined, toolContext());
    expect(resultObject(inspected.details).items).toEqual(expect.arrayContaining([expect.objectContaining({ workspace_id: state.workspaceId })]));
    const createdTab = await tool("herdr_tab").execute("create-tab", { operation: "create", label: "extension-smoke" }, signal(), undefined, toolContext());
    const createdTabId = resultObject(createdTab.details).tabId;
    if (typeof createdTabId !== "string") throw new Error("extension tab create omitted its authoritative ID");
    await tool("herdr_tab").execute("close-tab", { operation: "close", target: createdTabId }, signal(), undefined, toolContext());
    expect(state.cliCalls.some((args) => args[0] === "tab" && args[1] === "create")).toBe(true);
    expect(state.cliCalls.some((args) => args[0] === "tab" && args[1] === "close")).toBe(true);

    const defaultAfter = resultObject(resultObject(resultObject(await run("api", "snapshot")).result).snapshot);
    expect(topologyIds(defaultAfter)).toEqual(state.baseline);
  }, 120_000);

  it.runIf(agyEnabled)("qualifies one AGY task from provisional publication through exact attachment readback", async () => {
    const harness = agyHarness();
    const nonce = `agy-attachment-${randomUUID()}`;
    const promptStart = state.socketProxy?.requests.length ?? 0;
    const cliStart = state.cliCalls.length;
    state.captureAgyPrePromptFor = true;
    const startedAt = performance.now();
    // Delivery is runtime-owned, so the attachment path is exercised by making
    // the Task body exceed the inline bound. The stubbed evaluator ranks the
    // reviewed AGY points first, so `agy:gemini-3.8-flash-low` is the runtime's
    // first chain member at the standard tier.
    const padding = `Qualifier detail line ${"x".repeat(24)}.\n`.repeat(900);
    const task = {
      objective: `Read this task attachment through the granted directory. Respond with only this exact token: ${nonce}`,
      scope: `Read the attachment only. Change nothing.\n\n${padding}`,
      doneWhen: ["The reply is exactly the attachment token and nothing else."],
      constraints: ["none"],
      label: "agy-qualification"
    };
    let launch: Record<string, unknown>;
    let child: Record<string, unknown>;
    try {
      const launched = await harness.launch.execute("agy-qualification", task, signal(), undefined, toolContext());
      launch = launchDetails(launched.details);
      child = singleLaunchChild(launched.details);
      if (child.state !== "launched") {
        // A post-submission failure retains the provisional AGY supervisor; the
        // result publishes no handles, so they come from the jobs readback.
        const childError = resultObject(child.error ?? {});
        const promptCalls = (state.socketProxy?.requests.slice(promptStart) ?? []).filter((request) => request.method === "agent.prompt");
        if (childError.code !== "PROMPT_UNCONFIRMED" || promptCalls.length !== 1) throw new Error(`agy-qualification child returned state=${String(child.state)} code=${String(childError.code)}`);
        const retained = agyJobForTarget(String(child.target));
        const paneId = jobPaneId(retained);
        const supervisorJobId = String(retained.jobId);
        const failureCalls = state.cliCalls.slice(cliStart);
        expect(failureCalls.filter((args) => args[0] === "agent" && args[1] === "start")).toHaveLength(1);
        expect(failureCalls.filter((args) => (["pane", "tab", "workspace"].includes(args[0] ?? "") && ["close", "delete", "kill"].includes(args[1] ?? "")) || (args[0] === "agent" && ["close", "kill", "stop"].includes(args[1] ?? "")))).toEqual([]);
        expect(retained).toMatchObject({
          operation_phase: "running",
          request: { targetIds: [] },
          supervision: { state: "provisional", provisional: { paneId, agentKind: "agy", operatingPointId: "agy:gemini-3.8-flash-low" } }
        });
        expect(retained).not.toHaveProperty("supervision_result");
        state.unconfirmedRecoveries.push({ paneId, supervisorJobId });
        process.stderr.write(`INTEGRATION_AGY_UNCERTAIN_RETAINED ${JSON.stringify({ paneId, supervisorJobId, launch, child })}\n`);
        await recordDeliveryFailureBeforeTeardown("agy-qualification", launch, child, paneId, performance.now() - startedAt);
        return;
      }
    } finally {
      state.captureAgyPrePromptFor = undefined;
    }

    const operatingPointId = String(child.operatingPointId);
    expect(operatingPointId).toBe("agy:gemini-3.8-flash-low");
    const agentName = String(child.target);
    const supervisorJobId = String(child.supervisorJobId);
    const launchJob = agyJob(supervisorJobId);
    const paneId = jobPaneId(launchJob);
    const promptCalls = (state.socketProxy?.requests.slice(promptStart) ?? []).filter((request) => request.method === "agent.prompt");
    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0]).toMatchObject({ method: "agent.prompt", target: paneId });
    expect(promptCalls[0]!.text).toContain("[HERDR AGENT MESSAGE v1]");
    expect(promptCalls[0]!.text).toContain("authority: agent; not user/owner");
    expect(promptCalls[0]!.text).toContain("delivery: attachment");
    expect(promptCalls[0]!.text).not.toContain(nonce);
    const attachmentPath = promptCalls[0]!.text?.match(/attachment-path: (\S+)/u)?.[1];
    if (typeof attachmentPath !== "string") throw new Error("AGY qualification prompt omitted its attachment path");
    state.attachmentPaths.push(attachmentPath);
    expect(promptCalls[0]!.text).toContain(`attachment-path: ${attachmentPath}`);

    const startCalls = state.cliCalls.slice(cliStart).filter((args) => args[0] === "agent" && args[1] === "start");
    const grantedDirectory = dirname(dirname(attachmentPath));
    expect(startCalls).toEqual([[
      "agent", "start", agentName, "--kind", "agy", "--pane", paneId, "--timeout", "120000", "--",
      "--model", operatingPointId.slice("agy:".length), "--mode", "plan", "--dangerously-skip-permissions", "--add-dir", grantedDirectory,
      "--prompt-interactive", "Initialize this interactive session and reply with exactly AGY_READY."
    ]]);
    expect(state.agyPrePromptAgent).toMatchObject({ agent: "agy", interactive_ready: true });
    expect(state.agyPrePromptRecipientFailureCode).toBe("ATTACHMENT_TARGET_UNVERIFIED");
    const provisionalJob = resultObject(state.agyPrePromptJob);
    expect(provisionalJob).toMatchObject({
      operation_phase: "running",
      request: { targetIds: [], child: { agentName, agentKind: "agy", operatingPointId } },
      supervision: { state: "provisional", provisional: { agentName, agentKind: "agy", paneId, operatingPointId, baseline: { state: "idle", stateChangeSeq: expect.any(Number), revision: expect.any(Number) } } }
    });
    expect(provisionalJob).not.toHaveProperty("supervision_result");
    const strengthened = resultObject((await tool("herdr_jobs").execute("agy-strengthened", { operation: "get", jobId: supervisorJobId }, signal(), undefined, toolContext())).details);
    expect(strengthened).toMatchObject({ operation_phase: "running", request: { targetIds: [paneId], child: { agentName, agentKind: "agy", operatingPointId } }, supervision: { state: "active", child: { agentName, agentKind: "agy", paneId, operatingPointId } } });
    expect(resultObject(strengthened.supervision)).not.toHaveProperty("provisional");
    const wait = await tool("herdr_wait").execute("agy-attachment-readback", { targets: [paneId], match: "any", condition: { kind: "output", match: { kind: "literal", value: nonce } }, timeoutMs: ACCEPTANCE_DEADLINE_MS, label: "AGY attachment nonce readback" }, signal(), undefined, toolContext());
    const waitJobId = String(resultObject(wait.details).jobId);
    const settled = await waitForCondition(async () => resultObject((await tool("herdr_jobs").execute("agy-readback-job", { operation: "get", jobId: waitJobId }, signal(), undefined, toolContext())).details), (job) => job?.operation_phase === "settled", ACCEPTANCE_DEADLINE_MS, 500);
    expect(settled).toMatchObject({ operation_phase: "settled", wait_result: "condition_met", result: { matched: true } });
    expect(await readFile(attachmentPath, "utf8")).toContain(nonce);
    expect(dirname(dirname(attachmentPath))).toBe(grantedDirectory);
    await closeConfirmedFixturePane("agy-qualification", paneId);
    const proofPath = process.env.HERDR_TOOLS_AGY_INTEGRATION_PROOF;
    if (!proofPath) throw new Error("AGY integration proof path was not supplied by the integration runner");
    await writeFile(proofPath, "qualified");
  }, 360_000);

  it.runIf(agyEnabled)("falls back from the first chain candidate only after an exact pre-interactive zero-effect failure", async () => {
    const harness = agyHarness();
    const cliStart = state.cliCalls.length;
    const promptStart = state.socketProxy?.requests.length ?? 0;
    state.forceNextAgyStartFailure = true;
    const launched = await harness.launch.execute("agy-zero-effect-fallback", {
      objective: "Reply with the single word ready.",
      scope: "Change nothing.",
      doneWhen: ["The reply is the single word ready."],
      constraints: ["none"],
      label: "fallback"
    }, signal(), undefined, toolContext());
    const child = singleLaunchChild(launched.details);
    if (child.state !== "launched") throw new Error(`agy-zero-effect-fallback child returned state=${String(child.state)} error=${JSON.stringify(child.error ?? {})}`);
    // The stubbed evaluator ranks the AGY point first and Pi second, so the
    // fallback chain is deterministic: agy start fails once, then the next
    // reviewed chain member — a Pi point — launches on the same pane.
    expect(String(child.operatingPointId)).toMatch(/^pi:/u);
    const supervisorJobId = String(child.supervisorJobId);
    const paneId = jobPaneId(agyJob(supervisorJobId));
    const calls = state.cliCalls.slice(cliStart);
    const starts = calls.filter((args) => args[0] === "agent" && args[1] === "start");
    // The forced AGY failure fires on the first AGY start call; a fresh pane's
    // shell may still be registering, so the selected fallback can retry
    // agent_pane_busy until the settle window passes.
    const agyStarts = starts.filter((args) => args[args.indexOf("--kind") + 1] === "agy");
    const fallbackStarts = starts.filter((args) => args[args.indexOf("--kind") + 1] !== "agy");
    expect(agyStarts).toHaveLength(1);
    expect(fallbackStarts.length).toBeGreaterThanOrEqual(1);
    expect(state.forceNextAgyStartFailure).toBe(false);
    expect(agyStarts[0]).toEqual(expect.arrayContaining(["--kind", "agy", "--model", "gemini-3.8-flash-low", "--mode", "plan", "--dangerously-skip-permissions"]));
    expect(agyStarts[0]!.slice(-2)).toEqual(["--prompt-interactive", "Initialize this interactive session and reply with exactly AGY_READY."]);
    const promptCalls = (state.socketProxy?.requests.slice(promptStart) ?? []).filter((request) => request.method === "agent.prompt");
    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0]).toMatchObject({ method: "agent.prompt", target: paneId });
    const lastAgyStartIndex = calls.lastIndexOf(agyStarts[0]!);
    const firstFallbackStartIndex = calls.indexOf(fallbackStarts[0]!);
    expect(lastAgyStartIndex).toBeLessThan(firstFallbackStartIndex);
    // Zero-effect: the failed AGY attempt issued no prompt and no teardown
    // before the fallback reused the resolved pane.
    expect(calls.filter((args) => (["pane", "tab", "workspace"].includes(args[0] ?? "") && ["close", "delete", "kill"].includes(args[1] ?? "")) || (args[0] === "agent" && ["close", "kill", "stop"].includes(args[1] ?? "")))).toEqual([]);
    expect(calls.slice(lastAgyStartIndex + 1, firstFallbackStartIndex)).toContainEqual(["pane", "get", paneId]);
    await closeConfirmedFixturePane("agy-zero-effect-fallback", paneId);
  }, 300_000);

  it("retains exact supervision after deterministic task-confirmation uncertainty", async () => {
    const canary = `unconfirmed-task-${randomUUID()}`;
    state.forceNextPromptConfirmationFailure = true;
    const launched = await deliverLaunch("unconfirmed-recovery-launch", canary, () => tool("herdr_launch").execute("unconfirmed-recovery-launch", {
      objective: `Recovery integration canary: ${canary}. Do not call any tool, do not modify files, and do not close or move this pane; remain idle while the task is delivered.`,
      scope: "Call no tools and change nothing in the repository.",
      doneWhen: ["The launched pane remains live at the same pane identity while the task is delivered."],
      constraints: ["none"],
      tier: "frontier",
      label: "recovery"
    }, signal(), undefined, toolContext()));
    expect(launched.confirmed).toBe(false);
    if (launched.confirmed) throw new Error("forced confirmation uncertainty unexpectedly returned launch success");
    expect(state.promptConfirmationFailurePaneId).toBeUndefined();
    expect(state.unconfirmedRecoveries).toEqual(expect.arrayContaining([
      { paneId: launched.paneId, supervisorJobId: launched.supervisorJobId }
    ]));
  }, 120_000);

  /**
   * Transport smoke: non-gating evidence about the route, the transport, and the published
   * artifact. It deliberately makes no claim about what a recipient agent read; the
   * acceptance tests below own that claim.
   */
  it("routes wrapped text over the session-bound prompt socket transport and publishes exact artifacts", async () => {
    if (state.unconfirmedRecoveries.length >= 2) return;
    const inlineTask = {
      objective: ["integration canary", ...Array.from({ length: 320 }, (_value, index) => `long task line ${index}`)].join("\n"),
      scope: "Change nothing.",
      doneWhen: ["The prompt-socket request contains the complete task text and the agent-start arguments contain none of that text."],
      constraints: ["none"],
      tier: "frontier" as const,
      label: "smoke"
    };
    const inline = await deliverLaunch("task-inline-launch", "integration canary", () => tool("herdr_launch").execute("launch-task-inline", inlineTask, signal(), undefined, toolContext()));
    if (!inline.confirmed) return;
    const inlinePaneId = inline.paneId;
    const startArgs = state.cliCalls.find((args) => args[0] === "agent" && args[1] === "start" && args.includes(String(inline.child.target)));
    expect(startArgs).toBeDefined();

    const inlineDelivery = state.socketProxy?.requests.find((request) => request.target === inlinePaneId && request.text?.includes("integration canary"));
    expect(inlineDelivery, "task-inline-launch did not record its prompt-socket submission").toBeDefined();
    expect(inlineDelivery!.method).toBe("agent.prompt");
    expect(inlineDelivery!.target).toBe(inlinePaneId);
    expect(inlineDelivery!.text).toContain("[HERDR AGENT MESSAGE v1]");
    expect(inlineDelivery!.text).toContain("authority: agent; not user/owner");
    expect(inlineDelivery!.text).toContain("delivery: inline");
    expect(state.cliCalls.some((args) => args.some((arg) => arg.includes("integration canary")))).toBe(false);
    await closeConfirmedFixturePane("task-inline-launch", inlinePaneId);

    // The attachment path is runtime-selected: the Task body must exceed the
    // inline bound for the runtime to publish an artifact.
    const bodyTask = {
      objective: `Transport smoke body.\n${"detail line\n".repeat(2000)}`,
      scope: "Change nothing. Do not call tools or modify files; this task is verified from the published artifact.",
      doneWhen: ["The published attachment contains the complete task body with mode 0600 and the agent-start arguments contain none of that body."],
      constraints: ["none"],
      tier: "frontier" as const,
      label: "body"
    };
    const attachmentLaunch = await deliverLaunch("task-attachment-launch", "detail line", () => tool("herdr_launch").execute("launch-task-attachment", bodyTask, signal(), undefined, toolContext()));
    if (!attachmentLaunch.confirmed) return;
    const attachmentPaneId = attachmentLaunch.paneId;
    const envelope = (state.socketProxy?.requests ?? []).filter((request) => request.method === "agent.prompt" && request.target === attachmentPaneId);
    expect(envelope, "task-attachment-launch did not record its prompt-socket submission").toHaveLength(1);
    expect(envelope[0]!.text).toContain("[HERDR AGENT MESSAGE v1]");
    expect(envelope[0]!.text).toContain("delivery: attachment");
    expect(envelope[0]!.text).not.toContain("detail line");
    const attachmentPath = envelope[0]!.text?.match(/attachment-path: (\S+)/u)?.[1];
    const attachmentSha = envelope[0]!.text?.match(/attachment-sha256: (\S+)/u)?.[1];
    if (typeof attachmentPath !== "string" || typeof attachmentSha !== "string") throw new Error("attachment envelope omitted its path or digest");
    state.attachmentPaths.push(attachmentPath);
    // The published body is the canonical Task text plus the runtime's managed
    // handoff contract; the fixture parses both back out of the artifact.
    const published = await readFile(attachmentPath, "utf8");
    expect(published.startsWith(renderTask(bodyTask))).toBe(true);
    const artifactPath = published.match(/at this exact path: (\S+)/u)?.[1];
    const marker = published.match(/run marker verbatim: (\S+)/u)?.[1];
    if (typeof artifactPath !== "string" || typeof marker !== "string") throw new Error("published attachment omitted its handoff contract");
    const renderedBody = renderTask(bodyTask) + renderHandoffContract({ artifactPath, marker } as HandoffAllocation);
    expect(published).toBe(renderedBody);
    const attachmentStart = state.cliCalls.find((args) => args[0] === "agent" && args[1] === "start" && args.includes(String(attachmentLaunch.child.target)));
    expect(attachmentStart).toBeDefined();
    expect(createHash("sha256").update(renderedBody, "utf8").digest("hex")).toBe(attachmentSha);
    expect((await stat(attachmentPath)).mode & 0o777).toBe(0o600);
    expect(state.cliCalls.some((args) => args.some((arg) => arg.includes("detail line")))).toBe(false);
    await closeConfirmedFixturePane("task-attachment-launch", attachmentPaneId);
  }, 240_000);

  /**
   * Acceptance: a semantically confirmed recipient must produce a value that
   * never appears verbatim in its task. Exact fail-closed launch
   * uncertainty is accepted but returns before the readback assertion.
   */
  it("accepts a runtime-selected recipient readback only with agent-produced evidence", async () => {
    if (state.unconfirmedRecoveries.length > 0) return;
    const left = randomUUID();
    const right = randomUUID();
    const expected = `${left}:${right}`;
    const launched = await deliverLaunch("task-acceptance-launch", left, () => tool("herdr_launch").execute("accept-task", {
      objective: `Join the first token ${left} and the second token ${right} with one colon, then reply with only the joined value. Do not call tools or modify files.`,
      scope: "Call no tools and change nothing.",
      doneWhen: ["The response is the first token, one colon, and the second token, with no other text."],
      constraints: ["none"],
      tier: "frontier",
      label: "accept"
    }, signal(), undefined, toolContext()));
    if (!launched.confirmed) return;
    const paneId = launched.paneId;
    const produced = await waitForCondition(async () => resultObject((await tool("herdr_inspect").execute("accept-task-readback", { mode: "target", target: paneId }, signal(), undefined, toolContext())).details), (details) => JSON.stringify(details.recentUnwrappedLines).includes(expected), ACCEPTANCE_DEADLINE_MS, 500);
    expect(produced, `Runtime-selected recipient did not produce the joined readback ${expected}`).toBeDefined();
    await closeConfirmedFixturePane("task-acceptance-launch", paneId);
  }, 300_000);

});
