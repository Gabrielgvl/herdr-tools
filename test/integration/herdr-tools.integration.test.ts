import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import extension, { CORE_TOOL_NAMES } from "../../index.js";
import { renderAssignment } from "../../src/launch-schema.js";
import { renderHandoffContract, type HandoffAllocation } from "../../src/handoff.js";
import { startDisposableSocketProxy, stopDisposableServer, waitForCondition } from "./disposable-session.js";

interface ExecutableTool {
  name: string;
  execute(id: string, params: unknown, signal: AbortSignal, onUpdate: undefined, context: ExtensionContext): Promise<{ details?: Record<string, unknown> }>;
}

const execFileAsync = promisify(execFile);
const REQUIRED_SESSION = "herdr-tools-integration";
const requestedSession = process.env.HERDR_TOOLS_INTEGRATION_SESSION ?? REQUIRED_SESSION;
const enabled = process.env.HERDR_TOOLS_RUN_INTEGRATION === "1";
const agyEnabled = process.env.HERDR_TOOLS_RUN_AGY_INTEGRATION === "1";
// The suite needs a pi model that can actually generate; when the profile's
// pinned model has no upstream quota, HERDR_TOOLS_INTEGRATION_PI_MODEL selects
// a working provider/model pair for every worker-pi launch below. Unset means
// the profile default runs unchanged.
const piLaunchOverrides = process.env.HERDR_TOOLS_INTEGRATION_PI_MODEL === undefined ? undefined : { model: process.env.HERDR_TOOLS_INTEGRATION_PI_MODEL };
const piEffectiveModel = process.env.HERDR_TOOLS_INTEGRATION_PI_MODEL ?? "openai-codex/gpt-5.6-luna";
const ACCEPTANCE_DEADLINE_MS = 150_000;

function resultObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("integration response is not an object");
  return value as Record<string, unknown>;
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
    profilePromptContent: string;
    attachmentPaths: string[];
    forceNextPromptConfirmationFailure: boolean;
    promptConfirmationFailurePaneId?: string;
    forceNextAgyStartFailure: boolean;
    captureAgyPrePromptFor?: string;
    agyPrePromptJob?: Record<string, unknown>;
    agyPrePromptAgent?: Record<string, unknown>;
    agyPrePromptRecipientFailureCode?: string;
    unconfirmedRecoveries: Array<{ paneId: string; supervisorJobId: string }>;
  } = { cwd: "", sessionStarted: false, fixtureCreated: false, registered: new Map(), commands: [], handlers: [], cliCalls: [], toolCalls: [], profilePromptContent: "", attachmentPaths: [], forceNextPromptConfirmationFailure: false, forceNextAgyStartFailure: false, unconfirmedRecoveries: [] };

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

  const readinessDiagnostic = (details: Record<string, unknown>): Record<string, unknown> => {
    const readiness = resultObject(details.readiness ?? {});
    const records = Array.isArray(readiness.records) ? readiness.records.map((value) => {
      const record = resultObject(value);
      return { recordSource: record.source, ...diagnosticRecord(record) };
    }) : [];
    return {
      budgetBasis: readiness.budgetBasis,
      budgetMs: readiness.budgetMs,
      elapsedMs: readiness.elapsedMs,
      samples: readiness.samples,
      lastPendingReason: readiness.lastPendingReason,
      baselineRequired: readiness.baselineRequired,
      records
    };
  };

  const SCHEDULING_TOLERANCE_MS = 500;
  const assertLaunchPhaseTiming = (details: Record<string, unknown>, monotonicWallElapsedMs: number, confirmationTimedOut: boolean): void => {
    const readiness = resultObject(details.readiness);
    const confirmation = resultObject(details.promptConfirmation);
    const timing = resultObject(details.timing);
    const selectedStartReadinessMs = timing.selectedStartReadinessMs;
    const promptSubmissionAckMs = timing.promptSubmissionAckMs;
    const postAckConfirmationMs = timing.postAckConfirmationMs;
    for (const duration of [selectedStartReadinessMs, promptSubmissionAckMs, postAckConfirmationMs]) {
      expect(Number.isSafeInteger(duration)).toBe(true);
      expect(Number(duration)).toBeGreaterThanOrEqual(0);
    }
    const decomposedPhaseElapsedMs = Number(selectedStartReadinessMs) + Number(promptSubmissionAckMs) + Number(postAckConfirmationMs);
    expect(decomposedPhaseElapsedMs).toBeLessThanOrEqual(monotonicWallElapsedMs + SCHEDULING_TOLERANCE_MS);
    expect(readiness.elapsedMs).toBe(selectedStartReadinessMs);
    expect(confirmation.elapsedMs).toBe(postAckConfirmationMs);
    if (confirmationTimedOut) {
      expect(Number(postAckConfirmationMs)).toBeGreaterThanOrEqual(5_000 - SCHEDULING_TOLERANCE_MS);
      expect(Number(postAckConfirmationMs)).toBeLessThanOrEqual(monotonicWallElapsedMs + SCHEDULING_TOLERANCE_MS);
    }
  };

  const recordDeliveryFailureBeforeTeardown = async (label: string, failure: { code?: string; details: Record<string, unknown> }, elapsedMs: number): Promise<void> => {
    const details = failure.details;
    process.stderr.write(`INTEGRATION_DELIVERY_FAILURE_DETAILS ${label} ${JSON.stringify({ elapsedMs, code: failure.code, causeCode: details.causeCode, phase: details.phase, promptSubmitted: details.promptSubmitted, promptConsumption: details.promptConsumption, readiness: readinessDiagnostic(details), initialPromptSubmission: details.initialPromptSubmission, promptConfirmation: details.promptConfirmation, timing: details.timing, created: details.created })}\n`);
    const created = resultObject(details.created ?? {});
    const paneId = typeof created.paneId === "string" ? created.paneId : typeof details.paneId === "string" ? details.paneId : undefined;
    if (!paneId) return;
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

  /**
   * Every feature delivery is a gate. Keep bounded diagnostic evidence, then
   * rethrow so a lost or unacknowledged prompt/attachment fails the run rather
   * than being converted into a skipped acceptance claim.
   */
  const deliver = async (label: string, call: Promise<{ details?: Record<string, unknown> }>): Promise<{ confirmed: true; details: Record<string, unknown> }> => {
    const startedAt = performance.now();
    try {
      const result = await call;
      process.stderr.write(`INTEGRATION_DELIVERY_CONFIRMED ${label}\n`);
      return { confirmed: true, details: resultObject(result.details) };
    } catch (error) {
      const failure = error as { code?: string; details?: Record<string, unknown> };
      if (failure.details === undefined) throw error;
      // Argv-path failures keep bounded CLI text; prompt deliveries are non-textual by design.
      const evidence = [failure.details.stdout, failure.details.stderr].filter((value) => typeof value === "string" && value.length > 0).join(" | ").slice(0, 600).replace(/\s+/gu, " ");
      const attachment = resultObject(failure.details.attachment ?? {});
      if (typeof attachment.path === "string") state.attachmentPaths.push(attachment.path);
      process.stderr.write(`INTEGRATION_DELIVERY_FAILED ${label} code=${String(failure.code)} causeCode=${String(failure.details.causeCode)} phase=${String(failure.details.phase)}${evidence ? ` evidence=${evidence}` : ""}\n`);
      await recordDeliveryFailureBeforeTeardown(label, { code: failure.code, details: failure.details }, performance.now() - startedAt);
      throw error;
    }
  };

  const assertUnconfirmedRecovery = async (
    label: string,
    details: Record<string, unknown>,
    promptCanary: string,
    promptStart: number,
    cliStart: number,
    toolCallStart: number
  ): Promise<void> => {
    expect(details).toMatchObject({
      assignmentState: "unconfirmed",
      recipientRegistered: false,
      paneId: expect.any(String),
      supervisorJobId: expect.any(String),
      supervision: {
        jobId: expect.any(String),
        state: "active",
        child: {
          agentName: expect.any(String),
          agentKind: expect.any(String),
          paneId: expect.any(String),
          terminalId: expect.any(String),
          profileName: expect.any(String)
        }
      }
    });
    const paneId = details.paneId;
    const supervisorJobId = details.supervisorJobId;
    if (typeof paneId !== "string" || typeof supervisorJobId !== "string") throw new Error("unconfirmed launch omitted exact recovery IDs");
    const launchSupervision = resultObject(details.supervision);
    const launchChild = resultObject(launchSupervision.child);
    expect(launchSupervision.jobId).toBe(supervisorJobId);
    expect(launchChild.paneId).toBe(paneId);

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
    const expectedSession = resultObject(resultObject(details.initialPromptSubmission).agentSession);
    expect({
      paneId: liveAgent.pane_id,
      terminalId: liveAgent.terminal_id,
      agentName: liveAgent.name ?? liveAgent.agent_name,
      agentKind: liveAgent.agent,
      agentSession: liveAgent.agent_session
    }).toEqual({
      paneId,
      terminalId: launchChild.terminalId,
      agentName: launchChild.agentName,
      agentKind: launchChild.agentKind,
      agentSession: expectedSession
    });

    const jobResult = await tool("herdr_jobs").execute(`${label}-supervisor`, { operation: "get", jobId: supervisorJobId }, signal(), undefined, toolContext());
    const job = resultObject(jobResult.details);
    expect(job).toMatchObject({
      operation: "jobs",
      view: "job",
      jobId: supervisorJobId,
      kind: "supervisor",
      request: { kind: "supervisor", targetIds: [paneId] },
      supervision: {
        state: expect.stringMatching(/^(?:active|degraded)$/u),
        child: {
          agentName: launchChild.agentName,
          agentKind: launchChild.agentKind,
          paneId,
          terminalId: launchChild.terminalId,
          profileName: launchChild.profileName
        },
        monitor: {
          reconciliation: {
            intervalMs: 30_000,
            degraded: expect.any(Boolean),
            consecutiveFailures: expect.any(Number)
          }
        }
      }
    });
    expect(["accepted", "running"]).toContain(job.operation_phase);
    expect(job).not.toHaveProperty("supervision_result");

    const supervision = resultObject(job.supervision);
    const monitor = resultObject(supervision.monitor);
    const reconciliation = resultObject(monitor.reconciliation);
    const healthKeys = new Set(["intervalMs", "degraded", "consecutiveFailures", "lastAttemptAtMs", "lastSuccessAtMs", "lastFailureAtMs", "lastFailureReason"]);
    expect(Object.keys(reconciliation).every((key) => healthKeys.has(key))).toBe(true);
    expect(Number.isSafeInteger(reconciliation.consecutiveFailures)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(reconciliation), "utf8")).toBeLessThanOrEqual(512);
    const jobEvidence = JSON.stringify(job);
    expect(jobEvidence.includes(promptCanary), "the supervisor job exposed the assignment prompt canary").toBe(false);
    expect(jobEvidence).not.toContain(String(expectedSession.value));
    if (!state.unconfirmedRecoveries.some((entry) => entry.paneId === paneId && entry.supervisorJobId === supervisorJobId)) {
      state.unconfirmedRecoveries.push({ paneId, supervisorJobId });
    }
    process.stderr.write(`INTEGRATION_UNCONFIRMED_RECOVERY ${label} ${JSON.stringify({ paneId, supervisorJobId, operation_phase: job.operation_phase, supervisionState: supervision.state, reconciliation })}\n`);
    expect(JSON.stringify(details).includes(promptCanary), "rich launch failure details exposed the assignment prompt canary").toBe(false);
  };

  type LaunchDelivery = { confirmed: true; details: Record<string, unknown> } | { confirmed: false; details: Record<string, unknown> };

  const deliverLaunch = async (label: string, promptCanary: string, call: () => Promise<{ details?: Record<string, unknown> }>): Promise<LaunchDelivery> => {
    const startedAt = performance.now();
    const promptStart = state.socketProxy?.requests.length ?? 0;
    const cliStart = state.cliCalls.length;
    const toolCallStart = state.toolCalls.length;
    try {
      const result = await call();
      const wallElapsedMs = performance.now() - startedAt;
      const details = resultObject(result.details);
      expect(details).toMatchObject({
        promptSubmitted: true,
        promptConsumption: "confirmed",
        readiness: { budgetBasis: "immediately_before_selected_agent_start", budgetMs: 120_000, elapsedMs: expect.any(Number), samples: expect.any(Number), baselineRequired: true, records: expect.any(Array) },
        initialPromptSubmission: { confirmed: true, operationId: expect.any(String) },
        promptConfirmation: { elapsedMs: expect.any(Number) },
        timing: { selectedStartReadinessMs: expect.any(Number), promptSubmissionAckMs: expect.any(Number), postAckConfirmationMs: expect.any(Number) }
      });
      assertLaunchPhaseTiming(details, wallElapsedMs, false);
      const promptRequests = state.socketProxy?.requests.slice(promptStart) ?? [];
      expect(promptRequests).toHaveLength(1);
      expect(resultObject(details.initialPromptSubmission).operationId).toBe(promptRequests[0]!.id);
      process.stderr.write(`INTEGRATION_LAUNCH_READINESS ${label} ${JSON.stringify(readinessDiagnostic(details))}\n`);
      process.stderr.write(`INTEGRATION_DELIVERY_CONFIRMED ${label}\n`);
      return { confirmed: true, details };
    } catch (error) {
      const failure = error as { code?: string; details?: Record<string, unknown> };
      if (failure.details === undefined) throw error;
      const attachment = resultObject(failure.details.attachment ?? {});
      if (typeof attachment.path === "string") state.attachmentPaths.push(attachment.path);
      const elapsedMs = performance.now() - startedAt;
      process.stderr.write(`INTEGRATION_DELIVERY_FAILED ${label} code=${String(failure.code)} causeCode=${String(failure.details.causeCode)} phase=${String(failure.details.phase)}\n`);
      await recordDeliveryFailureBeforeTeardown(label, { code: failure.code, details: failure.details }, elapsedMs);
      if (failure.code !== "LAUNCH_FAILED" || failure.details.causeCode !== "PROMPT_UNCONFIRMED") throw error;
      expect(failure.details).toMatchObject({
        phase: "prompt_verification",
        promptSubmitted: true,
        promptConsumption: "unconfirmed",
        readiness: { budgetBasis: "immediately_before_selected_agent_start", budgetMs: 120_000, elapsedMs: expect.any(Number), samples: expect.any(Number), baselineRequired: true, records: expect.any(Array) },
        initialPromptSubmission: { confirmed: true, operationId: expect.any(String), agentSession: { source: expect.any(String), agent: expect.any(String), kind: expect.any(String), value: expect.any(String) } },
        promptConfirmation: { timeoutMs: 5_000, pollIntervalMs: 100, elapsedMs: expect.any(Number) },
        timing: { selectedStartReadinessMs: expect.any(Number), promptSubmissionAckMs: expect.any(Number), postAckConfirmationMs: expect.any(Number) },
        created: expect.any(Object)
      });
      const promptRequests = state.socketProxy?.requests.slice(promptStart) ?? [];
      expect(promptRequests).toHaveLength(1);
      expect(resultObject(failure.details.initialPromptSubmission).operationId).toBe(promptRequests[0]!.id);
      assertLaunchPhaseTiming(failure.details, elapsedMs, resultObject(failure.details.promptConfirmation).reason === "timeout");
      await assertUnconfirmedRecovery(label, failure.details, promptCanary, promptStart, cliStart, toolCallStart);
      // The helper performed only read-only recovery diagnostics. Callers return
      // immediately, so no marker, wait, communication, retry, or cleanup follows.
      return { confirmed: false, details: failure.details };
    }
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

  const closeConfirmedFixturePane = async (label: string, details: Record<string, unknown>): Promise<void> => {
    const paneId = details.paneId;
    if (typeof paneId !== "string") throw new Error(`${label} omitted its pane ID before harness cleanup`);
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

  const waitForMarker = async (path: string, nonce: string, deadlineMs: number): Promise<boolean> => {
    const deadline = performance.now() + deadlineMs;
    while (performance.now() < deadline) {
      const content = await readFile(path, "utf8").catch(() => undefined);
      if (content?.includes(nonce)) return true;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  };

  beforeAll(async () => {
    expect(requestedSession).toBe(REQUIRED_SESSION);
    expect(process.env.HERDR_ENV).toBe("1");
    const currentIds = [process.env.HERDR_WORKSPACE_ID, process.env.HERDR_TAB_ID, process.env.HERDR_PANE_ID];
    expect(currentIds.every(Boolean)).toBe(true);
    state.cwd = await mkdtemp(`${tmpdir()}/herdr-tools-it-`);

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
              const agentName = state.captureAgyPrePromptFor;
              const listed = resultObject((await tool("herdr_jobs").execute("agy-pre-prompt-jobs", { operation: "list", kind: "supervisor" }, signal(), undefined, toolContext())).details);
              const summaries = Array.isArray(listed.jobs) ? listed.jobs.map((value) => resultObject(value)) : [];
              const summary = summaries.find((job) => Array.isArray(job.targets) && job.targets.length === 1 && job.targets[0] === agentName);
              if (!summary || typeof summary.jobId !== "string") throw new Error("AGY provisional supervisor job was not published before prompt socket submission");
              state.agyPrePromptJob = resultObject((await tool("herdr_jobs").execute("agy-pre-prompt-job", { operation: "get", jobId: summary.jobId }, signal(), undefined, toolContext())).details);
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
        if (args[0] === "agent" && args[1] === "start") {
          const promptFlag = args.indexOf("--append-system-prompt");
          if (promptFlag >= 0 && typeof args[promptFlag + 1] === "string") state.profilePromptContent = await readFile(args[promptFlag + 1]!, "utf8");
        }
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

    const saved = { env: process.env.HERDR_ENV, workspace: process.env.HERDR_WORKSPACE_ID, tab: process.env.HERDR_TAB_ID, pane: process.env.HERDR_PANE_ID, socket: process.env.HERDR_SOCKET_PATH };
    process.env.HERDR_ENV = "1";
    process.env.HERDR_WORKSPACE_ID = state.workspaceId;
    process.env.HERDR_TAB_ID = state.rootTabId;
    process.env.HERDR_PANE_ID = state.rootPaneId;
    // The supervision monitor reads this lazily on its first reservation, so the
    // disposable session's socket stays set for the life of the suite.
    process.env.HERDR_SOCKET_PATH = state.socketProxy!.path;
    try {
      extension(pi);
    } finally {
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

    const profiles = await tool("herdr_inspect").execute("profiles", { mode: "collection", collection: "profiles" }, signal(), undefined, toolContext());
    const profileItems = resultObject(profiles.details).items;
    expect(Array.isArray(profileItems) ? profileItems : []).toHaveLength(24);
    expect(profileItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "manager-pi", kind: "pi", model: "openai-codex/gpt-5.6-sol", thinking: "high", tools: expect.arrayContaining(["herdr_tab"]), skills: expect.arrayContaining([expect.stringContaining("herdr-profiles/role-plugins/manager/skills/manager"), expect.stringContaining("herdr-profiles/role-plugins/manager/skills/harness-flow")]) }),
      expect.objectContaining({ name: "manager-claude", kind: "claude", model: "fable", effort: "high", permissionMode: "default", fallbackProfiles: ["manager-pi"] }),
      expect.objectContaining({ name: "promoter-pi", kind: "pi", model: "openai-codex/gpt-5.6-luna", thinking: "max", fallbackProfiles: [] }),
      expect.objectContaining({ name: "scout-agy", kind: "agy", model: "gemini-3.8-flash-low", mode: "plan", dangerouslySkipPermissions: true, addDirs: [], fallbackProfiles: ["scout-claude"] }),
      expect.objectContaining({ name: "worker-agy", kind: "agy", model: "gemini-3.8-flash-high", mode: "accept-edits", dangerouslySkipPermissions: true, addDirs: [], fallbackProfiles: ["worker-claude"] }),
      expect.objectContaining({ name: "researcher-agy", kind: "agy", model: "gemini-3.8-flash-low", mode: "plan", dangerouslySkipPermissions: true, addDirs: [], fallbackProfiles: ["researcher-claude"] }),
      expect.objectContaining({ name: "worker-devin", kind: "devin", model: "swe-2-max", permissionMode: "dangerous", fallbackProfiles: ["worker-pi"] }),
      expect.objectContaining({ name: "reviewer-devin", kind: "devin", model: "swe-2-max", permissionMode: "dangerous", fallbackProfiles: ["reviewer-pi"] })
    ]));
    const manager = await tool("herdr_inspect").execute("manager", { mode: "profile", profile: "manager-pi" }, signal(), undefined, toolContext());
    expect(resultObject(manager.details).profile).toMatchObject({ name: "manager-pi", kind: "pi", model: "openai-codex/gpt-5.6-sol", thinking: "high", tools: ["read", "grep", "find", "ls", "edit", "write", "ask_user_question", "mcp", "executor_execute", "executor_skills", "executor_resume", "herdr_inspect", "herdr_launch", "herdr_communicate", "herdr_wait", "herdr_jobs", "herdr_pane", "herdr_tab", "change_reasoning", "exec_command", "write_stdin", "apply_patch", "exec", "wait", "notebook", "view_image", "new_context", "get_context_remaining", "history", "notes"], extensions: [], skills: expect.arrayContaining([expect.stringContaining("herdr-profiles/role-plugins/manager/skills/manager"), expect.stringContaining("herdr-profiles/role-plugins/manager/skills/harness-flow"), expect.stringContaining("herdr-profiles/profile-plugins/executor/skills/executor")]), fallbackProfiles: ["manager-devin"] });
    const managerClaude = await tool("herdr_inspect").execute("manager-claude", { mode: "profile", profile: "manager-claude" }, signal(), undefined, toolContext());
    expect(resultObject(managerClaude.details).profile).toMatchObject({ name: "manager-claude", kind: "claude", model: "fable", effort: "high", permissionMode: "default", allowedTools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "AskUserQuestion", "Skill", "ToolSearch", "Edit", "Write", "mcp__plugin_herdr-tools_herdr", "mcp__plugin_herdr-executor_executor"], disallowedTools: ["Task"], pluginDirs: [expect.stringContaining("herdr-profiles/profile-plugins/manager"), expect.stringContaining("herdr-profiles/profile-plugins/executor")] });
    const workerAgy = await tool("herdr_inspect").execute("worker-agy", { mode: "profile", profile: "worker-agy" }, signal(), undefined, toolContext());
    expect(resultObject(workerAgy.details).profile).toMatchObject({ name: "worker-agy", kind: "agy", model: "gemini-3.8-flash-high", mode: "accept-edits", dangerouslySkipPermissions: true, fallbackProfiles: ["worker-claude"], reachableNames: ["worker-agy", "worker-claude"] });
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

  it.runIf(agyEnabled)("qualifies one AGY assignment from provisional publication through exact attachment readback", async () => {
    const agentName = `integration-agy-${process.pid}`;
    const nonce = `agy-attachment-${randomUUID()}`;
    const promptStart = state.socketProxy?.requests.length ?? 0;
    const cliStart = state.cliCalls.length;
    state.captureAgyPrePromptFor = agentName;
    const startedAt = performance.now();
    let details: Record<string, unknown>;
    try {
      const launched = await tool("herdr_launch").execute("agy-qualification", {
        name: agentName,
        profile: "researcher-agy",
        placement: { mode: "new_tab", tabLabel: "agy-qualification" },
        assignmentDelivery: "attachment",
        assignment: {
          objective: `Read this assignment attachment through the granted directory. Respond with only this exact token: ${nonce}`,
          scope: "Read the attachment only. Change nothing.",
          verification: "The reply is exactly the token and nothing else."
        }
      }, signal(), undefined, toolContext());
      details = resultObject(launched.details);
    } catch (error) {
      const failure = error as { details?: Record<string, unknown> };
      const failureDetails = resultObject(failure.details);
      const attachment = resultObject(failureDetails.attachment ?? {});
      if (typeof attachment.path === "string") state.attachmentPaths.push(attachment.path);
      const paneId = typeof failureDetails.paneId === "string" ? failureDetails.paneId : undefined;
      const supervisorJobId = typeof failureDetails.supervisorJobId === "string" ? failureDetails.supervisorJobId : undefined;
      if (failureDetails.promptSubmitted === true && paneId && supervisorJobId) {
        expect(state.socketProxy?.requests.slice(promptStart)).toHaveLength(1);
        const failureCalls = state.cliCalls.slice(cliStart);
        expect(failureCalls.filter((args) => args[0] === "agent" && args[1] === "start")).toHaveLength(1);
        expect(failureCalls.filter((args) => ( ["pane", "tab", "workspace"].includes(args[0] ?? "") && ["close", "delete", "kill"].includes(args[1] ?? "")) || (args[0] === "agent" && ["close", "kill", "stop"].includes(args[1] ?? "")))).toEqual([]);
        expect(failureDetails).toMatchObject({ recipientRegistered: false, attempts: [{ profile: "researcher-agy", outcome: "selected" }] });
        const retained = resultObject((await tool("herdr_jobs").execute("agy-retained-provisional", { operation: "get", jobId: supervisorJobId }, signal(), undefined, toolContext())).details);
        expect(retained).toMatchObject({
          operation_phase: "running",
          request: { targetIds: [] },
          supervision: { state: "provisional", provisional: { paneId, agentKind: "agy", profileName: "researcher-agy" } }
        });
        expect(retained).not.toHaveProperty("supervision_result");
        state.unconfirmedRecoveries.push({ paneId, supervisorJobId });
        process.stderr.write(`INTEGRATION_AGY_UNCERTAIN_RETAINED ${JSON.stringify({ paneId, supervisorJobId, details: failureDetails })}\n`);
        await recordDeliveryFailureBeforeTeardown("agy-qualification", { details: failureDetails }, performance.now() - startedAt);
      }
      throw error;
    } finally {
      state.captureAgyPrePromptFor = undefined;
    }

    const paneId = String(details.paneId);
    const attachment = resultObject(details.attachment);
    const attachmentPath = String(attachment.path);
    state.attachmentPaths.push(attachmentPath);
    const promptCalls = state.socketProxy?.requests.slice(promptStart) ?? [];
    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0]).toMatchObject({ method: "agent.prompt", target: paneId });
    expect(promptCalls[0]!.text).toContain("[HERDR AGENT MESSAGE v1]");
    expect(promptCalls[0]!.text).toContain("authority: agent; not user/owner");
    expect(promptCalls[0]!.text).toContain("delivery: attachment");
    expect(promptCalls[0]!.text).toContain(`attachment-path: ${attachmentPath}`);
    expect(promptCalls[0]!.text).not.toContain(nonce);

    const startCalls = state.cliCalls.slice(cliStart).filter((args) => args[0] === "agent" && args[1] === "start");
    const grantedDirectory = dirname(dirname(attachmentPath));
    expect(startCalls).toEqual([[
      "agent", "start", agentName, "--kind", "agy", "--pane", paneId, "--timeout", "120000", "--",
      "--model", "gemini-3.8-flash-low", "--mode", "plan", "--dangerously-skip-permissions", "--add-dir", grantedDirectory,
      "--prompt-interactive", "Initialize this interactive session and reply with exactly AGY_READY."
    ]]);
    expect(state.agyPrePromptAgent).toMatchObject({ agent: "agy", interactive_ready: true });
    expect(state.agyPrePromptRecipientFailureCode).toBe("ATTACHMENT_TARGET_UNVERIFIED");
    const provisionalJob = resultObject(state.agyPrePromptJob);
    expect(provisionalJob).toMatchObject({
      operation_phase: "running",
      request: { targetIds: [], child: { agentName, agentKind: "agy", profileName: "researcher-agy" } },
      supervision: { state: "provisional", provisional: { agentName, agentKind: "agy", paneId, profileName: "researcher-agy", baseline: { state: "idle", stateChangeSeq: expect.any(Number), revision: expect.any(Number) } } }
    });
    expect(provisionalJob).not.toHaveProperty("supervision_result");
    expect(details).toMatchObject({
      operation: "launch",
      outcome: "launched",
      kind: "agy",
      paneId,
      promptSubmitted: true,
      promptConsumption: "confirmed",
      assignmentState: "confirmed",
      recipientRegistered: true,
      initialPromptDelivery: "attachment",
      initialPromptSubmission: { confirmed: true, operationId: promptCalls[0]!.id, paneId, agentName, agentKind: "agy", agentSession: { source: expect.any(String), agent: "agy", kind: expect.any(String), value: expect.any(String) } },
      initialPromptObservation: { stateChangeSeq: expect.any(Number), revision: expect.any(Number), consumption: "confirmed" },
      supervision: { jobId: expect.any(String), state: "active", child: { agentName, agentKind: "agy", paneId, profileName: "researcher-agy" } },
      profile: { name: "researcher-agy", requested: "researcher-agy", selected: "researcher-agy", runtime: { kind: "agy", model: "gemini-3.8-flash-low", mode: "plan", dangerouslySkipPermissions: true }, permissions: { sessionPersistence: true, addDirs: [] }, attempts: [{ profile: "researcher-agy", outcome: "selected" }], fallbackProfiles: ["researcher-claude"], reachableNames: ["researcher-agy", "researcher-claude", "researcher-devin", "researcher-pi"] }
    });
    const baseline = resultObject(resultObject(provisionalJob.supervision).provisional).baseline as Record<string, unknown>;
    const observation = resultObject(details.initialPromptObservation);
    expect(Number(observation.stateChangeSeq)).toBeGreaterThan(Number(baseline.stateChangeSeq));
    expect(Number(observation.revision)).toBeGreaterThanOrEqual(Number(baseline.revision));
    const supervisorJobId = String(resultObject(details.supervision).jobId);
    const strengthened = resultObject((await tool("herdr_jobs").execute("agy-strengthened", { operation: "get", jobId: supervisorJobId }, signal(), undefined, toolContext())).details);
    expect(strengthened).toMatchObject({ operation_phase: "running", request: { targetIds: [paneId], child: { agentName, agentKind: "agy", profileName: "researcher-agy" } }, supervision: { state: "active", child: { agentName, agentKind: "agy", paneId, profileName: "researcher-agy" } } });
    expect(resultObject(strengthened.supervision)).not.toHaveProperty("provisional");
    const wait = await tool("herdr_wait").execute("agy-attachment-readback", { targets: [paneId], match: "any", condition: { kind: "output", match: { kind: "literal", value: nonce } }, timeoutMs: ACCEPTANCE_DEADLINE_MS, label: "AGY attachment nonce readback" }, signal(), undefined, toolContext());
    const waitJobId = String(resultObject(wait.details).jobId);
    const settled = await waitForCondition(async () => resultObject((await tool("herdr_jobs").execute("agy-readback-job", { operation: "get", jobId: waitJobId }, signal(), undefined, toolContext())).details), (job) => job?.operation_phase === "settled", ACCEPTANCE_DEADLINE_MS, 500);
    expect(settled).toMatchObject({ operation_phase: "settled", wait_result: "condition_met", result: { matched: true } });
    expect(await readFile(attachmentPath, "utf8")).toContain(nonce);
    expect(dirname(dirname(attachmentPath))).toBe(grantedDirectory);
    await closeConfirmedFixturePane("agy-qualification", details);
    const proofPath = process.env.HERDR_TOOLS_AGY_INTEGRATION_PROOF;
    if (!proofPath) throw new Error("AGY integration proof path was not supplied by the integration runner");
    await writeFile(proofPath, "qualified");
  }, 360_000);

  it.runIf(agyEnabled)("falls back from AGY only after an exact pre-interactive zero-effect failure", async () => {
    const agentName = `integration-agy-fallback-${process.pid}`;
    const cliStart = state.cliCalls.length;
    const promptStart = state.socketProxy?.requests.length ?? 0;
    state.forceNextAgyStartFailure = true;
    const launched = await tool("herdr_launch").execute("agy-zero-effect-fallback", {
      name: agentName,
      profile: "researcher-agy",
      placement: { mode: "new_tab", tabLabel: "agy-zero-effect-fallback" },
      assignment: { objective: "Reply with the single word ready.", scope: "Change nothing.", verification: "The reply is the single word ready." }
    }, signal(), undefined, toolContext());
    const details = resultObject(launched.details);
    const paneId = String(details.paneId);
    const calls = state.cliCalls.slice(cliStart);
    const starts = calls.filter((args) => args[0] === "agent" && args[1] === "start");
    // The forced AGY failure fires on the first AGY start call; a fresh pane's
    // shell may still be registering, so Claude retries agent_pane_busy until
    // the settle window passes -- per-kind counts absorb the retries.
    const agyStarts = starts.filter((args) => args[args.indexOf("--kind") + 1] === "agy");
    const claudeStarts = starts.filter((args) => args[args.indexOf("--kind") + 1] === "claude");
    expect(agyStarts).toHaveLength(1);
    expect(claudeStarts.length).toBeGreaterThanOrEqual(1);
    expect(state.forceNextAgyStartFailure).toBe(false);
    expect(agyStarts[0]).toEqual(expect.arrayContaining(["--kind", "agy", "--model", "gemini-3.8-flash-low", "--mode", "plan", "--dangerously-skip-permissions"]));
    expect(agyStarts[0]!.slice(-2)).toEqual(["--prompt-interactive", "Initialize this interactive session and reply with exactly AGY_READY."]);
    expect(claudeStarts.at(-1)).toEqual(expect.arrayContaining(["--kind", "claude", "--model", "claude-sonnet-5"]));
    const promptCalls = state.socketProxy?.requests.slice(promptStart) ?? [];
    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0]).toMatchObject({ method: "agent.prompt", target: paneId });
    const lastAgyStartIndex = calls.lastIndexOf(agyStarts[0]!);
    const firstClaudeStartIndex = calls.indexOf(claudeStarts[0]!);
    expect(lastAgyStartIndex).toBeLessThan(firstClaudeStartIndex);
    expect(calls.filter((args) => (["pane", "tab", "workspace"].includes(args[0] ?? "") && ["close", "delete", "kill"].includes(args[1] ?? "")) || (args[0] === "agent" && ["close", "kill", "stop"].includes(args[1] ?? "")))).toEqual([]);
    expect(details).toMatchObject({ kind: "claude", promptSubmitted: true, promptConsumption: "confirmed", recipientRegistered: true, supervision: { state: "active", child: { paneId, agentKind: "claude", profileName: "researcher-claude" } }, profile: { requested: "researcher-agy", selected: "researcher-claude", runtime: { kind: "claude", model: "claude-sonnet-5" }, attempts: [{ profile: "researcher-agy", outcome: "agent_start_failed", errorCode: "agent_start_failed", message: "agent process exited before becoming interactive", postState: { pane_id: paneId, agent_status: "unknown" } }, { profile: "researcher-claude", outcome: "selected" }] } });
    const failedPostState = resultObject((resultObject(details.profile).attempts as Array<Record<string, unknown>>)[0]!.postState);
    for (const field of ["agent", "agent_name", "agent_id", "agent_session", "agent_kind", "kind"]) expect(failedPostState).not.toHaveProperty(field);
    expect(calls.slice(lastAgyStartIndex + 1, firstClaudeStartIndex)).toContainEqual(["pane", "get", paneId]);
    await closeConfirmedFixturePane("agy-zero-effect-fallback", details);
  }, 300_000);

  it("retains exact supervision after deterministic assignment-confirmation uncertainty", async () => {
    const canary = `unconfirmed-assignment-${randomUUID()}`;
    state.forceNextPromptConfirmationFailure = true;
    const launched = await deliverLaunch("unconfirmed-recovery-launch", canary, () => tool("herdr_launch").execute("unconfirmed-recovery-launch", {
      name: `integration-unconfirmed-${process.pid}`,
      profile: "worker-pi",
      overrides: piLaunchOverrides,
      placement: { mode: "new_tab", tabLabel: "unconfirmed-recovery" },
      assignment: { objective: `Recovery integration canary: ${canary}. Do not close or move this pane.`, scope: "Change nothing in the repository.", verification: "The pane stays open at the same identity." }
    }, signal(), undefined, toolContext()));
    expect(launched.confirmed).toBe(false);
    if (launched.confirmed) throw new Error("forced confirmation uncertainty unexpectedly returned launch success");
    expect(state.promptConfirmationFailurePaneId).toBeUndefined();
    expect(state.unconfirmedRecoveries).toEqual(expect.arrayContaining([
      { paneId: launched.details.paneId, supervisorJobId: launched.details.supervisorJobId }
    ]));
  }, 120_000);

  it("fails closed for a deterministic Bash-tool interrupt in the disposable session", async () => {
    const turnMarker = `turn-control-${randomUUID()}`;
    const turnMarkerPath = join(state.cwd, "turn-control-started.txt");
    const turnScriptPath = join(state.cwd, "turn-control.sh");
    await writeFile(turnScriptPath, `printf '%s' '${turnMarker}' > '${turnMarkerPath}'\nsleep 120\n`, { mode: 0o700 });
    const launched = await deliverLaunch("turn-control-launch", turnMarker, () => tool("herdr_launch").execute("turn-control-launch", {
      name: `integration-turn-control-${process.pid}`,
      profile: "worker-pi",
      overrides: piLaunchOverrides,
      placement: { mode: "new_tab", tabLabel: "turn-control" },
      assignment: {
        objective: `Use Bash to execute exactly ${turnScriptPath} now. Do not use any other tool. Remain in this turn until the script exits; do not finish the task or send a final response.`,
        scope: `Run only ${turnScriptPath}. Use no other tool and change nothing else.`,
        verification: "The turn stays open until the script exits."
      }
    }, signal(), undefined, toolContext()));
    if (!launched.confirmed) return;
    expect(await waitForMarker(turnMarkerPath, turnMarker, 60_000), "turn-control fixture did not reach its deterministic sleep command").toBe(true);
    const details = launched.details;
    const paneId = details.paneId;
    if (typeof paneId !== "string") throw new Error("turn-control fixture launch did not return an authoritative pane ID");

    const fixtureSnapshot = resultObject(resultObject(resultObject(await runNamed(["api", "snapshot"])).result).snapshot);
    const fixturePanes = Array.isArray(fixtureSnapshot.panes) ? fixtureSnapshot.panes.map(resultObject) : [];
    const fixtureAgents = Array.isArray(fixtureSnapshot.agents) ? fixtureSnapshot.agents.map(resultObject) : [];
    expect(fixturePanes).toEqual(expect.arrayContaining([expect.objectContaining({ pane_id: paneId, agent_status: "working" })]));
    expect(fixtureAgents).toEqual(expect.arrayContaining([expect.objectContaining({ pane_id: paneId, agent_status: "working" })]));

    let failure: { code?: unknown; details?: Record<string, unknown> } | undefined;
    try {
      await tool("herdr_communicate").execute("turn-control", { target: paneId, operation: "interrupt" }, signal(), undefined, toolContext());
    } catch (error) {
      failure = error as { code?: unknown; details?: Record<string, unknown> };
    }
    expect(failure?.code).toBe("INTERRUPT_UNCONFIRMED");
    const failureDetails = resultObject(failure?.details);
    expect(failureDetails).toMatchObject({
      dispatchAttempted: true,
      dispatchAcknowledged: true,
      confirmation: { kind: "unconfirmed" }
    });
    const preEvidence = resultObject(failureDetails.preEvidence);
    const finalEvidence = resultObject(failureDetails.finalEvidence);
    expect(finalEvidence).toMatchObject({
      pane_id: paneId,
      terminal_id: preEvidence.terminal_id,
      agent_session: preEvidence.agent_session,
      agent_status: "working"
    });
    const controls = state.cliCalls.filter((args) => args[0] === "agent" && args[1] === "send-keys" && args[2] === paneId);
    expect(controls).toEqual([["agent", "send-keys", paneId, "ctrl+c"]]);
    await closeConfirmedFixturePane("turn-control-launch", details);
  }, 180_000);

  // The unprofiled-launch refusal this suite used to cover has no reachable path left:
  // launch is profile-only, so an unregistered recipient can no longer be created here.
  // The `ATTACHMENT_TARGET_UNVERIFIED` contract is covered by the unit suites instead.

  /**
   * Transport smoke: non-gating evidence about the route, the transport, and the published
   * artifact. It deliberately makes no claim about what a recipient agent read; the
   * acceptance tests below own that claim.
   */
  it("routes wrapped text over the session-bound prompt socket transport and publishes exact artifacts", async () => {
    if (state.unconfirmedRecoveries.length >= 2) return;
    const inlineBody = ["integration assignment", ...Array.from({ length: 320 }, (_value, index) => `long assignment line ${index}`)].join("\n");
    const inlineAssignment = { objective: inlineBody, scope: "Change nothing.", verification: "No verification is required for this transport smoke." };
    const inline = await deliverLaunch("pi-inline-launch", "integration assignment", () => tool("herdr_launch").execute("launch-profile", { name: "integration-profile-worker", profile: "worker-pi", overrides: piLaunchOverrides, placement: { mode: "new_tab", tabLabel: "profile-launch" }, assignment: inlineAssignment }, signal(), undefined, toolContext()));
    if (!inline.confirmed) return;
    expect(inline.details).toMatchObject({ initialPromptDelivery: "inline", initialPromptSubmission: { confirmed: true } });
    const startArgs = state.cliCalls.find((args) => args[0] === "agent" && args[1] === "start" && args.includes("integration-profile-worker"));
    expect(startArgs).toEqual(expect.arrayContaining(["--kind", "pi", "--model", piEffectiveModel, "--thinking", "max", "--tools", "read,bash,grep,find,ls,ffgrep,fffind,ctx_execute,ctx_execute_file,ctx_search,web_search,source_check,fetch_content,get_search_content,edit,write,bash_bg,jobs,job_decide,monitor,herdr_communicate,herdr_inspect,change_reasoning,exec_command,write_stdin,apply_patch,exec,wait,notebook,view_image,new_context,get_context_remaining,history,notes", "--skill", expect.stringContaining("herdr-profiles/role-plugins/worker/skills/worker"), "--append-system-prompt"]));
    // Pi exact isolation is positional, so `arrayContaining` cannot assert it:
    // exactly one `--no-skills` must precede every `--skill`, otherwise Pi
    // discovers the ambient project/user catalog first and silently skips a
    // selected generated copy whose skill name collides with an ambient one.
    const skillIndexes = startArgs!.flatMap((arg, index) => (arg === "--skill" ? [index] : []));
    expect(startArgs!.filter((arg) => arg === "--no-skills")).toEqual(["--no-skills"]);
    expect(skillIndexes.length).toBeGreaterThan(0);
    expect(Math.min(...skillIndexes)).toBeGreaterThan(startArgs!.indexOf("--no-skills"));
    expect(state.profilePromptContent).toContain("Use the worker role skill");

    const inlinePaneId = String(inline.details.paneId ?? resultObject(inline.details.created).paneId);
    const inlineDelivery = state.socketProxy?.requests.find((request) => request.text?.includes("integration assignment"));
    expect(inlineDelivery, `pi-inline-launch did not record its prompt-socket submission (phase=${String(inline.details.phase)})`).toBeDefined();
    expect(inlineDelivery!.method).toBe("agent.prompt");
    expect(inlineDelivery!.target).toBe(inlinePaneId);
    expect(inlineDelivery!.text).toContain("[HERDR AGENT MESSAGE v1]");
    expect(inlineDelivery!.text).toContain("authority: agent; not user/owner");
    expect(inlineDelivery!.text).toContain("delivery: inline");
    expect(state.cliCalls.some((args) => args.some((arg) => arg.includes("integration assignment")))).toBe(false);
    await closeConfirmedFixturePane("pi-inline-launch", inline.details);

    const body = `Transport smoke body.\n${"detail line\n".repeat(200)}`;
    const bodyAssignment = { objective: body, scope: "Change nothing.", verification: "No verification is required for this transport smoke." };
    const attachmentLaunch = await deliverLaunch("pi-attachment-launch", "detail line", () => tool("herdr_launch").execute("launch-pi-attachment", { name: "integration-pi-attach", profile: "worker-pi", overrides: piLaunchOverrides, placement: { mode: "new_tab", tabLabel: "pi-attachment" }, assignment: bodyAssignment, assignmentDelivery: "attachment" }, signal(), undefined, toolContext()));
    if (!attachmentLaunch.confirmed) return;
    const attachment = resultObject(attachmentLaunch.details.attachment);
    state.attachmentPaths.push(String(attachment.path));
    expect(attachmentLaunch.details).toMatchObject({ initialPromptDelivery: "attachment" });
    const handoff = resultObject(attachmentLaunch.details.handoff);
    const contract = renderHandoffContract({ artifactPath: String(handoff.path), marker: `herdr-run:${String(handoff.runId)}` } as HandoffAllocation);
    const renderedBody = renderAssignment(bodyAssignment) + contract;
    expect(await readFile(String(attachment.path), "utf8")).toBe(renderedBody);
    expect(createHash("sha256").update(renderedBody, "utf8").digest("hex")).toBe(attachment.sha256);
    expect(attachment.bytes).toBe(Buffer.byteLength(renderedBody, "utf8"));
    expect((await stat(String(attachment.path))).mode & 0o777).toBe(0o600);
    const envelope = state.socketProxy?.requests.find((request) => request.text?.includes(String(attachment.path)));
    expect(envelope, `pi-attachment-launch did not record its prompt-socket submission (phase=${String(attachmentLaunch.details.phase)})`).toBeDefined();
    expect(envelope!.method).toBe("agent.prompt");
    expect(envelope!.text).toContain("delivery: attachment");
    expect(envelope!.text).toContain(`attachment-sha256: ${String(attachment.sha256)}`);
    expect(envelope!.text).not.toContain("detail line");
    expect(state.cliCalls.some((args) => args.some((arg) => arg.includes("detail line")))).toBe(false);
    await closeConfirmedFixturePane("pi-attachment-launch", attachmentLaunch.details);
  }, 240_000);

  /**
   * Acceptance: a semantically confirmed recipient must produce evidence obtainable
   * only from the attachment. Exact fail-closed launch uncertainty is accepted but
   * returns before marker assertions because the prompt was possibly consumed.
   */
  it("accepts Pi recipient readback only with agent-produced evidence", async () => {
    if (state.unconfirmedRecoveries.length >= 2) return;
    const nonce = randomUUID();
    const markerPath = join(state.cwd, "readback-pi.txt");
    const body = [
      "Herdr integration acceptance check.",
      `Write the file ${markerPath} whose only content is this exact token:`,
      nonce,
      "Then stop. Do not change anything else and do not reply."
    ].join("\n");

    const launched = await deliverLaunch("pi-acceptance-launch", nonce, () => tool("herdr_launch").execute("accept-pi", { name: "integration-accept-pi", profile: "worker-pi", overrides: piLaunchOverrides, placement: { mode: "new_tab", tabLabel: "accept-pi" }, assignment: { objective: body, scope: `Write only ${markerPath}. Change nothing else.`, verification: `${markerPath} contains exactly the token.` }, assignmentDelivery: "attachment" }, signal(), undefined, toolContext()));
    if (!launched.confirmed) return;
    const attachment = resultObject(launched.details.attachment);
    state.attachmentPaths.push(String(attachment.path));
    expect(await readFile(String(attachment.path), "utf8")).toContain(nonce);
    const produced = await waitForMarker(markerPath, nonce, ACCEPTANCE_DEADLINE_MS);
    expect(produced, `Pi recipient did not produce ${markerPath} containing the attachment token`).toBe(true);
    await closeConfirmedFixturePane("pi-acceptance-launch", launched.details);
  }, 300_000);

  it("accepts Claude recipient readback only with agent-produced evidence", async () => {
    if (state.unconfirmedRecoveries.length >= 2) return;
    const nonce = randomUUID();
    const markerPath = join(state.cwd, "readback-claude.txt");
    const body = [
      "Herdr integration acceptance check.",
      `Write the file ${markerPath} whose only content is this exact token:`,
      nonce,
      "Then stop. Do not change anything else and do not reply."
    ].join("\n");

    const launched = await tool("herdr_launch").execute("accept-claude", {
      name: "integration-accept-claude",
      profile: "worker-claude",
      overrides: { permissionMode: "bypassPermissions" },
      placement: { mode: "new_tab", tabLabel: "accept-claude" },
      assignment: {
        objective: "Stand by in this pane for one follow-up assignment attachment, then carry it out exactly as written.",
        scope: "Change nothing until that follow-up arrives, and then change only what it names.",
        verification: "The follow-up assignment's own verification is the only check for this launch."
      }
    }, signal(), undefined, toolContext());
    const details = resultObject(launched.details);
    expect(details).toMatchObject({ recipient: { capable: true, kind: "claude", profileName: "worker-claude" } });
    const startArgs = state.cliCalls.find((args) => args[0] === "agent" && args[1] === "start" && args.includes("integration-accept-claude"));
    const grantIndex = startArgs!.indexOf("--add-dir");
    expect(grantIndex).toBeGreaterThan(0);
    const grantedDirectory = startArgs![grantIndex + 1]!;

    const sent = await deliver("claude-acceptance-send", tool("herdr_communicate").execute("accept-claude-send", { target: String(details.paneId), operation: "prompt", text: body, delivery: "attachment" }, signal(), undefined, toolContext()));
    const attachment = resultObject(sent.details.attachment);
    state.attachmentPaths.push(String(attachment.path));
    expect(dirname(dirname(String(attachment.path)))).toBe(grantedDirectory);
    expect(await readFile(String(attachment.path), "utf8")).toContain(nonce);
    const produced = await waitForMarker(markerPath, nonce, ACCEPTANCE_DEADLINE_MS);
    expect(produced, `Claude recipient did not produce ${markerPath} containing the attachment token`).toBe(true);
    await closeConfirmedFixturePane("claude-acceptance-launch", details);
  }, 300_000);
});
