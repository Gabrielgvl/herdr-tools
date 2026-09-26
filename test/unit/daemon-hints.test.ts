/**
 * N2.5: §11 best-effort idle hints, plus the two N2.4 wiring debts.
 *
 * Hint contract: after an event lands, one FRESH `pane get` on the owner pane;
 * exactly one `agent.prompt` (the §11 MCP-surface read pointer) only when the
 * pane is `idle`/`done`, still carries the recorded owner session, and the
 * kind is qualified. Busy, unknown, unproven, unsupported (`agy`), and
 * non-qualified kinds get zero writes; hints coalesce to one per manager per
 * 5 s and never block persistence. An unset qualified set is EMPTY; the
 * stock daemon passes the C9-proved {pi, claude, devin} set (N5.2).
 *
 * Wiring debts: `createOwnership`'s `retarget` reaches live supervisor hint
 * destinations through `SupervisionRegistry.retargetHintDestinations`, and
 * `herdr_status` projects `pendingTransfers` strictly read-only.
 */

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import type { JsonEnvelope, PiExec } from "../../src/cli.js";
import { createHandoffAllocator, type HandoffAllocator, type HandoffTaskContract } from "../../src/handoff.js";
import { createHandoffGate } from "../../src/handoff-gate.js";
import { JobRegistry } from "../../src/job-registry.js";
import type { AgentSessionIdentity } from "../../src/messages/prompt.js";
import type { AgentPromptClient } from "../../src/agent-prompt.js";
import { createIdleHints, IDLE_HINT_COALESCE_MS, type IdleHintEvent, type IdleHintSink } from "../../src/daemon/hints.js";
import { createIntentStore, managerSessionKey } from "../../src/daemon/intents.js";
import { createMailbox, type Mailbox, type MailboxEventWriter } from "../../src/daemon/mailbox.js";
import { daemonRunOwnership } from "../../src/daemon/ownership.js";
import { createDaemonRuntime, type DaemonRuntime } from "../../src/daemon/runtime.js";
import { handleDaemonStatus } from "../../src/daemon/handlers/status.js";
import { SessionEventMonitor } from "../../src/supervision/monitor.js";
import { SupervisionRegistry } from "../../src/supervision/registry.js";
import type { Supervisor } from "../../src/supervision/supervisor.js";
import { parseSocketLine, type SupervisionSocketEvent } from "../../src/supervision/protocol.js";
import type { SupervisedIdentity } from "../../src/supervision/identity.js";
import { scriptedServer } from "./supervision-peer.js";

const dirs: string[] = [];
const runtimes: DaemonRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.supervision.shutdown().catch(() => undefined);
    runtime.jobs.shutdown();
    await runtime.queueFlush.shutdown().catch(() => undefined);
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const ownerSession: AgentSessionIdentity = { source: "herdr:pi", agent: "pi", kind: "id", value: "mgr-owner" };
const successorSession: AgentSessionIdentity = { source: "herdr:pi", agent: "pi", kind: "id", value: "mgr-successor" };
const ownerKey = managerSessionKey(ownerSession);
const childSession: AgentSessionIdentity = { source: "herdr:pi", agent: "pi", kind: "path", value: "/pi/child.jsonl" };
const task: HandoffTaskContract = { objective: "do the thing", scope: "repo", doneWhen: ["it works"], constraints: [], tier: "standard", replicas: 1 };

const ok = (result: unknown): JsonEnvelope => ({ id: "op", result });

async function daemonNamespace() {
  const root = await mkdtemp(join(tmpdir(), "daemon-hints-"));
  dirs.push(root);
  const dir = join(root, "daemon");
  await mkdir(dir, { mode: 0o700 });
  return { root, namespace: { dir, endpoint: join(root, "herdr.sock") } };
}

interface SinkFixture {
  hints: IdleHintSink;
  mailbox: Mailbox;
  namespace: { dir: string; endpoint: string };
  calls: string[][];
  prompts: Array<{ target: string; text: string }>;
  logs: string[];
  advance(ms: number): void;
}

