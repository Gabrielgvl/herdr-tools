import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "typebox";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { HerdrCli, type PiExec } from "../../src/cli.js";
import { JobRegistry } from "../../src/job-registry.js";
import { RuntimeOwnership } from "../../src/ownership.js";
import { createPreflight, createToolSurface, CORE_TOOL_NAMES, type HerdrToolDefinition } from "../../src/tool-surface.js";
import { AdapterContractError, HERDR_DETAILS_LABEL, MCP_RESULT_MAX_BYTES, callTool, describeTools, errorOutcome, publishedInputSchema, type McpCallOutcome } from "../../src/mcp/adapter.js";
import { HostCapabilityError } from "../../src/mcp/host.js";
import { SequentialToolQueue } from "../../src/mcp/queue.js";
import { CommunicateParamsSchema } from "../../src/schemas.js";
import { LAUNCH_DIAGNOSTIC_MARKER, LAUNCH_RECOVERY_GUIDANCE } from "../../src/tools/launch.js";
import { stubSupervision } from "./supervision-fixtures.js";

const health = { client: { version: "0.8.0", protocol: 22 }, server: { status: "running", version: "0.8.0", protocol: 22, compatible: true } };
const snapshot = {
  type: "session_snapshot",
  snapshot: {
    version: "1",
    protocol: 1,
    workspaces: [{ workspace_id: "w", label: "w" }],
    tabs: [{ tab_id: "w:t", workspace_id: "w", label: "t" }],
    panes: [{ pane_id: "w:p", tab_id: "w:t", workspace_id: "w", label: "caller", agent_name: "caller", agent: "pi", terminal_id: "term-caller", agent_session: { source: "pi", agent: "pi", kind: "id", value: "caller-session" }, agent_status: "idle" }],
    agents: [{ pane_id: "w:p", name: "caller", agent: "pi", terminal_id: "term-caller", agent_session: { source: "pi", agent: "pi", kind: "id", value: "caller-session" }, agent_status: "idle" }]
  }
};

function realSurface() {
  const exec: PiExec = async (_command, argv) => {
    if (argv[0] === "status") return { stdout: JSON.stringify(health), stderr: "", code: 0, killed: false };
    if (argv[0] === "pane" && argv[1] === "current") return { stdout: JSON.stringify({ id: "current", result: { type: "pane_current", pane: snapshot.snapshot.panes[0] } }), stderr: "", code: 0, killed: false };
    if (argv[0] === "api") return { stdout: JSON.stringify({ id: "snapshot", result: snapshot }), stderr: "", code: 0, killed: false };
    if (argv[0] === "agent" && argv[1] === "wait") return { stdout: JSON.stringify({ id: "agent-wait", result: { agent: snapshot.snapshot.panes.find((pane) => pane.pane_id === argv[2]) } }), stderr: "", code: 0, killed: false };
    if (argv[0] === "agent" && argv[1] === "get") return { stdout: JSON.stringify({ id: "agent-get", result: { agent: snapshot.snapshot.panes.find((pane) => pane.pane_id === argv[2]) } }), stderr: "", code: 0, killed: false };
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
    supervision: stubSupervision(),
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
  return callTool({ surface, name, args, host, callId: "call-1", queue: new SequentialToolQueue() });
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

  it("publishes herdr_launch as a flat object root with every variant field optional", () => {
    const definition = realSurface().definitions.find((candidate) => candidate.name === "herdr_launch")!;
    const published = publishedInputSchema(definition.parameters) as { type: string; properties: Record<string, unknown>; required?: unknown; anyOf?: unknown; additionalProperties?: unknown };
    expect(published.type).toBe("object");
    expect(published.anyOf).toBeUndefined();
    // Every field is optional at publication; validateParams stays the
    // enforcement authority for the variant rules the union expressed.
    expect(published.required).toBeUndefined();
    expect(published.additionalProperties).toBe(false);
    for (const field of ["name", "profile", "overrides", "placement", "label", "cwd", "focus", "assignment", "assignmentDelivery", "supervisionDigest"]) {
      expect(published.properties).toHaveProperty(field);
    }
  });

  // Regression coverage for the incident where the pi harness dropped every
  // argument of a tool whose declared parameters were a root Type.Union — calls
  // arrived as {} — so every tool now publishes a flat object root, never a
  // union. The union schemas remain each tool's internal runtime contract.
  for (const name of CORE_TOOL_NAMES) {
    it(`${name} publishes a flat object root, never a union`, () => {
      const definition = realSurface().definitions.find((candidate) => candidate.name === name)!;
      const schema = definition.parameters as Record<string, unknown>;
      expect(schema.type).toBe("object");
      expect(schema.anyOf).toBeUndefined();
      expect(schema.oneOf).toBeUndefined();
      const published = publishedInputSchema(definition.parameters) as Record<string, unknown>;
      expect(published.anyOf).toBeUndefined();
      expect(published.oneOf).toBeUndefined();
    });
  }

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
    expect(descriptors[0]!.inputSchema).toMatchObject({ properties: expect.any(Object) as unknown as Record<string, unknown> });
    expect(descriptors.every((descriptor) => !("anyOf" in descriptor.inputSchema))).toBe(true);
  });
});

