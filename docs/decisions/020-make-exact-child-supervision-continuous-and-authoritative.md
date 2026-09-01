# ADR-020: Make exact-child supervision continuous and authoritative

## Status

Accepted.

This ADR supersedes these specific decisions:

- The post-confirmation supervisor bind timing and unconditional pre-bind failure release rule in [ADR-019](019-automatic-child-supervision.md).
- ADR-019's stream-only steady state, strictly on-demand snapshot rule, and statement that periodic polling is never part of supervision correctness.
- The prompt-uncertainty recovery and model-visible diagnostic shape in [ADR-015](015-semantic-initial-prompt-consumption-confirmation.md) and [ADR-018 model-visible failure evidence](018-model-visible-failure-evidence.md).
- The requirement that every target of a long explicit wait receives a separate wait reviewer call when an active exact-child supervisor already owns that review.
- The implemented supervisor request behavior that leaves `targetIds` empty after exact binding, contrary to the accepted auto-supervision specification.

The detached-only API in [ADR-018 detached wait](018-detached-only-wait-api.md), the single-submit semantic confirmation rule in ADR-015, and ADR-019's identity, revision-watermark, reconnect, notification, soft-receipt, reviewer, and session-lifetime decisions remain accepted.

## Date

2026-09-01

## Context

Automatic child supervision currently reserves before launch mutation but binds only after optional focus and initial-prompt confirmation. The launch catch path then releases the reservation on every failure. A prompt can therefore be acknowledged, remain semantically unconfirmed, and leave a real identity-proven child running after its supervisor job has been settled by launch error handling.

The assignment result and the supervision result answer different questions. Assignment confirmation answers whether Tools can report that the child consumed its initial work. Supervision binding answers whether Tools can observe the exact child's lifecycle. Delaying the second answer until the first succeeds couples independent safety gates and discards the one guard that matters most when assignment state is uncertain.

A second observed failure showed that successful binding and a live subscription are not enough. Supervisor `job_9ce7ea5f-9d84-4764-87d3-c330f69385d6` remained projected as `idle` with zero transitions and events while authoritative `herdr_inspect` reported the same exact child in pane `wE:p3` as `working`. No reconnect occurred, so the current reconnect snapshot rule could not repair the stale state. Stream silence can therefore mean a missed Herdr hook or socket transition, not a current child.

The same active supervisor request exposed `targetIds: []` even though binding had already proven pane `wE:p3`. The accepted auto-supervision specification requires `[paneId]`, and an empty bound request prevents managers and model projections from correlating the job with its exact target.

Long explicit waits also run a low-thinking semantic reviewer for every target even when the target already has a whole-life supervisor with its own required reviewer. This duplicates model work and can produce competing classifications for the same child. The wait condition itself is still authoritative and must remain independent from either reviewer.

Finally, a wait reviewer classification of `unknown` currently causes manager-judgment settlement even when fresh Herdr state still proves the target is working. Model uncertainty alone is weaker evidence than authoritative lifecycle state.

## Decision

### Bind at exact identity proof

`herdr_launch` keeps reserving supervision before its first topology mutation. After startup readiness proves the complete pane, terminal, name, kind, and agent-session identity, launch binds the supervisor immediately. Binding occurs before optional focus and before prompt dispatch.

Binding is a two-phase internal transaction. The supervisor validates its authoritative bind snapshot and drains queued pre-bind evidence without publishing `active` or `degraded`; the public view remains `reserved` unless that evidence settles it. Bind rejects if closure, release, replacement, identity loss, or another queued outcome settles the supervisor during that drain. Launch cannot focus or dispatch a prompt until the drain completes and the supervisor still proves the same live exact child.

The successful commit synchronously records the selected profile, selected kind, and `request.targetIds: [identity.paneId]`, then publishes bound `active` or `degraded` state. No asynchronous work separates request publication from bound-state publication. On any bind failure, provisional request values are rolled back to the reserved snapshot with `targetIds: []` before the error is observable. Launch returns `SUPERVISION_UNCONFIRMED`, performs no focus, prompt, recipient registration, retry, or child cleanup, and releases only the unbound reservation.

