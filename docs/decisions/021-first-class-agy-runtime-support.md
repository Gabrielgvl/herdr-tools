# ADR-021: Add first-class AGY runtime support

## Status

Accepted; amended for the Herdr Tools-only reduced-assurance path.

This ADR extends [ADR-005 visible provenance](005-visible-inter-agent-provenance.md),
[ADR-008 profile-only launch](008-profile-only-launch-and-bounded-fallback.md),
[the tools-owned attachment decision](008-tools-owned-large-message-attachments.md),
[ADR-015 semantic prompt confirmation](015-semantic-initial-prompt-consumption-confirmation.md),
[ADR-016 identity readiness](016-agent-start-budgeted-identity-readiness.md), and the
automatic and continuous supervision decisions in ADR-019 and ADR-020. Those decisions
remain authoritative except for the AGY-only pre-prompt identity and bind timing stated
here.

## Date

2026-09-02

## Context

Herdr Tools needs a profile-backed AGY researcher. Herdr exposes AGY as an agent kind,
but Herdr Tools currently accepts only Pi and Claude profiles. AGY's official native
session identity may not be present before the first prompt. Requiring that identity at
pre-prompt readiness would make AGY impossible without changing Herdr Core. The owner
has rejected Core changes and wants the narrow exception implemented in Herdr Tools
instead.

The exception must not weaken the established single-submit, provenance, fallback,
recipient, or supervision rules. In particular, a prompt acknowledgement is not proof
that AGY consumed the assignment, and a pane identity is not proof of native-session
continuity.

## Decision

### Tools-only profile

Add strict runtime kind `agy` and bundled profile `researcher-agy` with model
`gemini-3.7-flash-high`, `sessionPersistence: true`, fixed `--mode plan` and
`--dangerously-skip-permissions`, typed scope-normalized `addDirs`, and fallback
`researcher-pi`. The reachable fallback order is exactly:

```text
researcher-agy -> researcher-pi -> researcher-claude
```

AGY requires a non-empty `initialPrompt`; a promptless AGY launch is rejected before
mutation. Only typed `model` and `addDirs` primary overrides are accepted. The profile
body is catalog metadata, never a `--agent` argument, hidden/system prompt, or other
Tools-authored AGY input. AGY uses native project discovery for `AGENTS.md`; the manager's
visible v1 provenance-wrapped assignment is its only Tools-authored instruction.

### Provisional state and job-registry publication

The public supervision state adds an AGY-only `provisional` value between `reserved` and
exact `active` or `degraded` state. The job registry publishes the provisional supervisor
with the proven pane, terminal, name, kind, profile, and lifecycle baseline as provisional
evidence, but never a full native `agent_session` or exact target. Its
`operation_phase` remains `"running"`, `childLive()` remains true, and cancellation is
refused with `SUPERVISION_ACTIVE`. The provisional job is therefore live and
non-cancellable while `activeSupervisorFor`, semantic-review ownership, recipients, and
attachments continue to require exact strengthening.

Provisional publication keeps `request.targetIds` empty and uses the same registry
`commit`, `publish`, and rollback discipline as exact binding. A provisional pane or
terminal is inspectable evidence, not exact coverage. A failed launch or strengthen
retains the provisional supervisor and recovery evidence instead of settling or releasing
it.

### Reduced-assurance AGY launch

AGY launch uses the existing selected-attempt startup budget and the following ordered
transaction:

1. Readiness accepts one fresh coherent sample proving the pane, terminal, name,
   `agent: "agy"`, interactive readiness, idle lifecycle, and safe baseline
   `state_change_seq`/revision. Native `agent_session` may be missing or null at this
   point. Evidence is not merged across samples; contradiction, malformed data,
   duplicate records, or replacement fails closed.
2. Tools commits and publishes the AGY-only provisional supervisor before sending the
   assignment. The provisional binding is to the proven pane, terminal, name, kind, and
   idle baseline; it is live and non-cancellable but is not exact coverage.
3. Tools sends the mandatory visible envelope through exactly one stdin prompt
   submission. The `agent_prompted` acknowledgement must match that provisional
   pane/terminal/name/kind identity. No second submission, separate Enter, wait, or
   prompt retry is permitted.
4. During the existing post-acknowledgement semantic confirmation window (5,000 ms at
   100 ms cadence), fresh authoritative reads must show the official full AGY
   `agent_session` on the same pane, terminal, name, and kind. The lifecycle
   `state_change_seq` must strictly advance from the pre-prompt idle baseline and the
   revision must not regress. The records must be coherent.
5. Tools runs the observer-backed strengthening transaction below. Launch success and
   exact recipient or attachment registration occur only after its exact-session commit.
6. After strengthening, the existing exact-session supervision, reconciliation,
   identity-preserving move, notification, and session-lifetime rules apply unchanged.

