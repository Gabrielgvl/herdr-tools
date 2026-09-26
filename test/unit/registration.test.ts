import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type * as SupervisionRegistryModule from "../../src/supervision/registry.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", () => ({ readFile: readFileMock }));

/** Capture the options the runtime composes its supervision registry from. */
const registryOptions = vi.hoisted(() => ({ last: undefined as Record<string, unknown> | undefined }));
vi.mock("../../src/supervision/registry.js", async (importOriginal) => {
  const real = await importOriginal<typeof SupervisionRegistryModule>();
  return {
    ...real,
    SupervisionRegistry: class extends real.SupervisionRegistry {
      constructor(options: ConstructorParameters<typeof real.SupervisionRegistry>[0]) {
        super(options);
        registryOptions.last = options as unknown as Record<string, unknown>;
      }
    },
  };
});

import extension, { CORE_TOOL_NAMES, createPreflight, createRuntime, notificationForJob, readInjectedContext } from "../../index.js";
import { HerdrCli, type PiExec } from "../../src/cli.js";
import { RuntimeOwnership } from "../../src/ownership.js";

const original = {
  env: process.env.HERDR_ENV,
  workspace: process.env.HERDR_WORKSPACE_ID,
  tab: process.env.HERDR_TAB_ID,
  pane: process.env.HERDR_PANE_ID,
};

beforeEach(() => readFileMock.mockReset());

