# ADR-012: Automatically detach long Herdr waits

## Status

Superseded by ADR-018: detached-only `herdr_wait` API.

## Context

A wait longer than the configured review cadence already requires periodic
in-process model supervision. Keeping that wait in the initiating tool turn
holds the caller open even though the wait has an independent watcher and can
finish asynchronously. A detached completion must also wake the initiating Pi
agent so the result is actionable without polling.

## Decision

- A wait whose timeout exceeds the configured review cadence is registered as
  a session-scoped detached job, and the current API applies the same detached
  lifecycle to every timeout.
- Detached waits use the existing shared wait runner and mandatory in-process
  watcher model. The watcher remains tool-less and authoritative state/output
  still decides whether the condition matches.
- Terminal detached results use the existing visible Pi steer notification
  with `triggerTurn: true`, waking the initiating agent. Explicit cancellation
  and session-shutdown cancellation remain silent.

## Alternatives considered

### Keep long waits synchronous by default

Rejected: it occupies the caller turn despite the wait already having a
periodic watcher and a session job mechanism.

### Add a second polling or watcher implementation

Rejected: automatic detachment must preserve the established timeout,
reviewer, snapshot, and manager-judgment semantics through the shared runner.

### Notify without triggering a turn

Rejected: a visible queued message alone does not reliably resume the agent to
act on the completed wait.

## Consequences

Long waits return an opaque job ID after authoritative preflight. Existing
`herdr_jobs` inspection, cancellation, active-wait UI, and bounded terminal
notifications apply unchanged.
