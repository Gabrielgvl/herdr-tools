# Implementation spec: automatic child supervision

**Status:** Accepted contract. Implemented on `feature/auto-child-supervision`.

**Related decision record:** `docs/decisions/019-automatic-child-supervision.md`.

## 1. Objective

Every successful `herdr_launch` now produces a live, first-class **supervisor** that watches
the exact child agent it launched for the whole life of that child, binding as soon as the
exact launch identity is proven, before optional focus or assignment. Assignment
confirmation remains a separate launch-success gate. If assignment consumption is not
proven, launch fails while retaining the active supervisor so the child remains observable.
Supervision remains an internal service, not an eighth public tool. It observes the raw
child lifecycle and, for Tools-managed handoff runs, may withhold completion acceptance
and send one identity-bound repair prompt. It does not veto Herdr core state transitions.

The seven public tools are unchanged: `herdr_inspect`, `herdr_communicate`, `herdr_wait`,
`herdr_jobs`, `herdr_launch`, `herdr_pane`, `herdr_tab`.

## 2. Protocol facts this design is built on

These were established against the installed Herdr 0.8.2 (`herdr api schema --json`,
protocol 22) and by probing the live local socket. They are load-bearing; a future Herdr
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

**F8 — `state_change_seq` is an optional authoritative lifecycle counter.** An exact
occupant may advance it while `revision` stays constant. Tools keeps one monotonic lifecycle
watermark from the bind anchor through full-pane events, authoritative snapshots, AGY
strengthening, and proven pane moves. A same-revision status change is gap-free only when the
exact occupant supplies a strictly advanced sequence. Missing, unchanged, regressed, or
contradictory sequence evidence remains gap-visible or degrades reconciliation. Runtimes
without the counter retain the revision-only rule. Exact move endpoints are retained in
arrival order while destination reconciliation is pending. Once the destination is proven,
the move endpoints are folded before the later snapshot endpoint. A lower snapshot sequence
or revision degrades, and an equal sequence with a different status is contradictory. A
snapshot that supplies the move's sequence and status credits that event even when output has
advanced the pane revision. The revision advance remains visible as a source-`snapshot`
`revision_jump`. A missing snapshot sequence may use the event tuple only when revision and
status agree.

## 3. Consequences of the protocol facts

- **C1.** The session monitor holds **one** long-lived connection carrying a **fixed global**
  subscription and nothing else, multiplexed across all supervisors (requirement 14). Adding
  a supervisor never resubscribes and never risks the connection. The bind snapshot and
  periodic reconciliation snapshots are separate, short-lived unary reads. A launch takes
  only its required bind read, not an extra snapshot merely because the subscription is
  already live.
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
  reviewer.ts    supervisor reviewer (typesafe/jev-latest, SUPERVISION_REVIEWER_MODEL) + model service seam
  notify.ts      ManagerNotifier: Pi sendMessage and Claude Channel implementations
  supervisor.ts  one child's state machine, cadence, degradation, receipts
  registry.ts    SupervisionRegistry: reserve → bind → settle, job ownership
  model-service.ts host-independent model registry/auth service for the MCP host
  auth-json-credential-store.ts CredentialStore over the Pi agent's auth.json
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
   the new `pane_id` whose `terminal_id`, `agent_session`, `agent`, and name match.

Only then is the bound `paneId` rewritten. The destination revision is pane-local and is
rebased as the new watermark after this proof; it is never compared with the origin pane's
watermark. Nothing else may rewrite the bound pane ID.

The move event's lifecycle endpoint is not collapsed into the fresh snapshot. Every exact
endpoint from a chained pending move is folded in arrival order, followed by the snapshot
endpoint. This preserves a completion followed by a new working transition. It also preserves
an earlier sequence advance when a later chained move repeats the same sequence and status.
A supplied snapshot sequence cannot trail any retained supplied sequence, and its status must
match every retained endpoint at the same sequence. Retained endpoints that supply the same
sequence must also agree on status. Contradictory evidence leaves the move pending and
supervision degraded. These checks compare lifecycle evidence only. Revisions remain local to
each move destination.

