/**
 * Manager wake delivery. Report-only, best effort, never retried.
 *
 * A dropped wake is recovered by asking — `herdr_jobs get` returns the pending
 * unobserved events and marks exactly those observed — so nothing here resends,
 * escalates, or waits for an acknowledgement. Delivery failure must never affect
 * supervision state.
 */

import { boundedText, type JobDetail } from "../job-registry.js";
import { notificationForJob } from "../job-notification.js";
import { resolveEffectiveContext } from "../context.js";
import type { JsonEnvelope } from "../cli.js";
import { agentFrom, assertQualifiedPromptTarget, assertSendableState, paneFrom, snapshotIdentityRecords, stateOf } from "../messages/prompt-target.js";
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

export function supervisionWakeContent(wake: SupervisionWake): string {
  const prefix = wake.event.priority === "high" ? "HIGH PRIORITY: " : "";
  return boundedText(
    `${prefix}Herdr supervisor ${field(wake.jobId)} for child ${field(wake.child.agentName)} (${field(wake.child.paneId)}, ${field(wake.child.agentKind)}) reported ${field(wake.event.type)}: ${field(wake.event.summary)}. Read the full event with herdr_jobs get on this job id; returned events are marked observed.`,
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
  runText(argv: string[], signal: AbortSignal): Promise<string>;
  prompt(target: string, text: string, signal: AbortSignal): Promise<JsonEnvelope>;
}

export interface McpHostWakeDeps {
  cli: McpWakeCli;
  context: CurrentContext;
  notifyChannel: ChannelNotify;
  /** Aborted by the host at shutdown: an in-flight flush must not press Enter after close. */
  signal: AbortSignal;
}

/**
 * The MCP host's one wake surface. The supervisor path feeds `notifier`; the
 * job registry's `onTerminal` feeds `notifyJobTerminal`. Both converge on a
 * single `deliver` that routes by the hosting pane's lazily resolved agent
 * kind, so every wake stays best effort: a failure is a drop, never a retry,
 * and `herdr_jobs get` remains the recovery contract.
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
const WAKE_PIPELINE_TIMEOUT_MS = 15_000;
/**
 * Devin's composer holds input submitted mid-turn in a queue that does not
 * drain when the turn ends — it flushes only on an explicit Enter. A flush
 * cycle is bounded overall, and the in-flight-turn wait inside it is strictly
 * shorter so the post-wait reads and key retain signal budget.
 */
const WAKE_QUEUE_FLUSH_BUDGET_MS = 120_000;
const WAKE_QUEUE_FLUSH_WAIT_MS = 110_000;
/** A marker still rendered after a press is drained once more — completing the send, never resending it. */
const WAKE_QUEUE_FLUSH_MAX_PRESSES = 2;
/** Devin's composer input-box glyph; the last such row is the input line. */
const DEVIN_INPUT_GLYPH = "❭";
/** Each queued composer message row is prefixed with ○ (U+25CB). */
const DEVIN_QUEUED_GLYPH = "○";
/** A composer border row: a long box-drawing run, possibly annotated ("(bypass permissions on) ─"). */
const COMPOSER_RULE_PATTERN = /─{10,}/;
/** Queue evidence inside the box: a queued-message row, or the word itself. */
const QUEUED_COMPOSER_PATTERN = /\bqueued\b/;
const ANSI_ESC = "\x1b";
const CSI_PATTERN = new RegExp(`${ANSI_ESC}\\[[0-9;:?]*[A-Za-z]`, "g");
const SGR_PREFIX = new RegExp(`^${ANSI_ESC}\\[([0-9;:?]*)([A-Za-z])`);

function stripAnsi(text: string): string {
  return text.replace(CSI_PATTERN, "");
}

interface SgrState {
  /** Devin's placeholder gray (124,124,124) is the active foreground. */
  placeholder: boolean;
  /** Any non-default SGR attribute is active — rendered chrome, never typed text. */
  styled: boolean;
}

/**
 * Fold one SGR parameter run into the style state. `;` and `:` both separate
 * parameters (ITU-T T.416); an empty slot is an omitted parameter, which SGR
 * defines as `0` — reset — so `ESC[;m` clears exactly like `ESC[0m`. The one
 * exception is inside an extended-color payload, where an empty slot after
 * mode `2` is the omitted T.416 colorspace sub-parameter and is skipped.
 * Extended payloads are consumed as a unit — `38`/`48`/`58` take `;2;R;G;B`
 * or `;5;N` — so their components never leak into top-level interpretation.
 * Foreground colors decide `placeholder`: only the exact gray sets it, and
 * *any* other foreground — basic `30-37`, bright `90-97`, `38` variants, or
 * the `39` default — clears it, so a printable character under a
 * non-placeholder color can never pass the empty-input proof. Background
 * (`48`) and underline (`58`) colors mark the line styled without touching
 * `placeholder`. Per-attribute resets (`22-29`, `49`, `59`) are approximated
 * as clearing both — a partially-styled line then reads unstyled, which only
 * ever refuses the key.
 */
function sgrFold(params: string, state: SgrState): SgrState {
  const parts = params === "" ? ["0"] : params.split(/[;:]/);
  let { placeholder, styled } = state;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (part === "" || part === "0") {
      placeholder = false;
      styled = false;
    } else if ((part === "38" || part === "48" || part === "58") && parts[i + 1] === "2") {
      const colorspace = parts[i + 2] === "" ? 1 : 0;
      if (part === "38") {
        placeholder = parts[i + 2 + colorspace] === "124" && parts[i + 3 + colorspace] === "124" && parts[i + 4 + colorspace] === "124";
      }
      styled = true;
      i += 4 + colorspace;
    } else if ((part === "38" || part === "48" || part === "58") && parts[i + 1] === "5") {
      if (part === "38") placeholder = false;
      styled = true;
      i += 2;
    } else if (part === "38") {
      placeholder = false;
      styled = true;
    } else if (part === "48" || part === "58") {
      styled = true;
    } else if (part === "39" || part === "49" || part === "59" || /^2[2-9]$/.test(part)) {
      placeholder = false;
      styled = false;
    } else if (/^[39][0-7]$/.test(part)) {
      placeholder = false;
      styled = true;
    } else {
      styled = true;
    }
  }
  return { placeholder, styled };
}