After binding succeeds, launch never releases or cancels that supervisor because a later launch phase failed. The supervisor remains governed by its own exact-child lifecycle and manager-session shutdown rules. It can settle only from its existing release, replacement, identity-loss, pane-close, or shutdown evidence.

### Reconcile every live supervisor periodically

The event stream remains the low-latency channel, but it is no longer the sole steady-state correctness source. `SessionEventMonitor` takes one shared authoritative `session.snapshot` every fixed 30 seconds while at least one supervisor observer exists. Attempts use monotonic due times 30 seconds apart rather than sleeping 30 seconds after completion; delayed ticks skip catch-up bursts. Opening the unary socket has a 5-second connect bound, followed by the separate 10-second request bound. Connect-plus-request attempts never overlap, the timer stops with no observers or at session shutdown, and one snapshot fans out to every live supervisor through the ordered dispatch chain. A transition omitted at one scheduled attempt boundary therefore has a proven 45-second end-to-end convergence bound while attempts succeed.

Revision gaps are detected on both channels. For a same-pane full event, watermark plus one is expected, a jump above that emits one source-`event` `evidence_gap` with the omitted intermediate count before adopting the endpoint, and an exact duplicate stays silent. A same-revision status contradiction also emits one gap and adopts the status. Pane-move destinations rebase their pane-local revision and are not compared with the origin watermark. For a valid continuous snapshot, any higher revision means the stream failed to fold at least one authoritative revision and emits one source-`snapshot` gap before adoption. A gap remains visible even when endpoint status is unchanged.

Snapshot evidence is target-locally typed as unique, absent, or invalid. Duplicate bound-pane records, duplicate target-local agent records, contradictory local identity, or malformed required local fields are invalid, not absence. Globally malformed or target-locally invalid evidence preserves the last live projection, degrades reconciliation, and cannot settle the supervisor. Only valid unique or absent evidence can prove continuity, release, replacement, or pane absence. A lower revision is contradictory and is never adopted.

The first failed shared read, invalid target-local result, or contradictory lower revision in an episode emits `reconciliation_degraded` and exposes bounded attempt, valid-success, and failure timestamps, a saturated counter, and a fixed failure-reason literal on the supervisor job. Raw backend and protocol cause text is excluded. The first later valid target-local reconciliation emits `reconciliation_recovered`. Reconciliation degradation does not start CLI polling or another reviewer and does not surrender semantic review ownership.

This is one session-level periodic correctness guard, not one polling loop per child and not a replacement for the stream.

### Keep assignment as a separate success gate

Moving supervisor binding earlier does not weaken initial-prompt confirmation. Prompt submission remains single-shot. A prompt launch still returns success only after the existing semantic confirmation rule succeeds, and recipient registration remains forbidden before that point.

A prompt effect that may have occurred without confirmed consumption is `assignmentState: "unconfirmed"`. It remains a thrown launch error. It is not converted into partial success merely because supervision is active.

### Publish bounded recovery handles

The fixed `HERDR_LAUNCH_DIAGNOSTIC` gains top-level `paneId`, `supervisorJobId`, and `assignmentState: "unconfirmed"` for this error state. All three are required together. The recovery guidance is one fixed Tools-authored instruction to inspect the existing pane and supervisor job and not relaunch, resend, close, reuse, register, or continue dependent work while assignment consumption is unconfirmed.

The diagnostic continues to exclude attached error details, cause messages, backend evidence, output, environment data, prompt text, and agent-session values. The MCP adapter validates the fixed conditional shape and never falls back to rich details. Pi rich details carry the retained active supervisor, and the compact row identifies assignment uncertainty, pane ID, and supervisor job ID without resembling success.

