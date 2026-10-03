/**
 * The one runtime assembly every Herdr tools host shares (durable-supervisor
 * §5): the CLI transport, JobRegistry, the Devin queue-flush coordinator, the
 * managed-handoff gate, the ownership ledger, and the SupervisionRegistry
 * wired to the host's wake path and session-event
 * monitor. `createSharedRuntime` is the single construction path the Pi
 * extension, the MCP server, and the daemon all call; `createDaemonRuntime`
 * wraps it with the durable intent store, and the caller-verification helpers
 * here are the D2a identity gate every daemon request passes through.
 */

import { createAgentPromptClient, type AgentPromptClient } from "../agent-prompt.js";
import { HerdrCli, type JsonEnvelope, type PiExec } from "../cli.js";
import {
  ContextResolutionError,
  resolveManagerSession,
  type ContextResolver,
  type EffectiveContext,
  type ResolvedContext,
} from "../context.js";
import { createHandoffAllocator, type HandoffAllocator } from "../handoff.js";
import { createHandoffGate, type HandoffGate } from "../handoff-gate.js";
import { JobRegistry } from "../job-registry.js";
import { createDevinQueueFlush, type DevinQueueFlush } from "../messages/devin-queue-flush.js";
import type { AgentSessionIdentity } from "../messages/prompt.js";
import { RuntimeOwnership } from "../ownership.js";
import { createPaneWriteGuard, resolvePaneWriteNamespace } from "../pane-write-lock.js";
import { loadSettings, type Settings } from "../settings.js";
import { createCliTranscriptReader, SupervisionRegistry } from "../supervision/registry.js";
import { createSelfCloseTracker, type SelfCloseTracker } from "../supervision/self-close.js";
import type { ManagerNotifier } from "../supervision/notify.js";
import { parseSnapshotResult, type HerdrSnapshot } from "../targets.js";
import type { LaunchDependencies } from "../tools/launch.js";
import { handleDaemonLaunch } from "./handlers/launch.js";
import { handleDaemonRun } from "./handlers/run.js";
import { handleDaemonStatus } from "./handlers/status.js";
import { createIdleHints, type IdleHintSink } from "./hints.js";
import { createIntentStore, managerSessionKey, type IntentStore } from "./intents.js";
import { createOwnership } from "./ownership.js";
import type { Mailbox, MailboxEventWriter } from "./mailbox.js";
import type { DaemonNamespace } from "./namespace.js";
import type { LaneRetirer } from "./retire.js";
import { captureTraceHistory } from "../supervision/trace-tail.js";
import { DAEMON_REASON_TOKEN, DaemonRequestError } from "./protocol.js";
import type { DaemonRequestHandler } from "./server.js";

/** The narrow CLI surface daemon request plumbing needs — `HerdrCli` satisfies it. */
export interface DaemonCli {
  runJson(argv: string[], signal: AbortSignal): Promise<JsonEnvelope>;
}

/** What a host may layer onto the shared assembly between the CLI and supervision. */
export interface SharedRuntimeWiring {
  /** A job registry carrying the host's own terminal/change callbacks. */
  jobs?: JobRegistry;
  /** The host's wake path for supervisor events; absent means inert. */
  notifier?: ManagerNotifier;
  /** The host's own-close ledger, forwarded to every reserved supervisor. */
  selfClose?: SelfCloseTracker;
  /** The host's §11 idle-hint sink, forwarded to every reserved supervisor; absent means inert. */
  hints?: IdleHintSink;
}

export interface SharedRuntimeDeps {
  /** The host's CLI exec seam (`pi.exec` on Pi, `createNodeExec` elsewhere). */
  exec: PiExec;
  /**
   * The host env for the prompt client, the pane-write lock namespace, and
   * the monitor options. When unset the prompt client and lock still fall
   * back to `process.env` while the monitor is wired with no env — the exact
   * split the MCP host performs today.
   */
  env?: NodeJS.ProcessEnv;
  promptClient?: AgentPromptClient;
  settingsLoader?: () => Promise<Settings>;
  /**
   * Host seam invoked after the CLI and queue flush exist and before the job
   * registry and supervision registry are built — where a host's wake path
   * and job-registry callbacks wire in.
   */
  wire?: (parts: { cli: HerdrCli; queueFlush: DevinQueueFlush }) => SharedRuntimeWiring;
  /**
   * Bounded structured diagnostic sink forwarded to the mailbox, intents,
   * hints, and every reserved supervisor. Lines are `key=value` records —
   * never free-form wire content.
   */
  log?: (line: string) => void;
  /**
   * Marks this assembly daemon-hosted: the supervising process's own cwd and
   * env were never verified as a project anchor, so reserved supervisors
   * never fall back to `process.cwd()` for the review log — a reservation
   * without an explicit `reviewLogRoot` fails its appends closed.
   * `createDaemonRuntime` sets it; in-process hosts leave it unset and keep
   * the `HERDR_PROJECT_DIR`/launch-directory anchor.
   */
  daemonHosted?: boolean;
}

