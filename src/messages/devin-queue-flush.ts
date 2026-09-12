/**
 * Bounded Devin composer queue flush shared by every package sender.
 *
 * Devin's composer holds input submitted mid-turn in a queue that does not
 * drain when the turn ends — it flushes only on an explicit Enter. Any sender
 * whose acknowledged write lands on a working/blocked Devin pane therefore
 * needs the same completion step the own-pane wake path originally grew: wait
 * out the turn, prove the rendered composer still shows queued input above an
 * all-placeholder input line under the exact acknowledged identity, then send
 * one Enter. This module owns that whole contract: the ANSI composer parser,
 * the bounded/coalesced per-pane cycles, and the cross-process lock + spent
 * fence that keep two hosts from pressing the same frame.
 *
 * Safety boundary (approved observed-composer contract): the proof is a
 * rendered screenshot, not a composer-state primitive. A human's half-typed
 * draft landing between the last proof and the dispatched key is a residual
 * TOCTOU this package cannot close — the lock only serializes participating
 * processes, never humans or raw `herdr` CLI clients. Every missed or refused
 * condition means no key; recovery is a human re-send, never a blind Enter.
 */

import { createHash } from "node:crypto";
import type { CliTextResult, JsonEnvelope } from "../cli.js";
import { PANE_WRITE_LOCK_WAIT_MS, type PaneWriteGuard, type PaneWriteLease } from "../pane-write-lock.js";
import { requirePromptTargetIdentity, samePromptTargetIdentity, type PromptSubmissionEvidence, type PromptTargetIdentity } from "./prompt.js";
import { agentFrom, paneFrom, stateOf, type CommunicateState } from "./prompt-target.js";

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

