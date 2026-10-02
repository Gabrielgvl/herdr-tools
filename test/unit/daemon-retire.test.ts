/**
 * The ADR-040 lane-retirement sweep (design B3, node B8).
 *
 * Proves the full proof chain — only a `handed_off` run whose exact child
 * stays continuously idle past the grace with an unchanged lifecycle counter
 * and detection-screen digest, carries the launch tokens, manages nothing
 * live, drains its own mailbox, and sits clear of the owner's topology is
 * closed under the pane write lock and the run flock — plus the dry-run kill
 * switch, the bounded focused deferral, close uncertainty retries, the
 * one-shot `lane_retired` event, and the ledger's replay/idempotency.
 *
 * The PR #62 review regressions (F1–F13) each pin a destructive path that
 * f0ae1ed admitted: stale pane scalars over a fresh agent record, a silent
 * screen, a `recorded` child launch, a reconciled absence claimed as a close,
 * an ownership transfer inside the lock window, unreadable keep provenance,
 * a dead lease, and the env knobs.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile, chmod, mkdir, mkdtemp, rm, stat, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tokenValue } from "../../src/agent-identity.js";
import type { CliTextResult, JsonEnvelope } from "../../src/cli.js";
import {
  createHandoffAllocator,
  HANDOFF_PROVENANCE_NAME,
  readHandoffProvenance,
  updateHandoffState,
  writeHandoffProvenance,
  type HandoffAllocation,
  type HandoffAllocator,
  type HandoffLifecycleState,
  type HandoffNamespace,
  type HandoffProvenanceInput,
  type HandoffRunIdentity,
  type HandoffTaskContract,
  type HandoffTraceHistory,
} from "../../src/handoff.js";
import type { JobRegistry } from "../../src/job-registry.js";
import { devinComposerReadArgv } from "../../src/messages/devin-queue-flush.js";
import type { AgentSessionIdentity } from "../../src/messages/prompt.js";
import { createDevinQueueFlush } from "../../src/messages/devin-queue-flush.js";
import { acquireFlockHolder, createPaneWriteGuard, PaneWriteLockError, type PaneWriteGuard } from "../../src/pane-write-lock.js";
import { createSelfCloseTracker } from "../../src/supervision/self-close.js";
import type { TailScanner } from "../../src/supervision/trace-follow-up.js";
import { captureTraceHistory, tailScan, type TailScan, type TraceTailDeps } from "../../src/supervision/trace-tail.js";
import { parseSnapshotResult, type HerdrSnapshot } from "../../src/targets.js";
import { createIntentStore, managerSessionKey, type IntentStore } from "../../src/daemon/intents.js";
import { createMailbox, type Mailbox } from "../../src/daemon/mailbox.js";
import type { DaemonNamespace } from "../../src/daemon/namespace.js";
import { daemonRunOwnership, OwnershipError } from "../../src/daemon/ownership.js";
import { createLaneRetirer, type LaneRetirerCli, type LaneRetirerDeps } from "../../src/daemon/retire.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
});

const ownerSession: AgentSessionIdentity = { source: "herdr", agent: "pi", kind: "pi", value: "owner-session-A" };
const ownerKey = managerSessionKey(ownerSession);
const childSession: AgentSessionIdentity = { source: "herdr:pi", agent: "pi", kind: "path", value: "/pi/child.jsonl" };
const childKey = managerSessionKey(childSession);
const CLAUDE_UUID = "00000000-0000-4000-8000-000000000001";
const claudeSession: AgentSessionIdentity = { source: "herdr:claude", agent: "claude", kind: "id", value: CLAUDE_UUID };
const devinSession: AgentSessionIdentity = { source: "herdr:devin", agent: "devin", kind: "id", value: "devin-sess-1" };
const agySession: AgentSessionIdentity = { source: "herdr:agy", agent: "agy", kind: "id", value: "agy-1" };
type Kind = "pi" | "claude" | "devin" | "agy";
const SESSIONS: Record<Kind, AgentSessionIdentity> = { pi: childSession, claude: claudeSession, devin: devinSession, agy: agySession };
const WORKSPACE_CWD = "/project";

/** The deterministic retirement anchor every seeded artifact carries as its file mtime (ADR-040 amendment). */
const ANCHOR_MS = Date.parse("2026-10-01T12:00:00.000Z");
const at = (deltaMs: number): string => new Date(ANCHOR_MS + deltaMs).toISOString();
/** Redacted Pi session entries: no content, synthetic ids. */
function piEntry(role: "user" | "assistant" | "toolResult", deltaMs: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "message", id: `m${deltaMs}`, timestamp: at(deltaMs), message: { role, content: "redacted", timestamp: ANCHOR_MS + deltaMs }, ...over };
}
const PI_QUIET: Record<string, unknown>[] = [
  { type: "session", version: 1, id: "sess", timestamp: at(-3_600_000), cwd: WORKSPACE_CWD },
  piEntry("user", -3_000_000),
  piEntry("assistant", -2_900_000),
];
/** Redacted Claude JSONL records: the §2.1 shapes with no bodies. */
function claudeRecord(type: string, deltaMs: number | undefined, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type,
    sessionId: CLAUDE_UUID,
    cwd: WORKSPACE_CWD,
    ...(deltaMs === undefined ? {} : { timestamp: at(deltaMs) }),
    ...(type === "user" || type === "assistant" ? { message: { role: type, content: "redacted" } } : {}),
    ...over,
  };
}
const CLAUDE_QUIET: Record<string, unknown>[] = [claudeRecord("user", -3_000_000), claudeRecord("assistant", -2_900_000), claudeRecord("file-history-snapshot", undefined)];
/** A redacted ATIF document for `devinSession`. */
function devinDoc(steps: Array<{ source: "system" | "user" | "agent"; deltaMs: number }>, sessionId = devinSession.value): Record<string, unknown> {
  return {
    schema_version: "ATIF-v1.7",
    session_id: sessionId,
    steps: steps.map((step, index) => ({ step_id: index + 1, timestamp: at(step.deltaMs), source: step.source, message: "redacted" })),
  };
}
const DEVIN_QUIET = [{ source: "system" as const, deltaMs: -3_600_000 }, { source: "user" as const, deltaMs: -3_000_000 }, { source: "agent" as const, deltaMs: -2_900_000 }];

/** The verbatim ansi capture of a Devin composer with queued input (test/fixtures/devin-composer-queued.ansi). */
const REAL_QUEUED = readFileSync(new URL("../fixtures/devin-composer-queued.ansi", import.meta.url), "utf8");
const RULE = `\x1b[0m\x1b[38;2;68;68;68m${"─".repeat(60)}\x1b[0m`;
const GRAY = "\x1b[38;2;124;124;124m";
const RESET = "\x1b[0m";
/** Minimal rendered Devin composer: rule / `❭` input / rule. */
const composerView = (input: string): string => `agent output\n${RULE}\n❭ ${input}\n${RULE}\nSWE-2 Max   Context: 9%\n`;
const COMPOSER_DRAINED = composerView(`${RESET}${GRAY}Guide Devin while it works${RESET}`);
const COMPOSER_DRAFT = composerView("typed draft");
const successorSession: AgentSessionIdentity = { source: "herdr", agent: "pi", kind: "pi", value: "successor-session" };

const task: HandoffTaskContract = {
  objective: "do the thing",
  scope: "repo",
  doneWhen: ["it works"],
  constraints: [],
  tier: "standard",
};

const GRACE_MS = 60_000;
const SCREEN_READ = ["pane", "read", "p-child", "--source", "detection", "--format", "text"];

const identityFields = (agentName: string, agentKind: Kind = "pi"): HandoffRunIdentity => ({
  manager: { paneId: "p-owner", display: "pi", source: "agent_name" },
  child: {
    agentName,
    agentKind,
    operatingPointId: "worker-pi",
    specLabel: "worker",
    fallbackCandidates: [],
    workspace: { resolvedCwd: "/project" },
  },
});

function artifactBody(runId: string): string {
  return [
    `herdr-run:${runId}`,
    "",
    "## Status",
    "done",
    "",
    "## Summary",
    "Completed the assignment end to end.",
    "",
    "## Changes",
    "- src/daemon/retire.ts",
    "",
    "## Verification",
    "npx vitest run test/unit/daemon-retire.test.ts",
    "",
    "## Blockers",
    "None.",
    "",
    "## Continuation",
    "None.",
  ].join("\n");
}

/** The trace locations the fixture serves: Pi paths under `traceRoot`, Claude under a `home` of `traceRoot`, Devin under `traceRoot/devin`. */
function traceDepsFor(fx: Fx): TraceTailDeps {
  return { rootDir: fx.traceRoot, home: fx.traceRoot, devinTranscriptsDir: join(fx.traceRoot, "devin") };
}

/** Where a kind's native trace lives inside the fixture. */
function tracePath(fx: Fx, kind: Kind, session: AgentSessionIdentity): string {
  if (kind === "pi") return join(fx.traceRoot, session.value);
  if (kind === "claude") return join(fx.traceRoot, ".claude", "projects", WORKSPACE_CWD.replace(/[^a-zA-Z0-9]/g, "-"), `${session.value}.jsonl`);
  return join(fx.traceRoot, "devin", `${session.value}.json`);
}

/** Write a kind's native trace: JSONL records (plus an optional unterminated tail) or one ATIF document. */
async function writeTrace(fx: Fx, kind: Kind, session: AgentSessionIdentity, records: unknown, pendingTail = ""): Promise<string> {
  const path = tracePath(fx, kind, session);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const body = kind === "devin" ? JSON.stringify(records) : `${(records as unknown[]).map((record) => JSON.stringify(record)).join("\n")}\n${pendingTail}`;
  await writeFile(path, body, { mode: 0o600 });
  return path;
}

/** Append JSONL records (and an optional unterminated tail) to a seeded lane's trace. */
async function appendTrace(fx: Fx, kind: Kind, session: AgentSessionIdentity, records: unknown[], pendingTail = ""): Promise<void> {
  await appendFile(tracePath(fx, kind, session), `${records.map((record) => JSON.stringify(record)).join("\n")}${records.length === 0 ? "" : "\n"}${pendingTail}`);
}

function quietTrace(kind: Kind): unknown {
  if (kind === "pi") return PI_QUIET;
  if (kind === "claude") return CLAUDE_QUIET;
  return devinDoc(DEVIN_QUIET);
}

/**
 * Seed a bound run, `handed_off` with a digested artifact unless overridden.
 * ADR-040 amendment: the artifact's file mtime is pinned to `anchorMs`, the
 * sidecar carries that anchor, and the history fingerprint is captured from a
 * written native trace through the real capture function — exactly what the
 * gate persists at a first validation.
 */
async function seedRun(
  fx: Fx,
  options: {
    lifecycle?: HandoffLifecycleState;
    session?: AgentSessionIdentity;
    agentKind?: Kind;
    paneId?: string;
    terminalId?: string;
    task?: HandoffTaskContract;
    owner?: AgentSessionIdentity | null;
    provenance?: boolean;
    digest?: boolean;
    /** A cycle mark on the lifecycle detail. */
    detail?: string;
    /** The native trace to write (JSONL records or an ATIF document); `false` writes none. */
    trace?: unknown | false;
    /** Unterminated bytes left after the last JSONL record. */
    pendingTail?: string;
    /** The artifact's pinned file mtime and persisted anchor (default `ANCHOR_MS`); `false` persists no anchor (a legacy lane). */
    anchor?: number | false;
    /** `false` persists the anchor without a fingerprint (a failed capture); a record overrides the captured one. */
    history?: false | HandoffTraceHistory;
    /** Workspace record; `false` omits it (Claude's path cannot resolve). */
    workspace?: false;
  } = {},
): Promise<{ allocation: HandoffAllocation; runId: string; tracePath: string }> {
  const kind = options.agentKind ?? "pi";
  const session = options.session ?? SESSIONS[kind];
  const allocation = await fx.allocator.allocate();
  const provenance: HandoffProvenanceInput = {
    managerSession: options.owner === undefined ? ownerSession : options.owner,
    task: options.task ?? task,
  };
  const identity = identityFields("worker", kind);
  if (options.workspace === false) delete identity.child.workspace;
  await fx.allocator.persist(allocation, identity, options.provenance === false ? undefined : provenance);
  await updateHandoffState(allocation, (state) => {
    state.child.paneId = options.paneId ?? "p-child";
    state.child.terminalId = options.terminalId ?? "t1";
    state.child.agentId = "agent-1";
    state.nativeSession = { ...session };
    state.lifecycle.watermark = { stateChangeSeq: 4, revision: 2 };
    state.lifecycle.state = options.lifecycle ?? "handed_off";
    if (options.detail !== undefined) state.lifecycle.detail = options.detail;
  });
  const path = tracePath(fx, kind, session);
  if (options.trace !== false && kind !== "agy") await writeTrace(fx, kind, session, options.trace ?? quietTrace(kind), options.pendingTail);
  const content = artifactBody(allocation.runId);
  await writeFile(allocation.artifactPath, content, { mode: 0o600 });
  const anchorMs = options.anchor === false ? ANCHOR_MS : options.anchor ?? ANCHOR_MS;
  await utimes(allocation.artifactPath, new Date(anchorMs), new Date(anchorMs));
  if (options.digest !== false) {
    const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
    const mtimeMs = Math.floor((await stat(allocation.artifactPath)).mtimeMs);
    const history = options.history === false || options.anchor === false
      ? undefined
      : options.history ?? await captureTraceHistory({ agentKind: kind, agentSession: session }, { resolvedCwd: WORKSPACE_CWD }, new AbortController().signal, traceDepsFor(fx));
    await updateHandoffState(allocation, (state) => {
      state.artifact.sha256 = sha256;
      state.artifact.bytes = Buffer.byteLength(content);
      state.artifact.version = 1;
      state.artifact.status = "done";
      if (options.anchor !== false) state.artifact.mtimeMs = mtimeMs;
      if (history !== undefined) state.artifact.traceHistory = history;
    });
  }
  return { allocation, runId: allocation.runId, tracePath: path };
}

