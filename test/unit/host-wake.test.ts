import { describe, expect, it, vi } from "vitest";
import { AgentPromptError } from "../../src/agent-prompt.js";
import type { JsonEnvelope } from "../../src/cli.js";
import type { JobDetail } from "../../src/job-registry.js";
import {
  CLAUDE_CHANNEL_NOTIFICATION_METHOD,
  createMcpHostWake,
  type McpHostWakeDeps,
  type McpWakeCli,
  type SupervisionWake,
} from "../../src/supervision/notify.js";

const session = { source: "herdr:test", agent: "devin", kind: "id", value: "s-1" };
const ownPaneId = "w1:p9";
const context = { workspaceId: "w1", tabId: "w1:t1", paneId: ownPaneId };

const wake: SupervisionWake = {
  jobId: "job_sup",
  child: { agentName: "worker", agentKind: "pi", paneId: "w1:p2" },
  event: { eventId: "sev_1", atMs: 5, type: "blocked", priority: "high", summary: "child idle → blocked" },
};

function waitDetail(overrides: Partial<JobDetail> = {}): JobDetail {
  return {
    jobId: "job_wait",
    kind: "wait",
    operation_phase: "settled",
    wait_result: "condition_met",
    sequence: 1,
    createdAtMs: 0,
    finishedAtMs: 1,
    request: {
      kind: "wait",
      label: "wait for worker",
      targets: ["worker"],
      targetIds: ["w1:p2"],
      match: "any",
      condition: { kind: "state", state: "done" },
      timeoutMs: 1,
      settings: { reviewCadenceMinutes: 1, reviewerModel: "luna", reviewerThinking: "low" },
    },
    result: { wait_result: "condition_met", matched: true, reason: "condition_met", matchedTargets: [{ target: "worker", targetId: "w1:p2" }] },
    ...overrides,
  };
}

function paneRecord(kind: string | undefined, agentStatus = "idle"): Record<string, unknown> {
  return {
    pane_id: ownPaneId,
    tab_id: "w1:t1",
    workspace_id: "w1",
    label: "manager",
    agent_name: "manager",
    ...(kind === undefined ? {} : { agent: kind }),
    terminal_id: "term-9",
    agent_session: { ...session, agent: kind ?? "devin" },
    agent_status: agentStatus,
    revision: 7,
  };
}

function agentRecord(kind: string, agentStatus = "idle"): Record<string, unknown> {
  return {
    pane_id: ownPaneId,
    name: "manager",
    agent: kind,
    terminal_id: "term-9",
    agent_session: { ...session, agent: kind },
    agent_status: agentStatus,
    revision: 7,
  };
}

function snapshotResult(kind: string, agentStatus = "idle"): unknown {
  return {
    type: "session_snapshot",
    snapshot: {
      version: "0.9.0",
      protocol: 22,
      workspaces: [{ workspace_id: "w1", label: "w" }],
      tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "t" }],
      panes: [paneRecord(kind, agentStatus)],
      agents: [agentRecord(kind, agentStatus)],
    },
  };
}

function ackResult(kind: string): unknown {
  return {
    type: "agent_prompted",
    agent: {
      pane_id: ownPaneId,
      terminal_id: "term-9",
      name: "manager",
      agent: kind,
      agent_session: { ...session, agent: kind },
      interactive_ready: true,
      revision: 8,
      state_change_seq: 3,
    },
  };
}

interface Harness {
  deps: McpHostWakeDeps;
  calls: string[][];
  prompts: Array<{ target: string; text: string }>;
  notifications: Array<{ method: string; params: { content: string; meta: Record<string, unknown> } }>;
}

interface HarnessOptions {
  /** Kind reported by the first `pane get` (kind resolution). */
  resolvedKind?: string;
  /** Kind the sandwich records (snapshot, agent get, later pane gets) report. */
  sandwichKind?: string;
  /** Kind reported by the `agent_prompted` ack. Defaults to sandwichKind. */
  ackKind?: string;
  agentStatus?: string;
  /** Reject this many leading `pane get` calls before serving records. */
  paneGetFailures?: number;
  promptError?: Error;
  /** Drop the snapshot agent record entirely (the incomplete own-pane edge). */
  noSnapshotAgent?: boolean;
  /** Strip `agent_status` from sandwich pane-get records (unproven state). */
  omitSandwichPaneStatus?: boolean;
  /** Replace the `agent get` result payload. */
  agentGetResult?: unknown;
  notifyChannel?: McpHostWakeDeps["notifyChannel"];
  ctx?: McpHostWakeDeps["context"];
}