export interface DevinComposer {
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
export function devinComposer(view: string): DevinComposer | undefined {
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

/**
 * A flush cycle is bounded overall, and the in-flight-turn wait inside it is
 * strictly shorter so the post-wait reads and key retain signal budget.
 */
export const DEVIN_QUEUE_FLUSH_BUDGET_MS = 120_000;
export const DEVIN_QUEUE_FLUSH_WAIT_MS = 110_000;
/** A marker still rendered after a press is drained once more — completing the send, never resending it. */
export const DEVIN_QUEUE_FLUSH_MAX_PRESSES = 2;

/** The narrow CLI surface a flush cycle needs — `HerdrCli` satisfies it. */
export interface DevinQueueFlushCli {
  runJson(argv: string[], signal: AbortSignal): Promise<JsonEnvelope>;
  runTextResult(argv: string[], signal: AbortSignal): Promise<CliTextResult>;
}

export interface DevinQueueFlushRequest {
  /** The exact acknowledged prompt submission — the identity the flush binds to. */
  submission: PromptSubmissionEvidence;
  /** The last verified pre-send state, never a post-send observation. */
  sentState: CommunicateState;
}

export interface DevinQueueFlushDeps {
  cli: DevinQueueFlushCli;
  guard: PaneWriteGuard;
  /** Bound on acquiring a pane's write section; defaults to the shared wait. */
  sectionWaitMs?: number;
}

/**
 * The host's one Devin queue-flush coordinator. `begin` arms a session (and
 * cancels whatever an earlier session still had pending); `shutdown` aborts
 * the session's cycles before transports close; `schedule` is best effort and
 * never throws; `writeSection` is the shared short lock every participating
 * Devin text write must pass through.
 */
export interface DevinQueueFlush {
  begin(): void;
  shutdown(): Promise<void>;
  schedule(request: DevinQueueFlushRequest): void;
  writeSection(paneId: string): Promise<PaneWriteLease>;
}

/** Eligibility is exactly a Devin-kind ack written while the target was verified busy. */
export function queueFlushEligible(submission: PromptSubmissionEvidence, sentState: CommunicateState): boolean {
  return submission.agentKind === "devin" && (sentState === "working" || sentState === "blocked");
}

function digestOf(fields: readonly string[]): string {
  const hash = createHash("sha256");
  for (const field of fields) hash.update(field).update("\0");
  return hash.digest("hex");
}

/** The fence binds a spent frame to the whole prompt-target identity, not just the pane. */
export function devinFlushIdentityDigest(identity: PromptTargetIdentity): string {
  return digestOf([
    identity.paneId,
    identity.terminalId,
    identity.agentName,
    identity.agentKind,
    identity.agentSession.source,
    identity.agentSession.agent,
    identity.agentSession.kind,
    identity.agentSession.value,
  ]);
}

export function devinFlushFrameDigest(interior: string): string {
  return digestOf([interior]);
}

export function createDevinQueueFlush(deps: DevinQueueFlushDeps): DevinQueueFlush {
  interface FlushSession {
    controller: AbortController;
    panes: Map<string, PaneFlush>;
  }
  interface PaneFlush {
    /** Serializes this pane's cycles; never stays rejected. */
    tail: Promise<void>;
    /** The running cycle still inside `agent wait` — new acks join it. */
    waiting?: FlushCycle;
    /** The one follow-up cycle chained behind the running cycle. */
    pending?: FlushCycle;
  }
  interface FlushCycle {
    session: FlushSession;
    /** The latest ack bound to this cycle; coalesced sends refresh it. */
    submission: PromptSubmissionEvidence;
  }
  let session: FlushSession | undefined;

  const readComposer = async (paneId: string, signal: AbortSignal): Promise<DevinComposer | undefined> => {
    const result = await deps.cli.runTextResult(["pane", "read", paneId, "--source", "visible", "--format", "ansi"], signal);
    // A truncated frame can hide a draft or a queue marker: refuse, never guess.
    return result.truncated ? undefined : devinComposer(result.value);
  };

  /**
   * One locked proof/key section. Per the approved order, every candidate key
   * is gated by a fresh same-occupant identity join and a fresh idle/done
   * state taken *after* the candidate composer read, then by a final ANSI
   * proof that must equal the candidate frame. Resolves to the spent interior
   * on a dispatch so the next press can detect repaint lag; undefined means
   * "stop — no more keys this cycle".
   */
  const pressOnce = async (paneId: string, cycle: FlushCycle, lastInterior: string | undefined, signal: AbortSignal): Promise<string | undefined> => {
    const lease = await deps.guard.acquire(paneId, { waitMs: deps.sectionWaitMs ?? PANE_WRITE_LOCK_WAIT_MS });
    try {
      const candidate = await readComposer(paneId, signal);
      if (candidate === undefined || !candidate.inputEmpty) return undefined;
      // Fresh same-occupant join — the acknowledged identity must still be the
      // occupant. A missing fresh field never borrows from the ack: the join
      // itself throws and the cycle drops.
      const agent = agentFrom((await deps.cli.runJson(["agent", "get", paneId], signal)).result);
      const pane = paneFrom((await deps.cli.runJson(["pane", "get", paneId], signal)).result, paneId);
      const fresh = requirePromptTargetIdentity([agent, pane], paneId);
      if (!samePromptTargetIdentity(fresh, cycle.submission)) return undefined;
      const state = stateOf(pane);
      if (state !== "idle" && state !== "done") return undefined;
      const bound = devinFlushIdentityDigest(fresh);
      if (!candidate.queued) {
        // A fresh identity-bound, positively parsed, non-queued composer is the
        // only thing allowed to rearm the fence — never elapsed time, a new
        // ack, a parse failure, or a missing record.
        await lease.fence.rearm(bound);
        return undefined;
      }
      // An interior identical to the frame this cycle just pressed is repaint
      // lag, not a surviving queue — only a changed frame earns another key.
      if (lastInterior !== undefined && candidate.interior === lastInterior) return undefined;
      const final = await readComposer(paneId, signal);
      if (final === undefined || !final.queued || !final.inputEmpty || final.interior !== candidate.interior) return undefined;
      const frame = devinFlushFrameDigest(final.interior);
      if (await lease.fence.isSpent(bound, frame)) return undefined;
      if (signal.aborted) return undefined;
      await lease.check();
      // Record the spent frame BEFORE dispatch: a crashed or uncertain send
      // must never invite a retry of the same frame in this or another host.
      await lease.fence.record(bound, frame);
      await deps.cli.runJson(["agent", "send-keys", paneId, "enter"], signal);
      return final.interior;
    } finally {
      await lease.release();
    }
  };

  const runCycle = async (paneId: string, pane: PaneFlush, cycle: FlushCycle): Promise<void> => {
    /* c8 ignore next -- the tail chain serializes cycles per pane, so pending can only name this cycle here; the guard pins the scheduler invariant rather than a reachable race. */
    if (pane.pending === cycle) pane.pending = undefined;
    pane.waiting = cycle;
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(), DEVIN_QUEUE_FLUSH_BUDGET_MS);
    const signal = AbortSignal.any([cycle.session.controller.signal, budget.signal]);
    try {
      try {
        await deps.cli.runJson(["agent", "wait", paneId, "--until", "idle", "--until", "done", "--timeout", String(DEVIN_QUEUE_FLUSH_WAIT_MS)], signal);
      } finally {
        // Only this cycle may clear its own join flag; an older cycle must not
        // clear a newer cycle's.
        /* c8 ignore next -- cycles are serialized by the pane tail, so waiting can only name this cycle here; the guard pins the scheduler invariant rather than a reachable race. */
        if (pane.waiting === cycle) pane.waiting = undefined;
      }
      if (signal.aborted) return;
      let lastInterior: string | undefined;
      for (let press = 0; press < DEVIN_QUEUE_FLUSH_MAX_PRESSES; press += 1) {
        const interior = await pressOnce(paneId, cycle, lastInterior, signal);
        if (interior === undefined) return;
        lastInterior = interior;
      }
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    begin() {
      const previous = session;
      const controller = new AbortController();
      session = { controller, panes: new Map() };
      previous?.controller.abort();
    },
    async shutdown() {
      const ending = session;
      if (ending === undefined) return;
      session = undefined;
      ending.controller.abort();
      // Already-dispatched PTY bytes cannot be recalled; awaiting the tails
      // guarantees only that no NEW operation is dispatched after abort.
      await Promise.all([...ending.panes.values()].map((pane) => pane.tail));
    },
    schedule(request) {
      if (!queueFlushEligible(request.submission, request.sentState)) return;
      const current = session;
      /* c8 ignore next -- the installed session's controller is always live: begin() installs a fresh controller and shutdown() clears the slot before aborting. */
      if (current === undefined || current.controller.signal.aborted) return;
      const paneId = request.submission.paneId;
      let pane = current.panes.get(paneId);
      if (pane === undefined) {
        pane = { tail: Promise.resolve() };
        current.panes.set(paneId, pane);
      }
      const entry = pane;
      // An ack landing while the running cycle still waits rides that drain —
      // its write lands before that cycle's composer reads — while an ack
      // landing during the drain chains exactly one follow-up cycle, which any
      // later burst coalesces into. The queue never grows a third entry.
      if (entry.waiting !== undefined) { entry.waiting.submission = request.submission; return; }
      if (entry.pending !== undefined) { entry.pending.submission = request.submission; return; }
      const cycle: FlushCycle = { session: current, submission: request.submission };
      entry.pending = cycle;
      const run = entry.tail.then(() => runCycle(paneId, entry, cycle));
      const tail = run.catch(() => undefined);
      entry.tail = tail;
      void tail.then(() => {
        // Retire the entry only while nothing newer chained behind this tail.
        if (entry.tail === tail) current.panes.delete(paneId);
      });
    },
    writeSection(paneId) {
      return deps.guard.acquire(paneId, { waitMs: deps.sectionWaitMs ?? PANE_WRITE_LOCK_WAIT_MS });
    },
  };
}
