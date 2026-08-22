# ADR-015: Require semantic consumption confirmation for launch initial prompts

## Status

Accepted; supersedes `docs/decisions/013-prompt-submission-acknowledgement.md`.

ADR-013 correctly prohibited resubmission and Enter recovery, but its
`agent_prompted` acknowledgement was too weak for `herdr_launch.initialPrompt`.
This ADR retains the single-submit communication contract while making launch
assignment success require semantic prompt-consumption evidence. ADR-016 supersedes
only this ADR's pre-submit readiness and one-shot baseline references; the separate
post-acknowledgement 5,000 ms semantic confirmation defined here remains accepted.

## Date

2026-08-22

## Context

Herdr protocol 20 `cli:agent:prompt` / `agent_prompted` proves that Herdr injected
stdin plus Enter into the selected terminal. It does not prove that the agent TUI
consumed the prompt or began a turn.

A disposable exact `worker-pi` launch into a new tab demonstrated the gap. Agent
start and the identity-bound prompt acknowledgement both succeeded, but Pi stayed
idle for 60 seconds. It produced no Bash marker, model activity, tool activity, or
other evidence that the assignment was consumed. Treating that launch as successful
registered a recipient and handed the manager a worker that had never accepted its
assignment.

Resubmitting the prompt, restarting the agent, sending Enter, or cleaning up the
pane is unsafe after terminal injection. Any of those mutations could duplicate a
partially consumed assignment or destroy evidence about an uncertain effect.

## Decision

`herdr_launch.initialPrompt` submits the provenance-wrapped assignment exactly once.
The prompt-confirmation phase never invokes or retries prompt submission or agent
start, sends a recovery key, falls back after prompt submission, or automatically
cleans partial resources. Existing zero-assignment start fallback remains governed
by ADR-008 and can occur only before one profile successfully starts.

ADR-016 replaces the former five-second identity preflight plus later one-shot
baseline read with one condition-based readiness loop under the selected
agent-start attempt's existing absolute 120,000 ms budget. Each fresh sample is
ordered snapshot, `agent get`, then pane get, carries no record across samples, and is
evaluated only after all three reads complete. Fixed diagnostics retain completed
current-sample projections, including agent evidence when the pane read fails, without
using that incomplete sample for readiness. For submission readiness, that same
sample's authoritative `agent get` record must
independently contain the exact captured pane, terminal, name, kind, and complete
agent-session identity plus:

- `agent_status: "idle"`;
- safe non-negative `state_change_seq`; and
- safe non-negative `revision`.

As clarified by ADR-016, every non-null lifecycle value from start and readiness
records is shape-validated. Valid start lifecycle values are older process-start
observations and never overwrite or veto the fresh agent-get anchor. Same-sample
snapshot and pane lifecycle values must agree with the anchor when supplied, but a
valid same-identity disagreement is sequential skew: discard the sample and resample
without field merging or submission. Missing/null anchor metadata and valid non-idle
state are also pending. Malformed lifecycle shapes, duplicate records, contradictory
identity, or replacement is terminal. The readiness result returns one accepted
coherent baseline; there is no later one-shot baseline read.

After one exact identity-bound `agent_prompted` acknowledgement, launch runs a
separate read-only confirmation loop for exactly the existing maximum 5,000 ms at a
100 ms cadence. This window neither reuses nor extends the startup-readiness budget. Each sample
performs sequential `agent get` then `pane get` reads under one shared cancellation
window. No record is carried between samples. The `agent get` record is the sole
coherent source for `agent_status`, `state_change_seq`, and `revision`; `pane get`
proves identity continuity only. Lifecycle fields are never selected or merged
field-by-field across records.

A sample confirms consumption only when the complete pane, terminal, name, kind,
and agent-session identity still matches, `agent_status` is a known working or
non-working state (`working`, `idle`, `blocked`, or `done`), `state_change_seq` is
strictly greater than the pre-submit baseline, and `revision` is present and has not
regressed from either the baseline or acknowledgement. This covers an observed
working turn and a fast turn that settled between samples under the same rule.