interface DevinComposer {
  queued: boolean;
  inputEmpty: boolean;
  /** The box interior (queue section + input region) stripped of SGR — an unchanged value on the post-press read means the frame has not repainted yet. */
  interior: string;
}

/**
 * Prove the rendered Devin composer from a `--format ansi` visible read: the
 * input box is the last `❭` row between two border rules. `inputEmpty`
 * requires the input line itself to be all-placeholder after the glyph — so
 * Enter can never submit a draft — and any further rows inside the box to be
 * entirely styled chrome (a hint row; a draft's wrapped continuation is
 * unstyled and refuses). SGR state walks each raw line in full, so escapes
 * opened before the glyph or continued onto a wrapped row are honoured.
 * `queued` requires queue evidence *inside the box* — a `○`-prefixed message
 * row, the word "queued" in the section, or the placeholder hint itself —
 * never in scrollback, where transcript text can say the same words. Any
 * parse failure returns undefined: unproven means no key.
 */
function devinComposer(view: string): DevinComposer | undefined {
  const lines = view.split("\n");
  let input = -1;
  for (let i = lines.length - 1; i >= 0 && input < 0; i -= 1) {
    if (stripAnsi(lines[i]!).startsWith(DEVIN_INPUT_GLYPH)) input = i;
  }
  if (input < 0) return undefined;
  let top = -1;
  for (let i = input - 1; i >= 0 && top < 0; i -= 1) {
    if (COMPOSER_RULE_PATTERN.test(stripAnsi(lines[i]!))) top = i;
  }
  let bottom = -1;
  for (let i = input + 1; i < lines.length && bottom < 0; i += 1) {
    if (COMPOSER_RULE_PATTERN.test(stripAnsi(lines[i]!))) bottom = i;
  }
  if (top < 0 || bottom < 0) return undefined;
  const glyphIndex = lines[input]!.indexOf(DEVIN_INPUT_GLYPH);
  let state: SgrState = { placeholder: false, styled: false };
  let inputEmpty = true;
  for (let row = input; row < bottom && inputEmpty; row += 1) {
    const raw = lines[row]!;
    let index = 0;
    while (index < raw.length) {
      const escape = SGR_PREFIX.exec(raw.slice(index));
      if (escape !== null) {
        if (escape[2] === "m") state = sgrFold(escape[1]!, state);
        index += escape[0].length;
        continue;
      }
      const char = raw[index]!;
      index += 1;
      if (char === ANSI_ESC || char.trim().length === 0) continue;
      if (row === input && index - 1 <= glyphIndex) continue;
      // The input line proves empty only under the placeholder style; any row
      // below it must be styled chrome — unstyled text there is a draft tail.
      if (row === input ? !state.placeholder : !state.styled) {
        inputEmpty = false;
        break;
      }
    }
  }
  const section = lines.slice(top + 1, input);
  const queued = section.some((line) => stripAnsi(line).startsWith(DEVIN_QUEUED_GLYPH))
    || QUEUED_COMPOSER_PATTERN.test(stripAnsi(section.join("\n")))
    || (inputEmpty && QUEUED_COMPOSER_PATTERN.test(stripAnsi(lines.slice(input, bottom).join("\n"))));
  return { queued, inputEmpty, interior: stripAnsi(lines.slice(top + 1, bottom).join("\n")) };
}

