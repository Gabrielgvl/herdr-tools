import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonEnvelope } from "../../src/cli.js";
import {
  createDevinQueueFlush,
  queueFlushEligible,
  type DevinQueueFlush,
  type DevinQueueFlushCli,
} from "../../src/messages/devin-queue-flush.js";
import type { PromptSubmissionEvidence, PromptTargetIdentity } from "../../src/messages/prompt.js";
import { createPaneWriteGuard, PaneWriteLockError, type PaneWriteGuard } from "../../src/pane-write-lock.js";

const RULE = `\x1b[0m\x1b[38;2;68;68;68m${"─".repeat(60)}\x1b[0m`;
const GRAY = "\x1b[38;2;124;124;124m";
const RESET = "\x1b[0m";
const HINT = `${RESET}${GRAY}Press Enter to send queued messages now${RESET}`;
const PLACEHOLDER = `${RESET}${GRAY}Guide Devin while it works${RESET}`;
/** Minimal rendered Devin composer: rule / optional section rows / `❭` input / rule / status. */
const composerView = (input = PLACEHOLDER, section = ""): string =>
  `agent output\n⠀ Running tools\n${RULE}\n${section}❭ ${input}\n${RULE}\nSWE-2 Max   Context: 9%\n`;
const QUEUED = composerView(HINT);
/** A still-queued frame whose box interior differs — a distinct frame digest. */
const QUEUED_MORE = composerView(HINT, "2 queued · Enter to send\n");
const QUEUED_THIRD = composerView(HINT, "3 queued · Enter to send\n");
const DRAINED = composerView();
const DRAFT = composerView("typed draft");
const GARBAGE = "no composer here\n";

const session = { source: "herdr:test", agent: "devin", kind: "id", value: "s-1" } as const;
const otherSession = { source: "herdr:test", agent: "devin", kind: "id", value: "s-2" } as const;
const PANE = "w1:p9";

const identityFor = (paneId: string, sess = session): PromptTargetIdentity => ({
  paneId,
  terminalId: `term-${paneId}`,
  agentName: "manager",
  agentKind: "devin",
  agentSession: sess,
});
const submissionFor = (paneId: string, sess = session, operationId = "op-1"): PromptSubmissionEvidence => ({
  ...identityFor(paneId, sess),
  confirmed: true,
  operationId,
  interactiveReady: true,
  interactiveProof: "managed",
  revision: 8,
});
const submission = submissionFor(PANE);
const piSubmission: PromptSubmissionEvidence = { ...submission, agentKind: "pi" };

const sendKeys = (calls: string[][]): string[][] => calls.filter((argv) => argv[0] === "agent" && argv[1] === "send-keys");
const waits = (calls: string[][]): string[][] => calls.filter((argv) => argv[0] === "agent" && argv[1] === "wait");
const reads = (calls: string[][]): string[][] => calls.filter((argv) => argv[0] === "pane" && argv[1] === "read");

/** A held operation must notice the cycle abort like a real transport would. */
function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(new Error("aborted"));
    else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

interface CliOptions {
  /** Successive `pane read` payloads; `paneView` is the fallback once drained. */
  paneViews?: string[];
  /** Per-pane `pane read` payload queues, overriding paneViews for that pane. */
  paneViewsFor?: Record<string, string[]>;
  paneView?: string;
  /** Every `pane read` reports a truncated capture. */
  truncated?: boolean;
  /** agent_status served by the fresh identity/state join. */
  agentStatus?: string;
  /** Session value served by the fresh join; defaults to the submission's. */
  sessionId?: { source: string; agent: string; kind: string; value: string };
  waitError?: Error;
  /** Reject this many leading `agent wait` calls before serving. */
  waitFailures?: number;
  /** Hold `agent wait` until this promise resolves (or the cycle aborts). */
  holdWait?: Promise<void>;
  /** Hold the first `pane read` until this promise resolves. */
  holdRead?: Promise<void>;
  sendKeysError?: Error;
  /** Called inside the first `agent wait` handler before it resolves. */
  onWait?: () => void;
  guard?: PaneWriteGuard;
  sectionWaitMs?: number;
  namespaceDir?: string;
}