/** A sink-level fixture: scripted `pane get` state and recorded `agent.prompt` calls. */
async function sinkFixture(options: {
  qualifiedKinds?: readonly string[];
  qualifiedSet?: "absent";
  paneStatus?: string;
  /** Omit `agent_status` entirely — an unproven state, not a named one. */
  statusOmitted?: boolean;
  /** `undefined` = the recorded owner session; `"other"` = a foreign session; `null` = sessionless pane. */
  occupantSession?: AgentSessionIdentity | "other" | null;
  paneGetError?: unknown;
  promptError?: unknown;
  /** An outer abort signal folded into the per-delivery timeout. */
  signal?: AbortSignal;
  /** Omit `log` to exercise the default stderr writer. */
  defaultLog?: boolean;
} = {}): Promise<SinkFixture> {
  const { namespace } = await daemonNamespace();
  const mailbox = createMailbox({ namespace });
  const calls: string[][] = [];
  const prompts: SinkFixture["prompts"] = [];
  const logs: string[] = [];
  let nowMs = 1_000_000;
  const occupant = options.occupantSession === "other" ? successorSession : options.occupantSession === null ? null : ownerSession;
  const cli = {
    runJson: async (argv: string[]): Promise<JsonEnvelope> => {
      calls.push(argv);
      if (argv[0] === "pane" && argv[1] === "get") {
        if (options.paneGetError !== undefined) throw options.paneGetError;
        return ok({
          pane: {
            pane_id: argv[2], tab_id: "w1:t1", workspace_id: "w1",
            ...(options.statusOmitted === true ? {} : { agent_status: options.paneStatus ?? "idle" }),
            agent_session: occupant,
          },
        });
      }
      throw new Error(`unexpected argv: ${argv.join(" ")}`);
    },
    prompt: async (target: string, text: string): Promise<JsonEnvelope> => {
      prompts.push({ target, text });
      if (options.promptError !== undefined) throw options.promptError;
      return ok({});
    },
  };
  const hints = createIdleHints({
    cli,
    mailbox,
    namespace,
    ...(options.qualifiedSet === "absent" ? {} : { qualifiedKinds: options.qualifiedKinds ?? ["pi", "claude", "devin"] }),
    now: () => nowMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.defaultLog === true ? {} : { log: (line) => logs.push(line) }),
  });
  return { hints, mailbox, namespace, calls, prompts, logs, advance: (ms) => { nowMs += ms; } };
}

const hint = (owner: IdleHintEvent["owner"] = { paneId: "p-owner", session: ownerSession }): IdleHintEvent => ({
  runId: "11111111-2222-3333-4444-555555555555",
  eventId: "2026-09-25T120000.000Z-11111111-2222-3333-4444-555555555555",
  owner,
});

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

