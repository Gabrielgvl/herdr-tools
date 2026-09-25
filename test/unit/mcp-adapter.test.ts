import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "typebox";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "../../src/daemon/client.js";
import { createToolSurface, CORE_TOOL_NAMES, type HerdrToolDefinition } from "../../src/tool-surface.js";
import { AdapterContractError, HERDR_DETAILS_LABEL, MCP_RESULT_MAX_BYTES, callTool, describeTools, errorOutcome, publishedInputSchema, type McpCallOutcome } from "../../src/mcp/adapter.js";
import { HostCapabilityError } from "../../src/mcp/host.js";
import { LAUNCH_DIAGNOSTIC_MARKER, LAUNCH_RECOVERY_GUIDANCE } from "../../src/tools/launch.js";
import { TOOL_DIAGNOSTIC_MARKER, TOOL_DIAGNOSTIC_RECOVERY } from "../../src/telemetry.js";

/**
 * The real three-tool surface over a scripted daemon client: every typed call
 * records its request and returns the canned reply, so adapter assertions can
 * inspect exactly what crossed the proxy boundary.
 */
function realSurface(replies: { launch?: unknown; run?: unknown; status?: unknown } = {}) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const client = {
    launch: async (params: unknown) => { calls.push({ method: "launch", params }); return replies.launch ?? { kind: "launch", state: "completed" }; },
    run: async (params: unknown) => { calls.push({ method: "run", params }); return replies.run ?? { kind: "run" }; },
    status: async (params: unknown) => { calls.push({ method: "status", params }); return replies.status ?? { kind: "status", daemon: { status: "running" } }; },
    close: () => undefined,
  };
  const surface = createToolSurface({ connectDaemon: async () => client as unknown as DaemonClient, cwd: "/project" });
  return { surface, calls };
}

function stub(definition: Partial<HerdrToolDefinition> & Pick<HerdrToolDefinition, "execute">): { definitions: HerdrToolDefinition[] } {
  return {
    definitions: [{
      name: "herdr_status",
      label: "Herdr Status",
      description: "stub",
      parameters: Type.Object({ eventId: Type.Optional(Type.String()) }, { additionalProperties: false }),
      ...definition
    }]
  };
}

const host = { cwd: "/project", signal: new AbortController().signal };

function call(surface: { definitions: HerdrToolDefinition[] }, args: unknown = {}, name = "herdr_status"): Promise<McpCallOutcome> {
  return callTool({ surface, name, args, host, callId: "call-1" });
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("schema field is not an object");
  return value as Record<string, unknown>;
}

function outcomeBytes(outcome: McpCallOutcome): number {
  return outcome.content.reduce((total, block) => total + Buffer.byteLength(block.text, "utf8"), 0);
}

function payload(outcome: McpCallOutcome): Record<string, unknown> {
  return JSON.parse(outcome.content[0]!.text) as Record<string, unknown>;
}

/** The appended structured block, parsed. Every block must be valid JSON. */
function detailsOf(outcome: McpCallOutcome): unknown {
  const block = outcome.content.find((entry) => entry.text.startsWith(`${HERDR_DETAILS_LABEL}\n`));
  if (!block) throw new Error("outcome carried no herdr-details block");
  return JSON.parse(block.text.slice(HERDR_DETAILS_LABEL.length + 1));
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

  it("publishes herdr_launch as the strict {task, idempotencyKey} root", () => {
    const definition = realSurface().surface.definitions.find((candidate) => candidate.name === "herdr_launch")!;
    const published = publishedInputSchema(definition.parameters) as { type: string; properties: Record<string, unknown>; required?: unknown; anyOf?: unknown; additionalProperties?: unknown };
    expect(published.type).toBe("object");
    expect(published.anyOf).toBeUndefined();
    expect(published.required).toEqual(expect.arrayContaining(["task", "idempotencyKey"]));
    expect(published.additionalProperties).toBe(false);
    const task = record(published.properties.task);
    // The Task is a single strict object with the real requireds.
    expect(task.required).toEqual(expect.arrayContaining(["objective", "scope", "doneWhen"]));
    const taskProperties = record(task.properties);
    for (const field of ["objective", "scope", "doneWhen", "constraints", "tier", "replicas", "recoveryOf", "label", "cwd"]) {
      expect(taskProperties).toHaveProperty(field);
    }
    // The deleted caller-authority fields have no alias at the boundary —
    // neither on the request root nor inside the Task.
    for (const field of ["name", "specs", "tasks", "instructions", "assignment", "supervisionDigest", "category", "count", "placement", "focus", "assignmentDelivery", "profile", "overrides", "transportBypass"]) {
      expect(taskProperties).not.toHaveProperty(field);
    }
    for (const field of ["identity", "projectRoot", "runId", "runIds", "eventId", "successorPaneId", "incidentId"]) {
      expect(published.properties).not.toHaveProperty(field);
    }
    // The delegated-mode caller assertion is additive, optional, and strict.
    const caller = record(published.properties.caller);
    expect(caller.type).toBe("object");
    expect(caller.additionalProperties).toBe(false);
    expect(caller.required).toEqual(expect.arrayContaining(["paneId", "projectRoot"]));
    expect(published.required).not.toContain("caller");
  });

  it("publishes herdr_run as a strict discriminated-union root and herdr_status as a strict object", () => {
    const run = realSurface().surface.definitions.find((candidate) => candidate.name === "herdr_run")!;
    const publishedRun = publishedInputSchema(run.parameters) as { type: string; anyOf: Array<Record<string, unknown>> };
    // The union gains only the object type MCP requires; each variant stays
    // strict — the wire contract can never be looser than validation.
    expect(publishedRun.type).toBe("object");
    expect(publishedRun.anyOf.map((variant) => record(record(variant.properties).action).const)).toEqual(
      expect.arrayContaining(["observe", "reconcile", "transfer", "claim", "ack"])
    );
    expect(publishedRun.anyOf).toHaveLength(5);
    expect(publishedRun.anyOf.every((variant) => variant.additionalProperties === false)).toBe(true);
    // Every action variant admits the optional delegated caller assertion.
    for (const variant of publishedRun.anyOf) {
      const caller = record(record(variant.properties).caller);
      expect(caller.required).toEqual(expect.arrayContaining(["paneId", "projectRoot"]));
      expect(variant.required as unknown[]).not.toContain("caller");
    }

    const status = realSurface().surface.definitions.find((candidate) => candidate.name === "herdr_status")!;
    const publishedStatus = publishedInputSchema(status.parameters) as Record<string, unknown>;
    expect(publishedStatus.type).toBe("object");
    expect(publishedStatus.anyOf).toBeUndefined();
    expect(publishedStatus.additionalProperties).toBe(false);
    expect(record(publishedStatus.properties)).toHaveProperty("eventId");
    expect(record(publishedStatus.properties)).toHaveProperty("caller");
  });

  it("refuses any other root shape instead of publishing a permissive schema", () => {
    expect(() => publishedInputSchema(Type.String())).toThrowError(AdapterContractError);
    expect(() => publishedInputSchema(Type.Array(Type.String()))).toThrowError(AdapterContractError);
    const failure = (() => { try { publishedInputSchema(Type.Number()); } catch (error) { return error; } })();
    expect(failure).toMatchObject({ code: "ADAPTER_CONTRACT_VIOLATION" });
  });

  it("describes the three shared tools as structural clones", () => {
    const { surface } = realSurface();
    const descriptors = describeTools(surface);
    expect(descriptors.map((descriptor) => descriptor.name)).toEqual([...CORE_TOOL_NAMES]);
    expect(descriptors.map((descriptor) => descriptor.title)).toEqual(surface.definitions.map((definition) => definition.label));
    expect(descriptors.map((descriptor) => descriptor.description)).toEqual(surface.definitions.map((definition) => definition.description));
    expect(descriptors.every((descriptor) => descriptor.inputSchema.type === "object")).toBe(true);
    expect(descriptors[0]!.inputSchema).not.toBe(surface.definitions[0]!.parameters);
    expect(descriptors[0]!.inputSchema).toMatchObject({ properties: expect.any(Object) as unknown as Record<string, unknown> });
  });
});

