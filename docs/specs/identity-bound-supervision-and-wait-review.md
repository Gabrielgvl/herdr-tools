# Implementation spec: identity-bound supervision, authoritative reconciliation, and wait review ownership

**Status:** Approved for implementation after this documentation gate

**Date:** 2026-09-01

**Decision:** [ADR-020](../decisions/020-make-exact-child-supervision-continuous-and-authoritative.md)

## 1. Objective

Make exact-child supervision active as soon as `herdr_launch` proves the launched child identity. Assignment confirmation remains a separate launch success gate. If assignment consumption cannot be confirmed, launch still throws a tool error, but it must not release the bound supervisor or leave a working child without lifecycle observation.

Make supervision converge from authoritative session snapshots even when the socket stream or a Herdr transition hook misses an event. One session-level periodic reconciliation must cover every live supervisor, remain pinned to exact identity, and bound stale status rather than trusting stream silence indefinitely. Revision gaps must remain visible whether the first higher revision arrives through the event stream or through a snapshot.

Make the same supervisor the semantic review owner for that child. A long `herdr_wait` must continue to evaluate its authoritative condition, but it must not invoke a second semantic reviewer for a target already covered by an active exact-child supervisor. Targets without that coverage retain the existing required wait reviewer.

For Tools-managed handoff runs, authoritative identity also selects the completion gate. A matching `idle`, `done`, or other terminal observation remains unmatched while the current artifact is missing or invalid, so repair has time to complete. Validation is asynchronous in each target reader before `any` or `all` aggregation. A non-strict wait without authoritative managed-run identity remains observation-only. Turn-level cancellation does not create run-cancellation evidence. Host shutdown leaves unresolved durable state `recovery_pending`; automatic restoration is deferred.

Success has five observable properties:

1. An identity-proven child is bound to supervision before focus or assignment can fail.
2. Every live supervisor is reconciled from one bounded periodic authoritative snapshot loop, so a missed stream transition cannot leave status stale indefinitely while snapshot reads remain available.
3. Assignment uncertainty is a model-visible error state with a pane ID, supervisor job ID, and safe recovery instructions.
4. Wait conditions remain authoritative while semantic review runs exactly once per target owner.
5. Prompt text, environment values, backend messages, and agent-session values never enter model-visible failure content.

## 2. Scope

This change is limited to Herdr Tools in this repository.

In scope:

- `herdr_launch` phase ordering, partial-effect state, diagnostics, and Pi rendering.
- A session-level bounded periodic `session.snapshot` reconciliation loop for all live supervisors.
- Exact-identity, revision-gap, malformed-evidence, health, and recovery behavior across event and snapshot reconciliation.
- Transactional supervisor binding, including queued-event drain validation and exact bound `targetIds`.
- The internal exact-identity coverage query between supervisor jobs and `herdr_wait`.
- Long-wait reviewer target selection and `unknown` classification handling.
- Model-visible MCP projection for the fixed launch diagnostic.
- Manager guidance and the current product documents.
- Unit and disposable-session integration coverage for the changed contracts.

Out of scope:

- Herdr core, protocol, CLI, socket, or lifecycle changes.
- A new public tool, tool input field, setting, compatibility alias, or migration path.
- Retrying prompt submission, restarting an agent, sending Enter, or cleaning a failed launch.
- Folding supervisor events or supervisor reviewer results into `wait_result`.
- Polling the Herdr CLI for supervision, opening one periodic snapshot loop per child, or replacing the event stream.
- Changing the detached-only `herdr_wait` API or its authoritative condition semantics.
- Changing the supervisor reviewer model, wait reviewer model setting, cadence setting, or thinking levels.
- Persisting jobs or supervision across manager sessions.

## 3. Current behavior to replace

The current source has nine obsolete behaviors:

1. `src/tools/launch.ts` binds supervision after optional focus, prompt submission, and prompt consumption confirmation.
2. The launch failure handler calls `reservation.release(...)` for every failure, including a prompt-confirmation failure after the exact child identity was already proven.
3. `src/supervision/monitor.ts` trusts the socket stream after bootstrap and reads another authoritative snapshot only for reconnect or an event-triggered reconciliation. A live subscription that silently omits a transition can therefore leave a supervisor's status stale indefinitely.
4. `Supervisor.fold(...)` accepts any higher same-pane event revision and advances the watermark without recording omitted intermediate revisions, so an event-path jump can permanently hide an evidence gap from later snapshots.
5. `Supervisor.bind(...)` can drain queued closure or replacement evidence, settle the supervisor, and still resolve the bind call, allowing launch to continue toward prompt dispatch without active supervision.
6. Target-local snapshot extraction returns the same absent result for a genuinely missing pane, malformed evidence, and duplicate pane or agent records. A live supervisor can therefore settle from evidence that was not authoritative enough to prove absence.
7. `src/supervision/registry.ts` registers supervisor requests with `targetIds: []` and binding updates only profile and kind, so an active job does not identify its exact pane in the request snapshot.
8. `src/tools/wait.ts` constructs a wait reviewer for every long wait and sends every target to that reviewer, even when an active supervisor already owns semantic review for the same exact child.
9. A wait reviewer classification of `unknown` contributes to `manager_judgment_required` even when a fresh authoritative observation still reports that target as `working`.

The observed failure is concrete. A live supervisor job remained `idle` with no transitions or events while authoritative `herdr_inspect` reported its exact child as `working`. Stream silence was therefore not evidence that the supervisor projection was current.

The fixed launch diagnostic also lacks a top-level pane ID, supervisor job ID, and assignment state. Rich Pi details contain prompt evidence, but Pi does not guarantee that custom `Error.details` reaches the model. The MCP adapter therefore cannot recover those facts from attached details without violating the existing no-cause-evidence boundary.

These behaviors are removed. No stream-only supervision mode, empty active target ID, old phase order, unconditional release path, duplicate review path, diagnostic alias, or parser fallback remains.

## 4. Terms and invariants

### 4.1 Exact child identity

An exact child identity is the existing complete tuple:

- pane ID
- terminal ID
- agent name
- agent kind
- all four `agent_session` fields: `source`, `agent`, `kind`, and `value`

A pane ID, agent name, terminal ID, or partial session alone is not coverage evidence.

### 4.2 Bound supervisor

A supervisor is bound only after `SupervisionReservation.bind(...)` returns successfully for the exact child identity. A reserved job is not bound supervision. A settled supervisor is not active coverage.

A bound supervisor may be `active` or visibly `degraded`. Binding has not succeeded while queued pre-bind evidence is still draining. The bind operation must prove that the exact child remains live and the supervisor remains non-settled after that drain before it can publish bound state or permit prompt dispatch.

Degradation does not transfer semantic review ownership back to `herdr_wait`. The supervisor already reports degradation and retries under its own contract. Starting a hidden low-thinking fallback reviewer would conceal that state and recreate duplicate ownership.

### 4.3 Assignment state

`assignmentState` is present only when an initial prompt was requested:

- `confirmed`: semantic prompt consumption met the existing ADR-015 rule.
- `unconfirmed`: prompt dispatch may have had an effect, but semantic consumption did not reach the confirmation gate.

`promptSubmitted` remains the narrower typed-acknowledgement fact. It must not be inferred from `assignmentState`. A transport failure after prompt dispatch can therefore have `promptSubmitted: false` and `assignmentState: "unconfirmed"` when delivery may still have occurred.