describe("idle hints (§11)", () => {
  it("sends exactly one hint with the §11 MCP-surface body to an idle qualified owner pane", async () => {
    const f = await sinkFixture();
    const first = await f.mailbox.writeGapEvent(ownerKey, { from: "a", to: "b", lost: {} });
    const second = await f.mailbox.writeGapEvent(ownerKey, { from: "b", to: "c", lost: {} });
    if (!first.persisted || !second.persisted) throw new Error("fixture write failed");
    f.hints(hint());
    await vi.waitFor(() => expect(f.prompts).toHaveLength(1));
    const unread = join(f.namespace.dir, "mailbox", ownerKey, "unread");
    const ids = await f.mailbox.list(ownerKey);
    expect(f.prompts).toEqual([{
      target: "p-owner",
      text: `herdr mailbox: 2 unread (${ids.join(", ")}) at ${unread}; read via your MCP surface (herdr_status / executor → MCP)`,
    }]);
    // One fresh pane read, one prompt, nothing else — no Enter, no key synthesis.
    expect(f.calls).toEqual([["pane", "get", "p-owner"]]);
  });

  it("sends to a done pane as well", async () => {
    const f = await sinkFixture({ paneStatus: "done" });
    await f.mailbox.writeGapEvent(ownerKey, { from: "a", to: "b", lost: {} });
    f.hints(hint());
    await vi.waitFor(() => expect(f.prompts).toHaveLength(1));
  });

  it("writes nothing to busy, blocked, or unknown panes — a fresh read each event", async () => {
    for (const status of ["working", "blocked", "unknown"]) {
      const f = await sinkFixture({ paneStatus: status });
      await f.mailbox.writeGapEvent(ownerKey, { from: "a", to: "b", lost: {} });
      f.hints(hint());
      await vi.waitFor(() => expect(f.calls).toEqual([["pane", "get", "p-owner"]]));
      await flush();
      expect(f.prompts).toEqual([]);
    }
  });

  it("writes nothing when the pane state is unproven or the pane no longer carries the owner session", async () => {
    // No agent_status at all: state is unproven.
    const malformed = await sinkFixture({ statusOmitted: true });
    malformed.hints(hint());
    await vi.waitFor(() => expect(malformed.calls).toEqual([["pane", "get", "p-owner"]]));
    await flush();
    expect(malformed.prompts).toEqual([]);

    const rebound = await sinkFixture({ occupantSession: "other" });
    rebound.hints(hint());
    await vi.waitFor(() => expect(rebound.calls).toEqual([["pane", "get", "p-owner"]]));
    await flush();
    expect(rebound.prompts).toEqual([]);

    // An owner recorded without a session is unproven: not even a pane read.
    const sessionless = await sinkFixture();
    sessionless.hints(hint({ paneId: "p-owner", session: null }));
    await flush();
    expect(sessionless.calls).toEqual([]);
    expect(sessionless.prompts).toEqual([]);
  });

  it("never hints unsupported (agy) or non-qualified kinds", async () => {
    const agy: AgentSessionIdentity = { source: "herdr:agy", agent: "agy", kind: "id", value: "mgr-agy" };
    const f = await sinkFixture({ qualifiedKinds: ["pi", "agy"] });
    f.hints(hint({ paneId: "p-agy", session: agy }));
    await flush();
    expect(f.calls).toEqual([]);
    expect(f.prompts).toEqual([]);

    const piOnly = await sinkFixture({ qualifiedKinds: ["pi"] });
    piOnly.hints(hint({ paneId: "p-claude", session: { source: "herdr:claude", agent: "claude", kind: "id", value: "mgr-c" } }));
    await flush();
    expect(piOnly.calls).toEqual([]);
    expect(piOnly.prompts).toEqual([]);
  });

  it("coalesces bursts to one hint per manager per window", async () => {
    const f = await sinkFixture();
    await f.mailbox.writeGapEvent(ownerKey, { from: "a", to: "b", lost: {} });
    f.hints(hint());
    f.hints(hint());
    await vi.waitFor(() => expect(f.prompts).toHaveLength(1));
    f.hints(hint());
    await flush();
    expect(f.calls).toEqual([["pane", "get", "p-owner"]]);
    expect(f.prompts).toHaveLength(1);
    f.advance(IDLE_HINT_COALESCE_MS + 1);
    f.hints(hint());
    await vi.waitFor(() => expect(f.prompts).toHaveLength(2));
  });

  it("drops a failed hint visibly and never retries into the same window", async () => {
    const f = await sinkFixture({ promptError: new Error("socket closed") });
    await f.mailbox.writeGapEvent(ownerKey, { from: "a", to: "b", lost: {} });
    f.hints(hint());
    await vi.waitFor(() => expect(f.prompts).toHaveLength(1));
    await vi.waitFor(() => expect(f.logs.some((line) => line.includes("hint dropped"))).toBe(true));
    f.hints(hint());
    await flush();
    expect(f.calls).toEqual([["pane", "get", "p-owner"]]);
    expect(f.prompts).toHaveLength(1);

    const unreadable = await sinkFixture({ paneGetError: new Error("pane gone") });
    unreadable.hints(hint());
    await vi.waitFor(() => expect(unreadable.calls).toEqual([["pane", "get", "p-owner"]]));
    await vi.waitFor(() => expect(unreadable.logs.some((line) => line.includes("hint dropped"))).toBe(true));
    // A failed pane read consumed no window — the next event retries fresh.
    unreadable.hints(hint());
    await vi.waitFor(() => expect(unreadable.calls).toHaveLength(2));
    expect(unreadable.prompts).toEqual([]);
  });

  it("reads the fresh pane but sends nothing when the owner's mailbox is empty", async () => {
    const f = await sinkFixture();
    f.hints(hint());
    await vi.waitFor(() => expect(f.calls).toEqual([["pane", "get", "p-owner"]]));
    await flush();
    expect(f.prompts).toEqual([]);
    expect(f.logs).toEqual([]);
  });

  it("folds a caller-supplied abort signal into the per-delivery timeout", async () => {
    const f = await sinkFixture({ signal: new AbortController().signal });
    await f.mailbox.writeGapEvent(ownerKey, { from: "a", to: "b", lost: {} });
    f.hints(hint());
    await vi.waitFor(() => expect(f.prompts).toHaveLength(1));
  });

  it("writes the drop record to stderr when no log seam is wired, and stringifies non-Error faults", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const f = await sinkFixture({ defaultLog: true, paneGetError: "socket exploded" });
    f.hints(hint());
    await vi.waitFor(() => expect(stderr.mock.calls.some(([text]) => String(text).includes("hint dropped: socket exploded"))).toBe(true));
    stderr.mockRestore();
  });

  it("drops a hint that cannot even be scheduled — a throwing owner getter is logged, never thrown", async () => {
    const f = await sinkFixture();
    expect(() => f.hints({ ...hint(), owner: { paneId: "p-owner", get session(): never { throw new Error("sync-boom"); } } })).not.toThrow();
    expect(f.logs.some((line) => line.includes("hint dropped: sync-boom"))).toBe(true);
  });
});

