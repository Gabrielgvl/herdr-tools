import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { HerdrCli, type PiExec } from "../../src/cli.js";
import { JobRegistry } from "../../src/job-registry.js";
import { RuntimeOwnership } from "../../src/ownership.js";
import { createPreflight, createToolSurface, CORE_TOOL_NAMES, type HerdrToolDefinition } from "../../src/tool-surface.js";
import { AdapterContractError, HERDR_DETAILS_LABEL, MCP_RESULT_MAX_BYTES, callTool, describeTools, publishedInputSchema, type McpCallOutcome } from "../../src/mcp/adapter.js";
import { HostCapabilityError } from "../../src/mcp/host.js";

const health = { client: { version: "0.8.0", protocol: 19 }, server: { status: "running", version: "0.8.0", protocol: 19, compatible: true } };
const snapshot = {
  type: "session_snapshot",
  snapshot: {
    version: "1",
    protocol: 1,
    workspaces: [{ workspace_id: "w", label: "w" }],
    tabs: [{ tab_id: "w:t", workspace_id: "w", label: "t" }],
    panes: [{ pane_id: "w:p", tab_id: "w:t", workspace_id: "w", label: "caller", agent_name: "caller", agent_status: "idle" }],
    agents: [{ pane_id: "w:p", name: "caller", agent_status: "idle" }]
  }
};

function realSurface() {
  const exec: PiExec = async (_command, argv) => {
    if (argv[0] === "status") return { stdout: JSON.stringify(health), stderr: "", code: 0, killed: false };
    if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: snapshot }), stderr: "", code: 0, killed: false };
    if (argv[0] === "pane" && argv[1] === "get") return { stdout: JSON.stringify({ id: "pane", result: { pane: snapshot.snapshot.panes.find((pane) => pane.pane_id === argv[2]) } }), stderr: "", code: 0, killed: false };
    if (argv[0] === "pane" && argv[1] === "read") return { stdout: "caller output", stderr: "", code: 0, killed: false };
    return { stdout: JSON.stringify({ id: "other", result: { ok: true } }), stderr: "", code: 0, killed: false };
  };
  const cli = new HerdrCli(exec);
  return createToolSurface({
    cli,
    context: { workspaceId: "w", tabId: "w:t", paneId: "w:p" },
    environment: { enabled: true, currentIdsPresent: true, currentIdsValid: true },
    preflight: createPreflight(cli),
    settingsLoader: async () => ({ reviewCadenceMinutes: 5, reviewerModel: "luna", reviewerThinking: "low" }),
    jobs: new JobRegistry(),
    profiles: { load: async () => ({ effective: new Map(), candidates: [], diagnostics: [] }) as never },
    ownership: new RuntimeOwnership(),
    cwd: "/project"
  });
}

function stub(definition: Partial<HerdrToolDefinition> & Pick<HerdrToolDefinition, "execute">): { definitions: HerdrToolDefinition[] } {
  return {
    definitions: [{
      name: "herdr_inspect",
      label: "Herdr Inspect",
      description: "stub",
      parameters: Type.Object({ mode: Type.Optional(Type.String()) }, { additionalProperties: false }),
      ...definition
    }]
  };
}

const host = { cwd: "/project", signal: new AbortController().signal };

function call(surface: { definitions: HerdrToolDefinition[] }, args: unknown = {}, name = "herdr_inspect"): Promise<McpCallOutcome> {
  return callTool({ surface, name, args, host, callId: "call-1" });
}

function outcomeBytes(outcome: McpCallOutcome): number {
  return outcome.content.reduce((total, block) => total + Buffer.byteLength(block.text, "utf8"), 0);
}

function payload(outcome: McpCallOutcome): Record<string, unknown> {
  return JSON.parse(outcome.content[0]!.text) as Record<string, unknown>;
}

