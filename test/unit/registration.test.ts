import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", () => ({ readFile: readFileMock }));

import extension, { CORE_TOOL_NAMES, createRuntime, readInjectedContext } from "../../index.js";
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

  it("registers exactly the six core tools and no deferred aliases", () => {
    enable();
    const { pi, tools, handlers } = fakePi();
    extension(pi);
    expect(tools.map((tool) => (tool as { name: string }).name)).toEqual([...CORE_TOOL_NAMES]);
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
    expect(tools).toHaveLength(6);
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