`unknown`, missing lifecycle fields, an unchanged or regressed sequence, and a
missing or regressed revision remain unconfirmed and polling continues until the
bounded deadline while identity remains coherent. `screen_detection_skipped` is
diagnostic only: it never validates, confirms, contradicts, or rejects a sample and
is included only when it is a valid bounded boolean. Replacement, disappearance,
contradictory identity/lifecycle evidence, or a read/protocol failure fails closed
immediately.

A confirmation timeout or any post-ack inability to prove consumption returns
`LAUNCH_FAILED` with `causeCode: "PROMPT_UNCONFIRMED"` and
`phase: "prompt_verification"`. This means **consumption was not proven and the
acknowledged prompt was possibly consumed**; it does not mean the prompt was safely
unconsumed. Evidence records:

- `promptSubmitted: true` and `promptConsumption: "unconfirmed"`;
- the bounded exact acknowledgement/submission evidence;
- baseline and last observed state, `state_change_seq`, and `revision` when present;
- sample count, elapsed time, 5,000 ms window, and 100 ms cadence;
- the terminal reason and bounded source code; and
- all created resource IDs already known to launch.

Caller abort after acknowledgement is represented through the same effect-preserving
failure with reason `caller_aborted`; it cannot erase the acknowledged submission or
turn the outcome into a zero-effect abort. No recipient is registered until semantic
confirmation succeeds. A successful launch reports `promptSubmitted: true`,
`promptConsumption: "confirmed"`, the final observation, and the confirmation
evidence.

`herdr_communicate` remains a one-submit, acknowledgement-based operation. It does
not wait for semantic consumption because prompt and steer are intentionally
non-blocking communication primitives. Its optional observation now reports working,
non-working, unknown, stale, or unavailable state; `screen_detection_skipped` is a
diagnostic field rather than its own state classification.

## Alternatives considered

### Treat `agent_prompted` as launch assignment success

Rejected. It proves terminal injection only and reproduced a false-success launch
whose Pi worker never consumed the assignment.

### Wait only for `working`

Rejected. A fast turn can enter and leave working state between 100 ms samples.
Working is also not sufficient without a lifecycle transition after the idle
baseline. Every confirming state therefore requires the same strictly advanced
sequence and non-regressed revision evidence.

### Use revision advancement as the receipt

Rejected. Revision describes terminal observation and may change independently of a
turn. It remains diagnostic and guards stale reads; consumption depends on working
state or an advanced `state_change_seq`.

### Retry prompt submission, start, or Enter after timeout

Rejected. Terminal injection already occurred. A second mutation is not idempotent
and could duplicate or corrupt the assignment.

### Register the attachment recipient after acknowledgement

Rejected. Registration would advertise an assignment-capable recipient before the
launch proved that its initial assignment was consumed.

## Consequences

- Launch success means the exact started agent produced the required post-baseline
  lifecycle evidence, not merely that bytes reached its terminal.
- Tools-only telemetry has an explicit availability cost: a valid fast turn can be
  consumed without an observable counter advance. That launch intentionally returns
  `PROMPT_UNCONFIRMED` rather than risking false success.
- `PROMPT_UNCONFIRMED` means "not proven, possibly consumed." Callers must preserve
  effect evidence and must not retry, clean up, register, or continue dependent work.
- An idle worker with unchanged sequence after prompt acknowledgement fails within
  the separate five-second semantic window instead of surfacing later through a
  60-second smoke wait; pre-submit readiness uses ADR-016's start-attempt budget.
- Partial resources and acknowledged-effect evidence remain available for manual
  diagnosis; launch never auto-cleans or resends.
- Communication remains low-latency and non-blocking, while launch carries the
  stronger assignment contract.
- The contract still depends on Herdr's authoritative agent state and lifecycle
  sequence. Missing or contradictory backend evidence intentionally fails closed.