interface DaemonFixture {
  runtime: DaemonRuntime;
  namespace: { dir: string; endpoint: string };
  allocator: HandoffAllocator;
  mailbox: Mailbox;
  calls: string[][];
  prompt: ReturnType<typeof vi.fn>;
}

function paneRecord(paneId: string, session: AgentSessionIdentity, status = "idle"): Record<string, unknown> {
  return { pane_id: paneId, tab_id: "w1:t1", workspace_id: "w1", agent_name: `pane-${paneId}`, agent: session.agent, terminal_id: `t-${paneId}`, agent_session: session, agent_status: status, revision: 1, state_change_seq: 1 };
}
function agentRecord(paneId: string, session: AgentSessionIdentity): Record<string, unknown> {
  return { pane_id: paneId, name: `pane-${paneId}`, agent: session.agent, terminal_id: `t-${paneId}`, agent_session: session, agent_status: "idle", revision: 1, state_change_seq: 1 };
}

/** A daemon runtime over scripted exec: `api snapshot` proves the owner/successor panes; `pane get` reads the owner pane. */
async function daemonFixture(options: { hintKinds?: readonly string[]; ownerStatus?: string } = {}): Promise<DaemonFixture> {
  const { root, namespace } = await daemonNamespace();
  const runsDir = join(root, "runs");
  await mkdir(runsDir, { mode: 0o700 });
  const allocator = createHandoffAllocator({ namespace: { dir: runsDir, endpoint: namespace.endpoint } });
  const mailbox = createMailbox({ namespace, ownership: daemonRunOwnership(allocator) });
  const calls: string[][] = [];
  const prompt = vi.fn(async (): Promise<JsonEnvelope> => ok({}));
  const snapshot = {
    version: "test", protocol: 22, workspaces: [], tabs: [],
    panes: [paneRecord("w1:p1", ownerSession, options.ownerStatus ?? "idle"), paneRecord("w1:p2", successorSession)],
    agents: [agentRecord("w1:p1", ownerSession), agentRecord("w1:p2", successorSession)],
  };
  const exec: PiExec = async (_command, argv): Promise<ExecResult> => {
    calls.push(argv);
    if (argv[0] === "api" && argv[1] === "snapshot") return { stdout: JSON.stringify(ok({ type: "session_snapshot", snapshot })), stderr: "", code: 0, killed: false };
    if (argv[0] === "pane" && argv[1] === "get") {
      const pane = snapshot.panes.find((entry) => entry.pane_id === argv[2]);
      if (pane === undefined) throw new Error("pane not found");
      return { stdout: JSON.stringify(ok({ pane })), stderr: "", code: 0, killed: false };
    }
    throw new Error(`unexpected argv: ${argv.join(" ")}`);
  };
  const promptClient: AgentPromptClient = { prompt, ping: async () => undefined };
  const runtime = createDaemonRuntime({
    exec,
    env: {},
    promptClient,
    namespace,
    intents: createIntentStore({ namespace }),
    allocator,
    mailbox,
    ...(options.hintKinds === undefined ? {} : { hintKinds: options.hintKinds }),
  });
  runtimes.push(runtime);
  return { runtime, namespace, allocator, mailbox, calls, prompt };
}

