import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", () => ({ readFile: readFileMock }));

import extension, { CORE_TOOL_NAMES, createRuntime, notificationForJob, readInjectedContext } from "../../index.js";
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
  const handlers: Array<{ event: string; handler: (...args: never[]) => unknown }> = [];
  const pi = {
    exec: vi.fn(),
    sendMessage: vi.fn(),
    registerTool: vi.fn((tool: unknown) => tools.push(tool)),
    on: vi.fn((event: string, handler: (...args: never[]) => unknown) => handlers.push({ event, handler })),
  } as unknown as ExtensionAPI;
  return { pi, tools, handlers };
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
    const { pi, tools, handlers } = fakePi();
    extension(pi);
    expect(tools).toEqual([]);
    expect(handlers).toEqual([]);
    expect((pi.exec as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("registers exactly the seven core tools and no deferred aliases", () => {
    enable();
    const { pi, tools, handlers } = fakePi();
    extension(pi);
    expect(tools.map((tool) => (tool as { name: string }).name)).toEqual([...CORE_TOOL_NAMES]);
    expect(tools).toHaveLength(7);
    expect(tools.map((tool) => (tool as { name: string }).name)).not.toContain("herdr_command");
    expect(tools.map((tool) => (tool as { name: string }).name)).not.toContain("herdr_workspace");
    expect(tools.map((tool) => (tool as { name: string }).name)).not.toContain("herdr_admin");
    expect(handlers.map((entry) => entry.event)).toEqual(["session_shutdown", "session_start"]);
    expect((pi.exec as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("keeps enabled registration fail-closed when injected IDs are absent or malformed", () => {
    enable(false);
    const missing = readInjectedContext();
    expect(missing).toEqual({ context: {}, idsPresent: false, idsValid: true });
    process.env.HERDR_PANE_ID = "bad\nvalue";
    expect(readInjectedContext()).toMatchObject({ idsPresent: false, idsValid: false, context: {} });
    const { pi, tools } = fakePi();
    extension(pi);
    expect(tools).toHaveLength(7);
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
    await expect(runtime.settings.load()).resolves.toMatchObject({ reviewCadenceMinutes: 5, reviewerModel: "openai-codex/gpt-5.6-luna", reviewerThinking: "low" });
  });

  it("pushes bounded terminal notifications with queue and priority semantics", async () => {
    const detail = {
      jobId: "job_notify",
      status: "completed" as const,
      sequence: 1,
      createdAtMs: 0,
      finishedAtMs: 1,
      request: { targets: ["worker\\n<untrusted>"], targetIds: ["p1"], match: "any" as const, condition: { kind: "state", state: "done" }, timeoutMs: 1, settings: { reviewCadenceMinutes: 1, reviewerModel: "luna", reviewerThinking: "low" as const } },
      outcome: "manager_judgment_required" as const,
      result: { outcome: "manager_judgment_required" as const, matched: false, reason: "manager_judgment_required", reviewerSummaries: [{ target: "worker", targetId: "p1", classification: "blocked", summary: "review\nsummary" }] }
    };
    const notification = notificationForJob(detail);
    expect(notification.content).toContain("HIGH PRIORITY: MANAGER JUDGMENT REQUIRED");
    expect(notification.content).not.toContain("review\nsummary");
    expect(notification.details).toMatchObject({ priority: "high", jobId: "job_notify" });
    const fallback = notificationForJob({ ...detail, jobId: 123 as never, status: "completed", outcome: undefined, result: undefined, request: { ...detail.request, targets: ["target"], targetIds: [] } });
    expect(fallback).toMatchObject({ details: { outcome: "completed", reason: "completed", priority: "normal" } });
    expect(fallback.content).toContain("target (unknown)");
    const cancelled = notificationForJob({ ...detail, status: "cancelled", outcome: undefined, result: undefined, cancelReason: "cancelled" });
    expect(cancelled).toMatchObject({ details: { outcome: "cancelled", reason: "cancelled", priority: "normal" } });
    const codedFailure = notificationForJob({ ...detail, status: "failed", outcome: undefined, result: undefined, error: { code: "BROKEN", message: "backend down" } });
    expect(codedFailure.content).toContain("reason=BROKEN");
    expect(codedFailure.content).toContain("error=BROKEN: backend down");
    const uncodedFailure = notificationForJob({ ...detail, status: "failed", outcome: undefined, result: undefined, error: { message: "backend down" } });
    expect(uncodedFailure.content).toContain("reason=backend down");
    expect(uncodedFailure.content).toContain("error=error: backend down");
    enable();
    const { pi } = fakePi();
    const runtime = createRuntime(pi, process.env);
    const handle = runtime.jobs.register({ ...detail.request, condition: { kind: "state", state: "done" } }, async () => ({ outcome: "success", matched: true, reason: "condition_met" }));
    await handle.promise;
    expect((pi.sendMessage as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(expect.objectContaining({ customType: "herdr-wait-job", display: true }), { deliverAs: "steer", triggerTurn: true });
    const sentContent = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.content as string;
    expect(sentContent).toContain("outcome=success");

    const noNotifier = createRuntime({ exec: vi.fn() }, process.env);
    const noNotifierHandle = noNotifier.jobs.register(detail.request, async () => ({ outcome: "success", matched: true }));
    await noNotifierHandle.promise;

    const syncThrow = vi.fn(() => { throw new Error("Pi is shutting down"); });
    const throwingRuntime = createRuntime({ exec: vi.fn(), sendMessage: syncThrow }, process.env);
    const throwingHandle = throwingRuntime.jobs.register(detail.request, async () => ({ outcome: "success", matched: true }));
    await throwingHandle.promise;
    expect(syncThrow).toHaveBeenCalledTimes(1);
    const asyncReject = vi.fn().mockRejectedValue(new Error("Pi is unavailable"));
    const rejectingRuntime = createRuntime({ exec: vi.fn(), sendMessage: asyncReject }, process.env);
    const rejectingHandle = rejectingRuntime.jobs.register(detail.request, async () => ({ outcome: "success", matched: true }));
    await rejectingHandle.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(asyncReject).toHaveBeenCalledTimes(1);
  });

  it("suppresses notification for explicit cancel and shutdown", async () => {
    enable();
    const { pi } = fakePi();
    const runtime = createRuntime(pi, process.env);
    const pending = new Promise<never>(() => undefined);
    const handle = runtime.jobs.register({ targets: ["worker"], targetIds: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1, settings: { reviewCadenceMinutes: 1, reviewerModel: "luna", reviewerThinking: "low" } }, async () => pending);
    runtime.jobs.cancel(handle.jobId);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect((pi.sendMessage as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    const second = runtime.jobs.register({ targets: ["worker"], targetIds: ["p1"], match: "any", condition: { kind: "state", state: "done" }, timeoutMs: 1, settings: { reviewCadenceMinutes: 1, reviewerModel: "luna", reviewerThinking: "low" } }, async () => pending);
    runtime.jobs.shutdown();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runtime.jobs.get(second.jobId)).toBeUndefined();
    expect((pi.sendMessage as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("resets only in-memory ownership on every session transition", async () => {
    enable();
    const reset = vi.spyOn(RuntimeOwnership.prototype, "reset");
    const { pi, handlers } = fakePi();
    extension(pi);
    const shutdown = handlers.find((entry) => entry.event === "session_shutdown")?.handler;
    const start = handlers.find((entry) => entry.event === "session_start")?.handler;
    expect(shutdown).toBeDefined();
    expect(start).toBeDefined();
    await shutdown?.({} as never, {} as never);
    await start?.({} as never, {} as never);
    expect(reset).toHaveBeenCalledTimes(2);
    expect((pi.exec as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