### Make active supervision the semantic review owner

At every long-wait review cadence, `herdr_wait` compares each resolved target's complete identity with active bound supervisor jobs in the same session registry.

A target with exact live coverage is omitted from the explicit wait reviewer. A target without coverage retains the current required low-thinking reviewer. Mixed waits review only unsupervised targets. Reviewer construction is lazy, so an all-covered wait does not resolve or authenticate a wait reviewer at all.

Coverage is recomputed at each cadence. Reserved and settled supervisors, incomplete identities, and pane-only or name-only matches do not count. A visibly degraded but live exact supervisor remains the owner. Its degradation is not hidden by a fallback wait reviewer.

The wait continues to poll and settle only from its own authoritative condition, timeout, target failures, reviewer judgment for unsupervised targets, or cancellation. Supervisor events and reviewer findings remain on the supervisor job and never become wait predicate evidence.

The latest cadence partition is exposed through a dedicated bounded `JobDetail.semanticReview` field written through the job operation control. It is not stored only in `progress.details`, whose 256-byte bound can replace details with an opaque truncation envelope. The structured field retains explicit supervisor-covered entries, explicit reviewer target IDs, and omission counts under a 4,096-byte cap.

### Do not let reviewer `unknown` override working state

Reviewer classifications remain advisory until the existing post-review authoritative refresh establishes settlement precedence. `stalled`, `blocked`, and `risk` retain manager-judgment behavior. `progress` and `appears_complete` remain non-terminal.

An `unknown` result is stored, but it does not settle the wait only when an exact authoritative agent read performed after the review proves the captured occupant is `working`. State-condition logic may reuse its post-review exact agent read. Output-condition composite or pane metadata is insufficient; the strict output read must retain authoritative status from its final post-output identity-validation agent record, or perform a dedicated bounded `agent get` when that proof is unavailable. Missing, malformed, timed-out, or identity-contradictory reads cannot suppress `unknown` and retain existing target-read and deadline precedence. Another qualifying classification in the same review window can still settle the wait.

### Remove the old behavior

There is one launch order, one revision-gap rule per evidence source, one periodic reconciliation rule, and one review-ownership rule. No stream-only mode, unreported event jump, absence inference from invalid records, successful bind after queued settlement, stale provisional target ID, progress-only ownership projection, empty target ID on a bound job, compatibility field, old diagnostic key, delayed-bind mode, unconditional release path, duplicate reviewer path, or fallback parser is retained.

## Alternatives considered

### Keep binding after prompt confirmation

Rejected. It makes supervision disappear precisely when assignment effects are uncertain and leaves a real child without whole-life observation.

### Return success when assignment is unconfirmed but supervision is active

Rejected. Supervision proves observation, not assignment consumption. Returning success would weaken ADR-015 and authorize dependent work without evidence.

### Clean up the child on assignment uncertainty

Rejected. Prompt delivery is not idempotent and may already have been consumed. Cleanup would destroy a possibly working child and its evidence.

### Release the supervisor but include its old job ID in the error

Rejected. A settled reservation is not active supervision. Publishing a stale handle would describe observability that no longer exists.

### Publish bound state before queued evidence finishes

Rejected. Queued closure or replacement evidence can settle the supervisor during bind. Launch must not dispatch a prompt from a bind call that returns after its supervisor already settled. Request target fields and bound state are committed only after that drain and are rolled back together on failure.

### Trust the event stream unless it reconnects

Rejected by direct evidence. A live subscription and exact bound job stayed idle while authoritative state showed the child working. Reconnect-only reconciliation cannot repair a transition that is silently omitted without a disconnect.

### Detect gaps only when snapshots advance

Rejected. A higher event currently advances the same watermark snapshots use. If an event jumps over revisions and the supervisor silently adopts it, every later snapshot at that revision looks current and the omitted evidence is hidden permanently.

### Run one periodic snapshot timer per supervisor