describe("MCP input schema publication", () => {
  it("publishes object roots unchanged and union roots as object with strict variants", () => {
    const object = Type.Object({ a: Type.String() }, { additionalProperties: false });
    expect(publishedInputSchema(object)).toMatchObject({ type: "object", additionalProperties: false });
    const union = Type.Union([
      Type.Object({ mode: Type.Literal("a") }, { additionalProperties: false }),
      Type.Object({ mode: Type.Literal("b") }, { additionalProperties: false })
    ]);
    const published = publishedInputSchema(union) as { type: string; anyOf: Array<{ additionalProperties: unknown }>; additionalProperties?: unknown };
    expect(published.type).toBe("object");
    expect(published.additionalProperties).toBeUndefined();
    expect(published.anyOf).toHaveLength(2);
    expect(published.anyOf.every((variant) => variant.additionalProperties === false)).toBe(true);
  });

  it("refuses any other root shape instead of publishing a permissive schema", () => {
    expect(() => publishedInputSchema(Type.String())).toThrowError(AdapterContractError);
    expect(() => publishedInputSchema(Type.Array(Type.String()))).toThrowError(AdapterContractError);
    const failure = (() => { try { publishedInputSchema(Type.Number()); } catch (error) { return error; } })();
    expect(failure).toMatchObject({ code: "ADAPTER_CONTRACT_VIOLATION" });
  });

  it("describes the seven shared tools as structural clones", () => {
    const surface = realSurface();
    const descriptors = describeTools(surface);
    expect(descriptors.map((descriptor) => descriptor.name)).toEqual([...CORE_TOOL_NAMES]);
    expect(descriptors.map((descriptor) => descriptor.title)).toEqual(surface.definitions.map((definition) => definition.label));
    expect(descriptors.map((descriptor) => descriptor.description)).toEqual(surface.definitions.map((definition) => definition.description));
    expect(descriptors.every((descriptor) => descriptor.inputSchema.type === "object")).toBe(true);
    expect(descriptors[0]!.inputSchema).not.toBe(surface.definitions[0]!.parameters);
    expect(descriptors[0]!.inputSchema).toMatchObject({ anyOf: expect.any(Array) as unknown as unknown[] });
  });
});