Every launch carries the mandatory typed `assignment`, so every successful launch reports an `assignmentState`.

### 4.4 Semantic review ownership

The active exact-child supervisor owns semantic review for its child. `herdr_wait` still owns its requested state or output predicate, timeout, target reads, target errors, and settlement. Supervisor events never satisfy a wait predicate and never directly settle a wait job.

### 4.5 Periodic authoritative reconciliation

Periodic authoritative reconciliation is one session-level read-only `session.snapshot` loop shared by every live supervisor. It is a mandatory correctness channel beside the event stream, not a CLI polling fallback. The stream supplies low-latency transitions. The periodic snapshot proves current occupant identity, pane revision, and status when stream silence is incomplete.

### 4.6 Bound supervisor target ID

A reserved supervisor has no pane identity and carries `request.targetIds: []`. Binding is a two-phase internal transaction: prepare the exact child and drain queued evidence without publishing `active` or `degraded` (the public view remains `reserved` unless that evidence settles it), then synchronously commit the selected kind, selected profile, and `request.targetIds: [exactPaneId]` immediately before publishing `active` or `degraded` bound state. A bound supervisor request never retains the empty array.

If bind preparation, queued-evidence drain, request publication, or active-state publication fails, the bind rejects and the public request is restored to its reserved snapshot with `targetIds: []`. No provisional exact pane ID survives on a failed unbound reservation.

`request.targetIds` records the exact bind target. After a proven pane move, the live current pane remains in `supervision.child.paneId` under the existing move contract.

## 5. Launch lifecycle contract

### 5.1 Required phase order

The successful path is ordered as follows:

1. Validate input, resolve the profile graph, prepare prompt sources and attachment capability, and resolve live caller context.
2. Reserve supervision in `supervision_reserve` before the first topology mutation.
3. Place the pane, start the selected profile, and complete exact readiness in the existing absolute startup budget.
4. Bind the supervisor in `supervision_bind` immediately after readiness returns the exact captured identity and lifecycle anchor. Bind preparation validates an authoritative snapshot and drains all queued pre-bind evidence without publishing `active` or `degraded`; the public view remains `reserved` unless that evidence settles it. The operation succeeds only if the exact child is still live and the supervisor remains non-settled after the drain; its commit then publishes the selected profile, selected kind, and `request.targetIds: [capturedIdentity.paneId]` before bound state.
5. Apply optional focus only after that committed bind returns successfully.
6. If requested, submit the provenance-wrapped assignment exactly once and run the existing bounded semantic confirmation loop.
7. Register the recipient only after assignment confirmation.
8. Return launch success only after all required gates complete.

`supervision_bind` moves before `focus` and `prompt_verification`. No second bind phase remains after prompt confirmation.

### 5.2 Bind failure

If supervisor binding fails:

- The launch throws the existing `SUPERVISION_UNCONFIRMED` partial-effect failure.
- No focus command, prompt bytes, recipient registration, fallback, retry, or child cleanup occurs after the failed bind.
- The unbound reservation is released so the reserved job does not leak.
- No job is published as bound with `request.targetIds: []`.
- Any provisional request update is rolled back, so the failed unbound request again has `targetIds: []` and its original reserved child fields.
- The real child and the failed binding evidence remain available for manual inspection under the existing ADR-019 contract.

Queued closure, release, proven replacement, or identity-loss evidence can settle the supervisor while bind preparation drains the queue. That settled outcome makes bind reject with bounded `settledDuringBind` evidence; it is never reported as a successful bind. Queue drain completion is therefore part of the launch supervision gate, not asynchronous work that may finish after prompt dispatch.

This is the only path after identity readiness where Tools cannot claim active supervision. It is explicit and blocks assignment. Tools must never continue to focus or assign an identity-proven child after binding fails.

### 5.3 Failures after a successful bind

Launch tracks whether binding completed. Once it did:

- The launch catch path must not call `release`, `cancel`, `shutdown`, or any equivalent supervisor settlement operation.
- The supervisor remains session-scoped and follows only its own exact-child lifecycle settlement rules.
- Read-only launch reconciliation may still run under its independent bound, but reconciliation cannot release or replace supervision.
- Any later focus, prompt transport, acknowledgement parsing, prompt confirmation, recipient registration, caller-abort, or rendering failure retains the supervisor job ID in rich error details.

The failure handler releases only an unbound reservation. This is one branch, not a compatibility mode.

### 5.4 Prompt uncertainty

The prompt contract from ADR-015 remains fail-closed:

- The assignment is submitted at most once.
- No prompt, start, Enter, focus, fallback, or recovery mutation is retried after dispatch.
- `PROMPT_UNCONFIRMED` still means consumption was not proven and the prompt may have been consumed.
- Recipient registration remains forbidden.
- Launch must not return success or permit a dependent assertion to treat the assignment as accepted.

For an acknowledged prompt whose semantic confirmation fails, the thrown error remains:

- outer code `LAUNCH_FAILED`
- `causeCode: "PROMPT_UNCONFIRMED"` in rich details
- `phase: "prompt_verification"`
- `promptSubmitted: true`
- `promptConsumption: "unconfirmed"`
- `assignmentState: "unconfirmed"`
- exact pane ID
- the retained supervisor job with `state: "active"` at the successful bind boundary
- bounded submission, readiness, confirmation, timing, and reconciliation evidence

If the supervisor independently observes release, replacement, loss, or pane closure, it may settle under its existing lifecycle contract. Launch itself never settles it.

### 5.5 Successful assignment

A prompt launch can return success only after semantic confirmation. Its rich details include `assignmentState: "confirmed"`, `promptConsumption: "confirmed"`, and the active supervisor details.

## 6. Launch model and Pi UI contract

### 6.1 Fixed model-visible diagnostic

`LaunchModelDiagnostic` gains these optional fixed fields:

```ts
interface LaunchModelDiagnostic {
  code: string;
  phase: LaunchPhase;
  created: LaunchResourceIds;
  paneId?: string;
  supervisorJobId?: string;
  assignmentState?: "unconfirmed";
  agentStarted: boolean;
  promptSubmitted: boolean;
  recipientRegistered: boolean;
  effectCertainty: LaunchEffectCertainty;
  recoveryGuidance: LaunchRecoveryGuidance;
}
```

For an assignment-unconfirmed error, `paneId`, `supervisorJobId`, and `assignmentState: "unconfirmed"` are all required. `created` keeps its existing meaning and is not overloaded to identify an existing target pane.

The diagnostic remains inside the single `HERDR_LAUNCH_DIAGNOSTIC` record in `Error.message`, within `LAUNCH_DIAGNOSTIC_MAX_BYTES`. All values are Tools-authored literals, booleans, bounded safe IDs, or existing enums. The diagnostic contains no prompt text, cause message, backend envelope, stdout, stderr, recent output, environment data, profile body, or agent-session field.

The assignment-unconfirmed recovery guidance is one fixed Tools-authored string:

> Inspect the existing child with herdr_inspect and its active supervisor with herdr_jobs get; do not relaunch, resend, close or reuse the pane, register a recipient, or continue dependent work while assignment consumption is unconfirmed.

This guidance replaces the obsolete unconfirmed-prompt guidance. There is no old-key alias.

### 6.2 MCP projection