export function createMcpHostWake(deps: McpHostWakeDeps): McpHostWake {
  const ownPaneId = deps.context.paneId;
  // Resolved lazily on the first delivery, never at construction: startup stays
  // side-effect-free. One shared in-flight promise means a burst of wakes pays
  // exactly one `pane get`; a rejected read is not cached, so the next wake
  // retries, while a resolved kind — including "no usable kind" — is permanent
  // for the session.
  let kindPromise: Promise<string | undefined> | undefined;
  const resolveKind = (signal: AbortSignal): Promise<string | undefined> => {
    if (ownPaneId === undefined) return Promise.resolve(undefined);
    if (kindPromise === undefined) {
      const pending = deps.cli
        .runJson(["pane", "get", ownPaneId], signal)
        .then((envelope) => parsePromptTargetIdentityFields(paneFrom(envelope.result, ownPaneId), ownPaneId).agentKind);
      kindPromise = pending;
      void pending.catch(() => {
        // Only a settled rejection clears the slot; it runs before any later
        // wake can install a replacement, so clearing unconditionally is safe.
        kindPromise = undefined;
      });
    }
    return kindPromise;
  };

  /**
   * Complete a queued own-pane write: wait out the in-flight turn, then press
   * Enter only while the rendered composer still proves queued input above an
   * empty (all-placeholder) input area and a fresh `pane get` shows
   * `idle`/`done` — on a `blocked` or draft-bearing composer Enter would do
   * something else entirely. One Enter drains the whole queue, so a second
   * press is allowed only on an *observed change* — a different box interior
   * on the re-read — since an identical frame is repaint lag, not evidence of
   * an un-drained queue; anything newer is drained once more, never resent.
   * Cycles serialize on `queueTail`: a wake acking while the latest cycle
   * still waits joins its drain (its write lands before that cycle's composer
   * reads), and anything later appends a fresh cycle behind it, so no
   * acknowledged write goes unseen. Each cycle's budget starts when the cycle
   * starts, not when it is queued. Session shutdown cancels the cycle: Enter
   * must not fire after close. Every failure is a drop.
   */
  // True exactly while the latest cycle has not yet passed its `agent wait`
  // (it clears before that cycle's first composer read), so a write acked in
  // that window is always visible to the drain it joins.
  let queueWaiting = false;
  let queueTail: Promise<void> = Promise.resolve();
  const flushQueuedOwnPane = async (paneId: string): Promise<void> => {
    if (queueWaiting) {
      await queueTail;
      return;
    }
    queueWaiting = true;
    const next = queueTail.then(async () => {
      const signal = AbortSignal.any([AbortSignal.timeout(WAKE_QUEUE_FLUSH_BUDGET_MS), deps.signal]);
      try {
        await deps.cli.runJson(["agent", "wait", paneId, "--until", "idle", "--until", "done", "--timeout", String(WAKE_QUEUE_FLUSH_WAIT_MS)], signal);
      } finally {
        queueWaiting = false;
      }
      if (signal.aborted) return;
      let lastInterior: string | undefined;
      for (let press = 0; press < WAKE_QUEUE_FLUSH_MAX_PRESSES; press += 1) {
        const composer = devinComposer(await deps.cli.runText(["pane", "read", paneId, "--source", "visible", "--format", "ansi"], signal));
        if (composer === undefined || !composer.queued || !composer.inputEmpty) return;
        // One Enter drains the entire queue; an interior identical to the
        // frame just pressed on means the terminal has not repainted, not
        // that the queue survived — only a changed frame earns one more key.
        if (press > 0 && composer.interior === lastInterior) return;
        const state = stateOf(paneFrom((await deps.cli.runJson(["pane", "get", paneId], signal)).result, paneId));
        if ((state !== "idle" && state !== "done") || signal.aborted) return;
        await deps.cli.runJson(["agent", "send-keys", paneId, "enter"], signal);
        lastInterior = composer.interior;
      }
    });
    // The tail never stays rejected: later cycles still run after a drop.
    queueTail = next.catch(() => {});
    await next;
  };

  const pipeline = async (content: string, meta: Record<string, unknown>, kind: ProvenanceKind): Promise<void> => {
    const signal = AbortSignal.any([AbortSignal.timeout(WAKE_PIPELINE_TIMEOUT_MS), deps.signal]);
    const resolved = await resolveKind(signal);
    if (resolved === "claude") {
      // Channels-only for Claude (owner decision): even though targeted prompt
      // delivery to Claude panes is qualified for tool calls, a self-wake is
      // the server prompting its own hosting pane — a deliberately different
      // boundary. The send itself is unproven and ack-free, exactly like the
      // standalone notifier, and `herdr_jobs` polling stays the contract.
      await Promise.resolve(deps.notifyChannel({ method: CLAUDE_CHANNEL_NOTIFICATION_METHOD, params: { content, meta } }));
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
    if (!PROMPT_WAKE_KINDS.has(identity.agentKind) || identity.agentKind !== resolved) return;
    assertQualifiedPromptTarget(records, paneId);
    // Sendable-state gate only (owner decision): `working` and `blocked` still
    // send — the identical `agent.prompt` write the communicate "steer" route
    // makes without a busy gate — while `unknown` or unproven state drops. A
    // socket-level `agent_blocked` refusal lands as an ordinary drop.
    const sentState = assertSendableState(pane);
    const envelope = buildEnvelope(resolveSender(effective.snapshot, paneId), kind, content, "inline");
    parsePromptSubmission(await deps.cli.prompt(paneId, envelope, signal), identity);
    // Devin queues a write submitted mid-turn instead of steering it, and that
    // queue survives the turn end until an Enter flushes it — observed live as
    // wake envelopes sitting unconsumed on an idle composer. Completing the
    // acknowledged send this way writes nothing new and is not a retry. Pi
    // steers the same write into the running turn, so nothing follows it.
    if (resolved === "devin" && (sentState === "working" || sentState === "blocked")) {
      await flushQueuedOwnPane(paneId);
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
