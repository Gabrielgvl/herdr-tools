import { describe, expect, it } from "vitest";
import { CliProtocolError } from "../../src/cli.js";
import type { CompiledContract } from "../../src/compile.js";
import { expandBatchRequest } from "../../src/launch-batch.js";
import type { LaunchSpec, SpecLaunchRequest } from "../../src/launch-schema.js";
import type { SpecDecision } from "../../src/router.js";
import { launchTestInternals } from "../../src/tools/launch.js";

const assignment = { objective: "Do the work.", scope: "Only this replica.", verification: "Run the focused check." };
const digest = { doneWhen: ["done"], constraints: ["none"] };
const configuration: CompiledContract = {
  specLabel: "worker",
  candidate: { index: 0, runner: "pi", model: "pi-model" },
  quota: { provider: "provider", billingProduct: "product", account: "account", scope: "project" },
  scopeRoot: "/repo",
  sessionPersistence: false,
  timeoutMinutes: 30,
  plumbing: { sessionPersistence: "optional", promptDelivery: "file", skillSelection: "exact", toolSelection: "allowlist" },
  runtime: { kind: "pi", model: "pi-model", thinking: "low", tools: [], extensions: [], skills: [] },
  resources: {},
  derivations: [],
  gaps: [],
};

function spec(label: string, count = 1): LaunchSpec {
  return { label, instructions: "Instructions.", assignment, category: "worker", count };
}

function request(specs: LaunchSpec[], overrides: Partial<SpecLaunchRequest> = {}): SpecLaunchRequest {
  return { name: "task", specs, supervisionDigest: digest, ...overrides };
}

function admitted(count: number): SpecDecision {
  return {
    kind: "admitted",
    quality: "not_rejected",
    category: "worker",
    count,
    configuration,
    evidence: {
      quality: { outcome: "not_rejected", instructions_adequate: 0.9, assignment_verifiable: 0.9 },
      category: { name: "worker", confidence: 0.9 },
      selectedCandidate: { index: 0, runner: "pi", model: "pi-model" },
      availability: [{ index: 0, status: "unknown", retryNotBefore: null }],
    },
  };
}

const abstained: SpecDecision = { kind: "abstained", reason: "transport_failed", component: "fixture" };

function expanded(result: ReturnType<typeof expandBatchRequest>) {
  expect(result.kind).toBe("expanded");
  if (result.kind !== "expanded") throw new Error("expected expansion");
  return result;
}

describe("spec batch expansion", () => {
  it("treats a typed quota failure from agent start as fallback-eligible", () => {
    const failure = new CliProtocolError("CLI_PROTOCOL_ERROR", "Individual quota reached", {
      exitCode: 1,
      killed: false,
      errorStream: "stderr",
      stderrTruncated: false,
      errorEnvelope: { id: "cli:agent:start", error: { code: "quota_exceeded", message: "Individual quota reached" } },
    });

    expect(launchTestInternals.startFailureEvidence(failure)).toEqual({ code: "quota_exceeded", message: "Individual quota reached" });
  });

  it("treats an agent-start deadline with no confirmed child as fallback-eligible", () => {
    const failure = new CliProtocolError("CLI_TIMEOUT", "start surfaced timeout", {
      exitCode: null,
      killed: true,
      errorEnvelope: { id: "cli:agent:start", error: { code: "quota_exceeded", message: "AGY individual quota reached" } },
    });

    expect(launchTestInternals.startFailureEvidence(failure)).toEqual({ code: "CLI_TIMEOUT", message: "AGY individual quota reached" });
    expect(launchTestInternals.startFailureEvidence(new CliProtocolError("CLI_TIMEOUT", "start surfaced timeout", { killed: true }))).toEqual({ code: "CLI_TIMEOUT", message: "start surfaced timeout" });
  });

  it("derives exact names and one count-one spec per replica", () => {
    const result = expanded(expandBatchRequest(request([spec("worker", 2), spec("review")]), [admitted(2), admitted(1)], new Set()));
    expect(result.children.map((child) => ({ name: child.name, label: child.specLabel, ordinal: child.ordinal, count: child.count, specCount: child.spec.count }))).toEqual([
      { name: "task-worker-1", label: "worker", ordinal: 1, count: 2, specCount: 1 },
      { name: "task-worker-2", label: "worker", ordinal: 2, count: 2, specCount: 1 },
      { name: "task-review-1", label: "review", ordinal: 1, count: 1, specCount: 1 },
    ]);
  });

  it("does not expand rejected or abstained specs", () => {
    const result = expanded(expandBatchRequest(request([spec("worker"), spec("review")]), [abstained, admitted(1)], new Set()));
    expect(result.children.map((child) => child.name)).toEqual(["task-review-1"]);
  });

  it("retains planned-name collisions as structured per-child failures", () => {
    const result = expanded(expandBatchRequest(request([spec("worker", 2)]), [admitted(2)], new Set(["task-worker-2"])));
    expect(result.children.map((child) => child.name)).toEqual(["task-worker-1"]);
    expect(result.failures).toEqual([{ code: "BATCH_NAME_COLLISION", name: "task-worker-2", specLabel: "worker", ordinal: 2, message: expect.any(String) }]);
  });

  it("requires exactly one admitted replica for existing_pane placement", () => {
    expect(expandBatchRequest(request([spec("worker", 2)], { placement: { mode: "existing_pane", target: "w:p2" } }), [admitted(2)], new Set())).toEqual({
      kind: "invalid",
      code: "BATCH_PLACEMENT_INVALID",
      message: "existing_pane placement requires exactly one admitted spec replica",
    });
  });

  it("derives labels and tab labels without changing the child name contract", () => {
    const result = expanded(expandBatchRequest(request([spec("worker")], { label: "pane", placement: { mode: "new_tab", tabLabel: "tab" } }), [admitted(1)], new Set()));
    expect(result.children[0]).toMatchObject({ name: "task-worker-1", label: "pane-worker-1", placement: { mode: "new_tab", tabLabel: "tab-worker-1" } });
  });

  it("retains a derived-label collision as a child failure", () => {
    const result = expanded(expandBatchRequest(request([spec("worker")], { label: "pane" }), [admitted(1)], new Set(["pane-worker-1"])));
    expect(result.children).toEqual([]);
    expect(result.failures).toEqual([{ code: "BATCH_NAME_COLLISION", name: "task-worker-1", specLabel: "worker", ordinal: 1, message: expect.stringContaining("label") }]);
  });

  it("rejects a derived child name without truncating it", () => {
    const result = expanded(expandBatchRequest(request([spec("worker")], { name: "a".repeat(31) }), [admitted(1)], new Set()));
    expect(result.children).toEqual([]);
    expect(result.failures).toEqual([{ code: "BATCH_CHILD_NAME_INVALID", name: `${"a".repeat(31)}-worker-1`, specLabel: "worker", ordinal: 1, message: expect.stringContaining("32") }]);
  });
});
