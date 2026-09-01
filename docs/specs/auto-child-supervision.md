# Implementation spec: automatic child supervision

**Status:** Accepted contract. Implemented on `feature/auto-child-supervision`.

**Related decision record:** `docs/decisions/019-automatic-child-supervision.md`.

## 1. Objective

Every successful `herdr_launch` now produces a live, first-class **supervisor** that watches
the exact child agent it launched for the whole life of that child, wakes the launching
manager on material events only, and reports. Supervision is observation and notification.
It never mutates the child, never gates the child's work, and never becomes an eighth
public tool.

The seven public tools are unchanged: `herdr_inspect`, `herdr_communicate`, `herdr_wait`,
`herdr_jobs`, `herdr_launch`, `herdr_pane`, `herdr_tab`.

## 2. Protocol facts this design is built on

These were established against the installed Herdr 0.8.2 (`herdr api schema --json`,
protocol 20) and by probing the live local socket. They are load-bearing; a future Herdr
that breaks them breaks supervision loudly rather than silently.

**F1 — transport.** The socket at `HERDR_SOCKET_PATH` speaks newline-delimited JSON.
A request is `{"id":"<string>","method":"<string>","params":{...}}`. A success reply is
`{"id","result"}`; a failure reply is `{"id","error":{"code","message"}}`. Pushed events
are `{"event":"<EventKind>","data":{...,"type":"<EventKind>"}}` and carry **no** `id`.

**F2 — `events.subscribe` is acknowledged, then streams.** The reply is
`{"type":"subscription_started"}`. Only after that acknowledgement may pushed events be
accepted.

**F3 — one request per connection.** A connection answers its first request and nothing
else: a second request on a connection that already replied is ignored and the connection
closes, and a request issued after `events.subscribe` resets it (`ECONNRESET`). This was
established against a live named server; the earlier reading — that only a second
`events.subscribe` was refused — was too narrow. Two consequences: the subscription set is
fixed for the life of a connection and cannot be extended per child, and every
`session.snapshot` is a unary read on its own short-lived connection.

**F4 — `pane.agent_status_changed` requires a `pane_id`.** Because of **F3** it cannot be
used by a session-level connection that must serve children discovered later. The globally
subscribable `pane.updated` carries a full `PaneInfo` — `pane_id`, `tab_id`,
`workspace_id`, `terminal_id`, `agent`, `agent_session`, `agent_status`, `revision`,
`label` — so it is the authoritative status channel for supervision.

**F5 — the event stream replays a durable historical log.** On subscribe the server
replays the session's whole retained event log before tailing live, and the replay is
deterministic: two connections made seconds apart replay the identical prefix. There is no
end-of-replay marker and no per-event sequence number or timestamp.

**F6 — pane IDs are reused.** A `pane_closed` for `w6:pT` appears in the replay while a
different, live agent currently occupies a pane also called `w6:pT`. A pane ID alone can
never identify a child.

**F7 — `revision` is monotonic per pane occupancy** and is present on every
`PaneInfo`-bearing event (`pane_created`, `pane_updated`, `pane_moved`).

## 3. Consequences of the protocol facts

- **C1.** The session monitor holds **one** long-lived connection carrying a **fixed global**
  subscription and nothing else, multiplexed across all supervisors (requirement 14). Adding
  a supervisor never resubscribes and never risks the connection. Reads are separate,
  short-lived connections, and a launch whose subscription is already live opens none: a
  redundant per-launch snapshot measurably disturbed the observed session.
- **C2.** Supervision anchors on `revision` plus exact agent identity, not on stream
  position, so the unmarked replay boundary (**F5**) needs no heuristic and no quiescence
  timer.
- **C3.** Reconnect refolds rather than guesses, but the replay is **not** unconditionally
  lossless: the retained log is a ring buffer and can drop entries from its head (**R3**), so an
  old-enough outage is no longer replayable. The reconnect `session.snapshot` is therefore the
  authority, and the supervisor both reports the gap and adopts the state that snapshot
  proves. This is the `evidence_gap` condition in requirement 7, and it is correct whether or
  not the outage is still in the log.
- **C4.** Thin events (`pane_closed`, `pane_exited`, `pane_agent_detected`) carry only a
  pane ID, and **F6** makes a pane ID untrustworthy. They are treated as *reconciliation
  triggers*, never as conclusions: the monitor takes a fresh `session.snapshot` and the
  supervisor decides from authoritative state.
- **C5.** Every accepted event is validated on its own fields at the protocol boundary, not
  merely proven to be an object. A known kind that is malformed is refused — dropping the
  connection, which the monitor reports and reconnects from — rather than accepted and
  routed to no observer, which would lose lifecycle evidence silently. A `pane_moved` that is
  not atomic is a protocol violation, not an unproven move, so it never reaches a supervisor.
