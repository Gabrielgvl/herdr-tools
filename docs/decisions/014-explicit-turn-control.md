# ADR-014: Tools-only explicit turn control

## Status

Accepted

## Date

2026-08-21

## Context

Managers need to stop an active agent turn without relying on raw Herdr input or
an inferred focused pane. A stop request is safety-sensitive: a stale name,
pane reuse, or a lost key response could otherwise interrupt the wrong agent or
be reported as a successful cancellation.

The existing `herdr_communicate` tool is already sequential in Pi and MCP and is
the shared typed boundary for agent input. The feature must preserve its prompt,
steer, and named-key contracts while adding two explicit operations with strict
schemas.

## Decision

Add only these public `herdr_communicate` variants:

```text
{ target: TargetRef, operation: "cancel" }
{ target: TargetRef, operation: "interrupt" }
```

Both variants reject every additional field. They are implemented by a small
internal turn-control module and inherit the existing sequential scheduling in
both hosts.

Before dispatch, the module resolves the exact target from an authoritative
snapshot and performs one fresh `herdr agent get` against the resolved pane ID.
Both reads must identify the same currently `working` agent by exact pane ID,
terminal ID, and full `{source, agent, kind, value}` `agentSession`. The fresh
`agent get` must carry its own non-empty `pane_id`; required pane identity is
never inherited from the earlier snapshot. Missing or changed identity,
unknown/malformed state, and a non-working turn fail closed without sending a
key.

`cancel` sends exactly one named `esc`; `interrupt` sends exactly one named
`ctrl+c`. There are no retries, escalation keys, fallback routes, focus changes,
or synthetic recovery. A bounded five-second wait observes `idle`, `blocked`,
`done`, or `unknown`, followed by an independent fresh snapshot regardless of
wait failure. A same-agent result is confirmed only when the final state is
terminal and `state_change_seq` advanced. If both pre-dispatch reads provide a
sequence, a fresh sequence below the snapshot baseline is rejected before
dispatch, and confirmation binds to that freshest non-regressed sequence. Cancel
disappearance is always `CANCEL_UNCONFIRMED`.

Interrupt has one additional, deliberately narrow result: `agent_exited` is
allowed only after an acknowledged dispatch when the exact pane and terminal
remain under the original tab/workspace, the pane is agent-free `unknown`, no
replacement agent is present, and the captured session identity appears
nowhere else. The absence scan covers every pane and agent record and every
recognized session representation, including structured or legacy
`agent_session`, `agent_session_id`, `session_id`, and flattened session fields.
Matching, malformed, or contradictory evidence fails closed. Its reason is
`post_dispatch_absence_proven`; the tool does not claim that the key caused the
process to exit.

An abort before dispatch is `ABORTED`. Once dispatch is attempted, the key
operation evidence is retained and wait/final verification use independent
bounded signals. Details retain only bounded pre/final evidence, phase, reason,
dispatch acknowledgement/attempt, operation IDs, control key/window, wait
status, and confirmation. Compact rows remain intentionally small.

## Alternatives considered

### Add a separate `herdr_turn` tool

Rejected. It would duplicate target resolution, host scheduling, MCP publication,
rendering, and error mapping while making the public surface larger. Turn
control belongs with the existing typed communication boundary.

### Expose raw `send-keys` or arbitrary control text

Rejected. Raw bytes and caller-selected escape sequences cannot provide a stable
operation contract or prevent accidental destructive input. Only the two named
control keys are reachable through explicit discriminants.

### Use prompt, Escape-then-prompt, or a generic fallback sequence

Rejected. Prompt is a text-delivery operation and steer deliberately does not
interrupt. Combining operations would create retries/escalation and make
causality ambiguous. The new operations each dispatch exactly one key.

### Trust the target name or the focused pane after one snapshot

Rejected. Names can be reused and UI focus is not an authority. The snapshot plus
fresh `agent get` identity binding prevents a stale target from receiving a
control key.

### Treat disappearance after Ctrl-C as direct proof of causation

Rejected. A process may exit for an unrelated reason, and a pane may be reused.
The strict agent-free post-state is reported only as `post_dispatch_absence_proven`
and requires acknowledged dispatch plus absence of the captured session identity
elsewhere.

### Retry after a timeout or lost key response

Rejected. A key may already have reached the terminal. Retrying could deliver
multiple controls or affect a replacement agent. Final independent verification
is the only post-dispatch action.

## Consequences

- Managers get explicit, inspectable cancel/interrupt semantics without raw CLI
  or Bash dependency.
- A successful same-agent result is stronger than a transport acknowledgement;
  it requires authoritative state and sequence evidence.
- Some real outcomes remain unconfirmed, especially lost dispatch responses,
  replacement races, and cancel disappearance. This is intentional fail-closed
  behavior.
- The public tool count stays at seven, and Pi/MCP schema and FIFO behavior stay
  aligned.
- The operation depends on Herdr exposing terminal and complete agent-session
  identity. Older or incompatible CLI/backend responses fail with a typed error
  rather than being guessed around.
