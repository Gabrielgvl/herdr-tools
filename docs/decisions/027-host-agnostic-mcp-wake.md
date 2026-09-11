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
  gate. Devin's mid-turn prompt semantics are unverified; the wake may land as
  queued input rather than an interruption. `unknown` or unproven state drops
  the write entirely.

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
