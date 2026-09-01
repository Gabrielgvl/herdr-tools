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

If binding fails, launch returns `SUPERVISION_UNCONFIRMED` and performs no focus, prompt, recipient registration, retry, or child cleanup. It releases only the unbound reservation.

After binding succeeds, launch never releases or cancels that supervisor because a later launch phase failed. The supervisor remains governed by its own exact-child lifecycle and manager-session shutdown rules. It can settle only from its existing release, replacement, identity-loss, pane-close, or shutdown evidence.

Binding atomically records `request.targetIds: [identity.paneId]` with the selected profile and kind before active state is observable. A reservation may have no pane before identity exists. A bound active supervisor may not retain an empty target ID array.

### Reconcile every live supervisor periodically

The event stream remains the low-latency channel, but it is no longer the sole steady-state correctness source. `SessionEventMonitor` takes one shared authoritative `session.snapshot` every fixed 30 seconds while at least one supervisor observer exists. The existing 10-second request timeout bounds each read. Reads never overlap, the timer stops with no observers or at session shutdown, and one snapshot fans out to every live supervisor through the ordered dispatch chain.

Each supervisor reconciles only its complete bound pane, terminal, name, kind, and agent-session identity. Equal revision and equal status confirms currency. Equal revision with changed status emits one high-priority `evidence_gap` and adopts the authoritative status because the supervisor must not remain stale when Herdr's expected revision invariant is itself contradicted. A higher revision emits one gap, adopts the snapshot revision and status, and records any endpoint status transition from source `snapshot`. The gap is emitted even if endpoint status is unchanged because an omitted transition may have returned to the same state. Missing, released, and replaced occupants retain the existing settlement rules. A lower revision is contradictory and is never adopted.

The first failed or contradictory periodic reconciliation in an episode emits `reconciliation_degraded`, exposes bounded attempt, success, and failure evidence on the supervisor job, and retries on the next interval. The first later success emits `reconciliation_recovered`. Reconciliation degradation does not start CLI polling or another reviewer and does not surrender semantic review ownership.

This is one session-level periodic correctness guard, not one polling loop per child and not a replacement for the stream. Under the default bounds, a missed stream transition converges within 40 seconds while authoritative snapshots remain available.

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

### Do not let reviewer `unknown` override working state

Reviewer classifications remain advisory until the existing post-review authoritative refresh establishes settlement precedence. `stalled`, `blocked`, and `risk` retain manager-judgment behavior. `progress` and `appears_complete` remain non-terminal.

An `unknown` result is stored, but it does not settle the wait when the exact target's fresh authoritative state is `working`. It can still require manager judgment when the target is unmapped or the fresh state is not working and the requested condition remains unmet. Another qualifying classification in the same review window can still settle the wait.

### Remove the old behavior

There is one launch order, one periodic reconciliation rule, and one review-ownership rule. No stream-only mode, empty target ID on a bound job, compatibility field, old diagnostic key, delayed-bind mode, unconditional release path, duplicate reviewer path, or fallback parser is retained.

## Alternatives considered

### Keep binding after prompt confirmation

Rejected. It makes supervision disappear precisely when assignment effects are uncertain and leaves a real child without whole-life observation.

### Return success when assignment is unconfirmed but supervision is active

Rejected. Supervision proves observation, not assignment consumption. Returning success would weaken ADR-015 and authorize dependent work without evidence.

### Clean up the child on assignment uncertainty

Rejected. Prompt delivery is not idempotent and may already have been consumed. Cleanup would destroy a possibly working child and its evidence.

### Release the supervisor but include its old job ID in the error

Rejected. A settled reservation is not active supervision. Publishing a stale handle would describe observability that no longer exists.

### Trust the event stream unless it reconnects

Rejected by direct evidence. A live subscription and exact bound job stayed idle while authoritative state showed the child working. Reconnect-only reconciliation cannot repair a transition that is silently omitted without a disconnect.

### Run one periodic snapshot timer per supervisor

Rejected. Snapshot load would grow linearly with child count and every timer would read the same session topology. One session-level read can reconcile every observer and preserves ADR-019's multiplexing rationale.

### Reuse review cadence as the reconciliation interval

Rejected. Review cadence can be 30 minutes and is itself triggered by projected working state. A missed transition into working would prevent the very review timer expected to discover it. The fixed 30-second interval is below the minimum one-minute review cadence.

### Hide periodic snapshot failures behind stream health

Rejected. The observed defect was a healthy stream with stale state. A failed correctness read must make reconciliation health visibly degraded and retry, even while the subscription remains connected.

### Let every long wait keep its reviewer

Rejected. The supervisor already owns continuous semantic review for the same exact child. A second reviewer adds cost and conflicting judgments without strengthening the authoritative wait predicate.

### Use the wait reviewer only when the supervisor reviewer is degraded

Rejected. That is a hidden fallback. It conceals reduced supervisor evidence, changes reviewer model and thinking level under failure, and recreates two ownership rules.

### Treat every reviewer `unknown` as manager judgment

Rejected. A model's inability to classify does not outweigh fresh authoritative evidence that the child is still working. The summary remains visible and stronger evidence can still settle later.

## Consequences

- A failed prompt launch can truthfully leave a healthy active supervisor job. Managers must retain and inspect that job rather than relaunch the child.
- Binding failure happens before assignment, so a child whose supervision cannot be proven receives no initial work from Tools.
- Every bound supervisor request exposes its exact bind pane ID instead of an empty target array.
- Supervision adds one fixed session-level snapshot read every 30 seconds while children are observed. The load is constant with child count.
- A successful periodic snapshot repairs a missed stream transition within the default 40-second bound. Failed reads make reconciliation visibly degraded and keep retrying.
- A revision-only advance can produce a conservative evidence gap even when endpoint status is unchanged. This is preferred to silently assuming that no transition occurred.
- Prompt-unconfirmed diagnostics expose the two safe recovery handles while preserving the existing secret boundary.
- All-covered long waits no longer require the wait reviewer model service. Unsupervised targets still fail closed if their required reviewer is unavailable.
- Supervisor review and wait settlement remain separate. A supervisor can wake the manager while the wait continues toward its authoritative condition.
- A degraded supervisor remains visibly degraded instead of silently borrowing another reviewer.
- An `unknown` review can extend a wait to a later condition match or timeout. This is deliberate because authoritative working state is stronger evidence.
- Coverage is sampled immediately before each reviewer dispatch. A supervisor that settles just after the sample can defer explicit review until the next cadence, while target polling and supervisor settlement evidence remain active.

The implementation contract and exact acceptance criteria are in [the identity-bound supervision and wait review spec](../specs/identity-bound-supervision-and-wait-review.md).