Failing **2** or **3** is not a lost identity and does not settle. The monitor routes a move
by its destination as well as its origin, and **F6** makes pane IDs reusable, so such an
event is either a replay of a move this supervisor already followed or a *different*
occupant's move out of a recycled ID. Concluding `identity_lost` from either would settle a
live supervisor on somebody else's evidence, so both are treated as reconciliation triggers
(**C4**) and authoritative state decides. Only a move that is provably this occupant's but
whose destination cannot be confirmed in the fresh snapshot settles `identity_lost` and
wakes.

## 7. Anchoring, folding, gaps, and periodic reconciliation

A supervisor stores `anchor = { paneId, revision, stateChangeSeq, status }` captured at
bind, a bounded ordered `transitions` list, `lastRevision`, and one optional
`lastStateChangeSeq` watermark. `lastRevision` is the highest revision folded for the pane
currently bound to the exact child. Revisions are the deduplication watermark, not stream
positions. The lifecycle watermark is used whenever authoritative evidence supplies
`state_change_seq`, including after AGY strengthening and across proven pane moves. Herdr's
retained event log can drop its head, and a proven pane move rebases the revision watermark
to the destination pane's own numbering without discarding the lifecycle watermark.

For each event on the shared stream:

- an unrelated pane ID is ignored;
- a full same-pane event below `lastRevision` is historical and ignored;
- an event at `lastRevision` with the same status is a duplicate and stays silent;
- an event at `lastRevision` with a changed status is adopted without a gap only when its
  supplied `state_change_seq` strictly advances `lastStateChangeSeq`; absent or unchanged
  lifecycle evidence emits the existing high-priority `status_changed_without_revision`
  `evidence_gap` before adopting the status, while regressed evidence emits that gap and
  leaves the current status and revision unchanged; an exact endpoint replay stays silent;
- an event exactly one revision above the watermark advances normally;
- an event more than one revision above the watermark emits one high-priority
  `evidence_gap` with `source: "event"`, `reason: "revision_jump"`, the previous and
  observed revisions, and the positive omitted-revision count, then adopts its endpoint;
- a thin event requests coalesced authoritative reconciliation. At most one event-triggered
  read per supervisor is in flight, and another trigger sets a rerun flag.

Revision deduplication remains `lastRevision`, and lifecycle deduplication uses the one
optional `lastStateChangeSeq`; neither is a stream position. **F5**'s retained log drops
entries from its head: after truncation the same position names a different entry, so a
supervisor keyed on position would skip transitions it had never seen. A proven move changes
the routing key, so the destination pane's own revision becomes the new revision watermark
only after exact occupant proof, while the lifecycle watermark is retained. Origin and
destination revisions are never compared. The move event starts the destination revision
watermark, then the fresh snapshot is folded normally. A higher snapshot revision therefore
stays gap-visible as a revision jump without inventing a
`status_changed_without_revision` lifecycle gap when its sequence and status match the move.

Events that arrive between adding the observer and proving the anchor are queued and then
folded in arrival order against that same watermark, so a queued event advances it exactly as
a live one does. A supervisor added to a monitor that has already replayed history therefore
needs no cursor of its own: its bind revision discards everything before it.

`transitions` is bounded to `SUPERVISION_MAX_TRANSITIONS = 64` with a `truncatedTransitions`
count, matching the repository's bounded-evidence rule.

### Shared periodic authoritative reconciliation

`SessionEventMonitor` owns one periodic `session.snapshot` loop for the manager session. It
starts with the first supervisor observer, stops when the last observer is removed or the
session shuts down, and fans each successful snapshot through the existing ordered observer
chain. The fixed contract is:

- `SUPERVISION_RECONCILIATION_INTERVAL_MS = 30_000`;
- one snapshot attempt per due interval for the whole session, never one per child;
- monotonic due times 30 seconds apart from the first observer, with delayed ticks skipping
  elapsed due times instead of creating a catch-up burst;
- at most one connect-plus-request attempt in flight, with the timer unrefed where supported;
- a 5-second connect bound and a separate 10-second `session.snapshot` request bound;
- no periodic attempt when there are no observers.