/** Rewrite a run's provenance as v2 with `current` as the open owner entry. */
async function transferTo(allocation: HandoffAllocation, current: AgentSessionIdentity): Promise<void> {
  const prior = await readHandoffProvenance(allocation);
  await writeHandoffProvenance(allocation, {
    ...prior,
    v: 2,
    owners: [
      { session: ownerSession, from: prior.createdAt, to: "2026-10-01T00:00:00.000Z", reason: "transfer" },
      { session: current, from: "2026-10-01T00:00:00.000Z", to: null, reason: "transfer" },
    ],
  });
}

/** The launch tokens an accepted lane carries on both its records. */
function childTokens(session: AgentSessionIdentity = childSession, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { identity_provenance: "launched", identity_actor: "p-owner", identity_session: tokenValue(session.value), ...over };
}

type RawRecord = Record<string, unknown>;

function childPane(over: RawRecord = {}): RawRecord {
  return {
    pane_id: "p-child",
    terminal_id: "t1",
    tab_id: "tab-child",
    workspace_id: "w1",
    agent_status: "idle",
    revision: 5,
    state_change_seq: 5,
    agent: "pi",
    agent_name: "worker",
    agent_session: { ...childSession },
    tokens: childTokens(),
    ...over,
  };
}

function childAgent(over: RawRecord = {}): RawRecord {
  return {
    pane_id: "p-child",
    name: "worker",
    agent: "pi",
    terminal_id: "t1",
    agent_session: { ...childSession },
    agent_status: "idle",
    revision: 5,
    state_change_seq: 5,
    tokens: childTokens(),
    ...over,
  };
}

function ownerPane(over: RawRecord = {}): RawRecord {
  return { pane_id: "p-owner", terminal_id: "t-owner", tab_id: "tab-owner", workspace_id: "w1", agent_status: "idle", revision: 1, agent: "pi", agent_name: "manager", agent_session: { ...ownerSession }, ...over };
}

function ownerAgent(over: RawRecord = {}): RawRecord {
  return { pane_id: "p-owner", name: "manager", agent: "pi", agent_session: { ...ownerSession }, agent_status: "idle", revision: 1, ...over };
}

/** The live child records the sweep observes; empty `pane` means it is gone. `screen` is the detection-screen text, `ansi` the visible ansi frame. */
interface Live {
  pane?: RawRecord;
  agent?: RawRecord;
  screen?: string;
  ansi?: string;
}

/** Two tabs in one workspace: the lane's own tab cascades, the owner's survives. `omitOwner` drops the owner records entirely. */
function snapshotFor(live: Live, extras: { panes?: RawRecord[]; agents?: RawRecord[]; tabs?: RawRecord[]; omitOwner?: boolean } = {}): HerdrSnapshot {
  const panes: RawRecord[] = [...(extras.omitOwner === true ? [] : [ownerPane()]), ...(extras.panes ?? [])];
  const agents: RawRecord[] = [...(extras.omitOwner === true ? [] : [ownerAgent()]), ...(extras.agents ?? [])];
  if (live.pane !== undefined) panes.push(live.pane);
  if (live.agent !== undefined) agents.push(live.agent);
  return parseSnapshotResult({
    type: "session_snapshot",
    snapshot: {
      version: "0.8.2",
      protocol: 22,
      workspaces: [{ workspace_id: "w1", label: "w" }],
      tabs: [
        ...(extras.omitOwner === true ? [] : [{ tab_id: "tab-owner", workspace_id: "w1", label: "owner" }]),
        { tab_id: "tab-child", workspace_id: "w1", label: "child" },
        ...(extras.tabs ?? []),
      ],
      panes,
      agents,
    },
  });
}

interface FakeCli extends LaneRetirerCli {
  calls: string[][];
}

interface FakeCliOptions {
  closeError?: unknown;
  getError?: unknown;
  getPane?: RawRecord;
  getAgent?: RawRecord;
  /** `pane read` throws. */
  readError?: unknown;
  /** `pane read` reports a truncated result. */
  readTruncated?: boolean;
  /** Runs inside the `pane close` dispatch, before the records clear. */
  onClose?: () => Promise<void>;
  /** Runs after every detection-screen read is served. */
  onRead?: () => Promise<void>;
}

/**
 * A scripted Herdr CLI over the `live` records. `pane close` clears them (so
 * the readback proves absence) unless `closeError` throws first; `pane get` /
 * `agent get` serve the live records, or `getPane`/`getAgent` overrides when a
 * test needs the under-lock records to differ from the snapshot; `pane read`
 * serves `live.screen`. `opts` is read live, so a test can flip it mid-sweep.
 */
function fakeCli(live: Live, opts: FakeCliOptions = {}): FakeCli {
  const calls: string[][] = [];
  return {
    calls,
    async runJson(argv) {
      calls.push([...argv]);
      const [kind, verb, id] = argv;
      if (verb === "get" && opts.getError !== undefined) throw opts.getError;
      if (kind === "pane" && verb === "get") {
        const pane = opts.getPane ?? live.pane;
        if (pane === undefined || pane.pane_id !== id) throw Object.assign(new Error("pane gone"), { code: "TARGET_NOT_FOUND" });
        return { id: "op", result: { pane } } as JsonEnvelope;
      }
      if (kind === "agent" && verb === "get") {
        const agent = opts.getAgent ?? live.agent;
        if (agent === undefined) throw Object.assign(new Error("agent gone"), { code: "TARGET_NOT_FOUND" });
        return { id: "op", result: { agent } } as JsonEnvelope;
      }
      if (kind === "pane" && verb === "close") {
        await opts.onClose?.();
        if (opts.closeError !== undefined) throw opts.closeError;
        live.pane = undefined;
        live.agent = undefined;
        return { id: "op", result: { closed: id } } as JsonEnvelope;
      }
      throw Object.assign(new Error(`unexpected argv: ${argv.join(" ")}`), { code: "CLI_PROTOCOL_ERROR" });
    },
    async runTextResult(argv): Promise<CliTextResult> {
      calls.push([...argv]);
      if (argv[0] !== "pane" || argv[1] !== "read") throw Object.assign(new Error(`unexpected argv: ${argv.join(" ")}`), { code: "CLI_PROTOCOL_ERROR" });
      if (opts.readError !== undefined) throw opts.readError;
      if (live.pane === undefined) throw Object.assign(new Error("pane gone"), { code: "TARGET_NOT_FOUND" });
      if (argv.includes("ansi")) return { value: live.ansi ?? COMPOSER_DRAINED, truncated: opts.readTruncated === true };
      await opts.onRead?.();
      return { value: live.screen ?? "worker> waiting for input", truncated: opts.readTruncated === true };
    },
  };
}

interface FakeLockOptions {
  fails?: boolean;
  releaseError?: unknown;
  /** `lease.check()` rejects — the flock holder died or the lock path lost trust. */
  checkError?: unknown;
  /** Runs inside `acquire`, after the lock is "taken" and before the lease returns — the transfer window. */
  onAcquire?: () => Promise<void>;
}

/** A pane write guard that needs no flock: acquisition and checks are counted, never contended unless told to fail. `opts` is read live. */
function fakePaneLock(opts: FakeLockOptions = {}): { guard: PaneWriteGuard; acquired: string[]; checks: string[] } {
  const acquired: string[] = [];
  const checks: string[] = [];
  return {
    acquired,
    checks,
    guard: {
      async acquire(paneId) {
        if (opts.fails === true) throw Object.assign(new Error("contended"), { code: "PANE_WRITE_LOCK_UNAVAILABLE" });
        acquired.push(paneId);
        await opts.onAcquire?.();
        return {
          check: async () => {
            checks.push(paneId);
            if (opts.checkError !== undefined) throw opts.checkError;
          },
          release: async () => {
            if (opts.releaseError !== undefined) throw opts.releaseError;
          },
          fence: { isSpent: async () => false, record: async () => undefined, rearm: async () => undefined },
        };
      },
    },
  };
}

interface Fx {
  handoffNs: HandoffNamespace;
  daemonNs: DaemonNamespace;
  allocator: HandoffAllocator;
  intents: IntentStore;
  mailbox: Mailbox;
  lines: string[];
  /** The native traces' root: Pi paths resolve beneath it, it is Claude's `home`, and `devin/` holds ATIF documents. */
  traceRoot: string;
}

async function fixture(): Promise<Fx> {
  const root = await mkdtemp(join(tmpdir(), "herdr-retire-"));
  dirs.push(root);
  const handoffNs: HandoffNamespace = { dir: join(root, "herdr-handoffs"), endpoint: join(root, "herdr.sock") };
  const daemonNs: DaemonNamespace = { dir: join(root, "herdr-tools-daemon"), endpoint: join(root, "daemon.sock") };
  const traceRoot = join(root, "traces");
  await mkdir(handoffNs.dir, { recursive: true, mode: 0o700 });
  await mkdir(daemonNs.dir, { recursive: true, mode: 0o700 });
  await mkdir(traceRoot, { recursive: true, mode: 0o700 });
  const allocator = createHandoffAllocator({ namespace: handoffNs });
  const intents = createIntentStore({ namespace: daemonNs });
  const mailbox = createMailbox({ namespace: daemonNs, ownership: daemonRunOwnership(allocator) });
  return { handoffNs, daemonNs, allocator, intents, mailbox, lines: [], traceRoot };
}

function retirerDeps(
  fx: Fx,
  live: Live,
  over: Partial<Omit<LaneRetirerDeps, "options">> & { options?: Partial<LaneRetirerDeps["options"]> } = {},
): { deps: LaneRetirerDeps; clock: { nowMs: number } } {
  const clock = { nowMs: 1_000_000 };
  const { options: optionOverrides, ...depsOverrides } = over;
  return {
    clock,
    deps: {
      runs: fx.handoffNs,
      allocator: fx.allocator,
      ownership: daemonRunOwnership(fx.allocator),
      intents: fx.intents,
      mailbox: fx.mailbox,
      cli: fakeCli(live),
      selfClose: createSelfCloseTracker(),
      jobs: { activeSupervisorFor: () => undefined } as unknown as Pick<JobRegistry, "activeSupervisorFor">,
      snapshot: async () => snapshotFor(live),
      options: { enabled: true, graceMs: GRACE_MS, paneLock: fakePaneLock().guard, ...optionOverrides },
      now: () => new Date(clock.nowMs),
      log: (line) => fx.lines.push(line),
      trace: { trace: traceDepsFor(fx) },
      ...depsOverrides,
    },
  };
}

/** A tail scanner that counts its calls and delegates to the real one. */
function countingScan(): { scan: TailScanner; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    scan: async (target, anchorMs, history, deps) => {
      calls.push(anchorMs);
      return tailScan(target, anchorMs, history, deps);
    },
  };
}

/** The live records for a child of `kind` — the Pi defaults with the kind's session and agent name substituted. */
function liveFor(kind: Kind): Live {
  const session = SESSIONS[kind];
  const over = { agent: kind, agent_session: { ...session }, tokens: childTokens(session) };
  return { pane: childPane(over), agent: childAgent(over) };
}

const closes = (deps: LaneRetirerDeps): string[][] => (deps.cli as FakeCli).calls.filter((argv) => argv[1] === "close");
/** Every CLI call past the per-sweep screen reads — the under-lock `get`s and the close. */
const lockedCalls = (deps: LaneRetirerDeps): string[][] => (deps.cli as FakeCli).calls.filter((argv) => argv[1] !== "read");

/** Seed `begin`+`markEffecting`+`recordChildren`+`complete` under the child's own session key. */
async function recordChildIntent(intents: IntentStore, idempotencyKey: string, children: Array<{ name: string; runId?: string }>): Promise<void> {
  const begun = await intents.begin({
    managerSessionKey: childKey,
    idempotencyKey,
    task: { objective: task.objective, scope: task.scope, doneWhen: task.doneWhen, constraints: task.constraints },
    projectRoot: "/project",
  });
  if (begun.kind !== "launch") throw new Error("expected launch");
  await intents.markEffecting(begun.intent);
  await intents.complete(begun.intent, children);
}

/** `begin` only: the intent stays `recorded` — the state a launch request executes under before `effecting`. */
async function recordedChildIntent(intents: IntentStore, idempotencyKey: string): Promise<void> {
  const begun = await intents.begin({
    managerSessionKey: childKey,
    idempotencyKey,
    task: { objective: task.objective, scope: task.scope, doneWhen: task.doneWhen, constraints: task.constraints },
    projectRoot: "/project",
  });
  if (begun.kind !== "launch") throw new Error("expected launch");
}