async function seedRun(fx: DaemonFixture): Promise<string> {
  const run = await fx.allocator.allocate();
  await fx.allocator.persist(run, {
    manager: { paneId: "w1:p1", display: "pi", source: "agent_name" },
    child: { agentName: "child", agentKind: "pi", operatingPointId: "pi", specLabel: "test", fallbackCandidates: [] },
  }, { managerSession: ownerSession, task });
  return run.runId;
}

describe("runtime wiring", () => {
  it("leaves the qualified set EMPTY when the option is unset — an idle pi owner pane still gets zero writes", async () => {
    const fx = await daemonFixture();
    await fx.mailbox.writeGapEvent(ownerKey, { from: "a", to: "b", lost: {} });
    fx.runtime.hints(hint());
    await flush();
    expect(fx.calls).toEqual([]);
    expect(fx.prompt).not.toHaveBeenCalled();
  });

  it("delivers through the runtime-assembled sink when the start option qualifies the kind", async () => {
    const fx = await daemonFixture({ hintKinds: ["pi", "claude", "devin"] });
    const event = await fx.mailbox.writeGapEvent(ownerKey, { from: "a", to: "b", lost: {} });
    if (!event.persisted) throw new Error("fixture write failed");
    fx.runtime.hints(hint({ paneId: "w1:p1", session: ownerSession }));
    await vi.waitFor(() => expect(fx.prompt).toHaveBeenCalledTimes(1));
    const unread = join(fx.namespace.dir, "mailbox", ownerKey, "unread");
    expect(fx.prompt).toHaveBeenCalledWith("w1:p1",
      `herdr mailbox: 1 unread (${event.eventId}) at ${unread}; read via your MCP surface (herdr_status / executor → MCP)`,
      expect.any(AbortSignal));
    expect(fx.calls).toEqual([["pane", "get", "w1:p1"]]);
  });

  it("wires the journal's retarget to live supervisor hint destinations through the registry", async () => {
    const fx = await daemonFixture();
    const runId = await seedRun(fx);
    const spy = vi.spyOn(fx.runtime.supervision, "retargetHintDestinations");
    await fx.runtime.daemonOwnership.transfer({ caller: { paneId: "w1:p1", session: ownerSession }, runIds: [runId], successorPaneId: "w1:p2" });
    expect(spy).toHaveBeenCalledWith([runId], { paneId: "w1:p2", session: successorSession });
  });

  it("status projects pendingTransfers strictly read-only — identical on a second read", async () => {
    const fx = await daemonFixture();
    const runId = await seedRun(fx);
    // A journal stranded mid-flight: the recorded event pair cannot persist.
    const wrapped: Mailbox = {
      ...fx.mailbox,
      withMailboxes: (keys, section) => fx.mailbox.withMailboxes(keys, (locked) => section({
        ...locked,
        writeRecordedEvent: async (_key, event) => ({ persisted: false, persistenceFailed: true, eventId: event.id, reason: "unavailable", at: event.at }),
      })),
    };
    fx.runtime.bindMailbox(wrapped);
    await expect(fx.runtime.daemonOwnership.transfer({ caller: { paneId: "w1:p1", session: ownerSession }, runIds: [runId], successorPaneId: "w1:p2" }))
      .rejects.toMatchObject({ code: "TRANSFER_EVENT_FAILED" });
    const journal = join(fx.namespace.dir, "transfers", `${(await fx.runtime.daemonOwnership.pendingTransfers())[0]!.transferId}.json`);
    const bytes = await readFile(journal, "utf8");
    const params = { identity: { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", agentSession: ownerSession } };
    const first = await handleDaemonStatus(fx.runtime, params);
    const second = await handleDaemonStatus(fx.runtime, params);
    expect(first.pendingTransfers).toHaveLength(1);
    expect(first.pendingTransfers[0]).toMatchObject({ runIds: [runId], fromKey: ownerKey, toKey: managerSessionKey(successorSession) });
    expect(first.pendingTransfers[0]!.events.map((event) => event.id)).toHaveLength(2);
    expect(first.pendingTransfers[0]!.events[0]).toMatchObject({ kind: "transfer", runId });
    expect(second.pendingTransfers).toEqual(first.pendingTransfers);
    expect(await readFile(journal, "utf8")).toBe(bytes);
  });
});

describe("bound supervisor hint destination", () => {
  const child: SupervisedIdentity = { paneId: "p1", terminalId: "t1", agentName: "worker", agentKind: "pi", agentSession: childSession };
  const childPane = { pane_id: "p1", terminal_id: "t1", tab_id: "tab1", workspace_id: "w1", agent_status: "working", revision: 3, agent: "pi", agent_name: "worker", agent_session: childSession };

  const paneEvent = (status: string, revision: number, seq: number): SupervisionSocketEvent => parseSocketLine(JSON.stringify({
    event: "pane_updated",
    data: {
      type: "pane_updated",
      pane: { pane_id: "p1", terminal_id: "t1", tab_id: "tab1", workspace_id: "w1", agent_status: status, revision, state_change_seq: seq, agent: "pi", agent_name: "worker", agent_session: childSession },
    },
  })) as SupervisionSocketEvent;

  it("moves a live run's hint destination to the verified successor", async () => {
    const { namespace } = await daemonNamespace();
    const runsDir = join(namespace.dir, "runs");
    await mkdir(runsDir, { mode: 0o700 });
    const allocator = createHandoffAllocator({ namespace: { dir: runsDir, endpoint: namespace.endpoint } });
    const allocation = await allocator.allocate();
    await allocator.persist(allocation, {
      manager: { paneId: "p-owner", display: "pi", source: "agent_name" },
      child: { agentName: "worker", agentKind: "pi", operatingPointId: "worker-pi", specLabel: "worker-pi", fallbackCandidates: [] },
    }, { managerSession: ownerSession, task });
    const server = scriptedServer({ snapshots: [{ type: "session_snapshot", snapshot: { version: "t", protocol: 22, workspaces: [], tabs: [], panes: [childPane], agents: [{ pane_id: "p1", name: "worker", agent: "pi", agent_session: childSession }] } }] });
    const jobs = new JobRegistry();
    const hints = vi.fn();
    const gate = createHandoffGate();
    const supervision = new SupervisionRegistry({
      jobs,
      settingsLoader: async () => ({ reviewCadenceMinutes: 5, reviewerModel: "testmodel", reviewerThinking: "low" }),
      readTranscript: async () => ["line"],
      monitorFactory: () => new SessionEventMonitor({ connect: () => server.connect(), env: { HERDR_SOCKET_PATH: "/tmp/s.sock" }, clock: { now: () => 0, sleep: async () => undefined } }),
      typesafeCredentials: { read: async () => undefined },
      scheduler: { setTimer: () => "timer", clearTimer: () => undefined },
      workspaceRunner: async () => ({ stdout: "", exitCode: 0 }),
      handoffs: gate,
      hints,
    });
    let supervisor: Supervisor | undefined;
    const attach = jobs.attachSupervision.bind(jobs);
    jobs.attachSupervision = (jobId, port) => { supervisor = port as Supervisor; return attach(jobId, port); };
    const writer: MailboxEventWriter = { writeRunEvent: vi.fn(async (input) => ({ persisted: true as const, eventId: `e-${input.kind}`, path: "/x" })) };
    const reservation = await supervision.reserve({ child: { agentName: "worker", agentKind: "pi", operatingPointId: "worker-pi" }, settings: { eventWriter: writer } });
    await reservation.bind({ identity: child, operatingPointId: "worker-pi", stateChangeSeq: 2, handoff: { allocation, owner: { paneId: "p-owner", session: ownerSession } } });

    // working → idle emits work_cycle_completed: persists, then hints at the recorded owner.
    // Revisions advance by exactly one so no revision_jump evidence_gap emits beside it.
    await supervisor!.onEvent(paneEvent("idle", 4, 9));
    await vi.waitFor(() => expect(hints).toHaveBeenCalledTimes(1));
    expect(hints.mock.calls[0]![0]).toMatchObject({ runId: allocation.runId, owner: { paneId: "p-owner", session: ownerSession } });

    supervision.retargetHintDestinations([allocation.runId], { paneId: "p-successor", session: successorSession });

    await supervisor!.onEvent(paneEvent("working", 5, 10));
    await supervisor!.onEvent(paneEvent("idle", 6, 11));
    await vi.waitFor(() => expect(hints).toHaveBeenCalledTimes(2));
    expect(hints.mock.calls[1]![0]).toMatchObject({ runId: allocation.runId, owner: { paneId: "p-successor", session: successorSession } });
    await supervision.shutdown();
    jobs.shutdown();
  });
});