function makeCli(options: CliOptions): { cli: DevinQueueFlushCli; calls: string[][] } {
  const calls: string[][] = [];
  const readIndexByPane = new Map<string, number>();
  let readCalls = 0;
  let waitCalls = 0;
  const status = options.agentStatus ?? "idle";
  const sess = options.sessionId ?? session;
  const envelope = (id: string, result: unknown): JsonEnvelope => ({ id, result });
  const agentRecord = (paneId: string) => ({
    pane_id: paneId,
    name: "manager",
    agent: "devin",
    terminal_id: `term-${paneId}`,
    agent_session: sess,
    agent_status: status,
    revision: 7,
  });
  const paneRecord = (paneId: string) => ({
    pane_id: paneId,
    tab_id: "w1:t1",
    workspace_id: "w1",
    agent_name: "manager",
    agent: "devin",
    terminal_id: `term-${paneId}`,
    agent_session: sess,
    agent_status: status,
    revision: 7,
  });
  const cli: DevinQueueFlushCli = {
    runJson: async (argv, signal) => {
      if (signal.aborted) throw new Error("aborted");
      calls.push(argv);
      if (argv[0] === "agent" && argv[1] === "wait") {
        waitCalls += 1;
        if (waitCalls <= (options.waitFailures ?? 0)) throw options.waitError ?? new Error("wait failed");
        if (options.holdWait) await Promise.race([options.holdWait, aborted(signal)]);
        options.onWait?.();
        return envelope("agent-wait", { agent: agentRecord(argv[2]!) });
      }
      if (argv[0] === "agent" && argv[1] === "get") return envelope("agent-get", { agent: agentRecord(argv[2]!) });
      if (argv[0] === "pane" && argv[1] === "get") return envelope("pane-get", { pane: paneRecord(argv[2]!) });
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
        const paneId = argv[2]!;
        const views = options.paneViewsFor?.[paneId] ?? options.paneViews;
        const index = readIndexByPane.get(paneId) ?? 0;
        readIndexByPane.set(paneId, index + 1);
        const callIndex = readCalls;
        readCalls += 1;
        if (callIndex === 0 && options.holdRead) await Promise.race([options.holdRead, aborted(signal)]);
        const value = views !== undefined && index < views.length ? views[index]! : (options.paneView ?? "");
        return { value, truncated: options.truncated ?? false };
      }
      throw new Error(`unexpected argv: ${argv.join(" ")}`);
    },
  };
  return { cli, calls };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeCoordinator(options: CliOptions = {}): { queueFlush: DevinQueueFlush; calls: string[][]; dir: string } {
  const { cli, calls } = makeCli(options);
  const dir = options.namespaceDir ?? mkdtempSync(join(tmpdir(), "herdr-flush-"));
  dirs.push(dir);
  const queueFlush = createDevinQueueFlush({
    cli,
    guard: options.guard ?? createPaneWriteGuard({ namespace: { dir, endpoint: "herdr-test-endpoint" } }),
    ...(options.sectionWaitMs === undefined ? {} : { sectionWaitMs: options.sectionWaitMs }),
  });
  return { queueFlush, calls, dir };
}

async function settle(queueFlush: DevinQueueFlush): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
  await queueFlush.shutdown();
}

describe("queueFlushEligible", () => {
  it.each([
    ["devin", "working", true],
    ["devin", "blocked", true],
    ["devin", "idle", false],
    ["devin", "done", false],
    ["devin", "unknown", false],
    ["pi", "working", false],
    ["claude", "blocked", false],
  ] as const)("returns %s for a %s submission acknowledged while %s", (agentKind, sentState, expected) => {
    expect(queueFlushEligible({ ...submission, agentKind }, sentState)).toBe(expected);
  });
});