/** Sweep once at the clock, then once past the grace. */
async function sweepPastGrace(retirer: { sweep(): Promise<void> }, clock: { nowMs: number }): Promise<void> {
  await retirer.sweep();
  clock.nowMs += GRACE_MS;
  await retirer.sweep();
}

describe("lane retirer (ADR-040)", () => {
  it("closes a stable handed_off lane under the lock, confirms self-close, and writes exactly one lane_retired", async () => {
    const fx = await fixture();
    const { allocation, runId } = await seedRun(fx);
    const live: Live = { pane: childPane(), agent: childAgent() };
    const { deps, clock } = retirerDeps(fx, live);
    const retirer = createLaneRetirer(deps);

    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "watching", stableForMs: 0 });
    // The inactivity proof samples the detection screen every sweep.
    expect((deps.cli as FakeCli).calls).toContainEqual(SCREEN_READ);

    clock.nowMs += GRACE_MS;
    await retirer.sweep();

    expect(live.pane).toBeUndefined();
    expect(retirer.view(runId)).toMatchObject({ state: "retired" });
    expect(retirer.retiredByDaemon(runId)).toBe(true);
    // The own-close ledger carried the confirmed close: one claimable marker.
    expect(await deps.selfClose.consume("p-child")).toBe(true);
    expect(await deps.selfClose.consume("p-child")).toBe(false);
    // Exactly one lane_retired to the run's current owner, carrying the artifact.
    const unread = await fx.mailbox.list(ownerKey);
    expect(unread).toHaveLength(1);
    const event = await fx.mailbox.read(ownerKey, unread[0]!);
    expect(event).toMatchObject({
      kind: "lane_retired",
      runId,
      jobId: "daemon-retire",
      childIdentity: { agentName: "worker", agentKind: "pi", paneId: "p-child", terminalId: "t1" },
      handoff: { state: "handed_off", artifactSha256: expect.any(String) },
      actions: ["pane_closed:p-child", `artifact:${allocation.artifactPath}`],
    });
    // A repeated sweep replays nothing: the terminal view short-circuits.
    await retirer.sweep();
    expect(await fx.mailbox.list(ownerKey)).toHaveLength(1);
    expect(closes(deps)).toHaveLength(1);
    expect(fx.lines.filter((line) => line.includes(`run=${runId}`) && line.includes("decision=retired"))).toHaveLength(1);
  });

  it("reports the live supervisor's jobId and lands the event in a transferred run's successor mailbox", async () => {
    const fx = await fixture();
    const { allocation, runId } = await seedRun(fx);
    await transferTo(allocation, successorSession);
    const live: Live = { pane: childPane(), agent: childAgent() };
    const { deps, clock } = retirerDeps(fx, live, {
      jobs: { activeSupervisorFor: () => ({ jobId: "job_live" }) } as unknown as Pick<JobRegistry, "activeSupervisorFor">,
    });
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);

    expect(retirer.view(runId)).toMatchObject({ state: "retired" });
    const successorKey = managerSessionKey(successorSession);
    expect(await fx.mailbox.list(ownerKey)).toHaveLength(0);
    const unread = await fx.mailbox.list(successorKey);
    expect(unread).toHaveLength(1);
    expect(await fx.mailbox.read(successorKey, unread[0]!)).toMatchObject({ kind: "lane_retired", runId, jobId: "job_live" });
  });

  it("F14: the retired marker and the live supervisor jobId exist before the self-close waiter resolves", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx);
    const live: Live = { pane: childPane(), agent: childAgent() };
    const selfClose = createSelfCloseTracker();
    // The supervisor settles the instant its pending claim resolves — the
    // JobRegistry runner then skips the settled record, so a lookup after that
    // moment loses the jobId; its persistTerminalEvent reads the marker there too.
    let settled = false;
    let markerAtWake: boolean | undefined;
    let waiter: Promise<boolean> | undefined;
    const jobs = { activeSupervisorFor: () => (settled ? undefined : { jobId: "job_live" }) } as unknown as Pick<JobRegistry, "activeSupervisorFor">;
    const cli = fakeCli(live, {
      onClose: async () => {
        // Mid-close, the supervisor has observed the pane absent and claimed the
        // pending attempt; it is now waiting on the daemon's outcome.
        const claim = selfClose.consume("p-child");
        expect(claim).toBeInstanceOf(Promise);
        waiter = (claim as Promise<boolean>).then((suppress) => {
          markerAtWake = retirer.retiredByDaemon(runId);
          settled = true;
          return suppress;
        });
      },
    });
    const { deps, clock } = retirerDeps(fx, live, { cli, selfClose, jobs });
    // Declared after the closure that reads it; the closure only runs mid-close, once initialized.
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);

    expect(await waiter).toBe(true);
    expect(markerAtWake).toBe(true);
    expect(retirer.view(runId)).toMatchObject({ state: "retired" });
    const unread = await fx.mailbox.list(ownerKey);
    expect(unread).toHaveLength(1);
    expect(await fx.mailbox.read(ownerKey, unread[0]!)).toMatchObject({ kind: "lane_retired", runId, jobId: "job_live" });
  });

  it("refuses a handed_off run marked provider_limit or cycle_reopened, in the sweep and under the lock", async () => {
    const fx = await fixture();
    // The current cycle stalled on a typed provider limit: the manager decides.
    const limited = await seedRun(fx, { detail: "provider_limit" });
    // A follow-up cycle reopened the run after the acceptance: the accepted
    // artifact no longer describes the lane until a fresh acceptance clears it.
    const reopened = await seedRun(fx, { detail: "cycle_reopened", paneId: "p-child-2", terminalId: "t2", session: { ...childSession, value: "/pi/child-2.jsonl" } });
    const live: Live = { pane: childPane(), agent: childAgent() };
    const second: Live = {
      pane: childPane({ pane_id: "p-child-2", terminal_id: "t2", agent_session: { ...childSession, value: "/pi/child-2.jsonl" }, tokens: childTokens({ ...childSession, value: "/pi/child-2.jsonl" }) }),
      agent: childAgent({ pane_id: "p-child-2", terminal_id: "t2", agent_session: { ...childSession, value: "/pi/child-2.jsonl" }, tokens: childTokens({ ...childSession, value: "/pi/child-2.jsonl" }) }),
    };
    const { deps, clock } = retirerDeps(fx, live, { snapshot: async () => snapshotFor(live, { panes: second.pane === undefined ? [] : [second.pane], agents: second.agent === undefined ? [] : [second.agent] }) });
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(limited.runId)).toMatchObject({ state: "refused", reason: "provider_limit" });
    expect(retirer.view(reopened.runId)).toMatchObject({ state: "refused", reason: "cycle_reopened" });
    expect(closes(deps)).toEqual([]);
    // Each refusal journals once, not every sweep.
    await retirer.sweep();
    expect(fx.lines.filter((line) => line.includes("reason=provider_limit"))).toHaveLength(1);
    expect(fx.lines.filter((line) => line.includes("reason=cycle_reopened"))).toHaveLength(1);

    // A fresh acceptance clears the mark, and the lane retires on a later sweep.
    await updateHandoffState(limited.allocation, (state) => { delete state.lifecycle.detail; });
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(limited.runId)).toMatchObject({ state: "retired" });

    // The under-lock re-read refuses a mark that lands in the lock window.
    const late = await seedRun(fx, { paneId: "p-child-2", terminalId: "t2", session: { ...childSession, value: "/pi/child-2.jsonl" } });
    await updateHandoffState(reopened.allocation, (state) => { state.lifecycle.state = "cancelled"; });
    const lock = fakePaneLock({ onAcquire: async () => { await updateHandoffState(late.allocation, (state) => { state.lifecycle.detail = "cycle_reopened"; }); } });
    const lateDeps = retirerDeps(fx, second, { options: { paneLock: lock.guard } });
    const lateRetirer = createLaneRetirer(lateDeps.deps);
    await sweepPastGrace(lateRetirer, lateDeps.clock);
    expect(lateRetirer.view(late.runId)).toMatchObject({ state: "refused", reason: "recheck_cycle_reopened" });
    expect(closes(lateDeps.deps)).toEqual([]);
  });

  it("never retires a run whose lifecycle is not handed_off", async () => {
    const fx = await fixture();
    for (const lifecycle of ["awaiting_handoff", "recovery_pending", "cancelled", "failed"] as const) {
      const { runId } = await seedRun(fx, { lifecycle });
      const live: Live = { pane: childPane(), agent: childAgent() };
      const { deps, clock } = retirerDeps(fx, live);
      const retirer = createLaneRetirer(deps);
      await sweepPastGrace(retirer, clock);
      expect(retirer.view(runId)).toBeUndefined();
      expect(live.pane).not.toBeUndefined();
      expect(closes(deps)).toHaveLength(0);
    }
    expect(await fx.mailbox.list(ownerKey)).toHaveLength(0);
  });

  it("refuses a run whose sidecar is missing or malformed", async () => {
    const fx = await fixture();
    const { allocation, runId } = await seedRun(fx);
    await writeFile(allocation.statePath, "{not json", { mode: 0o600 });
    const live: Live = { pane: childPane(), agent: childAgent() };
    const { deps, clock } = retirerDeps(fx, live);
    const retirer = createLaneRetirer(deps);
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "refused", reason: expect.stringMatching(/^sidecar_/) });
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(live.pane).not.toBeUndefined();
    expect(fx.lines.some((line) => line.includes(`run=${runId}`) && line.includes("decision=refused"))).toBe(true);
  });

  it("refuses an unbound child identity and an unusable session key", async () => {
    const fx = await fixture();
    const unbound = await seedRun(fx);
    await updateHandoffState(unbound.allocation, (state) => {
      state.child.terminalId = null;
      state.nativeSession = null;
    });
    const malformed = await seedRun(fx);
    await updateHandoffState(malformed.allocation, (state) => {
      state.nativeSession = { source: "herdr:pi", agent: "pi", kind: "path", value: "bad\nvalue" };
    });
    const live: Live = { pane: childPane(), agent: childAgent() };
    const { deps, clock } = retirerDeps(fx, live);
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(unbound.runId)).toMatchObject({ state: "refused", reason: "child_identity_unbound" });
    expect(retirer.view(malformed.runId)).toMatchObject({ state: "refused", reason: "child_session_invalid" });
    expect(live.pane).not.toBeUndefined();
  });

  it("skips a provably absent child and defers an ambiguous one", async () => {
    const fx = await fixture();
    const absent = await seedRun(fx, { paneId: "p-absent", terminalId: "t-absent" });
    const ambiguous = await seedRun(fx);
    const live: Live = {};
    const { deps, clock } = retirerDeps(fx, live, {
      snapshot: async () => snapshotFor(live, {
        panes: [childPane(), childPane({ pane_id: "p-other" })],
        agents: [childAgent(), childAgent({ pane_id: "p-other" })],
      }),
    });
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    // Absent: no ledger entry at all — nothing to project or retire.
    expect(retirer.view(absent.runId)).toBeUndefined();
    // Two panes on the recorded terminal is ambiguity, never a close.
    expect(retirer.view(ambiguous.runId)).toMatchObject({ state: "deferred", reason: "child_terminal_ambiguous:2" });
    expect(fx.lines.some((line) => line.includes(`run=${absent.runId}`) && line.includes("decision=skipped reason=child_absent"))).toBe(true);
  });

  it("journals a skipped child_absent once per decision change, not once per sweep", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx);
    const live: Live = {};
    const { deps } = retirerDeps(fx, live);
    const retirer = createLaneRetirer(deps);
    const skips = () => fx.lines.filter((line) => line.includes(`run=${runId}`) && line.includes("decision=skipped reason=child_absent"));

    // A long-gone child is skipped on every sweep but journaled only once.
    await retirer.sweep();
    await retirer.sweep();
    await retirer.sweep();
    expect(retirer.view(runId)).toBeUndefined();
    expect(skips()).toHaveLength(1);

    // The pane reappears: a changed decision journals, and the renewed
    // absence journals the skip again — a change, never a repetition.
    live.pane = childPane();
    live.agent = childAgent();
    await retirer.sweep();
    expect(skips()).toHaveLength(1);
    expect(fx.lines.some((line) => line.includes(`run=${runId}`) && line.includes("decision=watching"))).toBe(true);
    live.pane = undefined;
    live.agent = undefined;
    await retirer.sweep();
    await retirer.sweep();
    expect(skips()).toHaveLength(2);
  });

  it("resets the stability clock on seq changes and on working status", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx);
    const live: Live = { pane: childPane(), agent: childAgent() };
    const { deps, clock } = retirerDeps(fx, live);
    const retirer = createLaneRetirer(deps);
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "watching" });

    // A seq bump inside the grace restarts the observation.
    live.pane = childPane({ state_change_seq: 6 });
    live.agent = childAgent({ state_change_seq: 6 });
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "watching", stableForMs: 0 });
    expect(live.pane).not.toBeUndefined();

    // A working status also resets — the lane must stay idle the whole grace.
    live.pane = childPane({ agent_status: "working", state_change_seq: 7 });
    live.agent = childAgent({ agent_status: "working", state_change_seq: 7 });
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "deferred", reason: "child_active:working" });
    live.pane = childPane({ state_change_seq: 8 });
    live.agent = childAgent({ state_change_seq: 8 });
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "watching", stableForMs: 0 });

    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "retired" });
  });

  it("defers while the agent record carries no usable state_change_seq or status, and reads the agent's counter when only the pane lacks one", async () => {
    // Both records lack the counter.
    const fx = await fixture();
    const { runId } = await seedRun(fx);
    const pane = childPane();
    const agent = childAgent();
    delete pane.state_change_seq;
    delete agent.state_change_seq;
    let live: Live = { pane, agent };
    let { deps, clock } = retirerDeps(fx, live);
    let retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "deferred", reason: "state_change_seq_unavailable" });
    expect(live.pane).not.toBeUndefined();

    // F2/F12: the pane's counter never stands in for a missing agent counter.
    const fx2 = await fixture();
    const paneOnly = await seedRun(fx2);
    const agentNoSeq = childAgent();
    delete agentNoSeq.state_change_seq;
    live = { pane: childPane(), agent: agentNoSeq };
    ({ deps, clock } = retirerDeps(fx2, live));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(paneOnly.runId)).toMatchObject({ state: "deferred", reason: "state_change_seq_unavailable" });
    expect(live.pane).not.toBeUndefined();

    // F2/F12: nor does the pane's status stand in for a missing agent status.
    const fx3 = await fixture();
    const noStatus = await seedRun(fx3);
    const agentNoStatus = childAgent();
    delete agentNoStatus.agent_status;
    live = { pane: childPane(), agent: agentNoStatus };
    ({ deps, clock } = retirerDeps(fx3, live));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(noStatus.runId)).toMatchObject({ state: "deferred", reason: "lifecycle_status_unavailable" });
    expect(live.pane).not.toBeUndefined();

    // The agent record is the authority: a pane without a counter is fine
    // while the agent record carries one.
    const fx4 = await fixture();
    const agentOnly = await seedRun(fx4);
    const paneNoSeq = childPane();
    delete paneNoSeq.state_change_seq;
    live = { pane: paneNoSeq, agent: childAgent() };
    ({ deps, clock } = retirerDeps(fx4, live));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(agentOnly.runId)).toMatchObject({ state: "retired" });
    expect(live.pane).toBeUndefined();
  });

  it("F2/F12: a stale idle pane record never outvotes a fresh working or advanced agent record in the sweep", async () => {
    const cases: Array<{ name: string; agent: RawRecord; reason: string }> = [
      { name: "pane idle/5, agent working/6", agent: childAgent({ agent_status: "working", state_change_seq: 6 }), reason: "lifecycle_target_identity_contradiction" },
      { name: "pane idle/5, agent idle/6 (agent-only seq bump)", agent: childAgent({ state_change_seq: 6 }), reason: "lifecycle_target_identity_contradiction" },
      { name: "pane idle/5, agent working/5", agent: childAgent({ agent_status: "working" }), reason: "lifecycle_target_identity_contradiction" },
      { name: "pane revision 5, agent revision 6", agent: childAgent({ revision: 6 }), reason: "lifecycle_target_identity_contradiction" },
      { name: "agent status malformed", agent: childAgent({ agent_status: "spinning" }), reason: "lifecycle_target_record_malformed" },
    ];
    for (const entry of cases) {
      const fx = await fixture();
      const { runId } = await seedRun(fx);
      const live: Live = { pane: childPane(), agent: entry.agent };
      const { deps, clock } = retirerDeps(fx, live);
      const retirer = createLaneRetirer(deps);
      await sweepPastGrace(retirer, clock);
      clock.nowMs += GRACE_MS;
      await retirer.sweep();
      expect(retirer.view(runId), entry.name).toMatchObject({ state: "deferred", reason: entry.reason });
      expect(live.pane, entry.name).not.toBeUndefined();
      expect(closes(deps), entry.name).toHaveLength(0);
    }
  });

  it("F2/F12: the under-lock re-proof rejects a fresh agent record that contradicts the pane, an agent-only counter bump, and vanished counters", async () => {
    const cases: Array<{ name: string; getPane?: RawRecord; getAgent?: RawRecord; reason: string }> = [
      { name: "agent working/6 under lock", getAgent: childAgent({ agent_status: "working", state_change_seq: 6 }), reason: "recheck_lifecycle_target_identity_contradiction" },
      { name: "agent-only seq bump under lock", getAgent: childAgent({ state_change_seq: 6 }), reason: "recheck_lifecycle_target_identity_contradiction" },
      { name: "agent status gone under lock", getAgent: (() => { const agent = childAgent(); delete agent.agent_status; return agent; })(), reason: "recheck_lifecycle_status_unavailable" },
      {
        name: "both counters gone under lock",
        getPane: (() => { const pane = childPane(); delete pane.state_change_seq; return pane; })(),
        getAgent: (() => { const agent = childAgent(); delete agent.state_change_seq; return agent; })(),
        reason: "recheck_state_change_seq_unavailable",
      },
      {
        name: "agent counter advanced while the pane carries none",
        getPane: (() => { const pane = childPane(); delete pane.state_change_seq; return pane; })(),
        getAgent: childAgent({ state_change_seq: 9 }),
        reason: "recheck_seq",
      },
    ];
    for (const entry of cases) {
      const fx = await fixture();
      const { runId } = await seedRun(fx);
      const live: Live = { pane: childPane(), agent: childAgent() };
      const { deps, clock } = retirerDeps(fx, live, {
        cli: fakeCli(live, { ...(entry.getPane === undefined ? {} : { getPane: entry.getPane }), ...(entry.getAgent === undefined ? {} : { getAgent: entry.getAgent }) }),
      });
      const retirer = createLaneRetirer(deps);
      await sweepPastGrace(retirer, clock);
      expect(retirer.view(runId), entry.name).toMatchObject({ state: "deferred", reason: entry.reason });
      expect(live.pane, entry.name).not.toBeUndefined();
      expect(closes(deps), entry.name).toHaveLength(0);
      // The clock restarted: the next observation is fresh, not stale.
      await retirer.sweep();
      expect(retirer.view(runId), entry.name).toMatchObject({ state: "watching", stableForMs: 0 });
    }
  });

  it("F1/F8: the detection-screen digest must stay unchanged through the grace — a change, a failed read, or a truncated read resets or defers", async () => {
    // A screen change inside the grace restarts the observation even though
    // status and seq never moved — the stale-telemetry case.
    const fx = await fixture();
    const { runId } = await seedRun(fx);
    const live: Live = { pane: childPane(), agent: childAgent(), screen: "worker> done" };
    let { deps, clock } = retirerDeps(fx, live);
    let retirer = createLaneRetirer(deps);
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "watching", stableForMs: 0 });
    live.screen = "worker> running tests...";
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "watching", stableForMs: 0 });
    expect(live.pane).not.toBeUndefined();
    expect(closes(deps)).toHaveLength(0);
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "retired" });

    // An unreadable screen is no proof: defer and hold the clock.
    const fx2 = await fixture();
    const unreadable = await seedRun(fx2);
    const live2: Live = { pane: childPane(), agent: childAgent() };
    ({ deps, clock } = retirerDeps(fx2, live2, { cli: fakeCli(live2, { readError: Object.assign(new Error("read failed"), { code: "CLI_PROTOCOL_ERROR" }) }) }));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(unreadable.runId)).toMatchObject({ state: "deferred", reason: "screen_unavailable" });
    expect(live2.pane).not.toBeUndefined();

    // A truncated screen was not fully observed — it cannot count as unchanged.
    const fx3 = await fixture();
    const truncated = await seedRun(fx3);
    const live3: Live = { pane: childPane(), agent: childAgent() };
    ({ deps, clock } = retirerDeps(fx3, live3, { cli: fakeCli(live3, { readTruncated: true }) }));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(truncated.runId)).toMatchObject({ state: "deferred", reason: "screen_truncated" });
    expect(live3.pane).not.toBeUndefined();
  });

  it("F1/F8: the screen digest is re-read under the lock — a change or an unreadable screen defers and restarts the clock", async () => {
    // The screen changes inside the lock window: the proof is void.
    const fx = await fixture();
    const { runId } = await seedRun(fx);
    const live: Live = { pane: childPane(), agent: childAgent(), screen: "worker> done" };
    const lock = fakePaneLock({ onAcquire: async () => { live.screen = "worker> one more thing"; } });
    let { deps, clock } = retirerDeps(fx, live, { options: { paneLock: lock.guard } });
    let retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "deferred", reason: "recheck_screen" });
    expect(live.pane).not.toBeUndefined();
    expect(closes(deps)).toHaveLength(0);
    // The digest changed, so the clock restarted from the new screen.
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "watching", stableForMs: 0 });

    // The under-lock read fails: defer, never dispatch.
    const fx2 = await fixture();
    const unreadable = await seedRun(fx2);
    const live2: Live = { pane: childPane(), agent: childAgent() };
    const cliOpts: FakeCliOptions = {};
    const lock2 = fakePaneLock({ onAcquire: async () => { cliOpts.readError = Object.assign(new Error("read failed"), { code: "CLI_PROTOCOL_ERROR" }); } });
    ({ deps, clock } = retirerDeps(fx2, live2, { cli: fakeCli(live2, cliOpts), options: { paneLock: lock2.guard } }));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(unreadable.runId)).toMatchObject({ state: "deferred", reason: "recheck_screen_unavailable" });
    expect(live2.pane).not.toBeUndefined();
    expect(closes(deps)).toHaveLength(0);
  });

  it("refuses on missing, adopted, malformed, contradictory, or mismatched launch tokens", async () => {
    const fx = await fixture();
    const cases: Array<{ name: string; pane: RawRecord; agent: RawRecord; reason: string }> = [
      {
        name: "absent provenance",
        pane: childPane({ tokens: { identity_actor: "p-owner", identity_session: tokenValue(childSession.value) } }),
        agent: childAgent({ tokens: { identity_actor: "p-owner", identity_session: tokenValue(childSession.value) } }),
        reason: "token_provenance_absent",
      },
      {
        name: "adopted provenance",
        pane: childPane({ tokens: childTokens(childSession, { identity_provenance: "adopted" }) }),
        agent: childAgent({ tokens: childTokens(childSession, { identity_provenance: "adopted" }) }),
        reason: "token_provenance_not_launched",
      },
      {
        name: "malformed tokens",
        pane: childPane({ tokens: "not-a-record" }),
        agent: childAgent(),
        reason: "token_provenance_malformed",
      },
      {
        name: "contradictory provenance",
        pane: childPane({ tokens: childTokens(childSession, { identity_provenance: "adopted" }) }),
        agent: childAgent(),
        reason: "token_provenance_contradictory",
      },
      {
        name: "absent session token",
        pane: childPane({ tokens: { identity_provenance: "launched", identity_actor: "p-owner" } }),
        agent: childAgent({ tokens: { identity_provenance: "launched", identity_actor: "p-owner" } }),
        reason: "token_session_absent",
      },
      {
        name: "mismatched session token",
        pane: childPane({ tokens: childTokens(childSession, { identity_session: "other-session" }) }),
        agent: childAgent({ tokens: childTokens(childSession, { identity_session: "other-session" }) }),
        reason: "token_session_mismatch",
      },
    ];
    for (const entry of cases) {
      const { runId } = await seedRun(fx);
      const live: Live = { pane: entry.pane, agent: entry.agent };
      const { deps, clock } = retirerDeps(fx, live);
      const retirer = createLaneRetirer(deps);
      await sweepPastGrace(retirer, clock);
      expect(retirer.view(runId), entry.name).toMatchObject({ state: "refused", reason: entry.reason });
      expect(live.pane).not.toBeUndefined();
    }
  });

  it("keeps a lane whose task retention or pane token says keep", async () => {
    const fx = await fixture();
    const keptByTask = await seedRun(fx, { task: { ...task, retention: "keep" } });
    const live: Live = { pane: childPane(), agent: childAgent() };
    const { deps, clock } = retirerDeps(fx, live);
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(keptByTask.runId)).toMatchObject({ state: "kept", reason: "task_retention_keep" });
    expect(live.pane).not.toBeUndefined();
    expect((deps.cli as FakeCli).calls).toHaveLength(0);
    // `kept` is terminal — later sweeps spend no effort on it.
    await retirer.sweep();
    expect((deps.cli as FakeCli).calls).toHaveLength(0);

    // The cooperative fallback: a `retention=keep` pane token parks the lane.
    const fx2 = await fixture();
    const keptByToken = await seedRun(fx2);
    const live2: Live = {
      pane: childPane({ tokens: childTokens(childSession, { retention: "keep" }) }),
      agent: childAgent({ tokens: childTokens(childSession, { retention: "keep" }) }),
    };
    const deps2 = retirerDeps(fx2, live2);
    const retirer2 = createLaneRetirer(deps2.deps);
    await sweepPastGrace(retirer2, deps2.clock);
    expect(retirer2.view(keptByToken.runId)).toMatchObject({ state: "kept", reason: "token_retention_keep" });
  });

  it("F15: clearing the retention pane token releases a token-kept lane, while a task-field keep stays kept", async () => {
    const fx = await fixture();
    const keptByTask = await seedRun(fx, { task: { ...task, retention: "keep" } });
    const keptByToken = await seedRun(fx);
    const live: Live = {
      pane: childPane({ tokens: childTokens(childSession, { retention: "keep" }) }),
      agent: childAgent({ tokens: childTokens(childSession, { retention: "keep" }) }),
    };
    const { deps, clock } = retirerDeps(fx, live);
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(keptByTask.runId)).toMatchObject({ state: "kept", reason: "task_retention_keep" });
    expect(retirer.view(keptByToken.runId)).toMatchObject({ state: "kept", reason: "token_retention_keep" });
    expect(closes(deps)).toHaveLength(0);

    // `herdr pane report-metadata <pane> --source owner-retention --clear-token retention`
    live.pane = childPane();
    live.agent = childAgent();
    // Clearing the token restarts the stability grace rather than retiring at once.
    await retirer.sweep();
    expect(retirer.view(keptByToken.runId)).toMatchObject({ state: "watching" });
    expect(live.pane).not.toBeUndefined();
    expect(closes(deps)).toHaveLength(0);
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(live.pane).toBeUndefined();
    expect(retirer.view(keptByToken.runId)).toMatchObject({ state: "retired" });
    expect(retirer.retiredByDaemon(keptByToken.runId)).toBe(true);
    expect(closes(deps)).toHaveLength(1);
    // The immutable task field is not released by a pane-token change.
    expect(retirer.view(keptByTask.runId)).toMatchObject({ state: "kept", reason: "task_retention_keep" });
    expect(retirer.retiredByDaemon(keptByTask.runId)).toBe(false);
  });

  it("F16: a token-kept lane accrues no grace across kept sweeps — clearing keep starts a full window", async () => {
    const fx = await fixture();
    const kept = await seedRun(fx);
    const live: Live = {
      pane: childPane({ tokens: childTokens(childSession, { retention: "keep" }) }),
      agent: childAgent({ tokens: childTokens(childSession, { retention: "keep" }) }),
    };
    const { deps, clock } = retirerDeps(fx, live);
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(kept.runId)).toMatchObject({ state: "kept", reason: "token_retention_keep" });
    // Still kept a sweep later: the keep is read before any clock work.
    clock.nowMs += 60_000;
    await retirer.sweep();
    expect(retirer.view(kept.runId)).toMatchObject({ state: "kept", reason: "token_retention_keep" });
    // Clear the token one full grace later: no grace accrued while kept.
    live.pane = childPane();
    live.agent = childAgent();
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(kept.runId)).toMatchObject({ state: "watching" });
    expect(live.pane).not.toBeUndefined();
    expect(closes(deps)).toHaveLength(0);
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(live.pane).toBeUndefined();
    expect(retirer.view(kept.runId)).toMatchObject({ state: "retired" });
  });

  it("F4: an unreadable provenance never overrides a keep opt-out — only a genuinely missing record is legacy", async () => {
    // Malformed provenance on a kept lane: refuse, never fall back to retire.
    const fx = await fixture();
    const kept = await seedRun(fx, { task: { ...task, retention: "keep" } });
    await writeFile(join(kept.allocation.toolsDir, HANDOFF_PROVENANCE_NAME), "{not json", { mode: 0o600 });
    let live: Live = { pane: childPane(), agent: childAgent() };
    let { deps, clock } = retirerDeps(fx, live);
    let retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(kept.runId)).toMatchObject({ state: "refused", reason: "provenance_unreadable" });
    expect(live.pane).not.toBeUndefined();
    expect((deps.cli as FakeCli).calls).toHaveLength(0);

    // An untrusted (group/world-writable) record refuses the same way.
    const fx2 = await fixture();
    const untrusted = await seedRun(fx2, { task: { ...task, retention: "keep" } });
    await chmod(join(untrusted.allocation.toolsDir, HANDOFF_PROVENANCE_NAME), 0o666);
    live = { pane: childPane(), agent: childAgent() };
    ({ deps, clock } = retirerDeps(fx2, live));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(untrusted.runId)).toMatchObject({ state: "refused", reason: "provenance_unreadable" });
    expect(live.pane).not.toBeUndefined();

    // A transferred run whose record became unreadable refuses rather than
    // protecting the original manager pane in the current owner's place.
    const fx3 = await fixture();
    const transferred = await seedRun(fx3);
    await transferTo(transferred.allocation, successorSession);
    await writeFile(join(transferred.allocation.toolsDir, HANDOFF_PROVENANCE_NAME), "{not json", { mode: 0o600 });
    live = { pane: childPane(), agent: childAgent() };
    ({ deps, clock } = retirerDeps(fx3, live));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(transferred.runId)).toMatchObject({ state: "refused", reason: "provenance_unreadable" });
    expect(live.pane).not.toBeUndefined();
  });

  it("refuses a pane other records name as their manager", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx);
    const live: Live = { pane: childPane(), agent: childAgent() };
    const { deps, clock } = retirerDeps(fx, live, {
      snapshot: async () => snapshotFor(live, {
        panes: [{ pane_id: "p-grandchild", terminal_id: "t-grand", tab_id: "tab-owner", workspace_id: "w1", agent_status: "idle", tokens: { identity_actor: "p-child" } }],
        agents: [{ pane_id: "p-grandchild", tokens: { identity_actor: "p-child" } }],
      }),
    });
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "refused", reason: "child_is_manager:manages_children" });
    expect(live.pane).not.toBeUndefined();
  });

  it("refuses a caller-policy failure and an open — effecting or merely recorded — intent ledger under the child's session", async () => {
    // Malformed scope evidence makes classification itself refuse.
    const fx = await fixture();
    const policyRun = await seedRun(fx);
    let live: Live = {
      pane: childPane({ tokens: childTokens(childSession, { identity_scope: { bad: true } }) }),
      agent: childAgent(),
    };
    let { deps, clock } = retirerDeps(fx, live);
    let retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(policyRun.runId)).toMatchObject({ state: "refused", reason: "caller_policy_unavailable" });

    // An `effecting` intent under the child's own session key refuses.
    const fx2 = await fixture();
    const openRun = await seedRun(fx2);
    const begun = await fx2.intents.begin({
      managerSessionKey: childKey,
      idempotencyKey: "sub-open",
      task: { objective: task.objective, scope: task.scope, doneWhen: task.doneWhen, constraints: task.constraints },
      projectRoot: "/project",
    });
    if (begun.kind !== "launch") throw new Error("expected launch");
    await fx2.intents.markEffecting(begun.intent);
    live = { pane: childPane(), agent: childAgent() };
    ({ deps, clock } = retirerDeps(fx2, live));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(openRun.runId)).toMatchObject({ state: "refused", reason: "child_intent_open" });

    // F5: a `recorded` intent — its launch request may be executing right
    // now, with no child token yet to mark the pane a manager — is open too.
    const fx3 = await fixture();
    const recordedRun = await seedRun(fx3);
    await recordedChildIntent(fx3.intents, "sub-recorded");
    live = { pane: childPane(), agent: childAgent() };
    ({ deps, clock } = retirerDeps(fx3, live));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(recordedRun.runId)).toMatchObject({ state: "refused", reason: "child_intent_open" });
    expect(live.pane).not.toBeUndefined();
    expect(closes(deps)).toHaveLength(0);
  });

  it("refuses a sub-manager with unproven or nonterminal recorded children, then retires once they settle", async () => {
    // A child runId with no readable sidecar is unproven — refuse.
    const fx = await fixture();
    const unproven = await seedRun(fx);
    await recordChildIntent(fx.intents, "sub-ghost", [{ name: "ghost", runId: "11111111-2222-4333-8444-555555555555" }]);
    let live: Live = { pane: childPane(), agent: childAgent() };
    let { deps, clock } = retirerDeps(fx, live);
    let retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(unproven.runId)).toMatchObject({ state: "refused", reason: "child_intent_child_untrusted" });

    // A recorded child whose sidecar is not yet terminal refuses the same way.
    const fx2 = await fixture();
    const managed = await seedRun(fx2);
    const liveChild = await seedRun(fx2, { lifecycle: "awaiting_handoff", paneId: "p-sub", terminalId: "t-sub" });
    await recordChildIntent(fx2.intents, "sub-live", [{ name: "sub", runId: liveChild.runId }, { name: "alias" }]);
    live = { pane: childPane(), agent: childAgent() };
    ({ deps, clock } = retirerDeps(fx2, live));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(managed.runId)).toMatchObject({ state: "refused", reason: "child_manages_live_intent" });

    // Settled recorded children stop refusing — the close proceeds.
    await updateHandoffState(liveChild.allocation, (state) => {
      state.lifecycle.state = "failed";
    });
    ({ deps, clock } = retirerDeps(fx2, live));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(managed.runId)).toMatchObject({ state: "retired" });
    expect(live.pane).toBeUndefined();
  });

  it("refuses while the child's own mailbox holds unread events", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx);
    await fx.mailbox.writeGapEvent(childKey, { from: "2026-10-01T00:00:00.000Z", to: "2026-10-01T01:00:00.000Z", lost: {} });
    const live: Live = { pane: childPane(), agent: childAgent() };
    const { deps, clock } = retirerDeps(fx, live);
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "refused", reason: "child_mailbox_unread" });
    expect(live.pane).not.toBeUndefined();
  });

  it("F13: reads the child's own ledger directly — the manager enumeration is never consulted — and defers when the ledger or the mailbox cannot be read", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx);
    const live: Live = { pane: childPane(), agent: childAgent() };

    // A broken manager enumeration is irrelevant: only the child's ledger is read.
    const listed: string[] = [];
    const noManagers: IntentStore = {
      ...fx.intents,
      listManagers: async () => { throw Object.assign(new Error("io"), { code: "INTENT_STORE_UNAVAILABLE" }); },
      list: async (key) => { listed.push(key); return fx.intents.list(key); },
    };
    let { deps, clock } = retirerDeps(fx, live, { intents: noManagers });
    let retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "retired" });
    expect(listed).toContain(childKey);

    // The child's own ledger read fails — defer.
    const fx2 = await fixture();
    const ledgerRun = await seedRun(fx2);
    const brokenLedger: IntentStore = {
      ...fx2.intents,
      list: async (key) => (key === childKey ? Promise.reject(Object.assign(new Error("io"), { code: "INTENT_STORE_UNAVAILABLE" })) : fx2.intents.list(key)),
    };
    const live2: Live = { pane: childPane(), agent: childAgent() };
    ({ deps, clock } = retirerDeps(fx2, live2, { intents: brokenLedger }));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(ledgerRun.runId)).toMatchObject({ state: "deferred", reason: "intents_unavailable" });
    expect(live2.pane).not.toBeUndefined();

    // A mailbox list failure also defers — proof gaps never close.
    const brokenMailbox: Pick<Mailbox, "writeRunEvent" | "list"> = {
      writeRunEvent: (input) => fx2.mailbox.writeRunEvent(input),
      list: async () => { throw Object.assign(new Error("io"), { code: "MAILBOX_UNAVAILABLE" }); },
    };
    ({ deps, clock } = retirerDeps(fx2, live2, { mailbox: brokenMailbox }));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(ledgerRun.runId)).toMatchObject({ state: "deferred", reason: "mailbox_unavailable" });
    expect(live2.pane).not.toBeUndefined();
  });

  it("refuses when the owner's pane sits inside the cascade and defers on invalid topology", async () => {
    // The recorded current owner IS the child pane — the cascade always reaches it.
    const fx = await fixture();
    const { allocation, runId } = await seedRun(fx);
    await transferTo(allocation, childSession);
    let live: Live = { pane: childPane(), agent: childAgent() };
    let { deps, clock } = retirerDeps(fx, live);
    let retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "refused", reason: "owner_topology_protected" });
    expect(live.pane).not.toBeUndefined();

    // A dangling parent — the child's tab has no record — is malformed topology.
    const fx2 = await fixture();
    const dangling = await seedRun(fx2);
    live = { pane: childPane({ tab_id: "tab-ghost" }), agent: childAgent() };
    ({ deps, clock } = retirerDeps(fx2, live));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(dangling.runId)).toMatchObject({ state: "deferred", reason: "topology_invalid" });
  });

  it("retires with no provenance record by falling back to the launch manager pane", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx, { provenance: false });
    const live: Live = { pane: childPane(), agent: childAgent() };
    const { deps, clock } = retirerDeps(fx, live);
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "retired" });
  });

  it("defers a focused pane only for the bounded count, then retires", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx);
    const live: Live = { pane: childPane({ focused: true }), agent: childAgent() };
    const { deps, clock } = retirerDeps(fx, live, { options: { maxFocusDefers: 2 } });
    const retirer = createLaneRetirer(deps);
    await retirer.sweep();
    for (let sweep = 0; sweep < 2; sweep += 1) {
      clock.nowMs += GRACE_MS;
      await retirer.sweep();
      expect(retirer.view(runId)).toMatchObject({ state: "deferred", reason: "focused" });
    }
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "retired" });
    expect(live.pane).toBeUndefined();
  });

  it("defers at close time when the under-lock pane is focused, drifted, or busy", async () => {
    // The snapshot records an unfocused idle pane; `pane get` reveals focused.
    const fx = await fixture();
    const focused = await seedRun(fx);
    let live: Live = { pane: childPane(), agent: childAgent() };
    let { deps, clock } = retirerDeps(fx, live, { cli: fakeCli(live, { getPane: childPane({ focused: true }) }) });
    let retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(focused.runId)).toMatchObject({ state: "deferred", reason: "recheck_focused" });
    expect(live.pane).not.toBeUndefined();

    // A session that drifted between the snapshot and the lock refuses the close.
    const fx2 = await fixture();
    const drifted = await seedRun(fx2);
    live = { pane: childPane(), agent: childAgent() };
    ({ deps, clock } = retirerDeps(fx2, live, {
      cli: fakeCli(live, { getAgent: childAgent({ agent_session: { ...childSession, value: "/pi/other.jsonl" } }) }),
    }));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(drifted.runId)).toMatchObject({ state: "deferred", reason: "recheck_identity" });

    // A coherent working tuple under the lock defers without spending an attempt.
    const fx3 = await fixture();
    const busy = await seedRun(fx3);
    const moved = await seedRun(fx3);
    live = { pane: childPane(), agent: childAgent() };
    ({ deps, clock } = retirerDeps(fx3, live, {
      cli: fakeCli(live, { getPane: childPane({ agent_status: "working", state_change_seq: 9 }), getAgent: childAgent({ agent_status: "working", state_change_seq: 9 }) }),
    }));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    // Status wins over the seq re-check — both refuse the same way.
    expect(retirer.view(busy.runId)).toMatchObject({ state: "deferred", reason: "recheck_status" });
    expect(retirer.view(moved.runId)).toMatchObject({ state: "deferred", reason: "recheck_status" });
  });

  it("re-proves the terminal identity and the stability seq under the lock", async () => {
    // Records that join cleanly but name a different terminal fail the field check.
    const fx = await fixture();
    const moved = await seedRun(fx);
    let live: Live = { pane: childPane(), agent: childAgent() };
    let { deps, clock } = retirerDeps(fx, live, {
      cli: fakeCli(live, { getPane: childPane({ terminal_id: "t2" }), getAgent: childAgent({ terminal_id: "t2" }) }),
    });
    let retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(moved.runId)).toMatchObject({ state: "deferred", reason: "recheck_identity" });
    expect(live.pane).not.toBeUndefined();

    // A coherent seq bump observed only under the lock restarts the stability clock.
    const fx2 = await fixture();
    const { runId } = await seedRun(fx2);
    live = { pane: childPane(), agent: childAgent() };
    ({ deps, clock } = retirerDeps(fx2, live, {
      cli: fakeCli(live, { getPane: childPane({ state_change_seq: 9 }), getAgent: childAgent({ state_change_seq: 9 }) }),
    }));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "deferred", reason: "recheck_seq" });
    expect(live.pane).not.toBeUndefined();
    // The clock restarted: the unchanged observation is fresh, not stale.
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "watching", stableForMs: 0 });
  });

  it("defers when the under-lock records drop the launch tokens", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx);
    const live: Live = { pane: childPane(), agent: childAgent() };
    const { deps, clock } = retirerDeps(fx, live, {
      cli: fakeCli(live, {
        getPane: childPane({ tokens: { identity_actor: "p-owner" } }),
        getAgent: childAgent({ tokens: { identity_actor: "p-owner" } }),
      }),
    });
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "deferred", reason: "recheck_tokens" });
    expect(live.pane).not.toBeUndefined();

    // The provenance token survives but the session token is gone — the
    // second under-lock token gate refuses the same way.
    const fx2 = await fixture();
    const dropped = await seedRun(fx2);
    const live2: Live = { pane: childPane(), agent: childAgent() };
    const deps2 = retirerDeps(fx2, live2, {
      cli: fakeCli(live2, {
        getPane: childPane({ tokens: { identity_provenance: "launched", identity_actor: "p-owner" } }),
        getAgent: childAgent({ tokens: { identity_provenance: "launched", identity_actor: "p-owner" } }),
      }),
    });
    const retirer2 = createLaneRetirer(deps2.deps);
    await sweepPastGrace(retirer2, deps2.clock);
    expect(retirer2.view(dropped.runId)).toMatchObject({ state: "deferred", reason: "recheck_tokens" });
  });

  it("F3: re-resolves the owner, the child's mailbox, and the child's intents under the locks — a transfer inside the lock window refuses the close", async () => {
    // The owner transfers the run to its own child between approval and the
    // lock: the fresh provenance makes the child the current owner, and the
    // topology re-validation refuses exactly as a pre-sweep transfer would.
    const fx = await fixture();
    const transferred = await seedRun(fx);
    let live: Live = { pane: childPane(), agent: childAgent() };
    let lock = fakePaneLock({ onAcquire: () => transferTo(transferred.allocation, childSession) });
    let { deps, clock } = retirerDeps(fx, live, { options: { paneLock: lock.guard } });
    let retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(transferred.runId)).toMatchObject({ state: "refused", reason: "recheck_owner_topology_protected" });
    expect(live.pane).not.toBeUndefined();
    expect(closes(deps)).toHaveLength(0);

    // An event landing in the child's mailbox inside the window refuses.
    const fx2 = await fixture();
    const mailed = await seedRun(fx2);
    live = { pane: childPane(), agent: childAgent() };
    lock = fakePaneLock({ onAcquire: async () => { await fx2.mailbox.writeGapEvent(childKey, { from: "2026-10-01T00:00:00.000Z", to: "2026-10-01T01:00:00.000Z", lost: {} }); } });
    ({ deps, clock } = retirerDeps(fx2, live, { options: { paneLock: lock.guard } }));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(mailed.runId)).toMatchObject({ state: "refused", reason: "recheck_child_mailbox_unread" });
    expect(live.pane).not.toBeUndefined();
    expect(closes(deps)).toHaveLength(0);

    // A launch intent recorded under the child's key inside the window refuses.
    const fx3 = await fixture();
    const launching = await seedRun(fx3);
    live = { pane: childPane(), agent: childAgent() };
    lock = fakePaneLock({ onAcquire: () => recordedChildIntent(fx3.intents, "sub-late") });
    ({ deps, clock } = retirerDeps(fx3, live, { options: { paneLock: lock.guard } }));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(launching.runId)).toMatchObject({ state: "refused", reason: "recheck_child_intent_open" });
    expect(live.pane).not.toBeUndefined();
    expect(closes(deps)).toHaveLength(0);
  });

  it("F3: holds the run flock across the re-proof and the close dispatch, defers without an attempt when it cannot be taken, and keeps a proven close through a release fault", async () => {
    // The close dispatch runs while the run's native flock is held: a
    // concurrent transfer (which takes the same flock) cannot interleave.
    const fx = await fixture();
    const { allocation, runId } = await seedRun(fx);
    const live: Live = { pane: childPane(), agent: childAgent() };
    const probe = async (): Promise<boolean> => {
      try {
        const holder = await acquireFlockHolder({ lockPath: allocation.lockPath, wait: "nonblock", readyMarker: "HERDR_RETIRE_TEST_PROBE", subject: "Probe", failure: (message) => new Error(message) });
        await holder.release();
        return false;
      } catch {
        return true;
      }
    };
    let heldDuringClose: boolean | undefined;
    const cli = fakeCli(live, { onClose: async () => { heldDuringClose = await probe(); } });
    let { deps, clock } = retirerDeps(fx, live, { cli });
    let retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "retired" });
    expect(heldDuringClose).toBe(true);
    // Released afterwards — the lane_retired write took the same flock and landed.
    expect(await probe()).toBe(false);
    expect(await fx.mailbox.list(ownerKey)).toHaveLength(1);

    // An unacquirable run flock defers before any under-lock read and spends
    // no attempt: the first real close failure afterwards is still a retry.
    const fx2 = await fixture();
    const contended = await seedRun(fx2);
    const live2: Live = { pane: childPane(), agent: childAgent() };
    const real = daemonRunOwnership(fx2.allocator);
    const gate = { fail: true };
    const flaky: LaneRetirerDeps["ownership"] = {
      withRunFlock: (id, section) => (gate.fail ? Promise.reject(new OwnershipError("OWNERSHIP_UNAVAILABLE")) : real.withRunFlock(id, section)),
    };
    const cliOpts: FakeCliOptions = { closeError: Object.assign(new Error("socket dropped"), { code: "CLI_UNAVAILABLE" }) };
    ({ deps, clock } = retirerDeps(fx2, live2, { ownership: flaky, cli: fakeCli(live2, cliOpts), options: { maxAttempts: 2 } }));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(contended.runId)).toMatchObject({ state: "deferred", reason: "run_lock_unavailable" });
    expect(lockedCalls(deps)).toHaveLength(0);
    gate.fail = false;
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(contended.runId)).toMatchObject({ state: "deferred", reason: "close_MUTATION_UNCERTAIN" });
    expect(closes(deps)).toHaveLength(1);

    // A release fault after the section ran cannot recall a proven close:
    // the recorded outcome stands and the event is written.
    const fx3 = await fixture();
    const faulting = await seedRun(fx3);
    const live3: Live = { pane: childPane(), agent: childAgent() };
    const real3 = daemonRunOwnership(fx3.allocator);
    const leaky: LaneRetirerDeps["ownership"] = {
      withRunFlock: async (id, section) => {
        await real3.withRunFlock(id, section);
        throw new OwnershipError("OWNERSHIP_UNAVAILABLE");
      },
    };
    ({ deps, clock } = retirerDeps(fx3, live3, { ownership: leaky }));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(faulting.runId)).toMatchObject({ state: "retired" });
    expect(retirer.retiredByDaemon(faulting.runId)).toBe(true);
    expect(await fx3.mailbox.list(ownerKey)).toHaveLength(1);
  });

  it("F3: re-reads the sidecar and the provenance under the locks — a released or unreadable run, an unreadable record, or a late keep never closes", async () => {
    // The run left `handed_off` inside the window.
    const fx = await fixture();
    const released = await seedRun(fx);
    let live: Live = { pane: childPane(), agent: childAgent() };
    let lock = fakePaneLock({ onAcquire: async () => { await updateHandoffState(released.allocation, (state) => { state.lifecycle.state = "cancelled"; }); } });
    let { deps, clock } = retirerDeps(fx, live, { options: { paneLock: lock.guard } });
    let retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(released.runId)).toMatchObject({ state: "deferred", reason: "recheck_lifecycle" });
    expect(live.pane).not.toBeUndefined();
    expect(lockedCalls(deps)).toHaveLength(0);

    // The sidecar became unreadable inside the window.
    const fx2 = await fixture();
    const broken = await seedRun(fx2);
    live = { pane: childPane(), agent: childAgent() };
    lock = fakePaneLock({ onAcquire: () => writeFile(broken.allocation.statePath, "{not json", { mode: 0o600 }) });
    ({ deps, clock } = retirerDeps(fx2, live, { options: { paneLock: lock.guard } }));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(broken.runId)).toMatchObject({ state: "deferred", reason: "recheck_sidecar" });
    expect(live.pane).not.toBeUndefined();

    // The provenance became unreadable inside the window.
    const fx3 = await fixture();
    const corrupted = await seedRun(fx3);
    live = { pane: childPane(), agent: childAgent() };
    lock = fakePaneLock({ onAcquire: () => writeFile(join(corrupted.allocation.toolsDir, HANDOFF_PROVENANCE_NAME), "{not json", { mode: 0o600 }) });
    ({ deps, clock } = retirerDeps(fx3, live, { options: { paneLock: lock.guard } }));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(corrupted.runId)).toMatchObject({ state: "deferred", reason: "recheck_provenance_unreadable" });
    expect(live.pane).not.toBeUndefined();
    expect(closes(deps)).toHaveLength(0);

    // A keep that appears under the lock — in the task contract or as a pane
    // token — parks the lane instead of closing it.
    const fx4 = await fixture();
    const lateKeep = await seedRun(fx4);
    live = { pane: childPane(), agent: childAgent() };
    lock = fakePaneLock({ onAcquire: async () => {
      const prior = await readHandoffProvenance(lateKeep.allocation);
      await writeHandoffProvenance(lateKeep.allocation, { ...prior, v: 2, owners: [{ session: ownerSession, from: prior.createdAt, to: null, reason: "launch" }], task: { ...prior.task, retention: "keep" } });
    } });
    ({ deps, clock } = retirerDeps(fx4, live, { options: { paneLock: lock.guard } }));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(lateKeep.runId)).toMatchObject({ state: "kept", reason: "task_retention_keep" });
    expect(live.pane).not.toBeUndefined();

    const fx5 = await fixture();
    const tokenKeep = await seedRun(fx5);
    live = { pane: childPane(), agent: childAgent() };
    ({ deps, clock } = retirerDeps(fx5, live, {
      cli: fakeCli(live, {
        getPane: childPane({ tokens: childTokens(childSession, { retention: "keep" }) }),
        getAgent: childAgent({ tokens: childTokens(childSession, { retention: "keep" }) }),
      }),
    }));
    retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(tokenKeep.runId)).toMatchObject({ state: "kept", reason: "token_retention_keep" });
    expect(live.pane).not.toBeUndefined();
  });

  it("F7: checks the lease immediately before dispatch — a lost lease defers without spending an attempt", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx);
    const live: Live = { pane: childPane(), agent: childAgent() };
    const lockOpts: FakeLockOptions = { checkError: Object.assign(new Error("holder is not live"), { code: "PANE_WRITE_LOCK_UNAVAILABLE" }) };
    const lock = fakePaneLock(lockOpts);
    const cliOpts: FakeCliOptions = { closeError: Object.assign(new Error("socket dropped"), { code: "CLI_UNAVAILABLE" }) };
    const { deps, clock } = retirerDeps(fx, live, { cli: fakeCli(live, cliOpts), options: { paneLock: lock.guard, maxAttempts: 2 } });
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(lock.checks).toEqual(["p-child"]);
    expect(retirer.view(runId)).toMatchObject({ state: "deferred", reason: "pane_lock_lost" });
    expect(closes(deps)).toHaveLength(0);
    expect(live.pane).not.toBeUndefined();
    // No attempt was spent: with the lease live again, the first real close
    // failure is a retry, not the terminal `failed`.
    lockOpts.checkError = undefined;
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(lock.checks).toEqual(["p-child", "p-child"]);
    expect(retirer.view(runId)).toMatchObject({ state: "deferred", reason: "close_MUTATION_UNCERTAIN" });
    expect(closes(deps)).toHaveLength(1);
  });

  it("ADR-040 amendment: a handed_off lane with no accepted digest never retires — there is no anchor to prove against", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx, { digest: false });
    const live: Live = { pane: childPane(), agent: childAgent() };
    const { deps, clock } = retirerDeps(fx, live);
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "refused", reason: "trace_anchor_missing" });
    expect(live.pane).not.toBeUndefined();
    expect(await fx.mailbox.list(ownerKey)).toHaveLength(0);
  });

  it("survives a failed snapshot, an absent or unreadable runs dir, and a mid-sweep fault", async () => {
    const fx = await fixture();
    const { allocation, runId } = await seedRun(fx);
    const live: Live = { pane: childPane(), agent: childAgent() };

    // Snapshot failure: no classification is ever inferred.
    const failing = retirerDeps(fx, live, { snapshot: async () => { throw new Error("socket gone"); } });
    await createLaneRetirer(failing.deps).sweep();
    expect(fx.lines.some((line) => line.includes("decision=sweep_unavailable reason=ERROR"))).toBe(true);

    // An absent runs dir is an empty sweep; a non-directory one is logged.
    const absentRuns: HandoffNamespace = { dir: join(fx.handoffNs.dir, "gone"), endpoint: fx.handoffNs.endpoint };
    const deps2 = retirerDeps(fx, live, { runs: absentRuns });
    await createLaneRetirer(deps2.deps).sweep();
    await writeFile(join(fx.handoffNs.dir, "file"), "x", { mode: 0o600 });
    const fileRuns: HandoffNamespace = { dir: join(fx.handoffNs.dir, "file"), endpoint: fx.handoffNs.endpoint };
    const deps3 = retirerDeps(fx, live, { runs: fileRuns });
    await createLaneRetirer(deps3.deps).sweep();
    expect(deps3.clock.nowMs).toBeGreaterThan(0);

    // A mid-evaluate fault — the get re-read throws — defers that run only,
    // and the run flock it threw under is released.
    const deps4 = retirerDeps(fx, live, { cli: fakeCli(live, { getError: Object.assign(new Error("gone"), { code: "CLI_PROTOCOL_ERROR" }) }) });
    const retirer4 = createLaneRetirer(deps4.deps);
    await sweepPastGrace(retirer4, deps4.clock);
    expect(retirer4.view(runId)).toMatchObject({ state: "deferred", reason: "sweep_error:CLI_PROTOCOL_ERROR" });
    const released = await acquireFlockHolder({ lockPath: allocation.lockPath, wait: "nonblock", readyMarker: "HERDR_RETIRE_TEST_PROBE", subject: "Probe", failure: (message) => new Error(message) });
    await released.release();

    // A vanished run directory drops its ledger entry entirely.
    const deps5 = retirerDeps(fx, live);
    const retirer5 = createLaneRetirer(deps5.deps);
    await retirer5.sweep();
    expect(retirer5.view(runId)).toMatchObject({ state: "watching" });
    await rm(join(fx.handoffNs.dir, runId), { recursive: true, force: true });
    await retirer5.sweep();
    expect(retirer5.view(runId)).toBeUndefined();
  });
});

