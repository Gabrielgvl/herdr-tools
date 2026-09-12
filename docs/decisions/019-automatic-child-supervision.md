# ADR-019: Automatic child supervision as a first-class job kind

## Status

Accepted. Extends ADR-002 (detached wait jobs) and ADR-018 (detached-only wait API) with a
second job kind, and removes the "never call Herdr's socket directly" constraint recorded in
`SPEC.md`.

## Date

2026-08-31

## Context

A manager that launches a child agent has, until now, had to decide *afterwards* to watch
it, by issuing an explicit `herdr_wait` against a condition it had to guess in advance. In
practice this produced three failure modes that no amount of manager discipline removed:

1. A launch with no `initialPrompt`, or into an existing pane, was routinely left unwatched
   because the manager had nothing to wait *for* yet.
2. A one-shot wait settles on its first match. A child that completes a work cycle, is
   steered again, and then blocks is invisible after the first settlement.
3. A wait is a *condition*, not a *subject*. It cannot notice that the agent it was
   watching was replaced, released, or moved, because it was never pinned to that agent's
   whole life.

The manager therefore needed a subject-scoped, whole-life watcher that exists from the
moment a child exists and reports material change without being asked.

Two mechanisms were available for observation. The Herdr CLI, already the sole authority for
every tool operation, can only poll. The local Herdr socket exposes `events.subscribe`, a
long-lived lifecycle stream, which is the mechanism Herdr documents for exactly this
purpose. Probing the installed Herdr 0.8.2 (protocol 20) established four facts that
constrain any design built on it:

- `events.subscribe` is acknowledged with `subscription_started` and then streams.
- A connection answers exactly **one** request. A second request on a connection that
  already replied is ignored and the connection closes; a request after `events.subscribe`
  resets it. The subscription set is fixed for a connection's life, and every read is its own
  short-lived connection.
- `pane.agent_status_changed` requires a `pane_id`, so it is unusable on a connection that
  must serve children that do not exist yet. The globally subscribable `pane.updated`
  carries a full `PaneInfo` — including `agent_status`, `agent_session`, `terminal_id`, and
  a monotonic `revision` — and is therefore the authoritative status channel.
- The stream replays the session's durable event log on every subscribe, deterministically,
  with no end-of-replay marker, no sequence number, and no timestamp. Pane IDs are reused
  across the log.

## Decision

**1. Supervision is created by every successful launch, not requested.** `herdr_launch`
reserves a supervisor before any topology mutation and binds it only after the exact launch
identity is proven and, when a prompt was sent, after prompt consumption is confirmed. A
launch that cannot bind a supervisor is not a successful launch: it throws
`SUPERVISION_UNCONFIRMED` as a partial-effect failure carrying child evidence, with no retry
and no cleanup of the child.

**2. A supervisor is a `kind: "supervisor"` job in the existing `JobRegistry`.** It is
listed, inspected, and shut down through the existing `herdr_jobs` tool, and its stable job
ID is returned in the launch result's model-visible content and details. No eighth public
tool is added and supervision is never disguised as a one-shot `herdr_wait`.
`JobRequestSnapshot` becomes a discriminated union on `kind` rather than a wait shape with
supervisor-shaped lies in it, and a supervisor settles into `supervision_result` rather than
into `wait_result`.

**3. One long-lived subscription connection, multiplexed; reads are separate and on
demand.** Because a connection answers one request, the monitor holds one connection that
carries `events.subscribe` and nothing else — `pane.updated`, `pane.closed`, `pane.exited`,
`pane.moved`, `pane.agent_detected` — and fans events out to supervisors by identity. Adding
a supervisor never resubscribes, so it can never drop the connection out from under its
siblings, and a launch whose subscription is already live opens no connection at all. Every
`session.snapshot` is a unary read on its own connection, taken only when something needs
it: a redundant per-launch snapshot was enough to disturb a clientless headless Herdr server
into failing prompt consumption, so reads are strictly on demand.

**4. Anchor on `revision` and exact identity, never on stream position.** The replay has no
boundary marker, so no design may try to find one. A supervisor stores the `revision` its
bind snapshot observed and ignores `PaneInfo`-bearing events below it; everything at or
above it is checked for `terminal_id` and `agent_session` continuity before it is folded.
Thin events that carry only a pane ID are treated as reconciliation triggers — a fresh
`session.snapshot` decides — because pane IDs are reused and a replayed `pane_closed` for a
recycled ID would otherwise settle a live supervisor. The same reasoning governs a
`pane_moved` that does not leave the supervisor's own pane or whose record does not prove its
own occupant: it reconciles rather than concluding. `revision` is also the *whole*
deduplication mechanism, not merely a floor. It is monotonic per pane occupancy and a move is
followed only on proof the occupancy is unchanged, so one watermark stays meaningful across a
move — where a count of routed events would not, and where a position in the retained log
would not either, since that log drops entries from its head.