Rejected. Snapshot load would grow linearly with child count and every timer would read the same session topology. One session-level read can reconcile every observer and preserves ADR-019's multiplexing rationale.

### Reuse review cadence as the reconciliation interval

Rejected. Review cadence can be 30 minutes and is itself triggered by projected working state. A missed transition into working would prevent the very review timer expected to discover it. The fixed 30-second interval is below the minimum one-minute review cadence.

### Hide periodic snapshot failures behind stream health

Rejected. The observed defect was a healthy stream with stale state. A failed correctness read must make reconciliation health visibly degraded and retry, even while the subscription remains connected.

### Treat non-unique target-local evidence as pane absence

Rejected. Duplicate or malformed records do not prove that the exact pane is absent. Settling a live supervisor from ambiguous topology would turn an evidence-quality failure into a false lifecycle conclusion.

### Publish review ownership only in progress details

Rejected. Public progress details are bounded to 256 bytes and can become an opaque truncation envelope. Ownership must remain a typed, bounded field even when ordinary progress is large.

### Let every long wait keep its reviewer

Rejected. The supervisor already owns continuous semantic review for the same exact child. A second reviewer adds cost and conflicting judgments without strengthening the authoritative wait predicate.

### Use the wait reviewer only when the supervisor reviewer is degraded

Rejected. That is a hidden fallback. It conceals reduced supervisor evidence, changes reviewer model and thinking level under failure, and recreates two ownership rules.

### Suppress output-wait `unknown` from pane metadata

Rejected. Composite output observations can contain stale or non-authoritative agent status. Suppression requires a fresh identity-pinned agent record after the review, either retained from the strict output read or obtained separately.

### Treat every reviewer `unknown` as manager judgment

Rejected. A model's inability to classify does not outweigh fresh authoritative evidence that the child is still working. The summary remains visible and stronger evidence can still settle later.

## Consequences

- A failed prompt launch can truthfully leave a healthy active supervisor job. Managers must retain and inspect that job rather than relaunch the child.
- Binding failure happens before assignment, so a child whose supervision cannot be proven receives no initial work from Tools. Queued settlement cannot be mistaken for bind success.
- Every successfully bound supervisor request exposes its exact bind pane ID instead of an empty target array. Failed binding restores the reserved empty target rather than leaving a provisional pane.
- Supervision adds one fixed session-level snapshot read every 30 seconds while children are observed. The load is constant with child count.
- A successful periodic attempt repairs a missed stream transition within the default 45-second end-to-end bound, including socket connection and request time. Failed or invalid reads make reconciliation visibly degraded and keep retrying.
- Event and snapshot revision advances can produce conservative evidence gaps even when endpoint status is unchanged. This is preferred to silently assuming that no transition occurred.
- Malformed or duplicate target-local records preserve the last live projection and degrade health instead of falsely settling the supervisor.
- Prompt-unconfirmed diagnostics expose the two safe recovery handles while preserving the existing secret boundary.
- All-covered long waits no longer require the wait reviewer model service. Unsupervised targets still fail closed if their required reviewer is unavailable.
- Wait details gain one typed, independently bounded semantic-review ownership field because ordinary progress truncation cannot carry the contract.
- Supervisor review and wait settlement remain separate. A supervisor can wake the manager while the wait continues toward its authoritative condition.
- A degraded supervisor remains visibly degraded instead of silently borrowing another reviewer.
- An `unknown` review can extend a wait to a later condition match or timeout. Output waits retain the authoritative state from their final post-output exact agent record, or perform a dedicated read when unavailable. This is deliberate because authoritative working state is stronger evidence.
- Coverage is sampled immediately before each reviewer dispatch. A supervisor that settles just after the sample can defer explicit review until the next cadence, while target polling and supervisor settlement evidence remain active.

The implementation contract and exact acceptance criteria are in [the identity-bound supervision and wait review spec](../specs/identity-bound-supervision-and-wait-review.md).
