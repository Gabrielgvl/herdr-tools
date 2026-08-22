# ADR-016: Bind launch identity readiness to the selected agent-start budget

## Status

Accepted; supersedes the launch identity-readiness portions of
`docs/decisions/013-prompt-submission-acknowledgement.md` and
`docs/decisions/015-semantic-initial-prompt-consumption-confirmation.md`.

ADR-013 still governs single stdin submission, exact acknowledgement, and no-Enter
recovery. ADR-015 still governs the separate post-acknowledgement semantic
confirmation window.

## Date

2026-08-22

## Context

Herdr's successful `agent start` acknowledgement can precede complete, coherent
identity and lifecycle metadata. The previous Tools launch path allowed only a
separate five-second identity preflight. For launches with an initial prompt it then
performed another one-shot `agent get` to establish the idle lifecycle baseline.

That split had two problems. A correctly starting agent whose identity took more
than five seconds to appear was rejected even though the selected start attempt had
an existing 120,000 ms startup allowance. Conversely, the later baseline read was
not part of the coherent snapshot, agent-get, and pane-get sample that established
identity. Complete fields from one source or sample could make the flow appear ready
while the authoritative prompt baseline remained incomplete or referred to skewed
evidence.

Readiness failure occurs after a successful process start and after possible topology
and attachment publication effects. It therefore must not be represented like a
zero-effect start failure or made eligible for profile fallback.

## Decision