A successful attempt is ordered with socket events and each live supervisor evaluates it against
its complete bound identity. With the socket service available, a transition omitted at one
scheduled boundary is corrected by the next successful snapshot. The fixed 30-second interval
plus the 5-second connect and 10-second request bounds gives a proven 45-second maximum stale
status window for successful-attempt convergence. This is a correctness bound, not a promise
when attempts fail.

Snapshot extraction is target-local and typed. A result is `unique` only when exactly one
bound-pane record and at most one coherent target-local agent record have valid required fields.
It is `absent` only when neither record exists. Duplicate pane or agent records, an orphan
agent, contradictory identity, or malformed required target-local data is `invalid`, not
absence. A globally malformed snapshot fails the shared attempt. Invalid or lower-revision
evidence preserves the last identity, revision, and status, cannot settle a live supervisor,
and enters visible reconciliation degradation. Only a later valid target-local result can
recover the episode.

For a valid continuous snapshot occupant, equal revision and status is silent. Equal revision
with a changed status is gap-free only when `state_change_seq` strictly advances the lifecycle
watermark. Missing, unchanged, regressed, or contradictory lifecycle evidence remains
visible through the existing gap or reconciliation-degraded paths. Any higher revision emits
one source-`snapshot` `evidence_gap` with reason `revision_jump`, even when the endpoint status
is unchanged, then adopts the snapshot revision and status. A lower revision is never adopted.
A gap remains visible because an endpoint can hide a transition that changed and returned.

Reconciliation failures expose bounded `intervalMs`, degraded state, consecutive failure
count, last-attempt, last-success, and last-failure timestamps, and one fixed failure reason.
The first failure in an episode emits `reconciliation_degraded`; the first later valid exact
reconciliation emits `reconciliation_recovered`. These events do not settle the supervisor or
transfer review ownership. Event-stream and periodic health are aggregated, so either one can
keep a live supervisor visibly `degraded`. No CLI polling or hidden reviewer fallback starts.

**Reconnect (requirement 7).** On reconnect the monitor re-runs bootstrap
(`session.snapshot`, then `events.subscribe`, then the replay). The bootstrap snapshot uses the
same exact-identity, target-local validity, and revision rules as periodic reconciliation. If
it proves the child is present at a higher revision, one high-priority `evidence_gap` is emitted
and the snapshot's status and revision are adopted. If the revision is unchanged, resume is
silent. If the child cannot be proven present, existing identity-loss rules decide. Replayed
events at or below the adopted revision are history; higher events are folded normally. If the
socket cannot be restored, the supervisor is visibly degraded, emits one `monitor_degraded`
wake, and retries with bounded exponential backoff (250 ms to 8 s, full jitter).

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
| `reconciliation_degraded` / `reconciliation_recovered` | periodic authoritative snapshot failure / recovery | normal |
| `evidence_gap` | event or snapshot revision evidence is incomplete | high |

`identity_replaced`, `identity_lost`, `released`, and `pane_closed` are **settling**: the
supervisor job settles immediately after the wake.

## 9. Supervisor reviewer (requirement 8)

- Cadence: `settings.wait.reviewCadenceMinutes` (default 5), measured from the start of a
  **continuous** `working` run. Any transition out of `working` resets the timer.
- Model: `typesafe/jev-latest` — the module constant `SUPERVISION_REVIEWER_MODEL` in
  `src/supervision/reviewer.ts`, not a setting. Jev carries no thinking level. The setting
  `wait.reviewerModel` continues to govern the explicit `herdr_wait` reviewer, which stays
  at `low` thinking.
- Contract (ADR-033/034 V2): one `systemOne` call per review carrying six independent
  `noul` predicates — `evidence_sufficient`, `making_progress`, `stalled`, `blocked`,
  `risk`, `appears_complete` — plus one `reason` `choice` question over the bounded reason
  vocabulary (`repetition`, `no_output`, `oscillation`, `external_dependency`,
  `missing_permission`, `tool_failure`, `scope_drift`, `destructive_action`,
  `incorrect_direction`, `completion_claim`, `artifact_produced`, `verification_passed`,
  `none`). All probabilities are logged internally.
