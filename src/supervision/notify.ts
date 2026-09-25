/**
 * Manager wake delivery. Report-only and best effort.
 *
 * A dropped wake is recovered by asking — `herdr_jobs get` returns the pending
 * unobserved events and marks exactly those observed — so the only resend here
 * is the Claude channel write's small bounded retry; nothing else escalates or
 * waits for an acknowledgement. Delivery failure must never affect supervision
 * state.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { boundedText, type JobDetail } from "../job-registry.js";
import { notificationForJob } from "../job-notification.js";
import { resolveEffectiveContext } from "../context.js";
import { adoptUnnamedTarget, LAZY_ADOPT_KINDS, type AdoptOutcome } from "../agent-identity.js";
import type { JsonEnvelope } from "../cli.js";
import type { DevinQueueFlush, DevinQueueFlushRequest } from "../messages/devin-queue-flush.js";
import { agentFrom, assertSendableState, paneFrom, snapshotIdentityRecords } from "../messages/prompt-target.js";
import { parsePromptSubmission, parsePromptTargetIdentityFields, requirePromptTargetIdentity } from "../messages/prompt.js";
import { buildEnvelope, resolveSender, type ProvenanceKind } from "../provenance.js";
import type { CurrentContext } from "../targets.js";
import type { SupervisionEvent } from "./events.js";

export const SUPERVISION_WAKE_CONTENT_BYTES = 4_000;
export const SUPERVISION_WAKE_FIELD_BYTES = 256;
/** The Claude Code Channels research-preview notification method. */
export const CLAUDE_CHANNEL_NOTIFICATION_METHOD = "notifications/claude/channel";
/** The experimental capability key a Channels-capable MCP server advertises. */
export const CLAUDE_CHANNEL_CAPABILITY = "claude/channel";

export interface SupervisionChildRef {
  agentName: string;
  agentKind: string;
  paneId: string;
}

export interface SupervisionWake {
  jobId: string;
  child: SupervisionChildRef;
  event: SupervisionEvent;
}

export interface ManagerNotifier {
  wake(wake: SupervisionWake): void;
}

function field(value: string): string {
  return boundedText(value, SUPERVISION_WAKE_FIELD_BYTES);
}

/**
 * The wake text is the only part a host renders back into the manager's
 * context on later turns (Pi replays custom messages as user turns), so it
 * carries its own staleness signal: the event time, the event id, and the
 * rule that an already-observed id or a settled job is history, not a wake.
 */
export function supervisionWakeContent(wake: SupervisionWake): string {
  const prefix = wake.event.priority === "high" ? "HIGH PRIORITY: " : "";
  const at = Number.isFinite(wake.event.atMs) ? new Date(wake.event.atMs).toISOString() : "an unknown time";
  return boundedText(
    `${prefix}Herdr supervisor ${field(wake.jobId)} for child ${field(wake.child.agentName)} (${field(wake.child.paneId)}, ${field(wake.child.agentKind)}) reported ${field(wake.event.type)} (event ${field(wake.event.eventId)}): ${field(wake.event.summary)}. Delivered once at ${at}; if this event id is already in your ledger or the job is settled, do nothing. Otherwise read the full event with herdr_jobs get on this job id; returned events are marked observed.`,
    SUPERVISION_WAKE_CONTENT_BYTES,
  );
}

export function supervisionWakeMeta(wake: SupervisionWake): Record<string, unknown> {
  return {
    jobId: field(wake.jobId),
    kind: "supervisor",
    eventId: field(wake.event.eventId),
    eventType: wake.event.type,
    priority: wake.event.priority,
    atMs: wake.event.atMs,
    agentName: field(wake.child.agentName),
    agentKind: field(wake.child.agentKind),
    paneId: field(wake.child.paneId),
    ...(wake.event.details === undefined ? {} : { details: wake.event.details }),
  };
}

export type PiSendMessage = (
  message: { customType: string; content: string; display: boolean; details: Record<string, unknown> },
  options: { deliverAs: "steer"; triggerTurn: true },
) => unknown;