Each profile start attempt has one absolute startup budget of 120,000 ms. Tools
captures a monotonic timestamp immediately before invoking that attempt's `agent
start`. If that attempt is selected, all subsequent launch-readiness work uses the
same absolute deadline. The timestamp and deadline are never reset by a successful
start response, a sample, a poll delay, or a pending observation. A typed
pre-interactive start failure may still select a later fallback under ADR-008; that
later attempt receives its own budget measured immediately before its own start.

After one attempt starts successfully, launch enters phase `ready` and runs a
condition-based, read-only loop. Every sample is ordered exactly as:

1. fresh `api snapshot`;
2. fresh `agent get` for the resolved pane; and
3. fresh `pane get` for the resolved pane.

A sample is evaluated only after all three reads complete, using its own records plus
identity fields actually supplied by the selected `agent_started` record. No field or
record is carried across samples. Fixed-whitelist model-visible evidence is cleared
before each sample, then updated after each completed read. In particular, the
current agent record is compacted after `agent get` completes and before awaiting
`pane get`; a pane-read failure therefore retains current-sample snapshot and agent
evidence without evaluating readiness from an incomplete sample. Duplicate target
records, malformed non-null metadata, contradictory identity aliases, or identity
replacement is terminal. Missing or null noncontradictory startup metadata is pending
only while this readiness loop remains inside the selected attempt's absolute budget.

Every non-null lifecycle field supplied by the start record or any readiness record
is shape-validated: `agent_status` must be a known state, `state_change_seq` and
`revision` must be safe non-negative integers, and diagnostic
`screen_detection_skipped` must be boolean. The start record is an earlier
process-start observation. Its valid lifecycle values are never merged into or
compared with a later sample, so stale start counters cannot overwrite or veto the
fresh same-sample anchor. Start identity fields retain their existing join and
contradiction semantics.

A no-prompt launch becomes ready when the coherent sample and supplied start
identity fields establish the same strict complete pane, terminal, name, kind, and
four-field agent session identity used by the existing launch contract. It does not
require an idle lifecycle baseline or lifecycle agreement, but every lifecycle field
that any source supplies must still pass the shape rules above.

A launch with `initialPrompt` has a stronger readiness condition. The same sample's
`agent get` record must independently provide all of the following:

- the full exact captured pane, terminal, name, kind, and four-field agent-session
  identity;
- `agent_status: "idle"`;
- a safe non-negative `state_change_seq`; and
- a safe non-negative `revision`.

Same-sample snapshot-agent, snapshot-pane, and pane-get lifecycle fields must agree
with that anchor whenever they supply a non-null value, but they cannot fill an
anchor omission. A valid disagreement for the same exact identity is treated as a
sequential transition/skew: the whole sample remains pending and is discarded before
resampling. Lifecycle values are never field-merged. A valid non-idle anchor state or
missing/null anchor field also remains pending. A malformed lifecycle shape or
identity replacement is terminal. Readiness returns the identity and idle baseline
from one accepted coherent sample; launch performs no later one-shot baseline read.

Only after readiness succeeds may an explicitly requested existing-pane focus occur.
It has its own `focus` phase. A focus CLI timeout remains `LAUNCH_FAILED` with
`causeCode:"CLI_TIMEOUT"`; it is not a readiness timeout. For prompt launches, phase
changes from `focus` (when requested) or `ready` to `prompt_verification` immediately
before the one stdin submission. The separate post-`agent_prompted` semantic
confirmation remains exactly 5,000 ms at a 100 ms cadence and does not reuse or
extend the startup budget.

Only exhaustion of the readiness loop's absolute deadline throws
`READY_TIMEOUT`; an individual CLI `CLI_TIMEOUT` or another read failure remains a
non-timeout launch failure with its own cause. A readiness timeout or caller abort
after successful start preserves partial-effect evidence. Details include
`agentStarted:true`, `promptSubmitted:false`,
`recipientRegistered:false`, created IDs, the start-budget basis and elapsed time,
sample count, last pending reason, bounded records, and whether the prompt baseline
was required. Published attachment and recipient-grant path evidence are retained.
There is no fallback, start or prompt retry, cleanup, generated Enter, focus mutation,
or recipient registration after such a failure.

Launch details also report three independent monotonic wall durations: selected
agent-start through readiness, immediately before stdin submission through completion
of typed acknowledgement parsing and identity validation, and validated
acknowledgement through semantic confirmation. Durations are bounded safe integers but
are not clamped to configured timeout or budget maxima, so scheduler, transport, or
validation overruns remain visible on both success and failure paths. Model-visible
readiness records use a fixed four-record whitelist projection: bounded strings,
safe integers, booleans, null, fixed malformed/missing markers, and only the four
fixed agent-session fields. Readiness error metadata and retained CLI failure evidence
also use fixed keys and bounded primitives. Arbitrary properties, `__proto__`,
`constructor`, `prototype`, nested record trees, deep arrays, and oversized values are
not retained. This is a readiness-specific projection; unrelated diagnostic contracts
retain their existing bounds.

The disposable live integration continues to accept only a semantically confirmed
launch or the exact post-acknowledgement `PROMPT_UNCONFIRMED` result. A readiness
`TARGET_IDENTITY_UNAVAILABLE` remains a failed integration. Integration diagnostics
record readiness timing plus bounded identity fingerprints.

## Alternatives considered

### Extend only the five-second identity preflight

Rejected. Any second fixed window duplicates the existing startup policy and can
still reject a start that remains within its authorized absolute budget.

### Start a new 120-second readiness window after `agent_started`

Rejected. That silently expands one start attempt to as much as 240 seconds and
resets the budget at the point where partial effects already exist.

### Keep the later one-shot baseline read

Rejected. It separates prompt authority from the sample that captured identity and
creates an avoidable skew boundary.

### Merge missing fields across readiness samples

Rejected. Cross-sample accumulation can manufacture an identity that no
single authoritative observation ever reported and can join evidence from a
replacement process.

### Fall back when readiness expires

Rejected. A process already started successfully. Launching another profile could
create two agents or duplicate assignment effects.

## Consequences

- Slowly materializing but valid identities can use the remainder of the existing
  120-second start allowance.
- The total selected-attempt start plus readiness duration cannot exceed that
  allowance through Tools-managed waiting.
- Initial-prompt identity and baseline are coherent and anchored in one authoritative
  agent-get record; same-identity lifecycle skew resamples without submission.
- Missing startup metadata is tolerated only as bounded pending evidence; malformed,
  duplicate, identity-contradictory, or replacement evidence remains fail-closed.
  Valid start lifecycle metadata is shape-checked but cannot supersede fresh sample
  time semantics.
- Readiness failures expose started-agent and retained-resource effects without
  authorizing fallback, cleanup, focus, registration, or prompt mutation.
- Prompt-consumption confirmation retains its independent five-second availability
  trade-off and semantics from ADR-015.