describe("MCP argument validation", () => {
  it("accepts the no-argument form and rejects unknown fields with bounded schema errors", async () => {
    const surface = realSurface();
    const definitions = { definitions: [...surface.definitions] };
    const absent = await callTool({ surface: definitions, name: "herdr_inspect", args: undefined, host, callId: "c" });
    const nulled = await callTool({ surface: definitions, name: "herdr_inspect", args: null, host, callId: "c" });
    expect(absent.isError).toBeUndefined();
    expect(nulled.isError).toBeUndefined();
    expect(absent.content[0]!.text).toContain("inspect");
    const invalid = await callTool({ surface: definitions, name: "herdr_inspect", args: { mode: "health", extra: true }, host, callId: "c" });
    expect(invalid.isError).toBe(true);
    const body = payload(invalid);
    expect(body.code).toBe("INVALID_INPUT");
    expect(body.message).toContain("herdr_inspect");
    expect((body.details as { errors: unknown[] }).errors).toHaveLength(3);
    expect((body.details as { errors: Array<Record<string, string>> }).errors[0]).toMatchObject({ keyword: expect.any(String) as unknown as string, message: expect.any(String) as unknown as string });
  });

  it("rejects invalid arguments for every union and object schema before execution", async () => {
    const surface = realSurface();
    const rejected: Array<[string, unknown]> = [
      ["herdr_communicate", { target: "w:p2", operation: "prompt" }],
      ["herdr_wait", { targets: [], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 }],
      ["herdr_jobs", { operation: "get" }],
      ["herdr_launch", { name: "Worker", profile: "worker-pi" }],
      ["herdr_pane", { operation: "split" }],
      ["herdr_tab", { operation: "create" }]
    ];
    for (const [name, args] of rejected) {
      const outcome = await callTool({ surface, name, args, host, callId: "c" });
      expect(outcome.isError).toBe(true);
      expect(payload(outcome).code).toBe("INVALID_INPUT");
    }
    const accepted = await callTool({ surface, name: "herdr_jobs", args: { operation: "list" }, host, callId: "c" });
    expect(accepted.isError).toBeUndefined();
  });

  it("raises MethodNotFound for an unknown tool name", async () => {
    const surface = realSurface();
    const failure = await callTool({ surface, name: "herdr_admin\nnope", args: {}, host, callId: "c" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(McpError);
    expect(failure).toMatchObject({ code: ErrorCode.MethodNotFound });
    expect((failure as McpError).message).toContain("herdr_admin nope");
  });
});

describe("MCP result mapping", () => {
  it("passes shared text blocks through verbatim and appends one bounded details block", async () => {
    const surface = stub({
      execute: async () => ({ content: [{ type: "text", text: "first" }, { type: "text", text: "second" }, { type: "image", data: "ignored", mimeType: "image/png" }], details: { operation: "inspect", outcome: "success" } })
    });
    const outcome = await call(surface);
    expect(outcome.isError).toBeUndefined();
    expect(outcome.content.map((block) => block.text)).toEqual([
      "first",
      "second",
      `${HERDR_DETAILS_LABEL}\n${JSON.stringify({ operation: "inspect", outcome: "success" })}`
    ]);
  });

  it("omits the details block when the shared tool reports none", async () => {
    const outcome = await call(stub({ execute: async () => ({ content: [{ type: "text", text: "only" }], details: undefined }) }));
    expect(outcome.content).toEqual([{ type: "text", text: "only" }]);
  });

  it("omits a details block that a shared block already publishes in full", async () => {
    const details = { operation: "jobs", outcome: "success", jobs: [{ jobId: "job_1", status: "running" }] };
    const identical = await call(stub({ execute: async () => ({ content: [{ type: "text", text: JSON.stringify(details) }], details }) }));
    expect(identical.content).toEqual([{ type: "text", text: JSON.stringify(details) }]);
    const prettyPrinted = await call(stub({ execute: async () => ({ content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details }) }));
    expect(prettyPrinted.content).toEqual([{ type: "text", text: JSON.stringify(details, null, 2) }]);
    const prose = await call(stub({ execute: async () => ({ content: [{ type: "text", text: "Inspected panes" }], details }) }));
    expect(prose.content).toHaveLength(2);

    // Anything short of an exact, complete serialization keeps its block, so no
    // structured evidence is ever hidden behind a near-duplicate rendering.
    const truncatedRendering = await call(stub({ execute: async () => ({ content: [{ type: "text", text: `${JSON.stringify(details)}\n[output truncated]` }], details }) }));
    expect(truncatedRendering.content).toHaveLength(2);
    expect(truncatedRendering.content[1]!.text).toBe(`${HERDR_DETAILS_LABEL}\n${JSON.stringify(details)}`);
    const projection = await call(stub({ execute: async () => ({ content: [{ type: "text", text: JSON.stringify({ jobs: details.jobs }) }], details }) }));
    expect(projection.content).toHaveLength(2);
  });

  it("publishes herdr_jobs evidence exactly once", async () => {
    const surface = realSurface();
    const outcome = await callTool({ surface, name: "herdr_jobs", args: { operation: "list" }, host, callId: "c" });
    expect(outcome.content).toHaveLength(1);
    expect(outcome.content[0]!.text).not.toContain(HERDR_DETAILS_LABEL);
    expect(JSON.parse(outcome.content[0]!.text)).toMatchObject({ operation: "jobs", kind: "list" });
  });

  it("truncates oversized details before the shared blocks and stays within the response bound", async () => {
    const outcome = await call(stub({
      execute: async () => ({ content: [{ type: "text", text: "shared" }], details: { blob: "d".repeat(200_000) } })
    }));
    expect(outcome.content[0]!.text).toBe("shared");
    expect(outcome.content[1]!.text.startsWith(`${HERDR_DETAILS_LABEL}\n{"blob":"ddd`)).toBe(true);
    expect(outcome.content[1]!.text.endsWith("[output truncated]")).toBe(true);
    expect(outcomeBytes(outcome)).toBeLessThanOrEqual(MCP_RESULT_MAX_BYTES);
    const multibyte = await call(stub({
      execute: async () => ({ content: [], details: { blob: "🐑".repeat(40_000) } })
    }));
    expect(multibyte.content[0]!.text.endsWith("[output truncated]")).toBe(true);
    expect(multibyte.content[0]!.text).not.toContain("�");
    expect(outcomeBytes(multibyte)).toBeLessThanOrEqual(MCP_RESULT_MAX_BYTES);
  });

  it("drops the details block and truncates shared blocks when the shared content fills the bound", async () => {
    const oversized = await call(stub({
      execute: async () => ({ content: [{ type: "text", text: "a".repeat(MCP_RESULT_MAX_BYTES + 500) }], details: { blob: "c".repeat(1_000) } })
    }));
    expect(oversized.content).toHaveLength(1);
    expect(oversized.content[0]!.text.startsWith("aaa")).toBe(true);
    expect(oversized.content[0]!.text.endsWith("[output truncated]")).toBe(true);
    expect(outcomeBytes(oversized)).toBeLessThanOrEqual(MCP_RESULT_MAX_BYTES);
    const partial = await call(stub({
      execute: async () => ({ content: [{ type: "text", text: "x".repeat(MCP_RESULT_MAX_BYTES - 200) }, { type: "text", text: "y".repeat(1_000) }, { type: "text", text: "dropped" }], details: undefined })
    }));
    expect(partial.content).toHaveLength(2);
    expect(partial.content[0]!.text.endsWith("[output truncated]")).toBe(false);
    expect(partial.content[1]!.text.endsWith("[output truncated]")).toBe(true);
    expect(outcomeBytes(partial)).toBeLessThanOrEqual(MCP_RESULT_MAX_BYTES);
    const exact = await call(stub({
      execute: async () => ({ content: [{ type: "text", text: "z".repeat(MCP_RESULT_MAX_BYTES) }], details: { blob: "c" } })
    }));
    expect(exact.content).toHaveLength(1);
    expect(exact.content[0]!.text.endsWith("[output truncated]")).toBe(false);
  });

  it("serializes unserializable details as null rather than failing the call", async () => {
    const outcome = await call(stub({ execute: async () => ({ content: [], details: (() => undefined) as never }) }));
    expect(outcome.content[0]!.text).toBe(`${HERDR_DETAILS_LABEL}\nnull`);
  });
});

describe("MCP error mapping", () => {
  it("keeps typed tool failures as model-visible tool results", async () => {
    const codes = ["INVALID_INPUT", "TARGET_NOT_FOUND", "TARGET_AMBIGUOUS", "CLI_TIMEOUT", "CLI_PROTOCOL_ERROR", "PROFILE_CATALOG_UNAVAILABLE", "REVIEWER_FAILED", "ABORTED"];
    for (const code of codes) {
      const outcome = await call(stub({
        execute: async () => { throw Object.assign(new Error(`${code}: refused`), { code, details: { target: "w:p2" } }); }
      }));
      expect(outcome.isError).toBe(true);
      expect(payload(outcome)).toMatchObject({ code, message: `${code}: refused`, details: { target: "w:p2" } });
    }
  });

  it("reports a denied host capability with its own code", async () => {
    const outcome = await call(stub({ execute: async () => { throw new HostCapabilityError("MCP host does not provide modelRegistry"); } }));
    expect(payload(outcome)).toMatchObject({ code: "HOST_CAPABILITY_UNAVAILABLE", message: "MCP host does not provide modelRegistry" });
  });

  it("falls back to INTERNAL_ERROR for untyped, blank, and non-error failures", async () => {
    const plain = await call(stub({ execute: async () => { throw new Error("boom"); } }));
    expect(payload(plain)).toEqual({ code: "INTERNAL_ERROR", message: "boom" });
    const blank = await call(stub({ execute: async () => { throw Object.assign(new Error("blank"), { code: "   " }); } }));
    expect(payload(blank)).toMatchObject({ code: "INTERNAL_ERROR" });
    const numeric = await call(stub({ execute: async () => { throw Object.assign(new Error("numeric"), { code: 7, details: "not-an-object" }); } }));
    expect(payload(numeric)).toEqual({ code: "INTERNAL_ERROR", message: "numeric" });
    const thrownString = await call(stub({ execute: async () => { throw "no error object"; } }));
    expect(payload(thrownString)).toEqual({ code: "INTERNAL_ERROR", message: "no error object" });
  });

  it("bounds a hostile failure message, code, and details", async () => {
    const outcome = await call(stub({
      execute: async () => { throw Object.assign(new Error(`line\none${"m".repeat(5_000)}`), { code: `WEIRD\nCODE${"x".repeat(500)}`, details: { blob: "d".repeat(200_000) } }); }
    }));
    const text = outcome.content[0]!.text;
    const [, code, message] = /^\{"code":"([^"]+)","message":"([^"]+)"/.exec(text) ?? [];
    expect(code).toBe(`WEIRD CODE${"x".repeat(110)}`);
    expect(message).toBe(`line one${"m".repeat(1_992)}`);
    expect(text.slice(0, -"\n[output truncated]".length)).not.toContain("\n");
    expect(text.endsWith("[output truncated]")).toBe(true);
    expect(outcomeBytes(outcome)).toBeLessThanOrEqual(MCP_RESULT_MAX_BYTES);
  });

  it("hands the request cancellation signal to the shared tool", async () => {
    const controller = new AbortController();
    const execute = vi.fn(async (_id: string, _args: unknown, signal: AbortSignal | undefined) => {
      expect(signal).toBe(controller.signal);
      return { content: [{ type: "text" as const, text: "ok" }], details: undefined };
    });
    await callTool({ surface: stub({ execute }), name: "herdr_inspect", args: {}, host: { cwd: "/project", signal: controller.signal }, callId: "c" });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