/** The Pi host's existing custom-context wake path. */
export function createPiSupervisionNotifier(sendMessage: PiSendMessage): ManagerNotifier {
  return {
    wake(wake) {
      try {
        void Promise.resolve(sendMessage(
          { customType: "herdr-supervision", content: supervisionWakeContent(wake), display: true, details: supervisionWakeMeta(wake) },
          { deliverAs: "steer", triggerTurn: true },
        )).catch(() => undefined);
      } catch {
        // Pi may be shutting down; the wake is explicitly best effort.
      }
    },
  };
}

export type ChannelNotify = (notification: { method: string; params: { content: string; meta: Record<string, unknown> } }) => unknown;

/** A notifier for a host with no wake channel at all. Supervision still records everything. */
export const inertNotifier: ManagerNotifier = { wake: () => undefined };

/** The narrow CLI surface the MCP host wake router needs — `HerdrCli` satisfies it. */
export interface McpWakeCli {
  runJson(argv: string[], signal: AbortSignal): Promise<JsonEnvelope>;
  prompt(target: string, text: string, signal: AbortSignal): Promise<JsonEnvelope>;
}

export interface McpHostWakeDeps {
  cli: McpWakeCli;
  context: CurrentContext;
  notifyChannel: ChannelNotify;
  /** Aborted by the host at shutdown: an in-flight pipeline must not send after close. */
  signal: AbortSignal;
  /**
   * The host's shared Devin queue-flush coordinator: it owns the write section
   * this pipeline's Devin send passes through and any flush the ack schedules.
   */
  queueFlush: DevinQueueFlush;
}

/**
 * The MCP host's one wake surface. The supervisor path feeds `notifier`; the
 * job registry's `onTerminal` feeds `notifyJobTerminal`. Both converge on a
 * single `deliver` that routes by the hosting pane's lazily resolved agent
 * kind, so every wake stays best effort: only the Claude channel write retries,
 * on a short bound, and a failure past that is a silent drop — `herdr_jobs get`
 * remains the recovery contract.
 */
export interface McpHostWake {
  readonly notifier: ManagerNotifier;
  notifyJobTerminal(detail: JobDetail): void;
}

/**
 * Kinds whose own pane is proven to render an `agent.prompt` write as a turn.
 * This is an explicit allowlist, not "everything except claude/agy": an unknown
 * future kind stays inert until its TUI proves it consumes typed input.
 */
const PROMPT_WAKE_KINDS = new Set(["devin", "pi"]);
/**
 * Kinds allowed to mint their own routing name when detection left their pane
 * unnamed. Explicitly allowlisted — never "not agy" — because adoption asserts
 * reachability that policy has only granted these three; an unsupported kind
 * such as `agy` stays inert.
 */
const SELF_ADOPT_KINDS = LAZY_ADOPT_KINDS;
const WAKE_PIPELINE_TIMEOUT_MS = 15_000;
/**
 * The Claude channel write is the one wake send that retries: the identical
 * payload at most this many times, with a short fixed backoff armed on the
 * pipeline's combined timeout/shutdown signal. The Channels preview has no
 * delivery acknowledgement, so transport write resolution is the ack;
 * exhaustion or abort stays the same silent drop as any other wake failure.
 */
export const CLAUDE_WAKE_MAX_ATTEMPTS = 3;
export const CLAUDE_WAKE_RETRY_DELAY_MS = 200;