function harness(options: HarnessOptions = {}): Harness {
  const calls: string[][] = [];
  const prompts: Array<{ target: string; text: string }> = [];
  const notifications: Array<{ method: string; params: { content: string; meta: Record<string, unknown> } }> = [];
  // `resolvedKind` present-but-undefined means the pane record carries no kind.
  const resolvedKind = Object.prototype.hasOwnProperty.call(options, "resolvedKind") ? options.resolvedKind : "devin";
  const sandwichKind = options.sandwichKind ?? resolvedKind ?? "devin";
  const ackKind = options.ackKind ?? sandwichKind;
  const status = options.agentStatus ?? "idle";
  let paneGetCalls = 0;
  let paneGetSuccesses = 0;
  const envelope = (id: string, result: unknown): JsonEnvelope => ({ id, result });
  const cli: McpWakeCli = {
    runJson: async (argv) => {
      calls.push(argv);
      if (argv[0] === "pane" && argv[1] === "get") {
        paneGetCalls += 1;
        if (paneGetCalls <= (options.paneGetFailures ?? 0)) throw new Error("backend down");
        paneGetSuccesses += 1;
        const record = paneRecord(paneGetSuccesses === 1 ? resolvedKind : sandwichKind, status);
        if (paneGetSuccesses > 1 && options.omitSandwichPaneStatus) delete record.agent_status;
        return envelope("pane-get", { pane: record });
      }
      if (argv[0] === "pane" && argv[1] === "current") {
        return envelope("pane-current", { type: "pane_current", pane: paneRecord(sandwichKind, status) });
      }
      if (argv[0] === "api" && argv[1] === "snapshot") {
        const snapshot = snapshotResult(sandwichKind, status) as { snapshot: { agents: unknown[] } };
        if (options.noSnapshotAgent) snapshot.snapshot.agents = [];
        return envelope("snapshot", snapshot);
      }
      if (argv[0] === "agent" && argv[1] === "get") {
        return envelope("agent-get", options.agentGetResult === undefined ? { agent: agentRecord(sandwichKind, status) } : options.agentGetResult);
      }
      throw new Error(`unexpected argv: ${argv.join(" ")}`);
    },
    prompt: async (target, text) => {
      prompts.push({ target, text });
      if (options.promptError) throw options.promptError;
      return envelope("prompt-1", ackResult(ackKind));
    },
  };
  return {
    deps: {
      cli,
      context: options.ctx ?? context,
      notifyChannel: options.notifyChannel ?? ((notification) => { notifications.push(notification); }),
    },
    calls,
    prompts,
    notifications,
  };
}

const paneGets = (calls: string[][]): number => calls.filter((argv) => argv[0] === "pane" && argv[1] === "get").length;