describe("MCP published schema parity", () => {
  it("publishes each shared schema unchanged except for the object root MCP requires", () => {
    for (const definition of realSurface().surface.definitions) {
      const source = JSON.parse(JSON.stringify(definition.parameters)) as Record<string, unknown>;
      // Publication may only add the root `type`; it can never drop or loosen a
      // keyword, so the published document cannot accept more than validation.
      expect(publishedInputSchema(definition.parameters)).toEqual({ ...source, type: "object" });
    }
  });

  it("admits every variant-shaped call at the root while keeping strict keys and field types", () => {
    const { surface } = realSurface();
    const taskReq = (overrides: Record<string, unknown> = {}) => ({ task: { objective: "o", scope: "s", doneWhen: ["d"], constraints: ["none"], ...overrides }, idempotencyKey: "idem-1" });
    const cases: Array<[string, unknown, boolean]> = [
      // herdr_status: one optional named-event selector.
      ["herdr_status", {}, true],
      ["herdr_status", { eventId: "evt-1" }, true],
      ["herdr_status", { eventId: 7 }, false],
      ["herdr_status", { eventId: "bad\nid" }, false],
      ["herdr_status", { extra: true }, false],
      // herdr_run: the strict discriminated union — every action's required
      // fields, strict keys, and the deleted tool names stay unknown fields.
      ["herdr_run", { action: "observe", runId: "run-1" }, true],
      ["herdr_run", { action: "observe" }, false],
      ["herdr_run", { action: "observe", runId: "run-1", extra: true }, false],
      ["herdr_run", { action: "reconcile", idempotencyKey: "idem-1" }, true],
      ["herdr_run", { action: "reconcile" }, false],
      ["herdr_run", { action: "transfer", runIds: ["run-1"], successorPaneId: "w:p2" }, true],
      ["herdr_run", { action: "transfer", runIds: [] , successorPaneId: "w:p2" }, false],
      ["herdr_run", { action: "transfer", runIds: ["run-1"] }, false],
      ["herdr_run", { action: "claim", runIds: ["run-1"], incidentId: "inc-1" }, true],
      ["herdr_run", { action: "claim", runIds: ["run-1"] }, false],
      ["herdr_run", { action: "ack", eventId: "evt-1" }, true],
      ["herdr_run", { action: "ack" }, false],
      ["herdr_run", { action: "ack", eventId: "bad\nevt" }, false],
      ["herdr_run", { action: "bogus" }, false],
      ["herdr_run", { operation: "list" }, false],
      ["herdr_run", { mode: "context" }, false],
      // The Task request: caller-authored fields plus the required
      // idempotency key — no identity, routing, placement, or supervision
      // authority.
      ["herdr_launch", taskReq(), true],
      ["herdr_launch", taskReq({ tier: "strong", replicas: 2, label: "docs sprint", cwd: "/repo", recoveryOf: "run-1" }), true],
      ["herdr_launch", { task: "nope", idempotencyKey: "k" }, false],
      ["herdr_launch", taskReq({ extra: true }), false],
      ["herdr_launch", { task: { objective: "o", scope: "s", doneWhen: ["d"] }, idempotencyKey: "k", extra: true }, false],
      // The idempotency key is required and bounded.
      ["herdr_launch", { task: { objective: "o", scope: "s", doneWhen: ["d"] } }, false],
      ["herdr_launch", { task: { objective: "o", scope: "s", doneWhen: ["d"] }, idempotencyKey: "" }, false],
      // The required semantic fields fail at the schema when absent or empty.
      ["herdr_launch", { task: { objective: "o", scope: "s" }, idempotencyKey: "k" }, false],
      ["herdr_launch", taskReq({ objective: "" }), false],
      ["herdr_launch", taskReq({ scope: "" }), false],
      ["herdr_launch", taskReq({ doneWhen: [] }), false],
      ["herdr_launch", taskReq({ doneWhen: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] }), false],
      ["herdr_launch", taskReq({ constraints: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] }), false],
      ["herdr_launch", taskReq({ constraints: [] }), true],
      ["herdr_launch", taskReq({ objective: "a\0b" }), false],
      ["herdr_launch", taskReq({ label: "a\nb" }), false],
      // Tier is the reviewed enum; replicas is a bounded integer.
      ["herdr_launch", taskReq({ tier: "bogus" }), false],
      ["herdr_launch", taskReq({ tier: "standard" }), true],
      ["herdr_launch", taskReq({ replicas: 0 }), false],
      ["herdr_launch", taskReq({ replicas: 9 }), false],
      ["herdr_launch", taskReq({ replicas: 1.5 }), false],
      ["herdr_launch", taskReq({ replicas: "2" }), false],
      ["herdr_launch", taskReq({ replicas: 8 }), true],
      // The deleted caller-authority fields are unknown keys — no alias survives.
      ["herdr_launch", taskReq({ name: "worker" }), false],
      ["herdr_launch", taskReq({ specs: [{ label: "worker" }] }), false],
      ["herdr_launch", taskReq({ tasks: [] }), false],
      ["herdr_launch", taskReq({ instructions: "i" }), false],
      ["herdr_launch", taskReq({ assignment: { objective: "o" } }), false],
      ["herdr_launch", taskReq({ supervisionDigest: { doneWhen: ["d"], constraints: ["none"] } }), false],
      ["herdr_launch", taskReq({ category: "cheap" }), false],
      ["herdr_launch", taskReq({ count: 2 }), false],
      ["herdr_launch", taskReq({ placement: { mode: "existing_pane" } }), false],
      ["herdr_launch", taskReq({ focus: true }), false],
      ["herdr_launch", taskReq({ assignmentDelivery: "inline" }), false],
      ["herdr_launch", taskReq({ transportBypass: true }), false],
      // The profile-era request is unknown keys at the boundary.
      ["herdr_launch", taskReq({ profile: "worker-pi" }), false],
      ["herdr_launch", taskReq({ overrides: { model: "m" } }), false],
      ["herdr_launch", taskReq({ initialPrompt: "o" }), false]
    ];
    for (const [name, args, accepted] of cases) {
      const definition = surface.definitions.find((candidate) => candidate.name === name)!;
      const published = publishedInputSchema(definition.parameters) as unknown as TSchema;
      const label = `${name} ${JSON.stringify(args)}`;
      expect(Value.Check(published, args), `published: ${label}`).toBe(accepted);
      expect(Value.Check(definition.parameters, args), `validation: ${label}`).toBe(accepted);
    }
  });

  it("keeps the wire contract at runtime: every contract-invalid call is INVALID_INPUT", async () => {
    const { surface } = realSurface();
    // Missing required fields, removed fields, strict-key violations, and bad
    // value domains fail at the request boundary before the daemon is touched.
    const rejected: Array<[string, unknown]> = [
      ["herdr_status", { eventId: 7 }],
      ["herdr_status", { mode: "context" }],
      ["herdr_run", { action: "observe" }],
      ["herdr_run", { action: "observe", runId: "run-1", extra: true }],
      ["herdr_run", { action: "reconcile" }],
      ["herdr_run", { action: "transfer", runIds: ["r"], successorPaneId: "p", extra: 1 }],
      ["herdr_run", { action: "claim", runIds: ["r"] }],
      ["herdr_run", { action: "ack" }],
      ["herdr_run", { action: "bogus" }],
      ["herdr_run", { target: "w:p2", operation: "prompt" }],
      ["herdr_launch", { task: { objective: "o", scope: "s", doneWhen: ["d"] } }],
      ["herdr_launch", { task: { objective: "o", scope: "s" }, idempotencyKey: "k" }],
      ["herdr_launch", { task: { objective: "o", scope: "s", doneWhen: [] }, idempotencyKey: "k" }],
      ["herdr_launch", { task: { objective: "o", scope: "s", doneWhen: ["d"], replicas: 0 }, idempotencyKey: "k" }],
      ["herdr_launch", { task: { objective: "o", scope: "s", doneWhen: ["d"], tier: "bogus" }, idempotencyKey: "k" }],
      ["herdr_launch", { task: { objective: "o", scope: "s", doneWhen: ["d"], label: "a\nb" }, idempotencyKey: "k" }],
      ["herdr_launch", { name: "task", specs: [{ label: "worker", instructions: "i", assignment: { objective: "o", scope: "s", verification: "v" } }], supervisionDigest: { doneWhen: ["d"], constraints: ["none"] } }],
      ["herdr_launch", { task: { objective: "o", scope: "s", doneWhen: ["d"], profile: "worker-pi" }, idempotencyKey: "k" }],
    ];
    for (const [name, args] of rejected) {
      const outcome = await callTool({ surface, name, args, host, callId: "c" });
      const label = `${name} ${JSON.stringify(args)}`;
      expect(outcome.isError, label).toBe(true);
      expect(payload(outcome).code, label).toBe("INVALID_INPUT");
    }
  });
});