A contradiction, timeout, move before strengthening, failed or ambiguous read, or missing
official session is a visible partial-effect failure. It does not retry, fall back, clean
up, release the child or provisional recovery handle, register a recipient, or continue
dependent work. The child, supervisor evidence, and recovery handles remain available
for inspection.

The only fallback remains the exact non-killed, untruncated pre-interactive
`agent_start_failed` envelope followed by fresh authoritative proof that no agent exists.
Only that proven zero-effect condition may advance the declared AGY-to-Pi-to-Claude chain.
No readiness, prompt, identity, supervision, timeout, or uncertain-effect failure may
select a fallback.

### Strengthening transaction

Strengthening runs as one observer-backed task on the existing supervisor mutation chain.
The provisional observer stays registered while Tools takes a fresh authoritative read
that proves exactly one occupant for the provisional pane. The occupant must preserve the
pane, terminal, name, and AGY kind, carry the full native `agent_session`, advance
`state_change_seq` beyond the pre-prompt idle baseline, and have a non-regressing valid
revision.

Before commit, the chain drains every event admitted during the provisional window in
arrival order. Move, replacement, contradiction, duplicate or malformed evidence,
settlement, identity mismatch, failed read, missing session, lifecycle failure, or
revision regression rejects the strengthen. A successful drain is followed by one atomic
commit of the supervisor's exact identity and the existing job-registry publication. The
matching `active` or `degraded` state, exact `targetIds: [paneId]`, and exact-identity
coverage become visible together. No observer sees a half-strengthened job.

Any failure rolls back only uncommitted exact-publication changes, retains the running
provisional supervisor and recovery handles, and registers no recipient. It never retries,
follows a fallback, cleans up the child, releases the reservation, submits another prompt,
or reports launch success.

### Deterministic safety contract

The normative matrix in the [AGY runtime support spec](../specs/agy-runtime-support.md)
requires deterministic cases for promptless zero-mutation rejection, AGY-only acceptance of
missing pre-session identity, unchanged Pi and Claude strictness, exactly one stdin
submission, and every acknowledgement, transport, identity, duplicate, move, read,
timeout, session, sequence, revision, and strengthening failure. Every listed failure
retains the provisional running, live, non-cancellable job with no retry, fallback,
cleanup, reservation release, second submission, exact coverage, or recipient
registration. Only the proven pre-interactive zero-effect `agent_start_failed` envelope
may advance the fallback chain.

### Residual risk

Until strengthening, pane/terminal/name/kind continuity is not cryptographic
attribution. A same-terminal, same-kind replacement or a stale pane-scoped hook report
could be mistaken for the started child during the short provisional window. Tools
cannot eliminate that risk without a Core change. The owner accepts this bounded,
AGY-only exception because success still requires the later official native session and
lifecycle advancement. Pi and Claude retain strict complete native-session readiness
before assignment and are unchanged.

## Alternatives considered

### Require native session identity before the AGY prompt

Rejected. AGY cannot satisfy that requirement reliably without a Core change, which is
outside the authorized scope. The provisional transaction preserves the stronger
post-prompt evidence and makes the residual risk explicit.

### Bind supervision only after native-session confirmation

Rejected. The assignment would then have a window with no supervisor, precisely when
AGY identity is least attributable. A provisional binding closes that observability gap
without making it an exact-session success.

### Treat the prompt acknowledgement as success or retry the prompt

Rejected. `agent_prompted` proves delivery to the terminal, not consumption. A second
submission or Enter could duplicate an already-consumed assignment.

### Fall back after any AGY confirmation or identity failure

Rejected. The AGY process may be live or the assignment may have had an effect. Fallback
is safe only for the existing proven pre-interactive zero-effect envelope.

### Clean up on an uncertain AGY result

Rejected. Cleanup can destroy a working child and the evidence needed to diagnose the
uncertain effect. Preserve the child and handles for manual inspection.

### Inject the profile body or add an AGY-specific transport

Rejected. It creates a second instruction channel or identity path. AGY uses native
project instructions and the existing visible assignment transport.

## Consequences

- Herdr Tools can launch `researcher-agy` without any Core or AGY change.
- AGY launch success has a stricter post-prompt condition than its reduced pre-prompt
  readiness: official native session identity, same terminal/name/kind, and advanced
  lifecycle are all required before registration.
- A provisional supervisor and its recovery evidence may remain after a failed AGY
  confirmation; managers must inspect rather than relaunch or resend.
- The short provisional interval carries an owner-accepted attribution risk unique to
  AGY. It is never generalized to Pi or Claude.
- The bundled catalog grows from 12 to 13 profiles and research guidance points to AGY;
  fallback profiles retain their own defaults.
- The exact implementation slices and qualification commands are in
  [the AGY runtime support spec](../specs/agy-runtime-support.md).