**5. Reconnect refolds where it can and resynchronises where it cannot.** The replay
re-delivers what the retained log still holds, which is usually everything emitted during the
outage but not always: the log is a ring buffer. So the reconnect snapshot, not the replay, is
the authority. The supervisor refolds every transition above its watermark, and when the
snapshot's revision has advanced past that watermark it emits exactly one high-priority
`evidence_gap` **and adopts the snapshot's status and revision**. Adopting is what makes the
decision correct whether or not the outage is still replayable; reporting the gap alone would
leave supervision reporting a stale status indefinitely. Resuming silently is permitted only
when the snapshot proves nothing advanced. If the socket cannot be reconnected the supervisor
stays **visibly** degraded and retries with bounded backoff. There is no hidden polling
fallback.

**6. A continuously working child is reviewed on cadence by an exact model.** Every
`reviewCadenceMinutes` of continuous `working`, a supervisor-specific reviewer classifies the
child using `openai-codex/gpt-5.6-sol` at `thinking: "max"`. This is a module constant, not
a setting: the explicit `herdr_wait` reviewer keeps its own setting and stays Luna at `low`.
Reviewer results store silently; only `stalled`, `blocked`, `risk`, `appears_complete`, and
`unknown` wake the manager, and the supervisor stays active either way. A reviewer failure
enters one visible degraded episode and retries at the next cadence; the first success after
it notifies recovery once. The reviewer never starts a Herdr agent.

**7. The MCP host gets its own narrow model service instead of the host's registry.**
`hostContext` continues to throw for `context.modelRegistry`. The MCP host instead builds a
host-independent registry/auth service from the installed Pi packages. Its `Models`
instance stores credentials in the Pi agent's `auth.json`
(`$PI_CODING_AGENT_DIR/auth.json`, default `~/.pi/agent/auth.json`) through
`AuthJsonCredentialStore`, a `proper-lockfile`-locked file `CredentialStore`, so the
reviewer shares the Pi host's existing `openai-codex` OAuth login and persists refreshes
back to the same file. Unresolvable model or unavailable auth (including a missing or
malformed `auth.json`) degrades the reviewer visibly; it never selects a substitute model
and never fails the supervisor.

**8. Wake is report-only and best effort.** Pi wakes through the existing `sendMessage`
custom-context path (`deliverAs: "steer"`, `triggerTurn: true`). Claude wakes through the
documented Channels research-preview contract in the same MCP server: the server advertises
`capabilities.experimental["claude/channel"]`, sends `notifications/claude/channel` with
bounded content and meta, and `manager-claude` opts in with the exact local development
channel flags. There is no delivery acknowledgement, no retry, and no prompt injection into
the child or the manager.

**9. Soft receipts replace retries.** Every material event carries an opaque `eventId`.
`herdr_jobs get` returns the pending unobserved events and marks exactly the ones it
returned; `list` and the Pi UI show unobserved counts. Event and reviewer history are bounded
with explicit truncation counts. A dropped notification is recoverable by asking, not by
resending.

**10. Supervisors are session-scoped and cannot be cancelled out from under a live child.**
`herdr_jobs cancel` on a supervisor whose exact child is live is refused with
`SUPERVISION_ACTIVE`. Manager-session shutdown cancels supervisors. Nothing persists across
manager sessions.

## Consequences

- `herdr_launch` gains two phases and one hard new precondition. A host that cannot open the
  Herdr socket can no longer launch at all. This is deliberate: the alternative — launching a
  child nobody is watching — is the failure this record exists to remove.
- `JobRequestSnapshot`, `JobRunResult`, and the job bounding code become kind-aware. Wait
  jobs keep their exact public shape; the union is additive at the type level and breaking at
  the construction site, which is where it should be.
- `SPEC.md`'s prohibition on direct socket use is deleted rather than qualified. The CLI
  remains the sole authority for mutations and for every tool operation; the socket is a
  read-only observation transport owned by one module.
- Supervision adds a long-lived connection and a periodic model call per continuously working
  child. Both are bounded and both are visible in `herdr_jobs`.
- Claude channel delivery is opted into with `--dangerously-load-development-channels
  server:herdr`, using the plugin's own MCP server key. The flag is proven to parse on Claude
  2.1.252, but end-to-end delivery also depends on the organization's `channelsEnabled`
  managed setting, which this repository cannot set or observe. The entry is declarative
  profile data so it can be corrected without a code change, and undelivered wakes cost
  nothing: every event is recoverable through `herdr_jobs get`.

## Alternatives rejected

- **Poll the CLI.** Rejected: it is the hidden fallback requirement 7 forbids, it cannot see
  a transition that begins and ends between polls, and it multiplies CLI load by the number
  of live children.
- **One socket connection per supervisor.** Rejected: it makes replay volume linear in
  supervisor count and gains nothing, because `pane.updated` already carries per-pane status
  and the connection's subscription set cannot be narrowed after the fact anyway.
- **Per-pane `pane.agent_status_changed` subscriptions.** Rejected on evidence: a second
  `events.subscribe` drops the connection, so a per-child subscription would have to
  reconnect the whole session monitor for every launch.
- **Detect the end of replay with a quiescence timer.** Rejected: it is a timing heuristic
  standing in for a correctness property, and it would misclassify a genuinely idle stream as
  the live edge. Revision anchoring makes the boundary irrelevant.
- **An eighth `herdr_supervise` tool.** Rejected: supervision is not a manager decision, so
  giving it a call site would invite managers to skip it.
- **Reuse `wait_result` for supervisors.** Rejected: `condition_met` and `timed_out` are
  false for a subject-scoped watcher with no condition and no deadline.
