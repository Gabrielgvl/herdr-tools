/**
 * The one runtime assembly every Herdr tools host shares (durable-supervisor
 * §5): the CLI transport, JobRegistry, the Devin queue-flush coordinator, the
 * managed-handoff gate, the ownership and recipient ledgers, and the
 * SupervisionRegistry wired to the host's wake channel and session-event
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
import { RecipientRegistry } from "../messages/recipients.js";
import { defaultAttachmentStore, type AttachmentStore } from "../messages/store.js";
import { RuntimeOwnership } from "../ownership.js";
import { createPaneWriteGuard, resolvePaneWriteNamespace } from "../pane-write-lock.js";
import { loadSettings, type Settings } from "../settings.js";
import { createCliTranscriptReader, SupervisionRegistry } from "../supervision/registry.js";
import type { SelfCloseTracker } from "../supervision/self-close.js";
import type { ManagerNotifier } from "../supervision/notify.js";
import { parseSnapshotResult, type HerdrSnapshot } from "../targets.js";
import type { LaunchDependencies } from "../tools/launch.js";
import { handleDaemonLaunch } from "./handlers/launch.js";
import { handleDaemonRun } from "./handlers/run.js";
import { handleDaemonStatus } from "./handlers/status.js";
import { createIdleHints, type IdleHintSink } from "./hints.js";
import { createIntentStore, managerSessionKey, type IntentStore } from "./intents.js";
import { createOwnership } from "./ownership.js";
import type { Mailbox } from "./mailbox.js";
import type { DaemonNamespace } from "./namespace.js";
import { DaemonRequestError } from "./protocol.js";
import type { DaemonRequestHandler } from "./server.js";

/** The narrow CLI surface daemon request plumbing needs — `HerdrCli` satisfies it. */
export interface DaemonCli {
  runJson(argv: string[], signal: AbortSignal): Promise<JsonEnvelope>;
}

/** What a host may layer onto the shared assembly between the CLI and supervision. */
export interface SharedRuntimeWiring {
  /** A job registry carrying the host's own terminal/change callbacks. */
  jobs?: JobRegistry;
  /** The host's wake channel for supervisor events; absent means inert. */
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
  attachments?: AttachmentStore;
  recipients?: RecipientRegistry;
  settingsLoader?: () => Promise<Settings>;
  /**
   * Host seam invoked after the CLI and queue flush exist and before the job
   * registry and supervision registry are built — where a host's wake channel
   * and job-registry callbacks wire in.
   */
  wire?: (parts: { cli: HerdrCli; queueFlush: DevinQueueFlush }) => SharedRuntimeWiring;
}

export interface SharedRuntime {
  cli: HerdrCli;
  queueFlush: DevinQueueFlush;
  jobs: JobRegistry;
  ownership: RuntimeOwnership;
  recipients: RecipientRegistry;
  attachments: AttachmentStore;
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
  const attachments = deps.attachments ?? defaultAttachmentStore;
  const recipients = deps.recipients ?? new RecipientRegistry();
  const ownership = new RuntimeOwnership();
  // The coordinator's namespace resolves lazily on first use, so constructing
  // the runtime still performs no filesystem or Herdr calls.
  const queueFlush = createDevinQueueFlush({ cli, guard: createPaneWriteGuard({ namespace: resolvePaneWriteNamespace.bind(null, env) }) });
  queueFlush.begin();
  const wiring = deps.wire?.({ cli, queueFlush }) ?? {};
  const jobs = wiring.jobs ?? new JobRegistry();
  const handoffs = createHandoffGate();
  const supervision = new SupervisionRegistry({
    jobs,
    settingsLoader: deps.settingsLoader ?? (() => loadSettings()),
    readTranscript: createCliTranscriptReader(cli),
    ...(wiring.notifier === undefined ? {} : { notifier: wiring.notifier }),
    monitorOptions: deps.env === undefined ? {} : { env: deps.env },
    ...(wiring.selfClose === undefined ? {} : { selfClose: wiring.selfClose }),
    ...(wiring.hints === undefined ? {} : { hints: wiring.hints }),
    handoffs,
    repairPrompt: (paneId, text, signal) => cli.prompt(paneId, text, signal),
  });
  return { cli, queueFlush, jobs, ownership, recipients, attachments, handoffs, supervision };
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
   * §11 qualified hint kinds — the production default is EMPTY and stays so
   * until the C9 owner gate (N5.2). Only the disposable test daemon passes
   * the candidate set.
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
  /** The §8 ownership journal surface: pending transfers, transfer/claim, retarget. */
  daemonOwnership: DaemonOwnership;
  /** The §11 idle-hint sink the runtime forwarded to its supervision registry. */
  hints: IdleHintSink;
  /**
   * In-flight launch executions keyed `<managerSessionKey>/<idempotencyKey>`:
   * a second caller that `begin`s a still-`recorded` intent waits for the live
   * attempt instead of launching a duplicate — the durable binding only
   * serializes records, not concurrent executors.
   */
  inflight: Map<string, Promise<unknown>>;
}

export function createDaemonRuntime(deps: DaemonRuntimeDeps): DaemonRuntime {
  const bound: { mailbox?: Mailbox } = { mailbox: deps.mailbox };
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
  // The wire seam runs synchronously inside `createSharedRuntime` and always
  // reassigns `hints` before `sink` below can be invoked; the initializer only
  // satisfies definite assignment.
  /* c8 ignore next */
  let hints: IdleHintSink = () => undefined;
  const shared = createSharedRuntime({
    ...deps,
    wire: (parts) => {
      const host = deps.wire?.(parts) ?? {};
      // §11: the qualified-kind set is empty unless the daemon start option
      // supplies it — production passes nothing (N5.2 gate).
      hints = deps.hints ?? createIdleHints({
        cli: parts.cli,
        mailbox: deferredMailbox,
        namespace: deps.namespace,
        qualifiedKinds: deps.hintKinds,
      });
      return { ...host, hints };
    },
  });
  const intents = deps.intents ?? createIntentStore({ namespace: deps.namespace });
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
    daemonOwnership: ownership,
    hints: sink,
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

/** A bounded typed code carried by the cause, else the refusal's own code. */
function codeOf(error: unknown): string | undefined {
  const code = isRecord(error) ? error.code : undefined;
  return typeof code === "string" && DAEMON_CODE.test(code) ? code : undefined;
}

/** Map any failure into the wire's typed refusal shape. */
export function daemonRequestError(error: unknown, fallback = "DAEMON_REQUEST_FAILED"): DaemonRequestError {
  return error instanceof DaemonRequestError ? error : new DaemonRequestError(codeOf(error) ?? fallback);
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
 * failure.
 */
export function daemonDispatcher(runtime: DaemonRuntime): DaemonRequestHandler {
  return (request) => {
    switch (request.method) {
      case "launch": return handleDaemonLaunch(runtime, request.params);
      case "run": return handleDaemonRun(runtime, request.params);
      case "status": return handleDaemonStatus(runtime, request.params);
      default: throw new DaemonRequestError("DAEMON_UNKNOWN_METHOD", "daemon method is not implemented");
    }
  };
}