`src/mcp/adapter.ts` parses only the fixed diagnostic from `Error.message` as it does today. It adds a strict conditional rule:

- If any of `paneId`, `supervisorJobId`, or `assignmentState` appears, all three must be valid and `assignmentState` must equal `unconfirmed`.
- A malformed combination rejects the entire diagnostic rather than consulting attached error details.
- Other launch diagnostics may omit all three fields.
- Raw `Error.details` remains excluded for `herdr_launch`.

### 6.3 Pi details and compact row

Rich Pi error details include the same `paneId`, `assignmentState`, and bounded supervision object used by successful launches:

```ts
{
  paneId: "w1:p2",
  assignmentState: "unconfirmed",
  supervision: {
    jobId: "job_...",
    state: "active",
    child: {
      agentName: "worker",
      agentKind: "pi",
      paneId: "w1:p2",
      terminalId: "term_...",
      profileName: "worker-pi"
    }
  }
}
```

The compact Pi result row for this error is:

```text
error LAUNCH_FAILED · assignment unconfirmed · <paneId> · supervisor <jobId>
```

Other launch error rows keep their current compact behavior. Expanded Pi details remain bounded and redacted.

## 7. Periodic authoritative supervisor reconciliation

### 7.1 Shared loop and bounds

`SessionEventMonitor` owns one periodic reconciliation loop for the manager session. It starts when the first supervision observer is present and stops when the last observer is removed or the session shuts down.

The fixed contract is:

- `SUPERVISION_RECONCILIATION_INTERVAL_MS = 30_000`.
- One `session.snapshot` request per interval for the whole session, not one request per supervisor.
- Attempt due times are monotonic and 30,000 ms apart from the first-observer epoch. The next due time is not computed as 30 seconds after the prior attempt completes.
- A delayed tick skips elapsed due times instead of launching a catch-up burst; it schedules the first future due time.
- The existing `SUPERVISION_CONNECT_TIMEOUT_MS = 5_000` bounds opening the short-lived unary connection.
- After connection, `SUPERVISION_REQUEST_TIMEOUT_MS = 10_000` separately bounds the `session.snapshot` request.
- At most one periodic snapshot attempt, including connect and request, is in flight. A slow or failed attempt never overlaps the next attempt.
- The timer is unrefed where the runtime supports it and is cancelled on monitor shutdown.
- No periodic snapshot runs when there are no observers.

With an available socket service, a transition omitted just after one scheduled snapshot can wait at most 30 seconds from that scheduled attempt boundary for the next attempt. That attempt can then spend up to 5 seconds connecting before the separate 10-second request timeout. Fixed due times, rather than completion-relative sleeps, make the proven default maximum stale-status window 45 seconds. This is an end-to-end correctness bound, not a service-level promise when connection or authoritative snapshot attempts fail.

The interval is fixed in code. It is not tied to review cadence and is not a setting or tool input. The minimum one-minute review cadence is longer than the reconciliation interval, so a missed working transition can be corrected before the first supervisor review decision.

### 7.2 Ordered fanout

A successful periodic snapshot is offered once to every current supervisor through the monitor's existing ordered dispatch chain. Snapshot reconciliation and socket event folding cannot mutate one supervisor concurrently.

The periodic read does not resubscribe, reset the stream, mark events observed, or open another long-lived connection. It uses one short-lived unary socket connection exactly like bootstrap and event-triggered reconciliation snapshots.

A socket event that arrives around the same time as a periodic snapshot can be covered first by either source. The pane revision watermark and projected status form the deduplication authority. A later event below an adopted snapshot revision is historical and ignored. An event at the adopted revision is ignored only when its status also matches; a same-revision status contradiction follows the gap rule below.

### 7.3 Exact identity, target-local validity, and revision rules

Every live supervisor evaluates the shared snapshot against its own complete bound identity. Snapshot extraction returns a typed target-local result rather than collapsing every non-unique lookup to `undefined`:

- `unique`: exactly one pane record exists for the bound pane ID, its required fields are valid, and there is at most one coherent target-local agent record.
- `absent`: no pane record and no agent record exists for the bound pane ID in an otherwise valid snapshot.
- `invalid`: duplicate bound-pane records, duplicate target-local agent records, an agent record without its pane, contradictory pane and agent identity fields, or a missing or malformed required target-local field.

A globally malformed `session.snapshot` response fails the shared attempt. An `invalid` target-local result fails reconciliation only for that supervisor. Neither result is absence evidence. A live supervisor preserves its last identity, revision, and status, enters visible reconciliation degradation with a bounded reason code, and never settles as closed, released, lost, or replaced from that evidence. Only a later valid target-local result can recover the episode.

A valid `absent` result settles under the existing pane-closed or identity-lost rule. A `unique` result can prove continuity, replacement, or release:

- A different terminal, name, kind, or complete session settles `identity_replaced`.
- An agent-free but otherwise continuous unique pane settles `released` under the existing contract.
- A complete continuous occupant enters the shared revision state machine.

For a full same-pane socket event after exact continuity succeeds:

- A revision below the watermark is a historical replay and is ignored.
- A revision equal to the watermark with equal status is a duplicate and is ignored.
- A revision equal to the watermark with changed status emits one high-priority `evidence_gap` with source `event` and reason `status_changed_without_revision`, adopts the status at the same watermark, and records the event transition.
- A revision exactly one greater than the watermark is the expected next event. It advances the watermark and applies status without a gap.
- A revision more than one greater than the watermark emits one high-priority `evidence_gap` with source `event`, reason `revision_jump`, previous and observed revisions, and the positive count of omitted intermediate revisions. It then advances the watermark and applies the event endpoint status.

A `pane_moved` destination revision is not compared with the origin pane watermark because revisions are pane-local. Existing exact move proof first rebases identity and watermark to the destination; later events and snapshots use the same rules there.

For a valid continuous snapshot occupant:

- Equal revision and equal status confirms currency without a transition or gap.
- Equal revision with changed status emits one high-priority `evidence_gap` with source `snapshot` and reason `status_changed_without_revision`, adopts the authoritative status at the same watermark, and records the snapshot transition.
- Any revision greater than the watermark proves that at least one revision reached authoritative state without being folded from the stream. It emits one high-priority `evidence_gap` with source `snapshot`, reason `revision_jump`, and previous and observed revisions, then adopts the snapshot revision and status.
- A revision lower than the watermark is never adopted. It starts a visible reconciliation-degraded episode as contradictory authoritative evidence.

A jump gap is emitted even when endpoint status equals the prior status. A child may have changed state and returned before the observed endpoint, so equal endpoint status does not prove that no lifecycle transition was missed. Gap deduplication is by the adopted watermark and status: once an endpoint is adopted, historical or exact duplicate evidence cannot emit the gap again.

When adopting a changed endpoint status, existing material transition rules still apply. For example, a periodic snapshot that corrects `working` to `done` records the snapshot transition and the existing work-cycle event in addition to the gap.

### 7.4 Reconciliation health

Periodic snapshot failure cannot remain a progress-only message. Each live supervisor exposes a bounded reconciliation health projection under `supervision.monitor`:

```ts
type ReconciliationFailureReason =
  | "connect_failed"
  | "request_failed"
  | "snapshot_protocol_invalid"
  | "duplicate_target_pane"
  | "duplicate_target_agent"
  | "orphan_target_agent"
  | "target_identity_contradiction"
  | "target_record_malformed"
  | "revision_regressed";

reconciliation: {
  intervalMs: 30_000;
  degraded: boolean;
  consecutiveFailures: number;
  lastAttemptAtMs?: number;
  lastSuccessAtMs?: number;
  lastFailureAtMs?: number;
  lastFailureReason?: ReconciliationFailureReason;
}
```

The first failed shared read, invalid target-local result, or contradictory lower revision in an episode emits one `reconciliation_degraded` material event and manager wake carrying only the fixed failure reason. Further failures saturate `consecutiveFailures` at `Number.MAX_SAFE_INTEGER`, update the last-failure fields, and do not duplicate the wake. No backend or protocol cause text enters the event or public view. `lastSuccessAtMs` advances only after a valid target-local result is reconciled for that supervisor; a globally successful snapshot containing malformed or duplicate local evidence is not success. The first later valid exact-identity reconciliation emits one `reconciliation_recovered` event, resets the counter, and clears the last failure reason.

`reconciliation_degraded` and `reconciliation_recovered` are added to the fixed `SupervisionEventType` vocabulary. They are not settling events. A reconciliation-degraded supervisor remains live, visible, and the semantic review owner. Its top-level supervision state is `degraded` until both event-stream health and periodic reconciliation health are healthy.

`supervision.monitor.connected` continues to describe the subscription connection only. `supervision.monitor.degraded` becomes the aggregate of event-stream and periodic reconciliation degradation. A connected stream with failed periodic snapshots therefore reports `connected: true`, `degraded: true`, and `reconciliation.degraded: true`. Recovery of one health source cannot set the supervisor active while the other remains degraded.

If periodic snapshots keep failing, stale status cannot be corrected, but the supervisor cannot claim healthy current observation. The degraded event, timestamps, and retry counter make that limitation visible, and the shared loop retries without a fallback transport at every interval.

### 7.5 Bound request target

Binding uses one internal prepare/commit transaction:

1. Capture the reserved public request snapshot.
2. Validate the authoritative bind snapshot and drain queued evidence without publishing `active` or `degraded`; remain `reserved` unless that evidence settles the supervisor.
3. Reject if the drain settled the supervisor or no longer proves the same live exact child.
4. Synchronously commit selected kind, selected profile, and `request.targetIds = [binding.identity.paneId]`.
5. Publish the supervisor as bound `active` or `degraded`, then resolve `SupervisionReservation.bind(...)`.

No asynchronous work or externally callable code runs between steps 4 and 5. If any earlier step fails, the request remains reserved. If step 4 or 5 throws after a provisional write, the coordinator restores the captured request before exposing the bind failure. `targets`, `targetIds`, and `target_generation_refs` remain aligned one-item arrays after success; after failure, the unbound request has the original reserved fields and `targetIds: []`.

`herdr_jobs get`, list summaries, Pi active-job views, and model projections therefore never report an empty bound target ID or a stale provisional target on a failed bind. The active-supervisor coverage query in section 8 uses the supervisor's live private identity, not `request.targetIds`; the public bind record cannot weaken exact matching.

## 8. Active-supervisor coverage seam

### 8.1 Internal query

The job registry gains one synchronous, read-only query for an exact identity. The concrete name may follow local naming, but its contract is fixed:

```ts
activeSupervisorFor(identity: SupervisedIdentity):
  | { jobId: string }
  | undefined
```

The query has no public tool exposure and does not mark soft receipts observed.

Coverage exists only when all of the following are true:

- The job kind is `supervisor`.
- The job has a bound supervision port.
- The supervisor is not settled and reports its exact child as live.
- The complete bound identity equals the wait target identity.

A reserved supervisor, a settled supervisor, a matching pane or name with a different session, or an incomplete wait identity does not cover the target. If more than one internal record matches the same exact identity, any live exact match is sufficient to avoid adding another wait reviewer. Existing launch uniqueness should make that condition exceptional.

`SupervisionJobPort` exposes only the internal exact-match predicate needed by the registry. The full session identity is never added to `JobDetail`, `herdr_jobs`, UI rows, or model-visible content.

### 8.2 Point-in-time coverage

`herdr_wait` evaluates coverage at each review cadence after its latest authoritative target observation and immediately before reviewer dispatch. Coverage is not frozen at wait registration.

A target whose supervisor settled since the previous cadence becomes unsupervised and is reviewed at the next cadence if the wait is still active. A target newly covered by an exact active supervisor is omitted from the explicit reviewer at that cadence.

Coverage state is a point-in-time ownership decision, not an authoritative target observation. It never bypasses target polling or alters timeout precedence.

## 9. Long-wait reviewer contract

### 9.1 Lazy reviewer construction

The wait reviewer is constructed only when a review cadence actually has at least one unsupervised target. Therefore:

- A long wait whose targets are all supervisor-covered does not resolve or authenticate the wait reviewer.
- On the MCP host, an all-covered long wait no longer fails only because the host lacks a wait reviewer model service.
- A mixed or fully unsupervised long wait keeps the existing fail-closed `REVIEWER_FAILED` behavior for the targets that require explicit review.

### 9.2 Target partition

At each cadence, `herdr_wait` partitions exact resolved targets into:

- `supervisorCovered`, carrying target, target ID, and supervisor job ID.
- `explicitReviewerTargets`, containing every target without exact active coverage.

Only `explicitReviewerTargets` produce `ReviewerRequest` values. Those requests remain concurrent and uncapped, preserve the existing 100-line bound, and use transcript deltas since that target's last explicit wait review.

A covered target does not advance its explicit-review transcript baseline. If it later becomes unsupervised, its next explicit review receives the bounded delta from its last explicit review, or up to the current 100-line window if it has never been explicitly reviewed.

Supervisor reviewer summaries remain on the supervisor job. They are not copied into wait reviewer summaries.

### 9.3 Public semantic-review ownership projection

Ordinary `JobProgress.details` is capped at 256 bytes and can be replaced by a truncation envelope. It cannot carry the ownership contract. `JobDetail` therefore gains a dedicated, independently bounded field for wait jobs:

```ts
interface WaitSemanticReviewProjection {
  observedAtMs: number;
  supervisorCovered: Array<{
    target: string;
    targetId: string;
    supervisorJobId: string;
  }>;
  explicitReviewerTargetIds: string[];
  omittedSupervisorCovered: number;
  omittedExplicitReviewerTargetIds: number;
}

interface JobDetail {
  // Existing fields omitted.
  semanticReview?: WaitSemanticReviewProjection;
}
```

`JobOperationControl.publishSemanticReview(...)` is the typed internal write seam. At every review cadence, after exact coverage partitioning and before reviewer dispatch, `herdr_wait` publishes one projection through that control. The registry accepts updates only for an open wait-job gate, clones and bounds the value before storage, and notifies observers; a supervisor-job call is rejected. Terminal jobs retain the last accepted projection. Progress text or details may summarize ownership, but they are never its public authority.

The public `herdr_jobs get` detail preserves `semanticReview` independently from `progress.details`; progress truncation cannot erase or reshape it. The field is absent before the first cadence and on supervisor jobs. It is not added to the compact job-list summary.

