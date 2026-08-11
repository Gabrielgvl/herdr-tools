# ADR-007: Show active wait jobs in Pi's footer and a toggleable widget

## Status

Accepted

## Date

2026-08-11

## Context

Detached `herdr_wait` jobs return immediately and remain observable through
`herdr_jobs`, but the Pi TUI has no persistent indication that waits are still
running. Operators must remember opaque job IDs and poll the tool manually. The
extension needs live feedback without turning the registry view into a second
interactive job manager or consuming editor space by default.

## Decision

- Add an optional printable single-line `label` to `herdr_wait`, valid for
  foreground and background waits. When omitted, derive a bounded effective label
  from resolved target names plus the requested condition. Store that effective
  label in job request/detail/summary projections. Supplied foreground labels show
  in call and result rows; labels derived after asynchronous preflight show in the
  result row because the call row has already rendered.
- While one or more detached waits are running, show a session-scoped Pi footer
  status with an animated spinner, the exact active count, the elapsed time of
  the oldest active wait, and the `/herdr-waits` command hint. Refresh once per
  second and clear the status immediately when the active count reaches zero.
- Register `/herdr-waits` as a read-only toggle for an above-editor widget. The
  widget contains active jobs only, one compact row per job with effective label,
  elapsed time, and exact job ID. Stay within Pi's 10-line string-widget limit,
  reserving the final line for an omission count when needed.
- Remember the widget toggle for the current Pi session. Clear the widget when no
  jobs are active, but restore it automatically when a later wait starts if the
  toggle remains enabled. Reset the preference at the next session boundary.
- Preserve the existing `herdr_jobs` inspect/cancel API and terminal steer
  notifications. The widget does not add interactive cancellation.
- Start no timer in the extension factory. Start the one-second timer only while
  active jobs exist, stop it when they do not, and clear timers/status/widget on
  session shutdown or replacement. UI failures remain isolated from job state.

## Alternatives considered

### Persistent multi-line widget by default

Rejected because it consumes vertical editor space even when the operator only
needs confirmation that waits are active.

### Footer count only

Rejected because a static count does not show that the extension is live or how
long the oldest wait has been running.

### Interactive cancellation dialog

Rejected because the agreed command is a visibility toggle. Cancellation remains
an explicit `herdr_jobs` operation using the exact ID shown in each row.

### Opaque IDs without labels

Rejected because IDs are useful for actions but poor primary identifiers. Labels
provide intent while IDs preserve exact inspect/cancel addressing.

## Consequences

The wait request and job result contracts gain a label field, and the extension
registers one slash command in addition to its seven MCP tools. The registry must
emit change notifications to a UI controller without letting rendering failures
affect job execution. UI behavior needs deterministic timer, lifecycle, bounding,
and non-UI tests.