afterEach(() => {
  for (const [key, value] of Object.entries({ HERDR_ENV: original.env, HERDR_WORKSPACE_ID: original.workspace, HERDR_TAB_ID: original.tab, HERDR_PANE_ID: original.pane })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});

function fakePi() {
  const tools: unknown[] = [];
  const commands: Array<{ name: string; definition: { handler: (...args: never[]) => unknown } }> = [];
  const handlers: Array<{ event: string; handler: (...args: never[]) => unknown }> = [];
  const pi = {
    exec: vi.fn(),
    sendMessage: vi.fn(),
    registerTool: vi.fn((tool: unknown) => tools.push(tool)),
    registerCommand: vi.fn((name: string, definition: { handler: (...args: never[]) => unknown }) => commands.push({ name, definition })),
    on: vi.fn((event: string, handler: (...args: never[]) => unknown) => handlers.push({ event, handler })),
  } as unknown as ExtensionAPI;
  return { pi, tools, commands, handlers };
}

function enable(ids = true): void {
  process.env.HERDR_ENV = "1";
  if (ids) {
    process.env.HERDR_WORKSPACE_ID = "w-current";
    process.env.HERDR_TAB_ID = "w-current:t-current";
    process.env.HERDR_PANE_ID = "w-current:p-current";
  } else {
    delete process.env.HERDR_WORKSPACE_ID;
    delete process.env.HERDR_TAB_ID;
    delete process.env.HERDR_PANE_ID;
  }
}

describe("global extension registration", () => {
  it("is completely inert when HERDR_ENV is not 1", () => {
    delete process.env.HERDR_ENV;
    const { pi, tools, commands, handlers } = fakePi();
    extension();
    expect(tools).toEqual([]);
    expect(commands).toEqual([]);
    expect(handlers).toEqual([]);
    expect((pi.exec as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("registers nothing even when enabled — Pi reaches the three daemon tools through the executor MCP gateway (C7)", () => {
    enable();
    const { pi, tools, commands, handlers } = fakePi();
    extension();
    // The universal surface is exactly the three daemon proxies; the Pi
    // extension itself is a no-op — no tools, commands, or session handlers.
    expect([...CORE_TOOL_NAMES]).toEqual(["herdr_launch", "herdr_run", "herdr_status"]);
    expect(tools).toEqual([]);
    expect(commands).toEqual([]);
    expect(handlers).toEqual([]);
    expect((pi.exec as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("keeps enabled registration fail-closed when injected IDs are absent or malformed", () => {
    enable(false);
    const missing = readInjectedContext();
    expect(missing).toEqual({ context: {}, idsPresent: false, idsValid: true });
    process.env.HERDR_PANE_ID = "bad\nvalue";
    expect(readInjectedContext()).toMatchObject({ idsPresent: false, idsValid: false, context: {} });
    const { tools } = fakePi();
    extension();
    expect(tools).toEqual([]);
  });

  it("constructs production runtime dependencies without reading settings or calling Herdr", async () => {
    enable();
    const { pi } = fakePi();
    const runtime = createRuntime(pi, process.env);
    expect(runtime.cli).toBeDefined();
    expect(runtime.context).toEqual({ workspaceId: "w-current", tabId: "w-current:t-current", paneId: "w-current:p-current" });
    expect(runtime.ownership).toBeInstanceOf(RuntimeOwnership);
    expect(runtime.idsPresent).toBe(true);
    expect(runtime.idsValid).toBe(true);
    expect((pi.exec as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    expect(runtime.settings.load).toBeTypeOf("function");
    readFileMock.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));
    await expect(runtime.settings.load()).resolves.toMatchObject({ reviewCadenceMinutes: 5, reviewerModel: "openai-codex/gpt-6-sol", reviewerThinking: "low" });
  });

  it("creates a compatibility preflight for the registered CLI", async () => {
    const exec = vi.fn<PiExec>().mockResolvedValue({ stdout: JSON.stringify({ client: { version: "0.8.0", protocol: 22 }, server: { status: "running", version: "0.8.0", protocol: 22, compatible: true } }), stderr: "", code: 0, killed: false });
    await expect(createPreflight(new HerdrCli(exec))(new AbortController().signal)).resolves.toBeUndefined();
    expect(exec).toHaveBeenCalledWith("herdr", ["status", "--json"], expect.anything());
  });

  it("pushes bounded terminal notifications with queue and priority semantics", async () => {
    const detail = {
      jobId: "job_notify",
      kind: "wait" as const,
      operation_phase: "settled" as const,
      wait_result: "manager_judgment_required" as const,
      sequence: 1,
      createdAtMs: 0,
      finishedAtMs: 1,
      request: { kind: "wait" as const, label: "wait for worker", targets: ["worker\\n<untrusted>"], targetIds: ["p1"], match: "any" as const, condition: { kind: "state", state: "done" }, timeoutMs: 1, settings: { reviewCadenceMinutes: 1, reviewerModel: "testmodel", reviewerThinking: "low" as const } },
      result: { wait_result: "manager_judgment_required" as const, matched: false, reason: "manager_judgment_required", reviewerSummaries: [{ target: "worker", targetId: "p1", classification: "blocked", summary: "review\nsummary" }] }
    };
    const notification = notificationForJob(detail);
    expect(notification.content).toContain("HIGH PRIORITY: MANAGER JUDGMENT REQUIRED");
    expect(notification.content).not.toContain("review\nsummary");
    expect(notification.details).toMatchObject({ action: "wait", priority: "high", jobId: "job_notify", label: "wait for worker", matchedTargets: [] });
    expect(notification.content).toContain("job_notify (wait for worker)");
    expect(notification.content).toContain("target lifecycle unchanged");
    const unicodeLabel = "😀".repeat(120);
    const unicodeNotification = notificationForJob({ ...detail, request: { ...detail.request, label: unicodeLabel } });
    expect(unicodeNotification.details.label).toBe(unicodeLabel);
    expect(unicodeNotification.content).toContain(unicodeLabel);
    const controlNotification = notificationForJob({ ...detail, request: { ...detail.request, targetIds: [`p1${String.fromCharCode(127)}`] } });
    expect(controlNotification.content).toContain("p1 ");
    const successAny = notificationForJob({
      ...detail,
      wait_result: "condition_met",
      result: {
        wait_result: "condition_met",
        matched: true,
        targets: [
          { target: "first", targetId: "p1", metadata: {}, recentUnwrappedLines: [], observedAtMs: 1, matched: false },
          { target: "second", targetId: "p2", metadata: {}, recentUnwrappedLines: [], observedAtMs: 1, matched: true, target_evidence: { kind: "native_done_observed", observedAtMs: 1, targetGenerationRef: "target_generation_opaque", currency: "historical_non_current", source: "native_agent_wait" } }
        ]
      }
    });
    expect(successAny.content).toContain("matchedTargets=second (p2)");
    expect(successAny.content).not.toContain("matchedTargets=first");
    expect(successAny.details).toMatchObject({ action: "wait", matchedTargets: ["p2"], matchedTargetCount: 1, target_evidence_kinds: ["native_done_observed"] });
    const successBeyondEvidence = notificationForJob({
      ...detail,
      wait_result: "condition_met",
      result: {
        wait_result: "condition_met",
        matched: true,
        targets: Array.from({ length: 101 }, (_, index) => ({ target: `target-${index + 1}`, targetId: `p${index + 1}`, metadata: {}, recentUnwrappedLines: [], observedAtMs: index, matched: index === 100 }))
      }
    });
    expect(successBeyondEvidence.content).toContain("matchedTargets=target-101 (p101)");
    expect(successBeyondEvidence.details).toMatchObject({ matchedTargets: ["p101"], matchedTargetCount: 1 });
    const boundedSuccess = notificationForJob({
      ...detail,
      request: { ...detail.request, targets: Array.from({ length: 20 }, (_, index) => `target-${index}`), targetIds: Array.from({ length: 20 }, (_, index) => `p${index}`) },
      wait_result: "condition_met",
      result: { wait_result: "condition_met", matched: true, matchedTargetCount: 20, matchedTargets: [{ target: "target-1", targetId: "p1" }] },
      truncation: { resultMatchedTargets: 19 }
    });
    expect(boundedSuccess.content).toContain("matchedTargetsOmitted=19");
    expect(boundedSuccess.details).toMatchObject({ matchedTargetCount: 20, matchedTargetsOmitted: 19, requestedTargetsOmitted: 4 });
    const timeoutWithMatchedSnapshot = notificationForJob({
      ...detail,
      wait_result: "timed_out",
      result: {
        wait_result: "timed_out",
        matched: false,
        targets: [{ target: "second", targetId: "p2", metadata: {}, recentUnwrappedLines: [], observedAtMs: 1, matched: true }]
      }
    });
    expect(timeoutWithMatchedSnapshot.content).toContain("matchedTargets=none");
    expect(timeoutWithMatchedSnapshot.details).toMatchObject({ matchedTargets: [] });
    const fallback = notificationForJob({ ...detail, jobId: 123 as never, operation_phase: "accepted", wait_result: undefined, result: undefined, request: { ...detail.request, targets: ["target"], targetIds: [] } });
    expect(fallback).toMatchObject({ details: { operation_phase: "accepted", reason: "awaiting_settlement", priority: "normal" } });
    expect(fallback.content).toContain("target (unknown)");
    const cancelled = notificationForJob({ ...detail, operation_phase: "settled", wait_result: "cancelled", result: undefined, cancelReason: "cancelled" });
    expect(cancelled).toMatchObject({ details: { operation_phase: "settled", wait_result: "cancelled", reason: "cancelled", priority: "normal" } });
    const codedFailure = notificationForJob({ ...detail, operation_phase: "settled", wait_result: "failed", result: undefined, error: { code: "BROKEN", message: "backend down" } });
    expect(codedFailure.content).toContain("reason=BROKEN");
    expect(codedFailure.content).toContain("error=BROKEN: backend down");
    const uncodedFailure = notificationForJob({ ...detail, operation_phase: "settled", wait_result: "failed", result: undefined, error: { message: "backend down" } });
    expect(uncodedFailure.content).toContain("reason=backend down");
    expect(uncodedFailure.content).toContain("error=error: backend down");
    enable();
    const { pi } = fakePi();
    const runtime = createRuntime(pi, process.env);
    const handle = runtime.jobs.register({ ...detail.request, condition: { kind: "state", state: "done" } }, async () => ({ wait_result: "condition_met", matched: true, reason: "condition_met" }));
    await handle.promise;
    expect((pi.sendMessage as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(expect.objectContaining({ customType: "herdr-wait-job", display: true }), { deliverAs: "steer", triggerTurn: true });
    const sentContent = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.content as string;
    expect(sentContent).toContain("wait_result=condition_met");

    const noNotifier = createRuntime({ exec: vi.fn() }, process.env);
    const noNotifierHandle = noNotifier.jobs.register(detail.request, async () => ({ wait_result: "condition_met", matched: true }));
    await noNotifierHandle.promise;

    const syncThrow = vi.fn(() => { throw new Error("Pi is shutting down"); });
    const throwingRuntime = createRuntime({ exec: vi.fn(), sendMessage: syncThrow }, process.env);
    const throwingHandle = throwingRuntime.jobs.register(detail.request, async () => ({ wait_result: "condition_met", matched: true }));
    await throwingHandle.promise;
    expect(syncThrow).toHaveBeenCalledTimes(1);
    const asyncReject = vi.fn().mockRejectedValue(new Error("Pi is unavailable"));
    const rejectingRuntime = createRuntime({ exec: vi.fn(), sendMessage: asyncReject }, process.env);
    const rejectingHandle = rejectingRuntime.jobs.register(detail.request, async () => ({ wait_result: "condition_met", matched: true }));
    await rejectingHandle.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(asyncReject).toHaveBeenCalledTimes(1);
  });

  it("wires the supervision repair transport to the runtime's own prompt client", async () => {
    enable();
    const { pi } = fakePi();
    const promptClient = {
      prompt: vi.fn(async () => ({ id: "cli:agent:prompt", result: { type: "agent_prompted", agent: { pane_id: "w1:p2" } } })),
      ping: vi.fn(async () => undefined),
      close: vi.fn(),
    };
    createRuntime(pi, process.env, { promptClient });
    // The gate's repair prompt must reach the exact child through the same
    // authenticated prompt transport every other send uses.
    const repairPrompt = registryOptions.last!.repairPrompt as (paneId: string, text: string, signal: AbortSignal) => Promise<unknown>;
    const signal = new AbortController().signal;
    await expect(repairPrompt("w1:p2", "repair the handoff artifact", signal)).resolves.toMatchObject({ id: "cli:agent:prompt" });
    expect(promptClient.prompt).toHaveBeenCalledWith("w1:p2", "repair the handoff artifact", signal);
    expect(pi.exec).not.toHaveBeenCalled();
  });

  it("suppresses notification for explicit cancel and shutdown", async () => {
    enable();
    const { pi } = fakePi();
    const runtime = createRuntime(pi, process.env);
    const pending = new Promise<never>(() => undefined);
    const handle = runtime.jobs.register({ kind: "wait" as const, label: "wait for worker", targets: ["worker"], targetIds: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1, settings: { reviewCadenceMinutes: 1, reviewerModel: "testmodel", reviewerThinking: "low" } }, async () => pending);
    runtime.jobs.cancel(handle.jobId);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect((pi.sendMessage as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    const second = runtime.jobs.register({ kind: "wait" as const, label: "wait for worker", targets: ["worker"], targetIds: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1, settings: { reviewCadenceMinutes: 1, reviewerModel: "testmodel", reviewerThinking: "low" } }, async () => pending);
    runtime.jobs.shutdown();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runtime.jobs.get(second.jobId)).toBeUndefined();
    expect((pi.sendMessage as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("registers no session handlers — the daemon owns the lifecycle now (C7)", async () => {
    enable();
    const { pi, handlers } = fakePi();
    extension();
    // The daemon survives client restarts, so there is no per-session Pi state
    // to reset or monitor: no handler may be registered for either transition.
    expect(handlers).toEqual([]);
    expect((pi.exec as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
