import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentPromptError } from "../../src/agent-prompt.js";
import type { JsonEnvelope } from "../../src/cli.js";
import type { JobDetail } from "../../src/job-registry.js";
import { createDevinQueueFlush, type DevinQueueFlush, type DevinQueueFlushCli } from "../../src/messages/devin-queue-flush.js";
import { createPaneWriteGuard } from "../../src/pane-write-lock.js";
import {
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
      settings: { reviewCadenceMinutes: 1, reviewerModel: "testmodel", reviewerThinking: "low" },
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
  queueFlush: DevinQueueFlush;
  lockDir: string;
}

const lockDirs: string[] = [];

afterEach(() => {
  for (const dir of lockDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A held flush operation must notice the cycle abort like a real transport would. */
function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(new Error("aborted"));
    else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

interface HarnessOptions {
  /** Kind reported by the first `pane get` (kind resolution). */
  resolvedKind?: string;
  /** Kind the sandwich records (snapshot, agent get, later pane gets) report. */
  sandwichKind?: string;
  /** Kind reported by the `agent_prompted` ack. Defaults to sandwichKind. */
  ackKind?: string;
  agentStatus?: string;
  /** Status reported by pane records read after the first `agent wait` call. */
  statusAfterWait?: string;
  /** Per-`pane get` agent_status sequence (the last value repeats); overrides statusAfterWait. */
  paneStatuses?: string[];
  /** Dynamic agent_status for `pane get`, keyed on progress counters; overrides paneStatuses. */
  paneStatusFn?: (obs: { paneGet: number; prompted: number; sentKeys: number; waits: number }) => string;
  /** Reject this many leading `pane get` calls before serving records. */
  paneGetFailures?: number;
  promptError?: Error;
  /** Reject the flush `agent wait`. */
  waitError?: Error;
  /** Hold the flush `agent wait` response until this promise resolves. */
  holdWait?: Promise<void>;
  /** Hold the first flush `pane read` response until this promise resolves. */
  holdRead?: Promise<void>;
  /** Reject the flush `agent send-keys`. */
  sendKeysError?: Error;
  /** Text returned by `pane read` during the flush check. */
  paneView?: string;
  /** Successive `pane read` payloads; `paneView` is the fallback once drained. */
  paneViews?: string[];
  /** Session controller wired as `deps.signal`; aborting it is server shutdown. */
  session?: AbortController;
  /** Shut the coordinator down inside the first `pane get` that follows an `agent wait`. */
  abortBeforeKey?: boolean;
  /** Drop the snapshot agent record entirely (the incomplete own-pane edge). */
  noSnapshotAgent?: boolean;
  /** Strip `agent_status` from sandwich pane-get records (unproven state). */
  omitSandwichPaneStatus?: boolean;
  /** Replace the `agent get` result payload. */
  agentGetResult?: unknown;
  ctx?: McpHostWakeDeps["context"];
}

function harness(options: HarnessOptions = {}): Harness {
  const calls: string[][] = [];
  const prompts: Array<{ target: string; text: string }> = [];
  // `resolvedKind` present-but-undefined means the pane record carries no kind.
  const resolvedKind = Object.prototype.hasOwnProperty.call(options, "resolvedKind") ? options.resolvedKind : "devin";
  const sandwichKind = options.sandwichKind ?? resolvedKind ?? "devin";
  const ackKind = options.ackKind ?? sandwichKind;
  const status = options.agentStatus ?? "idle";
  const session = options.session ?? new AbortController();
  let paneGetCalls = 0;
  let paneGetSuccesses = 0;
  let waited = false;
  let readCalls = 0;
  const envelope = (id: string, result: unknown): JsonEnvelope => ({ id, result });
  const cli: McpWakeCli & DevinQueueFlushCli = {
    runJson: async (argv, signal) => {
      if (signal.aborted) throw new Error("aborted");
      calls.push(argv);
      if (argv[0] === "pane" && argv[1] === "get") {
        paneGetCalls += 1;
        if (paneGetCalls <= (options.paneGetFailures ?? 0)) throw new Error("backend down");
        paneGetSuccesses += 1;
        const sequence = options.paneStatuses;
        const record = paneRecord(
          paneGetSuccesses === 1 ? resolvedKind : sandwichKind,
          options.paneStatusFn !== undefined
            ? options.paneStatusFn({
              paneGet: paneGetSuccesses,
              prompted: prompts.length,
              sentKeys: calls.filter((argv) => argv[0] === "agent" && argv[1] === "send-keys").length,
              waits: calls.filter((argv) => argv[0] === "agent" && argv[1] === "wait").length,
            })
            : sequence === undefined
              ? (waited ? (options.statusAfterWait ?? "idle") : status)
              : sequence[Math.min(paneGetSuccesses - 1, sequence.length - 1)]!,
        );
        if (paneGetSuccesses > 1 && options.omitSandwichPaneStatus) delete record.agent_status;
        if (options.abortBeforeKey && waited) void queueFlush.shutdown();
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
      if (argv[0] === "agent" && argv[1] === "wait") {
        waited = true;
        if (options.waitError) throw options.waitError;
        if (options.holdWait) await Promise.race([options.holdWait, aborted(signal)]);
        return envelope("agent-wait", { type: "agent_info", agent: agentRecord(sandwichKind, options.statusAfterWait ?? "idle") });
      }
      if (argv[0] === "agent" && argv[1] === "send-keys") {
        if (options.sendKeysError) throw options.sendKeysError;
        return envelope("send-keys", { ok: true });
      }
      throw new Error(`unexpected argv: ${argv.join(" ")}`);
    },
    runTextResult: async (argv, signal) => {
      if (signal.aborted) throw new Error("aborted");
      calls.push(argv);
      if (argv[0] === "pane" && argv[1] === "read") {
        readCalls += 1;
        if (readCalls === 1 && options.holdRead) await Promise.race([options.holdRead, aborted(signal)]);
        return { value: options.paneViews !== undefined && options.paneViews.length > 0 ? options.paneViews.shift()! : (options.paneView ?? ""), truncated: false };
      }
      throw new Error(`unexpected argv: ${argv.join(" ")}`);
    },
    prompt: async (target, text) => {
      prompts.push({ target, text });
      if (options.promptError) throw options.promptError;
      return envelope("prompt-1", ackResult(ackKind));
    },
  };
  const lockDir = mkdtempSync(join(tmpdir(), "herdr-wake-locks-"));
  lockDirs.push(lockDir);
  const queueFlush = createDevinQueueFlush({ cli, guard: createPaneWriteGuard({ namespace: { dir: lockDir, endpoint: "herdr-test-endpoint" } }), sectionWaitMs: 500 });
  queueFlush.begin();
  return {
    deps: {
      cli,
      context: options.ctx ?? context,
      signal: session.signal,
      queueFlush,
    },
    calls,
    prompts,
    queueFlush,
    lockDir,
  };
}

const paneGets = (calls: string[][]): number => calls.filter((argv) => argv[0] === "pane" && argv[1] === "get").length;

/** Yield until every queued microtask and immediate in the fire-and-forget pipeline has run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe("the MCP host wake router", () => {
  it("self-prompts a devin own pane with the full provenance envelope and validated ack", async () => {
    const { deps, prompts } = harness();
    createMcpHostWake(deps).notifier.wake(wake);
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]!.target).toBe(ownPaneId);
    expect(prompts[0]!.text).toContain("[HERDR AGENT MESSAGE v1]");
    expect(prompts[0]!.text).toContain("kind: supervision");
    expect(prompts[0]!.text).toContain("from: manager (w1:p9)");
    expect(prompts[0]!.text).toContain("HIGH PRIORITY: ");
    expect(prompts[0]!.text).toContain("job_sup");
  });

  it("self-prompts a pi own pane the same way", async () => {
    const { deps, prompts } = harness({ resolvedKind: "pi" });
    createMcpHostWake(deps).notifier.wake(wake);
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]!.text).toContain("kind: supervision");
  });

  // N5.2: a claude own pane has no wake path — the Channels send is gone and
  // the daemon owns every wake, so claude drops like any non-prompt kind.
  it.each([["claude"], ["agy"], ["codex"], [undefined]] as const)("stays inert for a %s own pane and caches the resolution", async (kind) => {
    const { deps, calls, prompts } = harness({ resolvedKind: kind });
    const host = createMcpHostWake(deps);
    host.notifier.wake(wake);
    host.notifyJobTerminal(waitDetail());
    await vi.waitFor(() => expect(paneGets(calls)).toBe(1));
    await flush();
    expect(prompts).toHaveLength(0);
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
    const { deps, calls, prompts } = harness({ resolvedKind: "claude" });
    const host = createMcpHostWake(deps);
    expect(calls).toHaveLength(0);
    // A synchronous burst shares the single in-flight resolution.
    host.notifier.wake(wake);
    host.notifier.wake(wake);
    host.notifyJobTerminal(waitDetail());
    await vi.waitFor(() => expect(paneGets(calls)).toBe(1));
    await flush();
    expect(prompts).toHaveLength(0);

    const failing = harness({ resolvedKind: "claude", paneGetFailures: 1 });
    const failingHost = createMcpHostWake(failing.deps);
    failingHost.notifier.wake(wake);
    await vi.waitFor(() => expect(paneGets(failing.calls)).toBe(1));
    await flush();
    expect(failing.prompts).toHaveLength(0);
    // The rejected resolution is not cached: the next wake pays another read.
    failingHost.notifier.wake(wake);
    await vi.waitFor(() => expect(paneGets(failing.calls)).toBe(2));
    await flush();
    expect(failing.prompts).toHaveLength(0);
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

  it("schedules no flush when the fresh identity join proves a different kind than the resolution", async () => {
    // The pane resolved devin, but the sandwich freshly proves pi: the
    // self-prompt is refused inside the write section before any send, so no
    // submission exists to schedule.
    const { deps, calls, prompts } = harness({ resolvedKind: "devin", sandwichKind: "pi" });
    createMcpHostWake(deps).notifier.wake(wake);
    await vi.waitFor(() => expect(paneGets(calls)).toBeGreaterThanOrEqual(2));
    await flush();
    expect(prompts).toHaveLength(0);
    expect(sendKeys(calls)).toHaveLength(0);
  });

  const sendKeys = (calls: string[][]): string[][] => calls.filter((argv) => argv[0] === "agent" && argv[1] === "send-keys");
  const waits = (calls: string[][]): string[][] => calls.filter((argv) => argv[0] === "agent" && argv[1] === "wait");

  // Rendered per the captured live fixture: the composer box is one `❭` row
  // between two 68-gray rules; queued envelopes render above the box as
  // `○`-prefixed placeholder-gray rows, and the box's queue signal is the
  // input placeholder itself ("Press Enter to send queued messages now").
  const RULE_INNER = "─".repeat(60);
  const GRAY = "\x1b[38;2;124;124;124m";
  const RULE_GRAY = "\x1b[38;2;68;68;68m";
  const RESET = "\x1b[0m";
  const COMPOSER_RULE = `${RESET}${RULE_GRAY}${RULE_INNER}${RESET}`;
  const HINT = `${RESET}${GRAY}Press Enter to send queued messages now${RESET}`;
  const PLACEHOLDER = `${RESET}${GRAY}Guide Devin while it works${RESET}`;
  const QUEUED_ROW = (text: string): string => `${RESET}${GRAY}○${RESET} ${RESET}${GRAY}${text}${RESET}`;
  /**
   * A rendered Devin pane: transcript + `○` queued rows above the box, then
   * rule / `❭` input / rule / status bar. `section` injects extra rows inside
   * the box above the input; `belowInput` injects rows inside below it;
   * `rawInput` replaces the whole input line (escapes may precede the glyph).
   */
  const composerView = (
    input = PLACEHOLDER,
    { queuedRows = 0, section = "", belowInput = "", rawInput, transcript = "agent output" }:
      { queuedRows?: number; section?: string; belowInput?: string; rawInput?: string; transcript?: string } = {},
  ): string =>
    `${transcript}\n${Array.from({ length: queuedRows }, (_, i) => QUEUED_ROW(`queued envelope ${i + 1}`)).join("\n")}${queuedRows > 0 ? "\n" : ""}⠀ Running tools\n${COMPOSER_RULE}\n${section}${rawInput ?? `❭ ${input}`}\n${belowInput}${COMPOSER_RULE}\nSWE-2 Max   Context: 9%\n`;
  const QUEUED = composerView(HINT, { queuedRows: 2 });
  const DRAINED = composerView();
  /** The verbatim `pane read --source visible --format ansi` capture of w6:p1Y with two queued wakes (test/fixtures/devin-composer-queued.ansi). */
  const REAL_QUEUED = readFileSync(new URL("../fixtures/devin-composer-queued.ansi", import.meta.url), "utf8");

  it.each(["working", "blocked"] as const)("flushes a devin wake queued mid-turn after the pane goes idle", async (agentStatus) => {
    // Driven by the real captured composer, not a synthetic render: the queue
    // is proven by the all-placeholder input hint alone. Views are candidate,
    // final re-proof, then the post-press drained frame: every key is gated by
    // a candidate read and a final ANSI proof rendering the identical frame.
    const { deps, calls, prompts } = harness({ agentStatus, paneViews: [REAL_QUEUED, REAL_QUEUED, DRAINED] });
    createMcpHostWake(deps).notifier.wake(wake);
    await vi.waitFor(() => expect(sendKeys(calls)).toEqual([["agent", "send-keys", ownPaneId, "enter"]]));
    expect(prompts).toHaveLength(1);
    // The flush is post-turn only: one bounded wait strictly inside the signal
    // budget, then a composer proof, a fresh state proof, and exactly one Enter.
    expect(waits(calls)).toEqual([["agent", "wait", ownPaneId, "--until", "idle", "--until", "done", "--timeout", "110000"]]);
    expect(calls).toContainEqual(["pane", "read", ownPaneId, "--source", "visible", "--format", "ansi"]);
    expect(calls.indexOf(waits(calls)[0]!)).toBeGreaterThan(calls.findIndex((argv) => argv[1] === "get"));
    expect(calls.indexOf(sendKeys(calls)[0]!)).toBeGreaterThan(calls.indexOf(waits(calls)[0]!));
  });

  it("accepts every empty-composer rendering the real capture implies", async () => {
    const views = [
      // SGR opened BEFORE the ❭ glyph: the walk must carry it into the input area.
      composerView("", { rawInput: `${GRAY}❭ Press Enter to send queued messages now${RESET}` }),
      // Placeholder gray continued onto a wrapped input row without re-emitting SGR.
      composerView(`${RESET}${GRAY}Press Enter to send queued`, { belowInput: "messages now\n" }),
      // Colon-form truecolor (ITU-T T.416 sub-parameters).
      composerView(`${RESET}\x1b[38:2::124:124:124mPress Enter to send queued messages now${RESET}`),
      // Extended background/underline payloads after placeholder gray: their
      // components are consumed, not re-read as resets or 8-color foregrounds.
      composerView(`${RESET}${GRAY}\x1b[48;2;0;0;0m\x1b[58;2;10;20;30m\x1b[58;5;8m\x1b[48;5;7mPress Enter to send queued messages now${RESET}`),
      // A styled chrome row inside the box below the input (a render-time hint).
      composerView(HINT, { belowInput: `${RESET}${RULE_GRAY}⏎ send · ⇧⏎ newline${RESET}\n` }),
      // A `○` queued row rendered inside the box section proves the queue too.
      composerView(PLACEHOLDER, { section: `${QUEUED_ROW("queued envelope 1")}\n` }),
      // An in-box "queued" section line proves the queue under a draft-free input.
      composerView(`${RESET}${GRAY}Guide Devin while it works${RESET}`, { section: "2 queued · Enter to send\n" }),
      // Non-SGR CSI escapes and bare resets inside the input do not defeat the proof.
      composerView(`\x1b[2K\x1b[;m\x1b[m${GRAY}Press Enter to send queued messages now${RESET}`),
    ];
    for (const [index, view] of views.entries()) {
      const ok = harness({ agentStatus: "working", paneViews: [view, view, DRAINED] });
      createMcpHostWake(ok.deps).notifier.wake(wake);
      await vi.waitFor(() => expect(sendKeys(ok.calls), `accepted view ${index} refused Enter`).toHaveLength(1));
    }
  });

  it("presses Enter only inside a proven composer: queued evidence plus empty input", async () => {
    // A typed draft under in-box queue evidence makes Enter a draft submission
    // — refused, however the draft is styled (non-124 color never reads as
    // placeholder, and a background color never proves the foreground empty).
    for (const input of [
      "half-typed draft",
      "\x1b[0m\x1b[38;5;8mcolored draft\x1b[0m",
      "\x1b[0m\x1b[31mred draft\x1b[0m",
      "\x1b[0m\x1b[38;2;200;200;200mtruecolor draft\x1b[0m",
      "\x1b[0m\x1b[38;2;124;0;0malmost-placeholder draft\x1b[0m",
      "\x1b[0m\x1b[38;2;124;124;0malmost-placeholder draft\x1b[0m",
      "\x1b[0m\x1b[38mdraft\x1b[0m",
      "\x1b[0m\x1b[48;1mdraft\x1b[0m",
      "\x1b[0m\x1b[58;4mdraft\x1b[0m",
      // A non-CSI escape leaves its trailing byte as printable content.
      "\x1b[0m\x1bMdraft\x1b[0m",
      // Attributes + background without placeholder gray never read as a hint.
      "\x1b[0m\x1b[1m\x1b[48;2;0;0;0mbold draft\x1b[0m",
      // Any other foreground revokes the placeholder proof mid-input — basic
      // and bright colors alike (a draft typed "in red" is still a draft).
      `${RESET}${GRAY}hint\x1b[31m then a red draft`,
      `${RESET}${GRAY}hint\x1b[37m then a draft`,
      `${RESET}${GRAY}hint\x1b[91m then a draft`,
      `${RESET}${GRAY}hint\x1b[97m then a draft`,
      `${RESET}${GRAY}hint\x1b[39m then a draft`,
      // An empty parameter is an omitted `0` — `ESC[;m` resets like `ESC[0m`.
      `${RESET}${GRAY}hint\x1b[;m then a draft`,
      `${RESET}${GRAY}hint\x1b[49m then a draft`,
      `${RESET}${GRAY}hint\x1b[59m then a draft`,
      `${RESET}${GRAY}hint\x1b[22m then a draft`,
    ]) {
      const draft = harness({ agentStatus: "working", paneView: composerView(input, { section: "1 queued\n" }) });
      createMcpHostWake(draft.deps).notifier.wake(wake);
      await vi.waitFor(() => expect(draft.calls.some((argv) => argv[0] === "pane" && argv[1] === "read")).toBe(true));
      await flush();
      expect(draft.prompts).toHaveLength(1);
      expect(sendKeys(draft.calls)).toHaveLength(0);
    }

    // An unstyled row inside the box below the input is a wrapped draft tail.
    const tail = harness({ agentStatus: "working", paneView: composerView(PLACEHOLDER, { section: "1 queued\n", belowInput: "unstyled tail\n" }) });
    createMcpHostWake(tail.deps).notifier.wake(wake);
    await vi.waitFor(() => expect(tail.calls.some((argv) => argv[0] === "pane" && argv[1] === "read")).toBe(true));
    await flush();
    expect(sendKeys(tail.calls)).toHaveLength(0);

    // "queued" in scrollback is transcript text, not a composer queue — refused.
    const scrollback = harness({ agentStatus: "working", paneView: composerView(PLACEHOLDER, { transcript: "turn reported 3 queued items" }) });
    createMcpHostWake(scrollback.deps).notifier.wake(wake);
    await vi.waitFor(() => expect(scrollback.calls.some((argv) => argv[0] === "pane" && argv[1] === "read")).toBe(true));
    await flush();
    expect(sendKeys(scrollback.calls)).toHaveLength(0);

    // A draft with no queue evidence anywhere is still unproven for queue purposes.
    const markerless = harness({ agentStatus: "working", paneView: composerView("typed draft") });
    createMcpHostWake(markerless.deps).notifier.wake(wake);
    await vi.waitFor(() => expect(markerless.calls.some((argv) => argv[0] === "pane" && argv[1] === "read")).toBe(true));
    await flush();
    expect(sendKeys(markerless.calls)).toHaveLength(0);

    // No composer structure at all — or a half-formed box — is unproven.
    for (const view of [
      "2 queued but no box",
      `1 queued\n❭ ${PLACEHOLDER}\n${COMPOSER_RULE}\n`,
      `${COMPOSER_RULE}\n1 queued\n❭ ${PLACEHOLDER}\nstatus bar\n`,
    ]) {
      const unproven = harness({ agentStatus: "working", paneView: view });
      createMcpHostWake(unproven.deps).notifier.wake(wake);
      await vi.waitFor(() => expect(unproven.calls.some((argv) => argv[0] === "pane" && argv[1] === "read")).toBe(true));
      await flush();
      expect(sendKeys(unproven.calls)).toHaveLength(0);
    }
  });

  it("re-proves state before every Enter and re-presses only on an observed change", async () => {
    // The queue is visible but the pane re-proves busy: no key is sent.
    const busy = harness({ agentStatus: "working", paneView: QUEUED, statusAfterWait: "working" });
    createMcpHostWake(busy.deps).notifier.wake(wake);
    await vi.waitFor(() => expect(busy.calls.some((argv) => argv[0] === "pane" && argv[1] === "read")).toBe(true));
    await flush();
    expect(busy.prompts).toHaveLength(1);
    expect(sendKeys(busy.calls)).toHaveLength(0);

    // One Enter drains the whole queue, so an identical frame on the next
    // candidate read is repaint lag — not an un-drained queue — and earns no
    // key. Reads: candidate + final for the spent press, candidate for the
    // refused one.
    const stale = harness({ agentStatus: "working", paneView: QUEUED });
    createMcpHostWake(stale.deps).notifier.wake(wake);
    await vi.waitFor(() => expect(sendKeys(stale.calls)).toHaveLength(1));
    // The refused repaint candidate pays one more locked read — a real flock
    // round-trip — so wait for it rather than yielding a fixed number of turns.
    await vi.waitFor(() => expect(stale.calls.filter((argv) => argv[1] === "read")).toHaveLength(3));
    await flush();
    expect(sendKeys(stale.calls)).toHaveLength(1);

    // A changed still-queued frame is new evidence: one more Enter, then the
    // cycle stops regardless (draining a newer arrival, never resending). The
    // second key needs its own candidate + identical final pair.
    const changed = harness({
      agentStatus: "working",
      paneViews: [QUEUED, QUEUED, composerView(HINT, { section: `${QUEUED_ROW("late envelope")}\n` }), composerView(HINT, { section: `${QUEUED_ROW("late envelope")}\n` }), DRAINED],
    });
    createMcpHostWake(changed.deps).notifier.wake(wake);
    await vi.waitFor(() => expect(sendKeys(changed.calls)).toHaveLength(2));
    await flush();
    expect(sendKeys(changed.calls)).toHaveLength(2);
  });

  it("starts a fresh flush cycle for a wake acknowledged mid-drain", async () => {
    let releaseRead!: () => void;
    const holdRead = new Promise<void>((resolve) => { releaseRead = resolve; });
    // The second wake's own text write must ride the same pane-write section
    // the parked cycle holds, so it cannot interleave with the proof/Enter —
    // it waits out the held read, then delivers and schedules a fresh cycle.
    // Pane status by progress: both wakes' sandwiches read working (eligible),
    // every flush re-proof reads idle.
    const { deps, calls, prompts } = harness({
      agentStatus: "working",
      paneViews: [QUEUED, QUEUED, DRAINED],
      paneView: DRAINED,
      holdRead,
      paneStatusFn: ({ waits: w, sentKeys, prompted }) =>
        w === 0 ? "working" : sentKeys === 0 ? "idle" : prompted === 1 ? "working" : "idle",
    });
    const host = createMcpHostWake(deps);
    host.notifier.wake(wake);
    await vi.waitFor(() => expect(waits(calls)).toHaveLength(1));
    await vi.waitFor(() => expect(calls.some((argv) => argv[0] === "pane" && argv[1] === "read")).toBe(true));
    // The first cycle is parked at its held composer read, holding the pane
    // write section. The second wake reaches the lock and waits there — its
    // prompt cannot interleave with the in-flight proof.
    host.notifier.wake(wake);
    await vi.waitFor(() => expect(calls.filter((argv) => argv[0] === "api" && argv[1] === "snapshot")).toHaveLength(2));
    await flush();
    expect(prompts).toHaveLength(1);
    expect(waits(calls)).toHaveLength(1);
    releaseRead();
    // Cycle 1 drains and presses once; the second write then acquires the
    // section, delivers, and appends a serialized cycle that runs its own wait
    // and a fresh composer read — the marker is gone, so no second key.
    await vi.waitFor(() => expect(prompts).toHaveLength(2));
    await vi.waitFor(() => expect(waits(calls)).toHaveLength(2));
    await vi.waitFor(() => expect(sendKeys(calls)).toHaveLength(1));
    await flush();
    expect(sendKeys(calls)).toHaveLength(1);
  });

  it("keeps the flush tail alive after a failed cycle", async () => {
    // Both cycles' waits fail — each wake drops independently and neither
    // poisons the chain.
    const { deps, calls, prompts } = harness({ agentStatus: "working", statusAfterWait: "working", waitError: new Error("gone") });
    const host = createMcpHostWake(deps);
    host.notifier.wake(wake);
    await vi.waitFor(() => expect(waits(calls)).toHaveLength(1));
    await flush();
    host.notifier.wake(wake);
    await vi.waitFor(() => expect(prompts).toHaveLength(2));
    await vi.waitFor(() => expect(waits(calls)).toHaveLength(2));
    await flush();
    expect(sendKeys(calls)).toHaveLength(0);
  });

  it("never presses Enter after the coordinator shuts down mid-flush", async () => {
    // Shutdown while the wait is held: the cycle is cancelled at the next call.
    let releaseWait!: () => void;
    const holdWait = new Promise<void>((resolve) => { releaseWait = resolve; });
    const duringWait = harness({ agentStatus: "working", paneView: QUEUED, holdWait });
    createMcpHostWake(duringWait.deps).notifier.wake(wake);
    await vi.waitFor(() => expect(waits(duringWait.calls)).toHaveLength(1));
    void duringWait.queueFlush.shutdown();
    releaseWait();
    await flush();
    expect(duringWait.prompts).toHaveLength(1);
    expect(sendKeys(duringWait.calls)).toHaveLength(0);

    // Shutdown landing between the state re-proof and the key: still no Enter.
    const atKey = harness({ agentStatus: "working", paneView: QUEUED, abortBeforeKey: true });
    createMcpHostWake(atKey.deps).notifier.wake(wake);
    await vi.waitFor(() => expect(waits(atKey.calls)).toHaveLength(1));
    await flush();
    expect(sendKeys(atKey.calls)).toHaveLength(0);
  });

  it("drops the prompt pipeline itself once the session is closed", async () => {
    // The combined pipeline signal is already aborted: no identity read and
    // no `agent prompt` write — nothing outlives shutdown.
    const session = new AbortController();
    session.abort();
    const { deps, calls, prompts } = harness({ session });
    createMcpHostWake(deps).notifier.wake(wake);
    await flush();
    expect(calls).toHaveLength(0);
    expect(prompts).toHaveLength(0);
  });

  it("coalesces a burst of queued wakes into one wait and one Enter", async () => {
    let release!: () => void;
    const latch = new Promise<void>((resolve) => { release = resolve; });
    const { deps, calls, prompts } = harness({ agentStatus: "working", paneViews: [QUEUED, QUEUED, DRAINED], holdWait: latch });
    const host = createMcpHostWake(deps);
    host.notifier.wake(wake);
    host.notifier.wake(wake);
    host.notifyJobTerminal(waitDetail());
    // All three writes queue while the shared flush is still held in its wait.
    await vi.waitFor(() => expect(prompts).toHaveLength(3));
    await vi.waitFor(() => expect(waits(calls)).toHaveLength(1));
    release();
    await vi.waitFor(() => expect(sendKeys(calls)).toHaveLength(1));
    expect(waits(calls)).toHaveLength(1);
  });

  it("swallows flush failures and never flushes a pi or idle-state wake", async () => {
    const waitFail = harness({ agentStatus: "working", waitError: new Error("gone") });
    createMcpHostWake(waitFail.deps).notifier.wake(wake);
    await vi.waitFor(() => expect(waits(waitFail.calls)).toHaveLength(1));
    await flush();
    expect(waitFail.prompts).toHaveLength(1);
    expect(sendKeys(waitFail.calls)).toHaveLength(0);

    const keysFail = harness({ agentStatus: "working", paneViews: [QUEUED, QUEUED], sendKeysError: new Error("gone") });
    createMcpHostWake(keysFail.deps).notifier.wake(wake);
    await vi.waitFor(() => expect(sendKeys(keysFail.calls)).toHaveLength(1));
    await flush();

    // Pi steers a mid-turn write; no flush follows it.
    const pi = harness({ resolvedKind: "pi", agentStatus: "working" });
    createMcpHostWake(pi.deps).notifier.wake(wake);
    await vi.waitFor(() => expect(pi.prompts).toHaveLength(1));
    await flush();
    expect(waits(pi.calls)).toHaveLength(0);
    expect(sendKeys(pi.calls)).toHaveLength(0);

    // An idle devin pane takes the write directly; nothing queues to flush.
    const idle = harness({ agentStatus: "idle", paneView: QUEUED });
    createMcpHostWake(idle.deps).notifier.wake(wake);
    await vi.waitFor(() => expect(idle.prompts).toHaveLength(1));
    await flush();
    expect(waits(idle.calls)).toHaveLength(0);
    expect(sendKeys(idle.calls)).toHaveLength(0);
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
    host.notifyJobTerminal(waitDetail({ kind: "supervisor" as never, request: { kind: "supervisor", label: "sup", targets: ["worker"], targetIds: [], child: { agentName: "worker", agentKind: "pi", operatingPointId: "worker-pi" }, settings: { reviewCadenceMinutes: 1, reviewerModel: "testmodel", reviewerThinking: "max" } } }));
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

describe("lazy self-adoption in the MCP host wake", () => {
  const selfSession = { source: "herdr:devin", agent: "devin", kind: "id", value: "s-unnamed" };

  interface SelfAdoptOptions {
    kind?: string;
    agentStatus?: string;
    /** The pane id this session hosts; ":::" exercises the underivable-name refusal. */
    paneId?: string;
    /** Records carry a name already (hand-named pane — the gate never fires). */
    named?: boolean;
    /** Only the kind-resolution read is nameless; later reads are named (race). */
    lateName?: boolean;
    /** Agent/pane records lack agent_session entirely — the gap is not name-only. */
    sessionless?: boolean;
    /** Names held by other panes — `agent rename` answers agent_name_taken. */
    taken?: string[];
    /** Fail the first N `api snapshot` calls inside the adopt attempt. */
    snapshotFailures?: number;
    /** A non-collision rename error (agent_not_found) — transient, retried. */
    renameTransient?: boolean;
    /** The rename ack carries a name other than the one requested. */
    mismatchName?: string;
    /** Provenance token write fails — adoption still stands. */
    metadataFails?: boolean;
  }

  interface SelfAdoptHarness {
    deps: McpHostWakeDeps;
    calls: string[][];
    renames: string[];
    prompts: Array<{ target: string; text: string }>;
  }

  function selfAdoptHarness(options: SelfAdoptOptions = {}): SelfAdoptHarness {
    const kind = options.kind ?? "devin";
    const status = options.agentStatus ?? "idle";
    const paneId = options.paneId ?? ownPaneId;
    const calls: string[][] = [];
    const renames: string[] = [];
    const prompts: Array<{ target: string; text: string }> = [];
    const named = options.named === true || options.lateName === true;
    const pane: Record<string, unknown> = {
      pane_id: paneId, tab_id: "w1:t1", workspace_id: "w1", label: "manager",
      agent: kind, terminal_id: "term-9",
      agent_status: status, revision: 7,
      ...(options.sessionless === true ? {} : { agent_session: { ...selfSession, agent: kind } }),
      ...(named ? { agent_name: "manual-name" } : {})
    };
    const agent: Record<string, unknown> = {
      pane_id: paneId, agent: kind, terminal_id: "term-9",
      agent_status: status, revision: 7,
      ...(options.sessionless === true ? {} : { agent_session: { ...selfSession, agent: kind } }),
      ...(named ? { name: "manual-name" } : {})
    };
    // Every read returns a point-in-time copy so a mint mid-flight cannot leak
    // backwards into records the attempt already sampled.
    const snapshotResultNow = () => ({
      type: "session_snapshot",
      snapshot: {
        version: "0.9.0", protocol: 22,
        workspaces: [{ workspace_id: "w1", label: "w" }],
        tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "t" }],
        panes: [{ ...pane }],
        agents: [{ ...agent }]
      }
    });
    const envelope = (id: string, result: unknown): JsonEnvelope => ({ id, result });
    let snapshotFailures = options.snapshotFailures ?? 0;
    let firstPaneGet = options.lateName === true;
    const nameTaken = (name: string) => Object.assign(new Error(`name taken: ${name}`), {
      details: { errorEnvelope: { id: "r", error: { code: "agent_name_taken", message: "name taken" } } }
    });
    const cli: McpWakeCli & DevinQueueFlushCli = {
      runJson: async (argv, signal) => {
        if (signal.aborted) throw new Error("aborted");
        calls.push(argv);
        if (argv[0] === "pane" && argv[1] === "get") {
          if (firstPaneGet) {
            firstPaneGet = false;
            const nameless = { ...pane };
            delete nameless.agent_name;
            delete nameless.name;
            return envelope("pane-get", { pane: nameless });
          }
          return envelope("pane-get", { pane: { ...pane } });
        }
        if (argv[0] === "pane" && argv[1] === "current") return envelope("pane-current", { type: "pane_current", pane: { ...pane } });
        if (argv[0] === "api" && argv[1] === "snapshot") {
          if (snapshotFailures > 0) {
            snapshotFailures -= 1;
            throw new Error("backend down");
          }
          return envelope("snapshot", snapshotResultNow());
        }
        if (argv[0] === "agent" && argv[1] === "get") return envelope("agent-get", { agent: { ...agent } });
        if (argv[0] === "agent" && argv[1] === "rename") {
          const name = argv[3]!;
          renames.push(name);
          if (options.renameTransient === true) {
            options.renameTransient = false;
            throw Object.assign(new Error("no agent"), { details: { errorEnvelope: { id: "r", error: { code: "agent_not_found", message: "no agent" } } } });
          }
          if (options.taken?.includes(name)) throw nameTaken(name);
          if (options.mismatchName !== undefined) {
            // The ack claims a different name than the one minted — the pane's
            // own records stay nameless so the join's lone supplied name is the
            // ack's, and the adopted-name check refuses.
            return envelope("rename", { type: "agent_info", agent: { ...agent, name: options.mismatchName } });
          }
          agent.name = name;
          pane.agent_name = name;
          return envelope("rename", { type: "agent_info", agent: { ...agent } });
        }
        if (argv[0] === "pane" && argv[1] === "report-metadata") {
          if (options.metadataFails === true) throw new Error("metadata offline");
          return envelope("metadata", { ok: true });
        }
        if (argv[0] === "agent" && argv[1] === "wait") return envelope("agent-wait", { type: "agent_info", agent });
        throw new Error(`unexpected argv: ${argv.join(" ")}`);
      },
      runTextResult: async (argv, signal) => {
        if (signal.aborted) throw new Error("aborted");
        calls.push(argv);
        return { value: "", truncated: false };
      },
      prompt: async (target, text) => {
        prompts.push({ target, text });
        // A detected/adopted pane's ack has no interactive_ready — only the
        // required agent_status proves the live detected agent.
        return envelope("prompt-1", {
          type: "agent_prompted",
          agent: {
            pane_id: paneId, terminal_id: "term-9", name: agent.name, agent: kind,
            agent_session: { ...selfSession, agent: kind }, agent_status: status, revision: 8
          }
        });
      }
    };
    const lockDir = mkdtempSync(join(tmpdir(), "herdr-wake-locks-"));
    lockDirs.push(lockDir);
    const queueFlush = createDevinQueueFlush({ cli, guard: createPaneWriteGuard({ namespace: { dir: lockDir, endpoint: "herdr-test-endpoint" } }), sectionWaitMs: 500 });
    queueFlush.begin();
    return {
      deps: {
        cli,
        context: { workspaceId: "w1", tabId: "w1:t1", paneId },
        signal: new AbortController().signal,
        queueFlush
      },
      calls,
      renames,
      prompts
    };
  }

  it("mints the derived name once, then the wake self-prompts through the detection-proven ack", async () => {
    const h = selfAdoptHarness();
    const host = createMcpHostWake(h.deps);
    host.notifier.wake(wake);
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    expect(h.renames).toEqual(["devin-w1p9"]);
    expect(h.calls).toContainEqual([
      "pane", "report-metadata", ownPaneId, "--source", "herdr-tools",
      "--token", "identity_provenance=adopted", "--token", `identity_actor=${ownPaneId}`, "--token", "identity_session=s-unnamed"
    ]);
    expect(h.prompts[0]!.text).toContain("[HERDR AGENT MESSAGE v1]");
    // The minted outcome is memoized: a second wake re-reads nothing for adoption.
    host.notifier.wake(wake);
    await vi.waitFor(() => expect(h.prompts).toHaveLength(2));
    expect(h.renames).toHaveLength(1);
    expect(h.calls.filter((argv) => argv[0] === "api" && argv[1] === "snapshot")).toHaveLength(3);
  });

  it("never touches a pane already named by hand", async () => {
    const h = selfAdoptHarness({ named: true });
    createMcpHostWake(h.deps).notifier.wake(wake);
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    expect(h.renames).toHaveLength(0);
    expect(h.calls.filter((argv) => argv[0] === "pane" && argv[1] === "report-metadata")).toHaveLength(0);
  });

  it("adopts nothing when a name arrives between resolution and the attempt", async () => {
    const h = selfAdoptHarness({ lateName: true });
    createMcpHostWake(h.deps).notifier.wake(wake);
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    expect(h.renames).toHaveLength(0);
  });

  it.each(["agy", "hermes"] as const)("stays inert for an unnamed %s pane — the kind gate is an allowlist", async (kind) => {
    const h = selfAdoptHarness({ kind });
    const host = createMcpHostWake(h.deps);
    host.notifier.wake(wake);
    await flush();
    expect(h.renames).toHaveLength(0);
    expect(h.prompts).toHaveLength(0);
  });

  it("mints a name for an unnamed claude pane even though the wake itself now drops", async () => {
    // The mint buys the claude pane inbound reachability; the wake send is
    // gone with the Channels path (N5.2), so no prompt or send follows it.
    const h = selfAdoptHarness({ kind: "claude" });
    createMcpHostWake(h.deps).notifier.wake(wake);
    await vi.waitFor(() => expect(h.renames).toEqual(["claude-w1p9"]));
    await flush();
    expect(h.prompts).toHaveLength(0);
  });

  it("fails closed without minting when the missing field is not the name", async () => {
    const h = selfAdoptHarness({ sessionless: true });
    const host = createMcpHostWake(h.deps);
    host.notifier.wake(wake);
    await vi.waitFor(() => expect(h.calls.filter((argv) => argv[0] === "api" && argv[1] === "snapshot")).toHaveLength(2));
    await flush();
    expect(h.renames).toHaveLength(0);
    expect(h.prompts).toHaveLength(0);
    // "unqualified" is not cached — the next wake re-evaluates and still refuses.
    host.notifier.wake(wake);
    await vi.waitFor(() => expect(h.calls.filter((argv) => argv[0] === "api" && argv[1] === "snapshot")).toHaveLength(4));
    await flush();
    expect(h.renames).toHaveLength(0);
    expect(h.prompts).toHaveLength(0);
  });

  it("walks the collision suffixes when the derived name is taken", async () => {
    const h = selfAdoptHarness({ taken: ["devin-w1p9", "devin-w1p9-2"] });
    createMcpHostWake(h.deps).notifier.wake(wake);
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    expect(h.renames).toEqual(["devin-w1p9", "devin-w1p9-2", "devin-w1p9-3"]);
  });

  it("stays inert permanently once every suffix is taken", async () => {
    const h = selfAdoptHarness({ taken: Array.from({ length: 9 }, (_, i) => (i === 0 ? "devin-w1p9" : `devin-w1p9-${i + 1}`)) });
    const host = createMcpHostWake(h.deps);
    host.notifier.wake(wake);
    await vi.waitFor(() => expect(h.renames).toHaveLength(9));
    await flush();
    expect(h.prompts).toHaveLength(0);
    host.notifier.wake(wake);
    await flush();
    expect(h.renames).toHaveLength(9);
    expect(h.prompts).toHaveLength(0);
  });

  it("retries after a transient read failure and after a non-collision rename error", async () => {
    const h = selfAdoptHarness({ snapshotFailures: 1 });
    const host = createMcpHostWake(h.deps);
    host.notifier.wake(wake);
    // The failed attempt is not cached: this wake still drops on the missing
    // name. Its drop is final once the send's sandwich `pane get` has run —
    // the write section makes the pipeline's reads genuinely async, so settle
    // on that last call rather than a fixed yield.
    await vi.waitFor(() => expect(h.calls.filter((argv) => argv[0] === "pane" && argv[1] === "get")).toHaveLength(2));
    await flush();
    expect(h.renames).toHaveLength(0);
    expect(h.prompts).toHaveLength(0);
    // …and the next wake re-runs the whole attempt, mints, and delivers.
    host.notifier.wake(wake);
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    expect(h.renames).toEqual(["devin-w1p9"]);

    const raced = selfAdoptHarness({ renameTransient: true });
    const racedHost = createMcpHostWake(raced.deps);
    racedHost.notifier.wake(wake);
    // Settle the dropped pipeline on its last read before asserting the drop —
    // kind resolution, the failed attempt's own read, then the send sandwich.
    await vi.waitFor(() => expect(raced.calls.filter((argv) => argv[0] === "pane" && argv[1] === "get")).toHaveLength(3));
    await flush();
    expect(raced.renames).toEqual(["devin-w1p9"]);
    expect(raced.prompts).toHaveLength(0);
    racedHost.notifier.wake(wake);
    await vi.waitFor(() => expect(raced.prompts).toHaveLength(1));
    expect(raced.renames).toEqual(["devin-w1p9", "devin-w1p9"]);
  });

  it("drops the wake when the minted ack cannot verify the adopted name", async () => {
    const h = selfAdoptHarness({ mismatchName: "other-name" });
    createMcpHostWake(h.deps).notifier.wake(wake);
    await vi.waitFor(() => expect(h.renames).toEqual(["devin-w1p9"]));
    await flush();
    expect(h.prompts).toHaveLength(0);
  });

  it("keeps the adoption when the advisory token write fails", async () => {
    const h = selfAdoptHarness({ metadataFails: true });
    createMcpHostWake(h.deps).notifier.wake(wake);
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    expect(h.renames).toEqual(["devin-w1p9"]);
  });

  it("refuses permanently when no valid name can be derived from the pane id", async () => {
    const h = selfAdoptHarness({ paneId: ":::" });
    const host = createMcpHostWake(h.deps);
    host.notifier.wake(wake);
    await vi.waitFor(() => expect(h.calls.filter((argv) => argv[0] === "api" && argv[1] === "snapshot")).toHaveLength(2));
    await flush();
    expect(h.renames).toHaveLength(0);
    expect(h.prompts).toHaveLength(0);
    host.notifier.wake(wake);
    // The "refused" outcome is memoized: the second wake pays only the context
    // read — one more snapshot, never another adoption attempt.
    await vi.waitFor(() => expect(h.calls.filter((argv) => argv[0] === "api" && argv[1] === "snapshot")).toHaveLength(3));
    await flush();
    expect(h.prompts).toHaveLength(0);
  });
});