- **C6.** The subscription acknowledgement is validated and takes effect inside the socket's
  ingest loop, because the transport may deliver it and the first replay event in one chunk.
  For the same reason the monitor installs its event and close handlers **before** it issues
  `events.subscribe`: a handler installed after the acknowledgement resolved would drop the
  head of the replay into an undefined callback, silently. The monitor never adopts a socket
  that closed before adoption, and never adopts one at all if the session stopped while the
  bootstrap was still awaiting.
- **C7.** Events reach observers through one ordered chain. Without it, a thin event awaiting
  its reconciliation snapshot could be overtaken by a later full update and then revert the
  status that update had already applied. Every observer call on that chain — routing,
  folding, bootstrap, degradation, recovery — is isolated per observer, wrapping the call
  rather than its returned promise so a failure thrown before the first await is caught too.
  A supervisor that fails must not deprive its siblings of an event they could never be given
  again. Both chain units are therefore total, so the chain itself carries no blanket catch:
  swallowing a monitor defect silently is the failure mode this rule exists to remove.

## 4. Fixed subscription set

```
pane.updated  pane.closed  pane.exited  pane.moved  pane.agent_detected
```

`pane.created` is excluded because a supervisor binds to a pane that already exists, so a
creation event for it can only be historical. `pane.focused`, `pane.output_matched`,
`pane.scroll_changed`, and every workspace/tab/layout kind are excluded: none carries
supervision-material information that `pane.updated` does not already carry, and each would
multiply replay volume.

## 5. Module layout

```
src/supervision/
  protocol.ts    strict validation of every untrusted server JSON value
  socket.ts      HerdrEventSocket: NDJSON client, request/reply + event stream
  monitor.ts     SessionEventMonitor: one connection, bootstrap, reconnect, fan-out
  identity.ts    exact child identity, continuity, and move-continuity rules
  events.ts      transition folding, material-wake classification, opaque event IDs
  reviewer.ts    supervisor reviewer (gpt-5.6-luna, thinking=max) + model service seam
  notify.ts      ManagerNotifier: Pi sendMessage and Claude Channel implementations
  supervisor.ts  one child's state machine, cadence, degradation, receipts
  registry.ts    SupervisionRegistry: reserve → bind → settle, job ownership
  model-service.ts host-independent model registry/auth service for the MCP host
```

## 6. Identity and continuity

The exact child is pinned by `SupervisedIdentity`, reusing the repository's existing
identity discipline (`src/wait-target-evidence.ts`):

```ts
interface SupervisedIdentity {
  paneId: string;
  terminalId: string;
  agentName: string;
  agentKind: string;                 // "pi" | "claude" as launched
  agentSession: { source: string; agent: string; kind: string; value: string };
}
```

Continuity holds for an observed `PaneInfo` when **every** supplied identity field equals
the bound value. A field the server omits is not evidence of change; a field it supplies
with a different value is. `agent_session` is compared on all four components.

**Move (requirement 6).** A `pane_moved` event is followed only when *all* of the
following hold:

1. the event is atomic — it carries `previous_pane_id` and a complete `pane` record;
2. `previous_pane_id` is the pane this supervisor is currently bound to;
3. the event's `pane` record proves `terminal_id` and `agent_session` continuity;
4. a **fresh** `session.snapshot` taken after the event still shows exactly one pane with
   the new `pane_id` whose `terminal_id`, `agent_session`, `agent`, and name match;
5. the snapshot's `revision` is greater than or equal to the last folded revision.

Only then is the bound `paneId` rewritten. Nothing else may rewrite it.

Failing **2** or **3** is not a lost identity and does not settle. The monitor routes a move
by its destination as well as its origin, and **F6** makes pane IDs reusable, so such an
event is either a replay of a move this supervisor already followed or a *different*
occupant's move out of a recycled ID. Concluding `identity_lost` from either would settle a
live supervisor on somebody else's evidence, so both are treated as reconciliation triggers
(**C4**) and authoritative state decides. Only a move that is provably this occupant's but
whose destination cannot be confirmed — failing **4** or **5** — settles `identity_lost` and
wakes.

## 7. Anchoring, folding, and gaps

A supervisor stores `anchor = { paneId, revision, stateChangeSeq, status }` captured at
bind, and a bounded ordered `transitions` list.

It also stores `lastRevision`, the highest pane `revision` it has folded, initialised from
the bind snapshot.

For each event on the shared stream:

- **not our pane id** → ignored (no work, no reconciliation);
- **`PaneInfo`-bearing and `revision < lastRevision`** → already reflected here, ignored;
- **`PaneInfo`-bearing and `revision >= lastRevision`** → continuity checked, then folded; a
  status change becomes a transition;
- **thin event** → a coalesced reconciliation (`session.snapshot`) is requested; at most one
  reconciliation per supervisor is in flight, and a request while one is in flight sets a
  re-run flag rather than queueing.

Deduplication is `lastRevision` and nothing else. No stream position is used, because
**F5**'s retained log drops entries from its head: after truncation the same position names a
different entry, so a supervisor keyed on position would skip transitions it had never seen.
No count of routed events is used either, because a proven move rewrites the routing key.
`revision` has neither problem. It is monotonic per pane *occupancy* (**F7**), and a move is
followed only on proof that the occupancy is unchanged, so the one watermark keeps meaning
across a move: this is why a replayed move is discarded on its own revision without costing a
snapshot, and why the destination's revision is comparable with the origin's.

Events that arrive between adding the observer and proving the anchor are queued and then
folded in arrival order against that same watermark, so a queued event advances it exactly as
a live one does. A supervisor added to a monitor that has already replayed history therefore
needs no cursor of its own: its bind revision discards everything before it.

`transitions` is bounded to `SUPERVISION_MAX_TRANSITIONS = 64` with a `truncatedTransitions`
count, matching the repository's bounded-evidence rule.

**Reconnect (requirement 7).** On reconnect the monitor re-runs bootstrap
(`session.snapshot`, then `events.subscribe`, then the replay). Each supervisor then does
exactly two things, and neither of them tries to locate the replay boundary:

- **Gap decision and resynchronisation, from the bootstrap snapshot alone.** If the fresh
  snapshot cannot prove the bound occupant is still there, the supervisor settles
  `identity_lost`. If it can, and the pane's `revision` is greater than `lastRevision`, the
  lifecycle sequence advanced while the socket was down: exactly one high-priority
  `evidence_gap` is emitted, **and the snapshot's own status and revision are adopted**. The
  individual outage transitions are not always recoverable — the retained log may have
  scrolled past them — so reporting the gap without adopting the state it proves would leave
  supervision reporting a stale status indefinitely. If the revision is unchanged, the
  supervisor resumes **silently**. This is a single authoritative comparison, not an
  inference about which replayed events were missed.
- **Replay dedupe, by the adopted revision.** The snapshot's revision is the new watermark,
  so the replay contributes only what that authoritative state does not already cover:
  everything at or below it is history, and everything above it is folded whether it happened
  during the outage or after it. This holds across a pane move for the reason given above.

If reconnect is not available the supervisor is **visibly degraded** — job progress records
it, one `monitor_degraded` wake is emitted, and reconnection is retried with bounded
exponential backoff (250 ms → 8 s, full jitter). There is no polling fallback of any kind.

## 8. Material events

Recorded silently (every exact-child transition is recorded, requirement 5):
`working` starts, output revisions, pane focus, and every folded status change.

Material wakes, each with an opaque `eventId`:

| kind | trigger | priority |
| --- | --- | --- |
| `work_cycle_completed` | `working` → `idle` or `done` | normal |
| `blocked` | any → `blocked` | high |
| `reviewer_attention` | reviewer says `stalled`/`blocked`/`risk`/`appears_complete`/`unknown` | high |
| `reviewer_degraded` | reviewer call failed, first failure of a degraded episode | normal |
| `reviewer_recovered` | first success after a degraded episode | normal |
| `identity_replaced` | continuity broken with a live replacement occupant | high |
| `identity_lost` | continuity broken with no provable occupant | high |
| `released` | agent released / `pane_exited` confirmed by snapshot | normal |
| `pane_closed` | pane absent from a fresh snapshot | normal |
| `monitor_degraded` / `monitor_recovered` | socket unavailable / restored | normal |
| `evidence_gap` | see §7 | high |

`identity_replaced`, `identity_lost`, `released`, and `pane_closed` are **settling**: the
supervisor job settles immediately after the wake.

## 9. Supervisor reviewer (requirement 8)

- Cadence: `settings.wait.reviewCadenceMinutes` (default 5), measured from the start of a
  **continuous** `working` run. Any transition out of `working` resets the timer.
- Model: exactly `openai-codex/gpt-5.6-luna`, `thinkingLevel: "max"`. This is a module
  constant, not a setting: the setting `wait.reviewerModel` continues to govern the
  explicit `herdr_wait` reviewer, which stays Luna at `low`.