export interface SharedRuntime {
  cli: HerdrCli;
  queueFlush: DevinQueueFlush;
  jobs: JobRegistry;
  ownership: RuntimeOwnership;
  /** The shared managed-handoff gate launch bindings and strict waits consult. */
  handoffs: HandoffGate;
  supervision: SupervisionRegistry;
}

/**
 * Build the shared host assembly once. Construction order is fixed: CLI →
 * queue flush (armed) → host wiring → jobs → gate → supervision — so every
 * host's lifecycle ordering stays exactly what it was before the extraction.
 */
export function createSharedRuntime(deps: SharedRuntimeDeps): SharedRuntime {
  const env = deps.env ?? process.env;
  const cli = new HerdrCli(deps.exec, 10_000, 50_000, deps.promptClient ?? createAgentPromptClient({ env }));
  const ownership = new RuntimeOwnership();
  // The coordinator's namespace resolves lazily on first use, so constructing
  // the runtime still performs no filesystem or Herdr calls.
  const queueFlush = createDevinQueueFlush({ cli, guard: createPaneWriteGuard({ namespace: resolvePaneWriteNamespace.bind(null, env) }) });
  queueFlush.begin();
  const wiring = deps.wire?.({ cli, queueFlush }) ?? {};
  const jobs = wiring.jobs ?? new JobRegistry();
  const handoffs = createHandoffGate({
    // ADR-040 amendment: the native-history fingerprint persisted beside the
    // acceptance anchor; the lane retirer proves the trace still extends it.
    traceHistory: (identity, workspace, signal) => captureTraceHistory(identity, workspace, signal),
    ...(deps.log === undefined ? {} : { log: deps.log }),
  });
  const supervision = new SupervisionRegistry({
    jobs,
    settingsLoader: deps.settingsLoader ?? (() => loadSettings()),
    readTranscript: createCliTranscriptReader(cli),
    ...(wiring.notifier === undefined ? {} : { notifier: wiring.notifier }),
    monitorOptions: deps.env === undefined ? {} : { env: deps.env },
    ...(wiring.selfClose === undefined ? {} : { selfClose: wiring.selfClose }),
    ...(wiring.hints === undefined ? {} : { hints: wiring.hints }),
    ...(deps.log === undefined ? {} : { log: deps.log }),
    ...(deps.daemonHosted === true ? { daemonHosted: true } : {}),
    handoffs,
    // The repair prompt rides the shared pane-write section so a lane-
    // retirement close holding the lease can never dispatch between its final
    // trace read and this prompt's acknowledgement (ADR-040 amendment, R2).
    repairPrompt: async (paneId, text, signal) => {
      const lease = await queueFlush.writeSection(paneId);
      try {
        return await cli.prompt(paneId, text, signal);
      } finally {
        await lease.release();
      }
    },
  });
  return { cli, queueFlush, jobs, ownership, handoffs, supervision };
}

export interface DaemonRuntimeDeps extends SharedRuntimeDeps {
  /** The bound endpoint namespace the intent store lives under. */
  namespace: DaemonNamespace;
  intents?: IntentStore;
  /** The daemon-owned run allocator; injected in tests for disposable paths. */
  allocator?: HandoffAllocator;
  /**
   * Optional launch-pipeline seams layered under the daemon-owned trust
   * boundary — tests drive the real pipeline with a stub supervision,
   * catalog, spec client, router log, and launch gate through this. The
   * verified context, cwd, intent allocator, and before-first-effect hook are
   * never overridable.
   */
  launchDeps?: Partial<LaunchDependencies>;
  /**
   * The §7 mailbox — the daemon assembly binds it once `startDaemon` has
   * created the serialized `daemon.json` queue (`bindMailbox`); tests inject
   * it here directly.
   */
  mailbox?: Mailbox;
  /**
   * §11 qualified hint kinds — unset means EMPTY. The stock daemon passes
   * the C9-proved {pi, claude, devin} set (N5.2); the disposable test
   * daemon takes its set from the environment.
   */
  hintKinds?: readonly string[];
  /** Full-sink injection for tests; absent builds the §11 sink over `cli`. */
  hints?: IdleHintSink;
}