describe("createDevinQueueFlush", () => {
  it("ignores schedules outside a live session and ineligible requests entirely", async () => {
    const { queueFlush, calls } = makeCoordinator();
    // Before begin: no session.
    queueFlush.schedule({ submission, sentState: "working" });
    await queueFlush.shutdown();
    queueFlush.begin();
    // Non-Devin and non-busy acks never start a cycle.
    queueFlush.schedule({ submission: piSubmission, sentState: "working" });
    queueFlush.schedule({ submission, sentState: "idle" });
    queueFlush.schedule({ submission, sentState: "done" });
    // A write section is still available for participating text writes.
    const lease = await queueFlush.writeSection(PANE);
    await lease.release();
    await queueFlush.shutdown();
    // After shutdown: dropped, never dispatched.
    queueFlush.schedule({ submission, sentState: "working" });
    await settle(queueFlush);
    expect(calls.filter((argv) => argv[0] === "agent")).toHaveLength(0);
  });

  it("dispatches exactly one Enter after the bounded wait, under fresh proofs", async () => {
    const { queueFlush, calls } = makeCoordinator({ paneViews: [QUEUED, QUEUED], sectionWaitMs: 2_000 });
    queueFlush.begin();
    queueFlush.schedule({ submission, sentState: "working" });
    await vi.waitFor(() => expect(sendKeys(calls)).toHaveLength(1));
    expect(waits(calls)).toEqual([["agent", "wait", PANE, "--until", "idle", "--until", "done", "--timeout", "110000"]]);
    // wait → candidate composer → fresh identity/state join → final ANSI proof
    // → Enter. The press loop then pays one more candidate read, which parses
    // to nothing (the pane read fallback is empty) and ends the cycle.
    await vi.waitFor(() => expect(reads(calls)).toHaveLength(3));
    const order = calls.map((argv) => argv.slice(0, 2).join(" "));
    expect(order).toEqual(["agent wait", "pane read", "agent get", "pane get", "pane read", "agent send-keys", "pane read"]);
    await settle(queueFlush);
  });

  it("coalesces an ack landing inside the wait into the running cycle", async () => {
    let releaseWait!: () => void;
    const holdWait = new Promise<void>((resolve) => { releaseWait = resolve; });
    const { queueFlush, calls } = makeCoordinator({ holdWait, paneViews: [QUEUED, QUEUED] });
    queueFlush.begin();
    queueFlush.schedule({ submission, sentState: "working" });
    await vi.waitFor(() => expect(waits(calls)).toHaveLength(1));
    // A second ack joins the waiting cycle instead of queueing a new one.
    queueFlush.schedule({ submission: submissionFor(PANE, session, "op-2"), sentState: "blocked" });
    releaseWait();
    await vi.waitFor(() => expect(sendKeys(calls)).toHaveLength(1));
    expect(waits(calls)).toHaveLength(1);
    await settle(queueFlush);
  });

  it("chains exactly one follow-up cycle behind a draining cycle and coalesces the rest", async () => {
    let releaseRead!: () => void;
    const holdRead = new Promise<void>((resolve) => { releaseRead = resolve; });
    const { queueFlush, calls } = makeCoordinator({ holdRead, paneViews: [QUEUED, QUEUED, QUEUED_MORE, QUEUED_MORE] });
    queueFlush.begin();
    queueFlush.schedule({ submission, sentState: "working" });
    // The running cycle is past its wait, parked on the locked candidate read.
    await vi.waitFor(() => expect(reads(calls)).toHaveLength(1));
    queueFlush.schedule({ submission, sentState: "working" });
    queueFlush.schedule({ submission, sentState: "working" });
    releaseRead();
    // Cycle one presses the first frame; the single pending follow-up presses
    // the distinct second frame — there is no third cycle.
    await vi.waitFor(() => expect(sendKeys(calls)).toHaveLength(2));
    expect(waits(calls)).toHaveLength(2);
    await settle(queueFlush);
  });

  it("serializes cycles per pane but never blocks one pane behind another", async () => {
    const { queueFlush, calls } = makeCoordinator({ paneViewsFor: { [PANE]: [QUEUED, QUEUED], "w1:p10": [QUEUED_MORE, QUEUED_MORE] } });
    queueFlush.begin();
    queueFlush.schedule({ submission, sentState: "working" });
    queueFlush.schedule({ submission: submissionFor("w1:p10"), sentState: "blocked" });
    await vi.waitFor(() => expect(sendKeys(calls)).toHaveLength(2));
    expect(sendKeys(calls).map((argv) => argv[2]).sort()).toEqual(["w1:p10", PANE]);
    await settle(queueFlush);
  });

  it("excludes a held write section from the proof/key section", async () => {
    const { queueFlush, calls } = makeCoordinator({ paneViews: [QUEUED, QUEUED], sectionWaitMs: 2_000 });
    queueFlush.begin();
    const write = await queueFlush.writeSection(PANE);
    queueFlush.schedule({ submission, sentState: "working" });
    await vi.waitFor(() => expect(waits(calls)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(sendKeys(calls)).toHaveLength(0);
    await write.release();
    await vi.waitFor(() => expect(sendKeys(calls)).toHaveLength(1));
    await settle(queueFlush);
  });
});

describe("the per-press proof", () => {
  it("refuses when the fresh occupant is not the acknowledged identity", async () => {
    const { queueFlush, calls } = makeCoordinator({ paneViews: [QUEUED, QUEUED], sessionId: otherSession });
    queueFlush.begin();
    queueFlush.schedule({ submission, sentState: "working" });
    // The candidate read and the fresh join both ran; the join refused the key.
    await vi.waitFor(() => expect(calls.filter((argv) => argv[1] === "get")).toHaveLength(2));
    await settle(queueFlush);
    expect(sendKeys(calls)).toHaveLength(0);
    expect(reads(calls)).toHaveLength(1);
  });

  it("refuses a busy fresh state even with a queued composer", async () => {
    const { queueFlush, calls } = makeCoordinator({ paneViews: [QUEUED, QUEUED], agentStatus: "working" });
    queueFlush.begin();
    queueFlush.schedule({ submission, sentState: "working" });
    await vi.waitFor(() => expect(calls.filter((argv) => argv[1] === "get")).toHaveLength(2));
    await settle(queueFlush);
    expect(sendKeys(calls)).toHaveLength(0);
  });

  it("refuses a truncated capture", async () => {
    const { queueFlush, calls } = makeCoordinator({ paneView: QUEUED, truncated: true });
    queueFlush.begin();
    queueFlush.schedule({ submission, sentState: "working" });
    await vi.waitFor(() => expect(reads(calls)).toHaveLength(1));
    await settle(queueFlush);
    expect(sendKeys(calls)).toHaveLength(0);
  });

  it.each([
    ["unparseable", GARBAGE],
    ["no longer queued", DRAINED],
    ["carrying a draft", DRAFT],
    ["repainted to a different frame", QUEUED_MORE],
  ] as const)("refuses a final proof that is %s", async (_label, finalView) => {
    const { queueFlush, calls } = makeCoordinator({ paneViews: [QUEUED, finalView] });
    queueFlush.begin();
    queueFlush.schedule({ submission, sentState: "working" });
    await vi.waitFor(() => expect(reads(calls)).toHaveLength(2));
    await settle(queueFlush);
    expect(sendKeys(calls)).toHaveLength(0);
  });

  it("stops at an identical repaint and never presses a third frame", async () => {
    // Press two: the candidate reads back the frame just keyed — repaint lag, not a live queue.
    const stale = makeCoordinator({ paneViews: [QUEUED, QUEUED, QUEUED] });
    stale.queueFlush.begin();
    stale.queueFlush.schedule({ submission, sentState: "working" });
    await vi.waitFor(() => expect(sendKeys(stale.calls)).toHaveLength(1));
    await vi.waitFor(() => expect(reads(stale.calls)).toHaveLength(3));
    await settle(stale.queueFlush);
    expect(sendKeys(stale.calls)).toHaveLength(1);

    // Two distinct proven frames earn both keys; the press cap then ends the cycle.
    const capped = makeCoordinator({ paneViews: [QUEUED, QUEUED, QUEUED_MORE, QUEUED_MORE], paneView: QUEUED_THIRD });
    capped.queueFlush.begin();
    capped.queueFlush.schedule({ submission, sentState: "working" });
    await vi.waitFor(() => expect(sendKeys(capped.calls)).toHaveLength(2));
    await settle(capped.queueFlush);
    expect(reads(capped.calls)).toHaveLength(4);
  });
});

describe("the spent-frame fence", () => {
  it("refuses a spent frame across cycles and coordinator instances, and rearms only on a fresh non-queued proof", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-flush-shared-"));
    dirs.push(dir);
    // Cycle one presses QUEUED and records its frame digest under the lock.
    const first = makeCoordinator({ paneViews: [QUEUED, QUEUED], namespaceDir: dir });
    first.queueFlush.begin();
    first.queueFlush.schedule({ submission, sentState: "working" });
    await vi.waitFor(() => expect(sendKeys(first.calls)).toHaveLength(1));
    await settle(first.queueFlush);

    // A different coordinator over the same namespace sees the spent frame —
    // the fence, not the in-memory state, carries the fact across hosts.
    const second = makeCoordinator({ paneViews: [QUEUED, QUEUED], paneView: QUEUED, namespaceDir: dir });
    second.queueFlush.begin();
    second.queueFlush.schedule({ submission, sentState: "working" });
    await vi.waitFor(() => expect(reads(second.calls)).toHaveLength(2));
    await settle(second.queueFlush);
    expect(sendKeys(second.calls)).toHaveLength(0);

    // Only a fresh identity-bound positively parsed non-queued composer rearms.
    const third = makeCoordinator({ paneViews: [DRAINED, QUEUED, QUEUED], paneView: QUEUED, namespaceDir: dir });
    third.queueFlush.begin();
    third.queueFlush.schedule({ submission, sentState: "working" });
    await vi.waitFor(() => expect(reads(third.calls)).toHaveLength(1));
    third.queueFlush.schedule({ submission, sentState: "working" });
    await vi.waitFor(() => expect(sendKeys(third.calls)).toHaveLength(1));
    // The rearm cycle itself never keys; the follow-up presses the same frame
    // again, then reads one identical repaint candidate and stops.
    await vi.waitFor(() => expect(reads(third.calls)).toHaveLength(4));
    await settle(third.queueFlush);
  });

  it("records before dispatch so an uncertain key cannot invite a retry", async () => {
    const { queueFlush, calls } = makeCoordinator({ paneViews: [QUEUED, QUEUED], paneView: QUEUED, sendKeysError: new Error("PTY write failed") });
    queueFlush.begin();
    queueFlush.schedule({ submission, sentState: "working" });
    await vi.waitFor(() => expect(sendKeys(calls)).toHaveLength(1));
    // The failed Enter already spent the frame: the next cycle refuses it.
    queueFlush.schedule({ submission, sentState: "working" });
    await vi.waitFor(() => expect(reads(calls)).toHaveLength(4));
    await settle(queueFlush);
    expect(sendKeys(calls)).toHaveLength(1);
  });

  it("fails the press closed when the lock is unavailable", async () => {
    const guard: PaneWriteGuard = {
      acquire: async () => { throw new PaneWriteLockError("Pane write lock was unavailable"); },
    };
    const { queueFlush, calls } = makeCoordinator({ paneViews: [QUEUED, QUEUED], guard });
    queueFlush.begin();
    queueFlush.schedule({ submission, sentState: "working" });
    await settle(queueFlush);
    expect(sendKeys(calls)).toHaveLength(0);
  });
});

describe("cancellation", () => {
  it("dispatches no key when shutdown lands inside the wait", async () => {
    let releaseWait!: () => void;
    const holdWait = new Promise<void>((resolve) => { releaseWait = resolve; });
    const { queueFlush, calls } = makeCoordinator({ holdWait, paneViews: [QUEUED, QUEUED] });
    queueFlush.begin();
    queueFlush.schedule({ submission, sentState: "working" });
    await vi.waitFor(() => expect(waits(calls)).toHaveLength(1));
    const stopping = queueFlush.shutdown();
    releaseWait();
    await stopping;
    await settle(queueFlush);
    expect(sendKeys(calls)).toHaveLength(0);
  });

  it("stops between the wait and the proof when the session ends there", async () => {
    // onWait fires inside the first cycle's wait, after the coordinator exists.
    const { queueFlush, calls } = makeCoordinator({ paneViews: [QUEUED, QUEUED], onWait: () => void queueFlush.shutdown() });
    queueFlush.begin();
    queueFlush.schedule({ submission, sentState: "working" });
    await settle(queueFlush);
    expect(sendKeys(calls)).toHaveLength(0);
    expect(reads(calls)).toHaveLength(0);
  });

  it("stops between the final proof and the key when the session ends there", async () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-flush-abort-"));
    dirs.push(dir);
    const realGuard = createPaneWriteGuard({ namespace: { dir, endpoint: "herdr-test-endpoint" } });
    let spentChecks = 0;
    // The isSpent closure runs inside the first press, after the coordinator exists.
    const guard: PaneWriteGuard = {
      acquire: async (paneId, options) => {
        const lease = await realGuard.acquire(paneId, options);
        return {
          ...lease,
          fence: {
            ...lease.fence,
            isSpent: async (identity, frame) => {
              // Abort lands after the final ANSI proof, before the key.
              spentChecks += 1;
              void queueFlush.shutdown();
              return lease.fence.isSpent(identity, frame);
            },
          },
        };
      },
    };
    const { queueFlush, calls } = makeCoordinator({ paneViews: [QUEUED, QUEUED], guard });
    queueFlush.begin();
    queueFlush.schedule({ submission, sentState: "working" });
    // The fence check is where the abort lands — wait for it so a slow lock
    // acquisition cannot make shutdown win the race before the proof.
    await vi.waitFor(() => expect(spentChecks).toBe(1));
    await settle(queueFlush);
    expect(sendKeys(calls)).toHaveLength(0);
  });

  it("abandons the cycle when the overall budget expires", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const held = new Promise<never>(() => undefined);
      const { queueFlush, calls } = makeCoordinator({ holdWait: held });
      queueFlush.begin();
      queueFlush.schedule({ submission, sentState: "working" });
      for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
      expect(waits(calls)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(120_000);
      await queueFlush.shutdown();
      expect(sendKeys(calls)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("survives a failed cycle: the pane tail stays usable", async () => {
    const { queueFlush, calls } = makeCoordinator({ waitFailures: 1, paneViews: [QUEUED, QUEUED] });
    queueFlush.begin();
    queueFlush.schedule({ submission, sentState: "working" });
    await vi.waitFor(() => expect(waits(calls)).toHaveLength(1));
    queueFlush.schedule({ submission, sentState: "working" });
    await vi.waitFor(() => expect(sendKeys(calls)).toHaveLength(1));
    expect(waits(calls)).toHaveLength(2);
    await settle(queueFlush);
  });
});
