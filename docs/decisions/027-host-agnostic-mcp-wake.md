# ADR-027: Host-agnostic MCP wake delivery

## Status

Accepted. Extends ADR-019's wake contract and ADR-023's Claude Channels
decision. `docs/specs/auto-child-supervision.md` §12 is the normative
description.

## Context

Supervision events and settled `herdr_wait` jobs already invoked
`ManagerNotifier.wake`, but the MCP host only knew how to emit the Claude
Channels notification, and `JobRegistry` had no terminal callback at all, so a
settled wait produced no inbound signal. On a Devin- or Pi-hosted manager the
wake was silently inert even though `agent.prompt` delivery to those kinds is
qualified for `herdr_communicate`.

## Decision

`createMcpHostWake` gives the MCP host one `deliver()` that routes by the
hosting pane's own agent kind, resolved lazily with a single `pane get` on the
first wake and cached for the session:

- `devin` / `pi` — self-prompt through `agent.prompt` on the server's own pane
  with the full identity sandwich, using the new provenance kinds
  `supervision` (supervisor events) and `wait` (settled wait jobs). The
  acknowledgement is validated by `parsePromptSubmission`, exactly like a
  `herdr_communicate` send.
- `claude` — the Channels notification only. There is deliberately no prompt
  fallback: targeted prompt delivery to Claude panes is qualified for tool
  calls, but a self-wake is the server prompting its own hosting pane — a
  different boundary the owner chose to keep Channels-only.
- anything else — `agy`, `unknown`, missing, or an unproven own-pane identity
  — is inert. A pane record that proves no `agent_name` drops the wake
  silently; the alternative (prompting an unproven pane) fails closed.

Two deliberate deviations from `herdr_communicate`'s target rules, both
recorded here:

- **Self-target bypass.** The wake's target is always the server's own hosting
  pane. `herdr_communicate`'s self-target refusal is a tool-call policy — it
  stops an agent from prompting itself *as a tool call*. The socket has no
  self-target rule, and this wake is the delivery mechanism itself, so the
  bypass is specific to wake delivery and does not relax the tool's guard.
- **No busy gate.** `working` and `blocked` states still send — the identical
  `agent.prompt` write the communicate `steer` route makes without a busy
  gate. `unknown` or unproven state drops the write entirely.
- **Devin queued-input flush.** Devin's mid-turn prompt semantics are now
  verified against a live capture: a write submitted while the pane is
  `working` or `blocked` lands in the composer's queued input — rendered as
  `○`-prefixed gray envelope rows above the input box, with the box's input
  placeholder switching to the "Press Enter to send queued messages now"
  hint — and that queue does **not** drain when the turn ends (observed live
  as two wake envelopes sitting unconsumed on an idle manager pane until a
  manual Enter; the verbatim capture is pinned at
  `test/fixtures/devin-composer-queued.ansi`). (Pi steers the same write
  into the running turn, so nothing follows it.) After an acknowledged
  busy-state write to a `devin` own pane, the wake pipeline runs a bounded
  flush cycle: `agent wait --until idle --until done` with a timeout
  (`WAKE_QUEUE_FLUSH_WAIT_MS`, 110s) strictly inside the cycle's own abort
  budget (`WAKE_QUEUE_FLUSH_BUDGET_MS`, 120s), which starts only when the
  cycle starts — a cycle queued behind another gets its full budget on
  entry. Each cycle then reads the pane with `--format ansi` and presses
  `enter` only while the rendered composer still proves both halves of the
  contract: queue evidence *inside the composer box* — a `○`-prefixed row
  between its border rules, the word "queued" in the box's section, or the
  all-placeholder input hint, never in scrollback where transcript text
  (including this repository's own spec prose) can say the same words — and
  an input area whose every printable character is placeholder-styled gray,
  so the key can never submit a half-typed draft. The ANSI walk carries SGR
  state across each whole raw line — escapes opened before the `❭` glyph or
  continued onto a wrapped row are honoured — and consumes extended
  foreground/background/underline color payloads (`38`/`48`/`58` with
  `;2;R;G;B` or `;5;N`, in `;`- or `:`-separated form) as units, so their
  components can never be misread as resets or 8-color codes; anything the
  parser cannot prove fails closed to no key. A fresh `pane get` must still
  show `idle`/`done` before every key: on a `blocked` composer Enter could
  answer a pending prompt instead of flushing. Because one Enter drains the
  entire queue, a second press is earned only by an *observed change* — a
  different box interior on the re-read; an identical frame is repaint lag,
  not an un-drained queue — and at most two Enters ever fire, completing
  the acknowledged send, never resending it. Flush cycles serialize on a
  tail: a wake acknowledged while the latest cycle still waits joins its
  drain (its write lands before that cycle's composer reads), and anything
  later appends a fresh cycle that re-reads the composer, so no
  acknowledged write goes unseen. `shutdown()` aborts the session signal
  shared by the whole wake pipeline — identity reads, the `agent.prompt`
  write, and the flush alike — so neither the write nor Enter can fire
  after the server closes. This completes the acknowledged send; nothing is
  re-written and it is not a retry. The Enter is deliberately scoped: it is
  the one narrow exception to ADR-013/024's "no path sends Enter" rule
  (cross-referenced there), safe here because the acknowledgement already
  proved dispatch, the target is the server's own pane, the key is gated on
  a proven composer, and a wrong-time Enter on an empty composer is a
  no-op. ADR-029 extends this exception to acknowledged busy
  `herdr_communicate` deliveries on Devin targets: the machinery described
  here now lives in one coordinator shared by the wake and communicate
  paths, serialized across processes by a pane-write lock and spent-frame
  fence — "own pane" records the original scope, not a standing boundary.
  If the turn outlives the bound, the envelope stays queued and is
  recovered by the next prompt or `herdr_jobs` polling. One honest single
  point of failure: on the live render the in-box queue proof rests on the
  word "queued" inside the all-placeholder hint — if Devin ever rewords or
  re-styles that hint, the flush silently stops firing. That direction is
  fail-closed (wakes stay queued for `herdr_jobs` recovery, never a wrong
  keypress), but it is a render-text coupling, not a protocol guarantee;
  the frozen fixture pins today's render, not tomorrow's.

`JobRegistry.onTerminal` feeds settled `wait`-kind jobs into the same router.
Supervisor settlements are excluded because their lifecycle events already
generate supervision wakes; a second notification would duplicate them.

## Consequences

- Devin- and Pi-hosted managers now receive inbound wakes as provenance
  envelopes with `kind: supervision` or `kind: wait`, closing the gap where
  MCP-hosted supervision was report-only with no inbound path.
- `herdr_jobs` polling remains the recovery contract on every host: every
  delivery failure — kind resolution, context resolution, identity proof, the
  prompt write, the acknowledgement — is swallowed, and a missed wake is
  recovered by polling pending unobserved events.
- Lazy resolution keeps startup side-effect-free: no host read happens before
  the first wake, a failed `pane get` is retried by the next wake rather than
  permanently disabling delivery, and one shared in-flight promise means a
  burst of wakes pays exactly one read.
- The send is one-shot and fire-and-forget; there is no retry, escalation, or
  durable queue for a dropped wake, by design.