- Classification is deterministic code — `reduceSupervisionReview` in `src/reviewer.ts`:
  the evidence gate runs first (`P(evidence_sufficient) < SUPERVISION_EVIDENCE_THRESHOLD`
  = 0.60 classifies `unknown` before any signal is judged), then precedence `risk`
  (`SUPERVISION_RISK_THRESHOLD` 0.60) → `blocked` (`SUPERVISION_BLOCKED_THRESHOLD` 0.65) →
  `appears_complete` (`SUPERVISION_APPEARS_COMPLETE_THRESHOLD` 0.70) → `stalled`
  (`SUPERVISION_STALLED_THRESHOLD` 0.70, raised to
  `SUPERVISION_STALLED_FIRST_OBSERVATION_THRESHOLD` 0.85 on the child's first review) →
  `progress` (`SUPERVISION_PROGRESS_THRESHOLD` 0.60), falling through to `unknown` when no
  signal crosses. Temporal state is in-memory only.
- Evidence: bounded compact pane metadata plus the transcript delta since the previous
  **completed** review, read through the existing `pane read --source recent-unwrapped` path.
  A pane read returns the latest window rather than what changed, so the delta is computed
  against the window the previous review consumed, using the same rule the explicit wait
  reviewer uses (`src/transcript-delta.ts`). Handing the whole window back each cadence would
  let a stalled child keep reading as fresh progress. The call also carries the launch's
  authorial `supervisionDigest` — `doneWhen`/`constraints` recorded at reservation — and the
  previous review's classification and signals.
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

**Model service.** The Jev reviewer resolves its credential through `resolveTypesafeApiKey`
(`src/typesafe-reviewer.ts`): an explicit key wins, then the `TYPESAFE_API_KEY` environment
variable, then the `typesafe` `api_key` entry in the Pi auth store —
`AuthJsonCredentialStore` (`src/supervision/auth-json-credential-store.ts`), a
`CredentialStore` backed by the Pi agent's `auth.json`
(`$PI_CODING_AGENT_DIR/auth.json`, default `~/.pi/agent/auth.json`), the same file the Pi
host logs into. A missing, malformed, or credential-less store resolves as "not
authenticated" and degrades the reviewer; it never crashes the supervisor.

The narrow `SupervisionModelService` seam is retained in the registry for hosts that still
wire it, but the Jev reviewer does not consult it:

- **Pi host** — adapts the host's existing `ModelRegistrySeam` (`ctx.modelRegistry`).
- **MCP host** — `createBuiltinModelService()` builds a host-independent service from the
  installed Pi packages (`builtinModels()` from `@earendil-works/pi-ai/providers/all`,
  `getAuth()` for credentials); OAuth refreshes persist back to `auth.json` under the
  shared `proper-lockfile` lock. The MCP host never exposes `context.modelRegistry`, and
  the `hostContext` proxy keeps throwing for it.

Unresolvable model or unavailable auth is a reviewer failure (degraded episode), never a
supervisor failure and never a substitute model.

### Explicit wait review ownership

A long explicit wait evaluates coverage after its latest authoritative target observation and
immediately before each review dispatch. The active supervisor is the sole semantic-review
owner for a target only when it is bound, live, non-settled, and matches the target's complete
pane, terminal, agent, kind, and four-part `agent_session` identity. Reserved or settled
supervisors, supervisors that cannot prove a live exact child, and pane-only, name-only, or
incomplete matches do not provide coverage. Degradation alone does not remove coverage while
the exact child remains live.

Covered targets are omitted from the explicit wait reviewer. Uncovered targets receive the
existing concurrent low-thinking reviewer, one request per target. Reviewer construction is
lazy, so an all-covered wait does not resolve or authenticate a wait reviewer. A degraded but
live supervisor retains ownership; the wait reviewer is never a hidden fallback. Coverage is
recomputed at every cadence, and a target that loses coverage is reviewed at the next cadence.
Supervisor reviewer summaries and degradation stay on the supervisor job and never become wait
predicate evidence.

Each cadence publishes a bounded typed `JobDetail.semanticReview` projection with the covered
entries, explicit reviewer target IDs, and omission counts independently from truncatable
progress details. The projection is absent before the first cadence and on supervisor jobs.

Reviewer `unknown` is retained but does not require manager judgment only after a fresh exact
authoritative agent read performed after that review proves the captured occupant is `working`.
State waits may reuse their post-review exact read. Output waits must retain the authoritative
state from their final post-output exact agent record or perform a dedicated bounded read;
output metadata alone is insufficient. Missing, malformed, timed-out, contradictory, or
non-working evidence cannot suppress `unknown`, so it retains manager-judgment behavior when
the condition remains unmet. Supervisor events and reviews never settle `wait_result`.

## 10. Job model (requirement 3)

`JobRequestSnapshot` becomes a discriminated union on `kind`:

```ts
type JobRequestSnapshot = WaitJobRequestSnapshot | SupervisorJobRequestSnapshot;
```

`WaitJobRequestSnapshot` is the existing shape plus `kind: "wait"`.
`SupervisorJobRequestSnapshot` carries `kind: "supervisor"`, `label`, `targets`
(`[agentName]`), `targetIds` (`[paneId]` after bind), `target_generation_refs`, a bounded
`child` descriptor, and `settings` with `reviewerThinking: "max"`. A reserved supervisor has
no pane identity and starts with `targetIds: []`; a successful bind publishes the exact pane
ID as a one-item target array.

`JobDetail` gains:

- `kind: JobKind` (mirrors `request.kind`);
- `supervision_result?: "released" | "identity_lost" | "identity_replaced" | "failed" | "cancelled" | "unknown"`
  — the supervisor terminal field. `wait_result` remains wait-only and is never populated
  for a supervisor job;
- `supervision?: { child, state, monitor, reviewer, events, truncation }` — the bounded
  supervision view;
- `semanticReview?: { observedAtMs, supervisorCovered, explicitReviewerTargetIds,
  omittedSupervisorCovered, omittedExplicitReviewerTargetIds }` — a wait-only bounded
  ownership projection, independent from progress details;
- `pending_events?: SupervisionEventView[]` — soft receipts, `herdr_jobs get` only;
- `unobservedEvents?: number` — on both detail and summary.

`herdr_jobs` gains an optional `kind` filter on `list`. No new operation and no new tool.

**Cancellation refusal (requirements 2 and 13).** `herdr_jobs cancel` on a supervisor job
whose exact child is still live throws `SUPERVISION_ACTIVE`. Manager-session shutdown
(`session_shutdown`, MCP shutdown, `beginSession`) stops in-memory supervisors but does
not fabricate cancellation; an unresolved handoff record remains `recovery_pending`.
Exact-child termination settles only after required runtime-authored evidence persists.

**Soft receipts (requirement 12).** Every material event carries an opaque `eventId`.
`herdr_jobs get` returns at most `SUPERVISION_MAX_RETURNED_EVENTS = 16` unobserved events,
oldest first, and marks **exactly those** observed. `list` and the Pi wait-jobs UI show
unobserved counts. Event history is bounded to `SUPERVISION_MAX_EVENTS = 48` with a
`truncatedEvents` count. There are no notification retries.

## 11. Launch integration (requirements 1 and 4)

`LaunchDependencies.supervision` is **required**. The two supervision phases are ordered as
follows:

1. `supervision_reserve` runs **before any topology mutation**, immediately after the
   pre-flight/attachment block. It ensures the session monitor is connected,
   bootstrapped, and subscribed, and registers the supervisor job in `accepted`, returning a
   stable job ID. A failure here is an ordinary early failure with `effectCertainty:
   "absent"` and code `SUPERVISION_UNAVAILABLE`.
2. `supervision_bind` runs immediately after readiness proves the exact launch identity and
   before optional focus or any initial-prompt dispatch. Binding validates a fresh
   `session.snapshot`, drains all queued pre-bind evidence while the public view remains
   `reserved`, and succeeds only when the exact child is still live and the supervisor is not
   settled. Its commit publishes the selected candidate, selected kind, and
   `request.targetIds: [exactPaneId]` before publishing bound `active` or `degraded` state.

Queued closure, release, replacement, or identity-loss evidence during bind makes the bind
reject. Any bind failure throws `SUPERVISION_UNCONFIRMED` as a partial-effect failure, sends
no focus or prompt, registers no recipient, performs no retry or child cleanup, and releases
only the unbound reservation. A failed bind rolls any provisional request fields back to the
reserved snapshot with `targetIds: []`. The real child and failed binding evidence remain
available for manual inspection.

Candidate fallback stays strictly inside `agent_start`, before assignment and before binding,
so the fallback chain is unchanged. After a successful bind, no later launch failure releases,
cancels, or shuts down the supervisor. The supervisor remains session-scoped and follows its
own exact-child lifecycle rules.

Initial-prompt confirmation remains a separate launch-success gate. The prompt is submitted at
most once. An acknowledged prompt whose semantic consumption is not proven throws
`LAUNCH_FAILED` with `causeCode: "PROMPT_UNCONFIRMED"`, `assignmentState: "unconfirmed"`,
`promptSubmitted: true`, the exact pane ID, the retained active supervisor job ID, and bounded
recovery evidence. The confirmation path never auto-sends Enter, retries assignment or start,
focuses again, closes or reuses the pane, registers a recipient, or authorizes dependent work.
The fixed recovery instruction tells the manager to inspect the existing child with
`herdr_inspect` and the supervisor with `herdr_jobs get`.

On success `LaunchDetails.supervision = { jobId, state: "active", child, monitor }` and the
model-visible content line names the job ID:

```
launch success · <paneId> · supervisor <jobId>
```

## 12. Manager wake delivery (requirements 9, 10, 11)

Delivery is **wake/report only**, best effort, never a gate, never retried.

- **Pi extension host** — the existing `pi.sendMessage({ customType: "herdr-supervision", content, display,
  details }, { deliverAs: "steer", triggerTurn: true })` path.
- **MCP host** — a single `deliver()` routes by the hosting pane's own agent kind, resolved
  lazily on the first wake and cached for the session; a failed resolution is never cached, so
  the next wake retries:
  - `devin` and `pi` — self-prompt through `agent.prompt` on the server's own hosting pane,
    carrying the full identity sandwich: `kind: "supervision"` for supervisor events and
    `kind: "wait"` for settled `herdr_wait` jobs. The acknowledgement is validated with
    `parsePromptSubmission` exactly like a `herdr_communicate` send. The self-target bypass is
    deliberate: `herdr_communicate`'s self-target refusal is a tool-call policy, while the
    socket has no such rule and this wake *is* the delivery mechanism, not a user message. The
    sendable-state gate is the only state check: `working` and `blocked` still send, while
    `unknown` or unproven state drops. On `devin`, a write acknowledged while the pane was
    `working`/`blocked` lands in the composer's queued input — rendered as `○`-prefixed gray
    rows above the input box plus an all-placeholder "Press Enter to send queued messages"
    hint — which does not drain at turn end on its own; the pipeline then runs a bounded flush
    cycle — `agent wait` for `idle`/`done` with a timeout strictly inside the cycle's abort
    budget, which starts when the cycle starts, then `pane read --format ansi` — and sends an
    `enter` key only while the rendered composer proves queue evidence *inside the composer
    box* (a `○` row, the word "queued" in the box's section, or the placeholder hint — never
    in scrollback, where transcript text can say the same words) above an input area whose
    printable characters are all placeholder-styled (so the key cannot submit a draft), and a
    fresh `pane get` still shows `idle`/`done`. The ANSI walk carries SGR state across each
    whole raw line and consumes extended `38`/`48`/`58` color payloads as units; unproven
    structure fails closed to no key. One Enter drains the entire queue, so a second press is
    earned only by an observed change to the box interior — an identical re-read is repaint
    lag — and at most two Enters ever fire per cycle. Cycles serialize: a wake acknowledged
    while the latest cycle still waits joins its drain; anything later appends a fresh cycle
    with its own budget. `shutdown()` aborts the session signal the whole pipeline shares —
    identity reads, the `agent.prompt` write, and the flush — so neither can fire after the
    server closes. That flush completes the acknowledged send — it is not a retry, resend, or
    new submission. Pi steers the same write into the running turn, so no flush follows it.
    The flush machinery is not wake-private: ADR-029 extends the same bounded cycle to
    acknowledged busy `herdr_communicate` deliveries on Devin targets, with the
    proof/key section serialized across hosts by a shared pane-write lock and a
    spent-frame fence suppressing duplicate keys. Every participating Devin text
    write — this wake self-prompt included — passes through that lock. The wake
    contract above is unchanged; the extension and its limits are ADR-029's record.
  - `claude` — the documented Claude Code Channels research preview inside the *same* MCP
    server: the server advertises `capabilities.experimental["claude/channel"] = {}` and sends
    `notifications/claude/channel` with bounded `content` and `meta`. There is no prompt
    fallback, no delivery acknowledgement, and no Herdr agent prompt injection.
  - anything else — `agy`, `unknown`, missing, unsupported, or an own-pane identity that cannot
    be proven (including a pane that proves no `agent_name`) — is inert; the wake drops silently.

Settled `herdr_wait` jobs reach the same router through `JobRegistry.onTerminal`; supervisor
settlements never re-notify, because their events already woke the manager. Every failure —
kind resolution, context or identity proof, the prompt write, the acknowledgement — is
swallowed: `herdr_jobs` polling stays the recovery contract on every host.

No compiled candidate contract declares `developmentChannels` — the catalog's reviewed
resource pools expose no such pool — so no `--dangerously-load-development-channels` opt-in
is emitted for any launch, and Claude sessions raise neither the organization-policy
warning nor the missing-MCP-server warning at startup. Claude manager wakes are recovered
by `herdr_jobs` polling, which returns pending events by opaque ID and marks exactly those
observed.

The flag itself is real but unused: it is hidden from `claude --help` in 2.1.252 yet parses
as a root-command option, and `--channels` requires a tagged `server:<name>` or
`plugin:<name>@<marketplace>` entry. Nothing in the catalog or the compiler can declare
one, so no caller input can open an inbound channel. See §16.

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

- **R1 — channel delivery (no launch opts in).** `--dangerously-load-development-channels`
  is proven to exist and to parse on Claude 2.1.252, and the entry `server:herdr` matches the
  plugin's own MCP server key, but end-to-end channel delivery was never proven here: it also
  requires the organization's `channelsEnabled` managed setting, which this repository can
  neither set nor observe, and the unproven opt-in additionally produced org-policy and
  missing-MCP-server warnings at startup. No compiled contract declares channels, so wakes
  on a Claude manager are recovered by `herdr_jobs` polling. Soft receipts make every event
  recoverable through `herdr_jobs get`, and Pi delivery is unaffected.
- **R2 — replay volume and observer load.** A long-lived Herdr session replays a large log
  on every connect and reconnect, and `pane.updated` fires on output changes for every pane
  in the session. The monitor parses each line under a per-line bound and discards
  non-matching events immediately, but the parse itself is unavoidable. One shared periodic
  snapshot every 30 seconds adds fixed session-level socket load rather than one read per
  child. A manager observing a very busy session pays for both channels. The required bind
  read and periodic correctness read are retained; no redundant per-launch snapshot or CLI
  polling fallback is added.
- **R3 — retained-log truncation.** If Herdr's retained log is a ring buffer, a long outage
  can scroll the anchor out. That case is detected in §7 from the reconnect snapshot alone,
  reported as `evidence_gap` rather than assumed benign, and resynchronised from that
  snapshot's own status and revision. What is *not* recoverable is the individual transitions
  inside the scrolled window: the child's exact path through the outage is lost, only its
  endpoint is known, and the gap event is what says so. This is also why no stream position is
  used for deduplication — after truncation, position *n* names a different entry.