describe("MCP argument validation", () => {
  it("accepts the no-argument form and returns bounded structured schema diagnostics", async () => {
    const { surface } = realSurface();
    const absent = await callTool({ surface, name: "herdr_status", args: undefined, host, callId: "c" });
    const nulled = await callTool({ surface, name: "herdr_status", args: null, host, callId: "c" });
    expect(absent.isError).toBeUndefined();
    expect(nulled.isError).toBeUndefined();
    expect(absent.content[0]!.text).toContain("status");

    const invalid = await callTool({ surface, name: "herdr_status", args: { eventId: "e", extra: true }, host, callId: "c" });
    expect(invalid.isError).toBe(true);
    const body = payload(invalid);
    expect(body.message).toContain(TOOL_DIAGNOSTIC_MARKER);
    expect(body.details).toMatchObject({
      tool: "herdr_status",
      schema: "herdr_status",
      code: "INVALID_INPUT",
      phase: "validate",
      errors: expect.arrayContaining([{ path: "/extra", expected: "property not allowed", received: "boolean" }]) as unknown[],
      effectCertainty: "absent",
      recoveryGuidance: TOOL_DIAGNOSTIC_RECOVERY,
    });

    const invalidRun = await callTool({ surface, name: "herdr_run", args: { action: "ack" }, host, callId: "run" });
    const runBody = payload(invalidRun);
    expect(invalidRun.isError).toBe(true);
    expect(runBody.message).toContain(TOOL_DIAGNOSTIC_MARKER);
    expect(runBody.details).toMatchObject({
      tool: "herdr_run",
      schema: "herdr_run",
      code: "INVALID_INPUT",
      phase: "validate",
      effectCertainty: "absent",
      recoveryGuidance: TOOL_DIAGNOSTIC_RECOVERY,
    });
  });

  /**
   * Schema bounds and size bounds are deliberately separate authorities. A
   * per-field `maxLength` in the public schema would fail an oversized field as
   * `INVALID_INPUT` during MCP validation, so Task text stays unbounded there.
   * An oversized Task is instead refused deterministically by the daemon's
   * supervision assignment-budget preflight (`ASSIGNMENT_OVER_BUDGET`), which
   * runs before the rendered-payload `MESSAGE_TOO_LARGE` check — this layer
   * only proves the schema admits the oversized text and forwards it.
   */
  it("splits schema label bounds from the daemon's assignment-budget refusal", async () => {
    const { surface, calls } = realSurface();
    const definition = surface.definitions.find((candidate) => candidate.name === "herdr_launch")!;
    const multiLineLabel = { task: { objective: "o", scope: "s", doneWhen: ["d"], label: "a\nb" }, idempotencyKey: "k" };
    expect(Value.Check(publishedInputSchema(definition.parameters) as unknown as TSchema, multiLineLabel)).toBe(false);
    expect(Value.Check(definition.parameters, multiLineLabel)).toBe(false);
    const labelOutcome = await callTool({ surface, name: "herdr_launch", args: multiLineLabel, host, callId: "c" });
    expect(labelOutcome.isError).toBe(true);
    expect(payload(labelOutcome).code).toBe("INVALID_INPUT");
    expect(calls).toEqual([]);

    const oversizedTask = {
      task: { objective: "x".repeat(1024 * 1024 + 1), scope: "s", doneWhen: ["The oversized task body is rejected."] },
      idempotencyKey: "k"
    };
    // Task text remains intentionally unbounded at the schema layer; the
    // daemon-side assignment-budget preflight owns this rejection.
    expect(Value.Check(publishedInputSchema(definition.parameters) as unknown as TSchema, oversizedTask)).toBe(true);
    expect(Value.Check(definition.parameters, oversizedTask)).toBe(true);
    const outcome = await callTool({ surface, name: "herdr_launch", args: oversizedTask, host, callId: "c" });
    expect(outcome.isError).toBeUndefined();
    expect(calls).toEqual([{ method: "launch", params: oversizedTask }]);
  });

  it("rejects invalid arguments for every tool before the daemon is touched", async () => {
    const { surface, calls } = realSurface();
    const rejected: Array<[string, unknown]> = [
      ["herdr_status", { eventId: 3 }],
      ["herdr_run", { action: "observe" }],
      ["herdr_run", { action: "ack" }],
      ["herdr_run", { operation: "list" }],
      ["herdr_launch", { task: { objective: "o", scope: "s", doneWhen: ["d"] } }],
      ["herdr_launch", { name: "worker", specs: [{ label: "worker" }], idempotencyKey: "k" }],
    ];
    for (const [name, args] of rejected) {
      const outcome = await callTool({ surface, name, args, host, callId: "c" });
      expect(outcome.isError).toBe(true);
      expect(payload(outcome).code).toBe("INVALID_INPUT");
    }
    expect(calls).toEqual([]);
    const accepted = await callTool({ surface, name: "herdr_status", args: {}, host, callId: "c" });
    expect(accepted.isError).toBeUndefined();
  });

  it("raises MethodNotFound for an unknown tool name", async () => {
    const { surface } = realSurface();
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
    const details = { operation: "jobs", kind: "list", operation_phase: "running", jobs: [{ jobId: "job_1", operation_phase: "running" }] };
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

  it("publishes daemon reply evidence exactly once", async () => {
    // The three tools already publish the daemon's reply as their sole JSON
    // block, so the adapter appends no second copy.
    const { surface } = realSurface({ status: { kind: "status", daemon: { status: "running" }, unread: { count: 0, ids: [] } } });
    const outcome = await callTool({ surface, name: "herdr_status", args: {}, host, callId: "c" });
    expect(outcome.content).toHaveLength(1);
    expect(outcome.content[0]!.text).not.toContain(HERDR_DETAILS_LABEL);
    expect(JSON.parse(outcome.content[0]!.text)).toMatchObject({ kind: "status", daemon: { status: "running" } });
  });

  it("bounds oversized details to a parseable truncation envelope inside the response bound", async () => {
    const outcome = await call(stub({
      execute: async () => ({ content: [{ type: "text", text: "shared" }], details: { blob: "d".repeat(200_000) } })
    }));
    expect(outcome.content[0]!.text).toBe("shared");
    const envelope = detailsOf(outcome) as { truncated: boolean; originalBytes: number; preview: string };
    expect(envelope.truncated).toBe(true);
    expect(envelope.originalBytes).toBe(Buffer.byteLength(JSON.stringify({ blob: "d".repeat(200_000) }), "utf8"));
    expect(envelope.preview.startsWith('{"blob":"ddd')).toBe(true);
    expect(outcomeBytes(outcome)).toBeLessThanOrEqual(MCP_RESULT_MAX_BYTES);

    // A multi-byte payload keeps the same guarantee: parseable JSON, no split
    // code point, and no replacement character anywhere in the block.
    const multibyte = await call(stub({ execute: async () => ({ content: [], details: { blob: "🐑".repeat(40_000) } }) }));
    const multibyteEnvelope = detailsOf(multibyte) as { truncated: boolean; preview: string };
    expect(multibyteEnvelope.truncated).toBe(true);
    expect(multibyteEnvelope.preview.startsWith('{"blob":"🐑')).toBe(true);
    expect(multibyte.content[0]!.text).not.toContain("�");
    expect(outcomeBytes(multibyte)).toBeLessThanOrEqual(MCP_RESULT_MAX_BYTES);
  });

  it("keeps a complete all-child launch manifest when verbose details exceed the bound", async () => {
    // The uniform launch result contract: the compact manifest leads the
    // content so a bounded response can never masquerade as a smaller fan-out.
    const names = Array.from({ length: 20 }, (_, index) => `task-abcd1234-${index + 1}`);
    const manifest = [
      `herdr_launch outcome=launched launch=abcd1234-0000-0000-0000-000000000000 tier=standard children=${names.length}`,
      ...names.map((name, index) => `- ${name} state=launched point=pi:pi-model:low supervisor=job-${index + 1}`)
    ].join("\n");
    const details = {
      kind: "launch",
      outcome: "launched",
      launchId: "abcd1234-0000-0000-0000-000000000000",
      requestedTier: "standard",
      effectiveTier: "standard",
      children: names.map((name, index) => ({
        target: name,
        state: "launched",
        operatingPointId: "pi:pi-model:low",
        supervisorJobId: `job-${index + 1}`,
        details: { operation: "launch", outcome: "launched", paneId: `w1:p${index + 10}`, supervision: { jobId: `job-${index + 1}` }, postState: { blob: "x".repeat(4_000) } }
      }))
    };
    const outcome = await call(stub({ execute: async () => ({ content: [{ type: "text", text: manifest }], details }) }));
    // Every expanded child is still named in the leading block, verbatim.
    expect(outcome.content[0]!.text).toBe(manifest);
    for (const name of names) expect(outcome.content[0]!.text).toContain(name);
    const envelope = detailsOf(outcome) as { truncated: boolean };
    expect(envelope.truncated).toBe(true);
    expect(outcomeBytes(outcome)).toBeLessThanOrEqual(MCP_RESULT_MAX_BYTES);
  });

  it("keeps every details block parseable at and around the block boundary", async () => {
    // The details budget is the response bound minus the shared blocks and the
    // block prefix, so these cases straddle the exact byte where the adapter
    // switches from the full value to the envelope.
    for (const size of [MCP_RESULT_MAX_BYTES - 200, MCP_RESULT_MAX_BYTES - 30, MCP_RESULT_MAX_BYTES - 14, MCP_RESULT_MAX_BYTES - 13, MCP_RESULT_MAX_BYTES, MCP_RESULT_MAX_BYTES + 1]) {
      const details = { blob: "x".repeat(size) };
      const outcome = await call(stub({ execute: async () => ({ content: [], details }) }));
      const parsed = detailsOf(outcome) as Record<string, unknown>;
      expect(typeof parsed, String(size)).toBe("object");
      expect(parsed.blob === details.blob || parsed.truncated === true, String(size)).toBe(true);
      expect(outcomeBytes(outcome), String(size)).toBeLessThanOrEqual(MCP_RESULT_MAX_BYTES);
    }
  });

  it("publishes a cyclic, hostile, or unserializable details object as parseable JSON", async () => {
    const cyclic: Record<string, unknown> = { operation: "inspect", nested: { deep: [] as unknown[] } };
    cyclic.self = cyclic;
    (cyclic.nested as { deep: unknown[] }).deep.push(cyclic);
    const outcome = await call(stub({ execute: async () => ({ content: [], details: cyclic }) }));
    expect(detailsOf(outcome)).toEqual({ operation: "inspect", nested: { deep: ["[cyclic]"] }, self: "[cyclic]" });

    const hostile = await call(stub({
      execute: async () => ({ content: [], details: { count: 10n, broken: Number.POSITIVE_INFINITY, hidden: () => undefined, list: [undefined, () => undefined], when: new Date("2026-08-17T00:00:00.000Z") } })
    }));
    expect(detailsOf(hostile)).toEqual({ count: "10", broken: null, list: [null, null], when: "2026-08-17T00:00:00.000Z" });

    let deep: Record<string, unknown> = { end: true };
    for (let level = 0; level < 200; level += 1) deep = { level, deep };
    const nested = await call(stub({ execute: async () => ({ content: [], details: deep }) }));
    expect(JSON.stringify(detailsOf(nested))).toContain("[depth limit]");
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

  it("preserves the structured launch diagnostic in model-visible error content", async () => {
    const diagnostic = { code: "LAUNCH_FAILED", phase: "ready", created: { paneId: "w:p2" }, agentStarted: true, promptSubmitted: false, recipientRegistered: false, effectCertainty: "unknown", recoveryGuidance: LAUNCH_RECOVERY_GUIDANCE.inspectBeforeRetry };
    const message = `Launch did not complete: readiness failed\n${LAUNCH_DIAGNOSTIC_MARKER} ${JSON.stringify(diagnostic)}`;
    const outcome = await call(stub({ execute: async () => { throw Object.assign(new Error(message), { code: "LAUNCH_FAILED", details: { effectCertainty: "unknown" } }); } }));
    const body = payload(outcome);
    expect(body.message).toContain(LAUNCH_DIAGNOSTIC_MARKER);
    const markerOffset = String(body.message).indexOf(LAUNCH_DIAGNOSTIC_MARKER);
    expect(JSON.parse(String(body.message).slice(markerOffset + LAUNCH_DIAGNOSTIC_MARKER.length + 1))).toEqual(diagnostic);
    expect(body.details).toEqual({ effectCertainty: "unknown" });
  });

  it("projects launch failures from the fixed diagnostic and never publishes attached cause evidence", async () => {
    const diagnostic = {
      code: "LAUNCH_FAILED",
      phase: "agent_start",
      created: { tabId: "w:t2", paneId: "w:p2", agentId: "agent-2" },
      agentStarted: true,
      promptSubmitted: false,
      recipientRegistered: false,
      effectCertainty: "partial",
      recoveryGuidance: LAUNCH_RECOVERY_GUIDANCE.inspectBeforeRetry
    };
    const hostile = ["cause-secret", "cli-secret", "stderr-secret", "envelope-secret", "environment-secret", "nested-secret"];
    const outcome = await call(stub({
      name: "herdr_launch",
      execute: async () => {
        throw Object.assign(new Error(`Launch failed\n${LAUNCH_DIAGNOSTIC_MARKER} ${JSON.stringify(diagnostic)}`), {
          code: "LAUNCH_FAILED",
          details: {
            causeMessage: hostile[0],
            cliFailure: { message: hostile[1], details: { stderr: hostile[2], errorEnvelope: { error: { message: hostile[3] } } } },
            environment: { SECRET: hostile[4] },
            nested: { details: { secret: hostile[5] } }
          }
        });
      }
    }), {}, "herdr_launch");
    expect(outcome.isError).toBe(true);
    const body = payload(outcome);
    expect(body.details).toEqual({ tool: "herdr_launch", diagnostic });
    const text = outcome.content.map((block) => block.text).join("\n");
    for (const secret of hostile) expect(text).not.toContain(secret);
    expect(text).toContain('"phase":"agent_start"');
    expect(text).toContain('"created":{"tabId":"w:t2","paneId":"w:p2","agentId":"agent-2"}');
    expect(text).toContain('"effectCertainty":"partial"');
    expect(text).toContain(LAUNCH_RECOVERY_GUIDANCE.inspectBeforeRetry);
  });

  it("projects a daemon-wire launch failure's certainty and surviving resources from typed details", () => {
    // The daemon's wire refusal carries only a bounded code — the typed client
    // (N3.1) projects `effectCertainty` and the surviving-resource handles
    // into `details`. Those fields publish here whether or not a diagnostic
    // exists, so a caller never sees a bare failure and relaunches into live
    // children.
    const outcome = errorOutcome(
      "LAUNCH_FAILED",
      "daemon launch call was refused",
      { effectCertainty: "unknown", paneId: "w:p9", tabId: "w:t9", supervisorJobId: "job_9", causeMessage: "wire-secret", diagnostic: { garbage: "attached-secret" } },
      "herdr_launch"
    );
    expect(payload(outcome).details).toEqual({
      tool: "herdr_launch",
      paneId: "w:p9",
      tabId: "w:t9",
      supervisorJobId: "job_9",
      effectCertainty: "unknown"
    });
    const text = outcome.content[0]!.text;
    expect(text).not.toContain("wire-secret");
    expect(text).not.toContain("attached-secret");
  });

  it("keeps the launcher effect certainty visible when no diagnostic record exists", () => {
    // The fail-closed wire path: a refusal that cannot prove the launch had no
    // effect must still surface `unknown` — never a bare failure that reads
    // like a safe retry.
    const outcome = errorOutcome("LAUNCH_FAILED", "daemon launch call was refused", { effectCertainty: "unknown" }, "herdr_launch");
    expect(payload(outcome).details).toEqual({ tool: "herdr_launch", effectCertainty: "unknown" });
  });

  it("publishes the complete assignment-unconfirmed diagnostic without attached launch evidence", () => {
    const diagnostic = {
      code: "LAUNCH_FAILED",
      phase: "prompt_verification",
      created: { tabId: "w:t2" },
      paneId: "w:p2",
      supervisorJobId: "job_supervisor_2",
      assignmentState: "unconfirmed",
      agentStarted: true,
      promptSubmitted: true,
      recipientRegistered: false,
      effectCertainty: "partial",
      recoveryGuidance: LAUNCH_RECOVERY_GUIDANCE.preserveUnconfirmed
    };
    const secrets = ["private-prompt", "environment-secret", "backend-secret", "session-secret"];
    const outcome = errorOutcome(
      "LAUNCH_FAILED",
      `Launch failed; inspect the structured diagnostic\n${LAUNCH_DIAGNOSTIC_MARKER} ${JSON.stringify(diagnostic)}`,
      { prompt: secrets[0], environment: secrets[1], causeMessage: secrets[2], agentSession: secrets[3] },
      "herdr_launch"
    );
    expect(payload(outcome).details).toEqual({ tool: "herdr_launch", diagnostic });
    const text = outcome.content.map((block) => block.text).join("\n");
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(Buffer.byteLength(JSON.stringify(diagnostic), "utf8")).toBeLessThan(8_192);
  });

  it("retains only verified launch recovery handles when projecting an unknown prompt", () => {
    const diagnostic = {
      code: "LAUNCH_FAILED",
      phase: "prompt_verification",
      created: { paneId: "w:p2" },
      paneId: "w:p2",
      supervisorJobId: "job_supervisor_2",
      assignmentState: "unconfirmed",
      agentStarted: true,
      promptSubmitted: false,
      recipientRegistered: false,
      effectCertainty: "unknown",
      recoveryGuidance: LAUNCH_RECOVERY_GUIDANCE.preserveUnconfirmed
    };
    const attachment = { attachmentId: "attachment-1", path: "/cache/recipient/attachment-1/body.txt", bytes: 17, sha256: "a".repeat(64), expiresAt: "2026-08-21T12:00:00.000Z", recipientPaneId: "w:p2" };
    const outcome = errorOutcome(
      "LAUNCH_FAILED",
      `failure\n${LAUNCH_DIAGNOSTIC_MARKER} ${JSON.stringify(diagnostic)}`,
      {
        paneId: "w:p2",
        supervisorJobId: "job_supervisor_2",
        promptDispatch: { state: "unknown", requestId: "request-17" },
        attachmentRetained: true,
        attachment,
        causeMessage: "private prompt body",
        recipientGrant: { path: "/cache/recipient" }
      },
      "herdr_launch"
    );
    expect(payload(outcome).details).toEqual({
      tool: "herdr_launch",
      diagnostic,
      paneId: "w:p2",
      supervisorJobId: "job_supervisor_2",
      promptDispatch: { state: "unknown", requestId: "request-17" },
      attachmentRetained: true,
      attachment
    });
    expect(outcome.content[0]!.text).not.toContain("private prompt body");
    expect(outcome.content[0]!.text).not.toContain("recipientGrant");
  });

  it("omits absent optional launch recovery identifiers", () => {
    const diagnostic = {
      code: "LAUNCH_FAILED",
      phase: "prompt_verification",
      created: { paneId: "w:p2" },
      agentStarted: true,
      promptSubmitted: true,
      recipientRegistered: false,
      effectCertainty: "unknown",
      recoveryGuidance: LAUNCH_RECOVERY_GUIDANCE.preserveUnconfirmed
    };
    const attachment = { attachmentId: "attachment-1", path: "/cache/body.txt", bytes: 1, sha256: "a".repeat(64), expiresAt: "2026-08-21T12:00:00.000Z" };
    const outcome = errorOutcome(
      "LAUNCH_FAILED",
      `failure\n${LAUNCH_DIAGNOSTIC_MARKER} ${JSON.stringify(diagnostic)}`,
      { promptDispatch: { state: "acknowledged" }, attachmentRetained: true, attachment },
      "herdr_launch"
    );
    expect(payload(outcome).details).toEqual({ tool: "herdr_launch", diagnostic, promptDispatch: { state: "acknowledged" }, attachmentRetained: true, attachment });

    const invalidAttachment = errorOutcome(
      "LAUNCH_FAILED",
      `failure\n${LAUNCH_DIAGNOSTIC_MARKER} ${JSON.stringify(diagnostic)}`,
      { attachment: { ...attachment, bytes: 0 } },
      "herdr_launch"
    );
    expect(payload(invalidAttachment).details).toEqual({ tool: "herdr_launch", diagnostic });
  });

  it("rejects malformed launch diagnostics instead of publishing arbitrary attached data", () => {
    const base = { phase: "agent_start", created: {}, agentStarted: true, promptSubmitted: false, recipientRegistered: false, effectCertainty: "partial", recoveryGuidance: LAUNCH_RECOVERY_GUIDANCE.inspectBeforeRetry };
    const messages = [
      "plain failure",
      `failure\n${LAUNCH_DIAGNOSTIC_MARKER} {`,
      `failure\n${LAUNCH_DIAGNOSTIC_MARKER} "scalar"`,
      `failure\n${LAUNCH_DIAGNOSTIC_MARKER} ${JSON.stringify({ ...base, phase: "not-a-phase" })}`,
      `failure\n${LAUNCH_DIAGNOSTIC_MARKER} ${JSON.stringify({ ...base, effectCertainty: "not-a-certainty" })}`,
      `failure\n${LAUNCH_DIAGNOSTIC_MARKER} ${JSON.stringify({ ...base, recoveryGuidance: "not-guidance" })}`,
      `failure\n${LAUNCH_DIAGNOSTIC_MARKER} ${JSON.stringify({ ...base, agentStarted: "yes" })}`,
      `failure\n${LAUNCH_DIAGNOSTIC_MARKER} ${JSON.stringify({ ...base, created: null })}`,
      `failure\n${LAUNCH_DIAGNOSTIC_MARKER} ${JSON.stringify({ ...base, paneId: "w:p2" })}`,
      `failure\n${LAUNCH_DIAGNOSTIC_MARKER} ${JSON.stringify({ ...base, supervisorJobId: "job_2" })}`,
      `failure\n${LAUNCH_DIAGNOSTIC_MARKER} ${JSON.stringify({ ...base, assignmentState: "unconfirmed" })}`,
      `failure\n${LAUNCH_DIAGNOSTIC_MARKER} ${JSON.stringify({ ...base, paneId: "w:p2", supervisorJobId: "job_2" })}`,
      `failure\n${LAUNCH_DIAGNOSTIC_MARKER} ${JSON.stringify({ ...base, paneId: "w:p2", assignmentState: "unconfirmed" })}`,
      `failure\n${LAUNCH_DIAGNOSTIC_MARKER} ${JSON.stringify({ ...base, supervisorJobId: "job_2", assignmentState: "unconfirmed" })}`,
      `failure\n${LAUNCH_DIAGNOSTIC_MARKER} ${JSON.stringify({ ...base, paneId: "w:p2", supervisorJobId: "job_2", assignmentState: "confirmed" })}`,
      `failure\n${LAUNCH_DIAGNOSTIC_MARKER} ${JSON.stringify({ ...base, paneId: "", supervisorJobId: "job_2", assignmentState: "unconfirmed" })}`,
      `failure\n${LAUNCH_DIAGNOSTIC_MARKER} ${JSON.stringify({ ...base, paneId: "w:p2", supervisorJobId: "job\n2", assignmentState: "unconfirmed" })}`
    ];
    for (const message of messages) {
      const outcome = errorOutcome("LAUNCH_FAILED", message, { secret: "must-not-publish" }, "herdr_launch");
      expect(payload(outcome).details).toEqual({ tool: "herdr_launch" });
      expect(outcome.content[0]!.text).not.toContain("must-not-publish");
    }
    const unsafeId = errorOutcome("LAUNCH_FAILED", `failure\n${LAUNCH_DIAGNOSTIC_MARKER} ${JSON.stringify({ ...base, created: { paneId: "\u0000" } })}`, undefined, "herdr_launch");
    expect(payload(unsafeId).details).toEqual({ tool: "herdr_launch", diagnostic: { ...base, code: "LAUNCH_FAILED" } });
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

  it("bounds a hostile failure message, code, and details without dropping the typed head", async () => {
    const outcome = await call(stub({
      execute: async () => { throw Object.assign(new Error(`line\none${"m".repeat(5_000)}`), { code: `WEIRD\nCODE${"x".repeat(500)}`, details: { blob: "d".repeat(200_000) } }); }
    }));
    const text = outcome.content[0]!.text;
    const body = payload(outcome) as { code: string; message: string; details: { truncated: boolean; originalBytes: number; preview: string } };
    expect(body.code).toBe(`WEIRD CODE${"x".repeat(110)}`);
    expect(body.message).toBe(`line one${"m".repeat(1_992)}`);
    // The evidence is bounded as a value, so the whole block stays parseable and
    // the truncation is stated instead of implied by a cut string.
    expect(body.details.truncated).toBe(true);
    expect(body.details.originalBytes).toBe(Buffer.byteLength(JSON.stringify({ blob: "d".repeat(200_000) }), "utf8"));
    expect(body.details.preview.startsWith('{"blob":"ddd')).toBe(true);
    expect(text).not.toContain("\n");
    expect(outcomeBytes(outcome)).toBeLessThanOrEqual(MCP_RESULT_MAX_BYTES);

    const multibyte = await call(stub({
      execute: async () => { throw Object.assign(new Error("CLI_TIMEOUT: read failed"), { code: "CLI_TIMEOUT", details: { stdout: "🐑".repeat(40_000) } }); }
    }));
    const multibyteBody = payload(multibyte) as { code: string; details: { preview: string } };
    expect(multibyteBody.code).toBe("CLI_TIMEOUT");
    expect(multibyteBody.details.preview).not.toContain("�");
    expect(outcomeBytes(multibyte)).toBeLessThanOrEqual(MCP_RESULT_MAX_BYTES);

    const cyclic: Record<string, unknown> = { target: "w:p2" };
    cyclic.self = cyclic;
    const cyclicOutcome = await call(stub({ execute: async () => { throw Object.assign(new Error("CLI_PROTOCOL_ERROR: bad"), { code: "CLI_PROTOCOL_ERROR", details: cyclic }); } }));
    expect(payload(cyclicOutcome)).toEqual({ code: "CLI_PROTOCOL_ERROR", message: "CLI_PROTOCOL_ERROR: bad", details: { target: "w:p2", self: "[cyclic]" } });
  });

  it("redacts environment values carried by a thrown error at every depth", async () => {
    const outcome = await call(stub({
      execute: async () => {
        throw Object.assign(new Error("CLI_PROTOCOL_ERROR: pane read failed"), {
          code: "CLI_PROTOCOL_ERROR",
          details: { target: "w:p2", pane: { pane_id: "w:p2", environment: { SECRET: "error-secret" } }, history: [{ env_vars: { VAR: "error-secret" } }] }
        });
      }
    }));
    expect(payload(outcome)).toEqual({
      code: "CLI_PROTOCOL_ERROR",
      message: "CLI_PROTOCOL_ERROR: pane read failed",
      details: { target: "w:p2", pane: { pane_id: "w:p2" }, history: [{}] }
    });
    expect(outcome.content[0]!.text).not.toContain("error-secret");
  });

  it("hands the request cancellation signal to the shared tool", async () => {
    const controller = new AbortController();
    const execute = vi.fn(async (_id: string, _args: unknown, signal: AbortSignal | undefined) => {
      expect(signal).toBe(controller.signal);
      return { content: [{ type: "text" as const, text: "ok" }], details: undefined };
    });
    await callTool({ surface: stub({ execute }), name: "herdr_status", args: {}, host: { cwd: "/project", signal: controller.signal }, callId: "c" });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

/**
 * Pane records may carry environment values the owner supplied for a child
 * process. They are authoritative evidence for the owner, never model-visible
 * content, so every projection this adapter publishes must strip them at every
 * nesting depth while keeping the typed evidence a manager needs.
 */
const SENTINELS = ["pane-secret", "upper-secret", "env-secret", "vars-secret", "variables-secret", "overrides-secret", "array-secret", "deep-secret"];

function leakyPane(paneId: string, label: string, status = "idle", withIdentity = false): Record<string, unknown> {
  return {
    pane_id: paneId,
    tab_id: "w:t",
    workspace_id: "w",
    label,
    agent_name: label,
    ...(withIdentity ? { agent: "pi", terminal_id: `term-${paneId}`, agent_session: { source: "pi", agent: "pi", kind: "id", value: `${paneId}-session` } } : {}),
    agent_status: status,
    environment: { SECRET: "pane-secret" },
    ENVIRONMENT: { SECRET: "upper-secret" },
    env: { SECRET: "env-secret" },
    env_vars: { SECRET: "vars-secret" },
    environment_variables: { SECRET: "variables-secret" },
    environment_overrides: { SECRET: "overrides-secret" },
    history: [{ env: { SECRET: "array-secret" } }, { child: { grandchild: { environment: { SECRET: "deep-secret" } } } }]
  };
}

describe("MCP model-boundary redaction", () => {
  it("strips environment values from a raw record nested in an arbitrary details projection", async () => {
    const outcome = await call(stub({
      execute: async () => ({
        content: [{ type: "text", text: "inspected" }],
        details: { operation: "inspect", metadata: leakyPane("w:p2", "worker"), snapshots: [{ metadata: leakyPane("w:p3", "other") }], postState: { pane: leakyPane("w:p4", "launched") } }
      })
    }));
    const text = outcome.content.map((block) => block.text).join("\n");
    for (const sentinel of SENTINELS) expect(text, sentinel).not.toContain(sentinel);
    expect(detailsOf(outcome)).toEqual({
      operation: "inspect",
      metadata: { pane_id: "w:p2", tab_id: "w:t", workspace_id: "w", label: "worker", agent_name: "worker", agent_status: "idle", history: [{}, { child: { grandchild: {} } }] },
      snapshots: [{ metadata: { pane_id: "w:p3", tab_id: "w:t", workspace_id: "w", label: "other", agent_name: "other", agent_status: "idle", history: [{}, { child: { grandchild: {} } }] } }],
      postState: { pane: { pane_id: "w:p4", tab_id: "w:t", workspace_id: "w", label: "launched", agent_name: "launched", agent_status: "idle", history: [{}, { child: { grandchild: {} } }] } }
    });
  });
});

describe("MCP turn-control redaction", () => {
  it("redacts environment-shaped turn evidence before publication", async () => {
    const outcome = await call(stub({
      execute: async () => ({
        content: [{ type: "text", text: "cancelled" }],
        details: {
          operation: "cancel",
          outcome: "cancelled",
          preEvidence: { pane_id: "p1", agent_status: "working", environment: { SECRET: "turn-secret" } },
          finalEvidence: { pane_id: "p1", agent_status: "idle", history: [{ env_vars: { SECRET: "nested-turn-secret" } }] }
        }
      })
    }));
    const text = outcome.content.map((block) => block.text).join("\n");
    expect(text).not.toContain("turn-secret");
    expect(text).not.toContain("nested-turn-secret");
    expect(text).toContain("agent_status");
  });
});