export function createMcpHostWake(deps: McpHostWakeDeps): McpHostWake {
  const ownPaneId = deps.context.paneId;
  // Resolved lazily on the first delivery, never at construction: startup stays
  // side-effect-free. One shared in-flight promise means a burst of wakes pays
  // exactly one `pane get`; a rejected read is not cached, so the next wake
  // retries, while a resolved kind — including "no usable kind" — is permanent
  // for the session. The pane record rides along so the self-adopt gate can
  // consult the same coherent read instead of a second probe.
  interface OwnPaneResolution {
    kind: string;
    paneId: string;
    pane: Record<string, unknown>;
  }
  let kindPromise: Promise<OwnPaneResolution | undefined> | undefined;
  const resolveKind = (signal: AbortSignal): Promise<OwnPaneResolution | undefined> => {
    if (ownPaneId === undefined) return Promise.resolve(undefined);
    if (kindPromise === undefined) {
      const pending = deps.cli
        .runJson(["pane", "get", ownPaneId], signal)
        .then((envelope) => {
          const pane = paneFrom(envelope.result, ownPaneId);
          const kind = parsePromptTargetIdentityFields(pane, ownPaneId).agentKind;
          return kind === undefined ? undefined : { kind, paneId: ownPaneId, pane };
        });
      kindPromise = pending;
      void pending.catch(() => {
        // Only a settled rejection clears the slot; it runs before any later
        // wake can install a replacement, so clearing unconditionally is safe.
        kindPromise = undefined;
      });
    }
    return kindPromise;
  };

  const paneSuppliesNoName = (pane: Record<string, unknown>): boolean =>
    typeof pane.name !== "string" && typeof pane.agent_name !== "string";

  /**
   * Lazy self-adoption, once per session. Runs only when the kind-resolution
   * read showed an unnamed pane; the attempt re-reads the full identity set
   * and mints only when the name is the *sole* missing join field — any other
   * failure stays fail-closed. Outcomes are memoized exactly like the kind:
   * "named" and "refused" (collision exhaustion, no derivable name) are
   * permanent, while "unqualified" is cleared so the next wake re-evaluates —
   * detection can mature. A minted name is verified through the real join
   * before the provenance tokens are written; the tokens are advisory and
   * their failure never voids the adoption.
   */
  const attemptSelfName = async (paneId: string, kind: string, signal: AbortSignal): Promise<AdoptOutcome> => {
    try {
      return (await adoptUnnamedTarget(deps.cli, paneId, kind, paneId, signal)).outcome;
    } catch {
      return "unqualified";
    }
  };
  let selfNamePromise: Promise<AdoptOutcome> | undefined;
  const ensureOwnName = (paneId: string, kind: string, signal: AbortSignal): Promise<AdoptOutcome> => {
    if (selfNamePromise === undefined) {
      const pending = attemptSelfName(paneId, kind, signal);
      selfNamePromise = pending;
      void pending.then((outcome) => {
        // Only a settled outcome clears the slot; it runs before any later
        // wake can install a replacement, so clearing unconditionally is safe.
        if (outcome === "unqualified") selfNamePromise = undefined;
      });
    }
    return selfNamePromise;
  };

  const pipeline = async (content: string, meta: Record<string, unknown>, kind: ProvenanceKind): Promise<void> => {
    const signal = AbortSignal.any([AbortSignal.timeout(WAKE_PIPELINE_TIMEOUT_MS), deps.signal]);
    const resolution = await resolveKind(signal);
    // Lazy self-adoption sits between kind resolution and the identity join: a
    // detected-but-never-launched pane has a complete session but no routing
    // name, so the join below would fail closed. When the resolution read
    // showed no name and the kind may adopt, mint one derived name once —
    // memoized for the session and inert on agent_name_taken — so this and
    // every later wake join on a real identity. A pane already named by hand
    // is untouched. For Claude the name buys inbound reachability only; the
    // channel notification below never depends on it.
    if (resolution !== undefined && SELF_ADOPT_KINDS.has(resolution.kind) && paneSuppliesNoName(resolution.pane)) {
      await ensureOwnName(resolution.paneId, resolution.kind, signal);
    }
    const resolved = resolution?.kind;
    if (resolved === "claude") {
      // Channels-only for Claude (owner decision): even though targeted prompt
      // delivery to Claude panes is qualified for tool calls, a self-wake is
      // the server prompting its own hosting pane — a deliberately different
      // boundary. The write retries the identical payload on the pipeline's
      // signal, so a wake in the transport's connect window lands while a
      // genuine drop still costs nothing past the bound.
      const notification = { method: CLAUDE_CHANNEL_NOTIFICATION_METHOD, params: { content, meta } };
      for (let attempt = 1; attempt <= CLAUDE_WAKE_MAX_ATTEMPTS; attempt += 1) {
        // No write may leave once shutdown landed; the backoff is armed on the
        // same signal, so an abort mid-wait also ends the pipeline at this
        // check before any further send.
        if (signal.aborted) return;
        try {
          await Promise.resolve(deps.notifyChannel(notification));
          return;
        } catch {
          if (attempt === CLAUDE_WAKE_MAX_ATTEMPTS) return;
          await sleep(CLAUDE_WAKE_RETRY_DELAY_MS, undefined, { signal });
        }
      }
      // c8 ignore next -- every loop path returns or aborts; retained as an explicit branch boundary.
      return;
    }
    if (resolved === undefined || !PROMPT_WAKE_KINDS.has(resolved)) return;

    // Self-prompt: the target is the server's own hosting pane. The
    // communicate tool's SELF_TARGET_REJECTED policy does not apply here —
    // that rule protects an agent from prompting itself *as a tool call*; the
    // socket has no self-target rule, and this wake is the delivery mechanism,
    // not a user message.
    const effective = await resolveEffectiveContext(deps.cli, deps.context, signal);
    const paneId = effective.context.paneId;
    const sendWake = async (): Promise<DevinQueueFlushRequest | undefined> => {
      const agentEnvelope = await deps.cli.runJson(["agent", "get", paneId], signal);
      const paneEnvelope = await deps.cli.runJson(["pane", "get", paneId], signal);
      const pane = paneFrom(paneEnvelope.result, paneId);
      const records = [
        ...snapshotIdentityRecords(effective.snapshot, paneId),
        agentFrom(agentEnvelope.result),
        pane
      ];
      const identity = requirePromptTargetIdentity(records, paneId);
      // Defense in depth: the freshly proven identity must agree with the kind
      // that routed this wake and must itself be prompt-capable.
      if (!PROMPT_WAKE_KINDS.has(identity.agentKind) || identity.agentKind !== resolved) return undefined;
      // Sendable-state gate only (owner decision): `working` and `blocked` still
      // send — the identical `agent.prompt` write the communicate "steer" route
      // makes without a busy gate — while `unknown` or unproven state drops. A
      // socket-level `agent_blocked` refusal lands as an ordinary drop.
      const sentState = assertSendableState(pane);
      const envelope = buildEnvelope(resolveSender(effective.snapshot, paneId), kind, content, "inline");
      const submission = parsePromptSubmission(await deps.cli.prompt(paneId, envelope, signal), identity);
      return { submission, sentState };
    };
    // A Devin write rides inside the shared pane-write section so a flush's
    // proof/Enter in another host cannot interleave with the bracketed-paste
    // submission; other kinds keep their unguarded write.
    const sent = resolved === "devin"
      ? await (async () => {
        const lease = await deps.queueFlush.writeSection(paneId);
        try {
          return await sendWake();
        } finally {
          await lease.release();
        }
      })()
      : await sendWake();
    // Devin queues a write submitted mid-turn instead of steering it, and that
    // queue survives the turn end until an Enter flushes it — observed live as
    // wake envelopes sitting unconsumed on an idle composer. Scheduling the
    // acknowledged send for the shared coordinator writes nothing new and is
    // not a retry. Pi steers the same write into the running turn, so nothing
    // follows it.
    if (sent === undefined) {
      return;
    } else {
      deps.queueFlush.schedule(sent);
    }
  };

  const deliver = (content: string, meta: Record<string, unknown>, kind: ProvenanceKind): void => {
    void pipeline(content, meta, kind).catch(() => undefined);
  };

  return {
    notifier: {
      wake(wake) {
        try {
          deliver(supervisionWakeContent(wake), supervisionWakeMeta(wake), "supervision");
        } catch {
          // A wake that cannot even be rendered is dropped; never surfaced.
        }
      },
    },
    notifyJobTerminal(detail) {
      // Mirrors the Pi host guard: only wait-kind settlements notify here;
      // supervisor settlements already arrive as supervision events.
      if (detail.kind !== "wait") return;
      try {
        const notification = notificationForJob(detail);
        deliver(notification.content, notification.details, "wait");
      } catch {
        // Best effort: a notification that cannot be rendered is dropped.
      }
    },
  };
}