The projection uses fixed structural bounds: at most six `supervisorCovered` entries, at most eight explicit reviewer target IDs, target strings and target IDs capped at 128 UTF-8 bytes, supervisor job IDs capped at 64 bytes, and total serialized size capped at 4,096 bytes. Tail omission increments the two explicit omitted counts. If the final size still exceeds the cap, entries are removed from the tail until the typed object fits; the whole field is never replaced by an opaque truncation marker.

This projection explains why a long wait may have no wait reviewer summaries. It does not change the public `herdr_wait` input schema, acknowledgement, `wait_result`, or `herdr_jobs` operations.

### 9.4 Reviewer `unknown`

A reviewer result is advisory until Tools performs the post-review authoritative refresh needed for settlement precedence. Condition and timeout refresh still runs first.

Suppressing `unknown` then requires a fresh authoritative agent-state proof obtained after the review response:

1. Map the reviewer target ID to one resolved exact wait identity.
2. Obtain an `agent get <paneId>` result after the review through the existing bounded `readFreshAgent` path under the wait deadline, abort signal, and job activity gate. The post-review state-condition path already returns this proof. The strict output-condition read may reuse its final post-output identity-validation agent record only after that record's explicit state is retained in the private observation; otherwise it performs a dedicated read.
3. Revalidate the complete returned occupant identity against the wait's captured identity.
4. Derive state from the agent record's explicit authoritative state field.

An output-condition observation's pane metadata and output match cannot satisfy this proof. Output waits must surface or obtain the post-review exact agent result before suppressing `unknown`, even when public output metadata says `working`. Previous observations, reviewer metadata, supervisor status, and incomplete identities are also insufficient.

For a known reviewed target:

- `stalled`, `blocked`, and `risk` still require manager judgment when the authoritative condition has not already settled.
- `appears_complete` and `progress` remain non-terminal.
- `unknown` is stored in reviewer summaries and progress, but it does not require manager judgment only when the fresh exact agent read proves `working`.
- `unknown` still requires manager judgment when the target cannot be mapped exactly or the fresh exact agent state is `unknown`, `idle`, `blocked`, or `done` and the requested condition remains unmet.
- Missing, malformed, timed-out, or identity-contradictory authoritative agent reads cannot suppress `unknown`; they retain the existing target-read failure and deadline precedence.

If an `unknown` review is the only attention classification and every corresponding target is freshly proven working, the wait continues. A later authoritative condition match, timeout, target error, stronger reviewer classification, or cancellation settles it under existing precedence.

For mixed reviewer results, any unsuppressed `stalled`, `blocked`, `risk`, or qualifying `unknown` can still produce `manager_judgment_required`.

## 10. Manager guidance

The shared manager role skill and README must say:

- Record both pane ID and supervisor job ID as soon as launch reports them.
- `PROMPT_UNCONFIRMED` after a successful bind means assignment state is unconfirmed, not that the child is unwatched.
- Inspect the exact pane with `herdr_inspect` and the supervisor with `herdr_jobs get`.
- Do not relaunch, resend, close or reuse the pane, register it as an assignment-capable recipient, or continue dependent success assertions.
- Continue recovery through the existing child and supervisor evidence.
- `SUPERVISION_UNCONFIRMED` from the bind phase remains the distinct case where binding itself was not proven and no assignment was sent.
- A healthy event subscription is not sufficient currency evidence by itself. `herdr_jobs get` exposes the last periodic reconciliation, reconciliation health, and any `evidence_gap`.
- An active supervisor request has `targetIds: [paneId]`. Record or report an empty active `targetIds` array as a Tools contract failure.
- A `reconciliation_degraded` event means current status may be stale. Inspect the child authoritatively and do not treat silence as idle.
- Long waits still evaluate their conditions. Active supervisors own semantic review for their exact children, while unsupervised targets retain the explicit wait reviewer. `herdr_jobs get` exposes the last bounded ownership decision in `semanticReview` independently from progress truncation.
- Supervisor reviewer findings and degradation remain on supervisor jobs and wakes. They are not copied into wait results.
- A wait reviewer `unknown` does not override `working` only after a post-review exact authoritative agent read proves that state; output metadata alone is insufficient, although the strict output read's final agent record may supply the proof.

The obsolete statement that any prompt-unconfirmed child is left unwatched must be removed. No compatibility wording presents both behaviors as valid.

## 11. Security and bounds

The existing redaction and bounding rules remain mandatory.

- The new coverage query and every periodic reconciliation compare full identity only in memory.
- One bounded periodic snapshot is shared across supervisors, and its raw topology is never copied into every job.
- Reconciliation health exposes fixed timestamps, counters, interval, and event literals only.
- Full identity and session fields do not enter the bounded `semanticReview` projection, reconciliation health, gap details, or launch diagnostics.
- Model-visible supervisor and pane IDs pass through the existing printable single-line and byte bounds.
- `assignmentState` and recovery guidance are fixed literals.
- Prompt text is never copied into errors, job progress, supervisor events, or test failure logs.
- MCP continues to ignore rich launch error details.
- TUI rows contain only fixed prose and bounded IDs.
- Integration diagnostics record bounded structured evidence before fixture teardown and never print the assignment body.

## 12. Acceptance criteria

### Periodic reconciliation and job identity

- **AC-S1:** With one or more live supervisors, the monitor schedules exactly one shared periodic `session.snapshot` attempt on monotonic due times 30,000 ms apart and never one attempt per child. Completion time does not shift the next due time, and delayed ticks do not burst.
- **AC-S2:** No connect-plus-request attempt overlaps another. The loop stops with no observers and on session shutdown, and it leaves no referenced timer.
- **AC-S3:** Every successful periodic snapshot is reconciled against each live supervisor's complete exact identity through the ordered event and snapshot mutation chain.
- **AC-S4:** A full same-pane event at watermark plus one advances normally. A jump above watermark plus one emits exactly one source-`event` `evidence_gap` with previous revision, observed revision, and omitted intermediate count before adopting the endpoint. Equal duplicate events stay silent; equal-revision status contradictions emit one gap and adopt status. Destination pane revisions are not compared across a proven move.
- **AC-S5:** A valid continuous snapshot at equal revision and status stays silent. A same-revision status mismatch or any higher snapshot revision emits exactly one source-`snapshot` gap and adopts authoritative endpoint status. A lower revision is not adopted.
- **AC-S6:** A missed `idle` to `working` socket transition is corrected by the next successful periodic snapshot, records source `snapshot`, and cannot remain stale beyond 45 seconds under the fixed 30-second interval, 5-second connect bound, and separate 10-second request bound.
- **AC-S7:** Only valid unique or absent target-local snapshot results can settle missing, released, or replaced occupants under existing exact-identity rules.
- **AC-S8:** A globally malformed snapshot or duplicate, contradictory, or malformed target-local evidence never settles a live supervisor. It preserves the last projection and enters visible reconciliation degradation with a bounded reason.
- **AC-S9:** Snapshot or target-local failure emits one `reconciliation_degraded` event per episode, retries without overlap, exposes bounded health, and emits one `reconciliation_recovered` event only after a later valid target-local reconciliation.
- **AC-S10:** A reconciliation-degraded but live supervisor remains the semantic review owner and is visibly `degraded`. No CLI or reviewer fallback starts.
- **AC-S11:** Successful bind drains queued evidence while the public supervision view remains `reserved`, proves the exact child remains live and the supervisor non-settled, then synchronously publishes selected kind, selected profile, `request.targetIds: [exactPaneId]`, and bound state. No active or degraded bound view is observable before all those conditions hold.
- **AC-S12:** Any bind failure, including settlement during queued-evidence drain or a failed request/state commit, rejects and restores the reserved request with `targetIds: []` before the failure is observable.
- **AC-S13:** `targets`, `targetIds`, and `target_generation_refs` remain aligned one-item arrays after successful bind, and public job projections expose the exact bind pane without exposing full identity.