/** The §8 ownership surface the daemon runtime assembles. */
export type DaemonOwnership = ReturnType<typeof createOwnership>;

export interface DaemonRuntime extends SharedRuntime {
  namespace: DaemonNamespace;
  intents: IntentStore;
  allocator: HandoffAllocator;
  launchDeps?: Partial<LaunchDependencies>;
  /**
   * The daemon's §7 mailbox, once bound — `undefined` before `bindMailbox`
   * runs and on assemblies that never start the daemon.
   */
  readonly mailbox: Mailbox | undefined;
  /**
   * Bind the daemon's mailbox post-construction. `startDaemon` creates it
   * only after the serialized status queue exists, and every mailbox-backed
   * op below resolves the bound instance at call time.
   */
  bindMailbox(mailbox: Mailbox): void;
  /**
   * The host's own-close ledger — shared between every reserved supervisor
   * and the ADR-040 lane retirer, so a daemon-owned close correlates with the
   * supervisor's `pane_closed` wake exactly like a manager-requested one.
   */
  readonly selfClose: SelfCloseTracker;
  /**
   * The bound lane retirer, once `bindRetirer` runs — `undefined` before.
   * `handleDaemonStatus` reads its projection; `JobRegistry` consults its
   * `retiredByDaemon` marker before suppressing a `handed_off` terminal.
   */
  readonly retirer: LaneRetirer | undefined;
  /** Bind the daemon's lane retirer; its marker feeds the JobRegistry seam. */
  bindRetirer(retirer: LaneRetirer): void;
  /** The daemon's bounded structured diagnostic sink, when the host supplied one. */
  readonly log?: (line: string) => void;
  /** The §8 ownership journal surface: pending transfers, transfer/claim, retarget. */
  daemonOwnership: DaemonOwnership;
  /** The §11 idle-hint sink the runtime forwarded to its supervision registry. */
  hints: IdleHintSink;
  /** The N2.2 run-event writer — the bound mailbox, resolved lazily per call. */
  readonly eventWriter: MailboxEventWriter;
  /**
   * In-flight launch executions keyed `<managerSessionKey>/<idempotencyKey>`:
   * a second caller that `begin`s a still-`recorded` intent waits for the live
   * attempt instead of launching a duplicate — the durable binding only
   * serializes records, not concurrent executors.
   */
  inflight: Map<string, Promise<unknown>>;
}