- Evidence: bounded compact pane metadata plus the transcript delta since the previous
  **completed** review, read through the existing `pane read --source recent-unwrapped` path.
  A pane read returns the latest window rather than what changed, so the delta is computed
  against the window the previous review consumed, using the same rule the explicit wait
  reviewer uses (`src/transcript-delta.ts`). Handing the whole window back each cadence would
  let a stalled child keep reading as fresh progress.
- A review is only evidence about the run it was started for. If the child leaves `working`
  while the transcript read or the model call is in flight, the review is abandoned: nothing
  is stored, nothing is announced, and the transcript cursor does not advance over lines no
  review consumed.
- The prompt is bounded in UTF-8 bytes, never split mid-code-point.
- Result storage is silent (job progress). Only `stalled`, `blocked`, `risk`,
  `appears_complete`, and `unknown` wake the manager, and the supervisor stays active.
- A reviewer failure enters a degraded episode: one `reviewer_degraded` wake, then retry at
  the next cadence. The first success afterwards emits one `reviewer_recovered` wake.
- The reviewer never starts a Herdr agent and never creates a pane.
- Reviews are bounded to `SUPERVISION_MAX_REVIEWS = 24` with a `truncatedReviews` count.

**Model service.** The reviewer resolves its model through a narrow
`SupervisionModelService` seam:

- **Pi host** — adapts the host's existing `ModelRegistrySeam` (`ctx.modelRegistry`).
- **MCP host** — `createBuiltinModelService()` builds a host-independent service from the
  installed Pi packages (`builtinModels()` from `@earendil-works/pi-ai/providers/all`,
  `getAuth()` for credentials). The MCP host never exposes `context.modelRegistry`, and the
  `hostContext` proxy keeps throwing for it.

Unresolvable model or unavailable auth is a reviewer failure (degraded episode), never a
supervisor failure and never a substitute model.

## 10. Job model (requirement 3)

`JobRequestSnapshot` becomes a discriminated union on `kind`:

```ts
type JobRequestSnapshot = WaitJobRequestSnapshot | SupervisorJobRequestSnapshot;
```

`WaitJobRequestSnapshot` is the existing shape plus `kind: "wait"`.
`SupervisorJobRequestSnapshot` carries `kind: "supervisor"`, `label`, `targets`
(`[agentName]`), `targetIds` (`[paneId]`), `target_generation_refs`, a bounded `child`
descriptor, and `settings` with `reviewerThinking: "max"`.

`JobDetail` gains:

- `kind: JobKind` (mirrors `request.kind`);
- `supervision_result?: "released" | "identity_lost" | "failed" | "cancelled" | "unknown"`
  — the supervisor terminal field. `wait_result` remains wait-only and is never populated
  for a supervisor job;
- `supervision?: { child, state, monitor, reviewer, events, truncation }` — the bounded
  supervision view;
- `pending_events?: SupervisionEventView[]` — soft receipts, `herdr_jobs get` only;
- `unobservedEvents?: number` — on both detail and summary.

`herdr_jobs` gains an optional `kind` filter on `list`. No new operation and no new tool.

**Cancellation refusal (requirements 2 and 13).** `herdr_jobs cancel` on a supervisor job
whose exact child is still live throws `SUPERVISION_ACTIVE`. Manager-session shutdown
(`session_shutdown`, MCP shutdown, `beginSession`) cancels supervisors unconditionally.
Exact-child termination settles the supervisor by itself.

**Soft receipts (requirement 12).** Every material event carries an opaque `eventId`.
`herdr_jobs get` returns at most `SUPERVISION_MAX_RETURNED_EVENTS = 16` unobserved events,
oldest first, and marks **exactly those** observed. `list` and the Pi wait-jobs UI show
unobserved counts. Event history is bounded to `SUPERVISION_MAX_EVENTS = 48` with a
`truncatedEvents` count. There are no notification retries.

## 11. Launch integration (requirements 1 and 4)

`LaunchDependencies.supervision` is **required**. Two new phases join `LaunchDetails.phase`:

1. `supervision_reserve` — runs **before any topology mutation**, immediately after the
   pre-flight/profile/attachment block. It ensures the session monitor is connected,
   bootstrapped, and subscribed, and registers the supervisor job in `accepted`, returning a
   stable job ID. A failure here is an ordinary early failure with `effectCertainty:
   "absent"` and code `SUPERVISION_UNAVAILABLE`.
2. `supervision_bind` — runs **after** readiness has proven the exact launch identity and,
   when an `initialPrompt` was sent, after prompt consumption is confirmed. Binding requires
   a fresh `session.snapshot` that shows exactly one pane carrying the launched identity, an
   agent record matching it, and a `revision`/`state_change_seq` anchor. If binding cannot be
   proven the launch throws `SUPERVISION_UNCONFIRMED` as a **partial-effect** failure with
   child evidence. There is no retry and no cleanup of the child.