### Launch and supervision

- **AC-L1:** Supervision reservation still completes before the first topology mutation.
- **AC-L2:** After exact readiness, `reservation.bind(...)` is called exactly once before optional focus and before any `agent prompt` dispatch, and launch treats it as successful only after queued-evidence drain and transactional bind commit complete.
- **AC-L3:** A bind failure sends no focus or prompt mutation, registers no recipient, performs no retry or child cleanup, releases only the unbound reservation, and exposes no provisional target ID.
- **AC-L4:** After bind succeeds, no later launch failure calls reservation release, supervisor cancel, or supervisor shutdown.
- **AC-L5:** An assignment-unconfirmed launch sends exactly one prompt and starts exactly one selected agent. It sends no Enter or second prompt.
- **AC-L6:** The assignment-unconfirmed error remains a thrown `LAUNCH_FAILED` with rich `causeCode: "PROMPT_UNCONFIRMED"`, `phase: "prompt_verification"`, `assignmentState: "unconfirmed"`, `recipientRegistered: false`, exact pane ID, and retained active supervisor details.
- **AC-L7:** The fixed model diagnostic for AC-L6 contains the exact pane ID, supervisor job ID, `assignmentState: "unconfirmed"`, and fixed recovery guidance.
- **AC-L8:** The diagnostic remains parseable and within 8,192 bytes. It contains no prompt body, environment value, cause text, backend text, output, profile body, or agent-session value.
- **AC-L9:** The MCP adapter publishes the fixed fields and no attached launch details. Malformed conditional fields suppress the diagnostic rather than weakening validation.
- **AC-L10:** Pi renders the exact compact assignment-unconfirmed row and does not render a success or generic unsupervised state.
- **AC-L11:** Recipient registration and launch success occur only after semantic confirmation. Integration code performs no marker, wait, communicate, or other dependent assertion after an unconfirmed assignment.
- **AC-L12:** A launch missing the mandatory typed `assignment`, or supplying an empty, NUL-bearing, extra, or legacy `initialPrompt`/`initialPromptDelivery` field, is rejected before any mutation, reservation, or attachment publication.
- **AC-L13:** Queued pane closure, release, proven replacement, or identity-loss evidence that settles during bind makes bind reject. Launch emits `SUPERVISION_UNCONFIRMED`, dispatches no prompt, and cannot report or retain a successful bound state.

### Wait review ownership

- **AC-W1:** Coverage requires the complete exact identity and a live bound supervisor. Reserved, settled, incomplete, pane-only, name-only, and replacement identities do not suppress wait review.
- **AC-W2:** Coverage is recomputed at every review cadence without observing supervisor soft receipts.
- **AC-W3:** An all-covered long wait performs zero wait reviewer factory calls and zero wait reviewer model calls while continuing authoritative polling to condition match or timeout.
- **AC-W4:** A mixed long wait reviews each unsupervised target exactly once per cadence and reviews no covered target.
- **AC-W5:** A target that loses active coverage is reviewed at the next cadence using a bounded transcript delta. A target that gains coverage is omitted at the next cadence.
- **AC-W6:** A degraded but live exact supervisor remains the review owner. Its degradation stays visible through its own job and no hidden wait-review fallback starts.
- **AC-W7:** After each cadence decision, public `herdr_jobs get` exposes typed `JobDetail.semanticReview.supervisorCovered` and `explicitReviewerTargetIds` through the dedicated job-control seam. The field survives independently when `progress.details` exceeds its 256-byte bound and becomes a truncation envelope.
- **AC-W8:** A sole `unknown` review is retained but does not settle only after a post-review exact authoritative agent read proves the same occupant is `working`. This proof is required for state and output conditions; output metadata alone cannot suppress `unknown`, but a strict output read may reuse its final exact agent record when it retains the authoritative state privately.
- **AC-W9:** `stalled`, `blocked`, `risk`, and a qualifying non-working or unmapped `unknown` retain manager-judgment behavior after authoritative condition, timeout, and target-read precedence.
- **AC-W10:** Supervisor events and reviews never directly set `wait_result` and never appear as wait reviewer summaries.
- **AC-W11:** The semantic-review projection obeys its entry, field, and 4,096-byte bounds, reports exact tail omission counts, retains a typed shape, and accepts no late update after the job gate closes.

### Documentation and scope

- **AC-D1:** `SPEC.md`, `README.md`, `docs/specs/auto-child-supervision.md`, and the shared manager skill describe the new bind order, periodic reconciliation, exact bound target ID, review ownership, and recovery without preserving the obsolete behavior.
- **AC-D2:** No public schema, setting, tool count, tool name, or Herdr core file changes.
- **AC-D3:** Tests explicitly prove no duplicate prompt, no launch cleanup, no secret leakage, no hidden event-path revision jump, no indefinitely stale status after a missed transition while snapshots succeed, no settlement from malformed or duplicate snapshot evidence, no successful bind after queued settlement, no stale provisional target ID after bind failure, no truncation-erased review ownership, and no post-bind identity-proven child losing supervision because launch failed.

## 13. Test strategy

Tests are written or changed before each runtime slice.

### 13.1 Launch unit tests

Update `test/unit/launch.test.ts` to cover:

- Bind call order before focus and prompt.
- Queued pane closure, release, replacement, and identity-loss settlement during bind drain; each case rejects binding and dispatches no focus or prompt.
- Prompt timeout, post-ack read failure, caller abort, acknowledgement parse failure, focus failure, and recipient failure after binding.
- No release after a successful bind on every later failure path.
- Release only when reservation never bound, with no provisional target ID left on the failed request.
- Exactly one start, one prompt stdin call, and no Enter, close, kill, retry, or fallback after prompt dispatch.
- Recipient absence and no success result for unconfirmed assignment.
- Rich details and fixed diagnostic fields for same-tab, new-tab, and existing-pane placement.
- Prompt body, environment, backend, output, and session canaries absent from `Error.message` and serialized results.

Replace the obsolete test named `binds only after the prompt was submitted and its consumption confirmed` with tests that require binding immediately after readiness and before prompt submission.

### 13.2 Periodic reconciliation and target ID unit tests

Use fake monitor time and two or more real supervisor observers.

Cover:

- One shared timer and one unary snapshot per interval regardless of supervisor count.
- No snapshot before an observer exists, no overlap while a read is pending, and complete timer cleanup after the last observer and shutdown.
- Ordered event and periodic snapshot application around the same revision.
- Same-pane event revision plus one without a gap, event revision jumps with one source-`event` gap and exact omitted count, duplicate event silence, same-revision event status contradiction, and no cross-pane jump inference during a proven move.
- A supervisor anchored `idle` with no socket event whose next authoritative snapshot reports the exact child `working` at a higher revision. The test must prove one source-`snapshot` gap, one snapshot transition, adopted working status, and no stale idle projection.
- A higher snapshot revision with the same endpoint status still produces one gap.
- Same snapshot revision with the same status stays silent, while same revision with a changed status emits a gap and adopts the status.
- A virtual-time worst case using fixed scheduled due times: the transition is omitted at one attempt boundary, the next attempt is due 30 seconds later, connect consumes 5 seconds, and the request consumes 10 seconds. Convergence occurs by 45 seconds. A separate test proves the next due time is not shifted to 30 seconds after completion and delayed ticks do not burst.
- Lower revision degradation, exact replacement, release, and valid pane absence.
- Duplicate target pane records, duplicate target-local agent records, orphan target agents, contradictory local identity, missing required local fields, and a globally malformed snapshot each degrade without settling or changing the last projection, and each maps to its fixed public reason without raw cause text.
- Snapshot timeout, repeated failure, valid target-local recovery, bounded reconciliation timestamps, and counters in `herdr_jobs get`.
- The public supervision view remains `reserved` while queued evidence drains, then atomically publishes selected profile, selected kind, `targetIds: [paneId]`, and bound state.
- Drain settlement and injected request/state commit failures reject bind, restore `targetIds: []`, and expose no bound active or degraded state.
- One-item alignment of target names, IDs, and generation references after successful bind.

### 13.3 Coverage and wait unit tests

Use real `JobRegistry` and supervisor ports where practical.

Cover:

- Exact identity match and every mismatch field.
- Reserved, active, degraded, and settled supervisor states.
- Coverage query does not consume pending events.
- All-covered, mixed, coverage-lost, and coverage-gained waits.
- Lazy reviewer construction, including MCP-like unavailable reviewer behavior.
- Transcript baseline preservation while covered.
- Dedicated `JobDetail.semanticReview` publication after each cadence, independent survival when progress details truncate at 256 bytes, fixed entry and byte bounds, exact omitted counts, terminal retention, and rejection of late publication.
- Working `unknown` continuation, later condition success, later timeout, mixed classifications, unknown target IDs, and non-working `unknown` manager judgment.
- State-condition reuse of its fresh post-review exact agent read and output-condition retention of authoritative state from its final post-output exact agent record, with a dedicated `agent get` only when that proof is unavailable. Stale output metadata that says `working` must not suppress when the agent read says otherwise; output metadata that is non-working must not override an exact agent read that proves `working`.
- Missing, malformed, timed-out, and identity-replaced agent reads retain target-read or deadline precedence and cannot suppress `unknown`.
- Existing deadline, target-read, cancellation, and condition precedence after the partitioning change.

### 13.4 Model and UI tests

Update MCP and TUI tests to cover:

- Exact conditional diagnostic shape.
- Invalid or partial new fields rejected.
- Fixed recovery allowlist.
- Hostile attached details and prompt canaries never published.
- Exact compact Pi row.
- Existing launch diagnostics without assignment uncertainty still accepted without the three optional fields.

### 13.5 Disposable integration

In `test/integration/herdr-tools.integration.test.ts`, preserve the existing rule that a prompt launch is either semantically confirmed or exact fail-closed `PROMPT_UNCONFIRMED`.

For the unconfirmed branch, additionally assert:

- one stdin prompt dispatch
- no dependent marker or communication
- exact pane ID and supervisor job ID in failure evidence
- `assignmentState: "unconfirmed"`
- `herdr_jobs get` finds the retained supervisor as non-settled for the still-live exact child
- the bound supervisor request reports `targetIds: [paneId]`
- reconciliation health is present and bounded
- fixture teardown happens only after diagnostics and is harness-owned, never launch cleanup

The integration remains disposable-session only. It must not run against the active Herdr session.

## 14. Implementation slices

Each slice changes at most five files.

- [ ] **Slice 1: Add the one session-level periodic snapshot loop**
  - Files: `src/supervision/monitor.ts`, `src/supervision/events.ts`, `test/unit/supervision-monitor.test.ts`, `test/unit/supervision-events.test.ts`
  - Acceptance: AC-S1, AC-S2, and the shared-attempt portion of AC-S9.
  - Verify: `npx vitest run --coverage.enabled=false test/unit/supervision-monitor.test.ts test/unit/supervision-events.test.ts`

- [ ] **Slice 2: Reconcile valid evidence and expose every revision gap**
  - Files: `src/supervision/identity.ts`, `src/supervision/supervisor.ts`, `src/supervision/state.ts`, `test/unit/supervision-identity.test.ts`, `test/unit/supervisor.test.ts`
  - Acceptance: AC-S3 through AC-S10.
  - Verify: `npx vitest run --coverage.enabled=false test/unit/supervision-identity.test.ts test/unit/supervisor.test.ts`

- [ ] **Slice 3: Make bind and exact target publication transactional**
  - Files: `src/supervision/supervisor.ts`, `src/supervision/registry.ts`, `src/job-registry.ts`, `test/unit/supervisor.test.ts`, `test/unit/supervision-registry.test.ts`
  - Acceptance: AC-S11 through AC-S13 and AC-L13.
  - Verify: `npx vitest run --coverage.enabled=false test/unit/supervisor.test.ts test/unit/supervision-registry.test.ts`

- [ ] **Slice 4: Expose exact active-supervisor coverage and public projection**
  - Files: `src/supervision/state.ts`, `src/supervision/supervisor.ts`, `src/job-registry.ts`, `test/unit/supervision-registry.test.ts`, `test/unit/supervision-projection.test.ts`
  - Acceptance: AC-W1 and AC-W2, plus the bound target projection portion of AC-S13.
  - Verify: `npx vitest run --coverage.enabled=false test/unit/supervision-registry.test.ts test/unit/supervision-projection.test.ts`

- [ ] **Slice 5: Partition wait review and publish structured ownership**
  - Files: `src/tools/wait.ts`, `src/job-registry.ts`, `test/unit/wait.test.ts`, `test/unit/job-registry.test.ts`
  - Acceptance: AC-W3 through AC-W11.
  - Verify: `npx vitest run --coverage.enabled=false test/unit/wait.test.ts test/unit/job-registry.test.ts`

- [ ] **Slice 6: Bind launch supervision at identity proof**
  - Files: `src/tools/launch.ts`, `test/unit/launch.test.ts`, `test/unit/supervision-fixtures.ts`
  - Acceptance: AC-L1 through AC-L6 and AC-L11 through AC-L13.
  - Verify: `npx vitest run --coverage.enabled=false test/unit/launch.test.ts`

- [ ] **Slice 7: Publish the assignment-unconfirmed model and Pi UI contract**
  - Files: `src/mcp/adapter.ts`, `src/tui.ts`, `test/unit/mcp-adapter.test.ts`, `test/unit/tui.test.ts`
  - Acceptance: AC-L7 through AC-L10.
  - Verify: `npx vitest run --coverage.enabled=false test/unit/mcp-adapter.test.ts test/unit/tui.test.ts`

- [ ] **Slice 8: Prove the disposable-session recovery path**
  - Files: `test/integration/herdr-tools.integration.test.ts`
  - Acceptance: the integration requirements in section 13.5 and AC-D3.
  - Verify: `HERDR_TOOLS_RUN_INTEGRATION=1 npm run test:integration -- --session herdr-tools-integration`

- [ ] **Slice 9: Replace current product and manager guidance**
  - Files: `SPEC.md`, `README.md`, `docs/specs/auto-child-supervision.md`, `herdr-profiles/role-plugins/manager/skills/manager/SKILL.md`
  - Acceptance: AC-D1 and AC-D2.
  - Verify: `git diff --check && npm run validate:plugin`