export function createDaemonRuntime(deps: DaemonRuntimeDeps): DaemonRuntime {
  const bound: { mailbox?: Mailbox; retirer?: LaneRetirer } = { mailbox: deps.mailbox };
  // The daemon's mailbox exists only once `startDaemon` has created its
  // serialized `daemon.json` queue; every op resolves the bound instance at
  // call time so a pre-bind call refuses rather than opening a second,
  // unsynchronized status port.
  const mailbox = (): Mailbox => {
    /* c8 ignore next -- startDaemon binds the mailbox during startup, before the socket accepts a request; this throw is only reachable if a consumer is mis-wired to call before bind. */
    if (bound.mailbox === undefined) throw new DaemonRequestError("DAEMON_UNAVAILABLE", "daemon mailbox is not bound");
    return bound.mailbox;
  };
  // Only the members the deferred consumers actually call are forwarded:
  // ownership serializes through `withMailboxes`, hints read through `list`.
  const deferredMailbox: Pick<Mailbox, "list" | "withMailboxes"> = {
    list: (key) => mailbox().list(key),
    withMailboxes: (keys, section) => mailbox().withMailboxes(keys, section),
  };
  // The N2.2 writer launch reservations and job terminals persist through —
  // the same bound mailbox the reattach path injects, resolved at call time.
  const deferredEventWriter: MailboxEventWriter = {
    writeRunEvent: (input) => mailbox().writeRunEvent(input),
  };
  // The wire seam runs synchronously inside `createSharedRuntime` and always
  // reassigns `hints` before `sink` below can be invoked; the initializer only
  // satisfies definite assignment.
  /* c8 ignore next */
  let hints: IdleHintSink = () => undefined;
  // The daemon always carries an own-close ledger: supervisors consult it for
  // `pane_closed` wakes and the lane retirer marks its proven closes through
  // the same instance, so a host that wires none still correlates correctly.
  let selfClose: SelfCloseTracker = createSelfCloseTracker();
  const shared = createSharedRuntime({
    ...deps,
    // The daemon's own cwd is never a project root: daemon-hosted supervision
    // requires an explicit reviewLogRoot on every reservation — launches pass
    // the D2a-verified project root, reattach the recorded one.
    daemonHosted: true,
    wire: (parts) => {
      const host = deps.wire?.(parts) ?? {};
      // §11: the qualified-kind set is empty unless the daemon start option
      // supplies it — production passes the C9-proved three (N5.2).
      hints = deps.hints ?? createIdleHints({
        cli: parts.cli,
        writeSection: (paneId) => parts.queueFlush.writeSection(paneId),
        mailbox: deferredMailbox,
        namespace: deps.namespace,
        qualifiedKinds: deps.hintKinds,
        ...(deps.log === undefined ? {} : { log: deps.log }),
      });
      if (host.selfClose !== undefined) selfClose = host.selfClose;
      return {
        ...host,
        selfClose,
        jobs: host.jobs ?? new JobRegistry({
          eventWriter: deferredEventWriter,
          // ADR-040: only a run the bound retirer provably closed skips the
          // trailing `job_terminal`; an unbound retirer marks nothing.
          laneRetired: (runId) => bound.retirer?.retiredByDaemon(runId) === true,
        }),
        hints,
      };
    },
  });
  const intents = deps.intents ?? createIntentStore({ namespace: deps.namespace, ...(deps.log === undefined ? {} : { log: deps.log }) });
  const allocator = deps.allocator ?? createHandoffAllocator({ ...(deps.env === undefined ? {} : { env: deps.env }) });
  const ownership = createOwnership({
    namespace: deps.namespace,
    allocator,
    intents,
    mailbox: deferredMailbox,
    snapshot: async () => parseSnapshotResult((await shared.cli.runJson(["api", "snapshot"], new AbortController().signal)).result),
    // The N2.4 journal's in-memory step: re-target every bound supervisor's
    // hint destination to the verified successor.
    retarget: async (runIds, successor) => {
      shared.supervision.retargetHintDestinations(runIds, successor);
    },
  });
  const sink: IdleHintSink = (hint) => hints(hint);
  return {
    ...shared,
    namespace: deps.namespace,
    intents,
    allocator,
    get mailbox() {
      return bound.mailbox;
    },
    bindMailbox: (next) => {
      bound.mailbox = next;
    },
    selfClose,
    get retirer() {
      return bound.retirer;
    },
    bindRetirer: (next) => {
      bound.retirer = next;
    },
    ...(deps.log === undefined ? {} : { log: deps.log }),
    daemonOwnership: ownership,
    hints: sink,
    eventWriter: deferredEventWriter,
    ...(deps.launchDeps === undefined ? {} : { launchDeps: deps.launchDeps }),
    inflight: new Map(),
  };
}

/**
 * The bound §7 mailbox or the typed refusal. The socket starts serving before
 * `bindMailbox` runs inside the reattach callback, so a request that lands in
 * the pre-bind window fails closed rather than fabricating an empty mailbox.
 */
export function requireDaemonMailbox(runtime: DaemonRuntime): Mailbox {
  if (runtime.mailbox === undefined) throw new DaemonRequestError("DAEMON_UNAVAILABLE", "daemon mailbox is not bound");
  return runtime.mailbox;
}

const DAEMON_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A bounded typed code: the request refusal's own `daemonCode`, else a carried cause code. */
function codeOf(error: unknown): string | undefined {
  const code = error instanceof DaemonRequestError ? error.daemonCode : isRecord(error) ? error.code : undefined;
  return typeof code === "string" && DAEMON_CODE.test(code) ? code : undefined;
}

/** The failure's bounded sub-code token (`details.reason`), else undefined. */
function reasonOf(error: unknown): string | undefined {
  const reason = isRecord(error) && isRecord(error.details) ? error.details.reason : undefined;
  return typeof reason === "string" && DAEMON_REASON_TOKEN.test(reason) ? reason : undefined;
}

