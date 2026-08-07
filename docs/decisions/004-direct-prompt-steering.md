# ADR-004: Steer by direct prompt submission

## Status
Accepted; supersedes the communication/steer portion of ADR-003

## Date
2026-08-07

## Context

ADR-003 incorrectly modeled steering as interrupting a working agent with Escape, waiting for it to settle, and then submitting a replacement prompt. That behavior cancels the active turn; it is interruption, not steering.

The installed Herdr 0.8 implementation has no dedicated `agent steer` command. `agent prompt` writes the supplied text and Enter directly to the target agent PTY for every supported agent kind. Herdr's own working-state tests prove that it does not prepend Escape. When the target is working, the target agent TUI decides how submitted input is handled; Pi treats submitted user input as steering.

## Decision

1. `herdr_communicate` with `operation:"steer"` never sends Escape or any other synthesized key.
2. For authoritative `idle`, `working`, `done`, or `blocked` state, steer submits the text directly through `herdr agent prompt`.
3. `operation:"prompt"` remains distinct: it rejects a `working` target with `TARGET_BUSY` rather than intentionally steering it.
4. Unknown or malformed target state remains a typed no-send failure.
5. Communication details report route `steer_direct` or `prompt_direct` and retain the prompt/post-state Herdr envelope IDs. Obsolete interrupt and settle-wait IDs are removed.
6. Post-submission authoritative state is still verified, but the adapter does not claim turn-level acknowledgement because Herdr does not track a newly submitted turn when the target was already working.

## Alternatives considered

### Escape, settle, then prompt

Rejected. It destroys the active turn and caused the reported failure. It cannot be described as steering.

### Add adapter-specific raw PTY behavior

Rejected. `herdr agent prompt` already owns safe text encoding, bracketed paste, delayed Enter ordering, foreground-agent validation, and PTY submission. Reimplementing that path would duplicate Herdr authority.

### Add a new Herdr semantic steer API now

Deferred. A future Herdr API could provide agent-specific acknowledgement and turn correlation, but the current adapter can correctly use the existing prompt submission path without interruption.

## Consequences

- A working agent receives steering input without cancellation.
- Idle/done/blocked agents receive the same direct prompt submission and begin work normally.
- The adapter no longer waits for an artificial settled state before steering.
- Herdr still cannot prove that a working agent TUI accepted the text as a distinct steering turn; the result proves prompt submission and observed post-state, not turn-level consumption.