/**
 * The ADR-040 amendment (plan rev4): the supervisor-independent follow-up
 * proof — persisted artifact-time anchor, native-history fingerprint, bounded
 * reverse tail scan — and the Devin composer guard, in the sweep and under the
 * close lock, through the real scan over real trace files unless a row names
 * the scripted seam (the two budget rows need > 8 MiB sources).
 */
describe("lane retirer follow-up proof (ADR-040 amendment)", () => {
  interface Seeded { allocation: HandoffAllocation; runId: string; tracePath: string }
  interface Ctx { fx: Fx; seeded: Seeded; live: Live; scripted: { scan?: TailScan } }
  interface Row {
    name: string;
    kind?: Kind;
    /** The sweep reason; the lock reason is `recheck_` + this. */
    reason: string;
    state?: "refused" | "deferred";
    /** Rows a lock recheck cannot stage (the sweep already refused them). */
    sweepOnly?: boolean;
    seed?: Parameters<typeof seedRun>[1];
    mutate: (ctx: Ctx) => Promise<unknown>;
  }
  const noop = async (): Promise<void> => undefined;
  const sidecar = (ctx: Ctx, mutate: (state: Parameters<Parameters<typeof updateHandoffState>[1]>[0]) => void) => updateHandoffState(ctx.seeded.allocation, mutate);
  const ROWS: Row[] = [
    { name: "kind without reader (agy)", kind: "agy", reason: "trace_unsupported_kind", sweepOnly: true, mutate: noop },
    { name: "legacy lane: no anchor", reason: "trace_anchor_missing", mutate: (ctx) => sidecar(ctx, (state) => { delete state.artifact.mtimeMs; }) },
    { name: "anchor without a fingerprint (capture failed)", reason: "trace_history_missing", mutate: (ctx) => sidecar(ctx, (state) => { delete state.artifact.traceHistory; }) },
    { name: "fingerprint for another session", reason: "trace_history_stale", mutate: (ctx) => sidecar(ctx, (state) => { state.artifact.traceHistory!.session = { ...childSession, value: "/pi/other.jsonl" }; }) },
    {
      name: "trace shorter than the fingerprint (same-session rollback)",
      reason: "trace_source_rewritten",
      mutate: async (ctx) => {
        const position = (await readHandoffStateOf(ctx)).artifact.traceHistory!.position as { offset: number };
        await truncate(ctx.seeded.tracePath, position.offset - 1);
      },
    },
    { name: "artifact missing at check time", reason: "trace_artifact_missing", mutate: (ctx) => rm(ctx.seeded.allocation.artifactPath) },
    { name: "artifact untrusted at check time", reason: "trace_artifact_untrusted", mutate: (ctx) => chmod(ctx.seeded.allocation.artifactPath, 0o666) },
    { name: "artifact invalid at check time", reason: "trace_artifact_invalid", mutate: (ctx) => writeFile(ctx.seeded.allocation.artifactPath, "garbage\n", { mode: 0o600 }) },
    { name: "artifact bytes differ from the accepted sha256", reason: "trace_artifact_changed", mutate: (ctx) => writeFile(ctx.seeded.allocation.artifactPath, artifactBody(ctx.seeded.runId).replace("Completed", "Finished"), { mode: 0o600 }) },
    { name: "trace unreadable", reason: "trace_source_unreadable", mutate: (ctx) => rm(ctx.seeded.tracePath) },
    {
      name: "session pointer invalid (relative Pi path)",
      reason: "trace_session_pointer_invalid",
      sweepOnly: true,
      seed: { session: { ...childSession, value: "relative.jsonl" }, history: { kind: "pi-jsonl", session: { ...childSession, value: "relative.jsonl" }, position: { path: "/relative.jsonl", offset: 0, anchor: createHash("sha256").digest("hex") } } },
      mutate: noop,
    },
    { name: "malformed trace line", reason: "trace_source_malformed", mutate: (ctx) => appendFile(ctx.seeded.tracePath, "{not json\n") },
    { name: "Devin document over budget", kind: "devin", reason: "trace_source_exceeds_budget", mutate: async (ctx) => { ctx.scripted.scan = { kind: "failure", failure: "source_exceeds_budget", reason: "document" }; } },
    { name: "unterminated bytes at EOF", reason: "trace_pending_tail", mutate: (ctx) => appendTrace(ctx.fx, "pi", childSession, [], '{"type":"message","message":{"role":"user"') },
    { name: "tail never reached the slack boundary", reason: "trace_ambiguous:scan_budget", mutate: async (ctx) => { ctx.scripted.scan = { kind: "ambiguous", reason: "scan_budget" }; } },
    { name: "user turn at or after the anchor", reason: "trace_follow_up", mutate: (ctx) => appendTrace(ctx.fx, "pi", childSession, [piEntry("user", 0)]) },
    { name: "user turn without a parseable time", reason: "trace_ambiguous:timestamp_missing", mutate: (ctx) => appendTrace(ctx.fx, "pi", childSession, [{ type: "message", id: "u", message: { role: "user", content: "redacted" } }]) },
    { name: "Pi compaction at or after the anchor", reason: "trace_ambiguous:compaction", mutate: (ctx) => appendTrace(ctx.fx, "pi", childSession, [{ type: "compaction", id: "c", timestamp: at(10), summary: "redacted", firstKeptEntryId: "m", tokensBefore: 1 }]) },
    { name: "Devin composer: queued input", kind: "devin", reason: "composer_queued", mutate: async (ctx) => { ctx.live.ansi = REAL_QUEUED; } },
    { name: "Devin composer: a draft", kind: "devin", reason: "composer_draft", mutate: async (ctx) => { ctx.live.ansi = COMPOSER_DRAFT; } },
    { name: "Devin composer: unreadable frame", kind: "devin", reason: "composer_unreadable", state: "deferred", mutate: async (ctx) => { ctx.live.ansi = "no composer here\n"; } },
  ];
  const readHandoffStateOf = async (ctx: Ctx) => (await import("../../src/handoff.js")).readHandoffState(ctx.seeded.allocation);

  async function stage(row: Row): Promise<{ ctx: Ctx; scan: TailScanner }> {
    const fx = await fixture();
    const kind = row.kind ?? "pi";
    const seeded = await seedRun(fx, { agentKind: kind, ...row.seed });
    const live = liveFor(kind);
    if (row.seed?.session !== undefined) {
      const over = { agent_session: { ...row.seed.session }, tokens: childTokens(row.seed.session) };
      live.pane = childPane(over);
      live.agent = childAgent(over);
    }
    const ctx: Ctx = { fx, seeded, live, scripted: {} };
    const scan: TailScanner = async (target, anchorMs, history, deps) => ctx.scripted.scan ?? tailScan(target, anchorMs, history, deps);
    return { ctx, scan };
  }

  it.each(ROWS)("sweep: $name → $reason", async (row) => {
    const { ctx, scan } = await stage(row);
    await row.mutate(ctx);
    const { deps, clock } = retirerDeps(ctx.fx, ctx.live, { trace: { scan, trace: traceDepsFor(ctx.fx) } });
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(ctx.seeded.runId)).toMatchObject({ state: row.state ?? "refused", reason: row.reason });
    expect(ctx.live.pane).not.toBeUndefined();
    expect(closes(deps)).toEqual([]);
    // The refusal is re-evaluated every sweep but journaled once, with vocabulary only.
    await retirer.sweep();
    const lines = ctx.fx.lines.filter((line) => line.includes(`run=${ctx.seeded.runId}`) && line.includes(`reason=${row.reason}`));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("redacted");
  });

  it.each(ROWS.filter((row) => row.sweepOnly !== true))("lock: $name → recheck_$reason, no close dispatched", async (row) => {
    const { ctx, scan } = await stage(row);
    const lock = fakePaneLock({ onAcquire: async () => { await row.mutate(ctx); } });
    const { deps, clock } = retirerDeps(ctx.fx, ctx.live, { trace: { scan, trace: traceDepsFor(ctx.fx) }, options: { paneLock: lock.guard } });
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(lock.acquired).toEqual(["p-child"]);
    expect(retirer.view(ctx.seeded.runId)).toMatchObject({ state: row.state ?? "refused", reason: `recheck_${row.reason}` });
    expect(ctx.live.pane).not.toBeUndefined();
    expect(closes(deps)).toEqual([]);
  });

  it.each(["pi", "claude", "devin"] as const)("retires a clean idle %s lane that passes the artifact, history, tail and composer checks", async (kind) => {
    const fx = await fixture();
    const { runId } = await seedRun(fx, { agentKind: kind });
    const live = liveFor(kind);
    const counting = countingScan();
    const { deps, clock } = retirerDeps(fx, live, { trace: { scan: counting.scan, trace: traceDepsFor(fx) } });
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "retired" });
    expect(live.pane).toBeUndefined();
    // Two sweeps plus the lock: every check scanned against the PERSISTED anchor.
    expect(counting.calls).toEqual([ANCHOR_MS, ANCHOR_MS, ANCHOR_MS]);
    const composerReads = (deps.cli as FakeCli).calls.filter((argv) => argv.includes("ansi"));
    if (kind === "devin") {
      // The guard issues exactly the production flush's ansi visible read, in the sweep and under the lock.
      expect(composerReads).toEqual([devinComposerReadArgv("p-child"), devinComposerReadArgv("p-child"), devinComposerReadArgv("p-child")]);
    } else {
      expect(composerReads).toEqual([]);
    }
  });

  it("performs no trace read for an absent child", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx);
    const counting = countingScan();
    const live: Live = {};
    const { deps } = retirerDeps(fx, live, { trace: { scan: counting.scan, trace: traceDepsFor(fx) } });
    const retirer = createLaneRetirer(deps);
    await retirer.sweep();
    expect(retirer.view(runId)).toBeUndefined();
    expect(counting.calls).toEqual([]);
  });

  it("refuses a follow-up written between the artifact write and the acceptance, and a re-acceptance of a newer artifact clears it", async () => {
    const fx = await fixture();
    // The follow-up's timestamp is after the artifact's write time even though
    // the acceptance (and the fingerprint capture) came later still.
    const { allocation, runId } = await seedRun(fx, { trace: [...PI_QUIET, piEntry("user", 500)] });
    const live: Live = { pane: childPane(), agent: childAgent() };
    const { deps, clock } = retirerDeps(fx, live);
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "refused", reason: "trace_follow_up" });

    // Re-acceptance: a changed artifact written after the follow-up, validated anew.
    const content = artifactBody(runId).replace("Completed", "Answered the follow-up and completed");
    await writeFile(allocation.artifactPath, content, { mode: 0o600 });
    await utimes(allocation.artifactPath, new Date(ANCHOR_MS + 5_000), new Date(ANCHOR_MS + 5_000));
    const history = await captureTraceHistory({ agentKind: "pi", agentSession: childSession }, { resolvedCwd: WORKSPACE_CWD }, new AbortController().signal, traceDepsFor(fx));
    const mtimeMs = Math.floor((await stat(allocation.artifactPath)).mtimeMs);
    await updateHandoffState(allocation, (state) => {
      state.artifact.sha256 = createHash("sha256").update(content, "utf8").digest("hex");
      state.artifact.bytes = Buffer.byteLength(content);
      state.artifact.version = 2;
      state.artifact.mtimeMs = mtimeMs;
      state.artifact.traceHistory = history;
    });
    expect(mtimeMs).toBeGreaterThan(ANCHOR_MS + 500);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "retired" });
  });

  it("F13: a byte-identical artifact rewrite after a downtime follow-up never moves the anchor — refused in the sweep and under the lock", async () => {
    // Accept at T1 (anchor), restart (a fresh retirer over the sidecar),
    // follow-up at T2, identical bytes rewritten at T3 with a newer file mtime.
    const fx = await fixture();
    const { allocation, runId } = await seedRun(fx);
    await appendTrace(fx, "pi", childSession, [piEntry("user", 60_000), piEntry("assistant", 70_000)]);
    await writeFile(allocation.artifactPath, artifactBody(runId), { mode: 0o600 });
    await utimes(allocation.artifactPath, new Date(ANCHOR_MS + 120_000), new Date(ANCHOR_MS + 120_000));
    const live: Live = { pane: childPane(), agent: childAgent() };
    const counting = countingScan();
    const { deps, clock } = retirerDeps(fx, live, { trace: { scan: counting.scan, trace: traceDepsFor(fx) } });
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "refused", reason: "trace_follow_up" });
    expect(counting.calls).toEqual([ANCHOR_MS, ANCHOR_MS]);
    expect((await (await import("../../src/handoff.js")).readHandoffState(allocation)).artifact.mtimeMs).toBe(ANCHOR_MS);

    // The same sequence inside the lock window.
    const fx2 = await fixture();
    const late = await seedRun(fx2);
    const lock = fakePaneLock({
      onAcquire: async () => {
        await appendTrace(fx2, "pi", childSession, [piEntry("user", 60_000)]);
        await writeFile(late.allocation.artifactPath, artifactBody(late.runId), { mode: 0o600 });
        await utimes(late.allocation.artifactPath, new Date(ANCHOR_MS + 120_000), new Date(ANCHOR_MS + 120_000));
      },
    });
    const live2: Live = { pane: childPane(), agent: childAgent() };
    const counting2 = countingScan();
    const deps2 = retirerDeps(fx2, live2, { trace: { scan: counting2.scan, trace: traceDepsFor(fx2) }, options: { paneLock: lock.guard } });
    const retirer2 = createLaneRetirer(deps2.deps);
    await sweepPastGrace(retirer2, deps2.clock);
    expect(retirer2.view(late.runId)).toMatchObject({ state: "refused", reason: "recheck_trace_follow_up" });
    expect(counting2.calls.every((anchor) => anchor === ANCHOR_MS)).toBe(true);
    expect(closes(deps2.deps)).toEqual([]);
    expect(live2.pane).not.toBeUndefined();
  });

  it("F15: a same-session /revert of the Devin trace to a pre-artifact prefix refuses as rewritten, in the sweep and under the lock", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx, { agentKind: "devin" });
    // Downtime follow-up, then `/revert` to a step before the artifact write:
    // the follow-up is gone and only pre-anchor steps remain.
    await writeTrace(fx, "devin", devinSession, devinDoc([...DEVIN_QUIET, { source: "user", deltaMs: 60_000 }]));
    await writeTrace(fx, "devin", devinSession, devinDoc(DEVIN_QUIET.slice(0, 2)));
    const live = liveFor("devin");
    const { deps, clock } = retirerDeps(fx, live);
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "refused", reason: "trace_source_rewritten" });

    const fx2 = await fixture();
    const late = await seedRun(fx2, { agentKind: "devin" });
    const lock = fakePaneLock({ onAcquire: () => writeTrace(fx2, "devin", devinSession, devinDoc(DEVIN_QUIET.slice(0, 2))).then(() => undefined) });
    const live2 = liveFor("devin");
    const deps2 = retirerDeps(fx2, live2, { options: { paneLock: lock.guard } });
    const retirer2 = createLaneRetirer(deps2.deps);
    await sweepPastGrace(retirer2, deps2.clock);
    expect(retirer2.view(late.runId)).toMatchObject({ state: "refused", reason: "recheck_trace_source_rewritten" });
    expect(closes(deps2.deps)).toEqual([]);
  });

  it("a partial user record under the lock refuses before closeWithReadback and spends no attempt", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx);
    let staged = false;
    const lock = fakePaneLock({
      onAcquire: async () => {
        if (staged) return;
        staged = true;
        await appendTrace(fx, "pi", childSession, [], '{"type":"message","id":"u","timestamp":"');
      },
    });
    const live: Live = { pane: childPane(), agent: childAgent() };
    const { deps, clock } = retirerDeps(fx, live, { options: { paneLock: lock.guard, maxAttempts: 1 } });
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "refused", reason: "recheck_trace_pending_tail" });
    expect(closes(deps)).toEqual([]);
    // The writer finishes the record as a pre-anchor assistant turn: with a
    // single allowed attempt, the lane can only retire if none was spent.
    await appendFile(tracePath(fx, "pi", childSession), `${at(-1_000)}","message":{"role":"assistant","content":"redacted"}}\n`);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "retired" });
  });

  it("F1: a follow-up landing after the under-lock lifecycle and screen reads is caught by the final veto, and the clock restarts", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx);
    const live: Live = { pane: childPane(), agent: childAgent() };
    const lock = fakePaneLock();
    let injected = false;
    const cli = fakeCli(live, {
      onRead: async () => {
        // The lock's own screen read has just been served: the pane is proven
        // idle and unchanged, and only the final veto stands between here and
        // the close dispatch.
        if (lock.acquired.length === 0 || injected) return;
        injected = true;
        await appendTrace(fx, "pi", childSession, [piEntry("user", 1_000)]);
      },
    });
    const counting = countingScan();
    const { deps, clock } = retirerDeps(fx, live, { cli, trace: { scan: counting.scan, trace: traceDepsFor(fx) }, options: { paneLock: lock.guard } });
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(injected).toBe(true);
    expect(retirer.view(runId)).toMatchObject({ state: "refused", reason: "recheck_trace_follow_up" });
    expect(closes(deps)).toEqual([]);
    expect(live.pane).not.toBeUndefined();
    // The veto was the last read: it ran after the lock's pane/agent gets and screen read.
    const calls = (deps.cli as FakeCli).calls;
    expect(calls.filter((argv) => argv[1] === "get")).toHaveLength(2);
    expect(counting.calls).toHaveLength(3);
    // F2: the lock-window refusal left the lane unobserved — the clock restarted.
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "refused", reason: "trace_follow_up" });
  });

  it("F1: a daemon-mediated prompt cannot take the pane-write section while the close holds it", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx);
    const live: Live = { pane: childPane(), agent: childAgent() };
    const lockDir = join(fx.traceRoot, "..", "pane-locks");
    await mkdir(lockDir, { recursive: true, mode: 0o700 });
    const guard = createPaneWriteGuard({ namespace: { dir: lockDir, endpoint: join(fx.traceRoot, "..", "herdr.sock") } });
    let section: unknown = "not attempted";
    const cli = fakeCli(live, {
      onClose: async () => {
        // Every daemon prompt path (communicate, wakes, launch, hints, the
        // repair prompt) takes this section first; mid-dispatch it is held.
        const flush = createDevinQueueFlush({ cli: deps.cli, guard, sectionWaitMs: 200 });
        try {
          const lease = await flush.writeSection("p-child");
          await lease.release();
          section = "acquired";
        } catch (error) {
          section = error;
        }
      },
    });
    const { deps, clock } = retirerDeps(fx, live, { cli, options: { paneLock: guard } });
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "retired" });
    expect(section).toBeInstanceOf(PaneWriteLockError);
    expect((section as PaneWriteLockError).code).toBe("PANE_WRITE_LOCK_UNAVAILABLE");
    // Released with the close: the section is free again.
    const after = await createDevinQueueFlush({ cli: deps.cli, guard, sectionWaitMs: 200 }).writeSection("p-child");
    await after.release();
  }, 20_000);

  it("F2: a veto that skips the observation restarts the grace — recovery needs a fresh full grace", async () => {
    // A Devin lane whose composer frame becomes unreadable mid-grace.
    const fx = await fixture();
    const { runId } = await seedRun(fx, { agentKind: "devin" });
    const live = liveFor("devin");
    const { deps, clock } = retirerDeps(fx, live);
    const retirer = createLaneRetirer(deps);
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "watching", stableForMs: 0 });
    live.ansi = "no composer here\n";
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "deferred", reason: "composer_unreadable" });
    delete live.ansi;
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "watching", stableForMs: 0 });
    expect(live.pane).not.toBeUndefined();
    clock.nowMs += GRACE_MS;
    await retirer.sweep();
    expect(retirer.view(runId)).toMatchObject({ state: "retired" });

    // The same for a transient trace refusal on a Pi lane.
    const fx2 = await fixture();
    const second = await seedRun(fx2);
    const live2: Live = { pane: childPane(), agent: childAgent() };
    const deps2 = retirerDeps(fx2, live2);
    const retirer2 = createLaneRetirer(deps2.deps);
    await retirer2.sweep();
    await appendTrace(fx2, "pi", childSession, [], '{"type":"message","id":"u","timestamp":"');
    deps2.clock.nowMs += GRACE_MS;
    await retirer2.sweep();
    expect(retirer2.view(second.runId)).toMatchObject({ state: "refused", reason: "trace_pending_tail" });
    await appendFile(tracePath(fx2, "pi", childSession), `${at(-1_000)}","message":{"role":"assistant","content":"redacted"}}\n`);
    await retirer2.sweep();
    expect(retirer2.view(second.runId)).toMatchObject({ state: "watching", stableForMs: 0 });
    expect(live2.pane).not.toBeUndefined();
    deps2.clock.nowMs += GRACE_MS;
    await retirer2.sweep();
    expect(retirer2.view(second.runId)).toMatchObject({ state: "retired" });
  });

  it("F4: a token-kept lane performs no trace read or composer read", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx, { agentKind: "devin" });
    const live = liveFor("devin");
    live.pane = childPane({ ...live.pane, tokens: childTokens(devinSession, { retention: "keep" }) });
    const counting = countingScan();
    const { deps, clock } = retirerDeps(fx, live, { trace: { scan: counting.scan, trace: traceDepsFor(fx) } });
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "kept", reason: "token_retention_keep" });
    expect(counting.calls).toEqual([]);
    expect((deps.cli as FakeCli).calls.filter((argv) => argv.includes("ansi"))).toEqual([]);
    // Clearing the token starts a fresh grace and the proof runs from then on.
    live.pane = childPane({ ...live.pane, tokens: childTokens(devinSession) });
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "retired" });
    expect(counting.calls.length).toBeGreaterThan(0);
  });

  it("a Devin composer read that throws defers as unreadable", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx, { agentKind: "devin" });
    const live = liveFor("devin");
    const { deps, clock } = retirerDeps(fx, live, { cli: fakeCli(live, { readError: Object.assign(new Error("gone"), { code: "CLI_UNAVAILABLE" }) }) });
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "deferred", reason: "composer_unreadable" });
    expect(closes(deps)).toEqual([]);
  });

  it("a Claude lane whose workspace is unbound cannot resolve its trace and never retires", async () => {
    const fx = await fixture();
    const { runId } = await seedRun(fx, { agentKind: "claude", workspace: false, history: { kind: "claude-jsonl", session: claudeSession, position: { path: "/x.jsonl", offset: 0, anchor: createHash("sha256").digest("hex") } } });
    const live = liveFor("claude");
    const { deps, clock } = retirerDeps(fx, live);
    const retirer = createLaneRetirer(deps);
    await sweepPastGrace(retirer, clock);
    expect(retirer.view(runId)).toMatchObject({ state: "refused", reason: "trace_session_pointer_invalid" });
  });
});