/** Map any failure into the wire's typed refusal shape: the code plus its bounded reason token. */
export function daemonRequestError(error: unknown, fallback = "DAEMON_REQUEST_FAILED"): DaemonRequestError {
  return error instanceof DaemonRequestError ? error : new DaemonRequestError(codeOf(error) ?? fallback, undefined, reasonOf(error));
}

/** The thin client's claimed identity (§6 D2a): never trusted until verified. */
export interface DaemonCallerClaim {
  workspaceId: string;
  tabId: string;
  paneId: string;
  agentSession: AgentSessionIdentity | null;
}

/** The verified caller: identity proved against one fresh authoritative snapshot. */
export interface VerifiedDaemonCaller {
  /** The verified claimed topology — `deps.context` for daemon-driven tools. */
  context: ResolvedContext;
  /** The occupant `agent_session` the snapshot proved — never caller-supplied. */
  session: AgentSessionIdentity;
  managerSessionKey: string;
  /** The one fresh snapshot this request verified against (D2a). */
  snapshot: HerdrSnapshot;
  /** The snapshot operation id, for evidence parity with host context resolution. */
  snapshotOperationId: string;
}

function safeIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0") && !value.includes("\r") && !value.includes("\n");
}

function safeSessionField(value: unknown): value is string {
  return safeIdentifier(value);
}

/**
 * Parse the claimed identity block. Shape only — nothing here is trusted; the
 * authoritative snapshot decides whether the claim is true.
 */
export function parseCallerClaim(value: unknown): DaemonCallerClaim {
  if (!isRecord(value)
    || !safeIdentifier(value.workspaceId)
    || !safeIdentifier(value.tabId)
    || !safeIdentifier(value.paneId)) {
    throw new DaemonRequestError("CALLER_IDENTITY_MALFORMED");
  }
  let agentSession: AgentSessionIdentity | null = null;
  if (value.agentSession !== null && value.agentSession !== undefined) {
    const candidate = value.agentSession;
    if (!isRecord(candidate)) throw new DaemonRequestError("CALLER_IDENTITY_MALFORMED");
    const { source, agent, kind, value: sessionValue } = candidate;
    if (!safeSessionField(source) || !safeSessionField(agent) || !safeSessionField(kind) || !safeSessionField(sessionValue)) {
      throw new DaemonRequestError("CALLER_IDENTITY_MALFORMED");
    }
    agentSession = { source, agent, kind, value: sessionValue };
  }
  return { workspaceId: value.workspaceId, tabId: value.tabId, paneId: value.paneId, agentSession };
}

function sameSession(left: AgentSessionIdentity, right: AgentSessionIdentity): boolean {
  return left.source === right.source
    && left.agent === right.agent
    && left.kind === right.kind
    && left.value === right.value;
}

/**
 * D2a: verify the claimed identity against exactly one fresh
 * `session.snapshot` — never process state, never a cached read. Exactly one
 * pane with the claimed `paneId` must exist, its occupant `agent_session` must
 * equal the claimed session, and the claimed tab/workspace must be the pane's
 * recorded parents. Mismatch, ambiguity, and unproven identity all refuse
 * before any effect.
 */
export async function verifyDaemonCaller(cli: DaemonCli, claim: DaemonCallerClaim, signal: AbortSignal): Promise<VerifiedDaemonCaller> {
  let snapshot: HerdrSnapshot;
  let snapshotOperationId: string;
  try {
    const envelope = await cli.runJson(["api", "snapshot"], signal);
    snapshot = parseSnapshotResult(envelope.result);
    snapshotOperationId = envelope.id;
  } catch (error) {
    throw daemonRequestError(error, "SNAPSHOT_UNAVAILABLE");
  }
  let session: AgentSessionIdentity | null;
  try {
    session = resolveManagerSession(snapshot, claim.paneId);
  } catch (error) {
    /* c8 ignore next -- resolveManagerSession refuses only via contextError; a foreign throw stays fail-closed. */
    if (!(error instanceof ContextResolutionError)) throw error;
    throw new DaemonRequestError("CALLER_IDENTITY_UNPROVEN");
  }
  if (session === null) throw new DaemonRequestError("MANAGER_SESSION_UNAVAILABLE");
  /* c8 ignore next -- resolveManagerSession already proved exactly one pane record. */
  const pane = snapshot.panes.find((candidate) => candidate.pane_id === claim.paneId)!;
  if (pane.tab_id !== claim.tabId
    || pane.workspace_id !== claim.workspaceId
    || claim.agentSession === null
    || !sameSession(session, claim.agentSession)) {
    throw new DaemonRequestError("CALLER_IDENTITY_MISMATCH");
  }
  return {
    context: { workspaceId: claim.workspaceId, tabId: claim.tabId, paneId: claim.paneId },
    session,
    managerSessionKey: managerSessionKey(session),
    snapshot,
    snapshotOperationId,
  };
}

