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

**F3 — one `events.subscribe` per connection.** A second `events.subscribe` on an already
subscribed connection makes the server drop the connection (observed `ECONNRESET`). The
subscription set is therefore fixed for the life of a connection and cannot be extended
per child.

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

- **C1.** The session monitor opens **one** connection with a **fixed global** subscription
  set and multiplexes it across all supervisors (requirement 14). Adding a supervisor never
  resubscribes and never risks the connection.
- **C2.** Supervision anchors on `revision` plus exact agent identity, not on stream
  position, so the unmarked replay boundary (**F5**) needs no heuristic and no quiescence
  timer.
- **C3.** Reconnect is **lossless**: the replay re-delivers everything emitted during the
  outage. Reconnect therefore refolds rather than guesses. A refold that yields transitions
  the supervisor had not already processed proves the sequence advanced, which is exactly
  the `evidence_gap` condition in requirement 7.
- **C4.** Thin events (`pane_closed`, `pane_exited`, `pane_agent_detected`) carry only a
  pane ID, and **F6** makes a pane ID untrustworthy. They are treated as *reconciliation
  triggers*, never as conclusions: the monitor takes a fresh `session.snapshot` and the
  supervisor decides from authoritative state.

## 4. Fixed subscription set

```
pane.created  pane.updated  pane.closed  pane.exited  pane.moved  pane.agent_detected
```

`pane.focused`, `pane.output_matched`, `pane.scroll_changed`, and every workspace/tab/layout
kind are excluded: none of them carries supervision-material information that
`pane.updated` does not already carry, and each would multiply replay volume.

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
following hold, otherwise the supervisor settles `identity_lost` and wakes:

1. the event is atomic — it carries `previous_pane_id` and a complete `pane` record;
2. the event's `pane` record proves `terminal_id` and `agent_session` continuity;
3. a **fresh** `session.snapshot` taken after the event still shows exactly one pane with
   the new `pane_id` whose `terminal_id`, `agent_session`, `agent`, and name match;
4. the snapshot's `revision` is greater than or equal to the last folded revision.

Only then is the bound `paneId` rewritten. Nothing else may rewrite it.

## 7. Anchoring, folding, and gaps

A supervisor stores `anchor = { paneId, revision, stateChangeSeq, status }` captured at
bind, and a bounded ordered `transitions` list.

For each event on the shared stream:

- **not our pane id** → ignored (no work, no reconciliation);
- **`PaneInfo`-bearing and `revision < anchor.revision`** → historical replay, ignored;
- **`PaneInfo`-bearing and `revision >= anchor.revision`** → continuity checked, then
  folded; a status change becomes a transition;
- **thin event** → a coalesced reconciliation (`session.snapshot`) is requested; at most one
  reconciliation per supervisor is in flight, and a request while one is in flight sets a
  re-run flag rather than queueing.

`transitions` is bounded to `SUPERVISION_MAX_TRANSITIONS = 64` with a `truncatedTransitions`
count, matching the repository's bounded-evidence rule.

**Reconnect (requirement 7).** On reconnect the monitor re-runs bootstrap
(`session.snapshot`, then `events.subscribe`, then the replay). Each supervisor then does
exactly two things, and neither of them tries to locate the replay boundary:

- **Gap decision, from the bootstrap snapshot alone.** If the fresh snapshot cannot prove the
  bound occupant is still there, the supervisor settles `identity_lost`. If it can, and the
  pane's `revision` is greater than the last folded revision, the lifecycle sequence advanced
  while the socket was down: exactly one high-priority `evidence_gap` is emitted. If the
  revision is unchanged, the supervisor resumes **silently**. This is a single authoritative
  comparison, not an inference about which replayed events were missed, so it is correct
  whether the retained log can still replay the outage or has scrolled past it.
- **Replay dedupe, by relevant-event index.** The replay is deterministic, so the *n*-th event
  relevant to this supervisor is the same event on every connection. The supervisor replays
  its fold cursor from zero and skips every relevant event at or below the cursor it had
  already reached; everything beyond it is folded, whether it happened during the outage or
  after it.

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
  review, read through the existing `pane read --source recent-unwrapped` path.
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
- **R2 — replay volume.** A long-lived Herdr session replays a large log on every connect
  and reconnect. The monitor parses it under a per-line bound and discards non-matching
  events without allocation beyond the parsed record.
- **R3 — retained-log truncation.** If Herdr's retained log is a ring buffer, a long outage
  can scroll the anchor out. That case is detected in §7 and reported as `evidence_gap`
  rather than assumed benign.