describe("MCP published schema parity", () => {
  it("publishes each shared schema unchanged except for the object root MCP requires", () => {
    for (const definition of realSurface().definitions) {
      const source = JSON.parse(JSON.stringify(definition.parameters)) as Record<string, unknown>;
      // Publication may only add the root `type`; it can never drop or loosen a
      // keyword, so the published document cannot accept more than validation.
      expect(publishedInputSchema(definition.parameters)).toEqual({ ...source, type: "object" });
    }
  });

  it("admits every variant-shaped call at the flat root while keeping strict keys and field types", () => {
    const surface = realSurface();
    // The flat publication deliberately accepts missing required fields and
    // cross-variant fields — the tools' runtime validation owns the union
    // contract now — but it still rejects undeclared keys and mistyped values.
    const cases: Array<[string, unknown, boolean]> = [
      ["herdr_inspect", {}, true],
      ["herdr_inspect", { mode: "context" }, true],
      ["herdr_inspect", { mode: "health" }, true],
      ["herdr_inspect", { mode: "target", target: "w:p2" }, true],
      ["herdr_inspect", { mode: "collection", collection: "panes" }, true],
      ["herdr_inspect", { mode: "collection", collection: "profiles" }, true],
      ["herdr_inspect", { mode: "profile", profile: "worker-pi" }, true],
      ["herdr_inspect", { mode: "context", collection: "panes" }, true],
      ["herdr_inspect", { mode: "context", profile: "worker-pi" }, true],
      ["herdr_inspect", { mode: "context", target: "w:p2" }, true],
      ["herdr_inspect", { mode: "health", target: "w:p2" }, true],
      ["herdr_inspect", { mode: "collection", collection: "panes", profile: "worker-pi" }, true],
      ["herdr_inspect", { mode: "target" }, true],
      ["herdr_inspect", { mode: "profile" }, true],
      ["herdr_inspect", { mode: "bogus" }, false],
      ["herdr_inspect", { collection: "panes" }, true],
      ["herdr_inspect", { mode: "context", extra: true }, false],
      ["herdr_communicate", { target: "w:p2", operation: "prompt", text: "hi" }, true],
      ["herdr_communicate", { target: "w:p2", operation: "prompt" }, true],
      ["herdr_communicate", { target: "w:p2", operation: "cancel" }, true],
      ["herdr_communicate", { target: "w:p2", operation: "interrupt" }, true],
      ["herdr_communicate", { target: "w:p2", operation: "keys", keys: ["escape"] }, true],
      ["herdr_communicate", { target: "w:p2", operation: "keys", keys: ["not-a-supported-key"] }, false],
      ["herdr_communicate", { target: "w:p2", operation: "cancel", extra: true }, false],
      ["herdr_communicate", { target: "w:p2", operation: "prompt", text: "hi", keys: ["enter"] }, true],
      ["herdr_communicate", { target: "w:p2", operation: "keys", keys: ["enter"], text: "hi" }, true],
      ["herdr_jobs", { operation: "list" }, true],
      ["herdr_jobs", { operation: "list", jobId: "job_1" }, true],
      ["herdr_jobs", { operation: "get", jobId: "job_1", status: "running" }, false],
      ["herdr_pane", { operation: "focus", target: "w:p2" }, true],
      ["herdr_pane", { operation: "focus", target: "w:p2", label: "worker" }, true],
      ["herdr_pane", { operation: "split", direction: "left" }, true],
      ["herdr_tab", { operation: "focus", target: "w:t" }, true],
      ["herdr_tab", { operation: "focus", target: "w:t", label: "review" }, true],
      ["herdr_wait", { targets: ["w:p2"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 5 }, true],
      ["herdr_wait", { targets: ["w:p2"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 5, runInBackground: true }, false],
      ["herdr_wait", { targets: ["w:p2"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 5, runInBackground: false }, false],
      ["herdr_wait", { targets: ["w:p2"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 5, extra: true }, false],
      ["herdr_launch", { name: "worker", profile: "worker-pi", assignment: { objective: "o", scope: "s", verification: "v" }, supervisionDigest: { doneWhen: ["o done"], constraints: ["none"] } }, true],
      ["herdr_launch", { name: "worker", profile: "worker-pi", assignment: { objective: "o", scope: "s", verification: "v" }, supervisionDigest: { doneWhen: ["o done"], constraints: ["none"] }, extra: true }, false],
      // The typed assignment and the supervision digest are both required, but
      // only at runtime: the flat root publishes them as optional.
      ["herdr_launch", { name: "worker", profile: "worker-pi" }, true],
      ["herdr_launch", { name: "worker", profile: "worker-pi", supervisionDigest: { doneWhen: ["o done"], constraints: ["none"] } }, true],
      ["herdr_launch", { name: "worker", profile: "worker-pi", assignment: { objective: "o", scope: "s", verification: "v" } }, true],
      ["herdr_launch", { name: "worker", profile: "worker-pi", assignment: { objective: "o", scope: "s" }, supervisionDigest: { doneWhen: ["o done"], constraints: ["none"] } }, true],
      ["herdr_launch", { name: "worker", profile: "worker-pi", assignment: { objective: "", scope: "s", verification: "v" }, supervisionDigest: { doneWhen: ["o done"], constraints: ["none"] } }, false],
      ["herdr_launch", { name: "worker", profile: "worker-pi", assignment: { objective: "o", scope: "s", verification: "v", extra: "e" }, supervisionDigest: { doneWhen: ["o done"], constraints: ["none"] } }, false],
      ["herdr_launch", { name: "worker", profile: "worker-pi", assignment: { objective: "o", scope: "s", verification: "v" }, supervisionDigest: { doneWhen: [], constraints: ["none"] } }, false],
      ["herdr_launch", { name: "worker", profile: "worker-pi", assignment: { objective: "o", scope: "s", verification: "v" }, supervisionDigest: { doneWhen: ["o done"], constraints: [] } }, false],
      ["herdr_launch", { name: "worker", profile: "worker-pi", assignment: { objective: "o", scope: "s", verification: "v" }, supervisionDigest: { doneWhen: ["o done"] } }, false],
      ["herdr_launch", { name: "worker", profile: "worker-pi", initialPrompt: "o" }, false],
      // The auto Batch variant: an assignment and no profile. The digest is
      // required on it exactly as on the explicit variant.
      ["herdr_launch", { name: "task", assignment: { objective: "o", scope: "s", verification: "v" }, supervisionDigest: { doneWhen: ["o done"], constraints: ["none"] } }, true],
      ["herdr_launch", { name: "task", assignment: { objective: "o", scope: "s", verification: "v" }, supervisionDigest: { doneWhen: ["o done"], constraints: ["none"] }, placement: { mode: "existing_pane", target: "w:p" } }, true],
      ["herdr_launch", { name: "task", assignment: { objective: "o", scope: "s", verification: "v" } }, true],
      ["herdr_launch", { name: "task", assignment: { objective: "o", scope: "s", verification: "v" }, supervisionDigest: { doneWhen: ["o done"], constraints: ["none"] }, extra: true }, false],
      ["herdr_launch", { name: "task", assignment: { objective: "o", scope: "s", verification: "v" }, supervisionDigest: { doneWhen: ["o done"], constraints: ["none"] }, overrides: { model: "m" } }, true],
      ["herdr_launch", { name: "task", assignment: { objective: "o", scope: "s", verification: "v" }, supervisionDigest: { doneWhen: ["o done"], constraints: ["none"] }, profile: null }, false],
      ["herdr_launch", { name: "task", assignment: { objective: "o", scope: "s", verification: "v" }, supervisionDigest: { doneWhen: ["o done"], constraints: ["none"] }, profile: "" }, false],
      // A literal profile named "auto" is an ordinary explicit profile.
      ["herdr_launch", { name: "task", assignment: { objective: "o", scope: "s", verification: "v" }, supervisionDigest: { doneWhen: ["o done"], constraints: ["none"] }, profile: "auto" }, true],
      ["herdr_launch", { name: "task", profile: "worker-pi" }, true]
    ];
    for (const [name, args, accepted] of cases) {
      const definition = surface.definitions.find((candidate) => candidate.name === name)!;
      const published = publishedInputSchema(definition.parameters) as unknown as TSchema;
      const label = `${name} ${JSON.stringify(args)}`;
      expect(Value.Check(published, args), `published: ${label}`).toBe(accepted);
      expect(Value.Check(definition.parameters, args), `validation: ${label}`).toBe(accepted);
    }
  });

  it("keeps the union contract at runtime: every contract-invalid call is still INVALID_INPUT", async () => {
    const surface = realSurface();
    // Every case the union used to reject — missing required fields, mixed
    // variant fields, strict-key violations, bad value domains — still fails
    // with the same code, now enforced by each tool's own validation.
    const rejected: Array<[string, unknown]> = [
      ["herdr_inspect", { mode: "context", collection: "panes" }],
      ["herdr_inspect", { mode: "context", profile: "worker-pi" }],
      ["herdr_inspect", { mode: "context", target: "w:p2" }],
      ["herdr_inspect", { mode: "health", target: "w:p2" }],
      ["herdr_inspect", { mode: "collection", collection: "panes", profile: "worker-pi" }],
      ["herdr_inspect", { mode: "target" }],
      ["herdr_inspect", { mode: "profile" }],
      ["herdr_inspect", { mode: "bogus" }],
      ["herdr_inspect", { collection: "panes" }],
      ["herdr_inspect", { mode: "context", extra: true }],
      ["herdr_communicate", { target: "w:p2", operation: "prompt" }],
      ["herdr_communicate", { target: "w:p2", operation: "keys" }],
      ["herdr_communicate", { target: "w:p2", operation: "keys", keys: ["not-a-supported-key"] }],
      ["herdr_communicate", { target: "w:p2", operation: "cancel", text: "x" }],
      ["herdr_communicate", { target: "w:p2", operation: "cancel", extra: true }],
      ["herdr_communicate", { target: "w:p2", operation: "prompt", text: "hi", keys: ["enter"] }],
      ["herdr_communicate", { target: "w:p2", operation: "keys", keys: ["enter"], text: "hi" }],
      ["herdr_jobs", { operation: "list", jobId: "job_1" }],
      ["herdr_jobs", { operation: "get", jobId: "job_1", status: "running" }],
      ["herdr_pane", { operation: "focus", target: "w:p2", label: "worker" }],
      ["herdr_pane", { operation: "split", direction: "left" }],
      ["herdr_pane", { operation: "close" }],
      ["herdr_tab", { operation: "focus", target: "w:t", label: "review" }],
      ["herdr_wait", { targets: ["w:p2"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 5, runInBackground: true }],
      ["herdr_wait", { targets: ["w:p2"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 5, runInBackground: false }],
      ["herdr_wait", { targets: ["w:p2"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 5, extra: true }],
      ["herdr_launch", { name: "worker", profile: "worker-pi", assignment: { objective: "o", scope: "s", verification: "v" }, supervisionDigest: { doneWhen: ["o done"], constraints: ["none"] }, extra: true }],
      ["herdr_launch", { name: "worker", profile: "worker-pi" }],
      ["herdr_launch", { name: "worker", profile: "worker-pi", supervisionDigest: { doneWhen: ["o done"], constraints: ["none"] } }],
      ["herdr_launch", { name: "worker", profile: "worker-pi", assignment: { objective: "o", scope: "s", verification: "v" } }],
      ["herdr_launch", { name: "worker", profile: "worker-pi", assignment: { objective: "o", scope: "s" }, supervisionDigest: { doneWhen: ["o done"], constraints: ["none"] } }],
      ["herdr_launch", { name: "worker", profile: "worker-pi", assignment: { objective: "", scope: "s", verification: "v" }, supervisionDigest: { doneWhen: ["o done"], constraints: ["none"] } }],
      ["herdr_launch", { name: "worker", profile: "worker-pi", assignment: { objective: "o", scope: "s", verification: "v", extra: "e" }, supervisionDigest: { doneWhen: ["o done"], constraints: ["none"] } }],
      ["herdr_launch", { name: "worker", profile: "worker-pi", assignment: { objective: "o", scope: "s", verification: "v" }, supervisionDigest: { doneWhen: [], constraints: ["none"] } }],
      ["herdr_launch", { name: "worker", profile: "worker-pi", assignment: { objective: "o", scope: "s", verification: "v" }, supervisionDigest: { doneWhen: ["o done"], constraints: [] } }],
      ["herdr_launch", { name: "worker", profile: "worker-pi", assignment: { objective: "o", scope: "s", verification: "v" }, supervisionDigest: { doneWhen: ["o done"] } }],
      ["herdr_launch", { name: "worker", profile: "worker-pi", initialPrompt: "o" }],
      ["herdr_launch", { name: "task", assignment: { objective: "o", scope: "s", verification: "v" } }],
      ["herdr_launch", { name: "task", assignment: { objective: "o", scope: "s", verification: "v" }, supervisionDigest: { doneWhen: ["o done"], constraints: ["none"] }, extra: true }],
      ["herdr_launch", { name: "task", assignment: { objective: "o", scope: "s", verification: "v" }, supervisionDigest: { doneWhen: ["o done"], constraints: ["none"] }, overrides: { model: "m" } }],
      ["herdr_launch", { name: "task", assignment: { objective: "o", scope: "s", verification: "v" }, supervisionDigest: { doneWhen: ["o done"], constraints: ["none"] }, profile: null }],
      ["herdr_launch", { name: "task", assignment: { objective: "o", scope: "s", verification: "v" }, supervisionDigest: { doneWhen: ["o done"], constraints: ["none"] }, profile: "" }],
      ["herdr_launch", { name: "task", profile: "worker-pi" }]
    ];
    for (const [name, args] of rejected) {
      const outcome = await callTool({ surface, name, args, host, callId: "c", queue: new SequentialToolQueue() });
      const label = `${name} ${JSON.stringify(args)}`;
      expect(outcome.isError, label).toBe(true);
      expect(payload(outcome).code, label).toBe("INVALID_INPUT");
    }
  });
});

describe("MCP argument validation", () => {
  it("accepts the no-argument form and rejects unknown fields with bounded schema errors", async () => {
    const surface = realSurface();
    const definitions = { definitions: [...surface.definitions] };
    const absent = await callTool({ surface: definitions, name: "herdr_inspect", args: undefined, host, callId: "c", queue: new SequentialToolQueue() });
    const nulled = await callTool({ surface: definitions, name: "herdr_inspect", args: null, host, callId: "c", queue: new SequentialToolQueue() });
    expect(absent.isError).toBeUndefined();
    expect(nulled.isError).toBeUndefined();
    expect(absent.content[0]!.text).toContain("inspect");
    const invalid = await callTool({ surface: definitions, name: "herdr_inspect", args: { mode: "health", extra: true }, host, callId: "c", queue: new SequentialToolQueue() });
    expect(invalid.isError).toBe(true);
    const body = payload(invalid);
    expect(body.code).toBe("INVALID_INPUT");
    expect(body.message).toContain("herdr_inspect");
    expect((body.details as { errors: unknown[] }).errors).toHaveLength(1);
    expect((body.details as { errors: Array<Record<string, string>> }).errors[0]).toMatchObject({ keyword: expect.any(String) as unknown as string, message: expect.any(String) as unknown as string });
  });

  /**
   * The rendered assignment's UTF-8 byte length is the only size authority. A
   * per-field `maxLength` in the public schema would fail an oversized field as
   * `INVALID_INPUT` during MCP validation, before rendering, so the caller's
   * error code would depend on which limit was crossed first.
   */
  it("lets an oversized assignment field reach the launch tool and reports PAYLOAD_TOO_LARGE before mutation", async () => {
    const args = {
      name: "worker",
      profile: "worker-pi",
      assignmentDelivery: "attachment",
      assignment: { objective: "x".repeat(1024 * 1024 + 1), scope: "bounded", verification: "bounded" },
      supervisionDigest: { doneWhen: ["The oversized objective is written."], constraints: ["none"] }
    };
    const definition = realSurface().definitions.find((candidate) => candidate.name === "herdr_launch")!;
    // No schema gate on field size, so the request is not turned into INVALID_INPUT.
    expect(Value.Check(publishedInputSchema(definition.parameters) as unknown as TSchema, args)).toBe(true);
    expect(Value.Check(definition.parameters, args)).toBe(true);

    const outcome = await callTool({ surface: realSurface(), name: "herdr_launch", args, host, callId: "c", queue: new SequentialToolQueue() });
    expect(outcome.isError).toBe(true);
    expect(payload(outcome)).toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      details: {
        tool: "herdr_launch",
        diagnostic: { code: "PAYLOAD_TOO_LARGE", phase: "validate", created: {}, agentStarted: false, promptSubmitted: false, recipientRegistered: false, effectCertainty: "absent" }
      }
    });
  });

  it("rejects invalid arguments for every tool before mutation", async () => {
    const surface = realSurface();
    const rejected: Array<[string, unknown]> = [
      ["herdr_communicate", { target: "w:p2", operation: "prompt" }],
      ["herdr_wait", { targets: [], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1 }],
      ["herdr_jobs", { operation: "get" }],
      ["herdr_launch", { name: "Worker", profile: "worker-pi", assignment: { objective: "o", scope: "s", verification: "v" }, supervisionDigest: { doneWhen: ["o done"], constraints: ["none"] } }],
      ["herdr_pane", { operation: "split" }],
      ["herdr_tab", { operation: "create" }]
    ];
    for (const [name, args] of rejected) {
      const outcome = await callTool({ surface, name, args, host, callId: "c", queue: new SequentialToolQueue() });
      expect(outcome.isError).toBe(true);
      expect(payload(outcome).code).toBe("INVALID_INPUT");
    }
    const accepted = await callTool({ surface, name: "herdr_jobs", args: { operation: "list" }, host, callId: "c", queue: new SequentialToolQueue() });
    expect(accepted.isError).toBeUndefined();
  });

  it("raises MethodNotFound for an unknown tool name", async () => {
    const surface = realSurface();
    const failure = await callTool({ surface, name: "herdr_admin\nnope", args: {}, host, callId: "c", queue: new SequentialToolQueue() }).catch((error: unknown) => error);
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

  it("publishes herdr_jobs evidence exactly once", async () => {
    const surface = realSurface();
    const outcome = await callTool({ surface, name: "herdr_jobs", args: { operation: "list" }, host, callId: "c", queue: new SequentialToolQueue() });
    expect(outcome.content).toHaveLength(1);
    expect(outcome.content[0]!.text).not.toContain(HERDR_DETAILS_LABEL);
    expect(JSON.parse(outcome.content[0]!.text)).toMatchObject({ operation: "jobs", view: "list" });
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

  it("keeps a complete all-child batch manifest when verbose details exceed the bound", async () => {
    // The batch result contract: the compact manifest leads the content so a
    // bounded response can never masquerade as a smaller fan-out.
    const names = Array.from({ length: 20 }, (_, index) => `task-worker-${index + 1}`);
    const manifest = [
      `herdr_launch batch outcome=launched router=route assignments=1 children=${names.length}`,
      ...names.map((name, index) => `- ${name} requested=worker outcome=launched pane=w1:p${index + 10} supervisor=job-${index + 1}`)
    ].join("\n");
    const details = {
      operation: "launch_batch",
      outcome: "launched",
      router: { kind: "route", assignments: [{ profile: "worker", count: names.length, purpose: "Perform the worker role." }] },
      children: names.map((name, index) => ({
        name,
        role: "worker",
        profile: "worker",
        ordinal: index + 1,
        status: "launched",
        launch: { operation: "launch", outcome: "launched", paneId: `w1:p${index + 10}`, supervision: { jobId: `job-${index + 1}` }, postState: { blob: "x".repeat(4_000) } }
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
    const diagnostic = { code: "LAUNCH_FAILED", phase: "ready", created: { paneId: "w:p2" }, agentStarted: true, promptSubmitted: false, recipientRegistered: false, effectCertainty: "unknown", recoveryGuidance: "Inspect with herdr_inspect before retrying." };
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
    await callTool({ surface: stub({ execute }), name: "herdr_inspect", args: {}, host: { cwd: "/project", signal: controller.signal }, callId: "c", queue: new SequentialToolQueue() });
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

function leakySurface() {
  const panes = [leakyPane("w:p", "caller", "idle", true), leakyPane("w:p2", "worker", "idle", true)];
  const live = {
    type: "session_snapshot",
    snapshot: {
      version: "1",
      protocol: 1,
      workspaces: [{ workspace_id: "w", label: "w" }],
      tabs: [{ tab_id: "w:t", workspace_id: "w", label: "t" }],
      panes,
      agents: [{ pane_id: "w:p", name: "caller", agent: "pi", terminal_id: "term-w:p", agent_session: { source: "pi", agent: "pi", kind: "id", value: "w:p-session" }, agent_status: "idle" }, { pane_id: "w:p2", name: "worker", agent: "pi", terminal_id: "term-w:p2", agent_session: { source: "pi", agent: "pi", kind: "id", value: "w:p2-session" }, agent_status: "idle" }]
    }
  };
  const envelope = (id: string, result: unknown) => ({ stdout: JSON.stringify({ id, result }), stderr: "", code: 0, killed: false });
  const exec: PiExec = async (_command, argv) => {
    if (argv[0] === "status") return { stdout: JSON.stringify(health), stderr: "", code: 0, killed: false };
    if (argv[0] === "pane" && argv[1] === "current") return envelope("current", { type: "pane_current", pane: live.snapshot.panes[0] });
    if (argv[0] === "api") return envelope("snapshot", live);
    if (argv[0] === "agent" && argv[1] === "wait") return envelope("agent-wait", { agent: panes.find((pane) => pane.pane_id === argv[2]) ?? leakyPane(argv[2]!, "created") });
    if (argv[0] === "agent" && argv[1] === "get") return envelope("agent-get", { agent: panes.find((pane) => pane.pane_id === argv[2]) ?? leakyPane(argv[2]!, "created") });
    if (argv[0] === "pane" && argv[1] === "get") return envelope("pane", { pane: panes.find((pane) => pane.pane_id === argv[2]) ?? leakyPane(argv[2]!, "created") });
    if (argv[0] === "pane" && argv[1] === "read") return { stdout: "worker output", stderr: "", code: 0, killed: false };
    if (argv[0] === "pane" && argv[1] === "split") return envelope("split", { pane: leakyPane("w:p3", "created") });
    return envelope("other", { ok: true });
  };
  const cli = new HerdrCli(exec);
  return createToolSurface({
    cli,
    context: { workspaceId: "w", tabId: "w:t", paneId: "w:p" },
    environment: { enabled: true, currentIdsPresent: true, currentIdsValid: true },
    preflight: createPreflight(cli),
    settingsLoader: async () => ({ reviewCadenceMinutes: 30, reviewerModel: "luna", reviewerThinking: "low" }),
    jobs: new JobRegistry(),
    profiles: { load: async () => ({ effective: new Map(), candidates: [], diagnostics: [] }) as never },
    ownership: new RuntimeOwnership(),
    supervision: stubSupervision(),
    cwd: "/project"
  });
}

describe("MCP model-boundary redaction", () => {
  it("strips environment values from inspect, wait, and pane evidence while keeping typed fields", async () => {
    const surface = leakySurface();
    const queue = new SequentialToolQueue();
    const calls: Array<[string, unknown]> = [
      ["herdr_inspect", { mode: "target", target: "w:p2" }],
      ["herdr_wait", { targets: ["w:p2"], match: "any", condition: { kind: "state", state: "idle" }, timeoutMs: 1_000 }],
      ["herdr_pane", { operation: "split", target: "w:p2", label: "worker-split", direction: "right", focus: false }]
    ];
    for (const [name, args] of calls) {
      const outcome = await callTool({ surface, name, args, host, callId: "c", queue });
      expect(outcome.isError, name).toBeUndefined();
      let text = outcome.content.map((block) => block.text).join("\n");
      for (const sentinel of SENTINELS) expect(text, `${name} ${sentinel}`).not.toContain(sentinel);
      // The environment keys themselves are gone, not just their values.
      expect(text, name).not.toContain("environment_overrides");
      if (name === "herdr_wait") {
        const jobId = (detailsOf(outcome) as { jobId: string }).jobId;
        let job: McpCallOutcome | undefined;
        await vi.waitFor(async () => {
          job = await callTool({ surface, name: "herdr_jobs", args: { operation: "get", jobId }, host, callId: "job", queue });
          expect(job!.content.map((block) => block.text).join("\n")).toContain("agent_status");
        });
        text = job!.content.map((block) => block.text).join("\n");
      }
      // The typed evidence a manager needs survives the redaction.
      expect(text, name).toContain("agent_status");
      expect(text, name).toMatch(/w:p[23]/);
    }
  });

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

describe("MCP sequential execution", () => {
  it("keeps cancel and interrupt in the shared FIFO communication lane", async () => {
    const order: string[] = [];
    const waiting: Array<() => void> = [];
    const surface: { definitions: HerdrToolDefinition[] } = { definitions: [{
      name: "herdr_communicate",
      label: "Herdr Communicate",
      description: "turn control",
      executionMode: "sequential",
      parameters: CommunicateParamsSchema,
      async execute(_id, args) {
        order.push((args as { operation: string }).operation);
        await new Promise<void>((resolve) => waiting.push(resolve));
        return { content: [{ type: "text" as const, text: "done" }], details: { operation: (args as { operation: string }).operation } };
      }
    }] };
    const queue = new SequentialToolQueue();
    const first = callTool({ surface, name: "herdr_communicate", args: { target: "p1", operation: "cancel" }, host, callId: "cancel", queue });
    await vi.waitFor(() => expect(order).toEqual(["cancel"]));
    const second = callTool({ surface, name: "herdr_communicate", args: { target: "p1", operation: "interrupt" }, host, callId: "interrupt", queue });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual(["cancel"]);
    waiting.shift()?.();
    await vi.waitFor(() => expect(order).toEqual(["cancel", "interrupt"]));
    waiting.shift()?.();
    const firstOutcome = await first;
    const secondOutcome = await second;
    expect(firstOutcome.isError).toBeUndefined();
    expect(secondOutcome.isError).toBeUndefined();
  });
  function overlapping(name: string, executionMode?: "sequential"): { definitions: HerdrToolDefinition[]; active: () => number; started: () => number; peak: () => number; release: () => void } {
    let active = 0;
    let started = 0;
    let peak = 0;
    const waiting: Array<() => void> = [];
    return {
      active: () => active,
      started: () => started,
      peak: () => peak,
      release: () => { for (const resume of waiting.splice(0)) resume(); },
      definitions: [{
        name,
        label: name,
        description: "stub",
        parameters: Type.Object({}, { additionalProperties: false }),
        ...(executionMode ? { executionMode } : {}),
        async execute() {
          active += 1;
          started += 1;
          peak = Math.max(peak, active);
          await new Promise<void>((resume) => waiting.push(resume));
          active -= 1;
          return { content: [{ type: "text" as const, text: "done" }], details: undefined };
        }
      }]
    };
  }

  it("never runs two sequential calls concurrently and keeps other tools concurrent", async () => {
    const sequential = overlapping("herdr_pane", "sequential");
    const queue = new SequentialToolQueue();
    const both = [
      callTool({ surface: sequential, name: "herdr_pane", args: {}, host, callId: "first", queue }),
      callTool({ surface: sequential, name: "herdr_pane", args: {}, host, callId: "second", queue })
    ];
    await vi.waitFor(() => expect(sequential.started()).toBe(1));
    // The second call is queued behind the first, so it cannot have started.
    expect(sequential.peak()).toBe(1);
    sequential.release();
    await vi.waitFor(() => expect(sequential.started()).toBe(2));
    sequential.release();
    expect((await Promise.all(both)).every((outcome) => outcome.isError === undefined)).toBe(true);
    expect(sequential.peak()).toBe(1);

    const parallel = overlapping("herdr_inspect");
    const concurrent = [
      callTool({ surface: parallel, name: "herdr_inspect", args: {}, host, callId: "first", queue }),
      callTool({ surface: parallel, name: "herdr_inspect", args: {}, host, callId: "second", queue })
    ];
    await vi.waitFor(() => expect(parallel.peak()).toBe(2));
    parallel.release();
    await Promise.all(concurrent);
  });

  it("does not poison the queue when a sequential call fails or is invalid", async () => {
    const order: string[] = [];
    const definitions: HerdrToolDefinition[] = [{
      name: "herdr_pane",
      label: "Herdr Pane",
      description: "stub",
      executionMode: "sequential",
      parameters: Type.Object({ fail: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
      async execute(_id, args) {
        order.push((args as { fail?: boolean }).fail ? "failed" : "ok");
        if ((args as { fail?: boolean }).fail) throw Object.assign(new Error("CLI_PROTOCOL_ERROR: refused"), { code: "CLI_PROTOCOL_ERROR" });
        return { content: [{ type: "text" as const, text: "done" }], details: undefined };
      }
    }];
    const surface = { definitions };
    const queue = new SequentialToolQueue();
    const [failed, invalid, recovered] = await Promise.all([
      callTool({ surface, name: "herdr_pane", args: { fail: true }, host, callId: "a", queue }),
      callTool({ surface, name: "herdr_pane", args: { unknown: true }, host, callId: "b", queue }),
      callTool({ surface, name: "herdr_pane", args: {}, host, callId: "c", queue })
    ]);
    expect(payload(failed!).code).toBe("CLI_PROTOCOL_ERROR");
    expect(payload(invalid!).code).toBe("INVALID_INPUT");
    expect(recovered!.isError).toBeUndefined();
    expect(order).toEqual(["failed", "ok"]);
  });

  it("refuses queued calls that outlive the host instead of mutating during teardown", async () => {
    const blocked = overlapping("herdr_pane", "sequential");
    const queue = new SequentialToolQueue();
    const holding = callTool({ surface: blocked, name: "herdr_pane", args: {}, host, callId: "holding", queue });
    await vi.waitFor(() => expect(blocked.started()).toBe(1));
    const waiting = callTool({ surface: blocked, name: "herdr_pane", args: {}, host, callId: "waiting", queue });
    queue.close();
    const afterClose = callTool({ surface: blocked, name: "herdr_pane", args: {}, host, callId: "after", queue });
    blocked.release();
    expect((await holding).isError).toBeUndefined();
    expect(payload(await waiting)).toMatchObject({ code: "ABORTED", details: { tool: "herdr_pane", executionMode: "sequential", reason: "closed" } });
    expect(payload(await afterClose)).toMatchObject({ code: "ABORTED", details: { reason: "closed" } });
    // Only the call that had already started ever executed.
    expect(blocked.peak()).toBe(1);
  });

  it("refuses a queued call whose request was cancelled before its turn", async () => {
    const blocked = overlapping("herdr_pane", "sequential");
    const queue = new SequentialToolQueue();
    const holding = callTool({ surface: blocked, name: "herdr_pane", args: {}, host, callId: "holding", queue });
    await vi.waitFor(() => expect(blocked.started()).toBe(1));
    const controller = new AbortController();
    const cancelled = callTool({ surface: blocked, name: "herdr_pane", args: {}, host: { cwd: "/project", signal: controller.signal }, callId: "cancelled", queue });
    controller.abort();
    blocked.release();
    await holding;
    expect(payload(await cancelled)).toMatchObject({ code: "ABORTED", details: { reason: "aborted" } });
    expect(blocked.peak()).toBe(1);
  });
});