/** The verified caller projected as an `EffectiveContext` for read-only consumers. */
export function daemonEffectiveContext(caller: VerifiedDaemonCaller): EffectiveContext {
  return {
    context: caller.context,
    snapshot: caller.snapshot,
    diagnostics: { injected: caller.context, effective: caller.context, rebound: false, attempts: 1 },
    operationIds: { current: "daemon-verified", snapshot: caller.snapshotOperationId },
  };
}

/**
 * The daemon's per-child context resolver: one fresh `api snapshot` per call —
 * the same read the in-process resolver performs — with the verified identity
 * re-asserted against it, so a caller pane that drifts mid-launch fails the
 * child closed exactly like a rebound host context does.
 */
export function daemonContextResolver(cli: DaemonCli, caller: VerifiedDaemonCaller): ContextResolver {
  return async (signal) => {
    const envelope = await cli.runJson(["api", "snapshot"], signal);
    const snapshot = parseSnapshotResult(envelope.result);
    const panes = snapshot.panes.filter((pane) => pane.pane_id === caller.context.paneId);
    if (panes.length !== 1
      || panes[0]!.tab_id !== caller.context.tabId
      || panes[0]!.workspace_id !== caller.context.workspaceId) {
      throw new ContextResolutionError("CONTEXT_UNAVAILABLE: caller topology changed after the request was verified", { reason: "topology_changed" }, true);
    }
    return {
      context: caller.context,
      snapshot,
      diagnostics: { injected: caller.context, effective: caller.context, rebound: false, attempts: 1 },
      operationIds: { current: "daemon-verified", snapshot: envelope.id },
    };
  };
}

/**
 * The daemon request surface (§6): `launch`, `run`, and `status` — the whole
 * N2.1 surface. Unknown methods are a correlated failure, never a connection
 * failure. Every request emits exactly one bounded structured line — method,
 * the caller's hashed session prefix, the bounded idempotency key / action /
 * run identifiers when present, the typed outcome, and the elapsed ms. Wire
 * content beyond identifiers never logs.
 */
export function daemonDispatcher(runtime: DaemonRuntime): DaemonRequestHandler {
  return async (request) => {
    const startedAt = Date.now();
    const method = safeIdentifier(request.method) ? request.method.slice(0, 64) : "-";
    const params = isRecord(request.params) ? request.params : {};
    let mgr = "-";
    try {
      const claim = parseCallerClaim(params.identity);
      if (claim.agentSession !== null) mgr = managerSessionKey(claim.agentSession).slice(0, 8);
    } catch {
      // A malformed identity is refused by the handler's own verification path.
    }
    const extras: string[] = [];
    if (safeIdentifier(params.idempotencyKey) && params.idempotencyKey.length <= 128) extras.push(`key=${params.idempotencyKey}`);
    if (safeIdentifier(params.action) && params.action.length <= 32) extras.push(`action=${params.action}`);
    if (safeIdentifier(params.runId) && params.runId.length <= 128) extras.push(`run=${params.runId}`);
    if (safeIdentifier(params.eventId) && params.eventId.length <= 128) extras.push(`event=${params.eventId}`);
    let outcome = "reply";
    try {
      switch (request.method) {
        case "launch": return await handleDaemonLaunch(runtime, params);
        case "run": return await handleDaemonRun(runtime, params);
        case "status": return await handleDaemonStatus(runtime, params);
        default: throw new DaemonRequestError("DAEMON_UNKNOWN_METHOD", "daemon method is not implemented");
      }
    } catch (error) {
      outcome = codeOf(error) ?? "DAEMON_REQUEST_FAILED";
      throw error;
    } finally {
      try {
        runtime.log?.(`herdr-tools-daemon request method=${method} mgr=${mgr}${extras.length === 0 ? "" : ` ${extras.join(" ")}`} outcome=${outcome} ms=${Date.now() - startedAt}`);
      } catch {
        /* c8 ignore -- the log sink can never fail a request. */
      }
    }
  };
}