Profile fallback stays strictly inside `agent_start`, before assignment and before binding,
so the fallback chain is unchanged.

On any launch failure between reserve and bind the reservation is released and its job
settles (`supervision_result: "failed"`, reason naming the launch phase). Releasing a
reservation is not child cleanup.

On success `LaunchDetails.supervision = { jobId, state: "active", child, monitor }` and the
model-visible content line names the job ID:

```
launch success · <paneId> · supervisor <jobId>
```

## 12. Manager wake delivery (requirements 9, 10, 11)

Delivery is **wake/report only**, best effort, never a gate, never retried.

- **Pi** — the existing `pi.sendMessage({ customType: "herdr-supervision", content, display,
  details }, { deliverAs: "steer", triggerTurn: true })` path.
- **Claude** — the documented Claude Code Channels research preview inside the *same* MCP
  server: the server advertises `capabilities.experimental["claude/channel"] = {}` and sends
  `notifications/claude/channel` with bounded `content` and `meta`. There is no delivery
  acknowledgement and no Herdr agent prompt injection.

`manager-claude` opts in locally with the documented development-channel flag, using the
plugin's own MCP server key:

```
--dangerously-load-development-channels server:herdr
```

The flag is hidden from `claude --help` in 2.1.252 but is a real root-command option, and
`--channels` is proven to require a tagged `server:<name>` or `plugin:<name>@<marketplace>`
entry. The entry is declared in the profile as `runtime.developmentChannels` rather than
hard-coded in the adapter, and it is validated as a tagged entry at profile-parse time, so a
different install can correct it without a code change. It is profile-only: a launch override
must not be able to open an inbound channel the profile did not declare. See §16.

## 13. Settings

No new settings file keys. `wait.reviewCadenceMinutes` is shared by the explicit wait
reviewer and the supervisor reviewer, and `wait.reviewerModel` remains wait-only.

## 14. Error taxonomy additions

| code | meaning | effect |
| --- | --- | --- |
| `SUPERVISION_UNAVAILABLE` | supervision could not be reserved | launch refused, `absent` |
| `SUPERVISION_UNCONFIRMED` | child exists, binding unproven | launch partial, no cleanup |
| `SUPERVISION_ACTIVE` | cancel refused while the exact child is live | `herdr_jobs` refusal |
| `SUPERVISION_SOCKET_UNAVAILABLE` | `HERDR_SOCKET_PATH` missing/unusable | reserve fails |
| `SUPERVISION_PROTOCOL_ERROR` | server JSON failed strict validation | connection dropped |

## 15. Removed assumptions

`SPEC.md` previously stated that the extension "must not … call Herdr's socket directly".
That assumption is removed, not layered over: the socket is now the supervision monitor's
only transport, and the CLI remains the only authority for mutations and for every tool
operation. No compatibility shim preserves the old wording.

## 16. Known risks

- **R1 — channel delivery.** `--dangerously-load-development-channels` is proven to exist
  and to parse on Claude 2.1.252, and the entry `server:herdr` matches the plugin's own MCP
  server key. End-to-end channel delivery is **not** proven here: it additionally requires the
  organization's `channelsEnabled` managed setting, which this repository can neither set nor
  observe. Mitigation: the entry is declarative profile data, delivery is best effort by
  contract, soft receipts make every event recoverable through `herdr_jobs get`, and Pi
  delivery is unaffected.
- **R2 — replay volume and observer load.** A long-lived Herdr session replays a large log
  on every connect and reconnect, and `pane.updated` fires on output changes for every pane
  in the session. The monitor parses each line under a per-line bound and discards
  non-matching events immediately, but the parse itself is unavoidable. A manager observing
  a very busy session pays for it. This is measurable: a redundant per-launch snapshot
  connection was enough to disturb a clientless headless Herdr server badly enough to break
  prompt consumption in the disposable integration session, which is why reads are now
  strictly on demand.
- **R3 — retained-log truncation.** If Herdr's retained log is a ring buffer, a long outage
  can scroll the anchor out. That case is detected in §7 from the reconnect snapshot alone,
  reported as `evidence_gap` rather than assumed benign, and resynchronised from that
  snapshot's own status and revision. What is *not* recoverable is the individual transitions
  inside the scrolled window: the child's exact path through the outage is lost, only its
  endpoint is known, and the gap event is what says so. This is also why no stream position is
  used for deduplication — after truncation, position *n* names a different entry.