- [ ] **Slice 10: Run full release validation**
  - Files: no source changes unless a preceding slice fails its own acceptance criteria.
  - Acceptance: every acceptance criterion in section 12.
  - Verify: all commands in section 15.

## 15. Commands

Run from `/home/gabriel/.pi/agent/extensions/herdr-tools`, or the corresponding repository worktree root.

Targeted tests:

```bash
npx vitest run --coverage.enabled=false \
  test/unit/launch.test.ts \
  test/unit/supervision-monitor.test.ts \
  test/unit/supervision-events.test.ts \
  test/unit/supervision-identity.test.ts \
  test/unit/supervisor.test.ts \
  test/unit/supervision-registry.test.ts \
  test/unit/supervision-projection.test.ts \
  test/unit/job-registry.test.ts \
  test/unit/wait.test.ts \
  test/unit/mcp-adapter.test.ts \
  test/unit/tui.test.ts
```

Full validation:

```bash
npm run test:unit
npm run typecheck
npm run lint
npm run build
npm run build:mcp
npm run validate:plugin
HERDR_TOOLS_RUN_INTEGRATION=1 npm run test:integration -- --session herdr-tools-integration
git diff --check
```

This repository has no configured Markdown-specific checker. Do not add one for this change. Documentation verification uses link inspection, `git diff --check`, plugin validation for the manager skill package, and the full repository gates above.

## 16. Trade-offs

### Periodic snapshots add fixed socket load

ADR-019 made snapshots strictly on demand after a redundant per-launch read disturbed a clientless server. Stream-only observation has now produced a stale active supervisor, so zero periodic reads is no longer acceptable. One shared snapshot every 30 seconds adds constant session-level load rather than load proportional to child count. A shorter interval would reduce staleness but raise socket pressure. A longer interval could let stale state survive into the minimum one-minute review cadence. Keeping the 30-second interval yields a proven 45-second end-to-end stale bound because each attempt also has separate 5-second connection and 10-second request bounds.

### Revision gaps are deliberately conservative

Pane revision can advance for output as well as lifecycle status. An event jump or periodic snapshot advance can therefore emit `evidence_gap` when endpoint status did not change. Suppressing that gap would falsely claim that no hidden lifecycle transition occurred and returned to the same state. The design prefers a bounded visible false positive over silent stale evidence.

### Reconciliation failure degrades rather than falls back

A failed periodic snapshot does not close a healthy event subscription and does not start CLI polling. Globally malformed or invalid target-local evidence is treated as failure rather than absence because settling a live child from ambiguous topology is worse than temporarily preserving stale state. Reconciliation health becomes degraded, retries on the next fixed interval, and preserves the last proven status with explicit timestamps. Current status can remain stale while valid authoritative evidence is unavailable, but it cannot remain silently stale.

### Earlier binding adds no new authority

Binding moves earlier, but it still uses the same exact readiness identity and the supervisor's authoritative bind snapshot. The two-phase prepare/commit adds a small internal transaction so queued evidence can settle the supervisor before any bound state or target ID is published. The change does not let launch infer supervision from a start response. The cost is that a supervisor can exist for a launch that later reports assignment failure. That retained job is the intended safety record.

### A tool error can leave a healthy active job

A prompt-unconfirmed launch now returns an error while its supervisor remains active. This is unusual but truthful. Tool success describes assignment acceptance. Supervisor activity describes lifecycle observation. Collapsing those states would either report false launch success or discard supervision.

### Supervisor degradation does not trigger a hidden fallback

A degraded active supervisor still owns semantic review. This can leave a long wait without a successful semantic classification until the supervisor reviewer recovers. The degradation is visible and recoverable through `herdr_jobs`. Starting the wait reviewer as a fallback would hide the failure and restore duplicate review.

### Wait and supervisor evidence remain separate

A supervisor may wake the manager while a related wait remains active. The manager must inspect the supervisor job rather than expecting its findings inside the wait result. This keeps the wait predicate authoritative and avoids inventing cross-job settlement semantics.

### `unknown` can extend a wait

A reviewer that cannot classify an authoritatively working child no longer ends the wait by itself. Output-condition waits must retain authoritative status from their final post-output exact agent record, or pay for a dedicated post-review `agent get` when that proof is unavailable, because composite output metadata is not sufficient. The wait may continue to its timeout. This favors fresh exact lifecycle state over model uncertainty and avoids false manager-judgment settlement.

### Review ownership needs a dedicated public field

A separate `JobDetail.semanticReview` field adds public response surface and up to 4,096 bounded bytes to a wait detail. Reusing progress would be smaller, but its 256-byte truncation contract can erase the ownership explanation entirely. The dedicated typed field keeps the decision inspectable and uses explicit omission counts instead of exposing unbounded target data.

### Coverage is sampled, not locked

Coverage is checked immediately before reviewer dispatch. A supervisor can settle just after that check, which can defer explicit review until the next cadence. Target polling continues, supervisor settlement remains visible, and no cross-registry lock is introduced. A lock would add lifecycle coupling without making Herdr state atomic.

### Model diagnostics expose only control handles

Pane and supervisor job IDs become model-visible because they are required for safe recovery. Full identity, session, prompt, output, and cause evidence stay excluded. This gives the model enough authority to inspect the existing child without widening the secret boundary.

## 17. Boundaries

Always:

- Preserve exact identity comparison and authoritative condition reads.
- Reconcile every live supervisor from the one bounded session-level periodic snapshot loop.
- Make every unobserved revision advance gap-visible whether first observed by event or snapshot, and adopt its authoritative endpoint.
- Preserve live state and degrade when target-local snapshot evidence is malformed, duplicate, or contradictory.
- Publish the exact bind pane in a bound supervisor request's `targetIds` only in the successful bind commit, with rollback on failure.
- Bind before any post-readiness mutation, and reject if queued evidence settles during bind.
- Keep prompt submission single-shot.
- Keep model output fixed, bounded, and redacted.
- Keep supervisor and wait settlement independent.
- Run targeted tests before each slice commit and full validation before completion.

Never:

- Modify Herdr core.
- Add a compatibility alias, stream-only mode, or dual phase order.
- Open one periodic snapshot loop per supervisor or poll the CLI as a fallback.
- Leave periodic snapshot failure as an unobservable progress string.
- Treat malformed or duplicate target-local snapshot evidence as pane absence.
- Accept an event revision jump without one gap event.
- Publish a bound active supervisor with empty `targetIds` or leave a provisional target ID after failed bind.
- Treat reservation or bind preparation as active coverage.
- Infer coverage from pane ID or name.
- Retry or clean up an uncertain prompt launch.
- Register a recipient or report dependent success before assignment confirmation.
- Publish rich launch error details at the MCP boundary.
- Start a wait reviewer for a supervisor-covered target.
- Hide review ownership only inside truncatable progress details.
- Suppress reviewer `unknown` for an output wait from pane or composite metadata without a fresh post-review exact agent proof.
- Let reviewer output satisfy the authoritative wait condition.

## 18. Open questions

None. The behavior and trade-offs above are approved. Any implementation discovery that contradicts an invariant in this document must stop the affected slice and return for review rather than add a fallback.