/** Yield until every queued microtask and immediate in the fire-and-forget pipeline has run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe("the MCP host wake router", () => {
  it("self-prompts a devin own pane with the full provenance envelope and validated ack", async () => {
    const { deps, prompts, notifications } = harness();
    createMcpHostWake(deps).notifier.wake(wake);
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]!.target).toBe(ownPaneId);
    expect(prompts[0]!.text).toContain("[HERDR AGENT MESSAGE v1]");
    expect(prompts[0]!.text).toContain("kind: supervision");
    expect(prompts[0]!.text).toContain("from: manager (w1:p9)");
    expect(prompts[0]!.text).toContain("HIGH PRIORITY: ");
    expect(prompts[0]!.text).toContain("job_sup");
    expect(notifications).toHaveLength(0);
  });

  it("self-prompts a pi own pane the same way", async () => {
    const { deps, prompts } = harness({ resolvedKind: "pi" });
    createMcpHostWake(deps).notifier.wake(wake);
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]!.text).toContain("kind: supervision");
  });

  it("sends a claude own pane the channel notification and never prompts", async () => {
    const { deps, prompts, notifications } = harness({ resolvedKind: "claude" });
    const host = createMcpHostWake(deps);
    host.notifier.wake(wake);
    await vi.waitFor(() => expect(notifications).toHaveLength(1));
    expect(notifications[0]!.method).toBe(CLAUDE_CHANNEL_NOTIFICATION_METHOD);
    expect(notifications[0]!.params.content).toContain("job_sup");
    expect(notifications[0]!.params.meta).toMatchObject({ jobId: "job_sup", eventType: "blocked" });
    expect(prompts).toHaveLength(0);
    // The resolved kind is cached: a second wake pays no resolution read.
    host.notifier.wake(wake);
    await vi.waitFor(() => expect(notifications).toHaveLength(2));
  });

  it("swallows a channel send that throws or rejects", async () => {
    for (const notifyChannel of [() => { throw new Error("closed"); }, () => Promise.reject(new Error("closed"))] as const) {
      const { deps, calls } = harness({ resolvedKind: "claude", notifyChannel });
      expect(() => createMcpHostWake(deps).notifier.wake(wake)).not.toThrow();
      await vi.waitFor(() => expect(paneGets(calls)).toBe(1));
      await flush();
    }
  });

  it.each([["agy"], ["codex"], [undefined]] as const)("stays inert for a %s own pane and caches the resolution", async (kind) => {
    const { deps, calls, prompts, notifications } = harness({ resolvedKind: kind });
    const host = createMcpHostWake(deps);
    host.notifier.wake(wake);
    host.notifyJobTerminal(waitDetail());
    await vi.waitFor(() => expect(paneGets(calls)).toBe(1));
    await flush();
    expect(prompts).toHaveLength(0);
    expect(notifications).toHaveLength(0);
    // A resolved "no usable kind" is cached permanently: no second `pane get`.
    host.notifier.wake(wake);
    await flush();
    expect(paneGets(calls)).toBe(1);
    expect(prompts).toHaveLength(0);
  });

  it("never touches Herdr when the injected context has no pane id", async () => {
    const { deps, calls, prompts } = harness({ ctx: { workspaceId: "w1", tabId: "w1:t1" } });
    const host = createMcpHostWake(deps);
    host.notifier.wake(wake);
    host.notifyJobTerminal(waitDetail());
    await flush();
    expect(calls).toHaveLength(0);
    expect(prompts).toHaveLength(0);
  });

  it("resolves the kind lazily: no reads at construction, one `pane get` for a burst, retry after a failure", async () => {
    const { deps, calls, notifications } = harness({ resolvedKind: "claude" });
    const host = createMcpHostWake(deps);
    expect(calls).toHaveLength(0);
    // A synchronous burst shares the single in-flight resolution.
    host.notifier.wake(wake);
    host.notifier.wake(wake);
    host.notifyJobTerminal(waitDetail());
    await vi.waitFor(() => expect(notifications).toHaveLength(3));
    expect(paneGets(calls)).toBe(1);

    const failing = harness({ resolvedKind: "claude", paneGetFailures: 1 });
    const failingHost = createMcpHostWake(failing.deps);
    failingHost.notifier.wake(wake);
    await vi.waitFor(() => expect(paneGets(failing.calls)).toBe(1));
    await flush();
    expect(failing.notifications).toHaveLength(0);
    // The rejected resolution is not cached: the next wake pays another read.
    failingHost.notifier.wake(wake);
    await vi.waitFor(() => expect(failing.notifications).toHaveLength(1));
    expect(paneGets(failing.calls)).toBe(2);
  });

  it("still writes to a working or blocked own pane but skips unknown or unproven state", async () => {
    for (const agentStatus of ["working", "blocked"] as const) {
      const { deps, prompts } = harness({ agentStatus });
      createMcpHostWake(deps).notifier.wake(wake);
      await vi.waitFor(() => expect(prompts).toHaveLength(1));
    }
    for (const overrides of [{ agentStatus: "unknown" }, { omitSandwichPaneStatus: true }] as const) {
      const { deps, calls, prompts } = harness(overrides);
      createMcpHostWake(deps).notifier.wake(wake);
      // The state gate is later than kind resolution, so the reads still run.
      await vi.waitFor(() => expect(calls.some((argv) => argv[0] === "agent" && argv[1] === "get")).toBe(true));
      await flush();
      expect(prompts).toHaveLength(0);
    }
  });

  it("drops the wake when the sandwich identity is contradictory or incomplete", async () => {
    // The incomplete own-pane identity edge: a live agent_session but no
    // snapshot agent record — the sandwich cannot be proven, so nothing writes.
    const missing = harness({ noSnapshotAgent: true });
    createMcpHostWake(missing.deps).notifier.wake(wake);
    await vi.waitFor(() => expect(missing.calls.some((argv) => argv[0] === "api")).toBe(true));
    await flush();
    expect(missing.prompts).toHaveLength(0);

    const contradictory = harness({ agentGetResult: { agent: { pane_id: "w1:pDIFFERENT" } } });
    createMcpHostWake(contradictory.deps).notifier.wake(wake);
    await vi.waitFor(() => expect(contradictory.calls.some((argv) => argv[0] === "agent" && argv[1] === "get")).toBe(true));
    await flush();
    expect(contradictory.prompts).toHaveLength(0);
  });

  it("drops the wake when the fresh record disagrees with the routed kind", async () => {
    // Resolved "devin"; the fresh sandwich proves "pi" — prompt-capable but not
    // the kind that routed the wake.
    const changed = harness({ resolvedKind: "devin", sandwichKind: "pi" });
    createMcpHostWake(changed.deps).notifier.wake(wake);
    await vi.waitFor(() => expect(changed.calls.some((argv) => argv[0] === "agent" && argv[1] === "get")).toBe(true));
    await flush();
    expect(changed.prompts).toHaveLength(0);

    // Resolved "devin"; the fresh sandwich proves a non-prompt-capable kind.
    const unqualified = harness({ resolvedKind: "devin", sandwichKind: "claude" });
    createMcpHostWake(unqualified.deps).notifier.wake(wake);
    await vi.waitFor(() => expect(unqualified.calls.some((argv) => argv[0] === "agent" && argv[1] === "get")).toBe(true));
    await flush();
    expect(unqualified.prompts).toHaveLength(0);
  });

  it("swallows a socket-level refusal and an ack identity mismatch", async () => {
    const blocked = harness({ promptError: new AgentPromptError("TARGET_BLOCKED", "Herdr rejected input for a blocked target", { state: "rejected", requestId: "prompt-1" }) });
    createMcpHostWake(blocked.deps).notifier.wake(wake);
    await vi.waitFor(() => expect(blocked.prompts).toHaveLength(1));
    await flush();

    const mismatched = harness({ ackKind: "pi" });
    createMcpHostWake(mismatched.deps).notifier.wake(wake);
    await vi.waitFor(() => expect(mismatched.prompts).toHaveLength(1));
    await flush();
  });

  it("swallows a context-resolution failure", async () => {
    const { deps, prompts } = harness();
    const original = deps.cli.runJson;
    deps.cli.runJson = async (argv, signal) => {
      if (argv[0] === "pane" && argv[1] === "current") throw new Error("socket down");
      return original(argv, signal);
    };
    expect(() => createMcpHostWake(deps).notifier.wake(wake)).not.toThrow();
    await flush();
    expect(prompts).toHaveLength(0);
  });

  it("routes wait-kind settlements under `kind: wait` and skips supervisor jobs", async () => {
    const { deps, prompts, calls } = harness();
    const host = createMcpHostWake(deps);
    host.notifyJobTerminal(waitDetail());
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]!.text).toContain("kind: wait");
    expect(prompts[0]!.text).toContain("job_wait");
    expect(prompts[0]!.text).toContain("wait_result=condition_met");

    const before = calls.length;
    host.notifyJobTerminal(waitDetail({ kind: "supervisor" as never, request: { kind: "supervisor", label: "sup", targets: ["worker"], targetIds: [], child: { agentName: "worker", agentKind: "pi", profileName: "worker-pi" }, settings: { reviewCadenceMinutes: 1, reviewerModel: "luna", reviewerThinking: "max" } } }));
    await flush();
    expect(calls.length).toBe(before);
    expect(prompts).toHaveLength(1);
  });

  it("never throws synchronously from wake or notifyJobTerminal, even on malformed input", async () => {
    const { deps } = harness({ resolvedKind: "claude" });
    const host = createMcpHostWake(deps);
    expect(() => host.notifier.wake({ ...wake, event: null as never })).not.toThrow();
    expect(() => host.notifyJobTerminal(waitDetail({ request: null as never }))).not.toThrow();
    await flush();
  });
});
